// The Customers dashboard (round 4c/4d, spec I.5): how many customers and
// how they grow, how happy they are and why, why lit homes have not
// switched (each reason paired with the lever that addresses it), each
// cabinet area with a "Run a campaign" button, and the levers themselves
// (marketing budget with its forecast, support level, referral credits),
// each with a one-line "what this does" and its live forecast. Plain words
// like the month summary and the Bank; Toy Town style; phone 390x844 with
// no horizontal scroll.
//
// Data: customers.ts (whyNotSwitched, happinessReport, customerAreas,
// quoteMarketing, quoteCampaign, quoteSupport, quoteReferrals) and the
// monthly reports (growth over the last 24 months, joined vs left). It
// changes the game only through commands (setMarketing, runCampaign,
// setSupport, setReferrals) via the session, and "Show me" / "Open Pricing"
// through deps.showMe (main.ts glides the map to the area, or opens the
// panel) after closing this sheet, because the modal covers the map. Every
// money figure is the sim's (a quote's or the ledger's); the UI only rounds
// and words them.
//
// The pure view-model functions below are what customersPanel.test.ts
// checks; the CustomersPanel class at the end builds the sheet once and
// update() rewrites its figures in place (inputs are never rebuilt, so focus
// and typed values survive). Quotes run only while the sheet is open, and at
// most once a QUOTE_REFRESH_MS while the clock runs (each is a forecast of
// the next CUSTOMER_QUOTE_MONTHS); a command or an edit refreshes at once.
//
// Owner: ui-customers workstream (round 4c/4d; the contract wrote the stub).

import { CAMPAIGN_DAYS, CUSTOMER_QUOTE_MONTHS, MARKETING_MAX_PER_MONTH, REFERRAL_CREDIT, SUPPORT_LEVELS } from '../sim/balance';
import { formatDate, formatMonth } from '../sim/calendar';
import {
  AREA_TREND_MONTHS,
  customerAreas,
  happinessReport,
  MARKETING_STEP,
  quoteCampaign,
  quoteMarketing,
  quoteReferrals,
  quoteSupport,
  SUPPORT_LEVEL_IDS,
  whyNotSwitched,
} from '../sim/customers';
import { roughMoney, subscriberUnits } from '../sim/sales';
import { cornerName } from '../sim/streets';
import type {
  AdviceAction,
  CabinetId,
  CampaignQuote,
  CustomerArea,
  GameState,
  HappinessBucket,
  HappinessReason,
  HappinessReport,
  MarketingQuote,
  MonthlyReport,
  ReferralQuote,
  SupportLevel,
  SupportQuote,
  SwitchReasons,
} from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el, setText } from './dom';
import { formatMoney, formatNumber, formatPercent, plural } from './format';
import type { Toasts } from './overlays';
import { parseNumberField } from './pricingPanel';
import type { GameSession } from './session';

export interface CustomersPanelDeps {
  /** "Show me" on an area or a happiness reason, or "Open Pricing": main.ts glides the map there and rings it, or opens the panel (as the briefing's Show me). The sheet closes first. */
  showMe(action: AdviceAction): void;
}

/** What the panel should open at: an area (scrolls to it, e.g. from an advisor card) or a lever section. */
export interface CustomersFocus {
  cabinet?: CabinetId;
  section?: 'growth' | 'happiness' | 'reasons' | 'areas' | 'levers' | 'marketing' | 'referrals';
}

// ---------------------------------------------------------------------------
// Words shared by the view model
// ---------------------------------------------------------------------------

/** Months the growth chart shows (spec I.5: the last 24 months). A UI choice, not balance. */
export const GROWTH_MONTHS = 24;

/** Quotes refresh at most this often while the clock runs (a command or an edit refreshes at once). A UI pace, not balance. */
export const QUOTE_REFRESH_MS = 1_000;

/** "a year" for the quotes' horizon (CUSTOMER_QUOTE_MONTHS), else "12 months". */
export function horizonWords(months: number = CUSTOMER_QUOTE_MONTHS): string {
  return months === 12 ? 'a year' : plural(months, 'month');
}

/** A forecast count in words: "about 12", "less than one", "none" (n not rounded). */
export function aboutCount(n: number): string {
  if (!(n > 0.05)) return 'none';
  if (n < 0.5) return 'less than one';
  return `about ${formatNumber(n)}`;
}

/** "about 12 new customers" / "less than one new customer" / "no new customers". */
function aboutCustomers(n: number, adjective: string): string {
  const words = aboutCount(n);
  if (words === 'none') return `no ${adjective} customers`;
  const one = words === 'less than one' || Math.round(n) === 1;
  return `${words} ${adjective} ${one ? 'customer' : 'customers'}`;
}

/** Words a test can hold the dashboard to: none of the finance or marketing jargon on its face (spec G/H/I: plain words). */
export const CUSTOMERS_JARGON = /leverage|covenant|DSCR|\bARR\b|\bOCF\b|\bbps\b|×|churn|take rate|\bMRR\b|ARPU|CPGA|awareness|passings|cohort|conversion|funnel/i;

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/** The dashboard's header figures (customersHeader). */
export interface CustomersHeader {
  /** Subscribed units today. */
  customers: number;
  /** "372 customers". */
  title: string;
  /** The last closed month's units connected and units lost (churned + lost service); null before the first close or on a report without figures. */
  joined: number | null;
  left: number | null;
  /** "+9 joined, -3 left in July 2029", or "No month has closed yet." */
  change: string;
  /** Subscribed units on lit streets over the units they pass (whyNotSwitched), or null with nothing passed. */
  share: number | null;
  /** "38% of the homes you can sell to are customers." */
  shareLine: string;
}

