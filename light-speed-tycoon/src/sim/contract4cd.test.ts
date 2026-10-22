// Round 4c/4d contract: the saved shape (GameState.customers, OpsStats.overhead,
// MonthlyReport.customers) and its migration and validation, the three new
// commands, the overhead seam, the month summary's data (money partition,
// story, cash, attention), the Bank's health words, and the customers
// queries' invariants. Placeholder VALUES are not pinned here (the workstreams
// replace them); invariants that hold for the real rules are.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BANK_WATCH_HEADROOM,
  CAMPAIGN_COOLDOWN_DAYS,
  CAMPAIGN_COST_MIN,
  CAMPAIGN_COST_PER_UNIT,
  CAMPAIGN_DAYS,
  CAMPAIGN_FADE_DAYS,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  DEFAULT_SUPPORT_LEVEL,
  LOAN_ROUNDING,
  MARKETING_MAX_PER_MONTH,
  PENALTY_STEP_UP_BPS,
  SUPPORT_LEVELS,
  TERM_LOAN_MIN,
} from './balance';
import { ADVICE_ORDER, ADVICE_TITLE_MAX, ADVICE_WHY_MAX, actionLabelOf, ATTENTION_MAX, advise, attentionItems, briefingMoney, briefingStory, buildBriefing, growthOptions } from './advisor';
import { dateOf, MONTH_LENGTHS } from './calendar';
import {
  AWARENESS_PPM,
  accountHappiness,
  bucketOf,
  campaignCost,
  campaignStrength,
  customerAreas,
  customerSnapshot,
  happinessReport,
  newCustomers,
  quoteCampaign,
  quoteMarketing,
  quoteReferrals,
  quoteSupport,
  SUPPORT_LEVEL_IDS,
  whyNotSwitched,
} from './customers';
import { bankHealth, covenantMetrics, healthLevel, quotePrepay, quoteRepay, stageAfterClose, totalDebt } from './debt';
import { applyCommand, newGame, runDays } from './game';
import { getService } from './network';
import { estimateMonthlyOverhead, fixedCostsPerMonth, livePlant, overheadRates, overheadTotal, perCustomerCost } from './overhead';
import { deserialize, SaveError, serialize } from './save';
import { subscriberUnits } from './sales';
import { addLivePlant, makeGridCity, makeLoan, makeTestState, makeTradingState } from './testing/fixtures';
import type { CovenantMetrics, GameState, MonthlyReport } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Save = any;

/** A small lit town (every street cabled live, a cabinet at the CO with room) with subscribers after `days`. */
function litTown(days = 75): GameState {
  const state = makeTestState(makeGridCity({ cols: 2, rows: 2 }));
  addLivePlant(state, { splitters: 4 });
  runDays(state, days);
  return state;
}

/** litTown with a closed month or two, a term loan and a credit draw (for the money partition and the Bank). */
function tradingTown(): GameState {
  const state = litTown(95);
  // Something to lend against: each closed month billed TERM_LOAN_MIN more (the books kept consistent: nets, cash at each close, cash now).
  state.finance.reports.forEach((report, i) => {
    report.totals.revenue = (report.totals.revenue ?? 0) + TERM_LOAN_MIN;
    report.net += TERM_LOAN_MIN;
    report.cashEnd += (i + 1) * TERM_LOAN_MIN;
  });
  state.finance.cash += state.finance.reports.length * TERM_LOAN_MIN;
  expect(applyCommand(state, { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: 5 })).toEqual({ ok: true, cost: -TERM_LOAN_MIN });
  runDays(state, 40);
  return state;
}

function expectSaveError(json: string, message: RegExp): void {
  let error: unknown;
  try {
    deserialize(json);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SaveError);
  expect((error as SaveError).message).toMatch(message);
}

/** A save with every round-4cd record filled in (as the rules will write them). */
function populated(): Save {
  const state = litTown();
  const save: Save = JSON.parse(serialize(state));
  const cabinet = save.network.cabinets[0].id;
  const parcel = save.sales.accounts[0].parcel;
  save.customers = {
    supportLevel: 'great',
    referrals: true,
    streets: [
      { segment: 0, litDay: 1, awareness: 250_000 },
      { segment: 1, litDay: 1, awareness: AWARENESS_PPM },
    ],
    campaigns: [{ cabinet, startDay: save.day - 5, endDay: save.day + 100, cooldownUntil: save.day + 220, cost: 1_200, units: 100 }],
    memories: [{ parcel, outageDays: 3, outageDay: save.day - 10, priceStepDay: null, waitedDay: save.day - 20 }],
    waits: [{ cabinet, day: save.day - 2 }],
    pausedDay: save.day - 30,
    month: { referralMilli: 2_400, campaignSpend: 1_200 },
  };
  const report = save.finance.reports[0];
  report.ops.overhead = { base: 2_000, perCustomer: 300, support: 200, perPlant: 450 };
  report.customers = { happy: 4, okay: 6, unhappy: 1, referralSignups: 2, referralCredits: 100, campaignSpend: 1_200, areas: [{ cabinet, passings: 40, units: 11 }] };
  return save;
}

