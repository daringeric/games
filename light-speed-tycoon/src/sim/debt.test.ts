// Financing (debt.ts). The contract's state helpers are covered here; the
// sim-debt workstream adds the rest (pricing, amortization, quotes, commands,
// the daily step, the month close, covenants and default).

import { describe, expect, it } from 'vitest';
import {
  ARR_TRAILING_MONTHS,
  BASE_RATE_BPS,
  CREDIT_LIMIT_ARR_MULTIPLE,
  CREDIT_LINE_EXTRA_BPS,
  LOAN_ROUNDING,
  PENALTY_STEP_UP_BPS,
} from './balance';
import { creditAvailable, creditLimit, newDebt, penaltyBps, rateOf, totalDebt, trailingArr } from './debt';
import { makeTestState } from './testing/fixtures';
import type { GameState, MonthlyReport } from './types';

/** A closed month with only revenue on the books (enough for the trailing figures). */
function report(month: number, revenue: number): MonthlyReport {
  return { year: 2027, month, totals: revenue > 0 ? { revenue } : {}, net: revenue, cashEnd: 0, passings: 0 };
}

function withRevenue(...revenues: number[]): GameState {
  const state = makeTestState();
  state.finance.reports = revenues.map((r, i) => report(i + 1, r));
  return state;
}

describe('newDebt', () => {
  it('starts with nothing borrowed, compliant, the line priced at base plus its product adjustment', () => {
    expect(newDebt()).toEqual({
      credit: {
        balance: 0,
        rate: { baseBps: BASE_RATE_BPS, leverageBps: 0, cppBps: 0, productBps: CREDIT_LINE_EXTRA_BPS },
        balanceDollarDays: 0,
      },
      loans: [],
      nextLoanId: 1,
      covenant: { stage: 'compliant', compliantCloses: 0 },
    });
    // Fresh objects every time: a game must never share debt state with another.
    expect(newDebt()).not.toBe(newDebt());
    expect(newDebt().loans).not.toBe(newDebt().loans);
  });

  it('is what a new game starts with', () => {
    expect(makeTestState().debt).toEqual(newDebt());
  });
});

describe('totalDebt, rateOf, penaltyBps', () => {
  it('adds the line and every loan', () => {
    const state = makeTestState();
    expect(totalDebt(state)).toBe(0);
    state.debt.credit.balance = 1_500;
    state.debt.loans.push(
      { id: 1, principal: 40_000, balance: 30_000, rateBps: 700, termMonths: 60, payment: 800, monthsLeft: 40, originatedDay: 0 },
      { id: 2, principal: 20_000, balance: 20_000, rateBps: 750, termMonths: 84, payment: 300, monthsLeft: 84, originatedDay: 0 },
    );
    expect(totalDebt(state)).toBe(1_500 + 30_000 + 20_000);
  });

  it('sums rate parts without the penalty, which follows the stage', () => {
    expect(rateOf({ baseBps: 500, leverageBps: 150, cppBps: 100, productBps: 50 })).toBe(800);
    expect(penaltyBps('compliant')).toBe(0);
    expect(penaltyBps('warning')).toBe(0);
    expect(penaltyBps('penalty')).toBe(PENALTY_STEP_UP_BPS);
    expect(penaltyBps('frozen')).toBe(PENALTY_STEP_UP_BPS);
  });
});

describe('trailingArr and the credit limit', () => {
  it('is zero before the first close and with no revenue', () => {
    expect(trailingArr(makeTestState())).toBe(0);
    expect(trailingArr(withRevenue(0, 0))).toBe(0);
    expect(creditLimit(makeTestState())).toBe(0);
    expect(creditAvailable(makeTestState())).toBe(0);
  });

  it('annualizes the trailing closed months, however many there are so far', () => {
    expect(trailingArr(withRevenue(1_000))).toBe(12_000);
    const revenues = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000];
    for (let n = 1; n <= revenues.length; n++) {
      const months = revenues.slice(0, n);
      const window = months.slice(-ARR_TRAILING_MONTHS);
      const expected = Math.round((window.reduce((a, b) => a + b, 0) * 12) / window.length);
      expect(trailingArr(withRevenue(...months)), `${n} months`).toBe(expected);
    }
  });

  it('sets the limit at a multiple of ARR, rounded down, and offers what is not drawn unless frozen', () => {
    const state = withRevenue(10_417, 10_417, 10_417);
    const arr = trailingArr(state);
    const limit = Math.floor((arr * CREDIT_LIMIT_ARR_MULTIPLE) / LOAN_ROUNDING) * LOAN_ROUNDING;
    expect(creditLimit(state)).toBe(limit);
    expect(limit % LOAN_ROUNDING).toBe(0);
    expect(limit).toBeGreaterThan(0);
    expect(creditAvailable(state)).toBe(limit);

    state.debt.credit.balance = limit - LOAN_ROUNDING;
    expect(creditAvailable(state)).toBe(LOAN_ROUNDING);
    // A shrunken limit (or capitalized interest) can leave the line over its limit: nothing to draw, never negative.
    state.debt.credit.balance = limit + 5;
    expect(creditAvailable(state)).toBe(0);

    state.debt.credit.balance = 0;
    state.debt.covenant.stage = 'frozen';
    expect(creditAvailable(state)).toBe(0);
    state.debt.covenant.stage = 'penalty';
    expect(creditAvailable(state)).toBe(limit);
  });

  it('only moves at a month close: it reads closed months, not the open one', () => {
    const state = withRevenue(5_000, 5_000, 5_000);
    const before = trailingArr(state);
    state.finance.monthToDate.push({ day: state.day, category: 'revenue', amount: 99_999, memo: 'not closed yet' });
    expect(trailingArr(state)).toBe(before);
  });
});
