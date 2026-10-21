// Weather (round 4): storms, dig-ins, outages and repairs, the month's
// accruals, the storm-risk estimate, and the stream discipline (weather
// draws only from rng.weather).

import { describe, expect, it } from 'vitest';
import {
  DIG_INS_PER_MILE_PER_YEAR,
  OUTAGE_CHURN_BASE,
  OUTAGE_CHURN_MAX,
  OUTAGE_CHURN_PER_DAY,
  OUTAGE_DAYS_AERIAL_MAX,
  OUTAGE_DAYS_AERIAL_MIN,
  OUTAGE_DAYS_UNDERGROUND_MAX,
  OUTAGE_DAYS_UNDERGROUND_MIN,
  REPAIR_BASE_AERIAL,
  REPAIR_BASE_UNDERGROUND,
  REPAIR_PER_FT_AERIAL,
  REPAIR_PER_FT_UNDERGROUND,
  STORM_AERIAL_DAMAGE_CHANCE,
  STORM_CHANCE_PER_DAY,
  STORM_LOG_DAYS,
  STORM_RADIUS_MAX,
  STORM_RADIUS_MIN,
  STORM_SEVERITY_MAX,
  STORM_START_DAY,
  STORM_UNDERGROUND_DAMAGE_CHANCE,
} from './balance';
import { dayOf } from './calendar';
import { formatMoney } from './finance';
import { applyCommand, newGame, runDays, tick } from './game';
import { getService } from './network';
import { Rng, withRng } from './rng';
import { hashState } from './save';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { CableMethod, Command, GameState, Storm } from './types';
import {
  closeWeatherMonth,
  emptyWeatherMonth,
  meanOutageDays,
  newWeather,
  outageChurnProbability,
  outageDaysOn,
  outageSpanIds,
  repairCost,
  stepWeather,
  stormAreaName,
  stormCoverage,
  stormRisk,
} from './weather';

// Default grid: 12 x 4 cells, CO at node 0. Horizontal segments 0..8 are
// 240 ft and pass homes; vertical segments 9..16 are 120 ft with no frontage.
// addLivePlant cables every segment and puts a cabinet at the CO, which
// lights the whole grid.

/**
 * An Rng whose draws the test decides: int() takes the queued values in
 * order (clamped to the range; the range's minimum once the queue is empty),
 * chance() asks `decide` and records every probability it was asked about.
 */
class FakeRng extends Rng {
  readonly odds: number[] = [];
  private readonly ints: number[];
  private readonly decide: (p: number, call: number) => boolean;

  constructor(ints: number[] = [], decide: (p: number, call: number) => boolean = () => false) {
    super(1);
    this.ints = [...ints];
    this.decide = decide;
  }

  override int(min: number, max: number): number {
    const v = this.ints.shift();
    return v === undefined ? min : Math.max(min, Math.min(max, v));
  }

  override chance(p: number): boolean {
    this.odds.push(p);
    return this.decide(p, this.odds.length - 1);
  }
}

/** Every chance comes up: a storm hits and damages everything it may. */
const always = () => true;

/** A grid with every segment cabled live by `method` and a live cabinet at the CO, on STORM_START_DAY. */
function stormyTown(method: CableMethod = 'aerial'): GameState {
  const state = makeTestState();
  addLivePlant(state);
  for (const span of state.network.spans) span.method = method;
  state.day = STORM_START_DAY;
  return state;
}

/** One weather day: the day moves on, then stepWeather with `rng`. */
function weatherDay(state: GameState, rng: Rng): void {
  state.day += 1;
  stepWeather(state, rng);
}

/** Give `parcel` a one-unit account on the CO cabinet (accounts stay sorted). */
function subscribe(state: GameState, parcel: number, units = 1): void {
  const cabinet = state.network.cabinets[0]!.id;
  state.sales.accounts.push({ parcel, cabinet, tierUnits: { fiber500: units, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] });
  state.sales.accounts.sort((a, b) => a.parcel - b.parcel);
}

/** A parcel served by `segment`. */
function parcelOn(state: GameState, segment: number): number {
  return state.city.parcels.find((p) => p.segment === segment)!.id;
}

