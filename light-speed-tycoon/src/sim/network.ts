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

import {
  AERIAL_COST_PER_FT,
  AERIAL_FT_PER_DAY,
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_PERMIT_DAYS,
  CABINET_START_SPLITTERS,
  MAKE_READY_DAYS_MAX,
  MAKE_READY_DAYS_MIN,
  MAKE_READY_LONG_CHANCE,
  MAKE_READY_LONG_DAYS_MAX,
  MAKE_READY_LONG_DAYS_MIN,
  PERMIT_DAYS_MAX,
  PERMIT_DAYS_MIN,
  PERMITTING_CANCEL_REFUND,
  ROCK_MULTIPLIER,
  SPLITTER_COST,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_FT_PER_DAY,
} from './balance';
import { canAfford, formatMoney, groupThousands, postEntry } from './finance';
import type { Rng } from './rng';
import { cornerName, isNodeId, isSegmentId, otherEnd, segmentsAtNode, shortestPath } from './streets';
import type {
  CabinetId,
  CabinetQuote,
  CableMethod,
  CableQuote,
  CableSpan,
  CommandResult,
  GameState,
  Network,
  NodeId,
  ParcelId,
  SegmentId,
  ServiceSnapshot,
  SpanId,
  StreetSegment,
} from './types';

const CABLE: Record<CableMethod, { costPerFt: number; ftPerDay: number }> = {
  aerial: { costPerFt: AERIAL_COST_PER_FT, ftPerDay: AERIAL_FT_PER_DAY },
  underground: { costPerFt: UNDERGROUND_COST_PER_FT, ftPerDay: UNDERGROUND_FT_PER_DAY },
};

function isCableMethod(method: unknown): method is CableMethod {
  return method === 'aerial' || method === 'underground';
}

/** Whole-dollar price of cabling one segment. */
export function cableCost(segment: StreetSegment, method: CableMethod): number {
  const rock = method === 'underground' && segment.rock ? ROCK_MULTIPLIER : 1;
  return Math.round(segment.lengthFt * CABLE[method].costPerFt * rock);
}

function constructDaysFor(segment: StreetSegment, method: CableMethod): number {
  return Math.max(1, Math.ceil(segment.lengthFt / CABLE[method].ftPerDay));
}

/** Full range a permitting draw can land in. */
function permitRange(method: CableMethod): [number, number] {
  if (method === 'underground') return [PERMIT_DAYS_MIN, PERMIT_DAYS_MAX];
  // Quote the long make-ready delay too: the player should plan around it.
  return [MAKE_READY_DAYS_MIN, Math.max(MAKE_READY_DAYS_MAX, MAKE_READY_LONG_DAYS_MAX)];
}

function drawPermitDays(method: CableMethod, rng: Rng): number {
  if (method === 'underground') return rng.int(PERMIT_DAYS_MIN, PERMIT_DAYS_MAX);
  return rng.chance(MAKE_READY_LONG_CHANCE)
    ? rng.int(MAKE_READY_LONG_DAYS_MIN, MAKE_READY_LONG_DAYS_MAX)
    : rng.int(MAKE_READY_DAYS_MIN, MAKE_READY_DAYS_MAX);
}

