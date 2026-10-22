// Tunable game-balance values. Rough starting points; see docs/light-speed-tycoon/DESIGN.md.
// Money in whole dollars, distance in feet, time in days.
//
// Round 2: tuned by headless bots (src/sim/tuning/): targets.test.ts holds the
// targets (start cash vs. town build-out, cost per passing by area, smart play
// cash-flow positive in months 12-18, careless overbuild goes bankrupt, idle
// survives) across several seeds; TUNE_REPORT=1 npx vitest run
// src/sim/tuning/report.test.ts prints the per-seed numbers. Tests reference
// these constants symbolically, never as literal dollar amounts.
// Round 3: the Financing section, tuned the same way (a careful borrower passes
// half the town or more by month 60 without a covenant breach, at ~7%; a
// rural-heavy borrower pays the red CPP spread; borrowing every dollar offered
// ends in a default).
// Round 4: storms, pole rent, the underground bore, prices, the take-rate and
// churn weights moved (targets4.test.ts: a careful operator buries 20-35% of
// its plant, an all-aerial copy is clearly more exposed to storms, default
// prices are the best constant price, hikes lose subscribers, a frozen-line
// hoarder repays through the call or defaults); see DESIGN.md, "Round 4 tuning".
// Round 4b: difficulty levels (only the starting cash differs) and the
// incumbent's promo, the retention offer and the storm-exposure bands
// (targets4b.test.ts: dropping the cheap tiers loses, promos do not cycle,
// the best answer to one beats ignoring it, the intro promo pays in a fresh
// area, storms favour exposed streets); see DESIGN.md, "Round 4b".
// Round 4c/4d (contract): scaled overhead, support levels, the customers
// model (switching by deal value, awareness, word of mouth, happiness) and
// the growth levers (neighborhood campaigns, referral credits). The values
// at the end of this file are the architect's first guesses; the round-4cd
// tuner owns them (tuning/targets4cd.test.ts).

import type { CppBand, DemandSegmentId, DifficultyId, ParcelKind, SupportLevel, TermYears, TierId, Zone } from './types';

export const START_YEAR = 2027;
/**
 * Start cash covers only ~25-33% of the town's build-out (tuning target).
 * Round 4b: the Seed round difficulty's starting investment (every round-2..4
 * tuning target is measured at it); DIFFICULTY_LEVELS holds the others.
 */
export const START_CASH = 750_000;

/** Round 4b: one difficulty level (owner decision 2026-10-21: levels differ ONLY in starting cash). */
export interface DifficultyLevel {
  id: DifficultyId;
  /** Start-screen card title, e.g. "Seed round". */
  name: string;
  /** finance.cash on day 0, whole dollars. */
  startCash: number;
  /** One line on the card: how it plays. */
  feel: string;
}

/**
 * Round 4b: the four difficulty levels, easiest first (the start screen's
 * card order). Seed round is START_CASH, the tuned default game; the others
 * change nothing but the starting investment.
 */
export const DIFFICULTY_LEVELS: readonly DifficultyLevel[] = [
  { id: 'angel', name: 'Angel-backed', startCash: 1_500_000, feel: 'Relaxed: cable a big chunk of town on day one.' },
  { id: 'seed', name: 'Seed round', startCash: START_CASH, feel: 'The standard game: build smart, then borrow to grow.' },
  { id: 'bootstrapped', name: 'Bootstrapped', startCash: 400_000, feel: 'Tight: one neighborhood, then sales and loans.' },
  { id: 'shoestring', name: 'Shoestring', startCash: 200_000, feel: 'Expert: one good street, and every dollar counts.' },
];
/** Round 4b: the level a new game starts at unless the player picks another, and every save from before difficulty existed. */
export const DEFAULT_DIFFICULTY: DifficultyId = 'seed';

/** Feet per map cell. A typical residential lot frontage. */
export const TILE_FT = 60;

// ---------------------------------------------------------------------------
// Construction cost
// ---------------------------------------------------------------------------

/** Aerial strand + lash, dollars per ft (excludes make-ready). */
export const AERIAL_COST_PER_FT = 11;
/**
 * Underground directional bore + conduit, dollars per ft (soil). Round 4: 28
 * -> 26, the lowest that keeps dense underground runs near CPP_TARGET (the
 * $850-1,150 probe band), so burying a short block can pay for itself.
 */
export const UNDERGROUND_COST_PER_FT = 26;
/** Extra dollars per ft for underground on rock, shown as its own quote line (rock bore ~ $50/ft all-in). */
export const UNDERGROUND_ROCK_SURCHARGE_PER_FT = 22;
/** Aerial make-ready: utility work per pole on each new aerial segment (polesOnSegment), non-refundable. */
export const MAKE_READY_COST_PER_POLE = 450;
/** Engineering and design, per cable order (one layCable command), any method. Non-refundable. */
export const ENGINEERING_FEE = 1_500;
/** Right-of-way application per underground order: city excavation permit. Non-refundable. */
export const PERMIT_FEE_UNDERGROUND = 1_000;
/** Right-of-way application per aerial order: pole attachment application. Non-refundable. */
export const PERMIT_FEE_AERIAL = 500;

// Construction speed (feet per day for a single span; crews come later).
export const AERIAL_FT_PER_DAY = 800;
export const UNDERGROUND_FT_PER_DAY = 300;

/**
 * Aerial routing prefers poled (or already cabled) streets, but never a detour
 * longer than this multiple of the plain shortest route; beyond it the shortest
 * route is used and its quote names the street without poles.
 */
export const AERIAL_DETOUR_MAX_RATIO = 1.5;

// ---------------------------------------------------------------------------
// Right-of-way timing
// ---------------------------------------------------------------------------

// Aerial needs pole attachment + make-ready, underground needs a city permit.
export const MAKE_READY_DAYS_MIN = 30;
export const MAKE_READY_DAYS_MAX = 90;
/** Chance a make-ready job hits a long delay (pole replacement, utility backlog). */
export const MAKE_READY_LONG_CHANCE = 0.15;
export const MAKE_READY_LONG_DAYS_MIN = 120;
export const MAKE_READY_LONG_DAYS_MAX = 210;
export const PERMIT_DAYS_MIN = 14;
export const PERMIT_DAYS_MAX = 45;
/**
 * How long a segment's permitting draw is remembered (MakeReadyMemo): an order
 * for the same segment and method within this many days of the draw reuses it,
 * so cancel-and-reorder cannot re-roll a long make-ready.
 */
export const MAKE_READY_MEMORY_DAYS = 365;

// Refunds: cancelling a span still in permitting refunds this fraction of its
// refundable part (construction + rock; fees and make-ready never come back).
// 1: the non-refundable fees already act as a cancellation fee.
export const PERMITTING_CANCEL_REFUND = 1;

// ---------------------------------------------------------------------------
// Poles
// ---------------------------------------------------------------------------

export const POLE_SPACING_FT = 150;
/**
 * Pole attachment rent, per pole on live aerial cable, posted at each close.
 * Round 4: 2 -> 7 (pole attachment, inspection and the utility's annual
 * fees): aerial plant is cheaper up front and dearer to keep, so the careful
 * operator buries the short blocks, where one pole's rent covers little
 * cable. About 4-5% of a careful operator's revenue (5-6% for an all-aerial one).
 */
export const POLE_RENT_PER_POLE_PER_MONTH = 7;

// ---------------------------------------------------------------------------
// Cabinets (fiber distribution hubs), splitters and coverage
// ---------------------------------------------------------------------------

