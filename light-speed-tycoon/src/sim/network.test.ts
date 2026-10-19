import { describe, expect, it } from 'vitest';
import {
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_PERMIT_DAYS,
  MAKE_READY_DAYS_MAX,
  MAKE_READY_DAYS_MIN,
  MAKE_READY_LONG_CHANCE,
  MAKE_READY_LONG_DAYS_MAX,
  MAKE_READY_LONG_DAYS_MIN,
  OLT_START_PON_PORTS,
  PERMIT_DAYS_MAX,
  PERMIT_DAYS_MIN,
  SPLITTER_COST,
  START_CASH,
} from './balance';
import { newGame } from './game';
import {
  advanceNetwork,
  cableCost,
  cableRoute,
  computeService,
  getService,
  layCable,
  placeCabinet,
  quoteCabinet,
  quoteCable,
  removeSpan,
  spanOnSegment,
} from './network';
import { Rng } from './rng';
import { shortestPath } from './streets';
import { makeGridCity } from './testing/fixtures';
import type { BuildStage, City, CommandResult, GameState, SegmentId } from './types';

// Default grid: 3x2 blocks of 4x2 cells. Node (i, j) = j * 4 + i.
// Horizontal segment (i, j) = j * 3 + i (240 ft, "1st St".."3rd St");
// vertical (i, j) = 9 + j * 4 + i (120 ft, "A Ave".."D Ave").
const H = (i: number, j: number) => j * 3 + i;
const V = (i: number, j: number) => 9 + j * 4 + i;
const CABINET_PRICE = CABINET_COST + SPLITTER_COST;

function makeState(city: City = makeGridCity()): GameState {
  return {
    schemaVersion: 1,
    seed: 1,
    day: 0,
    rng: { events: 12345 },
    nextId: 1,
    city,
    network: { spans: [], cabinets: [], olt: { ponPorts: OLT_START_PON_PORTS, tech: 'gpon' }, version: 0 },
    finance: { cash: START_CASH, monthToDate: [], reports: [] },
  };
}

function lay(state: GameState, segments: SegmentId[], method: 'aerial' | 'underground', seed = 1): CommandResult {
  return layCable(state, segments, method, new Rng(seed));
}

