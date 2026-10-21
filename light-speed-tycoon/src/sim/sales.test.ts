import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHURN_MONTHLY_BASE,
  CHURN_MONTHLY_MAX,
  CHURN_PRICE_SENSITIVITY,
  GRANDFATHER_MONTHS_DEFAULT,
  GRANDFATHER_MONTHS_MAX,
  GRANDFATHER_STEP_SHARE,
  INCUMBENT_DOWN_MBPS,
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_CHURN,
  INCUMBENT_PROMO_DISCOUNT,
  INCUMBENT_UP_MBPS,
  INSTALL_COST_HOME,
  INSTALL_COST_MDU_UNIT,
  INSTALL_COST_SMB,
  MARKETING_HALF_SAT_PER_PASSING,
  MARKETING_MAX_BOOST,
  MARKETING_MAX_PER_MONTH,
  MDU_PORTS_PER_BUILDING,
  MDU_ROUTER_COST,
  NOTICE_LOG_MAX,
  OVERHEAD_PER_MONTH,
  PRICE_STEP_CHURN_MAX,
  PRICE_STEP_CHURN_PER_RISE,
  PROMO_HORIZON_MONTHS,
  PROMO_MAX_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  PROMO_STEP_SHARE,
  SMB_MULTIPLIER_DEFAULT,
  SMB_MULTIPLIER_MAX,
  SMB_MULTIPLIER_MIN,
  SPLIT_RATIO,
  SPLITTER_COST,
  START_CASH,
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
  TIER_RETIRE_CHURN_BASE,
  TIER_RETIRE_CHURN_MAX,
  TIER_RETIRE_CHURN_PER_RISE,
  CHURN_TOTAL_MAX,
} from './balance';
import { dateOf, dayOf, MONTH_LENGTHS } from './calendar';
import { incumbentChurnFor } from './incumbent';
import { applyCommand, newGame, runDays } from './game';
import { getService, quoteRemoveCabinet, quoteRemoveSpan } from './network';
import { postNotice } from './notices';
import { withRng } from './rng';
import { deserialize, serialize } from './save';
import {
  accountPorts,
  accountUnitPrice,
  accrueDay,
  accountUnits,
  cabinetPortCapacity,
  cabinetPortsUsed,
  churnProbability,
  closeDayAfter,
  closeSalesMonth,
  defaultPricing,
  lockEndDay,
  promoDiscountShare,
  promoPrice,
  quotePricing,
  retireChurnProbability,
  retireDestination,
  setPromo,
  stateTakeRate,
  stepChurnProbability,
  stepShare,
  totalChurn,
  unitsByTier,
  INSTALLS_PAUSED_PREFIX,
  INSTALLS_RESUMED_PREFIX,
  installCost,
  installsPaused,
  marketingBoost,
  monthlyRecurringRevenue,
  segmentOffset,
  setMarketing,
  setPricing,
  stepSales,
  subscriberUnits,
  targetTakeRate,
  TIER_IDS,
  tierMix,
  unitPrice,
} from './sales';
import type { SalesClose } from './sales';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { Account, CabinetId, City, GameState, IntroPromo, ParcelKind, PriceLock, Pricing, Tier, TierId, TierSetting } from './types';
import { outageChurnProbability } from './weather';

// The sales town: 4x4 blocks of 4x2 cells with the CO (and its cabinet) in the
// middle, so every street is well within cabinet reach: 128 one-unit homes.
const TOWN = makeGridCity({ cols: 4, rows: 4, coAt: [2, 2] });
const HOMES = TOWN.parcels.length;
/** A budget near full marketing boost for these small towns, cheap enough to run for years on START_CASH. */
const LOUD = Math.min(20_000, MARKETING_MAX_PER_MONTH);
/** Splitters enough that ports never bind in TOWN. */
const ROOMY = Math.ceil(HOMES / SPLIT_RATIO) + 1;

interface Lit {
  state: GameState;
  cabinet: CabinetId;
}

function litTown(opts: { city?: City; rngSales?: number; splitters?: number; marketing?: number } = {}): Lit {
  const state = makeTestState(opts.city ?? TOWN, { rngSales: opts.rngSales ?? 54321 });
  const cabinet = addLivePlant(state, { splitters: opts.splitters ?? ROOMY }) as CabinetId;
  if (opts.marketing !== undefined) state.sales.marketingPerMonth = opts.marketing;
  // Years of overhead and marketing with no plant to pay for: never let a sales test go bankrupt.
  state.finance.cash = START_CASH * 10;
  return { state, cabinet };
}

/** Advance to the next day and run only the sales step (no month close, no network progress). */
function step(state: GameState, days = 1): void {
  for (let i = 0; i < days; i++) {
    state.day++;
    withRng(state, 'sales', (rng) => stepSales(state, rng));
  }
}

function takeRate(state: GameState): number {
  return subscriberUnits(state) / getService(state).passings;
}

function pricingWith(prices: Partial<Record<TierId, number>>, offered: Partial<Record<TierId, boolean>> = {}): Pricing {
  const pricing = defaultPricing();
  for (const tier of pricing.tiers) {
    tier.price = prices[tier.id] ?? tier.price;
    tier.offered = offered[tier.id] ?? tier.offered;
  }
  return pricing;
}

/** Only `id` offered, at `price`. */
function only(id: TierId, price: number): Pricing {
  const pricing = defaultPricing();
  for (const tier of pricing.tiers) tier.offered = tier.id === id;
  pricing.tiers.find((t) => t.id === id)!.price = price;
  return pricing;
}

function settings(pricing: Pricing): TierSetting[] {
  return pricing.tiers.map((t) => ({ id: t.id, price: t.price, offered: t.offered }));
}

/** The balance.ts value formula, written out independently. */
function value(t: Tier): number {
  return (
    TAKE_SPEED_WEIGHT * Math.min(t.downMbps / INCUMBENT_DOWN_MBPS, TAKE_SPEED_RATIO_CAP) +
    TAKE_UPLOAD_WEIGHT * Math.min(t.upMbps / INCUMBENT_UP_MBPS, TAKE_UPLOAD_RATIO_CAP) -
    (TAKE_PRICE_WEIGHT * t.price) / INCUMBENT_PRICE
  );
}
const INCUMBENT = TAKE_SPEED_WEIGHT + TAKE_UPLOAD_WEIGHT - TAKE_PRICE_WEIGHT;

function tierUnits(units: Partial<Record<TierId, number>>): Record<TierId, number> {
  return { fiber500: units.fiber500 ?? 0, fiber1g: units.fiber1g ?? 0, fiber2g: units.fiber2g ?? 0 };
}

function account(parcel: number, cabinet: CabinetId, units: Partial<Record<TierId, number>>, since = 0): Account {
  return { parcel, cabinet, tierUnits: tierUnits(units), since, locks: [] };
}

function noticesOf(state: GameState, kind: string, prefix = ''): number {
  return state.notices.filter((n) => n.kind === kind && n.message.startsWith(prefix)).length;
}

const ALL_KINDS: readonly ParcelKind[] = ['home', 'mdu', 'smb'];

/**
 * Keep the incumbent from answering at `cabinet` (a quiet record that never
 * ends), for tests of the base take-rate model in towns big enough to trigger it.
 */
function quietIncumbent(state: GameState, cabinet: CabinetId): void {
  state.sales.incumbentPromos = [{ cabinet, startDay: 0, endDay: 1, price: INCUMBENT_PRICE, quietUntil: 1_000_000 }];
}

/**
 * Run the sales part of the month close that falls on the next 1st of a
 * month (state.day moves there; the ended month's last day is the day
 * before), as finance.closeMonth does.
 */
function closeAt(state: GameState): SalesClose {
  state.day = closeDayAfter(state.day, 1);
  const date = dateOf(state.day - 1);
  return withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, MONTH_LENGTHS[date.month - 1]!, state.day - 1));
}

describe('targetTakeRate', () => {
  it('follows the documented formula for the default lineup', () => {
    const pricing = defaultPricing();
    const advantage = Math.max(...pricing.tiers.map(value)) - INCUMBENT;
    const raw = TAKE_RATE_BASE + TAKE_RATE_PER_ADVANTAGE * advantage;
    const clamped = Math.min(TAKE_RATE_MAX, Math.max(TAKE_RATE_MIN, raw));
    for (const kind of ALL_KINDS) {
      expect(targetTakeRate(pricing, kind)).toBeCloseTo(clamped * TAKE_RATE_KIND_FACTOR[kind], 12);
    }
  });

  it('falls as the price rises', () => {
    const rates: number[] = [];
    for (let price = TIER_PRICE_MIN; price <= TIER_PRICE_MAX; price += 10) rates.push(targetTakeRate(only('fiber1g', price), 'home'));
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThanOrEqual(rates[i - 1]!);
    expect(rates.at(-1)!).toBeLessThan(rates[0]!);
  });

  it('rises with speed at the same price', () => {
    const price = TIER_DEFAULTS[0]!.price;
    const r500 = targetTakeRate(only('fiber500', price), 'home');
    const r1g = targetTakeRate(only('fiber1g', price), 'home');
    const r2g = targetTakeRate(only('fiber2g', price), 'home');
    expect(r1g).toBeGreaterThan(r500);
    expect(r2g).toBeGreaterThan(r1g);
  });

  it('only counts the best offered tier', () => {
    const all = defaultPricing();
    const best = all.tiers.reduce((a, b) => (value(b) > value(a) ? b : a));
    expect(targetTakeRate(all, 'home')).toBeCloseTo(targetTakeRate(only(best.id, best.price), 'home'), 12);
  });

  it('clamps to TAKE_RATE_MIN..TAKE_RATE_MAX before the kind factor', () => {
    const priced = (price: number) => pricingWith({ fiber500: price, fiber1g: price, fiber2g: price });
    for (const kind of ALL_KINDS) {
      expect(targetTakeRate(priced(1_000_000), kind)).toBeCloseTo(TAKE_RATE_MIN * TAKE_RATE_KIND_FACTOR[kind], 12);
      expect(targetTakeRate(priced(-1_000_000), kind)).toBeCloseTo(TAKE_RATE_MAX * TAKE_RATE_KIND_FACTOR[kind], 12);
    }
  });

  it('scales by building kind', () => {
    const pricing = defaultPricing();
    const home = targetTakeRate(pricing, 'home');
    for (const kind of ALL_KINDS) {
      expect(targetTakeRate(pricing, kind) / home).toBeCloseTo(TAKE_RATE_KIND_FACTOR[kind] / TAKE_RATE_KIND_FACTOR.home, 12);
    }
  });

  it('is 0 with nothing offered', () => {
    const pricing = pricingWith({}, { fiber500: false, fiber1g: false, fiber2g: false });
    expect(targetTakeRate(pricing, 'home')).toBe(0);
  });

  it('prices businesses out as the business multiplier rises, and leaves households alone', () => {
    const at = (smbMultiplier: number): Pricing => ({ ...defaultPricing(), smbMultiplier });
    const rates: number[] = [];
    for (let m = SMB_MULTIPLIER_MIN; m <= SMB_MULTIPLIER_MAX; m += 0.5) {
      rates.push(targetTakeRate(at(m), 'smb'));
      expect(targetTakeRate(at(m), 'home')).toBe(targetTakeRate(defaultPricing(), 'home'));
      expect(targetTakeRate(at(m), 'mdu')).toBe(targetTakeRate(defaultPricing(), 'mdu'));
    }
    for (let i = 1; i < rates.length; i++) expect(rates[i]).toBeLessThan(rates[i - 1]!);
    // At the default multiplier a business values a tier exactly as a household does.
    expect(targetTakeRate(at(SMB_MULTIPLIER_DEFAULT), 'smb')).toBe(targetTakeRate(defaultPricing(), 'smb'));
    expect(targetTakeRate(defaultPricing(), 'smb')).toBeCloseTo(targetTakeRate(defaultPricing(), 'home') * TAKE_RATE_KIND_FACTOR.smb, 12);
    // Below it, businesses sign up more readily.
    expect(targetTakeRate(at(SMB_MULTIPLIER_MIN), 'smb')).toBeGreaterThan(targetTakeRate(defaultPricing(), 'smb'));
  });
});

