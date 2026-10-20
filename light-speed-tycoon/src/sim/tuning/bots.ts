// Scripted players for the balance harness (harness.ts runBot).
//
// Owner: balance-tuning workstream.
//
// - SMART: a careful operator. Keeps a cash reserve, builds the cabinet area
//   with the best homes-per-dollar (green cost per passing first, never red),
//   connects it to the plant, cables its streets with homes in few orders,
//   adds splitters and OLT cards as ports fill, markets about
//   SMART_MARKETING_PER_PASSING dollars per passing per month (none while
//   installs are paused for cash), default prices.
// - CARELESS: overbuilds underground toward random far corners whenever cash
//   covers it (no reserve), cabinets at every 4th corner reached, marketing at
//   the maximum, never adds splitters.
// - IDLE: does nothing.
// - MIXED: SMART plus random removals, price and budget changes, extra
//   splitters and OLT cards: every command type, for the invariant sessions.
//
// Bots read the game only through public sim functions and change it only
// through `send` (applyCommand). Their randomness comes from their own Rng.

import {
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  CPP_TARGET,
  MARKETING_MAX_PER_MONTH,
  MAX_SPLITTERS_PER_CABINET,
  MDU_ROUTER_COST,
  OLT_CARD_COST,
  OLT_MAX_CARDS,
  OVERHEAD_PER_MONTH,
  SIGNUP_RAMP_PER_DAY,
  SPLITTER_COST,
  SUPPORT_COST_PER_SUB_PER_MONTH,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
} from '../balance';
import { coveragePreview, segmentsWithinReach } from '../coverage';
import { cppBand } from '../metrics';
import { cableRoute, getService, orderFees, plannedService, ponPortsUsed, quoteCabinet, quoteCable } from '../network';
import { deriveSeed, Rng } from '../rng';
import {
  accountUnits,
  cabinetPortCapacity,
  cabinetPortsUsed,
  installCost,
  installsPaused,
  marketingBoost,
  monthlyRecurringRevenue,
  subscriberUnits,
  targetTakeRate,
} from '../sales';
import { otherEnd, parcelsServedBy, segmentsAtNode } from '../streets';
import type { CableMethod, City, GameState, NodeId, ParcelId, SegmentId, StreetSegment } from '../types';
import { cheapestMethod, streetTree, treePath } from './harness';
import type { BotFactory, Send } from './harness';

// ---------------------------------------------------------------------------
// SMART
// ---------------------------------------------------------------------------

/** Marketing budget a careful operator runs, dollars per passing per month (capped at MARKETING_MAX_PER_MONTH). */
export const SMART_MARKETING_PER_PASSING = 2;

export interface SmartOptions {
  /** Marketing dollars per passing per month. */
  marketingPerPassing: number;
  /** Add a splitter once a cabinet's ports used reach this share of its capacity. */
  splitterAt: number;
  /** Reserve months of fixed costs (overhead + marketing). */
  reserveMonths: number;
  /**
   * Extra reserve months of the part of fixed costs that revenue does not
   * cover yet (overhead + marketing - (MRR - support)): the runway through the
   * ramp before the first homes pay for the office.
   */
  burnMonths: number;
  /** Days of expected installs kept in the reserve. */
  installDays: number;
  /** Most new cabinet areas started per weekly look. */
  maxProjectsPerLook: number;
  /** Skip cabinet areas that newly cover fewer units than this. */
  minNewUnits: number;
  /** Within an area, skip streets whose own cable costs more than this per unit on them. */
  maxStreetCpp: number;
  /** Longest single cable order the bot draws, ft (a typical drag). */
  orderMaxFt: number;
  /** Candidate areas tried (best first) before waiting for more cash. */
  candidatesTried: number;
}

/**
 * The careful operator's settings. Its reserve is deliberately larger than
 * "3 months of fixed costs + 60 days of installs": with that rule it spends
 * nearly all its cash on day 0 and goes bankrupt in months 8-10 on every
 * tuning seed, because reaching break-even takes 12-18 months by design. So it
 * also keeps the runway to break-even (burnMonths of the uncovered burn, plus
 * the months until its plant is live) and a year of expected installs.
 */
