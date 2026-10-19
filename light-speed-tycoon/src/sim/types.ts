// Shared simulation types for Light Speed Tycoon.
//
// Units used everywhere in the sim:
//   distance  -> feet (number)
//   money     -> whole US dollars (integer; round at the point a cost is computed)
//   time      -> days since game start (integer; day 0 = Jan 1 of START_YEAR)
//   position  -> map grid units (see "Geometry" below)
//
// Geometry: the city map is `width` x `height` cells. Street nodes sit on integer
// lattice points (0..width, 0..height). Street segments run along grid lines
// between two nodes that share an x or a y, with no other node between them.
// Blocks are the cell rectangles enclosed by streets; parcels are cell
// rectangles inside blocks, each touching exactly one frontage segment.
// One cell is TILE_FT feet on a side.

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
  /** Rocky ground; underground construction costs ROCK_MULTIPLIER more. */
  rock: boolean;
  zone: Zone;
}

export type ParcelKind = 'home' | 'mdu' | 'smb';

export interface Parcel {
  /** Equals this parcel's index in City.parcels. */
  id: ParcelId;
  kind: ParcelKind;
  /** The street segment this parcel fronts; its drop comes off this segment. */
  segment: SegmentId;
  /** Top-left cell of the parcel footprint. */
  x: number;
  y: number;
  /** Footprint size in cells (homes/smb usually 1x1, MDUs larger). */
  w: number;
  h: number;
  /** Households or businesses at this parcel (home = 1, smb = 1, mdu = 8..48). */
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
  /** What the player paid for this span (used for refunds). */
  cost: number;
  orderedDay: number;
  /** Day the span went live, or null if not live yet. */
  liveDay: number | null;
}

export type PonTech = 'gpon' | 'xgspon';

export interface Cabinet {
  id: CabinetId;
  /** Street node the cabinet stands at. */
  node: NodeId;
  /** Each splitter is 1:SPLIT_RATIO and consumes one OLT PON port. */
  splitters: number;
  stage: BuildStage;
  stageDaysLeft: number;
  cost: number;
  orderedDay: number;
  liveDay: number | null;
}

/** Optical line terminal at the CO. M1 has exactly one. */
export interface Olt {
  ponPorts: number;
  tech: PonTech;
}

export interface Network {
  /** At most one span per segment. */
  spans: CableSpan[];
  cabinets: Cabinet[];
  olt: Olt;
  /**
   * Bumped whenever topology or any build stage changes. Derived caches
   * (see ServiceSnapshot) key off this.
   */
  version: number;
}

// ---------------------------------------------------------------------------
// Finance
// ---------------------------------------------------------------------------

export type LedgerCategory =
  | 'construction'
  | 'equipment'
  | 'refund'
  | 'poleRent'
  | 'revenue'
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
}

export interface Finance {
  cash: number;
  /** Entries for the current, still-open month. */
  monthToDate: LedgerEntry[];
  /** Closed months, oldest first. */
  reports: MonthlyReport[];
}

// ---------------------------------------------------------------------------
// Game state (the whole saved game; must be plain JSON-serializable data)
// ---------------------------------------------------------------------------

export interface RngStreams {
  /** uint32 state for random events during play (make-ready delays, etc.). */
  events: number;
}

export interface GameState {
  schemaVersion: 1;
  seed: number;
  day: number;
  rng: RngStreams;
  /** Monotonic id source for spans and cabinets. */
  nextId: number;
  city: City;
  network: Network;
  finance: Finance;
}

// ---------------------------------------------------------------------------
// Commands (every player action goes through applyCommand so play is replayable)
// ---------------------------------------------------------------------------

export type Command =
  | { type: 'layCable'; segments: SegmentId[]; method: CableMethod }
  | { type: 'placeCabinet'; node: NodeId }
  | { type: 'removeSpan'; span: SpanId };

export type CommandResult = { ok: true; cost: number } | { ok: false; reason: string };

/** Pre-flight estimate the UI shows before the player commits a layCable. */
export interface CableQuote {
  ok: boolean;
  /** Human-readable blockers; empty when ok. */
  reasons: string[];
  /** Segments that would get new cable (already-cabled segments are skipped, never charged). */
  newSegments: SegmentId[];
  lengthFt: number;
  cost: number;
  /** Permitting estimate range in days; construction days for the longest new span. */
  permitDaysMin: number;
  permitDaysMax: number;
  constructDays: number;
}

export interface CabinetQuote {
  ok: boolean;
  reasons: string[];
  cost: number;
  permitDays: number;
  constructDays: number;
}

// ---------------------------------------------------------------------------
// Derived (never saved; recomputed from GameState)
// ---------------------------------------------------------------------------

export interface ServiceSnapshot {
  networkVersion: number;
  day: number;
  /** Segments with a live span connected to the CO through live spans, given at least one active cabinet. */
  litSegments: Set<SegmentId>;
  /** Live cabinets whose node is reachable from the CO through live spans (or that stand at the CO). */
  activeCabinets: Set<CabinetId>;
  /** Parcels that exist (appearsDay <= day) and front a lit segment. */
  passedParcels: ParcelId[];
  /** Sum of units over passedParcels. */
  passings: number;
}
