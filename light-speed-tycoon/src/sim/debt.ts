// Financing (round 3): a revolving credit line, fixed-rate term loans,
// underwriting on recurring revenue, risk-based pricing, covenants that
// escalate, and default. Round 4: smoothed lending ARR, the frozen-line
// sweep, the bank calling the loans (acceleration), same-month loans priced
// together, and the pro forma reads the Bank, quote cards and advisor use
// (quoteDraw, maxSafeTermLoan, fundingHint, cureOptions, estimateSweep).
//
// Owner: sim-debt workstream. Arithmetic only (README): no Math.pow, so
// compounding is repeated multiplication.
//
// Units: whole dollars, days, rates in whole basis points (bps). Interest:
//   credit line   round(balanceDollarDays x effective bps / (10,000 x DAYS_PER_YEAR))
//                 at each close (end-of-day balances, actual/365)
//   term loan     round(balance x effective bps / 120,000) per regular monthly payment
//   stub / accrued round(balance x effective bps x days / (10,000 x DAYS_PER_YEAR))
// where effective bps = rate bps + penaltyBps(stage) (the stage during the month).
//
// Daily (game.tick): at the START of each tick, before the day advances and
// before any close, endDebtDay(state) adds the credit-line balance to
// balanceDollarDays (the end-of-day balance of state.day) and posts the
// 'paymentDue' reminder when due.
//
// Month close (finance.closeMonth), in order:
//   1. pole rent; 2. overhead; 3. sales.closeSalesMonth   (unchanged)
//   4. debt.closeDebtMonth(state, lastDay): debt service (called loans: what
//      falls due), then the frozen-line sweep, dated lastDay
//   5. totals, report (stats), append, clear monthToDate  (unchanged)
//   6. milestones.checkMilestones                         (unchanged)
//   7. debt.reviewDebt(state, report, close): default / missed payment /
//      covenant review, notices, credit-line re-pricing, the frozen-close
//      count and the call (acceleration), report.debt
//   8. finance.checkInsolvency                            (no-op once gameOver)
// Operating cash flow (metrics.operatingCashFlow) excludes financing
// (FINANCING_CATEGORIES) as well as capex; net cash flow (report.net)
// includes it; CPP (capex.osp) is untouched by debt.
//
// Cost of the reads (for the UI and the bots): creditOffer, termCapacity and
// estimateNextDebtService are O(loans + ARR_TRAILING_MONTHS), covenantMetrics
// O(12 x loans + ARR_TRAILING_MONTHS) (a year of each loan's schedule);
// quoteTermLoan adds pricingCpp (getService, memoized on network.version and
// day), one amortization schedule (termYears x 12 steps) and the safe-maximum
// bisection (about log2(capacity / LOAN_ROUNDING) pro formas of one level
// payment each, on one covenant base); quotePrepay one level-payment loop
// (monthsLeft steps); fundingHint and cureOptions a few such bisections.

import {
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  ARR_SPIKE_CAP,
  ARR_TRAILING_MONTHS,
  BASE_RATE_BPS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_SPREAD_BPS,
  CREDIT_LIMIT_ARR_MULTIPLE,
  CREDIT_LINE_EXTRA_BPS,
  FROZEN_ACCELERATION_CLOSES,
  FROZEN_SWEEP_RESERVE,
  FROZEN_SWEEP_SHARE,
  FUNDING_CUSHION_MONTHS,
  LATE_FEE_MIN,
  LATE_FEE_SHARE,
  LEVERAGE_SPREAD_BANDS,
  LEVERAGE_SPREAD_MAX_BPS,
  LOAN_ROUNDING,
  OVERHEAD_PER_MONTH,
  PAYMENT_REMINDER_DAYS,
  PENALTY_STEP_UP_BPS,
  TERM_CAPACITY_ARR_MULTIPLE,
  TERM_EXTRA_BPS,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  UNDERWRITING_MIN_MARGIN,
} from './balance';
import { dateOf, DAYS_PER_YEAR, formatMonth, isFirstOfMonth, MONTH_ABBR, MONTH_LENGTHS } from './calendar';
import { estimateCashAtClose, estimateMonthOperatingCashFlow, formatMoney, monthOperatingCashFlow, postEntry, postEntryOn } from './finance';
import { costPerPassing, cppBand, operatingCashFlow, trailingRepairs } from './metrics';
import { getService } from './network';
import { postNotice } from './notices';
import type {
  Command,
  CommandResult,
  CovenantMetrics,
  CovenantStage,
  CreditOffer,
  CureOption,
  Debt,
  DrawQuote,
  FundingHint,
  GameState,
  LoanId,
  MonthlyReport,
  PrepayQuote,
  RateBreakdown,
  RateParts,
  RepricedLoan,
  TermLoan,
  TermLoanQuote,
  TermYears,
} from './types';

// ---------------------------------------------------------------------------
// State helpers (implemented by the contract)
// ---------------------------------------------------------------------------

/**
 * Debt state for a new game and for saves migrated from schemaVersion 2:
 * nothing drawn, no loans, nextLoanId 1, covenant 'compliant' with 0
 * compliant closes, and the credit line priced at base + product (no
 * leverage, no CPP spread) until the first close re-prices it. Round 4: no
 * frozen closes, no acceleration.
 */
export function newDebt(): Debt {
  return {
    credit: {
      balance: 0,
      rate: { baseBps: BASE_RATE_BPS, leverageBps: 0, cppBps: 0, productBps: CREDIT_LINE_EXTRA_BPS },
      balanceDollarDays: 0,
    },
    loans: [],
    nextLoanId: 1,
    covenant: { stage: 'compliant', compliantCloses: 0 },
    frozenCloses: 0,
    acceleration: null,
  };
}

/** Credit-line balance plus every term loan's balance, whole dollars. */
export function totalDebt(state: GameState): number {
  let total = state.debt.credit.balance;
  for (const loan of state.debt.loans) total += loan.balance;
  return total;
}

/** A rate from its parts: baseBps + leverageBps + cppBps + productBps (no penalty). */
export function rateOf(parts: RateParts): number {
  return parts.baseBps + parts.leverageBps + parts.cppBps + parts.productBps;
}

/** The surcharge every balance pays at this stage: PENALTY_STEP_UP_BPS for 'penalty' and 'frozen', else 0. */
export function penaltyBps(stage: CovenantStage): number {
  return stage === 'penalty' || stage === 'frozen' ? PENALTY_STEP_UP_BPS : 0;
}

/**
 * Lending ARR: annualized recurring revenue of the trailing closed months,
 * smoothed (round 4). Over the revenue totals (totals.revenue) of the last
 * n = min(ARR_TRAILING_MONTHS, reports.length) closed months:
 *   round(12 x min(their mean, ARR_SPIKE_CAP x the lowest of them)), >= 0;
 * 0 before the first close. The cap keeps a one-month price spike from
 * inflating borrowing capacity, while equal months and honest growth of a
 * few percent a month count in full. Closed months only, so it (and every
 * capacity built on it) only changes at a month close. The Bank calls it
 * "lending ARR"; the HUD's run-rate (MRR) is a different figure.
 */
export function trailingArr(state: GameState): number {
  const reports = state.finance.reports;
  const n = Math.min(ARR_TRAILING_MONTHS, reports.length);
  if (n === 0) return 0;
  let revenue = 0;
  let lowest = Number.POSITIVE_INFINITY;
  for (let i = reports.length - n; i < reports.length; i++) {
    const month = (reports[i] as MonthlyReport).totals.revenue ?? 0;
    revenue += month;
    if (month < lowest) lowest = month;
  }
  const annualMean = (revenue * 12) / n;
  const annualCap = ARR_SPIKE_CAP * lowest * 12;
  return Math.max(0, round(Math.min(annualMean, annualCap)));
}

/** Credit-line limit: trailingArr x CREDIT_LIMIT_ARR_MULTIPLE, rounded down to a multiple of LOAN_ROUNDING. */
export function creditLimit(state: GameState): number {
  return Math.floor((trailingArr(state) * CREDIT_LIMIT_ARR_MULTIPLE) / LOAN_ROUNDING) * LOAN_ROUNDING;
}

/**
 * What a draw may take now: max(0, creditLimit - balance); 0 while the
 * covenant stage is 'frozen' or (round 4) while the bank has called the
 * loans (debt.acceleration: no new borrowing until everything is repaid).
 */
