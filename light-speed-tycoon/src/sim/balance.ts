// Tunable game-balance values. Rough starting points; see docs/light-speed-tycoon/DESIGN.md.
// Money in whole dollars, distance in feet, time in days.
//
// Round 2: tuned by headless bots (src/sim/tuning/): targets.test.ts holds the
// targets (start cash vs. town build-out, cost per passing by area, smart play
// cash-flow positive in months 12-18, careless overbuild goes bankrupt, idle
// survives) across several seeds; TUNE_REPORT=1 npx vitest run
// src/sim/tuning/report.test.ts prints the per-seed numbers. Tests reference
// these constants symbolically, never as literal dollar amounts.

import type { CppBand, ParcelKind, TermYears, TierId } from './types';

export const START_YEAR = 2027;
/** Start cash covers only ~25-33% of the town's build-out (tuning target). */
export const START_CASH = 750_000;

/** Feet per map cell. A typical residential lot frontage. */
export const TILE_FT = 60;

// ---------------------------------------------------------------------------
// Construction cost
// ---------------------------------------------------------------------------

/** Aerial strand + lash, dollars per ft (excludes make-ready). */
export const AERIAL_COST_PER_FT = 11;
/** Underground directional bore + conduit, dollars per ft (soil). */
export const UNDERGROUND_COST_PER_FT = 28;
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
export const POLE_RENT_PER_POLE_PER_MONTH = 2;

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

/** The fixed tier lineup and its starting prices, in display order. */
export const TIER_DEFAULTS: readonly TierDefault[] = [
  { id: 'fiber500', name: '500 Mbps', downMbps: 500, upMbps: 500, price: 55, popularity: 1 },
  { id: 'fiber1g', name: '1 Gig', downMbps: 1_000, upMbps: 1_000, price: 70, popularity: 0.8 },
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
// ---------------------------------------------------------------------------

export const TAKE_SPEED_WEIGHT = 0.2;
export const TAKE_SPEED_RATIO_CAP = 4;
export const TAKE_UPLOAD_WEIGHT = 0.02;
export const TAKE_UPLOAD_RATIO_CAP = 10;
export const TAKE_PRICE_WEIGHT = 1;
export const TAKE_RATE_BASE = 0.31;
export const TAKE_RATE_PER_ADVANTAGE = 0.25;
export const TAKE_RATE_MIN = 0.03;
export const TAKE_RATE_MAX = 0.6;
/** Target take rate multiplier by building kind. */
export const TAKE_RATE_KIND_FACTOR: Readonly<Record<ParcelKind, number>> = { home: 1, mdu: 0.8, smb: 0.6 };

/**
 * Signup ramp: each day a lit segment gains about
 * (target units - subscribed units) x SIGNUP_RAMP_PER_DAY x (1 + marketing boost).
 * At ~$2 per passing per month of marketing a street closes about 60% of its
 * gap in a year (take rate ~25% after a year, ~38% after three); a slower ramp
 * lets churn hold the take rate well below its target for good.
 */
export const SIGNUP_RAMP_PER_DAY = 1 / 550;

// ---------------------------------------------------------------------------
// Marketing
// ---------------------------------------------------------------------------

export const MARKETING_DEFAULT_PER_MONTH = 1_000;
export const MARKETING_MAX_PER_MONTH = 100_000;
/**
 * Marketing boost to the signup ramp, with diminishing returns:
 *   boost = MARKETING_MAX_BOOST x m / (m + MARKETING_HALF_SAT_PER_PASSING x max(1, passings))
 * where m = marketingPerMonth. At MARKETING_HALF_SAT_PER_PASSING dollars per
 * passing per month the boost is half its maximum.
 */
export const MARKETING_MAX_BOOST = 1.5;
export const MARKETING_HALF_SAT_PER_PASSING = 3;

// ---------------------------------------------------------------------------
// Churn (at each month close, per subscribed unit)
//   p = min(CHURN_MONTHLY_MAX, CHURN_MONTHLY_BASE x (1 + CHURN_PRICE_SENSITIVITY
//       x max(0, price_t - default price_t) / default price_t))
// (a business's price_t and default price_t both times its multiplier:
// smbMultiplier and SMB_MULTIPLIER_DEFAULT).
// ---------------------------------------------------------------------------

export const CHURN_MONTHLY_BASE = 0.011;
export const CHURN_PRICE_SENSITIVITY = 2;
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

/**
 * Fixed monthly overhead (NOC, billing, office, staff), posted at every month
 * close. With the ramp above, careful play turns cash-flow positive around
 * month 15 (tuning target 12-18).
 */
export const OVERHEAD_PER_MONTH = 9_000;
/** Customer support per subscribed unit per month, accrued daily, posted at close. */
export const SUPPORT_COST_PER_SUB_PER_MONTH = 4;

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
// Financing (round 3: debt.ts). INITIAL GUESSES for the balance-tuning pass.
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
/** A 'paymentDue' notice is posted this many days before a close when cash is below the debt service it will charge. */
export const PAYMENT_REMINDER_DAYS = 5;
