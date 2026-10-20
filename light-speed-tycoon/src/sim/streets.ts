// Street-graph queries over an immutable City. Indexes (adjacency lists,
// node-pair lookup, spatial buckets) are built lazily per City and cached in
// WeakMaps; City objects are never mutated after generation.

import { POLE_SPACING_FT } from './balance';
import type { City, NodeId, ParcelId, SegmentId, StreetNode, StreetSegment } from './types';

const EMPTY: readonly SegmentId[] = Object.freeze([]);

// ---------------------------------------------------------------------------
// Graph index
// ---------------------------------------------------------------------------

interface GraphIndex {
  /** Segment ids touching each node, ascending. */
  adjacency: SegmentId[][];
  /** Segment id by pairKey of its endpoints. */
  pairs: Map<number, SegmentId>;
}

const graphCache = new WeakMap<City, GraphIndex>();

function pairKey(city: City, a: NodeId, b: NodeId): number {
  return Math.min(a, b) * city.nodes.length + Math.max(a, b);
}

function graphIndex(city: City): GraphIndex {
  let index = graphCache.get(city);
  if (!index) {
    const adjacency: SegmentId[][] = city.nodes.map(() => []);
    const pairs = new Map<number, SegmentId>();
    // Segments are visited in id order, so every adjacency list comes out ascending.
    for (const seg of city.segments) {
      adjacency[seg.a]?.push(seg.id);
      adjacency[seg.b]?.push(seg.id);
      pairs.set(pairKey(city, seg.a, seg.b), seg.id);
    }
    index = { adjacency, pairs };
    graphCache.set(city, index);
  }
  return index;
}

/** True when `id` is a valid node id for this city. */
export function isNodeId(city: City, id: unknown): id is NodeId {
  return Number.isInteger(id) && (id as number) >= 0 && (id as number) < city.nodes.length;
}

/** True when `id` is a valid segment id for this city. */
export function isSegmentId(city: City, id: unknown): id is SegmentId {
  return Number.isInteger(id) && (id as number) >= 0 && (id as number) < city.segments.length;
}

/** Segment ids touching a node, ascending. */
export function segmentsAtNode(city: City, node: NodeId): readonly SegmentId[] {
  if (!isNodeId(city, node)) return EMPTY;
  return graphIndex(city).adjacency[node] ?? EMPTY;
}

/** The segment joining two adjacent nodes (either order), if any. */
export function segmentBetween(city: City, a: NodeId, b: NodeId): SegmentId | undefined {
  if (!isNodeId(city, a) || !isNodeId(city, b)) return undefined;
  return graphIndex(city).pairs.get(pairKey(city, a, b));
}

/** The endpoint of `segment` that is not `node`. Throws if node is not an endpoint. */
export function otherEnd(segment: StreetSegment, node: NodeId): NodeId {
  if (node === segment.a) return segment.b;
  if (node === segment.b) return segment.a;
  throw new RangeError(`Node ${node} is not an endpoint of segment ${segment.id}`);
}

/** Display name of a street node from the streets meeting there, e.g. "1st St & B Ave". */
export function cornerName(city: City, node: NodeId): string {
  const names: string[] = [];
  for (const id of segmentsAtNode(city, node)) {
    const name = city.segments[id]?.name;
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names.length > 0 ? names.join(' & ') : `Node ${node}`;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

interface HeapItem {
  dist: number;
  node: NodeId;
}

function heapLess(x: HeapItem, y: HeapItem): boolean {
  return x.dist < y.dist || (x.dist === y.dist && x.node < y.node);
}

function heapPush(heap: HeapItem[], item: HeapItem): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!heapLess(heap[i] as HeapItem, heap[parent] as HeapItem)) break;
    [heap[i], heap[parent]] = [heap[parent] as HeapItem, heap[i] as HeapItem];
    i = parent;
  }
}

function heapPop(heap: HeapItem[]): HeapItem | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (top === undefined || last === undefined || heap.length === 0) return top;
  heap[0] = last;
  let i = 0;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let min = i;
    if (l < heap.length && heapLess(heap[l] as HeapItem, heap[min] as HeapItem)) min = l;
    if (r < heap.length && heapLess(heap[r] as HeapItem, heap[min] as HeapItem)) min = r;
    if (min === i) break;
    [heap[i], heap[min]] = [heap[min] as HeapItem, heap[i] as HeapItem];
    i = min;
  }
  return top;
}

