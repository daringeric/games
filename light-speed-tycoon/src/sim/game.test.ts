import { describe, expect, it } from 'vitest';
import {
  CABINET_CONSTRUCT_DAYS,
  CABINET_COST,
  CABINET_START_SPLITTERS,
  CABINET_PERMIT_DAYS,
  INSOLVENCY_GRACE_MONTHS,
  MARKETING_DEFAULT_PER_MONTH,
  OLT_START_CARDS,
  OLT_START_PON_PORTS,
  OVERHEAD_PER_MONTH,
  PERMIT_DAYS_MAX,
  PERMIT_DAYS_MIN,
  PERMITTING_CANCEL_REFUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  SPLITTER_COST,
  START_CASH,
} from './balance';
import { dayOf, MONTH_LENGTHS } from './calendar';
import { generateCity } from './citygen';
import { applyCommand, newGame, runDays, tick } from './game';
import { getService, layCable, quoteCable } from './network';
import { deriveSeed, Rng } from './rng';
import { defaultPricing, newSales } from './sales';
import { addLivePlant, makeGridCity } from './testing/fixtures';
import type { City, Command, GameState, MonthlyReport } from './types';

// Default grid: 3x2 blocks of 4x2 cells, CO at node 0. Horizontal segments
// 0..8 are 240 ft with four homes fronting each of 0..5 from below or above;
// vertical segments 9..16 are 120 ft with no frontage.
// Cable prices come from quoteCable, never literals, so the cost model can change.
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
      schemaVersion: 2,
      seed: 42,
      day: 0,
      rng: { events: deriveSeed(42, 'events'), sales: deriveSeed(42, 'sales') },
      nextId: 1,
      city,
      network: {
        spans: [],
        cabinets: [],
        olt: { ponPorts: OLT_START_PON_PORTS, cards: OLT_START_CARDS, tech: 'gpon' },
        makeReady: [],
        version: 0,
      },
      finance: { cash: START_CASH, monthToDate: [], reports: [], capex: { osp: 0, connect: 0, co: 0 }, negativeMonths: 0 },
      sales: newSales(),
      milestones: [],
      notices: [],
      nextNoticeId: 1,
      gameOver: null,
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
    const cost = quoteCable(state, [0, 9], 'aerial').cost;
    expect(cost).toBeGreaterThan(0);

    expect(applyCommand(state, { type: 'layCable', segments: [0, 9], method: 'aerial' })).toEqual({ ok: true, cost });
    // Same outcome as calling network.layCable with the stored stream, which is then advanced.
    expect(layCable(twin, [0, 9], 'aerial', rng)).toEqual({ ok: true, cost });
    expect(state.network).toEqual(twin.network);
    expect(state.rng.events).toBe(rng.state);
    expect(state.rng.events).not.toBe(twin.rng.events);

    expect(state.network.spans.map((s) => [s.id, s.segment, s.stage, s.orderedDay])).toEqual([
      [1, 0, 'permitting', 0],
      [2, 9, 'permitting', 0],
    ]);
    expect(state.nextId).toBe(3);
    expect(state.finance.cash).toBe(START_CASH - cost);
    expect(state.finance.monthToDate).toMatchObject([{ day: 0, category: 'construction', amount: -cost }]);
  });

  it('lays underground cable', () => {
    const state = game();
    const before = state.rng.events;
    const cost = quoteCable(state, [0, 9], 'underground').cost;
    expect(applyCommand(state, { type: 'layCable', segments: [0, 9], method: 'underground' })).toEqual({ ok: true, cost });
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
    const span = state.network.spans[0]!;
    const refund = Math.round(span.refundable * PERMITTING_CANCEL_REFUND);
    expect(refund).toBeGreaterThan(0);
    const version = state.network.version;
    expect(applyCommand(state, { type: 'removeSpan', span: 1 })).toEqual({ ok: true, cost: -refund });
    expect(state.network.spans).toEqual([]);
    expect(state.network.version).toBeGreaterThan(version);
    expect(state.finance.cash).toBe(START_CASH - span.cost + refund);
  });

  it('removes a live span without a refund', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    runDays(state, PERMIT_DAYS_MAX + 1);
    expect(state.network.spans[0]?.stage).toBe('live');
    const cash = state.finance.cash;
    expect(applyCommand(state, { type: 'removeSpan', span: 1 })).toEqual({ ok: true, cost: 0 });
    expect(state.network.spans).toEqual([]);
    expect(state.finance.cash).toBe(cash);
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

/** setPricing tiers for the default lineup, with optional price overrides. */
function tierSettings(prices: Record<string, number> = {}): unknown[] {
  return defaultPricing().tiers.map((t) => ({ id: t.id, price: prices[t.id] ?? t.price, offered: t.offered }));
}

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
  { name: 'addSplitter without a cabinet', cmd: { type: 'addSplitter' }, reason: /addSplitter needs a cabinet id/ },
  { name: 'addSplitter with a string cabinet', cmd: { type: 'addSplitter', cabinet: '1' }, reason: /addSplitter needs a cabinet id/ },
  { name: 'removeCabinet without a cabinet', cmd: { type: 'removeCabinet' }, reason: /removeCabinet needs a cabinet id/ },
  { name: 'removeCabinet with a null cabinet', cmd: { type: 'removeCabinet', cabinet: null }, reason: /removeCabinet needs a cabinet id/ },
  { name: 'setPricing without tiers', cmd: { type: 'setPricing', smbMultiplier: 1.5 }, reason: /setPricing needs a list of tiers/ },
  { name: 'setPricing with an object for tiers', cmd: { type: 'setPricing', tiers: { fiber500: 55 }, smbMultiplier: 1.5 }, reason: /setPricing needs a list of tiers/ },
  {
    name: 'setPricing with a tier missing its price',
    cmd: { type: 'setPricing', tiers: [{ id: 'fiber500', offered: true }], smbMultiplier: 1.5 },
    reason: /each \{ id, price, offered \}/,
  },
  {
    name: 'setPricing with a string price',
    cmd: { type: 'setPricing', tiers: [{ id: 'fiber500', price: '55', offered: true }], smbMultiplier: 1.5 },
    reason: /each \{ id, price, offered \}/,
  },
  {
    name: 'setPricing with a numeric offered flag',
    cmd: { type: 'setPricing', tiers: [{ id: 'fiber500', price: 55, offered: 1 }], smbMultiplier: 1.5 },
    reason: /each \{ id, price, offered \}/,
  },
  { name: 'setPricing with a null tier', cmd: { type: 'setPricing', tiers: [null], smbMultiplier: 1.5 }, reason: /each \{ id, price, offered \}/ },
  {
    name: 'setPricing without a multiplier',
    cmd: { type: 'setPricing', tiers: tierSettings() },
    reason: /setPricing needs an SMB multiplier/,
  },
  {
    name: 'setPricing with a string multiplier',
    cmd: { type: 'setPricing', tiers: tierSettings(), smbMultiplier: '1.5' },
    reason: /setPricing needs an SMB multiplier/,
  },
  { name: 'setMarketing without a budget', cmd: { type: 'setMarketing' }, reason: /setMarketing needs a monthly budget/ },
  { name: 'setMarketing with a string budget', cmd: { type: 'setMarketing', perMonth: '5000' }, reason: /setMarketing needs a monthly budget/ },
  // Well-formed commands the rules refuse
  {
    name: 'a price out of range',
    cmd: { type: 'setPricing', tiers: tierSettings({ fiber1g: 100_000 }), smbMultiplier: 1.5 },
    reason: /1 Gig price must be/,
  },
  { name: 'an unknown tier', cmd: { type: 'setPricing', tiers: [{ id: 'fiber9g', price: 50, offered: true }], smbMultiplier: 1.5 }, reason: /Unknown tier/ },
  { name: 'a negative marketing budget', cmd: { type: 'setMarketing', perMonth: -5 }, reason: /marketing budget must be/ },
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
    // Keep the street dark through January so the month has no subscribers.
    state.network.spans[0]!.stageDaysLeft = 40;
    const cable = state.network.spans[0]!.cost;
    runDays(state, 30);
    expect(state.finance.reports).toEqual([]);
    expect(state.finance.monthToDate).toHaveLength(2);

    tick(state);
    expect(state.day).toBe(31);
    // Day 0 gets no sales step, so January's marketing accrues for 30 of its 31 days.
    const marketing = Math.round((MARKETING_DEFAULT_PER_MONTH * 30) / 31);
    const net = -cable - CABINET_PRICE - OVERHEAD_PER_MONTH - marketing;
    expect(state.finance.reports).toEqual([
      {
        year: 2027,
        month: 1,
        totals: { construction: -cable, equipment: -CABINET_PRICE, overhead: -OVERHEAD_PER_MONTH, marketing: -marketing },
        net,
        cashEnd: START_CASH + net,
        passings: 0,
        stats: {
          subscribers: 0,
          accounts: 0,
          subscriberDays: 0,
          grossAdds: 0,
          churned: 0,
          lostService: 0,
          connectsTotal: 0,
          capexOsp: state.finance.capex.osp,
          capexConnect: 0,
          capexCo: 0,
          ponPortsUsed: CABINET_START_SPLITTERS,
          ponPorts: OLT_START_PON_PORTS,
          fullCabinets: 0,
        },
      },
    ]);
    expect(state.finance.cash).toBe(START_CASH + net);
    expect(state.finance.monthToDate).toEqual([]);
  });

  it('closes every month of the year in order, charging overhead and marketing every month', () => {
    const state = game();
    runDays(state, 365);
    expect(state.finance.reports.map((r) => [r.year, r.month])).toEqual(
      Array.from({ length: 12 }, (_, i) => [2027, i + 1]),
    );
    expect(state.finance.reports.map(closedOn)).toEqual([31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365]);
    runDays(state, 31);
    const idle = -(OVERHEAD_PER_MONTH + MARKETING_DEFAULT_PER_MONTH);
    const january = state.finance.reports.at(-1)!;
    expect(january).toMatchObject({
      year: 2028,
      month: 1,
      totals: { overhead: -OVERHEAD_PER_MONTH, marketing: -MARKETING_DEFAULT_PER_MONTH },
      net: idle,
    });
    let cash = START_CASH;
    for (const report of state.finance.reports) {
      cash += report.net;
      expect(report.cashEnd).toBe(cash);
      expect(report.stats).toBeDefined();
    }
    expect(state.finance.cash).toBe(cash);
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
    // A month pays rent when the span was live by its last day.
    const rented = state.finance.reports.filter((r) => closedOn(r) > liveDay);
    expect(rented.length).toBeGreaterThan(0);
    for (const report of state.finance.reports) {
      expect(report.totals.poleRent).toBe(closedOn(report) > liveDay ? rent : undefined);
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
      expect(report.passings).toBe(closedOn(report) > lit ? 8 : 0);
    }
    expect(getService(state).passings).toBe(8);
  });

  it('bills no pole rent and counts no passings for the month before a span goes live on the 1st', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    applyCommand(state, { type: 'layCable', segments: [0], method: 'aerial' });
    // Make-ready ends on Jan 31 and the one-day build finishes on Feb 1 (day 31).
    const span = state.network.spans[0]!;
    span.stageDaysLeft = 30;
    span.constructDays = 1;
    runDays(state, 30);
    expect(span.stage).toBe('constructing');
    expect(getService(state).passings).toBe(0);

    tick(state);
    expect(span).toMatchObject({ stage: 'live', liveDay: 31 });
    const january = state.finance.reports[0]!;
    expect(january).toMatchObject({ year: 2027, month: 1, passings: 0 });
    expect(january.totals.poleRent).toBeUndefined();
    // The ledger has no rent dated Jan 31 either.
    expect(state.finance.monthToDate.filter((e) => e.category === 'poleRent')).toEqual([]);
    expect(getService(state).passings).toBe(4);

    runDays(state, 28);
    expect(state.finance.reports[1]).toMatchObject({ year: 2027, month: 2, passings: 4 });
    expect(state.finance.reports[1]!.totals.poleRent).toBe(-2 * POLE_RENT_PER_POLE_PER_MONTH);
  });

  it('counts homes that appear on the 1st in the new month, not the one that ended', () => {
    const city = makeGridCity();
    // One of the four homes fronting segment 0 is built on Feb 1 (day 31).
    const late = city.parcels.find((p) => p.segment === 0)!;
    late.appearsDay = 31;
    const state = game(city);
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    runDays(state, 30);
    expect(getService(state).passings).toBe(3);

    tick(state);
    expect(state.finance.reports[0]).toMatchObject({ year: 2027, month: 1, passings: 3 });
    expect(getService(state).passings).toBe(4);
  });
});

