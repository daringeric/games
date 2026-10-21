// Weather (round 4): storms, dig-ins, outages and repairs, the month's
// accruals, the storm-risk estimate, and the stream discipline (weather
// draws only from rng.weather and its per-storm and per-day sub-streams).
// Round 4b: storm exposure (zone, wooded, edge), storms that center on and
// damage exposed streets more, stormRisk exact for that model, and fair
// storm streams (two plants on one seed see the same storms).

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
  STORM_CENTER_EXPOSURE_WEIGHT,
  STORM_CHANCE_PER_DAY,
  STORM_EXPOSURE_EDGE,
  STORM_EXPOSURE_EDGE_CELLS,
  STORM_EXPOSURE_EXPOSED,
  STORM_EXPOSURE_MODERATE,
  STORM_EXPOSURE_WOODED,
  STORM_EXPOSURE_ZONE,
  STORM_LOG_DAYS,
  STORM_RADIUS_MAX,
  STORM_RADIUS_MIN,
  STORM_SEVERITY_MAX,
  STORM_START_DAY,
  STORM_UNDERGROUND_DAMAGE_CHANCE,
  STORM_CENTER_OPEN_FT,
  STORM_CENTER_REACH_CELLS,
} from './balance';
import { dayOf } from './calendar';
import { generateCity } from './citygen';
import { formatMoney } from './finance';
import { applyCommand, newGame, runDays, tick } from './game';
import { getService } from './network';
import { Rng, deriveSeed, withRng } from './rng';
import { hashState } from './save';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import { woodedAt } from './terrain';
import type { CableMethod, City, Command, GameState, Storm, Zone } from './types';
import {
  cityExposure,
  cityMeanExposure,
  cityStormCoverage,
  closeWeatherMonth,
  digInSubSeed,
  emptyWeatherMonth,
  exposureBand,
  lifetimeMethodCost,
  preferredMethod,
  segmentExposure,
  meanOutageDays,
  newWeather,
  outageChurnProbability,
  outageDaysOn,
  outageSpanIds,
  pickStormCenter,
  pointExposure,
  repairCost,
  stepWeather,
  stormAreaName,
  stormCenterWeights,
  stormCoverage,
  stormDamageChance,
  stormRisk,
  stormSubSeed,
} from './weather';

// Default grid: 12 x 4 cells, CO at node 0. Horizontal segments 0..8 are
// 240 ft and pass homes; vertical segments 9..16 are 120 ft with no frontage.
// addLivePlant cables every segment and puts a cabinet at the CO, which
// lights the whole grid.

/**
 * An Rng whose draws the test decides: int() takes the queued values in
 * order (clamped to the range; the range's minimum once the queue is empty),
 * chance() asks `decide` and records every probability it was asked about,
 * next() takes the queued uniforms (then a seeded sequence).
 */
class FakeRng extends Rng {
  readonly odds: number[] = [];
  private readonly ints: number[];
  private readonly nexts: number[];
  private readonly decide: (p: number, call: number) => boolean;

  constructor(ints: number[] = [], decide: (p: number, call: number) => boolean = () => false, nexts: number[] = []) {
    super(1);
    this.ints = [...ints];
    this.nexts = [...nexts];
    this.decide = decide;
  }