/** Long month name of a report: "July 2029". */
function reportMonth(report: Pick<MonthlyReport, 'year' | 'month'>): string {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[report.month - 1] ?? '?'} ${report.year}`;
}

/** The header: customers today, the last closed month's joined and left, and the share of the homes you can sell to (spec I.5). Pure. */
export function customersHeader(state: GameState, reasons: SwitchReasons): CustomersHeader {
  const customers = subscriberUnits(state);
  const last = state.finance.reports.at(-1);
  const stats = last?.stats;
  const joined = stats ? stats.grossAdds : null;
  const left = stats ? stats.churned + stats.lostService : null;
  const { passings, subscribed } = reasons.overall;
  const share = passings > 0 ? subscribed / passings : null;
  return {
    customers,
    title: plural(customers, 'customer'),
    joined,
    left,
    change: last && stats ? `+${formatNumber(stats.grossAdds)} joined, -${formatNumber(stats.churned + stats.lostService)} left in ${reportMonth(last)}` : 'No month has closed yet.',
    share,
    shareLine: share === null ? "You can't sell to any homes yet: light a street first." : `${formatPercent(share)} of the homes you can sell to are customers.`,
  };
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

/** One closed month on the growth chart. */
export interface GrowthPoint {
  year: number;
  month: number;
  /** "Jul 2029" */
  label: string;
  /** Subscribed units at month end. */
  customers: number;
  /** Units connected during the month. */
  joined: number;
  /** Units that cancelled or lost service at the close. */
  left: number;
}

/** The last `months` closed months with figures (reports with stats), oldest first. Pure. */
export function growthSeries(reports: readonly MonthlyReport[], months: number = GROWTH_MONTHS): GrowthPoint[] {
  const points: GrowthPoint[] = [];
  for (const report of reports) {
    const s = report.stats;
    if (!s) continue;
    points.push({ year: report.year, month: report.month, label: formatMonth(report.year, report.month), customers: s.subscribers, joined: s.grossAdds, left: s.churned + s.lostService });
  }
  return points.slice(Math.max(0, points.length - months));
}

/** The growth chart's text summary (its accessible name and the line under it). Pure. */
export function growthSummary(series: readonly GrowthPoint[]): string {
  const first = series[0];
  const last = series.at(-1);
  if (!first || !last) return 'The chart starts once your first month closes.';
  let joined = 0;
  let left = 0;
  for (const p of series) {
    joined += p.joined;
    left += p.left;
  }
  const span = series.length === 1 ? last.label : `${first.label} to ${last.label}`;
  const moved = series.length === 1 ? `${plural(last.customers, 'customer')} at the end of ${last.label}` : `from ${formatNumber(first.customers)} to ${plural(last.customers, 'customer')}`;
  return `${span}: ${moved}. ${formatNumber(joined)} joined and ${formatNumber(left)} left.`;
}

/** A round number at least `n` for a chart's top (1, 2 or 5 times a power of ten; at least `floor`). */
export function niceCeiling(n: number, floor = 10): number {
  const target = Math.max(floor, n);
  let step = 1;
  while (step * 10 <= target) step *= 10;
  for (const m of [1, 2, 5, 10]) if (m * step >= target) return m * step;
  return 10 * step;
}

/** One month's bars on the joined/left chart, in viewBox units. */
export interface FlowBar {
  label: string;
  x: number;
  width: number;
  joinedY: number;
  joinedHeight: number;
  leftY: number;
  leftHeight: number;
}

/** The growth charts' shapes (growthGeometry), in a viewBox COLUMN x months wide and CHART_HEIGHT tall. */
export interface GrowthGeometry {
  width: number;
  height: number;
  /** The customers chart: its top value, the line and the filled area under it (SVG path data). */
  customersMax: number;
  line: string;
  area: string;
  /** The joined/left chart: the zero line's y, the bars, and the biggest month each way. */
  baseline: number;
  joinedMax: number;
  leftMax: number;
  bars: FlowBar[];
}

/** Width of one month in the charts' viewBox. */
export const CHART_COLUMN = 10;
/** Height of the charts' viewBox. */
export const CHART_HEIGHT = 100;
/** Room left above the customers line so its top never touches the edge. */
const CHART_HEADROOM = 4;

/**
 * The growth charts as SVG shapes (no text: labels live in HTML so they stay
 * readable when the chart stretches). Customers: one point per month at the
 * middle of its column, scaled to niceCeiling(max). Joined vs left: bars up
 * and down from one baseline on one scale (customers a month), the baseline
 * placed so the biggest month each way fits. Pure.
 */
export function growthGeometry(series: readonly GrowthPoint[]): GrowthGeometry {
  const width = Math.max(1, series.length) * CHART_COLUMN;
  const height = CHART_HEIGHT;
  let top = 0;
  let joinedMax = 0;
  let leftMax = 0;
  for (const p of series) {
    top = Math.max(top, p.customers);
    joinedMax = Math.max(joinedMax, p.joined);
    leftMax = Math.max(leftMax, p.left);
  }
  const customersMax = niceCeiling(top);
  const round = (v: number) => Math.round(v * 100) / 100;
  const yOf = (n: number) => round(height - (n / customersMax) * (height - CHART_HEADROOM));
  const points = series.map((p, i) => `${round(i * CHART_COLUMN + CHART_COLUMN / 2)},${yOf(p.customers)}`);
  const line = points.length > 0 ? `M${points.join('L')}` : '';
  const area =
    points.length > 0 ? `M${round(CHART_COLUMN / 2)},${height}L${points.join('L')}L${round((series.length - 1) * CHART_COLUMN + CHART_COLUMN / 2)},${height}Z` : '';
  const total = joinedMax + leftMax;
  const scale = total > 0 ? height / total : 0;
  const baseline = total > 0 ? round(joinedMax * scale) : height / 2;
  const bars = series.map((p, i) => ({
    label: p.label,
    x: round(i * CHART_COLUMN + CHART_COLUMN * 0.2),
    width: round(CHART_COLUMN * 0.6),
    joinedY: round(baseline - p.joined * scale),
    joinedHeight: round(p.joined * scale),
    leftY: baseline,
    leftHeight: round(p.left * scale),
  }));
  return { width, height, customersMax, line, area, baseline, joinedMax, leftMax, bars };
}

// ---------------------------------------------------------------------------
// Happiness
// ---------------------------------------------------------------------------

/** What each happiness reason is called, by the direction it pushes (customers.ts HappinessReason). */
export const HAPPINESS_WORDS: Readonly<Record<HappinessReason, { happy: string; unhappy: string }>> = {
  support: { happy: 'Great support', unhappy: 'Basic support is slow to help' },
  outages: { happy: 'No outages', unhappy: 'Outages in the last few months' },
  priceVsCable: { happy: 'Cheaper than cable here', unhappy: 'Cable is cheaper here right now' },
  priceVsMarket: { happy: 'A fair price', unhappy: 'Paying more than the usual price' },
  goodDeal: { happy: 'A good deal on price', unhappy: 'Paying more than the usual price' },
  priceStep: { happy: 'Steady prices', unhappy: 'Their price went up recently' },
  installWait: { happy: 'Connected quickly', unhappy: 'Waited to be connected' },
};

/** One top happiness reason as the dashboard words it. */
export interface HappinessLine {
  reason: HappinessReason;
  bucket: 'happy' | 'unhappy';
  units: number;
  cabinet: CabinetId | null;
  /** The cabinet's corner, or null. */
  place: string | null;
  /** "Outages in the last few months (Elm St & 3rd Ave)" */
  text: string;
  /** "12 customers" */
  count: string;
}

/** The happiness section (happinessView). */
export interface HappinessView {
  happy: number;
  okay: number;
  unhappy: number;
  total: number;
  /** "Happy 280 · Okay 10 · Unhappy 4" for the bar's accessible name. */
  summary: string;
  reasons: HappinessLine[];
}

/** A cabinet's corner name, or null when it is gone. */
function placeOf(state: GameState, cabinet: CabinetId | null): string | null {
  if (cabinet === null) return null;
  const found = state.network.cabinets.find((c) => c.id === cabinet);
  return found ? cornerName(state.city, found.node) : null;
}

/** Happy / Okay / Unhappy counts and the top reasons in plain words, each with its area when one holds most of it. Pure. */
export function happinessView(state: GameState, report: HappinessReport): HappinessView {
  const total = report.happy + report.okay + report.unhappy;
  return {
    happy: report.happy,
    okay: report.okay,
    unhappy: report.unhappy,
    total,
    summary: total === 0 ? 'No customers yet.' : `Happy ${formatNumber(report.happy)}, okay ${formatNumber(report.okay)}, unhappy ${formatNumber(report.unhappy)}.`,
    reasons: report.reasons.map((r) => {
      const place = placeOf(state, r.cabinet);
      const words = HAPPINESS_WORDS[r.reason][r.bucket];
      return {
        reason: r.reason,
        bucket: r.bucket,
        units: r.units,
        cabinet: place === null ? null : r.cabinet,
        place,
        text: place === null ? words : `${words} (${place})`,
        count: plural(r.units, 'customer'),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Why homes haven't switched
// ---------------------------------------------------------------------------

export type SwitchReasonKey = 'unaware' | 'deciding' | 'notWorth' | 'tooExpensive' | 'waiting' | 'notLit';

/** What a reason row's lever button does. */
export type LeverLink =
  | { kind: 'section'; section: 'marketing' | 'areas' | 'referrals'; label: string }
  | { kind: 'pricing'; label: string }
  | { kind: 'showMe'; cabinet: CabinetId; label: string; place: string };

/** One "Why homes haven't switched" row: a reason, its count and bar, and the lever that addresses it. */
export interface SwitchRow {
  key: SwitchReasonKey;
  /** "Don't know you yet" */
  label: string;
  count: number;
  /** "420 homes" */
  countText: string;
  /** Share of every home counted here (the bar's length), 0..1. */
  share: number;
  /** "Marketing or a neighborhood campaign" */
  lever: string;
  links: LeverLink[];
}

/** The reasons' words (spec I.5's pairs). */
export const SWITCH_WORDS: Readonly<Record<SwitchReasonKey, { label: string; lever: string }>> = {
  unaware: { label: "Don't know you yet", lever: 'Marketing or a neighborhood campaign' },
  deciding: { label: "Know you, haven't switched yet", lever: 'Time and word of mouth; referral credits, a campaign or lower prices speed it up' },
  notWorth: { label: 'Not worth switching at your price', lever: 'Lower prices or an intro promo' },
  tooExpensive: { label: 'Too expensive for them', lever: 'A cheaper plan' },
  waiting: { label: 'Waiting for install', lever: 'Add a splitter where a cabinet is full, or keep cash for installs' },
  notLit: { label: 'Not lit yet', lever: 'Finish building, or add a cabinet that reaches them' },
};

/**
 * Why homes you can sell to haven't signed up (whyNotSwitched), one row per
 * reason with its count and the lever that addresses it; 'Not lit yet' only
 * when non-zero. Bars are shares of every home counted. Waiting links to the
 * area with the most homes waiting. Pure.
 */
export function switchRows(state: GameState, reasons: SwitchReasons): SwitchRow[] {
  const o = reasons.overall;
  const keys: SwitchReasonKey[] = ['unaware', 'deciding', 'notWorth', 'tooExpensive', 'waiting'];
  if (o.notLit > 0) keys.push('notLit');
  const total = o.unsigned + o.notLit;
  let waitingArea: { cabinet: CabinetId; waiting: number } | null = null;
  for (const area of reasons.areas) if (area.waiting > 0 && (!waitingArea || area.waiting > waitingArea.waiting)) waitingArea = { cabinet: area.cabinet, waiting: area.waiting };
  return keys.map((key) => {
    const count = o[key];
    const links: LeverLink[] = [];
    if (key === 'unaware') links.push({ kind: 'section', section: 'marketing', label: 'Marketing' }, { kind: 'section', section: 'areas', label: 'Campaigns' });
    if (key === 'deciding') links.push({ kind: 'section', section: 'referrals', label: 'Referral credits' }, { kind: 'section', section: 'areas', label: 'Campaigns' });
    if (key === 'notWorth' || key === 'tooExpensive') links.push({ kind: 'pricing', label: 'Open Pricing' });
    if (key === 'waiting' && waitingArea) {
      const place = placeOf(state, waitingArea.cabinet);
      if (place !== null) links.push({ kind: 'showMe', cabinet: waitingArea.cabinet, label: 'Show me', place });
    }
    return {
      key,
      label: SWITCH_WORDS[key].label,
      count,
      countText: plural(count, 'home'),
      share: total > 0 ? count / total : 0,
      lever: SWITCH_WORDS[key].lever,
      links,
    };
  });
}

/** The line over the reasons: "502 homes you can sell to haven't signed up yet." Pure. */
export function switchIntro(reasons: SwitchReasons): string {
  const o = reasons.overall;
  if (o.passings === 0 && o.notLit === 0) return 'No homes on your fiber yet: build a street and light it.';
  if (o.unsigned === 0) return o.notLit > 0 ? 'Every home you can sell to is a customer. More are on the way as streets light up.' : 'Every home you can sell to is a customer.';
  return `${plural(o.unsigned, 'home')} you can sell to ${o.unsigned === 1 ? "hasn't" : "haven't"} signed up yet.`;
}

// ---------------------------------------------------------------------------
// Areas and campaigns
// ---------------------------------------------------------------------------

/** "about 2 months": how long a campaign runs at full strength (CAMPAIGN_DAYS). */
export function campaignLengthWords(): string {
  const months = Math.max(1, Math.round((CAMPAIGN_DAYS * 12) / 365));
  return `about ${plural(months, 'month')}`;
}

/** The "Run a campaign" button of an area, with its quote in words (campaignButton). */
export interface CampaignButton {
  label: string;
  disabled: boolean;
  /** Why it is disabled (the quote's first reason), or null. */
  reason: string | null;
  /** "Costs $1,440: about 18 more customers in a year, about $80 each. Pays for itself within a year." ('' without figures) */
  line: string;
  /** "A campaign runs here until Mar 3, 2029." / "Next campaign from Jul 1, 2029." or null. */
  status: string | null;
}

/** The campaign button and lines for an area from its quote (null: not quoted yet). Pure. */
export function campaignButton(quote: CampaignQuote | null, area: Pick<CustomerArea, 'campaign'>, day: number): CampaignButton {
  const running = area.campaign !== null && day < area.campaign.endDay;
  let status: string | null = null;
  if (running) status = `A campaign runs here until ${formatDate(area.campaign!.endDay)}.`;
  else if (quote?.availableDay != null) status = `Next campaign from ${formatDate(quote.availableDay)}.`;
  if (!quote) return { label: 'Run a campaign', disabled: true, reason: null, line: '', status };
  let line = '';
  if (!running && quote.unsignedUnits > 0) {
    const verdict = quote.pays ? `Pays for itself within ${horizonWords()}.` : `Won't pay for itself within ${horizonWords()}.`;
    line =
      quote.extraSignups < 0.5 || quote.costPerCustomer === null
        ? `Costs ${formatMoney(quote.cost)}: hardly any more customers here in ${horizonWords()}. ${verdict}`
        : `Costs ${formatMoney(quote.cost)}: ${aboutCustomers(quote.extraSignups, 'more')} in ${horizonWords()}, about ${formatMoney(quote.costPerCustomer)} each. ${verdict}`;
  }
  const reason = quote.ok ? null : (quote.reasons[0] ?? 'Not possible here now');
  return { label: 'Run a campaign', disabled: !quote.ok, reason, line, status };
}