/** Repair dollars ledgered this month. */
function repairsPosted(state: GameState): number {
  return -state.finance.monthToDate.filter((e) => e.category === 'repair').reduce((sum, e) => sum + e.amount, 0);
}

/** Lattice points (0..w, 0..h) within r of (mx, my), averaged over the radii: the brute force of stormCoverage. */
function bruteCoverage(w: number, h: number, mx: number, my: number): number {
  let total = 0;
  let radii = 0;
  for (let r = STORM_RADIUS_MIN; r <= STORM_RADIUS_MAX; r++) {
    let n = 0;
    for (let x = 0; x <= w; x++) for (let y = 0; y <= h; y++) if ((x - mx) * (x - mx) + (y - my) * (y - my) <= r * r) n++;
    total += n / ((w + 1) * (h + 1));
    radii++;
  }
  return total / radii;
}

describe('weather contract', () => {
  it('starts with no storms and an empty month', () => {
    expect(newWeather()).toEqual({ storms: [], nextStormId: 1, month: emptyWeatherMonth(), cutOff: [] });
    expect(newWeather()).not.toBe(newWeather());
    expect(makeTestState().weather).toEqual(newWeather());
  });

  it("reads a segment's outage days in the open month", () => {
    const state = makeTestState();
    state.weather.month.segmentOutageDays = [
      { segment: 1, days: 2 },
      { segment: 4, days: 7 },
      { segment: 9, days: 1 },
    ];
    expect([0, 1, 4, 5, 9, 10].map((s) => outageDaysOn(state, s))).toEqual([0, 2, 7, 0, 1, 0]);
  });

  it('adds outage churn by days out, capped', () => {
    expect(outageChurnProbability(0)).toBe(0);
    expect(outageChurnProbability(3)).toBeCloseTo(OUTAGE_CHURN_BASE + 3 * OUTAGE_CHURN_PER_DAY);
    expect(outageChurnProbability(10_000)).toBe(OUTAGE_CHURN_MAX);
  });

  it('closes the month: returns its totals and resets them, outages carry on', () => {
    const state = makeTestState();
    addLivePlant(state);
    const span = state.network.spans[0]!;
    span.outage = { cause: 'storm', storm: null, startDay: 0, daysLeft: 3, repairCost: 100 };
    state.weather.month = { segmentOutageDays: [{ segment: 0, days: 2 }], outageUnitDays: 9, storms: 1, spansDamaged: 1, repairs: 100 };
    expect(closeWeatherMonth(state)).toEqual({ outageUnitDays: 9, storms: 1, spansDamaged: 1, repairs: 100 });
    expect(state.weather.month).toEqual(emptyWeatherMonth());
    expect(outageSpanIds(state)).toEqual([span.id]);
  });

  it('brings no storms or dig-ins before STORM_START_DAY, and draws nothing from the weather stream', () => {
    const state = makeTestState();
    addLivePlant(state);
    const weatherRng = state.rng.weather;
    runDays(state, STORM_START_DAY - 1);
    expect(state.day).toBe(STORM_START_DAY - 1);
    expect(state.rng.weather).toBe(weatherRng);
    expect(state.weather.storms).toEqual([]);
    expect(outageSpanIds(state)).toEqual([]);
    expect(getService(state).interruptedSegments.size).toBe(0);
    expect(state.finance.reports.every((r) => r.ops?.storms === 0 && r.ops.repairs === 0 && r.ops.outageUnitDays === 0)).toBe(true);
    // From STORM_START_DAY on, every day draws at least the storm chance.
    tick(state);
    expect(state.day).toBe(STORM_START_DAY);
    expect(state.rng.weather).not.toBe(weatherRng);
  });
});

