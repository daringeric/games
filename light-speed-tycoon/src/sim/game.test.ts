import { describe, expect, it } from 'vitest';
import {
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_PERMIT_DAYS,
  OLT_START_PON_PORTS,
  PERMIT_DAYS_MAX,
  PERMIT_DAYS_MIN,
  POLE_RENT_PER_POLE_PER_MONTH,
  SPLITTER_COST,
  START_CASH,
} from './balance';
import { dayOf, MONTH_LENGTHS } from './calendar';
import { generateCity } from './citygen';
import { applyCommand, newGame, runDays, tick } from './game';
import { getService, layCable } from './network';
import { deriveSeed, Rng } from './rng';
import { makeGridCity } from './testing/fixtures';
import type { City, Command, GameState, MonthlyReport } from './types';

// Default grid: 3x2 blocks of 4x2 cells, CO at node 0. Horizontal segments
// 0..8 are 240 ft with four homes fronting each of 0..5 from below or above;
// vertical segments 9..16 are 120 ft with no frontage.
const CABINET_PRICE = CABINET_COST + SPLITTER_COST;

function game(city: City = makeGridCity()): GameState {
  return newGame(42, { city });
}

/** Game day on which a report's month was closed (the 1st of the next month). */
function closedOn(report: MonthlyReport): number {
  return dayOf({ year: report.year, month: report.month, day: 1 }) + (MONTH_LENGTHS[report.month - 1] as number);
}

describe('newGame', () => {
  it('starts a fresh game on the given city', () => {
    const city = makeGridCity();
    const state = newGame(42, { city });
    expect(state).toEqual({
      schemaVersion: 1,
      seed: 42,
      day: 0,
      rng: { events: deriveSeed(42, 'events') },
      nextId: 1,
      city,
      network: { spans: [], cabinets: [], olt: { ponPorts: OLT_START_PON_PORTS, tech: 'gpon' }, version: 0 },
      finance: { cash: START_CASH, monthToDate: [], reports: [] },
    });
    expect(state.city).toBe(city);
  });

  it('stores the seed as a uint32 without changing the derived streams', () => {
    const city = makeGridCity();
    const state = newGame(-1, { city });
    expect(state.seed).toBe(0xffffffff);
    expect(state.rng.events).toBe(deriveSeed(-1, 'events'));
    expect(state).toEqual(newGame(0xffffffff, { city }));
  });

  it('gives each seed its own event stream', () => {
    expect(game().rng.events).not.toBe(newGame(43, { city: makeGridCity() }).rng.events);
  });

  it('never shares mutable state between games', () => {
    const city = makeGridCity();
    const a = newGame(1, { city });
    const b = newGame(1, { city });
    applyCommand(a, { type: 'placeCabinet', node: 0 });
    runDays(a, 31);
    expect(b).toEqual(newGame(1, { city }));
  });

  it('generates the city from the seed when none is given', () => {
    expect(newGame(42).city).toEqual(generateCity(deriveSeed(42, 'citygen')));
    const cityOptions = { width: 48, height: 32 };
    expect(newGame(42, { cityOptions }).city).toEqual(generateCity(deriveSeed(42, 'citygen'), cityOptions));
  });
});

