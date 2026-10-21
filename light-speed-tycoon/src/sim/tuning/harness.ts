// Headless balance harness: plays a bot on a generated town for N months
// through the real sim (commands + daily ticks, no DOM), records every monthly
// report and its KPIs, and measures the town the balance targets are about
// (size, build-out cost, cost per passing of typical cable runs).
//
// Owner: balance-tuning workstream. Used by targets.test.ts (the balance
// targets), report.test.ts (TUNE_REPORT=1 prints the numbers) and
// invariants.test.ts (long mixed sessions). Pure and deterministic: bots draw
// from their own Rng, never from the game's streams.

import { CABINET_COST, CABINET_REACH_FT, SPLITTER_COST } from '../balance';
import { dayOf, MONTH_LENGTHS } from '../calendar';
import { creditLimit, penaltyBps, termCapacity } from '../debt';
import { applyCommand, newGame, tick } from '../game';
import { reportKpis } from '../metrics';
import type { ReportKpis } from '../metrics';
import { orderFees, quoteCable, spanCharges } from '../network';
import { otherEnd, parcelsServedBy, segmentsAtNode, segmentsWithin } from '../streets';
import type {
  CableMethod,
  City,
  Command,
  CommandResult,
  CovenantStage,
  GameOver,
  GameState,
  MonthlyReport,
  SegmentId,
  StreetSegment,
  Zone,
} from '../types';

/** The seeds every balance target is checked on. */
export const TUNING_SEEDS: readonly number[] = [1, 2027, 424242, 99, 12345];

/** Bots look at the game and act once every this many days (day 0 included). */
export const BOT_INTERVAL_DAYS = 7;

/** Sends one command to the game (applyCommand, counted by the harness). */
export type Send = (cmd: Command) => CommandResult;

/** A scripted player. It changes the game only through `send`. */
export interface Bot {
  readonly name: string;
  /** Called on day 0 and every BOT_INTERVAL_DAYS days after, before that day's tick. */
  act(state: GameState, send: Send): void;
}

export type BotFactory = (seed: number) => Bot;

export interface RunResult {
  seed: number;
  bot: string;
  /** Final state (after the last close played, or the close that ended the game). */
  state: GameState;
  /** Every closed month of the run, oldest first (reports[0] is month 1). */
  reports: MonthlyReport[];
  /** reportKpis of each report (every round-2 close writes stats). */
  kpis: ReportKpis[];
  gameOver: GameOver | null;
  /** 1-based month whose close ended the game, else null. */
  gameOverMonth: number | null;
  /** Successful commands by type, and how many were rejected. */
  commands: Record<string, number>;
  /** 1-based month in which each command type first succeeded. */
  firstMonth: Record<string, number>;
  rejected: number;
  /** Milliseconds the run took by opts.clock (0 without one: the sim never reads a clock itself). */
  ms: number;
  /** borrowingCapacity on the day the run started (before the bot's first look). */
  capacityAtStart: number;
  /** Most borrowingCapacity seen on any day before the first subscriber signed up (whole run if nobody ever did). */
  capacityBeforeFirstSubscriber: number;
  /** borrowingCapacity right after each close of the run (capacityAfterClose[0] after month 1). */
  capacityAfterClose: number[];
}

export interface RunOptions {
  /** Start from this state instead of newGame(seed) (e.g. a loaded save). */
  state?: GameState;
  /** Called after every tick (invariant checks). */
  afterTick?: (state: GameState) => void;
  /** Called after every command the bot sends, with the cash before it. */
  afterCommand?: (state: GameState, cmd: Command, result: CommandResult, cashBefore: number) => void;
  /**
   * A millisecond clock to time the run with (tests pass performance.now).
   * Nothing under src/sim reads a clock itself (README purity rule).
   */
  clock?: () => number;
}

/**
 * Play `makeBot(seed)` on newGame(seed) (or opts.state) until `months` month
 * closes have happened or the game is over. The bot acts on day 0 and every
 * BOT_INTERVAL_DAYS days, before that day's tick.
 */
