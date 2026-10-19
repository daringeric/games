import { describe, expect, it } from 'vitest';
import { Rng } from './rng';
import {
  cornerName,
  isNodeId,
  isSegmentId,
  nearestNode,
  nearestSegment,
  otherEnd,
  polesOnSegment,
  segmentBetween,
  segmentsAtNode,
  shortestPath,
} from './streets';
import { makeGridCity } from './testing/fixtures';
import type { City, SegmentId, StreetSegment } from './types';

// Default grid: 3x2 blocks of 4x2 cells. Node (i, j) = j * 4 + i at (4i, 2j).
// Horizontal segment (i, j) = j * 3 + i (240 ft); vertical (i, j) = 9 + j * 4 + i (120 ft).
const H = (i: number, j: number) => j * 3 + i;
const V = (i: number, j: number) => 9 + j * 4 + i;

function seg(city: City, id: number): StreetSegment {
  return city.segments[id]!;
}

/** Brute-force references with the same tie rules as the indexed versions. */
function bruteNearestNode(city: City, x: number, y: number): number {
  let best = -1;
  let best2 = Infinity;
  for (const n of city.nodes) {
    const d2 = (n.x - x) ** 2 + (n.y - y) ** 2;
    if (d2 < best2) {
      best = n.id;
      best2 = d2;
    }
  }
  return best;
}

function bruteNearestSegment(city: City, x: number, y: number, maxDist = Infinity): number | null {
  let best: number | null = null;
  let best2 = Infinity;
  for (const s of city.segments) {
    const a = city.nodes[s.a]!;
    const b = city.nodes[s.b]!;
    const cx = Math.min(Math.max(x, Math.min(a.x, b.x)), Math.max(a.x, b.x));
    const cy = Math.min(Math.max(y, Math.min(a.y, b.y)), Math.max(a.y, b.y));
    const d2 = (cx - x) ** 2 + (cy - y) ** 2;
    if (d2 < best2) {
      best = s.id;
      best2 = d2;
    }
  }
  return best2 <= maxDist * maxDist ? best : null;
}

function pathLength(city: City, path: readonly SegmentId[]): number {
  return path.reduce((sum, id) => sum + seg(city, id).lengthFt, 0);
}

/** Walks the path and returns the node it ends on (throws if it is not contiguous). */
function walk(city: City, from: number, path: readonly SegmentId[]): number {
  return path.reduce((node, id) => otherEnd(seg(city, id), node), from);
}

describe('graph lookups', () => {
  const city = makeGridCity();

  it('lists segments at a node in ascending order', () => {
    expect(segmentsAtNode(city, 0)).toEqual([H(0, 0), V(0, 0)]);
    expect(segmentsAtNode(city, 5)).toEqual([H(0, 1), H(1, 1), V(1, 0), V(1, 1)]);
    expect(segmentsAtNode(city, 11)).toEqual([H(2, 2), V(3, 1)]);
  });

  it('returns no segments for invalid nodes', () => {
    expect(segmentsAtNode(city, -1)).toEqual([]);
    expect(segmentsAtNode(city, 12)).toEqual([]);
    expect(segmentsAtNode(city, 1.5)).toEqual([]);
  });

  it('finds the segment between adjacent nodes in either order', () => {
    expect(segmentBetween(city, 0, 1)).toBe(H(0, 0));
    expect(segmentBetween(city, 1, 0)).toBe(H(0, 0));
    expect(segmentBetween(city, 5, 9)).toBe(V(1, 1));
    expect(segmentBetween(city, 0, 5)).toBeUndefined();
    expect(segmentBetween(city, 0, 2)).toBeUndefined();
    expect(segmentBetween(city, 0, 99)).toBeUndefined();
  });

  it('gives the other end of a segment', () => {
    const s = seg(city, H(0, 0));
    expect(otherEnd(s, 0)).toBe(1);
    expect(otherEnd(s, 1)).toBe(0);
    expect(() => otherEnd(s, 2)).toThrow(RangeError);
  });

  it('validates ids', () => {
    expect(isNodeId(city, 0)).toBe(true);
    expect(isNodeId(city, 11)).toBe(true);
    expect(isNodeId(city, 12)).toBe(false);
    expect(isNodeId(city, 0.5)).toBe(false);
    expect(isNodeId(city, '1')).toBe(false);
    expect(isSegmentId(city, 16)).toBe(true);
    expect(isSegmentId(city, 17)).toBe(false);
    expect(isSegmentId(city, -1)).toBe(false);
    expect(isSegmentId(city, Number.NaN)).toBe(false);
  });

  it('names corners from the streets that meet there', () => {
    expect(cornerName(city, 0)).toBe('1st St & A Ave');
    expect(cornerName(city, 1)).toBe('1st St & B Ave');
    expect(cornerName(city, 5)).toBe('2nd St & B Ave');
  });
});

