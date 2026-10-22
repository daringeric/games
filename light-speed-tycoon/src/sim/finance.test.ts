import { describe, expect, it } from 'vitest';
import {
  ACCELERATION_CLOSES,
  COVENANT_CURE_CLOSES,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  DEFAULT_SUPPORT_LEVEL,
  FROZEN_ACCELERATION_CLOSES,
  FROZEN_SWEEP_SHARE,
  INSOLVENCY_GRACE_MONTHS,
  LATE_FEE_MIN,
  LATE_FEE_SHARE,
  OLT_START_PON_PORTS,
  OVERHEAD_BASE_PER_MONTH,
  PENALTY_STEP_UP_BPS,
  POLE_RENT_PER_POLE_PER_MONTH,
  REFERRAL_CREDIT,
  START_CASH,
  SUPPORT_LEVELS,
  TERM_LOAN_MIN,
} from './balance';
import { dateOf, DAYS_PER_YEAR, formatMonth, MONTH_LENGTHS } from './calendar';
import {
  amortize,
  annualDebtService,
  annualOperatingCashFlow,
  closeDebtMonth,
  covenantMetrics,
  creditLimit,
  estimateNextDebtService,
  formatRateBps,
  levelPayment,
  penaltyBps,
  priceRate,
  pricingCpp,
  rateOf,
  stubDays,
  totalDebt,
  trailingArr,
} from './debt';
import {
  canAfford,
  checkInsolvency,
  closeMonth,
  estimateCashAtClose,
  estimateMonthOperatingCashFlow,
  formatMoney,
  groupThousands,
  monthlyPoleRent,
  postEntry,
  postEntryOn,
  monthlyBurn,
  runwayMonths,
} from './finance';
import { applyCommand, runDays, tick } from './game';
import { operatingCashFlow, REPAIR_TRAILING_MONTHS } from './metrics';
import { fixedOverheadLines, livePlant, perCustomerCost } from './overhead';
import { getService } from './network';
import { Rng } from './rng';
import { accrueDay, monthlyRecurringRevenue, subscriberUnits } from './sales';
import { addLivePlant, makeGridCity, makeLoan, makeTestState, makeTradingState, noDebtStats, quietCustomerStats, quietOpsStats } from './testing/fixtures';
import type { BuildStage, CableMethod, City, Command, CovenantStage, GameState, LedgerEntry, MonthlyReport, SegmentId, TermLoan } from './types';

// Default grid: horizontal segments 0..8 are 240 ft (2 poles), vertical 9..16 are 120 ft (1 pole).

function makeState(city: City = makeGridCity()): GameState {
  return makeTestState(city);
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
}

/** The fixed overhead a close posts for today's plant: base + per plant (overhead.fixedOverheadLines). */
function fixedOverhead(state: GameState): number {
  const lines = fixedOverheadLines(state);
  return lines.base + lines.perPlant;
}

/** The ledger entries overhead.closeOverhead posts for today's plant, dated `day` and labelled `label` ($0 lines left out). */
function fixedOverheadEntries(state: GameState, day: number, label: string): LedgerEntry[] {
  const lines = fixedOverheadLines(state);
  const entries: LedgerEntry[] = [];
  if (lines.base !== 0) entries.push({ day, category: 'overhead', amount: -lines.base, memo: `Overhead for ${label}: office and systems` });
  if (lines.perPlant !== 0) entries.push({ day, category: 'overhead', amount: -lines.perPlant, memo: expect.stringMatching(new RegExp(`^Plant upkeep for ${label}: `)) as unknown as string });
  return entries;
}

describe('formatting', () => {
  it('groups thousands and formats money', () => {
    expect(groupThousands(0)).toBe('0');
    expect(groupThousands(999)).toBe('999');
    expect(groupThousands(1_320)).toBe('1,320');
    expect(groupThousands(1_500_000)).toBe('1,500,000');
    expect(formatMoney(12_400)).toBe('$12,400');
    expect(formatMoney(-3_000)).toBe('-$3,000');
    expect(formatMoney(0)).toBe('$0');
  });
});

describe('postEntry', () => {
  it('records a dated entry and applies it to cash', () => {
    const state = makeState();
    state.day = 12;
    postEntry(state, 'construction', -2_400, 'Aerial cable');
    postEntry(state, 'refund', 400, 'Refund');
    expect(state.finance.monthToDate).toEqual([
      { day: 12, category: 'construction', amount: -2_400, memo: 'Aerial cable' },
      { day: 12, category: 'refund', amount: 400, memo: 'Refund' },
    ]);
    expect(state.finance.cash).toBe(START_CASH - 2_000);
  });

  it('lets cash go negative', () => {
    const state = makeState();
    state.finance.cash = 10;
    postEntry(state, 'poleRent', -50, 'Rent');
    expect(state.finance.cash).toBe(-40);
  });

  it('can date an entry on another day (month-close charges)', () => {
    const state = makeState();
    state.day = 31;
    postEntryOn(state, 30, 'overhead', -100, 'Overhead');
    expect(state.finance.monthToDate).toEqual([{ day: 30, category: 'overhead', amount: -100, memo: 'Overhead' }]);
    expect(state.finance.cash).toBe(START_CASH - 100);
    expect(() => postEntryOn(state, 30, 'other', 0.5, 'x')).toThrow(RangeError);
  });

  it('rejects fractional amounts', () => {
    const state = makeState();
    expect(() => postEntry(state, 'other', 1.5, 'x')).toThrow(RangeError);
    expect(() => postEntry(state, 'other', Number.NaN, 'x')).toThrow(RangeError);
    expect(state.finance.monthToDate).toEqual([]);
    expect(state.finance.cash).toBe(START_CASH);
  });
});

describe('canAfford', () => {
  it('compares a non-negative cost with cash', () => {
    const state = makeState();
    state.finance.cash = 1_000;
    expect(canAfford(state, 0)).toBe(true);
    expect(canAfford(state, 1_000)).toBe(true);
    expect(canAfford(state, 1_001)).toBe(false);
    expect(canAfford(state, -5)).toBe(false);
    expect(canAfford(state, Number.NaN)).toBe(false);
    state.finance.cash = -1;
    expect(canAfford(state, 0)).toBe(false);
  });
});

describe('monthlyPoleRent', () => {
  it('charges per pole on live aerial spans only', () => {
    const state = makeState();
    expect(monthlyPoleRent(state)).toBe(0);
    addSpan(state, 0, 'aerial');
    addSpan(state, 9, 'aerial');
    expect(monthlyPoleRent(state)).toBe(3 * POLE_RENT_PER_POLE_PER_MONTH);
    addSpan(state, 1, 'underground');
    addSpan(state, 2, 'aerial', 'constructing');
    addSpan(state, 3, 'aerial', 'permitting');
    expect(monthlyPoleRent(state)).toBe(3 * POLE_RENT_PER_POLE_PER_MONTH);
  });

  it('charges nothing on segments without poles', () => {
    const state = makeState(makeGridCity({ hasPoles: false }));
    addSpan(state, 0, 'aerial');
    expect(monthlyPoleRent(state)).toBe(0);
  });
});