/** One row of the Areas list (areaRow). */
export interface AreaRow {
  cabinet: CabinetId;
  /** The cabinet's corner. */
  place: string;
  passings: number;
  subscribed: number;
  takeRate: number | null;
  monthsLit: number | null;
  /** subscribed - subscribedBefore, or null when unknown. */
  trend: number | null;
  /** "447 homes · 21% are customers · lit 11 months" */
  facts: string;
  /** "+37 in 3 months", "No change in 3 months", "New" */
  trendText: string;
  /** 'up' | 'down' | 'flat' | 'new' (the trend's tone; the words always say it). */
  trendTone: 'up' | 'down' | 'flat' | 'new';
  campaign: CampaignButton;
}

/** "lit 11 months" / "lit this month". */
function litWords(months: number | null): string {
  if (months === null) return 'not lit yet';
  return months < 1 ? 'lit this month' : `lit ${plural(months, 'month')}`;
}

/** An area row: its corner, homes, share signed, months lit, trend, and its campaign button. Pure. */
export function areaRow(state: GameState, area: CustomerArea, quote: CampaignQuote | null): AreaRow {
  const place = cornerName(state.city, area.node);
  const trend = area.subscribedBefore === null ? null : area.subscribed - area.subscribedBefore;
  const span = plural(AREA_TREND_MONTHS, 'month');
  const trendText = trend === null ? 'New' : trend === 0 ? `No change in ${span}` : `${trend > 0 ? '+' : '-'}${formatNumber(Math.abs(trend))} in ${span}`;
  const share = area.takeRate === null ? 'nobody to sell to yet' : `${formatPercent(area.takeRate)} are customers`;
  return {
    cabinet: area.cabinet,
    place,
    passings: area.passings,
    subscribed: area.subscribed,
    takeRate: area.takeRate,
    monthsLit: area.monthsLit,
    trend,
    facts: `${plural(area.passings, 'home')} · ${share} · ${litWords(area.monthsLit)}`,
    trendText,
    trendTone: trend === null ? 'new' : trend > 0 ? 'up' : trend < 0 ? 'down' : 'flat',
    campaign: campaignButton(quote, area, state.day),
  };
}

// ---------------------------------------------------------------------------
// Levers
// ---------------------------------------------------------------------------

/** "What this does" for each lever. */
export const LEVER_WHAT: Readonly<Record<'marketing' | 'campaign' | 'support' | 'referrals', string>> = {
  marketing: 'Ads and mailers, so more homes on your lit streets know you. Each extra dollar helps a little less.',
  campaign: `Door-to-door sales in one area for ${campaignLengthWords()}, then it fades. Best right after an area is lit.`,
  support: 'How fast you help customers with problems. Better support keeps them happy: fewer cancel and more tell their neighbors.',
  referrals: `A customer who brings a neighbor gets ${formatMoney(REFERRAL_CREDIT)} off, and so does the neighbor. Happy customers bring more neighbors.`,
};

/** The marketing budget field's problem the way setMarketing will judge it, or null when it would be accepted. Pure. */
export function marketingProblem(perMonth: number): string | null {
  if (!Number.isInteger(perMonth) || perMonth < 0 || perMonth > MARKETING_MAX_PER_MONTH) {
    return `Marketing must be a whole number from $0 to ${formatMoney(MARKETING_MAX_PER_MONTH)} a month`;
  }
  return null;
}

/** The marketing lines with nothing lit to sell to (the header's "light a street first"). */
export const MARKETING_NOTHING_LIT = 'No lit streets yet: marketing starts helping once a street is lit.';

/**
 * The marketing forecast line (spec I.4): "At $1,500 a month: about 12 new
 * customers a month, about $95 per new customer it brings." With no budget,
 * where new customers come from; with a budget that adds hardly any, says so;
 * with no homes to sell to yet (`canSell` false: nothing lit), says that
 * instead. Empty for a quote that is not ok. Pure.
 */
export function marketingForecast(q: MarketingQuote, canSell = true): string {
  if (!q.ok) return '';
  if (!canSell) return MARKETING_NOTHING_LIT;
  const at = `At ${formatMoney(q.perMonth)} a month: ${aboutCustomers(q.signupsPerMonth, 'new')} a month`;
  if (q.perMonth === 0) return `${at}, from neighbors and time alone.`;
  if (q.costPerCustomer === null) return `${at}, but marketing adds hardly any of them: most homes on your lit streets already know you.`;
  return `${at}, about ${formatMoney(q.costPerCustomer)} per new customer it brings.`;
}

