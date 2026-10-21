// The month-end briefing (round 4, the owner's own idea): at a month close the
// game pauses and a sheet shows the period at a glance, the advisor's
// suggestions (each with a real "Show me" button), what changed, the period's
// notices, the money in and out and a look ahead; Continue picks the game up
// at the speed the player had.
//
// The data is advisor.buildBriefing (pure sim); this file only turns it into
// words (briefingView, pure and unit-tested) and DOM (BriefingSheet). How often
// it shows is a per-browser preference (localStorage 'lst:briefing'), never
// game state: every month (default), every quarter, or only when something
// needs attention. Pages opened with ?debug=1 (every e2e test) start with it
// off unless the URL asks for it with ?briefing=1 (the stored preference) or
// ?briefing=<frequency>; the debug hook's setBriefing switches it too.
//
// Owner: ui-briefing workstream.

import { buildBriefing } from '../sim/advisor';
import { MONTH_ABBR, dateOf, formatDate } from '../sim/calendar';
import type {
  AdviceAction,
  AdviceSeverity,
  Briefing,
  BriefingChange,
  BriefingChangeKey,
  CppBand,
  GameState,
  LedgerCategory,
  MonthlyReport,
  Notice,
} from '../sim/types';
import { STAGE_LABEL, STAGE_TONE } from './bankPanel';
import type { BankTone } from './bankPanel';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { DEBUG_PARAM } from './debugHook';
import { el, icon } from './dom';
import {
  formatMaybeMoney,
  formatMoney,
  formatMonthLong,
  formatNumber,
  formatPercent,
  formatPoints,
  formatRatio,
  formatSignedMoney,
  plural,
} from './format';
import { ICONS } from './icons';
import { noticeTone } from './overlays';
import type { ToastTone } from './overlays';
import { subscriberMovements } from './panel';

// ---------------------------------------------------------------------------
// The preference: how often the briefing shows
// ---------------------------------------------------------------------------

/** How often the briefing shows (the sheet's radio group). */
export type BriefingFrequency = 'monthly' | 'quarterly' | 'attention';
/** A page's setting: a frequency, or 'off' (debug pages and tests, unless asked). */
export type BriefingSetting = BriefingFrequency | 'off';

export const BRIEFING_FREQUENCIES: readonly BriefingFrequency[] = ['monthly', 'quarterly', 'attention'];
export const FREQUENCY_LABEL: Readonly<Record<BriefingFrequency, string>> = {
  monthly: 'Every month',
  quarterly: 'Every quarter',
  attention: 'Only when something needs attention',
};
export const DEFAULT_BRIEFING_FREQUENCY: BriefingFrequency = 'monthly';
/** localStorage key of the preference. */
export const BRIEFING_STORAGE_KEY = 'lst:briefing';
/** URL parameter that turns briefings on for a debug page: '1' (the stored preference) or a frequency; '0' / 'off' turn them off. */
export const BRIEFING_PARAM = 'briefing';
/** Months a quarterly briefing covers. */
export const QUARTER_MONTHS = 3;

export function isBriefingFrequency(value: unknown): value is BriefingFrequency {
  return typeof value === 'string' && (BRIEFING_FREQUENCIES as readonly string[]).includes(value);
}

/** Months a briefing at this setting covers: a quarter for 'quarterly', else one month. */
export function briefingSpan(setting: BriefingSetting): number {
  return setting === 'quarterly' ? QUARTER_MONTHS : 1;
}

/**
 * Whether the close of `report` gets a briefing at `setting`: monthly always;
 * quarterly at the close of a quarter's last month (Mar, Jun, Sep, Dec);
 * attention-only when the briefing says something needs attention (pass
 * null before building it: false); off never.
 */
export function briefingDue(report: Pick<MonthlyReport, 'month'>, briefing: Pick<Briefing, 'needsAttention'> | null, setting: BriefingSetting): boolean {
  switch (setting) {
    case 'monthly':
      return true;
    case 'quarterly':
      return report.month % QUARTER_MONTHS === 0;
    case 'attention':
      return briefing?.needsAttention === true;
    case 'off':
      return false;
  }
}

/**
 * The briefing to show for the close that just wrote `report` (the latest),
 * or null when none is due at `setting` or the game has ended (the game-over
 * dialog shows instead). Pure: buildBriefing only reads the state.
 */
export function briefingAtClose(state: GameState, report: MonthlyReport, setting: BriefingSetting): Briefing | null {
  if (setting === 'off' || state.gameOver) return null;
  // Quarterly needs no briefing to decide; attention-only needs one built.
  if (setting === 'quarterly' && !briefingDue(report, null, setting)) return null;
  const briefing = buildBriefing(state, briefingSpan(setting));
  return briefing && briefingDue(report, briefing, setting) ? briefing : null;
}