export function creditAvailable(state: GameState): number {
  if (state.debt.covenant.stage === 'frozen' || state.debt.acceleration !== null) return 0;
  return Math.max(0, creditLimit(state) - state.debt.credit.balance);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** 10,000 bps x DAYS_PER_YEAR: the divisor of day-count interest. */
const DAY_INTEREST_DIVISOR = 10_000 * DAYS_PER_YEAR;
/** 10,000 bps x 12 months: the divisor of a monthly payment's interest. */
const MONTH_INTEREST_DIVISOR = 120_000;
/**
 * Compounding factors past this are as good as infinite: f / (f - 1) is
 * exactly 1 in floating point long before, and multiplying further would
 * overflow (only reachable with absurd rates and terms from a loaded save).
 */
const FACTOR_CAP = 1e100;

/** Math.round without a -0 (JSON writes -0 as 0, so a save would not round-trip it). */
function round(x: number): number {
  return Math.round(x) + 0;
}

/** Interest on `dollarDays` (balance x days) at `bps` a year, actual/365, whole dollars. */
function dayCountInterest(dollarDays: number, bps: number): number {
  return round((dollarDays * bps) / DAY_INTEREST_DIVISOR);
}

/** One month's interest on `balance` at `bps` a year (a regular payment's interest), whole dollars. */
function monthInterest(balance: number, bps: number): number {
  return round((balance * bps) / MONTH_INTEREST_DIVISOR);
}

/** First day of the month `day` falls in. */
function monthStart(day: number): number {
  return day - dateOf(day).day + 1;
}

/** A whole number of dollars, at least 1. */
function isWholeDollars(amount: unknown): amount is number {
  return typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 1;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return String(value);
  return value === null ? 'null' : typeof value;
}

/** 725 -> "7.25%" (whole-number arithmetic, no float formatting). */
export function formatRateBps(bps: number): string {
  const v = round(bps);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

/** The multiplication sign the UI writes multiples with (ui/format.formatRatio), so sim reasons and UI figures read alike. */
const TIMES = '\u00d7';

/** 4.123 -> "4.12×", -0.5 -> "-0.50×". */
export function formatMultiple(x: number): string {
  const v = round(x * 100);
  const sign = v < 0 ? '-' : '';
  const abs = Math.abs(v);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}${TIMES}`;
}

/** A capacity multiple for prose: 0.5 -> "0.5×", 3 -> "3×", 1.25 -> "1.25×". */
function shortMultiple(x: number): string {
  const v = round(x * 100);
  if (v % 100 === 0) return `${v / 100}${TIMES}`;
  if (v % 10 === 0) return `${Math.floor(v / 100)}.${(v % 100) / 10}${TIMES}`;
  return formatMultiple(x);
}

/** "5 or 7" */
function joinOr(items: readonly (string | number)[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} or ${String(items[items.length - 1])}`;
}

function termBalances(state: GameState): number {
  let owed = 0;
  for (const loan of state.debt.loans) owed += loan.balance;
  return owed;
}

/** "Feb 1": the next month close after `day` (the 1st of the month after it). */
function closeDate(day: number): string {
  return `${MONTH_ABBR[dateOf(day).month % 12] as string} 1`;
}

/** "1 compliant close", "2 compliant closes" */
function closes(n: number, what: string): string {
  return `${n} ${what}${n === 1 ? '' : 's'}`;
}

function reject(reason: string): CommandResult {
  return { ok: false, reason };
}

/**
 * Why nothing can be borrowed while frozen, and how to lift it. With nothing
 * owed the next month close lifts it (reviewDebt), so that is what it says.
 * Round 4: it names the frozen-line sweep and the countdown to the call (or,
 * once the loans are called, what that means).
 */
export function frozenReason(state: GameState): string {
  if (totalDebt(state) === 0) {
    return (
      'Your credit line is frozen after a covenant breach or a missed payment, but you owe nothing now: ' +
      `the bank lifts the freeze and the penalty rate at the next month close (the ${closeDate(state.day)} close). ` +
      'No draws or new term loans until then.'
    );
  }
  return (
    'Your credit line is frozen after a covenant breach or a missed payment: no draws or new term loans until it cures. ' +
    `${closes(COVENANT_CURE_CLOSES, 'month close')} in a row with every payment made, leverage at most ` +
    `${formatMultiple(COVENANT_MAX_LEVERAGE)} and debt-service coverage at least ${formatMultiple(COVENANT_MIN_COVERAGE)} lift the freeze ` +
    `(repaying and prepaying still work). ${frozenConsequences(state)}`
  );
}

/** "While it lasts, the bank takes 50% ... (4 more frozen closes)." or what the call means once it came. */
function frozenConsequences(state: GameState): string {
  const acceleration = state.debt.acceleration;
  if (acceleration !== null) return calledSentence(state, acceleration.closesLeft);
  const left = closesUntilAcceleration(state) ?? FROZEN_ACCELERATION_CLOSES;
  return (
    `While it lasts, the bank takes ${sweepShare()} of each month's positive operating cash flow to repay what you owe, ` +
    `and after ${FROZEN_ACCELERATION_CLOSES} frozen closes in a row it calls the loans ` +
    `(${left === 0 ? 'at the next close' : `${closes(left, 'more frozen close')}`}).`
  );
}

/** "50%" */
function sweepShare(): string {
  return `${round(FROZEN_SWEEP_SHARE * 100)}%`;
}

/** "The bank has called your loans: everything you owe ($91,000) falls due over the next 2 closes, and a close that cannot pay is a default." */
function calledSentence(state: GameState, closesLeft: number): string {
  const over = closesLeft <= 1 ? 'at the next close' : `over the next ${closesLeft} closes`;
  return (
    `The bank has called your loans: everything you owe (${formatMoney(totalDebt(state))}) falls due ${over}, ` +
    'and a close that cannot pay what falls due is a default that ends the game.'
  );
}

/** Why nothing can be borrowed once the loans are called (round 4). */
export function acceleratedReason(state: GameState): string {
  const left = state.debt.acceleration?.closesLeft ?? 1;
  return `No new borrowing: ${calledSentence(state, left).replace(/^The bank/, 'the bank')} Repaying and prepaying still work.`;
}

function noCreditLineReason(): string {
  return (
    'No credit line yet: the bank lends against recurring revenue, so sign up subscribers first ' +
    `(the limit is ${shortMultiple(CREDIT_LIMIT_ARR_MULTIPLE)} your lending ARR: the revenue of your last closed months, annualized and smoothed).`
  );
}

function lineFullReason(limit: number, balance: number): string {
  if (balance > limit) {
    return `The credit line is over its limit (${formatMoney(balance)} drawn on a ${formatMoney(limit)} limit): repay some to draw again.`;
  }
  return `The credit line is fully drawn (${formatMoney(balance)} of ${formatMoney(limit)}): repay some, or grow revenue to raise the limit.`;
}

// ---------------------------------------------------------------------------
// Underwriting and covenants
// ---------------------------------------------------------------------------

/**
 * Annualized operating cash flow of the trailing closed months (the same
 * window as trailingArr): sum of (metrics.operatingCashFlow(report) - its
 * 'repair' total) x 12 / count, plus the 'repair' totals of the last
 * metrics.REPAIR_TRAILING_MONTHS closed months at face value
 * (metrics.trailingRepairs), rounded; 0 before the first close. May be negative.
 * Round 4: repairs are one-off and lumpy (a storm month), so they count once,
 * at what they cost over the past year, instead of being annualized from a
 * three-month window (a $7k storm month would otherwise cut the lender's
 * cash flow by $28k for a quarter and could breach a covenant on its own).
 */
export function annualOperatingCashFlow(state: GameState): number {
  const reports = state.finance.reports;
  const n = Math.min(ARR_TRAILING_MONTHS, reports.length);
  if (n === 0) return 0;
  let flow = 0;
  for (let i = reports.length - n; i < reports.length; i++) {
    const report = reports[i] as MonthlyReport;
    flow += operatingCashFlow(report) - (report.totals.repair ?? 0);
  }
  return round((flow * 12) / n + trailingRepairs(reports));
}

/**
 * Debt service scheduled over the next 12 months at today's effective rates:
 * for each loan its next min(12, monthsLeft) regular payments exactly as the
 * closes will charge them while the stage holds (scheduledPayments: the last
 * one repays whatever balance is left), plus round(credit balance x (line
 * rate + penalty) / 10,000) for the line (a year of interest at today's
 * balance). A loan's stub interest is ignored.
 * Round 4, once the bank has called the loans: each loan as the closes will
 * charge it (chargedLoan: at most closesLeft payments), and the line's
 * balance repaid over the closes left with a month's interest at each
 * (acceleratedLine), so the figure is everything that falls due.
 */
export function annualDebtService(state: GameState): number {
  const { credit, loans, covenant, acceleration } = state.debt;
  const penalty = penaltyBps(covenant.stage);
  const lineBps = rateOf(credit.rate) + penalty;
  let service = acceleration !== null ? sumDue(acceleratedLine(credit.balance, lineBps, acceleration.closesLeft)) : round((credit.balance * lineBps) / 10_000);
  for (const raw of loans) {
    const loan = chargedLoan(state, raw);
    service += scheduledPayments(loan, loan.rateBps + penalty, Math.min(12, loan.monthsLeft));
  }
  return service;
}

/** One close's share of a called credit line: a month's interest and the principal that falls due. */
interface LineDue {
  interest: number;
  principal: number;
}

function sumDue(parts: readonly LineDue[]): number {
  let total = 0;
  for (const part of parts) total += part.interest + part.principal;
  return total;
}

/**
 * Principal of a called credit line that falls due at a close with
 * `closesLeft` closes to go: ceil(balance / closesLeft), all of it when one
 * is left (a closesLeft below 1 counts as 1).
 */
export function calledLinePrincipal(balance: number, closesLeft: number): number {
  if (balance <= 0) return 0;
  return closesLeft <= 1 ? balance : Math.ceil(balance / closesLeft) + 0;
}

/**
 * What a called credit line of `balance` falls due at each of the
 * `closesLeft` closes to go if nothing else changes: the principal
 * (calledLinePrincipal) and a month's interest on the balance before it
 * (round(balance x bps / 120,000); the close itself charges actual days).
 */
function acceleratedLine(balance: number, bps: number, closesLeft: number): LineDue[] {
  const parts: LineDue[] = [];
  let left = balance;
  for (let k = Math.max(1, closesLeft); k >= 1 && left > 0; k--) {
    const principal = calledLinePrincipal(left, k);
    parts.push({ interest: monthInterest(left, bps), principal });
    left -= principal;
  }
  return parts;
}

/**
 * A loan as the next close will charge it: itself, except once the bank has
 * called the loans and it has more months left than closes (a loaded save,
 * or the close right after the call re-sets nothing), when it is due over
 * the closes left: monthsLeft = closesLeft, payment = levelPayment over them
 * at the effective rate. closeDebtMonth applies exactly this. Pure.
 */
function chargedLoan(state: GameState, loan: TermLoan): TermLoan {
  const acceleration = state.debt.acceleration;
  if (acceleration === null || loan.monthsLeft <= acceleration.closesLeft) return loan;
  const months = Math.max(1, acceleration.closesLeft);
  return { ...loan, monthsLeft: months, payment: levelPayment(loan.balance, loan.rateBps + penaltyBps(state.debt.covenant.stage), months) };
}

/**
 * Once the bank has called the loans: what falls due at each of the closes
 * left (index 0 = the next close), at today's balances and effective rates:
 * the line (acceleratedLine) plus each loan's scheduled payments (chargedLoan,
 * amortized exactly). Empty when the loans are not called or nothing is
 * owed. The 'loansCalled' notice, the Bank and the HUD show it.
 */
export function acceleratedSchedule(state: GameState): number[] {
  const { credit, loans, covenant, acceleration } = state.debt;
  if (acceleration === null || totalDebt(state) === 0) return [];
  const penalty = penaltyBps(covenant.stage);
  const closesLeft = Math.max(1, acceleration.closesLeft);
  const due: number[] = new Array<number>(closesLeft).fill(0);
  acceleratedLine(credit.balance, rateOf(credit.rate) + penalty, closesLeft).forEach((part, i) => {
    due[i] = (due[i] as number) + part.interest + part.principal;
  });
  for (const raw of loans) {
    const loan = chargedLoan(state, raw);
    const effective = loan.rateBps + penalty;
    let balance = loan.balance;
    for (let k = 0; k < closesLeft && balance > 0; k++) {
      const { interest, principal } = paymentParts(balance, loan.monthsLeft - k, loan.payment, effective);
      due[k] = (due[k] as number) + interest + principal;
      balance -= principal;
    }
  }
  while (due.length > 0 && due[due.length - 1] === 0) due.pop();
  return due;
}

/** x to the hundredth, as the UI and report.debt show it: round(x x 100) / 100 (held to safe integers). */
function hundredth(x: number): number {
  return safeX100(x) / 100;
}

/** Leverage to the hundredth: 0 with no debt, null (unmeasurable) when there is debt and no positive cash flow. */
function leverageOf(debt: number, underwritingCashFlow: number): number | null {
  if (debt === 0) return 0;
  return underwritingCashFlow > 0 ? hundredth(debt / underwritingCashFlow) : null;
}

/**
 * A hypothetical change for covenantMetrics: extra debt (negative: repaid)
 * and its yearly debt service, and (round 4, cure advice) extra annual
 * operating cash flow.
 */
export interface ProForma {
  addDebt: number;
  addAnnualDebtService: number;
  addAnnualOperatingCashFlow?: number;
}

/** The figures covenantMetrics starts from, read once (bisections evaluate many pro formas on one base). */
interface MetricsBase {
  debt: number;
  arr: number;
  ocf: number;
  service: number;
}

function metricsBase(state: GameState): MetricsBase {
  return { debt: totalDebt(state), arr: trailingArr(state), ocf: annualOperatingCashFlow(state), service: annualDebtService(state) };
}

/**
 * The covenant tests on today's debt (plus `proForma`, if given) against the
 * trailing cash flows: see CovenantMetrics for every field. Leverage = total
 * debt / max(annualOperatingCashFlow, trailingArr x UNDERWRITING_MIN_MARGIN)
 * (0 with no debt; null, a breach, when debt > 0 and that is <= 0); coverage
 * = the same cash flow / annualDebtService (null when nothing is scheduled).
 * Both are rounded to the hundredth once, here, and tested, priced and shown
 * at that figure (a leverage that reads 5.00x is within the 5x limit).
 * Limits: COVENANT_MAX_LEVERAGE, COVENANT_MIN_COVERAGE. Pure read.
 */
export function covenantMetrics(state: GameState, proForma?: ProForma): CovenantMetrics {
  return metricsOf(metricsBase(state), proForma);
}

/** covenantMetrics from its base figures. */
function metricsOf(base: MetricsBase, proForma?: ProForma): CovenantMetrics {
  const debt = base.debt + (proForma?.addDebt ?? 0);
  const arr = base.arr;
  const ocf = base.ocf + (proForma?.addAnnualOperatingCashFlow ?? 0);
  const underwritingCashFlow = Math.max(ocf, arr * UNDERWRITING_MIN_MARGIN);
  const service = base.service + (proForma?.addAnnualDebtService ?? 0);
  const leverage = leverageOf(debt, underwritingCashFlow);
  const coverage = service === 0 ? null : hundredth(underwritingCashFlow / service);
  const leverageOk = debt === 0 || (leverage !== null && leverage <= COVENANT_MAX_LEVERAGE);
  const coverageOk = service === 0 || (coverage !== null && coverage >= COVENANT_MIN_COVERAGE);
  return {
    totalDebt: debt,
    arr,
    annualOperatingCashFlow: ocf,
    underwritingCashFlow,
    annualDebtService: service,
    leverage,
    coverage,
    leverageOk,
    coverageOk,
    compliant: leverageOk && coverageOk,
  };
}

/** Leverage spread in bps: the first LEVERAGE_SPREAD_BANDS entry with leverage <= maxLeverage; LEVERAGE_SPREAD_MAX_BPS above them or for null (unmeasurable). */
export function leverageSpreadBps(leverage: number | null): number {
  if (leverage === null) return LEVERAGE_SPREAD_MAX_BPS;
  for (const band of LEVERAGE_SPREAD_BANDS) if (leverage <= band.maxLeverage) return band.spreadBps;
  return LEVERAGE_SPREAD_MAX_BPS;
}

/**
 * Lifetime cost per passing the lender prices on: metrics.costPerPassing(
 * finance.capex.osp, getService(state).passings) (the HUD's figure); null
 * while nothing is passed (no CPP spread).
 */
export function pricingCpp(state: GameState): number | null {
  return costPerPassing(state.finance.capex.osp, getService(state).passings);
}

/** Which product a rate is for: the credit line, or a term loan of `years`. */
export type DebtProduct = { kind: 'line' } | { kind: 'term'; years: TermYears };

/**
 * Price `product` at `leverage` and `cpp`: base BASE_RATE_BPS, leverage
 * leverageSpreadBps(leverage), CPP CPP_SPREAD_BPS[cppBand(cpp)] (0 for a null
 * cpp), product CREDIT_LINE_EXTRA_BPS or TERM_EXTRA_BPS[years] (0 for a term
 * not on offer); penalty penaltyBps(stage) for the stage given. Pure.
 */
export function priceRate(product: DebtProduct, leverage: number | null, cpp: number | null, stage: CovenantStage): RateBreakdown {
  const leverageBps = leverageSpreadBps(leverage);
  const band = cpp === null ? null : cppBand(cpp);
  const cppBps = band === null ? 0 : CPP_SPREAD_BPS[band];
  // A term not on offer (only reachable by calling with junk) adds nothing.
  const termExtra: unknown = product.kind === 'term' ? TERM_EXTRA_BPS[product.years] : undefined;
  const productBps = product.kind === 'line' ? CREDIT_LINE_EXTRA_BPS : typeof termExtra === 'number' ? termExtra : 0;
  const penalty = penaltyBps(stage);
  const rateBps = BASE_RATE_BPS + leverageBps + cppBps + productBps;
  return {
    baseBps: BASE_RATE_BPS,
    leverageBps,
    cppBps,
    productBps,
    penaltyBps: penalty,
    rateBps,
    effectiveRateBps: rateBps + penalty,
    leverage,
    cpp,
    cppBand: band,
  };
}

// ---------------------------------------------------------------------------
// Amortization
// ---------------------------------------------------------------------------

/**
 * Level monthly payment that repays `amount` over `months` at `rateBps` a
 * year: r = rateBps / 120,000; with r = 0, ceil(amount / months); else
 * ceil(amount x r x f / (f - 1)) with f = (1 + r)^months by repeated
 * multiplication. Whole dollars >= 1 (for amount >= 1, months >= 1); 0 for an
 * amount that is not a positive number. A months count below 1 (or not a
 * number) is taken as 1, a fraction rounded down; a negative or non-finite
 * rate as 0.
 */
export function levelPayment(amount: number, rateBps: number, months: number): number {
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  const n = Number.isFinite(months) && months >= 1 ? Math.floor(months) : 1;
  const r = Number.isFinite(rateBps) && rateBps > 0 ? rateBps / MONTH_INTEREST_DIVISOR : 0;
  if (r === 0) return Math.ceil(amount / n) + 0;
  let f = 1;
  for (let i = 0; i < n; i++) {
    f *= 1 + r;
    if (f > FACTOR_CAP) return Math.ceil(amount * r) + 0;
  }
  return Math.ceil((amount * r * f) / (f - 1)) + 0;
}

/** One regular payment of an exact schedule. */
export interface ScheduledPayment {
  interest: number;
  principal: number;
  /** Balance after the payment (0 after the last). */
  balance: number;
}

/**
 * The exact whole-dollar schedule of `months` regular payments of `payment`
 * on `amount` at `rateBps` (no penalty): each interest = round(balance x
 * rateBps / 120,000), principal = min(balance, max(0, payment - interest)),
 * and the last payment repays whatever balance remains (the remainder lands
 * on it). Principal parts sum exactly to `amount`. Pure. Empty for months < 1.
 */
export function amortize(amount: number, rateBps: number, months: number, payment: number): ScheduledPayment[] {
  const schedule: ScheduledPayment[] = [];
  const n = Number.isFinite(months) ? Math.floor(months) : 0;
  let balance = amount;
  for (let m = 1; m <= n; m++) {
    const interest = monthInterest(balance, rateBps);
    const principal = m === n ? balance : Math.min(balance, Math.max(0, payment - interest));
    balance -= principal;
    schedule.push({ interest, principal, balance });
  }
  return schedule;
}

/**
 * Days a balance taken on `day` is held through the end of that month,
 * inclusive (end-of-day balances): last day of day's month - day + 1. The
 * stub period of a term loan taken that day.
 */
export function stubDays(day: number): number {
  const date = dateOf(day);
  return (MONTH_LENGTHS[date.month - 1] as number) - date.day + 1;
}

// ---------------------------------------------------------------------------
// Offers and quotes (pure reads)
// ---------------------------------------------------------------------------

/**
 * Most a new term loan may be now: floor to LOAN_ROUNDING of trailingArr x
 * TERM_CAPACITY_ARR_MULTIPLE minus the term balances owed; 0 when that is
 * below TERM_LOAN_MIN, the stage is 'frozen' or (round 4) the bank has
 * called the loans.
 */
export function termCapacity(state: GameState): number {
  if (state.debt.covenant.stage === 'frozen' || state.debt.acceleration !== null) return 0;
  const room = trailingArr(state) * TERM_CAPACITY_ARR_MULTIPLE - termBalances(state);
  const capacity = Math.floor(room / LOAN_ROUNDING) * LOAN_ROUNDING;
  return capacity >= TERM_LOAN_MIN ? capacity : 0;
}

/** The credit line today: see CreditOffer. */
export function creditOffer(state: GameState): CreditOffer {
  const { credit, covenant } = state.debt;
  const limit = creditLimit(state);
  const available = creditAvailable(state);
  const frozen = covenant.stage === 'frozen';
  const last = state.finance.reports.at(-1);
  // What the last close priced the line on (0 / null before the first close).
  const leverage = last?.debt ? (last.debt.leverageX100 === null ? null : last.debt.leverageX100 / 100) : 0;
  const cpp = last?.stats && last.passings > 0 ? last.stats.capexOsp / last.passings : null;
  const penalty = penaltyBps(covenant.stage);
  const rateBps = rateOf(credit.rate);
  const reasons: string[] = [];
  if (available === 0) {
    if (frozen) reasons.push(frozenReason(state));
    else if (state.debt.acceleration !== null) reasons.push(acceleratedReason(state));
    else if (limit === 0) reasons.push(noCreditLineReason());
    else reasons.push(lineFullReason(limit, credit.balance));
  }
  return {
    limit,
    balance: credit.balance,
    available,
    maxRepay: Math.min(credit.balance, Math.max(0, state.finance.cash)),
    frozen,
    rate: {
      baseBps: credit.rate.baseBps,
      leverageBps: credit.rate.leverageBps,
      cppBps: credit.rate.cppBps,
      productBps: credit.rate.productBps,
      penaltyBps: penalty,
      rateBps,
      effectiveRateBps: rateBps + penalty,
      leverage,
      cpp,
      cppBand: cpp === null ? null : cppBand(cpp),
    },
    accruedInterest: dayCountInterest(credit.balanceDollarDays, rateBps + penalty),
    arr: trailingArr(state),
    reasons,
  };
}

/**
 * What takeTermLoan(amount, termYears) would do now: see TermLoanQuote.
 * Never throws for bad input (a non-integer, a too-small amount, an unknown
 * term): ok false with a reason, figures for what can be computed (an amount
 * that is not a positive number counts as 0; an unknown term has
 * termMonths 0 and no payment). Rate: priceRate({ kind: 'term', years },
 * pro forma leverage (to the hundredth, as covenantMetrics shows it),
 * pricingCpp, stage). The payment and schedule are at the effective rate (the
 * penalty included while it lasts), as the loan would be set up today.
 * Round 4: same-month loans are priced together (termProForma): every term
 * loan originated this month is re-priced at the same leverage (repriced),
 * and `after` counts their new payments; safeMaxAmount is maxSafeTermLoan.
 * Reasons, most fundamental first: game over, term, amount not whole
 * dollars, frozen (or the loans called), no capacity, below TERM_LOAN_MIN,
 * above maxAmount.
 */
export function quoteTermLoan(state: GameState, amount: number, termYears: TermYears): TermLoanQuote {
  const knownTerm = TERM_LOAN_YEARS.includes(termYears);
  const termMonths = knownTerm ? termYears * 12 : 0;
  const whole = isWholeDollars(amount);
  const usable = typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 0;
  const frozen = state.debt.covenant.stage === 'frozen';
  const maxAmount = termCapacity(state);
  const base = metricsBase(state);
  const before = metricsOf(base);
  const cpp = pricingCpp(state);
  const pro = termProForma(state, base, cpp, usable, termYears, whole && knownTerm);
  const { rate, payment, repriced, after } = pro;
  const schedule = payment > 0 ? amortize(amount, rate.effectiveRateBps, termMonths, payment) : [];
  const final = schedule.at(-1);
  const stubInterest = dayCountInterest(usable * stubDays(state.day), rate.effectiveRateBps);
  let totalInterest = stubInterest;
  for (const step of schedule) totalInterest += step.interest;

  const reasons: string[] = [];
  if (state.gameOver) reasons.push('The game is over');
  if (!knownTerm) reasons.push(`Term must be ${joinOr(TERM_LOAN_YEARS)} years`);
  if (!whole) reasons.push(`A term loan must be a whole number of dollars (got ${describeValue(amount)})`);
  if (frozen) reasons.push(frozenReason(state));
  else if (state.debt.acceleration !== null) reasons.push(acceleratedReason(state));
  else if (maxAmount === 0) reasons.push(noTermCapacityReason(state));
  if (whole && amount < TERM_LOAN_MIN) reasons.push(`The smallest term loan is ${formatMoney(TERM_LOAN_MIN)}`);
  else if (whole && maxAmount > 0 && amount > maxAmount) reasons.push(overCapacityReason(state, maxAmount));

  return {
    ok: reasons.length === 0,
    reasons,
    amount,
    termYears,
    termMonths,
    maxAmount,
    rate,
    payment,
    lastPayment: final ? final.interest + final.principal : 0,
    stubInterest,
    totalInterest,
    before,
    after,
    breachesCovenant: !after.compliant,
    cashAfter: state.finance.cash + usable,
    repriced,
    safeMaxAmount: knownTerm ? safeTermMax(state, base, cpp, termYears, maxAmount) : 0,
  };
}

/** A new term loan, pro forma: what quoteTermLoan and maxSafeTermLoan both price. */
interface TermProForma {
  rate: RateBreakdown;
  /** Level payment at the effective rate; 0 when `payable` is false. */
  payment: number;
  repriced: RepricedLoan[];
  /** Covenants with the loan and the re-priced same-month loans (plus `extra`, if given). */
  after: CovenantMetrics;
}

/**
 * A term loan of `amount` (> 0) and `termYears` on top of `base` (plus
 * `extra` debt and yearly debt service already pro forma, e.g. a draw): the
 * rate on pro forma leverage leverageOf(debt + extra + amount, underwriting
 * cash flow) and `cpp`; its level payment over termYears x 12 at the
 * effective rate (when `payable`); every open loan originated this month
 * (originatedDay >= the 1st) re-priced at that leverage and cpp with its own
 * term's product adjustment, its payment re-set over its months left at the
 * effective rate (RepricedLoan, ascending id; only loans whose rate or
 * payment changes); and the covenants with all of it (the new loan's next
 * min(12, term) payments, each re-priced loan's change in scheduled
 * payments). Pure.
 */
function termProForma(
  state: GameState,
  base: MetricsBase,
  cpp: number | null,
  amount: number,
  termYears: TermYears,
  payable: boolean,
  extra: { debt: number; service: number } = { debt: 0, service: 0 },
): TermProForma {
  const stage = state.debt.covenant.stage;
  const penalty = penaltyBps(stage);
  const ocf = Math.max(base.ocf, base.arr * UNDERWRITING_MIN_MARGIN);
  const leverage = leverageOf(base.debt + extra.debt + amount, ocf);
  const rate = priceRate({ kind: 'term', years: termYears }, leverage, cpp, stage);
  const termMonths = TERM_LOAN_YEARS.includes(termYears) ? termYears * 12 : 0;
  const payment = payable && termMonths > 0 ? levelPayment(amount, rate.effectiveRateBps, termMonths) : 0;
  let service = extra.service + payment * Math.min(12, termMonths);
  const repriced: RepricedLoan[] = [];
  const start = monthStart(state.day);
  for (const loan of state.debt.loans) {
    if (loan.originatedDay < start) continue;
    const years = (loan.termMonths / 12) as TermYears;
    const rateBpsAfter = priceRate({ kind: 'term', years }, leverage, cpp, stage).rateBps;
    const paymentAfter = levelPayment(loan.balance, rateBpsAfter + penalty, loan.monthsLeft);
    if (rateBpsAfter === loan.rateBps && paymentAfter === loan.payment) continue;
    repriced.push({ loan: loan.id, rateBps: loan.rateBps, rateBpsAfter, payment: loan.payment, paymentAfter });
    const months = Math.min(12, loan.monthsLeft);
    service +=
      scheduledPayments({ ...loan, rateBps: rateBpsAfter, payment: paymentAfter }, rateBpsAfter + penalty, months) -
      scheduledPayments(loan, loan.rateBps + penalty, months);
  }
  const after = metricsOf(base, { addDebt: extra.debt + amount, addAnnualDebtService: service });
  return { rate, payment, repriced, after };
}

/**
 * Round 4b: whether covenant figures `m` pass with `headroom` (a share,
 * 0..1) to spare: no debt or leverage measurable and at most
 * COVENANT_MAX_LEVERAGE x (1 - headroom), and nothing scheduled or coverage
 * at least COVENANT_MIN_COVERAGE x (1 + headroom). With headroom 0 exactly
 * m.compliant. The advisor's expand suggestion (EXPAND_COVENANT_HEADROOM)
 * and the Bank's starting loan (BANK_PREFILL_HEADROOM) use it.
 */
export function covenantsWithin(m: CovenantMetrics, headroom: number): boolean {
  const h = Number.isFinite(headroom) && headroom > 0 ? Math.min(headroom, 1) : 0;
  if (h === 0) return m.compliant;
  const leverageOk = m.totalDebt === 0 || (m.leverage !== null && m.leverage <= COVENANT_MAX_LEVERAGE * (1 - h));
  const coverageOk = m.annualDebtService === 0 || (m.coverage !== null && m.coverage >= COVENANT_MIN_COVERAGE * (1 + h));
  return leverageOk && coverageOk;
}

/**
 * The largest multiple of LOAN_ROUNDING in TERM_LOAN_MIN..capacity whose
 * termProForma covenants pass with `headroom` to spare (covenantsWithin;
 * compliance only falls as the amount grows: more debt, a higher payment, a
 * rate no lower), by bisection; 0 when none does. `extra` as termProForma.
 */
function safeTermMax(
  state: GameState,
  base: MetricsBase,
  cpp: number | null,
  termYears: TermYears,
  capacity: number,
  extra?: { debt: number; service: number },
  headroom = 0,
): number {
  if (state.gameOver || capacity < TERM_LOAN_MIN || !TERM_LOAN_YEARS.includes(termYears)) return 0;
  const safe = (amount: number): boolean => covenantsWithin(termProForma(state, base, cpp, amount, termYears, true, extra).after, headroom);
  let lo = Math.ceil(TERM_LOAN_MIN / LOAN_ROUNDING);
  let hi = Math.floor(capacity / LOAN_ROUNDING);
  if (hi < lo || !safe(lo * LOAN_ROUNDING)) return 0;
  // Invariant: lo is safe; everything above hi is not known to be.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (safe(mid * LOAN_ROUNDING)) lo = mid;
    else hi = mid - 1;
  }
  return lo * LOAN_ROUNDING;
}

