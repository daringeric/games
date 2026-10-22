// The Bank, round 4c/4d (spec H, "Bank C: health first"): the bank's health
// in one plain word and sentence (debt.bankHealth, worded by ui/health.ts),
// the verified cure with its button (debt.cureFor), the two checks as plain
// sentences with bars against the bank's limits, "Borrow more" with three
// amount chips, an "Other amount" field, a 5 or 7-year choice and a live
// preview in words, then "Pay back" and "Emergency cash" (the credit line),
// each opening in place, "What happens if I slip?" and the bank's messages.
// The rule for the first view: only the figures a player acts on, in plain
// words; every other figure is one tap away in a disclosure, where the
// bank's own words ("leverage", "coverage", "lending ARR", "×") appear next
// to their plain meaning, never on their own.
//
// Every figure comes from debt.ts (bankHealth, healthLevel, stageAfterClose,
// creditOffer, quoteDraw, quoteRepay, quoteTermLoan, maxSafeTermLoan,
// quotePrepay, cureFor, estimateNextDebtService, estimateSweep,
// closesUntilAcceleration, acceleratedSchedule) and finance.estimateCashAtClose;
// the panel only words and lays them out, and changes the game only through
// drawCredit / repayCredit / takeTermLoan / prepayLoan. The quote functions
// run only while the panel is open.
//
// The sheet is modal, but the clock keeps running behind it: main.ts calls
// update() every frame and the figures refresh in place on each new day or
// command, never rebuilding an input (focus and typed amounts survive).
//
// Owner: ui-bank workstream.

import {
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  ARR_SPIKE_CAP,
  ARR_TRAILING_MONTHS,
  BANK_PREFILL_HEADROOM,
  BANK_WATCH_HEADROOM,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_TARGET,
  CREDIT_LIMIT_ARR_MULTIPLE,
  DRAW_PRESETS,
  FROZEN_ACCELERATION_CLOSES,
  LOAN_ROUNDING,
  PENALTY_STEP_UP_BPS,
  TERM_CAPACITY_ARR_MULTIPLE,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  UNDERWRITING_MIN_MARGIN,
} from '../sim/balance';
import { dateOf, dayOf, formatDate, formatMonth } from '../sim/calendar';
import {
  acceleratedSchedule,
  bankHealth,
  closesUntilAcceleration,
  covenantsWithin,
  creditOffer,
  cureFor,
  estimateNextDebtService,
  estimateSweep,
  finalPayment,
  repayAllCure,
  healthLevel,
  maxSafeTermLoan,
  quoteDraw,
  quotePrepay,
  quoteRepay,
  quoteTermLoan,
  repayAllCommands,
  stageAfterClose,
  termCapacity,
  totalDebt,
} from '../sim/debt';
import { estimateCashAtClose } from '../sim/finance';
import type {
  BankHealth,
  BankHealthLevel,
  Command,
  CovenantMetrics,
  CovenantStage,
  CreditOffer,
  CureOption,
  DebtStats,
  DrawQuote,
  GameState,
  LoanId,
  Notice,
  NoticeKind,
  PrepayQuote,
  RateBreakdown,
  RepayQuote,
  TermLoan,
  TermLoanQuote,
  TermYears,
} from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el, setText } from './dom';
import { formatBpsDelta, formatMoney, formatPercent, formatRatio, plural } from './format';
import { CALLED_WORD, HEALTH_ICON, HEALTH_TONE, HEALTH_WORD, healthSentence, healthTitleOf, healthWordOf, stepBackText } from './health';
import type { HealthTone } from './health';
import { noticeTone } from './overlays';
import type { Toasts, ToastTone } from './overlays';
import { parseNumberField } from './pricingPanel';
import type { GameSession } from './session';

// ---------------------------------------------------------------------------
// The old stage words (the month summary and the advisor may still name a stage)
// ---------------------------------------------------------------------------

export type BankTone = 'ok' | 'warn' | 'danger';

export const STAGE_LABEL: Readonly<Record<CovenantStage, string>> = {
  compliant: 'Compliant',
  warning: 'Warning',
  penalty: 'Penalty rate',
  frozen: 'Frozen',
};

export const STAGE_TONE: Readonly<Record<CovenantStage, BankTone>> = {
  compliant: 'ok',
  warning: 'warn',
  penalty: 'warn',
  frozen: 'danger',
};

/** Label of the covenant badge while the stage is compliant but today's figures break a covenant (the Bank now says "Watch"). */
export const AT_RISK_LABEL = 'At risk';

// ---------------------------------------------------------------------------
// Plain numbers
// ---------------------------------------------------------------------------

/** "0.5×", "3×": a multiple of lending ARR (the rate card and the disclosures). */
export function formatMultiple(x: number): string {
  return `${Math.round(x * 100) / 100}×`;
}

/** Up to two decimals, trailing zeros dropped: 5 -> "5", 4.5 -> "4.5", 3.456 -> "3.46". */
export function trimNumber(x: number): string {
  return String(Math.round(x * 100) / 100);
}

/** A yearly rate in basis points, plainly: 640 -> "6.4%", 725 -> "7.25%", 600 -> "6%". */
export function plainRate(bps: number): string {
  return `${trimNumber(Math.round(bps) / 100)}%`;
}

