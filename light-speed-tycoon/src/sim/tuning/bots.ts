// Scripted players for the balance harness (harness.ts runBot).
//
// Owner: balance-tuning workstream.
//
// - SMART: a careful operator. Keeps a cash reserve, builds the cabinet area
//   with the best homes-per-dollar (green cost per passing first, never red),
//   connects it to the plant, cables its streets with homes in few orders,
//   adds splitters and OLT cards as ports fill, markets about
//   SMART_MARKETING_PER_PASSING dollars per passing per month (none while
//   installs are paused for cash), default prices with default
//   grandfathering. Round 3: it borrows responsibly. A 7-year term loan funds
//   its next cabinet project (plus the connects it expects) when the project
//   is not red on its own, the lifetime cost per passing after it - what the
//   bank prices on - stays under opts.loanLifetimeCpp, its reserve is covered
//   and the quote's pro forma covenants keep a buffer (never a quote that
//   breaches; sized within debt.maxSafeTermLoan); the credit line covers
//   timing gaps (draw when cash dips under a small floor, repay when cash is
//   comfortably above the reserve, repay first when a covenant is at risk), so
//   its reserve leans on the undrawn line instead of idle cash, and a
//   covenant-safe draw (debt.fundingHint) buys a splitter or OLT card that
//   cash alone cannot. smartBot({ borrow: false }) is the round-2 SMART.
//   Round 4:
//   - it picks each street's method by its lifetime cost over
//     opts.horizonYears (lifetimeCost: construction, make-ready and fees, pole
//     rent, weather.stormRisk repairs, the outage churn of the subscribers the
//     span would carry, and the make-ready wait before its own street lights),
//     so trunks that carry a whole cabinet area go underground and leaf streets
//     stay aerial where poles make that cheaper;
//   - it rebuilds underground an aerial span storms have hit
//     opts.convertHits times when network.quoteConvert pays back (pole rent,
//     repairs and outage churn avoided) within opts.convertPaybackYears;
//   - it answers an incumbent promo with extra marketing on the contested
//     passings (opts.promoMarketingPerPassing), or an intro promo (opts.introPromo);
//   - it never ignores a frozen line: past a warning it takes debt.cureOptions'
//     first repayment, else deleverages, and builds nothing until compliant.
// - LEVERED: borrows to the limit (every term loan termCapacity allows plus the
//   whole credit line, ignoring covenants and the quote's warning), overbuilds
//   (SMART's project picker, amber and red allowed, heavy marketing) and keeps
//   no reserve for its debt service once the bank lends. It breaches, is
//   frozen, misses a payment and defaults.
// - FROZEN_HOARDER (round 4): the careful operator without loans until the
//   bank lends, then every dollar offered whenever it is offered (LEVERED's
//   borrowing), after which it stops building and sits on the cash, never
//   repaying by choice. With { spendHoard: true } it builds with the hoard
//   instead, keeping only a year of scheduled debt service (the round-3
//   exploit of a frozen line). The frozen-line sweep and the call (debt.ts)
//   make it repay or default.
// - ALL_AERIAL / ALL_UNDERGROUND (round 4): SMART, but aerial wherever poled
//   (underground only where there are no poles) or underground everywhere,
//   never converting.
// - PRICE_HIKER (round 4): SMART, but every PRICE_HIKE_EVERY_MONTHS it raises
//   every offered tier by PRICE_HIKE_SHARE (grandfathered for the default
//   months, or passed on at the next bill with priceHikerBot(0)).
// - RURAL: SMART's borrowing rules on red rural cabinet areas only, so
//   its lifetime cost per passing is red while it borrows: the bank's CPP spread.
// - CARELESS: overbuilds underground toward random far corners whenever cash
//   covers it (no reserve), cabinets at every 4th corner reached, marketing at
//   the maximum, never adds splitters, never borrows.
// - IDLE: does nothing.
// - MIXED: SMART plus random removals, price changes (grandfathered or not,
//   tiers retired and re-offered), intro promos, underground rebuilds, budget
//   changes, extra splitters and OLT cards, credit-line draws and repayments,
//   term loans and prepayments (and junk of each): every command type, for
//   the invariant sessions.
//
// Bots read the game only through public sim functions and change it only
// through `send` (applyCommand). Their randomness comes from their own Rng.

import {
  AERIAL_FT_PER_DAY,
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_TARGET,
  GRANDFATHER_MONTHS_MAX,
  INSTALL_COST_HOME,
  LOAN_ROUNDING,
  MAKE_READY_DAYS_MAX,
  MAKE_READY_DAYS_MIN,
  MAKE_READY_LONG_CHANCE,
  MAKE_READY_LONG_DAYS_MAX,
  MAKE_READY_LONG_DAYS_MIN,
  MARKETING_MAX_PER_MONTH,
  MAX_SPLITTERS_PER_CABINET,
  MDU_ROUTER_COST,
  OLT_CARD_COST,
  OLT_MAX_CARDS,
  OVERHEAD_PER_MONTH,
  PERMIT_DAYS_MAX,
  PERMIT_DAYS_MIN,
  POLE_RENT_PER_POLE_PER_MONTH,
  PROMO_MAX_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  SIGNUP_RAMP_PER_DAY,
  SPLITTER_COST,
  SUPPORT_COST_PER_SUB_PER_MONTH,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
  UNDERGROUND_FT_PER_DAY,
} from '../balance';
import { coveragePreview, segmentsWithinReach } from '../coverage';
import {
  covenantMetrics,
  creditAvailable,
  creditOffer,
  cureOptions,
  estimateNextDebtService,
  fundingHint,
  maxSafeTermLoan,
  quoteTermLoan,
  termCapacity,
  totalDebt,
} from '../debt';
import { activePromos } from '../incumbent';
import { cppBand } from '../metrics';
import {
  cableRoute,
  getService,
  orderFees,
  plannedService,
  ponPortsUsed,
  quoteCabinet,
  quoteCable,
  quoteConvert,
  quoteRemoveSpan,
  spanCharges,
} from '../network';
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
  tierMix,
} from '../sales';
import { otherEnd, parcelsServedBy, polesOnSegment, segmentsAtNode } from '../streets';
import type {
  CableMethod,
  City,
  Command,
  CovenantMetrics,
  GameState,
  IntroPromo,
  NodeId,
  ParcelId,
  ParcelKind,
  SegmentId,
  SpanId,
  StormRisk,
  StreetSegment,
  TermYears,
} from '../types';
import { meanOutageDays, outageChurnProbability, stormRisk } from '../weather';
import { cheapestMethod, streetTree, treePath } from './harness';
import type { BotFactory, Send } from './harness';

// ---------------------------------------------------------------------------
// SMART
// ---------------------------------------------------------------------------

/** Marketing budget a careful operator runs, dollars per passing per month (capped at MARKETING_MAX_PER_MONTH). */
export const SMART_MARKETING_PER_PASSING = 2;

/**
 * How a bot picks each new street's cable method:
 *   lifetime    - the cheaper over the bot's horizon (lifetimeCost; SMART);
 *   aerial      - aerial wherever the street has poles, else underground (ALL_AERIAL);
 *   underground - underground everywhere (ALL_UNDERGROUND).
 */
