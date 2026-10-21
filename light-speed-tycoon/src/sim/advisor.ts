// The month-end briefing and the advisor (round 4): everything pertinent
// about the period that just closed, and 1-3 ranked suggestions, each with a
// plain-language reason built from the game's figures and an action the UI
// can perform ("Show me": move the camera to a cabinet or street, or open the
// Pricing, Bank or OLT panel).
//
// Owner: sim-advisor workstream. The contract implemented buildBriefing (the
// headline, what changed, the period's notices, the ledger breakdown and the
// forward look) and the advice ranking frame; sim-advisor implements the
// rules (one per AdviceId in types.ts). The UI (ui-briefing) only renders
// what is here.
//
// Rules for every rule:
// - Pure and deterministic: reads state through public sim functions,
//   never writes it, no randomness; ties broken by ADVICE_ORDER.
// - Never advice that backfires: a cure is verified pro forma
//   (debt.cureOptions), a draw or loan suggestion is covenant-safe and keeps
//   a cash cushion (debt.fundingHint, debt.maxSafeTermLoan), a purchase is
//   only suggested when cash (or such financing) covers it and the cushion,
//   an "expand" suggestion only when cash or safe borrowing covers the build
//   and a reserve. Each rule's suggested commands are in its AdvicePlan
//   (advicePlans), so tests apply them to a copy and check exactly that.
// - Suggestions shown together never stack into a backfire: rules run in
//   ADVICE_ORDER and each plan claims what it spends and whether it borrows
//   (Claims); a later rule counts the earlier spend in its own cash check,
//   suggests no financing once an earlier one borrowed (borrowing is
//   verified one suggestion at a time) or once covenantCure has said not to
//   borrow (a covenant breached or near its limit), and sizes its financing
//   to cover the earlier spend too. The one borrowing that can come before
//   that warning is paymentShort's (the payment the next close must make,
//   covenant-safe), and the warning then says to borrow nothing beyond it.
//   So doing every suggestion of one advise() call stays covenant-safe and
//   keeps the cushion.
// - Each fires at most once per call, with priority in its severity's band
//   (urgent 300-399, important 200-299, tip 100-199): ADVICE_PRIORITY.
// - `why` quotes the figures (dollars via finance.formatMoney, rates and
//   multiples via debt.formatRateBps / formatMultiple, places via
//   streets.cornerName / street names).
//
// Cost: advise() runs at every close (the briefing), so the heavy reads are
// bounded: expand previews at most EXPAND_CANDIDATES_MAX corners
// (coverage.coveragePreview), stormUnderground tests at most
// STORM_CANDIDATES_MAX spans and outages at most OUTAGE_CANDIDATES_MAX spans
// (a coverage run each); the rest are a pass over accounts or parcels, or
// the debt reads' few bisections. Shared reads are taken once per call.

import {
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  CONVERT_PAYBACK_YEARS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  EXPAND_RESERVE_MONTHS,
  FROZEN_SWEEP_SHARE,
  INCUMBENT_PRICE,
  LOAN_ROUNDING,
  MARKETING_PER_PASSING_GOOD,
  MAX_SPLITTERS_PER_CABINET,
  OLT_MAX_CARDS,
  OLT_PORTS_PER_CARD,
  OVERHEAD_PER_MONTH,
  SPLIT_RATIO,
  STORM_LOG_DAYS,
  STORM_REPAIRS_CONVERT_SHARE,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  TIER_DEFAULTS,
} from './balance';
import { coveragePreview } from './coverage';
import { dateOf, DAYS_PER_YEAR, dayOf, formatDate, formatMonth, MONTH_ABBR, MONTH_LENGTHS } from './calendar';
import {
  acceleratedSchedule,
  closesUntilAcceleration,
  covenantMetrics,
  cureBeatsCall,
  cureFor,
  estimateNextDebtService,
  estimateSweep,
  formatMultiple,
  formatRateBps,
  fundingHint,
  maxSafeTermLoan,
  pricingCpp,
  quoteDraw,
  quoteTermLoan,
  repayAllCommands,
  totalDebt,
} from './debt';
import { estimateCashAtClose, formatMoney, groupThousands, monthlyBurn, runwayMonths } from './finance';
import { activePromos } from './incumbent';
import { costPerPassing, cppBand, operatingCashFlow, passingsWeightedRate, reportKpis } from './metrics';
import { getService, outageImpact, outageService, ponPortsUsed, quoteConvert, quoteOltCard, quoteSplitter } from './network';
import {
  accountUnits,
  cabinetPortCapacity,
  cabinetPortsUsed,
  churnProbability,
  marketingBoost,
  segmentOffset,
  stateTakeRate,
  targetTakeRate,
  unitsByTier,
} from './sales';
import { cornerName } from './streets';
import { cutOffOf, outageChurnFor, outageSpanIds, repairCost } from './weather';
import type {
  Advice,
  AdviceAction,
  AdviceId,
  AdvicePanel,
  AdviceSeverity,
  Briefing,
  BriefingChange,
  BriefingChangeKey,
  Cabinet,
  CabinetId,
  CableSpan,
  Command,
  CovenantMetrics,
  FundingHint,
  GameState,
  LedgerCategory,
  MonthlyReport,
  Notice,
  NoticeKind,
  ParcelId,
  ParcelKind,
  Pricing,
  SegmentId,
  ServiceSnapshot,
  SpanId,
  TermYears,
} from './types';

/** Most suggestions advise() returns (and the briefing shows). */
export const ADVICE_MAX = 3;

/** AdviceId in tie-break order (the order of the AdviceId union). */
export const ADVICE_ORDER: readonly AdviceId[] = [
  'paymentShort',
  'loansCalled',
  'covenantCure',
  'frozenSweep',
  'cashRunway',
  'addSplitter',
  'addOltCard',
  'outages',
  'stormUnderground',
  'incumbentPromo',
  'takeRate',
  'pricing',
  'redCpp',
  'expand',
];

/**
 * Notice kinds that mean the player should look (the briefing's
 * needsAttention, the "only when something needs attention" setting);
 * storms and dig-ins only while plant is still out at the close, a full
 * cabinet, a full OLT or paused installs only while still so at the close
 * (noticeNeedsAttention).
 */
export const ATTENTION_NOTICE_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>([
  'cabinetFull',
  'serviceLost',
  'oltFull',
  'insolvencyWarning',
  'installsPaused',
  'paymentDue',
  'paymentMissed',
  'covenantWarning',
  'covenantPenalty',
  'creditFrozen',
  'debtSwept',
  'accelerationWarning',
  'loansCalled',
  'incumbentPromo',
  'storm',
  'digIn',
  'gameOver',
]);

/**
 * Each rule's priority (its rank), inside its severity's band: urgent
 * 300-399, important 200-299, tip 100-199. A rule with two strengths has
 * two entries.
 */
export const ADVICE_PRIORITY = {
  paymentShort: 390,
  loansCalled: 380,
  covenantCureUrgent: 350,
  cashRunwayUrgent: 330,
  frozenSweep: 280,
  covenantCureAtRisk: 260,
  addSplitterFull: 250,
  addSplitterFinanced: 240,
  cashRunway: 240,
  addOltCardNeeded: 230,
  addSplitterShort: 225,
  addSplitterNearlyFull: 220,
  redCppWithDebt: 215,
  outages: 210,
  incumbentPromo: 205,
  stormUnderground: 180,
  takeRate: 170,
  pricing: 160,
  addOltCardNearlyFull: 150,
  redCpp: 150,
  expandCash: 140,
  expandLoan: 125,
} as const;

// Rule thresholds (rules, not balance, unless marked TUNING).

/** covenantCure: a breach at today's figures is urgent when the next close is this many days away or fewer. */
export const URGENT_CLOSE_DAYS = 10;
/** covenantCure: compliant but within this share of a limit (leverage above 90% of the maximum, coverage below 110% of the minimum) is "at risk". */
export const COVENANT_RISK_MARGIN = 0.1;
/** cashRunway: runway (finance.runwayMonths) at or below this with no safe financing is urgent ... */
export const RUNWAY_URGENT_MONTHS = 2;
/** ... and at or below this is important. */
export const RUNWAY_WARN_MONTHS = 4;
/** cashRunway: financing is sized to add this many months of burn (one month when that much is not safe). */
export const RUNWAY_FUND_MONTHS = 2;
/** addSplitter / addOltCard: "nearly full" is this share of ports in use. */
export const NEARLY_FULL_SHARE = 0.9;
/** outages: at most this many outaged spans get their exact impact measured (a coverage run each), most subscribers on their own street first. */
export const OUTAGE_CANDIDATES_MAX = 6;
/** stormUnderground: storm hits within STORM_LOG_DAYS that make an aerial span storm-prone (or repairs of STORM_REPAIRS_CONVERT_SHARE, balance.ts). */
export const STORM_HITS_MIN = 2;
/** stormUnderground: at most this many storm-prone spans get the streets they feed measured (a coverage run each). */
export const STORM_CANDIDATES_MAX = 3;
/** takeRate: fires when the take rate in mature areas is below this share of their target ... */
export const TAKE_RATE_LAG_SHARE = 0.7;
/**
 * ... counting areas lit at least this many months (the signup ramp,
 * SIGNUP_RAMP_PER_DAY x (1 + marketing boost), closes only ~40% of the gap
 * to the target in 6 months at good marketing but ~80% in 18, so a younger
 * area is still ramping, not lagging) ...
 */
export const TAKE_RATE_MATURE_MONTHS = 18;
/** ... with at least this many units passed there, while marketing is below MARKETING_PER_PASSING_GOOD (balance.ts) ... */
export const TAKE_RATE_MIN_PASSINGS = 50;
/** ... and raising it there would sign people up at least this many times as fast (less is not worth a suggestion). */
export const TAKE_RATE_MIN_PACE = 1.1;
/** pricing: an offered tier more than this share from its market reference (TIER_DEFAULTS price). */
export const PRICE_BAND_SHARE = 0.2;
/** expand: not while the runway (finance.runwayMonths, when burning) is shorter than this. */
export const EXPAND_MIN_RUNWAY_MONTHS = 6;
/** expand: candidate corners lie within this many CABINET_REACH_FT of the planned plant ... */
export const EXPAND_REACH_MULTIPLE = 2;
/** ... at least CABINET_REACH_FT from every planned cabinet, the nearest this many ... */
export const EXPAND_CANDIDATES_MAX = 6;
/** ... and a suggestion passes at least this many units not served today. */
export const EXPAND_MIN_PASSINGS = 25;

