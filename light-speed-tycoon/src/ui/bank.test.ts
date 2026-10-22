// The Bank's pure view models, round 4c/4d (spec H, "Bank C: health first"),
// fed literal figures or real trading states (and the sim's own quote
// functions where a figure must match what the bank would do), so the
// wording and the arithmetic of the panel are pinned down on their own.
// Money and limits come from balance.ts constants or sim results, never
// literal tuning values. Covered: the health word and sentence of every
// level, the cure in plain words with its button, the two checks (scales,
// markers, unmeasurable and no-debt cases), the amount chips (rounding,
// dedupe, minimum, none when nothing is safe or borrowing is impossible),
// the borrow, draw, repay and prepay previews (over and near a limit, by
// stage), the loan rows, the slip ladder, the frozen line's sweep and
// countdown, and no jargon on the first view.

import { describe, expect, it } from 'vitest';
import {
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  BANK_PREFILL_HEADROOM,
  BANK_WATCH_HEADROOM,
  BASE_RATE_BPS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_TARGET,
  CREDIT_LINE_EXTRA_BPS,
  DRAW_PRESETS,
  FROZEN_ACCELERATION_CLOSES,
  LOAN_ROUNDING,
  PENALTY_STEP_UP_BPS,
  TERM_EXTRA_BPS,
  TERM_LOAN_MIN,
} from '../sim/balance';
import { dayOf, formatDate } from '../sim/calendar';
import {
  bankHealth,
  covenantMetrics,
  covenantsWithin,
  creditOffer,
  cureFor,
  maxSafeTermLoan,
  quoteDraw,
  quotePrepay,
  quoteRepay,
  quoteTermLoan,
  repayAllCommands,
  termCapacity,
} from '../sim/debt';
import { applyCommand } from '../sim/game';
import { makeLoan, makeTradingState } from '../sim/testing/fixtures';
import type { BankHealth, BankHealthLevel, CovenantMetrics, CreditOffer, CureOption, DrawQuote, PrepayQuote, RateBreakdown, RepayQuote, TermLoan, TermLoanQuote } from '../sim/types';
import {
  COVERAGE_BAR_MAX,
  DEBT_BAR_MAX,
  MISSED_PAYMENT_RULE,
  afterFigures,
  bankFigures,
  bankHeader,
  borrowBlocked,
  borrowChips,
  borrowPreview,
  closeDayAfter,
  coverageCheck,
  cppLine,
  creditView,
  cureAction,
  cureAdvice,
  debtCheck,
  defaultTermAmount,
  drawPreview,
  drawPresets,
  effectWords,
  frozenView,
  healthView,
  inFirstMonth,
  isBankNotice,
  loanRow,
  messagesLabel,
  nextCloseDay,
  overLimitConsequence,
  parseAmount,
  paymentWarning,
  perDollar,
  plainRate,
  prefillLine,
  prefillTermAmount,
  prepayPreview,
  rateRows,
  recoveringLine,
  repayPresets,
  repayPreview,
  repricedLines,
  safeAmountLine,
  slipLadder,
  slipOpenByDefault,
  stepBackLine,
  termDetailLines,
  trimNumber,
  yearsOfProfit,
} from './bankPanel';
import { formatBpsDelta, formatMoney, plural } from './format';
import { CALLED_WORD, HEALTH_WORD, stepBackText } from './health';

/** Words that may appear only inside a disclosure, next to their plain meaning. */
const JARGON = /leverage|covenant|DSCR|ARR|OCF|bps|×|debt service|term loan|credit line/i;

// ---------------------------------------------------------------------------
// Literal factories
// ---------------------------------------------------------------------------

function rate(over: Partial<RateBreakdown> = {}): RateBreakdown {
  const parts = { baseBps: BASE_RATE_BPS, leverageBps: 0, cppBps: 0, productBps: CREDIT_LINE_EXTRA_BPS, penaltyBps: 0, ...over };
  const rateBps = parts.baseBps + parts.leverageBps + parts.cppBps + parts.productBps;
  return { leverage: 0, cpp: null, cppBand: null, rateBps, effectiveRateBps: rateBps + parts.penaltyBps, ...parts, ...over };
}

/** Covenant figures with `debt` owed against `uw` a year of profit and `service` a year of payments (leverage and coverage to the hundredth, as the sim rounds them). */
function metrics(debt: number, uw = 100_000, service = 0, over: Partial<CovenantMetrics> = {}): CovenantMetrics {
  const leverage = debt === 0 ? 0 : uw > 0 ? Math.round((debt / uw) * 100) / 100 : null;
  const coverage = service === 0 ? null : Math.round((uw / service) * 100) / 100;
  const leverageOk = debt === 0 || (leverage !== null && leverage <= COVENANT_MAX_LEVERAGE);
  const coverageOk = service === 0 || (coverage !== null && coverage >= COVENANT_MIN_COVERAGE);
  return {
    totalDebt: debt,
    arr: uw * 3,
    annualOperatingCashFlow: uw,
    underwritingCashFlow: uw,
    annualDebtService: service,
    leverage,
    coverage,
    leverageOk,
    coverageOk,
    compliant: leverageOk && coverageOk,
    ...over,
  };
}

/** Comfortably inside both limits. */
const SAFE = metrics(200_000, 100_000, 30_000);
/** Inside both limits, but within BANK_WATCH_HEADROOM of the leverage limit. */
const NEAR = metrics(COVENANT_MAX_LEVERAGE * (1 - BANK_WATCH_HEADROOM / 2) * 100_000, 100_000, 30_000);
/** Over the leverage limit. */
const OVER = metrics((COVENANT_MAX_LEVERAGE + 1) * 100_000, 100_000, 30_000);
const NONE = metrics(0);

function health(level: BankHealthLevel, over: Partial<BankHealth> = {}): BankHealth {
  return {
    level,
    noDebt: false,
    failingNow: false,
    nearLimit: false,
    metrics: SAFE,
    penaltyBps: level === 'penalty' || level === 'frozen' ? PENALTY_STEP_UP_BPS : 0,
    closesUntilCalled: level === 'frozen' ? 3 : null,
    called: false,
    ...over,
  };
}