describe('repairCost and stormRisk', () => {
  const city = makeGridCity();
  const street = city.segments[0]!;

  it('prices a repair by method: a base plus a per-foot part, whole dollars', () => {
    expect(repairCost(street, 'aerial')).toBe(Math.round(REPAIR_BASE_AERIAL + REPAIR_PER_FT_AERIAL * street.lengthFt));
    expect(repairCost(street, 'underground')).toBe(Math.round(REPAIR_BASE_UNDERGROUND + REPAIR_PER_FT_UNDERGROUND * street.lengthFt));
    expect(Number.isInteger(repairCost({ ...street, lengthFt: 123.4 }, 'aerial'))).toBe(true);
  });

  it('measures the chance a storm covers a point exactly, half cells and map edges included', () => {
    for (const [w, h, mx, my] of [
      [12, 4, 2, 0],
      [12, 4, 0, 1],
      [40, 30, 20.5, 15],
      [40, 30, 0, 0],
      [96, 64, 47, 31.5],
      [3, 3, 1.5, 3],
    ] as const) {
      expect(stormCoverage(w, h, 2 * mx, 2 * my), `${w}x${h} at (${mx}, ${my})`).toBeCloseTo(bruteCoverage(w, h, mx, my), 12);
    }
    // A corner of a big map is covered less often than its middle.
    expect(stormCoverage(96, 64, 0, 0)).toBeLessThan(stormCoverage(96, 64, 96, 64));
  });

  it('expects yearly outages from storm chance x coverage x damage chance, plus dig-ins underground', () => {
    const state = makeTestState(city);
    const a = city.nodes[street.a]!;
    const b = city.nodes[street.b]!;
    const coverage = stormCoverage(city.width, city.height, a.x + b.x, a.y + b.y);
    const meanDamage = (chance: number) => {
      let sum = 0;
      for (let s = 1; s <= STORM_SEVERITY_MAX; s++) sum += Math.min(1, s * chance);
      return sum / STORM_SEVERITY_MAX;
    };
    const aerial = stormRisk(state, street, 'aerial');
    const underground = stormRisk(state, street, 'underground');
    expect(aerial.outagesPerYear).toBeCloseTo(365 * STORM_CHANCE_PER_DAY * coverage * meanDamage(STORM_AERIAL_DAMAGE_CHANCE), 10);
    const digIns = (street.lengthFt / 5_280) * DIG_INS_PER_MILE_PER_YEAR;
    expect(underground.outagesPerYear).toBeCloseTo(365 * STORM_CHANCE_PER_DAY * coverage * meanDamage(STORM_UNDERGROUND_DAMAGE_CHANCE) + digIns, 10);
    for (const [risk, method] of [
      [aerial, 'aerial'],
      [underground, 'underground'],
    ] as const) {
      expect(risk.repairCostPerYear).toBeCloseTo(risk.outagesPerYear * repairCost(street, method), 8);
      expect(risk.outageDaysPerYear).toBeCloseTo(risk.outagesPerYear * meanOutageDays(method), 8);
    }
    expect(meanOutageDays('aerial')).toBe((OUTAGE_DAYS_AERIAL_MIN + OUTAGE_DAYS_AERIAL_MAX) / 2);
    expect(meanOutageDays('underground')).toBe((OUTAGE_DAYS_UNDERGROUND_MIN + OUTAGE_DAYS_UNDERGROUND_MAX) / 2);
    // The design: aerial plant is far more exposed than underground.
    expect(aerial.outagesPerYear).toBeGreaterThan(underground.outagesPerYear);
    // Pure: nothing in the state moved.
    expect(state).toEqual(makeTestState(city));
  });
});