describe('tierMix', () => {
  const sum = (mix: Record<TierId, number>) => TIER_IDS.reduce((s, id) => s + mix[id], 0);

  it('mixes business signups on the price they pay', () => {
    const pricing = defaultPricing();
    expect(tierMix(pricing, 'smb')).toEqual(tierMix(pricing));
    expect(tierMix(pricing, 'mdu')).toEqual(tierMix(pricing));
    // Dearer business prices push businesses from the dearest tier toward the cheapest.
    // (A little dearer: far enough up, no tier beats the incumbent and offered tiers split evenly.)
    const dearer = SMB_MULTIPLIER_DEFAULT * 1.25;
    const dear = tierMix({ ...pricing, smbMultiplier: dearer }, 'smb');
    expect(sum(dear)).toBeCloseTo(1, 12);
    expect(dear.fiber500).toBeGreaterThan(tierMix(pricing).fiber500);
    expect(dear.fiber2g).toBeLessThan(tierMix(pricing).fiber2g);
    expect(tierMix({ ...pricing, smbMultiplier: SMB_MULTIPLIER_MAX })).toEqual(tierMix(pricing));
  });

  it('splits signups over offered tiers by popularity x advantage', () => {
    const pricing = defaultPricing();
    const mix = tierMix(pricing);
    expect(sum(mix)).toBeCloseTo(1, 12);
    const weight = (t: Tier) => TIER_DEFAULTS.find((d) => d.id === t.id)!.popularity * Math.max(0, value(t) - INCUMBENT);
    const total = pricing.tiers.reduce((s, t) => s + weight(t), 0);
    for (const tier of pricing.tiers) expect(mix[tier.id]).toBeCloseTo(weight(tier) / total, 12);
  });

  it('gives unoffered tiers nothing', () => {
    const mix = tierMix(pricingWith({}, { fiber2g: false }));
    expect(mix.fiber2g).toBe(0);
    expect(mix.fiber500).toBeGreaterThan(0);
    expect(sum(mix)).toBeCloseTo(1, 12);
    expect(tierMix(only('fiber1g', TIER_PRICE_MAX))).toEqual({ fiber500: 0, fiber1g: 1, fiber2g: 0 });
  });

  it('splits evenly when no offered tier beats the incumbent', () => {
    expect(tierMix(pricingWith({ fiber500: 1e6, fiber1g: 1e6, fiber2g: 1e6 }))).toEqual({
      fiber500: 1 / 3,
      fiber1g: 1 / 3,
      fiber2g: 1 / 3,
    });
    expect(tierMix(pricingWith({ fiber500: 1e6, fiber1g: 1e6, fiber2g: 1e6 }, { fiber1g: false }))).toEqual({
      fiber500: 0.5,
      fiber1g: 0,
      fiber2g: 0.5,
    });
  });
});

describe('prices, installs and ports', () => {
  it('prices businesses at the rounded multiplied price', () => {
    const pricing = defaultPricing();
    pricing.smbMultiplier = 1.5;
    for (const tier of pricing.tiers) {
      expect(unitPrice(pricing, tier.id, 'home')).toBe(tier.price);
      expect(unitPrice(pricing, tier.id, 'mdu')).toBe(tier.price);
      expect(unitPrice(pricing, tier.id, 'smb')).toBe(Math.round(tier.price * 1.5));
    }
    pricing.tiers[0]!.price = 55;
    pricing.smbMultiplier = 1.25; // 68.75
    expect(unitPrice(pricing, 'fiber500', 'smb')).toBe(69);
    pricing.smbMultiplier = 1.5; // 82.5 rounds up
    expect(unitPrice(pricing, 'fiber500', 'smb')).toBe(83);
  });

  it('charges a building router only with an apartment building first unit', () => {
    expect(installCost('home', false)).toBe(INSTALL_COST_HOME);
    expect(installCost('smb', false)).toBe(INSTALL_COST_SMB);
    expect(installCost('mdu', false)).toBe(INSTALL_COST_MDU_UNIT + MDU_ROUTER_COST);
    expect(installCost('mdu', true)).toBe(INSTALL_COST_MDU_UNIT);
    expect(installCost('home', true)).toBe(INSTALL_COST_HOME);
  });

  it('gives an apartment building one port however many units subscribe', () => {
    const city = makeGridCity({ parcelKinds: (p) => (p.id === 0 ? { kind: 'mdu', units: 40 } : p.id === 1 ? { kind: 'smb', units: 1 } : undefined) });
    const state = makeTestState(city);
    expect(MDU_PORTS_PER_BUILDING).toBe(1);
    state.sales.accounts = [account(0, 5, { fiber1g: 35 }), account(1, 5, { fiber500: 1 }), account(2, 6, { fiber2g: 1 })];
    expect(state.sales.accounts.map((a) => accountPorts(state, a))).toEqual([MDU_PORTS_PER_BUILDING, 1, 1]);
    expect(cabinetPortsUsed(state)).toEqual(new Map([[5, MDU_PORTS_PER_BUILDING + 1], [6, 1]]));
  });

  it('counts subscribers and monthly recurring revenue at today\'s prices', () => {
    const city = makeGridCity({ parcelKinds: (p) => (p.id === 0 ? { kind: 'mdu', units: 40 } : p.id === 1 ? { kind: 'smb', units: 1 } : undefined) });
    const state = makeTestState(city);
    state.sales.accounts = [account(0, 5, { fiber500: 3, fiber1g: 2 }), account(1, 5, { fiber2g: 1 }), account(2, 5, { fiber1g: 1 })];
    const p = state.sales.pricing;
    expect(subscriberUnits(state)).toBe(7);
    expect(monthlyRecurringRevenue(state)).toBe(
      3 * unitPrice(p, 'fiber500', 'mdu') + 2 * unitPrice(p, 'fiber1g', 'mdu') + unitPrice(p, 'fiber2g', 'smb') + unitPrice(p, 'fiber1g', 'home'),
    );
  });

  it('boosts the ramp with diminishing returns on marketing', () => {
    const passings = 1_000;
    expect(marketingBoost(0, passings)).toBe(0);
    let previous = 0;
    for (const m of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000]) {
      const boost = marketingBoost(m, passings);
      expect(boost).toBeGreaterThan(previous);
      // Doubling the budget less than doubles the boost.
      if (previous > 0) expect(boost).toBeLessThan(2 * previous);
      expect(boost).toBeLessThan(MARKETING_MAX_BOOST);
      previous = boost;
    }
    // Half the maximum at MARKETING_HALF_SAT_PER_PASSING dollars per passing.
    expect(marketingBoost(MARKETING_HALF_SAT_PER_PASSING * passings, passings)).toBeCloseTo(MARKETING_MAX_BOOST / 2, 12);
    // The same budget does less in a bigger footprint.
    expect(marketingBoost(5_000, 2 * passings)).toBeLessThan(marketingBoost(5_000, passings));
  });

  it('rounds segment targets with a fixed offset in [0, 1)', () => {
    const offsets = Array.from({ length: 2_000 }, (_, seg) => segmentOffset(7, seg));
    for (const o of offsets) {
      expect(o).toBeGreaterThanOrEqual(0);
      expect(o).toBeLessThan(1);
    }
    const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
    expect(segmentOffset(7, 3)).toBe(segmentOffset(7, 3));
    expect(segmentOffset(8, 3)).not.toBe(segmentOffset(7, 3));
  });
});

describe('signups', () => {
  it('ramps the take rate toward the target over a year or two', () => {
    const target = targetTakeRate(defaultPricing(), 'home');
    let early = 0;
    let late = 0;
    for (const rngSales of [1, 2, 3]) {
      const { state, cabinet } = litTown({ rngSales });
      // The base model: the incumbent never answers here (see incumbent.test.ts for when it does).
      quietIncumbent(state, cabinet);
      runDays(state, 30);
      const first = takeRate(state);
      runDays(state, 700);
      const last = takeRate(state);
      expect(first).toBeLessThan(0.75 * target);
      expect(last).toBeGreaterThan(0.8 * target);
      expect(last).toBeLessThan(1.15 * target);
      early += first;
      late += last;
    }
    expect(late).toBeGreaterThan(2 * early);
  });

  it('connects new accounts on the serving cabinet, sorted by parcel, dated the day they connect', () => {
    const { state, cabinet } = litTown({ marketing: LOUD });
    const sinceSeen = new Map<number, number>();
    for (let d = 0; d < 60; d++) {
      step(state);
      for (const a of state.sales.accounts) if (!sinceSeen.has(a.parcel)) sinceSeen.set(a.parcel, state.day);
    }
    const { accounts } = state.sales;
    expect(accounts.length).toBeGreaterThan(10);
    expect(accounts.map((a) => a.parcel)).toEqual([...new Set(accounts.map((a) => a.parcel))].sort((a, b) => a - b));
    const service = getService(state);
    for (const a of accounts) {
      expect(a.cabinet).toBe(cabinet);
      expect(service.servingCabinet.get(state.city.parcels[a.parcel]!.segment)).toBe(cabinet);
      expect(a.since).toBe(sinceSeen.get(a.parcel));
      expect(accountUnits(a)).toBe(1);
    }
    const units = subscriberUnits(state);
    expect(state.sales.connectsTotal).toBe(units);
    expect(state.sales.month.grossAdds).toBe(units);
    expect(state.finance.capex.connect).toBe(units * INSTALL_COST_HOME);
  });

  it('posts at most one itemized install entry a day, matching connect capex', () => {
    const city = makeGridCity({
      cols: 4,
      rows: 4,
      coAt: [2, 2],
      parcelKinds: (p) => (p.id % 5 === 0 ? { kind: 'mdu', units: 12 } : p.id % 5 === 1 ? { kind: 'smb', units: 1 } : undefined),
    });
    const { state } = litTown({ city, marketing: LOUD });
    step(state, 90);
    const installs = state.finance.monthToDate.filter((e) => e.category === 'install');
    expect(installs.length).toBeGreaterThan(5);
    const days = installs.map((e) => e.day);
    expect(new Set(days).size).toBe(days.length);
    expect(installs.reduce((s, e) => s + e.amount, 0)).toBe(-state.finance.capex.connect);
    for (const e of installs) {
      expect(e.amount).toBeLessThan(0);
      expect(e.memo).toMatch(/^Installs: \d+ (home|business|apartment)/);
    }
    expect(installs.some((e) => /\d+ apartments? \+ \d+ building routers?$/.test(e.memo))).toBe(true);
    expect(installs.some((e) => /\d+ business(es)?/.test(e.memo))).toBe(true);
  });

  it('charges each apartment building router once', () => {
    const city = makeGridCity({ cols: 1, rows: 1, blockW: 2, blockH: 1, parcelKinds: () => ({ kind: 'mdu', units: 30 }) });
    const { state } = litTown({ city, marketing: LOUD, splitters: 1 });
    step(state, 200);
    const units = subscriberUnits(state);
    const buildings = state.sales.accounts.length;
    expect(units).toBeGreaterThan(buildings);
    expect(state.sales.routerParcels).toEqual(state.sales.accounts.map((a) => a.parcel));
    expect(state.finance.capex.connect).toBe(buildings * MDU_ROUTER_COST + units * INSTALL_COST_MDU_UNIT);
    expect(state.sales.connectsTotal).toBe(units);
  });

  it('keeps routers paid for when every unit of a building leaves', () => {
    const city = makeGridCity({ cols: 1, rows: 1, blockW: 1, blockH: 1, parcelKinds: () => ({ kind: 'mdu', units: 10 }) });
    const { state, cabinet } = litTown({ city, marketing: 0 });
    state.sales.accounts = [account(0, cabinet, { fiber1g: 1 })];
    state.sales.routerParcels = [0];
    for (const tier of state.sales.pricing.tiers) tier.price = TIER_PRICE_MAX;
    // At CHURN_MONTHLY_MAX a year of closes almost surely churns one unit.
    let months = 0;
    while (state.sales.accounts.length > 0 && months < 200) {
      withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, 30, state.day));
      months++;
    }
    expect(state.sales.accounts).toEqual([]);
    expect(state.sales.routerParcels).toEqual([0]);
    expect(installCost('mdu', state.sales.routerParcels.includes(0))).toBe(INSTALL_COST_MDU_UNIT);
  });

  it('never signs anyone up on unlit streets', () => {
    const state = makeTestState(TOWN);
    addLivePlant(state, { node: null });
    step(state, 60);
    expect(state.sales.accounts).toEqual([]);
    const before = state.rng.sales;
    step(state);
    // Nothing lit, so not even a draw.
    expect(state.rng.sales).toBe(before);
  });

  it('ramps faster with more marketing', () => {
    let quiet = 0;
    let loud = 0;
    for (const rngSales of [1, 2, 3, 4]) {
      const a = litTown({ rngSales, marketing: 0 }).state;
      const b = litTown({ rngSales, marketing: LOUD }).state;
      step(a, 45);
      step(b, 45);
      quiet += subscriberUnits(a);
      loud += subscriberUnits(b);
    }
    expect(loud).toBeGreaterThan(quiet * 1.5);
  });

  it('never sells an unoffered tier, and keeps its subscribers on it only until the next close', () => {
    const { state, cabinet } = litTown({ marketing: LOUD });
    state.sales.accounts = [account(0, cabinet, { fiber2g: 1 }), account(1, cabinet, { fiber2g: 1 })];
    const pricing = settings(state.sales.pricing).map((t) => (t.id === 'fiber2g' ? { ...t, offered: false } : t));
    expect(setPricing(state, pricing, state.sales.pricing.smbMultiplier)).toEqual({ ok: true, cost: 0 });
    step(state, 25);
    const on2g = state.sales.accounts.filter((a) => a.tierUnits.fiber2g > 0).map((a) => a.parcel);
    expect(on2g).toEqual([0, 1]);
    expect(subscriberUnits(state)).toBeGreaterThan(5);
    // Until the close they bill at the tier's (still editable) price.
    const expected = state.sales.accounts.reduce(
      (s, a) => s + TIER_IDS.reduce((t, id) => t + a.tierUnits[id] * unitPrice(state.sales.pricing, id, 'home'), 0),
      0,
    );
    expect(monthlyRecurringRevenue(state)).toBe(expected);
    // The close moves them (or they cancel): nobody is left on 2 Gig.
    const close = closeAt(state);
    expect(state.sales.accounts.every((a) => a.tierUnits.fiber2g === 0)).toBe(true);
    expect(close.tierMoves + close.priceChurn).toBeGreaterThanOrEqual(2);
    expect(noticesOf(state, 'tierRetired')).toBe(1);
  });
});