function noTermCapacityReason(state: GameState): string {
  const arr = trailingArr(state);
  const multiple = shortMultiple(TERM_CAPACITY_ARR_MULTIPLE);
  if (arr === 0) {
    return `No term loans yet: the bank lends up to ${multiple} your lending ARR (trailing revenue, annualized and smoothed), so sign up subscribers first.`;
  }
  return (
    `No term-loan room left: the bank lends up to ${multiple} your lending ARR of ${formatMoney(arr)}, ` +
    `less the ${formatMoney(termBalances(state))} owed on term loans, and the smallest loan is ${formatMoney(TERM_LOAN_MIN)}.`
  );
}

function overCapacityReason(state: GameState, maxAmount: number): string {
  const owed = termBalances(state);
  const less = owed > 0 ? `, less the ${formatMoney(owed)} owed on term loans` : '';
  return (
    `The most the bank will lend now is ${formatMoney(maxAmount)} ` +
    `(${shortMultiple(TERM_CAPACITY_ARR_MULTIPLE)} your lending ARR of ${formatMoney(trailingArr(state))}${less})`
  );
}

/** Interest accrued on `amount` of `loan` since the later of its origination and the 1st of this month, at the effective rate. */
function accruedOn(state: GameState, loan: TermLoan, amount: number): number {
  const days = Math.max(0, state.day - Math.max(loan.originatedDay, monthStart(state.day)));
  return dayCountInterest(amount * days, loan.rateBps + penaltyBps(state.debt.covenant.stage));
}