/** The part of Storage the preference uses. */
export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** window.localStorage, or null where reaching it throws (blocked storage) or there is none (node). */
export function browserStorage(): PreferenceStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** The stored frequency; the default when there is none, it is unreadable, or storage throws. */
export function readBriefingFrequency(storage: () => PreferenceStorage | null = browserStorage): BriefingFrequency {
  try {
    const value = storage()?.getItem(BRIEFING_STORAGE_KEY);
    return isBriefingFrequency(value) ? value : DEFAULT_BRIEFING_FREQUENCY;
  } catch {
    return DEFAULT_BRIEFING_FREQUENCY;
  }
}

/** Store the frequency; false when storage is missing or throws (the choice then lasts for this page only). */
export function writeBriefingFrequency(frequency: BriefingFrequency, storage: () => PreferenceStorage | null = browserStorage): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(BRIEFING_STORAGE_KEY, frequency);
    return true;
  } catch {
    return false;
  }
}

/**
 * The setting a page starts with. `?briefing=1` uses the stored preference,
 * `?briefing=<frequency>` that frequency, `?briefing=0` / `off` none. Without
 * the parameter a debug page (`?debug=1`: every e2e test) starts off and any
 * other page uses the stored preference.
 */
export function startingBriefingSetting(search: string, stored: BriefingFrequency): BriefingSetting {
  const params = new URLSearchParams(search);
  const asked = params.get(BRIEFING_PARAM);
  const debug = params.get(DEBUG_PARAM) === '1';
  if (asked === '1') return stored;
  if (isBriefingFrequency(asked)) return asked;
  if (asked === '0' || asked === 'off') return 'off';
  return debug ? 'off' : stored;
}

/** The page's briefing setting, and the player's choice on the sheet (stored for the next visit). */
export class BriefingPreference {
  private remembered: BriefingFrequency;

  constructor(
    private setting: BriefingSetting,
    private readonly storage: () => PreferenceStorage | null = browserStorage,
  ) {
    this.remembered = setting === 'off' ? readBriefingFrequency(storage) : setting;
  }

  /** What the page does at a close now. */
  get current(): BriefingSetting {
    return this.setting;
  }

  /** The frequency the sheet's radio group shows (while off: the last one chosen or stored). */
  get frequency(): BriefingFrequency {
    return this.setting === 'off' ? this.remembered : this.setting;
  }

  /** The player chose on the sheet: use it from now on and store it; false if it could not be stored. */
  choose(frequency: BriefingFrequency): boolean {
    this.setting = frequency;
    this.remembered = frequency;
    return writeBriefingFrequency(frequency, this.storage);
  }

  /** Set this page's setting without storing it (the debug hook). */
  set(setting: BriefingSetting): void {
    this.setting = setting;
    if (setting !== 'off') this.remembered = setting;
  }
}

// ---------------------------------------------------------------------------
// The view model: a Briefing in words
// ---------------------------------------------------------------------------

export type GlanceKey = 'net' | 'cash' | 'subscribers' | 'passings' | 'takeRate' | 'cpp' | 'debt';

export interface GlanceTile {
  key: GlanceKey;
  label: string;
  value: string;
  /** Small print under the value (the CPP band and target, the covenant stage), or null. */
  detail: string | null;
  /** Coloring, always alongside words: negative money, the CPP band, or the covenant stage's tone. */
  tone: 'negative' | CppBand | BankTone | null;
}

export type ChangeDirection = 'up' | 'down' | 'flat';

export interface ChangeRow {
  key: BriefingChangeKey;
  label: string;
  /** This period's figure ('–' when it does not exist). */
  value: string;
  /** Direction of the change, or null when there is nothing to compare. */
  direction: ChangeDirection | null;
  /** The change in words: "up $1,200", "down 2.1 pts", "no change", or "–". */
  change: string;
  /** "was $9,800" for the earlier figure, or null. */
  before: string | null;
  /** Good or bad news by BriefingChange.upIsGood; neutral for no change or no comparison. */
  tone: 'good' | 'bad' | 'neutral';
}

export interface AdviceCard {
  severity: AdviceSeverity;
  severityLabel: string;
  title: string;
  why: string;
  actionLabel: string;
  action: AdviceAction;
}

export interface NoticeRow {
  id: number;
  tone: ToastTone;
  /** Spoken before the text (the tone icon is decoration): "Good news", "Heads up", "Problem". */
  toneLabel: string;
  /** "Mar 4" */
  when: string;
  text: string;
  /** Identical notices of the period folded into this row. */
  count: number;
}

export type MoneyGroup = 'operating' | 'building' | 'financing';

export interface MoneyGroupView {
  group: MoneyGroup;
  label: string;
  rows: { category: LedgerCategory; label: string; amount: string; negative: boolean }[];
  /** The group's sum. */
  total: string;
  negative: boolean;
}

