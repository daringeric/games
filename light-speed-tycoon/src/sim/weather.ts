// Weather (round 4): seeded storms that damage aerial plant far more than
// underground, dig-ins on underground plant, outages and their repair, and
// the month's outage totals.
//
// Owner: sim-storms workstream.
//
// Rules shared by every function here:
// - Pure sim (README): randomness only from the `rng` argument, which
//   game.tick takes from state.rng.weather (withRng(state, 'weather')), so
//   storms never shift the events (make-ready) or sales streams.
// - Arithmetic and Math.sqrt only. Deterministic iteration (spans in
//   network.spans order, segments ascending).
// - Money is whole dollars at the point it is posted. Repairs are an
//   operating cost: one 'repair' ledger entry per storm or dig-in, posted
//   the day of the damage even when cash goes negative (like overhead).
// - Damage lives on the spans (CableSpan.outage). Every outage that starts
//   or ends bumps network.version, so the service snapshot (and its
//   interruptedSegments) and the map catch up.
//
// Daily (game.tick, after advanceNetwork and before stepSales):
//   stepWeather(state, rng)
// Month close (finance.closeMonth, right after sales.closeSalesMonth, which
// charges outage churn for the month's days in Weather.cutOff):
//   closeWeatherMonth(state)
//
// Round 4b (storms-balance workstream): storms favour exposed streets (rural
// streets, wooded streets, the map's edges: segmentExposure, deterministic
// from the city), both where they center (stormCenterWeights) and how much
// they damage; stormRisk counts both exactly, preferredMethod judges a
// street's method over its lifetime with it, and the map has an exposure
// overlay (cityExposure, exposureBand). Fair comparisons: the weather
// stream draws the same each day whatever the plant (the storm chance; for a
// storm its center, radius, severity and a storm seed; a dig-in seed for the
// day), and each storm's damage rolls and outage lengths, and each day's
// dig-ins, come from sub-streams derived from those seeds, the storm id or
// the day, and the street (stormSubSeed, digInSubSeed): two plants on one
// seed see the same storms, and a street cabled in both gets the same rolls.
//
// Round 4c/4d (sim-economy, spec D: storm economics): exposure varies
// inside the town. Old residential neighborhoods are tree-lined
// (streetCanopy, from terrain.canopyAt: the grove field, drawn independently
// of the lots), and on a tree-lined street aerial cable takes up to
// 1 + STORM_EXPOSURE_CANOPY times the storm damage of an open street, a
// repair costs up to 1 + REPAIR_CANOPY_SHARE times as much and an outage
// lasts longer (its days drawn from the top of the usual range: more
// cancellations, more days not billed). The method choice (methodYearlyCost, lifetimeMethodCost,
// buryPayback, preferredMethod) weighs pole rent, those repairs and the
// outage cost of the street's customers against the extra cost of a bore,
// counting up-front money METHOD_UPFRONT_WEIGHT times (growth is bound by
// capital): burying a tree-lined block pays back within a few years, while
// open and sheltered blocks stay aerial.

import {
  BUILD_METHOD_HORIZON_YEARS,
  DIG_INS_PER_MILE_PER_YEAR,
  LOST_CUSTOMER_MONTHS,
  METHOD_UPFRONT_WEIGHT,
  OUTAGE_CHURN_BASE,
  OUTAGE_CHURN_MAX,
  OUTAGE_CHURN_PER_DAY,
  OUTAGE_DAYS_AERIAL_MAX,
  OUTAGE_DAYS_AERIAL_MIN,
  OUTAGE_DAYS_CANOPY,
  OUTAGE_DAYS_UNDERGROUND_MAX,
  OUTAGE_DAYS_UNDERGROUND_MIN,
  POLE_RENT_PER_POLE_PER_MONTH,
  REPAIR_BASE_AERIAL,
  REPAIR_BASE_UNDERGROUND,
  REPAIR_CANOPY_SHARE,
  REPAIR_PER_FT_AERIAL,
  REPAIR_PER_FT_UNDERGROUND,
  STORM_AERIAL_DAMAGE_CHANCE,
  STORM_CANOPY_ZONE,
  STORM_CENTER_EXPOSURE_WEIGHT,
  STORM_CENTER_OPEN_FT,
  STORM_CENTER_REACH_CELLS,
  STORM_CHANCE_PER_DAY,
  STORM_EXPOSURE_CANOPY,
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
} from './balance';
import { formatMoney, groupThousands, postEntry } from './finance';
import { getService, outageService, spanCharges } from './network';
import { postNotice } from './notices';
import { Rng, deriveSeed } from './rng';
import { perCustomerCost } from './overhead';
import { accountUnits, stateTakeRate, tierMix, unitPrice } from './sales';
import { cornerName, polesOnSegment } from './streets';
import { canopyAt, woodedAt } from './terrain';
import type {
  AccountOutage,
  CableMethod,
  CableSpan,
  City,
  ExposureBand,
  GameState,
  NodeId,
  ParcelId,
  ParcelKind,
  SegmentId,
  ServiceSnapshot,
  Storm,
  StormRisk,
  StreetSegment,
  Weather,
  WeatherMonth,
} from './types';

const FT_PER_MILE = 5_280;
const DAYS_PER_YEAR = 365;
/** Days in the month the method choice prices an outage day's unbilled service at (a bill covers about this many days). */
export const DAYS_PER_BILL = 30;
/**
 * Most days one WeatherMonth.segmentOutageDays entry can hold (the longest
 * month). Normal play never reaches it, since every close resets the month;
 * the cap keeps a hand-edited save that starts a month near it loadable.
 */
const MONTH_DAYS_MAX = 31;
/**
 * Most days one Weather.cutOff count can hold. An entry lasts only while its
 * subscriber is cut off plus the rest of that month; the cap keeps a street
 * that outages keep cutting off for months a sane number (the churn it
 * charges is capped at OUTAGE_CHURN_MAX long before).
 */
export const CUT_OFF_DAYS_MAX = 366;

/** Month totals with nothing in them. */
export function emptyWeatherMonth(): WeatherMonth {
  return { segmentOutageDays: [], outageUnitDays: 0, storms: 0, spansDamaged: 0, repairs: 0 };
}

/** Weather for a new game and for saves migrated from schemaVersion 3: no storms yet. */
export function newWeather(): Weather {
  return { storms: [], nextStormId: 1, month: emptyWeatherMonth(), cutOff: [] };
}

/**
 * Where a storm's or a day's draws for one street come from: an Rng on the
 * seed derived for that street (stormSubSeed, digInSubSeed). The game uses a
 * fresh Rng on it; tests may hand out their own.
 */
export type SubStream = (seed: number) => Rng;

const freshRng: SubStream = (seed) => new Rng(seed);

