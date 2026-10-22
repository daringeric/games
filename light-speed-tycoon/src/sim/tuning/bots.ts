// Scripted players for the balance harness (harness.ts runBot).
//
// Owner: balance-tuning workstream.
//
// - SMART: a careful operator. Keeps a cash reserve, builds the cabinet area
//   with the best homes-per-dollar (green cost per passing first, never red),
//   connects it to the plant, cables its streets with homes in few orders,
//   adds splitters and OLT cards as ports fill, markets about
//   SMART_MARKETING_PER_PASSING dollars per passing per month (none while
//   installs are paused for cash), default prices with default
//   grandfathering. Round 3: it borrows responsibly. A 7-year term loan funds
//   its next cabinet project (plus the connects it expects) when the project
//   is not red on its own, the lifetime cost per passing after it - what the
//   bank prices on - stays under opts.loanLifetimeCpp, its reserve is covered
//   and the quote's pro forma covenants keep a buffer (never a quote that
//   breaches; sized within debt.maxSafeTermLoan); the credit line covers
//   timing gaps (draw when cash dips under a small floor, repay when cash is
//   comfortably above the reserve, repay first when a covenant is at risk), so
//   its reserve leans on the undrawn line instead of idle cash, and a
//   covenant-safe draw (debt.fundingHint) buys a splitter or OLT card that
//   cash alone cannot. smartBot({ borrow: false }) is the round-2 SMART.
//   Round 4:
//   - it picks each new street's method by its lifetime cost over
//     opts.horizonYears (lifetimeCost: construction, make-ready and fees, pole
//     rent, weather.stormRisk repairs and the outage churn of the street's own
//     subscribers; a street whose way to the cabinet is all underground also
//     counts the margin it loses waiting for make-ready). In practice it buries
//     the short blocks, where a pole's rent and a repair crew's call-out weigh
//     most per foot, and strings the long blocks on poles. When a project's
//     lifetime plan would break its cost-per-passing test (what the bank prices
//     on), it keeps only the burials that save the most for their extra cost,
//     and at last strings the area aerial;
//   - it keeps a year of expected storm repairs above its cash floor (and two
//     in its building reserve), so a storm month never leaves a payment unpaid;
//   - it rebuilds underground an aerial span storms have hit opts.convertHits
//     times when network.quoteConvert pays back (pole rent, repairs and outage
//     churn avoided) within opts.convertPaybackYears (with today's values a
//     rebuild's fees and bore rarely do);
//   - while the incumbent runs a promo in any of its areas it offers new
//     signups SMART_INTRO_PROMO (opts.introPromo), or extra marketing on the
//     contested passings (opts.promoMarketingPerPassing);
//   - it never ignores a frozen line: past a warning it takes debt.cureOptions'
//     first repayment, else deleverages, and builds nothing until compliant.
//   Round 4b:
//   - it answers each incumbent promo with what incumbent.bestIncumbentAnswer
//     chooses when it starts (opts.incumbentAnswer 'best': the retention
//     offer, an intro promo while it runs, or nothing);
//   - its lifetime method choice weighs a street's expected outage cost
//     twice (opts.stormWeight: a storm year costs cash and covenant headroom
//     at once) over a 13-year horizon, so it buries the storm-exposed streets
//     and strings the sheltered ones;
//   - below the Seed round's purse (Bootstrapped, Shoestring) it plays lean
//     (LEAN_OPTIONS): cheap aerial plant, densest streets first, a short
//     runway, the intro promo while it pays, and a bridge loan when cash runs
//     under its floor with the line used up.
// - TWO_GIG_ONLY / NO_CHEAP_TIER (round 4b): SMART offering only 2 Gig, or 1 Gig
//   and 2 Gig, at their default prices from day 0 (lineupBot).
// - AGGRESSIVE (round 4b): SMART with every price x0.8 from day 0.
// - SMART-lite (round 4b): SMART without loans, rebuilds or promo answers.
// - ADVISOR_FOLLOWER (round 4b): sends the top suggestion's commands
//   (advisor.advicePlans) every look, nothing else.
// - LEVERED: borrows to the limit (every term loan termCapacity allows plus the
//   whole credit line, ignoring covenants and the quote's warning), overbuilds
//   (SMART's project picker, amber and red allowed, heavy marketing) and keeps
//   no reserve for its debt service once the bank lends. It breaches, is
//   frozen, misses a payment and defaults.
// - FROZEN_HOARDER (round 4): the careful operator without loans until the
//   bank lends, then every dollar offered whenever it is offered (LEVERED's
//   borrowing), after which it stops building and sits on the cash, never
//   repaying by choice. With { spendHoard: true } it builds with the hoard
//   instead, keeping only a year of scheduled debt service (the round-3
//   exploit of a frozen line). The frozen-line sweep and the call (debt.ts)
//   make it repay or default.
// - ALL_AERIAL / ALL_UNDERGROUND (round 4): SMART, but aerial wherever poled
//   (underground only where there are no poles) or underground everywhere,
//   never converting.
// - PRICE_HIKER (round 4): SMART, but every PRICE_HIKE_EVERY_MONTHS it raises
//   every offered tier by PRICE_HIKE_SHARE (grandfathered for the default
//   months, or passed on at the next bill with priceHikerBot(0)).
// - RURAL: SMART's borrowing rules on red rural cabinet areas only (round 3's
//   cash rules, no storm reserve), so its lifetime cost per passing is red
//   while it borrows: the bank's CPP spread.
// - CARELESS: overbuilds underground toward random far corners whenever cash
//   covers it (no reserve), cabinets at every 4th corner reached, marketing at
//   the maximum, never adds splitters, never borrows.
// - IDLE: does nothing.
// - MIXED: SMART plus random removals, price changes (grandfathered or not,
//   tiers retired and re-offered), intro promos, underground rebuilds, budget
//   changes, extra splitters and OLT cards, credit-line draws and repayments,
//   term loans and prepayments, round 4b's retention offers, snoozes and
//   briefing notes (and junk of each): every command type, for the
//   invariant sessions.
//
// Bots read the game only through public sim functions and change it only
// through `send` (applyCommand). Their randomness comes from their own Rng.
// The round-4b experiments at the end of this file (incumbent promo answers,
// the intro promo in a fresh area and in a mature town) start from a copy of
// a bot's game, with an incumbent promo injected when none runs (a test-only
// state edit, ensureIncumbentPromo).

import {
  AERIAL_FT_PER_DAY,
  AWARENESS_ON_LIT,
  BUILD_METHOD_HORIZON_YEARS,
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_TARGET,
  CUSTOMER_QUOTE_MONTHS,
  GRANDFATHER_MONTHS_MAX,
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_MIN_PASSINGS,
  INCUMBENT_PROMO_MONTHS,
  INCUMBENT_PROMO_QUIET_MONTHS,
  LOAN_ROUNDING,
  LOST_CUSTOMER_MONTHS,
  MAKE_READY_DAYS_MAX,
  MAKE_READY_DAYS_MIN,
  MAKE_READY_LONG_CHANCE,
  MAKE_READY_LONG_DAYS_MAX,
  MAKE_READY_LONG_DAYS_MIN,
  MARKETING_MAX_PER_MONTH,
  MAX_SPLITTERS_PER_CABINET,
  MDU_ROUTER_COST,
  METHOD_UPFRONT_WEIGHT,
  OLT_CARD_COST,
  OLT_MAX_CARDS,
  PERMIT_DAYS_MAX,
  PERMIT_DAYS_MIN,
  POLE_RENT_PER_POLE_PER_MONTH,
  PROMO_MAX_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  SMB_MULTIPLIER_DEFAULT,
  SPLITTER_COST,
  START_CASH,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
  UNDERGROUND_FT_PER_DAY,
} from '../balance';
import { coveragePreview, segmentsWithinReach } from '../coverage';
import {
  covenantMetrics,
  creditAvailable,
  creditOffer,
  cureOptions,
  estimateNextDebtService,
  fundingHint,
  maxSafeTermLoan,
  quoteTermLoan,
  termCapacity,
  totalDebt,
} from '../debt';
import { advicePlans, advise, buildTrough } from '../advisor';
import {
  awarenessGainPerDay,
  customerAreas,
  dealFactor,
  happinessReport,
  marketingAwarenessPerDay,
  quoteCampaign,
  quoteMarketing,
  quoteReferrals,
  quoteSupport,
  SUPPORT_LEVEL_IDS,
  switchRate,
  womSwitchFactor,
} from '../customers';
import { estimateMonthlyOverhead, fixedCostsPerMonth, overheadTotal, perCustomerCost } from '../overhead';
import { difficultyLevel } from '../company';
import { activePromos, areaTakeRates, bestIncumbentAnswer, incumbentPromoPrice } from '../incumbent';
import { cppBand, reportKpis } from '../metrics';
import {
  cableRoute,
  getService,
  orderFees,
  plannedService,
  ponPortsUsed,
  quoteCabinet,
  quoteCable,
  quoteConvert,
  quoteRemoveSpan,
  spanCharges,
} from '../network';
import { deriveSeed, Rng } from '../rng';
import {
  accountUnits,
  cabinetPortCapacity,
  closeDayAfter,
  cabinetPortsUsed,
  installCost,
  installsPaused,
  monthlyRecurringRevenue,
  quotePromo,
  subscriberUnits,
  targetTakeRate,
  tierMix,
} from '../sales';
import { otherEnd, parcelsServedBy, polesOnSegment, segmentsAtNode } from '../streets';
import type {
  CableMethod,
  City,
  Command,
  CovenantMetrics,
  GameState,
  IncumbentAnswer,
  IncumbentPromo,
  IntroPromo,
  NodeId,
  ParcelId,
  ParcelKind,
  PromoQuote,
  CampaignQuote,
  ReferralQuote,
  SupportQuote,
  SegmentId,
  SpanId,
  StormRisk,
  StreetSegment,
  SupportLevel,
  TermYears,
  TierId,
} from '../types';
import { DAYS_PER_BILL, outageChurnProbability, stormRisk } from '../weather';
import { areaCurves, averageArpu, cheapestMethod, constantPriceBot, cumulativeOperatingCashFlow, runBot, runValue, streetTree, treePath } from './harness';
import type { BotFactory, RunResult, Send } from './harness';
import { newGame } from '../game';

// ---------------------------------------------------------------------------
// SMART
// ---------------------------------------------------------------------------

/** Marketing budget a careful operator runs, dollars per passing per month (capped at MARKETING_MAX_PER_MONTH). */
export const SMART_MARKETING_PER_PASSING = 2;

/**
 * SMART's intro offer (a modest match of the cable company's discount for a
 * few months; the same as sales.SUGGESTED_PROMO): round 4's answer to an
 * incumbent promo (incumbentAnswer 'introPromo': new signups get it while
 * the cable company runs one in any of its areas), the lean operator's offer
 * while it pays, and the one the round-4b intro-promo experiments set. Extra
 * marketing on the contested passings (promoMarketingPerPassing) did no
 * better over 20 seeds.
 */
export const SMART_INTRO_PROMO: IntroPromo = { percentOff: 20, months: 3 };

/**
 * How a bot picks each new street's cable method:
 *   lifetime    - the cheaper over the bot's horizon (lifetimeCost; SMART);
 *   aerial      - aerial wherever the street has poles, else underground (ALL_AERIAL);
 *   underground - underground everywhere (ALL_UNDERGROUND).
 */
export type MethodPolicy = 'lifetime' | 'aerial' | 'underground';

/** How a bot answers the incumbent's promos (SmartOptions.incumbentAnswer). */
export type IncumbentAnswerPolicy = 'introPromo' | 'best' | 'retention' | 'none';

export interface SmartOptions {
  /** Marketing dollars per passing per month. */
  marketingPerPassing: number;
  /** Add a splitter once a cabinet's ports used reach this share of its capacity. */
  splitterAt: number;
  /** Reserve months of fixed costs (overhead + marketing). */
  reserveMonths: number;
  /**
   * Extra reserve months of the part of fixed costs that revenue does not
   * cover yet (running costs + marketing - MRR): the runway through the
   * ramp before the first homes pay for the office.
   */
  burnMonths: number;
  /** Days of expected installs kept in the reserve. */
  installDays: number;
  /** Most new cabinet areas started per weekly look. */
  maxProjectsPerLook: number;
  /** Skip cabinet areas that newly cover fewer units than this. */
  minNewUnits: number;
  /** Within an area, skip streets whose own cable costs more than this per unit on them. */
  maxStreetCpp: number;
  /** Longest single cable order the bot draws, ft (a typical drag). */
  orderMaxFt: number;
  /** Candidate areas tried (best first) before waiting for more cash. */
  candidatesTried: number;

  // Financing (round 3)
  /** Borrow: term loans for its projects (see loanLifetimeCpp), the credit line for timing gaps (false: the round-2 SMART). */
  borrow: boolean;
  /** A term loan's pro forma leverage stays at most this share of COVENANT_MAX_LEVERAGE ... */
  loanLeverageShare: number;
  /** ... and its pro forma debt-service coverage at least this multiple of COVENANT_MIN_COVERAGE. */
  loanCoverageMultiple: number;
  /**
   * The credit line's (smaller) buffer: a draw keeps leverage within this
   * share of the limit and coverage above this multiple of the minimum, and
   * outside it the line is repaid first (a covenant is at risk).
   */
  lineLeverageShare: number;
  lineCoverageMultiple: number;
  /** Term of the loans it takes. */
  termYears: TermYears;
  /**
   * It borrows for a project that is not red on its own (projectCpp, feeder
   * included) and keeps the projected lifetime cost per passing - the figure
   * the bank prices on - at most this (lifetime capex.osp plus the project's
   * plant, over passings plus its new units): green money for green plant.
   */
  loanLifetimeCpp: number;
  /**
   * A project built with its own cash keeps the projected lifetime cost per
   * passing at most this (round 4: underground plant raises it, and the bank
   * prices every loan on it), unless the bot builds red areas.
   */
  ownLifetimeCpp: number;
  /** Borrow for a project even while its own reserve is short (only the covenant buffers limit it): the rural-heavy bot. */
  borrowWhenShort: boolean;
  /** Smallest term loan it takes (it borrows in chunks); at least TERM_LOAN_MIN. */
  minLoan: number;
  /**
   * Round 4b: with cash under its floor and the line used up, take a term
   * loan (within the loan buffers) that restores the floor plus this many
   * months of the last close's operating deficit (0: never; bridge).
   */
  bridgeMonths: number;
  /** Loan amounts are rounded up to a multiple of this. */
  loanStep: number;
  /** Cash floor below which it draws on the line: months of fixed costs (overhead + marketing) ... */
  floorMonths: number;
  /** ... plus this many days of expected installs, plus the next close's debt service ... */
  floorInstallDays: number;
  /** ... plus this many years of expected repairs on its plant (expectedRepairsPerYear): a storm month never leaves the debt service unpaid. */
  floorStormYears: number;
  /** Share of the drawable line (within the line buffer) its reserve counts instead of idle cash. */
  lineLean: number;
  /** Build red cabinet areas too, and borrow for any band. */
  allowRed: boolean;
  /** Build only red cabinet areas (the rural-heavy bot; implies allowRed). */
  redOnly: boolean;

  // Round 4
  /** How each new street's cable method is picked (MethodPolicy). */
  methods: MethodPolicy;
  /** Years of running costs (pole rent, repairs, outage churn) the lifetime method choice weighs against the up-front difference. */
  horizonYears: number;
  /**
   * Round 4c/4d: what a dollar spent up front counts for in the lifetime
   * method choice against a dollar of running costs (the advisor's
   * METHOD_UPFRONT_WEIGHT: growth is bound by capital).
   */
  upfrontWeight: number;
  /** Weight of the make-ready wait in the lifetime method choice (1: the margin lost while waiting, in full). */
  waitWeight: number;
  /**
   * Round 4b: the lifetime method choice buries a street only when what it
   * saves over the horizon is at least this multiple of what burying costs
   * more up front (0: whenever it is cheaper over the horizon). Money is what
   * the careful operator is short of: a dollar not spent on a bore passes
   * more homes, which the bank lends against.
   */
  buryGain: number;
  /**
   * Round 4b: weight of a street's expected outage cost (storm repairs and
   * the outage churn of its subscribers) in the lifetime method choice (1:
   * as expected).
   */
  stormWeight: number;
  /** Years of expected repairs on its plant (expectedRepairsPerYear) kept in the reserve: a bad storm is not a missed payment. */
  stormReserveYears: number;
  /** Rebuild storm-hit aerial spans underground when it pays back (round 4). */
  convert: boolean;
  /** Storm hits (in the weather log) that make an aerial span worth a look. */
  convertHits: number;
  /** A rebuild is ordered when its cost over what it saves a year is at most this many years. */
  convertPaybackYears: number;
  /** Extra marketing dollars a month per passing where the incumbent runs a promo (0: no answer by marketing). */
  promoMarketingPerPassing: number;
  /** The intro promo it runs while any incumbent promo runs in its areas (null: none), when incumbentAnswer is 'introPromo'. */
  introPromo: IntroPromo | null;
  /**
   * Round 4b: how it answers an incumbent promo in one of its areas:
   *   introPromo - opts.introPromo for new signups while any incumbent promo runs (round 4);
   *   best       - what incumbent.bestIncumbentAnswer chooses when the promo starts
   *                (the retention offer, an intro promo while it runs, or nothing);
   *   retention  - always the retention offer (answerIncumbent);
   *   none       - ignore it.
   */
  incumbentAnswer: IncumbentAnswerPolicy;
  /** Round 4b: run this intro promo whenever sales.quotePromo says it pays (checked every 4 weeks; null: never). */
  promoWhenPays: IntroPromo | null;
  /** Round 4b: an intro promo it keeps set whenever no answer to the incumbent wants another (the intro-promo experiments; null: none). */
  standingPromo: IntroPromo | null;
  /** Round 4b: false leaves the intro promo and the incumbent's promos to someone else (a wrapper bot in an experiment). */
  managePromo: boolean;
  /** Round 4b: within a cabinet area, which streets a budget-limited project takes first: the nearest, or the most units per dollar. */
  streetOrder: 'distance' | 'density';
  /** Past a covenant warning, cure (debt.cureOptions) or deleverage, and build nothing until compliant. */
  cure: boolean;
  /**
   * Round 4c/4d: a project it pays for with its own cash must leave the cash
   * the advisor's runway arithmetic says its ramp needs (advisor.buildTrough:
   * the deepest the cash falls over the months after the build, the new
   * area's installs and running costs against its signups) above the cash
   * floor; a smaller project is tried when the first does not fit
   * (TROUGH_BUDGET_SHARES). The lean operator's rule: with a small purse the
   * months before the first homes pay are what ends a company.
   */
  troughCheck: boolean;
  /**
   * Round 4c/4d: when no lifetime plan of an area passes its cost-per-passing
   * test even keeping only the best burials (LIFETIME_FALLBACK_GAINS), string
   * it aerial wherever it can (true, round 4's rule) or leave the area for
   * later (false: an exposed street strung aerial costs more in repairs than
   * the area brings).
   */
  aerialFallback: boolean;
  /** Add splitters (and OLT cards) as ports fill (false: the plant's ports stay as they are, as the customers forecast assumes). */
  capacity: boolean;