describe('splitter ports', () => {
  it('caps a one-splitter cabinet at SPLIT_RATIO homes, says so once, and lifts the cap with more splitters', () => {
    const { state, cabinet } = litTown({ splitters: 1, marketing: LOUD });
    // The town wants more homes than one splitter has ports.
    expect(targetTakeRate(state.sales.pricing, 'home') * HOMES).toBeGreaterThan(SPLIT_RATIO * 1.25);
    for (let d = 0; d < 365; d++) {
      runDays(state, 1);
      expect(cabinetPortsUsed(state).get(cabinet) ?? 0).toBeLessThanOrEqual(SPLIT_RATIO);
    }
    expect(subscriberUnits(state)).toBeGreaterThanOrEqual(SPLIT_RATIO - 2);
    expect(state.sales.fullCabinets).toEqual([cabinet]);
    const full = state.notices.filter((n) => n.kind === 'cabinetFull');
    expect(full).toHaveLength(1);
    expect(full[0]).toMatchObject({ cabinet, milestone: null });
    expect(full[0]!.message).toMatch(/is full: add a splitter/);

    state.network.cabinets[0]!.splitters = ROOMY;
    state.network.version++;
    runDays(state, 1);
    expect(state.sales.fullCabinets).toEqual([]);
    runDays(state, 120);
    expect(subscriberUnits(state)).toBeGreaterThan(SPLIT_RATIO);
    expect(state.notices.filter((n) => n.kind === 'cabinetFull')).toHaveLength(1);
  });

  it('drops a full cabinet from the list when one splitter is added, and announces it again when it really fills', () => {
    // 192 homes: the street gap is far larger than the 32 ports one more splitter adds.
    const city = makeGridCity({ cols: 4, rows: 4, blockW: 6, coAt: [2, 2] });
    const { state, cabinet } = litTown({ city, splitters: 1, marketing: LOUD });
    const free = () => cabinetPortCapacity(state.network.cabinets[0]!) - (cabinetPortsUsed(state).get(cabinet) ?? 0);
    for (let d = 0; d < 365 && !state.sales.fullCabinets.includes(cabinet); d++) runDays(state, 1);
    expect(state.sales.fullCabinets).toEqual([cabinet]);
    expect(noticesOf(state, 'cabinetFull')).toBe(1);

    expect(applyCommand(state, { type: 'addSplitter', cabinet })).toEqual({ ok: true, cost: SPLITTER_COST });
    // The player answered: the cabinet has free ports and is no longer turning anyone away.
    expect(state.sales.fullCabinets).toEqual([]);
    runDays(state, 1);
    expect(free()).toBeGreaterThan(SPLIT_RATIO / 2);
    expect(state.sales.fullCabinets).toEqual([]);

    // It is listed again only once its ports really run out, with a second notice.
    let relisted = -1;
    for (let d = 0; d < 3 * 365 && relisted < 0; d++) {
      runDays(state, 1);
      if (state.sales.fullCabinets.includes(cabinet)) relisted = state.day;
      else expect(free()).toBeGreaterThan(0);
    }
    expect(relisted).toBeGreaterThan(0);
    expect(free()).toBe(0);
    expect(noticesOf(state, 'cabinetFull')).toBe(2);
    expect(state.notices.filter((n) => n.kind === 'cabinetFull').at(-1)).toMatchObject({ day: relisted, cabinet });
  });

  it('lets an apartment building add units on its router port while the cabinet turns new accounts away', () => {
    const city = makeGridCity({ cols: 1, rows: 1, blockW: 4, blockH: 2, parcelKinds: (p) => (p.id === 0 ? { kind: 'mdu', units: 48 } : undefined) });
    const { state, cabinet } = litTown({ city, splitters: 0, marketing: LOUD });
    state.sales.accounts = [account(0, cabinet, { fiber500: 1 })];
    state.sales.routerParcels = [0];
    step(state, 120);
    expect(state.sales.accounts.map((a) => a.parcel)).toEqual([0]);
    expect(accountUnits(state.sales.accounts[0]!)).toBeGreaterThan(1);
    expect(state.sales.fullCabinets).toEqual([cabinet]);
    expect(noticesOf(state, 'cabinetFull')).toBe(1);
  });

  it('carries many apartments on few ports', () => {
    const city = makeGridCity({ cols: 1, rows: 1, blockW: 2, blockH: 1, parcelKinds: () => ({ kind: 'mdu', units: 120 }) });
    const { state, cabinet } = litTown({ city, splitters: 1, marketing: LOUD });
    step(state, 365);
    expect(subscriberUnits(state)).toBeGreaterThan(SPLIT_RATIO);
    expect(cabinetPortsUsed(state).get(cabinet)).toBe(2 * MDU_PORTS_PER_BUILDING);
    expect(state.sales.fullCabinets).toEqual([]);
  });
});

describe('lost service', () => {
  it('drops subscribers the day after their street loses its cable', () => {
    const { state, cabinet } = litTown({ marketing: LOUD });
    step(state, 60);
    const victim = state.sales.accounts[0]!;
    const segment = state.city.parcels[victim.parcel]!.segment;
    const onSegment = state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === segment);
    const lost = onSegment.reduce((s, a) => s + accountUnits(a), 0);
    const span = state.network.spans.find((s) => s.segment === segment)!;
    const lostBefore = state.sales.month.lostService;

    expect(applyCommand(state, { type: 'removeSpan', span: span.id })).toEqual({ ok: true, cost: 0 });
    // Nothing happens until the next daily step.
    expect(state.sales.accounts).toContainEqual(victim);
    step(state);
    expect(state.sales.accounts.some((a) => state.city.parcels[a.parcel]!.segment === segment)).toBe(false);
    expect(state.sales.month.lostService - lostBefore).toBe(lost);
    const notices = state.notices.filter((n) => n.kind === 'serviceLost');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ day: state.day, cabinet });
    expect(notices[0]!.message).toMatch(new RegExp(`^${lost} subscribers? lost service at `));
  });

  it('drops every subscriber of a cabinet that is gone, once per cabinet', () => {
    const { state, cabinet } = litTown({ marketing: LOUD });
    step(state, 60);
    const units = subscriberUnits(state);
    expect(units).toBeGreaterThan(0);
    state.network.cabinets = [];
    state.network.version++;
    step(state);
    expect(state.sales.accounts).toEqual([]);
    expect(state.sales.month.lostService).toBe(units);
    const notices = state.notices.filter((n) => n.kind === 'serviceLost');
    expect(notices).toHaveLength(1);
    expect(notices[0]!.cabinet).toBe(cabinet);
    expect(notices[0]!.message).toMatch(/cabinet was removed/);
    // Reconnecting pays the install again.
    const plant = addLivePlant(state);
    const capex = state.finance.capex.connect;
    step(state, 60);
    expect(state.sales.accounts.every((a) => a.cabinet === plant)).toBe(true);
    expect(state.finance.capex.connect - capex).toBe(subscriberUnits(state) * INSTALL_COST_HOME);
  });

  it('drops the subscribers of a cabinet removed by command at the next daily step', () => {
    const { state, cabinet } = litTown({ marketing: LOUD });
    step(state, 60);
    const units = subscriberUnits(state);
    expect(units).toBeGreaterThan(0);
    const result = applyCommand(state, { type: 'removeCabinet', cabinet });
    expect(result.ok).toBe(true);
    expect(subscriberUnits(state)).toBe(units);
    step(state);
    expect(state.sales.accounts).toEqual([]);
    expect(state.sales.month.lostService).toBe(units);
    expect(state.notices.filter((n) => n.kind === 'serviceLost').map((n) => n.cabinet)).toEqual([cabinet]);
  });

  describe('when their cabinet no longer reaches them', () => {
    // One row of four 240 ft blocks, CO at node 0 with cabinet A; cabinet B at node 4,
    // the far end of 1st St. Cable on both streets, A Ave (8) and E Ave (12): a ring.
    // 1st St's second block (segment 1) is 240 ft from A and 480 ft from B, so A
    // serves it; cut 1st St's first block (segment 0) and A's way round the ring is
    // 1,680 ft, out of reach, while B still lights it.
    function ring(bSplitters = 1): { state: GameState; a: CabinetId; b: CabinetId; parcel: number; cut: number } {
      const city = makeGridCity({ cols: 4, rows: 1, blockW: 4, blockH: 2, coAt: [0, 0] });
      const state = makeTestState(city);
      const a = addLivePlant(state, { segments: [0, 1, 2, 3, 4, 5, 6, 7, 8, 12] }) as CabinetId;
      const b = addLivePlant(state, { segments: [], node: 4, splitters: bSplitters }) as CabinetId;
      state.sales.marketingPerMonth = 0;
      state.finance.cash = START_CASH * 10;
      const parcel = state.city.parcels.find((p) => p.segment === 1)!.id;
      state.sales.accounts = [account(parcel, a, { fiber1g: 1 })];
      expect(getService(state).servingCabinet.get(1)).toBe(a);
      expect(getService(state).segmentCabinets.get(1)).toEqual([a, b]);
      const cut = state.network.spans.find((s) => s.segment === 0)!.id;
      return { state, a, b, parcel, cut };
    }

    it('moves them to a cabinet that does, so removing that one later is quoted and blamed right', () => {
      const { state, a, b, cut } = ring();
      // B can take them, so cutting the cable costs nobody service.
      expect(quoteRemoveSpan(state, cut).subscribersAffected).toBe(0);
      expect(applyCommand(state, { type: 'removeSpan', span: cut }).ok).toBe(true);
      step(state);
      const service = getService(state);
      expect(service.cabinetCoverage.get(a)!.segments).not.toContain(1);
      expect(service.servingCabinet.get(1)).toBe(b);
      expect(service.segmentCabinets.get(1)).toEqual([b]);
      expect(state.sales.accounts.map((acc) => acc.cabinet)).toEqual([b]);
      expect(state.sales.month.lostService).toBe(0);
      expect(noticesOf(state, 'serviceLost')).toBe(0);

      // B now carries them: removing B is quoted as costing them service, and the notice names B.
      expect(quoteRemoveCabinet(state, b).subscribersAffected).toBe(1);
      expect(quoteRemoveCabinet(state, a).subscribersAffected).toBe(0);
      expect(applyCommand(state, { type: 'removeCabinet', cabinet: b }).ok).toBe(true);
      step(state);
      expect(state.sales.accounts).toEqual([]);
      expect(state.sales.month.lostService).toBe(1);
      const notices = state.notices.filter((n) => n.kind === 'serviceLost');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ cabinet: b });
      expect(notices[0]!.message).toMatch(/their cabinet was removed/);
    });

    it('drops them with a notice when no cabinet that reaches them has a free port, and quotes it', () => {
      const { state, a, cut } = ring(0);
      expect(quoteRemoveSpan(state, cut).subscribersAffected).toBe(1);
      expect(applyCommand(state, { type: 'removeSpan', span: cut }).ok).toBe(true);
      step(state);
      expect(state.sales.accounts).toEqual([]);
      expect(state.sales.month.lostService).toBe(1);
      const notices = state.notices.filter((n) => n.kind === 'serviceLost');
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ cabinet: a });
      expect(notices[0]!.message).toMatch(/^1 subscriber lost service at .*: no cabinet in reach of their street has a free port/);
    });
  });

  it('keeps existing subscribers on the cabinet they connected to', () => {
    const { state, cabinet } = litTown({ marketing: 0 });
    // A second active cabinet that does not serve the street: accounts stay where they are.
    const other = addLivePlant(state, { segments: [], node: 1 }) as CabinetId;
    state.sales.accounts = [account(0, other, { fiber1g: 1 })];
    step(state, 30);
    expect(state.sales.accounts.find((a) => a.parcel === 0)?.cabinet).toBe(other);
    expect(getService(state).servingCabinet.get(state.city.parcels[0]!.segment)).not.toBeUndefined();
    void cabinet;
  });
});

