// The report panel at the right edge of the map (round 4c/4d: a small
// version of the month summary, after the owner found the old list of every
// figure "almost too much density of information"). For the last closed
// month, top to bottom: the month and the collapse toggle; "Cash went down
// $32,539 · $332,590 left"; money in and money out as two thin bars on one
// scale, each with its total and a compact legend (the summary's sources,
// groups and colors); the customers line with "See customers"; while the
// month built fiber, what building cost and the cost per home passed against
// the target, in words; with debt, the bank's health in the one word the
// Bank, the HUD chip and the summary share, as a link to the Bank; this
// month's spending so far; and "See the full books", which opens the
// briefing sheet's books view for this report on its own. Every figure the
// old list had is in those books (the tiles, the itemized money, and the
// "More figures" rows built here: reportRows). Phones and short screens
// start collapsed to the cash line, the customers line and the bank's word.
// No jargon in the panel (no ARPU, CPGA, leverage, coverage, ×).
//
// The words come from the month summary's view model (briefing.ts:
// moneyBars, cashHeadline, CPP_BAND_TEXT) and ui/health.ts; the figures from
// the sim only (advisor.briefingMoney over the one report, metrics.reportKpis,
// debt.bankHealth for today's health, like the HUD chip and the Bank). The
// panel computes no money figure itself. reportPanelView is pure and
// unit-tested; ReportPanel builds its DOM once and updates it in place.
//
// Also here: subscriberMovements (the books' customers tile), the month-close
// toast (monthClosedMessage / monthClosedTone, main.ts) and the full books'
// "More figures" rows (reportRows: kpiRows, overheadRow, supportRow,
// operationsRows, financingRows).
//
// Owner: ui-summary workstream (round 4c/4d); ui-economy, ui-bank and
// ui-briefing before.

import { briefingMoney } from '../sim/advisor';
import { COVENANT_MAX_LEVERAGE, COVENANT_MIN_COVERAGE, CPP_TARGET } from '../sim/balance';
import { MONTH_ABBR, dateOf, formatMonth } from '../sim/calendar';
import { bankHealth } from '../sim/debt';
import { operatingCashFlow, reportKpis } from '../sim/metrics';
import type { CppBand, GameState, MonthlyReport } from '../sim/types';
// briefing.ts imports this module's row builders too: both use each other's exports only inside functions.
import { CPP_BAND_TEXT, cashHeadline, moneyBars, wordsText } from './briefing';
import type { MoneyBar, Words } from './briefing';
import { el, setText } from './dom';
import { formatMaybeMoney, formatMoney, formatMonthLong, formatNumber, formatPercent, formatRatio, formatSignedMoney, plural } from './format';
import { HEALTH_TONE, healthSentence, healthWordOf } from './health';
import type { HealthTone } from './health';

// ---------------------------------------------------------------------------
// The full books' "More figures" (briefing.ts booksView lists these rows)
// ---------------------------------------------------------------------------

export type ReportRowKey =
  | 'arpu'
  | 'cpga'
  | 'costPerConnection'
  | 'operatingCashFlow'
  | 'overhead'
  | 'support'
  | 'outages'
  | 'outageCredits'
  | 'priceChurn'
  | 'tierMoves'
  | 'incumbentPromos'
  | 'sweep'
  | 'debt'
  | 'leverage'
  | 'coverage';

export interface ReportRow {
  key: ReportRowKey;
  /** Plain words; a trade term only in brackets after its plain meaning ("Average bill per customer (ARPU)"). */
  label: string;
  /** Display value; '–' when the figure is undefined (no customers, a report from an earlier build). */
  value: string;
  /** Coloring beside the words: a negative amount, or a bank limit the month went over. */
  tone: 'negative' | 'breach' | null;
  /** Secondary line, e.g. the bank's limit. */
  detail: string | null;
  /** Longer explanation for a tooltip. */
  hint: string;
  /** Nothing to say this month (nothing happened, or the report predates the figure): the books leave the row out. */
  quiet: boolean;
}

const DASH = '–';

/** "+30 new, 5 churned, 2 lost service" for a month's subscriber movements (the full books' customers tile). */
export function subscriberMovements(report: MonthlyReport): string | null {
  const stats = report.stats;
  if (!stats) return null;
  const parts = [`+${formatNumber(stats.grossAdds)} new`, `${formatNumber(stats.churned)} churned`];
  if (stats.lostService > 0) parts.push(`${formatNumber(stats.lostService)} lost service`);
  return parts.join(', ');
}

