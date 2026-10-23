// Round 4c/4d customers model (customers.ts): switching that responds to the
// deal, awareness and its sources, why homes have not switched, happiness
// with its churn and word of mouth, the three levers (commands, validation,
// saves, forecasts) and determinism. Balance values come from balance.ts or
// the module's own derived constants, never literals.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  AWARENESS_BASE_PER_DAY,
  AWARENESS_ON_LIT,
  CAMPAIGN_DAYS,
  CAMPAIGN_FADE_DAYS,
  CHURN_MONTHLY_BASE,
  CUSTOMER_QUOTE_MONTHS,
  HAPPINESS_CABLE_PREMIUM_TOLERATED,
  HAPPINESS_INSTALL_WAIT,
  HAPPINESS_OUTAGE_MEMORY_DAYS,
  HAPPINESS_PER_OUTAGE_DAY,
  HAPPINESS_PRICE_STEP,
  HAPPINESS_PRICE_STEP_MEMORY_DAYS,
  HAPPY_SCORE_MIN,
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_CHURN,
  INCUMBENT_PROMO_DISCOUNT,
  MARKETING_MAX_PER_MONTH,
  REFERRAL_CREDIT,
  REFERRAL_WOM_MULTIPLIER,
  SMB_MULTIPLIER_DEFAULT,
  START_CASH,
  SUPPORT_LEVELS,
  SWITCH_BASE_PER_DAY,
  SWITCH_DEAL_MAX,
  SWITCH_DEAL_MIN,
  SWITCH_WOM_BOOST,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
  UNHAPPY_SCORE_MAX,
} from './balance';
import { dateOf, formatMonth, MONTH_LENGTHS } from './calendar';
import {
  AWARENESS_PPM,
  accountHappiness,
  awarenessGainPerDay,
  awarenessOf,
  campaignStrength,
  campaignSwitchFactor,
  churnFromScore,
  closeCustomersMonth,
  dealAdvantage,
  dealFactor,
  forecastCustomers,
  happinessReport,
  INSTALL_WAIT_WINDOW_DAYS,
  marketingAwarenessPerDay,
  nextAwareness,
  priceScores,
  PROMO_BOOST_YOUNG_DAYS,
  quoteCampaign,
  quoteMarketing,
  quoteReferrals,
  quoteSupport,
  referralShareOf,
  stepCustomers,
  streetHappiness,
  switchingDay,
  whyNotSwitched,
  womSwitchFactor,
  SUPPORT_LEVEL_IDS,
} from './customers';
import { applyCommand, newGame, runDays } from './game';
import { getService } from './network';
import { withRng } from './rng';
import { deserialize, hashState, serialize } from './save';
import { closeDayAfter, closeSalesMonth, defaultPricing, segmentDeals, stepSales, subscriberUnits } from './sales';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { Account, CabinetId, City, GameState, IntroPromo, Pricing, SupportLevel, TierId, TierSetting } from './types';

/**
 * A support level whose customers, with nothing else to say, are happy, and
 * one whose are not (bucket thresholds are balance values: since the
 * round-4c/4d tuning a customer on Good support at the default prices is
 * happy and one on Basic is not).
 */
const HAPPY_LEVEL = SUPPORT_LEVEL_IDS.find((l) => SUPPORT_LEVELS[l].happiness >= HAPPY_SCORE_MIN) as SupportLevel;
const UNHAPPY_LEVEL = SUPPORT_LEVEL_IDS.find((l) => SUPPORT_LEVELS[l].happiness < HAPPY_SCORE_MIN) as SupportLevel;


// 128 one-unit homes, every street in reach of one cabinet at the CO.
const TOWN = makeGridCity({ cols: 4, rows: 4, coAt: [2, 2] });
// Two areas on one row: cabinet A at the CO (node 0) serves segments 0-3, cabinet B at node 8 serves 4-7.
const ROW = makeGridCity({ cols: 8, rows: 1 });

interface Lit {
  state: GameState;
  cabinet: CabinetId;
}

function litTown(opts: { city?: City; rngSales?: number; splitters?: number; marketing?: number; aware?: number } = {}): Lit {
  const state = makeTestState(opts.city ?? TOWN, { rngSales: opts.rngSales ?? 54321 });
  const cabinet = addLivePlant(state, { splitters: opts.splitters ?? 8 }) as CabinetId;
  if (opts.marketing !== undefined) state.sales.marketingPerMonth = opts.marketing;
  state.finance.cash = START_CASH * 10;
  if (opts.aware !== undefined) aware(state, opts.aware);
  return { state, cabinet };
}

/** ROW with both cabinets live and every street lit. */
function twoAreas(rngSales = 7): { state: GameState; a: CabinetId; b: CabinetId } {
  const state = makeTestState(ROW, { rngSales });
  const a = addLivePlant(state, { splitters: 4 }) as CabinetId;
  const b = addLivePlant(state, { node: 8, splitters: 4, segments: [] }) as CabinetId;
  state.finance.cash = START_CASH * 10;
  return { state, a, b };
}

/** Every lit street known to `share` of its households, lit today. */
function aware(state: GameState, share = 1): void {
  state.customers.streets = [...getService(state).litSegments].sort((a, b) => a - b).map((segment) => ({ segment, litDay: state.day, awareness: Math.round(share * AWARENESS_PPM) }));
}

/** The next day's customers and sales steps only (no close, no network or weather). */
function step(state: GameState, days = 1): void {
  for (let i = 0; i < days; i++) {
    state.day++;
    stepCustomers(state);
    withRng(state, 'sales', (rng) => stepSales(state, rng));
  }
}

function scaled(f: number): Pricing {
  const pricing = defaultPricing();
  for (const tier of pricing.tiers) tier.price = Math.min(TIER_PRICE_MAX, Math.max(TIER_PRICE_MIN, Math.round(tier.price * f)));
  return pricing;
}

function settings(pricing: Pricing): TierSetting[] {
  return pricing.tiers.map((t) => ({ id: t.id, price: t.price, offered: t.offered }));
}

function home(parcel: number, cabinet: CabinetId, tier: TierId = 'fiber1g', since = 0): Account {
  return { parcel, cabinet, tierUnits: { fiber500: 0, fiber1g: 0, fiber2g: 0, [tier]: 1 } as Account['tierUnits'], since, locks: [] };
}