describe('installs and cash', () => {
  it('pauses installs when cash cannot cover one, and says so once each way', () => {
    const { state } = litTown({ marketing: LOUD });
    state.finance.cash = INSTALL_COST_HOME - 1;
    step(state, 45);
    expect(state.sales.accounts).toEqual([]);
    expect(state.finance.monthToDate.filter((e) => e.category === 'install')).toEqual([]);
    expect(state.finance.cash).toBe(INSTALL_COST_HOME - 1);
    expect(noticesOf(state, 'installsPaused', INSTALLS_PAUSED_PREFIX)).toBe(1);
    expect(noticesOf(state, 'installsResumed')).toBe(0);
    // Their own kinds: nothing rides on the insolvency warning any more.
    expect(noticesOf(state, 'insolvencyWarning')).toBe(0);
    expect(state.sales.installsPaused).toBe(true);
    expect(installsPaused(state)).toBe(true);
    const paused = state.notices.find((n) => n.kind === 'installsPaused')!;
    expect(paused).toMatchObject({ cabinet: null, milestone: null });

    // The demand waited: with cash back, signups come at once.
    state.finance.cash = 1_000_000;
    step(state, 5);
    expect(subscriberUnits(state)).toBeGreaterThan(0);
    expect(noticesOf(state, 'installsResumed', INSTALLS_RESUMED_PREFIX)).toBe(1);
    expect(state.sales.installsPaused).toBe(false);
    expect(installsPaused(state)).toBe(false);
    step(state, 30);
    expect(noticesOf(state, 'installsPaused')).toBe(1);
    expect(noticesOf(state, 'installsResumed')).toBe(1);
  });

  it('never lets a busy day of installs overdraw cash, counting the day\'s earlier installs', () => {
    // A whole generated town lit at once from a roomy CO cabinet, at full marketing:
    // some days want more installs than cash for two homes covers.
    const state = newGame(2027);
    addLivePlant(state, { splitters: 8 });
    state.sales.marketingPerMonth = MARKETING_MAX_PER_MONTH;
    const covered = 2;
    let busyDays = 0;
    let pausedDays = 0;
    for (let d = 0; d < 365; d++) {
      state.finance.cash = covered * INSTALL_COST_HOME + 10;
      const connects = state.sales.connectsTotal;
      step(state);
      expect(state.finance.cash, `day ${state.day}`).toBeGreaterThanOrEqual(0);
      if (state.sales.connectsTotal - connects >= covered) busyDays++;
      if (state.sales.installsPaused) pausedDays++;
    }
    // The cap really bound: days that filled the cash, and installs left waiting.
    expect(busyDays).toBeGreaterThan(0);
    expect(pausedDays).toBeGreaterThan(0);
    expect(noticesOf(state, 'installsPaused')).toBeGreaterThan(0);
  });

  it('remembers a pause after its notice has left the capped notice log', () => {
    const { state } = litTown({ marketing: LOUD });
    state.finance.cash = INSTALL_COST_HOME - 1;
    step(state, 10);
    expect(noticesOf(state, 'installsPaused')).toBe(1);
    // A flood of other news pushes the pause notice out of the log.
    for (let i = 0; i < NOTICE_LOG_MAX + 5; i++) postNotice(state, 'oltFull', `news ${i}`);
    expect(noticesOf(state, 'installsPaused')).toBe(0);
    step(state, 10);
    // Still paused: no second "paused" notice.
    expect(noticesOf(state, 'installsPaused')).toBe(0);
    expect(installsPaused(state)).toBe(true);
    state.finance.cash = 1_000_000;
    step(state, 5);
    // And the resume is still announced.
    expect(noticesOf(state, 'installsResumed')).toBe(1);
    expect(installsPaused(state)).toBe(false);
  });

  it('never lets installs take cash below zero', () => {
    const { state } = litTown({ marketing: LOUD });
    state.finance.cash = 5 * INSTALL_COST_HOME + 10;
    for (let d = 0; d < 90; d++) {
      step(state);
      expect(state.finance.cash).toBeGreaterThanOrEqual(0);
    }
    expect(subscriberUnits(state)).toBe(5);
    expect(state.finance.cash).toBe(10);
    expect(installsPaused(state)).toBe(true);
  });
});

describe('accruals and billing', () => {
  // One home on one street: once it subscribes nobody else can, so billing is exact.
  const ONE_HOME = makeGridCity({ cols: 1, rows: 1, blockW: 1, blockH: 1 });

  function oneHome(kind: ParcelKind = 'home'): Lit {
    const city = kind === 'home' ? ONE_HOME : makeGridCity({ cols: 1, rows: 1, blockW: 1, blockH: 1, parcelKinds: () => ({ kind, units: 1 }) });
    return litTown({ city, marketing: 0 });
  }

  it('bills a mid-month connection for the days it had service', () => {
    const { state, cabinet } = oneHome();
    state.day = 9; // Jan 10
    state.sales.accounts = [account(0, cabinet, { fiber1g: 1 }, 9)];
    runDays(state, 31 - 9); // through the Feb 1 close; steps ran on days 10..30
    const price = unitPrice(state.sales.pricing, 'fiber1g', 'home');
    const january = state.finance.reports[0]!;
    expect(january.totals.revenue).toBe(Math.round((price * 21) / 31));
    // Overhead is the fixed monthly charge plus support for the same 21 days.
    expect(january.totals.overhead).toBe(-(OVERHEAD_PER_MONTH + Math.round((SUPPORT_COST_PER_SUB_PER_MONTH * 21) / 31)));
    expect(january.totals.marketing).toBeUndefined();
    expect(january.stats!.grossAdds).toBe(0);
  });

  it('bills a price cut from the next day', () => {
    const { state, cabinet } = oneHome();
    state.day = 9;
    state.sales.accounts = [account(0, cabinet, { fiber1g: 1 }, 9)];
    const p1 = unitPrice(state.sales.pricing, 'fiber1g', 'home');
    runDays(state, 11); // day 20: steps 10..20 billed at p1
    const p2 = p1 - 15;
    const next = settings(state.sales.pricing).map((t) => (t.id === 'fiber1g' ? { ...t, price: p2 } : t));
    expect(applyCommand(state, { type: 'setPricing', tiers: next, smbMultiplier: state.sales.pricing.smbMultiplier })).toEqual({ ok: true, cost: 0 });
    runDays(state, 11); // day 31: steps 21..30 billed at p2
    expect(state.finance.reports[0]!.totals.revenue).toBe(Math.round((p1 * 11 + p2 * 10) / 31));
  });

  it('bills a price rise to existing subscribers only after their lock ends, even with no grandfathering', () => {
    const { state, cabinet } = oneHome();
    state.day = 9;
    state.sales.accounts = [account(0, cabinet, { fiber1g: 1 }, 9)];
    const p1 = unitPrice(state.sales.pricing, 'fiber1g', 'home');
    runDays(state, 11);
    const p2 = p1 + 25;
    const next = settings(state.sales.pricing).map((t) => (t.id === 'fiber1g' ? { ...t, price: p2 } : t));
    expect(applyCommand(state, { type: 'setPricing', tiers: next, smbMultiplier: state.sales.pricing.smbMultiplier, grandfatherMonths: 0 })).toEqual({
      ok: true,
      cost: 0,
    });
    // Notice: the rise reaches the next bill, so January still bills the old price in full.
    runDays(state, 11);
    expect(state.finance.reports[0]!.totals.revenue).toBe(Math.round((p1 * 21) / 31));
    // After the Feb 1 close it pays the new price (if it stayed).
    if (state.sales.accounts.length > 0) {
      expect(state.sales.accounts[0]!.locks).toEqual([]);
      expect(monthlyRecurringRevenue(state)).toBe(p2);
    }
  });

  it('bills businesses at the multiplied price', () => {
    const { state, cabinet } = oneHome('smb');
    state.sales.accounts = [account(0, cabinet, { fiber500: 1 })];
    state.sales.pricing.smbMultiplier = 2.25;
    runDays(state, 31);
    const rate = unitPrice(state.sales.pricing, 'fiber500', 'smb');
    expect(rate).toBe(Math.round(state.sales.pricing.tiers[0]!.price * 2.25));
    // Subscribed from day 0: January bills all 31 of its days.
    expect(state.finance.reports[0]!.totals.revenue).toBe(rate);
  });

  it('accrues marketing per day, so a mid-month budget change counts from the next day', () => {
    const state = makeTestState(TOWN);
    const m1 = state.sales.marketingPerMonth;
    runDays(state, 15); // days 0..15 at m1 (day 0 accrues with the first tick)
    expect(state.sales.month.marketingDollarDays).toBe(m1 * 16);
    const m2 = m1 + 3_000;
    expect(applyCommand(state, { type: 'setMarketing', perMonth: m2 })).toEqual({ ok: true, cost: 0 });
    runDays(state, 16); // Feb 1 close: days 16..30 at m2
    expect(state.finance.reports[0]!.totals.marketing).toBe(-Math.round((m1 * 16 + m2 * 15) / 31));
    expect(state.sales.month.marketingDollarDays).toBe(m2);
  });

  it('accrues subscriber-days for support and revenue after the day\'s signups', () => {
    const { state } = litTown({ marketing: LOUD });
    let unitDays = 0;
    let dollarDays = 0;
    for (let d = 0; d < 20; d++) {
      step(state);
      unitDays += subscriberUnits(state);
      dollarDays += monthlyRecurringRevenue(state);
    }
    expect(state.sales.month.subscriberUnitDays).toBe(unitDays);
    expect(state.sales.month.revenueDollarDays).toBe(dollarDays);
  });
});

describe('closeSalesMonth', () => {
  it('posts revenue, marketing and support on the last day, churns, and resets the month', () => {
    const { state } = litTown({ marketing: LOUD });
    step(state, 30);
    const month = { ...state.sales.month };
    const subs = subscriberUnits(state);
    expect(subs).toBeGreaterThan(5);
    state.day = 31;
    const close = withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, 31, 30));
    expect(close).toEqual({
      revenue: Math.round(month.revenueDollarDays / 31),
      marketing: Math.round(month.marketingDollarDays / 31),
      support: Math.round((SUPPORT_COST_PER_SUB_PER_MONTH * month.subscriberUnitDays) / 31),
      subscriberDays: month.subscriberUnitDays,
      grossAdds: month.grossAdds,
      churned: subs - subscriberUnits(state),
      lostService: month.lostService,
      tierMoves: 0,
      priceChurn: 0,
      outageChurn: 0,
      incumbentChurn: 0,
    });
    const entries = state.finance.monthToDate.filter((e) => e.category !== 'install');
    expect(entries).toEqual([
      { day: 30, category: 'revenue', amount: close.revenue, memo: `Subscriber billing for Jan 2027: ${subs} subscribers` },
      { day: 30, category: 'marketing', amount: -close.marketing, memo: 'Marketing for Jan 2027' },
      { day: 30, category: 'overhead', amount: -close.support, memo: 'Customer support' },
    ]);
    expect(state.sales.month).toEqual({ revenueDollarDays: 0, marketingDollarDays: 0, subscriberUnitDays: 0, grossAdds: 0, lostService: 0 });
  });

  it('skips empty charges', () => {
    const state = makeTestState(TOWN);
    state.sales.marketingPerMonth = 0;
    state.day = 31;
    const close = withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, 31, 30));
    expect(close).toEqual({
      revenue: 0,
      marketing: 0,
      support: 0,
      subscriberDays: 0,
      grossAdds: 0,
      churned: 0,
      lostService: 0,
      tierMoves: 0,
      priceChurn: 0,
      outageChurn: 0,
      incumbentChurn: 0,
    });
    expect(state.finance.monthToDate).toEqual([]);
  });

  it('rejects a bad month length', () => {
    const state = makeTestState(TOWN);
    expect(() => withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, 0, 30))).toThrow(RangeError);
  });
});