/** Cabinet shell, pad and install. */
export const CABINET_COST = 28_000;
/** One 1:SPLIT_RATIO splitter, installed. */
export const SPLITTER_COST = 1_800;
export const CABINET_START_SPLITTERS = 1;
export const SPLIT_RATIO = 32;
/** Splitter slots per cabinet (8 x 32 = 256 subscriber ports). */
export const MAX_SPLITTERS_PER_CABINET = 8;
export const CABINET_PERMIT_DAYS = 10;
export const CABINET_CONSTRUCT_DAYS = 5;
/** Cancelling a cabinet while permitting refunds this fraction of Cabinet.cost; none once construction starts. */
export const CABINET_CANCEL_REFUND = 1;
/**
 * A cabinet passes homes on connected cable whose nearer endpoint is strictly
 * less than this far from the cabinet's node, measured along that cable.
 * Tuned so placement is a decision: the best downtown corner reaches about 500
 * units (~30% of the town), a typical corner ~150-200, and covering the whole
 * town takes ~17-22 cabinets (at 1,500 ft one corner reached ~1,200 units and
 * two or three cabinets covered most of the town).
 */
export const CABINET_REACH_FT = 800;

// ---------------------------------------------------------------------------
// OLT at the CO
// ---------------------------------------------------------------------------

/**
 * Every cabinet's splitters take PON ports. One 16-port card (the owner's model:
 * 16 cabinets before a CO upgrade) covers the opening build; covering the whole
 * town takes 17-22 cabinets at CABINET_REACH_FT, so town-wide expansion needs a card.
 */
export const OLT_PORTS_PER_CARD = 16;
export const OLT_START_CARDS = 1;
/** Line-card slots in the one chassis (a second chassis comes later). */
export const OLT_MAX_CARDS = 8;
export const OLT_CARD_COST = 12_000;
export const OLT_START_PON_PORTS = OLT_START_CARDS * OLT_PORTS_PER_CARD;

// ---------------------------------------------------------------------------
// Cost per passing (scorecard)
// ---------------------------------------------------------------------------

/** Target lifetime OSP capex per unit passed. Green at or below. */
export const CPP_TARGET = 1_000;
/** Amber up to CPP_TARGET x this; red above. */
export const CPP_AMBER_MULTIPLIER = 1.5;

// ---------------------------------------------------------------------------
// Pricing and the incumbent
// ---------------------------------------------------------------------------

export interface TierDefault {
  id: TierId;
  name: string;
  downMbps: number;
  upMbps: number;
  price: number;
  /** Relative appeal before price (tier-mix weight multiplier). */
  popularity: number;
}

/**
 * The fixed tier lineup and its starting prices, in display order. The
 * prices are also the market reference churn and the advisor compare with.
 * Round 4: 55/70/95 -> 60/75/95, with the take-rate and churn weights below,
 * so the defaults are what the market bears: a careful operator playing five
 * years at constant multiples of these prices does best at x1 (the sweep in
 * tuning/harness.ts; it was x1.3 before).
 */
export const TIER_DEFAULTS: readonly TierDefault[] = [
  { id: 'fiber500', name: '500 Mbps', downMbps: 500, upMbps: 500, price: 60, popularity: 1 },
  { id: 'fiber1g', name: '1 Gig', downMbps: 1_000, upMbps: 1_000, price: 75, popularity: 0.8 },
  { id: 'fiber2g', name: '2 Gig', downMbps: 2_000, upMbps: 2_000, price: 95, popularity: 0.35 },
];
export const TIER_PRICE_MIN = 20;
export const TIER_PRICE_MAX = 300;
export const SMB_MULTIPLIER_DEFAULT = 1.5;
export const SMB_MULTIPLIER_MIN = 1;
export const SMB_MULTIPLIER_MAX = 4;

/** The incumbent cable company's typical offer that every tier is compared with. */
export const INCUMBENT_PRICE = 75;
export const INCUMBENT_DOWN_MBPS = 300;
export const INCUMBENT_UP_MBPS = 20;

// ---------------------------------------------------------------------------
// Take-rate model (sales.ts). Arithmetic only, no Math.pow/log/exp, so every
// JS engine replays the same game.
//
//   value(t)  = TAKE_SPEED_WEIGHT  x min(down_t / INCUMBENT_DOWN_MBPS, TAKE_SPEED_RATIO_CAP)
//             + TAKE_UPLOAD_WEIGHT x min(up_t / INCUMBENT_UP_MBPS, TAKE_UPLOAD_RATIO_CAP)
//             - TAKE_PRICE_WEIGHT  x price_t / INCUMBENT_PRICE
//   incumbent = TAKE_SPEED_WEIGHT + TAKE_UPLOAD_WEIGHT - TAKE_PRICE_WEIGHT
//   advantage = max over offered tiers of value(t) - incumbent
//   target    = clamp(TAKE_RATE_BASE + TAKE_RATE_PER_ADVANTAGE x advantage, TAKE_RATE_MIN, TAKE_RATE_MAX)
//               x TAKE_RATE_KIND_FACTOR[kind]
// Businesses value a tier at the price they pay against the incumbent's
// business price (INCUMBENT_PRICE x SMB_MULTIPLIER_DEFAULT): their price term
// is multiplied by smbMultiplier / SMB_MULTIPLIER_DEFAULT (1 at the default).
// At the default prices the best tier (1 Gig) is worth 0.65 over the cable
// offer: a 55% target for homes (round 4: base 0.31 -> 0.356, per advantage
// 0.25 -> 0.3; was 49%). Every 10% on all prices costs ~3 points of target
// take; churn (below) does the rest of keeping the defaults the best price.
// TAKE_RATE_MAX 0.6 -> 0.7 leaves a faster tier at the slower tier's price
// above a slower one (only a price far below the defaults reaches it).
// ---------------------------------------------------------------------------

export const TAKE_SPEED_WEIGHT = 0.2;
export const TAKE_SPEED_RATIO_CAP = 4;
export const TAKE_UPLOAD_WEIGHT = 0.02;
export const TAKE_UPLOAD_RATIO_CAP = 10;
export const TAKE_PRICE_WEIGHT = 1;
export const TAKE_RATE_BASE = 0.356;
export const TAKE_RATE_PER_ADVANTAGE = 0.3;
export const TAKE_RATE_MIN = 0.03;
export const TAKE_RATE_MAX = 0.7;
/** Target take rate multiplier by building kind. */
export const TAKE_RATE_KIND_FACTOR: Readonly<Record<ParcelKind, number>> = { home: 1, mdu: 0.8, smb: 0.6 };

// Round 4c/4d: the signup ramp (round 4b's SIGNUP_RAMP_PER_DAY x (1 +
// marketing boost)) is retired: how fast a lit street's households switch is
// customers.ts's (SWITCH_* and AWARENESS_* below).

// ---------------------------------------------------------------------------
// Marketing
// ---------------------------------------------------------------------------

/**
 * Round 4c/4d tuning: 1,000 -> 500. Marketing now raises awareness with
 * diminishing returns per passing, and a new company's first area is small:
 * at $1,000 a Shoestring network's first months of marketing cost more than
 * the awareness was worth, and the advisor found no first build that paid
 * its way on one tuning town. Lit streets still learn of you from time and
 * word of mouth (AWARENESS_BASE_PER_DAY, AWARENESS_WOM_PER_DAY).
 */
export const MARKETING_DEFAULT_PER_MONTH = 500;
export const MARKETING_MAX_PER_MONTH = 100_000;
// Round 4c/4d: marketing raises awareness, with diminishing returns
// (AWARENESS_MARKETING_MAX_PER_DAY, AWARENESS_MARKETING_HALF_SAT_PER_PASSING
// below), in place of round 4b's boost to the signup ramp.

// ---------------------------------------------------------------------------
// Churn (at each month close, per subscribed unit)
// Round 4c/4d: a unit's regular churn is its happiness churn
// (customers.churnFromScore: CHURN_MONTHLY_BASE x clamp(1 - score, ...), up
// to CHURN_MONTHLY_MAX). Round 4's CHURN_PRICE_SENSITIVITY (10: 10% over the
// market's price doubles churn) lives on as the score's
// HAPPINESS_PER_PRICE_OVER_MARKET below, so a player who prices above the
// defaults still loses subscribers month after month, on top of the one-off
// step when a price lock ends.
// ---------------------------------------------------------------------------

export const CHURN_MONTHLY_BASE = 0.011;
export const CHURN_MONTHLY_MAX = 0.2;

