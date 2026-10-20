import { describe, expect, it } from 'vitest';
import {
  INSOLVENCY_GRACE_MONTHS,
  OLT_START_PON_PORTS,
  OVERHEAD_PER_MONTH,
  POLE_RENT_PER_POLE_PER_MONTH,
  START_CASH,
  SUPPORT_COST_PER_SUB_PER_MONTH,
} from './balance';
import {
  canAfford,
  checkInsolvency,
  closeMonth,
  formatMoney,
  groupThousands,
  monthlyPoleRent,
  postEntry,
  postEntryOn,
  runwayMonths,
} from './finance';
import { operatingCashFlow } from './metrics';
import { Rng } from './rng';
import { subscriberUnits } from './sales';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { BuildStage, CableMethod, City, GameState, MonthlyReport, SegmentId } from './types';

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
  });
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
    const net = -21_000 - rent - OVERHEAD_PER_MONTH;
    expect(report).toEqual({
      year: 2027,
      month: 1,
      totals: { construction: -6_000, equipment: -16_200, refund: 1_200, poleRent: -rent, overhead: -OVERHEAD_PER_MONTH },
      net,
      cashEnd: START_CASH + net,
      passings: 42,
      stats: ZERO_STATS,
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
    close(state);
    expect(before).toEqual([
      { day: 58, category: 'poleRent', amount: -2 * POLE_RENT_PER_POLE_PER_MONTH, memo: `Pole rent for Feb 2027: 2 poles x ${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}` },
      { day: 58, category: 'overhead', amount: -OVERHEAD_PER_MONTH, memo: 'Overhead for Feb 2027' },
    ]);
    expect(state.finance.reports[0]).toMatchObject({ year: 2027, month: 2 });
  });

  it('charges only overhead when nothing else happened', () => {
    const state = makeState();
    addSpan(state, 0, 'underground');
    state.day = 365; // Jan 1 2028
    const report = close(state);
    expect(report).toEqual({
      year: 2027,
      month: 12,
      totals: { overhead: -OVERHEAD_PER_MONTH },
      net: -OVERHEAD_PER_MONTH,
      cashEnd: START_CASH - OVERHEAD_PER_MONTH,
      passings: 0,
      stats: ZERO_STATS,
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
      { parcel: 0, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 3 },
      { parcel: 2, cabinet, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 9 },
    ];
    state.sales.connectsTotal = 5;
    state.sales.fullCabinets = [cabinet];
    state.sales.month = { revenueDollarDays: 31 * 125, marketingDollarDays: 31 * 1_000, subscriberUnitDays: 31 * 2, grossAdds: 5, lostService: 3 };
    state.finance.capex = { osp: 1_000, connect: 4_250, co: 18_000 };
    state.day = 31;
    const before = state.finance.monthToDate;
    const report = close(state, 8);

    expect(before.map((e) => [e.day, e.category, e.memo])).toEqual([
      [30, 'poleRent', `Pole rent for Jan 2027: 2 poles x ${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}`],
      [30, 'overhead', 'Overhead for Jan 2027'],
      [30, 'revenue', 'Subscriber billing for Jan 2027: 2 subscribers'],
      [30, 'marketing', 'Marketing for Jan 2027'],
      [30, 'overhead', 'Customer support'],
    ]);
    expect(report.totals).toEqual({
      revenue: 125,
      poleRent: -2 * POLE_RENT_PER_POLE_PER_MONTH,
      overhead: -OVERHEAD_PER_MONTH - 2 * SUPPORT_COST_PER_SUB_PER_MONTH,
      marketing: -1_000,
    });
    const subscribers = subscriberUnits(state);
    expect(report.stats).toEqual({
      subscribers,
      accounts: state.sales.accounts.length,
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
    expect(state.sales.month).toEqual({ revenueDollarDays: 0, marketingDollarDays: 0, subscriberUnitDays: 0, grossAdds: 0, lostService: 0 });
  });

  it('checks milestones and insolvency after the report is filed', () => {
    const state = makeState();
    state.finance.cash = OVERHEAD_PER_MONTH - 1;
    state.day = 31;
    const report = close(state, 3);
    expect(state.milestones).toEqual([{ id: 'firstLight', day: 31 }]);
    expect(report.cashEnd).toBe(-1);
    expect(state.finance.negativeMonths).toBe(1);
    expect(state.notices.map((n) => n.kind)).toEqual(['milestone', 'insolvencyWarning']);
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
    state.finance.cash = OVERHEAD_PER_MONTH; // ends the close at exactly 0
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