export type ForwardKey = 'nextClose' | 'payment' | 'projectedCash' | 'runway' | 'called' | 'acceleration';

export interface ForwardRow {
  key: ForwardKey;
  label: string;
  value: string;
  detail: string | null;
  tone: 'negative' | 'warn' | 'danger' | null;
}

export interface BriefingView {
  /** "March 2028 briefing" / "Jan–Mar 2028 briefing" */
  title: string;
  subtitle: string;
  /** 'month' or 'quarter', for headings. */
  period: 'month' | 'quarter';
  tiles: GlanceTile[];
  /** What changed against the period before (empty when there is none: the first month). */
  changes: ChangeRow[];
  /** "March" / "the quarter before", what the changes compare against, or null. */
  comparedWith: string | null;
  advice: AdviceCard[];
  notices: NoticeRow[];
  /** Notices left out of `notices` (it shows at most NOTICE_ROWS_MAX rows). */
  moreNotices: number;
  money: MoneyGroupView[];
  /** The period's net cash flow (all groups). */
  net: string;
  netNegative: boolean;
  forward: ForwardRow[];
  needsAttention: boolean;
}

/** Most notice rows the sheet lists (the rest are counted). */
export const NOTICE_ROWS_MAX = 6;
/** A notice longer than this is cut to its first sentence (or to this many characters). */
export const NOTICE_TEXT_MAX = 150;

export const SEVERITY_LABEL: Readonly<Record<AdviceSeverity, string>> = {
  urgent: 'Urgent',
  important: 'Important',
  tip: 'Tip',
};

const TONE_LABEL: Readonly<Record<ToastTone, string>> = { ok: 'Good news', warn: 'Heads up', err: 'Problem' };

/** Words beside the cost-per-passing color (never color alone): "Far over the $1,000 target". */
export const CPP_BAND_TEXT: Readonly<Record<CppBand, string>> = {
  green: 'Within',
  amber: 'Over',
  red: 'Far over',
};

/** "Within the $1,000 target" for a band, or "Target $1,000" with nothing passed. */
export function cppTargetText(band: CppBand | null, target: number): string {
  return band === null ? `Target ${formatMoney(target)}` : `${CPP_BAND_TEXT[band]} the ${formatMoney(target)} target`;
}

/** Readable labels for the ledger categories, exhaustive so a new category needs one. */
export const CATEGORY_LABEL: Readonly<Record<LedgerCategory, string>> = {
  revenue: 'Subscriber billing',
  construction: 'Cable construction',
  equipment: 'Cabinets, splitters and OLT cards',
  install: 'Installs',
  refund: 'Refunds',
  poleRent: 'Pole rent',
  overhead: 'Overhead and support',
  payroll: 'Payroll',
  marketing: 'Marketing',
  repair: 'Storm and dig-in repairs',
  interest: 'Interest and fees',
  principal: 'Loan repayments',
  loanProceeds: 'Money borrowed',
  other: 'Other',
};

const CATEGORY_GROUP: Readonly<Record<LedgerCategory, MoneyGroup>> = {
  revenue: 'operating',
  poleRent: 'operating',
  overhead: 'operating',
  payroll: 'operating',
  marketing: 'operating',
  repair: 'operating',
  other: 'operating',
  construction: 'building',
  equipment: 'building',
  install: 'building',
  refund: 'building',
  interest: 'financing',
  principal: 'financing',
  loanProceeds: 'financing',
};

const GROUP_LABEL: Readonly<Record<MoneyGroup, string>> = {
  operating: 'Running the network',
  building: 'Building and installs',
  financing: 'Loans',
};

/** "Mar 4" */
function shortDate(day: number): string {
  const d = dateOf(day);
  return `${MONTH_ABBR[d.month - 1]} ${d.day}`;
}

/** "March 2028 briefing", or "Jan–Mar 2028 briefing" for a quarter. */
export function briefingTitle(briefing: Pick<Briefing, 'report' | 'span' | 'label'>): string {
  if (briefing.span <= 1) return `${formatMonthLong(briefing.report.year, briefing.report.month)} briefing`;
  return `${briefing.label.replace(/-/g, '–')} briefing`;
}

/**
 * A notice in at most NOTICE_TEXT_MAX characters: whole when short; else its
 * first sentence, or that sentence's headline before a colon ("Covenant
 * breach at the May 2027 close: leverage ..." -> "Covenant breach at the May
 * 2027 close."), else cut at a word. The Bank and the map keep the full text.
 */