export const SMART_DEFAULTS: SmartOptions = {
  marketingPerPassing: SMART_MARKETING_PER_PASSING,
  splitterAt: 0.8,
  reserveMonths: 3,
  burnMonths: 9,
  installDays: 365,
  maxProjectsPerLook: 6,
  minNewUnits: 25,
  maxStreetCpp: 2 * CPP_TARGET,
  orderMaxFt: 3_000,
  candidatesTried: 6,
};

interface Order {
  segments: SegmentId[];
  method: CableMethod;
}

interface Project {
  node: NodeId;
  /** Buy an OLT card first (no free PON port for the cabinet). */
  oltCard: boolean;
  orders: Order[];
  cost: number;
  newUnits: number;
}

/**
 * Install spend expected on one street as signups close its gap to the target
 * take rate (the gap counted per street, as sales.stepSales does), times
 * `share` of that gap: new units spread over its parcels by their
 * unsubscribed units, at each kind's install cost, plus a building router for
 * an apartment building without one that expects at least half a signup.
 */
function streetConnectCost(
  state: GameState,
  segment: SegmentId,
  subscribed: ReadonlyMap<ParcelId, number>,
  routers: ReadonlySet<ParcelId>,
  share: number,
): number {
  const { city, sales, day } = state;
  let target = 0;
  let subs = 0;
  let open = 0;
  const parcels: Array<{ id: ParcelId; kind: 'home' | 'mdu' | 'smb'; free: number }> = [];
  for (const pid of parcelsServedBy(city, segment)) {
    const parcel = city.parcels[pid];
    if (!parcel || parcel.appearsDay > day) continue;
    const sub = subscribed.get(pid) ?? 0;
    target += targetTakeRate(sales.pricing, parcel.kind) * parcel.units;
    subs += sub;
    open += parcel.units - sub;
    parcels.push({ id: pid, kind: parcel.kind, free: parcel.units - sub });
  }
  const gap = Math.max(0, target - subs) * share;
  if (gap <= 0 || open <= 0) return 0;
  let cost = 0;
  for (const p of parcels) {
    const units = (gap * p.free) / open;
    cost += units * installCost(p.kind, true);
    if (p.kind === 'mdu' && units >= 0.5 && !routers.has(p.id)) cost += MDU_ROUTER_COST;
  }
  return cost;
}

/**
 * Share of a take-rate gap the signup ramp closes within `days` at a marketing
 * budget of `perPassing` dollars per passing per month (the boost does not
 * depend on the town's size at a fixed spend per passing), at most 1.
 */
export function installShare(days: number, perPassing: number): number {
  const boost = marketingBoost(perPassing * 1_000, 1_000);
  // 1 - (1 - r)^days, by repeated multiplication (no Math.pow in the sim).
  const r = SIGNUP_RAMP_PER_DAY * (1 + boost);
  let left = 1;
  for (let d = 0; d < days; d++) left *= 1 - r;
  return Math.min(1, 1 - left);
}

/**
 * Days until everything already ordered is live: the longest remaining
 * permitting plus construction of any span or cabinet not live yet (0 when
 * all plant is live).
 */
export function daysUntilPlannedLive(state: GameState): number {
  let days = 0;
  for (const span of state.network.spans) {
    if (span.stage === 'live') continue;
    days = Math.max(days, span.stageDaysLeft + (span.stage === 'permitting' ? span.constructDays : 0));
  }
  for (const cabinet of state.network.cabinets) {
    if (cabinet.stage === 'live') continue;
    days = Math.max(days, cabinet.stageDaysLeft + (cabinet.stage === 'permitting' ? CABINET_CONSTRUCT_DAYS : 0));
  }
  return days;
}

/**
 * Cash a careful operator never spends on new plant: opts.reserveMonths of
 * fixed costs (overhead + marketing), the part of them that revenue does not
 * cover yet for opts.burnMonths plus the months until the plant already
 * ordered is live (a long make-ready delays the first revenue), and the
 * installs it expects (expectedInstalls over opts.installDays).
 */
