// The Bank: the credit line (draw and repay), the term-loan builder (amount,
// 5 or 7 years, a live quote with the rate's parts, the payment and the
// covenants before and after), the loans list (prepay) and the covenant
// status (stage, leverage and coverage against the limits, what happens next
// and how to cure). Every figure comes from debt.ts (creditOffer,
// quoteTermLoan, quotePrepay, covenantMetrics, estimateNextDebtService); the
// panel only words and lays them out, and changes the game only through
// drawCredit / repayCredit / takeTermLoan / prepayLoan. The quote functions
// run only while the panel is open.
//
// The sheet is modal, but the clock keeps running behind it: main.ts calls
// update() every frame and the figures refresh in place on each new day or
// command, never rebuilding an input (focus and typed amounts survive).
//
// Owner: ui-bank workstream.

import {
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_TARGET,
  CREDIT_LIMIT_ARR_MULTIPLE,
  LOAN_ROUNDING,
  PENALTY_STEP_UP_BPS,
  TERM_CAPACITY_ARR_MULTIPLE,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  UNDERWRITING_MIN_MARGIN,
} from '../sim/balance';
import { dateOf, dayOf, formatDate } from '../sim/calendar';
import { covenantMetrics, creditOffer, estimateNextDebtService, quotePrepay, quoteTermLoan, termCapacity, totalDebt } from '../sim/debt';
import type {
  CovenantMetrics,
  CovenantStage,
  CreditOffer,
  GameState,
  LoanId,
  PrepayQuote,
  RateBreakdown,
  TermLoan,
  TermLoanQuote,
  TermYears,
} from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el, setText } from './dom';
import { formatBpsDelta, formatMoney, formatPercent, formatRate, formatRatio, plural } from './format';
import type { Toasts } from './overlays';
import { parseNumberField } from './pricingPanel';
import type { GameSession } from './session';

// ---------------------------------------------------------------------------
// Covenant wording (shared with the HUD chip)
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

/** "Leverage at most 5.00× and coverage at least 1.20×" */
export function covenantLimits(): string {
  return `leverage at most ${formatRatio(COVENANT_MAX_LEVERAGE)} and debt-service coverage at least ${formatRatio(COVENANT_MIN_COVERAGE)}`;
}

/** What the stage means today. */
export function stageMeaning(stage: CovenantStage): string {
  switch (stage) {
    case 'compliant':
      return 'Your loans are in good standing.';
    case 'warning':
      return 'The bank flagged a covenant breach at a month close. Nothing changes yet.';
    case 'penalty':
      return `Every balance pays a ${formatBpsDelta(PENALTY_STEP_UP_BPS)} penalty rate on top of its own.`;
    case 'frozen':
      return `The credit line is frozen: no draws and no new term loans, and every balance pays ${formatBpsDelta(PENALTY_STEP_UP_BPS)}. Repaying and prepaying still work.`;
  }
}

/** What the next breach (or a missed payment) does from this stage. */
export function stageNext(stage: CovenantStage): string {
  const missed = 'A payment you cannot make freezes the credit line at once, with a late fee.';
  switch (stage) {
    case 'compliant':
      return `A breach at a month close brings a warning first. ${missed}`;
    case 'warning':
      return `Another breach adds a ${formatBpsDelta(PENALTY_STEP_UP_BPS)} penalty rate on all debt. ${missed}`;
    case 'penalty':
      return `Another breach freezes the credit line: no draws and no new term loans. ${missed}`;
    case 'frozen':
      return 'A missed payment now is a default, and a default ends the game.';
  }
}

/** How to step back down, with the progress so far ('' while compliant). */
export function cureText(stage: CovenantStage, compliantCloses: number): string {
  if (stage === 'compliant') return '';
  const progress = compliantCloses > 0 ? ` (${compliantCloses} of ${COVENANT_CURE_CLOSES} so far)` : '';
  return (
    `${plural(COVENANT_CURE_CLOSES, 'compliant month close')} in a row step back one stage${progress}. ` +
    'Repay debt or grow your operating cash flow to get back within the limits; with no debt at all the bank lifts everything.'
  );
}

/** How a new breach would escalate from this stage, for the builder's warning. */
function escalation(stage: CovenantStage): string {
  switch (stage) {
    case 'compliant':
      return 'a warning first, then a penalty rate, then a frozen credit line';
    case 'warning':
      return 'a penalty rate next, then a frozen credit line';
    case 'penalty':
    case 'frozen':
      return 'a frozen credit line next';
  }
}

// ---------------------------------------------------------------------------
// Pure view models (unit-tested with literal offers and quotes)
// ---------------------------------------------------------------------------

/** "0.5×", "3×": a multiple of ARR. */
export function formatMultiple(x: number): string {
  return `${Math.round(x * 100) / 100}×`;
}

/** Leverage as the bank sees it: "not measurable" when there is debt and no cash flow to measure it against. */
export function formatLeverage(leverage: number | null): string {
  return leverage === null ? 'not measurable' : formatRatio(leverage);
}

/** The plain-language line under the cost-per-passing spread. */
export function cppLine(rate: Pick<RateBreakdown, 'cpp' | 'cppBand' | 'cppBps'>): string {
  const spread = rate.cppBps > 0 ? formatBpsDelta(rate.cppBps) : 'no CPP spread';
  if (rate.cpp === null || rate.cppBand === null) return 'Nothing passed yet: no CPP spread';
  const cpp = formatMoney(rate.cpp);
  switch (rate.cppBand) {
    case 'green':
      return `Cost per passing ${cpp} is ${Math.round(rate.cpp) < CPP_TARGET ? 'under' : 'on'} target: ${spread}`;
    case 'amber':
      return `Cost per passing ${cpp} is over target (amber): ${spread}`;
    case 'red':
      return `Cost per passing ${cpp} is far over target (red): ${spread}`;
  }
}

/** The leverage the leverage spread was priced on, in words. */
export function leverageNote(leverage: number | null): string {
  if (leverage === null) return 'leverage not measurable: the top spread';
  if (leverage === 0) return 'no debt yet';
  return `at ${formatRatio(leverage)} leverage`;
}

