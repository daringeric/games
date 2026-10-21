// The Bank panel's pure view models, fed literal offers, quotes and covenant
// figures (never the sim's quote functions), so the wording and the
// arithmetic of the panel are pinned down on their own. Money and limits come
// from balance.ts constants, never literal tuning values. Round 4: the
// covenant remedy, the frozen line's sweep and countdown, the called loans,
// the draw preview, the safe builder default and same-month re-pricing.

import { describe, expect, it } from 'vitest';
import {
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  BASE_RATE_BPS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  CREDIT_LINE_EXTRA_BPS,
  DRAW_PRESETS,
  FROZEN_ACCELERATION_CLOSES,
  FROZEN_SWEEP_RESERVE,
  FROZEN_SWEEP_SHARE,
  LOAN_ROUNDING,
  PENALTY_STEP_UP_BPS,
  TERM_EXTRA_BPS,
  TERM_LOAN_MIN,
  UNDERWRITING_MIN_MARGIN,
} from '../sim/balance';
import { dayOf, formatDate } from '../sim/calendar';
import type { CovenantMetrics, CreditOffer, CureOption, DrawQuote, PrepayQuote, RateBreakdown, TermLoan, TermLoanQuote } from '../sim/types';
import {
  STAGE_LABEL,
  STAGE_TONE,
  closeDayAfter,
  covenantView,
  remedyLine,
  cppLine,
  creditView,
  cureAdvice,
  cureText,
  defaultTermAmount,
  drawPresets,
  drawPreview,
  frozenView,
  isBankNotice,
  repricedLines,
  safeAmountLine,
  inFirstMonth,
  loanView,
  nextCloseDay,
  nextPaymentFigure,
  parseAmount,
  prepayView,
  rateRows,
  repayPresets,
  stageNext,
  termPresets,
  termView,
} from './bankPanel';
import { formatBpsDelta, formatMoney, formatPercent, formatRate, formatRatio, plural } from './format';

// ---------------------------------------------------------------------------
// Literal factories
// ---------------------------------------------------------------------------

function rate(over: Partial<RateBreakdown> = {}): RateBreakdown {
  const parts = { baseBps: BASE_RATE_BPS, leverageBps: 0, cppBps: 0, productBps: CREDIT_LINE_EXTRA_BPS, penaltyBps: 0, ...over };
  const rateBps = parts.baseBps + parts.leverageBps + parts.cppBps + parts.productBps;
  return { leverage: 0, cpp: null, cppBand: null, rateBps, effectiveRateBps: rateBps + parts.penaltyBps, ...parts, ...over };
}

function metrics(over: Partial<CovenantMetrics> = {}): CovenantMetrics {
  return {
    totalDebt: 0,
    arr: 120_000,
    annualOperatingCashFlow: 30_000,
    underwritingCashFlow: 42_000,
    annualDebtService: 0,
    leverage: 0,
    coverage: null,
    leverageOk: true,
    coverageOk: true,
    compliant: true,
    ...over,
  };
}

function offer(over: Partial<CreditOffer> = {}): CreditOffer {
  return {
    limit: 60_000,
    balance: 0,
    available: 60_000,
    maxRepay: 0,
    frozen: false,
    rate: rate(),
    accruedInterest: 0,
    arr: 120_000,
    reasons: [],
    ...over,
  };
}

function termQuote(over: Partial<TermLoanQuote> = {}): TermLoanQuote {
  return {
    ok: true,
    reasons: [],
    amount: 100_000,
    termYears: 7,
    termMonths: 84,
    maxAmount: 360_000,
    rate: rate({ productBps: TERM_EXTRA_BPS[7] }),
    payment: 1_530,
    lastPayment: 1_530,
    stubInterest: 210,
    totalInterest: 28_600,
    before: metrics(),
    after: metrics({ totalDebt: 100_000, annualDebtService: 18_360, leverage: 100_000 / 42_000, coverage: 42_000 / 18_360 }),
    breachesCovenant: false,
    cashAfter: 150_000,
    repriced: [],
    safeMaxAmount: 0,
    ...over,
  };
}

