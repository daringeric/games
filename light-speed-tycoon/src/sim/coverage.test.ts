import { describe, expect, it } from 'vitest';
import { CABINET_COST, CABINET_REACH_FT, CABINET_START_SPLITTERS, SPLIT_RATIO, SPLITTER_COST } from './balance';
import { coveragePreview, segmentsWithinReach } from './coverage';
import { newGame } from './game';
import { cppBand } from './metrics';
import { getService, spanCharges } from './network';
import { parcelsServedBy } from './streets';
import { makeGridCity, makeTestState } from './testing/fixtures';
import type { BuildStage, City, CoveragePreview, GameState, SegmentId, StreetSegment } from './types';

// Default grid: 3x2 blocks of 4x2 cells. Node (i, j) = j * 4 + i.
// Horizontal segment (i, j) = j * 3 + i (240 ft); vertical (i, j) = 9 + j * 4 + i (120 ft).
const H = (i: number, j: number) => j * 3 + i;
const V = (i: number, j: number) => 9 + j * 4 + i;
const CABINET_PRICE = CABINET_COST + CABINET_START_SPLITTERS * SPLITTER_COST;
const PORTS = CABINET_START_SPLITTERS * SPLIT_RATIO;

function addSpan(state: GameState, segment: SegmentId, stage: BuildStage = 'live'): number {
  const id = state.nextId++;
  state.network.spans.push({
    id,
    segment,
    method: 'underground',
    stage,
    stageDaysLeft: stage === 'live' ? 0 : 3,
    constructDays: 1,
    cost: 0,
    refundable: 0,
    orderedDay: 0,
    liveDay: stage === 'live' ? 0 : null,
  });
  state.network.version++;
  return id;
}

function addCabinet(state: GameState, node: number, stage: BuildStage = 'live'): number {
  const id = state.nextId++;
  state.network.cabinets.push({
    id,
    node,
    splitters: 1,
    stage,
    stageDaysLeft: stage === 'live' ? 0 : 3,
    cost: 0,
    orderedDay: 0,
    liveDay: stage === 'live' ? 0 : null,
  });
  state.network.version++;
  return id;
}

/** Cheapest buildable cable per the CoveragePreview docs: aerial where poled, else underground. */
function cheapest(segment: StreetSegment): number {
  const underground = spanCharges(segment, 'underground').total;
  return segment.hasPoles ? Math.min(underground, spanCharges(segment, 'aerial').total) : underground;
}

function units(state: GameState, segments: readonly SegmentId[]): number {
  let total = 0;
  for (const s of segments) {
    for (const pid of parcelsServedBy(state.city, s)) {
      const p = state.city.parcels[pid]!;
      if (p.appearsDay <= state.day) total += p.units;
    }
  }
  return total;
}

describe('segmentsWithinReach', () => {
  const city = makeGridCity();

  it('lists segments whose nearer endpoint is strictly within reach along streets', () => {
    expect(segmentsWithinReach(city, 0, 300)).toEqual([
      { segment: H(0, 0), distanceFt: 0 },
      { segment: H(1, 0), distanceFt: 240 },
      { segment: H(0, 1), distanceFt: 120 },
      { segment: H(0, 2), distanceFt: 240 },
      { segment: V(0, 0), distanceFt: 0 },
      { segment: V(1, 0), distanceFt: 240 },
      { segment: V(0, 1), distanceFt: 120 },
    ]);
    expect(segmentsWithinReach(city, 0, 240).map((r) => r.segment)).toEqual([H(0, 0), H(0, 1), V(0, 0), V(0, 1)]);
  });

  it('follows only allowed segments', () => {
    const avenues = (s: StreetSegment) => s.id >= 9;
    expect(segmentsWithinReach(city, 0, 1_000, avenues)).toEqual([
      { segment: V(0, 0), distanceFt: 0 },
      { segment: V(0, 1), distanceFt: 120 },
    ]);
  });

  it('returns [] for an invalid node', () => {
    expect(segmentsWithinReach(city, 99, 1_000)).toEqual([]);
    expect(segmentsWithinReach(city, Number.NaN, 1_000)).toEqual([]);
  });
});