describe('storms', () => {
  it('damages the live spans in its area, posts one repair entry, logs the storm and tells the player', () => {
    const state = stormyTown('aerial');
    // Two homes on the first street subscribe.
    subscribe(state, parcelOn(state, 0));
    subscribe(state, state.city.parcels.filter((p) => p.segment === 0)[1]!.id);
    const version = state.network.version;
    const cash = state.finance.cash;
    // A storm over the middle of the town, wide enough for all of it, severity 1, each outage 3 days.
    const rng = new FakeRng([6, 2, STORM_RADIUS_MAX, 1, ...state.network.spans.map(() => 3)], always);
    weatherDay(state, rng);

    const spans = state.network.spans;
    const expectedCost = spans.reduce((sum, s) => sum + repairCost(state.city.segments[s.segment]!, 'aerial'), 0);
    expect(state.weather.storms).toEqual<Storm[]>([
      { id: 1, day: state.day, x: 6, y: 2, radius: STORM_RADIUS_MAX, severity: 1, spans: spans.map((s) => s.id), repairCost: expectedCost },
    ]);
    expect(state.weather.nextStormId).toBe(2);
    for (const span of spans) {
      expect(span.outage).toEqual({
        cause: 'storm',
        storm: 1,
        startDay: state.day,
        daysLeft: 3,
        repairCost: repairCost(state.city.segments[span.segment]!, 'aerial'),
      });
    }
    // The damage chance asked per span: severity x the aerial chance (after the storm's own chance).
    expect(rng.odds[0]).toBe(STORM_CHANCE_PER_DAY);
    expect(rng.odds.slice(1)).toEqual(spans.map(() => STORM_AERIAL_DAMAGE_CHANCE));
    // One repair entry for the storm, posted at once.
    expect(state.finance.monthToDate.filter((e) => e.category === 'repair')).toEqual([
      expect.objectContaining({ day: state.day, amount: -expectedCost }),
    ]);
    expect(state.finance.cash).toBe(cash - expectedCost);
    expect(state.network.version).toBeGreaterThan(version);
    expect(state.weather.month).toMatchObject({ storms: 1, spansDamaged: spans.length, repairs: expectedCost });
    // Every lit street is cut off now.
    const service = getService(state);
    expect([...service.interruptedSegments].sort((a, b) => a - b)).toEqual([...service.litSegments].sort((a, b) => a - b));
    // The notice names the area, the spans, the subscribers, the bill and how long.
    const notice = state.notices.at(-1)!;
    expect(notice.kind).toBe('storm');
    expect(notice.message).toContain(stormAreaName(state.city, { x: 6, y: 2 }));
    expect(notice.message).toContain(`${spans.length} spans down`);
    expect(notice.message).toContain('2 subscribers cut off');
    expect(notice.message).toContain(formatMoney(expectedCost));
    expect(notice.message).toContain('3 days');
  });

  it('uses the underground damage chance on underground plant, and scales both by severity', () => {
    const state = stormyTown('underground');
    // Severity 2; nothing is actually damaged; dig-ins never come up.
    const rng = new FakeRng([6, 2, STORM_RADIUS_MAX, 2], (_p, call) => call === 0);
    weatherDay(state, rng);
    const n = state.network.spans.length;
    expect(rng.odds.slice(1, 1 + n)).toEqual(state.network.spans.map(() => 2 * STORM_UNDERGROUND_DAMAGE_CHANCE));
    expect(STORM_AERIAL_DAMAGE_CHANCE).toBeGreaterThan(STORM_UNDERGROUND_DAMAGE_CHANCE);
  });

  it('only exposes live spans in its area without an outage', () => {
    const state = stormyTown('aerial');
    const [out, permitting] = state.network.spans;
    out!.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft: 50, repairCost: 0 };
    Object.assign(permitting!, { stage: 'permitting', stageDaysLeft: 9, liveDay: null });
    state.network.version++;
    // A small storm in the far corner: radius STORM_RADIUS_MIN around (12, 4).
    const rng = new FakeRng([12, 4, STORM_RADIUS_MIN, 1], (_p, call) => call === 0);
    weatherDay(state, rng);
    const { city } = state;
    const inArea = state.network.spans.filter((s) => {
      if (s === out || s === permitting) return false;
      const seg = city.segments[s.segment]!;
      const mx = (city.nodes[seg.a]!.x + city.nodes[seg.b]!.x) / 2;
      const my = (city.nodes[seg.a]!.y + city.nodes[seg.b]!.y) / 2;
      return (mx - 12) ** 2 + (my - 4) ** 2 <= STORM_RADIUS_MIN ** 2;
    });
    expect(inArea.length).toBeGreaterThan(0);
    expect(inArea.length).toBeLessThan(state.network.spans.length - 2);
    expect(rng.odds.length - 1).toBe(inArea.length);
  });

  it('logs a storm that damages nothing, with no notice and no ledger entry', () => {
    const state = stormyTown('aerial');
    const version = state.network.version;
    weatherDay(state, new FakeRng([1, 1, STORM_RADIUS_MIN, 1], (_p, call) => call === 0));
    expect(state.weather.storms).toHaveLength(1);
    expect(state.weather.storms[0]).toMatchObject({ id: 1, spans: [], repairCost: 0 });
    expect(state.notices).toEqual([]);
    expect(state.finance.monthToDate).toEqual([]);
    expect(state.network.version).toBe(version);
    expect(state.weather.month).toMatchObject({ storms: 1, spansDamaged: 0, repairs: 0 });
  });

  it('keeps STORM_LOG_DAYS of storms, numbering them from nextStormId', () => {
    const state = stormyTown('aerial');
    state.weather.nextStormId = 41;
    state.weather.storms = [
      { id: 39, day: state.day - STORM_LOG_DAYS, x: 0, y: 0, radius: 9, severity: 1, spans: [], repairCost: 0 },
      { id: 40, day: state.day - STORM_LOG_DAYS + 2, x: 0, y: 0, radius: 9, severity: 1, spans: [], repairCost: 0 },
    ];
    weatherDay(state, new FakeRng([1, 1, STORM_RADIUS_MIN, 1], (_p, call) => call === 0));
    expect(state.weather.storms.map((s) => s.id)).toEqual([40, 41]);
    expect(state.weather.nextStormId).toBe(42);
    weatherDay(state, new FakeRng());
    expect(state.weather.storms.map((s) => s.id)).toEqual([41]);
  });
});