// ---------------------------------------------------------------------------
// Connections (connect capex, paid the day a unit connects)
// ---------------------------------------------------------------------------

/** Drop + ONT + install for a single-family home. */
export const INSTALL_COST_HOME = 700;
/** Drop + ONT + install for a small business. */
export const INSTALL_COST_SMB = 1_100;
/** One-time fiber-to-demarc + building router, paid with an MDU's first subscribing unit. */
export const MDU_ROUTER_COST = 5_000;
/** Per subscribing MDU apartment (in-building wiring + ONT/port). */
export const INSTALL_COST_MDU_UNIT = 250;
/**
 * Splitter ports one apartment building (MDU) account occupies, however many of
 * its units subscribe: fiber runs to the building demarc and the building router
 * distributes to the units (round-2 product decision: one port per building).
 */
export const MDU_PORTS_PER_BUILDING = 1;

// ---------------------------------------------------------------------------
// Operating costs
// ---------------------------------------------------------------------------

// Round 4c/4d: round 4b's flat OVERHEAD_PER_MONTH ($9,000) and
// SUPPORT_COST_PER_SUB_PER_MONTH are replaced by the scaled overhead (a base,
// per customer with the support level, per unit of plant: "Scaled overhead"
// below, applied by overhead.ts).

// ---------------------------------------------------------------------------
// Insolvency and notices
// ---------------------------------------------------------------------------

/**
 * The game ends at the month close that makes this many consecutive closes end
 * with cash < 0. Every earlier negative close posts an 'insolvencyWarning'.
 */
export const INSOLVENCY_GRACE_MONTHS = 3;
/** Notices kept in GameState.notices (oldest dropped first). */
export const NOTICE_LOG_MAX = 50;

// ---------------------------------------------------------------------------
// Financing (round 3: debt.ts). Tuned by the headless bots (tuning/): the
// architect's starting values held every target, so none moved (see DESIGN.md,
// "Financing"). What they produce on the tuning seeds: a careful borrower
// (SMART) carries leverage ~3x and coverage ~1.5x at ~7.0% (7-year loans
// priced at 3-4x leverage), passes 54-64% of the town by month 60 (27-34%
// without loans) and never breaches; borrowing every dollar offered (3.5x ARR,
// ~10x leverage on the cash-flow floor) goes warning, penalty, frozen and
// defaults around month 10; a red-CPP rural borrower pays ~9.4-10%.
//
// Rates are whole basis points (100 bps = 1% a year). Money is whole dollars.
// Borrowing capacity is a multiple of ARR, the annualized revenue of the
// trailing ARR_TRAILING_MONTHS closed months. The rate of new debt is
//   BASE_RATE_BPS + leverage spread (LEVERAGE_SPREAD_BANDS) + CPP spread
//   (CPP_SPREAD_BPS by the band of lifetime cost per passing) + product
//   adjustment (CREDIT_LINE_EXTRA_BPS / TERM_EXTRA_BPS),
// and every balance pays PENALTY_STEP_UP_BPS more while the covenant stage is
// 'penalty' or 'frozen'. Covenants (max leverage, min debt-service coverage)
// are tested at each month close against the underwriting cash flow:
//   max(annual operating cash flow, ARR x UNDERWRITING_MIN_MARGIN).
// ---------------------------------------------------------------------------

/** Closed months whose revenue and operating cash flow are annualized (x 12 / this). Must divide 12. */
export const ARR_TRAILING_MONTHS = 3;
/** Credit limits and term capacity are rounded down to a multiple of this many dollars. */
export const LOAN_ROUNDING = 1_000;

/** Base annual rate of all debt. */
export const BASE_RATE_BPS = 500;
/** The revolving credit line's product adjustment over a term loan's base pricing. */
export const CREDIT_LINE_EXTRA_BPS = 100;
/** Term-loan terms on offer, in years (the TermYears type lists the same values). */
export const TERM_LOAN_YEARS: readonly TermYears[] = [5, 7];
/** Term-loan product adjustment by term: a longer loan costs a little more. */
export const TERM_EXTRA_BPS: Readonly<Record<TermYears, number>> = { 5: 0, 7: 50 };

/**
 * Leverage spread: the first band whose maxLeverage is >= the leverage
 * (debt / underwriting cash flow) gives spreadBps; above the last band, or
 * when leverage is unmeasurable (debt with no cash flow), LEVERAGE_SPREAD_MAX_BPS.
 * Ascending maxLeverage. Term loans are priced on pro forma leverage (with the
 * new loan); the credit line on leverage at the close that re-priced it.
 */
export const LEVERAGE_SPREAD_BANDS: readonly { maxLeverage: number; spreadBps: number }[] = [
  { maxLeverage: 2, spreadBps: 0 },
  { maxLeverage: 3, spreadBps: 75 },
  { maxLeverage: 4, spreadBps: 150 },
  { maxLeverage: 5, spreadBps: 250 },
];
export const LEVERAGE_SPREAD_MAX_BPS = 400;

/** Spread by the band of lifetime cost per passing (metrics.cppBand); none while nothing is passed. Efficient builds get cheaper money. */
export const CPP_SPREAD_BPS: Readonly<Record<CppBand, number>> = { green: 0, amber: 100, red: 250 };

/** Surcharge on every balance while the covenant stage is 'penalty' or 'frozen'. */
export const PENALTY_STEP_UP_BPS = 300;

/** Credit-line limit = ARR x this (rounded down to LOAN_ROUNDING). */
export const CREDIT_LIMIT_ARR_MULTIPLE = 0.5;
/** Term-loan capacity = ARR x this, less the term loans already owed (rounded down to LOAN_ROUNDING). */
export const TERM_CAPACITY_ARR_MULTIPLE = 3;
/** Smallest term loan. */
export const TERM_LOAN_MIN = 10_000;

/**
 * Share of ARR the lender counts as cash flow when annual operating cash flow
 * is lower (a young network is underwritten on its recurring revenue). Keeps
 * leverage and coverage finite and meaningful while operating cash flow is
 * <= 0 or small; with no revenue and no positive cash flow, debt is unmeasurable (a breach).
 */
export const UNDERWRITING_MIN_MARGIN = 0.35;

/** Covenant: total debt / underwriting cash flow at most this at every close. */
export const COVENANT_MAX_LEVERAGE = 5;
/** Covenant: underwriting cash flow / annual debt service at least this at every close (when anything is scheduled). */
export const COVENANT_MIN_COVERAGE = 1.2;
/** Compliant closes in a row that step the covenant stage down one level. */
export const COVENANT_CURE_CLOSES = 2;

/** Late fee for a missed payment: max(LATE_FEE_MIN, round(missed debt service x LATE_FEE_SHARE)). */
export const LATE_FEE_MIN = 1_000;
export const LATE_FEE_SHARE = 0.05;
/**
 * A 'paymentDue' notice is posted this many days before a close when the cash
 * that close will have at its debt step (finance.estimateCashAtClose: today's
 * cash plus the month's billing, less its running costs and installs) is
 * below the debt service it will charge.
 */
export const PAYMENT_REMINDER_DAYS = 5;

/** Bank panel: fixed credit-line draw presets in whole dollars (the panel adds "Half" and "All" of what is available). */
export const DRAW_PRESETS: readonly number[] = [10_000, 25_000];

// ---------------------------------------------------------------------------
// Round 4. Every rule these feed is documented in the module that applies it.
// Tuned by the headless bots (tuning/targets4.test.ts, DESIGN.md "Round 4
// tuning"): the integrator's ARR_SPIKE_CAP, INCUMBENT_PROMO_TAKE_RATE and storm
// radius held; storms come a little more often, damage aerial spans a little
// more, and a repair costs mostly the crew's call-out (so short aerial blocks
// are the dearest to keep per foot); an outage costs more subscribers. With
// pole rent (above) that makes underground pay on the short blocks and aerial
// on the long ones. Repairs cost a careful operator ~2.5% of revenue (100 seeds;
// an all-aerial one ~3.1%).
// ---------------------------------------------------------------------------