/** "about 2 more a month" / "less than one more a month" / "about the same". */
function stepWords(diff: number, word: 'more' | 'fewer'): string {
  if (!(diff >= 0.05)) return 'about the same';
  return `${diff < 0.5 ? 'less than one' : `about ${formatNumber(diff)}`} ${word} a month`;
}

/**
 * What one MARKETING_STEP up or down would do: "$500 more a month: about 2
 * more a month. $500 less: about 1 fewer a month." `up` / `down`
 * null when the budget is at its maximum / minimum. Pure.
 */
export function marketingStepLine(base: MarketingQuote, up: MarketingQuote | null, down: MarketingQuote | null, canSell = true): string {
  if (!base.ok || !canSell) return '';
  const parts: string[] = [];
  if (up?.ok) parts.push(`${formatMoney(MARKETING_STEP)} more a month: ${stepWords(up.signupsPerMonth - base.signupsPerMonth, 'more')}.`);
  if (down?.ok) parts.push(`${formatMoney(MARKETING_STEP)} less: ${stepWords(base.signupsPerMonth - down.signupsPerMonth, 'fewer')}.`);
  return parts.join(' ');
}

/** One support level choice (supportOption). */
export interface SupportOption {
  level: SupportLevel;
  /** "Great" */
  name: string;
  current: boolean;
  /** "$7 a customer a month" */
  price: string;
  /** "$2,058 a month for your 294 customers. About 3 cancel a month; 294 happy." */
  effect: string;
  /** "Your level now." / "Better than now by about $6,300 over a year." / "Worse than now by about $300 over a year." */
  verdict: string;
}

/** A support level as the dashboard offers it, from its quote (spec I.4). Pure. */
export function supportOption(current: SupportLevel, customers: number, q: SupportQuote): SupportOption {
  const spec = SUPPORT_LEVELS[q.level];
  const isCurrent = q.level === current;
  const cancels = q.cancellationsPerMonth;
  const cancelWords = !(cancels > 0.05) ? 'Hardly anyone cancels' : `${cancels < 0.5 ? 'Less than one' : `About ${formatNumber(cancels)}`} ${cancels >= 0.5 && Math.round(cancels) === 1 ? 'cancels' : 'cancel'} a month`;
  const effect =
    customers > 0
      ? `${formatMoney(q.costPerMonth)} a month for your ${plural(customers, 'customer')}. ${cancelWords}; ${formatNumber(q.happy)} happy.`
      : 'No customers yet, so it costs nothing today.';
  let verdict: string;
  if (isCurrent) verdict = 'Your level now.';
  else if (customers === 0 || Math.abs(q.netValue) < 50) verdict = `About the same as now over ${horizonWords()}.`;
  else if (q.netValue > 0) verdict = `Better than now by about ${roughMoney(q.netValue)} over ${horizonWords()}.`;
  else verdict = `Worse than now by about ${roughMoney(-q.netValue)} over ${horizonWords()}.`;
  return { level: q.level, name: spec.name, current: isCurrent, price: `${formatMoney(spec.costPerSub)} a customer a month`, effect, verdict };
}

/** The referral credits lines (referralLines). */
export interface ReferralLines {
  on: boolean;
  /** "On" / "Off" */
  state: string;
  /** What credits on would bring: "About 3 referrals a month, about $150 a month in credits: about 1 more customer a month (about $150 each)." */
  forecast: string;
  /** "Turning them on: worth about $400 over a year." etc. */
  verdict: string;
}

/** Referral credits in words from the credits-on quote (spec I.4). Pure. */
export function referralLines(on: boolean, q: ReferralQuote): ReferralLines {
  let forecast: string;
  if (!q.ok) forecast = '';
  else if (!(q.referralsPerMonth >= 0.05)) forecast = 'Hardly any referrals expected now, so credits would cost little and bring few customers.';
  else {
    const refs = q.referralsPerMonth < 0.5 ? 'Less than one referral' : `About ${plural(Math.round(q.referralsPerMonth), 'referral')}`;
    // "no more customers a month (about $987 each)" would price customers it says don't come: under the count's own floor, say hardly any.
    const extra =
      q.costPerCustomer === null || aboutCount(q.extraPerMonth) === 'none'
        ? 'hardly any of them extra'
        : `${aboutCustomers(q.extraPerMonth, 'more')} a month (about ${formatMoney(q.costPerCustomer)} each)`;
    // roughMoney rounds to $10: a few dollars of credits would read "about $0".
    const credits = q.costPerMonth < 5 ? 'a few dollars a month in credits' : `about ${roughMoney(q.costPerMonth)} a month in credits`;
    forecast = `${refs} a month, ${credits}: ${extra}.`;
  }
  const value = q.netValue;
  const lead = on ? 'Keeping them on' : 'Turning them on';
  let verdict: string;
  if (!q.ok) verdict = '';
  else if (Math.abs(value) < 50) verdict = `${lead}: about break-even over ${horizonWords()}.`;
  else if (value > 0) verdict = `${lead}: worth about ${roughMoney(value)} over ${horizonWords()}.`;
  else verdict = `${lead}: costs about ${roughMoney(-value)} more than it brings over ${horizonWords()}.`;
  return { on, state: on ? 'On' : 'Off', forecast, verdict };
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Real time in milliseconds for the quotes' pace (the UI's clock; the sim never reads one). */
function clockNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string> = {}): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/** A face for a happiness bucket: shape as well as color (a smile, a straight mouth, a frown). Trusted markup. */
const FACES: Readonly<Record<HappinessBucket, string>> = {
  happy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 14c1 1.6 2.4 2.4 4 2.4s3-.8 4-2.4"/><circle cx="9" cy="10" r="0.6" fill="currentColor"/><circle cx="15" cy="10" r="0.6" fill="currentColor"/></svg>',
  okay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8.5 15h7"/><circle cx="9" cy="10" r="0.6" fill="currentColor"/><circle cx="15" cy="10" r="0.6" fill="currentColor"/></svg>',
  unhappy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 16.4c1-1.6 2.4-2.4 4-2.4s3 .8 4 2.4"/><circle cx="9" cy="10" r="0.6" fill="currentColor"/><circle cx="15" cy="10" r="0.6" fill="currentColor"/></svg>',
};

const BUCKET_NAMES: Readonly<Record<HappinessBucket, string>> = { happy: 'Happy', okay: 'Okay', unhappy: 'Unhappy' };

/** DOM of one area row. */
interface AreaDom {
  root: HTMLElement;
  place: HTMLElement;
  facts: HTMLElement;
  trend: HTMLElement;
  status: HTMLElement;
  line: HTMLElement;
  reason: HTMLElement;
  run: HTMLButtonElement;
  show: HTMLButtonElement;
  error: HTMLElement;
}

/** DOM of one reason row. */
interface ReasonDom {
  root: HTMLElement;
  label: HTMLElement;
  count: HTMLElement;
  fill: HTMLElement;
  lever: HTMLElement;
  links: HTMLElement;
  linksKey: string;
}

/** DOM of one support choice. */
interface SupportDom {
  button: HTMLButtonElement;
  price: HTMLElement;
  effect: HTMLElement;
  verdict: HTMLElement;
}

/** Put `nodes` in `container` in this order, moving only what is out of place (a focused button stays focused). */
function placeInOrder(container: HTMLElement, nodes: readonly HTMLElement[]): void {
  const keep = new Set<Node>(nodes);
  for (const child of [...container.children]) if (!keep.has(child)) child.remove();
  let cursor: Element | null = container.firstElementChild;
  for (const node of nodes) {
    if (cursor === node) {
      cursor = cursor.nextElementSibling;
      continue;
    }
    container.insertBefore(node, cursor);
  }
}

/** The Customers dashboard sheet; at most one at a time. */
export class CustomersPanel {
  private sheet: Sheet | null = null;
  private dom: PanelDom | null = null;
  /** What the figures were last drawn from: the game, its revision, and when the quotes last ran. */
  private seen = { state: null as GameState | null, revision: -1, quotesAt: -Infinity, quotesRevision: -1 };
  /** There are lit homes to sell to (the header's share): the marketing lines say so when there are none. */
  private canSell = true;

  constructor(
    private readonly session: GameSession,
    private readonly toasts: Toasts,
    private readonly deps: CustomersPanelDeps,
  ) {}

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  close(): void {
    this.sheet?.close();
  }