/**
 * What travelling along a segment costs a route: a positive number, or
 * Infinity (any non-finite value) where the route may not go.
 */
export type SegmentCost = (segment: StreetSegment) => number;

const byLength: SegmentCost = (segment) => segment.lengthFt;

/**
 * Cheapest route along streets from one node to another (Dijkstra), weighted by
 * `cost` (default: lengthFt, i.e. the shortest route). Returns segment ids in
 * travel order, [] when from === to, or null when unreachable. Deterministic:
 * ties break toward the lower segment id.
 */
export function shortestPath(city: City, from: NodeId, to: NodeId, cost: SegmentCost = byLength): SegmentId[] | null {
  if (!isNodeId(city, from) || !isNodeId(city, to)) return null;
  if (from === to) return [];
  const { adjacency } = graphIndex(city);
  const n = city.nodes.length;
  const dist = new Float64Array(n).fill(Infinity);
  // Segment each node is entered by on its best route; -1 = not reached.
  const via = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap: HeapItem[] = [];
  dist[from] = 0;
  heapPush(heap, { dist: 0, node: from });

  for (let item = heapPop(heap); item; item = heapPop(heap)) {
    const u = item.node;
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) break;
    for (const segId of adjacency[u] ?? EMPTY) {
      const seg = city.segments[segId] as StreetSegment;
      const v = otherEnd(seg, u);
      if (done[v]) continue;
      const step = cost(seg);
      if (!Number.isFinite(step)) continue;
      const d = item.dist + step;
      const best = dist[v] as number;
      // Costs are positive, so every equal-cost predecessor of v is settled
      // before v is: keeping the lowest entering segment id is order-independent.
      if (d < best || (d === best && segId < (via[v] as number))) {
        dist[v] = d;
        via[v] = segId;
        if (d < best) heapPush(heap, { dist: d, node: v });
      }
    }
  }

  if (!done[to]) return null;
  const path: SegmentId[] = [];
  for (let node = to; node !== from; ) {
    const segId = via[node] as number;
    path.push(segId);
    node = otherEnd(city.segments[segId] as StreetSegment, node);
  }
  return path.reverse();
}

// ---------------------------------------------------------------------------
// Picking
// ---------------------------------------------------------------------------

// Bucket edge in grid units: a few blocks' worth, so each bucket holds a handful
// of nodes and segments and a pick touches only nearby ones.
const BUCKET_CELLS = 8;

interface SpatialIndex {
  /** Bounding box of all nodes; every node and segment lies inside it. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  cols: number;
  rows: number;
  /** Ids per bucket (row-major), ascending. */
  nodes: NodeId[][];
  segments: SegmentId[][];
}

const spatialCache = new WeakMap<City, SpatialIndex | null>();

function spatialIndex(city: City): SpatialIndex | null {
  let index = spatialCache.get(city);
  if (index === undefined) {
    index = buildSpatialIndex(city);
    spatialCache.set(city, index);
  }
  return index;
}

function buildSpatialIndex(city: City): SpatialIndex | null {
  if (city.nodes.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of city.nodes) {
    x0 = Math.min(x0, n.x);
    y0 = Math.min(y0, n.y);
    x1 = Math.max(x1, n.x);
    y1 = Math.max(y1, n.y);
  }
  const cols = Math.floor((x1 - x0) / BUCKET_CELLS) + 1;
  const rows = Math.floor((y1 - y0) / BUCKET_CELLS) + 1;
  const index: SpatialIndex = {
    x0,
    y0,
    x1,
    y1,
    cols,
    rows,
    nodes: Array.from({ length: cols * rows }, () => []),
    segments: Array.from({ length: cols * rows }, () => []),
  };
  for (const n of city.nodes) {
    index.nodes[bucketRow(index, n.y) * cols + bucketCol(index, n.x)]?.push(n.id);
  }
  for (const seg of city.segments) {
    const a = city.nodes[seg.a];
    const b = city.nodes[seg.b];
    if (!a || !b) continue;
    const c0 = bucketCol(index, Math.min(a.x, b.x));
    const c1 = bucketCol(index, Math.max(a.x, b.x));
    const r0 = bucketRow(index, Math.min(a.y, b.y));
    const r1 = bucketRow(index, Math.max(a.y, b.y));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) index.segments[r * cols + c]?.push(seg.id);
    }
  }
  return index;
}