// ---------------------------------------------------------------------------
// Advice frame
// ---------------------------------------------------------------------------

/**
 * One rule's suggestion with what it would have the player do: `commands`
 * in order (financing first, then the purchase or repayment), each verified
 * pro forma by the rule (empty when it suggests no command). `spend` is the
 * cash the suggestion takes out (purchases, repayments and `extraSpend`;
 * money it borrows not netted), `extraSpend` the part of it beyond its
 * commands (expand: the cabinet's build-out cable), and `keep` the cash it
 * promises to leave after everything (expand: its reserve; 0 when it
 * promises only the next debt service). Tests apply `commands` to a copy of
 * the game; the UI shows only `advice`.
 */
export interface AdvicePlan {
  advice: Advice;
  commands: Command[];
  spend: number;
  extraSpend: number;
  keep: number;
}

/**
 * What the plans made so far in one advicePlans call have claimed: cash they
 * spend, whether one borrows or repays (borrowed), whether one takes on new
 * debt (newDebt: a draw or a term loan), whether one (covenantCure) told the
 * player not to borrow, so no later plan suggests borrowing either,
 * whether paymentShort fired (loansCalled then leaves a last called close to
 * it), and whether cash is short (cashShort).
 */
interface Claims {
  spend: number;
  borrowed: boolean;
  newDebt: boolean;
  holdBorrowing: boolean;
  paymentShort: boolean;
  /** An earlier plan is about cash running short (paymentShort, cashRunway): no suggestion to spend more on growth. */
  cashShort: boolean;
}

/** Order advice: priority descending, then ADVICE_ORDER. */
export function rankAdvice(advice: readonly Advice[]): Advice[] {
  const rank = (id: AdviceId) => ADVICE_ORDER.indexOf(id);
  return [...advice].sort((a, b) => b.priority - a.priority || rank(a.id) - rank(b.id));
}

/** Commands that borrow or repay: verified one suggestion at a time, so a later rule suggests none once an earlier one does. */
const FINANCING_COMMANDS: ReadonlySet<Command['type']> = new Set<Command['type']>(['drawCredit', 'takeTermLoan', 'repayCredit', 'prepayLoan']);

/**
 * Every rule that fires on `state` with its plan, ranked as rankAdvice ranks
 * their advice; [] once the game is over. Rules run in ADVICE_ORDER with
 * Claims, so every plan returned can be followed together.
 */