function prepay(over: Partial<PrepayQuote> = {}): PrepayQuote {
  return { ok: true, reasons: [], loan: 2, amount: 10_000, accruedInterest: 40, total: 10_040, paysOff: false, paymentAfter: 1_320, ...over };
}

function loan(over: Partial<TermLoan> = {}): TermLoan {
  return { id: 2, principal: 100_000, balance: 92_000, rateBps: 725, termMonths: 84, payment: 1_530, monthsLeft: 80, originatedDay: 0, ...over };
}

// ---------------------------------------------------------------------------

describe('rate breakdown', () => {
  it('words the cost-per-passing spread by band', () => {
    expect(cppLine(rate())).toBe('Nothing passed yet: no CPP spread');
    expect(cppLine(rate({ cpp: CPP_TARGET - 258, cppBand: 'green' }))).toBe(`Cost per passing ${formatMoney(CPP_TARGET - 258)} is under target: no CPP spread`);
    expect(cppLine(rate({ cpp: CPP_TARGET, cppBand: 'green' }))).toBe(`Cost per passing ${formatMoney(CPP_TARGET)} is on target: no CPP spread`);
    const amber = CPP_TARGET * (1 + CPP_AMBER_MULTIPLIER) / 2;
    expect(cppLine(rate({ cpp: amber, cppBand: 'amber', cppBps: CPP_SPREAD_BPS.amber }))).toBe(
      `Cost per passing ${formatMoney(amber)} is over target (amber): ${formatBpsDelta(CPP_SPREAD_BPS.amber)}`,
    );
    const red = CPP_TARGET * CPP_AMBER_MULTIPLIER * 2;
    expect(cppLine(rate({ cpp: red, cppBand: 'red', cppBps: CPP_SPREAD_BPS.red }))).toBe(
      `Cost per passing ${formatMoney(red)} is far over target (red): ${formatBpsDelta(CPP_SPREAD_BPS.red)}`,
    );
  });

  it('lists base, leverage, CPP and product, and the penalty only while it applies', () => {
    const line = rateRows(rate({ leverageBps: 75, leverage: 2.5 }), { kind: 'line' });
    expect(line.map((r) => r.key)).toEqual(['base', 'leverage', 'cpp', 'product']);
    expect(line.map((r) => r.value)).toEqual([formatRate(BASE_RATE_BPS), formatBpsDelta(75), formatBpsDelta(0), formatBpsDelta(CREDIT_LINE_EXTRA_BPS)]);
    expect(line[1]!.note).toBe(`at ${formatRatio(2.5)} leverage`);
    expect(line[3]!.label).toBe('Line premium');

    const term = rateRows(rate({ productBps: TERM_EXTRA_BPS[5], penaltyBps: PENALTY_STEP_UP_BPS, leverage: null }), { kind: 'term', years: 5 });
    expect(term.map((r) => r.key)).toEqual(['base', 'leverage', 'cpp', 'product', 'penalty']);
    expect(term[1]!.note).toMatch(/not measurable/);
    expect(term[3]).toMatchObject({ label: 'Term premium', value: formatBpsDelta(TERM_EXTRA_BPS[5]) });
    expect(term[4]!.value).toBe(formatBpsDelta(PENALTY_STEP_UP_BPS));
  });
});