/**
 * What prepayLoan(loan, amount) would take now: see PrepayQuote. Never throws
 * for bad input (an unknown loan, an amount that is not whole dollars: ok
 * false, accruedInterest 0 for an amount that is not a positive number).
 * Allowed while frozen.
 */
export function quotePrepay(state: GameState, loan: LoanId, amount: number): PrepayQuote {
  const found = state.debt.loans.find((l) => l.id === loan);
  const whole = isWholeDollars(amount);
  const usable = typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 0;
  const reasons: string[] = [];
  if (state.gameOver) reasons.push('The game is over');
  if (!found) {
    reasons.push(`There is no open term loan #${describeValue(loan)}`);
    if (!whole) reasons.push(`A prepayment must be a whole number of dollars, at least $1 (got ${describeValue(amount)})`);
    return { ok: false, reasons, loan, amount, accruedInterest: 0, total: usable, paysOff: false, paymentAfter: 0 };
  }
  const accruedInterest = usable > 0 ? accruedOn(state, found, usable) : 0;
  const total = usable + accruedInterest;
  const paysOff = whole && amount === found.balance;
  if (!whole) reasons.push(`A prepayment must be a whole number of dollars, at least $1 (got ${describeValue(amount)})`);
  else if (amount > found.balance) reasons.push(`Loan #${found.id} has only ${formatMoney(found.balance)} left to repay`);
  else if (state.finance.cash < total) {
    const interest = accruedInterest > 0 ? ` (${formatMoney(amount)} plus ${formatMoney(accruedInterest)} of accrued interest)` : '';
    reasons.push(`Not enough cash: need ${formatMoney(total)}${interest}, have ${formatMoney(state.finance.cash)}`);
  }
  // Re-amortized at the effective rate, like every level payment (TermLoan.payment).
  const effective = found.rateBps + penaltyBps(state.debt.covenant.stage);
  const paymentAfter = whole && amount < found.balance ? levelPayment(found.balance - amount, effective, found.monthsLeft) : 0;
  return { ok: reasons.length === 0, reasons, loan, amount, accruedInterest, total, paysOff, paymentAfter };
}

/**
 * A regular (non-stub) payment of level `payment` on `balance` with
 * `monthsLeft` payments to go, at `effectiveBps`: interest, and principal
 * (the whole balance on the last payment).
 */
function paymentParts(balance: number, monthsLeft: number, payment: number, effectiveBps: number): { interest: number; principal: number } {
  const interest = monthInterest(balance, effectiveBps);
  const principal = monthsLeft <= 1 ? balance : Math.min(balance, Math.max(0, payment - interest));
  return { interest, principal };
}

/** The next regular payment of `loan` at `effectiveBps` (TermLoan.payment doc). */
function regularPayment(loan: TermLoan, effectiveBps: number): { interest: number; principal: number } {
  return paymentParts(loan.balance, loan.monthsLeft, loan.payment, effectiveBps);
}

/**
 * The next `count` regular payments of `loan` at `effectiveBps` (the stage
 * held), summed, each exactly as closeDebtMonth would charge it; stops once
 * the balance is repaid. O(count).
 */
function scheduledPayments(loan: TermLoan, effectiveBps: number, count: number): number {
  let balance = loan.balance;
  let total = 0;
  for (let k = 0; k < count && balance > 0; k++) {
    const { interest, principal } = paymentParts(balance, loan.monthsLeft - k, loan.payment, effectiveBps);
    total += interest + principal;
    balance -= principal;
  }
  return total;
}

/**
 * What the last payment of `loan` will be if today's stage holds: the exact
 * schedule of its remaining payments at the effective rate (amortize). The
 * Bank lists it beside the level payment when they differ.
 */
export function finalPayment(state: GameState, loan: TermLoan): number {
  const final = amortize(loan.balance, loan.rateBps + penaltyBps(state.debt.covenant.stage), loan.monthsLeft, loan.payment).at(-1);
  return final ? final.interest + final.principal : 0;
}

/**
 * Estimate of the debt service the next close will charge: the line's
 * interest for the dollar-days so far plus today's balance for the rest of
 * the month (today included), and each loan's payment (its stub interest if
 * taken this month; the whole balance plus interest on its last payment), at
 * today's effective rates. Round 4: once the loans are called, the line's
 * principal that falls due (calledLinePrincipal) and each loan as the close
 * will charge it (chargedLoan, a regular payment even in its first month).
 * The frozen-line sweep is not debt service (it comes out of what is left;
 * see estimateSweep). For the Bank panel, the reminder and bots.
 */
export function estimateNextDebtService(state: GameState): number {
  const { interest, principal } = nextServiceParts(state);
  return interest + principal;
}

/** estimateNextDebtService in its interest and principal parts. */
function nextServiceParts(state: GameState): { interest: number; principal: number } {
  const { credit, loans, covenant, acceleration } = state.debt;
  const penalty = penaltyBps(covenant.stage);
  const start = monthStart(state.day);
  let interest = dayCountInterest(credit.balanceDollarDays + credit.balance * stubDays(state.day), rateOf(credit.rate) + penalty);
  let principal = acceleration !== null ? calledLinePrincipal(credit.balance, acceleration.closesLeft) : 0;
  for (const raw of loans) {
    const loan = chargedLoan(state, raw);
    const effective = loan.rateBps + penalty;
    if (acceleration === null && loan.originatedDay >= start) {
      interest += dayCountInterest(loan.balance * stubDays(loan.originatedDay), effective);
    } else {
      const part = regularPayment(loan, effective);
      interest += part.interest;
      principal += part.principal;
    }
  }
  return { interest, principal };
}

// ---------------------------------------------------------------------------
// Commands. Never throw for bad input; reject with a player-facing reason and
// leave state untouched. applyCommand checks field types and game over first.
// Ledger memos name what happened ("Credit line draw", "Term loan #2: 7 years
// at 7.25%", "Prepayment, loan #2", "Accrued interest, loan #2").
// ---------------------------------------------------------------------------

/**
 * drawCredit: amount a whole number >= 1 and <= creditAvailable (rejects:
 * frozen; no limit yet - "the bank lends against recurring revenue"; over
 * what is available, naming it). Adds to the balance, posts 'loanProceeds'
 * +amount; cost -amount.
 */
export function drawCredit(state: GameState, amount: number): CommandResult {
  if (!isWholeDollars(amount)) {
    return reject(`A credit line draw must be a whole number of dollars, at least $1 (got ${describeValue(amount)})`);
  }
  const { credit, covenant } = state.debt;
  if (covenant.stage === 'frozen') return reject(frozenReason(state));
  if (state.debt.acceleration !== null) return reject(acceleratedReason(state));
  const limit = creditLimit(state);
  if (limit === 0) return reject(noCreditLineReason());
  const available = creditAvailable(state);
  if (available === 0) return reject(lineFullReason(limit, credit.balance));
  if (amount > available) {
    return reject(
      `Only ${formatMoney(available)} is available on the credit line (${formatMoney(credit.balance)} drawn of a ${formatMoney(limit)} limit)`,
    );
  }
  credit.balance += amount;
  postEntry(state, 'loanProceeds', amount, 'Credit line draw');
  return { ok: true, cost: -amount };
}

/**
 * repayCredit: amount a whole number >= 1, <= balance (nothing drawn / only
 * $X drawn) and <= cash (not enough cash). Allowed while frozen. Posts
 * 'principal' -amount; cost amount.
 */
export function repayCredit(state: GameState, amount: number): CommandResult {
  if (!isWholeDollars(amount)) {
    return reject(`A credit line repayment must be a whole number of dollars, at least $1 (got ${describeValue(amount)})`);
  }
  const { credit } = state.debt;
  if (credit.balance === 0) return reject('Nothing is drawn on the credit line');
  if (amount > credit.balance) return reject(`Only ${formatMoney(credit.balance)} is drawn on the credit line`);
  if (state.finance.cash < amount) {
    return reject(`Not enough cash: need ${formatMoney(amount)}, have ${formatMoney(state.finance.cash)}`);
  }
  credit.balance -= amount;
  postEntry(state, 'principal', -amount, 'Credit line repayment');
  return { ok: true, cost: amount };
}

/**
 * takeTermLoan: termYears one of TERM_LOAN_YEARS, amount a whole number in
 * TERM_LOAN_MIN..termCapacity, not frozen or called (a covenant breach warns
 * in the quote but does not block); rejects with the quote's first reason.
 * Appends { id: nextLoanId++, principal: amount, balance: amount, rateBps:
 * quote.rate.rateBps, termMonths: years x 12, payment: quote.payment,
 * monthsLeft: termMonths, originatedDay: day }, posts 'loanProceeds' +amount
 * ("Term loan #2: 7 years at 7.25%"); cost -amount. Round 4: applies the
 * quote's same-month re-pricing (each repriced loan's rateBps and payment)
 * and names it in the memo ("...; loan #1 taken this month re-priced to
 * 7.25%: same-month loans are priced together").
 */
export function takeTermLoan(state: GameState, amount: number, termYears: TermYears): CommandResult {
  const quote = quoteTermLoan(state, amount, termYears);
  if (!quote.ok) return reject(quote.reasons[0] ?? 'The bank will not write this loan');
  const debt = state.debt;
  for (const change of quote.repriced) {
    const loan = debt.loans.find((l) => l.id === change.loan);
    if (!loan) continue;
    loan.rateBps = change.rateBpsAfter;
    loan.payment = change.paymentAfter;
  }
  const id = debt.nextLoanId++;
  debt.loans.push({
    id,
    principal: amount,
    balance: amount,
    rateBps: quote.rate.rateBps,
    termMonths: quote.termMonths,
    payment: quote.payment,
    monthsLeft: quote.termMonths,
    originatedDay: state.day,
  });
  postEntry(state, 'loanProceeds', amount, `Term loan #${id}: ${termYears} years at ${formatRateBps(quote.rate.rateBps)}${repricedMemo(quote.repriced)}`);
  return { ok: true, cost: -amount };
}

/** "; loan #1 taken this month re-priced to 7.25%: same-month loans are priced together" ('' for none). */
function repricedMemo(repriced: readonly RepricedLoan[]): string {
  if (repriced.length === 0) return '';
  const parts = repriced.map((r) => `#${r.loan} to ${formatRateBps(r.rateBpsAfter)}`);
  const what = repriced.length === 1 ? 'loan' : 'loans';
  return `; ${what} ${joinAnd(parts)} taken this month re-priced: same-month loans are priced together`;
}

/** "a, b and c" */
function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${String(items[items.length - 1])}`;
}

/**
 * prepayLoan: an open loan id; amount a whole number in 1..balance; cash >=
 * amount + accrued interest (quotePrepay). Allowed while frozen. Posts
 * 'interest' -accrued (if > 0) and 'principal' -amount; a loan repaid in
 * full is removed, otherwise its payment is re-amortized over the same
 * monthsLeft. Cost amount + accrued.
 */
export function prepayLoan(state: GameState, loan: LoanId, amount: number): CommandResult {
  const quote = quotePrepay(state, loan, amount);
  if (!quote.ok) return reject(quote.reasons[0] ?? 'This prepayment is not possible');
  const debt = state.debt;
  const index = debt.loans.findIndex((l) => l.id === loan);
  const target = debt.loans[index] as TermLoan;
  if (quote.accruedInterest > 0) postEntry(state, 'interest', -quote.accruedInterest, `Accrued interest, loan #${target.id}`);
  postEntry(state, 'principal', -amount, `Prepayment, loan #${target.id}`);
  target.balance -= amount;
  if (target.balance === 0) debt.loans.splice(index, 1);
  else target.payment = quote.paymentAfter;
  return { ok: true, cost: amount + quote.accruedInterest };
}