/** "a, b, c and 2 more" */
function listWithMore(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

function streetNames(state: GameState, segments: readonly SegmentId[]): string[] {
  const names: string[] = [];
  for (const id of segments) {
    const name = state.city.segments[id]?.name;
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

function notEnoughCash(state: GameState, cost: number): string {
  return `Not enough cash: need ${formatMoney(cost)}, have ${formatMoney(state.finance.cash)}`;
}

/**
 * The street route a cable run between two corners takes, for quoting and
 * ordering. Aerial runs keep to segments they can go on (poled, or already
 * cabled, which an order skips) whenever such a route exists, even when a
 * shorter one crosses a street without poles. With no such route they take the
 * plain shortest route, whose quote then names the street that blocks it.
 * Underground runs take the shortest route. Null when unreachable.
 */
export function cableRoute(state: GameState, from: NodeId, to: NodeId, method: CableMethod): SegmentId[] | null {
  const { city } = state;
  if (method === 'aerial') {
    const cabled = new Set<SegmentId>(state.network.spans.map((s) => s.segment));
    const route = shortestPath(city, from, to, (seg) => (seg.hasPoles || cabled.has(seg.id) ? seg.lengthFt : Infinity));
    if (route) return route;
  }
  return shortestPath(city, from, to);
}

/** Estimate a cable order without changing state. */
export function quoteCable(state: GameState, segments: readonly SegmentId[], method: CableMethod): CableQuote {
  const reasons: string[] = [];
  const quote: CableQuote = {
    ok: false,
    reasons,
    newSegments: [],
    lengthFt: 0,
    cost: 0,
    permitDaysMin: 0,
    permitDaysMax: 0,
    constructDays: 0,
  };
  // Commands can arrive from saves or replays, so check shapes, not just types.
  if (!isCableMethod(method)) {
    reasons.push(`Unknown cable method: ${String(method)}`);
    return quote;
  }
  if (!Array.isArray(segments)) {
    reasons.push('No street segments selected');
    return quote;
  }
  [quote.permitDaysMin, quote.permitDaysMax] = permitRange(method);

  // Already-cabled segments and repeats are skipped, never charged.
  const skip = new Set<SegmentId>(state.network.spans.map((s) => s.segment));
  const invalid: string[] = [];
  const noPoles: SegmentId[] = [];
  for (const id of segments) {
    if (!isSegmentId(state.city, id)) {
      invalid.push(String(id));
      continue;
    }
    if (skip.has(id)) continue;
    skip.add(id);
    const segment = state.city.segments[id] as StreetSegment;
    quote.newSegments.push(id);
    quote.lengthFt += segment.lengthFt;
    quote.cost += cableCost(segment, method);
    quote.constructDays = Math.max(quote.constructDays, constructDaysFor(segment, method));
    if (method === 'aerial' && !segment.hasPoles) noPoles.push(id);
  }

  if (invalid.length > 0) {
    reasons.push(`Unknown street segment${invalid.length > 1 ? 's' : ''}: ${listWithMore(invalid, 5)}`);
  } else if (segments.length === 0) {
    reasons.push('No street segments selected');
  } else if (quote.newSegments.length === 0) {
    reasons.push('Every selected street already has cable');
  }
  if (noPoles.length > 0) {
    reasons.push(`No poles on ${listWithMore(streetNames(state, noPoles), 3)} - lay underground instead`);
  }
  if (quote.newSegments.length > 0 && !canAfford(state, quote.cost)) reasons.push(notEnoughCash(state, quote.cost));
  quote.ok = reasons.length === 0;
  return quote;
}

/** Order cable. `rng` is the events stream (used for the permitting draw). */
export function layCable(state: GameState, segments: readonly SegmentId[], method: CableMethod, rng: Rng): CommandResult {
  const quote = quoteCable(state, segments, method);
  if (!quote.ok) return { ok: false, reason: quote.reasons.join('; ') };

  // One right-of-way application covers the whole order.
  const permitDays = drawPermitDays(method, rng);
  for (const id of quote.newSegments) {
    const segment = state.city.segments[id] as StreetSegment;
    state.network.spans.push({
      id: state.nextId++,
      segment: id,
      method,
      stage: 'permitting',
      stageDaysLeft: permitDays,
      constructDays: constructDaysFor(segment, method),
      cost: cableCost(segment, method),
      orderedDay: state.day,
      liveDay: null,
    });
  }
  state.network.version++;

  const label = method === 'aerial' ? 'Aerial' : 'Underground';
  const streets = listWithMore(streetNames(state, quote.newSegments), 3);
  postEntry(state, 'construction', -quote.cost, `${label} cable on ${streets} (${groupThousands(quote.lengthFt)} ft)`);
  return { ok: true, cost: quote.cost };
}

/** Estimate a cabinet without changing state. */
export function quoteCabinet(state: GameState, node: NodeId): CabinetQuote {
  const { city, network } = state;
  const reasons: string[] = [];
  const cost = CABINET_COST + CABINET_START_SPLITTERS * SPLITTER_COST;

  if (!isNodeId(city, node)) {
    reasons.push(`Unknown street corner: ${String(node)}`);
  } else if (network.cabinets.some((c) => c.node === node)) {
    reasons.push(`There is already a cabinet at ${cornerName(city, node)}`);
  }
  // Every splitter feeds from its own OLT PON port.
  const usedPorts = network.cabinets.reduce((sum, c) => sum + c.splitters, 0);
  if (usedPorts + CABINET_START_SPLITTERS > network.olt.ponPorts) {
    reasons.push(`No free PON ports on the OLT: ${usedPorts} of ${network.olt.ponPorts} in use`);
  }
  if (!canAfford(state, cost)) reasons.push(notEnoughCash(state, cost));

  return {
    ok: reasons.length === 0,
    reasons,
    cost,
    permitDays: CABINET_PERMIT_DAYS,
    constructDays: CABINET_CONSTRUCT_DAYS,
  };
}

export function placeCabinet(state: GameState, node: NodeId): CommandResult {
  const quote = quoteCabinet(state, node);
  if (!quote.ok) return { ok: false, reason: quote.reasons.join('; ') };

  state.network.cabinets.push({
    id: state.nextId++,
    node,
    splitters: CABINET_START_SPLITTERS,
    stage: 'permitting',
    stageDaysLeft: quote.permitDays,
    cost: quote.cost,
    orderedDay: state.day,
    liveDay: null,
  });
  state.network.version++;

  const splitters = `${CABINET_START_SPLITTERS} splitter${CABINET_START_SPLITTERS === 1 ? '' : 's'}`;
  postEntry(state, 'equipment', -quote.cost, `Cabinet at ${cornerName(state.city, node)} (${splitters})`);
  return { ok: true, cost: quote.cost };
}

/**
 * Remove a span. Cancelling during permitting refunds it; once crews have
 * started there is no refund. On success `cost` is the net spend (negative for
 * a refund).
 */
export function removeSpan(state: GameState, span: SpanId): CommandResult {
  const spans = state.network.spans;
  const index = spans.findIndex((s) => s.id === span);
  const target = spans[index];
  if (!target) return { ok: false, reason: `Unknown cable span: ${String(span)}` };

  spans.splice(index, 1);
  state.network.version++;

  const segment = state.city.segments[target.segment];
  const where = segment ? `${segment.name} (${groupThousands(segment.lengthFt)} ft)` : `segment ${target.segment}`;
  if (target.stage === 'permitting') {
    const refund = Math.round(target.cost * PERMITTING_CANCEL_REFUND);
    postEntry(state, 'refund', refund, `Refund: cancelled ${target.method} cable on ${where}`);
    return { ok: true, cost: -refund };
  }
  // Still logged so the player can see where the cable went.
  postEntry(state, 'refund', 0, `Removed ${target.method} cable on ${where} - no refund once construction starts`);
  return { ok: true, cost: 0 };
}

type Buildable = Pick<CableSpan, 'stage' | 'stageDaysLeft' | 'liveDay'>;

/** One day of progress; true when the stage changed. */
function advanceOne(asset: Buildable, constructDays: number, day: number): boolean {
  if (asset.stage === 'live') return false;
  asset.stageDaysLeft--;
  if (asset.stageDaysLeft > 0) return false;
  if (asset.stage === 'permitting') {
    asset.stage = 'constructing';
    asset.stageDaysLeft = constructDays;
  } else {
    asset.stage = 'live';
    asset.stageDaysLeft = 0;
    asset.liveDay = day;
  }
  return true;
}

/**
 * Advance every span and cabinet by one day: decrement stageDaysLeft; at 0,
 * permitting -> constructing (stageDaysLeft = constructDays for spans,
 * CABINET_CONSTRUCT_DAYS for cabinets), constructing -> live (liveDay = state.day).
 * Bumps network.version if any stage changed. Called by tick() after state.day
 * has been incremented.
 */
export function advanceNetwork(state: GameState): void {
  let changed = false;
  for (const span of state.network.spans) {
    changed = advanceOne(span, span.constructDays, state.day) || changed;
  }
  for (const cabinet of state.network.cabinets) {
    changed = advanceOne(cabinet, CABINET_CONSTRUCT_DAYS, state.day) || changed;
  }
  if (changed) state.network.version++;
}

/**
 * Recompute service from scratch. A segment is lit when it has a live span, its
 * span is connected to the CO node through live spans, and at least one cabinet
 * in that CO-connected network is active. A cabinet is active when live and its
 * node is the CO node or touches a CO-connected live span.
 */
export function computeService(state: GameState): ServiceSnapshot {
  const { city, network, day } = state;
  const liveSegments = new Set<SegmentId>();
  for (const span of network.spans) if (span.stage === 'live') liveSegments.add(span.segment);

  // Flood fill from the CO along live cable.
  const reached = new Set<NodeId>([city.coNode]);
  const connected = new Set<SegmentId>();
  const queue: NodeId[] = [city.coNode];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i] as NodeId;
    for (const id of segmentsAtNode(city, node)) {
      if (!liveSegments.has(id) || connected.has(id)) continue;
      connected.add(id);
      const next = otherEnd(city.segments[id] as StreetSegment, node);
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }

  const activeCabinets = new Set<CabinetId>();
  for (const cabinet of network.cabinets) {
    if (cabinet.stage === 'live' && reached.has(cabinet.node)) activeCabinets.add(cabinet.id);
  }
  // Cable without a cabinet to split light onto it serves nobody.
  const litSegments = activeCabinets.size > 0 ? connected : new Set<SegmentId>();

  const passedParcels: ParcelId[] = [];
  let passings = 0;
  if (litSegments.size > 0) {
    for (const parcel of city.parcels) {
      if (parcel.appearsDay <= day && litSegments.has(parcel.segment)) {
        passedParcels.push(parcel.id);
        passings += parcel.units;
      }
    }
  }
  return { networkVersion: network.version, day, litSegments, activeCabinets, passedParcels, passings };
}

const serviceCache = new WeakMap<GameState, { network: Network; snapshot: ServiceSnapshot }>();

/** computeService memoized on (state, network.version, day). Safe to call every frame. */
export function getService(state: GameState): ServiceSnapshot {
  const cached = serviceCache.get(state);
  if (
    cached &&
    cached.network === state.network &&
    cached.snapshot.networkVersion === state.network.version &&
    cached.snapshot.day === state.day
  ) {
    return cached.snapshot;
  }
  const snapshot = computeService(state);
  serviceCache.set(state, { network: state.network, snapshot });
  return snapshot;
}

export function spanOnSegment(state: GameState, segment: SegmentId): CableSpan | undefined {
  return state.network.spans.find((s) => s.segment === segment);
}