/**
 * The figures of a closed month the full books' tiles and money lines do not
 * already show, in display order: the KPIs, the overhead's total, the support
 * part of the per-customer cost, round 4's operations and the month's bank
 * figures. With the tiles (net, cash, customers and their moves, homes
 * passed, take rate, cost per home passed, debt) and the itemized money in
 * and out (bills, borrowing, every running cost and overhead line, pole rent,
 * repairs, building, interest, principal), these are every figure the old
 * report panel listed.
 */
export function reportRows(report: MonthlyReport): ReportRow[] {
  return [...kpiRows(report), overheadRow(report), supportRow(report), ...operationsRows(report), ...financingRows(report)];
}

/**
 * The month's KPIs (metrics.reportKpis; '–' for a report without stats, one
 * migrated from a schemaVersion 1 save, or with nothing to divide by) and its
 * operating cash flow (metrics.operatingCashFlow, which works on any report).
 */
export function kpiRows(report: MonthlyReport): ReportRow[] {
  const kpis = reportKpis(report);
  const flow = operatingCashFlow(report);
  return [
    {
      key: 'arpu',
      label: 'Average bill per customer (ARPU)',
      value: kpis?.arpu != null ? `${formatMoney(kpis.arpu)}/mo` : DASH,
      tone: null,
      detail: null,
      hint: 'The month’s customer bills over its average number of customers',
      quiet: false,
    },
    {
      key: 'cpga',
      label: 'Marketing per new customer (CPGA)',
      value: formatMaybeMoney(kpis?.cpga ?? null),
      tone: null,
      detail: null,
      hint: 'The month’s marketing spend over the customers who joined',
      quiet: false,
    },
    {
      key: 'costPerConnection',
      label: 'Install cost per connection',
      value: formatMaybeMoney(kpis?.costPerConnection ?? null),
      tone: null,
      detail: null,
      hint: 'Lifetime install spend (drops, ONTs, building routers) over every connection made',
      quiet: false,
    },
    {
      key: 'operatingCashFlow',
      label: 'Bills less running costs (operating cash flow)',
      value: formatSignedMoney(flow),
      tone: flow < 0 ? 'negative' : null,
      detail: null,
      hint: 'Customer bills minus running costs, before building, installs and loans',
      quiet: false,
    },
  ];
}

/**
 * The month's overhead (totals.overhead), the old panel's Overhead row: the
 * books' running costs list its base, per-customer and plant lines (from
 * OpsStats.overhead, which add up to it) but no subtotal of the three, so it
 * is said here. Quiet when there was none, or when the report predates the
 * lines (the books then show the overhead as one line, which is this total).
 */
export function overheadRow(report: MonthlyReport): ReportRow {
  const total = 0 - (report.totals.overhead ?? 0);
  return {
    key: 'overhead',
    label: 'Overhead',
    value: formatMoney(total),
    tone: null,
    detail: 'base costs, per customer, and per cabinet and mile of cable',
    hint: 'Running the company: a small base, plus costs that grow with your customers and your live plant. Running the business lists these parts; this is their total.',
    quiet: !report.ops?.overhead || total === 0,
  };
}

/**
 * The support level's part of the per-customer cost (OpsStats.overhead's
 * support line, round 4c/4d; the per-customer line itself is in the money
 * out). Quiet when nothing was spent on it or the report predates it.
 */
export function supportRow(report: MonthlyReport): ReportRow {
  const lines = report.ops?.overhead ?? null;
  return {
    key: 'support',
    label: 'Customer support',
    value: lines ? formatMoney(lines.support) : DASH,
    tone: null,
    detail: lines ? 'included in the per-customer cost' : null,
    hint: 'What the support level you chose cost this month (part of the per-customer running cost)',
    quiet: !lines || !(lines.support > 0),
  };
}

/**
 * Round 4's operating figures (report.ops): outages (with the storms, the
 * spans damaged and the cancellations they caused), outage credits (round
 * 4b), price-step and tier-move cancellations, and the cable company's
 * promos. Each is quiet when nothing happened; a report from before round 4
 * (no ops) reads '–' and is quiet throughout.
 */
