// The month-end summary (round 4, the owner's own idea; still "the briefing"
// in code, the menu and the dialog's name): at a month close the game pauses
// and a sheet shows how the period went; Continue picks the game up at the
// speed the player had.
//
// Round 4c/4d (spec G, the owner's pick "Summary B + next step"): the first
// view shows only the figures a player acts on, in plain words, top to
// bottom: a header (the period and the company) and a one-line headline
// chosen from the period's story; money in as one bar split by source;
// money out as one stacked bar in three groups (running the business,
// building fiber, loan payments), each group a button that opens its lines;
// both bars on one scale; the cash card (went up or down, what is left, how
// long it lasts or what building cost); the customers line with "See
// customers"; at most two "Needs attention" lines with their buttons; and
// the advisor's top card as "Your next step" (Show me / Not now) with the
// rest behind "N more tips". Everything the round-4b briefing had that is
// no longer on the first view is one tap away in "See the full books": the
// glance tiles, the itemized money, every notice, the look ahead and the
// frequency select, and (since the report panel became a small summary too)
// "More figures" for the latest month: the KPIs, operations and bank figures
// the panel used to list (panel.reportRows), each trade term beside its plain
// meaning. The report panel opens these books on their own (openBooks): not
// a month-end briefing, Close returns to the game. No jargon on the first
// view (no leverage, covenant, DSCR, ARR, OCF, bps or ×); debt is never
// success green.
//
// The data is advisor.buildBriefing (pure sim: Briefing.story, money, cash,
// attention, advice); this file only turns it into words (summaryView, pure
// and unit-tested; it sums ledger lines and formats, never invents a money
// figure) and DOM (BriefingSheet). Snoozes go through deps.dispatch
// (snoozeAdvice), and a close-time briefing records what it showed
// (noteAdviceShown) once per report. How often it shows is a per-browser
// preference (localStorage 'lst:briefing'), never game state: every month
// (default), every quarter, or only when something needs attention. Pages
// opened with ?debug=1 (every e2e test) start with it off unless the URL
// asks for it with ?briefing=1 (the stored preference) or
// ?briefing=<frequency>; the debug hook's setBriefing switches it too.
//
// Owner: ui-summary workstream (round 4c/4d); ui-briefing / briefing-advisor-polish before.

import { briefingBuiltOn, buildBriefing, closeDayOf } from '../sim/advisor';
import { ADVICE_SNOOZE_MONTHS, ADVICE_SNOOZE_URGENT_MONTHS } from '../sim/balance';
import { MONTH_ABBR, dateOf, formatDate } from '../sim/calendar';
import { healthLevel } from '../sim/debt';
import type {
  AdviceAction,
  AdviceSeverity,
  AttentionItem,
  BankHealthLevel,
  Briefing,
  BriefingCash,
  BriefingChange,
  BriefingChangeKey,
  BriefingStory,
  Command,
  CommandResult,
  CppBand,
  CovenantStage,
  GameState,
  MoneyGroupKey,
  MoneyLine,
  MoneyLineKey,
  MonthlyReport,
  Notice,
} from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { DEBUG_PARAM } from './debugHook';
import { el, icon } from './dom';
import { formatMaybeMoney, formatMoney, formatMonthLong, formatNumber, formatPercent, formatPoints, formatSignedMoney, plural } from './format';
import { HEALTH_TONE, HEALTH_WORD, healthTitleOf } from './health';
import type { HealthTone } from './health';
import { ICONS } from './icons';
import { noticeTone } from './overlays';
import type { ToastTone } from './overlays';
// panel.ts imports this module's view model too: both use each other's exports only inside functions.
import { reportRows, subscriberMovements } from './panel';
import type { ReportRow } from './panel';

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
// The view model: a Briefing in plain words
// ---------------------------------------------------------------------------

/** "month" or "quarter": what the period is called. */
export type PeriodWord = 'month' | 'quarter';

function periodOf(b: Pick<Briefing, 'span'>): PeriodWord {
  return b.span > 1 ? 'quarter' : 'month';
}

/** "March 2028 briefing", or "Jan–Mar 2028 briefing" for a quarter: the dialog's accessible name. */
export function briefingTitle(briefing: Pick<Briefing, 'report' | 'span' | 'label'>): string {
  return `${periodLabel(briefing)} briefing`;
}

/** "The full books for March 2028": the dialog's accessible name when the report panel opens the books on their own. */
export function booksTitle(briefing: Pick<Briefing, 'report' | 'span' | 'label'>): string {
  return `The full books for ${periodLabel(briefing)}`;
}

/** "March 2028", or "Jan–Mar 2028" for a quarter. */
export function periodLabel(briefing: Pick<Briefing, 'report' | 'span' | 'label'>): string {
  if (briefing.span <= 1) return formatMonthLong(briefing.report.year, briefing.report.month);
  return briefing.label.replace(/-/g, '–');
}

/**
 * The header line over the headline: "July 2029 · Marten Run Fiber" (the
 * sheet sets it in capitals: "JULY 2029 · MARTEN RUN FIBER"), or
 * "Jul–Sep 2029 · ..." for a quarter; the period alone without a name.
 */
export function summaryKicker(b: Pick<Briefing, 'report' | 'span' | 'label'>, companyName: string): string {
  const name = companyName.trim();
  return name ? `${periodLabel(b)} · ${name}` : periodLabel(b);
}

/** The headline for each story but the bank's (spec G.1). */
export const STORY_HEADLINE: Readonly<Record<Exclude<BriefingStory, 'bank'>, string>> = {
  earned: 'You earned more than you spent',
  building: "You spent more than you earned, because you're building",
  billsShort: "Your bills don't cover your running costs yet",
};

/** The bank's health as the summary words it (the same words as the Bank and the HUD chip: ui/health.ts). */
export interface HealthBadge {
  level: BankHealthLevel;
  /** HEALTH_WORD[level]: "Good", "Watch", "Warning", "Higher interest", "No more borrowing". */
  word: string;
  /** "Bank health: Warning", or "Bank health: Loans called". */
  text: string;
  /** HEALTH_TONE[level]; 'danger' once the loans are called. Never success green while there is trouble. */
  tone: HealthTone;
  /** The bank has called the loans (debt owed). */
  called: boolean;
}

/**
 * The bank's health at the briefing's figures: debt.healthLevel on its
 * covenant stage and figures (what debt.bankHealth(state).level says for a
 * briefing built at the close), and whether the loans are called.
 */
export function briefingHealth(b: Pick<Briefing, 'headline' | 'forward'>): HealthBadge {
  const h = b.headline;
  const level = healthLevel(h.stage, h.covenant, h.debt > 0);
  const called = b.forward.accelerationClosesLeft !== null && h.debt > 0;
  return {
    level,
    word: HEALTH_WORD[level],
    text: healthTitleOf({ level, called }),
    tone: called ? 'danger' : HEALTH_TONE[level],
    called,
  };
}

export interface SummaryHeadline {
  text: string;
  /** Amber while bills don't cover running costs; the bank's tone when the bank leads. */
  tone: 'warn' | 'danger' | null;
  /** The bank's health under the headline when the bank leads, else null. */
  health: HealthBadge | null;
}

/** The headline the period's story picks (spec G.1): the bank's trouble leads when there is any. */
export function summaryHeadline(b: Pick<Briefing, 'story' | 'headline' | 'forward'>): SummaryHeadline {
  if (b.story !== 'bank') return { text: STORY_HEADLINE[b.story], tone: b.story === 'billsShort' ? 'warn' : null, health: null };
  const health = briefingHealth(b);
  let text: string;
  if (health.called) text = 'The bank wants its loans paid back';
  else if (health.level === 'frozen') text = 'The bank has stopped your borrowing';
  else if (health.level === 'penalty') text = 'The bank raised the interest on your loans';
  else text = 'The bank is worried about your loans';
  return { text, tone: health.tone === 'ok' ? 'warn' : health.tone, health };
}

/** Every money line in plain words (the itemized lists; exhaustive, so a new key needs one). */
export const MONEY_LINE_LABEL: Readonly<Record<MoneyLineKey, string>> = {
  bills: 'Customer bills',
  borrowed: 'Borrowed',
  otherIn: 'Other',
  overheadBase: 'Base costs (any size)',
  overheadCustomers: 'Per customer (support and billing)',
  overheadPlant: 'Per cabinet and mile of cable',
  overhead: 'Overhead and support',
  payroll: 'Payroll',
  poleRent: 'Pole rent',
  marketing: 'Marketing',
  campaigns: 'Neighborhood campaigns',
  referrals: 'Referral credits',
  repair: 'Storm and dig-in repairs',
  otherOut: 'Other',
  construction: 'New cable',
  equipment: 'Cabinets, splitters and OLT cards',
  install: 'Installs',
  refund: 'Refunds',
  interest: 'Interest and fees',
  principal: 'Paying back loans',
};

