// Save/load. Pure string <-> GameState; browser storage lives in the UI layer.

import { START_YEAR } from './balance';
import type {
  BuildStage,
  CableMethod,
  GameState,
  LedgerCategory,
  ParcelKind,
  PonTech,
  StreetClass,
  Zone,
} from './types';

const SCHEMA_VERSION = 1;
const UINT32_MAX = 0xffffffff;
/**
 * Largest map edge in cells a save may have: several times a generated town
 * (96 x 64), and small enough for the per-cell buffers the map is drawn from.
 */
const MAX_MAP_CELLS = 512;

export class SaveError extends Error {
  override name = 'SaveError';
}

/** JSON text of the full game state. */
export function serialize(state: GameState): string {
  return JSON.stringify(state);
}

/**
 * Parse and validate a save. Throws SaveError for malformed JSON, a missing or
 * unsupported schemaVersion, or a structurally invalid state.
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
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new SaveError(
      `Unsupported save version ${describe(raw.schemaVersion)} (this build reads version ${SCHEMA_VERSION})`,
    );
  }
  checkState(raw);
  return raw as unknown as GameState;
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
// Structural validation. Everything the sim indexes by, divides by or formats
// is checked here, so a corrupted or hand-edited save fails on load with a
// message naming the bad field instead of crashing mid-game.
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

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
const LEDGER_CATEGORIES = members<LedgerCategory>({
  construction: true,
  equipment: true,
  refund: true,
  poleRent: true,
  revenue: true,
  payroll: true,
  marketing: true,
  interest: true,
  other: true,
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

interface CityShape {
  nodes: number;
  segments: number;
}

function checkState(save: Json): void {
  int(save.seed, 'seed', 0, UINT32_MAX);
  int(save.day, 'day', 0);
  int(obj(save.rng, 'rng').events, 'rng.events', 0, UINT32_MAX);
  const nextId = int(save.nextId, 'nextId', 1);
  const city = checkCity(obj(save.city, 'city'));
  checkNetwork(obj(save.network, 'network'), city, nextId);
  checkFinance(obj(save.finance, 'finance'));
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

  list(city.parcels, 'city.parcels').forEach((value, i) => {
    const path = `city.parcels[${i}]`;
    const parcel = obj(value, path);
    indexId(parcel.id, `${path}.id`, i);
    oneOf(parcel.kind, `${path}.kind`, PARCEL_KINDS);
    ref(parcel.segment, `${path}.segment`, segments.length, 'segment');
    const x = int(parcel.x, `${path}.x`, 0, width - 1);
    const y = int(parcel.y, `${path}.y`, 0, height - 1);
    const w = int(parcel.w, `${path}.w`, 1);
    const h = int(parcel.h, `${path}.h`, 1);
    if (x + w > width || y + h > height) {
      corrupt(path, `runs off the ${width} x ${height} map (cells ${x}..${x + w - 1} x ${y}..${y + h - 1})`);
    }
    int(parcel.units, `${path}.units`, 0);
    int(parcel.appearsDay, `${path}.appearsDay`, 0);
    oneOf(parcel.zone, `${path}.zone`, ZONES);
  });

  ref(city.coNode, 'city.coNode', nodes.length, 'node');
  return { nodes: nodes.length, segments: segments.length };
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

function checkNetwork(network: Json, city: CityShape, nextId: number): void {
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
  oneOf(olt.tech, 'network.olt.tech', PON_TECHS);
  int(network.version, 'network.version', 0);
}

function checkFinance(finance: Json): void {
  int(finance.cash, 'finance.cash');

  list(finance.monthToDate, 'finance.monthToDate').forEach((value, i) => {
    const path = `finance.monthToDate[${i}]`;
    const entry = obj(value, path);
    int(entry.day, `${path}.day`, 0);
    oneOf(entry.category, `${path}.category`, LEDGER_CATEGORIES);
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
      oneOf(category, `${path}.totals key`, LEDGER_CATEGORIES);
      int(total, `${path}.totals.${category}`);
    }
    int(report.net, `${path}.net`);
    int(report.cashEnd, `${path}.cashEnd`);
    int(report.passings, `${path}.passings`, 0);
  });
}