export function advicePlans(state: GameState): AdvicePlan[] {
  if (state.gameOver) return [];
  const r = readingsOf(state);
  const found: AdvicePlan[] = [];
  for (const id of ADVICE_ORDER) {
    const plan = RULES[id](state, r);
    if (!plan) continue;
    found.push(plan);
    r.claims.spend += plan.spend;
    if (plan.commands.some((c) => FINANCING_COMMANDS.has(c.type))) r.claims.borrowed = true;
    if (plan.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan')) r.claims.newDebt = true;
    // A covenant breached or near its limit: every covenantCure text says not to borrow more.
    if (id === 'covenantCure') r.claims.holdBorrowing = true;
    if (id === 'paymentShort') r.claims.paymentShort = true;
    if (id === 'paymentShort' || id === 'cashRunway') r.claims.cashShort = true;
  }
  const rank = (id: AdviceId) => ADVICE_ORDER.indexOf(id);
  return found.sort((a, b) => b.advice.priority - a.advice.priority || rank(a.advice.id) - rank(b.advice.id));
}

/** Every rule that fires on `state`, ranked (rankAdvice); [] once the game is over. */
export function adviceCandidates(state: GameState): Advice[] {
  return advicePlans(state).map((plan) => plan.advice);
}

/** The top `max` (default ADVICE_MAX) suggestions for `state`, ranked; [] once the game is over. */
export function advise(state: GameState, max: number = ADVICE_MAX): Advice[] {
  if (state.gameOver) return [];
  return adviceCandidates(state).slice(0, Math.max(0, max));
}

/** One rule's plan on `state` on its own (no earlier claims), or null when it does not fire (or the game is over). For tests and tools. */
export function planFor(state: GameState, id: AdviceId): AdvicePlan | null {
  if (state.gameOver) return null;
  return RULES[id](state, readingsOf(state));
}

/** The close day after `day`: the 1st of the next month. */
export function nextCloseDay(day: number): number {
  const date = dateOf(day);
  return day - date.day + 1 + (MONTH_LENGTHS[date.month - 1] as number);
}

// ---------------------------------------------------------------------------
// Shared reads (taken at most once per advise call)
// ---------------------------------------------------------------------------

function once<T>(make: () => T): () => T {
  let made = false;
  let value: T | undefined;
  return () => {
    if (!made) {
      value = make();
      made = true;
    }
    return value as T;
  };
}

interface Readings {
  service: () => ServiceSnapshot;
  debt: () => number;
  metrics: () => CovenantMetrics;
  nextService: () => number;
  cashAtClose: () => number;
  runway: () => number | null;
  /** Cash a funding hint keeps: FUNDING_CUSHION_MONTHS of fixed costs plus the next debt service (fundingHint(state, 0).cushion). */
  keep: () => number;
  /** A month of fixed costs as the funding cushion counts them: OVERHEAD_PER_MONTH + the marketing budget. */
  fixed: () => number;
  closeDay: () => number;
  portsUsed: () => Map<CabinetId, number>;
  waiting: () => Map<CabinetId, number>;
  subscribed: () => Map<ParcelId, number>;
  splitterCandidates: () => SplitterCandidate[];
  /** What earlier rules of this call claimed (mutable: advicePlans adds each plan). */
  claims: Claims;
}

function readingsOf(state: GameState): Readings {
  const service = once(() => getService(state));
  const subscribed = once(() => {
    const units = new Map<ParcelId, number>();
    for (const account of state.sales.accounts) units.set(account.parcel, accountUnits(account));
    return units;
  });
  const portsUsed = once(() => cabinetPortsUsed(state));
  const waiting = once(() => demandWaiting(state, service(), subscribed()));
  const r: Readings = {
    service,
    debt: once(() => totalDebt(state)),
    metrics: once(() => covenantMetrics(state)),
    nextService: once(() => estimateNextDebtService(state)),
    cashAtClose: once(() => estimateCashAtClose(state)),
    runway: once(() => runwayMonths(state)),
    keep: once(() => fundingHint(state, 0).cushion),
    fixed: once(() => OVERHEAD_PER_MONTH + state.sales.marketingPerMonth),
    closeDay: once(() => nextCloseDay(state.day)),
    portsUsed,
    waiting,
    subscribed,
    splitterCandidates: once(() => splitterCandidates(state, portsUsed(), waiting())),
    claims: { spend: 0, borrowed: false, newDebt: false, holdBorrowing: false, paymentShort: false, cashShort: false },
  };
  return r;
}

/**
 * Demand waiting per serving cabinet: over each lit segment it serves, the
 * segment's target in whole units (stateTakeRate per building kind against
 * the incumbent's price there, rounded with sales.segmentOffset as the
 * signup step rounds it) less the units subscribed, at most the units not
 * yet subscribed. Cabinets with none are absent.
 */
function demandWaiting(state: GameState, service: ServiceSnapshot, subscribed: Map<ParcelId, number>): Map<CabinetId, number> {
  const rates = new Map<string, number>();
  const rate = (kind: ParcelKind, cabinet: CabinetId): number => {
    const key = `${cabinet}:${kind}`;
    let value = rates.get(key);
    if (value === undefined) {
      value = stateTakeRate(state, kind, cabinet);
      rates.set(key, value);
    }
    return value;
  };
  const perSegment = new Map<SegmentId, { cabinet: CabinetId; target: number; subscribed: number; open: number }>();
  for (const id of service.passedParcels) {
    const parcel = state.city.parcels[id];
    if (!parcel) continue;
    const cabinet = service.servingCabinet.get(parcel.segment);
    if (cabinet === undefined) continue;
    let row = perSegment.get(parcel.segment);
    if (!row) {
      row = { cabinet, target: 0, subscribed: 0, open: 0 };
      perSegment.set(parcel.segment, row);
    }
    const sub = subscribed.get(id) ?? 0;
    row.target += rate(parcel.kind, cabinet) * parcel.units;
    row.subscribed += sub;
    row.open += Math.max(0, parcel.units - sub);
  }
  const waiting = new Map<CabinetId, number>();
  for (const [segment, row] of perSegment) {
    const target = Math.max(0, Math.ceil(row.target - segmentOffset(state.seed, segment)));
    const gap = Math.min(row.open, target - row.subscribed);
    if (gap > 0) waiting.set(row.cabinet, (waiting.get(row.cabinet) ?? 0) + gap);
  }
  return waiting;
}

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

const money = formatMoney;

/** 0.234 -> "23%" */
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** 0.0113 -> "1.1%" */
function pct1(x: number): string {
  return `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
}

/** "1 subscriber", "1,204 subscribers" */
function count(n: number, one: string, many: string): string {
  return `${groupThousands(n)} ${n === 1 ? one : many}`;
}

/** "Apr 1": a close day. */
function closeLabel(day: number): string {
  const d = dateOf(day);
  return `${MONTH_ABBR[d.month - 1] as string} ${d.day}`;
}

function capitalize(text: string): string {
  return text.length > 0 ? (text[0] as string).toUpperCase() + text.slice(1) : text;
}

/** "trim marketing ($8,000 a month) and hold off on new builds" */
function cutSpending(state: GameState): string {
  const m = state.sales.marketingPerMonth;
  return m > 0 ? `trim marketing (${money(m)} a month) and hold off on new builds` : 'hold off on new builds';
}

const PANEL_LABEL: Record<AdvicePanel, string> = { pricing: 'Open Pricing', bank: 'Open Bank', olt: 'Open OLT' };

/** The severity of a priority's band. */
export function severityOf(priority: number): AdviceSeverity {
  return priority >= 300 ? 'urgent' : priority >= 200 ? 'important' : 'tip';
}

/** "Show me" for a place, "Open Pricing" / "Open Bank" / "Open OLT" for a panel. */
export function actionLabelOf(action: AdviceAction): string {
  return action.kind === 'openPanel' ? PANEL_LABEL[action.panel] : 'Show me';
}

function makeAdvice(id: AdviceId, priority: number, title: string, why: string, action: AdviceAction): Advice {
  return { id, priority, severity: severityOf(priority), title, why, action, actionLabel: actionLabelOf(action) };
}

function plan(advice: Advice, commands: Command[] = [], spend = 0, extraSpend = 0, keep = 0): AdvicePlan {
  return { advice, commands, spend, extraSpend, keep };
}

const BANK: AdviceAction = { kind: 'openPanel', panel: 'bank' };
const PRICING: AdviceAction = { kind: 'openPanel', panel: 'pricing' };
const OLT: AdviceAction = { kind: 'openPanel', panel: 'olt' };

/** Financing a FundingHint suggests: its wording and its commands (the draw first: fundingHint prices the loan with it). */
interface Funding {
  phrase: string;
  commands: Command[];
  draw: number;
  termLoan: number;
  termYears: TermYears;
}

/** The financing of a hint that covers its shortfall (draw, term, drawAndTerm), else null (cash: none needed; short: nothing safe covers it). */
function fundingOf(hint: FundingHint): Funding | null {
  const draw: Command = { type: 'drawCredit', amount: hint.draw };
  const loan: Command = { type: 'takeTermLoan', amount: hint.termLoan, termYears: hint.termYears };
  const term = `a ${money(hint.termLoan)} ${hint.termYears}-year term loan`;
  const base = { draw: hint.draw, termLoan: hint.termLoan, termYears: hint.termYears };
  switch (hint.kind) {
    case 'draw':
      return { ...base, termLoan: 0, phrase: `a ${money(hint.draw)} credit-line draw`, commands: [draw] };
    case 'term':
      return { ...base, draw: 0, phrase: term, commands: [loan] };
    case 'drawAndTerm':
      return { ...base, phrase: `a ${money(hint.draw)} credit-line draw plus ${term}`, commands: [draw, loan] };
    default:
      return null;
  }
}

/**
 * How a purchase of `cost` is paid, given what earlier rules claimed: the
 * fundingHint for it plus the earlier spend (so cash or the financing covers
 * both and keeps the cushion); no financing once an earlier rule borrowed
 * or said not to borrow (Claims.holdBorrowing).
 * ", and cash covers it." / ": a $4,000 credit-line draw pays for it and
 * keeps a cushion, within the covenants." / null (nothing safe covers it).
 */
function purchaseFunding(state: GameState, r: Readings, cost: number): { text: string; commands: Command[]; cash: boolean } | null {
  const hint = fundingHint(state, cost + r.claims.spend);
  if (hint.kind === 'cash') return { text: ', and cash covers it.', commands: [], cash: true };
  const funding = r.claims.borrowed || r.claims.holdBorrowing ? null : fundingOf(hint);
  if (!funding) return null;
  return { text: `: ${funding.phrase} pays for it and keeps a cushion, within the covenants.`, commands: funding.commands, cash: false };
}

/** What a purchase waits on beyond its cost: "the next loan payment" while one is due or anything is owed, else "a cushion" (the fixed costs fundingHint keeps). */
function keepWhat(r: Readings): string {
  return r.nextService() > 0 || r.debt() > 0 ? 'the next loan payment' : 'a cushion for the month’s costs';
}

/** Cash alone covers `cost` on top of what earlier rules claimed, keeping the cushion (fundingHint finds no shortfall). */
function cashCovers(state: GameState, r: Readings, cost: number): boolean {
  return fundingHint(state, cost + r.claims.spend).kind === 'cash';
}

/** The longest term on offer. */
function longestTerm(): TermYears {
  return TERM_LOAN_YEARS[TERM_LOAN_YEARS.length - 1] as TermYears;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

type Rule = (state: GameState, r: Readings) => AdvicePlan | null;

/**
 * paymentShort (urgent): the next close's estimated debt service is not
 * covered by the cash projected at it (finance.estimateCashAtClose). Says
 * the shortfall and the close; suggests the fundingHint financing that
 * lifts the projected cash to the payment plus a month of fixed costs when
 * a covenant-safe one does (checked again at the close, the financing's own
 * interest included), else cutting spending, and what a missed payment
 * means at this stage (a default while frozen or called). Open Bank.
 */
function paymentShortRule(state: GameState, r: Readings): AdvicePlan | null {
  const service = r.nextService();
  if (service <= 0) return null;
  const projected = r.cashAtClose();
  if (projected >= service) return null;
  const close = closeLabel(r.closeDay());
  const lead =
    `The ${close} close owes about ${money(service)} in loan payments, but cash there is projected at ${money(projected)}: ` +
    `${money(service - projected)} short.`;
  // The month's outflows to the close as the "cost": the hint's shortfall is then the payment + cushion - projected cash.
  let funding = fundingOf(fundingHint(state, Math.max(0, state.finance.cash - projected)));
  if (funding) {
    const extra =
      (funding.draw > 0 ? quoteDraw(state, funding.draw).interestToClose : 0) +
      (funding.termLoan > 0 ? quoteTermLoan(state, funding.termLoan, funding.termYears).stubInterest : 0);
    if (projected + funding.draw + funding.termLoan < service + extra) funding = null;
  }
  let next: string;
  if (funding) next = `${capitalize(funding.phrase)} now covers it with a cushion and stays within the covenants.`;
  else if (state.debt.acceleration !== null) {
    next = `The bank has called your loans, so a close that cannot pay is a default that ends the game: ${cutSpending(state)} until it is paid.`;
  } else if (state.debt.covenant.stage === 'frozen') {
    next = `Your credit line is frozen, so a missed payment is a default that ends the game: ${cutSpending(state)} until it is paid.`;
  } else {
    next = `No covenant-safe borrowing covers it: ${cutSpending(state)}, or a missed payment freezes the credit line and adds a late fee.`;
  }
  return plan(makeAdvice('paymentShort', ADVICE_PRIORITY.paymentShort, `Cover the ${close} loan payment`, `${lead} ${next}`, BANK), funding?.commands ?? []);
}

/**
 * loansCalled (urgent): the bank has called the loans (Debt.acceleration):
 * what falls due at the next close (debt.acceleratedSchedule) against the
 * cash projected there, the rest over the closes left, and that a close that
 * cannot pay is a default. Not when everything falls due at the next close
 * and paymentShort (earlier in the same call) already says it cannot be
 * paid. Open Bank.
 */
function loansCalledRule(state: GameState, r: Readings): AdvicePlan | null {
  const acceleration = state.debt.acceleration;
  const debt = r.debt();
  if (acceleration === null || debt === 0) return null;
  // Everything falls due at the next close and paymentShort already says that close cannot pay it: one card, not two.
  if (r.claims.paymentShort && acceleration.closesLeft <= 1) return null;
  const schedule = acceleratedSchedule(state);
  const due = schedule[0] ?? r.nextService();
  let rest = 0;
  for (let i = 1; i < schedule.length; i++) rest += schedule[i] as number;
  const projected = r.cashAtClose();
  const close = closeLabel(r.closeDay());
  const left = Math.max(1, acceleration.closesLeft);
  const later = rest > 0 ? `, then ${money(rest)} more over the ${count(schedule.length - 1, 'close', 'closes')} after it` : '';
  const lead = `The bank has called your loans: ${money(due)} falls due at the ${close} close against ${money(projected)} of projected cash${later}.`;
  const next =
    projected < due
      ? `As things stand that close cannot pay, and a close that cannot pay is a default that ends the game: ${cutSpending(state)}.`
      : `A close that cannot pay what falls due is a default that ends the game, so keep the cash for it: ${cutSpending(state)}.`;
  const title = left <= 1 ? `Repay all ${money(debt)} at the ${close} close` : `Repay ${money(debt)} over the next ${left} closes`;
  return plan(makeAdvice('loansCalled', ADVICE_PRIORITY.loansCalled, title, `${lead} ${next}`, BANK));
}

/** "leverage 6.48× (limit 5.00×) and coverage 0.60× (minimum 1.20×)" */
function covenantFigures(m: CovenantMetrics): string {
  const leverage = m.leverage === null ? 'leverage unmeasurable (no cash flow to measure it against)' : `leverage ${formatMultiple(m.leverage)} (limit ${formatMultiple(COVENANT_MAX_LEVERAGE)})`;
  const coverage = m.coverage === null ? 'nothing scheduled' : `coverage ${formatMultiple(m.coverage)} (minimum ${formatMultiple(COVENANT_MIN_COVERAGE)})`;
  return `${leverage} and ${coverage}`;
}

/** What the next breached close does at each stage. */
const NEXT_BREACH: Record<GameState['debt']['covenant']['stage'], string> = {
  compliant: 'a breach there brings a warning',
  warning: 'a second breach brings the penalty rate',
  penalty: 'another breach freezes the credit line',
  frozen: `the freeze lasts until ${COVENANT_CURE_CLOSES} compliant closes in a row`,
};

/**
 * covenantCure: a covenant breached at today's figures (urgent while the
 * stage is penalty or frozen, or when the close is URGENT_CLOSE_DAYS away
 * or fewer; important otherwise) with the cure debt.cureFor shows (a verified
 * repayment or prepayment; repaying everything when no single repayment
 * cures and cash covers it all; else the 'grow' figure). Once the bank has
 * called the loans, or a cure could not lift the freeze before it calls them
 * (debt.cureBeatsCall), only repaying everything helps: that (urgent) when
 * cash covers it, else nothing (frozenSweep and loansCalled say what
 * happens). Or, compliant but within COVENANT_RISK_MARGIN of a limit,
 * important: hold off on borrowing (beyond what an earlier suggestion, the
 * payment the next close must make, borrows: Claims.newDebt). Never "borrow
 * more". Open Bank.
 */
function covenantCureRule(state: GameState, r: Readings): AdvicePlan | null {
  if (r.debt() === 0) return null;
  const m = r.metrics();
  const stage = state.debt.covenant.stage;
  const close = closeLabel(r.closeDay());
  if (!m.compliant) {
    const inTime = cureBeatsCall(state);
    const urgent = !inTime || stage === 'penalty' || stage === 'frozen' || r.closeDay() - state.day <= URGENT_CLOSE_DAYS;
    const priority = urgent ? ADVICE_PRIORITY.covenantCureUrgent : ADVICE_PRIORITY.covenantCureAtRisk;
    const option = cureFor(state);
    if (!inTime && (!option || option.kind !== 'repayAll')) return null;
    const lead = !inTime
      ? state.debt.acceleration !== null
        ? 'The bank has called your loans: a covenant cure does not end the call, only repaying everything does.'
        : `At today's figures ${covenantFigures(m)} breach the covenants, and lifting the freeze takes ${COVENANT_CURE_CLOSES} compliant closes in a row, ` +
          `more than remain before the bank calls the loans: only repaying everything stops it.`
      : `At today's figures ${covenantFigures(m)} breach the covenants, and the ${close} close tests them again: ${NEXT_BREACH[stage]}.`;
    if (!option) {
      const why = `${lead} No single repayment cures it: grow operating cash flow (more subscribers, lower costs) and do not borrow more.`;
      return plan(makeAdvice('covenantCure', priority, 'Grow cash flow to meet the covenants', why, BANK));
    }
    let title: string;
    let commands: Command[] = [];
    if (option.kind === 'repayAll') {
      title = `Repay all ${money(option.amount)} you owe`;
      commands = repayAllCommands(state);
    } else if (option.kind === 'repayCredit') {
      title = `Repay ${money(option.amount)} of the credit line`;
      commands = [{ type: 'repayCredit', amount: option.amount }];
    } else if (option.kind === 'prepayLoan' && option.loan !== null) {
      const loan = state.debt.loans.find((l) => l.id === option.loan);
      title = loan && option.amount >= loan.balance ? `Pay off term loan #${option.loan}` : `Prepay ${money(option.amount)} of term loan #${option.loan}`;
      commands = [{ type: 'prepayLoan', loan: option.loan, amount: option.amount }];
    } else {
      // On the same basis as its text: today's operating cash flow raised to this.
      title = `Grow operating cash flow to about ${money(Math.round(option.after.annualOperatingCashFlow / LOAN_ROUNDING) * LOAN_ROUNDING)} a year`;
    }
    const spend = commands.length > 0 ? state.finance.cash - option.cashAfter : 0;
    return plan(makeAdvice('covenantCure', priority, title, `${lead} ${option.text}`, BANK), commands, spend);
  }
  const leverageNear = m.totalDebt > 0 && m.leverage !== null && m.leverage > COVENANT_MAX_LEVERAGE * (1 - COVENANT_RISK_MARGIN);
  const coverageNear = m.coverage !== null && m.coverage < COVENANT_MIN_COVERAGE * (1 + COVENANT_RISK_MARGIN);
  if (!leverageNear && !coverageNear) return null;
  const hold = r.claims.newDebt
    ? 'Beyond the borrowing suggested above (it covers the payment and stays within the covenants), hold off on new borrowing and keep cash flow growing'
    : 'Hold off on new borrowing and keep cash flow growing';
  const why =
    `At today's figures ${covenantFigures(m)} pass, but only just: a weak month or more borrowing would breach them at the ${close} close. ` +
    `${hold}; repaying debt widens the margin.`;
  return plan(makeAdvice('covenantCure', ADVICE_PRIORITY.covenantCureAtRisk, 'Keep clear of the covenant limits', why, BANK));
}