export function operationsRows(report: MonthlyReport): ReportRow[] {
  const ops = report.ops ?? null;
  const count = (n: number | undefined) => (ops ? formatNumber(n ?? 0) : DASH);
  const outageDetail = ops
    ? [plural(ops.storms, 'storm'), ...(ops.spansDamaged > 0 ? [`${plural(ops.spansDamaged, 'span')} damaged`] : []), `${formatNumber(ops.outageChurn)} cancelled`].join(', ')
    : null;
  return [
    {
      key: 'outages',
      label: 'Outages',
      value: ops ? `${formatNumber(ops.outageUnitDays)} customer-days` : DASH,
      tone: null,
      detail: outageDetail,
      hint: 'Days customers went without service because a damaged span cut their street off, the storms that hit, the spans damaged and the cancellations the outages caused',
      quiet: !ops || (ops.outageUnitDays === 0 && ops.storms === 0 && ops.outageChurn === 0 && ops.spansDamaged === 0),
    },
    {
      key: 'outageCredits',
      label: 'Outage credits',
      value: ops ? formatMoney(ops.outageCredits ?? 0) : DASH,
      tone: null,
      detail: null,
      hint: 'Bills not charged for the days customers had no service because of outages (customer bills are already net of it)',
      quiet: !ops || !(ops.outageCredits > 0),
    },
    {
      key: 'priceChurn',
      label: 'Cancelled after a price rise',
      value: count(ops?.priceChurn),
      tone: null,
      detail: null,
      hint: 'Customers who cancelled at this close because their price stepped up (a price lock or intro promo ending, or a move off a retired tier)',
      quiet: !ops || ops.priceChurn === 0,
    },
    {
      key: 'tierMoves',
      label: 'Moved off retired tiers',
      value: count(ops?.tierMoves),
      tone: null,
      detail: null,
      hint: 'Customers moved off tiers you no longer offer, to the offered tier nearest in price',
      quiet: !ops || ops.tierMoves === 0,
    },
    {
      key: 'incumbentPromos',
      label: 'Cable company promos',
      value: count(ops?.incumbentPromos),
      tone: null,
      detail: ops && ops.incumbentPromos > 0 ? `${formatNumber(ops.incumbentChurn)} cancelled` : null,
      hint: 'Areas where the cable company ran a promo this month, and your customers it took',
      quiet: !ops || (ops.incumbentPromos === 0 && ops.incumbentChurn === 0),
    },
  ];
}

/**
 * The month's bank figures (report.debt, at month end): the spare cash the
 * bank took from a frozen line, the debt, and the two checks (leverage as
 * years of profit, coverage as profit per $1 of loan payments) against the
 * bank's limits. The month's interest, principal and borrowing are in the
 * full books' money in and out. The debt and the checks are quiet with
 * nothing owed; a report from before round 3 (no `debt`) is quiet and reads
 * '–' throughout.
 */
export function financingRows(report: MonthlyReport): ReportRow[] {
  const debt = report.debt ?? null;
  const owed = debt ? debt.creditBalance + debt.termBalance : 0;
  const leverage = debt?.leverageX100;
  const coverage = debt?.coverageX100;
  const leverageBreach = debt !== null && (leverage === null ? owed > 0 : (leverage ?? 0) > COVENANT_MAX_LEVERAGE * 100);
  const coverageBreach = debt !== null && coverage != null && coverage < COVENANT_MIN_COVERAGE * 100;
  const nothingOwed = !debt || owed === 0;
  return [
    {
      key: 'sweep',
      label: 'Spare cash the bank took',
      value: debt?.sweep === undefined ? DASH : formatMoney(debt.sweep),
      tone: null,
      detail: debt?.frozenCloses ? `${plural(debt.frozenCloses, 'frozen close')} in a row` : null,
      hint: 'While you can’t borrow, the bank takes part of each month’s spare cash to pay down your debt (part of paying back loans)',
      quiet: !debt?.sweep,
    },
    {
      key: 'debt',
      label: 'Debt at month end',
      value: debt ? formatMoney(owed) : DASH,
      tone: null,
      detail: null,
      hint: 'Emergency cash used plus every loan still owed, after this close’s payments',
      quiet: nothingOwed,
    },
    {
      key: 'leverage',
      label: 'Years of profit (leverage)',
      value: !debt || leverage === undefined ? DASH : leverage === null ? 'not measurable' : formatRatio(leverage / 100),
      tone: leverageBreach ? 'breach' : null,
      detail: debt ? `limit ${formatRatio(COVENANT_MAX_LEVERAGE)}` : null,
      hint: `What you owe over the yearly profit the bank counts (bills less running costs, or a share of yearly bills if that is more). The bank allows at most ${formatRatio(COVENANT_MAX_LEVERAGE)}`,
      quiet: nothingOwed,
    },
    {
      key: 'coverage',
      label: 'Earned per $1 of loan payments (coverage)',
      value: !debt || coverage == null ? DASH : formatRatio(coverage / 100),
      tone: coverageBreach ? 'breach' : null,
      detail: debt ? `min ${formatRatio(COVENANT_MIN_COVERAGE)}` : null,
      hint: `The yearly profit the bank counts over the next 12 months of loan payments. The bank asks for at least ${formatRatio(COVENANT_MIN_COVERAGE)}`,
      quiet: nothingOwed,
    },
  ];
}

