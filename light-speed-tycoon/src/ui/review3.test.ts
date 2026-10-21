// Regressions from the round-3 review of the Bank, the HUD and the toasts:
// each test reproduces a confirmed finding (numbered as in the review) on
// real sim state or literal figures, and pins the fix. Money and limits come
// from balance.ts constants or the sim's own results.

import { describe, expect, it } from 'vitest';
import { ARR_TRAILING_MONTHS, COVENANT_MAX_LEVERAGE, INSOLVENCY_GRACE_MONTHS, PENALTY_STEP_UP_BPS } from '../sim/balance';
import { dateOf, dayOf, formatDate, formatMonth, MONTH_LENGTHS } from '../sim/calendar';
import {
  closeDebtMonth,
  covenantMetrics,
  creditOffer,
  estimateNextDebtService,
  finalPayment,
  levelPayment,
  quoteTermLoan,
  reviewDebt,
} from '../sim/debt';
import { closeMonth, estimateCashAtClose, postEntry } from '../sim/finance';
import { applyCommand } from '../sim/game';
import { Rng } from '../sim/rng';
import { closedMonth, makeLoan, makeTradingState } from '../sim/testing/fixtures';
import type { GameState, MonthlyReport, Notice, TermLoan } from '../sim/types';
import {
  AT_RISK_LABEL,
  BANK_NOTICES_SHOWN,
  bankNotices,
  cashAtCloseFigure,
  covenantView,
  creditView,
  isBankNotice,
  lastTestFigure,
  loanView,
  nextCloseDay,
  nextPaymentFigure,
  noticeHeadline,
  termView,
} from './bankPanel';
import { formatMoney, formatRatio, plural } from './format';
import { covenantStatus, overdraftStatus } from './hud';
import { TOAST_MAX_MS, TOAST_MS, WARN_TOAST_MS, toastDuration } from './overlays';
import { monthClosedTone } from './panel';

function apply(state: GameState, cmd: Parameters<typeof applyCommand>[1]): void {
  expect(applyCommand(state, cmd), JSON.stringify(cmd)).toMatchObject({ ok: true });
}

/** The 1st of the month after `day`. */
function closeAfter(day: number): number {
  return day - dateOf(day).day + 1 + (MONTH_LENGTHS[dateOf(day).month - 1] as number);
}

/**
 * Make the open month bill `revenue` at its close, as if every day had billed
 * revenue / days (so the smoothed lending ARR holds through a real close).
 */
function billMonth(state: GameState, revenue: number): void {
  state.sales.month.revenueDollarDays = revenue * (MONTH_LENGTHS[dateOf(state.day).month - 1] as number);
}

/** A real month close (closeMonth) on the 1st after state.day. */
function closeNext(state: GameState): MonthlyReport {
  state.day = closeAfter(state.day);
  return closeMonth(state, 0, new Rng(1));
}

// ---------------------------------------------------------------------------
// #1: the loan row and the quote show the payments as they will be charged
// ---------------------------------------------------------------------------

describe('#1 the loan row and the quote name the real last payment', () => {
  it('lists the last payment beside the level one when it differs, and the payment itself when it is the last', () => {
    const day = dayOf({ year: 2027, month: 6, day: 10 });
    const loan = makeLoan({ id: 2, originatedDay: 0, balance: 50_000, principal: 60_000, monthsLeft: 40 });
    loan.payment = levelPayment(60_000, loan.rateBps, 60);
    const state = makeTradingState(25_000, 0);
    state.debt.loans = [loan];
    const last = finalPayment(state, loan);
    expect(last).not.toBe(loan.payment);
    const view = loanView(loan, day, 0, last);
    expect(view.payment).toBe(`${formatMoney(loan.payment)}/mo`);
    expect(view.schedule).toBe(`${plural(40, 'payment')} left, the last ${formatMoney(last)}`);
    // One payment left: the row shows what it will charge.
    const ending: TermLoan = { ...loan, monthsLeft: 1, balance: 3_210 };
    expect(loanView(ending, day, 0, finalPayment(state, ending)).payment).toBe(`${formatMoney(finalPayment(state, ending))} (last)`);
    // The penalty is in the payment while it lasts.
    expect(loanView(loan, day, PENALTY_STEP_UP_BPS, last).penalty).toMatch(/included in the payment/);
  });

  it('quotes a loan on the penalty rate with the payment that repays it at that rate, and says so', () => {
    const state = makeTradingState(200_000, 0);
    state.debt.covenant.stage = 'penalty';
    const q = quoteTermLoan(state, 500_000, 7);
    const view = termView(q, 'penalty');
    const payment = view.figures.find((f) => f.label === 'Monthly payment')!;
    expect(payment.value).toBe(formatMoney(levelPayment(500_000, q.rate.effectiveRateBps, 84)));
    expect(payment.sub).toMatch(/^penalty included while it lasts/);
    expect(view.figures.find((f) => f.label === 'Total interest')!.sub).toMatch(/penalty lasted the whole term/);
  });
});