/**
 * frozenSweep (important): frozen with debt and not yet called: the sweep
 * at the last close (report.debt.sweep) and the next (debt.estimateSweep),
 * the closes until the bank calls the loans (debt.closesUntilAcceleration),
 * and what lifts the freeze (COVENANT_CURE_CLOSES compliant closes in a
 * row), or that too few closes remain for that. Open Bank.
 */
function frozenSweepRule(state: GameState, r: Readings): AdvicePlan | null {
  if (state.debt.covenant.stage !== 'frozen' || state.debt.acceleration !== null || r.debt() === 0) return null;
  const left = closesUntilAcceleration(state) ?? 0;
  const last = state.finance.reports.at(-1)?.debt?.sweep ?? 0;
  const next = estimateSweep(state);
  const close = closeLabel(r.closeDay());
  const compliantNow = r.metrics().compliant;
  const done = compliantNow ? state.debt.covenant.compliantCloses : 0;
  const needed = Math.max(1, COVENANT_CURE_CLOSES - done);
  const swept = last > 0 ? `swept ${money(last)} at the last close and ` : '';
  const takes =
    next > 0
      ? `will take about ${money(next)} at the ${close} close`
      : `takes ${pct(FROZEN_SWEEP_SHARE)} of each month's positive operating cash flow (none expected at the ${close} close)`;
  const call = left <= 0 ? 'calls the loans at the next frozen close' : `calls the loans after ${count(left, 'more frozen close', 'more frozen closes')}`;
  const lead = `While your credit line is frozen the bank ${swept}${takes}, and it ${call}.`;
  const canCure = needed <= Math.max(1, left);
  const lift = canCure
    ? `${COVENANT_CURE_CLOSES} compliant closes in a row lift the freeze (${compliantNow ? `today's figures pass; ${done} so far` : "today's figures still breach"}).`
    : `Lifting the freeze takes ${COVENANT_CURE_CLOSES} compliant closes in a row, more than remain before the call: only repaying everything stops it.`;
  const title = !canCure
    ? `Repay ${money(r.debt())} before the bank calls the loans`
    : left <= 0
      ? 'The bank calls the loans at the next close'
      : `Lift the freeze within ${count(left, 'close', 'closes')}`;
  return plan(makeAdvice('frozenSweep', ADVICE_PRIORITY.frozenSweep, title, `${lead} ${lift}`, BANK));
}

/**
 * cashRunway: installs are paused (Sales.installsPaused), or the runway
 * (finance.runwayMonths) is RUNWAY_WARN_MONTHS or less. Urgent when paused,
 * or at RUNWAY_URGENT_MONTHS or less with no safe financing; important
 * otherwise. Suggests the fundingHint financing that brings in
 * RUNWAY_FUND_MONTHS (else one) months of burn (finance.monthlyBurn) beyond
 * the cushion, or slowing builds and marketing when nothing safe covers it
 * or an earlier suggestion said not to borrow. Open Bank.
 */
function cashRunwayRule(state: GameState, r: Readings): AdvicePlan | null {
  const paused = state.sales.installsPaused;
  const runway = r.runway();
  if (!paused && (runway === null || runway > RUNWAY_WARN_MONTHS)) return null;
  const cash = state.finance.cash;
  const burn = monthlyBurn(state);
  const month = Math.max(burn, r.fixed());
  const borrowed = r.claims.borrowed;
  const hold = r.claims.holdBorrowing;
  let funding: Funding | null = null;
  let months = 0;
  for (const k of borrowed || hold ? [] : RUNWAY_FUND_MONTHS > 1 ? [RUNWAY_FUND_MONTHS, 1] : [1]) {
    funding = fundingOf(fundingHint(state, k * month + Math.max(0, cash - r.keep()) + r.claims.spend));
    if (funding) {
      months = k;
      break;
    }
  }
  const urgent = paused || (runway !== null && runway <= RUNWAY_URGENT_MONTHS && funding === null && !borrowed);
  const priority = urgent ? ADVICE_PRIORITY.cashRunwayUrgent : ADVICE_PRIORITY.cashRunway;
  const lead = paused
    ? `Installs are paused: cash (${money(cash)}) can't cover the next one, so new customers are waiting.`
    : runway === 0
      ? `At your current burn of ${money(burn)} a month, your cash (${money(cash)}) will not last the month.`
      : `At your current burn of ${money(burn)} a month, your ${money(cash)} of cash lasts about ${count(runway ?? 0, 'month', 'months')}.`;
  // "Borrowing suggested above" only when an earlier plan takes on new debt: a
  // repayment above (covenantCure's) is not borrowing, and its warning stands.
  const next = funding
    ? `${capitalize(funding.phrase)} adds about ${months === 1 ? 'a month' : `${months} months`} of ${paused ? 'costs' : 'runway'} and stays within the covenants.`
    : r.claims.newDebt
      ? `Beyond the borrowing suggested above, ${cutSpending(state)} until revenue catches up.`
      : hold
        ? `Until the covenants are clear of their limits (see above), don't borrow: ${cutSpending(state)} until revenue catches up.`
        : borrowed
          ? `After the repayment suggested above, ${cutSpending(state)} until revenue catches up.`
          : `No covenant-safe borrowing covers it: ${cutSpending(state)} until revenue catches up.`;
  const title = paused
    ? 'Raise cash to restart installs'
    : funding
      ? 'Extend your cash runway'
      : `Slow spending: ${count(runway ?? 0, 'month', 'months')} of cash left`;
  return plan(makeAdvice('cashRunway', priority, title, `${lead} ${next}`, BANK), funding?.commands ?? []);
}

/** A cabinet that needs a splitter: turning signups away, or nearly full with demand waiting, and with a free slot. */
interface SplitterCandidate {
  cabinet: Cabinet;
  full: boolean;
  waiting: number;
  used: number;
  capacity: number;
}

/**
 * Cabinets that need a splitter, best first: listed in Sales.fullCabinets
 * or with NEARLY_FULL_SHARE of their ports used and demand waiting, with a
 * free splitter slot (< MAX_SPLITTERS_PER_CABINET); most units waiting
 * first, then full before nearly full, then lower id. OLT ports not checked.
 */