export function smartReserve(state: GameState, opts: SmartOptions = SMART_DEFAULTS): number {
  const fixed = OVERHEAD_PER_MONTH + state.sales.marketingPerMonth;
  const earning = monthlyRecurringRevenue(state) - SUPPORT_COST_PER_SUB_PER_MONTH * subscriberUnits(state);
  const uncovered = Math.max(0, fixed - earning);
  const burnMonths = opts.burnMonths + daysUntilPlannedLive(state) / 30;
  return (
    opts.reserveMonths * fixed +
    burnMonths * uncovered +
    expectedInstalls(state, opts.installDays, opts.marketingPerPassing)
  );
}

/**
 * Install spend expected over the next `days` on every street that will be
 * lit once everything ordered is built: streetConnectCost with the share of
 * the gap the signup ramp fills in that time at today's marketing.
 */
export function expectedInstalls(state: GameState, days: number, marketingPerPassing = SMART_MARKETING_PER_PASSING): number {
  const { sales } = state;
  const planned = plannedService(state);
  const subscribed = new Map<ParcelId, number>();
  for (const account of sales.accounts) subscribed.set(account.parcel, accountUnits(account));
  const routers = new Set(sales.routerParcels);
  const share = installShare(days, marketingPerPassing);
  let cost = 0;
  for (const segment of planned.servingCabinet.keys()) cost += streetConnectCost(state, segment, subscribed, routers, share);
  return Math.round(cost);
}

/** Group segments into connected same-method orders of at most maxFt each (one oversized segment is its own order). */
function groupOrders(city: City, segments: Iterable<SegmentId>, method: CableMethod, maxFt: number): Order[] {
  const left = new Set(segments);
  const orders: Order[] = [];
  while (left.size > 0) {
    let start = Infinity;
    for (const id of left) start = Math.min(start, id);
    const order: SegmentId[] = [];
    let ft = 0;
    const queue: SegmentId[] = [start];
    const seen = new Set<SegmentId>([start]);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i] as SegmentId;
      const seg = city.segments[id] as StreetSegment;
      if (order.length > 0 && ft + seg.lengthFt > maxFt) continue;
      order.push(id);
      ft += seg.lengthFt;
      left.delete(id);
      for (const node of [seg.a, seg.b]) {
        for (const next of segmentsAtNode(city, node)) {
          if (!left.has(next) || seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }
    orders.push({ segments: order, method });
  }
  return orders;
}

/** Method for one segment of a bot build: aerial where poled (and cheaper), else underground. */
function methodFor(segment: StreetSegment): CableMethod {
  return cheapestMethod(segment).method;
}

/**
 * Multi-source cheapest-build distances from the plant the player has
 * committed to (the CO and every corner touched by planned CO-connected
 * cable): already-cabled segments cost 0, others their cheapest build.
 * Returns per node the cost and the source corner it is cheapest from.
 */
function feederCosts(state: GameState): { cost: Float64Array; source: Int32Array } {
  const { city, network } = state;
  const planned = plannedService(state);
  const cabled = new Set<SegmentId>(network.spans.map((s) => s.segment));
  const n = city.nodes.length;
  const cost = new Float64Array(n).fill(Infinity);
  const source = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const seed = (node: NodeId) => {
    cost[node] = 0;
    source[node] = node;
  };
  seed(city.coNode);
  for (const id of planned.connectedSegments) {
    const seg = city.segments[id] as StreetSegment;
    seed(seg.a);
    seed(seg.b);
  }
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && (cost[i] as number) < best) {
        best = cost[i] as number;
        u = i;
      }
    }
    if (u < 0) break;
    done[u] = 1;
    for (const segId of segmentsAtNode(city, u)) {
      const seg = city.segments[segId] as StreetSegment;
      const v = otherEnd(seg, u);
      if (done[v]) continue;
      const d = best + (cabled.has(segId) ? 0 : cheapestMethod(seg).cost);
      if (d < (cost[v] as number)) {
        cost[v] = d;
        source[v] = source[u] as number;
      }
    }
  }
  return { cost, source };
}

/** Units on existing parcels served by each segment today. */
function unitsBySegment(state: GameState): Int32Array {
  const units = new Int32Array(state.city.segments.length);
  for (const parcel of state.city.parcels) {
    if (parcel.appearsDay <= state.day) units[parcel.segment] = (units[parcel.segment] as number) + parcel.units;
  }
  return units;
}

