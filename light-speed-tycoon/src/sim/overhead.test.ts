// Round 4c/4d: overhead that scales with the company (overhead.ts). Balance
// is symbolic: every figure comes from balance.ts constants or the
// functions under test, never a literal dollar amount.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPPORT_LEVEL,
  DIFFICULTY_LEVELS,
  OVERHEAD_BASE_PER_MONTH,
  OVERHEAD_PER_CABINET_PER_MONTH,
  OVERHEAD_PER_CUSTOMER_PER_MONTH,
  OVERHEAD_PER_MILE_PER_MONTH,
  SUPPORT_LEVELS,
} from './balance';
import { dateOf, formatMonth, MONTH_LENGTHS } from './calendar';
import { SUPPORT_LEVEL_IDS } from './customers';
import { closeMonth, estimateCashAtClose } from './finance';
import { applyCommand, newGame, runDays, tick } from './game';
import {
  closeOverhead,
  estimateMonthlyOverhead,
  FEET_PER_MILE,
  fixedCostsPerMonth,
  fixedOverheadLines,
  livePlant,
  overheadLinesOf,
  overheadRates,
  overheadTotal,
  perCustomerCost,
  postCustomerOverhead,
  supportLevelOf,
} from './overhead';
import { Rng } from './rng';
import { deserialize } from './save';
import { subscriberUnits } from './sales';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { BuildStage, CableMethod, Command, GameState, MonthlyReport, SegmentId, SupportLevel } from './types';

// Default grid: horizontal segments 0..8 are 240 ft, vertical 9..16 are 120 ft.

function fixture(name: 'v3-town' | 'v3-grid'): GameState {
  return deserialize(readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8'));
}

function addSpan(state: GameState, segment: SegmentId, method: CableMethod, stage: BuildStage = 'live'): void {
  state.network.spans.push({
    id: state.nextId++,
    segment,
    method,
    stage,
    stageDaysLeft: stage === 'live' ? 0 : 3,
    constructDays: 1,
    cost: 0,
    refundable: 0,
    orderedDay: 0,
    liveDay: stage === 'live' ? 0 : null,
    outage: null,
    conversion: null,
  });
  state.network.version++;
}

function addCabinet(state: GameState, node: number, stage: BuildStage = 'live'): void {
  state.network.cabinets.push({
    id: state.nextId++,
    node,
    splitters: 1,
    stage,
    stageDaysLeft: stage === 'live' ? 0 : 5,
    cost: 0,
    orderedDay: 0,
    liveDay: stage === 'live' ? 0 : null,
  });
  state.network.version++;
}

/** Two subscribed homes at the grid's cabinet (marketing off). */
function twoSubscribers(): GameState {
  const state = makeTestState();
  const cabinet = addLivePlant(state)!;
  state.sales.marketingPerMonth = 0;
  state.sales.accounts = [
    { parcel: 0, cabinet, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 0, locks: [] },
    { parcel: 2, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] },
  ];
  return state;
}

function setLevel(state: GameState, level: SupportLevel): void {
  expect(applyCommand(state, { type: 'setSupport', level })).toMatchObject({ ok: true });
}

/** "1.4": miles to one decimal, as the plant memo writes them. */
function tenths(miles: number): string {
  return (Math.round(miles * 10) / 10).toFixed(1);
}

/** Tick until the next month close; that close's report. */
function tickThroughClose(state: GameState): MonthlyReport {
  const count = state.finance.reports.length;
  for (let i = 0; i < 40 && !state.gameOver; i++) {
    tick(state);
    if (state.finance.reports.length > count) return state.finance.reports.at(-1)!;
  }
  throw new Error('no close within 40 days');
}

