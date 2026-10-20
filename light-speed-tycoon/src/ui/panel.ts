// Report panel: the last closed month (net, revenue, subscribers, the
// scorecard KPIs and, from round 3, financing: interest, principal, money
// borrowed, debt, leverage and coverage) and this month's spending so far. On
// phones and short screens it starts collapsed to three headline figures;
// "Details" opens the rest.
//
// Owner: ui-economy workstream; financing rows: ui-bank workstream.

import { COVENANT_MAX_LEVERAGE, COVENANT_MIN_COVERAGE, CPP_AMBER_MULTIPLIER, CPP_TARGET } from '../sim/balance';
import { MONTH_ABBR, dateOf, formatMonth } from '../sim/calendar';
import { operatingCashFlow, reportKpis } from '../sim/metrics';
import type { CppBand, GameState, MonthlyReport } from '../sim/types';
import { el, setText } from './dom';
import { formatMaybeMoney, formatMoney, formatNumber, formatPercent, formatRatio, formatSignedMoney, plural } from './format';

export type ReportRowKey =
  | 'net'
  | 'revenue'
  | 'subscribers'
  | 'arpu'
  | 'cpga'
  | 'takeRate'
  | 'cpp'
  | 'costPerConnection'
  | 'operatingCashFlow'
  | 'poleRent'
  | 'passings'
  | 'interest'
  | 'principal'
  | 'proceeds'
  | 'debt'
  | 'leverage'
  | 'coverage';

export interface ReportRow {
  key: ReportRowKey;
  label: string;
  /** Display value; '–' when the KPI is undefined (no subscribers, no passings, a report from a v1 or v2 save). */
  value: string;
  /** Coloring: a negative amount, the cost-per-passing band, or a covenant breach. */
  tone: 'negative' | CppBand | 'breach' | null;
  /** Secondary line, e.g. the subscriber movements of the month. */
  detail: string | null;
  /** Longer explanation for a tooltip. */
  hint: string;
}

const DASH = '–';

/** "+30 new, 5 churned, 2 lost service" for a month's subscriber movements. */
export function subscriberMovements(report: MonthlyReport): string | null {
  const stats = report.stats;
  if (!stats) return null;
  const parts = [`+${formatNumber(stats.grossAdds)} new`, `${formatNumber(stats.churned)} churned`];
  if (stats.lostService > 0) parts.push(`${formatNumber(stats.lostService)} lost service`);
  return parts.join(', ');
}

/**
 * Every figure the report panel shows for a closed month, in display order.
 * KPIs come from metrics.reportKpis (null for a report without stats, i.e.
 * one migrated from a schemaVersion 1 save: those read '–').
 */