// ---------------------------------------------------------------------------
// Daily step and month close (wired into game.tick and finance.closeMonth)
// ---------------------------------------------------------------------------

/**
 * End of state.day (called at the start of tick, before the day advances and
 * before any close; never once the game is over): balanceDollarDays +=
 * credit balance. Then, if a close is PAYMENT_REMINDER_DAYS days away
 * (calendar.isFirstOfMonth(state.day + PAYMENT_REMINDER_DAYS)) and the cash
 * that close will have at its debt step (finance.estimateCashAtClose: after
 * the month's billing, running costs and installs) is below
 * estimateNextDebtService(state) > 0 (estimated before today's balance is
 * added, so today counts once), post one 'paymentDue' notice.
 */
export function endDebtDay(state: GameState): void {
  if (state.gameOver) return;
  const closeDay = state.day + PAYMENT_REMINDER_DAYS;
  const due = isFirstOfMonth(closeDay) ? estimateNextDebtService(state) : 0;
  const atClose = due > 0 ? estimateCashAtClose(state) : 0;
  const { credit } = state.debt;
  credit.balanceDollarDays += credit.balance;
  if (due > 0 && atClose < due) postNotice(state, 'paymentDue', paymentDueMessage(state, closeDay, due, atClose));
}

function paymentDueMessage(state: GameState, closeDay: number, due: number, atClose: number): string {
  const date = dateOf(closeDay);
  const when = `${MONTH_ABBR[date.month - 1] as string} ${date.day}`;
  const frozen = state.debt.covenant.stage === 'frozen';
  const called = state.debt.acceleration !== null;
  const raise = creditAvailable(state) > 0 ? 'draw on the credit line or raise cash before then' : 'raise cash before then (the credit line has nothing to draw)';
  const consequence = called
    ? 'or it is a default: the bank has called your loans, and a close that cannot pay what falls due ends the game.'
    : frozen
      ? 'or it is a default: with the credit line frozen, the bank calls your loans and the game ends.'
      : 'or the payment is missed: a late fee and a frozen credit line.';
  return (
    `Loan payments of about ${formatMoney(due)} are due at the ${when} close, and after this month's billing and running costs ` +
    `cash is projected at about ${formatMoney(atClose)} then (${formatMoney(state.finance.cash)} today), ` +
    `${formatMoney(due - atClose)} short: ${raise}, ${consequence}`
  );
}

/** What the debt part of a month close did (closeDebtMonth -> reviewDebt). */
export interface DebtClose {
  /**
   * Debt service due: credit-line interest + every loan's regular payment
   * (stub interest for a loan taken in the ended month) + (round 4, the
   * loans called) the line's principal that falls due. The sweep is not part of it.
   */
  due: number;
  /** Interest posted ('interest'), dollars >= 0; 0 when missed. */
  interestPaid: number;
  /** Principal posted ('principal'), dollars >= 0, the sweep included; 0 when missed. */
  principalPaid: number;
  /** Cash (after the month's operating entries) was below `due`: nothing was paid. */
  missed: boolean;
  /** Missed while the stage was already 'frozen' or (round 4) the loans were called: reviewDebt ends the game ('default'). */
  defaulted: boolean;
  /** Late fee posted ('interest'), 0 unless missed and not defaulted. */
  lateFee: number;
  /** Loans whose last payment, or the sweep, this close made (removed from debt.loans), ascending. */
  paidOff: LoanId[];
  /**
   * Round 4: principal swept from the month's operating cash flow because
   * the close began frozen (FROZEN_SWEEP_SHARE, never below
   * FROZEN_SWEEP_RESERVE of cash), included in principalPaid.
   */
  sweep: number;
  /** Round 4: what the sweep repaid (credit line, then loans by id), for its notice; absent when nothing was swept. */
  swept?: SweepPart[];
  /** Round 4: the ended month's operating cash flow the sweep took its share of; absent when nothing was swept. */
  sweptFrom?: number;
}

/** One balance the frozen-line sweep repaid: the credit line (loan null) or a term loan. */
export interface SweepPart {
  loan: LoanId | null;
  amount: number;
}

interface LoanCharge {
  loan: TermLoan;
  interest: number;
  principal: number;
  stub: boolean;
}

/**
 * Debt part of a month close (step 4), every entry dated `lastDay` (the
 * ended month's last day), at effective rates for the stage during the
 * month. due = line interest (from balanceDollarDays) + each loan's payment:
 * a loan taken in the ended month pays stub interest only (balance x stubDays
 * of its originatedDay), others a regular payment (TermLoan.payment doc).
 * Round 4, while the bank has called the loans (debt.acceleration): every
 * loan is first set to be due over the closes left (chargedLoan: monthsLeft
 * at most closesLeft, its payment re-set) and pays a regular payment, and
 * the line's principal calledLinePrincipal(balance, closesLeft) is part of
 * `due` too.
 * - cash >= due: post 'interest' -interest and 'principal' -principal (one
 *   entry each, skipped when 0, memos name the parts), reduce balances,
 *   monthsLeft -= 1 for regular payments, remove loans that reach 0.
 * - cash < due (missed): post nothing of it; capitalize every interest part
 *   into its balance (line and loans), leave monthsLeft (the schedule slips a
 *   month; reviewDebt re-sets the payments to the new balances); if the stage
 *   is 'frozen' or the loans are called mark defaulted, else post a late fee
 *   'interest' -max(LATE_FEE_MIN, round(due x LATE_FEE_SHARE)).
 * Round 4, the frozen-line sweep: when the close BEGAN with the stage
 * 'frozen', debt is still owed and the debt service was paid, sweep =
 * round(FROZEN_SWEEP_SHARE x max(0, the ended month's operating cash flow))
 * (finance.monthOperatingCashFlow: steps 1-3 of the close have posted every
 * operating entry), capped at max(0, cash after the debt service -
 * FROZEN_SWEEP_RESERVE) and at what is owed. It repays the credit line
 * first, then term loans by ascending id (each re-amortized over its months
 * left at its effective rate, like prepayLoan; no accrued interest at a
 * close; a loan reaching 0 is removed and listed in paidOff), as one
 * 'principal' entry ("Frozen-line sweep for Mar 2028: credit line $X, loan
 * #2 $Y"). The close that freezes the line does not sweep (it began unfrozen).
 * Always resets balanceDollarDays to 0. Returns the DebtClose.
 */
export function closeDebtMonth(state: GameState, lastDay: number): DebtClose {
  const debt = state.debt;
  const { credit, covenant, acceleration } = debt;
  const beganFrozen = covenant.stage === 'frozen';
  const penalty = penaltyBps(covenant.stage);
  const ended = dateOf(lastDay);
  const label = formatMonth(ended.year, ended.month);
  const start = lastDay - ended.day + 1;

  // Called loans are due over the closes left (a loaded save, or a loan the
  // call found with fewer payments to go, needs no change).
  if (acceleration !== null) {
    for (const loan of debt.loans) {
      const charged = chargedLoan(state, loan);
      loan.monthsLeft = charged.monthsLeft;
      loan.payment = charged.payment;
    }
  }

  const lineInterest = dayCountInterest(credit.balanceDollarDays, rateOf(credit.rate) + penalty);
  credit.balanceDollarDays = 0;
  const linePrincipal = acceleration !== null ? calledLinePrincipal(credit.balance, acceleration.closesLeft) : 0;
  const charges: LoanCharge[] = debt.loans.map((loan) => {
    const effective = loan.rateBps + penalty;
    if (acceleration === null && loan.originatedDay >= start) {
      return { loan, interest: dayCountInterest(loan.balance * stubDays(loan.originatedDay), effective), principal: 0, stub: true };
    }
    return { loan, ...regularPayment(loan, effective), stub: false };
  });

  let interest = lineInterest;
  let principal = linePrincipal;
  for (const charge of charges) {
    interest += charge.interest;
    principal += charge.principal;
  }
  const due = interest + principal;
  const result: DebtClose = { due, interestPaid: 0, principalPaid: 0, missed: false, defaulted: false, lateFee: 0, paidOff: [], sweep: 0 };

  if (due > 0 && state.finance.cash < due) {
    result.missed = true;
    credit.balance += lineInterest;
    for (const charge of charges) charge.loan.balance += charge.interest;
    if (beganFrozen || acceleration !== null) {
      result.defaulted = true;
    } else {
      result.lateFee = Math.max(LATE_FEE_MIN, round(due * LATE_FEE_SHARE));
      postEntryOn(state, lastDay, 'interest', -result.lateFee, `Late fee: ${formatMoney(due)} of loan payments for ${label} missed`);
    }
    return result;
  }

  if (interest > 0) {
    const parts: string[] = [];
    if (lineInterest > 0) parts.push(`credit line ${formatMoney(lineInterest)}`);
    for (const charge of charges) {
      if (charge.interest > 0) parts.push(`loan #${charge.loan.id} ${formatMoney(charge.interest)}${charge.stub ? ' (first month)' : ''}`);
    }
    postEntryOn(state, lastDay, 'interest', -interest, `Interest for ${label}: ${parts.join(', ')}`);
  }
  if (principal > 0) {
    const parts: string[] = [];
    if (linePrincipal > 0) parts.push(`credit line ${formatMoney(linePrincipal)} (called)`);
    for (const charge of charges) {
      if (charge.principal > 0) {
        const last = charge.principal === charge.loan.balance ? ' (paid off)' : '';
        parts.push(`loan #${charge.loan.id} ${formatMoney(charge.principal)}${last}`);
      }
    }
    postEntryOn(state, lastDay, 'principal', -principal, `Loan principal for ${label}: ${parts.join(', ')}`);
  }
  result.interestPaid = interest;
  result.principalPaid = principal;
  credit.balance -= linePrincipal;
  for (const charge of charges) {
    charge.loan.balance -= charge.principal;
    if (!charge.stub) charge.loan.monthsLeft = Math.max(1, charge.loan.monthsLeft - 1);
    if (charge.loan.balance === 0) result.paidOff.push(charge.loan.id);
  }

  if (beganFrozen) sweepFrozenLine(state, lastDay, label, result);
  if (result.paidOff.length > 0) {
    debt.loans = debt.loans.filter((loan) => loan.balance > 0);
    result.paidOff.sort((a, b) => a - b);
  }
  return result;
}

/** The frozen-line sweep of a paid close (closeDebtMonth doc), recorded in `result`. */
function sweepFrozenLine(state: GameState, lastDay: number, label: string, result: DebtClose): void {
  const debt = state.debt;
  const owed = totalDebt(state);
  if (owed <= 0) return;
  const flow = monthOperatingCashFlow(state);
  const sweep = Math.min(round(FROZEN_SWEEP_SHARE * Math.max(0, flow)), Math.max(0, state.finance.cash - FROZEN_SWEEP_RESERVE), owed);
  if (sweep <= 0) return;
  const penalty = penaltyBps(debt.covenant.stage);
  const swept: SweepPart[] = [];
  let left = sweep;
  const fromLine = Math.min(left, debt.credit.balance);
  if (fromLine > 0) {
    debt.credit.balance -= fromLine;
    left -= fromLine;
    swept.push({ loan: null, amount: fromLine });
  }
  for (const loan of [...debt.loans].sort((a, b) => a.id - b.id)) {
    if (left <= 0) break;
    if (loan.balance <= 0) continue;
    const take = Math.min(left, loan.balance);
    loan.balance -= take;
    left -= take;
    swept.push({ loan: loan.id, amount: take });
    if (loan.balance === 0) result.paidOff.push(loan.id);
    else loan.payment = levelPayment(loan.balance, loan.rateBps + penalty, loan.monthsLeft);
  }
  postEntryOn(state, lastDay, 'principal', -sweep, `Frozen-line sweep for ${label}: ${describeSwept(swept)}`);
  result.sweep = sweep;
  result.principalPaid += sweep;
  result.swept = swept;
  result.sweptFrom = flow;
}