describe('overhead rates', () => {
  it('are the base, per customer with the support level, and per unit of plant', () => {
    const state = makeTestState();
    const rates = overheadRates(state);
    const support = SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL].costPerSub;
    expect(rates).toEqual({
      base: OVERHEAD_BASE_PER_MONTH,
      perCustomer: OVERHEAD_PER_CUSTOMER_PER_MONTH + support,
      support,
      supportLevel: DEFAULT_SUPPORT_LEVEL,
      perCabinet: OVERHEAD_PER_CABINET_PER_MONTH,
      perMile: OVERHEAD_PER_MILE_PER_MONTH,
      cabinets: 0,
      miles: 0,
    });
    expect(perCustomerCost(state)).toBe(rates.perCustomer);
    expect(supportLevelOf(state)).toBe(DEFAULT_SUPPORT_LEVEL);
  });

  it('change only the per-customer part with the support level', () => {
    const state = makeTestState();
    addLivePlant(state);
    const good = overheadRates(state);
    for (const level of SUPPORT_LEVEL_IDS) {
      setLevel(state, level);
      const rates = overheadRates(state);
      expect(rates).toEqual({
        ...good,
        supportLevel: level,
        support: SUPPORT_LEVELS[level].costPerSub,
        perCustomer: OVERHEAD_PER_CUSTOMER_PER_MONTH + SUPPORT_LEVELS[level].costPerSub,
      });
      expect(rates.support).toBeLessThanOrEqual(rates.perCustomer);
      expect(perCustomerCost(state)).toBe(rates.perCustomer);
    }
  });

  it('fall back to the default support level for a state without customers', () => {
    const state = makeTestState();
    const bare = { ...state, customers: undefined } as unknown as GameState;
    expect(supportLevelOf(bare)).toBe(DEFAULT_SUPPORT_LEVEL);
    expect(perCustomerCost(bare)).toBe(perCustomerCost(state));
  });
});

describe('live plant', () => {
  it('counts only live cabinets and the route-miles of live cable', () => {
    const state = makeTestState();
    addSpan(state, 0, 'aerial');
    addSpan(state, 9, 'underground');
    addSpan(state, 1, 'aerial', 'constructing');
    addSpan(state, 2, 'underground', 'permitting');
    addCabinet(state, 0);
    addCabinet(state, 5, 'constructing');
    const feet = state.city.segments[0]!.lengthFt + state.city.segments[9]!.lengthFt;
    expect(livePlant(state)).toEqual({ cabinets: 1, miles: feet / FEET_PER_MILE });
    expect(overheadRates(state)).toMatchObject({ cabinets: 1, miles: feet / FEET_PER_MILE });
    // A span under repair is still plant to look after.
    state.network.spans[0]!.outage = { cause: 'storm', storm: null, startDay: 0, daysLeft: 3, repairCost: 0 };
    expect(livePlant(state).miles).toBe(feet / FEET_PER_MILE);
  });

  it('prices the per-plant line once, rounded, from the live plant', () => {
    const state = makeTestState();
    expect(fixedOverheadLines(state)).toEqual({ base: OVERHEAD_BASE_PER_MONTH, perPlant: 0 });
    addLivePlant(state);
    addCabinet(state, 5);
    const plant = livePlant(state);
    expect(plant.cabinets).toBe(2);
    expect(fixedOverheadLines(state)).toEqual({
      base: OVERHEAD_BASE_PER_MONTH,
      perPlant: Math.round(plant.cabinets * OVERHEAD_PER_CABINET_PER_MONTH + plant.miles * OVERHEAD_PER_MILE_PER_MONTH),
    });
    // Plant still being built costs nothing to run yet.
    addCabinet(state, 7, 'constructing');
    addSpan(state, 16, 'aerial', 'constructing');
    expect(fixedOverheadLines(state).perPlant).toBe(Math.round(plant.cabinets * OVERHEAD_PER_CABINET_PER_MONTH + plant.miles * OVERHEAD_PER_MILE_PER_MONTH));
  });
});