interface PlanContext {
  units: Int32Array;
  cabled: Set<SegmentId>;
  /** Segments lit once everything already ordered is built. */
  plannedLit: ReadonlyMap<SegmentId, number>;
  routers: ReadonlySet<ParcelId>;
  subscribed: ReadonlyMap<ParcelId, number>;
  /** Share of a street's take-rate gap counted as install spend (the reserve's horizon). */
  installShare: number;
}

/**
 * The orders (and cabinet, and OLT card if no PON port is free) that light as
 * much of the cabinet area at `node` as `budget` allows, counting what
 * connecting its expected signups will cost (streetConnectCost) as part of the
 * project: the feeder from the committed plant
 * (cableRoute, aerial where possible), then streets with homes in reach that
 * nobody serves yet, nearest first, each with its street path back to the
 * cabinet. Null when it would newly pass fewer than opts.minNewUnits.
 */
function planProject(
  state: GameState,
  node: NodeId,
  source: NodeId,
  budget: number,
  ctx: PlanContext,
  opts: SmartOptions,
): Project | null {
  const { city, network } = state;
  const preview = coveragePreview(state, node);
  const here = network.cabinets.some((c) => c.node === node);
  const oltCard = !here && ponPortsUsed(state) >= network.olt.ponPorts;
  if (oltCard && network.olt.cards >= OLT_MAX_CARDS) return null;
  const fixed = (here ? 0 : quoteCabinet(state, node).cost) + (oltCard ? OLT_CARD_COST : 0);

  const feeder: SegmentId[] = [];
  if (source !== node) {
    const route = cableRoute(state, source, node, 'aerial');
    if (!route) return null;
    for (const id of route) if (!ctx.cabled.has(id)) feeder.push(id);
  }

  const tree = streetTree(city, node, CABINET_REACH_FT);
  const targets = preview.segments
    .filter((entry) => {
      if (entry.servedBy !== null || ctx.plannedLit.has(entry.segment)) return false;
      const units = ctx.units[entry.segment] as number;
      if (units === 0) return false;
      const seg = city.segments[entry.segment] as StreetSegment;
      return ctx.cabled.has(entry.segment) || cheapestMethod(seg).cost <= opts.maxStreetCpp * units;
    })
    .sort((x, y) => x.distanceFt - y.distanceFt || x.segment - y.segment);

  const costOf = (ids: Iterable<SegmentId>) => {
    let cost = 0;
    for (const id of ids) cost += cheapestMethod(city.segments[id] as StreetSegment).cost;
    return cost;
  };
  const build = new Set<SegmentId>(feeder);
  let estimate = fixed + costOf(feeder);
  const accepted: Array<{ segments: SegmentId[]; units: number; connect: number }> = [];
  let newUnits = 0;
  let connect = 0;
  for (const entry of targets) {
    const seg = city.segments[entry.segment] as StreetSegment;
    const adds: SegmentId[] = [];
    if (!ctx.cabled.has(entry.segment) && !build.has(entry.segment)) adds.push(entry.segment);
    const da = tree.dist.get(seg.a) ?? Infinity;
    const db = tree.dist.get(seg.b) ?? Infinity;
    for (const id of treePath(city, tree, da <= db ? seg.a : seg.b)) {
      if (!ctx.cabled.has(id) && !build.has(id) && !adds.includes(id)) adds.push(id);
    }
    const units = ctx.units[entry.segment] as number;
    const addCost = costOf(adds);
    const addConnect = streetConnectCost(state, entry.segment, ctx.subscribed, ctx.routers, ctx.installShare);
    // Leave room for per-order fees (about one order per six streets) when estimating.
    const fees = (Math.ceil((build.size + adds.length) / 6) + 1) * orderFees('underground');
    if (estimate + addCost + fees + connect + addConnect > budget) continue;
    for (const id of adds) build.add(id);
    estimate += addCost;
    newUnits += units;
    connect += addConnect;
    accepted.push({ segments: adds, units, connect: addConnect });
  }

  // Exact cost from quotes; drop the farthest streets until it fits.
  for (;;) {
    if (newUnits < opts.minNewUnits) return null;
    const byMethod: Record<CableMethod, SegmentId[]> = { aerial: [], underground: [] };
    for (const id of build) byMethod[methodFor(city.segments[id] as StreetSegment)].push(id);
    const orders = [
      ...groupOrders(city, byMethod.aerial, 'aerial', opts.orderMaxFt),
      ...groupOrders(city, byMethod.underground, 'underground', opts.orderMaxFt),
    ];
    let cost = fixed;
    for (const order of orders) cost += quoteCable(state, order.segments, order.method).cost;
    if (cost + connect <= budget) return { node, oltCard, orders, cost, newUnits };
    const last = accepted.pop();
    if (!last) return null;
    for (const id of last.segments) build.delete(id);
    newUnits -= last.units;
    connect -= last.connect;
  }
}