// ---------------------------------------------------------------------------
// The month-close toast (main.ts)
// ---------------------------------------------------------------------------

/**
 * "Mar 2027 closed: net +$1,200, 412 subs, 1,034 passings" (no subscriber
 * count for a report without stats; ", payment missed" when the close could
 * not pay its debt service; round 4: ", 2 storms" and ", $8,000 swept" when
 * storms hit or the bank swept cash from a frozen line).
 */
export function monthClosedMessage(report: MonthlyReport): string {
  const parts = [`net ${formatSignedMoney(report.net)}`];
  if (report.stats) parts.push(plural(report.stats.subscribers, 'sub'));
  parts.push(plural(report.passings, 'passing'));
  if (report.ops && report.ops.storms > 0) parts.push(plural(report.ops.storms, 'storm'));
  if (report.debt?.sweep) parts.push(`${formatMoney(report.debt.sweep)} swept`);
  if (report.debt?.missedPayment) parts.push('payment missed');
  return `${formatMonth(report.year, report.month)} closed: ${parts.join(', ')}`;
}

/** The month-close toast's tone: good news, unless the close missed its debt payment. */
export function monthClosedTone(report: MonthlyReport): 'ok' | 'warn' {
  return report.debt?.missedPayment ? 'warn' : 'ok';
}

// ---------------------------------------------------------------------------
// The panel's view model
// ---------------------------------------------------------------------------

/** The panel's parts, top to bottom: each one element, shown or hidden in place. */
export type PanelPart = 'empty' | 'cash' | 'money' | 'customers' | 'seeCustomers' | 'building' | 'bank' | 'mtd' | 'books';

export const PANEL_PARTS: readonly PanelPart[] = ['empty', 'cash', 'money', 'customers', 'seeCustomers', 'building', 'bank', 'mtd', 'books'];

/** What stays on screen collapsed (phones and short screens start so): the cash line, the customers line and the bank's word. */
export const COLLAPSED_PARTS: readonly PanelPart[] = ['cash', 'customers', 'bank'];

export interface PanelCash {
  /** "Cash went down $32,539" (briefing.cashHeadline, the summary's cash card). */
  headline: string;
  /** "$332,590 left" / "$2,100 overdrawn". */
  left: string;
  direction: 'up' | 'down' | 'flat';
  /** "Cash went down $32,539 · $332,590 left" */
  text: string;
}

export interface PanelMoney {
  /** briefing.moneyBars for the month: both bars on one scale (the larger total is the full width). */
  in: MoneyBar;
  out: MoneyBar;
  /** Money in includes borrowing: its total is never success green (debt is not earnings). */
  borrowed: boolean;
}

export interface PanelBuilding {
  /** "Building: $80,540 · $2,333 per home passed (target $1,000)" */
  text: string;
  /** The cost per home passed's band, or null without one. */
  band: CppBand | null;
  /** The band in words beside its color: "Within target", "Over target", "Far over target"; null without one. */
  bandText: string | null;
}

export interface PanelBank {
  /** The shared word (ui/health.ts): "Good", "Watch", "Warning", "Higher interest", "No more borrowing", "Loans called". */
  word: string;
  /** "Bank: Watch" (the link's text, like the HUD chip). */
  text: string;
  /** HEALTH_TONE of the level, 'danger' once the loans are called. Never success green. */
  tone: HealthTone;
  /** The plain sentence under the word in the Bank (the link's tooltip). */
  sentence: string;
}