/** Dollars earned per $1 of loan payments: 1.54 -> "$1.54", -0.3 -> "-$0.30". */
export function perDollar(x: number): string {
  const cents = Math.round(x * 100);
  const abs = Math.abs(cents);
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/**
 * The bank's first check in plain words: "3.4 years of profit". One decimal,
 * two where one would hide which side of the limit it is on (5.04 is over a
 * limit of 5: "5.04 years", never "5 years"); "under 0.1 years" for a sliver.
 */
export function yearsOfProfit(leverage: number): string {
  let value = Math.round(leverage * 10) / 10;
  if (leverage > COVENANT_MAX_LEVERAGE !== value > COVENANT_MAX_LEVERAGE) value = Math.round(leverage * 100) / 100;
  if (value === 0 && leverage > 0) return 'under 0.1 years of profit';
  return `${trimNumber(value)} ${value === 1 ? 'year' : 'years'} of profit`;
}

/** Leverage as the bank sees it, for the disclosures: "not measurable" when there is debt and no cash flow to measure it against. */
export function formatLeverage(leverage: number | null): string {
  return leverage === null ? 'not measurable' : formatRatio(leverage);
}

// ---------------------------------------------------------------------------
// Health status and the cure
// ---------------------------------------------------------------------------

export interface HealthView {
  level: BankHealthLevel;
  word: string;
  /** "Bank health: Good" */
  title: string;
  sentence: string;
  tone: HealthTone;
  icon: (typeof HEALTH_ICON)[BankHealthLevel];
}

export function healthView(health: BankHealth): HealthView {
  // Once the bank has asked for every loan back the title says so, whatever the stage (as the HUD chip and the month summary do).
  return {
    level: health.level,
    word: healthWordOf(health),
    title: healthTitleOf(health),
    sentence: healthSentence(health),
    tone: health.called ? 'danger' : HEALTH_TONE[health.level],
    icon: health.called ? HEALTH_ICON.frozen : HEALTH_ICON[health.level],
  };
}

/**
 * The verified cure (debt.cureFor) in plain words, or '' for none (no debt,
 * the checks pass today, or the loans are called and cash cannot repay them
 * all). `called`: the bank has asked for every loan back; a cure short of
 * repaying everything then lifts the freeze but not the call.
 */
export function cureAdvice(option: CureOption | null | undefined, called = false): string {
  if (!option) return '';
  const stands = called && option.kind !== 'repayAll' ? ' The bank still wants every loan back on schedule.' : '';
  const leaves = ` That leaves ${formatMoney(option.cashAfter)} in cash.`;
  switch (option.kind) {
    case 'repayCredit':
      return `To pass both checks again, pay back ${formatMoney(option.amount)} of emergency cash.${leaves}${stands}`;
    case 'prepayLoan':
      return `To pass both checks again, pay ${formatMoney(option.amount)} off loan ${option.loan ?? ''} early.${leaves}${stands}`;
    case 'repayAll':
      return `To clear things with the bank, pay back everything you owe (${formatMoney(option.amount)}): with no debt it clears everything at the next month close.${leaves}`;
    case 'grow':
      return `No repayment fixes it: you'd need about ${formatMoney(option.amount)} a year more profit to pass both checks.${stands}`;
  }
}

export interface CureAction {
  /** "Pay back $42,000" */
  label: string;
  /** The toast once done: "Paid back $42,000 of emergency cash". */
  done: string;
  /** What the button sends, in order. */
  commands: Command[];
}

/** The cure's button: the commands that make it (none for growth, which no command makes). */
export function cureAction(option: CureOption | null | undefined, state: GameState): CureAction | null {
  if (!option) return null;
  switch (option.kind) {
    case 'repayCredit':
      return {
        label: `Pay back ${formatMoney(option.amount)}`,
        done: `Paid back ${formatMoney(option.amount)} of emergency cash`,
        commands: [{ type: 'repayCredit', amount: option.amount }],
      };
    case 'prepayLoan':
      return option.loan === null
        ? null
        : {
            label: `Pay ${formatMoney(option.amount)} off loan ${option.loan}`,
            done: `Paid ${formatMoney(option.amount)} off loan ${option.loan}`,
            commands: [{ type: 'prepayLoan', loan: option.loan, amount: option.amount }],
          };
    case 'repayAll':
      return { label: 'Pay back everything', done: `Paid back everything you owed (${formatMoney(option.amount)})`, commands: repayAllCommands(state) };
    case 'grow':
      return null;
  }
}

/**
 * Off a good standing but passing both checks today: how it steps back
 * ("You pass both checks today. 2 good month closes in a row move you back
 * one step (1 of 2 so far)."), or that the bank clears everything when
 * nothing is owed; '' in good standing or while a check fails.
 */
export function recoveringLine(stage: CovenantStage, compliantCloses: number, passingToday: boolean, owed: number, called = false): string {
  if (stage === 'compliant' || !passingToday || called) return '';
  if (owed <= 0) return '';
  const progress = compliantCloses > 0 ? ` (${compliantCloses} of ${COVENANT_CURE_CLOSES} so far)` : '';
  return `You pass both checks today. ${plural(COVENANT_CURE_CLOSES, 'good month close')} in a row move you back one step${progress}.`;
}

// ---------------------------------------------------------------------------
// The two checks
// ---------------------------------------------------------------------------

/** The debt bar runs from 0 to this many years of profit (6 for a limit of 5). */
export const DEBT_BAR_MAX = Math.max(6, Math.ceil(COVENANT_MAX_LEVERAGE * 1.2));
/** The earnings bar runs from $0 to this per $1 of loan payments ($2.50 for a minimum of $1.20). */
export const COVERAGE_BAR_MAX = Math.max(2.5, Math.ceil(COVENANT_MIN_COVERAGE * 4) / 2);

export type CheckStatus = 'pass' | 'near' | 'over' | 'none';

export interface TextPart {
  text: string;
  strong?: boolean;
}

export interface CheckView {
  key: 'debt' | 'coverage';
  /** The sentence, with the figure to bold. */
  parts: TextPart[];
  sentence: string;
  status: CheckStatus;
  /** "Passed", "Close to the limit", "Over the bank's limit", "Not needed" (words beside the color). */
  statusText: string;
  /** Share of the bar filled, 0..1. */
  fill: number;
  /** Where the limit marker sits, 0..1. */
  marker: number;
  markerLabel: string;
  scaleStart: string;
  scaleEnd: string;
  /** The bar for a screen reader. */
  barLabel: string;
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function check(key: CheckView['key'], parts: TextPart[], status: CheckStatus, statusText: string, fill: number, extra: Omit<CheckView, 'key' | 'parts' | 'sentence' | 'status' | 'statusText' | 'fill'>): CheckView {
  return { key, parts, sentence: parts.map((p) => p.text).join(''), status, statusText, fill: clamp01(fill), ...extra };
}

/** "Your debt is 3.4 years of profit. The bank's limit is 5." on a 0..DEBT_BAR_MAX bar. */
export function debtCheck(m: CovenantMetrics): CheckView {
  const limit = trimNumber(COVENANT_MAX_LEVERAGE);
  const scale = {
    marker: COVENANT_MAX_LEVERAGE / DEBT_BAR_MAX,
    markerLabel: `limit ${limit}`,
    scaleStart: '0 years',
    scaleEnd: `${trimNumber(DEBT_BAR_MAX)} years`,
  };
  if (m.totalDebt <= 0) {
    return check('debt', [{ text: 'You owe nothing, so this check passes.' }], 'none', 'Passed', 0, { ...scale, barLabel: `No debt. The bank's limit is ${limit} years of profit.` });
  }
  if (m.leverage === null) {
    return check(
      'debt',
      [{ text: 'You have no profit yet to measure your debt against.' }, { text: ` The bank's limit is ${limit} years of profit.` }],
      'over',
      "Over the bank's limit",
      1,
      { ...scale, barLabel: `Debt can't be measured against profit: over the limit of ${limit} years.` },
    );
  }
  const years = yearsOfProfit(m.leverage);
  const status: CheckStatus = !m.leverageOk ? 'over' : m.leverage > COVENANT_MAX_LEVERAGE * (1 - BANK_WATCH_HEADROOM) ? 'near' : 'pass';
  const statusText = status === 'over' ? "Over the bank's limit" : status === 'near' ? 'Close to the limit' : 'Passed';
  return check('debt', [{ text: 'Your debt is ' }, { text: years, strong: true }, { text: `. The bank's limit is ${limit}.` }], status, statusText, m.leverage / DEBT_BAR_MAX, {
    ...scale,
    barLabel: `${years}, on a scale to ${trimNumber(DEBT_BAR_MAX)} years. The limit is ${limit}. ${statusText}.`,
  });
}

/** "You earn $1.54 for every $1 of loan payments. The bank wants at least $1.20." on a $0..COVERAGE_BAR_MAX bar. */
export function coverageCheck(m: CovenantMetrics): CheckView {
  const min = perDollar(COVENANT_MIN_COVERAGE);
  const scale = {
    marker: COVENANT_MIN_COVERAGE / COVERAGE_BAR_MAX,
    markerLabel: `at least ${min}`,
    scaleStart: '$0',
    scaleEnd: perDollar(COVERAGE_BAR_MAX),
  };
  if (m.coverage === null || m.annualDebtService <= 0) {
    return check('coverage', [{ text: 'No loan payments yet.' }], 'none', 'Not needed', 0, { ...scale, barLabel: `No loan payments. The bank wants at least ${min} for every $1 of them.` });
  }
  if (m.coverage <= 0) {
    return check(
      'coverage',
      [{ text: "You don't earn enough yet to make your loan payments." }, { text: ` The bank wants at least ${min} for every $1.` }],
      'over',
      "Under the bank's minimum",
      0,
      { ...scale, barLabel: `Nothing earned toward the loan payments. The minimum is ${min}. Under the bank's minimum.` },
    );
  }
  const earn = `${perDollar(m.coverage)} for every $1`;
  const status: CheckStatus = !m.coverageOk ? 'over' : m.coverage < COVENANT_MIN_COVERAGE * (1 + BANK_WATCH_HEADROOM) ? 'near' : 'pass';
  const statusText = status === 'over' ? "Under the bank's minimum" : status === 'near' ? 'Close to the minimum' : 'Passed';
  return check('coverage', [{ text: 'You earn ' }, { text: earn, strong: true }, { text: ` of loan payments. The bank wants at least ${min}.` }], status, statusText, m.coverage / COVERAGE_BAR_MAX, {
    ...scale,
    barLabel: `${earn} of loan payments, on a scale to ${perDollar(COVERAGE_BAR_MAX)}. The minimum is ${min}. ${statusText}.`,
  });
}

// ---------------------------------------------------------------------------
// What a change would do to the bank's health, in words
// ---------------------------------------------------------------------------

export type PreviewTone = 'ok' | 'warn' | 'danger';

export interface Preview {
  tone: PreviewTone;
  text: string;
}

/** What going over a limit leads to at the next close, from this stage (debt.stageAfterClose). */
export function overLimitConsequence(stage: CovenantStage): string {
  switch (stageAfterClose(stage, false)) {
    case 'warning':
      return "you'd get a warning at the next month close";
    case 'penalty':
      return 'your interest would go up at the next month close';
    case 'frozen':
    case 'compliant':
      return 'the bank would stop lending at the next month close';
  }
}

/**
 * What figures `after` (a quote's) would mean against today's `before`, in a
 * few words: "still Good", "Watch. You'd be close to the bank's limit",
 * "this would put you over the bank's limit: you'd get a warning at the next
 * month close", "you'd pass both checks again", "you'd owe nothing".
 */
export function effectWords(stage: CovenantStage, before: CovenantMetrics, after: CovenantMetrics): Preview {
  if (!after.compliant) {
    return before.compliant
      ? { tone: 'danger', text: `this would put you over the bank's limit: ${overLimitConsequence(stage)}` }
      : { tone: 'danger', text: `you'd still be over the bank's limit: ${overLimitConsequence(stage)}` };
  }
  if (after.totalDebt <= 0) {
    return { tone: 'ok', text: stage === 'compliant' ? "you'd owe nothing" : "you'd owe nothing, and the bank clears everything at the next month close" };
  }
  const near = !covenantsWithin(after, BANK_WATCH_HEADROOM);
  if (!before.compliant) return near ? { tone: 'warn', text: "you'd pass both checks again, but close to a limit" } : { tone: 'ok', text: "you'd pass both checks again" };
  if (stage !== 'compliant') return near ? { tone: 'warn', text: "you'd still pass both checks, but close to a limit" } : { tone: 'ok', text: "you'd still pass both checks" };
  const was = healthLevel(stage, before, before.totalDebt > 0);
  const now = healthLevel(stage, after, true);
  if (near) return { tone: 'warn', text: `${was === 'watch' ? 'still ' : ''}${HEALTH_WORD.watch}. You'd be close to the bank's limit` };
  return { tone: 'ok', text: was === now ? `still ${HEALTH_WORD[now]}` : `back to ${HEALTH_WORD[now]}` };
}

/** "Debt becomes 3.8 years of profit, you'd earn $1.37 per $1." for pro forma figures. */
export function afterFigures(after: CovenantMetrics): string {
  if (after.totalDebt <= 0) return '';
  const debt = after.leverage === null ? "Your debt couldn't be measured against your profit" : `Debt becomes ${yearsOfProfit(after.leverage)}`;
  const earn =
    after.coverage === null ? '' : after.coverage <= 0 ? ", and you wouldn't earn enough to make the loan payments" : `, you'd earn ${perDollar(after.coverage)} per $1`;
  return `${debt}${earn}.`;
}

/** The problem with a typed amount, or '' when there is none ("Enter an amount in whole dollars."). */
function amountProblem(amount: number, min: number, max: number, overMax: string): string {
  if (!Number.isInteger(amount) || amount < 1) return 'Enter an amount in whole dollars.';
  if (amount < min) return `The smallest loan is ${formatMoney(min)}.`;
  if (amount > max) return overMax;
  return '';
}

// ---------------------------------------------------------------------------
// Borrow more
// ---------------------------------------------------------------------------

export interface AmountChip {
  amount: number;
  /** "$25,000" */
  label: string;
  share: 'third' | 'twoThirds' | 'safe';
}

/**
 * The amount chips (spec H.4): about a third, about two thirds and all of
 * the largest safe amount (the builder's start, prefillTermAmount), each
 * rounded down to LOAN_ROUNDING, duplicates dropped, none below
 * TERM_LOAN_MIN; none at all when nothing is safe.
 */
export function borrowChips(safeAmount: number): AmountChip[] {
  const round = (x: number) => Math.floor(x / LOAN_ROUNDING) * LOAN_ROUNDING;
  const candidates: AmountChip['share'][] = ['third', 'twoThirds', 'safe'];
  const amounts = [round(safeAmount / 3), round((safeAmount * 2) / 3), round(safeAmount)];
  const out: AmountChip[] = [];
  candidates.forEach((share, i) => {
    const amount = amounts[i] ?? 0;
    if (amount < TERM_LOAN_MIN || out.some((c) => c.amount === amount)) return;
    out.push({ amount, label: formatMoney(amount), share });
  });
  return out;
}

/**
 * Where the builder starts, given the largest loan it may start at:
 * that amount, or TERM_LOAN_MIN when there is none (the preview then says
 * it would put the player over a limit).
 */
export function defaultTermAmount(safeMaxAmount: number): number {
  return safeMaxAmount >= TERM_LOAN_MIN ? safeMaxAmount : TERM_LOAN_MIN;
}

/**
 * The builder's starting amount for `termYears`: the largest loan that leaves
 * the checks BANK_PREFILL_HEADROOM inside their limits (debt.maxSafeTermLoan
 * with that headroom), so the default is never right on a limit; TERM_LOAN_MIN
 * when even that is 0. The largest chip is this amount.
 */
export function prefillTermAmount(state: GameState, termYears: TermYears): number {
  return defaultTermAmount(maxSafeTermLoan(state, termYears, BANK_PREFILL_HEADROOM));
}

/**
 * Why nothing can be borrowed, in one plain sentence, or '' when something
 * can (`maxAmount` > 0, the quote's or debt.termCapacity).
 */
export function borrowBlocked(maxAmount: number, health: Pick<BankHealth, 'level' | 'called' | 'metrics'>): string {
  if (maxAmount > 0) return '';
  if (health.called) return "The bank has asked for every loan back, so it won't lend more until it's all repaid.";
  if (health.level === 'frozen') return "No more borrowing for now: the bank won't lend again until it moves you back a step.";
  if (health.metrics.arr <= 0) return 'The bank lends once customers are paying you: sign up customers first.';
  return `You've borrowed all the bank will lend against your bills for now (the smallest loan is ${formatMoney(TERM_LOAN_MIN)}).`;
}

/**
 * The live line under the chips: "If you borrow $50,000: still Good. Debt
 * becomes 3.8 years of profit, you'd earn $1.37 per $1. $976 a month for 5
 * years at 6.4%." Danger words when the loan would put the player over a
 * limit (and what the next close would then bring), warn words near one, a
 * plain problem for an amount the bank won't lend; null when nothing can be
 * borrowed (borrowBlocked says why).
 */
export function borrowPreview(quote: TermLoanQuote, stage: CovenantStage): Preview | null {
  if (quote.maxAmount <= 0) return null;
  const problem = amountProblem(quote.amount, TERM_LOAN_MIN, quote.maxAmount, `The most the bank will lend now is ${formatMoney(quote.maxAmount)}.`);
  if (problem) return { tone: 'warn', text: problem };
  if (!quote.ok || quote.payment <= 0) return { tone: 'warn', text: quote.reasons[0] ?? 'The bank cannot lend that now.' };
  const effect = effectWords(stage, quote.before, quote.after);
  const penalty = quote.rate.penaltyBps > 0 ? ', with the higher interest while it lasts' : '';
  const cost = `${formatMoney(quote.payment)} a month for ${quote.termYears} years at ${plainRate(quote.rate.effectiveRateBps)}${penalty}.`;
  return { tone: effect.tone, text: `If you borrow ${formatMoney(quote.amount)}: ${effect.text}. ${afterFigures(quote.after)} ${cost}` };
}

/** "Loan 1, taken this month, would go from 6.5% to 7.25%: $1,200 to $1,265 a month. ..." for each same-month loan the quote re-prices. */
export function repricedLines(repriced: TermLoanQuote['repriced']): string[] {
  return repriced.map(
    (r) =>
      `Loan ${r.loan}, taken this month, would go from ${plainRate(r.rateBps)} to ${plainRate(r.rateBpsAfter)}: ` +
      `${formatMoney(r.payment)} to ${formatMoney(r.paymentAfter)} a month. Loans taken in the same month share one rate.`,
  );
}

/**
 * The builder's line about the safe amount, for "How the rate is set": the
 * exact largest amount that still passes both checks (the largest chip stops
 * BANK_PREFILL_HEADROOM inside it), or why there is none; '' when nothing can
 * be borrowed.
 */
export function safeAmountLine(safeMaxAmount: number, maxAmount: number, years: TermYears): string {
  if (maxAmount <= 0) return '';
  if (safeMaxAmount >= TERM_LOAN_MIN) {
    const all = safeMaxAmount >= maxAmount ? ', all the bank will lend' : '';
    return `The most you can borrow over ${years} years and still pass both checks: ${formatMoney(safeMaxAmount)}${all}.`;
  }
  return `No ${years}-year loan passes both checks at today's figures: even the smallest, ${formatMoney(TERM_LOAN_MIN)}, would put you over a limit at the next month close.`;
}

/** "The largest amount button stops 15% inside the limits ($X)." when it is below the exact safe maximum; '' otherwise. */
export function prefillLine(prefill: number, safeMaxAmount: number): string {
  if (prefill < TERM_LOAN_MIN || safeMaxAmount < TERM_LOAN_MIN || prefill >= safeMaxAmount) return '';
  return `The largest amount button, ${formatMoney(prefill)}, stops ${formatPercent(BANK_PREFILL_HEADROOM)} inside the bank's limits to leave you room.`;
}

/** Everything else about a loan, one tap away in "How the rate is set". */
export function termDetailLines(quote: TermLoanQuote, prefill: number): string[] {
  if (quote.maxAmount <= 0) return [];
  const lines = [
    safeAmountLine(quote.safeMaxAmount, quote.maxAmount, quote.termYears),
    prefillLine(prefill, quote.safeMaxAmount),
    `The most the bank will lend now: ${formatMoney(quote.maxAmount)} (${formatMultiple(TERM_CAPACITY_ARR_MULTIPLE)} your yearly bills as it counts them, its "lending ARR", less the loans you have).`,
  ];
  if (quote.ok && quote.payment > 0) {
    const last = quote.lastPayment !== quote.payment ? ` The last payment is ${formatMoney(quote.lastPayment)}.` : '';
    const penalty = quote.rate.penaltyBps > 0 ? ' Total interest counts the higher interest for the whole loan, as if it lasted.' : '';
    lines.push(
      `For ${formatMoney(quote.amount)}: ${formatMoney(quote.stubInterest)} of interest at this month's close (for the days left this month), ` +
        `then ${formatMoney(quote.payment)} a month.${last} Total interest ${formatMoney(quote.totalInterest)}.${penalty} Cash after: ${formatMoney(quote.cashAfter)}.`,
    );
  }
  return lines.filter((l) => l !== '');
}

// ---------------------------------------------------------------------------
// The rate's parts ("How the rate is set")
// ---------------------------------------------------------------------------

/** "Jun 2027": the close that priced the line (null before the first close); "Aug 1, 2027": the next close, which re-prices it. */
export interface LinePricing {
  close: string | null;
  next: string;
}

export interface RateRowView {
  key: 'base' | 'leverage' | 'cpp' | 'product' | 'penalty';
  label: string;
  value: string;
  /** Small print under the row. */
  note: string;
}

/** The plain line under the cost-per-passing spread. `when` dates a figure that is not today's ("at the Jun 2027 close"). */
export function cppLine(rate: Pick<RateBreakdown, 'cpp' | 'cppBand' | 'cppBps'>, when?: string): string {
  const spread = rate.cppBps > 0 ? formatBpsDelta(rate.cppBps) : 'no CPP spread';
  if (rate.cpp === null || rate.cppBand === null) return when ? `Nothing passed ${when}: no CPP spread` : 'Nothing passed yet: no CPP spread';
  const cpp = `${formatMoney(rate.cpp)}${when ? ` ${when}` : ''}`;
  switch (rate.cppBand) {
    case 'green':
      return `Cost per passing ${cpp} is ${Math.round(rate.cpp) < CPP_TARGET ? 'under' : 'on'} target: ${spread}`;
    case 'amber':
      return `Cost per passing ${cpp} is over target (amber): ${spread}`;
    case 'red':
      return `Cost per passing ${cpp} is far over target (red): ${spread}`;
  }
}

/** The leverage the leverage spread was priced on, in words; `when` dates it ("at the Jun 2027 close"). */
export function leverageNote(leverage: number | null, when?: string): string {
  if (leverage === null) return `leverage not measurable${when ? ` ${when}` : ''}: the top spread`;
  if (leverage === 0) return when ? `no debt ${when}` : 'no debt yet';
  return `at ${formatRatio(leverage)} leverage${when ? ` ${when}` : ''}`;
}

/**
 * The rate's parts, in order, each with its plain name and the bank's; the
 * penalty only while it applies. A term quote is priced on today's figures;
 * the credit line on the last close's (`pricing`), and its notes say so.
 */
export function rateRows(rate: RateBreakdown, product: { kind: 'line' } | { kind: 'term'; years: TermYears }, pricing?: LinePricing): RateRowView[] {
  const when = product.kind === 'line' && pricing?.close ? `at the ${pricing.close} close` : undefined;
  const floats =
    pricing === undefined
      ? 'take and repay any time; the rate floats'
      : `take and repay any time; the rate floats: re-priced at every month close, next on ${pricing.next}`;
  const rows: RateRowView[] = [
    { key: 'base', label: 'Base rate', value: plainRate(rate.baseBps), note: 'what every loan starts from' },
    { key: 'leverage', label: 'For how much you owe (leverage)', value: formatBpsDelta(rate.leverageBps), note: leverageNote(rate.leverage, when) },
    { key: 'cpp', label: 'For your building cost per home (cost per passing)', value: formatBpsDelta(rate.cppBps), note: cppLine(rate, when) },
    product.kind === 'line'
      ? { key: 'product', label: 'For emergency cash (line premium)', value: formatBpsDelta(rate.productBps), note: floats }
      : { key: 'product', label: `For a ${product.years}-year loan (term premium)`, value: formatBpsDelta(rate.productBps), note: `${product.years}-year term, fixed for its life` },
  ];
  if (rate.penaltyBps > 0) {
    rows.push({ key: 'penalty', label: 'Higher interest (penalty)', value: formatBpsDelta(rate.penaltyBps), note: "on every balance until you're back in good standing" });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Emergency cash (the credit line)
// ---------------------------------------------------------------------------

export interface Preset {
  label: string;
  amount: number;
  /** The amount can't be used now (0, or more than allowed). */
  disabled: boolean;
}

/** Fixed presets (balance.DRAW_PRESETS, whole dollars), then half and all of what is available. */
export function drawPresets(available: number): Preset[] {
  const half = Math.floor(available / 2);
  return [
    ...DRAW_PRESETS.map((amount) => ({ label: formatMoney(amount), amount, disabled: amount > available })),
    { label: 'Half', amount: half, disabled: half < 1 },
    { label: 'All', amount: available, disabled: available < 1 },
  ];
}

/** Pay back half of the balance or all of it, never more than maxRepay (cash on hand). */
export function repayPresets(offer: Pick<CreditOffer, 'balance' | 'maxRepay'>): Preset[] {
  const half = Math.min(offer.maxRepay, Math.ceil(offer.balance / 2));
  return [
    { label: 'Half', amount: half, disabled: half < 1 },
    { label: 'All', amount: offer.maxRepay, disabled: offer.maxRepay < 1 },
  ];
}

export interface CreditView {
  /** "Borrow and repay any time, up to $60,000. Using now: $12,000." ('' before there is any). */
  summary: string;
  /** "It costs 8.25% a year on what you use, charged at each month close." */
  rate: string;
  canDraw: boolean;
  /** Why nothing can be taken now, or ''. */
  why: string;
  canRepay: boolean;
  /** "You're using $12,000 of emergency cash." ('' with nothing used). */
  using: string;
  /** Why the balance can't be paid back now (no cash), or ''. */
  repayWhy: string;
}

export function creditView(offer: CreditOffer, health: Pick<BankHealth, 'level' | 'called'>): CreditView {
  let why = '';
  if (offer.available <= 0) {
    if (health.called) why = "The bank has asked for every loan back, so no more emergency cash until it's all repaid.";
    else if (offer.frozen) why = 'No emergency cash while the bank has stopped lending. You can still pay it back.';
    else if (offer.limit <= 0) why = 'No emergency cash yet: the bank sets it from the bills your customers pay, so sign up customers first.';
    else why = offer.balance > offer.limit ? `You're using more than the ${formatMoney(offer.limit)} it allows now: pay some back to take more.` : `You're using all ${formatMoney(offer.limit)} of it.`;
  }
  return {
    summary: offer.limit > 0 || offer.balance > 0 ? `Borrow and repay any time, up to ${formatMoney(offer.limit)}. Using now: ${formatMoney(offer.balance)}.` : '',
    rate: `It costs ${plainRate(offer.rate.effectiveRateBps)} a year on what you use, charged at each month close.`,
    canDraw: offer.available > 0,
    why,
    canRepay: offer.balance > 0 && offer.maxRepay > 0,
    using: offer.balance > 0 ? `You're using ${formatMoney(offer.balance)} of emergency cash.` : '',
    repayWhy: offer.balance > 0 && offer.maxRepay <= 0 ? 'No cash to pay it back with right now.' : '',
  };
}

/** "Limit 0.5× your lending ARR (...)": where the limit comes from, for the line's rate disclosure. */
export function creditLimitNote(offer: Pick<CreditOffer, 'limit' | 'arr'>): string {
  if (offer.limit <= 0) return '';
  return `The limit is ${formatMultiple(CREDIT_LIMIT_ARR_MULTIPLE)} your yearly bills as the bank counts them (lending ARR, ${formatMoney(offer.arr)} a year), set again at each month close.`;
}

/**
 * The preview under the emergency-cash amount: "If you take $20,000: still
 * Good. Debt becomes ..., you'd earn ... per $1. About $85 of interest if
 * you keep it to the month end." or the problem with the amount.
 */
export function drawPreview(quote: DrawQuote, stage: CovenantStage, available: number): Preview {
  if (!Number.isInteger(quote.amount) || quote.amount < 1) return { tone: 'warn', text: 'Enter an amount in whole dollars.' };
  if (!quote.ok) {
    if (available > 0 && quote.amount > available) return { tone: 'warn', text: `You can take up to ${formatMoney(available)} now.` };
    return { tone: 'warn', text: quote.reasons[0] ?? "The bank won't lend that now." };
  }
  const effect = effectWords(stage, quote.before, quote.after);
  return {
    tone: effect.tone,
    text: `If you take ${formatMoney(quote.amount)}: ${effect.text}. ${afterFigures(quote.after)} About ${formatMoney(quote.interestToClose)} of interest if you keep it to the month end.`,
  };
}

/** The preview under the pay-back amount: what paying back `quote.amount` of emergency cash would do, or the problem with it. */
export function repayPreview(quote: RepayQuote, stage: CovenantStage, offer: Pick<CreditOffer, 'balance' | 'maxRepay'>): Preview {
  if (!Number.isInteger(quote.amount) || quote.amount < 1) return { tone: 'warn', text: 'Enter an amount in whole dollars.' };
  if (!quote.ok) {
    if (offer.balance <= 0) return { tone: 'warn', text: 'You have no emergency cash to pay back.' };
    if (quote.amount > offer.balance) return { tone: 'warn', text: `You're using ${formatMoney(offer.balance)}: that's the most you can pay back.` };
    return { tone: 'warn', text: `You can pay back up to ${formatMoney(offer.maxRepay)} with the cash you have.` };
  }
  const effect = effectWords(stage, quote.before, quote.after);
  const figures = afterFigures(quote.after);
  return { tone: effect.tone, text: `If you pay back ${formatMoney(quote.amount)}: ${effect.text}.${figures ? ` ${figures}` : ''} Leaves ${formatMoney(quote.cashAfter)} in cash.` };
}

// ---------------------------------------------------------------------------
// Pay back: the loans
// ---------------------------------------------------------------------------

export interface LoanRowView {
  id: LoanId;
  /** "Loan 1" */
  title: string;
  /** "$40,000" */
  balance: string;
  /** " left · $790 a month · 51 months left": the line after the balance. */
  rest: string;
  /** "Loan 1: $40,000 left · $790 a month · 51 months left" */
  line: string;
  /** The small print: its term and rate, a first interest-only payment, the last payment, the higher interest. */
  note: string;
}

/** True in the month a loan was taken: that close charges only interest for the days it was held. */
export function inFirstMonth(loan: Pick<TermLoan, 'originatedDay'>, day: number): boolean {
  const taken = dateOf(loan.originatedDay);
  const now = dateOf(day);
  return taken.year === now.year && taken.month === now.month;
}

/**
 * A loan as one row. `lastPayment`: what the final payment will be at today's
 * rate (debt.finalPayment); named when it differs from the level payment, and
 * the payment itself when only one is left.
 */
export function loanRow(loan: TermLoan, day: number, penaltyBps: number, lastPayment: number = loan.payment): LoanRowView {
  const first = inFirstMonth(loan, day);
  const lastOnly = !first && loan.monthsLeft <= 1;
  const title = `Loan ${loan.id}`;
  const balance = formatMoney(loan.balance);
  const rest = lastOnly
    ? ` left · last payment ${formatMoney(lastPayment)}`
    : ` left · ${formatMoney(loan.payment)} a month · ${plural(loan.monthsLeft, 'month')} left`;
  const notes = [`${loan.termMonths / 12}-year loan at ${plainRate(loan.rateBps)}.`];
  if (first) notes.push("This month's payment is interest only, for the days since you took it.");
  if (!lastOnly && loan.monthsLeft > 1 && lastPayment !== loan.payment) notes.push(`The last payment will be ${formatMoney(lastPayment)}.`);
  if (penaltyBps > 0) notes.push(`The payment includes the higher interest (${formatBpsDelta(penaltyBps)}) while it lasts.`);
  return { id: loan.id, title, balance, rest, line: `${title}: ${balance}${rest}`, note: notes.join(' ') };
}

export interface PrepayPreview extends Preview {
  ok: boolean;
  /** The confirm button: "Pay off for $40,120", "Pay $10,040". */
  label: string;
}

/**
 * Paying a loan off early (or part of it): what it takes and what it does to
 * the bank's health ("If you pay it off: still Good. It takes $40,120 of
 * cash, with $120 of interest so far."), or the problem with the amount.
 * `before`: today's figures; `balance`: the loan's; `cash`: on hand.
 */
export function prepayPreview(quote: PrepayQuote, stage: CovenantStage, before: CovenantMetrics, balance: number, cash: number): PrepayPreview {
  const fail = (text: string): PrepayPreview => ({ ok: false, tone: 'warn', text, label: 'Pay' });
  if (!Number.isInteger(quote.amount) || quote.amount < 1) return fail('Enter an amount in whole dollars.');
  if (!quote.ok) {
    if (quote.amount > balance) return fail(`Loan ${quote.loan} has ${formatMoney(balance)} left.`);
    if (cash < quote.total) return fail(`That takes ${formatMoney(quote.total)} of cash; you have ${formatMoney(cash)}.`);
    return fail(quote.reasons[0] ?? "That can't be paid now.");
  }
  const effect = effectWords(stage, before, quote.after);
  const interest = quote.accruedInterest > 0 ? `, with ${formatMoney(quote.accruedInterest)} of interest so far` : '';
  if (quote.paysOff) {
    return { ok: true, tone: effect.tone, text: `If you pay it off: ${effect.text}. It takes ${formatMoney(quote.total)} of cash${interest}.`, label: `Pay off for ${formatMoney(quote.total)}` };
  }
  return {
    ok: true,
    tone: effect.tone,
    text: `If you pay ${formatMoney(quote.amount)} off early: ${effect.text}. It takes ${formatMoney(quote.total)} of cash${interest}, and the payment drops to ${formatMoney(quote.paymentAfter)} a month.`,
    label: `Pay ${formatMoney(quote.total)}`,
  };
}

// ---------------------------------------------------------------------------
// No more borrowing: the sweep and the countdown, or the called loans
// ---------------------------------------------------------------------------

/** What a frozen line (or called loans) means now: figures from the sim (debt.ts). */
export interface FrozenInfo {
  /** The latest close's sweep (report.debt.sweep) and the month it closed, or null when that close swept nothing. */
  lastSweep: { amount: number; close: string } | null;
  /** debt.estimateSweep: what the next close would sweep if the line stays frozen. */
  nextSweep: number;
  /** debt.closesUntilAcceleration: frozen closes left before the bank calls the loans, or null (not frozen, or already called). */
  closesUntilCall: number | null;
  /** debt.acceleratedSchedule once the loans are called: what falls due at each close left (index 0 = the next), else null. */
  called: number[] | null;
  /** Today (for the close dates). */
  day: number;
  /** Total debt today. */
  owed: number;
  /** The stage is 'frozen' (a call can outlast the freeze). */
  frozen: boolean;
}

export interface FrozenView {
  tone: BankTone;
  /** Plain lines: 'called', 'end', 'sweep', 'last', 'countdown'. */
  items: { key: 'called' | 'end' | 'sweep' | 'last' | 'countdown'; text: string }[];
  /** Once called: what falls due at each close left ("Aug 1, 2027: about $50,000"). */
  due: string[];
}

/** The 1st of the month `k` closes after `day` (k = 1: the next close). */
export function closeDayAfter(day: number, k: number): number {
  let next = day;
  for (let i = 0; i < k; i++) next = nextCloseDay(next);
  return next;
}

/** Day of the next month close (the 1st of next month). */
export function nextCloseDay(day: number): number {
  const d = dateOf(day);
  return d.month === 12 ? dayOf({ year: d.year + 1, month: 1, day: 1 }) : dayOf({ year: d.year, month: d.month + 1, day: 1 });
}

/**
 * The sweep (next and last) and the countdown to the bank asking for every
 * loan back, in plain words; once it has, what falls due at each close
 * left. Null while there is neither a frozen line with debt nor a call.
 */
export function frozenView(info: FrozenInfo): FrozenView | null {
  const sweep: FrozenView['items'] = [];
  if (info.frozen && info.owed > 0) {
    sweep.push({
      key: 'sweep',
      text:
        info.nextSweep > 0
          ? `At the next month close (${formatDate(nextCloseDay(info.day))}) the bank takes about ${formatMoney(info.nextSweep)} of your spare cash to pay down what you owe.`
          : 'The bank takes part of your spare cash at each month close to pay down what you owe; none is expected at the next close.',
    });
    if (info.lastSweep) sweep.push({ key: 'last', text: `Last time it took ${formatMoney(info.lastSweep.amount)}, at the ${info.lastSweep.close} close.` });
  }
  if (info.called !== null && info.owed > 0) {
    const left = info.called.length;
    return {
      tone: 'danger',
      items: [
        {
          key: 'called',
          text: `The bank has asked for every loan back: ${formatMoney(info.owed)} in all, due ${left <= 1 ? 'at the next month close' : `over the next ${left} month closes`}.`,
        },
        { key: 'end', text: "If a month close can't pay what's due, the game ends. Paying back early still works." },
        ...sweep,
      ],
      due: info.called.map((amount, i) => `${formatDate(closeDayAfter(info.day, i + 1))}: about ${formatMoney(amount)}`),
    };
  }
  if (!info.frozen || info.owed <= 0) return null;
  const left = info.closesUntilCall ?? FROZEN_ACCELERATION_CLOSES;
  const countdown =
    left <= 0
      ? "If you're still over a limit at the next month close, the bank asks for every loan back."
      : `If you're still over a limit, the bank asks for every loan back in ${plural(left, 'month')} (at the ${formatDate(closeDayAfter(info.day, left))} close), due within ${plural(ACCELERATION_CLOSES, 'month')}.`;
  return { tone: left <= ACCELERATION_WARNING_CLOSES ? 'danger' : 'warn', items: [...sweep, { key: 'countdown', text: countdown }], due: [] };
}

// ---------------------------------------------------------------------------
// What happens if I slip?
// ---------------------------------------------------------------------------

export interface SlipStep {
  key: 'warning' | 'penalty' | 'frozen' | 'called' | 'end';
  /** The step's name ("Warning"). */
  name: string;
  text: string;
  /** The player is on this step now. */
  current: boolean;
}

/** The ladder in plain steps, with the current one marked (none in good standing or on watch). */
export function slipLadder(health: Pick<BankHealth, 'level' | 'called' | 'noDebt'>): SlipStep[] {
  const at: SlipStep['key'] | null = health.called
    ? 'called'
    : health.noDebt
      ? null
      : health.level === 'warning' || health.level === 'penalty' || health.level === 'frozen'
        ? health.level
        : null;
  const steps: Omit<SlipStep, 'current'>[] = [
    { key: 'warning', name: HEALTH_WORD.warning, text: 'Go over a limit at a month close and you get a warning. Nothing changes yet.' },
    { key: 'penalty', name: HEALTH_WORD.penalty, text: `Still over at the next close: every loan costs ${plainRate(PENALTY_STEP_UP_BPS)} more.` },
    { key: 'frozen', name: HEALTH_WORD.frozen, text: 'Still over: the bank stops lending and takes your spare cash each month.' },
    {
      key: 'called',
      name: CALLED_WORD,
      text: `After ${plural(FROZEN_ACCELERATION_CLOSES, 'month')} like that, the bank asks for every loan back, due within ${plural(ACCELERATION_CLOSES, 'month')}.`,
    },
    { key: 'end', name: 'Game over', text: "If you can't pay what's due, the game ends." },
  ];
  return steps.map((s) => ({ ...s, current: s.key === at }));
}

/** "What happens if I slip?" opens by itself whenever the bank's health isn't Good. */
export function slipOpenByDefault(level: BankHealthLevel): boolean {
  return level !== 'good';
}

/** The missed-payment rule, plainly. */
export const MISSED_PAYMENT_RULE = "If you can't make a payment, borrowing stops at once and you pay a late fee.";

/** How to step back, with the progress so far while off a good standing. */
export function stepBackLine(stage: CovenantStage, compliantCloses: number): string {
  const progress = stage !== 'compliant' && compliantCloses > 0 ? ` You have ${compliantCloses} of ${COVENANT_CURE_CLOSES} so far.` : '';
  return `${stepBackText().replace(/^./, (c) => c.toUpperCase())}${progress}`;
}

// ---------------------------------------------------------------------------
// The next payment and the figures behind the checks ("What the bank counts")
// ---------------------------------------------------------------------------

/**
 * The warning line under the checks when the next loan payment is more than
 * the cash projected at that close (finance.estimateCashAtClose: after the
 * month's billing and running costs, which the close takes first); ''
 * otherwise.
 */
export function paymentWarning(estimate: number, cashAtClose: number, day: number): string {
  if (estimate <= 0 || cashAtClose >= estimate) return '';
  return (
    `Your next loan payment, about ${formatMoney(estimate)} on ${formatDate(nextCloseDay(day))}, is more than the cash you're expected to have then ` +
    `(about ${formatMoney(cashAtClose)}).`
  );
}

export interface Figure {
  label: string;
  value: string;
  /** Small print after the value. */
  sub?: string;
  tone?: BankTone | 'muted';
}

/** What the last close's test found (report.debt), for the disclosure beside today's figures. */
export interface LastTest {
  /** "Jul 2027": the month that close ended. */
  close: string;
  debt: Pick<DebtStats, 'creditBalance' | 'termBalance' | 'leverageX100' | 'coverageX100' | 'annualDebtService'>;
}

/** "6.02× · 0.91×" with what the test measured, or null when that close had no debt to test. */
export function lastTestFigure(last: LastTest | null): Figure | null {
  if (!last || last.debt.creditBalance + last.debt.termBalance <= 0) return null;
  const { leverageX100, coverageX100, annualDebtService } = last.debt;
  return {
    label: `Tested at the ${last.close} close`,
    value: `${formatLeverage(leverageX100 === null ? null : leverageX100 / 100)} · ${formatRatio(coverageX100 === null ? null : coverageX100 / 100)}`,
    sub: `years of profit (leverage) · earned per $1 (coverage), on ${formatMoney(annualDebtService)} a year of payments at the rates before that close re-priced`,
  };
}

/** "≈ $3,120 at the Feb 1, 2027 close", warn-toned when the cash projected at that close is below it. */
export function nextPaymentFigure(estimate: number, cashAtClose: number, day: number): Figure {
  if (estimate <= 0) return { label: 'Next loan payment', value: 'None due', tone: 'muted' };
  const short = cashAtClose < estimate;
  return {
    label: 'Next loan payment',
    value: `≈ ${formatMoney(estimate)}`,
    sub: `at the ${formatDate(nextCloseDay(day))} close${short ? ': more than the cash projected then' : ''}`,
    tone: short ? 'warn' : undefined,
  };
}

/** The cash projected at the next close before its loan payments, while a payment is due (null otherwise). */
export function cashAtCloseFigure(cashAtClose: number, estimate: number): Figure | null {
  if (estimate <= 0) return null;
  return {
    label: 'Cash at the close',
    value: `≈ ${formatMoney(cashAtClose)}`,
    sub: 'projected, before loan payments',
    tone: cashAtClose < 0 ? 'danger' : cashAtClose < estimate ? 'warn' : undefined,
  };
}

/** "smoothed: the mean of your last 3 closed months' revenue, at most 1.1× the weakest of them, × 12" */
export function lendingArrNote(): string {
  return `smoothed: the mean of your last ${plural(ARR_TRAILING_MONTHS, 'closed month')}' revenue, at most ${formatMultiple(ARR_SPIKE_CAP)} the weakest of them, × 12`;
}

/**
 * Every figure behind the two checks, for "What the bank counts": each in
 * plain words with the bank's own name beside it. Debt figures carry no tone
 * (never success green).
 */
export function bankFigures(
  m: CovenantMetrics,
  extra: { credit: number; term: number; estimate: number; cashAtClose: number; day: number; last: LastTest | null },
): Figure[] {
  const tested = lastTestFigure(extra.last);
  const projected = cashAtCloseFigure(extra.cashAtClose, extra.estimate);
  return [
    { label: 'What you owe', value: formatMoney(m.totalDebt), sub: `${formatMoney(extra.credit)} of emergency cash (the credit line) and ${formatMoney(extra.term)} in loans` },
    {
      label: 'Profit, as the bank counts it',
      value: `${formatMoney(m.underwritingCashFlow)} a year`,
      sub:
        `your yearly bills minus running costs (operating cash flow, ${formatMoney(m.annualOperatingCashFlow)} a year), ` +
        `or ${formatPercent(UNDERWRITING_MIN_MARGIN)} of your yearly bills if that is more: the bank's minimum margin`,
      tone: m.underwritingCashFlow > 0 ? undefined : 'danger',
    },
    { label: 'Yearly bills, as the bank counts them', value: `${formatMoney(m.arr)} a year`, sub: `lending ARR, ${lendingArrNote()}` },
    { label: 'Loan payments, next 12 months', value: `${formatMoney(m.annualDebtService)} a year`, sub: "debt service, at today's rates" },
    { label: 'Years of profit', value: formatLeverage(m.leverage), sub: `leverage: what you owe ÷ profit; the limit is ${formatRatio(COVENANT_MAX_LEVERAGE)}` },
    { label: 'Earned per $1 of payments', value: formatRatio(m.coverage), sub: `coverage (DSCR): profit ÷ loan payments; at least ${formatRatio(COVENANT_MIN_COVERAGE)}` },
    ...(tested ? [tested] : []),
    nextPaymentFigure(extra.estimate, extra.cashAtClose, extra.day),
    ...(projected ? [projected] : []),
  ];
}

// ---------------------------------------------------------------------------
// Bank messages
// ---------------------------------------------------------------------------

/** Notices the Bank keeps to reread: the debt notices, long and gone from the toasts in seconds. */
const BANK_NOTICE_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>([
  'paymentDue',
  'paymentMissed',
  'covenantWarning',
  'covenantPenalty',
  'creditFrozen',
  'covenantCured',
  'loanPaidOff',
  'debtSwept',
  'accelerationWarning',
  'loansCalled',
]);

/** How many of them the Bank lists. */
export const BANK_NOTICES_SHOWN = 5;

/** The Bank lists notices of this kind to reread. */
export function isBankNotice(kind: NoticeKind): boolean {
  return BANK_NOTICE_KINDS.has(kind);
}

/** Longest headline a narrow screen toasts for a bank notice. */
const HEADLINE_MAX = 180;

/**
 * A bank notice cut to its headline, for a toast on a narrow screen (the full
 * text would cover the map; the Bank lists it): the first sentence, or the
 * part before its first colon when that sentence is long, or the first
 * HEADLINE_MAX characters at a word; then where to read the rest.
 */
export function noticeHeadline(message: string): string {
  const end = message.indexOf('. ');
  let head = end >= 0 ? message.slice(0, end + 1) : message;
  if (head.length > HEADLINE_MAX) {
    const colon = head.indexOf(': ');
    if (colon >= 0 && colon <= HEADLINE_MAX) head = `${head.slice(0, colon)}.`;
    else head = `${head.slice(0, head.lastIndexOf(' ', HEADLINE_MAX))}…`;
  }
  return head === message ? message : `${head} Full notice in the Bank.`;
}

export interface BankNoticeView {
  id: number;
  /** "Aug 1, 2027" */
  date: string;
  text: string;
  tone: ToastTone;
}

/** The latest debt notices, newest first, at most `max`. */
export function bankNotices(notices: readonly Notice[], max: number = BANK_NOTICES_SHOWN): BankNoticeView[] {
  const out: BankNoticeView[] = [];
  for (let i = notices.length - 1; i >= 0 && out.length < max; i--) {
    const n = notices[i] as Notice;
    if (BANK_NOTICE_KINDS.has(n.kind)) out.push({ id: n.id, date: formatDate(n.day), text: n.message, tone: noticeTone(n) });
  }
  return out;
}

/** "Bank messages (3)" */
export function messagesLabel(count: number): string {
  return `Bank messages (${count})`;
}

/** A typed amount the sim can take: a whole number >= 1, else null. */
export function parseAmount(text: string): number | null {
  const n = parseNumberField(text.replace(/[$,\s]/g, ''));
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/** "THE BANK · MARTEN RUN FIBER" (upper-cased by CSS): the header, with the company's name as text. */
export function bankHeader(companyName: string): string {
  const name = companyName.trim();
  return name ? `The Bank · ${name}` : 'The Bank';
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const ENTER_AMOUNT = 'Enter an amount in whole dollars';

/** The status icons (trusted markup): shape and color, never color alone. */
const HEALTH_SVG: Readonly<Record<HealthView['icon'], string>> = {
  check: '<circle class="hi-ring" cx="28" cy="28" r="28"/><circle class="hi-shape" cx="28" cy="28" r="18"/><path class="hi-mark" d="M20 28.5l5.5 5.5L37 22.5"/>',
  watch: '<circle class="hi-ring" cx="28" cy="28" r="28"/><circle class="hi-shape" cx="28" cy="28" r="18"/><path class="hi-mark" d="M28 19.5v10"/><circle class="hi-dot" cx="28" cy="36" r="2.6"/>',
  warning: '<circle class="hi-ring" cx="28" cy="28" r="28"/><path class="hi-shape" d="M28 9.5L47 43H9z"/><path class="hi-mark" d="M28 21v10"/><circle class="hi-dot" cx="28" cy="37.5" r="2.6"/>',
  rate: '<circle class="hi-ring" cx="28" cy="28" r="28"/><path class="hi-shape" d="M28 9.5L47 43H9z"/><path class="hi-mark" d="M28 38V23M22 29l6-6 6 6"/>',
  stop: '<circle class="hi-ring" cx="28" cy="28" r="28"/><path class="hi-shape" d="M21 10h14l11 11v14L35 46H21L10 35V21z"/><path class="hi-mark" d="M19 28h18"/>',
};

/** The small marks beside a preview: a check (fine), "!" (near a limit), "!" in a triangle (over). */
const PREVIEW_SVG: Readonly<Record<PreviewTone, string>> = {
  ok: '<circle class="pv-shape" cx="9" cy="9" r="9"/><path class="pv-mark" d="M5 9.3l2.6 2.6L13 6.5"/>',
  warn: '<circle class="pv-shape" cx="9" cy="9" r="9"/><path class="pv-mark" d="M9 4.5v5.5"/><circle class="pv-dot" cx="9" cy="13.3" r="1.4"/>',
  danger: '<path class="pv-shape" d="M9 0.8L17.6 16.6H0.4z"/><path class="pv-mark" d="M9 6.2v5"/><circle class="pv-dot" cx="9" cy="14" r="1.3"/>',
};

let bankIds = 0;

function setDisabled(node: HTMLButtonElement | HTMLInputElement, disabled: boolean): void {
  if (node.disabled !== disabled) node.disabled = disabled;
}

function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

function setHidden(node: HTMLElement, hidden: boolean): void {
  if (node.hidden !== hidden) node.hidden = hidden;
}

/** Container tones are is-ok / is-warn / is-danger (style.css's tone-* colors every number inside: figures only). */
function setTone(node: HTMLElement, tone: string | null, tones: readonly string[] = ['ok', 'warn', 'danger'], prefix: 'is' | 'tone' = 'is'): void {
  for (const t of tones) node.classList.toggle(`${prefix}-${t}`, tone === t);
}

/** A <dl> of label/value rows, built once and updated in place. */
class FigureList {
  readonly root: HTMLDListElement;
  private readonly rows: { value: HTMLElement; sub: HTMLElement; row: HTMLElement }[] = [];

  constructor(cls: string, private readonly testPrefix?: string) {
    this.root = el('dl', { class: `bank-figs ${cls}` });
  }

  set(figures: Figure[]): void {
    while (this.rows.length < figures.length) {
      const value = el('span', { class: 'num' });
      const sub = el('small', { class: 'bank-sub' });
      const row = el('div', { class: 'bank-fig' }, [el('dt'), el('dd', {}, [value, sub])]);
      this.rows.push({ value, sub, row });
      this.root.append(row);
    }
    this.rows.forEach((dom, i) => {
      const f = figures[i];
      setHidden(dom.row, !f);
      if (!f) return;
      setText(dom.row.firstElementChild as HTMLElement, f.label);
      if (this.testPrefix) setAttr(dom.value, 'data-testid', `${this.testPrefix}-${f.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`);
      setText(dom.value, f.value);
      setTone(dom.value, f.tone ?? null, ['ok', 'warn', 'danger', 'muted'], 'tone');
      setText(dom.sub, f.sub ?? '');
      setHidden(dom.sub, !f.sub);
    });
  }
}

/** A list of plain lines, rebuilt only when its content changes (no inputs inside). */
function setLines(list: HTMLElement, items: string[], key: { value: string }, tag: 'li' | 'p' = 'li'): void {
  const next = items.join('\n');
  if (next === key.value) return;
  key.value = next;
  list.replaceChildren(...items.map((t) => el(tag, { text: t })));
  setHidden(list, items.length === 0);
}

/** Rate rows rebuilt when they change. */
function setRateRows(list: HTMLElement, rows: RateRowView[], key: { value: string }): void {
  const next = JSON.stringify(rows);
  if (next === key.value) return;
  key.value = next;
  list.replaceChildren(
    ...rows.map((r) =>
      el('div', { class: `bank-rate-row rate-${r.key}`, attrs: { 'data-rate': r.key } }, [
        el('dt', {}, [el('span', { text: r.label }), el('small', { text: r.note })]),
        el('dd', { class: 'num', text: r.value }),
      ]),
    ),
  );
}

/** One preview line: its mark and its words, toned. */
class PreviewLine {
  readonly root: HTMLElement;
  private readonly mark: HTMLElement;
  private readonly text: HTMLElement;
  private tone: PreviewTone | null = null;

  constructor(testid: string) {
    this.mark = el('span', { class: 'bank-preview-mark', attrs: { 'aria-hidden': 'true' } });
    this.text = el('span', { class: 'bank-preview-text' });
    this.root = el('p', { class: 'bank-preview', attrs: { 'data-testid': testid, hidden: '' } }, [this.mark, this.text]);
  }

  set(preview: Preview | null): void {
    setHidden(this.root, preview === null);
    if (!preview) return;
    setText(this.text, preview.text);
    if (preview.tone !== this.tone) {
      this.tone = preview.tone;
      this.mark.innerHTML = `<svg viewBox="0 0 18 18" width="18" height="18">${PREVIEW_SVG[preview.tone]}</svg>`;
      setTone(this.root, preview.tone);
    }
  }

  get value(): string {
    return this.root.hidden ? '' : (this.text.textContent ?? '');
  }
}

/** One of the two checks: its sentence, bar, limit marker and status words. */
class CheckRow {
  readonly root: HTMLElement;
  private readonly sentence: HTMLElement;
  private readonly status: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly marker: HTMLElement;
  private readonly markerLabel: HTMLElement;
  private readonly start: HTMLElement;
  private readonly end: HTMLElement;
  private key = '';

  constructor(kind: CheckView['key']) {
    this.sentence = el('p', { class: 'bank-check-sentence' });
    this.status = el('span', { class: 'bank-check-status', attrs: { 'data-testid': `bank-check-${kind}-status` } });
    this.fill = el('span', { class: 'bank-bar-fill' });
    this.marker = el('span', { class: 'bank-bar-marker' });
    this.bar = el('span', { class: 'bank-bar', attrs: { role: 'img' } }, [this.fill, this.marker]);
    this.start = el('span', { class: 'bank-scale-start' });
    this.markerLabel = el('span', { class: 'bank-scale-limit' });
    this.end = el('span', { class: 'bank-scale-end' });
    this.root = el('div', { class: 'bank-check', attrs: { 'data-check': kind, 'data-testid': `bank-check-${kind}` } }, [
      this.sentence,
      this.bar,
      el('span', { class: 'bank-scale', attrs: { 'aria-hidden': 'true' } }, [this.start, this.markerLabel, this.end]),
      this.status,
    ]);
  }

  set(view: CheckView): void {
    const key = JSON.stringify(view);
    if (key === this.key) return;
    this.key = key;
    this.sentence.replaceChildren(...view.parts.map((p) => (p.strong ? el('b', { text: p.text }) : document.createTextNode(p.text))));
    setText(this.status, view.statusText);
    setAttr(this.root, 'data-status', view.status);
    setAttr(this.bar, 'aria-label', view.barLabel);
    this.fill.style.width = `${Math.round(view.fill * 1000) / 10}%`;
    const at = `${Math.round(view.marker * 1000) / 10}%`;
    this.marker.style.left = at;
    this.markerLabel.style.left = at;
    setText(this.markerLabel, view.markerLabel);
    setText(this.start, view.scaleStart);
    setText(this.end, view.scaleEnd);
  }
}

interface LoanDom {
  root: HTMLElement;
  line: HTMLElement;
  balance: HTMLElement;
  rest: HTMLElement;
  note: HTMLElement;
  toggle: HTMLButtonElement;
  form: HTMLElement;
  input: HTMLInputElement;
  preview: PreviewLine;
  confirm: HTMLButtonElement;
  error: HTMLElement;
  /** The form was opened with this balance prefilled (reset when the balance changes and nothing was typed). */
  filledFor: number;
  typed: boolean;
}

/** Open the Bank over the game; at most one at a time. */
export class BankPanel {
  private sheet: Sheet | null = null;
  private view: BankView | null = null;

  constructor(
    private readonly session: GameSession,
    private readonly toasts: Toasts,
  ) {}

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  close(): void {
    this.sheet?.close();
  }

  open(): void {
    if (this.sheet?.isOpen) return;
    if (this.session.state.gameOver) return;
    const sheet = openSheet({
      title: 'Bank',
      className: 'bank',
      onClose: () => {
        if (this.sheet === sheet) {
          this.sheet = null;
          this.view = null;
        }
      },
    });
    this.sheet = sheet;
    this.view = new BankView(sheet, this.session, this.toasts);
    this.view.refresh(true);
    sheet.dialog.querySelector<HTMLButtonElement>('.sheet-close')?.focus();
  }

  /** Every frame while open: refresh the figures in place when the day or anything else changed. */
  update(session: GameSession): void {
    if (!this.view || !this.sheet?.isOpen) return;
    if (session.state.gameOver) {
      this.close();
      return;
    }
    this.view.refresh(false);
  }
}

type Pane = 'payback' | 'credit';

class BankView {
  private seen = { state: null as GameState | null, day: -1, revision: -1 };
  /**
   * The one live region: what the player's own choice just previewed. The
   * figures refresh every game day and would chatter if they were live.
   */
  private readonly live: HTMLElement;
  // Health.
  private readonly healthBox: HTMLElement;
  private readonly healthIcon: HTMLElement;
  private readonly healthTitle: HTMLElement;
  private readonly healthSentence: HTMLElement;
  private healthIconKey = '';
  private readonly cureBox: HTMLElement;
  private readonly cureText: HTMLElement;
  private readonly cureButton: HTMLButtonElement;
  private cure: CureAction | null = null;
  private readonly paymentWarn: HTMLElement;
  private readonly frozenBox: HTMLElement;
  private readonly frozenItems: HTMLElement;
  private readonly frozenDue: HTMLElement;
  private frozenKey = '';
  // The checks.
  private readonly debtRow = new CheckRow('debt');
  private readonly coverageRow = new CheckRow('coverage');
  private readonly figures = new FigureList('bank-count-figs', 'bank-fig');
  // Borrow more.
  private readonly borrowWhy: HTMLElement;
  private readonly builder: HTMLElement;
  private readonly chipButtons: HTMLButtonElement[] = [];
  private readonly otherChip: HTMLButtonElement;
  private readonly otherRow: HTMLElement;
  private readonly termInput: HTMLInputElement;
  private readonly upTo: HTMLElement;
  private readonly yearButtons = new Map<TermYears, HTMLButtonElement>();
  private readonly termPreview = new PreviewLine('bank-term-preview');
  private readonly termRepriced: HTMLElement;
  private readonly termRepricedKey = { value: '' };
  private readonly termRateRows: HTMLElement;
  private readonly termRateKey = { value: '' };
  private readonly termDetails: HTMLElement;
  private readonly termDetailsKey = { value: '' };
  private readonly termError: HTMLElement;
  private readonly borrowButton: HTMLButtonElement;
  private chips: AmountChip[] = [];
  private termYears: TermYears = TERM_LOAN_YEARS[0] ?? 5;
  /** "Other amount" is chosen: the field shows, whatever it holds. */
  private otherMode = false;
  /** The player chose an amount (a chip, Other or typing): new figures leave it alone. */
  private termDirty = false;
  /** Capacity, starting amount and term the builder's default amount was last set for. */
  private termDefaultKey = '';
  private termPrefill = 0;
  // Pay back and Emergency cash.
  private pane: Pane | null = null;
  private readonly paybackToggle: HTMLButtonElement;
  private readonly creditToggle: HTMLButtonElement;
  private readonly paybackPane: HTMLElement;
  private readonly creditPane: HTMLElement;
  private readonly paybackSlot: HTMLElement;
  private readonly creditSlot: HTMLElement;
  private readonly loanList: HTMLElement;
  private readonly loansEmpty: HTMLElement;
  private readonly loans = new Map<LoanId, LoanDom>();
  private readonly creditSummary: HTMLElement;
  private readonly creditRate: HTMLElement;
  private readonly creditWhy: HTMLElement;
  private readonly drawForm: HTMLElement;
  private readonly drawInput: HTMLInputElement;
  private readonly drawButton: HTMLButtonElement;
  private readonly drawPresetButtons: HTMLButtonElement[] = [];
  private readonly drawPreview = new PreviewLine('bank-draw-preview');
  private readonly drawError: HTMLElement;
  private readonly creditRateRows: HTMLElement;
  private readonly creditRateKey = { value: '' };
  private readonly creditLimitNote: HTMLElement;
  private drawPresets: Preset[] = [];
  private readonly repayForm: HTMLElement;
  private readonly repayHead: HTMLElement;
  private readonly repayInput: HTMLInputElement;
  private readonly repayButton: HTMLButtonElement;
  private readonly repayPresetButtons: HTMLButtonElement[] = [];
  private readonly repayPreview = new PreviewLine('bank-repay-preview');
  private readonly repayWhy: HTMLElement;
  private readonly repayError: HTMLElement;
  private repayPresets: Preset[] = [];
  // What happens if I slip?
  private readonly slip: HTMLDetailsElement;
  private readonly ladder: HTMLElement;
  private ladderKey = '';
  private readonly stepBack: HTMLElement;
  private slipLevel: BankHealthLevel | null = null;
  // Bank messages.
  private readonly messages: HTMLDetailsElement;
  private readonly messagesSummary: HTMLElement;
  private readonly noticeList: HTMLElement;
  private noticesKey = '';

  constructor(
    sheet: Sheet,
    private readonly session: GameSession,
    private readonly toasts: Toasts,
  ) {
    const id = `bank-${++bankIds}`;
    const state = session.state;

    // The header: "THE BANK · <COMPANY>", while the dialog keeps the plain name "Bank".
    const title = sheet.dialog.querySelector<HTMLElement>('.sheet-title');
    if (title) {
      title.classList.add('bank-eyebrow');
      setText(title, bankHeader(state.company.name));
    }
    sheet.dialog.removeAttribute('aria-labelledby');
    sheet.dialog.setAttribute('aria-label', 'Bank');

    const button = (label: string, cls: string, run: () => void, attrs: Record<string, string> = {}) =>
      el('button', { class: `btn ${cls}`, text: label, attrs: { type: 'button', ...attrs }, on: { click: run } });
    const amountInput = (label: string, testid: string) =>
      el('input', {
        class: 'field num bank-amount',
        attrs: { type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: 'Amount', 'aria-label': label, 'data-testid': testid },
      });
    const moneyField = (input: HTMLInputElement) => el('span', { class: 'money-field bank-money' }, [el('span', { text: '$', attrs: { 'aria-hidden': 'true' } }), input]);
    const error = () => el('p', { class: 'sheet-error', attrs: { role: 'alert', hidden: '' } });
    const details = (cls: string, testid: string, summary: string | HTMLElement, children: (Node | null)[]) => {
      const node = el('details', { class: `bank-more ${cls}`, attrs: { 'data-testid': testid } }, [
        el('summary', {}, [el('span', { class: 'bank-more-chevron', attrs: { 'aria-hidden': 'true' } }), typeof summary === 'string' ? el('span', { text: summary }) : summary]),
        ...children,
      ]);
      return node;
    };
    const presetRow = (label: string) => el('div', { class: 'bank-presets', attrs: { role: 'group', 'aria-label': label } });

    this.live = el('p', { class: 'visually-hidden', attrs: { role: 'status', 'aria-live': 'polite' } });

    // 1. Health status, the cure, the payment warning and (frozen or called) the sweep and the countdown.
    this.healthIcon = el('span', { class: 'bank-health-icon', attrs: { 'aria-hidden': 'true' } });
    this.healthTitle = el('h3', { class: 'bank-health-title', attrs: { 'data-testid': 'bank-health-title' } });
    this.healthSentence = el('p', { class: 'bank-health-sentence', attrs: { 'data-testid': 'bank-health-sentence', id: `${id}-health` } });
    this.healthBox = el('div', { class: 'bank-health', attrs: { 'data-testid': 'bank-health' } }, [
      this.healthIcon,
      el('div', { class: 'bank-health-text' }, [this.healthTitle, this.healthSentence]),
    ]);
    sheet.dialog.setAttribute('aria-describedby', `${id}-health`);
    this.cureText = el('p', { class: 'bank-cure-text', attrs: { 'data-testid': 'bank-cure-text' } });
    this.cureButton = button('', 'sheet-secondary bank-cure-action', () => this.runCure(), { 'data-testid': 'bank-cure-action' });
    this.cureBox = el('div', { class: 'bank-cure', attrs: { 'data-testid': 'bank-cure', hidden: '' } }, [this.cureText, this.cureButton]);
    this.paymentWarn = el('p', { class: 'bank-attention', attrs: { 'data-testid': 'bank-payment-warning', hidden: '' } });
    this.frozenItems = el('ul', { class: 'bank-frozen-lines' });
    this.frozenDue = el('ol', { class: 'bank-frozen-due', attrs: { 'aria-label': 'What falls due at each month close' } });
    this.frozenBox = el('div', { class: 'bank-frozen', attrs: { 'data-testid': 'bank-frozen', role: 'group', 'aria-label': 'What the bank is doing now', hidden: '' } }, [
      this.frozenItems,
    ]);

    // 2. The two checks, and what the bank counts.
    const checks = el('div', { class: 'bank-checks', attrs: { 'data-testid': 'bank-checks', role: 'group', 'aria-label': 'The two checks' } }, [
      this.debtRow.root,
      this.coverageRow.root,
      details('bank-count', 'bank-figures', 'What the bank counts', [this.figures.root]),
    ]);

    // 3. Borrow more.
    this.borrowWhy = el('p', { class: 'bank-why', attrs: { 'data-testid': 'bank-borrow-why', hidden: '' } });
    const chips = el('div', { class: 'bank-chips', attrs: { role: 'group', 'aria-label': 'How much to borrow' } });
    for (let i = 0; i < 3; i++) {
      const b = button('', 'bank-chip', () => this.pickChip(i), { 'aria-pressed': 'false', 'data-testid': `bank-chip-${i}` });
      b.hidden = true;
      this.chipButtons.push(b);
      chips.append(b);
    }
    this.otherChip = button('Other amount', 'bank-chip bank-chip-other', () => this.pickOther(), { 'aria-pressed': 'false', 'data-testid': 'bank-chip-other' });
    chips.append(this.otherChip);
    this.termInput = amountInput('Amount to borrow', 'bank-term-amount');
    this.upTo = el('span', { class: 'bank-up-to' });
    this.otherRow = el('div', { class: 'bank-other', attrs: { hidden: '' } }, [moneyField(this.termInput), this.upTo]);
    const years = el('div', { class: 'bank-years', attrs: { role: 'radiogroup', 'aria-label': 'Pay back over' } }, [el('span', { class: 'bank-years-label', text: 'Pay back over', attrs: { 'aria-hidden': 'true' } })]);
    for (const y of TERM_LOAN_YEARS) {
      const b = el('button', {
        class: 'btn bank-year',
        text: `${y} years`,
        attrs: { type: 'button', role: 'radio', 'aria-checked': String(y === this.termYears), 'data-years': String(y), tabindex: y === this.termYears ? '0' : '-1' },
        on: { click: () => this.pickYears(y) },
      });
      this.yearButtons.set(y, b);
      years.append(b);
    }
    years.addEventListener('keydown', (e) => {
      const list = [...TERM_LOAN_YEARS];
      const at = list.indexOf(this.termYears);
      const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (step === 0) return;
      e.preventDefault();
      const next = list[(at + step + list.length) % list.length];
      if (next !== undefined) {
        this.pickYears(next);
        this.yearButtons.get(next)?.focus();
      }
    });
    this.termRepriced = el('ul', { class: 'bank-repriced', attrs: { 'data-testid': 'bank-term-repriced', hidden: '' } });
    this.termRateRows = el('dl', { class: 'bank-rate-rows' });
    this.termDetails = el('div', { class: 'bank-detail-lines', attrs: { 'data-testid': 'bank-term-details' } });
    this.builder = el('div', { class: 'bank-builder' }, [
      chips,
      this.otherRow,
      years,
      this.termPreview.root,
      this.termRepriced,
      details('bank-rate-details', 'bank-rate-details', 'How the rate is set', [this.termRateRows, this.termDetails]),
    ]);
    this.termError = error();
    const borrow = el('section', { class: 'bank-section bank-borrow', attrs: { 'aria-labelledby': `${id}-borrow`, 'data-testid': 'bank-term' } }, [
      el('h3', { class: 'bank-heading', text: 'Borrow more', attrs: { id: `${id}-borrow` } }),
      this.borrowWhy,
      this.builder,
      this.termError,
    ]);

    // 4. The actions: borrow, and the two panes that open in place.
    this.borrowButton = button('Borrow', 'sheet-primary bank-borrow-go', () => this.borrow(), { 'data-testid': 'bank-borrow' });
    this.paybackToggle = button('Pay back', 'bank-toggle', () => this.togglePane('payback'), {
      'aria-expanded': 'false',
      'aria-controls': `${id}-payback`,
      'data-testid': 'bank-payback-toggle',
    });
    this.creditToggle = button('Emergency cash', 'bank-toggle', () => this.togglePane('credit'), {
      'aria-expanded': 'false',
      'aria-controls': `${id}-credit`,
      'data-testid': 'bank-credit-toggle',
    });
    const actions = el('div', { class: 'bank-actions' }, [this.borrowButton, this.paybackToggle, this.creditToggle]);

    // The emergency-cash pay-back form: it sits in whichever pane is open.
    this.repayHead = el('p', { class: 'bank-repay-head', attrs: { 'data-testid': 'bank-repay-head' } });
    this.repayInput = amountInput('Amount to repay', 'bank-repay-amount');
    this.repayButton = button('Pay back', 'sheet-secondary bank-go', () => this.repay(), { 'data-testid': 'bank-repay' });
    const repayPresets = presetRow('Pay back presets');
    for (let i = 0; i < 2; i++) {
      const b = button('', 'bank-preset', () => this.pickPreset(this.repayInput, this.repayPresets[i]));
      this.repayPresetButtons.push(b);
      repayPresets.append(b);
    }
    this.repayWhy = el('p', { class: 'bank-note', attrs: { hidden: '' } });
    this.repayError = error();
    this.repayForm = el('div', { class: 'bank-form bank-repay', attrs: { 'data-testid': 'bank-repay-form' } }, [
      this.repayHead,
      repayPresets,
      el('div', { class: 'bank-form-row' }, [moneyField(this.repayInput), this.repayButton]),
      this.repayPreview.root,
      this.repayWhy,
      this.repayError,
    ]);

    // Pay back: the emergency cash used, then each loan.
    this.paybackSlot = el('div', { class: 'bank-slot' });
    this.loanList = el('ul', { class: 'bank-loans', attrs: { 'data-testid': 'bank-loan-list' } });
    this.loansEmpty = el('p', { class: 'bank-empty', text: 'No loans to pay back.' });
    this.paybackPane = el('section', { class: 'bank-pane bank-payback', attrs: { id: `${id}-payback`, 'aria-labelledby': `${id}-payback-h`, 'data-testid': 'bank-payback', hidden: '' } }, [
      el('h3', { class: 'bank-heading', text: 'Pay back', attrs: { id: `${id}-payback-h` } }),
      this.paybackSlot,
      this.loansEmpty,
      this.loanList,
    ]);

    // Emergency cash: the credit line.
    this.creditSummary = el('p', { class: 'bank-credit-summary', attrs: { 'data-testid': 'bank-credit-summary' } });
    this.creditRate = el('p', { class: 'bank-note', attrs: { 'data-testid': 'bank-credit-rate' } });
    this.creditWhy = el('p', { class: 'bank-why', attrs: { 'data-testid': 'bank-credit-why', hidden: '' } });
    this.drawInput = amountInput('Amount to take', 'bank-draw-amount');
    this.drawButton = button('Take', 'sheet-primary bank-go', () => this.draw(), { 'data-testid': 'bank-draw' });
    const drawPresets = presetRow('Amounts to take');
    for (let i = 0; i < DRAW_PRESETS.length + 2; i++) {
      const b = button('', 'bank-preset', () => this.pickPreset(this.drawInput, this.drawPresets[i]));
      this.drawPresetButtons.push(b);
      drawPresets.append(b);
    }
    this.drawError = error();
    this.drawForm = el('div', { class: 'bank-form' }, [drawPresets, el('div', { class: 'bank-form-row' }, [moneyField(this.drawInput), this.drawButton]), this.drawPreview.root, this.drawError]);
    this.creditRateRows = el('dl', { class: 'bank-rate-rows' });
    this.creditLimitNote = el('p', { class: 'bank-note' });
    this.creditSlot = el('div', { class: 'bank-slot' });
    this.creditPane = el('section', { class: 'bank-pane bank-credit', attrs: { id: `${id}-credit`, 'aria-labelledby': `${id}-credit-h`, 'data-testid': 'bank-credit', hidden: '' } }, [
      el('h3', { class: 'bank-heading', text: 'Emergency cash', attrs: { id: `${id}-credit-h` } }),
      this.creditSummary,
      this.creditRate,
      this.creditWhy,
      this.drawForm,
      this.creditSlot,
      details('bank-line-rate', 'bank-credit-rate-details', 'How the rate is set', [this.creditRateRows, this.creditLimitNote]),
    ]);

    // 5. What happens if I slip?
    this.ladder = el('ol', { class: 'bank-ladder', attrs: { 'data-testid': 'bank-ladder' } });
    this.stepBack = el('p', { class: 'bank-note', attrs: { 'data-testid': 'bank-step-back' } });
    this.slip = details('bank-slip', 'bank-slip', 'What happens if I slip?', [
      this.ladder,
      el('p', { class: 'bank-note bank-missed', text: MISSED_PAYMENT_RULE, attrs: { 'data-testid': 'bank-missed-rule' } }),
      this.stepBack,
    ]) as HTMLDetailsElement;

    // 6. Bank messages.
    this.messagesSummary = el('span', { text: messagesLabel(0) });
    this.noticeList = el('ol', { class: 'bank-notice-list', attrs: { 'data-testid': 'bank-notice-list' } });
    this.messages = details('bank-messages', 'bank-messages', this.messagesSummary, [this.noticeList]) as HTMLDetailsElement;
    this.messages.hidden = true;

    sheet.body.append(
      this.live,
      this.healthBox,
      this.cureBox,
      this.frozenBox,
      this.paymentWarn,
      checks,
      borrow,
      actions,
      this.paybackPane,
      this.creditPane,
      this.slip,
      this.messages,
    );

    // Typing updates the previews at once; an Enter acts like the form's button.
    this.termInput.addEventListener('input', () => {
      this.termDirty = true;
      this.otherMode = true;
      this.hideError(this.termError);
      this.refreshTerm(this.session.state);
      this.announce(this.termPreview.value);
    });
    this.drawInput.addEventListener('input', () => {
      this.hideError(this.drawError);
      this.refreshDraw(this.session.state);
    });
    this.repayInput.addEventListener('input', () => {
      this.hideError(this.repayError);
      this.refreshRepay(this.session.state);
    });
    const enter = (input: HTMLInputElement, run: () => void) =>
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          run();
        }
      });
    enter(this.termInput, () => this.borrowButton.click());
    enter(this.drawInput, () => this.drawButton.click());
    enter(this.repayInput, () => this.repayButton.click());
  }

  private hideError(node: HTMLElement): void {
    node.hidden = true;
  }

  private showError(node: HTMLElement, message: string): void {
    setText(node, message);
    node.hidden = false;
    this.toasts.show(message, 'err');
  }

  private announce(text: string): void {
    setText(this.live, text);
  }

  private pickPreset(input: HTMLInputElement, preset: Preset | undefined): void {
    if (!preset || preset.disabled) return;
    input.value = String(preset.amount);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // -------------------------------------------------------------------------
  // Borrow more
  // -------------------------------------------------------------------------

  private pickChip(i: number): void {
    const chip = this.chips[i];
    if (!chip) return;
    this.termInput.value = String(chip.amount);
    this.otherMode = false;
    this.termDirty = true;
    this.hideError(this.termError);
    this.refreshTerm(this.session.state);
    this.announce(this.termPreview.value);
  }

  private pickOther(): void {
    this.otherMode = true;
    this.termDirty = true;
    this.hideError(this.termError);
    this.refreshTerm(this.session.state);
    this.termInput.focus();
    this.termInput.select();
  }

  private pickYears(years: TermYears): void {
    this.termYears = years;
    for (const [y, b] of this.yearButtons) {
      setAttr(b, 'aria-checked', String(y === years));
      b.tabIndex = y === years ? 0 : -1;
    }
    this.hideError(this.termError);
    this.refreshBorrow(this.session.state, bankHealth(this.session.state), true);
    this.announce(this.termPreview.value);
  }

  /**
   * Set the builder to its starting amount for the chosen term (the largest
   * chip; TERM_LOAN_MIN in "Other amount" when no amount is safe) whenever
   * that, the capacity or the term changes, unless the player chose an
   * amount. `picked`: the player just chose the term.
   */
  private syncTermDefault(max: number, prefill: number, picked: boolean): void {
    const key = `${max}:${prefill}:${this.termYears}`;
    if (key === this.termDefaultKey) return;
    this.termDefaultKey = key;
    if (this.termDirty || (!picked && document.activeElement === this.termInput)) return;
    this.termInput.value = String(prefill);
    this.otherMode = false;
  }

  /** Borrow more: why not, or the chips, the default amount and the preview. */
  private refreshBorrow(state: GameState, health: BankHealth, picked = false): void {
    const max = termCapacity(state);
    const why = borrowBlocked(max, health);
    setText(this.borrowWhy, why);
    setHidden(this.borrowWhy, why === '');
    setHidden(this.builder, max <= 0);
    setHidden(this.borrowButton, max <= 0);
    if (max <= 0) {
      this.hideError(this.termError);
      return;
    }
    const safeInside = maxSafeTermLoan(state, this.termYears, BANK_PREFILL_HEADROOM);
    const prefill = defaultTermAmount(safeInside);
    this.termPrefill = prefill;
    this.chips = borrowChips(safeInside);
    this.chipButtons.forEach((b, i) => {
      const chip = this.chips[i];
      setHidden(b, !chip);
      if (!chip) return;
      setText(b, chip.label);
      setAttr(b, 'data-amount', String(chip.amount));
      setAttr(b, 'title', chip.share === 'safe' ? 'The most that keeps you comfortably inside the bank’s limits' : chip.share === 'third' ? 'About a third of that' : 'About two thirds of that');
    });
    this.syncTermDefault(max, prefill, picked);
    this.refreshTerm(state);
  }

  /** The quote for the amount chosen: chips pressed, the field, the preview, the details and the button. */
  private refreshTerm(state: GameState): void {
    const amount = parseNumberField(this.termInput.value);
    const quote = quoteTermLoan(state, amount, this.termYears);
    if (!this.otherMode && !this.chips.some((c) => c.amount === amount)) this.otherMode = true;
    this.chipButtons.forEach((b, i) => setAttr(b, 'aria-pressed', String(!this.otherMode && this.chips[i]?.amount === amount)));
    setAttr(this.otherChip, 'aria-pressed', String(this.otherMode));
    setHidden(this.otherRow, !this.otherMode);
    setAttr(this.termInput, 'max', String(quote.maxAmount));
    setAttr(this.termInput, 'aria-invalid', String(this.otherMode && !quote.ok && quote.maxAmount > 0));
    setText(this.upTo, quote.maxAmount > 0 ? `Up to ${formatMoney(quote.maxAmount)}` : '');
    this.termPreview.set(borrowPreview(quote, state.debt.covenant.stage));
    setLines(this.termRepriced, quote.ok ? repricedLines(quote.repriced) : [], this.termRepricedKey);
    setRateRows(this.termRateRows, rateRows(quote.rate, { kind: 'term', years: this.termYears }), this.termRateKey);
    setLines(this.termDetails, termDetailLines(quote, this.termPrefill), this.termDetailsKey, 'p');
    setText(this.borrowButton, quote.ok ? `Borrow ${formatMoney(quote.amount)}` : 'Borrow');
    setDisabled(this.borrowButton, !quote.ok);
  }

  // -------------------------------------------------------------------------
  // Pay back and Emergency cash
  // -------------------------------------------------------------------------

  private togglePane(which: Pane): void {
    this.pane = this.pane === which ? null : which;
    this.applyPane();
    if (this.pane) {
      const pane = this.pane === 'payback' ? this.paybackPane : this.creditPane;
      pane.scrollIntoView?.({ block: 'nearest' });
    }
  }

  private applyPane(): void {
    setHidden(this.paybackPane, this.pane !== 'payback');
    setHidden(this.creditPane, this.pane !== 'credit');
    setAttr(this.paybackToggle, 'aria-expanded', String(this.pane === 'payback'));
    setAttr(this.creditToggle, 'aria-expanded', String(this.pane === 'credit'));
    const slot = this.pane === 'credit' ? this.creditSlot : this.paybackSlot;
    if (this.repayForm.parentElement !== slot) slot.append(this.repayForm);
  }

  private refreshCredit(state: GameState, health: BankHealth): void {
    const offer = creditOffer(state);
    const view = creditView(offer, health);
    setText(this.creditSummary, view.summary);
    setHidden(this.creditSummary, view.summary === '');
    setText(this.creditRate, view.rate);
    setHidden(this.creditRate, offer.limit <= 0 && offer.balance <= 0);
    setText(this.creditWhy, view.why);
    setHidden(this.creditWhy, view.why === '');
    setHidden(this.drawForm, !view.canDraw);
    this.drawPresets = drawPresets(offer.available);
    this.drawPresets.forEach((p, i) => {
      const b = this.drawPresetButtons[i];
      if (!b) return;
      setText(b, p.label);
      setDisabled(b, !view.canDraw || p.disabled);
    });
    setDisabled(this.drawInput, !view.canDraw);
    this.refreshDraw(state, offer);
    const lastReport = state.finance.reports.at(-1);
    setRateRows(
      this.creditRateRows,
      rateRows(offer.rate, { kind: 'line' }, { close: lastReport ? formatMonth(lastReport.year, lastReport.month) : null, next: formatDate(nextCloseDay(state.day)) }),
      this.creditRateKey,
    );
    const note = creditLimitNote(offer);
    setText(this.creditLimitNote, note);
    setHidden(this.creditLimitNote, note === '');

    // The pay-back form (in whichever pane is open).
    setHidden(this.repayForm, offer.balance <= 0);
    setText(this.repayHead, view.using);
    this.repayPresets = repayPresets(offer);
    this.repayPresets.forEach((p, i) => {
      const b = this.repayPresetButtons[i];
      if (!b) return;
      setText(b, p.disabled ? p.label : `${p.label} (${formatMoney(p.amount)})`);
      setDisabled(b, !view.canRepay || p.disabled);
    });
    setText(this.repayWhy, view.repayWhy);
    setHidden(this.repayWhy, view.repayWhy === '');
    setDisabled(this.repayInput, !view.canRepay);
    this.refreshRepay(state, offer);
  }

  /** The preview for the amount typed to take (none for nothing typed). */
  private refreshDraw(state: GameState, offer: CreditOffer = creditOffer(state)): void {
    const text = this.drawInput.value.trim();
    if (text === '' || offer.available <= 0) {
      this.drawPreview.set(null);
      setText(this.drawButton, 'Take');
      setDisabled(this.drawButton, offer.available <= 0 || text === '');
      return;
    }
    const quote = quoteDraw(state, parseNumberField(text));
    this.drawPreview.set(drawPreview(quote, state.debt.covenant.stage, offer.available));
    setText(this.drawButton, quote.ok ? `Take ${formatMoney(quote.amount)}` : 'Take');
    setDisabled(this.drawButton, !quote.ok);
  }

  /** The preview for the amount typed to pay back (none for nothing typed). */
  private refreshRepay(state: GameState, offer: CreditOffer = creditOffer(state)): void {
    const text = this.repayInput.value.trim();
    if (text === '' || offer.balance <= 0) {
      this.repayPreview.set(null);
      setText(this.repayButton, 'Pay back');
      setDisabled(this.repayButton, true);
      return;
    }
    const quote = quoteRepay(state, parseNumberField(text));
    this.repayPreview.set(repayPreview(quote, state.debt.covenant.stage, offer));
    setText(this.repayButton, quote.ok ? `Pay back ${formatMoney(quote.amount)}` : 'Pay back');
    setDisabled(this.repayButton, !quote.ok);
  }

  private refreshLoans(state: GameState, health: BankHealth): void {
    const loans = state.debt.loans;
    setHidden(this.loansEmpty, loans.length > 0 || state.debt.credit.balance > 0);
    setHidden(this.loanList, loans.length === 0);
    const open = new Set(loans.map((l) => l.id));
    for (const [id, dom] of this.loans) {
      if (!open.has(id)) {
        dom.root.remove();
        this.loans.delete(id);
      }
    }
    loans.forEach((loan, i) => {
      let dom = this.loans.get(loan.id);
      if (!dom) {
        dom = this.buildLoan(loan.id);
        this.loans.set(loan.id, dom);
      }
      // Keep list order (ascending id) without moving rows that are already in place.
      if (this.loanList.children[i] !== dom.root) this.loanList.insertBefore(dom.root, this.loanList.children[i] ?? null);
      const view = loanRow(loan, state.day, health.penaltyBps, finalPayment(state, loan));
      setText(dom.balance, view.balance);
      setText(dom.rest, view.rest);
      setText(dom.note, view.note);
      // A form opened on the old balance follows a new one unless the player typed.
      if (!dom.form.hidden && !dom.typed && dom.filledFor !== loan.balance) {
        dom.input.value = String(loan.balance);
        dom.filledFor = loan.balance;
      }
      this.refreshPrepay(state, dom, loan.id, health);
    });
  }

  private buildLoan(id: LoanId): LoanDom {
    const balance = el('span', { class: 'num', attrs: { 'data-testid': `bank-loan-${id}-balance` } });
    const rest = el('span');
    const line = el('p', { class: 'bank-loan-line', attrs: { 'data-testid': `bank-loan-${id}` } }, [el('strong', { text: `Loan ${id}` }), ': ', balance, rest]);
    const note = el('p', { class: 'bank-loan-note' });
    const input = el('input', {
      class: 'field num bank-amount',
      attrs: { type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: 'Amount', 'aria-label': `Amount to pay off loan ${id}`, 'data-testid': `bank-prepay-amount-${id}` },
    });
    const preview = new PreviewLine(`bank-prepay-preview-${id}`);
    const confirm = el('button', { class: 'btn sheet-primary bank-go', text: 'Pay', attrs: { type: 'button', 'data-testid': `bank-prepay-${id}` } });
    const error = el('p', { class: 'sheet-error', attrs: { role: 'alert', hidden: '' } });
    const form = el('div', { class: 'bank-form bank-prepay', attrs: { hidden: '' } }, [
      el('div', { class: 'bank-form-row' }, [el('span', { class: 'money-field bank-money' }, [el('span', { text: '$', attrs: { 'aria-hidden': 'true' } }), input]), confirm]),
      preview.root,
      error,
    ]);
    const toggle = el('button', {
      class: 'btn bank-toggle bank-prepay-open',
      text: 'Pay off early',
      attrs: { type: 'button', 'aria-expanded': 'false', 'data-testid': `bank-prepay-open-${id}` },
    });
    const dom: LoanDom = {
      root: el('li', { class: 'bank-loan', attrs: { 'data-loan': String(id) } }),
      line,
      balance,
      rest,
      note,
      toggle,
      form,
      input,
      preview,
      confirm,
      error,
      filledFor: -1,
      typed: false,
    };
    toggle.addEventListener('click', () => {
      const opening = form.hidden;
      form.hidden = !opening;
      setAttr(toggle, 'aria-expanded', String(opening));
      if (opening) {
        const loan = this.session.state.debt.loans.find((l) => l.id === id);
        if (loan && (!dom.typed || input.value.trim() === '')) {
          input.value = String(loan.balance);
          dom.filledFor = loan.balance;
          dom.typed = false;
        }
        this.refreshPrepay(this.session.state, dom, id, bankHealth(this.session.state));
        this.announce(dom.preview.value);
      }
    });
    input.addEventListener('input', () => {
      error.hidden = true;
      dom.typed = true;
      this.refreshPrepay(this.session.state, dom, id, bankHealth(this.session.state));
      this.announce(dom.preview.value);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirm.click();
      }
    });
    confirm.addEventListener('click', () => this.prepay(id, dom));
    dom.root.append(line, note, el('div', { class: 'bank-loan-actions' }, [toggle]), form);
    return dom;
  }

  /** The prepay preview for what is typed (nothing while the form is closed or empty). */
  private refreshPrepay(state: GameState, dom: LoanDom, id: LoanId, health: BankHealth): void {
    const text = dom.input.value.trim();
    const loan = state.debt.loans.find((l) => l.id === id);
    if (dom.form.hidden || text === '' || !loan) {
      dom.preview.set(null);
      setText(dom.confirm, 'Pay');
      setDisabled(dom.confirm, true);
      return;
    }
    const quote = quotePrepay(state, id, parseNumberField(text));
    const view = prepayPreview(quote, state.debt.covenant.stage, health.metrics, loan.balance, state.finance.cash);
    dom.preview.set(view);
    setText(dom.confirm, view.label);
    setDisabled(dom.confirm, !view.ok);
  }

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  /** Refresh every figure when the day, a command or the game changed (or `force`). */
  refresh(force: boolean): void {
    const state = this.session.state;
    const { seen } = this;
    if (!force && seen.state === state && seen.day === state.day && seen.revision === this.session.revision) return;
    this.seen = { state, day: state.day, revision: this.session.revision };
    const health = bankHealth(state);
    const stage = state.debt.covenant.stage;
    const owed = totalDebt(state);

    // Health status.
    const hv = healthView(health);
    setAttr(this.healthBox, 'data-level', hv.level);
    setTone(this.healthBox, hv.tone);
    if (hv.icon !== this.healthIconKey) {
      this.healthIconKey = hv.icon;
      this.healthIcon.innerHTML = `<svg viewBox="0 0 56 56" width="56" height="56">${HEALTH_SVG[hv.icon]}</svg>`;
    }
    setText(this.healthTitle, hv.title);
    setText(this.healthSentence, hv.sentence);

    // The verified cure, or how it steps back while passing today. Once the loans are called only repaying
    // everything ends the call (debt.repayAllCure), even while both checks pass.
    const cure = health.metrics.compliant ? (health.called ? repayAllCure(state) : null) : cureFor(state);
    this.cure = cureAction(cure, state);
    const advice = cureAdvice(cure, health.called) || recoveringLine(stage, state.debt.covenant.compliantCloses, health.metrics.compliant, owed, health.called);
    setText(this.cureText, advice);
    setHidden(this.cureBox, advice === '');
    setHidden(this.cureButton, this.cure === null);
    if (this.cure) setText(this.cureButton, this.cure.label);

    // The next payment, when the close won't have the cash for it.
    const estimate = estimateNextDebtService(state);
    const atClose = estimateCashAtClose(state);
    const warn = paymentWarning(estimate, atClose, state.day);
    setText(this.paymentWarn, warn);
    setHidden(this.paymentWarn, warn === '');

    // No more borrowing: the sweep and the countdown; or the called loans.
    const lastReport = state.finance.reports.at(-1);
    const lastClose = lastReport ? formatMonth(lastReport.year, lastReport.month) : null;
    const frozen = frozenView({
      lastSweep: lastReport?.debt?.sweep && lastClose ? { amount: lastReport.debt.sweep, close: lastClose } : null,
      nextSweep: estimateSweep(state),
      closesUntilCall: closesUntilAcceleration(state),
      called: state.debt.acceleration !== null ? acceleratedSchedule(state) : null,
      day: state.day,
      owed,
      frozen: stage === 'frozen',
    });
    setHidden(this.frozenBox, frozen === null);
    const frozenKey = JSON.stringify(frozen);
    if (frozen && frozenKey !== this.frozenKey) {
      this.frozenKey = frozenKey;
      setTone(this.frozenBox, frozen.tone);
      this.frozenItems.replaceChildren(
        ...frozen.items.map((item) => {
          const li = el('li', { attrs: { 'data-line': item.key, 'data-testid': `bank-frozen-${item.key}` } }, [el('span', { text: item.text })]);
          // What falls due at each close sits under the call itself.
          if (item.key === 'called' && frozen.due.length > 0) {
            this.frozenDue.replaceChildren(...frozen.due.map((d) => el('li', { text: d })));
            li.append(this.frozenDue);
          }
          return li;
        }),
      );
    }

    // The two checks and what the bank counts.
    this.debtRow.set(debtCheck(health.metrics));
    this.coverageRow.set(coverageCheck(health.metrics));
    this.figures.set(
      bankFigures(health.metrics, {
        credit: state.debt.credit.balance,
        term: owed - state.debt.credit.balance,
        estimate,
        cashAtClose: atClose,
        day: state.day,
        last: lastReport?.debt && lastClose ? { close: lastClose, debt: lastReport.debt } : null,
      }),
    );

    // Borrow more, Pay back and Emergency cash.
    this.refreshBorrow(state, health);
    this.refreshCredit(state, health);
    this.refreshLoans(state, health);
    this.applyPane();

    // What happens if I slip? Open by itself whenever the health isn't Good (on a change, so a player's toggle stays).
    const ladder = slipLadder(health);
    const ladderKey = JSON.stringify(ladder);
    if (ladderKey !== this.ladderKey) {
      this.ladderKey = ladderKey;
      this.ladder.replaceChildren(
        ...ladder.map((s) => {
          const li = el('li', { class: `bank-step${s.current ? ' is-current' : ''}`, attrs: { 'data-step': s.key } }, [
            el('strong', { text: s.name }),
            ` ${s.text}`,
            s.current ? el('span', { class: 'bank-here', text: 'You are here' }) : null,
          ]);
          if (s.current) li.setAttribute('aria-current', 'step');
          return li;
        }),
      );
    }
    setText(this.stepBack, stepBackLine(stage, state.debt.covenant.compliantCloses));
    if (health.level !== this.slipLevel) {
      const wasGood = this.slipLevel === null || this.slipLevel === 'good';
      if (slipOpenByDefault(health.level) && wasGood) this.slip.open = true;
      else if (!slipOpenByDefault(health.level) && this.slipLevel !== null) this.slip.open = false;
      this.slipLevel = health.level;
    }

    // Bank messages.
    const notices = bankNotices(state.notices);
    const key = notices.map((n) => n.id).join(',');
    if (key !== this.noticesKey) {
      this.noticesKey = key;
      setText(this.messagesSummary, messagesLabel(notices.length));
      this.noticeList.replaceChildren(
        ...notices.map((n) => el('li', { class: `bank-notice bank-notice-${n.tone}` }, [el('time', { class: 'bank-notice-date', text: n.date }), el('span', { text: n.text })])),
      );
      this.messages.hidden = notices.length === 0;
    }
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private runCure(): void {
    const action = this.cure;
    if (!action) return;
    for (const cmd of action.commands) {
      const result = this.session.dispatch(cmd);
      if (!result.ok) {
        this.toasts.show(`Nothing paid back: ${result.reason}`, 'err');
        this.refresh(true);
        return;
      }
    }
    this.toasts.show(action.done, 'ok');
    this.refresh(true);
  }

  private borrow(): void {
    const amount = parseAmount(this.termInput.value);
    if (amount === null) {
      this.showError(this.termError, ENTER_AMOUNT);
      return;
    }
    const years = this.termYears;
    const result = this.session.dispatch({ type: 'takeTermLoan', amount, termYears: years });
    if (!result.ok) {
      this.showError(this.termError, `No loan taken: ${result.reason}`);
      return;
    }
    this.hideError(this.termError);
    const loan = this.session.state.debt.loans.at(-1);
    const terms = loan ? ` at ${plainRate(loan.rateBps)}: ${formatMoney(loan.payment)} a month` : '';
    this.toasts.show(`Borrowed ${formatMoney(amount)} over ${years} years${terms}`, 'ok');
    this.termDirty = false;
    this.otherMode = false;
    this.termDefaultKey = '';
    this.refresh(true);
  }

  private draw(): void {
    const amount = parseAmount(this.drawInput.value);
    if (amount === null) {
      this.showError(this.drawError, ENTER_AMOUNT);
      return;
    }
    const result = this.session.dispatch({ type: 'drawCredit', amount });
    if (!result.ok) {
      this.showError(this.drawError, `Nothing taken: ${result.reason}`);
      return;
    }
    this.hideError(this.drawError);
    this.drawInput.value = '';
    this.toasts.show(`Took ${formatMoney(amount)} of emergency cash`, 'ok');
    this.refresh(true);
  }

  private repay(): void {
    const amount = parseAmount(this.repayInput.value);
    if (amount === null) {
      this.showError(this.repayError, ENTER_AMOUNT);
      return;
    }
    const result = this.session.dispatch({ type: 'repayCredit', amount });
    if (!result.ok) {
      this.showError(this.repayError, `Nothing paid back: ${result.reason}`);
      return;
    }
    this.hideError(this.repayError);
    this.repayInput.value = '';
    this.toasts.show(`Paid back ${formatMoney(amount)} of emergency cash`, 'ok');
    this.refresh(true);
  }

  private prepay(id: LoanId, dom: LoanDom): void {
    const amount = parseAmount(dom.input.value);
    if (amount === null) {
      setText(dom.error, ENTER_AMOUNT);
      dom.error.hidden = false;
      this.toasts.show(ENTER_AMOUNT, 'err');
      return;
    }
    const quote = quotePrepay(this.session.state, id, amount);
    const result = this.session.dispatch({ type: 'prepayLoan', loan: id, amount });
    if (!result.ok) {
      const message = `Nothing paid: ${result.reason}`;
      setText(dom.error, message);
      dom.error.hidden = false;
      this.toasts.show(message, 'err');
      return;
    }
    dom.error.hidden = true;
    dom.input.value = '';
    dom.typed = false;
    dom.filledFor = -1;
    dom.form.hidden = true;
    setAttr(dom.toggle, 'aria-expanded', 'false');
    this.toasts.show(
      quote.paysOff ? `Loan ${id} paid off for ${formatMoney(result.cost)}` : `Paid ${formatMoney(amount)} off loan ${id} (${formatMoney(result.cost)} with interest)`,
      'ok',
    );
    this.refresh(true);
  }
}