// Loan polish (debt.ts) ------------------------------------------------------

/**
 * Smoothed ARR (debt.trailingArr): the trailing months' mean revenue counts
 * for at most this multiple of the lowest of those months, so a one-month
 * price spike cannot inflate borrowing capacity (honest growth of a few
 * percent a month is untouched).
 */
export const ARR_SPIKE_CAP = 1.5; // first guess 1.1 also capped honest ramp-up growth
/** While frozen, each close sweeps this share of the month's positive operating cash flow to repay debt. */
export const FROZEN_SWEEP_SHARE = 0.5;
/** ...but never takes cash below this reserve. */
export const FROZEN_SWEEP_RESERVE = 25_000;
/** Consecutive frozen closes after which the bank calls the loans (acceleration). */
export const FROZEN_ACCELERATION_CLOSES = 6;
/** Closes over which everything owed falls due once the loans are called. */
export const ACCELERATION_CLOSES = 3;
/** A frozen close with this many or fewer closes left before the call posts an 'accelerationWarning'. */
export const ACCELERATION_WARNING_CLOSES = 2;
/** Funding hints and cure advice keep this many months of fixed costs (overhead + marketing) in cash, beyond the next debt service. */
export const FUNDING_CUSHION_MONTHS = 1;

// Pricing realism (sales.ts, incumbent.ts) ------------------------------------

/** Month closes a price rise waits before it reaches today's subscribers, when setPricing does not say. */
export const GRANDFATHER_MONTHS_DEFAULT = 6;
/** Most month closes setPricing may grandfather a rise for. */
export const GRANDFATHER_MONTHS_MAX = 24;
/**
 * One-off churn when a unit's price steps up at a close (a lock ending):
 * p = min(PRICE_STEP_CHURN_MAX, PRICE_STEP_CHURN_PER_RISE x rise / old price x share),
 * share by the lock's reason: 1 for 'notice' (a rise passed on at the next
 * bill, grandfatherMonths 0), GRANDFATHER_STEP_SHARE for 'grandfather',
 * PROMO_STEP_SHARE for 'promo' (an intro promo ending).
 */
export const PRICE_STEP_CHURN_PER_RISE = 0.4;
export const PRICE_STEP_CHURN_MAX = 0.5;
export const GRANDFATHER_STEP_SHARE = 0.5;
export const PROMO_STEP_SHARE = 0.5;
/**
 * A tier no longer offered: at the next close each of its units moves to the
 * offered tier nearest in price (ties: the cheaper) or cancels, with
 * p = min(TIER_RETIRE_CHURN_MAX, TIER_RETIRE_CHURN_BASE + TIER_RETIRE_CHURN_PER_RISE x max(0, new / old - 1)).
 */
export const TIER_RETIRE_CHURN_BASE = 0.05;
export const TIER_RETIRE_CHURN_PER_RISE = 0.6;
export const TIER_RETIRE_CHURN_MAX = 0.6;
/** Intro promo limits (setPromo). */
export const PROMO_MAX_PERCENT_OFF = 50;
export const PROMO_MAX_MONTHS = 12;
/**
 * The take-rate model values an intro promo as its discount spread over this
 * many months of service (percentOff x min(months, horizon) / horizon off the
 * price a new signup weighs).
 */
export const PROMO_HORIZON_MONTHS = 24;
/**
 * The incumbent answers when your take rate in a cabinet area reaches this ...
 * Round 4b: 0.45 -> 0.5, above where a careful operator's areas settle (the
 * median area of SMART's at month 60 sits at ~43%), so a promo answers an
 * area that is doing unusually well (an apartment block, a dense corner, or
 * prices pushed down) rather than every mature one; with the per-area memory
 * (INCUMBENT_PROMO_RETRIGGER_POINTS) no area meets more than two in five years.
 * (Round 4's first guess 0.35 sat under the default target take rate: promos
 * ran nearly everywhere.)
 */
export const INCUMBENT_PROMO_TAKE_RATE = 0.5;
/** ... on at least this many passings there. */
export const INCUMBENT_PROMO_MIN_PASSINGS = 100;
/** Dollars a month the incumbent's promo price is below INCUMBENT_PRICE. */
export const INCUMBENT_PROMO_DISCOUNT = 20;
/** Month closes an incumbent promo runs, and the quiet months after it before another can start there. */
export const INCUMBENT_PROMO_MONTHS = 6;
export const INCUMBENT_PROMO_QUIET_MONTHS = 6;
/**
 * Monthly churn probability added for subscribers in an area while the
 * incumbent's promo runs there. Round 4b: 0.01 -> 0.03: ignoring a promo now
 * costs about a sixth of the area's subscribers over its six months, so
 * answering it matters (at 1% no answer beat ignoring it by more than the
 * game's own noise).
 */
export const INCUMBENT_PROMO_CHURN = 0.03;
/**
 * The most a unit's total churn probability at a close may be (regular +
 * price step + outage + incumbent), so a bad month never empties a network
 * on one close. Each component's share of a capped total shrinks in
 * proportion (sales.totalChurn).
 */
export const CHURN_TOTAL_MAX = 0.8;

// Storms, dig-ins and conversions (weather.ts, network.ts) --------------------

/** No storms or dig-ins before this day (the first year is for building). */
export const STORM_START_DAY = 365;
/** Chance a storm hits on any day from STORM_START_DAY (round 4: 1/60 -> 1/50, about 7 a year; round 4c/4d: 1/50 -> 1/55 with the canopy term, below, putting the damage where the trees are). */
export const STORM_CHANCE_PER_DAY = 1 / 55;
/** Radius of the area a storm hits, map cells. */
export const STORM_RADIUS_MIN = 5; // first guess 8
export const STORM_RADIUS_MAX = 15; // first guess 30: a storm covered up to half a 96x64 town, ~9% of revenue in repairs for all-aerial play
/** Storm severity 1..this (uniform), scaling the damage chances. */
export const STORM_SEVERITY_MAX = 3;
/**
 * Chance per unit of severity that a storm damages a live span in its area: aerial (round 4: 0.06 -> 0.07; ~0.06 outages a span-year).
 * Round 4c/4d tuning: 0.07 -> 0.04, as STORM_EXPOSURE_CANOPY concentrates the damage on tree-lined streets: open aerial
 * streets now see fewer outages, tree-lined ones several times more, and repairs stay a few percent of revenue ...
 */
export const STORM_AERIAL_DAMAGE_CHANCE = 0.04;
/** ... and underground (washouts; rare). */
export const STORM_UNDERGROUND_DAMAGE_CHANCE = 0.002;
/** Dig-ins a year per mile (5,280 ft) of live underground cable. */
export const DIG_INS_PER_MILE_PER_YEAR = 0.15;
/** Days a damaged span is out of service (uniform): aerial ... */
export const OUTAGE_DAYS_AERIAL_MIN = 2;
export const OUTAGE_DAYS_AERIAL_MAX = 6;
/** ... and underground (digging to the break takes longer). */
export const OUTAGE_DAYS_UNDERGROUND_MIN = 4;
export const OUTAGE_DAYS_UNDERGROUND_MAX = 12;
/**
 * Repair cost of a damaged span: base + per ft of the span, by method. Round
 * 4: aerial per ft 3 -> 1, so an aerial repair is mostly the crew's call-out
 * (a short block costs nearly as much to fix as a long one).
 */
export const REPAIR_BASE_AERIAL = 1_200;
export const REPAIR_PER_FT_AERIAL = 1;
/** Round 4c/4d tuning: 4,000 -> 3,000, so a dig-in on buried plant does not cost as much as the storms burying saves (spec D: burying exposed streets pays back). */
export const REPAIR_BASE_UNDERGROUND = 3_000;
export const REPAIR_PER_FT_UNDERGROUND = 1;
/**
 * Extra churn for a subscribed unit one outage cut off d days (its own days
 * without service, charged at the closes they fall before; an outage over a
 * close pays the base once, weather.outageChurnFor):
 * min(OUTAGE_CHURN_MAX, OUTAGE_CHURN_BASE + OUTAGE_CHURN_PER_DAY x d), 0 when d is 0.
 * Round 4: 0.01 + 0.004/day (max 0.1) -> 0.05 + 0.01/day (max 0.25): about
 * one in eleven subscribers cut off for an average aerial outage leaves.
 */