/** Put a span straight into the network at a given stage (service tests). */
function addSpan(state: GameState, segment: SegmentId, stage: BuildStage = 'live'): void {
  state.network.spans.push({
    id: state.nextId++,
    segment,
    method: 'aerial',
    stage,
    stageDaysLeft: stage === 'live' ? 0 : 3,
    constructDays: 1,
    cost: 0,
    orderedDay: 0,
    liveDay: stage === 'live' ? 0 : null,
  });
  state.network.version++;
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

function tick(state: GameState): void {
  state.day++;
  advanceNetwork(state);
}

function reasonOf(result: CommandResult): string {
  return result.ok ? '' : result.reason;
}

describe('quoteCable', () => {
  it('prices aerial and underground per foot', () => {
    const state = makeState();
    const aerial = quoteCable(state, [H(0, 0), V(0, 0)], 'aerial');
    expect(aerial).toMatchObject({ ok: true, reasons: [], newSegments: [H(0, 0), V(0, 0)], lengthFt: 360, cost: 3_600 });
    const underground = quoteCable(state, [H(0, 0), V(0, 0)], 'underground');
    expect(underground).toMatchObject({ ok: true, lengthFt: 360, cost: 10_800 });
  });

  it('doubles underground on rock but not aerial', () => {
    const state = makeState(makeGridCity({ rock: true }));
    expect(quoteCable(state, [H(0, 0), V(0, 0)], 'underground').cost).toBe(21_600);
    expect(quoteCable(state, [H(0, 0), V(0, 0)], 'aerial').cost).toBe(3_600);
  });

  it('rounds to whole dollars per span', () => {
    const city = makeGridCity();
    city.segments[0] = { ...city.segments[0]!, lengthFt: 33.33 };
    city.segments[1] = { ...city.segments[1]!, lengthFt: 33.33 };
    expect(cableCost(city.segments[0], 'aerial')).toBe(333);
    // 2 x 333, not round(666.6).
    expect(quoteCable(makeState(city), [0, 1], 'aerial').cost).toBe(666);
  });

  it('skips already-cabled segments and duplicate ids', () => {
    const state = makeState();
    expect(lay(state, [H(0, 0)], 'aerial').ok).toBe(true);
    const quote = quoteCable(state, [H(0, 0), H(1, 0), H(1, 0), H(0, 0), H(1, 0)], 'aerial');
    expect(quote).toMatchObject({ ok: true, newSegments: [H(1, 0)], lengthFt: 240, cost: 2_400 });
  });

  it('rejects an order with nothing new to build', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'aerial');
    const quote = quoteCable(state, [H(0, 0), H(0, 0)], 'underground');
    expect(quote.ok).toBe(false);
    expect(quote.reasons).toEqual(['Every selected street already has cable']);
    expect(quote.cost).toBe(0);
  });

  it('rejects an empty order', () => {
    const quote = quoteCable(makeState(), [], 'aerial');
    expect(quote.ok).toBe(false);
    expect(quote.reasons).toEqual(['No street segments selected']);
  });

  it('rejects aerial on streets without poles, naming them', () => {
    const state = makeState(makeGridCity({ hasPoles: false }));
    const quote = quoteCable(state, [H(0, 0), H(1, 0), V(0, 0)], 'aerial');
    expect(quote.ok).toBe(false);
    expect(quote.reasons).toEqual(['No poles on 1st St, A Ave - lay underground instead']);
    expect(quoteCable(state, [H(0, 0), V(0, 0)], 'underground').ok).toBe(true);
  });

  it('only checks poles on new segments', () => {
    const city = makeGridCity();
    city.segments[V(0, 0)] = { ...city.segments[V(0, 0)]!, hasPoles: false };
    const state = makeState(city);
    expect(quoteCable(state, [H(0, 0), V(0, 0)], 'aerial').reasons).toEqual([
      'No poles on A Ave - lay underground instead',
    ]);
    lay(state, [V(0, 0)], 'underground');
    expect(quoteCable(state, [H(0, 0), V(0, 0)], 'aerial').ok).toBe(true);
  });

  it('rejects invalid ids with a reason instead of throwing', () => {
    const state = makeState();
    for (const bad of [-1, 17, 1.5, Number.NaN]) {
      const quote = quoteCable(state, [H(0, 0), bad], 'aerial');
      expect(quote.ok).toBe(false);
      expect(quote.reasons).toEqual([`Unknown street segment: ${bad}`]);
    }
    expect(quoteCable(state, [99, 100], 'aerial').reasons).toEqual(['Unknown street segments: 99, 100']);
    expect(quoteCable(state, [0], 'fiber' as 'aerial').reasons).toEqual(['Unknown cable method: fiber']);
    expect(quoteCable(state, null as unknown as SegmentId[], 'aerial').ok).toBe(false);
  });

  it('flags insufficient cash with both amounts', () => {
    const state = makeState();
    state.finance.cash = 9_000;
    const quote = quoteCable(state, [H(0, 0), H(1, 0)], 'underground');
    expect(quote.ok).toBe(false);
    expect(quote.cost).toBe(14_400);
    expect(quote.reasons).toEqual(['Not enough cash: need $14,400, have $9,000']);
  });

  it('quotes the full permitting range and the longest construction', () => {
    const state = makeState(makeGridCity({ blockW: 20 }));
    // Horizontal segments are 1,200 ft, vertical 120 ft.
    const aerial = quoteCable(state, [H(0, 0), V(0, 0)], 'aerial');
    expect(aerial).toMatchObject({
      permitDaysMin: MAKE_READY_DAYS_MIN,
      permitDaysMax: MAKE_READY_LONG_DAYS_MAX,
      constructDays: 2,
    });
    const underground = quoteCable(state, [V(0, 0), H(0, 0)], 'underground');
    expect(underground).toMatchObject({ permitDaysMin: PERMIT_DAYS_MIN, permitDaysMax: PERMIT_DAYS_MAX, constructDays: 4 });
    expect(quoteCable(state, [V(0, 0)], 'underground').constructDays).toBe(1);
  });

  it('does not change state', () => {
    const state = makeState();
    const before = JSON.stringify(state);
    quoteCable(state, [H(0, 0), V(0, 0)], 'aerial');
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('layCable', () => {
  it('creates permitting spans, charges cash and posts a construction entry', () => {
    const state = makeState(makeGridCity({ blockW: 20 }));
    state.day = 7;
    const result = lay(state, [H(0, 0), V(0, 0)], 'aerial');
    expect(result).toEqual({ ok: true, cost: 13_200 });
    expect(state.finance.cash).toBe(START_CASH - 13_200);
    expect(state.nextId).toBe(3);
    expect(state.network.version).toBe(1);

    const [first, second] = state.network.spans;
    expect(first).toMatchObject({ id: 1, segment: H(0, 0), method: 'aerial', stage: 'permitting', constructDays: 2, cost: 12_000, orderedDay: 7, liveDay: null });
    expect(second).toMatchObject({ id: 2, segment: V(0, 0), constructDays: 1, cost: 1_200 });
    expect(first!.stageDaysLeft).toBe(second!.stageDaysLeft);

    expect(state.finance.monthToDate).toEqual([
      { day: 7, category: 'construction', amount: -13_200, memo: 'Aerial cable on 1st St, A Ave (1,320 ft)' },
    ]);
  });

  it('summarises long street lists in the memo', () => {
    const state = makeState(makeGridCity({ cols: 3, rows: 3 }));
    // Vertical segments start at 4 * 3 = 12 here; A..D Ave plus 1st St.
    lay(state, [0, 12, 13, 14, 15], 'underground');
    expect(state.finance.monthToDate[0]!.memo).toBe('Underground cable on 1st St, A Ave, B Ave and 2 more (720 ft)');
  });

  it('leaves state and rng untouched when rejected', () => {
    const state = makeState();
    state.finance.cash = 100;
    const rng = new Rng(5);
    const before = JSON.stringify(state);
    const result = layCable(state, [H(0, 0)], 'aerial', rng);
    expect(result).toEqual({ ok: false, reason: 'Not enough cash: need $2,400, have $100' });
    expect(JSON.stringify(state)).toBe(before);
    expect(rng.state).toBe(new Rng(5).state);
  });

  it('joins multiple reasons', () => {
    const state = makeState(makeGridCity({ hasPoles: false }));
    state.finance.cash = 0;
    expect(reasonOf(lay(state, [H(0, 0)], 'aerial'))).toBe(
      'No poles on 1st St - lay underground instead; Not enough cash: need $2,400, have $0',
    );
  });

  it('never throws on invalid ids', () => {
    const state = makeState();
    expect(reasonOf(lay(state, [1.5], 'aerial'))).toBe('Unknown street segment: 1.5');
    expect(reasonOf(lay(state, [-3], 'underground'))).toBe('Unknown street segment: -3');
    expect(state.network.spans).toHaveLength(0);
    expect(state.network.version).toBe(0);
  });

  it('draws aerial make-ready from the short or long range', () => {
    const days: number[] = [];
    for (let seed = 0; seed < 1000; seed++) {
      const state = makeState();
      lay(state, [H(0, 0)], 'aerial', seed);
      days.push(state.network.spans[0]!.stageDaysLeft);
    }
    const short = days.filter((d) => d >= MAKE_READY_DAYS_MIN && d <= MAKE_READY_DAYS_MAX);
    const long = days.filter((d) => d >= MAKE_READY_LONG_DAYS_MIN && d <= MAKE_READY_LONG_DAYS_MAX);
    expect(short.length + long.length).toBe(days.length);
    expect(Math.min(...short)).toBe(MAKE_READY_DAYS_MIN);
    expect(Math.max(...short)).toBe(MAKE_READY_DAYS_MAX);
    expect(long.length / days.length).toBeGreaterThan(MAKE_READY_LONG_CHANCE - 0.05);
    expect(long.length / days.length).toBeLessThan(MAKE_READY_LONG_CHANCE + 0.05);
  });

  it('draws underground permits from PERMIT_DAYS', () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 1000; seed++) {
      const state = makeState();
      lay(state, [H(0, 0)], 'underground', seed);
      seen.add(state.network.spans[0]!.stageDaysLeft);
    }
    expect(Math.min(...seen)).toBe(PERMIT_DAYS_MIN);
    expect(Math.max(...seen)).toBe(PERMIT_DAYS_MAX);
    expect(seen.size).toBe(PERMIT_DAYS_MAX - PERMIT_DAYS_MIN + 1);
  });

  it('shares one permitting draw across the whole order', () => {
    for (const method of ['aerial', 'underground'] as const) {
      for (let seed = 0; seed < 50; seed++) {
        const state = makeState();
        const rng = new Rng(seed);
        layCable(state, [H(0, 0), H(1, 0), H(2, 0), V(3, 0)], method, rng);
        const days = new Set(state.network.spans.map((s) => s.stageDaysLeft));
        expect(days.size).toBe(1);

        // The rng advanced by exactly one draw.
        const ref = new Rng(seed);
        if (method === 'aerial') {
          if (ref.chance(MAKE_READY_LONG_CHANCE)) ref.int(MAKE_READY_LONG_DAYS_MIN, MAKE_READY_LONG_DAYS_MAX);
          else ref.int(MAKE_READY_DAYS_MIN, MAKE_READY_DAYS_MAX);
        } else {
          ref.int(PERMIT_DAYS_MIN, PERMIT_DAYS_MAX);
        }
        expect(rng.state).toBe(ref.state);
      }
    }
  });
});

describe('advanceNetwork', () => {
  it('moves a span through permitting, constructing and live on exact days', () => {
    const state = makeState(makeGridCity({ blockW: 20 }));
    lay(state, [H(0, 0)], 'aerial');
    const span = state.network.spans[0]!;
    const permitDays = span.stageDaysLeft;
    let version = state.network.version;

    for (let d = 1; d < permitDays; d++) {
      tick(state);
      expect(span).toMatchObject({ stage: 'permitting', stageDaysLeft: permitDays - d });
      expect(state.network.version).toBe(version);
    }
    tick(state);
    expect(span).toMatchObject({ stage: 'constructing', stageDaysLeft: 2, liveDay: null });
    expect(state.network.version).toBe(++version);

    tick(state);
    expect(span).toMatchObject({ stage: 'constructing', stageDaysLeft: 1 });
    expect(state.network.version).toBe(version);

    tick(state);
    expect(span).toMatchObject({ stage: 'live', stageDaysLeft: 0, liveDay: permitDays + 2 });
    expect(state.network.version).toBe(++version);

    for (let d = 0; d < 5; d++) tick(state);
    expect(span).toMatchObject({ stage: 'live', stageDaysLeft: 0, liveDay: permitDays + 2 });
    expect(state.network.version).toBe(version);
  });

  it('builds a cabinet in permit + construct days', () => {
    const state = makeState();
    state.day = 3;
    placeCabinet(state, 0);
    const cabinet = state.network.cabinets[0]!;
    // The cabinet is the only thing in the network, so every version bump below is
    // its own: the renderer redraws cabinets only when the version changes.
    let version = state.network.version;
    for (let d = 1; d < CABINET_PERMIT_DAYS; d++) {
      tick(state);
      expect(state.network.version).toBe(version);
    }
    expect(cabinet.stage).toBe('permitting');
    tick(state);
    expect(cabinet).toMatchObject({ stage: 'constructing', stageDaysLeft: CABINET_CONSTRUCT_DAYS });
    expect(state.network.version).toBe(++version);
    for (let d = 1; d < CABINET_CONSTRUCT_DAYS; d++) {
      tick(state);
      expect(state.network.version).toBe(version);
    }
    expect(cabinet.stage).toBe('constructing');
    tick(state);
    expect(cabinet).toMatchObject({ stage: 'live', liveDay: 3 + CABINET_PERMIT_DAYS + CABINET_CONSTRUCT_DAYS });
    expect(state.network.version).toBe(++version);
    for (let d = 0; d < 5; d++) tick(state);
    expect(state.network.version).toBe(version);
  });

  it('bumps the version once per day however many stages change', () => {
    const state = makeState();
    lay(state, [H(0, 0), H(1, 0)], 'aerial');
    placeCabinet(state, 0);
    const version = state.network.version;
    state.network.spans.forEach((s) => (s.stageDaysLeft = 1));
    state.network.cabinets[0]!.stageDaysLeft = 1;
    tick(state);
    expect(state.network.version).toBe(version + 1);
  });
});

describe('cabinets', () => {
  it('quotes cost and build times', () => {
    expect(quoteCabinet(makeState(), 5)).toEqual({
      ok: true,
      reasons: [],
      cost: CABINET_PRICE,
      permitDays: CABINET_PERMIT_DAYS,
      constructDays: CABINET_CONSTRUCT_DAYS,
    });
  });

  it('places a cabinet, charges equipment and bumps the version', () => {
    const state = makeState();
    state.nextId = 40;
    expect(placeCabinet(state, 5)).toEqual({ ok: true, cost: CABINET_PRICE });
    expect(state.network.cabinets).toEqual([
      { id: 40, node: 5, splitters: 1, stage: 'permitting', stageDaysLeft: CABINET_PERMIT_DAYS, cost: CABINET_PRICE, orderedDay: 0, liveDay: null },
    ]);
    expect(state.nextId).toBe(41);
    expect(state.network.version).toBe(1);
    expect(state.finance.cash).toBe(START_CASH - CABINET_PRICE);
    expect(state.finance.monthToDate).toEqual([
      { day: 0, category: 'equipment', amount: -CABINET_PRICE, memo: 'Cabinet at 2nd St & B Ave (1 splitter)' },
    ]);
  });

  it('rejects bad nodes', () => {
    const state = makeState();
    for (const bad of [-1, 12, 2.5, Number.NaN]) {
      expect(reasonOf(placeCabinet(state, bad))).toBe(`Unknown street corner: ${bad}`);
    }
    expect(state.network.cabinets).toHaveLength(0);
  });

  it('allows one cabinet per node', () => {
    const state = makeState();
    expect(placeCabinet(state, 0).ok).toBe(true);
    expect(reasonOf(placeCabinet(state, 0))).toBe('There is already a cabinet at 1st St & A Ave');
    expect(placeCabinet(state, 1).ok).toBe(true);
  });

  it('caps total splitters at the OLT port count', () => {
    const state = makeState();
    state.network.olt.ponPorts = 2;
    expect(placeCabinet(state, 0).ok).toBe(true);
    expect(placeCabinet(state, 1).ok).toBe(true);
    expect(reasonOf(placeCabinet(state, 2))).toBe('No free PON ports on the OLT: 2 of 2 in use');
    expect(state.network.cabinets).toHaveLength(2);
  });

  it('rejects when cash is short', () => {
    const state = makeState();
    state.finance.cash = 16_199;
    expect(reasonOf(placeCabinet(state, 0))).toBe('Not enough cash: need $16,200, have $16,199');
    state.finance.cash = 16_200;
    expect(placeCabinet(state, 0).ok).toBe(true);
    expect(state.finance.cash).toBe(0);
  });
});

describe('removeSpan', () => {
  it('refunds a span still in permitting', () => {
    const state = makeState();
    lay(state, [H(0, 0), H(1, 0)], 'underground');
    const version = state.network.version;
    const result = removeSpan(state, 1);
    expect(result).toEqual({ ok: true, cost: -7_200 });
    expect(state.finance.cash).toBe(START_CASH - 7_200);
    expect(state.network.spans.map((s) => s.id)).toEqual([2]);
    expect(state.network.version).toBe(version + 1);
    expect(state.finance.monthToDate.at(-1)).toEqual({
      day: 0,
      category: 'refund',
      amount: 7_200,
      memo: 'Refund: cancelled underground cable on 1st St (240 ft)',
    });
  });

  it('removes a span under construction or live without a refund', () => {
    for (const stage of ['constructing', 'live'] as const) {
      const state = makeState();
      lay(state, [H(0, 0)], 'aerial');
      state.network.spans[0]!.stage = stage;
      const cash = state.finance.cash;
      expect(removeSpan(state, 1)).toEqual({ ok: true, cost: 0 });
      expect(state.finance.cash).toBe(cash);
      expect(state.network.spans).toHaveLength(0);
      expect(state.network.version).toBe(2);
      expect(state.finance.monthToDate.at(-1)).toMatchObject({ category: 'refund', amount: 0 });
      expect(state.finance.monthToDate.at(-1)!.memo).toContain('no refund');
    }
  });

  it('rejects unknown spans', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'aerial');
    for (const bad of [0, 2, 1.5, -1]) expect(reasonOf(removeSpan(state, bad))).toBe(`Unknown cable span: ${bad}`);
    expect(state.network.spans).toHaveLength(1);
    expect(state.network.version).toBe(1);
  });

  it('lets the segment be cabled again', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'aerial');
    removeSpan(state, 1);
    expect(quoteCable(state, [H(0, 0)], 'underground').newSegments).toEqual([H(0, 0)]);
  });
});

