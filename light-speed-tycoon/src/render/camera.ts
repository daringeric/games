// 2D camera: screen = world * scale + offset. Pure math so it unit-tests in node;
// the scene copies it onto the world container each frame.

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Bounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class Camera {
  scale = 1;
  x = 0;
  y = 0;
  minScale = 0.1;
  maxScale = 3;
  /** Viewport size in CSS pixels. */
  viewW = 1;
  viewH = 1;
  /** World area the camera keeps in view (the board). */
  private bounds: Bounds = { x: 0, y: 0, w: 1, h: 1 };

  setViewport(w: number, h: number): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.clamp();
  }

  setBounds(bounds: Bounds): void {
    this.bounds = bounds;
  }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: wx * this.scale + this.x, y: wy * this.scale + this.y };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.x) / this.scale, y: (sy - this.y) / this.scale };
  }

  /**
   * Fit `target` (default: the whole bounds) into the viewport minus UI insets.
   * Zooming out is allowed until the whole bounds fit with room to spare.
   */
  fit(insets: Insets, target: Bounds = this.bounds): void {
    const b = this.bounds;
    const availW = Math.max(1, this.viewW - insets.left - insets.right);
    const availH = Math.max(1, this.viewH - insets.top - insets.bottom);
    this.minScale = Math.min(availW / b.w, availH / b.h) * 0.8;
    const contain = Math.min(availW / target.w, availH / target.h);
    const cover = Math.max(availW / target.w, availH / target.h);
    // On a tall phone screen a strict fit leaves the town tiny; meet cover halfway.
    const fitted = cover / contain > 1.6 ? Math.sqrt(contain * cover) : contain;
    const scale = Math.min(this.maxScale, Math.max(this.minScale, fitted));
    this.scale = scale;
    this.x = insets.left + (availW - target.w * scale) / 2 - target.x * scale;
    this.y = insets.top + (availH - target.h * scale) / 2 - target.y * scale;
    this.clamp();
  }

  panBy(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  /** Multiply the zoom by `factor`, keeping the world point under (sx, sy) fixed. */
  zoomAt(sx: number, sy: number, factor: number): void {
    const before = this.screenToWorld(sx, sy);
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    this.x = sx - before.x * this.scale;
    this.y = sy - before.y * this.scale;
    this.clamp();
  }

  /** Center the view on a world point. */
  centerOn(wx: number, wy: number): void {
    this.x = this.viewW / 2 - wx * this.scale;
    this.y = this.viewH / 2 - wy * this.scale;
    this.clamp();
  }

  /** Keep at least a third of the viewport over the board so it can't be lost off-screen. */
  private clamp(): void {
    const b = this.bounds;
    const keepW = Math.min(this.viewW / 3, b.w * this.scale);
    const keepH = Math.min(this.viewH / 3, b.h * this.scale);
    const minX = keepW - (b.x + b.w) * this.scale;
    const maxX = this.viewW - keepW - b.x * this.scale;
    const minY = keepH - (b.y + b.h) * this.scale;
    const maxY = this.viewH - keepH - b.y * this.scale;
    this.x = Math.min(maxX, Math.max(minX, this.x));
    this.y = Math.min(maxY, Math.max(minY, this.y));
  }
}