/**
 * One day of weather for the new state.day (game.tick, after advanceNetwork,
 * before stepSales; never on day 0 or after game over). In order:
 * 1. Repairs: every span with an outage counts daysLeft down by 1; one that
 *    reaches 0 is back in service (outage = null). If any came back, bump
 *    network.version and post one 'serviceRestored' notice for the day
 *    ("Repairs finished on Elm St and 2 more streets: 37 subscribers have
 *    service again after 4 days."). Storms older than STORM_LOG_DAYS leave
 *    the log.
 * 2. Storms: from STORM_START_DAY, with probability STORM_CHANCE_PER_DAY
 *    (rng.chance) a storm hits: center pickStormCenter(city, rng.next()) (a
 *    lattice point drawn by stormCenterWeights: exposed areas more often),
 *    radius rng.int(STORM_RADIUS_MIN, STORM_RADIUS_MAX), severity
 *    rng.int(1, STORM_SEVERITY_MAX), its seed drawSeed(rng), id
 *    weather.nextStormId: the weather stream draws the same whatever the
 *    plant. Each live span without an outage whose segment midpoint is within
 *    the radius is damaged with probability stormDamageChance(method,
 *    severity, its street's exposure) (a span being converted is still
 *    aerial), drawn from subStream(stormSubSeed(storm seed, id, segment)),
 *    which then draws its days out after a hit. Damage: outage = { cause:
 *    'storm', storm: id, startDay: day, daysLeft:
 *    int(OUTAGE_DAYS_<method>_MIN, _MAX), repairCost: repairCost(segment,
 *    method) }, one 'repair' ledger entry for
 *    the storm's total, network.version bumped and one 'storm' notice naming
 *    the area (the corner nearest its center), spans down, subscribers cut
 *    off, the repair cost and how long. The Storm is appended to
 *    weather.storms either way: one that damages nothing is logged (the map
 *    shows it) but posts no notice.
 * 3. Dig-ins: from STORM_START_DAY, the day's seed drawSeed(rng) (drawn
 *    every day, plant or not); each live underground span without an outage
 *    is cut with probability lengthFt / 5,280 x DIG_INS_PER_MILE_PER_YEAR /
 *    365, drawn (then its days out) from subStream(digInSubSeed(day seed,
 *    state.day, segment)); cause 'digIn', storm null, each posting a
 *    'repair' entry and a 'digIn' notice.
 * 4. Month accrual: every segment in getService(state).interruptedSegments
 *    adds 1 to its WeatherMonth.segmentOutageDays entry (sorted, one per
 *    segment); every account cut off today (network.outageService: an
 *    outage cuts its own cabinet off from its street, and no other cabinet
 *    that still reaches it has a port free for it) adds 1 day to its
 *    Weather.cutOff entry (its units: the most cut off on one day) and its
 *    units to outageUnitDays; an entry carried over a close (days 0) whose
 *    account has service again is dropped (that outage is over and fully
 *    charged), as are entries of parcels with no account any more. Storms,
 *    spansDamaged and repairs counted up as they happen above.
 */
export function stepWeather(state: GameState, rng: Rng, subStream: SubStream = freshRng): void {
  repairSpans(state);
  dropOldStorms(state);
  if (state.day >= STORM_START_DAY) {
    if (rng.chance(STORM_CHANCE_PER_DAY)) stormHits(state, rng, subStream);
    digIns(state, drawSeed(rng), subStream);
  }
  accrueOutages(state);
}

/** Labels of the weather sub-streams (deriveSeed): a storm's, a day's dig-ins, and one street's under either. */
const SUB_STREAM = { storm: 'storm ', digIn: 'digIn ', street: 'street ' } as const;

/** A uint32 seed drawn from the weather stream (one draw). */
function drawSeed(rng: Rng): number {
  return Math.floor(rng.next() * 4294967296) >>> 0;
}

/** The base of storm `storm`'s draws, from the seed the weather stream drew for it. */
function stormSeedOf(seed: number, storm: number): number {
  return deriveSeed(seed, `${SUB_STREAM.storm}${storm}`);
}

/** The base of day `day`'s dig-in draws, from the seed the weather stream drew for the day. */
function digInSeedOf(seed: number, day: number): number {
  return deriveSeed(seed, `${SUB_STREAM.digIn}${day}`);
}

/** The seed of one street's draws under a storm or on a day: derived from the storm's or day's seed and the segment. */
function streetSeed(base: number, segment: SegmentId): number {
  return deriveSeed(base, `${SUB_STREAM.street}${segment}`);
}

/**
 * The seed of storm `storm`'s draws on street `segment` (its damage roll,
 * then its days out after a hit): from the storm's seed (drawn from the
 * weather stream, which draws the same whatever the plant), the storm id and
 * the street alone, so every plant on one game seed rolls the same for that
 * street.
 */
export function stormSubSeed(seed: number, storm: number, segment: SegmentId): number {
  return streetSeed(stormSeedOf(seed, storm), segment);
}

/** The seed of day `day`'s dig-in draw on street `segment` (then its days out): from the day's seed (drawn from the weather stream), the day and the street alone. */
export function digInSubSeed(seed: number, day: number, segment: SegmentId): number {
  return streetSeed(digInSeedOf(seed, day), segment);
}

/** What the weather part of a month close counted (the month's totals before the reset). */
export interface WeatherClose {
  outageUnitDays: number;
  storms: number;
  spansDamaged: number;
  repairs: number;
}

/**
 * Month close (finance.closeMonth, right after sales.closeSalesMonth, which
 * charged outage churn for each Weather.cutOff entry's days, outageChargeOf):
 * return the month's totals, reset weather.month to emptyWeatherMonth(), and
 * keep the entries of accounts still cut off, their days moved to `charged`
 * (so the next close charges only the days that outage adds: its base churn
 * is charged once); the rest are dropped. Outages themselves carry on across
 * the close.
 */
export function closeWeatherMonth(state: GameState): WeatherClose {
  const { weather } = state;
  const month = weather.month;
  weather.month = emptyWeatherMonth();
  if (weather.cutOff.length > 0) {
    const { cutOff } = outageService(state, getService(state));
    const kept: AccountOutage[] = [];
    for (const entry of weather.cutOff) {
      // Cut off at the close (so the account exists).
      if (!cutOff.has(entry.parcel)) continue;
      kept.push({ parcel: entry.parcel, days: 0, charged: Math.min(CUT_OFF_DAYS_MAX, entry.charged + entry.days), units: entry.units });
    }
    weather.cutOff = kept;
  }
  return { outageUnitDays: month.outageUnitDays, storms: month.storms, spansDamaged: month.spansDamaged, repairs: month.repairs };
}

