// Subscribers: daily signups on passed parcels toward a target take rate,
// installs (connect capex), splitter-port capacity, billing accruals, monthly
// churn, pricing and marketing commands.
//
// Owner: sim-economy workstream.
//
// Rules shared by every function here:
// - Pure sim: no DOM, Date or Math.random. Randomness only from the `rng`
//   argument, which callers take from state.rng.sales (withRng(state, 'sales')).
// - Arithmetic and Math.sqrt only (no Math.pow/log/exp/trig), so the same seed
//   and commands replay identically on every JS engine.
// - Deterministic iteration: segments ascending by id, parcels ascending by id,
//   tiers in TIER_IDS order, cabinets ascending by id.
// - Money is whole dollars at the point it is posted (round once, at posting).
//
// Product rules settled for round 2 (beyond the types.ts contract):
// - An apartment building (MDU) connects through ONE building router on ONE
//   splitter port, however many of its units subscribe (fiber to the building
//   demarc, the router distributes to the units). So an MDU account occupies
//   MDU_PORTS_PER_BUILDING port(s) and adding units to it needs no new port.
// - Installs pause while cash cannot cover the next install: the unit is not
//   connected and its demand simply waits (the take-rate gap is unchanged), so
//   signups resume on their own once cash recovers. One notice is raised when
//   installs pause and one when they resume (see INSTALL_NOTICE_KIND).

import {
  CHURN_MONTHLY_BASE,
  CHURN_MONTHLY_MAX,
  CHURN_PRICE_SENSITIVITY,
  INCUMBENT_DOWN_MBPS,
  INCUMBENT_PRICE,
  INCUMBENT_UP_MBPS,
  INSTALL_COST_HOME,
  INSTALL_COST_MDU_UNIT,
  INSTALL_COST_SMB,
  MARKETING_DEFAULT_PER_MONTH,
  MARKETING_HALF_SAT_PER_PASSING,
  MARKETING_MAX_BOOST,
  MARKETING_MAX_PER_MONTH,
  MDU_PORTS_PER_BUILDING,
  MDU_ROUTER_COST,
  SIGNUP_RAMP_PER_DAY,
  SMB_MULTIPLIER_DEFAULT,
  SMB_MULTIPLIER_MAX,
  SMB_MULTIPLIER_MIN,
  SPLIT_RATIO,
  SUPPORT_COST_PER_SUB_PER_MONTH,
  TAKE_PRICE_WEIGHT,
  TAKE_RATE_BASE,
  TAKE_RATE_KIND_FACTOR,
  TAKE_RATE_MAX,
  TAKE_RATE_MIN,
  TAKE_RATE_PER_ADVANTAGE,
  TAKE_SPEED_RATIO_CAP,
  TAKE_SPEED_WEIGHT,
  TAKE_UPLOAD_RATIO_CAP,
  TAKE_UPLOAD_WEIGHT,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
} from './balance';
import { dateOf, formatMonth } from './calendar';
import { formatMoney, groupThousands, postEntry, postEntryOn } from './finance';
import { getService } from './network';
import { postNotice } from './notices';
import type { Rng } from './rng';
import { cornerName } from './streets';
import type {
  Account,
  Cabinet,
  CabinetId,
  City,
  CommandResult,
  GameState,
  MonthAccrual,
  NoticeKind,
  ParcelKind,
  Pricing,
  Sales,
  ServiceSnapshot,
  Tier,
  TierId,
  TierSetting,
} from './types';

/** The tier lineup, in display (and Pricing.tiers) order. */
export const TIER_IDS: readonly TierId[] = TIER_DEFAULTS.map((t) => t.id);


/**
 * Notice kind used for the "installs paused" / "installs resumed" notices.
 * NoticeKind has no dedicated kinds for them yet (types.ts is frozen this
 * round), so they ride on the cash-trouble kind and are told apart by their
 * message prefixes below.
 */
export const INSTALL_NOTICE_KIND: NoticeKind = 'insolvencyWarning';
export const INSTALLS_PAUSED_PREFIX = 'Installs paused';
export const INSTALLS_RESUMED_PREFIX = 'Installs resumed';

/** Starting prices: TIER_DEFAULTS, every tier offered, SMB_MULTIPLIER_DEFAULT. */
export function defaultPricing(): Pricing {
  return {
    tiers: TIER_DEFAULTS.map((t) => ({
      id: t.id,
      name: t.name,
      downMbps: t.downMbps,
      upMbps: t.upMbps,
      price: t.price,
      offered: true,
    })),
    smbMultiplier: SMB_MULTIPLIER_DEFAULT,
  };
}

export function emptyMonthAccrual(): MonthAccrual {
  return { revenueDollarDays: 0, marketingDollarDays: 0, subscriberUnitDays: 0, grossAdds: 0, lostService: 0 };
}