  // Round 4c/4d: the growth levers (judged every LEVER_JUDGE_DAYS)
  /** Buy a neighborhood campaign in an area whenever customers.quoteCampaign says it pays there and its cost is spare cash. */
  campaigns: boolean;
  /** The support level it keeps, 'quote': the level customers.quoteSupport says is worth the most when it pays, or 'keep': whatever is set. */
  support: SupportLevel | 'quote' | 'keep';
  /** Referral credits on or off, 'quote': switched when customers.quoteReferrals says the switch pays, or 'keep': whatever is set. */
  referrals: boolean | 'quote' | 'keep';
  /** RunResult.bot. */
  name: string;
}

/**
 * The careful operator's settings. Its reserve is deliberately larger than
 * "3 months of fixed costs + 60 days of installs": with that rule it spends
 * nearly all its cash on day 0 and goes bankrupt in months 8-10 on every
 * tuning seed, because reaching break-even takes 12-18 months by design. So it
 * also keeps the runway to break-even (burnMonths of the uncovered burn, plus
 * the months until its plant is live) and a year of expected installs.
 */
export const SMART_DEFAULTS: SmartOptions = {
  marketingPerPassing: SMART_MARKETING_PER_PASSING,
  splitterAt: 0.8,
  reserveMonths: 3,
  burnMonths: 7,
  installDays: 365,
  maxProjectsPerLook: 6,
  minNewUnits: 25,
  maxStreetCpp: 2 * CPP_TARGET,
  orderMaxFt: 3_000,
  candidatesTried: 6,
  borrow: true,
  loanLeverageShare: 0.8,
  loanCoverageMultiple: 1.2,
  lineLeverageShare: 0.9,
  lineCoverageMultiple: 1.1,
  termYears: 7,
  loanLifetimeCpp: 0.97 * CPP_TARGET,
  ownLifetimeCpp: 0.98 * CPP_TARGET,
  borrowWhenShort: false,
  minLoan: 25_000,
  bridgeMonths: 0,
  loanStep: 5_000,
  floorMonths: 1,
  floorInstallDays: 60,
  floorStormYears: 1,
  lineLean: 1,
  allowRed: false,
  redOnly: false,
  methods: 'lifetime',
  horizonYears: BUILD_METHOD_HORIZON_YEARS,
  upfrontWeight: METHOD_UPFRONT_WEIGHT,
  waitWeight: 1,
  buryGain: 0,
  stormWeight: 1,
  stormReserveYears: 2,
  convert: true,
  convertHits: 2,
  convertPaybackYears: 10,
  promoMarketingPerPassing: 0,
  introPromo: SMART_INTRO_PROMO,
  incumbentAnswer: 'best',
  promoWhenPays: null,
  standingPromo: null,
  managePromo: true,
  streetOrder: 'distance',
  cure: true,
  troughCheck: false,
  aerialFallback: false,
  capacity: true,
  campaigns: false,
  support: 'keep',
  referrals: 'keep',
  name: 'smart',
};

interface Order {
  segments: SegmentId[];
  method: CableMethod;
}

interface Project {
  node: NodeId;
  /** Buy an OLT card first (no free PON port for the cabinet). */
  oltCard: boolean;
  orders: Order[];
  /** Plant cost from quotes: cabinet, OLT card, cable orders. */
  cost: number;
  /** Install spend its expected signups will take over the reserve's horizon (part of its budget). */
  connect: number;
  newUnits: number;
  /** The streets with homes it lights (its targets, not the feeder or paths between them). */
  lit: SegmentId[];
}

// ---------------------------------------------------------------------------
// Round 4: lifetime cost of a street's cable, by method
// ---------------------------------------------------------------------------

/** What one subscriber is worth to the method choice and the rebuild test, at today's prices. */
export interface SubscriberEconomics {
  /** What one household subscriber pays a month: the signup tier mix's price. */
  price: number;
  /** Its monthly margin: price less the running cost per customer (overhead.perCustomerCost, the support level's cost included). */
  margin: number;
  /** What losing one costs: LOST_CUSTOMER_MONTHS of its margin (weather.methodYearlyCost's rule, the advisor's per-street method choice). */
  lostValue: number;
}

export function subscriberEconomics(state: GameState): SubscriberEconomics {
  const { pricing } = state.sales;
  const mix = tierMix(pricing, 'home');
  let price = 0;
  for (const tier of pricing.tiers) price += mix[tier.id] * tier.price;
  const margin = Math.max(0, price - perCustomerCost(state));
  return { price, margin, lostValue: LOST_CUSTOMER_MONTHS * margin };
}

/** Expected days from order to light for a span of `method` on `segment`: permitting (make-ready's long tail included) plus construction. */
export function expectedLeadDays(segment: StreetSegment, method: CableMethod): number {
  if (method === 'aerial') {
    const usual = (MAKE_READY_DAYS_MIN + MAKE_READY_DAYS_MAX) / 2;
    const long = (MAKE_READY_LONG_DAYS_MIN + MAKE_READY_LONG_DAYS_MAX) / 2;
    return (1 - MAKE_READY_LONG_CHANCE) * usual + MAKE_READY_LONG_CHANCE * long + segment.lengthFt / AERIAL_FT_PER_DAY;
  }
  return (PERMIT_DAYS_MIN + PERMIT_DAYS_MAX) / 2 + segment.lengthFt / UNDERGROUND_FT_PER_DAY;
}

const riskCache = new WeakMap<City, Map<number, StormRisk>>();

/** weather.stormRisk per segment and method, computed once per city (it depends only on where the street is). */
function riskOf(state: GameState, segment: StreetSegment, method: CableMethod): StormRisk {
  let cache = riskCache.get(state.city);
  if (!cache) {
    cache = new Map();
    riskCache.set(state.city, cache);
  }
  const key = segment.id * 2 + (method === 'aerial' ? 0 : 1);
  let risk = cache.get(key);
  if (!risk) {
    risk = stormRisk(state, segment, method);
    cache.set(key, risk);
  }
  return risk;
}

/**
 * Expected yearly cost of the outages on a span of `method` carrying
 * `subscribers` (weather.methodYearlyCost's rule, with the bot's own
 * estimate of the street's subscribers): the expected storm and dig-in
 * repairs, and per outage (its mean days out, the canopy counted) the
 * cancellations it causes at SubscriberEconomics.lostValue each and the
 * days of service not billed.
 */
function outageCostPerYear(state: GameState, segment: StreetSegment, method: CableMethod, subscribers: number, econ: SubscriberEconomics): number {
  const risk = riskOf(state, segment, method);
  if (!(risk.outagesPerYear > 0) || !(subscribers > 0)) return risk.repairCostPerYear;
  const days = risk.outageDaysPerYear / risk.outagesPerYear;
  const perOutage = outageChurnProbability(days) * econ.lostValue + (days / DAYS_PER_BILL) * econ.price;
  return risk.repairCostPerYear + risk.outagesPerYear * subscribers * perOutage;
}

/**
 * What cabling `segment` with `method` costs over opts.horizonYears, the
 * advisor's per-street rule (weather.lifetimeMethodCost) with the bot's
 * settings: opts.upfrontWeight x its charges (construction, rock,
 * make-ready) and its share of an order's fees, plus opts.horizonYears x
 * its running costs (pole rent, and opts.stormWeight x the expected outage
 * cost: repairs, and the outage churn and unbilled days of its own street's
 * `own` subscribers), plus opts.waitWeight x the margin `waiting`
 * subscribers lose while it waits for permits and make-ready
 * (expectedLeadDays: the street lights that much later).
 */
export function lifetimeCost(
  state: GameState,
  segment: StreetSegment,
  method: CableMethod,
  own: number,
  waiting: number,
  opts: SmartOptions,
  econ: SubscriberEconomics,
): number {
  const upfront = spanCharges(segment, method).total + orderFees(method) * Math.min(1, segment.lengthFt / opts.orderMaxFt);
  const rent = method === 'aerial' ? polesOnSegment(segment) * POLE_RENT_PER_POLE_PER_MONTH * 12 : 0;
  const yearly = rent + opts.stormWeight * outageCostPerYear(state, segment, method, own, econ);
  const wait = waiting > 0 ? opts.waitWeight * (expectedLeadDays(segment, method) / 30) * waiting * econ.margin : 0;
  return opts.upfrontWeight * upfront + opts.horizonYears * yearly + wait;
}

/**
 * The method a bot cables `segment` with (MethodPolicy): for 'lifetime' the
 * cheaper lifetimeCost, with `own` subscribers on the street and `waiting`
 * of them lighting as soon as this segment does.
 */
export function chooseMethod(
  state: GameState,
  segment: StreetSegment,
  own: number,
  waiting: number,
  opts: SmartOptions,
  econ: SubscriberEconomics,
  minGain = 0,
): CableMethod {
  if (!segment.hasPoles || opts.methods === 'underground') return 'underground';
  if (opts.methods === 'aerial') return 'aerial';
  const aerial = lifetimeCost(state, segment, 'aerial', own, waiting, opts, econ);
  const underground = lifetimeCost(state, segment, 'underground', own, waiting, opts, econ);
  minGain = Math.max(minGain, opts.buryGain);
  if (minGain <= 0) return underground < aerial ? 'underground' : 'aerial';
  // Only when what it saves over the horizon is at least minGain x what it costs more up front (beyond its weight).
  const extra = spanCharges(segment, 'underground').total - spanCharges(segment, 'aerial').total;
  return aerial - underground >= minGain * Math.max(1, extra) ? 'underground' : 'aerial';
}

/** Up-front charges (before fees) of the method a policy would pick on cost alone: underground everywhere, else the cheaper buildable way. */
function policyBuildCost(segment: StreetSegment, policy: MethodPolicy): number {
  return policy === 'underground' ? spanCharges(segment, 'underground').total : cheapestMethod(segment).cost;
}

/**
 * Install spend expected on one street as signups close its gap to the target
 * take rate (the gap counted per street, as sales.stepSales does), times
 * `share` of that gap: new units spread over its parcels by their
 * unsubscribed units, at each kind's install cost, plus a building router for
 * an apartment building without one that expects at least half a signup.
 */
function streetConnectCost(
  state: GameState,
  segment: SegmentId,
  subscribed: ReadonlyMap<ParcelId, number>,
  routers: ReadonlySet<ParcelId>,
  share: number,
  rates: Readonly<Record<ParcelKind, number>>,
): number {
  const { city, day } = state;
  let target = 0;
  let subs = 0;
  let open = 0;
  const parcels: Array<{ id: ParcelId; kind: 'home' | 'mdu' | 'smb'; free: number }> = [];
  for (const pid of parcelsServedBy(city, segment)) {
    const parcel = city.parcels[pid];
    if (!parcel || parcel.appearsDay > day) continue;
    const sub = subscribed.get(pid) ?? 0;
    target += rates[parcel.kind] * parcel.units;
    subs += sub;
    open += parcel.units - sub;
    parcels.push({ id: pid, kind: parcel.kind, free: parcel.units - sub });
  }
  const gap = Math.max(0, target - subs) * share;
  if (gap <= 0 || open <= 0) return 0;
  let cost = 0;
  for (const p of parcels) {
    const units = (gap * p.free) / open;
    cost += units * installCost(p.kind, true);
    if (p.kind === 'mdu' && units >= 0.5 && !routers.has(p.id)) cost += MDU_ROUTER_COST;
  }
  return cost;
}

/** Subscribers a street is expected to carry at its target take rate (its parcels present today). */
function streetSubscribers(state: GameState, segment: SegmentId, rates: Readonly<Record<ParcelKind, number>>): number {
  let subs = 0;
  for (const pid of parcelsServedBy(state.city, segment)) {
    const parcel = state.city.parcels[pid];
    if (parcel && parcel.appearsDay <= state.day) subs += rates[parcel.kind] * parcel.units;
  }
  return subs;
}

/**
 * Share of a freshly lit street's take-rate gap that switches within `days`
 * at a marketing budget of `perPassing` dollars per passing per month (the
 * marketing gain does not depend on the town's size at a fixed spend per
 * passing), at most 1: the customers model day by day (awareness from
 * AWARENESS_ON_LIT growing by time, marketing and word of mouth,
 * customers.awarenessGainPerDay; switching at customers.switchRate at the
 * deal factor `deal` and word of mouth from `happyShare` of its customers
 * happy), without campaigns or the intro promo.
 */
export function installShare(days: number, perPassing: number, deal = 1, happyShare = 0): number {
  const gain = awarenessGainPerDay(marketingAwarenessPerDay(perPassing * 1_000, 1_000), 0, happyShare, false);
  const wom = womSwitchFactor(happyShare, false);
  let awareness = AWARENESS_ON_LIT;
  let left = 1;
  for (let d = 0; d < days; d++) {
    left *= 1 - switchRate(awareness, deal, wom, 1, 1);
    awareness += (1 - awareness) * Math.min(1, gain);
  }
  return Math.min(1, 1 - left);
}

/**
 * installShare at the game's deal (customers.dealFactor of its prices for
 * households) with word of mouth from its customers' happy share today
 * (none before the first customer), for a marketing budget of `perPassing`.
 */
export function stateInstallShare(state: GameState, days: number, perPassing: number): number {
  const deal = dealFactor(state.sales.pricing, 'home', INCUMBENT_PRICE, state.sales.promo);
  const units = subscriberUnits(state);
  const happy = units > 0 ? happinessReport(state).happy / units : 0;
  return installShare(days, perPassing, deal, happy);
}

/**
 * Days until everything already ordered is live: the longest remaining
 * permitting plus construction of any span or cabinet not live yet (0 when
 * all plant is live).
 */
export function daysUntilPlannedLive(state: GameState): number {
  let days = 0;
  for (const span of state.network.spans) {
    if (span.stage === 'live') continue;
    days = Math.max(days, span.stageDaysLeft + (span.stage === 'permitting' ? span.constructDays : 0));
  }
  for (const cabinet of state.network.cabinets) {
    if (cabinet.stage === 'live') continue;
    days = Math.max(days, cabinet.stageDaysLeft + (cabinet.stage === 'permitting' ? CABINET_CONSTRUCT_DAYS : 0));
  }
  return days;
}

/**
 * Cash a careful operator never spends on new plant: opts.reserveMonths of
 * fixed costs (overhead + marketing), the part of them (and of a month's
 * `debtService`, for a borrower) that revenue does not cover yet for
 * opts.burnMonths plus the months until the plant already ordered is live (a
 * long make-ready delays the first revenue), and the installs it expects
 * (expectedInstalls over opts.installDays).
 */
export function smartReserve(state: GameState, opts: SmartOptions = SMART_DEFAULTS, debtService = 0): number {
  const fixed = fixedCosts(state);
  const earning = monthlyRecurringRevenue(state);
  const uncovered = Math.max(0, fixed + debtService - earning);
  const burnMonths = opts.burnMonths + daysUntilPlannedLive(state) / 30;
  return (
    opts.reserveMonths * fixed +
    burnMonths * uncovered +
    expectedInstalls(state, opts.installDays, opts.marketingPerPassing) +
    opts.stormReserveYears * expectedRepairsPerYear(state)
  );
}

/** Expected storm and dig-in repairs a year on the plant as it stands (weather.stormRisk per span, by its method). */
export function expectedRepairsPerYear(state: GameState): number {
  let repairs = 0;
  for (const span of state.network.spans) {
    const segment = state.city.segments[span.segment];
    if (segment) repairs += riskOf(state, segment, span.method).repairCostPerYear;
  }
  return repairs;
}

/** Target take rate by building kind at today's prices (sales.targetTakeRate), for streetConnectCost. */
function takeRates(state: GameState): Record<ParcelKind, number> {
  const { pricing } = state.sales;
  return { home: targetTakeRate(pricing, 'home'), mdu: targetTakeRate(pricing, 'mdu'), smb: targetTakeRate(pricing, 'smb') };
}

/**
 * Last expectedInstalls results per state, keyed by everything they read: the
 * day (parcels appear by day), the plant (network.version), accounts and
 * building routers, prices, the horizon and the marketing assumption. A weekly
 * look asks several times on one day; this keeps the bots fast and never
 * changes an answer.
 */
const installsMemo = new WeakMap<GameState, Map<string, number>>();

/**
 * Install spend expected over the next `days` on every street that will be
 * lit once everything ordered is built: streetConnectCost with the share of
 * the gap the signup ramp fills in that time at today's marketing.
 */
