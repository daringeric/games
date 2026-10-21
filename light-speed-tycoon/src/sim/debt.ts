// Financing (round 3): a revolving credit line, fixed-rate term loans,
// underwriting on recurring revenue, risk-based pricing, covenants that
// escalate, and default.
//
// Owner: sim-debt workstream. The contract implemented the state helpers the
// UI reads everywhere (newDebt, totalDebt, rateOf, penaltyBps, trailingArr,
// creditLimit, creditAvailable); sim-debt implemented the rest. Arithmetic
// only (README): no Math.pow, so compounding is repeated multiplication.
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
//   4. debt.closeDebtMonth(state, lastDay): debt service, dated lastDay
//   5. totals, report (stats), append, clear monthToDate  (unchanged)
//   6. milestones.checkMilestones                         (unchanged)
//   7. debt.reviewDebt(state, report, close): default / missed payment /
//      covenant review, notices, credit-line re-pricing, report.debt
//   8. finance.checkInsolvency                            (no-op once gameOver)
// Operating cash flow (metrics.operatingCashFlow) excludes financing
// (FINANCING_CATEGORIES) as well as capex; net cash flow (report.net)
// includes it; CPP (capex.osp) is untouched by debt.
//
// Cost of the reads (for the UI and the bots): creditOffer, termCapacity and
// estimateNextDebtService are O(loans + ARR_TRAILING_MONTHS), covenantMetrics
// O(12 x loans + ARR_TRAILING_MONTHS) (a year of each loan's schedule);
// quoteTermLoan adds pricingCpp (getService, memoized on network.version and
// day) and one amortization schedule (termYears x 12 steps); quotePrepay one
// level-payment loop (monthsLeft steps). None allocates more than a schedule.

import {
  ARR_TRAILING_MONTHS,
  BASE_RATE_BPS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_SPREAD_BPS,
  CREDIT_LIMIT_ARR_MULTIPLE,
  CREDIT_LINE_EXTRA_BPS,
  LATE_FEE_MIN,
  LATE_FEE_SHARE,
  LEVERAGE_SPREAD_BANDS,
  LEVERAGE_SPREAD_MAX_BPS,
  LOAN_ROUNDING,
  PAYMENT_REMINDER_DAYS,
  PENALTY_STEP_UP_BPS,
  TERM_CAPACITY_ARR_MULTIPLE,
  TERM_EXTRA_BPS,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  UNDERWRITING_MIN_MARGIN,
} from './balance';
import { dateOf, DAYS_PER_YEAR, formatMonth, isFirstOfMonth, MONTH_ABBR, MONTH_LENGTHS } from './calendar';
import { estimateCashAtClose, formatMoney, postEntry, postEntryOn } from './finance';
import { costPerPassing, cppBand, operatingCashFlow } from './metrics';
import { getService } from './network';
import { postNotice } from './notices';
import type {
  CommandResult,
  CovenantMetrics,
  CovenantStage,
  CreditOffer,
  Debt,
  GameState,
  LoanId,
  MonthlyReport,
  PrepayQuote,
  RateBreakdown,
  RateParts,
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
 * leverage, no CPP spread) until the first close re-prices it.
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
 * Annualized recurring revenue of the trailing closed months: the revenue
 * totals (totals.revenue) of the last min(ARR_TRAILING_MONTHS,
 * reports.length) closed months, summed, x 12 / that count, rounded; 0
 * before the first close. Closed months only, so it (and every capacity built
 * on it) only changes at a month close.
 */
export function trailingArr(state: GameState): number {
  const reports = state.finance.reports;
  const n = Math.min(ARR_TRAILING_MONTHS, reports.length);
  if (n === 0) return 0;
  let revenue = 0;
  for (let i = reports.length - n; i < reports.length; i++) revenue += (reports[i] as MonthlyReport).totals.revenue ?? 0;
  return Math.max(0, Math.round((revenue * 12) / n));
}