export type MethodPolicy = 'lifetime' | 'aerial' | 'underground';

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

  // Financing (round 3)
  /** Borrow: term loans for its projects (see loanLifetimeCpp), the credit line for timing gaps (false: the round-2 SMART). */
  borrow: boolean;
  /** A term loan's pro forma leverage stays at most this share of COVENANT_MAX_LEVERAGE ... */
  loanLeverageShare: number;
  /** ... and its pro forma debt-service coverage at least this multiple of COVENANT_MIN_COVERAGE. */
  loanCoverageMultiple: number;
  /**
   * The credit line's (smaller) buffer: a draw keeps leverage within this
   * share of the limit and coverage above this multiple of the minimum, and
   * outside it the line is repaid first (a covenant is at risk).
   */
  lineLeverageShare: number;
  lineCoverageMultiple: number;
  /** Term of the loans it takes. */
  termYears: TermYears;
  /**
   * It borrows for a project that is not red on its own (projectCpp, feeder
   * included) and keeps the projected lifetime cost per passing - the figure
   * the bank prices on - at most this (lifetime capex.osp plus the project's
   * plant, over passings plus its new units): green money for green plant.
   */
  loanLifetimeCpp: number;
  /** Borrow for a project even while its own reserve is short (only the covenant buffers limit it): the rural-heavy bot. */
  borrowWhenShort: boolean;
  /** Smallest term loan it takes (it borrows in chunks); at least TERM_LOAN_MIN. */
  minLoan: number;
  /** Loan amounts are rounded up to a multiple of this. */
  loanStep: number;
  /** Cash floor below which it draws on the line: months of fixed costs (overhead + marketing) ... */
  floorMonths: number;
  /** ... plus this many days of expected installs, plus the next close's debt service. */
  floorInstallDays: number;
  /** Share of the drawable line (within the line buffer) its reserve counts instead of idle cash. */
  lineLean: number;
  /** Build red cabinet areas too, and borrow for any band. */
  allowRed: boolean;
  /** Build only red cabinet areas (the rural-heavy bot; implies allowRed). */
  redOnly: boolean;

  // Round 4
  /** How each new street's cable method is picked (MethodPolicy). */
  methods: MethodPolicy;
  /** Years of running costs (pole rent, repairs, outage churn) the lifetime method choice weighs against the up-front difference. */
  horizonYears: number;
  /** Rebuild storm-hit aerial spans underground when it pays back (round 4). */
  convert: boolean;
  /** Storm hits (in the weather log) that make an aerial span worth a look. */
  convertHits: number;
  /** A rebuild is ordered when its cost over what it saves a year is at most this many years. */
  convertPaybackYears: number;
  /** Extra marketing dollars a month per passing where the incumbent runs a promo (0: no answer by marketing). */
  promoMarketingPerPassing: number;
  /** The intro promo it runs while any incumbent promo runs in its areas (null: none). */
  introPromo: IntroPromo | null;
  /** Past a covenant warning, cure (debt.cureOptions) or deleverage, and build nothing until compliant. */
  cure: boolean;
  /** RunResult.bot. */
  name: string;
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
  borrow: true,
  loanLeverageShare: 0.8,
  loanCoverageMultiple: 1.2,
  lineLeverageShare: 0.9,
  lineCoverageMultiple: 1.1,
  termYears: 7,
  loanLifetimeCpp: 0.9 * CPP_TARGET,
  borrowWhenShort: false,
  minLoan: 25_000,
  loanStep: 5_000,
  floorMonths: 1,
  floorInstallDays: 60,
  lineLean: 1,
  allowRed: false,
  redOnly: false,
  methods: 'lifetime',
  horizonYears: 10,
  convert: true,
  convertHits: 2,
  convertPaybackYears: 10,
  promoMarketingPerPassing: 2,
  introPromo: null,
  cure: true,
  name: 'smart',
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
  /** Plant cost from quotes: cabinet, OLT card, cable orders. */
  cost: number;
  /** Install spend its expected signups will take over the reserve's horizon (part of its budget). */
  connect: number;
  newUnits: number;
}

// ---------------------------------------------------------------------------
// Round 4: lifetime cost of a street's cable, by method
// ---------------------------------------------------------------------------

/** What one subscriber is worth to the method choice and the rebuild test, at today's prices. */
export interface SubscriberEconomics {
  /** Monthly margin of one household subscriber: the signup tier mix's price less support. */
  margin: number;
  /** What losing one costs: a new install plus the margin lost while the signup ramp refills its place (capped at the horizon). */
  lostValue: number;
}

export function subscriberEconomics(state: GameState, opts: SmartOptions = SMART_DEFAULTS): SubscriberEconomics {
  const { pricing } = state.sales;
  const mix = tierMix(pricing, 'home');
  let price = 0;
  for (const tier of pricing.tiers) price += mix[tier.id] * tier.price;
  const margin = Math.max(0, price - SUPPORT_COST_PER_SUB_PER_MONTH);
  const boost = marketingBoost(opts.marketingPerPassing * 1_000, 1_000);
  const monthlyRamp = SIGNUP_RAMP_PER_DAY * (1 + boost) * 30;
  const refillMonths = Math.min(12 * opts.horizonYears, monthlyRamp > 0 ? 1 / monthlyRamp : Infinity);
  return { margin, lostValue: INSTALL_COST_HOME + margin * refillMonths };
}

/** Expected days from order to light for a span of `method` on `segment`: permitting (make-ready's long tail included) plus construction. */
export function expectedLeadDays(segment: StreetSegment, method: CableMethod): number {
  if (method === 'aerial') {
    const usual = (MAKE_READY_DAYS_MIN + MAKE_READY_DAYS_MAX) / 2;
    const long = (MAKE_READY_LONG_DAYS_MIN + MAKE_READY_LONG_DAYS_MAX) / 2;
    return (1 - MAKE_READY_LONG_CHANCE) * usual + MAKE_READY_LONG_CHANCE * long + segment.lengthFt / AERIAL_FT_PER_DAY;
  }
  return (PERMIT_DAYS_MIN + PERMIT_DAYS_MAX) / 2 + segment.lengthFt / UNDERGROUND_FT_PER_DAY;
}

const riskCache = new WeakMap<City, Map<number, StormRisk>>();

/** weather.stormRisk per segment and method, computed once per city (it depends only on where the street is). */
function riskOf(state: GameState, segment: StreetSegment, method: CableMethod): StormRisk {
  let cache = riskCache.get(state.city);
  if (!cache) {
    cache = new Map();
    riskCache.set(state.city, cache);
  }
  const key = segment.id * 2 + (method === 'aerial' ? 0 : 1);
  let risk = cache.get(key);
  if (!risk) {
    risk = stormRisk(state, segment, method);
    cache.set(key, risk);
  }
  return risk;
}

/** Expected yearly cost of the outages on a span of `method` carrying `subscribers`: repairs plus the subscribers they cost. */
function outageCostPerYear(state: GameState, segment: StreetSegment, method: CableMethod, subscribers: number, econ: SubscriberEconomics): number {
  const risk = riskOf(state, segment, method);
  const churn = risk.outagesPerYear * subscribers * outageChurnProbability(meanOutageDays(method)) * econ.lostValue;
  return risk.repairCostPerYear + churn;
}

/**
 * What cabling `segment` with `method` costs over opts.horizonYears: its
 * charges (construction, rock, make-ready) and its share of an order's fees,
 * plus the horizon's pole rent and expected outage cost (weather.stormRisk
 * repairs, and the outage churn of its own street's `own` subscribers: the
 * street grid gives the rest of the plant a second path, so an outage cuts
 * off little more than the street itself), plus the margin the `carried`
 * subscribers (its street and those that light through it) lose while it
 * waits for permits and make-ready.
 */
export function lifetimeCost(
  state: GameState,
  segment: StreetSegment,
  method: CableMethod,
  carried: number,
  own: number,
  opts: SmartOptions,
  econ: SubscriberEconomics,
): number {
  const upfront = spanCharges(segment, method).total + orderFees(method) * Math.min(1, segment.lengthFt / opts.orderMaxFt);
  const rent = method === 'aerial' ? polesOnSegment(segment) * POLE_RENT_PER_POLE_PER_MONTH * 12 : 0;
  const yearly = rent + outageCostPerYear(state, segment, method, own, econ);
  const wait = (expectedLeadDays(segment, method) / 30) * (WAIT_ON_CARRIED ? carried : own) * econ.margin;
  return upfront + opts.horizonYears * yearly + wait;
}