export function condenseNotice(message: string): string {
  if (message.length <= NOTICE_TEXT_MAX) return message;
  const end = message.indexOf('. ');
  if (end > 0 && end < NOTICE_TEXT_MAX) return message.slice(0, end + 1);
  const colon = message.indexOf(': ');
  if (colon >= 20 && colon < NOTICE_TEXT_MAX) return `${message.slice(0, colon)}.`;
  const cut = message.lastIndexOf(' ', NOTICE_TEXT_MAX - 1);
  return `${message.slice(0, cut > 0 ? cut : NOTICE_TEXT_MAX - 1)}…`;
}

function changeValue(change: BriefingChange, amount: number): string {
  switch (change.unit) {
    case 'money':
      return change.key === 'net' || change.key === 'operatingCashFlow' ? formatSignedMoney(amount) : formatMoney(amount);
    case 'count':
      return formatNumber(amount);
    case 'ratio':
      return formatPercent(amount);
  }
}

/** One "what changed" row: the figure, its direction and size in words, and whether that is good news. */
export function changeRow(change: BriefingChange): ChangeRow {
  const value = change.now === null ? '–' : changeValue(change, change.now);
  const before = change.before === null ? null : `was ${changeValue(change, change.before)}`;
  if (change.delta === null) return { key: change.key, label: change.label, value, direction: null, change: '–', before, tone: 'neutral' };
  // The size as shown: a change that rounds to nothing is no change.
  const size = change.unit === 'ratio' ? formatPoints(change.delta) : change.unit === 'money' ? formatMoney(Math.abs(change.delta)) : formatNumber(Math.abs(change.delta));
  const shownZero = change.unit === 'ratio' ? Math.round(Math.abs(change.delta) * 1000) === 0 : Math.round(Math.abs(change.delta)) === 0;
  if (shownZero) return { key: change.key, label: change.label, value, direction: 'flat', change: 'no change', before, tone: 'neutral' };
  const direction: ChangeDirection = change.delta > 0 ? 'up' : 'down';
  const tone = change.upIsGood === null ? 'neutral' : (direction === 'up') === change.upIsGood ? 'good' : 'bad';
  return { key: change.key, label: change.label, value, direction, change: `${direction} ${size}`, before, tone };
}

function glanceTiles(b: Briefing): GlanceTile[] {
  const h = b.headline;
  const quarter = b.span > 1;
  const flow = b.changes.find((c) => c.key === 'operatingCashFlow')?.now ?? null;
  const debtTone = h.debt > 0 || h.stage !== 'compliant' ? STAGE_TONE[h.stage] : null;
  let debtDetail: string;
  if (h.debt <= 0 && h.stage === 'compliant') debtDetail = 'No loans';
  else {
    const leverage = h.covenant.leverage === null ? 'not measurable' : formatRatio(h.covenant.leverage);
    const figures = h.debt > 0 ? `: leverage ${leverage}, coverage ${formatRatio(h.covenant.coverage)}` : '';
    debtDetail = `${STAGE_LABEL[h.stage]}${figures}`;
  }
  return [
    {
      key: 'net',
      label: quarter ? 'Net this quarter' : 'Net this month',
      value: formatSignedMoney(h.net),
      detail: flow === null ? null : `operating ${formatSignedMoney(flow)}`,
      tone: h.net < 0 ? 'negative' : null,
    },
    { key: 'cash', label: 'Cash', value: formatMoney(h.cash), detail: 'at the close', tone: h.cash < 0 ? 'negative' : null },
    {
      key: 'subscribers',
      label: 'Subscribers',
      value: h.subscribers === null ? '–' : formatNumber(h.subscribers),
      detail: quarter ? null : subscriberMovements(b.report),
      tone: null,
    },
    { key: 'passings', label: 'Passings', value: formatNumber(h.passings), detail: 'homes and businesses lit', tone: null },
    { key: 'takeRate', label: 'Take rate', value: h.takeRate === null ? '–' : formatPercent(h.takeRate), detail: 'of passings subscribe', tone: null },
    {
      key: 'cpp',
      label: 'Cost per passing',
      value: formatMaybeMoney(h.cpp),
      detail: cppTargetText(h.cppBand, h.cppTarget),
      tone: h.cppBand,
    },
    { key: 'debt', label: 'Debt', value: formatMoney(h.debt), detail: debtDetail, tone: debtTone },
  ];
}

function adviceCards(b: Briefing): AdviceCard[] {
  return b.advice.map((a) => ({
    severity: a.severity,
    severityLabel: SEVERITY_LABEL[a.severity],
    title: a.title,
    why: a.why,
    actionLabel: a.actionLabel,
    action: a.action,
  }));
}

