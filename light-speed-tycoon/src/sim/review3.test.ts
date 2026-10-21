// Regressions from the round-3 review of financing: each test reproduces a
// confirmed finding (numbered as in the review) and pins the fix. Money and
// limits come from balance.ts constants or quoted results, never literal
// tuning values.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCELERATION_CLOSES,
  ARR_TRAILING_MONTHS,
  COVENANT_CURE_CLOSES,
  FROZEN_ACCELERATION_CLOSES,
  COVENANT_MAX_LEVERAGE,
  INSOLVENCY_GRACE_MONTHS,
  LEVERAGE_SPREAD_BANDS,
  OVERHEAD_PER_MONTH,
  PAYMENT_REMINDER_DAYS,
  PENALTY_STEP_UP_BPS,
} from './balance';
import { dateOf, isFirstOfMonth, MONTH_LENGTHS } from './calendar';
import {
  amortize,
  annualDebtService,
  closeDebtMonth,
  covenantMetrics,
  creditAvailable,
  estimateNextDebtService,
  formatMultiple,
  leverageSpreadBps,
  levelPayment,
  penaltyBps,
  quotePrepay,
  quoteTermLoan,
  reviewDebt,
  termCapacity,
  totalDebt,
} from './debt';
import type { DebtClose } from './debt';
import { closeMonth, estimateCashAtClose, formatMoney, postEntry } from './finance';
import { applyCommand, tick } from './game';
import { Rng } from './rng';
import { deserialize } from './save';
import { closedMonth, makeLoan, makeTradingState } from './testing/fixtures';
import type { Command, GameState, MonthlyReport, NoticeKind, TermLoan } from './types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apply(state: GameState, cmd: Command): void {
  expect(applyCommand(state, cmd), JSON.stringify(cmd)).toMatchObject({ ok: true });
}

function monthStartOf(day: number): number {
  return day - dateOf(day).day + 1;
}

/** The 1st of the month after `day`. */
function nextCloseDay(day: number): number {
  return monthStartOf(day) + (MONTH_LENGTHS[dateOf(day).month - 1] as number);
}

function lastNoticeId(state: GameState): number {
  return state.notices.at(-1)?.id ?? 0;
}

function noticesSince(state: GameState, afterId: number, kind?: NoticeKind) {
  return state.notices.filter((n) => n.id > afterId && (kind === undefined || n.kind === kind));
}

/**
 * The debt steps of the next month close and nothing else: closeDebtMonth,
 * then a closed month that billed `revenue` and spent `costs` appended, with
 * the whole trailing window rewritten to those figures (so the covenant review
 * tests exactly that cash flow), then reviewDebt.
 */
function closeBooks(state: GameState, revenue: number, costs = 0): { close: DebtClose; report: MonthlyReport } {
  state.day = nextCloseDay(state.day);
  const lastDay = state.day - 1;
  const close = closeDebtMonth(state, lastDay);
  const { year, month } = dateOf(lastDay);
  const report = closedMonth(year, month, revenue, costs);
  state.finance.reports.push(report);
  for (const r of state.finance.reports.slice(-ARR_TRAILING_MONTHS)) {
    r.totals = closedMonth(r.year, r.month, revenue, costs).totals;
    r.net = revenue - costs;
  }
  state.finance.monthToDate = [];
  reviewDebt(state, report, close);
  return { close, report };
}

/** Tick until a month closes; that close's report. */
function tickThroughClose(state: GameState): MonthlyReport {
  const count = state.finance.reports.length;
  for (let i = 0; i < 40 && !state.gameOver; i++) {
    tick(state);
    if (state.finance.reports.length > count) return state.finance.reports.at(-1)!;
  }
  throw new Error('no close within 40 days');
}

/** Monthly revenue that keeps a $500,000 loan well inside the covenants (no costs) ... */
const GOOD = 200_000;
/** ... and revenue that breaches them (leverage far over the limit). */
const BAD = 5_000;

interface LoanRun {
  /** What each regular close charged on the loan (interest + principal), in order; a missed close charged 0. */
  charges: number[];
  /** The loan's payment just before each regular close. */
  payments: number[];
  /** annualDebtService just before the close at which 12 payments were left. */
  serviceAt12: number | null;
  missedCloses: number;
}