describe('credit line', () => {
  it('gives the sim’s reason there is no credit yet in a town without recurring revenue', () => {
    const view = creditView(offer({ limit: 0, available: 0, arr: 0, reasons: ['The bank lends against recurring revenue'] }));
    expect(view.note).toBe('');
    expect(view.canDraw).toBe(false);
    expect(view.reasons).toEqual(['The bank lends against recurring revenue']);
    expect(view.drawPresets.every((p) => p.disabled)).toBe(true);
    expect(view.canRepay).toBe(false);
  });

  it('shows limit, drawn, available and this month’s interest, and the effective rate', () => {
    const view = creditView(offer({ balance: 20_000, available: 40_000, maxRepay: 20_000, accruedInterest: 55, rate: rate({ penaltyBps: PENALTY_STEP_UP_BPS }) }));
    expect(view.figures.map((f) => [f.label, f.value])).toEqual([
      ['Limit', formatMoney(60_000)],
      ['Drawn', formatMoney(20_000)],
      ['Available', formatMoney(40_000)],
      ['Interest so far this month', formatMoney(55)],
    ]);
    expect(view.rate).toBe(formatRate(BASE_RATE_BPS + CREDIT_LINE_EXTRA_BPS + PENALTY_STEP_UP_BPS));
    expect(view.note).toContain(formatMoney(120_000));
    expect(view.canDraw).toBe(true);
    expect(view.reasons).toEqual([]);
    expect(view.canRepay).toBe(true);
    expect(view.repayReason).toBe('');
  });

  it('cannot repay without cash, and says so', () => {
    const view = creditView(offer({ balance: 20_000, available: 40_000, maxRepay: 0 }));
    expect(view.canRepay).toBe(false);
    expect(view.repayReason).toMatch(/cash/);
  });

  it('offers draw presets up to what is available, and repay presets capped at cash', () => {
    const available = DRAW_PRESETS[1]! + 1;
    const draws = drawPresets(available);
    expect(draws.map((p) => p.amount)).toEqual([...DRAW_PRESETS, Math.floor(available / 2), available]);
    expect(draws.map((p) => p.disabled)).toEqual([false, false, false, false]);
    expect(drawPresets(DRAW_PRESETS[0]! - 1).map((p) => p.disabled)).toEqual([true, true, false, false]);
    expect(drawPresets(0).every((p) => p.disabled)).toBe(true);

    expect(repayPresets({ balance: 30_001, maxRepay: 50_000 }).map((p) => p.amount)).toEqual([15_001, 50_000]);
    expect(repayPresets({ balance: 30_000, maxRepay: 30_000 }).map((p) => p.amount)).toEqual([15_000, 30_000]);
    // Short of cash: both presets stop at what cash allows.
    expect(repayPresets({ balance: 30_000, maxRepay: 9_000 }).map((p) => p.amount)).toEqual([9_000, 9_000]);
  });
});