/** Binary search of Weather.cutOff (ascending by parcel). */
function cutOffEntry(state: GameState, parcel: ParcelId): AccountOutage | undefined {
  const entries = state.weather.cutOff;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = entries[mid] as AccountOutage;
    if (entry.parcel === parcel) return entry;
    if (entry.parcel < parcel) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/**
 * The account on `parcel`'s current or latest outage (Weather.cutOff): its
 * days cut off since the last close (`days`, not charged yet), the days of
 * the same outage charged at earlier closes (`charged`: it was still cut off
 * then) and the most of its units cut off on one day; null when there is
 * none.
 */
export function cutOffOf(state: GameState, parcel: ParcelId): { days: number; charged: number; units: number } | null {
  const entry = cutOffEntry(state, parcel);
  return entry ? { days: entry.days, charged: entry.charged, units: entry.units } : null;
}

/**
 * Outage churn probability for `days` more days of an outage that has
 * already been charged for `charged` days: outageChurnProbability(charged +
 * days) - outageChurnProbability(charged), so one outage pays its base once
 * however many closes it spans.
 */
export function outageChurnFor(charged: number, days: number): number {
  return outageChurnProbability(charged + days) - outageChurnProbability(charged);
}

/**
 * What a close charges the account on `parcel` for outages: the churn
 * probability of its Weather.cutOff days since the last close
 * (outageChurnFor) and the most of its units cut off on one day; null when it
 * was not cut off since. sales.closeSalesMonth adds the probability, times
 * the share of the account's units that were cut off, to each unit's churn.
 */
export function outageChargeOf(state: GameState, parcel: ParcelId): { probability: number; units: number } | null {
  if (state.weather.cutOff.length === 0) return null;
  const entry = cutOffEntry(state, parcel);
  if (!entry || entry.days === 0) return null;
  return { probability: outageChurnFor(entry.charged, entry.days), units: entry.units };
}

/** Days `segment` was interrupted (no cabinet reached it) in the open month (WeatherMonth.segmentOutageDays; 0 when absent). Binary search. */
export function outageDaysOn(state: GameState, segment: SegmentId): number {
  const days = state.weather.month.segmentOutageDays;
  let lo = 0;
  let hi = days.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = days[mid] as { segment: SegmentId; days: number };
    if (entry.segment === segment) return entry.days;
    if (entry.segment < segment) lo = mid + 1;
    else hi = mid - 1;
  }
  return 0;
}

/**
 * Extra churn probability for a subscriber one outage cut off `days` days
 * (its own days, Weather.cutOff): 0 for 0 days, else
 * min(OUTAGE_CHURN_MAX, OUTAGE_CHURN_BASE + OUTAGE_CHURN_PER_DAY x days).
 * Charged at the closes the days fall before (outageChurnFor: the base once).
 */
export function outageChurnProbability(days: number): number {
  if (!(days > 0)) return 0;
  return Math.min(OUTAGE_CHURN_MAX, OUTAGE_CHURN_BASE + OUTAGE_CHURN_PER_DAY * days);
}

/**
 * Repair cost of a damaged span of `method` on `segment`, whole dollars:
 * round(REPAIR_BASE_<method> + REPAIR_PER_FT_<method> x lengthFt). Round
 * 4c/4d: given the street's `city`, an aerial repair also pays for the
 * trees, x (1 + REPAIR_CANOPY_SHARE x streetCanopy) (rounded once); without
 * it (or underground) the plain figure, as round 4b.
 */
export function repairCost(segment: StreetSegment, method: CableMethod, city?: City): number {
  if (method !== 'aerial') return Math.round(REPAIR_BASE_UNDERGROUND + REPAIR_PER_FT_UNDERGROUND * segment.lengthFt);
  const canopy = city ? streetCanopy(city, segment) : 0;
  return Math.round((REPAIR_BASE_AERIAL + REPAIR_PER_FT_AERIAL * segment.lengthFt) * (1 + REPAIR_CANOPY_SHARE * canopy));
}

/**
 * The range one outage's days out are drawn from (uniform, whole days):
 * OUTAGE_DAYS_<method>_MIN..MAX; round 4c/4d: an aerial outage under
 * `canopy` (0..1) starts at OUTAGE_DAYS_AERIAL_MIN + round(OUTAGE_DAYS_CANOPY
 * x canopy), at most OUTAGE_DAYS_AERIAL_MAX.
 */
export function outageDaysRange(method: CableMethod, canopy = 0): { min: number; max: number } {
  if (method !== 'aerial') return { min: OUTAGE_DAYS_UNDERGROUND_MIN, max: OUTAGE_DAYS_UNDERGROUND_MAX };
  const shift = Math.round(OUTAGE_DAYS_CANOPY * Math.max(0, Math.min(1, canopy)));
  return { min: Math.min(OUTAGE_DAYS_AERIAL_MAX, OUTAGE_DAYS_AERIAL_MIN + shift), max: OUTAGE_DAYS_AERIAL_MAX };
}

/**
 * Mean days out of service of one outage on `method` plant (the uniform
 * draw's mean, outageDaysRange); round 4c/4d: an aerial outage under
 * `canopy` (streetCanopy; default 0, an open street) lasts longer.
 */
export function meanOutageDays(method: CableMethod, canopy = 0): number {
  const { min, max } = outageDaysRange(method, canopy);
  return (min + max) / 2;
}

/** A storm's damage chance per unit of severity on `method` plant. */
function damageChance(method: CableMethod): number {
  return method === 'aerial' ? STORM_AERIAL_DAMAGE_CHANCE : STORM_UNDERGROUND_DAMAGE_CHANCE;
}

/**
 * The chance a storm of `severity` that covers a span of `method` damages it
 * on a street of storm exposure `exposure` (segmentExposure):
 * min(1, severity x STORM_<method>_DAMAGE_CHANCE x exposure).
 */
export function stormDamageChance(method: CableMethod, severity: number, exposure: number): number {
  return Math.min(1, severity * damageChance(method) * Math.max(0, exposure));
}

