import { describe, expect, it } from 'vitest';
import { generateCity } from '../sim/citygen';
import { canopyIn, cityGroveField, groveAt } from '../sim/terrain';
import { makeGridCity } from '../sim/testing/fixtures';
import type { City } from '../sim/types';
import { placeStreetTrees, placeTrees, STREET_TREE_MIN_CANOPY } from './decor';
import { streetCanopy } from '../sim/weather';
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

  it('places exactly the trees it placed when tree-lined blocks got their backyard trees (round 4c/4d)', () => {
    // Fingerprints (tree count, FNV-1a of the trees' JSON), re-taken in round 4c/4d when
    // backyards on tree-lined blocks (sim/terrain canopy) got more trees. Re-take them only
    // when the theme's tree settings or the placement rules change on purpose.
    const fingerprint = (trees: readonly Tree[]) => {
      const json = JSON.stringify(trees);
      let h = 0x811c9dc5;
      for (let i = 0; i < json.length; i++) {
        h ^= json.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return { count: trees.length, hash: (h >>> 0).toString(16) };
    };
    expect(fingerprint(placeTrees(city, toyTown))).toEqual({ count: 132, hash: 'e8a56b9c' });
    expect(fingerprint(placeTrees(generateCity(2027), toyTown))).toEqual({ count: 1312, hash: '547a821e' });
    expect(fingerprint(placeTrees(generateCity(424242), toyTown))).toEqual({ count: 1914, hash: 'd413ebcc' });
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

  it('plants more backyard trees on tree-lined blocks, where the sim counts street canopy', () => {
    // Round 4c/4d: the storm-exposed tree-lined neighborhoods (weather.streetCanopy) read as leafy.
    const tally = { lined: { cells: 0, trees: 0 }, open: { cells: 0, trees: 0 } };
    for (const seed of [2027, 424242, 99]) {
      const town: City = generateCity(seed);
      const field = cityGroveField(town);
      const grid = parcelGrid(town);
      const perCell = new Map<number, number>();
      for (const t of placeTrees(town, toyTown)) {
        const key = Math.floor(t.y / toyTown.cell) * town.width + Math.floor(t.x / toyTown.cell);
        perCell.set(key, (perCell.get(key) ?? 0) + 1);
      }
      for (let y = 1; y < town.height - 1; y++) {
        for (let x = 1; x < town.width - 1; x++) {
          if (grid[y * town.width + x] !== 0) continue;
          let nearLot = false;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (grid[(y + dy) * town.width + x + dx] !== 0) nearLot = true;
          if (!nearLot) continue;
          const canopy = canopyIn(field, x + 0.5, y + 0.5);
          const bucket = canopy >= 0.99 ? tally.lined : canopy <= 0 ? tally.open : null;
          if (!bucket) continue;
          bucket.cells++;
          bucket.trees += perCell.get(y * town.width + x) ?? 0;
        }
      }
    }
    expect(tally.lined.cells).toBeGreaterThan(20);
    expect(tally.open.cells).toBeGreaterThan(20);
    expect(tally.lined.trees / tally.lined.cells).toBeGreaterThan(1.8 * (tally.open.trees / tally.open.cells));
  });

  it('lines the curbs of tree-lined blocks with street trees, off the roadway, deterministic per town (round 4c/4d)', () => {
    const c = toyTown.cell;
    for (const seed of [2027, 424242]) {
      const town: City = generateCity(seed);
      const trees = placeStreetTrees(town, toyTown);
      expect(trees).toEqual(placeStreetTrees(town, toyTown));
      expect(trees.length).toBeGreaterThan(50);
      const ys = trees.map((t) => t.y);
      expect(ys).toEqual([...ys].sort((p, q) => p - q));
      const lined = town.segments.filter((g) => streetCanopy(town, g) >= STREET_TREE_MIN_CANOPY);
      for (const t of trees) {
        // Beside a tree-lined street, never on any roadway.
        const near = lined.some((g) => {
          const a = town.nodes[g.a]!;
          const b = town.nodes[g.b]!;
          return distToSegment(t.x, t.y, a.x * c, a.y * c, b.x * c, b.y * c) <= toyTown.road.width[g.streetClass] / 2 + toyTown.lot.curbGap + t.r;
        });
        expect(near).toBe(true);
        for (const g of town.segments) {
          const a = town.nodes[g.a]!;
          const b = town.nodes[g.b]!;
          expect(distToSegment(t.x, t.y, a.x * c, a.y * c, b.x * c, b.y * c)).toBeGreaterThanOrEqual(toyTown.road.width[g.streetClass] / 2);
        }
      }
    }
  });

  it('returns trees sorted back to front', () => {
    const ys = placeTrees(city, toyTown).map((t) => t.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
  });
});
