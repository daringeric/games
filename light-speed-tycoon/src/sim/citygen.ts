// Procedural town generator.
//
// Four passes:
//   1. Plan. Main St and a north-south arterial cross a little off the map
//      center; collectors follow at spacings that widen toward the edge. These
//      coarse lines cut the map into superblocks ("blocks" below), and each
//      block gets a zone from its distance to downtown.
//   2. Streets. Every block gets a local pattern that suits its zone: a tight
//      downtown grid, offset residential blocks, cul-de-sac subdivisions, big
//      industrial blocks, the odd rural lane. Then some local streets are
//      removed (superblocks, dead ends) as long as the network stays connected.
//   3. Lots. Cut along every street frontage, shallow blocks first, so they
//      fill with back-to-back rows and deep blocks get deep lots or backyards.
//   4. Overlays. Poles, rock and growth timing.
//
// Streets are drawn as unit edges on the cell lattice before they become
// nodes and segments; that keeps removal, connectivity checks and lot fitting
// to plain array lookups. Only arithmetic and Math.sqrt are used (no trig or
// pow) so every JS engine generates the same town from a seed.

import { TILE_FT } from './balance';
import { Rng, deriveSeed } from './rng';
import type { City, Parcel, ParcelKind, StreetClass, StreetNode, StreetSegment, Zone } from './types';

export interface CityGenOptions {
  /** Map width in cells. Default 96. */
  width?: number;
  /** Map height in cells. Default 64. */
  height?: number;
  /** Override the generated town name. */
  name?: string;
}

/** Growth plays out over the first five years; no parcel appears after this day. */
export const LAST_GROWTH_DAY = 1825;

const DEFAULT_WIDTH = 96;
const DEFAULT_HEIGHT = 64;
const MIN_WIDTH = 32;
const MIN_HEIGHT = 24;
/** Arterials and collectors keep at least this many cells from the map edge. */
const EDGE_MARGIN = 4;
/** Longer straight runs are split so cable can be ordered a piece at a time. */
const MAX_SEGMENT_CELLS = 12;
/** How far a lot looks across its block for the street behind it. */
const DEPTH_SCAN = 10;
/** The built-up town covers at least this share of the map. */
const MIN_TOWN_SHARE = 0.4;
/** Share of parcels present on day 0 that the growth pass steers toward. */
const DAY0_MIN = 0.72;
const DAY0_MAX = 0.78;

const TOWN_PREFIXES = [
  'Alder', 'Amber', 'Basalt', 'Bramble', 'Cedar', 'Copper', 'Elkhorn', 'Fennel', 'Foxglove', 'Heron',
  'Juniper', 'Kestrel', 'Larkspur', 'Marten', 'Millstone', 'Otter', 'Sorrel', 'Tamarack', 'Thistle', 'Wren',
  'Yarrow',
];
const TOWN_SUFFIXES = [
  'Bend', 'Bluff', 'Crossing', 'Flats', 'Ford', 'Glen', 'Grove', 'Hollow', 'Junction', 'Landing',
  'Meadow', 'Prairie', 'Ridge', 'Run', 'Springs',
];
const ARTERIAL_NAMES = [
  'Pacific Ave', 'Grand Ave', 'Central Ave', 'Broadway', 'Union Ave', 'Commerce St', 'Lakeshore Dr',
  'Highland Ave', 'Valley Blvd', 'Railroad Ave', 'Summit Ave', 'Frontier Rd',
];
const COLLECTOR_NAMES = [
  'Church St', 'School St', 'Mill Rd', 'Depot St', 'Park Ave', 'Lake St', 'Ridge Rd', 'Orchard Rd',
  'River Rd', 'Station Rd', 'College Ave', 'Fairview Rd', 'Hillside Ave', 'Meadow Rd', 'Spring St',
  'Water St', 'Market St', 'Court St', 'Academy St', 'Canal St', 'Quarry Rd', 'Creamery Rd',
  'Fairground Rd', 'Old Post Rd',
];
const TREES = [
  'Alder', 'Aspen', 'Birch', 'Buckeye', 'Catalpa', 'Cedar', 'Cherry', 'Chestnut', 'Cypress', 'Dogwood',
  'Elm', 'Fir', 'Ginkgo', 'Hawthorn', 'Hazel', 'Hemlock', 'Hickory', 'Holly', 'Juniper', 'Larch',
  'Laurel', 'Linden', 'Locust', 'Magnolia', 'Maple', 'Mulberry', 'Oak', 'Olive', 'Pecan', 'Pine',
  'Poplar', 'Redbud', 'Rowan', 'Sassafras', 'Spruce', 'Sumac', 'Sycamore', 'Tamarack', 'Tupelo',
  'Walnut', 'Willow', 'Yew',
];
const TREE_SUFFIXES = ['Ave', 'Ln', 'Way', 'Ct', 'Pl', 'Ter'];

/** Segment zone when its two sides differ: the busier side wins. */
const ZONE_PRIORITY: Record<Zone, number> = { downtown: 3, residential: 2, industrial: 1, rural: 0 };

/**
 * Generate a fictional town from a seed. Pure and deterministic: the same seed
 * and options always produce a deep-equal City. Must satisfy every invariant in
 * types.ts (ids equal indexes; segments axis-aligned between adjacent nodes with
 * no node strictly between them; a < b; every parcel touches its frontage
 * segment; no two parcels overlap; parcels never sit on a street line; the street
 * graph is connected; coNode is a valid node).
 */
export function generateCity(seed: number, opts: CityGenOptions = {}): City {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_WIDTH || height < MIN_HEIGHT) {
    throw new RangeError(`generateCity: map must be at least ${MIN_WIDTH} x ${MIN_HEIGHT} cells, got ${width} x ${height}`);
  }
  // Separate streams so tuning one pass doesn't reshuffle the others.
  const layoutRng = new Rng(deriveSeed(seed, 'citygen:layout'));
  const lotRng = new Rng(deriveSeed(seed, 'citygen:lots'));
  const overlayRng = new Rng(deriveSeed(seed, 'citygen:overlay'));
  const nameRng = new Rng(deriveSeed(seed, 'citygen:names'));

  const plan = planTown(layoutRng, width, height);
  const g = new Lattice(width, height);
  layStreets(layoutRng, plan, g);
  thinStreets(layoutRng, plan, g);

  const geoms = traceSegments(g);
  const names = nameStreets(nameRng, plan, g);
  const { nodes, segments } = buildNetwork(overlayRng, plan, geoms, names);
  const { parcels, lotBlocks } = cutLots(lotRng, plan, g, geoms);
  scheduleGrowth(lotRng, plan, nodes, segments, parcels, lotBlocks);

  return {
    seed,
    name: opts.name ?? `${nameRng.pick(TOWN_PREFIXES)} ${nameRng.pick(TOWN_SUFFIXES)}`,
    width,
    height,
    tileFt: TILE_FT,
    nodes,
    segments,
    parcels,
    coNode: pickCoNode(overlayRng, plan, nodes, segments),
  };
}

