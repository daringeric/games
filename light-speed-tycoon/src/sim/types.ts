// Shared simulation types for Light Speed Tycoon.
//
// Units used everywhere in the sim:
//   distance  -> feet (number)
//   money     -> whole US dollars (integer; round at the point a cost is computed)
//   time      -> days since game start (integer; day 0 = Jan 1 of START_YEAR)
//   position  -> map grid units (see "Geometry" below)
//   ratios    -> plain fractions 0..1 (take rate, churn); never saved, always derived
//
// Geometry: the city map is `width` x `height` cells. Street nodes sit on integer
// lattice points (0..width, 0..height). Street segments run along grid lines
// between two nodes that share an x or a y, with no other node between them.
// Blocks are the cell rectangles enclosed by streets; parcels are cell
// rectangles inside blocks, each with exactly one frontage (serving) segment.
// One cell is TILE_FT feet on a side.
//
// Saved state (GameState and everything under it) is plain JSON: no classes,
// Maps, Sets, undefined or NaN. Every number in saved state is a safe integer
// unless its doc says otherwise (Pricing.smbMultiplier is the one float).
// Interest rates are saved as whole basis points (bps: 725 = 7.25% a year) and
// saved ratios as hundredths (412 = 4.12x), so they stay integers too.
//
// schemaVersion history:
//   1 - round 1: city, network (spans, cabinets, OLT ports), ledger, reports.
//   2 - round 2: cabinet reach, splitter/OLT capacity, itemized costs and CPP,
//       subscribers and pricing, insolvency, milestones, notices. v1 saves are
//       migrated on load (save.ts migrateV1toV2).
//   3 - round 3: financing (GameState.debt: a revolving credit line, term
//       loans, covenant stage), ledger categories 'principal' and
//       'loanProceeds', MonthlyReport.debt, debt notices and the 'default'
//       game over. v2 saves migrate with no debt (save.ts migrateV2toV3); v1
//       saves migrate v1 -> v2 -> v3.
//   4 - round 4: weather (GameState.weather: storms, rng.weather) and span
//       outages and aerial -> underground conversions (CableSpan.outage,
//       CableSpan.conversion), price locks on accounts (grandfathering and
//       intro promos), the intro promo setting, incumbent promos per cabinet
//       area, the frozen-line sweep and loan acceleration (Debt.frozenCloses,
//       Debt.acceleration), ledger category 'repair', MonthlyReport.ops and
//       the new DebtStats fields, and the round-4 notice kinds. v3 saves
//       migrate with no storms, locks or promos (save.ts migrateV3toV4); v1
//       and v2 saves migrate v1 -> v2 -> v3 -> v4.
//       Round 4b extends v4 in place (round 4 was never released, so no
//       version bump): GameState.company (name, difficulty), GameState.advisor
//       (snoozed and recently shown suggestions), the 'retention' price lock
//       and IncumbentPromo.triggerTakePct / answered, MonthAccrual.
//       outageCreditDollarDays and OpsStats.outageCredits. A v4 save written
//       before these fields gets them on load (save.ts upgradeEarlyV4); older
//       saves get them from migrateV3toV4 (difficulty 'seed', the name
//       company.defaultCompanyName(town)).
//       Round 4c/4d extends v4 in place again (still unreleased):
//       GameState.customers (support level, referral credits, per-street
//       awareness, neighborhood campaigns, per-account happiness memory,
//       install-wait memory, the month's referral and campaign figures),
//       OpsStats.overhead (the overhead's base / per-customer / per-plant
//       lines; null on reports from earlier builds) and MonthlyReport.customers
//       (happiness counts, referral and campaign figures and per-area take-rate
//       history; absent on reports from earlier builds). A v4 save written
//       before them gets customers.newCustomers() and ops.overhead = null on
//       load (save.ts upgradeEarlyV4); older saves get them from migrateV3toV4.

export type NodeId = number;
export type SegmentId = number;
export type ParcelId = number;
export type CabinetId = number;
export type SpanId = number;

// ---------------------------------------------------------------------------
// City (generated once from a seed; immutable during play except parcel growth
// is revealed over time via Parcel.appearsDay)
// ---------------------------------------------------------------------------

export type StreetClass = 'arterial' | 'collector' | 'local';
export type Zone = 'downtown' | 'residential' | 'industrial' | 'rural';

export interface StreetNode {
  /** Equals this node's index in City.nodes. */
  id: NodeId;
  x: number;
  y: number;
}

export interface StreetSegment {
  /** Equals this segment's index in City.segments. */
  id: SegmentId;
  /** Endpoint node ids. Segments are axis-aligned. Convention: a < b. */
  a: NodeId;
  b: NodeId;
  streetClass: StreetClass;
  /** Display name of the street this segment belongs to, e.g. "Alder St". */
  name: string;
  lengthFt: number;
  /** Utility poles line this segment; aerial construction is only possible when true. */
  hasPoles: boolean;
  /** Rocky ground; underground construction pays UNDERGROUND_ROCK_SURCHARGE_PER_FT on top of the bore rate. */
  rock: boolean;
  zone: Zone;
}

export type ParcelKind = 'home' | 'mdu' | 'smb';

export interface Parcel {
  /** Equals this parcel's index in City.parcels. */
  id: ParcelId;
  kind: ParcelKind;
  /**
   * The ONE street segment that serves this parcel (its single serving side):
   * its drop comes off this segment and nothing else. A corner or through lot
   * may touch other streets, but cable on them never passes it. The renderer
   * shows the serving side with "building tells" (front walk, awning, MDU demarc).
   */
  segment: SegmentId;
  /** Top-left cell of the parcel footprint. */
  x: number;
  y: number;
  /** Footprint size in cells (homes/smb usually 1x1, MDUs larger). */
  w: number;
  h: number;
  /** Households or businesses at this parcel (home = 1, smb = 1, mdu = 8..48). Passings count units. */
  units: number;
  /** Town growth: the parcel exists from this day on. 0 = present at game start. */
  appearsDay: number;
  zone: Zone;
}

export interface City {
  seed: number;
  name: string;
  /** Map size in cells. */
  width: number;
  height: number;
  /** Feet per cell. */
  tileFt: number;
  nodes: StreetNode[];
  segments: StreetSegment[];
  parcels: Parcel[];
  /** Street node where the central office sits (given in M1). */
  coNode: NodeId;
}

// ---------------------------------------------------------------------------
// Network (player-built plant)
// ---------------------------------------------------------------------------

export type CableMethod = 'aerial' | 'underground';

/**
 * Build pipeline for any asset:
 *   permitting   - aerial: pole attachment application + make-ready
 *                  underground: city permit
 *   constructing - crews on site
 *   live         - in service
 */
export type BuildStage = 'permitting' | 'constructing' | 'live';

export interface CableSpan {
  id: SpanId;
  segment: SegmentId;
  method: CableMethod;
  stage: BuildStage;
  /** Whole days remaining in the current stage (0 once live). */
  stageDaysLeft: number;
  /** Construction-stage duration, fixed when the span is ordered. */
  constructDays: number;
  /**
   * Everything the player paid for this span: construction (rate x ft), rock
   * surcharge, make-ready, and its share of the order's per-order fees (split
   * across the order's spans by length, remainder on the order's last span, so
   * the spans of one order sum exactly to the order's cost).
   */
  cost: number;
  /**
   * The part of `cost` a cancellation during permitting can refund: construction
   * and rock surcharge only. Fees and make-ready are never refunded. The refund
   * is round(refundable x PERMITTING_CANCEL_REFUND). Invariant: 0 <= refundable <= cost.
   * Spans migrated from schemaVersion 1 have refundable === cost.
   */
  refundable: number;
  orderedDay: number;
  /** Day the span went live, or null if not live yet. */
  liveDay: number | null;
  /**
   * Round 4: storm or dig-in damage keeping this live span out of service
   * until repaired, else null. Only a live span can have one. While it lasts
   * the span carries no light: streets cut off by it are interrupted
   * (ServiceSnapshot.interruptedSegments) but still passed, and their
   * subscribers keep their accounts (they are not dropped as 'dark').
   */
  outage: SpanOutage | null;
  /**
   * Round 4: an aerial span being rebuilt underground (convertSpan), else
   * null. Only a live aerial span can have one; the aerial cable stays in
   * service (and exposed to storms) until the rebuild goes live, when
   * `method` becomes 'underground' and this is cleared.
   */
  conversion: SpanConversion | null;
}

/** What took a span out of service: a storm (aerial plant mostly) or a dig-in (underground plant). */
export type OutageCause = 'storm' | 'digIn';

/** Damage on a live span (CableSpan.outage). */
export interface SpanOutage {
  cause: OutageCause;
  /** The storm that did it (Storm.id), or null for a dig-in. */
  storm: number | null;
  /** Day the damage happened. */
  startDay: number;
  /**
   * Whole days until repaired, >= 1. weather.stepWeather counts it down once
   * a day and clears the outage (service restored) the day it would reach 0.
   */
  daysLeft: number;
  /** Repair cost posted as a 'repair' ledger entry the day the damage happened, whole dollars >= 0. */
  repairCost: number;
}

/** An aerial span's rebuild underground (CableSpan.conversion), with its own permit and construction. */
export interface SpanConversion {
  stage: 'permitting' | 'constructing';
  /** Whole days left in the current stage, >= 0. */
  stageDaysLeft: number;
  /** Construction-stage duration, fixed when ordered, >= 1. */
  constructDays: number;
  /** What the rebuild cost (paid when ordered, added to CableSpan.cost and Capex.osp then), whole dollars >= 0. */
  cost: number;
  orderedDay: number;
}

export type PonTech = 'gpon' | 'xgspon';

export interface Cabinet {
  id: CabinetId;
  /** Street node the cabinet stands at. At most one cabinet per node. */
  node: NodeId;
  /**
   * 1:SPLIT_RATIO splitters installed, 0..MAX_SPLITTERS_PER_CABINET. Each one
   * gives SPLIT_RATIO subscriber ports and consumes one OLT PON port, whether or
   * not the cabinet is live yet.
   */
  splitters: number;
  stage: BuildStage;
  stageDaysLeft: number;
  /** Everything paid for this cabinet: the cabinet plus every splitter added to it (refunded in full while permitting). */
  cost: number;
  orderedDay: number;
  liveDay: number | null;
}

/** Optical line terminal at the CO. M1 has exactly one chassis. */
export interface Olt {
  /**
   * PON ports available to splitters. Authoritative capacity: total splitters
   * across all cabinets may never exceed it. Kept equal to
   * cards x OLT_PORTS_PER_CARD by every command (tests may set it directly).
   */
  ponPorts: number;
  /** Line cards installed in the chassis, 1..OLT_MAX_CARDS (addOltCard adds one). */
  cards: number;
  tech: PonTech;
}

/**
 * What a right-of-way application for one segment drew, remembered so that
 * cancelling and re-ordering cannot re-roll it. An order for (segment, method)
 * placed while state.day < drawnDay + MAKE_READY_MEMORY_DAYS gets exactly
 * `days` of permitting for that span instead of a fresh draw.
 */
export interface MakeReadyMemo {
  segment: SegmentId;
  method: CableMethod;
  /** Permitting days drawn (make-ready for aerial, permit for underground), >= 1. */
  days: number;
  /** Day of the original draw; reuse never moves it, so a memo always expires. 0 <= drawnDay <= state.day. */
  drawnDay: number;
}

export interface Network {
  /** At most one span per segment. */
  spans: CableSpan[];
  cabinets: Cabinet[];
  olt: Olt;
  /**
   * Remembered permitting draws, at most one per (segment, method), sorted by
   * segment then method ('aerial' before 'underground'). Expired memos may
   * linger until the next layCable prunes them; readers must check expiry.
   */
  makeReady: MakeReadyMemo[];
  /**
   * Bumped whenever topology, any build stage, splitter count or OLT capacity
   * changes, and (round 4) whenever a span's outage starts or ends or a
   * conversion goes live. Derived caches (see ServiceSnapshot) key off this.
   */
  version: number;
}

// ---------------------------------------------------------------------------
// Weather (round 4): seeded storms that damage aerial plant far more than
// underground, and dig-ins on underground plant. weather.ts owns the rules;
// the damage itself lives on the spans (CableSpan.outage).
// ---------------------------------------------------------------------------

/** One storm that hit the town (kept STORM_LOG_DAYS for the map, the briefing and the advisor). */
export interface Storm {
  /** From Weather.nextStormId; strictly increasing through the log. */
  id: number;
  /** Day it hit. */
  day: number;
  /** Center of the area it hit, map grid units (integers inside the map). */
  x: number;
  y: number;
  /** Radius of the area it hit, map cells, >= 1. Spans whose segment midpoint lies within it were exposed. */
  radius: number;
  /** 1 (squall) .. STORM_SEVERITY_MAX (major storm): scales the damage chance. */
  severity: number;
  /** Spans it damaged (any method), ascending ids (a span removed since stays listed). */
  spans: SpanId[];
  /** Repair dollars it caused (sum of those outages' repairCost). */
  repairCost: number;
}

/** Running weather totals for the open month, reset by each close (weather.closeWeatherMonth). */
export interface WeatherMonth {
  /**
   * Days each lit segment spent interrupted (ServiceSnapshot.interruptedSegments:
   * no cabinet reaches it) this month, sorted by segment ascending, one entry
   * per segment, days >= 1 (segments never interrupted are absent). The
   * street's record (weather.outageDaysOn); churn goes by each subscriber's
   * own days (Weather.cutOff).
   */
  segmentOutageDays: { segment: SegmentId; days: number }[];
  /**
   * Subscriber-days without service this month: over the month's days, the
   * subscribed units of accounts cut off (network.outageService: an outage
   * cuts their own cabinet off from their street and no other cabinet that
   * still reaches it has a port free for them).
   */
  outageUnitDays: number;
  /** Storms that hit this month. */
  storms: number;
  /** Spans damaged this month (storms and dig-ins). */
  spansDamaged: number;
  /** Repair dollars posted this month (the month's 'repair' entries, as a positive number). */
  repairs: number;
}

/**
 * One subscriber's outage (Weather.cutOff): the account on `parcel` was cut
 * off `days` days since the last close (not charged yet), after `charged`
 * days of the same outage charged at earlier closes (it was still cut off at
 * them), with at most `units` of its units cut off on one day (units it adds
 * later were not cut off).
 */
export interface AccountOutage {
  parcel: ParcelId;
  /** >= 0; days + charged >= 1. */
  days: number;
  /** >= 0. */
  charged: number;
  /** >= 1. */
  units: number;
}