export let WAIT_ON_CARRIED = false;
export function setWaitOnCarried(v: boolean): void { WAIT_ON_CARRIED = v; }
/** The method a bot cables `segment` with: `carried` subscribers light through it, `own` of them on the street itself. */
export function chooseMethod(
  state: GameState,
  segment: StreetSegment,
  carried: number,
  own: number,
  opts: SmartOptions,
  econ: SubscriberEconomics,
): CableMethod {
  if (!segment.hasPoles || opts.methods === 'underground') return 'underground';
  if (opts.methods === 'aerial') return 'aerial';
  const aerial = lifetimeCost(state, segment, 'aerial', carried, own, opts, econ);
  const underground = lifetimeCost(state, segment, 'underground', carried, own, opts, econ);
  return underground < aerial ? 'underground' : 'aerial';
}

/** Up-front charges (before fees) of the method a policy would pick on cost alone: underground everywhere, else the cheaper buildable way. */
function policyBuildCost(segment: StreetSegment, policy: MethodPolicy): number {
  return policy === 'underground' ? spanCharges(segment, 'underground').total : cheapestMethod(segment).cost;
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
  rates: Readonly<Record<ParcelKind, number>>,
): number {
  const { city, day } = state;
  let target = 0;
  let subs = 0;
  let open = 0;
  const parcels: Array<{ id: ParcelId; kind: 'home' | 'mdu' | 'smb'; free: number }> = [];
  for (const pid of parcelsServedBy(city, segment)) {
    const parcel = city.parcels[pid];
    if (!parcel || parcel.appearsDay > day) continue;
    const sub = subscribed.get(pid) ?? 0;
    target += rates[parcel.kind] * parcel.units;
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

/** Subscribers a street is expected to carry at its target take rate (its parcels present today). */
function streetSubscribers(state: GameState, segment: SegmentId, rates: Readonly<Record<ParcelKind, number>>): number {
  let subs = 0;
  for (const pid of parcelsServedBy(state.city, segment)) {
    const parcel = state.city.parcels[pid];
    if (parcel && parcel.appearsDay <= state.day) subs += rates[parcel.kind] * parcel.units;
  }
  return subs;
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
 * fixed costs (overhead + marketing), the part of them (and of a month's
 * `debtService`, for a borrower) that revenue does not cover yet for
 * opts.burnMonths plus the months until the plant already ordered is live (a
 * long make-ready delays the first revenue), and the installs it expects
 * (expectedInstalls over opts.installDays).
 */
export function smartReserve(state: GameState, opts: SmartOptions = SMART_DEFAULTS, debtService = 0): number {
  const fixed = OVERHEAD_PER_MONTH + state.sales.marketingPerMonth;
  const earning = monthlyRecurringRevenue(state) - SUPPORT_COST_PER_SUB_PER_MONTH * subscriberUnits(state);
  const uncovered = Math.max(0, fixed + debtService - earning);
  const burnMonths = opts.burnMonths + daysUntilPlannedLive(state) / 30;
  return (
    opts.reserveMonths * fixed +
    burnMonths * uncovered +
    expectedInstalls(state, opts.installDays, opts.marketingPerPassing)
  );
}

/** Target take rate by building kind at today's prices (sales.targetTakeRate), for streetConnectCost. */
function takeRates(state: GameState): Record<ParcelKind, number> {
  const { pricing } = state.sales;
  return { home: targetTakeRate(pricing, 'home'), mdu: targetTakeRate(pricing, 'mdu'), smb: targetTakeRate(pricing, 'smb') };
}

/**
 * Last expectedInstalls results per state, keyed by everything they read: the
 * day (parcels appear by day), the plant (network.version), accounts and
 * building routers, prices, the horizon and the marketing assumption. A weekly
 * look asks several times on one day; this keeps the bots fast and never
 * changes an answer.
 */
const installsMemo = new WeakMap<GameState, Map<string, number>>();

/**
 * Install spend expected over the next `days` on every street that will be
 * lit once everything ordered is built: streetConnectCost with the share of
 * the gap the signup ramp fills in that time at today's marketing.
 */
export function expectedInstalls(state: GameState, days: number, marketingPerPassing = SMART_MARKETING_PER_PASSING): number {
  const { sales } = state;
  const key =
    `${state.day}:${state.network.version}:${sales.accounts.length}:${sales.routerParcels.length}:${days}:${marketingPerPassing}:` +
    JSON.stringify(sales.pricing);
  let memo = installsMemo.get(state);
  const hit = memo?.get(key);
  if (hit !== undefined) return hit;
  const planned = plannedService(state);
  const subscribed = new Map<ParcelId, number>();
  for (const account of sales.accounts) subscribed.set(account.parcel, accountUnits(account));
  const routers = new Set(sales.routerParcels);
  const share = installShare(days, marketingPerPassing);
  const rates = takeRates(state);
  let cost = 0;
  for (const segment of planned.servingCabinet.keys()) cost += streetConnectCost(state, segment, subscribed, routers, share, rates);
  const result = Math.round(cost);
  if (!memo || memo.size >= 8) {
    memo = new Map();
    installsMemo.set(state, memo);
  }
  memo.set(key, result);
  return result;
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

/**
 * Multi-source cheapest-build distances from the plant the player has
 * committed to (the CO and every corner touched by planned CO-connected
 * cable): already-cabled segments cost 0, others their cheapest build under
 * `policy` (policyBuildCost). Returns per node the cost and the source corner
 * it is cheapest from.
 */
function feederCosts(state: GameState, policy: MethodPolicy): { cost: Float64Array; source: Int32Array } {
  const { city, network } = state;
  const planned = plannedService(state);
  const cabled = new Set<SegmentId>(network.spans.map((s) => s.segment));
  const build = segmentBuildCosts(city, policy);
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
      const d = best + (cabled.has(segId) ? 0 : (build[segId] as number));
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
  /** Target take rate by kind (takeRates). */
  rates: Readonly<Record<ParcelKind, number>>;
  /** Subscriber economics for the method choice (subscriberEconomics). */
  econ: SubscriberEconomics;
}

/**
 * The orders (and cabinet, and OLT card if no PON port is free) that light as
 * much of the cabinet area at `node` as `budget` allows, counting what
 * connecting its expected signups will cost (streetConnectCost) as part of the
 * project: the feeder from the committed plant (cableRoute, aerial where
 * possible unless the bot builds underground everywhere), then streets with
 * homes in reach that nobody serves yet, nearest first, each with its street
 * path back to the cabinet. Each new segment's method is chosen once for the
 * whole area (chooseMethod): the feeder carries every subscriber the area is
 * expected to have, a street on the way to others carries theirs too. Null
 * when it would newly pass fewer than opts.minNewUnits.
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
    const route = cableRoute(state, source, node, opts.methods === 'underground' ? 'underground' : 'aerial');
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
    .sort((x, y) => x.distanceFt - y.distanceFt || x.segment - y.segment)
    .map((entry) => {
      // The street's new segments: itself and its street path back to the cabinet.
      const seg = city.segments[entry.segment] as StreetSegment;
      const path: SegmentId[] = [];
      if (!ctx.cabled.has(entry.segment)) path.push(entry.segment);
      const da = tree.dist.get(seg.a) ?? Infinity;
      const db = tree.dist.get(seg.b) ?? Infinity;
      for (const id of treePath(city, tree, da <= db ? seg.a : seg.b)) {
        if (!ctx.cabled.has(id) && !path.includes(id)) path.push(id);
      }
      return { segment: entry.segment, path, subs: streetSubscribers(state, entry.segment, ctx.rates) };
    });

  // Method per new segment, for the whole area: subscribers carried and on the street itself.
  const carried = new Map<SegmentId, number>();
  const own = new Map<SegmentId, number>();
  let areaSubs = 0;
  for (const t of targets) {
    areaSubs += t.subs;
    own.set(t.segment, t.subs);
    for (const id of t.path) carried.set(id, (carried.get(id) ?? 0) + t.subs);
  }
  for (const id of feeder) carried.set(id, (carried.get(id) ?? 0) + areaSubs);
  const methods = new Map<SegmentId, CableMethod>();
  for (const [id, subs] of carried) {
    methods.set(id, chooseMethod(state, city.segments[id] as StreetSegment, subs, own.get(id) ?? 0, opts, ctx.econ));
  }
  const methodOf = (id: SegmentId): CableMethod =>
    methods.get(id) ?? chooseMethod(state, city.segments[id] as StreetSegment, 0, 0, opts, ctx.econ);

  const costOf = (ids: Iterable<SegmentId>) => {
    let cost = 0;
    for (const id of ids) cost += spanCharges(city.segments[id] as StreetSegment, methodOf(id)).total;
    return cost;
  };
  const build = new Set<SegmentId>(feeder);
  let estimate = fixed + costOf(feeder);
  const accepted: Array<{ segments: SegmentId[]; units: number; connect: number }> = [];
  let newUnits = 0;
  let connect = 0;
  for (const target of targets) {
    const adds = target.path.filter((id) => !build.has(id));
    const units = ctx.units[target.segment] as number;
    const addCost = costOf(adds);
    const addConnect = streetConnectCost(state, target.segment, ctx.subscribed, ctx.routers, ctx.installShare, ctx.rates);
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
    for (const id of build) byMethod[methodOf(id)].push(id);
    const orders = [
      ...groupOrders(city, byMethod.aerial, 'aerial', opts.orderMaxFt),
      ...groupOrders(city, byMethod.underground, 'underground', opts.orderMaxFt),
    ];
    let cost = fixed;
    for (const order of orders) cost += quoteCable(state, order.segments, order.method).cost;
    if (cost + connect <= budget) return { node, oltCard, orders, cost, connect, newUnits };
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

const buildCostCache = new WeakMap<City, Partial<Record<MethodPolicy, Float64Array>>>();

/** policyBuildCost per segment (before fees), computed once per city and policy. */
function segmentBuildCosts(city: City, policy: MethodPolicy): Float64Array {
  let byPolicy = buildCostCache.get(city);
  if (!byPolicy) {
    byPolicy = {};
    buildCostCache.set(city, byPolicy);
  }
  let costs = byPolicy[policy];
  if (!costs) {
    costs = Float64Array.from(city.segments, (seg) => policyBuildCost(seg, policy));
    byPolicy[policy] = costs;
  }
  return costs;
}

/** Outside-plant cost per unit the project newly passes (its cabinet and cable; an OLT card is CO capex). */
function projectCpp(project: Project): number {
  return (project.cost - (project.oltCard ? OLT_CARD_COST : 0)) / project.newUnits;
}

/**
 * Best cabinet area to build or extend next within `budget`: every corner
 * scored by the units it would newly pass per dollar of cabinet, in-reach
 * build-out (coveragePreview's figures) and feeder from the committed plant;
 * areas whose projected cost per passing is green first, amber next, red only
 * with opts.allowRed (opts.redOnly: red areas only). `maxBand` (a BAND_RANK)
 * caps the area's band and the planned project's own cost per passing
 * (projectCpp, which counts its feeder) when `strict`; `accept` may veto a
 * planned project (SMART's lifetime test for what it borrows for).
 */
function chooseProject(
  state: GameState,
  budget: number,
  opts: SmartOptions,
  maxBand = defaultBand(opts),
  strict = false,
  accept: (project: Project) => boolean = () => true,
): Project | null {
  const { city, network } = state;
  const { cost: feeder, source } = feederCosts(state, opts.methods);
  const ctx: PlanContext = {
    units: unitsBySegment(state),
    cabled: new Set<SegmentId>(network.spans.map((s) => s.segment)),
    plannedLit: plannedService(state).servingCabinet,
    routers: new Set(state.sales.routerParcels),
    subscribed: new Map(state.sales.accounts.map((a) => [a.parcel, accountUnits(a)])),
    installShare: installShare(opts.installDays, opts.marketingPerPassing),
    rates: takeRates(state),
    econ: subscriberEconomics(state, opts),
  };
  const reach = streetReach(city);
  const buildCost = segmentBuildCosts(city, opts.methods);
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
    if (band > maxBand || (opts.redOnly && band < BAND_RANK.red)) continue;
    const score = newly / (cost + (feeder[node] as number));
    candidates.push({ node, band, score });
  }
  candidates.sort((x, y) => x.band - y.band || y.score - x.score || x.node - y.node);
  for (const candidate of candidates.slice(0, opts.candidatesTried)) {
    const project = planProject(state, candidate.node, source[candidate.node] as number, budget, ctx, opts);
    if (!project) continue;
    const band = BAND_RANK[cppBand(projectCpp(project))];
    if ((strict && band > maxBand) || (opts.redOnly && band < BAND_RANK.red) || !accept(project)) continue;
    return project;
  }
  return null;
}

/** The worst band a bot builds with its own cash: amber, or red with opts.allowRed. */
function defaultBand(opts: SmartOptions): number {
  return opts.allowRed || opts.redOnly ? BAND_RANK.red : BAND_RANK.amber;
}

/** The worst band of a project a bot borrows for: amber (with the lifetime test), or red with opts.allowRed. */
function loanBand(opts: SmartOptions): number {
  return opts.allowRed || opts.redOnly ? BAND_RANK.red : BAND_RANK.amber;
}

/** Lifetime cost per passing once `project` is built: (capex.osp + its plant) / (passings + its new units). */
function projectedLifetimeCpp(state: GameState, project: Project): number {
  const plant = project.cost - (project.oltCard ? OLT_CARD_COST : 0);
  return (state.finance.capex.osp + plant) / (getService(state).passings + project.newUnits);
}

/**
 * Cash for a capacity purchase of `cost` (a splitter, an OLT card): what
 * cash holds above `cushion`, or else (a borrower, compliant) the
 * covenant-safe credit-line draw debt.fundingHint suggests, when it is all
 * it takes and keeps the line's buffer. True when cash now covers it.
 */
function fundCapacity(state: GameState, send: Send, opts: SmartOptions, cost: number, cushion: number): boolean {
  if (state.finance.cash >= cost + cushion) return true;
  if (!opts.borrow || state.debt.covenant.stage !== 'compliant') return false;
  const hint = fundingHint(state, cost);
  if (hint.kind !== 'draw' || hint.draw > lineRoom(state, opts)) return false;
  return send({ type: 'drawCredit', amount: hint.draw }).ok && state.finance.cash >= cost;
}

/** Splitters where ports run short (and OLT cards to feed them), while cash (or a safe draw) allows. */
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
      if (olt.cards >= OLT_MAX_CARDS || !fundCapacity(state, send, opts, OLT_CARD_COST + SPLITTER_COST, cushion)) return;
      if (!send({ type: 'addOltCard' }).ok) return;
    }
    if (!fundCapacity(state, send, opts, SPLITTER_COST, cushion)) return;
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

// ---------------------------------------------------------------------------
// SMART's financing (round 3, cures round 4)
// ---------------------------------------------------------------------------

/**
 * The metrics keep `leverageShare` x COVENANT_MAX_LEVERAGE and
 * `coverageMultiple` x COVENANT_MIN_COVERAGE (no debt, or nothing scheduled,
 * passes that test).
 */
export function withinBuffer(m: CovenantMetrics, leverageShare: number, coverageMultiple: number): boolean {
  if (m.totalDebt > 0 && (m.leverage === null || m.leverage > leverageShare * COVENANT_MAX_LEVERAGE)) return false;
  if (m.annualDebtService > 0 && (m.coverage === null || m.coverage < coverageMultiple * COVENANT_MIN_COVERAGE)) return false;
  return true;
}

/** Largest multiple of `step` in [0, max] for which `ok` holds (`ok` true at 0 and monotone: once false, false above). */
function largestOk(max: number, step: number, ok: (amount: number) => boolean): number {
  let lo = 0;
  let hi = Math.floor(max / step);
  if (hi <= 0) return 0;
  if (ok(hi * step)) return hi * step;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid * step)) lo = mid;
    else hi = mid;
  }
  return lo * step;
}