export const OUTAGE_CHURN_BASE = 0.05;
export const OUTAGE_CHURN_PER_DAY = 0.01;
export const OUTAGE_CHURN_MAX = 0.25;
/** Storms are kept in Weather.storms this long (the advisor's storm-prone test looks back as far). */
export const STORM_LOG_DAYS = 730;
/** The map shows a storm's area this many days after it hit. */
export const STORM_SHOW_DAYS = 10;

// Advisor (advisor.ts) ----------------------------------------------------------

/** stormUnderground: repairs on an aerial span of at least this share of rebuilding it underground make it storm-prone (as do STORM_HITS_MIN hits). */
export const STORM_REPAIRS_CONVERT_SHARE = 0.5;
/** stormUnderground: a rebuild is suggested when what it saves a year (repairs avoided + pole rent) pays for it within this many years. */
export const CONVERT_PAYBACK_YEARS = 10;
/** takeRate: marketing below this many dollars per passing a month counts as under-marketed (the signup model's "about $2 per passing"). */
export const MARKETING_PER_PASSING_GOOD = 2;
/** expand: months of fixed costs (overhead + marketing) kept in reserve on top of the funding cushion. */
export const EXPAND_RESERVE_MONTHS = 3;

// ---------------------------------------------------------------------------
// Round 4b (start screen and difficulty: above, with START_CASH; the rest
// fixes round 4's design gaps). The architect's and integrator's values, as
// the round-4b tuning moved them (tuning/targets4b.test.ts, DESIGN.md "Round
// 4b"): the incumbent's trigger, promo churn and retention offer, and the
// storm exposure's industrial zone, center weight and bands moved; the rest
// held. Rules that are not balance (lengths, caps) live in their modules.
// ---------------------------------------------------------------------------

// Advisor (advisor.ts) ----------------------------------------------------------

/** snoozeAdvice: month closes a dismissed suggestion stays hidden (it shows again at the close this many closes on). */
export const ADVICE_SNOOZE_MONTHS = 3;
/** ... and for an urgent one (it comes back at the next close unless dealt with). */
export const ADVICE_SNOOZE_URGENT_MONTHS = 1;
/**
 * expand: a financed build must leave the covenants this far inside their
 * limits pro forma (leverage at most COVENANT_MAX_LEVERAGE x (1 - this),
 * coverage at least COVENANT_MIN_COVERAGE x (1 + this); debt.covenantsWithin),
 * so following the advice never brings the advisor's own covenant-risk warning.
 */
export const EXPAND_COVENANT_HEADROOM = 0.15;
/** expand: months of the new area's expected installs (connect capex) kept in reserve on top of EXPAND_RESERVE_MONTHS of running costs. */
export const EXPAND_INSTALL_MONTHS = 6;
/** Bank: the term-loan builder starts at the largest loan this far inside the covenant limits (debt.maxSafeTermLoan headroom), not exactly on them. */
export const BANK_PREFILL_HEADROOM = 0.15;

// Pricing: demand segments (sales.ts) -----------------------------------------------

/** One slice of households by price sensitivity (see DEMAND_SEGMENTS). */
export interface DemandSegment {
  id: DemandSegmentId;
  /** Share of households; the shares sum to 1. */
  share: number;
  /** Speed beyond this many Mbps adds nothing for them (their speed term uses min(down, this)). */
  maxUsefulMbps: number;
  /** Multiplies TAKE_PRICE_WEIGHT for them (price sensitivity), for your tiers and the incumbent alike. */
  priceWeight: number;
  /**
   * Most they will pay, as a multiple of the incumbent's price where they
   * live (incumbent.incumbentPriceFor): a tier above it does not suit them
   * (within DEMAND_RESERVATION_SOFTNESS above it, less and less), and with no
   * tier that suits them they do not sign up.
   */
  maxPriceRatio: number;
}

/**
 * Round 4b: households in three price-sensitivity segments, so dropping the
 * cheap tiers is not dominant (round 4's single model let a 2 Gig-only
 * lineup keep ~93% of the default target take rate at a far higher ARPU).
 * The target take rate of a building kind becomes
 *   sum over segments of share x clamp(TAKE_RATE_BASE + TAKE_RATE_PER_ADVANTAGE
 *     x best advantage among the offered tiers that suit the segment,
 *     TAKE_RATE_MIN, TAKE_RATE_MAX) (0 for a segment no tier suits)
 *   x TAKE_RATE_KIND_FACTOR[kind],
 * each segment valuing tiers with its own maxUsefulMbps and priceWeight
 * against the incumbent scored the same way; the tier mix sums the segments'
 * mixes weighted by share x their take. Interim values keep the default
 * lineup where round 4 had it, ~56% of homes at ~$69 (round 4: 55% at ~$72:
 * within ~1.5% of its revenue per household, which every round-2..4 target was
 * tuned on), while value seekers drop out of a lineup without a tier near the
 * incumbent's price: a 2 Gig-only lineup signs up ~31% (a fifth less revenue
 * per household than the default lineup) and 1 Gig + 2 Gig ~44%.
 * (Integrator, round 4b: the architect's first values, value 35% /
 * mainstream 45% / speed 20% with price weights 1.5 / 1 / 0.6, kept the take
 * rate but moved signups to 500 Mbps, cutting revenue per household ~6% and
 * SMART's share of the town at month 60 by ~10 points.)
 */
export const DEMAND_SEGMENTS: readonly DemandSegment[] = [
  { id: 'value', share: 0.25, maxUsefulMbps: 500, priceWeight: 2.5, maxPriceRatio: 0.9 },
  { id: 'mainstream', share: 0.45, maxUsefulMbps: 1_000, priceWeight: 0.6, maxPriceRatio: 1.2 },
  { id: 'speed', share: 0.3, maxUsefulMbps: 2_000, priceWeight: 0.55, maxPriceRatio: 2 },
];
/**
 * A tier priced above a segment's reservation (maxPriceRatio x the
 * incumbent's price) by a share s of it still suits that segment with
 * weight max(0, 1 - s / this): no cliff when every price rises a little.
 */
export const DEMAND_RESERVATION_SOFTNESS = 0.15;

// Pricing: the incumbent and the levers that answer it (incumbent.ts, sales.ts)

/**
 * The incumbent promo trigger (INCUMBENT_PROMO_TAKE_RATE, round 4) must sit
 * above the steady-state take rate a careful operator reaches; and once a
 * promo has run in an area, the next one there needs the area's take rate
 * this many points (a fraction) above the one that started the last
 * (IncumbentPromo.triggerTakePct), so a mature area never cycles forever.
 * Round 4c/4d tuning: 0.05 -> 0.07. Happy customers' word of mouth keeps an
 * area growing past where round 4b's settled, so a mature area needs a
 * larger step before the next promo (the target: at most two per area in
 * five years).
 */
export const INCUMBENT_PROMO_RETRIGGER_POINTS = 0.07;
/**
 * answerIncumbent: whole percent off the list price for the area's
 * subscribers until the promo ends. Round 4b tuning: 15 -> 12, with
 * INCUMBENT_PROMO_CHURN 0.03, so the offer pays over a promo's months (it
 * keeps about half the cancellations a promo causes, for less than they are
 * worth) but not in its last month (RETENTION_STEP_SHARE).
 */
export const RETENTION_PERCENT_OFF = 12;
/**
 * Churn share of the price step when a retention lock ends (as
 * GRANDFATHER_STEP_SHARE / PROMO_STEP_SHARE). Round 4b tuning: 0.25 -> 1 (the
 * discount ends like a rise passed on at the next bill), so a retention offer
 * made with a close or two left costs more at its end than it saves.
 */