/** stormDamageChance averaged over the uniform severities 1..STORM_SEVERITY_MAX. */
function expectedDamageChance(method: CableMethod, exposure: number): number {
  let sum = 0;
  let n = 0;
  for (let severity = 1; severity <= STORM_SEVERITY_MAX; severity++) {
    sum += stormDamageChance(method, severity, exposure);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/** Storm-center weights as column sums (cityStormCenters): what stormCoverage needs to weigh centers. */
export interface StormCenterMass {
  /** prefix[x * (height + 2) + y]: the summed weights of lattice points (x, 0..y - 1). */
  prefix: Float64Array;
  /** All the weights together (> 0). */
  total: number;
}

/**
 * The chance a storm's area covers the point (mx2 / 2, my2 / 2) of a
 * width x height map: storms center on a lattice point (0..width,
 * 0..height), each with probability its weight / the total (`centers`;
 * uniform when absent, as round 4), with a uniform whole radius
 * STORM_RADIUS_MIN..MAX, and cover the point when it lies within the radius
 * (the test stepWeather applies). Exact: per radius, the lattice points
 * within it, summed column by column in doubled coordinates (so half-cell
 * midpoints stay integers): counted when uniform, by column sums when
 * weighted.
 */
export function stormCoverage(width: number, height: number, mx2: number, my2: number, centers?: StormCenterMass): number {
  const lattice = (width + 1) * (height + 1);
  if (!(lattice > 0)) return 0;
  const mass = centers ? centers.total : lattice;
  if (!(mass > 0)) return 0;
  const stride = height + 2;
  let total = 0;
  let radii = 0;
  for (let r = STORM_RADIUS_MIN; r <= STORM_RADIUS_MAX; r++) {
    radii++;
    const reach2 = 4 * r * r;
    let count = 0;
    const cxMin = Math.max(0, Math.ceil((mx2 - 2 * r) / 2));
    const cxMax = Math.min(width, Math.floor((mx2 + 2 * r) / 2));
    for (let cx = cxMin; cx <= cxMax; cx++) {
      const dx = 2 * cx - mx2;
      const room = reach2 - dx * dx;
      if (room < 0) continue;
      // Largest k with k * k <= room, exact for whole numbers.
      let k = Math.floor(Math.sqrt(room));
      while ((k + 1) * (k + 1) <= room) k++;
      while (k * k > room) k--;
      const lo = Math.max(0, Math.ceil((my2 - k) / 2));
      const hi = Math.min(height, Math.floor((my2 + k) / 2));
      if (hi < lo) continue;
      if (centers) count += (centers.prefix[cx * stride + hi + 1] ?? 0) - (centers.prefix[cx * stride + lo] ?? 0);
      else count += hi - lo + 1;
    }
    total += count / mass;
  }
  return radii > 0 ? Math.max(0, total / radii) : 0;
}

/** A city's storm centers: everything stormHits and stormRisk need, precomputed once per city. */
interface StormCenters extends StormCenterMass {
  /** Lattice point (x, y)'s exposure at y * (width + 1) + x (pointExposure). */
  exposure: Float64Array;
  /** Its weight (stormCenterWeights). */
  weights: Float64Array;
  /** cumulative[i]: weights[0] + ... + weights[i]. */
  cumulative: Float64Array;
  /** stormCoverage with these weights at doubled midpoints (key mx2 * (2 x height + 1) + my2), filled on demand. */
  coverage: Map<number, number>;
}

const centersCache = new WeakMap<City, StormCenters>();

/**
 * Storm centers of `city`, memoized per city. A lattice point's exposure is
 * the mean of the exposures (cityExposure) of the streets whose midpoints lie
 * within STORM_CENTER_REACH_CELLS of it, each weighted by its length x
 * (1 - d² / reach²) (nearer and longer streets count more), together with
 * STORM_CENTER_OPEN_FT feet at the town's mean exposure (cityMeanExposure):
 * open country, with no street that close, rates as an average street, so
 * storms keep round 4's share of the town overall, and within it sheltered
 * downtown blocks draw them less and exposed rural edges and wooded streets
 * more. Its weight is max(0, 1 + STORM_CENTER_EXPOSURE_WEIGHT x
 * (exposure - 1)) (all 1 if that leaves nothing).
 */
function cityStormCenters(city: City): StormCenters {
  const cached = centersCache.get(city);
  if (cached) return cached;
  const w1 = city.width + 1;
  const h1 = city.height + 1;
  const n = Math.max(0, w1 * h1);
  const sum = new Float64Array(n);
  const mass = new Float64Array(n);
  const exposures = cityExposure(city);
  const reach = STORM_CENTER_REACH_CELLS > 0 ? STORM_CENTER_REACH_CELLS : 1;
  // Doubled coordinates: midpoints may sit on half cells.
  const reach2 = 4 * reach * reach;
  for (const seg of city.segments) {
    const a = city.nodes[seg.a];
    const b = city.nodes[seg.b];
    if (!a || !b || !(seg.lengthFt > 0)) continue;
    const mx2 = a.x + b.x;
    const my2 = a.y + b.y;
    const e = exposures[seg.id] ?? 1;
    const x0 = Math.max(0, Math.ceil((mx2 - 2 * reach) / 2));
    const x1 = Math.min(city.width, Math.floor((mx2 + 2 * reach) / 2));
    const y0 = Math.max(0, Math.ceil((my2 - 2 * reach) / 2));
    const y1 = Math.min(city.height, Math.floor((my2 + 2 * reach) / 2));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = 2 * x - mx2;
        const dy = 2 * y - my2;
        const d2 = dx * dx + dy * dy;
        if (d2 >= reach2) continue;
        const w = seg.lengthFt * (1 - d2 / reach2);
        sum[y * w1 + x] = (sum[y * w1 + x] ?? 0) + w * e;
        mass[y * w1 + x] = (mass[y * w1 + x] ?? 0) + w;
      }
    }
  }
  const exposure = new Float64Array(n);
  const weights = new Float64Array(n);
  const open = cityMeanExposure(city);
  const prior = Math.max(0, STORM_CENTER_OPEN_FT);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const m = (mass[i] ?? 0) + prior;
    const e = m > 0 ? ((sum[i] ?? 0) + prior * open) / m : open;
    exposure[i] = e;
    const w = Math.max(0, 1 + STORM_CENTER_EXPOSURE_WEIGHT * (e - 1));
    weights[i] = w;
    total += w;
  }
  if (!(total > 0)) {
    weights.fill(1);
    total = n;
  }
  const cumulative = new Float64Array(n);
  let run = 0;
  for (let i = 0; i < n; i++) {
    run += weights[i] ?? 0;
    cumulative[i] = run;
  }
  const stride = city.height + 2;
  const prefix = new Float64Array(w1 * stride);
  for (let x = 0; x < w1; x++) {
    let col = 0;
    for (let y = 0; y < h1; y++) {
      col += weights[y * w1 + x] ?? 0;
      prefix[x * stride + y + 1] = col;
    }
  }
  const centers: StormCenters = { exposure, weights, cumulative, prefix, total: n > 0 ? run : 0, coverage: new Map() };
  centersCache.set(city, centers);
  return centers;
}

/**
 * How exposed the map around lattice point (x, y) of `city` is, for drawing
 * storm centers (see cityStormCenters): 1 off the lattice. Pure, memoized
 * per city.
 */
export function pointExposure(city: City, x: number, y: number): number {
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > city.width || y > city.height) return 1;
  return cityStormCenters(city).exposure[y * (city.width + 1) + x] ?? 1;
}

/** The weight of every lattice point of `city` as a storm center, at y * (width + 1) + x (cityStormCenters; read-only). */
export function stormCenterWeights(city: City): Readonly<Float64Array> {
  return cityStormCenters(city).weights;
}

/**
 * The storm center a uniform draw `u` in [0, 1) picks on `city`: the lattice
 * point whose share of the cumulative weights (stormCenterWeights, row by
 * row) holds u x the total, so each point comes up with probability its
 * weight / the total, and never one of weight 0.
 */
export function pickStormCenter(city: City, u: number): { x: number; y: number } {
  const { cumulative, total } = cityStormCenters(city);
  const n = cumulative.length;
  if (n === 0) return { x: 0, y: 0 };
  const target = Math.max(0, Math.min(1, u)) * total;
  // First index whose running total passes the target.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((cumulative[mid] ?? 0) > target) hi = mid;
    else lo = mid + 1;
  }
  const w1 = city.width + 1;
  return { x: lo % w1, y: Math.floor(lo / w1) };
}

