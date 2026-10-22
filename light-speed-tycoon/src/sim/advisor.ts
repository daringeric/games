// The month-end briefing and the advisor (round 4): everything pertinent
// about the period that just closed, and 1-3 ranked suggestions, each with a
// plain-language reason built from the game's figures and an action the UI
// can perform ("Show me": move the camera to a cabinet or street, or open the
// Pricing, Bank, OLT or Customers panel).
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
// - Round 4c/4d (spec B): the card is short. `title` is at most
//   ADVICE_TITLE_MAX characters and `why` one plain sentence of at most
//   ADVICE_WHY_MAX that names the cost when there is one ("It's full and 12
//   homes are waiting. Costs $1,800."), with no jargon (no covenant,
//   leverage, OCF, CPP); each rule offers its wordings longest first and
//   fitText takes the first that fits. The longer reasoning (the figures:
//   dollars via finance.formatMoney, rates and multiples via
//   debt.formatRateBps / formatMultiple, places via streets.cornerName;
//   the financing, the alternatives, the cure text) is in `detail`, and
//   `cost` is what following it costs (a purchase's price; a month's extra
//   for a running cost), else null.
//
// Round 4b (briefing-advisor-polish workstream; the contract added the
// frame): every Advice has a key (its rule and subject: ADVICE_KEYS) and a
// repeat count (briefings in a row that showed it, from AdvisorState.shown);
// a repeat is never worded word for word (rewordRepeat: "Still open since
// the Mar 2028 briefing (3rd briefing in a row)." ahead of the detail, round
// 4c/4d). A snoozed key (AdvisorState.snoozes, the snoozeAdvice command) is
// left out of advise() until its snooze ends or its severity rises, and
// claims nothing in advicePlans (a later rule does not count its spend); a
// rule with several subjects (a cabinet, a span, a street, a tier, a corner)
// passes over a snoozed subject to the next one. The commands' bookkeeping
// (snoozeAdvice, noteAdviceShown) is here too. Also round 4b: expand keeps a
// real reserve (running costs, loan payments and installs, the new area's
// installs and the funding cushion), builds exactly coverage.buildOutPlan
// (or, round 4c/4d, a smaller plan of it that fits the cash:
// coverage.smallerBuildPlan) and borrows only EXPAND_COVENANT_HEADROOM
// inside the covenants; incumbentPromo says only what
// incumbent.bestIncumbentAnswer says (or that the promo ends on its own) and
// clears once answered; stormUnderground points only at exposed streets
// (weather.exposureBand).
//
// Round 4c/4d (spec B, I.6): advice at every budget. firstBuild gives a new
// company a concrete first build sized to its cash; expand ranks every
// candidate corner and prices enough of them (smaller builds included) to
// find one the cash covers; growCustomers weighs marketing, a neighborhood
// campaign, referral credits and new fiber per customer (growthOptions) and
// says plainly when growing on what you built is cheaper than building; the
// support and lineup rules cover the new levers; cashRunway never lends into
// a network that cannot break even. While cash burns the summary always has
// a next step: firstBuild until something is lit, then growCustomers (with
// a lever, or what more customers would do) beside the rest.
//
// Cost: advise() runs at every close (the briefing), so the heavy reads are
// bounded: expand and firstBuild price at most EXPAND_PRICE_MAX corners
// (coverage.buildOutPlan) and try at most SMALLER_CANDIDATES_MAX smaller
// plans, stormUnderground tests at most STORM_CANDIDATES_MAX spans and
// outages at most OUTAGE_CANDIDATES_MAX spans (a coverage run each),
// growCustomers quotes at most CAMPAIGN_QUOTES_MAX areas (two customer
// forecasts each) beside one forecast per other lever, and the corners are
// ranked by a street walk of CABINET_REACH_FT from each
// (streets.segmentsWithin); the rest are a pass over accounts or parcels, or
// the debt reads' few bisections. Shared reads are taken once per call.