/** The period's notices, identical ones folded together, oldest first, at most NOTICE_ROWS_MAX. */
export function noticeRows(notices: readonly Notice[]): { rows: NoticeRow[]; more: number } {
  const rows: NoticeRow[] = [];
  const byText = new Map<string, NoticeRow>();
  for (const notice of notices) {
    const text = condenseNotice(notice.message);
    const key = `${notice.kind}|${text}`;
    const seen = byText.get(key);
    if (seen) {
      seen.count++;
      continue;
    }
    const tone = noticeTone(notice);
    const row: NoticeRow = { id: notice.id, tone, toneLabel: TONE_LABEL[tone], when: shortDate(notice.day), text, count: 1 };
    byText.set(key, row);
    rows.push(row);
  }
  const shown = rows.slice(0, NOTICE_ROWS_MAX);
  const more = rows.slice(NOTICE_ROWS_MAX).reduce((n, r) => n + r.count, 0);
  return { rows: shown, more };
}

function moneyGroups(b: Briefing): MoneyGroupView[] {
  const groups: MoneyGroupView[] = [];
  for (const group of ['operating', 'building', 'financing'] as const) {
    const lines = b.breakdown.filter((line) => CATEGORY_GROUP[line.category] === group);
    if (lines.length === 0) continue;
    const sum = lines.reduce((n, line) => n + line.amount, 0);
    groups.push({
      group,
      label: GROUP_LABEL[group],
      rows: lines.map((line) => ({
        category: line.category,
        label: CATEGORY_LABEL[line.category],
        amount: formatSignedMoney(line.amount),
        negative: line.amount < 0,
      })),
      total: formatSignedMoney(sum),
      negative: sum < 0,
    });
  }
  return groups;
}

function forwardRows(b: Briefing): ForwardRow[] {
  const f = b.forward;
  const close = formatDate(f.nextCloseDay);
  const rows: ForwardRow[] = [
    { key: 'nextClose', label: 'Next month close', value: close, detail: null, tone: null },
    {
      key: 'payment',
      label: 'Loan payment at that close',
      value: f.nextPayment > 0 ? formatMoney(f.nextPayment) : 'None due',
      detail: f.nextPayment > 0 ? `due ${close}: interest and principal, estimated` : null,
      tone: null,
    },
    {
      key: 'projectedCash',
      label: 'Cash projected at that close',
      value: formatMoney(f.projectedCash),
      detail:
        f.sweep > 0
          ? `after the loan payment and the frozen-line sweep (≈ ${formatMoney(f.sweep)})`
          : f.nextPayment > 0
            ? 'after the loan payment'
            : 'at today’s pace',
      tone: f.projectedCash < 0 ? 'negative' : null,
    },
    {
      key: 'runway',
      label: 'Runway',
      value: f.runwayMonths === null ? 'Not burning cash' : plural(f.runwayMonths, 'month'),
      detail: f.runwayMonths === null ? null : 'of cash at the monthly burn',
      tone: f.runwayMonths === null ? null : f.runwayMonths <= 2 ? 'danger' : f.runwayMonths <= 6 ? 'warn' : null,
    },
  ];
  if (f.closesUntilCalled !== null) {
    rows.push({
      key: 'called',
      label: 'The bank calls the loans',
      value: f.closesUntilCalled <= 0 ? 'at the next close' : `in ${plural(f.closesUntilCalled, 'close')}`,
      detail: 'if the credit line is still frozen',
      tone: f.closesUntilCalled <= 2 ? 'danger' : 'warn',
    });
  }
  if (f.accelerationClosesLeft !== null) {
    rows.push({
      key: 'acceleration',
      label: 'Loans called',
      value: `everything due within ${plural(f.accelerationClosesLeft, 'close')}`,
      detail: 'a close that cannot pay is a default',
      tone: 'danger',
    });
  }
  return rows;
}

/** Everything the sheet shows for a briefing, in words. Pure. */
export function briefingView(b: Briefing, cityName = ''): BriefingView {
  const quarter = b.span > 1;
  const period = quarter ? 'quarter' : 'month';
  const { rows, more } = noticeRows(b.notices);
  const changes = b.previous ? b.changes.map(changeRow) : [];
  const comparedWith = b.previous ? (quarter ? 'the quarter before' : formatMonthLong(b.previous.year, b.previous.month).split(' ')[0]!) : null;
  const where = cityName ? `${cityName}: ` : '';
  return {
    title: briefingTitle(b),
    subtitle: `${where}game paused. ${b.needsAttention ? 'Something needs your attention.' : `Here is how the ${period} went.`}`,
    period,
    tiles: glanceTiles(b),
    changes,
    comparedWith,
    advice: adviceCards(b),
    notices: rows,
    moreNotices: more,
    money: moneyGroups(b),
    net: formatSignedMoney(b.headline.net),
    netNegative: b.headline.net < 0,
    forward: forwardRows(b),
    needsAttention: b.needsAttention,
  };
}

// ---------------------------------------------------------------------------
// Show me: where an advice points
// ---------------------------------------------------------------------------