describe('pricing and marketing commands', () => {
  it('sets prices and the marketing budget for free', () => {
    const state = game();
    const tiers = tierSettings({ fiber500: 50, fiber2g: 120 });
    expect(applyCommand(state, { type: 'setPricing', tiers: tiers as never, smbMultiplier: 2 })).toEqual({ ok: true, cost: 0 });
    expect(state.sales.pricing.tiers.map((t) => t.price)).toEqual([50, defaultPricing().tiers[1]!.price, 120]);
    expect(state.sales.pricing.smbMultiplier).toBe(2);
    expect(applyCommand(state, { type: 'setMarketing', perMonth: 4_000 })).toEqual({ ok: true, cost: 0 });
    expect(state.sales.marketingPerMonth).toBe(4_000);
    expect(state.finance.cash).toBe(START_CASH);
    expect(state.finance.monthToDate).toEqual([]);
  });
});

/** A game one negative close away from insolvency, on the last day of January. */
function nearlyBroke(): GameState {
  const state = game();
  state.day = 30;
  state.finance.cash = -1;
  state.finance.negativeMonths = INSOLVENCY_GRACE_MONTHS - 1;
  return state;
}

describe('the daily tick, round 2', () => {
  it('runs no sales step on day 0: the first step is day 1', () => {
    const state = game();
    addLivePlant(state);
    const before = structuredClone(state.sales);
    expect(state.sales.month.marketingDollarDays).toBe(0);
    tick(state);
    expect(state.day).toBe(1);
    expect(state.sales.month.marketingDollarDays).toBe(state.sales.marketingPerMonth);
    expect(before.month.marketingDollarDays).toBe(0);
  });

  it('closes the month before the new day\'s network progress and sales', () => {
    const state = game();
    addLivePlant(state);
    runDays(state, 30);
    const accrued = state.sales.month.marketingDollarDays;
    expect(accrued).toBe(30 * state.sales.marketingPerMonth);
    tick(state); // Feb 1: close January, then step Feb 1
    expect(state.finance.reports[0]!.totals.marketing).toBe(-Math.round(accrued / 31));
    expect(state.sales.month.marketingDollarDays).toBe(state.sales.marketingPerMonth);
  });

  it('stops a tick whose close ends the game before any network progress or sales', () => {
    const state = nearlyBroke();
    applyCommandUnchecked(state);
    const span = state.network.spans[0]!;
    const daysLeft = span.stageDaysLeft;
    const salesRng = state.rng.sales;
    tick(state);
    expect(state.day).toBe(31);
    expect(state.gameOver).toMatchObject({ day: 31, reason: 'insolvent' });
    expect(state.finance.reports).toHaveLength(1);
    expect(span.stageDaysLeft).toBe(daysLeft);
    // No sales step ran after the close: the new month's accrual is still empty.
    expect(state.sales.month.marketingDollarDays).toBe(0);
    expect(state.rng.sales).toBe(salesRng);
    expect(state.notices.at(-1)).toMatchObject({ kind: 'gameOver', day: 31 });
  });

  it('does nothing once the game is over, and runDays stops advancing', () => {
    const state = nearlyBroke();
    runDays(state, 100);
    expect(state.day).toBe(31);
    expect(state.gameOver).not.toBeNull();
    const frozen = structuredClone(state);
    tick(state);
    runDays(state, 365);
    expect(state).toEqual(frozen);
  });
});