/** Overhead + this month's marketing. */
function fixedCosts(state: GameState): number {
  return OVERHEAD_PER_MONTH + state.sales.marketingPerMonth;
}

/**
 * Most the credit line can draw now while the covenant metrics keep the
 * line's buffer (opts.lineLeverageShare, opts.lineCoverageMultiple), a year of
 * interest at the line's effective rate counted as debt service; 0 unless the
 * stage is 'compliant'.
 */
export function lineRoom(state: GameState, opts: SmartOptions): number {
  if (state.debt.covenant.stage !== 'compliant') return 0;
  const offer = creditOffer(state);
  if (offer.available <= 0) return 0;
  const bps = offer.rate.effectiveRateBps;
  return largestOk(offer.available, LOAN_ROUNDING, (amount) =>
    withinBuffer(
      covenantMetrics(state, { addDebt: amount, addAnnualDebtService: Math.round((amount * bps) / 10_000) }),
      opts.lineLeverageShare,
      opts.lineCoverageMultiple,
    ),
  );
}

/**
 * Largest term loan (opts.termYears, a multiple of LOAN_ROUNDING) within the
 * bank's largest covenant-safe loan (debt.maxSafeTermLoan) whose quote is ok
 * and keeps the loan buffer (opts.loanLeverageShare,
 * opts.loanCoverageMultiple) pro forma; 0 when that is below opts.minLoan or
 * the stage is not 'compliant'.
 */