/**
 * The map point (grid units) a "Show me" action points at: a node, a
 * cabinet's node, or the midpoint of a segment's two nodes; null for a panel,
 * or a place that is gone (a cabinet removed since).
 */
export function actionPoint(state: GameState, action: AdviceAction): { x: number; y: number } | null {
  const { city } = state;
  switch (action.kind) {
    case 'focusNode': {
      const node = city.nodes[action.node];
      return node ? { x: node.x, y: node.y } : null;
    }
    case 'focusCabinet': {
      const cabinet = state.network.cabinets.find((c) => c.id === action.cabinet);
      const node = cabinet ? city.nodes[cabinet.node] : undefined;
      return node ? { x: node.x, y: node.y } : null;
    }
    case 'focusSegment': {
      const segment = city.segments[action.segment];
      const a = segment ? city.nodes[segment.a] : undefined;
      const b = segment ? city.nodes[segment.b] : undefined;
      return a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
    }
    case 'openPanel':
      return null;
  }
}

/** How long the Show me ring stays (it fades over the last FADE_MS). */
export const HIGHLIGHT_MS = 2500;
const HIGHLIGHT_FADE_MS = 400;

/**
 * The pulsing ring "Show me" puts on the map: a DOM element (aria-hidden)
 * placed each frame at `project(world point)` (CSS client pixels), so it
 * follows the camera until it fades.
 */
export class PlaceHighlight {
  private ring: HTMLElement | null = null;
  private point: { x: number; y: number } | null = null;
  private timers: number[] = [];

  constructor(private readonly project: (x: number, y: number) => { x: number; y: number }) {}

  get isShowing(): boolean {
    return this.ring !== null;
  }

  /** Ring the map point (x, y) (grid units) for HIGHLIGHT_MS. */
  show(x: number, y: number): void {
    this.clear();
    const ring = el('div', { class: 'briefing-ring', attrs: { 'aria-hidden': 'true' } }, [el('span', { class: 'briefing-ring-pulse' })]);
    this.ring = ring;
    this.point = { x, y };
    document.body.append(ring);
    this.update();
    this.timers.push(
      window.setTimeout(() => ring.classList.add('leaving'), HIGHLIGHT_MS - HIGHLIGHT_FADE_MS),
      window.setTimeout(() => this.clear(), HIGHLIGHT_MS),
    );
  }

  /** Every frame: follow the camera. */
  update(): void {
    if (!this.ring || !this.point) return;
    const p = this.project(this.point.x, this.point.y);
    this.ring.style.left = `${Math.round(p.x)}px`;
    this.ring.style.top = `${Math.round(p.y)}px`;
  }

  clear(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers = [];
    this.ring?.remove();
    this.ring = null;
    this.point = null;
  }
}

// ---------------------------------------------------------------------------
// The sheet
// ---------------------------------------------------------------------------

export interface BriefingSheetDeps {
  preference: BriefingPreference;
  /** Continue, Esc, the backdrop or the close button: the game picks up its speed again. */
  onContinue(): void;
  /** A Show me button: the sheet has closed; do the action (the game stays paused). */
  onAction(action: AdviceAction): void;
  /** The frequency could not be stored (blocked storage): it lasts for this page only. */
  onStoreFailed?(): void;
}

/** How the open sheet closes: Continue (resume), a Show me action, or quietly (a game replaced). */
type Exit = { kind: 'continue' } | { kind: 'action'; action: AdviceAction } | { kind: 'quiet' };

const TONE_ICON: Readonly<Record<ToastTone, string>> = { ok: ICONS.spark, warn: ICONS.warning, err: ICONS.close };
const ARROW: Readonly<Record<ChangeDirection, string>> = { up: '▲', down: '▼', flat: '•' };

/** Ids for each render's headings and radio group, unique on the page. */
let renders = 0;

export class BriefingSheet {
  /** The sheet on screen and how it is closing (its close event comes later, so each sheet keeps its own). */
  private current: { sheet: Sheet; exit: Exit } | null = null;
  private shown: Briefing | null = null;
  private renderId = 0;

  constructor(private readonly deps: BriefingSheetDeps) {}

  /** The <dialog> is open (false as soon as it starts closing). */
  get isOpen(): boolean {
    return this.current?.sheet.dialog.open ?? false;
  }

  /** The briefing on screen, or null. */
  get briefing(): Briefing | null {
    return this.isOpen ? this.shown : null;
  }

