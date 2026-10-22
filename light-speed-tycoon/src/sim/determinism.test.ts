import { describe, expect, it } from 'vitest';
import { MARKETING_MAX_PER_MONTH, STORM_START_DAY, TERM_LOAN_MIN, TIER_DEFAULTS } from './balance';
import { isFirstOfMonth } from './calendar';
import { creditAvailable, termCapacity } from './debt';
import { applyCommand, newGame, runDays } from './game';
import { getService } from './network';
import { subscriberUnits } from './sales';
import { deserialize, hashState, serialize } from './save';
import { shortestPath } from './streets';
import { makeGridCity } from './testing/fixtures';
import type { Command, CommandResult, GameState } from './types';
import { outageSpanIds } from './weather';

// Commands interleaved with day counts. Default grid: horizontal segments 0..8,
// vertical 9..16, CO at node 0. Every aerial order draws make-ready (with its
// long-delay chance) from the events stream, so later draws depend on earlier ones.
const SCRIPT: ReadonlyArray<Command | number> = [
  { type: 'placeCabinet', node: 0 },
  { type: 'layCable', segments: [0, 9], method: 'aerial' },
  { type: 'layCable', segments: [1], method: 'underground' },
  20,
  { type: 'layCable', segments: [2, 12], method: 'aerial' },
  45,
  { type: 'placeCabinet', node: 5 },
  { type: 'layCable', segments: [3, 4, 5], method: 'aerial' },
  { type: 'removeSpan', span: 4 },
  60,
  { type: 'layCable', segments: [10, 13], method: 'aerial' },
  { type: 'layCable', segments: [6, 7], method: 'underground' },
  90,
  // Rejected; must not disturb anything.
  { type: 'layCable', segments: [99], method: 'aerial' },
  { type: 'layCable', segments: [8, 16], method: 'aerial' },
  120,
];

interface Session {
  state: GameState;
  results: CommandResult[];
}

/** A script step: a command, a command decided from the state at that moment, or days to run. */
type Step = Command | ((state: GameState) => Command) | number;

function play(state: GameState, steps: ReadonlyArray<Step> = SCRIPT): Session {
  const results: CommandResult[] = [];
  for (const step of steps) {
    if (typeof step === 'number') runDays(state, step);
    else results.push(applyCommand(state, typeof step === 'function' ? step(state) : step));
  }
  return { state, results };
}

function gridSession(seed: number): Session {
  return play(newGame(seed, { city: makeGridCity() }));
}

/** When each span was ordered and went live: the visible footprint of the RNG. */
function timeline(state: GameState): Array<[number, number, number | null]> {
  return state.network.spans.map((s) => [s.segment, s.orderedDay, s.liveDay]);
}