export function expectedInstalls(state: GameState, days: number, marketingPerPassing = SMART_MARKETING_PER_PASSING): number {
  const { sales } = state;
  const key =
    `${state.day}:${state.network.version}:${sales.accounts.length}:${sales.routerParcels.length}:${days}:${marketingPerPassing}:` +
    JSON.stringify(sales.pricing);
  let memo = installsMemo.get(state);
  const hit = memo?.get(key);
  if (hit !== undefined) return hit;
  const planned = plannedService(state);
  const subscribed = new Map<ParcelId, number>();
  for (const account of sales.accounts) subscribed.set(account.parcel, accountUnits(account));
  const routers = new Set(sales.routerParcels);
  const share = stateInstallShare(state, days, marketingPerPassing);
  const rates = takeRates(state);
  let cost = 0;
  for (const segment of planned.servingCabinet.keys()) cost += streetConnectCost(state, segment, subscribed, routers, share, rates);
  const result = Math.round(cost);
  if (!memo || memo.size >= 8) {
    memo = new Map();
    installsMemo.set(state, memo);
  }
  memo.set(key, result);
  return result;
}

/** Group segments into connected same-method orders of at most maxFt each (one oversized segment is its own order). */
function groupOrders(city: City, segments: Iterable<SegmentId>, method: CableMethod, maxFt: number): Order[] {
  const left = new Set(segments);
  const orders: Order[] = [];
  while (left.size > 0) {
    let start = Infinity;
    for (const id of left) start = Math.min(start, id);
    const order: SegmentId[] = [];
    let ft = 0;
    const queue: SegmentId[] = [start];
    const seen = new Set<SegmentId>([start]);
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i] as SegmentId;
      const seg = city.segments[id] as StreetSegment;
      if (order.length > 0 && ft + seg.lengthFt > maxFt) continue;
      order.push(id);
      ft += seg.lengthFt;
      left.delete(id);
      for (const node of [seg.a, seg.b]) {
        for (const next of segmentsAtNode(city, node)) {
          if (!left.has(next) || seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    }
    orders.push({ segments: order, method });
  }
  return orders;
}

/**
 * Multi-source cheapest-build distances from the plant the player has
 * committed to (the CO and every corner touched by planned CO-connected
 * cable): already-cabled segments cost 0, others their cheapest build under
 * `policy` (policyBuildCost). Returns per node the cost and the source corner
 * it is cheapest from.
 */
function feederCosts(state: GameState, policy: MethodPolicy): { cost: Float64Array; source: Int32Array } {
  const { city, network } = state;
  const planned = plannedService(state);
  const cabled = new Set<SegmentId>(network.spans.map((s) => s.segment));
  const build = segmentBuildCosts(city, policy);
  const n = city.nodes.length;
  const cost = new Float64Array(n).fill(Infinity);
  const source = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const seed = (node: NodeId) => {
    cost[node] = 0;
    source[node] = node;
  };
  seed(city.coNode);
  for (const id of planned.connectedSegments) {
    const seg = city.segments[id] as StreetSegment;
    seed(seg.a);
    seed(seg.b);
  }
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      if (!done[i] && (cost[i] as number) < best) {
        best = cost[i] as number;
        u = i;
      }
    }
    if (u < 0) break;
    done[u] = 1;
    for (const segId of segmentsAtNode(city, u)) {
      const seg = city.segments[segId] as StreetSegment;
      const v = otherEnd(seg, u);
      if (done[v]) continue;
      const d = best + (cabled.has(segId) ? 0 : (build[segId] as number));
      if (d < (cost[v] as number)) {
        cost[v] = d;
        source[v] = source[u] as number;
      }
    }
  }
  return { cost, source };
}

/** Units on existing parcels served by each segment today. */
function unitsBySegment(state: GameState): Int32Array {
  const units = new Int32Array(state.city.segments.length);
  for (const parcel of state.city.parcels) {
    if (parcel.appearsDay <= state.day) units[parcel.segment] = (units[parcel.segment] as number) + parcel.units;
  }
  return units;
}

interface PlanContext {
  units: Int32Array;
  cabled: Set<SegmentId>;
  /** Segments lit once everything already ordered is built. */
  plannedLit: ReadonlyMap<SegmentId, number>;
  routers: ReadonlySet<ParcelId>;
  subscribed: ReadonlyMap<ParcelId, number>;
  /** Share of a street's take-rate gap counted as install spend (the reserve's horizon). */
  installShare: number;
  /** Target take rate by kind (takeRates). */
  rates: Readonly<Record<ParcelKind, number>>;
  /** Subscriber economics for the method choice (subscriberEconomics). */
  econ: SubscriberEconomics;
}

/**
 * The orders (and cabinet, and OLT card if no PON port is free) that light as
 * much of the cabinet area at `node` as `budget` allows, counting what
 * connecting its expected signups will cost (streetConnectCost) as part of the
 * project: the feeder from the committed plant (the cheaper over the bot's
 * horizon of the poled route and the plain shortest one), then streets with
 * homes in reach that nobody serves yet, nearest first, each with its street
 * path back to the cabinet. Each new segment's method is chosen once for the
 * whole area (chooseMethod; burials need a lifetime saving of at least
 * `minGain` x their extra up-front cost). Null when it would newly pass fewer
 * than opts.minNewUnits.
 */
function planProject(
  state: GameState,
  node: NodeId,
  source: NodeId,
  budget: number,
  ctx: PlanContext,
  opts: SmartOptions,
  minGain = 0,
): Project | null {
  const { city, network } = state;
  const preview = coveragePreview(state, node);
  const here = network.cabinets.some((c) => c.node === node);
  const oltCard = !here && ponPortsUsed(state) >= network.olt.ponPorts;
  if (oltCard && network.olt.cards >= OLT_MAX_CARDS) return null;
  const fixed = (here ? 0 : quoteCabinet(state, node).cost) + (oltCard ? OLT_CARD_COST : 0);

  let feeder: SegmentId[] = [];
  if (source !== node) {
    // The aerial route keeps to poled streets (a detour of up to
    // AERIAL_DETOUR_MAX_RATIO); a lifetime planner also prices the plain
    // shortest route, which may cross streets without poles, and takes the
    // cheaper over its horizon.
    const routes =
      opts.methods === 'underground'
        ? [cableRoute(state, source, node, 'underground')]
        : opts.methods === 'aerial'
          ? [cableRoute(state, source, node, 'aerial')]
          : [cableRoute(state, source, node, 'aerial'), cableRoute(state, source, node, 'underground')];
    let best = Infinity;
    for (const route of routes) {
      if (!route) continue;
      const fresh = route.filter((id) => !ctx.cabled.has(id));
      let cost = 0;
      for (const id of fresh) {
        const seg = city.segments[id] as StreetSegment;
        cost += lifetimeCost(state, seg, chooseMethod(state, seg, 0, 0, opts, ctx.econ, minGain), 0, 0, opts, ctx.econ);
      }
      if (cost < best) {
        best = cost;
        feeder = fresh;
      }
    }
    if (best === Infinity) return null;
  }

  const tree = streetTree(city, node, CABINET_REACH_FT);
  const targets = preview.segments
    .filter((entry) => {
      if (entry.servedBy !== null || ctx.plannedLit.has(entry.segment)) return false;
      const units = ctx.units[entry.segment] as number;
      if (units === 0) return false;
      const seg = city.segments[entry.segment] as StreetSegment;
      return ctx.cabled.has(entry.segment) || cheapestMethod(seg).cost <= opts.maxStreetCpp * units;
    })
    .sort((x, y) => x.distanceFt - y.distanceFt || x.segment - y.segment)
    .map((entry) => {
      // The street's new segments: itself and its street path back to the cabinet.
      const seg = city.segments[entry.segment] as StreetSegment;
      const path: SegmentId[] = [];
      if (!ctx.cabled.has(entry.segment)) path.push(entry.segment);
      const da = tree.dist.get(seg.a) ?? Infinity;
      const db = tree.dist.get(seg.b) ?? Infinity;
      for (const id of treePath(city, tree, da <= db ? seg.a : seg.b)) {
        if (!ctx.cabled.has(id) && !path.includes(id)) path.push(id);
      }
      return { segment: entry.segment, path, subs: streetSubscribers(state, entry.segment, ctx.rates) };
    });
  if (opts.streetOrder === 'density') {
    // Most units per dollar of the street and its path first (a small budget takes the best streets).
    const density = (t: { segment: SegmentId; path: SegmentId[] }) => {
      let cost = 0;
      for (const id of t.path) cost += cheapestMethod(city.segments[id] as StreetSegment).cost;
      return (ctx.units[t.segment] as number) / Math.max(1, cost);
    };
    const score = new Map(targets.map((t) => [t.segment, density(t)]));
    targets.sort((x, y) => (score.get(y.segment) as number) - (score.get(x.segment) as number) || x.segment - y.segment);
  }

  // Method per new segment, for the whole area, on running costs first (each
  // street's own subscribers). Then make-ready timing: a street whose way to
  // the cabinet (its path and the feeder) is all underground lights as soon as
  // its own cable is in, so its wait counts too (nearest streets first, so a
  // path's streets are settled before the streets beyond them).
  const own = new Map<SegmentId, number>();
  for (const t of targets) own.set(t.segment, t.subs);
  const methods = new Map<SegmentId, CableMethod>();
  const choose = (id: SegmentId, waiting: number) =>
    chooseMethod(state, city.segments[id] as StreetSegment, own.get(id) ?? 0, waiting, opts, ctx.econ, minGain);
  for (const id of feeder) methods.set(id, choose(id, 0));
  for (const t of targets) for (const id of t.path) if (!methods.has(id)) methods.set(id, choose(id, 0));
  if (opts.methods === 'lifetime' && opts.waitWeight > 0 && feeder.every((id) => methods.get(id) === 'underground')) {
    for (const t of targets) {
      if (!t.path.includes(t.segment) || methods.get(t.segment) === 'underground') continue;
      if (t.path.every((id) => id === t.segment || methods.get(id) === 'underground')) methods.set(t.segment, choose(t.segment, t.subs));
    }
  }
  const methodOf = (id: SegmentId): CableMethod => methods.get(id) ?? choose(id, 0);

  const costOf = (ids: Iterable<SegmentId>) => {
    let cost = 0;
    for (const id of ids) cost += spanCharges(city.segments[id] as StreetSegment, methodOf(id)).total;
    return cost;
  };
  const build = new Set<SegmentId>(feeder);
  let estimate = fixed + costOf(feeder);
  const accepted: Array<{ segment: SegmentId; segments: SegmentId[]; units: number; connect: number }> = [];
  let newUnits = 0;
  let connect = 0;
  for (const target of targets) {
    const adds = target.path.filter((id) => !build.has(id));
    const units = ctx.units[target.segment] as number;
    const addCost = costOf(adds);
    const addConnect = streetConnectCost(state, target.segment, ctx.subscribed, ctx.routers, ctx.installShare, ctx.rates);
    // Leave room for per-order fees (about one order per six streets) when estimating.
    const fees = (Math.ceil((build.size + adds.length) / 6) + 1) * orderFees('underground');
    if (estimate + addCost + fees + connect + addConnect > budget) continue;
    for (const id of adds) build.add(id);
    estimate += addCost;
    newUnits += units;
    connect += addConnect;
    accepted.push({ segment: target.segment, segments: adds, units, connect: addConnect });
  }

  // Exact cost from quotes; drop the farthest streets until it fits.
  for (;;) {
    if (newUnits < opts.minNewUnits) return null;
    const byMethod: Record<CableMethod, SegmentId[]> = { aerial: [], underground: [] };
    for (const id of build) byMethod[methodOf(id)].push(id);
    const orders = [
      ...groupOrders(city, byMethod.aerial, 'aerial', opts.orderMaxFt),
      ...groupOrders(city, byMethod.underground, 'underground', opts.orderMaxFt),
    ];
    let cost = fixed;
    for (const order of orders) cost += quoteCable(state, order.segments, order.method).cost;
    if (cost + connect <= budget) return { node, oltCard, orders, cost, connect, newUnits, lit: accepted.map((a) => a.segment) };
    const last = accepted.pop();
    if (!last) return null;
    for (const id of last.segments) build.delete(id);
    newUnits -= last.units;
    connect -= last.connect;
  }
}

const BAND_RANK = { green: 0, amber: 1, red: 2 } as const;

/**
 * When a project's lifetime plan fails the bot's cost-per-passing test,
 * chooseProject re-plans it keeping only the burials whose lifetime saving
 * is at least each of these multiples of their extra up-front cost, then all
 * aerial where poled.
 */
const LIFETIME_FALLBACK_GAINS: readonly number[] = [0.25, 0.5, 1, 2];

const streetReachCache = new WeakMap<City, SegmentId[][]>();

/**
 * Per corner, the segments a cabinet there would reach along streets (what
 * coveragePreview measures), computed once per city: the city never changes,
 * and scoring every corner through coveragePreview each weekly look was most
 * of a run's time.
 */
function streetReach(city: City): SegmentId[][] {
  let reach = streetReachCache.get(city);
  if (!reach) {
    reach = city.nodes.map((node) => segmentsWithinReach(city, node.id, CABINET_REACH_FT).map((r) => r.segment));
    streetReachCache.set(city, reach);
  }
  return reach;
}

const buildCostCache = new WeakMap<City, Partial<Record<MethodPolicy, Float64Array>>>();

/** policyBuildCost per segment (before fees), computed once per city and policy. */
function segmentBuildCosts(city: City, policy: MethodPolicy): Float64Array {
  let byPolicy = buildCostCache.get(city);
  if (!byPolicy) {
    byPolicy = {};
    buildCostCache.set(city, byPolicy);
  }
  let costs = byPolicy[policy];
  if (!costs) {
    costs = Float64Array.from(city.segments, (seg) => policyBuildCost(seg, policy));
    byPolicy[policy] = costs;
  }
  return costs;
}

/** Outside-plant cost per unit the project newly passes (its cabinet and cable; an OLT card is CO capex). */
function projectCpp(project: Project): number {
  return (project.cost - (project.oltCard ? OLT_CARD_COST : 0)) / project.newUnits;
}

/**
 * Best cabinet area to build or extend next within `budget`: every corner
 * scored by the units it would newly pass per dollar of cabinet, in-reach
 * build-out (coveragePreview's figures) and feeder from the committed plant;
 * areas whose projected cost per passing is green first, amber next, red only
 * with opts.allowRed (opts.redOnly: red areas only). `maxBand` (a BAND_RANK)
 * caps the area's band and the planned project's own cost per passing
 * (projectCpp, which counts its feeder) when `strict`; `accept` may veto a
 * planned project (SMART's lifetime test for what it borrows for).
 */
function chooseProject(
  state: GameState,
  budget: number,
  opts: SmartOptions,
  maxBand = defaultBand(opts),
  strict = false,
  accept: (project: Project) => boolean = () => true,
): Project | null {
  const { city, network } = state;
  const { cost: feeder, source } = feederCosts(state, opts.methods);
  const ctx: PlanContext = {
    units: unitsBySegment(state),
    cabled: new Set<SegmentId>(network.spans.map((s) => s.segment)),
    plannedLit: plannedService(state).servingCabinet,
    routers: new Set(state.sales.routerParcels),
    subscribed: new Map(state.sales.accounts.map((a) => [a.parcel, accountUnits(a)])),
    installShare: stateInstallShare(state, opts.installDays, opts.marketingPerPassing),
    rates: takeRates(state),
    econ: subscriberEconomics(state),
  };
  const reach = streetReach(city);
  const buildCost = segmentBuildCosts(city, opts.methods);
  const standing = new Set<NodeId>(network.cabinets.map((c) => c.node));
  const candidates: Array<{ node: NodeId; band: number; score: number }> = [];
  for (const { id: node } of city.nodes) {
    if ((source[node] as number) < 0) continue;
    // coveragePreview's figures from the cached street reach: the units on
    // segments nothing ordered will serve, and cabinetCost + buildOutCost.
    let newly = 0;
    let cost = standing.has(node) ? 0 : CABINET_COST + CABINET_START_SPLITTERS * SPLITTER_COST;
    for (const segment of reach[node] as SegmentId[]) {
      if (!ctx.plannedLit.has(segment)) newly += ctx.units[segment] as number;
      if (!ctx.cabled.has(segment)) cost += buildCost[segment] as number;
    }
    if (newly < opts.minNewUnits) continue;
    const band = BAND_RANK[cppBand(cost / newly)];
    if (band > maxBand || (opts.redOnly && band < BAND_RANK.red)) continue;
    const score = newly / (cost + (feeder[node] as number));
    candidates.push({ node, band, score });
  }
  candidates.sort((x, y) => x.band - y.band || y.score - x.score || x.node - y.node);
  const acceptable = (project: Project | null): project is Project => {
    if (!project) return false;
    const band = BAND_RANK[cppBand(projectCpp(project))];
    return !(strict && band > maxBand) && !(opts.redOnly && band < BAND_RANK.red) && accept(project);
  };
  for (const candidate of candidates.slice(0, opts.candidatesTried)) {
    const from = source[candidate.node] as number;
    const project = planProject(state, candidate.node, from, budget, ctx, opts);
    if (acceptable(project)) return project;
    // Underground plant raises the cost per passing the bank prices on: when
    // the lifetime plan would breach the bot's cost-per-passing test, keep
    // only the burials that save the most for what they cost more up front,
    // and at last string the area aerial wherever it can be.
    if (opts.methods === 'lifetime') {
      for (const minGain of LIFETIME_FALLBACK_GAINS) {
        const cheaper = planProject(state, candidate.node, from, budget, ctx, opts, minGain);
        if (acceptable(cheaper)) return cheaper;
      }
      if (opts.aerialFallback) {
        const aerial = planProject(state, candidate.node, from, budget, ctx, { ...opts, methods: 'aerial' });
        if (acceptable(aerial)) return aerial;
      }
    }
  }
  return null;
}