export function reportRows(report: MonthlyReport): ReportRow[] {
  const kpis = reportKpis(report);
  const stats = report.stats ?? null;
  const flow = operatingCashFlow(report);
  const money = (amount: number | null | undefined) => formatMaybeMoney(amount ?? null);
  return [
    {
      key: 'net',
      label: 'Net',
      value: formatSignedMoney(report.net),
      tone: report.net < 0 ? 'negative' : null,
      detail: null,
      hint: 'Net cash flow: everything in and out this month, building, installs and financing included',
    },
    {
      key: 'revenue',
      label: 'Revenue',
      value: kpis ? formatMoney(kpis.revenue) : DASH,
      tone: null,
      detail: null,
      hint: 'Subscriber billing for the month',
    },
    {
      key: 'subscribers',
      label: 'Subscribers',
      value: stats ? formatNumber(stats.subscribers) : DASH,
      tone: null,
      detail: subscriberMovements(report),
      hint: 'Subscribed homes, businesses and apartments at month end',
    },
    {
      key: 'arpu',
      label: 'ARPU',
      value: kpis?.arpu != null ? `${formatMoney(kpis.arpu)}/mo` : DASH,
      tone: null,
      detail: null,
      hint: 'Average revenue per subscriber: billing over the month\'s average subscribers',
    },
    {
      key: 'cpga',
      label: 'CPGA',
      value: money(kpis?.cpga),
      tone: null,
      detail: null,
      hint: 'Cost per gross add: marketing spend per new subscriber',
    },
    {
      key: 'takeRate',
      label: 'Take rate',
      value: kpis?.takeRate != null ? formatPercent(kpis.takeRate) : DASH,
      tone: null,
      detail: null,
      hint: 'Subscribers as a share of homes passed',
    },
    {
      key: 'cpp',
      label: 'Cost per passing',
      value: money(kpis?.cpp),
      tone: kpis?.cppBand ?? null,
      detail: kpis?.cpp != null ? `target ${formatMoney(CPP_TARGET)}` : null,
      hint: `Lifetime outside-plant spend (cable, cabinets, splitters) per home passed. Target ${formatMoney(CPP_TARGET)}: green at or under it, amber up to ${formatMoney(CPP_TARGET * CPP_AMBER_MULTIPLIER)}, red above`,
    },
    {
      key: 'costPerConnection',
      label: 'Cost per connection',
      value: money(kpis?.costPerConnection),
      tone: null,
      detail: null,
      hint: 'Lifetime install spend (drops, ONTs, building routers) per connection',
    },
    {
      key: 'operatingCashFlow',
      label: 'Operating cash flow',
      value: formatSignedMoney(flow),
      tone: flow < 0 ? 'negative' : null,
      detail: null,
      hint: 'Revenue minus running costs, before building, installs and financing',
    },
    {
      key: 'poleRent',
      label: 'Pole rent',
      value: formatMoney(-(report.totals.poleRent ?? 0)),
      tone: null,
      detail: null,
      hint: 'Rent for the utility poles your aerial cable hangs on',
    },
    {
      key: 'passings',
      label: 'Passings',
      value: formatNumber(report.passings),
      tone: null,
      detail: null,
      hint: 'Homes and businesses your lit network passes',
    },
    ...financingRows(report),
  ];
}

/**
 * The month's financing: interest, principal repaid and money borrowed (from
 * totals), and debt, leverage and coverage at month end (report.debt). A
 * report from before round 3 (no `debt`) reads '–' throughout.
 */
export function financingRows(report: MonthlyReport): ReportRow[] {
  const debt = report.debt ?? null;
  const spent = (amount: number | undefined) => (debt ? formatMoney(0 - (amount ?? 0)) : DASH);
  const leverage = debt?.leverageX100;
  const coverage = debt?.coverageX100;
  const leverageBreach = debt !== null && (leverage === null ? debt.creditBalance + debt.termBalance > 0 : (leverage ?? 0) > COVENANT_MAX_LEVERAGE * 100);
  const coverageBreach = debt !== null && coverage != null && coverage < COVENANT_MIN_COVERAGE * 100;
  return [
    {
      key: 'interest',
      label: 'Interest',
      value: spent(report.totals.interest),
      tone: null,
      detail: null,
      hint: 'Interest on the credit line and term loans, accrued interest on prepayments, and any late fee',
    },
    {
      key: 'principal',
      label: 'Principal repaid',
      value: spent(report.totals.principal),
      tone: null,
      detail: null,
      hint: 'Credit-line repayments, scheduled term-loan principal and prepayments',
    },
    {
      key: 'proceeds',
      label: 'Borrowed',
      value: debt ? formatMoney(report.totals.loanProceeds ?? 0) : DASH,
      tone: null,
      detail: null,
      hint: 'Credit-line draws and new term loans this month',
    },
    {
      key: 'debt',
      label: 'Debt at month end',
      value: debt ? formatMoney(debt.creditBalance + debt.termBalance) : DASH,
      tone: null,
      detail: null,
      hint: 'Credit-line balance plus every term loan still owed, after this close’s payments',
    },
    {
      key: 'leverage',
      label: 'Leverage',
      value: !debt || leverage === undefined ? DASH : leverage === null ? 'not measurable' : formatRatio(leverage / 100),
      tone: leverageBreach ? 'breach' : null,
      detail: debt ? `limit ${formatRatio(COVENANT_MAX_LEVERAGE)}` : null,
      hint: `Debt over the cash flow the bank counts (yearly operating cash flow, or a share of recurring revenue if that is more). The covenant allows at most ${formatRatio(COVENANT_MAX_LEVERAGE)}`,
    },
    {
      key: 'coverage',
      label: 'Coverage',
      value: !debt || coverage == null ? DASH : formatRatio(coverage / 100),
      tone: coverageBreach ? 'breach' : null,
      detail: debt ? `min ${formatRatio(COVENANT_MIN_COVERAGE)}` : null,
      hint: `The cash flow the bank counts over the next 12 months of debt service. The covenant asks for at least ${formatRatio(COVENANT_MIN_COVERAGE)}`,
    },
  ];
}