import {
  ADVICE_SNOOZE_MONTHS,
  ADVICE_SNOOZE_URGENT_MONTHS,
  AWARENESS_ON_LIT,
  BANK_WATCH_HEADROOM,
  CABINET_COST,
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  CONVERT_PAYBACK_YEARS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  CUSTOMER_QUOTE_MONTHS,
  EXPAND_COVENANT_HEADROOM,
  EXPAND_INSTALL_MONTHS,
  EXPAND_RESERVE_MONTHS,
  FROZEN_SWEEP_SHARE,
  GROWTH_PAYBACK_MONTHS,
  GROWTH_TRIM_FACTOR,
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_CHURN,
  LOAN_ROUNDING,
  MARKETING_MAX_PER_MONTH,
  MAX_SPLITTERS_PER_CABINET,
  OLT_MAX_CARDS,
  OLT_PORTS_PER_CARD,
  OVERHEAD_PER_CABINET_PER_MONTH,
  OVERHEAD_PER_MILE_PER_MONTH,
  POLE_RENT_PER_POLE_PER_MONTH,
  REFERRAL_CREDIT,
  SPLITTER_COST,
  SPLIT_RATIO,
  STORM_LOG_DAYS,
  STORM_REPAIRS_CONVERT_SHARE,
  SUPPORT_LEVELS,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  TIER_DEFAULTS,
  UNDERGROUND_COST_PER_FT,
} from './balance';
import { buildOutPlan, cheapestBuild, coveragePreview, smallerBuildPlan } from './coverage';
import { dateOf, DAYS_PER_YEAR, dayOf, formatDate, formatMonth, MONTH_ABBR, MONTH_LENGTHS } from './calendar';
import {
  MARKETING_STEP,
  PROMO_BOOST_YOUNG_DAYS,
  awarenessGainPerDay,
  awarenessOf,
  customerAreas,
  dealFactor,
  dealFactors,
  forecastCustomers,
  happinessReport,
  marketingAwarenessPerDay,
  quoteCampaign,
  quoteSupport,
  switchRate,
} from './customers';
import type { CustomerForecast } from './customers';
import {
  acceleratedSchedule,
  closesUntilAcceleration,
  covenantMetrics,
  cureBeatsCall,
  cureFor,
  covenantsWithin,
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
import { estimateCashAtClose, formatMoney, groupThousands, monthlyBurn, monthlyPoleRent, runwayMonths } from './finance';
import { activePromos, bestIncumbentAnswer } from './incumbent';
import { costPerPassing, cppBand, operatingCashFlow, passingsWeightedRate, REPAIR_TRAILING_MONTHS, reportKpis, trailingRepairs } from './metrics';
import { getService, orderFees, outageImpact, outageService, plannedService, ponPortsUsed, quoteConvert, quoteOltCard, quoteSplitter } from './network';
import { fixedCostsPerMonth, fixedOverheadLines, perCustomerCost } from './overhead';
import {
  accountUnits,
  cabinetPortCapacity,
  closeDayAfter,
  cabinetPortsUsed,
  churnProbability,
  installCost,
  promoSignupFactor,
  segmentDemand,
  segmentOffset,
  stateTakeRate,
  subscriberUnits,
  targetTakeRate,
  unitsByTier,
} from './sales';
import { cornerName, parcelsServedBy, polesOnSegment, segmentsWithin } from './streets';
import { cityExposure, cutOffOf, exposureBand, nearestCorner, outageChurnFor, outageSpanIds, repairCost } from './weather';
import type {
  Advice,
  AdviceAction,
  AdviceId,
  AdvicePanel,
  AdviceSeverity,
  AdviceShown,
  AdviceSnooze,
  AttentionItem,
  BuildOutPlan,
  AdvisorState,
  Briefing,
  BriefingMoney,
  BriefingMoneyGroup,
  BriefingStory,
  CableMethod,
  BriefingChange,
  BriefingChangeKey,
  Cabinet,
  CabinetId,
  CableSpan,
  Command,
  CommandResult,
  CovenantMetrics,
  FundingHint,
  GameState,
  GrowthOption,
  IncumbentPromo,
  LedgerCategory,
  MoneyGroupKey,
  MoneyLine,
  MoneyLineKey,
  NodeId,
  MonthlyReport,
  Notice,
  NoticeKind,
  ParcelId,
  ParcelKind,
  Pricing,
  SegmentId,
  ServiceSnapshot,
  SpanId,
  SupportLevel,
  TermYears,
  TierId,
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
  'lineup',
  'support',
  'growCustomers',
  'redCpp',
  'firstBuild',
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
  /** Round 4c/4d: a new company's first build leads (nothing else matters until homes can sign up). */
  firstBuild: 235,
  addOltCardNeeded: 230,
  addSplitterShort: 225,
  addSplitterNearlyFull: 220,
  redCppWithDebt: 215,
  outages: 210,
  incumbentPromo: 205,
  /** Round 4c/4d: the cheap tiers dropped turns a whole segment of homes away. */
  lineup: 190,
  stormUnderground: 180,
  /** Round 4c/4d: a lever that signs homes up on your streets for less than new fiber. */
  growCustomers: 175,
  takeRate: 170,
  /** Round 4c/4d: Great support pays where outages and waits drive cancellations (or Basic costs customers). */
  support: 165,
  pricing: 160,
  addOltCardNearlyFull: 150,
  redCpp: 150,
  expandCash: 140,
  expandLoan: 125,
  /** Round 4c/4d: the first cabinet is being built: what comes next (no command). */
  firstBuildWait: 120,
  incumbentPromoRideOut: 110,
  /** Round 4c/4d: cash burns and no lever is worth it yet: what more customers would do (no command). */
  growCustomersHint: 105,
} as const;

/** Round 4c/4d (spec B): an Advice.title is at most this many characters ... */
export const ADVICE_TITLE_MAX = 45;
/** ... and its `why` one sentence of at most this many (the month summary's next-step card). */
export const ADVICE_WHY_MAX = 90;
/** Round 4c/4d: the month summary shows at most this many "Needs attention" lines (Briefing.attention). */
export const ATTENTION_MAX = 2;

// Rule thresholds (rules, not balance, unless marked TUNING).

/** covenantCure: a breach at today's figures is urgent when the next close is this many days away or fewer. */
export const URGENT_CLOSE_DAYS = 10;
/**
 * covenantCure: compliant but within this share of a limit (leverage above 90% of the maximum, coverage below 110% of the minimum) is "at risk".
 * Round 4c/4d: the Bank's 'watch' health uses the same margin (balance.BANK_WATCH_HEADROOM).
 */
export const COVENANT_RISK_MARGIN = BANK_WATCH_HEADROOM;
/** cashRunway: runway (finance.runwayMonths) at or below this with no safe financing is urgent ... */
export const RUNWAY_URGENT_MONTHS = 2;
/** ... and at or below this is important. */
export const RUNWAY_WARN_MONTHS = 4;
/** cashRunway: financing is sized to add this many months of burn (one month when that much is not safe). */
export const RUNWAY_FUND_MONTHS = 2;
/**
 * cashRunway and the purchases (addSplitter, addOltCard): the financing they
 * suggest leaves the covenants at least this share inside their limits
 * (debt.fundingHint's headroom), as expand's loan does, and more than
 * COVENANT_RISK_MARGIN, so following it never brings on covenantCure's
 * "Keep clear of the covenant limits" card (round 4b review). paymentShort
 * keeps 0: a missed payment is worse than that warning.
 */
export const SUGGESTED_BORROWING_HEADROOM = EXPAND_COVENANT_HEADROOM;
/** cashRunway without safe financing: the marketing budget it suggests is this share of today's (rounded down to MARKETING_CUT_ROUNDING). */
export const MARKETING_CUT_SHARE = 0.5;
export const MARKETING_CUT_ROUNDING = 100;
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
 * ... counting areas lit at least this many months (a lit street's homes
 * switch over years: a younger area is still ramping, not lagging) ...
 */
export const TAKE_RATE_MATURE_MONTHS = 18;
/** ... with at least this many units passed there ... */
export const TAKE_RATE_MIN_PASSINGS = 50;
/**
 * ... and only while the lineup's deal makes homes switch slower than the
 * default prices do (customers.dealFactor for households at cable's standard
 * price below this). Round 4c/4d: marketing, campaigns and referral credits
 * are growCustomers' to weigh, so the take-rate tip is about prices only.
 */
export const TAKE_RATE_SLOW_DEAL = 0.9;
/** lineup: offering the dropped cheap tiers again must raise the households' target take rate by at least this (or serve a segment no tier suits). */
export const LINEUP_MIN_GAIN = 0.02;
/** pricing: an offered tier more than this share from its market reference (TIER_DEFAULTS price). */
export const PRICE_BAND_SHARE = 0.2;
/** expand: not while the runway (finance.runwayMonths, when burning) is shorter than this. */
export const EXPAND_MIN_RUNWAY_MONTHS = 6;
/** expand: candidate corners lie within this many CABINET_REACH_FT of the planned plant ... */
export const EXPAND_REACH_MULTIPLE = 2;
/** ... at least CABINET_REACH_FT from every planned cabinet; expandCandidates returns this many of them (rankedCorners ranks them all) ... */
export const EXPAND_CANDIDATES_MAX = 6;
/** ... and a suggestion passes at least this many units not served today. */
export const EXPAND_MIN_PASSINGS = 25;
/**
 * expand / firstBuild (round 4c/4d, spec B): price at least
 * EXPAND_CANDIDATES_MAX of the ranked corners, then go on down the ranking
 * until one the cash covers turns up, at most this many in all (a
 * buildOutPlan each).
 */
export const EXPAND_PRICE_MAX = 24;
/** expand / firstBuild: when no whole build-out fits, a smaller plan (coverage.smallerBuildPlan) is tried at this many of the best-ranked corners ... */
export const SMALLER_CANDIDATES_MAX = 4;
/** ... and at this many for a first build (once per game: which corner a small purse starts from decides how many customers it gets). */
export const FIRST_BUILD_SMALLER_MAX = 16;
/** expand / firstBuild: the reserve covers the deepest the cash falls over this many months of the new area's ramp (rampTrough). */
export const TROUGH_MONTHS = 36;
/** growCustomers: lit areas count as under-signed while their subscribed units are below this share of their target ... */
export const GROW_UNDER_SIGNED_SHARE = 0.8;
/** ... and at least this many units are still to sign up there. */
export const GROW_MIN_GAP_UNITS = 10;
/** growthOptions: an option is worth weighing when it brings at least this many customers within CUSTOMER_QUOTE_MONTHS. */
export const GROW_MIN_CUSTOMERS = 2;
/** growthOptions: at most this many cabinet areas get a campaign quote (the most households not signed up first). */
export const CAMPAIGN_QUOTES_MAX = 2;
/** support: at least this many subscribed units before support advice ... */
export const SUPPORT_MIN_UNITS = 20;
/** ... and on Good, Great is suggested when at least this share of them are unhappy mainly about service (outages, install waits). */
export const SUPPORT_SERVICE_SHARE = 0.05;

// ---------------------------------------------------------------------------
// Advice frame
// ---------------------------------------------------------------------------

/**
 * One rule's suggestion with what it would have the player do: `commands`
 * in order (financing first, then the purchase or repayment), each verified
 * pro forma by the rule (empty when it suggests no command). `spend` is the
 * cash the suggestion takes out (purchases, repayments and `extraSpend`;
 * money it borrows not netted), `extraSpend` the part of it beyond its
 * commands (round 4c/4d: a running cost's first EXPAND_RESERVE_MONTHS
 * months: more marketing, referral credits, Great support), and `keep` the
 * cash it promises to leave after everything (expand: its reserve; 0 when it
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
 * Claims, so every plan returned can be followed together. Round 4b: each
 * advice carries its repeat count (repeatOf), and snoozed suggestions
 * (isSnoozed) are left out and claim nothing.
 */
export function advicePlans(state: GameState): AdvicePlan[] {
  return planAll(state).plans;
}

/**
 * advicePlans and the number of rules that fired but are snoozed
 * (isSnoozed: left out, claiming nothing). `includeSnoozed` keeps them (for
 * snoozeAdvice, which needs the suggestion's current severity).
 */
function planAll(state: GameState, includeSnoozed = false): { plans: AdvicePlan[]; snoozed: number } {
  if (state.gameOver) return { plans: [], snoozed: 0 };
  const r = readingsOf(state, !includeSnoozed);
  const found: AdvicePlan[] = [];
  let snoozed = 0;
  for (const id of ADVICE_ORDER) {
    const made = RULES[id](state, r);
    if (!made) continue;
    const plan = { ...made, advice: rewordRepeat(state, { ...made.advice, repeat: repeatOf(state, made.advice.key) }) };
    if (!includeSnoozed && isSnoozed(state, plan.advice)) {
      snoozed++;
      continue;
    }
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
  // Subjects a rule passed over because they are snoozed count as snoozed too.
  return { plans: found.sort((a, b) => b.advice.priority - a.advice.priority || rank(a.advice.id) - rank(b.advice.id)), snoozed: snoozed + r.skipped.size };
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

/**
 * One rule's plan on `state` on its own (no earlier claims, snoozes ignored:
 * the rule's best subject; repeats worded as advicePlans words them), or null
 * when it does not fire (or the game is over). For tests and tools.
 */
export function planFor(state: GameState, id: AdviceId): AdvicePlan | null {
  if (state.gameOver) return null;
  const made = RULES[id](state, readingsOf(state, false));
  return made ? { ...made, advice: rewordRepeat(state, { ...made.advice, repeat: repeatOf(state, made.advice.key) }) } : null;
}

/**
 * Advice keys by rule (Advice.key): the rule id, then its subject.
 * `addSplitter:cabinet:<id>`, `addOltCard`, `outages:segment:<id>`,
 * `stormUnderground:span:<id>`, `incumbentPromo:cabinet:<id>`, `takeRate`,
 * `pricing:<tierId>`, `redCpp`, `expand:node:<id>`, and the rule id alone for
 * paymentShort, loansCalled, covenantCure, frozenSweep and cashRunway. Round
 * 4c/4d: `lineup:<tierId>` (the cheapest tier it puts back),
 * `support:<level>` (the level it suggests), `growCustomers:<lever>` and
 * `growCustomers:campaign:<cabinet>` (`growCustomers:hint` for the card with
 * no lever), `firstBuild:node:<id>` (`firstBuild` while the first cabinet
 * is being built).
 */
export const ADVICE_KEYS = {
  addSplitter: (cabinet: CabinetId) => `addSplitter:cabinet:${cabinet}`,
  outages: (segment: SegmentId) => `outages:segment:${segment}`,
  stormUnderground: (span: SpanId) => `stormUnderground:span:${span}`,
  incumbentPromo: (cabinet: CabinetId) => `incumbentPromo:cabinet:${cabinet}`,
  pricing: (tier: string) => `pricing:${tier}`,
  expand: (node: NodeId) => `expand:node:${node}`,
  lineup: (tier: TierId) => `lineup:${tier}`,
  support: (level: SupportLevel) => `support:${level}`,
  growCustomers: (lever: 'marketing' | 'referrals' | 'hint' | 'campaign', cabinet?: CabinetId) =>
    lever === 'campaign' ? `growCustomers:campaign:${cabinet ?? 0}` : `growCustomers:${lever}`,
  firstBuild: (node: NodeId) => `firstBuild:node:${node}`,
} as const;

/** "1st", "2nd", "3rd", "4th", ..., "11th", "12th", "13th", "21st" */
function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/**
 * A repeat (advice.repeat >= 1) worded so it never reads word for word like
 * the briefing before: "Still open since the Mar 2028 briefing (3rd briefing
 * in a row)." ahead of the detail (round 4c/4d: the card's short `why`
 * stays as it is; the note leads the longer reasoning behind it), the month
 * the run's first briefing covered (a briefing on a close day covers the
 * month before it). The count grows each briefing, so no two in a row
 * match. New advice is unchanged.
 */
export function rewordRepeat(state: GameState, advice: Advice): Advice {
  if (advice.repeat < 1) return advice;
  const entry = state.advisor.shown.find((e) => e.key === advice.key);
  const nth = `${ordinal(advice.repeat + 1)} briefing in a row`;
  let lead = `Still open (${nth}).`;
  if (entry) {
    const first = dateOf(entry.firstDay);
    const covered = first.day === 1 && entry.firstDay > 0 ? dateOf(entry.firstDay - 1) : first;
    lead = `Still open since the ${formatMonth(covered.year, covered.month)} briefing (${nth}).`;
  }
  return { ...advice, detail: advice.detail.length > 0 ? `${lead} ${advice.detail}` : lead };
}

// ---------------------------------------------------------------------------
// Snoozes and repeats (round 4b; saved in GameState.advisor)
// ---------------------------------------------------------------------------

/** Longest Advice.key. */
export const ADVICE_KEY_MAX_LENGTH = 64;
/** Most entries AdvisorState.snoozes and AdvisorState.shown each keep (the oldest-ending snoozes and the oldest shown go first). */
export const ADVISOR_MEMORY_MAX = 32;
/** Most keys one noteAdviceShown may carry. */
export const ADVICE_SHOWN_MAX = 16;

/** The advisor of a new game (and of saves from before round 4b): nothing snoozed, nothing shown. */
export function newAdvisorState(): AdvisorState {
  return { snoozes: [], shown: [] };
}

/** A key snoozeAdvice / noteAdviceShown accept: 1..ADVICE_KEY_MAX_LENGTH characters, no whitespace or control characters. */
export function isAdviceKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= ADVICE_KEY_MAX_LENGTH && !/[\s\u0000-\u001f\u007f]/.test(value);
}

const SEVERITY_RANK: Readonly<Record<AdviceSeverity, number>> = { tip: 0, important: 1, urgent: 2 };

/** Whether `advice` is snoozed today: a snooze on its key that has not ended (day < untilDay), at a severity no lower than its own. */
export function isSnoozed(state: GameState, advice: Pick<Advice, 'key' | 'severity'>): boolean {
  const snooze = state.advisor.snoozes.find((s) => s.key === advice.key);
  return snooze !== undefined && state.day < snooze.untilDay && SEVERITY_RANK[advice.severity] <= SEVERITY_RANK[snooze.severity];
}

/**
 * Advice.repeat for `key`: the briefings in a row that showed it before
 * today's (AdvisorState.shown: its times, less one when the latest of them
 * is today's own briefing); 0 when the latest briefing did not show it.
 */
export function repeatOf(state: GameState, key: string): number {
  const shown = state.advisor.shown;
  const entry = shown.find((e) => e.key === key);
  if (!entry) return 0;
  let latest = 0;
  for (const e of shown) latest = Math.max(latest, e.lastDay);
  if (entry.lastDay !== latest) return 0;
  return entry.lastDay === state.day ? entry.times - 1 : entry.times;
}

/**
 * snoozeAdvice command: hide the suggestion with Advice.key `key` (it must
 * be one advise() would show today, snoozed or not) until the close
 * ADVICE_SNOOZE_MONTHS closes on (ADVICE_SNOOZE_URGENT_MONTHS for an urgent
 * one: sales.closeDayAfter(day, n)), remembering its severity (a higher one
 * shows again at once). Replaces any snooze on the key; drops ended
 * snoozes; keeps at most ADVISOR_MEMORY_MAX, always this one (the
 * soonest-ending of the others go first), ascending key. Free: { ok: true, cost: 0 }. Rejects (state untouched) a key
 * that is not isAdviceKey or not a current suggestion.
 */
export function snoozeAdvice(state: GameState, key: string): CommandResult {
  if (!isAdviceKey(key)) return { ok: false, reason: `Not a suggestion key: ${JSON.stringify(key)}` };
  // What advise() shows (a rule may show its next subject past a snoozed one), else what fires, snoozed or not.
  const plan = planAll(state).plans.find((p) => p.advice.key === key) ?? planAll(state, true).plans.find((p) => p.advice.key === key);
  if (!plan) return { ok: false, reason: 'That suggestion no longer applies' };
  const months = plan.advice.severity === 'urgent' ? ADVICE_SNOOZE_URGENT_MONTHS : ADVICE_SNOOZE_MONTHS;
  const snooze: AdviceSnooze = { key, untilDay: closeDayAfter(state.day, Math.max(1, months)), severity: plan.advice.severity };
  // The new snooze is always kept: when the memory is full, the soonest-ending of the others go.
  let others = state.advisor.snoozes.filter((s) => s.key !== key && s.untilDay > state.day);
  if (others.length > ADVISOR_MEMORY_MAX - 1) {
    others.sort((a, b) => b.untilDay - a.untilDay || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    others = others.slice(0, ADVISOR_MEMORY_MAX - 1);
  }
  state.advisor.snoozes = [...others, snooze].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, cost: 0 };
}

/**
 * noteAdviceShown command: a month-end briefing on state.day showed these
 * keys (the UI sends it once per close-time briefing). For each key: an
 * entry the previous briefing showed (its lastDay is the latest lastDay
 * before today) runs on (times + 1, lastDay = today); one already noted
 * today is unchanged; any other starts a run (times 1). Entries not shown
 * today are dropped (the run broke). Ascending key, at most
 * ADVICE_SHOWN_MAX keys per call (each isAdviceKey, no duplicates; else
 * rejected, state untouched). Free: { ok: true, cost: 0 }.
 */
export function noteAdviceShown(state: GameState, keys: readonly string[]): CommandResult {
  if (keys.length > ADVICE_SHOWN_MAX) return { ok: false, reason: `At most ${ADVICE_SHOWN_MAX} suggestions per briefing` };
  for (const key of keys) if (!isAdviceKey(key)) return { ok: false, reason: `Not a suggestion key: ${JSON.stringify(key)}` };
  if (new Set(keys).size !== keys.length) return { ok: false, reason: 'A suggestion is listed twice' };
  const day = state.day;
  const old = state.advisor.shown;
  let previous = -1;
  for (const e of old) if (e.lastDay < day) previous = Math.max(previous, e.lastDay);
  const next: AdviceShown[] = [];
  for (const key of keys) {
    const entry = old.find((e) => e.key === key);
    if (entry && entry.lastDay === day) next.push(entry);
    else if (entry && entry.lastDay === previous) next.push({ key, firstDay: entry.firstDay, lastDay: day, times: entry.times + 1 });
    else next.push({ key, firstDay: day, lastDay: day, times: 1 });
  }
  // A second briefing the same day (another close cannot happen) keeps what the first noted.
  for (const e of old) if (e.lastDay === day && !keys.includes(e.key)) next.push(e);
  state.advisor.shown = next.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).slice(0, ADVISOR_MEMORY_MAX);
  return { ok: true, cost: 0 };
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
  /** A month of fixed costs as the funding cushion counts them (overhead.fixedCostsPerMonth: overhead + the marketing budget). */
  fixed: () => number;
  closeDay: () => number;
  portsUsed: () => Map<CabinetId, number>;
  waiting: () => Map<CabinetId, number>;
  subscribed: () => Map<ParcelId, number>;
  splitterCandidates: () => SplitterCandidate[];
  /** Round 4c/4d: the customers model played forward at today's settings (customers.forecastCustomers), shared by the growth levers. */
  forecast: () => CustomerForecast;
  /** Round 4c/4d: lit areas' subscribed units against their target (growCustomers' "under-signed"). */
  signed: () => SignedUp;
  /** Round 4c/4d: the operating cash flow a month the network reaches once its streets are signed up to target (matureMonthlyFlow). */
  mature: () => number;
  /** Round 4c/4d: the best build the cash covers (chooseBuild for expand, or for firstBuild on a new company), with snoozes as the call treats them. */
  build: () => BuildChoice | null;
  /** Round 4c/4d: the growth levers (growthOptions) and what they were weighed against. */
  growth: () => Growth;
  /** Round 4c/4d: every corner rankedCorners considers, estimated once per call. */
  corners: () => CornerEstimate[];
  /** Round 4c/4d: coverage.buildOutPlan at a corner, priced once per call. */
  buildOut: (node: NodeId) => BuildOutPlan;
  /** Round 4c/4d: rampShares over TROUGH_MONTHS for a network of `passings`, once per call and size. */
  ramp: (passings: number) => number[];
  /** What earlier rules of this call claimed (mutable: advicePlans adds each plan). */
  claims: Claims;
  /**
   * Whether a rule with several subjects should pass over this one: snoozed
   * (isSnoozed) when the call respects snoozes (advicePlans), never for
   * planFor and snoozeAdvice's look-up. A subject passed over is added to
   * `skipped` (it counts in Briefing.snoozed).
   */
  passOver: (advice: Pick<Advice, 'key' | 'severity'>) => boolean;
  /** passOver without counting the subject as skipped (a look-ahead that may not end up shown). */
  isPassed: (advice: Pick<Advice, 'key' | 'severity'>) => boolean;
  skipped: Set<string>;
}

function readingsOf(state: GameState, respectSnoozes = true): Readings {
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
    fixed: once(() => fixedCostsPerMonth(state)),
    closeDay: once(() => nextCloseDay(state.day)),
    portsUsed,
    waiting,
    subscribed,
    splitterCandidates: once(() => splitterCandidates(state, portsUsed(), waiting())),
    forecast: once(() => forecastCustomers(state)),
    signed: once(() => signedUp(state, service(), subscribed())),
    mature: once(() => matureMonthlyFlow(state, r)),
    build: (() => {
      // Keyed on what earlier rules claimed: growCustomers weighs the build before expand runs, and expand must see its own claims.
      let memo: { key: string; choice: BuildChoice | null } | null = null;
      return () => {
        const key = `${r.claims.spend}:${r.claims.borrowed}:${r.claims.holdBorrowing}`;
        if (!memo || memo.key !== key) memo = { key, choice: chooseBuild(state, r) };
        return memo.choice;
      };
    })(),
    growth: once(() => growthWith(state, r)),
    corners: once(() => cornerEstimates(state)),
    buildOut: (() => {
      const plans = new Map<NodeId, BuildOutPlan>();
      return (node: NodeId) => {
        let built = plans.get(node);
        if (!built) {
          built = buildOutPlan(state, node);
          plans.set(node, built);
        }
        return built;
      };
    })(),
    ramp: (() => {
      const ramps = new Map<number, number[]>();
      return (passings: number) => {
        let shares = ramps.get(passings);
        if (!shares) {
          shares = rampShares(state, passings, TROUGH_MONTHS);
          ramps.set(passings, shares);
        }
        return shares;
      };
    })(),
    claims: { spend: 0, borrowed: false, newDebt: false, holdBorrowing: false, paymentShort: false, cashShort: false },
    passOver: (advice) => {
      if (!r.isPassed(advice)) return false;
      r.skipped.add(advice.key);
      return true;
    },
    isPassed: (advice) => respectSnoozes && isSnoozed(state, advice),
    skipped: new Set<string>(),
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

/** Wordings of a title or a why, longest first (fitText takes the first that fits). */
type Wording = string | readonly string[];

/**
 * Round 4c/4d (spec B): the first wording of at most `max` characters; when
 * none fits, the last cut to `max` with an ellipsis (every rule ends its
 * list with a wording short enough, so this is a guard).
 */
export function fitText(max: number, wording: Wording): string {
  const list = typeof wording === 'string' ? [wording] : wording;
  for (const text of list) if (text.length <= max) return text;
  const last = list[list.length - 1] ?? '';
  return last.length <= max ? last : `${last.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** The first street of a corner name ("Elm St & 4th Ave" -> "Elm St"), for a title that would not fit with both. */
function firstStreet(place: string): string {
  return place.split(' & ')[0] ?? place;
}

/** "Costs $1,800." */
function costs(amount: number): string {
  return `Costs ${money(amount)}.`;
}

const PANEL_LABEL: Record<AdvicePanel, string> = { pricing: 'Open Pricing', bank: 'Open Bank', olt: 'Open OLT', customers: 'Open Customers' };

/** The severity of a priority's band. */
export function severityOf(priority: number): AdviceSeverity {
  return priority >= 300 ? 'urgent' : priority >= 200 ? 'important' : 'tip';
}

/** "Show me" for a place, "Open Pricing" / "Open Bank" / "Open OLT" / "Open Customers" for a panel. */
export function actionLabelOf(action: AdviceAction): string {
  return action.kind === 'openPanel' ? PANEL_LABEL[action.panel] : 'Show me';
}

/** Advice.detail and Advice.cost (round 4c/4d). */
interface AdviceMore {
  detail?: string;
  cost?: number | null;
}

/**
 * An Advice. `key` defaults to the rule's id (round 4b: rules give a key
 * naming their subject, e.g. `addSplitter:cabinet:12`); `repeat` is filled
 * in by advicePlans (repeatOf). Round 4c/4d: the title and why are fitted to
 * ADVICE_TITLE_MAX / ADVICE_WHY_MAX (fitText over the rule's wordings), the
 * longer reasoning is `more.detail` and `more.cost` what following it costs.
 */
function makeAdvice(id: AdviceId, priority: number, title: Wording, why: Wording, action: AdviceAction, key: string = id, more: AdviceMore = {}): Advice {
  const cost = more.cost === undefined || more.cost === null ? null : Math.round(more.cost);
  return {
    id,
    key,
    repeat: 0,
    priority,
    severity: severityOf(priority),
    title: fitText(ADVICE_TITLE_MAX, title),
    why: fitText(ADVICE_WHY_MAX, why),
    detail: (more.detail ?? '').trim(),
    cost,
    action,
    actionLabel: actionLabelOf(action),
  };
}

function plan(advice: Advice, commands: Command[] = [], spend = 0, extraSpend = 0, keep = 0): AdvicePlan {
  return { advice, commands, spend, extraSpend, keep };
}

const BANK: AdviceAction = { kind: 'openPanel', panel: 'bank' };
const PRICING: AdviceAction = { kind: 'openPanel', panel: 'pricing' };
const OLT: AdviceAction = { kind: 'openPanel', panel: 'olt' };
const CUSTOMERS: AdviceAction = { kind: 'openPanel', panel: 'customers' };

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

/** What a Funding borrows in all. */
function borrowedBy(funding: Funding): number {
  return funding.draw + funding.termLoan;
}

/**
 * How a purchase of `cost` is paid, given what earlier rules claimed: the
 * fundingHint for it plus the earlier spend (so cash or the financing covers
 * both and keeps the cushion), the financing SUGGESTED_BORROWING_HEADROOM
 * inside the covenants; no financing once an earlier rule borrowed or said
 * not to borrow (Claims.holdBorrowing).
 * ", and cash covers it." / ": a $4,000 credit-line draw pays for it and
 * keeps a cushion, within the covenants." / null (nothing safe covers it).
 */
function purchaseFunding(state: GameState, r: Readings, cost: number): { text: string; commands: Command[]; cash: boolean; borrow: number } | null {
  const hint = fundingHint(state, cost + r.claims.spend, SUGGESTED_BORROWING_HEADROOM);
  if (hint.kind === 'cash') return { text: ', and cash covers it.', commands: [], cash: true, borrow: 0 };
  const funding = r.claims.borrowed || r.claims.holdBorrowing ? null : fundingOf(hint);
  if (!funding) return null;
  return { text: `: ${funding.phrase} pays for it and keeps a cushion, within the covenants.`, commands: funding.commands, cash: false, borrow: borrowedBy(funding) };
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
  const short = service - projected;
  const lead =
    `The ${close} close owes about ${money(service)} in loan payments, but cash there is projected at ${money(projected)}: ` +
    `${money(short)} short.`;
  // The month's outflows to the close as the "cost": the hint's shortfall is then the payment + cushion - projected cash.
  let funding = fundingOf(fundingHint(state, Math.max(0, state.finance.cash - projected)));
  if (funding) {
    const extra =
      (funding.draw > 0 ? quoteDraw(state, funding.draw).interestToClose : 0) +
      (funding.termLoan > 0 ? quoteTermLoan(state, funding.termLoan, funding.termYears).stubInterest : 0);
    if (projected + funding.draw + funding.termLoan < service + extra) funding = null;
  }
  const ends = state.debt.acceleration !== null || state.debt.covenant.stage === 'frozen';
  let next: string;
  if (funding) next = `${capitalize(funding.phrase)} now covers it with a cushion and stays within the covenants.`;
  else if (state.debt.acceleration !== null) {
    next = `The bank has called your loans, so a close that cannot pay is a default that ends the game: ${cutSpending(state)} until it is paid.`;
  } else if (state.debt.covenant.stage === 'frozen') {
    next = `Your credit line is frozen, so a missed payment is a default that ends the game: ${cutSpending(state)} until it is paid.`;
  } else {
    next = `No covenant-safe borrowing covers it: ${cutSpending(state)}, or a missed payment freezes the credit line and adds a late fee.`;
  }
  const why: Wording = funding
    ? [
        `The ${close} close is ${money(short)} short of its loan payment: borrow ${money(borrowedBy(funding))} now.`,
        `You're ${money(short)} short of the ${close} loan payment: borrow ${money(borrowedBy(funding))}.`,
      ]
    : ends
      ? [`The ${close} close is ${money(short)} short of its loan payment, and missing it ends the game.`, `You're ${money(short)} short of the ${close} loan payment; missing it ends the game.`]
      : [`The ${close} close is ${money(short)} short of its loan payment: cut spending now.`, `You're ${money(short)} short of the ${close} loan payment: cut spending.`];
  const advice = makeAdvice('paymentShort', ADVICE_PRIORITY.paymentShort, [`Cover the ${close} loan payment`, 'Cover the next loan payment'], why, BANK, 'paymentShort', {
    detail: `${lead} ${next}`,
  });
  return plan(advice, funding?.commands ?? []);
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
  const title = left <= 1 ? [`Repay all ${money(debt)} at the ${close} close`, `Repay all ${money(debt)} you owe`] : [`Repay ${money(debt)} over the next ${left} closes`, `Repay ${money(debt)} you owe`];
  const why: Wording =
    projected < due
      ? [`The bank wants ${money(due)} back at the ${close} close, more than you'll have: cut spending.`, `The bank wants ${money(due)} at the ${close} close: cut spending.`]
      : [`The bank wants all ${money(debt)} back, ${money(due)} of it at the ${close} close.`, `The bank wants ${money(due)} back at the ${close} close.`];
  return plan(makeAdvice('loansCalled', ADVICE_PRIORITY.loansCalled, title, why, BANK, 'loansCalled', { detail: `${lead} ${next}` }));
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
 * more". Open Bank. Round 4c/4d: the card speaks of "the bank's checks";
 * the covenant figures are in its detail.
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
    const growWhy: Wording = [
      `You fail the bank's checks and can't repay enough: grow profit and don't borrow.`,
      `You fail the bank's checks: grow profit and don't borrow.`,
    ];
    if (!option) {
      const detail = `${lead} No single repayment cures it: grow operating cash flow (more subscribers, lower costs) and do not borrow more.`;
      return plan(makeAdvice('covenantCure', priority, "Grow cash flow to pass the bank's checks", growWhy, BANK, 'covenantCure', { detail }));
    }
    let title: Wording;
    let why: Wording;
    let commands: Command[] = [];
    if (option.kind === 'repayAll') {
      title = [`Repay all ${money(option.amount)} you owe`, 'Repay everything you owe'];
      commands = repayAllCommands(state);
      why = !inTime
        ? ['Only repaying everything you owe stops the bank calling your loans.']
        : [`You fail the bank's checks, and repaying everything you owe clears them.`];
    } else if (option.kind === 'repayCredit') {
      title = [`Repay ${money(option.amount)} of the credit line`, `Repay ${money(option.amount)} of the line`];
      commands = [{ type: 'repayCredit', amount: option.amount }];
      why = [`At today's figures you fail the bank's checks; repaying ${money(option.amount)} fixes that.`, `You fail the bank's checks; this repayment fixes that.`];
    } else if (option.kind === 'prepayLoan' && option.loan !== null) {
      const loan = state.debt.loans.find((l) => l.id === option.loan);
      title = loan && option.amount >= loan.balance ? `Pay off term loan #${option.loan}` : [`Prepay ${money(option.amount)} of term loan #${option.loan}`, `Prepay ${money(option.amount)} of a term loan`];
      commands = [{ type: 'prepayLoan', loan: option.loan, amount: option.amount }];
      why = [`At today's figures you fail the bank's checks; repaying ${money(option.amount)} fixes that.`, `You fail the bank's checks; this repayment fixes that.`];
    } else {
      // On the same basis as its text: today's operating cash flow raised to this.
      const to = Math.round(option.after.annualOperatingCashFlow / LOAN_ROUNDING) * LOAN_ROUNDING;
      title = [`Raise cash flow to about ${money(to)} a year`, "Grow cash flow to pass the bank's checks"];
      why = growWhy;
    }
    const spend = commands.length > 0 ? state.finance.cash - option.cashAfter : 0;
    return plan(makeAdvice('covenantCure', priority, title, why, BANK, 'covenantCure', { detail: `${lead} ${option.text}` }), commands, spend);
  }
  const leverageNear = m.totalDebt > 0 && m.leverage !== null && m.leverage > COVENANT_MAX_LEVERAGE * (1 - COVENANT_RISK_MARGIN);
  const coverageNear = m.coverage !== null && m.coverage < COVENANT_MIN_COVERAGE * (1 + COVENANT_RISK_MARGIN);
  if (!leverageNear && !coverageNear) return null;
  const hold = r.claims.newDebt
    ? 'Beyond the borrowing suggested above (it covers the payment and stays within the covenants), hold off on new borrowing and keep cash flow growing'
    : 'Hold off on new borrowing and keep cash flow growing';
  const detail =
    `At today's figures ${covenantFigures(m)} pass, but only just: a weak month or more borrowing would breach them at the ${close} close. ` +
    `${hold}; repaying debt widens the margin.`;
  const why: Wording = r.claims.newDebt
    ? [`You pass the bank's checks only just: borrow nothing beyond the payment above.`]
    : [`You pass the bank's checks only just: hold off on new borrowing.`];
  return plan(makeAdvice('covenantCure', ADVICE_PRIORITY.covenantCureAtRisk, "Keep clear of the bank's limits", why, BANK, 'covenantCure', { detail }));
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
  const title: Wording = !canCure
    ? [`Repay ${money(r.debt())} before the loans are called`, 'Repay everything before the loans are called']
    : left <= 0
      ? 'The bank calls the loans at the next close'
      : `Lift the freeze within ${count(left, 'close', 'closes')}`;
  const why: Wording = !canCure
    ? ['Too few closes remain to lift the freeze: only repaying everything stops the call.']
    : left <= 0
      ? ['The bank calls every loan at the next close unless you repay what you owe.']
      : [
          `The bank takes your spare cash each month and calls every loan in ${count(left, 'close', 'closes')}.`,
          `The bank takes spare cash and calls every loan in ${count(left, 'close', 'closes')}.`,
        ];
  return plan(makeAdvice('frozenSweep', ADVICE_PRIORITY.frozenSweep, title, why, BANK, 'frozenSweep', { detail: `${lead} ${lift}` }));
}