/** Sales state for a new game (and for saves migrated from schemaVersion 1): no subscribers, default pricing and marketing. */
export function newSales(): Sales {
  return {
    pricing: defaultPricing(),
    marketingPerMonth: MARKETING_DEFAULT_PER_MONTH,
    accounts: [],
    routerParcels: [],
    connectsTotal: 0,
    fullCabinets: [],
    month: emptyMonthAccrual(),
  };
}

/** Subscribed units on an account (sum of tierUnits). */
export function accountUnits(account: Account): number {
  let units = 0;
  for (const id of TIER_IDS) units += account.tierUnits[id];
  return units;
}

/** Subscriber ports a cabinet's splitters provide: splitters x SPLIT_RATIO. */
export function cabinetPortCapacity(cabinet: Cabinet): number {
  return cabinet.splitters * SPLIT_RATIO;
}

// ---------------------------------------------------------------------------
// Take rate, tier mix, prices
// ---------------------------------------------------------------------------

const DEFAULT_PRICE: Readonly<Record<TierId, number>> = Object.fromEntries(
  TIER_DEFAULTS.map((t) => [t.id, t.price]),
) as Record<TierId, number>;

const POPULARITY: Readonly<Record<TierId, number>> = Object.fromEntries(
  TIER_DEFAULTS.map((t) => [t.id, t.popularity]),
) as Record<TierId, number>;

/** The incumbent's offer scored by the same value formula: every ratio is 1. */
const INCUMBENT_VALUE = TAKE_SPEED_WEIGHT + TAKE_UPLOAD_WEIGHT - TAKE_PRICE_WEIGHT;