/** A line's name in a group's sub-label ("staff, customer support and pole rent"). */
export const MONEY_LINE_SHORT: Readonly<Record<MoneyLineKey, string>> = {
  bills: 'customer bills',
  borrowed: 'borrowing',
  otherIn: 'other',
  overheadBase: 'base costs',
  overheadCustomers: 'customer support',
  overheadPlant: 'network upkeep',
  overhead: 'overhead and support',
  payroll: 'staff',
  poleRent: 'pole rent',
  marketing: 'marketing',
  campaigns: 'campaigns',
  referrals: 'referral credits',
  repair: 'repairs',
  otherOut: 'other',
  construction: 'new cable',
  equipment: 'equipment',
  install: 'installs',
  refund: 'refunds',
  interest: 'interest',
  principal: 'paying back',
};

/**
 * The order lines are listed in (spec G.3): running the business lists the
 * overhead's base / per-customer / per-plant lines (or the one overhead
 * line), then payroll, pole rent, marketing, repairs, other.
 */
const MONEY_LINE_ORDER: readonly MoneyLineKey[] = [
  'bills',
  'borrowed',
  'otherIn',
  'overheadBase',
  'overheadCustomers',
  'overheadPlant',
  'overhead',
  'payroll',
  'poleRent',
  'marketing',
  'campaigns',
  'referrals',
  'repair',
  'otherOut',
  'construction',
  'equipment',
  'install',
  'refund',
  'interest',
  'principal',
];

export const MONEY_GROUP_LABEL: Readonly<Record<MoneyGroupKey, string>> = {
  running: 'Running the business',
  building: 'Building fiber',
  loans: 'Loan payments',
};

/** One itemized line. */
export interface MoneyLineView {
  key: MoneyLineKey;
  label: string;
  amount: number;
  /** "$1,200" (a refund that nets a group reads "-$300"). */
  value: string;
}

/** A bar segment: a money-in source or a money-out group. */
export interface BarSegment {
  key: MoneyLineKey | MoneyGroupKey;
  label: string;
  amount: number;
  value: string;
  /** Its length as a share of the shared scale (0..1). */
  share: number;
  /** Its label is printed inside it (only the customer bills, alone and wide enough); otherwise a legend names it. */
  inside: boolean;
}

export interface MoneyBar {
  total: number;
  /** "$25,748" */
  value: string;
  /** The bar's length as a share of the shared scale (0..1): the larger total is the full width. */
  share: number;
  segments: BarSegment[];
  /** Accessible text: "Money in $25,748: Customer bills $25,748." */
  description: string;
  /** Said instead of an empty bar ("No money came in this month."), else null. */
  empty: string | null;
}

/** A money-out group in the legend: a button that opens its lines. */
export interface MoneyGroupView {
  key: MoneyGroupKey;
  label: string;
  total: number;
  value: string;
  /** Its biggest parts in plain words ("staff, customer support and pole rent"), or "nothing this month". */
  sub: string;
  /** Building only: cost per home passed against the target, "$1,040 per home passed, target $1,000". */
  note: string | null;
  /** Its itemized lines, in MONEY_LINE_ORDER. */
  lines: MoneyLineView[];
}

/** Below this share of the scale a segment is too short to print its label inside. */
export const BAR_LABEL_MIN_SHARE = 0.25;

/** "$1,040 per home passed, target $1,000", or "No homes passed yet, target $1,000 each". */
export function cppWords(cpp: number | null, target: number): string {
  if (cpp === null) return `No homes passed yet, target ${formatMoney(target)} each`;
  return `${formatMoney(cpp)} per home passed, target ${formatMoney(target)}`;
}

/** "a", "a and b", "a, b and c". */
function listWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function lineView(line: MoneyLine): MoneyLineView {
  return { key: line.key, label: MONEY_LINE_LABEL[line.key], amount: line.amount, value: formatMoney(line.amount) };
}

function orderLines(lines: readonly MoneyLine[]): MoneyLineView[] {
  return [...lines].sort((a, b) => MONEY_LINE_ORDER.indexOf(a.key) - MONEY_LINE_ORDER.indexOf(b.key)).map(lineView);
}

/** Most parts a group's sub-label names. */
const SUB_PARTS_MAX = 3;

/**
 * What the money bars and groups read: the period's money, its span and the
 * cost per home passed. A Briefing has them all; the report panel builds
 * them for its one month from the sim (advisor.briefingMoney and the
 * report's KPIs) without the advisor's suggestions.
 */
export type MoneyFigures = Pick<Briefing, 'money' | 'span'> & { headline: Pick<Briefing['headline'], 'cpp' | 'cppTarget'> };

/** The money-out groups, always all three, with their sub-labels and lines (spec G.3). */
export function moneyGroups(b: MoneyFigures): MoneyGroupView[] {
  const period = periodOf(b);
  return (['running', 'building', 'loans'] as const).map((key) => {
    const group = b.money.groups.find((g) => g.key === key);
    const lines = group?.lines ?? [];
    const total = group?.total ?? 0;
    const biggest = [...lines].filter((l) => l.amount > 0).sort((x, y) => y.amount - x.amount);
    const parts = biggest.slice(0, SUB_PARTS_MAX).map((l) => MONEY_LINE_SHORT[l.key]);
    return {
      key,
      label: MONEY_GROUP_LABEL[key],
      total,
      value: formatMoney(total),
      sub: total > 0 && parts.length > 0 ? listWords(parts) : `nothing this ${period}`,
      note: key === 'building' ? cppWords(b.headline.cpp, b.headline.cppTarget) : null,
      lines: orderLines(lines),
    };
  });
}

/**
 * The two bars on one scale (the larger of money in and money out is the
 * full width), so their lengths compare honestly. Money in is split by
 * source (customer bills, borrowed, other: only those that are not zero);
 * money out by group.
 */
export function moneyBars(b: MoneyFigures): { scale: number; in: MoneyBar; out: MoneyBar; inLegend: boolean } {
  const { money } = b;
  const period = periodOf(b);
  const scale = Math.max(money.in, money.out);
  const share = (amount: number) => (scale > 0 ? amount / scale : 0);
  const sources = money.inLines.filter((l) => l.amount > 0);
  const inSegments: BarSegment[] = sources.map((l) => ({
    key: l.key,
    label: MONEY_LINE_LABEL[l.key],
    amount: l.amount,
    value: formatMoney(l.amount),
    share: share(l.amount),
    inside: false,
  }));
  const single = inSegments.length === 1 && inSegments[0]!.key === 'bills' && inSegments[0]!.share >= BAR_LABEL_MIN_SHARE;
  if (single) inSegments[0]!.inside = true;
  const groups = moneyGroups(b);
  const outSegments: BarSegment[] = groups
    .filter((g) => g.total > 0)
    .map((g) => ({ key: g.key, label: g.label, amount: g.total, value: g.value, share: share(g.total), inside: false }));
  const describe = (name: string, total: number, segments: BarSegment[]) =>
    segments.length === 0 ? `${name} ${formatMoney(total)}.` : `${name} ${formatMoney(total)}: ${segments.map((s) => `${s.label} ${s.value}`).join(', ')}.`;
  return {
    scale,
    in: {
      total: money.in,
      value: formatMoney(money.in),
      share: share(money.in),
      segments: inSegments,
      description: describe('Money in', money.in, inSegments),
      empty: money.in > 0 ? null : `No money came in this ${period}.`,
    },
    out: {
      total: money.out,
      value: formatMoney(money.out),
      share: share(money.out),
      segments: outSegments,
      description: describe('Money out', money.out, outSegments),
      empty: money.out > 0 ? null : `Nothing went out this ${period}.`,
    },
    inLegend: !single && inSegments.length > 0,
  };
}

/** A sentence in parts, some set in bold ("At this pace your cash lasts **about 10 months**."). */
export type Words = { text: string; strong?: boolean }[];

/** The words of a sentence in parts, joined. */
export function wordsText(words: Words): string {
  return words.map((w) => w.text).join('');
}

export interface CashCardView {
  /** "Cash went down $4,479" / "Cash went up $1,200" / "Cash stayed the same". */
  headline: string;
  /** "$43,753 left", or "$2,100 overdrawn". */
  left: string;
  direction: 'up' | 'down' | 'flat';
  /** The sentences under it (spec G.4). */
  lines: Words[];
}

/** Months of runway in plain words: "about 10 months", or "about 3 years" from two years on (a slow burn on a big purse is not "about 158 months"). */
export function runwayPhrase(months: number): string {
  return months >= 24 ? `about ${plural(Math.round(months / 12), 'year')}` : `about ${plural(months, 'month')}`;
}

/**
 * The cash card's heading and what is left: "Cash went down $4,479" and
 * "$43,753 left" (or "went up", "stayed the same", "$2,100 overdrawn").
 * Shared by the summary's cash card and the report panel's cash line.
 */