export interface RateRowView {
  key: 'base' | 'leverage' | 'cpp' | 'product' | 'penalty';
  label: string;
  value: string;
  /** Small print under the row. */
  note: string;
}

/** The rate's parts, in order; the penalty row only while it applies. */
export function rateRows(rate: RateBreakdown, product: { kind: 'line' } | { kind: 'term'; years: TermYears }): RateRowView[] {
  const rows: RateRowView[] = [
    { key: 'base', label: 'Base', value: formatRate(rate.baseBps), note: 'what every loan starts from' },
    { key: 'leverage', label: 'Leverage spread', value: formatBpsDelta(rate.leverageBps), note: leverageNote(rate.leverage) },
    { key: 'cpp', label: 'Cost-per-passing spread', value: formatBpsDelta(rate.cppBps), note: cppLine(rate) },
    product.kind === 'line'
      ? { key: 'product', label: 'Line premium', value: formatBpsDelta(rate.productBps), note: 'draw and repay any time; the rate floats' }
      : { key: 'product', label: 'Term premium', value: formatBpsDelta(rate.productBps), note: `${product.years}-year term, fixed for its life` },
  ];
  if (rate.penaltyBps > 0) {
    rows.push({ key: 'penalty', label: 'Penalty', value: formatBpsDelta(rate.penaltyBps), note: 'on every balance until the covenants are cured' });
  }
  return rows;
}

export interface Preset {
  label: string;
  amount: number;
  /** The amount can't be used now (0, or more than allowed). */
  disabled: boolean;
}

/** Fixed draw presets (whole dollars), then half and all of what is available. */
export const DRAW_PRESETS: readonly number[] = [10_000, 25_000];

export function drawPresets(available: number): Preset[] {
  const half = Math.floor(available / 2);
  return [
    ...DRAW_PRESETS.map((amount) => ({ label: formatMoney(amount), amount, disabled: amount > available })),
    { label: 'Half', amount: half, disabled: half < 1 },
    { label: 'All', amount: available, disabled: available < 1 },
  ];
}

/** Repay half of the balance or all of it, never more than maxRepay (cash on hand). */
export function repayPresets(offer: Pick<CreditOffer, 'balance' | 'maxRepay'>): Preset[] {
  const half = Math.min(offer.maxRepay, Math.ceil(offer.balance / 2));
  return [
    { label: 'Half', amount: half, disabled: half < 1 },
    { label: 'All', amount: offer.maxRepay, disabled: offer.maxRepay < 1 },
  ];
}

export interface Figure {
  label: string;
  value: string;
  /** Small print after the value. */
  sub?: string;
  tone?: BankTone | 'muted';
}

export interface CreditView {
  figures: Figure[];
  /** Effective rate charged today. */
  rate: string;
  rateRows: RateRowView[];
  /** One line on where the limit comes from (or why there is none yet). */
  note: string;
  canDraw: boolean;
  /** Why nothing can be drawn (the offer's reasons); empty when canDraw. */
  reasons: string[];
  canRepay: boolean;
  /** Why the drawn balance can't be repaid now (no cash), or ''. */
  repayReason: string;
  drawPresets: Preset[];
  repayPresets: Preset[];
}

export function creditView(offer: CreditOffer): CreditView {
  const multiple = formatMultiple(CREDIT_LIMIT_ARR_MULTIPLE);
  const note =
    offer.limit <= 0
      ? `No credit yet: the bank lends against recurring revenue. Your limit will be ${multiple} your annual recurring revenue (ARR), set at each month close once subscribers pay.`
      : `Limit ${multiple} your annual recurring revenue (${formatMoney(offer.arr)} a year), reset at each month close.`;
  return {
    figures: [
      { label: 'Limit', value: formatMoney(offer.limit) },
      { label: 'Drawn', value: formatMoney(offer.balance) },
      { label: 'Available', value: formatMoney(offer.available), tone: offer.available > 0 ? undefined : 'muted' },
      { label: 'Interest so far this month', value: formatMoney(offer.accruedInterest) },
    ],
    rate: formatRate(offer.rate.effectiveRateBps),
    rateRows: rateRows(offer.rate, { kind: 'line' }),
    note,
    canDraw: offer.available > 0,
    reasons: offer.available > 0 ? [] : offer.reasons,
    canRepay: offer.balance > 0 && offer.maxRepay > 0,
    repayReason: offer.balance > 0 && offer.maxRepay <= 0 ? 'No cash to repay with right now' : '',
    drawPresets: drawPresets(offer.available),
    repayPresets: repayPresets(offer),
  };
}

/** The builder's default amount rounds the capacity down to this. */
export const TERM_DEFAULT_ROUNDING = 10_000;

/** Capacity rounded down to TERM_DEFAULT_ROUNDING, at least TERM_LOAN_MIN. */
export function defaultTermAmount(maxAmount: number): number {
  return Math.max(TERM_LOAN_MIN, Math.floor(maxAmount / TERM_DEFAULT_ROUNDING) * TERM_DEFAULT_ROUNDING);
}

/** 25 / 50 / 75 / 100% of capacity, rounded down to LOAN_ROUNDING (100% is the capacity itself). */
export function termPresets(maxAmount: number): Preset[] {
  return [0.25, 0.5, 0.75, 1].map((share) => {
    const amount = share === 1 ? maxAmount : Math.floor((maxAmount * share) / LOAN_ROUNDING) * LOAN_ROUNDING;
    return { label: formatPercent(share), amount, disabled: amount < TERM_LOAN_MIN || amount > maxAmount };
  });
}

export interface CovenantCheck {
  label: string;
  /** "2.40× → 4.10×" in the builder, "2.40×" in the status. */
  value: string;
  limit: string;
  ok: boolean;
  /** "within the limit" / "over the limit" (words beside the color). */
  mark: string;
}