describe('determinism', () => {
  it('replays a scripted session identically from the same seed', () => {
    const a = gridSession(2027);
    const b = gridSession(2027);
    expect(a.state.day).toBe(335);
    expect(a.results).toEqual(b.results);
    expect(a.state.finance.reports).toHaveLength(11);
    expect(a.state.finance.reports).toEqual(b.state.finance.reports);
    expect(hashState(a.state)).toBe(hashState(b.state));
    expect(serialize(a.state)).toBe(serialize(b.state));
  });

  it('exercises the make-ready RNG', () => {
    const { state, results } = gridSession(2027);
    expect(results.filter((r) => r.ok)).toHaveLength(results.length - 1);
    expect(state.rng.events).not.toBe(newGame(2027, { city: makeGridCity() }).rng.events);
    // Aerial orders placed on different days spent different times in make-ready.
    const makeReady = new Set(
      state.network.spans
        .filter((s) => s.method === 'aerial' && s.liveDay !== null)
        .map((s) => (s.liveDay as number) - s.orderedDay - s.constructDays),
    );
    expect(makeReady.size).toBeGreaterThan(1);
  });

  it('diverges for a different seed', () => {
    const a = gridSession(2027);
    const b = gridSession(2028);
    expect(hashState(a.state)).not.toBe(hashState(b.state));
    expect(timeline(a.state)).not.toEqual(timeline(b.state));
  });

  it('replays identically through a save and load mid-session', () => {
    const straight = gridSession(7);
    const half = SCRIPT.indexOf(60);
    const first = play(newGame(7, { city: makeGridCity() }), SCRIPT.slice(0, half));
    const second = play(deserialize(serialize(first.state)), SCRIPT.slice(half));
    expect([...first.results, ...second.results]).toEqual(straight.results);
    expect(hashState(second.state)).toBe(hashState(straight.state));
  });

  it('keeps games independent when stepped side by side', () => {
    const solo = gridSession(11);
    const a = newGame(11, { city: makeGridCity() });
    const b = newGame(12, { city: makeGridCity() });
    // Alternate steps between two games sharing one City object.
    b.city = a.city;
    for (const step of SCRIPT) {
      play(a, [step]);
      play(b, [step]);
      getService(b);
    }
    expect(hashState(a)).toBe(hashState(solo.state));
  });

  it('replays a session on a generated city', () => {
    const generatedSession = (seed: number): Session => {
      const state = newGame(seed);
      const { city } = state;
      const far = city.coNode === city.nodes.length - 1 ? 0 : city.nodes.length - 1;
      const route = shortestPath(city, city.coNode, far) ?? [];
      const poled = city.segments.filter((s) => s.hasPoles && !route.includes(s.id)).map((s) => s.id);
      return play(state, [
        { type: 'placeCabinet', node: city.coNode },
        { type: 'layCable', segments: route, method: 'underground' },
        30,
        { type: 'layCable', segments: poled.slice(0, 4), method: 'aerial' },
        60,
        { type: 'layCable', segments: poled.slice(4, 8), method: 'aerial' },
        120,
      ]);
    };

    const a = generatedSession(99);
    const b = generatedSession(99);
    expect(a.results[0]?.ok).toBe(true);
    expect(a.results[1]?.ok).toBe(true);
    expect(a.results).toEqual(b.results);
    expect(hashState(a.state)).toBe(hashState(b.state));
    // The route from the CO is lit by now, and the generated town survives a save.
    expect(getService(a.state).litSegments.size).toBeGreaterThan(0);
    expect(deserialize(serialize(a.state))).toEqual(a.state);
    expect(hashState(generatedSession(100).state)).not.toBe(hashState(a.state));
  });
});

// A sales-heavy session: apartment buildings and businesses on a small grid,
// heavy marketing and prices above default so signups and churn both happen.
// Round 4c/4d: with the customers model's commands too (support level,
// referral credits, a neighborhood campaign sized from the state at the time).
const SALES_CITY = makeGridCity({
  cols: 3,
  rows: 3,
  coAt: [1, 1],
  parcelKinds: (p) => (p.id % 4 === 0 ? { kind: 'mdu', units: 16 } : p.id % 4 === 1 ? { kind: 'smb', units: 1 } : undefined),
});
const PRICIER = TIER_DEFAULTS.map((t) => ({ id: t.id, price: Math.round(t.price * 1.25), offered: true }));
const SALES_SCRIPT: ReadonlyArray<Step> = [
  { type: 'setMarketing', perMonth: Math.min(10_000, MARKETING_MAX_PER_MONTH) },
  { type: 'setSupport', level: 'great' },
  { type: 'setReferrals', on: true },
  { type: 'placeCabinet', node: 5 },
  { type: 'layCable', segments: [3, 4, 5, 6, 7, 8], method: 'underground' },
  { type: 'layCable', segments: [16, 17, 18, 19, 20, 21, 22, 23], method: 'underground' },
  110,
  (s) => ({ type: 'runCampaign', cabinet: s.network.cabinets[0]?.id ?? 0 }),
  { type: 'setPricing', tiers: PRICIER, smbMultiplier: 2 },
  { type: 'layCable', segments: [0, 1, 2, 9, 10, 11], method: 'aerial' },
  80,
  { type: 'setMarketing', perMonth: 2_000 },
  { type: 'setSupport', level: 'basic' },
  { type: 'setReferrals', on: false },
  140,
];
/** Days SALES_SCRIPT runs. */
const SALES_DAYS = SALES_SCRIPT.reduce<number>((n, step) => n + (typeof step === 'number' ? step : 0), 0);

function salesSession(seed: number, steps: ReadonlyArray<Step> = SALES_SCRIPT): Session {
  return play(newGame(seed, { city: SALES_CITY }), steps);
}