/**
 * The operating cash flow a month the network should reach once every
 * street it lights or is building (network.plannedService) is signed up to
 * its target take rate (sales.stateTakeRate per building kind and cabinet;
 * today's subscribed units when more), at what a unit pays today
 * (customers.forecastCustomers' price; the default lineup's signup price
 * with nobody subscribed), less the running costs at that size: overhead
 * (the base and today's plant, overhead.fixedOverheadLines, and
 * overhead.perCustomerCost per unit), pole rent, the marketing budget and
 * the trailing year's repairs a month; the revenue never below what the
 * last closed month billed. Whole dollars, may be negative: a network that
 * cannot pay its own way even signed up to target.
 */
function matureMonthlyFlow(state: GameState, r: Readings): number {
  const planned = plannedService(state);
  const rates = new Map<string, number>();
  let units = 0;
  for (const [segment, cabinet] of planned.servingCabinet) {
    for (const id of parcelsServedBy(state.city, segment)) {
      const parcel = state.city.parcels[id];
      if (!parcel || parcel.appearsDay > state.day) continue;
      const key = `${cabinet}:${parcel.kind}`;
      let rate = rates.get(key);
      if (rate === undefined) {
        rate = stateTakeRate(state, parcel.kind, cabinet);
        rates.set(key, rate);
      }
      units += Math.max(parcel.units * rate, r.subscribed().get(id) ?? 0);
    }
  }
  const forecast = r.forecast();
  const price = forecast.units > 0 ? forecast.price : forecast.signupPrice;
  const fixed = fixedOverheadLines(state);
  const repairs = -trailingRepairs(state.finance.reports) / REPAIR_TRAILING_MONTHS;
  const costs = fixed.base + fixed.perPlant + perCustomerCost(state) * units + monthlyPoleRent(state) + state.sales.marketingPerMonth + repairs;
  // Never less than the bills the last closed month brought.
  const billed = state.finance.reports.at(-1)?.totals.revenue ?? 0;
  return Math.round(Math.max(units * price, billed) - costs);
}

/** The marketing budget cashRunway suggests when nothing safe can be borrowed: MARKETING_CUT_SHARE of today's, rounded down. */
function trimmedMarketing(perMonth: number): number {
  return Math.max(0, Math.floor((perMonth * MARKETING_CUT_SHARE) / MARKETING_CUT_ROUNDING) * MARKETING_CUT_ROUNDING);
}

/**
 * cashRunway: installs are paused (Sales.installsPaused), or the runway
 * (finance.runwayMonths) is RUNWAY_WARN_MONTHS or less. Urgent when paused,
 * or at RUNWAY_URGENT_MONTHS or less with no safe financing; important
 * otherwise. Suggests the fundingHint financing that brings in
 * RUNWAY_FUND_MONTHS (else one) months of burn (finance.monthlyBurn) beyond
 * the cushion, SUGGESTED_BORROWING_HEADROOM inside the covenants (round 4b
 * review: a loan landing on the limit brought on covenantCure's own
 * warning), or slowing builds and marketing when nothing safe covers it,
 * an earlier suggestion said not to borrow, or the network cannot carry
 * more debt: it is past break-even (the trailing operating cash flow,
 * debt.covenantMetrics' annualOperatingCashFlow, is at least 0) but that
 * does not cover the yearly payments of the loans already owed, so the burn
 * is the debt service itself and a loan would only pay old debt with new;
 * or (round 4c/4d, spec B) the network will not pay its way even once its
 * streets are signed up to target under the scaled overhead
 * (matureMonthlyFlow, a year of it), or not enough to carry the loans it
 * would then owe (today's yearly debt service plus the suggested
 * financing's). Without financing, the plan trims marketing to
 * MARKETING_CUT_SHARE of today's (setMarketing) while cash covers the next
 * debt service. Open Bank.
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
  // Past break-even but short of the loan payments already owed: the burn is the debt service, and a loan would pay old debt with new.
  const m = r.metrics();
  const overloaded = m.annualDebtService > 0 && m.annualOperatingCashFlow >= 0 && m.annualOperatingCashFlow < m.annualDebtService;
  let funding: Funding | null = null;
  let months = 0;
  let cannotCarry = false;
  for (const k of borrowed || hold || overloaded ? [] : RUNWAY_FUND_MONTHS > 1 ? [RUNWAY_FUND_MONTHS, 1] : [1]) {
    const candidate = fundingOf(fundingHint(state, k * month + Math.max(0, cash - r.keep()) + r.claims.spend, SUGGESTED_BORROWING_HEADROOM));
    if (!candidate) continue;
    // Round 4c/4d: lend only into a network that, signed up to target, carries its loans and this one.
    const service =
      m.annualDebtService +
      (candidate.draw > 0 ? quoteDraw(state, candidate.draw).after.annualDebtService - m.annualDebtService : 0) +
      (candidate.termLoan > 0 ? 12 * quoteTermLoan(state, candidate.termLoan, candidate.termYears).payment : 0);
    if (12 * r.mature() <= service) {
      cannotCarry = true;
      break;
    }
    funding = candidate;
    months = k;
    break;
  }
  const urgent = paused || (runway !== null && runway <= RUNWAY_URGENT_MONTHS && funding === null && !borrowed);
  const priority = urgent ? ADVICE_PRIORITY.cashRunwayUrgent : ADVICE_PRIORITY.cashRunway;
  const lead = paused
    ? `Installs are paused: cash (${money(cash)}) can't cover the next one, so new customers are waiting.`
    : runway === 0
      ? `At your current burn of ${money(burn)} a month, your cash (${money(cash)}) will not last the month.`
      : `At your current burn of ${money(burn)} a month, your ${money(cash)} of cash lasts about ${count(runway ?? 0, 'month', 'months')}.`;
  const mature = r.mature();
  // "Borrowing suggested above" only when an earlier plan takes on new debt: a
  // repayment above (covenantCure's) is not borrowing, and its warning stands.
  const next = funding
    ? `${capitalize(funding.phrase)} adds about ${months === 1 ? 'a month' : `${months} months`} of ${paused ? 'costs' : 'runway'} ` +
      `and leaves the covenants at least ${pct(SUGGESTED_BORROWING_HEADROOM)} inside their limits.`
    : r.claims.newDebt
      ? `Beyond the borrowing suggested above, ${cutSpending(state)} until revenue catches up.`
      : hold
        ? `Until the covenants are clear of their limits (see above), don't borrow: ${cutSpending(state)} until revenue catches up.`
        : borrowed
          ? `After the repayment suggested above, ${cutSpending(state)} until revenue catches up.`
          : overloaded
            ? `Your operating cash flow (${money(m.annualOperatingCashFlow)} a year) does not cover the ${money(m.annualDebtService)} a year of loan payments ` +
              `you already owe, so this network cannot carry more debt (a loan would only pay old debt with new): ${cutSpending(state)} until revenue catches up.`
            : cannotCarry
              ? `Even with every street you have lit signed up to its target, this network would bring in about ${money(mature)} a month after running costs, ` +
                `not enough to carry another loan, so borrowing would only put off the shortfall: ${cutSpending(state)} and grow customers on the streets you have.`
              : `No covenant-safe borrowing covers it: ${cutSpending(state)} until revenue catches up.`;
  // Without financing, trim marketing (a command) while cash covers the next payment (paymentShort covers the rest).
  const marketing = state.sales.marketingPerMonth;
  const cut = !funding && marketing > 0 && cash >= r.nextService() ? trimmedMarketing(marketing) : null;
  const cutText = cut !== null ? ` Cutting marketing to ${money(cut)} a month saves ${money(marketing - cut)} a month.` : '';
  const title: Wording = paused
    ? 'Raise cash to restart installs'
    : funding
      ? 'Extend your cash runway'
      : runway === 0
        ? 'Slow spending: cash runs out this month'
        : `Slow spending: ${count(runway ?? 0, 'month', 'months')} of cash left`;
  const lasts = runway === 0 ? 'Cash runs out this month at this pace' : `Cash lasts about ${count(runway ?? 0, 'month', 'months')} at this pace`;
  const trim = cut !== null ? `cut marketing to ${money(cut)} a month` : 'trim spending and hold off on building';
  const why: Wording = paused
    ? funding
      ? [`Installs are paused for lack of cash: borrowing ${money(borrowedBy(funding))} restarts them.`]
      : [`Installs are paused for lack of cash: ${trim}.`, 'Installs are paused for lack of cash: trim spending.']
    : funding
      ? [`${lasts}: borrowing ${money(borrowedBy(funding))} adds about ${months === 1 ? 'a month' : `${months} months`}.`, `${lasts}: borrow ${money(borrowedBy(funding))}.`]
      : overloaded || cannotCarry
        ? [`${lasts}, and loans won't fix it: ${trim}.`, `${lasts}; loans won't fix it: trim spending.`, `${lasts}: ${trim}.`]
        : [`${lasts}: ${trim}.`, `${lasts}: trim spending.`];
  const commands: Command[] = funding ? funding.commands : cut !== null ? [{ type: 'setMarketing', perMonth: cut }] : [];
  return plan(makeAdvice('cashRunway', priority, title, why, BANK, 'cashRunway', { detail: `${lead} ${next}${cutText}` }), commands);
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
  if (r.splitterCandidates().length === 0) return null;
  if (ponPortsUsed(state) >= state.network.olt.ponPorts) return null;
  // The cabinet that needs one most, past any the player snoozed (every splitter card is important).
  for (const candidate of r.splitterCandidates()) {
    const made = splitterPlan(state, r, candidate);
    if (!r.passOver(made.advice)) return made;
  }
  return null;
}

/** "12 homes are waiting" / "1 home is waiting" */
function homesWaiting(n: number): string {
  return `${count(n, 'home is', 'homes are')} waiting`;
}

/** addSplitter's card for one cabinet in need. */
function splitterPlan(state: GameState, r: Readings, best: SplitterCandidate): AdvicePlan {
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
  const title: Wording = paid
    ? [`Add a splitter at ${place}`, `Add a splitter at ${firstStreet(place)}`, 'Add a splitter to a full cabinet']
    : [`Add a splitter at ${place} when cash allows`, `Add a splitter at ${firstStreet(place)} when cash allows`, 'Add a splitter when cash allows'];
  const state0 = best.full
    ? best.waiting > 0
      ? `It's full and ${homesWaiting(best.waiting)}`
      : "It's full, so new customers are turned away"
    : `${groupThousands(best.used)} of its ${groupThousands(best.capacity)} ports are in use and ${homesWaiting(best.waiting)}`;
  const short = best.full ? "It's full" : "It's nearly full";
  const why: Wording = !paid
    ? [`${state0}; add it once cash allows (${money(cost)}).`, `${short}; add a splitter once cash allows (${money(cost)}).`]
    : paid.cash
      ? [`${state0}. ${costs(cost)}`, `It needs more ports for new customers. ${costs(cost)}`]
      : [
          `${state0}: borrow ${money(paid.borrow)} for it. ${costs(cost)}`,
          `${short} and ${homesWaiting(best.waiting)}: borrow ${money(paid.borrow)}. ${costs(cost)}`,
          `${short}: borrow ${money(paid.borrow)} for a splitter. ${costs(cost)}`,
        ];
  const commands: Command[] = paid ? [...paid.commands, { type: 'addSplitter', cabinet: cabinet.id }] : [];
  const action: AdviceAction = { kind: 'focusCabinet', cabinet: cabinet.id };
  const advice = makeAdvice('addSplitter', priority, title, why, action, ADVICE_KEYS.addSplitter(cabinet.id), { detail: `${lead} ${next}`, cost });
  return plan(advice, commands, paid ? cost : 0);
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
  const situation = needer
    ? 'A cabinet needs a port at the central office and none is free'
    : free <= 0
      ? 'The central office has no free port for new cabinets'
      : `${groupThousands(used)} of the ${groupThousands(olt.ponPorts)} ports at the central office are in use`;
  const why: Wording = paid
    ? paid.cash
      ? [`${situation}. ${costs(cost)}`, `The central office is nearly out of ports. ${costs(cost)}`]
      : [`${situation}: borrow ${money(paid.borrow)} for it. ${costs(cost)}`, `The central office is out of ports: borrow ${money(paid.borrow)}. ${costs(cost)}`]
    : [`${situation}; add a card once cash allows (${money(cost)}).`, `The central office is nearly out of ports (${money(cost)} a card).`];
  const advice = makeAdvice('addOltCard', priority, paid ? 'Add an OLT line card' : 'Add an OLT line card when cash allows', why, OLT, 'addOltCard', { detail: `${lead} ${next}`, cost });
  return plan(advice, commands, paid ? cost : 0);
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
  // The measured spans, cutting off the most first (ties: the ranking); none measured cuts anyone off: the first, with everyone cut off.
  const measured = ranked
    .slice(0, OUTAGE_CANDIDATES_MAX)
    .map((span, rank) => ({ span, rank, impact: outageImpact(state, span.id) }))
    .filter((m) => m.impact.subscribers > 0)
    .sort((a, b) => b.impact.subscribers - a.impact.subscribers || a.rank - b.rank);
  const choices =
    measured.length > 0
      ? measured.map((m) => ({ span: m.span, units: m.impact.subscribers, segments: m.impact.segments }))
      : [{ span: ranked[0] as CableSpan, units: total, segments: [] as readonly SegmentId[] }];
  for (const choice of choices) {
    const made = outagePlan(state, r, choice.span, choice.units, choice.segments, total, cutOff);
    if (made && !r.passOver(made.advice)) return made;
  }
  return null;
}

