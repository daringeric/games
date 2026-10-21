import { describe, expect, it } from 'vitest';
import {
  AERIAL_COST_PER_FT,
  AERIAL_DETOUR_MAX_RATIO,
  CABINET_CANCEL_REFUND,
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_PERMIT_DAYS,
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  ENGINEERING_FEE,
  MAKE_READY_COST_PER_POLE,
  MAKE_READY_DAYS_MAX,
  MAKE_READY_DAYS_MIN,
  MAKE_READY_LONG_CHANCE,
  MAKE_READY_LONG_DAYS_MAX,
  MAKE_READY_LONG_DAYS_MIN,
  MAKE_READY_MEMORY_DAYS,
  MAX_SPLITTERS_PER_CABINET,
  OLT_CARD_COST,
  OLT_MAX_CARDS,
  OLT_PORTS_PER_CARD,
  PERMIT_DAYS_MAX,
  PERMIT_DAYS_MIN,
  PERMIT_FEE_AERIAL,
  PERMIT_FEE_UNDERGROUND,
  PERMITTING_CANCEL_REFUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  SPLIT_RATIO,
  SPLITTER_COST,
  START_CASH,
  TILE_FT,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_FT_PER_DAY,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
} from './balance';
import { formatMoney, monthlyPoleRent } from './finance';
import { applyCommand, newGame } from './game';
import { cppBand } from './metrics';
import {
  addOltCard,
  addSplitter,
  advanceNetwork,
  cableCost,
  cableRoute,
  computeService,
  convertSpan,
  getService,
  outageImpact,
  layCable,
  orderFees,
  placeCabinet,
  ponPortsUsed,
  quoteCabinet,
  quoteCable,
  cableStormRisk,
  quoteConvert,
  quoteOltCard,
  quoteRemoveCabinet,
  quoteRemoveSpan,
  quoteSplitter,
  rememberedPermitDays,
  removeCabinet,
  removeSpan,
  segmentCostPerFt,
  spanCharges,
  spanOnSegment,
} from './network';
import { Rng } from './rng';
import { polesOnSegment, shortestPath } from './streets';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { BuildStage, CableMethod, City, CommandResult, GameState, SegmentId, StreetSegment } from './types';
import { exposureBand, segmentExposure, stormRisk } from './weather';

// Default grid: 3x2 blocks of 4x2 cells. Node (i, j) = j * 4 + i.
// Horizontal segment (i, j) = j * 3 + i (240 ft, "1st St".."3rd St");
// vertical (i, j) = 9 + j * 4 + i (120 ft, "A Ave".."D Ave").
// Lots: ids 0, 2, 4, 6 front H(0, 0); 1, 3, 5, 7 front H(0, 1) from above, 24, 26, 28, 30 from below.
const H = (i: number, j: number) => j * 3 + i;
const V = (i: number, j: number) => 9 + j * 4 + i;
const CABINET_PRICE = CABINET_COST + CABINET_START_SPLITTERS * SPLITTER_COST;

function makeState(city: City = makeGridCity()): GameState {
  return makeTestState(city);
}

function lay(state: GameState, segments: SegmentId[], method: CableMethod, seed = 1): CommandResult {
  return layCable(state, segments, method, new Rng(seed));
}

function seg(state: GameState, id: SegmentId): StreetSegment {
  return state.city.segments[id]!;
}

function charges(state: GameState, id: SegmentId, method: CableMethod) {
  return spanCharges(seg(state, id), method);
}

/** What an order of these (all new) segments costs: per-span charges plus the per-order fees once. */
function orderCost(state: GameState, ids: SegmentId[], method: CableMethod): number {
  return ids.reduce((sum, id) => sum + charges(state, id, method).total, 0) + orderFees(method);
}

/** The permitting draw layCable makes, replayed on a reference Rng. */
function refDraw(rng: Rng, method: CableMethod): number {
  if (method === 'underground') return rng.int(PERMIT_DAYS_MIN, PERMIT_DAYS_MAX);
  return rng.chance(MAKE_READY_LONG_CHANCE)
    ? rng.int(MAKE_READY_LONG_DAYS_MIN, MAKE_READY_LONG_DAYS_MAX)
    : rng.int(MAKE_READY_DAYS_MIN, MAKE_READY_DAYS_MAX);
}