// ---------------------------------------------------------------------------
// Street lattice
// ---------------------------------------------------------------------------

/** A straight street run along one lattice line, from < to. */
interface Run {
  horizontal: boolean;
  /** y for horizontal runs, x for vertical ones. */
  line: number;
  from: number;
  to: number;
}

/** Street unit edges on the cell lattice. */
class Lattice {
  readonly width: number;
  readonly height: number;
  /** hs[y * width + x]: street along line y from x to x + 1. */
  private readonly hs: Uint8Array;
  /** vs[y * (width + 1) + x]: street along line x from y to y + 1. */
  private readonly vs: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.hs = new Uint8Array(width * (height + 1));
    this.vs = new Uint8Array((width + 1) * height);
  }

  h(x: number, y: number): boolean {
    return x >= 0 && x < this.width && y >= 0 && y <= this.height && this.hs[y * this.width + x] === 1;
  }

  v(x: number, y: number): boolean {
    return x >= 0 && x <= this.width && y >= 0 && y < this.height && this.vs[y * (this.width + 1) + x] === 1;
  }

  set(run: Run, on: boolean): void {
    for (let t = run.from; t < run.to; t++) {
      if (run.horizontal) this.hs[run.line * this.width + t] = on ? 1 : 0;
      else this.vs[t * (this.width + 1) + run.line] = on ? 1 : 0;
    }
  }

  /** Streets need a node wherever they end, branch or turn. */
  isJunction(x: number, y: number): boolean {
    const w = this.h(x - 1, y);
    const e = this.h(x, y);
    const n = this.v(x, y - 1);
    const s = this.v(x, y);
    const degree = Number(w) + Number(e) + Number(n) + Number(s);
    return degree === 1 || degree > 2 || (degree === 2 && w !== e);
  }

  /** True when every street edge can be reached from lattice point (x, y). */
  connectedFrom(x: number, y: number): boolean {
    const seen = this.reach(x, y);
    const w1 = this.width + 1;
    for (let yy = 0; yy <= this.height; yy++) {
      for (let xx = 0; xx < this.width; xx++) if (this.h(xx, yy) && !seen[yy * w1 + xx]) return false;
    }
    for (let yy = 0; yy < this.height; yy++) {
      for (let xx = 0; xx <= this.width; xx++) if (this.v(xx, yy) && !seen[yy * w1 + xx]) return false;
    }
    return true;
  }

  /** Removes every street edge that cannot be reached from (x, y). */
  pruneFrom(x: number, y: number): void {
    const seen = this.reach(x, y);
    const w1 = this.width + 1;
    for (let yy = 0; yy <= this.height; yy++) {
      for (let xx = 0; xx < this.width; xx++) if (!seen[yy * w1 + xx]) this.hs[yy * this.width + xx] = 0;
    }
    for (let yy = 0; yy < this.height; yy++) {
      for (let xx = 0; xx <= this.width; xx++) if (!seen[yy * w1 + xx]) this.vs[yy * w1 + xx] = 0;
    }
  }

  private reach(x: number, y: number): Uint8Array {
    const w1 = this.width + 1;
    const seen = new Uint8Array(w1 * (this.height + 1));
    const stack = [y * w1 + x];
    seen[y * w1 + x] = 1;
    const visit = (xx: number, yy: number) => {
      const k = yy * w1 + xx;
      if (!seen[k]) {
        seen[k] = 1;
        stack.push(k);
      }
    };
    while (stack.length > 0) {
      const k = stack.pop() as number;
      const px = k % w1;
      const py = (k - px) / w1;
      if (this.h(px - 1, py)) visit(px - 1, py);
      if (this.h(px, py)) visit(px + 1, py);
      if (this.v(px, py - 1)) visit(px, py - 1);
      if (this.v(px, py)) visit(px, py + 1);
    }
    return seen;
  }
}

/** Maximal straight runs between junctions: horizontal by (y, x), then vertical by (x, y). */
function traceRuns(g: Lattice): Run[] {
  const runs: Run[] = [];
  for (let y = 0; y <= g.height; y++) {
    for (let x = 0; x < g.width; ) {
      if (!g.h(x, y)) {
        x++;
        continue;
      }
      let end = x + 1;
      while (end < g.width && g.h(end, y) && !g.isJunction(end, y)) end++;
      runs.push({ horizontal: true, line: y, from: x, to: end });
      x = end;
    }
  }
  for (let x = 0; x <= g.width; x++) {
    for (let y = 0; y < g.height; ) {
      if (!g.v(x, y)) {
        y++;
        continue;
      }
      let end = y + 1;
      while (end < g.height && g.v(x, end) && !g.isJunction(x, end)) end++;
      runs.push({ horizontal: false, line: x, from: y, to: end });
      y = end;
    }
  }
  return runs;
}