/**
 * The chance a storm's area covers the point (mx2 / 2, my2 / 2) of `city`,
 * its centers drawn as stormHits draws them (stormCoverage with the city's
 * storm-center weights), memoized per city and point.
 */
export function cityStormCoverage(city: City, mx2: number, my2: number): number {
  const centers = cityStormCenters(city);
  const key = mx2 * (2 * city.height + 1) + my2;
  let coverage = centers.coverage.get(key);
  if (coverage === undefined) {
    coverage = stormCoverage(city.width, city.height, mx2, my2, centers);
    centers.coverage.set(key, coverage);
  }
  return coverage;
}

/**
 * Expected yearly exposure of a span of `method` on `segment` from
 * STORM_START_DAY on, exact for the storm model stepWeather plays: outages a
 * year (365 x STORM_CHANCE_PER_DAY storms x the chance a storm's area covers
 * the segment's midpoint, cityStormCoverage (centers weighted by exposure),
 * x stormDamageChance for the street's exposure (segmentExposure) averaged
 * over the severities, plus lengthFt / 5,280 x DIG_INS_PER_MILE_PER_YEAR
 * dig-ins for underground), their repair cost (repairCost each, the street's
 * canopy counted) and days out (meanOutageDays each, likewise). Used by quote cards ("about $X a year in storm
 * repairs"), quoteConvert, preferredMethod, the advisor and the tuning bots.
 * Pure, no rng; an estimate (not rounded).
 */
export function stormRisk(state: GameState, segment: StreetSegment, method: CableMethod): StormRisk {
  const { city } = state;
  const a = city.nodes[segment.a];
  const b = city.nodes[segment.b];
  if (!a || !b) return { outagesPerYear: 0, repairCostPerYear: 0, outageDaysPerYear: 0 };
  const coverage = cityStormCoverage(city, a.x + b.x, a.y + b.y);
  const exposure = city.segments[segment.id] === segment ? (cityExposure(city)[segment.id] ?? 1) : exposureOf(city, segment);
  let outages = DAYS_PER_YEAR * STORM_CHANCE_PER_DAY * coverage * expectedDamageChance(method, exposure);
  if (method === 'underground') outages += (segment.lengthFt / FT_PER_MILE) * DIG_INS_PER_MILE_PER_YEAR;
  return {
    outagesPerYear: outages,
    repairCostPerYear: outages * repairCost(segment, method, city),
    outageDaysPerYear: outages * meanOutageDays(method, streetCanopy(city, segment)),
  };
}

// ---------------------------------------------------------------------------
// Round 4b: storm exposure
// ---------------------------------------------------------------------------

/**
 * How exposed the street `segment` of `city` is to storms: a multiplier
 * (>= 0, mean ~1 over a generated town's street feet: about 1.05-1.15 on the
 * tuning towns) on the storm damage chance there (stormDamageChance) and on
 * where storms center (cityStormCenters). Deterministic from the city alone
 * (never from game state, never stored):
 * STORM_EXPOSURE_ZONE[zone] x (1 + STORM_EXPOSURE_WOODED x wooded) x
 * (1 + STORM_EXPOSURE_EDGE x edge), where `wooded` (0..1) is
 * terrain.woodedAt the street's midpoint (the grove field the map's trees
 * are drawn from, on the land around it that no lot covers: the streets the
 * player sees among trees) and `edge` fades from 1 at the map's edge to 0
 * STORM_EXPOSURE_EDGE_CELLS cells in. Arithmetic only. An unknown segment
 * returns 1.
 */
export function segmentExposure(city: City, segment: SegmentId): number {
  const seg = city.segments[segment];
  return seg ? exposureOf(city, seg) : 1;
}

/** segmentExposure of a street given as a segment (its zone and its ends in `city`). */
function exposureOf(city: City, seg: StreetSegment): number {
  const a = city.nodes[seg.a];
  const b = city.nodes[seg.b];
  if (!a || !b) return 1;
  // Doubled coordinates keep the midpoint whole; the edge distance is in cells.
  const mx2 = a.x + b.x;
  const my2 = a.y + b.y;
  const wooded = woodedAt(city, mx2 / 2, my2 / 2);
  const toEdge = Math.min(mx2, my2, 2 * city.width - mx2, 2 * city.height - my2) / 2;
  const reach = STORM_EXPOSURE_EDGE_CELLS > 0 ? STORM_EXPOSURE_EDGE_CELLS : 1;
  const edge = Math.max(0, 1 - toEdge / reach);
  const zone = STORM_EXPOSURE_ZONE[seg.zone] ?? 1;
  const canopy = canopyOf(city, seg);
  return Math.max(0, zone * (1 + STORM_EXPOSURE_WOODED * wooded) * (1 + STORM_EXPOSURE_EDGE * edge) * (1 + STORM_EXPOSURE_CANOPY * canopy));
}

const exposureCache = new WeakMap<City, readonly number[]>();
const meanCache = new WeakMap<City, number>();

/** The mean exposure of `city`'s streets, weighted by length (1 for a city without streets); memoized per city. */
export function cityMeanExposure(city: City): number {
  const cached = meanCache.get(city);
  if (cached !== undefined) return cached;
  const exposure = cityExposure(city);
  let sum = 0;
  let feet = 0;
  for (const seg of city.segments) {
    if (!(seg.lengthFt > 0)) continue;
    sum += (exposure[seg.id] ?? 1) * seg.lengthFt;
    feet += seg.lengthFt;
  }
  const mean = feet > 0 ? sum / feet : 1;
  meanCache.set(city, mean);
  return mean;
}

/** segmentExposure of every street of `city`, by segment id (memoized per city; treat as read-only). For the overlay and stormRisk. */
export function cityExposure(city: City): readonly number[] {
  const cached = exposureCache.get(city);
  if (cached) return cached;
  const values = city.segments.map((s) => exposureOf(city, s));
  exposureCache.set(city, values);
  return values;
}

/** The canopy a street counts (STORM_CANOPY_ZONE[zone] x terrain.canopyAt its midpoint), 0 for a street whose ends are unknown. */
function canopyOf(city: City, seg: StreetSegment): number {
  const share = STORM_CANOPY_ZONE[seg.zone] ?? 0;
  if (!(share > 0)) return 0;
  const a = city.nodes[seg.a];
  const b = city.nodes[seg.b];
  if (!a || !b) return 0;
  return Math.max(0, Math.min(1, share * canopyAt(city, (a.x + b.x) / 2, (a.y + b.y) / 2)));
}

const canopyCache = new WeakMap<City, readonly number[]>();

/**
 * Round 4c/4d (spec D): how much of street `segment` (an id of `city`, or a
 * segment) runs under mature trees, 0 (open) .. 1 (tree-lined):
 * terrain.canopyAt its midpoint on the zones STORM_CANOPY_ZONE counts
 * (residential), 0 elsewhere. It raises the street's storm exposure
 * (segmentExposure: x (1 + STORM_EXPOSURE_CANOPY x canopy)), what an aerial
 * repair there costs (repairCost) and how long an aerial outage lasts
 * (meanOutageDays). Deterministic from the city, memoized per city.
 */