describe('shortestPath', () => {
  const city = makeGridCity();

  it('returns [] for the same node and a single segment for neighbours', () => {
    expect(shortestPath(city, 5, 5)).toEqual([]);
    expect(shortestPath(city, 0, 1)).toEqual([H(0, 0)]);
    expect(shortestPath(city, 1, 0)).toEqual([H(0, 0)]);
  });

  it('returns segments in travel order', () => {
    expect(shortestPath(city, 0, 3)).toEqual([H(0, 0), H(1, 0), H(2, 0)]);
    expect(shortestPath(city, 3, 0)).toEqual([H(2, 0), H(1, 0), H(0, 0)]);
    expect(shortestPath(city, 0, 8)).toEqual([V(0, 0), V(0, 1)]);
  });

  it('breaks ties between equal-length routes toward the lower segment id', () => {
    // 0 -> 5 is 360 ft either way; node 5 is entered by H(0,1)=3 rather than V(1,0)=10.
    expect(shortestPath(city, 0, 5)).toEqual([V(0, 0), H(0, 1)]);
    // Same answer every time, from a fresh index too.
    expect(shortestPath(makeGridCity(), 0, 5)).toEqual([V(0, 0), H(0, 1)]);
    // Reverse trip: node 0 is entered by H(0,0)=0 rather than V(0,0)=9.
    expect(shortestPath(city, 5, 0)).toEqual([V(1, 0), H(0, 0)]);
  });

  it('breaks ties toward the lower segment id even when the higher one is found first', () => {
    // Square 2x2-cell blocks: nodes 1 (2, 0) and 4 (0, 2) are both 120 ft from
    // node 0, and node 1 settles first by node id, so node 5 is first reached by
    // V(1,0)=10. The tie-break must swap that for H(0,1)=3 when node 4 settles.
    expect(shortestPath(makeGridCity({ blockW: 2, blockH: 2 }), 0, 5)).toEqual([V(0, 0), H(0, 1)]);
  });

  it('weighs by length, not hop count', () => {
    const detour = makeGridCity();
    detour.segments[H(0, 0)] = { ...seg(detour, H(0, 0)), lengthFt: 10_000 };
    expect(shortestPath(detour, 0, 1)).toEqual([V(0, 0), H(0, 1), V(1, 0)]);
  });

  it('weighs by a custom cost and never crosses a segment costing Infinity', () => {
    // H(0,1) is closed: 0 -> 5 has to take the other 360 ft route.
    const closed = (s: StreetSegment) => (s.id === H(0, 1) ? Infinity : s.lengthFt);
    expect(shortestPath(city, 0, 5, closed)).toEqual([H(0, 0), V(1, 0)]);
    // Hop count instead of feet: straight along 1st St beats the shorter dog-leg.
    const detour = makeGridCity();
    detour.segments[H(0, 0)] = { ...seg(detour, H(0, 0)), lengthFt: 10_000 };
    expect(shortestPath(detour, 0, 1, () => 1)).toEqual([H(0, 0)]);
    // Every way into node 0 closed: unreachable.
    const fenced = (s: StreetSegment) => (s.a === 0 || s.b === 0 ? Infinity : s.lengthFt);
    expect(shortestPath(city, 5, 0, fenced)).toBeNull();
    expect(shortestPath(city, 0, 0, fenced)).toEqual([]);
  });

  it('returns null when unreachable or for invalid nodes', () => {
    const grid = makeGridCity();
    const island: City = { ...grid, nodes: [...grid.nodes, { id: 12, x: 2, y: 1 }] };
    expect(shortestPath(island, 0, 12)).toBeNull();
    expect(shortestPath(island, 12, 0)).toBeNull();
    expect(shortestPath(island, 12, 12)).toEqual([]);
    expect(shortestPath(city, 0, 99)).toBeNull();
    expect(shortestPath(city, -1, 0)).toBeNull();
    expect(shortestPath(city, 0.5, 0)).toBeNull();
  });

  it('finds contiguous minimum-length routes across a large grid', () => {
    const big = makeGridCity({ cols: 12, rows: 9, blockW: 5, blockH: 3 });
    const rng = new Rng(99);
    for (let k = 0; k < 200; k++) {
      const from = rng.int(0, big.nodes.length - 1);
      const to = rng.int(0, big.nodes.length - 1);
      const path = shortestPath(big, from, to)!;
      expect(walk(big, from, path)).toBe(to);
      const a = big.nodes[from]!;
      const b = big.nodes[to]!;
      // On a perfect grid the shortest route is the Manhattan distance.
      expect(pathLength(big, path)).toBe((Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) * big.tileFt);
    }
  });
});