/** Order something that will still be permitting tomorrow (bypasses the cash check). */
function applyCommandUnchecked(state: GameState): void {
  const cash = state.finance.cash;
  state.finance.cash = START_CASH;
  expect(applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' }).ok).toBe(true);
  state.finance.cash = cash;
}

describe('game over', () => {
  const COMMANDS: unknown[] = [
    { type: 'layCable', segments: [0], method: 'aerial' },
    { type: 'placeCabinet', node: 0 },
    { type: 'removeSpan', span: 1 },
    { type: 'addSplitter', cabinet: 1 },
    { type: 'removeCabinet', cabinet: 1 },
    { type: 'addOltCard' },
    { type: 'setPricing', tiers: tierSettings(), smbMultiplier: 1.5 },
    { type: 'setMarketing', perMonth: 0 },
    { type: 'teleport' },
    {},
  ];

  it.each(COMMANDS)('rejects %j after the game has ended and changes nothing', (cmd) => {
    const state = nearlyBroke();
    applyCommandUnchecked(state);
    tick(state);
    expect(state.gameOver).not.toBeNull();
    const before = structuredClone(state);
    const result = applyCommand(state, cmd as Command);
    expect(result).toEqual({ ok: false, reason: `Game over: ${state.gameOver!.message}` });
    expect(state).toEqual(before);
  });
});