describe('churn', () => {
  it('rises with price above the default, up to CHURN_MONTHLY_MAX', () => {
    for (const d of TIER_DEFAULTS) {
      const tier = defaultPricing().tiers.find((t) => t.id === d.id)!;
      expect(churnProbability(tier)).toBeCloseTo(CHURN_MONTHLY_BASE, 12);
      expect(churnProbability({ ...tier, price: Math.max(1, d.price - 20) })).toBeCloseTo(CHURN_MONTHLY_BASE, 12);
      const higher = { ...tier, price: Math.round(d.price * 1.5) };
      const over = (higher.price - d.price) / d.price;
      expect(churnProbability(higher)).toBeCloseTo(Math.min(CHURN_MONTHLY_MAX, CHURN_MONTHLY_BASE * (1 + CHURN_PRICE_SENSITIVITY * over)), 12);
      expect(churnProbability({ ...tier, price: 1_000_000 })).toBe(CHURN_MONTHLY_MAX);
    }
  });

  it('churns businesses on the price they pay: more above the default multiplier, the same at it', () => {
    for (const tier of defaultPricing().tiers) {
      expect(churnProbability(tier, 'smb', SMB_MULTIPLIER_DEFAULT)).toBe(churnProbability(tier));
      expect(churnProbability(tier, 'home', SMB_MULTIPLIER_MAX)).toBe(churnProbability(tier));
      const over = SMB_MULTIPLIER_MAX / SMB_MULTIPLIER_DEFAULT - 1;
      expect(churnProbability(tier, 'smb', SMB_MULTIPLIER_MAX)).toBeCloseTo(
        Math.min(CHURN_MONTHLY_MAX, CHURN_MONTHLY_BASE * (1 + CHURN_PRICE_SENSITIVITY * over)),
        12,
      );
      expect(churnProbability(tier, 'smb', SMB_MULTIPLIER_MIN)).toBe(churnProbability(tier));
    }
  });

  it('cancels more businesses at a higher business multiplier', () => {
    const city = makeGridCity({ cols: 4, rows: 4, parcelKinds: () => ({ kind: 'smb', units: 1 }) });
    const churned = (smbMultiplier: number): number => {
      const state = makeTestState(city, { rngSales: 99 });
      state.sales.accounts = city.parcels.map((p) => account(p.id, 1, { fiber1g: 1 }));
      state.sales.pricing.smbMultiplier = smbMultiplier;
      let total = 0;
      for (let m = 0; m < 12 && state.sales.accounts.length > 0; m++) total += withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, 30, 0)).churned;
      return total;
    };
    expect(churned(SMB_MULTIPLIER_MAX)).toBeGreaterThan(churned(SMB_MULTIPLIER_DEFAULT) * 1.5);
  });

  it('cancels more subscribers at higher prices', () => {
    const city = makeGridCity({ cols: 1, rows: 1, blockW: 5, blockH: 2, parcelKinds: () => ({ kind: 'mdu', units: 100 }) });
    const churned = (price: number): number => {
      const state = makeTestState(city, { rngSales: 99 });
      state.sales.accounts = city.parcels.map((p) => account(p.id, 1, { fiber1g: 100 }));
      state.sales.pricing.tiers[1]!.price = price;
      let total = 0;
      for (let m = 0; m < 3; m++) total += withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, 30, 0)).churned;
      return total;
    };
    const base = TIER_DEFAULTS[1]!.price;
    const atDefault = churned(base);
    const doubled = churned(base * 2);
    expect(atDefault).toBeGreaterThan(0);
    expect(doubled).toBeGreaterThan(atDefault * 1.8);
  });

  it('removes accounts left with no units', () => {
    const city = makeGridCity();
    const state = makeTestState(city);
    state.sales.accounts = city.parcels.map((p) => account(p.id, 1, { fiber2g: 1 }));
    state.sales.pricing.tiers[2]!.price = 1_000_000; // CHURN_MONTHLY_MAX
    const before = state.sales.accounts.length;
    const { churned } = withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, 30, 0));
    expect(churned).toBeGreaterThan(0);
    expect(state.sales.accounts).toHaveLength(before - churned);
    expect(state.sales.accounts.every((a) => accountUnits(a) === 1)).toBe(true);
  });
});

describe('setPricing', () => {
  it('replaces prices and offered flags, in TIER_IDS order whatever the input order', () => {
    const state = makeTestState(TOWN);
    const before = structuredClone(state.sales.pricing);
    const result = setPricing(
      state,
      [
        { id: 'fiber2g', price: 120, offered: false },
        { id: 'fiber500', price: TIER_PRICE_MIN, offered: true },
        { id: 'fiber1g', price: TIER_PRICE_MAX, offered: true },
      ],
      SMB_MULTIPLIER_MAX,
    );
    expect(result).toEqual({ ok: true, cost: 0 });
    expect(state.sales.pricing.tiers.map((t) => t.id)).toEqual([...TIER_IDS]);
    expect(state.sales.pricing.tiers.map((t) => [t.price, t.offered])).toEqual([
      [TIER_PRICE_MIN, true],
      [TIER_PRICE_MAX, true],
      [120, false],
    ]);
    expect(state.sales.pricing.tiers.map((t) => [t.name, t.downMbps, t.upMbps])).toEqual(before.tiers.map((t) => [t.name, t.downMbps, t.upMbps]));
    expect(state.sales.pricing.smbMultiplier).toBe(SMB_MULTIPLIER_MAX);
    expect(state.finance.cash).toBe(makeTestState(TOWN).finance.cash);
  });

  const base = (): TierSetting[] => settings(defaultPricing());
  const cases: Array<[string, unknown, unknown, RegExp]> = [
    ['a non-array', 'all', 1.5, /needs a list of tiers/],
    ['a null tier', [null, ...base().slice(1)], 1.5, /each \{ id, price, offered \}/],
    ['an unknown tier', [...base().slice(0, 2), { id: 'fiber10g', price: 100, offered: true }], 1.5, /Unknown tier: "fiber10g"/],
    ['a duplicate tier', [...base(), base()[0]], 1.5, /500 Mbps tier is listed twice/],
    ['a missing tier', base().slice(0, 2), 1.5, /missing 2 Gig/],
    ['an empty list', [], 1.5, /missing 500 Mbps, 1 Gig, 2 Gig/],
    ['a fractional price', base().map((t, i) => (i === 0 ? { ...t, price: 55.5 } : t)), 1.5, /500 Mbps price must be a whole number .* got 55\.5/],
    ['a price below the minimum', base().map((t, i) => (i === 1 ? { ...t, price: TIER_PRICE_MIN - 1 } : t)), 1.5, /1 Gig price must be/],
    ['a price above the maximum', base().map((t, i) => (i === 2 ? { ...t, price: TIER_PRICE_MAX + 1 } : t)), 1.5, /2 Gig price must be/],
    ['a NaN price', base().map((t, i) => (i === 2 ? { ...t, price: Number.NaN } : t)), 1.5, /2 Gig price must be/],
    ['a string price', base().map((t, i) => (i === 2 ? { ...t, price: '60' } : t)), 1.5, /2 Gig price must be/],
    ['a non-boolean offered', base().map((t, i) => (i === 0 ? { ...t, offered: 1 } : t)), 1.5, /needs offered: true or false/],
    ['nothing offered', base().map((t) => ({ ...t, offered: false })), 1.5, /Offer at least one tier/],
    ['a multiplier below the minimum', base(), SMB_MULTIPLIER_MIN - 0.01, /business price multiplier must be from/],
    ['a multiplier above the maximum', base(), SMB_MULTIPLIER_MAX + 0.01, /business price multiplier/],
    ['a NaN multiplier', base(), Number.NaN, /business price multiplier/],
    ['an infinite multiplier', base(), Number.POSITIVE_INFINITY, /business price multiplier/],
  ];
  it.each(cases)('rejects %s and leaves the game untouched', (_name, tiers, multiplier, reason) => {
    const state = makeTestState(TOWN);
    const before = structuredClone(state);
    const result = setPricing(state, tiers as TierSetting[], multiplier as number);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(reason);
    expect(state).toEqual(before);
  });
});

describe('setMarketing', () => {
  it.each([0, 1, MARKETING_MAX_PER_MONTH])('accepts %d', (perMonth) => {
    const state = makeTestState(TOWN);
    expect(setMarketing(state, perMonth)).toEqual({ ok: true, cost: 0 });
    expect(state.sales.marketingPerMonth).toBe(perMonth);
  });

  it.each([-1, 0.5, MARKETING_MAX_PER_MONTH + 1, Number.NaN, Number.POSITIVE_INFINITY])('rejects %d', (perMonth) => {
    const state = makeTestState(TOWN);
    const before = structuredClone(state);
    const result = setMarketing(state, perMonth);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(/marketing budget must be a whole number/);
    expect(state).toEqual(before);
  });
});

describe('performance', () => {
  it('steps a fully lit generated town in well under a millisecond', () => {
    const state = newGame(5);
    addLivePlant(state);
    for (const cabinet of state.network.cabinets) cabinet.splitters = 1_000;
    state.sales.marketingPerMonth = LOUD;
    const times: number[] = [];
    for (let d = 0; d < 300; d++) {
      state.day++;
      getService(state); // the network's share of the day, not timed here
      const start = performance.now();
      withRng(state, 'sales', (rng) => stepSales(state, rng));
      times.push(performance.now() - start);
    }
    expect(subscriberUnits(state)).toBeGreaterThan(100);
    times.sort((a, b) => a - b);
    // Typically ~0.2 ms.
    expect(times[times.length >> 1]!).toBeLessThan(1);
  });
});


// ---------------------------------------------------------------------------
// Round 4: price locks, intro promos, tier retirement, churn causes, the
// incumbent's local price, outages, the pricing quote
// ---------------------------------------------------------------------------

/** Apartment buildings only: `parcels` buildings (a multiple of 20) of `units` each, for churn statistics. */
function towers(parcels = 40, units = 50): City {
  return makeGridCity({ cols: parcels / 20, rows: 2, blockW: 5, blockH: 2, parcelKinds: () => ({ kind: 'mdu', units }) });
}

/** A count drawn n times with probability p lands within 5 standard deviations of n x p. */
function expectNear(count: number, n: number, p: number): void {
  const sd = Math.sqrt(n * p * (1 - p));
  expect(Math.abs(count - n * p), `${count} of ${n} at p=${p}`).toBeLessThanOrEqual(5 * sd + 1);
}

function listOf(state: GameState, id: TierId): number {
  return state.sales.pricing.tiers.find((t) => t.id === id)!.price;
}

/** The game's tier settings with one tier's price (and optionally offered flag) changed. */
function withPrice(state: GameState, id: TierId, price: number, offered?: boolean): TierSetting[] {
  return settings(state.sales.pricing).map((t) => (t.id === id ? { ...t, price, offered: offered ?? t.offered } : t));
}

function lockOf(tier: TierId, price: number, untilDay: number, reason: PriceLock['reason'] = 'grandfather'): PriceLock {
  return { tier, price, untilDay, reason };
}

describe('price locks', () => {
  it('bill a locked tier at min(lock, list), and businesses at the multiplied lock price', () => {
    const city = makeGridCity({ parcelKinds: (p) => (p.id === 0 ? { kind: 'mdu', units: 40 } : p.id === 1 ? { kind: 'smb', units: 1 } : undefined) });
    const state = makeTestState(city);
    const l500 = listOf(state, 'fiber500');
    const l1g = listOf(state, 'fiber1g');
    const l2g = listOf(state, 'fiber2g');
    const smb = state.sales.pricing.smbMultiplier;
    state.sales.accounts = [
      { ...account(0, 5, { fiber500: 3, fiber1g: 2 }), locks: [lockOf('fiber1g', l1g - 10, 31)] },
      { ...account(1, 5, { fiber2g: 1 }), locks: [lockOf('fiber2g', l2g - 7, 31, 'promo')] },
      // A lock above the list price (a loaded save) changes nothing.
      { ...account(2, 5, { fiber500: 1 }), locks: [lockOf('fiber500', l500 + 9, 31, 'notice')] },
    ];
    const [mdu, biz, home] = state.sales.accounts as [Account, Account, Account];
    expect(accountUnitPrice(state, mdu, 'fiber1g')).toBe(l1g - 10);
    expect(accountUnitPrice(state, mdu, 'fiber500')).toBe(l500);
    expect(accountUnitPrice(state, biz, 'fiber2g')).toBe(Math.round((l2g - 7) * smb));
    expect(accountUnitPrice(state, home, 'fiber500')).toBe(l500);
    const mrr = 3 * l500 + 2 * (l1g - 10) + Math.round((l2g - 7) * smb) + l500;
    expect(monthlyRecurringRevenue(state)).toBe(mrr);
    // Billing accrues what each unit pays.
    accrueDay(state);
    expect(state.sales.month.revenueDollarDays).toBe(mrr);
  });

  it('end the month after next for 0 months, and `months` closes after that', () => {
    const mar10 = dayOf({ year: 2027, month: 3, day: 10 });
    expect(lockEndDay(mar10, 0)).toBe(dayOf({ year: 2027, month: 4, day: 1 }));
    expect(lockEndDay(mar10, 3)).toBe(dayOf({ year: 2027, month: 7, day: 1 }));
    expect(lockEndDay(dayOf({ year: 2027, month: 11, day: 1 }), 2)).toBe(dayOf({ year: 2028, month: 2, day: 1 }));
    expect(lockEndDay(0, 0)).toBe(31);
    expect(closeDayAfter(mar10, 1)).toBe(dayOf({ year: 2027, month: 4, day: 1 }));
    expect(closeDayAfter(dayOf({ year: 2027, month: 12, day: 31 }), 1)).toBe(dayOf({ year: 2028, month: 1, day: 1 }));
  });
});