describe('computeService', () => {
  it('lights nothing without an active cabinet', () => {
    const state = makeState();
    addSpan(state, H(0, 0));
    addSpan(state, H(1, 0));
    const service = computeService(state);
    expect(service.litSegments.size).toBe(0);
    expect(service.activeCabinets.size).toBe(0);
    expect(service.passedParcels).toEqual([]);
    expect(service.passings).toBe(0);

    addCabinet(state, 1, 'constructing');
    expect(computeService(state).litSegments.size).toBe(0);
  });

  it('lights CO-connected live cable once a cabinet on it is live', () => {
    const state = makeState();
    addSpan(state, H(0, 0));
    addSpan(state, H(1, 0));
    const cabinet = addCabinet(state, 2);
    const service = computeService(state);
    expect([...service.activeCabinets]).toEqual([cabinet]);
    expect([...service.litSegments].sort((a, b) => a - b)).toEqual([H(0, 0), H(1, 0)]);
    // 1st St lots: block row 0 top rows, four per segment.
    expect(service.passedParcels).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(service.passings).toBe(8);
    expect(service.networkVersion).toBe(state.network.version);
    expect(service.day).toBe(0);
  });

  it('counts a cabinet standing at the CO node', () => {
    const state = makeState();
    const cabinet = addCabinet(state, state.city.coNode);
    expect([...computeService(state).activeCabinets]).toEqual([cabinet]);
    addSpan(state, V(0, 0));
    expect([...computeService(state).litSegments]).toEqual([V(0, 0)]);
  });

  it('ignores cabinets off the CO-connected network', () => {
    const state = makeState();
    addSpan(state, H(0, 0));
    addCabinet(state, 5);
    expect(computeService(state).activeCabinets.size).toBe(0);
    expect(computeService(state).litSegments.size).toBe(0);
  });

  it('does not light islands cut off from the CO', () => {
    const state = makeState();
    addSpan(state, H(0, 0));
    addCabinet(state, 1);
    addSpan(state, H(2, 2));
    addSpan(state, V(3, 1));
    const lit = computeService(state).litSegments;
    expect([...lit]).toEqual([H(0, 0)]);
  });

  it('does not route through spans that are not live', () => {
    const state = makeState();
    addSpan(state, H(0, 0));
    addSpan(state, H(1, 0), 'constructing');
    addSpan(state, H(2, 0));
    addCabinet(state, 0);
    addCabinet(state, 3);
    const service = computeService(state);
    expect([...service.litSegments]).toEqual([H(0, 0)]);
    expect(service.activeCabinets.size).toBe(1);
  });

  it('excludes parcels that have not appeared yet and sums units', () => {
    const city = makeGridCity();
    city.parcels[0] = { ...city.parcels[0]!, appearsDay: 10 };
    city.parcels[2] = { ...city.parcels[2]!, kind: 'mdu', units: 24 };
    const state = makeState(city);
    addSpan(state, H(0, 0));
    addCabinet(state, 0);
    expect(computeService(state)).toMatchObject({ passedParcels: [2, 4, 6], passings: 26 });
    state.day = 10;
    expect(computeService(state)).toMatchObject({ passedParcels: [0, 2, 4, 6], passings: 27 });
  });

  it('counts lots on both sides of a street', () => {
    const state = makeState();
    addSpan(state, V(0, 0));
    addSpan(state, H(0, 1));
    addCabinet(state, 0);
    expect(computeService(state).passings).toBe(8);
  });
});