describe('repairs', () => {
  it('counts outages down and puts spans back in service the day they reach 0, with one notice', () => {
    const state = stormyTown('aerial');
    // 1st St is segments 0..2; its middle block stays out longest, with a subscriber on it.
    subscribe(state, parcelOn(state, 1));
    const [first, second, third] = state.network.spans;
    first!.outage = { cause: 'storm', storm: null, startDay: state.day - 1, daysLeft: 2, repairCost: 0 };
    third!.outage = { cause: 'storm', storm: null, startDay: state.day - 1, daysLeft: 2, repairCost: 0 };
    second!.outage = { cause: 'digIn', storm: null, startDay: state.day, daysLeft: 3, repairCost: 0 };
    state.network.version++;
    expect(getService(state).interruptedSegments.has(2)).toBe(true);
    const noticesBefore = state.notices.length;

    weatherDay(state, new FakeRng());
    expect(outageSpanIds(state)).toEqual([first!.id, second!.id, third!.id]);
    expect(first!.outage?.daysLeft).toBe(1);
    expect(state.notices).toHaveLength(noticesBefore);

    const version = state.network.version;
    weatherDay(state, new FakeRng());
    expect(outageSpanIds(state)).toEqual([second!.id]);
    expect(state.network.version).toBeGreaterThan(version);
    const notice = state.notices.at(-1)!;
    expect(notice.kind).toBe('serviceRestored');
    expect(notice.message).toBe('Repairs finished on 1st St: the cable is back in service.');

    // The last one brings the subscriber on 1st St back, after 3 days out.
    weatherDay(state, new FakeRng());
    expect(outageSpanIds(state)).toEqual([]);
    expect(getService(state).interruptedSegments.size).toBe(0);
    expect(state.notices.at(-1)).toMatchObject({ kind: 'serviceRestored', message: 'Repairs finished on 1st St: 1 subscriber has service again after 3 days.' });
  });

  it('names several streets and counts the subscribers who got service back', () => {
    const state = stormyTown('aerial');
    // Segment 0 feeds 1st St east of the CO; segment 3 (2nd St) and 6 (3rd St) hang off the verticals.
    for (const segment of [0, 3, 6]) subscribe(state, parcelOn(state, segment));
    // Both of the CO's streets (1st St and A Ave) and 2nd St: the whole town is cut off.
    for (const segment of [0, 3, 9]) {
      const span = state.network.spans.find((s) => s.segment === segment)!;
      span.outage = { cause: 'storm', storm: null, startDay: state.day - 4, daysLeft: 1, repairCost: 0 };
    }
    state.network.version++;
    expect(getService(state).interruptedSegments.size).toBeGreaterThan(0);
    weatherDay(state, new FakeRng());
    const notice = state.notices.at(-1)!;
    expect(getService(state).interruptedSegments.size).toBe(0);
    expect(notice.message).toBe('Repairs finished on 1st St and 2 more streets: 3 subscribers have service again after 5 days.');
  });
});

