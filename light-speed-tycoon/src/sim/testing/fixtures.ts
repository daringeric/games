// Test-only helpers: small, hand-checkable cities that don't depend on the generator.

import { CABINET_START_SPLITTERS, TILE_FT } from '../balance';
import { newGame } from '../game';
import type { CabinetId, City, GameState, NodeId, Parcel, ParcelKind, SegmentId, StreetNode, StreetSegment } from '../types';

export interface GridCityOptions {
  /** Blocks across. Default 3. */
  cols?: number;
  /** Blocks down. Default 2. */
  rows?: number;
  /** Block width in cells. Default 4. */
  blockW?: number;
  /** Block height in cells. Default 2 (two back-to-back rows of lots). */
  blockH?: number;
  /** Poles on every segment. Default true. */
  hasPoles?: boolean;
  /** Rock under every segment. Default false. */
  rock?: boolean;
  /** Lattice coordinates (in blocks) of the CO node. Default [0, 0]. */
  coAt?: [number, number];
  /**
   * Override a lot's kind and units (default: every lot is a 1-unit home).
   * Called once per lot in id order with the lot as built; return undefined to
   * keep the home.
   */
  parcelKinds?: (parcel: Readonly<Parcel>) => { kind: ParcelKind; units: number } | undefined;
}

/**
 * A perfect grid town. Node (i, j) sits at (i * blockW, j * blockH) and has id
 * j * (cols + 1) + i. Horizontal segments come first (id = j * cols + i, joining
 * node (i, j) to (i + 1, j)), then vertical ones (id = H + j * (cols + 1) + i,
 * joining (i, j) to (i, j + 1), where H = (rows + 1) * cols).
 *
 * Every block has a top row of home lots fronting the street above it and, when
 * blockH >= 2, a bottom row fronting the street below it. All parcels exist
 * from day 0.
 */
export function makeGridCity(opts: GridCityOptions = {}): City {
  const cols = opts.cols ?? 3;
  const rows = opts.rows ?? 2;
  const blockW = opts.blockW ?? 4;
  const blockH = opts.blockH ?? 2;
  const hasPoles = opts.hasPoles ?? true;
  const rock = opts.rock ?? false;
  const [coI, coJ] = opts.coAt ?? [0, 0];

  const nodeId = (i: number, j: number) => j * (cols + 1) + i;
  const hSeg = (i: number, j: number) => j * cols + i;
  const H = (rows + 1) * cols;
  const vSeg = (i: number, j: number) => H + j * (cols + 1) + i;

  const nodes: StreetNode[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      nodes.push({ id: nodeId(i, j), x: i * blockW, y: j * blockH });
    }
  }

  const segments: StreetSegment[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i < cols; i++) {
      segments.push({
        id: hSeg(i, j),
        a: nodeId(i, j),
        b: nodeId(i + 1, j),
        streetClass: 'local',
        name: `${j + 1}${ordinalSuffix(j + 1)} St`,
        lengthFt: blockW * TILE_FT,
        hasPoles,
        rock,
        zone: 'residential',
      });
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i <= cols; i++) {
      segments.push({
        id: vSeg(i, j),
        a: nodeId(i, j),
        b: nodeId(i, j + 1),
        streetClass: 'local',
        name: `${String.fromCharCode(65 + (i % 26))} Ave`,
        lengthFt: blockH * TILE_FT,
        hasPoles,
        rock,
        zone: 'residential',
      });
    }
  }

  const parcels: Parcel[] = [];
  const addHome = (x: number, y: number, segment: number) => {
    const parcel: Parcel = {
      id: parcels.length,
      kind: 'home',
      segment,
      x,
      y,
      w: 1,
      h: 1,
      units: 1,
      appearsDay: 0,
      zone: 'residential',
    };
    const override = opts.parcelKinds?.(parcel);
    if (override) {
      parcel.kind = override.kind;
      parcel.units = override.units;
    }
    parcels.push(parcel);
  };
  for (let bj = 0; bj < rows; bj++) {
    for (let bi = 0; bi < cols; bi++) {
      for (let cx = 0; cx < blockW; cx++) {
        const x = bi * blockW + cx;
        addHome(x, bj * blockH, hSeg(bi, bj));
        if (blockH >= 2) addHome(x, bj * blockH + blockH - 1, hSeg(bi, bj + 1));
      }
    }
  }

  return {
    seed: 0,
    name: 'Gridville',
    width: cols * blockW,
    height: rows * blockH,
    tileFt: TILE_FT,
    nodes,
    segments,
    parcels,
    coNode: nodeId(coI, coJ),
  };
}

export interface TestStateOptions {
  /** Game seed (default 1). */
  seed?: number;
  /** Override rng.events (default 12345, a fixed stream independent of the seed). */
  rngEvents?: number;
  /** Override rng.sales (default 54321). */
  rngSales?: number;
}

/**
 * A complete, valid current-schema GameState on `city` for unit tests: exactly
 * newGame(seed, { city }) with fixed RNG states, so tests never hand-build
 * state literals that go stale when GameState grows.
 */
export function makeTestState(city: City = makeGridCity(), opts: TestStateOptions = {}): GameState {
  const state = newGame(opts.seed ?? 1, { city });
  state.rng = { events: opts.rngEvents ?? 12345, sales: opts.rngSales ?? 54321 };
  return state;
}

export interface LivePlantOptions {
  /** Segments to cable (live underground spans, cost 0). Default: every segment of the city. */
  segments?: readonly SegmentId[];
  /** Corner for a live cabinet. Default: the CO node. Null: no cabinet. */
  node?: NodeId | null;
  /** Splitters in that cabinet. Default CABINET_START_SPLITTERS. */
  splitters?: number;
}

/**
 * Plant as if it was built long ago and paid for elsewhere: live spans on
 * `segments` and a live cabinet, written straight into state (no ledger, no
 * capex) with network.version bumped. Returns the cabinet id (or null). Keep
 * the plant within CABINET_REACH_FT of the cabinet along the cable when the
 * test needs every segment lit.
 */
export function addLivePlant(state: GameState, opts: LivePlantOptions = {}): CabinetId | null {
  const segments = opts.segments ?? state.city.segments.map((s) => s.id);
  for (const segment of segments) {
    if (state.network.spans.some((s) => s.segment === segment)) continue;
    state.network.spans.push({
      id: state.nextId++,
      segment,
      method: 'underground',
      stage: 'live',
      stageDaysLeft: 0,
      constructDays: 1,
      cost: 0,
      refundable: 0,
      orderedDay: 0,
      liveDay: 0,
    });
  }
  let cabinet: CabinetId | null = null;
  const node = opts.node === undefined ? state.city.coNode : opts.node;
  if (node !== null) {
    cabinet = state.nextId++;
    state.network.cabinets.push({
      id: cabinet,
      node,
      splitters: opts.splitters ?? CABINET_START_SPLITTERS,
      stage: 'live',
      stageDaysLeft: 0,
      cost: 0,
      orderedDay: 0,
      liveDay: 0,
    });
  }
  state.network.version++;
  return cabinet;
}

function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}
