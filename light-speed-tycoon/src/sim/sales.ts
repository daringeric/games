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
//   signups resume on their own once cash recovers. One 'installsPaused'
//   notice is raised when installs pause and one 'installsResumed' when they
//   resume; Sales.installsPaused remembers which (the notice log is capped).
//
// Round 4 (sim-pricing workstream): pricing realism.
// - Price locks (Account.locks): a unit on a locked tier pays min(lock price,
//   list price) until the close its lock ends (accountUnitPrice). setPricing
//   grandfathers a rise for today's subscribers ('grandfather', or 'notice'
//   with grandfatherMonths 0), the intro promo locks a discount for new
//   signups ('promo'), and a cut reaches everyone at once (locks at or above
//   the new list price are dropped). When a lock ends at a close the unit's
//   price steps up to the list price, with a one-off churn by the size of the
//   rise (stepChurnProbability).
// - An intro promo (Sales.promo, setPromo) is only offered on a tier an
//   account has no units on yet: an apartment building's next unit on a tier
//   it already subscribes to joins what the building pays there (its lock, or
//   the list price), so a standing promo never re-discounts a whole building.
// - A tier no longer offered moves its units at the next close to the
//   offered tier nearest in list price (ties: the cheaper); some cancel
//   (retireChurnProbability), more the bigger the jump.
// - Churn at a close is one draw per unit against the sum of the regular,
//   price-step, outage and incumbent probabilities (capped at
//   CHURN_TOTAL_MAX); each cancellation is attributed to the component its
//   draw falls in (SalesClose.priceChurn, outageChurn, incumbentChurn).
// - The take-rate model compares your tiers with the incumbent's local price
//   (incumbent.incumbentPriceFor the street's serving cabinet: its promo
//   price while one runs there) and values the intro promo for signups.
// - While an outage cuts a street off from its serving cabinet
//   (ServiceSnapshot.cutOffCabinets), new subscribers there connect only to a
//   cabinet that still reaches it with a free port (else no one signs up),
//   and no one joins a building whose account is cut off
//   (network.outageService). Subscribers cut off keep their accounts and are
//   charged outage churn for their own days without service at each close,
//   an outage's base churn once (weather.outageChargeOf).

import {
  CHURN_MONTHLY_BASE,
  CHURN_TOTAL_MAX,
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
  GRANDFATHER_MONTHS_DEFAULT,
  GRANDFATHER_MONTHS_MAX,
  GRANDFATHER_STEP_SHARE,
  PRICE_STEP_CHURN_MAX,
  PRICE_STEP_CHURN_PER_RISE,
  PROMO_HORIZON_MONTHS,
  PROMO_MAX_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  PROMO_STEP_SHARE,
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
  START_YEAR,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
  TIER_RETIRE_CHURN_BASE,
  TIER_RETIRE_CHURN_MAX,
  TIER_RETIRE_CHURN_PER_RISE,
} from './balance';
import { dateOf, dayOf, formatMonth } from './calendar';
import { formatMoney, groupThousands, postEntry, postEntryOn } from './finance';
import { activePromos, incumbentChurnFor, incumbentPriceFor } from './incumbent';
import { getService, outageService } from './network';
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
  IntroPromo,
  MonthAccrual,
  Parcel,
  ParcelKind,
  PriceLock,
  PriceLockReason,
  Pricing,
  PricingQuote,
  Sales,
  ServiceSnapshot,
  Tier,
  TierId,
  TierSetting,
} from './types';
import { outageChargeOf } from './weather';

/** The tier lineup, in display (and Pricing.tiers) order. */
export const TIER_IDS: readonly TierId[] = TIER_DEFAULTS.map((t) => t.id);


/** How the install pause and resume notices begin (their kinds are 'installsPaused' and 'installsResumed'). */
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
    installsPaused: false,
    month: emptyMonthAccrual(),
    promo: null,
    incumbentPromos: [],
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

/**
 * The incumbent's offer at `incumbentPrice` a month (its promo price where it
 * runs one): TAKE_SPEED_WEIGHT + TAKE_UPLOAD_WEIGHT - TAKE_PRICE_WEIGHT x
 * incumbentPrice / INCUMBENT_PRICE (exactly INCUMBENT_VALUE at INCUMBENT_PRICE).
 */
function incumbentValue(incumbentPrice: number): number {
  if (incumbentPrice === INCUMBENT_PRICE) return INCUMBENT_VALUE;
  return TAKE_SPEED_WEIGHT + TAKE_UPLOAD_WEIGHT - (TAKE_PRICE_WEIGHT * incumbentPrice) / INCUMBENT_PRICE;
}

/**
 * The share of the list price a new signup weighs off for an intro promo:
 * percentOff / 100 x min(months, PROMO_HORIZON_MONTHS) / PROMO_HORIZON_MONTHS
 * (0 without a promo). A tier's price term then uses list - list x this.
 */
export function promoDiscountShare(promo: IntroPromo | null): number {
  if (promo === null) return 0;
  return ((promo.percentOff / 100) * Math.min(promo.months, PROMO_HORIZON_MONTHS)) / PROMO_HORIZON_MONTHS;
}

/**
 * How a building kind's price compares with a household's, relative to the
 * incumbent's offer to it: businesses pay tier price x smbMultiplier and
 * compare it with the incumbent's business price, INCUMBENT_PRICE x
 * SMB_MULTIPLIER_DEFAULT, so their price ratio is the household one times
 * smbMultiplier / SMB_MULTIPLIER_DEFAULT (exactly 1 at the default). Homes and
 * apartments pay the household price: 1.
 */
function priceFactor(pricing: Pricing, kind: ParcelKind): number {
  return kind === 'smb' ? pricing.smbMultiplier / SMB_MULTIPLIER_DEFAULT : 1;
}

/**
 * A tier's value to a customer whose price ratio is `factor` x the household
 * one (balance.ts take-rate model; factor 1 for a household), with an intro
 * promo worth `discount` of the list price (promoDiscountShare).
 */