function splitterCandidates(state: GameState, used: Map<CabinetId, number>, waiting: Map<CabinetId, number>): SplitterCandidate[] {
  const full = new Set(state.sales.fullCabinets);
  const out: SplitterCandidate[] = [];
  for (const cabinet of state.network.cabinets) {
    if (cabinet.splitters >= MAX_SPLITTERS_PER_CABINET) continue;
    const capacity = cabinetPortCapacity(cabinet);
    const inUse = used.get(cabinet.id) ?? 0;
    const w = waiting.get(cabinet.id) ?? 0;
    const isFull = full.has(cabinet.id);
    if (!isFull && !(capacity > 0 && inUse >= NEARLY_FULL_SHARE * capacity && w > 0)) continue;
    out.push({ cabinet, full: isFull, waiting: w, used: inUse, capacity });
  }
  return out.sort((a, b) => b.waiting - a.waiting || Number(b.full) - Number(a.full) || a.cabinet.id - b.cabinet.id);
}

/**
 * addSplitter (important): the cabinet that needs a splitter most
 * (splitterCandidates) when the OLT has a free PON port (else addOltCard):
 * the units waiting there, the splitter's cost (network.quoteSplitter) and
 * how it is paid (cash, or covenant-safe financing that keeps a cushion);
 * "when cash allows" with no command when nothing safe pays for it. Show
 * me: the cabinet.
 */
function addSplitterRule(state: GameState, r: Readings): AdvicePlan | null {
  const best = r.splitterCandidates()[0];
  if (!best) return null;
  if (ponPortsUsed(state) >= state.network.olt.ponPorts) return null;
  const { cabinet } = best;
  const place = cornerName(state.city, cabinet.node);
  const cost = quoteSplitter(state, cabinet.id).cost;
  const paid = purchaseFunding(state, r, cost);
  const waiting = best.waiting > 0 ? `about ${count(best.waiting, 'customer', 'customers')} waiting to sign up there` : 'new customers there';
  const lead = best.full
    ? `The cabinet at ${place} has no free splitter port, so ${waiting} ${best.waiting === 1 ? 'is' : 'are'} being turned away.`
    : `The cabinet at ${place} has ${groupThousands(best.used)} of its ${groupThousands(best.capacity)} ports in use, with ${waiting}.`;
  const next = `A splitter (${money(cost)}) adds ${SPLIT_RATIO} ports${paid ? paid.text : `, but cash is tight: add it once cash covers it and ${keepWhat(r)}.`}`;
  const priority = !best.full
    ? ADVICE_PRIORITY.addSplitterNearlyFull
    : paid?.cash
      ? ADVICE_PRIORITY.addSplitterFull
      : paid
        ? ADVICE_PRIORITY.addSplitterFinanced
        : ADVICE_PRIORITY.addSplitterShort;
  const title = paid ? `Add a splitter at ${place}` : `Add a splitter at ${place} when cash allows`;
  const commands: Command[] = paid ? [...paid.commands, { type: 'addSplitter', cabinet: cabinet.id }] : [];
  return plan(makeAdvice('addSplitter', priority, title, `${lead} ${next}`, { kind: 'focusCabinet', cabinet: cabinet.id }), commands, paid ? cost : 0);
}

/**
 * addOltCard: important when no PON port is free and a cabinet needs one
 * for a splitter (splitterCandidates), a tip at NEARLY_FULL_SHARE of the
 * ports in use; nothing once the chassis is full. The card's cost
 * (network.quoteOltCard) and how it is paid. Open OLT.
 */
function addOltCardRule(state: GameState, r: Readings): AdvicePlan | null {
  const olt = state.network.olt;
  if (olt.cards >= OLT_MAX_CARDS) return null;
  const used = ponPortsUsed(state);
  const free = olt.ponPorts - used;
  const needer = free <= 0 ? (r.splitterCandidates()[0] ?? null) : null;
  if (needer === null && !(olt.ponPorts <= 0 || used >= NEARLY_FULL_SHARE * olt.ponPorts)) return null;
  const cost = quoteOltCard(state).cost;
  const paid = purchaseFunding(state, r, cost);
  const need = needer
    ? `, and the cabinet at ${cornerName(state.city, needer.cabinet.node)} needs one for a splitter` +
      (needer.waiting > 0 ? ` (${count(needer.waiting, 'customer', 'customers')} waiting)` : '')
    : free <= 0
      ? ', so no cabinet or splitter can be added'
      : '';
  const lead = `${groupThousands(used)} of the ${groupThousands(olt.ponPorts)} PON ports at the CO are in use${need}.`;
  const next = `A line card (${money(cost)}) adds ${OLT_PORTS_PER_CARD} more${paid ? paid.text : `, once cash covers it and ${keepWhat(r)}.`}`;
  const priority = needer ? ADVICE_PRIORITY.addOltCardNeeded : ADVICE_PRIORITY.addOltCardNearlyFull;
  const commands: Command[] = paid ? [...paid.commands, { type: 'addOltCard' }] : [];
  return plan(makeAdvice('addOltCard', priority, paid ? 'Add an OLT line card' : 'Add an OLT line card when cash allows', `${lead} ${next}`, OLT), commands, paid ? cost : 0);
}

/**
 * outages (important): spans out of service now with subscribers cut off
 * (network.outageService: the outage cuts their own cabinet off from their
 * street and no other cabinet there has a port free): the span cutting off
 * the most (network.outageImpact, measured for at most
 * OUTAGE_CANDIDATES_MAX spans), its street, the days left, its repair
 * cost and the churn its subscribers still risk (weather.outageChurnFor: their
 * days cut off so far, weather.cutOffOf, plus the days still to come, a span
 * repaired in `daysLeft` days being out daysLeft - 1 more days, less what
 * earlier closes charged) at the closes those days fall before (one, or the
 * next two when the outage runs past a close). Show me: that street.
 */
function outagesRule(state: GameState, r: Readings): AdvicePlan | null {
  const out = state.network.spans.filter((s) => s.outage !== null && s.stage === 'live');
  if (out.length === 0) return null;
  const service = r.service();
  if (service.cutOffCabinets.size === 0) return null;
  const parcels = state.city.parcels;
  const dark = outageService(state, service).cutOff;
  let total = 0;
  const onSegment = new Map<SegmentId, number>();
  const cutOff: { segment: SegmentId; parcel: ParcelId }[] = [];
  for (const account of state.sales.accounts) {
    const parcel = parcels[account.parcel];
    if (!parcel || !dark.has(account.parcel)) continue;
    const units = accountUnits(account);
    total += units;
    onSegment.set(parcel.segment, (onSegment.get(parcel.segment) ?? 0) + units);
    cutOff.push({ segment: parcel.segment, parcel: parcel.id });
  }
  if (total === 0) return null;
  const daysLeft = (s: CableSpan) => s.outage?.daysLeft ?? 0;
  const ranked = [...out].sort((a, b) => (onSegment.get(b.segment) ?? 0) - (onSegment.get(a.segment) ?? 0) || daysLeft(b) - daysLeft(a) || a.id - b.id);
  let worst = ranked[0] as CableSpan;
  let units = 0;
  let segments: readonly SegmentId[] = [];
  for (const span of ranked.slice(0, OUTAGE_CANDIDATES_MAX)) {
    const impact = outageImpact(state, span.id);
    if (impact.subscribers > units) {
      units = impact.subscribers;
      worst = span;
      segments = impact.segments;
    }
  }
  if (units === 0) units = total;
  const outage = worst.outage;
  if (!outage) return null;
  const street = state.city.segments[worst.segment]?.name ?? 'a street';
  // Its subscribers' outage so far (the longest among them), and the days still to come.
  const theirs = segments.length > 0 ? new Set(segments) : null;
  let soFar = { days: 0, charged: 0 };
  for (const c of cutOff) {
    if (theirs !== null && !theirs.has(c.segment)) continue;
    const entry = cutOffOf(state, c.parcel);
    if (entry && entry.days + entry.charged > soFar.days + soFar.charged) soFar = entry;
  }
  const more = Math.max(0, outage.daysLeft - 1);
  const p = outageChurnFor(soFar.charged, soFar.days + more);
  const first = r.closeDay();
  const last = nextCloseDay(state.day + more);
  const closes = last === first ? `the ${closeLabel(first)} close` : `the ${closeLabel(first)} and ${closeLabel(last)} closes`;
  const cause = outage.cause === 'storm' ? 'A storm' : 'A dig-in';
  const all = total > units ? ` (${groupThousands(total)} in all)` : '';
  const lead =
    `${cause} cut ${count(units, 'subscriber', 'subscribers')} off on ${street}${all}; ` +
    `the repair (${money(outage.repairCost)}) finishes in ${count(outage.daysLeft, 'day', 'days')}.`;
  const expected = Math.round(units * p);
  const next = `Days without service add churn: about ${pct(p)} of them${expected > 0 ? ` (${groupThousands(expected)})` : ''} may cancel at ${closes}.`;
  return plan(makeAdvice('outages', ADVICE_PRIORITY.outages, `Service is out on ${street}`, `${lead} ${next}`, { kind: 'focusSegment', segment: worst.segment }));
}

/**
 * Subscribed units an outage on `span` would cut off (beyond what is cut
 * off today): the coverage rule on a pro forma copy with that span out
 * (state is never written; the copy has its own network object, so the
 * service cache keys it apart), counted per account (network.outageService).
 */
function unitsFedBy(state: GameState, span: CableSpan, r: Readings): number {
  if (span.outage !== null) return outageImpact(state, span.id).subscribers;
  const spans = state.network.spans.map((s) =>
    s.id === span.id ? { ...s, outage: { cause: 'storm' as const, storm: null, startDay: state.day, daysLeft: 1, repairCost: 0 } } : s,
  );
  const pro: GameState = { ...state, network: { ...state.network, spans } };
  const before = outageService(state, r.service()).cutOff;
  const after = outageService(pro, getService(pro)).cutOff;
  let units = 0;
  for (const account of state.sales.accounts) if (after.has(account.parcel) && !before.has(account.parcel)) units += accountUnits(account);
  return units;
}

/**
 * stormUnderground (tip): a live aerial span (not being rebuilt) that
 * storms damaged STORM_HITS_MIN or more times within STORM_LOG_DAYS (or
 * whose repairs reach STORM_REPAIRS_CONVERT_SHARE of rebuilding it) and
 * feeds subscribers (the most-hit STORM_CANDIDATES_MAX are measured), with
 * the repairs so far. Rebuilding it underground (network.quoteConvert) when
 * what it saves a year (repairsAvoidedPerYear, weather.stormRisk's estimate,
 * plus a year of pole rent) pays it back within CONVERT_PAYBACK_YEARS and
 * cash covers it and the cushion; otherwise the figures and building new
 * streets there underground (storms center anywhere on the map, so past
 * hits do not raise the estimate: a rebuild that does not pay is not
 * suggested). Show me: that street.
 */