export function safeTermLoan(state: GameState, opts: SmartOptions): number {
  const min = Math.max(TERM_LOAN_MIN, opts.minLoan);
  if (state.debt.covenant.stage !== 'compliant') return 0;
  const safe = maxSafeTermLoan(state, opts.termYears);
  if (safe < min) return 0;
  const amount = largestOk(safe, LOAN_ROUNDING, (a) => {
    if (a < TERM_LOAN_MIN) return true;
    const quote = quoteTermLoan(state, a, opts.termYears);
    return quote.ok && !quote.breachesCovenant && withinBuffer(quote.after, opts.loanLeverageShare, opts.loanCoverageMultiple);
  });
  return amount >= min ? amount : 0;
}

/**
 * The borrowing operator's cash floor: opts.floorMonths of fixed costs, the
 * next close's debt service (debt.estimateNextDebtService) and
 * opts.floorInstallDays of expected installs. Below it, it draws on the line.
 */
export function cashFloor(state: GameState, opts: SmartOptions): number {
  return (
    opts.floorMonths * fixedCosts(state) +
    estimateNextDebtService(state) +
    expectedInstalls(state, opts.floorInstallDays, opts.marketingPerPassing)
  );
}

/**
 * Cash SMART does not spend on new plant. Without borrowing, the round-2
 * smartReserve. A borrower counts the next close's debt service as a monthly
 * cost revenue must cover (smartReserve's burn runway) and keeps it in hand,
 * less opts.lineLean of what the line could draw within its buffer
 * (lineRoom), never below cashFloor.
 */
export function borrowerReserve(state: GameState, opts: SmartOptions): number {
  if (!opts.borrow) return smartReserve(state, opts);
  const service = estimateNextDebtService(state);
  const lean = opts.lineLean > 0 ? opts.lineLean * lineRoom(state, opts) : 0;
  return Math.max(cashFloor(state, opts), smartReserve(state, opts, service) + service - lean);
}

/**
 * The credit line for timing gaps: with a covenant at risk (stage not
 * 'compliant', or the metrics outside the line's buffer) repay the line from
 * everything above one month of fixed costs and the next debt service; else
 * repay what is above the full reserve (smartReserve + next debt service), or
 * draw back up to the cash floor when cash is under it (within the buffer).
 */
function manageCredit(state: GameState, send: Send, opts: SmartOptions): void {
  const balance = state.debt.credit.balance;
  const cash = state.finance.cash;
  const nextService = estimateNextDebtService(state);
  const atRisk =
    state.debt.covenant.stage !== 'compliant' ||
    !withinBuffer(covenantMetrics(state), opts.lineLeverageShare, opts.lineCoverageMultiple);
  if (balance > 0) {
    const keep = atRisk ? fixedCosts(state) + nextService : smartReserve(state, opts, nextService) + nextService;
    const repay = Math.min(balance, Math.floor(cash - keep));
    if (repay >= 1) {
      send({ type: 'repayCredit', amount: repay });
      return;
    }
  }
  if (atRisk) return;
  const floor = cashFloor(state, opts);
  if (cash >= floor) return;
  const want = Math.ceil((floor - cash) / LOAN_ROUNDING) * LOAN_ROUNDING;
  const amount = Math.min(want, lineRoom(state, opts));
  if (amount >= 1) send({ type: 'drawCredit', amount });
}

/**
 * Round 4: never ignore a frozen line. Past a covenant warning (penalty,
 * frozen, or loans called) with debt owed: take the first verified cure
 * (debt.cureOptions: a repayment or prepayment that passes both tests and
 * keeps the next debt service in cash), else deleverage: repay the line, then
 * prepay the dearest loan, from everything above a month of fixed costs and
 * the next debt service. Returns true while it must not build (stage past a
 * warning, or the loans called).
 */
function cureOrDeleverage(state: GameState, send: Send, opts: SmartOptions): boolean {
  const { covenant, acceleration } = state.debt;
  const serious = covenant.stage === 'penalty' || covenant.stage === 'frozen' || acceleration !== null;
  if (!opts.cure || totalDebt(state) === 0 || covenant.stage === 'compliant') return false;
  const cure = cureOptions(state).find((option) => option.kind !== 'grow');
  if (cure) {
    const cmd: Command =
      cure.kind === 'repayCredit'
        ? { type: 'repayCredit', amount: cure.amount }
        : { type: 'prepayLoan', loan: cure.loan as number, amount: cure.amount };
    send(cmd);
    return serious;
  }
  if (!serious) return false;
  let spare = Math.floor(state.finance.cash - fixedCosts(state) - estimateNextDebtService(state));
  const line = Math.min(state.debt.credit.balance, spare);
  if (line >= 1 && send({ type: 'repayCredit', amount: line }).ok) spare -= line;
  const dearest = [...state.debt.loans].sort((a, b) => b.rateBps - a.rateBps || a.id - b.id)[0];
  // Leave room for the accrued interest a prepayment also takes.
  const prepay = dearest ? Math.min(dearest.balance, Math.floor(spare * 0.95)) : 0;
  if (dearest && prepay >= 1) send({ type: 'prepayLoan', loan: dearest.id, amount: prepay });
  return true;
}

