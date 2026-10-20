// Pure map geometry shared by the renderer and the input layer: where streets
// run on the cell lattice, which side of a lot faces its street, and the inset
// rectangles lots and buildings are drawn in. No Pixi here, so it unit-tests in node.

import { otherEnd, segmentsAtNode } from '../sim/streets';
import type { City, NodeId, Parcel, SegmentId, StreetClass, StreetSegment } from '../sim/types';
import type { Theme } from './theme';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Side = 'top' | 'bottom' | 'left' | 'right';

const CLASS_CODE: Record<StreetClass, number> = { local: 1, collector: 2, arterial: 3 };
const CODE_CLASS: readonly (StreetClass | undefined)[] = [undefined, 'local', 'collector', 'arterial'];

/**
 * Street class of every unit edge of the cell lattice. Segments run along grid
 * lines, so a lot's side either lies on a street or it doesn't.
 */
export interface StreetLattice {
  width: number;
  height: number;
  /** Edge (x, y)-(x+1, y) at index y * width + x; 0 = no street. */
  horizontal: Uint8Array;
  /** Edge (x, y)-(x, y+1) at index y * (width + 1) + x; 0 = no street. */
  vertical: Uint8Array;
  /** Segments touching each node. */
  degree: Uint8Array;
}

const latticeCache = new WeakMap<City, StreetLattice>();

export function streetLattice(city: City): StreetLattice {
  let lattice = latticeCache.get(city);
  if (lattice) return lattice;
  const { width, height } = city;
  lattice = {
    width,
    height,
    horizontal: new Uint8Array(width * (height + 1)),
    vertical: new Uint8Array((width + 1) * height),
    degree: new Uint8Array(city.nodes.length),
  };
  for (const seg of city.segments) {
    const a = city.nodes[seg.a];
    const b = city.nodes[seg.b];
    if (!a || !b) continue;
    lattice.degree[seg.a] = (lattice.degree[seg.a] ?? 0) + 1;
    lattice.degree[seg.b] = (lattice.degree[seg.b] ?? 0) + 1;
    const code = CLASS_CODE[seg.streetClass];
    if (a.y === b.y) {
      for (let x = Math.min(a.x, b.x); x < Math.max(a.x, b.x); x++) lattice.horizontal[a.y * width + x] = code;
    } else {
      for (let y = Math.min(a.y, b.y); y < Math.max(a.y, b.y); y++) lattice.vertical[y * (width + 1) + a.x] = code;
    }
  }
  latticeCache.set(city, lattice);
  return lattice;
}

/** Street class on edge (x, y)-(x+1, y), if any. */
export function horizontalStreet(lattice: StreetLattice, x: number, y: number): StreetClass | undefined {
  if (x < 0 || x >= lattice.width || y < 0 || y > lattice.height) return undefined;
  return CODE_CLASS[lattice.horizontal[y * lattice.width + x] ?? 0];
}

/** Street class on edge (x, y)-(x, y+1), if any. */
export function verticalStreet(lattice: StreetLattice, x: number, y: number): StreetClass | undefined {
  if (x < 0 || x > lattice.width || y < 0 || y >= lattice.height) return undefined;
  return CODE_CLASS[lattice.vertical[y * (lattice.width + 1) + x] ?? 0];
}

/** Widest street along one side of a cell rectangle (grid units), if any. */
export function streetAlongSide(lattice: StreetLattice, r: Rect, side: Side): StreetClass | undefined {
  let best: StreetClass | undefined;
  const consider = (cls: StreetClass | undefined) => {
    if (cls && (!best || CLASS_CODE[cls] > CLASS_CODE[best])) best = cls;
  };
  if (side === 'top' || side === 'bottom') {
    const y = side === 'top' ? r.y : r.y + r.h;
    for (let x = r.x; x < r.x + r.w; x++) consider(horizontalStreet(lattice, x, y));
  } else {
    const x = side === 'left' ? r.x : r.x + r.w;
    for (let y = r.y; y < r.y + r.h; y++) consider(verticalStreet(lattice, x, y));
  }
  return best;
}

/** The side of a parcel that touches its frontage segment. */
export function frontageSide(city: City, parcel: Parcel): Side {
  const seg = city.segments[parcel.segment] as StreetSegment;
  const a = city.nodes[seg.a];
  const b = city.nodes[seg.b];
  if (a && b && a.y === b.y) return a.y === parcel.y ? 'top' : 'bottom';
  if (a && b) return a.x === parcel.x ? 'left' : 'right';
  return 'bottom';
}

/**
 * The lawn rectangle of a parcel in world pixels: the cell footprint pulled back
 * from each street it touches by that street's half-width plus a curb gap, and
 * from neighboring lots by a hairline gap.
 */