  /**
   * Show a briefing (the caller has paused the game). Over one already open
   * (a later close while it shows), the content is replaced in place.
   */
  open(briefing: Briefing, cityName: string): void {
    const view = briefingView(briefing, cityName);
    this.shown = briefing;
    let entry = this.current;
    if (!entry || !entry.sheet.dialog.open) {
      const created: { sheet: Sheet | null; exit: Exit } = { sheet: null, exit: { kind: 'continue' } };
      const sheet = openSheet({
        title: view.title,
        subtitle: view.subtitle,
        className: 'briefing',
        onClose: () => {
          if (this.current?.sheet === sheet) this.current = null;
          const exit = created.exit;
          if (exit.kind === 'continue') this.deps.onContinue();
          else if (exit.kind === 'action') this.deps.onAction(exit.action);
        },
      });
      created.sheet = sheet;
      entry = created as { sheet: Sheet; exit: Exit };
      this.current = entry;
    } else {
      setTextOf(entry.sheet.dialog.querySelector('.sheet-title'), view.title);
      setTextOf(entry.sheet.dialog.querySelector('.sheet-subtitle'), view.subtitle);
    }
    this.render(entry.sheet, view);
  }

  /** Close without resuming (the game in play was replaced, or ended). */
  dismiss(): void {
    this.finish({ kind: 'quiet' });
  }

  private finish(exit: Exit): void {
    const entry = this.current;
    if (!entry || !entry.sheet.dialog.open) return;
    entry.exit = exit;
    entry.sheet.close();
  }

  private render(sheet: Sheet, view: BriefingView): void {
    this.renderId = ++renders;
    const { body, actions } = sheet;
    sheet.dialog.classList.toggle('briefing-attention', view.needsAttention);
    body.replaceChildren(
      this.glance(view),
      this.advisor(view),
      this.changes(view),
      this.notices(view),
      this.money(view),
      this.forward(view),
      this.frequency(),
    );
    const go = el('button', {
      class: 'btn sheet-primary briefing-continue',
      text: 'Continue',
      attrs: { type: 'button' },
      on: { click: () => this.finish({ kind: 'continue' }) },
    });
    actions.replaceChildren(go);
    body.scrollTop = 0;
    go.focus({ preventScroll: true });
  }

  private section(name: string, title: string, children: (Node | null)[]): HTMLElement {
    const id = `briefing-${name}-${this.renderId}`;
    return el('section', { class: `briefing-section briefing-${name}`, attrs: { 'aria-labelledby': id } }, [
      el('h3', { text: title, attrs: { id } }),
      ...children,
    ]);
  }

  private glance(view: BriefingView): HTMLElement {
    return this.section('glance', `The ${view.period} at a glance`, [
      el(
        'dl',
        { class: 'briefing-tiles' },
        view.tiles.map((tile) =>
          el('div', { class: `briefing-tile briefing-tile-${tile.key}`, attrs: { 'data-key': tile.key } }, [
            el('dt', { text: tile.label }),
            el('dd', {}, [
              el('span', { class: `num briefing-tile-value${tile.tone ? ` tone-${tile.tone}` : ''}`, text: tile.value }),
              tile.detail
                ? el('small', { class: 'briefing-tile-detail' }, [
                    tile.key === 'cpp' && tile.tone ? el('span', { class: `band-swatch cpp-bg-${tile.tone}`, attrs: { 'aria-hidden': 'true' } }) : null,
                    el('span', { text: tile.detail }),
                  ])
                : null,
            ]),
          ]),
        ),
      ),
    ]);
  }

  private advisor(view: BriefingView): HTMLElement {
    if (view.advice.length === 0) {
      return this.section('advisor', 'Advisor', [el('p', { class: 'briefing-empty', text: 'Nothing pressing. Keep building and signing people up!' })]);
    }
    return this.section('advisor', 'Advisor', [
      el(
        'ol',
        { class: 'briefing-advice' },
        view.advice.map((card) =>
          el('li', { class: `briefing-card briefing-card-${card.severity}` }, [
            el('div', { class: 'briefing-card-head' }, [
              el('span', { class: `briefing-severity briefing-severity-${card.severity}`, text: card.severityLabel }),
              el('h4', { class: 'briefing-card-title', text: card.title }),
            ]),
            el('p', { class: 'briefing-card-why', text: card.why }),
            el('button', {
              class: 'btn sheet-secondary briefing-show',
              text: card.actionLabel,
              attrs: { type: 'button', 'aria-label': `${card.actionLabel}: ${card.title}` },
              on: { click: () => this.finish({ kind: 'action', action: card.action }) },
            }),
          ]),
        ),
      ),
    ]);
  }