describe('applyCommand', () => {
  it('lays aerial cable with a make-ready draw from the events stream', () => {
    const state = game();
    const twin = structuredClone(state);
    const rng = new Rng(state.rng.events);

    expect(applyCommand(state, { type: 'layCable', segments: [0, 9], method: 'aerial' })).toEqual({ ok: true, cost: 3_600 });
    // Same outcome as calling network.layCable with the stored stream, which is then advanced.
    expect(layCable(twin, [0, 9], 'aerial', rng)).toEqual({ ok: true, cost: 3_600 });
    expect(state.network).toEqual(twin.network);
    expect(state.rng.events).toBe(rng.state);
    expect(state.rng.events).not.toBe(twin.rng.events);

    expect(state.network.spans.map((s) => [s.id, s.segment, s.stage, s.orderedDay])).toEqual([
      [1, 0, 'permitting', 0],
      [2, 9, 'permitting', 0],
    ]);
    expect(state.nextId).toBe(3);
    expect(state.finance.cash).toBe(START_CASH - 3_600);
    expect(state.finance.monthToDate).toMatchObject([{ day: 0, category: 'construction', amount: -3_600 }]);
  });

  it('lays underground cable', () => {
    const state = game();
    const before = state.rng.events;
    expect(applyCommand(state, { type: 'layCable', segments: [0, 9], method: 'underground' })).toEqual({ ok: true, cost: 10_800 });
    expect(state.rng.events).not.toBe(before);
    const permitDays = state.network.spans[0]?.stageDaysLeft;
    expect(permitDays).toBeGreaterThanOrEqual(PERMIT_DAYS_MIN);
    expect(permitDays).toBeLessThanOrEqual(PERMIT_DAYS_MAX);
  });

  it('places a cabinet without touching the events stream', () => {
    const state = game();
    const before = state.rng.events;
    expect(applyCommand(state, { type: 'placeCabinet', node: 0 })).toEqual({ ok: true, cost: CABINET_PRICE });
    expect(state.network.cabinets).toMatchObject([{ id: 1, node: 0, stage: 'permitting', stageDaysLeft: CABINET_PERMIT_DAYS }]);
    expect(state.finance.cash).toBe(START_CASH - CABINET_PRICE);
    expect(state.rng.events).toBe(before);
  });

  it('refunds a span cancelled during permitting', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    const version = state.network.version;
    expect(applyCommand(state, { type: 'removeSpan', span: 1 })).toEqual({ ok: true, cost: -7_200 });
    expect(state.network.spans).toEqual([]);
    expect(state.network.version).toBeGreaterThan(version);
    expect(state.finance.cash).toBe(START_CASH);
  });

  it('removes a live span without a refund', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    runDays(state, PERMIT_DAYS_MAX + 1);
    expect(state.network.spans[0]?.stage).toBe('live');
    expect(applyCommand(state, { type: 'removeSpan', span: 1 })).toEqual({ ok: true, cost: 0 });
    expect(state.network.spans).toEqual([]);
    expect(state.finance.cash).toBe(START_CASH - 7_200);
  });

  it('stamps orders with the current day', () => {
    const state = game();
    runDays(state, 10);
    applyCommand(state, { type: 'layCable', segments: [0], method: 'aerial' });
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    expect(state.network.spans[0]?.orderedDay).toBe(10);
    expect(state.network.cabinets[0]?.orderedDay).toBe(10);
  });
});

interface RejectCase {
  name: string;
  cmd: unknown;
  reason: RegExp;
  city?: City;
  setup?: (state: GameState) => void;
}

