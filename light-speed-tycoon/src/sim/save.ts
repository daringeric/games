// Save/load. Pure string <-> GameState; browser storage lives in the UI layer.
//
// This build writes schemaVersion 3 and reads 3, 2 and 1. Older saves (still
// in players' browsers as autosaves) are validated against their own shape and
// migrated one version at a time, each step validated: v1 -> migrateV1toV2 ->
// v2 -> migrateV2toV3 -> v3. A v2 save gets no debt.
//
// Owner after the round-3 contract: sim-debt workstream (debt validation and
// corruption cases; migration tests against the frozen v1 and v2 fixtures in
// testing/).

import { CABINET_REACH_FT, OLT_MAX_CARDS, OLT_PORTS_PER_CARD, START_YEAR } from './balance';
import { groupThousands } from './finance';
import { getService } from './network';
import { postNotice } from './notices';
import { newDebt } from './debt';
import { deriveSeed } from './rng';
import { otherEnd, segmentsAtNode } from './streets';
import { INSTALLS_PAUSED_PREFIX, INSTALLS_RESUMED_PREFIX, newSales } from './sales';
import type {
  BuildStage,
  CableMethod,
  CableSpan,
  CovenantStage,
  GameOverReason,
  GameState,
  LedgerCategory,
  LedgerEntry,
  MilestoneId,
  MonthlyStats,
  NoticeKind,
  ParcelKind,
  PonTech,
  StreetClass,
  TierId,
  Zone,
} from './types';

const SCHEMA_VERSION = 3;
const UINT32_MAX = 0xffffffff;
/**
 * Largest map edge in cells a save may have: several times a generated town
 * (96 x 64), and small enough for the per-cell buffers the map is drawn from.
 */
const MAX_MAP_CELLS = 512;
/**
 * Validation bounds are about what the sim can run without crashing or posting
 * non-integer money, never about tunable rules (TIER_PRICE_MAX, OLT_MAX_CARDS,
 * INSOLVENCY_GRACE_MONTHS, ...): saves outlive balance changes, and a save made
 * under old rules must still load. Commands enforce the rules.
 */
const SANE_PRICE_MAX = 100_000;
/**
 * Most units one parcel may hold. Signups and churn loop per unit, so a
 * corrupted million-unit building would stall every month close; generated
 * apartment buildings have tens of units.
 */
const SANE_PARCEL_UNITS_MAX = 10_000;
const SANE_MULTIPLIER_MAX = 100;
const SANE_BUDGET_MAX = 1_000_000_000;
/**
 * Largest balance, principal or payment a save may carry ($1 trillion), and
 * the largest rate (1,000% a year) and term (100 years): interest on them
 * stays a finite whole number, and amortization loops stay short.
 */
const SANE_DEBT_MAX = 1_000_000_000_000;
const SANE_RATE_MAX_BPS = 100_000;
const SANE_TERM_MONTHS_MAX = 1_200;
/** Most compliant closes a save may count toward a cure (the rule itself, COVENANT_CURE_CLOSES, is tunable). */
const SANE_CURE_CLOSES_MAX = 1_000;

export class SaveError extends Error {
  override name = 'SaveError';
}

/** JSON text of the full game state. */
export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

/**
 * Parse and validate a save. Throws SaveError for malformed JSON, a missing or
 * unsupported schemaVersion, or a structurally invalid state. A schemaVersion 1
 * or 2 save is migrated to the current version (each step validated).
 */