// ---------------------------------------------------------------------------
// Saved shape, migration and validation
// ---------------------------------------------------------------------------

describe('round 4c/4d: schemaVersion 4 extended in place', () => {
  it('a new game starts with the customers model at its defaults, right after sales', () => {
    const state = newGame(5, { city: makeGridCity() });
    expect(state.customers).toEqual(newCustomers());
    expect(state.customers.supportLevel).toBe(DEFAULT_SUPPORT_LEVEL);
    expect(state.customers.referrals).toBe(false);
    const keys = Object.keys(state);
    expect(keys.indexOf('customers')).toBe(keys.indexOf('sales') + 1);
  });

  it('every close records the overhead by line and the customer figures', () => {
    const state = litTown(130);
    expect(state.finance.reports.length).toBeGreaterThanOrEqual(3);
    for (const report of state.finance.reports) {
      const lines = report.ops?.overhead;
      expect(lines).toBeTruthy();
      expect(overheadTotal(lines!)).toBe(-(report.totals.overhead ?? 0));
      expect(lines!.support).toBeLessThanOrEqual(lines!.perCustomer);
      const stats = report.customers!;
      expect(stats.happy + stats.okay + stats.unhappy).toBe(report.stats!.subscribers);
      expect(stats.areas.map((a) => a.cabinet)).toEqual([...stats.areas.map((a) => a.cabinet)].sort((a, b) => a - b));
    }
  });

  it('loads and round-trips every round-4cd record', () => {
    const text = JSON.stringify(populated());
    const state = deserialize(text);
    expect(state.customers.supportLevel).toBe('great');
    expect(state.customers.campaigns).toHaveLength(1);
    expect(state.finance.reports[0]?.ops?.overhead).toEqual({ base: 2_000, perCustomer: 300, support: 200, perPlant: 450 });
    expect(state.finance.reports[0]?.customers?.referralCredits).toBe(100);
    expect(serialize(deserialize(text))).toBe(text);
  });

  it('upgrades a v4 save written before round 4c/4d: defaults where newGame puts them', () => {
    const save = populated();
    delete save.customers;
    for (const report of save.finance.reports) {
      delete report.ops.overhead;
      delete report.customers;
    }
    const state = deserialize(JSON.stringify(save));
    expect(state.customers).toEqual(newCustomers());
    expect(state.finance.reports.every((r) => r.ops?.overhead === null && r.customers === undefined)).toBe(true);
    const fresh = newGame(state.seed, { city: state.city });
    expect(Object.keys(state)).toEqual(Object.keys(fresh));
    const opsKeys = Object.keys(state.finance.reports[0]!.ops!);
    expect(opsKeys.at(-1)).toBe('overhead');
    expect(opsKeys.at(-2)).toBe('outageCredits');
    // The summary still works on such reports: one overhead line.
    const money = briefingMoney(state.finance.reports);
    expect(money.groups[0]!.lines.some((l) => l.key === 'overhead')).toBe(true);
  });

  it.each(['v1-grid', 'v1-town', 'v2-grid', 'v2-town', 'v3-grid', 'v3-town'] as const)('gives the frozen %s save the customers defaults', (name) => {
    const state = deserialize(readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8'));
    expect(state.customers).toEqual(newCustomers());
    expect(Object.keys(state)).toEqual(Object.keys(newGame(state.seed, { city: state.city })));
    // And it plays on, closing months with the new records.
    runDays(state, 40);
    expect(state.finance.reports.at(-1)?.customers).toBeDefined();
  });

  const cases: Array<[string, (s: Save) => void, RegExp]> = [
    ['a null customers state', (s) => (s.customers = null), /customers should be an object, got null/],
    ['an unknown support level', (s) => (s.customers.supportLevel = 'superb'), /customers\.supportLevel should be one of "basic", "good", "great"/],
    ['referral credits "yes"', (s) => (s.customers.referrals = 'yes'), /customers\.referrals should be true or false/],
    ['awareness above everybody', (s) => (s.customers.streets[0].awareness = AWARENESS_PPM + 1), /customers\.streets\[0\]\.awareness should be an integer in 0\.\.1000000/],
    ['a street lit in the future', (s) => (s.customers.streets[0].litDay = s.day + 1), /customers\.streets\[0\]\.litDay should be an integer in/],
    ['a street that is not on the map', (s) => (s.customers.streets[1].segment = 9_999), /customers\.streets\[1\]\.segment should be an integer in/],
    ['streets out of order', (s) => s.customers.streets.reverse(), /customers\.streets \(by segment\)\[1\] should be greater/],
    ['a campaign that ends before it starts', (s) => (s.customers.campaigns[0].endDay = s.customers.campaigns[0].startDay), /customers\.campaigns\[0\]\.endDay should be an integer >=/],
    ['a cooldown before the campaign ends', (s) => (s.customers.campaigns[0].cooldownUntil = s.customers.campaigns[0].endDay - 1), /customers\.campaigns\[0\]\.cooldownUntil should be an integer >=/],
    ['a campaign on a cabinet never built', (s) => (s.customers.campaigns[0].cabinet = s.nextId), /customers\.campaigns\[0\]\.cabinet should be an integer in/],
    ['a negative campaign cost', (s) => (s.customers.campaigns[0].cost = -1), /customers\.campaigns\[0\]\.cost should be an integer in/],
    ['outage days without an outage', (s) => (s.customers.memories[0].outageDay = null), /customers\.memories\[0\]\.outageDays should be an integer in 0\.\.0/],
    ['a price step in the future', (s) => (s.customers.memories[0].priceStepDay = s.day + 1), /customers\.memories\[0\]\.priceStepDay should be an integer in/],
    ['two memories of one parcel', (s) => s.customers.memories.push({ ...s.customers.memories[0] }), /customers\.memories \(by parcel\)\[1\] should be greater/],
    ['a wait in the future', (s) => (s.customers.waits[0].day = s.day + 1), /customers\.waits\[0\]\.day should be an integer in/],
    ['installs paused in the future', (s) => (s.customers.pausedDay = s.day + 1), /customers\.pausedDay should be an integer in/],
    ['negative referral credits accrued', (s) => (s.customers.month.referralMilli = -1), /customers\.month\.referralMilli should be an integer >= 0/],
    ['overhead lines that are not an object', (s) => (s.finance.reports[0].ops.overhead = 5), /ops\.overhead should be an object, got 5/],
    ['more support than per-customer overhead', (s) => (s.finance.reports[0].ops.overhead.support = 301), /ops\.overhead\.support should be an integer in 0\.\.300/],
    ['negative happy customers in a report', (s) => (s.finance.reports[0].customers.happy = -1), /customers\.happy should be an integer >= 0/],
    ['report areas on a cabinet never built', (s) => (s.finance.reports[0].customers.areas[0].cabinet = 0), /customers\.areas\[0\]\.cabinet should be an integer in/],
  ];

  it.each(cases)('rejects %s', (_name, mutate, message) => {
    const save = populated();
    mutate(save);
    expectSaveError(JSON.stringify(save), message);
  });

  it('either rejects or loads a playable game for any single-field corruption of a round-4cd record', () => {
    const save0 = populated();
    const text = JSON.stringify(save0);
    const ROUND4CD = new Set(['customers', 'overhead']);
    const paths: Array<Array<string | number>> = [];
    const walk = (value: unknown, path: Array<string | number>): void => {
      if (path.some((key) => typeof key === 'string' && ROUND4CD.has(key))) paths.push(path);
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
      else if (typeof value === 'object' && value !== null) for (const [key, v] of Object.entries(value)) walk(v, [...path, key]);
    };
    walk(save0, []);
    expect(paths.length).toBeGreaterThan(30);
    const DELETE = Symbol('delete');
    const replacements: unknown[] = [DELETE, null, 'x', -1, 0, 1, 1.5, true, {}, [], 1e9];
    const failures: string[] = [];
    for (const path of paths) {
      for (const replacement of replacements) {
        const save: Save = JSON.parse(text);
        const parent = path.slice(0, -1).reduce((node: Save, key) => node[key], save);
        const key = path[path.length - 1] as string | number;
        if (replacement === DELETE) delete parent[key];
        else parent[key] = replacement;
        let state: GameState;
        try {
          state = deserialize(JSON.stringify(save));
        } catch (err) {
          if (!(err instanceof SaveError)) failures.push(`${path.join('.')}: threw ${String(err)}`);
          continue;
        }
        try {
          applyCommand(state, { type: 'setSupport', level: 'basic' });
          applyCommand(state, { type: 'setReferrals', on: false });
          applyCommand(state, { type: 'runCampaign', cabinet: state.network.cabinets[0]?.id ?? 1 });
          runDays(state, 40);
          whyNotSwitched(state);
          happinessReport(state);
          customerAreas(state);
          buildBriefing(state);
          deserialize(serialize(state));
        } catch (err) {
          failures.push(`${path.join('.')}: loaded, then ${String(err)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

describe('round 4c/4d commands', () => {
  it('setSupport sets a known level, free, and rejects anything else untouched', () => {
    const state = litTown(10);
    for (const level of SUPPORT_LEVEL_IDS) {
      expect(applyCommand(state, { type: 'setSupport', level })).toEqual({ ok: true, cost: 0 });
      expect(state.customers.supportLevel).toBe(level);
    }
    for (const bad of ['superb', '', 'Great']) {
      const r = applyCommand(state, { type: 'setSupport', level: bad as never });
      expect(r.ok).toBe(false);
      expect(state.customers.supportLevel).toBe('great');
    }
    expect(applyCommand(state, { type: 'setSupport' } as never)).toEqual({ ok: false, reason: 'setSupport needs a support level' });
  });

  it('setReferrals turns credits on and off, free; anything but a boolean is rejected', () => {
    const state = litTown(10);
    expect(applyCommand(state, { type: 'setReferrals', on: true })).toEqual({ ok: true, cost: 0 });
    expect(state.customers.referrals).toBe(true);
    expect(applyCommand(state, { type: 'setReferrals', on: 'no' as never }).ok).toBe(false);
    expect(state.customers.referrals).toBe(true);
    expect(applyCommand(state, { type: 'setReferrals', on: false })).toEqual({ ok: true, cost: 0 });
    expect(state.customers.referrals).toBe(false);
  });

  it('runCampaign buys a campaign in a lit area: its quoted cost as marketing, a record, then a cooldown', () => {
    const state = litTown(40);
    const cabinet = state.network.cabinets[0]!.id;
    const quote = quoteCampaign(state, cabinet);
    expect(quote.ok).toBe(true);
    expect(quote.unsignedUnits).toBeGreaterThan(0);
    expect(quote.cost).toBe(campaignCost(quote.unsignedUnits));
    expect(quote.cost).toBe(Math.max(CAMPAIGN_COST_MIN, Math.round(quote.unsignedUnits * CAMPAIGN_COST_PER_UNIT)));
    const cash = state.finance.cash;
    expect(applyCommand(state, { type: 'runCampaign', cabinet })).toEqual({ ok: true, cost: quote.cost });
    expect(state.finance.cash).toBe(cash - quote.cost);
    expect(state.finance.monthToDate.at(-1)).toMatchObject({ category: 'marketing', amount: -quote.cost });
    expect(state.customers.month.campaignSpend).toBe(quote.cost);
    const record = state.customers.campaigns[0]!;
    expect(record).toEqual({
      cabinet,
      startDay: state.day,
      endDay: state.day + CAMPAIGN_DAYS + CAMPAIGN_FADE_DAYS,
      cooldownUntil: state.day + CAMPAIGN_DAYS + CAMPAIGN_FADE_DAYS + CAMPAIGN_COOLDOWN_DAYS,
      cost: quote.cost,
      units: quote.unsignedUnits,
    });
    // One at a time, then a rest.
    expect(applyCommand(state, { type: 'runCampaign', cabinet }).ok).toBe(false);
    expect(quoteCampaign(state, cabinet).availableDay).toBe(record.cooldownUntil);
    // The close reports the month's spend and starts a fresh month.
    const closeIn = MONTH_LENGTHS[dateOf(state.day).month - 1]! - dateOf(state.day).day + 1;
    runDays(state, closeIn);
    expect(state.finance.reports.at(-1)?.customers?.campaignSpend).toBe(quote.cost);
    expect(state.customers.month.campaignSpend).toBe(0);
    runDays(state, record.endDay - state.day);
    expect(campaignStrength(record, state.day)).toBe(0);
    expect(applyCommand(state, { type: 'runCampaign', cabinet }).ok).toBe(false);
    runDays(state, record.cooldownUntil - state.day + 31);
    expect(state.customers.campaigns.find((c) => c.cabinet === cabinet && c.startDay === record.startDay)).toBeUndefined();
  });

  it('runCampaign refuses a cabinet that does not exist or lights nothing, and a bad field type', () => {
    const state = litTown(10);
    expect(applyCommand(state, { type: 'runCampaign', cabinet: 999 }).ok).toBe(false);
    expect(applyCommand(state, { type: 'runCampaign', cabinet: '1' } as never)).toEqual({ ok: false, reason: 'runCampaign needs a cabinet id' });
    const dark = makeTestState(makeGridCity());
    expect(applyCommand(dark, { type: 'placeCabinet', node: dark.city.coNode }).ok).toBe(true);
    const id = dark.network.cabinets[0]!.id;
    expect(quoteCampaign(dark, id).ok).toBe(false);
    expect(applyCommand(dark, { type: 'runCampaign', cabinet: id }).ok).toBe(false);
    expect(dark.customers.campaigns).toEqual([]);
  });

  it('campaign strength is full for CAMPAIGN_DAYS, then fades to nothing at endDay', () => {
    const c = { startDay: 100, endDay: 100 + CAMPAIGN_DAYS + CAMPAIGN_FADE_DAYS };
    expect(campaignStrength(c, 99)).toBe(0);
    expect(campaignStrength(c, 100)).toBe(1);
    expect(campaignStrength(c, 100 + CAMPAIGN_DAYS - 1)).toBe(1);
    const mid = campaignStrength(c, 100 + CAMPAIGN_DAYS + Math.floor(CAMPAIGN_FADE_DAYS / 2));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(campaignStrength(c, c.endDay)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The overhead seam
// ---------------------------------------------------------------------------

describe('overhead seam', () => {
  it('rates, estimates and the cushion agree with each other', () => {
    const state = litTown(100);
    const rates = overheadRates(state);
    expect(rates.supportLevel).toBe(state.customers.supportLevel);
    expect(rates.support).toBeLessThanOrEqual(rates.perCustomer);
    expect(perCustomerCost(state)).toBe(rates.perCustomer);
    const plant = livePlant(state);
    expect(plant.cabinets).toBe(state.network.cabinets.filter((c) => c.stage === 'live').length);
    expect(plant.miles).toBeGreaterThan(0);
    const month = estimateMonthlyOverhead(state);
    expect(month.support).toBeLessThanOrEqual(month.perCustomer);
    expect(fixedCostsPerMonth(state)).toBeGreaterThanOrEqual(state.sales.marketingPerMonth);
  });
});

// ---------------------------------------------------------------------------
// The month summary's data
// ---------------------------------------------------------------------------

function report(totals: MonthlyReport['totals'], extra: Partial<MonthlyReport> = {}): MonthlyReport {
  let net = 0;
  for (const amount of Object.values(totals)) net += amount ?? 0;
  return { year: 2028, month: 3, totals, net, cashEnd: 0, passings: 0, ...extra };
}

describe('the month summary: money in and out', () => {
  it('money in less money out is exactly the period cash change, for a month and a quarter of play', () => {
    const state = tradingTown();
    for (const span of [1, 3]) {
      const b = buildBriefing(state, span)!;
      const period = state.finance.reports.slice(-b.span);
      const nets = period.reduce((sum, r) => sum + r.net, 0);
      expect(b.money.in - b.money.out).toBe(nets);
      expect(b.money.cashChange).toBe(nets);
      expect(b.cash.change).toBe(nets);
      expect(b.cash.end).toBe(b.report.cashEnd);
      const before = state.finance.reports.at(-1 - b.span);
      if (before) expect(b.report.cashEnd - before.cashEnd).toBe(nets);
      expect(b.money.groups.map((g) => g.key)).toEqual(['running', 'building', 'loans']);
      expect(b.money.inLines[0]!.key).toBe('bills');
      for (const group of b.money.groups) {
        expect(group.total).toBeGreaterThanOrEqual(0);
        for (const line of group.lines) expect(line.amount).not.toBe(0);
      }
    }
  });

  it('borrowed money is its own money-in line, and loan payments their own group', () => {
    const m = briefingMoney([report({ revenue: 20_000, loanProceeds: 50_000, construction: -30_000, interest: -400, principal: -600, overhead: -9_000 })]);
    expect(m.inLines).toEqual([
      { key: 'bills', amount: 20_000 },
      { key: 'borrowed', amount: 50_000 },
    ]);
    expect(m.groups.find((g) => g.key === 'loans')).toEqual({ key: 'loans', total: 1_000, lines: [{ key: 'principal', amount: 600 }, { key: 'interest', amount: 400 }] });
    expect(m.in - m.out).toBe(20_000 + 50_000 - 30_000 - 1_000 - 9_000);
  });

  it('splits the overhead into its lines when every report has them, else keeps one line', () => {
    const lines = { base: 2_000, perCustomer: 1_500, support: 1_000, perPlant: 700 };
    const split = briefingMoney([report({ overhead: -4_200 }, { ops: { overhead: lines } as never })]);
    expect(split.groups[0]!.lines.map((l) => l.key).sort()).toEqual(['overheadBase', 'overheadCustomers', 'overheadPlant']);
    expect(split.groups[0]!.total).toBe(4_200);
    const mixed = briefingMoney([report({ overhead: -4_200 }, { ops: { overhead: lines } as never }), report({ overhead: -9_000 })]);
    expect(mixed.groups[0]!.lines).toEqual([{ key: 'overhead', amount: 13_200 }]);
  });

  it('splits marketing into the budget, neighborhood campaigns and referral credits when every report has the customer figures', () => {
    const customers = { happy: 0, okay: 0, unhappy: 0, referralSignups: 6, referralCredits: 300, campaignSpend: 1_500, areas: [] };
    const split = briefingMoney([report({ revenue: 9_000, marketing: -2_800 }, { customers })]);
    const running = split.groups.find((g) => g.key === 'running')!;
    expect(running.total).toBe(2_800);
    expect(running.lines).toEqual([
      { key: 'campaigns', amount: 1_500 },
      { key: 'marketing', amount: 1_000 },
      { key: 'referrals', amount: 300 },
    ]);
    expect(split.cashChange).toBe(9_000 - 2_800);
    // A report from before round 4c/4d (no customer figures) keeps one marketing line.
    const mixed = briefingMoney([report({ marketing: -2_800 }, { customers }), report({ marketing: -1_000 })]);
    expect(mixed.groups.find((g) => g.key === 'running')!.lines).toEqual([{ key: 'marketing', amount: 3_800 }]);
  });

  it('a group that nets money in (refunds above spend) counts in Other, so the bars still add up', () => {
    const m = briefingMoney([report({ revenue: 1_000, refund: 5_000, construction: -2_000 })]);
    const building = m.groups.find((g) => g.key === 'building')!;
    expect(building.total).toBe(0);
    expect(m.inLines).toContainEqual({ key: 'otherIn', amount: 3_000 });
    expect(m.cashChange).toBe(4_000);
  });

  it('tells the story: earned, building, bills short, or the bank first', () => {
    const state = makeTradingState(30_000);
    const earned = briefingMoney([report({ revenue: 30_000, overhead: -9_000, marketing: -1_000 })]);
    expect(briefingStory(state, earned)).toBe('earned');
    const building = briefingMoney([report({ revenue: 30_000, overhead: -9_000, construction: -40_000, loanProceeds: 30_000 })]);
    expect(briefingStory(state, building)).toBe('building');
    const short = briefingMoney([report({ revenue: 5_000, overhead: -9_000, construction: -1_000 })]);
    expect(briefingStory(state, short)).toBe('billsShort');
    state.debt.loans = [makeLoan()];
    state.debt.covenant.stage = 'warning';
    expect(briefingStory(state, earned)).toBe('bank');
  });

  it('the cash card: the pace a month, and what bills less running costs and loan payments made', () => {
    const state = tradingTown();
    const b = buildBriefing(state, 3)!;
    expect(b.cash.perMonth).toBe(Math.round(b.money.cashChange / b.span));
    const bills = b.money.inLines.find((l) => l.key === 'bills')?.amount ?? 0;
    const group = (key: string) => b.money.groups.find((g) => g.key === key)!.total;
    expect(b.cash.withoutBuilding).toBe(bills - group('running') - group('loans'));
    expect(b.cash.building).toBe(group('building') > 0);
    // Round 4c/4d: while cash falls, how long what is left lasts at the period's own pace.
    if (b.money.cashChange < 0) expect(b.cash.paceMonths).toBe(Math.floor((Math.max(0, b.cash.end) * b.span) / -b.money.cashChange));
    else expect(b.cash.paceMonths).toBeNull();
  });
});

describe('the month summary: needs attention', () => {
  it('lists at most ATTENTION_MAX lines, the bank first, each with an action', () => {
    const state = tradingTown();
    state.debt.covenant.stage = 'penalty';
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    const items = attentionItems(state, [{ id: 1, day: state.day, kind: 'covenantPenalty', message: 'x', cabinet: null, milestone: null }]);
    expect(items.length).toBeLessThanOrEqual(ATTENTION_MAX);
    expect(items[0]).toMatchObject({ kind: 'bankStage', stage: 'penalty', action: { kind: 'openPanel', panel: 'bank' } });
    expect(items[1]).toMatchObject({ kind: 'cabinetFull', action: { kind: 'focusCabinet', cabinet: state.network.cabinets[0]!.id } });
  });

  it('is empty when nothing needs the player', () => {
    const state = litTown(40);
    state.sales.fullCabinets = [];
    expect(attentionItems(state, [])).toEqual([]);
  });

  it('every briefing carries a story, the money, the cash card and its attention lines', () => {
    const b = buildBriefing(tradingTown())!;
    expect(['bank', 'earned', 'building', 'billsShort']).toContain(b.story);
    expect(b.attention.length).toBeLessThanOrEqual(ATTENTION_MAX);
  });
});

// ---------------------------------------------------------------------------
// The Bank's health
// ---------------------------------------------------------------------------

function metrics(over: Partial<CovenantMetrics> = {}): CovenantMetrics {
  return {
    totalDebt: 100_000,
    arr: 120_000,
    annualOperatingCashFlow: 50_000,
    underwritingCashFlow: 50_000,
    annualDebtService: 20_000,
    leverage: 2,
    coverage: 2.5,
    leverageOk: true,
    coverageOk: true,
    compliant: true,
    ...over,
  };
}

describe('bank health', () => {
  it('maps each stage and the checks to one level', () => {
    expect(healthLevel('compliant', metrics({ totalDebt: 0, leverage: 0, annualDebtService: 0, coverage: null }), false)).toBe('good');
    expect(healthLevel('compliant', metrics(), true)).toBe('good');
    const near = COVENANT_MAX_LEVERAGE * (1 - BANK_WATCH_HEADROOM) + 0.01;
    expect(healthLevel('compliant', metrics({ leverage: near }), true)).toBe('watch');
    expect(healthLevel('compliant', metrics({ coverage: COVENANT_MIN_COVERAGE * (1 + BANK_WATCH_HEADROOM) - 0.01 }), true)).toBe('watch');
    expect(healthLevel('compliant', metrics({ leverage: 6, leverageOk: false, compliant: false }), true)).toBe('watch');
    for (const stage of ['warning', 'penalty', 'frozen'] as const) expect(healthLevel(stage, metrics(), true)).toBe(stage);
  });

  it('the next close steps a breached stage up one, and leaves a compliant one', () => {
    expect(stageAfterClose('compliant', false)).toBe('warning');
    expect(stageAfterClose('warning', false)).toBe('penalty');
    expect(stageAfterClose('penalty', false)).toBe('frozen');
    expect(stageAfterClose('frozen', false)).toBe('frozen');
    expect(stageAfterClose('penalty', true)).toBe('penalty');
  });

  it('bankHealth reads the game: no debt, failing now, the penalty and the countdown', () => {
    const state = makeTradingState(30_000, 10_000);
    expect(bankHealth(state)).toMatchObject({ level: 'good', noDebt: true, failingNow: false, nearLimit: false, called: false, closesUntilCalled: null, penaltyBps: 0 });
    state.debt.loans = [makeLoan({ balance: 2_000_000, principal: 2_000_000 })];
    const failing = bankHealth(state);
    expect(failing).toMatchObject({ level: 'watch', noDebt: false, failingNow: true, nearLimit: false });
    expect(failing.metrics).toEqual(covenantMetrics(state));
    state.debt.covenant.stage = 'frozen';
    state.debt.frozenCloses = 2;
    expect(bankHealth(state)).toMatchObject({ level: 'frozen', penaltyBps: PENALTY_STEP_UP_BPS });
    expect(bankHealth(state).closesUntilCalled).toBeGreaterThan(0);
  });

  it('quoteRepay and quotePrepay give the covenant figures after', () => {
    const state = makeTradingState(30_000, 5_000);
    state.finance.cash = 500_000;
    state.debt.credit.balance = 40_000;
    state.debt.loans = [makeLoan()];
    const repay = quoteRepay(state, 10_000);
    expect(repay.ok).toBe(true);
    expect(repay.after.totalDebt).toBe(totalDebt(state) - 10_000);
    expect(repay.cashAfter).toBe(state.finance.cash - 10_000);
    expect(quoteRepay(state, 40_001).ok).toBe(false);
    expect(quoteRepay(state, 1.5).ok).toBe(false);
    expect(quoteRepay(state, 1.5).after).toEqual(repay.before);
    const prepay = quotePrepay(state, 1, LOAN_ROUNDING);
    expect(prepay.after.totalDebt).toBe(totalDebt(state) - LOAN_ROUNDING);
    expect(quotePrepay(state, 1, state.debt.loans[0]!.balance).after.totalDebt).toBe(state.debt.credit.balance);
  });
});

// ---------------------------------------------------------------------------
// Customers queries (invariants that hold for the placeholders and the rules)
// ---------------------------------------------------------------------------

describe('customers queries', () => {
  it('every lit unsigned household has exactly one reason; areas add up to the town', () => {
    const state = litTown(120);
    const reasons = whyNotSwitched(state);
    const check = (r: typeof reasons.overall) => {
      expect(r.unaware + r.notWorth + r.tooExpensive + r.waiting).toBe(r.unsigned);
      expect(r.unsigned).toBe(r.passings - r.subscribed);
      for (const n of [r.unaware, r.notWorth, r.tooExpensive, r.waiting, r.notLit]) expect(Number.isInteger(n) && n >= 0).toBe(true);
    };
    check(reasons.overall);
    expect(reasons.overall.passings).toBe(getService(state).passings);
    expect(reasons.overall.subscribed).toBe(subscriberUnits(state));
    let unsigned = 0;
    for (const area of reasons.areas) {
      check(area);
      expect(area.notLit).toBe(0);
      unsigned += area.unsigned;
    }
    expect(unsigned).toBe(reasons.overall.unsigned);
  });

  it('counts cabled streets that are not lit yet', () => {
    const state = makeTestState(makeGridCity());
    addLivePlant(state, { node: null });
    expect(whyNotSwitched(state).overall.notLit).toBeGreaterThan(0);
    expect(whyNotSwitched(state).overall.unsigned).toBe(0);
  });

  it('happiness buckets cover every customer; support moves the score', () => {
    const state = litTown(120);
    const report = happinessReport(state);
    expect(report.happy + report.okay + report.unhappy).toBe(subscriberUnits(state));
    expect(bucketOf(10)).toBe('happy');
    expect(bucketOf(-10)).toBe('unhappy');
    expect(bucketOf(0)).toBe('okay');
    const account = state.sales.accounts[0]!;
    const good = accountHappiness(state, account).score;
    state.customers.supportLevel = 'great';
    expect(accountHappiness(state, account).score).toBeGreaterThan(good);
    state.customers.supportLevel = 'basic';
    expect(accountHappiness(state, account).score).toBeLessThan(good);
    for (const reason of happinessReport(state).reasons) expect(['happy', 'unhappy']).toContain(reason.bucket);
  });

  it('the Areas list matches the close snapshot', () => {
    const state = litTown(120);
    const areas = customerAreas(state);
    const snapshot = customerSnapshot(state);
    expect(areas.map((a) => [a.cabinet, a.passings, a.subscribed])).toEqual(snapshot.areas.map((a) => [a.cabinet, a.passings, a.units]));
    for (const area of areas) {
      expect(area.takeRate).toBe(area.passings > 0 ? area.subscribed / area.passings : null);
      expect(area.monthsLit).not.toBeNull();
    }
  });

  it('the quotes validate like their commands and never return negative figures', () => {
    const state = litTown(120);
    expect(quoteMarketing(state, -1).ok).toBe(false);
    expect(quoteMarketing(state, MARKETING_MAX_PER_MONTH + 1).ok).toBe(false);
    expect(quoteMarketing(state, 1.5).ok).toBe(false);
    const m = quoteMarketing(state, 2_000);
    expect(m.ok).toBe(true);
    expect(m.signupsPerMonth).toBeGreaterThanOrEqual(0);
    expect(m.extraPerMonth).toBeGreaterThanOrEqual(0);
    for (const level of SUPPORT_LEVEL_IDS) {
      const q = quoteSupport(state, level);
      expect(q.ok).toBe(true);
      expect(q.costPerMonth).toBe(Math.round(SUPPORT_LEVELS[level].costPerSub * subscriberUnits(state)));
      expect(q.happy + q.okay + q.unhappy).toBe(subscriberUnits(state));
    }
    expect(quoteSupport(state, 'good').costChange).toBe(0);
    expect(quoteReferrals(state, true).ok).toBe(true);
    expect(quoteReferrals(state, true).costPerMonth).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Advisor contract
// ---------------------------------------------------------------------------

describe('advisor contract', () => {
  it('knows the new rules, words the Customers panel, and every advice carries detail and cost', () => {
    for (const id of ['lineup', 'support', 'growCustomers', 'firstBuild'] as const) expect(ADVICE_ORDER).toContain(id);
    expect(actionLabelOf({ kind: 'openPanel', panel: 'customers' })).toBe('Open Customers');
    expect(ADVICE_TITLE_MAX).toBeGreaterThan(0);
    expect(ADVICE_WHY_MAX).toBeGreaterThan(ADVICE_TITLE_MAX);
    const state = tradingTown();
    for (const advice of advise(state, 10)) {
      expect(typeof advice.detail).toBe('string');
      expect(advice.cost === null || Number.isInteger(advice.cost)).toBe(true);
    }
    expect(Array.isArray(growthOptions(state))).toBe(true);
  });
});