function tierValue(tier: Tier, factor = 1, discount = 0): number {
  const price = tier.price - tier.price * discount;
  return (
    TAKE_SPEED_WEIGHT * Math.min(tier.downMbps / INCUMBENT_DOWN_MBPS, TAKE_SPEED_RATIO_CAP) +
    TAKE_UPLOAD_WEIGHT * Math.min(tier.upMbps / INCUMBENT_UP_MBPS, TAKE_UPLOAD_RATIO_CAP) -
    ((TAKE_PRICE_WEIGHT * price) / INCUMBENT_PRICE) * factor
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Target take rate (0..1) for a building kind under the given pricing, from the
 * model documented in balance.ts: the best offered tier's value against the
 * incumbent, clamped to TAKE_RATE_MIN..TAKE_RATE_MAX, times
 * TAKE_RATE_KIND_FACTOR[kind]. Businesses value a tier at the price they pay
 * (see priceFactor), so a higher smbMultiplier lowers their take rate. With no
 * tier offered (impossible via setPricing) returns 0.
 *
 * Round 4: `incumbentPrice` is the incumbent's price on the streets in
 * question (incumbent.incumbentPriceFor: lower where it runs a promo, which
 * lowers your target there); `promo` is the intro offer new signups get
 * (Sales.promo), valued as promoDiscountShare off each tier's price. The
 * defaults (INCUMBENT_PRICE, no promo) are the round-3 model; stateTakeRate
 * applies the game's own.
 */
export function targetTakeRate(
  pricing: Pricing,
  kind: ParcelKind,
  incumbentPrice: number = INCUMBENT_PRICE,
  promo: IntroPromo | null = null,
): number {
  const factor = priceFactor(pricing, kind);
  const discount = promoDiscountShare(promo);
  const incumbent = incumbentValue(incumbentPrice);
  let best = -Infinity;
  for (const tier of pricing.tiers) {
    if (tier.offered) best = Math.max(best, tierValue(tier, factor, discount) - incumbent);
  }
  if (best === -Infinity) return 0;
  return clamp(TAKE_RATE_BASE + TAKE_RATE_PER_ADVANTAGE * best, TAKE_RATE_MIN, TAKE_RATE_MAX) * TAKE_RATE_KIND_FACTOR[kind];
}

/**
 * The target take rate the game uses today for a building kind on streets
 * served by `cabinet` (undefined: anywhere the incumbent runs no promo):
 * targetTakeRate at the game's pricing, the incumbent's price there and the
 * intro promo. For the advisor and the pricing panel ("your target take rate
 * there vs elsewhere").
 */
export function stateTakeRate(state: GameState, kind: ParcelKind, cabinet?: CabinetId): number {
  return targetTakeRate(state.sales.pricing, kind, incumbentPriceFor(state, cabinet), state.sales.promo);
}

function zeroTiers(): Record<TierId, number> {
  const record = {} as Record<TierId, number>;
  for (const id of TIER_IDS) record[id] = 0;
  return record;
}

/**
 * Share of new signups of a building kind (default: households) choosing each
 * tier (sums to 1 over offered tiers, 0 for unoffered). Weight per offered
 * tier = popularity_t x max(0, value_t - incumbent value) (see balance.ts),
 * valued at the price that kind pays; if every weight is 0, offered tiers
 * split evenly. Round 4: against the incumbent at `incumbentPrice`, with the
 * intro promo valued, exactly as targetTakeRate.
 */
export function tierMix(
  pricing: Pricing,
  kind: ParcelKind = 'home',
  incumbentPrice: number = INCUMBENT_PRICE,
  promo: IntroPromo | null = null,
): Record<TierId, number> {
  const factor = priceFactor(pricing, kind);
  const discount = promoDiscountShare(promo);
  const incumbent = incumbentValue(incumbentPrice);
  const mix = zeroTiers();
  let total = 0;
  let offered = 0;
  for (const tier of pricing.tiers) {
    if (!tier.offered) continue;
    offered++;
    const weight = (POPULARITY[tier.id] ?? 0) * Math.max(0, tierValue(tier, factor, discount) - incumbent);
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

/** Target take rates and signup tier mixes by building kind, for one incumbent price. */
interface Demand {
  take: Record<ParcelKind, number>;
  mixes: Record<ParcelKind, Record<TierId, number>>;
}

function demandModel(pricing: Pricing, incumbentPrice: number, promo: IntroPromo | null): Demand {
  return {
    take: {
      home: targetTakeRate(pricing, 'home', incumbentPrice, promo),
      mdu: targetTakeRate(pricing, 'mdu', incumbentPrice, promo),
      smb: targetTakeRate(pricing, 'smb', incumbentPrice, promo),
    },
    mixes: {
      home: tierMix(pricing, 'home', incumbentPrice, promo),
      mdu: tierMix(pricing, 'mdu', incumbentPrice, promo),
      smb: tierMix(pricing, 'smb', incumbentPrice, promo),
    },
  };
}

// ---------------------------------------------------------------------------
// Price locks (round 4)
// ---------------------------------------------------------------------------

/** Month index of a day: 0 = Jan of START_YEAR. */
function monthIndexOf(day: number): number {
  const date = dateOf(day);
  return (date.year - START_YEAR) * 12 + date.month - 1;
}

/**
 * The day of the `n`-th month close after `day` (n >= 1): the 1st of the
 * month n months after day's own (on a close day, that day's close is not
 * counted). n = 0 gives the 1st of day's own month.
 */
export function closeDayAfter(day: number, n: number): number {
  const index = monthIndexOf(day) + n;
  return dayOf({ year: START_YEAR + Math.floor(index / 12), month: (index % 12) + 1, day: 1 });
}

/**
 * The close whose close ends a lock set on `day` for `months` months (a
 * grandfathering period, an intro promo): the close `months` closes after
 * the next one, so it covers the rest of this month and `months` full months
 * (0: the next close).
 */
export function lockEndDay(day: number, months: number): number {
  return closeDayAfter(day, months + 1);
}

/** The account's lock on `tier`, if any. */
export function lockOn(account: Account, tier: TierId): PriceLock | undefined {
  for (const lock of account.locks) if (lock.tier === tier) return lock;
  return undefined;
}

/** Set `lock` on its tier (replacing any lock there), keeping TIER_IDS order. */
function putLock(account: Account, lock: PriceLock): void {
  const order = TIER_IDS.indexOf(lock.tier);
  const locks = account.locks.filter((l) => l.tier !== lock.tier);
  let at = 0;
  while (at < locks.length && TIER_IDS.indexOf((locks[at] as PriceLock).tier) < order) at++;
  locks.splice(at, 0, lock);
  account.locks = locks;
}

/** Drop locks on tiers an account has no units on (none survive anywhere else; a loaded save may hold some). */
function dropIdleLocks(accounts: readonly Account[]): void {
  for (const account of accounts) {
    if (account.locks.length === 0) continue;
    if (account.locks.some((l) => account.tierUnits[l.tier] === 0)) account.locks = account.locks.filter((l) => account.tierUnits[l.tier] > 0);
  }
}

/** Household price an intro promo of `percentOff` gives on a list price: max(1, round(list x (100 - percentOff) / 100)). */
export function promoPrice(list: number, percentOff: number): number {
  return Math.max(1, Math.round((list * (100 - percentOff)) / 100));
}

/** The promo lock a signup on `tier` gets on `day`, or null when the promo price would not be below the list price. */
function promoLock(pricing: Pricing, tier: TierId, promo: IntroPromo, day: number): PriceLock | null {
  const list = tierOf(pricing, tier).price;
  const price = promoPrice(list, promo.percentOff);
  if (price >= list) return null;
  return { tier, price, untilDay: lockEndDay(day, promo.months), reason: 'promo' };
}

/** Churn share of a price step by why the price was locked (balance.ts PRICE_STEP_CHURN_*). */
export function stepShare(reason: PriceLockReason): number {
  return reason === 'notice' ? 1 : reason === 'grandfather' ? GRANDFATHER_STEP_SHARE : PROMO_STEP_SHARE;
}

/**
 * One-off churn probability when a unit's household price steps from
 * `from` to `to` at a close (a lock ending): min(PRICE_STEP_CHURN_MAX,
 * PRICE_STEP_CHURN_PER_RISE x max(0, to - from) / from x share), share by the
 * lock's reason (stepShare). 0 for no rise.
 */
export function stepChurnProbability(from: number, to: number, share: number): number {
  if (!(from > 0) || to <= from) return 0;
  return Math.min(PRICE_STEP_CHURN_MAX, ((PRICE_STEP_CHURN_PER_RISE * (to - from)) / from) * share);
}

/**
 * Churn probability of a unit moved off a retired tier, from the household
 * price it paid (`from`, its lock included) to the destination's list price
 * (`to`): min(TIER_RETIRE_CHURN_MAX, TIER_RETIRE_CHURN_BASE +
 * TIER_RETIRE_CHURN_PER_RISE x max(0, to / from - 1)).
 */
export function retireChurnProbability(from: number, to: number): number {
  const rise = from > 0 ? Math.max(0, to / from - 1) : 0;
  return Math.min(TIER_RETIRE_CHURN_MAX, TIER_RETIRE_CHURN_BASE + TIER_RETIRE_CHURN_PER_RISE * rise);
}

/**
 * Where units on tier `from` move when it is not offered: the offered tier
 * (other than `from`) whose price is nearest `from`'s, ties to the cheaper,
 * then to TIER_IDS order; null when no other tier is offered. `tiers` may be
 * Pricing.tiers or a setPricing draft.
 */
export function retireDestination(tiers: readonly Pick<Tier, 'id' | 'price' | 'offered'>[], from: TierId): TierId | null {
  const source = tiers.find((t) => t.id === from);
  if (!source) return null;
  let best: Pick<Tier, 'id' | 'price' | 'offered'> | null = null;
  for (const id of TIER_IDS) {
    const tier = tiers.find((t) => t.id === id);
    if (!tier || !tier.offered || tier.id === from) continue;
    if (best === null) {
      best = tier;
      continue;
    }
    const d = Math.abs(tier.price - source.price);
    const bestD = Math.abs(best.price - source.price);
    if (d < bestD || (d === bestD && tier.price < best.price)) best = tier;
  }
  return best ? best.id : null;
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

/**
 * Sum over every subscribed unit of its monthly price (accountUnitPrice:
 * price locks included), and the units counted.
 */
function billableRate(state: GameState): { rate: number; units: number } {
  const prices = priceTable(state.sales.pricing);
  const parcels = state.city.parcels;
  let rate = 0;
  let units = 0;
  for (const account of state.sales.accounts) {
    const kind = parcels[account.parcel]?.kind ?? 'home';
    const row = prices[kind];
    const locked = account.locks.length > 0;
    for (const id of TIER_IDS) {
      const n = account.tierUnits[id];
      if (n === 0) continue;
      rate += n * (locked ? accountUnitPrice(state, account, id) : row[id]);
      units += n;
    }
  }
  return { rate, units };
}

/** Subscribed units per tier over every account (TIER_IDS keys). */
export function unitsByTier(state: GameState): Record<TierId, number> {
  const units = zeroTiers();
  for (const account of state.sales.accounts) for (const id of TIER_IDS) units[id] += account.tierUnits[id];
  return units;
}

/** What every current subscriber pays for a full month at today's prices, price locks included (HUD "MRR"). */
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

/** What serviceChanges reads from a network: ServiceSnapshot, or a removal quote's "what if". */
export type ServiceView = Pick<ServiceSnapshot, 'activeCabinets' | 'segmentCabinets'>;

/** Why an account loses service: its street went dark, or every cabinet still reaching it is out of ports. */
export type LostServiceReason = 'dark' | 'noPort';

/** What step 1 of stepSales does to the accounts on a network (see serviceChanges). */
export interface ServiceChanges {
  /** Index into Sales.accounts -> the cabinet it moves to. */
  moves: Map<number, CabinetId>;
  /** Accounts that lose service, ascending by index. */
  drops: { index: number; reason: LostServiceReason }[];
}

/**
 * Who keeps service on the network `view` describes (pure; step 1 of
 * stepSales and the removal quotes both use it). For each account, ascending:
 * - its parcel no longer exists or its street is not lit: dropped ('dark');
 * - its own cabinet is active and reaches the street (in segmentCabinets): kept;
 * - otherwise it needs another cabinet. After every kept account has taken its
 *   ports, those accounts (ascending) move to the first cabinet in their
 *   street's segmentCabinets (nearest first) with free ports for them, or are
 *   dropped ('noPort').
 * Free ports = cabinetPortCapacity minus the ports of accounts kept on or moved to it.
 */
export function serviceChanges(state: GameState, view: ServiceView): ServiceChanges {
  const { city, day, network } = state;
  const accounts = state.sales.accounts;
  const moves = new Map<number, CabinetId>();
  const drops: ServiceChanges['drops'] = [];
  const used = new Map<CabinetId, number>();
  const homeless: number[] = [];
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i] as Account;
    const parcel = city.parcels[account.parcel];
    const reachers = parcel !== undefined && parcel.appearsDay <= day ? view.segmentCabinets.get(parcel.segment) : undefined;
    if (!reachers || reachers.length === 0) drops.push({ index: i, reason: 'dark' });
    else if (view.activeCabinets.has(account.cabinet) && reachers.includes(account.cabinet)) {
      used.set(account.cabinet, (used.get(account.cabinet) ?? 0) + accountPorts(state, account));
    } else homeless.push(i);
  }
  if (homeless.length > 0) {
    const capacity = new Map<CabinetId, number>();
    for (const cabinet of network.cabinets) capacity.set(cabinet.id, cabinetPortCapacity(cabinet));
    for (const i of homeless) {
      const account = accounts[i] as Account;
      const parcel = city.parcels[account.parcel] as Parcel;
      const ports = accountPorts(state, account);
      const to = view.segmentCabinets.get(parcel.segment)?.find((c) => (capacity.get(c) ?? 0) - (used.get(c) ?? 0) >= ports);
      if (to === undefined) {
        drops.push({ index: i, reason: 'noPort' });
        continue;
      }
      moves.set(i, to);
      used.set(to, (used.get(to) ?? 0) + ports);
    }
    drops.sort((a, b) => a.index - b.index);
  }
  return { moves, drops };
}

/**
 * Step 1 of stepSales: apply serviceChanges on today's service. Moved
 * accounts change cabinet quietly (the subscriber keeps service); dropped ones
 * are removed, added to month.lostService, and the player is told once per
 * (cabinet, reason).
 */
function applyServiceChanges(state: GameState, service: ServiceSnapshot): void {
  const { sales } = state;
  const { moves, drops } = serviceChanges(state, service);
  for (const [index, cabinet] of moves) (sales.accounts[index] as Account).cabinet = cabinet;
  if (drops.length === 0) return;
  const lost = new Map<string, { cabinet: CabinetId; reason: LostServiceReason; units: number }>();
  const dropped = new Set<number>();
  for (const { index, reason } of drops) {
    const account = sales.accounts[index] as Account;
    dropped.add(index);
    const key = `${account.cabinet}|${reason}`;
    const entry = lost.get(key) ?? { cabinet: account.cabinet, reason, units: 0 };
    entry.units += accountUnits(account);
    lost.set(key, entry);
  }
  sales.accounts = sales.accounts.filter((_, i) => !dropped.has(i));
  const order = [...lost.values()].sort((a, b) => a.cabinet - b.cabinet || (a.reason === b.reason ? 0 : a.reason === 'dark' ? -1 : 1));
  for (const { cabinet, reason, units } of order) {
    sales.month.lostService += units;
    const place = cabinetPlace(state, cabinet);
    const who = plural(units, 'subscriber', 'subscribers');
    const why =
      reason === 'noPort'
        ? 'no cabinet in reach of their street has a free port (add a splitter).'
        : place
          ? 'their cable or cabinet is no longer connected.'
          : 'their cabinet was removed.';
    const message = place
      ? `${who} lost service at ${place}: ${why}`
      : reason === 'noPort'
        ? `${who} lost service: their cabinet was removed and ${why}`
        : `${who} lost service: ${why}`;
    postNotice(state, 'serviceLost', message, { cabinet });
  }
}

/**
 * A cabinet already listed in Sales.fullCabinets stays listed while the demand
 * waiting on it is expected to take every one of its free ports within this
 * many days at today's signup ramp. Ports that churn frees at a month close are
 * soon taken again, so a busy full cabinet does not drop out of the list and
 * announce itself again; a cabinet whose free ports would last longer than
 * this (a splitter was added, subscribers left) is not turning anyone away.
 */
export const FULL_HOLD_DAYS = 30;

/** Whether installs are paused for lack of cash (Sales.installsPaused). */
export function installsPaused(state: GameState): boolean {
  return state.sales.installsPaused;
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
 * 1. Service check (serviceChanges on getService(state)): an account whose
 *    own cabinet is no longer active or no longer reaches its street moves to
 *    the nearest active cabinet that reaches it and has a free port; one whose
 *    parcel is no longer passed, or that no such cabinet can take, is dropped
 *    and its units added to month.lostService. If any were dropped, post one
 *    'serviceLost' notice per affected cabinet and reason ("N subscribers lost
 *    service at <corner>: ...").
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
 *    units, pick a tier by tierMix for its kind (rng), and connect it unless C has no free
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
 *    installs posts an 'installsPaused' notice and sets Sales.installsPaused
 *    unless they were already paused; the first day an install connects
 *    after a pause clears it and posts 'installsResumed'.
 * 3. Accruals for the day (after signups, accrueDay): month.revenueDollarDays
 *    += the monthly rate of every subscribed unit (unitPrice per tier and
 *    kind); month.marketingDollarDays += marketingPerMonth;
 *    month.subscriberUnitDays += subscribed units.
 * 4. fullCabinets := cabinets marked full today (sorted); post a 'cabinetFull'
 *    notice for each cabinet not in the previous list. Besides a blocked
 *    unit, a cabinet is marked full when demand left waiting on its segments
 *    (min(gap left, ports its open parcels without an account would take))
 *    finds no free port for a new account (without this, a full cabinet would
 *    drop out of the list on every day nobody happened to try to sign up, most
 *    days on a small area, and re-announce itself). A cabinet already listed
 *    also stays while that waiting demand, at today's ramp, would take all
 *    its free ports within FULL_HOLD_DAYS. addSplitter takes a cabinet off
 *    the list at once.
 *
 * Round 4:
 * - Before signups, locks on tiers an account has no units on are dropped
 *   (only a loaded save can have them: every other path drops them when the
 *   units leave).
 * - Step 2: on a segment whose serving cabinet an outage cuts off from it
 *   (service.cutOffCabinets), new accounts go to the first cabinet of its
 *   segmentCabinets that still reaches it and has a free port (it does not
 *   count as full there, and the street's waiting demand is not put on it);
 *   with none, the segment is skipped (no signups, no draws; its accounts
 *   stay). A unit drawn for a building whose account is cut off
 *   (network.outageService) does not connect, and ports lent to accounts it
 *   re-homes for the outage are not free. The take rate stays that of the
 *   serving cabinet's area.
 * - The target take rate and tier mix on a segment are those against the
 *   incumbent's price at its serving cabinet (incumbent.incumbentPriceFor:
 *   its promo price while one runs there) with the intro promo valued
 *   (targetTakeRate / tierMix with Sales.promo).
 * - While Sales.promo is set, a unit signing up on a tier its account has no
 *   units on gets a PriceLock { tier, price: max(1, round(list x (100 -
 *   percentOff) / 100)), untilDay: the close `months` closes after the next
 *   one, reason 'promo' } (none when that is not below the list price). An
 *   apartment building's further units on a tier join what the building
 *   pays there (its lock if any).
 */
export function stepSales(state: GameState, rng: Rng): void {
  const service = getService(state);
  applyServiceChanges(state, service);
  dropIdleLocks(state.sales.accounts);

  const { city, sales, finance, day } = state;
  const parcels = city.parcels;
  const index = cityIndex(city);
  const pricing = sales.pricing;
  const promo = sales.promo;
  const cutOff = service.cutOffCabinets;
  // While a span is out: who has no service, and the ports lent to the others it cut off (network.outageService).
  const outage = cutOff.size > 0 ? outageService(state, service) : null;
  // Take rates and tier mixes per incumbent price: INCUMBENT_PRICE everywhere
  // but the cabinet areas where it runs a promo today.
  const localPrice = new Map<CabinetId, number>();
  for (const running of activePromos(state)) localPrice.set(running.cabinet, running.price);
  const models = new Map<number, Demand>();
  const demandAt = (incumbentPrice: number): Demand => {
    let model = models.get(incumbentPrice);
    if (!model) {
      model = demandModel(pricing, incumbentPrice, promo);
      models.set(incumbentPrice, model);
    }
    return model;
  };
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
    return (cabinet ? cabinetPortCapacity(cabinet) : 0) - (portsUsed.get(cabinetId) ?? 0) - (outage?.lent.get(cabinetId) ?? 0);
  };
  const routers = new Set(sales.routerParcels);
  const fullToday = new Set<CabinetId>();
  // Per serving cabinet: new-port signups its waiting demand is expected to
  // make per day (at today's ramp), and the fewest ports any one waiting new
  // account needs.
  const portDemandPerDay = new Map<CabinetId, number>();
  const minNewPorts = new Map<CabinetId, number>();
  const tally: InstallTally = { home: 0, smb: 0, mdu: 0, routers: 0 };
  let spend = 0;
  let connected = 0;
  let addedAccount = false;
  let addedRouter = false;
  let cashBlockedCost: number | null = null;

  for (const seg of index.servingSegments) {
    if (!service.litSegments.has(seg)) continue;
    const nearest = service.servingCabinet.get(seg);
    if (nearest === undefined) continue;
    // An outage cuts the street off from its cabinet: new signups go to the
    // nearest cabinet that still reaches it and has a free port, else they
    // wait for the repair.
    let server = nearest;
    let rerouted = false;
    const lost = cutOff.size > 0 ? cutOff.get(seg) : undefined;
    if (lost?.has(nearest)) {
      const working = (service.segmentCabinets.get(seg) ?? []).find((c) => !lost.has(c) && freePorts(c) > 0);
      if (working === undefined) continue;
      server = working;
      rerouted = true;
    }
    const { take, mixes } = demandAt(localPrice.get(nearest) ?? INCUMBENT_PRICE);
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
      const tier = pickTier(mixes[parcels[chosen]?.kind ?? 'home'], rng);
      if (chosen < 0 || tier === null) continue;
      const parcel = parcels[chosen]!;
      const existing = accountAt[chosen] as number;

      // Ports: a new account needs its ports on the serving cabinet; more units
      // in a building that already has an account ride on its router's port.
      if (existing < 0 && freePorts(server) < portsForKind(parcel.kind)) {
        // A cabinet standing in for one an outage cut off is not "full" for its own streets.
        if (!rerouted) fullToday.add(server);
        continue;
      }
      // A building an outage leaves without service connects no one more until repairs finish.
      if (existing >= 0 && outage !== null && outage.cutOff.has(chosen)) continue;

      // Cash: installs pause while cash cannot cover the next one.
      const cost = installCost(parcel.kind, routers.has(chosen));
      if (cashBlockedCost !== null) continue;
      if (cost > finance.cash - spend) {
        cashBlockedCost = cost;
        continue;
      }

      if (existing >= 0) {
        const acc = accounts[existing] as Account;
        // The intro promo is for a tier the building does not have yet; more
        // units on a tier join what the building pays there (its lock, if any).
        if (promo !== null && acc.tierUnits[tier] === 0) {
          const lock = promoLock(pricing, tier, promo, day);
          if (lock) putLock(acc, lock);
        }
        acc.tierUnits[tier] += 1;
      } else {
        const tierUnits = zeroTiers();
        tierUnits[tier] = 1;
        accountAt[chosen] = accounts.length;
        const lock = promo !== null ? promoLock(pricing, tier, promo, day) : null;
        accounts.push({ parcel: chosen, cabinet: server, tierUnits, since: day, locks: lock ? [lock] : [] });
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

    // Demand still waiting here that needs new ports on the server (its own, not a stand-in's).
    const waiting = Math.min(gap - connectedHere, newPorts - portsTakenHere);
    if (waiting > 0 && !rerouted) {
      portDemandPerDay.set(server, (portDemandPerDay.get(server) ?? 0) + waiting * ramp);
      minNewPorts.set(server, Math.min(minNewPorts.get(server) ?? Infinity, fewestPorts));
    }
  }

  if (addedAccount) accounts.sort((a, b) => a.parcel - b.parcel);
  if (addedRouter) sales.routerParcels = [...routers].sort((a, b) => a - b);
  if (spend > 0) postEntry(state, 'install', -spend, installMemo(tally));

  if (cashBlockedCost !== null) {
    if (!sales.installsPaused) {
      sales.installsPaused = true;
      postNotice(
        state,
        'installsPaused',
        `${INSTALLS_PAUSED_PREFIX}: cash can't cover the next install (${formatMoney(cashBlockedCost)}). ` +
          'New customers will wait and be connected once cash recovers.',
      );
    }
  } else if (connected > 0 && sales.installsPaused) {
    sales.installsPaused = false;
    postNotice(state, 'installsResumed', `${INSTALLS_RESUMED_PREFIX}: cash covers installs again, and waiting customers are being connected.`);
  }

  // 3. Accruals, after today's signups.
  accrueDay(state);

  // 4. Cabinets turning signups away: a cabinet becomes full when it has no
  // room for a waiting new account, and stays full while its waiting demand
  // would take every free port within FULL_HOLD_DAYS (so a port freed by churn
  // does not make it flicker out of the list and announce itself again, while
  // a new splitter's ports do take it off).
  const previous = new Set(sales.fullCabinets);
  for (const [cabinetId, perDay] of portDemandPerDay) {
    const free = freePorts(cabinetId);
    const noRoom = free < (minNewPorts.get(cabinetId) ?? 1);
    const full = noRoom || (previous.has(cabinetId) && perDay * FULL_HOLD_DAYS >= free);
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

/**
 * One day's billing accruals at today's settings: month.revenueDollarDays +=
 * the monthly rate of every subscribed unit, month.marketingDollarDays +=
 * marketingPerMonth, month.subscriberUnitDays += subscribed units. Step 3 of
 * stepSales; tick() also runs it for day 0, which gets no sales step, so the
 * first month bills every one of its days.
 */
export function accrueDay(state: GameState): void {
  const { sales } = state;
  const { rate, units } = billableRate(state);
  sales.month.revenueDollarDays += rate;
  sales.month.marketingDollarDays += sales.marketingPerMonth;
  sales.month.subscriberUnitDays += units;
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
  /** Every unit that cancelled at this close (tier-move cancellations included). */
  churned: number;
  lostService: number;
  /**
   * Round 4 (finance.closeMonth copies them into MonthlyReport.ops): units
   * moved off tiers no longer offered that kept service, and of `churned` the
   * cancellations caused by price steps (locks ending, tier moves), outages
   * and incumbent promos (the rest are regular churn).
   */
  tierMoves: number;
  priceChurn: number;
  outageChurn: number;
  incumbentChurn: number;
}

/**
 * Monthly churn probability for a unit of `kind` on `tier` at the price it
 * pays: a household's is the tier price against its default price; a
 * business's is price x smbMultiplier against default price x
 * SMB_MULTIPLIER_DEFAULT (the same as a household's at the default multiplier).
 * Round 4: pass the tier at what the unit pays (its lock price, when lower).
 */
export function churnProbability(tier: Tier, kind: ParcelKind = 'home', smbMultiplier: number = SMB_MULTIPLIER_DEFAULT): number {
  const base = DEFAULT_PRICE[tier.id] ?? tier.price;
  const factor = kind === 'smb' ? smbMultiplier / SMB_MULTIPLIER_DEFAULT : 1;
  const over = base > 0 ? Math.max(0, tier.price * factor - base) / base : 0;
  return Math.min(CHURN_MONTHLY_MAX, CHURN_MONTHLY_BASE * (1 + CHURN_PRICE_SENSITIVITY * over));
}

/** The pieces of one unit's churn probability at a close (see closeSalesMonth step 6). */
export interface ChurnParts {
  regular: number;
  price: number;
  outage: number;
  incumbent: number;
}

/** min(sum of the parts, CHURN_TOTAL_MAX): the chance the unit cancels. */
export function totalChurn(parts: ChurnParts): number {
  return Math.min(CHURN_TOTAL_MAX, parts.regular + parts.price + parts.outage + parts.incumbent);
}

type ChurnCause = 'regular' | 'price' | 'outage' | 'incumbent';

/**
 * Which part a draw `r` in [0, 1) falls in, or null when the unit stays
 * (r >= totalChurn). The parts lie end to end in the order regular, price,
 * outage, incumbent, each scaled by CHURN_TOTAL_MAX / sum when capped. With
 * only a regular part this is exactly rng.chance(regular).
 */
function churnCause(parts: ChurnParts, r: number): ChurnCause | null {
  const sum = parts.regular + parts.price + parts.outage + parts.incumbent;
  const scale = sum > CHURN_TOTAL_MAX ? CHURN_TOTAL_MAX / sum : 1;
  let edge = parts.regular * scale;
  if (r < edge) return 'regular';
  edge += parts.price * scale;
  if (r < edge) return 'price';
  edge += parts.outage * scale;
  if (r < edge) return 'outage';
  edge += parts.incumbent * scale;
  if (r < edge) return 'incumbent';
  return null;
}

/** "grandfathered prices", "intro promos", ... for the price-step notice. */
function stepWhy(reasons: ReadonlySet<PriceLockReason>): string {
  if (reasons.size === 1 && reasons.has('grandfather')) return 'whose grandfathered prices ended';
  if (reasons.size === 1 && reasons.has('promo')) return 'whose intro promos ended';
  if (reasons.size === 1 && reasons.has('notice')) return 'whose announced price rise took effect';
  return 'whose grandfathered or intro prices ended';
}

/**
 * Sales part of a month close, called by finance.closeMonth (before the report
 * is built) at state.day = the close day, with the ended month's length in
 * days and its last day (the date every entry is posted on). In order:
 * 1. 'revenue' +round(month.revenueDollarDays / daysInMonth) (skip if 0), memo
 *    "Subscriber billing for Mar 2027: 412 subscribers" (billing accrued at
 *    what each unit paid that day: price locks included).
 * 2. 'marketing' -round(month.marketingDollarDays / daysInMonth) (skip if 0).
 * 3. 'overhead' -round(SUPPORT_COST_PER_SUB_PER_MONTH x month.subscriberUnitDays / daysInMonth) (skip if 0), memo "Customer support".
 * 4. Tier retirement (round 4): units on a tier not offered move to
 *    retireDestination (the offered tier nearest in list price, ties to the
 *    cheaper). Accounts ascending, retired tiers in TIER_IDS order, one draw
 *    per unit: it cancels with retireChurnProbability(what it paid, lock
 *    included; the destination's list price), else it moves (and pays the
 *    list price there, or the account's lock on that tier). The old tier's
 *    lock is dropped. One 'tierRetired' notice per retired tier that had
 *    units ("2 Gig is no longer offered: 37 of its 40 subscribers moved to
 *    1 Gig at the Mar 2028 close and 3 cancelled."). Moved units that stayed
 *    count in tierMoves; the cancellations in churned and priceChurn.
 * 5. Churn: every subscribed unit (accounts ascending, tiers in TIER_IDS
 *    order) draws once against the sum of (ChurnParts):
 *      regular   - churnProbability at what it pays (its lock price, when lower)
 *      price     - when its lock ends at this close (untilDay <= state.day):
 *                  stepChurnProbability(lock price, list price, stepShare(reason))
 *      outage    - the churn of the account's days cut off since the last
 *                  close (weather.outageChargeOf: outageChurnProbability of
 *                  its days, less what earlier closes charged the same
 *                  outage, so its base churn is charged once), times the
 *                  share of its units that were cut off (units it added
 *                  later were not)
 *      incumbent - incumbent.incumbentChurnFor(its cabinet): a promo ran there
 *    capped at CHURN_TOTAL_MAX; a cancellation counts in churned and in the
 *    part its draw falls in (churnCause). Accounts left with 0 units are
 *    removed (routers stay in routerParcels).
 * 6. Locks ending at this close (untilDay <= state.day) are removed (their
 *    units pay the list price from now on), with locks on tiers left with no
 *    units and locks no longer below the list price. When any ended with a
 *    real rise, one 'priceStep' notice ("Prices stepped up for 312
 *    subscribers whose grandfathered prices ended at the Mar 2028 close: 11
 *    cancelled."; the cancellations are those step 5 put on the price part).
 * 7. Reset `month` to emptyMonthAccrual() and return the figures (subscriber
 *    days, grossAdds and lostService from the accrual before the reset).
 * Only the sales stream `rng` is drawn from, in the order above.
 */
export function closeSalesMonth(state: GameState, rng: Rng, daysInMonth: number, lastDay: number): SalesClose {
  if (!Number.isInteger(daysInMonth) || daysInMonth <= 0) throw new RangeError(`closeSalesMonth: bad month length ${daysInMonth}`);
  const { sales, day } = state;
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

  const pricing = sales.pricing;
  const parcels = state.city.parcels;
  const list = zeroTiers();
  for (const id of TIER_IDS) list[id] = tierOf(pricing, id).price;
  let churned = 0;
  let priceChurn = 0;
  let outageChurn = 0;
  let incumbentChurn = 0;
  let tierMoves = 0;

  // 4. Tier retirement.
  const destination = new Map<TierId, TierId>();
  for (const id of TIER_IDS) {
    if (tierOf(pricing, id).offered) continue;
    const to = retireDestination(pricing.tiers, id);
    if (to !== null) destination.set(id, to);
  }
  if (destination.size > 0) {
    const retired = new Map<TierId, { units: number; cancelled: number }>();
    for (const account of sales.accounts) {
      for (const id of TIER_IDS) {
        const to = destination.get(id);
        const n = account.tierUnits[id];
        if (to === undefined || n === 0) continue;
        const lock = lockOn(account, id);
        const p = retireChurnProbability(lock ? Math.min(lock.price, list[id]) : list[id], list[to]);
        let kept = 0;
        for (let u = 0; u < n; u++) if (!rng.chance(p)) kept++;
        account.tierUnits[id] = 0;
        account.tierUnits[to] += kept;
        if (lock) account.locks = account.locks.filter((l) => l.tier !== id);
        const tally = retired.get(id) ?? { units: 0, cancelled: 0 };
        tally.units += n;
        tally.cancelled += n - kept;
        retired.set(id, tally);
        tierMoves += kept;
        priceChurn += n - kept;
        churned += n - kept;
      }
    }
    for (const id of TIER_IDS) {
      const tally = retired.get(id);
      if (!tally) continue;
      const name = tierOf(pricing, id).name;
      const toName = tierOf(pricing, destination.get(id) as TierId).name;
      const moved = tally.units - tally.cancelled;
      const of = tally.units === 1 ? 'its 1 subscriber' : `${groupThousands(moved)} of its ${plural(tally.units, 'subscriber', 'subscribers')}`;
      const message =
        tally.units === 1
          ? `${name} is no longer offered: its 1 subscriber ${moved === 1 ? `moved to ${toName}` : 'cancelled instead of moving'} at the ${label} close.`
          : `${name} is no longer offered: ${of} moved to ${toName} at the ${label} close and ${groupThousands(tally.cancelled)} cancelled.`;
      postNotice(state, 'tierRetired', message);
    }
  }

  // 5. Churn, one draw per unit, attributed to the part it falls in.
  const regularAtList: Record<ParcelKind, Record<TierId, number>> = { home: zeroTiers(), mdu: zeroTiers(), smb: zeroTiers() };
  for (const tier of pricing.tiers) {
    for (const kind of ['home', 'mdu', 'smb'] as const) regularAtList[kind][tier.id] = churnProbability(tier, kind, pricing.smbMultiplier);
  }
  let stepUnits = 0;
  let stepCancelled = 0;
  const stepReasons = new Set<PriceLockReason>();
  let emptied = false;
  for (const account of sales.accounts) {
    const parcel = parcels[account.parcel];
    const kind = parcel?.kind ?? 'home';
    const charge = outageChargeOf(state, account.parcel);
    // Spread over the account's units by the share of them that were cut off: units it added later were not.
    const outage = charge ? charge.probability * Math.min(1, charge.units / Math.max(1, accountUnits(account))) : 0;
    const incumbent = incumbentChurnFor(state, account.cabinet);
    for (const id of TIER_IDS) {
      const units = account.tierUnits[id];
      if (units === 0) continue;
      const lock = account.locks.length > 0 ? lockOn(account, id) : undefined;
      let regular = regularAtList[kind][id];
      let price = 0;
      let stepping = false;
      if (lock) {
        const paid = Math.min(lock.price, list[id]);
        if (paid < list[id]) regular = churnProbability({ ...tierOf(pricing, id), price: paid }, kind, pricing.smbMultiplier);
        if (lock.untilDay <= day && list[id] > lock.price) {
          price = stepChurnProbability(lock.price, list[id], stepShare(lock.reason));
          stepping = true;
          stepUnits += units;
          stepReasons.add(lock.reason);
        }
      }
      const parts: ChurnParts = { regular, price, outage, incumbent };
      let left = units;
      for (let u = 0; u < units; u++) {
        const cause = churnCause(parts, rng.next());
        if (cause === null) continue;
        left--;
        if (cause === 'price') {
          priceChurn++;
          if (stepping) stepCancelled++;
        } else if (cause === 'outage') outageChurn++;
        else if (cause === 'incumbent') incumbentChurn++;
      }
      churned += units - left;
      account.tierUnits[id] = left;
    }
    if (accountUnits(account) === 0) emptied = true;
  }
  if (emptied) sales.accounts = sales.accounts.filter((a) => accountUnits(a) > 0);

  // 6. Locks that end here: their units pay the list price from now on.
  for (const account of sales.accounts) {
    if (account.locks.length === 0) continue;
    account.locks = account.locks.filter((l) => l.untilDay > day && account.tierUnits[l.tier] > 0 && l.price < list[l.tier]);
  }
  if (stepUnits > 0) {
    postNotice(
      state,
      'priceStep',
      `Prices stepped up for ${plural(stepUnits, 'subscriber', 'subscribers')} ${stepWhy(stepReasons)} at the ${label} close: ${groupThousands(stepCancelled)} cancelled.`,
    );
  }

  const result: SalesClose = {
    revenue,
    marketing,
    support,
    subscriberDays: month.subscriberUnitDays,
    grossAdds: month.grossAdds,
    churned,
    lostService: month.lostService,
    tierMoves,
    priceChurn,
    outageChurn,
    incumbentChurn,
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

/** A setPricing request that passed every check: one setting per tier. */
type PricingCheck = { ok: true; settings: Map<TierId, TierSetting> } | { ok: false; reason: string };

/** setPricing's checks, without touching the game (setPricing and quotePricing share them). */
function checkPricing(state: GameState, tiers: readonly TierSetting[], smbMultiplier: number, grandfatherMonths: number): PricingCheck {
  const fail = (reason: string): PricingCheck => ({ ok: false, reason });
  if (!Array.isArray(tiers)) return fail('setPricing needs a list of tiers');
  const settings = new Map<TierId, TierSetting>();
  for (const raw of tiers as readonly unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return fail('setPricing needs a list of tiers, each { id, price, offered }');
    }
    const setting = raw as Record<string, unknown>;
    const id = setting.id;
    if (typeof id !== 'string' || !TIER_IDS.includes(id as TierId)) return fail(`Unknown tier: ${describeValue(id)}`);
    const tierId = id as TierId;
    const name = tierOf(state.sales.pricing, tierId).name;
    if (settings.has(tierId)) return fail(`The ${name} tier is listed twice`);
    const price = setting.price;
    if (typeof price !== 'number' || !Number.isInteger(price) || price < TIER_PRICE_MIN || price > TIER_PRICE_MAX) {
      return fail(
        `The ${name} price must be a whole number of dollars from ${formatMoney(TIER_PRICE_MIN)} to ${formatMoney(TIER_PRICE_MAX)}, got ${describeValue(price)}`,
      );
    }
    if (typeof setting.offered !== 'boolean') return fail(`The ${name} tier needs offered: true or false`);
    settings.set(tierId, { id: tierId, price, offered: setting.offered });
  }
  const missing = TIER_IDS.filter((id) => !settings.has(id)).map((id) => tierOf(state.sales.pricing, id).name);
  if (missing.length > 0) return fail(`setPricing must list every tier; missing ${missing.join(', ')}`);
  if (![...settings.values()].some((t) => t.offered)) return fail('Offer at least one tier');
  if (
    typeof smbMultiplier !== 'number' ||
    !Number.isFinite(smbMultiplier) ||
    smbMultiplier < SMB_MULTIPLIER_MIN ||
    smbMultiplier > SMB_MULTIPLIER_MAX
  ) {
    return fail(`The business price multiplier must be from ${SMB_MULTIPLIER_MIN} to ${SMB_MULTIPLIER_MAX}, got ${describeValue(smbMultiplier)}`);
  }
  if (!Number.isInteger(grandfatherMonths) || grandfatherMonths < 0 || grandfatherMonths > GRANDFATHER_MONTHS_MAX) {
    return fail(`Grandfathering must be a whole number of months from 0 to ${GRANDFATHER_MONTHS_MAX}, got ${describeValue(grandfatherMonths)}`);
  }
  return { ok: true, settings };
}

/**
 * setPricing command. Rejects (state untouched) unless `tiers` names every
 * TierId exactly once, every price is an integer in TIER_PRICE_MIN..
 * TIER_PRICE_MAX, at least one tier is offered, smbMultiplier is finite in
 * SMB_MULTIPLIER_MIN..SMB_MULTIPLIER_MAX and grandfatherMonths is an integer
 * 0..GRANDFATHER_MONTHS_MAX (default GRANDFATHER_MONTHS_DEFAULT). On success
 * replaces each tier's price and offered flag (names and speeds never change)
 * and the multiplier, keeps Pricing.tiers in TIER_IDS order, and returns
 * { ok: true, cost: 0 }. New prices bill from the next daily accrual.
 *
 * Round 4, price locks: first, for each tier whose list price rises, every
 * account with units on it and no lock on it gets PriceLock { price: the old
 * list price, untilDay: lockEndDay(day, grandfatherMonths) (the close
 * grandfatherMonths closes after the next one; 0: the next close), reason
 * 'grandfather' ('notice' for 0) }. Then every lock whose price is at or
 * above its tier's new list price is dropped (a cut reaches everyone at
 * once). Locks stay one per tier, in TIER_IDS order, on tiers with units. New
 * subscribers pay the new list price (or the intro promo). The business
 * multiplier is never grandfathered. A tier set to not offered keeps its
 * subscribers until the next close moves them (closeSalesMonth).
 */
export function setPricing(
  state: GameState,
  tiers: readonly TierSetting[],
  smbMultiplier: number,
  grandfatherMonths: number = GRANDFATHER_MONTHS_DEFAULT,
): CommandResult {
  const check = checkPricing(state, tiers, smbMultiplier, grandfatherMonths);
  if (!check.ok) return reject(check.reason);
  const { settings } = check;
  const pricing = state.sales.pricing;
  const accounts = state.sales.accounts;

  const untilDay = lockEndDay(state.day, grandfatherMonths);
  const reason: PriceLockReason = grandfatherMonths === 0 ? 'notice' : 'grandfather';
  for (const id of TIER_IDS) {
    const old = tierOf(pricing, id).price;
    if ((settings.get(id) as TierSetting).price <= old) continue;
    for (const account of accounts) {
      if (account.tierUnits[id] > 0 && !lockOn(account, id)) putLock(account, { tier: id, price: old, untilDay, reason });
    }
  }

  // Keep TIER_IDS order whatever order the command listed them in.
  pricing.tiers = TIER_IDS.map((id) => {
    const tier = tierOf(pricing, id);
    const setting = settings.get(id) as TierSetting;
    return { ...tier, price: setting.price, offered: setting.offered };
  });
  pricing.smbMultiplier = smbMultiplier;

  for (const account of accounts) {
    if (account.locks.length === 0) continue;
    account.locks = account.locks.filter((l) => account.tierUnits[l.tier] > 0 && l.price < tierOf(pricing, l.tier).price);
  }
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

// ---------------------------------------------------------------------------
// Round 4 (sim-pricing): price locks, intro promo, the pricing quote
// ---------------------------------------------------------------------------

/**
 * Monthly price one unit of `account` pays on `tier` today: min(lock price,
 * list price) when the account has a lock on that tier, else the list price;
 * a business pays round(that x smbMultiplier). billableRate (and so billing,
 * monthlyRecurringRevenue and estimateCashAtClose) uses it.
 */
export function accountUnitPrice(state: GameState, account: Account, tier: TierId): number {
  const pricing = state.sales.pricing;
  const kind = state.city.parcels[account.parcel]?.kind ?? 'home';
  const list = tierOf(pricing, tier).price;
  const lock = account.locks.length > 0 ? lockOn(account, tier) : undefined;
  const price = lock ? Math.min(lock.price, list) : list;
  return kind === 'smb' ? Math.round(price * pricing.smbMultiplier) : price;
}

/**
 * setPromo command: promo null (no intro offer) or { percentOff: integer
 * 1..PROMO_MAX_PERCENT_OFF, months: integer 1..PROMO_MAX_MONTHS } (else
 * reject naming the range, state untouched). Sets Sales.promo; free.
 * New signups from the next daily step get a PriceLock { reason 'promo',
 * price promoPrice(list, percentOff), untilDay lockEndDay(day, months) } on a
 * tier their account has no units on (stepSales), and the take-rate model
 * values the offer (promoDiscountShare). Existing subscribers are unaffected;
 * clearing it leaves the locks already given.
 */
export function setPromo(state: GameState, promo: IntroPromo | null): CommandResult {
  if (promo === null) {
    state.sales.promo = null;
    return { ok: true, cost: 0 };
  }
  if (typeof promo !== 'object' || Array.isArray(promo)) return reject('setPromo needs promo: null or { percentOff, months }');
  const { percentOff, months } = promo as { percentOff: unknown; months: unknown };
  if (typeof percentOff !== 'number' || !Number.isInteger(percentOff) || percentOff < 1 || percentOff > PROMO_MAX_PERCENT_OFF) {
    return reject(`The intro promo must be a whole percent off from 1% to ${PROMO_MAX_PERCENT_OFF}%, got ${describeValue(percentOff)}`);
  }
  if (typeof months !== 'number' || !Number.isInteger(months) || months < 1 || months > PROMO_MAX_MONTHS) {
    return reject(`The intro promo must last a whole number of months from 1 to ${PROMO_MAX_MONTHS}, got ${describeValue(months)}`);
  }
  state.sales.promo = { percentOff, months };
  return { ok: true, cost: 0 };
}

/**
 * What setPricing(tiers, smbMultiplier, grandfatherMonths) would do to
 * today's subscribers (see PricingQuote). Never throws for bad input: ok
 * false with the reason setPricing would give, and today's figures with
 * nothing rising, falling or moving. Pure, no rng. Per subscribed unit on
 * its tier (L0 = today's list price, L1 = the new one):
 * - a tier no longer offered: unitsMoving (it moves at the next close to
 *   retireDestination under the new settings); expectedChurn adds
 *   retireChurnProbability(what it will pay, lock included; the
 *   destination's new list price);
 * - otherwise unitsRising when L1 > L0 (a unit with no lock gets one at L0
 *   ending at locksEndDay; expectedChurn adds its step at that close,
 *   stepChurnProbability(L0, L1, share by 'grandfather' / 'notice'), and a
 *   unit already locked adds how much more its own step will cost), and
 *   unitsFalling when L1 is below what it pays today;
 * - mrrNow: what every unit pays right after the change (locks held, those
 *   at or above the new list price dropped), at the new multiplier;
 *   mrrAfterLocks: the same once the locks it creates have ended and the
 *   moves have happened (moved units at the destination's list price; locks
 *   already held stay held). Neither counts regular churn or cancellations.
 */
export function quotePricing(
  state: GameState,
  tiers: readonly TierSetting[],
  smbMultiplier: number,
  grandfatherMonths: number = GRANDFATHER_MONTHS_DEFAULT,
): PricingQuote {
  const check = checkPricing(state, tiers, smbMultiplier, grandfatherMonths);
  if (!check.ok) {
    const mrr = monthlyRecurringRevenue(state);
    return {
      ok: false,
      reasons: [check.reason],
      grandfatherMonths,
      unitsRising: 0,
      unitsFalling: 0,
      locksEndDay: null,
      mrrNow: mrr,
      mrrAfterLocks: mrr,
      unitsMoving: 0,
      expectedChurn: 0,
    };
  }
  const { settings } = check;
  const pricing = state.sales.pricing;
  const untilDay = lockEndDay(state.day, grandfatherMonths);
  const share = stepShare(grandfatherMonths === 0 ? 'notice' : 'grandfather');
  const next = TIER_IDS.map((id) => settings.get(id) as TierSetting);
  const L1 = zeroTiers();
  const L0 = zeroTiers();
  const destination = new Map<TierId, TierId | null>();
  for (const setting of next) {
    L1[setting.id] = setting.price;
    L0[setting.id] = tierOf(pricing, setting.id).price;
    if (!setting.offered) destination.set(setting.id, retireDestination(next, setting.id));
  }
  const bill = (household: number, kind: ParcelKind) => (kind === 'smb' ? Math.round(household * smbMultiplier) : household);

  let unitsRising = 0;
  let unitsFalling = 0;
  let unitsMoving = 0;
  let mrrNow = 0;
  let mrrAfterLocks = 0;
  let expectedChurn = 0;
  let created = false;
  for (const account of state.sales.accounts) {
    const kind = state.city.parcels[account.parcel]?.kind ?? 'home';
    for (const id of TIER_IDS) {
      const n = account.tierUnits[id];
      if (n === 0) continue;
      const lock = lockOn(account, id);
      const paidToday = lock ? Math.min(lock.price, L0[id]) : L0[id];
      // The unit's lock right after the change.
      let lockPrice: number | null = lock ? lock.price : null;
      const creates = !lock && L1[id] > L0[id];
      if (creates) lockPrice = L0[id];
      if (lockPrice !== null && lockPrice >= L1[id]) lockPrice = null;
      const payNow = lockPrice !== null ? lockPrice : L1[id];
      mrrNow += n * bill(payNow, kind);
      if (destination.has(id)) {
        unitsMoving += n;
        const to = destination.get(id) ?? id;
        mrrAfterLocks += n * bill(L1[to], kind);
        expectedChurn += n * retireChurnProbability(payNow, L1[to]);
        continue;
      }
      if (L1[id] > L0[id]) unitsRising += n;
      if (L1[id] < paidToday) unitsFalling += n;
      mrrAfterLocks += n * bill(creates ? L1[id] : payNow, kind);
      if (creates) {
        created = true;
        expectedChurn += n * stepChurnProbability(L0[id], L1[id], share);
      } else if (lock && lockPrice !== null && L1[id] > L0[id]) {
        const s = stepShare(lock.reason);
        expectedChurn += n * Math.max(0, stepChurnProbability(lockPrice, L1[id], s) - stepChurnProbability(lockPrice, L0[id], s));
      }
    }
  }
  return {
    ok: true,
    reasons: [],
    grandfatherMonths,
    unitsRising,
    unitsFalling,
    locksEndDay: created ? untilDay : null,
    mrrNow,
    mrrAfterLocks,
    unitsMoving,
    expectedChurn: Math.round(expectedChurn),
  };
}