  private changes(view: BriefingView): HTMLElement {
    if (view.changes.length === 0) {
      return this.section('changes', 'What changed', [el('p', { class: 'briefing-empty', text: 'Your first month: nothing earlier to compare with yet.' })]);
    }
    return this.section('changes', `What changed since ${view.comparedWith ?? 'last time'}`, [
      el(
        'ul',
        { class: 'briefing-changes' },
        view.changes.map((row) =>
          el('li', { class: `briefing-change change-${row.tone}`, attrs: { 'data-key': row.key } }, [
            el('span', { class: 'briefing-change-label', text: row.label }),
            el('span', { class: 'num briefing-change-value', text: row.value }),
            el('span', { class: 'briefing-change-delta', attrs: row.before ? { title: row.before } : {} }, [
              row.direction ? el('span', { class: 'briefing-arrow', text: ARROW[row.direction], attrs: { 'aria-hidden': 'true' } }) : null,
              el('span', { text: row.change }),
              // The earlier figure is a tooltip on screen; screen readers hear it.
              row.before ? el('span', { class: 'visually-hidden', text: ` (${row.before})` }) : null,
            ]),
          ]),
        ),
      ),
    ]);
  }

  private notices(view: BriefingView): HTMLElement {
    const title = view.period === 'quarter' ? 'This quarter’s notices' : 'This month’s notices';
    if (view.notices.length === 0) return this.section('notices', title, [el('p', { class: 'briefing-empty', text: `No notices this ${view.period}.` })]);
    return this.section('notices', title, [
      el(
        'ul',
        { class: 'briefing-notices' },
        view.notices.map((row) =>
          el('li', { class: `briefing-notice notice-${row.tone}` }, [
            icon(TONE_ICON[row.tone], 'icon briefing-notice-icon'),
            el('span', { class: 'visually-hidden', text: `${row.toneLabel}: ` }),
            el('span', { class: 'briefing-notice-when', text: row.when }),
            el('span', { class: 'briefing-notice-text', text: row.count > 1 ? `${row.text} (×${row.count})` : row.text }),
          ]),
        ),
      ),
      view.moreNotices > 0 ? el('p', { class: 'briefing-more', text: `and ${plural(view.moreNotices, 'more notice')}` }) : null,
    ]);
  }

  private money(view: BriefingView): HTMLElement {
    const title = view.period === 'quarter' ? 'Money in and out this quarter' : 'Money in and out';
    const groups = view.money.map((group) =>
      el('div', { class: `briefing-money-group money-${group.group}` }, [
        el('h4', { text: group.label }),
        el(
          'dl',
          {},
          group.rows.map((row) =>
            el('div', { class: 'briefing-money-row', attrs: { 'data-category': row.category } }, [
              el('dt', { text: row.label }),
              el('dd', { class: `num${row.negative ? ' negative' : ''}`, text: row.amount }),
            ]),
          ),
        ),
        group.rows.length > 1
          ? el('p', { class: 'briefing-money-total' }, [el('span', { text: 'Subtotal' }), el('span', { class: `num${group.negative ? ' negative' : ''}`, text: group.total })])
          : null,
      ]),
    );
    return this.section('money', title, [
      ...(groups.length > 0 ? groups : [el('p', { class: 'briefing-empty', text: 'No money moved.' })]),
      el('p', { class: 'briefing-money-net' }, [el('span', { text: 'Net cash flow' }), el('span', { class: `num${view.netNegative ? ' negative' : ''}`, text: view.net })]),
    ]);
  }

  private forward(view: BriefingView): HTMLElement {
    return this.section('forward', 'Looking ahead', [
      el(
        'dl',
        { class: 'briefing-forward' },
        view.forward.map((row) =>
          el('div', { class: 'briefing-forward-row', attrs: { 'data-key': row.key } }, [
            el('dt', {}, [el('span', { text: row.label }), row.detail ? el('small', { text: row.detail }) : null]),
            el('dd', { class: `num${row.tone ? ` tone-${row.tone}` : ''}`, text: row.value }),
          ]),
        ),
      ),
    ]);
  }

  private frequency(): HTMLElement {
    const name = `briefing-frequency-${this.renderId}`;
    const chosen = this.deps.preference.frequency;
    const note = el('p', { class: 'briefing-frequency-note', text: 'Kept in this browser. Reopen the latest briefing from the menu.' });
    return el('fieldset', { class: 'briefing-section briefing-frequency' }, [
      el('legend', { text: 'Show this briefing' }),
      el(
        'div',
        { class: 'briefing-choices' },
        BRIEFING_FREQUENCIES.map((frequency) => {
          const input = el('input', { attrs: { type: 'radio', name, value: frequency } });
          input.checked = frequency === chosen;
          input.addEventListener('change', () => {
            if (!input.checked) return;
            if (!this.deps.preference.choose(frequency)) this.deps.onStoreFailed?.();
          });
          return el('label', { class: 'briefing-choice' }, [input, el('span', { text: FREQUENCY_LABEL[frequency] })]);
        }),
      ),
      note,
    ]);
  }
}

function setTextOf(node: Element | null, text: string): void {
  if (node && node.textContent !== text) node.textContent = text;
}