/** Credit-line limit: trailingArr x CREDIT_LIMIT_ARR_MULTIPLE, rounded down to a multiple of LOAN_ROUNDING. */
export function creditLimit(state: GameState): number {
  return Math.floor((trailingArr(state) * CREDIT_LIMIT_ARR_MULTIPLE) / LOAN_ROUNDING) * LOAN_ROUNDING;
}

/** What a draw may take now: max(0, creditLimit - balance); 0 while the covenant stage is 'frozen'. */
export function creditAvailable(state: GameState): number {
  if (state.debt.covenant.stage === 'frozen') return 0;
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
    '(repaying and prepaying still work).'
  );
}

function noCreditLineReason(): string {
  return (
    'No credit line yet: the bank lends against recurring revenue, so sign up subscribers first ' +
    `(the limit is ${shortMultiple(CREDIT_LIMIT_ARR_MULTIPLE)} your annualized revenue of the last closed months).`
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
 * window as trailingArr): sum of metrics.operatingCashFlow(report) x 12 /
 * count, rounded; 0 before the first close. May be negative.
 */
export function annualOperatingCashFlow(state: GameState): number {
  const reports = state.finance.reports;
  const n = Math.min(ARR_TRAILING_MONTHS, reports.length);
  if (n === 0) return 0;
  let flow = 0;
  for (let i = reports.length - n; i < reports.length; i++) flow += operatingCashFlow(reports[i] as MonthlyReport);
  return round((flow * 12) / n);
}

/**
 * Debt service scheduled over the next 12 months at today's effective rates:
 * for each loan its next min(12, monthsLeft) regular payments exactly as the
 * closes will charge them while the stage holds (scheduledPayments: the last
 * one repays whatever balance is left), plus round(credit balance x (line
 * rate + penalty) / 10,000) for the line (a year of interest at today's
 * balance). A loan's stub interest is ignored.
 */
export function annualDebtService(state: GameState): number {
  const { credit, loans, covenant } = state.debt;
  const penalty = penaltyBps(covenant.stage);
  let service = round((credit.balance * (rateOf(credit.rate) + penalty)) / 10_000);
  for (const loan of loans) service += scheduledPayments(loan, loan.rateBps + penalty, Math.min(12, loan.monthsLeft));
  return service;
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

/** A hypothetical extra loan for covenantMetrics: its amount and its yearly debt service. */
export interface ProForma {
  addDebt: number;
  addAnnualDebtService: number;
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
  const debt = totalDebt(state) + (proForma?.addDebt ?? 0);
  const arr = trailingArr(state);
  const ocf = annualOperatingCashFlow(state);
  const underwritingCashFlow = Math.max(ocf, arr * UNDERWRITING_MIN_MARGIN);
  const service = annualDebtService(state) + (proForma?.addAnnualDebtService ?? 0);
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
 * below TERM_LOAN_MIN or the stage is 'frozen'.
 */
export function termCapacity(state: GameState): number {
  if (state.debt.covenant.stage === 'frozen') return 0;
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
 * Reasons, most fundamental first: game over, term, amount not whole
 * dollars, frozen, no capacity, below TERM_LOAN_MIN, above maxAmount.
 */
export function quoteTermLoan(state: GameState, amount: number, termYears: TermYears): TermLoanQuote {
  const knownTerm = TERM_LOAN_YEARS.includes(termYears);
  const termMonths = knownTerm ? termYears * 12 : 0;
  const whole = isWholeDollars(amount);
  const usable = typeof amount === 'number' && Number.isFinite(amount) && amount > 0 ? amount : 0;
  const frozen = state.debt.covenant.stage === 'frozen';
  const maxAmount = termCapacity(state);
  const before = covenantMetrics(state);

  const leverage = leverageOf(before.totalDebt + usable, before.underwritingCashFlow);
  const rate = priceRate({ kind: 'term', years: termYears }, leverage, pricingCpp(state), state.debt.covenant.stage);
  const payment = whole && knownTerm ? levelPayment(amount, rate.effectiveRateBps, termMonths) : 0;
  const schedule = payment > 0 ? amortize(amount, rate.effectiveRateBps, termMonths, payment) : [];
  const final = schedule.at(-1);
  const stubInterest = dayCountInterest(usable * stubDays(state.day), rate.effectiveRateBps);
  let totalInterest = stubInterest;
  for (const step of schedule) totalInterest += step.interest;
  const after = covenantMetrics(state, { addDebt: usable, addAnnualDebtService: payment * Math.min(12, termMonths) });

  const reasons: string[] = [];
  if (state.gameOver) reasons.push('The game is over');
  if (!knownTerm) reasons.push(`Term must be ${joinOr(TERM_LOAN_YEARS)} years`);
  if (!whole) reasons.push(`A term loan must be a whole number of dollars (got ${describeValue(amount)})`);
  if (frozen) reasons.push(frozenReason(state));
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
  };
}

function noTermCapacityReason(state: GameState): string {
  const arr = trailingArr(state);
  const multiple = shortMultiple(TERM_CAPACITY_ARR_MULTIPLE);
  if (arr === 0) {
    return `No term loans yet: the bank lends up to ${multiple} your annualized recurring revenue, so sign up subscribers first.`;
  }
  return (
    `No term-loan room left: the bank lends up to ${multiple} your annualized recurring revenue of ${formatMoney(arr)}, ` +
    `less the ${formatMoney(termBalances(state))} owed on term loans, and the smallest loan is ${formatMoney(TERM_LOAN_MIN)}.`
  );
}

function overCapacityReason(state: GameState, maxAmount: number): string {
  const owed = termBalances(state);
  const less = owed > 0 ? `, less the ${formatMoney(owed)} owed on term loans` : '';
  return (
    `The most the bank will lend now is ${formatMoney(maxAmount)} ` +
    `(${shortMultiple(TERM_CAPACITY_ARR_MULTIPLE)} your annualized recurring revenue of ${formatMoney(trailingArr(state))}${less})`
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
 * today's effective rates. For the Bank panel, the reminder and bots.
 */
export function estimateNextDebtService(state: GameState): number {
  const { credit, loans, covenant } = state.debt;
  const penalty = penaltyBps(covenant.stage);
  const start = monthStart(state.day);
  let due = dayCountInterest(credit.balanceDollarDays + credit.balance * stubDays(state.day), rateOf(credit.rate) + penalty);
  for (const loan of loans) {
    const effective = loan.rateBps + penalty;
    if (loan.originatedDay >= start) {
      due += dayCountInterest(loan.balance * stubDays(loan.originatedDay), effective);
    } else {
      const { interest, principal } = regularPayment(loan, effective);
      due += interest + principal;
    }
  }
  return due;
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
 * TERM_LOAN_MIN..termCapacity, not frozen (a covenant breach warns in the
 * quote but does not block); rejects with the quote's first reason. Appends
 * { id: nextLoanId++, principal: amount, balance: amount, rateBps:
 * quote.rate.rateBps, termMonths: years x 12, payment: quote.payment,
 * monthsLeft: termMonths, originatedDay: day }, posts 'loanProceeds' +amount
 * ("Term loan #2: 7 years at 7.25%"); cost -amount.
 */
export function takeTermLoan(state: GameState, amount: number, termYears: TermYears): CommandResult {
  const quote = quoteTermLoan(state, amount, termYears);
  if (!quote.ok) return reject(quote.reasons[0] ?? 'The bank will not write this loan');
  const debt = state.debt;
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
  postEntry(state, 'loanProceeds', amount, `Term loan #${id}: ${termYears} years at ${formatRateBps(quote.rate.rateBps)}`);
  return { ok: true, cost: -amount };
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
  const raise = creditAvailable(state) > 0 ? 'draw on the credit line or raise cash before then' : 'raise cash before then (the credit line has nothing to draw)';
  const consequence = frozen
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
  /** Debt service due: credit-line interest + every loan's regular payment (stub interest for a loan taken in the ended month). */
  due: number;
  /** Interest posted ('interest'), dollars >= 0; 0 when missed. */
  interestPaid: number;
  /** Principal posted ('principal'), dollars >= 0; 0 when missed. */
  principalPaid: number;
  /** Cash (after the month's operating entries) was below `due`: nothing was paid. */
  missed: boolean;
  /** Missed while the stage was already 'frozen': reviewDebt ends the game ('default'). */
  defaulted: boolean;
  /** Late fee posted ('interest'), 0 unless missed and not defaulted. */
  lateFee: number;
  /** Loans whose last payment this close made (removed from debt.loans), ascending. */
  paidOff: LoanId[];
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
 * - cash >= due: post 'interest' -interest and 'principal' -principal (one
 *   entry each, skipped when 0, memos name the parts), reduce balances,
 *   monthsLeft -= 1 for regular payments, remove loans that reach 0.
 * - cash < due (missed): post nothing of it; capitalize every interest part
 *   into its balance (line and loans), leave monthsLeft (the schedule slips a
 *   month; reviewDebt re-sets the payments to the new balances); if the stage
 *   is not 'frozen' post a late fee 'interest' -max(LATE_FEE_MIN, round(due x
 *   LATE_FEE_SHARE)), else mark defaulted.
 * Always resets balanceDollarDays to 0. Returns the DebtClose.
 */
export function closeDebtMonth(state: GameState, lastDay: number): DebtClose {
  const debt = state.debt;
  const { credit, covenant } = debt;
  const penalty = penaltyBps(covenant.stage);
  const ended = dateOf(lastDay);
  const label = formatMonth(ended.year, ended.month);
  const start = lastDay - ended.day + 1;

  const lineInterest = dayCountInterest(credit.balanceDollarDays, rateOf(credit.rate) + penalty);
  credit.balanceDollarDays = 0;
  const charges: LoanCharge[] = debt.loans.map((loan) => {
    const effective = loan.rateBps + penalty;
    if (loan.originatedDay >= start) {
      return { loan, interest: dayCountInterest(loan.balance * stubDays(loan.originatedDay), effective), principal: 0, stub: true };
    }
    return { loan, ...regularPayment(loan, effective), stub: false };
  });

  let interest = lineInterest;
  let principal = 0;
  for (const charge of charges) {
    interest += charge.interest;
    principal += charge.principal;
  }
  const due = interest + principal;
  const result: DebtClose = { due, interestPaid: 0, principalPaid: 0, missed: false, defaulted: false, lateFee: 0, paidOff: [] };
  if (due === 0) return result;

  if (state.finance.cash < due) {
    result.missed = true;
    credit.balance += lineInterest;
    for (const charge of charges) charge.loan.balance += charge.interest;
    if (covenant.stage === 'frozen') {
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
  for (const charge of charges) {
    charge.loan.balance -= charge.principal;
    if (!charge.stub) charge.loan.monthsLeft = Math.max(1, charge.loan.monthsLeft - 1);
    if (charge.loan.balance === 0) result.paidOff.push(charge.loan.id);
  }
  if (result.paidOff.length > 0) debt.loans = debt.loans.filter((loan) => loan.balance > 0);
  return result;
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
        `the ${penalty} penalty rate stays, and a payment missed while frozen is a default that ends the game. ${cureRule()} lift the freeze.`,
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
 *   'gameOver' notice (message: which payment could not be made while frozen).
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
 * per close.paidOff, and report.debt (DebtStats: the tested figures, stage
 * after the review, average rate after re-pricing).
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
      `Default: the ${formatMoney(close.due)} of loan payments due at the ${label} close could not be paid ` +
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
        `Another missed payment while frozen is a default that ends the game; ${cureRule()} lift the freeze.`,
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
      postNotice(state, 'loanPaidOff', `Term loan #${id} is paid off: its last payment was made at the ${label} close.`);
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
  };
}

/** round(x x 100), held to safe integers so an absurd loaded save still saves. */
function safeX100(x: number): number {
  return Math.max(-Number.MAX_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, round(x * 100)));
}