/** "credit line $4,000, loan #2 $1,500" */
function describeSwept(parts: readonly SweepPart[]): string {
  return parts.map((p) => `${p.loan === null ? 'credit line' : `loan #${p.loan}`} ${formatMoney(p.amount)}`).join(', ');
}

const STEP_UP: Record<CovenantStage, CovenantStage> = { compliant: 'warning', warning: 'penalty', penalty: 'frozen', frozen: 'frozen' };
const STEP_DOWN: Record<CovenantStage, CovenantStage> = { compliant: 'compliant', warning: 'compliant', penalty: 'warning', frozen: 'penalty' };

/** Which covenant tests fail, with figures and limits, for a breach notice. */
function breachDetails(m: CovenantMetrics): string {
  const parts: string[] = [];
  if (!m.leverageOk) {
    parts.push(
      m.leverage === null
        ? `leverage cannot be measured: you owe ${formatMoney(m.totalDebt)} with no recurring revenue or operating cash flow to repay it`
        : `leverage ${formatMultiple(m.leverage)} is over the ${formatMultiple(COVENANT_MAX_LEVERAGE)} limit ` +
            `(${formatMoney(m.totalDebt)} of debt on ${formatMoney(m.underwritingCashFlow)} a year of underwriting cash flow)`,
    );
  }
  if (!m.coverageOk && m.coverage !== null) {
    parts.push(
      `debt-service coverage ${formatMultiple(m.coverage)} is under the ${formatMultiple(COVENANT_MIN_COVERAGE)} minimum ` +
        `(${formatMoney(m.underwritingCashFlow)} a year of underwriting cash flow for ${formatMoney(m.annualDebtService)} of payments due in the next 12 months)`,
    );
  }
  return parts.join(' and ');
}

function cureRule(): string {
  return `${closes(COVENANT_CURE_CLOSES, 'compliant close')} in a row`;
}

/**
 * The debt service the Bank shows after the close re-priced the line and
 * re-set loan payments, when it differs from the figure the review tested:
 * " At the new rates, $X of payments are due in the next 12 months
 * (coverage Y)." ('' when unchanged).
 */
function repricedClause(tested: CovenantMetrics, now: CovenantMetrics): string {
  if (now.annualDebtService === tested.annualDebtService) return '';
  const coverage = now.coverage === null ? '' : ` (coverage ${formatMultiple(now.coverage)})`;
  return ` At the new rates, ${formatMoney(now.annualDebtService)} of payments are due in the next 12 months${coverage}.`;
}

/** `m`: the metrics the review tested; `now`: the same after re-pricing (what the Bank shows from now on). */
function breachNotice(state: GameState, label: string, stage: CovenantStage, m: CovenantMetrics, now: CovenantMetrics): void {
  const failing = breachDetails(m);
  const repriced = repricedClause(m, now);
  const penalty = formatRateBps(PENALTY_STEP_UP_BPS);
  if (stage === 'warning') {
    postNotice(
      state,
      'covenantWarning',
      `Covenant warning at the ${label} close: ${failing}.${repriced} Nothing changes yet, but another breach adds a ${penalty} penalty rate to every balance; ${cureRule()} clear the warning.`,
    );
  } else if (stage === 'penalty') {
    postNotice(
      state,
      'covenantPenalty',
      `Covenant breach at the ${label} close while on warning: ${failing}. Every balance now pays ${penalty} more (term-loan payments rise to match) ` +
        `until ${cureRule()} step it back down; another breach freezes the credit line.${repriced}`,
    );
  } else if (stage === 'frozen') {
    postNotice(
      state,
      'creditFrozen',
      `Credit line frozen at the ${label} close after another covenant breach: ${failing}.${repriced} No draws or new term loans (repaying and prepaying still work), ` +
        `the ${penalty} penalty rate stays, and a payment missed while frozen is a default that ends the game. ${frozenRulesSentence()} ${cureRule()} lift the freeze.`,
    );
  }
}

function cureNotice(state: GameState, label: string, stage: CovenantStage): void {
  const penalty = formatRateBps(PENALTY_STEP_UP_BPS);
  const still =
    stage === 'penalty'
      ? `The credit line is unfrozen, but the ${penalty} penalty rate still applies until ${cureRule()} more.`
      : stage === 'warning'
        ? `The ${penalty} penalty rate is lifted and term-loan payments come back down; you are still on warning, so another breach brings it back.`
        : 'You are back in good standing with the bank.';
  postNotice(state, 'covenantCured', `Covenants met at the ${label} close: your standing is back to ${stage}. ${still}`);
}

/**
 * Debt review at a month close (step 7), after `report` is appended. The
 * covenant metrics are taken once, after the close's payments and before any
 * stage change or re-pricing; they decide the review and fill report.debt.
 * - close.defaulted: gameOver = { day, reason: 'default', message } and a
 *   'gameOver' notice (message: which payment could not be made while
 *   frozen, or, once the loans are called, the called debts).
 * - else close.missed: stage 'frozen', compliantCloses 0, 'paymentMissed' notice (fee, what frozen means, how to cure).
 * - else no debt left: stage 'compliant', compliantCloses 0 (a 'covenantCured' notice if it was not compliant).
 * - else covenantMetrics(state): a breach resets compliantCloses and steps
 *   the stage up (notice 'covenantWarning' / 'covenantPenalty' /
 *   'creditFrozen'; already frozen: no notice); compliant closes count up and
 *   every COVENANT_CURE_CLOSES of them step it down one ('covenantCured');
 *   compliant while 'compliant' keeps compliantCloses at 0.
 * Then (unless defaulted), when the close missed (interest capitalized) or
 * the penalty surcharge started or stopped, re-set every loan's level payment
 * over its months left at its new effective rate (TermLoan.payment). Re-price
 * the credit line (priceRate line parts at the close's leverage, to the
 * hundredth as report.debt records it, the ended month's CPP from
 * report.stats.capexOsp / report.passings (pricingCpp for a report without
 * stats) and the stage after the review, so creditOffer shows exactly what
 * the line was priced on). A breach notice is posted after that, with the
 * tested figures and, when they changed, the debt service and coverage at the
 * new rates (what the Bank shows from then on). Then one 'loanPaidOff' notice
 * per close.paidOff (naming the sweep when it repaid the rest).
 * Round 4, unless defaulted: debt.frozenCloses counts the closes ending
 * 'frozen' with debt owed (0 otherwise); with nothing owed the acceleration
 * ends; a running acceleration counts closesLeft down (at least 1); else at
 * FROZEN_ACCELERATION_CLOSES the bank calls the loans (callLoans, a
 * 'loansCalled' notice with what falls due at each close). A swept close
 * posts 'debtSwept'; a frozen close leaving 1..ACCELERATION_WARNING_CLOSES
 * closes before the call posts 'accelerationWarning'. Then report.debt
 * (DebtStats: the tested figures, stage after the review, average rate
 * after re-pricing, the sweep, frozenCloses and the closes left once called).
 */
export function reviewDebt(state: GameState, report: MonthlyReport, close: DebtClose): void {
  const debt = state.debt;
  const covenant = debt.covenant;
  const label = formatMonth(report.year, report.month);
  const m = covenantMetrics(state);
  const penaltyBefore = penaltyBps(covenant.stage);
  /** The stage a breach stepped up to (its notice waits for the re-priced figures). */
  let breached: CovenantStage | null = null;

  if (close.defaulted) {
    const message =
      debt.acceleration !== null
        ? `Default: the bank called your loans at the ${closeLabel(debt.acceleration.day)} close, and the ${formatMoney(close.due)} that fell due ` +
          `at the ${label} close (${calledDebts(state)}) could not be paid (${formatMoney(state.finance.cash)} in cash).`
        : `Default: the ${formatMoney(close.due)} of loan payments due at the ${label} close could not be paid ` +
          `(${formatMoney(state.finance.cash)} in cash) while your credit line was frozen, so the bank has called your loans.`;
    state.gameOver = { day: state.day, reason: 'default', message };
    postNotice(state, 'gameOver', message);
  } else if (close.missed) {
    covenant.stage = 'frozen';
    covenant.compliantCloses = 0;
    const cash = state.finance.cash + close.lateFee;
    postNotice(
      state,
      'paymentMissed',
      `Missed payment: the ${formatMoney(close.due)} of loan payments due at the ${label} close could not be paid (cash ${formatMoney(cash)}). ` +
        `The bank charged a ${formatMoney(close.lateFee)} late fee, added the unpaid interest to what you owe (term-loan payments are re-set to repay it on schedule) ` +
        'and froze your credit line: ' +
        `no draws or new term loans, and a ${formatRateBps(PENALTY_STEP_UP_BPS)} penalty rate on every balance. ` +
        `Another missed payment while frozen is a default that ends the game; ${cureRule()} lift the freeze. ${frozenRulesSentence()}`,
    );
  } else if (m.totalDebt === 0) {
    if (covenant.stage !== 'compliant') {
      postNotice(
        state,
        'covenantCured',
        `All debt repaid by the ${label} close: your standing is back to compliant, with no penalty rate and the credit line open.`,
      );
    }
    covenant.stage = 'compliant';
    covenant.compliantCloses = 0;
  } else if (!m.compliant) {
    covenant.compliantCloses = 0;
    if (covenant.stage !== 'frozen') {
      covenant.stage = STEP_UP[covenant.stage];
      breached = covenant.stage;
    }
  } else if (covenant.stage === 'compliant') {
    covenant.compliantCloses = 0;
  } else {
    covenant.compliantCloses += 1;
    if (covenant.compliantCloses >= COVENANT_CURE_CLOSES) {
      covenant.stage = STEP_DOWN[covenant.stage];
      covenant.compliantCloses = 0;
      cureNotice(state, label, covenant.stage);
    }
  }

  // A level payment repays its loan only at the rate it was set for: when the
  // penalty starts or stops, or a missed payment added interest to the
  // balances, re-set each payment over the months left, so the surcharge is
  // paid as it accrues and never piles up on the last payment.
  const penalty = penaltyBps(covenant.stage);
  if (!close.defaulted && (close.missed || penalty !== penaltyBefore)) {
    for (const loan of debt.loans) loan.payment = levelPayment(loan.balance, loan.rateBps + penalty, loan.monthsLeft);
  }

  // Priced on the figures this close records, which are what creditOffer shows
  // until the next close: leverage to the hundredth (covenantMetrics,
  // report.debt.leverageX100) and the ended month's CPP (report.passings, taken
  // before the day moved on; a lot that appears on the 1st belongs to the new month).
  const leverageX100 = m.leverage === null ? null : safeX100(m.leverage);
  const cpp = report.stats ? costPerPassing(report.stats.capexOsp, report.passings) : pricingCpp(state);
  const priced = priceRate({ kind: 'line' }, m.leverage, cpp, covenant.stage);
  debt.credit.rate = { baseBps: priced.baseBps, leverageBps: priced.leverageBps, cppBps: priced.cppBps, productBps: priced.productBps };

  if (breached !== null) breachNotice(state, label, breached, m, covenantMetrics(state));
  if (!close.defaulted) {
    for (const id of close.paidOff) {
      const bySweep = close.swept?.some((part) => part.loan === id) ?? false;
      postNotice(
        state,
        'loanPaidOff',
        bySweep
          ? `Term loan #${id} is paid off: the frozen-line sweep at the ${label} close repaid the rest.`
          : `Term loan #${id} is paid off: its last payment was made at the ${label} close.`,
      );
    }
  }

  // Round 4: consecutive closes ending frozen with debt owed; the bank calls
  // the loans at FROZEN_ACCELERATION_CLOSES of them. A called close that paid
  // counts down; nothing owed ends it (a cure does not).
  if (!close.defaulted) {
    debt.frozenCloses = covenant.stage === 'frozen' && totalDebt(state) > 0 ? debt.frozenCloses + 1 : 0;
    let called = false;
    if (totalDebt(state) === 0) debt.acceleration = null;
    else if (debt.acceleration !== null) debt.acceleration.closesLeft = Math.max(1, debt.acceleration.closesLeft - 1);
    else if (debt.frozenCloses >= FROZEN_ACCELERATION_CLOSES) {
      callLoans(state);
      called = true;
    }
    if (close.sweep > 0) postNotice(state, 'debtSwept', sweptMessage(state, label, close));
    if (called) postNotice(state, 'loansCalled', loansCalledMessage(state, label));
    else {
      const left = closesUntilAcceleration(state);
      if (left !== null && left >= 1 && left <= ACCELERATION_WARNING_CLOSES) {
        postNotice(state, 'accelerationWarning', accelerationWarningMessage(state, label, left));
      }
    }
  }

  const total = totalDebt(state);
  let weighted = debt.credit.balance * (rateOf(debt.credit.rate) + penalty);
  for (const loan of debt.loans) weighted += loan.balance * (loan.rateBps + penalty);
  report.debt = {
    creditBalance: debt.credit.balance,
    termBalance: termBalances(state),
    creditLimit: creditLimit(state),
    arr: m.arr,
    annualOperatingCashFlow: m.annualOperatingCashFlow,
    annualDebtService: m.annualDebtService,
    leverageX100,
    coverageX100: m.coverage === null ? null : safeX100(m.coverage),
    stage: covenant.stage,
    averageRateBps: total === 0 ? null : round(weighted / total),
    missedPayment: close.missed,
    sweep: close.sweep,
    frozenCloses: debt.frozenCloses,
    accelerationClosesLeft: debt.acceleration?.closesLeft ?? null,
  };
}

/**
 * The bank calls the loans (reviewDebt, at FROZEN_ACCELERATION_CLOSES frozen
 * closes in a row): acceleration = { day, closesLeft: ACCELERATION_CLOSES },
 * every loan due over min(monthsLeft, ACCELERATION_CLOSES) closes with its
 * level payment re-set over them at its effective rate.
 */
function callLoans(state: GameState): void {
  const debt = state.debt;
  debt.acceleration = { day: state.day, closesLeft: ACCELERATION_CLOSES };
  const penalty = penaltyBps(debt.covenant.stage);
  for (const loan of debt.loans) {
    loan.monthsLeft = Math.max(1, Math.min(loan.monthsLeft, ACCELERATION_CLOSES));
    loan.payment = levelPayment(loan.balance, loan.rateBps + penalty, loan.monthsLeft);
  }
}

/** The month a close on `day` ended: "Mar 2028". */
function closeLabel(day: number): string {
  const ended = dateOf(Math.max(0, day - 1));
  return formatMonth(ended.year, ended.month);
}

/** "Apr 1": the close `k` closes after the one on (or the next after) `day` (k = 1: the next close). */
function nthCloseDate(day: number, k: number): string {
  const next = dateOf(day).month - 1 + k;
  return `${MONTH_ABBR[((next % 12) + 12) % 12] as string} 1`;
}

/** "the credit line ($4,000) and loan #1 ($77,000)" */
function calledDebts(state: GameState): string {
  const parts: string[] = [];
  if (state.debt.credit.balance > 0) parts.push(`the credit line (${formatMoney(state.debt.credit.balance)})`);
  for (const loan of state.debt.loans) parts.push(`loan #${loan.id} (${formatMoney(loan.balance)})`);
  return parts.length === 0 ? 'nothing' : joinAnd(parts);
}

/** "While frozen, the bank takes 50% of ... and after 6 frozen closes in a row it calls the loans." */
function frozenRulesSentence(): string {
  return (
    `While frozen, the bank takes ${sweepShare()} of each month's positive operating cash flow (keeping ${formatMoney(FROZEN_SWEEP_RESERVE)} in cash) ` +
    `to repay what you owe, and after ${FROZEN_ACCELERATION_CLOSES} frozen closes in a row it calls the loans: everything falls due within ${closes(ACCELERATION_CLOSES, 'close')}.`
  );
}

/** "$30,000 at the Apr 1 close, $29,500 at May 1 and $29,000 at Jun 1" */
function scheduleText(state: GameState, schedule: readonly number[]): string {
  return joinAnd(schedule.map((amount, i) => `${formatMoney(amount)} at ${i === 0 ? 'the ' : ''}${nthCloseDate(state.day, i + 1)}${i === 0 ? ' close' : ''}`));
}

/**
 * What lifts the freeze from here, never advice that cannot work: with
 * enough frozen closes left for the compliant closes a cure needs, those;
 * else only repaying everything before the next close stops the call.
 */
function avoidCallText(state: GameState, left: number): string {
  const needed = Math.max(1, COVENANT_CURE_CLOSES - state.debt.covenant.compliantCloses);
  if (left >= needed) {
    return (
      `${closes(needed, 'compliant close')} in a row from the next one (leverage at most ${formatMultiple(COVENANT_MAX_LEVERAGE)}, ` +
      `coverage at least ${formatMultiple(COVENANT_MIN_COVERAGE)}, every payment made) lift the freeze in time, or repay everything you owe.`
    );
  }
  return `Too few closes are left for a cure to lift the freeze in time: only repaying everything you owe (${formatMoney(totalDebt(state))}) before then stops it.`;
}

function sweptMessage(state: GameState, label: string, close: DebtClose): string {
  const from = close.sweptFrom ?? 0;
  const head =
    `The bank swept ${formatMoney(close.sweep)} at the ${label} close (${sweepShare()} of the month's ${formatMoney(from)} operating cash flow, ` +
    `keeping at least ${formatMoney(FROZEN_SWEEP_RESERVE)} in cash) because your credit line is frozen: ${describeSwept(close.swept ?? [])}.`;
  const owed = totalDebt(state);
  if (owed === 0) return `${head} That repaid everything you owed: the freeze lifts now.`;
  const acceleration = state.debt.acceleration;
  if (acceleration !== null) {
    return `${head} You still owe ${formatMoney(owed)}, and the bank has called the loans: ${closes(acceleration.closesLeft, 'close')} left to repay everything.`;
  }
  const left = closesUntilAcceleration(state);
  if (left === null) return `${head} You still owe ${formatMoney(owed)}.`;
  if (left === 0) return `${head} You still owe ${formatMoney(owed)}.`;
  return (
    `${head} You still owe ${formatMoney(owed)}; ${closes(left, 'more frozen close')} and the bank calls the loans. ` +
    `${cureRule()} (leverage at most ${formatMultiple(COVENANT_MAX_LEVERAGE)}, coverage at least ${formatMultiple(COVENANT_MIN_COVERAGE)}, every payment made) lift the freeze.`
  );
}

function accelerationWarningMessage(state: GameState, label: string, left: number): string {
  return (
    `${closes(left, 'more frozen close')} and the bank calls your loans (credit line still frozen at the ${label} close). ` +
    `Everything you owe (${formatMoney(totalDebt(state))}) then falls due within ${closes(ACCELERATION_CLOSES, 'close')}, ` +
    `and a close that cannot pay it is a default that ends the game. Cash is ${formatMoney(state.finance.cash)}. ${avoidCallText(state, left)}`
  );
}

function loansCalledMessage(state: GameState, label: string): string {
  const schedule = acceleratedSchedule(state);
  return (
    `The bank has called your loans at the ${label} close after ${FROZEN_ACCELERATION_CLOSES} frozen closes in a row. Everything you owe ` +
    `(${formatMoney(totalDebt(state))}: ${calledDebts(state)}) falls due over the next ${closes(schedule.length, 'close')}: about ${scheduleText(state, schedule)}. ` +
    `Cash is ${formatMoney(state.finance.cash)}. A close that cannot pay what falls due is a default that ends the game; repaying early still works.`
  );
}

/** round(x x 100), held to safe integers so an absurd loaded save still saves. */
function safeX100(x: number): number {
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, round(x * 100)));
}