/** closeMonth with a throwaway sales stream. */
function close(state: GameState, passings = 0, seed = 1): MonthlyReport {
  return closeMonth(state, passings, new Rng(seed));
}

const ZERO_STATS = {
  subscribers: 0,
  accounts: 0,
  subscriberDays: 0,
  grossAdds: 0,
  churned: 0,
  lostService: 0,
  connectsTotal: 0,
  capexOsp: 0,
  capexConnect: 0,
  capexCo: 0,
  ponPortsUsed: 0,
  ponPorts: OLT_START_PON_PORTS,
  fullCabinets: 0,
};

describe('closeMonth', () => {
  it('posts pole rent and overhead on the last day and reports the ended month', () => {
    const state = makeState();
    addSpan(state, 0, 'aerial');
    addSpan(state, 1, 'aerial');
    state.day = 3;
    postEntry(state, 'construction', -4_800, 'Aerial cable');
    state.day = 20;
    postEntry(state, 'equipment', -16_200, 'Cabinet');
    postEntry(state, 'construction', -1_200, 'Aerial cable');
    postEntry(state, 'refund', 1_200, 'Refund');

    state.day = 31; // Feb 1
    const report = close(state, 42);
    const rent = 4 * POLE_RENT_PER_POLE_PER_MONTH;
    // Base and upkeep of the two live aerial spans (no cabinet, no customers).
    const overhead = fixedOverhead(state);
    expect(overhead).toBeGreaterThan(OVERHEAD_BASE_PER_MONTH);
    const net = -21_000 - rent - overhead;
    expect(report).toEqual({
      year: 2027,
      month: 1,
      totals: { construction: -6_000, equipment: -16_200, refund: 1_200, poleRent: -rent, overhead: -overhead },
      net,
      cashEnd: START_CASH + net,
      passings: 42,
      stats: ZERO_STATS,
      // Every round-3 close records financing, debt or not.
      debt: noDebtStats(state),
      // Every round-4 close records its operating figures.
      ops: quietOpsStats(state),
      customers: quietCustomerStats(state),
    });
    expect(Object.keys(report.totals)).toEqual(['construction', 'equipment', 'refund', 'poleRent', 'overhead']);
    expect(state.finance.cash).toBe(START_CASH + net);
    expect(state.finance.reports).toEqual([report]);
    expect(state.finance.monthToDate).toEqual([]);
  });

  it('dates its charges on the last day of the ended month', () => {
    const state = makeState();
    addSpan(state, 0, 'aerial');
    state.day = 59; // Mar 1: February just ended
    const before = state.finance.monthToDate;
    const overhead = fixedOverheadEntries(state, 58, 'Feb 2027');
    expect(overhead).toHaveLength(2);
    close(state);
    expect(before).toEqual([
      { day: 58, category: 'poleRent', amount: -2 * POLE_RENT_PER_POLE_PER_MONTH, memo: `Pole rent for Feb 2027: 2 poles x ${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}` },
      ...overhead,
    ]);
    expect(state.finance.reports[0]).toMatchObject({ year: 2027, month: 2 });
  });

  it('charges only overhead when nothing else happened', () => {
    const state = makeState();
    addSpan(state, 0, 'underground');
    state.day = 365; // Jan 1 2028
    const overhead = fixedOverhead(state);
    const report = close(state);
    expect(report).toEqual({
      year: 2027,
      month: 12,
      totals: { overhead: -overhead },
      net: -overhead,
      cashEnd: START_CASH - overhead,
      passings: 0,
      stats: ZERO_STATS,
      debt: noDebtStats(state),
      ops: quietOpsStats(state),
      customers: quietCustomerStats(state),
    });
  });

  it('appends reports oldest first', () => {
    const state = makeState();
    state.day = 31;
    close(state, 1);
    state.day = 59;
    close(state, 2);
    expect(state.finance.reports.map((r) => [r.month, r.passings])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('refuses to close before any month has ended', () => {
    expect(() => close(makeState())).toThrow(RangeError);
  });

  it('closes sales after rent and overhead, in ledger order, and counts the month in stats', () => {
    const state = makeState();
    // Segment 0 aerial (rent), the rest underground; two cabinets with 3 + 2 splitters.
    addSpan(state, 0, 'aerial');
    const cabinet = addLivePlant(state, { splitters: 3 })!;
    addLivePlant(state, { segments: [], node: 5, splitters: 2 });
    state.sales.accounts = [
      { parcel: 0, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 3, locks: [] },
      { parcel: 2, cabinet, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 9, locks: [] },
    ];
    state.sales.connectsTotal = 5;
    state.sales.fullCabinets = [cabinet];
    state.sales.month = { revenueDollarDays: 31 * 125, marketingDollarDays: 31 * 1_000, subscriberUnitDays: 31 * 2, grossAdds: 5, lostService: 3, outageCreditDollarDays: 0 };
    state.finance.capex = { osp: 1_000, connect: 4_250, co: 18_000 };
    state.day = 31;
    const before = state.finance.monthToDate;
    const fixed = fixedOverheadLines(state);
    const plant = livePlant(state);
    const report = close(state, 8);

    expect(before.map((e) => [e.day, e.category, e.memo])).toEqual([
      [30, 'poleRent', `Pole rent for Jan 2027: 2 poles x ${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}`],
      [30, 'overhead', 'Overhead for Jan 2027: office and systems'],
      [30, 'overhead', `Plant upkeep for Jan 2027: ${plant.cabinets} cabinets, ${(Math.round(plant.miles * 10) / 10).toFixed(1)} miles of cable`],
      [30, 'revenue', 'Subscriber billing for Jan 2027: 2 subscribers'],
      [30, 'marketing', 'Marketing for Jan 2027'],
      [30, 'overhead', 'Customer costs for Jan 2027: 2 customers on Good support'],
    ]);
    expect(report.totals).toEqual({
      revenue: 125,
      poleRent: -2 * POLE_RENT_PER_POLE_PER_MONTH,
      overhead: -(fixed.base + fixed.perPlant + 2 * perCustomerCost(state)),
      marketing: -1_000,
    });
    expect(report.ops!.overhead).toEqual({ ...fixed, perCustomer: 2 * perCustomerCost(state), support: 2 * SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL].costPerSub });
    const subscribers = subscriberUnits(state);
    expect(report.stats).toEqual({
      subscribers,
      accounts: state.sales.accounts.length,
      // The month's subscriber-days (the ARPU denominator), from the accrual.
      subscriberDays: 31 * 2,
      grossAdds: 5,
      churned: 2 - subscribers,
      lostService: 3,
      connectsTotal: 5,
      capexOsp: 1_000,
      capexConnect: 4_250,
      capexCo: 18_000,
      ponPortsUsed: 5,
      ponPorts: OLT_START_PON_PORTS,
      fullCabinets: 1,
    });
    expect(state.sales.month).toEqual({ revenueDollarDays: 0, marketingDollarDays: 0, subscriberUnitDays: 0, grossAdds: 0, lostService: 0, outageCreditDollarDays: 0 });
  });

  it('checks milestones and insolvency after the report is filed', () => {
    const state = makeState();
    state.finance.cash = fixedOverhead(state) - 1;
    state.day = 31;
    const report = close(state, 3);
    expect(state.milestones).toEqual([{ id: 'firstLight', day: 31 }]);
    expect(report.cashEnd).toBe(-1);
    expect(state.finance.negativeMonths).toBe(1);
    expect(state.notices.map((n) => n.kind)).toEqual(['milestone', 'insolvencyWarning']);
  });
});

describe('outage credits (round 4b)', () => {
  /** Two homes subscribed on 1 Gig at the grid's cabinet, no marketing. */
  function trading(): GameState {
    const state = makeState();
    const cabinet = addLivePlant(state)!;
    state.sales.marketingPerMonth = 0;
    state.sales.accounts = [
      { parcel: 0, cabinet, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 0, locks: [] },
      { parcel: 2, cabinet, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 0, locks: [] },
    ];
    return state;
  }

  it('reports the month\'s outage credits in ops, with revenue already net of them', () => {
    const state = trading();
    const rate = monthlyRecurringRevenue(state) / 2;
    // January: parcel 0 cut off for 10 days.
    for (let d = 0; d < 31; d++) accrueDay(state, d < 10 ? { cutOff: new Set([0]), lent: new Map() } : null);
    state.day = 31;
    const report = close(state, 8);
    expect(report.ops!.outageCredits).toBe(Math.round((rate * 10) / 31));
    expect(report.totals.revenue).toBe(Math.round((rate * (31 + 21)) / 31));
    expect(report.totals.revenue! + report.ops!.outageCredits).toBeCloseTo(2 * rate, -0.5);
    // The cut-off home's 10 days are not charged per customer either.
    expect(report.totals.overhead).toBe(-fixedOverhead(state) - Math.round((perCustomerCost(state) * (31 + 21)) / 31));
    expect(report.ops!.overhead!.perCustomer).toBe(Math.round((perCustomerCost(state) * (31 + 21)) / 31));
  });

  it('projects the close\'s cash from billing net of credits: exact on the month\'s last day', () => {
    const state = trading();
    for (let d = 0; d < 31; d++) {
      state.day = d;
      accrueDay(state, d < 10 ? { cutOff: new Set([0]), lent: new Map() } : null);
    }
    state.day = 30;
    const projected = estimateCashAtClose(state);
    state.day = 31;
    const report = close(state, 8);
    expect(report.cashEnd).toBe(projected);
    // Round 4c/4d: the referral credits the close posts as 'marketing' are in the projection too.
    const referred = trading();
    referred.customers.referrals = true;
    for (let d = 0; d < 31; d++) {
      referred.day = d;
      accrueDay(referred);
    }
    referred.customers.month.referralMilli = 3_400;
    referred.day = 30;
    const withCredits = estimateCashAtClose(referred);
    referred.day = 31;
    const referredReport = close(referred, 8);
    expect(referredReport.customers?.referralCredits).toBe(3 * 2 * REFERRAL_CREDIT);
    expect(referredReport.cashEnd).toBe(withCredits);
    // Mid-month it bills today's subscribers for the days left (an outage under way is assumed repaired).
    const mid = trading();
    for (let d = 0; d <= 14; d++) {
      mid.day = d;
      accrueDay(mid, { cutOff: new Set([0]), lent: new Map() });
    }
    const plain = trading();
    for (let d = 0; d <= 14; d++) {
      plain.day = d;
      accrueDay(plain);
    }
    // The cut-off home's 15 days: billing not charged, and no per-customer overhead charged for them either.
    const credit = (15 * monthlyRecurringRevenue(mid)) / 2 / 31;
    const perCustomer = (15 * perCustomerCost(mid)) / 31;
    expect(Math.abs(estimateCashAtClose(plain) - estimateCashAtClose(mid) - (credit - perCustomer))).toBeLessThanOrEqual(1.5);
  });
});

describe('checkInsolvency', () => {
  function negativeClose(state: GameState, day: number): void {
    state.finance.cash = -500;
    state.day = day;
    close(state);
  }

  it('warns at each negative close, counting down, and ends the game at INSOLVENCY_GRACE_MONTHS', () => {
    const state = makeState();
    const closes = [31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
    for (let i = 1; i < INSOLVENCY_GRACE_MONTHS; i++) {
      negativeClose(state, closes[i - 1]!);
      expect(state.finance.negativeMonths).toBe(i);
      expect(state.gameOver).toBeNull();
      const warning = state.notices.at(-1)!;
      expect(warning.kind).toBe('insolvencyWarning');
      const left = INSOLVENCY_GRACE_MONTHS - i;
      expect(warning.message).toContain(`${left} more close${left === 1 ? '' : 's'} in the red`);
      expect(warning.message).toContain(formatMoney(state.finance.cash));
    }
    const day = closes[INSOLVENCY_GRACE_MONTHS - 1]!;
    negativeClose(state, day);
    expect(state.finance.negativeMonths).toBe(INSOLVENCY_GRACE_MONTHS);
    expect(state.gameOver).toMatchObject({ day, reason: 'insolvent' });
    expect(state.gameOver!.message).toMatch(/below zero/);
    expect(state.notices.at(-1)).toMatchObject({ kind: 'gameOver', message: state.gameOver!.message, day });
    expect(state.notices.filter((n) => n.kind === 'insolvencyWarning')).toHaveLength(INSOLVENCY_GRACE_MONTHS - 1);

    // Nothing more happens once the game is over.
    const after = structuredClone(state);
    checkInsolvency(state);
    expect(state).toEqual(after);
  });

  it('names the month that closed', () => {
    const state = makeState();
    negativeClose(state, 59);
    expect(state.notices.at(-1)!.message).toMatch(/^Cash is below zero at the Feb 2027 close/);
  });

  it('resets the count after a close with cash >= 0, without a notice', () => {
    const state = makeState();
    negativeClose(state, 31);
    expect(state.finance.negativeMonths).toBe(1);
    const notices = state.notices.length;
    state.finance.cash = fixedOverhead(state); // ends the close at exactly 0
    state.day = 59;
    close(state);
    expect(state.finance.cash).toBe(0);
    expect(state.finance.negativeMonths).toBe(0);
    expect(state.notices).toHaveLength(notices);
  });
});

describe('runwayMonths', () => {
  function withReport(totals: MonthlyReport['totals'], cash: number): GameState {
    const state = makeState();
    const net = Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);
    state.finance.reports.push({ year: 2027, month: 1, totals, net, cashEnd: cash, passings: 0 });
    state.finance.cash = cash;
    return state;
  }

  it('is null before the first close', () => {
    expect(runwayMonths(makeState())).toBeNull();
  });

  it('is null when the last month made or broke even on operations', () => {
    expect(runwayMonths(withReport({ revenue: 10_000, overhead: -10_000, construction: -99_000 }, 5))).toBeNull();
    expect(runwayMonths(withReport({ revenue: 20_000, overhead: -10_000 }, 5))).toBeNull();
  });

  it('divides cash by the operating burn, ignoring capex', () => {
    const totals = { revenue: 4_000, overhead: -10_000, construction: -500_000, install: -20_000 };
    const state = withReport(totals, 100_000);
    const burn = -operatingCashFlow(state.finance.reports[0]!);
    expect(burn).toBe(6_000);
    expect(runwayMonths(state)).toBe(Math.floor(100_000 / burn));
    expect(runwayMonths(withReport(totals, -1))).toBe(0);
  });
});

describe('runwayMonths with debt (round 3)', () => {
  function withReport(totals: MonthlyReport['totals'], cash: number): GameState {
    const state = makeState();
    const net = Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);
    state.finance.reports.push({ year: 2027, month: 1, totals, net, cashEnd: cash, passings: 0 });
    state.finance.cash = cash;
    return state;
  }

  it('burns debt service on top of operations, and never counts money borrowed as income', () => {
    const levered = withReport({ revenue: 4_000, overhead: -10_000, interest: -1_000, principal: -2_000, loanProceeds: 50_000 }, 90_000);
    expect(runwayMonths(levered)).toBe(Math.floor(90_000 / (6_000 + 1_000 + 2_000)));
    // Operations pay their way, but not the loans.
    const servicing = withReport({ revenue: 10_000, overhead: -8_000, interest: -1_500, principal: -1_500 }, 9_999);
    expect(runwayMonths(servicing)).toBe(Math.floor(9_999 / 1_000));
    // Borrowing does not stretch the runway.
    const borrowed = withReport({ revenue: 4_000, overhead: -10_000, loanProceeds: 100_000 }, 60_000);
    expect(runwayMonths(borrowed)).toBe(Math.floor(60_000 / 6_000));
    expect(runwayMonths(withReport({ revenue: 10_000, overhead: -8_000, interest: -2_000 }, 5))).toBeNull();
  });

  it('round 4: counts the scheduled debt service, not a voluntary repayment, and storm repairs at their yearly average', () => {
    // Operations earn $2,000; the month also repaid $30,000 of the line by choice; $1,500 a month is scheduled.
    const state = withReport({ revenue: 10_000, overhead: -8_000, interest: -1_500, principal: -30_000 }, 9_000);
    const report = state.finance.reports[0]!;
    report.debt = { ...noDebtStats(state), creditBalance: 50_000, annualDebtService: 12 * 1_500 };
    expect(monthlyBurn(state)).toBe(0);
    expect(runwayMonths(state)).toBeNull();
    report.debt.annualDebtService = 12 * 3_000;
    expect(monthlyBurn(state)).toBe(1_000);
    expect(runwayMonths(state)).toBe(9);
    // A storm month's repairs count at a twelfth of the year's repairs.
    report.totals.repair = -12_000;
    report.net -= 12_000;
    expect(monthlyBurn(state)).toBe(1_000 + 12_000 / REPAIR_TRAILING_MONTHS);
  });
});

// ---------------------------------------------------------------------------
// The month close with debt (round 3): closeDebtMonth and reviewDebt wired
// into closeMonth.
// ---------------------------------------------------------------------------

/** Monthly revenue of the trading states (a test input, not a balance figure). */
const REVENUE = 25_000;
const DAY_DIVISOR = 10_000 * DAYS_PER_YEAR;

/** REVENUE billed in each trailing month, `costs` spent, plenty of cash; the 10th of the month after. */
function trading(costs = 0): GameState {
  const state = makeTradingState(REVENUE, costs);
  state.finance.cash = START_CASH * 10;
  return state;
}

function monthStartOf(state: GameState): number {
  return state.day - dateOf(state.day).day + 1;
}

/** The 1st of the month after state.day. */
function nextCloseDay(state: GameState): number {
  return monthStartOf(state) + (MONTH_LENGTHS[dateOf(state.day).month - 1] as number);
}

/**
 * Make the open month bill `revenue` at its close (its revenue accrual set as
 * if every day had billed revenue / days), with no subscribers to show for it.
 */
function billMonth(state: GameState, revenue: number): void {
  state.sales.month.revenueDollarDays = revenue * (MONTH_LENGTHS[dateOf(state.day).month - 1] as number);
}

/** closeMonth on the 1st after state.day (no daily steps in between), with a throwaway sales stream. */
function closeNext(state: GameState): MonthlyReport {
  state.day = nextCloseDay(state);
  return close(state);
}

/** Tick up to and through the next close; returns that close's report and the month's ledger entries. */
function tickThroughClose(state: GameState): { report: MonthlyReport; entries: LedgerEntry[] } {
  const closeDay = nextCloseDay(state);
  let entries = state.finance.monthToDate;
  while (state.day < closeDay) {
    entries = state.finance.monthToDate;
    tick(state);
  }
  return { report: state.finance.reports.at(-1)!, entries };
}

function apply(state: GameState, cmd: Command): number {
  const result = applyCommand(state, cmd);
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.cost : Number.NaN;
}

function lastNotice(state: GameState) {
  return state.notices.at(-1);
}

describe('closeMonth: credit-line interest', () => {
  it('charges every end-of-day balance of the month, its last day included, at the line\'s rate', () => {
    const state = trading();
    const rate = rateOf(state.debt.credit.rate);
    const start = state.day;
    const lastDay = nextCloseDay(state) - 1;
    apply(state, { type: 'drawCredit', amount: 30_000 });
    runDays(state, 5);
    apply(state, { type: 'drawCredit', amount: 10_000 });
    runDays(state, 7);
    apply(state, { type: 'repayCredit', amount: 15_000 });
    runDays(state, lastDay - state.day);
    expect(state.day).toBe(lastDay);
    // A draw on the month's last day is held at the end of that day: it pays one day.
    apply(state, { type: 'drawCredit', amount: 5_000 });
    const dollarDays = 30_000 * 5 + 40_000 * 7 + 25_000 * (lastDay - start - 12) + 30_000;
    const { report, entries } = tickThroughClose(state);

    const interest = Math.round((dollarDays * rate) / DAY_DIVISOR);
    expect(interest).toBeGreaterThan(0);
    expect(report.totals.interest).toBe(-interest);
    expect(report.totals.principal).toBe(-15_000);
    expect(report.totals.loanProceeds).toBe(45_000);
    const label = dateLabel(report);
    expect(entries.filter((e) => e.category === 'interest')).toEqual([
      { day: lastDay, category: 'interest', amount: -interest, memo: `Interest for ${label}: credit line ${formatMoney(interest)}` },
    ]);
    // The new month starts counting from zero.
    expect(state.debt.credit.balanceDollarDays).toBe(0);
    expect(report.debt).toMatchObject({ creditBalance: 30_000, termBalance: 0, missedPayment: false });
  });

  it('is predicted exactly by estimateNextDebtService when nothing changes before the close', () => {
    const state = trading();
    // The month bills like the trailing ones, so the smoothed lending ARR (and term capacity) holds through the close.
    billMonth(state, REVENUE);
    apply(state, { type: 'drawCredit', amount: 30_000 });
    apply(state, { type: 'takeTermLoan', amount: TERM_LOAN_MIN * 2, termYears: 5 });
    tickThroughClose(state);
    // Mid-month, with one loan in its stub month and one on regular payments.
    runDays(state, 9);
    apply(state, { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: 7 });
    runDays(state, 3);
    const estimate = estimateNextDebtService(state);
    const { report } = tickThroughClose(state);
    expect(-(report.totals.interest ?? 0) - (report.totals.principal ?? 0)).toBe(estimate);
  });
});

describe('closeMonth: term loans', () => {
  it('charges stub interest the month a loan is taken, then level payments that follow its schedule', () => {
    const state = trading();
    const amount = TERM_LOAN_MIN * 6;
    apply(state, { type: 'takeTermLoan', amount, termYears: 5 });
    const loan = structuredClone(state.debt.loans[0]!);
    const { report, entries } = tickThroughClose(state);
    const stub = Math.round((amount * stubDays(loan.originatedDay) * loan.rateBps) / DAY_DIVISOR);
    expect(report.totals.interest).toBe(-stub);
    expect(report.totals.principal).toBeUndefined();
    expect(entries.find((e) => e.category === 'interest')?.memo).toMatch(new RegExp(`loan #1 \\${formatMoney(stub)} \\(first month\\)$`));
    // The stub month is not one of the regular payments.
    expect(state.debt.loans[0]).toEqual(loan);

    // Regular payments, closed with the stage held where it is, follow the exact schedule.
    const rows = amortize(amount, loan.rateBps, loan.termMonths, loan.payment);
    const books = structuredClone(state);
    for (let m = 0; m < loan.termMonths; m++) {
      books.day = nextCloseDay(books);
      const before = books.finance.monthToDate.length;
      const closed = closeDebtMonth(books, books.day - 1);
      const posted = books.finance.monthToDate.slice(before);
      expect(closed).toMatchObject({ interestPaid: rows[m]!.interest, principalPaid: rows[m]!.principal, missed: false });
      expect(posted.find((e) => e.category === 'principal')?.amount).toBe(-rows[m]!.principal);
      if (m < loan.termMonths - 1) expect(books.debt.loans[0]).toMatchObject({ balance: rows[m]!.balance, monthsLeft: loan.termMonths - m - 1 });
    }
    expect(books.debt.loans).toEqual([]);

    // The real next close: a regular payment.
    const next = tickThroughClose(state).report;
    expect(next.totals.interest).toBe(-rows[0]!.interest);
    expect(next.totals.principal).toBe(-rows[0]!.principal);
    expect(state.debt.loans[0]).toMatchObject({ balance: rows[0]!.balance, monthsLeft: loan.termMonths - 1 });
  });

  it('makes the last payment in full, closes the loan and says so', () => {
    const state = trading();
    state.debt.loans = [makeLoan({ id: 4, monthsLeft: 1, balance: 3_210, principal: 60_000 }), makeLoan({ id: 5 })];
    state.debt.nextLoanId = 6;
    const last = state.debt.loans[0]!;
    const interest = Math.round((last.balance * last.rateBps) / 120_000);
    const before = state.finance.monthToDate;
    const report = closeNext(state);
    expect(state.debt.loans.map((l) => l.id)).toEqual([5]);
    expect(before.find((e) => e.category === 'principal')?.memo).toMatch(/loan #4 \$3,210 \(paid off\)/);
    expect(report.totals.principal).toBe(-(3_210 + (makeLoan({ id: 5 }).payment - Math.round((makeLoan().balance * makeLoan().rateBps) / 120_000))));
    expect(report.totals.interest).toBeLessThanOrEqual(-interest);
    const paid = state.notices.filter((n) => n.kind === 'loanPaidOff');
    expect(paid.map((n) => n.message)).toEqual([`Term loan #4 is paid off: its last payment was made at the ${dateLabel(report)} close.`]);
  });

  it('charges the penalty surcharge on every balance while on penalty or frozen, and never fixes it into a loan', () => {
    for (const stage of ['penalty', 'frozen'] as CovenantStage[]) {
      const state = trading();
      state.debt.covenant.stage = stage;
      state.debt.credit.balance = 20_000;
      state.debt.credit.balanceDollarDays = 20_000 * 30;
      const p = penaltyBps(stage);
      expect(p).toBe(PENALTY_STEP_UP_BPS);
      // While the surcharge lasts a loan's level payment is the one that repays it at the effective rate.
      const base = makeLoan({ id: 1 });
      state.debt.loans = [{ ...base, payment: levelPayment(base.balance, base.rateBps + p, base.monthsLeft) }];
      state.debt.nextLoanId = 2;
      const loan = structuredClone(state.debt.loans[0]!);
      const line = Math.round((20_000 * 30 * (rateOf(state.debt.credit.rate) + p)) / DAY_DIVISOR);
      const loanInterest = Math.round((loan.balance * (loan.rateBps + p)) / 120_000);
      const report = closeNext(state);
      expect(report.totals.interest).toBe(-(line + loanInterest));
      expect(report.totals.principal).toBe(-(loan.payment - loanInterest));
      // The exact schedule at the effective rate: the surcharge never piles up on the last payment.
      const schedule = amortize(loan.balance, loan.rateBps + p, loan.monthsLeft, loan.payment);
      expect(schedule[0]).toMatchObject({ interest: loanInterest, principal: loan.payment - loanInterest });
      const last = schedule.at(-1)!;
      expect(last.interest + last.principal).toBeLessThanOrEqual(loan.payment);
      expect(state.debt.loans[0]!.rateBps).toBe(loan.rateBps);
    }
  });
});

/** "Apr 2027" for a report's month. */
function dateLabel(report: MonthlyReport): string {
  return formatMonth(report.year, report.month);
}

describe('closeMonth: missed payments and default', () => {
  /** Debt due at the next close with cash that cannot cover it. */
  function short(stage: CovenantStage): GameState {
    const state = trading();
    state.debt.covenant = { stage, compliantCloses: stage === 'compliant' ? 0 : 1 };
    state.debt.credit.balance = 20_000;
    state.debt.credit.balanceDollarDays = 20_000 * 9;
    state.debt.loans = [makeLoan({ id: 1 }), makeLoan({ id: 2, originatedDay: 0, balance: TERM_LOAN_MIN, principal: TERM_LOAN_MIN })];
    state.debt.loans[1]!.originatedDay = monthStartOf(state) + 2;
    state.debt.nextLoanId = 3;
    // Exactly the close's running costs (no plant, no customers: the base), so nothing is left for the payment.
    state.finance.cash = fixedOverhead(state);
    return state;
  }

  it('posts none of a payment cash cannot cover, capitalizes its interest, charges a late fee and freezes the line', () => {
    const state = short('warning');
    const [regular, stubLoan] = structuredClone(state.debt.loans);
    const p = 0;
    const line = Math.round((20_000 * 9 * (rateOf(state.debt.credit.rate) + p)) / DAY_DIVISOR);
    const regularInterest = Math.round((regular!.balance * regular!.rateBps) / 120_000);
    const stub = Math.round((stubLoan!.balance * stubDays(stubLoan!.originatedDay) * stubLoan!.rateBps) / DAY_DIVISOR);
    const due = line + regularInterest + (regular!.payment - regularInterest) + stub;
    const lateFee = Math.max(LATE_FEE_MIN, Math.round(due * LATE_FEE_SHARE));
    const before = state.finance.monthToDate;
    const report = closeNext(state);

    expect(report.totals.principal).toBeUndefined();
    expect(report.totals.interest).toBe(-lateFee);
    expect(before.filter((e) => e.category === 'interest').map((e) => e.memo)).toEqual([
      `Late fee: ${formatMoney(due)} of loan payments for ${dateLabel(report)} missed`,
    ]);
    expect(state.debt.credit.balance).toBe(20_000 + line);
    // The schedule slips a month (monthsLeft unchanged) and each payment is re-set to repay the
    // larger balance over it at the frozen line's penalty rate: no lump left for the last payment.
    const reset = (loan: TermLoan, balance: number) => ({ ...loan, balance, payment: levelPayment(balance, loan.rateBps + PENALTY_STEP_UP_BPS, loan.monthsLeft) });
    expect(state.debt.loans).toEqual([reset(regular!, regular!.balance + regularInterest), reset(stubLoan!, stubLoan!.balance + stub)]);
    expect(state.debt.covenant).toEqual({ stage: 'frozen', compliantCloses: 0 });
    expect(report.debt).toMatchObject({ missedPayment: true, stage: 'frozen', creditBalance: 20_000 + line });
    const notice = state.notices.find((n) => n.kind === 'paymentMissed')!;
    expect(notice.message).toContain(formatMoney(due));
    expect(notice.message).toContain(formatMoney(lateFee));
    expect(notice.message).toContain(`cash ${formatMoney(report.cashEnd + lateFee)}`);
    expect(notice.message).toMatch(/froze your credit line: no draws or new term loans/);
    expect(notice.message).toMatch(/Another missed payment while frozen is a default/);
    expect(state.gameOver).toBeNull();
  });

  it('ends the game with a default when a payment is missed while frozen, without also calling it insolvency', () => {
    const state = short('frozen');
    state.finance.cash = 0;
    state.day = nextCloseDay(state) - 1;
    tick(state);
    const report = state.finance.reports.at(-1)!;
    expect(state.gameOver).toMatchObject({ day: state.day, reason: 'default' });
    expect(state.gameOver!.message).toMatch(
      new RegExp(`^Default: the \\$[\\d,]+ of loan payments due at the ${dateLabel(report)} close could not be paid \\(${formatMoney(report.cashEnd).replace('$', '\\$')} in cash\\) while your credit line was frozen, so the bank has called your loans\\.$`),
    );
    expect(lastNotice(state)).toMatchObject({ kind: 'gameOver', message: state.gameOver!.message, day: state.day });
    expect(report.cashEnd).toBeLessThan(0);
    expect(state.notices.some((n) => n.kind === 'insolvencyWarning')).toBe(false);
    expect(state.finance.negativeMonths).toBe(0);
    // No late fee on a default, and nothing paid.
    expect(report.totals.interest).toBeUndefined();
    expect(report.debt).toMatchObject({ missedPayment: true, stage: 'frozen' });
    // The game stops.
    const frozen = structuredClone(state);
    runDays(state, 40);
    expect(state).toEqual(frozen);
  });
});

describe('closeMonth: covenants', () => {
  it('steps up one stage per breach, compliant to warning to penalty to frozen, with a notice for each', () => {
    // Debt with no revenue at all: leverage cannot be measured, a breach at every close.
    const state = makeTestState();
    state.day = 40;
    state.finance.cash = START_CASH * 10;
    state.debt.credit.balance = 10_000;
    const stages: CovenantStage[] = [];
    const kinds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const notices = state.notices.length;
      closeNext(state);
      stages.push(state.debt.covenant.stage);
      kinds.push(...state.notices.slice(notices).map((n) => n.kind));
      expect(state.debt.covenant.compliantCloses).toBe(0);
    }
    expect(stages).toEqual(['warning', 'penalty', 'frozen', 'frozen']);
    expect(kinds.filter((k) => k !== 'milestone')).toEqual(['covenantWarning', 'covenantPenalty', 'creditFrozen']);
    const [warning, penalty, frozen] = state.notices.filter((n) => n.kind.startsWith('covenant') || n.kind === 'creditFrozen');
    expect(warning!.message).toMatch(/^Covenant warning at the \w+ 2027 close: leverage cannot be measured: you owe \$[\d,]+ with no recurring revenue/);
    expect(warning!.message).toContain(`another breach adds a ${formatRateBps(PENALTY_STEP_UP_BPS)} penalty rate`);
    expect(penalty!.message).toMatch(/Every balance now pays [\d.]+% more .* another breach freezes the credit line/);
    expect(frozen!.message).toMatch(/^Credit line frozen at the .* close after another covenant breach: .*No draws or new term loans/);
    expect(state.finance.reports.at(-1)!.debt).toMatchObject({ stage: 'frozen', leverageX100: null, missedPayment: false });
  });

  it('names a failing coverage test with its figures and the limit', () => {
    const state = trading();
    const uw = covenantMetrics(state).underwritingCashFlow;
    // A balloon due within the year: far more debt service than cash flow.
    // Payments of a year's cash flow, with a balance that outlasts this close.
    state.debt.loans = [makeLoan({ balance: uw * 3, principal: uw * 3, monthsLeft: 2, payment: uw })];
    state.debt.nextLoanId = 2;
    closeNext(state);
    const warning = state.notices.find((n) => n.kind === 'covenantWarning')!;
    expect(warning.message).toMatch(/debt-service coverage -?[\d.]+\u00d7 is under the [\d.]+\u00d7 minimum/);
  });

  it('cures one stage at a time after COVENANT_CURE_CLOSES compliant closes in a row', () => {
    const state = trading();
    const good = structuredClone(state.finance.reports);
    state.debt.credit.balance = 5_000;
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    const stages: CovenantStage[] = [];
    const cures: string[] = [];
    for (let i = 0; i < 3 * COVENANT_CURE_CLOSES; i++) {
      // Keep the trailing months healthy: only this close's own month is new.
      state.finance.reports = structuredClone(good);
      const notices = state.notices.length;
      closeNext(state);
      expect(covenantMetrics(state).compliant).toBe(true);
      stages.push(state.debt.covenant.stage);
      cures.push(...state.notices.slice(notices).filter((n) => n.kind === 'covenantCured').map((n) => n.message));
      state.day += 3;
    }
    const expected: CovenantStage[] = [];
    for (const stage of ['penalty', 'warning', 'compliant'] as CovenantStage[]) {
      for (let k = 1; k < COVENANT_CURE_CLOSES; k++) expected.push(expected.at(-1) ?? 'frozen');
      expected.push(stage);
    }
    expect(stages).toEqual(expected);
    expect(cures).toHaveLength(3);
    expect(cures[0]).toMatch(/your standing is back to penalty\. The credit line is unfrozen, but the [\d.]+% penalty rate still applies/);
    expect(cures[1]).toMatch(/back to warning\. The [\d.]+% penalty rate is lifted/);
    expect(cures[2]).toMatch(/back to compliant\. You are back in good standing/);
    expect(state.debt.covenant.compliantCloses).toBe(0);
  });

  it('starts the count again after a breach in the middle of a cure', () => {
    const state = trading();
    const good = structuredClone(state.finance.reports);
    state.debt.credit.balance = 5_000;
    state.debt.covenant = { stage: 'frozen', compliantCloses: COVENANT_CURE_CLOSES - 1 };
    state.finance.reports = [];
    const notices = state.notices.length;
    closeNext(state);
    expect(state.debt.covenant).toEqual({ stage: 'frozen', compliantCloses: 0 });
    expect(state.notices.slice(notices).filter((n) => n.kind !== 'milestone')).toEqual([]);
    state.finance.reports = structuredClone(good);
    state.day += 3;
    closeNext(state);
    if (COVENANT_CURE_CLOSES > 1) expect(state.debt.covenant).toEqual({ stage: 'frozen', compliantCloses: 1 });
    else expect(state.debt.covenant).toEqual({ stage: 'penalty', compliantCloses: 0 });
  });

  it('returns to compliant once nothing is owed', () => {
    const state = trading();
    state.debt.covenant = { stage: 'penalty', compliantCloses: 1 };
    closeNext(state);
    expect(state.debt.covenant).toEqual({ stage: 'compliant', compliantCloses: 0 });
    expect(state.notices.filter((n) => n.kind === 'covenantCured').map((n) => n.message)).toEqual([
      expect.stringMatching(/^All debt repaid by the \w+ 2027 close: your standing is back to compliant/),
    ]);
    // Already compliant: nothing to say.
    const notices = state.notices.length;
    state.day += 3;
    closeNext(state);
    expect(state.notices.slice(notices).filter((n) => n.kind === 'covenantCured')).toEqual([]);
  });
});

describe('closeMonth: pricing and report.debt', () => {
  it('re-prices the line at each close on its leverage, the lifetime CPP and the stage', () => {
    const state = trading(REVENUE / 2);
    addLivePlant(state);
    // A red-band build.
    state.finance.capex.osp = Math.ceil(getService(state).passings * CPP_TARGET * CPP_AMBER_MULTIPLIER) + getService(state).passings;
    const uw = covenantMetrics(state).underwritingCashFlow;
    state.debt.credit.balance = Math.round(uw * 2.5);
    // The passings as the month ended, as tick() hands them to the close.
    state.day = nextCloseDay(state);
    const report = close(state, getService(state).passings);
    const m = covenantMetrics(state);
    // Priced on what the close records and the Bank shows: leverage to the hundredth, the ended month's CPP.
    expect(report.debt?.leverageX100).toBe(Math.round(m.leverage! * 100));
    expect(pricingCpp(state)).toBe(report.stats!.capexOsp / report.passings);
    const priced = priceRate({ kind: 'line' }, report.debt!.leverageX100! / 100, report.stats!.capexOsp / report.passings, state.debt.covenant.stage);
    expect(state.debt.credit.rate).toEqual({ baseBps: priced.baseBps, leverageBps: priced.leverageBps, cppBps: priced.cppBps, productBps: priced.productBps });
    expect(state.debt.credit.rate.cppBps).toBe(CPP_SPREAD_BPS.red);
    expect(state.debt.credit.rate.leverageBps).toBeGreaterThan(0);
  });

  it('records the close\'s financing figures, debt or not', () => {
    const state = trading();
    apply(state, { type: 'drawCredit', amount: 12_000 });
    apply(state, { type: 'takeTermLoan', amount: TERM_LOAN_MIN * 3, termYears: 7 });
    const { report } = tickThroughClose(state);
    const m = covenantMetrics(state);
    const total = totalDebt(state);
    const p = penaltyBps(state.debt.covenant.stage);
    let weighted = state.debt.credit.balance * (rateOf(state.debt.credit.rate) + p);
    for (const loan of state.debt.loans) weighted += loan.balance * (loan.rateBps + p);
    expect(report.debt).toEqual({
      creditBalance: 12_000,
      termBalance: TERM_LOAN_MIN * 3,
      creditLimit: creditLimit(state),
      arr: trailingArr(state),
      annualOperatingCashFlow: annualOperatingCashFlow(state),
      annualDebtService: annualDebtService(state),
      leverageX100: Math.round(m.leverage! * 100),
      coverageX100: Math.round(m.coverage! * 100),
      stage: state.debt.covenant.stage,
      averageRateBps: Math.round(weighted / total),
      missedPayment: false,
      sweep: 0,
      frozenCloses: 0,
      accelerationClosesLeft: null,
    });
    expect(state.debt.covenant.stage).toBe('compliant');
    // With no debt: zeros, null coverage and rate.
    const plain = trading();
    closeNext(plain);
    expect(plain.finance.reports.at(-1)!.debt).toEqual(noDebtStats(plain));
  });

  it('keeps financing out of operating cash flow and CPP, and in net cash flow', () => {
    const state = trading();
    addLivePlant(state);
    state.finance.capex.osp = 40_000;
    apply(state, { type: 'drawCredit', amount: 9_000 });
    apply(state, { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: 5 });
    runDays(state, 3);
    apply(state, { type: 'repayCredit', amount: 4_000 });
    apply(state, { type: 'prepayLoan', loan: 1, amount: TERM_LOAN_MIN / 2 });
    const { report } = tickThroughClose(state);
    const financing = (report.totals.interest ?? 0) + (report.totals.principal ?? 0) + (report.totals.loanProceeds ?? 0);
    expect(report.totals.loanProceeds).toBe(9_000 + TERM_LOAN_MIN);
    expect(report.totals.principal).toBe(-4_000 - TERM_LOAN_MIN / 2);
    expect(report.totals.interest).toBeLessThan(0);
    const capex = (report.totals.construction ?? 0) + (report.totals.equipment ?? 0) + (report.totals.install ?? 0) + (report.totals.refund ?? 0);
    expect(report.net - capex - financing).toBe(operatingCashFlow(report));
    expect(report.stats!.capexOsp).toBe(40_000);
    expect(state.finance.capex.osp).toBe(40_000);
  });
});

// ---------------------------------------------------------------------------
// Round 4: the frozen-line sweep and called loans through real closes
// ---------------------------------------------------------------------------

describe('closeMonth: the frozen-line sweep and called loans (round 4)', () => {
  /** Frozen with a credit-line balance, the month billing like the trailing ones. */
  function frozen(balance: number, frozenCloses = 1): GameState {
    const state = trading();
    state.debt.covenant.stage = 'frozen';
    state.debt.frozenCloses = frozenCloses;
    state.debt.credit.balance = balance;
    billMonth(state, REVENUE);
    return state;
  }

  it('takes the sweep after the debt service, in the ended month\'s principal, and the books balance', () => {
    const state = frozen(150_000);
    const cashBefore = state.finance.cash;
    const posted = state.finance.monthToDate.reduce((a, e) => a + e.amount, 0);
    const { report, entries } = tickThroughClose(state);
    const sweep = report.debt!.sweep!;
    // Its share of the month's operating cash flow (financing is not operating: the sweep leaves it alone).
    expect(sweep).toBe(Math.round(FROZEN_SWEEP_SHARE * operatingCashFlow(report)));
    expect(sweep).toBeGreaterThan(0);
    const sweepEntry = entries.find((e) => e.memo.startsWith('Frozen-line sweep'))!;
    expect(sweepEntry).toMatchObject({ category: 'principal', amount: -sweep, day: state.day - 1 });
    // The debt service is posted first, the sweep after it.
    expect(entries.indexOf(sweepEntry)).toBe(entries.length - 1);
    expect(report.totals.principal).toBe(-sweep);
    expect(report.net).toBe(Object.values(report.totals).reduce((a, b) => a + (b ?? 0), 0));
    expect(report.cashEnd).toBe(state.finance.cash);
    expect(cashBefore - posted + report.net).toBe(state.finance.cash);
    expect(state.debt.credit.balance).toBe(150_000 - sweep);
    expect(report.debt!.creditBalance).toBe(150_000 - sweep);
    expect(state.notices.some((n) => n.kind === 'debtSwept')).toBe(true);
  });

  it('estimates the month\'s operating cash flow the sweep will take its share of', () => {
    const state = frozen(150_000);
    while (dateOf(state.day + 1).day !== 1) tick(state);
    const estimate = estimateMonthOperatingCashFlow(state);
    const { report } = tickThroughClose(state);
    expect(operatingCashFlow(report)).toBe(estimate);
  });

  it(`calls the loans after ${FROZEN_ACCELERATION_CLOSES} frozen closes, then collects everything within ${ACCELERATION_CLOSES} closes`, () => {
    const state = frozen(120_000, FROZEN_ACCELERATION_CLOSES - 1);
    state.debt.loans = [makeLoan({ id: 1, principal: 90_000, balance: 80_000, monthsLeft: 48, originatedDay: 0 })];
    state.debt.nextLoanId = 2;
    const first = tickThroughClose(state).report;
    expect(first.debt).toMatchObject({ stage: 'frozen', frozenCloses: FROZEN_ACCELERATION_CLOSES, accelerationClosesLeft: ACCELERATION_CLOSES });
    expect(state.notices.filter((n) => n.kind === 'loansCalled')).toHaveLength(1);
    const lefts: Array<number | null | undefined> = [];
    for (let i = 0; i < ACCELERATION_CLOSES && totalDebt(state) > 0; i++) {
      billMonth(state, REVENUE);
      const owed = totalDebt(state);
      const { report } = tickThroughClose(state);
      expect(report.debt!.missedPayment).toBe(false);
      expect(-(report.totals.principal ?? 0)).toBeGreaterThan(0);
      expect(totalDebt(state)).toBeLessThan(owed);
      lefts.push(report.debt!.accelerationClosesLeft);
    }
    expect(totalDebt(state)).toBe(0);
    expect(state.debt.acceleration).toBeNull();
    expect(state.debt.covenant.stage).toBe('compliant');
    expect(state.gameOver).toBeNull();
    // Counted down while anything was owed, cleared with nothing left.
    expect(lefts.at(-1)).toBeNull();
    for (let i = 1; i < lefts.length - 1; i++) expect(lefts[i]).toBe((lefts[i - 1] as number) - 1);
  });

  it('defaults a called close that cannot pay, and words the runway and insolvency for called loans', () => {
    const state = frozen(400_000);
    state.debt.acceleration = { day: 0, closesLeft: 2 };
    state.finance.reports.at(-1)!.totals.interest = -1_000;
    state.finance.cash = 100_000;
    // The runway counts what falls due at the next close, not last month's payments.
    const flow = operatingCashFlow(state.finance.reports.at(-1)!) - estimateNextDebtService(state);
    expect(flow).toBeLessThan(0);
    expect(runwayMonths(state)).toBe(Math.floor(100_000 / -flow));
    // An overdraft warning while called says the next close in the red is a default.
    const warned = trading();
    warned.debt.credit.balance = 1_000;
    warned.debt.acceleration = { day: 0, closesLeft: 3 };
    warned.debt.covenant.stage = 'penalty';
    warned.finance.cash = -5;
    checkInsolvency(warned);
    expect(warned.notices.at(-1)!.message).toContain('The bank has called your loans, so the next close in the red is a default');
    // And the close that cannot pay is a default.
    tickThroughClose(state);
    expect(state.gameOver?.reason).toBe('default');
    expect(state.gameOver?.message).toMatch(/^Default: the bank called your loans/);
  });
});