describe('term loan builder', () => {
  it('starts at the largest covenant-safe amount, and at the smallest loan when none is safe', () => {
    expect(defaultTermAmount(0)).toBe(TERM_LOAN_MIN);
    expect(defaultTermAmount(37 * LOAN_ROUNDING)).toBe(Math.max(TERM_LOAN_MIN, 37 * LOAN_ROUNDING));
    expect(defaultTermAmount(400 * LOAN_ROUNDING)).toBe(400 * LOAN_ROUNDING);
  });

  it('says what the largest covenant-safe amount is, or that none is', () => {
    const safe = 120 * LOAN_ROUNDING;
    expect(safeAmountLine(safe, 360 * LOAN_ROUNDING, 7)).toBe(`Largest covenant-safe amount: ${formatMoney(safe)} over 7 years.`);
    expect(safeAmountLine(safe, safe, 5)).toBe(`Largest covenant-safe amount: ${formatMoney(safe)} over 5 years, all the bank will lend.`);
    expect(safeAmountLine(0, 360 * LOAN_ROUNDING, 7)).toBe(
      `No 7-year loan keeps the covenants at today's figures: even the smallest, ${formatMoney(TERM_LOAN_MIN)}, would breach one at the next month close.`,
    );
    // Nothing to borrow: the reasons say why.
    expect(safeAmountLine(0, 0, 7)).toBe('');
    // In the builder's view, from the quote.
    const view = termView(termQuote({ safeMaxAmount: safe }), 'compliant');
    expect(view.safe).toBe(safeAmountLine(safe, 360_000, 7));
  });

  it('shows the same-month loans a new loan re-prices', () => {
    const repriced = [{ loan: 1, rateBps: 650, rateBpsAfter: 725, payment: 1_200, paymentAfter: 1_265 }];
    expect(repricedLines(repriced)).toEqual([
      `Loan #1 (taken this month) re-prices from ${formatRate(650)} to ${formatRate(725)}: ${formatMoney(1_200)} → ${formatMoney(1_265)}/mo. Loans taken in the same month are priced together.`,
    ]);
    expect(termView(termQuote({ repriced }), 'compliant').repriced).toEqual(repricedLines(repriced));
    expect(termView(termQuote(), 'compliant').repriced).toEqual([]);
    // A loan that can't be quoted re-prices nothing.
    expect(termView(termQuote({ repriced, payment: 0, maxAmount: 0 }), 'compliant').repriced).toEqual([]);
  });

  it('calls the capacity a multiple of lending ARR, never annual recurring revenue', () => {
    const view = termView(termQuote(), 'compliant');
    expect(view.capacity).toContain('lending ARR');
    expect(view.capacity).not.toMatch(/annual recurring revenue/i);
    expect(creditView(offer()).note).toContain('lending ARR');
    expect(creditView(offer()).note).not.toMatch(/annual recurring revenue/i);
  });

  it('offers 25 / 50 / 75 / 100% of capacity, rounded down, disabled below the smallest loan', () => {
    const max = 40 * TERM_LOAN_MIN + 1;
    const presets = termPresets(max);
    expect(presets.map((p) => p.label)).toEqual([formatPercent(0.25), formatPercent(0.5), formatPercent(0.75), formatPercent(1)]);
    expect(presets.map((p) => p.amount)).toEqual([
      Math.floor((max * 0.25) / LOAN_ROUNDING) * LOAN_ROUNDING,
      Math.floor((max * 0.5) / LOAN_ROUNDING) * LOAN_ROUNDING,
      Math.floor((max * 0.75) / LOAN_ROUNDING) * LOAN_ROUNDING,
      max,
    ]);
    expect(presets.every((p) => !p.disabled)).toBe(true);
    expect(termPresets(0).every((p) => p.disabled)).toBe(true);
  });

  it('quotes the payment, interest, cash after and the covenants before and after', () => {
    const view = termView(termQuote({ lastPayment: 1_498 }), 'compliant');
    expect(view.ok).toBe(true);
    expect(view.confirmLabel).toBe(`Borrow ${formatMoney(100_000)} over 7 years`);
    expect(view.rate).toBe(`${formatRate(BASE_RATE_BPS + TERM_EXTRA_BPS[7])} fixed`);
    expect(view.capacity).toContain(formatMoney(360_000));
    const figure = (label: string) => view.figures.find((f) => f.label === label)!;
    expect(figure('Monthly payment')).toMatchObject({ value: formatMoney(1_530), sub: `last one ${formatMoney(1_498)}` });
    expect(figure('Interest at this month’s close').value).toBe(formatMoney(210));
    expect(figure('Total interest').value).toBe(formatMoney(28_600));
    expect(figure('Cash after')).toMatchObject({ value: formatMoney(150_000), tone: undefined });
    const [leverage, coverage] = view.checks;
    expect(leverage).toMatchObject({ value: `${formatRatio(0)} → ${formatRatio(100_000 / 42_000)}`, limit: `max ${formatRatio(COVENANT_MAX_LEVERAGE)}`, ok: true });
    expect(coverage).toMatchObject({ value: `– → ${formatRatio(42_000 / 18_360)}`, limit: `min ${formatRatio(COVENANT_MIN_COVERAGE)}`, ok: true });
    expect(view.warning).toBeNull();
    // A level schedule: no separate last payment.
    expect(termView(termQuote(), 'compliant').figures[0]!.sub).toBeUndefined();
  });

  it('warns about a loan that would break a covenant, by stage', () => {
    const breach = termQuote({
      breachesCovenant: true,
      after: metrics({ totalDebt: 300_000, leverage: 300_000 / 42_000, leverageOk: false, coverage: 2, compliant: false }),
    });
    const view = termView(breach, 'compliant');
    expect(view.warning).toBe(
      "At today's cash flow this loan breaks the leverage covenant at the next month close: a warning first, then a penalty rate, then a frozen credit line.",
    );
    expect(view.checks[0]).toMatchObject({ ok: false, mark: 'over the limit' });
    expect(view.ok).toBe(true);
    expect(termView(breach, 'warning').warning).toContain('a penalty rate next, then a frozen credit line');
    const both = termQuote({
      breachesCovenant: true,
      after: metrics({ leverage: null, leverageOk: false, coverage: 0.5, coverageOk: false, compliant: false }),
    });
    const bothView = termView(both, 'penalty');
    expect(bothView.warning).toContain('the leverage and coverage covenants');
    expect(bothView.warning).toContain('a frozen credit line next');
    expect(bothView.checks[0]!.value).toBe(`${formatRatio(0)} → not measurable`);
    expect(bothView.checks[1]).toMatchObject({ ok: false, mark: 'under the minimum' });
  });

  it('is disabled with the sim’s reasons when nothing can be borrowed', () => {
    const none = termView(termQuote({ ok: false, reasons: ['No recurring revenue yet'], maxAmount: 0, payment: 0, lastPayment: 0 }), 'compliant');
    expect(none.ok).toBe(false);
    expect(none.reasons).toEqual(['No recurring revenue yet']);
    expect(none.confirmLabel).toBe('Borrow');
    expect(none.capacity).toBe('');
    expect(none.figures[0]).toMatchObject({ value: '–', tone: 'muted' });
    // A payment quoted for a loan that can't be taken shows no figures either.
    expect(termView(termQuote({ ok: false, maxAmount: 0 }), 'frozen').figures[0]).toMatchObject({ value: '–', tone: 'muted' });
    // Cash after below zero is red.
    expect(termView(termQuote({ cashAfter: -5 }), 'compliant').figures.find((f) => f.label === 'Cash after')!.tone).toBe('danger');
  });

  it('shows the penalty on top of the fixed rate while it lasts', () => {
    const view = termView(termQuote({ rate: rate({ productBps: TERM_EXTRA_BPS[7], penaltyBps: PENALTY_STEP_UP_BPS }) }), 'penalty');
    const fixed = BASE_RATE_BPS + TERM_EXTRA_BPS[7];
    expect(view.rate).toBe(`${formatRate(fixed)} fixed (${formatRate(fixed + PENALTY_STEP_UP_BPS)} while the penalty lasts)`);
    expect(view.rateRows.at(-1)!.key).toBe('penalty');
  });
});