describe('a month of overhead at today\'s size', () => {
  it('is the fixed lines plus per customer for today\'s subscribers, each rounded once', () => {
    const state = twoSubscribers();
    const fixed = fixedOverheadLines(state);
    const units = subscriberUnits(state);
    expect(units).toBe(2);
    const support = SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL].costPerSub;
    const month = estimateMonthlyOverhead(state);
    expect(month).toEqual({ base: fixed.base, perCustomer: units * (OVERHEAD_PER_CUSTOMER_PER_MONTH + support), support: units * support, perPlant: fixed.perPlant });
    expect(overheadTotal(month)).toBe(fixed.base + fixed.perPlant + units * perCustomerCost(state));
  });

  it('gives the funding cushion a month of every overhead line plus marketing, and grows with the network', () => {
    const empty = makeTestState();
    // A company that has built nothing: the base and its marketing budget.
    expect(fixedCostsPerMonth(empty)).toBe(OVERHEAD_BASE_PER_MONTH + empty.sales.marketingPerMonth);
    const state = twoSubscribers();
    state.sales.marketingPerMonth = empty.sales.marketingPerMonth;
    expect(fixedCostsPerMonth(state)).toBe(overheadTotal(estimateMonthlyOverhead(state)) + state.sales.marketingPerMonth);
    expect(fixedCostsPerMonth(state)).toBeGreaterThan(fixedCostsPerMonth(empty));
    // More plant and more customers: more to cover.
    const before = fixedCostsPerMonth(state);
    addCabinet(state, 5);
    expect(fixedCostsPerMonth(state)).toBe(before + OVERHEAD_PER_CABINET_PER_MONTH);
    const cabinet = state.network.cabinets[0]!.id;
    state.sales.accounts.push({ parcel: 4, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] });
    expect(fixedCostsPerMonth(state)).toBe(before + OVERHEAD_PER_CABINET_PER_MONTH + perCustomerCost(state));
    // A dearer support level costs more a month.
    setLevel(state, 'great');
    expect(fixedCostsPerMonth(state)).toBe(before + OVERHEAD_PER_CABINET_PER_MONTH + 3 * perCustomerCost(state) - 2 * (OVERHEAD_PER_CUSTOMER_PER_MONTH + SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL].costPerSub));
  });

  it('follows the size of a real network: the frozen town costs more to run than a new game', () => {
    const town = fixture('v3-town');
    const fresh = newGame(town.seed);
    expect(livePlant(town).cabinets).toBeGreaterThan(0);
    expect(subscriberUnits(town)).toBeGreaterThan(0);
    const month = estimateMonthlyOverhead(town);
    expect(month.perPlant).toBeGreaterThan(0);
    expect(month.perCustomer).toBe(subscriberUnits(town) * perCustomerCost(town));
    expect(fixedCostsPerMonth(town) - town.sales.marketingPerMonth).toBeGreaterThan(fixedCostsPerMonth(fresh) - fresh.sales.marketingPerMonth);
  });
});

