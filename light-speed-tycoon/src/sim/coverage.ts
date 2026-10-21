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