describe('loans and prepayments', () => {
  it('lists each loan with its term, rate, balance, payment and payments left', () => {
    const day = dayOf({ year: 2027, month: 6, day: 10 });
    const view = loanView(loan({ originatedDay: dayOf({ year: 2027, month: 2, day: 3 }) }), day, 0);
    expect(view).toEqual({
      id: 2,
      title: `#2 · 7 years at ${formatRate(725)}`,
      balance: formatMoney(92_000),
      payment: `${formatMoney(1_530)}/mo`,
      schedule: `${plural(80, 'payment')} left`,
      penalty: '',
    });
    expect(loanView(loan(), day, PENALTY_STEP_UP_BPS).penalty).toContain(formatBpsDelta(PENALTY_STEP_UP_BPS));
  });

  it('says a loan taken this month pays only interest at its first close', () => {
    const taken = dayOf({ year: 2027, month: 6, day: 10 });
    const fresh = loan({ originatedDay: taken, monthsLeft: 84 });
    expect(inFirstMonth(fresh, taken)).toBe(true);
    expect(inFirstMonth(fresh, dayOf({ year: 2027, month: 6, day: 30 }))).toBe(true);
    expect(inFirstMonth(fresh, dayOf({ year: 2027, month: 7, day: 1 }))).toBe(false);
    expect(inFirstMonth(fresh, dayOf({ year: 2028, month: 6, day: 10 }))).toBe(false);
    expect(loanView(fresh, taken, 0).schedule).toBe(`first payment: interest only, then ${plural(84, 'payment')}`);
  });

  it('quotes a prepayment: accrued interest, cash needed and the new payment', () => {
    expect(prepayView(prepay())).toEqual({
      ok: true,
      reasons: [],
      summary: `Accrued interest ${formatMoney(40)} · cash needed ${formatMoney(10_040)} · new payment ${formatMoney(1_320)}/mo`,
      label: `Prepay ${formatMoney(10_040)}`,
    });
    const off = prepayView(prepay({ amount: 92_000, accruedInterest: 300, total: 92_300, paysOff: true, paymentAfter: 0 }));
    expect(off.summary).toContain('pays the loan off');
    expect(off.label).toBe(`Pay off for ${formatMoney(92_300)}`);
    const bad = prepayView(prepay({ ok: false, reasons: ['Not enough cash'] }));
    expect(bad).toMatchObject({ ok: false, reasons: ['Not enough cash'], summary: '', label: 'Prepay' });
  });
});