/** Every home of the town subscribed (the given share of parcels, in id order). */
function subscribe(state: GameState, cabinet: CabinetId, share = 1): void {
  const n = Math.round(share * state.city.parcels.length);
  state.sales.accounts = state.city.parcels.slice(0, n).map((p) => home(p.id, cabinet));
}

/** A count drawn n times with probability p lands within 5 standard deviations of n x p. */
function expectNear(count: number, n: number, p: number): void {
  const sd = Math.sqrt(n * p * (1 - p));
  expect(Math.abs(count - n * p), `${count} of ${n} at p=${p}`).toBeLessThanOrEqual(5 * sd + 1);
}

/** Run the next month close's sales and customers parts by hand (finance.closeMonth's order), at the next 1st. */
function closeAt(state: GameState): void {
  state.day = closeDayAfter(state.day, 1);
  const date = dateOf(state.day - 1);
  withRng(state, 'sales', (rng) => closeSalesMonth(state, rng, MONTH_LENGTHS[date.month - 1]!, state.day - 1));
}

/** A generated town fully cabled with cabinets spread over it, rich enough never to pause installs. */
function bigTown(seed: number): GameState {
  const state = newGame(seed);
  addLivePlant(state, { node: null });
  const placed: { x: number; y: number }[] = [];
  for (const node of state.city.nodes) {
    if (placed.some((p) => Math.abs(p.x - node.x) + Math.abs(p.y - node.y) < 14)) continue;
    placed.push({ x: node.x, y: node.y });
    addLivePlant(state, { node: node.id, splitters: 8, segments: [] });
  }
  state.finance.cash = 1e9;
  return state;
}

const PROMO_PRICE = INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT;

// ---------------------------------------------------------------------------
// 1. Switching responds to the deal
// ---------------------------------------------------------------------------

describe('switching responds to the deal', () => {
  it('scores the deal as the take-weighted mean of the segments\' best advantage over cable', () => {
    for (const kind of ['home', 'mdu', 'smb'] as const) {
      for (const pricing of [defaultPricing(), scaled(0.85), scaled(1.2)]) {
        let weight = 0;
        let sum = 0;
        for (const deal of segmentDeals(pricing, kind)) {
          if (deal.advantage === null || deal.take <= 0) continue;
          weight += deal.share * deal.take;
          sum += deal.share * deal.take * deal.advantage;
        }
        expect(dealAdvantage(pricing, kind)).toBeCloseTo(sum / weight, 12);
      }
    }
    // Nothing suits anyone: no deal at all, and the slowest switching.
    const none = scaled(10);
    expect(dealAdvantage(none, 'home')).toBeNull();
    expect(dealFactor(none, 'home')).toBe(SWITCH_DEAL_MIN);
  });

  it('is 1 at the default lineup, faster for a better deal, slower for a dearer one or where cable runs a promo, within its clamp', () => {
    for (const kind of ['home', 'mdu', 'smb'] as const) {
      expect(dealFactor(defaultPricing(), kind)).toBeCloseTo(1, 12);
      expect(dealFactor(scaled(0.85), kind)).toBeGreaterThan(1);
      expect(dealFactor(scaled(1.2), kind)).toBeLessThan(1);
      expect(dealFactor(defaultPricing(), kind, PROMO_PRICE)).toBeLessThan(1);
      expect(dealFactor(scaled(0.2), kind)).toBeLessThanOrEqual(SWITCH_DEAL_MAX);
      expect(dealFactor(scaled(2), kind)).toBeGreaterThanOrEqual(SWITCH_DEAL_MIN);
    }
    // Cheaper is faster all the way down to the clamp.
    let previous = 0;
    for (const f of [1.3, 1.15, 1, 0.9, 0.8, 0.7]) {
      const factor = dealFactor(scaled(f), 'home');
      expect(factor).toBeGreaterThan(previous);
      previous = factor;
    }
  });

  it('values the intro promo in the deal: more for a deeper or longer offer, never past the clamp (round 4c, spec C)', () => {
    const base = dealFactor(defaultPricing(), 'home');
    const offer = (percentOff: number, months: number): number => dealFactor(defaultPricing(), 'home', INCUMBENT_PRICE, { percentOff, months });
    expect(offer(20, 3)).toBeGreaterThan(base);
    expect(offer(20, 6)).toBeGreaterThan(offer(20, 3));
    expect(offer(40, 3)).toBeGreaterThan(offer(20, 3));
    expect(offer(50, 12)).toBeLessThanOrEqual(SWITCH_DEAL_MAX);
  });

  it('switches a better deal faster and an overpriced one slower, at the same awareness', () => {
    const signups = (f: number): number => {
      let total = 0;
      for (const rngSales of [1, 2, 3, 4]) {
        const { state } = litTown({ rngSales, aware: 1 });
        if (f !== 1) expect(applyCommand(state, { type: 'setPricing', tiers: settings(scaled(f)), smbMultiplier: SMB_MULTIPLIER_DEFAULT, grandfatherMonths: 0 }).ok).toBe(true);
        step(state, 120);
        total += subscriberUnits(state);
      }
      return total;
    };
    const atDefault = signups(1);
    expect(signups(0.85)).toBeGreaterThan(atDefault * 1.2);
    expect(signups(1.2)).toBeLessThan(atDefault * 0.8);
  });

  it('shows a price cut within a couple of months', () => {
    let kept = 0;
    let cut = 0;
    for (const rngSales of [11, 12, 13]) {
      const a = litTown({ rngSales, aware: 1 });
      runDays(a.state, 200);
      const b = structuredClone(a.state);
      expect(applyCommand(b, { type: 'setPricing', tiers: settings(scaled(0.85)), smbMultiplier: SMB_MULTIPLIER_DEFAULT }).ok).toBe(true);
      const before = a.state.sales.connectsTotal;
      runDays(a.state, 61);
      runDays(b, 61);
      kept += a.state.sales.connectsTotal - before;
      cut += b.sales.connectsTotal - before;
    }
    expect(cut).toBeGreaterThan(kept * 1.15);
  });

  it('expects gap x awareness x SWITCH_BASE_PER_DAY x the deal x word of mouth x campaign x the promo\'s boost a day', () => {
    const { state, cabinet } = litTown({ aware: 0.5 });
    const segment = state.customers.streets[0]!.segment;
    const rate = (contested = false) => switchingDay(state)(segment, cabinet, contested).rate;
    expect(rate()).toBeCloseTo(0.5 * SWITCH_BASE_PER_DAY, 15);
    // A campaign at full strength.
    state.customers.campaigns = [{ cabinet, startDay: state.day, endDay: state.day + CAMPAIGN_DAYS + CAMPAIGN_FADE_DAYS, cooldownUntil: state.day + 400, cost: 0, units: 0 }];
    expect(campaignStrength(state.customers.campaigns[0]!, state.day)).toBe(1);
    expect(rate()).toBeCloseTo(0.5 * SWITCH_BASE_PER_DAY * campaignSwitchFactor(1), 15);
    expect(campaignSwitchFactor(1)).toBeGreaterThan(1);
    state.customers.campaigns = [];
    // The intro promo's boost on a young street, not on a mature one unless cable contests it.
    state.sales.promo = { percentOff: 20, months: 3 };
    const young = rate();
    expect(young).toBeGreaterThan(0.5 * SWITCH_BASE_PER_DAY);
    state.day += PROMO_BOOST_YOUNG_DAYS;
    expect(rate()).toBeCloseTo(0.5 * SWITCH_BASE_PER_DAY, 15);
    expect(rate(true)).toBeCloseTo(young, 15);
    state.sales.promo = null;
    // Word of mouth: every customer on the street happy (Great support).
    const parcel = state.city.parcels.find((p) => p.segment === segment)!;
    state.sales.accounts = [home(parcel.id, cabinet)];
    state.customers.supportLevel = 'great';
    expect(rate()).toBeCloseTo(0.5 * SWITCH_BASE_PER_DAY * womSwitchFactor(1, false), 15);
    state.customers.referrals = true;
    expect(rate()).toBeCloseTo(0.5 * SWITCH_BASE_PER_DAY * womSwitchFactor(1, true), 15);
    expect(womSwitchFactor(1, true)).toBeCloseTo(1 + SWITCH_WOM_BOOST * REFERRAL_WOM_MULTIPLIER, 12);
  });

  it('signs up in proportion to awareness', () => {
    let half = 0;
    let all = 0;
    for (const rngSales of [1, 2, 3, 4, 5, 6]) {
      const a = litTown({ rngSales, aware: 0.5 });
      const b = litTown({ rngSales, aware: 1 });
      // Sales steps only: awareness stays where it was put.
      for (let d = 0; d < 30; d++) {
        for (const s of [a.state, b.state]) {
          s.day++;
          withRng(s, 'sales', (rng) => stepSales(s, rng));
        }
      }
      half += subscriberUnits(a.state);
      all += subscriberUnits(b.state);
    }
    expect(half / all).toBeGreaterThan(0.35);
    expect(half / all).toBeLessThan(0.65);
  });
});