describe('setPricing with grandfathering', () => {
  function priced(): GameState {
    const city = makeGridCity({ parcelKinds: (p) => (p.id === 3 ? { kind: 'mdu', units: 30 } : undefined) });
    const state = makeTestState(city);
    state.day = dayOf({ year: 2027, month: 3, day: 10 });
    state.sales.accounts = [
      account(0, 1, { fiber1g: 1 }),
      account(1, 1, { fiber500: 1 }),
      { ...account(2, 1, { fiber1g: 1 }), locks: [lockOf('fiber1g', listOf(state, 'fiber1g') - 20, dayOf({ year: 2027, month: 5, day: 1 }), 'promo')] },
      account(3, 1, { fiber500: 4, fiber2g: 6 }),
    ];
    return state;
  }

  it('locks today\'s subscribers on a rising tier at the old price until the close the months name', () => {
    const state = priced();
    const old1g = listOf(state, 'fiber1g');
    const old2g = listOf(state, 'fiber2g');
    const promoLockBefore = structuredClone(state.sales.accounts[2]!.locks);
    const tiers = settings(state.sales.pricing).map((t) =>
      t.id === 'fiber1g' ? { ...t, price: old1g + 15 } : t.id === 'fiber2g' ? { ...t, price: old2g + 10 } : t.id === 'fiber500' ? { ...t, price: t.price + 5 } : t,
    );
    expect(setPricing(state, tiers, state.sales.pricing.smbMultiplier, 3)).toEqual({ ok: true, cost: 0 });
    const until = dayOf({ year: 2027, month: 7, day: 1 });
    const [a0, a1, a2, a3] = state.sales.accounts as [Account, Account, Account, Account];
    expect(a0.locks).toEqual([lockOf('fiber1g', old1g, until, 'grandfather')]);
    expect(a1.locks).toEqual([lockOf('fiber500', TIER_DEFAULTS[0]!.price, until, 'grandfather')]);
    // An existing lock is kept as it was: no second lock, no new end day.
    expect(a2.locks).toEqual(promoLockBefore);
    // One lock per tier, in tier order, for an apartment building on two rising tiers.
    expect(a3.locks.map((l) => l.tier)).toEqual(['fiber500', 'fiber2g']);
    expect(a3.locks[1]).toEqual(lockOf('fiber2g', old2g, until, 'grandfather'));
    // They pay what they paid; a new subscriber pays the new price.
    expect(accountUnitPrice(state, a0, 'fiber1g')).toBe(old1g);
    expect(accountUnitPrice(state, account(9, 1, { fiber1g: 1 }), 'fiber1g')).toBe(old1g + 15);

    // A second rise neither re-locks nor moves the end.
    expect(setPricing(state, withPrice(state, 'fiber1g', old1g + 30), state.sales.pricing.smbMultiplier, 12)).toEqual({ ok: true, cost: 0 });
    expect(state.sales.accounts[0]!.locks).toEqual([lockOf('fiber1g', old1g, until, 'grandfather')]);
  });

  it('passes a rise on at the next bill with 0 months, and grandfathers GRANDFATHER_MONTHS_DEFAULT when not told', () => {
    const notice = priced();
    const old = listOf(notice, 'fiber1g');
    expect(setPricing(notice, withPrice(notice, 'fiber1g', old + 5), notice.sales.pricing.smbMultiplier, 0)).toEqual({ ok: true, cost: 0 });
    expect(notice.sales.accounts[0]!.locks).toEqual([lockOf('fiber1g', old, dayOf({ year: 2027, month: 4, day: 1 }), 'notice')]);

    const plain = priced();
    expect(applyCommand(plain, { type: 'setPricing', tiers: withPrice(plain, 'fiber1g', old + 5), smbMultiplier: plain.sales.pricing.smbMultiplier })).toEqual({
      ok: true,
      cost: 0,
    });
    expect(plain.sales.accounts[0]!.locks).toEqual([lockOf('fiber1g', old, lockEndDay(plain.day, GRANDFATHER_MONTHS_DEFAULT), 'grandfather')]);
  });

  it('reaches everyone at once with a cut: locks at or above the new list price go', () => {
    const state = priced();
    const old = listOf(state, 'fiber1g');
    const promoPriceHeld = state.sales.accounts[2]!.locks[0]!.price;
    setPricing(state, withPrice(state, 'fiber1g', old + 15), state.sales.pricing.smbMultiplier, 6);
    expect(state.sales.accounts[0]!.locks).toHaveLength(1);
    // Cut to between the promo price and the grandfathered one: the grandfathered lock goes, the promo stays.
    setPricing(state, withPrice(state, 'fiber1g', old - 5), state.sales.pricing.smbMultiplier, 6);
    expect(state.sales.accounts[0]!.locks).toEqual([]);
    expect(accountUnitPrice(state, state.sales.accounts[0]!, 'fiber1g')).toBe(old - 5);
    expect(state.sales.accounts[2]!.locks.map((l) => l.price)).toEqual([promoPriceHeld]);
    // Cut below the promo price too: it goes.
    setPricing(state, withPrice(state, 'fiber1g', promoPriceHeld), state.sales.pricing.smbMultiplier, 6);
    expect(state.sales.accounts[2]!.locks).toEqual([]);
  });

  it.each([-1, 1.5, GRANDFATHER_MONTHS_MAX + 1, Number.NaN])('rejects %d months of grandfathering, naming the range', (months) => {
    const state = priced();
    const before = structuredClone(state);
    const result = setPricing(state, withPrice(state, 'fiber1g', listOf(state, 'fiber1g') + 5), 1.5, months);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toContain(`from 0 to ${GRANDFATHER_MONTHS_MAX}`);
    expect(state).toEqual(before);
  });
});

describe('price steps at the close', () => {
  /** Every unit on 1 Gig, locked at `lock` until this coming close, list at `list`. */
  function stepping(reason: PriceLock['reason'], lock: number, list: number, rngSales = 7): { state: GameState; units: number } {
    const city = towers();
    const state = makeTestState(city, { rngSales });
    state.day = 40; // Feb 10: the coming close is Mar 1
    const until = closeDayAfter(state.day, 1);
    state.sales.pricing.tiers[1]!.price = list;
    state.sales.accounts = city.parcels.map((p) => ({ ...account(p.id, 1, { fiber1g: p.units }), locks: [lockOf('fiber1g', lock, until, reason)] }));
    return { state, units: subscriberUnits(state) };
  }

  it('cancel by the size of the rise and the lock reason: notice in full, grandfathered and promo prices by their shares', () => {
    const list = TIER_DEFAULTS[1]!.price;
    const lock = Math.round(list / 1.5);
    const counts: Record<string, number> = {};
    for (const reason of ['notice', 'grandfather', 'promo'] as const) {
      const { state, units } = stepping(reason, lock, list);
      const close = closeAt(state);
      const p = Math.min(PRICE_STEP_CHURN_MAX, ((PRICE_STEP_CHURN_PER_RISE * (list - lock)) / lock) * stepShare(reason));
      expect(stepChurnProbability(lock, list, stepShare(reason))).toBeCloseTo(p, 12);
      expectNear(close.priceChurn, units, p);
      expect(close.churned).toBeGreaterThan(close.priceChurn);
      expect(close.churned).toBe(units - subscriberUnits(state));
      counts[reason] = close.priceChurn;
      // Survivors pay the list price: the locks are gone.
      expect(state.sales.accounts.every((a) => a.locks.length === 0)).toBe(true);
      expect(monthlyRecurringRevenue(state)).toBe(subscriberUnits(state) * list);
      const notices = state.notices.filter((n) => n.kind === 'priceStep');
      expect(notices).toHaveLength(1);
      expect(notices[0]!.message).toContain(`Prices stepped up for ${units.toLocaleString('en-US')} subscribers`);
      expect(notices[0]!.message).toContain(`at the Feb 2027 close: ${close.priceChurn} cancelled.`);
    }
    expect(stepShare('notice')).toBe(1);
    expect(stepShare('grandfather')).toBe(GRANDFATHER_STEP_SHARE);
    expect(stepShare('promo')).toBe(PROMO_STEP_SHARE);
    expect(counts.notice!).toBeGreaterThan(counts.grandfather!);
    expect(state0Messages()).toBe(true);
    function state0Messages(): boolean {
      const { state } = stepping('promo', lock, list);
      closeAt(state);
      return state.notices.some((n) => n.kind === 'priceStep' && n.message.includes('whose intro promos ended'));
    }
  });

  it('wait for the close the lock names, and charge regular churn at the locked price meanwhile', () => {
    // List far above the default price, lock at the default: regular churn is the base rate, not the maximum.
    const { state, units } = stepping('grandfather', TIER_DEFAULTS[1]!.price, TIER_PRICE_MAX);
    for (const a of state.sales.accounts) a.locks[0]!.untilDay = closeDayAfter(state.day, 3);
    const close = closeAt(state);
    expect(close.priceChurn).toBe(0);
    expectNear(close.churned, units, CHURN_MONTHLY_BASE);
    expect(state.sales.accounts.every((a) => a.locks.length === 1)).toBe(true);
    expect(noticesOf(state, 'priceStep')).toBe(0);
  });

  it('end quietly when nothing rises (a lock at or above the list price)', () => {
    const { state } = stepping('notice', TIER_DEFAULTS[1]!.price, TIER_DEFAULTS[1]!.price);
    const close = closeAt(state);
    expect(close.priceChurn).toBe(0);
    expect(noticesOf(state, 'priceStep')).toBe(0);
    expect(state.sales.accounts.every((a) => a.locks.length === 0)).toBe(true);
  });
});

