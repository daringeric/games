// Cabinet reach: which segments a cabinet can serve, measured along streets
// (for the placement preview) or along live cable (for actual service, see
// network.computeService).
//
// Owner: sim-network workstream.

import { CABINET_COST, CABINET_REACH_FT, CABINET_START_SPLITTERS, SPLIT_RATIO, SPLITTER_COST } from './balance';
import { cppBand } from './metrics';
import { getService, orderFees, plannedService, quoteCable, segmentsLitByCabinetAt, spanCharges } from './network';
import { isNodeId, parcelsServedBy, segmentsWithin, shortestPath } from './streets';
import type { SegmentReach } from './streets';
import type {
  BuildOutPlan,
  CableMethod,
  City,
  Command,
  CoveragePreview,
  CoverageSegment,
  GameState,
  Network,
  NodeId,
  SegmentId,
  StreetSegment,
} from './types';
import { preferredMethod } from './weather';

export type { SegmentReach } from './streets';

/**
 * Segments whose nearer endpoint is strictly less than `reachFt` from `from`,
 * travelling only along segments `allowed` accepts (default: every street).
 * Distance = shortest path length (sum of lengthFt) to the nearer endpoint;
 * a segment touching `from` has distance 0. Ascending by segment id.
 * Deterministic, arithmetic only. An invalid node returns [].
 */
export function segmentsWithinReach(
  city: City,
  from: NodeId,
  reachFt: number,
  allowed?: (segment: StreetSegment) => boolean,
): SegmentReach[] {
  return segmentsWithin(city, from, reachFt, allowed);
}

function emptyPreview(node: NodeId): CoveragePreview {
  return {
    node,
    reachFt: CABINET_REACH_FT,
    segments: [],
    passingsNow: 0,
    passingsFuture: 0,
    passingsServedElsewhere: 0,
    passingsPassableToday: 0,
    cabinetCost: 0,
    buildOutCost: 0,
    projectedCpp: null,
    projectedCppBand: null,
    ports: 0,
  };
}

/** Cheapest buildable cable on a segment before per-order fees: aerial where poled (unless boring is cheaper), else underground. Round 4b: exported for advisor.expandCandidates' estimate. */
export function cheapestBuild(segment: StreetSegment): { method: CableMethod; total: number } {
  const underground = spanCharges(segment, 'underground').total;
  if (!segment.hasPoles) return { method: 'underground', total: underground };
  const aerial = spanCharges(segment, 'aerial').total;
  return aerial <= underground ? { method: 'aerial', total: aerial } : { method: 'underground', total: underground };
}

interface PreviewCacheEntry {
  network: Network;
  version: number;
  day: number;
  node: NodeId;
  preview: CoveragePreview;
}

// The last preview per state: hovering the same corner every frame is free.
const previewCache = new WeakMap<GameState, PreviewCacheEntry>();

/**
 * What a cabinet at `node` could cover, measured along streets with
 * CABINET_REACH_FT (cable not required). See CoveragePreview for every field.
 * Uses getService(state) for `connected` (live cable today),
 * network.segmentsLitByCabinetAt for `litOnPlacement` (the real coverage rule,
 * along today's live cable, against today's active cabinets) and
 * plannedService(state) for `servedBy`: the cabinet that will serve the
 * segment once everything already ordered is built, so a cabinet still
 * permitting or under construction counts too (a cabinet already at `node`
 * never counts as "elsewhere"). The cabinet's list price for
 * cabinetCost (CABINET_COST + CABINET_START_SPLITTERS x SPLITTER_COST, or 0
 * when a cabinet already stands at `node`; cash and PON ports are not checked
 * here), and per-segment cheapest cable charges (network.spanCharges) plus the
 * per-order fees (network.orderFees) of one order per method used for
 * buildOutCost. Parcels count by Parcel.segment only. An invalid node returns
 * an empty preview (no segments, zero counts and costs, null CPP). Memoized per
 * (state, network.version, day, node). Treat the result as read-only.
 */
