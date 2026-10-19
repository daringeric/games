import { describe, expect, it } from 'vitest';
import { makeGridCity } from '../sim/testing/fixtures';
import { placeTrees } from './decor';
import { parcelGrid } from './geometry';
import { toyTown } from './theme';

// Deep blocks leave backyard rows free for trees.
const city = { ...makeGridCity({ cols: 4, rows: 3, blockW: 6, blockH: 6 }), seed: 42 };

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

describe('placeTrees', () => {
  it('is deterministic per city seed', () => {
    expect(placeTrees(city, toyTown)).toEqual(placeTrees(city, toyTown));
    expect(placeTrees({ ...city, seed: 43 }, toyTown)).not.toEqual(placeTrees(city, toyTown));
  });

  it('plants some trees in free backyard cells', () => {
    expect(placeTrees(city, toyTown).length).toBeGreaterThan(10);
  });

  it('never plants on a parcel', () => {
    const grid = parcelGrid(city);
    for (const t of placeTrees(city, toyTown)) {
      const cx = Math.floor(t.x / toyTown.cell);
      const cy = Math.floor(t.y / toyTown.cell);
      expect(grid[cy * city.width + cx]).toBe(0);
    }
  });

  it('keeps every canopy off every road', () => {
    const c = toyTown.cell;
    for (const t of placeTrees(city, toyTown)) {
      for (const seg of city.segments) {
        const a = city.nodes[seg.a]!;
        const b = city.nodes[seg.b]!;
        const d = distToSegment(t.x, t.y, a.x * c, a.y * c, b.x * c, b.y * c);
        expect(d).toBeGreaterThanOrEqual(toyTown.road.width[seg.streetClass] / 2 + t.r);
      }
    }
  });

  it('returns trees sorted back to front', () => {
    const ys = placeTrees(city, toyTown).map((t) => t.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });
});