export function cashHeadline(cash: Pick<BriefingCash, 'change' | 'end'>): Pick<CashCardView, 'headline' | 'left' | 'direction'> {
  const change = cash.change;
  return {
    headline: change < 0 ? `Cash went down ${formatMoney(-change)}` : change > 0 ? `Cash went up ${formatMoney(change)}` : 'Cash stayed the same',
    left: cash.end < 0 ? `${formatMoney(-cash.end)} overdrawn` : `${formatMoney(cash.end)} left`,
    direction: change < 0 ? 'down' : change > 0 ? 'up' : 'flat',
  };
}

/**
 * The cash card (spec G.4): how much cash moved and what is left; when it
 * fell, how long it lasts at this pace (BriefingCash.paceMonths: the
 * period's own pace, building included, as the mockup reads); when the
 * period built fiber, what running the business alone made
 * (BriefingCash.withoutBuilding), or plainly that the bills don't cover the
 * running costs yet; when it rose, how much a month (and how much of it was
 * borrowed).
 */
export function cashCard(b: Pick<Briefing, 'cash' | 'money' | 'story' | 'span'>): CashCardView {
  const { cash } = b;
  const period = periodOf(b);
  const change = cash.change;
  const { headline, left, direction } = cashHeadline(cash);
  const lines: Words[] = [];
  const borrowed = b.money.inLines.find((l) => l.key === 'borrowed')?.amount ?? 0;
  if (change < 0 && cash.paceMonths !== null) {
    lines.push(
      cash.paceMonths <= 0
        ? [{ text: 'At this pace your cash runs out ' }, { text: 'before the next month close', strong: true }, { text: '.' }]
        : [{ text: 'At this pace your cash lasts ' }, { text: runwayPhrase(cash.paceMonths), strong: true }, { text: '.' }],
    );
  }
  if (change > 0) {
    if (borrowed > 0) {
      const own = change - borrowed;
      lines.push(
        own > 0
          ? [{ text: 'That includes ' }, { text: formatMoney(borrowed), strong: true }, { text: ` you borrowed; without it you'd still have added ${formatMoney(own)}.` }]
          : [
              { text: 'You borrowed ' },
              { text: formatMoney(borrowed), strong: true },
              { text: own < 0 ? `; without it your cash would have gone down ${formatMoney(-own)}.` : '; without it your cash would have stayed the same.' },
            ],
      );
    } else {
      lines.push([{ text: 'At this pace you add ' }, { text: `about ${formatMoney(cash.perMonth)}`, strong: true }, { text: ' a month.' }]);
    }
  }
  if (cash.building && b.story !== 'earned') {
    if (cash.withoutBuilding > 0) {
      lines.push([{ text: "Building is your choice: without it you'd have made " }, { text: formatMoney(cash.withoutBuilding), strong: true }, { text: ` this ${period}.` }]);
    } else if (cash.withoutBuilding < 0) {
      lines.push([
        { text: "Your bills don't cover your running costs yet: even without building you'd have lost " },
        { text: formatMoney(-cash.withoutBuilding), strong: true },
        { text: ` this ${period}.` },
      ]);
    } else {
      lines.push([{ text: "Without building you'd have just broken even: your bills only just cover your running costs." }]);
    }
  }
  return { headline, left, direction, lines };
}

/** The customers line (spec G.5): "**372 customers** (+9). 38% of the homes you pass buy from you." Null without subscriber figures (an old report). */
export function customersLine(b: Pick<Briefing, 'headline' | 'changes'>): Words | null {
  const subs = b.headline.subscribers;
  if (subs === null) return null;
  const delta = b.changes.find((c) => c.key === 'subscribers')?.delta ?? null;
  const moved = delta === null ? '' : ` (${delta >= 0 ? '+' : '-'}${formatNumber(Math.abs(delta))})`;
  const take = b.headline.takeRate;
  return [
    { text: plural(subs, 'customer'), strong: true },
    { text: `${moved}. ` },
    { text: take === null ? 'No homes passed yet.' : `${formatPercent(take)} of the homes you pass buy from you.` },
  ];
}

/** "See customers": the Customers dashboard (main.ts opens it for this action). */
export const SEE_CUSTOMERS: AdviceAction = { kind: 'openPanel', panel: 'customers' };

export interface AttentionLine {
  kind: AttentionItem['kind'];
  /** One short plain line. */
  text: string;
  /** "Open the Bank" for the bank's lines, "Show me" for a place. */
  button: string;
  action: AdviceAction;
  tone: 'warn' | 'danger';
}

const BANK_ATTENTION: ReadonlySet<AttentionItem['kind']> = new Set(['bankStage', 'bankWatch', 'loansCalled']);

/** CovenantStage -> its health level (compliant reads Good here: a step-up is never to compliant). */
function stageLevel(stage: CovenantStage | null): BankHealthLevel {
  return stage === null || stage === 'compliant' ? 'good' : stage;
}

/** A "Needs attention" item in one short plain line, with its button (spec G.6). */
export function attentionLine(item: AttentionItem): AttentionLine {
  const bank = BANK_ATTENTION.has(item.kind);
  const button = bank ? 'Open the Bank' : 'Show me';
  const place = item.place;
  let text: string;
  let tone: 'warn' | 'danger' = 'warn';
  switch (item.kind) {
    case 'bankStage': {
      const level = stageLevel(item.stage);
      text = `Bank health is now ${HEALTH_WORD[level]}: you went over a bank limit at the month close.`;
      tone = HEALTH_TONE[level] === 'danger' ? 'danger' : 'warn';
      break;
    }
    case 'bankWatch':
      text = `Bank health: ${HEALTH_WORD.watch}. If the month closed today you'd fail a bank check.`;
      break;
    case 'loansCalled':
      text = item.count === null ? 'The bank has asked for every loan back.' : `The bank wants every loan back within ${plural(item.count, 'month close')}.`;
      tone = 'danger';
      break;
    case 'outage': {
      const n = item.count ?? 1;
      if (place === null) text = `${plural(n, 'cable span')} ${n === 1 ? 'is' : 'are'} out of service.`;
      else text = n === 1 ? `Cable is out of service on ${place}.` : `${plural(n, 'cable span')} are out of service, one on ${place}.`;
      tone = 'danger';
      break;
    }
    case 'storm': {
      const n = item.count ?? 1;
      const where = place === null ? '' : ` near ${place}`;
      text = n === 1 ? `A storm hit${where}. The damage is repaired.` : `${plural(n, 'storm')} hit, the last${where}. The damage is repaired.`;
      break;
    }
    case 'cabinetFull': {
      const at = place === null ? 'A cabinet' : `The cabinet at ${place}`;
      text = item.count !== null && item.count > 0 ? `${at} is full: ${plural(item.count, 'home')} waiting.` : `${at} is full and turning signups away.`;
      break;
    }
  }
  return { kind: item.kind, text, button, action: item.action, tone };
}

/** A suggestion as the summary shows it: the next step, or one of the more tips. */
export interface StepCard {
  /** Advice.key: what Not now snoozes. */
  key: string;
  severity: AdviceSeverity;
  title: string;
  why: string;
  /** The longer reasoning behind the card's own disclosure, or null. */
  detail: string | null;
  /** "Show me", "Open Pricing", ...: Advice.actionLabel. */
  actionLabel: string;
  action: AdviceAction;
  /** Not now's tooltip: "Hide this for 3 months", or "until next month" for urgent advice. */
  snoozeHint: string;
}

/** How long Not now hides a suggestion: "Hide this for 3 months" (ADVICE_SNOOZE_MONTHS), or "Hide this until next month" (urgent: ADVICE_SNOOZE_URGENT_MONTHS). */
export function snoozeHint(severity: AdviceSeverity): string {
  const months = Math.max(1, severity === 'urgent' ? ADVICE_SNOOZE_URGENT_MONTHS : ADVICE_SNOOZE_MONTHS);
  return months === 1 ? 'Hide this until next month' : `Hide this for ${months} months`;
}

function stepCard(a: Briefing['advice'][number]): StepCard {
  return {
    key: a.key,
    severity: a.severity,
    title: a.title,
    why: a.why,
    detail: a.detail && a.detail.trim() ? a.detail : null,
    actionLabel: a.actionLabel,
    action: a.action,
    snoozeHint: snoozeHint(a.severity),
  };
}

export interface NextStepView {
  /** advice[0], or null when the advisor has nothing. */
  next: StepCard | null;
  /** The rest of the advice. */
  tips: StepCard[];
  /** "2 more tips" / "1 more tip", or null with none. */
  tipsLabel: string | null;
  /** "1 snoozed suggestion", or null with none. */
  snoozedText: string | null;
  /** Said instead of a card when there is no advice (never "Nothing pressing" while cash falls), else null. */
  empty: string | null;
}

