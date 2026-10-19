import { describe, expect, it } from 'vitest';
import { Camera } from './camera';

const BOARD = { x: -100, y: -100, w: 4000, h: 3000 };
const NO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

function camera(): Camera {
  const cam = new Camera();
  cam.setBounds(BOARD);
  cam.setViewport(1000, 800);
  return cam;
}

describe('Camera', () => {
  it('converts between world and screen both ways', () => {
    const cam = camera();
    cam.fit(NO_INSETS);
    cam.zoomAt(300, 200, 1.7);
    const s = cam.worldToScreen(1234, 567);
    const w = cam.screenToWorld(s.x, s.y);
    expect(w.x).toBeCloseTo(1234);
    expect(w.y).toBeCloseTo(567);
  });

  it('fits a target rect inside the insets, centred', () => {
    const cam = camera();
    const target = { x: 1000, y: 500, w: 1600, h: 800 };
    cam.fit({ top: 100, right: 20, bottom: 40, left: 80 }, target);
    // Available area is 900 x 660; the target is wider than tall, so width decides.
    expect(cam.scale).toBeCloseTo(900 / 1600);
    const topLeft = cam.worldToScreen(target.x, target.y);
    const bottomRight = cam.worldToScreen(target.x + target.w, target.y + target.h);
    expect(topLeft.x).toBeCloseTo(80);
    expect(bottomRight.x).toBeCloseTo(980);
    expect((topLeft.y + bottomRight.y) / 2).toBeCloseTo(100 + 660 / 2);
  });

  it('zooms around the cursor, keeping the point under it fixed', () => {
    const cam = camera();
    cam.fit(NO_INSETS);
    const before = cam.screenToWorld(420, 310);
    cam.zoomAt(420, 310, 2);
    const after = cam.screenToWorld(420, 310);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('clamps zoom between the fitted minimum and the maximum', () => {
    const cam = camera();
    cam.fit(NO_INSETS);
    cam.zoomAt(500, 400, 1e6);
    expect(cam.scale).toBe(cam.maxScale);
    cam.zoomAt(500, 400, 1e-6);
    expect(cam.scale).toBe(cam.minScale);
    expect(cam.minScale).toBeLessThan(Math.min(1000 / BOARD.w, 800 / BOARD.h));
  });

  it('keeps part of the board on screen however far you pan', () => {
    const cam = camera();
    cam.fit(NO_INSETS);
    cam.zoomAt(500, 400, 3);
    cam.panBy(1e6, 1e6);
    const topLeft = cam.worldToScreen(BOARD.x, BOARD.y);
    expect(topLeft.x).toBeLessThan(1000);
    expect(topLeft.y).toBeLessThan(800);
    cam.panBy(-2e6, -2e6);
    const bottomRight = cam.worldToScreen(BOARD.x + BOARD.w, BOARD.y + BOARD.h);
    expect(bottomRight.x).toBeGreaterThan(0);
    expect(bottomRight.y).toBeGreaterThan(0);
  });

  it('meets cover halfway on a tall phone screen instead of shrinking the town to a strip', () => {
    const cam = new Camera();
    cam.setBounds(BOARD);
    cam.setViewport(390, 844);
    const target = { x: 0, y: 0, w: 2400, h: 1800 };
    cam.fit(NO_INSETS, target);
    const contain = 390 / 2400;
    const cover = 844 / 1800;
    expect(cam.scale).toBeCloseTo(Math.sqrt(contain * cover));
  });
});