export function lotRect(lattice: StreetLattice, parcel: Parcel, theme: Theme): Rect {
  const c = theme.cell;
  const inset = (side: Side) => {
    const cls = streetAlongSide(lattice, parcel, side);
    return cls ? theme.road.width[cls] / 2 + theme.lot.curbGap : theme.lot.sideGap;
  };
  const left = inset('left');
  const right = inset('right');
  const top = inset('top');
  const bottom = inset('bottom');
  return {
    x: parcel.x * c + left,
    y: parcel.y * c + top,
    w: parcel.w * c - left - right,
    h: parcel.h * c - top - bottom,
  };
}

/**
 * Lot-local frame: `u` runs along the frontage, `v` runs from the street into the
 * lot. Lets building code be written once for all four orientations.
 */
export interface LotFrame {
  /** Length along the street. */
  front: number;
  /** Depth away from the street. */
  depth: number;
  /** World rect of a lot-local rect (u, v, along, deep). */
  toWorld(u: number, v: number, along: number, deep: number): Rect;
  /** World point of a lot-local point; negative v lies between the lot and the street. */
  point(u: number, v: number): { x: number; y: number };
  /** True when the street runs horizontally past this lot. */
  horizontal: boolean;
}

export function lotFrame(lot: Rect, side: Side): LotFrame {
  const horizontal = side === 'top' || side === 'bottom';
  const front = horizontal ? lot.w : lot.h;
  const depth = horizontal ? lot.h : lot.w;
  return {
    front,
    depth,
    horizontal,
    toWorld(u, v, along, deep) {
      switch (side) {
        case 'top':
          return { x: lot.x + u, y: lot.y + v, w: along, h: deep };
        case 'bottom':
          return { x: lot.x + u, y: lot.y + lot.h - v - deep, w: along, h: deep };
        case 'left':
          return { x: lot.x + v, y: lot.y + u, w: deep, h: along };
        case 'right':
          return { x: lot.x + lot.w - v - deep, y: lot.y + u, w: deep, h: along };
      }
    },
    point(u, v) {
      switch (side) {
        case 'top':
          return { x: lot.x + u, y: lot.y + v };
        case 'bottom':
          return { x: lot.x + u, y: lot.y + lot.h - v };
        case 'left':
          return { x: lot.x + v, y: lot.y + u };
        case 'right':
          return { x: lot.x + lot.w - v, y: lot.y + u };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Building tells: every building shows the one street that serves it
// (Parcel.segment). Homes have a front walk with a doorstep and a notch at the
// curb, shops an awning facing the street, apartment buildings a demarc box on
// the serving wall with a dashed fiber entry out to the curb.
// ---------------------------------------------------------------------------

/** Roof inset of an apartment building from its lot edge (world px). */
export const MDU_ROOF_PAD = 4;
/** Width of a home's front walk (world px). */
export const HOME_PATH_WIDTH = 3.5;

/** 0..1 from a slice of a hash, for deterministic per-lot variety. */
export function vary(hash: number, shift: number): number {
  return ((hash >>> shift) & 0xff) / 255;
}

function clampTo(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Where a home's house sits in its lot frame: `u` along the street, `setback` from it. */
export interface HomePlan {
  u: number;
  along: number;
  deep: number;
  setback: number;
  /** Centre of the front walk along the street (u). */
  walkU: number;
}

export function homePlan(f: LotFrame, hash: number): HomePlan {
  const along = clampTo(f.front * (0.64 + 0.12 * vary(hash, 0)), 14, 46);
  const deep = clampTo(f.depth * (0.5 + 0.1 * vary(hash, 8)), 12, 26);
  const setback = clampTo(f.depth * 0.14, 3, 8);
  const u = (f.front - along) * (0.3 + 0.4 * vary(hash, 16));
  return { u, along, deep, setback, walkU: u + along / 2 };
}

/** An apartment building's demarc: the box on its serving wall and the fiber entry out to the curb. */
export interface DemarcTell {
  side: Side;
  /** Box straddling the middle of the serving wall (world px). */
  box: Rect;
  /** From the box's street-side edge to the curb (world px). */
  entry: { ax: number; ay: number; bx: number; by: number };
  /** Where the entry meets the curb: the building's drop point. */
  curb: { x: number; y: number };
}

export function mduDemarc(lot: Rect, side: Side, theme: Theme): DemarcTell {
  const f = lotFrame(lot, side);
  const s = theme.demarc.size;
  const mid = f.front / 2;
  const box = f.toWorld(mid - s / 2, MDU_ROOF_PAD - s / 2, s, s);
  const from = f.point(mid, MDU_ROOF_PAD - s / 2);
  const curb = f.point(mid, -theme.lot.curbGap);
  return { side, box, entry: { ax: from.x, ay: from.y, bx: curb.x, by: curb.y }, curb };
}

/**
 * The curb point where a building's drop comes off its serving street: the end
 * of a home's front walk, the middle of a shop front, an apartment building's
 * fiber entry. World px.
 */
export function dropPoint(city: City, lattice: StreetLattice, parcel: Parcel, theme: Theme): { x: number; y: number } {
  const lot = lotRect(lattice, parcel, theme);
  const side = frontageSide(city, parcel);
  if (parcel.kind === 'mdu') return mduDemarc(lot, side, theme).curb;
  const f = lotFrame(lot, side);
  const u = parcel.kind === 'home' ? homePlan(f, hashInt(parcel.id)).walkU : f.front / 2;
  return f.point(u, -theme.lot.curbGap);
}

/** Cheap stable 32-bit hash of an integer, for per-parcel visual variety. */
export function hashInt(n: number): number {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

const parcelGridCache = new WeakMap<City, Int32Array>();

/** Cells covered by any parcel (present or future): a width x height grid of parcel id + 1, 0 = free. */
export function parcelGrid(city: City): Int32Array {
  let grid = parcelGridCache.get(city);
  if (grid) return grid;
  grid = new Int32Array(city.width * city.height);
  for (const p of city.parcels) {
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        if (x >= 0 && x < city.width && y >= 0 && y < city.height) grid[y * city.width + x] = p.id + 1;
      }
    }
  }
  parcelGridCache.set(city, grid);
  return grid;
}

/**
 * Where a street runs off the map: a dead end on the map border whose street
 * points outward. Returns the unit direction out of the map, or null for any
 * other node (an ordinary dead end gets a turnaround bulb instead).
 */
export function mapExit(city: City, lattice: StreetLattice, node: NodeId): { dx: number; dy: number } | null {
  if (lattice.degree[node] !== 1) return null;
  const n = city.nodes[node];
  const seg = city.segments[segmentsAtNode(city, node)[0] ?? -1];
  if (!n || !seg) return null;
  const o = city.nodes[otherEnd(seg, node)];
  if (!o) return null;
  const dx = Math.sign(n.x - o.x);
  const dy = Math.sign(n.y - o.y);
  const out = (n.x === 0 && dx < 0) || (n.x === city.width && dx > 0) || (n.y === 0 && dy < 0) || (n.y === city.height && dy > 0);
  return out ? { dx, dy } : null;
}

/** A straight stretch of one street class, possibly several segments long. */
export interface StreetRun {
  /** End nodes; the run is axis-aligned from a to b. */
  a: NodeId;
  b: NodeId;
  streetClass: StreetClass;
  segments: SegmentId[];
}

function isHorizontal(city: City, seg: StreetSegment): boolean {
  return city.nodes[seg.a]?.y === city.nodes[seg.b]?.y;
}

/**
 * Streets as straight runs: segments joined through plain joints (degree-2 nodes
 * where the same class of street carries straight on, which citygen adds to
 * split long runs). Centre-line dashes follow runs so they don't break at joints.
 */
export function straightRuns(city: City, lattice: StreetLattice): StreetRun[] {
  const visited = new Uint8Array(city.segments.length);
  // The segment that continues `seg` straight through `node`, if node is a plain joint.
  const carryOn = (seg: StreetSegment, node: NodeId): StreetSegment | null => {
    if (lattice.degree[node] !== 2) return null;
    for (const id of segmentsAtNode(city, node)) {
      const next = city.segments[id];
      if (next && next.id !== seg.id && next.streetClass === seg.streetClass && isHorizontal(city, next) === isHorizontal(city, seg)) {
        return next;
      }
    }
    return null;
  };
  const runs: StreetRun[] = [];
  for (const seg of city.segments) {
    if (visited[seg.id]) continue;
    visited[seg.id] = 1;
    const ends: NodeId[] = [];
    const before: SegmentId[] = [];
    const after: SegmentId[] = [];
    for (const [start, list] of [
      [seg.a, before],
      [seg.b, after],
    ] as const) {
      let cur: StreetSegment = seg;
      let node: NodeId = start;
      for (let next = carryOn(cur, node); next && !visited[next.id]; next = carryOn(cur, node)) {
        visited[next.id] = 1;
        list.push(next.id);
        node = otherEnd(next, node);
        cur = next;
      }
      ends.push(node);
    }
    runs.push({ a: ends[0] as NodeId, b: ends[1] as NodeId, streetClass: seg.streetClass, segments: [...before.reverse(), seg.id, ...after] });
  }
  return runs;
}