/** "Your next step" and the more tips (spec G.7). */
export function nextStep(b: Pick<Briefing, 'advice' | 'snoozed' | 'cash'>): NextStepView {
  const cards = b.advice.map(stepCard);
  const tips = cards.slice(1);
  let empty: string | null = null;
  if (cards.length === 0) {
    empty = b.cash.change < 0 ? 'No suggestion right now. See the full books for where the money goes.' : 'Nothing pressing right now. Keep building and signing people up.';
  }
  return {
    next: cards[0] ?? null,
    tips,
    tipsLabel: tips.length > 0 ? plural(tips.length, 'more tip') : null,
    snoozedText: b.snoozed > 0 ? plural(b.snoozed, 'snoozed suggestion') : null,
    empty,
  };
}

// --- The full books ----------------------------------------------------------

export type GlanceKey = 'net' | 'cash' | 'subscribers' | 'passings' | 'takeRate' | 'cpp' | 'debt';

/** The full books' tiles, in order: each also carries its change against the period before. */
export const GLANCE_KEYS: readonly GlanceKey[] = ['net', 'cash', 'subscribers', 'passings', 'takeRate', 'cpp', 'debt'];

export type ChangeDirection = 'up' | 'down' | 'flat';

/** A tile's change against the period before, in words (never color alone). */
export interface TileChange {
  direction: ChangeDirection | null;
  /** "up $1,200", "down 2.1 pts", "no change". */
  text: string;
  /** "was $9,800" for the earlier figure, or null. */
  before: string | null;
  /** Good or bad news by BriefingChange.upIsGood; debt is always neutral. */
  tone: 'good' | 'bad' | 'neutral';
}

export interface GlanceTile {
  key: GlanceKey;
  label: string;
  value: string;
  /** Small print under the value (the cost-per-home band and target, the bank's health, the month's subscriber moves), or null. */
  detail: string | null;
  /** Coloring, always alongside words: negative money, the cost-per-home band, or the bank's tone. Never success green on debt. */
  tone: 'negative' | CppBand | 'warn' | 'danger' | null;
  /** Its change against the period before (null on the first briefing, or with nothing to compare). */
  change: TileChange | null;
}

export interface ChangeRow {
  key: BriefingChangeKey;
  label: string;
  /** This period's figure ('–' when it does not exist). */
  value: string;
  direction: ChangeDirection | null;
  /** The change in words: "up $1,200", "down 2.1 pts", "no change", or "–". */
  change: string;
  before: string | null;
  tone: 'good' | 'bad' | 'neutral';
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

export type ForwardKey = 'nextClose' | 'payment' | 'projectedCash' | 'runway' | 'called' | 'acceleration';

export interface ForwardRow {
  key: ForwardKey;
  label: string;
  value: string;
  detail: string | null;
  tone: 'negative' | 'warn' | 'danger' | null;
}

export interface BooksView {
  tiles: GlanceTile[];
  /** What changed that is not a tile (revenue, operating cash flow); empty with nothing to compare. */
  changes: ChangeRow[];
  /** "March" / "the quarter before", or null. */
  comparedWith: string | null;
  /** Money in, itemized. */
  moneyIn: MoneyLineView[];
  /** Money out by group, itemized (every group, even at $0). */
  moneyOut: MoneyGroupView[];
  inTotal: string;
  outTotal: string;
  /** The period's cash change ("+$1,200" / "-$4,479"): money in less money out. */
  net: string;
  netNegative: boolean;
  /** Every notice of the period, identical ones folded together. */
  notices: NoticeRow[];
  noticeCount: number;
  forward: ForwardRow[];
  /** "More figures for March 2028": the latest report's own month, even in a quarter. */
  moreTitle: string;
  /**
   * The rest of the latest report (panel.reportRows: average bill, marketing
   * per new customer, outages, the bank's figures, ...), the rows with
   * nothing to say left out: with the tiles and the money above, every figure
   * the old report panel listed.
   */
  more: ReportRow[];
}

const TONE_LABEL: Readonly<Record<ToastTone, string>> = { ok: 'Good news', warn: 'Heads up', err: 'Problem' };

/** Words beside the cost-per-home color (never color alone): "Far over the $1,000 target". */
export const CPP_BAND_TEXT: Readonly<Record<CppBand, string>> = {
  green: 'Within',
  amber: 'Over',
  red: 'Far over',
};

/** "Within the $1,000 target" for a band, or "Target $1,000" with nothing passed. */
export function cppTargetText(band: CppBand | null, target: number): string {
  return band === null ? `Target ${formatMoney(target)}` : `${CPP_BAND_TEXT[band]} the ${formatMoney(target)} target`;
}

/** "Mar 4" */
function shortDate(day: number): string {
  const d = dateOf(day);
  return `${MONTH_ABBR[d.month - 1]} ${d.day}`;
}

/** A notice longer than this is cut to its first sentence (or to this many characters). */
export const NOTICE_TEXT_MAX = 150;

/**
 * A notice in at most NOTICE_TEXT_MAX characters: whole when short; else its
 * first sentence, or that sentence's headline before a colon, else cut at a
 * word. The Bank and the map keep the full text.
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

/** The period's notices, identical ones folded together, oldest first: every one of them. */
export function noticeRows(notices: readonly Notice[]): NoticeRow[] {
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
  return rows;
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

/**
 * One change in words: the figure, its direction and size, and whether that
 * is good news. Debt is never good or bad news by itself: its tone is
 * neutral whatever upIsGood says.
 */
export function changeRow(change: BriefingChange): ChangeRow {
  const value = change.now === null ? '–' : changeValue(change, change.now);
  const before = change.before === null ? null : `was ${changeValue(change, change.before)}`;
  if (change.delta === null) return { key: change.key, label: change.label, value, direction: null, change: '–', before, tone: 'neutral' };
  const size = change.unit === 'ratio' ? formatPoints(change.delta) : change.unit === 'money' ? formatMoney(Math.abs(change.delta)) : formatNumber(Math.abs(change.delta));
  const shownZero = change.unit === 'ratio' ? Math.round(Math.abs(change.delta) * 1000) === 0 : Math.round(Math.abs(change.delta)) === 0;
  if (shownZero) return { key: change.key, label: change.label, value, direction: 'flat', change: 'no change', before, tone: 'neutral' };
  const direction: ChangeDirection = change.delta > 0 ? 'up' : 'down';
  const tone = change.key === 'debt' || change.upIsGood === null ? 'neutral' : (direction === 'up') === change.upIsGood ? 'good' : 'bad';
  return { key: change.key, label: change.label, value, direction, change: `${direction} ${size}`, before, tone };
}

function tileChange(b: Briefing, key: GlanceKey): TileChange | null {
  if (!b.previous) return null;
  const change = b.changes.find((c) => c.key === key);
  if (!change) return null;
  const row = changeRow(change);
  if (row.direction === null) return null;
  return { direction: row.direction, text: row.change, before: row.before, tone: row.tone };
}

/** The debt tile's tone: none in good health, amber (watch, warning) or red (higher interest, no more borrowing, loans called). Never success green. */
export function debtTone(b: Pick<Briefing, 'headline' | 'forward'>): 'warn' | 'danger' | null {
  const health = briefingHealth(b);
  return health.tone === 'ok' ? null : health.tone;
}

function glanceTiles(b: Briefing): GlanceTile[] {
  const h = b.headline;
  const quarter = b.span > 1;
  const health = briefingHealth(b);
  const debtDetail = h.debt <= 0 && h.stage === 'compliant' ? 'No loans' : health.text;
  const tiles: Omit<GlanceTile, 'change'>[] = [
    { key: 'net', label: quarter ? 'Net this quarter' : 'Net this month', value: formatSignedMoney(h.net), detail: null, tone: h.net < 0 ? 'negative' : null },
    { key: 'cash', label: 'Cash', value: formatMoney(h.cash), detail: null, tone: h.cash < 0 ? 'negative' : null },
    {
      key: 'subscribers',
      label: 'Customers',
      value: h.subscribers === null ? '–' : formatNumber(h.subscribers),
      detail: quarter ? null : subscriberMovements(b.report),
      tone: null,
    },
    { key: 'passings', label: 'Homes passed', value: formatNumber(h.passings), detail: null, tone: null },
    { key: 'takeRate', label: 'Take rate', value: h.takeRate === null ? '–' : formatPercent(h.takeRate), detail: 'Homes passed that buy from you', tone: null },
    { key: 'cpp', label: 'Cost per home passed', value: formatMaybeMoney(h.cpp), detail: cppTargetText(h.cppBand, h.cppTarget), tone: h.cppBand },
    { key: 'debt', label: 'Debt', value: formatMoney(h.debt), detail: debtDetail, tone: debtTone(b) },
  ];
  return tiles.map((tile) => ({ ...tile, change: tileChange(b, tile.key) }));
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
      detail: f.nextPayment > 0 ? `due ${close}: interest and payback, estimated` : null,
      tone: null,
    },
    {
      key: 'projectedCash',
      label: 'Cash expected at that close',
      value: formatMoney(f.projectedCash),
      detail:
        f.sweep > 0
          ? `after the loan payment and the spare cash the bank takes (about ${formatMoney(f.sweep)})`
          : f.nextPayment > 0
            ? 'after the loan payment'
            : 'at today’s pace',
      tone: f.projectedCash < 0 ? 'negative' : null,
    },
    {
      key: 'runway',
      label: 'Cash lasts',
      value: f.runwayMonths === null ? 'Not falling' : runwayPhrase(f.runwayMonths),
      detail: f.runwayMonths === null ? null : 'at what running the business costs each month',
      tone: f.runwayMonths === null ? null : f.runwayMonths <= 2 ? 'danger' : f.runwayMonths <= 6 ? 'warn' : null,
    },
  ];
  if (f.closesUntilCalled !== null) {
    rows.push({
      key: 'called',
      label: 'The bank asks for every loan back',
      value: f.closesUntilCalled <= 0 ? 'at the next close' : `in ${plural(f.closesUntilCalled, 'close')}`,
      detail: 'if you still can’t borrow by then',
      tone: f.closesUntilCalled <= 2 ? 'danger' : 'warn',
    });
  }
  if (f.accelerationClosesLeft !== null) {
    rows.push({
      key: 'acceleration',
      label: 'Loans called',
      value: `everything due within ${plural(f.accelerationClosesLeft, 'close')}`,
      detail: 'a close that cannot pay ends the game',
      tone: 'danger',
    });
  }
  return rows;
}

