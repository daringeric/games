// Tunable game-balance values. Rough starting points; see docs/light-speed-tycoon/DESIGN.md.
// Money in whole dollars, distance in feet, time in days.

export const START_YEAR = 2027;
export const START_CASH = 1_500_000;

/** Feet per map cell. A typical residential lot frontage. */
export const TILE_FT = 60;

// Construction cost per foot.
export const AERIAL_COST_PER_FT = 10;
export const UNDERGROUND_COST_PER_FT = 30;
/** Underground cost multiplier on rock segments. */
export const ROCK_MULTIPLIER = 2;

// Construction speed (feet per day for a single span; crews come later).
export const AERIAL_FT_PER_DAY = 800;
export const UNDERGROUND_FT_PER_DAY = 300;

// Right-of-way: aerial needs pole attachment + make-ready, underground needs a city permit.
export const MAKE_READY_DAYS_MIN = 30;
export const MAKE_READY_DAYS_MAX = 90;
/** Chance a make-ready job hits a long delay (pole replacement, utility backlog). */
export const MAKE_READY_LONG_CHANCE = 0.15;
export const MAKE_READY_LONG_DAYS_MIN = 120;
export const MAKE_READY_LONG_DAYS_MAX = 210;
export const PERMIT_DAYS_MIN = 14;
export const PERMIT_DAYS_MAX = 45;

// Poles.
export const POLE_SPACING_FT = 150;
export const POLE_RENT_PER_POLE_PER_MONTH = 2;

// Cabinets (fiber distribution hubs) and splitters.
export const CABINET_COST = 15_000;
export const SPLITTER_COST = 1_200;
export const CABINET_START_SPLITTERS = 1;
export const SPLIT_RATIO = 32;
export const CABINET_PERMIT_DAYS = 10;
export const CABINET_CONSTRUCT_DAYS = 5;

// OLT at the CO.
export const OLT_START_PON_PORTS = 16;

// Refunds: cancelling a span still in permitting refunds this fraction of its cost.
export const PERMITTING_CANCEL_REFUND = 1;