/**
 * Take a $500,000 7-year loan on a well-capitalised trading state and close
 * months until it is repaid. `revenueAt(i)` is the revenue of regular close i
 * (0-based, after the stub close); `missAt` is a regular close whose cash is
 * set to 0 first (a missed payment).
 */
function runLoan(revenueAt: (i: number) => number, missAt = -1): LoanRun {
  const state = makeTradingState(GOOD, 0);
  state.finance.cash = 1e12;
  apply(state, { type: 'takeTermLoan', amount: 500_000, termYears: 7 });
  closeBooks(state, GOOD);
  const run: LoanRun = { charges: [], payments: [], serviceAt12: null, missedCloses: 0 };
  for (let i = 0; state.debt.loans.length > 0; i++) {
    if (i > 200) throw new Error('loan never repaid');
    const loan = state.debt.loans[0] as TermLoan;
    if (loan.monthsLeft === 12 && run.serviceAt12 === null) run.serviceAt12 = annualDebtService(state);
    run.payments.push(loan.payment);
    if (i === missAt) state.finance.cash = 0;
    const { close } = closeBooks(state, revenueAt(i));
    if (i === missAt) state.finance.cash = 1e12;
    if (close.missed) run.missedCloses++;
    run.charges.push(close.interestPaid + close.principalPaid);
  }
  return run;
}

function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

// ---------------------------------------------------------------------------
// #1: penalty months and missed payments must not hide a balloon payment
// ---------------------------------------------------------------------------

describe('#1 term loans stay level through penalty months and missed payments', () => {
  it('re-amortizes when the penalty starts and stops, so the last payment is no balloon', () => {
    // Breaches walk the stage up to frozen (3 closes) and hold it there as long
    // as a cure can still lift it before the bank calls the loans (round 4),
    // then compliant closes cure it back down; the loan then runs to the end.
    const bad = 3 + FROZEN_ACCELERATION_CLOSES - COVENANT_CURE_CLOSES - 1;
    const run = runLoan((i) => (i < bad ? BAD : GOOD));
    const last = run.charges.at(-1)!;
    const paymentBefore = run.payments.at(-1)!;
    expect(last).toBeLessThanOrEqual(paymentBefore);
    expect(last).toBeGreaterThan(paymentBefore * 0.9);
    expect(run.charges.length).toBe(84);
    // The payment rose while the penalty applied, and came back down after.
    expect(Math.max(...run.payments)).toBeGreaterThan(run.payments[0]!);
    // Coverage counts what the last year really charges.
    expect(run.serviceAt12).toBe(sum(run.charges.slice(-12)));
  });

  it('round 4: a freeze held too long gets the loan called, repaid in full within the closes the bank allows', () => {
    const run = runLoan((i) => (i < 36 ? BAD : GOOD));
    // Three breaches to frozen, FROZEN_ACCELERATION_CLOSES frozen closes to the call, then the closes it allows.
    expect(run.charges.length).toBeLessThanOrEqual(2 + FROZEN_ACCELERATION_CLOSES + ACCELERATION_CLOSES);
    expect(run.missedCloses).toBe(0);
    expect(Math.max(...run.charges)).toBeGreaterThan(run.payments[0]! * 10);
  });

  it('re-amortizes after a missed payment capitalizes its interest: the schedule slips a month, no lump at the end', () => {
    const run = runLoan(() => GOOD, 5);
    expect(run.missedCloses).toBe(1);
    expect(run.charges.length).toBe(84 + 1);
    const last = run.charges.at(-1)!;
    const paymentBefore = run.payments.at(-1)!;
    expect(last).toBeLessThanOrEqual(paymentBefore);
    expect(last).toBeGreaterThan(paymentBefore * 0.9);
    expect(run.serviceAt12).toBe(sum(run.charges.slice(-12)));
  });

  it('counts the real last payment in the annual debt service of a loan in its final year', () => {
    const always = runLoan(() => GOOD);
    expect(always.serviceAt12).toBe(sum(always.charges.slice(-12)));
    // A final year whose last payment carries more than the level payment counts it ...
    const state = makeTradingState(GOOD, 0);
    const ending = makeLoan({ monthsLeft: 5, balance: 7_000, principal: 60_000 });
    ending.payment = levelPayment(60_000, ending.rateBps, 60);
    state.debt.loans = [ending];
    const schedule = amortize(ending.balance, ending.rateBps, ending.monthsLeft, ending.payment);
    expect(annualDebtService(state)).toBe(sum(schedule.map((s) => s.interest + s.principal)));
    expect(annualDebtService(state)).toBeGreaterThan(ending.payment * 5);
    // ... and a balance that runs out before its months do charges only what is left.
    ending.balance = ending.payment + 1;
    const short = amortize(ending.balance, ending.rateBps, ending.monthsLeft, ending.payment).filter((s) => s.interest + s.principal > 0);
    expect(annualDebtService(state)).toBe(sum(short.map((s) => s.interest + s.principal)));
    expect(annualDebtService(state)).toBeLessThan(ending.payment * 3);
  });

  it('quotes a loan taken on the penalty rate with the payment that repays it at that rate', () => {
    const state = makeTradingState(GOOD, 0);
    state.debt.covenant.stage = 'penalty';
    const q = quoteTermLoan(state, 500_000, 7);
    expect(q.ok).toBe(true);
    expect(q.rate.effectiveRateBps).toBe(q.rate.rateBps + PENALTY_STEP_UP_BPS);
    expect(q.payment).toBe(levelPayment(500_000, q.rate.effectiveRateBps, 84));
    const final = amortize(500_000, q.rate.effectiveRateBps, 84, q.payment).at(-1)!;
    expect(q.lastPayment).toBe(final.interest + final.principal);
    expect(q.lastPayment).toBeLessThanOrEqual(q.payment);
    apply(state, { type: 'takeTermLoan', amount: 500_000, termYears: 7 });
    expect(state.debt.loans[0]!.payment).toBe(q.payment);
  });

  it('re-amortizes a prepayment made on the penalty rate at that rate', () => {
    const state = makeTradingState(GOOD, 0);
    state.finance.cash = 1e9;
    state.debt.loans = [makeLoan({ id: 1, originatedDay: 0 })];
    state.debt.nextLoanId = 2;
    state.debt.covenant.stage = 'frozen';
    const loan = state.debt.loans[0]!;
    const q = quotePrepay(state, 1, 10_000);
    expect(q.paymentAfter).toBe(levelPayment(loan.balance - 10_000, loan.rateBps + penaltyBps('frozen'), loan.monthsLeft));
  });
});

