// Pointer and keyboard input: camera pan/zoom and routing clicks, taps and
// drags to tools.
//
// Panning: left-drag with the inspect tool, middle- or right-drag in any tool,
// Space+drag in any tool, and one-finger drag on touch screens (a tap still
// clicks). Wheel and pinch zoom around the cursor; +/- zoom around the centre.
//
// Drawing: in the cable tools a left-button press (or one finger) that starts
// on a corner and moves past DRAG_SLOP draws a cable run along the streets
// instead (dragStart/dragMove/dragEnd); releasing orders it. Esc, a right-click
// or a second finger cancels the drag with no order. A press that doesn't move
// is still a click or tap, so the click-by-click flow keeps working.
//
// Space toggles pause on a plain tap. A press made while it is held is a pan
// (never a tool click) and cancels the pause toggle. Space still presses a
// button the keyboard focused, as on any page, but not one the mouse left
// focused, which would otherwise swallow every pause.

import type { Camera } from '../render/camera';
import { isDialogOpen } from './confirm';
import type { Speed } from './session';
import type { ToolId } from './tools';

/** Movement (CSS px) before a press counts as a drag instead of a click. */
export const DRAG_SLOP = 6;
const KEY_ZOOM = 1.25;
/** How near (CSS px) a press must start to a corner to draw from it, at least the tools' own pick radius. */
const DRAW_PICK_PX = 18;
/** ...but never more than this many map cells, however far out the map is zoomed. */
const DRAW_PICK_MAX_CELLS = 1.2;

export interface InputHandlers {
  /** Cursor moved over the map (grid units), or left it (null); `touch` when a finger moved. */
  hover(grid: { x: number; y: number } | null, screen: { x: number; y: number }, touch?: boolean): void;
  /** A click or tap on the map; `touch` for a finger, which has no hover to preview with. */
  click(grid: { x: number; y: number }, touch: boolean): void;
  /** Esc / right-click: end the current action. Returns true if something was cancelled. */
  cancel(): boolean;
  pickTool(tool: ToolId): void;
  currentTool(): ToolId;
  setSpeed(speed: Speed): void;
  togglePause(): void;
  /** Esc with nothing to cancel on the map (closes menus). */
  escape(): void;
  /**
   * A left-button or one-finger press that began at `start` (grid units) moved
   * past the slop: return true to draw from there (it began on a corner in a
   * cable tool), false to leave it a pan (touch) or nothing (mouse). `pick` is
   * a corner radius in grid units suited to the current zoom.
   */
  dragStart(start: { x: number; y: number }, pick: number, touch: boolean): boolean;
  /** The drawing pointer moved (grid units, and screen position for the card). */
  dragMove(grid: { x: number; y: number }, screen: { x: number; y: number }): void;
  /** The drawing pointer was released at `grid`: order the run. */
  dragEnd(grid: { x: number; y: number }, touch: boolean): void;
  /** Esc, right-click, a second finger or a lost pointer: drop the drawing with no order. */
  dragCancel(): void;
  /** The O key: toggle the $/ft cost overlay. */
  toggleOverlay(): void;
  /** Round 4b: the E key: toggle the storm-exposure overlay. */
  toggleExposureOverlay(): void;
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
  /** Space was held when the press began: it pans and never clicks. */
  space: boolean;
  /** The press is drawing a cable run (dragStart said yes). */
  drawing: boolean;
  /** A drawing was cancelled mid-press: the release does nothing. */
  cancelled: boolean;
}

/** Controls the browser presses with Space when they have keyboard focus. */
const SPACE_CONTROLS = 'button, [role="menuitem"], a[href], summary, select';

const TOOL_KEYS: Record<string, ToolId> = { i: 'inspect', a: 'aerial', u: 'underground', c: 'cabinet', x: 'remove' };
const OVERLAY_KEY = 'o';
const EXPOSURE_KEY = 'e';
const SPEED_KEYS: Record<string, Speed> = { '1': 1, '2': 2, '3': 4 };