export function runBot(seed: number, makeBot: BotFactory, months: number, opts: RunOptions = {}): RunResult {
  const started = opts.clock?.() ?? 0;
  const state = opts.state ?? newGame(seed);
  const bot = makeBot(seed);
  const commands: Record<string, number> = {};
  const firstMonth: Record<string, number> = {};
  let rejected = 0;
  const startReports = state.finance.reports.length;
  const capacityAtStart = borrowingCapacity(state);
  let capacityBeforeFirstSubscriber = 0;
  const capacityAfterClose: number[] = [];
  const noSubscriberYet = () => state.sales.accounts.length === 0 && state.sales.connectsTotal === 0;
  const send: Send = (cmd) => {
    const cashBefore = state.finance.cash;
    const result = applyCommand(state, cmd);
    if (result.ok) {
      commands[cmd.type] = (commands[cmd.type] ?? 0) + 1;
      firstMonth[cmd.type] ??= state.finance.reports.length - startReports + 1;
    } else {
      rejected++;
    }
    opts.afterCommand?.(state, cmd, result, cashBefore);
    return result;
  };
  while (state.finance.reports.length - startReports < months && !state.gameOver) {
    if (noSubscriberYet()) capacityBeforeFirstSubscriber = Math.max(capacityBeforeFirstSubscriber, borrowingCapacity(state));
    if (state.day % BOT_INTERVAL_DAYS === 0) bot.act(state, send);
    const closes = state.finance.reports.length;
    tick(state);
    if (state.finance.reports.length > closes) capacityAfterClose.push(borrowingCapacity(state));
    opts.afterTick?.(state);
  }
  const reports = state.finance.reports.slice(startReports);
  const kpis = reports.map((r) => {
    const k = reportKpis(r);
    if (!k) throw new Error('a round-2 month close wrote no stats');
    return k;
  });
  return {
    seed,
    bot: bot.name,
    state,
    reports,
    kpis,
    gameOver: state.gameOver,
    gameOverMonth: state.gameOver ? reports.length : null,
    commands,
    firstMonth,
    rejected,
    ms: opts.clock ? opts.clock() - started : 0,
    capacityAtStart,
    capacityBeforeFirstSubscriber,
    capacityAfterClose,
  };
}

// ---------------------------------------------------------------------------
// Financing measures (round 3)
// ---------------------------------------------------------------------------

/** What the bank would lend now: the credit-line limit plus term-loan capacity (debt.creditLimit + debt.termCapacity). */
export function borrowingCapacity(state: GameState): number {
  return creditLimit(state) + termCapacity(state);
}

/** Total debt at a report's month end (credit line + term loans); 0 for a report without debt stats. */
export function reportDebt(report: MonthlyReport): number {
  return report.debt ? report.debt.creditBalance + report.debt.termBalance : 0;
}

/** Most total debt at any month end of the run. */
export function peakDebt(result: RunResult): number {
  return result.reports.reduce((peak, r) => Math.max(peak, reportDebt(r)), 0);
}

/**
 * Debt-weighted average borrowing rate of the run, bps: sum(total debt x
 * averageRateBps) / sum(total debt) over the month ends with debt (penalty
 * included, as DebtStats records it); null if the run never borrowed.
 * `withoutPenalty`: only month ends whose stage carries no penalty surcharge
 * ('compliant' or 'warning'), i.e. the risk pricing alone.
 */
export function averageBorrowingRate(result: RunResult, withoutPenalty = false): number | null {
  let weighted = 0;
  let total = 0;
  for (const report of result.reports) {
    const debt = reportDebt(report);
    const rate = report.debt?.averageRateBps;
    if (debt <= 0 || rate === null || rate === undefined) continue;
    if (withoutPenalty && penaltyBps(report.debt?.stage ?? 'compliant') > 0) continue;
    weighted += debt * rate;
    total += debt;
  }
  return total > 0 ? weighted / total : null;
}

const STAGE_RANK: Record<CovenantStage, number> = { compliant: 0, warning: 1, penalty: 2, frozen: 3 };

/** The worst covenant stage any close of the run ended in ('compliant' for a run without debt stats). */
export function worstStage(result: RunResult): CovenantStage {
  let worst: CovenantStage = 'compliant';
  for (const report of result.reports) {
    const stage = report.debt?.stage;
    if (stage && STAGE_RANK[stage] > STAGE_RANK[worst]) worst = stage;
  }
  return worst;
}