// ---------------------------------------------------------------------------
// #2 / #6 / #11: the payment reminder looks at the cash the close will have
// ---------------------------------------------------------------------------

describe('#2 #6 #11 the payment reminder projects cash at the close', () => {
  /** A $100,000 5-year loan past its stub close, ten days before the next close. */
  function tenDaysOut(stage: GameState['debt']['covenant']['stage']): GameState {
    const state = makeTradingState(20_000, 0);
    state.finance.cash = 200_000;
    apply(state, { type: 'takeTermLoan', amount: 100_000, termYears: 5 });
    tickThroughClose(state);
    state.debt.covenant.stage = stage;
    while (!isFirstOfMonth(state.day + 10)) tick(state);
    return state;
  }

  it('warns a borrower whose running costs will take the cash the payment needs (the finding: a silent default)', () => {
    const state = tenDaysOut('frozen');
    const due = estimateNextDebtService(state);
    expect(due).toBeGreaterThan(0);
    // More cash than the payment, less than the payment plus the month's overhead.
    state.finance.cash = due + 5_000;
    const mark = lastNoticeId(state);
    const report = tickThroughClose(state);
    const reminders = noticesSince(state, mark, 'paymentDue');
    expect(reminders).toHaveLength(1);
    expect(reminders[0]!.day).toBe(nextCloseDay(reminders[0]!.day) - PAYMENT_REMINDER_DAYS);
    expect(reminders[0]!.message).toContain(formatMoney(due));
    expect(reminders[0]!.message).toMatch(/default/);
    // The warning was right: the close could not pay.
    expect(report.debt?.missedPayment).toBe(true);
    expect(state.gameOver?.reason).toBe('default');
  });

  it('stays quiet when the month\'s billing will cover the payment, even with less cash than it today', () => {
    const state = tenDaysOut('compliant');
    const due = estimateNextDebtService(state);
    state.finance.cash = due - 1;
    // This month's billing so far: enough for the running costs and the payment.
    const dim = MONTH_LENGTHS[dateOf(state.day).month - 1] as number;
    state.sales.month.revenueDollarDays += (due + OVERHEAD_PER_MONTH + 2 * state.sales.marketingPerMonth) * dim;
    expect(estimateCashAtClose(state)).toBeGreaterThanOrEqual(due);
    const mark = lastNoticeId(state);
    const report = tickThroughClose(state);
    expect(noticesSince(state, mark, 'paymentDue')).toEqual([]);
    expect(report.debt?.missedPayment).toBe(false);
  });

  it('projects exactly the cash the close leaves before its debt step, on the month\'s last day', () => {
    const state = deserialize(readFileSync(new URL('./testing/v2-town.save.json', import.meta.url), 'utf8'));
    expect(totalDebt(state)).toBe(0);
    for (let month = 0; month < 4; month++) {
      while (!isFirstOfMonth(state.day + 1)) tick(state);
      const projected = estimateCashAtClose(state);
      const report = tickThroughClose(state);
      expect(report.cashEnd, `close ${month}`).toBe(projected);
    }
  });

  it('counts the installs still to come at the month\'s pace so far', () => {
    const state = makeTradingState(20_000, 0);
    state.day = monthStartOf(state.day) + 9; // the 10th
    const before = estimateCashAtClose(state);
    postEntry(state, 'install', -10_000, 'Installs');
    const left = nextCloseDay(state.day) - 1 - state.day;
    // Cash fell by the install; the days left are expected to spend at the same daily pace.
    expect(estimateCashAtClose(state)).toBe(before - 10_000 - Math.round((10_000 * left) / dateOf(state.day).day));
  });
});