export function coveragePreview(state: GameState, node: NodeId): CoveragePreview {
  const { city, network, day } = state;
  if (!isNodeId(city, node)) return emptyPreview(node);
  const cached = previewCache.get(state);
  if (
    cached &&
    cached.network === network &&
    cached.version === network.version &&
    cached.day === day &&
    cached.node === node
  ) {
    return cached.preview;
  }

  const service = getService(state);
  const planned = plannedService(state);
  const here = network.cabinets.find((c) => c.node === node);
  const cabled = new Set(network.spans.map((s) => s.segment));
  const litHere = segmentsLitByCabinetAt(state, node);
  const methods = new Set<CableMethod>();
  const preview = emptyPreview(node);
  preview.cabinetCost = here ? 0 : CABINET_COST + CABINET_START_SPLITTERS * SPLITTER_COST;
  preview.ports = CABINET_START_SPLITTERS * SPLIT_RATIO;

  for (const { segment, distanceFt } of segmentsWithin(city, node, CABINET_REACH_FT)) {
    const connected = service.connectedSegments.has(segment);
    const litOnPlacement = litHere.has(segment);
    const server = planned.servingCabinet.get(segment);
    const servedBy = server === undefined || server === here?.id ? null : server;
    const entry: CoverageSegment = { segment, distanceFt, connected, litOnPlacement, servedBy };
    preview.segments.push(entry);

    for (const pid of parcelsServedBy(city, segment)) {
      const parcel = city.parcels[pid];
      if (!parcel) continue;
      if (parcel.appearsDay > day) {
        preview.passingsFuture += parcel.units;
        continue;
      }
      preview.passingsNow += parcel.units;
      if (servedBy !== null) preview.passingsServedElsewhere += parcel.units;
      else if (litOnPlacement) preview.passingsPassableToday += parcel.units;
    }
    if (!cabled.has(segment)) {
      const build = cheapestBuild(city.segments[segment] as StreetSegment);
      preview.buildOutCost += build.total;
      methods.add(build.method);
    }
  }
  // Engineering and the right-of-way application, as a cable quote charges them.
  for (const method of methods) preview.buildOutCost += orderFees(method);

  const newlyCovered = preview.passingsNow - preview.passingsServedElsewhere;
  if (newlyCovered > 0) {
    preview.projectedCpp = (preview.cabinetCost + preview.buildOutCost) / newlyCovered;
    preview.projectedCppBand = cppBand(preview.projectedCpp);
  }

  previewCache.set(state, { network, version: network.version, day, node, preview });
  return preview;
}

/**
 * Round 4b: everything a new cabinet at `node` needs to light what it
 * reaches, as commands (see BuildOutPlan): the feeder, the uncabled
 * segments of the cheapest route from the CO to `node` where already-cabled
 * streets (any stage) cost next to nothing (so it joins the nearest planned
 * plant); the reach, every uncabled segment within CABINET_REACH_FT along
 * streets (as coveragePreview's build-out); each segment built by
 * weather.preferredMethod; commands placeCabinet (unless one stands there),
 * then one layCable per method used (aerial first). cost = the cabinet's
 * price (as coveragePreview) + each order's quoteCable cost (fees included);
 * passings = coveragePreview's passingsNow - passingsServedElsewhere; cpp =
 * cost / passings (null for none). An invalid node gives an empty plan.
 * Cash and PON ports are not checked (the advisor checks them). Pure.
 * Implemented by the contract (the advisor's expand suggestion and the
 * tuning stage's advice-following bot send these commands).
 */
