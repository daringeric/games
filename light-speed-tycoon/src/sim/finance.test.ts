import { describe, expect, it } from 'vitest';
import { OLT_START_PON_PORTS, POLE_RENT_PER_POLE_PER_MONTH, START_CASH } from './balance';
import { canAfford, closeMonth, formatMoney, groupThousands, monthlyPoleRent, postEntry } from './finance';
import { makeGridCity } from './testing/fixtures';
import type { BuildStage, CableMethod, City, GameState, SegmentId } from './types';

// Default grid: horizontal segments 0..8 are 240 ft (2 poles), vertical 9..16 are 120 ft (1 pole).

function makeState(city: City = makeGridCity()): GameState {
  return {
    schemaVersion: 1,
    seed: 1,
    day: 0,
    rng: { events: 12345 },
    nextId: 1,
    city,
    network: { spans: [], cabinets: [], olt: { ponPorts: OLT_START_PON_PORTS, tech: 'gpon' }, version: 0 },
    finance: { cash: START_CASH, monthToDate: [], reports: [] },
  };
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

describe('closeMonth', () => {
  it('posts pole rent on the last day and reports the ended month', () => {
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
    const report = closeMonth(state, 42);
    const rent = 4 * POLE_RENT_PER_POLE_PER_MONTH;
    expect(report).toEqual({
      year: 2027,
      month: 1,
      totals: { construction: -6_000, equipment: -16_200, refund: 1_200, poleRent: -rent },
      net: -21_000 - rent,
      cashEnd: START_CASH - 21_000 - rent,
      passings: 42,
    });
    expect(Object.keys(report.totals)).toEqual(['construction', 'equipment', 'refund', 'poleRent']);
    expect(state.finance.cash).toBe(START_CASH - 21_000 - rent);
    expect(state.finance.reports).toEqual([report]);
    expect(state.finance.monthToDate).toEqual([]);
  });

  it('dates the pole rent entry on the last day of the ended month', () => {
    const state = makeState();
    addSpan(state, 0, 'aerial');
    state.day = 59; // Mar 1: February just ended
    const before = state.finance.monthToDate;
    closeMonth(state, 0);
    expect(before.at(-1)).toEqual({
      day: 58,
      category: 'poleRent',
      amount: -2 * POLE_RENT_PER_POLE_PER_MONTH,
      memo: 'Pole rent for Feb 2027: 2 poles x $2',
    });
    expect(state.finance.reports[0]).toMatchObject({ year: 2027, month: 2 });
  });

  it('omits categories with no entries and skips rent when nothing is on poles', () => {
    const state = makeState();
    addSpan(state, 0, 'underground');
    state.day = 365; // Jan 1 2028
    const report = closeMonth(state, 0);
    expect(report).toEqual({ year: 2027, month: 12, totals: {}, net: 0, cashEnd: START_CASH, passings: 0 });
  });

  it('appends reports oldest first', () => {
    const state = makeState();
    state.day = 31;
    closeMonth(state, 1);
    state.day = 59;
    closeMonth(state, 2);
    expect(state.finance.reports.map((r) => [r.month, r.passings])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it('refuses to close before any month has ended', () => {
    expect(() => closeMonth(makeState(), 0)).toThrow(RangeError);
  });
});