describe('dig-ins', () => {
  it('cuts underground spans at their per-mile rate, with a repair entry and a notice', () => {
    const state = stormyTown('underground');
    const span = state.network.spans[0]!;
    const segment = state.city.segments[span.segment]!;
    subscribe(state, parcelOn(state, segment.id));
    // No storm; the first span is cut, for 7 days.
    const rng = new FakeRng([7], (_p, call) => call === 1);
    weatherDay(state, rng);
    const perFtPerDay = DIG_INS_PER_MILE_PER_YEAR / 5_280 / 365;
    expect(rng.odds.slice(1)).toEqual(state.network.spans.map((s) => state.city.segments[s.segment]!.lengthFt * perFtPerDay));
    expect(span.outage).toEqual({ cause: 'digIn', storm: null, startDay: state.day, daysLeft: 7, repairCost: repairCost(segment, 'underground') });
    expect(outageSpanIds(state)).toEqual([span.id]);
    expect(repairsPosted(state)).toBe(repairCost(segment, 'underground'));
    expect(state.weather.month).toMatchObject({ storms: 0, spansDamaged: 1, repairs: repairCost(segment, 'underground') });
    expect(state.notices.at(-1)).toMatchObject({ kind: 'digIn' });
    expect(state.notices.at(-1)!.message).toContain(`on ${segment.name}: 1 subscriber cut off`);
    expect(state.notices.at(-1)!.message).toContain('7 days');
  });

  it('never cuts aerial plant (a converting span is still aerial)', () => {
    const state = stormyTown('aerial');
    state.network.spans[0]!.conversion = { stage: 'constructing', stageDaysLeft: 5, constructDays: 5, cost: 0, orderedDay: 0 };
    const rng = new FakeRng([], always);
    // The storm hits too here: only check the dig-in draws (none).
    state.network.spans.forEach((s) => (s.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft: 9, repairCost: 0 }));
    weatherDay(state, rng);
    expect(rng.odds).toEqual([STORM_CHANCE_PER_DAY]);
  });
});

describe('month accruals', () => {
  it('counts interrupted days per segment and subscriber-days, and the close reports and resets them', () => {
    const state = stormyTown('aerial');
    // Three days before a close (before storm season, so nothing else happens), counting through it.
    const close = dayOf({ year: 2027, month: 12, day: 1 });
    expect(close).toBeLessThan(STORM_START_DAY);
    state.day = close - 3;
    state.finance.cash = 10_000_000;
    subscribe(state, parcelOn(state, 2));
    subscribe(state, parcelOn(state, 1), 1);
    const leaf = state.network.spans.find((s) => s.segment === 2)!;
    leaf.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft: 30, repairCost: 0 };
    state.network.version++;
    state.weather.month.segmentOutageDays = [
      { segment: 1, days: 4 },
      { segment: 5, days: 2 },
    ];

    // The out block, and 1st St's far vertical, which falls out of the cabinet's reach without it.
    const cut = [...getService(state).interruptedSegments].sort((a, b) => a - b);
    expect(cut).toEqual([2, 12]);
    weatherDay(state, new FakeRng());
    weatherDay(state, new FakeRng());
    expect(state.weather.month.segmentOutageDays).toEqual([
      { segment: 1, days: 4 },
      { segment: 2, days: 2 },
      { segment: 5, days: 2 },
      { segment: 12, days: 2 },
    ]);
    expect(outageDaysOn(state, 2)).toBe(2);
    // One subscriber on the out street, two days.
    expect(state.weather.month.outageUnitDays).toBe(2);

    // The real close reports the month and starts a fresh one, which counts the 1st.
    tick(state);
    expect(state.day).toBe(close);
    const ops = state.finance.reports.at(-1)!.ops!;
    expect(ops).toMatchObject({ outageUnitDays: 2, storms: 0, spansDamaged: 0, repairs: 0 });
    expect(state.weather.month.segmentOutageDays).toEqual([
      { segment: 2, days: 1 },
      { segment: 12, days: 1 },
    ]);
    const stillSubscribed = state.sales.accounts.some((a) => a.parcel === parcelOn(state, 2));
    expect(state.weather.month.outageUnitDays).toBe(stillSubscribed ? 1 : 0);
  });
});