/** The worst band a bot builds with its own cash: amber, or red with opts.allowRed. */
function defaultBand(opts: SmartOptions): number {
  return opts.allowRed || opts.redOnly ? BAND_RANK.red : BAND_RANK.amber;
}

/** The worst band of a project a bot borrows for: amber (with the lifetime test), or red with opts.allowRed. */
function loanBand(opts: SmartOptions): number {
  return opts.allowRed || opts.redOnly ? BAND_RANK.red : BAND_RANK.amber;
}

/** Lifetime cost per passing once `project` is built: (capex.osp + its plant) / (passings + its new units). */
function projectedLifetimeCpp(state: GameState, project: Project): number {
  const plant = project.cost - (project.oltCard ? OLT_CARD_COST : 0);
  return (state.finance.capex.osp + plant) / (getService(state).passings + project.newUnits);
}

/**
 * Cash for a capacity purchase of `cost` (a splitter, an OLT card): what
 * cash holds above `cushion`, or else (a borrower, compliant) the
 * covenant-safe credit-line draw debt.fundingHint suggests, when it is all
 * it takes and keeps the line's buffer. True when cash now covers it.
 */
function fundCapacity(state: GameState, send: Send, opts: SmartOptions, cost: number, cushion: number): boolean {
  if (state.finance.cash >= cost + cushion) return true;
  if (!opts.borrow || state.debt.covenant.stage !== 'compliant') return false;
  const hint = fundingHint(state, cost);
  if (hint.kind !== 'draw' || hint.draw > lineRoom(state, opts)) return false;
  return send({ type: 'drawCredit', amount: hint.draw }).ok && state.finance.cash >= cost;
}

/** Splitters where ports run short (and OLT cards to feed them), while cash (or a safe draw) allows. */
function addCapacity(state: GameState, send: Send, opts: SmartOptions): void {
  const used = cabinetPortsUsed(state);
  const full = new Set(state.sales.fullCabinets);
  const cushion = overheadTotal(estimateMonthlyOverhead(state));
  for (const cabinet of [...state.network.cabinets]) {
    if (cabinet.splitters >= MAX_SPLITTERS_PER_CABINET) continue;
    const ports = used.get(cabinet.id) ?? 0;
    if (!full.has(cabinet.id) && ports < opts.splitterAt * cabinetPortCapacity(cabinet)) continue;
    const { olt } = state.network;
    if (ponPortsUsed(state) >= olt.ponPorts) {
      if (olt.cards >= OLT_MAX_CARDS || !fundCapacity(state, send, opts, OLT_CARD_COST + SPLITTER_COST, cushion)) return;
      if (!send({ type: 'addOltCard' }).ok) return;
    }
    if (!fundCapacity(state, send, opts, SPLITTER_COST, cushion)) return;
    send({ type: 'addSplitter', cabinet: cabinet.id });
  }
}