describe('coveragePreview', () => {
  it('counts everything in street reach on an empty network', () => {
    const state = makeTestState();
    // Every segment's nearer end is at most 600 ft from corner (1, 0), so the
    // whole default grid is in reach of a cabinet there.
    expect(CABINET_REACH_FT).toBeGreaterThan(600);
    const preview = coveragePreview(state, 1);
    const all = state.city.segments.map((s) => s.id);
    expect(preview.segments.map((s) => s.segment)).toEqual(all);
    expect(preview.segments.every((s) => !s.connected && s.servedBy === null)).toBe(true);
    expect(preview.segments.find((s) => s.segment === H(2, 2))!.distanceFt).toBe(240 + 240);
    expect(preview.segments.find((s) => s.segment === V(3, 1))!.distanceFt).toBe(480 + 120);
    const buildOut = state.city.segments.reduce((sum, s) => sum + cheapest(s), 0);
    expect(preview).toMatchObject({
      node: 1,
      reachFt: CABINET_REACH_FT,
      passingsNow: 48,
      passingsFuture: 0,
      passingsServedElsewhere: 0,
      passingsPassableToday: 0,
      cabinetCost: CABINET_PRICE,
      buildOutCost: buildOut,
      projectedCpp: (CABINET_PRICE + buildOut) / 48,
      projectedCppBand: cppBand((CABINET_PRICE + buildOut) / 48),
      ports: PORTS,
    });
  });

  it('keeps to the reach on a big town and counts future parcels apart', () => {
    const city = makeGridCity({ blockW: 30 });
    // Two of 2nd block's 1st St lots are built later.
    const late = city.parcels.filter((p) => p.segment === H(1, 0)).slice(0, 2);
    for (const p of late) city.parcels[p.id] = { ...p, appearsDay: 40 };
    const state = makeTestState(city);
    const preview = coveragePreview(state, 2);
    // Node 2 sits between 1st St's 2nd and 3rd 1,800 ft segments; node 1 and 3 are too far.
    expect(preview.segments.map((s) => [s.segment, s.distanceFt])).toEqual([
      [H(1, 0), 0],
      [H(2, 0), 0],
      [H(1, 1), 120],
      [H(2, 1), 120],
      [H(1, 2), 240],
      [H(2, 2), 240],
      [V(2, 0), 0],
      [V(2, 1), 120],
    ]);
    expect(preview.passingsNow).toBe(2 * (30 + 60 + 30) - 2);
    expect(preview.passingsFuture).toBe(2);
    state.day = 40;
    const later = coveragePreview(state, 2);
    expect(later).toMatchObject({ passingsNow: 240, passingsFuture: 0 });
  });

  it('splits homes already served elsewhere from homes passable today', () => {
    // 1,800 ft blocks: the CO cabinet lights only the first 1st St segment;
    // the second is connected but beyond its reach.
    const state = makeTestState(makeGridCity({ blockW: 30 }));
    addSpan(state, H(0, 0));
    addSpan(state, H(1, 0));
    const co = addCabinet(state, 0);

    const at1 = coveragePreview(state, 1);
    expect(at1.segments.find((s) => s.segment === H(0, 0))).toEqual({ segment: H(0, 0), distanceFt: 0, connected: true, servedBy: co });
    expect(at1.segments.find((s) => s.segment === H(1, 0))).toEqual({ segment: H(1, 0), distanceFt: 0, connected: true, servedBy: null });
    expect(at1.passingsServedElsewhere).toBe(30);
    expect(at1.passingsPassableToday).toBe(30);
    const inReach = at1.segments.map((s) => s.segment);
    expect(at1.passingsNow).toBe(units(state, inReach));
    // Only uncabled streets count toward the build-out.
    const uncabled = inReach.filter((s) => s !== H(0, 0) && s !== H(1, 0));
    expect(at1.buildOutCost).toBe(uncabled.reduce((sum, s) => sum + cheapest(state.city.segments[s]!), 0));
    expect(at1.projectedCpp).toBe((CABINET_PRICE + at1.buildOutCost) / (at1.passingsNow - 30));
  });

  it('counts streets a cabinet still being built will serve as served elsewhere', () => {
    // 1,800 ft blocks: cable ordered along 1st St, a cabinet permitting at the CO.
    const state = makeTestState(makeGridCity({ blockW: 30 }));
    addSpan(state, H(0, 0), 'permitting');
    addSpan(state, H(1, 0), 'constructing');
    const planned = addCabinet(state, 0, 'permitting');
    expect(getService(state).litSegments.size).toBe(0);
    const at1 = coveragePreview(state, 1);
    // Once built, the CO cabinet serves 1st St's first segment; the second is beyond its reach.
    expect(at1.segments.find((s) => s.segment === H(0, 0))).toEqual({ segment: H(0, 0), distanceFt: 0, connected: false, servedBy: planned });
    expect(at1.segments.find((s) => s.segment === H(1, 0))).toMatchObject({ connected: false, servedBy: null });
    expect(at1.passingsServedElsewhere).toBe(30);
    expect(at1.passingsPassableToday).toBe(0);
    expect(at1.projectedCpp).toBe((CABINET_PRICE + at1.buildOutCost) / (at1.passingsNow - 30));
  });

  it('never counts a cabinet at the preview node as serving elsewhere', () => {
    const state = makeTestState();
    addSpan(state, H(0, 0));
    const co = addCabinet(state, 0);
    const here = coveragePreview(state, 0);
    expect(here.segments.find((s) => s.segment === H(0, 0))).toMatchObject({ connected: true, servedBy: null });
    expect(here).toMatchObject({ cabinetCost: 0, passingsServedElsewhere: 0, passingsPassableToday: 4 });
    const next = coveragePreview(state, 1);
    expect(next.segments.find((s) => s.segment === H(0, 0))).toMatchObject({ connected: true, servedBy: co });
    expect(next).toMatchObject({ cabinetCost: CABINET_PRICE, passingsServedElsewhere: 4, passingsPassableToday: 0 });
  });

  it('prices the build-out with the cheaper buildable method per segment', () => {
    const city = makeGridCity({ rock: true });
    // Rock makes underground dear, so poled streets go aerial; unpoled ones must bore.
    for (const id of [H(0, 0), V(0, 0)]) city.segments[id] = { ...city.segments[id]!, hasPoles: false };
    const state = makeTestState(city);
    // From corner (1, 0) the whole grid is in reach (see above).
    const preview = coveragePreview(state, 1);
    const expected = state.city.segments.reduce((sum, s) => sum + cheapest(s), 0);
    expect(preview.buildOutCost).toBe(expected);
    // The unpoled street can only be bored.
    const bored = spanCharges(state.city.segments[H(0, 0)]!, 'underground').total;
    expect(cheapest(state.city.segments[H(0, 0)]!)).toBe(bored);
    // A span in any stage takes its segment out of the build-out.
    addSpan(state, H(0, 0), 'permitting');
    expect(coveragePreview(state, 1).buildOutCost).toBe(expected - bored);
  });

  it('gives no projected CPP when nothing new would be covered', () => {
    const city: City = { ...makeGridCity(), parcels: [] };
    expect(coveragePreview(makeTestState(city), 0)).toMatchObject({ passingsNow: 0, projectedCpp: null, projectedCppBand: null });

    // Every home in reach already served by the CO cabinet.
    const state = makeTestState();
    for (const s of state.city.segments) addSpan(state, s.id);
    addCabinet(state, 0);
    expect(getService(state).passings).toBe(48);
    const preview = coveragePreview(state, 11);
    expect(preview).toMatchObject({ passingsNow: 48, passingsServedElsewhere: 48, buildOutCost: 0, projectedCpp: null, projectedCppBand: null });
  });

  it('returns an empty preview for an invalid node', () => {
    const state = makeTestState();
    const empty: CoveragePreview = {
      node: 99,
      reachFt: CABINET_REACH_FT,
      segments: [],
      passingsNow: 0,
      passingsFuture: 0,
      passingsServedElsewhere: 0,
      passingsPassableToday: 0,
      cabinetCost: 0,
      buildOutCost: 0,
      projectedCpp: null,
      projectedCppBand: null,
      ports: 0,
    };
    expect(coveragePreview(state, 99)).toEqual(empty);
    expect(coveragePreview(state, -1)).toEqual({ ...empty, node: -1 });
    expect(coveragePreview(state, 1.5)).toEqual({ ...empty, node: 1.5 });
  });

  it('memoizes per node, network version and day, and never changes state', () => {
    const state = makeTestState();
    const before = JSON.stringify(state);
    const first = coveragePreview(state, 5);
    expect(coveragePreview(state, 5)).toBe(first);
    expect(JSON.stringify(state)).toBe(before);
    const other = coveragePreview(state, 6);
    expect(other).not.toBe(first);
    expect(coveragePreview(state, 5)).toEqual(first);
    addSpan(state, H(0, 0));
    const afterOrder = coveragePreview(state, 5);
    expect(afterOrder).not.toBe(first);
    expect(afterOrder.buildOutCost).toBeLessThan(first.buildOutCost);
    state.day++;
    expect(coveragePreview(state, 5)).not.toBe(afterOrder);
  });

  it('is fast enough to run on every hover on a generated town', () => {
    const state = newGame(1);
    const { city } = state;
    // Some plant so the service lookups have something to find.
    for (const s of city.segments.slice(0, 120)) addSpan(state, s.id);
    addCabinet(state, city.coNode);
    getService(state);
    coveragePreview(state, 0); // warm the per-City indexes
    const start = performance.now();
    for (const node of city.nodes) {
      const preview = coveragePreview(state, node.id);
      expect(preview.segments.every((s) => s.distanceFt < CABINET_REACH_FT)).toBe(true);
    }
    const perHover = (performance.now() - start) / city.nodes.length;
    // Typically well under 0.1 ms; the bound leaves room for slow CI machines.
    expect(perHover).toBeLessThan(2);
  });
});