const BAND_RANK = { green: 0, amber: 1, red: 2 } as const;

const streetReachCache = new WeakMap<City, SegmentId[][]>();

/**
 * Per corner, the segments a cabinet there would reach along streets (what
 * coveragePreview measures), computed once per city: the city never changes,
 * and scoring every corner through coveragePreview each weekly look was most
 * of a run's time.
 */
function streetReach(city: City): SegmentId[][] {
  let reach = streetReachCache.get(city);
  if (!reach) {
    reach = city.nodes.map((node) => segmentsWithinReach(city, node.id, CABINET_REACH_FT).map((r) => r.segment));
    streetReachCache.set(city, reach);
  }
  return reach;
}

const buildCostCache = new WeakMap<City, Float64Array>();

/** Cheapest buildable cable per segment before fees (cheapestMethod), computed once per city. */
function segmentBuildCosts(city: City): Float64Array {
  let costs = buildCostCache.get(city);
  if (!costs) {
    costs = Float64Array.from(city.segments, (seg) => cheapestMethod(seg).cost);
    buildCostCache.set(city, costs);
  }
  return costs;
}

/**
 * Best cabinet area to build or extend next within `budget`: every corner
 * scored by the units it would newly pass per dollar of cabinet, in-reach
 * build-out (coveragePreview's figures) and feeder from the committed plant;
 * areas whose projected cost per passing is green first, amber next, red never.
 */
function chooseProject(state: GameState, budget: number, opts: SmartOptions): Project | null {
  const { city, network } = state;
  const { cost: feeder, source } = feederCosts(state);
  const ctx: PlanContext = {
    units: unitsBySegment(state),
    cabled: new Set<SegmentId>(network.spans.map((s) => s.segment)),
    plannedLit: plannedService(state).servingCabinet,
    routers: new Set(state.sales.routerParcels),
    subscribed: new Map(state.sales.accounts.map((a) => [a.parcel, accountUnits(a)])),
    installShare: installShare(opts.installDays, opts.marketingPerPassing),
  };
  const reach = streetReach(city);
  const buildCost = segmentBuildCosts(city);
  const standing = new Set<NodeId>(network.cabinets.map((c) => c.node));
  const candidates: Array<{ node: NodeId; band: number; score: number }> = [];
  for (const { id: node } of city.nodes) {
    if ((source[node] as number) < 0) continue;
    // coveragePreview's figures from the cached street reach: the units on
    // segments nothing ordered will serve, and cabinetCost + buildOutCost.
    let newly = 0;
    let cost = standing.has(node) ? 0 : CABINET_COST + CABINET_START_SPLITTERS * SPLITTER_COST;
    for (const segment of reach[node] as SegmentId[]) {
      if (!ctx.plannedLit.has(segment)) newly += ctx.units[segment] as number;
      if (!ctx.cabled.has(segment)) cost += buildCost[segment] as number;
    }
    if (newly < opts.minNewUnits) continue;
    const band = BAND_RANK[cppBand(cost / newly)];
    if (band > BAND_RANK.amber) continue;
    const score = newly / (cost + (feeder[node] as number));
    candidates.push({ node, band, score });
  }
  candidates.sort((x, y) => x.band - y.band || y.score - x.score || x.node - y.node);
  for (const candidate of candidates.slice(0, opts.candidatesTried)) {
    const project = planProject(state, candidate.node, source[candidate.node] as number, budget, ctx, opts);
    if (project) return project;
  }
  return null;
}