function stormUndergroundRule(state: GameState, r: Readings): AdvicePlan | null {
  const since = state.day - STORM_LOG_DAYS;
  const hits = new Map<SpanId, { hits: number; first: number }>();
  for (const storm of state.weather.storms) {
    if (storm.day < since || storm.day > state.day) continue;
    for (const id of storm.spans) {
      const row = hits.get(id);
      if (row) row.hits++;
      else hits.set(id, { hits: 1, first: storm.day });
    }
  }
  if (hits.size === 0) return null;
  const candidates: { span: CableSpan; hits: number; first: number; repairs: number }[] = [];
  for (const span of state.network.spans) {
    const row = hits.get(span.id);
    if (!row || span.method !== 'aerial' || span.stage !== 'live' || span.conversion !== null) continue;
    const segment = state.city.segments[span.segment];
    if (!segment) continue;
    const repairs = row.hits * repairCost(segment, 'aerial');
    if (row.hits < STORM_HITS_MIN && repairs < STORM_REPAIRS_CONVERT_SHARE * quoteConvert(state, span.id).cost) continue;
    candidates.push({ span, hits: row.hits, first: row.first, repairs });
  }
  candidates.sort((a, b) => b.hits - a.hits || b.repairs - a.repairs || a.span.id - b.span.id);
  for (const c of candidates.slice(0, STORM_CANDIDATES_MAX)) {
    const fed = unitsFedBy(state, c.span, r);
    if (fed <= 0) continue;
    const street = state.city.segments[c.span.segment]?.name ?? 'a street';
    const lead =
      `Storms have damaged the aerial cable on ${street} ${count(c.hits, 'time', 'times')} since ${formatDate(c.first)} ` +
      `(about ${money(c.repairs)} of repairs), and an outage there cuts off ${count(fed, 'subscriber', 'subscribers')}.`;
    const quote = quoteConvert(state, c.span.id);
    const saved = quote.repairsAvoidedPerYear + 12 * quote.poleRentSaved;
    const pays = quote.cost > 0 && saved > 0 && saved * CONVERT_PAYBACK_YEARS >= quote.cost;
    const convert = pays && quote.ok && cashCovers(state, r, quote.cost);
    const rent = quote.poleRentSaved > 0 ? ` and ${money(12 * quote.poleRentSaved)} of pole rent` : '';
    const savings = `about ${money(quote.repairsAvoidedPerYear)} a year in storm repairs${rent}`;
    const next = convert
      ? `Rebuilding it underground costs ${money(quote.cost)} and saves ${savings}: it pays for itself in about ${count(Math.ceil(quote.cost / saved), 'year', 'years')}.`
      : pays
        ? `Rebuilding it underground (${money(quote.cost)}) would save ${savings}: do it once cash covers it and ${keepWhat(r)}, and build new streets around here underground.`
        : quote.cost > 0
          ? `Rebuilding it (${money(quote.cost)}) would save only ${savings}, so build new streets around here underground instead.`
          : 'Build new streets around here underground.';
    const title = convert ? `Rebuild ${street} underground` : `Build underground around ${street}`;
    const commands: Command[] = convert ? [{ type: 'convertSpan', span: c.span.id }] : [];
    const action: AdviceAction = { kind: 'focusSegment', segment: c.span.segment };
    return plan(makeAdvice('stormUnderground', ADVICE_PRIORITY.stormUnderground, title, `${lead} ${next}`, action), commands, convert ? quote.cost : 0);
  }
  return null;
}

/** Units passed per building kind on the lit segments `cabinet` serves. */
function areaUnits(state: GameState, service: ServiceSnapshot, cabinet: CabinetId): Record<ParcelKind, number> {
  const units: Record<ParcelKind, number> = { home: 0, mdu: 0, smb: 0 };
  for (const id of service.passedParcels) {
    const parcel = state.city.parcels[id];
    if (parcel && service.servingCabinet.get(parcel.segment) === cabinet) units[parcel.kind] += parcel.units;
  }
  return units;
}

const KINDS: readonly ParcelKind[] = ['home', 'mdu', 'smb'];

/** Months from the month of `day` to the month of `until` (a close day): the months a promo ending then still runs. */
function monthsUntil(day: number, until: number): number {
  const a = dateOf(day);
  const b = dateOf(until);
  return Math.max(0, b.year * 12 + b.month - (a.year * 12 + a.month));
}

/**
 * incumbentPromo (important): the incumbent's running promo (incumbent.
 * activePromos) at the cabinet with the most of your subscribers: its price,
 * how long it runs, and your target take rate there (sales.stateTakeRate at
 * its promo price, weighted by the area's passings per building kind)
 * against elsewhere (at INCUMBENT_PRICE); answer with an intro promo or
 * marketing, not a permanent price cut. Open Pricing.
 */
function incumbentPromoRule(state: GameState, r: Readings): AdvicePlan | null {
  const running = activePromos(state);
  if (running.length === 0) return null;
  const units = new Map<CabinetId, number>();
  for (const account of state.sales.accounts) units.set(account.cabinet, (units.get(account.cabinet) ?? 0) + accountUnits(account));
  let best: { promo: (typeof running)[number]; units: number } | null = null;
  for (const promo of running) {
    const n = units.get(promo.cabinet) ?? 0;
    if (n > 0 && (best === null || n > best.units)) best = { promo, units: n };
  }
  if (!best) return null;
  const cabinet = state.network.cabinets.find((c) => c.id === best.promo.cabinet);
  if (!cabinet) return null;
  const place = cornerName(state.city, cabinet.node);
  const kinds = areaUnits(state, r.service(), cabinet.id);
  const there = passingsWeightedRate(KINDS.map((k) => ({ units: kinds[k], rate: stateTakeRate(state, k, cabinet.id) }))) ?? stateTakeRate(state, 'home', cabinet.id);
  const elsewhere = passingsWeightedRate(KINDS.map((k) => ({ units: kinds[k], rate: stateTakeRate(state, k) }))) ?? stateTakeRate(state, 'home');
  const months = monthsUntil(state.day, best.promo.endDay);
  const lead =
    `The cable company charges ${money(best.promo.price)}/mo (instead of ${money(INCUMBENT_PRICE)}) around ${place} until ${formatDate(best.promo.endDay)}, ` +
    `${count(months, 'month', 'months')} more: your target take rate there is ${pct(there)} instead of ${pct(elsewhere)}, ` +
    `and its ${count(best.units, 'subscriber', 'subscribers')} cancel more.`;
  const next =
    state.sales.promo === null
      ? 'Answer with an intro promo for new signups or more marketing rather than a permanent price cut: the promo ends.'
      : 'Your intro promo already helps new signups; add marketing rather than cutting prices for good: the promo ends.';
  return plan(makeAdvice('incumbentPromo', ADVICE_PRIORITY.incumbentPromo, `Answer the cable company's promo at ${place}`, `${lead} ${next}`, PRICING));
}

/**
 * takeRate (tip): in areas lit TAKE_RATE_MATURE_MONTHS or more (a segment
 * counts from the later of its span's and its serving cabinet's liveDay),
 * with at least TAKE_RATE_MIN_PASSINGS units, the take rate is below
 * TAKE_RATE_LAG_SHARE of their passings-weighted target (sales.stateTakeRate
 * per kind and cabinet) while marketing is under MARKETING_PER_PASSING_GOOD
 * a passing and raising it to that would sign people up at least
 * TAKE_RATE_MIN_PACE times as fast: what raising it does to the signup pace
 * (sales.marketingBoost). Not while installs are paused (new customers
 * already wait for cash) or an earlier suggestion of the same call is about
 * cash running short (Claims.cashShort: paymentShort or cashRunway), so it
 * never sits next to a card telling the player to cut spending or raise
 * cash.
 * Open Pricing (marketing lives there).
 */
function takeRateRule(state: GameState, r: Readings): AdvicePlan | null {
  if (state.sales.installsPaused || r.claims.cashShort) return null;
  const service = r.service();
  const passings = service.passings;
  if (passings <= 0) return null;
  const m = state.sales.marketingPerMonth;
  const good = MARKETING_PER_PASSING_GOOD * passings;
  if (m >= good) return null;
  const spanLive = new Map<SegmentId, number>();
  for (const span of state.network.spans) if (span.liveDay !== null) spanLive.set(span.segment, span.liveDay);
  const cabinetLive = new Map<CabinetId, number>();
  for (const cabinet of state.network.cabinets) if (cabinet.liveDay !== null) cabinetLive.set(cabinet.id, cabinet.liveDay);
  const matureDays = (TAKE_RATE_MATURE_MONTHS * DAYS_PER_YEAR) / 12;
  const groups = new Map<string, { units: number; rate: number }>();
  const subscribed = r.subscribed();
  let mature = 0;
  let subs = 0;
  for (const id of service.passedParcels) {
    const parcel = state.city.parcels[id];
    if (!parcel) continue;
    const cabinet = service.servingCabinet.get(parcel.segment);
    if (cabinet === undefined) continue;
    const since = Math.max(spanLive.get(parcel.segment) ?? state.day, cabinetLive.get(cabinet) ?? state.day);
    if (state.day - since < matureDays) continue;
    const key = `${cabinet}:${parcel.kind}`;
    let group = groups.get(key);
    if (!group) {
      group = { units: 0, rate: stateTakeRate(state, parcel.kind, cabinet) };
      groups.set(key, group);
    }
    group.units += parcel.units;
    mature += parcel.units;
    subs += subscribed.get(id) ?? 0;
  }
  if (mature < TAKE_RATE_MIN_PASSINGS) return null;
  const target = passingsWeightedRate([...groups.values()]);
  if (target === null) return null;
  const actual = subs / mature;
  if (actual >= TAKE_RATE_LAG_SHARE * target) return null;
  const suggested = Math.ceil(good / 100) * 100;
  const pace = (1 + marketingBoost(suggested, passings)) / (1 + marketingBoost(m, passings));
  if (pace < TAKE_RATE_MIN_PACE) return null;
  const perPassing = `$${(m / passings).toFixed(2)}`;
  const lead =
    `In areas lit ${TAKE_RATE_MATURE_MONTHS} months or more your take rate is ${pct(actual)} against a ${pct(target)} target, ` +
    `with marketing at ${money(m)} a month (${perPassing} a passing).`;
  const next = `Raising it to ${money(suggested)} a month signs people up ${formatMultiple(pace)} as fast; check your prices too.`;
  return plan(makeAdvice('takeRate', ADVICE_PRIORITY.takeRate, `Raise marketing to ${money(suggested)} a month`, `${lead} ${next}`, PRICING));
}