function leverageCheck(before: CovenantMetrics | null, after: CovenantMetrics): CovenantCheck {
  const value = before ? `${formatLeverage(before.leverage)} → ${formatLeverage(after.leverage)}` : formatLeverage(after.leverage);
  return {
    label: 'Leverage',
    value,
    limit: `max ${formatRatio(COVENANT_MAX_LEVERAGE)}`,
    ok: after.leverageOk,
    mark: after.leverageOk ? 'within the limit' : after.leverage === null ? 'breach: no cash flow to carry it' : 'over the limit',
  };
}

function coverageCheck(before: CovenantMetrics | null, after: CovenantMetrics): CovenantCheck {
  const value = before ? `${formatRatio(before.coverage)} → ${formatRatio(after.coverage)}` : formatRatio(after.coverage);
  return {
    label: 'Coverage',
    value,
    limit: `min ${formatRatio(COVENANT_MIN_COVERAGE)}`,
    ok: after.coverageOk,
    mark: after.coverage === null ? 'nothing scheduled' : after.coverageOk ? 'within the limit' : 'under the minimum',
  };
}

export interface TermView {
  ok: boolean;
  reasons: string[];
  /** "Borrow $120,000 over 7 years", or "Borrow" for an amount that can't be quoted. */
  confirmLabel: string;
  /** "Up to $240,000 today" / why nothing can be borrowed. */
  capacity: string;
  /** Fixed rate the loan would carry; with the penalty in force, what is charged today too. */
  rate: string;
  rateRows: RateRowView[];
  figures: Figure[];
  checks: CovenantCheck[];
  /** The breach warning, or null when the loan keeps the covenants. */
  warning: string | null;
}

/** Words for the covenants a quote would break. */
function brokenCovenants(after: CovenantMetrics): string {
  if (!after.leverageOk && !after.coverageOk) return 'the leverage and coverage covenants';
  return !after.leverageOk ? 'the leverage covenant' : 'the coverage covenant';
}

export function termView(quote: TermLoanQuote, stage: CovenantStage): TermView {
  const valid = quote.payment > 0;
  const capacity =
    quote.maxAmount > 0
      ? `Up to ${formatMoney(quote.maxAmount)} today: ${formatMultiple(TERM_CAPACITY_ARR_MULTIPLE)} your annual recurring revenue, less the term loans you owe.`
      : stage === 'frozen'
        ? 'No new term loans while the credit line is frozen.'
        : `No term loans yet: the bank lends up to ${formatMultiple(TERM_CAPACITY_ARR_MULTIPLE)} your annual recurring revenue, less the term loans you owe, from at least ${formatMoney(TERM_LOAN_MIN)}.`;
  const fixed = formatRate(quote.rate.rateBps);
  const figures: Figure[] = [
    {
      label: 'Monthly payment',
      value: valid ? formatMoney(quote.payment) : '–',
      sub: valid && quote.lastPayment !== quote.payment ? `last one ${formatMoney(quote.lastPayment)}` : undefined,
      tone: valid ? undefined : 'muted',
    },
    {
      label: 'Interest at this month’s close',
      value: valid ? formatMoney(quote.stubInterest) : '–',
      sub: valid ? 'interest only, for the days left this month' : undefined,
      tone: valid ? undefined : 'muted',
    },
    { label: 'Total interest', value: valid ? formatMoney(quote.totalInterest) : '–', tone: valid ? undefined : 'muted' },
    { label: 'Cash after', value: formatMoney(quote.cashAfter), tone: quote.cashAfter < 0 ? 'danger' : undefined },
  ];
  const warning = quote.breachesCovenant
    ? `At today's cash flow this loan breaks ${brokenCovenants(quote.after)} at the next month close: ${escalation(stage)}.`
    : null;
  return {
    ok: quote.ok,
    reasons: quote.reasons,
    confirmLabel: valid ? `Borrow ${formatMoney(quote.amount)} over ${quote.termYears} years` : 'Borrow',
    capacity,
    rate: quote.rate.penaltyBps > 0 ? `${fixed} fixed (${formatRate(quote.rate.effectiveRateBps)} while the penalty lasts)` : `${fixed} fixed`,
    rateRows: rateRows(quote.rate, { kind: 'term', years: quote.termYears }),
    figures,
    checks: [leverageCheck(quote.before, quote.after), coverageCheck(quote.before, quote.after)],
    warning,
  };
}

export interface LoanView {
  id: LoanId;
  /** "#2 · 7 years at 7.25%" */
  title: string;
  balance: string;
  payment: string;
  /** "83 payments left", or "first payment: interest only" in the month it was taken. */
  schedule: string;
  /** The penalty surcharge it pays today, or ''. */
  penalty: string;
}

/** True in the month a loan was taken: that close charges only interest for the days it was held. */
export function inFirstMonth(loan: Pick<TermLoan, 'originatedDay'>, day: number): boolean {
  const taken = dateOf(loan.originatedDay);
  const now = dateOf(day);
  return taken.year === now.year && taken.month === now.month;
}

export function loanView(loan: TermLoan, day: number, penaltyBps: number): LoanView {
  const first = inFirstMonth(loan, day);
  return {
    id: loan.id,
    title: `#${loan.id} · ${loan.termMonths / 12} years at ${formatRate(loan.rateBps)}`,
    balance: formatMoney(loan.balance),
    payment: `${formatMoney(loan.payment)}/mo`,
    schedule: first ? `first payment: interest only, then ${plural(loan.monthsLeft, 'payment')}` : `${plural(loan.monthsLeft, 'payment')} left`,
    penalty: penaltyBps > 0 ? `${formatBpsDelta(penaltyBps)} penalty while it lasts` : '',
  };
}

export interface PrepayView {
  ok: boolean;
  reasons: string[];
  /** "Accrued interest $40 · Total $10,040 · New payment $1,620/mo" */
  summary: string;
  label: string;
}

export function prepayView(quote: PrepayQuote): PrepayView {
  const parts = [`Accrued interest ${formatMoney(quote.accruedInterest)}`, `cash needed ${formatMoney(quote.total)}`];
  parts.push(quote.paysOff ? 'pays the loan off' : `new payment ${formatMoney(quote.paymentAfter)}/mo`);
  return {
    ok: quote.ok,
    reasons: quote.reasons,
    summary: quote.ok ? parts.join(' · ') : '',
    label: quote.ok ? (quote.paysOff ? `Pay off for ${formatMoney(quote.total)}` : `Prepay ${formatMoney(quote.total)}`) : 'Prepay',
  };
}