export interface ReportPanelView {
  /** The toggle's text: the closed month ("August 2027"), or "Monthly report" before the first close. */
  title: string;
  /** A month has closed (the toggle works and "See the full books" has a report to open). */
  hasReport: boolean;
  /** "First report arrives Feb 1." before the first close, else null. */
  empty: string | null;
  cash: PanelCash | null;
  money: PanelMoney | null;
  /** "**31 customers** (+4 joined, 1 left) · 18% of homes you pass", or null for a report without customer figures. */
  customers: Words | null;
  /** Only when the month built fiber, else null. */
  building: PanelBuilding | null;
  /** Only with debt (or while the bank's health is not Good), else null. Today's health, as the HUD chip and the Bank show it. */
  bank: PanelBank | null;
  /** "This month so far: $1,100 spent" and its amount. */
  mtd: { amount: string; text: string };
}

/** The customers line: the month-end count, who joined and left (as the Customers dashboard counts them), and the take rate in words. */
export function customersWords(report: MonthlyReport): Words | null {
  const stats = report.stats;
  if (!stats) return null;
  const joined = stats.grossAdds;
  const left = stats.churned + stats.lostService;
  const take = reportKpis(report)?.takeRate ?? null;
  return [
    { text: plural(stats.subscribers, 'customer'), strong: true },
    { text: joined === 0 && left === 0 ? '' : ` (+${formatNumber(joined)} joined, ${formatNumber(left)} left)` },
    { text: take === null ? ' · no homes passed yet' : ` · ${formatPercent(take)} of homes you pass` },
  ];
}

/** "Building: $80,540 · $2,333 per home passed (target $1,000)", with the band in words; null when the month built nothing. */
export function buildingLine(money: PanelMoney, report: MonthlyReport): PanelBuilding | null {
  const spent = money.out.segments.find((s) => s.key === 'building');
  if (!spent) return null;
  const kpis = reportKpis(report);
  if (!kpis) return { text: `Building: ${spent.value}`, band: null, bandText: null };
  const perHome = kpis.cpp === null ? 'no homes passed yet' : `${formatMoney(kpis.cpp)} per home passed`;
  const band = kpis.cpp === null ? null : kpis.cppBand;
  return {
    text: `Building: ${spent.value} · ${perHome} (target ${formatMoney(CPP_TARGET)})`,
    band,
    bandText: band ? `${CPP_BAND_TEXT[band]} target` : null,
  };
}

/** The bank's word as a link, today's health (debt.bankHealth); null with no debt while the health is Good. */
export function bankLine(state: GameState): PanelBank | null {
  const health = bankHealth(state);
  if (health.noDebt && health.level === 'good') return null;
  const word = healthWordOf(health);
  return { word, text: `Bank: ${word}`, tone: health.called ? 'danger' : HEALTH_TONE[health.level], sentence: healthSentence(health) };
}

/** Everything the panel shows for `state`, in words. Pure. */
export function reportPanelView(state: GameState): ReportPanelView {
  const { finance } = state;
  const report = finance.reports.at(-1) ?? null;
  const spent = finance.monthToDate.reduce((sum, e) => sum + (e.amount < 0 ? -e.amount : 0), 0);
  const mtdAmount = formatMoney(spent);
  const mtd = { amount: mtdAmount, text: `This month so far: ${mtdAmount} spent` };
  const bank = bankLine(state);
  if (!report) {
    const next = dateOf(state.day);
    const month = next.month === 12 ? 1 : next.month + 1;
    return { title: 'Monthly report', hasReport: false, empty: `First report arrives ${MONTH_ABBR[month - 1]} 1.`, cash: null, money: null, customers: null, building: null, bank, mtd };
  }
  // The month's money exactly as the month summary partitions it (one report: a span of 1).
  const figures = { money: briefingMoney([report]), span: 1, headline: { cpp: reportKpis(report)?.cpp ?? null, cppTarget: CPP_TARGET } };
  const bars = moneyBars(figures);
  const money: PanelMoney = { in: bars.in, out: bars.out, borrowed: bars.in.segments.some((s) => s.key === 'borrowed') };
  const head = cashHeadline({ change: figures.money.cashChange, end: report.cashEnd });
  return {
    title: formatMonthLong(report.year, report.month),
    hasReport: true,
    empty: null,
    cash: { ...head, text: `${head.headline} · ${head.left}` },
    money,
    customers: customersWords(report),
    building: buildingLine(money, report),
    bank,
    mtd,
  };
}