/** Put a span straight into the network at a given stage (service tests). */
function addSpan(state: GameState, segment: SegmentId, stage: BuildStage = 'live'): number {
  const id = state.nextId++;
  state.network.spans.push({
    id,
    segment,
    method: 'aerial',
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

function tick(state: GameState): void {
  state.day++;
  advanceNetwork(state);
}

function reasonOf(result: CommandResult): string {
  return result.ok ? '' : result.reason;
}

function sorted(ids: Iterable<number>): number[] {
  return [...ids].sort((a, b) => a - b);
}

/** A rejected command must leave every part of the game exactly as it was. */
function expectRejected(state: GameState, run: (s: GameState) => CommandResult, reason: string | RegExp): void {
  const before = structuredClone(state);
  const result = run(state);
  expect(result.ok).toBe(false);
  if (typeof reason === 'string') expect(reasonOf(result)).toBe(reason);
  else expect(reasonOf(result)).toMatch(reason);
  expect(state).toEqual(before);
}

describe('spanCharges and segmentCostPerFt', () => {
  it('prices aerial strand plus make-ready per pole', () => {
    const state = makeState();
    const segment = seg(state, H(0, 0));
    const poles = polesOnSegment(segment);
    expect(poles).toBeGreaterThan(0);
    const construction = Math.round(segment.lengthFt * AERIAL_COST_PER_FT);
    expect(spanCharges(segment, 'aerial')).toEqual({
      construction,
      rock: 0,
      poles,
      makeReady: poles * MAKE_READY_COST_PER_POLE,
      total: construction + poles * MAKE_READY_COST_PER_POLE,
      refundable: construction,
    });
    expect(cableCost(segment, 'aerial')).toBe(construction + poles * MAKE_READY_COST_PER_POLE);
  });

  it('adds the rock surcharge to underground only', () => {
    const state = makeState(makeGridCity({ rock: true }));
    const segment = seg(state, H(0, 0));
    const construction = Math.round(segment.lengthFt * UNDERGROUND_COST_PER_FT);
    const rock = Math.round(segment.lengthFt * UNDERGROUND_ROCK_SURCHARGE_PER_FT);
    expect(spanCharges(segment, 'underground')).toEqual({
      construction,
      rock,
      poles: 0,
      makeReady: 0,
      total: construction + rock,
      refundable: construction + rock,
    });
    expect(spanCharges(segment, 'aerial').rock).toBe(0);
    expect(spanCharges(seg(makeState(), H(0, 0)), 'underground').rock).toBe(0);
  });

  it('rounds each charge to whole dollars', () => {
    const city = makeGridCity({ rock: true });
    city.segments[0] = { ...city.segments[0]!, lengthFt: 33.33 };
    const segment = city.segments[0];
    expect(spanCharges(segment, 'aerial').construction).toBe(Math.round(33.33 * AERIAL_COST_PER_FT));
    expect(spanCharges(segment, 'underground').rock).toBe(Math.round(33.33 * UNDERGROUND_ROCK_SURCHARGE_PER_FT));
    for (const method of ['aerial', 'underground'] as const) {
      const c = spanCharges(segment, method);
      expect(Number.isInteger(c.construction) && Number.isInteger(c.rock) && Number.isInteger(c.total)).toBe(true);
    }
  });

  it('charges no make-ready on a street without poles', () => {
    const state = makeState(makeGridCity({ hasPoles: false }));
    expect(charges(state, H(0, 0), 'aerial')).toMatchObject({ poles: 0, makeReady: 0 });
  });

  it('gives all-in dollars per foot, null for aerial without poles', () => {
    const state = makeState();
    const segment = seg(state, H(0, 0));
    expect(segmentCostPerFt(segment, 'aerial')).toBe(spanCharges(segment, 'aerial').total / segment.lengthFt);
    expect(segmentCostPerFt(segment, 'underground')).toBe(UNDERGROUND_COST_PER_FT);
    const bare = { ...segment, hasPoles: false };
    expect(segmentCostPerFt(bare, 'aerial')).toBeNull();
    expect(segmentCostPerFt(bare, 'underground')).toBe(UNDERGROUND_COST_PER_FT);
  });
});

describe('quoteCable', () => {
  it('itemizes an aerial order: strand, make-ready and the two fees', () => {
    const state = makeState();
    const ids = [H(0, 0), V(0, 0)];
    const quote = quoteCable(state, ids, 'aerial');
    const poles = polesOnSegment(seg(state, H(0, 0))) + polesOnSegment(seg(state, V(0, 0)));
    const strand = charges(state, H(0, 0), 'aerial').construction + charges(state, V(0, 0), 'aerial').construction;
    expect(quote).toMatchObject({ ok: true, reasons: [], newSegments: ids, lengthFt: 360 });
    expect(quote.lines).toEqual([
      { kind: 'cable', label: 'Aerial strand', quantity: 360, unit: 'ft', rate: AERIAL_COST_PER_FT, amount: strand, refundable: true },
      {
        kind: 'makeReady',
        label: `Make-ready (${poles} poles)`,
        quantity: poles,
        unit: 'pole',
        rate: MAKE_READY_COST_PER_POLE,
        amount: poles * MAKE_READY_COST_PER_POLE,
        refundable: false,
      },
      { kind: 'engineering', label: 'Engineering', quantity: 1, unit: 'order', rate: ENGINEERING_FEE, amount: ENGINEERING_FEE, refundable: false },
      {
        kind: 'permit',
        label: 'Pole attachment application',
        quantity: 1,
        unit: 'order',
        rate: PERMIT_FEE_AERIAL,
        amount: PERMIT_FEE_AERIAL,
        refundable: false,
      },
    ]);
    expect(quote.cost).toBe(quote.lines.reduce((sum, line) => sum + line.amount, 0));
    expect(quote.cost).toBe(orderCost(state, ids, 'aerial'));
    expect(quote.refundable).toBe(strand);
    expect(quote.costPerFt).toBe(quote.cost / 360);
  });

  it('itemizes an underground order with a city permit and no make-ready', () => {
    const state = makeState();
    const quote = quoteCable(state, [H(0, 0), V(0, 0)], 'underground');
    expect(quote.lines.map((l) => [l.kind, l.label])).toEqual([
      ['cable', 'Underground bore'],
      ['engineering', 'Engineering'],
      ['permit', 'City permit'],
    ]);
    expect(quote.lines[0]).toMatchObject({ quantity: 360, rate: UNDERGROUND_COST_PER_FT, amount: 360 * UNDERGROUND_COST_PER_FT });
    expect(quote.lines[2]).toMatchObject({ rate: PERMIT_FEE_UNDERGROUND, amount: PERMIT_FEE_UNDERGROUND });
    expect(quote.cost).toBe(360 * UNDERGROUND_COST_PER_FT + ENGINEERING_FEE + PERMIT_FEE_UNDERGROUND);
    expect(quote.refundable).toBe(360 * UNDERGROUND_COST_PER_FT);
  });

  it('adds a rock line for underground on rock only, over the rock segments only', () => {
    const city = makeGridCity();
    city.segments[H(0, 0)] = { ...city.segments[H(0, 0)]!, rock: true };
    const state = makeState(city);
    const underground = quoteCable(state, [H(0, 0), V(0, 0)], 'underground');
    const rock = underground.lines.find((l) => l.kind === 'rock');
    expect(rock).toEqual({
      kind: 'rock',
      label: 'Rock surcharge',
      quantity: 240,
      unit: 'ft',
      rate: UNDERGROUND_ROCK_SURCHARGE_PER_FT,
      amount: Math.round(240 * UNDERGROUND_ROCK_SURCHARGE_PER_FT),
      refundable: true,
    });
    expect(underground.lines.map((l) => l.kind)).toEqual(['cable', 'rock', 'engineering', 'permit']);
    expect(underground.refundable).toBe(underground.lines[0]!.amount + rock!.amount);
    expect(underground.cost).toBe(orderCost(state, [H(0, 0), V(0, 0)], 'underground'));
    expect(quoteCable(state, [H(0, 0), V(0, 0)], 'aerial').lines.some((l) => l.kind === 'rock')).toBe(false);
    expect(quoteCable(state, [V(0, 0)], 'underground').lines.some((l) => l.kind === 'rock')).toBe(false);
  });

  it('sums per-span rounded amounts, so lines add up exactly', () => {
    const city = makeGridCity();
    city.segments[0] = { ...city.segments[0]!, lengthFt: 33.33 };
    city.segments[1] = { ...city.segments[1]!, lengthFt: 33.33 };
    const state = makeState(city);
    const quote = quoteCable(state, [0, 1], 'underground');
    // 2 x round(33.33 x rate), not round(66.66 x rate).
    expect(quote.lines[0]!.amount).toBe(2 * Math.round(33.33 * UNDERGROUND_COST_PER_FT));
    expect(quote.cost).toBe(quote.lines.reduce((sum, line) => sum + line.amount, 0));
  });

  it('skips already-cabled segments and duplicate ids, charging the fees once', () => {
    const state = makeState();
    expect(lay(state, [H(0, 0)], 'aerial').ok).toBe(true);
    const quote = quoteCable(state, [H(0, 0), H(1, 0), H(1, 0), H(0, 0), H(1, 0)], 'aerial');
    expect(quote).toMatchObject({ ok: true, newSegments: [H(1, 0)], lengthFt: 240 });
    expect(quote.cost).toBe(charges(state, H(1, 0), 'aerial').total + ENGINEERING_FEE + PERMIT_FEE_AERIAL);
    expect(quote.lines.filter((l) => l.kind === 'engineering' || l.kind === 'permit').map((l) => l.quantity)).toEqual([1, 1]);
  });

  it('rejects an order with nothing new to build and charges nothing, not even fees', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'aerial');
    const quote = quoteCable(state, [H(0, 0), H(0, 0)], 'underground');
    expect(quote.ok).toBe(false);
    expect(quote.reasons).toEqual(['Every selected street already has cable']);
    expect(quote).toMatchObject({ cost: 0, lines: [], refundable: 0, costPerFt: 0, lengthFt: 0 });
  });

  it('rejects an empty order', () => {
    const quote = quoteCable(makeState(), [], 'aerial');
    expect(quote.ok).toBe(false);
    expect(quote.reasons).toEqual(['No street segments selected']);
    expect(quote.lines).toEqual([]);
  });

  it('rejects aerial on streets without poles, naming them', () => {
    const state = makeState(makeGridCity({ hasPoles: false }));
    const quote = quoteCable(state, [H(0, 0), H(1, 0), V(0, 0)], 'aerial');
    expect(quote.ok).toBe(false);
    expect(quote.reasons).toEqual(['No poles on 1st St, A Ave - lay underground instead']);
    // No poles, no make-ready line.
    expect(quote.lines.map((l) => l.kind)).toEqual(['cable', 'engineering', 'permit']);
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

  it('checks cash against the full cost including fees and make-ready', () => {
    const state = makeState();
    const cost = orderCost(state, [H(0, 0), H(1, 0)], 'aerial');
    state.finance.cash = cost - 1;
    const quote = quoteCable(state, [H(0, 0), H(1, 0)], 'aerial');
    expect(quote.ok).toBe(false);
    expect(quote.cost).toBe(cost);
    expect(quote.reasons).toEqual([`Not enough cash: need ${formatMoney(cost)}, have ${formatMoney(cost - 1)}`]);
    state.finance.cash = cost;
    expect(quoteCable(state, [H(0, 0), H(1, 0)], 'aerial').ok).toBe(true);
  });

  it('quotes the full permitting range and the longest construction', () => {
    const state = makeState(makeGridCity({ blockW: 20 }));
    // Horizontal segments are 1,200 ft, vertical 120 ft.
    const aerial = quoteCable(state, [H(0, 0), V(0, 0)], 'aerial');
    expect(aerial).toMatchObject({
      permitDaysMin: MAKE_READY_DAYS_MIN,
      permitDaysMax: MAKE_READY_LONG_DAYS_MAX,
      constructDays: 2,
      rememberedPermitDays: null,
    });
    const underground = quoteCable(state, [V(0, 0), H(0, 0)], 'underground');
    expect(underground).toMatchObject({ permitDaysMin: PERMIT_DAYS_MIN, permitDaysMax: PERMIT_DAYS_MAX, constructDays: 4 });
    expect(quoteCable(state, [V(0, 0)], 'underground').constructDays).toBe(1);
  });

  it('does not change state', () => {
    const state = makeState();
    addCabinet(state, 0, 'permitting');
    lay(state, [H(0, 0)], 'aerial');
    const before = JSON.stringify(state);
    quoteCable(state, [H(0, 0), H(1, 0), V(1, 0)], 'aerial');
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('quoteCable passings, CPP and wrong-side buildings', () => {
  it('counts units along the new cable today and in the future, by serving segment', () => {
    const city = makeGridCity();
    city.parcels[0] = { ...city.parcels[0]!, appearsDay: 10 };
    city.parcels[2] = { ...city.parcels[2]!, kind: 'mdu', units: 24 };
    const state = makeState(city);
    // Lots 0, 2, 4, 6 front 1st St; A Ave serves nobody (lots 0 and 1 only touch it).
    const quote = quoteCable(state, [H(0, 0), V(0, 0)], 'underground');
    expect(quote).toMatchObject({ passingsAlong: 26, passingsFuture: 1 });
    state.day = 10;
    expect(quoteCable(state, [H(0, 0), V(0, 0)], 'underground')).toMatchObject({ passingsAlong: 27, passingsFuture: 0 });
  });

  it('gives cost per passing and its band, or null with no passings', () => {
    const state = makeState();
    const quote = quoteCable(state, [H(0, 0), H(1, 0)], 'aerial');
    expect(quote.passingsAlong).toBe(8);
    expect(quote.cpp).toBe(quote.cost / 8);
    expect(quote.cppBand).toBe(cppBand(quote.cost / 8));
    const avenue = quoteCable(state, [V(0, 0)], 'aerial');
    expect(avenue).toMatchObject({ passingsAlong: 0, cpp: null, cppBand: null });
  });

  it('counts passings in reach only with a cabinet ordered on CO-connected cable', () => {
    const state = makeState();
    expect(quoteCable(state, [H(0, 0), H(1, 0)], 'aerial').passingsInReach).toBe(0);
    // A cabinet still in permitting counts: the quote assumes everything ordered goes live.
    addCabinet(state, 0, 'permitting');
    expect(quoteCable(state, [H(0, 0), H(1, 0)], 'aerial').passingsInReach).toBe(8);
  });

  it('routes the hypothetical network through spans already ordered', () => {
    const state = makeState();
    addCabinet(state, 1, 'permitting');
    // Without 1st St from the CO, 2nd block's 1st St is an island.
    expect(quoteCable(state, [H(1, 0)], 'aerial').passingsInReach).toBe(0);
    addSpan(state, H(0, 0), 'permitting');
    expect(quoteCable(state, [H(1, 0)], 'aerial')).toMatchObject({ passingsAlong: 4, passingsInReach: 4 });
  });

  it('leaves out passings beyond cabinet reach', () => {
    // 1,800 ft blocks: 1st St's second segment starts 1,800 ft from the CO cabinet.
    const state = makeState(makeGridCity({ blockW: 30 }));
    addCabinet(state, 0, 'constructing');
    const quote = quoteCable(state, [H(0, 0), H(1, 0)], 'underground');
    expect(quote).toMatchObject({ passingsAlong: 60, passingsInReach: 30 });
  });

  it('lists existing buildings along the route that face an uncabled street', () => {
    const state = makeState();
    // Lots 0 and 1 sit on A Ave's corners but front 1st St and 2nd St.
    expect(quoteCable(state, [V(0, 0)], 'aerial').wrongSideParcels).toEqual([0, 1]);
    // Cabling 1st St in the same order takes care of lot 0.
    expect(quoteCable(state, [V(0, 0), H(0, 0)], 'aerial').wrongSideParcels).toEqual([1]);
    // So does 2nd St already having cable (any stage).
    addSpan(state, H(0, 1), 'permitting');
    expect(quoteCable(state, [V(0, 0), H(0, 0)], 'aerial').wrongSideParcels).toEqual([]);
    // Buildings that do not exist yet are not counted.
    const city = makeGridCity();
    city.parcels[1] = { ...city.parcels[1]!, appearsDay: 10 };
    expect(quoteCable(makeState(city), [V(0, 0)], 'aerial').wrongSideParcels).toEqual([0]);
    // Streets lined by the lots they serve have none.
    expect(quoteCable(state, [H(1, 0), H(2, 0)], 'aerial').wrongSideParcels).toEqual([]);
  });
});

describe('layCable', () => {
  it('creates permitting spans, charges cash and capex and posts one construction entry', () => {
    const state = makeState(makeGridCity({ blockW: 20 }));
    state.day = 7;
    const quote = quoteCable(state, [H(0, 0), V(0, 0)], 'aerial');
    const result = lay(state, [H(0, 0), V(0, 0)], 'aerial');
    expect(result).toEqual({ ok: true, cost: quote.cost });
    expect(state.finance.cash).toBe(START_CASH - quote.cost);
    expect(state.finance.capex).toEqual({ osp: quote.cost, connect: 0, co: 0 });
    expect(state.nextId).toBe(3);
    expect(state.network.version).toBe(1);

    const [first, second] = state.network.spans;
    expect(first).toMatchObject({ id: 1, segment: H(0, 0), method: 'aerial', stage: 'permitting', constructDays: 2, orderedDay: 7, liveDay: null });
    expect(second).toMatchObject({ id: 2, segment: V(0, 0), constructDays: 1 });
    expect(first!.stageDaysLeft).toBe(second!.stageDaysLeft);

    expect(state.finance.monthToDate).toEqual([
      { day: 7, category: 'construction', amount: -quote.cost, memo: 'Aerial cable on 1st St, A Ave (1,320 ft)' },
    ]);
  });

  it('splits the order fees over the spans by length, remainder on the last span', () => {
    const state = makeState(makeGridCity({ blockW: 20 }));
    const ids = [H(0, 0), V(0, 0), H(0, 1)];
    const quote = quoteCable(state, ids, 'underground');
    lay(state, ids, 'underground');
    const fees = orderFees('underground');
    const total = 1_200 + 120 + 1_200;
    const share = (ft: number) => Math.floor((fees * ft) / total);
    const spans = state.network.spans;
    expect(spans[0]!.cost).toBe(charges(state, H(0, 0), 'underground').total + share(1_200));
    expect(spans[1]!.cost).toBe(charges(state, V(0, 0), 'underground').total + share(120));
    expect(spans[2]!.cost).toBe(charges(state, H(0, 1), 'underground').total + fees - share(1_200) - share(120));
    expect(spans.reduce((sum, s) => sum + s.cost, 0)).toBe(quote.cost);
    for (const span of spans) expect(span.refundable).toBe(charges(state, span.segment, 'underground').refundable);
  });

  it('keeps refundable to construction plus rock', () => {
    const state = makeState(makeGridCity({ rock: true }));
    lay(state, [H(0, 0)], 'underground');
    lay(state, [H(1, 0)], 'aerial');
    const [bore, strand] = state.network.spans;
    const c = charges(state, H(0, 0), 'underground');
    expect(bore!.refundable).toBe(c.construction + c.rock);
    expect(strand!.refundable).toBe(charges(state, H(1, 0), 'aerial').construction);
    for (const span of state.network.spans) expect(span.refundable).toBeLessThanOrEqual(span.cost);
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
    const cost = quoteCable(state, [H(0, 0)], 'aerial').cost;
    const rng = new Rng(5);
    const before = JSON.stringify(state);
    const result = layCable(state, [H(0, 0)], 'aerial', rng);
    expect(result).toEqual({ ok: false, reason: `Not enough cash: need ${formatMoney(cost)}, have $100` });
    expect(JSON.stringify(state)).toBe(before);
    expect(rng.state).toBe(new Rng(5).state);
  });

  it('joins multiple reasons', () => {
    const state = makeState(makeGridCity({ hasPoles: false }));
    state.finance.cash = 0;
    const cost = quoteCable(state, [H(0, 0)], 'aerial').cost;
    expect(reasonOf(lay(state, [H(0, 0)], 'aerial'))).toBe(
      `No poles on 1st St - lay underground instead; Not enough cash: need ${formatMoney(cost)}, have $0`,
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
        expect([...days][0]).toBe(refDraw(ref, method));
        expect(rng.state).toBe(ref.state);
      }
    }
  });
});

describe('make-ready memory', () => {
  it('remembers each fresh draw, sorted by segment then method', () => {
    const state = makeState();
    state.day = 4;
    lay(state, [H(2, 0), H(0, 0)], 'aerial', 3);
    const days = state.network.spans[0]!.stageDaysLeft;
    lay(state, [V(0, 0), H(1, 1)], 'underground', 4);
    const ugDays = state.network.spans[2]!.stageDaysLeft;
    expect(state.network.makeReady).toEqual([
      { segment: H(0, 0), method: 'aerial', days, drawnDay: 4 },
      { segment: H(2, 0), method: 'aerial', days, drawnDay: 4 },
      { segment: H(1, 1), method: 'underground', days: ugDays, drawnDay: 4 },
      { segment: V(0, 0), method: 'underground', days: ugDays, drawnDay: 4 },
    ]);
    expect(rememberedPermitDays(state, H(0, 0), 'aerial')).toBe(days);
    expect(rememberedPermitDays(state, H(0, 0), 'underground')).toBeNull();
  });

  it('reuses the remembered days after cancel and reorder, consuming no RNG', () => {
    const state = makeState();
    expect(applyCommand(state, { type: 'layCable', segments: [H(0, 0)], method: 'aerial' }).ok).toBe(true);
    const days = state.network.spans[0]!.stageDaysLeft;
    const memos = structuredClone(state.network.makeReady);
    expect(applyCommand(state, { type: 'removeSpan', span: state.network.spans[0]!.id }).ok).toBe(true);
    // Memos survive the cancellation.
    expect(state.network.makeReady).toEqual(memos);

    state.day = MAKE_READY_MEMORY_DAYS - 1;
    const quote = quoteCable(state, [H(0, 0)], 'aerial');
    expect(quote).toMatchObject({ rememberedPermitDays: days, permitDaysMin: days, permitDaysMax: days });
    const events = state.rng.events;
    expect(applyCommand(state, { type: 'layCable', segments: [H(0, 0)], method: 'aerial' }).ok).toBe(true);
    expect(state.rng.events).toBe(events);
    expect(state.network.spans[0]!.stageDaysLeft).toBe(days);
    // Reuse never moves drawnDay, so the memo still expires on schedule.
    expect(state.network.makeReady).toEqual(memos);
  });

  it('draws fresh once the memory has expired, and replaces the memo', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'underground', 1);
    removeSpan(state, state.network.spans[0]!.id);
    state.day = MAKE_READY_MEMORY_DAYS;
    expect(quoteCable(state, [H(0, 0)], 'underground')).toMatchObject({
      rememberedPermitDays: null,
      permitDaysMin: PERMIT_DAYS_MIN,
      permitDaysMax: PERMIT_DAYS_MAX,
    });
    const rng = new Rng(99);
    layCable(state, [H(0, 0)], 'underground', rng);
    const ref = new Rng(99);
    const fresh = refDraw(ref, 'underground');
    expect(rng.state).toBe(ref.state);
    expect(state.network.spans[0]!.stageDaysLeft).toBe(fresh);
    expect(state.network.makeReady).toEqual([
      { segment: H(0, 0), method: 'underground', days: fresh, drawnDay: MAKE_READY_MEMORY_DAYS },
    ]);
  });

  it('draws fresh for the other method', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'underground', 1);
    const ugDays = state.network.spans[0]!.stageDaysLeft;
    removeSpan(state, state.network.spans[0]!.id);
    expect(quoteCable(state, [H(0, 0)], 'aerial').rememberedPermitDays).toBeNull();
    const rng = new Rng(8);
    layCable(state, [H(0, 0)], 'aerial', rng);
    const ref = new Rng(8);
    const fresh = refDraw(ref, 'aerial');
    expect(rng.state).toBe(ref.state);
    expect(state.network.spans[0]!.stageDaysLeft).toBe(fresh);
    expect(state.network.makeReady).toEqual([
      { segment: H(0, 0), method: 'aerial', days: fresh, drawnDay: 0 },
      { segment: H(0, 0), method: 'underground', days: ugDays, drawnDay: 0 },
    ]);
  });

  it('keeps remembered spans on their days while the rest share one fresh draw', () => {
    const state = makeState();
    lay(state, [H(1, 0)], 'aerial', 21);
    const remembered = state.network.spans[0]!.stageDaysLeft;
    removeSpan(state, state.network.spans[0]!.id);
    state.day = 30;

    const quote = quoteCable(state, [H(0, 0), H(1, 0), H(2, 0)], 'aerial');
    expect(quote.rememberedPermitDays).toBe(remembered);
    expect(quote.permitDaysMin).toBe(Math.max(remembered, MAKE_READY_DAYS_MIN));
    expect(quote.permitDaysMax).toBe(Math.max(remembered, MAKE_READY_LONG_DAYS_MAX));

    const rng = new Rng(22);
    layCable(state, [H(0, 0), H(1, 0), H(2, 0)], 'aerial', rng);
    const ref = new Rng(22);
    const fresh = refDraw(ref, 'aerial');
    expect(rng.state).toBe(ref.state);
    expect(state.network.spans.map((s) => [s.segment, s.stageDaysLeft])).toEqual([
      [H(0, 0), fresh],
      [H(1, 0), remembered],
      [H(2, 0), fresh],
    ]);
    expect(state.network.makeReady).toEqual([
      { segment: H(0, 0), method: 'aerial', days: fresh, drawnDay: 30 },
      { segment: H(1, 0), method: 'aerial', days: remembered, drawnDay: 0 },
      { segment: H(2, 0), method: 'aerial', days: fresh, drawnDay: 30 },
    ]);
  });

  it('quotes a remembered long draw as the floor of the permitting range', () => {
    const state = makeState();
    state.network.makeReady = [{ segment: H(0, 0), method: 'underground', days: PERMIT_DAYS_MAX + 100, drawnDay: 0 }];
    expect(quoteCable(state, [H(0, 0), H(1, 0)], 'underground')).toMatchObject({
      rememberedPermitDays: PERMIT_DAYS_MAX + 100,
      permitDaysMin: PERMIT_DAYS_MAX + 100,
      permitDaysMax: PERMIT_DAYS_MAX + 100,
    });
    state.network.makeReady = [{ segment: H(0, 0), method: 'underground', days: PERMIT_DAYS_MIN + 1, drawnDay: 0 }];
    expect(quoteCable(state, [H(0, 0), H(1, 0)], 'underground')).toMatchObject({
      rememberedPermitDays: PERMIT_DAYS_MIN + 1,
      permitDaysMin: PERMIT_DAYS_MIN + 1,
      permitDaysMax: PERMIT_DAYS_MAX,
    });
    // A memo on a segment that is skipped (already cabled) does not count.
    addSpan(state, H(0, 0), 'permitting');
    expect(quoteCable(state, [H(0, 0), H(1, 0)], 'underground').rememberedPermitDays).toBeNull();
  });

  it('prunes expired memos on the next successful order, not on a rejected one', () => {
    const state = makeState();
    lay(state, [H(0, 0), V(0, 0)], 'aerial');
    lay(state, [H(2, 2)], 'underground');
    state.day = MAKE_READY_MEMORY_DAYS + 5;

    // Rejected: nothing changes, expired memos linger.
    const cash = state.finance.cash;
    state.finance.cash = 0;
    expectRejected(state, (s) => lay(s, [H(1, 0)], 'aerial'), /Not enough cash/);
    expect(state.network.makeReady).toHaveLength(3);
    state.finance.cash = cash;

    expect(lay(state, [H(1, 0)], 'aerial', 5).ok).toBe(true);
    expect(state.network.makeReady).toEqual([
      { segment: H(1, 0), method: 'aerial', days: state.network.spans.at(-1)!.stageDaysLeft, drawnDay: MAKE_READY_MEMORY_DAYS + 5 },
    ]);
  });

  it('leaves memos and RNG untouched when an order with remembered segments is rejected', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'aerial');
    removeSpan(state, state.network.spans[0]!.id);
    state.finance.cash = 0;
    const rng = new Rng(3);
    expectRejected(state, (s) => layCable(s, [H(0, 0), H(1, 0)], 'aerial', rng), /Not enough cash/);
    expect(rng.state).toBe(new Rng(3).state);
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
      splitters: CABINET_START_SPLITTERS,
      ports: CABINET_START_SPLITTERS * SPLIT_RATIO,
    });
  });

  it('places a cabinet, charges equipment and capex and bumps the version', () => {
    const state = makeState();
    state.nextId = 40;
    expect(placeCabinet(state, 5)).toEqual({ ok: true, cost: CABINET_PRICE });
    expect(state.network.cabinets).toEqual([
      {
        id: 40,
        node: 5,
        splitters: CABINET_START_SPLITTERS,
        stage: 'permitting',
        stageDaysLeft: CABINET_PERMIT_DAYS,
        cost: CABINET_PRICE,
        orderedDay: 0,
        liveDay: null,
      },
    ]);
    expect(state.nextId).toBe(41);
    expect(state.network.version).toBe(1);
    expect(state.finance.cash).toBe(START_CASH - CABINET_PRICE);
    expect(state.finance.capex).toEqual({ osp: CABINET_PRICE, connect: 0, co: 0 });
    expect(state.finance.monthToDate).toEqual([
      { day: 0, category: 'equipment', amount: -CABINET_PRICE, memo: 'Cabinet at 2nd St & B Ave (1 splitter)' },
    ]);
    expect(state.notices).toEqual([]);
  });

  it('rejects bad nodes', () => {
    const state = makeState();
    for (const bad of [-1, 12, 2.5, Number.NaN]) {
      expectRejected(state, (s) => placeCabinet(s, bad), `Unknown street corner: ${bad}`);
    }
  });

  it('allows one cabinet per node', () => {
    const state = makeState();
    expect(placeCabinet(state, 0).ok).toBe(true);
    expectRejected(state, (s) => placeCabinet(s, 0), 'There is already a cabinet at 1st St & A Ave');
    expect(placeCabinet(state, 1).ok).toBe(true);
  });

  it('caps total splitters at the OLT port count and says when the last port is used', () => {
    const state = makeState();
    state.network.olt.ponPorts = 2;
    expect(placeCabinet(state, 0).ok).toBe(true);
    expect(state.notices).toEqual([]);
    expect(placeCabinet(state, 1).ok).toBe(true);
    expect(state.notices).toEqual([
      {
        id: 1,
        day: 0,
        kind: 'oltFull',
        message: 'All 2 PON ports at the CO are in use: add an OLT line card before the next cabinet or splitter',
        cabinet: null,
        milestone: null,
      },
    ]);
    expect(state.nextNoticeId).toBe(2);
    // Same blocker as a splitter: it says how to get more ports.
    expectRejected(state, (s) => placeCabinet(s, 2), 'No free PON ports on the OLT: 2 of 2 in use - add a line card at the CO');
    expect(state.network.cabinets).toHaveLength(2);
  });

  it('rejects when cash is short', () => {
    const state = makeState();
    state.finance.cash = CABINET_PRICE - 1;
    expectRejected(
      state,
      (s) => placeCabinet(s, 0),
      `Not enough cash: need ${formatMoney(CABINET_PRICE)}, have ${formatMoney(CABINET_PRICE - 1)}`,
    );
    state.finance.cash = CABINET_PRICE;
    expect(placeCabinet(state, 0).ok).toBe(true);
    expect(state.finance.cash).toBe(0);
  });
});