export interface Weather {
  /** Storms of the last STORM_LOG_DAYS days, oldest first. */
  storms: Storm[];
  /** Id the next storm gets (>= 1, greater than every id in storms). */
  nextStormId: number;
  month: WeatherMonth;
  /**
   * Round 4: subscribers cut off by outages this month, or still cut off at
   * the last close, one entry per account (by parcel, ascending). Each day an
   * account is cut off (network.outageService) adds a day; each close charges
   * the days since the last one (sales.closeSalesMonth, weather.outageChargeOf)
   * and keeps only the accounts still cut off, their days counted as charged
   * (weather.closeWeatherMonth), so an outage over a close pays its base churn
   * once.
   */
  cutOff: AccountOutage[];
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export type LedgerCategory =
  | 'construction' // cable orders: construction, rock, make-ready, engineering + permit fees (OSP capex)
  | 'equipment' // cabinets and splitters (OSP capex), OLT line cards (CO capex)
  | 'install' // drops, ONTs, installs, MDU building routers (connect capex)
  | 'refund' // money back for cancelled orders (positive), or a 0 memo for no-refund removals
  | 'poleRent'
  | 'revenue' // subscriber billing at month close (positive)
  | 'overhead' // fixed monthly overhead plus per-subscriber support cost
  | 'payroll'
  | 'marketing'
  | 'repair' // round 4: storm and dig-in repairs (operating cost, negative)
  | 'interest' // financing: credit-line and term-loan interest, accrued interest on a prepayment, late fees (negative)
  | 'principal' // financing: credit-line repayments, scheduled term-loan principal, prepayments (negative)
  | 'loanProceeds' // financing: credit-line draws and term-loan proceeds (positive)
  | 'other';

export interface LedgerEntry {
  day: number;
  category: LedgerCategory;
  /** Signed whole dollars: negative = money out, positive = money in. */
  amount: number;
  memo: string;
}

/**
 * Operating figures captured at a month close (counts are subscriber units:
 * a home or business is 1, each subscribing MDU apartment is 1).
 */
export interface MonthlyStats {
  /** Subscribed units at month end, after that close's churn. */
  subscribers: number;
  /** Accounts (parcels with service) at month end. */
  accounts: number;
  /**
   * Subscriber-days billed during the month: the sum over its days of
   * subscribed units (the billing basis). Average subscribers = subscriberDays
   * / days in the month, the denominator of ARPU.
   */
  subscriberDays: number;
  /** Units connected during the month. */
  grossAdds: number;
  /** Units that cancelled at this close (voluntary churn). */
  churned: number;
  /** Units disconnected during the month because their service went away (cable or cabinet removed). */
  lostService: number;
  /** Lifetime units connected, at month end (Sales.connectsTotal). */
  connectsTotal: number;
  /** Cumulative capex at month end (Finance.capex). */
  capexOsp: number;
  capexConnect: number;
  capexCo: number;
  /** Splitters in use (= OLT PON ports in use) and OLT PON ports at month end. */
  ponPortsUsed: number;
  ponPorts: number;
  /** Cabinets turning signups away at month end (Sales.fullCabinets.length). */
  fullCabinets: number;
}

export interface MonthlyReport {
  year: number;
  /** 1..12 */
  month: number;
  /** Signed totals per category for the month (categories with no entries omitted). */
  totals: Partial<Record<LedgerCategory, number>>;
  net: number;
  cashEnd: number;
  /** Units passed (sum of Parcel.units on lit segments) at month end. */
  passings: number;
  /**
   * Operating figures at month end. Absent on reports migrated from
   * schemaVersion 1 saves; present on every report a round-2 close writes.
   * Derived KPIs (ARPU, CPGA, take rate, CPP, cost per connection) come from
   * metrics.ts reportKpis(), never stored.
   */
  stats?: MonthlyStats;
  /**
   * Financing figures at month end (after this close's debt service and
   * covenant review). Absent on reports migrated from schemaVersion 1 and 2
   * saves; present on every report a round-3 close writes, debt or not.
   * Interest, principal and proceeds of the month are in `totals`.
   */
  debt?: DebtStats;
  /**
   * Round-4 operating figures (pricing, outages, the incumbent, the notice
   * cursor the briefing reads). Absent on reports migrated from schemaVersion
   * 1-3 saves; present on every report a round-4 close writes.
   */
  ops?: OpsStats;
  /**
   * Round 4c/4d: customer figures at month end (happiness, referrals,
   * campaigns, per-area take-rate history for the Customers dashboard).
   * Absent on reports written before round 4c/4d; present on every report a
   * round-4cd close writes (customers.closeCustomersMonth).
   */
  customers?: CustomerStats;
}

/**
 * Round 4c/4d: the overhead a month close posted ('overhead' ledger
 * entries), by line. base + perCustomer + perPlant = -(totals.overhead) of
 * the report exactly (whole dollars). See overhead.ts.
 */
export interface OverheadLines {
  /** OVERHEAD_BASE_PER_MONTH: the part that does not grow with the business. */
  base: number;
  /** Per subscribed unit: (OVERHEAD_PER_CUSTOMER_PER_MONTH + the support level's cost) x subscriber-days / days in the month. */
  perCustomer: number;
  /** Of perCustomer, the support level's part (SUPPORT_LEVELS[level].costPerSub x subscriber-days / days). */
  support: number;
  /** Per unit of live plant: live cabinets x OVERHEAD_PER_CABINET_PER_MONTH + route-miles of live cable x OVERHEAD_PER_MILE_PER_MONTH. */
  perPlant: number;
}

/**
 * Round 4c/4d: what one more month costs to run at today's size and rates
 * (overhead.overheadRates), for the rate card, the dashboard and the
 * quotes. Dollars a month; perMile may be fractional.
 */
export interface OverheadRates {
  base: number;
  /** Per subscribed unit a month: OVERHEAD_PER_CUSTOMER_PER_MONTH + support. */
  perCustomer: number;
  /** The support level's cost per subscribed unit a month (SUPPORT_LEVELS). */
  support: number;
  supportLevel: SupportLevel;
  perCabinet: number;
  perMile: number;
  /** Live plant today: cabinets and route-miles of live cable (not rounded). */
  cabinets: number;
  miles: number;
}

/** Round 4c/4d: customer figures a month close records (MonthlyReport.customers). */
export interface CustomerStats {
  /** Subscribed units by happiness bucket at month end (after churn); they sum to stats.subscribers. */
  happy: number;
  okay: number;
  unhappy: number;
  /** Signups credited to referrals in the month (whole units) and the credits they cost (2 x REFERRAL_CREDIT each, in totals.marketing). */
  referralSignups: number;
  referralCredits: number;
  /** Neighborhood campaigns bought in the month, dollars (in totals.marketing). */
  campaignSpend: number;
  /** Per active cabinet with lit streets at month end: units passed on the streets it serves and subscribed units on its accounts, ascending cabinet. */
  areas: AreaSnapshot[];
}

/** One cabinet area at a month close (CustomerStats.areas): the take-rate history the dashboard's trend reads. */
export interface AreaSnapshot {
  cabinet: CabinetId;
  passings: number;
  units: number;
}

/** Round-4 figures captured at a month close (finance.closeMonth assembles them). */
export interface OpsStats {
  /**
   * Highest notice id issued by the end of this close (state.nextNoticeId - 1
   * after every step of the close). The period's notices are those with an id
   * above the previous report's lastNoticeId, up to this one.
   */
  lastNoticeId: number;
  /** Subscriber units moved off tiers that are no longer offered, at this close (they kept service on another tier). */
  tierMoves: number;
  /**
   * Of stats.churned: units that cancelled at this close because their price
   * stepped up (a price lock ending, a retired tier's move to a dearer tier).
   */
  priceChurn: number;
  /** Of stats.churned: units that cancelled because of outages in the month. */
  outageChurn: number;
  /** Of stats.churned: units that cancelled because the incumbent ran a promo in their area. */
  incumbentChurn: number;
  /** Subscriber-days without service because of outages (WeatherMonth.outageUnitDays). */
  outageUnitDays: number;
  /** Storms that hit in the month. */
  storms: number;
  /** Spans damaged in the month (storms and dig-ins). */
  spansDamaged: number;
  /** Repair spend in the month, dollars >= 0 (= -(totals.repair ?? 0)). */
  repairs: number;
  /** Incumbent promos that ran during the month (before this close's incumbent review). */
  incumbentPromos: number;
  /** What every subscriber pays for a full month at month end, price locks included (sales.monthlyRecurringRevenue after churn). */
  mrr: number;
  /**
   * Round 4b: billing not charged for days subscribers had no service
   * because of outages (round(MonthAccrual.outageCreditDollarDays / days in
   * the month)), dollars >= 0. Revenue in `totals` is already net of it.
   * Reports written by an earlier round-4 build get 0 on load.
   */
  outageCredits: number;
  /**
   * Round 4c/4d: the month's overhead by line (sums to -(totals.overhead)),
   * or null on reports written before round 4c/4d (the summary then shows
   * one overhead line).
   */
  overhead: OverheadLines | null;
}

/**
 * Financing figures captured at a month close (debt.reviewDebt writes them,
 * after payments, the covenant review and the credit line's re-pricing).
 */
export interface DebtStats {
  /** Credit-line balance at month end (>= 0; missed interest capitalized into it). */
  creditBalance: number;
  /** Sum of every term loan's balance at month end (>= 0). Total debt = creditBalance + termBalance. */
  termBalance: number;
  /** Credit-line limit for the coming month (debt.creditLimit at this close, >= 0). */
  creditLimit: number;
  /** Annualized trailing recurring revenue at this close (debt.trailingArr), the base of borrowing capacity (>= 0). */
  arr: number;
  /** Annualized trailing operating cash flow at this close (debt.annualOperatingCashFlow); may be negative. */
  annualOperatingCashFlow: number;
  /** Scheduled debt service over the next 12 months at this close (debt.annualDebtService, >= 0). */
  annualDebtService: number;
  /** Leverage x 100, rounded (412 = 4.12x): 0 with no debt; null when unmeasurable (debt but no cash flow to measure it against). */
  leverageX100: number | null;
  /** Debt-service coverage x 100, rounded (may be <= 0); null when nothing is scheduled (no debt). */
  coverageX100: number | null;
  /** Covenant stage after this close's review. */
  stage: CovenantStage;
  /** Debt-weighted average effective annual rate (penalty included) on month-end balances, bps; null with no debt. */
  averageRateBps: number | null;
  /** This close's debt service could not be paid (see DebtClose.missed). */
  missedPayment: boolean;
  /**
   * Round 4 (absent on reports from older saves, present on every round-4
   * close): principal the bank swept from this month's operating cash flow
   * while the line was frozen (FROZEN_SWEEP_SHARE), dollars >= 0.
   */
  sweep?: number;
  /** Round 4: consecutive closes ending 'frozen', after this close's review (Debt.frozenCloses). */
  frozenCloses?: number;
  /** Round 4: closes left to repay everything once the bank has called the loans (Acceleration.closesLeft after this close), else null. */
  accelerationClosesLeft?: number | null;
}

/**
 * Lifetime capital spend, net of refunds, whole dollars. Updated by the command
 * or event that spends the money, at the same time as its ledger entry.
 * Invariants: osp + co = -(sum of all construction + equipment + refund ledger
 * amounts ever posted); connect = -(sum of all install ledger amounts ever).
 */
export interface Capex {
  /** Outside plant: cable orders (incl. fees and make-ready), cabinets, splitters. Numerator of cost per passing (CPP). */
  osp: number;
  /** Connections: installs and MDU building routers. Numerator of cost per connection. */
  connect: number;
  /** Central office electronics: OLT line cards. In neither CPP nor cost per connection. */
  co: number;
}

export interface Finance {
  /**
   * May go negative: recurring charges (overhead, support, marketing, pole
   * rent) post even when cash is short (see insolvency). Installs do not: they
   * pause while cash can't cover them (sales.stepSales).
   */
  cash: number;
  /** Entries for the current, still-open month. */
  monthToDate: LedgerEntry[];
  /** Closed months, oldest first. */
  reports: MonthlyReport[];
  capex: Capex;
  /**
   * Consecutive month closes that ended with cash < 0 (0 after any close that
   * ends with cash >= 0). Reaching INSOLVENCY_GRACE_MONTHS ends the game.
   */
  negativeMonths: number;
}

// ---------------------------------------------------------------------------
// Financing (round 3): a revolving credit line, term loans, covenants.
//
// Borrowing capacity is a multiple of ARR: annualized recurring revenue of
// the trailing closed months (debt.trailingArr). Rates are base + a leverage
// spread + a cost-per-passing spread + a product adjustment, in whole basis
// points; while the covenant stage is 'penalty' or 'frozen' every balance pays
// PENALTY_STEP_UP_BPS on top (never fixed into a loan). Term-loan rates are
// fixed at origination; the credit line floats (re-priced at each close).
// See debt.ts for every formula.
// ---------------------------------------------------------------------------

export type LoanId = number;

/** Allowed term-loan terms in years (balance.TERM_LOAN_YEARS lists them). */
export type TermYears = 5 | 7;

/**
 * Where the company stands with its lender. Each month close that breaches a
 * covenant steps it up one stage (compliant -> warning -> penalty -> frozen;
 * frozen stays frozen); COVENANT_CURE_CLOSES compliant closes in a row step
 * it down one stage. A missed payment jumps straight to 'frozen' (with a late
 * fee); a missed payment while 'frozen' is a default (game over). A close
 * with no debt at all resets it to 'compliant'.
 *   warning - nothing changes yet but the notice
 *   penalty - every balance pays PENALTY_STEP_UP_BPS more
 *   frozen  - penalty, and no credit-line draws or new term loans (repaying and prepaying still work)
 */
export type CovenantStage = 'compliant' | 'warning' | 'penalty' | 'frozen';

/**
 * An interest rate's parts, whole basis points, each >= 0. The rate is their
 * sum; the penalty surcharge is never one of them (it follows the stage).
 */
export interface RateParts {
  /** BASE_RATE_BPS when priced. */
  baseBps: number;
  /** Leverage spread (LEVERAGE_SPREAD_BANDS; LEVERAGE_SPREAD_MAX_BPS above them or when unmeasurable). */
  leverageBps: number;
  /** Cost-per-passing spread: CPP_SPREAD_BPS[band of lifetime CPP]; 0 while nothing is passed. */
  cppBps: number;
  /** Product adjustment: CREDIT_LINE_EXTRA_BPS for the line, TERM_EXTRA_BPS[termYears] for a term loan. */
  productBps: number;
}

export interface CreditLine {
  /** Drawn balance, whole dollars, 0..SANE max (may exceed the limit after the limit shrinks or missed interest is capitalized). */
  balance: number;
  /**
   * The line's floating rate until the next close, without the penalty
   * surcharge. newGame and migrations price it with no leverage and no CPP
   * spread (base + product); every close re-prices it (debt.reviewDebt).
   */
  rate: RateParts;
  /**
   * Sum over the open month's days of the end-of-day balance (debt.endDebtDay
   * adds the balance once per day, before the day advances). Interest at the
   * close = round(balanceDollarDays x effective bps / (10,000 x 365)); reset to
   * 0 by the close. >= 0.
   */
  balanceDollarDays: number;
}

/**
 * A fixed-rate term loan, repaid in level monthly payments (principal +
 * interest) at month closes. The month it is taken it pays only stub interest
 * for the days it was held; the regular payments start at the next close.
 */
export interface TermLoan {
  /** From Debt.nextLoanId; loans are listed by ascending id. */
  id: LoanId;
  /** Amount borrowed, whole dollars >= 1. */
  principal: number;
  /**
   * Still owed, whole dollars >= 1 (a loan is removed the moment it reaches
   * 0). Normally <= principal; a missed payment capitalizes interest into it.
   */
  balance: number;
  /** Fixed annual rate, bps (the RateParts sum at origination; no penalty surcharge). */
  rateBps: number;
  /** Term in months: termYears x 12. */
  termMonths: number;
  /**
   * Level monthly payment, whole dollars >= 1: debt.levelPayment of the
   * balance over monthsLeft at the effective rate (rateBps + the penalty
   * surcharge of the stage). Set at origination, and re-set over the months
   * left by a partial prepayment, whenever a close starts or stops the
   * penalty, and after a missed payment capitalizes interest (debt.reviewDebt),
   * so it always repays the loan on schedule. Each regular payment's interest
   * is round(balance x effective bps / 120,000) and its principal is payment -
   * interest (never below 0); the last one (monthsLeft === 1) pays the whole
   * remaining balance plus its interest, which differs from payment only by
   * the whole-dollar rounding.
   */
  payment: number;
  /** Regular payments still due, 1..termMonths. A missed payment leaves it unchanged (the schedule slips a month). */
  monthsLeft: number;
  /** Day the loan was taken, 0..state.day. */
  originatedDay: number;
}

export interface CovenantState {
  stage: CovenantStage;
  /**
   * Consecutive compliant closes toward the next cure step, 0..COVENANT_CURE_CLOSES - 1
   * (0 whenever stage is 'compliant'; reset by any breach or missed payment).
   */
  compliantCloses: number;
}

/**
 * Round 4: the bank has called the loans after FROZEN_ACCELERATION_CLOSES
 * frozen closes in a row. Everything owed (term loans and the credit line)
 * falls due over the next ACCELERATION_CLOSES closes; a close that cannot pay
 * what falls due is a default (game over). It lasts until nothing is owed.
 */
export interface Acceleration {
  /** Close day the bank called the loans. */
  day: number;
  /** Closes left to repay everything, ACCELERATION_CLOSES..1 (the close with 1 left takes all that remains). */
  closesLeft: number;
}

export interface Debt {
  credit: CreditLine;
  /** Open term loans (balance >= 1), ascending id. */
  loans: TermLoan[];
  /** Id the next term loan gets (>= 1, greater than every id in loans). */
  nextLoanId: number;
  covenant: CovenantState;
  /**
   * Round 4: consecutive month closes whose review ended with the stage
   * 'frozen' (0 whenever a close ends in any other stage, or nothing is
   * owed). Reaching FROZEN_ACCELERATION_CLOSES calls the loans (acceleration).
   * Migrated v3 saves count the trailing frozen closes of their reports.
   */
  frozenCloses: number;
  /** Round 4: the loans have been called, else null (debt.reviewDebt starts it; it ends when nothing is owed). */
  acceleration: Acceleration | null;
}

// ---------------------------------------------------------------------------
// Sales (subscribers, pricing, marketing)
// ---------------------------------------------------------------------------

/** The fixed round-2 tier lineup, in display order. */
export type TierId = 'fiber500' | 'fiber1g' | 'fiber2g';

export interface Tier {
  id: TierId;
  /** Display name, e.g. "500 Mbps". Fixed (from TIER_DEFAULTS); setPricing never changes it. */
  name: string;
  /** Advertised speeds in Mbps. Fixed (from TIER_DEFAULTS). */
  downMbps: number;
  upMbps: number;
  /** Monthly price for a household, whole dollars, TIER_PRICE_MIN..TIER_PRICE_MAX. */
  price: number;
  /**
   * Sold to new customers. Round 4: subscribers on a tier that is not offered
   * move at the next close to the offered tier nearest in price, and some
   * cancel (sales.closeSalesMonth step 4); round 3 let them keep it, so a v3
   * save with such subscribers gets a 'rulesUpdated' notice at load.
   */
  offered: boolean;
}

export interface Pricing {
  /** Exactly one entry per TierId, in TierId order (fiber500, fiber1g, fiber2g); at least one offered. */
  tiers: Tier[];
  /**
   * Businesses pay round(tier price x smbMultiplier) per month. The only float
   * in saved state: finite, SMB_MULTIPLIER_MIN..SMB_MULTIPLIER_MAX.
   */
  smbMultiplier: number;
}

/**
 * Service at one parcel. Homes and businesses have one unit; an MDU account
 * aggregates its subscribing apartments.
 */
export interface Account {
  parcel: ParcelId;
  /**
   * Cabinet whose splitter ports these units occupy: the street's serving
   * cabinet at connect. It stays while that cabinet is active and reaches the
   * street along connected cable; when it no longer does, the next daily step
   * moves the account to the nearest active cabinet that reaches the street
   * and has a free port, or drops it (sales.serviceChanges).
   */
  cabinet: CabinetId;
  /**
   * Subscribed units per tier (non-negative integers). Total >= 1 and
   * <= the parcel's units; homes and businesses total exactly 1.
   */
  tierUnits: Record<TierId, number>;
  /** Day the account's first unit connected. */
  since: number;
  /**
   * Round 4: prices this account pays that differ from the list price, at
   * most one per tier, only for tiers it has units on, in TIER_IDS order. A
   * unit on a locked tier pays min(lock.price, list price) (a price cut
   * reaches everyone at once); others pay the list price. Every unit of an
   * apartment building's account on that tier shares the lock.
   */
  locks: PriceLock[];
}

/**
 * Why an account pays something other than the list price:
 *   grandfather - a price rise grandfathered for months (setPricing grandfatherMonths >= 1)
 *   notice      - a price rise passed on at the next bill (setPricing grandfatherMonths 0)
 *   promo       - it signed up on the intro promo (Sales.promo)
 *   retention   - round 4b: a retention offer answering the incumbent's promo
 *                 in its cabinet area (answerIncumbent), until that promo ends
 * The reason sets the churn share of the price step when the lock ends.
 */
export type PriceLockReason = 'grandfather' | 'notice' | 'promo' | 'retention';

/** A price an account's units on one tier pay until a month close (Account.locks). */
export interface PriceLock {
  tier: TierId;
  /** Household monthly price while it lasts, whole dollars >= 1 (a business pays round(price x smbMultiplier)). */
  price: number;
  /**
   * The month-close day (a 1st of the month, after the day it was set) whose
   * close ends it: billing up to that close uses the lock, and that close
   * moves the units to the list price (a price step: extra churn by the size
   * of the rise, see sales.closeSalesMonth).
   */
  untilDay: number;
  reason: PriceLockReason;
  /**
   * Round 4b, on a 'retention' lock only (absent otherwise): the dearer lock
   * it replaced that was promised past the incumbent promo's end (a
   * grandfathered or intro-promo price), so the offer never cuts that
   * promise short. When the retention lock ends at a close, its units go
   * back to this price (a step from the retention price, RETENTION_STEP_SHARE)
   * until resume.untilDay, with resume.reason, instead of to the list price.
   */
  resume?: PriceLockResume;
}

/** Round 4b: the lock a retention lock gives back when it ends (PriceLock.resume): never itself a retention lock. */
export interface PriceLockResume {
  /** Household monthly price, whole dollars >= 1, above the retention lock's. */
  price: number;
  /** A month-close day after the retention lock's untilDay. */
  untilDay: number;
  reason: Exclude<PriceLockReason, 'retention'>;
}

/** The intro offer new signups get (Sales.promo): a discount off the list price for their first months. */
export interface IntroPromo {
  /** Whole percent off the list price, 1..PROMO_MAX_PERCENT_OFF. */
  percentOff: number;
  /**
   * Months each signup keeps it, 1..PROMO_MAX_MONTHS: its lock ends at the
   * close `months` closes after the next one, so it covers the rest of the
   * signup month and `months` full months.
   */
  months: number;
}

/**
 * Round 4: the incumbent cable company answering a high take rate in one of
 * your cabinet areas with a local promo (sales/incumbent.ts). While it runs
 * (startDay <= day < endDay) the incumbent's price on streets that cabinet
 * serves is `price`: your target take rate there falls and its subscribers
 * churn more.
 */
export interface IncumbentPromo {
  /** The cabinet whose serving area it targets. */
  cabinet: CabinetId;
  /** Close day it started. */
  startDay: number;
  /** Close day it ends (it runs while day < endDay), > startDay. */
  endDay: number;
  /** The incumbent's promo price there, whole dollars a month, 1..INCUMBENT_PRICE. */
  price: number;
  /**
   * No new promo at this cabinet before this day (>= endDay). Round 4b: the
   * record is kept after it as the area's memory (at most one record per
   * cabinet; a new promo replaces it): the next promo there needs the area's
   * take rate at least triggerTakePct / 100 + INCUMBENT_PROMO_RETRIGGER_POINTS
   * (incumbent.reviewIncumbent), so a mature area does not cycle forever. It
   * is dropped when its cabinet no longer exists.
   */
  quietUntil: number;
  /** Round 4b: your take rate in the area when it started, whole percent 0..100 (round(takeRate x 100)). */
  triggerTakePct: number;
  /**
   * Round 4b: the player answered it with a retention offer
   * (answerIncumbent: 'retention' price locks for the area's subscribers
   * until endDay). The advisor's card about it clears; at most one answer
   * per promo.
   */
  answered: boolean;
  /**
   * Round 4b: the player set an intro promo while it ran where
   * incumbent.bestIncumbentAnswer recommended one (setPromo: see
   * incumbent.setIntroPromo), and it is still set. The advisor's card about it
   * clears too, but unlike `answered` it spares no churn (the intro promo
   * speeds up signups; only a retention offer keeps subscribers), and a
   * retention offer can still be made. Back to false when the intro promo is
   * taken away (setPromo null) while it runs.
   */
  answeredWithPromo: boolean;
}

/**
 * Running totals for the open month, reset by each close. Money accrues per
 * day so a mid-month change (a price, a budget, a signup) counts for exactly
 * the days it was in effect.
 */
export interface MonthAccrual {
  /**
   * Sum over the month's daily steps of that day's billable monthly rate
   * (sum of tier price x units, SMB at the multiplied price). Revenue billed at
   * close = round(revenueDollarDays / days in the month).
   */
  revenueDollarDays: number;
  /** Sum over the month's daily steps of marketingPerMonth. Spend at close = round(/ days in the month). */
  marketingDollarDays: number;
  /** Sum over the month's daily steps of subscribed units (outage days left out). The per-customer overhead at close (overhead.postCustomerOverhead) is priced from it. */
  subscriberUnitDays: number;
  /** Units connected so far this month. */
  grossAdds: number;
  /** Units disconnected so far this month because service went away. */
  lostService: number;
  /**
   * Round 4b: sum over the month's daily steps of the monthly rate of the
   * units cut off that day (network.outageService), which revenueDollarDays
   * leaves out: outage days are not billed (nor charged support:
   * subscriberUnitDays leaves those units out too). The close reports
   * round(/ days in the month) as OpsStats.outageCredits. >= 0.
   */
  outageCreditDollarDays: number;
}

export interface Sales {
  pricing: Pricing;
  /** Marketing budget, whole dollars per month, 0..MARKETING_MAX_PER_MONTH. Accrues daily; posted at month close. */
  marketingPerMonth: number;
  /** One per parcel with service, sorted by parcel ascending, no duplicates. */
  accounts: Account[];
  /** MDU parcels whose building router is installed (paid once; it stays when every unit leaves). Sorted ascending, unique. */
  routerParcels: ParcelId[];
  /** Lifetime units connected (sum of all gross adds). Denominator of cost per connection. */
  connectsTotal: number;
  /**
   * Cabinets turning signups away: on the latest daily step a waiting new
   * account found no free splitter port, or (already listed) the demand
   * waiting on it would take every free port within sales.FULL_HOLD_DAYS.
   * addSplitter takes a cabinet off the list. Sorted ascending, unique. A
   * cabinet newly entering this list posts a 'cabinetFull' notice.
   */
  fullCabinets: CabinetId[];
  /**
   * Installs are paused: on the latest day an install was due, cash could not
   * cover it. Set by the step that posts 'installsPaused'; cleared by the
   * first step after it that connects an install, which posts
   * 'installsResumed'. (Saves written before this field derive it on load.)
   */
  installsPaused: boolean;
  month: MonthAccrual;
  /** Round 4: the intro promo new signups get, or null for none (setPromo). */
  promo: IntroPromo | null;
  /** Round 4: incumbent promos running or cooling down, sorted by cabinet, at most one per cabinet. */
  incumbentPromos: IncumbentPromo[];
}

// ---------------------------------------------------------------------------
// Progress: milestones, notices, game over
// ---------------------------------------------------------------------------

/** Scorecard milestones (definitions and titles in milestones.ts). */
export type MilestoneId =
  | 'firstLight'
  | 'passings1000UnderTarget'
  | 'subscribers100'
  | 'cashFlowPositive'
  | 'subscribers1000'
  | 'takeRate30';

export interface MilestoneRecord {
  id: MilestoneId;
  /** Day it was achieved (the close day for month-close milestones). */
  day: number;
}

export type NoticeKind =
  | 'cabinetFull' // a cabinet ran out of splitter ports and turned a signup away
  | 'serviceLost' // subscribers were disconnected because their cable or cabinet went away
  | 'oltFull' // a successful placeCabinet/addSplitter just used the OLT's last free PON port
  | 'insolvencyWarning' // a month closed with cash < 0
  | 'installsPaused' // cash could not cover the next install; new customers wait (Sales.installsPaused set)
  | 'installsResumed' // an install connected again after a pause (Sales.installsPaused cleared)
  | 'rulesUpdated' // an older save loaded under rules that changed what it gets (e.g. cabinet reach)
  | 'paymentDue' // PAYMENT_REMINDER_DAYS before a close, the cash projected at it (finance.estimateCashAtClose) is below the debt service it will charge
  | 'paymentMissed' // a close could not pay its debt service: late fee, credit frozen (not yet frozen before)
  | 'covenantWarning' // a covenant breach stepped the stage up to 'warning'
  | 'covenantPenalty' // a covenant breach stepped the stage up to 'penalty' (rate step-up)
  | 'creditFrozen' // a covenant breach stepped the stage up to 'frozen' (no draws, no new term loans)
  | 'covenantCured' // compliant closes (or no debt left) stepped the stage down
  | 'loanPaidOff' // a term loan's last scheduled payment was made at a close
  | 'debtSwept' // round 4: a close while frozen swept part of the month's operating cash flow to repay debt
  | 'accelerationWarning' // round 4: a frozen close brought the bank within ACCELERATION_WARNING_CLOSES closes of calling the loans
  | 'loansCalled' // round 4: FROZEN_ACCELERATION_CLOSES frozen closes in a row: everything owed falls due over ACCELERATION_CLOSES closes
  | 'tierRetired' // round 4: subscribers on a tier no longer offered moved to another tier at a close (some cancelled)
  | 'priceStep' // round 4: price locks ended at a close (grandfathering or intro promos): units now pay the list price (some cancelled)
  | 'incumbentPromo' // round 4: the incumbent started a promo in a cabinet area (Notice.cabinet set)
  | 'incumbentPromoEnded' // round 4: an incumbent promo ended (Notice.cabinet set)
  | 'storm' // round 4: a storm hit and damaged spans (outages, repair cost)
  | 'digIn' // round 4: an excavator cut an underground span
  | 'serviceRestored' // round 4: repairs finished and interrupted streets have service again
  | 'gameOver' // insolvency or default ended the game
  | 'milestone';

/**
 * Something the sim wants the player told about, raised during a tick or a
 * command. The UI shows each notice once: it remembers the highest id it has
 * shown and toasts newer ones. The sim never deletes a notice early; it keeps
 * the newest NOTICE_LOG_MAX.
 */
export interface Notice {
  /** From GameState.nextNoticeId; strictly increasing through the log. */
  id: number;
  day: number;
  kind: NoticeKind;
  /** Player-facing sentence, e.g. "Cabinet at Elm St & 3rd Ave is full: add a splitter to keep signing up customers." */
  message: string;
  /** The cabinet concerned (cabinetFull, serviceLost, incumbentPromo, incumbentPromoEnded), else null. */
  cabinet: CabinetId | null;
  /** The milestone achieved (milestone), else null. */
  milestone: MilestoneId | null;
}

/**
 * Why the game ended: 'insolvent' - INSOLVENCY_GRACE_MONTHS month closes in a
 * row ended with cash < 0 (finance.checkInsolvency); 'default' - a close could
 * not pay its debt service while the credit line was already frozen
 * (debt.reviewDebt).
 */
export type GameOverReason = 'insolvent' | 'default';

export interface GameOver {
  /** Day the game ended (a month-close day). */
  day: number;
  reason: GameOverReason;
  /** Player-facing explanation. */
  message: string;
}

// ---------------------------------------------------------------------------
// Game state (the whole saved game; must be plain JSON-serializable data)
// ---------------------------------------------------------------------------

export interface RngStreams {
  /** uint32 state for random events during play (make-ready delays, etc.). */
  events: number;
  /** uint32 state for subscriber signups, tier choice and churn (sales.ts only). */
  sales: number;
  /** Round 4: uint32 state for storms, dig-ins and outage lengths (weather.ts only), deriveSeed(seed, 'weather'). */
  weather: number;
}

/**
 * Round 4b: how hard the game is. Levels differ ONLY in starting cash for now
 * (balance.DIFFICULTY_LEVELS: Angel-backed, Seed round = START_CASH,
 * Bootstrapped, Shoestring); more knobs may follow.
 */
export type DifficultyId = 'angel' | 'seed' | 'bootstrapped' | 'shoestring';

/** Round 4b: the player's company (chosen on the start screen; never renamed mid-game). */
export interface Company {
  /**
   * Display name, e.g. "Otter Junction Fiber": a string already normalized by
   * company.normalizeCompanyName (trimmed, inner whitespace collapsed to one
   * space, no control characters), 1..COMPANY_NAME_MAX UTF-16 code units.
   * The UI renders it as text only (textContent), never as HTML.
   */
  name: string;
  difficulty: DifficultyId;
}

/**
 * Round 4b: a suggestion the player dismissed (snoozeAdvice). advise() leaves
 * out an advice with this key while state.day < untilDay, unless its severity
 * is now above the snoozed one (the situation got materially worse).
 */
export interface AdviceSnooze {
  /** Advice.key it silences (1..ADVICE_KEY_MAX_LENGTH characters). */
  key: string;
  /** A close day (the 1st of a month) after the day it was snoozed: hidden before it, shown again from it. */
  untilDay: number;
  /** The advice's severity when it was snoozed. */
  severity: AdviceSeverity;
}

/**
 * Round 4b: a suggestion shown in recent month-end briefings
 * (noteAdviceShown): how many briefings in a row have shown it, so the
 * advisor never repeats it word for word (Advice.repeat).
 */
export interface AdviceShown {
  key: string;
  /** Day of the first briefing of the current run that showed it. */
  firstDay: number;
  /** Day of the latest briefing that showed it (>= firstDay). */
  lastDay: number;
  /** Briefings in a row that showed it, >= 1. */
  times: number;
}

/** Round 4b: what the advisor remembers between briefings (saved, so it survives reloads). */
export interface AdvisorState {
  /** Snoozed suggestions, ascending key, one per key, at most ADVISOR_MEMORY_MAX. */
  snoozes: AdviceSnooze[];
  /** Suggestions the latest briefing showed, ascending key, one per key, at most ADVISOR_MEMORY_MAX. */
  shown: AdviceShown[];
}

// ---------------------------------------------------------------------------
// Customers (round 4c/4d; customers.ts owns the rules, sales.ts applies them
// to signups and churn). Saved in GameState.customers; plain JSON, integers.
// ---------------------------------------------------------------------------

/** Round 4c/4d: how much customer support the company pays for (balance.SUPPORT_LEVELS). */
export type SupportLevel = 'basic' | 'good' | 'great';

/**
 * Round 4c/4d: one lit street's awareness (CustomersState.streets). Kept
 * for every lit segment (customers.stepCustomers adds a street the day it is
 * first lit, at AWARENESS_ON_LIT, and drops it the day it is no longer lit);
 * an interrupted street (an outage) stays lit and keeps its entry.
 */
export interface StreetAwareness {
  segment: SegmentId;
  /** Day this run of being lit began (0..state.day). */
  litDay: number;
  /** Share of the street's households that know you, in parts per million: 0..customers.AWARENESS_PPM (1,000,000). */
  awareness: number;
}

/**
 * Round 4c/4d: a neighborhood campaign in one cabinet's area
 * (runCampaign): an awareness burst at full strength for CAMPAIGN_DAYS,
 * fading to nothing over CAMPAIGN_FADE_DAYS. The record is kept as the
 * area's memory until cooldownUntil (one record per cabinet; a new campaign
 * replaces it), and dropped after it or when the cabinet no longer exists.
 */
export interface NeighborhoodCampaign {
  cabinet: CabinetId;
  /** Day it was bought (0..state.day). */
  startDay: number;
  /** Day its effect has faded to nothing (startDay + CAMPAIGN_DAYS + CAMPAIGN_FADE_DAYS at purchase), > startDay. */
  endDay: number;
  /** No new campaign in this area before this day (endDay + CAMPAIGN_COOLDOWN_DAYS at purchase), >= endDay. */
  cooldownUntil: number;
  /** What it cost (posted as 'marketing' when bought), whole dollars >= 0. */
  cost: number;
  /** Lit units not signed up in the area when bought (what it was sized on), >= 0. */
  units: number;
}

/**
 * Round 4c/4d: what one account's happiness remembers
 * (CustomersState.memories; only accounts with something to remember have
 * an entry). customers.ts updates it at each close (outages, price steps)
 * and at connect (an install wait), and drops an entry once every field has
 * expired (or its account is gone).
 */
export interface CustomerMemory {
  parcel: ParcelId;
  /** Days its service was cut off by outages within HAPPINESS_OUTAGE_MEMORY_DAYS of the latest (outageDay), >= 0. */
  outageDays: number;
  /** Last day counted in outageDays, or null (outageDays is then 0). */
  outageDay: number | null;
  /** Close day its price last stepped up (a lock ending with a rise, a move to a dearer tier), or null. */
  priceStepDay: number | null;
  /** Day it connected after waiting for a port or for installs to resume, or null. */
  waitedDay: number | null;
}

/** Round 4c/4d: the last day a cabinet turned signups away (CustomersState.waits), for the install-wait happiness factor. */
export interface CabinetWait {
  cabinet: CabinetId;
  /** Last day it was listed in Sales.fullCabinets (0..state.day). */
  day: number;
}

/** Round 4c/4d: customer figures accrued over the open month, reset by each close. */
export interface CustomersMonth {
  /**
   * Signups credited to referral credits so far this month, in thousandths
   * of a unit (each signup adds round(its referral share x 1000), the share
   * of its street's switching that word of mouth brought while credits were
   * on). The close credits round(/ 1000) referrals, >= 0.
   */
  referralMilli: number;
  /** Neighborhood campaigns bought so far this month, dollars >= 0. */
  campaignSpend: number;
}

/** Round 4c/4d: the customers model's saved state (GameState.customers; customers.newCustomers() for a new game). */
export interface CustomersState {
  supportLevel: SupportLevel;
  /** Referral credits on (setReferrals): REFERRAL_CREDIT off for both sides of each referral signup. */
  referrals: boolean;
  /** One per lit segment, ascending segment. */
  streets: StreetAwareness[];
  /** Running or cooling down, ascending cabinet, at most one per cabinet. */
  campaigns: NeighborhoodCampaign[];
  /** Ascending parcel, at most one per parcel. */
  memories: CustomerMemory[];
  /** Cabinets that turned signups away recently, ascending cabinet, at most one per cabinet. */
  waits: CabinetWait[];
  /** Last day installs were paused for lack of cash (Sales.installsPaused), or null. */
  pausedDay: number | null;
  month: CustomersMonth;
}

export interface GameState {
  schemaVersion: 4;
  seed: number;
  /** Round 4b: the player's company: its name and the difficulty it started at. */
  company: Company;
  day: number;
  rng: RngStreams;
  /** Monotonic id source for spans and cabinets. */
  nextId: number;
  city: City;
  network: Network;
  finance: Finance;
  /** Credit line, term loans and covenant stage (debt.newDebt() for a new game: nothing borrowed). */
  debt: Debt;
  sales: Sales;
  /** Round 4c/4d: support level, referral credits, awareness, campaigns and happiness memory (customers.newCustomers() for a new game). */
  customers: CustomersState;
  /** Round 4: storms and the month's outage totals (weather.newWeather() for a new game). */
  weather: Weather;
  /** Round 4b: snoozed and recently shown suggestions (advisor.newAdvisorState() for a new game). */
  advisor: AdvisorState;
  /** Achieved milestones, in the order achieved; each id at most once. */
  milestones: MilestoneRecord[];
  /** The newest NOTICE_LOG_MAX notices, oldest first. */
  notices: Notice[];
  /** Id the next notice gets (>= 1, greater than every id in notices). */
  nextNoticeId: number;
  /**
   * Set once the game has ended. From then on applyCommand rejects every
   * command and tick() does nothing (the day no longer advances).
   */
  gameOver: GameOver | null;
}

// ---------------------------------------------------------------------------
// Commands (every player action goes through applyCommand so play is replayable)
// ---------------------------------------------------------------------------

/** One tier's new settings in a setPricing command. */
export interface TierSetting {
  id: TierId;
  /** Whole dollars per month, TIER_PRICE_MIN..TIER_PRICE_MAX. */
  price: number;
  offered: boolean;
}

export type Command =
  | { type: 'layCable'; segments: SegmentId[]; method: CableMethod }
  | { type: 'placeCabinet'; node: NodeId }
  | { type: 'removeSpan'; span: SpanId }
  /** Add one splitter to a cabinet in any stage (uses one free OLT PON port). */
  | { type: 'addSplitter'; cabinet: CabinetId }
  /** Remove a cabinet: refunded while permitting, frees its PON ports; its subscribers lose service. */
  | { type: 'removeCabinet'; cabinet: CabinetId }
  /** Buy one OLT line card at the CO (+OLT_PORTS_PER_CARD PON ports). */
  | { type: 'addOltCard' }
  /**
   * Replace every tier's price and offered flag (each TierId exactly once) and
   * the SMB multiplier. Free. Round 4: a price rise reaches today's
   * subscribers only after `grandfatherMonths` month closes (0: at the next
   * close; omitted: GRANDFATHER_MONTHS_DEFAULT), through price locks; new
   * subscribers pay the new price at once; a cut reaches everyone at once. A
   * tier no longer offered moves its subscribers to another tier at the next close.
   */
  | { type: 'setPricing'; tiers: TierSetting[]; smbMultiplier: number; grandfatherMonths?: number }
  /** Round 4: set the intro promo for new signups (null: none). Free. */
  | { type: 'setPromo'; promo: IntroPromo | null }
  /** Round 4: rebuild a live aerial span underground (permit, then construction; the aerial cable serves until it is live). Cost = quoteConvert(...).cost. */
  | { type: 'convertSpan'; span: SpanId }
  /** Set the monthly marketing budget (whole dollars). Free; spend accrues daily. */
  | { type: 'setMarketing'; perMonth: number }
  /** Draw whole dollars (>= 1, <= available) from the credit line. Cost = -amount (cash in). */
  | { type: 'drawCredit'; amount: number }
  /** Repay whole dollars (>= 1, <= balance, <= cash) of the credit line. Cost = amount. */
  | { type: 'repayCredit'; amount: number }
  /** Borrow a fixed-rate term loan of whole dollars (TERM_LOAN_MIN..capacity). Cost = -amount (cash in). */
  | { type: 'takeTermLoan'; amount: number; termYears: TermYears }
  /** Prepay whole dollars (>= 1, <= balance) of a term loan plus the interest accrued on them. Cost = amount + accrued interest. */
  | { type: 'prepayLoan'; loan: LoanId; amount: number }
  /**
   * Round 4b: answer the incumbent's running promo at `cabinet` with a
   * retention offer: every subscriber there gets a 'retention' price lock
   * (RETENTION_PERCENT_OFF off) until the promo ends, which spares them the
   * promo's extra churn. Free now (the discount is revenue given up). Once
   * per promo. See incumbent.answerIncumbent / quoteRetention.
   */
  | { type: 'answerIncumbent'; cabinet: CabinetId }
  /**
   * Round 4b: snooze (dismiss) the suggestion with this Advice.key for
   * ADVICE_SNOOZE_MONTHS closes (ADVICE_SNOOZE_URGENT_MONTHS for an urgent
   * one). Free; changes only what the advisor shows. See advisor.snoozeAdvice.
   */
  | { type: 'snoozeAdvice'; key: string }
  /**
   * Round 4b: the month-end briefing just showed these suggestions
   * (Advice.key); the UI sends it once per close-time briefing (not when the
   * menu reopens one). Free; feeds Advice.repeat. See advisor.noteAdviceShown.
   */
  | { type: 'noteAdviceShown'; keys: string[] }
  /**
   * Round 4c/4d: run a neighborhood campaign in a live, active cabinet's
   * area (an awareness burst there). Cost = customers.quoteCampaign(...).cost,
   * posted as 'marketing'. One per area at a time, then a cooldown. See
   * customers.runCampaign.
   */
  | { type: 'runCampaign'; cabinet: CabinetId }
  /** Round 4c/4d: set the support level (its cost per customer from the next daily accrual). Free now. See customers.setSupport. */
  | { type: 'setSupport'; level: SupportLevel }
  /** Round 4c/4d: turn referral credits on or off. Free now; each referral signup costs 2 x REFERRAL_CREDIT at the close. See customers.setReferrals. */
  | { type: 'setReferrals'; on: boolean };

/**
 * On success `cost` is the net cash spent now: negative for a refund or money
 * borrowed, 0 for free commands. A command's cost is exactly the change in cash
 * it caused (negated).
 */
export type CommandResult = { ok: true; cost: number } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Quotes and previews (pure functions of state; never saved)
// ---------------------------------------------------------------------------

/** Cost-per-passing color band: green <= CPP_TARGET, amber <= CPP_TARGET x CPP_AMBER_MULTIPLIER, red above. */
export type CppBand = 'green' | 'amber' | 'red';

export type QuoteLineKind = 'cable' | 'rock' | 'makeReady' | 'engineering' | 'permit';

/** One itemized row of a cable quote. Lines with quantity 0 are omitted. */
export interface QuoteLine {
  kind: QuoteLineKind;
  /** e.g. "Underground bore", "Rock surcharge", "Make-ready (14 poles)", "Engineering", "City permit", "Pole attachment application". */
  label: string;
  /** Feet for cable/rock, poles for makeReady, 1 for per-order fees. */
  quantity: number;
  unit: 'ft' | 'pole' | 'order';
  /** Dollars per unit (a per-ft rate may be fractional). */
  rate: number;
  /**
   * Whole dollars. For per-span charges this is the sum of the per-span rounded
   * amounts, so the lines always sum exactly to CableQuote.cost.
   */
  amount: number;
  /** Refunded (x PERMITTING_CANCEL_REFUND) if cancelled while permitting: true for cable and rock only. */
  refundable: boolean;
}

/** Pre-flight estimate the UI shows before the player commits a layCable. */
export interface CableQuote {
  ok: boolean;
  /** Human-readable blockers; empty when ok. */
  reasons: string[];
  /** Segments that would get new cable (already-cabled segments are skipped, never charged), in request order. */
  newSegments: SegmentId[];
  lengthFt: number;
  /** Total whole dollars = sum of lines[].amount. */
  cost: number;
  /** Itemization of `cost`: cable rate x ft, rock surcharge, make-ready poles, per-order fees. */
  lines: QuoteLine[];
  /** Sum of the refundable lines. */
  refundable: number;
  /** cost / lengthFt (0 when lengthFt is 0). Not rounded. */
  costPerFt: number;
  /** Permitting estimate range in days; construction days for the longest new span. */
  permitDaysMin: number;
  permitDaysMax: number;
  constructDays: number;
  /**
   * Largest remembered permitting draw (MakeReadyMemo) among the new segments
   * for this method, or null when none is remembered. When every new segment is
   * remembered, permitDaysMin === permitDaysMax === this.
   */
  rememberedPermitDays: number | null;
  /** Units on parcels that exist today and are served by (front) the new segments. */
  passingsAlong: number;
  /** Units on parcels served by the new segments that appear later (town growth). */
  passingsFuture: number;
  /**
   * Of passingsAlong, the units that would be passed once this order and
   * everything already ordered (spans and cabinets in any stage) is live:
   * i.e. CO-connected and within CABINET_REACH_FT of a cabinet along cable.
   */
  passingsInReach: number;
  /** cost / passingsAlong (null when passingsAlong is 0). Not rounded. */
  cpp: number | null;
  cppBand: CppBand | null;
  /**
   * Existing parcels that touch a new segment but are served from another
   * street that is neither in this order nor already cabled: "N buildings along
   * this route face another street". Ascending ids.
   */
  wrongSideParcels: ParcelId[];
  /**
   * Round 4b: the storm (and, underground, dig-in) exposure of the new
   * segments as this method would build them (weather.stormRisk summed, and
   * the exposure bands of weather.segmentExposure): the aerial quote card's
   * storm-risk line. Null when there are no new segments.
   */
  stormRisk: CableStormRisk | null;
}

/** Round 4b: how exposed a street is to storms (weather.exposureBand of weather.segmentExposure). */
export type ExposureBand = 'sheltered' | 'moderate' | 'exposed';

/** Round 4b: a cable quote's storm exposure (CableQuote.stormRisk). Estimates, not rounded. */
export interface CableStormRisk {
  method: CableMethod;
  /** Sums over the new segments of weather.stormRisk(segment, method). */
  outagesPerYear: number;
  repairCostPerYear: number;
  outageDaysPerYear: number;
  /** The most exposed band among the new segments. */
  band: ExposureBand;
  /** Feet of the new segments in the 'exposed' band. */
  exposedFt: number;
}

export interface CabinetQuote {
  ok: boolean;
  reasons: string[];
  cost: number;
  permitDays: number;
  constructDays: number;
  /** Splitters it starts with (CABINET_START_SPLITTERS) and the subscriber ports they give. */
  splitters: number;
  ports: number;
}

export interface SplitterQuote {
  ok: boolean;
  reasons: string[];
  cost: number;
  /** Cabinet splitters and subscriber ports after the addition. */
  splittersAfter: number;
  portsAfter: number;
  /** OLT PON ports in use after the addition, and the OLT's total. */
  ponPortsUsedAfter: number;
  ponPorts: number;
}

export interface RemoveCabinetQuote {
  ok: boolean;
  reasons: string[];
  /** Whole dollars refunded (0 once construction has started). */
  refund: number;
  /** OLT PON ports freed (its splitters). */
  ponPortsFreed: number;
  /**
   * Subscriber units who would lose service at the next daily step: those on
   * this cabinet that no other active cabinet in reach of their street has a
   * free port for (the rest move to such a cabinet).
   */
  subscribersAffected: number;
}

export interface RemoveSpanQuote {
  ok: boolean;
  reasons: string[];
  /** Whole dollars refunded: round(refundable x PERMITTING_CANCEL_REFUND) while permitting, else 0. */
  refund: number;
  /**
   * Subscriber units who would lose service at the next daily step: on this
   * street, or downstream of it and cut off from the CO or from every
   * cabinet's reach (a subscriber whose own cabinet no longer reaches them
   * moves to another cabinet in reach with a free port instead, if there is
   * one). 0 unless the span is live.
   */
  subscribersAffected: number;
  /** Units passed today that would no longer be passed (this street and everything cut off beyond it). */
  passingsLost: number;
}

export interface OltCardQuote {
  ok: boolean;
  reasons: string[];
  cost: number;
  cardsAfter: number;
  ponPortsAfter: number;
}

/** One street segment inside a coverage preview's reach. */
export interface CoverageSegment {
  segment: SegmentId;
  /** Street distance (ft) from the preview node to the segment's nearer endpoint; < CABINET_REACH_FT. */
  distanceFt: number;
  /**
   * Has live cable connected to the CO today. Being connected is not enough to
   * be lit by a cabinet here: see litOnPlacement.
   */
  connected: boolean;
  /**
   * A live cabinet here would light and serve it today: connected, within
   * CABINET_REACH_FT of this corner along today's live cable (which can be
   * longer than the street distance), and nearer than any active cabinet.
   */
  litOnPlacement: boolean;
  /**
   * Cabinet (other than one at the preview node) that serves it once
   * everything already ordered is built (live cabinets today included, and
   * ones still permitting or under construction), else null.
   */
  servedBy: CabinetId | null;
}

/**
 * What a cabinet at `node` could cover, measured along streets (cable not
 * required): the shading and count card of the cabinet tool. The street reach
 * is what it could serve once cable joins it; litOnPlacement and
 * passingsPassableToday are what it would serve on today's live cable.
 */
export interface CoveragePreview {
  node: NodeId;
  reachFt: number;
  /** Every segment whose nearer endpoint is < reachFt from node along streets, ascending by segment id. */
  segments: CoverageSegment[];
  /** Units on existing parcels served by those segments. */
  passingsNow: number;
  /** Units on parcels served by those segments that appear later. */
  passingsFuture: number;
  /** Of passingsNow: on segments another cabinet serves, or will once what is already ordered is built (servedBy). */
  passingsServedElsewhere: number;
  /** Of passingsNow, not served elsewhere: on litOnPlacement segments, so passed as soon as this cabinet is live. */
  passingsPassableToday: number;
  /** Price of a cabinet here (0 when one already stands here). */
  cabinetCost: number;
  /**
   * Estimated cable cost to cable every in-reach segment that has no span yet:
   * per segment the cheaper buildable method (aerial where poled, else
   * underground) including rock and make-ready, plus the per-order fees
   * (engineering and right-of-way application) of one order per method used,
   * as a cable quote charges them.
   */
  buildOutCost: number;
  /** (cabinetCost + buildOutCost) / (passingsNow - passingsServedElsewhere); null when that is <= 0. Marginal, not lifetime. */
  projectedCpp: number | null;
  projectedCppBand: CppBand | null;
  /** Subscriber ports a new cabinet starts with (CABINET_START_SPLITTERS x SPLIT_RATIO). */
  ports: number;
}

// ---------------------------------------------------------------------------
// Financing quotes (pure functions of state, debt.ts; never saved)
// ---------------------------------------------------------------------------

/** A rate with its parts, for a quote or offer. All bps. */
export interface RateBreakdown extends RateParts {
  /** PENALTY_STEP_UP_BPS while the covenant stage is 'penalty' or 'frozen', else 0. Charged on every balance; never fixed into a loan. */
  penaltyBps: number;
  /** baseBps + leverageBps + cppBps + productBps: what a term loan fixes, or the line's rate until the next close. */
  rateBps: number;
  /** rateBps + penaltyBps: what is charged today. */
  effectiveRateBps: number;
  /** Leverage the leverage spread was priced on (x, unrounded): 0 with no debt, null when unmeasurable. */
  leverage: number | null;
  /** Lifetime cost per passing the CPP spread was priced on (dollars, unrounded); null while nothing is passed (no CPP spread). */
  cpp: number | null;
  cppBand: CppBand | null;
}

/**
 * The covenant tests and the figures behind them (debt.covenantMetrics).
 * Cash flows are annualized from the trailing closed months; debt is today's.
 */
export interface CovenantMetrics {
  /** Credit-line balance + term-loan balances (pro forma: plus the quoted amount). */
  totalDebt: number;
  /** Annualized trailing recurring revenue (debt.trailingArr). */
  arr: number;
  /** Annualized trailing operating cash flow (financing and capex excluded; round 4: repairs at their past-year total, debt.annualOperatingCashFlow); may be negative. */
  annualOperatingCashFlow: number;
  /**
   * Cash flow the lender counts: max(annualOperatingCashFlow, arr x
   * UNDERWRITING_MIN_MARGIN), so a young network is judged on its recurring
   * revenue while its operating cash flow is <= 0 or small. May be <= 0
   * (no revenue yet and burning cash).
   */
  underwritingCashFlow: number;
  /**
   * Scheduled debt service over the next 12 months at today's effective rates
   * (debt.annualDebtService): each loan's next min(12, monthsLeft) payments as
   * the closes will charge them, the last one exact, + the line's balance x
   * effective rate for a year.
   */
  annualDebtService: number;
  /**
   * totalDebt / underwritingCashFlow (x) to the hundredth, as shown and as the
   * covenant and pricing use it; 0 with no debt; null when debt > 0 and
   * underwritingCashFlow <= 0 (unmeasurable: a breach).
   */
  leverage: number | null;
  /** underwritingCashFlow / annualDebtService (x) to the hundredth, may be <= 0; null when annualDebtService is 0. */
  coverage: number | null;
  /** No debt, or leverage measurable and <= COVENANT_MAX_LEVERAGE (to the hundredth: 5.00x passes). */
  leverageOk: boolean;
  /** Nothing scheduled, or coverage >= COVENANT_MIN_COVERAGE (to the hundredth). */
  coverageOk: boolean;
  /** leverageOk && coverageOk. */
  compliant: boolean;
}

/** The credit line as the bank offers it today (debt.creditOffer). */
export interface CreditOffer {
  /** Limit: floor to LOAN_ROUNDING of trailingArr x CREDIT_LIMIT_ARR_MULTIPLE (stable within a month: closed months only). */
  limit: number;
  balance: number;
  /** What a draw may take now: max(0, limit - balance), 0 while frozen. */
  available: number;
  /** Most a repayment may be now: min(balance, max(0, cash)). */
  maxRepay: number;
  frozen: boolean;
  /** The line's rate (stored parts, priced at the last close) plus today's penalty surcharge. leverage/cpp are those of the last close (0 / null before the first). */
  rate: RateBreakdown;
  /** Interest accrued so far this month at the effective rate (what the next close charges for days already past). */
  accruedInterest: number;
  /** trailingArr: the base of the limit. */
  arr: number;
  /** Why a draw is impossible now (frozen, no limit yet, limit used up); empty when available > 0. */
  reasons: string[];
}

/** A term loan as the bank would write it today (debt.quoteTermLoan). */
export interface TermLoanQuote {
  /**
   * takeTermLoan would accept it: the game is not over, termYears is one of
   * TERM_LOAN_YEARS, amount is a whole number >= TERM_LOAN_MIN and <=
   * maxAmount, and the stage is not 'frozen'. A covenant breach does not
   * block it (see breachesCovenant).
   */
  ok: boolean;
  /** Player-facing blockers; empty when ok. */
  reasons: string[];
  /** Requested amount (as given). */
  amount: number;
  termYears: TermYears;
  termMonths: number;
  /** Most a new term loan may be now: floor to LOAN_ROUNDING of trailingArr x TERM_CAPACITY_ARR_MULTIPLE - term balances (0 while frozen or below TERM_LOAN_MIN). */
  maxAmount: number;
  /** Priced on pro forma leverage (debt + amount) and today's lifetime CPP. */
  rate: RateBreakdown;
  /**
   * Level monthly payment at rate.effectiveRateBps (debt.levelPayment: the
   * penalty included while it lasts, re-set when it lifts); 0 when the amount
   * is invalid.
   */
  payment: number;
  /** The final regular payment (absorbs rounding), from the exact schedule at rate.effectiveRateBps. */
  lastPayment: number;
  /** Interest-only charge at this month's close for the days from today to month end (debt.stubDays), at the effective rate. */
  stubInterest: number;
  /** stubInterest + every regular payment's interest at rate.effectiveRateBps (as if today's rate held for the whole term), from the exact schedule. */
  totalInterest: number;
  /** Covenant figures today and pro forma with this loan (today's cash flows: the build it funds is not counted). */
  before: CovenantMetrics;
  after: CovenantMetrics;
  /** !after.compliant: taking it would breach a covenant at the next close unless cash flow improves. */
  breachesCovenant: boolean;
  /** Cash after the proceeds arrive. */
  cashAfter: number;
  /**
   * Round 4: term loans taken earlier this month that this loan would
   * re-price (same-month loans are priced together, on the leverage of all of
   * them: no discount for splitting one loan into slices), ascending loan id;
   * empty when there are none. `after` and `payment` already count them.
   */
  repriced: RepricedLoan[];
  /**
   * Round 4: the largest amount of this term whose pro forma covenants stay
   * compliant (debt.maxSafeTermLoan), a multiple of LOAN_ROUNDING, 0 when no
   * loan of at least TERM_LOAN_MIN would be. The Bank's builder starts there.
   */
  safeMaxAmount: number;
}

/** A same-month term loan re-priced by a new one (TermLoanQuote.repriced). */
export interface RepricedLoan {
  loan: LoanId;
  /** Its fixed rate now and after (bps, no penalty). */
  rateBps: number;
  rateBpsAfter: number;
  /** Its level payment now and after (at the effective rate). */
  payment: number;
  paymentAfter: number;
}

/** Round 4: what a credit-line draw would do (debt.quoteDraw), for the Bank's covenant preview. */
export interface DrawQuote {
  /** drawCredit would accept it (whole dollars, 1..available, not frozen); a covenant breach does not block it. */
  ok: boolean;
  reasons: string[];
  amount: number;
  /** Covenant figures today and with the draw (its year of interest added to the debt service). */
  before: CovenantMetrics;
  after: CovenantMetrics;
  /** !after.compliant. */
  breachesCovenant: boolean;
  cashAfter: number;
  /** Interest the draw adds to this month's close if held to month end (stub days at the effective rate). */
  interestToClose: number;
}

/**
 * Round 4: how to pay for something that costs more than the cash the player
 * should keep (debt.fundingHint). Used by the quote cards and the advisor;
 * never sizes financing that leaves cash near $0 or breaches a covenant.
 */
export interface FundingHint {
  cost: number;
  /** Cash the hint keeps after paying: FUNDING_CUSHION_MONTHS of fixed costs (overhead + marketing) plus the next close's debt service. */
  cushion: number;
  /** max(0, cost + cushion - cash): what financing must bring in. */
  shortfall: number;
  /**
   *   cash        - cash covers it and the cushion (draw and termLoan 0)
   *   draw        - a covenant-safe credit-line draw covers the shortfall
   *   term        - a covenant-safe term loan covers it (the line cannot)
   *   drawAndTerm - both together cover it
   *   short       - no covenant-safe financing covers it (draw/termLoan show the most there is)
   */
  kind: 'cash' | 'draw' | 'term' | 'drawAndTerm' | 'short';
  /** Suggested draw, whole dollars (a multiple of LOAN_ROUNDING unless it is all that is available), 0 for none. */
  draw: number;
  /** Suggested term loan (TERM_LOAN_MIN..its safe maximum, a multiple of LOAN_ROUNDING), 0 for none, and its term. */
  termLoan: number;
  termYears: TermYears;
}

/**
 * Round 4: one way to bring the covenants back into compliance
 * (debt.cureOptions). Every option is verified pro forma: it makes both
 * tests pass at today's figures, and it leaves at least the next close's
 * debt service plus FUNDING_CUSHION_MONTHS of fixed costs in cash (so it
 * cannot turn into a missed payment). Advice that cannot be verified is
 * never offered.
 */
export interface CureOption {
  /**
   * repayCredit / prepayLoan: a command that cures it now; grow: the yearly
   * operating cash flow that would (no command); repayAll: repaying the line
   * and every loan in full (debt.repayAllCure: never among cureOptions, only
   * debt.cureFor).
   */
  kind: 'repayCredit' | 'prepayLoan' | 'grow' | 'repayAll';
  /** The loan to prepay (prepayLoan), else null. */
  loan: LoanId | null;
  /** Dollars to repay or prepay (repayAll: everything owed); for grow, the extra annual operating cash flow needed. */
  amount: number;
  /** Covenant figures after it (for grow: with that cash flow). */
  after: CovenantMetrics;
  /** Cash after it (for grow: today's cash). */
  cashAfter: number;
  /** One plain-language sentence with the figures ("Repay $42,000 of the credit line: leverage 4.6x, coverage 1.3x"). */
  text: string;
}

/** What prepaying a term loan would take (debt.quotePrepay). */
export interface PrepayQuote {
  ok: boolean;
  reasons: string[];
  loan: LoanId;
  /** Principal prepaid (as given). */
  amount: number;
  /** Interest accrued on `amount` since the later of the loan's origination and the 1st of this month, at the effective rate. */
  accruedInterest: number;
  /** amount + accruedInterest: the cash it takes. */
  total: number;
  /** Repays the whole balance (the loan closes). */
  paysOff: boolean;
  /** Re-amortized level payment over the same months left at the effective rate (0 when it pays off). */
  paymentAfter: number;
  /**
   * Round 4c/4d: the covenant figures after the prepayment (today's cash
   * flows; the loan's balance and payment as they would be), for the Bank's
   * "its effect on bank health" words. Today's figures when the quote is not ok.
   */
  after: CovenantMetrics;
}

/** Round 4c/4d: what repaying the credit line would do (debt.quoteRepay), for the Bank's emergency-cash preview. */
export interface RepayQuote {
  /** repayCredit would accept it: whole dollars, 1..min(balance, cash), game not over. */
  ok: boolean;
  reasons: string[];
  amount: number;
  /** Covenant figures today and after the repayment (the line's balance less the amount; its year of interest gone from the debt service). */
  before: CovenantMetrics;
  after: CovenantMetrics;
  cashAfter: number;
}

/**
 * Round 4c/4d: the Bank's health in plain words (debt.bankHealth). The
 * level maps to the words the HUD chip, the Bank and the month summary all
 * use (ui/health.ts): good "Good", watch "Watch", warning "Warning",
 * penalty "Higher interest", frozen "No more borrowing".
 */
export type BankHealthLevel = 'good' | 'watch' | 'warning' | 'penalty' | 'frozen';

export interface BankHealth {
  level: BankHealthLevel;
  /** Nothing owed (level 'good'; the checks read as not needed). */
  noDebt: boolean;
  /** Compliant stage, but today's figures break a check (level 'watch'): the old "At risk". */
  failingNow: boolean;
  /** Compliant stage, both checks pass, but within BANK_WATCH_HEADROOM of a limit (level 'watch'). */
  nearLimit: boolean;
  /** Today's covenant figures (debt.covenantMetrics). */
  metrics: CovenantMetrics;
  /** PENALTY_STEP_UP_BPS while 'penalty' or 'frozen', else 0. */
  penaltyBps: number;
  /** Frozen with debt and not yet called: closes until the bank calls the loans (debt.closesUntilAcceleration), else null. */
  closesUntilCalled: number | null;
  /** The bank has called the loans (Debt.acceleration), whatever the stage. */
  called: boolean;
}

// ---------------------------------------------------------------------------
// Round-4 quotes (pure functions of state; never saved)
// ---------------------------------------------------------------------------

/** What a setPricing would do to today's subscribers (sales.quotePricing), for the pricing panel. */
export interface PricingQuote {
  /** setPricing would accept it. */
  ok: boolean;
  reasons: string[];
  /** grandfatherMonths as it would apply (the default when omitted). */
  grandfatherMonths: number;
  /** Subscriber units whose price rises: they keep their price until the locks end. */
  unitsRising: number;
  /** Subscriber units whose price falls at once. */
  unitsFalling: number;
  /** Close day the new locks end (their price step), or null when nothing rises. */
  locksEndDay: number | null;
  /** MRR right after the change (locks held) and once every lock it creates has ended, for today's subscribers. */
  mrrNow: number;
  mrrAfterLocks: number;
  /** Units on tiers it stops offering: they move to another tier at the next close. */
  unitsMoving: number;
  /** Expected cancellations from its price steps and tier moves (an estimate, rounded), at the closes they happen. */
  expectedChurn: number;
  /**
   * Round 4c (spec C): mrrAfterLocks less what the expected cancellations
   * (expectedChurn) would have paid, so the drop-tiers preview counts the
   * cancellations it lists. Whole dollars, <= mrrAfterLocks.
   */
  mrrAfterChurn: number;
}

/** What converting an aerial span to underground would take (network.quoteConvert). */
export interface ConvertQuote {
  ok: boolean;
  reasons: string[];
  span: SpanId;
  /** Whole dollars: underground construction and rock for the segment, engineering and the city permit (lines sum to it). */
  cost: number;
  lines: QuoteLine[];
  permitDaysMin: number;
  permitDaysMax: number;
  constructDays: number;
  /** Pole rent it stops once live, dollars a month. */
  poleRentSaved: number;
  /** Expected storm repair cost a year it avoids (weather.stormRisk aerial minus underground), dollars (an estimate). */
  repairsAvoidedPerYear: number;
  /** Round 4b: the span's street's storm exposure band (weather.exposureBand of weather.segmentExposure). */
  exposure: ExposureBand;
}

/**
 * Round 4b: the households a price lineup wins, by price sensitivity
 * (balance.DEMAND_SEGMENTS: value seekers who only take a cheap tier,
 * mainstream, speed seekers). sales.segmentDemand; the pricing panel's
 * "who signs up" rows.
 */
export type DemandSegmentId = 'value' | 'mainstream' | 'speed';

/** One demand segment's response to a lineup (sales.segmentDemand). */
export interface SegmentDemand {
  segment: DemandSegmentId;
  /** Its share of households (DEMAND_SEGMENTS share; the shares sum to 1). */
  share: number;
  /** Its target take rate under the lineup, 0..1 (before TAKE_RATE_KIND_FACTOR: a household's). */
  takeRate: number;
  /** The tier it would mostly take, or null when no offered tier suits it (it does not sign up). */
  tier: TierId | null;
}

/**
 * Round 4b: what a retention offer answering the incumbent's promo at
 * `cabinet` would cost and save (incumbent.quoteRetention), for the pricing
 * panel and the advisor. Estimates rounded to whole dollars / units.
 */
export interface RetentionQuote {
  /** answerIncumbent would accept it: a promo runs there now, not answered yet, with subscribers. */
  ok: boolean;
  reasons: string[];
  cabinet: CabinetId;
  /** Subscribed units on accounts of that cabinet today. */
  units: number;
  /** RETENTION_PERCENT_OFF. */
  percentOff: number;
  /** Month closes until the promo ends (the locks' length). */
  months: number;
  /** Revenue a month the offer gives up (MRR now less with the locks). */
  monthlyCost: number;
  /** monthlyCost x months. */
  totalCost: number;
  /** Cancellations the promo is expected to cause there over its remaining months that the offer avoids. */
  cancellationsAvoided: number;
  /** What those cancellations would cost (lost margin until replaced, reinstalls), dollars. */
  valueSaved: number;
  /** valueSaved > totalCost: the advisor recommends it only then. */
  pays: boolean;
}

/**
 * Round 4b: the best answer to the incumbent's promo at a cabinet
 * (incumbent.bestIncumbentAnswer): the remedy that pays most, or none when
 * nothing beats waiting it out. The advisor's incumbentPromo card says this
 * and only this; the pricing panel shows the same figures.
 */
export interface IncumbentAnswer {
  cabinet: CabinetId;
  /** retention: answerIncumbent pays; introPromo: setPromo(promo) pays; none: nothing pays (or the promo is answered or over). */
  kind: 'retention' | 'introPromo' | 'none';
  /** The retention offer's quote (always computed). */
  retention: RetentionQuote;
  /** The intro promo it weighed (kind introPromo: the one to set), else null. */
  promo: IntroPromo | null;
  /** What the remedy is worth beyond its cost, dollars (0 for none). */
  netValue: number;
  /** One plain-language sentence with the figures; round 4c/4d: for none, one sentence saying ignoring the promo is fine there, and why (empty only when the promo is answered or over). */
  text: string;
}

/**
 * Round 4b: what an intro promo would do (sales.quotePromo), for the pricing
 * panel ("when it pays") and the advisor. Estimates over PROMO_QUOTE_MONTHS.
 */
export interface PromoQuote {
  /** setPromo would accept it (null: always). */
  ok: boolean;
  reasons: string[];
  promo: IntroPromo | null;
  /** Units waiting to sign up across lit areas today (target take less subscribed), the gap a promo speeds up. */
  waitingUnits: number;
  /** Round 4c/4d fix: the quote's horizon, months (the promo's own months plus PROMO_QUOTE_MONTHS, so the step churn when its locks end is inside it). */
  months: number;
  /** Extra signups the promo brings within the horizon (its signup boost and lift on the waiting gap where it applies). */
  extraSignups: number;
  /** Revenue given up on the discounted signups within the horizon, dollars. */
  discountCost: number;
  /** Margin the extra (and earlier) signups bring within the horizon, less the installs and splitters they need, dollars (at least 0). */
  valueGained: number;
  /** valueGained > discountCost. */
  pays: boolean;
  /** One plain-language sentence on when it pays ("Pays while you light new areas: ..."). */
  advice: string;
}

/**
 * Round 4b: everything a new cabinet at `node` needs to light what it
 * reaches (coverage.buildOutPlan), as commands a player (or the advisor's
 * expand suggestion, or a bot following it) can send in order.
 */
export interface BuildOutPlan {
  node: NodeId;
  /** Uncabled segments joining the node to the planned plant (network.cableRoute from the nearest planned plant node), in route order; empty when already joined. */
  feeder: SegmentId[];
  /** Uncabled segments within CABINET_REACH_FT of the node along streets (coveragePreview's build-out), ascending. */
  reach: SegmentId[];
  /** Feeder and reach segments by method (weather.preferredMethod per segment), each ascending: one layCable order per non-empty list. */
  aerial: SegmentId[];
  underground: SegmentId[];
  /** placeCabinet (when none stands there), then layCable aerial, then layCable underground. */
  commands: Command[];
  /** Cabinet price plus both orders' quoteCable costs, dollars. */
  cost: number;
  /** Units on existing parcels the plan would newly pass (not served elsewhere: coveragePreview). */
  passings: number;
  /** cost / passings, or null when passings is 0. */
  cpp: number | null;
}

/** Expected yearly storm and dig-in exposure of a span of `method` on a segment (weather.stormRisk). */
export interface StormRisk {
  /** Expected outages a year. Not rounded. */
  outagesPerYear: number;
  /** Expected repair dollars a year. Not rounded. */
  repairCostPerYear: number;
  /** Expected days out of service a year. Not rounded. */
  outageDaysPerYear: number;
}

// ---------------------------------------------------------------------------
// Advisor and month-end briefing (round 4; advisor.ts; derived, never saved)
// ---------------------------------------------------------------------------

/** Which advisor rule produced an advice (each fires at most once per call). */
export type AdviceId =
  | 'paymentShort' // the next close's debt service is not covered: raise cash now or it is a missed payment / default
  | 'loansCalled' // the bank has called the loans: what falls due at each close
  | 'covenantCure' // a covenant is breached or at risk: a verified cure (debt.cureOptions)
  | 'frozenSweep' // frozen: the sweep and the countdown to acceleration, and what lifts the freeze
  | 'cashRunway' // runway short or installs paused: credit line / slow builds
  | 'addSplitter' // a cabinet is full (or nearly): add a splitter there
  | 'addOltCard' // OLT PON ports nearly or all used: buy a line card
  | 'outages' // spans are out after a storm: what it is costing
  | 'stormUnderground' // aerial spans hit repeatedly: convert or build underground there
  | 'incumbentPromo' // the incumbent is running a promo in an area: price / marketing response
  | 'takeRate' // take rate lagging its target: price or marketing
  | 'pricing' // a tier priced far from what the market bears
  | 'lineup' // round 4c/4d: the cheap tiers are not offered: value seekers do not sign up
  | 'support' // round 4c/4d: outages or unhappiness drive cancellations: Great support pays (or Basic costs customers)
  | 'growCustomers' // round 4c/4d: lit areas under-signed: the cheapest way to more customers (marketing, a campaign, referral credits or a new street)
  | 'redCpp' // red-CPP builds are raising the rate on new debt
  | 'firstBuild' // round 4c/4d: nothing lit yet: a concrete first build sized to the cash
  | 'expand'; // idle cash or safe borrowing room with green-CPP corners nearby: build there

export type AdviceSeverity = 'urgent' | 'important' | 'tip';

/** A panel the UI can open for an advice (round 4c/4d: 'customers', the Customers dashboard). */
export type AdvicePanel = 'pricing' | 'bank' | 'olt' | 'customers';

/** What "Show me" does: move the camera to a place (and highlight it), or open a panel. */
export type AdviceAction =
  | { kind: 'focusNode'; node: NodeId }
  | { kind: 'focusSegment'; segment: SegmentId }
  | { kind: 'focusCabinet'; cabinet: CabinetId }
  | { kind: 'openPanel'; panel: AdvicePanel };

/** One ranked suggestion (advisor.advise). */
export interface Advice {
  id: AdviceId;
  /**
   * Round 4b: the suggestion's identity for snoozes and repeats: its rule and
   * subject, e.g. "addSplitter:cabinet:12", "expand:node:345",
   * "pricing:fiber2g", "cashRunway" (1..ADVICE_KEY_MAX_LENGTH characters, no
   * whitespace). Two suggestions with the same key are the same advice; a
   * different subject is a different one (a snooze does not silence it).
   */
  key: string;
  /**
   * Round 4b: how many month-end briefings in a row before this one showed
   * this key (AdvisorState.shown); 0 = new. The advisor words a repeat
   * differently (never word for word); the briefing may compact it.
   */
  repeat: number;
  /**
   * Rank: higher first (ties by AdviceId order above). Bands: urgent 300-399,
   * important 200-299, tip 100-199, so severity and priority always agree.
   */
  priority: number;
  severity: AdviceSeverity;
  /**
   * Short imperative, e.g. "Add a splitter at Elm St & 3rd Ave". Round 4c/4d
   * (spec B): at most advisor.ADVICE_TITLE_MAX (~45) characters.
   */
  title: string;
  /**
   * Plain-language reason built from the game's figures. Round 4c/4d (spec
   * B): ONE sentence of at most advisor.ADVICE_WHY_MAX (~90) characters that
   * names the cost when there is one ("It's full and 12 homes are waiting.
   * Costs $1,800."); it leads the month summary's next-step card. Longer
   * reasoning goes in `detail`.
   */
  why: string;
  /**
   * Round 4c/4d: the longer reasoning (figures, alternatives, how it is
   * financed), shown only behind the card's own disclosure; '' when the
   * short `why` says it all.
   */
  detail: string;
  /** Round 4c/4d: what following it costs now, whole dollars (null: no cost, or not a purchase). */
  cost: number | null;
  action: AdviceAction;
  /** Button label: "Show me" for a place, "Open Pricing" / "Open Bank" / "Open OLT" / "Open Customers" for a panel. */
  actionLabel: string;
}

/** Keys of the "what changed" rows of a briefing. */
export type BriefingChangeKey = 'net' | 'cash' | 'subscribers' | 'passings' | 'takeRate' | 'cpp' | 'revenue' | 'operatingCashFlow' | 'debt';

/** One "what changed" row: this period's figure against the one `span` months earlier. */
export interface BriefingChange {
  key: BriefingChangeKey;
  label: string;
  /** null where the figure does not exist (no stats on an old report, nothing passed). */
  now: number | null;
  before: number | null;
  /** now - before, or null when either is null. */
  delta: number | null;
  /** Whether a rise is good news (cost per passing and debt: false), or null for neutral. */
  upIsGood: boolean | null;
  unit: 'money' | 'count' | 'ratio';
}

/** The month-end briefing (advisor.buildBriefing): everything pertinent about the period that just closed. */
export interface Briefing {
  /** The latest closed month, and the report `span` months before it (null when there is none). */
  report: MonthlyReport;
  previous: MonthlyReport | null;
  /** Months it covers: 1 (a month) or 3 (a quarter). */
  span: number;
  /** "March 2028" or "Jan-Mar 2028". */
  label: string;
  headline: {
    net: number;
    cash: number;
    subscribers: number | null;
    passings: number;
    takeRate: number | null;
    cpp: number | null;
    cppBand: CppBand | null;
    /** CPP_TARGET, for "cost per passing $812 vs $1,000 target". */
    cppTarget: number;
    /** Total debt today, and the covenant stage and today's covenant figures. */
    debt: number;
    stage: CovenantStage;
    covenant: CovenantMetrics;
  };
  changes: BriefingChange[];
  /** The period's notices still in the log (ids after the previous report's ops.lastNoticeId), oldest first. */
  notices: Notice[];
  /** The period's ledger totals by category (revenue first, then costs), summed over its months. */
  breakdown: { category: LedgerCategory; amount: number }[];
  forward: {
    /** Day of the next month close. */
    nextCloseDay: number;
    /** Estimated debt service at the next close (debt.estimateNextDebtService). */
    nextPayment: number;
    /**
     * Cash projected after the next close: at its debt step
     * (finance.estimateCashAtClose), less the next payment and, while the line
     * is frozen, the sweep (debt.estimateSweep).
     */
    projectedCash: number;
    /** The frozen-line sweep expected at the next close (debt.estimateSweep: 0 unless frozen), included in projectedCash. */
    sweep: number;
    /** finance.runwayMonths: null when not burning. */
    runwayMonths: number | null;
    /** Frozen: closes until the bank calls the loans (debt.closesUntilAcceleration), else null. */
    closesUntilCalled: number | null;
    /** Loans called: closes left to repay everything, else null. */
    accelerationClosesLeft: number | null;
  };
  /**
   * advisor.advise(state): at most ADVICE_MAX, ranked (snoozed suggestions
   * left out). Round 4c/4d: the first is the month summary's "Your next
   * step"; the rest are its "N more tips".
   */
  advice: Advice[];
  /** Round 4b: suggestions that fired but are snoozed (AdvisorState.snoozes), so not in `advice`. */
  snoozed: number;
  /** Something needs the player: urgent advice, or a period notice of a kind that needs action (advisor.noticeNeedsAttention). */
  needsAttention: boolean;
  /** Round 4c/4d: the period's story, which picks the month summary's headline (see BriefingStory). */
  story: BriefingStory;
  /** Round 4c/4d: the period's money in and out, partitioned for the month summary's two bars (see BriefingMoney). */
  money: BriefingMoney;
  /** Round 4c/4d: the cash card's figures (see BriefingCash). */
  cash: BriefingCash;
  /** Round 4c/4d: at most advisor.ATTENTION_MAX things that need the player now, most pressing first (empty when nothing does). */
  attention: AttentionItem[];
}

/**
 * Round 4c/4d: which headline the month summary leads with:
 *   bank       - bank trouble leads: the covenant stage is warning or worse, or the loans are called;
 *   earned     - money in without borrowing (bills + other) covered money out;
 *   building   - money out was more, but customer bills covered running costs and loan payments (the shortfall is building);
 *   billsShort - customer bills did not cover running costs and loan payments.
 */
export type BriefingStory = 'bank' | 'earned' | 'building' | 'billsShort';

/** Round 4c/4d: the three groups of money out (the month summary's stacked bar). */
export type MoneyGroupKey = 'running' | 'building' | 'loans';

/**
 * Round 4c/4d: one line of the money partition. Money in: bills (revenue),
 * borrowed (loanProceeds: loan proceeds and credit-line draws), otherIn
 * (any group or category that netted positive). Running the business:
 * overheadBase / overheadCustomers / overheadPlant (OpsStats.overhead's
 * lines, when every report of the period has them) or overhead (the whole
 * category otherwise), payroll, poleRent, marketing (campaigns and referral
 * credits included), repair, otherOut. Building fiber: construction,
 * equipment, install, refund (negative: it nets). Loan payments: interest,
 * principal.
 */
export type MoneyLineKey =
  | 'bills'
  | 'borrowed'
  | 'otherIn'
  | 'overheadBase'
  | 'overheadCustomers'
  | 'overheadPlant'
  | 'overhead'
  | 'payroll'
  | 'poleRent'
  | 'marketing'
  | 'campaigns'
  | 'referrals'
  | 'repair'
  | 'otherOut'
  | 'construction'
  | 'equipment'
  | 'install'
  | 'refund'
  | 'interest'
  | 'principal';

export interface MoneyLine {
  key: MoneyLineKey;
  /** Whole dollars, as money in (in lines) or money out (group lines): positive, except a refund netting a group (negative). Lines of 0 are left out. */
  amount: number;
}

export interface BriefingMoneyGroup {
  key: MoneyGroupKey;
  /** Money out of the group over the period, whole dollars >= 0 (a group that netted positive is 0 here and its net is in money in's otherIn). */
  total: number;
  /** Its lines, biggest first; they sum to `total` unless the group netted positive. */
  lines: MoneyLine[];
}

/**
 * Round 4c/4d: the period's money (advisor.buildBriefing), from the ledger
 * totals of its reports only: in - out = cashChange exactly (whole dollars),
 * the change in cash over the period (the sum of the reports' nets).
 */
export interface BriefingMoney {
  /** Money in, whole dollars >= 0: bills + borrowed + otherIn. */
  in: number;
  /** bills, then borrowed and otherIn when non-zero. */
  inLines: MoneyLine[];
  /** Money out, whole dollars >= 0: the groups' totals. */
  out: number;
  /** running, building, loans, always all three (a group may be 0). */
  groups: BriefingMoneyGroup[];
  /** in - out: the period's cash change. */
  cashChange: number;
}

/** Round 4c/4d: the month summary's cash card. */
export interface BriefingCash {
  /** The period's cash change (= money.cashChange). */
  change: number;
  /** Cash at the period's end (report.cashEnd). */
  end: number;
  /** round(change / span): "at this pace you add about $X a month". */
  perMonth: number;
  /** finance.runwayMonths now (null when not burning): what running the business alone burns (the full books' look ahead). */
  runwayMonths: number | null;
  /**
   * Round 4c/4d: how long the cash at the period's end lasts at the period's
   * own pace (perMonth, building included) while cash fell: floor(max(0,
   * end) / -perMonth), 0 when it is gone; null when cash did not fall. The
   * cash card's "At this pace your cash lasts about N months" (spec G.4).
   */
  paceMonths: number | null;
  /** Building fiber's money out was more than 0 this period. */
  building: boolean;
  /** Customer bills less running costs and loan payments over the period ("without building you'd have made $Z" when > 0). */
  withoutBuilding: number;
}

/**
 * Round 4c/4d: kinds of the month summary's "Needs attention" lines:
 *   bankStage   - the covenant stage stepped up at the close (a warning, higher interest, no more borrowing);
 *   bankWatch   - compliant with debt, but today's figures fail a check (the old "At risk");
 *   loansCalled - the bank has called the loans;
 *   outage      - plant still out of service at the close;
 *   storm       - a storm hit this period (repaired already);
 *   cabinetFull - a cabinet is full and turning signups away.
 */
export type AttentionKind = 'bankStage' | 'bankWatch' | 'loansCalled' | 'outage' | 'storm' | 'cabinetFull';

export interface AttentionItem {
  kind: AttentionKind;
  /** What its button does: open the Bank, or show the place. */
  action: AdviceAction;
  /** The place it is about ("Elm St & 3rd Ave"), or null. */
  place: string | null;
  /** Its count when it has one (homes waiting at a full cabinet, spans out, storms), else null. */
  count: number | null;
  /** bankStage: the stage now; else null. */
  stage: CovenantStage | null;
}

// ---------------------------------------------------------------------------
// Customers queries and quotes (round 4c/4d; customers.ts; derived, never saved)
// ---------------------------------------------------------------------------

/**
 * Why a lit household has not signed up (one main reason each):
 *   unaware      - doesn't know you yet (awareness);
 *   deciding     - knows you and would switch at your prices (inside its street's target), but hasn't yet:
 *                  switching takes time (awareness x the daily pace), which word of mouth, referral credits,
 *                  a campaign or a better deal speed up;
 *   notWorth     - knows you, but your deal is not worth switching for (beyond the street's target: value vs cable for its segment);
 *   tooExpensive - no offered plan within its segment's reservation price;
 *   waiting      - wants to switch but waits for an install or a free port (cabinet full, installs paused, its street cut off).
 */
export type SwitchReason = 'unaware' | 'deciding' | 'notWorth' | 'tooExpensive' | 'waiting';

/** Counts by reason, in units (customers.whyNotSwitched). */
export interface SwitchReasonCounts {
  unaware: number;
  deciding: number;
  notWorth: number;
  tooExpensive: number;
  waiting: number;
  /** Lit units not signed up: exactly unaware + deciding + notWorth + tooExpensive + waiting. */
  unsigned: number;
  /** Units passed (on lit streets) and subscribed units there. */
  passings: number;
  subscribed: number;
  /**
   * Units on existing parcels of cabled streets that are not lit yet (their
   * cable is still being built, or no cabinet reaches them): not part of
   * `unsigned`. 0 in a per-area row (no cabinet serves them).
   */
  notLit: number;
}

export interface AreaSwitchReasons extends SwitchReasonCounts {
  cabinet: CabinetId;
}

export interface SwitchReasons {
  overall: SwitchReasonCounts;
  /** One per active cabinet serving lit streets, ascending cabinet; their counts sum to overall's (notLit aside). */
  areas: AreaSwitchReasons[];
}

/** Round 4c/4d: a customer's happiness bucket (balance HAPPY_SCORE_MIN / UNHAPPY_SCORE_MAX). */
export type HappinessBucket = 'happy' | 'okay' | 'unhappy';

/**
 * What moves a customer's happiness:
 *   support       - the support level (Basic lowers it, Great raises it);
 *   outages       - days without service in the recent past;
 *   priceVsCable  - pays more than cable's local price for that kind of plan (an incumbent promo);
 *   priceVsMarket - pays more than the market's price for the tier;
 *   goodDeal      - pays less than the market's price for the tier;
 *   priceStep     - its price stepped up recently;
 *   installWait   - waited to be connected.
 */
export type HappinessReason = 'support' | 'outages' | 'priceVsCable' | 'priceVsMarket' | 'goodDeal' | 'priceStep' | 'installWait';

export interface HappinessFactor {
  reason: HappinessReason;
  /** Signed score it adds (positive: happier). Never 0. */
  score: number;
}

/** One account's happiness (customers.accountHappiness). */
export interface AccountHappiness {
  parcel: ParcelId;
  cabinet: CabinetId;
  units: number;
  /** Sum of the factors' scores. */
  score: number;
  bucket: HappinessBucket;
  /** Non-zero factors, most negative first. */
  factors: HappinessFactor[];
}

/** One of the top happiness reasons (HappinessReport.reasons). */
export interface HappinessReasonCount {
  reason: HappinessReason;
  /** 'happy' for a reason that raises happiness (goodDeal, Great support), 'unhappy' for one that lowers it. */
  bucket: 'happy' | 'unhappy';
  /** Subscribed units in that bucket for whom it is the biggest factor. */
  units: number;
  /** The cabinet area holding most of them, or null when no area holds half. */
  cabinet: CabinetId | null;
}

/** Round 4c/4d: happiness across the network (customers.happinessReport). */
export interface HappinessReport {
  /** Subscribed units by bucket; they sum to every subscribed unit. */
  happy: number;
  okay: number;
  unhappy: number;
  /** The top reasons, most units first (at most customers.HAPPINESS_REASONS_MAX). */
  reasons: HappinessReasonCount[];
  /** Per cabinet with accounts, ascending cabinet. */
  areas: { cabinet: CabinetId; happy: number; okay: number; unhappy: number }[];
}

/** Round 4c/4d: one row of the dashboard's Areas list (customers.customerAreas). */
export interface CustomerArea {
  cabinet: CabinetId;
  /** The cabinet's corner. */
  node: NodeId;
  /** Units passed on the streets it serves: the homes it can sell to. */
  passings: number;
  /** Subscribed units on its accounts. */
  subscribed: number;
  /** subscribed / passings, or null with nothing passed. */
  takeRate: number | null;
  /** Whole months since the cabinet went live (null while it is not live). */
  monthsLit: number | null;
  /** Its subscribed units customers.AREA_TREND_MONTHS closes ago (MonthlyReport.customers.areas), or null when unknown (trend: subscribed - this). */
  subscribedBefore: number | null;
  /** Its campaign record (running or cooling down), or null. */
  campaign: NeighborhoodCampaign | null;
}

/** Round 4c/4d: what a marketing budget would do (customers.quoteMarketing). Estimates over `months`. */
export interface MarketingQuote {
  /** setMarketing would accept the budget (and the game is not over). */
  ok: boolean;
  reasons: string[];
  perMonth: number;
  /** CUSTOMER_QUOTE_MONTHS. */
  months: number;
  /** Expected new customers a month at this budget (gross signups over the horizon / months), not rounded. */
  signupsPerMonth: number;
  /** Of those, the ones this budget brings beyond no marketing at all, a month, not rounded (>= 0). */
  extraPerMonth: number;
  /**
   * Round 4c/4d fix: the splitters (and OLT line cards) the extra signups need beyond no marketing over the horizon,
   * dollars (customers.splittersCost).
   */
  splitterCost: number;
  /** (perMonth x months + splitterCost) / (extraPerMonth x months), whole dollars; null when extraPerMonth is about 0 (or the budget is 0). */
  costPerCustomer: number | null;
}

/** Round 4c/4d: what a neighborhood campaign would do (customers.quoteCampaign). Estimates over CUSTOMER_QUOTE_MONTHS. */
export interface CampaignQuote {
  /** runCampaign would accept it now. */
  ok: boolean;
  reasons: string[];
  cabinet: CabinetId;
  /** What it costs now: max(CAMPAIGN_COST_MIN, round(unsignedUnits x CAMPAIGN_COST_PER_UNIT)). */
  cost: number;
  /** Lit units not signed up in the area today, and of them the ones who don't know you yet. */
  unsignedUnits: number;
  unawareUnits: number;
  /** Expected signups it brings beyond no campaign, within the horizon (not rounded). */
  extraSignups: number;
  /** Round 4c/4d fix: the splitters (and OLT line cards) its extra signups need beyond no campaign over the horizon, dollars (customers.splittersCost). */
  splitterCost: number;
  /** (cost + splitterCost) / extraSignups, whole dollars; null when extraSignups is about 0. */
  costPerCustomer: number | null;
  /** Margin the extra signups bring within the horizon (their bills less per-customer costs; installs left out), dollars. */
  valueGained: number;
  /** valueGained > cost + splitterCost. */
  pays: boolean;
  /** When the area's cooldown ends (no campaign before it), or null when none holds it back. */
  availableDay: number | null;
}

/** Round 4c/4d: what a support level would do against today's (customers.quoteSupport). Estimates over SUPPORT_QUOTE_MONTHS (round 4c/4d fix). */
export interface SupportQuote {
  level: SupportLevel;
  /** The horizon of the estimates below, months (SUPPORT_QUOTE_MONTHS). */
  months: number;
  /** setSupport would accept it (always, while the game is not over). */
  ok: boolean;
  reasons: string[];
  /** The support line a month at this level for today's subscribers. */
  costPerMonth: number;
  /** costPerMonth less today's level's (positive: dearer). */
  costChange: number;
  /** Subscribed units by bucket at this level today. */
  happy: number;
  okay: number;
  unhappy: number;
  /** Expected cancellations a month at this level (not rounded). */
  cancellationsPerMonth: number;
  /** Expected new customers a month at this level (word of mouth moves it; not rounded). */
  signupsPerMonth: number;
  /** Round 4c/4d fix: the splitters (and OLT line cards) this level's customers need beyond today's level's over the horizon, dollars. */
  splitterCost: number;
  /** Value over the horizon against today's level: margin of the customers kept and gained less the extra cost and splitterCost (negative: worse). Dollars. */
  netValue: number;
  /** netValue > 0 (false for today's own level). */
  pays: boolean;
}

/** Round 4c/4d: what referral credits on or off would do (customers.quoteReferrals). Estimates over CUSTOMER_QUOTE_MONTHS. */
export interface ReferralQuote {
  on: boolean;
  ok: boolean;
  reasons: string[];
  /** Expected referral signups a month with credits on (those credited; 0 for off), not rounded. */
  referralsPerMonth: number;
  /** referralsPerMonth x 2 x REFERRAL_CREDIT (0 for off). */
  costPerMonth: number;
  /** Signups a month credits on bring beyond credits off (>= 0; 0 for off), not rounded. */
  extraPerMonth: number;
  /** Round 4c/4d fix: the splitters (and OLT line cards) the extra signups credits on bring need over the horizon, dollars (0 for off). */
  splitterCost: number;
  /** (costPerMonth + splitterCost / months) / extraPerMonth, whole dollars; null when extraPerMonth is about 0. */
  costPerCustomer: number | null;
  /** Value over the horizon of this setting against the other (margin of extra customers less credits and splitterCost). Dollars. */
  netValue: number;
  pays: boolean;
}

/** Round 4c/4d: the levers the advisor weighs for more customers (advisor.growthOptions). */
export type GrowthLever = 'marketing' | 'campaign' | 'referrals' | 'build';

/** One way to more customers, priced per customer (advisor.growthOptions). */
export interface GrowthOption {
  lever: GrowthLever;
  /** Expected extra customers within CUSTOMER_QUOTE_MONTHS (not rounded). */
  customers: number;
  /**
   * What it costs over that horizon (marketing: the extra budget x months; campaign: its price; referrals: the credits;
   * each with the splitters its extra signups need; build: the build-out plan with its installs), dollars.
   */
  cost: number;
  /** cost / customers, whole dollars; null when customers is about 0. */
  costPerCustomer: number | null;
  /** The campaign's area, else null. */
  cabinet: CabinetId | null;
  /** The build's corner, else null. */
  node: NodeId | null;
  /** What following it sends, in order (setMarketing, runCampaign, setReferrals, or the build-out plan's commands with any financing first). */
  commands: Command[];
}

// ---------------------------------------------------------------------------
// Derived (never saved; recomputed from GameState)
// ---------------------------------------------------------------------------

export interface CabinetCoverage {
  /** Lit segments this cabinet serves (it is their nearest active cabinet), ascending. */
  segments: SegmentId[];
  /** Existing parcels on those segments. */
  parcels: number;
  /** Units on those parcels. */
  passings: number;
}

/**
 * Who the network reaches, from network + city + day only (subscriber data is
 * deliberately not in here: it changes inside a day, this is memoized on
 * network.version and day).
 */
export interface ServiceSnapshot {
  networkVersion: number;
  day: number;
  /** Segments whose live span connects to the CO through live spans (light reaches them), regardless of cabinet reach. */
  connectedSegments: Set<SegmentId>;
  /**
   * Connected segments that pass homes: within CABINET_REACH_FT of an active
   * cabinet measured along connected cable (from the cabinet's node to the
   * segment's nearer endpoint, strictly less than the reach).
   */
  litSegments: Set<SegmentId>;
  /** Live cabinets whose node is reachable from the CO through live spans (or that stand at the CO). */
  activeCabinets: Set<CabinetId>;
  /** For each lit segment, the active cabinet nearest along connected cable (ties -> lower cabinet id). */
  servingCabinet: Map<SegmentId, CabinetId>;
  /** For each lit segment, that cabinet's cable distance (ft) to the segment's nearer endpoint. */
  servingDistanceFt: Map<SegmentId, number>;
  /**
   * For each lit segment, every active cabinet within CABINET_REACH_FT of it
   * along connected cable, nearest first (ties -> lower id); the first is its
   * servingCabinet. A subscriber stays on its own cabinet while that cabinet is
   * in this list (sales.serviceChanges).
   */
  segmentCabinets: Map<SegmentId, readonly CabinetId[]>;
  /** Per active cabinet (every active cabinet has an entry, possibly empty). */
  cabinetCoverage: Map<CabinetId, CabinetCoverage>;
  /** Parcels that exist (appearsDay <= day) and are served by a lit segment (Parcel.segment only), ascending. */
  passedParcels: ParcelId[];
  /** Sum of units over passedParcels. */
  passings: number;
  /**
   * Round 4: lit segments with no light today because an outage cuts them off
   * from every cabinet in segmentCabinets (their own span is out, or every
   * live path from each cabinet to them, or from it to the CO, runs through a
   * span that is out, or is too long). Still lit and passed (passings and
   * scorecards ignore outages). Empty when no span is out.
   */
  interruptedSegments: Set<SegmentId>;
  /**
   * Round 4: for each lit segment an outage cuts off from one or more of its
   * segmentCabinets, those cabinets (all of them for an interrupted
   * segment). A subscriber whose own cabinet (Account.cabinet) is listed for
   * its street is served meanwhile by another of them that still reaches it
   * with a port free, else has no service (network.outageService); while
   * the street's servingCabinet is listed, new signups there go only to such
   * a cabinet. Empty when no span is out.
   */
  cutOffCabinets: Map<SegmentId, ReadonlySet<CabinetId>>;
}
