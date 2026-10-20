import { describe, expect, it } from 'vitest';
import { makeGridCity } from '../sim/testing/fixtures';
import type { City, StreetClass } from '../sim/types';
import {
  MDU_ROOF_PAD,
  dropPoint,
  frontageSide,
  hashInt,
  homePlan,
  horizontalStreet,
  lotFrame,
  lotRect,
  mapExit,
  mduDemarc,
  parcelGrid,
  straightRuns,
  streetAlongSide,
  streetLattice,
  verticalStreet,
} from './geometry';
import { toyTown } from './theme';

describe('streetLattice', () => {
  it('marks every unit edge a street runs along', () => {
    // 3 x 2 blocks of 4 x 2 cells: streets on x = 0, 4, 8, 12 and y = 0, 2, 4.
    const city = makeGridCity();
    const lattice = streetLattice(city);
    expect(horizontalStreet(lattice, 0, 0)).toBe('local');
    expect(horizontalStreet(lattice, 11, 4)).toBe('local');
    expect(horizontalStreet(lattice, 5, 1)).toBeUndefined();
    expect(verticalStreet(lattice, 4, 3)).toBe('local');
    expect(verticalStreet(lattice, 5, 0)).toBeUndefined();
    // Off the map is never a street.
    expect(horizontalStreet(lattice, -1, 0)).toBeUndefined();
    expect(verticalStreet(lattice, 13, 0)).toBeUndefined();
  });

  it('counts segments per node', () => {
    const city = makeGridCity();
    const lattice = streetLattice(city);
    expect(lattice.degree[0]).toBe(2); // corner
    expect(lattice.degree[1]).toBe(3); // top edge
    expect(lattice.degree[5]).toBe(4); // interior crossing
  });

  it('reports the widest street along a side', () => {
    const city = makeGridCity();
    city.segments[0] = { ...city.segments[0]!, streetClass: 'arterial' };
    const lattice = streetLattice(city);
    expect(streetAlongSide(lattice, { x: 0, y: 0, w: 4, h: 1 }, 'top')).toBe('arterial');
    expect(streetAlongSide(lattice, { x: 1, y: 0, w: 1, h: 1 }, 'bottom')).toBeUndefined();
  });
});

describe('lots', () => {
  const city = makeGridCity();
  const lattice = streetLattice(city);
  const top = city.parcels.find((p) => p.x === 1 && p.y === 0)!;
  const bottom = city.parcels.find((p) => p.x === 1 && p.y === 1)!;

  it('finds the side that faces the frontage street', () => {
    expect(frontageSide(city, top)).toBe('top');
    expect(frontageSide(city, bottom)).toBe('bottom');
  });

  it('pulls lots back from streets and only a hairline from neighbors', () => {
    const c = toyTown.cell;
    const curb = toyTown.road.width.local / 2 + toyTown.lot.curbGap;
    const gap = toyTown.lot.sideGap;
    const r = lotRect(lattice, top, toyTown);
    expect(r.y).toBeCloseTo(curb);
    expect(r.x).toBeCloseTo(c + gap);
    expect(r.w).toBeCloseTo(c - 2 * gap);
    expect(r.h).toBeCloseTo(c - curb - gap);
    // The corner lot also pulls back from the cross street on its left.
    const corner = lotRect(lattice, city.parcels.find((p) => p.x === 0 && p.y === 0)!, toyTown);
    expect(corner.x).toBeCloseTo(curb);
  });

  it('maps lot-local coordinates (along the street, away from it) to world rects', () => {
    const lot = { x: 100, y: 200, w: 40, h: 30 };
    expect(lotFrame(lot, 'top').toWorld(5, 2, 10, 8)).toEqual({ x: 105, y: 202, w: 10, h: 8 });
    expect(lotFrame(lot, 'bottom').toWorld(5, 2, 10, 8)).toEqual({ x: 105, y: 220, w: 10, h: 8 });
    expect(lotFrame(lot, 'left').toWorld(5, 2, 10, 8)).toEqual({ x: 102, y: 205, w: 8, h: 10 });
    expect(lotFrame(lot, 'right').toWorld(5, 2, 10, 8)).toEqual({ x: 130, y: 205, w: 8, h: 10 });
    expect(lotFrame(lot, 'left').front).toBe(30);
  });

  it('maps lot-local points, with negative depth toward the street', () => {
    const lot = { x: 100, y: 200, w: 40, h: 30 };
    expect(lotFrame(lot, 'top').point(5, -3)).toEqual({ x: 105, y: 197 });
    expect(lotFrame(lot, 'bottom').point(5, -3)).toEqual({ x: 105, y: 233 });
    expect(lotFrame(lot, 'left').point(5, -3)).toEqual({ x: 97, y: 205 });
    expect(lotFrame(lot, 'right').point(5, -3)).toEqual({ x: 143, y: 205 });
  });

  it('indexes parcels by cell', () => {
    const grid = parcelGrid(city);
    expect(grid[1 * city.width + 1]).toBe(bottom.id + 1);
    expect(grid.every((v) => v > 0)).toBe(true);
    expect(parcelGrid(makeGridCity({ blockH: 3 }))[1 * 12 + 1]).toBe(0);
  });
});

