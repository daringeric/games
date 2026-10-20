// Drag-to-draw cable: the corners a press-and-drag has visited and the street
// route through them. Pure (no DOM, no Pixi) so it unit-tests against
// hand-built states; tools.ts owns one while a drag is under way.

import { cableRoute } from '../sim/network';
import { nearestNode } from '../sim/streets';
import type { CableMethod, City, GameState, NodeId, SegmentId } from '../sim/types';

/**
 * A cable run being drawn by dragging: it starts at a corner and appends the
 * nearest corner as the pointer moves. Moving back onto the previous-but-one
 * corner pops the last one, so dragging back along the way undoes it.
 */
export class CableDrag {
  private readonly nodes: NodeId[];
  /**
   * Street route of each leg (legs[i] runs corners[i] -> corners[i + 1]),
   * computed lazily and kept while the state and its network version stay the
   * same: a drag only ever changes its last leg, so a long drag stays cheap.
   */
  private legs: (SegmentId[] | null)[] = [];
  private legsFor: { state: GameState; version: number } | null = null;

  constructor(
    readonly method: CableMethod,
    start: NodeId,
  ) {
    this.nodes = [start];
  }

  /** Visited corners, the start first. */
  get corners(): readonly NodeId[] {
    return this.nodes;
  }

  get start(): NodeId {
    return this.nodes[0] as NodeId;
  }

  get last(): NodeId {
    return this.nodes[this.nodes.length - 1] as NodeId;
  }

  /** The pointer is over grid point (x, y): visit its nearest corner. True when the corners changed. */
  moveTo(city: City, x: number, y: number): boolean {
    return this.visit(nearestNode(city, x, y));
  }

  /**
   * Visit a corner: nothing when it is the last one, a backtrack (pop) when it
   * is the previous-but-one, otherwise appended. True when the corners changed.
   */
  visit(node: NodeId): boolean {
    const n = this.nodes;
    if (node === n[n.length - 1]) return false;
    if (n.length >= 2 && node === n[n.length - 2]) {
      n.pop();
      this.legs.length = Math.min(this.legs.length, n.length - 1);
      return true;
    }
    n.push(node);
    return true;
  }

  /** The street route through the visited corners: routeThrough(state, corners, method), with legs cached. */
  route(state: GameState): SegmentId[] | null {
    if (this.legsFor?.state !== state || this.legsFor.version !== state.network.version) {
      this.legs = [];
      this.legsFor = { state, version: state.network.version };
    }
    for (let i = this.legs.length; i < this.nodes.length - 1; i++) {
      this.legs.push(cableRoute(state, this.nodes[i] as NodeId, this.nodes[i + 1] as NodeId, this.method));
    }
    return joinLegs(this.legs);
  }
}

/**
 * The cable route through `corners` in order: each leg is cableRoute(state,
 * from, to, method) (so aerial legs keep to poles where the detour is short
 * enough), legs are concatenated, a segment that immediately retraces the one
 * before it cancels both (an exact reversal), and any segment already on the
 * route is dropped. Null when any leg is unreachable; [] for fewer than two
 * distinct corners.
 */
export function routeThrough(state: GameState, corners: readonly NodeId[], method: CableMethod): SegmentId[] | null {
  const legs: (SegmentId[] | null)[] = [];
  for (let i = 1; i < corners.length; i++) {
    const from = corners[i - 1] as NodeId;
    const to = corners[i] as NodeId;
    legs.push(from === to ? [] : cableRoute(state, from, to, method));
  }
  return joinLegs(legs);
}

/** Concatenate legs, cancelling exact reversals and dropping repeats; null if any leg is unreachable. */
function joinLegs(legs: readonly (readonly SegmentId[] | null)[]): SegmentId[] | null {
  const walk: SegmentId[] = [];
  for (const leg of legs) {
    if (!leg) return null;
    for (const seg of leg) {
      if (walk.length > 0 && walk[walk.length - 1] === seg) walk.pop();
      else walk.push(seg);
    }
  }
  const seen = new Set<SegmentId>();
  const route: SegmentId[] = [];
  for (const seg of walk) {
    if (seen.has(seg)) continue;
    seen.add(seg);
    route.push(seg);
  }
  return route;
}