describe('splitters', () => {
  it('quotes one more splitter', () => {
    const state = makeState();
    placeCabinet(state, 0);
    const id = state.network.cabinets[0]!.id;
    expect(quoteSplitter(state, id)).toEqual({
      ok: true,
      reasons: [],
      cost: SPLITTER_COST,
      splittersAfter: CABINET_START_SPLITTERS + 1,
      portsAfter: (CABINET_START_SPLITTERS + 1) * SPLIT_RATIO,
      ponPortsUsedAfter: CABINET_START_SPLITTERS + 1,
      ponPorts: state.network.olt.ponPorts,
    });
  });

  it('adds a splitter in any stage, charging equipment and capex', () => {
    for (const stage of ['permitting', 'constructing', 'live'] as const) {
      const state = makeState();
      const id = addCabinet(state, 0, stage);
      const version = state.network.version;
      expect(addSplitter(state, id)).toEqual({ ok: true, cost: SPLITTER_COST });
      expect(state.network.cabinets[0]).toMatchObject({ splitters: 2, cost: SPLITTER_COST, stage });
      expect(state.network.version).toBe(version + 1);
      expect(ponPortsUsed(state)).toBe(2);
      expect(state.finance.cash).toBe(START_CASH - SPLITTER_COST);
      expect(state.finance.capex).toEqual({ osp: SPLITTER_COST, connect: 0, co: 0 });
      expect(state.finance.monthToDate).toEqual([
        { day: 0, category: 'equipment', amount: -SPLITTER_COST, memo: `Splitter added at 1st St & A Ave (2 x 1:${SPLIT_RATIO})` },
      ]);
      expect(state.notices).toEqual([]);
    }
  });

  it('posts oltFull when a splitter takes the last PON port', () => {
    const state = makeState();
    state.network.olt.ponPorts = 3;
    const id = addCabinet(state, 0);
    expect(addSplitter(state, id).ok).toBe(true);
    expect(state.notices).toEqual([]);
    expect(addSplitter(state, id).ok).toBe(true);
    expect(state.notices.map((n) => [n.kind, n.message])).toEqual([
      ['oltFull', 'All 3 PON ports at the CO are in use: add an OLT line card before the next cabinet or splitter'],
    ]);
  });

  it('rejects every blocker without changing anything', () => {
    const state = makeState();
    const id = addCabinet(state, 0);
    expectRejected(state, (s) => addSplitter(s, 99), 'Unknown cabinet: 99');
    expect(quoteSplitter(state, 99)).toMatchObject({ ok: false, reasons: ['Unknown cabinet: 99'] });

    state.network.cabinets[0]!.splitters = MAX_SPLITTERS_PER_CABINET;
    // Room on the OLT, so the full cabinet is the only blocker.
    state.network.olt.ponPorts = MAX_SPLITTERS_PER_CABINET + 1;
    expectRejected(
      state,
      (s) => addSplitter(s, id),
      `Cabinet at 1st St & A Ave already has ${MAX_SPLITTERS_PER_CABINET} splitters, the most it holds`,
    );

    state.network.cabinets[0]!.splitters = 2;
    state.network.olt.ponPorts = 2;
    expectRejected(state, (s) => addSplitter(s, id), 'No free PON ports on the OLT: 2 of 2 in use - add a line card at the CO');
    state.network.olt.cards = OLT_MAX_CARDS;
    expectRejected(state, (s) => addSplitter(s, id), 'No free PON ports on the OLT: 2 of 2 in use - the OLT chassis is full');

    state.network.olt.ponPorts = 16;
    state.finance.cash = SPLITTER_COST - 1;
    expectRejected(
      state,
      (s) => addSplitter(s, id),
      `Not enough cash: need ${formatMoney(SPLITTER_COST)}, have ${formatMoney(SPLITTER_COST - 1)}`,
    );
    state.finance.cash = SPLITTER_COST;
    expect(addSplitter(state, id).ok).toBe(true);
  });

  it('lists several blockers together', () => {
    const state = makeState();
    const id = addCabinet(state, 0);
    state.network.olt.ponPorts = 1;
    state.finance.cash = 0;
    expect(quoteSplitter(state, id).reasons).toEqual([
      'No free PON ports on the OLT: 1 of 1 in use - add a line card at the CO',
      `Not enough cash: need ${formatMoney(SPLITTER_COST)}, have $0`,
    ]);
  });
});