export function buildOutPlan(state: GameState, node: NodeId): BuildOutPlan {
  const { city, network } = state;
  const plan: BuildOutPlan = { node, feeder: [], reach: [], aerial: [], underground: [], commands: [], cost: 0, passings: 0, cpp: null };
  if (!isNodeId(city, node)) return plan;
  const preview = coveragePreview(state, node);
  const cabled = new Set<SegmentId>(network.spans.map((s) => s.segment));
  // Cabled streets are nearly free to travel, so the route joins the nearest planned plant.
  const route = shortestPath(city, city.coNode, node, (seg) => (cabled.has(seg.id) ? seg.lengthFt / 1_000_000 : seg.lengthFt)) ?? [];
  plan.feeder = route.filter((id) => !cabled.has(id));
  const inFeeder = new Set(plan.feeder);
  plan.reach = preview.segments.map((s) => s.segment).filter((id) => !cabled.has(id) && !inFeeder.has(id));
  for (const id of [...plan.feeder, ...plan.reach]) {
    const segment = city.segments[id] as StreetSegment;
    (preferredMethod(state, segment) === 'aerial' ? plan.aerial : plan.underground).push(id);
  }
  plan.aerial.sort((a, b) => a - b);
  plan.underground.sort((a, b) => a - b);
  const commands: Command[] = [];
  if (preview.cabinetCost > 0) commands.push({ type: 'placeCabinet', node });
  plan.cost = preview.cabinetCost;
  for (const method of ['aerial', 'underground'] as const) {
    const segments = method === 'aerial' ? plan.aerial : plan.underground;
    if (segments.length === 0) continue;
    commands.push({ type: 'layCable', segments: [...segments], method });
    plan.cost += quoteCable(state, segments, method).cost;
  }
  plan.commands = commands;
  plan.passings = preview.passingsNow - preview.passingsServedElsewhere;
  plan.cpp = plan.passings > 0 ? plan.cost / plan.passings : null;
  return plan;
}

/** A smaller build-out (smallerBuildPlan): a BuildOutPlan with the streets it lights. */
export interface SmallerBuildPlan extends BuildOutPlan {
  /** The streets the cabinet would newly light: within CABINET_REACH_FT of it along the cable the plan leaves (today's, its feeder and its streets), served by no other planned cabinet, ascending. */
  lit: SegmentId[];
}

/**
 * Round 4c/4d (spec B, advice at every budget): a build at `node` costing at
 * most `maxCost`, or null when not even the cabinet and its feeder fit (or
 * the node is invalid). The whole buildOutPlan when it fits (its `lit`: the
 * preview's streets no other planned cabinet serves). Otherwise the cabinet,
 * the full feeder and, of buildOutPlan's reach, the streets most units per
 * dollar first, each joining the cable laid so far (it touches the node,
 * the feeder, cabled streets or a street already picked) and fitting what
 * is left of `maxCost` (its charges, network.spanCharges with
 * weather.preferredMethod as buildOutPlan builds it, and the order's fees
 * when it is the first street of its method); streets with no units newly
 * passed are skipped. Then exactly as buildOutPlan prices and counts: cost =
 * the cabinet's price + each order's quoteCable cost, passings = the units
 * on existing parcels of the streets within CABINET_REACH_FT of the node
 * along that cable (streets.segmentsWithin over today's cabled streets,
 * the feeder and the picks) that no other planned cabinet serves, cpp =
 * cost / passings. Commands placeCabinet (unless one stands there) then one
 * layCable per method (aerial first). `whole`, when given, is
 * buildOutPlan(state, node) already priced. Pure; cash and PON ports are not
 * checked.
 */