function termQuote(over: Partial<TermLoanQuote> = {}): TermLoanQuote {
  return {
    ok: true,
    reasons: [],
    amount: 50_000,
    termYears: 5,
    termMonths: 60,
    maxAmount: 360_000,
    rate: rate({ productBps: TERM_EXTRA_BPS[5] }),
    payment: 976,
    lastPayment: 976,
    stubInterest: 120,
    totalInterest: 8_560,
    before: SAFE,
    after: metrics(250_000, 100_000, 41_700),
    breachesCovenant: false,
    cashAfter: 150_000,
    repriced: [],
    safeMaxAmount: 300_000,
    ...over,
  };
}

function offer(over: Partial<CreditOffer> = {}): CreditOffer {
  return { limit: 60_000, balance: 0, available: 60_000, maxRepay: 0, frozen: false, rate: rate(), accruedInterest: 0, arr: 120_000, reasons: [], ...over };
}

function loan(over: Partial<TermLoan> = {}): TermLoan {
  return { id: 2, principal: 100_000, balance: 40_000, rateBps: 725, termMonths: 60, payment: 790, monthsLeft: 51, originatedDay: 0, ...over };
}

const LATER = dayOf({ year: 2027, month: 9, day: 10 });

// ---------------------------------------------------------------------------

describe('plain numbers', () => {
  it('rounds years of profit to a tenth, never hiding which side of the limit it is on', () => {
    expect(yearsOfProfit(3.42)).toBe('3.4 years of profit');
    expect(yearsOfProfit(1)).toBe('1 year of profit');
    expect(yearsOfProfit(COVENANT_MAX_LEVERAGE)).toBe(`${trimNumber(COVENANT_MAX_LEVERAGE)} years of profit`);
    // Just over the limit: one decimal would read as the limit itself.
    expect(yearsOfProfit(COVENANT_MAX_LEVERAGE + 0.04)).toBe(`${trimNumber(COVENANT_MAX_LEVERAGE + 0.04)} years of profit`);
    expect(yearsOfProfit(0.03)).toBe('under 0.1 years of profit');
  });

  it('says rates and earnings per dollar plainly', () => {
    expect(plainRate(640)).toBe('6.4%');
    expect(plainRate(725)).toBe('7.25%');
    expect(plainRate(600)).toBe('6%');
    expect(perDollar(1.54)).toBe('$1.54');
    expect(perDollar(COVENANT_MIN_COVERAGE)).toBe(`$${COVENANT_MIN_COVERAGE.toFixed(2)}`);
    expect(perDollar(-0.3)).toBe('-$0.30');
  });

  it('takes whole dollars only', () => {
    expect(parseAmount('12000')).toBe(12_000);
    expect(parseAmount('$12,000')).toBe(12_000);
    expect(parseAmount('12.5')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
  });

  it('heads the Bank with the company, as text', () => {
    expect(bankHeader('  Otter Junction Fiber ')).toBe('The Bank · Otter Junction Fiber');
    expect(bankHeader('<b>x</b>')).toBe('The Bank · <b>x</b>');
    expect(bankHeader('')).toBe('The Bank');
  });
});

describe('health status', () => {
  const cases: [BankHealthLevel, Partial<BankHealth>, string, string][] = [
    ['good', { noDebt: true, metrics: NONE }, 'Good', 'No loans yet.'],
    ['good', {}, 'Good', 'The bank checks two things each month. You pass both.'],
    ['watch', { nearLimit: true, metrics: NEAR }, 'Watch', "You pass both checks, but you're close to a limit."],
    ['watch', { failingNow: true, metrics: OVER }, 'Watch', "At today's figures you'd fail a check at the next month close."],
    ['warning', { metrics: OVER }, 'Warning', 'You went over a limit at the last month close. Nothing changes yet.'],
    ['penalty', { metrics: OVER }, 'Higher interest', `You went over again. Every loan now costs ${plainRate(PENALTY_STEP_UP_BPS)} more.`],
    [
      'frozen',
      { metrics: OVER, closesUntilCalled: 3 },
      'No more borrowing',
      "You can't borrow, the bank takes your spare cash each month, and if this goes on it asks for every loan back in 3 months.",
    ],
  ];

  it.each(cases)('%s: one word, a big title and one plain sentence', (level, over, word, sentence) => {
    const view = healthView(health(level, over));
    expect(view.word).toBe(word);
    expect(view.word).toBe(HEALTH_WORD[level]);
    expect(view.title).toBe(`Bank health: ${word}`);
    expect(view.sentence).toBe(sentence);
    expect(view.sentence).not.toMatch(JARGON);
  });

  it('never rests on color alone: each level has its own icon shape and a tone', () => {
    const levels: BankHealthLevel[] = ['good', 'watch', 'warning', 'penalty', 'frozen'];
    const icons = levels.map((l) => healthView(health(l)).icon);
    expect(new Set(icons).size).toBe(levels.length);
    expect(healthView(health('good')).tone).toBe('ok');
    expect(healthView(health('watch')).tone).toBe('warn');
    expect(healthView(health('frozen')).tone).toBe('danger');
  });

  it('says once the bank has asked for every loan back, whatever the stage', () => {
    expect(healthView(health('frozen', { called: true, closesUntilCalled: null })).sentence).toBe(
      "The bank has asked for every loan back. You can't borrow until it's all repaid.",
    );
    expect(healthView(health('penalty', { called: true })).sentence).toMatch(/asked for every loan back/);
    // Round 4c/4d: the title says so too, as the HUD chip and the month summary do, in danger whatever the stage.
    for (const level of ['warning', 'penalty', 'frozen'] as const) {
      const view = healthView(health(level, { called: true }));
      expect(view.title).toBe(`Bank health: ${CALLED_WORD}`);
      expect(view.tone).toBe('danger');
    }
    expect(healthView(health('frozen')).title).toBe(`Bank health: ${HEALTH_WORD.frozen}`);
    // Frozen (or worse) with nothing owed: the next close clears it.
    expect(healthView(health('frozen', { noDebt: true, metrics: NONE, closesUntilCalled: null })).sentence).toMatch(/owe nothing/);
  });

  it('reads a real game: no debt Good, a loan the cash flow cannot carry Watch, then the stages', () => {
    const state = makeTradingState(30_000);
    expect(healthView(bankHealth(state)).title).toBe('Bank health: Good');
    state.debt.loans = [makeLoan({ balance: 2_000_000, principal: 2_000_000 })];
    expect(healthView(bankHealth(state)).word).toBe('Watch');
    state.debt.covenant = { stage: 'penalty', compliantCloses: 0 };
    expect(healthView(bankHealth(state)).sentence).toContain(`${plainRate(PENALTY_STEP_UP_BPS)} more`);
  });
});

describe('the cure', () => {
  const cure = (over: Partial<CureOption>): CureOption => ({ kind: 'repayCredit', loan: null, amount: 42_000, after: SAFE, cashAfter: 80_000, text: 'Repay $42,000 of the credit line: leverage 2.0×', ...over });

  it('words each verified cure plainly, never with the sim’s jargon', () => {
    expect(cureAdvice(cure({}))).toBe(`To pass both checks again, pay back ${formatMoney(42_000)} of emergency cash. That leaves ${formatMoney(80_000)} in cash.`);
    expect(cureAdvice(cure({ kind: 'prepayLoan', loan: 3 }))).toBe(`To pass both checks again, pay ${formatMoney(42_000)} off loan 3 early. That leaves ${formatMoney(80_000)} in cash.`);
    expect(cureAdvice(cure({ kind: 'repayAll', amount: 150_000 }))).toMatch(/^To clear things with the bank, pay back everything you owe \(\$150,000\)/);
    expect(cureAdvice(cure({ kind: 'grow', amount: 24_000 }))).toBe(`No repayment fixes it: you'd need about ${formatMoney(24_000)} a year more profit to pass both checks.`);
    expect(cureAdvice(null)).toBe('');
    for (const kind of ['repayCredit', 'prepayLoan', 'repayAll', 'grow'] as const) expect(cureAdvice(cure({ kind, loan: 1 }))).not.toMatch(JARGON);
  });

  it('says the call stands for a cure short of repaying everything', () => {
    expect(cureAdvice(cure({}), true)).toContain('The bank still wants every loan back on schedule.');
    expect(cureAdvice(cure({ kind: 'repayAll' }), true)).not.toContain('still wants');
  });

  it('gives each cure that a command makes its button, and growth none', () => {
    const state = makeTradingState(25_000, 20_000);
    state.debt.credit.balance = 10_000;
    state.debt.loans = [makeLoan({ id: 4, balance: 30_000 })];
    expect(cureAction(cure({}), state)).toEqual({
      label: `Pay back ${formatMoney(42_000)}`,
      done: `Paid back ${formatMoney(42_000)} of emergency cash`,
      commands: [{ type: 'repayCredit', amount: 42_000 }],
    });
    expect(cureAction(cure({ kind: 'prepayLoan', loan: 4, amount: 9_000 }), state)!.commands).toEqual([{ type: 'prepayLoan', loan: 4, amount: 9_000 }]);
    expect(cureAction(cure({ kind: 'repayAll' }), state)!.commands).toEqual(repayAllCommands(state));
    expect(cureAction(cure({ kind: 'grow' }), state)).toBeNull();
    expect(cureAction(null, state)).toBeNull();
  });

  it('takes the sim’s verified cure on a real breach, and its button cures it', () => {
    const state = makeTradingState(25_000, 20_000);
    state.finance.cash = 2_000_000;
    state.debt.covenant = { stage: 'warning', compliantCloses: 0 };
    state.debt.credit.balance = 2_000_000;
    const option = cureFor(state)!;
    expect(option).not.toBeNull();
    const action = cureAction(option, state)!;
    for (const cmd of action.commands) expect(applyCommand(state, cmd)).toMatchObject({ ok: true });
    expect(covenantMetrics(state).compliant).toBe(true);
  });

  it('off a good standing but passing today, says how it steps back, with the progress', () => {
    expect(recoveringLine('compliant', 0, true, 50_000)).toBe('');
    expect(recoveringLine('warning', 0, false, 50_000)).toBe('');
    expect(recoveringLine('warning', 0, true, 50_000)).toBe(`You pass both checks today. ${plural(COVENANT_CURE_CLOSES, 'good month close')} in a row move you back one step.`);
    expect(recoveringLine('penalty', 1, true, 50_000)).toContain(`(1 of ${COVENANT_CURE_CLOSES} so far)`);
    // Called, the call stands whatever the checks say; owing nothing, the health sentence says it.
    expect(recoveringLine('frozen', 0, true, 50_000, true)).toBe('');
    expect(recoveringLine('frozen', 0, true, 0)).toBe('');
  });
});

describe('the two checks', () => {
  it('puts the limit markers where the limits are on fixed scales', () => {
    expect(DEBT_BAR_MAX).toBeGreaterThan(COVENANT_MAX_LEVERAGE);
    expect(COVERAGE_BAR_MAX).toBeGreaterThan(COVENANT_MIN_COVERAGE);
    const debt = debtCheck(SAFE);
    expect(debt.marker).toBeCloseTo(COVENANT_MAX_LEVERAGE / DEBT_BAR_MAX);
    expect(debt.markerLabel).toBe(`limit ${trimNumber(COVENANT_MAX_LEVERAGE)}`);
    expect(debt.scaleStart).toBe('0 years');
    expect(debt.fill).toBeCloseTo(SAFE.leverage! / DEBT_BAR_MAX);
    const coverage = coverageCheck(SAFE);
    expect(coverage.marker).toBeCloseTo(COVENANT_MIN_COVERAGE / COVERAGE_BAR_MAX);
    expect(coverage.markerLabel).toBe(`at least ${perDollar(COVENANT_MIN_COVERAGE)}`);
    expect(coverage.scaleStart).toBe('$0');
    expect(coverage.fill).toBeCloseTo(Math.min(1, SAFE.coverage! / COVERAGE_BAR_MAX));
    expect(coverageCheck(metrics(100_000, 100_000, 60_000)).fill).toBeCloseTo(Math.round((100_000 / 60_000) * 100) / 100 / COVERAGE_BAR_MAX);
  });

  it('says each check in one plain sentence, the figure in bold', () => {
    const debt = debtCheck(SAFE);
    expect(debt.sentence).toBe(`Your debt is ${yearsOfProfit(SAFE.leverage!)}. The bank's limit is ${trimNumber(COVENANT_MAX_LEVERAGE)}.`);
    expect(debt.parts.find((p) => p.strong)?.text).toBe(yearsOfProfit(SAFE.leverage!));
    expect(debt.status).toBe('pass');
    const coverage = coverageCheck(SAFE);
    expect(coverage.sentence).toBe(`You earn ${perDollar(SAFE.coverage!)} for every $1 of loan payments. The bank wants at least ${perDollar(COVENANT_MIN_COVERAGE)}.`);
    expect(coverage.status).toBe('pass');
    for (const c of [debt, coverage]) {
      expect(c.sentence).not.toMatch(JARGON);
      expect(c.barLabel).not.toBe('');
    }
  });

  it('turns over-limit bars red with words saying so, and near ones amber', () => {
    const over = debtCheck(OVER);
    expect(over).toMatchObject({ status: 'over', statusText: "Over the bank's limit" });
    expect(over.fill).toBe(1);
    expect(debtCheck(NEAR)).toMatchObject({ status: 'near', statusText: 'Close to the limit' });
    const under = coverageCheck(metrics(100_000, 100_000, 100_000 / (COVENANT_MIN_COVERAGE - 0.2)));
    expect(under).toMatchObject({ status: 'over', statusText: "Under the bank's minimum" });
    const close = coverageCheck(metrics(100_000, 100_000, 100_000 / (COVENANT_MIN_COVERAGE * (1 + BANK_WATCH_HEADROOM / 2))));
    expect(close).toMatchObject({ status: 'near', statusText: 'Close to the minimum' });
    // A huge cushion fills the bar, no more.
    expect(coverageCheck(metrics(10_000, 1_000_000, 10_000)).fill).toBe(1);
  });

  it('says plainly when there is no profit to measure the debt against, or nothing earned toward the payments', () => {
    const none = metrics(80_000, 0, 20_000, { leverage: null, leverageOk: false, coverage: 0, coverageOk: false, compliant: false });
    const debt = debtCheck(none);
    expect(debt.sentence).toMatch(/^You have no profit yet to measure your debt against\./);
    expect(debt).toMatchObject({ status: 'over', fill: 1 });
    const coverage = coverageCheck(none);
    expect(coverage.sentence).toMatch(/^You don't earn enough yet to make your loan payments\./);
    expect(coverage.status).toBe('over');
  });

  it('reads as passed and not needed with no debt', () => {
    expect(debtCheck(NONE)).toMatchObject({ sentence: 'You owe nothing, so this check passes.', status: 'none', statusText: 'Passed', fill: 0 });
    expect(coverageCheck(NONE)).toMatchObject({ sentence: 'No loan payments yet.', status: 'none', statusText: 'Not needed', fill: 0 });
  });

  it('keeps every figure behind the checks one tap away, the bank’s words beside the plain ones, debt never toned', () => {
    const figures = bankFigures(SAFE, { credit: 50_000, term: 150_000, estimate: 3_000, cashAtClose: 2_000, day: LATER, last: null });
    const labels = figures.map((f) => f.label);
    expect(labels).toEqual(expect.arrayContaining(['What you owe', 'Profit, as the bank counts it', 'Yearly bills, as the bank counts them', 'Loan payments, next 12 months', 'Years of profit', 'Earned per $1 of payments', 'Next loan payment', 'Cash at the close']));
    expect(figures.find((f) => f.label === 'What you owe')!.tone).toBeUndefined();
    expect(figures.find((f) => f.label === 'Years of profit')!.sub).toMatch(/^leverage/);
    expect(figures.find((f) => f.label === 'Earned per $1 of payments')!.sub).toMatch(/^coverage \(DSCR\)/);
    expect(figures.find((f) => f.label === 'Yearly bills, as the bank counts them')!.sub).toMatch(/^lending ARR/);
    // The next payment the close won't have the cash for.
    expect(figures.find((f) => f.label === 'Next loan payment')!.tone).toBe('warn');
  });
});

describe('borrow more: the amount chips', () => {
  it('offers about a third, about two thirds and all of the largest safe amount, rounded down', () => {
    const safe = 10 * TERM_LOAN_MIN + LOAN_ROUNDING / 2;
    const round = (x: number) => Math.floor(x / LOAN_ROUNDING) * LOAN_ROUNDING;
    expect(borrowChips(safe)).toEqual([
      { amount: round(safe / 3), label: formatMoney(round(safe / 3)), share: 'third' },
      { amount: round((safe * 2) / 3), label: formatMoney(round((safe * 2) / 3)), share: 'twoThirds' },
      { amount: round(safe), label: formatMoney(round(safe)), share: 'safe' },
    ]);
    for (const chip of borrowChips(safe)) expect(chip.amount % LOAN_ROUNDING).toBe(0);
  });

  it('drops chips below the smallest loan, and duplicates', () => {
    // Two thirds and a third are under the minimum: only the largest safe amount.
    expect(borrowChips(TERM_LOAN_MIN).map((c) => c.amount)).toEqual([TERM_LOAN_MIN]);
    // A third under the minimum, two thirds over it.
    const mid = Math.ceil((TERM_LOAN_MIN * 1.6) / LOAN_ROUNDING) * LOAN_ROUNDING;
    expect(borrowChips(mid).map((c) => c.share)).toEqual(['twoThirds', 'safe']);
    // Rounding can make two the same: listed once.
    const tiny = LOAN_ROUNDING;
    const amounts = borrowChips(TERM_LOAN_MIN * 3 + tiny).map((c) => c.amount);
    expect(new Set(amounts).size).toBe(amounts.length);
    // Nothing safe: no chips (the builder opens "Other amount" at the smallest loan).
    expect(borrowChips(0)).toEqual([]);
    expect(defaultTermAmount(0)).toBe(TERM_LOAN_MIN);
  });

  it('starts at the largest chip: BANK_PREFILL_HEADROOM inside the limits on a real trading state', () => {
    const state = makeTradingState(40_000, 36_000);
    for (const years of [5, 7] as const) {
      const exact = maxSafeTermLoan(state, years);
      const prefill = prefillTermAmount(state, years);
      expect(prefill).toBeGreaterThanOrEqual(TERM_LOAN_MIN);
      expect(prefill).toBeLessThanOrEqual(exact);
      expect(covenantsWithin(quoteTermLoan(state, prefill, years).after, BANK_PREFILL_HEADROOM)).toBe(true);
      expect(borrowChips(maxSafeTermLoan(state, years, BANK_PREFILL_HEADROOM)).at(-1)!.amount).toBe(prefill);
    }
  });

  it('says why nothing can be borrowed, in one plain sentence, instead of chips', () => {
    expect(borrowBlocked(100_000, health('good'))).toBe('');
    expect(borrowBlocked(0, health('good', { metrics: metrics(0, 0, 0, { arr: 0 }) }))).toBe('The bank lends once customers are paying you: sign up customers first.');
    expect(borrowBlocked(0, health('frozen'))).toMatch(/^No more borrowing for now/);
    expect(borrowBlocked(0, health('penalty', { called: true }))).toMatch(/asked for every loan back/);
    expect(borrowBlocked(0, health('good'))).toContain(formatMoney(TERM_LOAN_MIN));
    for (const h of [health('good'), health('frozen'), health('warning', { called: true })]) expect(borrowBlocked(0, h)).not.toMatch(JARGON);
    // A fresh town: no capacity, so no preview either.
    const fresh = makeTradingState(0);
    expect(termCapacity(fresh)).toBe(0);
    expect(borrowBlocked(termCapacity(fresh), bankHealth(fresh))).toMatch(/sign up customers/);
    expect(borrowPreview(quoteTermLoan(fresh, TERM_LOAN_MIN, 5), 'compliant')).toBeNull();
  });
});

describe('borrow more: the preview', () => {
  it('words a loan that keeps the bank happy, with the figures after and the cost', () => {
    const q = termQuote();
    const preview = borrowPreview(q, 'compliant')!;
    expect(preview.tone).toBe('ok');
    expect(preview.text).toBe(
      `If you borrow ${formatMoney(50_000)}: still Good. Debt becomes ${yearsOfProfit(q.after.leverage!)}, you'd earn ${perDollar(q.after.coverage!)} per $1. ` +
        `${formatMoney(976)} a month for 5 years at ${plainRate(q.rate.effectiveRateBps)}.`,
    );
    expect(preview.text).not.toMatch(JARGON);
  });

  it('warns near a limit and, over one, says what the next close brings from each stage', () => {
    expect(borrowPreview(termQuote({ after: NEAR }), 'compliant')).toMatchObject({ tone: 'warn', text: expect.stringMatching(/^If you borrow \$50,000: Watch\. You'd be close to the bank's limit\./) });
    expect(borrowPreview(termQuote({ before: NEAR, after: NEAR }), 'compliant')!.text).toMatch(/: still Watch\./);
    const over = termQuote({ after: OVER, breachesCovenant: true });
    expect(borrowPreview(over, 'compliant')).toMatchObject({
      tone: 'danger',
      text: expect.stringContaining("this would put you over the bank's limit: you'd get a warning at the next month close."),
    });
    expect(borrowPreview(over, 'warning')!.text).toContain('your interest would go up at the next month close');
    expect(borrowPreview(over, 'penalty')!.text).toContain('the bank would stop lending at the next month close');
    // Already over today: still over, and the same consequence.
    expect(borrowPreview(termQuote({ before: OVER, after: OVER }), 'compliant')!.text).toContain("you'd still be over the bank's limit: you'd get a warning");
    // Off a good standing but passing: no health word to keep.
    expect(borrowPreview(termQuote(), 'warning')!.text).toContain("you'd still pass both checks");
  });

  it('says the higher interest is in the payment while it lasts', () => {
    const q = termQuote({ rate: rate({ productBps: TERM_EXTRA_BPS[5], penaltyBps: PENALTY_STEP_UP_BPS }) });
    expect(borrowPreview(q, 'penalty')!.text).toContain(`at ${plainRate(q.rate.effectiveRateBps)}, with the higher interest while it lasts.`);
  });

  it('names the problem with an amount the bank won’t lend', () => {
    expect(borrowPreview(termQuote({ amount: TERM_LOAN_MIN - LOAN_ROUNDING, ok: false, payment: 0 }), 'compliant')).toEqual({ tone: 'warn', text: `The smallest loan is ${formatMoney(TERM_LOAN_MIN)}.` });
    expect(borrowPreview(termQuote({ amount: 400_000, ok: false, payment: 0 }), 'compliant')!.text).toBe(`The most the bank will lend now is ${formatMoney(360_000)}.`);
    expect(borrowPreview(termQuote({ amount: Number.NaN, ok: false, payment: 0 }), 'compliant')!.text).toBe('Enter an amount in whole dollars.');
    expect(borrowPreview(termQuote({ amount: 12_500.5, ok: false, payment: 0 }), 'compliant')!.text).toBe('Enter an amount in whole dollars.');
  });

  it('matches the sim on a real trading state: the prefill is fine, all of the capacity is not', () => {
    const state = makeTradingState(40_000, 36_000);
    const prefill = prefillTermAmount(state, 5);
    expect(borrowPreview(quoteTermLoan(state, prefill, 5), 'compliant')!.text).toMatch(/: still Good\./);
    const all = quoteTermLoan(state, termCapacity(state), 5);
    expect(all.breachesCovenant).toBe(true);
    expect(borrowPreview(all, 'compliant')!.tone).toBe('danger');
  });

  it('words same-month re-pricing plainly, only when it applies', () => {
    const lines = repricedLines([{ loan: 1, rateBps: 650, rateBpsAfter: 725, payment: 1_200, paymentAfter: 1_265 }]);
    expect(lines).toEqual([`Loan 1, taken this month, would go from 6.5% to 7.25%: ${formatMoney(1_200)} to ${formatMoney(1_265)} a month. Loans taken in the same month share one rate.`]);
    expect(repricedLines([])).toEqual([]);
  });

  it('keeps the exact largest safe amount and the rest in "How the rate is set"', () => {
    expect(safeAmountLine(120_000, 360_000, 5)).toBe(`The most you can borrow over 5 years and still pass both checks: ${formatMoney(120_000)}.`);
    expect(safeAmountLine(360_000, 360_000, 7)).toContain('all the bank will lend');
    expect(safeAmountLine(0, 360_000, 5)).toContain(`even the smallest, ${formatMoney(TERM_LOAN_MIN)}`);
    expect(safeAmountLine(0, 0, 5)).toBe('');
    expect(prefillLine(100_000, 120_000)).toContain(`${Math.round(BANK_PREFILL_HEADROOM * 100)}% inside`);
    expect(prefillLine(120_000, 120_000)).toBe('');
    const lines = termDetailLines(termQuote({ lastPayment: 1_002 }), 250_000);
    expect(lines[0]).toBe(safeAmountLine(300_000, 360_000, 5));
    expect(lines.join(' ')).toContain('lending ARR');
    expect(lines.join(' ')).toContain(`The last payment is ${formatMoney(1_002)}.`);
    expect(lines.join(' ')).toContain(`Total interest ${formatMoney(8_560)}`);
    expect(termDetailLines(termQuote({ maxAmount: 0 }), 0)).toEqual([]);
  });
});

describe('the rate’s parts', () => {
  it('names each part plainly with the bank’s word beside it, and the penalty only while it applies', () => {
    const rows = rateRows(rate({ productBps: TERM_EXTRA_BPS[7], leverageBps: 50 }), { kind: 'term', years: 7 });
    expect(rows.map((r) => r.key)).toEqual(['base', 'leverage', 'cpp', 'product']);
    expect(rows.find((r) => r.key === 'leverage')!.label).toBe('For how much you owe (leverage)');
    expect(rows.find((r) => r.key === 'product')!.label).toBe('For a 7-year loan (term premium)');
    expect(rows.find((r) => r.key === 'base')!.value).toBe(plainRate(BASE_RATE_BPS));
    const penalty = rateRows(rate({ penaltyBps: PENALTY_STEP_UP_BPS }), { kind: 'line' });
    expect(penalty.at(-1)).toMatchObject({ key: 'penalty', value: formatBpsDelta(PENALTY_STEP_UP_BPS) });
  });

  it('words the cost-per-passing spread by band', () => {
    expect(cppLine(rate())).toBe('Nothing passed yet: no CPP spread');
    expect(cppLine(rate({ cpp: CPP_TARGET - 258, cppBand: 'green' }))).toBe(`Cost per passing ${formatMoney(CPP_TARGET - 258)} is under target: no CPP spread`);
    expect(cppLine(rate({ cpp: CPP_TARGET * 2, cppBand: 'red', cppBps: 150 }))).toContain('far over target (red)');
  });
});

describe('emergency cash (the credit line)', () => {
  it('says what it is, what it costs and how much is used, plainly', () => {
    const view = creditView(offer({ balance: 12_000, available: 48_000, maxRepay: 12_000 }), health('good'));
    expect(view.summary).toBe(`Borrow and repay any time, up to ${formatMoney(60_000)}. Using now: ${formatMoney(12_000)}.`);
    expect(view.rate).toBe(`It costs ${plainRate(rate().effectiveRateBps)} a year on what you use, charged at each month close.`);
    expect(view.using).toBe(`You're using ${formatMoney(12_000)} of emergency cash.`);
    expect(view).toMatchObject({ canDraw: true, canRepay: true, why: '', repayWhy: '' });
    for (const text of [view.summary, view.rate, view.using]) expect(text).not.toMatch(JARGON);
  });

  it('says why nothing can be taken: none yet, used up, frozen, called', () => {
    expect(creditView(offer({ limit: 0, available: 0, arr: 0 }), health('good')).why).toMatch(/^No emergency cash yet/);
    expect(creditView(offer({ limit: 0, available: 0, arr: 0 }), health('good')).summary).toBe('');
    expect(creditView(offer({ balance: 60_000, available: 0, maxRepay: 60_000 }), health('good')).why).toBe(`You're using all ${formatMoney(60_000)} of it.`);
    expect(creditView(offer({ frozen: true, available: 0, balance: 5_000 }), health('frozen')).why).toMatch(/stopped lending\. You can still pay it back\./);
    expect(creditView(offer({ available: 0, balance: 5_000 }), health('penalty', { called: true })).why).toMatch(/asked for every loan back/);
    expect(creditView(offer({ balance: 5_000, maxRepay: 0 }), health('good')).repayWhy).toBe('No cash to pay it back with right now.');
  });

  it('offers amounts up to what is available, and pay-back amounts capped at cash', () => {
    const presets = drawPresets(30_000);
    expect(presets.map((p) => p.label)).toEqual([...DRAW_PRESETS.map((a) => formatMoney(a)), 'Half', 'All']);
    expect(presets.at(-1)).toMatchObject({ amount: 30_000, disabled: false });
    expect(presets.find((p) => p.label === 'Half')!.amount).toBe(15_000);
    expect(drawPresets(0).every((p) => p.disabled)).toBe(true);
    expect(repayPresets({ balance: 9_001, maxRepay: 9_001 })).toEqual([
      { label: 'Half', amount: 4_501, disabled: false },
      { label: 'All', amount: 9_001, disabled: false },
    ]);
    expect(repayPresets({ balance: 9_000, maxRepay: 2_000 })[0]!.amount).toBe(2_000);
  });

  const draw = (over: Partial<DrawQuote> = {}): DrawQuote => ({
    ok: true,
    reasons: [],
    amount: 20_000,
    before: SAFE,
    after: metrics(220_000, 100_000, 31_500),
    breachesCovenant: false,
    cashAfter: 120_000,
    interestToClose: 85,
    ...over,
  });

  it('previews a draw in words: its effect on the bank’s health and its interest', () => {
    const preview = drawPreview(draw(), 'compliant', 48_000);
    expect(preview.tone).toBe('ok');
    expect(preview.text).toBe(`If you take ${formatMoney(20_000)}: still Good. ${afterFigures(draw().after)} About ${formatMoney(85)} of interest if you keep it to the month end.`);
    expect(preview.text).not.toMatch(JARGON);
    expect(drawPreview(draw({ after: OVER, breachesCovenant: true }), 'compliant', 48_000)).toMatchObject({ tone: 'danger', text: expect.stringContaining("you'd get a warning at the next month close") });
    expect(drawPreview(draw({ ok: false, amount: 50_000 }), 'compliant', 48_000).text).toBe(`You can take up to ${formatMoney(48_000)} now.`);
    expect(drawPreview(draw({ ok: false, amount: 1.5 }), 'compliant', 48_000).text).toBe('Enter an amount in whole dollars.');
  });

  const repay = (over: Partial<RepayQuote> = {}): RepayQuote => ({ ok: true, reasons: [], amount: 6_000, before: OVER, after: SAFE, cashAfter: 94_000, ...over });

  it('previews paying back in words, including passing both checks again', () => {
    expect(repayPreview(repay(), 'warning', { balance: 12_000, maxRepay: 12_000 })).toMatchObject({
      tone: 'ok',
      text: `If you pay back ${formatMoney(6_000)}: you'd pass both checks again. ${afterFigures(SAFE)} Leaves ${formatMoney(94_000)} in cash.`,
    });
    expect(repayPreview(repay({ before: SAFE }), 'compliant', { balance: 12_000, maxRepay: 12_000 }).text).toMatch(/: still Good\./);
    expect(repayPreview(repay({ before: NEAR }), 'compliant', { balance: 12_000, maxRepay: 12_000 }).text).toMatch(/: back to Good\./);
    expect(repayPreview(repay({ after: NONE, before: SAFE }), 'compliant', { balance: 12_000, maxRepay: 12_000 }).text).toMatch(/: you'd owe nothing\. Leaves/);
    expect(repayPreview(repay({ ok: false, amount: 20_000 }), 'compliant', { balance: 12_000, maxRepay: 12_000 }).text).toBe(`You're using ${formatMoney(12_000)}: that's the most you can pay back.`);
    expect(repayPreview(repay({ ok: false, amount: 8_000 }), 'compliant', { balance: 12_000, maxRepay: 5_000 }).text).toBe(`You can pay back up to ${formatMoney(5_000)} with the cash you have.`);
  });

  it('matches the sim: a draw and a repayment on a real trading state', () => {
    const state = makeTradingState(40_000, 20_000);
    const credit = creditOffer(state);
    expect(credit.available).toBeGreaterThan(0);
    const amount = Math.floor(credit.available / 2);
    expect(drawPreview(quoteDraw(state, amount), 'compliant', credit.available).text).toMatch(/^If you take /);
    expect(applyCommand(state, { type: 'drawCredit', amount })).toMatchObject({ ok: true });
    const after = creditOffer(state);
    expect(repayPreview(quoteRepay(state, after.balance), 'compliant', after).text).toMatch(/you'd owe nothing/);
  });
});

describe('pay back: the loans', () => {
  it('lists each loan as one row: what is left, the payment and the months left', () => {
    const row = loanRow(loan(), LATER, 0);
    expect(row.line).toBe(`Loan 2: ${formatMoney(40_000)} left · ${formatMoney(790)} a month · 51 months left`);
    expect(row.line).toBe(`${row.title}: ${row.balance}${row.rest}`);
    expect(row.note).toBe(`5-year loan at ${plainRate(725)}.`);
    expect(row.line).not.toMatch(JARGON);
  });

  it('notes a first interest-only payment, a different last payment and the higher interest', () => {
    const taken = dayOf({ year: 2027, month: 9, day: 3 });
    expect(inFirstMonth(loan({ originatedDay: taken }), LATER)).toBe(true);
    expect(loanRow(loan({ originatedDay: taken }), LATER, 0).note).toContain("This month's payment is interest only");
    expect(loanRow(loan(), LATER, 0, 812).note).toContain(`The last payment will be ${formatMoney(812)}.`);
    expect(loanRow(loan({ monthsLeft: 1, balance: 805 }), LATER, 0, 812).line).toBe(`Loan 2: ${formatMoney(805)} left · last payment ${formatMoney(812)}`);
    expect(loanRow(loan(), LATER, PENALTY_STEP_UP_BPS).note).toContain(`higher interest (${formatBpsDelta(PENALTY_STEP_UP_BPS)})`);
  });

  const prepay = (over: Partial<PrepayQuote> = {}): PrepayQuote => ({
    ok: true,
    reasons: [],
    loan: 2,
    amount: 40_000,
    accruedInterest: 120,
    total: 40_120,
    paysOff: true,
    paymentAfter: 0,
    after: metrics(160_000, 100_000, 20_500),
    ...over,
  });

  it('says what paying off early takes and what it does to the bank’s health', () => {
    expect(prepayPreview(prepay(), 'compliant', SAFE, 40_000, 100_000)).toEqual({
      ok: true,
      tone: 'ok',
      text: `If you pay it off: still Good. It takes ${formatMoney(40_120)} of cash, with ${formatMoney(120)} of interest so far.`,
      label: `Pay off for ${formatMoney(40_120)}`,
    });
    const part = prepayPreview(prepay({ amount: 10_000, total: 10_040, accruedInterest: 40, paysOff: false, paymentAfter: 593 }), 'warning', OVER, 40_000, 100_000);
    expect(part.text).toBe(
      `If you pay ${formatMoney(10_000)} off early: you'd pass both checks again. It takes ${formatMoney(10_040)} of cash, with ${formatMoney(40)} of interest so far, and the payment drops to ${formatMoney(593)} a month.`,
    );
    expect(part.label).toBe(`Pay ${formatMoney(10_040)}`);
    expect(prepayPreview(prepay({ ok: false, amount: 50_000, paysOff: false }), 'compliant', SAFE, 40_000, 100_000)).toMatchObject({ ok: false, text: `Loan 2 has ${formatMoney(40_000)} left.` });
    expect(prepayPreview(prepay({ ok: false }), 'compliant', SAFE, 40_000, 1_000)).toMatchObject({ ok: false, text: `That takes ${formatMoney(40_120)} of cash; you have ${formatMoney(1_000)}.` });
  });

  it('matches the sim’s prepay quote on a real loan', () => {
    const state = makeTradingState(40_000, 20_000);
    state.finance.cash = 1_000_000;
    expect(applyCommand(state, { type: 'takeTermLoan', amount: 60_000, termYears: 5 })).toMatchObject({ ok: true });
    const taken = state.debt.loans[0]!;
    state.day += 10;
    const quote = quotePrepay(state, taken.id, taken.balance);
    const view = prepayPreview(quote, 'compliant', covenantMetrics(state), taken.balance, state.finance.cash);
    expect(view.label).toBe(`Pay off for ${formatMoney(quote.total)}`);
    expect(view.text).toMatch(/you'd owe nothing/);
  });
});

describe('what happens if I slip?', () => {
  it('lists the ladder in plain steps and marks where the player is', () => {
    const ladder = slipLadder(health('good'));
    expect(ladder.map((s) => s.key)).toEqual(['warning', 'penalty', 'frozen', 'called', 'end']);
    expect(ladder.map((s) => s.name).slice(0, 3)).toEqual([HEALTH_WORD.warning, HEALTH_WORD.penalty, HEALTH_WORD.frozen]);
    expect(ladder.some((s) => s.current)).toBe(false);
    expect(slipLadder(health('watch')).some((s) => s.current)).toBe(false);
    for (const level of ['warning', 'penalty', 'frozen'] as const) {
      expect(slipLadder(health(level)).filter((s) => s.current).map((s) => s.key)).toEqual([level]);
    }
    expect(slipLadder(health('penalty', { called: true })).find((s) => s.current)!.key).toBe('called');
    expect(slipLadder(health('frozen', { noDebt: true })).some((s) => s.current)).toBe(false);
    expect(ladder.find((s) => s.key === 'penalty')!.text).toContain(`${plainRate(PENALTY_STEP_UP_BPS)} more`);
    expect(ladder.find((s) => s.key === 'called')!.text).toContain(plural(FROZEN_ACCELERATION_CLOSES, 'month'));
    expect(ladder.find((s) => s.key === 'end')!.text).toMatch(/the game ends/);
    for (const s of ladder) expect(s.text).not.toMatch(JARGON);
  });

  it('opens by itself whenever the health is not Good', () => {
    expect(slipOpenByDefault('good')).toBe(false);
    for (const level of ['watch', 'warning', 'penalty', 'frozen'] as const) expect(slipOpenByDefault(level)).toBe(true);
  });

  it('says the missed-payment rule and how to step back, with the progress', () => {
    expect(MISSED_PAYMENT_RULE).toBe("If you can't make a payment, borrowing stops at once and you pay a late fee.");
    expect(stepBackLine('compliant', 0)).toBe(`${COVENANT_CURE_CLOSES} ${stepBackText().slice(String(COVENANT_CURE_CLOSES).length + 1)}`);
    expect(stepBackLine('penalty', 1)).toContain(`You have 1 of ${COVENANT_CURE_CLOSES} so far.`);
  });
});

describe('no more borrowing: the sweep and the countdown', () => {
  const day = dayOf({ year: 2027, month: 6, day: 12 });
  const base = { lastSweep: null, nextSweep: 0, closesUntilCall: null, called: null, day, owed: 150_000, frozen: false };

  it('shows nothing while neither frozen with debt nor called', () => {
    expect(frozenView(base)).toBeNull();
    expect(frozenView({ ...base, frozen: true, owed: 0 })).toBeNull();
  });

  it('says the next and last sweep and the months until the bank asks for every loan back', () => {
    const view = frozenView({ ...base, frozen: true, nextSweep: 4_200, lastSweep: { amount: 3_900, close: 'May 2027' }, closesUntilCall: 4 })!;
    expect(view.items.map((i) => i.key)).toEqual(['sweep', 'last', 'countdown']);
    expect(view.items[0]!.text).toBe(`At the next month close (${formatDate(nextCloseDay(day))}) the bank takes about ${formatMoney(4_200)} of your spare cash to pay down what you owe.`);
    expect(view.items[1]!.text).toBe(`Last time it took ${formatMoney(3_900)}, at the May 2027 close.`);
    expect(view.items[2]!.text).toContain(`asks for every loan back in ${plural(4, 'month')} (at the ${formatDate(closeDayAfter(day, 4))} close)`);
    expect(view.tone).toBe(4 <= ACCELERATION_WARNING_CLOSES ? 'danger' : 'warn');
    expect(frozenView({ ...base, frozen: true, closesUntilCall: 0 })!.items.at(-1)!.text).toMatch(/at the next month close, the bank asks for every loan back/);
    expect(frozenView({ ...base, frozen: true, closesUntilCall: 1 })!.tone).toBe('danger');
    expect(frozenView({ ...base, frozen: true })!.items[0]!.text).toMatch(/none is expected at the next close/);
    for (const item of view.items) expect(item.text).not.toMatch(JARGON);
  });

  it('once called, says what falls due at each close left and that a missed one ends the game', () => {
    const view = frozenView({ ...base, frozen: true, called: [50_000, 50_000, 50_000] })!;
    expect(view.tone).toBe('danger');
    expect(view.items[0]!.text).toBe(`The bank has asked for every loan back: ${formatMoney(150_000)} in all, due over the next ${ACCELERATION_CLOSES} month closes.`);
    expect(view.items[1]!.text).toMatch(/the game ends/);
    expect(view.due).toEqual([1, 2, 3].map((k) => `${formatDate(closeDayAfter(day, k))}: about ${formatMoney(50_000)}`));
    expect(frozenView({ ...base, called: [150_000] })!.items[0]!.text).toContain('due at the next month close');
  });
});

describe('the next payment and the messages', () => {
  it('warns when the next payment is more than the cash projected at that close', () => {
    expect(paymentWarning(3_120, 2_000, LATER)).toBe(
      `Your next loan payment, about ${formatMoney(3_120)} on ${formatDate(nextCloseDay(LATER))}, is more than the cash you're expected to have then (about ${formatMoney(2_000)}).`,
    );
    expect(paymentWarning(3_120, 5_000, LATER)).toBe('');
    expect(paymentWarning(0, -5_000, LATER)).toBe('');
  });

  it('counts the bank’s messages and keeps the debt notices among them', () => {
    expect(messagesLabel(3)).toBe('Bank messages (3)');
    for (const kind of ['debtSwept', 'accelerationWarning', 'loansCalled', 'covenantWarning', 'paymentMissed'] as const) expect(isBankNotice(kind)).toBe(true);
    expect(isBankNotice('cabinetFull')).toBe(false);
  });
});

describe('effect words', () => {
  it('say over, near, again and nothing owed by stage', () => {
    expect(effectWords('compliant', SAFE, SAFE)).toEqual({ tone: 'ok', text: 'still Good' });
    expect(effectWords('compliant', NEAR, SAFE)).toEqual({ tone: 'ok', text: 'back to Good' });
    expect(effectWords('compliant', SAFE, NEAR).tone).toBe('warn');
    expect(effectWords('compliant', SAFE, OVER)).toEqual({ tone: 'danger', text: `this would put you over the bank's limit: ${overLimitConsequence('compliant')}` });
    expect(effectWords('warning', OVER, NEAR)).toEqual({ tone: 'warn', text: "you'd pass both checks again, but close to a limit" });
    expect(effectWords('frozen', OVER, NONE).text).toBe("you'd owe nothing, and the bank clears everything at the next month close");
    expect(overLimitConsequence('frozen')).toBe('the bank would stop lending at the next month close');
  });
});