/**
 * Take the term loan that funds `project` beyond `own` cash: its cost plus
 * expected connects less own, rounded up to opts.loanStep, at least
 * opts.minLoan, at most `room` (safeTermLoan). Checks the quote once more.
 */
function borrowFor(state: GameState, send: Send, opts: SmartOptions, project: Project, own: number, room: number): boolean {
  const need = project.cost + project.connect - Math.max(0, own);
  if (need <= 0) return true;
  const amount = Math.min(room, Math.max(opts.minLoan, TERM_LOAN_MIN, Math.ceil(need / opts.loanStep) * opts.loanStep));
  if (amount < need) return false;
  const quote = quoteTermLoan(state, amount, opts.termYears);
  if (!quote.ok || quote.breachesCovenant || !withinBuffer(quote.after, opts.loanLeverageShare, opts.loanCoverageMultiple)) return false;
  return send({ type: 'takeTermLoan', amount, termYears: opts.termYears }).ok;
}

// ---------------------------------------------------------------------------
// SMART's round-4 habits: marketing against incumbent promos, rebuilds
// ---------------------------------------------------------------------------

/** Passings in cabinet areas where the incumbent runs a promo today. */
export function contestedPassings(state: GameState): number {
  const coverage = getService(state).cabinetCoverage;
  let passings = 0;
  for (const promo of activePromos(state)) passings += coverage.get(promo.cabinet)?.passings ?? 0;
  return passings;
}

/**
 * The marketing budget: opts.marketingPerPassing per passing, plus
 * opts.promoMarketingPerPassing per passing where the incumbent runs a promo,
 * capped; none while installs are paused for cash (no point advertising
 * while cash cannot connect the customers it brings in).
 */
function marketingBudget(state: GameState, opts: SmartOptions): number {
  if (installsPaused(state)) return 0;
  const contested = opts.promoMarketingPerPassing > 0 ? contestedPassings(state) : 0;
  const wanted = opts.marketingPerPassing * getService(state).passings + opts.promoMarketingPerPassing * contested;
  return Math.min(MARKETING_MAX_PER_MONTH, Math.round(wanted));
}

/** The intro promo (opts.introPromo) runs while the incumbent runs a promo in any of its areas, and stops after. */
function answerWithPromo(state: GameState, send: Send, opts: SmartOptions): void {
  if (opts.introPromo === null) return;
  const want = activePromos(state).length > 0 ? opts.introPromo : null;
  const have = state.sales.promo;
  const same = want === null ? have === null : have !== null && have.percentOff === want.percentOff && have.months === want.months;
  if (!same) send({ type: 'setPromo', promo: want });
}

/** Storm hits per span in the weather log (Storm.spans, the last STORM_LOG_DAYS days). */
export function stormHits(state: GameState): Map<SpanId, number> {
  const hits = new Map<SpanId, number>();
  for (const storm of state.weather.storms) for (const span of storm.spans) hits.set(span, (hits.get(span) ?? 0) + 1);
  return hits;
}

/**
 * What rebuilding a live aerial span underground saves a year: the pole rent
 * and repairs network.quoteConvert names, plus the outage churn it avoids on
 * the subscribers the span carries (those quoteRemoveSpan says it would cut
 * off, or its passings at the target take rate when that is more).
 */
export function convertSavingsPerYear(state: GameState, span: SpanId, econ: SubscriberEconomics): number {
  const quote = quoteConvert(state, span);
  const target = state.network.spans.find((s) => s.id === span);
  const segment = target ? state.city.segments[target.segment] : undefined;
  if (!segment) return 0;
  const cut = quoteRemoveSpan(state, span);
  const carried = Math.max(cut.subscribersAffected, cut.passingsLost * targetTakeRate(state.sales.pricing, 'home'));
  const churn =
    outageCostPerYear(state, segment, 'aerial', carried, econ) -
    riskOf(state, segment, 'aerial').repairCostPerYear -
    (outageCostPerYear(state, segment, 'underground', carried, econ) - riskOf(state, segment, 'underground').repairCostPerYear);
  return 12 * quote.poleRentSaved + quote.repairsAvoidedPerYear + churn;
}

/**
 * Rebuild underground the aerial spans storms have hit opts.convertHits times
 * (in the weather log) whose rebuild (network.quoteConvert) pays back within
 * opts.convertPaybackYears (convertSavingsPerYear), most hits first, from
 * cash above its reserve. Looks once every 4 weeks.
 */
function convertHitSpans(state: GameState, send: Send, opts: SmartOptions): void {
  if (!opts.convert || opts.methods !== 'lifetime' || state.day % 28 >= 7) return;
  const hits = stormHits(state);
  const candidates = state.network.spans
    .filter((s) => s.stage === 'live' && s.method === 'aerial' && s.conversion === null && (hits.get(s.id) ?? 0) >= opts.convertHits)
    .sort((a, b) => (hits.get(b.id) ?? 0) - (hits.get(a.id) ?? 0) || a.id - b.id);
  if (candidates.length === 0) return;
  const econ = subscriberEconomics(state, opts);
  for (const span of candidates) {
    const quote = quoteConvert(state, span.id);
    if (!quote.ok) continue;
    const savings = convertSavingsPerYear(state, span.id, econ);
    if (savings <= 0 || quote.cost > opts.convertPaybackYears * savings) continue;
    if (state.finance.cash - borrowerReserve(state, opts) < quote.cost) return;
    send({ type: 'convertSpan', span: span.id });
  }
}

/** One weekly look by the careful operator (shared by SMART, RURAL, MIXED and the round-4 variants). */
function smartAct(state: GameState, send: Send, opts: SmartOptions, memo: { idleKey: string | null }): void {
  const budget = marketingBudget(state, opts);
  if (budget !== state.sales.marketingPerMonth) send({ type: 'setMarketing', perMonth: budget });
  answerWithPromo(state, send, opts);

  const hold = opts.borrow ? cureOrDeleverage(state, send, opts) : false;
  if (opts.borrow) manageCredit(state, send, opts);
  addCapacity(state, send, opts);
  if (hold) return;
  convertHitSpans(state, send, opts);

  for (let i = 0; i < opts.maxProjectsPerLook; i++) {
    const own = state.finance.cash - borrowerReserve(state, opts);
    // SMART never borrows to build while its reserve (debt service included) is short.
    if (own <= 0 && !(opts.borrowWhenShort && opts.borrow)) break;
    const room = opts.borrow ? safeTermLoan(state, opts) : 0;
    if (own <= 0 && room <= 0) break;
    // Nothing worth building last time and nothing changed since: skip the scan.
    const key = `${state.network.version}:${Math.floor(state.day / 28)}:${Math.floor(own / 25_000)}:${Math.floor(room / 25_000)}`;
    if (memo.idleKey === key) break;
    // With loan room: the best project it would borrow for (not red on its own,
    // lifetime cost per passing kept under opts.loanLifetimeCpp); else what its
    // own cash builds (amber too).
    const lifetimeOk = (p: Project) => opts.allowRed || opts.redOnly || projectedLifetimeCpp(state, p) <= opts.loanLifetimeCpp;
    let project = room > 0 ? chooseProject(state, Math.max(0, own) + room, opts, loanBand(opts), true, lifetimeOk) : null;
    if (!project && own > 0) project = chooseProject(state, own, opts);
    if (!project) {
      memo.idleKey = key;
      break;
    }
    if (project.cost + project.connect > own && !borrowFor(state, send, opts, project, own, room)) break;
    if (!buildProject(state, send, project)) break;
  }
  // Installs and the build just ordered may leave cash under the floor: the line covers the gap.
  if (opts.borrow) manageCredit(state, send, opts);
}