/** A tier's value to a household (balance.ts take-rate model). */
function tierValue(tier: Tier): number {
  return (
    TAKE_SPEED_WEIGHT * Math.min(tier.downMbps / INCUMBENT_DOWN_MBPS, TAKE_SPEED_RATIO_CAP) +
    TAKE_UPLOAD_WEIGHT * Math.min(tier.upMbps / INCUMBENT_UP_MBPS, TAKE_UPLOAD_RATIO_CAP) -
    (TAKE_PRICE_WEIGHT * tier.price) / INCUMBENT_PRICE
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Target take rate (0..1) for a building kind under the given pricing, from the
 * model documented in balance.ts: the best offered tier's value against the
 * incumbent, clamped to TAKE_RATE_MIN..TAKE_RATE_MAX, times
 * TAKE_RATE_KIND_FACTOR[kind]. With no tier offered (impossible via setPricing)
 * returns 0.
 */
export function targetTakeRate(pricing: Pricing, kind: ParcelKind): number {
  let best = -Infinity;
  for (const tier of pricing.tiers) {
    if (tier.offered) best = Math.max(best, tierValue(tier) - INCUMBENT_VALUE);
  }
  if (best === -Infinity) return 0;
  return clamp(TAKE_RATE_BASE + TAKE_RATE_PER_ADVANTAGE * best, TAKE_RATE_MIN, TAKE_RATE_MAX) * TAKE_RATE_KIND_FACTOR[kind];
}

function zeroTiers(): Record<TierId, number> {
  const record = {} as Record<TierId, number>;
  for (const id of TIER_IDS) record[id] = 0;
  return record;
}

/**
 * Share of new signups choosing each tier (sums to 1 over offered tiers, 0 for
 * unoffered). Weight per offered tier = popularity_t x max(0, value_t -
 * incumbent value) (see balance.ts); if every weight is 0, offered tiers split
 * evenly.
 */
export function tierMix(pricing: Pricing): Record<TierId, number> {
  const mix = zeroTiers();
  let total = 0;
  let offered = 0;
  for (const tier of pricing.tiers) {
    if (!tier.offered) continue;
    offered++;
    const weight = (POPULARITY[tier.id] ?? 0) * Math.max(0, tierValue(tier) - INCUMBENT_VALUE);
    mix[tier.id] = weight;
    total += weight;
  }
  for (const tier of pricing.tiers) {
    if (!tier.offered) continue;
    mix[tier.id] = total > 0 ? mix[tier.id] / total : 1 / offered;
  }
  return mix;
}

function tierOf(pricing: Pricing, id: TierId): Tier {
  const tier = pricing.tiers.find((t) => t.id === id);
  if (!tier) throw new RangeError(`Unknown tier: ${String(id)}`);
  return tier;
}

/** Monthly price one unit of `kind` pays on tier `tier` (SMB: round(price x smbMultiplier)). */
export function unitPrice(pricing: Pricing, tier: TierId, kind: ParcelKind): number {
  const price = tierOf(pricing, tier).price;
  return kind === 'smb' ? Math.round(price * pricing.smbMultiplier) : price;
}

/**
 * Connect cost for one new unit of `kind`: INSTALL_COST_HOME, INSTALL_COST_SMB,
 * or INSTALL_COST_MDU_UNIT plus MDU_ROUTER_COST when the building's router is
 * not installed yet (`routerInstalled` false).
 */
export function installCost(kind: ParcelKind, routerInstalled: boolean): number {
  if (kind === 'home') return INSTALL_COST_HOME;
  if (kind === 'smb') return INSTALL_COST_SMB;
  return INSTALL_COST_MDU_UNIT + (routerInstalled ? 0 : MDU_ROUTER_COST);
}

/** Ports an account on a parcel of `kind` occupies: 1 for a home or business, MDU_PORTS_PER_BUILDING for an apartment building. */
function portsForKind(kind: ParcelKind): number {
  return kind === 'mdu' ? MDU_PORTS_PER_BUILDING : 1;
}

/**
 * Splitter ports an account occupies: 1 for a home or business; an apartment
 * building's router takes MDU_PORTS_PER_BUILDING (one) port however many of its
 * units subscribe (round-2 product decision).
 */
export function accountPorts(state: GameState, account: Account): number {
  const parcel = state.city.parcels[account.parcel];
  return portsForKind(parcel ? parcel.kind : 'home');
}

/** Ports in use per cabinet id (cabinets with no subscribers omitted). */
export function cabinetPortsUsed(state: GameState): Map<CabinetId, number> {
  const used = new Map<CabinetId, number>();
  for (const account of state.sales.accounts) {
    used.set(account.cabinet, (used.get(account.cabinet) ?? 0) + accountPorts(state, account));
  }
  return used;
}

/** Total subscribed units. */
export function subscriberUnits(state: GameState): number {
  let units = 0;
  for (const account of state.sales.accounts) units += accountUnits(account);
  return units;
}

/** Monthly price per unit, by parcel kind then tier, at today's prices. */
type PriceTable = Record<ParcelKind, Record<TierId, number>>;

function priceTable(pricing: Pricing): PriceTable {
  const table = { home: zeroTiers(), mdu: zeroTiers(), smb: zeroTiers() };
  for (const id of TIER_IDS) {
    table.home[id] = unitPrice(pricing, id, 'home');
    table.mdu[id] = unitPrice(pricing, id, 'mdu');
    table.smb[id] = unitPrice(pricing, id, 'smb');
  }
  return table;
}

/** Sum over every subscribed unit of its monthly price, and the units counted. */
function billableRate(state: GameState): { rate: number; units: number } {
  const prices = priceTable(state.sales.pricing);
  const parcels = state.city.parcels;
  let rate = 0;
  let units = 0;
  for (const account of state.sales.accounts) {
    const kind = parcels[account.parcel]?.kind ?? 'home';
    const row = prices[kind];
    for (const id of TIER_IDS) {
      const n = account.tierUnits[id];
      if (n === 0) continue;
      rate += n * row[id];
      units += n;
    }
  }
  return { rate, units };
}

/** What every current subscriber would pay for a full month at today's prices (HUD "MRR"). */
export function monthlyRecurringRevenue(state: GameState): number {
  return billableRate(state).rate;
}

// ---------------------------------------------------------------------------
// Per-City index (cities never change after generation)
// ---------------------------------------------------------------------------

interface CityIndex {
  /** Parcels served by segment s are parcelIds[segStart[s] .. segStart[s + 1]), ascending. */
  segStart: Int32Array;
  parcelIds: Int32Array;
  /** Segments that serve at least one parcel (present or future), ascending. */
  servingSegments: Int32Array;
}

const cityIndexes = new WeakMap<City, CityIndex>();

function cityIndex(city: City): CityIndex {
  const cached = cityIndexes.get(city);
  if (cached) return cached;
  const segCount = city.segments.length;
  // Counting sort of parcel ids by serving segment (ids stay ascending within a segment).
  const counts = new Array<number>(segCount + 1).fill(0);
  for (const parcel of city.parcels) {
    if (parcel.segment >= 0 && parcel.segment < segCount) counts[parcel.segment + 1] = (counts[parcel.segment + 1] as number) + 1;
  }
  for (let s = 0; s < segCount; s++) counts[s + 1] = (counts[s + 1] as number) + (counts[s] as number);
  const segStart = Int32Array.from(counts);
  const fill = counts.slice(0, segCount);
  const parcelIds = new Int32Array(counts[segCount] as number);
  for (const parcel of city.parcels) {
    if (parcel.segment < 0 || parcel.segment >= segCount) continue;
    const at = fill[parcel.segment] as number;
    parcelIds[at] = parcel.id;
    fill[parcel.segment] = at + 1;
  }
  const serving: number[] = [];
  for (let s = 0; s < segCount; s++) if ((segStart[s + 1] as number) > (segStart[s] as number)) serving.push(s);
  const index = { segStart, parcelIds, servingSegments: Int32Array.from(serving) };
  cityIndexes.set(city, index);
  return index;
}

// ---------------------------------------------------------------------------
// Daily step
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${groupThousands(n)} ${n === 1 ? one : many}`;
}

function cabinetPlace(state: GameState, cabinetId: CabinetId): string | null {
  const cabinet = state.network.cabinets.find((c) => c.id === cabinetId);
  return cabinet ? cornerName(state.city, cabinet.node) : null;
}

/**
 * Step 1 of stepSales: drop every account whose parcel is no longer passed or
 * whose cabinet is no longer active, and tell the player once per cabinet.
 */
function dropLostService(state: GameState, service: ServiceSnapshot): void {
  const { sales, city, day } = state;
  const accounts = sales.accounts;
  let kept: Account[] | null = null;
  let lost: Map<CabinetId, number> | null = null;
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i] as Account;
    const parcel = city.parcels[account.parcel];
    // Equivalent to membership in service.passedParcels (an existing parcel on a lit segment).
    const passed = parcel !== undefined && parcel.appearsDay <= day && service.litSegments.has(parcel.segment);
    if (passed && service.activeCabinets.has(account.cabinet)) {
      kept?.push(account);
      continue;
    }
    kept ??= accounts.slice(0, i);
    lost ??= new Map();
    lost.set(account.cabinet, (lost.get(account.cabinet) ?? 0) + accountUnits(account));
  }
  if (!kept || !lost) return;
  sales.accounts = kept;
  for (const [cabinet, units] of [...lost].sort(([a], [b]) => a - b)) {
    sales.month.lostService += units;
    const place = cabinetPlace(state, cabinet);
    const who = plural(units, 'subscriber', 'subscribers');
    const message = place
      ? `${who} lost service at ${place}: their cable or cabinet is no longer connected.`
      : `${who} lost service: their cabinet was removed.`;
    postNotice(state, 'serviceLost', message, { cabinet });
  }
}

/** Whether the newest install pause/resume notice still in the log is a pause. */
export function installsPaused(state: GameState): boolean {
  for (let i = state.notices.length - 1; i >= 0; i--) {
    const notice = state.notices[i];
    if (!notice || notice.kind !== INSTALL_NOTICE_KIND) continue;
    if (notice.message.startsWith(INSTALLS_PAUSED_PREFIX)) return true;
    if (notice.message.startsWith(INSTALLS_RESUMED_PREFIX)) return false;
  }
  return false;
}

interface InstallTally {
  home: number;
  smb: number;
  mdu: number;
  routers: number;
}

function installMemo(t: InstallTally): string {
  const parts: string[] = [];
  if (t.home > 0) parts.push(plural(t.home, 'home', 'homes'));
  if (t.smb > 0) parts.push(plural(t.smb, 'business', 'businesses'));
  if (t.mdu > 0) parts.push(plural(t.mdu, 'apartment', 'apartments'));
  const routers = t.routers > 0 ? ` + ${plural(t.routers, 'building router', 'building routers')}` : '';
  return `Installs: ${parts.join(', ')}${routers}`;
}

/**
 * Marketing boost to the signup ramp, with diminishing returns (balance.ts):
 * MARKETING_MAX_BOOST x m / (m + MARKETING_HALF_SAT_PER_PASSING x max(1, passings)).
 */
export function marketingBoost(marketingPerMonth: number, passings: number): number {
  const m = marketingPerMonth;
  const saturation = m + MARKETING_HALF_SAT_PER_PASSING * Math.max(1, passings);
  return m > 0 && saturation > 0 ? (MARKETING_MAX_BOOST * m) / saturation : 0;
}

/**
 * Fixed offset in [0, 1) per (game seed, segment), used to round a segment's
 * target to whole units: ceil(target - offset) is floor(target) plus one with
 * probability frac(target) over segments, never biased up, and never moves as
 * days pass (it is not a draw from the sales stream).
 */
export function segmentOffset(seed: number, segment: number): number {
  let h = (seed ^ Math.imul(segment + 1, 0x9e3779b1)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Pick an offered tier by the mix (one draw); null when nothing is offered. */
function pickTier(mix: Record<TierId, number>, rng: Rng): TierId | null {
  let r = rng.next();
  let last: TierId | null = null;
  for (const id of TIER_IDS) {
    const share = mix[id];
    if (share <= 0) continue;
    last = id;
    if (r < share) return id;
    r -= share;
  }
  return last;
}

/**
 * One day of sales, run by tick() after advanceNetwork for the new state.day
 * (never for day 0, never after game over). In order:
 *
 * 1. Lost service: drop every account whose parcel is no longer passed
 *    (getService(state).passedParcels) or whose cabinet is not an active
 *    cabinet any more; add its units to month.lostService. If any were
 *    dropped, post one 'serviceLost' notice per affected cabinet
 *    ("N subscribers lost service at <corner>").
 * 2. Signups: for each lit segment (ascending), with passed parcels P on it
 *    and serving cabinet C (service.servingCabinet):
 *      target = ceil(sum over P of targetTakeRate(pricing, kind) x units
 *                    - segmentOffset(seed, segment)), at least 0
 *               (whole units, rounded without bias; the plain sum made every
 *               street settle at its rounded-up target, e.g. a one-home
 *               street near 100% instead of the take rate)
 *      gap    = max(0, target - subscribed units on P)
 *      boost  = MARKETING_MAX_BOOST x m / (m + MARKETING_HALF_SAT_PER_PASSING x max(1, passings))
 *      expect = gap x SIGNUP_RAMP_PER_DAY x (1 + boost)
 *      n      = floor(expect) + (rng.chance(expect - floor(expect)) ? 1 : 0),
 *               capped at the unsubscribed units on P (skip the draw when gap is 0).
 *    (passings = getService(state).passings; m = marketingPerMonth.)
 *    Each new unit: pick a parcel on the segment weighted by its unsubscribed
 *    units, pick a tier by tierMix (rng), and connect it unless C has no free
 *    port (cabinetPortCapacity - ports used; an apartment building that already
 *    has an account needs no new port: its router already holds one); a
 *    blocked unit is not connected and marks C full for today. Next, a unit
 *    whose install cost cash (net of today's installs so far) cannot cover is
 *    not connected either and pauses installs for the rest of the day (its
 *    demand waits). Connecting creates or extends the parcel's Account
 *    (cabinet = C, since = state.day), charges installCost (router once per
 *    MDU: add to routerParcels), adds it to finance.capex.connect,
 *    sales.connectsTotal and month.grossAdds. Install spend posts as at most
 *    one 'install' ledger entry per day (memo like "Installs: 3 homes,
 *    1 business, 2 apartments + 1 building router"). A day that pauses
 *    installs posts an "Installs paused" notice unless they were already
 *    paused; the first day an install connects after a pause posts
 *    "Installs resumed".
 * 3. Accruals for the day (after signups): month.revenueDollarDays += the
 *    monthly rate of every subscribed unit (unitPrice per tier and kind);
 *    month.marketingDollarDays += marketingPerMonth; month.subscriberUnitDays +=
 *    subscribed units.
 * 4. fullCabinets := cabinets marked full today (sorted); post a 'cabinetFull'
 *    notice for each cabinet not in the previous list. Besides a blocked
 *    unit, a cabinet is marked full when demand left waiting on its segments
 *    (min(gap left, ports its open parcels without an account would take))
 *    finds no free port for a new account, and a cabinet already listed stays
 *    while that waiting demand exceeds its free ports. Without this, a full
 *    cabinet would drop out of the list on every day nobody happened to try
 *    to sign up (most days on a small area) and re-announce itself.
 */
export function stepSales(state: GameState, rng: Rng): void {
  const service = getService(state);
  dropLostService(state, service);

  const { city, sales, finance, day } = state;
  const parcels = city.parcels;
  const index = cityIndex(city);
  const pricing = sales.pricing;
  const take: Record<ParcelKind, number> = {
    home: targetTakeRate(pricing, 'home'),
    mdu: targetTakeRate(pricing, 'mdu'),
    smb: targetTakeRate(pricing, 'smb'),
  };
  const mix = tierMix(pricing);
  const m = sales.marketingPerMonth;
  const ramp = SIGNUP_RAMP_PER_DAY * (1 + marketingBoost(m, service.passings));

  const accounts = sales.accounts;
  // Index into `accounts` per parcel (-1: no account).
  const accountAt = new Int32Array(parcels.length).fill(-1);
  for (let i = 0; i < accounts.length; i++) accountAt[(accounts[i] as Account).parcel] = i;
  const subscribedAt = (parcelId: number): number => {
    const at = accountAt[parcelId] as number;
    return at >= 0 ? accountUnits(accounts[at] as Account) : 0;
  };

  let portsUsed: Map<CabinetId, number> | null = null;
  const cabinetsById = new Map<CabinetId, Cabinet>();
  for (const cabinet of state.network.cabinets) cabinetsById.set(cabinet.id, cabinet);
  /** Splitter ports still free on a cabinet (0 for an unknown one). */
  const freePorts = (cabinetId: CabinetId): number => {
    portsUsed ??= cabinetPortsUsed(state);
    const cabinet = cabinetsById.get(cabinetId);
    return (cabinet ? cabinetPortCapacity(cabinet) : 0) - (portsUsed.get(cabinetId) ?? 0);
  };
  const routers = new Set(sales.routerParcels);
  const fullToday = new Set<CabinetId>();
  // Per serving cabinet: ports its remaining demand could still take today,
  // and the fewest ports any one waiting new account needs.
  const portDemand = new Map<CabinetId, number>();
  const minNewPorts = new Map<CabinetId, number>();
  const tally: InstallTally = { home: 0, smb: 0, mdu: 0, routers: 0 };
  let spend = 0;
  let connected = 0;
  let addedAccount = false;
  let addedRouter = false;
  let cashBlockedCost: number | null = null;

  for (const seg of index.servingSegments) {
    if (!service.litSegments.has(seg)) continue;
    const server = service.servingCabinet.get(seg);
    if (server === undefined) continue;
    const from = index.segStart[seg] as number;
    const to = index.segStart[seg + 1] as number;

    let target = 0;
    let subscribed = 0;
    let open = 0;
    // Ports the open parcels without an account would take, and the fewest one needs.
    let newPorts = 0;
    let fewestPorts = Infinity;
    for (let k = from; k < to; k++) {
      const parcel = parcels[index.parcelIds[k] as number];
      if (!parcel || parcel.appearsDay > day) continue;
      const sub = subscribedAt(parcel.id);
      target += take[parcel.kind] * parcel.units;
      subscribed += sub;
      open += Math.max(0, parcel.units - sub);
      if (sub === 0 && parcel.units > 0) {
        const ports = portsForKind(parcel.kind);
        newPorts += ports;
        fewestPorts = Math.min(fewestPorts, ports);
      }
    }
    // Whole units, rounded with this segment's fixed offset: unbiased, so a
    // one-home street settles near the take rate instead of always signing up.
    target = Math.max(0, Math.ceil(target - segmentOffset(state.seed, seg)));
    const gap = target - subscribed;
    if (gap <= 0 || open <= 0) continue;
    let connectedHere = 0;
    let portsTakenHere = 0;

    const expect = gap * ramp;
    const whole = Math.floor(expect);
    const n = Math.min(open, whole + (rng.chance(expect - whole) ? 1 : 0));

    for (let u = 0; u < n; u++) {
      // A parcel weighted by its unsubscribed units.
      let r = rng.next() * open;
      let chosen = -1;
      for (let k = from; k < to; k++) {
        const parcel = parcels[index.parcelIds[k] as number];
        if (!parcel || parcel.appearsDay > day) continue;
        const free = parcel.units - subscribedAt(parcel.id);
        if (free <= 0) continue;
        chosen = parcel.id;
        if (r < free) break;
        r -= free;
      }
      const tier = pickTier(mix, rng);
      if (chosen < 0 || tier === null) continue;
      const parcel = parcels[chosen]!;
      const existing = accountAt[chosen] as number;

      // Ports: a new account needs its ports on the serving cabinet; more units
      // in a building that already has an account ride on its router's port.
      if (existing < 0 && freePorts(server) < portsForKind(parcel.kind)) {
        fullToday.add(server);
        continue;
      }

      // Cash: installs pause while cash cannot cover the next one.
      const cost = installCost(parcel.kind, routers.has(chosen));
      if (cashBlockedCost !== null) continue;
      if (cost > finance.cash - spend) {
        cashBlockedCost = cost;
        continue;
      }

      if (existing >= 0) {
        (accounts[existing] as Account).tierUnits[tier] += 1;
      } else {
        const tierUnits = zeroTiers();
        tierUnits[tier] = 1;
        accountAt[chosen] = accounts.length;
        accounts.push({ parcel: chosen, cabinet: server, tierUnits, since: day });
        addedAccount = true;
        portsUsed ??= cabinetPortsUsed(state);
        portsUsed.set(server, (portsUsed.get(server) ?? 0) + portsForKind(parcel.kind));
        portsTakenHere += portsForKind(parcel.kind);
      }
      if (parcel.kind === 'mdu' && !routers.has(chosen)) {
        routers.add(chosen);
        addedRouter = true;
        tally.routers++;
      }
      tally[parcel.kind]++;
      spend += cost;
      connected++;
      connectedHere++;
      open--;
      finance.capex.connect += cost;
      sales.connectsTotal += 1;
      sales.month.grossAdds += 1;
    }

    // Demand still waiting here that needs new ports on the server.
    const waiting = Math.min(gap - connectedHere, newPorts - portsTakenHere);
    if (waiting > 0) {
      portDemand.set(server, (portDemand.get(server) ?? 0) + waiting);
      minNewPorts.set(server, Math.min(minNewPorts.get(server) ?? Infinity, fewestPorts));
    }
  }

  if (addedAccount) accounts.sort((a, b) => a.parcel - b.parcel);
  if (addedRouter) sales.routerParcels = [...routers].sort((a, b) => a - b);
  if (spend > 0) postEntry(state, 'install', -spend, installMemo(tally));

  if (cashBlockedCost !== null) {
    if (!installsPaused(state)) {
      postNotice(
        state,
        INSTALL_NOTICE_KIND,
        `${INSTALLS_PAUSED_PREFIX}: cash can't cover the next install (${formatMoney(cashBlockedCost)}). ` +
          'New customers will wait and be connected once cash recovers.',
      );
    }
  } else if (connected > 0 && installsPaused(state)) {
    postNotice(state, INSTALL_NOTICE_KIND, `${INSTALLS_RESUMED_PREFIX}: cash covers installs again, and waiting customers are being connected.`);
  }

  // 3. Accruals, after today's signups.
  const { rate, units } = billableRate(state);
  sales.month.revenueDollarDays += rate;
  sales.month.marketingDollarDays += m;
  sales.month.subscriberUnitDays += units;

  // 4. Cabinets turning signups away: a cabinet becomes full when it has no
  // room for a waiting new account, and stays full while the demand waiting
  // on it needs more ports than it has free (so a port freed by churn does not
  // make it flicker out of the list and announce itself again).
  const previous = new Set(sales.fullCabinets);
  for (const [cabinetId, demand] of portDemand) {
    const free = freePorts(cabinetId);
    const full = previous.has(cabinetId) ? demand > free : free < (minNewPorts.get(cabinetId) ?? 1);
    if (full) fullToday.add(cabinetId);
  }
  sales.fullCabinets = [...fullToday].sort((a, b) => a - b);
  for (const cabinetId of sales.fullCabinets) {
    if (previous.has(cabinetId)) continue;
    const place = cabinetPlace(state, cabinetId) ?? 'a cabinet';
    postNotice(state, 'cabinetFull', `Cabinet at ${place} is full: add a splitter to keep signing up customers.`, {
      cabinet: cabinetId,
    });
  }
}

