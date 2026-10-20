import { describe, expect, it } from 'vitest';
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
  MARKETING_HALF_SAT_PER_PASSING,
  MARKETING_MAX_BOOST,
  MARKETING_MAX_PER_MONTH,
  MDU_PORTS_PER_BUILDING,
  MDU_ROUTER_COST,
  OVERHEAD_PER_MONTH,
  SMB_MULTIPLIER_MAX,
  SMB_MULTIPLIER_MIN,
  SPLIT_RATIO,
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
} from './balance';
import { applyCommand, newGame, runDays } from './game';
import { getService } from './network';
import { withRng } from './rng';
import {
  accountPorts,
  accountUnits,
  cabinetPortsUsed,
  churnProbability,
  closeSalesMonth,
  defaultPricing,
  INSTALL_NOTICE_KIND,
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
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { Account, CabinetId, City, GameState, ParcelKind, Pricing, Tier, TierId, TierSetting } from './types';

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
  return { parcel, cabinet, tierUnits: tierUnits(units), since };
}

function noticesOf(state: GameState, kind: string, prefix = ''): number {
  return state.notices.filter((n) => n.kind === kind && n.message.startsWith(prefix)).length;
}

const ALL_KINDS: readonly ParcelKind[] = ['home', 'mdu', 'smb'];

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
});

describe('tierMix', () => {
  const sum = (mix: Record<TierId, number>) => TIER_IDS.reduce((s, id) => s + mix[id], 0);

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
      const { state } = litTown({ rngSales });
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

  it('never sells an unoffered tier, and grandfathers its subscribers', () => {
    const { state, cabinet } = litTown({ marketing: LOUD });
    state.sales.accounts = [account(0, cabinet, { fiber2g: 1 }), account(1, cabinet, { fiber2g: 1 })];
    const pricing = settings(state.sales.pricing).map((t) => (t.id === 'fiber2g' ? { ...t, offered: false } : t));
    expect(setPricing(state, pricing, state.sales.pricing.smbMultiplier)).toEqual({ ok: true, cost: 0 });
    step(state, 90);
    const on2g = state.sales.accounts.filter((a) => a.tierUnits.fiber2g > 0).map((a) => a.parcel);
    expect(on2g).toEqual([0, 1]);
    expect(subscriberUnits(state)).toBeGreaterThan(10);
    // Grandfathered units still bill at the tier's (still editable) price.
    const expected = state.sales.accounts.reduce(
      (s, a) => s + TIER_IDS.reduce((t, id) => t + a.tierUnits[id] * unitPrice(state.sales.pricing, id, 'home'), 0),
      0,
    );
    expect(monthlyRecurringRevenue(state)).toBe(expected);
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
    expect(noticesOf(state, INSTALL_NOTICE_KIND, INSTALLS_PAUSED_PREFIX)).toBe(1);
    expect(noticesOf(state, INSTALL_NOTICE_KIND, INSTALLS_RESUMED_PREFIX)).toBe(0);
    expect(installsPaused(state)).toBe(true);
    const paused = state.notices.find((n) => n.message.startsWith(INSTALLS_PAUSED_PREFIX))!;
    expect(paused).toMatchObject({ cabinet: null, milestone: null });

    // The demand waited: with cash back, signups come at once.
    state.finance.cash = 1_000_000;
    step(state, 5);
    expect(subscriberUnits(state)).toBeGreaterThan(0);
    expect(noticesOf(state, INSTALL_NOTICE_KIND, INSTALLS_RESUMED_PREFIX)).toBe(1);
    expect(installsPaused(state)).toBe(false);
    step(state, 30);
    expect(noticesOf(state, INSTALL_NOTICE_KIND, INSTALLS_PAUSED_PREFIX)).toBe(1);
    expect(noticesOf(state, INSTALL_NOTICE_KIND, INSTALLS_RESUMED_PREFIX)).toBe(1);
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

  it('bills a price change from the next day', () => {
    const { state, cabinet } = oneHome();
    state.day = 9;
    state.sales.accounts = [account(0, cabinet, { fiber1g: 1 }, 9)];
    const p1 = unitPrice(state.sales.pricing, 'fiber1g', 'home');
    runDays(state, 11); // day 20: steps 10..20 billed at p1
    const p2 = p1 + 25;
    const next = settings(state.sales.pricing).map((t) => (t.id === 'fiber1g' ? { ...t, price: p2 } : t));
    expect(applyCommand(state, { type: 'setPricing', tiers: next, smbMultiplier: state.sales.pricing.smbMultiplier })).toEqual({ ok: true, cost: 0 });
    runDays(state, 11); // day 31: steps 21..30 billed at p2
    expect(state.finance.reports[0]!.totals.revenue).toBe(Math.round((p1 * 11 + p2 * 10) / 31));
  });

  it('bills businesses at the multiplied price', () => {
    const { state, cabinet } = oneHome('smb');
    state.sales.accounts = [account(0, cabinet, { fiber500: 1 })];
    state.sales.pricing.smbMultiplier = 2.25;
    runDays(state, 31);
    const rate = unitPrice(state.sales.pricing, 'fiber500', 'smb');
    expect(rate).toBe(Math.round(state.sales.pricing.tiers[0]!.price * 2.25));
    expect(state.finance.reports[0]!.totals.revenue).toBe(Math.round((rate * 30) / 31));
  });

  it('accrues marketing per day, so a mid-month budget change counts from the next day', () => {
    const state = makeTestState(TOWN);
    const m1 = state.sales.marketingPerMonth;
    runDays(state, 15);
    expect(state.sales.month.marketingDollarDays).toBe(m1 * 15);
    const m2 = m1 + 3_000;
    expect(applyCommand(state, { type: 'setMarketing', perMonth: m2 })).toEqual({ ok: true, cost: 0 });
    runDays(state, 16); // Feb 1 close: days 16..30 at m2
    expect(state.finance.reports[0]!.totals.marketing).toBe(-Math.round((m1 * 15 + m2 * 15) / 31));
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
      grossAdds: month.grossAdds,
      churned: subs - subscriberUnits(state),
      lostService: month.lostService,
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
    expect(close).toEqual({ revenue: 0, marketing: 0, support: 0, grossAdds: 0, churned: 0, lostService: 0 });
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