describe('intro promo', () => {
  it.each<[string, unknown, RegExp]>([
    ['0% off', { percentOff: 0, months: 3 }, new RegExp(`from 1% to ${PROMO_MAX_PERCENT_OFF}%, got 0`)],
    ['too deep', { percentOff: PROMO_MAX_PERCENT_OFF + 1, months: 3 }, new RegExp(`from 1% to ${PROMO_MAX_PERCENT_OFF}%`)],
    ['a fractional percent', { percentOff: 12.5, months: 3 }, /whole percent/],
    ['0 months', { percentOff: 10, months: 0 }, new RegExp(`from 1 to ${PROMO_MAX_MONTHS}, got 0`)],
    ['too long', { percentOff: 10, months: PROMO_MAX_MONTHS + 1 }, new RegExp(`from 1 to ${PROMO_MAX_MONTHS}`)],
    ['a string', { percentOff: 10, months: '3' }, /whole number of months/],
  ])('rejects %s, naming the range', (_name, promo, reason) => {
    const state = makeTestState(TOWN);
    const before = structuredClone(state);
    const result = setPromo(state, promo as IntroPromo);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(reason);
    expect(state).toEqual(before);
  });

  it('is set and cleared for free', () => {
    const state = makeTestState(TOWN);
    expect(setPromo(state, { percentOff: PROMO_MAX_PERCENT_OFF, months: PROMO_MAX_MONTHS })).toEqual({ ok: true, cost: 0 });
    expect(state.sales.promo).toEqual({ percentOff: PROMO_MAX_PERCENT_OFF, months: PROMO_MAX_MONTHS });
    expect(applyCommand(state, { type: 'setPromo', promo: { percentOff: 1, months: 1 } })).toEqual({ ok: true, cost: 0 });
    expect(applyCommand(state, { type: 'setPromo', promo: null })).toEqual({ ok: true, cost: 0 });
    expect(state.sales.promo).toBeNull();
    expect(state.finance.cash).toBe(makeTestState(TOWN).finance.cash);
  });

  it('is valued by the take-rate model as its discount spread over PROMO_HORIZON_MONTHS', () => {
    const pricing = defaultPricing();
    const promo: IntroPromo = { percentOff: 20, months: 6 };
    const share = (promo.percentOff / 100) * (Math.min(promo.months, PROMO_HORIZON_MONTHS) / PROMO_HORIZON_MONTHS);
    expect(promoDiscountShare(promo)).toBeCloseTo(share, 12);
    expect(promoDiscountShare(null)).toBe(0);
    const discounted: Pricing = { ...pricing, tiers: pricing.tiers.map((t) => ({ ...t, price: t.price - t.price * share })) };
    for (const kind of ALL_KINDS) {
      expect(targetTakeRate(pricing, kind, INCUMBENT_PRICE, promo)).toBeCloseTo(targetTakeRate(discounted, kind), 12);
      expect(targetTakeRate(pricing, kind, INCUMBENT_PRICE, promo)).toBeGreaterThan(targetTakeRate(pricing, kind));
      expect(targetTakeRate(pricing, kind, INCUMBENT_PRICE, null)).toBe(targetTakeRate(pricing, kind));
    }
    const mix = tierMix(pricing, 'home', INCUMBENT_PRICE, promo);
    const plain = tierMix(discounted, 'home');
    for (const id of TIER_IDS) expect(mix[id]).toBeCloseTo(plain[id], 12);
    // Deeper and longer offers are worth more.
    expect(targetTakeRate(pricing, 'home', INCUMBENT_PRICE, { percentOff: 30, months: 6 })).toBeGreaterThan(targetTakeRate(pricing, 'home', INCUMBENT_PRICE, promo));
    expect(targetTakeRate(pricing, 'home', INCUMBENT_PRICE, { percentOff: 20, months: 9 })).toBeGreaterThan(targetTakeRate(pricing, 'home', INCUMBENT_PRICE, promo));
  });

  it('locks new signups at the promo price, and an apartment building\'s next units join its lock', () => {
    const city = makeGridCity({ cols: 1, rows: 1, blockW: 2, blockH: 1, parcelKinds: () => ({ kind: 'mdu', units: 60 }) });
    const { state } = litTown({ city, marketing: LOUD, splitters: 1 });
    const list = TIER_DEFAULTS[1]!.price;
    expect(setPricing(state, settings(only('fiber1g', list)), state.sales.pricing.smbMultiplier)).toEqual({ ok: true, cost: 0 });
    expect(setPromo(state, { percentOff: 20, months: 3 })).toEqual({ ok: true, cost: 0 });
    step(state, 150);
    const price = promoPrice(list, 20);
    expect(price).toBe(Math.max(1, Math.round((list * 80) / 100)));
    expect(state.sales.accounts.length).toBeGreaterThan(0);
    for (const a of state.sales.accounts) {
      expect(a.locks).toEqual([lockOf('fiber1g', price, lockEndDay(a.since, 3), 'promo')]);
    }
    expect(state.sales.accounts.some((a) => accountUnits(a) > 1)).toBe(true);
    expect(monthlyRecurringRevenue(state)).toBe(subscriberUnits(state) * price);
  });

  it('is only for a tier the account does not have yet, and never makes a lock that is not a discount', () => {
    const city = makeGridCity({ cols: 1, rows: 1, blockW: 1, blockH: 1, parcelKinds: () => ({ kind: 'mdu', units: 60 }) });
    const { state, cabinet } = litTown({ city, marketing: LOUD, splitters: 1 });
    setPricing(state, settings(only('fiber1g', TIER_DEFAULTS[1]!.price)), state.sales.pricing.smbMultiplier);
    state.sales.accounts = [account(0, cabinet, { fiber1g: 5 })];
    state.sales.routerParcels = [0];
    setPromo(state, { percentOff: 25, months: 2 });
    step(state, 120);
    expect(accountUnits(state.sales.accounts[0]!)).toBeGreaterThan(5);
    expect(state.sales.accounts[0]!.locks).toEqual([]);

    // 1% off the cheapest allowed price rounds back to it: no lock.
    expect(promoPrice(TIER_PRICE_MIN, 1)).toBe(TIER_PRICE_MIN);
    const cheap = litTown({ marketing: LOUD });
    setPricing(cheap.state, settings(only('fiber500', TIER_PRICE_MIN)), cheap.state.sales.pricing.smbMultiplier);
    setPromo(cheap.state, { percentOff: 1, months: 2 });
    step(cheap.state, 60);
    expect(subscriberUnits(cheap.state)).toBeGreaterThan(0);
    expect(cheap.state.sales.accounts.every((a) => a.locks.length === 0)).toBe(true);
  });

  it('ends at its close with the promo share of the step', () => {
    const { state } = litTown({ marketing: LOUD });
    setPromo(state, { percentOff: 30, months: 1 });
    step(state, 20); // Jan 21
    const promoted = subscriberUnits(state);
    expect(promoted).toBeGreaterThan(0);
    const until = lockEndDay(20, 1);
    expect(state.sales.accounts.every((a) => a.locks[0]?.untilDay === lockEndDay(a.since, 1))).toBe(true);
    expect(until).toBe(dayOf({ year: 2027, month: 3, day: 1 }));
    closeAt(state); // Feb 1: not yet
    expect(state.sales.accounts.every((a) => a.locks.length === 1)).toBe(true);
    expect(noticesOf(state, 'priceStep')).toBe(0);
    closeAt(state); // Mar 1: the promo ends
    expect(state.sales.accounts.every((a) => a.locks.length === 0)).toBe(true);
    const notice = state.notices.find((n) => n.kind === 'priceStep')!;
    expect(notice.message).toMatch(/whose intro promos ended at the Feb 2027 close/);
  });
});

describe('tier retirement', () => {
  it('moves to the offered tier nearest in price, ties to the cheaper', () => {
    const tiers = (prices: [number, number, number], offered: [boolean, boolean, boolean]) =>
      TIER_IDS.map((id, i) => ({ id, price: prices[i]!, offered: offered[i]! }));
    expect(retireDestination(tiers([50, 70, 90], [true, false, true]), 'fiber1g')).toBe('fiber500');
    expect(retireDestination(tiers([50, 80, 90], [true, false, true]), 'fiber1g')).toBe('fiber2g');
    expect(retireDestination(tiers([50, 70, 90], [true, true, false]), 'fiber2g')).toBe('fiber1g');
    expect(retireDestination(tiers([50, 70, 90], [false, false, true]), 'fiber500')).toBe('fiber2g');
    expect(retireDestination(tiers([50, 70, 90], [false, true, false]), 'fiber1g')).toBeNull();
  });

  function retiring(from: TierId, offered: Record<TierId, boolean>, lockPrice?: number): { state: GameState; units: number } {
    const city = towers();
    const state = makeTestState(city, { rngSales: 11 });
    state.day = 40;
    for (const tier of state.sales.pricing.tiers) tier.offered = offered[tier.id];
    state.sales.accounts = city.parcels.map((p) => ({
      ...account(p.id, 1, { [from]: p.units }),
      locks: lockPrice === undefined ? [] : [lockOf(from, lockPrice, closeDayAfter(state.day, 6))],
    }));
    return { state, units: subscriberUnits(state) };
  }

  it('moves every unit at the next close, cancelling more the bigger the price jump', () => {
    const l500 = TIER_DEFAULTS[0]!.price;
    const l1g = TIER_DEFAULTS[1]!.price;
    const l2g = TIER_DEFAULTS[2]!.price;
    // Down a tier: the base rate.
    const down = retiring('fiber2g', { fiber500: true, fiber1g: true, fiber2g: false });
    const downClose = closeAt(down.state);
    expect(retireChurnProbability(l2g, l1g)).toBe(TIER_RETIRE_CHURN_BASE);
    expectNear(downClose.priceChurn, down.units, TIER_RETIRE_CHURN_BASE);
    expect(downClose.tierMoves).toBe(down.units - downClose.priceChurn);
    expect(unitsByTier(down.state).fiber2g).toBe(0);
    expect(downClose.churned).toBe(down.units - subscriberUnits(down.state));
    const notice = down.state.notices.find((n) => n.kind === 'tierRetired')!;
    expect(notice.message).toBe(
      `2 Gig is no longer offered: ${downClose.tierMoves.toLocaleString('en-US')} of its ${down.units.toLocaleString('en-US')} subscribers moved to 1 Gig at the Feb 2027 close and ${downClose.priceChurn} cancelled.`,
    );
    expect(noticesOf(down.state, 'tierRetired')).toBe(1);

    // Up two tiers: much more.
    const up = retiring('fiber500', { fiber500: false, fiber1g: false, fiber2g: true });
    const upClose = closeAt(up.state);
    const p = Math.min(TIER_RETIRE_CHURN_MAX, TIER_RETIRE_CHURN_BASE + TIER_RETIRE_CHURN_PER_RISE * (l2g / l500 - 1));
    expect(retireChurnProbability(l500, l2g)).toBeCloseTo(p, 12);
    expectNear(upClose.priceChurn, up.units, p);
    expect(upClose.priceChurn).toBeGreaterThan(downClose.priceChurn);
    expect(unitsByTier(up.state)).toEqual({ fiber500: 0, fiber1g: 0, fiber2g: subscriberUnits(up.state) });
  });

  it('measures the jump from what a unit paid, lock included, and drops the old tier\'s lock', () => {
    const l1g = TIER_DEFAULTS[1]!.price;
    const l2g = TIER_DEFAULTS[2]!.price;
    const lock = Math.round(l1g / 2);
    const { state, units } = retiring('fiber1g', { fiber500: false, fiber1g: false, fiber2g: true }, lock);
    const close = closeAt(state);
    expectNear(close.priceChurn, units, retireChurnProbability(lock, l2g));
    expect(state.sales.accounts.every((a) => a.locks.length === 0)).toBe(true);
    expect(monthlyRecurringRevenue(state)).toBe(subscriberUnits(state) * l2g);
  });

  it('moves the frozen v3 save\'s 2 Gig subscribers at its first close after loading', () => {
    const state = deserialize(readFileSync(new URL('./testing/v3-grid.save.json', import.meta.url), 'utf8'));
    expect(state.sales.pricing.tiers.find((t) => t.id === 'fiber2g')!.offered).toBe(false);
    const on2g = unitsByTier(state).fiber2g;
    expect(on2g).toBeGreaterThan(0);
    const reports = state.finance.reports.length;
    while (state.finance.reports.length === reports && !state.gameOver) runDays(state, 1);
    expect(unitsByTier(state).fiber2g).toBe(0);
    const ops = state.finance.reports.at(-1)!.ops!;
    expect(ops.tierMoves + ops.priceChurn).toBe(on2g);
    expect(noticesOf(state, 'tierRetired')).toBe(1);
  });
});

describe('churn causes', () => {
  it('attribute each cancellation to the price step, the outage or the incumbent its draw falls in', () => {
    const city = towers(60);
    const state = makeTestState(city, { rngSales: 3 });
    state.day = 40;
    const list = TIER_DEFAULTS[1]!.price;
    const lock = Math.round(list / 2);
    state.sales.accounts = city.parcels.map((p) => ({ ...account(p.id, 1, { fiber1g: p.units }), locks: [lockOf('fiber1g', lock, closeDayAfter(40, 1), 'notice')] }));
    const segments = [...new Set(city.parcels.map((p) => p.segment))].sort((a, b) => a - b);
    const outageDays = 6;
    state.weather.month.segmentOutageDays = segments.map((segment) => ({ segment, days: outageDays }));
    state.sales.incumbentPromos = [{ cabinet: 1, startDay: 0, endDay: 400, price: INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT, quietUntil: 600 }];
    const units = subscriberUnits(state);
    const close = closeAt(state);
    const parts = {
      regular: churnProbability({ ...state.sales.pricing.tiers[1]!, price: lock }, 'mdu'),
      price: stepChurnProbability(lock, list, 1),
      outage: outageChurnProbability(outageDays),
      incumbent: INCUMBENT_PROMO_CHURN,
    };
    expect(incumbentChurnFor(state, 1)).toBe(INCUMBENT_PROMO_CHURN);
    expect(close.churned).toBe(units - subscriberUnits(state));
    expectNear(close.churned, units, totalChurn(parts));
    expectNear(close.priceChurn, units, parts.price);
    expectNear(close.outageChurn, units, parts.outage);
    expectNear(close.incumbentChurn, units, parts.incumbent);
    const regular = close.churned - close.priceChurn - close.outageChurn - close.incumbentChurn;
    expect(regular).toBeGreaterThanOrEqual(0);
    expectNear(regular, units, parts.regular);
  });

  it('cap the total below certainty', () => {
    expect(CHURN_TOTAL_MAX).toBeLessThan(1);
    expect(totalChurn({ regular: 0.5, price: 0.5, outage: 0.5, incumbent: 0.5 })).toBe(CHURN_TOTAL_MAX);
    expect(totalChurn({ regular: 0.1, price: 0, outage: 0.05, incumbent: 0 })).toBeCloseTo(0.15, 12);
  });

  it('add outage churn only on streets interrupted in the month, and incumbent churn only where its promo ran', () => {
    const city = towers();
    const quiet = makeTestState(city, { rngSales: 5 });
    quiet.sales.accounts = city.parcels.map((p) => account(p.id, 1, { fiber500: p.units }));
    const noisy = structuredClone(quiet);
    // The promo runs at another cabinet; the outage on a street nobody here lives on.
    noisy.sales.incumbentPromos = [{ cabinet: 2, startDay: 0, endDay: 400, price: INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT, quietUntil: 600 }];
    noisy.weather.month.segmentOutageDays = [{ segment: city.segments.length - 1, days: 9 }];
    expect(city.parcels.some((p) => p.segment === city.segments.length - 1)).toBe(false);
    const a = closeAt(quiet);
    const b = closeAt(noisy);
    expect(b).toEqual(a);
    expect(a.outageChurn + a.incumbentChurn + a.priceChurn).toBe(0);
  });
});