function bucketCol(index: SpatialIndex, x: number): number {
  return Math.min(index.cols - 1, Math.max(0, Math.floor((x - index.x0) / BUCKET_CELLS)));
}

function bucketRow(index: SpatialIndex, y: number): number {
  return Math.min(index.rows - 1, Math.max(0, Math.floor((y - index.y0) / BUCKET_CELLS)));
}

/**
 * Visit bucket contents in rings of growing Chebyshev radius around the point.
 * `visit` returns the best squared distance so far; the search stops once no
 * unvisited bucket can hold anything at least as close, or beyond `maxDist2`.
 *
 * Bound: the point is first clamped into the index's bounding box (projection
 * onto a box never increases distance to anything inside it). Every point in a
 * bucket at ring k >= 1 is then at least (k - 1) * BUCKET_CELLS away, so after
 * rings 0..r, anything unvisited is at least r * BUCKET_CELLS away.
 */
function searchRings(
  index: SpatialIndex,
  buckets: readonly (readonly number[])[],
  x: number,
  y: number,
  maxDist2: number,
  visit: (id: number) => number,
): void {
  const cx = bucketCol(index, Math.min(index.x1, Math.max(index.x0, x)));
  const cy = bucketRow(index, Math.min(index.y1, Math.max(index.y0, y)));
  const maxRing = Math.max(cx, index.cols - 1 - cx, cy, index.rows - 1 - cy);
  let best2 = Infinity;
  for (let r = 0; r <= maxRing; r++) {
    // Everything not yet visited lies in ring r or beyond.
    const bound = Math.max(0, r - 1) * BUCKET_CELLS;
    if (best2 < bound * bound || bound * bound > maxDist2) return;
    for (let dy = -r; dy <= r; dy++) {
      const row = cy + dy;
      if (row < 0 || row >= index.rows) continue;
      // Interior rows of the ring only contribute their two edge buckets.
      const step = Math.abs(dy) === r ? 1 : 2 * r;
      for (let dx = -r; dx <= r; dx += step) {
        const col = cx + dx;
        if (col < 0 || col >= index.cols) continue;
        for (const id of buckets[row * index.cols + col] ?? EMPTY) best2 = visit(id);
      }
    }
  }
}

/** Closest node to a map point (grid units). Ties break toward the lower id. */
export function nearestNode(city: City, x: number, y: number): NodeId {
  const index = spatialIndex(city);
  if (!index || !Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError(`nearestNode: no node near (${x}, ${y})`);
  }
  let best = -1;
  let best2 = Infinity;
  searchRings(index, index.nodes, x, y, Infinity, (id) => {
    const n = city.nodes[id] as StreetNode;
    const ex = n.x - x;
    const ey = n.y - y;
    const d2 = ex * ex + ey * ey;
    if (d2 < best2 || (d2 === best2 && id < best)) {
      best = id;
      best2 = d2;
    }
    return best2;
  });
  return best;
}

/** Squared distance from a point to the segment between (ax, ay) and (bx, by). */
function segmentDist2(x: number, y: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / len2));
  const ex = ax + t * dx - x;
  const ey = ay + t * dy - y;
  return ex * ex + ey * ey;
}

/**
 * Closest segment to a map point by perpendicular distance (grid units), or null
 * if none is within maxDist. Ties break toward the lower id.
 */
export function nearestSegment(city: City, x: number, y: number, maxDist = Infinity): SegmentId | null {
  const index = spatialIndex(city);
  if (!index || !Number.isFinite(x) || !Number.isFinite(y) || !(maxDist >= 0)) return null;
  const maxDist2 = maxDist * maxDist;
  let best = -1;
  let best2 = Infinity;
  searchRings(index, index.segments, x, y, maxDist2, (id) => {
    const seg = city.segments[id] as StreetSegment;
    const a = city.nodes[seg.a] as StreetNode;
    const b = city.nodes[seg.b] as StreetNode;
    const d2 = segmentDist2(x, y, a.x, a.y, b.x, b.y);
    if (d2 < best2 || (d2 === best2 && id < best)) {
      best = id;
      best2 = d2;
    }
    return best2;
  });
  return best >= 0 && best2 <= maxDist2 ? best : null;
}

