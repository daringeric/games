import { describe, expect, it } from 'vitest';
import { generateCity } from '../sim/citygen';
import { cityGroveField, groveAt } from '../sim/terrain';
import { makeGridCity } from '../sim/testing/fixtures';
import type { City } from '../sim/types';
import { placeTrees } from './decor';
import type { Tree } from './decor';
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

  it('places exactly the trees of round 4: the grove field moved to sim/terrain without moving a tree', () => {
    // Fingerprints taken before the move (tree count, FNV-1a of the trees' JSON). Re-take them
    // only when the theme's tree settings change on purpose.
    const fingerprint = (trees: readonly Tree[]) => {
      const json = JSON.stringify(trees);
      let h = 0x811c9dc5;
      for (let i = 0; i < json.length; i++) {
        h ^= json.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return { count: trees.length, hash: (h >>> 0).toString(16) };
    };
    expect(fingerprint(placeTrees(city, toyTown))).toEqual({ count: 102, hash: '978dc59c' });
    expect(fingerprint(placeTrees(generateCity(2027), toyTown))).toEqual({ count: 1286, hash: 'f908e1cd' });
    expect(fingerprint(placeTrees(generateCity(424242), toyTown))).toEqual({ count: 1782, hash: '8ac9ae8d' });
  });

  it('grows open-country groves where the shared grove field is high', () => {
    // Away from lots, cells in a full grove carry far more trees than clearings.
    const town: City = generateCity(2027);
    const field = cityGroveField(town);
    const grid = parcelGrid(town);
    const perCell = new Map<number, number>();
    for (const t of placeTrees(town, toyTown)) {
      const key = Math.floor(t.y / toyTown.cell) * town.width + Math.floor(t.x / toyTown.cell);
      perCell.set(key, (perCell.get(key) ?? 0) + 1);
    }
    const tally = { grove: { cells: 0, trees: 0 }, clearing: { cells: 0, trees: 0 } };
    for (let y = 1; y < town.height - 1; y++) {
      for (let x = 1; x < town.width - 1; x++) {
        let nearLot = false;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (grid[(y + dy) * town.width + x + dx] !== 0) nearLot = true;
        if (nearLot) continue;
        const g = groveAt(field, x, y);
        const bucket = g >= 0.8 ? tally.grove : g <= 0.2 ? tally.clearing : null;
        if (!bucket) continue;
        bucket.cells++;
        bucket.trees += perCell.get(y * town.width + x) ?? 0;
      }
    }
    expect(tally.grove.cells).toBeGreaterThan(20);
    expect(tally.clearing.cells).toBeGreaterThan(20);
    expect(tally.grove.trees / tally.grove.cells).toBeGreaterThan(3 * (tally.clearing.trees / tally.clearing.cells));
  });

  it('returns trees sorted back to front', () => {
    const ys = placeTrees(city, toyTown).map((t) => t.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });
});