/** Splitters where ports run short (and OLT cards to feed them), while cash allows. */
function addCapacity(state: GameState, send: Send, opts: SmartOptions): void {
  const used = cabinetPortsUsed(state);
  const full = new Set(state.sales.fullCabinets);
  const cushion = OVERHEAD_PER_MONTH;
  for (const cabinet of [...state.network.cabinets]) {
    if (cabinet.splitters >= MAX_SPLITTERS_PER_CABINET) continue;
    const ports = used.get(cabinet.id) ?? 0;
    if (!full.has(cabinet.id) && ports < opts.splitterAt * cabinetPortCapacity(cabinet)) continue;
    const { olt } = state.network;
    if (ponPortsUsed(state) >= olt.ponPorts) {
      if (olt.cards >= OLT_MAX_CARDS || state.finance.cash < OLT_CARD_COST + SPLITTER_COST + cushion) return;
      if (!send({ type: 'addOltCard' }).ok) return;
    }
    if (state.finance.cash < SPLITTER_COST + cushion) return;
    send({ type: 'addSplitter', cabinet: cabinet.id });
  }
}

function buildProject(state: GameState, send: Send, project: Project): boolean {
  if (project.oltCard && !send({ type: 'addOltCard' }).ok) return false;
  const here = state.network.cabinets.some((c) => c.node === project.node);
  if (!here && !send({ type: 'placeCabinet', node: project.node }).ok) return false;
  for (const order of project.orders) {
    if (!send({ type: 'layCable', segments: order.segments, method: order.method }).ok) return false;
  }
  return true;
}

/** One weekly look by the careful operator (shared by SMART and MIXED). */
function smartAct(state: GameState, send: Send, opts: SmartOptions, memo: { idleKey: string | null }): void {
  const passings = getService(state).passings;
  // No point advertising while cash cannot connect the customers it brings in.
  const budget = installsPaused(state) ? 0 : Math.min(MARKETING_MAX_PER_MONTH, Math.round(opts.marketingPerPassing * passings));
  if (budget !== state.sales.marketingPerMonth) send({ type: 'setMarketing', perMonth: budget });

  addCapacity(state, send, opts);

  for (let i = 0; i < opts.maxProjectsPerLook; i++) {
    const available = state.finance.cash - smartReserve(state, opts);
    if (available <= 0) return;
    // Nothing worth building last time and nothing changed since: skip the scan.
    const key = `${state.network.version}:${Math.floor(state.day / 28)}:${Math.floor(available / 25_000)}`;
    if (memo.idleKey === key) return;
    const project = chooseProject(state, available, opts);
    if (!project) {
      memo.idleKey = key;
      return;
    }
    if (!buildProject(state, send, project)) return;
  }
}

export function smartBot(options: Partial<SmartOptions> = {}): BotFactory {
  const opts: SmartOptions = { ...SMART_DEFAULTS, ...options };
  return () => {
    const memo = { idleKey: null as string | null };
    return { name: 'smart', act: (state, send) => smartAct(state, send, opts, memo) };
  };
}

// ---------------------------------------------------------------------------
// CARELESS
// ---------------------------------------------------------------------------

/** Most orders the careless player tries in one weekly look. */
const CARELESS_ORDERS_PER_LOOK = 12;
/** A cabinet at every this-many-th corner the careless plant reaches. */
const CARELESS_CABINET_EVERY = 4;