// ---------------------------------------------------------------------------
// Round 4 (sim-debt): covenant previews, safe borrowing, funding hints, cure
// options and the sweep estimate. The rules themselves live where they act:
// smoothed ARR in trailingArr, the frozen-line sweep and called loans in
// closeDebtMonth / reviewDebt (callLoans), same-month pricing in
// quoteTermLoan (termProForma) / takeTermLoan. Every read here is pure and
// verifies what it suggests pro forma: nothing it returns can backfire at
// today's figures.
// ---------------------------------------------------------------------------

/**
 * Closes left before the bank calls the loans: while frozen with debt and not
 * yet accelerated, max(0, FROZEN_ACCELERATION_CLOSES - debt.frozenCloses);
 * else null.
 */
export function closesUntilAcceleration(state: GameState): number | null {
  const { covenant, frozenCloses, acceleration } = state.debt;
  if (covenant.stage !== 'frozen' || acceleration !== null || totalDebt(state) === 0) return null;
  return Math.max(0, FROZEN_ACCELERATION_CLOSES - frozenCloses);
}

/**
 * What drawCredit(amount) would do now: see DrawQuote. Never throws for bad
 * input. The draw's debt service is a year of interest at the line's
 * effective rate (as annualDebtService counts the line). Its reasons are
 * drawCredit's own.
 */
export function quoteDraw(state: GameState, amount: number): DrawQuote {
  const whole = isWholeDollars(amount);
  const usable = typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 0;
  const { credit, covenant } = state.debt;
  const effective = rateOf(credit.rate) + penaltyBps(covenant.stage);
  const before = covenantMetrics(state);
  const after = covenantMetrics(state, { addDebt: usable, addAnnualDebtService: round((usable * effective) / 10_000) });
  const reasons: string[] = [];
  const limit = creditLimit(state);
  const available = creditAvailable(state);
  if (state.gameOver) reasons.push('The game is over');
  if (!whole) reasons.push(`A credit line draw must be a whole number of dollars, at least $1 (got ${describeValue(amount)})`);
  if (covenant.stage === 'frozen') reasons.push(frozenReason(state));
  else if (state.debt.acceleration !== null) reasons.push(acceleratedReason(state));
  else if (limit === 0) reasons.push(noCreditLineReason());
  else if (available === 0) reasons.push(lineFullReason(limit, credit.balance));
  else if (whole && amount > available) {
    reasons.push(`Only ${formatMoney(available)} is available on the credit line (${formatMoney(credit.balance)} drawn of a ${formatMoney(limit)} limit)`);
  }
  return {
    ok: reasons.length === 0,
    reasons,
    amount,
    before,
    after,
    breachesCovenant: !after.compliant,
    cashAfter: state.finance.cash + usable,
    interestToClose: dayCountInterest(usable * stubDays(state.day), effective),
  };
}

/**
 * The largest term loan of `termYears` whose pro forma covenants
 * (quoteTermLoan(...).after, same-month re-pricing included) stay
 * compliant, with `headroom` to spare (round 4b, covenantsWithin; default 0:
 * exactly compliant): a multiple of LOAN_ROUNDING in
 * TERM_LOAN_MIN..termCapacity, found by bisection (safeTermMax, on the same
 * pro forma as the quote); 0 when even TERM_LOAN_MIN would breach, while
 * frozen or called, with no capacity, for a term not on offer, or once the
 * game is over.
 */
export function maxSafeTermLoan(state: GameState, termYears: TermYears, headroom = 0): number {
  if (!TERM_LOAN_YEARS.includes(termYears)) return 0;
  return safeTermMax(state, metricsBase(state), pricingCpp(state), termYears, termCapacity(state), undefined, headroom);
}

/** A credit-line draw's yearly debt service, as quoteDraw counts it: a year of interest at the line's effective rate. */
function drawService(state: GameState, amount: number): number {
  const effective = rateOf(state.debt.credit.rate) + penaltyBps(state.debt.covenant.stage);
  return round((amount * effective) / 10_000);
}

/** quoteDraw(state, amount).after passes with `headroom` to spare (covenantsWithin; 0: compliant), on a base read once. */
function drawSafe(state: GameState, base: MetricsBase, amount: number, headroom = 0): boolean {
  return covenantsWithin(metricsOf(base, { addDebt: amount, addAnnualDebtService: drawService(state, amount) }), headroom);
}

/**
 * The largest covenant-safe draw (quoteDraw(...).after.compliant) up to what
 * is available: a multiple of LOAN_ROUNDING, or everything available when
 * that is safe; 0 when none is. Bisection (compliance only falls as a draw grows).
 */
function maxSafeDraw(state: GameState, base: MetricsBase, headroom = 0): number {
  const available = creditAvailable(state);
  if (available <= 0 || state.gameOver) return 0;
  if (drawSafe(state, base, available, headroom)) return available;
  let lo = 0;
  let hi = Math.floor(available / LOAN_ROUNDING);
  if (hi >= 1 && hi * LOAN_ROUNDING === available) hi -= 1;
  // Invariant: lo x LOAN_ROUNDING is safe (0 trivially); above hi is not known to be.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (drawSafe(state, base, mid * LOAN_ROUNDING, headroom)) lo = mid;
    else hi = mid - 1;
  }
  return lo * LOAN_ROUNDING;
}

/** FUNDING_CUSHION_MONTHS of fixed costs: overhead and today's marketing budget. */
function fixedCostCushion(state: GameState): number {
  return FUNDING_CUSHION_MONTHS * (OVERHEAD_PER_MONTH + state.sales.marketingPerMonth);
}

/** The smallest multiple of LOAN_ROUNDING at or above `amount` (>= 0). */
function roundUpToLoan(amount: number): number {
  return Math.max(0, Math.ceil(amount / LOAN_ROUNDING) * LOAN_ROUNDING);
}

/**
 * How to pay for `cost` keeping a cushion (see FundingHint): the cushion is
 * FUNDING_CUSHION_MONTHS x (OVERHEAD_PER_MONTH + marketing) + the next
 * close's estimated debt service; shortfall = max(0, cost + cushion - cash).
 * In order of preference, each verified pro forma at today's figures:
 *   cash        - no shortfall;
 *   draw        - the shortfall rounded up to LOAN_ROUNDING (capped at what is
 *                 available) is a covenant-safe draw (quoteDraw(...).after.compliant);
 *   term        - a term loan of the longest term on offer, the shortfall
 *                 rounded up (at least TERM_LOAN_MIN), within maxSafeTermLoan;
 *   drawAndTerm - the largest safe draw plus the rest as such a term loan,
 *                 the two together covenant-safe (the loan priced on the
 *                 leverage with the draw);
 *   short       - nothing safe covers it: the most there is, the largest safe
 *                 draw with the largest term loan safe on top of it (0 when
 *                 below TERM_LOAN_MIN), or the largest safe loan alone when
 *                 that is more.
 * A cost that is not a positive number counts as 0. Round 4b: with
 * `headroom` (a share, default 0), "covenant-safe" means passing with that
 * much to spare (covenantsWithin), so the financing lands comfortably
 * inside the limits. Pure.
 */
