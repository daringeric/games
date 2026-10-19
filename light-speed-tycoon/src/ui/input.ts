// Pointer and keyboard input: camera pan/zoom and routing clicks to tools.
//
// Panning: left-drag with the inspect tool, middle- or right-drag in any tool,
// Space+drag in any tool, and one-finger drag on touch screens (a tap still
// clicks). Wheel and pinch zoom around the cursor; +/- zoom around the centre.

import type { Camera } from '../render/camera';
import type { Speed } from './session';
import type { ToolId } from './tools';

/** Movement (CSS px) before a press counts as a drag instead of a click. */
const DRAG_SLOP = 6;
const KEY_ZOOM = 1.25;

export interface InputHandlers {
  /** Cursor moved over the map (grid units), or left it (null). */
  hover(grid: { x: number; y: number } | null, screen: { x: number; y: number }): void;
  click(grid: { x: number; y: number }): void;
  /** Esc / right-click: end the current action. Returns true if something was cancelled. */
  cancel(): boolean;
  pickTool(tool: ToolId): void;
  currentTool(): ToolId;
  setSpeed(speed: Speed): void;
  togglePause(): void;
  /** Esc with nothing to cancel on the map (closes menus). */
  escape(): void;
}

interface Press {
  id: number;
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  pan: boolean;
  moved: boolean;
  touch: boolean;
}

const TOOL_KEYS: Record<string, ToolId> = { i: 'inspect', a: 'aerial', u: 'underground', c: 'cabinet', x: 'remove' };
const SPEED_KEYS: Record<string, Speed> = { '1': 1, '2': 2, '3': 4 };

export class Input {
  private press: Press | null = null;
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private spaceHeld = false;
  private spaceUsedForPan = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly cell: number,
    private readonly handlers: InputHandlers,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
    });
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private toGrid(p: { x: number; y: number }): { x: number; y: number } {
    const w = this.camera.screenToWorld(p.x, p.y);
    return { x: w.x / this.cell, y: w.y / this.cell };
  }

  private updateCursor(): void {
    const panning = this.press?.pan && this.press.moved;
    const tool = this.handlers.currentTool();
    this.canvas.style.cursor = panning ? 'grabbing' : this.spaceHeld || tool === 'inspect' ? 'grab' : 'crosshair';
  }

  private readonly onDown = (e: PointerEvent) => {
    const p = this.local(e);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, p);
      if (this.touches.size === 2) {
        // Second finger: switch to pinch and drop the pending tap.
        this.press = null;
        this.pinchDist = this.touchSpread().dist;
        return;
      }
    }
    if (this.press) return;
    this.canvas.setPointerCapture(e.pointerId);
    const inspect = this.handlers.currentTool() === 'inspect';
    this.press = {
      id: e.pointerId,
      button: e.button,
      startX: p.x,
      startY: p.y,
      lastX: p.x,
      lastY: p.y,
      // Pan right away for drags that can never be a tool click.
      pan: e.button === 1 || e.button === 2 || this.spaceHeld || (e.button === 0 && inspect),
      moved: false,
      touch: e.pointerType === 'touch',
    };
    if (e.button === 1) e.preventDefault();
  };

  private readonly onMove = (e: PointerEvent) => {
    const p = this.local(e);
    if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, p);
      if (this.touches.size >= 2) {
        this.pinch();
        return;
      }
    }
    const press = this.press;
    if (press && press.id === e.pointerId) {
      if (!press.moved && Math.hypot(p.x - press.startX, p.y - press.startY) > DRAG_SLOP) {
        press.moved = true;
        // A one-finger drag pans in every tool; a mouse drag only where panning was chosen.
        if (press.touch) press.pan = true;
        if (this.spaceHeld) this.spaceUsedForPan = true;
      }
      if (press.pan && press.moved) {
        this.camera.panBy(p.x - press.lastX, p.y - press.lastY);
      }
      press.lastX = p.x;
      press.lastY = p.y;
    }
    this.handlers.hover(this.toGrid(p), p);
    this.updateCursor();
  };

  private readonly onUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    const press = this.press;
    if (!press || press.id !== e.pointerId) return;
    this.press = null;
    const p = this.local(e);
    if (!press.moved) {
      if (press.button === 2) {
        this.handlers.cancel();
      } else if (press.button === 0 && !this.spaceHeld) {
        this.handlers.click(this.toGrid(p));
        this.handlers.hover(this.toGrid(p), p);
      }
    }
    this.updateCursor();
  };

  private readonly onCancel = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.press?.id === e.pointerId) this.press = null;
    this.updateCursor();
  };

  private readonly onLeave = (e: PointerEvent) => {
    if (!this.press) this.handlers.hover(null, this.local(e));
  };

  private readonly onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const p = this.local(e);
    // Trackpads send many small deltas, mouse wheels a few big ones; exp keeps both smooth.
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.camera.zoomAt(p.x, p.y, Math.exp(-delta * 0.0018));
    this.handlers.hover(this.toGrid(p), p);
  };

  private touchSpread(): { dist: number; x: number; y: number } {
    const [a, b] = [...this.touches.values()];
    if (!a || !b) return { dist: 0, x: 0, y: 0 };
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }

  private pinch(): void {
    const { dist, x, y } = this.touchSpread();
    if (this.pinchDist > 0 && dist > 0) {
      this.camera.zoomAt(x, y, dist / this.pinchDist);
    }
    this.pinchDist = dist;
  }

  private zoomCenter(factor: number): void {
    this.camera.zoomAt(this.camera.viewW / 2, this.camera.viewH / 2, factor);
  }

  private readonly onKeyDown = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const key = e.key.toLowerCase();
    if (e.key === ' ') {
      // Space pans while held and toggles pause on a plain tap; keep it from clicking focused buttons.
      e.preventDefault();
      if (!e.repeat) {
        this.spaceHeld = true;
        this.spaceUsedForPan = false;
        this.updateCursor();
      }
      return;
    }
    if (e.repeat && key !== '+' && key !== '=' && key !== '-' && key !== '_') return;
    const tool = TOOL_KEYS[key];
    const speed = SPEED_KEYS[key];
    if (tool) this.handlers.pickTool(tool);
    else if (speed) this.handlers.setSpeed(speed);
    else if (key === '+' || key === '=') this.zoomCenter(KEY_ZOOM);
    else if (key === '-' || key === '_') this.zoomCenter(1 / KEY_ZOOM);
    else if (e.key === 'Escape') {
      if (!this.handlers.cancel()) this.handlers.escape();
    } else return;
    e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== ' ') return;
    e.preventDefault();
    if (this.spaceHeld && !this.spaceUsedForPan) this.handlers.togglePause();
    this.spaceHeld = false;
    this.updateCursor();
  };
}