  /** Open the dashboard, optionally at an area or a section (when it is already open, just go there). */
  open(focus: CustomersFocus = {}): void {
    if (!this.sheet?.isOpen) this.build();
    this.goTo(focus);
  }

  /** Called every frame by main.ts: refresh figures in place while open (never rebuild an input). */
  update(session: GameSession): void {
    if (!this.isOpen || !this.dom) return;
    const state = session.state;
    const replaced = state !== this.seen.state;
    const stale = replaced || session.revision !== this.seen.revision;
    const quotesStale = replaced || session.revision !== this.seen.quotesRevision;
    if (!stale && !quotesStale) return;
    // The forecasts trail the clock by at most QUOTE_REFRESH_MS; everything else follows every day.
    const quotesDue = quotesStale && (replaced || clockNow() - this.seen.quotesAt >= QUOTE_REFRESH_MS);
    if (!stale && !quotesDue) return;
    this.refresh(quotesDue);
  }

  // -- building -------------------------------------------------------------

  private build(): void {
    const state = this.session.state;
    const sheet = openSheet({
      title: 'Customers',
      subtitle: plural(subscriberUnits(state), 'customer'),
      className: 'customers',
      onClose: () => {
        if (this.sheet === sheet) {
          this.sheet = null;
          this.dom = null;
        }
      },
    });
    this.sheet = sheet;
    const heading = sheet.dialog.querySelector<HTMLElement>('.sheet-heading');
    const headline = sheet.dialog.querySelector<HTMLElement>('.sheet-subtitle') ?? el('p');
    headline.classList.add('customers-headline');
    const kicker = el('p', { class: 'customers-kicker', text: `Customers · ${state.company.name}` });
    heading?.insertBefore(kicker, headline);

    const section = (key: string, title: string, children: (Node | null)[]) =>
      el('section', { class: `customers-section customers-${key}`, attrs: { 'data-section': key, 'aria-label': title } }, [
        el('h3', { class: 'customers-h', text: title, attrs: { tabindex: '-1' } }),
        ...children,
      ]);

    // Summary under the headline.
    const change = el('p', { class: 'customers-change' });
    const share = el('p', { class: 'customers-share' });
    const summary = el('div', { class: 'customers-summary' }, [change, share]);

    // Growth.
    const customersNow = el('span', { class: 'customers-chart-value' });
    const customersTop = el('span', { class: 'customers-axis-top' });
    const customersSvg = svgEl('svg', { class: 'customers-chart-svg', preserveAspectRatio: 'none', role: 'img', focusable: 'false' });
    const joinedTotal = el('span', { class: 'customers-legend-value' });
    const leftTotal = el('span', { class: 'customers-legend-value' });
    const flowSvg = svgEl('svg', { class: 'customers-chart-svg customers-flow-svg', preserveAspectRatio: 'none', role: 'img', focusable: 'false' });
    const firstMonth = el('span');
    const lastMonth = el('span');
    const firstMonth2 = el('span');
    const lastMonth2 = el('span');
    const growthText = el('p', { class: 'customers-chart-summary' });
    const charts = el('div', { class: 'customers-charts' }, [
      el('figure', { class: 'customers-chart' }, [
        el('figcaption', { class: 'customers-chart-head' }, [el('span', { class: 'customers-chart-title', text: 'Customers' }), customersNow]),
        el('div', { class: 'customers-plot' }, [customersTop, customersSvg]),
        el('div', { class: 'customers-axis' }, [firstMonth, lastMonth]),
      ]),
      el('figure', { class: 'customers-chart' }, [
        el('figcaption', { class: 'customers-chart-head' }, [
          el('span', { class: 'customers-chart-title', text: 'Joined and left each month' }),
          el('span', { class: 'customers-legend' }, [
            el('span', { class: 'customers-legend-item' }, [el('span', { class: 'customers-swatch swatch-joined', attrs: { 'aria-hidden': 'true' } }), el('span', { text: 'Joined' }), joinedTotal]),
            el('span', { class: 'customers-legend-item' }, [el('span', { class: 'customers-swatch swatch-left', attrs: { 'aria-hidden': 'true' } }), el('span', { text: 'Left' }), leftTotal]),
          ]),
        ]),
        el('div', { class: 'customers-plot' }, [flowSvg]),
        el('div', { class: 'customers-axis' }, [firstMonth2, lastMonth2]),
      ]),
    ]);
    const growthEmpty = el('p', { class: 'customers-empty' });
    const growth = section('growth', 'Growth', [growthEmpty, charts, growthText]);

    // Happiness.
    const counts = new Map<HappinessBucket, HTMLElement>();
    const happyTiles = el(
      'ul',
      { class: 'customers-moods' },
      (['happy', 'okay', 'unhappy'] as const).map((bucket) => {
        const value = el('span', { class: 'customers-mood-count' });
        counts.set(bucket, value);
        return el('li', { class: `customers-mood mood-${bucket}` }, [
          el('span', { class: 'customers-face', html: FACES[bucket], attrs: { 'aria-hidden': 'true' } }),
          el('span', { class: 'customers-mood-name', text: BUCKET_NAMES[bucket] }),
          value,
        ]);
      }),
    );
    const moodBar = el('div', { class: 'customers-mood-bar', attrs: { role: 'img' } });
    const moodSegs = new Map<HappinessBucket, HTMLElement>();
    for (const bucket of ['happy', 'okay', 'unhappy'] as const) {
      const seg = el('span', { class: `customers-mood-seg seg-${bucket}` });
      moodSegs.set(bucket, seg);
      moodBar.append(seg);
    }
    const happyReasonsHead = el('p', { class: 'customers-subhead', text: 'What moves them most' });
    const happyReasons = el('ul', { class: 'customers-reasons-list' });
    const happyEmpty = el('p', { class: 'customers-empty' });
    const happiness = section('happiness', 'How happy they are', [happyEmpty, happyTiles, moodBar, happyReasonsHead, happyReasons]);

    // Why homes haven't switched.
    const switchIntroEl = el('p', { class: 'customers-intro' });
    const switchList = el('ul', { class: 'customers-switch-list' });
    const reasons = section('reasons', "Why homes haven't switched", [switchIntroEl, switchList]);

    // Areas.
    const areasEmpty = el('p', { class: 'customers-empty', text: 'No lit areas yet: place a cabinet where your fiber reaches homes.' });
    const areaList = el('ul', { class: 'customers-area-list' });
    const areas = section('areas', 'Areas', [el('p', { class: 'customers-what', text: `Campaigns: ${LEVER_WHAT.campaign}` }), areasEmpty, areaList]);

    // Levers: marketing.
    const marketingNow = el('span', { class: 'customers-lever-now' });
    const marketingInput = el('input', {
      class: 'field num customers-marketing-input',
      attrs: {
        type: 'number',
        inputmode: 'numeric',
        min: '0',
        max: String(MARKETING_MAX_PER_MONTH),
        step: '100',
        value: String(state.sales.marketingPerMonth),
        'aria-label': 'Marketing budget per month',
        id: 'customers-marketing',
      },
    });
    const marketingApply = el('button', { class: 'btn customers-apply', text: 'Apply', attrs: { type: 'button' } });
    const marketingForecastEl = el('p', { class: 'customers-forecast marketing-forecast', attrs: { 'aria-live': 'polite' } });
    const marketingStep = el('p', { class: 'customers-forecast-step marketing-step' });
    const marketingProblemEl = el('p', { class: 'customers-problem' });
    const marketingError = el('p', { class: 'sheet-error customers-error', attrs: { role: 'alert' } });
    const marketing = el('div', { class: 'customers-lever lever-marketing', attrs: { 'data-section': 'marketing' } }, [
      el('div', { class: 'customers-lever-head' }, [el('h4', { class: 'customers-lever-title', text: 'Marketing budget', attrs: { tabindex: '-1' } }), marketingNow]),
      el('p', { class: 'customers-what', text: LEVER_WHAT.marketing }),
      el('div', { class: 'customers-marketing-row' }, [
        el('label', { class: 'money-field', attrs: { for: 'customers-marketing' } }, [el('span', { text: '$', attrs: { 'aria-hidden': 'true' } }), marketingInput, el('span', { class: 'per', text: 'a month' })]),
        marketingApply,
      ]),
      marketingForecastEl,
      marketingStep,
      marketingProblemEl,
      marketingError,
    ]);

    // Levers: support.
    const supportDom = new Map<SupportLevel, SupportDom>();
    const supportChoices = el('div', { class: 'customers-support-choices', attrs: { role: 'group', 'aria-label': 'Support level' } });
    for (const level of SUPPORT_LEVEL_IDS) {
      const price = el('span', { class: 'customers-choice-price' });
      const effect = el('span', { class: 'customers-choice-effect' });
      const verdict = el('span', { class: 'customers-choice-verdict' });
      const button = el('button', { class: 'customers-choice', attrs: { type: 'button', 'aria-pressed': 'false', 'data-level': level } }, [
        el('span', { class: 'customers-choice-name', text: SUPPORT_LEVELS[level].name }),
        price,
        effect,
        verdict,
      ]);
      button.addEventListener('click', () => this.chooseSupport(level));
      supportDom.set(level, { button, price, effect, verdict });
      supportChoices.append(button);
    }
    const supportError = el('p', { class: 'sheet-error customers-error', attrs: { role: 'alert' } });
    const support = el('div', { class: 'customers-lever lever-support', attrs: { 'data-section': 'support' } }, [
      el('div', { class: 'customers-lever-head' }, [el('h4', { class: 'customers-lever-title', text: 'Support level' })]),
      el('p', { class: 'customers-what', text: LEVER_WHAT.support }),
      supportChoices,
      supportError,
    ]);

    // Levers: referral credits.
    const referralSwitch = el('button', {
      class: 'customers-switch',
      attrs: { type: 'button', role: 'switch', 'aria-checked': 'false', 'aria-label': 'Referral credits' },
    }, [el('span', { class: 'customers-switch-track', attrs: { 'aria-hidden': 'true' } }, [el('span', { class: 'customers-switch-knob' })]), el('span', { class: 'customers-switch-text' })]);
    referralSwitch.addEventListener('click', () => this.toggleReferrals());
    const referralForecast = el('p', { class: 'customers-forecast referral-forecast' });
    const referralVerdict = el('p', { class: 'customers-forecast-step referral-verdict' });
    const referralError = el('p', { class: 'sheet-error customers-error', attrs: { role: 'alert' } });
    const referrals = el('div', { class: 'customers-lever lever-referrals', attrs: { 'data-section': 'referrals' } }, [
      el('div', { class: 'customers-lever-head' }, [el('h4', { class: 'customers-lever-title', text: 'Referral credits' }), referralSwitch]),
      el('p', { class: 'customers-what', text: LEVER_WHAT.referrals }),
      referralForecast,
      referralVerdict,
      referralError,
    ]);
    const levers = section('levers', 'Ways to grow', [marketing, support, referrals]);

    sheet.body.append(summary, growth, happiness, reasons, areas, levers);
    for (const error of [marketingError, supportError, referralError]) error.hidden = true;

    // Marketing: edits re-quote the typed budget; Apply (or Enter) sends setMarketing.
    marketingInput.addEventListener('input', () => {
      marketingError.hidden = true;
      this.refreshMarketing();
    });
    marketingInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        marketingApply.click();
      }
    });
    marketingApply.addEventListener('click', () => this.applyMarketing());

    this.dom = {
      headline,
      change,
      share,
      growthEmpty,
      charts,
      customersNow,
      customersTop,
      customersSvg,
      flowSvg,
      joinedTotal,
      leftTotal,
      months: [firstMonth, lastMonth, firstMonth2, lastMonth2],
      growthText,
      seriesKey: '(not drawn)',
      counts,
      moodBar,
      moodSegs,
      happyTiles,
      happyEmpty,
      happyReasonsHead,
      happyReasons,
      happyKey: '(not drawn)',
      switchIntro: switchIntroEl,
      switchList,
      switchRows: new Map(),
      areasEmpty,
      areaList,
      areaRows: new Map(),
      marketingNow,
      marketingInput,
      marketingApply,
      marketingForecast: marketingForecastEl,
      marketingStep,
      marketingProblem: marketingProblemEl,
      marketingError,
      support: supportDom,
      supportError,
      referralSwitch,
      referralForecast,
      referralVerdict,
      referralError,
    };
    this.seen = { state: null, revision: -1, quotesAt: -Infinity, quotesRevision: -1 };
    this.refresh(true);
  }

  /** Scroll to an area or a section (and focus the marketing field for 'marketing'). */
  private goTo(focus: CustomersFocus): void {
    const dom = this.dom;
    const sheet = this.sheet;
    if (!dom || !sheet) return;
    const scroll = (target: Element | null | undefined) => target?.scrollIntoView({ block: 'start', behavior: 'auto' });
    if (focus.cabinet !== undefined) {
      const row = dom.areaRows.get(focus.cabinet);
      if (row) {
        scroll(row.root);
        row.root.classList.remove('customers-flash');
        void row.root.offsetWidth;
        row.root.classList.add('customers-flash');
        return;
      }
      scroll(sheet.body.querySelector('[data-section="areas"]'));
      return;
    }
    if (!focus.section) return;
    const target = sheet.body.querySelector<HTMLElement>(`[data-section="${focus.section}"]`);
    scroll(target);
    if (focus.section === 'marketing') dom.marketingInput.focus({ preventScroll: true });
  }

  // -- refreshing -----------------------------------------------------------

  /** Rewrite every figure from the game as it stands; `quotes` also re-runs the forecasts. */
  private refresh(quotes: boolean): void {
    const dom = this.dom;
    if (!dom) return;
    const state = this.session.state;
    this.seen.state = state;
    this.seen.revision = this.session.revision;
    const reasons = whyNotSwitched(state);
    const header = customersHeader(state, reasons);
    this.canSell = header.share !== null;
    setText(dom.headline, header.title);
    setText(dom.change, header.change);
    setText(dom.share, header.shareLine);

    this.refreshGrowth(state);
    this.refreshHappiness(state);
    this.refreshReasons(state, reasons);
    const areas = customerAreas(state);
    const doQuotes = quotes || this.seen.quotesRevision < 0;
    this.refreshAreas(state, areas, doQuotes);
    if (doQuotes) {
      this.refreshMarketing();
      this.refreshSupport(state);
      this.refreshReferrals(state);
      this.seen.quotesAt = clockNow();
      this.seen.quotesRevision = this.session.revision;
    } else {
      // Settings may have changed through the game (a load): keep the controls honest without quoting.
      this.refreshLeverStates(state);
    }
  }

  private refreshGrowth(state: GameState): void {
    const dom = this.dom!;
    const series = growthSeries(state.finance.reports);
    const key = series.map((p) => `${p.year}-${p.month}:${p.customers}:${p.joined}:${p.left}`).join('|');
    if (key === dom.seriesKey) return;
    dom.seriesKey = key;
    const summary = growthSummary(series);
    setText(dom.growthText, summary);
    const empty = series.length === 0;
    dom.growthEmpty.hidden = !empty;
    dom.charts.hidden = empty;
    dom.growthText.hidden = empty;
    setText(dom.growthEmpty, summary);
    if (empty) return;
    const g = growthGeometry(series);
    const last = series.at(-1)!;
    setText(dom.customersNow, plural(last.customers, 'customer'));
    setText(dom.customersTop, formatNumber(g.customersMax));
    let joined = 0;
    let left = 0;
    for (const p of series) {
      joined += p.joined;
      left += p.left;
    }
    setText(dom.joinedTotal, formatNumber(joined));
    setText(dom.leftTotal, formatNumber(left));
    dom.months.forEach((node, i) => setText(node, i % 2 === 0 ? series[0]!.label : series.length > 1 ? last.label : ''));

    const view = `0 0 ${g.width} ${g.height}`;
    // Customers: gridlines at the top and the middle, the filled area, the line, and per-month hover targets.
    const cs = dom.customersSvg;
    cs.setAttribute('viewBox', view);
    cs.setAttribute('aria-label', `Customers by month. ${summary}`);
    const grid = (y: number) => svgEl('line', { class: 'chart-grid', x1: '0', x2: String(g.width), y1: String(y), y2: String(y), 'vector-effect': 'non-scaling-stroke' });
    const customerNodes: SVGElement[] = [grid(4), grid(52), svgEl('path', { class: 'chart-area', d: g.area }), svgEl('path', { class: 'chart-line', d: g.line, 'vector-effect': 'non-scaling-stroke' })];
    series.forEach((p, i) => {
      const hit = svgEl('rect', { class: 'chart-hit', x: String(i * CHART_COLUMN), y: '0', width: String(CHART_COLUMN), height: String(g.height) });
      const title = svgEl('title');
      title.textContent = `${p.label}: ${plural(p.customers, 'customer')}`;
      hit.append(title);
      customerNodes.push(hit);
    });
    cs.replaceChildren(...customerNodes);
    // Joined and left: bars up and down from one baseline.
    const fs = dom.flowSvg;
    fs.setAttribute('viewBox', view);
    fs.setAttribute('aria-label', `Customers who joined and left each month, ${series[0]!.label}${series.length > 1 ? ` to ${last.label}` : ''}: ${formatNumber(joined)} joined, ${formatNumber(left)} left.`);
    const flowNodes: SVGElement[] = [];
    g.bars.forEach((bar, i) => {
      const p = series[i]!;
      const group = svgEl('g');
      const title = svgEl('title');
      title.textContent = `${p.label}: ${formatNumber(p.joined)} joined, ${formatNumber(p.left)} left`;
      group.append(
        title,
        svgEl('rect', { class: 'chart-hit', x: String(i * CHART_COLUMN), y: '0', width: String(CHART_COLUMN), height: String(g.height) }),
        svgEl('rect', { class: 'chart-joined', x: String(bar.x), y: String(bar.joinedY), width: String(bar.width), height: String(bar.joinedHeight) }),
        svgEl('rect', { class: 'chart-left', x: String(bar.x), y: String(bar.leftY), width: String(bar.width), height: String(bar.leftHeight) }),
      );
      flowNodes.push(group);
    });
    flowNodes.push(svgEl('line', { class: 'chart-zero', x1: '0', x2: String(g.width), y1: String(g.baseline), y2: String(g.baseline), 'vector-effect': 'non-scaling-stroke' }));
    fs.replaceChildren(...flowNodes);
  }

  private refreshHappiness(state: GameState): void {
    const dom = this.dom!;
    const view = happinessView(state, happinessReport(state));
    const empty = view.total === 0;
    dom.happyEmpty.hidden = !empty;
    setText(dom.happyEmpty, 'No customers yet. Once homes sign up, this shows how happy they are and why.');
    dom.happyTiles.hidden = empty;
    dom.moodBar.hidden = empty;
    for (const bucket of ['happy', 'okay', 'unhappy'] as const) {
      setText(dom.counts.get(bucket)!, formatNumber(view[bucket]));
      const seg = dom.moodSegs.get(bucket)!;
      const width = `${view.total > 0 ? (view[bucket] / view.total) * 100 : 0}%`;
      if (seg.style.width !== width) seg.style.width = width;
    }
    dom.moodBar.setAttribute('aria-label', view.summary);
    const hasReasons = view.reasons.length > 0;
    dom.happyReasonsHead.hidden = !hasReasons;
    dom.happyReasons.hidden = !hasReasons;
    const key = view.reasons.map((r) => `${r.reason}:${r.bucket}:${r.units}:${r.cabinet}:${r.place}`).join('|');
    if (key === dom.happyKey) return;
    dom.happyKey = key;
    // Rebuilt only when the reasons change (a month close, a support change): they hold buttons but no inputs.
    dom.happyReasons.replaceChildren(
      ...view.reasons.map((r) => {
        const children: HTMLElement[] = [
          el('span', { class: 'customers-face', html: FACES[r.bucket], attrs: { 'aria-hidden': 'true' } }),
          el('span', { class: 'customers-reason-text' }, [el('span', { class: 'customers-reason-words', text: r.text }), el('span', { class: 'customers-reason-count', text: r.count })]),
        ];
        if (r.cabinet !== null && r.place !== null) {
          const cabinet = r.cabinet;
          children.push(
            el('button', {
              class: 'btn customers-show',
              text: 'Show me',
              attrs: { type: 'button', 'aria-label': `Show me: ${r.text}` },
              on: { click: () => this.show({ kind: 'focusCabinet', cabinet }) },
            }),
          );
        }
        return el('li', { class: `customers-reason mood-${r.bucket}`, attrs: { 'data-reason': r.reason } }, children);
      }),
    );
  }

  private refreshReasons(state: GameState, reasons: SwitchReasons): void {
    const dom = this.dom!;
    setText(dom.switchIntro, switchIntro(reasons));
    const rows = switchRows(state, reasons);
    const nodes: HTMLElement[] = [];
    for (const row of rows) {
      let r = dom.switchRows.get(row.key);
      if (!r) {
        const label = el('span', { class: 'customers-switch-label' });
        const count = el('span', { class: 'customers-switch-count' });
        const fill = el('span', { class: 'customers-switch-fill' });
        const lever = el('span', { class: 'customers-switch-lever' });
        const links = el('span', { class: 'customers-switch-links' });
        const root = el('li', { class: `customers-switch-row reason-${row.key}`, attrs: { 'data-reason': row.key } }, [
          el('div', { class: 'customers-switch-head' }, [label, count]),
          el('div', { class: 'customers-switch-bar', attrs: { 'aria-hidden': 'true' } }, [fill]),
          el('div', { class: 'customers-switch-fix' }, [el('span', { class: 'customers-fix-label', text: 'What helps: ' }), lever, links]),
        ]);
        r = { root, label, count, fill, lever, links, linksKey: '' };
        dom.switchRows.set(row.key, r);
      }
      setText(r.label, row.label);
      setText(r.count, row.countText);
      const width = `${row.share * 100}%`;
      if (r.fill.style.width !== width) r.fill.style.width = width;
      setText(r.lever, row.lever);
      const linksKey = row.links.map((l) => `${l.kind}:${l.label}:${'cabinet' in l ? l.cabinet : ''}`).join('|');
      if (linksKey !== r.linksKey) {
        r.linksKey = linksKey;
        r.links.replaceChildren(...row.links.map((link) => this.leverButton(link)));
      }
      nodes.push(r.root);
    }
    for (const key of [...dom.switchRows.keys()]) if (!rows.some((row) => row.key === key)) dom.switchRows.delete(key);
    placeInOrder(dom.switchList, nodes);
  }

  private leverButton(link: LeverLink): HTMLButtonElement {
    const button = el('button', { class: 'btn customers-link', text: link.label, attrs: { type: 'button' } });
    if (link.kind === 'section') {
      const goes = { marketing: 'Go to the marketing budget', areas: 'Go to the areas and their campaigns', referrals: 'Go to referral credits' } as const;
      button.setAttribute('aria-label', goes[link.section]);
      button.addEventListener('click', () => this.goTo({ section: link.section }));
    } else if (link.kind === 'pricing') {
      button.addEventListener('click', () => this.show({ kind: 'openPanel', panel: 'pricing' }));
    } else {
      button.setAttribute('aria-label', `Show me ${link.place}, where homes wait for install`);
      button.addEventListener('click', () => this.show({ kind: 'focusCabinet', cabinet: link.cabinet }));
    }
    return button;
  }

  private refreshAreas(state: GameState, areas: CustomerArea[], quotes: boolean): void {
    const dom = this.dom!;
    dom.areasEmpty.hidden = areas.length > 0;
    const nodes: HTMLElement[] = [];
    for (const area of areas) {
      let row = dom.areaRows.get(area.cabinet);
      const fresh = !row;
      if (!row) row = this.areaDom(area.cabinet);
      const quote = quotes || fresh ? quoteCampaign(state, area.cabinet) : null;
      const view = areaRow(state, area, quote);
      setText(row.place, view.place);
      setText(row.facts, view.facts);
      setText(row.trend, view.trendText);
      row.trend.className = `customers-trend trend-${view.trendTone}`;
      row.show.setAttribute('aria-label', `Show me ${view.place} on the map`);
      if (quote) {
        const c = view.campaign;
        row.run.disabled = c.disabled;
        row.run.setAttribute('aria-label', `Run a campaign at ${view.place}`);
        setText(row.line, c.line);
        row.line.hidden = c.line === '';
        setText(row.reason, c.reason ?? '');
        row.reason.hidden = c.reason === null;
        setText(row.status, c.status ?? '');
        row.status.hidden = c.status === null;
      }
      nodes.push(row.root);
    }
    const live = new Set(areas.map((a) => a.cabinet));
    for (const cabinet of [...dom.areaRows.keys()]) if (!live.has(cabinet)) dom.areaRows.delete(cabinet);
    placeInOrder(dom.areaList, nodes);
  }

  /** A new area row's DOM (its figures come from refreshAreas). */
  private areaDom(cabinet: CabinetId): AreaDom {
    const dom = this.dom!;
    const place = el('h4', { class: 'customers-area-place' });
    const facts = el('p', { class: 'customers-area-facts' });
    const trend = el('span', { class: 'customers-trend' });
    const status = el('p', { class: 'customers-area-status' });
    const line = el('p', { class: 'customers-area-quote' });
    const reason = el('p', { class: 'customers-area-reason' });
    const error = el('p', { class: 'sheet-error customers-error', attrs: { role: 'alert' } });
    error.hidden = true;
    const run = el('button', { class: 'btn customers-run', text: 'Run a campaign', attrs: { type: 'button', 'data-cabinet': String(cabinet) } });
    const show = el('button', { class: 'btn customers-show', text: 'Show me', attrs: { type: 'button' } });
    run.addEventListener('click', () => this.runCampaign(cabinet, error));
    show.addEventListener('click', () => this.show({ kind: 'focusCabinet', cabinet }));
    const root = el('li', { class: 'customers-area', attrs: { 'data-cabinet': String(cabinet) } }, [
      el('div', { class: 'customers-area-head' }, [place, trend]),
      facts,
      status,
      line,
      reason,
      el('div', { class: 'customers-area-actions' }, [run, show]),
      error,
    ]);
    const row: AreaDom = { root, place, facts, trend, status, line, reason, run, show, error };
    dom.areaRows.set(cabinet, row);
    return row;
  }

  /** The marketing field's own state: the current budget, the typed value's problem, and whether Apply has anything to send. Returns the typed value when it is valid. */
  private marketingFieldState(): number | null {
    const dom = this.dom!;
    const state = this.session.state;
    const current = state.sales.marketingPerMonth;
    setText(dom.marketingNow, `Now ${formatMoney(current)} a month`);
    const value = parseNumberField(dom.marketingInput.value);
    const problem = marketingProblem(value);
    dom.marketingInput.setAttribute('aria-invalid', String(problem !== null));
    setText(dom.marketingProblem, problem ?? '');
    dom.marketingProblem.hidden = problem === null;
    dom.marketingApply.disabled = problem !== null || value === current || state.gameOver !== null;
    return problem === null ? value : null;
  }

  /** The marketing lever: current budget, the typed budget's forecast and one step up or down. */
  private refreshMarketing(): void {
    const dom = this.dom;
    if (!dom) return;
    const state = this.session.state;
    const value = this.marketingFieldState();
    if (value === null) {
      setText(dom.marketingForecast, '');
      setText(dom.marketingStep, '');
      return;
    }
    const base = quoteMarketing(state, value);
    const up = value + MARKETING_STEP <= MARKETING_MAX_PER_MONTH ? quoteMarketing(state, value + MARKETING_STEP) : null;
    const down = value - MARKETING_STEP >= 0 ? quoteMarketing(state, value - MARKETING_STEP) : null;
    setText(dom.marketingForecast, marketingForecast(base, this.canSell));
    setText(dom.marketingStep, marketingStepLine(base, up, down, this.canSell));
  }

  private refreshSupport(state: GameState): void {
    const dom = this.dom!;
    const current = state.customers.supportLevel;
    const customers = subscriberUnits(state);
    for (const level of SUPPORT_LEVEL_IDS) {
      const d = dom.support.get(level)!;
      const option = supportOption(current, customers, quoteSupport(state, level));
      d.button.setAttribute('aria-pressed', String(option.current));
      d.button.setAttribute('aria-label', `${option.name} support: ${option.price}${option.current ? ', your level now' : ''}`);
      setText(d.price, option.price);
      setText(d.effect, option.effect);
      setText(d.verdict, option.verdict);
      d.button.disabled = state.gameOver !== null;
    }
  }

  private refreshReferrals(state: GameState): void {
    const dom = this.dom!;
    const on = state.customers.referrals;
    const lines = referralLines(on, quoteReferrals(state, true));
    dom.referralSwitch.setAttribute('aria-checked', String(on));
    setText(dom.referralSwitch.querySelector('.customers-switch-text')!, lines.state);
    setText(dom.referralForecast, lines.forecast);
    setText(dom.referralVerdict, lines.verdict);
    dom.referralSwitch.disabled = state.gameOver !== null;
  }

  /** Between quotes: only the settings' own state (which button is pressed, the switch, the current budget). */
  private refreshLeverStates(state: GameState): void {
    const dom = this.dom!;
    this.marketingFieldState();
    for (const level of SUPPORT_LEVEL_IDS) dom.support.get(level)!.button.setAttribute('aria-pressed', String(level === state.customers.supportLevel));
    dom.referralSwitch.setAttribute('aria-checked', String(state.customers.referrals));
    setText(dom.referralSwitch.querySelector('.customers-switch-text')!, state.customers.referrals ? 'On' : 'Off');
  }

  // -- commands -------------------------------------------------------------

  /** Close the sheet (the map is under it), then Show me / Open Pricing through main.ts. */
  private show(action: AdviceAction): void {
    this.close();
    this.deps.showMe(action);
  }

  private fail(error: HTMLElement, message: string): void {
    setText(error, message);
    error.hidden = false;
    this.toasts.show(message, false);
  }

  private applyMarketing(): void {
    const dom = this.dom;
    if (!dom) return;
    const value = parseNumberField(dom.marketingInput.value);
    const result = this.session.dispatch({ type: 'setMarketing', perMonth: value });
    if (!result.ok) {
      this.fail(dom.marketingError, `Marketing not changed: ${result.reason}`);
      return;
    }
    dom.marketingError.hidden = true;
    this.toasts.show(`Marketing set to ${formatMoney(value)} a month`, true);
    this.refresh(true);
  }

  private chooseSupport(level: SupportLevel): void {
    const dom = this.dom;
    if (!dom || this.session.state.customers.supportLevel === level) return;
    const result = this.session.dispatch({ type: 'setSupport', level });
    if (!result.ok) {
      this.fail(dom.supportError, `Support not changed: ${result.reason}`);
      return;
    }
    dom.supportError.hidden = true;
    const spec = SUPPORT_LEVELS[level];
    this.toasts.show(`Support set to ${spec.name}: ${formatMoney(spec.costPerSub)} a customer a month`, true);
    this.refresh(true);
  }

  private toggleReferrals(): void {
    const dom = this.dom;
    if (!dom) return;
    const on = !this.session.state.customers.referrals;
    const result = this.session.dispatch({ type: 'setReferrals', on });
    if (!result.ok) {
      this.fail(dom.referralError, `Referral credits not changed: ${result.reason}`);
      return;
    }
    dom.referralError.hidden = true;
    this.toasts.show(on ? `Referral credits on: ${formatMoney(REFERRAL_CREDIT)} off for each side of a referral` : 'Referral credits off', true);
    this.refresh(true);
  }

  private runCampaign(cabinet: CabinetId, error: HTMLElement): void {
    const state = this.session.state;
    const place = placeOf(state, cabinet) ?? 'that area';
    const result = this.session.dispatch({ type: 'runCampaign', cabinet });
    if (!result.ok) {
      this.fail(error, `No campaign: ${result.reason}`);
      return;
    }
    error.hidden = true;
    this.toasts.show(`Campaign started at ${place} for ${formatMoney(result.cost)}`, true);
    this.refresh(true);
  }
}