export function smartBot(options: Partial<SmartOptions> = {}): BotFactory {
  const opts: SmartOptions = { ...SMART_DEFAULTS, ...options };
  return () => {
    const memo = { idleKey: null as string | null };
    return { name: opts.name, act: (state, send) => smartAct(state, send, opts, memo) };
  };
}

// ---------------------------------------------------------------------------
// ALL_AERIAL / ALL_UNDERGROUND (round 4)
// ---------------------------------------------------------------------------

/** SMART, but aerial wherever the street has poles and never a rebuild: the storm-exposed operator. */
export const ALL_AERIAL_OPTIONS: Partial<SmartOptions> = { methods: 'aerial', convert: false, name: 'all-aerial' };
/** SMART, but underground everywhere: the operator who pays up front for durable plant. */
export const ALL_UNDERGROUND_OPTIONS: Partial<SmartOptions> = { methods: 'underground', convert: false, name: 'all-underground' };

export function allAerialBot(options: Partial<SmartOptions> = {}): BotFactory {
  return smartBot({ ...ALL_AERIAL_OPTIONS, ...options });
}

export function allUndergroundBot(options: Partial<SmartOptions> = {}): BotFactory {
  return smartBot({ ...ALL_UNDERGROUND_OPTIONS, ...options });
}

// ---------------------------------------------------------------------------
// PRICE_HIKER (round 4)
// ---------------------------------------------------------------------------

/** Share every offered tier's price rises by at each hike. */
export const PRICE_HIKE_SHARE = 0.15;
/** Month closes between hikes (the first after this many closes). */
export const PRICE_HIKE_EVERY_MONTHS = 6;

/**
 * SMART, but every PRICE_HIKE_EVERY_MONTHS closes it raises every offered
 * tier by PRICE_HIKE_SHARE (rounded, at most TIER_PRICE_MAX), grandfathered
 * for `grandfatherMonths` (undefined: the game's default; 0: at the next bill).
 */