export function streetCanopy(city: City, segment: SegmentId | StreetSegment): number {
  const id = typeof segment === 'number' ? segment : segment.id;
  const seg = city.segments[id];
  if (typeof segment !== 'number' && seg !== segment) return canopyOf(city, segment);
  if (!seg) return 0;
  let values = canopyCache.get(city);
  if (!values) {
    values = city.segments.map((s) => canopyOf(city, s));
    canopyCache.set(city, values);
  }
  return values[id] ?? 0;
}

/** The band of an exposure: 'exposed' from STORM_EXPOSURE_EXPOSED, 'moderate' from STORM_EXPOSURE_MODERATE, else 'sheltered'. */
export function exposureBand(exposure: number): ExposureBand {
  if (exposure >= STORM_EXPOSURE_EXPOSED) return 'exposed';
  if (exposure >= STORM_EXPOSURE_MODERATE) return 'moderate';
  return 'sheltered';
}

/** Parcels fronting each street of a city (ids ascending), memoized per city: what a street's customers would be. */
const parcelsByStreet = new WeakMap<City, readonly (readonly ParcelId[])[]>();

function streetParcels(city: City, segment: SegmentId): readonly ParcelId[] {
  let lists = parcelsByStreet.get(city);
  if (!lists) {
    const built: ParcelId[][] = city.segments.map(() => []);
    for (const parcel of city.parcels) built[parcel.segment]?.push(parcel.id);
    lists = built;
    parcelsByStreet.set(city, lists);
  }
  return lists[segment] ?? [];
}

/**
 * The customers a street would have once its signups settle: the units of
 * the buildings on it that stand today, each kind at its target take rate
 * at today's prices (sales.stateTakeRate). The method choice's estimate.
 */
function expectedCustomersOn(state: GameState, segment: StreetSegment): number {
  const { city } = state;
  if (city.segments[segment.id] !== segment) return 0;
  const units: Record<ParcelKind, number> = { home: 0, mdu: 0, smb: 0 };
  for (const id of streetParcels(city, segment.id)) {
    const parcel = city.parcels[id];
    if (parcel && parcel.appearsDay <= state.day) units[parcel.kind] += parcel.units;
  }
  let customers = 0;
  for (const kind of ['home', 'mdu', 'smb'] as const) if (units[kind] > 0) customers += units[kind] * stateTakeRate(state, kind);
  return customers;
}

/** What one household customer pays a month at today's prices: the signup tier mix's price (sales.tierMix, sales.unitPrice). */
function householdPrice(state: GameState): number {
  const { pricing } = state.sales;
  const mix = tierMix(pricing, 'home');
  let price = 0;
  for (const tier of pricing.tiers) price += (mix[tier.id] ?? 0) * unitPrice(pricing, tier.id, 'home');
  return price;
}

/**
 * Round 4c/4d (spec D): what a span of `method` on `segment` costs a year to
 * own, dollars (not rounded): pole rent (aerial), the expected storm and
 * dig-in repairs (stormRisk, exact for the storm model), and what its
 * outages cost the street's customers would-be or real (expectedCustomersOn):
 * per outage, the cancellations it causes (outageChurnProbability of the
 * mean days out, the canopy counted) at LOST_CUSTOMER_MONTHS of a
 * customer's margin each, and the days of service not billed (mean days out
 * / DAYS_PER_BILL of the price). An exposed aerial street (storm exposure
 * from canopy, woods and the map's edge) costs far more a year than the same
 * street underground or a sheltered one. Pure.
 */
export function methodYearlyCost(state: GameState, segment: StreetSegment, method: CableMethod): number {
  return yearlyCostWith(state, segment, method, streetCustomers(state, segment));
}

/** The street's would-be customers and what one pays a month and earns over its running cost (for yearlyCostWith). */
interface StreetCustomers {
  customers: number;
  price: number;
  margin: number;
}

function streetCustomers(state: GameState, segment: StreetSegment): StreetCustomers {
  const customers = expectedCustomersOn(state, segment);
  if (!(customers > 0)) return { customers: 0, price: 0, margin: 0 };
  const price = householdPrice(state);
  return { customers, price, margin: Math.max(0, price - perCustomerCost(state)) };
}

/** methodYearlyCost with the street's customers worked out once (preferredMethod prices both methods with them). */
function yearlyCostWith(state: GameState, segment: StreetSegment, method: CableMethod, who: StreetCustomers): number {
  const rent = method === 'aerial' ? polesOnSegment(segment) * POLE_RENT_PER_POLE_PER_MONTH * 12 : 0;
  const risk = stormRisk(state, segment, method);
  let outages = 0;
  if (risk.outagesPerYear > 0 && who.customers > 0) {
    const days = risk.outageDaysPerYear / risk.outagesPerYear;
    const perOutage = outageChurnProbability(days) * LOST_CUSTOMER_MONTHS * who.margin + (days / DAYS_PER_BILL) * who.price;
    outages = risk.outagesPerYear * who.customers * perOutage;
  }
  return rent + risk.repairCostPerYear + outages;
}

/** lifetimeMethodCost with the street's customers worked out once. */
function lifetimeCostWith(state: GameState, segment: StreetSegment, method: CableMethod, who: StreetCustomers): number {
  return METHOD_UPFRONT_WEIGHT * spanCharges(segment, method).total + BUILD_METHOD_HORIZON_YEARS * yearlyCostWith(state, segment, method, who);
}

/**
 * What the method choice weighs for a span of `method` on `segment`
 * (dollars, not rounded): METHOD_UPFRONT_WEIGHT x its construction charges
 * (network.spanCharges: cable, rock, make-ready; per-order fees left out)
 * plus BUILD_METHOD_HORIZON_YEARS x methodYearlyCost (pole rent, expected
 * storm repairs, the outage cost of the street's customers). The up-front
 * weight is what money spent now is worth in a game where growth is bound by
 * capital, so burying wins only where it pays its extra cost back within
 * BUILD_METHOD_HORIZON_YEARS / METHOD_UPFRONT_WEIGHT years: a tree-lined
 * (exposed) block, not a sheltered or open one.
 */
export function lifetimeMethodCost(state: GameState, segment: StreetSegment, method: CableMethod): number {
  return lifetimeCostWith(state, segment, method, streetCustomers(state, segment));
}

/**
 * Round 4c/4d (spec D): burying `segment` instead of stringing it, for a new
 * build: what it costs more up front (spanCharges underground less aerial;
 * per-order fees left out), what it saves a year (methodYearlyCost aerial
 * less underground), and the years it takes to pay back (extra / saved;
 * null when it saves nothing, 0 when it costs no more). null for a street
 * without poles (it can only be buried). For the quote cards, the advisor
 * and the tests. Pure.
 */