/** Final segment geometry: runs, with long ones split evenly. */
function traceSegments(g: Lattice): Run[] {
  const out: Run[] = [];
  for (const run of traceRuns(g)) {
    const len = run.to - run.from;
    const pieces = Math.ceil(len / MAX_SEGMENT_CELLS);
    let prev = run.from;
    for (let i = 1; i <= pieces; i++) {
      const next = run.from + Math.round((i * len) / pieces);
      out.push({ ...run, from: prev, to: next });
      prev = next;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plan: coarse lines, blocks and zones
// ---------------------------------------------------------------------------

interface Block {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  row: number;
  col: number;
  /** Which sides are streets; a side on the map edge is open land. */
  top: boolean;
  bottom: boolean;
  left: boolean;
  right: boolean;
  /** Elliptical distance of the block center from downtown (1 = edge of town). */
  dist: number;
  zone: Zone;
  /** A new subdivision whose homes appear during play. */
  growth: boolean;
  /** Utilities run underground here, so its streets have no poles. */
  underground: boolean;
  /** Odd-depth blocks give their spare row to deep lots rather than backyards. */
  deepLots: boolean;
}

interface Plan {
  width: number;
  height: number;
  /** Where Main St crosses the north-south arterial: the heart of downtown. */
  cx: number;
  cy: number;
  blocks: Block[];
  /** Block index of every cell (y * width + x). */
  cellBlock: Int32Array;
  /** Street class of each horizontal line (by y) and vertical line (by x). */
  hClass: (StreetClass | undefined)[];
  vClass: (StreetClass | undefined)[];
}

function planTown(rng: Rng, width: number, height: number): Plan {
  const scX = clamp(width / DEFAULT_WIDTH, 0.6, 2);
  const scY = clamp(height / DEFAULT_HEIGHT, 0.6, 2);
  // Downtown sits a little off the map center.
  const cx = Math.round(width / 2) + sign(rng) * rng.int(1, Math.max(1, Math.round(width * 0.08)));
  const cy = Math.round(height / 2) + sign(rng) * rng.int(1, Math.max(1, Math.round(height * 0.06)));
  const xs = coarseLines(rng, width, cx, scaled(7, 10, scX), scaled(16, 21, scX));
  const ys = coarseLines(rng, height, cy, scaled(5, 7, scY), scaled(11, 15, scY));

  const bx = [0, ...xs, width];
  const by = [0, ...ys, height];
  const cols = bx.length - 1;
  const rows = by.length - 1;
  const rx = width * 0.36;
  const ry = height * 0.38;
  const blocks: Block[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = bx[col] as number;
      const x1 = bx[col + 1] as number;
      const y0 = by[row] as number;
      const y1 = by[row + 1] as number;
      const dx = ((x0 + x1) / 2 - cx) / rx;
      const dy = ((y0 + y1) / 2 - cy) / ry;
      blocks.push({
        x0,
        y0,
        x1,
        y1,
        row,
        col,
        top: row > 0,
        bottom: row < rows - 1,
        left: col > 0,
        right: col < cols - 1,
        // A little noise keeps the edge of town ragged.
        dist: Math.sqrt(dx * dx + dy * dy) + (rng.next() - 0.5) * 0.16,
        zone: 'residential',
        growth: false,
        underground: false,
        deepLots: false,
      });
    }
  }
  const blockAt = (col: number, row: number): Block | undefined =>
    col >= 0 && col < cols && row >= 0 && row < rows ? blocks[row * cols + col] : undefined;
  const area = (b: Block) => (b.x1 - b.x0) * (b.y1 - b.y0);

  // Downtown: the four blocks around the main crossing, sometimes stretched
  // one more block along Main St.
  const westCol = xs.indexOf(cx);
  const northRow = ys.indexOf(cy);
  const downtownCols = [westCol, westCol + 1];
  const extra = rng.chance(0.5) ? westCol - 1 : westCol + 2;
  if (extra > 0 && extra < cols - 1 && (bx[extra + 1] as number) - (bx[extra] as number) <= Math.round(12 * scX) && rng.chance(0.6)) {
    downtownCols.push(extra);
  }
  for (const col of downtownCols) {
    for (const row of [northRow, northRow + 1]) {
      const b = blockAt(col, row);
      if (b) b.zone = 'downtown';
    }
  }

  // Industrial: the blocks nearest a point out toward one corner of town.
  const ax = cx + sign(rng) * rx * 0.8;
  const ay = cy + sign(rng) * ry * 0.8;
  const industrialMax = width * height * 0.07;
  const candidates = blocks
    .map((b, i) => ({ b, i, d: sq((b.x0 + b.x1) / 2 - ax) + sq((b.y0 + b.y1) / 2 - ay) }))
    .filter(({ b }) => b.zone === 'residential' && b.dist >= 0.45 && b.dist <= 1.15)
    .sort((p, q) => p.d - q.d || p.i - q.i);
  let industrialArea = 0;
  for (const { b } of candidates.slice(0, 3)) {
    if (industrialArea > 0 && industrialArea + area(b) > industrialMax) continue;
    b.zone = 'industrial';
    industrialArea += area(b);
  }

  for (const b of blocks) if (b.zone === 'residential' && b.dist > 1) b.zone = 'rural';
  // Coarse spacing can leave a town too small to be worth wiring: absorb the
  // nearest farmland until it covers a minimum share of the map.
  const rural = blocks.filter((b) => b.zone === 'rural').sort((p, q) => p.dist - q.dist);
  let townArea = blocks.reduce((sum, b) => sum + (b.zone === 'rural' ? 0 : area(b)), 0);
  for (const b of rural) {
    if (townArea >= width * height * MIN_TOWN_SHARE) break;
    b.zone = 'residential';
    townArea += area(b);
  }

  // Growth: rural blocks on the edge of town become subdivisions that fill in
  // during play.
  const residentialArea = blocks.reduce((sum, b) => sum + (b.zone === 'residential' ? area(b) : 0), 0);
  const isResidentialNeighbor = (b: Block) =>
    [blockAt(b.col - 1, b.row), blockAt(b.col + 1, b.row), blockAt(b.col, b.row - 1), blockAt(b.col, b.row + 1)].some(
      (n) => n?.zone === 'residential',
    );
  const edge = rng.shuffle(
    blocks.filter((b) => b.zone === 'rural' && area(b) <= width * height * 0.06 && isResidentialNeighbor(b)),
  );
  let grown = 0;
  for (const b of edge) {
    if (grown >= residentialArea * 0.2) break;
    b.zone = 'residential';
    b.growth = true;
    grown += area(b);
  }
  if (grown === 0) {
    // Small maps may have no rural edge to grow into: the outermost
    // neighborhood is the newest instead.
    const outer = blocks.filter((b) => b.zone === 'residential').sort((p, q) => q.dist - p.dist)[0];
    if (outer) outer.growth = true;
  }

  for (const b of blocks) {
    b.underground = b.zone === 'downtown' || b.growth || (b.zone === 'residential' && rng.chance(0.12));
    b.deepLots = rng.chance(0.5);
  }

  const cellBlock = new Int32Array(width * height);
  blocks.forEach((b, i) => {
    for (let y = b.y0; y < b.y1; y++) cellBlock.fill(i, y * width + b.x0, y * width + b.x1);
  });

  const hClass = new Array<StreetClass | undefined>(height + 1).fill(undefined);
  const vClass = new Array<StreetClass | undefined>(width + 1).fill(undefined);
  // The streets ringing downtown are collectors; further out, about every
  // other coarse line is, and the rest are long local streets.
  ys.forEach((y, i) => {
    hClass[y] = Math.abs(i - northRow) <= 1 || rng.chance(0.5) ? 'collector' : 'local';
  });
  xs.forEach((x, i) => {
    vClass[x] = Math.abs(i - westCol) <= 1 || rng.chance(0.5) ? 'collector' : 'local';
  });
  hClass[cy] = 'arterial';
  vClass[cx] = 'arterial';
  // Sometimes a third arterial (the old highway) crosses town further out.
  const outerLines = [
    ...ys.filter((_, i) => Math.abs(i - northRow) === 2).map((at) => ({ horizontal: true, at })),
    ...xs.filter((_, i) => Math.abs(i - westCol) === 2).map((at) => ({ horizontal: false, at })),
  ];
  if (outerLines.length > 0 && rng.chance(0.65)) {
    const third = rng.pick(outerLines);
    (third.horizontal ? hClass : vClass)[third.at] = 'arterial';
  }
  // Coarse lines that only cross farmland are country roads, not collectors.
  ys.forEach((y, i) => {
    const touchesTown = blocks.some((b) => (b.row === i || b.row === i + 1) && b.zone !== 'rural');
    if (hClass[y] === 'collector' && !touchesTown) hClass[y] = 'local';
  });
  xs.forEach((x, i) => {
    const touchesTown = blocks.some((b) => (b.col === i || b.col === i + 1) && b.zone !== 'rural');
    if (vClass[x] === 'collector' && !touchesTown) vClass[x] = 'local';
  });

  return { width, height, cx, cy, blocks, cellBlock, hClass, vClass };
}

/** Coarse street positions outward from the center line, spacing widening toward the edge. */
function coarseLines(rng: Rng, size: number, center: number, inner: [number, number], ring: [number, number]): number[] {
  const lines = [center];
  for (const dir of [-1, 1]) {
    let at = center + dir * rng.int(inner[0], inner[1]);
    for (let k = 0; at >= EDGE_MARGIN && at <= size - EDGE_MARGIN; k++) {
      lines.push(at);
      at += dir * (rng.int(ring[0], ring[1]) + 2 * k);
    }
  }
  return lines.sort((a, b) => a - b);
}

function blockOfCell(plan: Plan, x: number, y: number): Block | undefined {
  if (x < 0 || y < 0 || x >= plan.width || y >= plan.height) return undefined;
  return plan.blocks[plan.cellBlock[y * plan.width + x] as number];
}

/** The blocks on either side of a street run, sampled at its middle. */
function blocksBeside(plan: Plan, run: Run): Block[] {
  const t = Math.floor((run.from + run.to - 1) / 2);
  const sides = run.horizontal
    ? [blockOfCell(plan, t, run.line - 1), blockOfCell(plan, t, run.line)]
    : [blockOfCell(plan, run.line - 1, t), blockOfCell(plan, run.line, t)];
  return sides.filter((b): b is Block => b !== undefined);
}

function lineClass(plan: Plan, run: Run): StreetClass {
  return (run.horizontal ? plan.hClass[run.line] : plan.vClass[run.line]) ?? 'local';
}

// ---------------------------------------------------------------------------
// Streets: local patterns per block, then thinning
// ---------------------------------------------------------------------------

type Orient = 'h' | 'v';

/**
 * A block seen with its bands of lots running along u and stacking along v.
 * Orient 'h' means u = x, v = y (east-west streets).
 */
interface Frame {
  orient: Orient;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  /** Street on that side (false = map edge). */
  uLo: boolean;
  uHi: boolean;
  vLo: boolean;
  vHi: boolean;
}

function frameOf(b: Block, orient: Orient): Frame {
  return orient === 'h'
    ? { orient, u0: b.x0, u1: b.x1, v0: b.y0, v1: b.y1, uLo: b.left, uHi: b.right, vLo: b.top, vHi: b.bottom }
    : { orient, u0: b.y0, u1: b.y1, v0: b.x0, v1: b.x1, uLo: b.top, uHi: b.bottom, vLo: b.left, vHi: b.right };
}

/** Lays local streets in a frame: `along` runs parallel to the bands, `across` cuts through them. */
function pen(plan: Plan, g: Lattice, f: Frame) {
  const street = (horizontal: boolean, line: number, from: number, to: number) => {
    if (to <= from) return;
    g.set({ horizontal, line, from, to }, true);
    const classes = horizontal ? plan.hClass : plan.vClass;
    classes[line] ??= 'local';
  };
  return {
    along: (v: number, ua: number, ub: number) => street(f.orient === 'h', v, ua, ub),
    across: (u: number, va: number, vb: number) => street(f.orient !== 'h', u, va, vb),
  };
}

function layStreets(rng: Rng, plan: Plan, g: Lattice): void {
  // Coarse lines run edge to edge: the roads in and out of town.
  plan.hClass.forEach((cls, y) => {
    if (cls) g.set({ horizontal: true, line: y, from: 0, to: plan.width }, true);
  });
  plan.vClass.forEach((cls, x) => {
    if (cls) g.set({ horizontal: false, line: x, from: 0, to: plan.height }, true);
  });

  // Neighboring blocks often share their band layout so streets carry on
  // across a collector instead of jogging.
  const sharedBands = new Map<string, number[]>();
  const bandsFor = (b: Block, f: Frame, min: number, max: number, favorSmall: boolean) => {
    const key = `${b.zone}:${f.orient}:${f.orient === 'h' ? b.row : b.col}`;
    const shared = sharedBands.get(key);
    if (shared && rng.chance(0.65)) return shared;
    const bands = cuts(rng, f.v0, f.v1, min, max, favorSmall);
    if (!shared) sharedBands.set(key, bands);
    return bands;
  };

  for (const b of plan.blocks) {
    if (b.zone === 'downtown') {
      const f = frameOf(b, 'h');
      gridStreets(rng, plan, g, f, bandsFor(b, f, 2, 3, false), [4, 6], false);
    } else if (b.zone === 'industrial') {
      const f = frameOf(b, rng.chance(0.5) ? 'h' : 'v');
      gridStreets(rng, plan, g, f, cuts(rng, f.v0, f.v1, 4, 6, false), [8, 16], false);
    } else if (b.zone === 'rural') {
      if (rng.chance(0.4)) ruralLane(rng, plan, g, b);
    } else if (b.growth && rng.chance(0.7)) {
      courtStreets(rng, plan, g, b);
    } else if (b.growth) {
      const f = frameOf(b, rng.chance(0.5) ? 'h' : 'v');
      gridStreets(rng, plan, g, f, cuts(rng, f.v0, f.v1, 2, 3, false), [5, 9], true);
    } else {
      const f = frameOf(b, rng.chance(0.7) ? 'h' : 'v');
      gridStreets(rng, plan, g, f, bandsFor(b, f, 2, 4, true), [5, 8], rng.chance(0.45));
    }
  }
}

/**
 * Rows of lots between parallel streets (`bands` are their v positions), cut
 * into blocks by cross streets. A brick layout staggers the cross streets band
 * by band, giving T-junctions instead of a plain grid.
 */
function gridStreets(rng: Rng, plan: Plan, g: Lattice, f: Frame, bands: number[], lengths: [number, number], brick: boolean): void {
  const { along, across } = pen(plan, g, f);
  // Streets stop a little short of the map edge rather than run into it.
  const inset = rng.int(1, 2);
  const eu0 = f.uLo ? f.u0 : f.u0 + inset;
  const eu1 = f.uHi ? f.u1 : f.u1 - inset;
  const ev0 = f.vLo ? f.v0 : f.v0 + inset;
  const ev1 = f.vHi ? f.v1 : f.v1 - inset;
  for (const v of bands) along(v, eu0, eu1);
  if (!brick) {
    for (const u of cuts(rng, f.u0, f.u1, lengths[0], lengths[1], false)) across(u, ev0, ev1);
    return;
  }
  const edges = [f.v0, ...bands, f.v1];
  for (let i = 0; i + 1 < edges.length; i++) {
    const va = Math.max(edges[i] as number, ev0);
    const vb = Math.min(edges[i + 1] as number, ev1);
    if (vb <= va) continue;
    for (const u of cuts(rng, f.u0, f.u1, lengths[0], lengths[1], false)) across(u, va, vb);
  }
}

/**
 * A newer subdivision: one or more spines run in from the street facing town,
 * with short dead-end courts branching off them.
 */
function courtStreets(rng: Rng, plan: Plan, g: Lattice, b: Block): void {
  const sides = (['top', 'bottom', 'left', 'right'] as const).filter((s) => b[s]);
  const mid = (s: (typeof sides)[number]) => {
    const x = s === 'left' ? b.x0 : s === 'right' ? b.x1 : (b.x0 + b.x1) / 2;
    const y = s === 'top' ? b.y0 : s === 'bottom' ? b.y1 : (b.y0 + b.y1) / 2;
    return sq(x - plan.cx) + sq(y - plan.cy);
  };
  const entrance = sides.sort((p, q) => mid(p) - mid(q))[0];
  const f = entrance ? frameOf(b, entrance === 'top' || entrance === 'bottom' ? 'h' : 'v') : undefined;
  const span = f ? f.u1 - f.u0 : 0;
  const depth = f ? f.v1 - f.v0 : 0;
  if (!f || span < 8 || depth < 7) {
    const grid = frameOf(b, 'h');
    gridStreets(rng, plan, g, grid, cuts(rng, grid.v0, grid.v1, 2, 3, false), [5, 9], true);
    return;
  }
  const { along, across } = pen(plan, g, f);
  const fromLo = entrance === 'top' || entrance === 'left';
  const farIsStreet = fromLo ? f.vHi : f.vLo;
  const through = farIsStreet && rng.chance(0.35);
  const reach = through ? depth : depth - rng.int(2, 3);
  const count = Math.max(1, Math.round(span / 13));
  const spines: number[] = [];
  for (let i = 0; i < count; i++) {
    spines.push(clamp(f.u0 + Math.round(((i + 0.5) * span) / count) + rng.int(-1, 1), f.u0 + 3, f.u1 - 3));
  }
  spines.forEach((u, i) => {
    if (fromLo) across(u, f.v0, f.v0 + reach);
    else across(u, f.v1 - reach, f.v1);
    // Courts stop well short of the next spine so they stay dead ends.
    const roomLo = Math.floor(i === 0 ? u - f.u0 - 2 : (u - (spines[i - 1] as number)) / 2 - 1);
    const roomHi = Math.floor(i === count - 1 ? f.u1 - u - 2 : ((spines[i + 1] as number) - u) / 2 - 1);
    for (let t = rng.int(3, 4); t < reach - 1; t += rng.int(4, 6)) {
      const v = fromLo ? f.v0 + t : f.v1 - t;
      if (rng.chance(0.8)) {
        const len = Math.min(rng.int(3, 5), roomLo);
        if (len >= 2) along(v, u - len, u);
      }
      if (rng.chance(0.8)) {
        const len = Math.min(rng.int(3, 5), roomHi);
        if (len >= 2) along(v, u, u + len);
      }
    }
  });
}

/** A farm lane: a dead-end road off one side of a rural block. */
function ruralLane(rng: Rng, plan: Plan, g: Lattice, b: Block): void {
  const sides = (['top', 'bottom', 'left', 'right'] as const).filter((s) => b[s]);
  if (sides.length === 0) return;
  const side = rng.pick(sides);
  const f = frameOf(b, side === 'top' || side === 'bottom' ? 'h' : 'v');
  const maxLen = Math.min(10, f.v1 - f.v0 - 3);
  if (f.u1 - f.u0 < 8 || maxLen < 4) return;
  const u = rng.int(f.u0 + 3, f.u1 - 3);
  const len = rng.int(4, maxLen);
  const { across } = pen(plan, g, f);
  if (side === 'top' || side === 'left') across(u, f.v0, f.v0 + len);
  else across(u, f.v1 - len, f.v1);
}

/** Removes some local streets for superblocks and dead ends, keeping the network connected. */
function thinStreets(rng: Rng, plan: Plan, g: Lattice): void {
  for (const run of rng.shuffle(traceRuns(g))) {
    const p = removalChance(plan, run);
    if (p === 0 || !rng.chance(p)) continue;
    g.set(run, false);
    if (!g.connectedFrom(plan.cx, plan.cy)) g.set(run, true);
  }
  // Every block pattern touches a street, but make sure nothing is stranded.
  g.pruneFrom(plan.cx, plan.cy);
}

function removalChance(plan: Plan, run: Run): number {
  const cls = lineClass(plan, run);
  if (cls === 'arterial') return 0;
  const beside = blocksBeside(plan, run);
  // Country roads thin out into long rural blocks.
  if (beside.every((b) => b.zone === 'rural')) return 0.3;
  if (cls === 'collector' || beside.some((b) => b.zone === 'downtown' || b.zone === 'rural' || b.growth)) return 0;
  return 0.16;
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/**
 * One name per street line, keyed 'h<y>' / 'v<x>'. North-south streets are
 * numbered west to east; east-west locals take tree names in alphabetical
 * order north to south and collectors take landmark names.
 */
function nameStreets(rng: Rng, plan: Plan, g: Lattice): Map<string, string> {
  const names = new Map<string, string>();
  const hLines: number[] = [];
  const vLines: number[] = [];
  for (let y = 0; y <= plan.height; y++) {
    for (let x = 0; x < plan.width; x++) {
      if (g.h(x, y)) {
        hLines.push(y);
        break;
      }
    }
  }
  for (let x = 0; x <= plan.width; x++) {
    for (let y = 0; y < plan.height; y++) {
      if (g.v(x, y)) {
        vLines.push(x);
        break;
      }
    }
  }

  const arterials = rng.shuffle([...ARTERIAL_NAMES]);
  const collectors = rng.shuffle([...COLLECTOR_NAMES]);
  const hLocals: number[] = [];
  let numbered = 0;
  for (const y of hLines) {
    const cls = plan.hClass[y];
    if (cls === 'arterial') names.set(`h${y}`, y === plan.cy ? 'Main St' : (arterials.pop() as string));
    else if (cls === 'collector') names.set(`h${y}`, collectors.pop() ?? `${TREES[y % TREES.length] as string} Rd`);
    else hLocals.push(y);
  }
  for (const x of vLines) {
    if (plan.vClass[x] === 'arterial') names.set(`v${x}`, arterials.pop() as string);
    else names.set(`v${x}`, `${ordinal(++numbered)} St`);
  }

  // Tree names: Ave first, then other suffixes when a town runs out of trees.
  const pool: string[] = [];
  for (let round = 0; pool.length < hLocals.length; round++) {
    const suffix = TREE_SUFFIXES[round % TREE_SUFFIXES.length] as string;
    const tag = round >= TREE_SUFFIXES.length ? ` ${Math.floor(round / TREE_SUFFIXES.length) + 1}` : '';
    const trees = rng.shuffle([...TREES]).slice(0, hLocals.length - pool.length);
    for (const tree of trees) pool.push(`${tree} ${suffix}${tag}`);
  }
  pool.sort();
  hLocals.forEach((y, i) => names.set(`h${y}`, pool[i] as string));
  return names;
}

// ---------------------------------------------------------------------------
// Network: nodes and segments with poles, rock and zones
// ---------------------------------------------------------------------------

function buildNetwork(rng: Rng, plan: Plan, geoms: Run[], names: Map<string, string>): { nodes: StreetNode[]; segments: StreetSegment[] } {
  const w1 = plan.width + 1;
  const ends = (s: Run): [number, number] =>
    s.horizontal ? [s.line * w1 + s.from, s.line * w1 + s.to] : [s.from * w1 + s.line, s.to * w1 + s.line];
  // Keys grow with (y, x), so sorted ids put a segment's west/north end first.
  const keys = [...new Set(geoms.flatMap(ends))].sort((p, q) => p - q);
  const idOf = new Map(keys.map((k, i) => [k, i]));
  const nodes: StreetNode[] = keys.map((k, id) => ({ id, x: k % w1, y: Math.floor(k / w1) }));

  const rock = markRock(rng, plan, geoms);
  const segments = geoms.map((s, id): StreetSegment => {
    const [ka, kb] = ends(s);
    const beside = blocksBeside(plan, s);
    const zone = beside.reduce<Zone>((z, b) => (ZONE_PRIORITY[b.zone] > ZONE_PRIORITY[z] ? b.zone : z), 'rural');
    // Downtown and newer subdivisions put utilities underground.
    const underground = beside.some((b) => b.zone === 'downtown')
      ? 0.88
      : beside.length > 0 && beside.every((b) => b.underground)
        ? 0.9
        : 0.04;
    return {
      id,
      a: idOf.get(ka) as number,
      b: idOf.get(kb) as number,
      streetClass: lineClass(plan, s),
      name: names.get(`${s.horizontal ? 'h' : 'v'}${s.line}`) as string,
      lengthFt: (s.to - s.from) * TILE_FT,
      hasPoles: !rng.chance(underground),
      rock: rock[id] as boolean,
      zone,
    };
  });
  return { nodes, segments };
}

/**
 * Rock lies in 2-3 blobs, each a cluster of overlapping circles. The blobs are
 * then scaled together until a target share of segment midpoints falls inside.
 */
function markRock(rng: Rng, plan: Plan, geoms: Run[]): boolean[] {
  const { width, height } = plan;
  const circles: { x: number; y: number; r: number }[] = [];
  const base = Math.min(width / DEFAULT_WIDTH, height / DEFAULT_HEIGHT);
  for (let blob = rng.int(2, 3); blob > 0; blob--) {
    const bx = rng.int(Math.round(width * 0.1), Math.round(width * 0.9));
    const by = rng.int(Math.round(height * 0.1), Math.round(height * 0.9));
    const r = rng.int(5, 9) * base;
    for (let i = rng.int(3, 5); i > 0; i--) {
      circles.push({
        x: bx + (rng.next() * 2 - 1) * r * 0.8,
        y: by + (rng.next() * 2 - 1) * r * 0.8,
        r: r * (0.5 + rng.next() * 0.5),
      });
    }
  }
  const mids = geoms.map((s) =>
    s.horizontal ? { x: (s.from + s.to) / 2, y: s.line } : { x: s.line, y: (s.from + s.to) / 2 },
  );
  const inside = (scale: number) =>
    mids.map((m) => circles.some((c) => sq(m.x - c.x) + sq(m.y - c.y) < sq(c.r * scale)));
  const share = (scale: number) => inside(scale).filter(Boolean).length / Math.max(1, mids.length);
  const target = 0.08 + rng.next() * 0.07;
  let lo = 0;
  let hi = 8;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (share(m) < target) lo = m;
    else hi = m;
  }
  return inside(hi);
}

// ---------------------------------------------------------------------------
// Lots
// ---------------------------------------------------------------------------

/** One side of a segment, with lots extending away from the street in `dir`. */
interface Side {
  seg: number;
  horizontal: boolean;
  line: number;
  from: number;
  to: number;
  /** +1: lots below / right of the street; -1: above / left. */
  dir: 1 | -1;
  cls: StreetClass;
  /** Cells to the next parallel street behind the lots, at mid-side. */
  depth: number;
  /** Block the lots fall in, at mid-side. */
  block: Block | undefined;
}

function cutLots(rng: Rng, plan: Plan, g: Lattice, geoms: Run[]): { parcels: Parcel[]; lotBlocks: Block[] } {
  const { width, height } = plan;
  const occupied = new Int32Array(width * height).fill(-1);
  const parcels: Parcel[] = [];
  const lotBlocks: Block[] = [];

  const frontCell = (s: Side, t: number): [number, number] => {
    const across = s.dir > 0 ? s.line : s.line - 1;
    return s.horizontal ? [t, across] : [across, t];
  };
  const depthAt = (s: Side, t: number): number => {
    for (let k = 1; k <= DEPTH_SCAN; k++) {
      const line = s.line + s.dir * k;
      if (line < 0 || line > (s.horizontal ? height : width)) return Infinity;
      if (s.horizontal ? g.h(t, line) : g.v(line, t)) return k;
    }
    return Infinity;
  };

  const sides: Side[] = [];
  geoms.forEach((geom, seg) => {
    for (const dir of [-1, 1] as const) {
      const side: Side = { ...geom, seg, dir, cls: lineClass(plan, geom), depth: 0, block: undefined };
      const t = Math.floor((geom.from + geom.to - 1) / 2);
      side.block = blockOfCell(plan, ...frontCell(side, t));
      if (!side.block) continue;
      side.depth = depthAt(side, t);
      sides.push(side);
    }
  });
  // Shallow frontages first, so back-to-back rows claim their cells before
  // the long side streets of the same block do.
  sides.sort((p, q) => p.depth - q.depth || p.seg - q.seg || p.dir - q.dir);

  /** Lot rectangle w cells along the street and d cells deep. */
  const rectOf = (s: Side, t: number, w: number, d: number) => {
    const back = s.dir > 0 ? s.line : s.line - d;
    return s.horizontal ? { x: t, y: back, w, h: d } : { x: back, y: t, w: d, h: w };
  };
  const fits = (s: Side, t: number, w: number, d: number, block: Block): boolean => {
    if (t < s.from || t + w > s.to) return false;
    const r = rectOf(s, t, w, d);
    if (r.x < 0 || r.y < 0 || r.x + r.w > width || r.y + r.h > height) return false;
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (occupied[y * width + x] !== -1 || blockOfCell(plan, x, y) !== block) return false;
      }
    }
    // No street may cross the lot's interior.
    for (let y = r.y + 1; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) if (g.h(x, y)) return false;
    }
    for (let x = r.x + 1; x < r.x + r.w; x++) {
      for (let y = r.y; y < r.y + r.h; y++) if (g.v(x, y)) return false;
    }
    return true;
  };
  const add = (s: Side, t: number, w: number, d: number, block: Block, kind: ParcelKind, units: number) => {
    const r = rectOf(s, t, w, d);
    const id = parcels.length;
    for (let y = r.y; y < r.y + r.h; y++) occupied.fill(id, y * width + r.x, y * width + r.x + r.w);
    parcels.push({ id, kind, segment: s.seg, ...r, units, appearsDay: 0, zone: block.zone });
    lotBlocks.push(block);
  };
  /** Places the largest lot up to w x d that fits; returns its frontage or 0. */
  const place = (s: Side, t: number, w: number, d: number, block: Block, kind: ParcelKind): number => {
    for (let ww = w; ww >= 1; ww--) {
      for (let dd = d; dd >= 1; dd--) {
        if (fits(s, t, ww, dd, block)) {
          add(s, t, ww, dd, block, kind, 1);
          return ww;
        }
      }
    }
    return 0;
  };
  /** Half the block depth (rounded toward deep lots where the block allows), capped. */
  const lotDepth = (s: Side, t: number, block: Block, max: number): number => {
    const d = depthAt(s, t);
    if (!Number.isFinite(d)) return max;
    const half = Math.floor(d / 2) + (d % 2 === 1 && block.deepLots && s.dir < 0 ? 1 : 0);
    return clamp(half, 1, max);
  };
  /** Visits each free frontage cell; `step` returns how many cells to advance. */
  const walk = (filter: (s: Side) => boolean, step: (s: Side, t: number, block: Block) => number) => {
    for (const s of sides) {
      if (!filter(s)) continue;
      for (let t = s.from; t < s.to; ) {
        const [x, y] = frontCell(s, t);
        const block = blockOfCell(plan, x, y);
        if (!block || occupied[y * width + x] !== -1) t++;
        else t += Math.max(1, step(s, t, block));
      }
    }
  };
  /** Scatters `want` apartment buildings over the given sides. */
  const placeMdus = (pool: Side[], want: number, maxUnits: number) => {
    let placed = 0;
    for (let tries = 0; placed < want && tries < want * 25 && pool.length > 0; tries++) {
      const s = rng.pick(pool);
      const t = rng.int(s.from, s.to - 1);
      const [x, y] = frontCell(s, t);
      const block = blockOfCell(plan, x, y);
      const room = Math.min(3, depthAt(s, t));
      if (!block || block !== s.block || room < 2) continue;
      const w = rng.int(2, 4);
      const d = rng.int(2, room);
      if (!fits(s, t, w, d, block)) continue;
      add(s, t, w, d, block, 'mdu', clamp(Math.round(w * d * (2 + rng.next() * 3)), 8, maxUnits));
      placed++;
    }
  };
  const zoneIs = (zone: Zone) => (s: Side) => s.block?.zone === zone;
  const cellsIn = (pred: (b: Block) => boolean) =>
    plan.blocks.reduce((sum, b) => sum + (pred(b) ? (b.x1 - b.x0) * (b.y1 - b.y0) : 0), 0);

  // Downtown: apartments over shops, storefronts along the main streets,
  // then a mix of businesses and old houses on the side streets.
  const downtownSides = sides.filter(zoneIs('downtown'));
  placeMdus(downtownSides, Math.max(2, Math.round(cellsIn((b) => b.zone === 'downtown') / 28)), 48);
  walk(
    (s) => zoneIs('downtown')(s) && s.cls !== 'local',
    (s, t, block) => (block.zone === 'downtown' && rng.chance(0.95) ? place(s, t, 1, lotDepth(s, t, block, 2), block, 'smb') : 1),
  );
  walk(zoneIs('downtown'), (s, t, block) => {
    if (block.zone !== 'downtown') return 1;
    const roll = rng.next();
    if (roll < 0.45) return place(s, t, 1, lotDepth(s, t, block, 2), block, 'smb');
    if (roll < 0.8) return place(s, t, 1, lotDepth(s, t, block, 2), block, 'home');
    return 1;
  });

  // A few garden apartments on the busier streets near downtown.
  const nearSides = sides.filter((s) => s.block?.zone === 'residential' && s.block.dist < 0.75 && s.cls !== 'local');
  placeMdus(nearSides, Math.round(cellsIn((b) => b.zone === 'residential' && !b.growth) / 350), 32);

  walk(zoneIs('industrial'), (s, t, block) => {
    if (block.zone !== 'industrial' || !rng.chance(0.8)) return 1;
    return place(s, t, rng.int(2, 4), lotDepth(s, t, block, 3), block, 'smb');
  });

  walk(zoneIs('residential'), (s, t, block) => {
    if (block.zone !== 'residential') return 1;
    // The odd corner store or office on a busy street.
    if (s.cls !== 'local' && !block.growth && rng.chance(0.05)) return place(s, t, 1, 1, block, 'smb');
    if (!rng.chance(block.growth ? 0.97 : 0.94)) return 1;
    return place(s, t, 1, lotDepth(s, t, block, 2), block, 'home');
  });

  // Farmhouses: sparse, on bigger lots.
  walk(zoneIs('rural'), (s, t, block) => {
    if (block.zone !== 'rural' || !rng.chance(0.2)) return 1;
    const w = place(s, t, rng.int(1, 2), 2, block, 'home');
    return w === 0 ? 1 : w + rng.int(2, 5);
  });

  return { parcels, lotBlocks };
}