/** The parts on screen: everything there is when expanded, COLLAPSED_PARTS when not; before the first close, the empty line, the bank and the spending so far either way. */
export function visibleParts(view: ReportPanelView, expanded: boolean): PanelPart[] {
  const has: Record<PanelPart, boolean> = {
    empty: view.empty !== null,
    cash: view.cash !== null,
    money: view.money !== null,
    customers: view.customers !== null,
    // Beside the customers line, so only with it.
    seeCustomers: view.customers !== null,
    building: view.building !== null,
    bank: view.bank !== null,
    mtd: true,
    books: view.hasReport,
  };
  const wanted: readonly PanelPart[] = !view.hasReport ? ['empty', 'bank', 'mtd'] : expanded ? PANEL_PARTS : COLLAPSED_PARTS;
  return PANEL_PARTS.filter((part) => has[part] && wanted.includes(part));
}

/** Every string the panel shows (the toggle's title included), expanded or collapsed: for the tests' no-jargon and collapsed checks. */
export function panelText(view: ReportPanelView, expanded: boolean): string[] {
  const out: string[] = [view.title];
  for (const part of visibleParts(view, expanded)) {
    switch (part) {
      case 'empty':
        out.push(view.empty ?? '');
        break;
      case 'cash':
        out.push(view.cash?.text ?? '');
        break;
      case 'money':
        for (const [name, bar] of [['Money in', view.money!.in], ['Money out', view.money!.out]] as const) {
          out.push(name, bar.value, bar.description);
          if (bar.empty) out.push(bar.empty);
          for (const s of bar.segments) out.push(s.label, s.value);
        }
        break;
      case 'customers':
        out.push(wordsText(view.customers ?? []));
        break;
      case 'seeCustomers':
        out.push(SEE_CUSTOMERS_TEXT);
        break;
      case 'building':
        out.push(view.building!.text, ...(view.building!.bandText ? [view.building!.bandText] : []));
        break;
      case 'bank':
        out.push(view.bank!.text);
        break;
      case 'mtd':
        out.push(view.mtd.text);
        break;
      case 'books':
        out.push(BOOKS_TEXT);
        break;
    }
  }
  return out;
}

const SEE_CUSTOMERS_TEXT = 'See customers';
const BOOKS_TEXT = 'See the full books';

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

/** Phones and short screens start collapsed. */
const COMPACT_QUERY = '(max-width: 880px), (max-height: 500px)';

/** The money-in sources and money-out groups each bar can show, in moneyBars' order. */
const IN_KEYS = ['bills', 'borrowed', 'otherIn'] as const;
const OUT_KEYS = ['running', 'building', 'loans'] as const;

export interface ReportPanelDeps {
  /** "See customers": the Customers dashboard. */
  customers(): void;
  /** "Bank: <word>": the Bank. */
  bank(): void;
  /** "See the full books": the briefing sheet's books view for the latest report, on its own. */
  books(): void;
}

/** One bar's elements, made once: the total, the track's segments and the legend's items, each keyed by source or group. */
interface BarView {
  total: HTMLElement;
  track: HTMLElement;
  segments: Map<string, HTMLElement>;
  items: Map<string, { item: HTMLElement; value: HTMLElement }>;
  empty: HTMLElement;
}

function percent(share: number): string {
  return `${Math.max(0, Math.min(100, share * 100)).toFixed(2)}%`;
}

export class ReportPanel {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly parts = new Map<PanelPart, HTMLElement>();
  private readonly empty: HTMLElement;
  private readonly cashHead: HTMLElement;
  private readonly cashLeft: HTMLElement;
  private readonly bars: { in: BarView; out: BarView };
  private readonly customersText: HTMLElement;
  private readonly buildingText: HTMLElement;
  private readonly buildingBand: HTMLElement;
  private readonly bankLink: HTMLButtonElement;
  private readonly mtd: HTMLElement;
  private customersKey = '';
  private view: ReportPanelView | null = null;
  private key = '';
  private state: GameState | null = null;