/** The full books (spec G.8): everything the first view leaves out, one tap away. Pure. */
export function booksView(b: Briefing): BooksView {
  const quarter = b.span > 1;
  const tileKeys = new Set<string>(GLANCE_KEYS);
  const notices = noticeRows(b.notices);
  return {
    tiles: glanceTiles(b),
    changes: b.previous ? b.changes.filter((c) => !tileKeys.has(c.key)).map(changeRow) : [],
    comparedWith: b.previous ? (quarter ? 'the quarter before' : formatMonthLong(b.previous.year, b.previous.month).split(' ')[0]!) : null,
    moneyIn: orderLines(b.money.inLines.filter((l) => l.amount !== 0)),
    moneyOut: moneyGroups(b),
    inTotal: formatMoney(b.money.in),
    outTotal: formatMoney(b.money.out),
    net: formatSignedMoney(b.money.cashChange),
    netNegative: b.money.cashChange < 0,
    notices,
    noticeCount: b.notices.length,
    forward: forwardRows(b),
    moreTitle: `More figures for ${formatMonthLong(b.report.year, b.report.month)}`,
    more: reportRows(b.report).filter((row) => !row.quiet),
  };
}

/** Everything the summary shows, in words. Pure. */
export interface SummaryView {
  /** "March 2028 briefing" / "Jan–Mar 2028 briefing" (the dialog's accessible name). */
  title: string;
  /** "March 2028 · Otter Junction Fiber" (set in capitals). */
  kicker: string;
  period: PeriodWord;
  headline: SummaryHeadline;
  bars: ReturnType<typeof moneyBars>;
  groups: MoneyGroupView[];
  cash: CashCardView;
  customers: Words | null;
  attention: AttentionLine[];
  steps: NextStepView;
  books: BooksView;
  needsAttention: boolean;
}

/** The whole summary for a briefing; `companyName` leads the header. Pure. */
export function summaryView(b: Briefing, companyName = ''): SummaryView {
  return {
    title: briefingTitle(b),
    kicker: summaryKicker(b, companyName),
    period: periodOf(b),
    headline: summaryHeadline(b),
    bars: moneyBars(b),
    groups: moneyGroups(b),
    cash: cashCard(b),
    customers: customersLine(b),
    attention: b.attention.map(attentionLine),
    steps: nextStep(b),
    books: booksView(b),
    needsAttention: b.needsAttention,
  };
}

/** Every string the first view shows (headline to footer, the group lines left closed and the more tips excepted), for the no-jargon check. */
export function firstViewText(view: SummaryView): string[] {
  const out: string[] = [view.kicker, view.headline.text];
  if (view.headline.health) out.push(view.headline.health.text);
  for (const bar of [view.bars.in, view.bars.out]) {
    out.push(bar.value, bar.description);
    if (bar.empty) out.push(bar.empty);
    for (const s of bar.segments) out.push(s.label, s.value);
  }
  for (const g of view.groups) out.push(g.label, g.value, g.sub, ...(g.note ? [g.note] : []));
  out.push(view.cash.headline, view.cash.left, ...view.cash.lines.map(wordsText));
  if (view.customers) out.push(wordsText(view.customers));
  for (const a of view.attention) out.push(a.text, a.button);
  const { next, tipsLabel, snoozedText, empty } = view.steps;
  if (next) out.push(next.title, next.why, next.actionLabel);
  for (const t of [tipsLabel, snoozedText, empty]) if (t) out.push(t);
  return out;
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
  /** A Show me / Open the Bank / See customers button: the sheet has closed; do the action (the game stays paused). */
  onAction(action: AdviceAction): void;
  /** The frequency could not be stored (blocked storage): it lasts for this page only. */
  onStoreFailed?(): void;
  /**
   * Send a command through the session (snoozeAdvice for Not now,
   * noteAdviceShown once per close-time briefing); the sheet never touches
   * the game state itself. main.ts wires session.dispatch.
   */
  dispatch?(cmd: Command): CommandResult;
  /** The briefing rebuilt from today's state for `span` months (after a snooze), or null. main.ts wires advisor.buildBriefing. */
  rebuild?(span: number): Briefing | null;
}

/**
 * Whether `briefing` is the close-time one: built (advisor.briefingBuiltOn)
 * on its report's close day (advisor.closeDayOf). The menu's "Latest
 * briefing" later in the month is built on a later day; a copy of a briefing
 * (not built by buildBriefing) is never close-time.
 */
export function isCloseTimeBriefing(briefing: Briefing): boolean {
  const day = briefingBuiltOn(briefing);
  return day !== null && day === closeDayOf(briefing.report);
}

/** How the open sheet closes: Continue (resume), an action, or quietly (a game replaced). */
type Exit = { kind: 'continue' } | { kind: 'action'; action: AdviceAction } | { kind: 'quiet' };

/** Which view the sheet shows: the summary (first view) or the full books. */
export type BriefingMode = 'summary' | 'books';

const TONE_ICON: Readonly<Record<ToastTone, string>> = { ok: ICONS.spark, warn: ICONS.warning, err: ICONS.close };
const ARROW: Readonly<Record<ChangeDirection, string>> = { up: '▲', down: '▼', flat: '•' };
const ATTENTION_ICON: Readonly<Record<AttentionItem['kind'], string>> = {
  bankStage: ICONS.bank,
  bankWatch: ICONS.bank,
  loansCalled: ICONS.bank,
  outage: ICONS.storm,
  storm: ICONS.storm,
  cabinetFull: ICONS.cabinet,
};

/** Ids for each render's headings and controls, unique on the page. */
let renders = 0;

/** Sentence parts as DOM (bold parts in <b>). */
function wordsNodes(words: Words): Node[] {
  return words.map((w) => (w.strong ? el('b', { text: w.text }) : document.createTextNode(w.text)));
}

function percent(share: number): string {
  return `${Math.max(0, Math.min(100, share * 100)).toFixed(2)}%`;
}

export class BriefingSheet {
  /** The sheet on screen and how it is closing (its close event comes later, so each sheet keeps its own). */
  private current: { sheet: Sheet; exit: Exit } | null = null;
  private shown: Briefing | null = null;
  /** The company name the open briefing's header leads with (kept for a re-render after a snooze). */
  private companyName = '';
  private renderId = 0;
  private modeNow: BriefingMode = 'summary';
  private booksOnlyNow = false;
  /** Reports whose close-time briefing recorded its suggestions (noteAdviceShown): never twice. */
  private readonly noted = new WeakSet<MonthlyReport>();
  private nextSection: HTMLElement | null = null;
  /** Watches the money-in bar's inside label: when it no longer fits its segment, the legend names the segment instead. */
  private labelFit: ResizeObserver | null = null;

  constructor(private readonly deps: BriefingSheetDeps) {}

  /** The <dialog> is open (false as soon as it starts closing). */
  get isOpen(): boolean {
    return this.current?.sheet.dialog.open ?? false;
  }

  /** The briefing on screen, or null. */
  get briefing(): Briefing | null {
    return this.isOpen ? this.shown : null;
  }

  /** The view on screen: the summary or the full books. */
  get mode(): BriefingMode {
    return this.modeNow;
  }

  /**
   * The open sheet shows the full books on their own (the report panel's "See
   * the full books"), not a month-end briefing: false while a briefing or
   * nothing is open.
   */
  get booksOnly(): boolean {
    return this.isOpen && this.booksOnlyNow;
  }