// ---------------------------------------------------------------------------
// Month close
// ---------------------------------------------------------------------------

/** What the sales part of a month close posted and counted. */
export interface SalesClose {
  revenue: number;
  marketing: number;
  support: number;
  /** Subscriber-days billed in the month (month.subscriberUnitDays before the reset). */
  subscriberDays: number;
  grossAdds: number;
  churned: number;
  lostService: number;
}

/** Monthly churn probability for a unit on `tier` at its current household price. */
export function churnProbability(tier: Tier): number {
  const base = DEFAULT_PRICE[tier.id] ?? tier.price;
  const over = base > 0 ? Math.max(0, tier.price - base) / base : 0;
  return Math.min(CHURN_MONTHLY_MAX, CHURN_MONTHLY_BASE * (1 + CHURN_PRICE_SENSITIVITY * over));
}

/**
 * Sales part of a month close, called by finance.closeMonth (before the report
 * is built) with the ended month's length in days and its last day (the date
 * every entry is posted on). In order:
 * 1. 'revenue' +round(month.revenueDollarDays / daysInMonth) (skip if 0), memo
 *    "Subscriber billing for Mar 2027: 412 subscribers".
 * 2. 'marketing' -round(month.marketingDollarDays / daysInMonth) (skip if 0).
 * 3. 'overhead' -round(SUPPORT_COST_PER_SUB_PER_MONTH x month.subscriberUnitDays / daysInMonth) (skip if 0), memo "Customer support".
 * 4. Churn: every subscribed unit (accounts ascending, tiers in TIER_IDS order)
 *    cancels with probability min(CHURN_MONTHLY_MAX, CHURN_MONTHLY_BASE x (1 +
 *    CHURN_PRICE_SENSITIVITY x max(0, price - default price) / default price))
 *    using its tier's household price; accounts left with 0 units are removed
 *    (routers stay in routerParcels).
 * 5. Reset `month` to emptyMonthAccrual() and return the figures (subscriber
 *    days, grossAdds and lostService from the accrual before the reset).
 */
