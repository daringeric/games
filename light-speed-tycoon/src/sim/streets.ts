// Street-graph queries over an immutable City. Implementations may cache a
// per-city index (adjacency lists, node-pair lookup, spatial buckets) in a
// WeakMap<City, ...>; City objects are never mutated after generation.

import type { City, NodeId, SegmentId, StreetSegment } from './types';

const NOT_IMPLEMENTED = 'not implemented';

/** Segment ids touching a node, ascending. */
export function segmentsAtNode(city: City, node: NodeId): readonly SegmentId[] {
  void city;
  void node;
  throw new Error(NOT_IMPLEMENTED);
}

/** The segment joining two adjacent nodes (either order), if any. */
export function segmentBetween(city: City, a: NodeId, b: NodeId): SegmentId | undefined {
  void city;
  void a;
  void b;
  throw new Error(NOT_IMPLEMENTED);
}

/** The endpoint of `segment` that is not `node`. Throws if node is not an endpoint. */
export function otherEnd(segment: StreetSegment, node: NodeId): NodeId {
  void segment;
  void node;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Shortest route along streets from one node to another, weighted by lengthFt
 * (Dijkstra). Returns segment ids in travel order, [] when from === to, or null
 * when unreachable. Deterministic: ties break toward the lower segment id.
 */
export function shortestPath(city: City, from: NodeId, to: NodeId): SegmentId[] | null {
  void city;
  void from;
  void to;
  throw new Error(NOT_IMPLEMENTED);
}

/** Closest node to a map point (grid units). Ties break toward the lower id. */
export function nearestNode(city: City, x: number, y: number): NodeId {
  void city;
  void x;
  void y;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Closest segment to a map point by perpendicular distance (grid units), or null
 * if none is within maxDist. Ties break toward the lower id.
 */
export function nearestSegment(city: City, x: number, y: number, maxDist = Infinity): SegmentId | null {
  void city;
  void x;
  void y;
  void maxDist;
  throw new Error(NOT_IMPLEMENTED);
}

/** Number of utility poles along a segment (0 when it has none): max(1, round(lengthFt / POLE_SPACING_FT)). */
export function polesOnSegment(segment: StreetSegment): number {
  void segment;
  throw new Error(NOT_IMPLEMENTED);
}