export function fundingHint(state: GameState, cost: number, headroom = 0): FundingHint {
  const price = typeof cost === 'number' && Number.isFinite(cost) && cost > 0 ? cost : 0;
  const termYears = TERM_LOAN_YEARS[TERM_LOAN_YEARS.length - 1] as TermYears;
  const cushion = fixedCostCushion(state) + estimateNextDebtService(state);
  const shortfall = Math.max(0, round(price + cushion - state.finance.cash));
  const hint = (kind: FundingHint['kind'], draw: number, termLoan: number): FundingHint => ({ cost, cushion, shortfall, kind, draw, termLoan, termYears });
  if (shortfall === 0) return hint('cash', 0, 0);

  const base = metricsBase(state);
  const available = creditAvailable(state);
  const wantDraw = Math.min(available, roundUpToLoan(shortfall));
  if (wantDraw >= shortfall && drawSafe(state, base, wantDraw, headroom)) return hint('draw', wantDraw, 0);

  const cpp = pricingCpp(state);
  const capacity = termCapacity(state);
  const wantTerm = Math.max(roundUpToLoan(TERM_LOAN_MIN), roundUpToLoan(shortfall));
  const safeTerm = safeTermMax(state, base, cpp, termYears, capacity, undefined, headroom);
  if (wantTerm <= safeTerm) return hint('term', 0, wantTerm);

  const draw = maxSafeDraw(state, base, headroom);
  const extra = { debt: draw, service: drawService(state, draw) };
  const rest = Math.max(roundUpToLoan(TERM_LOAN_MIN), roundUpToLoan(shortfall - draw));
  if (draw > 0 && rest <= capacity && covenantsWithin(termProForma(state, base, cpp, rest, termYears, true, extra).after, headroom)) {
    return hint('drawAndTerm', draw, rest);
  }
  // The most there is: the safe draw with the loan safe on top of it, or the safe loan alone when that is more.
  const termOnTop = draw > 0 ? safeTermMax(state, base, cpp, termYears, capacity, extra, headroom) : safeTerm;
  return draw + termOnTop >= safeTerm ? hint('short', draw, termOnTop) : hint('short', 0, safeTerm);
}

/**
 * Ways to cure a breached covenant now (see CureOption), best first:
 * repaying the credit line, then prepaying each term loan (highest rate
 * first, ties by id), each the smallest amount (a multiple of LOAN_ROUNDING,
 * or the whole balance) whose pro forma covenants pass at today's figures -
 * computed exactly on the state with that repayment made (the line's
 * balance, or the loan re-amortized over its months left at its effective
 * rate, or gone) - and only when cash after it (the prepayment's accrued
 * interest included) stays >= the next close's debt service with it +
 * FUNDING_CUSHION_MONTHS of fixed costs. When no single repayment can, one
 * 'grow' option: the extra annual operating cash flow (rounded up to
 * LOAN_ROUNDING) with which both tests pass, verified. Empty when nothing is
 * owed or the covenants already pass. Never advice that backfires. Pure
 * (each candidate is a shallow pro forma copy of the debt; state is never written).
 */
export function cureOptions(state: GameState): CureOption[] {
  if (totalDebt(state) === 0) return [];
  const today = covenantMetrics(state);
  if (today.compliant) return [];
  const options: CureOption[] = [];
  const keepFixed = fixedCostCushion(state);
  const credit = state.debt.credit;

  if (credit.balance > 0) {
    const at = (amount: number): GameState => withDebt(state, { ...state.debt, credit: { ...credit, balance: credit.balance - amount } });
    const amount = smallestCure(credit.balance, (a) => covenantMetrics(at(a)).compliant);
    if (amount !== null) {
      const pro = at(amount);
      const cashAfter = state.finance.cash - amount;
      if (cashAfter >= estimateNextDebtService(pro) + keepFixed) {
        const after = covenantMetrics(pro);
        options.push({ kind: 'repayCredit', loan: null, amount, after, cashAfter, text: cureText(`Repay ${formatMoney(amount)} of the credit line`, after, cashAfter) });
      }
    }
  }

  const loans = [...state.debt.loans].sort((a, b) => b.rateBps - a.rateBps || a.id - b.id);
  const effectivePenalty = penaltyBps(state.debt.covenant.stage);
  for (const loan of loans) {
    const at = (amount: number): GameState => {
      const rest = loan.balance - amount;
      const others = state.debt.loans.filter((l) => l.id !== loan.id);
      const changed: TermLoan[] =
        rest > 0 ? [...others, { ...loan, balance: rest, payment: levelPayment(rest, loan.rateBps + effectivePenalty, loan.monthsLeft) }] : others;
      changed.sort((a, b) => a.id - b.id);
      return withDebt(state, { ...state.debt, loans: changed });
    };
    const amount = smallestCure(loan.balance, (a) => covenantMetrics(at(a)).compliant);
    if (amount === null) continue;
    const pro = at(amount);
    const cashAfter = state.finance.cash - amount - accruedOn(state, loan, amount);
    if (cashAfter < estimateNextDebtService(pro) + keepFixed) continue;
    const after = covenantMetrics(pro);
    const what = amount === loan.balance ? `Pay off term loan #${loan.id} (${formatMoney(amount)})` : `Prepay ${formatMoney(amount)} of term loan #${loan.id}`;
    options.push({ kind: 'prepayLoan', loan: loan.id, amount, after, cashAfter, text: cureText(what, after, cashAfter) });
  }
  if (options.length > 0) return options;

  const grow = growCure(state);
  return grow === null ? [] : [grow];
}

/**
 * Whether a cure started now can lift a freeze before the bank calls the
 * loans: the COVENANT_CURE_CLOSES compliant closes in a row it takes (fewer
 * when today's figures pass and some are already counted) fit in the closes
 * left (closesUntilAcceleration). True when nothing is counting down; false
 * once the loans are called (a cure does not end a call: only repaying
 * everything does).
 */
export function cureBeatsCall(state: GameState): boolean {
  if (state.debt.acceleration !== null) return false;
  const left = closesUntilAcceleration(state);
  if (left === null) return true;
  const done = covenantMetrics(state).compliant ? state.debt.covenant.compliantCloses : 0;
  return Math.max(1, COVENANT_CURE_CLOSES - done) <= Math.max(1, left);
}

/**
 * Repaying everything owed now as a cure option (kind 'repayAll', amount the
 * debt): the credit line and every term loan, each loan with the interest
 * accrued on it, when cash after it still holds the next close's debt
 * service (the line's interest accrued so far) plus FUNDING_CUSHION_MONTHS
 * of fixed costs; null when nothing is owed or cash cannot. With nothing
 * owed the next close clears the covenant stage and ends a call
 * (reviewDebt). Pure.
 */
export function repayAllCure(state: GameState): CureOption | null {
  const owed = totalDebt(state);
  if (owed === 0) return null;
  let interest = 0;
  for (const loan of state.debt.loans) interest += accruedOn(state, loan, loan.balance);
  const pro = withDebt(state, { ...state.debt, credit: { ...state.debt.credit, balance: 0 }, loans: [], acceleration: null });
  const cashAfter = state.finance.cash - owed - interest;
  if (cashAfter < estimateNextDebtService(pro) + fixedCostCushion(state)) return null;
  const accrued = interest > 0 ? ` and ${formatMoney(interest)} of accrued interest` : '';
  const ends =
    state.debt.acceleration !== null
      ? 'ends the call and clears your standing'
      : state.debt.covenant.stage === 'frozen'
        ? 'lifts the freeze, before the bank can call the loans'
        : 'clears your standing';
  return {
    kind: 'repayAll',
    loan: null,
    amount: owed,
    after: covenantMetrics(pro),
    cashAfter,
    text: `Repay everything you owe (${formatMoney(owed)}${accrued}): with no debt the next close ${ends}, leaving ${formatMoney(cashAfter)} in cash.`,
  };
}

/**
 * The cure to show (the advisor's covenantCure, the Bank's "To cure it
 * now"): null when nothing is owed or today's figures pass. When the bank has
 * called the loans, or a cure could not lift the freeze before it does
 * (cureBeatsCall), only repaying everything (repayAllCure; null when cash
 * cannot: nothing short of it helps). Otherwise the first cureOptions entry,
 * with repaying everything ahead of the 'grow' figure when no single
 * repayment cures but cash covers all of it.
 */
export function cureFor(state: GameState): CureOption | null {
  if (totalDebt(state) === 0 || covenantMetrics(state).compliant) return null;
  if (!cureBeatsCall(state)) return repayAllCure(state);
  const first = cureOptions(state)[0] ?? null;
  if (first === null || first.kind === 'grow') return repayAllCure(state) ?? first;
  return first;
}

/** The commands that repay everything owed now: the credit line, then each term loan in full (repayAllCure). */
export function repayAllCommands(state: GameState): Command[] {
  const commands: Command[] = [];
  if (state.debt.credit.balance > 0) commands.push({ type: 'repayCredit', amount: state.debt.credit.balance });
  for (const loan of state.debt.loans) commands.push({ type: 'prepayLoan', loan: loan.id, amount: loan.balance });
  return commands;
}

/** `state` with `debt` in place of its own (a shallow copy for pro forma reads; never written). */
function withDebt(state: GameState, debt: Debt): GameState {
  return { ...state, debt };
}

/**
 * The smallest candidate repayment of a `balance` - multiples of
 * LOAN_ROUNDING below it, then the balance itself - that `cures`, or null
 * when even the balance does not. Bisection (repaying more never makes a
 * covenant worse: less debt, a lower or no payment).
 */
function smallestCure(balance: number, cures: (amount: number) => boolean): number | null {
  if (balance <= 0 || !cures(balance)) return null;
  // Candidates 1..steps are k x LOAN_ROUNDING (all below the balance); steps + 1 is the balance.
  const steps = Math.ceil(balance / LOAN_ROUNDING) - 1;
  let lo = 1;
  let hi = steps + 1;
  const value = (k: number): number => (k > steps ? balance : k * LOAN_ROUNDING);
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (cures(value(mid))) hi = mid;
    else lo = mid + 1;
  }
  return value(lo);
}

/** "Repay $42,000 of the credit line: at today's figures leverage 4.60× and coverage 1.31×, with $88,000 left in cash." */
function cureText(what: string, after: CovenantMetrics, cashAfter: number): string {
  return `${what}: at today's figures that brings ${metricsText(after)}, leaving ${formatMoney(cashAfter)} in cash.`;
}

/** "leverage to 4.60× (limit 5.00×) and coverage to 1.31× (minimum 1.20×)" */
function metricsText(m: CovenantMetrics): string {
  const leverage = m.leverage === null ? 'leverage still unmeasurable' : m.totalDebt === 0 ? 'no debt' : `leverage to ${formatMultiple(m.leverage)} (limit ${formatMultiple(COVENANT_MAX_LEVERAGE)})`;
  const coverage = m.coverage === null ? 'nothing scheduled' : `coverage to ${formatMultiple(m.coverage)} (minimum ${formatMultiple(COVENANT_MIN_COVERAGE)})`;
  return `${leverage} and ${coverage}`;
}

/**
 * " (until then the bank counts $23,666, 35% of lending ARR)" when the
 * trailing operating cash flow is below the underwriting floor (what the
 * covenant figures count instead), else "": so a 'grow' text's figures,
 * all on the operating-cash-flow basis, do not read against the floor.
 */
function floorNote(base: MetricsBase): string {
  const floor = base.arr * UNDERWRITING_MIN_MARGIN;
  if (base.ocf >= floor) return '';
  return ` (until then the bank counts ${formatMoney(floor)}, ${Math.round(UNDERWRITING_MIN_MARGIN * 100)}% of lending ARR)`;
}

/**
 * The 'grow' cure: the smallest multiple of LOAN_ROUNDING of extra annual
 * operating cash flow with which both tests pass at today's debt and debt
 * service (underwriting cash flow >= debt / COVENANT_MAX_LEVERAGE and >=
 * debt service x COVENANT_MIN_COVERAGE), verified on covenantMetrics; null
 * when none within a sane bound does (it always exists for finite figures).
 */
function growCure(state: GameState): CureOption | null {
  const base = metricsBase(state);
  const target = Math.max(base.debt / COVENANT_MAX_LEVERAGE, base.service * COVENANT_MIN_COVERAGE);
  let amount = roundUpToLoan(target - base.ocf);
  if (amount <= 0) amount = LOAN_ROUNDING;
  for (let tries = 0; tries < 100; tries++, amount += LOAN_ROUNDING) {
    const after = metricsOf(base, { addDebt: 0, addAnnualDebtService: 0, addAnnualOperatingCashFlow: amount });
    if (!after.compliant) continue;
    const cashAfter = state.finance.cash;
    return {
      kind: 'grow',
      loan: null,
      amount,
      after,
      cashAfter,
      text:
        `No single repayment cures it: about ${formatMoney(amount)} a year more operating cash flow would, ` +
        `raising it from ${formatMoney(base.ocf)} to ${formatMoney(after.annualOperatingCashFlow)} a year${floorNote(base)}, ` +
        `at today's figures bringing ${metricsText(after)}.`,
    };
  }
  return null;
}

/**
 * The sweep the next close would take if the stage stays frozen
 * (closeDebtMonth's rule on estimates): round(FROZEN_SWEEP_SHARE x max(0,
 * finance.estimateMonthOperatingCashFlow)), capped at the cash projected
 * after the next debt service (finance.estimateCashAtClose -
 * estimateNextDebtService) less FROZEN_SWEEP_RESERVE, and at what is owed
 * after that service's principal; 0 when not frozen, nothing is owed, or the
 * projected cash cannot pay the debt service (that close would miss it). For
 * the Bank and the briefing.
 */
export function estimateSweep(state: GameState): number {
  if (state.debt.covenant.stage !== 'frozen' || state.gameOver) return 0;
  const owed = totalDebt(state);
  if (owed === 0) return 0;
  const { interest, principal } = nextServiceParts(state);
  const cashAfterService = estimateCashAtClose(state) - interest - principal;
  if (cashAfterService < 0) return 0;
  const flow = estimateMonthOperatingCashFlow(state);
  return Math.max(0, Math.min(round(FROZEN_SWEEP_SHARE * Math.max(0, flow)), cashAfterService - FROZEN_SWEEP_RESERVE, owed - principal));
}