describe('removeCabinet', () => {
  function withAccounts(state: GameState, cabinet: number): void {
    state.sales.accounts = [
      { parcel: 0, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] },
      { parcel: 2, cabinet: cabinet + 100, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 0, locks: [] },
      { parcel: 4, cabinet, tierUnits: { fiber500: 3, fiber1g: 2, fiber2g: 1 }, since: 0, locks: [] },
    ];
  }

  it('quotes the refund, freed ports and affected subscribers', () => {
    const state = makeState();
    placeCabinet(state, 0);
    const cabinet = state.network.cabinets[0]!;
    addSplitter(state, cabinet.id);
    withAccounts(state, cabinet.id);
    expect(quoteRemoveCabinet(state, cabinet.id)).toEqual({
      ok: true,
      reasons: [],
      refund: Math.round(cabinet.cost * CABINET_CANCEL_REFUND),
      ponPortsFreed: 2,
      subscribersAffected: 7,
    });
    cabinet.stage = 'constructing';
    expect(quoteRemoveCabinet(state, cabinet.id)).toMatchObject({ refund: 0, ponPortsFreed: 2 });
    expect(quoteRemoveCabinet(state, 99)).toEqual({
      ok: false,
      reasons: ['Unknown cabinet: 99'],
      refund: 0,
      ponPortsFreed: 0,
      subscribersAffected: 0,
    });
  });

  it('refunds a cabinet cancelled in permitting, splitters included, and frees its ports', () => {
    const state = makeState();
    placeCabinet(state, 0);
    const id = state.network.cabinets[0]!.id;
    addSplitter(state, id);
    const paid = CABINET_PRICE + SPLITTER_COST;
    expect(state.network.cabinets[0]!.cost).toBe(paid);
    const refund = Math.round(paid * CABINET_CANCEL_REFUND);
    const version = state.network.version;
    withAccounts(state, id);
    const accounts = structuredClone(state.sales.accounts);

    expect(removeCabinet(state, id)).toEqual({ ok: true, cost: -refund });
    expect(state.network.cabinets).toEqual([]);
    expect(ponPortsUsed(state)).toBe(0);
    expect(state.network.version).toBe(version + 1);
    expect(state.finance.cash).toBe(START_CASH - paid + refund);
    expect(state.finance.capex.osp).toBe(paid - refund);
    expect(state.finance.monthToDate.at(-1)).toEqual({
      day: 0,
      category: 'refund',
      amount: refund,
      memo: 'Refund: cancelled cabinet at 1st St & A Ave',
    });
    // Subscribers are dropped by the next daily sales step, not here.
    expect(state.sales.accounts).toEqual(accounts);
  });

  it('removes a cabinet under construction or live without a refund', () => {
    for (const stage of ['constructing', 'live'] as const) {
      const state = makeState();
      placeCabinet(state, 5);
      const cabinet = state.network.cabinets[0]!;
      cabinet.stage = stage;
      const cash = state.finance.cash;
      const capex = { ...state.finance.capex };
      expect(removeCabinet(state, cabinet.id)).toEqual({ ok: true, cost: 0 });
      expect(state.network.cabinets).toEqual([]);
      expect(state.finance.cash).toBe(cash);
      expect(state.finance.capex).toEqual(capex);
      expect(state.finance.monthToDate.at(-1)).toEqual({
        day: 0,
        category: 'refund',
        amount: 0,
        memo: 'Removed cabinet at 2nd St & B Ave - no refund once construction starts',
      });
    }
  });

  it('rejects an unknown cabinet without changing anything', () => {
    const state = makeState();
    placeCabinet(state, 0);
    for (const bad of [99, -1, 1.5, Number.NaN]) expectRejected(state, (s) => removeCabinet(s, bad), `Unknown cabinet: ${bad}`);
  });
});