const REJECTIONS: RejectCase[] = [
  // Malformed commands
  { name: 'null', cmd: null, reason: /must be an object/ },
  { name: 'undefined', cmd: undefined, reason: /must be an object/ },
  { name: 'a string', cmd: 'layCable', reason: /must be an object/ },
  { name: 'a number', cmd: 42, reason: /must be an object/ },
  { name: 'an array', cmd: [{ type: 'placeCabinet', node: 0 }], reason: /must be an object/ },
  { name: 'a missing type', cmd: {}, reason: /Unknown command: missing type/ },
  { name: 'an unknown type', cmd: { type: 'buildTower' }, reason: /Unknown command: "buildTower"/ },
  { name: 'a non-string type', cmd: { type: 7 }, reason: /Unknown command: number/ },
  { name: 'layCable without segments', cmd: { type: 'layCable', method: 'aerial' }, reason: /needs a list of street segments/ },
  { name: 'layCable with a string for segments', cmd: { type: 'layCable', segments: '0', method: 'aerial' }, reason: /needs a list of street segments/ },
  { name: 'layCable with an object for segments', cmd: { type: 'layCable', segments: { 0: 1 }, method: 'aerial' }, reason: /needs a list of street segments/ },
  { name: 'layCable with a string segment id', cmd: { type: 'layCable', segments: [0, '1'], method: 'aerial' }, reason: /segments must be numbers/ },
  { name: 'layCable with a null segment id', cmd: { type: 'layCable', segments: [null], method: 'aerial' }, reason: /segments must be numbers/ },
  { name: 'layCable without a method', cmd: { type: 'layCable', segments: [0] }, reason: /needs a cable method/ },
  { name: 'layCable with a numeric method', cmd: { type: 'layCable', segments: [0], method: 1 }, reason: /needs a cable method/ },
  { name: 'layCable with an unknown method', cmd: { type: 'layCable', segments: [0], method: 'laser' }, reason: /Unknown cable method: laser/ },
  { name: 'placeCabinet without a node', cmd: { type: 'placeCabinet' }, reason: /needs a street corner/ },
  { name: 'placeCabinet with a string node', cmd: { type: 'placeCabinet', node: '0' }, reason: /needs a street corner/ },
  { name: 'removeSpan without a span', cmd: { type: 'removeSpan' }, reason: /needs a cable span id/ },
  { name: 'removeSpan with a string span', cmd: { type: 'removeSpan', span: '1' }, reason: /needs a cable span id/ },
  // Well-formed commands the rules refuse
  { name: 'an unknown segment', cmd: { type: 'layCable', segments: [99], method: 'aerial' }, reason: /Unknown street segment: 99/ },
  { name: 'a negative segment', cmd: { type: 'layCable', segments: [-1], method: 'aerial' }, reason: /Unknown street segment: -1/ },
  { name: 'a fractional segment', cmd: { type: 'layCable', segments: [1.5], method: 'aerial' }, reason: /Unknown street segment: 1\.5/ },
  { name: 'a NaN segment', cmd: { type: 'layCable', segments: [Number.NaN], method: 'underground' }, reason: /Unknown street segment: NaN/ },
  { name: 'an empty order', cmd: { type: 'layCable', segments: [], method: 'aerial' }, reason: /No street segments selected/ },
  {
    name: 'an order with nothing new',
    cmd: { type: 'layCable', segments: [0], method: 'underground' },
    reason: /already has cable/,
    setup: (s) => void applyCommand(s, { type: 'layCable', segments: [0], method: 'aerial' }),
  },
  {
    name: 'aerial cable without poles',
    cmd: { type: 'layCable', segments: [0], method: 'aerial' },
    reason: /No poles on 1st St/,
    city: makeGridCity({ hasPoles: false }),
  },
  {
    name: 'cable the player cannot afford',
    cmd: { type: 'layCable', segments: [0], method: 'underground' },
    reason: /Not enough cash/,
    setup: (s) => void (s.finance.cash = 100),
  },
  { name: 'a cabinet on an unknown corner', cmd: { type: 'placeCabinet', node: 99 }, reason: /Unknown street corner: 99/ },
  {
    name: 'a second cabinet on one corner',
    cmd: { type: 'placeCabinet', node: 0 },
    reason: /already a cabinet/,
    setup: (s) => void applyCommand(s, { type: 'placeCabinet', node: 0 }),
  },
  {
    name: 'a cabinet with no free PON port',
    cmd: { type: 'placeCabinet', node: 1 },
    reason: /No free PON ports/,
    setup: (s) => void (s.network.olt.ponPorts = 0),
  },
  {
    name: 'a cabinet the player cannot afford',
    cmd: { type: 'placeCabinet', node: 1 },
    reason: /Not enough cash/,
    setup: (s) => void (s.finance.cash = CABINET_PRICE - 1),
  },
  { name: 'an unknown span', cmd: { type: 'removeSpan', span: 99 }, reason: /Unknown cable span: 99/ },
  {
    name: 'removing a cabinet id as a span',
    cmd: { type: 'removeSpan', span: 1 },
    reason: /Unknown cable span: 1/,
    setup: (s) => void applyCommand(s, { type: 'placeCabinet', node: 0 }),
  },
];

describe('applyCommand rejections', () => {
  it.each(REJECTIONS)('rejects $name and leaves the game untouched', ({ cmd, reason, city, setup }) => {
    const state = game(city);
    setup?.(state);
    const before = structuredClone(state);
    const result = applyCommand(state, cmd as Command);
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.reason).toMatch(reason);
    expect(state).toEqual(before);
  });
});