/** Every node the sheet rewrites in place. */
interface PanelDom {
  headline: HTMLElement;
  change: HTMLElement;
  share: HTMLElement;
  growthEmpty: HTMLElement;
  charts: HTMLElement;
  customersNow: HTMLElement;
  customersTop: HTMLElement;
  customersSvg: SVGSVGElement;
  flowSvg: SVGSVGElement;
  joinedTotal: HTMLElement;
  leftTotal: HTMLElement;
  months: HTMLElement[];
  growthText: HTMLElement;
  seriesKey: string;
  counts: Map<HappinessBucket, HTMLElement>;
  moodBar: HTMLElement;
  moodSegs: Map<HappinessBucket, HTMLElement>;
  happyTiles: HTMLElement;
  happyEmpty: HTMLElement;
  happyReasonsHead: HTMLElement;
  happyReasons: HTMLElement;
  happyKey: string;
  switchIntro: HTMLElement;
  switchList: HTMLElement;
  switchRows: Map<SwitchReasonKey, ReasonDom>;
  areasEmpty: HTMLElement;
  areaList: HTMLElement;
  areaRows: Map<CabinetId, AreaDom>;
  marketingNow: HTMLElement;
  marketingInput: HTMLInputElement;
  marketingApply: HTMLButtonElement;
  marketingForecast: HTMLElement;
  marketingStep: HTMLElement;
  marketingProblem: HTMLElement;
  marketingError: HTMLElement;
  support: Map<SupportLevel, SupportDom>;
  supportError: HTMLElement;
  referralSwitch: HTMLButtonElement;
  referralForecast: HTMLElement;
  referralVerdict: HTMLElement;
  referralError: HTMLElement;
}