export function smallerBuildPlan(state: GameState, node: NodeId, maxCost: number, whole?: BuildOutPlan): SmallerBuildPlan | null {
  const { city, network } = state;
  if (!isNodeId(city, node)) return null;
  const full = whole && whole.node === node ? whole : buildOutPlan(state, node);
  const preview = coveragePreview(state, node);
  const elsewhere = new Set<SegmentId>(preview.segments.filter((s) => s.servedBy !== null).map((s) => s.segment));
  if (full.cost <= maxCost) {
    return { ...full, lit: preview.segments.filter((s) => s.servedBy === null).map((s) => s.segment) };
  }
  const cabled = new Set<SegmentId>(network.spans.map((s) => s.segment));
  const methodOf = new Map<SegmentId, CableMethod>();
  for (const id of full.aerial) methodOf.set(id, 'aerial');
  for (const id of full.underground) methodOf.set(id, 'underground');
  const unitsOn = (segment: SegmentId): number => {
    if (elsewhere.has(segment)) return 0;
    let units = 0;
    for (const id of parcelsServedBy(city, segment)) {
      const parcel = city.parcels[id];
      if (parcel && parcel.appearsDay <= state.day) units += parcel.units;
    }
    return units;
  };
  const charge = (segment: SegmentId): number => spanCharges(city.segments[segment] as StreetSegment, methodOf.get(segment) ?? 'underground').total;
  // The fixed part: the cabinet, its feeder and the feeder's order fees.
  const used = new Set<CableMethod>();
  let cost = preview.cabinetCost;
  for (const id of full.feeder) {
    cost += charge(id);
    used.add(methodOf.get(id) ?? 'underground');
  }
  for (const method of used) cost += orderFees(method);
  if (cost > maxCost) return null;
  const joined = new Set<NodeId>([node]);
  const join = (segment: SegmentId) => {
    const s = city.segments[segment];
    if (s) {
      joined.add(s.a);
      joined.add(s.b);
    }
  };
  for (const id of full.feeder) join(id);
  for (const id of cabled) join(id);
  const picked: SegmentId[] = [];
  const left = new Set<SegmentId>(full.reach.filter((id) => unitsOn(id) > 0));
  for (;;) {
    let best: { id: SegmentId; density: number; price: number } | null = null;
    for (const id of left) {
      const s = city.segments[id];
      if (!s || (!joined.has(s.a) && !joined.has(s.b))) continue;
      const method = methodOf.get(id) ?? 'underground';
      const price = charge(id) + (used.has(method) ? 0 : orderFees(method));
      if (cost + price > maxCost) continue;
      const density = unitsOn(id) / Math.max(1, price);
      if (!best || density > best.density || (density === best.density && id < best.id)) best = { id, density, price };
    }
    if (!best) break;
    picked.push(best.id);
    left.delete(best.id);
    used.add(methodOf.get(best.id) ?? 'underground');
    cost += best.price;
    join(best.id);
  }
  const laid = new Set<SegmentId>([...cabled, ...full.feeder, ...picked]);
  const plan: SmallerBuildPlan = { node, feeder: [...full.feeder], reach: [...picked].sort((a, b) => a - b), aerial: [], underground: [], commands: [], cost: 0, passings: 0, cpp: null, lit: [] };
  for (const id of [...full.feeder, ...picked]) (methodOf.get(id) === 'aerial' ? plan.aerial : plan.underground).push(id);
  plan.aerial.sort((a, b) => a - b);
  plan.underground.sort((a, b) => a - b);
  if (preview.cabinetCost > 0) plan.commands.push({ type: 'placeCabinet', node });
  plan.cost = preview.cabinetCost;
  for (const method of ['aerial', 'underground'] as const) {
    const segments = method === 'aerial' ? plan.aerial : plan.underground;
    if (segments.length === 0) continue;
    plan.commands.push({ type: 'layCable', segments: [...segments], method });
    plan.cost += quoteCable(state, segments, method).cost;
  }
  for (const { segment } of segmentsWithin(city, node, CABINET_REACH_FT, (s) => laid.has(s.id))) {
    if (!laid.has(segment) || elsewhere.has(segment)) continue;
    const units = unitsOn(segment);
    plan.lit.push(segment);
    plan.passings += units;
  }
  plan.lit.sort((a, b) => a - b);
  plan.cpp = plan.passings > 0 ? plan.cost / plan.passings : null;
  return plan;
}