describe('covenant status', () => {
  it('names each stage with its tone', () => {
    expect(STAGE_LABEL).toEqual({ compliant: 'Compliant', warning: 'Warning', penalty: 'Penalty rate', frozen: 'Frozen' });
    expect(STAGE_TONE).toEqual({ compliant: 'ok', warning: 'warn', penalty: 'warn', frozen: 'danger' });
  });

  it('tests leverage and coverage against the limits and shows the cash flow the bank counts', () => {
    const m = metrics({ totalDebt: 300_000, annualDebtService: 40_000, leverage: 300_000 / 42_000, coverage: 42_000 / 40_000, leverageOk: false, coverageOk: false, compliant: false });
    const view = covenantView('warning', 1, m);
    expect(view).toMatchObject({ stage: 'Warning', tone: 'warn', cureLabel: 'How to cure' });
    expect(view.checks[0]).toMatchObject({ label: 'Leverage', value: formatRatio(300_000 / 42_000), ok: false });
    expect(view.checks[1]).toMatchObject({ label: 'Coverage', value: formatRatio(42_000 / 40_000), ok: false, mark: 'under the minimum' });
    const counted = view.figures.find((f) => f.label === 'Cash flow the bank counts')!;
    expect(counted.value).toBe(`${formatMoney(42_000)}/yr`);
    expect(counted.sub).toBe(`your yearly operating cash flow (${formatMoney(30_000)}), or ${formatPercent(UNDERWRITING_MIN_MARGIN)} of lending ARR if that is more`);
    expect(view.figures.find((f) => f.label === 'Lending ARR')).toMatchObject({ value: `${formatMoney(120_000)}/yr` });
    expect(view.figures.some((f) => /annual recurring revenue/i.test(f.label))).toBe(false);
    expect(view.next).toContain(formatBpsDelta(PENALTY_STEP_UP_BPS));
    expect(view.cure).toContain(`1 of ${COVENANT_CURE_CLOSES} so far`);

    const fine = covenantView('compliant', 0, metrics());
    expect(fine).toMatchObject({ stage: 'Compliant', tone: 'ok', cureLabel: 'The tests' });
    expect(fine.checks[1]).toMatchObject({ value: '–', mark: 'nothing scheduled', ok: true });
    expect(fine.cure).toContain(formatRatio(COVENANT_MAX_LEVERAGE));
  });

  it('says what the next breach does and how to cure, at every stage', () => {
    expect(stageNext('compliant')).toMatch(/warning first/);
    expect(stageNext('warning')).toContain(formatBpsDelta(PENALTY_STEP_UP_BPS));
    expect(stageNext('penalty')).toMatch(/freezes the credit line/);
    expect(stageNext('frozen')).toMatch(/default.*ends the game/);
    expect(cureText('compliant', 0)).toBe('');
    expect(cureText('frozen', 0)).toContain(plural(COVENANT_CURE_CLOSES, 'compliant month close'));
    expect(cureText('frozen', 0)).toMatch(/no debt at all/i);
    // The rule never advises a repayment on its own (that could leave too little cash): the verified cure does.
    expect(cureText('frozen', 0)).not.toMatch(/repay/i);
  });

  it('leads with the verified cure: a repayment, or the operating cash flow that would cure it', () => {
    const breached = metrics({ totalDebt: 300_000, annualDebtService: 40_000, leverage: 300_000 / 42_000, coverage: 42_000 / 40_000, leverageOk: false, coverageOk: false, compliant: false });
    const repay: CureOption = {
      kind: 'repayCredit',
      loan: null,
      amount: 42_000,
      after: metrics({ totalDebt: 258_000, compliant: true }),
      cashAfter: 88_000,
      text: "Repay $42,000 of the credit line: at today's figures that brings leverage to 4.60× and coverage to 1.31×, leaving $88,000 in cash.",
    };
    expect(cureAdvice(repay)).toBe(repay.text);
    expect(covenantView('warning', 0, breached, null, null, repay).remedy).toBe(repay.text);
    const grow: CureOption = { kind: 'grow', loan: null, amount: 37_000, after: metrics(), cashAfter: 0, text: 'sim text' };
    expect(cureAdvice(grow)).toBe(`No repayment cures it: about ${formatMoney(37_000)} a year more operating cash flow would, at today's figures.`);
    expect(cureAdvice(null)).toBe('');
    // Nothing to cure when today's figures pass, whatever was passed in.
    expect(covenantView('penalty', 1, metrics(), null, null, repay).remedy).toBe('');
    expect(covenantView('warning', 0, breached).remedy).toBe('');
    // The line the Bank shows: once the loans are called, a cure does not undo the call.
    expect(remedyLine(repay.text, false)).toBe(`To cure it now: ${repay.text}`);
    expect(remedyLine(repay.text, true)).toBe(`To cure it now: ${repay.text} The call stands either way: everything you owe still falls due on schedule.`);
    expect(remedyLine('', true)).toBe('');
  });

  it('dates the next payment at the next close and warns when cash is short of it', () => {
    const day = dayOf({ year: 2027, month: 12, day: 20 });
    expect(nextCloseDay(day)).toBe(dayOf({ year: 2028, month: 1, day: 1 }));
    expect(nextCloseDay(dayOf({ year: 2027, month: 3, day: 1 }))).toBe(dayOf({ year: 2027, month: 4, day: 1 }));
    expect(nextPaymentFigure(0, 100, day)).toMatchObject({ value: 'None due', tone: 'muted' });
    expect(nextPaymentFigure(3_120, 10_000, day)).toEqual({ label: 'Next payment', value: `≈ ${formatMoney(3_120)}`, sub: 'at the Jan 1, 2028 close', tone: undefined });
    // The second figure is the cash projected at the close (after the month's billing and running costs).
    expect(nextPaymentFigure(3_120, 3_000, day)).toMatchObject({ tone: 'warn', sub: 'at the Jan 1, 2028 close: more than the cash projected then' });
  });
});

