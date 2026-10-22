import { describe, expect, it } from 'vitest';
import { CABINET_COST, CABINET_REACH_FT, CABINET_START_SPLITTERS, SPLIT_RATIO, SPLITTER_COST } from './balance';
import { buildOutPlan, coveragePreview, segmentsWithinReach, smallerBuildPlan } from './coverage';
import { applyCommand, newGame, runDays } from './game';
import { cppBand } from './metrics';
import { getService, orderFees, quoteCable, spanCharges } from './network';
import { parcelsServedBy } from './streets';
import { makeGridCity, makeTestState } from './testing/fixtures';
import { preferredMethod } from './weather';
import type { BuildStage, CableMethod, City, CoveragePreview, GameState, SegmentId, StreetSegment } from './types';

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
    outage: null,
    conversion: null,
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

/** Build-out per the CoveragePreview docs: the cheapest cable per segment plus one order's fees per method used. */
function buildOut(state: GameState, segments: readonly SegmentId[]): number {
  const methods = new Set<CableMethod>();
  let total = 0;
  for (const id of segments) {
    const segment = state.city.segments[id]!;
    const cost = cheapest(segment);
    total += cost;
    methods.add(segment.hasPoles && cost === spanCharges(segment, 'aerial').total ? 'aerial' : 'underground');
  }
  for (const method of methods) total += orderFees(method);
  return total;
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
    const all48 = buildOut(state, all);
    // A cable order's engineering and permit fees are part of the build-out, as a cable quote charges them.
    expect(all48).toBe(state.city.segments.reduce((sum, s) => sum + cheapest(s), 0) + orderFees('aerial'));
    // The same money a cable quote for the whole build-out asks.
    expect(quoteCable(state, all, 'aerial').cost).toBe(all48);
    expect(preview).toMatchObject({
      node: 1,
      reachFt: CABINET_REACH_FT,
      passingsNow: 48,
      passingsFuture: 0,
      passingsServedElsewhere: 0,
      passingsPassableToday: 0,
      cabinetCost: CABINET_PRICE,
      buildOutCost: all48,
      projectedCpp: (CABINET_PRICE + all48) / 48,
      projectedCppBand: cppBand((CABINET_PRICE + all48) / 48),
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
    // A cabinet at node 1 would tie the CO cabinet on the first segment (both 0 ft): the older one keeps it.
    expect(at1.segments.find((s) => s.segment === H(0, 0))).toEqual({ segment: H(0, 0), distanceFt: 0, connected: true, litOnPlacement: false, servedBy: co });
    expect(at1.segments.find((s) => s.segment === H(1, 0))).toEqual({ segment: H(1, 0), distanceFt: 0, connected: true, litOnPlacement: true, servedBy: null });
    expect(at1.passingsServedElsewhere).toBe(30);
    expect(at1.passingsPassableToday).toBe(30);
    const inReach = at1.segments.map((s) => s.segment);
    expect(at1.passingsNow).toBe(units(state, inReach));
    // Only uncabled streets count toward the build-out.
    const uncabled = inReach.filter((s) => s !== H(0, 0) && s !== H(1, 0));
    expect(at1.buildOutCost).toBe(buildOut(state, uncabled));
    expect(at1.projectedCpp).toBe((CABINET_PRICE + at1.buildOutCost) / (at1.passingsNow - 30));
  });

  it('counts as passable today only streets a cabinet here would light along today\'s cable', () => {
    // One row of 360 ft blocks, CO at (0, 1). Live cable runs as a U from the CO:
    // up A Ave to node 0 and out along 1st St to node 1, and along 2nd St to node 7
    // and up C Ave to node 2. 1st St's first block is 360 ft from node 2 along the
    // street, but 960 ft round the U along the cable: a cabinet at node 2 cannot light it.
    const city = makeGridCity({ cols: 4, rows: 1, blockW: 6, blockH: 2, coAt: [0, 1] });
    const state = makeTestState(city);
    for (const s of [8, 0, 4, 5, 10]) addSpan(state, s);
    const preview = coveragePreview(state, 2);
    expect(preview.segments.find((s) => s.segment === 0)).toEqual({ segment: 0, distanceFt: 360, connected: true, litOnPlacement: false, servedBy: null });
    expect(preview.segments.filter((s) => s.litOnPlacement).map((s) => s.segment)).toEqual([4, 5, 10]);

    // What actually happens once a live cabinet stands there.
    const cabinet = addCabinet(state, 2);
    const service = getService(state);
    expect(service.cabinetCoverage.get(cabinet)!.segments).toEqual([4, 5, 10]);
    expect(preview.passingsPassableToday).toBe(service.passings);
    expect(preview.passingsPassableToday).toBe(units(state, [4, 5, 10]));
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
    expect(at1.segments.find((s) => s.segment === H(0, 0))).toEqual({ segment: H(0, 0), distanceFt: 0, connected: false, litOnPlacement: false, servedBy: planned });
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
    const expected = buildOut(state, state.city.segments.map((s) => s.id));
    // Both methods are needed, so both kinds of order pay their fees.
    expect(expected).toBe(state.city.segments.reduce((sum, s) => sum + cheapest(s), 0) + orderFees('aerial') + orderFees('underground'));
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

describe('buildOutPlan (round 4b)', () => {
  it('joins a corner to the CO, cables what it reaches by the preferred method, and prices it as the commands will', () => {
    const state = newGame(3, { city: makeGridCity() });
    const node = 10;
    const plan = buildOutPlan(state, node);
    const preview = coveragePreview(state, node);
    expect(plan.node).toBe(node);
    // Nothing is cabled yet: the feeder runs from the CO and the reach is coveragePreview's build-out.
    expect(plan.feeder.length).toBeGreaterThan(0);
    expect(new Set([...plan.feeder, ...plan.reach]).size).toBe(plan.feeder.length + plan.reach.length);
    for (const id of preview.segments.map((s) => s.segment)) expect([...plan.feeder, ...plan.reach]).toContain(id);
    for (const id of [...plan.aerial, ...plan.underground]) expect([...plan.feeder, ...plan.reach]).toContain(id);
    expect(plan.aerial.length + plan.underground.length).toBe(plan.feeder.length + plan.reach.length);
    for (const id of plan.aerial) expect(preferredMethod(state, state.city.segments[id] as StreetSegment)).toBe('aerial');
    for (const id of plan.underground) expect(preferredMethod(state, state.city.segments[id] as StreetSegment)).toBe('underground');
    expect(plan.commands[0]).toEqual({ type: 'placeCabinet', node });
    const quoted =
      CABINET_PRICE +
      (plan.aerial.length > 0 ? quoteCable(state, plan.aerial, 'aerial').cost : 0) +
      (plan.underground.length > 0 ? quoteCable(state, plan.underground, 'underground').cost : 0);
    expect(plan.cost).toBe(quoted);
    expect(plan.passings).toBe(preview.passingsNow - preview.passingsServedElsewhere);
    expect(plan.cpp).toBe(plan.passings > 0 ? plan.cost / plan.passings : null);

    // Sending the commands spends exactly the cost and lights the corner's streets once built.
    state.finance.cash = plan.cost + 1_000_000;
    const before = state.finance.cash;
    for (const cmd of plan.commands) expect(applyCommand(state, cmd).ok).toBe(true);
    expect(before - state.finance.cash).toBe(plan.cost);
    runDays(state, 400);
    const lit = getService(state).litSegments;
    for (const s of preview.segments) if (s.distanceFt < CABINET_REACH_FT) expect(lit.has(s.segment)).toBe(true);
  });

  it('needs no feeder or cabinet where plant already stands, and is empty for a bad node', () => {
    const state = newGame(3, { city: makeGridCity() });
    const co = state.city.coNode;
    addCabinet(state, co);
    const plan = buildOutPlan(state, co);
    expect(plan.feeder).toEqual([]);
    expect(plan.commands.some((c) => c.type === 'placeCabinet')).toBe(false);
    expect(buildOutPlan(state, -1)).toMatchObject({ feeder: [], reach: [], commands: [], cost: 0, passings: 0, cpp: null });
  });
});

describe('smallerBuildPlan (round 4c/4d, spec B)', () => {
  /** A generated town and the corner whose whole build-out passes the most homes. */
  function town(): { state: GameState; node: number; full: ReturnType<typeof buildOutPlan> } {
    const state = newGame(424242, { difficulty: 'shoestring' });
    let best = { node: -1, full: buildOutPlan(state, -1) };
    for (const n of state.city.nodes) {
      const full = buildOutPlan(state, n.id);
      if (full.reach.length >= 4 && full.passings > best.full.passings) best = { node: n.id, full };
    }
    return { state, ...best };
  }

  it('is the whole build-out when it fits, with the streets it newly lights', () => {
    const { state, node, full } = town();
    const plan = smallerBuildPlan(state, node, full.cost)!;
    expect({ ...plan, lit: undefined }).toEqual({ ...full, lit: undefined });
    const preview = coveragePreview(state, node);
    expect(plan.lit).toEqual(preview.segments.filter((s) => s.servedBy === null).map((s) => s.segment));
  });

  it('fits a smaller budget with the cabinet, its feeder and the densest streets, priced and counted as built', () => {
    const { state, node, full } = town();
    const maxCost = Math.round(full.cost / 2);
    const plan = smallerBuildPlan(state, node, maxCost)!;
    expect(plan).not.toBeNull();
    expect(plan.cost).toBeLessThanOrEqual(maxCost);
    expect(plan.feeder).toEqual(full.feeder);
    for (const id of plan.reach) expect(full.reach).toContain(id);
    expect(plan.reach.length).toBeLessThan(full.reach.length);
    expect(plan.passings).toBeGreaterThan(0);
    expect(plan.cpp).toBe(plan.cost / plan.passings);
    // Each street is built as buildOutPlan builds it.
    for (const id of plan.aerial) expect(full.aerial).toContain(id);
    for (const id of plan.underground) expect(full.underground).toContain(id);
    expect(plan.commands[0]).toEqual({ type: 'placeCabinet', node });
    // Sending it spends exactly its cost, and once built the cabinet lights exactly the streets it said, passing what it said.
    state.finance.cash = plan.cost + 1_000_000;
    const before = state.finance.cash;
    for (const cmd of plan.commands) expect(applyCommand(state, cmd), JSON.stringify(cmd)).toMatchObject({ ok: true });
    expect(before - state.finance.cash).toBe(plan.cost);
    const day = state.day;
    runDays(state, 200);
    const service = getService(state);
    const cabinet = state.network.cabinets.find((c) => c.node === node)!;
    expect(service.cabinetCoverage.get(cabinet.id)!.segments).toEqual(plan.lit);
    let units = 0;
    for (const segment of plan.lit) {
      for (const id of parcelsServedBy(state.city, segment)) {
        const parcel = state.city.parcels[id]!;
        if (parcel.appearsDay <= day) units += parcel.units;
      }
    }
    expect(units).toBe(plan.passings);
  });

  it('is null when not even the cabinet and its feeder fit, or for a bad node', () => {
    const { state, node, full } = town();
    expect(smallerBuildPlan(state, node, CABINET_PRICE - 1)).toBeNull();
    expect(full.cost).toBeGreaterThan(CABINET_PRICE);
    expect(smallerBuildPlan(state, -1, 1_000_000)).toBeNull();
  });
});