export function deserialize(json: string): GameState {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new SaveError(`Save is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isRecord(raw)) throw new SaveError(`Save should be a JSON object, got ${describe(raw)}`);
  if (!('schemaVersion' in raw)) {
    throw new SaveError(`Save has no schemaVersion (this build reads version ${SCHEMA_VERSION})`);
  }
  if (raw.schemaVersion === 1) {
    checkState(raw, 1);
    const v2 = migrateV1toV2(raw);
    checkState(v2 as unknown as Json, 2);
    const state = migrateV2toV3(v2);
    checkState(state as unknown as Json, 3);
    noteReachChange(state);
    return state;
  }
  if (raw.schemaVersion === 2) {
    upgradeEarlyV2(raw);
    checkState(raw, 2);
    const state = migrateV2toV3(raw as unknown as V2State);
    checkState(state as unknown as Json, 3);
    return state;
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new SaveError(
      `Unsupported save version ${describe(raw.schemaVersion)} (this build reads version ${SCHEMA_VERSION})`,
    );
  }
  checkState(raw, 3);
  return raw as unknown as GameState;
}

/**
 * Bring a schemaVersion 2 save written before installs had their own notice
 * kinds up to date, in place (no version bump: the change only adds a field
 * that can be derived). Such a save has no sales.installsPaused and posted its
 * install pause/resume notices as 'insolvencyWarning' told apart by message
 * prefix: those notices get the 'installsPaused' / 'installsResumed' kinds,
 * and installsPaused is true when the newest of them still in the log is a
 * pause. Anything else is left for checkState to judge.
 */
function upgradeEarlyV2(save: Json): void {
  const sales = save.sales;
  if (!isRecord(sales) || 'installsPaused' in sales) return;
  let paused = false;
  if (Array.isArray(save.notices)) {
    for (const notice of save.notices) {
      if (!isRecord(notice) || notice.kind !== 'insolvencyWarning' || typeof notice.message !== 'string') continue;
      if (notice.message.startsWith(INSTALLS_PAUSED_PREFIX)) {
        notice.kind = 'installsPaused';
        paused = true;
      } else if (notice.message.startsWith(INSTALLS_RESUMED_PREFIX)) {
        notice.kind = 'installsResumed';
        paused = false;
      }
    }
  }
  // Keep newSales' key order (installsPaused right after fullCabinets), so the save hashes like a fresh one.
  const entries = Object.entries(sales);
  const at = entries.findIndex(([key]) => key === 'fullCabinets');
  entries.splice(at < 0 ? entries.length : at + 1, 0, ['installsPaused', paused]);
  for (const key of Object.keys(sales)) delete sales[key];
  Object.assign(sales, Object.fromEntries(entries));
}

/** Short stable hash (FNV-1a, hex) of serialize(state); used by determinism tests. */
export function hashState(state: GameState): string {
  return fnv1a(serialize(state));
}

/** 32-bit FNV-1a over the UTF-16 code units of `text` (bytes, for ASCII), as 8 lowercase hex digits. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/** A schemaVersion 2 game: today's GameState without debt. */
export type V2State = Omit<GameState, 'schemaVersion' | 'debt'> & { schemaVersion: 2 };

/**
 * Turn a v2-valid save into a v3 GameState: everything kept as it is (the
 * same objects), plus debt = debt.newDebt() (nothing borrowed, covenant
 * compliant). Reports keep no `debt` stats (the UI shows them as "-").
 * Keys are written in newGame's order (debt right after finance) so migrated
 * and fresh saves hash alike.
 */
export function migrateV2toV3(v2: V2State): GameState {
  return {
    schemaVersion: 3,
    seed: v2.seed,
    day: v2.day,
    rng: v2.rng,
    nextId: v2.nextId,
    city: v2.city,
    network: v2.network,
    finance: v2.finance,
    debt: newDebt(),
    sales: v2.sales,
    milestones: v2.milestones,
    notices: v2.notices,
    nextNoticeId: v2.nextNoticeId,
    gameOver: v2.gameOver,
  };
}

/**
 * Turn a parsed, v1-valid save into a v2 game (the input object is not
 * reused). Players keep their town, plant, cash, ledger and reports:
 * - rng.sales = deriveSeed(seed, 'sales'); rng.events kept, so make-ready
 *   draws continue exactly as before.
 * - olt.cards = ceil(ponPorts / OLT_PORTS_PER_CARD), clamped to 0..OLT_MAX_CARDS
 *   (ponPorts itself is kept: it stays the authoritative capacity).
 * - every span gets refundable = cost (v1 orders had no fees or make-ready).
 * - network.makeReady = [] (v1 draws were not remembered).
 * - finance.capex.osp = everything v1 ever spent net of refunds: -(sum of the
 *   construction, equipment and refund totals of every report plus the open
 *   month's entries), floored at 0; connect = co = 0 (v1 had neither).
 * - negativeMonths = 0; reports keep no `stats` (shown as "-").
 * - sales = newSales() (no subscribers yet; signups start on the next day
 *   for homes that are already passed), no milestones, notices or game over.
 * Keys are written in newGame's order so migrated and fresh saves hash alike.
 */
export function migrateV1toV2(v1: Record<string, unknown>): V2State {
  const old = v1 as unknown as V1State;
  const capexCategories: readonly LedgerCategory[] = ['construction', 'equipment', 'refund'];
  let spent = 0;
  for (const report of old.finance.reports) {
    for (const category of capexCategories) spent -= report.totals[category] ?? 0;
  }
  for (const entry of old.finance.monthToDate) if (capexCategories.includes(entry.category)) spent -= entry.amount;

  return {
    schemaVersion: 2,
    seed: old.seed,
    day: old.day,
    rng: { events: old.rng.events, sales: deriveSeed(old.seed, 'sales') },
    nextId: old.nextId,
    city: old.city,
    network: {
      spans: old.network.spans.map((s) => ({
        id: s.id,
        segment: s.segment,
        method: s.method,
        stage: s.stage,
        stageDaysLeft: s.stageDaysLeft,
        constructDays: s.constructDays,
        cost: s.cost,
        refundable: s.cost,
        orderedDay: s.orderedDay,
        liveDay: s.liveDay,
      })),
      cabinets: old.network.cabinets,
      olt: {
        ponPorts: old.network.olt.ponPorts,
        cards: Math.min(OLT_MAX_CARDS, Math.ceil(old.network.olt.ponPorts / OLT_PORTS_PER_CARD)),
        tech: old.network.olt.tech,
      },
      makeReady: [],
      version: old.network.version,
    },
    finance: {
      cash: old.finance.cash,
      monthToDate: old.finance.monthToDate,
      reports: old.finance.reports,
      capex: { osp: Math.max(0, spent), connect: 0, co: 0 },
      negativeMonths: 0,
    },
    sales: newSales(),
    milestones: [],
    notices: [],
    nextNoticeId: 1,
    gameOver: null,
  };
}

/**
 * Round 1 lit every street on CO-connected cable once any cabinet stood on it;
 * round 2 lights only streets within CABINET_REACH_FT of a cabinet. A migrated
 * town can lose most of its passings on load, so say why instead of leaving
 * the player to find the network dark.
 */
function noteReachChange(state: GameState): void {
  const before = roundOnePassings(state);
  const after = getService(state).passings;
  if (after >= before) return;
  postNotice(
    state,
    'rulesUpdated',
    `Cabinets changed in this version: each now lights streets within ${groupThousands(CABINET_REACH_FT)} ft of it along its cable, ` +
      `so ${groupThousands(before - after)} of your ${groupThousands(before)} passings are out of reach. Add cabinets closer to them to light them again.`,
  );
}

/** Units passed under the round-1 rule: existing parcels on live cable joined to the CO, once a live cabinet stands on that cable. */
function roundOnePassings(state: GameState): number {
  const { city, network } = state;
  const live = new Set(network.spans.filter((s) => s.stage === 'live').map((s) => s.segment));
  const reached = new Set<number>([city.coNode]);
  const connected = new Set<number>();
  const queue = [city.coNode];
  for (let node = queue.pop(); node !== undefined; node = queue.pop()) {
    for (const id of segmentsAtNode(city, node)) {
      const segment = city.segments[id];
      if (!segment || !live.has(id) || connected.has(id)) continue;
      connected.add(id);
      const next = otherEnd(segment, node);
      if (!reached.has(next)) {
        reached.add(next);
        queue.push(next);
      }
    }
  }
  if (!network.cabinets.some((c) => c.stage === 'live' && reached.has(c.node))) return 0;
  let units = 0;
  for (const p of city.parcels) if (p.appearsDay <= state.day && connected.has(p.segment)) units += p.units;
  return units;
}

/** The v1 shape, as far as the migration reads it (already validated by checkState(_, 1)). */
interface V1State {
  seed: number;
  day: number;
  rng: { events: number };
  nextId: number;
  city: GameState['city'];
  network: {
    spans: Omit<CableSpan, 'refundable'>[];
    cabinets: GameState['network']['cabinets'];
    olt: { ponPorts: number; tech: PonTech };
    version: number;
  };
  finance: {
    cash: number;
    monthToDate: LedgerEntry[];
    reports: { year: number; month: number; totals: Partial<Record<LedgerCategory, number>>; net: number; cashEnd: number; passings: number }[];
  };
}

// ---------------------------------------------------------------------------
// Structural validation. Everything the sim indexes by, divides by or formats
// is checked here, so a corrupted or hand-edited save fails on load with a
// message naming the bad field instead of crashing mid-game.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;
type Version = 1 | 2 | 3;

/** Keys of an exhaustive record: adding a union member is a compile error until it is listed. */
function members<T extends string>(record: Record<T, true>): readonly T[] {
  return Object.keys(record) as T[];
}

const STREET_CLASSES = members<StreetClass>({ arterial: true, collector: true, local: true });
const ZONES = members<Zone>({ downtown: true, residential: true, industrial: true, rural: true });
const PARCEL_KINDS = members<ParcelKind>({ home: true, mdu: true, smb: true });
const CABLE_METHODS = members<CableMethod>({ aerial: true, underground: true });
const BUILD_STAGES = members<BuildStage>({ permitting: true, constructing: true, live: true });
const PON_TECHS = members<PonTech>({ gpon: true, xgspon: true });
const TIER_IDS = members<TierId>({ fiber500: true, fiber1g: true, fiber2g: true });
const MILESTONE_IDS = members<MilestoneId>({
  firstLight: true,
  passings1000UnderTarget: true,
  subscribers100: true,
  cashFlowPositive: true,
  subscribers1000: true,
  takeRate30: true,
});
const NOTICE_KINDS = members<NoticeKind>({
  cabinetFull: true,
  serviceLost: true,
  oltFull: true,
  insolvencyWarning: true,
  installsPaused: true,
  installsResumed: true,
  rulesUpdated: true,
  paymentDue: true,
  paymentMissed: true,
  covenantWarning: true,
  covenantPenalty: true,
  creditFrozen: true,
  covenantCured: true,
  loanPaidOff: true,
  gameOver: true,
  milestone: true,
});
/** Notice kinds new in schemaVersion 3 (financing). */
const V3_NOTICE_KINDS: readonly NoticeKind[] = [
  'paymentDue',
  'paymentMissed',
  'covenantWarning',
  'covenantPenalty',
  'creditFrozen',
  'covenantCured',
  'loanPaidOff',
];
/** Notice kinds a schemaVersion 2 save can contain. */
const V2_NOTICE_KINDS: readonly NoticeKind[] = NOTICE_KINDS.filter((k) => !V3_NOTICE_KINDS.includes(k));
const LEDGER_CATEGORIES = members<LedgerCategory>({
  construction: true,
  equipment: true,
  install: true,
  refund: true,
  poleRent: true,
  revenue: true,
  overhead: true,
  payroll: true,
  marketing: true,
  interest: true,
  principal: true,
  loanProceeds: true,
  other: true,
});
/** Categories a schemaVersion 2 save can contain (no financing flows but the never-posted 'interest'). */
const V2_LEDGER_CATEGORIES: readonly LedgerCategory[] = LEDGER_CATEGORIES.filter((c) => c !== 'principal' && c !== 'loanProceeds');
/** Categories a schemaVersion 1 save can contain. */
const V1_LEDGER_CATEGORIES: readonly LedgerCategory[] = V2_LEDGER_CATEGORIES.filter((c) => c !== 'install' && c !== 'overhead');
const LEDGER_CATEGORIES_BY_VERSION: Record<Version, readonly LedgerCategory[]> = {
  1: V1_LEDGER_CATEGORIES,
  2: V2_LEDGER_CATEGORIES,
  3: LEDGER_CATEGORIES,
};
const COVENANT_STAGES = members<CovenantStage>({ compliant: true, warning: true, penalty: true, frozen: true });
const GAME_OVER_REASONS = members<GameOverReason>({ insolvent: true, default: true });
const STATS_FIELDS = members<keyof MonthlyStats>({
  subscribers: true,
  accounts: true,
  subscriberDays: true,
  grossAdds: true,
  churned: true,
  lostService: true,
  connectsTotal: true,
  capexOsp: true,
  capexConnect: true,
  capexCo: true,
  ponPortsUsed: true,
  ponPorts: true,
  fullCabinets: true,
});

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  return String(value);
}

function corrupt(path: string, problem: string): never {
  throw new SaveError(`Corrupt save: ${path} ${problem}`);
}

function expected(path: string, what: string, value: unknown): never {
  return corrupt(path, `should be ${what}, got ${describe(value)}`);
}

function obj(value: unknown, path: string): Json {
  if (!isRecord(value)) expected(path, 'an object', value);
  return value;
}

function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) expected(path, 'an array', value);
  return value;
}

function str(value: unknown, path: string): string {
  if (typeof value !== 'string') expected(path, 'a string', value);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') expected(path, 'true or false', value);
  return value;
}

/** Safe integer in [min, max]. */
function int(value: unknown, path: string, min = -Number.MAX_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    const lo = min > -Number.MAX_SAFE_INTEGER;
    const hi = max < Number.MAX_SAFE_INTEGER;
    const range = lo && hi ? ` in ${min}..${max}` : lo ? ` >= ${min}` : hi ? ` <= ${max}` : '';
    expected(path, `an integer${range}`, value);
  }
  return value as number;
}

function positive(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) expected(path, 'a number > 0', value);
  return value;
}

/** Finite number in [min, max]. */
function num(value: unknown, path: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    expected(path, `a number in ${min}..${max}`, value);
  }
  return value;
}

function oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
  if (!options.includes(value as T)) expected(path, `one of ${options.map((o) => `"${o}"`).join(', ')}`, value);
  return value as T;
}

/** ids of nodes, segments and parcels equal their index. */
function indexId(value: unknown, path: string, index: number): void {
  if (value !== index) expected(path, `${index} (its position in the list)`, value);
}

/** A reference into a city list of `count` items. */
function ref(value: unknown, path: string, count: number, what: string): number {
  if (count === 0) return corrupt(path, `refers to a ${what}, but the city has none`);
  return int(value, path, 0, count - 1);
}

/** Each value strictly greater than the one before (sorted, no duplicates). */
function ascending(values: readonly number[], path: string): void {
  for (let i = 1; i < values.length; i++) {
    if ((values[i] as number) <= (values[i - 1] as number)) {
      corrupt(`${path}[${i}]`, `should be greater than the entry before it (${values[i - 1]}), got ${values[i]}`);
    }
  }
}

interface CityShape {
  nodes: number;
  segments: number;
  parcels: readonly { kind: ParcelKind; units: number }[];
}

interface Context {
  version: Version;
  day: number;
  nextId: number;
  city: CityShape;
}

function checkState(save: Json, version: Version): void {
  int(save.seed, 'seed', 0, UINT32_MAX);
  const day = int(save.day, 'day', 0);
  const rng = obj(save.rng, 'rng');
  int(rng.events, 'rng.events', 0, UINT32_MAX);
  if (version >= 2) int(rng.sales, 'rng.sales', 0, UINT32_MAX);
  const nextId = int(save.nextId, 'nextId', 1);
  const city = checkCity(obj(save.city, 'city'));
  const ctx: Context = { version, day, nextId, city };
  checkNetwork(obj(save.network, 'network'), ctx);
  checkFinance(obj(save.finance, 'finance'), ctx);
  if (version === 1) return;
  if (version >= 3) checkDebt(obj(save.debt, 'debt'), ctx);
  checkSales(obj(save.sales, 'sales'), ctx);
  checkProgress(save, ctx);
}

function checkCity(city: Json): CityShape {
  int(city.seed, 'city.seed');
  str(city.name, 'city.name');
  // Map geometry sizes the spatial index and the renderer's buffers, so it is
  // held to what the generator makes: nodes on the map's lattice, axis-aligned
  // segments with a < b, and parcels inside the map.
  const width = int(city.width, 'city.width', 1, MAX_MAP_CELLS);
  const height = int(city.height, 'city.height', 1, MAX_MAP_CELLS);
  positive(city.tileFt, 'city.tileFt');

  const nodes = list(city.nodes, 'city.nodes');
  const points = nodes.map((value, i) => {
    const path = `city.nodes[${i}]`;
    const node = obj(value, path);
    indexId(node.id, `${path}.id`, i);
    return { x: int(node.x, `${path}.x`, 0, width), y: int(node.y, `${path}.y`, 0, height) };
  });

  const segments = list(city.segments, 'city.segments');
  segments.forEach((value, i) => {
    const path = `city.segments[${i}]`;
    const seg = obj(value, path);
    indexId(seg.id, `${path}.id`, i);
    const a = ref(seg.a, `${path}.a`, nodes.length, 'node');
    const b = ref(seg.b, `${path}.b`, nodes.length, 'node');
    if (b <= a) expected(`${path}.b`, `greater than a (${a})`, b);
    const pa = points[a] as { x: number; y: number };
    const pb = points[b] as { x: number; y: number };
    if (pa.x !== pb.x && pa.y !== pb.y) {
      corrupt(path, `should run along one grid line, but joins (${pa.x}, ${pa.y}) to (${pb.x}, ${pb.y})`);
    }
    if (pa.x === pb.x && pa.y === pb.y) corrupt(path, `joins two nodes at the same point (${pa.x}, ${pa.y})`);
    oneOf(seg.streetClass, `${path}.streetClass`, STREET_CLASSES);
    str(seg.name, `${path}.name`);
    positive(seg.lengthFt, `${path}.lengthFt`);
    bool(seg.hasPoles, `${path}.hasPoles`);
    bool(seg.rock, `${path}.rock`);
    oneOf(seg.zone, `${path}.zone`, ZONES);
  });

  const parcels = list(city.parcels, 'city.parcels').map((value, i) => {
    const path = `city.parcels[${i}]`;
    const parcel = obj(value, path);
    indexId(parcel.id, `${path}.id`, i);
    const kind = oneOf(parcel.kind, `${path}.kind`, PARCEL_KINDS);
    ref(parcel.segment, `${path}.segment`, segments.length, 'segment');
    const x = int(parcel.x, `${path}.x`, 0, width - 1);
    const y = int(parcel.y, `${path}.y`, 0, height - 1);
    const w = int(parcel.w, `${path}.w`, 1);
    const h = int(parcel.h, `${path}.h`, 1);
    if (x + w > width || y + h > height) {
      corrupt(path, `runs off the ${width} x ${height} map (cells ${x}..${x + w - 1} x ${y}..${y + h - 1})`);
    }
    const units = int(parcel.units, `${path}.units`, 0, SANE_PARCEL_UNITS_MAX);
    int(parcel.appearsDay, `${path}.appearsDay`, 0);
    oneOf(parcel.zone, `${path}.zone`, ZONES);
    return { kind, units };
  });

  ref(city.coNode, 'city.coNode', nodes.length, 'node');
  return { nodes: nodes.length, segments: segments.length, parcels };
}

/** Fields spans and cabinets share; returns the stage. */
function checkBuildable(asset: Json, path: string, nextId: number, usedIds: Set<number>): BuildStage {
  // Spans and cabinets draw ids from one counter, so ids are unique across both and below nextId.
  const id = int(asset.id, `${path}.id`, 1, nextId - 1);
  if (usedIds.has(id)) corrupt(`${path}.id`, `${id} is used twice`);
  usedIds.add(id);
  const stage = oneOf(asset.stage, `${path}.stage`, BUILD_STAGES);
  int(asset.stageDaysLeft, `${path}.stageDaysLeft`, 0);
  int(asset.cost, `${path}.cost`, 0);
  int(asset.orderedDay, `${path}.orderedDay`, 0);
  if (stage === 'live') int(asset.liveDay, `${path}.liveDay`, 0);
  else if (asset.liveDay !== null) expected(`${path}.liveDay`, `null while ${stage}`, asset.liveDay);
  return stage;
}

function checkNetwork(network: Json, ctx: Context): void {
  const { city, nextId, version } = ctx;
  const usedIds = new Set<number>();

  const cabled = new Set<number>();
  list(network.spans, 'network.spans').forEach((value, i) => {
    const path = `network.spans[${i}]`;
    const span = obj(value, path);
    checkBuildable(span, path, nextId, usedIds);
    const segment = ref(span.segment, `${path}.segment`, city.segments, 'segment');
    if (cabled.has(segment)) corrupt(`${path}.segment`, `${segment} already has a span`);
    cabled.add(segment);
    oneOf(span.method, `${path}.method`, CABLE_METHODS);
    int(span.constructDays, `${path}.constructDays`, 1);
    if (version >= 2) int(span.refundable, `${path}.refundable`, 0, span.cost as number);
  });

  const cabinetNodes = new Set<number>();
  list(network.cabinets, 'network.cabinets').forEach((value, i) => {
    const path = `network.cabinets[${i}]`;
    const cabinet = obj(value, path);
    checkBuildable(cabinet, path, nextId, usedIds);
    const node = ref(cabinet.node, `${path}.node`, city.nodes, 'node');
    if (cabinetNodes.has(node)) corrupt(`${path}.node`, `${node} already has a cabinet`);
    cabinetNodes.add(node);
    int(cabinet.splitters, `${path}.splitters`, 0);
  });

  const olt = obj(network.olt, 'network.olt');
  int(olt.ponPorts, 'network.olt.ponPorts', 0);
  if (version >= 2) int(olt.cards, 'network.olt.cards', 0);
  oneOf(olt.tech, 'network.olt.tech', PON_TECHS);

  if (version >= 2) {
    const keys: number[] = [];
    list(network.makeReady, 'network.makeReady').forEach((value, i) => {
      const path = `network.makeReady[${i}]`;
      const memo = obj(value, path);
      const segment = ref(memo.segment, `${path}.segment`, city.segments, 'segment');
      const method = oneOf(memo.method, `${path}.method`, CABLE_METHODS);
      int(memo.days, `${path}.days`, 1);
      int(memo.drawnDay, `${path}.drawnDay`, 0, ctx.day);
      keys.push(segment * 2 + (method === 'aerial' ? 0 : 1));
    });
    // Sorted by segment then method, one memo per pair.
    ascending(keys, 'network.makeReady');
  }
  int(network.version, 'network.version', 0);
}

function checkFinance(finance: Json, ctx: Context): void {
  const categories = LEDGER_CATEGORIES_BY_VERSION[ctx.version];
  int(finance.cash, 'finance.cash');

  list(finance.monthToDate, 'finance.monthToDate').forEach((value, i) => {
    const path = `finance.monthToDate[${i}]`;
    const entry = obj(value, path);
    int(entry.day, `${path}.day`, 0);
    oneOf(entry.category, `${path}.category`, categories);
    int(entry.amount, `${path}.amount`);
    str(entry.memo, `${path}.memo`);
  });

  list(finance.reports, 'finance.reports').forEach((value, i) => {
    const path = `finance.reports[${i}]`;
    const report = obj(value, path);
    int(report.year, `${path}.year`, START_YEAR);
    int(report.month, `${path}.month`, 1, 12);
    const totals = obj(report.totals, `${path}.totals`);
    for (const [category, total] of Object.entries(totals)) {
      oneOf(category, `${path}.totals key`, categories);
      int(total, `${path}.totals.${category}`);
    }
    int(report.net, `${path}.net`);
    int(report.cashEnd, `${path}.cashEnd`);
    int(report.passings, `${path}.passings`, 0);
    if (ctx.version >= 2 && report.stats !== undefined) {
      const stats = obj(report.stats, `${path}.stats`);
      for (const field of STATS_FIELDS) int(stats[field], `${path}.stats.${field}`, 0);
    }
    if (ctx.version >= 3 && report.debt !== undefined) checkDebtStats(obj(report.debt, `${path}.debt`), `${path}.debt`);
  });

  if (ctx.version === 1) return;
  const capex = obj(finance.capex, 'finance.capex');
  int(capex.osp, 'finance.capex.osp', 0);
  int(capex.connect, 'finance.capex.connect', 0);
  int(capex.co, 'finance.capex.co', 0);
  int(finance.negativeMonths, 'finance.negativeMonths', 0);
}

/** Report.debt (round-3 closes). */
function checkDebtStats(stats: Json, path: string): void {
  int(stats.creditBalance, `${path}.creditBalance`, 0);
  int(stats.termBalance, `${path}.termBalance`, 0);
  int(stats.creditLimit, `${path}.creditLimit`, 0);
  int(stats.arr, `${path}.arr`, 0);
  int(stats.annualOperatingCashFlow, `${path}.annualOperatingCashFlow`);
  int(stats.annualDebtService, `${path}.annualDebtService`, 0);
  // Required but nullable: a missing field is corrupt, null is "not measurable".
  if (stats.leverageX100 !== null) int(stats.leverageX100, `${path}.leverageX100`, 0);
  if (stats.coverageX100 !== null) int(stats.coverageX100, `${path}.coverageX100`);
  oneOf(stats.stage, `${path}.stage`, COVENANT_STAGES);
  if (stats.averageRateBps !== null) int(stats.averageRateBps, `${path}.averageRateBps`, 0);
  bool(stats.missedPayment, `${path}.missedPayment`);
}

function checkRateParts(rate: Json, path: string): void {
  for (const field of ['baseBps', 'leverageBps', 'cppBps', 'productBps'] as const) {
    int(rate[field], `${path}.${field}`, 0, SANE_RATE_MAX_BPS);
  }
}

function checkDebt(debt: Json, ctx: Context): void {
  const credit = obj(debt.credit, 'debt.credit');
  int(credit.balance, 'debt.credit.balance', 0, SANE_DEBT_MAX);
  checkRateParts(obj(credit.rate, 'debt.credit.rate'), 'debt.credit.rate');
  // A month of end-of-day balances.
  int(credit.balanceDollarDays, 'debt.credit.balanceDollarDays', 0, SANE_DEBT_MAX * 31);

  const nextLoanId = int(debt.nextLoanId, 'debt.nextLoanId', 1);
  const ids = list(debt.loans, 'debt.loans').map((value, i) => {
    const path = `debt.loans[${i}]`;
    const loan = obj(value, path);
    const id = int(loan.id, `${path}.id`, 1, nextLoanId - 1);
    int(loan.principal, `${path}.principal`, 1, SANE_DEBT_MAX);
    // Missed payments capitalize interest, so the balance may exceed the principal.
    int(loan.balance, `${path}.balance`, 1, SANE_DEBT_MAX);
    int(loan.rateBps, `${path}.rateBps`, 0, SANE_RATE_MAX_BPS);
    const termMonths = int(loan.termMonths, `${path}.termMonths`, 1, SANE_TERM_MONTHS_MAX);
    int(loan.payment, `${path}.payment`, 1, SANE_DEBT_MAX);
    int(loan.monthsLeft, `${path}.monthsLeft`, 1, termMonths);
    int(loan.originatedDay, `${path}.originatedDay`, 0, ctx.day);
    return id;
  });
  ascending(ids, 'debt.loans (by id)');

  const covenant = obj(debt.covenant, 'debt.covenant');
  oneOf(covenant.stage, 'debt.covenant.stage', COVENANT_STAGES);
  int(covenant.compliantCloses, 'debt.covenant.compliantCloses', 0, SANE_CURE_CLOSES_MAX);
}

function checkSales(sales: Json, ctx: Context): void {
  const { city, day, nextId } = ctx;

  const pricing = obj(sales.pricing, 'sales.pricing');
  const tiers = list(pricing.tiers, 'sales.pricing.tiers');
  if (tiers.length !== TIER_IDS.length) {
    corrupt('sales.pricing.tiers', `should list the ${TIER_IDS.length} tiers ${TIER_IDS.join(', ')}, got ${tiers.length}`);
  }
  let offered = 0;
  tiers.forEach((value, i) => {
    const path = `sales.pricing.tiers[${i}]`;
    const tier = obj(value, path);
    const id = TIER_IDS[i] as TierId;
    if (tier.id !== id) expected(`${path}.id`, `"${id}"`, tier.id);
    str(tier.name, `${path}.name`);
    int(tier.downMbps, `${path}.downMbps`, 1);
    int(tier.upMbps, `${path}.upMbps`, 1);
    int(tier.price, `${path}.price`, 1, SANE_PRICE_MAX);
    if (bool(tier.offered, `${path}.offered`)) offered++;
  });
  if (offered === 0) corrupt('sales.pricing.tiers', 'should offer at least one tier');
  num(pricing.smbMultiplier, 'sales.pricing.smbMultiplier', 0.01, SANE_MULTIPLIER_MAX);
  int(sales.marketingPerMonth, 'sales.marketingPerMonth', 0, SANE_BUDGET_MAX);

  const parcelsWithService: number[] = [];
  list(sales.accounts, 'sales.accounts').forEach((value, i) => {
    const path = `sales.accounts[${i}]`;
    const account = obj(value, path);
    const parcel = ref(account.parcel, `${path}.parcel`, city.parcels.length, 'parcel');
    parcelsWithService.push(parcel);
    // A removed cabinet's subscribers stay until the next daily step drops
    // them, so the id need not exist, only have been issued.
    int(account.cabinet, `${path}.cabinet`, 1, nextId - 1);
    const tierUnits = obj(account.tierUnits, `${path}.tierUnits`);
    for (const key of Object.keys(tierUnits)) oneOf(key, `${path}.tierUnits key`, TIER_IDS);
    let units = 0;
    for (const id of TIER_IDS) units += int(tierUnits[id], `${path}.tierUnits.${id}`, 0);
    const { units: capacity, kind } = city.parcels[parcel] as { units: number; kind: ParcelKind };
    if (units < 1 || units > capacity) {
      corrupt(`${path}.tierUnits`, `should add up to 1..${capacity} units (parcel ${parcel} has ${capacity}), got ${units}`);
    }
    // Homes and businesses are one household or business each.
    if (kind !== 'mdu' && units !== 1) corrupt(`${path}.tierUnits`, `should add up to 1 unit for a ${kind}, got ${units}`);
    int(account.since, `${path}.since`, 0, day);
  });
  ascending(parcelsWithService, 'sales.accounts (by parcel)');

  const routers = list(sales.routerParcels, 'sales.routerParcels').map((value, i) => {
    const path = `sales.routerParcels[${i}]`;
    const parcel = ref(value, path, city.parcels.length, 'parcel');
    if (city.parcels[parcel]?.kind !== 'mdu') corrupt(path, `refers to parcel ${parcel}, which is not an apartment building`);
    return parcel;
  });
  ascending(routers, 'sales.routerParcels');
  int(sales.connectsTotal, 'sales.connectsTotal', 0);
  const full = list(sales.fullCabinets, 'sales.fullCabinets').map((value, i) => int(value, `sales.fullCabinets[${i}]`, 1, nextId - 1));
  ascending(full, 'sales.fullCabinets');
  bool(sales.installsPaused, 'sales.installsPaused');

  const month = obj(sales.month, 'sales.month');
  for (const field of ['revenueDollarDays', 'marketingDollarDays', 'subscriberUnitDays', 'grossAdds', 'lostService'] as const) {
    int(month[field], `sales.month.${field}`, 0);
  }
}

function checkProgress(save: Json, ctx: Context): void {
  const seen = new Set<string>();
  list(save.milestones, 'milestones').forEach((value, i) => {
    const path = `milestones[${i}]`;
    const record = obj(value, path);
    const id = oneOf(record.id, `${path}.id`, MILESTONE_IDS);
    if (seen.has(id)) corrupt(`${path}.id`, `"${id}" is listed twice`);
    seen.add(id);
    int(record.day, `${path}.day`, 0, ctx.day);
  });

  const nextNoticeId = int(save.nextNoticeId, 'nextNoticeId', 1);
  const ids = list(save.notices, 'notices').map((value, i) => {
    const path = `notices[${i}]`;
    const notice = obj(value, path);
    const id = int(notice.id, `${path}.id`, 1, nextNoticeId - 1);
    int(notice.day, `${path}.day`, 0, ctx.day);
    oneOf(notice.kind, `${path}.kind`, ctx.version >= 3 ? NOTICE_KINDS : V2_NOTICE_KINDS);
    str(notice.message, `${path}.message`);
    if (notice.cabinet !== null) int(notice.cabinet, `${path}.cabinet`, 1, ctx.nextId - 1);
    if (notice.milestone !== null) oneOf(notice.milestone, `${path}.milestone`, MILESTONE_IDS);
    return id;
  });
  ascending(ids, 'notices (by id)');

  if (save.gameOver !== null) {
    const over = obj(save.gameOver, 'gameOver');
    int(over.day, 'gameOver.day', 0, ctx.day);
    oneOf(over.reason, 'gameOver.reason', ctx.version >= 3 ? GAME_OVER_REASONS : (['insolvent'] as const));
    str(over.message, 'gameOver.message');
  }
}