// ---------------------------------------------------------------------------
// #3: a frozen borrower's next close in the red is a default, not a grace close
// ---------------------------------------------------------------------------

describe('#3 the insolvency warning after a missed payment', () => {
  it('says the next close in the red is a default instead of promising more closes', () => {
    const state = makeTradingState(20_000, 0);
    state.finance.cash = 100_000;
    apply(state, { type: 'takeTermLoan', amount: 100_000, termYears: 5 });
    state.day = nextCloseDay(state.day);
    closeMonth(state, 0, new Rng(1));
    expect(state.debt.covenant.stage).toBe('compliant');
    state.finance.cash = 0;
    postEntry(state, 'revenue', 20_000, 'Billing');
    postEntry(state, 'other', -20_000, 'Costs');
    const mark = lastNoticeId(state);
    state.day = nextCloseDay(state.day);
    closeMonth(state, 0, new Rng(1));
    const kinds = noticesSince(state, mark).map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(['paymentMissed', 'insolvencyWarning']));
    expect(state.debt.covenant.stage).toBe('frozen');
    const warning = noticesSince(state, mark, 'insolvencyWarning')[0]!;
    expect(warning.message).not.toMatch(new RegExp(`${INSOLVENCY_GRACE_MONTHS - 1} more close`));
    expect(warning.message).toMatch(/next close in the red is a default/);
    // And so it is.
    state.finance.cash = -10_000;
    state.day = nextCloseDay(state.day);
    closeMonth(state, 0, new Rng(1));
    expect(state.gameOver?.reason).toBe('default');
  });

  it('keeps the plain countdown for a company in the red with no debt', () => {
    const state = makeTradingState(20_000, 0);
    state.finance.cash = -1;
    state.day = nextCloseDay(state.day);
    closeMonth(state, 0, new Rng(1));
    const warning = state.notices.filter((n) => n.kind === 'insolvencyWarning').at(-1)!;
    expect(warning.message).toMatch(new RegExp(`${INSOLVENCY_GRACE_MONTHS - 1} more closes in the red`));
  });
});

// ---------------------------------------------------------------------------
// #4: covenant tests, quotes and notices use the figures the player sees
// ---------------------------------------------------------------------------