/** `pricing` with tier `id` at `price` (a copy). */
function withPrice(pricing: Pricing, id: string, price: number): Pricing {
  return { ...pricing, tiers: pricing.tiers.map((t) => (t.id === id ? { ...t, price } : t)) };
}

/**
 * pricing (tip): the offered tier furthest from its market reference (its
 * TIER_DEFAULTS price, which the tuner puts near what the market bears),
 * when more than PRICE_BAND_SHARE away: above means more churn
 * (sales.churnProbability) and possibly a lower target take rate, below
 * means revenue left on the table (its subscribers x the gap). Open Pricing.
 */
function pricingRule(state: GameState): AdvicePlan | null {
  const pricing = state.sales.pricing;
  let best: { id: string; name: string; price: number; ref: number; gap: number } | null = null;
  for (const tier of pricing.tiers) {
    if (!tier.offered) continue;
    const ref = TIER_DEFAULTS.find((t) => t.id === tier.id)?.price;
    if (ref === undefined || ref <= 0) continue;
    const gap = (tier.price - ref) / ref;
    if (Math.abs(gap) <= PRICE_BAND_SHARE) continue;
    if (best === null || Math.abs(gap) > Math.abs(best.gap)) best = { id: tier.id, name: tier.name, price: tier.price, ref, gap };
  }
  if (!best) return null;
  const tier = pricing.tiers.find((t) => t.id === best.id);
  if (!tier) return null;
  let why: string;
  if (best.gap > 0) {
    const churn = churnProbability(tier);
    const churnAtRef = churnProbability({ ...tier, price: best.ref });
    const target = targetTakeRate(pricing, 'home', INCUMBENT_PRICE, state.sales.promo);
    const targetAtRef = targetTakeRate(withPrice(pricing, best.id, best.ref), 'home', INCUMBENT_PRICE, state.sales.promo);
    const lower = Math.round(target * 100) < Math.round(targetAtRef * 100) ? `, and your target take rate is ${pct(target)} instead of ${pct(targetAtRef)}` : '';
    why =
      `${best.name} at ${money(best.price)} is ${pct(best.gap)} above the ${money(best.ref)} the market bears: ` +
      `its subscribers cancel ${pct1(churn)} a month instead of ${pct1(churnAtRef)}${lower}.`;
  } else {
    const units = unitsByTier(state)[tier.id];
    const left = units > 0 ? `about ${money(units * (best.ref - best.price))} a month left on the table across its ${count(units, 'subscriber', 'subscribers')}` : 'new subscribers would pay more';
    why =
      `${best.name} at ${money(best.price)} is ${pct(-best.gap)} below the ${money(best.ref)} the market bears: ${left}. ` +
      'A rise reaches today’s subscribers only when their price lock ends.';
  }
  return plan(makeAdvice('pricing', ADVICE_PRIORITY.pricing, `Bring ${best.name} closer to ${money(best.ref)}`, why, PRICING));
}

/**
 * redCpp: the lifetime cost per passing the lender prices on
 * (debt.pricingCpp) is amber or red: the CPP_SPREAD_BPS spread it adds to
 * the credit line and new loans (and what that costs a year on the line's
 * balance, the only debt it re-prices: a term loan's rate is fixed when it
 * is taken), and where green builds take it. Important while the line is
 * drawn, else a tip. Open Bank.
 */
function redCppRule(state: GameState): AdvicePlan | null {
  const cpp = pricingCpp(state);
  if (cpp === null) return null;
  const band = cppBand(cpp);
  if (band === 'green') return null;
  const spread = CPP_SPREAD_BPS[band];
  const lower = band === 'red' ? 'amber' : 'green';
  const threshold = band === 'red' ? CPP_TARGET * CPP_AMBER_MULTIPLIER : CPP_TARGET;
  const line = state.debt.credit.balance;
  const cost = line > 0 ? `: about ${money((line * spread) / 10_000)} a year on the ${money(line)} drawn on the line` : '';
  const fixed = state.debt.loans.length > 0 ? ' (your term loans keep the rates they were taken at)' : '';
  const lead =
    `Your lifetime cost per passing is ${money(cpp)} (${band}; target ${money(CPP_TARGET)}), ` +
    `so the bank adds ${formatRateBps(spread)} to the credit line and every new loan${fixed}${cost}.`;
  const next =
    `Builds that pass homes for under ${money(CPP_TARGET)} each (green on the cabinet tool) bring it down; ` +
    `at ${money(threshold)} or less the spread drops to ${formatRateBps(CPP_SPREAD_BPS[lower])}.`;
  const priority = line > 0 ? ADVICE_PRIORITY.redCppWithDebt : ADVICE_PRIORITY.redCpp;
  return plan(makeAdvice('redCpp', priority, 'Bring your cost per passing down', `${lead} ${next}`, BANK));
}

/**
 * Corners to preview for a new cabinet: no cabinet there, within
 * EXPAND_REACH_MULTIPLE x CABINET_REACH_FT (straight line, a lower bound of
 * the street distance) of the planned plant (every span's ends, every
 * cabinet, the CO) and at least CABINET_REACH_FT from every planned
 * cabinet; the nearest EXPAND_CANDIDATES_MAX to the plant (ties: lower id).
 */
export function expandCandidates(state: GameState): number[] {
  const { city, network } = state;
  const cell = city.tileFt > 0 ? city.tileFt : 1;
  const plant = new Set<number>([city.coNode]);
  for (const span of network.spans) {
    const segment = city.segments[span.segment];
    if (segment) {
      plant.add(segment.a);
      plant.add(segment.b);
    }
  }
  const cabinets = new Set<number>(network.cabinets.map((c) => c.node));
  for (const node of cabinets) plant.add(node);
  const plantNodes = [...plant].map((id) => city.nodes[id]).filter((n) => n !== undefined);
  const cabinetNodes = [...cabinets].map((id) => city.nodes[id]).filter((n) => n !== undefined);
  const near = (EXPAND_REACH_MULTIPLE * CABINET_REACH_FT) / cell;
  const apart = CABINET_REACH_FT / cell;
  const found: { node: number; d2: number }[] = [];
  for (const node of city.nodes) {
    if (cabinets.has(node.id)) continue;
    let d2 = Number.POSITIVE_INFINITY;
    for (const p of plantNodes) {
      const dx = p.x - node.x;
      const dy = p.y - node.y;
      d2 = Math.min(d2, dx * dx + dy * dy);
    }
    if (d2 > near * near) continue;
    let tooClose = false;
    for (const c of cabinetNodes) {
      const dx = c.x - node.x;
      const dy = c.y - node.y;
      if (dx * dx + dy * dy < apart * apart) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) found.push({ node: node.id, d2 });
  }
  found.sort((a, b) => a.d2 - b.d2 || a.node - b.node);
  return found.slice(0, EXPAND_CANDIDATES_MAX).map((f) => f.node);
}

/**
 * expand (tip): only when compliant (stage and today's figures, loans not
 * called), installs running, the runway at least EXPAND_MIN_RUNWAY_MONTHS
 * (when burning), a PON port free and cash at least a reserve
 * (EXPAND_RESERVE_MONTHS of fixed costs + the funding cushion, which holds
 * the next debt service). The best of expandCandidates by
 * coverage.coveragePreview: projected CPP green, the most passings not
 * served elsewhere (>= EXPAND_MIN_PASSINGS; ties: lower projected CPP, then
 * node id), whose cabinet plus build-out cash above the reserve covers, or
 * with a term loan within debt.maxSafeTermLoan (covenant-safe; verified on
 * quoteTermLoan). Show me: the corner.
 */
function expandRule(state: GameState, r: Readings): AdvicePlan | null {
  if (state.debt.covenant.stage !== 'compliant' || state.debt.acceleration !== null || state.sales.installsPaused) return null;
  const runway = r.runway();
  if (runway !== null && runway < EXPAND_MIN_RUNWAY_MONTHS) return null;
  if (ponPortsUsed(state) + CABINET_START_SPLITTERS > state.network.olt.ponPorts) return null;
  if (!r.metrics().compliant) return null;
  const reserve = EXPAND_RESERVE_MONTHS * r.fixed() + r.keep();
  // Cash above the reserve and what earlier suggestions spend.
  const room = state.finance.cash - reserve - r.claims.spend;
  if (room < 0) return null;
  const years = longestTerm();
  const safeLoan = r.claims.borrowed || r.claims.holdBorrowing ? 0 : maxSafeTermLoan(state, years);
  const funds = room + (safeLoan >= TERM_LOAN_MIN ? safeLoan : 0);
  let best: { node: number; newly: number; cpp: number; cost: number; buildOut: number } | null = null;
  for (const node of expandCandidates(state)) {
    const preview = coveragePreview(state, node);
    const newly = preview.passingsNow - preview.passingsServedElsewhere;
    if (preview.projectedCppBand !== 'green' || preview.projectedCpp === null || newly < EXPAND_MIN_PASSINGS) continue;
    const cost = preview.cabinetCost + preview.buildOutCost;
    if (cost > funds) continue;
    const better =
      best === null || newly > best.newly || (newly === best.newly && (preview.projectedCpp < best.cpp || (preview.projectedCpp === best.cpp && node < best.node)));
    if (better) best = { node, newly, cpp: preview.projectedCpp, cost, buildOut: preview.buildOutCost };
  }
  if (!best) return null;
  const loan = best.cost <= room ? 0 : Math.max(TERM_LOAN_MIN, Math.ceil((best.cost - room) / LOAN_ROUNDING) * LOAN_ROUNDING);
  if (loan > 0) {
    const quote = quoteTermLoan(state, loan, years);
    if (loan > safeLoan || !quote.ok || !quote.after.compliant) return null;
  }
  const corner = cornerName(state.city, best.node);
  const lead =
    `A cabinet at ${corner} would add ${count(best.newly, 'passing', 'passings')} not served today at about ${money(best.cpp)} each ` +
    `(target ${money(CPP_TARGET)}), for ${money(best.cost)} with its cable.`;
  const next =
    loan === 0
      ? `Cash covers it and still keeps ${money(reserve)} in reserve.`
      : `A ${money(loan)} ${years}-year term loan covers it within the covenants, keeping ${money(reserve)} in reserve.`;
  const commands: Command[] = [];
  if (loan > 0) commands.push({ type: 'takeTermLoan', amount: loan, termYears: years });
  commands.push({ type: 'placeCabinet', node: best.node });
  const priority = loan === 0 ? ADVICE_PRIORITY.expandCash : ADVICE_PRIORITY.expandLoan;
  return plan(
    makeAdvice('expand', priority, `Build a cabinet at ${corner}`, `${lead} ${next}`, { kind: 'focusNode', node: best.node }),
    commands,
    best.cost,
    best.buildOut,
    reserve,
  );
}