/** Stage changes of the run as "m7 warning, m8 penalty, ..." entries: [month, stage after that close]. */
export function stageHistory(result: RunResult): Array<[number, CovenantStage]> {
  const changes: Array<[number, CovenantStage]> = [];
  let last: CovenantStage = 'compliant';
  result.reports.forEach((report, i) => {
    const stage = report.debt?.stage ?? 'compliant';
    if (stage !== last) changes.push([i + 1, stage]);
    last = stage;
  });
  return changes;
}

/** Share of the month ends with debt at which lifetime cost per passing was red (metrics.cppBand); null without debt. */
export function redWhileOwingShare(result: RunResult): number | null {
  let owing = 0;
  let red = 0;
  result.reports.forEach((report, i) => {
    if (reportDebt(report) <= 0) return;
    owing++;
    if (result.kpis[i]?.cppBand === 'red') red++;
  });
  return owing > 0 ? red / owing : null;
}

/** 1-based months whose close missed its debt service. */
export function missedPaymentMonths(result: RunResult): number[] {
  const months: number[] = [];
  result.reports.forEach((report, i) => {
    if (report.debt?.missedPayment) months.push(i + 1);
  });
  return months;
}

/** Units on parcels that exist on `day` (appearsDay <= day). */
export function unitsPresent(city: City, day: number): number {
  let units = 0;
  for (const parcel of city.parcels) if (parcel.appearsDay <= day) units += parcel.units;
  return units;
}

/** Last day of the month a report closed. */
export function reportLastDay(report: MonthlyReport): number {
  return dayOf({ year: report.year, month: report.month, day: MONTH_LENGTHS[report.month - 1] as number });
}

/**
 * Share of the town's units passed at the end of 1-based `month`: the report's
 * passings over the units on parcels present on that month's last day (the
 * passings were counted then too); null past the end of the run.
 */
export function passedShare(result: RunResult, month: number): number | null {
  const report = result.reports[month - 1];
  if (!report) return null;
  const units = unitsPresent(result.state.city, reportLastDay(report));
  return units > 0 ? report.passings / units : null;
}

/** 1-based month of the first close with operating cash flow > 0, or null. */
export function firstPositiveMonth(result: RunResult): number | null {
  const i = result.kpis.findIndex((k) => k.operatingCashFlow > 0);
  return i < 0 ? null : i + 1;
}

/** Average voluntary churn per month over the run: sum(churned) / sum(month-start subscribers), months with subscribers only. */
export function averageChurn(result: RunResult): number | null {
  let churned = 0;
  let base = 0;
  let prevSubs = 0;
  for (const report of result.reports) {
    const stats = report.stats;
    if (!stats) continue;
    // Subscribers exposed to this close's churn: month-end count plus those who just left.
    const exposed = stats.subscribers + stats.churned;
    if (prevSubs > 0 || exposed > 0) {
      churned += stats.churned;
      base += exposed;
    }
    prevSubs = stats.subscribers;
  }
  return base > 0 ? churned / base : null;
}