export function priceHikerBot(grandfatherMonths?: number, options: Partial<SmartOptions> = {}): BotFactory {
  const name = grandfatherMonths === undefined ? 'price-hiker' : `price-hiker-${grandfatherMonths}`;
  const smart = smartBot({ name, ...options });
  return (seed) => {
    const inner = smart(seed);
    let lastHike = 0;
    return {
      name,
      act(state, send) {
        const closes = state.finance.reports.length;
        if (closes >= lastHike + PRICE_HIKE_EVERY_MONTHS) {
          lastHike = closes;
          const { pricing } = state.sales;
          send({
            type: 'setPricing',
            tiers: pricing.tiers.map((t) => ({
              id: t.id,
              price: t.offered ? Math.min(TIER_PRICE_MAX, Math.round(t.price * (1 + PRICE_HIKE_SHARE))) : t.price,
              offered: t.offered,
            })),
            smbMultiplier: pricing.smbMultiplier,
            ...(grandfatherMonths === undefined ? {} : { grandfatherMonths }),
          });
        }
        inner.act(state, send);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// RURAL (red cost per passing, borrowing by SMART's rules)
// ---------------------------------------------------------------------------

/**
 * The rural-heavy operator: SMART's covenant buffers, but it builds only red
 * (rural) cabinet areas, judged on each project's own cost per passing, and
 * borrows for them whenever the buffers allow (even with its reserve short),
 * so its lifetime cost per passing is red while it borrows. Rural lanes are
 * long and sparse, so it accepts small areas and expensive streets. A red-only
 * network never covers the overhead, so it bleeds: its rate is the point.
 */
export const RURAL_OPTIONS: Partial<SmartOptions> = {
  redOnly: true,
  borrowWhenShort: true,
  minNewUnits: 10,
  maxStreetCpp: Infinity,
  name: 'rural',
};

export function ruralBot(options: Partial<SmartOptions> = {}): BotFactory {
  return smartBot({ ...RURAL_OPTIONS, ...options });
}

// ---------------------------------------------------------------------------
// LEVERED (borrows to the limit)
// ---------------------------------------------------------------------------

/** The levered operator's marketing, dollars per passing per month (heavy: SMART runs SMART_MARKETING_PER_PASSING). */
export const LEVERED_MARKETING_PER_PASSING = 6;

/**
 * The levered operator: SMART's project picker with amber and red areas,
 * heavy marketing, and every dollar the bank offers. Until the bank lends at
 * all (no revenue yet) it keeps SMART's runway, or it would simply run out of
 * cash before borrowing (CARELESS's story); from then on its reserve is
 * opts.reserveMonths of fixed costs and opts.installDays of installs, with
 * nothing kept for debt service.
 */
export const LEVERED_OPTIONS: Partial<SmartOptions> = {
  marketingPerPassing: LEVERED_MARKETING_PER_PASSING,
  borrow: false,
  allowRed: true,
  reserveMonths: 1,
  installDays: 60,
  promoMarketingPerPassing: 0,
  name: 'levered',
};

/** Take every term loan the bank allows (the longest term) and the whole credit line, covenants and warnings ignored. True if it borrowed. */
function borrowEverything(state: GameState, send: Send): boolean {
  let borrowed = false;
  const capacity = termCapacity(state);
  if (capacity >= TERM_LOAN_MIN) borrowed = send({ type: 'takeTermLoan', amount: capacity, termYears: TERM_LOAN_YEARS.at(-1) as TermYears }).ok;
  const available = creditAvailable(state);
  if (available > 0) borrowed = send({ type: 'drawCredit', amount: available }).ok || borrowed;
  return borrowed;
}

export function leveredBot(options: Partial<SmartOptions> = {}): BotFactory {
  const opts: SmartOptions = { ...SMART_DEFAULTS, ...LEVERED_OPTIONS, ...options };
  return () => {
    const memo = { idleKey: null as string | null };
    let lending = false;
    return {
      name: opts.name,
      act(state, send) {
        // Heavy marketing, even while installs are paused (it never holds back).
        const budget = Math.min(MARKETING_MAX_PER_MONTH, Math.round(opts.marketingPerPassing * getService(state).passings));
        if (budget !== state.sales.marketingPerMonth) send({ type: 'setMarketing', perMonth: budget });

        const capacity = termCapacity(state);
        const available = creditAvailable(state);
        borrowEverything(state, send);
        lending ||= capacity > 0 || available > 0;

        addCapacity(state, send, opts);
        for (let i = 0; i < opts.maxProjectsPerLook; i++) {
          const reserve = lending
            ? opts.reserveMonths * fixedCosts(state) + expectedInstalls(state, opts.installDays, opts.marketingPerPassing)
            : smartReserve(state, SMART_DEFAULTS);
          const own = state.finance.cash - reserve;
          if (own <= 0) return;
          const key = `${state.network.version}:${Math.floor(state.day / 28)}:${Math.floor(own / 25_000)}`;
          if (memo.idleKey === key) return;
          const project = chooseProject(state, own, opts);
          if (!project) {
            memo.idleKey = key;
            return;
          }
          if (!buildProject(state, send, project)) return;
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// FROZEN_HOARDER (round 4)
// ---------------------------------------------------------------------------

export interface HoarderOptions {
  /**
   * Build with the hoard (SMART's project picker) while keeping only
   * HOARDER_SERVICE_MONTHS of scheduled debt service in cash: the round-3
   * exploit of a frozen line. False: build nothing once it has borrowed.
   */
  spendHoard: boolean;
}

/** Months of scheduled debt service the spending hoarder keeps (a year: enough to pay every close of a frozen line). */
export const HOARDER_SERVICE_MONTHS = 12;

/**
 * The careful operator without loans until the bank lends at all; from then
 * on every dollar the bank offers whenever it offers any (LEVERED's
 * borrowing), never repaying by choice. It stops building and sits on the
 * cash (marketing and splitters only), or with { spendHoard: true } builds
 * with it. Under the round-4 rules the frozen line's sweep and the call make
 * it repay everything or default.
 */
export function frozenHoarderBot(options: Partial<HoarderOptions> & Partial<SmartOptions> = {}): BotFactory {
  const spendHoard = options.spendHoard ?? false;
  const opts: SmartOptions = {
    ...SMART_DEFAULTS,
    borrow: false,
    convert: false,
    name: spendHoard ? 'hoarder-spender' : 'frozen-hoarder',
    ...options,
  };
  return () => {
    const memo = { idleKey: null as string | null };
    let borrowed = false;
    return {
      name: opts.name,
      act(state, send) {
        borrowed = borrowEverything(state, send) || borrowed;
        if (!borrowed) {
          smartAct(state, send, opts, memo);
          return;
        }
        const budget = marketingBudget(state, opts);
        if (budget !== state.sales.marketingPerMonth) send({ type: 'setMarketing', perMonth: budget });
        addCapacity(state, send, opts);
        if (!spendHoard) return;
        for (let i = 0; i < opts.maxProjectsPerLook; i++) {
          const reserve = HOARDER_SERVICE_MONTHS * estimateNextDebtService(state) + opts.reserveMonths * fixedCosts(state);
          const own = state.finance.cash - reserve;
          if (own <= 0) return;
          const key = `${state.network.version}:${Math.floor(state.day / 28)}:${Math.floor(own / 25_000)}`;
          if (memo.idleKey === key) return;
          const project = chooseProject(state, own, opts);
          if (!project) {
            memo.idleKey = key;
            return;
          }
          if (!buildProject(state, send, project)) return;
        }
      },
    };
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
 * One random financing command (sometimes junk the sim must reject): draw on
 * or repay the credit line, take a term loan, prepay one.
 */
function randomDebtCommand(state: GameState, send: Send, rng: Rng): void {
  const { credit, loans } = state.debt;
  const roll = rng.next();
  if (roll < 0.3) {
    const available = creditAvailable(state);
    const amount = available > 0 && rng.chance(0.85) ? rng.int(1, available) : available + rng.int(1, 50_000);
    send({ type: 'drawCredit', amount });
  } else if (roll < 0.55) {
    const amount = credit.balance > 0 && rng.chance(0.85) ? rng.int(1, credit.balance) : credit.balance + rng.int(1, 50_000);
    send({ type: 'repayCredit', amount });
  } else if (roll < 0.75) {
    const capacity = termCapacity(state);
    const amount = capacity >= TERM_LOAN_MIN && rng.chance(0.85) ? rng.int(TERM_LOAN_MIN, capacity) : capacity + rng.int(1, 50_000);
    send({ type: 'takeTermLoan', amount, termYears: rng.pick(TERM_LOAN_YEARS) });
  } else if (roll < 0.92) {
    if (loans.length === 0) {
      send({ type: 'prepayLoan', loan: rng.int(1, 5), amount: rng.int(1, 10_000) });
    } else {
      const loan = rng.pick(loans);
      const amount = rng.chance(0.3) ? loan.balance : rng.int(1, loan.balance);
      send({ type: 'prepayLoan', loan: loan.id, amount });
    }
  } else {
    // Junk: fractions, negatives, an unknown term.
    const junk = rng.int(0, 3);
    if (junk === 0) send({ type: 'drawCredit', amount: -rng.int(1, 1_000) });
    else if (junk === 1) send({ type: 'repayCredit', amount: 0.5 });
    else if (junk === 2) send({ type: 'takeTermLoan', amount: 50_000, termYears: 6 as TermYears });
    else send({ type: 'prepayLoan', loan: -1, amount: 1.5 });
  }
}

/**
 * A random price change (round 4 too): prices up or down (sometimes out of
 * range: rejected), some tiers retired (at least one stays offered unless the
 * draw is junk), the SMB multiplier, and a grandfathering period of 0 to
 * GRANDFATHER_MONTHS_MAX months, the default (omitted), or junk.
 */
function randomPricing(send: Send, rng: Rng): void {
  const tiers = TIER_DEFAULTS.map((t) => ({
    id: t.id,
    price: rng.chance(0.9) ? rng.int(TIER_PRICE_MIN, Math.min(TIER_PRICE_MAX, t.price * 2)) : TIER_PRICE_MAX + 1,
    offered: t.id === 'fiber1g' || rng.chance(0.7),
  }));
  const roll = rng.next();
  const grandfather =
    roll < 0.35 ? {} : roll < 0.9 ? { grandfatherMonths: rng.int(0, GRANDFATHER_MONTHS_MAX) } : { grandfatherMonths: rng.chance(0.5) ? -1 : 2.5 };
  send({ type: 'setPricing', tiers, smbMultiplier: 1 + rng.int(0, 20) / 10, ...grandfather });
}

/** A random intro promo: none, a valid one, or junk the sim must reject. */
function randomPromo(send: Send, rng: Rng): void {
  const roll = rng.next();
  if (roll < 0.35) send({ type: 'setPromo', promo: null });
  else if (roll < 0.9) send({ type: 'setPromo', promo: { percentOff: rng.int(1, PROMO_MAX_PERCENT_OFF), months: rng.int(1, PROMO_MAX_MONTHS) } });
  else send({ type: 'setPromo', promo: { percentOff: PROMO_MAX_PERCENT_OFF + rng.int(1, 50), months: 0 } });
}

/** Rebuild a random live aerial span underground (sometimes a span that cannot be: rejected). */
function randomConvert(state: GameState, send: Send, rng: Rng): void {
  const aerial = state.network.spans.filter((s) => s.stage === 'live' && s.method === 'aerial' && s.conversion === null);
  if (aerial.length > 0 && rng.chance(0.85)) send({ type: 'convertSpan', span: rng.pick(aerial).id });
  else if (state.network.spans.length > 0) send({ type: 'convertSpan', span: rng.pick(state.network.spans).id });
  else send({ type: 'convertSpan', span: -1 });
}

/**
 * SMART plus, each weekly look, a few random extras from its own Rng: cancel
 * or remove a span (any stage), remove a cabinet, add a splitter or an OLT
 * card, change prices (randomPricing) or the marketing budget, set an intro
 * promo (randomPromo), rebuild a span underground (randomConvert), a
 * financing command (randomDebtCommand), or send junk the sim must reject.
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
          if (rng.chance(0.25)) {
            randomDebtCommand(state, send, rng);
            continue;
          }
          const roll = rng.next();
          const { spans, cabinets } = state.network;
          if (roll < 0.16 && spans.length > 0) {
            // Prefer cancelling something still in permitting (refund), sometimes live cable.
            const permitting = spans.filter((s) => s.stage === 'permitting');
            const pool = permitting.length > 0 && rng.chance(0.7) ? permitting : spans;
            send({ type: 'removeSpan', span: rng.pick(pool).id });
          } else if (roll < 0.24 && cabinets.length > 1) {
            send({ type: 'removeCabinet', cabinet: rng.pick(cabinets).id });
          } else if (roll < 0.36 && cabinets.length > 0) {
            send({ type: 'addSplitter', cabinet: rng.pick(cabinets).id });
          } else if (roll < 0.42) {
            send({ type: 'addOltCard' });
          } else if (roll < 0.56) {
            randomPricing(send, rng);
          } else if (roll < 0.63) {
            randomPromo(send, rng);
          } else if (roll < 0.7) {
            randomConvert(state, send, rng);
          } else if (roll < 0.83) {
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