/**
 * 10 x 6 map. Main St runs west off the map from (8,3) through a plain joint at
 * (4,3); a local street runs north off the map from (8,3) and dead-ends inside
 * at (8,5); a collector runs east off the map; a short lane lies along the top
 * border without leaving it.
 */
function edgeCity(midClass: StreetClass = 'arterial'): City {
  const pts: [number, number][] = [[0, 3], [4, 3], [8, 3], [8, 0], [8, 5], [10, 3], [2, 0], [5, 0]];
  const seg = (id: number, a: number, b: number, streetClass: StreetClass) => ({
    id, a, b, streetClass, name: `S${id}`, lengthFt: 60, hasPoles: true, rock: false, zone: 'residential' as const,
  });
  return {
    seed: 1,
    name: 'Edge Test',
    width: 10,
    height: 6,
    tileFt: 60,
    nodes: pts.map(([x, y], id) => ({ id, x, y })),
    segments: [
      seg(0, 0, 1, 'arterial'),
      seg(1, 1, 2, midClass),
      seg(2, 2, 3, 'local'),
      seg(3, 2, 4, 'local'),
      seg(4, 2, 5, 'collector'),
      seg(5, 6, 7, 'local'),
    ],
    parcels: [],
    coNode: 2,
  };
}

describe('mapExit', () => {
  it('finds dead ends where a street points off the map', () => {
    const city = edgeCity();
    const lattice = streetLattice(city);
    expect(mapExit(city, lattice, 0)).toEqual({ dx: -1, dy: 0 });
    expect(mapExit(city, lattice, 3)).toEqual({ dx: 0, dy: -1 });
    expect(mapExit(city, lattice, 5)).toEqual({ dx: 1, dy: 0 });
  });

  it('leaves junctions, inner dead ends and lanes along the border alone', () => {
    const city = edgeCity();
    const lattice = streetLattice(city);
    for (const node of [1, 2, 4, 6, 7]) expect(mapExit(city, lattice, node)).toBeNull();
  });
});

