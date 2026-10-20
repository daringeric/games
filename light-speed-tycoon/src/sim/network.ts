// Player-built plant: quoting, ordering and removing cable, cabinets, splitters
// and OLT line cards, the daily build pipeline, and which homes the network
// passes. See types.ts for every field's units and invariants.
//
// Rules:
// - layCable: one span per segment; segments that already have a span are
//   skipped and never charged; duplicate ids in the request are ignored.
//   Aerial requires hasPoles on every new segment (else reject, naming the
//   streets). Reject if cash can't cover the whole order.
// - Cost model (spanCharges): per new segment, construction = round(lengthFt x
//   method rate); underground on rock adds round(lengthFt x
//   UNDERGROUND_ROCK_SURCHARGE_PER_FT); aerial adds polesOnSegment x
//   MAKE_READY_COST_PER_POLE. Per order (one layCable): ENGINEERING_FEE +
//   PERMIT_FEE_AERIAL or PERMIT_FEE_UNDERGROUND. quoteCable itemizes these as
//   QuoteLines summing exactly to cost; span.cost = its own charges + its share
//   of the order fees (by length, floor, the remainder on the order's last new
//   span); span.refundable = construction + rock. Ledger: one 'construction'
//   entry per order.
// - Permitting: aerial = make-ready (MAKE_READY_* incl. the long-delay chance),
//   underground = PERMIT_DAYS_*. A new span on (segment, method) with an
//   unexpired MakeReadyMemo (state.day < drawnDay + MAKE_READY_MEMORY_DAYS) gets
//   stageDaysLeft = memo.days; the other new spans share one fresh draw, which
//   is drawn only if at least one new span lacks a memo (so an order made
//   entirely of remembered segments consumes no RNG). Every fresh span writes a
//   memo { days, drawnDay: state.day }; reuse never moves drawnDay. layCable
//   prunes expired memos and keeps network.makeReady sorted. Each span's
//   construct days = max(1, ceil(lengthFt / ft-per-day)).
// - removeSpan: permitting -> refund round(span.refundable x
//   PERMITTING_CANCEL_REFUND) (memo says what was not refundable); later -> 0.
//   Memos stay, so cancel-and-reorder cannot re-roll a long make-ready.
// - placeCabinet: on a street node, at most one per node, starts with
//   CABINET_START_SPLITTERS splitters; total splitters across all cabinets may
//   not exceed olt.ponPorts. Cost = CABINET_COST + splitters x SPLITTER_COST.
// - addSplitter / removeCabinet / addOltCard: see their docs below. A
//   successful placeCabinet or addSplitter that leaves no free PON port posts
//   an 'oltFull' notice. Rejected commands never change anything (RNG, memos,
//   notices, ledger, capex).
// - Capex: every spend/refund here also updates finance.capex (osp for cable,
//   cabinets, splitters; co for OLT cards) by the same amount as its ledger entry.
// - Every successful order/removal posts to the ledger and bumps network.version.
// - Coverage (computeService): a connected segment is lit when it is within
//   CABINET_REACH_FT of an active cabinet along connected cable (cabinet node to
//   the segment's nearer endpoint, strictly less); each lit segment is served by
//   its nearest active cabinet (ties -> lower id). Parcels are passed only via
//   their own Parcel.segment (never via another street they touch).
// - cableRoute caps aerial detours at AERIAL_DETOUR_MAX_RATIO x the shortest route.

import {
  AERIAL_COST_PER_FT,
  AERIAL_DETOUR_MAX_RATIO,
  AERIAL_FT_PER_DAY,
  CABINET_CANCEL_REFUND,
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_PERMIT_DAYS,
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  ENGINEERING_FEE,
  MAKE_READY_COST_PER_POLE,
  MAKE_READY_DAYS_MAX,
  MAKE_READY_DAYS_MIN,
  MAKE_READY_LONG_CHANCE,
  MAKE_READY_LONG_DAYS_MAX,
  MAKE_READY_LONG_DAYS_MIN,
  MAKE_READY_MEMORY_DAYS,
  MAX_SPLITTERS_PER_CABINET,
  OLT_CARD_COST,
  OLT_MAX_CARDS,
  OLT_PORTS_PER_CARD,
  PERMIT_DAYS_MAX,
  PERMIT_DAYS_MIN,
  PERMIT_FEE_AERIAL,
  PERMIT_FEE_UNDERGROUND,
  PERMITTING_CANCEL_REFUND,
  SPLIT_RATIO,
  SPLITTER_COST,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_FT_PER_DAY,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
} from './balance';
import { canAfford, formatMoney, groupThousands, postEntry } from './finance';
import { cppBand } from './metrics';
import { postNotice } from './notices';
import type { Rng } from './rng';
import { accountUnits } from './sales';
import {
  cornerName,
  isNodeId,
  isSegmentId,
  otherEnd,
  parcelsServedBy,
  parcelsTouchingSegment,
  polesOnSegment,
  segmentsAtNode,
  segmentsWithin,
  shortestPath,
} from './streets';
import type {
  Cabinet,
  CabinetCoverage,
  CabinetId,
  CabinetQuote,
  CableMethod,
  CableQuote,
  CableSpan,
  City,
  CommandResult,
  GameState,
  MakeReadyMemo,
  Network,
  NodeId,
  OltCardQuote,
  ParcelId,
  QuoteLine,
  RemoveCabinetQuote,
  RemoveSpanQuote,
  SegmentId,
  ServiceSnapshot,
  SpanId,
  SplitterQuote,
  StreetSegment,
} from './types';

