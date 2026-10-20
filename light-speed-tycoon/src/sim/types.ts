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
//
// schemaVersion history:
//   1 - round 1: city, network (spans, cabinets, OLT ports), ledger, reports.
//   2 - round 2: cabinet reach, splitter/OLT capacity, itemized costs and CPP,
//       subscribers and pricing, insolvency, milestones, notices. v1 saves are
//       migrated on load (save.ts migrateV1toV2).

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
   * changes. Derived caches (see ServiceSnapshot) key off this.
   */
  version: number;
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
  | 'interest'
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
  /** Sold to new customers. Subscribers already on an unoffered tier keep it (grandfathered). */
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
  /** Sum over the month's daily steps of subscribed units. Support cost at close = round(SUPPORT_COST_PER_SUB_PER_MONTH x / days). */
  subscriberUnitDays: number;
  /** Units connected so far this month. */
  grossAdds: number;
  /** Units disconnected so far this month because service went away. */
  lostService: number;
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
  | 'gameOver'
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
  /** The cabinet concerned (cabinetFull, serviceLost), else null. */
  cabinet: CabinetId | null;
  /** The milestone achieved (milestone), else null. */
  milestone: MilestoneId | null;
}

export interface GameOver {
  /** Day the game ended (a month-close day). */
  day: number;
  reason: 'insolvent';
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
}

export interface GameState {
  schemaVersion: 2;
  seed: number;
  day: number;
  rng: RngStreams;
  /** Monotonic id source for spans and cabinets. */
  nextId: number;
  city: City;
  network: Network;
  finance: Finance;
  sales: Sales;
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
  /** Replace every tier's price and offered flag (each TierId exactly once) and the SMB multiplier. Free. */
  | { type: 'setPricing'; tiers: TierSetting[]; smbMultiplier: number }
  /** Set the monthly marketing budget (whole dollars). Free; spend accrues daily. */
  | { type: 'setMarketing'; perMonth: number };

/** On success `cost` is the net spend now (negative for a refund, 0 for free commands). */
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
}