// ---------------------------------------------------------------------------
// 2. Awareness
// ---------------------------------------------------------------------------

describe('awareness', () => {
  it('starts a newly lit street at AWARENESS_ON_LIT, lit today, and drops it once it is dark', () => {
    const { state, a, b } = twoAreas();
    state.day = 5;
    stepCustomers(state);
    const lit = [...getService(state).litSegments].sort((x, y) => x - y);
    expect(state.customers.streets).toEqual(lit.map((segment) => ({ segment, litDay: 5, awareness: Math.round(AWARENESS_ON_LIT * AWARENESS_PPM) })));
    expect(awarenessOf(state, lit[0]!)).toBeCloseTo(AWARENESS_ON_LIT, 6);
    // Take cabinet B away: its streets go dark and leave the list.
    const bStreets = lit.filter((s) => getService(state).servingCabinet.get(s) === b);
    expect(bStreets.length).toBeGreaterThan(0);
    state.network.cabinets = state.network.cabinets.filter((c) => c.id !== b);
    state.network.version++;
    state.day++;
    stepCustomers(state);
    expect(state.customers.streets.map((s) => s.segment).some((s) => bStreets.includes(s))).toBe(false);
    expect(state.customers.streets.every((s) => getService(state).servingCabinet.get(s.segment) === a)).toBe(true);
  });

  it('grows with time alone: a += (1 - a) x AWARENESS_BASE_PER_DAY a day, in whole ppm', () => {
    const { state } = litTown({ marketing: 0 });
    state.day = 1;
    stepCustomers(state);
    let expected = Math.round(AWARENESS_ON_LIT * AWARENESS_PPM);
    for (let d = 0; d < 40; d++) {
      state.day++;
      stepCustomers(state);
      expected = nextAwareness(expected, AWARENESS_BASE_PER_DAY);
    }
    for (const street of state.customers.streets) {
      expect(street.awareness).toBe(expected);
      expect(Number.isInteger(street.awareness)).toBe(true);
    }
    expect(expected).toBeGreaterThan(Math.round(AWARENESS_ON_LIT * AWARENESS_PPM));
  });

  it('grows faster with marketing, with diminishing returns', () => {
    const quiet = litTown({ marketing: 0 }).state;
    const loud = litTown({ marketing: 5_000 }).state;
    step(quiet, 30);
    step(loud, 30);
    expect(loud.customers.streets[0]!.awareness).toBeGreaterThan(quiet.customers.streets[0]!.awareness);
    expect(marketingAwarenessPerDay(0, 100)).toBe(0);
    const one = marketingAwarenessPerDay(1_000, 500);
    expect(marketingAwarenessPerDay(2_000, 500)).toBeGreaterThan(one);
    expect(marketingAwarenessPerDay(2_000, 500)).toBeLessThan(2 * one);
    // The same budget does less over more passings.
    expect(marketingAwarenessPerDay(1_000, 1_000)).toBeLessThan(one);
  });

  it('jumps in a campaign\'s area only', () => {
    const plain = twoAreas();
    const run = structuredClone(plain.state);
    step(plain.state, 1);
    step(run, 1);
    expect(applyCommand(run, { type: 'runCampaign', cabinet: plain.a }).ok).toBe(true);
    step(plain.state, 30);
    step(run, 30);
    const service = getService(run);
    for (const street of run.customers.streets) {
      const control = plain.state.customers.streets.find((s) => s.segment === street.segment)!;
      if (service.servingCabinet.get(street.segment) === plain.a) expect(street.awareness).toBeGreaterThan(control.awareness);
      else expect(street.awareness).toBe(control.awareness);
    }
  });

  it('grows with word of mouth from happy customers on the street, twice as strong with referral credits', () => {
    expect(awarenessGainPerDay(0, 0, 1, false)).toBeGreaterThan(awarenessGainPerDay(0, 0, 0, false));
    const extra = awarenessGainPerDay(0, 0, 1, false) - awarenessGainPerDay(0, 0, 0, false);
    expect(awarenessGainPerDay(0, 0, 1, true) - awarenessGainPerDay(0, 0, 0, true)).toBeCloseTo(extra * REFERRAL_WOM_MULTIPLIER, 12);
    const build = (support: SupportLevel, referrals: boolean): GameState => {
      const { state, cabinet } = litTown({ marketing: 0 });
      state.customers.supportLevel = support;
      state.customers.referrals = referrals;
      // One customer on every street.
      const seen = new Set<number>();
      state.sales.accounts = state.city.parcels.filter((p) => !seen.has(p.segment) && seen.add(p.segment)).map((p) => home(p.id, cabinet));
      state.day = 1;
      stepCustomers(state);
      for (let d = 0; d < 20; d++) {
        state.day++;
        stepCustomers(state);
      }
      return state;
    };
    const okay = build(UNHAPPY_LEVEL, false).customers.streets[0]!.awareness;
    const happy = build(HAPPY_LEVEL, false).customers.streets[0]!.awareness;
    const referred = build(HAPPY_LEVEL, true).customers.streets[0]!.awareness;
    expect(happy).toBeGreaterThan(okay);
    expect(referred).toBeGreaterThan(happy);
  });

  it('starts a street that already has customers (a save from before round 4c/4d) from its first customer\'s day', () => {
    const { state, cabinet } = litTown();
    state.day = 300;
    state.sales.accounts = [home(0, cabinet, 'fiber1g', 100)];
    stepCustomers(state);
    const segment = state.city.parcels[0]!.segment;
    const street = state.customers.streets.find((s) => s.segment === segment)!;
    expect(street.litDay).toBe(100);
    let expected = Math.round(AWARENESS_ON_LIT * AWARENESS_PPM);
    for (let d = 0; d < 200; d++) expected = AWARENESS_PPM - (AWARENESS_PPM - expected) * (1 - AWARENESS_BASE_PER_DAY);
    expect(Math.abs(street.awareness - expected)).toBeLessThanOrEqual(2);
    // Streets without customers start from today.
    expect(state.customers.streets.filter((s) => s.segment !== segment).every((s) => s.litDay === 300)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Why homes have not switched
// ---------------------------------------------------------------------------

describe('why homes have not switched', () => {
  function checkSums(r: ReturnType<typeof whyNotSwitched>['overall']): void {
    expect(r.unaware + r.deciding + r.notWorth + r.tooExpensive + r.waiting).toBe(r.unsigned);
    expect(r.unsigned).toBe(r.passings - r.subscribed);
    for (const n of [r.unaware, r.deciding, r.notWorth, r.tooExpensive, r.waiting, r.notLit]) expect(Number.isInteger(n) && n >= 0).toBe(true);
  }

  it('gives every lit unsigned household exactly one reason, per street, area and overall', () => {
    const state = bigTown(3);
    runDays(state, 200);
    const reasons = whyNotSwitched(state);
    checkSums(reasons.overall);
    let unsigned = 0;
    let unaware = 0;
    for (const area of reasons.areas) {
      checkSums(area);
      expect(area.notLit).toBe(0);
      unsigned += area.unsigned;
      unaware += area.unaware;
    }
    expect(unsigned).toBe(reasons.overall.unsigned);
    expect(unaware).toBe(reasons.overall.unaware);
    expect(reasons.overall.passings).toBe(getService(state).passings);
    expect(reasons.overall.subscribed).toBe(subscriberUnits(state));
    // One street alone: its own counts are exact.
    const one = litTown({ city: makeGridCity({ cols: 1, rows: 1, blockW: 6, blockH: 1 }), aware: 0.37 });
    subscribe(one.state, one.cabinet, 0.2);
    const r = whyNotSwitched(one.state).overall;
    checkSums(r);
  });

  it('splits the gap by awareness: the unaware share, and the aware share deciding (they switch at your prices, in time)', () => {
    const fresh = litTown({ aware: 0 });
    const known = litTown({ aware: 1 });
    const a = whyNotSwitched(fresh.state).overall;
    const b = whyNotSwitched(known.state).overall;
    expect(a.unaware).toBeGreaterThan(0);
    expect(b.unaware).toBe(0);
    expect(a.deciding).toBe(0);
    expect(a.unaware).toBe(b.deciding);
    // Not worth switching at your price is only the households beyond the ceiling: awareness never moves them.
    expect(a.notWorth).toBe(b.notWorth);
    expect(a.waiting + b.waiting + a.tooExpensive + b.tooExpensive).toBe(0);
    // Halfway: about half the gap is unaware.
    const half = whyNotSwitched(litTown({ aware: 0.5 }).state).overall;
    expect(Math.abs(half.unaware - a.unaware / 2)).toBeLessThanOrEqual(whyNotSwitched(fresh.state).areas.length + 8);
  });

  it('a campaign moves homes from "don\'t know you" to deciding, never to "not worth switching at your price" (no price changed)', () => {
    const { state, cabinet } = litTown();
    runDays(state, 10);
    const withCampaign = deserialize(serialize(state));
    expect(applyCommand(withCampaign, { type: 'runCampaign', cabinet }).ok).toBe(true);
    runDays(state, 60);
    runDays(withCampaign, 60);
    const without = whyNotSwitched(state).overall;
    const campaign = whyNotSwitched(withCampaign).overall;
    expect(campaign.unaware).toBeLessThan(without.unaware);
    expect(campaign.deciding).toBeGreaterThan(without.deciding);
    // The ceiling at today's prices sets who is not worth it: the same on both copies (both inside their targets).
    expect(campaign.notWorth).toBe(without.notWorth);
    // Those deciding are inside the target: with no price change they keep switching.
    let deciding = campaign.deciding;
    const later = deserialize(serialize(withCampaign));
    const before = subscriberUnits(later);
    runDays(later, 240);
    expect(subscriberUnits(later) - before).toBeGreaterThan(0);
    deciding = whyNotSwitched(later).overall.deciding;
    expect(deciding).toBeLessThan(campaign.deciding);
  });

  it('counts households no offered plan suits as too expensive', () => {
    const { state } = litTown({ aware: 1 });
    expect(whyNotSwitched(state).overall.tooExpensive).toBe(0);
    // Every plan far above every segment's reservation price: nobody's target, all too expensive.
    for (const tier of state.sales.pricing.tiers) tier.price = TIER_PRICE_MAX;
    const r = whyNotSwitched(state).overall;
    expect(r.tooExpensive).toBe(r.unsigned);
    // Without a cheap tier the value seekers drop out: some too expensive, the rest not.
    const lineup = litTown({ aware: 1 }).state;
    lineup.sales.pricing.tiers.find((t) => t.id === 'fiber500')!.offered = false;
    const partial = whyNotSwitched(lineup).overall;
    expect(partial.tooExpensive).toBeGreaterThan(0);
    expect(partial.tooExpensive).toBeLessThan(partial.unsigned);
  });

  it('says the aware gap is waiting while installs are paused or the cabinet is full', () => {
    const { state, cabinet } = litTown({ aware: 1 });
    // With nobody aware the whole gap is unaware: that is the gap.
    const gap = whyNotSwitched(litTown({ aware: 0 }).state).overall.unaware;
    expect(gap).toBeGreaterThan(0);
    const normal = whyNotSwitched(state).overall;
    expect(normal.waiting).toBe(0);
    state.sales.installsPaused = true;
    const paused = whyNotSwitched(state).overall;
    expect(paused.waiting).toBe(gap);
    expect(paused.deciding).toBe(normal.deciding - gap);
    expect(paused.notWorth).toBe(normal.notWorth);
    state.sales.installsPaused = false;
    state.sales.fullCabinets = [cabinet];
    expect(whyNotSwitched(state).overall).toEqual(paused);
  });

  it('counts cabled streets that are not lit yet, overall only', () => {
    const state = makeTestState(makeGridCity());
    addLivePlant(state, { node: null });
    const r = whyNotSwitched(state);
    expect(r.overall.notLit).toBeGreaterThan(0);
    expect(r.overall.unsigned).toBe(0);
    expect(r.areas).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Happiness
// ---------------------------------------------------------------------------

describe('happiness', () => {
  it('puts every customer in a bucket from its factors: support, prices against the market and cable, memories', () => {
    const { state, cabinet } = litTown();
    subscribe(state, cabinet, 0.25);
    const account = state.sales.accounts[0]!;
    // Good support at the default prices with nothing remembered: a score of 0 (happy since the round-4c/4d tuning: HAPPY_SCORE_MIN <= 0).
    expect(accountHappiness(state, account)).toMatchObject({ score: 0, bucket: 0 >= HAPPY_SCORE_MIN ? 'happy' : 'okay', factors: [] });
    state.customers.supportLevel = 'great';
    expect(accountHappiness(state, account)).toMatchObject({ score: SUPPORT_LEVELS.great.happiness, factors: [{ reason: 'support', score: SUPPORT_LEVELS.great.happiness }] });
    expect(accountHappiness(state, account).bucket).toBe(SUPPORT_LEVELS.great.happiness >= HAPPY_SCORE_MIN ? 'happy' : 'okay');
    state.customers.supportLevel = 'good';
    // Paying under the market: a good deal; over it: unhappier.
    account.locks = [{ tier: 'fiber1g', price: 60, untilDay: 1_000, reason: 'promo' }];
    expect(accountHappiness(state, account).factors.map((f) => f.reason)).toEqual(['goodDeal']);
    account.locks = [];
    state.sales.pricing.tiers[1]!.price = 90;
    expect(accountHappiness(state, account).factors.map((f) => f.reason)).toEqual(['priceVsMarket']);
    state.sales.pricing.tiers[1]!.price = 75;
    // Where cable runs its promo: priceVsCable, nowhere else.
    state.sales.incumbentPromos = [{ cabinet, startDay: 0, endDay: 400, price: PROMO_PRICE, quietUntil: 600, triggerTakePct: 45, answered: false, answeredWithPromo: false }];
    const contested = accountHappiness(state, account);
    expect(contested.factors.map((f) => f.reason)).toEqual(['priceVsCable']);
    expect(contested.bucket).toBe('unhappy');
    state.sales.incumbentPromos = [];
    // Memories: outage days, a price step, an install wait, each while it lasts.
    state.customers.memories = [{ parcel: account.parcel, outageDays: 3, outageDay: state.day, priceStepDay: state.day, waitedDay: state.day }];
    const remembered = accountHappiness(state, account);
    expect(remembered.factors.map((f) => f.reason).sort()).toEqual(['installWait', 'outages', 'priceStep']);
    expect(remembered.score).toBeCloseTo(-3 * HAPPINESS_PER_OUTAGE_DAY - HAPPINESS_PRICE_STEP - HAPPINESS_INSTALL_WAIT, 12);
    expect(remembered.factors[0]!.score).toBeLessThanOrEqual(remembered.factors[2]!.score);
    state.day += Math.max(HAPPINESS_OUTAGE_MEMORY_DAYS, HAPPINESS_PRICE_STEP_MEMORY_DAYS) + 120;
    expect(accountHappiness(state, account).factors).toEqual([]);
    // Buckets cover every unit.
    const report = happinessReport(state);
    expect(report.happy + report.okay + report.unhappy).toBe(subscriberUnits(state));
  });

  it('prices the cable promo so an ignored one costs INCUMBENT_PROMO_CHURN a month and the default retention offer answers it', () => {
    const score = (paid: number, cable = PROMO_PRICE) => {
      const p = priceScores('fiber1g', 'home', paid, SMB_MULTIPLIER_DEFAULT, cable);
      return p.priceVsCable + p.priceVsMarket + p.goodDeal;
    };
    const list = defaultPricing().tiers[1]!.price;
    expect(churnFromScore(score(list)) - churnFromScore(score(list, INCUMBENT_PRICE))).toBeCloseTo(INCUMBENT_PROMO_CHURN, 12);
    expect(priceScores('fiber1g', 'home', list, SMB_MULTIPLIER_DEFAULT, INCUMBENT_PRICE).priceVsCable).toBe(0);
    expect(HAPPINESS_CABLE_PREMIUM_TOLERATED).toBeGreaterThan(0);
    // Paying no more than the tolerated premium over cable's promo price: nothing to answer.
    const tolerated = Math.floor(PROMO_PRICE * (1 + HAPPINESS_CABLE_PREMIUM_TOLERATED));
    expect(priceScores('fiber1g', 'home', tolerated, SMB_MULTIPLIER_DEFAULT, PROMO_PRICE).priceVsCable).toBe(0);
  });

  it('makes unhappy customers cancel more and happy ones less, one draw per unit', () => {
    const towers = makeGridCity({ cols: 2, rows: 2, blockW: 5, blockH: 2, parcelKinds: () => ({ kind: 'mdu', units: 50 }) });
    const churned = (setup: (s: GameState) => void): { churned: number; units: number } => {
      const state = makeTestState(towers, { rngSales: 4 });
      state.day = 40;
      state.sales.accounts = towers.parcels.map((p) => ({ parcel: p.id, cabinet: 1, tierUnits: { fiber500: 0, fiber1g: p.units, fiber2g: 0 }, since: 0, locks: [] }));
      setup(state);
      const units = subscriberUnits(state);
      closeAt(state);
      return { churned: units - subscriberUnits(state), units };
    };
    const okay = churned(() => {});
    expectNear(okay.churned, okay.units, CHURN_MONTHLY_BASE);
    const happy = churned((s) => (s.customers.supportLevel = 'great'));
    expectNear(happy.churned, happy.units, churnFromScore(SUPPORT_LEVELS.great.happiness));
    const unhappy = churned((s) => {
      s.customers.supportLevel = 'basic';
      s.customers.memories = s.sales.accounts.map((a) => ({ parcel: a.parcel, outageDays: 4, outageDay: s.day - 10, priceStepDay: null, waitedDay: null }));
    });
    expectNear(unhappy.churned, unhappy.units, churnFromScore(SUPPORT_LEVELS.basic.happiness - 4 * HAPPINESS_PER_OUTAGE_DAY));
    expect(SUPPORT_LEVELS.basic.happiness - 4 * HAPPINESS_PER_OUTAGE_DAY).toBeLessThanOrEqual(UNHAPPY_SCORE_MAX);
    expect(unhappy.churned).toBeGreaterThan(okay.churned);
    expect(happy.churned).toBeLessThan(okay.churned);
  });

  it('remembers a month\'s outage days at its close, after the draws, so they weigh only on later months', () => {
    const { state, cabinet } = litTown();
    subscribe(state, cabinet, 0.25);
    const parcel = state.sales.accounts[0]!.parcel;
    state.day = closeDayAfter(40, 1);
    const lastDay = state.day - 1;
    state.weather.cutOff = [{ parcel, days: 3, charged: 0, units: 1 }];
    // The close's churn ran without the memory (the outage part charged the days); the customers part writes it.
    expect(accountHappiness(state, state.sales.accounts[0]!).factors).toEqual([]);
    closeCustomersMonth(state, lastDay);
    expect(state.customers.memories).toEqual([{ parcel, outageDays: 3, outageDay: lastDay, priceStepDay: null, waitedDay: null }]);
    expect(accountHappiness(state, state.sales.accounts[0]!).factors).toEqual([{ reason: 'outages', score: -3 * HAPPINESS_PER_OUTAGE_DAY }]);
    // Another outage within the memory adds up; one after it starts afresh.
    state.day = closeDayAfter(state.day, 1);
    state.weather.cutOff = [{ parcel, days: 2, charged: 0, units: 1 }];
    closeCustomersMonth(state, state.day - 1);
    expect(state.customers.memories[0]).toMatchObject({ outageDays: 5, outageDay: state.day - 1 });
    // Forgotten HAPPINESS_OUTAGE_MEMORY_DAYS after the last outage day.
    state.weather.cutOff = [];
    state.day += HAPPINESS_OUTAGE_MEMORY_DAYS;
    stepCustomers(state);
    expect(state.customers.memories).toEqual([]);
  });

  it('remembers a price step from the close its lock ends, after that close\'s draws', () => {
    const { state, cabinet } = litTown();
    subscribe(state, cabinet, 0.25);
    state.day = 40;
    const until = closeDayAfter(40, 1);
    for (const account of state.sales.accounts) account.locks = [{ tier: 'fiber1g', price: 60, untilDay: until, reason: 'promo' }];
    closeAt(state);
    expect(state.day).toBe(until);
    expect(state.customers.memories.length).toBe(state.sales.accounts.length);
    for (const memory of state.customers.memories) expect(memory).toMatchObject({ priceStepDay: until, outageDays: 0, outageDay: null, waitedDay: null });
    expect(accountHappiness(state, state.sales.accounts[0]!).factors).toEqual([{ reason: 'priceStep', score: -HAPPINESS_PRICE_STEP }]);
  });

  it('remembers waiting to be connected: a cabinet that turned signups away, or installs paused', () => {
    const { state, cabinet } = litTown({ aware: 1 });
    state.customers.waits = [{ cabinet, day: 0 }];
    step(state, 20);
    expect(subscriberUnits(state)).toBeGreaterThan(0);
    const waited = state.customers.memories.filter((m) => m.waitedDay !== null);
    expect(waited.length).toBe(state.sales.accounts.length);
    expect(accountHappiness(state, state.sales.accounts[0]!).factors.map((f) => f.reason)).toEqual(['installWait']);
    // The wait record ages out after INSTALL_WAIT_WINDOW_DAYS; later connects did not wait.
    step(state, INSTALL_WAIT_WINDOW_DAYS + 60);
    expect(state.customers.waits).toEqual([]);
    const late = state.sales.accounts.filter((a) => a.since > INSTALL_WAIT_WINDOW_DAYS);
    expect(late.length).toBeGreaterThan(0);
    for (const account of late) expect(state.customers.memories.find((m) => m.parcel === account.parcel)?.waitedDay ?? null).toBeNull();
    // Installs paused: pausedDay is noted daily, and expires.
    state.sales.installsPaused = true;
    step(state, 1);
    expect(state.customers.pausedDay).toBe(state.day);
    state.sales.installsPaused = false;
    step(state, INSTALL_WAIT_WINDOW_DAYS + 1);
    expect(state.customers.pausedDay).toBeNull();
  });

  it('brings neighbors: a street\'s happy share speeds its switching up', () => {
    const { state, cabinet } = litTown({ aware: 1 });
    state.customers.supportLevel = HAPPY_LEVEL;
    const segment = state.customers.streets[0]!.segment;
    const parcels = state.city.parcels.filter((p) => p.segment === segment);
    state.sales.accounts = [home(parcels[0]!.id, cabinet)];
    expect(streetHappiness(state).get(segment)).toEqual({ happy: 1, units: 1 });
    expect(switchingDay(state)(segment, cabinet, false).rate).toBeCloseTo(SWITCH_BASE_PER_DAY * womSwitchFactor(1, false), 15);
    state.customers.supportLevel = UNHAPPY_LEVEL;
    expect(switchingDay(state)(segment, cabinet, false).rate).toBeCloseTo(SWITCH_BASE_PER_DAY, 15);
  });
});

// ---------------------------------------------------------------------------
// 5. Levers: commands, the close, saves
// ---------------------------------------------------------------------------

describe('levers', () => {
  it('credits referrals at the close as marketing, from the part of signups word of mouth brought', () => {
    const { state, cabinet } = litTown({ aware: 1 });
    state.customers.supportLevel = 'great';
    state.customers.referrals = true;
    // A happy customer on every street.
    const seen = new Set<number>();
    state.sales.accounts = state.city.parcels.filter((p) => !seen.has(p.segment) && seen.add(p.segment)).map((p) => home(p.id, cabinet));
    // To the month's last day: its referral share is all in.
    runDays(state, closeDayAfter(state.day, 1) - state.day - 1);
    const milli = state.customers.month.referralMilli;
    expect(milli).toBeGreaterThan(1_000);
    runDays(state, 1);
    const report = state.finance.reports.at(-1)!;
    const n = Math.round(milli / 1000);
    expect(report.customers).toMatchObject({ referralSignups: n, referralCredits: n * 2 * REFERRAL_CREDIT });
    // Without credits nothing accrues, however happy the neighbors.
    const off = litTown({ aware: 1 });
    off.state.customers.supportLevel = 'great';
    const once = new Set<number>();
    off.state.sales.accounts = off.state.city.parcels.filter((p) => !once.has(p.segment) && once.add(p.segment)).map((p) => home(p.id, off.cabinet));
    step(off.state, 30);
    expect(subscriberUnits(off.state)).toBeGreaterThan(off.state.sales.accounts.length - 1);
    expect(off.state.customers.month.referralMilli).toBe(0);
    // Each signup's share is the word-of-mouth part of its street's rate.
    expect(referralShareOf(1, true)).toBeCloseTo((womSwitchFactor(1, true) - 1) / womSwitchFactor(1, true), 12);
    expect(referralShareOf(1, false)).toBe(0);
  });

  it('posts the referral credits on the month\'s last day with a plain memo, then starts a fresh month, and nothing without referrals', () => {
    const { state } = litTown();
    state.day = closeDayAfter(40, 1);
    state.customers.month = { referralMilli: 9_400, campaignSpend: 1_200 };
    const stats = closeCustomersMonth(state, state.day - 1);
    expect(stats).toMatchObject({ referralSignups: 9, referralCredits: 9 * 2 * REFERRAL_CREDIT, campaignSpend: 1_200 });
    const ended = dateOf(state.day - 1);
    expect(state.finance.monthToDate).toEqual([
      { day: state.day - 1, category: 'marketing', amount: -9 * 2 * REFERRAL_CREDIT, memo: `Referral credits for ${formatMonth(ended.year, ended.month)}: 9 referrals` },
    ]);
    expect(state.customers.month).toEqual({ referralMilli: 0, campaignSpend: 0 });
    // Under half a referral: nothing to credit.
    state.customers.month.referralMilli = 499;
    expect(closeCustomersMonth(state, state.day - 1)).toMatchObject({ referralSignups: 0, referralCredits: 0 });
    expect(state.finance.monthToDate).toHaveLength(1);
    // A whole month's close reports them too.
    const played = litTown().state;
    played.day = 40;
    played.customers.month.referralMilli = 2_600;
    runDays(played, closeDayAfter(40, 1) - played.day);
    expect(played.finance.reports.at(-1)?.customers).toMatchObject({ referralSignups: 3, referralCredits: 3 * 2 * REFERRAL_CREDIT });
  });

  it('round-trips every lever and memory through a save', () => {
    const { state, cabinet } = litTown({ aware: 0.4 });
    runDays(state, 40);
    expect(applyCommand(state, { type: 'setSupport', level: 'great' }).ok).toBe(true);
    expect(applyCommand(state, { type: 'setReferrals', on: true }).ok).toBe(true);
    expect(applyCommand(state, { type: 'runCampaign', cabinet }).ok).toBe(true);
    runDays(state, 45);
    expect(state.customers.campaigns.length).toBe(1);
    expect(state.customers.streets.length).toBeGreaterThan(0);
    const loaded = deserialize(serialize(state));
    expect(loaded.customers).toEqual(state.customers);
    expect(hashState(loaded)).toBe(hashState(state));
  });

  it('runs a campaign with an awareness burst for CAMPAIGN_DAYS that then fades, and a cooldown after', () => {
    const { state, cabinet } = litTown({ marketing: 0 });
    step(state, 1);
    expect(applyCommand(state, { type: 'runCampaign', cabinet }).ok).toBe(true);
    const record = state.customers.campaigns[0]!;
    const before = state.customers.streets[0]!.awareness;
    step(state, 10);
    expect(state.customers.streets[0]!.awareness).toBeGreaterThan(before);
    expect(campaignStrength(record, state.day)).toBe(1);
    expect(campaignStrength(record, record.startDay + CAMPAIGN_DAYS + Math.floor(CAMPAIGN_FADE_DAYS / 2))).toBeLessThan(1);
    expect(quoteCampaign(state, cabinet).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Forecasts
// ---------------------------------------------------------------------------

describe('forecasts', () => {
  it('forecasts the marketing budget within about 20% of what the sim then does', () => {
    for (const [seed, day] of [
      [1, 31],
      [2027, 500],
    ] as const) {
      const state = bigTown(seed);
      runDays(state, day);
      const quote = quoteMarketing(state, state.sales.marketingPerMonth);
      expect(quote.ok).toBe(true);
      const start = state.sales.connectsTotal;
      runDays(state, Math.round((CUSTOMER_QUOTE_MONTHS * 365) / 12));
      const actual = (state.sales.connectsTotal - start) / CUSTOMER_QUOTE_MONTHS;
      expect(quote.signupsPerMonth / actual, `seed ${seed} day ${day}: ${quote.signupsPerMonth} vs ${actual}`).toBeGreaterThan(0.8);
      expect(quote.signupsPerMonth / actual, `seed ${seed} day ${day}: ${quote.signupsPerMonth} vs ${actual}`).toBeLessThan(1.2);
    }
  });

  it('says what more marketing buys: more where few know you, nothing where everybody does', () => {
    const fresh = litTown({ marketing: 0 }).state;
    step(fresh, 1);
    const q = quoteMarketing(fresh, 2_000);
    expect(q.extraPerMonth).toBeGreaterThan(0);
    expect(q.costPerCustomer).toBe(Math.round(2_000 / q.extraPerMonth));
    expect(quoteMarketing(fresh, 4_000).extraPerMonth).toBeGreaterThan(q.extraPerMonth);
    expect(quoteMarketing(fresh, 4_000).extraPerMonth).toBeLessThan(2 * q.extraPerMonth);
    expect(quoteMarketing(fresh, 0)).toMatchObject({ extraPerMonth: 0, costPerCustomer: null });
    const known = litTown({ aware: 1 }).state;
    expect(quoteMarketing(known, 2_000).extraPerMonth).toBeLessThan(0.01);
    expect(quoteMarketing(known, MARKETING_MAX_PER_MONTH + 1).ok).toBe(false);
  });

  it('prices a campaign: it pays on a freshly lit area, not on a well-signed one', () => {
    const fresh = bigTown(1);
    runDays(fresh, 5);
    const big = [...whyNotSwitched(fresh).areas].sort((a, b) => b.unsigned - a.unsigned)[0]!;
    const q = quoteCampaign(fresh, big.cabinet);
    expect(q.ok).toBe(true);
    expect(q.extraSignups).toBeGreaterThan(0);
    expect(q.costPerCustomer).toBe(Math.round(q.cost / q.extraSignups));
    expect(q.unawareUnits).toBe(big.unaware);
    expect(q.pays).toBe(true);
    expect(q.valueGained).toBeGreaterThan(q.cost);
    // The same area three years on: everybody knows you and most who want fiber have it.
    const mature = bigTown(1);
    runDays(mature, 3 * 365);
    const m = quoteCampaign(mature, big.cabinet);
    expect(m.ok).toBe(true);
    expect(m.pays).toBe(false);
    expect(m.extraSignups).toBeLessThan(q.extraSignups);
  });

  it('weighs support levels: Basic loses customers, Great keeps more and makes them happy, today\'s level is no change', () => {
    const state = bigTown(2027);
    runDays(state, 400);
    const basic = quoteSupport(state, 'basic');
    const good = quoteSupport(state, 'good');
    const great = quoteSupport(state, 'great');
    expect(good).toMatchObject({ costChange: 0, netValue: 0, pays: false });
    expect(basic.cancellationsPerMonth).toBeGreaterThan(good.cancellationsPerMonth);
    expect(great.cancellationsPerMonth).toBeLessThan(good.cancellationsPerMonth);
    // Since the round-4c/4d tuning Good's customers are happy too: Great keeps every one of them happy, Basic makes fewer so.
    expect(great.happy).toBeGreaterThanOrEqual(good.happy);
    expect(basic.happy).toBeLessThan(good.happy);
    expect(basic.costChange).toBeLessThan(0);
    expect(great.costChange).toBeGreaterThan(0);
    // Great's customers stay (and its happy ones bring neighbors): net of cancellations it grows at least as fast. (Its gross
    // signups can be fewer: fewer cancellations leave less of the gap to refill.)
    expect(great.signupsPerMonth - great.cancellationsPerMonth).toBeGreaterThanOrEqual(good.signupsPerMonth - good.cancellationsPerMonth);
  });

  it('weighs referral credits: nothing to credit without happy customers, a cost per referral with them', () => {
    const { state, cabinet } = litTown({ aware: 0.5 });
    subscribe(state, cabinet, 0.2);
    state.customers.supportLevel = UNHAPPY_LEVEL;
    expect(quoteReferrals(state, true)).toMatchObject({ referralsPerMonth: 0, costPerMonth: 0, extraPerMonth: 0, costPerCustomer: null });
    state.customers.supportLevel = HAPPY_LEVEL;
    const on = quoteReferrals(state, true);
    expect(on.referralsPerMonth).toBeGreaterThan(0);
    expect(on.costPerMonth).toBeCloseTo(on.referralsPerMonth * 2 * REFERRAL_CREDIT, 9);
    expect(on.extraPerMonth).toBeGreaterThan(0);
    const off = quoteReferrals(state, false);
    expect(off).toMatchObject({ referralsPerMonth: 0, costPerMonth: 0, extraPerMonth: 0, netValue: -on.netValue });
    expect(off.pays).toBe(on.netValue < 0);
    expect(quoteReferrals(state, 'yes' as never).ok).toBe(false);
  });

  it('plays the model forward without touching the game', () => {
    const state = bigTown(1);
    runDays(state, 60);
    const before = serialize(state);
    forecastCustomers(state, { marketingPerMonth: 5_000, supportLevel: 'great', referrals: true, promo: { percentOff: 20, months: 3 } as IntroPromo });
    quoteMarketing(state, 3_000);
    quoteCampaign(state, state.network.cabinets[0]!.id);
    quoteSupport(state, 'basic');
    quoteReferrals(state, true);
    expect(serialize(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7. Determinism and purity
// ---------------------------------------------------------------------------

describe('determinism and purity', () => {
  it('replays the same seed and commands to the same hash, straight or through a save', () => {
    const play = (save: boolean): GameState => {
      let state = newGame(77, { city: TOWN });
      addLivePlant(state, { splitters: 4 });
      state.finance.cash = START_CASH * 10;
      runDays(state, 30);
      applyCommand(state, { type: 'setSupport', level: 'great' });
      applyCommand(state, { type: 'setReferrals', on: true });
      applyCommand(state, { type: 'runCampaign', cabinet: state.network.cabinets[0]!.id });
      runDays(state, 70);
      if (save) state = deserialize(serialize(state));
      applyCommand(state, { type: 'setSupport', level: 'basic' });
      runDays(state, 120);
      return state;
    };
    const a = play(false);
    const b = play(true);
    expect(subscriberUnits(a)).toBeGreaterThan(0);
    expect(hashState(a)).toBe(hashState(b));
    expect(a.customers).toEqual(b.customers);
  });

  it('keeps to the sim rules: no randomness, clock, DOM or non-arithmetic math', () => {
    const source = readFileSync(new URL('./customers.ts', import.meta.url), 'utf8');
    for (const banned of [/Math\.random/, /\bDate\b/, /\bdocument\b/, /\bwindow\b/, /Math\.(pow|exp|log|sin|cos|tan|atan)/, /\*\*/]) {
      expect(source.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(banned);
    }
  });
});