  /**
   * Show a briefing (the caller has paused the game); `companyName` leads the
   * header. Over one already open (a later close while it shows, or the books
   * the report panel opened), the content is replaced in place, back on the
   * summary. A close-time briefing (isCloseTimeBriefing) records the
   * suggestions it shows (noteAdviceShown) once per report; the menu's
   * reopened one does not.
   */
  open(briefing: Briefing, companyName: string): void {
    this.show(briefing, companyName, false);
    this.noteShown(briefing);
  }

  /**
   * The report panel's "See the full books": the books view of `briefing`
   * (its latest report's month) opened directly (the caller has paused the
   * game). It is not a month-end briefing: it records nothing (no
   * noteAdviceShown), has no summary to go back to, and Close (or Esc, or the
   * backdrop) returns to the game through deps.onContinue. Ignored while a
   * sheet is already open.
   */
  openBooks(briefing: Briefing, companyName: string): void {
    if (this.isOpen) return;
    this.show(briefing, companyName, true);
  }

  private show(briefing: Briefing, companyName: string, booksOnly: boolean): void {
    const view = summaryView(briefing, companyName);
    const title = booksOnly ? booksTitle(briefing) : view.title;
    this.shown = briefing;
    this.companyName = companyName;
    this.modeNow = booksOnly ? 'books' : 'summary';
    this.booksOnlyNow = booksOnly;
    let entry = this.current;
    if (!entry || !entry.sheet.dialog.open) {
      const created: { sheet: Sheet | null; exit: Exit } = { sheet: null, exit: { kind: 'continue' } };
      const sheet = openSheet({
        title,
        subtitle: view.headline.text,
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
    }
    entry.sheet.dialog.classList.toggle('briefing-books-only', booksOnly);
    this.header(entry.sheet, view, title);
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

  /** Record the suggestions a close-time briefing shows, once per report. */
  private noteShown(briefing: Briefing): void {
    if (!this.deps.dispatch || this.noted.has(briefing.report) || !isCloseTimeBriefing(briefing)) return;
    this.noted.add(briefing.report);
    this.deps.dispatch({ type: 'noteAdviceShown', keys: briefing.advice.map((a) => a.key) });
  }

  /**
   * The header: the dialog's name (`name`: briefingTitle, or booksTitle for
   * the books on their own; kept for screen readers and the tests, shown only
   * to them), the period and company over the headline, and the bank's
   * health under it when the bank leads.
   */
  private header(sheet: Sheet, view: SummaryView, name: string): void {
    const heading = sheet.dialog.querySelector('.sheet-heading');
    const title = sheet.dialog.querySelector('.sheet-title');
    const subtitle = sheet.dialog.querySelector<HTMLElement>('.sheet-subtitle');
    if (!heading || !title || !subtitle) return;
    setTextOf(title, name);
    let kicker = heading.querySelector<HTMLElement>('.briefing-kicker');
    if (!kicker) {
      kicker = el('p', { class: 'briefing-kicker' });
      title.after(kicker);
    }
    setTextOf(kicker, view.kicker);
    const { headline } = view;
    subtitle.className = `sheet-subtitle briefing-headline${headline.tone ? ` tone-${headline.tone}` : ''}`;
    subtitle.replaceChildren(
      ...(headline.tone ? [icon(ICONS.warning, 'icon briefing-headline-icon')] : []),
      el('span', { text: headline.text }),
    );
    heading.querySelector('.briefing-health')?.remove();
    if (headline.health) {
      const h = headline.health;
      subtitle.after(
        el('p', { class: `briefing-health health-${h.tone}` }, [icon(h.tone === 'ok' ? ICONS.spark : ICONS.warning, 'icon briefing-health-icon'), el('span', { text: h.text })]),
      );
    }
    sheet.dialog.classList.toggle('briefing-attention', view.needsAttention);
  }

  /** Fill the body and the footer for the current mode; focus Continue (or, back from the books, the button that opened them; in the books, their heading). */
  private render(sheet: Sheet, view: SummaryView, backFromBooks = false): void {
    this.renderId = ++renders;
    const { body, actions } = sheet;
    sheet.dialog.dataset.mode = this.modeNow;
    const go = el('button', {
      class: 'btn sheet-primary briefing-continue',
      text: 'Continue',
      attrs: { type: 'button' },
      on: { click: () => this.finish({ kind: 'continue' }) },
    });
    if (this.modeNow === 'summary') {
      this.nextSection = this.next(view);
      body.replaceChildren(
        this.moneyIn(view),
        this.moneyOut(view),
        this.cash(view),
        ...(view.customers ? [this.customers(view.customers)] : []),
        ...(view.attention.length > 0 ? [this.attention(view)] : []),
        this.nextSection,
      );
      const books = el('button', {
        class: 'btn sheet-secondary briefing-books-open',
        text: 'See the full books',
        attrs: { type: 'button' },
        on: { click: () => this.switchTo('books') },
      });
      actions.replaceChildren(books, go);
      body.scrollTop = 0;
      if (backFromBooks) books.focus({ preventScroll: true });
      else go.focus({ preventScroll: true });
    } else {
      this.nextSection = null;
      const section = this.books(view);
      body.replaceChildren(section);
      if (this.booksOnlyNow) {
        // Opened on their own from the report panel: no summary to go back to; Close returns to the game.
        actions.replaceChildren(
          el('button', {
            class: 'btn sheet-primary briefing-continue briefing-close',
            text: 'Close',
            attrs: { type: 'button' },
            on: { click: () => this.finish({ kind: 'continue' }) },
          }),
        );
      } else {
        const back = el('button', {
          class: 'btn sheet-secondary briefing-back',
          text: 'Back',
          attrs: { type: 'button', 'aria-label': 'Back to the summary' },
          on: { click: () => this.switchTo('summary') },
        });
        actions.replaceChildren(back, go);
      }
      body.scrollTop = 0;
      section.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
    }
  }

  /** See the full books / Back: the other view, from the briefing on screen. */
  private switchTo(mode: BriefingMode): void {
    const entry = this.current;
    const shown = this.shown;
    if (!entry || !shown || !entry.sheet.dialog.open) return;
    this.modeNow = mode;
    this.render(entry.sheet, summaryView(shown, this.companyName), mode === 'summary');
  }

  private id(name: string): string {
    return `briefing-${name}-${this.renderId}`;
  }

  private bar(bar: MoneyBar, kind: 'in' | 'out'): HTMLElement {
    const track = el('div', { class: `briefing-bar briefing-bar-${kind}`, attrs: { role: 'img', 'aria-label': bar.description } });
    for (const segment of bar.segments) {
      const seg = el('span', { class: `briefing-seg seg-${segment.key}`, attrs: { 'data-key': segment.key } }, [
        segment.inside ? el('span', { class: 'briefing-seg-label', text: segment.label }) : null,
      ]);
      seg.style.width = percent(segment.share);
      track.append(seg);
    }
    return track;
  }

  /** A bar's heading and total (money in that includes borrowing is never success green: debt is not earnings). */
  private moneyHead(id: string, label: string, value: string, kind: 'in' | 'out', borrowed = false): HTMLElement {
    return el('div', { class: 'briefing-money-head' }, [
      el('h3', { class: 'briefing-money-title', text: label, attrs: { id } }),
      el('span', { class: `num briefing-money-total total-${kind}${borrowed ? ' total-borrowed' : ''}`, text: value }),
    ]);
  }

  private moneyIn(view: SummaryView): HTMLElement {
    const id = this.id('in');
    const bar = view.bars.in;
    const track = bar.empty ? null : this.bar(bar, 'in');
    const label = track?.querySelector<HTMLElement>('.briefing-seg-label') ?? null;
    // The legend, or (when the view puts the label inside its segment) a hidden
    // fallback legend that takes over whenever that label would be cut short.
    const legend =
      view.bars.inLegend || label
        ? el(
            'ul',
            { class: 'briefing-in-legend' },
            bar.segments.map((s) =>
              el('li', { attrs: { 'data-key': s.key } }, [
                el('span', { class: `briefing-swatch seg-${s.key}`, attrs: { 'aria-hidden': 'true' } }),
                el('span', { text: s.label }),
                el('span', { class: 'num', text: s.value }),
              ]),
            ),
          )
        : null;
    this.labelFit?.disconnect();
    this.labelFit = null;
    if (label && legend && !view.bars.inLegend) {
      legend.hidden = true;
      this.fitLabel(label, legend);
    }
    return el('section', { class: 'briefing-money briefing-money-in', attrs: { 'aria-labelledby': id } }, [
      this.moneyHead(id, 'Money in', bar.value, 'in', bar.segments.some((seg) => seg.key === 'borrowed')),
      bar.empty ? el('p', { class: 'briefing-empty', text: bar.empty }) : track,
      legend,
    ]);
  }

  /**
   * Text is never clipped: the inside label shows only while its segment is
   * wide enough for it (a phone's 25-39% segment is not); otherwise it hides
   * and the legend under the bar names the segment. Measured on layout and on
   * every resize (a phone turning), from the label's own width.
   */
  private fitLabel(label: HTMLElement, legend: HTMLElement): void {
    const fit = () => {
      if (!label.isConnected) return;
      label.hidden = false;
      const clipped = label.scrollWidth > label.clientWidth + 0.5;
      label.hidden = clipped;
      legend.hidden = !clipped;
    };
    if (typeof ResizeObserver === 'undefined') {
      requestAnimationFrame(fit);
      return;
    }
    const segment = label.parentElement;
    this.labelFit = new ResizeObserver(fit);
    this.labelFit.observe(segment ?? label);
  }

  private moneyOut(view: SummaryView): HTMLElement {
    const id = this.id('out');
    const bar = view.bars.out;
    return el('section', { class: 'briefing-money briefing-money-out', attrs: { 'aria-labelledby': id } }, [
      this.moneyHead(id, 'Money out', bar.value, 'out'),
      bar.empty ? el('p', { class: 'briefing-empty', text: bar.empty }) : this.bar(bar, 'out'),
      el(
        'ul',
        { class: 'briefing-legend' },
        view.groups.map((group) => {
          const linesId = this.id(`lines-${group.key}`);
          const lines = el(
            'dl',
            { class: 'briefing-group-lines', attrs: { id: linesId, hidden: '' } },
            group.lines.map((line) =>
              el('div', { class: 'briefing-line', attrs: { 'data-key': line.key } }, [
                el('dt', { text: line.label }),
                el('dd', { class: 'num', text: line.value }),
              ]),
            ),
          );
          const button = el(
            'button',
            {
              class: 'briefing-group',
              attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': linesId, 'data-key': group.key },
              on: {
                click: () => {
                  const open = button.getAttribute('aria-expanded') !== 'true';
                  button.setAttribute('aria-expanded', String(open));
                  lines.hidden = !open;
                },
              },
            },
            [
              el('span', { class: 'briefing-group-name' }, [
                el('span', { class: `briefing-swatch seg-${group.key}`, attrs: { 'aria-hidden': 'true' } }),
                el('span', { text: group.label }),
                el('span', { class: 'briefing-chevron', attrs: { 'aria-hidden': 'true' } }),
              ]),
              el('span', { class: 'num briefing-group-total', text: group.value }),
              el('span', { class: 'briefing-group-sub', text: group.sub }),
              group.note ? el('span', { class: 'briefing-group-note', text: group.note }) : null,
            ],
          );
          if (group.lines.length === 0) button.disabled = true;
          return el('li', { class: `briefing-group-item group-${group.key}` }, [button, lines]);
        }),
      ),
    ]);
  }

  private cash(view: SummaryView): HTMLElement {
    const id = this.id('cash');
    const c = view.cash;
    return el('section', { class: `briefing-cash cash-${c.direction}`, attrs: { 'aria-labelledby': id } }, [
      el('div', { class: 'briefing-cash-head' }, [
        el('h3', { class: 'briefing-cash-title', text: c.headline, attrs: { id } }),
        el('span', { class: 'num briefing-cash-left', text: c.left }),
      ]),
      ...c.lines.map((line) => el('p', { class: 'briefing-cash-line' }, wordsNodes(line))),
    ]);
  }

  private customers(words: Words): HTMLElement {
    return el('p', { class: 'briefing-customers' }, [
      icon(ICONS.users, 'icon briefing-customers-icon'),
      el('span', { class: 'briefing-customers-text' }, wordsNodes(words)),
      el('button', {
        class: 'btn briefing-link briefing-see-customers',
        text: 'See customers',
        attrs: { type: 'button' },
        on: { click: () => this.finish({ kind: 'action', action: SEE_CUSTOMERS }) },
      }),
    ]);
  }

  private attention(view: SummaryView): HTMLElement {
    const id = this.id('attention');
    return el('section', { class: 'briefing-attention-list', attrs: { 'aria-labelledby': id } }, [
      el('h3', { text: 'Needs attention', attrs: { id } }),
      el(
        'ul',
        {},
        view.attention.map((line) =>
          el('li', { class: `briefing-alert alert-${line.tone}`, attrs: { 'data-kind': line.kind } }, [
            icon(ATTENTION_ICON[line.kind], 'icon briefing-alert-icon'),
            el('span', { class: 'briefing-alert-text', text: line.text }),
            el('button', {
              class: 'btn sheet-secondary briefing-alert-action',
              text: line.button,
              attrs: { type: 'button', ...(line.button === 'Show me' ? { 'aria-label': `Show me: ${line.text}` } : {}) },
              on: { click: () => this.finish({ kind: 'action', action: line.action }) },
            }),
          ]),
        ),
      ),
    ]);
  }

  private stepActions(card: StepCard, onSnooze: (() => void) | null): HTMLElement {
    return el('div', { class: 'briefing-card-actions' }, [
      el('button', {
        class: 'btn briefing-show',
        text: card.actionLabel,
        attrs: { type: 'button', 'aria-label': `${card.actionLabel}: ${card.title}` },
        on: { click: () => this.finish({ kind: 'action', action: card.action }) },
      }),
      onSnooze
        ? el('button', {
            class: 'btn briefing-snooze',
            text: 'Not now',
            attrs: { type: 'button', 'aria-label': `Not now: ${card.title}`, title: card.snoozeHint },
            on: { click: onSnooze },
          })
        : null,
    ]);
  }

  /** "Your next step" and the more tips (Not now snoozes through deps.dispatch, then this section re-renders in place). */
  private next(view: SummaryView, tipsOpen = false): HTMLElement {
    const id = this.id('next');
    const { next, tips, tipsLabel, snoozedText, empty } = view.steps;
    const canSnooze = this.deps.dispatch !== undefined && this.deps.rebuild !== undefined;
    const children: (Node | null)[] = [];
    if (next) {
      children.push(
        el('div', { class: `briefing-card briefing-card-main severity-${next.severity}`, attrs: { 'data-key': next.key } }, [
          el('div', { class: 'briefing-card-text' }, [
            el('h3', { class: 'briefing-step-label', text: 'Your next step', attrs: { id, tabindex: '-1' } }),
            el('h4', { class: 'briefing-card-title', text: next.title }),
            el('p', { class: 'briefing-card-why', text: next.why }),
            next.detail
              ? el('details', { class: 'briefing-card-detail' }, [el('summary', { text: 'More about this' }), el('p', { text: next.detail })])
              : null,
          ]),
          this.stepActions(next, canSnooze ? () => this.snooze(next.key, 'main', 0) : null),
        ]),
      );
    } else {
      children.push(el('h3', { class: 'briefing-step-label', text: 'Your next step', attrs: { id, tabindex: '-1' } }), el('p', { class: 'briefing-empty', text: empty ?? '' }));
    }
    if (tipsLabel) {
      const details = el('details', { class: 'briefing-tips' }, [
        el('summary', { class: 'briefing-tips-summary', text: tipsLabel }),
        el(
          'ol',
          { class: 'briefing-tip-list' },
          tips.map((card, index) =>
            el('li', { class: `briefing-card briefing-card-tip severity-${card.severity}`, attrs: { 'data-key': card.key } }, [
              el('div', { class: 'briefing-card-text' }, [
                el('h4', { class: 'briefing-card-title', text: card.title }),
                el('p', { class: 'briefing-card-why', text: card.why }),
                card.detail
                  ? el('details', { class: 'briefing-card-detail' }, [el('summary', { text: 'More about this' }), el('p', { text: card.detail })])
                  : null,
              ]),
              this.stepActions(card, canSnooze ? () => this.snooze(card.key, 'tip', index) : null),
            ]),
          ),
        ),
      ]);
      details.open = tipsOpen;
      children.push(details);
    }
    if (snoozedText) children.push(el('p', { class: 'briefing-snoozed', text: snoozedText }));
    return el('section', { class: 'briefing-next', attrs: { 'aria-labelledby': id } }, children);
  }

  /** Not now: the command, then "Your next step" re-rendered in place from a rebuilt briefing, focus kept nearby. */
  private snooze(key: string, where: 'main' | 'tip', index: number): void {
    const entry = this.current;
    const shown = this.shown;
    if (!entry || !shown || !this.deps.dispatch) return;
    this.deps.dispatch({ type: 'snoozeAdvice', key });
    const fresh = this.deps.rebuild?.(shown.span) ?? null;
    if (!fresh) return;
    this.shown = fresh;
    const view = summaryView(fresh, this.companyName);
    entry.sheet.dialog.classList.toggle('briefing-attention', view.needsAttention);
    const wasOpen = this.nextSection?.querySelector<HTMLDetailsElement>('.briefing-tips')?.open ?? false;
    const section = this.next(view, where === 'tip' && wasOpen);
    this.nextSection?.replaceWith(section);
    this.nextSection = section;
    let target: HTMLElement | null = null;
    if (where === 'tip') {
      const tips = section.querySelectorAll<HTMLElement>('.briefing-card-tip');
      target = tips[Math.min(index, tips.length - 1)]?.querySelector<HTMLElement>('.briefing-show') ?? section.querySelector<HTMLElement>('.briefing-tips-summary');
    }
    target ??= section.querySelector<HTMLElement>('.briefing-card-main .briefing-show') ?? section.querySelector<HTMLElement>('h3');
    target?.focus({ preventScroll: false });
  }

  // --- The full books -------------------------------------------------------

  private books(view: SummaryView): HTMLElement {
    const id = this.id('books');
    const books = view.books;
    const quarter = view.period === 'quarter';
    return el('section', { class: 'briefing-books', attrs: { 'aria-labelledby': id } }, [
      el('div', { class: 'briefing-books-head' }, [
        el('h3', { text: 'The full books', attrs: { id, tabindex: '-1' } }),
        books.comparedWith ? el('span', { class: 'briefing-vs', text: `▲▼ against ${books.comparedWith}` }) : null,
      ]),
      this.frequency(),
      this.tiles(books),
      this.booksMoney(books, quarter),
      this.more(books),
      this.notices(books, quarter),
      this.forward(books),
    ]);
  }

  /** The rest of the latest report's figures (panel.reportRows), each with its plain explanation as a tooltip. */
  private more(books: BooksView): HTMLElement {
    if (books.more.length === 0) return this.part('more', books.moreTitle, [el('p', { class: 'briefing-empty', text: 'Nothing more to report.' })]);
    return this.part('more', books.moreTitle, [
      el(
        'dl',
        { class: 'briefing-figures' },
        books.more.map((row) =>
          el('div', { class: 'briefing-figure', attrs: { 'data-key': row.key, title: row.hint } }, [
            el('dt', {}, [el('span', { text: row.label }), row.detail ? el('small', { text: row.detail }) : null]),
            el('dd', { class: `num${row.tone === 'negative' ? ' tone-negative' : row.tone === 'breach' ? ' tone-danger' : ''}`, text: row.value }),
          ]),
        ),
      ),
    ]);
  }

  /** How often it shows, a compact select (kept in this browser). */
  private frequency(): HTMLElement {
    const id = this.id('frequency');
    const select = el(
      'select',
      { class: 'field briefing-frequency-select', attrs: { id, title: 'Kept in this browser. Reopen the latest briefing from the menu.' } },
      BRIEFING_FREQUENCIES.map((frequency) => el('option', { text: FREQUENCY_LABEL[frequency], attrs: { value: frequency } })),
    );
    select.value = this.deps.preference.frequency;
    select.addEventListener('change', () => {
      const value = select.value;
      if (!isBriefingFrequency(value)) return;
      if (!this.deps.preference.choose(value)) this.deps.onStoreFailed?.();
    });
    return el('div', { class: 'briefing-frequency' }, [el('label', { text: 'Show this briefing', attrs: { for: id } }), select]);
  }

  private tiles(books: BooksView): HTMLElement {
    return el(
      'dl',
      { class: 'briefing-tiles' },
      books.tiles.map((tile) =>
        el('div', { class: `briefing-tile briefing-tile-${tile.key}`, attrs: { 'data-key': tile.key } }, [
          el('dt', { text: tile.label }),
          el('dd', {}, [
            el('span', { class: `num briefing-tile-value${tile.tone ? ` tone-${tile.tone}` : ''}`, text: tile.value }),
            tile.change
              ? el('small', { class: `briefing-tile-change change-${tile.change.tone}`, attrs: tile.change.before ? { title: tile.change.before } : {} }, [
                  tile.change.direction ? el('span', { class: 'briefing-arrow', text: ARROW[tile.change.direction], attrs: { 'aria-hidden': 'true' } }) : null,
                  el('span', { text: tile.change.text }),
                  tile.change.before ? el('span', { class: 'visually-hidden', text: ` (${tile.change.before})` }) : null,
                ])
              : null,
            tile.detail
              ? el('small', { class: 'briefing-tile-detail' }, [
                  tile.key === 'cpp' && tile.tone ? el('span', { class: `band-swatch cpp-bg-${tile.tone}`, attrs: { 'aria-hidden': 'true' } }) : null,
                  el('span', { text: tile.detail }),
                ])
              : null,
          ]),
        ]),
      ),
    );
  }

  private part(name: string, title: string, children: (Node | null)[]): HTMLElement {
    const id = this.id(name);
    return el('div', { class: `briefing-part briefing-part-${name}`, attrs: { role: 'group', 'aria-labelledby': id } }, [el('h4', { text: title, attrs: { id } }), ...children]);
  }

  private lineList(lines: MoneyLineView[], cls: string): HTMLElement {
    return el(
      'dl',
      { class: `briefing-lines ${cls}` },
      lines.map((line) =>
        el('div', { class: 'briefing-line', attrs: { 'data-key': line.key } }, [
          el('dt', { text: line.label }),
          el('dd', { class: `num${line.amount < 0 ? ' negative' : ''}`, text: line.value }),
        ]),
      ),
    );
  }

  private booksMoney(books: BooksView, quarter: boolean): HTMLElement {
    const changes =
      books.changes.length === 0
        ? null
        : el('ul', { class: 'briefing-changes', attrs: { 'aria-label': `Against ${books.comparedWith ?? 'last time'}` } }, [
            ...books.changes.map((row) =>
              el('li', { class: `briefing-change change-${row.tone}`, attrs: { 'data-key': row.key } }, [
                el('span', { class: 'briefing-change-label', text: row.label }),
                el('span', { class: 'num briefing-change-value', text: row.value }),
                el('span', { class: 'briefing-change-delta', attrs: row.before ? { title: row.before } : {} }, [
                  row.direction ? el('span', { class: 'briefing-arrow', text: ARROW[row.direction], attrs: { 'aria-hidden': 'true' } }) : null,
                  el('span', { text: row.change }),
                  row.before ? el('span', { class: 'visually-hidden', text: ` (${row.before})` }) : null,
                ]),
              ]),
            ),
          ]);
    return this.part('money', quarter ? 'Money in and out this quarter' : 'Money in and out', [
      changes,
      el('p', { class: 'briefing-subtotal' }, [el('span', { text: 'Money in' }), el('span', { class: 'num', text: books.inTotal })]),
      books.moneyIn.length > 0 ? this.lineList(books.moneyIn, 'briefing-lines-in') : el('p', { class: 'briefing-empty', text: 'Nothing came in.' }),
      el('p', { class: 'briefing-subtotal' }, [el('span', { text: 'Money out' }), el('span', { class: 'num', text: books.outTotal })]),
      ...books.moneyOut.map((group) =>
        el('div', { class: `briefing-books-group group-${group.key}`, attrs: { 'data-key': group.key } }, [
          el('p', { class: 'briefing-books-group-head' }, [el('span', { text: group.label }), el('span', { class: 'num', text: group.value })]),
          group.lines.length > 0 ? this.lineList(group.lines, 'briefing-lines-out') : null,
        ]),
      ),
      el('p', { class: 'briefing-money-net' }, [
        el('span', { text: 'Cash change' }),
        el('span', { class: `num${books.netNegative ? ' negative' : ''}`, text: books.net }),
      ]),
    ]);
  }

  private notices(books: BooksView, quarter: boolean): HTMLElement {
    const title = `${quarter ? 'This quarter’s notices' : 'This month’s notices'} (${formatNumber(books.noticeCount)})`;
    if (books.notices.length === 0) return this.part('notices', title, [el('p', { class: 'briefing-empty', text: `No notices this ${quarter ? 'quarter' : 'month'}.` })]);
    return this.part('notices', title, [
      el(
        'ul',
        { class: 'briefing-notices' },
        books.notices.map((row) =>
          el('li', { class: `briefing-notice notice-${row.tone}` }, [
            icon(TONE_ICON[row.tone], 'icon briefing-notice-icon'),
            el('span', { class: 'visually-hidden', text: `${row.toneLabel}: ` }),
            el('span', { class: 'briefing-notice-when', text: row.when }),
            el('span', { class: 'briefing-notice-text', text: row.count > 1 ? `${row.text} (${plural(row.count, 'time')})` : row.text }),
          ]),
        ),
      ),
    ]);
  }

  private forward(books: BooksView): HTMLElement {
    return this.part('forward', 'Looking ahead', [
      el(
        'dl',
        { class: 'briefing-forward' },
        books.forward.map((row) =>
          el('div', { class: 'briefing-forward-row', attrs: { 'data-key': row.key } }, [
            el('dt', {}, [el('span', { text: row.label }), row.detail ? el('small', { text: row.detail }) : null]),
            el('dd', { class: `num${row.tone ? ` tone-${row.tone}` : ''}`, text: row.value }),
          ]),
        ),
      ),
    ]);
  }
}

function setTextOf(node: Element | null, text: string): void {
  if (node && node.textContent !== text) node.textContent = text;
}