/** Number of utility poles along a segment (0 when it has none): max(1, round(lengthFt / POLE_SPACING_FT)). */
export function polesOnSegment(segment: StreetSegment): number {
  return segment.hasPoles ? Math.max(1, Math.round(segment.lengthFt / POLE_SPACING_FT)) : 0;
}

// ---------------------------------------------------------------------------
// Reach (bounded street distance)
// ---------------------------------------------------------------------------

/** A segment within reach of a node, with the street distance (ft) to its nearer endpoint. */
export interface SegmentReach {
  segment: SegmentId;
  distanceFt: number;
}

/**
 * Segments with an endpoint strictly closer than `limitFt` to `from` along
 * streets, travelling only on segments `allowed` accepts (default: every
 * street); only accepted segments are returned. distanceFt is the shortest
 * route length (sum of lengthFt) from `from` to the segment's nearer endpoint,
 * so a segment touching `from` has distance 0 however long it is. Ascending by
 * segment id. An invalid node or a limit that is not > 0 returns [].
 *
 * A bounded Dijkstra: it only touches nodes closer than the limit, so its cost
 * scales with the area in reach, not the town. Deterministic, arithmetic only.
 */
export function segmentsWithin(
  city: City,
  from: NodeId,
  limitFt: number,
  allowed?: (segment: StreetSegment) => boolean,
): SegmentReach[] {
  if (!isNodeId(city, from) || !(limitFt > 0)) return [];
  const { adjacency } = graphIndex(city);
  // Reuse the City's scratch arrays (cleared in O(1) by bumping the stamp)
  // unless a callback re-entered us, which then gets arrays of its own.
  const shared = reachScratch(city);
  const sc = shared.busy ? newReachScratch(city) : shared;
  sc.busy = true;
  try {
    if (sc.stamp >= 0xfffffffe) {
      sc.nodeStamp.fill(0);
      sc.doneStamp.fill(0);
      sc.segStamp.fill(0);
      sc.stamp = 0;
    }
    const stamp = ++sc.stamp;
    const { dist, nodeStamp, doneStamp, segStamp, segDist } = sc;
    const found: SegmentId[] = [];
    const heap: HeapItem[] = [{ dist: 0, node: from }];
    dist[from] = 0;
    nodeStamp[from] = stamp;

    // Every node on the heap is closer than the limit; nodes settle in order of
    // distance, so the first settled endpoint of a segment is its nearer one.
    for (let item = heapPop(heap); item; item = heapPop(heap)) {
      const u = item.node;
      if (doneStamp[u] === stamp) continue;
      doneStamp[u] = stamp;
      for (const segId of adjacency[u] ?? EMPTY) {
        const seg = city.segments[segId] as StreetSegment;
        if (allowed && !allowed(seg)) continue;
        if (segStamp[segId] !== stamp) {
          segStamp[segId] = stamp;
          segDist[segId] = item.dist;
          found.push(segId);
        }
        const v = otherEnd(seg, u);
        if (doneStamp[v] === stamp) continue;
        const d = item.dist + seg.lengthFt;
        if (d < limitFt && (nodeStamp[v] !== stamp || d < (dist[v] as number))) {
          dist[v] = d;
          nodeStamp[v] = stamp;
          heapPush(heap, { dist: d, node: v });
        }
      }
    }

    found.sort((x, y) => x - y);
    return found.map((segment) => ({ segment, distanceFt: segDist[segment] as number }));
  } finally {
    sc.busy = false;
  }
}

interface ReachScratch {
  /** Tentative node distances, valid where nodeStamp === stamp. */
  dist: Float64Array;
  nodeStamp: Uint32Array;
  /** Settled nodes: doneStamp === stamp. */
  doneStamp: Uint32Array;
  /** Found segments (segStamp === stamp) and their distances. */
  segStamp: Uint32Array;
  segDist: Float64Array;
  stamp: number;
  busy: boolean;
}

const reachScratchCache = new WeakMap<City, ReachScratch>();