describe('#4 leverage and coverage are tested and priced to the hundredth, as shown', () => {
  it('passes leverage that reads 5.00×, and names a breach by a figure over the limit', () => {
    // No operating cash flow: the bank counts the recurring-revenue floor.
    const state = makeTradingState(100_000, 100_000);
    const uw = covenantMetrics(state).underwritingCashFlow;
    state.finance.cash = 1e9;
    state.debt.credit.balance = Math.round(uw * 5.003);
    expect(covenantMetrics(state)).toMatchObject({ leverage: COVENANT_MAX_LEVERAGE, leverageOk: true });
    const mark = lastNoticeId(state);
    const { report } = closeBooks(state, 100_000, 100_000);
    expect(noticesSince(state, mark, 'covenantWarning')).toEqual([]);
    expect(state.debt.covenant.stage).toBe('compliant');
    expect(report.debt?.leverageX100).toBe(COVENANT_MAX_LEVERAGE * 100);
    expect(state.debt.credit.rate.leverageBps).toBe(LEVERAGE_SPREAD_BANDS.find((b) => b.maxLeverage === COVENANT_MAX_LEVERAGE)!.spreadBps);

    state.debt.credit.balance = Math.round(uw * 5.007);
    const mark2 = lastNoticeId(state);
    closeBooks(state, 100_000, 100_000);
    const warning = noticesSince(state, mark2, 'covenantWarning')[0]!;
    expect(warning.message).toContain(`leverage ${formatMultiple(5.01)} is over the ${formatMultiple(COVENANT_MAX_LEVERAGE)} limit`);
  });

  it('prices a term loan on the pro forma leverage it shows', () => {
    const state = makeTradingState(100_000, 0);
    const uw = covenantMetrics(state).underwritingCashFlow;
    const amount = Math.round((uw * 2.0033) / 1_000) * 1_000;
    expect(amount).toBeLessThanOrEqual(termCapacity(state));
    const q = quoteTermLoan(state, amount, 5);
    expect(q.after.leverage).toBe(2);
    expect(q.rate.leverage).toBe(2);
    expect(q.rate.leverageBps).toBe(leverageSpreadBps(2));
  });
});

// ---------------------------------------------------------------------------
// #5: a frozen line with nothing owed
// ---------------------------------------------------------------------------

describe('#5 repaying everything while frozen', () => {
  it('says the freeze lifts at the next close, not after two compliant closes', () => {
    const state = makeTradingState(100_000, 0);
    state.finance.cash = 1_000_000;
    // The month bills like the trailing ones, so the smoothed lending ARR holds through the close.
    state.sales.month.revenueDollarDays = 100_000 * (MONTH_LENGTHS[dateOf(state.day).month - 1] as number);
    apply(state, { type: 'drawCredit', amount: 50_000 });
    state.debt.covenant.stage = 'frozen';
    apply(state, { type: 'repayCredit', amount: 50_000 });
    expect(totalDebt(state)).toBe(0);
    const result = applyCommand(state, { type: 'drawCredit', amount: 10_000 });
    expect(result.ok).toBe(false);
    const reason = result.ok ? '' : result.reason;
    expect(reason).toMatch(/frozen/);
    expect(reason).toMatch(/nothing/i);
    expect(reason).toMatch(/next month close/);
    expect(reason).not.toMatch(new RegExp(`${COVENANT_CURE_CLOSES} month closes in a row`));
    expect(quoteTermLoan(state, 50_000, 5).reasons[0]).toBe(reason);
    // And it does lift at the next close.
    tickThroughClose(state);
    expect(state.debt.covenant.stage).toBe('compliant');
    expect(creditAvailable(state)).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// #10: the breach notice gives the figures the Bank shows after re-pricing
// ---------------------------------------------------------------------------

describe('#10 breach notices and the re-priced debt service', () => {
  it('adds the debt service and coverage at the new rates when re-pricing changed them', () => {
    const state = makeTradingState(GOOD, 0);
    state.finance.cash = 1e12;
    apply(state, { type: 'takeTermLoan', amount: 500_000, termYears: 7 });
    apply(state, { type: 'drawCredit', amount: 100_000 });
    closeBooks(state, GOOD);
    state.debt.covenant.stage = 'warning';
    const mark = lastNoticeId(state);
    const { report } = closeBooks(state, BAD);
    expect(state.debt.covenant.stage).toBe('penalty');
    const notice = noticesSince(state, mark, 'covenantPenalty')[0]!;
    // The figures the review tested ...
    expect(notice.message).toContain(formatMoney(report.debt!.annualDebtService));
    // ... and what the Bank now shows: the penalty rate on every balance.
    const now = covenantMetrics(state);
    expect(now.annualDebtService).toBeGreaterThan(report.debt!.annualDebtService);
    expect(notice.message).toContain(formatMoney(now.annualDebtService));
    expect(notice.message).toContain(formatMultiple(now.coverage!));
  });
});