export function closeSalesMonth(state: GameState, rng: Rng, daysInMonth: number, lastDay: number): SalesClose {
  if (!Number.isInteger(daysInMonth) || daysInMonth <= 0) throw new RangeError(`closeSalesMonth: bad month length ${daysInMonth}`);
  const { sales } = state;
  const month = sales.month;
  const ended = dateOf(lastDay);
  const label = formatMonth(ended.year, ended.month);

  const revenue = Math.round(month.revenueDollarDays / daysInMonth);
  if (revenue !== 0) {
    const subs = plural(subscriberUnits(state), 'subscriber', 'subscribers');
    postEntryOn(state, lastDay, 'revenue', revenue, `Subscriber billing for ${label}: ${subs}`);
  }
  const marketing = Math.round(month.marketingDollarDays / daysInMonth);
  if (marketing !== 0) postEntryOn(state, lastDay, 'marketing', -marketing, `Marketing for ${label}`);
  const support = Math.round((SUPPORT_COST_PER_SUB_PER_MONTH * month.subscriberUnitDays) / daysInMonth);
  if (support !== 0) postEntryOn(state, lastDay, 'overhead', -support, 'Customer support');

  const churnP = zeroTiers();
  for (const tier of sales.pricing.tiers) churnP[tier.id] = churnProbability(tier);
  let churned = 0;
  let emptied = false;
  for (const account of sales.accounts) {
    for (const id of TIER_IDS) {
      const units = account.tierUnits[id];
      let left = units;
      for (let u = 0; u < units; u++) if (rng.chance(churnP[id])) left--;
      churned += units - left;
      account.tierUnits[id] = left;
    }
    if (accountUnits(account) === 0) emptied = true;
  }
  if (emptied) sales.accounts = sales.accounts.filter((a) => accountUnits(a) > 0);

  const result: SalesClose = {
    revenue,
    marketing,
    support,
    subscriberDays: month.subscriberUnitDays,
    grossAdds: month.grossAdds,
    churned,
    lostService: month.lostService,
  };
  sales.month = emptyMonthAccrual();
  return result;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function reject(reason: string): CommandResult {
  return { ok: false, reason };
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

/**
 * setPricing command. Rejects (state untouched) unless `tiers` names every
 * TierId exactly once, every price is an integer in TIER_PRICE_MIN..
 * TIER_PRICE_MAX, at least one tier is offered, and smbMultiplier is finite in
 * SMB_MULTIPLIER_MIN..SMB_MULTIPLIER_MAX. On success replaces each tier's price
 * and offered flag (names and speeds never change) and the multiplier, keeps
 * Pricing.tiers in TIER_IDS order, and returns { ok: true, cost: 0 }. Existing
 * subscribers keep their tier; new prices bill from the next daily accrual.
 */
export function setPricing(state: GameState, tiers: readonly TierSetting[], smbMultiplier: number): CommandResult {
  if (!Array.isArray(tiers)) return reject('setPricing needs a list of tiers');
  const settings = new Map<TierId, TierSetting>();
  for (const raw of tiers as readonly unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return reject('setPricing needs a list of tiers, each { id, price, offered }');
    }
    const setting = raw as Record<string, unknown>;
    const id = setting.id;
    if (typeof id !== 'string' || !TIER_IDS.includes(id as TierId)) return reject(`Unknown tier: ${describeValue(id)}`);
    const tierId = id as TierId;
    const name = tierOf(state.sales.pricing, tierId).name;
    if (settings.has(tierId)) return reject(`The ${name} tier is listed twice`);
    const price = setting.price;
    if (typeof price !== 'number' || !Number.isInteger(price) || price < TIER_PRICE_MIN || price > TIER_PRICE_MAX) {
      return reject(
        `The ${name} price must be a whole number of dollars from ${formatMoney(TIER_PRICE_MIN)} to ${formatMoney(TIER_PRICE_MAX)}, got ${describeValue(price)}`,
      );
    }
    if (typeof setting.offered !== 'boolean') return reject(`The ${name} tier needs offered: true or false`);
    settings.set(tierId, { id: tierId, price, offered: setting.offered });
  }
  const missing = TIER_IDS.filter((id) => !settings.has(id)).map((id) => tierOf(state.sales.pricing, id).name);
  if (missing.length > 0) return reject(`setPricing must list every tier; missing ${missing.join(', ')}`);
  if (![...settings.values()].some((t) => t.offered)) return reject('Offer at least one tier');
  if (
    typeof smbMultiplier !== 'number' ||
    !Number.isFinite(smbMultiplier) ||
    smbMultiplier < SMB_MULTIPLIER_MIN ||
    smbMultiplier > SMB_MULTIPLIER_MAX
  ) {
    return reject(
      `The business price multiplier must be from ${SMB_MULTIPLIER_MIN} to ${SMB_MULTIPLIER_MAX}, got ${describeValue(smbMultiplier)}`,
    );
  }

  const pricing = state.sales.pricing;
  // Keep TIER_IDS order whatever order the command listed them in.
  pricing.tiers = TIER_IDS.map((id) => {
    const tier = tierOf(pricing, id);
    const setting = settings.get(id) as TierSetting;
    return { ...tier, price: setting.price, offered: setting.offered };
  });
  pricing.smbMultiplier = smbMultiplier;
  return { ok: true, cost: 0 };
}

/**
 * setMarketing command: perMonth must be an integer in
 * 0..MARKETING_MAX_PER_MONTH (else reject, state untouched). Sets
 * marketingPerMonth; returns { ok: true, cost: 0 } (spend accrues daily).
 */
export function setMarketing(state: GameState, perMonth: number): CommandResult {
  if (typeof perMonth !== 'number' || !Number.isInteger(perMonth) || perMonth < 0 || perMonth > MARKETING_MAX_PER_MONTH) {
    return reject(
      `The marketing budget must be a whole number of dollars from $0 to ${formatMoney(MARKETING_MAX_PER_MONTH)} a month, got ${describeValue(perMonth)}`,
    );
  }
  state.sales.marketingPerMonth = perMonth;
  return { ok: true, cost: 0 };
}