describe('OLT line cards', () => {
  it('quotes and installs a card instantly', () => {
    const state = makeState();
    const { cards, ponPorts } = state.network.olt;
    expect(quoteOltCard(state)).toEqual({
      ok: true,
      reasons: [],
      cost: OLT_CARD_COST,
      cardsAfter: cards + 1,
      ponPortsAfter: ponPorts + OLT_PORTS_PER_CARD,
    });
    const version = state.network.version;
    expect(addOltCard(state)).toEqual({ ok: true, cost: OLT_CARD_COST });
    expect(state.network.olt).toMatchObject({ cards: cards + 1, ponPorts: ponPorts + OLT_PORTS_PER_CARD });
    expect(state.network.version).toBe(version + 1);
    expect(state.finance.cash).toBe(START_CASH - OLT_CARD_COST);
    expect(state.finance.capex).toEqual({ osp: 0, connect: 0, co: OLT_CARD_COST });
    expect(state.finance.monthToDate).toEqual([
      {
        day: 0,
        category: 'equipment',
        amount: -OLT_CARD_COST,
        memo: `OLT line card ${cards + 1} of ${OLT_MAX_CARDS} at the CO (+${OLT_PORTS_PER_CARD} PON ports)`,
      },
    ]);
  });

  it('frees the way for a cabinet that had no PON port', () => {
    const state = makeState();
    state.network.olt.ponPorts = 1;
    placeCabinet(state, 0);
    expect(reasonOf(placeCabinet(state, 1))).toMatch(/No free PON ports/);
    addOltCard(state);
    expect(placeCabinet(state, 1).ok).toBe(true);
  });

  it('rejects a full chassis or short cash without changing anything', () => {
    const state = makeState();
    state.network.olt.cards = OLT_MAX_CARDS;
    state.network.olt.ponPorts = OLT_MAX_CARDS * OLT_PORTS_PER_CARD;
    expectRejected(state, addOltCard, `The OLT chassis is full: ${OLT_MAX_CARDS} of ${OLT_MAX_CARDS} line cards`);
    state.network.olt.cards = 1;
    state.finance.cash = OLT_CARD_COST - 1;
    expectRejected(
      state,
      addOltCard,
      `Not enough cash: need ${formatMoney(OLT_CARD_COST)}, have ${formatMoney(OLT_CARD_COST - 1)}`,
    );
  });

  it('says the chassis is full when the last port of a full chassis is used', () => {
    const state = makeState();
    state.network.olt.cards = OLT_MAX_CARDS;
    state.network.olt.ponPorts = 1;
    placeCabinet(state, 0);
    expect(state.notices.map((n) => n.message)).toEqual([
      'All 1 PON ports at the CO are in use: the OLT chassis is full, so no more cabinets or splitters fit',
    ]);
  });
});

describe('removeSpan', () => {
  it('refunds construction of a span cancelled in permitting and keeps the fees', () => {
    const state = makeState();
    lay(state, [H(0, 0), H(1, 0)], 'underground');
    const span = state.network.spans[0]!;
    const refund = Math.round(span.refundable * PERMITTING_CANCEL_REFUND);
    expect(span.cost).toBeGreaterThan(refund);
    const cashBefore = state.finance.cash;
    const version = state.network.version;
    const result = removeSpan(state, 1);
    expect(result).toEqual({ ok: true, cost: -refund });
    expect(state.finance.cash).toBe(cashBefore + refund);
    expect(state.network.spans.map((s) => s.id)).toEqual([2]);
    expect(state.network.version).toBe(version + 1);
    expect(state.finance.monthToDate.at(-1)).toEqual({
      day: 0,
      category: 'refund',
      amount: refund,
      memo: `Refund: cancelled underground cable on 1st St (240 ft); ${formatMoney(span.cost - refund)} of fees not refundable`,
    });
  });

  it('keeps make-ready on a cancelled aerial span, and capex nets out to cash spent', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'aerial');
    const span = state.network.spans[0]!;
    const refund = Math.round(span.refundable * PERMITTING_CANCEL_REFUND);
    expect(removeSpan(state, span.id)).toEqual({ ok: true, cost: -refund });
    expect(state.finance.monthToDate.at(-1)!.memo).toBe(
      `Refund: cancelled aerial cable on 1st St (240 ft); ${formatMoney(span.cost - refund)} of fees and make-ready not refundable`,
    );
    expect(span.cost - refund).toBeGreaterThanOrEqual(
      charges(state, H(0, 0), 'aerial').makeReady + orderFees('aerial'),
    );
    expect(state.finance.capex.osp).toBe(START_CASH - state.finance.cash);
    expect(state.finance.capex.osp).toBe(span.cost - refund);
  });

  it('says nothing about fees when everything is refunded (spans migrated from v1)', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'underground');
    const span = state.network.spans[0]!;
    span.refundable = span.cost;
    const refund = Math.round(span.cost * PERMITTING_CANCEL_REFUND);
    removeSpan(state, span.id);
    const memo = state.finance.monthToDate.at(-1)!.memo;
    if (refund === span.cost) expect(memo).toBe('Refund: cancelled underground cable on 1st St (240 ft)');
    else expect(memo).toContain('cancellation charge not refundable');
  });

  it('removes a span under construction or live without a refund', () => {
    for (const stage of ['constructing', 'live'] as const) {
      const state = makeState();
      lay(state, [H(0, 0)], 'aerial');
      state.network.spans[0]!.stage = stage;
      const cash = state.finance.cash;
      const capex = { ...state.finance.capex };
      expect(removeSpan(state, 1)).toEqual({ ok: true, cost: 0 });
      expect(state.finance.cash).toBe(cash);
      expect(state.finance.capex).toEqual(capex);
      expect(state.network.spans).toHaveLength(0);
      expect(state.network.version).toBe(2);
      expect(state.finance.monthToDate.at(-1)).toMatchObject({ category: 'refund', amount: 0 });
      expect(state.finance.monthToDate.at(-1)!.memo).toContain('no refund');
    }
  });

  it('rejects unknown spans', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'aerial');
    for (const bad of [0, 2, 1.5, -1]) expectRejected(state, (s) => removeSpan(s, bad), `Unknown cable span: ${bad}`);
    expect(state.network.spans).toHaveLength(1);
  });

  it('lets the segment be cabled again', () => {
    const state = makeState();
    lay(state, [H(0, 0)], 'aerial');
    removeSpan(state, 1);
    expect(quoteCable(state, [H(0, 0)], 'underground').newSegments).toEqual([H(0, 0)]);
  });
});