const CABLE: Record<CableMethod, { costPerFt: number; ftPerDay: number; permitFee: number }> = {
  aerial: { costPerFt: AERIAL_COST_PER_FT, ftPerDay: AERIAL_FT_PER_DAY, permitFee: PERMIT_FEE_AERIAL },
  underground: {
    costPerFt: UNDERGROUND_COST_PER_FT,
    ftPerDay: UNDERGROUND_FT_PER_DAY,
    permitFee: PERMIT_FEE_UNDERGROUND,
  },
};

function isCableMethod(method: unknown): method is CableMethod {
  return method === 'aerial' || method === 'underground';
}

/** Per-segment charges of cabling one segment with one method (excludes per-order fees). */
export interface SpanCharges {
  /** round(lengthFt x AERIAL_COST_PER_FT or UNDERGROUND_COST_PER_FT). */
  construction: number;
  /** Underground on rock: round(lengthFt x UNDERGROUND_ROCK_SURCHARGE_PER_FT); else 0. */
  rock: number;
  /** Aerial: polesOnSegment(segment); else 0. */
  poles: number;
  /** poles x MAKE_READY_COST_PER_POLE. */
  makeReady: number;
  /** construction + rock + makeReady. */
  total: number;
  /** construction + rock (what a permitting cancellation can refund). */
  refundable: number;
}

/**
 * Charges for cabling `segment` with `method`, before per-order fees. Defined
 * for aerial on an unpoled segment too (poles 0), though layCable rejects it.
 */
export function spanCharges(segment: StreetSegment, method: CableMethod): SpanCharges {
  const construction = Math.round(segment.lengthFt * CABLE[method].costPerFt);
  const rock =
    method === 'underground' && segment.rock ? Math.round(segment.lengthFt * UNDERGROUND_ROCK_SURCHARGE_PER_FT) : 0;
  const poles = method === 'aerial' ? polesOnSegment(segment) : 0;
  const makeReady = poles * MAKE_READY_COST_PER_POLE;
  return {
    construction,
    rock,
    poles,
    makeReady,
    total: construction + rock + makeReady,
    refundable: construction + rock,
  };
}

/**
 * All-in dollars per foot for cabling a segment with a method, before per-order
 * fees: spanCharges(segment, method).total / lengthFt. Null for aerial on a
 * segment without poles. For the $/ft overlay, street inspect and the rate card.
 */
export function segmentCostPerFt(segment: StreetSegment, method: CableMethod): number | null {
  if (method === 'aerial' && !segment.hasPoles) return null;
  return segment.lengthFt > 0 ? spanCharges(segment, method).total / segment.lengthFt : 0;
}

/** Whole-dollar price of cabling one segment before per-order fees: spanCharges(segment, method).total. */
export function cableCost(segment: StreetSegment, method: CableMethod): number {
  return spanCharges(segment, method).total;
}