  override next(): number {
    return this.nexts.shift() ?? super.next();
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

/**
 * One weather day: the day moves on, then stepWeather with `rng` (the storm
 * sequence) and, when given, `sub` for every street's damage and dig-in
 * draws (else the real sub-streams).
 */
function weatherDay(state: GameState, rng: Rng, sub?: Rng): void {
  state.day += 1;
  stepWeather(state, rng, sub ? () => sub : undefined);
}

/** The uniform draw that makes pickStormCenter land on lattice point (x, y) of `city` (the middle of its share). */
function centerDraw(city: City, x: number, y: number): number {
  const weights = stormCenterWeights(city);
  const index = y * (city.width + 1) + x;
  let before = 0;
  let total = 0;
  for (let i = 0; i < weights.length; i++) {
    if (i < index) before += weights[i]!;
    total += weights[i]!;
  }
  expect(weights[index]!).toBeGreaterThan(0);
  return (before + weights[index]! / 2) / total;
}

/** A storm-sequence Rng for one storm at (x, y) with `radius` and `severity`. */
function stormAt(city: City, x: number, y: number, radius: number, severity: number): FakeRng {
  return new FakeRng([radius, severity], (_p, call) => call === 0, [centerDraw(city, x, y)]);
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

/**
 * The brute force of cityStormCoverage: over the radii, the share of the
 * storm-center weight (stormCenterWeights) on lattice points within r of
 * the doubled point (mx2, my2).
 */
function bruteWeightedCoverage(city: City, mx2: number, my2: number): number {
  const weights = stormCenterWeights(city);
  let all = 0;
  for (const w of weights) all += w;
  let total = 0;
  let radii = 0;
  for (let r = STORM_RADIUS_MIN; r <= STORM_RADIUS_MAX; r++) {
    let inside = 0;
    for (let y = 0; y <= city.height; y++) {
      for (let x = 0; x <= city.width; x++) {
        const dx = 2 * x - mx2;
        const dy = 2 * y - my2;
        if (dx * dx + dy * dy <= 4 * r * r) inside += weights[y * (city.width + 1) + x]!;
      }
    }
    total += inside / all;
    radii++;
  }
  return total / radii;
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

  it('expects yearly outages from storm chance x weighted coverage x exposed damage chance, plus dig-ins underground', () => {
    const state = makeTestState(city);
    const a = city.nodes[street.a]!;
    const b = city.nodes[street.b]!;
    const coverage = bruteWeightedCoverage(city, a.x + b.x, a.y + b.y);
    const exposure = segmentExposure(city, street.id);
    const meanDamage = (chance: number) => {
      let sum = 0;
      for (let s = 1; s <= STORM_SEVERITY_MAX; s++) sum += Math.min(1, s * chance * exposure);
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
    const rng = stormAt(state.city, 6, 2, STORM_RADIUS_MAX, 1);
    const sub = new FakeRng(state.network.spans.map(() => 3), always);
    weatherDay(state, rng, sub);

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
    // The storm sequence asks only the storm's own chance; each street's sub-stream asks its
    // damage chance: severity x the aerial chance x the street's exposure.
    expect(rng.odds).toEqual([STORM_CHANCE_PER_DAY]);
    const exposure = cityExposure(state.city);
    expect(sub.odds).toEqual(spans.map((s) => Math.min(1, STORM_AERIAL_DAMAGE_CHANCE * exposure[s.segment]!)));
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
    const rng = stormAt(state.city, 6, 2, STORM_RADIUS_MAX, 2);
    const sub = new FakeRng();
    weatherDay(state, rng, sub);
    const n = state.network.spans.length;
    const exposure = cityExposure(state.city);
    expect(sub.odds.slice(0, n)).toEqual(state.network.spans.map((s) => Math.min(1, 2 * STORM_UNDERGROUND_DAMAGE_CHANCE * exposure[s.segment]!)));
    expect(STORM_AERIAL_DAMAGE_CHANCE).toBeGreaterThan(STORM_UNDERGROUND_DAMAGE_CHANCE);
  });

  it('only exposes live spans in its area without an outage', () => {
    const state = stormyTown('aerial');
    const [out, permitting] = state.network.spans;
    out!.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft: 50, repairCost: 0 };
    Object.assign(permitting!, { stage: 'permitting', stageDaysLeft: 9, liveDay: null });
    state.network.version++;
    // A small storm in the far corner: radius STORM_RADIUS_MIN around (12, 4).
    const rng = stormAt(state.city, 12, 4, STORM_RADIUS_MIN, 1);
    // Only the storm's rolls: dig-ins never come up on aerial plant.
    const sub = new FakeRng();
    weatherDay(state, rng, sub);
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
    expect(rng.odds).toEqual([STORM_CHANCE_PER_DAY]);
    expect(sub.odds.length).toBe(inArea.length);
    expect(state.weather.storms[0]).toMatchObject({ x: 12, y: 4, radius: STORM_RADIUS_MIN });
  });

  it('logs a storm that damages nothing, with no notice and no ledger entry', () => {
    const state = stormyTown('aerial');
    const version = state.network.version;
    weatherDay(state, stormAt(state.city, 1, 1, STORM_RADIUS_MIN, 1), new FakeRng());
    expect(state.weather.storms).toHaveLength(1);
    expect(state.weather.storms[0]).toMatchObject({ id: 1, x: 1, y: 1, spans: [], repairCost: 0 });
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
    weatherDay(state, stormAt(state.city, 1, 1, STORM_RADIUS_MIN, 1), new FakeRng());
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
    const rng = new FakeRng();
    const sub = new FakeRng([7], (_p, call) => call === 0);
    weatherDay(state, rng, sub);
    const perFtPerDay = DIG_INS_PER_MILE_PER_YEAR / 5_280 / 365;
    expect(rng.odds).toEqual([STORM_CHANCE_PER_DAY]);
    expect(sub.odds).toEqual(state.network.spans.map((s) => state.city.segments[s.segment]!.lengthFt * perFtPerDay));
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
    const sub = new FakeRng([], always);
    // The storm hits too here: only check the dig-in draws (none).
    state.network.spans.forEach((s) => (s.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft: 9, repairCost: 0 }));
    weatherDay(state, rng, sub);
    expect(rng.odds).toEqual([STORM_CHANCE_PER_DAY]);
    expect(sub.odds).toEqual([]);
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

describe('round 4b: exposure and the lifetime method (contract)', () => {
  it('bands exposures at the balance thresholds', () => {
    expect(exposureBand(STORM_EXPOSURE_MODERATE - 0.01)).toBe('sheltered');
    expect(exposureBand(STORM_EXPOSURE_MODERATE)).toBe('moderate');
    expect(exposureBand(STORM_EXPOSURE_EXPOSED - 0.01)).toBe('moderate');
    expect(exposureBand(STORM_EXPOSURE_EXPOSED)).toBe('exposed');
  });

  it('gives every street of a generated town an exposure, deterministic from the city', () => {
    const a = newGame(2027);
    const b = newGame(2027);
    const exposure = cityExposure(a.city);
    expect(exposure).toHaveLength(a.city.segments.length);
    expect(cityExposure(a.city)).toBe(exposure);
    expect([...cityExposure(b.city)]).toEqual([...exposure]);
    for (const [i, x] of exposure.entries()) {
      expect(Number.isFinite(x) && x >= 0).toBe(true);
      expect(x).toBe(segmentExposure(a.city, i));
    }
  });

  it('prefers the method with the lower lifetime cost, and underground where there are no poles', () => {
    const state = makeTestState(makeGridCity());
    for (const segment of state.city.segments) {
      const aerial = lifetimeMethodCost(state, segment, 'aerial');
      const underground = lifetimeMethodCost(state, segment, 'underground');
      const expected = !segment.hasPoles ? 'underground' : aerial <= underground ? 'aerial' : 'underground';
      expect(preferredMethod(state, segment)).toBe(expected);
      expect(underground).toBeGreaterThan(0);
    }
    const unpoled = { ...state.city.segments[0]!, hasPoles: false };
    expect(preferredMethod(state, unpoled)).toBe('underground');
  });
});

describe('round 4b: the exposure terms the contract implements (zone and edge)', () => {
  it('rates rural streets on the edge above sheltered downtown blocks in the middle', () => {
    const city = makeGridCity();
    const mid = city.segments.find((s) => s.id === 4)!;
    const edgeSeg = city.segments[0]!;
    const asZone = (zone: Zone) => ({ ...city, segments: city.segments.map((s) => (s.id === mid.id || s.id === edgeSeg.id ? { ...s, zone } : s)) });
    const rural = asZone('rural');
    const downtown = asZone('downtown');
    expect(segmentExposure(rural, edgeSeg.id)).toBeGreaterThan(segmentExposure(downtown, edgeSeg.id));
    expect(segmentExposure(rural, edgeSeg.id)).toBeGreaterThanOrEqual(STORM_EXPOSURE_ZONE.rural);
    expect(segmentExposure(downtown, mid.id)).toBeLessThanOrEqual(segmentExposure(downtown, edgeSeg.id));
    expect(segmentExposure(city, 9_999)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round 4b (storms-balance): the exposure model, storms that favour exposed
// streets, stormRisk exact for it, and fair storm streams.
// ---------------------------------------------------------------------------

/** The tuning towns (tuning/harness TUNING_SEEDS) and a few more. */
const TOWN_SEEDS = [1, 2027, 424242, 99, 12345, 7];
const towns = new Map<number, City>();
const town = (seed: number): City => {
  let city = towns.get(seed);
  if (!city) {
    city = generateCity(seed);
    towns.set(seed, city);
  }
  return city;
};

/** The doubled midpoint of a street. */
function mid2(city: City, segment: number): { mx2: number; my2: number } {
  const seg = city.segments[segment]!;
  return { mx2: city.nodes[seg.a]!.x + city.nodes[seg.b]!.x, my2: city.nodes[seg.a]!.y + city.nodes[seg.b]!.y };
}

/** A storm-sequence Rng that brings a storm every day (the rest of its draws are real). */
class StormEveryDay extends Rng {
  override chance(p: number): boolean {
    return p === STORM_CHANCE_PER_DAY ? true : super.chance(p);
  }
}

describe('round 4b: storm exposure', () => {
  it('is zone x (1 + wooded) x (1 + edge), wooded from the grove field at the midpoint', () => {
    for (const seed of [2027, 99]) {
      const city = town(seed);
      for (const seg of city.segments) {
        const { mx2, my2 } = mid2(city, seg.id);
        const wooded = woodedAt(city, mx2 / 2, my2 / 2);
        expect(wooded).toBeGreaterThanOrEqual(0);
        expect(wooded).toBeLessThanOrEqual(1);
        const toEdge = Math.min(mx2, my2, 2 * city.width - mx2, 2 * city.height - my2) / 2;
        const edge = Math.max(0, 1 - toEdge / STORM_EXPOSURE_EDGE_CELLS);
        const expected = STORM_EXPOSURE_ZONE[seg.zone] * (1 + STORM_EXPOSURE_WOODED * wooded) * (1 + STORM_EXPOSURE_EDGE * edge);
        expect(segmentExposure(city, seg.id)).toBeCloseTo(expected, 12);
      }
    }
  });

  it('rates a street through open, wooded country above the same street between lots', () => {
    const city = town(2027);
    // The same town with every lot cleared: open country everywhere, so streets read as wooded as the groves they run through.
    const open: City = { ...city, parcels: [] };
    let raised = 0;
    for (const seg of city.segments) {
      expect(segmentExposure(open, seg.id)).toBeGreaterThanOrEqual(segmentExposure(city, seg.id));
      if (segmentExposure(open, seg.id) > segmentExposure(city, seg.id) + 0.05) raised++;
    }
    expect(raised).toBeGreaterThan(city.segments.length / 4);
    // And the wooded term counts: some streets of the town itself sit among trees.
    expect(city.segments.some((s) => woodedAt(city, mid2(city, s.id).mx2 / 2, mid2(city, s.id).my2 / 2) > 0.3)).toBe(true);
  });

  it('averages about 1 over a generated town, with sheltered, moderate and exposed streets', () => {
    for (const seed of TOWN_SEEDS) {
      const city = town(seed);
      const exposure = cityExposure(city);
      const feet = { sheltered: 0, moderate: 0, exposed: 0 };
      let sum = 0;
      let all = 0;
      for (const seg of city.segments) {
        sum += exposure[seg.id]! * seg.lengthFt;
        all += seg.lengthFt;
        feet[exposureBand(exposure[seg.id]!)] += seg.lengthFt;
      }
      expect(sum / all, `seed ${seed} mean`).toBeGreaterThan(0.95);
      expect(sum / all, `seed ${seed} mean`).toBeLessThan(1.2);
      expect(feet.sheltered / all, `seed ${seed} sheltered`).toBeGreaterThan(0.03);
      expect(feet.exposed / all, `seed ${seed} exposed`).toBeGreaterThan(0.05);
      expect(feet.moderate / all, `seed ${seed} moderate`).toBeGreaterThan(0.5);
      // Rural streets are the most exposed, downtown the least.
      const meanOf = (zone: Zone) => {
        const segs = city.segments.filter((s) => s.zone === zone);
        return segs.reduce((t, s) => t + exposure[s.id]!, 0) / Math.max(1, segs.length);
      };
      expect(meanOf('rural')).toBeGreaterThan(meanOf('residential'));
      expect(meanOf('residential')).toBeGreaterThan(meanOf('downtown'));
    }
  });

  it('is a pure function of the city: the same for a regenerated town, and never stored in the game', () => {
    const a = generateCity(424242);
    const b = generateCity(424242);
    expect([...cityExposure(b)]).toEqual([...cityExposure(a)]);
    const state = newGame(424242);
    expect(JSON.stringify(state)).not.toContain('exposure');
  });
});

describe('round 4b: storms favour exposed areas', () => {
  it("rates a lattice point by its streets' exposure, and open country as the town's average street", () => {
    // A rural grid in the corner of a big, empty map.
    const base = makeGridCity();
    for (const seg of base.segments) seg.zone = 'rural';
    const city: City = { ...base, width: 60, height: 40 };
    const exposure = cityExposure(city);
    let feet = 0;
    let sum = 0;
    for (const seg of city.segments) {
      feet += seg.lengthFt;
      sum += exposure[seg.id]! * seg.lengthFt;
    }
    expect(cityMeanExposure(city)).toBeCloseTo(sum / feet, 12);
    // Far from every street: the town's mean exposure (off the lattice: 1).
    expect(pointExposure(city, 60, 40)).toBeCloseTo(cityMeanExposure(city), 12);
    expect(pointExposure(city, 40, 30)).toBeCloseTo(cityMeanExposure(city), 12);
    expect(pointExposure(city, -1, 0)).toBe(1);
    // Among the streets: between their exposures, all of them exposed.
    const near = pointExposure(city, 6, 2);
    expect(near).toBeGreaterThanOrEqual(Math.min(...exposure) - 1e-12);
    expect(near).toBeLessThanOrEqual(Math.max(...exposure) + 1e-12);
    expect(near).toBeGreaterThan(1);
    // A downtown grid well inside the map: sheltered, below 1.
    const downtown: City = { ...base, segments: base.segments.map((s) => ({ ...s, zone: 'downtown' as Zone })), nodes: base.nodes.map((n) => ({ ...n, x: n.x + 30, y: n.y + 20 })), width: 72, height: 44 };
    expect(pointExposure(downtown, 36, 22)).toBeLessThan(1);
    // Reach: a point just past STORM_CENTER_REACH_CELLS from every midpoint rates as open country.
    expect(pointExposure(downtown, 36 + 12 + STORM_CENTER_REACH_CELLS, 22)).toBeCloseTo(cityMeanExposure(downtown), 12);
    // A street's own corner rates nearer its exposure than open country does (STORM_CENTER_OPEN_FT is a light prior).
    const corner = pointExposure(city, 4, 2);
    expect(Math.abs(corner - cityMeanExposure(city))).toBeLessThanOrEqual(Math.max(...exposure) - Math.min(...exposure) + 1e-12);
    expect(STORM_CENTER_OPEN_FT).toBeGreaterThan(0);
  });

  it('weighs every lattice point 1 + STORM_CENTER_EXPOSURE_WEIGHT x (exposure - 1), and draws centers by those weights', () => {
    const city = town(2027);
    const weights = stormCenterWeights(city);
    expect(weights).toHaveLength((city.width + 1) * (city.height + 1));
    for (let y = 0; y <= city.height; y += 7) {
      for (let x = 0; x <= city.width; x += 5) {
        const w = weights[y * (city.width + 1) + x]!;
        expect(w).toBeCloseTo(Math.max(0, 1 + STORM_CENTER_EXPOSURE_WEIGHT * (pointExposure(city, x, y) - 1)), 12);
        if (w > 0) expect(pickStormCenter(city, centerDraw(city, x, y))).toEqual({ x, y });
      }
    }
    expect(pickStormCenter(city, 0)).toEqual({ x: 0, y: 0 });
    expect(pickStormCenter(city, 1 - 1e-12)).toEqual({ x: city.width, y: city.height });
    // Centers drawn over many storms sit in more exposed areas than the lattice on average.
    const rng = new Rng(5);
    let drawn = 0;
    const n = 4_000;
    for (let i = 0; i < n; i++) {
      const c = pickStormCenter(city, rng.next());
      drawn += pointExposure(city, c.x, c.y);
    }
    let lattice = 0;
    for (let y = 0; y <= city.height; y++) for (let x = 0; x <= city.width; x++) lattice += pointExposure(city, x, y);
    lattice /= weights.length;
    expect(drawn / n).toBeGreaterThan(lattice + 0.02);
  });

  it('measures weighted coverage exactly, and uniform weights give round 4 coverage', () => {
    const city = town(99);
    const segments = [0, 37, 120, city.segments.length - 1];
    for (const id of segments) {
      const { mx2, my2 } = mid2(city, id);
      expect(cityStormCoverage(city, mx2, my2), `segment ${id}`).toBeCloseTo(bruteWeightedCoverage(city, mx2, my2), 12);
    }
    for (const [mx2, my2] of [
      [0, 0],
      [2 * city.width, 1],
      [95, 64],
    ] as const) {
      expect(cityStormCoverage(city, mx2, my2)).toBeCloseTo(bruteWeightedCoverage(city, mx2, my2), 12);
    }
    // All weights 1: the round-4 count.
    const w1 = 13;
    const h1 = 9;
    const prefix = new Float64Array(w1 * (h1 + 1));
    for (let x = 0; x < w1; x++) for (let y = 0; y <= h1; y++) prefix[x * (h1 + 1) + y] = y;
    expect(stormCoverage(12, 8, 7, 9, { prefix, total: w1 * h1 })).toBeCloseTo(stormCoverage(12, 8, 7, 9), 12);
  });

  it('scales a span\'s damage chance by its street\'s exposure, capped at 1', () => {
    for (const method of ['aerial', 'underground'] as const) {
      const base = method === 'aerial' ? STORM_AERIAL_DAMAGE_CHANCE : STORM_UNDERGROUND_DAMAGE_CHANCE;
      for (const severity of [1, 2, STORM_SEVERITY_MAX]) {
        expect(stormDamageChance(method, severity, 1)).toBeCloseTo(Math.min(1, severity * base), 12);
        expect(stormDamageChance(method, severity, 1.7)).toBeCloseTo(Math.min(1, severity * base * 1.7), 12);
        expect(stormDamageChance(method, severity, 0)).toBe(0);
        expect(stormDamageChance(method, severity, 1e9)).toBe(1);
      }
    }
    expect(stormDamageChance('aerial', 2, 1.5)).toBeGreaterThan(stormDamageChance('aerial', 2, 0.6));
  });

  it('makes stormRisk exactly the model: weighted coverage x the exposed damage chance', () => {
    const city = town(2027);
    const state = makeTestState(city);
    const exposure = cityExposure(city);
    const byBand = (band: string) => city.segments.find((s) => exposureBand(exposure[s.id]!) === band && s.hasPoles)!;
    for (const seg of [byBand('sheltered'), byBand('moderate'), byBand('exposed')]) {
      const { mx2, my2 } = mid2(city, seg.id);
      const coverage = bruteWeightedCoverage(city, mx2, my2);
      for (const method of ['aerial', 'underground'] as const) {
        let damage = 0;
        for (let s = 1; s <= STORM_SEVERITY_MAX; s++) damage += stormDamageChance(method, s, exposure[seg.id]!);
        damage /= STORM_SEVERITY_MAX;
        const digIns = method === 'underground' ? (seg.lengthFt / 5_280) * DIG_INS_PER_MILE_PER_YEAR : 0;
        const risk = stormRisk(state, seg, method);
        expect(risk.outagesPerYear).toBeCloseTo(365 * STORM_CHANCE_PER_DAY * coverage * damage + digIns, 10);
        expect(risk.repairCostPerYear).toBeCloseTo(risk.outagesPerYear * repairCost(seg, method), 8);
        // A copy of the segment (as the UI and tests pass) rates the same.
        expect(stormRisk(state, { ...seg }, method)).toEqual(risk);
      }
    }
    // An exposed street's aerial repairs a year run well above a sheltered one's of the same length.
    const perFt = (seg: (typeof city.segments)[number]) => stormRisk(state, seg, 'aerial').outagesPerYear;
    expect(perFt(byBand('exposed'))).toBeGreaterThan(1.5 * perFt(byBand('sheltered')));
  });

  it('hits exposed streets clearly more often than sheltered ones over many storms, as stormRisk expects', () => {
    const city = town(2027);
    const state = makeTestState(city);
    addLivePlant(state, { node: null });
    for (const span of state.network.spans) span.method = 'aerial';
    state.day = STORM_START_DAY;
    const exposure = cityExposure(city);
    const hits = new Map<number, number>();
    const rng = new StormEveryDay(77);
    const days = 3_000;
    let seen = state.weather.nextStormId;
    for (let day = 0; day < days; day++) {
      weatherDay(state, rng);
      for (const storm of state.weather.storms) {
        if (storm.id < seen) continue;
        for (const id of storm.spans) {
          const segment = state.network.spans.find((s) => s.id === id)!.segment;
          hits.set(segment, (hits.get(segment) ?? 0) + 1);
        }
      }
      seen = state.weather.nextStormId;
      // Mend everything at once, so every storm meets the whole plant.
      for (const span of state.network.spans) span.outage = null;
      state.network.version++;
    }
    const tally = { sheltered: { hits: 0, spans: 0, expected: 0 }, moderate: { hits: 0, spans: 0, expected: 0 }, exposed: { hits: 0, spans: 0, expected: 0 } };
    for (const seg of city.segments) {
      const t = tally[exposureBand(exposure[seg.id]!)];
      t.hits += hits.get(seg.id) ?? 0;
      t.spans++;
      // stormRisk's outages a year come from 365 x STORM_CHANCE_PER_DAY storms; here every day brings one.
      t.expected += (stormRisk(state, seg, 'aerial').outagesPerYear / (365 * STORM_CHANCE_PER_DAY)) * days;
    }
    for (const band of ['sheltered', 'moderate', 'exposed'] as const) {
      const t = tally[band];
      expect(t.spans, band).toBeGreaterThan(5);
      // Within sampling noise (hits under one storm move together, so the noise is wider than Poisson's).
      expect(t.hits / t.expected, `${band}: ${t.hits} hits, ${t.expected.toFixed(0)} expected`).toBeGreaterThan(0.75);
      expect(t.hits / t.expected, `${band}: ${t.hits} hits, ${t.expected.toFixed(0)} expected`).toBeLessThan(1.25);
    }
    const rate = (band: keyof typeof tally) => tally[band].hits / tally[band].spans;
    expect(rate('exposed')).toBeGreaterThan(2 * rate('sheltered'));
    expect(rate('exposed')).toBeGreaterThan(rate('moderate'));
  });
});

describe('round 4b: fair storm streams', () => {
  it('derives each storm\'s and each day\'s per-street draws from its seed, the storm or day, and the street', () => {
    expect(stormSubSeed(9, 4, 17)).toBe(deriveSeed(deriveSeed(9, 'storm 4'), 'street 17'));
    expect(digInSubSeed(9, 400, 17)).toBe(deriveSeed(deriveSeed(9, 'digIn 400'), 'street 17'));
    const seeds = new Set([stormSubSeed(9, 4, 17), stormSubSeed(9, 5, 17), stormSubSeed(9, 4, 18), stormSubSeed(10, 4, 17), digInSubSeed(9, 4, 17)]);
    expect(seeds.size).toBe(5);
  });

  it('draws the same storm sequence from the weather stream whatever the plant', () => {
    const aerial = stormyTown('aerial');
    const underground = stormyTown('underground');
    underground.network.spans.splice(5);
    underground.network.version++;
    for (let i = 0; i < 1_000; i++) {
      for (const state of [aerial, underground]) {
        state.day += 1;
        withRng(state, 'weather', (rng) => stepWeather(state, rng));
      }
      expect(underground.rng.weather).toBe(aerial.rng.weather);
    }
    const sequence = (s: GameState) => s.weather.storms.map(({ id, day, x, y, radius, severity }) => ({ id, day, x, y, radius, severity }));
    expect(sequence(aerial).length).toBeGreaterThan(5);
    expect(sequence(underground)).toEqual(sequence(aerial));
    expect(aerial.weather.storms.some((s) => s.spans.length > 0)).toBe(true);
  });

  it('gives two different plants on one seed the same storms, and the same damage on a street both cabled aerial', () => {
    const play = (rest: Command): GameState => {
      const state = newGame(31, { city: makeGridCity() });
      state.finance.cash = 5_000_000;
      applyCommand(state, { type: 'placeCabinet', node: 0 });
      applyCommand(state, { type: 'layCable', segments: [0, 1, 2, 9], method: 'aerial' });
      applyCommand(state, rest);
      runDays(state, STORM_START_DAY + 500);
      return state;
    };
    const a = play({ type: 'layCable', segments: [3, 4, 5, 10, 11, 12], method: 'aerial' });
    const b = play({ type: 'layCable', segments: [6, 7, 8, 13, 14], method: 'underground' });
    const sequence = (s: GameState) => s.weather.storms.map(({ id, day, x, y, radius, severity }) => ({ id, day, x, y, radius, severity }));
    expect(sequence(a).length).toBeGreaterThan(3);
    expect(sequence(b)).toEqual(sequence(a));
    // The streets both cabled aerial (0, 1, 2 and 9) took the same storm damage in both games.
    const shared = new Set([0, 1, 2, 9]);
    const damage = (s: GameState) =>
      s.weather.storms.map((storm) =>
        storm.spans
          .map((id) => s.network.spans.find((sp) => sp.id === id)!.segment)
          .filter((seg) => shared.has(seg))
          .sort((p, q) => p - q),
      );
    expect(damage(b)).toEqual(damage(a));
    expect(damage(a).some((d) => d.length > 0)).toBe(true);
  });
});