describe('getService', () => {
  it('memoizes on network version and day', () => {
    const state = makeState();
    addSpan(state, H(0, 0));
    addCabinet(state, 0);
    const first = getService(state);
    expect(getService(state)).toBe(first);

    lay(state, [H(1, 0)], 'aerial');
    const second = getService(state);
    expect(second).not.toBe(first);
    expect(second.networkVersion).toBe(state.network.version);
    expect(getService(state)).toBe(second);

    state.day++;
    const third = getService(state);
    expect(third).not.toBe(second);
    expect(third.day).toBe(1);
  });

  it('keeps separate caches per state', () => {
    const a = makeState();
    const b = makeState();
    addSpan(b, H(0, 0));
    addCabinet(b, 0);
    expect(getService(a).passings).toBe(0);
    expect(getService(b).passings).toBe(4);
    expect(getService(a).passings).toBe(0);
  });
});

describe('spanOnSegment', () => {
  it('finds the span on a segment', () => {
    const state = makeState();
    lay(state, [H(0, 0), V(0, 0)], 'aerial');
    expect(spanOnSegment(state, V(0, 0))?.id).toBe(2);
    expect(spanOnSegment(state, H(1, 0))).toBeUndefined();
  });
});

describe('cableRoute', () => {
  // 0 -> 5 is 360 ft either way: [V(0,0), H(0,1)] by the shortest-path tie-break, or [H(0,0), V(1,0)].
  function unpoled(...ids: SegmentId[]): City {
    const city = makeGridCity();
    for (const id of ids) city.segments[id] = { ...city.segments[id]!, hasPoles: false };
    return city;
  }

  it('routes aerial runs along poles when an equally short route has them', () => {
    const state = makeState(unpoled(H(0, 1)));
    expect(shortestPath(state.city, 0, 5)).toEqual([V(0, 0), H(0, 1)]);
    const route = cableRoute(state, 0, 5, 'aerial');
    expect(route).toEqual([H(0, 0), V(1, 0)]);
    expect(quoteCable(state, route!, 'aerial')).toMatchObject({ ok: true, lengthFt: 360 });
  });

  it('takes a longer poled detour over a shorter street without poles', () => {
    const state = makeState(unpoled(H(0, 0)));
    expect(cableRoute(state, 0, 1, 'aerial')).toEqual([V(0, 0), H(0, 1), V(1, 0)]);
  });

  it('crosses a street without poles that already has cable, since the order skips it', () => {
    const state = makeState(unpoled(H(0, 0)));
    expect(lay(state, [H(0, 0)], 'underground').ok).toBe(true);
    const route = cableRoute(state, 0, 2, 'aerial');
    expect(route).toEqual([H(0, 0), H(1, 0)]);
    expect(quoteCable(state, route!, 'aerial')).toMatchObject({ ok: true, newSegments: [H(1, 0)] });
  });

  it('falls back to the plain shortest route, whose quote names the blocking street', () => {
    // Node 0 has no poled street at all.
    const state = makeState(unpoled(H(0, 0), V(0, 0)));
    const route = cableRoute(state, 0, 5, 'aerial');
    expect(route).toEqual(shortestPath(state.city, 0, 5));
    expect(quoteCable(state, route!, 'aerial').reasons).toEqual(['No poles on A Ave - lay underground instead']);
  });

  it('routes underground runs along the plain shortest route', () => {
    const state = makeState(unpoled(H(0, 1)));
    expect(cableRoute(state, 0, 5, 'underground')).toEqual([V(0, 0), H(0, 1)]);
    expect(cableRoute(state, 0, 0, 'underground')).toEqual([]);
    expect(cableRoute(state, 0, 99, 'aerial')).toBeNull();
  });

  it('finds the poled route on a generated town', () => {
    // Seed 1: the plain shortest 68 -> 97 route crosses Water St, which has no
    // poles; an all-poled route of the same 1,500 ft exists.
    const state = newGame(1);
    const plain = shortestPath(state.city, 68, 97)!;
    expect(quoteCable(state, plain, 'aerial').reasons).toEqual(['No poles on Water St - lay underground instead']);
    const route = cableRoute(state, 68, 97, 'aerial')!;
    expect(quoteCable(state, route, 'aerial')).toMatchObject({ ok: true, reasons: [], lengthFt: 1_500 });
  });
});