export const RETENTION_STEP_SHARE = 1;
/**
 * While an intro promo is set, the signup ramp is multiplied by
 * 1 + PROMO_SIGNUP_BOOST x percentOff / 100 (households switch sooner for a
 * deal): worth most where many homes have not signed up yet (a freshly lit
 * area, or one the incumbent is contesting). Round 4b tuning: kept at 2,
 * where SMART's 20% off for 3 months pays in a freshly lit area (quoted and
 * realized). It pays in a mature town too: the boost speeds every street's
 * gap alike, and churn keeps a mature town's gap about as large per signup as
 * a fresh one's; no value of it, PROMO_HORIZON_MONTHS or PROMO_QUOTE_MONTHS
 * separates the two (DESIGN.md, "What round 4b could not reach"). Round 4c
 * made the boost act on young streets only (PROMO_BOOST_YOUNG_MONTHS), which
 * separates them. Round 4c/4d tuning: 2 -> 2.5, so the promo still pays
 * against the slower switching (SWITCH_BASE_PER_DAY) in a freshly lit area,
 * quoted and realized.
 */
export const PROMO_SIGNUP_BOOST = 2.5;
/** sales.quotePromo: months its estimate looks ahead. */
export const PROMO_QUOTE_MONTHS = 12;

// Storm exposure (weather.ts) ---------------------------------------------------

/**
 * Round 4b: storms favour exposed streets. A street's exposure
 * (weather.segmentExposure, a multiplier with mean ~1 over a generated
 * town) is STORM_EXPOSURE_ZONE[its zone] x (1 + STORM_EXPOSURE_WOODED x how
 * wooded it is, 0..1: the grove field the map's trees are drawn from) x
 * (1 + STORM_EXPOSURE_EDGE near the map's edge, fading to 0 at
 * STORM_EXPOSURE_EDGE_CELLS cells in), deterministic from the city. It scales
 * the storm damage chance on the street, and where storms center
 * (STORM_CENTER_EXPOSURE_WEIGHT). Residential streets, most of every town and
 * of a careful operator's plant, rate 1 so a typical one keeps round 4's
 * aerial storm risk (integrator, round 4b: at the architect's 0.9 they fell to
 * ~0.8x of it, since storms center toward the exposed edges, and burying
 * stopped paying on the short residential blocks). Round 4b tuning:
 * industrial 0.9 -> 0.7 (yards and low sheds, few trees near the lines), so
 * downtown and the industrial blocks make the 'sheltered' band at least a
 * tenth of every tuning town (the overlay's three bands each mean something).
 */
export const STORM_EXPOSURE_ZONE: Readonly<Record<Zone, number>> = { downtown: 0.6, residential: 1, industrial: 0.7, rural: 1.5 };
/** (Integrator, round 4b: 0.6, was the architect's 0.8, so residential at 1 keeps the town's mean exposure about 1.) */
export const STORM_EXPOSURE_WOODED = 0.6;
export const STORM_EXPOSURE_EDGE = 0.5;
export const STORM_EXPOSURE_EDGE_CELLS = 10;
/**
 * Storm centers are drawn with weight 1 + this x (exposure there - 1) (0:
 * uniform, as round 4). Round 4b tuning: 1 -> 1.25, so storms lean a little
 * more toward the exposed edges and groves than toward the town (exposed
 * streets take 3-4x a sheltered street's damage per span-year), which keeps
 * an all-aerial copy of SMART clearly more exposed than its mix.
 */
export const STORM_CENTER_EXPOSURE_WEIGHT = 1.25;
/** Cells around a lattice point whose streets set how exposed it is for drawing storm centers (weather.pointExposure). */
export const STORM_CENTER_REACH_CELLS = 6;
/** Feet of street at the town's mean exposure every lattice point counts besides its own streets (open country rates as an average street). */
export const STORM_CENTER_OPEN_FT = 360;
/**
 * Exposure bands for the overlay, quote cards and the advisor: 'moderate'
 * from this exposure (a plain residential street, exactly the residential
 * zone's 1) ... Round 4b tuning: 0.85 -> 1 and 1.3 -> 1.2, so each band holds
 * 10-70% of a tuning town's street feet (sheltered 10-17%, moderate 62-69%,
 * exposed 16-24%; at 0.85 / 1.3 the sheltered band was 7-12% and the
 * moderate one 70-78%). Labels only: no rule reads the bands but the
 * overlay, the quote and span cards and the advisor's storm suggestion.
 */
export const STORM_EXPOSURE_MODERATE = 1;
/** ... and 'exposed' from this one ('sheltered' below 'moderate'): a residential street with trees or near the map's edge, a rural one. */
export const STORM_EXPOSURE_EXPOSED = 1.2;
/**
 * weather.preferredMethod: years of ownership over which a street's method
 * is judged (construction, make-ready and fees, pole rent, expected storm
 * repairs), as SMART's lifetime method choice does (tuning VALUE_YEARS).
 */
export const BUILD_METHOD_HORIZON_YEARS = 12;

// ---------------------------------------------------------------------------
// Round 4c/4d (contract; first guesses, the round-4cd tuner owns the values).
// Owner decisions 2026-10-22: overhead scales with company size (difficulty
// still differs ONLY in starting cash); realistic switching (40-55% of homes
// over 3-5 years of a lit street, a better deal mostly speeds that up);
// levers: neighborhood campaigns, support level, referral credits; the three
// tiers stay. Every rule these feed is documented in the module that applies
// it: overhead.ts (overhead), customers.ts (switching, awareness, happiness,
// the levers and their quotes), sales.ts (signups and churn use them).
// ---------------------------------------------------------------------------

// Scaled overhead (overhead.ts) ----------------------------------------------

/**
 * The part of the monthly overhead that does not grow with the business:
 * office, billing system, insurance, the founders' pay. Replaces the flat
 * OVERHEAD_PER_MONTH (round 4b's $9,000, which a small network could never
 * cover: DESIGN.md "What round 4b could not reach"). Round 4c/4d tuning:
 * the integrator's 2,000 -> 2,500 with the per-customer cost below, which
 * puts the Seed round's first positive month at about 12-13 (spec A's 12-15)
 * while Shoestring stays winnable.
 */
export const OVERHEAD_BASE_PER_MONTH = 2_500;
/**
 * Per subscribed unit per month, besides support (billing, network
 * operations, customer accounts). The month's per-customer line is
 * (this + the support level's SUPPORT_LEVELS cost) x subscriber-days / days
 * in the month. Round 4c/4d tuning: 2 -> 8. A customer's running cost is
 * what makes a cheaper lineup a real trade-off: at $2 (with Good support's
 * $4) a lineup 17% below the defaults earned nearly as much per customer and
 * signed many more, so it dominated on 5-year value; at $8 neither
 * dominates (spec I.7). It also slows the Seed round's break-even toward
 * spec A's band now that the base is small.
 */
export const OVERHEAD_PER_CUSTOMER_PER_MONTH = 8;
/** Per live cabinet per month (power, cooling, inspections, truck rolls): part of the per-plant line. */
export const OVERHEAD_PER_CABINET_PER_MONTH = 200;
/** Per route-mile (5,280 ft) of live cable per month (locates, patrols, plant records): the rest of the per-plant line. */
export const OVERHEAD_PER_MILE_PER_MONTH = 100;

// Support level (customers.ts, overhead.ts) -------------------------------------

/** One support level (SUPPORT_LEVELS). */
export interface SupportLevelSpec {
  id: SupportLevel;
  /** Display name: "Basic", "Good", "Great". */
  name: string;
  /** Support cost per subscribed unit per month (in the per-customer overhead line). */
  costPerSub: number;
  /** Happiness score it adds to every customer (customers.ts: 0 at Good, negative at Basic, positive at Great). */
  happiness: number;
}