describe('the incumbent\'s local price', () => {
  it('lowers the target take rate where it is cheaper', () => {
    const pricing = defaultPricing();
    const promo = INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT;
    const incumbent = TAKE_SPEED_WEIGHT + TAKE_UPLOAD_WEIGHT - (TAKE_PRICE_WEIGHT * promo) / INCUMBENT_PRICE;
    const advantage = Math.max(...pricing.tiers.map(value)) - incumbent;
    const clamped = Math.min(TAKE_RATE_MAX, Math.max(TAKE_RATE_MIN, TAKE_RATE_BASE + TAKE_RATE_PER_ADVANTAGE * advantage));
    for (const kind of ALL_KINDS) {
      expect(targetTakeRate(pricing, kind, promo)).toBeCloseTo(clamped * TAKE_RATE_KIND_FACTOR[kind], 12);
      expect(targetTakeRate(pricing, kind, promo)).toBeLessThan(targetTakeRate(pricing, kind));
      expect(targetTakeRate(pricing, kind, INCUMBENT_PRICE)).toBe(targetTakeRate(pricing, kind));
    }
    expect(tierMix(pricing, 'home', INCUMBENT_PRICE)).toEqual(tierMix(pricing));
  });

  it('signs up fewer households where its promo runs, and says so in the local target', () => {
    // Two big apartment buildings on one street: enough units for the averages to show.
    const city = makeGridCity({ cols: 1, rows: 1, blockW: 2, blockH: 1, parcelKinds: () => ({ kind: 'mdu', units: 500 }) });
    let calm = 0;
    let contested = 0;
    for (const rngSales of [1, 2, 3]) {
      const a = litTown({ city, rngSales, marketing: LOUD, splitters: 1 });
      const b = litTown({ city, rngSales, marketing: LOUD, splitters: 1 });
      b.state.sales.incumbentPromos = [{ cabinet: b.cabinet, startDay: 0, endDay: 10_000, price: INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT, quietUntil: 10_000 }];
      step(a.state, 365);
      step(b.state, 365);
      calm += subscriberUnits(a.state);
      contested += subscriberUnits(b.state);
      expect(stateTakeRate(b.state, 'mdu', b.cabinet)).toBeLessThan(stateTakeRate(b.state, 'mdu'));
      expect(stateTakeRate(a.state, 'mdu', a.cabinet)).toBe(stateTakeRate(a.state, 'mdu'));
    }
    // About in proportion to the two targets.
    const ratio = stateTakeRateAt(INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT) / stateTakeRateAt(INCUMBENT_PRICE);
    expect(contested / calm).toBeGreaterThan(ratio - 0.06);
    expect(contested / calm).toBeLessThan(Math.min(ratio + 0.06, 0.97));
    function stateTakeRateAt(price: number): number {
      return targetTakeRate(defaultPricing(), 'mdu', price);
    }
  });
});

describe('outages', () => {
  /** Next day's sales step with `segments` interrupted (written into today's service snapshot). */
  function stepCut(state: GameState, segments: readonly number[]): void {
    state.day++;
    const service = getService(state);
    for (const segment of segments) service.interruptedSegments.add(segment);
    withRng(state, 'sales', (rng) => stepSales(state, rng));
  }

  it('sign nobody up on an interrupted street, and keep its subscribers', () => {
    const { state, cabinet } = litTown({ marketing: LOUD });
    const cut = state.city.parcels[0]!.segment;
    state.sales.accounts = [account(0, cabinet, { fiber1g: 1 })];
    for (let d = 0; d < 120; d++) stepCut(state, [cut]);
    const onCut = state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === cut).map((a) => a.parcel);
    expect(onCut).toEqual([0]);
    expect(subscriberUnits(state)).toBeGreaterThan(10);
    expect(state.sales.month.lostService).toBe(0);
  });

  it('draw nothing when every street is cut off', () => {
    const { state } = litTown({ marketing: LOUD });
    const all = state.city.segments.map((s) => s.id);
    const before = state.rng.sales;
    for (let d = 0; d < 30; d++) stepCut(state, all);
    expect(state.rng.sales).toBe(before);
    expect(state.sales.accounts).toEqual([]);
  });
});

describe('quotePricing', () => {
  function market(): GameState {
    const city = makeGridCity({ cols: 4, rows: 2, parcelKinds: (p) => (p.id === 0 ? { kind: 'smb', units: 1 } : p.id === 1 ? { kind: 'mdu', units: 20 } : undefined) });
    const state = makeTestState(city);
    state.day = dayOf({ year: 2027, month: 6, day: 12 });
    const accounts: Account[] = [account(0, 1, { fiber1g: 1 }), account(1, 1, { fiber500: 6, fiber1g: 4 })];
    for (let p = 2; p < 12; p++) accounts.push(account(p, 1, { fiber1g: 1 }));
    for (let p = 12; p < 17; p++) accounts.push(account(p, 1, { fiber500: 1 }));
    for (let p = 17; p < 20; p++) accounts.push(account(p, 1, { fiber2g: 1 }));
    // One home already on an intro promo on 1 Gig.
    accounts[5]!.locks = [lockOf('fiber1g', listOf(state, 'fiber1g') - 20, dayOf({ year: 2027, month: 9, day: 1 }), 'promo')];
    state.sales.accounts = accounts;
    return state;
  }

  it('quotes a grandfathered rise and a cut: who rises and falls, until when, MRR now and after, the step\'s cancellations', () => {
    const state = market();
    const before = structuredClone(state);
    const old1g = listOf(state, 'fiber1g');
    const old500 = listOf(state, 'fiber500');
    const tiers = settings(state.sales.pricing).map((t) =>
      t.id === 'fiber1g' ? { ...t, price: old1g + 14 } : t.id === 'fiber500' ? { ...t, price: old500 - 5 } : t,
    );
    const q = quotePricing(state, tiers, state.sales.pricing.smbMultiplier, 4);
    expect(state).toEqual(before);
    const on1g = unitsByTier(state).fiber1g;
    expect(q).toMatchObject({ ok: true, reasons: [], grandfatherMonths: 4, unitsRising: on1g, unitsFalling: unitsByTier(state).fiber500, unitsMoving: 0 });
    expect(q.locksEndDay).toBe(lockEndDay(state.day, 4));

    const applied = structuredClone(state);
    expect(setPricing(applied, tiers, applied.sales.pricing.smbMultiplier, 4).ok).toBe(true);
    expect(q.mrrNow).toBe(monthlyRecurringRevenue(applied));
    // Once the new locks have ended (the promo lock is not one of them).
    for (const a of applied.sales.accounts) a.locks = a.locks.filter((l) => l.reason !== 'grandfather');
    expect(q.mrrAfterLocks).toBe(monthlyRecurringRevenue(applied));
    expect(q.mrrAfterLocks).toBeGreaterThan(q.mrrNow);

    const promoHolder = state.sales.accounts[5]!.locks[0]!;
    const fresh = on1g - 1;
    const expected =
      fresh * stepChurnProbability(old1g, old1g + 14, GRANDFATHER_STEP_SHARE) +
      (stepChurnProbability(promoHolder.price, old1g + 14, PROMO_STEP_SHARE) - stepChurnProbability(promoHolder.price, old1g, PROMO_STEP_SHARE));
    expect(q.expectedChurn).toBe(Math.round(expected));
  });

  it('quotes a notice rise ending at the next close with the full step', () => {
    const state = market();
    const old = listOf(state, 'fiber2g');
    const q = quotePricing(state, withPrice(state, 'fiber2g', old + 30), state.sales.pricing.smbMultiplier, 0);
    expect(q.locksEndDay).toBe(closeDayAfter(state.day, 1));
    expect(q.unitsRising).toBe(unitsByTier(state).fiber2g);
    expect(q.expectedChurn).toBe(Math.round(unitsByTier(state).fiber2g * stepChurnProbability(old, old + 30, 1)));
    // Omitted months: the default.
    expect(quotePricing(state, withPrice(state, 'fiber2g', old + 30), state.sales.pricing.smbMultiplier).grandfatherMonths).toBe(GRANDFATHER_MONTHS_DEFAULT);
  });

  it('quotes the units a retired tier moves and their expected cancellations', () => {
    const state = market();
    const q = quotePricing(state, withPrice(state, 'fiber2g', listOf(state, 'fiber2g'), false), state.sales.pricing.smbMultiplier);
    const moving = unitsByTier(state).fiber2g;
    expect(q).toMatchObject({ ok: true, unitsMoving: moving, unitsRising: 0, unitsFalling: 0, locksEndDay: null });
    expect(q.mrrNow).toBe(monthlyRecurringRevenue(state));
    expect(q.mrrAfterLocks).toBe(monthlyRecurringRevenue(state) - moving * (listOf(state, 'fiber2g') - listOf(state, 'fiber1g')));
    expect(q.expectedChurn).toBe(Math.round(moving * retireChurnProbability(listOf(state, 'fiber2g'), listOf(state, 'fiber1g'))));
  });

  it('says what setPricing would say about a bad request, and quotes today\'s figures', () => {
    const state = market();
    const mrr = monthlyRecurringRevenue(state);
    const bad = withPrice(state, 'fiber1g', TIER_PRICE_MAX + 1);
    const q = quotePricing(state, bad, state.sales.pricing.smbMultiplier, 2);
    const result = setPricing(structuredClone(state), bad, state.sales.pricing.smbMultiplier, 2);
    expect(q).toEqual({
      ok: false,
      reasons: [result.ok ? '' : result.reason],
      grandfatherMonths: 2,
      unitsRising: 0,
      unitsFalling: 0,
      locksEndDay: null,
      mrrNow: mrr,
      mrrAfterLocks: mrr,
      unitsMoving: 0,
      expectedChurn: 0,
    });
    expect(quotePricing(state, settings(state.sales.pricing), 1.5, GRANDFATHER_MONTHS_MAX + 1).ok).toBe(false);
  });
});

describe('round-4 determinism', () => {
  it('replays grandfathering, promos, retirements and the incumbent identically', () => {
    const play = (): GameState => {
      const { state } = litTown({ marketing: LOUD });
      runDays(state, 70);
      const p = state.sales.pricing;
      expect(applyCommand(state, { type: 'setPricing', tiers: withPrice(state, 'fiber1g', listOf(state, 'fiber1g') + 10), smbMultiplier: p.smbMultiplier, grandfatherMonths: 1 }).ok).toBe(true);
      expect(applyCommand(state, { type: 'setPromo', promo: { percentOff: 25, months: 2 } }).ok).toBe(true);
      runDays(state, 120);
      expect(applyCommand(state, { type: 'setPricing', tiers: withPrice(state, 'fiber2g', listOf(state, 'fiber2g'), false), smbMultiplier: p.smbMultiplier, grandfatherMonths: 0 }).ok).toBe(true);
      runDays(state, 400);
      return state;
    };
    const a = play();
    const b = play();
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const kinds = new Set(a.notices.map((n) => n.kind));
    for (const kind of ['priceStep', 'tierRetired'] as const) expect(kinds.has(kind), kind).toBe(true);
    // Through a save and load too.
    expect(serialize(deserialize(serialize(a)))).toBe(serialize(a));
  });
});