export interface CovenantView {
  stage: string;
  tone: BankTone;
  meaning: string;
  checks: CovenantCheck[];
  figures: Figure[];
  next: string;
  /** "How to cure", or "The tests" while compliant. */
  cureLabel: string;
  cure: string;
}

/** The covenant section: stage, today's tests, the cash flow behind them, and what comes next. */
export function covenantView(stage: CovenantStage, compliantCloses: number, metrics: CovenantMetrics): CovenantView {
  const share = formatPercent(UNDERWRITING_MIN_MARGIN);
  return {
    stage: STAGE_LABEL[stage],
    tone: STAGE_TONE[stage],
    meaning: stageMeaning(stage),
    checks: [leverageCheck(null, metrics), coverageCheck(null, metrics)],
    figures: [
      { label: 'Debt', value: formatMoney(metrics.totalDebt) },
      { label: 'Annual recurring revenue', value: `${formatMoney(metrics.arr)}/yr` },
      {
        label: 'Cash flow the bank counts',
        value: `${formatMoney(metrics.underwritingCashFlow)}/yr`,
        sub: `your yearly operating cash flow (${formatMoney(metrics.annualOperatingCashFlow)}), or ${share} of recurring revenue if that is more`,
        tone: metrics.underwritingCashFlow > 0 ? undefined : 'danger',
      },
      { label: 'Debt service, next 12 months', value: `${formatMoney(metrics.annualDebtService)}/yr` },
    ],
    next: stageNext(stage),
    cureLabel: stage === 'compliant' ? 'The tests' : 'How to cure',
    cure: stage === 'compliant' ? `The bank checks ${covenantLimits()} at every month close.` : cureText(stage, compliantCloses),
  };
}

/** Day of the next month close (the 1st of next month). */
export function nextCloseDay(day: number): number {
  const d = dateOf(day);
  return d.month === 12 ? dayOf({ year: d.year + 1, month: 1, day: 1 }) : dayOf({ year: d.year, month: d.month + 1, day: 1 });
}

/** "≈ $3,120 on Feb 1, 2027", warn-toned when cash is below it. */
export function nextPaymentFigure(estimate: number, cash: number, day: number): Figure {
  if (estimate <= 0) return { label: 'Next payment', value: 'None due', tone: 'muted' };
  const short = cash < estimate;
  return {
    label: 'Next payment',
    value: `≈ ${formatMoney(estimate)}`,
    sub: `at the ${formatDate(nextCloseDay(day))} close${short ? ': more than your cash' : ''}`,
    tone: short ? 'warn' : undefined,
  };
}