/**
 * "Mar 2027 closed: net +$1,200, 412 subs, 1,034 passings" (no subscriber
 * count for a report without stats; ", payment missed" when the close could
 * not pay its debt service).
 */
export function monthClosedMessage(report: MonthlyReport): string {
  const parts = [`net ${formatSignedMoney(report.net)}`];
  if (report.stats) parts.push(plural(report.stats.subscribers, 'sub'));
  parts.push(plural(report.passings, 'passing'));
  if (report.debt?.missedPayment) parts.push('payment missed');
  return `${formatMonth(report.year, report.month)} closed: ${parts.join(', ')}`;
}

/** The month-close toast's tone: good news, unless the close missed its debt payment. */
export function monthClosedTone(report: MonthlyReport): 'ok' | 'warn' {
  return report.debt?.missedPayment ? 'warn' : 'ok';
}

/** A report used only to lay out the rows (labels and hints). */
const SAMPLE: MonthlyReport = { year: 2027, month: 1, totals: {}, net: 0, cashEnd: 0, passings: 0 };

/** Shown in the collapsed panel, in this order. */
const HEADLINE: readonly ReportRowKey[] = ['net', 'subscribers', 'takeRate'];

/** Phones and short screens start with the details collapsed. */
const COMPACT_QUERY = '(max-width: 880px), (max-height: 500px)';

interface RowView {
  value: HTMLElement;
  /** Where the row's secondary line goes (the subscriber movements), if anywhere. */
  detail: HTMLElement | null;
  /** Small print shown right after the value (the cost-per-passing target). */
  inline: HTMLElement | null;
}

/** Rows whose secondary line sits right after the value rather than on a row of its own. */
const INLINE_DETAIL: readonly ReportRowKey[] = ['cpp', 'leverage', 'coverage'];

export class ReportPanel {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly headline: HTMLElement;
  private readonly details: HTMLElement;
  private readonly rows = new Map<ReportRowKey, RowView>();
  private readonly mtdLabel: HTMLElement;
  private readonly mtd: HTMLElement;
  private readonly empty: HTMLElement;
  private key = '';
  private state: GameState | null = null;