export const carelessBot: BotFactory = (seed) => {
  const rng = new Rng(deriveSeed(seed, 'bot:careless'));
  let cornersReached = 0;
  const reached = new Set<NodeId>();
  let farCorners: NodeId[] | null = null;
  return {
    name: 'careless',
    act(state, send) {
      const { city } = state;
      if (state.sales.marketingPerMonth !== MARKETING_MAX_PER_MONTH) {
        send({ type: 'setMarketing', perMonth: MARKETING_MAX_PER_MONTH });
      }
      if (!farCorners) {
        // The farther half of the town's corners from the CO, by street distance.
        const tree = streetTree(city, city.coNode, Infinity);
        const byDist = city.nodes.map((n) => n.id).sort((a, b) => (tree.dist.get(a) ?? 0) - (tree.dist.get(b) ?? 0) || a - b);
        farCorners = byDist.slice(byDist.length >> 1);
        reached.add(city.coNode);
      }
      for (let i = 0; i < CARELESS_ORDERS_PER_LOOK; i++) {
        const target = rng.pick(farCorners);
        const route = cableRoute(state, city.coNode, target, 'underground');
        if (!route || route.length === 0) continue;
        const quote = quoteCable(state, route, 'underground');
        if (quote.newSegments.length === 0) continue;
        if (quote.cost > state.finance.cash) return; // no reserve: stop only when broke
        if (!send({ type: 'layCable', segments: route, method: 'underground' }).ok) return;
        // Walk the route from the CO and drop a cabinet at every 4th new corner.
        let at = city.coNode;
        for (const id of route) {
          at = otherEnd(city.segments[id] as StreetSegment, at);
          if (reached.has(at)) continue;
          reached.add(at);
          cornersReached++;
          if (cornersReached % CARELESS_CABINET_EVERY === 0) send({ type: 'placeCabinet', node: at });
        }
      }
    },
  };
};

// ---------------------------------------------------------------------------
// IDLE
// ---------------------------------------------------------------------------

export const idleBot: BotFactory = () => ({ name: 'idle', act() {} });

// ---------------------------------------------------------------------------
// MIXED (every command type)
// ---------------------------------------------------------------------------

/**
 * SMART plus, each weekly look, a few random extras from its own Rng: cancel
 * or remove a span (any stage), remove a cabinet, add a splitter or an OLT
 * card, change prices (sometimes out of range: rejected) or the marketing
 * budget, or send junk the sim must reject.
 */
export function mixedBot(options: Partial<SmartOptions> = {}): BotFactory {
  const opts: SmartOptions = { ...SMART_DEFAULTS, ...options };
  return (seed) => {
    const rng = new Rng(deriveSeed(seed, 'bot:mixed'));
    const memo = { idleKey: null as string | null };
    return {
      name: 'mixed',
      act(state, send) {
        smartAct(state, send, opts, memo);
        const extras = rng.int(0, 3);
        for (let i = 0; i < extras; i++) {
          const roll = rng.next();
          const { spans, cabinets } = state.network;
          if (roll < 0.2 && spans.length > 0) {
            // Prefer cancelling something still in permitting (refund), sometimes live cable.
            const permitting = spans.filter((s) => s.stage === 'permitting');
            const pool = permitting.length > 0 && rng.chance(0.7) ? permitting : spans;
            send({ type: 'removeSpan', span: rng.pick(pool).id });
          } else if (roll < 0.3 && cabinets.length > 1) {
            send({ type: 'removeCabinet', cabinet: rng.pick(cabinets).id });
          } else if (roll < 0.45 && cabinets.length > 0) {
            send({ type: 'addSplitter', cabinet: rng.pick(cabinets).id });
          } else if (roll < 0.52) {
            send({ type: 'addOltCard' });
          } else if (roll < 0.7) {
            const tiers = TIER_DEFAULTS.map((t) => ({
              id: t.id,
              price: rng.chance(0.9) ? rng.int(TIER_PRICE_MIN, Math.min(TIER_PRICE_MAX, t.price * 2)) : TIER_PRICE_MAX + 1,
              offered: t.id === 'fiber1g' || rng.chance(0.7),
            }));
            send({ type: 'setPricing', tiers, smbMultiplier: 1 + rng.int(0, 20) / 10 });
          } else if (roll < 0.85) {
            send({ type: 'setMarketing', perMonth: rng.chance(0.9) ? rng.int(0, MARKETING_MAX_PER_MONTH / 5) : -1 });
          } else if (roll < 0.95 && spans.length > 0) {
            // Re-order a street whose cable was removed earlier (remembered make-ready), or extend.
            const seg = rng.int(0, state.city.segments.length - 1);
            send({ type: 'layCable', segments: [seg], method: rng.chance(0.5) ? 'aerial' : 'underground' });
          } else {
            send({ type: 'placeCabinet', node: -1 });
          }
        }
      },
    };
  };
}