describe('posting the overhead at a close', () => {
  it('posts the base and the plant upkeep as their own entries, dated the ended month\'s last day', () => {
    const state = makeTestState();
    addLivePlant(state);
    state.day = 90; // Apr 1: March ended on day 89
    const label = formatMonth(2027, 3);
    const plant = livePlant(state);
    const fixed = closeOverhead(state, 89, label);
    expect(fixed).toEqual(fixedOverheadLines(state));
    expect(state.finance.monthToDate).toEqual([
      { day: 89, category: 'overhead', amount: -OVERHEAD_BASE_PER_MONTH, memo: 'Overhead for Mar 2027: office and systems' },
      { day: 89, category: 'overhead', amount: -fixed.perPlant, memo: `Plant upkeep for Mar 2027: 1 cabinet, ${tenths(plant.miles)} miles of cable` },
    ]);
  });

  it('skips a line of $0 and names only the plant there is', () => {
    const state = makeTestState();
    closeOverhead(state, 30, 'Jan 2027');
    expect(state.finance.monthToDate.map((e) => e.memo)).toEqual(['Overhead for Jan 2027: office and systems']);

    const cable = makeTestState();
    for (let s = 0; s < 9; s++) addSpan(cable, s, 'aerial');
    addCabinet(cable, 1);
    addCabinet(cable, 2);
    closeOverhead(cable, 30, 'Jan 2027');
    expect(cable.finance.monthToDate[1]!.memo).toBe(`Plant upkeep for Jan 2027: 2 cabinets, ${tenths(livePlant(cable).miles)} miles of cable`);

    const cabinetOnly = makeTestState();
    addCabinet(cabinetOnly, 1);
    closeOverhead(cabinetOnly, 30, 'Jan 2027');
    expect(cabinetOnly.finance.monthToDate[1]).toEqual({ day: 30, category: 'overhead', amount: -OVERHEAD_PER_CABINET_PER_MONTH, memo: 'Plant upkeep for Jan 2027: 1 cabinet' });
  });

  it('prices the customer line from the month\'s subscriber-days at the support level, and names both', () => {
    const state = twoSubscribers();
    const days = 31;
    // 2 subscribers all month, a third for 10 days.
    const unitDays = 2 * days + 10;
    const before = state.finance.cash;
    const posted = postCustomerOverhead(state, 30, 'Jan 2027', unitDays, days);
    const support = SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL].costPerSub;
    expect(posted).toEqual({
      perCustomer: Math.round(((OVERHEAD_PER_CUSTOMER_PER_MONTH + support) * unitDays) / days),
      support: Math.round((support * unitDays) / days),
    });
    expect(state.finance.monthToDate).toEqual([
      { day: 30, category: 'overhead', amount: -posted.perCustomer, memo: `Customer costs for Jan 2027: ${Math.round(unitDays / days)} customers on ${SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL].name} support` },
    ]);
    expect(state.finance.cash).toBe(before - posted.perCustomer);

    // One customer for a day still reads as one customer.
    const one = twoSubscribers();
    const tiny = postCustomerOverhead(one, 30, 'Jan 2027', 1, days);
    if (tiny.perCustomer > 0) expect(one.finance.monthToDate[0]!.memo).toBe(`Customer costs for Jan 2027: 1 customer on ${SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL].name} support`);

    // No customers: nothing posted.
    const none = twoSubscribers();
    expect(postCustomerOverhead(none, 30, 'Jan 2027', 0, days)).toEqual({ perCustomer: 0, support: 0 });
    expect(none.finance.monthToDate).toEqual([]);
  });

  it('changes only the per-customer line with the support level', () => {
    const lines = new Map<SupportLevel, ReturnType<typeof overheadLinesOf>>();
    for (const level of SUPPORT_LEVEL_IDS) {
      const state = twoSubscribers();
      setLevel(state, level);
      state.sales.month.subscriberUnitDays = 2 * 31;
      state.day = 31;
      const report = closeMonth(state, 0, new Rng(1));
      const overhead = report.ops!.overhead!;
      lines.set(level, overhead);
      const subs = report.stats!.subscriberDays;
      expect(overhead.perCustomer).toBe(Math.round(((OVERHEAD_PER_CUSTOMER_PER_MONTH + SUPPORT_LEVELS[level].costPerSub) * subs) / 31));
      expect(overhead.support).toBe(Math.round((SUPPORT_LEVELS[level].costPerSub * subs) / 31));
      expect(overheadTotal(overhead)).toBe(-(report.totals.overhead ?? 0));
      expect(state.finance.reports[0]!.totals.overhead).toBe(report.totals.overhead);
    }
    const good = lines.get('good')!;
    for (const level of SUPPORT_LEVEL_IDS) {
      const l = lines.get(level)!;
      expect(l.base).toBe(good.base);
      expect(l.perPlant).toBe(good.perPlant);
    }
    expect(lines.get('basic')!.perCustomer).toBeLessThan(good.perCustomer);
    expect(lines.get('great')!.perCustomer).toBeGreaterThan(good.perCustomer);
  });
});