/** outages' card for one out-of-service span cutting off `units` subscribed units on `segments` (`total` cut off in all). */
function outagePlan(
  state: GameState,
  r: Readings,
  worst: CableSpan,
  units: number,
  segments: readonly SegmentId[],
  total: number,
  cutOff: readonly { segment: SegmentId; parcel: ParcelId }[],
): AdvicePlan | null {
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
  const action: AdviceAction = { kind: 'focusSegment', segment: worst.segment };
  const days = count(outage.daysLeft, 'day', 'days');
  const why: Wording =
    expected > 0
      ? [
          `${cause} cut off ${count(units, 'customer', 'customers')} for ${days}, and about ${groupThousands(expected)} may cancel.`,
          `${cause} cut off ${count(units, 'customer', 'customers')}; about ${groupThousands(expected)} may cancel.`,
        ]
      : [`${cause} cut off ${count(units, 'customer', 'customers')}; the repair takes ${days}.`, `${cause} cut off ${count(units, 'customer', 'customers')} here.`];
  const advice = makeAdvice('outages', ADVICE_PRIORITY.outages, [`Service is out on ${street}`, 'Service is out on one of your streets'], why, action, ADVICE_KEYS.outages(worst.segment), {
    detail: `${lead} ${next}`,
  });
  return plan(advice);
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
 * stormUnderground (tip): a live aerial span (not being rebuilt) on an
 * exposed street (round 4b: weather.exposureBand of its
 * weather.segmentExposure is 'exposed': rural edges, wooded streets, round
 * 4c/4d tree-lined blocks; a sheltered or moderate street gets no card,
 * however often a storm hit it) that storms damaged STORM_HITS_MIN or more
 * times within STORM_LOG_DAYS (or whose repairs, weather.repairCost with the
 * town so tree-lined streets cost what they cost, reach
 * STORM_REPAIRS_CONVERT_SHARE of rebuilding it) and feeds subscribers (the
 * most-hit STORM_CANDIDATES_MAX are measured), with the repairs so far.
 * Rebuilding it underground (network.quoteConvert) when what it saves a
 * year (repairsAvoidedPerYear, weather.stormRisk's estimate, plus a year of
 * pole rent) pays it back within CONVERT_PAYBACK_YEARS and cash covers it
 * and the cushion; otherwise the figures and building new streets there
 * underground (a rebuild that does not pay is not suggested). One card per
 * span (its key); a snoozed span gives way to the next. Show me: that
 * street.
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
  const exposure = cityExposure(state.city);
  const candidates: { span: CableSpan; hits: number; first: number; repairs: number }[] = [];
  for (const span of state.network.spans) {
    const row = hits.get(span.id);
    if (!row || span.method !== 'aerial' || span.stage !== 'live' || span.conversion !== null) continue;
    if (exposureBand(exposure[span.segment] ?? 1) !== 'exposed') continue;
    const segment = state.city.segments[span.segment];
    if (!segment) continue;
    const repairs = row.hits * repairCost(segment, 'aerial', state.city);
    if (row.hits < STORM_HITS_MIN && repairs < STORM_REPAIRS_CONVERT_SHARE * quoteConvert(state, span.id).cost) continue;
    candidates.push({ span, hits: row.hits, first: row.first, repairs });
  }
  candidates.sort((a, b) => b.hits - a.hits || b.repairs - a.repairs || a.span.id - b.span.id);
  let measured = 0;
  for (const c of candidates) {
    if (measured >= STORM_CANDIDATES_MAX) break;
    // A snoozed span gives way to the next before it costs a measurement.
    if (r.passOver({ key: ADVICE_KEYS.stormUnderground(c.span.id), severity: severityOf(ADVICE_PRIORITY.stormUnderground) })) continue;
    measured++;
    const fed = unitsFedBy(state, c.span, r);
    if (fed <= 0) continue;
    const street = state.city.segments[c.span.segment]?.name ?? 'a street';
    const lead =
      `Storms have damaged the aerial cable on ${street}, an exposed street, ${count(c.hits, 'time', 'times')} since ${formatDate(c.first)} ` +
      `(about ${money(c.repairs)} of repairs), and an outage there cuts off ${count(fed, 'subscriber', 'subscribers')}.`;
    const quote = quoteConvert(state, c.span.id);
    const saved = quote.repairsAvoidedPerYear + 12 * quote.poleRentSaved;
    const pays = quote.cost > 0 && saved > 0 && saved * CONVERT_PAYBACK_YEARS >= quote.cost;
    const convert = pays && quote.ok && cashCovers(state, r, quote.cost);
    const rent = quote.poleRentSaved > 0 ? ` and ${money(12 * quote.poleRentSaved)} of pole rent` : '';
    const savings = `about ${money(quote.repairsAvoidedPerYear)} a year in storm repairs${rent}`;
    const years = pays ? Math.ceil(quote.cost / saved) : 0;
    const next = convert
      ? `Rebuilding it underground costs ${money(quote.cost)} and saves ${savings}: it pays for itself in about ${count(years, 'year', 'years')}.`
      : pays
        ? `Rebuilding it underground (${money(quote.cost)}) would save ${savings}: do it once cash covers it and ${keepWhat(r)}, and build new streets around here underground.`
        : quote.cost > 0
          ? `Rebuilding it (${money(quote.cost)}) would save only ${savings}, so build new streets around here underground instead.`
          : 'Build new streets around here underground.';
    const title: Wording = convert
      ? [`Rebuild ${street} underground`, 'Rebuild a storm-hit street underground']
      : [`Build underground around ${street}`, 'Build underground near storm-hit streets'];
    const hit = `Storms hit it ${count(c.hits, 'time', 'times')}`;
    const why: Wording = convert
      ? [`${hit}, and burying it pays back in about ${count(years, 'year', 'years')}. ${costs(quote.cost)}`, `Burying it pays back in about ${count(years, 'year', 'years')}. ${costs(quote.cost)}`]
      : pays
        ? [`${hit}; bury it once cash allows (${money(quote.cost)}).`, `Bury it once cash allows (${money(quote.cost)}).`]
        : [`${hit}; build new streets around here underground.`, 'Storms keep hitting it: build underground around here.'];
    const commands: Command[] = convert ? [{ type: 'convertSpan', span: c.span.id }] : [];
    const action: AdviceAction = { kind: 'focusSegment', segment: c.span.segment };
    const key = ADVICE_KEYS.stormUnderground(c.span.id);
    const advice = makeAdvice('stormUnderground', ADVICE_PRIORITY.stormUnderground, title, why, action, key, { detail: `${lead} ${next}`, cost: pays ? quote.cost : null });
    return plan(advice, commands, convert ? quote.cost : 0);
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
 * incumbentPromo: the incumbent's running promos (incumbent.activePromos)
 * not yet answered (the card clears once the player answers: with a
 * retention offer, IncumbentPromo.answered, or with the intro promo the card
 * recommended, IncumbentPromo.answeredWithPromo), at cabinets with your
 * subscribers, most subscribers first; one
 * card per cabinet (its key), a snoozed one giving way to the next. The lead
 * says its price, how long it runs, and your target take rate there
 * (sales.stateTakeRate at its promo price, weighted by the area's passings
 * per building kind) against elsewhere (at INCUMBENT_PRICE). Then exactly
 * what incumbent.bestIncumbentAnswer says:
 * - a remedy that pays (kind 'retention' or 'introPromo'): important, its
 *   `text` verbatim (round 4c/4d: in the detail, the card naming the
 *   remedy), with its command (answerIncumbent, or setPromo with its
 *   promo); Open Pricing. Not while an earlier suggestion of the same call
 *   is about cash running short (Claims.cashShort: paymentShort or
 *   cashRunway): both remedies are discounts that cut this month's revenue
 *   to win it back over months, so the card waits (as takeRate does) and no
 *   card shows for that area meanwhile (integrator, round 4b);
 * - nothing pays (kind 'none'): a tip that recommends no remedy (round 4b
 *   choice: the player still learns why the area's take rate dips): the
 *   extra cancellations it may cause (its subscribed units x
 *   INCUMBENT_PROMO_CHURN x the months it still runs) and that it ends on
 *   its own; no command; Show me: the cabinet.
 * Never marketing, a price cut, or a promo the quotes say does not pay.
 */
function incumbentPromoRule(state: GameState, r: Readings): AdvicePlan | null {
  const running = activePromos(state).filter((p) => !p.answered && !p.answeredWithPromo);
  if (running.length === 0) return null;
  const units = new Map<CabinetId, number>();
  for (const account of state.sales.accounts) units.set(account.cabinet, (units.get(account.cabinet) ?? 0) + accountUnits(account));
  const ranked = running
    .map((promo) => ({ promo, units: units.get(promo.cabinet) ?? 0 }))
    .filter((c) => c.units > 0)
    .sort((a, b) => b.units - a.units || a.promo.cabinet - b.promo.cabinet);
  for (const c of ranked) {
    const made = incumbentPlan(state, r, c.promo, c.units);
    if (made && !r.passOver(made.advice)) return made;
  }
  return null;
}

/** incumbentPromo's card for one running, unanswered promo over `subscribed` units of yours. */
function incumbentPlan(state: GameState, r: Readings, promo: IncumbentPromo, subscribed: number): AdvicePlan | null {
  const cabinet = state.network.cabinets.find((c) => c.id === promo.cabinet);
  if (!cabinet) return null;
  const key = ADVICE_KEYS.incumbentPromo(cabinet.id);
  const place = cornerName(state.city, cabinet.node);
  const kinds = areaUnits(state, r.service(), cabinet.id);
  const there = passingsWeightedRate(KINDS.map((k) => ({ units: kinds[k], rate: stateTakeRate(state, k, cabinet.id) }))) ?? stateTakeRate(state, 'home', cabinet.id);
  const elsewhere = passingsWeightedRate(KINDS.map((k) => ({ units: kinds[k], rate: stateTakeRate(state, k) }))) ?? stateTakeRate(state, 'home');
  const months = monthsUntil(state.day, promo.endDay);
  const lead =
    `The cable company charges ${money(promo.price)}/mo (instead of ${money(INCUMBENT_PRICE)}) around ${place} until ${formatDate(promo.endDay)}, ` +
    `${count(months, 'month', 'months')} more: your target take rate there is ${pct(there)} instead of ${pct(elsewhere)}, ` +
    `and its ${count(subscribed, 'subscriber', 'subscribers')} cancel more.`;
  const until = closeLabel(promo.endDay);
  const answer = bestIncumbentAnswer(state, cabinet.id);
  if (answer.kind !== 'none' && answer.text.length > 0) {
    if (r.claims.cashShort) return null;
    const commands: Command[] =
      answer.kind === 'retention' ? [{ type: 'answerIncumbent', cabinet: cabinet.id }] : answer.promo ? [{ type: 'setPromo', promo: answer.promo }] : [];
    const remedy = answer.kind === 'retention' ? 'a retention offer keeps customers for less than they are worth' : 'an intro promo wins more than it costs';
    const why: Wording = [
      `Cable charges ${money(promo.price)} here until ${until}: ${remedy}.`,
      `Cable charges ${money(promo.price)} here until ${until}: ${answer.kind === 'retention' ? 'a retention offer' : 'an intro promo'} pays.`,
    ];
    const title: Wording = [`Answer cable's promo at ${place}`, `Answer cable's promo at ${firstStreet(place)}`, "Answer the cable company's promo"];
    return plan(makeAdvice('incumbentPromo', ADVICE_PRIORITY.incumbentPromo, title, why, PRICING, key, { detail: `${lead} ${answer.text}` }), commands);
  }
  const extra = Math.round(subscribed * INCUMBENT_PROMO_CHURN * months);
  const cost = extra > 0 ? `It may cost you about ${count(extra, 'cancellation', 'cancellations')} there. ` : '';
  const detail =
    `${lead} ${cost}No answer pays for itself here (neither a retention offer nor an intro promo is worth what it costs), ` +
    `so let it run: it ends on its own on ${formatDate(promo.endDay)}.`;
  const why: Wording = [
    `Cable charges ${money(promo.price)} here until ${until}; no answer pays, so let it run.`,
    `Cable runs a promo here until ${until}; no answer pays, so let it run.`,
  ];
  const action: AdviceAction = { kind: 'focusCabinet', cabinet: cabinet.id };
  const title: Wording = [`Ride out cable's promo at ${place}`, `Ride out cable's promo at ${firstStreet(place)}`, "Ride out the cable company's promo"];
  return plan(makeAdvice('incumbentPromo', ADVICE_PRIORITY.incumbentPromoRideOut, title, why, action, key, { detail }));
}

/**
 * takeRate (tip): in areas lit TAKE_RATE_MATURE_MONTHS or more (a segment
 * counts from the later of its span's and its serving cabinet's liveDay),
 * with at least TAKE_RATE_MIN_PASSINGS units, the take rate is below
 * TAKE_RATE_LAG_SHARE of their passings-weighted target (sales.stateTakeRate
 * per kind and cabinet) while the lineup's deal makes households switch
 * slower than the default prices do (customers.dealFactor at cable's
 * standard price with the intro promo below TAKE_RATE_SLOW_DEAL): your
 * prices slow switching. Round 4c/4d: narrowed to prices; whether more
 * marketing, a campaign or referral credits would sign more homes up is
 * growCustomers' to weigh (the round-4b marketing advice read the retired
 * signup ramp). Not while installs are paused (new customers already wait
 * for cash) or an earlier suggestion of the same call is about cash running
 * short (Claims.cashShort: paymentShort or cashRunway): a price cut lowers
 * this month's revenue. Open Pricing.
 */
function takeRateRule(state: GameState, r: Readings): AdvicePlan | null {
  if (state.sales.installsPaused || r.claims.cashShort) return null;
  const deal = dealFactor(state.sales.pricing, 'home', INCUMBENT_PRICE, state.sales.promo);
  if (deal >= TAKE_RATE_SLOW_DEAL) return null;
  const service = r.service();
  if (service.passings <= 0) return null;
  const mature = matureTake(state, r);
  if (!mature || mature.units < TAKE_RATE_MIN_PASSINGS) return null;
  const { actual, target } = mature;
  if (actual >= TAKE_RATE_LAG_SHARE * target) return null;
  const detail =
    `In areas lit ${TAKE_RATE_MATURE_MONTHS} months or more your take rate is ${pct(actual)} against a ${pct(target)} target. ` +
    `At your prices, households there switch at about ${pct(deal)} of the speed the default prices bring (your deal against cable's ${money(INCUMBENT_PRICE)}): ` +
    'prices nearer the market speed switching up. The Customers panel shows why the rest have not switched.';
  const why: Wording = [
    `Areas lit ${TAKE_RATE_MATURE_MONTHS}+ months are ${pct(actual)} signed (target ${pct(target)}): your prices slow switching.`,
    `Your older areas are ${pct(actual)} signed: your prices slow switching.`,
  ];
  return plan(makeAdvice('takeRate', ADVICE_PRIORITY.takeRate, 'Your prices slow sign-ups', why, PRICING, 'takeRate', { detail }));
}

/** The take rate in areas lit TAKE_RATE_MATURE_MONTHS or more against their passings-weighted target, over their units; null with none. */
function matureTake(state: GameState, r: Readings): { units: number; actual: number; target: number } | null {
  const service = r.service();
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
  const target = passingsWeightedRate([...groups.values()]);
  if (mature <= 0 || target === null) return null;
  return { units: mature, actual: subs / mature, target };
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
function pricingRule(state: GameState, r: Readings): AdvicePlan | null {
  const pricing = state.sales.pricing;
  const out: { id: string; name: string; price: number; ref: number; gap: number; order: number }[] = [];
  pricing.tiers.forEach((tier, order) => {
    if (!tier.offered) return;
    const ref = TIER_DEFAULTS.find((t) => t.id === tier.id)?.price;
    if (ref === undefined || ref <= 0) return;
    const gap = (tier.price - ref) / ref;
    if (Math.abs(gap) <= PRICE_BAND_SHARE) return;
    out.push({ id: tier.id, name: tier.name, price: tier.price, ref, gap, order });
  });
  // The furthest first (ties: the lineup's order), past any tier the player snoozed.
  out.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap) || a.order - b.order);
  for (const best of out) {
    if (r.passOver({ key: ADVICE_KEYS.pricing(best.id), severity: severityOf(ADVICE_PRIORITY.pricing) })) continue;
    return pricingPlan(state, best);
  }
  return null;
}

/** pricing's card for one tier `gap` (a share) from its market reference `ref`. */
function pricingPlan(state: GameState, best: { id: string; name: string; price: number; ref: number; gap: number }): AdvicePlan | null {
  const pricing = state.sales.pricing;
  const tier = pricing.tiers.find((t) => t.id === best.id);
  if (!tier) return null;
  let detail: string;
  let why: Wording;
  if (best.gap > 0) {
    const churn = churnProbability(tier);
    const churnAtRef = churnProbability({ ...tier, price: best.ref });
    const target = targetTakeRate(pricing, 'home', INCUMBENT_PRICE, state.sales.promo);
    const targetAtRef = targetTakeRate(withPrice(pricing, best.id, best.ref), 'home', INCUMBENT_PRICE, state.sales.promo);
    const lower = Math.round(target * 100) < Math.round(targetAtRef * 100) ? `, and your target take rate is ${pct(target)} instead of ${pct(targetAtRef)}` : '';
    detail =
      `${best.name} at ${money(best.price)} is ${pct(best.gap)} above the ${money(best.ref)} the market bears: ` +
      `its subscribers cancel ${pct1(churn)} a month instead of ${pct1(churnAtRef)}${lower}.`;
    why = [
      `${best.name} at ${money(best.price)} is ${pct(best.gap)} above the market's ${money(best.ref)}, so customers cancel more.`,
      `${best.name} is ${pct(best.gap)} above the market price, so customers cancel more.`,
    ];
  } else {
    const units = unitsByTier(state)[tier.id];
    const left = units > 0 ? `about ${money(units * (best.ref - best.price))} a month left on the table across its ${count(units, 'subscriber', 'subscribers')}` : 'new subscribers would pay more';
    detail =
      `${best.name} at ${money(best.price)} is ${pct(-best.gap)} below the ${money(best.ref)} the market bears: ${left}. ` +
      'A rise reaches today’s subscribers only when their price lock ends.';
    why =
      units > 0
        ? [
            `${best.name} at ${money(best.price)} is ${pct(-best.gap)} below the market's ${money(best.ref)}: about ${money(units * (best.ref - best.price))} a month unearned.`,
            `${best.name} is ${pct(-best.gap)} below the market price: about ${money(units * (best.ref - best.price))} a month unearned.`,
            `${best.name} is ${pct(-best.gap)} below the market price, leaving money on the table.`,
          ]
        : [`${best.name} at ${money(best.price)} is ${pct(-best.gap)} below the market's ${money(best.ref)}: new customers would pay more.`, `${best.name} is ${pct(-best.gap)} below the market price.`];
  }
  const title: Wording = [`Bring ${best.name} closer to ${money(best.ref)}`, `Bring ${best.name} nearer the market price`];
  return plan(makeAdvice('pricing', ADVICE_PRIORITY.pricing, title, why, PRICING, ADVICE_KEYS.pricing(best.id), { detail }));
}

/** Plain words for the demand segments (balance.DEMAND_SEGMENTS). */
const SEGMENT_WORDS: Readonly<Record<string, string>> = { value: 'price-conscious', mainstream: 'mainstream', speed: 'speed-hungry' };

/**
 * lineup (tip, round 4c/4d, spec B): the cheap tiers are dropped (a tier
 * whose market price, TIER_DEFAULTS, is below every offered tier's is not
 * offered), so the price-conscious households sign up far less or not at all
 * (sales.segmentDemand at cable's standard price: a segment no offered tier
 * suits takes 0). Fires when offering the dropped tiers again at their
 * market price (one setPricing, every other tier as it is) raises the
 * households' target take rate by at least LINEUP_MIN_GAIN, or serves a
 * segment no tier suits today; says what share of homes no plan suits (or
 * that the price-conscious ones sign up less) and, in the detail, how many
 * more of the homes you pass would sign up. Open Pricing.
 */
function lineupRule(state: GameState, r: Readings): AdvicePlan | null {
  const pricing = state.sales.pricing;
  const promo = state.sales.promo;
  const offered = pricing.tiers.filter((t) => t.offered);
  if (offered.length === 0) return null;
  const marketPrice = (id: TierId) => TIER_DEFAULTS.find((t) => t.id === id)?.price ?? 0;
  let cheapestOffered = Number.POSITIVE_INFINITY;
  for (const t of offered) cheapestOffered = Math.min(cheapestOffered, marketPrice(t.id));
  const dropped = pricing.tiers.filter((t) => !t.offered && marketPrice(t.id) > 0 && marketPrice(t.id) < cheapestOffered);
  if (dropped.length === 0) return null;
  const back = new Set(dropped.map((t) => t.id));
  const tiers = pricing.tiers.map((t) => ({ id: t.id, price: back.has(t.id) ? marketPrice(t.id) : t.price, offered: t.offered || back.has(t.id) }));
  const next: Pricing = { ...pricing, tiers: pricing.tiers.map((t) => ({ ...t, price: back.has(t.id) ? marketPrice(t.id) : t.price, offered: t.offered || back.has(t.id) })) };
  const before = segmentDemand(pricing, 'home', INCUMBENT_PRICE, promo);
  const after = segmentDemand(next, 'home', INCUMBENT_PRICE, promo);
  const fixed = before.filter((d) => !(d.takeRate > 0) && (after.find((a) => a.segment === d.segment)?.takeRate ?? 0) > 0);
  const takeNow = targetTakeRate(pricing, 'home', INCUMBENT_PRICE, promo);
  const takeNext = targetTakeRate(next, 'home', INCUMBENT_PRICE, promo);
  const gain = takeNext - takeNow;
  if (fixed.length === 0 && gain < LINEUP_MIN_GAIN) return null;
  let share = 0;
  for (const d of fixed) share += d.share;
  const more = Math.max(0, Math.round(gain * r.service().passings));
  const sorted = [...dropped].sort((a, b) => marketPrice(a.id) - marketPrice(b.id));
  const first = sorted[0] as (typeof sorted)[number];
  const names = sorted.map((t) => t.name).join(' and ');
  const prices = sorted.map((t) => `${t.name} at ${money(marketPrice(t.id))}`).join(' and ');
  const who =
    fixed.length > 0
      ? `no plan suits the ${fixed.map((d) => SEGMENT_WORDS[d.segment] ?? d.segment).join(' and ')} households (${pct(share)} of homes): their price limit is below every tier you offer, so they never sign up`
      : 'the price-conscious households find every tier you offer dearer than they like, so far fewer of them sign up';
  const detail =
    `With ${names} not offered, ${who}. Offering ${prices} again lifts your target take rate for homes from ${pct(takeNow)} to ${pct(takeNext)}` +
    `${more > 0 ? `: about ${count(more, 'more home', 'more homes')} of those you pass` : ''}. Customers on the dearer tiers keep their plans.`;
  const offer = `offer ${first.name} at ${money(marketPrice(first.id))} again`;
  const why: Wording =
    fixed.length > 0
      ? [`No plan suits ${pct(share)} of homes, the price-conscious ones: ${offer}.`, `No plan suits ${pct(share)} of homes: ${offer}.`, `No plan suits ${pct(share)} of homes: offer ${first.name} again.`]
      : [`Price-conscious homes rarely sign up without ${first.name}: ${offer}.`, `Price-conscious homes need ${first.name}: ${offer}.`, `Price-conscious homes need ${first.name}: offer it again.`];
  const title: Wording = [`Offer ${names} again`, `Offer ${first.name} again`];
  const command: Command = { type: 'setPricing', tiers, smbMultiplier: pricing.smbMultiplier };
  return plan(makeAdvice('lineup', ADVICE_PRIORITY.lineup, title, why, PRICING, ADVICE_KEYS.lineup(first.id), { detail }), [command]);
}

/** Subscribed units whose biggest grievance is service (outages, install waits, Basic support), from a happiness report's top reasons. */
function serviceUnhappy(report: ReturnType<typeof happinessReport>): number {
  let units = 0;
  for (const reason of report.reasons) {
    if (reason.bucket === 'unhappy' && (reason.reason === 'outages' || reason.reason === 'installWait' || reason.reason === 'support')) units += reason.units;
  }
  return units;
}

/**
 * support (tip, round 4c/4d, spec I.6), with at least SUPPORT_MIN_UNITS
 * subscribed and not while installs are paused or an earlier suggestion is
 * about cash running short:
 * - on Good: at least SUPPORT_SERVICE_SHARE of customers are unhappy mainly
 *   about service (outages, install waits: customers.happinessReport) and
 *   customers.quoteSupport('great') pays (the customers kept and won are
 *   worth more than its extra cost over CUSTOMER_QUOTE_MONTHS): suggest
 *   Great (setSupport), its extra cost a month and EXPAND_RESERVE_MONTHS of
 *   it covered by cash with the cushion (extraSpend);
 * - on Basic: when a dearer level pays (the better netValue of Good and
 *   Great), what Basic costs in customers (cancellations it adds and
 *   signups it loses a year, from the quotes at both levels) and the level
 *   to go back to, covered as above.
 * Open Customers.
 */
function supportRule(state: GameState, r: Readings): AdvicePlan | null {
  if (state.sales.installsPaused || r.claims.cashShort) return null;
  const units = subscriberUnits(state);
  if (units < SUPPORT_MIN_UNITS) return null;
  const level = state.customers.supportLevel;
  if (level === 'great') return null;
  if (level === 'good') {
    const report = happinessReport(state);
    const service = serviceUnhappy(report);
    if (service < SUPPORT_SERVICE_SHARE * units) return null;
    const quote = quoteSupport(state, 'great');
    if (!quote.ok || !quote.pays || quote.costChange <= 0) return null;
    const extra = EXPAND_RESERVE_MONTHS * quote.costChange;
    if (!cashCovers(state, r, extra)) return null;
    const detail =
      `${count(service, 'customer is', 'customers are')} unhappy mainly about outages or waiting to be connected, and unhappy customers cancel more. ` +
      `Great support costs ${money(quote.costChange)} a month more for your ${count(units, 'customer', 'customers')} and, over the next ${CUSTOMER_QUOTE_MONTHS} months, ` +
      `keeps and wins customers worth about ${money(quote.netValue)} more than it costs (about ${quote.cancellationsPerMonth.toFixed(1)} cancellations a month at Great).`;
    const why: Wording = [
      `${count(service, 'customer is', 'customers are')} unhappy about outages or waits; Great support pays. ${costs(quote.costChange)}`,
      `Outages and waits make customers unhappy; Great support pays. ${costs(quote.costChange)}`,
    ];
    const advice = makeAdvice('support', ADVICE_PRIORITY.support, 'Switch to Great support', why, CUSTOMERS, ADVICE_KEYS.support('great'), { detail, cost: quote.costChange });
    return plan(advice, [{ type: 'setSupport', level: 'great' }], extra, extra);
  }
  // Basic: what it costs in customers, when a dearer level pays.
  const today = quoteSupport(state, level);
  const options = (['good', 'great'] as const).map((l) => quoteSupport(state, l)).filter((q) => q.ok && q.pays);
  if (options.length === 0) return null;
  const better = options.reduce((a, b) => (b.netValue > a.netValue ? b : a));
  const extra = EXPAND_RESERVE_MONTHS * Math.max(0, better.costChange);
  if (!cashCovers(state, r, extra)) return null;
  const lost = Math.max(0, Math.round((today.cancellationsPerMonth - better.cancellationsPerMonth + better.signupsPerMonth - today.signupsPerMonth) * 12));
  const name = SUPPORT_LEVELS[better.level].name;
  const saving = Math.max(0, better.costChange);
  const detail =
    `Basic support saves ${money(saving)} a month against ${name}, but its customers are less happy, so more cancel and fewer neighbors sign up: ` +
    `about ${count(lost, 'customer', 'customers')} fewer a year. Over the next ${CUSTOMER_QUOTE_MONTHS} months ${name} is worth about ${money(better.netValue)} more than it costs.`;
  const why: Wording = [
    `Basic support saves ${money(saving)} a month but costs about ${count(lost, 'customer', 'customers')} a year.`,
    `Basic support costs you about ${count(lost, 'customer', 'customers')} a year.`,
  ];
  const title = `Go back to ${name} support`;
  const advice = makeAdvice('support', ADVICE_PRIORITY.support, title, why, CUSTOMERS, ADVICE_KEYS.support(better.level), { detail, cost: saving > 0 ? saving : null });
  return plan(advice, [{ type: 'setSupport', level: better.level }], extra, extra);
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
  const why: Wording = [
    `So far your fiber cost ${money(cpp)} per home passed (target ${money(CPP_TARGET)}), so loans cost more.`,
    `So far your fiber cost ${money(cpp)} per home passed, so loans cost more.`,
  ];
  return plan(makeAdvice('redCpp', priority, 'Bring your cost per home passed down', why, BANK, 'redCpp', { detail: `${lead} ${next}` }));
}

// ---------------------------------------------------------------------------
// Builds: the corners, their plans and what they cost to carry (expand,
// firstBuild and growthOptions' new-fiber option)
// ---------------------------------------------------------------------------

/**
 * Corners to preview for a new cabinet, every one ranked (round 4c/4d, spec
 * B: rankedCorners ranks them all, expand and firstBuild price as many as
 * they need): no cabinet there, within EXPAND_REACH_MULTIPLE x
 * CABINET_REACH_FT (straight line, a lower bound of the street distance) of
 * the planned plant (every span's ends, every cabinet, the CO) and at least
 * CABINET_REACH_FT from every planned cabinet, that newly pass at least
 * EXPAND_MIN_PASSINGS units (exactly coverage.buildOutPlan's passings: the
 * units on the streets within CABINET_REACH_FT along streets that no
 * planned cabinet serves, as coveragePreview counts them). Ranked without a
 * coverage run each, by an estimated cost (expandEstimate: the cabinet,
 * those streets' cheapest cable and a straight feeder from the plant at
 * UNDERGROUND_COST_PER_FT) and cost per passing (over those units). Corners
 * that look green (at most CPP_TARGET) and cost at most `budget` (what the
 * caller could spend on a build: default no limit) come first, then the
 * other green-looking ones, each the most units first (expand and
 * firstBuild then pick among those they price by the customers each would
 * sign: planCustomers); then the rest, the cheapest per passing first; ties go to the nearest to the plant, then the
 * lower id. Round 4b review: ranked by the nearest alone, every corner on
 * existing cable tied at 0 ft and the lowest ids won, small pockets beside
 * the plant, so once a feeder ran through town the green build-outs along
 * it were never priced and expand fell silent; and a reach measured in a
 * straight line (across blocks no street joins) overcounted the units, so
 * amber and red corners looked green and crowded the green ones out; and
 * ranked by size alone, the largest green areas, none of them affordable,
 * kept an affordable smaller one from being priced (round 4b check).
 */
export function rankedCorners(state: GameState, budget: number = Number.POSITIVE_INFINITY): number[] {
  return rankCorners(cornerEstimates(state), budget);
}

/** A corner rankedCorners may rank, with its distance to the plant (squared cells), units and estimated cost and cost per passing. */
interface CornerEstimate {
  node: number;
  d2: number;
  units: number;
  cost: number;
  cpp: number;
}

/** rankedCorners' order of `corners` for `budget`. */
function rankCorners(corners: readonly CornerEstimate[], budget: number): number[] {
  const tier = (c: CornerEstimate) => (c.cpp <= CPP_TARGET ? (c.cost <= budget ? 2 : 1) : 0);
  return [...corners]
    .map((c) => ({ ...c, tier: tier(c) }))
    .sort((a, b) => b.tier - a.tier || (a.tier > 0 ? b.units - a.units : a.cpp - b.cpp) || a.d2 - b.d2 || a.node - b.node)
    .map((c) => c.node);
}

/** Every corner rankedCorners considers, estimated (no budget yet). */
function cornerEstimates(state: GameState): CornerEstimate[] {
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
  const streets = expandStreets(state);
  const corners: CornerEstimate[] = [];
  for (const f of found) {
    const estimate = expandEstimate(state, f.node, streets);
    const units = estimate.units;
    if (units < EXPAND_MIN_PASSINGS) continue;
    const cost = estimate.cost + Math.sqrt(f.d2) * cell * UNDERGROUND_COST_PER_FT;
    corners.push({ ...f, units, cost, cpp: cost / units });
  }
  return corners;
}

/** The first EXPAND_CANDIDATES_MAX of rankedCorners: the corners every expand call prices (it may price more, down to EXPAND_PRICE_MAX, to find one the cash covers). */
export function expandCandidates(state: GameState, budget: number = Number.POSITIVE_INFINITY): number[] {
  return rankedCorners(state, budget).slice(0, EXPAND_CANDIDATES_MAX);
}

/** Per street, read once per rankedCorners call: the units no planned cabinet serves (0 when one does), and the cheapest cable for it when uncabled. */
interface ExpandStreets {
  units: (segment: SegmentId) => number;
  /** Cheapest cable charges (coverage.cheapestBuild) for an uncabled street, null for a cabled one. */
  cable: (segment: SegmentId) => { method: CableMethod; total: number } | null;
}

function expandStreets(state: GameState): ExpandStreets {
  const { city, network } = state;
  const served = plannedService(state).servingCabinet;
  const cabled = new Set<SegmentId>(network.spans.map((s) => s.segment));
  const unitCache = new Map<SegmentId, number>();
  const cableCache = new Map<SegmentId, { method: CableMethod; total: number } | null>();
  return {
    units(segment) {
      let units = unitCache.get(segment);
      if (units === undefined) {
        units = 0;
        if (!served.has(segment)) {
          for (const id of parcelsServedBy(city, segment)) {
            const parcel = city.parcels[id];
            if (parcel && parcel.appearsDay <= state.day) units += parcel.units;
          }
        }
        unitCache.set(segment, units);
      }
      return units;
    },
    cable(segment) {
      let cable = cableCache.get(segment);
      if (cable === undefined) {
        const street = city.segments[segment];
        cable = cabled.has(segment) || !street ? null : cheapestBuild(street);
        cableCache.set(segment, cable);
      }
      return cable;
    },
  };
}

/**
 * What a cabinet at `node` newly passes and roughly costs, without a coverage
 * run: the units on the streets within CABINET_REACH_FT along streets
 * (streets.segmentsWithin, as coveragePreview measures reach) that no planned
 * cabinet serves, which is exactly buildOutPlan's passings; and the
 * cabinet's price (CABINET_COST + CABINET_START_SPLITTERS x SPLITTER_COST)
 * plus the cheapest cable on the uncabled ones and one order's fees per
 * method (coveragePreview's build-out cost). The feeder is the caller's to add.
 */
function expandEstimate(state: GameState, node: NodeId, streets: ExpandStreets): { units: number; cost: number } {
  let units = 0;
  let cost = CABINET_COST + CABINET_START_SPLITTERS * SPLITTER_COST;
  let aerial = false;
  let underground = false;
  for (const { segment } of segmentsWithin(state.city, node, CABINET_REACH_FT)) {
    units += streets.units(segment);
    const cable = streets.cable(segment);
    if (!cable) continue;
    cost += cable.total;
    if (cable.method === 'aerial') aerial = true;
    else underground = true;
  }
  if (aerial) cost += orderFees('aerial');
  if (underground) cost += orderFees('underground');
  return { units, cost };
}

/** Average days in a month: the ramp and the install pace count months as DAYS_PER_YEAR / 12 days. */
const DAYS_PER_MONTH = DAYS_PER_YEAR / 12;

/**
 * The monthly install pace (connect capex, dollars >= 0): this month's
 * installs so far with the last closed month's, over their days, scaled to a
 * month (finance.estimateCashAtClose takes the same pace for the days left).
 */
export function monthlyInstallPace(state: GameState): number {
  const date = dateOf(state.day);
  let installs = 0;
  for (const entry of state.finance.monthToDate) if (entry.category === 'install') installs += entry.amount;
  const last = state.finance.reports.at(-1);
  const lastInstalls = last ? (last.totals.install ?? 0) : 0;
  const days = date.day + (last ? (MONTH_LENGTHS[last.month - 1] as number) : 0);
  if (days <= 0) return 0;
  return Math.max(0, Math.round((-(installs + lastInstalls) * DAYS_PER_MONTH) / days));
}

/** Share of a street's gap that switches within a month at awareness `awareness` and deal `deal` (customers.switchRate, compounded over the month's days). */
function monthShare(awareness: number, deal: number): number {
  const rate = switchRate(awareness, deal, 1, 1, 1);
  const days = Math.round(DAYS_PER_MONTH);
  let open = 1;
  for (let d = 0; d < days; d++) open *= 1 - rate;
  return 1 - open;
}

/**
 * The install pace the network already committed to should bring (connect
 * capex a month, dollars >= 0): over every parcel on a street the planned
 * network will light (network.plannedService: spans and cabinets still being
 * built count), the units still to sign up (its target take rate there,
 * sales.stateTakeRate, less those subscribed) x the share of that gap a
 * month signs (round 4c/4d: the switching model, monthShare at the street's
 * awareness, customers.awarenessOf, AWARENESS_ON_LIT for a street not lit
 * yet, and the building kind's deal, customers.dealFactors at cable's
 * standard price) x sales.installCost (an apartment building's router when
 * none of its units subscribes yet). Catches the installs a build still
 * under construction will bring, which the measured pace
 * (monthlyInstallPace) cannot see yet.
 */
export function plannedInstallPace(state: GameState, subscribed: ReadonlyMap<ParcelId, number>): number {
  const planned = plannedService(state);
  const lit = getService(state).litSegments;
  const deals = dealFactors(state.sales.pricing, INCUMBENT_PRICE, state.sales.promo);
  const rate = new Map<string, number>();
  const shares = new Map<string, number>();
  let total = 0;
  for (const [segment, cabinet] of planned.servingCabinet) {
    const awareness = lit.has(segment) ? awarenessOf(state, segment) : AWARENESS_ON_LIT;
    for (const id of parcelsServedBy(state.city, segment)) {
      const parcel = state.city.parcels[id];
      if (!parcel || parcel.appearsDay > state.day) continue;
      const key = `${cabinet}:${parcel.kind}`;
      let take = rate.get(key);
      if (take === undefined) {
        take = stateTakeRate(state, parcel.kind, cabinet);
        rate.set(key, take);
      }
      const shareKey = `${awareness}:${parcel.kind}`;
      let share = shares.get(shareKey);
      if (share === undefined) {
        share = monthShare(awareness, deals[parcel.kind]);
        shares.set(shareKey, share);
      }
      const sub = subscribed.get(id) ?? 0;
      const signed = Math.max(0, parcel.units * take - sub) * share;
      total += signed * installCost(parcel.kind, true);
      if (parcel.kind === 'mdu' && sub === 0 && signed > 0) total += (installCost('mdu', false) - installCost('mdu', true)) * Math.min(1, signed);
    }
  }
  return Math.round(total);
}

/**
 * The share of a new area's target signups made within `months` (round
 * 4c/4d: the switching model, customers.ts model 1-2, played day by day on a
 * freshly lit street: awareness from AWARENESS_ON_LIT growing by
 * customers.awarenessGainPerDay with today's marketing over `passings`,
 * households inside the target switching at customers.switchRate with the
 * households' deal, customers.dealFactor at cable's standard price, and the
 * intro promo's boost while the street is young, customers.
 * PROMO_BOOST_YOUNG_DAYS; no word of mouth or campaign). Arithmetic only.
 */
export function rampShare(state: GameState, passings: number, months: number): number {
  return rampShares(state, passings, months)[Math.max(0, Math.round(months * DAYS_PER_MONTH))] as number;
}

/** rampShare at the end of every day 0..round(months x DAYS_PER_MONTH) (index = days since lit), in one pass. */
function rampShares(state: GameState, passings: number, months: number): number[] {
  const days = Math.max(0, Math.round(months * DAYS_PER_MONTH));
  const promo = state.sales.promo;
  const gain = awarenessGainPerDay(marketingAwarenessPerDay(state.sales.marketingPerMonth, passings), 0, 0, false);
  const deal = dealFactor(state.sales.pricing, 'home', INCUMBENT_PRICE, promo);
  const boost = promoSignupFactor(promo);
  let awareness = AWARENESS_ON_LIT;
  let open = 1;
  const shares = [0];
  for (let d = 0; d < days; d++) {
    open *= 1 - switchRate(awareness, deal, 1, 1, d < PROMO_BOOST_YOUNG_DAYS ? boost : 1);
    awareness += (1 - awareness) * Math.min(1, gain);
    shares.push(1 - open);
  }
  return shares;
}

/**
 * The company's operating cash flow a month before a build, signed (the
 * cash it makes, negative while it burns): the last closed month's
 * operating cash flow with storm repairs at their trailing average, less
 * its debt service (finance.monthlyBurn's figure, signed); with no closed
 * month yet, minus the fixed costs and pole rent (a new company only
 * spends).
 */
function monthlyFlowNow(state: GameState, r: Readings): number {
  const last = state.finance.reports.at(-1);
  if (!last) return -(r.fixed() + monthlyPoleRent(state));
  const burn = monthlyBurn(state);
  if (burn > 0) return -burn;
  const service = last.debt ? Math.round(last.debt.annualDebtService / 12) : -((last.totals.interest ?? 0) + (last.totals.principal ?? 0));
  const repairs = Math.round(trailingRepairs(state.finance.reports) / REPAIR_TRAILING_MONTHS);
  return operatingCashFlow(last) - (last.totals.repair ?? 0) + repairs - service;
}

/**
 * Round 4c/4d (spec B, the scaled overhead): the cash a build needs to come
 * through its ramp without borrowing: the deepest the company's cash would
 * fall over TROUGH_MONTHS after it, month by month, from today's flow
 * (monthlyFlowNow, less today's install pace for the first
 * EXPAND_RESERVE_MONTHS months) plus the new area: its target units signed
 * as the switching model signs a fresh street (rampShares), each paying the
 * households' signup price (customers.forecastCustomers) less
 * overhead.perCustomerCost, the installs of those signups as they come, and
 * what the plan adds to the running costs (planRunningCost). Whole dollars
 * >= 0 (0 when the cash never falls). buildTrough is it for `plan` on
 * `state` as it stands (expand and firstBuild compute it with their call's
 * readings).
 */
export function buildTrough(state: GameState, plan: BuildOutPlan & { lit?: readonly SegmentId[] }): number {
  const r = readingsOf(state, false);
  const passingsToday = r.service().passings;
  const installs = Math.max(monthlyInstallPace(state), plannedInstallPace(state, r.subscribed()));
  return rampTrough(state, r, plan, areaSignups(state, plan, passingsToday, EXPAND_INSTALL_MONTHS), passingsToday, installs);
}

function rampTrough(
  state: GameState,
  r: Readings,
  plan: BuildOutPlan,
  area: { target: number; installsPerUnit: number },
  passingsToday: number,
  installsNow: number,
): number {
  const shares = r.ramp(passingsToday + plan.passings);
  const margin = r.forecast().signupPrice - perCustomerCost(state);
  const flow = monthlyFlowNow(state, r);
  const running = planRunningCost(state, plan);
  let cash = 0;
  let low = 0;
  let before = 0;
  for (let m = 1; m <= TROUGH_MONTHS; m++) {
    const signed = area.target * (shares[Math.min(shares.length - 1, Math.round(m * DAYS_PER_MONTH))] as number);
    cash += flow - (m <= EXPAND_RESERVE_MONTHS ? installsNow : 0) + signed * margin - running - (signed - before) * area.installsPerUnit;
    before = signed;
    low = Math.min(low, cash);
  }
  return Math.round(-low);
}

/** A plan's lit streets: those it newly serves (its preview's streets no other planned cabinet serves), or a smaller plan's own. */
function planStreets(state: GameState, plan: Pick<BuildOutPlan, 'node'> & { lit?: readonly SegmentId[] }): readonly SegmentId[] {
  if (plan.lit) return plan.lit;
  return coveragePreview(state, plan.node)
    .segments.filter((s) => s.servedBy === null)
    .map((s) => s.segment);
}

/**
 * Connect capex a new cabinet at plan.node is expected to spend within
 * `months` (default EXPAND_INSTALL_MONTHS): over the parcels it would newly
 * pass (existing parcels on its reach's segments no other cabinet serves:
 * coverage.coveragePreview; a smaller plan's own streets), units x the
 * target take rate for their kind (sales.stateTakeRate; a new area has no
 * incumbent promo) x the share signed within that many months (rampShare),
 * at sales.installCost (an apartment building's router once). Whole
 * dollars. With `signups` it also reports the units signed.
 */
export function expectedAreaInstalls(
  state: GameState,
  plan: Pick<BuildOutPlan, 'node' | 'passings'> & { lit?: readonly SegmentId[] },
  passingsToday: number,
  months: number = EXPAND_INSTALL_MONTHS,
): number {
  return areaSignups(state, plan, passingsToday, months).installs;
}

/** expectedAreaInstalls with the units signed within `months` and their target units. */
function areaSignups(
  state: GameState,
  plan: Pick<BuildOutPlan, 'node' | 'passings'> & { lit?: readonly SegmentId[] },
  passingsToday: number,
  months: number,
  shares?: readonly number[],
): { installs: number; signups: number; target: number; installsPerUnit: number } {
  const day = Math.max(0, Math.round(months * DAYS_PER_MONTH));
  const share = shares && day < shares.length ? (shares[day] as number) : rampShare(state, passingsToday + plan.passings, months);
  const rate = new Map<ParcelKind, number>();
  let total = 0;
  let signups = 0;
  let target = 0;
  let perUnit = 0;
  for (const segment of planStreets(state, plan)) {
    for (const id of parcelsServedBy(state.city, segment)) {
      const parcel = state.city.parcels[id];
      if (!parcel || parcel.appearsDay > state.day) continue;
      let take = rate.get(parcel.kind);
      if (take === undefined) {
        take = stateTakeRate(state, parcel.kind);
        rate.set(parcel.kind, take);
      }
      const signed = parcel.units * take * share;
      target += parcel.units * take;
      signups += signed;
      total += signed * installCost(parcel.kind, true);
      perUnit += parcel.units * take * installCost(parcel.kind, true) + (parcel.kind === 'mdu' ? installCost('mdu', false) - installCost('mdu', true) : 0);
      if (parcel.kind === 'mdu' && signed > 0) total += (installCost('mdu', false) - installCost('mdu', true)) * Math.min(1, signed);
    }
  }
  return { installs: Math.round(total), signups, target, installsPerUnit: target > 0 ? perUnit / target : 0 };
}

/**
 * What a plan adds to the monthly running costs once built (round 4c/4d,
 * the scaled overhead): its cabinet's upkeep (OVERHEAD_PER_CABINET_PER_MONTH,
 * when it places one), its cable's route-miles x OVERHEAD_PER_MILE_PER_MONTH,
 * and pole rent on its aerial streets (streets.polesOnSegment x
 * POLE_RENT_PER_POLE_PER_MONTH). Whole dollars.
 */
export function planRunningCost(state: GameState, plan: Pick<BuildOutPlan, 'commands' | 'aerial' | 'underground'>): number {
  let feet = 0;
  let poles = 0;
  for (const id of plan.aerial) {
    const segment = state.city.segments[id];
    if (!segment) continue;
    feet += segment.lengthFt;
    poles += polesOnSegment(segment);
  }
  for (const id of plan.underground) feet += state.city.segments[id]?.lengthFt ?? 0;
  const cabinet = plan.commands.some((c) => c.type === 'placeCabinet') ? OVERHEAD_PER_CABINET_PER_MONTH : 0;
  return Math.round(cabinet + (feet / 5_280) * OVERHEAD_PER_MILE_PER_MONTH + poles * POLE_RENT_PER_POLE_PER_MONTH);
}

/** How a build of `cost` is paid keeping `reserve`: from cash, or with a term loan (keep then counts the loan's payments too). */
interface ExpandFunding {
  loan: number;
  /** Cash the plan promises to leave: the reserve, plus EXPAND_RESERVE_MONTHS of the loan's payments and its stub interest. */
  keep: number;
}

/**
 * Cash above `reserve` (and what earlier suggestions spend) pays for `cost`;
 * else a term loan of the longest term, at least TERM_LOAN_MIN, a multiple of
 * LOAN_ROUNDING, sized so cash after the build still covers the reserve plus
 * EXPAND_RESERVE_MONTHS of its own payments and its first close's stub
 * interest; it must be at most `safeLoan` (debt.maxSafeTermLoan with
 * EXPAND_COVENANT_HEADROOM) and leave the covenants that far inside their
 * limits on its own quote (debt.covenantsWithin of quoteTermLoan(...).after)
 * and (round 4c/4d) once the plan's own running costs (`running` a month)
 * come off the operating cash flow; and it pays for the build only, never
 * for the reserve (at most `cost`). Null when neither pays for it.
 */
function expandFunding(state: GameState, r: Readings, cost: number, reserve: number, safeLoan: number, years: TermYears, running = 0): ExpandFunding | null {
  const cash = state.finance.cash - r.claims.spend;
  if (cost + reserve <= cash) return { loan: 0, keep: reserve };
  if (safeLoan < TERM_LOAN_MIN) return null;
  const round = (amount: number) => Math.max(TERM_LOAN_MIN, Math.ceil(amount / LOAN_ROUNDING) * LOAN_ROUNDING);
  let loan = round(cost + reserve - cash);
  for (let i = 0; i < 4; i++) {
    // Round 4c/4d: a loan pays for the build, never for the reserve (a reserve on borrowed money is not one).
    if (loan > safeLoan || loan > cost) return null;
    const quote = quoteTermLoan(state, loan, years);
    if (!quote.ok) return null;
    const keep = reserve + EXPAND_RESERVE_MONTHS * quote.payment + quote.stubInterest;
    const need = round(cost + keep - cash);
    if (need <= loan) {
      // ... and the covenants keep the headroom once the new plant's running costs come off the cash flow too (round 4c/4d, the scaled overhead).
      const after = covenantMetrics(state, { addDebt: loan, addAnnualDebtService: quote.after.annualDebtService - r.metrics().annualDebtService, addAnnualOperatingCashFlow: -12 * running });
      return covenantsWithin(quote.after, EXPAND_COVENANT_HEADROOM) && covenantsWithin(after, EXPAND_COVENANT_HEADROOM) ? { loan, keep } : null;
    }
    loan = need;
  }
  return null;
}

/** A build the advisor can suggest (expand, firstBuild): the plan at its corner and how it is paid. */
interface BuildChoice {
  node: NodeId;
  plan: BuildOutPlan & { lit?: readonly SegmentId[] };
  cpp: number;
  funding: ExpandFunding;
  /** The new area's installs within EXPAND_INSTALL_MONTHS (expectedAreaInstalls). */
  installs: number;
  /** A smaller plan than the whole build-out (coverage.smallerBuildPlan). */
  smaller: boolean;
  /** A new company's first build (no cabinet yet). */
  first: boolean;
  years: TermYears;
  /** The customers its streets should sign at your prices (planCustomers). */
  customers: number;
}

/**
 * The customers a plan's streets should sign at your prices (round 4c/4d):
 * over the parcels it newly passes (planStreets), units x the target take
 * rate for their kind (sales.stateTakeRate; a new area has no incumbent
 * promo). Apartments and businesses sign up less than homes, so a plan
 * passing many apartment units can sign fewer customers than one passing
 * fewer homes.
 */
export function planCustomers(state: GameState, plan: Pick<BuildOutPlan, 'node'> & { lit?: readonly SegmentId[] }): number {
  const rate = new Map<ParcelKind, number>();
  let target = 0;
  for (const segment of planStreets(state, plan)) {
    for (const id of parcelsServedBy(state.city, segment)) {
      const parcel = state.city.parcels[id];
      if (!parcel || parcel.appearsDay > state.day) continue;
      let take = rate.get(parcel.kind);
      if (take === undefined) {
        take = stateTakeRate(state, parcel.kind);
        rate.set(parcel.kind, take);
      }
      target += parcel.units * take;
    }
  }
  return target;
}

/**
 * Whether `plan` at `node` (signing `customers`: planCustomers) beats `best`:
 * more customers signed at your prices (round 4c/4d; round 4b counted
 * passings, which favored apartment blocks that sign up less), then a lower
 * CPP, then a lower node id.
 */
function betterExpand(plan: BuildOutPlan, node: NodeId, customers: number, best: { node: NodeId; cpp: number; customers: number }): boolean {
  if (customers !== best.customers) return customers > best.customers;
  const cpp = plan.cpp ?? Number.POSITIVE_INFINITY;
  if (cpp !== best.cpp) return cpp < best.cpp;
  return node < best.node;
}

/**
 * Whether a first build can pay its way (round 4c/4d, spec B: never a build
 * that cannot break even): its streets signed up to target (areaSignups'
 * target units) at the households' signup price (customers.forecastCustomers)
 * less overhead.perCustomerCost cover the running costs it leaves the
 * company with (the overhead base, the marketing budget, today's plant and
 * the plan's own: planRunningCost).
 */
function firstBuildPays(state: GameState, r: Readings, plan: BuildOutPlan & { lit?: readonly SegmentId[] }, target: number): boolean {
  const margin = r.forecast().signupPrice - perCustomerCost(state);
  const fixed = fixedOverheadLines(state);
  const costs = fixed.base + fixed.perPlant + monthlyPoleRent(state) + state.sales.marketingPerMonth + planRunningCost(state, plan);
  return target * margin > costs;
}

/**
 * The build expand (or, on a new company with no cabinet, firstBuild)
 * suggests, or null. Only when compliant (stage and today's figures, loans
 * not called) with both covenants at least COVENANT_RISK_MARGIN inside their
 * limits, installs running, the runway at least EXPAND_MIN_RUNWAY_MONTHS
 * (when burning) and a PON port free for its splitters; cash beyond what
 * earlier suggestions spend must cover the base reserve
 *   EXPAND_RESERVE_MONTHS x (fixed costs: overhead + marketing + pole rent,
 *     + the month's scheduled debt service + the monthly install pace: the
 *     larger of the measured one, monthlyInstallPace, and what the planned
 *     network should bring, plannedInstallPace)
 *   + the funding cushion (debt.fundingHint: a month of fixed costs and the next debt service).
 * Each plan's own reserve adds EXPAND_RESERVE_MONTHS of what it adds to the
 * running costs (planRunningCost) and the new area's installs within
 * EXPAND_INSTALL_MONTHS (expectedAreaInstalls); it is paid from cash, or
 * with a covenant-safe term loan (expandFunding: within maxSafeTermLoan at
 * EXPAND_COVENANT_HEADROOM, none once an earlier suggestion borrowed or
 * said not to). Round 4c/4d (spec B): the corners come from rankedCorners
 * (every candidate, those the cash and the largest safe loan could pay for
 * first); past any corner the player snoozed, at least EXPAND_CANDIDATES_MAX
 * are priced (coverage.buildOutPlan), then more until one the cash covers
 * turns up, at most EXPAND_PRICE_MAX: the plan green, at least
 * EXPAND_MIN_PASSINGS newly passed, the most customers signed at your
 * prices first (planCustomers; ties: lower CPP, then node id). When no whole build-out fits, a smaller plan
 * (coverage.smallerBuildPlan: the cabinet, its feeder and the densest of its
 * streets the money covers) at the first SMALLER_CANDIDATES_MAX corners. A
 * first build may be amber when nothing green fits, and must pay its way
 * (firstBuildPays).
 */
function chooseBuild(state: GameState, r: Readings): BuildChoice | null {
  if (state.debt.covenant.stage !== 'compliant' || state.debt.acceleration !== null || state.sales.installsPaused) return null;
  const runway = r.runway();
  if (runway !== null && runway < EXPAND_MIN_RUNWAY_MONTHS) return null;
  if (ponPortsUsed(state) + CABINET_START_SPLITTERS > state.network.olt.ponPorts) return null;
  const m = r.metrics();
  if (!m.compliant || !covenantsWithin(m, COVENANT_RISK_MARGIN)) return null;
  const first = state.network.cabinets.length === 0;
  const service = Math.max(r.nextService(), Math.ceil(m.annualDebtService / 12));
  const installs = Math.max(monthlyInstallPace(state), plannedInstallPace(state, r.subscribed()));
  const running = r.fixed() + monthlyPoleRent(state) + service + installs;
  const base = EXPAND_RESERVE_MONTHS * running + r.keep();
  const cash = state.finance.cash - r.claims.spend;
  if (cash < base) return null;
  const years = longestTerm();
  const safeLoan = r.claims.borrowed || r.claims.holdBorrowing ? 0 : maxSafeTermLoan(state, years, EXPAND_COVENANT_HEADROOM);
  const passingsToday = r.service().passings;
  const severity = severityOf(first ? ADVICE_PRIORITY.firstBuild : ADVICE_PRIORITY.expandCash);
  const keyOf = (node: NodeId) => (first ? ADVICE_KEYS.firstBuild(node) : ADVICE_KEYS.expand(node));
  const budget = cash - base + safeLoan;

  /** The plan at `node` with its reserve and funding, or null when it cannot be paid for (or, first, cannot pay its way). */
  const reserveOf = (plan: BuildOutPlan & { lit?: readonly SegmentId[] }, area: ReturnType<typeof areaSignups>): number =>
    Math.max(base + EXPAND_RESERVE_MONTHS * planRunningCost(state, plan) + area.installs, r.keep() + rampTrough(state, r, plan, area, passingsToday, installs));
  const price = (plan: BuildOutPlan & { lit?: readonly SegmentId[] }, node: NodeId, smaller: boolean): BuildChoice | null => {
    const area = areaSignups(state, plan, passingsToday, EXPAND_INSTALL_MONTHS, r.ramp(passingsToday + plan.passings));
    if (first && !firstBuildPays(state, r, plan, area.target)) return null;
    const reserve = reserveOf(plan, area);
    // An amber build is paid from cash only (it raises what the bank charges on new loans: CPP_SPREAD_BPS).
    const amberBuild = plan.cpp !== null && cppBand(plan.cpp) !== 'green';
    const funding = expandFunding(state, r, plan.cost, reserve, amberBuild ? 0 : safeLoan, years, planRunningCost(state, plan));
    if (!funding) return null;
    return { node, plan, cpp: plan.cpp ?? Number.POSITIVE_INFINITY, funding, installs: area.installs, smaller, first, years, customers: area.target };
  };
  // "Nothing burns" needs a closed month with lit homes behind it: before the first close (or while the first
  // cabinet is still being built) runway reads null only because there is nothing to measure yet.
  const nothingBurns = runway === null && passingsToday > 0 && state.finance.reports.length > 0;
  const usable = (plan: BuildOutPlan): 'green' | 'amber' | null => {
    if (plan.cpp === null || plan.passings < EXPAND_MIN_PASSINGS || !plan.commands.some((c) => c.type === 'placeCabinet')) return null;
    const band = cppBand(plan.cpp);
    // Amber for a first build, or once nothing burns and no green build is left that cash covers.
    return band === 'green' ? 'green' : band === 'amber' && (first || nothingBurns) ? 'amber' : null;
  };

  const corners = r.corners();
  // Past the first EXPAND_CANDIDATES_MAX, only corners whose estimate looks green (amber for a first build, or when nothing burns) are worth a price.
  const promising = new Set<NodeId>(corners.filter((c) => c.cpp <= (first || nothingBurns ? CPP_TARGET * CPP_AMBER_MULTIPLIER : CPP_TARGET)).map((c) => c.node));
  const ranked = rankCorners(corners, budget);
  const open: NodeId[] = [];
  let green: BuildChoice | null = null;
  let amber: BuildChoice | null = null;
  let priced = 0;
  for (const node of ranked) {
    if (priced >= EXPAND_PRICE_MAX || (priced >= EXPAND_CANDIDATES_MAX && (green !== null || !promising.has(node)))) break;
    if (r.passOver({ key: keyOf(node), severity })) continue;
    open.push(node);
    const built = r.buildOut(node);
    priced++;
    const band = usable(built);
    if (band === null) continue;
    const best = band === 'green' ? green : amber;
    // Only a better plan than the best affordable one so far needs pricing: more customers, then a lower CPP, then a lower node id.
    if (best !== null && !betterExpand(built, node, planCustomers(state, built), best)) continue;
    const choice = price(built, node, false);
    if (!choice) continue;
    if (band === 'green') green = choice;
    else amber = choice;
  }
  if (green === null || first) {
    // No whole build-out fits (or, for a first build, one that does may still sign fewer customers than part of a
    // richer area): the best-ranked corners with only as much of their reach as the money covers.
    const tries = first ? ranked.filter((n) => promising.has(n) && !r.isPassed({ key: keyOf(n), severity })).slice(0, FIRST_BUILD_SMALLER_MAX) : open.filter((n) => promising.has(n)).slice(0, SMALLER_CANDIDATES_MAX);
    for (const node of tries) {
      let maxCost = budget;
      for (let attempt = 0; attempt < 3 && maxCost > 0; attempt++) {
        const smaller = smallerBuildPlan(state, node, maxCost, r.buildOut(node));
        if (!smaller) break;
        const band = usable(smaller);
        if (band === null) break;
        const best = band === 'green' ? green : amber;
        if (best !== null && !betterExpand(smaller, node, planCustomers(state, smaller), best)) break;
        const choice = price(smaller, node, smaller.cost < r.buildOut(node).cost);
        if (choice) {
          if (band === 'green') green = choice;
          else amber = choice;
          break;
        }
        // Short of its reserve: try again with that much less cable.
        const reserve = reserveOf(smaller, areaSignups(state, smaller, passingsToday, EXPAND_INSTALL_MONTHS, r.ramp(passingsToday + smaller.passings)));
        const over = smaller.cost + reserve - (cash + safeLoan);
        maxCost = smaller.cost - Math.max(over, LOAN_ROUNDING);
      }
    }
  }
  return green ?? amber;
}

/** "(aerial or underground, street by street, whichever costs less to own)" for a plan's methods. */
function methodsOf(build: BuildOutPlan): string {
  return build.aerial.length > 0 && build.underground.length > 0
    ? ' (aerial or underground, street by street, whichever costs less to own)'
    : build.underground.length > 0
      ? ' (underground)'
      : '';
}

/** The commands, wording and detail of a BuildChoice's card (expand and firstBuild). */
function buildCard(state: GameState, choice: BuildChoice): { commands: Command[]; lead: string; reserveText: string; loanText: string } {
  const { node, plan: build, funding, years } = choice;
  const corner = cornerName(state.city, node);
  const part = choice.smaller ? ', the densest streets in its reach first (the rest can follow when cash allows)' : '';
  const lead =
    `A cabinet at ${corner} would add ${count(build.passings, 'passing', 'passings')} not served today at about ${money(choice.cpp)} each ` +
    `(target ${money(CPP_TARGET)}), for ${money(build.cost)} with its cable${methodsOf(build)}${part}.`;
  const reserveText = `${money(funding.keep)} in reserve for ${EXPAND_RESERVE_MONTHS} months of running costs, loan payments and installs and the new area's first installs`;
  const loanText =
    funding.loan === 0
      ? `Cash covers it and still keeps ${reserveText}.`
      : `A ${money(funding.loan)} ${years}-year term loan covers it, leaves the covenants at least ${pct(EXPAND_COVENANT_HEADROOM)} inside their limits and keeps ${reserveText}.`;
  const commands: Command[] = [];
  if (funding.loan > 0) commands.push({ type: 'takeTermLoan', amount: funding.loan, termYears: years });
  commands.push(...build.commands);
  return { commands, lead, reserveText, loanText };
}

/**
 * expand (tip): a new cabinet and the cable to light what it reaches
 * (chooseBuild on a company that has placed a cabinet): exactly
 * coverage.buildOutPlan (its commands, cost, passings and CPP), or a smaller
 * plan of it when no whole build-out fits (coverage.smallerBuildPlan), so a
 * player or bot following it does what was costed. Green, or (round 4c/4d)
 * amber paid from cash once nothing burns and no green build fits: an area
 * above the CPP target still pays for itself many times over the years. Not beside covenantCure
 * (snoozed or not: chooseBuild needs both covenants COVENANT_RISK_MARGIN
 * inside their limits) or an earlier suggestion about cash running short.
 * Commands [takeTermLoan?, ...plan.commands], spend = plan.cost, extraSpend
 * 0, keep = the reserve (with the loan's payments). Show me: the corner.
 */
function expandRule(state: GameState, r: Readings): AdvicePlan | null {
  if (state.network.cabinets.length === 0) return null;
  if (r.claims.holdBorrowing || r.claims.cashShort) return null;
  const choice = r.build();
  if (!choice) return null;
  const { node, plan: build, funding } = choice;
  const corner = cornerName(state.city, node);
  const card = buildCard(state, choice);
  const priority = funding.loan === 0 ? ADVICE_PRIORITY.expandCash : ADVICE_PRIORITY.expandLoan;
  const action: AdviceAction = { kind: 'focusNode', node };
  const homes = count(build.passings, 'home', 'homes');
  const why: Wording =
    funding.loan === 0
      ? [`A cabinet here lights ${homes} at ${money(choice.cpp)} each (target ${money(CPP_TARGET)}). ${costs(build.cost)}`, `It lights ${homes} at ${money(choice.cpp)} each. ${costs(build.cost)}`]
      : [
          `It lights ${homes} at ${money(choice.cpp)} each; a ${money(funding.loan)} loan covers part. ${costs(build.cost)}`,
          `It lights ${homes} at ${money(choice.cpp)} each, part on a loan. ${costs(build.cost)}`,
        ];
  const title: Wording = [`Build a cabinet at ${corner}`, `Build a cabinet at ${firstStreet(corner)}`, 'Build your next cabinet'];
  const amber =
    cppBand(choice.cpp) === 'green'
      ? ''
      : ` It costs more per home than the ${money(CPP_TARGET)} target, which raises what the bank charges on new loans, so it is paid from cash; no greener area is left within reach.`;
  const advice = makeAdvice('expand', priority, title, why, action, ADVICE_KEYS.expand(node), { detail: `${card.lead} ${card.loanText}${amber}`, cost: build.cost });
  return plan(advice, card.commands, build.cost, 0, funding.keep);
}

/**
 * firstBuild (important, round 4c/4d, spec B): a new company (no cabinet
 * yet) gets a concrete first build sized to its cash: chooseBuild's plan
 * ("Light Elm St & 4th first: 140 homes at $857 each. Costs $120,000."),
 * green when one fits, else amber (a first area must exist before anything
 * else does), never one that cannot pay its way, from cash keeping the
 * reserve (a new company has nothing to borrow against). When none fits
 * (too little cash for any build that pays its way) it says so, with no
 * command (Show me: the central office). Once a cabinet is placed but
 * nothing is lit yet, a tip with no command: the first streets light up
 * when it and its cable are built. Show me: the corner (the Customers panel
 * while building).
 */
function firstBuildRule(state: GameState, r: Readings): AdvicePlan | null {
  if (state.network.cabinets.length > 0) {
    if (r.service().passings > 0) return null;
    const detail =
      'Your first cabinet and its cable are being built. Homes on its streets can sign up as soon as it is live; until then the company only spends, ' +
      'so hold off on more building and keep cash for the first installs.';
    const why: Wording = ['Your first cabinet and cable are being built; homes can sign up once it is live.', 'Your first cabinet is being built.'];
    return plan(makeAdvice('firstBuild', ADVICE_PRIORITY.firstBuildWait, 'Your first streets light up soon', why, CUSTOMERS, 'firstBuild', { detail }));
  }
  if (r.claims.holdBorrowing || r.claims.cashShort) return null;
  const choice = r.build();
  if (!choice) {
    // No build that pays its way fits the cash (or none can be built now): say so rather than nothing.
    if (state.debt.covenant.stage !== 'compliant' || state.sales.installsPaused) return null;
    const detail =
      `No area the cash covers would pay its way: signed up to its target, none brings in enough to cover the ${money(fixedOverheadLines(state).base)} a month ` +
      `the office costs, the marketing budget and its own upkeep while keeping a reserve for the first installs. Light the densest street you can reach from the ` +
      'central office by hand, keep marketing low until it is lit, and build out from there.';
    const why: Wording = ['No whole area pays its way at this cash: light the densest street near the office.', 'Light the densest street near the office first.'];
    const action: AdviceAction = { kind: 'focusNode', node: state.city.coNode };
    return plan(makeAdvice('firstBuild', ADVICE_PRIORITY.firstBuild, 'Pick a dense street to light first', why, action, 'firstBuild', { detail }));
  }
  const { node, plan: build, funding } = choice;
  const corner = cornerName(state.city, node);
  const card = buildCard(state, choice);
  const homes = count(build.passings, 'home', 'homes');
  const band = cppBand(choice.cpp);
  const amber =
    band === 'green'
      ? ''
      : ` It costs more per home than the ${money(CPP_TARGET)} target, which the bank notices, but it is the best first area your cash covers; build greener areas next.`;
  const why: Wording = [
    `Your first cabinet here lights ${homes} at ${money(choice.cpp)} each. ${costs(build.cost)}`,
    `It lights ${homes} at ${money(choice.cpp)} each. ${costs(build.cost)}`,
  ];
  const title: Wording = [`Light ${corner} first`, `Light ${firstStreet(corner)} first`, 'Light your first streets'];
  const action: AdviceAction = { kind: 'focusNode', node };
  const advice = makeAdvice('firstBuild', ADVICE_PRIORITY.firstBuild, title, why, action, ADVICE_KEYS.firstBuild(node), {
    detail: `${card.lead} ${card.loanText}${amber}`,
    cost: build.cost,
  });
  return plan(advice, card.commands, build.cost, 0, funding.keep);
}

// ---------------------------------------------------------------------------
// Growing on what you built (round 4c/4d, spec I.6)
// ---------------------------------------------------------------------------

/** Lit areas' subscribed units against their target (growCustomers' "under-signed"). */
interface SignedUp {
  /** Units passed on lit streets. */
  passings: number;
  /** Subscribed units there. */
  units: number;
  /** Their target units (sales.stateTakeRate per kind and cabinet). */
  target: number;
}

function signedUp(state: GameState, service: ServiceSnapshot, subscribed: ReadonlyMap<ParcelId, number>): SignedUp {
  const rates = new Map<string, number>();
  let passings = 0;
  let units = 0;
  let target = 0;
  for (const id of service.passedParcels) {
    const parcel = state.city.parcels[id];
    if (!parcel) continue;
    const cabinet = service.servingCabinet.get(parcel.segment);
    if (cabinet === undefined) continue;
    const key = `${cabinet}:${parcel.kind}`;
    let rate = rates.get(key);
    if (rate === undefined) {
      rate = stateTakeRate(state, parcel.kind, cabinet);
      rates.set(key, rate);
    }
    passings += parcel.units;
    units += subscribed.get(id) ?? 0;
    target += parcel.units * rate;
  }
  return { passings, units, target };
}

/** What growthWith found: the options (cheapest per customer first), the new-fiber option on its own, a customer's monthly margin, and a marketing cut worth making. */
interface Growth {
  options: GrowthOption[];
  build: GrowthOption | null;
  margin: number;
  /** The marketing budget one MARKETING_STEP lower when that step brings too few customers for what it costs (see growthWith), else null. */
  trim: { to: number; lost: number; saving: number } | null;
}

/** cost / customers, whole dollars; null below a hundredth of a customer. */
function perCustomer(cost: number, customers: number): number | null {
  return customers >= 0.01 ? Math.round(cost / customers) : null;
}

/**
 * The growth levers on `state` given what earlier suggestions claimed
 * (growthOptions with fresh readings; growCustomers with its call's). Each
 * is priced per new customer over CUSTOMER_QUOTE_MONTHS from the customers
 * model (customers.forecastCustomers):
 * - marketing: the budget one customers.MARKETING_STEP higher (at most
 *   MARKETING_MAX_PER_MONTH) against today's (what customers.quoteMarketing
 *   at both budgets says: the signups it adds), costing the step x the
 *   months; setMarketing;
 * - a campaign: customers.quoteCampaign at the CAMPAIGN_QUOTES_MAX cabinet
 *   areas with the most households not signed up (customers.customerAreas,
 *   none running or cooling down there), the one cheapest per customer;
 *   runCampaign;
 * - referral credits, while off: customers.quoteReferrals(true): the extra
 *   signups, costing the credits; setReferrals;
 * - new fiber: the build expand or firstBuild would suggest (chooseBuild),
 *   costing the plan with the installs of the signups it brings within the
 *   horizon (areaSignups), over those signups; its commands with any
 *   financing first.
 * A lever needs at least GROW_MIN_CUSTOMERS, a cost per customer paid back
 * by GROWTH_PAYBACK_MONTHS of a customer's margin (what a unit pays less
 * overhead.perCustomerCost), and must be affordable under the runway rules:
 * installs running, no earlier suggestion about cash running short, the
 * runway (when burning) at least EXPAND_MIN_RUNWAY_MONTHS, and cash
 * covering its price (a campaign) or EXPAND_RESERVE_MONTHS of its running
 * cost (marketing, credits) with the cushion and, while the company burns
 * cash (monthlyFlowNow below 0), EXPAND_MIN_RUNWAY_MONTHS of that burn on
 * top. Levers are weighed only while the lit areas are under-signed
 * (underSigned), unless `all` (growthOptions). The build is affordable when
 * chooseBuild found it. Cheapest per customer first (ties: the lever order
 * campaign, marketing, referrals, build). Also, for growCustomers: `trim`,
 * the marketing budget one MARKETING_STEP lower when that step would bring
 * fewer than GROW_MIN_CUSTOMERS or save more than GROWTH_TRIM_FACTOR x the
 * payback a raise needs per customer it loses (never beside a raise).
 */
/** Lit areas under-signed: subscribed units below GROW_UNDER_SIGNED_SHARE of their target, with at least GROW_MIN_GAP_UNITS to go. */
function underSigned(signed: SignedUp): boolean {
  return signed.units < GROW_UNDER_SIGNED_SHARE * signed.target && signed.target - signed.units >= GROW_MIN_GAP_UNITS;
}

function growthWith(state: GameState, r: Readings, all = false): Growth {
  const forecast = r.forecast();
  const margin = Math.max(0, (forecast.units > 0 ? forecast.price : forecast.signupPrice) - perCustomerCost(state));
  const empty: Growth = { options: [], build: null, margin, trim: null };
  if (state.gameOver || state.sales.installsPaused || r.claims.cashShort) return empty;
  const runway = r.runway();
  const roomy = runway === null || runway >= EXPAND_MIN_RUNWAY_MONTHS;
  const months = CUSTOMER_QUOTE_MONTHS;
  // While the company burns cash, a lever leaves EXPAND_MIN_RUNWAY_MONTHS of that burn on top of the cushion.
  const hold = EXPAND_MIN_RUNWAY_MONTHS * Math.max(0, -monthlyFlowNow(state, r));
  const covers = (cost: number) => cashCovers(state, r, cost + hold);
  const sensible = (cpc: number | null, customers: number) => cpc !== null && customers >= GROW_MIN_CUSTOMERS && cpc <= GROWTH_PAYBACK_MONTHS * margin;
  const levers: GrowthOption[] = [];
  const lit = r.service().passings > 0;
  if (lit && roomy && (all || underSigned(r.signed()))) {
    // A neighborhood campaign where the most households have not signed up.
    const areas = customerAreas(state)
      .filter((a) => a.passings > a.subscribed && (a.campaign === null || state.day >= a.campaign.cooldownUntil))
      .sort((a, b) => b.passings - b.subscribed - (a.passings - a.subscribed) || a.cabinet - b.cabinet)
      .slice(0, CAMPAIGN_QUOTES_MAX);
    let campaign: GrowthOption | null = null;
    for (const area of areas) {
      const quote = quoteCampaign(state, area.cabinet);
      if (!quote.ok || !covers(quote.cost)) continue;
      const cpc = perCustomer(quote.cost, quote.extraSignups);
      if (!sensible(cpc, quote.extraSignups)) continue;
      if (campaign === null || (cpc as number) < (campaign.costPerCustomer as number)) {
        campaign = { lever: 'campaign', customers: quote.extraSignups, cost: quote.cost, costPerCustomer: cpc, cabinet: area.cabinet, node: area.node, commands: [{ type: 'runCampaign', cabinet: area.cabinet }] };
      }
    }
    if (campaign) levers.push(campaign);
    // One marketing step more.
    const m = state.sales.marketingPerMonth;
    const next = Math.min(MARKETING_MAX_PER_MONTH, m + MARKETING_STEP);
    if (next > m && covers(EXPAND_RESERVE_MONTHS * (next - m))) {
      const up = forecastCustomers(state, { marketingPerMonth: next });
      const customers = Math.max(0, up.signups - forecast.signups);
      const cost = (next - m) * months;
      const cpc = perCustomer(cost, customers);
      if (sensible(cpc, customers)) levers.push({ lever: 'marketing', customers, cost, costPerCustomer: cpc, cabinet: null, node: null, commands: [{ type: 'setMarketing', perMonth: next }] });
    }
    // Referral credits (customers.quoteReferrals(true)'s figures: credits off is today's forecast).
    if (!state.customers.referrals) {
      const credited = forecastCustomers(state, { referrals: true });
      const customers = Math.max(0, credited.signups - forecast.signups);
      const cost = credited.referrals * 2 * REFERRAL_CREDIT;
      const cpc = perCustomer(cost, customers);
      if (sensible(cpc, customers) && covers((EXPAND_RESERVE_MONTHS * cost) / months)) {
        levers.push({ lever: 'referrals', customers, cost, costPerCustomer: cpc, cabinet: null, node: null, commands: [{ type: 'setReferrals', on: true }] });
      }
    }
  }
  // New fiber: the build expand or firstBuild suggests, with the installs its signups bring.
  let build: GrowthOption | null = null;
  const choice = r.claims.holdBorrowing ? null : r.build();
  if (choice) {
    const area = areaSignups(state, choice.plan, r.service().passings, months, r.ramp(r.service().passings + choice.plan.passings));
    const cost = choice.plan.cost + area.installs;
    const card = buildCard(state, choice);
    if (area.signups >= GROW_MIN_CUSTOMERS) {
      build = { lever: 'build', customers: area.signups, cost, costPerCustomer: perCustomer(cost, area.signups), cabinet: null, node: choice.node, commands: card.commands };
    }
  }
  const order: Record<GrowthOption['lever'], number> = { campaign: 0, marketing: 1, referrals: 2, build: 3 };
  const options = [...levers, ...(build ? [build] : [])].sort(
    (a, b) => (a.costPerCustomer ?? Number.POSITIVE_INFINITY) - (b.costPerCustomer ?? Number.POSITIVE_INFINITY) || order[a.lever] - order[b.lever],
  );
  // The last marketing step: worth cutting when what it saves per customer it loses is well past the payback a raise needs.
  let trim: Growth['trim'] = null;
  const m = state.sales.marketingPerMonth;
  if (lit && m > 0 && !levers.some((o) => o.lever === 'marketing')) {
    const to = Math.max(0, m - MARKETING_STEP);
    const down = forecastCustomers(state, { marketingPerMonth: to });
    const lost = Math.max(0, forecast.signups - down.signups);
    const saving = (m - to) * months;
    if (lost < GROW_MIN_CUSTOMERS || saving > GROWTH_TRIM_FACTOR * GROWTH_PAYBACK_MONTHS * margin * lost) trim = { to, lost, saving };
  }
  return { options, build, margin, trim };
}

/**
 * Round 4c/4d (spec I.6): the ways to more customers the player can afford
 * today, each priced per customer over CUSTOMER_QUOTE_MONTHS (marketing one
 * customers.MARKETING_STEP higher, the best neighborhood campaign, referral
 * credits, and the build expand or firstBuild would suggest with its
 * installs), cheapest per customer first; see growthWith for what makes an
 * option sensible and affordable. [] once the game is over. Pure.
 */
export function growthOptions(state: GameState): GrowthOption[] {
  if (state.gameOver) return [];
  return growthWith(state, readingsOf(state, false), true).options;
}

/** "about 20 homes" / "less than one home" for an expected count of new customers. */
function aboutHomes(customers: number): string {
  const n = Math.round(customers);
  return n >= 1 ? `about ${count(n, 'home', 'homes')}` : 'less than one home';
}

/** What a growth option is, for the detail: "A campaign at Elm St & 4th would sign about 20 homes for $1,500 ($75 each)". */
function optionPhrase(state: GameState, option: GrowthOption): string {
  const each = option.costPerCustomer === null ? '' : ` (${money(option.costPerCustomer)} each)`;
  switch (option.lever) {
    case 'campaign': {
      const cabinet = state.network.cabinets.find((c) => c.id === option.cabinet);
      const place = cabinet ? cornerName(state.city, cabinet.node) : 'one of your areas';
      return `a neighborhood campaign at ${place} would sign ${aboutHomes(option.customers)} for ${money(option.cost)}${each}`;
    }
    case 'marketing':
      return `${money(Math.round(option.cost / CUSTOMER_QUOTE_MONTHS))} a month more marketing would sign ${aboutHomes(option.customers)} more in ${CUSTOMER_QUOTE_MONTHS} months for ${money(option.cost)}${each}`;
    case 'referrals':
      return `referral credits would sign ${aboutHomes(option.customers)} more in ${CUSTOMER_QUOTE_MONTHS} months for about ${money(option.cost)} of credits${each}`;
    default:
      return `new fiber would sign ${aboutHomes(option.customers)} in ${CUSTOMER_QUOTE_MONTHS} months for ${money(option.cost)} with its installs${each}`;
  }
}

/**
 * growCustomers (round 4c/4d, spec I.6): lit areas under-signed (their
 * subscribed units below GROW_UNDER_SIGNED_SHARE of their target, with at
 * least GROW_MIN_GAP_UNITS to go) and a lever (marketing, a campaign,
 * referral credits) cheaper per customer than new fiber, or no affordable
 * build at all (growthWith): a tip with the cheapest lever, in plain words
 * ("Your lit streets are only 35% signed up: a campaign here signs about 20
 * homes for $1,500."), its figures and the alternatives it beat ("..., cheaper
 * than new fiber at about $2,400 per customer") in the detail. Its plan's
 * commands are the lever's (setMarketing, runCampaign or setReferrals), a
 * campaign's price its spend, a running cost's first EXPAND_RESERVE_MONTHS
 * months its extraSpend. When new fiber is cheapest, expand (or firstBuild)
 * says so instead. While cash burns (a runway) and no lever is worth it, a
 * quieter tip with no command says how much of the lit streets is signed up
 * and that more customers is how the burn ends (Open Customers), so a burning
 * company always has a next step. Not while installs are paused or an
 * earlier suggestion is about cash running short. Show me: the campaign's
 * cabinet, else Open Customers.
 */
function growCustomersRule(state: GameState, r: Readings): AdvicePlan | null {
  if (state.sales.installsPaused || r.claims.cashShort) return null;
  const signed = r.signed();
  if (signed.passings <= 0) return null;
  const take = signed.units / signed.passings;
  const under = underSigned(signed);
  const burning = r.runway() !== null;
  const marketing = state.sales.marketingPerMonth;
  if (!under && !burning && marketing <= 0) return null;
  const growth = r.growth();
  const best = under ? (growth.options[0] ?? null) : null;
  const lead = `Your lit streets are ${pct(take)} signed up`;
  if (best && best.lever !== 'build' && growth) {
    const others = growth.options.slice(1, 3).map((o) => optionPhrase(state, o));
    const vs = growth.build && growth.build !== best && growth.build.costPerCustomer !== null ? `, cheaper than new fiber at about ${money(growth.build.costPerCustomer)} per customer` : '';
    const alternatives = others.length > 0 ? ` Next best: ${others.join('; ')}.` : '';
    const detail =
      `${lead} (${groupThousands(signed.units)} of the ${groupThousands(signed.passings)} homes you pass; about ${groupThousands(Math.round(signed.target))} would at your prices). ` +
      `${capitalize(optionPhrase(state, best))}${vs}.${alternatives}`;
    const n = aboutHomes(best.customers);
    let title: Wording;
    let why: Wording;
    let action: AdviceAction = CUSTOMERS;
    let key: string;
    let spend = 0;
    let extra = 0;
    let cost: number | null = best.cost;
    if (best.lever === 'campaign') {
      const cabinet = state.network.cabinets.find((c) => c.id === best.cabinet);
      const place = cabinet ? cornerName(state.city, cabinet.node) : 'your streets';
      title = [`Run a campaign at ${place}`, `Run a campaign at ${firstStreet(place)}`, 'Run a neighborhood campaign'];
      why = [`${lead}: a campaign here signs ${n} for ${money(best.cost)}.`, `A campaign here signs ${n} for ${money(best.cost)}.`];
      if (cabinet) action = { kind: 'focusCabinet', cabinet: cabinet.id };
      key = ADVICE_KEYS.growCustomers('campaign', best.cabinet ?? 0);
      spend = best.cost;
    } else if (best.lever === 'marketing') {
      const step = Math.round(best.cost / CUSTOMER_QUOTE_MONTHS);
      const to = state.sales.marketingPerMonth + step;
      title = [`Raise marketing to ${money(to)} a month`, 'Raise your marketing budget'];
      why = [`${lead}: ${money(step)} more marketing a month signs ${n} more a year.`, `${money(step)} more marketing a month signs ${n} more a year.`];
      key = ADVICE_KEYS.growCustomers('marketing');
      extra = EXPAND_RESERVE_MONTHS * step;
      spend = extra;
      cost = step;
    } else {
      const perMonth = Math.round(best.cost / CUSTOMER_QUOTE_MONTHS);
      title = 'Turn on referral credits';
      why = [`${lead}: referral credits sign ${n} more a year for about ${money(perMonth)} a month.`, `Referral credits sign ${n} more a year for about ${money(perMonth)} a month.`];
      key = ADVICE_KEYS.growCustomers('referrals');
      extra = EXPAND_RESERVE_MONTHS * perMonth;
      spend = extra;
      cost = perMonth;
    }
    const advice = makeAdvice('growCustomers', ADVICE_PRIORITY.growCustomers, title, why, action, key, { detail, cost });
    return plan(advice, best.commands, spend, extra);
  }
  if (growth.trim) {
    // Marketing that no longer pays: cut it a step.
    const { to, lost, saving } = growth.trim;
    const step = marketing - to;
    const detail =
      `${lead}. At ${money(marketing)} a month, marketing's last ${money(step)} a month would bring ${aboutHomes(lost)} more in the next ${CUSTOMER_QUOTE_MONTHS} months, ` +
      `${lost >= 0.01 ? `about ${money(Math.round(saving / lost))} each` : 'next to nothing'}: most homes on your streets already know you, ` +
      `and word of mouth and time do the rest. Cutting to ${money(to)} saves ${money(saving)} a year; raise it again when you light new streets.`;
    const why: Wording =
      lost >= 1
        ? [`Marketing is doing little now: ${money(step)} a month less loses only ${aboutHomes(lost)} a year.`, `${money(step)} a month less marketing loses only ${aboutHomes(lost)} a year.`]
        : [`The last ${money(step)} a month of marketing signs hardly anyone now.`, 'Your marketing signs hardly anyone now.'];
    const advice = makeAdvice('growCustomers', ADVICE_PRIORITY.growCustomers, [`Cut marketing to ${money(to)} a month`, 'Cut your marketing budget'], why, CUSTOMERS, ADVICE_KEYS.growCustomers('marketing'), { detail });
    return plan(advice, [{ type: 'setMarketing', perMonth: to }]);
  }
  if (!burning || (best && best.lever === 'build')) return null;
  // Burning with no lever worth it: what more customers would do (no command).
  const mature = r.mature();
  const detail =
    `${lead} (${groupThousands(signed.units)} of the ${groupThousands(signed.passings)} homes you pass). Homes switch over months as they hear of you and their neighbors sign up, ` +
    `so the bills grow on their own; signed up to their target, your streets would bring in about ${money(mature)} a month after running costs. ` +
    'The Customers panel shows why the rest have not switched and what each lever would do.';
  const why: Wording = [`${lead}: more customers is how you stop burning cash.`, 'More customers is how you stop burning cash.'];
  return plan(makeAdvice('growCustomers', ADVICE_PRIORITY.growCustomersHint, 'Sign up more homes on your streets', why, CUSTOMERS, ADVICE_KEYS.growCustomers('hint'), { detail }));
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
  lineup: lineupRule,
  support: supportRule,
  growCustomers: growCustomersRule,
  redCpp: redCppRule,
  firstBuild: firstBuildRule,
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

// ---------------------------------------------------------------------------
// Round 4c/4d: the month summary's data (contract: implemented; sim-advisor
// owns and may refine it). The UI (ui/briefing.ts) only words it.
// ---------------------------------------------------------------------------

/** Where each ledger category goes in the money partition: money in, or one of the three groups of money out (exhaustive). */
const MONEY_PLACE: Record<LedgerCategory, { group: MoneyGroupKey | 'in'; line: MoneyLineKey }> = {
  revenue: { group: 'in', line: 'bills' },
  loanProceeds: { group: 'in', line: 'borrowed' },
  overhead: { group: 'running', line: 'overhead' },
  payroll: { group: 'running', line: 'payroll' },
  poleRent: { group: 'running', line: 'poleRent' },
  marketing: { group: 'running', line: 'marketing' },
  repair: { group: 'running', line: 'repair' },
  other: { group: 'running', line: 'otherOut' },
  construction: { group: 'building', line: 'construction' },
  equipment: { group: 'building', line: 'equipment' },
  install: { group: 'building', line: 'install' },
  refund: { group: 'building', line: 'refund' },
  interest: { group: 'loans', line: 'interest' },
  principal: { group: 'loans', line: 'principal' },
};

const MONEY_GROUPS: readonly MoneyGroupKey[] = ['running', 'building', 'loans'];

/**
 * The money partition of a period's reports (see BriefingMoney), from their
 * ledger totals only: bills = revenue (a negative revenue total would count
 * as running costs), borrowed = loanProceeds; each group's lines are its
 * categories' totals as money out (a refund nets negative); the overhead is
 * split into overheadBase / overheadCustomers / overheadPlant when every
 * report of the period has OpsStats.overhead and the lines add up to its
 * total, else one 'overhead' line; marketing likewise into the budget
 * ('marketing'), neighborhood campaigns ('campaigns') and referral credits
 * ('referrals') when every report has MonthlyReport.customers and those two
 * fit inside it (round 4c/4d: the levers' costs, all posted as 'marketing'),
 * else one 'marketing' line; a group whose lines net to money in is 0
 * and its net goes to money in's otherIn. So in - out is exactly the sum of
 * the reports' nets. Lines of 0 are left out; group lines biggest first.
 */
export function briefingMoney(period: readonly MonthlyReport[]): BriefingMoney {
  const sums = new Map<LedgerCategory, number>();
  for (const report of period) {
    for (const [category, amount] of Object.entries(report.totals) as [LedgerCategory, number][]) sums.set(category, (sums.get(category) ?? 0) + amount);
  }
  let bills = 0;
  let borrowed = 0;
  let otherIn = 0;
  const lines: Record<MoneyGroupKey, MoneyLine[]> = { running: [], building: [], loans: [] };
  const out = (group: MoneyGroupKey, key: MoneyLineKey, amount: number) => {
    if (amount !== 0) lines[group].push({ key, amount });
  };
  for (const [category, total] of sums) {
    const place = MONEY_PLACE[category];
    if (!place || total === 0) continue;
    if (place.group === 'in') {
      if (total >= 0) {
        if (place.line === 'bills') bills += total;
        else borrowed += total;
      } else out(place.line === 'bills' ? 'running' : 'loans', place.line === 'bills' ? 'otherOut' : 'principal', -total);
      continue;
    }
    if (category === 'overhead') {
      const split = period.every((r) => r.ops?.overhead) ? period.map((r) => r.ops?.overhead) : null;
      let base = 0;
      let customers = 0;
      let plant = 0;
      for (const lines of split ?? []) {
        base += lines?.base ?? 0;
        customers += lines?.perCustomer ?? 0;
        plant += lines?.perPlant ?? 0;
      }
      if (split && base + customers + plant === -total) {
        out('running', 'overheadBase', base);
        out('running', 'overheadCustomers', customers);
        out('running', 'overheadPlant', plant);
        continue;
      }
    }
    if (category === 'marketing' && period.every((r) => r.customers)) {
      let campaigns = 0;
      let referrals = 0;
      for (const r of period) {
        campaigns += r.customers?.campaignSpend ?? 0;
        referrals += r.customers?.referralCredits ?? 0;
      }
      const budget = -total - campaigns - referrals;
      if (campaigns >= 0 && referrals >= 0 && budget >= 0) {
        out('running', 'marketing', budget);
        out('running', 'campaigns', campaigns);
        out('running', 'referrals', referrals);
        continue;
      }
    }
    out(place.group, place.line, -total);
  }
  const groups: BriefingMoneyGroup[] = MONEY_GROUPS.map((key) => {
    const own = lines[key].sort((a, b) => b.amount - a.amount);
    let net = 0;
    for (const line of own) net += line.amount;
    if (net < 0) otherIn += -net;
    return { key, total: Math.max(0, net), lines: own };
  });
  const inLines: MoneyLine[] = [{ key: 'bills', amount: bills }];
  if (borrowed !== 0) inLines.push({ key: 'borrowed', amount: borrowed });
  if (otherIn !== 0) inLines.push({ key: 'otherIn', amount: otherIn });
  const moneyIn = bills + borrowed + otherIn;
  let moneyOut = 0;
  for (const group of groups) moneyOut += group.total;
  return { in: moneyIn, inLines, out: moneyOut, groups, cashChange: moneyIn - moneyOut };
}

/** A money group's total (0 when absent). */
function groupTotal(money: BriefingMoney, key: MoneyGroupKey): number {
  return money.groups.find((g) => g.key === key)?.total ?? 0;
}

/** A money-in line's amount (0 when absent). */
function inAmount(money: BriefingMoney, key: MoneyLineKey): number {
  return money.inLines.find((l) => l.key === key)?.amount ?? 0;
}

/**
 * The period's story (see BriefingStory): bank trouble leads (stage warning
 * or worse, or the loans called with debt owed); else 'earned' when money
 * in without borrowing (bills + otherIn) covers money out; else 'building'
 * when customer bills cover running costs and loan payments; else
 * 'billsShort'.
 */
export function briefingStory(state: GameState, money: BriefingMoney): BriefingStory {
  if (state.debt.covenant.stage !== 'compliant' || (state.debt.acceleration !== null && totalDebt(state) > 0)) return 'bank';
  const bills = inAmount(money, 'bills');
  if (bills + inAmount(money, 'otherIn') >= money.out) return 'earned';
  return bills >= groupTotal(money, 'running') + groupTotal(money, 'loans') ? 'building' : 'billsShort';
}

/** Notice kinds that mean the covenant stage stepped up at a close (or a missed payment froze the line). */
const STAGE_UP_KINDS: ReadonlySet<NoticeKind> = new Set<NoticeKind>(['covenantWarning', 'covenantPenalty', 'creditFrozen', 'paymentMissed']);

/**
 * The month summary's "Needs attention" lines (see AttentionItem), most
 * pressing first, at most ATTENTION_MAX: one bank line (the loans called;
 * else a stage step-up among the period's notices; else compliant with
 * today's figures failing a check), then plant still out of service (the
 * first outaged span's street), a full cabinet (the first in
 * Sales.fullCabinets, with the homes waiting on it), and a storm this period
 * (when nothing is still out). Pure.
 */
export function attentionItems(state: GameState, notices: readonly Notice[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  const bank: AttentionItem['action'] = { kind: 'openPanel', panel: 'bank' };
  const owed = totalDebt(state) > 0;
  const stage = state.debt.covenant.stage;
  if (state.debt.acceleration !== null && owed) {
    items.push({ kind: 'loansCalled', action: bank, place: null, count: state.debt.acceleration.closesLeft, stage });
  } else if (stage !== 'compliant' && notices.some((n) => STAGE_UP_KINDS.has(n.kind))) {
    items.push({ kind: 'bankStage', action: bank, place: null, count: null, stage });
  } else if (stage === 'compliant' && owed && !covenantMetrics(state).compliant) {
    items.push({ kind: 'bankWatch', action: bank, place: null, count: null, stage: null });
  }
  const out = outageSpanIds(state);
  if (out.length > 0) {
    const span = state.network.spans.find((x) => x.id === out[0]);
    if (span) {
      const segment = state.city.segments[span.segment];
      items.push({ kind: 'outage', action: { kind: 'focusSegment', segment: span.segment }, place: segment ? segment.name : null, count: out.length, stage: null });
    }
  }
  const full = state.sales.fullCabinets[0];
  const cabinet = full === undefined ? undefined : state.network.cabinets.find((c) => c.id === full);
  if (cabinet) {
    const subscribed = new Map<ParcelId, number>();
    for (const account of state.sales.accounts) subscribed.set(account.parcel, accountUnits(account));
    const waiting = demandWaiting(state, getService(state), subscribed).get(cabinet.id) ?? null;
    items.push({ kind: 'cabinetFull', action: { kind: 'focusCabinet', cabinet: cabinet.id }, place: cornerName(state.city, cabinet.node), count: waiting, stage: null });
  }
  if (out.length === 0) {
    const storms = notices.filter((n) => n.kind === 'storm');
    const last = state.weather.storms.at(-1);
    if (storms.length > 0 && last) {
      const node = nearestCorner(state.city, last.x, last.y);
      if (node !== null) items.push({ kind: 'storm', action: { kind: 'focusNode', node }, place: cornerName(state.city, node), count: storms.length, stage: null });
    }
  }
  return items.slice(0, ATTENTION_MAX);
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
    // Round 4b: debt is neither good nor bad news by itself (borrowing to build is the plan): neutral.
    change('debt', 'Debt', debtAt(report) ?? debt, debtAt(previous), null, 'money'),
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
  const planned = planAll(state);
  const advice = planned.plans.slice(0, ADVICE_MAX).map((p) => p.advice);

  const money = briefingMoney(period);
  const briefing: Briefing = {
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
    snoozed: planned.snoozed,
    needsAttention: advice.some((a) => a.severity === 'urgent') || notices.some((n) => noticeNeedsAttention(state, n)),
    // Round 4c/4d: the month summary's story, money bars, cash card and attention lines.
    story: briefingStory(state, money),
    money,
    cash: {
      change: money.cashChange,
      end: report.cashEnd,
      perMonth: Math.round(money.cashChange / months),
      runwayMonths: runwayMonths(state),
      paceMonths: money.cashChange < 0 ? Math.floor((Math.max(0, report.cashEnd) * months) / -money.cashChange) : null,
      building: groupTotal(money, 'building') > 0,
      withoutBuilding: inAmount(money, 'bills') - groupTotal(money, 'running') - groupTotal(money, 'loans'),
    },
    attention: attentionItems(state, notices),
  };
  builtOn.set(briefing, state.day);
  return briefing;
}

// The day of the state each briefing was built from (derived, never saved): a side table, since Briefing is the contract's shape.
const builtOn = new WeakMap<Briefing, number>();

/**
 * The game day of the state `briefing` was built from (buildBriefing), or
 * null for a briefing object it did not build (a copy). A briefing built on
 * its report's close day (closeDayOf(briefing.report)) is the close-time
 * one; the menu's "Latest briefing" later in the month is built on a later
 * day. The sheet records the suggestions shown (noteAdviceShown) only for
 * the close-time one.
 */
export function briefingBuiltOn(briefing: Briefing): number | null {
  return builtOn.get(briefing) ?? null;
}