const RULES: Record<AdviceId, Rule> = {
  paymentShort: paymentShortRule,
  loansCalled: loansCalledRule,
  covenantCure: covenantCureRule,
  frozenSweep: frozenSweepRule,
  cashRunway: cashRunwayRule,
  addSplitter: addSplitterRule,
  addOltCard: addOltCardRule,
  outages: outagesRule,
  stormUnderground: stormUndergroundRule,
  incumbentPromo: incumbentPromoRule,
  takeRate: takeRateRule,
  pricing: pricingRule,
  redCpp: redCppRule,
  expand: expandRule,
};

// ---------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------

/** Report category order for the breakdown (revenue first): exhaustive, so a new category is a compile error until placed. */
const CATEGORY_RANK: Record<LedgerCategory, number> = {
  revenue: 0,
  construction: 1,
  equipment: 2,
  install: 3,
  refund: 4,
  poleRent: 5,
  overhead: 6,
  payroll: 7,
  marketing: 8,
  repair: 9,
  interest: 10,
  principal: 11,
  loanProceeds: 12,
  other: 13,
};

/** The close day of a report: the 1st of the month after the one it closed. */
export function closeDayOf(report: Pick<MonthlyReport, 'year' | 'month'>): number {
  const last = dayOf({ year: report.year, month: report.month, day: MONTH_LENGTHS[report.month - 1] as number });
  return last + 1;
}

/** "Mar 2028", or "Jan-Mar 2028" / "Nov 2027-Jan 2028" for a span of months ending at `last`. */
function periodLabel(first: MonthlyReport, last: MonthlyReport): string {
  if (first === last) return formatMonth(last.year, last.month);
  const head = formatMonth(first.year, first.month);
  return first.year === last.year ? `${head.slice(0, 3)}-${formatMonth(last.year, last.month)}` : `${head}-${formatMonth(last.year, last.month)}`;
}

function sumFlows(reports: readonly MonthlyReport[]): { net: number; revenue: number; operatingCashFlow: number } {
  let net = 0;
  let revenue = 0;
  let flow = 0;
  for (const r of reports) {
    net += r.net;
    revenue += r.totals.revenue ?? 0;
    flow += operatingCashFlow(r);
  }
  return { net, revenue, operatingCashFlow: flow };
}

function debtAt(report: MonthlyReport | null): number | null {
  if (!report?.debt) return null;
  return report.debt.creditBalance + report.debt.termBalance;
}

function change(
  key: BriefingChangeKey,
  label: string,
  now: number | null,
  before: number | null,
  upIsGood: boolean | null,
  unit: BriefingChange['unit'],
): BriefingChange {
  return { key, label, now, before, delta: now === null || before === null ? null : now - before, upIsGood, unit };
}

/** The period's notices still in the log: after the earlier report's notice cursor, up to this report's. */
function periodNotices(state: GameState, report: MonthlyReport, before: MonthlyReport | null): Notice[] {
  // Reports from older saves have no notice cursor: fall back to close days.
  const afterId = before?.ops?.lastNoticeId;
  const afterDay = before && !before.ops ? closeDayOf(before) : -1;
  const uptoId = report.ops ? report.ops.lastNoticeId : Infinity;
  const uptoDay = report.ops ? Infinity : closeDayOf(report);
  return state.notices.filter((n) => (afterId === undefined ? n.day > afterDay : n.id > afterId) && n.id <= uptoId && n.day <= uptoDay);
}

/**
 * The briefing for the latest close, covering the last `span` closed months
 * (1 or 3; clamped to the months there are): see Briefing. Stocks (cash,
 * subscribers, passings, take rate, CPP, debt) are compared at month end with
 * the report `span` months earlier; flows (net, revenue, operating cash flow)
 * sum the period and compare with the `span` months before it. Notices are
 * the period's (MonthlyReport.ops.lastNoticeId; by day for reports from
 * older saves). The forward look and covenant figures are today's (call it
 * right after the close). Null before the first close. Pure.
 */
/**
 * Whether a period notice needs the player (Briefing.needsAttention): its
 * kind is in ATTENTION_NOTICE_KINDS, and one about something the player can
 * have fixed before the close only while it still stands at the close: a
 * 'storm' or 'digIn' while a span is still out of service (a storm repaired
 * before the close is news, not something to act on), 'cabinetFull' while
 * its cabinet (Notice.cabinet; any, without one) is still in
 * Sales.fullCabinets, 'oltFull' while no PON port is free, 'installsPaused'
 * while installs are still paused.
 */
export function noticeNeedsAttention(state: GameState, notice: Pick<Notice, 'kind'> & Partial<Pick<Notice, 'cabinet'>>): boolean {
  if (!ATTENTION_NOTICE_KINDS.has(notice.kind)) return false;
  switch (notice.kind) {
    case 'storm':
    case 'digIn':
      return outageSpanIds(state).length > 0;
    case 'cabinetFull': {
      const full = state.sales.fullCabinets;
      return notice.cabinet === undefined || notice.cabinet === null ? full.length > 0 : full.includes(notice.cabinet);
    }
    case 'oltFull':
      return ponPortsUsed(state) >= state.network.olt.ponPorts;
    case 'installsPaused':
      return state.sales.installsPaused;
    default:
      return true;
  }
}

export function buildBriefing(state: GameState, span = 1): Briefing | null {
  const reports = state.finance.reports;
  const report = reports.at(-1);
  if (!report) return null;
  const months = Math.max(1, Math.min(Math.floor(span) || 1, reports.length));
  const period = reports.slice(reports.length - months);
  const earlier = reports.slice(Math.max(0, reports.length - 2 * months), reports.length - months);
  const previous = reports[reports.length - 1 - months] ?? null;

  const kpis = reportKpis(report);
  const prevKpis = previous ? reportKpis(previous) : null;
  const flows = sumFlows(period);
  const prevFlows = earlier.length === months ? sumFlows(earlier) : null;
  const cpp = kpis?.cpp ?? costPerPassing(state.finance.capex.osp, report.passings);
  const debt = totalDebt(state);

  const changes: BriefingChange[] = [
    change('net', 'Net cash flow', flows.net, prevFlows?.net ?? null, true, 'money'),
    change('cash', 'Cash', report.cashEnd, previous?.cashEnd ?? null, true, 'money'),
    change('subscribers', 'Subscribers', report.stats?.subscribers ?? null, previous?.stats?.subscribers ?? null, true, 'count'),
    change('passings', 'Passings', report.passings, previous?.passings ?? null, true, 'count'),
    change('takeRate', 'Take rate', kpis?.takeRate ?? null, prevKpis?.takeRate ?? null, true, 'ratio'),
    change('cpp', 'Cost per passing', cpp, prevKpis?.cpp ?? null, false, 'money'),
    change('revenue', 'Revenue', flows.revenue, prevFlows?.revenue ?? null, true, 'money'),
    change('operatingCashFlow', 'Operating cash flow', flows.operatingCashFlow, prevFlows?.operatingCashFlow ?? null, true, 'money'),
    change('debt', 'Debt', debtAt(report) ?? debt, debtAt(previous), false, 'money'),
  ];

  const sums = new Map<LedgerCategory, number>();
  for (const r of period) {
    for (const [category, amount] of Object.entries(r.totals) as [LedgerCategory, number][]) {
      sums.set(category, (sums.get(category) ?? 0) + amount);
    }
  }
  const breakdown = [...sums]
    .filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => CATEGORY_RANK[a] - CATEGORY_RANK[b])
    .map(([category, amount]) => ({ category, amount }));

  const nextPayment = estimateNextDebtService(state);
  const sweep = estimateSweep(state);
  const notices = periodNotices(state, report, previous);
  const advice = advise(state);

  return {
    report,
    previous,
    span: months,
    label: periodLabel(period[0] as MonthlyReport, report),
    headline: {
      net: flows.net,
      cash: report.cashEnd,
      subscribers: report.stats?.subscribers ?? null,
      passings: report.passings,
      takeRate: kpis?.takeRate ?? null,
      cpp,
      cppBand: cpp === null ? null : cppBand(cpp),
      cppTarget: CPP_TARGET,
      debt,
      stage: state.debt.covenant.stage,
      covenant: covenantMetrics(state),
    },
    changes,
    notices,
    breakdown,
    forward: {
      nextCloseDay: nextCloseDay(state.day),
      nextPayment,
      projectedCash: estimateCashAtClose(state) - nextPayment - sweep,
      sweep,
      runwayMonths: runwayMonths(state),
      closesUntilCalled: closesUntilAcceleration(state),
      accelerationClosesLeft: state.debt.acceleration?.closesLeft ?? null,
    },
    advice,
    needsAttention: advice.some((a) => a.severity === 'urgent') || notices.some((n) => noticeNeedsAttention(state, n)),
  };
}
