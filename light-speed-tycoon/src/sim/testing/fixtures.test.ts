import { describe, expect, it } from 'vitest';
import { ARR_TRAILING_MONTHS, START_YEAR } from '../balance';
import { dateOf } from '../calendar';
import { annualOperatingCashFlow, creditLimit, levelPayment, trailingArr } from '../debt';
import { closedMonth, giveHistory, makeGridCity, makeLoan, makeTradingState, noDebtStats } from './fixtures';

describe('makeGridCity', () => {
  it('builds a 3x2 grid with index-aligned ids', () => {
    const city = makeGridCity();
    expect(city.nodes).toHaveLength(12);
    expect(city.segments).toHaveLength(9 + 8);
    expect(city.parcels).toHaveLength(3 * 2 * 4 * 2);
    city.nodes.forEach((n, i) => expect(n.id).toBe(i));
    city.segments.forEach((s, i) => expect(s.id).toBe(i));
    city.parcels.forEach((p, i) => expect(p.id).toBe(i));
  });

  it('puts every parcel adjacent to its frontage segment', () => {
    const city = makeGridCity({ cols: 2, rows: 2, blockW: 3, blockH: 2 });
    for (const p of city.parcels) {
      const seg = city.segments[p.segment]!;
      const a = city.nodes[seg.a]!;
      const b = city.nodes[seg.b]!;
      expect(a.y).toBe(b.y); // fixture parcels front horizontal streets
      const touchesTop = p.y === a.y;
      const touchesBottom = p.y + p.h === a.y;
      expect(touchesTop || touchesBottom).toBe(true);
      expect(p.x).toBeGreaterThanOrEqual(Math.min(a.x, b.x));
      expect(p.x + p.w).toBeLessThanOrEqual(Math.max(a.x, b.x));
    }
  });
});

describe('financing fixtures', () => {
  it('gives a state a trading history its trailing figures read back', () => {
    const state = makeTradingState(10_000, 4_000);
    expect(state.finance.reports).toHaveLength(ARR_TRAILING_MONTHS);
    expect(trailingArr(state)).toBe(10_000 * 12);
    expect(annualOperatingCashFlow(state)).toBe(6_000 * 12);
    // The day is the 10th of the month after the history, which ends just before it.
    const date = dateOf(state.day);
    expect(date.day).toBe(10);
    const last = state.finance.reports.at(-1)!;
    expect(last.month % 12).toBe((date.month - 1) % 12);
    expect(giveHistory(state, 500, 0, 1).finance.reports).toEqual([closedMonth(START_YEAR, 1, 500)]);
  });

  it('makes a loan with a level payment, and the no-debt stats a close writes', () => {
    const loan = makeLoan({ balance: 30_000, monthsLeft: 24 });
    expect(loan).toMatchObject({ principal: 30_000, balance: 30_000, monthsLeft: 24, termMonths: 60 });
    expect(loan.payment).toBe(levelPayment(30_000, loan.rateBps, 24));
    const state = makeTradingState(10_000);
    expect(noDebtStats(state)).toMatchObject({ arr: trailingArr(state), creditLimit: creditLimit(state), leverageX100: 0, coverageX100: null, stage: 'compliant' });
  });
});
