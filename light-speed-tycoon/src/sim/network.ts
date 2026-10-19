// Player-built plant: quoting, ordering and removing cable and cabinets, the
// daily build pipeline, and which homes the network passes.
//
// Rules (M1 scaffold):
// - layCable: one span per segment; segments that already have a span are
//   skipped and never charged; duplicate ids in the request are ignored.
//   Aerial requires hasPoles on every new segment (else reject, naming the
//   streets). Cost = lengthFt x per-ft rate (x ROCK_MULTIPLIER for underground
//   on rock), rounded to whole dollars per span. Reject if cash can't cover it.
//   The whole order shares one permitting draw: aerial = make-ready
//   (MAKE_READY_* incl. the long-delay chance), underground = PERMIT_DAYS_*.
//   Each span's construct days = max(1, ceil(lengthFt / ft-per-day)).
// - placeCabinet: on a street node, at most one per node, starts with
//   CABINET_START_SPLITTERS splitters; total splitters across all cabinets may
//   not exceed olt.ponPorts. Cost = CABINET_COST + splitters x SPLITTER_COST.
// - removeSpan: permitting -> refund PERMITTING_CANCEL_REFUND x cost; later
//   stages -> removed with no refund.
// - Every successful order/removal posts to the ledger and bumps network.version.

import type {
  CabinetQuote,
  CableMethod,
  CableQuote,
  CableSpan,
  CommandResult,
  GameState,
  NodeId,
  SegmentId,
  ServiceSnapshot,
  SpanId,
} from './types';
import type { Rng } from './rng';

const NOT_IMPLEMENTED = 'not implemented';

/** Estimate a cable order without changing state. */
export function quoteCable(state: GameState, segments: readonly SegmentId[], method: CableMethod): CableQuote {
  void state;
  void segments;
  void method;
  throw new Error(NOT_IMPLEMENTED);
}

/** Order cable. `rng` is the events stream (used for the permitting draw). */
export function layCable(state: GameState, segments: readonly SegmentId[], method: CableMethod, rng: Rng): CommandResult {
  void state;
  void segments;
  void method;
  void rng;
  throw new Error(NOT_IMPLEMENTED);
}

/** Estimate a cabinet without changing state. */
export function quoteCabinet(state: GameState, node: NodeId): CabinetQuote {
  void state;
  void node;
  throw new Error(NOT_IMPLEMENTED);
}

export function placeCabinet(state: GameState, node: NodeId): CommandResult {
  void state;
  void node;
  throw new Error(NOT_IMPLEMENTED);
}

export function removeSpan(state: GameState, span: SpanId): CommandResult {
  void state;
  void span;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Advance every span and cabinet by one day: decrement stageDaysLeft; at 0,
 * permitting -> constructing (stageDaysLeft = constructDays for spans,
 * CABINET_CONSTRUCT_DAYS for cabinets), constructing -> live (liveDay = state.day).
 * Bumps network.version if any stage changed. Called by tick() after state.day
 * has been incremented.
 */
export function advanceNetwork(state: GameState): void {
  void state;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Recompute service from scratch. A segment is lit when it has a live span, its
 * span is connected to the CO node through live spans, and at least one cabinet
 * in that CO-connected network is active. A cabinet is active when live and its
 * node is the CO node or touches a CO-connected live span.
 */
export function computeService(state: GameState): ServiceSnapshot {
  void state;
  throw new Error(NOT_IMPLEMENTED);
}

/** computeService memoized on (state, network.version, day). Safe to call every frame. */
export function getService(state: GameState): ServiceSnapshot {
  void state;
  throw new Error(NOT_IMPLEMENTED);
}

export function spanOnSegment(state: GameState, segment: SegmentId): CableSpan | undefined {
  void state;
  void segment;
  throw new Error(NOT_IMPLEMENTED);
}