describe('the overhead lines in real play', () => {
  it('sum to the month\'s overhead exactly at every close, outage days left out of the customer line', () => {
    // The frozen town played on through storms (from its second year), changing the support level on the way.
    const state = fixture('v3-town');
    let outageMonths = 0;
    const levels: SupportLevel[] = ['good', 'great', 'basic', 'good'];
    for (let close = 0; close < 16; close++) {
      if (close % 4 === 0) setLevel(state, levels[(close / 4) % levels.length]!);
      // The lines a close will post for plant as it stands on the month's last day.
      while (dateOf(state.day + 1).day !== 1) tick(state);
      const fixed = fixedOverheadLines(state);
      const rate = perCustomerCost(state);
      const supportRate = SUPPORT_LEVELS[supportLevelOf(state)].costPerSub;
      const report = tickThroughClose(state);
      const lines = report.ops!.overhead!;
      const days = MONTH_LENGTHS[report.month - 1] as number;
      const where = `${formatMonth(report.year, report.month)}`;
      expect(overheadTotal(lines), where).toBe(-(report.totals.overhead ?? 0));
      expect(lines.base, where).toBe(fixed.base);
      expect(lines.perPlant, where).toBe(fixed.perPlant);
      // subscriberDays (the accrual) already leaves out units cut off by an outage.
      expect(lines.perCustomer, where).toBe(Math.round((rate * report.stats!.subscriberDays) / days));
      expect(lines.support, where).toBe(Math.round((supportRate * report.stats!.subscriberDays) / days));
      expect(lines.support).toBeLessThanOrEqual(lines.perCustomer);
      if (report.ops!.outageUnitDays > 0) outageMonths++;
    }
    expect(state.gameOver).toBeNull();
    expect(outageMonths).toBeGreaterThan(0);
  });

  it('are projected exactly on the month\'s last day (estimateCashAtClose)', () => {
    const state = fixture('v3-grid');
    for (let close = 0; close < 3; close++) {
      while (dateOf(state.day + 1).day !== 1) tick(state);
      const projected = estimateCashAtClose(state);
      const report = tickThroughClose(state);
      expect(report.cashEnd - (report.totals.interest ?? 0) - (report.totals.principal ?? 0), `close ${close}`).toBe(projected);
    }
  });
});

describe('difficulty', () => {
  it('changes only the starting cash: the same rates, the same overhead at every close, the same play', () => {
    const play: Command[] = [{ type: 'setMarketing', perMonth: 500 }];
    const runs = DIFFICULTY_LEVELS.map((level) => {
      const state = newGame(4242, { difficulty: level.id });
      expect(state.finance.cash).toBe(level.startCash);
      return { level, state };
    });
    const [first] = runs;
    const rates = overheadRates(first!.state);
    const cushion = fixedCostsPerMonth(first!.state);
    for (const { state } of runs) {
      expect(overheadRates(state)).toEqual(rates);
      expect(fixedCostsPerMonth(state)).toBe(cushion);
      for (const cmd of play) expect(applyCommand(state, cmd)).toMatchObject({ ok: true });
      // A small network: a cabinet at the CO and its streets, cheap enough for every level.
      addLivePlant(state, { segments: state.city.segments.filter((s) => s.a === state.city.coNode || s.b === state.city.coNode).map((s) => s.id) });
      runDays(state, 150);
    }
    // Real play: closes with customers and plant to run.
    expect(first!.state.finance.reports.length).toBeGreaterThanOrEqual(4);
    expect(first!.state.finance.reports.at(-1)!.ops!.overhead!.perCustomer).toBeGreaterThan(0);
    expect(first!.state.finance.reports.at(-1)!.ops!.overhead!.perPlant).toBeGreaterThan(0);
    for (const { level, state } of runs) {
      expect(state.finance.reports.map((r) => r.ops?.overhead)).toEqual(first!.state.finance.reports.map((r) => r.ops?.overhead));
      expect(state.finance.reports.map((r) => r.totals)).toEqual(first!.state.finance.reports.map((r) => r.totals));
      expect(state.finance.cash - level.startCash).toBe(first!.state.finance.cash - first!.level.startCash);
      expect(state.sales.accounts).toEqual(first!.state.sales.accounts);
    }
  });

  it('starts a new company at the same base whatever its purse', () => {
    for (const level of DIFFICULTY_LEVELS) {
      const state = newGame(9, { difficulty: level.id });
      expect(estimateMonthlyOverhead(state)).toEqual({ base: OVERHEAD_BASE_PER_MONTH, perCustomer: 0, support: 0, perPlant: 0 });
    }
  });
});

describe('a grid town without subscribers', () => {
  it('closes with the base only, on the grid fixture town', () => {
    const state = makeTestState(makeGridCity({ cols: 2, rows: 1 }));
    state.day = 31;
    const report = closeMonth(state, 0, new Rng(1));
    expect(report.ops!.overhead).toEqual({ base: OVERHEAD_BASE_PER_MONTH, perCustomer: 0, support: 0, perPlant: 0 });
    expect(report.totals.overhead).toBe(-OVERHEAD_BASE_PER_MONTH);
  });
});