describe('nearestNode', () => {
  const city = makeGridCity();

  it('picks the closest node', () => {
    expect(nearestNode(city, 0.4, 0.3)).toBe(0);
    expect(nearestNode(city, 3.9, 1.8)).toBe(5);
    expect(nearestNode(city, 12, 4)).toBe(11);
  });

  it('breaks ties toward the lower id', () => {
    // Centre of a block: equidistant from nodes 0, 1, 4 and 5.
    expect(nearestNode(city, 2, 1)).toBe(0);
    expect(nearestNode(city, 2, 1.5)).toBe(4);
  });

  it('works for points outside the map', () => {
    expect(nearestNode(city, -10, -10)).toBe(0);
    expect(nearestNode(city, 100, 1)).toBe(3);
    expect(nearestNode(city, 100, 3.5)).toBe(11);
  });

  it('rejects non-finite points', () => {
    expect(() => nearestNode(city, Number.NaN, 0)).toThrow(RangeError);
  });

  it('matches a brute-force scan', () => {
    const cities = [
      makeGridCity({ cols: 20, rows: 15, blockW: 7, blockH: 3 }),
      makeGridCity({ cols: 1, rows: 1, blockW: 60, blockH: 40 }),
      makeGridCity({ cols: 9, rows: 4, blockW: 2, blockH: 9 }),
    ];
    const rng = new Rng(7);
    for (const c of cities) {
      for (let k = 0; k < 500; k++) {
        const x = rng.next() * (c.width + 40) - 20;
        const y = rng.next() * (c.height + 40) - 20;
        expect(nearestNode(c, x, y)).toBe(bruteNearestNode(c, x, y));
      }
    }
  });
});

describe('nearestSegment', () => {
  const city = makeGridCity();

  it('picks the closest segment by perpendicular distance', () => {
    expect(nearestSegment(city, 1, 0.2)).toBe(H(0, 0));
    expect(nearestSegment(city, 0.3, 1)).toBe(V(0, 0));
    expect(nearestSegment(city, 10, 3.9)).toBe(H(2, 2));
  });

  it('breaks ties toward the lower id', () => {
    // Between 1st St and 2nd St, one cell from each.
    expect(nearestSegment(city, 2, 1)).toBe(H(0, 0));
    // On a node every touching segment is at distance 0.
    expect(nearestSegment(city, 4, 2)).toBe(H(0, 1));
  });

  it('honours maxDist', () => {
    expect(nearestSegment(city, 2, 1, 0.5)).toBeNull();
    expect(nearestSegment(city, 2, 1, 1)).toBe(H(0, 0));
    expect(nearestSegment(city, 1, 0.2, 0)).toBeNull();
    expect(nearestSegment(city, 1, 0, 0)).toBe(H(0, 0));
  });

  it('works for points outside the map', () => {
    expect(nearestSegment(city, -10, -10)).toBe(H(0, 0));
    expect(nearestSegment(city, 100, 1)).toBe(V(3, 0));
    expect(nearestSegment(city, 100, 1, 50)).toBeNull();
  });

  it('returns null for non-finite input', () => {
    expect(nearestSegment(city, Number.NaN, 1)).toBeNull();
    expect(nearestSegment(city, 1, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('matches a brute-force scan', () => {
    const cities = [
      makeGridCity({ cols: 20, rows: 15, blockW: 7, blockH: 3 }),
      makeGridCity({ cols: 1, rows: 1, blockW: 60, blockH: 40 }),
      makeGridCity({ cols: 9, rows: 4, blockW: 2, blockH: 9 }),
    ];
    const rng = new Rng(11);
    for (const c of cities) {
      for (let k = 0; k < 500; k++) {
        const x = rng.next() * (c.width + 40) - 20;
        const y = rng.next() * (c.height + 40) - 20;
        const maxDist = k % 3 === 0 ? rng.next() * 6 : Infinity;
        expect(nearestSegment(c, x, y, maxDist)).toBe(bruteNearestSegment(c, x, y, maxDist));
      }
      // Lattice points hit exact ties between several segments.
      for (let x = -2; x <= c.width + 2; x++) {
        for (let y = -2; y <= c.height + 2; y++) {
          expect(nearestSegment(c, x, y)).toBe(bruteNearestSegment(c, x, y));
        }
      }
    }
  });
});

describe('polesOnSegment', () => {
  const base = seg(makeGridCity(), 0);

  it('spaces poles every POLE_SPACING_FT with at least one', () => {
    expect(polesOnSegment({ ...base, lengthFt: 240 })).toBe(2);
    expect(polesOnSegment({ ...base, lengthFt: 120 })).toBe(1);
    expect(polesOnSegment({ ...base, lengthFt: 60 })).toBe(1);
    expect(polesOnSegment({ ...base, lengthFt: 1500 })).toBe(10);
  });

  it('is zero without poles', () => {
    expect(polesOnSegment({ ...base, hasPoles: false })).toBe(0);
  });
});