describe('determinism of sales', () => {
  it('replays signups, installs and churn identically from the same seed', () => {
    const a = salesSession(5);
    const b = salesSession(5);
    expect(a.results.every((r) => r.ok), JSON.stringify(a.results)).toBe(true);
    expect(SALES_DAYS).toBe(330);
    expect(subscriberUnits(a.state)).toBeGreaterThan(20);
    // The customers model's figures replay too: awareness, the campaign, memories and the closes' customer stats.
    expect(a.state.customers).toEqual(b.state.customers);
    expect(a.state.finance.reports.some((r) => (r.customers?.campaignSpend ?? 0) > 0)).toBe(true);
    const churned = a.state.finance.reports.reduce((sum, r) => sum + (r.stats?.churned ?? 0), 0);
    expect(churned).toBeGreaterThan(0);
    expect(a.state.sales.routerParcels.length).toBeGreaterThan(0);
    expect(a.state.sales).toEqual(b.state.sales);
    expect(a.state.finance.reports).toEqual(b.state.finance.reports);
    expect(hashState(a.state)).toBe(hashState(b.state));
  });

  it('diverges with a different sales stream, even on identical plant', () => {
    const a = newGame(5, { city: SALES_CITY });
    const b = newGame(5, { city: SALES_CITY });
    b.rng.sales = (a.rng.sales ^ 0x9e3779b9) >>> 0;
    play(a, SALES_SCRIPT);
    play(b, SALES_SCRIPT);
    // Same make-ready draws, so the network matches; who signs up does not.
    expect(timeline(a)).toEqual(timeline(b));
    expect(a.sales.accounts).not.toEqual(b.sales.accounts);
  });

  it('diverges for a different seed', () => {
    expect(hashState(salesSession(5).state)).not.toBe(hashState(salesSession(6).state));
  });

  it('replays identically through a save and load in the middle of a month', () => {
    const straight = salesSession(9);
    // Stop mid-month with subscribers and a half-accrued bill.
    const split = SALES_SCRIPT.indexOf(80);
    const first = play(newGame(9, { city: SALES_CITY }), SALES_SCRIPT.slice(0, split));
    expect(isFirstOfMonth(first.state.day)).toBe(false);
    expect(subscriberUnits(first.state)).toBeGreaterThan(0);
    expect(first.state.sales.month.revenueDollarDays).toBeGreaterThan(0);
    expect(first.state.sales.month.marketingDollarDays).toBeGreaterThan(0);
    const reloaded = deserialize(serialize(first.state));
    expect(reloaded.sales.month).toEqual(first.state.sales.month);
    const second = play(reloaded, SALES_SCRIPT.slice(split));
    expect([...first.results, ...second.results]).toEqual(straight.results);
    expect(second.state.finance.reports).toEqual(straight.state.finance.reports);
    expect(hashState(second.state)).toBe(hashState(straight.state));
  });
});

// The sales session, then a year on credit: draws, term loans, repayments and
// prepayments sized from the state at the time (so they are accepted), one
// junk command, and month closes charging interest and principal.
const DEBT_SCRIPT: ReadonlyArray<Step> = [
  ...SALES_SCRIPT,
  (s) => ({ type: 'drawCredit', amount: Math.floor(creditAvailable(s) / 2) }),
  (s) => ({ type: 'takeTermLoan', amount: Math.max(TERM_LOAN_MIN, Math.floor(termCapacity(s) / 3)), termYears: 7 }),
  45,
  { type: 'repayCredit', amount: 1_000 },
  { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: 5 },
  { type: 'drawCredit', amount: Number.NaN },
  70,
  { type: 'prepayLoan', loan: 1, amount: TERM_LOAN_MIN / 2 },
  (s) => ({ type: 'drawCredit', amount: Math.max(1, Math.floor(creditAvailable(s) / 4)) }),
  120,
  // Pay off the second loan in full.
  (s) => ({ type: 'prepayLoan', loan: 2, amount: s.debt.loans.find((l) => l.id === 2)?.balance ?? 1 }),
  90,
];

describe('determinism with debt', () => {
  it('replays a session on credit identically, straight or through a save and load', () => {
    const a = salesSession(5, DEBT_SCRIPT);
    const b = salesSession(5, DEBT_SCRIPT);
    const debtResults = a.results.slice(-8);
    expect(debtResults, JSON.stringify(debtResults)).toMatchObject([{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: false }, { ok: true }, { ok: true }, { ok: true }]);
    expect(a.results).toEqual(b.results);
    expect(a.state.finance.reports.some((r) => (r.totals.interest ?? 0) < 0 && (r.totals.principal ?? 0) < 0)).toBe(true);
    expect(a.state.debt.loans.map((l) => l.id)).toEqual([1]);
    expect(hashState(a.state)).toBe(hashState(b.state));

    const split = DEBT_SCRIPT.indexOf(70);
    const first = play(newGame(5, { city: SALES_CITY }), DEBT_SCRIPT.slice(0, split));
    expect(first.state.debt.credit.balanceDollarDays).toBeGreaterThan(0);
    const second = play(deserialize(serialize(first.state)), DEBT_SCRIPT.slice(split));
    expect([...first.results, ...second.results]).toEqual(a.results);
    expect(hashState(second.state)).toBe(hashState(a.state));
    expect(hashState(salesSession(6, DEBT_SCRIPT).state)).not.toBe(hashState(a.state));
  });
});