export class Input {
  private press: Press | null = null;
  private readonly touches = new Map<number, { x: number; y: number }>();
  private pinchDist = 0;
  private spaceHeld = false;
  /** Space has been a pan modifier during this hold (a press began or was under way), so releasing it doesn't toggle pause. */
  private spaceUsedForPan = false;
  /** The last input was a pointer press rather than a key; read when focus moves. */
  private pointerInput = false;
  /** The element that last took focus from the keyboard (Tab, or a script after a key press), if any. */
  private keyboardFocused: EventTarget | null = null;

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
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      // A right-click while drawing (a chorded press reports no pointerdown) cancels it.
      this.cancelDrawing();
    });
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', () => {
      this.spaceHeld = false;
    });
    // Focus modality, tracked first (capture on window) so nothing can hide it.
    // :focus-visible can't tell: a key press turns it on before keydown handlers run.
    window.addEventListener('pointerdown', () => (this.pointerInput = true), true);
    window.addEventListener('keydown', () => (this.pointerInput = false), true);
    window.addEventListener('focusin', (e) => (this.keyboardFocused = this.pointerInput ? null : e.target), true);
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
    this.canvas.style.cursor = panning ? 'grabbing' : this.press?.drawing ? 'crosshair' : this.spaceHeld || tool === 'inspect' ? 'grab' : 'crosshair';
  }

  /** Corner radius (grid units) for starting a drawing at the current zoom. */
  private drawPick(): number {
    return Math.min(DRAW_PICK_MAX_CELLS, DRAW_PICK_PX / (this.cell * this.camera.scale));
  }

  /** Drop a drawing in progress (no order); true if there was one. The press stays, inert, until released. */
  private cancelDrawing(): boolean {
    const press = this.press;
    if (!press?.drawing) return false;
    press.drawing = false;
    press.cancelled = true;
    this.handlers.dragCancel();
    this.updateCursor();
    return true;
  }

  private readonly onDown = (e: PointerEvent) => {
    const p = this.local(e);
    if (e.pointerType === 'touch') {
      this.touches.set(e.pointerId, p);
      if (this.touches.size === 2) {
        // Second finger: switch to pinch, cancel any drawing and drop the pending tap.
        this.cancelDrawing();
        this.press = null;
        this.pinchDist = this.touchSpread().dist;
        return;
      }
    }
    if (this.press) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      // A synthetic or already-released pointer can't be captured; the press still works.
    }
    if (this.spaceHeld) this.spaceUsedForPan = true;
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
      space: this.spaceHeld,
      drawing: false,
      cancelled: false,
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
      // A right button pressed while the left one draws (a chorded press reports no pointerdown).
      if (press.drawing && (e.buttons & 2) !== 0) this.cancelDrawing();
      if (!press.moved && Math.hypot(p.x - press.startX, p.y - press.startY) > DRAG_SLOP) {
        press.moved = true;
        // Starting on a corner in a cable tool, a left-button or one-finger drag draws.
        const canDraw = !press.pan && press.button === 0 && !press.space && !this.spaceHeld;
        if (canDraw && this.handlers.dragStart(this.toGrid({ x: press.startX, y: press.startY }), this.drawPick(), press.touch)) {
          press.drawing = true;
        } else if (press.touch) {
          // Otherwise a one-finger drag pans in every tool; a mouse drag only where panning was chosen.
          press.pan = true;
        }
        if (this.spaceHeld) this.spaceUsedForPan = true;
      }
      if (press.drawing) {
        this.handlers.dragMove(this.toGrid(p), p);
      } else if (press.pan && press.moved) {
        this.camera.panBy(p.x - press.lastX, p.y - press.lastY);
      }
      press.lastX = p.x;
      press.lastY = p.y;
    }
    this.handlers.hover(this.toGrid(p), p, e.pointerType === 'touch');
    this.updateCursor();
  };

  private readonly onUp = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    const press = this.press;
    if (!press || press.id !== e.pointerId) return;
    this.press = null;
    const p = this.local(e);
    if (press.drawing) {
      this.handlers.dragEnd(this.toGrid(p), press.touch);
      this.handlers.hover(this.toGrid(p), p);
    } else if (!press.moved && !press.cancelled) {
      if (press.button === 2) {
        this.handlers.cancel();
      } else if (press.button === 0 && !press.space && !this.spaceHeld) {
        this.handlers.click(this.toGrid(p), press.touch);
        this.handlers.hover(this.toGrid(p), p);
      }
    }
    this.updateCursor();
  };

  private readonly onCancel = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    if (this.press?.id === e.pointerId) {
      this.cancelDrawing();
      this.press = null;
    }
    this.updateCursor();
  };

  private readonly onLeave = (e: PointerEvent) => {
    // A lifted finger "leaves" too; keep its tap's card up, since touch has no hover to bring it back.
    if (e.pointerType === 'touch') return;
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
    // A modal confirmation owns the keyboard: Space and Enter press its buttons, Esc cancels it.
    if (e.ctrlKey || e.metaKey || e.altKey || isDialogOpen()) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    const key = e.key.toLowerCase();
    if (e.key === ' ') {
      // A keyboard-focused control gets Space as usual (the browser presses it).
      if (this.keyboardFocusedControl(target)) return;
      // Otherwise Space pans while held and toggles pause on a plain tap; keep it
      // from pressing a button the mouse left focused.
      e.preventDefault();
      if (!e.repeat) {
        this.spaceHeld = true;
        // Held down over a press already under way: a modifier, not a pause tap.
        this.spaceUsedForPan = this.press !== null;
        this.updateCursor();
      }
      return;
    }
    if (e.key === 'Escape' && this.cancelDrawing()) {
      e.preventDefault();
      return;
    }
    if (e.repeat && key !== '+' && key !== '=' && key !== '-' && key !== '_') return;
    const tool = TOOL_KEYS[key];
    const speed = SPEED_KEYS[key];
    if (tool) {
      // Switching tools mid-drag drops the drawing.
      this.cancelDrawing();
      this.handlers.pickTool(tool);
    } else if (speed) this.handlers.setSpeed(speed);
    else if (key === OVERLAY_KEY) this.handlers.toggleOverlay();
    else if (key === EXPOSURE_KEY) this.handlers.toggleExposureOverlay();
    else if (key === '+' || key === '=') this.zoomCenter(KEY_ZOOM);
    else if (key === '-' || key === '_') this.zoomCenter(1 / KEY_ZOOM);
    else if (e.key === 'Escape') {
      if (!this.handlers.cancel()) this.handlers.escape();
    } else return;
    e.preventDefault();
  };

  private readonly onKeyUp = (e: KeyboardEvent) => {
    // Only a Space whose keydown was taken for pan and pause; one that went to a control is left to it.
    if (e.key !== ' ' || !this.spaceHeld) return;
    e.preventDefault();
    if (!this.spaceUsedForPan) this.handlers.togglePause();
    this.spaceHeld = false;
    this.updateCursor();
  };

  private keyboardFocusedControl(target: HTMLElement | null): boolean {
    return target !== null && target === this.keyboardFocused && target.matches(SPACE_CONTROLS);
  }
}
