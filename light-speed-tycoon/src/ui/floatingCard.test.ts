import { describe, expect, it } from 'vitest';
import { placeCard } from './floatingCard';
import type { CardPlacementInput } from './floatingCard';

// A 390 x 844 phone: HUD down to 150, toolbar from 770. The full quote card is
// 340 x 437 (a long aerial route with a blocker); its compact layout 340 x 190.
const PHONE: Omit<CardPlacementInput, 'x' | 'y'> = {
  w: 340,
  h: 437,
  compactW: 340,
  compactH: 190,
  viewW: 390,
  viewH: 844,
  safe: { top: 158, bottom: 762 },
};

function covers(p: { left: number; top: number }, w: number, h: number, x: number, y: number): boolean {
  return p.left <= x && x <= p.left + w && p.top <= y && y <= p.top + h;
}

describe('placeCard', () => {
  it('sits below-right of the pointer when it fits, flipping left and up at the edges', () => {
    const desk = { w: 300, h: 200, compactW: 300, compactH: 100, viewW: 1440, viewH: 900, safe: { top: 120, bottom: 900 } };
    expect(placeCard({ ...desk, x: 400, y: 300 })).toEqual({ left: 418, top: 318, compact: false });
    expect(placeCard({ ...desk, x: 1300, y: 300 })).toEqual({ left: 982, top: 318, compact: false });
    expect(placeCard({ ...desk, x: 400, y: 800 })).toEqual({ left: 418, top: 582, compact: false });
  });

  it('never covers a finger dragging cable mid-screen on a phone', () => {
    for (const y of [381, 409, 430, 438]) {
      for (const x of [122, 188, 285]) {
        const p = placeCard({ ...PHONE, x, y });
        const w = p.compact ? PHONE.compactW : PHONE.w;
        const h = p.compact ? PHONE.compactH : PHONE.h;
        expect(covers(p, w, h, x, y), `finger at ${x}, ${y}`).toBe(false);
        // And stays clear of the HUD and the toolbar.
        expect(p.top).toBeGreaterThanOrEqual(PHONE.safe.top);
        expect(p.top + h).toBeLessThanOrEqual(PHONE.safe.bottom);
      }
    }
  });

  it('keeps the full card when it fits above or below the finger', () => {
    const p = placeCard({ ...PHONE, h: 300, x: 188, y: 700 });
    expect(p).toMatchObject({ compact: false, top: 700 - 18 - 300 });
  });

  it('docks the full card to the far end of the safe band when that clears the finger', () => {
    expect(placeCard({ ...PHONE, x: 188, y: 610 })).toEqual({ left: 8, top: PHONE.safe.top, compact: false });
    expect(placeCard({ ...PHONE, x: 188, y: 315 })).toEqual({ left: 8, top: PHONE.safe.bottom - PHONE.h, compact: false });
  });

  it('docks to the far end of the safe band when even the compact card cannot clear the finger', () => {
    const tall = { ...PHONE, compactH: 420 };
    expect(placeCard({ ...tall, x: 188, y: 500 })).toMatchObject({ compact: true, top: PHONE.safe.top });
    expect(placeCard({ ...tall, x: 188, y: 420 })).toMatchObject({ compact: true, top: PHONE.safe.bottom - 420 });
  });
});