/**
 * Basic / Good (default, round 4b's $4) / Great. Round 4c/4d tuning: Great
 * $7 / +0.3 -> $6 / +0.6, so Great pays where outages keep customers
 * unhappy (high exposure, long horizons) and not where they are rare (spec
 * I.7); at +0.3 it never lifted a customer out of an outage's unhappiness
 * and never paid.
 */
export const SUPPORT_LEVELS: Readonly<Record<SupportLevel, SupportLevelSpec>> = {
  basic: { id: 'basic', name: 'Basic', costPerSub: 2, happiness: -0.4 },
  good: { id: 'good', name: 'Good', costPerSub: 4, happiness: 0 },
  great: { id: 'great', name: 'Great', costPerSub: 6, happiness: 0.6 },
};
/** The support level a new game (and every older save) starts with. */
export const DEFAULT_SUPPORT_LEVEL: SupportLevel = 'good';

// Switching (customers.ts; sales.stepSales applies it) -----------------------------

/**
 * Daily share of a lit street's aware households inside its target (the
 * gap) that switch, at the default lineup's deal (dealFactor 1), before word
 * of mouth, campaigns and the intro promo. Round 4b's ramp was 1/550 x (1 +
 * marketing boost) on the whole gap. Round 4c/4d tuning: 1/450 -> 1/525:
 * with happy customers' word of mouth (HAPPY_SCORE_MIN) streets filled too
 * fast (the Seed round broke even around month 10 and passed ~70% of the
 * town); at 1/525 SMART's areas lit 3-5 years sit at 40-55% take.
 */
export const SWITCH_BASE_PER_DAY = 1 / 525;
/**
 * dealFactor = clamp(1 + SWITCH_PER_ADVANTAGE x (deal advantage - the
 * default lineup's), SWITCH_DEAL_MIN, SWITCH_DEAL_MAX): every 0.1 of
 * advantage over cable (customers.dealAdvantage, the take-weighted mean of
 * the demand segments' best advantage, the intro promo valued) above the
 * default lineup's speeds switching up by this x 10%.
 */
export const SWITCH_PER_ADVANTAGE = 3;
export const SWITCH_DEAL_MIN = 0.2;
export const SWITCH_DEAL_MAX = 3;
/** Switching on a street speeds up by this x the share of its customers who are happy (neighbors recommend you). */
export const SWITCH_WOM_BOOST = 0.5;

// Awareness (customers.ts) ----------------------------------------------------------

/** Share of a street's households that know you the day it is lit (the crews, the door hangers). */
export const AWARENESS_ON_LIT = 0.15;
/** Daily awareness gain from time alone (neighbors' installs, the trucks): a += (1 - a) x this. */
export const AWARENESS_BASE_PER_DAY = 1 / 300;
/**
 * Marketing's daily awareness gain on every lit street, with diminishing
 * returns: AWARENESS_MARKETING_MAX_PER_DAY x m / (m +
 * AWARENESS_MARKETING_HALF_SAT_PER_PASSING x max(1, passings)), m =
 * marketingPerMonth (half its maximum at that many dollars per passing a month).
 */
export const AWARENESS_MARKETING_MAX_PER_DAY = 1 / 60;
export const AWARENESS_MARKETING_HALF_SAT_PER_PASSING = 3;
/** Word of mouth: daily awareness gain on a street = this x the share of its customers who are happy (x REFERRAL_WOM_MULTIPLIER with referral credits on). */
export const AWARENESS_WOM_PER_DAY = 1 / 90;

// Neighborhood campaigns (customers.ts) -------------------------------------------

/**
 * A campaign costs this per lit unit not signed up in the cabinet's area when bought ... Round 4c/4d tuning: 12 -> 20 with
 * CAMPAIGN_SWITCH_BOOST 0.5 -> 1: a campaign pays in a freshly lit area (many unaware homes it reaches) and not in a
 * well-signed one (its few unsigned homes mostly not worth switching), quoted and realized (spec I.7).
 */
export const CAMPAIGN_COST_PER_UNIT = 20;
/** ... and at least this. */
export const CAMPAIGN_COST_MIN = 500;
/** Daily awareness gain in the area at full strength (a += (1 - a) x this x strength). */
export const CAMPAIGN_AWARENESS_PER_DAY = 1 / 25;
/** Days at full strength from the purchase ... */
export const CAMPAIGN_DAYS = 61;
/** ... then fading linearly to nothing over this many days (NeighborhoodCampaign.endDay = start + both). */
export const CAMPAIGN_FADE_DAYS = 61;
/** Switching in the area speeds up by this x the campaign's strength (door-to-door sales). Round 4c/4d tuning: 0.5 -> 1 (see CAMPAIGN_COST_PER_UNIT). */
export const CAMPAIGN_SWITCH_BOOST = 1;
/** No new campaign in an area until this many days after the last one there ended (NeighborhoodCampaign.cooldownUntil). */
export const CAMPAIGN_COOLDOWN_DAYS = 120;

// Referral credits (customers.ts) ---------------------------------------------------

/** Dollars off a month's bill for the referring customer and for the neighbor who joins: each referral signup costs 2 x this ('marketing'). */
export const REFERRAL_CREDIT = 25;
/** While referral credits are on, word of mouth (awareness and switching) is this many times as strong. */
export const REFERRAL_WOM_MULTIPLIER = 2;

// Happiness (customers.ts; sales churn reads it) ------------------------------------

/**
 * A customer's happiness score is the sum of its factors (0 for a customer
 * on Good support at the default prices with no recent trouble); its
 * regular churn is CHURN_MONTHLY_BASE x clamp(1 - score, HAPPY_CHURN_FLOOR,
 * CHURN_MONTHLY_MAX / CHURN_MONTHLY_BASE). Happy from HAPPY_SCORE_MIN up,
 * unhappy at UNHAPPY_SCORE_MAX or below, okay between. Round 4c/4d tuning:
 * HAPPY_SCORE_MIN 0.2 -> -0.2, so a customer on Good support at the default
 * prices with no recent trouble (score 0) is happy: at 0.2 nobody was happy
 * without Great support, word of mouth and referral credits did nothing,
 * and a lineup below the market (the good-deal bonus) was the only way to
 * make customers happy.
 */
export const HAPPY_SCORE_MIN = -0.2;
export const UNHAPPY_SCORE_MAX = -0.5;
/** The happiest customers still churn at this share of CHURN_MONTHLY_BASE. Round 4c/4d tuning: 0.5 -> 0.7, so Great support and a cheap lineup cannot halve churn (a cheaper lineup dominated). */
export const HAPPY_CHURN_FLOOR = 0.7;
/** Score lost per day without service in the recent past (outages within HAPPINESS_OUTAGE_MEMORY_DAYS of the last). */
export const HAPPINESS_PER_OUTAGE_DAY = 0.1;
/** Round 4c/4d tuning: 90 -> 180, so outages weigh on happiness long enough for support to matter where storms are frequent. */
export const HAPPINESS_OUTAGE_MEMORY_DAYS = 180;
/**
 * Score lost per share paid above the market's price for the tier
 * (TIER_DEFAULTS; a business: x SMB_MULTIPLIER_DEFAULT). Round 4b's
 * CHURN_PRICE_SENSITIVITY (10: 10% over the market doubles churn), moved
 * into the score.
 */
export const HAPPINESS_PER_PRICE_OVER_MARKET = 10;
/** Share above cable's price a customer at the default price pays where cable runs its promo ((INCUMBENT_PRICE - promo price) / promo price). */
const CABLE_PROMO_PRICE = Math.max(1, INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT);
const CABLE_PROMO_SHARE = (INCUMBENT_PRICE - CABLE_PROMO_PRICE) / CABLE_PROMO_PRICE;
/**
 * Share above cable's local price for that kind of plan that customers
 * accept without minding (fiber is worth that much more to them): derived,
 * the default retention offer's (RETENTION_PERCENT_OFF off the default
 * price) share above cable's promo price, so that offer answers an
 * incumbent promo in full, as round 4b's RETENTION_CHURN_CUT of 1 did. At
 * most three quarters of the promo's share, so an ignored promo always
 * costs something. About 0.2 at today's values.
 */