/** A storm-season session on the grid, all aerial except a few underground streets. */
const STORMY_SCRIPT: ReadonlyArray<Command | number> = [
  { type: 'placeCabinet', node: 0 },
  { type: 'layCable', segments: [0, 1, 2, 9, 10, 11, 12], method: 'aerial' },
  { type: 'layCable', segments: [3, 4, 5], method: 'underground' },
  { type: 'setMarketing', perMonth: 5_000 },
  STORM_START_DAY + 200,
  { type: 'layCable', segments: [6, 7, 8, 13, 14, 15, 16], method: 'aerial' },
  400,
];

function stormySession(seed: number, weather?: number): GameState {
  const state = newGame(seed, { city: makeGridCity() });
  state.finance.cash = 5_000_000;
  if (weather !== undefined) state.rng.weather = weather;
  for (const step of STORMY_SCRIPT) {
    if (typeof step === 'number') runDays(state, step);
    else applyCommand(state, step);
  }
  return state;
}

describe('replay and streams', () => {
  it('replays storms, outages and repairs exactly from the same seed and commands', () => {
    const a = stormySession(31);
    const b = stormySession(31);
    const storms = a.finance.reports.reduce((sum, r) => sum + (r.ops?.storms ?? 0), 0);
    const repairs = a.finance.reports.reduce((sum, r) => sum + (r.ops?.repairs ?? 0), 0);
    expect(storms).toBeGreaterThan(0);
    expect(repairs).toBeGreaterThan(0);
    expect(a.weather).toEqual(b.weather);
    expect(hashState(a)).toBe(hashState(b));
  });

  it('draws only from the weather stream: storms never shift make-ready draws', () => {
    const a = stormySession(31);
    const b = stormySession(31, 0xdecafbad);
    expect(a.weather.storms).not.toEqual(b.weather.storms);
    // The same make-ready (events stream) for every order, before and after the storms began.
    const timeline = (s: GameState) => s.network.spans.map((sp) => [sp.segment, sp.orderedDay, sp.liveDay]);
    expect(timeline(a)).toEqual(timeline(b));
    expect(a.rng.events).toBe(b.rng.events);
  });

  it('never touches the events or sales streams itself', () => {
    const state = stormyTown('aerial');
    for (const span of state.network.spans.slice(0, 6)) span.method = 'underground';
    const { events, sales } = state.rng;
    const before = state.rng.weather;
    for (let i = 0; i < 2_000; i++) {
      state.day += 1;
      withRng(state, 'weather', (rng) => stepWeather(state, rng));
    }
    expect(state.weather.nextStormId).toBeGreaterThan(5);
    expect(state.rng.weather).not.toBe(before);
    expect(state.rng).toMatchObject({ events, sales });
  });
});

describe('aerial vs underground', () => {
  it('damages aerial plant far more often than underground over many storms', () => {
    // Every other street aerial; a decade of weather days on the small town.
    const state = stormyTown('aerial');
    state.network.spans.forEach((s, i) => (s.method = i % 2 === 0 ? 'aerial' : 'underground'));
    const method = new Map(state.network.spans.map((s) => [s.id, s.method]));
    const hits = { aerial: 0, underground: 0 };
    let storms = 0;
    let seen = state.weather.nextStormId;
    const rng = new Rng(2027);
    for (let day = 0; day < 3_650; day++) {
      weatherDay(state, rng);
      for (const storm of state.weather.storms) {
        if (storm.id < seen) continue;
        storms++;
        for (const id of storm.spans) hits[method.get(id)!]++;
      }
      seen = state.weather.nextStormId;
    }
    expect(storms).toBeGreaterThan(20);
    expect(hits.aerial).toBeGreaterThan(10);
    expect(hits.aerial).toBeGreaterThan(5 * hits.underground);
  });
});