describe('tick and runDays', () => {
  it('advances one day at a time', () => {
    const state = game();
    tick(state);
    expect(state.day).toBe(1);
    runDays(state, 9);
    expect(state.day).toBe(10);
    runDays(state, 0);
    expect(state.day).toBe(10);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects a day count of %d', (days) => {
    const state = game();
    expect(() => runDays(state, days)).toThrow(RangeError);
    expect(state.day).toBe(0);
  });

  it('takes an order through permitting and construction to live service', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    const span = state.network.spans[0]!;
    const cabinet = state.network.cabinets[0]!;
    const permitDays = span.stageDaysLeft;
    const constructDays = span.constructDays;
    expect(constructDays).toBe(1); // 240 ft at 300 ft/day

    runDays(state, permitDays - 1);
    expect(span).toMatchObject({ stage: 'permitting', stageDaysLeft: 1, liveDay: null });

    let version = state.network.version;
    tick(state);
    expect(span).toMatchObject({ stage: 'constructing', stageDaysLeft: constructDays, liveDay: null });
    expect(state.network.version).toBeGreaterThan(version);
    expect(getService(state).passings).toBe(0);

    version = state.network.version;
    runDays(state, constructDays);
    const liveDay = permitDays + constructDays;
    expect(state.day).toBe(liveDay);
    expect(span).toMatchObject({ stage: 'live', stageDaysLeft: 0, liveDay });
    expect(state.network.version).toBeGreaterThan(version);
    // Underground permits take at least 14 days, so the cabinet (15 days) is already up.
    expect(cabinet).toMatchObject({ stage: 'live', liveDay: CABINET_PERMIT_DAYS + CABINET_CONSTRUCT_DAYS });
    expect(getService(state).passings).toBe(4);

    // Live assets stay put.
    version = state.network.version;
    runDays(state, 10);
    expect(span).toMatchObject({ stage: 'live', liveDay });
    expect(state.network.version).toBe(version);
  });

  it('closes January on day 31 with a report', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    runDays(state, 30);
    expect(state.finance.reports).toEqual([]);
    expect(state.finance.monthToDate).toHaveLength(2);

    tick(state);
    expect(state.day).toBe(31);
    expect(state.finance.reports).toEqual([
      {
        year: 2027,
        month: 1,
        totals: { construction: -7_200, equipment: -CABINET_PRICE },
        net: -7_200 - CABINET_PRICE,
        cashEnd: START_CASH - 7_200 - CABINET_PRICE,
        passings: getService(state).passings,
      },
    ]);
    expect(state.finance.cash).toBe(START_CASH - 7_200 - CABINET_PRICE);
    expect(state.finance.monthToDate).toEqual([]);
  });

  it('closes every month of the year in order', () => {
    const state = game();
    runDays(state, 365);
    expect(state.finance.reports.map((r) => [r.year, r.month])).toEqual(
      Array.from({ length: 12 }, (_, i) => [2027, i + 1]),
    );
    expect(state.finance.reports.map(closedOn)).toEqual([31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]);
    runDays(state, 31);
    expect(state.finance.reports.at(-1)).toMatchObject({ year: 2028, month: 1, net: 0, cashEnd: START_CASH });
  });

  it('charges pole rent for live aerial spans only', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    applyCommand(state, { type: 'layCable', segments: [0], method: 'aerial' });
    // Underground on a poled street never pays pole rent.
    applyCommand(state, { type: 'layCable', segments: [9], method: 'underground' });
    const aerial = state.network.spans[0]!;
    while (aerial.stage !== 'live') tick(state);
    runDays(state, 31);

    const liveDay = aerial.liveDay!;
    // 240 ft at one pole per 150 ft = 2 poles.
    const rent = -2 * POLE_RENT_PER_POLE_PER_MONTH;
    const rented = state.finance.reports.filter((r) => closedOn(r) >= liveDay);
    expect(rented.length).toBeGreaterThan(0);
    for (const report of state.finance.reports) {
      expect(report.totals.poleRent).toBe(closedOn(report) >= liveDay ? rent : undefined);
    }
  });

  it('records passings at each month close', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    // Segments 0 and 1 run east from the CO with four homes fronting each.
    applyCommand(state, { type: 'layCable', segments: [0, 1], method: 'underground' });
    runDays(state, 120);

    const lit = Math.max(
      ...state.network.spans.map((s) => s.liveDay!),
      state.network.cabinets[0]!.liveDay!,
    );
    expect(state.finance.reports).toHaveLength(4); // day 120 is May 1
    for (const report of state.finance.reports) {
      expect(report.passings).toBe(closedOn(report) >= lit ? 8 : 0);
    }
    expect(getService(state).passings).toBe(8);
  });
});