/** A typed amount the sim can take: a whole number >= 1, else null. */
export function parseAmount(text: string): number | null {
  const n = parseNumberField(text.replace(/[$,\s]/g, ''));
  return Number.isInteger(n) && n >= 1 ? n : null;
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

const ENTER_AMOUNT = 'Enter an amount in whole dollars';

let bankIds = 0;

interface FigureDom {
  value: HTMLElement;
  sub: HTMLElement;
  row: HTMLElement;
}

interface LoanDom {
  root: HTMLElement;
  title: HTMLElement;
  balance: HTMLElement;
  payment: HTMLElement;
  schedule: HTMLElement;
  penalty: HTMLElement;
  input: HTMLInputElement;
  all: HTMLButtonElement;
  prepay: HTMLButtonElement;
  quote: HTMLElement;
  reasons: HTMLElement;
  error: HTMLElement;
  quoteKey: string;
}

function toneClass(node: HTMLElement, tone: Figure['tone']): void {
  for (const t of ['ok', 'warn', 'danger', 'muted'] as const) node.classList.toggle(`tone-${t}`, tone === t);
}

function setDisabled(node: HTMLButtonElement | HTMLInputElement | HTMLFieldSetElement, disabled: boolean): void {
  if (node.disabled !== disabled) node.disabled = disabled;
}

function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/** A <dl> of label/value rows, built once and updated in place. */
class FigureList {
  readonly root: HTMLDListElement;
  private readonly rows: FigureDom[] = [];

  constructor(cls: string, private readonly testPrefix?: string) {
    this.root = el('dl', { class: `bank-figs ${cls}` });
  }

  set(figures: Figure[]): void {
    while (this.rows.length < figures.length) {
      const value = el('span', { class: 'num' });
      const sub = el('small', { class: 'bank-sub' });
      const label = el('dt');
      const row = el('div', { class: 'bank-fig' }, [label, el('dd', {}, [value, sub])]);
      this.rows.push({ value, sub, row });
      this.root.append(row);
    }
    this.rows.forEach((dom, i) => {
      const f = figures[i];
      dom.row.hidden = !f;
      if (!f) return;
      setText(dom.row.firstElementChild as HTMLElement, f.label);
      if (this.testPrefix) setAttr(dom.value, 'data-testid', `${this.testPrefix}-${f.label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-$/, '')}`);
      setText(dom.value, f.value);
      toneClass(dom.value, f.tone);
      setText(dom.sub, f.sub ?? '');
      dom.sub.hidden = !f.sub;
    });
  }
}

/** A list rebuilt only when its content changes (no inputs inside). */
function setList(list: HTMLElement, items: string[], key: { value: string }): void {
  const next = items.join('\n');
  if (next === key.value) return;
  key.value = next;
  list.replaceChildren(...items.map((t) => el('li', { text: t })));
  list.hidden = items.length === 0;
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

function setChecks(list: HTMLElement, checks: CovenantCheck[], key: { value: string }): void {
  const next = JSON.stringify(checks);
  if (next === key.value) return;
  key.value = next;
  list.replaceChildren(
    ...checks.map((c) =>
      el('div', { class: `bank-check ${c.ok ? 'is-ok' : 'is-breach'}`, attrs: { 'data-check': c.label.toLowerCase() } }, [
        el('dt', { text: c.label }),
        el('dd', {}, [
          el('span', { class: 'num bank-check-value', text: c.value }),
          el('small', { class: 'bank-check-limit', text: c.limit }),
          el('span', { class: 'bank-check-mark', text: c.mark }),
        ]),
      ]),
    ),
  );
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
      subtitle: 'Credit line, term loans and covenants',
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

class BankView {
  private seen = { state: null as GameState | null, day: -1, revision: -1 };
  private readonly stageBadge: HTMLElement;
  private readonly summary: FigureList;
  // Credit line.
  private readonly creditFigures: FigureList;
  private readonly creditNote: HTMLElement;
  private readonly creditRate: HTMLElement;
  private readonly creditRateRows: HTMLElement;
  private readonly creditRateKey = { value: '' };
  private readonly drawInput: HTMLInputElement;
  private readonly drawButton: HTMLButtonElement;
  private readonly drawPresetButtons: HTMLButtonElement[] = [];
  private readonly drawReasons: HTMLElement;
  private readonly drawReasonsKey = { value: '' };
  private readonly repayForm: HTMLElement;
  private readonly repayInput: HTMLInputElement;
  private readonly repayButton: HTMLButtonElement;
  private readonly repayPresetButtons: HTMLButtonElement[] = [];
  private readonly creditError: HTMLElement;
  private drawPresets: Preset[] = [];
  private repayPresets: Preset[] = [];
  // Term loan builder.
  private readonly termFieldset: HTMLFieldSetElement;
  private readonly termCapacity: HTMLElement;
  private readonly termInput: HTMLInputElement;
  private readonly termPresetButtons: HTMLButtonElement[] = [];
  private readonly yearButtons = new Map<TermYears, HTMLButtonElement>();
  private readonly termRate: HTMLElement;
  private readonly termRateRows: HTMLElement;
  private readonly termRateKey = { value: '' };
  private readonly termFigures: FigureList;
  private readonly termChecks: HTMLElement;
  private readonly termChecksKey = { value: '' };
  private readonly termWarning: HTMLElement;
  private readonly termReasons: HTMLElement;
  private readonly termReasonsKey = { value: '' };
  private readonly termConfirm: HTMLButtonElement;
  private readonly termError: HTMLElement;
  private termPresets: Preset[] = [];
  private termYears: TermYears = TERM_LOAN_YEARS[0] ?? 5;
  /** The player typed an amount (or picked a preset): capacity changes leave it alone. */
  private termDirty = false;
  private termMax = -1;
  // Loans.
  private readonly loanList: HTMLElement;
  private readonly loansEmpty: HTMLElement;
  private readonly loans = new Map<LoanId, LoanDom>();
  // Covenants.
  private readonly covStage: HTMLElement;
  private readonly covMeaning: HTMLElement;
  private readonly covChecks: HTMLElement;
  private readonly covChecksKey = { value: '' };
  private readonly covFigures: FigureList;
  private readonly covNext: HTMLElement;
  private readonly covCureLabel: HTMLElement;
  private readonly covCure: HTMLElement;
  private readonly repayReason: HTMLElement;

  constructor(
    sheet: Sheet,
    private readonly session: GameSession,
    private readonly toasts: Toasts,
  ) {
    const id = `bank-${++bankIds}`;
    const section = (key: string, title: string, children: (Node | null)[]) =>
      el('section', { class: `bank-section bank-${key}`, attrs: { 'aria-labelledby': `${id}-${key}`, 'data-testid': `bank-${key}` } }, [
        el('h3', { text: title, attrs: { id: `${id}-${key}` } }),
        ...children,
      ]);
    const amountInput = (label: string, testid: string) =>
      el('input', {
        class: 'field num bank-amount',
        attrs: { type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: 'Amount', 'aria-label': label, 'data-testid': testid },
      });
    const button = (label: string, cls: string, run: () => void, attrs: Record<string, string> = {}) =>
      el('button', { class: `btn ${cls}`, text: label, attrs: { type: 'button', ...attrs }, on: { click: run } });
    const moneyField = (input: HTMLInputElement) => el('span', { class: 'money-field bank-money' }, [el('span', { text: '$', attrs: { 'aria-hidden': 'true' } }), input]);
    const error = () => {
      const node = el('p', { class: 'sheet-error', attrs: { role: 'alert' } });
      node.hidden = true;
      return node;
    };
    const reasons = () => el('ul', { class: 'blockers bank-reasons', attrs: { hidden: '' } });

    // Summary: stage badge, debt and the next payment.
    this.stageBadge = el('span', { class: 'bank-badge', attrs: { 'data-testid': 'bank-stage' } });
    this.summary = new FigureList('bank-summary-figs', 'bank-summary');
    const summary = el('div', { class: 'bank-summary', attrs: { role: 'status' } }, [this.stageBadge, this.summary.root]);

    // a) Credit line.
    this.creditFigures = new FigureList('bank-credit-figs', 'bank-credit');
    this.creditNote = el('p', { class: 'bank-note' });
    this.creditRate = el('span', { class: 'num', attrs: { 'data-testid': 'bank-credit-rate' } });
    this.creditRateRows = el('dl', { class: 'bank-rate-rows' });
    this.drawInput = amountInput('Amount to draw', 'bank-draw-amount');
    this.drawButton = button('Draw', 'sheet-primary bank-go', () => this.draw(), { 'data-testid': 'bank-draw' });
    const drawPresets = el('div', { class: 'bank-presets', attrs: { role: 'group', 'aria-label': 'Draw presets' } });
    for (let i = 0; i < DRAW_PRESETS.length + 2; i++) {
      const b = button('', 'bank-preset', () => this.pickPreset(this.drawInput, this.drawPresets[i]));
      this.drawPresetButtons.push(b);
      drawPresets.append(b);
    }
    this.drawReasons = reasons();
    this.repayInput = amountInput('Amount to repay', 'bank-repay-amount');
    this.repayButton = button('Repay', 'sheet-secondary bank-go', () => this.repay(), { 'data-testid': 'bank-repay' });
    const repayPresets = el('div', { class: 'bank-presets', attrs: { role: 'group', 'aria-label': 'Repay presets' } });
    for (let i = 0; i < 2; i++) {
      const b = button('', 'bank-preset', () => this.pickPreset(this.repayInput, this.repayPresets[i]));
      this.repayPresetButtons.push(b);
      repayPresets.append(b);
    }
    this.repayReason = el('p', { class: 'bank-note', attrs: { hidden: '' } });
    this.repayForm = el('div', { class: 'bank-form' }, [
      el('div', { class: 'bank-form-row' }, [el('span', { class: 'bank-form-label', text: 'Repay' }), moneyField(this.repayInput), this.repayButton]),
      repayPresets,
      this.repayReason,
    ]);
    this.creditError = error();
    const credit = section('credit', 'Credit line', [
      this.creditFigures.root,
      this.creditNote,
      el('div', { class: 'bank-rate' }, [
        el('p', { class: 'bank-rate-total' }, [el('span', { text: 'Rate today' }), this.creditRate]),
        this.creditRateRows,
      ]),
      el('div', { class: 'bank-form' }, [
        el('div', { class: 'bank-form-row' }, [el('span', { class: 'bank-form-label', text: 'Draw' }), moneyField(this.drawInput), this.drawButton]),
        drawPresets,
        this.drawReasons,
      ]),
      this.repayForm,
      this.creditError,
    ]);

    // b) Term loan builder.
    this.termCapacity = el('p', { class: 'bank-note', attrs: { 'data-testid': 'bank-term-capacity' } });
    this.termInput = amountInput('Term loan amount', 'bank-term-amount');
    const termPresets = el('div', { class: 'bank-presets', attrs: { role: 'group', 'aria-label': 'Share of what you can borrow' } });
    for (let i = 0; i < 4; i++) {
      const b = button('', 'bank-preset', () => {
        this.termDirty = true;
        this.pickPreset(this.termInput, this.termPresets[i]);
      });
      this.termPresetButtons.push(b);
      termPresets.append(b);
    }
    const years = el('div', { class: 'bank-years', attrs: { role: 'radiogroup', 'aria-label': 'Term' } });
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
    this.termRate = el('span', { class: 'num', attrs: { 'data-testid': 'bank-term-rate' } });
    this.termRateRows = el('dl', { class: 'bank-rate-rows' });
    this.termFigures = new FigureList('bank-term-figs', 'bank-term');
    this.termChecks = el('dl', { class: 'bank-checks' });
    this.termWarning = el('p', { class: 'bank-warning', attrs: { 'data-testid': 'bank-term-warning', hidden: '' } });
    this.termReasons = reasons();
    this.termConfirm = button('Borrow', 'sheet-primary bank-borrow', () => this.borrow(), { 'data-testid': 'bank-borrow' });
    this.termError = error();
    this.termFieldset = el('fieldset', { class: 'bank-fieldset' }, [
      el('legend', { class: 'visually-hidden', text: 'New term loan' }),
      el('div', { class: 'bank-form-row' }, [el('span', { class: 'bank-form-label', text: 'Amount' }), moneyField(this.termInput), years]),
      termPresets,
    ]);
    const term = section('term', 'New term loan', [
      this.termCapacity,
      this.termFieldset,
      el('div', { class: 'bank-quote', attrs: { role: 'status', 'aria-label': 'Term loan quote' } }, [
        el('div', { class: 'bank-rate' }, [el('p', { class: 'bank-rate-total' }, [el('span', { text: 'Rate' }), this.termRate]), this.termRateRows]),
        this.termFigures.root,
        el('h4', { class: 'bank-subhead', text: 'Covenants after this loan' }),
        this.termChecks,
      ]),
      this.termWarning,
      this.termReasons,
      el('div', { class: 'bank-confirm' }, [this.termConfirm]),
      this.termError,
    ]);

    // c) Loans.
    this.loanList = el('ul', { class: 'bank-loans', attrs: { 'data-testid': 'bank-loans' } });
    this.loansEmpty = el('p', { class: 'bank-empty', text: 'No term loans' });
    const loans = section('loans', 'Your term loans', [this.loansEmpty, this.loanList]);

    // d) Covenants.
    this.covStage = el('span', { class: 'bank-badge', attrs: { 'data-testid': 'bank-covenant-stage' } });
    this.covMeaning = el('p', { class: 'bank-stage-meaning' });
    this.covChecks = el('dl', { class: 'bank-checks', attrs: { 'data-testid': 'bank-covenant-checks' } });
    this.covFigures = new FigureList('bank-cov-figs', 'bank-cov');
    this.covNext = el('span', { class: 'bank-next', attrs: { 'data-testid': 'bank-covenant-next' } });
    this.covCure = el('span', { class: 'bank-cure', attrs: { 'data-testid': 'bank-covenant-cure' } });
    this.covCureLabel = el('strong');
    const covenant = section('covenant', 'Covenants', [
      el('div', { class: 'bank-stage-line' }, [this.covStage, this.covMeaning]),
      this.covChecks,
      this.covFigures.root,
      el('p', { class: 'bank-explain' }, [el('strong', { text: 'What happens next: ' }), this.covNext]),
      el('p', { class: 'bank-explain' }, [this.covCureLabel, this.covCure]),
    ]);

    sheet.body.append(summary, credit, term, loans, covenant);

    // Typing updates the quotes at once; an Enter acts like the form's button.
    this.drawInput.addEventListener('input', () => this.hideError(this.creditError));
    this.repayInput.addEventListener('input', () => this.hideError(this.creditError));
    this.termInput.addEventListener('input', () => {
      this.termDirty = true;
      this.hideError(this.termError);
      this.refreshTerm(this.session.state);
    });
    const enter = (input: HTMLInputElement, run: () => void) =>
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          run();
        }
      });
    enter(this.drawInput, () => this.drawButton.click());
    enter(this.repayInput, () => this.repayButton.click());
    enter(this.termInput, () => this.termConfirm.click());
  }

  private hideError(node: HTMLElement): void {
    node.hidden = true;
  }

  private showError(node: HTMLElement, message: string): void {
    setText(node, message);
    node.hidden = false;
    this.toasts.show(message, 'err');
  }

  private pickPreset(input: HTMLInputElement, preset: Preset | undefined): void {
    if (!preset || preset.disabled) return;
    input.value = String(preset.amount);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  private pickYears(years: TermYears): void {
    this.termYears = years;
    for (const [y, b] of this.yearButtons) {
      setAttr(b, 'aria-checked', String(y === years));
      b.tabIndex = y === years ? 0 : -1;
    }
    this.hideError(this.termError);
    this.refreshTerm(this.session.state);
  }

  /** Refresh every figure when the day, a command or the game changed (or `force`). */
  refresh(force: boolean): void {
    const state = this.session.state;
    const { seen } = this;
    if (!force && seen.state === state && seen.day === state.day && seen.revision === this.session.revision) return;
    this.seen = { state, day: state.day, revision: this.session.revision };
    const offer = creditOffer(state);
    const metrics = covenantMetrics(state);
    const stage = state.debt.covenant.stage;

    // Summary.
    setText(this.stageBadge, STAGE_LABEL[stage]);
    this.setBadgeTone(this.stageBadge, STAGE_TONE[stage]);
    this.summary.set([
      { label: 'Debt', value: formatMoney(totalDebt(state)) },
      nextPaymentFigure(estimateNextDebtService(state), state.finance.cash, state.day),
      { label: 'Cash', value: formatMoney(state.finance.cash), tone: state.finance.cash < 0 ? 'danger' : undefined },
    ]);

    // Credit line.
    const credit = creditView(offer);
    this.creditFigures.set(credit.figures);
    setText(this.creditNote, credit.note);
    setText(this.creditRate, credit.rate);
    setRateRows(this.creditRateRows, credit.rateRows, this.creditRateKey);
    this.drawPresets = credit.drawPresets;
    this.drawPresets.forEach((p, i) => {
      const b = this.drawPresetButtons[i];
      if (!b) return;
      setText(b, p.label);
      setDisabled(b, !credit.canDraw || p.disabled);
    });
    setDisabled(this.drawInput, !credit.canDraw);
    setDisabled(this.drawButton, !credit.canDraw);
    setList(this.drawReasons, credit.reasons, this.drawReasonsKey);
    this.repayForm.hidden = offer.balance <= 0;
    this.repayPresets = credit.repayPresets;
    this.repayPresets.forEach((p, i) => {
      const b = this.repayPresetButtons[i];
      if (!b) return;
      setText(b, p.label);
      setDisabled(b, !credit.canRepay || p.disabled);
    });
    setDisabled(this.repayButton, !credit.canRepay);
    setText(this.repayReason, credit.repayReason);
    this.repayReason.hidden = credit.repayReason === '';

    // Term loan builder: a new capacity resets the default amount unless the player chose one.
    const max = termCapacity(state);
    if (max !== this.termMax) {
      this.termMax = max;
      if (!this.termDirty && document.activeElement !== this.termInput) this.termInput.value = String(defaultTermAmount(max));
      this.termPresets = termPresets(max);
      this.termPresets.forEach((p, i) => {
        const b = this.termPresetButtons[i];
        if (!b) return;
        setText(b, p.label);
        setAttr(b, 'aria-label', `${p.label} of what you can borrow: ${formatMoney(p.amount)}`);
        setDisabled(b, p.disabled);
      });
    }
    setDisabled(this.termFieldset, max <= 0);
    this.refreshTerm(state);

    // Loans.
    this.refreshLoans(state);

    // Covenants.
    const cov = covenantView(stage, state.debt.covenant.compliantCloses, metrics);
    setText(this.covStage, cov.stage);
    this.setBadgeTone(this.covStage, cov.tone);
    setText(this.covMeaning, cov.meaning);
    setChecks(this.covChecks, cov.checks, this.covChecksKey);
    this.covFigures.set(cov.figures);
    setText(this.covNext, cov.next);
    setText(this.covCureLabel, `${cov.cureLabel}: `);
    setText(this.covCure, cov.cure);
  }

  private setBadgeTone(node: HTMLElement, tone: BankTone): void {
    for (const t of ['ok', 'warn', 'danger'] as const) node.classList.toggle(`tone-${t}`, tone === t);
  }

  private refreshTerm(state: GameState): void {
    const amount = parseNumberField(this.termInput.value);
    const quote = quoteTermLoan(state, amount, this.termYears);
    const view = termView(quote, state.debt.covenant.stage);
    setAttr(this.termInput, 'aria-invalid', String(!quote.ok && quote.maxAmount > 0 && quote.payment === 0));
    setText(this.termCapacity, view.capacity);
    setText(this.termRate, view.rate);
    setRateRows(this.termRateRows, view.rateRows, this.termRateKey);
    this.termFigures.set(view.figures);
    setChecks(this.termChecks, view.checks, this.termChecksKey);
    setText(this.termWarning, view.warning ?? '');
    this.termWarning.hidden = view.warning === null;
    setList(this.termReasons, view.reasons, this.termReasonsKey);
    setText(this.termConfirm, view.confirmLabel);
    setDisabled(this.termConfirm, !view.ok);
  }

  private refreshLoans(state: GameState): void {
    const loans = state.debt.loans;
    this.loansEmpty.hidden = loans.length > 0;
    this.loanList.hidden = loans.length === 0;
    const open = new Set(loans.map((l) => l.id));
    for (const [id, dom] of this.loans) {
      if (!open.has(id)) {
        dom.root.remove();
        this.loans.delete(id);
      }
    }
    const penalty = state.debt.covenant.stage === 'penalty' || state.debt.covenant.stage === 'frozen';
    loans.forEach((loan, i) => {
      let dom = this.loans.get(loan.id);
      if (!dom) {
        dom = this.buildLoan(loan.id);
        this.loans.set(loan.id, dom);
      }
      // Keep list order (ascending id) without moving rows that are already in place.
      if (this.loanList.children[i] !== dom.root) this.loanList.insertBefore(dom.root, this.loanList.children[i] ?? null);
      const view = loanView(loan, state.day, penalty ? PENALTY_STEP_UP_BPS : 0);
      setText(dom.title, view.title);
      setText(dom.balance, view.balance);
      setText(dom.payment, view.payment);
      setText(dom.schedule, view.schedule);
      setText(dom.penalty, view.penalty);
      dom.penalty.hidden = view.penalty === '';
      this.refreshPrepay(state, dom, loan.id);
    });
  }

  private buildLoan(id: LoanId): LoanDom {
    const fig = (label: string, value: HTMLElement) => el('div', { class: 'bank-fig' }, [el('dt', { text: label }), el('dd', {}, [value])]);
    const title = el('h4', { class: 'bank-loan-title' });
    const balance = el('span', { class: 'num', attrs: { 'data-testid': `bank-loan-${id}-balance` } });
    const payment = el('span', { class: 'num' });
    const schedule = el('span', { class: 'bank-loan-schedule' });
    const penalty = el('p', { class: 'bank-loan-penalty' });
    const input = el('input', {
      class: 'field num bank-amount',
      attrs: { type: 'number', inputmode: 'numeric', min: '1', step: '1', placeholder: 'Amount', 'aria-label': `Amount to prepay on loan #${id}` },
    });
    const quote = el('p', { class: 'bank-prepay-quote', attrs: { role: 'status' } });
    const reasons = el('ul', { class: 'blockers bank-reasons', attrs: { hidden: '' } });
    const error = el('p', { class: 'sheet-error', attrs: { role: 'alert', hidden: '' } });
    const dom: LoanDom = {
      root: el('li', { class: 'bank-loan', attrs: { 'data-loan': String(id) } }),
      title,
      balance,
      payment,
      schedule,
      penalty,
      input,
      all: el('button', { class: 'btn bank-preset', text: 'All', attrs: { type: 'button', 'aria-label': `Prepay all of loan #${id}` } }),
      prepay: el('button', { class: 'btn sheet-secondary bank-go', text: 'Prepay', attrs: { type: 'button', 'data-testid': `bank-prepay-${id}` } }),
      quote,
      reasons,
      error,
      quoteKey: '',
    };
    dom.all.addEventListener('click', () => {
      const loan = this.session.state.debt.loans.find((l) => l.id === id);
      if (!loan) return;
      input.value = String(loan.balance);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('input', () => {
      error.hidden = true;
      dom.quoteKey = '';
      this.refreshPrepay(this.session.state, dom, id);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        dom.prepay.click();
      }
    });
    dom.prepay.addEventListener('click', () => this.prepay(id, dom));
    dom.root.append(
      title,
      el('dl', { class: 'bank-figs bank-loan-figs' }, [fig('Balance', balance), fig('Payment', payment), fig('Schedule', schedule)]),
      penalty,
      el('div', { class: 'bank-form-row bank-prepay-row' }, [
        el('span', { class: 'bank-form-label', text: 'Prepay' }),
        el('span', { class: 'money-field bank-money' }, [el('span', { text: '$', attrs: { 'aria-hidden': 'true' } }), input]),
        dom.all,
        dom.prepay,
      ]),
      quote,
      reasons,
      error,
    );
    return dom;
  }

  private refreshPrepay(state: GameState, dom: LoanDom, id: LoanId): void {
    const text = dom.input.value.trim();
    if (text === '') {
      setText(dom.quote, '');
      dom.quote.hidden = true;
      dom.reasons.hidden = true;
      setText(dom.prepay, 'Prepay');
      setDisabled(dom.prepay, true);
      return;
    }
    const quote = quotePrepay(state, id, parseNumberField(text));
    const view = prepayView(quote);
    setText(dom.quote, view.summary);
    dom.quote.hidden = view.summary === '';
    const key = { value: dom.quoteKey };
    setList(dom.reasons, view.reasons, key);
    dom.quoteKey = key.value;
    setText(dom.prepay, view.label);
    setDisabled(dom.prepay, !view.ok);
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private draw(): void {
    const amount = parseAmount(this.drawInput.value);
    if (amount === null) {
      this.showError(this.creditError, ENTER_AMOUNT);
      return;
    }
    const result = this.session.dispatch({ type: 'drawCredit', amount });
    if (!result.ok) {
      this.showError(this.creditError, `Nothing drawn: ${result.reason}`);
      return;
    }
    this.hideError(this.creditError);
    this.drawInput.value = '';
    this.toasts.show(`Drew ${formatMoney(amount)} from the credit line`, 'ok');
    this.refresh(true);
  }

  private repay(): void {
    const amount = parseAmount(this.repayInput.value);
    if (amount === null) {
      this.showError(this.creditError, ENTER_AMOUNT);
      return;
    }
    const result = this.session.dispatch({ type: 'repayCredit', amount });
    if (!result.ok) {
      this.showError(this.creditError, `Nothing repaid: ${result.reason}`);
      return;
    }
    this.hideError(this.creditError);
    this.repayInput.value = '';
    this.toasts.show(`Repaid ${formatMoney(amount)} of the credit line`, 'ok');
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
    const terms = loan ? ` at ${formatRate(loan.rateBps)}: ${formatMoney(loan.payment)} a month` : '';
    this.toasts.show(`Borrowed ${formatMoney(amount)} over ${years} years${terms}`, 'ok');
    this.termDirty = false;
    this.termMax = -1;
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
      const message = `Nothing prepaid: ${result.reason}`;
      setText(dom.error, message);
      dom.error.hidden = false;
      this.toasts.show(message, 'err');
      return;
    }
    dom.error.hidden = true;
    dom.input.value = '';
    this.toasts.show(
      quote.paysOff ? `Loan #${id} paid off for ${formatMoney(result.cost)}` : `Prepaid ${formatMoney(amount)} of loan #${id} (${formatMoney(result.cost)} with interest)`,
      'ok',
    );
    this.refresh(true);
  }
}