/** Mean ARPU over months that billed anyone. */
export function averageArpu(result: RunResult, fromMonth = 1, toMonth = result.kpis.length): number | null {
  const values = result.kpis
    .slice(fromMonth - 1, toMonth)
    .map((k) => k.arpu)
    .filter((v): v is number => v !== null);
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

// ---------------------------------------------------------------------------
// Town facts
// ---------------------------------------------------------------------------

export interface TownFacts {
  /** Units on parcels present on day 0, and at full growth. */
  unitsDay0: number;
  unitsFull: number;
  streetFt: number;
  /** Shares of street length with poles / on rock. */
  poledShare: number;
  rockShare: number;
  /** Street feet per day-0 unit, by the zone of the serving street (null: no units). */
  ftPerUnit: Record<Zone, number | null>;
}

export function townFacts(city: City): TownFacts {
  let unitsDay0 = 0;
  let unitsFull = 0;
  let streetFt = 0;
  let poled = 0;
  let rock = 0;
  const zoneFt: Record<Zone, number> = { downtown: 0, residential: 0, industrial: 0, rural: 0 };
  const zoneUnits: Record<Zone, number> = { downtown: 0, residential: 0, industrial: 0, rural: 0 };
  for (const seg of city.segments) {
    streetFt += seg.lengthFt;
    if (seg.hasPoles) poled += seg.lengthFt;
    if (seg.rock) rock += seg.lengthFt;
    zoneFt[seg.zone] += seg.lengthFt;
  }
  for (const parcel of city.parcels) {
    unitsFull += parcel.units;
    if (parcel.appearsDay > 0) continue;
    unitsDay0 += parcel.units;
    const seg = city.segments[parcel.segment];
    if (seg) zoneUnits[seg.zone] += parcel.units;
  }
  const ftPerUnit = {} as Record<Zone, number | null>;
  for (const zone of Object.keys(zoneFt) as Zone[]) {
    ftPerUnit[zone] = zoneUnits[zone] > 0 ? zoneFt[zone] / zoneUnits[zone] : null;
  }
  return {
    unitsDay0,
    unitsFull,
    streetFt,
    poledShare: streetFt > 0 ? poled / streetFt : 0,
    rockShare: streetFt > 0 ? rock / streetFt : 0,
    ftPerUnit,
  };
}

/** Cheapest buildable method on a segment (aerial where poled and not dearer) and its charges before fees. */
export function cheapestMethod(segment: StreetSegment): { method: CableMethod; cost: number } {
  const underground = spanCharges(segment, 'underground').total;
  if (segment.hasPoles) {
    const aerial = spanCharges(segment, 'aerial').total;
    if (aerial <= underground) return { method: 'aerial', cost: aerial };
  }
  return { method: 'underground', cost: underground };
}

/** Feet of street per cable order assumed by townBuildOut (a typical drag-to-draw order). */
export const BUILD_OUT_ORDER_FT = 2_000;

export interface TownBuildOut {
  /** Every segment cabled with its cheaper buildable method (spanCharges totals). */
  cable: number;
  /** Per-order fees, one order per BUILD_OUT_ORDER_FT of street of each method. */
  fees: number;
  /** Cabinets in the greedy cover. */
  cabinets: number;
  /** cabinets x (CABINET_COST + SPLITTER_COST). */
  cabinetCost: number;
  total: number;
}

/**
 * What it costs to light the whole town: every street segment cabled the
 * cheaper buildable way, per-order fees at one order per BUILD_OUT_ORDER_FT of
 * street, and a greedy cabinet cover (repeatedly the corner whose street reach
 * covers the most still-uncovered segments that serve parcels, present or
 * future, until all are covered) at CABINET_COST + SPLITTER_COST each.
 */
export function townBuildOut(city: City): TownBuildOut {
  let cable = 0;
  const methodFt: Record<CableMethod, number> = { aerial: 0, underground: 0 };
  for (const seg of city.segments) {
    const cheapest = cheapestMethod(seg);
    cable += cheapest.cost;
    methodFt[cheapest.method] += seg.lengthFt;
  }
  let fees = 0;
  for (const method of ['aerial', 'underground'] as const) {
    fees += Math.ceil(methodFt[method] / BUILD_OUT_ORDER_FT) * orderFees(method);
  }

  const serving = new Set<SegmentId>();
  for (const parcel of city.parcels) serving.add(parcel.segment);
  const reachOf = city.nodes.map((node) =>
    segmentsWithin(city, node.id, CABINET_REACH_FT)
      .map((r) => r.segment)
      .filter((s) => serving.has(s)),
  );
  const uncovered = new Set(serving);
  let cabinets = 0;
  while (uncovered.size > 0) {
    let best = -1;
    let bestCount = 0;
    reachOf.forEach((segments, node) => {
      let count = 0;
      for (const s of segments) if (uncovered.has(s)) count++;
      if (count > bestCount) {
        bestCount = count;
        best = node;
      }
    });
    if (best < 0) break; // unreachable leftovers (cannot happen on a connected town)
    for (const s of reachOf[best] ?? []) uncovered.delete(s);
    cabinets++;
  }
  const cabinetCost = cabinets * (CABINET_COST + SPLITTER_COST);
  return { cable, fees, cabinets, cabinetCost, total: cable + fees + cabinetCost };
}

// ---------------------------------------------------------------------------
// Cost-per-passing probes: quoteCable on typical single-order runs
// ---------------------------------------------------------------------------

export const PROBE_MIN_FT = 1_500;
export const PROBE_MAX_FT = 2_500;
/** A "dense" run has at least one day-0 unit per this many feet of street. */
export const DENSE_FT_PER_UNIT = 35;
/** Rural runs may bridge onto non-rural streets this sparse (ft per unit or more). */
const RURAL_BRIDGE_FT_PER_UNIT = 120;
/** Share of a rural run's length that must be rural-zone street. */
const RURAL_MIN_SHARE = 0.6;

export interface CppProbe {
  segments: SegmentId[];
  method: CableMethod;
  lengthFt: number;
  cost: number;
  passings: number;
  /** quoteCable(...).cpp: cost (fees included) per unit passed along the run. */
  cpp: number;
}

export interface CppProbes {
  denseAerial: CppProbe[];
  denseUnderground: CppProbe[];
  rural: CppProbe[];
}

function day0Units(city: City, segment: SegmentId): number {
  let units = 0;
  for (const pid of parcelsServedBy(city, segment)) {
    const parcel = city.parcels[pid];
    if (parcel && parcel.appearsDay === 0) units += parcel.units;
  }
  return units;
}

interface RunRules {
  /** A run may start on this segment. */
  start: (seg: StreetSegment) => boolean;
  /** A run may grow onto this segment. */
  allowed: (seg: StreetSegment) => boolean;
  /** Growth takes the allowed neighbour with the highest preference (ties: lower id). */
  prefer: (seg: StreetSegment) => number;
  /** A finished run of PROBE_MIN_FT..PROBE_MAX_FT is kept when this accepts it. */
  accept: (run: readonly SegmentId[]) => boolean;
}

/**
 * Disjoint connected runs of PROBE_MIN_FT..PROBE_MAX_FT: from each unused
 * start segment (ascending id), repeatedly add the most preferred allowed
 * neighbour that still fits, until the run is long enough.
 */
function growRuns(city: City, rules: RunRules): SegmentId[][] {
  const used = new Set<SegmentId>();
  const runs: SegmentId[][] = [];
  for (const start of city.segments) {
    if (used.has(start.id) || !rules.start(start)) continue;
    const run: SegmentId[] = [start.id];
    const inRun = new Set<SegmentId>(run);
    let ft = start.lengthFt;
    while (ft < PROBE_MIN_FT) {
      let best: StreetSegment | null = null;
      for (const id of run) {
        const seg = city.segments[id] as StreetSegment;
        for (const node of [seg.a, seg.b]) {
          for (const next of segmentsAtNode(city, node)) {
            if (inRun.has(next) || used.has(next)) continue;
            const nseg = city.segments[next] as StreetSegment;
            if (!rules.allowed(nseg) || ft + nseg.lengthFt > PROBE_MAX_FT) continue;
            const better =
              best === null ||
              rules.prefer(nseg) > rules.prefer(best) ||
              (rules.prefer(nseg) === rules.prefer(best) && nseg.id < best.id);
            if (better) best = nseg;
          }
        }
      }
      if (!best) break;
      run.push(best.id);
      inRun.add(best.id);
      ft += best.lengthFt;
    }
    if (ft >= PROBE_MIN_FT && ft <= PROBE_MAX_FT && rules.accept(run)) {
      for (const id of run) used.add(id);
      runs.push(run);
    }
  }
  return runs;
}

function probe(state: GameState, segments: SegmentId[], method: CableMethod): CppProbe | null {
  const quote = quoteCable(state, segments, method);
  if (quote.cpp === null || quote.newSegments.length !== segments.length) return null;
  return { segments, method, lengthFt: quote.lengthFt, cost: quote.cost, passings: quote.passingsAlong, cpp: quote.cpp };
}

/**
 * Cost per passing of typical single orders on a fresh game of `seed` (day
 * 0): dense poled residential/downtown runs quoted aerial and underground, and
 * rural runs quoted aerial when every segment is poled, else underground
 * (runs that pass nobody are skipped). Quotes are made with ample cash (cash
 * never changes a quote's cpp).
 */
export function cppProbes(seed: number): CppProbes {
  const state = newGame(seed);
  state.finance.cash = Number.MAX_SAFE_INTEGER;
  const { city } = state;
  const units = city.segments.map((seg) => day0Units(city, seg.id));
  const unitsOf = (id: SegmentId) => units[id] ?? 0;
  const lengthOf = (run: readonly SegmentId[]) => run.reduce((ft, id) => ft + (city.segments[id] as StreetSegment).lengthFt, 0);
  const townStreet = (seg: StreetSegment) => seg.hasPoles && (seg.zone === 'residential' || seg.zone === 'downtown');

  // (a)/(b) Dense poled residential/downtown: at least one unit per DENSE_FT_PER_UNIT
  // over the whole run (a run may cross a short side street with no lots).
  const dense = growRuns(city, {
    start: (seg) => townStreet(seg) && unitsOf(seg.id) * DENSE_FT_PER_UNIT >= seg.lengthFt,
    allowed: townStreet,
    prefer: (seg) => unitsOf(seg.id) / seg.lengthFt,
    accept: (run) => run.reduce((u, id) => u + unitsOf(id), 0) * DENSE_FT_PER_UNIT >= lengthOf(run),
  });
  // (c) Rural: mostly rural-zone streets; rural lanes are short, so a run may
  // continue onto sparse (under one unit per RURAL_BRIDGE_FT_PER_UNIT) non-downtown streets.
  const isRural = (seg: StreetSegment) => seg.zone === 'rural';
  const rural = growRuns(city, {
    start: isRural,
    allowed: (seg) => isRural(seg) || (seg.zone !== 'downtown' && unitsOf(seg.id) * RURAL_BRIDGE_FT_PER_UNIT <= seg.lengthFt),
    prefer: (seg) => (isRural(seg) ? 1 : 0),
    accept: (run) => {
      const ruralFt = run.reduce((ft, id) => ft + (isRural(city.segments[id] as StreetSegment) ? (city.segments[id] as StreetSegment).lengthFt : 0), 0);
      return ruralFt >= RURAL_MIN_SHARE * lengthOf(run);
    },
  });

  const out: CppProbes = { denseAerial: [], denseUnderground: [], rural: [] };
  for (const run of dense) {
    const aerial = probe(state, run, 'aerial');
    const underground = probe(state, run, 'underground');
    if (aerial) out.denseAerial.push(aerial);
    if (underground) out.denseUnderground.push(underground);
  }
  for (const run of rural) {
    const poled = run.every((id) => (city.segments[id] as StreetSegment).hasPoles);
    const result = probe(state, run, poled ? 'aerial' : 'underground');
    if (result) out.rural.push(result);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Street-graph helpers for bots
// ---------------------------------------------------------------------------

/** Shortest-path tree from `from` over street length, bounded to nodes closer than `limitFt`. */
export interface StreetTree {
  dist: Map<number, number>;
  /** Segment used to reach each node (absent for `from`). */
  via: Map<number, SegmentId>;
}

export function streetTree(city: City, from: number, limitFt: number): StreetTree {
  const dist = new Map<number, number>([[from, 0]]);
  const via = new Map<number, SegmentId>();
  const done = new Set<number>();
  // Small graphs (a few hundred nodes): a linear-scan frontier is plenty.
  const frontier = new Set<number>([from]);
  while (frontier.size > 0) {
    let u = -1;
    let best = Infinity;
    for (const n of frontier) {
      const d = dist.get(n) as number;
      if (d < best || (d === best && n < u)) {
        best = d;
        u = n;
      }
    }
    frontier.delete(u);
    done.add(u);
    for (const segId of segmentsAtNode(city, u)) {
      const seg = city.segments[segId] as StreetSegment;
      const v = otherEnd(seg, u);
      if (done.has(v)) continue;
      const d = best + seg.lengthFt;
      if (d >= limitFt) continue;
      const cur = dist.get(v);
      if (cur === undefined || d < cur) {
        dist.set(v, d);
        via.set(v, segId);
        frontier.add(v);
      }
    }
  }
  return { dist, via };
}

/** Segments on the tree path from the tree's root to `node` (empty for the root or an unreached node). */
export function treePath(city: City, tree: StreetTree, node: number): SegmentId[] {
  const path: SegmentId[] = [];
  let at = node;
  for (let guard = 0; guard < city.nodes.length; guard++) {
    const seg = tree.via.get(at);
    if (seg === undefined) break;
    path.push(seg);
    at = otherEnd(city.segments[seg] as StreetSegment, at);
  }
  return path;
}