function newReachScratch(city: City): ReachScratch {
  const n = city.nodes.length;
  const m = city.segments.length;
  return {
    dist: new Float64Array(n),
    nodeStamp: new Uint32Array(n),
    doneStamp: new Uint32Array(n),
    segStamp: new Uint32Array(m),
    segDist: new Float64Array(m),
    stamp: 0,
    busy: false,
  };
}

function reachScratch(city: City): ReachScratch {
  let sc = reachScratchCache.get(city);
  if (!sc) {
    sc = newReachScratch(city);
    reachScratchCache.set(city, sc);
  }
  return sc;
}

// ---------------------------------------------------------------------------
// Parcels along streets
// ---------------------------------------------------------------------------

const EMPTY_PARCELS: readonly ParcelId[] = Object.freeze([]);

const servedCache = new WeakMap<City, ParcelId[][]>();

/**
 * Parcels (present and future) whose serving segment (Parcel.segment) is
 * `segment`, ascending ids. These are the only parcels cable on the segment
 * passes. Indexed lazily per City. Unknown segment -> [].
 */
export function parcelsServedBy(city: City, segment: SegmentId): readonly ParcelId[] {
  let index = servedCache.get(city);
  if (!index) {
    index = city.segments.map(() => []);
    // Parcels are visited in id order, so every list comes out ascending.
    for (const parcel of city.parcels) index[parcel.segment]?.push(parcel.id);
    servedCache.set(city, index);
  }
  return (isSegmentId(city, segment) ? index[segment] : undefined) ?? EMPTY_PARCELS;
}

const touchingCache = new WeakMap<City, ParcelId[][]>();

/**
 * Every parcel (present or future) whose footprint shares an edge of positive
 * length with the segment's street line, whether or not the segment serves it
 * (corner and through lots touch more than one street). Ascending ids.
 * Indexed lazily per City like the other caches. Used for "N buildings along
 * this route face another street" (parcels touching a segment whose
 * Parcel.segment is different). Unknown segment -> [].
 */
export function parcelsTouchingSegment(city: City, segment: SegmentId): readonly ParcelId[] {
  let index = touchingCache.get(city);
  if (!index) {
    index = buildTouchingIndex(city);
    touchingCache.set(city, index);
  }
  return (isSegmentId(city, segment) ? index[segment] : undefined) ?? EMPTY_PARCELS;
}

function buildTouchingIndex(city: City): ParcelId[][] {
  // Unit lattice edges: the edge from (x, y) one cell east (dir 0) or south (dir 1).
  let maxX = city.width;
  for (const n of city.nodes) maxX = Math.max(maxX, n.x);
  for (const p of city.parcels) maxX = Math.max(maxX, p.x + p.w);
  const stride = maxX + 1;
  const edgeKey = (x: number, y: number, dir: 0 | 1) => (y * stride + x) * 2 + dir;

  const edgeSegment = new Map<number, SegmentId>();
  for (const seg of city.segments) {
    const a = city.nodes[seg.a];
    const b = city.nodes[seg.b];
    if (!a || !b) continue;
    if (a.y === b.y) {
      for (let x = Math.min(a.x, b.x); x < Math.max(a.x, b.x); x++) edgeSegment.set(edgeKey(x, a.y, 0), seg.id);
    } else if (a.x === b.x) {
      for (let y = Math.min(a.y, b.y); y < Math.max(a.y, b.y); y++) edgeSegment.set(edgeKey(a.x, y, 1), seg.id);
    }
  }

  const index: ParcelId[][] = city.segments.map(() => []);
  for (const p of city.parcels) {
    const touched = new Set<SegmentId>();
    const add = (key: number) => {
      const id = edgeSegment.get(key);
      if (id !== undefined) touched.add(id);
    };
    for (let i = 0; i < p.w; i++) {
      add(edgeKey(p.x + i, p.y, 0)); // top side
      add(edgeKey(p.x + i, p.y + p.h, 0)); // bottom side
    }
    for (let j = 0; j < p.h; j++) {
      add(edgeKey(p.x, p.y + j, 1)); // left side
      add(edgeKey(p.x + p.w, p.y + j, 1)); // right side
    }
    // Parcels are visited in id order, so every list comes out ascending.
    for (const id of touched) index[id]?.push(p.id);
  }
  return index;
}