  constructor(deps: ReportPanelDeps) {
    this.title = el('span', { class: 'panel-title-text' });
    this.toggle = el(
      'button',
      {
        class: 'btn panel-toggle',
        attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'report-body' },
        on: { click: () => this.setExpanded(!this.expanded) },
      },
      [this.title, el('span', { class: 'panel-toggle-label', text: 'Details' })],
    );

    this.empty = el('p', { class: 'panel-empty' });
    this.cashHead = el('b', { class: 'panel-cash-head' });
    this.cashLeft = el('span', { class: 'panel-cash-left' });
    const cash = el('p', { class: 'panel-cash' }, [this.cashHead, el('span', { class: 'panel-cash-dot visually-hidden', text: ' · ' }), this.cashLeft]);

    const inBar = this.bar('in', 'Money in', IN_KEYS);
    const outBar = this.bar('out', 'Money out', OUT_KEYS);
    this.bars = { in: inBar.view, out: outBar.view };
    const money = el('div', { class: 'panel-money' }, [inBar.root, outBar.root]);

    this.customersText = el('span', { class: 'panel-customers-text' });
    const seeCustomers = el('button', {
      class: 'btn panel-link panel-see-customers',
      text: SEE_CUSTOMERS_TEXT,
      attrs: { type: 'button' },
      on: { click: () => deps.customers() },
    });
    const customers = el('p', { class: 'panel-customers' }, [this.customersText, ' ', seeCustomers]);

    this.buildingText = el('span', { class: 'panel-building-text' });
    this.buildingBand = el('span', { class: 'panel-band' });
    const building = el('p', { class: 'panel-building' }, [this.buildingText, ' ', this.buildingBand]);

    this.bankLink = el('button', {
      class: 'btn panel-link panel-bank',
      attrs: { type: 'button', 'data-testid': 'panel-bank' },
      on: { click: () => deps.bank() },
    });
    const bank = el('p', { class: 'panel-bank-line' }, [this.bankLink]);

    this.mtd = el('span', { class: 'num', attrs: { 'data-testid': 'mtd-spend' } });
    const mtd = el('p', { class: 'mtd' }, ['This month so far: ', this.mtd, ' spent']);

    const books = el('button', {
      class: 'btn panel-books',
      text: BOOKS_TEXT,
      attrs: { type: 'button' },
      on: { click: () => deps.books() },
    });

    const elements: Record<PanelPart, HTMLElement> = {
      empty: this.empty,
      cash,
      money,
      customers,
      seeCustomers,
      building,
      bank,
      mtd,
      books,
    };
    for (const part of PANEL_PARTS) {
      elements[part].dataset.part = part;
      this.parts.set(part, elements[part]);
    }
    const body = el('div', { class: 'panel-body', attrs: { id: 'report-body' } }, [this.empty, cash, money, customers, building, bank, mtd, books]);
    this.root = el('section', { class: 'panel pill-card', attrs: { 'aria-label': 'Monthly report' } }, [el('h2', { class: 'panel-title' }, [this.toggle]), body]);