describe('quoteRemoveSpan', () => {
  /** Live cable along 1st St (H(0,0) -> H(1,0) -> H(2,0)) from the CO cabinet, one subscriber per lot on it. */
  function litStreet(): { state: GameState; spans: number[]; cabinet: number } {
    const state = makeState();
    const spans = [H(0, 0), H(1, 0), H(2, 0)].map((s) => addSpan(state, s));
    const cabinet = addCabinet(state, state.city.coNode);
    const on = new Set([H(0, 0), H(1, 0), H(2, 0)]);
    state.sales.accounts = state.city.parcels
      .filter((p) => on.has(p.segment))
      .map((p) => ({ parcel: p.id, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] }));
    return { state, spans, cabinet };
  }

  /** Units that the next daily sales step would drop as lost service (street dark or cabinet inactive). */
  function wouldLoseService(state: GameState): number {
    const service = computeService(state);
    return state.sales.accounts
      .filter((a) => !service.litSegments.has(state.city.parcels[a.parcel]!.segment) || !service.activeCabinets.has(a.cabinet))
      .length;
  }

  it('counts everyone cut off beyond a feeder span, not just its own street', () => {
    const { state, spans } = litStreet();
    const unitsOn = (seg: SegmentId) => state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === seg).length;
    expect(unitsOn(H(0, 0))).toBeGreaterThan(0);
    expect(unitsOn(H(2, 0))).toBeGreaterThan(0);
    const before = structuredClone(state);
    const passings = computeService(state).passings;

    const feeder = quoteRemoveSpan(state, spans[0]!);
    expect(feeder).toEqual({ ok: true, reasons: [], refund: 0, subscribersAffected: state.sales.accounts.length, passingsLost: passings });
    const tail = quoteRemoveSpan(state, spans[2]!);
    expect(tail.subscribersAffected).toBe(unitsOn(H(2, 0)));
    // A quote changes nothing.
    expect(state).toEqual(before);

    // And it matches what removing it really does.
    for (const [span, quote] of [[spans[0]!, feeder], [spans[2]!, tail]] as const) {
      const copy = structuredClone(before);
      removeSpan(copy, span);
      expect(wouldLoseService(copy)).toBe(quote.subscribersAffected);
      expect(passings - computeService(copy).passings).toBe(quote.passingsLost);
    }
  });

  it('counts subscribers whose cabinet goes dark with the cable feeding it', () => {
    const state = makeState();
    addSpan(state, H(0, 0));
    const feeder = addSpan(state, H(1, 0));
    addSpan(state, H(2, 0));
    // The cabinet stands at the far end of 2nd span: cut that and the cabinet loses the CO.
    const cabinet = addCabinet(state, 2);
    const parcel = state.city.parcels.find((p) => p.segment === H(0, 0))!;
    state.sales.accounts = [{ parcel: parcel.id, cabinet, tierUnits: { fiber500: 0, fiber1g: 2, fiber2g: 0 }, since: 0, locks: [] }];
    expect(computeService(state).litSegments.has(H(0, 0))).toBe(true);
    expect(quoteRemoveSpan(state, feeder).subscribersAffected).toBe(2);
  });

  it('quotes the permitting refund removeSpan pays, and no service loss for cable not yet live', () => {
    const state = makeState();
    lay(state, [H(0, 0), H(1, 0)], 'underground');
    const span = state.network.spans[0]!;
    const quote = quoteRemoveSpan(state, span.id);
    expect(quote).toEqual({ ok: true, reasons: [], refund: Math.round(span.refundable * PERMITTING_CANCEL_REFUND), subscribersAffected: 0, passingsLost: 0 });
    expect(removeSpan(state, span.id)).toEqual({ ok: true, cost: -quote.refund });
    state.network.spans[0]!.stage = 'constructing';
    expect(quoteRemoveSpan(state, state.network.spans[0]!.id).refund).toBe(0);
  });

  it('names an unknown span', () => {
    const state = makeState();
    expect(quoteRemoveSpan(state, 99)).toEqual({ ok: false, reasons: ['Unknown cable span: 99'], refund: 0, subscribersAffected: 0, passingsLost: 0 });
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
    expect(service.servingCabinet.size).toBe(0);
    expect(service.cabinetCoverage.size).toBe(0);
    expect(sorted(service.connectedSegments)).toEqual([H(0, 0), H(1, 0)]);

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
    expect(sorted(service.litSegments)).toEqual([H(0, 0), H(1, 0)]);
    // 1st St lots: block row 0 top rows, four per segment.
    expect(service.passedParcels).toEqual([0, 2, 4, 6, 8, 10, 12, 14]);
    expect(service.passings).toBe(8);
    expect(service.networkVersion).toBe(state.network.version);
    expect(service.day).toBe(0);
    expect(service.servingDistanceFt).toEqual(
      new Map([
        [H(0, 0), 240],
        [H(1, 0), 0],
      ]),
    );
    expect(service.cabinetCoverage.get(cabinet)).toEqual({ segments: [H(0, 0), H(1, 0)], parcels: 8, passings: 8 });
  });

  it('counts a cabinet standing at the CO node', () => {
    const state = makeState();
    const cabinet = addCabinet(state, state.city.coNode);
    expect([...computeService(state).activeCabinets]).toEqual([cabinet]);
    expect(computeService(state).cabinetCoverage.get(cabinet)).toEqual({ segments: [], parcels: 0, passings: 0 });
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

  it('passes a corner lot only from its own serving street', () => {
    const state = makeState();
    addSpan(state, V(0, 0));
    addCabinet(state, 0);
    const service = computeService(state);
    // A Ave is lit and lots 0 and 1 touch it, but they front 1st St and 2nd St.
    expect([...service.litSegments]).toEqual([V(0, 0)]);
    expect(service.passedParcels).toEqual([]);
    expect(service.passings).toBe(0);
  });

  it('leaves connected cable beyond cabinet reach unlit', () => {
    // 1,800 ft blocks: H(0, 0) touches the cabinet (distance 0 although longer than
    // the reach), H(1, 0) starts 1,800 ft away.
    const state = makeState(makeGridCity({ blockW: 30 }));
    addSpan(state, H(0, 0));
    addSpan(state, H(1, 0));
    const cabinet = addCabinet(state, 0);
    const service = computeService(state);
    expect(sorted(service.connectedSegments)).toEqual([H(0, 0), H(1, 0)]);
    expect([...service.litSegments]).toEqual([H(0, 0)]);
    expect(service.servingDistanceFt.get(H(0, 0))).toBe(0);
    expect(service.passings).toBe(30);
    expect(service.cabinetCoverage.get(cabinet)).toEqual({ segments: [H(0, 0)], parcels: 30, passings: 30 });
  });

  it('is strict at the reach boundary', () => {
    for (const [lengthFt, lit] of [
      [CABINET_REACH_FT, false],
      [CABINET_REACH_FT - 1, true],
    ] as const) {
      const city = makeGridCity();
      city.segments[H(0, 0)] = { ...city.segments[H(0, 0)]!, lengthFt };
      const state = makeState(city);
      addSpan(state, H(0, 0));
      addSpan(state, H(1, 0));
      addCabinet(state, 0);
      const service = computeService(state);
      expect(service.litSegments.has(H(1, 0))).toBe(lit);
      expect(service.servingDistanceFt.get(H(1, 0))).toBe(lit ? lengthFt : undefined);
    }
  });

  it('measures reach along connected cable, not streets', () => {
    // Blocks sized from the reach: 120 ft tall and just wide enough that the
    // cable reaching node 1 the long way round (A Ave, 2nd St, B Ave: 2 x 120
    // ft + wide) is out of reach although 1st St alone (wide) would be in.
    const blockH = 2;
    const blockW = Math.ceil((CABINET_REACH_FT - 2 * blockH * TILE_FT) / TILE_FT);
    const tall = blockH * TILE_FT;
    const wide = blockW * TILE_FT;
    expect(2 * tall + wide).toBeGreaterThanOrEqual(CABINET_REACH_FT);
    expect(tall + wide).toBeLessThan(CABINET_REACH_FT);
    const state = makeState(makeGridCity({ blockW, blockH }));
    for (const id of [V(0, 0), H(0, 1), V(1, 0), H(1, 0)]) addSpan(state, id);
    addCabinet(state, 0);
    const service = computeService(state);
    expect(service.servingDistanceFt.get(V(1, 0))).toBe(tall + wide);
    expect(service.litSegments.has(H(1, 0))).toBe(false);
    // Cabling 1st St brings node 1 within reach.
    addSpan(state, H(0, 0));
    expect(computeService(state).servingDistanceFt.get(H(1, 0))).toBe(wide);
  });

  it('serves each segment from the nearest cabinet, ties to the lower id', () => {
    const state = makeState();
    for (const id of [H(0, 0), H(1, 0), H(2, 0)]) addSpan(state, id);
    // The east cabinet gets the lower id; 2nd block's 1st St is 240 ft from both.
    const east = addCabinet(state, 3);
    const west = addCabinet(state, 0);
    const service = computeService(state);
    expect(service.servingCabinet).toEqual(
      new Map([
        [H(0, 0), west],
        [H(1, 0), east],
        [H(2, 0), east],
      ]),
    );
    expect(service.servingDistanceFt).toEqual(
      new Map([
        [H(0, 0), 0],
        [H(1, 0), 240],
        [H(2, 0), 0],
      ]),
    );
    expect(service.cabinetCoverage.get(west)).toEqual({ segments: [H(0, 0)], parcels: 4, passings: 4 });
    expect(service.cabinetCoverage.get(east)).toEqual({ segments: [H(1, 0), H(2, 0)], parcels: 8, passings: 8 });
    expect([...service.activeCabinets]).toEqual([east, west].sort((a, b) => a - b));
  });

  it('splits passings across cabinets so coverage sums to the total', () => {
    const state = makeState(makeGridCity({ cols: 6, rows: 4, blockW: 8 }));
    // Every street cabled; cabinets at the CO and in the far corner.
    for (const s of state.city.segments) addSpan(state, s.id);
    const a = addCabinet(state, 0);
    const b = addCabinet(state, state.city.nodes.length - 1);
    const service = computeService(state);
    const coverage = [...service.cabinetCoverage.values()];
    expect(coverage.reduce((sum, c) => sum + c.passings, 0)).toBe(service.passings);
    expect(coverage.reduce((sum, c) => sum + c.parcels, 0)).toBe(service.passedParcels.length);
    expect(sorted(coverage.flatMap((c) => c.segments))).toEqual(sorted(service.litSegments));
    expect(service.cabinetCoverage.get(a)!.passings).toBeGreaterThan(0);
    expect(service.cabinetCoverage.get(b)!.passings).toBeGreaterThan(0);
    for (const c of coverage) expect(c.segments).toEqual(sorted(c.segments));
    for (const [segment, distance] of service.servingDistanceFt) {
      expect(distance).toBeLessThan(CABINET_REACH_FT);
      expect(service.litSegments.has(segment)).toBe(true);
    }
  });

  it('unlights downstream segments when a feeder span is removed', () => {
    const state = makeState();
    addCabinet(state, 0);
    const feeder = addSpan(state, H(0, 0));
    addSpan(state, H(1, 0));
    expect(getService(state).passings).toBe(8);
    expect(removeSpan(state, feeder).ok).toBe(true);
    const service = getService(state);
    expect(service.connectedSegments.size).toBe(0);
    expect(service.litSegments.size).toBe(0);
    expect(service.passings).toBe(0);
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

  it('takes a poled detour up to AERIAL_DETOUR_MAX_RATIO x the shortest route', () => {
    // 0 -> 1: 1st St (240 ft, no poles) or round the block via A Ave, 2nd St, B Ave.
    const city = unpoled(H(0, 0));
    const atCap = ((AERIAL_DETOUR_MAX_RATIO - 1) * 240) / 2;
    city.segments[V(0, 0)] = { ...city.segments[V(0, 0)]!, lengthFt: atCap };
    city.segments[V(1, 0)] = { ...city.segments[V(1, 0)]!, lengthFt: atCap };
    const state = makeState(city);
    expect(cableRoute(state, 0, 1, 'aerial')).toEqual([V(0, 0), H(0, 1), V(1, 0)]);
  });

  it('takes the shortest route over a longer detour, and its quote names the street without poles', () => {
    // The default detour is 480 ft against 240 ft: twice the shortest route.
    const state = makeState(unpoled(H(0, 0)));
    expect(480 / 240).toBeGreaterThan(AERIAL_DETOUR_MAX_RATIO);
    const route = cableRoute(state, 0, 1, 'aerial');
    expect(route).toEqual([H(0, 0)]);
    expect(quoteCable(state, route!, 'aerial').reasons).toEqual(['No poles on 1st St - lay underground instead']);
    // Just over the cap also takes the shortest route.
    const city = unpoled(H(0, 0));
    const overCap = ((AERIAL_DETOUR_MAX_RATIO - 1) * 240) / 2 + 1;
    city.segments[V(0, 0)] = { ...city.segments[V(0, 0)]!, lengthFt: overCap };
    city.segments[V(1, 0)] = { ...city.segments[V(1, 0)]!, lengthFt: overCap };
    expect(cableRoute(makeState(city), 0, 1, 'aerial')).toEqual([H(0, 0)]);
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
    expect(cableRoute(state, 0, 0, 'aerial')).toEqual([]);
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

// ---------------------------------------------------------------------------
// Round 4: outages and underground rebuilds
// ---------------------------------------------------------------------------

/** Put an outage on the span on `segment` (as a storm would) and bump the version. */
function knockOut(state: GameState, segment: SegmentId, daysLeft = 3): void {
  const span = spanOnSegment(state, segment)!;
  span.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft, repairCost: 0 };
  state.network.version++;
}

describe('interrupted segments', () => {
  /** 1st St cabled from the CO (node 0) to node 3, a cabinet at the CO. */
  function firstStreet(): GameState {
    const state = makeState();
    for (const id of [H(0, 0), H(1, 0), H(2, 0)]) addSpan(state, id);
    addCabinet(state, 0);
    return state;
  }

  it('cuts off everything beyond an out feeder, while it stays lit and passed', () => {
    const state = firstStreet();
    const before = computeService(state);
    expect(before.interruptedSegments.size).toBe(0);
    knockOut(state, H(0, 0));
    const after = computeService(state);
    expect(sorted(after.interruptedSegments)).toEqual([H(0, 0), H(1, 0), H(2, 0)]);
    // Scorecards ignore outages: the same streets lit, the same homes passed, the same serving cabinets.
    expect(sorted(after.litSegments)).toEqual(sorted(before.litSegments));
    expect(after.passedParcels).toEqual(before.passedParcels);
    expect(after.passings).toBe(before.passings);
    expect(after.servingCabinet).toEqual(before.servingCabinet);
    expect(sorted(after.connectedSegments)).toEqual(sorted(before.connectedSegments));
  });

  it('cuts off only its own street when an out leaf feeds nothing', () => {
    const state = firstStreet();
    knockOut(state, H(2, 0));
    expect(sorted(computeService(state).interruptedSegments)).toEqual([H(2, 0)]);
  });

  it('keeps streets with another live path lit', () => {
    // The first block's loop: 1st St, B Ave, 2nd St, A Ave.
    const state = makeState();
    for (const id of [H(0, 0), V(1, 0), H(0, 1), V(0, 0)]) addSpan(state, id);
    addCabinet(state, 0);
    knockOut(state, H(0, 0));
    expect(sorted(computeService(state).interruptedSegments)).toEqual([H(0, 0)]);
  });

  it('cuts off what a cabinet serves when the outage cuts the cabinet off from the CO', () => {
    const state = makeState();
    for (const id of [H(0, 0), H(1, 0), H(2, 0)]) addSpan(state, id);
    addCabinet(state, 3);
    knockOut(state, H(0, 0));
    const service = computeService(state);
    expect(sorted(service.interruptedSegments)).toEqual(sorted(service.litSegments));
    expect(service.litSegments.size).toBe(3);
  });

  it('is memoized with the snapshot, follows the network version, and matches a fresh computation', () => {
    const state = firstStreet();
    const clear = getService(state);
    expect(clear.interruptedSegments.size).toBe(0);
    knockOut(state, H(1, 0));
    const out = getService(state);
    expect(out).not.toBe(clear);
    expect(sorted(out.interruptedSegments)).toEqual([H(1, 0), H(2, 0)]);
    expect(getService(state)).toBe(out);
    // A new day on the same network keeps the outage.
    state.day++;
    expect(sorted(getService(state).interruptedSegments)).toEqual([H(1, 0), H(2, 0)]);
    expect(sorted(computeService(state).interruptedSegments)).toEqual([H(1, 0), H(2, 0)]);
    // Repaired: gone with the next version.
    spanOnSegment(state, H(1, 0))!.outage = null;
    state.network.version++;
    expect(getService(state).interruptedSegments.size).toBe(0);
  });
});

describe('outageImpact', () => {
  it('names what one outage cuts off and its subscribers, and nothing for a span in service', () => {
    const state = makeState();
    for (const id of [H(0, 0), H(1, 0), H(2, 0)]) addSpan(state, id);
    const cabinet = addCabinet(state, 0);
    // A subscriber on the middle block of 1st St (lots 8.. front H(1, 0)).
    const parcel = state.city.parcels.find((p) => p.segment === H(1, 0))!.id;
    state.sales.accounts = [{ parcel, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] }];
    const feeder = spanOnSegment(state, H(0, 0))!;
    const leaf = spanOnSegment(state, H(2, 0))!;
    expect(outageImpact(state, feeder.id)).toEqual({ segments: [], subscribers: 0 });
    knockOut(state, H(0, 0));
    expect(outageImpact(state, feeder.id)).toEqual({ segments: [H(0, 0), H(1, 0), H(2, 0)], subscribers: 1 });
    // With the leaf out too, the feeder's repair alone brings back all but the leaf.
    knockOut(state, H(2, 0));
    expect(outageImpact(state, feeder.id)).toEqual({ segments: [H(0, 0), H(1, 0)], subscribers: 1 });
    expect(outageImpact(state, leaf.id)).toEqual({ segments: [], subscribers: 0 });
    expect(outageImpact(state, 999)).toEqual({ segments: [], subscribers: 0 });
  });
});

describe('quoteConvert', () => {
  it('quotes the underground bore, rock, engineering and the city permit for a live aerial span, no make-ready', () => {
    const state = makeState(makeGridCity({ rock: true }));
    const span = addSpan(state, H(0, 0));
    const street = seg(state, H(0, 0));
    const quote = quoteConvert(state, span);
    const ug = spanCharges(street, 'underground');
    expect(quote.ok).toBe(true);
    expect(quote.reasons).toEqual([]);
    expect(quote.span).toBe(span);
    expect(quote.lines.map((l) => l.kind)).toEqual(['cable', 'rock', 'engineering', 'permit']);
    expect(quote.lines.every((l) => !l.refundable)).toBe(true);
    expect(quote.lines[0]).toMatchObject({ quantity: street.lengthFt, unit: 'ft', rate: UNDERGROUND_COST_PER_FT, amount: ug.construction });
    expect(quote.lines[1]).toMatchObject({ quantity: street.lengthFt, rate: UNDERGROUND_ROCK_SURCHARGE_PER_FT, amount: ug.rock });
    expect(quote.cost).toBe(ug.total + ENGINEERING_FEE + PERMIT_FEE_UNDERGROUND);
    expect(quote.lines.reduce((sum, l) => sum + l.amount, 0)).toBe(quote.cost);
    expect([quote.permitDaysMin, quote.permitDaysMax]).toEqual([PERMIT_DAYS_MIN, PERMIT_DAYS_MAX]);
    expect(quote.constructDays).toBe(Math.max(1, Math.ceil(street.lengthFt / UNDERGROUND_FT_PER_DAY)));
    expect(quote.poleRentSaved).toBe(polesOnSegment(street) * POLE_RENT_PER_POLE_PER_MONTH);
    expect(quote.poleRentSaved).toBeGreaterThan(0);
    const avoided = stormRisk(state, street, 'aerial').repairCostPerYear - stormRisk(state, street, 'underground').repairCostPerYear;
    expect(quote.repairsAvoidedPerYear).toBe(Math.round(avoided));
    expect(quote.repairsAvoidedPerYear).toBeGreaterThan(0);
    // No rock under the street: no rock line.
    const soil = makeState();
    expect(quoteConvert(soil, addSpan(soil, H(0, 0))).lines.map((l) => l.kind)).toEqual(['cable', 'engineering', 'permit']);
  });

  it('is allowed while the span is out of service', () => {
    const state = makeState();
    const span = addSpan(state, H(0, 0));
    knockOut(state, H(0, 0));
    expect(quoteConvert(state, span).ok).toBe(true);
  });

  it('pins the permit days to a remembered underground draw for the segment', () => {
    const state = makeState();
    const span = addSpan(state, H(0, 0));
    state.network.makeReady = [{ segment: H(0, 0), method: 'underground', days: 20, drawnDay: 0 }];
    expect(quoteConvert(state, span)).toMatchObject({ permitDaysMin: 20, permitDaysMax: 20 });
    // An aerial memo for the segment is not an underground permit.
    state.network.makeReady = [{ segment: H(0, 0), method: 'aerial', days: 99, drawnDay: 0 }];
    expect(quoteConvert(state, span)).toMatchObject({ permitDaysMin: PERMIT_DAYS_MIN, permitDaysMax: PERMIT_DAYS_MAX });
  });

  it('names what blocks it, structural reasons before cash, and never throws for junk', () => {
    const state = makeState();
    const building = addSpan(state, H(0, 0), 'constructing');
    const underground = addSpan(state, H(1, 0));
    spanOnSegment(state, H(1, 0))!.method = 'underground';
    const converting = addSpan(state, H(2, 0));
    spanOnSegment(state, H(2, 0))!.conversion = { stage: 'permitting', stageDaysLeft: 5, constructDays: 1, cost: 0, orderedDay: 0 };
    const fine = addSpan(state, H(0, 1));
    expect(quoteConvert(state, 999).reasons).toEqual(['Unknown cable span: 999']);
    expect(quoteConvert(state, building).reasons).toEqual(['The cable on 1st St is still being built: rebuild it underground once it is live']);
    expect(quoteConvert(state, underground).reasons).toEqual(['The cable on 1st St is already underground']);
    expect(quoteConvert(state, converting).reasons).toEqual(['The cable on 1st St is already being rebuilt underground']);
    state.finance.cash = 10;
    const broke = quoteConvert(state, fine);
    expect(broke.ok).toBe(false);
    expect(broke.reasons).toEqual([`Not enough cash: need ${formatMoney(broke.cost)}, have ${formatMoney(10)}`]);
    expect(quoteConvert(state, underground).reasons).toHaveLength(1);
    for (const junk of [Number.NaN, -1, 1.5, 'x', null, undefined, {}]) {
      expect(quoteConvert(state, junk as never).ok).toBe(false);
    }
  });
});

describe('convertSpan', () => {
  it('pays for the rebuild, draws its permit from the events stream and remembers the draw', () => {
    const state = makeState();
    const span = addSpan(state, H(0, 0));
    const target = spanOnSegment(state, H(0, 0))!;
    target.cost = 5_000;
    const quote = quoteConvert(state, span);
    const version = state.network.version;
    const rng = new Rng(77);
    const result = convertSpan(state, span, rng);
    expect(result).toEqual({ ok: true, cost: quote.cost });
    const days = refDraw(new Rng(77), 'underground');
    expect(rng.state).not.toBe(new Rng(77).state);
    expect(target.conversion).toEqual({ stage: 'permitting', stageDaysLeft: days, constructDays: quote.constructDays, cost: quote.cost, orderedDay: 0 });
    expect(target.method).toBe('aerial');
    expect(target.stage).toBe('live');
    expect(target.cost).toBe(5_000 + quote.cost);
    expect(state.finance.cash).toBe(START_CASH - quote.cost);
    expect(state.finance.capex.osp).toBe(quote.cost);
    expect(state.finance.monthToDate).toEqual([
      { day: 0, category: 'construction', amount: -quote.cost, memo: `Underground rebuild: 1st St (${seg(state, H(0, 0)).lengthFt} ft)` },
    ]);
    expect(state.network.makeReady).toEqual([{ segment: H(0, 0), method: 'underground', days, drawnDay: 0 }]);
    expect(rememberedPermitDays(state, H(0, 0), 'underground')).toBe(days);
    expect(state.network.version).toBeGreaterThan(version);
  });

  it('reuses a remembered underground draw without touching the rng', () => {
    const state = makeState();
    const span = addSpan(state, H(0, 0));
    state.day = 10;
    state.network.makeReady = [{ segment: H(0, 0), method: 'underground', days: 21, drawnDay: 5 }];
    const rng = new Rng(77);
    expect(convertSpan(state, span, rng).ok).toBe(true);
    expect(rng.state).toBe(new Rng(77).state);
    expect(spanOnSegment(state, H(0, 0))!.conversion?.stageDaysLeft).toBe(21);
    expect(state.network.makeReady).toEqual([{ segment: H(0, 0), method: 'underground', days: 21, drawnDay: 5 }]);
  });

  it('rejects with the first reason and changes nothing, the rng included', () => {
    const state = makeState();
    const span = addSpan(state, H(0, 0), 'constructing');
    expectRejected(state, (s) => convertSpan(s, span, new Rng(1)), 'The cable on 1st St is still being built: rebuild it underground once it is live');
    const live = addSpan(state, H(1, 0));
    state.finance.cash = 1;
    expectRejected(state, (s) => convertSpan(s, live, new Rng(1)), /^Not enough cash/);
    expectRejected(state, (s) => convertSpan(s, 12345, new Rng(1)), 'Unknown cable span: 12345');
    const rng = new Rng(9);
    convertSpan(state, live, rng);
    expect(rng.state).toBe(new Rng(9).state);
  });

  it('goes through permitting and construction, then the span is underground: pole rent stops, the outage is cleared', () => {
    const state = makeState();
    const span = addSpan(state, H(0, 0));
    const target = spanOnSegment(state, H(0, 0))!;
    const rentBefore = monthlyPoleRent(state);
    expect(rentBefore).toBe(polesOnSegment(seg(state, H(0, 0))) * POLE_RENT_PER_POLE_PER_MONTH);
    expect(convertSpan(state, span, new Rng(3)).ok).toBe(true);
    const conversion = target.conversion!;
    const permit = conversion.stageDaysLeft;
    // Storm damage during the rebuild does not hold it up.
    knockOut(state, H(0, 0), 10_000);

    for (let d = 1; d < permit; d++) {
      const version = state.network.version;
      tick(state);
      expect(target.conversion?.stage).toBe('permitting');
      expect(state.network.version).toBe(version);
    }
    let version = state.network.version;
    tick(state);
    expect(target.conversion).toMatchObject({ stage: 'constructing', stageDaysLeft: conversion.constructDays });
    expect(state.network.version).toBeGreaterThan(version);
    // The aerial cable serves (and pays pole rent) until the rebuild is live.
    expect(target.method).toBe('aerial');
    expect(monthlyPoleRent(state)).toBe(rentBefore);
    for (let d = 1; d < conversion.constructDays; d++) tick(state);
    expect(target.conversion?.stage).toBe('constructing');
    version = state.network.version;
    tick(state);
    expect(target.method).toBe('underground');
    expect(target.conversion).toBeNull();
    expect(target.outage).toBeNull();
    expect(target.stage).toBe('live');
    expect(state.network.version).toBeGreaterThan(version);
    expect(monthlyPoleRent(state)).toBe(0);
    // It is an underground span now: nothing more to convert.
    expect(quoteConvert(state, span).reasons).toEqual(['The cable on 1st St is already underground']);
  });

  it('moves a stage left at 0 days on the next day (a hand-edited save)', () => {
    const state = makeState();
    addSpan(state, H(0, 0));
    const target = spanOnSegment(state, H(0, 0))!;
    target.conversion = { stage: 'permitting', stageDaysLeft: 0, constructDays: 2, cost: 0, orderedDay: 0 };
    tick(state);
    expect(target.conversion).toMatchObject({ stage: 'constructing', stageDaysLeft: 2 });
    target.conversion!.stageDaysLeft = 0;
    tick(state);
    expect(target.method).toBe('underground');
  });

  it('works through applyCommand on the events stream, and removeSpan takes a converting span away whole with no refund', () => {
    const state = makeState();
    const span = addSpan(state, H(0, 0));
    const events = state.rng.events;
    const sales = state.rng.sales;
    const result = applyCommand(state, { type: 'convertSpan', span });
    expect(result.ok).toBe(true);
    expect(state.rng.events).not.toBe(events);
    expect(state.rng.sales).toBe(sales);
    const cash = state.finance.cash;
    expect(quoteRemoveSpan(state, span).refund).toBe(0);
    expect(removeSpan(state, span)).toEqual({ ok: true, cost: 0 });
    expect(state.network.spans).toEqual([]);
    expect(state.finance.cash).toBe(cash);
  });
});

describe('cable quotes: storm risk (round 4b)', () => {
  it('sums weather.stormRisk over the new segments and names the most exposed band', () => {
    const state = makeTestState(makeGridCity());
    const segments = [0, 1];
    for (const method of ['aerial', 'underground'] as const) {
      const quote = quoteCable(state, segments, method);
      const risk = quote.stormRisk;
      expect(risk).not.toBeNull();
      let repairs = 0;
      let outages = 0;
      let days = 0;
      let exposedFt = 0;
      for (const id of quote.newSegments) {
        const segment = state.city.segments[id]!;
        const r = stormRisk(state, segment, method);
        repairs += r.repairCostPerYear;
        outages += r.outagesPerYear;
        days += r.outageDaysPerYear;
        if (exposureBand(segmentExposure(state.city, id)) === 'exposed') exposedFt += segment.lengthFt;
      }
      expect(risk).toMatchObject({ method, exposedFt });
      expect(risk!.repairCostPerYear).toBeCloseTo(repairs, 6);
      expect(risk!.outagesPerYear).toBeCloseTo(outages, 9);
      expect(risk!.outageDaysPerYear).toBeCloseTo(days, 9);
      expect(cableStormRisk(state, quote.newSegments, method)).toEqual(risk);
    }
    expect(quoteCable(state, [], 'aerial').stormRisk).toBeNull();
  });

  it('a rebuild quote names the street\'s exposure band', () => {
    const state = makeTestState(makeGridCity());
    addLivePlant(state, { segments: [0] });
    const span = state.network.spans[0]!;
    span.method = 'aerial';
    expect(quoteConvert(state, span.id).exposure).toBe(exposureBand(segmentExposure(state.city, span.segment)));
  });
});

describe('cable quotes: storm exposure (round 4b, storms-balance)', () => {
  /** The default grid with every street in `zone`, moved `inland` cells in from every map edge. */
  function zonedState(zone: 'rural' | 'downtown', inland: number): GameState {
    const city = makeGridCity();
    for (const segment of city.segments) segment.zone = zone;
    for (const node of city.nodes) {
      node.x += inland;
      node.y += inland;
    }
    for (const parcel of city.parcels) {
      parcel.x += inland;
      parcel.y += inland;
    }
    city.width += 2 * inland;
    city.height += 2 * inland;
    return makeTestState(city);
  }

  it('names an exposed rural run exposed, with its feet, and a sheltered downtown run sheltered', () => {
    const rural = zonedState('rural', 0);
    const exposed = quoteCable(rural, [0, 1, 2], 'aerial').stormRisk!;
    expect(exposed.band).toBe('exposed');
    expect(exposed.exposedFt).toBe([0, 1, 2].reduce((ft, id) => ft + rural.city.segments[id]!.lengthFt, 0));
    const downtown = zonedState('downtown', 40);
    const sheltered = quoteCable(downtown, [0, 1, 2], 'aerial').stormRisk!;
    expect(sheltered.band).toBe('sheltered');
    expect(sheltered.exposedFt).toBe(0);
  });

  it('expects more storm repairs a year on exposed aerial plant than on the same run sheltered, and burying it saves more there', () => {
    const rural = zonedState('rural', 0);
    const downtown = zonedState('rural', 0);
    for (const segment of downtown.city.segments) segment.zone = 'downtown';
    const risk = (state: GameState) => quoteCable(state, [0, 1, 2], 'aerial').stormRisk!.repairCostPerYear;
    expect(risk(rural)).toBeGreaterThan(1.5 * risk(downtown));
    for (const state of [rural, downtown]) {
      addLivePlant(state, { segments: [0] });
      state.network.spans[0]!.method = 'aerial';
    }
    expect(quoteConvert(rural, rural.network.spans[0]!.id).repairsAvoidedPerYear).toBeGreaterThan(
      quoteConvert(downtown, downtown.network.spans[0]!.id).repairsAvoidedPerYear,
    );
    expect(quoteConvert(rural, rural.network.spans[0]!.id).exposure).toBe('exposed');
    expect(quoteConvert(downtown, downtown.network.spans[0]!.id).exposure).not.toBe('exposed');
  });
});