/** Engineering plus the right-of-way application: charged once per cable order with new segments. */
export function orderFees(method: CableMethod): number {
  return ENGINEERING_FEE + CABLE[method].permitFee;
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

/** True while a memo still pins its segment's permitting days. */
function memoActive(state: GameState, memo: MakeReadyMemo): boolean {
  return state.day < memo.drawnDay + MAKE_READY_MEMORY_DAYS;
}

/**
 * Remembered permitting days for (segment, method), or null when there is no
 * unexpired MakeReadyMemo for the pair. What a new order for it would get.
 */
export function rememberedPermitDays(state: GameState, segment: SegmentId, method: CableMethod): number | null {
  const memo = state.network.makeReady.find((m) => m.segment === segment && m.method === method);
  return memo && memoActive(state, memo) ? memo.days : null;
}

/** Unexpired memos for one method, by segment. */
function activeMemos(state: GameState, method: CableMethod): Map<SegmentId, number> {
  const out = new Map<SegmentId, number>();
  for (const memo of state.network.makeReady) {
    if (memo.method === method && memoActive(state, memo)) out.set(memo.segment, memo.days);
  }
  return out;
}

/** "a, b, c and 2 more" */
function listWithMore(items: readonly string[], max: number): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** "a", "a and b", "a, b and c" */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] as string}`;
}

function plural(n: number, one: string, many: string): string {
  return `${groupThousands(n)} ${n === 1 ? one : many}`;
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

function routeLength(city: City, route: readonly SegmentId[]): number {
  let ft = 0;
  for (const id of route) ft += (city.segments[id] as StreetSegment).lengthFt;
  return ft;
}

/**
 * The street route a cable run between two corners takes, for quoting and
 * ordering. Aerial runs keep to segments they can go on (poled, or already
 * cabled, which an order skips) whenever such a route exists and is at most
 * AERIAL_DETOUR_MAX_RATIO x the plain shortest route's length, even when a
 * shorter one crosses a street without poles. Otherwise (no such route, or a
 * longer detour) they take the plain shortest route, whose quote then names the
 * street without poles. Underground runs take the shortest route. Null when
 * unreachable.
 */
export function cableRoute(state: GameState, from: NodeId, to: NodeId, method: CableMethod): SegmentId[] | null {
  const { city } = state;
  const shortest = shortestPath(city, from, to);
  if (method !== 'aerial' || !shortest) return shortest;
  const cabled = new Set<SegmentId>(state.network.spans.map((s) => s.segment));
  const poled = shortestPath(city, from, to, (seg) => (seg.hasPoles || cabled.has(seg.id) ? seg.lengthFt : Infinity));
  if (poled && routeLength(city, poled) <= AERIAL_DETOUR_MAX_RATIO * routeLength(city, shortest)) return poled;
  return shortest;
}

// ---------------------------------------------------------------------------
// Reach: which segments light passes homes on (shared by service and quotes)
// ---------------------------------------------------------------------------

interface Reach {
  /** Live-cable segments flood-filled from the CO. */
  connected: Set<SegmentId>;
  /** Nodes that flood fill reached (always includes the CO). */
  reached: Set<NodeId>;
  /** Cabinets standing on a reached node, ascending id. */
  active: CabinetId[];
  /** Lit segment -> nearest active cabinet and its cable distance, ascending by segment id. */
  serving: Map<SegmentId, { cabinet: CabinetId; distanceFt: number }>;
}

/**
 * The coverage rule over an arbitrary set of live segments and live cabinets:
 * CO flood fill along `live`, cabinets on reached nodes are active, and each
 * connected segment within CABINET_REACH_FT (along connected cable, to its
 * nearer endpoint) of an active cabinet is lit by the nearest one (ties ->
 * lower id). computeService runs it on the real network, quoteCable on a
 * hypothetical "everything ordered is live" one.
 */
function computeReach(
  city: City,
  live: ReadonlySet<SegmentId>,
  cabinets: ReadonlyArray<Pick<Cabinet, 'id' | 'node'>>,
): Reach {
  const reached = new Set<NodeId>([city.coNode]);
  const connected = new Set<SegmentId>();
  const queue: NodeId[] = [city.coNode];
  for (let i = 0; i < queue.length; i++) {
    const node = queue[i] as NodeId;
    for (const id of segmentsAtNode(city, node)) {
      if (!live.has(id) || connected.has(id)) continue;
      connected.add(id);
      const next = otherEnd(city.segments[id] as StreetSegment, node);
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }

  const active = cabinets
    .filter((c) => reached.has(c.node))
    .map((c) => ({ id: c.id, node: c.node }))
    .sort((a, b) => a.id - b.id);

  const best = new Map<SegmentId, { cabinet: CabinetId; distanceFt: number }>();
  if (connected.size > 0) {
    const onCable = (seg: StreetSegment) => connected.has(seg.id);
    for (const cabinet of active) {
      for (const { segment, distanceFt } of segmentsWithin(city, cabinet.node, CABINET_REACH_FT, onCable)) {
        const current = best.get(segment);
        // Cabinets come in ascending id order, so a tie keeps the lower id.
        if (!current || distanceFt < current.distanceFt) best.set(segment, { cabinet: cabinet.id, distanceFt });
      }
    }
  }
  const serving = new Map([...best].sort((a, b) => a[0] - b[0]));
  return { connected, reached, active: active.map((c) => c.id), serving };
}

// ---------------------------------------------------------------------------
// Cable orders
// ---------------------------------------------------------------------------

/** Estimate a cable order without changing state. */
export function quoteCable(state: GameState, segments: readonly SegmentId[], method: CableMethod): CableQuote {
  const { city, network, day } = state;
  const reasons: string[] = [];
  const quote: CableQuote = {
    ok: false,
    reasons,
    newSegments: [],
    lengthFt: 0,
    cost: 0,
    lines: [],
    refundable: 0,
    costPerFt: 0,
    permitDaysMin: 0,
    permitDaysMax: 0,
    constructDays: 0,
    rememberedPermitDays: null,
    passingsAlong: 0,
    passingsFuture: 0,
    passingsInReach: 0,
    cpp: null,
    cppBand: null,
    wrongSideParcels: [],
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
  const [freshMin, freshMax] = permitRange(method);
  [quote.permitDaysMin, quote.permitDaysMax] = [freshMin, freshMax];

  // Already-cabled segments and repeats are skipped, never charged.
  const cabled = new Set<SegmentId>(network.spans.map((s) => s.segment));
  const requested = new Set<SegmentId>();
  const invalid: string[] = [];
  const noPoles: SegmentId[] = [];
  let construction = 0;
  let rockFt = 0;
  let rock = 0;
  let poles = 0;
  let makeReady = 0;
  for (const id of segments) {
    if (!isSegmentId(city, id)) {
      invalid.push(String(id));
      continue;
    }
    if (requested.has(id)) continue;
    requested.add(id);
    if (cabled.has(id)) continue;
    const segment = city.segments[id] as StreetSegment;
    const charges = spanCharges(segment, method);
    quote.newSegments.push(id);
    quote.lengthFt += segment.lengthFt;
    construction += charges.construction;
    if (charges.rock > 0) {
      rockFt += segment.lengthFt;
      rock += charges.rock;
    }
    poles += charges.poles;
    makeReady += charges.makeReady;
    quote.constructDays = Math.max(quote.constructDays, constructDaysFor(segment, method));
    if (method === 'aerial' && !segment.hasPoles) noPoles.push(id);
  }

  if (quote.newSegments.length > 0) {
    const lines: QuoteLine[] = [
      {
        kind: 'cable',
        label: method === 'aerial' ? 'Aerial strand' : 'Underground bore',
        quantity: quote.lengthFt,
        unit: 'ft',
        rate: CABLE[method].costPerFt,
        amount: construction,
        refundable: true,
      },
      {
        kind: 'rock',
        label: 'Rock surcharge',
        quantity: rockFt,
        unit: 'ft',
        rate: UNDERGROUND_ROCK_SURCHARGE_PER_FT,
        amount: rock,
        refundable: true,
      },
      {
        kind: 'makeReady',
        label: `Make-ready (${plural(poles, 'pole', 'poles')})`,
        quantity: poles,
        unit: 'pole',
        rate: MAKE_READY_COST_PER_POLE,
        amount: makeReady,
        refundable: false,
      },
      {
        kind: 'engineering',
        label: 'Engineering',
        quantity: 1,
        unit: 'order',
        rate: ENGINEERING_FEE,
        amount: ENGINEERING_FEE,
        refundable: false,
      },
      {
        kind: 'permit',
        label: method === 'aerial' ? 'Pole attachment application' : 'City permit',
        quantity: 1,
        unit: 'order',
        rate: CABLE[method].permitFee,
        amount: CABLE[method].permitFee,
        refundable: false,
      },
    ];
    quote.lines = lines.filter((line) => line.quantity > 0);
    for (const line of quote.lines) {
      quote.cost += line.amount;
      if (line.refundable) quote.refundable += line.amount;
    }
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
  quote.costPerFt = quote.lengthFt > 0 ? quote.cost / quote.lengthFt : 0;

  // Permitting: remembered draws pin their spans; the rest share one fresh draw.
  const memos = activeMemos(state, method);
  let remembered = 0;
  let memoMax = 0;
  for (const id of quote.newSegments) {
    const days = memos.get(id);
    if (days === undefined) continue;
    remembered++;
    memoMax = Math.max(memoMax, days);
  }
  if (remembered > 0) {
    quote.rememberedPermitDays = memoMax;
    if (remembered === quote.newSegments.length) {
      quote.permitDaysMin = memoMax;
      quote.permitDaysMax = memoMax;
    } else {
      quote.permitDaysMin = Math.max(memoMax, freshMin);
      quote.permitDaysMax = Math.max(memoMax, freshMax);
    }
  }

  // Homes along the new cable (by each parcel's own serving segment).
  const isNew = new Set<SegmentId>(quote.newSegments);
  const alongToday: ParcelId[] = [];
  for (const id of quote.newSegments) {
    for (const pid of parcelsServedBy(city, id)) {
      const parcel = city.parcels[pid];
      if (!parcel) continue;
      if (parcel.appearsDay <= day) {
        alongToday.push(pid);
        quote.passingsAlong += parcel.units;
      } else {
        quote.passingsFuture += parcel.units;
      }
    }
  }
  if (quote.passingsAlong > 0) {
    // Once everything ordered (any stage) and this order are live.
    const live = new Set<SegmentId>(cabled);
    for (const id of quote.newSegments) live.add(id);
    const { serving } = computeReach(city, live, network.cabinets);
    for (const pid of alongToday) {
      const parcel = city.parcels[pid];
      if (parcel && serving.has(parcel.segment)) quote.passingsInReach += parcel.units;
    }
    quote.cpp = quote.cost / quote.passingsAlong;
    quote.cppBand = cppBand(quote.cpp);
  }

  // Buildings the new cable runs past that are served from a street left uncabled.
  const wrongSide = new Set<ParcelId>();
  for (const id of quote.newSegments) {
    for (const pid of parcelsTouchingSegment(city, id)) {
      const parcel = city.parcels[pid];
      if (!parcel || parcel.appearsDay > day || isNew.has(parcel.segment)) continue;
      if (!requested.has(parcel.segment) && !cabled.has(parcel.segment)) wrongSide.add(pid);
    }
  }
  quote.wrongSideParcels = [...wrongSide].sort((a, b) => a - b);

  quote.ok = reasons.length === 0;
  return quote;
}

/** Order cable. `rng` is the events stream (used for the permitting draw). */
export function layCable(
  state: GameState,
  segments: readonly SegmentId[],
  method: CableMethod,
  rng: Rng,
): CommandResult {
  const quote = quoteCable(state, segments, method);
  if (!quote.ok) return { ok: false, reason: quote.reasons.join('; ') };
  const { city, network } = state;

  // Remembered segments keep their draw; the rest share one fresh draw, made
  // only when needed so an all-remembered order consumes no RNG.
  const memos = activeMemos(state, method);
  const freshDays = quote.newSegments.some((id) => !memos.has(id)) ? drawPermitDays(method, rng) : 0;
  const freshSegments: SegmentId[] = [];

  // Order fees are spread over the spans by length; the last span takes the remainder.
  const fees = orderFees(method);
  let feesLeft = fees;
  quote.newSegments.forEach((id, i) => {
    const segment = city.segments[id] as StreetSegment;
    const charges = spanCharges(segment, method);
    const last = i === quote.newSegments.length - 1;
    const share = last ? feesLeft : quote.lengthFt > 0 ? Math.floor((fees * segment.lengthFt) / quote.lengthFt) : 0;
    feesLeft -= share;
    const memoDays = memos.get(id);
    if (memoDays === undefined) freshSegments.push(id);
    network.spans.push({
      id: state.nextId++,
      segment: id,
      method,
      stage: 'permitting',
      stageDaysLeft: memoDays ?? freshDays,
      constructDays: constructDaysFor(segment, method),
      cost: charges.total + share,
      refundable: charges.refundable,
      orderedDay: state.day,
      liveDay: null,
    });
  });

  // Prune expired memos, record the fresh draws, keep one per pair, sorted.
  const keyOf = (segment: SegmentId, m: CableMethod) => segment * 2 + (m === 'aerial' ? 0 : 1);
  const kept = new Map<number, MakeReadyMemo>();
  for (const memo of network.makeReady) {
    if (memoActive(state, memo)) kept.set(keyOf(memo.segment, memo.method), memo);
  }
  for (const segment of freshSegments) {
    kept.set(keyOf(segment, method), { segment, method, days: freshDays, drawnDay: state.day });
  }
  network.makeReady = [...kept].sort((a, b) => a[0] - b[0]).map(([, memo]) => memo);
  network.version++;

  const label = method === 'aerial' ? 'Aerial' : 'Underground';
  const streets = listWithMore(streetNames(state, quote.newSegments), 3);
  state.finance.capex.osp += quote.cost;
  postEntry(state, 'construction', -quote.cost, `${label} cable on ${streets} (${groupThousands(quote.lengthFt)} ft)`);
  return { ok: true, cost: quote.cost };
}

interface RemovalReachCache {
  network: Network;
  version: number;
  span: SpanId;
  reach: Reach;
}

// The last "network without this span" per state: hovering one span is free.
const removalReachCache = new WeakMap<GameState, RemovalReachCache>();

/** The coverage rule on the live network minus one span (memoized per state, network version and span). */
function reachWithoutSpan(state: GameState, span: SpanId): Reach {
  const { network } = state;
  const cached = removalReachCache.get(state);
  if (cached && cached.network === network && cached.version === network.version && cached.span === span) return cached.reach;
  const live = new Set<SegmentId>();
  for (const s of network.spans) if (s.stage === 'live' && s.id !== span) live.add(s.segment);
  const reach = computeReach(state.city, live, network.cabinets.filter((c) => c.stage === 'live'));
  removalReachCache.set(state, { network, version: network.version, span, reach });
  return reach;
}

/**
 * Estimate removing a span without changing state: the refund (while
 * permitting) and, for a live span, who loses service. Removing live cable
 * can cut off more than its own street: everything beyond it that no longer
 * connects to the CO, or that falls out of its cabinet's reach, goes dark. A
 * subscriber is affected when their street would no longer be lit or their
 * cabinet would no longer be active (sales.stepSales drops them next day).
 * Only blocker: unknown span ("Unknown cable span: 7").
 */
export function quoteRemoveSpan(state: GameState, span: SpanId): RemoveSpanQuote {
  const target = state.network.spans.find((s) => s.id === span);
  if (!target) {
    return { ok: false, reasons: [`Unknown cable span: ${String(span)}`], refund: 0, subscribersAffected: 0, passingsLost: 0 };
  }
  const quote: RemoveSpanQuote = {
    ok: true,
    reasons: [],
    refund: target.stage === 'permitting' ? Math.round(target.refundable * PERMITTING_CANCEL_REFUND) : 0,
    subscribersAffected: 0,
    passingsLost: 0,
  };
  if (target.stage !== 'live') return quote;

  const { city, day } = state;
  const after = reachWithoutSpan(state, span);
  const active = new Set(after.active);
  for (const account of state.sales.accounts) {
    const parcel = city.parcels[account.parcel];
    if (!parcel || !after.serving.has(parcel.segment) || !active.has(account.cabinet)) {
      quote.subscribersAffected += accountUnits(account);
    }
  }
  const service = getService(state);
  let passingsAfter = 0;
  for (const pid of service.passedParcels) {
    const parcel = city.parcels[pid];
    if (parcel && parcel.appearsDay <= day && after.serving.has(parcel.segment)) passingsAfter += parcel.units;
  }
  quote.passingsLost = service.passings - passingsAfter;
  return quote;
}

/**
 * Remove a span. Cancelling during permitting refunds its refundable part
 * (construction and rock) x PERMITTING_CANCEL_REFUND; fees and make-ready are
 * kept. Once crews have started there is no refund. Remembered make-ready
 * draws stay. On success `cost` is the net spend (negative for a refund).
 * quoteRemoveSpan previews it.
 */
export function removeSpan(state: GameState, span: SpanId): CommandResult {
  const spans = state.network.spans;
  const index = spans.findIndex((s) => s.id === span);
  const target = spans[index];
  if (!target) return { ok: false, reason: `Unknown cable span: ${String(span)}` };
  const refund = target.stage === 'permitting' ? Math.round(target.refundable * PERMITTING_CANCEL_REFUND) : 0;

  spans.splice(index, 1);
  state.network.version++;

  const segment = state.city.segments[target.segment];
  const where = segment ? `${segment.name} (${groupThousands(segment.lengthFt)} ft)` : `segment ${target.segment}`;
  if (target.stage === 'permitting') {
    let memo = `Refund: cancelled ${target.method} cable on ${where}`;
    if (target.cost > refund) {
      const kept: string[] = [];
      if (target.cost > target.refundable) kept.push('fees');
      if (target.cost > target.refundable && target.method === 'aerial') kept.push('make-ready');
      if (target.refundable > refund) kept.push('cancellation charge');
      memo += `; ${formatMoney(target.cost - refund)} of ${joinAnd(kept)} not refundable`;
    }
    state.finance.capex.osp -= refund;
    postEntry(state, 'refund', refund, memo);
    return { ok: true, cost: -refund };
  }
  // Still logged so the player can see where the cable went.
  postEntry(state, 'refund', 0, `Removed ${target.method} cable on ${where} - no refund once construction starts`);
  return { ok: true, cost: 0 };
}

// ---------------------------------------------------------------------------
// Cabinets, splitters and the OLT
// ---------------------------------------------------------------------------

/** OLT PON ports in use: total splitters across all cabinets (any stage). */
export function ponPortsUsed(state: GameState): number {
  return state.network.cabinets.reduce((sum, c) => sum + c.splitters, 0);
}

function noFreePonPorts(state: GameState): string {
  const { olt } = state.network;
  const fix = olt.cards >= OLT_MAX_CARDS ? 'the OLT chassis is full' : 'add a line card at the CO';
  return `No free PON ports on the OLT: ${ponPortsUsed(state)} of ${olt.ponPorts} in use - ${fix}`;
}

/** After a successful placeCabinet/addSplitter: tell the player when the OLT has no PON port left. */
function noticeIfOltFull(state: GameState): void {
  const { olt } = state.network;
  if (ponPortsUsed(state) < olt.ponPorts) return;
  const next =
    olt.cards >= OLT_MAX_CARDS
      ? 'the OLT chassis is full, so no more cabinets or splitters fit'
      : 'add an OLT line card before the next cabinet or splitter';
  postNotice(state, 'oltFull', `All ${groupThousands(olt.ponPorts)} PON ports at the CO are in use: ${next}`);
}

function findCabinet(state: GameState, id: CabinetId): Cabinet | undefined {
  return state.network.cabinets.find((c) => c.id === id);
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
  const usedPorts = ponPortsUsed(state);
  if (usedPorts + CABINET_START_SPLITTERS > network.olt.ponPorts) reasons.push(noFreePonPorts(state));
  if (!canAfford(state, cost)) reasons.push(notEnoughCash(state, cost));

  return {
    ok: reasons.length === 0,
    reasons,
    cost,
    permitDays: CABINET_PERMIT_DAYS,
    constructDays: CABINET_CONSTRUCT_DAYS,
    splitters: CABINET_START_SPLITTERS,
    ports: CABINET_START_SPLITTERS * SPLIT_RATIO,
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

  const splitters = plural(CABINET_START_SPLITTERS, 'splitter', 'splitters');
  state.finance.capex.osp += quote.cost;
  postEntry(state, 'equipment', -quote.cost, `Cabinet at ${cornerName(state.city, node)} (${splitters})`);
  noticeIfOltFull(state);
  return { ok: true, cost: quote.cost };
}

/**
 * Estimate adding one splitter to a cabinet. Blockers, in order: unknown
 * cabinet ("Unknown cabinet: 7"); already MAX_SPLITTERS_PER_CABINET ("Cabinet at
 * <corner> already has 8 splitters, the most it holds"); no free OLT PON port
 * ("No free PON ports on the OLT: 16 of 16 in use - add a line card at the
 * CO", or "- the OLT chassis is full" when no card slot is left); cash <
 * SPLITTER_COST (the shared "Not enough cash" message). Any stage.
 */
export function quoteSplitter(state: GameState, cabinet: CabinetId): SplitterQuote {
  const { network } = state;
  const reasons: string[] = [];
  const used = ponPortsUsed(state);
  const target = findCabinet(state, cabinet);
  if (!target) {
    reasons.push(`Unknown cabinet: ${String(cabinet)}`);
    return {
      ok: false,
      reasons,
      cost: SPLITTER_COST,
      splittersAfter: 0,
      portsAfter: 0,
      ponPortsUsedAfter: used,
      ponPorts: network.olt.ponPorts,
    };
  }
  if (target.splitters >= MAX_SPLITTERS_PER_CABINET) {
    const has = plural(target.splitters, 'splitter', 'splitters');
    reasons.push(`Cabinet at ${cornerName(state.city, target.node)} already has ${has}, the most it holds`);
  }
  if (used + 1 > network.olt.ponPorts) reasons.push(noFreePonPorts(state));
  if (!canAfford(state, SPLITTER_COST)) reasons.push(notEnoughCash(state, SPLITTER_COST));
  const splittersAfter = target.splitters + 1;
  return {
    ok: reasons.length === 0,
    reasons,
    cost: SPLITTER_COST,
    splittersAfter,
    portsAfter: splittersAfter * SPLIT_RATIO,
    ponPortsUsedAfter: used + 1,
    ponPorts: network.olt.ponPorts,
  };
}

/**
 * addSplitter command: if quoteSplitter is ok, splitters += 1, cabinet.cost +=
 * SPLITTER_COST, capex.osp += SPLITTER_COST, post 'equipment' -SPLITTER_COST
 * ("Splitter added at <corner> (2 x 1:32)"), network.version++, and an
 * 'oltFull' notice if that used the last free PON port. Otherwise reject with
 * the reasons joined by "; " and change nothing.
 */
export function addSplitter(state: GameState, cabinet: CabinetId): CommandResult {
  const quote = quoteSplitter(state, cabinet);
  const target = findCabinet(state, cabinet);
  if (!quote.ok || !target) return { ok: false, reason: quote.reasons.join('; ') };

  target.splitters += 1;
  target.cost += SPLITTER_COST;
  state.network.version++;
  state.finance.capex.osp += SPLITTER_COST;
  postEntry(
    state,
    'equipment',
    -SPLITTER_COST,
    `Splitter added at ${cornerName(state.city, target.node)} (${target.splitters} x 1:${SPLIT_RATIO})`,
  );
  noticeIfOltFull(state);
  return { ok: true, cost: SPLITTER_COST };
}

/**
 * Estimate removing a cabinet: refund = round(cost x CABINET_CANCEL_REFUND)
 * while permitting, else 0; ponPortsFreed = its splitters;
 * subscribersAffected = units on accounts whose cabinet is this one. Only
 * blocker: unknown cabinet ("Unknown cabinet: 7").
 */
export function quoteRemoveCabinet(state: GameState, cabinet: CabinetId): RemoveCabinetQuote {
  const target = findCabinet(state, cabinet);
  if (!target) {
    const reasons = [`Unknown cabinet: ${String(cabinet)}`];
    return { ok: false, reasons, refund: 0, ponPortsFreed: 0, subscribersAffected: 0 };
  }
  let subscribersAffected = 0;
  for (const account of state.sales.accounts) {
    if (account.cabinet === target.id) subscribersAffected += accountUnits(account);
  }
  return {
    ok: true,
    reasons: [],
    refund: target.stage === 'permitting' ? Math.round(target.cost * CABINET_CANCEL_REFUND) : 0,
    ponPortsFreed: target.splitters,
    subscribersAffected,
  };
}

/**
 * removeCabinet command: splice the cabinet out (freeing its PON ports),
 * network.version++. Permitting: post 'refund' +refund ("Refund: cancelled
 * cabinet at <corner>"), capex.osp -= refund, result cost = -refund. Later
 * stages: post 'refund' 0 ("Removed cabinet at <corner> - no refund once
 * construction starts"), cost 0. Its subscribers lose service at the next
 * daily sales step (sales.stepSales), not here. Unknown id -> reject.
 */
export function removeCabinet(state: GameState, cabinet: CabinetId): CommandResult {
  const quote = quoteRemoveCabinet(state, cabinet);
  const cabinets = state.network.cabinets;
  const index = cabinets.findIndex((c) => c.id === cabinet);
  const target = cabinets[index];
  if (!quote.ok || !target) return { ok: false, reason: quote.reasons.join('; ') };

  cabinets.splice(index, 1);
  state.network.version++;
  const where = cornerName(state.city, target.node);
  if (target.stage === 'permitting') {
    state.finance.capex.osp -= quote.refund;
    postEntry(state, 'refund', quote.refund, `Refund: cancelled cabinet at ${where}`);
    return { ok: true, cost: -quote.refund };
  }
  postEntry(state, 'refund', 0, `Removed cabinet at ${where} - no refund once construction starts`);
  return { ok: true, cost: 0 };
}

/**
 * Estimate one more OLT line card. Blockers: olt.cards >= OLT_MAX_CARDS ("The
 * OLT chassis is full: 8 of 8 line cards"); cash < OLT_CARD_COST.
 */
export function quoteOltCard(state: GameState): OltCardQuote {
  const { olt } = state.network;
  const reasons: string[] = [];
  if (olt.cards >= OLT_MAX_CARDS) reasons.push(`The OLT chassis is full: ${olt.cards} of ${OLT_MAX_CARDS} line cards`);
  if (!canAfford(state, OLT_CARD_COST)) reasons.push(notEnoughCash(state, OLT_CARD_COST));
  return {
    ok: reasons.length === 0,
    reasons,
    cost: OLT_CARD_COST,
    cardsAfter: olt.cards + 1,
    ponPortsAfter: olt.ponPorts + OLT_PORTS_PER_CARD,
  };
}

/**
 * addOltCard command: cards += 1, ponPorts += OLT_PORTS_PER_CARD, capex.co +=
 * OLT_CARD_COST, post 'equipment' -OLT_CARD_COST ("OLT line card 2 of 8 at the
 * CO (+16 PON ports)"), network.version++. Installed instantly.
 */
export function addOltCard(state: GameState): CommandResult {
  const quote = quoteOltCard(state);
  if (!quote.ok) return { ok: false, reason: quote.reasons.join('; ') };
  const { olt } = state.network;
  olt.cards += 1;
  olt.ponPorts += OLT_PORTS_PER_CARD;
  state.network.version++;
  state.finance.capex.co += OLT_CARD_COST;
  postEntry(
    state,
    'equipment',
    -OLT_CARD_COST,
    `OLT line card ${olt.cards} of ${OLT_MAX_CARDS} at the CO (+${OLT_PORTS_PER_CARD} PON ports)`,
  );
  return { ok: true, cost: OLT_CARD_COST };
}

// ---------------------------------------------------------------------------
// Build pipeline
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Service: who the network passes
// ---------------------------------------------------------------------------

/**
 * Recompute service from scratch (see ServiceSnapshot). Connected segments are
 * live spans flood-filled from the CO through live spans. A cabinet is active
 * when live and its node is the CO node or touches a CO-connected live span.
 * A connected segment is lit when its nearer endpoint is strictly less than
 * CABINET_REACH_FT from an active cabinet along connected cable (a segment
 * touching the cabinet's node is at distance 0 however long it is); it is
 * served by the nearest such cabinet (ties -> lower id). A parcel is passed when
 * it exists and its own Parcel.segment is lit.
 */
export function computeService(state: GameState): ServiceSnapshot {
  return snapshotFrom(state, liveReach(state));
}

/** The coverage rule on the network as it stands: live spans and live cabinets. */
function liveReach(state: GameState): Reach {
  const { city, network } = state;
  const liveSegments = new Set<SegmentId>();
  for (const span of network.spans) if (span.stage === 'live') liveSegments.add(span.segment);
  return computeReach(city, liveSegments, network.cabinets.filter((c) => c.stage === 'live'));
}

/** Snapshot for today from a network's reach (the only day-dependent part is which parcels exist). */
function snapshotFrom(state: GameState, reach: Reach): ServiceSnapshot {
  const { city, network, day } = state;
  const litSegments = new Set<SegmentId>();
  const servingCabinet = new Map<SegmentId, CabinetId>();
  const servingDistanceFt = new Map<SegmentId, number>();
  const cabinetCoverage = new Map<CabinetId, CabinetCoverage>();
  for (const id of reach.active) cabinetCoverage.set(id, { segments: [], parcels: 0, passings: 0 });
  // reach.serving is ascending by segment, so every list below comes out ascending.
  for (const [segment, { cabinet, distanceFt }] of reach.serving) {
    litSegments.add(segment);
    servingCabinet.set(segment, cabinet);
    servingDistanceFt.set(segment, distanceFt);
    cabinetCoverage.get(cabinet)?.segments.push(segment);
  }

  const passedParcels: ParcelId[] = [];
  let passings = 0;
  if (litSegments.size > 0) {
    for (const parcel of city.parcels) {
      if (parcel.appearsDay > day) continue;
      const cabinet = servingCabinet.get(parcel.segment);
      if (cabinet === undefined) continue;
      passedParcels.push(parcel.id);
      passings += parcel.units;
      const coverage = cabinetCoverage.get(cabinet);
      if (coverage) {
        coverage.parcels++;
        coverage.passings += parcel.units;
      }
    }
  }

  return {
    networkVersion: network.version,
    day,
    connectedSegments: new Set(reach.connected),
    litSegments,
    activeCabinets: new Set(reach.active),
    servingCabinet,
    servingDistanceFt,
    cabinetCoverage,
    passedParcels,
    passings,
  };
}

const serviceCache = new WeakMap<GameState, { network: Network; reach: Reach; snapshot: ServiceSnapshot }>();

/**
 * computeService memoized on (state, network.version, day). Safe to call every
 * frame. A new day on an unchanged network reuses the network's reach and only
 * recounts which parcels exist.
 */
export function getService(state: GameState): ServiceSnapshot {
  const cached = serviceCache.get(state);
  const sameNetwork =
    cached !== undefined &&
    cached.network === state.network &&
    cached.snapshot.networkVersion === state.network.version;
  if (cached && sameNetwork && cached.snapshot.day === state.day) return cached.snapshot;
  const reach = cached && sameNetwork ? cached.reach : liveReach(state);
  const snapshot = snapshotFrom(state, reach);
  serviceCache.set(state, { network: state.network, reach, snapshot });
  return snapshot;
}

export function spanOnSegment(state: GameState, segment: SegmentId): CableSpan | undefined {
  return state.network.spans.find((s) => s.segment === segment);
}