// Storm season on the sales town: mostly aerial plant, an underground
// rebuild ordered once storms have begun, and two years of weather. Round
// 4b: the storm sequence comes from the weather stream alone and each
// storm's (and day's) per-street draws from sub-streams of the seed, so a
// different plant on the same seed meets the same storms.
const STORM_SCRIPT: ReadonlyArray<Step> = [
  ...SALES_SCRIPT,
  STORM_START_DAY - SALES_DAYS,
  (s) => ({ type: 'convertSpan', span: s.network.spans.find((sp) => sp.method === 'aerial' && sp.stage === 'live')?.id ?? 0 }),
  { type: 'layCable', segments: [12, 13, 14, 15], method: 'aerial' },
  300,
];

function stormSession(seed: number, steps: ReadonlyArray<Step> = STORM_SCRIPT): Session {
  const state = newGame(seed, { city: SALES_CITY });
  state.finance.cash = 5_000_000;
  return play(state, steps);
}

describe('determinism with weather', () => {
  it('replays storms, outages, repairs and an underground rebuild identically from the same seed', () => {
    const a = stormSession(5);
    const b = stormSession(5);
    expect(a.results.every((r) => r.ok), JSON.stringify(a.results)).toBe(true);
    expect(a.state.day).toBeGreaterThan(STORM_START_DAY + 200);
    const storms = a.state.finance.reports.reduce((sum, r) => sum + (r.ops?.storms ?? 0), 0);
    expect(storms).toBeGreaterThan(0);
    expect(a.state.finance.reports.some((r) => (r.ops?.spansDamaged ?? 0) > 0)).toBe(true);
    // The rebuild finished: one span changed method.
    expect(a.state.network.spans.some((s) => s.method === 'underground' && s.orderedDay < STORM_START_DAY && s.cost > 0)).toBe(true);
    expect(a.results).toEqual(b.results);
    expect(a.state.weather).toEqual(b.state.weather);
    expect(hashState(a.state)).toBe(hashState(b.state));
    expect(hashState(stormSession(6).state)).not.toBe(hashState(a.state));
  });

  it('brings the same storms to a different plant on the same seed (round 4b: fair streams)', () => {
    const a = stormSession(5);
    // The same session, but the late order goes in underground instead of aerial, and the rebuild never happens.
    const other: ReadonlyArray<Step> = [...SALES_SCRIPT, STORM_START_DAY - SALES_DAYS, { type: 'layCable', segments: [12, 13, 14, 15], method: 'underground' }, 300];
    const b = stormSession(5, other);
    expect(b.results.every((r) => r.ok), JSON.stringify(b.results)).toBe(true);
    const sequence = (s: GameState) => s.weather.storms.map(({ id, day, x, y, radius, severity }) => ({ id, day, x, y, radius, severity }));
    expect(sequence(a.state).length).toBeGreaterThan(0);
    expect(sequence(b.state)).toEqual(sequence(a.state));
    expect(b.state.rng.weather).toBe(a.state.rng.weather);
    // The plants differ, and so does what the storms did to them.
    expect(hashState(b.state)).not.toBe(hashState(a.state));
  });

  it('replays identically through a save and load taken while spans are out of service', () => {
    const straight = stormSession(5);
    // The same session, saved and reloaded on the first day of the last stretch with a span out.
    const last = STORM_SCRIPT.length - 1;
    const first = play(newGame(5, { city: SALES_CITY }), []);
    first.state.finance.cash = 5_000_000;
    const head = play(first.state, STORM_SCRIPT.slice(0, last));
    let state = head.state;
    const days = STORM_SCRIPT[last] as number;
    let ran = 0;
    while (ran < days && outageSpanIds(state).length === 0) {
      runDays(state, 1);
      ran++;
    }
    expect(outageSpanIds(state).length).toBeGreaterThan(0);
    const json = serialize(state);
    state = deserialize(json);
    expect(serialize(state)).toBe(json);
    runDays(state, days - ran);
    expect(head.results).toEqual(straight.results);
    expect(hashState(state)).toBe(hashState(straight.state));
  });
});