// ---------------------------------------------------------------------------
// #2 / #6: the Bank's next payment looks at the cash the close will have
// ---------------------------------------------------------------------------

describe('#2 #6 the Bank flags a payment the close will not have the cash for', () => {
  it('warns when the running costs will take the cash the payment needs (the finding: "covered" by today\'s cash)', () => {
    const state = makeTradingState(20_000, 0);
    state.finance.cash = 200_000;
    apply(state, { type: 'takeTermLoan', amount: 100_000, termYears: 5 });
    closeNext(state);
    state.day += 20;
    const estimate = estimateNextDebtService(state);
    expect(estimate).toBeGreaterThan(0);
    state.finance.cash = estimate + 5_000;
    const atClose = estimateCashAtClose(state);
    expect(atClose).toBeLessThan(estimate);
    const figure = nextPaymentFigure(estimate, atClose, state.day);
    expect(figure).toMatchObject({ tone: 'warn' });
    expect(figure.sub).toContain('more than the cash projected then');
    expect(cashAtCloseFigure(atClose, estimate)).toMatchObject({ label: 'Cash at the close', value: `≈ ${formatMoney(atClose)}` });
    expect(cashAtCloseFigure(atClose, estimate)!.tone).toMatch(/warn|danger/);
    // No payment due: no projection shown.
    expect(cashAtCloseFigure(atClose, 0)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// #3: frozen with debt, no grace closes are left
// ---------------------------------------------------------------------------

describe('#3 the HUD overdraft chip after a missed payment', () => {
  it('says no closes are left instead of the insolvency grace', () => {
    const state = makeTradingState(20_000, 0);
    state.finance.cash = 100_000;
    apply(state, { type: 'takeTermLoan', amount: 100_000, termYears: 5 });
    closeNext(state);
    state.finance.cash = 0;
    postEntry(state, 'revenue', 20_000, 'Billing');
    postEntry(state, 'other', -20_000, 'Costs');
    closeNext(state);
    expect(state.debt.covenant.stage).toBe('frozen');
    expect(state.finance.cash).toBeLessThan(0);
    const chip = overdraftStatus(state)!;
    expect(chip.text).toBe('Overdrawn: no closes left');
    expect(chip.text).not.toBe(`Overdrawn: ${plural(INSOLVENCY_GRACE_MONTHS - 1, 'close')} left`);
    expect(chip.tip).toMatch(/default/);
    // Back above $0 but still frozen with debt: the next close in the red still ends it.
    state.finance.cash = 10;
    expect(overdraftStatus(state)).toMatchObject({ text: 'Recovering: no closes left', tone: 'warn' });
    // With nothing owed the plain countdown applies.
    state.debt.loans = [];
    state.finance.cash = -1;
    expect(overdraftStatus(state)!.text).toBe(`Overdrawn: ${plural(INSOLVENCY_GRACE_MONTHS - 1, 'close')} left`);
  });
});

// ---------------------------------------------------------------------------
// #7: compliant, but today's figures break the covenants
// ---------------------------------------------------------------------------

describe('#7 a compliant stage with both covenant tests red', () => {
  function overLevered(): GameState {
    const state = makeTradingState(25_000, 0);
    const uw = covenantMetrics(state).underwritingCashFlow;
    state.debt.loans = [makeLoan({ balance: uw * (COVENANT_MAX_LEVERAGE * 2), principal: uw * (COVENANT_MAX_LEVERAGE * 2), monthsLeft: 24 })];
    return state;
  }

  it('does not call the loans in good standing above two red checks, and the HUD warns ahead of the close', () => {
    const state = overLevered();
    const metrics = covenantMetrics(state);
    expect(metrics).toMatchObject({ leverageOk: false, coverageOk: false });
    expect(state.debt.covenant.stage).toBe('compliant');
    const next = nextCloseDay(state.day);
    const view = covenantView('compliant', 0, metrics, next);
    expect(view.stage).toBe(AT_RISK_LABEL);
    expect(view.tone).toBe('warn');
    expect(view.meaning).not.toMatch(/good standing\.$/);
    expect(view.meaning).toContain('the leverage and coverage covenants');
    expect(view.meaning).toContain(`the ${formatDate(next)} close`);
    // Hedged: the close re-tests on that month's figures.
    expect(view.meaning).not.toMatch(/will breach/);
    expect(view.checks.every((c) => !c.ok)).toBe(true);

    const chip = covenantStatus(state)!;
    expect(chip).toMatchObject({ text: 'Covenant at risk', tone: 'warn' });
    expect(chip.tip).toContain('the leverage and coverage covenants');
    // Within the limits: no chip, and the plain compliant wording.
    state.debt.loans = [];
    expect(covenantStatus(state)).toBeNull();
    expect(covenantView('compliant', 0, covenantMetrics(state), next).stage).toBe('Compliant');
  });
});

// ---------------------------------------------------------------------------
// #8: the credit line's breakdown is the last close's figures, and says so
// ---------------------------------------------------------------------------

describe('#8 the credit-line breakdown is dated', () => {
  it('never says "no debt yet" with a loan outstanding, and names the close it was priced at', () => {
    const state = makeTradingState(25_000, 0);
    state.finance.cash = 1_000_000;
    billMonth(state, 25_000);
    const report = closeNext(state);
    apply(state, { type: 'takeTermLoan', amount: 45_000, termYears: 7 });
    const offer = creditOffer(state);
    // The line was priced at the close, before the loan.
    expect(offer.rate.leverage).toBe(0);
    const close = formatMonth(report.year, report.month);
    const next = formatDate(nextCloseDay(state.day));
    const view = creditView(offer, { close, next });
    const leverage = view.rateRows.find((r) => r.key === 'leverage')!;
    expect(leverage.note).not.toBe('no debt yet');
    expect(leverage.note).toBe(`no debt at the ${close} close`);
    expect(view.rateRows.find((r) => r.key === 'cpp')!.note).toContain(`at the ${close} close`);
    expect(view.rateRows.find((r) => r.key === 'product')!.note).toContain(`next on ${next}`);
  });
});

// ---------------------------------------------------------------------------
// #9: severe toasts are not the shortest-lived; a missed payment is not green
// ---------------------------------------------------------------------------

describe('#9 toast timing and tone', () => {
  it('keeps an error at least as long as a warning, and long messages long enough to read', () => {
    expect(toastDuration('Saved', 'ok')).toBe(TOAST_MS);
    expect(toastDuration('Nothing drawn', 'err')).toBe(WARN_TOAST_MS);
    expect(toastDuration('Nothing drawn', 'err')).toBeGreaterThanOrEqual(toastDuration('Nothing drawn', 'warn'));
    const frozen = Array.from({ length: 94 }, () => 'word').join(' ');
    expect(toastDuration(frozen, 'err')).toBeGreaterThan(WARN_TOAST_MS);
    expect(toastDuration(frozen, 'err')).toBeLessThanOrEqual(TOAST_MAX_MS);
    expect(toastDuration(Array.from({ length: 40 }, () => 'w').join(' '), 'warn')).toBeGreaterThan(WARN_TOAST_MS);
  });

  it('does not toast a close that missed its payment as good news', () => {
    const base: MonthlyReport = { year: 2027, month: 11, totals: {}, net: 0, cashEnd: 0, passings: 0 };
    expect(monthClosedTone(base)).toBe('ok');
    const debt = {
      creditBalance: 1,
      termBalance: 0,
      creditLimit: 0,
      arr: 0,
      annualOperatingCashFlow: 0,
      annualDebtService: 0,
      leverageX100: null,
      coverageX100: null,
      stage: 'frozen' as const,
      averageRateBps: null,
      missedPayment: true,
    };
    expect(monthClosedTone({ ...base, debt })).toBe('warn');
    expect(monthClosedTone({ ...base, debt: { ...debt, missedPayment: false } })).toBe('ok');
  });

  it('toasts only the headline of a long debt notice on a phone, pointing to the Bank for the rest', () => {
    const frozen =
      'Credit line frozen at the Mar 2027 close after another covenant breach: leverage cannot be measured: you owe $48,864 with no recurring revenue ' +
      'or operating cash flow to repay it and debt-service coverage 0.00× is under the 1.20× minimum ($0 a year of underwriting cash flow for ' +
      '$11,032 of payments due in the next 12 months). ' +
      'No draws or new term loans (repaying and prepaying still work), the 3.00% penalty rate stays. 2 compliant closes in a row lift the freeze.';
    expect(noticeHeadline(frozen)).toBe('Credit line frozen at the Mar 2027 close after another covenant breach. Full notice in the Bank.');
    const missed = 'Missed payment: the $1,888 of loan payments due at the May 2027 close could not be paid (cash -$1,000). The bank charged a $1,000 late fee.';
    expect(noticeHeadline(missed)).toBe('Missed payment: the $1,888 of loan payments due at the May 2027 close could not be paid (cash -$1,000). Full notice in the Bank.');
    const paid = 'Term loan #3 is paid off: its last payment was made at the May 2027 close.';
    expect(noticeHeadline(paid)).toBe(paid);
    // A sentence too long for its colon to help is cut at a word.
    const long = Array.from({ length: 60 }, (_, i) => `w${i}`).join(' ');
    expect(noticeHeadline(long).length).toBeLessThan(long.length);
    expect(noticeHeadline(long)).toMatch(/… Full notice in the Bank\.$/);
    expect(isBankNotice('creditFrozen')).toBe(true);
    expect(isBankNotice('cabinetFull')).toBe(false);
  });

  it('keeps the latest debt notices in the Bank to reread, newest first', () => {
    const notice = (id: number, kind: Notice['kind']): Notice => ({ id, day: id, kind, message: `n${id}`, cabinet: null, milestone: null });
    const log = [
      notice(1, 'covenantWarning'),
      notice(2, 'cabinetFull'),
      notice(3, 'covenantPenalty'),
      notice(4, 'milestone'),
      notice(5, 'creditFrozen'),
      notice(6, 'paymentDue'),
      notice(7, 'paymentMissed'),
      notice(8, 'loanPaidOff'),
      notice(9, 'covenantCured'),
    ];
    const listed = bankNotices(log);
    expect(listed).toHaveLength(BANK_NOTICES_SHOWN);
    expect(listed.map((n) => n.id)).toEqual([9, 8, 7, 6, 5]);
    expect(listed[2]).toMatchObject({ text: 'n7', tone: 'err', date: formatDate(7) });
    expect(bankNotices(log, 10).map((n) => n.id)).toEqual([9, 8, 7, 6, 5, 3, 1]);
  });
});

// ---------------------------------------------------------------------------
// #10: the Bank shows what the close tested beside today's figures
// ---------------------------------------------------------------------------

describe('#10 the figures the close tested, beside the re-priced ones', () => {
  it('shows the tested leverage, coverage and debt service of the last close in the covenant section', () => {
    const state = makeTradingState(200_000, 0);
    state.finance.cash = 1e12;
    apply(state, { type: 'takeTermLoan', amount: 500_000, termYears: 7 });
    apply(state, { type: 'drawCredit', amount: 100_000 });
    // A breach while on warning: the penalty re-prices every balance after the test.
    state.debt.covenant.stage = 'warning';
    state.day = closeAfter(state.day);
    const close = closeDebtMonth(state, state.day - 1);
    const { year, month } = dateOf(state.day - 1);
    const report = closedMonth(year, month, 5_000);
    state.finance.reports.push(report);
    for (const r of state.finance.reports.slice(-ARR_TRAILING_MONTHS)) {
      r.totals = { revenue: 5_000 };
      r.net = 5_000;
    }
    reviewDebt(state, report, close);
    expect(state.debt.covenant.stage).toBe('penalty');
    const now = covenantMetrics(state);
    expect(now.annualDebtService).not.toBe(report.debt!.annualDebtService);
    const label = formatMonth(report.year, report.month);
    const view = covenantView(state.debt.covenant.stage, 0, now, nextCloseDay(state.day), { close: label, debt: report.debt! });
    const tested = view.figures.find((f) => f.label === `Tested at the ${label} close`)!;
    expect(tested.value).toBe(`${formatRatio(report.debt!.leverageX100! / 100)} · ${formatRatio(report.debt!.coverageX100! / 100)}`);
    expect(tested.sub).toContain(formatMoney(report.debt!.annualDebtService));
    expect(view.figures.find((f) => f.label === 'Debt service, next 12 months')!.value).toBe(`${formatMoney(now.annualDebtService)}/yr`);
    // The notice gives both, so the toast and the Bank agree.
    const notice = state.notices.filter((n) => n.kind === 'covenantPenalty').at(-1)!;
    expect(notice.message).toContain(formatMoney(report.debt!.annualDebtService));
    expect(notice.message).toContain(formatMoney(now.annualDebtService));
    // A close with no debt has nothing to show.
    expect(lastTestFigure({ close: label, debt: { ...report.debt!, creditBalance: 0, termBalance: 0 } })).toBeNull();
  });
});