describe('amount fields', () => {
  it('takes whole dollars only', () => {
    expect(parseAmount('12000')).toBe(12_000);
    expect(parseAmount(' $12,000 ')).toBe(12_000);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
    expect(parseAmount('12.5')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });
});

describe('the frozen line', () => {
  const day = dayOf({ year: 2028, month: 3, day: 12 });

  it('shows the last sweep, the next one and the countdown to the call', () => {
    const view = frozenView({
      lastSweep: { amount: 6_500, close: 'Feb 2028' },
      nextSweep: 7_100,
      closesUntilCall: ACCELERATION_WARNING_CLOSES + 1,
      called: null,
      day,
      owed: 90_000,
      frozen: true,
    })!;
    expect(view.title).toMatch(/sweep and the countdown/);
    expect(view.tone).toBe('warn');
    expect(view.text).toContain(formatPercent(FROZEN_SWEEP_SHARE));
    expect(view.text).toContain(formatMoney(FROZEN_SWEEP_RESERVE));
    expect(view.text).toContain(`after ${FROZEN_ACCELERATION_CLOSES} frozen closes in a row it calls the loans`);
    expect(view.text).toContain(plural(ACCELERATION_CLOSES, 'close'));
    const figure = (label: string) => view.figures.find((f) => f.label === label)!;
    expect(figure('Last sweep')).toMatchObject({ value: formatMoney(6_500), sub: 'at the Feb 2028 close' });
    expect(figure('Next sweep')).toMatchObject({ value: `≈ ${formatMoney(7_100)}`, sub: 'at the Apr 1, 2028 close, at this month\'s pace' });
    expect(figure('Before the bank calls the loans')).toMatchObject({ value: plural(ACCELERATION_WARNING_CLOSES + 1, 'frozen close'), tone: 'warn' });
    // Close to the call: danger, and the close it would come at.
    const near = frozenView({ lastSweep: null, nextSweep: 0, closesUntilCall: 2, called: null, day, owed: 90_000, frozen: true })!;
    expect(near.tone).toBe(2 <= ACCELERATION_WARNING_CLOSES ? 'danger' : 'warn');
    expect(near.figures.find((f) => f.label === 'Last sweep')).toMatchObject({ value: 'None', tone: 'muted' });
    expect(near.figures.find((f) => f.label === 'Next sweep')).toMatchObject({ value: 'None expected', tone: 'muted' });
    expect(near.figures.at(-1)!.sub).toBe(`the call comes at the ${formatDate(closeDayAfter(day, 2))} close if still frozen`);
  });

  it('shows what falls due at each close once the loans are called, and nothing when neither frozen nor called', () => {
    const called = frozenView({ lastSweep: null, nextSweep: 0, closesUntilCall: null, called: [31_000, 30_500, 30_000], day, owed: 90_000, frozen: false })!;
    expect(called).toMatchObject({ title: 'Loans called', tone: 'danger' });
    expect(called.text).toContain(formatMoney(90_000));
    expect(called.text).toContain('over the next 3 closes');
    expect(called.figures.map((f) => [f.label, f.value])).toEqual([
      [`Due at the ${formatDate(closeDayAfter(day, 1))} close`, `≈ ${formatMoney(31_000)}`],
      [`Due at the ${formatDate(closeDayAfter(day, 2))} close`, `≈ ${formatMoney(30_500)}`],
      [`Due at the ${formatDate(closeDayAfter(day, 3))} close`, `≈ ${formatMoney(30_000)}`],
    ]);
    expect(frozenView({ lastSweep: null, nextSweep: 0, closesUntilCall: null, called: [5_000], day, owed: 5_000, frozen: true })!.text).toContain('at the next close');
    expect(frozenView({ lastSweep: null, nextSweep: 0, closesUntilCall: null, called: null, day, owed: 90_000, frozen: false })).toBeNull();
    expect(frozenView({ lastSweep: null, nextSweep: 0, closesUntilCall: null, called: null, day, owed: 0, frozen: true })).toBeNull();
    expect(closeDayAfter(day, 1)).toBe(nextCloseDay(day));
    expect(closeDayAfter(day, 2)).toBe(dayOf({ year: 2028, month: 5, day: 1 }));
  });

  it('keeps the sweep, the warning and the call among the notices to reread', () => {
    for (const kind of ['debtSwept', 'accelerationWarning', 'loansCalled'] as const) expect(isBankNotice(kind)).toBe(true);
  });
});

describe('the draw preview', () => {
  function draw(over: Partial<DrawQuote> = {}): DrawQuote {
    return {
      ok: true,
      reasons: [],
      amount: 20_000,
      before: metrics({ totalDebt: 40_000, annualDebtService: 3_000, leverage: 40_000 / 42_000, coverage: 14 }),
      after: metrics({ totalDebt: 60_000, annualDebtService: 4_400, leverage: 60_000 / 42_000, coverage: 9.55 }),
      breachesCovenant: false,
      cashAfter: 50_000,
      interestToClose: 85,
      ...over,
    };
  }

  it('previews leverage and coverage before and after a draw, and its interest to the close', () => {
    const view = drawPreview(draw(), 'compliant')!;
    expect(view.checks[0]).toMatchObject({ label: 'Leverage', value: `${formatRatio(40_000 / 42_000)} → ${formatRatio(60_000 / 42_000)}`, ok: true });
    expect(view.checks[1]).toMatchObject({ label: 'Coverage', value: `${formatRatio(14)} → ${formatRatio(9.55)}`, ok: true });
    expect(view.warning).toBeNull();
    expect(view.interest).toContain(formatMoney(85));
  });

  it('warns when the draw would breach, by stage, and shows nothing for a draw the line refuses', () => {
    const breach = draw({ breachesCovenant: true, after: metrics({ totalDebt: 300_000, leverage: 300_000 / 42_000, leverageOk: false, compliant: false }) });
    expect(drawPreview(breach, 'compliant')!.warning).toBe(
      "At today's cash flow this draw breaks the leverage covenant at the next month close: a warning first, then a penalty rate, then a frozen credit line.",
    );
    expect(drawPreview(breach, 'penalty')!.warning).toContain('a frozen credit line next');
    expect(drawPreview(draw({ ok: false, reasons: ['Only $5,000 is available'] }), 'compliant')).toBeNull();
  });
});