export function buryPayback(state: GameState, segment: StreetSegment): { extraCost: number; savedPerYear: number; years: number | null } | null {
  if (!segment.hasPoles) return null;
  const extraCost = spanCharges(segment, 'underground').total - spanCharges(segment, 'aerial').total;
  const who = streetCustomers(state, segment);
  const savedPerYear = yearlyCostWith(state, segment, 'aerial', who) - yearlyCostWith(state, segment, 'underground', who);
  const years = extraCost <= 0 ? 0 : savedPerYear > 0 ? extraCost / savedPerYear : null;
  return { extraCost, savedPerYear, years };
}

/**
 * The method a careful builder would choose for `segment`: the lower
 * lifetimeMethodCost (ties: aerial), or 'underground' when the street has no
 * poles. The advisor's expand plan (coverage.buildOutPlan) builds with it:
 * the mixed build, aerial on open and sheltered blocks, underground on
 * tree-lined and other exposed ones where burying pays back (buryPayback
 * within BUILD_METHOD_HORIZON_YEARS / METHOD_UPFRONT_WEIGHT years). Pure.
 */
export function preferredMethod(state: GameState, segment: StreetSegment): CableMethod {
  if (!segment.hasPoles) return 'underground';
  const who = streetCustomers(state, segment);
  return lifetimeCostWith(state, segment, 'aerial', who) <= lifetimeCostWith(state, segment, 'underground', who) ? 'aerial' : 'underground';
}

/** Spans out of service today, in network.spans order (the map and the briefing). Implemented by the contract. */
export function outageSpanIds(state: GameState): number[] {
  const ids: number[] = [];
  for (const span of state.network.spans) if (span.outage !== null) ids.push(span.id);
  return ids;
}

/** The corner nearest a map point (ties: the lower id), or null for a city without corners. */
export function nearestCorner(city: City, x: number, y: number): NodeId | null {
  let best: NodeId | null = null;
  let bestD2 = Infinity;
  for (const node of city.nodes) {
    const dx = node.x - x;
    const dy = node.y - y;
    const d2 = dx * dx + dy * dy;
    if (d2 < bestD2) {
      bestD2 = d2;
      best = node.id;
    }
  }
  return best;
}

/** "Elm St & 3rd Ave": the area a storm hit, by the corner nearest its center. */
export function stormAreaName(city: City, storm: Pick<Storm, 'x' | 'y'>): string {
  const corner = nearestCorner(city, storm.x, storm.y);
  return corner === null ? 'town' : cornerName(city, corner);
}

/** "A squall" / "A storm" / "A major storm" by severity. */
export function stormLabel(severity: number): string {
  if (severity >= STORM_SEVERITY_MAX && STORM_SEVERITY_MAX > 1) return 'major storm';
  if (severity <= 1) return 'squall';
  return 'storm';
}

// ---------------------------------------------------------------------------
// The daily steps
// ---------------------------------------------------------------------------

function plural(n: number, one: string, many: string): string {
  return `${groupThousands(n)} ${n === 1 ? one : many}`;
}