export const HAPPINESS_CABLE_PREMIUM_TOLERATED = Math.min(
  (CABLE_PROMO_SHARE * 3) / 4,
  Math.max(0, (INCUMBENT_PRICE * (1 - RETENTION_PERCENT_OFF / 100) - CABLE_PROMO_PRICE) / CABLE_PROMO_PRICE),
);
/**
 * Score lost per share paid above cable's local price for the same kind of
 * plan (incumbent.incumbentPriceFor x the tier's default price /
 * INCUMBENT_PRICE), beyond the share paid above the market price and the
 * premium customers accept (HAPPINESS_CABLE_PREMIUM_TOLERATED): an
 * incumbent promo makes your customers there unhappy. Calibrated, not
 * guessed: a customer paying the default price where the incumbent runs its
 * promo cancels exactly INCUMBENT_PROMO_CHURN a month more than elsewhere
 * (round 4b's ignored-promo churn), so that constant keeps its meaning.
 * About 16.7 at today's values (the first guess 1.5, with no premium
 * accepted, made an ignored promo cost a fifth of round 4b's and a retention
 * offer answer under half of it).
 */
export const HAPPINESS_PER_PRICE_OVER_CABLE =
  CHURN_MONTHLY_BASE > 0 && CABLE_PROMO_SHARE - HAPPINESS_CABLE_PREMIUM_TOLERATED > 0
    ? INCUMBENT_PROMO_CHURN / CHURN_MONTHLY_BASE / (CABLE_PROMO_SHARE - HAPPINESS_CABLE_PREMIUM_TOLERATED)
    : 0;
/**
 * Score gained per share paid below the market's price for the tier (a good deal), at most HAPPINESS_GOOD_DEAL_MAX.
 * Round 4c/4d tuning: 2 -> 0.25. At 2 a lineup 17% below the defaults made every customer much happier (lower churn,
 * stronger word of mouth) on top of faster switching, and dominated; a cheaper lineup now pays mostly through switching.
 */
export const HAPPINESS_PER_PRICE_UNDER_MARKET = 0.25;
export const HAPPINESS_GOOD_DEAL_MAX = 0.4;
/** Score lost for a price step-up (a lock ending with a rise, a move to a dearer tier) within the last HAPPINESS_PRICE_STEP_MEMORY_DAYS. */
export const HAPPINESS_PRICE_STEP = 0.5;
export const HAPPINESS_PRICE_STEP_MEMORY_DAYS = 120;
/** Score lost for a customer who waited to be connected (its cabinet full or installs paused), for HAPPINESS_WAIT_MEMORY_DAYS after connecting. */
export const HAPPINESS_INSTALL_WAIT = 0.3;
export const HAPPINESS_WAIT_MEMORY_DAYS = 90;

// Quotes and the intro promo (customers.ts, sales.ts) ---------------------------------

/** Months the customers quotes (marketing, campaign, support, referrals) look ahead. */
export const CUSTOMER_QUOTE_MONTHS = 12;
/**
 * Round 4c (spec C): the intro promo's signup boost (PROMO_SIGNUP_BOOST)
 * applies only on streets lit within this many months (a freshly lit area),
 * so a standing promo in a mature town discounts every signup for little.
 */
export const PROMO_BOOST_YOUNG_MONTHS = 12;

// Storm economics (weather.ts, terrain.ts; spec D) ------------------------------------

/**
 * Round 4c/4d (spec D): a street's exposure is multiplied by 1 + this x its
 * canopy (terrain.canopyAt) on the zones STORM_CANOPY_ZONE counts: a
 * residential street fully under mature trees takes this many times more
 * storm damage on aerial cable than an open one (falling limbs are most of a
 * storm's damage to aerial plant). Underground cable is hit by its own small
 * chance times the same exposure. Round 4c/4d tuning: 6 -> 8 (with
 * STORM_AERIAL_DAMAGE_CHANCE 0.07 -> 0.04): tree-lined aerial streets cost
 * enough in storms that burying them pays back, while open ones see fewer
 * outages and stay aerial (spec D).
 */
export const STORM_EXPOSURE_CANOPY = 8;
/** Zones whose streets count their canopy (residential: old neighborhoods with street trees; rural streets count their woods through STORM_EXPOSURE_WOODED instead). */
export const STORM_CANOPY_ZONE: Readonly<Record<Zone, number>> = { downtown: 0, residential: 1, industrial: 0, rural: 0 };
/**
 * Round 4c/4d (spec D): an aerial repair under canopy costs 1 + this x the
 * street's canopy times the usual (a tree crew clears the fallen limbs and
 * more cable is replaced). Round 4c/4d tuning: 1 -> 2, so SMART's mix
 * beats all-aerial on 5-year value: all-aerial strings the tree-lined
 * streets SMART buries.
 */
export const REPAIR_CANOPY_SHARE = 2;
/**
 * ... and its days out are drawn from OUTAGE_DAYS_AERIAL_MIN + round(this x
 * canopy) (at most OUTAGE_DAYS_AERIAL_MAX) to OUTAGE_DAYS_AERIAL_MAX instead
 * of the whole range: the trees come off the lines first, so an outage there
 * lasts longer on average but never past the usual longest.
 */
export const OUTAGE_DAYS_CANOPY = 3;
/**
 * Round 4c/4d (spec D): the method choice (lifetimeMethodCost,
 * preferredMethod) counts a dollar spent up front this many times a dollar
 * of running costs: in a game where growth is bound by capital and lent
 * against revenue, money a bore takes would have passed more homes (about
 * four dollars of value at month 60 for one up front: DESIGN.md "What round
 * 4b could not reach"). Over BUILD_METHOD_HORIZON_YEARS of running costs,
 * burying is chosen when what it saves a year pays its extra cost back
 * within BUILD_METHOD_HORIZON_YEARS / this years. Round 4c/4d tuning: 3 ->
 * 1.5: at 3 the choice strung tree-lined residential streets aerial whose
 * storms then cost more than the bore (SMART's mix lost to all-underground
 * on a tuning town); at 1.5 they are buried (payback within 8 years) and
 * open blocks stay aerial.
 */
export const METHOD_UPFRONT_WEIGHT = 1.5;
/**
 * Months of a customer's margin (its price less the per-customer overhead)
 * the method choice counts for each cancellation an outage causes: its
 * place takes about this long to refill, and the refill pays a new install.
 */
export const LOST_CUSTOMER_MONTHS = 12;
/** Round 4c/4d (spec D, terrain.canopyAt): grove noise at or below this is an open street, no canopy ... */
export const CANOPY_LOW = 0.6;
/** ... and at or above CANOPY_LOW + this a street fully under trees (canopy 1). */
export const CANOPY_SPAN = 0.1;

// Growth advice (advisor.ts; spec I.6) --------------------------------------------------

/**
 * advisor.growthOptions: a lever (marketing, a campaign, referral credits) is
 * sensible when its cost per new customer is paid back by this many months
 * of what a customer brings (what a unit pays less overhead.perCustomerCost).
 */
export const GROWTH_PAYBACK_MONTHS = 18;
/**
 * advisor growCustomers: the marketing budget's last MARKETING_STEP is worth
 * cutting when what it saves per customer it loses is more than this many
 * times the payback a raise needs (GROWTH_PAYBACK_MONTHS of margin; the gap
 * keeps a cut and a raise from following each other).
 */
export const GROWTH_TRIM_FACTOR = 1.5;

// Bank health words (debt.bankHealth) --------------------------------------------------

/**
 * 'watch': compliant and passing both checks, but within this share of a
 * limit (leverage above (1 - this) x COVENANT_MAX_LEVERAGE, or coverage
 * below (1 + this) x COVENANT_MIN_COVERAGE). The advisor's
 * COVENANT_RISK_MARGIN is this value.
 */
export const BANK_WATCH_HEADROOM = 0.1;