// ---------------------------------------------------------------------------
// Growth
// ---------------------------------------------------------------------------

/**
 * New subdivisions open on their own dates and fill street by street, a few
 * downtown apartment buildings go up later, and the day-0 share is nudged into
 * range: by treating early subdivision homes as already built, or by letting
 * whole outlying streets fill in over time.
 */
function scheduleGrowth(rng: Rng, plan: Plan, nodes: StreetNode[], segments: StreetSegment[], parcels: Parcel[], lotBlocks: Block[]): void {
  const segDist = (seg: number) => {
    const s = segments[seg] as StreetSegment;
    const a = nodes[s.a] as StreetNode;
    const b = nodes[s.b] as StreetNode;
    return sq((a.x + b.x) / 2 - plan.cx) + sq((a.y + b.y) / 2 - plan.cy);
  };
  const clampDay = (day: number) => clamp(day, 1, LAST_GROWTH_DAY);

  for (const block of plan.blocks) {
    if (!block.growth) continue;
    const lots = parcels.filter((_, i) => lotBlocks[i] === block);
    const streets = [...new Set(lots.map((p) => p.segment))].sort((p, q) => segDist(p) - segDist(q) || p - q);
    const start = rng.int(30, 1100);
    const span = rng.int(300, 700);
    streets.forEach((seg, k) => {
      const open = start + Math.round((k / streets.length) * span);
      for (const p of lots) if (p.segment === seg) p.appearsDay = clampDay(open + rng.int(0, 45));
    });
  }

  const downtownMdus = rng.shuffle(parcels.filter((p) => p.kind === 'mdu' && p.zone === 'downtown'));
  for (const p of downtownMdus.slice(0, Math.floor(downtownMdus.length / 4))) p.appearsDay = rng.int(180, 1700);

  const total = parcels.length;
  const goal = total * (1 - (DAY0_MIN + 0.01 + rng.next() * (DAY0_MAX - DAY0_MIN - 0.02)));
  let later = parcels.filter((p) => p.appearsDay > 0).length;
  if (later > total * (1 - DAY0_MIN)) {
    const early = parcels
      .filter((p, i) => p.appearsDay > 0 && lotBlocks[i]?.growth)
      .sort((p, q) => p.appearsDay - q.appearsDay || p.id - q.id);
    for (const p of early) {
      if (later <= goal) break;
      p.appearsDay = 0;
      later--;
    }
  } else if (later < total * (1 - DAY0_MAX)) {
    const homesBySeg = new Map<number, Parcel[]>();
    parcels.forEach((p, i) => {
      if (p.kind !== 'home' || p.appearsDay > 0 || lotBlocks[i]?.zone !== 'residential') return;
      const list = homesBySeg.get(p.segment) ?? [];
      list.push(p);
      homesBySeg.set(p.segment, list);
    });
    // Outlying streets first, with some shuffle.
    const streets = [...homesBySeg.keys()]
      .map((seg) => ({ seg, key: segDist(seg) * (0.7 + rng.next() * 0.6) }))
      .sort((p, q) => q.key - p.key || p.seg - q.seg);
    for (const { seg } of streets) {
      if (later >= goal) break;
      const open = rng.int(60, 1700);
      for (const p of homesBySeg.get(seg) ?? []) {
        if (later >= goal) break;
        p.appearsDay = clampDay(open + rng.int(0, 120));
        later++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Central office
// ---------------------------------------------------------------------------

/** An arterial node on the edge of downtown, where the CO building sits. */
function pickCoNode(rng: Rng, plan: Plan, nodes: StreetNode[], segments: StreetSegment[]): number {
  const degree = new Array<number>(nodes.length).fill(0);
  const arterial = new Array<boolean>(nodes.length).fill(false);
  for (const s of segments) {
    degree[s.a] = (degree[s.a] as number) + 1;
    degree[s.b] = (degree[s.b] as number) + 1;
    if (s.streetClass === 'arterial') {
      arterial[s.a] = true;
      arterial[s.b] = true;
    }
  }
  const downtown = plan.blocks.filter((b) => b.zone === 'downtown');
  const x0 = Math.min(...downtown.map((b) => b.x0));
  const x1 = Math.max(...downtown.map((b) => b.x1));
  const y0 = Math.min(...downtown.map((b) => b.y0));
  const y1 = Math.max(...downtown.map((b) => b.y1));
  // Distance from the downtown rectangle's outline.
  const edgeDist = (n: StreetNode) => {
    const inside = n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1;
    if (inside) return Math.min(n.x - x0, x1 - n.x, n.y - y0, y1 - n.y);
    return Math.max(x0 - n.x, n.x - x1, 0) + Math.max(y0 - n.y, n.y - y1, 0);
  };
  const usable = nodes.filter((n) => arterial[n.id] && (degree[n.id] as number) >= 2);
  const pool = usable.length > 0 ? usable : nodes.filter((n) => (degree[n.id] as number) >= 2);
  const best = Math.min(...pool.map(edgeDist));
  return rng.pick(pool.filter((n) => edgeDist(n) === best)).id;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Inner cut points that split [lo, hi] into pieces of min..max cells.
 * favorSmall biases toward more, smaller pieces. A length that can't be split
 * within the limits comes back as fewer, oversized pieces.
 */
function cuts(rng: Rng, lo: number, hi: number, min: number, max: number, favorSmall: boolean): number[] {
  const len = hi - lo;
  const kMax = Math.floor(len / min);
  const kMin = Math.max(1, Math.ceil(len / max));
  if (kMax < 2) return [];
  const r = favorSmall ? sq(rng.next()) : rng.next();
  const k = kMin >= kMax ? kMax : kMax - Math.floor(r * (kMax - kMin + 1));
  if (k < 2) return [];
  const sizes = new Array<number>(k).fill(min);
  for (let extra = len - k * min; extra > 0; extra--) {
    let i = rng.int(0, k - 1);
    for (let tries = 0; tries < k && (sizes[i] as number) >= max; tries++) i = (i + 1) % k;
    sizes[i] = (sizes[i] as number) + 1;
  }
  const out: number[] = [];
  let at = lo;
  for (let i = 0; i < k - 1; i++) {
    at += sizes[i] as number;
    out.push(at);
  }
  return out;
}

function scaled(lo: number, hi: number, scale: number): [number, number] {
  const a = Math.max(3, Math.round(lo * scale));
  return [a, Math.max(a, Math.round(hi * scale))];
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function sq(v: number): number {
  return v * v;
}

function sign(rng: Rng): 1 | -1 {
  return rng.chance(0.5) ? 1 : -1;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}