function buildProject(state: GameState, send: Send, project: Project): boolean {
  if (project.oltCard && !send({ type: 'addOltCard' }).ok) return false;
  const here = state.network.cabinets.some((c) => c.node === project.node);
  if (!here && !send({ type: 'placeCabinet', node: project.node }).ok) return false;
  for (const order of project.orders) {
    if (!send({ type: 'layCable', segments: order.segments, method: order.method }).ok) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// SMART's financing (round 3, cures round 4)
// ---------------------------------------------------------------------------

/**
 * The metrics keep `leverageShare` x COVENANT_MAX_LEVERAGE and
 * `coverageMultiple` x COVENANT_MIN_COVERAGE (no debt, or nothing scheduled,
 * passes that test).
 */
export function withinBuffer(m: CovenantMetrics, leverageShare: number, coverageMultiple: number): boolean {
  if (m.totalDebt > 0 && (m.leverage === null || m.leverage > leverageShare * COVENANT_MAX_LEVERAGE)) return false;
  if (m.annualDebtService > 0 && (m.coverage === null || m.coverage < coverageMultiple * COVENANT_MIN_COVERAGE)) return false;
  return true;
}

/** Largest multiple of `step` in [0, max] for which `ok` holds (`ok` true at 0 and monotone: once false, false above). */
function largestOk(max: number, step: number, ok: (amount: number) => boolean): number {
  let lo = 0;
  let hi = Math.floor(max / step);
  if (hi <= 0) return 0;
  if (ok(hi * step)) return hi * step;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (ok(mid * step)) lo = mid;
    else hi = mid;
  }
  return lo * step;
}

/** A month of running costs at today's size (overhead.fixedCostsPerMonth: base, per customer with support, per plant) + this month's marketing. */
function fixedCosts(state: GameState): number {
  return fixedCostsPerMonth(state);
}

/**
 * Most the credit line can draw now while the covenant metrics keep the
 * line's buffer (opts.lineLeverageShare, opts.lineCoverageMultiple), a year of
 * interest at the line's effective rate counted as debt service; 0 unless the
 * stage is 'compliant'.
 */
export function lineRoom(state: GameState, opts: SmartOptions): number {
  if (state.debt.covenant.stage !== 'compliant') return 0;
  const offer = creditOffer(state);
  if (offer.available <= 0) return 0;
  const bps = offer.rate.effectiveRateBps;
  return largestOk(offer.available, LOAN_ROUNDING, (amount) =>
    withinBuffer(
      covenantMetrics(state, { addDebt: amount, addAnnualDebtService: Math.round((amount * bps) / 10_000) }),
      opts.lineLeverageShare,
      opts.lineCoverageMultiple,
    ),
  );
}

/**
 * Largest term loan (opts.termYears, a multiple of LOAN_ROUNDING) within the
 * bank's largest covenant-safe loan (debt.maxSafeTermLoan) whose quote is ok
 * and keeps the loan buffer (opts.loanLeverageShare,
 * opts.loanCoverageMultiple) pro forma; 0 when that is below opts.minLoan or
 * the stage is not 'compliant'.
 */
export function safeTermLoan(state: GameState, opts: SmartOptions): number {
  const min = Math.max(TERM_LOAN_MIN, opts.minLoan);
  if (state.debt.covenant.stage !== 'compliant') return 0;
  const safe = maxSafeTermLoan(state, opts.termYears);
  if (safe < min) return 0;
  const amount = largestOk(safe, LOAN_ROUNDING, (a) => {
    if (a < TERM_LOAN_MIN) return true;
    const quote = quoteTermLoan(state, a, opts.termYears);
    return quote.ok && !quote.breachesCovenant && withinBuffer(quote.after, opts.loanLeverageShare, opts.loanCoverageMultiple);
  });
  return amount >= min ? amount : 0;
}

/**
 * The borrowing operator's cash floor: opts.floorMonths of fixed costs, the
 * next close's debt service (debt.estimateNextDebtService) and
 * opts.floorInstallDays of expected installs. Below it, it draws on the line.
 */
export function cashFloor(state: GameState, opts: SmartOptions): number {
  return (
    opts.floorMonths * fixedCosts(state) +
    estimateNextDebtService(state) +
    expectedInstalls(state, opts.floorInstallDays, opts.marketingPerPassing) +
    opts.floorStormYears * expectedRepairsPerYear(state)
  );
}

/**
 * Cash SMART does not spend on new plant. Without borrowing, the round-2
 * smartReserve. A borrower counts the next close's debt service as a monthly
 * cost revenue must cover (smartReserve's burn runway) and keeps it in hand,
 * less opts.lineLean of what the line could draw within its buffer
 * (lineRoom), never below cashFloor.
 */
export function borrowerReserve(state: GameState, opts: SmartOptions): number {
  if (!opts.borrow) return smartReserve(state, opts);
  const service = estimateNextDebtService(state);
  const lean = opts.lineLean > 0 ? opts.lineLean * lineRoom(state, opts) : 0;
  return Math.max(cashFloor(state, opts), smartReserve(state, opts, service) + service - lean);
}

/**
 * The credit line for timing gaps: with a covenant at risk (stage not
 * 'compliant', or the metrics outside the line's buffer) repay the line from
 * everything above one month of fixed costs and the next debt service; else
 * repay what is above the full reserve (smartReserve + next debt service), or
 * draw back up to the cash floor when cash is under it (within the buffer).
 */
function manageCredit(state: GameState, send: Send, opts: SmartOptions): void {
  const balance = state.debt.credit.balance;
  const cash = state.finance.cash;
  const nextService = estimateNextDebtService(state);
  const atRisk =
    state.debt.covenant.stage !== 'compliant' ||
    !withinBuffer(covenantMetrics(state), opts.lineLeverageShare, opts.lineCoverageMultiple);
  if (balance > 0) {
    const keep = atRisk ? fixedCosts(state) + nextService : smartReserve(state, opts, nextService) + nextService;
    const repay = Math.min(balance, Math.floor(cash - keep));
    if (repay >= 1) {
      send({ type: 'repayCredit', amount: repay });
      return;
    }
  }
  if (atRisk) return;
  const floor = cashFloor(state, opts);
  if (cash >= floor) return;
  const want = Math.ceil((floor - cash) / LOAN_ROUNDING) * LOAN_ROUNDING;
  const amount = Math.min(want, lineRoom(state, opts));
  if (amount >= 1) send({ type: 'drawCredit', amount });
  if (opts.bridgeMonths > 0 && state.finance.cash < floor) bridge(state, send, opts, floor);
}

/**
 * Round 4b: cash under the floor with the line used up: a term loan within
 * the loan buffers (safeTermLoan) that restores the floor and covers
 * opts.bridgeMonths of the last close's operating deficit, so a young network
 * still short of break-even never misses a payment for want of cash the bank
 * would lend.
 */
function bridge(state: GameState, send: Send, opts: SmartOptions, floor: number): void {
  const last = state.finance.reports.at(-1);
  const flow = last ? (reportKpis(last)?.operatingCashFlow ?? 0) : 0;
  const need = floor - state.finance.cash + opts.bridgeMonths * Math.max(0, -flow);
  const room = safeTermLoan(state, opts);
  const amount = Math.min(room, Math.max(opts.minLoan, TERM_LOAN_MIN, Math.ceil(need / opts.loanStep) * opts.loanStep));
  if (amount >= TERM_LOAN_MIN && amount >= Math.min(need, room)) send({ type: 'takeTermLoan', amount, termYears: opts.termYears });
}

/**
 * Round 4: never ignore a frozen line. Past a covenant warning (penalty,
 * frozen, or loans called) with debt owed: take the first verified cure
 * (debt.cureOptions: a repayment or prepayment that passes both tests and
 * keeps the next debt service in cash), else deleverage: repay the line, then
 * prepay the dearest loan, from everything above a month of fixed costs and
 * the next debt service. Returns true while it must not build (stage past a
 * warning, or the loans called).
 */
function cureOrDeleverage(state: GameState, send: Send, opts: SmartOptions): boolean {
  const { covenant, acceleration } = state.debt;
  const serious = covenant.stage === 'penalty' || covenant.stage === 'frozen' || acceleration !== null;
  if (!opts.cure || totalDebt(state) === 0 || covenant.stage === 'compliant') return false;
  const cure = cureOptions(state).find((option) => option.kind !== 'grow');
  if (cure) {
    const cmd: Command =
      cure.kind === 'repayCredit'
        ? { type: 'repayCredit', amount: cure.amount }
        : { type: 'prepayLoan', loan: cure.loan as number, amount: cure.amount };
    send(cmd);
    return serious;
  }
  if (!serious) return false;
  let spare = Math.floor(state.finance.cash - fixedCosts(state) - estimateNextDebtService(state));
  const line = Math.min(state.debt.credit.balance, spare);
  if (line >= 1 && send({ type: 'repayCredit', amount: line }).ok) spare -= line;
  const dearest = [...state.debt.loans].sort((a, b) => b.rateBps - a.rateBps || a.id - b.id)[0];
  // Leave room for the accrued interest a prepayment also takes.
  const prepay = dearest ? Math.min(dearest.balance, Math.floor(spare * 0.95)) : 0;
  if (dearest && prepay >= 1) send({ type: 'prepayLoan', loan: dearest.id, amount: prepay });
  return true;
}

/**
 * Take the term loan that funds `project` beyond `own` cash: its cost plus
 * expected connects less own, rounded up to opts.loanStep, at least
 * opts.minLoan, at most `room` (safeTermLoan). Checks the quote once more.
 */
function borrowFor(state: GameState, send: Send, opts: SmartOptions, project: Project, own: number, room: number): boolean {
  const need = project.cost + project.connect - Math.max(0, own);
  if (need <= 0) return true;
  const amount = Math.min(room, Math.max(opts.minLoan, TERM_LOAN_MIN, Math.ceil(need / opts.loanStep) * opts.loanStep));
  if (amount < need) return false;
  const quote = quoteTermLoan(state, amount, opts.termYears);
  if (!quote.ok || quote.breachesCovenant || !withinBuffer(quote.after, opts.loanLeverageShare, opts.loanCoverageMultiple)) return false;
  return send({ type: 'takeTermLoan', amount, termYears: opts.termYears }).ok;
}

// ---------------------------------------------------------------------------
// SMART's round-4 habits: marketing against incumbent promos, rebuilds
// ---------------------------------------------------------------------------

/** Passings in cabinet areas where the incumbent runs a promo today. */
export function contestedPassings(state: GameState): number {
  const coverage = getService(state).cabinetCoverage;
  let passings = 0;
  for (const promo of activePromos(state)) passings += coverage.get(promo.cabinet)?.passings ?? 0;
  return passings;
}

/**
 * The marketing budget: opts.marketingPerPassing per passing, plus
 * opts.promoMarketingPerPassing per passing where the incumbent runs a promo,
 * capped; none while installs are paused for cash (no point advertising
 * while cash cannot connect the customers it brings in).
 */
function marketingBudget(state: GameState, opts: SmartOptions): number {
  if (installsPaused(state)) return 0;
  const contested = opts.promoMarketingPerPassing > 0 ? contestedPassings(state) : 0;
  const wanted = opts.marketingPerPassing * getService(state).passings + opts.promoMarketingPerPassing * contested;
  return Math.min(MARKETING_MAX_PER_MONTH, Math.round(wanted));
}

/** What a bot remembers between looks about intro promos and its answers to the incumbent. */
export interface PromoMemo {
  /** The answer chosen for each incumbent promo it met, by `${cabinet}:${startDay}` (policy 'best'). */
  answers: Map<string, IncumbentAnswer['kind']>;
  /** The intro promo bestIncumbentAnswer chose for a promo it answers that way. */
  offers: Map<string, IntroPromo>;
  /** Day promoWhenPays was last judged, and its verdict. */
  judgedDay: number;
  pays: boolean;
}

export function newPromoMemo(): PromoMemo {
  return { answers: new Map(), offers: new Map(), judgedDay: -Infinity, pays: false };
}

const PROMO_JUDGE_DAYS = 28;

function samePromo(a: IntroPromo | null, b: IntroPromo | null): boolean {
  return a === null ? b === null : b !== null && a.percentOff === b.percentOff && a.months === b.months;
}

/**
 * Answer the incumbent's promos (opts.incumbentAnswer) and keep the intro
 * promo set to what the answers and opts.promoWhenPays want:
 * - 'introPromo': opts.introPromo while the incumbent runs a promo in any of its areas (round 4);
 * - 'best': when it first meets a promo, incumbent.bestIncumbentAnswer decides: the
 *   retention offer (answerIncumbent, once), an intro promo while that promo runs, or nothing;
 * - 'retention': the retention offer at every promo it meets;
 * - 'none': nothing.
 * Else opts.promoWhenPays while sales.quotePromo says it pays (judged every 4 weeks).
 */
function answerIncumbentPromos(state: GameState, send: Send, opts: SmartOptions, memo: PromoMemo): void {
  const running = activePromos(state);
  let want: IntroPromo | null = null;
  if (opts.incumbentAnswer === 'introPromo') {
    if (running.length > 0) want = opts.introPromo;
  } else if (opts.incumbentAnswer !== 'none') {
    for (const promo of running) {
      const key = `${promo.cabinet}:${promo.startDay}`;
      let kind = memo.answers.get(key);
      if (kind === undefined) {
        if (opts.incumbentAnswer === 'retention') kind = 'retention';
        else {
          const answer = bestIncumbentAnswer(state, promo.cabinet);
          kind = answer.kind;
          if (answer.promo) memo.offers.set(key, answer.promo);
        }
        memo.answers.set(key, kind);
        if (kind === 'retention' && !promo.answered) send({ type: 'answerIncumbent', cabinet: promo.cabinet });
      }
      if (kind === 'introPromo') want ??= memo.offers.get(key) ?? null;
    }
  }
  if (want === null && opts.promoWhenPays !== null) {
    if (state.day - memo.judgedDay >= PROMO_JUDGE_DAYS) {
      memo.judgedDay = state.day;
      memo.pays = quotePromo(state, opts.promoWhenPays).pays;
    }
    if (memo.pays) want = opts.promoWhenPays;
  }
  want ??= opts.standingPromo;
  if (!samePromo(want, state.sales.promo)) send({ type: 'setPromo', promo: want });
}

/** Storm hits per span in the weather log (Storm.spans, the last STORM_LOG_DAYS days). */
export function stormHits(state: GameState): Map<SpanId, number> {
  const hits = new Map<SpanId, number>();
  for (const storm of state.weather.storms) for (const span of storm.spans) hits.set(span, (hits.get(span) ?? 0) + 1);
  return hits;
}

/**
 * What rebuilding a live aerial span underground saves a year: the pole rent
 * and repairs network.quoteConvert names, plus the outage churn it avoids on
 * the subscribers the span carries (those quoteRemoveSpan says it would cut
 * off, or its passings at the target take rate when that is more).
 */
export function convertSavingsPerYear(state: GameState, span: SpanId, econ: SubscriberEconomics): number {
  const quote = quoteConvert(state, span);
  const target = state.network.spans.find((s) => s.id === span);
  const segment = target ? state.city.segments[target.segment] : undefined;
  if (!segment) return 0;
  const cut = quoteRemoveSpan(state, span);
  const carried = Math.max(cut.subscribersAffected, cut.passingsLost * targetTakeRate(state.sales.pricing, 'home'));
  const churn =
    outageCostPerYear(state, segment, 'aerial', carried, econ) -
    riskOf(state, segment, 'aerial').repairCostPerYear -
    (outageCostPerYear(state, segment, 'underground', carried, econ) - riskOf(state, segment, 'underground').repairCostPerYear);
  return 12 * quote.poleRentSaved + quote.repairsAvoidedPerYear + churn;
}

/**
 * Rebuild underground the aerial spans storms have hit opts.convertHits times
 * (in the weather log) whose rebuild (network.quoteConvert) pays back within
 * opts.convertPaybackYears (convertSavingsPerYear), most hits first, from
 * cash above its reserve. Looks once every 4 weeks.
 */
function convertHitSpans(state: GameState, send: Send, opts: SmartOptions): void {
  if (!opts.convert || opts.methods !== 'lifetime' || state.day % 28 >= 7) return;
  const hits = stormHits(state);
  const candidates = state.network.spans
    .filter((s) => s.stage === 'live' && s.method === 'aerial' && s.conversion === null && (hits.get(s.id) ?? 0) >= opts.convertHits)
    .sort((a, b) => (hits.get(b.id) ?? 0) - (hits.get(a.id) ?? 0) || a.id - b.id);
  if (candidates.length === 0) return;
  const econ = subscriberEconomics(state);
  for (const span of candidates) {
    const quote = quoteConvert(state, span.id);
    if (!quote.ok) continue;
    const savings = convertSavingsPerYear(state, span.id, econ);
    if (savings <= 0 || quote.cost > opts.convertPaybackYears * savings) continue;
    if (state.finance.cash - borrowerReserve(state, opts) < quote.cost) return;
    send({ type: 'convertSpan', span: span.id });
  }
}

/** Days between two looks at the growth levers (SmartOptions campaigns, support, referrals). */
export const LEVER_JUDGE_DAYS = 28;

/**
 * Round 4c/4d: the growth levers, every LEVER_JUDGE_DAYS: the support level
 * (opts.support: a fixed level, or 'quote': the level customers.quoteSupport
 * values most when that pays), referral credits (opts.referrals: fixed, or
 * 'quote': switched when customers.quoteReferrals says the switch pays) and
 * neighborhood campaigns (opts.campaigns: in each area where
 * customers.quoteCampaign accepts one and says it pays, best value for its
 * cost first, while the cost is cash above its reserve).
 */
function manageLevers(state: GameState, send: Send, opts: SmartOptions, memo: SmartMemo): void {
  if (opts.support !== 'quote' && opts.support !== 'keep' && opts.support !== state.customers.supportLevel) send({ type: 'setSupport', level: opts.support });
  if (typeof opts.referrals === 'boolean' && opts.referrals !== state.customers.referrals) send({ type: 'setReferrals', on: opts.referrals });
  if (state.day - memo.leversDay < LEVER_JUDGE_DAYS) return;
  memo.leversDay = state.day;
  if (opts.support === 'quote') {
    let best: { level: SupportLevel; value: number } | null = null;
    for (const level of SUPPORT_LEVEL_IDS) {
      if (level === state.customers.supportLevel) continue;
      const quote = quoteSupport(state, level);
      if (quote.ok && quote.pays && (!best || quote.netValue > best.value)) best = { level, value: quote.netValue };
    }
    if (best) send({ type: 'setSupport', level: best.level });
  }
  if (opts.referrals === 'quote') {
    const on = !state.customers.referrals;
    if (quoteReferrals(state, on).pays) send({ type: 'setReferrals', on });
  }
  if (opts.campaigns && !installsPaused(state)) {
    const quotes = customerAreas(state)
      .map((area) => quoteCampaign(state, area.cabinet))
      .filter((q) => q.ok && q.pays)
      .sort((a, b) => b.valueGained / Math.max(1, b.cost) - a.valueGained / Math.max(1, a.cost) || a.cabinet - b.cabinet);
    for (const quote of quotes) {
      if (state.finance.cash - borrowerReserve(state, opts) < quote.cost) break;
      send({ type: 'runCampaign', cabinet: quote.cabinet });
    }
  }
}

/** What SMART remembers between weekly looks. */
export interface SmartMemo {
  /** The scan key of the last look that found nothing worth building. */
  idleKey: string | null;
  promo: PromoMemo;
  /** Day the growth levers were last judged (manageLevers). */
  leversDay: number;
}

export function newSmartMemo(): SmartMemo {
  return { idleKey: null, promo: newPromoMemo(), leversDay: -Infinity };
}

/** Budget shares a trough-checked operator tries, largest first, until a project leaves its ramp's cash (SmartOptions.troughCheck). */
export const TROUGH_BUDGET_SHARES: readonly number[] = [1, 0.8, 0.65, 0.5, 0.4, 0.3, 0.2];

/**
 * The cash `project` needs to come through its ramp (advisor.buildTrough on
 * the project as a build plan: its cabinet, its cable by method, the units
 * and streets it lights).
 */
export function projectTrough(state: GameState, project: Project): number {
  const aerial: SegmentId[] = [];
  const underground: SegmentId[] = [];
  for (const order of project.orders) (order.method === 'aerial' ? aerial : underground).push(...order.segments);
  const here = state.network.cabinets.some((c) => c.node === project.node);
  const commands: Command[] = here ? [] : [{ type: 'placeCabinet', node: project.node }];
  return buildTrough(state, {
    node: project.node,
    feeder: [],
    reach: [],
    aerial,
    underground,
    commands,
    cost: project.cost,
    passings: project.newUnits,
    cpp: project.newUnits > 0 ? projectCpp(project) : null,
    lit: project.lit,
  });
}

/** One weekly look by the careful operator (shared by SMART, RURAL, MIXED and the round-4 variants). */
function smartAct(state: GameState, send: Send, opts: SmartOptions, memo: SmartMemo): void {
  const budget = marketingBudget(state, opts);
  if (budget !== state.sales.marketingPerMonth) send({ type: 'setMarketing', perMonth: budget });
  if (opts.managePromo) answerIncumbentPromos(state, send, opts, memo.promo);

  const hold = opts.borrow ? cureOrDeleverage(state, send, opts) : false;
  if (opts.borrow) manageCredit(state, send, opts);
  if (opts.capacity) addCapacity(state, send, opts);
  if (hold) return;
  manageLevers(state, send, opts, memo);
  convertHitSpans(state, send, opts);

  for (let i = 0; i < opts.maxProjectsPerLook; i++) {
    const own = state.finance.cash - borrowerReserve(state, opts);
    // SMART never borrows to build while its reserve (debt service included) is short.
    if (own <= 0 && !(opts.borrowWhenShort && opts.borrow)) break;
    const room = opts.borrow ? safeTermLoan(state, opts) : 0;
    if (own <= 0 && room <= 0) break;
    // Nothing worth building last time and nothing changed since: skip the scan.
    const key = `${state.network.version}:${Math.floor(state.day / 28)}:${Math.floor(own / 25_000)}:${Math.floor(room / 25_000)}`;
    if (memo.idleKey === key) break;
    // With loan room: the best project it would borrow for (not red on its own,
    // lifetime cost per passing kept under opts.loanLifetimeCpp); else what its
    // own cash builds (amber too).
    const lifetimeOk = (p: Project) => opts.allowRed || opts.redOnly || projectedLifetimeCpp(state, p) <= opts.loanLifetimeCpp;
    const ownOk = (p: Project) => opts.allowRed || opts.redOnly || projectedLifetimeCpp(state, p) <= opts.ownLifetimeCpp;
    let project = room > 0 ? chooseProject(state, Math.max(0, own) + room, opts, loanBand(opts), true, lifetimeOk) : null;
    if (!project && own > 0) {
      if (opts.troughCheck) {
        // The lean operator: the largest project whose ramp its cash comes through.
        const spare = state.finance.cash - cashFloor(state, opts);
        const fits = (p: Project) => ownOk(p) && p.cost + projectTrough(state, p) <= spare;
        for (const share of TROUGH_BUDGET_SHARES) {
          project = chooseProject(state, own * share, opts, defaultBand(opts), false, fits);
          if (project) break;
        }
      } else project = chooseProject(state, own, opts, defaultBand(opts), false, ownOk);
    }
    if (!project) {
      memo.idleKey = key;
      break;
    }
    if (project.cost + project.connect > own && !borrowFor(state, send, opts, project, own, room)) break;
    if (!buildProject(state, send, project)) break;
  }
  // Installs and the build just ordered may leave cash under the floor: the line covers the gap.
  if (opts.borrow) manageCredit(state, send, opts);
}

/**
 * Round 4b: SMART's settings when its starting purse is below the Seed
 * round's (Bootstrapped, Shoestring). The Seed-round SMART keeps a long
 * runway and buries the streets that pay back over 12 years; with half the
 * money that leaves one small area that never covers the $9,000 overhead. The
 * lean operator puts every dollar it can into cheap plant instead: aerial
 * unless a bore pays back four times over its horizon (buryGain, with storms
 * weighed as expected over 12 years: it cannot afford durability), the most
 * units per dollar first and no street dearer than the cost-per-passing
 * target, a two-month runway plus half a year of installs, $1 of marketing a
 * passing, the intro promo while sales.quotePromo says it pays, and a term
 * loan within its buffers whenever cash falls under its floor with the line
 * used up (bridgeMonths).
 */
export const LEAN_OPTIONS: Partial<SmartOptions> = {
  troughCheck: true,
  burnMonths: 2,
  installDays: 180,
  stormWeight: 1,
  horizonYears: 12,
  streetOrder: 'density',
  maxStreetCpp: CPP_TARGET,
  marketingPerPassing: 1,
  bridgeMonths: 3,
  promoWhenPays: SMART_INTRO_PROMO,
};

/** The starting cash of `state`'s difficulty (company.difficultyLevel). */
export function startCashOf(state: GameState): number {
  return difficultyLevel(state.company.difficulty).startCash;
}

/**
 * The careful operator. Its settings are SMART_DEFAULTS, under LEAN_OPTIONS
 * when the game's starting cash is below START_CASH (round 4b: the
 * difficulty levels differ only in it), under `options`.
 */
export function smartBot(options: Partial<SmartOptions> = {}): BotFactory {
  const seedRound: SmartOptions = { ...SMART_DEFAULTS, ...options };
  const lean: SmartOptions = { ...SMART_DEFAULTS, ...LEAN_OPTIONS, ...options };
  return () => {
    const memo = newSmartMemo();
    let opts: SmartOptions | null = null;
    return {
      name: seedRound.name,
      act: (state, send) => {
        opts ??= startCashOf(state) < START_CASH ? lean : seedRound;
        smartAct(state, send, opts, memo);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Round 4b: lineups, the aggressive operator, SMART-lite, the advisor follower
// ---------------------------------------------------------------------------

/**
 * `makeInner` (a bot that keeps whatever prices it finds, e.g. SMART) with
 * only the `offered` tiers offered, at their TIER_DEFAULTS prices, from its
 * first look on (SMB multiplier at its default).
 */
export function lineupBot(offered: readonly TierId[], makeInner: BotFactory): BotFactory {
  return (seed) => {
    const inner = makeInner(seed);
    let set = false;
    return {
      name: inner.name,
      act(state, send) {
        if (!set) {
          const tiers = TIER_DEFAULTS.map((t) => ({ id: t.id, price: t.price, offered: offered.includes(t.id) }));
          set = send({ type: 'setPricing', tiers, smbMultiplier: SMB_MULTIPLIER_DEFAULT }).ok;
        }
        inner.act(state, send);
      },
    };
  };
}

/** TWO_GIG_ONLY: SMART offering only 2 Gig, at its default price, from day 0. */
export function twoGigOnlyBot(options: Partial<SmartOptions> = {}): BotFactory {
  return lineupBot(['fiber2g'], smartBot({ name: 'two-gig-only', ...options }));
}

/** NO_CHEAP_TIER: SMART offering 1 Gig and 2 Gig (no 500 Mbps), at their default prices, from day 0. */
export function noCheapTierBot(options: Partial<SmartOptions> = {}): BotFactory {
  return lineupBot(['fiber1g', 'fiber2g'], smartBot({ name: 'no-cheap-tier', ...options }));
}

/** AGGRESSIVE's prices: every tier this multiple of its TIER_DEFAULTS price, kept from day 0. */
export const AGGRESSIVE_PRICE_MULTIPLIER = 0.8;

/** AGGRESSIVE: SMART pushing its take rate with every price at AGGRESSIVE_PRICE_MULTIPLIER of the defaults (harness.constantPriceBot). */
export function aggressiveBot(options: Partial<SmartOptions> = {}): BotFactory {
  return constantPriceBot(smartBot({ name: 'aggressive', ...options }), AGGRESSIVE_PRICE_MULTIPLIER);
}

/**
 * SMART-lite (round 4b, the advisor follower's yardstick): the careful
 * operator without loans, rebuilds or any answer to the incumbent's promos
 * (no intro promo, no retention offer): what a cautious player who only
 * builds with the starting cash gets.
 */
export const SMART_LITE_OPTIONS: Partial<SmartOptions> = { borrow: false, convert: false, incumbentAnswer: 'none', name: 'smart-lite' };

export function smartLiteBot(options: Partial<SmartOptions> = {}): BotFactory {
  return smartBot({ ...SMART_LITE_OPTIONS, ...options });
}

/**
 * ADVISOR_FOLLOWER (round 4b): every BOT_INTERVAL_DAYS, if the top
 * suggestion (advisor.advicePlans(state)[0]) has commands, it sends them in
 * order and stops at the first rejection; otherwise it does nothing. It keeps
 * the default marketing budget and never snoozes. The expand plan carries
 * coverage.buildOutPlan's commands, so following it builds what was costed.
 */
export const advisorFollowerBot: BotFactory = () => ({
  name: 'advisor-follower',
  act(state, send) {
    const top = advicePlans(state)[0];
    if (!top) return;
    for (const cmd of top.commands) if (!send(cmd).ok) break;
  },
});

// ---------------------------------------------------------------------------
// ALL_AERIAL / ALL_UNDERGROUND (round 4)
// ---------------------------------------------------------------------------

/** SMART, but aerial wherever the street has poles and never a rebuild: the storm-exposed operator. */
export const ALL_AERIAL_OPTIONS: Partial<SmartOptions> = { methods: 'aerial', convert: false, name: 'all-aerial' };
/** SMART, but underground everywhere: the operator who pays up front for durable plant. */
export const ALL_UNDERGROUND_OPTIONS: Partial<SmartOptions> = { methods: 'underground', convert: false, name: 'all-underground' };

export function allAerialBot(options: Partial<SmartOptions> = {}): BotFactory {
  return smartBot({ ...ALL_AERIAL_OPTIONS, ...options });
}

export function allUndergroundBot(options: Partial<SmartOptions> = {}): BotFactory {
  return smartBot({ ...ALL_UNDERGROUND_OPTIONS, ...options });
}

// ---------------------------------------------------------------------------
// PRICE_HIKER (round 4)
// ---------------------------------------------------------------------------

/** Share every offered tier's price rises by at each hike. */
export const PRICE_HIKE_SHARE = 0.15;
/** Month closes between hikes (the first after this many closes). */
export const PRICE_HIKE_EVERY_MONTHS = 6;

/**
 * SMART, but every PRICE_HIKE_EVERY_MONTHS closes it raises every offered
 * tier by PRICE_HIKE_SHARE (rounded, at most TIER_PRICE_MAX), grandfathered
 * for `grandfatherMonths` (undefined: the game's default; 0: at the next bill).
 */
export function priceHikerBot(grandfatherMonths?: number, options: Partial<SmartOptions> = {}): BotFactory {
  const name = grandfatherMonths === undefined ? 'price-hiker' : `price-hiker-${grandfatherMonths}`;
  const smart = smartBot({ name, ...options });
  return (seed) => {
    const inner = smart(seed);
    let lastHike = 0;
    return {
      name,
      act(state, send) {
        const closes = state.finance.reports.length;
        if (closes >= lastHike + PRICE_HIKE_EVERY_MONTHS) {
          lastHike = closes;
          const { pricing } = state.sales;
          send({
            type: 'setPricing',
            tiers: pricing.tiers.map((t) => ({
              id: t.id,
              price: t.offered ? Math.min(TIER_PRICE_MAX, Math.round(t.price * (1 + PRICE_HIKE_SHARE))) : t.price,
              offered: t.offered,
            })),
            smbMultiplier: pricing.smbMultiplier,
            ...(grandfatherMonths === undefined ? {} : { grandfatherMonths }),
          });
        }
        inner.act(state, send);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// RURAL (red cost per passing, borrowing by SMART's rules)
// ---------------------------------------------------------------------------

/**
 * The rural-heavy operator: SMART's covenant buffers, but it builds only red
 * (rural) cabinet areas, judged on each project's own cost per passing, and
 * borrows for them whenever the buffers allow (even with its reserve short),
 * so its lifetime cost per passing is red while it borrows. Rural lanes are
 * long and sparse, so it accepts small areas and expensive streets. A red-only
 * network never covers the overhead, so it bleeds: its rate is the point.
 */
export const RURAL_OPTIONS: Partial<SmartOptions> = {
  redOnly: true,
  borrowWhenShort: true,
  minNewUnits: 10,
  maxStreetCpp: Infinity,
  // Round 3's cash rules (no storm reserve): the bot is about the bank's CPP
  // spread, so it keeps borrowing for red lanes rather than holding cash.
  stormReserveYears: 0,
  floorStormYears: 0,
  name: 'rural',
};

export function ruralBot(options: Partial<SmartOptions> = {}): BotFactory {
  return smartBot({ ...RURAL_OPTIONS, ...options });
}

// ---------------------------------------------------------------------------
// LEVERED (borrows to the limit)
// ---------------------------------------------------------------------------

/** The levered operator's marketing, dollars per passing per month (heavy: SMART runs SMART_MARKETING_PER_PASSING). */
export const LEVERED_MARKETING_PER_PASSING = 6;

/**
 * The levered operator: SMART's project picker with amber and red areas,
 * heavy marketing, and every dollar the bank offers. Until the bank lends at
 * all (no revenue yet) it keeps SMART's runway, or it would simply run out of
 * cash before borrowing (CARELESS's story); from then on its reserve is
 * opts.reserveMonths of fixed costs and opts.installDays of installs, with
 * nothing kept for debt service.
 */
export const LEVERED_OPTIONS: Partial<SmartOptions> = {
  marketingPerPassing: LEVERED_MARKETING_PER_PASSING,
  borrow: false,
  allowRed: true,
  reserveMonths: 1,
  installDays: 60,
  promoMarketingPerPassing: 0,
  name: 'levered',
};

/** Take every term loan the bank allows (the longest term) and the whole credit line, covenants and warnings ignored. True if it borrowed. */
function borrowEverything(state: GameState, send: Send): boolean {
  let borrowed = false;
  const capacity = termCapacity(state);
  if (capacity >= TERM_LOAN_MIN) borrowed = send({ type: 'takeTermLoan', amount: capacity, termYears: TERM_LOAN_YEARS.at(-1) as TermYears }).ok;
  const available = creditAvailable(state);
  if (available > 0) borrowed = send({ type: 'drawCredit', amount: available }).ok || borrowed;
  return borrowed;
}

export function leveredBot(options: Partial<SmartOptions> = {}): BotFactory {
  const opts: SmartOptions = { ...SMART_DEFAULTS, ...LEVERED_OPTIONS, ...options };
  return () => {
    const memo = newSmartMemo();
    let lending = false;
    return {
      name: opts.name,
      act(state, send) {
        // Heavy marketing, even while installs are paused (it never holds back).
        const budget = Math.min(MARKETING_MAX_PER_MONTH, Math.round(opts.marketingPerPassing * getService(state).passings));
        if (budget !== state.sales.marketingPerMonth) send({ type: 'setMarketing', perMonth: budget });

        const capacity = termCapacity(state);
        const available = creditAvailable(state);
        borrowEverything(state, send);
        lending ||= capacity > 0 || available > 0;

        addCapacity(state, send, opts);
        for (let i = 0; i < opts.maxProjectsPerLook; i++) {
          const reserve = lending
            ? opts.reserveMonths * fixedCosts(state) + expectedInstalls(state, opts.installDays, opts.marketingPerPassing)
            : smartReserve(state, SMART_DEFAULTS);
          const own = state.finance.cash - reserve;
          if (own <= 0) return;
          const key = `${state.network.version}:${Math.floor(state.day / 28)}:${Math.floor(own / 25_000)}`;
          if (memo.idleKey === key) return;
          const project = chooseProject(state, own, opts);
          if (!project) {
            memo.idleKey = key;
            return;
          }
          if (!buildProject(state, send, project)) return;
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// FROZEN_HOARDER (round 4)
// ---------------------------------------------------------------------------

export interface HoarderOptions {
  /**
   * Build with the hoard (SMART's project picker) while keeping only
   * HOARDER_SERVICE_MONTHS of scheduled debt service in cash: the round-3
   * exploit of a frozen line. False: build nothing once it has borrowed.
   */
  spendHoard: boolean;
}

/** Months of scheduled debt service the spending hoarder keeps (a year: enough to pay every close of a frozen line). */
export const HOARDER_SERVICE_MONTHS = 12;

/**
 * The careful operator without loans until the bank lends at all; from then
 * on every dollar the bank offers whenever it offers any (LEVERED's
 * borrowing), never repaying by choice. It stops building and sits on the
 * cash (marketing and splitters only), or with { spendHoard: true } builds
 * with it. Under the round-4 rules the frozen line's sweep and the call make
 * it repay everything or default.
 */
export function frozenHoarderBot(options: Partial<HoarderOptions> & Partial<SmartOptions> = {}): BotFactory {
  const spendHoard = options.spendHoard ?? false;
  const opts: SmartOptions = {
    ...SMART_DEFAULTS,
    borrow: false,
    convert: false,
    name: spendHoard ? 'hoarder-spender' : 'frozen-hoarder',
    ...options,
  };
  return () => {
    const memo = newSmartMemo();
    let borrowed = false;
    return {
      name: opts.name,
      act(state, send) {
        borrowed = borrowEverything(state, send) || borrowed;
        if (!borrowed) {
          smartAct(state, send, opts, memo);
          return;
        }
        const budget = marketingBudget(state, opts);
        if (budget !== state.sales.marketingPerMonth) send({ type: 'setMarketing', perMonth: budget });
        addCapacity(state, send, opts);
        if (!spendHoard) return;
        for (let i = 0; i < opts.maxProjectsPerLook; i++) {
          const reserve = HOARDER_SERVICE_MONTHS * estimateNextDebtService(state) + opts.reserveMonths * fixedCosts(state);
          const own = state.finance.cash - reserve;
          if (own <= 0) return;
          const key = `${state.network.version}:${Math.floor(state.day / 28)}:${Math.floor(own / 25_000)}`;
          if (memo.idleKey === key) return;
          const project = chooseProject(state, own, opts);
          if (!project) {
            memo.idleKey = key;
            return;
          }
          if (!buildProject(state, send, project)) return;
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// CARELESS
// ---------------------------------------------------------------------------

/** Most orders the careless player tries in one weekly look. */
const CARELESS_ORDERS_PER_LOOK = 12;
/** A cabinet at every this-many-th corner the careless plant reaches. */
const CARELESS_CABINET_EVERY = 4;

export const carelessBot: BotFactory = (seed) => {
  const rng = new Rng(deriveSeed(seed, 'bot:careless'));
  let cornersReached = 0;
  const reached = new Set<NodeId>();
  let farCorners: NodeId[] | null = null;
  return {
    name: 'careless',
    act(state, send) {
      const { city } = state;
      if (state.sales.marketingPerMonth !== MARKETING_MAX_PER_MONTH) {
        send({ type: 'setMarketing', perMonth: MARKETING_MAX_PER_MONTH });
      }
      if (!farCorners) {
        // The farther half of the town's corners from the CO, by street distance.
        const tree = streetTree(city, city.coNode, Infinity);
        const byDist = city.nodes.map((n) => n.id).sort((a, b) => (tree.dist.get(a) ?? 0) - (tree.dist.get(b) ?? 0) || a - b);
        farCorners = byDist.slice(byDist.length >> 1);
        reached.add(city.coNode);
      }
      for (let i = 0; i < CARELESS_ORDERS_PER_LOOK; i++) {
        const target = rng.pick(farCorners);
        const route = cableRoute(state, city.coNode, target, 'underground');
        if (!route || route.length === 0) continue;
        const quote = quoteCable(state, route, 'underground');
        if (quote.newSegments.length === 0) continue;
        if (quote.cost > state.finance.cash) return; // no reserve: stop only when broke
        if (!send({ type: 'layCable', segments: route, method: 'underground' }).ok) return;
        // Walk the route from the CO and drop a cabinet at every 4th new corner.
        let at = city.coNode;
        for (const id of route) {
          at = otherEnd(city.segments[id] as StreetSegment, at);
          if (reached.has(at)) continue;
          reached.add(at);
          cornersReached++;
          if (cornersReached % CARELESS_CABINET_EVERY === 0) send({ type: 'placeCabinet', node: at });
        }
      }
    },
  };
};

// ---------------------------------------------------------------------------
// IDLE
// ---------------------------------------------------------------------------

export const idleBot: BotFactory = () => ({ name: 'idle', act() {} });

// ---------------------------------------------------------------------------
// MIXED (every command type)
// ---------------------------------------------------------------------------

/**
 * One random financing command (sometimes junk the sim must reject): draw on
 * or repay the credit line, take a term loan, prepay one.
 */
function randomDebtCommand(state: GameState, send: Send, rng: Rng): void {
  const { credit, loans } = state.debt;
  const roll = rng.next();
  if (roll < 0.3) {
    const available = creditAvailable(state);
    const amount = available > 0 && rng.chance(0.85) ? rng.int(1, available) : available + rng.int(1, 50_000);
    send({ type: 'drawCredit', amount });
  } else if (roll < 0.55) {
    const amount = credit.balance > 0 && rng.chance(0.85) ? rng.int(1, credit.balance) : credit.balance + rng.int(1, 50_000);
    send({ type: 'repayCredit', amount });
  } else if (roll < 0.75) {
    const capacity = termCapacity(state);
    const amount = capacity >= TERM_LOAN_MIN && rng.chance(0.85) ? rng.int(TERM_LOAN_MIN, capacity) : capacity + rng.int(1, 50_000);
    send({ type: 'takeTermLoan', amount, termYears: rng.pick(TERM_LOAN_YEARS) });
  } else if (roll < 0.92) {
    if (loans.length === 0) {
      send({ type: 'prepayLoan', loan: rng.int(1, 5), amount: rng.int(1, 10_000) });
    } else {
      const loan = rng.pick(loans);
      const amount = rng.chance(0.3) ? loan.balance : rng.int(1, loan.balance);
      send({ type: 'prepayLoan', loan: loan.id, amount });
    }
  } else {
    // Junk: fractions, negatives, an unknown term.
    const junk = rng.int(0, 3);
    if (junk === 0) send({ type: 'drawCredit', amount: -rng.int(1, 1_000) });
    else if (junk === 1) send({ type: 'repayCredit', amount: 0.5 });
    else if (junk === 2) send({ type: 'takeTermLoan', amount: 50_000, termYears: 6 as TermYears });
    else send({ type: 'prepayLoan', loan: -1, amount: 1.5 });
  }
}

/**
 * A random price change (round 4 too): prices up or down (sometimes out of
 * range: rejected), some tiers retired (1 Gig always stays offered), the SMB
 * multiplier, and a grandfathering period: the default (omitted), 0 (a rise
 * passed on at the next bill), 1 to GRANDFATHER_MONTHS_MAX months, or junk.
 */
function randomPricing(send: Send, rng: Rng): void {
  const tiers = TIER_DEFAULTS.map((t) => ({
    id: t.id,
    price: rng.chance(0.9) ? rng.int(TIER_PRICE_MIN, Math.min(TIER_PRICE_MAX, t.price * 2)) : TIER_PRICE_MAX + 1,
    offered: t.id === 'fiber1g' || rng.chance(0.7),
  }));
  const roll = rng.next();
  const grandfather =
    roll < 0.35
      ? {}
      : roll < 0.55
        ? { grandfatherMonths: 0 }
        : roll < 0.9
          ? { grandfatherMonths: rng.int(1, GRANDFATHER_MONTHS_MAX) }
          : { grandfatherMonths: rng.chance(0.5) ? -1 : 2.5 };
  send({ type: 'setPricing', tiers, smbMultiplier: 1 + rng.int(0, 20) / 10, ...grandfather });
}

/** A random intro promo: none, a valid one, or junk the sim must reject. */
function randomPromo(send: Send, rng: Rng): void {
  const roll = rng.next();
  if (roll < 0.35) send({ type: 'setPromo', promo: null });
  else if (roll < 0.9) send({ type: 'setPromo', promo: { percentOff: rng.int(1, PROMO_MAX_PERCENT_OFF), months: rng.int(1, PROMO_MAX_MONTHS) } });
  else send({ type: 'setPromo', promo: { percentOff: PROMO_MAX_PERCENT_OFF + rng.int(1, 50), months: 0 } });
}

/** Rebuild a random live aerial span underground (sometimes a span that cannot be: rejected). */
function randomConvert(state: GameState, send: Send, rng: Rng): void {
  const aerial = state.network.spans.filter((s) => s.stage === 'live' && s.method === 'aerial' && s.conversion === null);
  if (aerial.length > 0 && rng.chance(0.85)) send({ type: 'convertSpan', span: rng.pick(aerial).id });
  else if (state.network.spans.length > 0) send({ type: 'convertSpan', span: rng.pick(state.network.spans).id });
  else send({ type: 'convertSpan', span: -1 });
}

/**
 * Round 4b: answer a running incumbent promo with the retention offer (a
 * random one, answered or not: an answered one is rejected), or junk (no
 * promo there, a cabinet that does not exist).
 */
function randomAnswer(state: GameState, send: Send, rng: Rng): void {
  const running = activePromos(state);
  if (running.length > 0 && rng.chance(0.85)) send({ type: 'answerIncumbent', cabinet: rng.pick(running).cabinet });
  else if (state.network.cabinets.length > 0 && rng.chance(0.5)) send({ type: 'answerIncumbent', cabinet: rng.pick(state.network.cabinets).id });
  else send({ type: 'answerIncumbent', cabinet: -1 });
}

/**
 * Round 4b: what a player does with the briefing: snooze one of today's
 * suggestions (advise), note the ones a briefing showed (noteAdviceShown, as
 * the UI does at a close), or junk keys the sim must reject.
 */
function randomAdviceCommand(state: GameState, send: Send, rng: Rng): void {
  const keys = advise(state).map((a) => a.key);
  const roll = rng.next();
  if (roll < 0.45) {
    if (keys.length > 0) send({ type: 'snoozeAdvice', key: rng.pick(keys) });
    else send({ type: 'snoozeAdvice', key: 'expand:node:-1' });
  } else if (roll < 0.9) {
    send({ type: 'noteAdviceShown', keys: keys.filter(() => rng.chance(0.8)) });
  } else {
    const junk = rng.int(0, 2);
    if (junk === 0) send({ type: 'snoozeAdvice', key: 'not a key' });
    else if (junk === 1) send({ type: 'noteAdviceShown', keys: ['takeRate', 'takeRate'] });
    else send({ type: 'snoozeAdvice', key: '' });
  }
}

/**
 * Round 4c/4d: a growth-lever command: a neighborhood campaign in a random
 * area (often one the sim must refuse: running, cooling down, unlit), a
 * support level, referral credits on or off, or junk (an unknown cabinet,
 * level or flag).
 */
function randomLeverCommand(state: GameState, send: Send, rng: Rng): void {
  const roll = rng.next();
  if (roll < 0.4) {
    const cabinets = state.network.cabinets;
    if (cabinets.length > 0 && rng.chance(0.85)) send({ type: 'runCampaign', cabinet: rng.pick(cabinets).id });
    else send({ type: 'runCampaign', cabinet: -1 });
  } else if (roll < 0.65) {
    send({ type: 'setSupport', level: rng.pick(SUPPORT_LEVEL_IDS) });
  } else if (roll < 0.88) {
    send({ type: 'setReferrals', on: rng.chance(0.5) });
  } else {
    const junk = rng.int(0, 2);
    if (junk === 0) send({ type: 'setSupport', level: 'premium' as SupportLevel });
    else if (junk === 1) send({ type: 'setReferrals', on: 1 as unknown as boolean });
    else send({ type: 'runCampaign', cabinet: 0.5 });
  }
}

/** Chance per look that MIXED sends a growth-lever command (valid or junk: randomLeverCommand). */
const MIXED_LEVER_CHANCE = 0.2;

/**
 * SMART plus, each weekly look, a few random extras from its own Rng: cancel
 * or remove a span (any stage), remove a cabinet, add a splitter or an OLT
 * card, change prices (randomPricing) or the marketing budget, set an intro
 * promo (randomPromo), rebuild a span underground (randomConvert), a
 * financing command (randomDebtCommand), round 4b's retention offer
 * (randomAnswer) and briefing commands (randomAdviceCommand), round 4c/4d's
 * growth levers (randomLeverCommand, from a second Rng so the older mix plays
 * as before), or send junk the sim must reject. SMART leaves the intro promo
 * and the incumbent's promos to these random commands (managePromo false).
 */
export function mixedBot(options: Partial<SmartOptions> = {}): BotFactory {
  const opts: SmartOptions = { ...SMART_DEFAULTS, managePromo: false, ...options };
  return (seed) => {
    const rng = new Rng(deriveSeed(seed, 'bot:mixed'));
    // The growth levers draw from their own stream, so the round-4b command mix (rng) plays as before.
    const leverRng = new Rng(deriveSeed(seed, 'bot:mixed:levers'));
    const memo = newSmartMemo();
    return {
      name: 'mixed',
      act(state, send) {
        smartAct(state, send, opts, memo);
        if (leverRng.chance(MIXED_LEVER_CHANCE)) randomLeverCommand(state, send, leverRng);
        const extras = rng.int(0, 3);
        for (let i = 0; i < extras; i++) {
          if (rng.chance(0.25)) {
            randomDebtCommand(state, send, rng);
            continue;
          }
          if (rng.chance(0.12)) {
            if (rng.chance(0.5)) randomAnswer(state, send, rng);
            else randomAdviceCommand(state, send, rng);
            continue;
          }
          const roll = rng.next();
          const { spans, cabinets } = state.network;
          if (roll < 0.16 && spans.length > 0) {
            // Prefer cancelling something still in permitting (refund), sometimes live cable.
            const permitting = spans.filter((s) => s.stage === 'permitting');
            const pool = permitting.length > 0 && rng.chance(0.7) ? permitting : spans;
            send({ type: 'removeSpan', span: rng.pick(pool).id });
          } else if (roll < 0.24 && cabinets.length > 1) {
            send({ type: 'removeCabinet', cabinet: rng.pick(cabinets).id });
          } else if (roll < 0.36 && cabinets.length > 0) {
            send({ type: 'addSplitter', cabinet: rng.pick(cabinets).id });
          } else if (roll < 0.42) {
            send({ type: 'addOltCard' });
          } else if (roll < 0.56) {
            randomPricing(send, rng);
          } else if (roll < 0.63) {
            randomPromo(send, rng);
          } else if (roll < 0.7) {
            randomConvert(state, send, rng);
          } else if (roll < 0.83) {
            send({ type: 'setMarketing', perMonth: rng.chance(0.9) ? rng.int(0, MARKETING_MAX_PER_MONTH / 5) : -1 });
          } else if (roll < 0.95 && spans.length > 0) {
            // Re-order a street whose cable was removed earlier (remembered make-ready), or extend.
            const seg = rng.int(0, state.city.segments.length - 1);
            send({ type: 'layCable', segments: [seg], method: rng.chance(0.5) ? 'aerial' : 'underground' });
          } else {
            send({ type: 'placeCabinet', node: -1 });
          }
        }
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Round 4b: controlled experiments on the incumbent's promo and the intro promo
// ---------------------------------------------------------------------------

/** A plain-JSON copy of a game (GameState is plain data: README). */
function copyState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

/**
 * Test-only state edit: an incumbent promo at the cabinet area with the most
 * passings among those with customers (round 4c/4d: the incumbent answers a
 * take rate, so a promo where nobody has signed up yet tests nothing; any
 * area when none has customers), starting today with the rule's length, price and quiet months
 * (incumbent.reviewIncumbent's record), unless one already runs (then the
 * running one with the most passings). Returns its cabinet and whether it
 * was injected.
 */
export function ensureIncumbentPromo(state: GameState): { cabinet: number; injected: boolean } {
  const areas = areaTakeRates(state);
  const passingsOf = (cabinet: number) => areas.find((a) => a.cabinet === cabinet)?.passings ?? 0;
  const running = activePromos(state).sort((a, b) => passingsOf(b.cabinet) - passingsOf(a.cabinet) || a.cabinet - b.cabinet);
  if (running[0]) return { cabinet: running[0].cabinet, injected: false };
  const signed = (a: { takeRate: number }) => (a.takeRate > 0 ? 1 : 0);
  const area = [...areas].sort((a, b) => signed(b) - signed(a) || b.passings - a.passings || a.cabinet - b.cabinet)[0];
  if (!area) throw new Error('ensureIncumbentPromo: no cabinet area');
  const endDay = closeDayAfter(state.day, INCUMBENT_PROMO_MONTHS);
  const promo: IncumbentPromo = {
    cabinet: area.cabinet,
    startDay: state.day,
    endDay,
    price: incumbentPromoPrice(),
    quietUntil: closeDayAfter(endDay, INCUMBENT_PROMO_QUIET_MONTHS),
    triggerTakePct: Math.round(area.takeRate * 100),
    answered: false,
    answeredWithPromo: false,
  };
  state.sales.incumbentPromos = [...state.sales.incumbentPromos.filter((p) => p.cabinet !== area.cabinet), promo].sort((a, b) => a.cabinet - b.cabinet);
  return { cabinet: area.cabinet, injected: true };
}

/** The answers the incumbent-promo experiment compares. */
export type AnswerPolicy = 'ignore' | 'retention' | 'introPromo' | 'best';
export const ANSWER_POLICIES: readonly AnswerPolicy[] = ['ignore', 'retention', 'introPromo', 'best'];
/** The experiment starts from SMART's game at this month's close ... */
export const ANSWER_EXPERIMENT_MONTH = 30;
/** ... and plays the promo and a year after it. */
export const ANSWER_EXPERIMENT_MONTHS = INCUMBENT_PROMO_MONTHS + 12;

export interface AnswerExperiment {
  cabinet: number;
  /** The promo was injected (no promo ran in SMART's areas at that month). */
  injected: boolean;
  /** What incumbent.bestIncumbentAnswer chose at the promo's start. */
  chosen: IncumbentAnswer['kind'];
  /** Its quoted net value. */
  netValue: number;
  /** Cumulative operating cash flow over the experiment's months, by answer. */
  ocf: Record<AnswerPolicy, number>;
  /** Cancellations the incumbent's promos caused over them, by answer. */
  incumbentChurn: Record<AnswerPolicy, number>;
}

/**
 * The controlled experiment on the incumbent's promo: SMART's game at the
 * close of `month` with a promo at its largest area (ensureIncumbentPromo),
 * then `months` of SMART operating the network it has (no new areas, so
 * build timing does not drown the answer) under each answer to that promo:
 * ignore it; the retention offer (answerIncumbent) at its start; SMART's
 * intro promo (SMART_INTRO_PROMO) for new signups while it runs; or what
 * incumbent.bestIncumbentAnswer chooses at its start (that intro promo while
 * it runs, the retention offer, or nothing). Any later promo is ignored in
 * every case.
 */
export function incumbentAnswerExperiment(seed: number, month = ANSWER_EXPERIMENT_MONTH, months = ANSWER_EXPERIMENT_MONTHS): AnswerExperiment {
  const start = runBot(seed, smartBot(), month).state;
  const { cabinet, injected } = ensureIncumbentPromo(start);
  const promo = start.sales.incumbentPromos.find((p) => p.cabinet === cabinet) as IncumbentPromo;
  const best = bestIncumbentAnswer(start, cabinet);
  const operator = smartBot({ maxProjectsPerLook: 0, managePromo: false });
  const ocf = {} as Record<AnswerPolicy, number>;
  const incumbentChurn = {} as Record<AnswerPolicy, number>;
  for (const policy of ANSWER_POLICIES) {
    const answering: BotFactory = (s) => {
      const inner = operator(s);
      let decided = false;
      let offer: IntroPromo | null = null;
      return {
        name: `answer-${policy}`,
        act(state, send) {
          if (!decided) {
            decided = true;
            const kind = policy === 'best' ? bestIncumbentAnswer(state, cabinet).kind : policy;
            if (kind === 'retention') send({ type: 'answerIncumbent', cabinet });
            if (kind === 'introPromo') offer = policy === 'best' ? (bestIncumbentAnswer(state, cabinet).promo ?? SMART_INTRO_PROMO) : SMART_INTRO_PROMO;
          }
          const want = offer !== null && state.day < promo.endDay ? offer : null;
          if (!samePromo(want, state.sales.promo)) send({ type: 'setPromo', promo: want });
          inner.act(state, send);
        },
      };
    };
    const run = runBot(seed, answering, months, { state: copyState(start) });
    ocf[policy] = cumulativeOperatingCashFlow(run);
    incumbentChurn[policy] = run.reports.reduce((t, r) => t + (r.ops?.incumbentChurn ?? 0), 0);
  }
  return { cabinet, injected, chosen: best.kind, netValue: best.netValue, ocf, incumbentChurn };
}

/**
 * The fresh-area intro-promo experiment starts from SMART's game at this
 * month's close (its first areas just lit; or the first close with a lit
 * area, at the latest FRESH_PROMO_LATEST_MONTH) ...
 */
export const FRESH_PROMO_MONTH = 4;
export const FRESH_PROMO_LATEST_MONTH = 12;
/** ... and plays this long, comparing the operating cash flow at each of FRESH_PROMO_CHECK_MONTHS. */
export const FRESH_PROMO_MONTHS = 24;
export const FRESH_PROMO_CHECK_MONTHS: readonly number[] = [12, 18, 24];
/** The mature-town experiment starts at this month's close and plays a year with no new areas ... */
export const MATURE_PROMO_MONTH = 48;
export const MATURE_PROMO_MONTHS = 12;
/**
 * ... once SMART, building nothing new, has finished what it was building
 * then (at most this many more closes): streets that light during the year
 * would be a fresh area, where the promo's boost is meant to pay.
 */
export const MATURE_SETTLE_MONTHS_MAX = 6;

export interface PromoExperiment {
  /** sales.quotePromo(SMART_INTRO_PROMO) at the start. */
  quote: PromoQuote;
  /** Cumulative operating cash flow with the intro promo and without, at each checked month. */
  withPromo: number[];
  without: number[];
}

/**
 * The intro promo in a fresh area: SMART's game at FRESH_PROMO_MONTH (areas
 * lit in the last weeks, most households still to sign up; later when
 * nothing is lit yet) with an
 * incumbent promo at its largest area (ensureIncumbentPromo), played on by
 * SMART (building as usual) with SMART_INTRO_PROMO for new signups while the
 * incumbent's promo runs, against SMART ignoring it.
 */
export function freshPromoExperiment(seed: number): PromoExperiment {
  let start = runBot(seed, smartBot(), FRESH_PROMO_MONTH).state;
  // A long make-ready can leave nothing lit yet: then the first close after it with an area.
  for (let month = FRESH_PROMO_MONTH; areaTakeRates(start).length === 0 && month < FRESH_PROMO_LATEST_MONTH; month++) {
    start = runBot(seed, smartBot(), 1, { state: start }).state;
  }
  ensureIncumbentPromo(start);
  const quote = quotePromo(start, SMART_INTRO_PROMO);
  const play = (incumbentAnswer: IncumbentAnswerPolicy) => {
    const run = runBot(seed, smartBot({ incumbentAnswer, introPromo: SMART_INTRO_PROMO }), FRESH_PROMO_MONTHS, { state: copyState(start) });
    return FRESH_PROMO_CHECK_MONTHS.map((m) => cumulativeOperatingCashFlow(run, m));
  };
  return { quote, withPromo: play('introPromo'), without: play('none') };
}

/**
 * The intro promo in a mature town: SMART's game at MATURE_PROMO_MONTH, then
 * SMART building nothing new until all its plant is live (at most
 * MATURE_SETTLE_MONTHS_MAX closes), played MATURE_PROMO_MONTHS on by SMART
 * building nothing new, with SMART_INTRO_PROMO set throughout against none
 * (any incumbent promo ignored).
 */
export function maturePromoExperiment(seed: number): PromoExperiment {
  let start = runBot(seed, smartBot(), MATURE_PROMO_MONTH).state;
  const building = (state: GameState) => state.network.spans.some((s) => s.stage !== 'live') || state.network.cabinets.some((c) => c.stage !== 'live');
  for (let month = 0; month < MATURE_SETTLE_MONTHS_MAX && building(start); month++) {
    start = runBot(seed, smartBot({ maxProjectsPerLook: 0, incumbentAnswer: 'none' }), 1, { state: start }).state;
  }
  const quote = quotePromo(start, SMART_INTRO_PROMO);
  const play = (standingPromo: IntroPromo | null) => {
    const run = runBot(seed, smartBot({ maxProjectsPerLook: 0, incumbentAnswer: 'none', standingPromo }), MATURE_PROMO_MONTHS, { state: copyState(start) });
    return [cumulativeOperatingCashFlow(run)];
  };
  return { quote, withPromo: play(SMART_INTRO_PROMO), without: play(null) };
}

// ---------------------------------------------------------------------------
// Round 4c/4d: CASUAL, the lever and lineup variants, the experiments
// ---------------------------------------------------------------------------

/** CASUAL lays at most this many streets with homes ("a few dense streets near the CO"). */
export const CASUAL_STREETS = 8;
/** It looks for its cabinet's corner within this street distance of the CO. */
export const CASUAL_SEARCH_FT = 2_400;
/** It spends at most this share of its cash on its plant. */
export const CASUAL_BUDGET_SHARE = 0.4;

/**
 * CASUAL's one build: a cabinet at the corner within CASUAL_SEARCH_FT of
 * the CO whose reach holds the most homes, cabled from the CO, and up to
 * CASUAL_STREETS of the streets with homes in its reach, densest (units per
 * dollar of cable) first, each with its street path back to the cabinet,
 * every segment by its cheapest method (aerial where poled), within
 * CASUAL_BUDGET_SHARE of its cash. True once ordered.
 */
function casualBuild(state: GameState, send: Send): boolean {
  const { city } = state;
  const reach = streetReach(city);
  const units = unitsBySegment(state);
  const near = streetTree(city, city.coNode, CASUAL_SEARCH_FT);
  const corners = [...near.dist.keys()]
    .map((node) => {
      let n = 0;
      for (const seg of reach[node] as SegmentId[]) n += units[seg] as number;
      return { node, units: n, dist: near.dist.get(node) ?? 0 };
    })
    .filter((c) => c.units > 0)
    .sort((a, b) => b.units - a.units || a.dist - b.dist || a.node - b.node);
  const budget = CASUAL_BUDGET_SHARE * state.finance.cash;
  for (const corner of corners) {
    const node = corner.node;
    const cabinetCost = quoteCabinet(state, node);
    if (!cabinetCost.ok) continue;
    const feeder = node === city.coNode ? [] : (cableRoute(state, city.coNode, node, 'aerial') ?? null);
    if (feeder === null) continue;
    const tree = streetTree(city, node, CABINET_REACH_FT);
    const streets = (reach[node] as SegmentId[])
      .filter((seg) => (units[seg] as number) > 0)
      .map((seg) => ({ seg, density: (units[seg] as number) / Math.max(1, cheapestMethod(city.segments[seg] as StreetSegment).cost) }))
      .sort((a, b) => b.density - a.density || a.seg - b.seg)
      .slice(0, CASUAL_STREETS);
    const chosen = streets.map(({ seg }) => {
      const s = city.segments[seg] as StreetSegment;
      const da = tree.dist.get(s.a) ?? Infinity;
      const db = tree.dist.get(s.b) ?? Infinity;
      return [seg, ...treePath(city, tree, da <= db ? s.a : s.b)];
    });
    const quoteOf = (picked: SegmentId[][]) => {
      const all = new Set<SegmentId>(feeder);
      for (const path of picked) for (const id of path) all.add(id);
      const byMethod: Record<CableMethod, SegmentId[]> = { aerial: [], underground: [] };
      for (const id of all) byMethod[cheapestMethod(city.segments[id] as StreetSegment).method].push(id);
      const orders = [...groupOrders(city, byMethod.aerial, 'aerial', SMART_DEFAULTS.orderMaxFt), ...groupOrders(city, byMethod.underground, 'underground', SMART_DEFAULTS.orderMaxFt)];
      let cost = cabinetCost.cost;
      for (const order of orders) cost += quoteCable(state, order.segments, order.method).cost;
      return { orders, cost };
    };
    let plan = quoteOf(chosen);
    while (plan.cost > budget && chosen.length > 1) {
      chosen.pop();
      plan = quoteOf(chosen);
    }
    if (plan.cost > budget) continue;
    if (!send({ type: 'placeCabinet', node }).ok) continue;
    for (const order of plan.orders) send({ type: 'layCable', segments: order.segments, method: order.method });
    return true;
  }
  return false;
}

/**
 * CASUAL (round 4c/4d, spec F): a first-time player. On its first look it
 * lays a few dense streets near the CO with one cabinet (casualBuild); then
 * it keeps the default prices, the default marketing budget and Good
 * support, runs no campaigns, takes no loans, and adds a splitter (with an
 * OLT card when no PON port is free) when its cabinet is full and cash
 * allows.
 */
export function casualBot(): BotFactory {
  return () => {
    let built = false;
    return {
      name: 'casual',
      act(state, send) {
        if (!built) built = casualBuild(state, send);
        for (const cabinet of [...state.network.cabinets]) {
          if (!state.sales.fullCabinets.includes(cabinet.id) || cabinet.splitters >= MAX_SPLITTERS_PER_CABINET) continue;
          const { olt } = state.network;
          const card = ponPortsUsed(state) >= olt.ponPorts;
          if (card && olt.cards >= OLT_MAX_CARDS) continue;
          if (state.finance.cash < SPLITTER_COST + (card ? OLT_CARD_COST : 0)) continue;
          if (card && !send({ type: 'addOltCard' }).ok) continue;
          send({ type: 'addSplitter', cabinet: cabinet.id });
        }
      },
    };
  };
}

/** DISCOUNT's prices: every tier this multiple of its TIER_DEFAULTS price (about 17% below), kept from day 0. */
export const DISCOUNT_PRICE_MULTIPLIER = 0.83;
/** OVERPRICED's prices: every tier this multiple of its TIER_DEFAULTS price, kept from day 0. */
export const OVERPRICED_PRICE_MULTIPLIER = 1.2;

/** DISCOUNT (round 4c/4d, spec I.7): SMART with every price DISCOUNT_PRICE_MULTIPLIER of the defaults. */
export function discountBot(options: Partial<SmartOptions> = {}): BotFactory {
  return constantPriceBot(smartBot({ name: 'discount', ...options }), DISCOUNT_PRICE_MULTIPLIER);
}

/** OVERPRICED (round 4c/4d, spec I.7): SMART with every price OVERPRICED_PRICE_MULTIPLIER of the defaults. */
export function overpricedBot(options: Partial<SmartOptions> = {}): BotFactory {
  return constantPriceBot(smartBot({ name: 'overpriced', ...options }), OVERPRICED_PRICE_MULTIPLIER);
}

/** SMART pulling every growth lever by its quote: campaigns where they pay, the support level and referral credits by quote. */
export const SMART_LEVERS_OPTIONS: Partial<SmartOptions> = { campaigns: true, support: 'quote', referrals: 'quote', name: 'smart-levers' };

export function smartLeversBot(options: Partial<SmartOptions> = {}): BotFactory {
  return smartBot({ ...SMART_LEVERS_OPTIONS, ...options });
}

/** SMART operating the network it has: no new areas, no promo management (the experiments' operator). */
const OPERATOR_OPTIONS: Partial<SmartOptions> = { maxProjectsPerLook: 0, managePromo: false, convert: false };

/**
 * `makeInner` with `first` sent on its first look (before the inner bot
 * acts): an experiment arm's one decision.
 */
function withFirst(first: (state: GameState, send: Send) => void, makeInner: BotFactory, name: string): BotFactory {
  return (seed) => {
    const inner = makeInner(seed);
    let done = false;
    return {
      name,
      act(state, send) {
        if (!done) {
          done = true;
          first(state, send);
        }
        inner.act(state, send);
      },
    };
  };
}

/** Cumulative operating cash flow less install capex (cash before plant and financing) over months 1..toMonth. */
export function operatingLessInstalls(run: RunResult, toMonth = run.reports.length): number {
  let flow = 0;
  for (let i = 0; i < Math.min(toMonth, run.reports.length); i++) {
    const report = run.reports[i] as RunResult['reports'][number];
    flow += (run.kpis[i]?.operatingCashFlow ?? 0) + (report.totals.install ?? 0);
  }
  return flow;
}

// The marketing forecast ---------------------------------------------------------

/** The marketing-forecast check quotes at these month closes of SMART's game. */
export const MARKETING_FORECAST_MONTHS: readonly number[] = [24, 36];

export interface MarketingForecastCheck {
  month: number;
  /** quoteMarketing(today's budget).signupsPerMonth x CUSTOMER_QUOTE_MONTHS. */
  quoted: number;
  /** Units connected (stats.grossAdds) over the next CUSTOMER_QUOTE_MONTHS closes, SMART operating its network with the same budget and no new areas. */
  realized: number;
  /** Diagnostics: cabinets turning signups away at the start, passings at the start and the end. */
  fullAtStart: number;
  passingsStart: number;
  passingsEnd: number;
}

/**
 * The marketing forecast against what the sim then does: SMART's game at the
 * close of `month`, quoteMarketing at its budget, then CUSTOMER_QUOTE_MONTHS
 * of SMART operating that network as it stands, under the forecast's own
 * assumptions (customers.forecastCustomers: no new streets and no new ports,
 * so no new areas or splitters; the same marketing per passing).
 */
export function marketingForecastCheck(seed: number, month: number): MarketingForecastCheck {
  const start = runBot(seed, smartBot(), month).state;
  const quote = quoteMarketing(start, start.sales.marketingPerMonth);
  const run = runBot(seed, smartBot({ ...OPERATOR_OPTIONS, capacity: false }), CUSTOMER_QUOTE_MONTHS, { state: copyState(start) });
  let realized = 0;
  for (const report of run.reports) realized += report.stats?.grossAdds ?? 0;
  return {
    month,
    quoted: quote.signupsPerMonth * CUSTOMER_QUOTE_MONTHS,
    realized,
    fullAtStart: start.sales.fullCabinets.length,
    passingsStart: getService(start).passings,
    passingsEnd: run.reports.at(-1)?.passings ?? 0,
  };
}

// Campaigns -----------------------------------------------------------------------------

/** Months each lever experiment plays after its decision (the quotes' horizon). */
export const LEVER_EXPERIMENT_MONTHS = CUSTOMER_QUOTE_MONTHS;
/** A freshly lit area: its cabinet went live within this many days of the close the experiment starts from ... */
export const FRESH_AREA_DAYS = 60;
/** ... found at the first such close up to this month. */
export const FRESH_AREA_LATEST_MONTH = 18;
/** A well-signed area: lit at least this many months at MATURE_PROMO_MONTH, the one with the highest take rate (INCUMBENT_PROMO_MIN_PASSINGS passings or more). */
export const SIGNED_AREA_MONTHS = 36;

export interface LeverArm {
  /** Cumulative operating cash flow over LEVER_EXPERIMENT_MONTHS with the lever and without. */
  withLever: number;
  without: number;
  /** Subscribers at the end with and without. */
  subsWith: number;
  subsWithout: number;
}

export interface CampaignArm extends LeverArm {
  cabinet: number;
  quote: CampaignQuote;
  /**
   * The campaign's realized worth in its own area over LEVER_EXPERIMENT_MONTHS:
   * the extra subscriber-months there (CustomerStats.areas at each close, with
   * against without) x what a unit pays less overhead.perCustomerCost (the
   * quote's margin), less its cost. Its own area only, so the rest of the
   * network's luck (storms, the sales stream's draws) does not drown it.
   */
  areaValue: number;
}

export interface CampaignExperiment {
  fresh: CampaignArm | null;
  signed: CampaignArm | null;
}

/** Fewest unsigned lit units an area needs to be the campaign experiment's fresh area. */
export const FRESH_AREA_MIN_UNSIGNED = 40;

/**
 * SMART's game at the first close (from month 1 up to FRESH_AREA_LATEST_MONTH)
 * with a cabinet live for at most FRESH_AREA_DAYS whose area has
 * FRESH_AREA_MIN_UNSIGNED or more lit units not signed up (the one with the
 * most), and that cabinet; null if none.
 */
function freshAreaStart(seed: number): { state: GameState; cabinet: number } | null {
  let state = newGame(seed);
  const bot = smartBot();
  for (let month = 1; month <= FRESH_AREA_LATEST_MONTH; month++) {
    state = runBot(seed, bot, 1, { state }).state;
    const areas = customerAreas(state).filter((a) => {
      const cabinet = state.network.cabinets.find((c) => c.id === a.cabinet);
      return cabinet && cabinet.liveDay !== null && state.day - cabinet.liveDay <= FRESH_AREA_DAYS && a.passings - a.subscribed >= FRESH_AREA_MIN_UNSIGNED;
    });
    const best = areas.sort((a, b) => b.passings - b.subscribed - (a.passings - a.subscribed) || a.cabinet - b.cabinet)[0];
    if (best) return { state, cabinet: best.cabinet };
  }
  return null;
}

/** SMART's game at MATURE_PROMO_MONTH and its best-signed area lit SIGNED_AREA_MONTHS or more; null if none. */
function signedAreaStart(seed: number): { state: GameState; cabinet: number } | null {
  const state = runBot(seed, smartBot(), MATURE_PROMO_MONTH).state;
  const best = customerAreas(state)
    .filter((a) => (a.monthsLit ?? 0) >= SIGNED_AREA_MONTHS && a.passings >= INCUMBENT_PROMO_MIN_PASSINGS && a.takeRate !== null)
    .sort((a, b) => (b.takeRate ?? 0) - (a.takeRate ?? 0) || a.cabinet - b.cabinet)[0];
  return best ? { state, cabinet: best.cabinet } : null;
}

/** One lever decision played both ways from `start` by SMART operating its network (no new areas) for `months`, and both runs. */
function leverRuns(seed: number, start: GameState, decide: (state: GameState, send: Send) => void, operator: Partial<SmartOptions> = {}, months = LEVER_EXPERIMENT_MONTHS): { a: RunResult; b: RunResult } {
  const play = (lever: boolean) => {
    const bot = withFirst(lever ? decide : () => {}, smartBot({ ...OPERATOR_OPTIONS, ...operator }), lever ? 'lever' : 'none');
    return runBot(seed, bot, months, { state: copyState(start) });
  };
  return { a: play(true), b: play(false) };
}

function armOf(a: RunResult, b: RunResult): LeverArm {
  return {
    withLever: cumulativeOperatingCashFlow(a),
    without: cumulativeOperatingCashFlow(b),
    subsWith: a.reports.at(-1)?.stats?.subscribers ?? 0,
    subsWithout: b.reports.at(-1)?.stats?.subscribers ?? 0,
  };
}

/** Subscribed units of cabinet `cabinet`'s area summed over the run's closes (CustomerStats.areas): its subscriber-months. */
function areaUnitMonths(run: RunResult, cabinet: number): number {
  let months = 0;
  for (const report of run.reports) months += report.customers?.areas.find((a) => a.cabinet === cabinet)?.units ?? 0;
  return months;
}

/**
 * The campaign experiment: a neighborhood campaign in a freshly lit area
 * (freshAreaStart) and in a well-signed one (signedAreaStart), each against
 * none, by realized operating cash flow over LEVER_EXPERIMENT_MONTHS
 * (the campaign's cost is in it) and by quoteCampaign at the start.
 */
export function campaignExperiment(seed: number): CampaignExperiment {
  const arm = (start: { state: GameState; cabinet: number } | null): CampaignArm | null => {
    if (!start) return null;
    const quote = quoteCampaign(start.state, start.cabinet);
    const { a, b } = leverRuns(seed, start.state, (_, send) => {
      send({ type: 'runCampaign', cabinet: start.cabinet });
    });
    const margin = subscriberEconomics(start.state).margin;
    const areaValue = (areaUnitMonths(a, start.cabinet) - areaUnitMonths(b, start.cabinet)) * margin - quote.cost;
    return { cabinet: start.cabinet, quote, areaValue, ...armOf(a, b) };
  };
  return { fresh: arm(freshAreaStart(seed)), signed: arm(signedAreaStart(seed)) };
}

// Support level ---------------------------------------------------------------------

/** The support experiment starts at this close of an all-aerial (high outage exposure) and an all-underground (low) SMART's game ... */
export const SUPPORT_EXPERIMENT_MONTH = 24;
/** ... and compares the levels over a short and a long horizon (months). */
export const SUPPORT_SHORT_MONTHS = CUSTOMER_QUOTE_MONTHS;
export const SUPPORT_LONG_MONTHS = 36;

export interface SupportCase {
  /** Cumulative operating cash flow less installs over the horizon, by level. */
  value: Record<SupportLevel, number>;
  /** harness.runValue at the end (cash less debt plus VALUE_YEARS of its trailing operating cash flow), by level. */
  worth: Record<SupportLevel, number>;
  /** Subscribers at the end, by level. */
  subscribers: Record<SupportLevel, number>;
  /** quoteSupport('great') at the start. */
  greatQuote: SupportQuote;
}

export interface SupportExperiment {
  high: { short: SupportCase; long: SupportCase };
  low: { short: SupportCase; long: SupportCase };
}

function supportCase(seed: number, start: GameState, months: number): SupportCase {
  const value = {} as Record<SupportLevel, number>;
  const worth = {} as Record<SupportLevel, number>;
  const subscribers = {} as Record<SupportLevel, number>;
  for (const level of SUPPORT_LEVEL_IDS) {
    const run = runBot(seed, smartBot({ ...OPERATOR_OPTIONS, support: level }), months, { state: copyState(start) });
    value[level] = operatingLessInstalls(run);
    worth[level] = runValue(run);
    subscribers[level] = run.reports.at(-1)?.stats?.subscribers ?? 0;
  }
  return { value, worth, subscribers, greatQuote: quoteSupport(start, 'great') };
}

/**
 * The support experiment: Basic, Good and Great from SUPPORT_EXPERIMENT_MONTH
 * of an all-aerial SMART's game (high outage exposure) and an
 * all-underground one (low), each over SUPPORT_SHORT_MONTHS and
 * SUPPORT_LONG_MONTHS, SMART operating its network (no new areas), valued by
 * operating cash flow less installs (operatingLessInstalls: a cancellation
 * refilled costs a new install).
 */
export function supportExperiment(seed: number): SupportExperiment {
  const high = runBot(seed, allAerialBot(), SUPPORT_EXPERIMENT_MONTH).state;
  const low = runBot(seed, allUndergroundBot(), SUPPORT_EXPERIMENT_MONTH).state;
  return {
    high: { short: supportCase(seed, high, SUPPORT_SHORT_MONTHS), long: supportCase(seed, high, SUPPORT_LONG_MONTHS) },
    low: { short: supportCase(seed, low, SUPPORT_SHORT_MONTHS), long: supportCase(seed, low, SUPPORT_LONG_MONTHS) },
  };
}

// Referral credits ------------------------------------------------------------------

/** The referral experiment starts from SMART's game at this close (young areas: customers next to many unsigned lit homes). */
export const REFERRAL_YOUNG_MONTH = 15;

export interface ReferralArm extends LeverArm {
  quote: ReferralQuote;
  /** Realized: the extra subscriber-months with credits on x the margin a unit brings, less the credits paid. */
  subsValue: number;
  /** Happy share of the customers and unsigned share of the lit homes at the start. */
  happyShare: number;
  unsignedShare: number;
}

export interface ReferralExperiment {
  many: ReferralArm;
  few: ReferralArm;
}

/**
 * The referral experiment: credits on against off from REFERRAL_YOUNG_MONTH
 * of SMART's game, SMART operating its network for LEVER_EXPERIMENT_MONTHS,
 * by realized value (ReferralArm.subsValue) and quoteReferrals at the start:
 * `many` as the game stands there (Good support: happy customers next to
 * many unsigned lit homes), `few` with Basic support set first in both arms
 * (customers merely okay: few happy ones to bring neighbors).
 */
export function referralExperiment(seed: number): ReferralExperiment {
  const young = runBot(seed, smartBot(), REFERRAL_YOUNG_MONTH).state;
  const arm = (start: GameState, operator: Partial<SmartOptions>): ReferralArm => {
    const units = subscriberUnits(start);
    const passings = getService(start).passings;
    const { a, b } = leverRuns(
      seed,
      start,
      (_, send) => {
        send({ type: 'setReferrals', on: true });
      },
      operator,
    );
    const margin = subscriberEconomics(start).margin;
    let extra = 0;
    let credits = 0;
    for (const r of a.reports) {
      extra += r.stats?.subscribers ?? 0;
      credits += r.customers?.referralCredits ?? 0;
    }
    for (const r of b.reports) extra -= r.stats?.subscribers ?? 0;
    return {
      quote: quoteReferrals(start, true),
      subsValue: extra * margin - credits,
      happyShare: units > 0 ? happinessReport(start).happy / units : 0,
      unsignedShare: passings > 0 ? (passings - units) / passings : 0,
      ...armOf(a, b),
    };
  };
  const basic = copyState(young);
  basic.customers.supportLevel = 'basic';
  return { many: arm(young, {}), few: arm(basic, { support: 'basic' }) };
}

// Switching speed by price -------------------------------------------------------

/** The switching experiment starts from SMART's game at this close (its first areas lit) ... */
export const SWITCHING_EXPERIMENT_MONTH = 12;
/** ... and plays the network it has this long under each lineup. */
export const SWITCHING_EXPERIMENT_MONTHS = 48;
/** An area "reaches the ceiling" once its take rate is this share of its ceiling (AreaCurve.ceiling). */
export const CEILING_SHARE = 0.9;

export interface SwitchingArm {
  /** Pooled over the areas lit at the start: whole months until their take rate reached CEILING_SHARE of their ceiling (null: not within the run). */
  monthsToCeiling: number | null;
  /** Their ceiling take rate and their take rate at the end. */
  ceiling: number;
  take: number;
  /** Their take rate at each close of the run. */
  takes: number[];
  /** Revenue per subscriber-month over the run (ARPU), and revenue per home they pass in the last 12 months. */
  arpu: number;
  revenuePerHome: number;
  /** Cumulative operating cash flow over the run. */
  ocf: number;
}

export interface SwitchingExperiment {
  /** The cabinets whose areas were lit at the start. */
  cabinets: number[];
  standard: SwitchingArm;
  discount: SwitchingArm;
  overpriced: SwitchingArm;
}

/**
 * Switching speed by price, on one fixed set of areas: SMART's game at
 * SWITCHING_EXPERIMENT_MONTH, then SWITCHING_EXPERIMENT_MONTHS of SMART
 * operating the network it has (no new areas) at the default prices, at
 * DISCOUNT_PRICE_MULTIPLIER of them and at OVERPRICED_PRICE_MULTIPLIER (set
 * on the first day, the default grandfathering for a rise), measured on the
 * areas lit at the start (their pooled take rate against their pooled
 * ceiling: harness.areaCurves).
 */
export function switchingExperiment(seed: number): SwitchingExperiment {
  const start = runBot(seed, smartBot(), SWITCHING_EXPERIMENT_MONTH).state;
  const service = getService(start);
  const cabinets = start.network.cabinets.filter((c) => c.liveDay !== null && (service.cabinetCoverage.get(c.id)?.passings ?? 0) > 0).map((c) => c.id);
  const arm = (multiplier: number): SwitchingArm => {
    const inner = smartBot(OPERATOR_OPTIONS);
    const bot = multiplier === 1 ? inner : constantPriceBot(inner, multiplier);
    const run = runBot(seed, bot, SWITCHING_EXPERIMENT_MONTHS, { state: copyState(start) });
    const curves = areaCurves(run).filter((c) => cabinets.includes(c.cabinet));
    let target = 0;
    let passings = 0;
    for (const c of curves) {
      target += c.ceiling * c.passings;
      passings += c.passings;
    }
    const ceiling = passings > 0 ? target / passings : 0;
    const takes = run.reports.map((report) => {
      let units = 0;
      let homes = 0;
      for (const area of report.customers?.areas ?? []) {
        if (!cabinets.includes(area.cabinet)) continue;
        units += area.units;
        homes += area.passings;
      }
      return homes > 0 ? units / homes : 0;
    });
    const reached = takes.findIndex((t) => t >= CEILING_SHARE * ceiling);
    let revenue = 0;
    for (const report of run.reports.slice(-12)) revenue += report.totals.revenue ?? 0;
    const lastPassings = run.reports.at(-1)?.passings ?? 0;
    return {
      monthsToCeiling: reached < 0 ? null : reached + 1,
      ceiling,
      take: takes.at(-1) ?? 0,
      takes,
      arpu: averageArpu(run) ?? 0,
      revenuePerHome: lastPassings > 0 ? revenue / lastPassings : 0,
      ocf: cumulativeOperatingCashFlow(run),
    };
  };
  return { cabinets, standard: arm(1), discount: arm(DISCOUNT_PRICE_MULTIPLIER), overpriced: arm(OVERPRICED_PRICE_MULTIPLIER) };
}