describe('straightRuns', () => {
  it('joins segments through plain joints of the same street class', () => {
    const city = edgeCity();
    const runs = straightRuns(city, streetLattice(city));
    expect(runs).toContainEqual({ a: 0, b: 2, streetClass: 'arterial', segments: [0, 1] });
    // A crossing is not a joint, even where the street carries straight on.
    expect(runs).toContainEqual({ a: 2, b: 3, streetClass: 'local', segments: [2] });
    expect(runs).toContainEqual({ a: 2, b: 4, streetClass: 'local', segments: [3] });
    expect(runs.flatMap((r) => r.segments).sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('breaks a run where the street class changes', () => {
    const city = edgeCity('collector');
    const runs = straightRuns(city, streetLattice(city));
    expect(runs).toContainEqual({ a: 0, b: 1, streetClass: 'arterial', segments: [0] });
    expect(runs).toContainEqual({ a: 1, b: 2, streetClass: 'collector', segments: [1] });
  });

  it('covers every segment of a generated town exactly once, end to end', async () => {
    const { generateCity } = await import('../sim/citygen');
    const city = generateCity(2027);
    const runs = straightRuns(city, streetLattice(city));
    const ids = runs.flatMap((r) => r.segments).sort((a, b) => a - b);
    expect(ids).toEqual(city.segments.map((s) => s.id));
    for (const run of runs) {
      const a = city.nodes[run.a]!;
      const b = city.nodes[run.b]!;
      expect(a.x === b.x || a.y === b.y).toBe(true);
      const length = run.segments.reduce((sum, id) => sum + city.segments[id]!.lengthFt, 0);
      expect(length).toBe((Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * city.tileFt);
    }
    // Citygen splits long streets, so some runs span several segments.
    expect(runs.length).toBeLessThan(city.segments.length);
  });
});

describe('building tells', () => {
  const s = toyTown.demarc.size;
  const gap = toyTown.lot.curbGap;
  const center = (r: { x: number; y: number; w: number; h: number }) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

  /** Grid town whose lots are apartment buildings. */
  function mduCity(): City {
    return makeGridCity({ parcelKinds: () => ({ kind: 'mdu', units: 12 }) });
  }

  it('puts an apartment building’s demarc on the middle of its serving wall, with the entry running to the curb', () => {
    const city = mduCity();
    const lattice = streetLattice(city);
    // Fronts 1st St above it.
    const north = city.parcels.find((p) => p.x === 1 && p.y === 0)!;
    const lot = lotRect(lattice, north, toyTown);
    const tell = mduDemarc(lot, frontageSide(city, north), toyTown);
    expect(tell.side).toBe('top');
    expect(center(tell.box).x).toBeCloseTo(lot.x + lot.w / 2);
    expect(center(tell.box).y).toBeCloseTo(lot.y + MDU_ROOF_PAD);
    expect(tell.box.w).toBe(s);
    expect(tell.entry).toEqual({ ax: lot.x + lot.w / 2, ay: lot.y + MDU_ROOF_PAD - s / 2, bx: lot.x + lot.w / 2, by: lot.y - gap });
    expect(tell.curb).toEqual({ x: lot.x + lot.w / 2, y: lot.y - gap });
    // The curb point sits on the edge of the serving street's pavement.
    const street = toyTown.road.width.local / 2;
    expect(tell.curb.y).toBeCloseTo(north.y * toyTown.cell + street);

    // Its neighbor behind it fronts 2nd St below: the demarc moves to the bottom wall.
    const south = city.parcels.find((p) => p.x === 1 && p.y === 1)!;
    const southLot = lotRect(lattice, south, toyTown);
    const southTell = mduDemarc(southLot, frontageSide(city, south), toyTown);
    expect(southTell.side).toBe('bottom');
    expect(center(southTell.box).y).toBeCloseTo(southLot.y + southLot.h - MDU_ROOF_PAD);
    expect(southTell.curb.y).toBeCloseTo(southLot.y + southLot.h + gap);
  });

  it('follows the serving street round a corner lot, never just the nearest street', () => {
    const city = mduCity();
    // The corner lot at (0, 0) touches 1st St (top) and A Ave (left); serve it from A Ave.
    const corner = city.parcels.find((p) => p.x === 0 && p.y === 0)!;
    corner.segment = 9;
    const lattice = streetLattice(city);
    const lot = lotRect(lattice, corner, toyTown);
    const tell = mduDemarc(lot, frontageSide(city, corner), toyTown);
    expect(tell.side).toBe('left');
    expect(center(tell.box).x).toBeCloseTo(lot.x + MDU_ROOF_PAD);
    expect(center(tell.box).y).toBeCloseTo(lot.y + lot.h / 2);
    expect(tell.curb).toEqual({ x: lot.x - gap, y: lot.y + lot.h / 2 });
    expect(dropPoint(city, lattice, corner, toyTown)).toEqual(tell.curb);
  });

  it('drops homes at the end of their front walk and shops mid-front, on the serving side', () => {
    const city = makeGridCity({ parcelKinds: (p) => (p.x === 2 ? { kind: 'smb', units: 1 } : undefined) });
    const lattice = streetLattice(city);
    const home = city.parcels.find((p) => p.x === 1 && p.y === 1)!;
    const lot = lotRect(lattice, home, toyTown);
    const plan = homePlan(lotFrame(lot, 'bottom'), hashInt(home.id));
    expect(dropPoint(city, lattice, home, toyTown)).toEqual({ x: lot.x + plan.walkU, y: lot.y + lot.h + gap });
    // The walk runs from the house's middle.
    expect(plan.walkU).toBeCloseTo(plan.u + plan.along / 2);

    const shop = city.parcels.find((p) => p.x === 2 && p.y === 0)!;
    const shopLot = lotRect(lattice, shop, toyTown);
    expect(dropPoint(city, lattice, shop, toyTown)).toEqual({ x: shopLot.x + shopLot.w / 2, y: shopLot.y - gap });
  });
});