  constructor() {
    this.title = el('span', { class: 'panel-title-text' });
    this.toggle = el(
      'button',
      {
        class: 'btn panel-toggle',
        attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': 'report-details' },
        on: { click: () => this.setExpanded(this.toggle.getAttribute('aria-expanded') !== 'true') },
      },
      [this.title, el('span', { class: 'panel-toggle-label', text: 'Details' })],
    );
    this.headline = el('dl', { class: 'stats' });
    this.details = el('dl', { class: 'report-details', attrs: { id: 'report-details' } });
    // Build one view per row; the sample report only provides labels and hints.
    for (const row of reportRows(SAMPLE)) {
      const headline = HEADLINE.includes(row.key);
      const kind = headline ? 'stat' : 'row';
      const value = el('span', { class: 'num' });
      const inline = INLINE_DETAIL.includes(row.key) ? el('small', { class: 'row-sub', attrs: { hidden: '' } }) : null;
      this.rows.set(row.key, { value, detail: null, inline });
      (headline ? this.headline : this.details).append(
        el('div', { class: `${kind} ${kind}-${row.key}`, attrs: { title: row.hint } }, [el('dt', { text: row.label }), el('dd', {}, [value, inline])]),
      );
    }
    // The subscriber headline's movements get a row of their own in the details.
    const moves = el('span', { class: 'num' });
    const movesRow = el('div', { class: 'row row-movements', attrs: { title: 'New subscribers, cancellations and disconnections this month' } }, [
      el('dt', { text: 'Movement' }),
      el('dd', {}, [moves]),
    ]);
    this.details.insertBefore(movesRow, this.details.firstChild);
    (this.rows.get('subscribers') as RowView).detail = moves;

    this.mtdLabel = el('span');
    this.mtd = el('span', { class: 'num', attrs: { 'data-testid': 'mtd-spend' } });
    this.empty = el('p', { class: 'panel-empty' });
    this.root = el('section', { class: 'panel pill-card', attrs: { 'aria-label': 'Monthly report' } }, [
      el('h2', { class: 'panel-title' }, [this.toggle]),
      this.headline,
      this.details,
      this.empty,
      el('p', { class: 'mtd' }, [this.mtdLabel, ' ', this.mtd]),
    ]);
    let compact = false;
    try {
      compact = window.matchMedia(COMPACT_QUERY).matches;
    } catch {
      // No matchMedia: show everything.
    }
    this.setExpanded(!compact);
  }

  get expanded(): boolean {
    return this.toggle.getAttribute('aria-expanded') === 'true';
  }

  setExpanded(open: boolean): void {
    this.toggle.setAttribute('aria-expanded', String(open));
    this.root.classList.toggle('expanded', open);
    setText(this.toggle.querySelector('.panel-toggle-label') as HTMLElement, open ? 'Less' : 'Details');
  }

  update(state: GameState): void {
    const { finance } = state;
    const key = `${finance.reports.length}|${finance.monthToDate.length}|${state.day}`;
    // A loaded game can match the old one's counts, so the state is part of the key.
    if (key === this.key && state === this.state) return;
    this.key = key;
    this.state = state;

    const last = finance.reports[finance.reports.length - 1];
    this.headline.hidden = !last;
    this.details.hidden = !last;
    this.toggle.disabled = !last;
    this.empty.hidden = !!last;
    if (last) {
      setText(this.title, `${formatMonth(last.year, last.month)} report`);
      for (const row of reportRows(last)) {
        const view = this.rows.get(row.key);
        if (!view) continue;
        setText(view.value, row.value);
        view.value.classList.toggle('negative', row.tone === 'negative');
        view.value.classList.toggle('breach', row.tone === 'breach');
        for (const band of ['green', 'amber', 'red'] as const) view.value.classList.toggle(`cpp-${band}`, row.tone === band);
        if (view.detail) setText(view.detail, row.detail ?? '–');
        if (view.inline) {
          setText(view.inline, row.detail ?? '');
          view.inline.hidden = !row.detail;
        }
      }
    } else {
      setText(this.title, 'Monthly report');
      const next = dateOf(state.day);
      const month = next.month === 12 ? 1 : next.month + 1;
      setText(this.empty, `First report arrives ${MONTH_ABBR[month - 1]} 1.`);
    }

    const spent = finance.monthToDate.reduce((sum, e) => sum + (e.amount < 0 ? -e.amount : 0), 0);
    const now = dateOf(state.day);
    setText(this.mtdLabel, `Spent in ${MONTH_ABBR[now.month - 1]} so far`);
    setText(this.mtd, formatMoney(spent));
  }
}