    let compact = false;
    try {
      compact = window.matchMedia(COMPACT_QUERY).matches;
    } catch {
      // No matchMedia: show everything.
    }
    this.setExpanded(!compact);
  }

  /** One bar: its heading and total, the track (role img, its words as the label), the legend, and the words said instead of an empty bar. */
  private bar(kind: 'in' | 'out', label: string, keys: readonly string[]): { root: HTMLElement; view: BarView } {
    const total = el('span', { class: `num panel-flow-total total-${kind}` });
    const track = el('div', { class: `panel-bar panel-bar-${kind}`, attrs: { role: 'img' } });
    const list = el('ul', { class: 'panel-legend' });
    const segments = new Map<string, HTMLElement>();
    const items = new Map<string, { item: HTMLElement; value: HTMLElement }>();
    for (const key of keys) {
      const seg = el('span', { class: `panel-seg seg-${key}`, attrs: { 'data-key': key, hidden: '' } });
      segments.set(key, seg);
      track.append(seg);
      const value = el('span', { class: 'num' });
      const item = el('li', { attrs: { 'data-key': key, hidden: '' } }, [
        el('span', { class: `panel-swatch seg-${key}`, attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'panel-legend-label' }),
        ' ',
        value,
      ]);
      items.set(key, { item, value });
      list.append(item);
    }
    const empty = el('p', { class: 'panel-flow-empty', attrs: { hidden: '' } });
    const root = el('div', { class: `panel-flow panel-flow-${kind}` }, [
      el('p', { class: 'panel-flow-head' }, [el('span', { class: 'panel-flow-label', text: label }), ' ', total]),
      track,
      list,
      empty,
    ]);
    return { root, view: { total, track, segments, items, empty } };
  }

  get expanded(): boolean {
    return this.toggle.getAttribute('aria-expanded') === 'true';
  }

  setExpanded(open: boolean): void {
    this.toggle.setAttribute('aria-expanded', String(open));
    this.root.classList.toggle('expanded', open);
    setText(this.toggle.querySelector('.panel-toggle-label') as HTMLElement, open ? 'Less' : 'Details');
    this.showParts();
  }

  /** Show exactly the parts visibleParts names for the current view and state of the toggle. */
  private showParts(): void {
    const view = this.view;
    const shown = new Set(view ? visibleParts(view, this.expanded) : []);
    for (const [part, node] of this.parts) node.hidden = !shown.has(part);
  }

  update(state: GameState): void {
    const { finance } = state;
    const key = `${finance.reports.length}|${finance.monthToDate.length}|${state.day}`;
    // A loaded game can match the old one's counts, so the state is part of the key.
    if (key === this.key && state === this.state) return;
    this.key = key;
    this.state = state;
    const view = reportPanelView(state);
    this.view = view;

    setText(this.title, view.title);
    this.toggle.disabled = !view.hasReport;
    setText(this.empty, view.empty ?? '');
    if (view.cash) {
      setText(this.cashHead, view.cash.headline);
      setText(this.cashLeft, view.cash.left);
    }
    if (view.money) {
      this.fillBar(this.bars.in, view.money.in);
      this.fillBar(this.bars.out, view.money.out);
      this.bars.in.total.classList.toggle('total-borrowed', view.money.borrowed);
    }
    this.setCustomers(view.customers);
    if (view.building) {
      setText(this.buildingText, view.building.text);
      setText(this.buildingBand, view.building.bandText ?? '');
      this.buildingBand.hidden = view.building.bandText === null;
      for (const band of ['green', 'amber', 'red'] as const) this.buildingBand.classList.toggle(`cpp-${band}`, view.building.band === band);
    }
    if (view.bank) {
      setText(this.bankLink, view.bank.text);
      if (this.bankLink.title !== view.bank.sentence) this.bankLink.title = view.bank.sentence;
      for (const tone of ['ok', 'warn', 'danger'] as const) this.bankLink.classList.toggle(`tone-${tone}`, view.bank.tone === tone);
    }
    setText(this.mtd, view.mtd.amount);
    this.showParts();
  }

  private fillBar(bar: BarView, model: MoneyBar): void {
    setText(bar.total, model.value);
    if (bar.track.getAttribute('aria-label') !== model.description) bar.track.setAttribute('aria-label', model.description);
    bar.track.hidden = model.empty !== null;
    setText(bar.empty, model.empty ?? '');
    bar.empty.hidden = model.empty === null;
    const first = model.segments[0]?.key;
    const last = model.segments.at(-1)?.key;
    for (const [key, seg] of bar.segments) {
      const segment = model.segments.find((s) => s.key === key);
      seg.hidden = !segment;
      // The bar's rounded ends go on the first and last segments shown (the others stay in the DOM, hidden).
      seg.classList.toggle('is-first', key === first);
      seg.classList.toggle('is-last', key === last);
      if (segment) {
        const width = percent(segment.share);
        if (seg.style.width !== width) seg.style.width = width;
      }
    }
    for (const [key, { item, value }] of bar.items) {
      const segment = model.segments.find((s) => s.key === key);
      item.hidden = !segment;
      if (segment) {
        setText(item.querySelector('.panel-legend-label') as HTMLElement, segment.label);
        setText(value, segment.value);
      }
    }
  }

  /** The customers line's words (the count in bold), rebuilt only when they change. */
  private setCustomers(words: Words | null): void {
    const key = words ? JSON.stringify(words) : '';
    if (key === this.customersKey) return;
    this.customersKey = key;
    this.customersText.replaceChildren(...(words ?? []).filter((w) => w.text).map((w) => (w.strong ? el('b', { text: w.text }) : document.createTextNode(w.text))));
  }
}