/** Distinct street names of these spans' segments, in order. */
function streetNamesOf(state: GameState, spans: readonly CableSpan[]): string[] {
  const names: string[] = [];
  for (const span of spans) {
    const name = state.city.segments[span.segment]?.name;
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** "Elm St", "Elm St and Oak Ave", "Elm St and 2 more streets". */
function streetsPhrase(names: readonly string[]): string {
  if (names.length === 0) return 'the network';
  if (names.length === 1) return names[0] as string;
  if (names.length === 2) return `${names[0] as string} and ${names[1] as string}`;
  return `${names[0] as string} and ${names.length - 1} more streets`;
}

/** "3 days" or "2 to 6 days". */
function daysPhrase(min: number, max: number): string {
  return min === max ? plural(min, 'day', 'days') : `${groupThousands(min)} to ${plural(max, 'day', 'days')}`;
}

/** Subscribed units of the accounts cut off in `now` but not in `then` (network.outageService). */
function unitsCutOff(state: GameState, now: ReadonlySet<ParcelId>, then: ReadonlySet<ParcelId>): number {
  if (now.size === 0) return 0;
  let units = 0;
  for (const account of state.sales.accounts) if (now.has(account.parcel) && !then.has(account.parcel)) units += accountUnits(account);
  return units;
}

/** Who is cut off on `service` (network.outageService). */
function cutOffOn(state: GameState, service: ServiceSnapshot): ReadonlySet<ParcelId> {
  return outageService(state, service).cutOff;
}

/** Subscribed units newly without service: accounts cut off now that were not in `before`. */
function newlyCutOff(state: GameState, before: ReadonlySet<ParcelId>): number {
  return unitsCutOff(state, cutOffOn(state, getService(state)), before);
}

/** Step 1: count repairs down, put spans back in service, tell the player. */
function repairSpans(state: GameState): void {
  const { network } = state;
  if (!network.spans.some((span) => span.outage !== null)) return;
  // Who was cut off before today's repairs.
  const before = cutOffOn(state, getService(state));
  const restored: CableSpan[] = [];
  let changed = false;
  let longest = 0;
  for (const span of network.spans) {
    const outage = span.outage;
    if (outage === null) continue;
    if (span.stage !== 'live') {
      // Only live plant can be out (save validation holds it); never leave one stuck.
      span.outage = null;
      changed = true;
      continue;
    }
    outage.daysLeft -= 1;
    if (outage.daysLeft > 0) continue;
    longest = Math.max(longest, state.day - outage.startDay);
    span.outage = null;
    restored.push(span);
  }
  if (!changed && restored.length === 0) return;
  network.version++;
  if (restored.length === 0) return;
  const units = unitsCutOff(state, before, cutOffOn(state, getService(state)));
  const where = streetsPhrase(streetNamesOf(state, restored));
  const back =
    units > 0
      ? `${plural(units, 'subscriber has', 'subscribers have')} service again after ${plural(Math.max(1, longest), 'day', 'days')}`
      : 'the cable is back in service';
  postNotice(state, 'serviceRestored', `Repairs finished on ${where}: ${back}.`);
}

/** Keep the storms of the last STORM_LOG_DAYS days (the log is oldest first). */
function dropOldStorms(state: GameState): void {
  const storms = state.weather.storms;
  let drop = 0;
  while (drop < storms.length && state.day - (storms[drop] as Storm).day >= STORM_LOG_DAYS) drop++;
  if (drop > 0) storms.splice(0, drop);
}

/** Damage drawn for one span, applied once every draw is made. */
interface Damage {
  span: CableSpan;
  daysLeft: number;
  repairCost: number;
}

/** Days out for one damaged span: one uniform draw from `rng` over outageDaysRange(method, the street's canopy). */
function drawOutageDays(method: CableMethod, rng: Rng, canopy = 0): number {
  const { min, max } = outageDaysRange(method, canopy);
  return Math.max(1, rng.int(min, max));
}

/** Step 2: a storm hits. Its center, radius, severity and seed come from `rng`; each street's damage roll and days out from its own sub-stream. */
function stormHits(state: GameState, rng: Rng, subStream: SubStream): void {
  const { city, network, weather } = state;
  const { x, y } = pickStormCenter(city, rng.next());
  const radius = rng.int(STORM_RADIUS_MIN, STORM_RADIUS_MAX);
  const severity = rng.int(1, STORM_SEVERITY_MAX);
  const id = weather.nextStormId++;
  const stormSeed = stormSeedOf(drawSeed(rng), id);
  const reach2 = 4 * radius * radius;
  const exposure = cityExposure(city);

  const damage: Damage[] = [];
  for (const span of network.spans) {
    if (span.stage !== 'live' || span.outage !== null) continue;
    const segment = city.segments[span.segment];
    const a = segment ? city.nodes[segment.a] : undefined;
    const b = segment ? city.nodes[segment.b] : undefined;
    if (!segment || !a || !b) continue;
    // Doubled coordinates: the midpoint may sit on a half cell.
    const dx = 2 * x - (a.x + b.x);
    const dy = 2 * y - (a.y + b.y);
    if (dx * dx + dy * dy > reach2) continue;
    const roll = subStream(streetSeed(stormSeed, segment.id));
    if (!roll.chance(stormDamageChance(span.method, severity, exposure[segment.id] ?? 1))) continue;
    const canopy = streetCanopy(city, segment);
    damage.push({ span, daysLeft: drawOutageDays(span.method, roll, canopy), repairCost: repairCost(segment, span.method, city) });
  }

  let total = 0;
  for (const d of damage) total += d.repairCost;
  const storm: Storm = {
    id,
    day: state.day,
    x,
    y,
    radius,
    severity,
    spans: damage.map((d) => d.span.id).sort((p, q) => p - q),
    repairCost: total,
  };
  weather.storms.push(storm);
  weather.month.storms += 1;
  if (damage.length === 0) return;

  const before = cutOffOn(state, getService(state));
  let minDays = Infinity;
  let maxDays = 0;
  for (const d of damage) {
    d.span.outage = { cause: 'storm', storm: id, startDay: state.day, daysLeft: d.daysLeft, repairCost: d.repairCost };
    minDays = Math.min(minDays, d.daysLeft);
    maxDays = Math.max(maxDays, d.daysLeft);
  }
  network.version++;
  const area = stormAreaName(city, storm);
  const label = stormLabel(severity);
  postEntry(state, 'repair', -total, `Storm repairs near ${area} (${plural(damage.length, 'span', 'spans')})`);
  weather.month.repairs += total;
  weather.month.spansDamaged += damage.length;
  const units = newlyCutOff(state, before);
  const cut = units > 0 ? `${plural(units, 'subscriber', 'subscribers')} cut off` : 'no subscribers cut off';
  postNotice(
    state,
    'storm',
    `A ${label} hit near ${area}: ${plural(damage.length, 'span', 'spans')} down, ${cut}. ` +
      `Repairs ${formatMoney(total)}; service back in ${daysPhrase(minDays, maxDays)}.`,
  );
}

/** Step 3: excavators cut underground cable. Each street's draw (and days out) from the day's sub-stream for it (`seed`: the day's, from the weather stream). */
function digIns(state: GameState, seed: number, subStream: SubStream): void {
  const { city, network, weather } = state;
  const perFtPerDay = DIG_INS_PER_MILE_PER_YEAR / FT_PER_MILE / DAYS_PER_YEAR;
  let daySeed: number | null = null;
  const cuts: Damage[] = [];
  for (const span of network.spans) {
    if (span.stage !== 'live' || span.outage !== null || span.method !== 'underground') continue;
    const segment = city.segments[span.segment];
    if (!segment) continue;
    daySeed ??= digInSeedOf(seed, state.day);
    const roll = subStream(streetSeed(daySeed, segment.id));
    if (!roll.chance(segment.lengthFt * perFtPerDay)) continue;
    cuts.push({ span, daysLeft: drawOutageDays('underground', roll), repairCost: repairCost(segment, 'underground', city) });
  }
  for (const cut of cuts) {
    const before = cutOffOn(state, getService(state));
    cut.span.outage = { cause: 'digIn', storm: null, startDay: state.day, daysLeft: cut.daysLeft, repairCost: cut.repairCost };
    network.version++;
    const street = city.segments[cut.span.segment]?.name ?? 'a street';
    postEntry(state, 'repair', -cut.repairCost, `Dig-in repair on ${street}`);
    weather.month.repairs += cut.repairCost;
    weather.month.spansDamaged += 1;
    const units = newlyCutOff(state, before);
    const who = units > 0 ? `${plural(units, 'subscriber', 'subscribers')} cut off` : 'no subscribers cut off';
    postNotice(
      state,
      'digIn',
      `An excavator cut the underground cable on ${street}: ${who}. ` +
        `Repairs ${formatMoney(cut.repairCost)}; service back in ${plural(cut.daysLeft, 'day', 'days')}.`,
    );
  }
}

/** Step 4: count today's interrupted segments, cut-off subscribers and subscriber-days. */
function accrueOutages(state: GameState): void {
  const service = getService(state);
  const { weather } = state;
  if (service.cutOffCabinets.size === 0 && weather.cutOff.length === 0) return;
  const month = weather.month;
  const interrupted = service.interruptedSegments;
  if (interrupted.size > 0) {
    const today = [...interrupted].sort((a, b) => a - b);
    // Merge two ascending lists, one entry per segment.
    const merged: { segment: SegmentId; days: number }[] = [];
    const old = month.segmentOutageDays;
    let i = 0;
    let j = 0;
    while (i < old.length || j < today.length) {
      const entry = old[i];
      const segment = today[j];
      if (segment === undefined || (entry !== undefined && entry.segment < segment)) {
        merged.push(entry as { segment: SegmentId; days: number });
        i++;
      } else if (entry === undefined || segment < entry.segment) {
        merged.push({ segment, days: 1 });
        j++;
      } else {
        merged.push({ segment, days: Math.min(MONTH_DAYS_MAX, entry.days + 1) });
        i++;
        j++;
      }
    }
    month.segmentOutageDays = merged;
  }
  // Accounts are ascending by parcel, so the entries stay ascending.
  const cutOff = cutOffOn(state, service);
  const next: AccountOutage[] = [];
  let unitDays = 0;
  for (const account of state.sales.accounts) {
    const entry = weather.cutOff.length > 0 ? cutOffEntry(state, account.parcel) : undefined;
    const units = accountUnits(account);
    if (units > 0 && cutOff.has(account.parcel)) {
      unitDays += units;
      next.push(
        entry
          ? { parcel: account.parcel, days: Math.min(CUT_OFF_DAYS_MAX, entry.days + 1), charged: entry.charged, units: Math.max(entry.units, units) }
          : { parcel: account.parcel, days: 1, charged: 0, units },
      );
    } else if (entry && entry.days > 0) next.push(entry);
  }
  weather.cutOff = next;
  month.outageUnitDays += unitDays;
}
