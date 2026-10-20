// Input against a fake canvas, camera and window (unit tests run without a
// DOM): which presses pan, draw, click or cancel. The round-2 rules: in the
// cable tools a right, middle or Space drag pans (a left drag from a corner
// draws), and a second finger cancels a drawing without ordering it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Camera } from '../render/camera';
import { DRAG_SLOP, Input } from './input';
import type { InputHandlers } from './input';
import type { ToolId } from './tools';

type Listener = (e: never) => void;

interface Rig {
  fire(type: string, e: Record<string, unknown>): void;
  key(type: 'keydown' | 'keyup', key: string): void;
  camera: { panBy: ReturnType<typeof vi.fn>; zoomAt: ReturnType<typeof vi.fn> };
  handlers: { [K in keyof InputHandlers]: ReturnType<typeof vi.fn> };
}

let windowListeners: Map<string, Listener[]>;

beforeEach(() => {
  windowListeners = new Map();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]),
  });
  vi.stubGlobal('document', { querySelector: () => null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function rig(tool: ToolId, drawFromCorner = true): Rig {
  const canvasListeners = new Map<string, Listener>();
  const canvas = {
    addEventListener: (type: string, fn: Listener) => canvasListeners.set(type, fn),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => {},
    style: { cursor: '' },
  };
  const camera = {
    scale: 1,
    viewW: 800,
    viewH: 600,
    screenToWorld: (x: number, y: number) => ({ x, y }),
    panBy: vi.fn(),
    zoomAt: vi.fn(),
  };
  const handlers = {
    hover: vi.fn(),
    click: vi.fn(),
    cancel: vi.fn(() => false),
    pickTool: vi.fn(),
    currentTool: vi.fn(() => tool),
    setSpeed: vi.fn(),
    togglePause: vi.fn(),
    escape: vi.fn(),
    dragStart: vi.fn(() => drawFromCorner),
    dragMove: vi.fn(),
    dragEnd: vi.fn(),
    dragCancel: vi.fn(),
    toggleOverlay: vi.fn(),
  };
  new Input(canvas as unknown as HTMLCanvasElement, camera as unknown as Camera, 1, handlers as unknown as InputHandlers);
  const event = (e: Record<string, unknown>) => ({ pointerType: 'mouse', pointerId: 1, button: 0, buttons: 0, preventDefault: () => {}, ...e });
  return {
    fire: (type, e) => canvasListeners.get(type)?.(event(e) as never),
    key: (type, key) => {
      for (const fn of windowListeners.get(type) ?? []) {
        fn({ key, repeat: false, ctrlKey: false, metaKey: false, altKey: false, target: null, preventDefault: () => {} } as never);
      }
    },
    camera,
    handlers,
  };
}

/** Press, move in steps past the slop by (dx, dy), release. */
function drag(r: Rig, e: Record<string, unknown>, dx: number, dy: number): void {
  const x = 100;
  const y = 100;
  r.fire('pointerdown', { ...e, clientX: x, clientY: y });
  for (let i = 1; i <= 4; i++) r.fire('pointermove', { ...e, clientX: x + (dx * i) / 4, clientY: y + (dy * i) / 4 });
  r.fire('pointerup', { ...e, clientX: x + dx, clientY: y + dy });
}

function panned(r: Rig): { x: number; y: number } {
  return r.camera.panBy.mock.calls.reduce((sum, [x, y]) => ({ x: sum.x + (x as number), y: sum.y + (y as number) }), { x: 0, y: 0 });
}

describe('Input', () => {
  for (const [name, button, buttons] of [
    ['right', 2, 2],
    ['middle', 1, 4],
  ] as const) {
    it(`pans on a ${name}-button drag in a cable tool, even from a corner, and never draws or clicks`, () => {
      const r = rig('underground');
      drag(r, { button, buttons }, 60, 40);
      expect(panned(r)).toEqual({ x: 60, y: 40 });
      expect(r.handlers.dragStart).not.toHaveBeenCalled();
      expect(r.handlers.dragEnd).not.toHaveBeenCalled();
      expect(r.handlers.click).not.toHaveBeenCalled();
    });
  }

  it('draws on a left-button drag from a corner in a cable tool, without panning', () => {
    const r = rig('aerial');
    drag(r, { button: 0, buttons: 1 }, 60, 40);
    expect(r.handlers.dragStart).toHaveBeenCalledTimes(1);
    expect(r.handlers.dragMove).toHaveBeenCalled();
    expect(r.handlers.dragEnd).toHaveBeenCalledTimes(1);
    expect(r.camera.panBy).not.toHaveBeenCalled();
    expect(r.handlers.click).not.toHaveBeenCalled();
  });

  it('cancels a one-finger drawing when a second finger lands, and the release orders nothing', () => {
    const r = rig('underground');
    const one = { pointerType: 'touch', pointerId: 1 };
    const two = { pointerType: 'touch', pointerId: 2 };
    r.fire('pointerdown', { ...one, clientX: 100, clientY: 100 });
    r.fire('pointermove', { ...one, clientX: 100 + DRAG_SLOP + 4, clientY: 100 });
    r.fire('pointermove', { ...one, clientX: 140, clientY: 100 });
    expect(r.handlers.dragStart).toHaveBeenCalledTimes(1);
    expect(r.handlers.dragMove).toHaveBeenCalled();

    r.fire('pointerdown', { ...two, clientX: 200, clientY: 100 });
    expect(r.handlers.dragCancel).toHaveBeenCalledTimes(1);
    r.fire('pointerup', { ...one, clientX: 140, clientY: 100 });
    r.fire('pointerup', { ...two, clientX: 200, clientY: 100 });
    expect(r.handlers.dragEnd).not.toHaveBeenCalled();
    expect(r.handlers.click).not.toHaveBeenCalled();
  });

  it('pans on a Space+drag in a cable tool and never clicks, and that Space does not toggle pause', () => {
    const r = rig('underground');
    r.key('keydown', ' ');
    drag(r, { button: 0, buttons: 1 }, 30, -20);
    r.key('keyup', ' ');
    expect(panned(r)).toEqual({ x: 30, y: -20 });
    expect(r.handlers.dragStart).not.toHaveBeenCalled();
    expect(r.handlers.click).not.toHaveBeenCalled();
    expect(r.handlers.togglePause).not.toHaveBeenCalled();

    // A plain Space tap does toggle pause.
    r.key('keydown', ' ');
    r.key('keyup', ' ');
    expect(r.handlers.togglePause).toHaveBeenCalledTimes(1);
  });

  it('clicks on a press that does not move, and cancels on a right click', () => {
    const r = rig('cabinet');
    drag(r, { button: 0 }, 0, 0);
    expect(r.handlers.click).toHaveBeenCalledTimes(1);
    drag(r, { button: 2 }, 0, 0);
    expect(r.handlers.cancel).toHaveBeenCalledTimes(1);
    expect(r.handlers.click).toHaveBeenCalledTimes(1);
  });
});
