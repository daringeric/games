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
import { formatMoney, groupThousands, postEntry } from './finance';
import { getService, outageService } from './network';
import { postNotice } from './notices';
import type { Rng } from './rng';
import { accountUnits } from './sales';
import { cornerName } from './streets';
import type {
  AccountOutage,
  CableMethod,
  CableSpan,
  City,
  GameState,
  NodeId,
  ParcelId,
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
 * One day of weather for the new state.day (game.tick, after advanceNetwork,
 * before stepSales; never on day 0 or after game over). In order:
 * 1. Repairs: every span with an outage counts daysLeft down by 1; one that
 *    reaches 0 is back in service (outage = null). If any came back, bump
 *    network.version and post one 'serviceRestored' notice for the day
 *    ("Repairs finished on Elm St and 2 more streets: 37 subscribers have
 *    service again after 4 days."). Storms older than STORM_LOG_DAYS leave
 *    the log.
 * 2. Storms: from STORM_START_DAY, with probability STORM_CHANCE_PER_DAY a
 *    storm hits: center (rng.int over the map's lattice), radius
 *    STORM_RADIUS_MIN..STORM_RADIUS_MAX, severity 1..STORM_SEVERITY_MAX. Each
 *    live span without an outage whose segment midpoint is within the radius
 *    is damaged with probability severity x STORM_AERIAL_DAMAGE_CHANCE
 *    (aerial; a span being converted is still aerial) or severity x
 *    STORM_UNDERGROUND_DAMAGE_CHANCE (underground), drawing its days out
 *    right after a hit. Damage: outage = { cause: 'storm', storm: id,
 *    startDay: day, daysLeft: rng.int(OUTAGE_DAYS_<method>_MIN, _MAX),
 *    repairCost: repairCost(segment, method) }, one 'repair' ledger entry for
 *    the storm's total, network.version bumped and one 'storm' notice naming
 *    the area (the corner nearest its center), spans down, subscribers cut
 *    off, the repair cost and how long. The Storm is appended to
 *    weather.storms either way: one that damages nothing is logged (the map
 *    shows it) but posts no notice.
 * 3. Dig-ins: from STORM_START_DAY, each live underground span without an
 *    outage is cut with probability lengthFt / 5,280 x
 *    DIG_INS_PER_MILE_PER_YEAR / 365 (one draw per span, then its days out;
 *    cause 'digIn', storm null), each posting a 'repair' entry and a 'digIn'
 *    notice.
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
export function stepWeather(state: GameState, rng: Rng): void {
  repairSpans(state);
  dropOldStorms(state);
  if (state.day >= STORM_START_DAY) {
    if (rng.chance(STORM_CHANCE_PER_DAY)) stormHits(state, rng);
    digIns(state, rng);
  }
  accrueOutages(state);
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
 * round(REPAIR_BASE_<method> + REPAIR_PER_FT_<method> x lengthFt).
 */
export function repairCost(segment: StreetSegment, method: CableMethod): number {
  return method === 'aerial'
    ? Math.round(REPAIR_BASE_AERIAL + REPAIR_PER_FT_AERIAL * segment.lengthFt)
    : Math.round(REPAIR_BASE_UNDERGROUND + REPAIR_PER_FT_UNDERGROUND * segment.lengthFt);
}

/** Mean days out of service of one outage on `method` plant (the uniform draw's mean). */
export function meanOutageDays(method: CableMethod): number {
  return method === 'aerial'
    ? (OUTAGE_DAYS_AERIAL_MIN + OUTAGE_DAYS_AERIAL_MAX) / 2
    : (OUTAGE_DAYS_UNDERGROUND_MIN + OUTAGE_DAYS_UNDERGROUND_MAX) / 2;
}

/** A storm's damage chance per unit of severity on `method` plant. */
function damageChance(method: CableMethod): number {
  return method === 'aerial' ? STORM_AERIAL_DAMAGE_CHANCE : STORM_UNDERGROUND_DAMAGE_CHANCE;
}

/** The chance a storm that covers a span damages it, averaged over the uniform severities 1..STORM_SEVERITY_MAX. */
function expectedDamageChance(method: CableMethod): number {
  let sum = 0;
  let n = 0;
  for (let severity = 1; severity <= STORM_SEVERITY_MAX; severity++) {
    sum += Math.min(1, severity * damageChance(method));
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * The chance a storm's area covers the point (mx2 / 2, my2 / 2) of a
 * width x height map: storms center on a uniform lattice point (0..width,
 * 0..height) with a uniform whole radius STORM_RADIUS_MIN..MAX, and cover
 * the point when it lies within the radius (the test stepWeather applies).
 * Exact: per radius, the lattice points within it, counted column by column
 * in doubled coordinates (so half-cell midpoints stay integers).
 */
export function stormCoverage(width: number, height: number, mx2: number, my2: number): number {
  const lattice = (width + 1) * (height + 1);
  if (!(lattice > 0)) return 0;
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
      if (hi >= lo) count += hi - lo + 1;
    }
    total += count / lattice;
  }
  return radii > 0 ? total / radii : 0;
}

/**
 * Expected yearly exposure of a span of `method` on `segment` from
 * STORM_START_DAY on: outages a year (365 x STORM_CHANCE_PER_DAY storms x
 * the chance a storm's area covers the segment's midpoint, stormCoverage, x
 * the method's damage chance averaged over the severities, plus
 * lengthFt / 5,280 x DIG_INS_PER_MILE_PER_YEAR dig-ins for underground),
 * their repair cost (repairCost each) and days out (meanOutageDays each).
 * Used by quote cards ("about $X a year in storm repairs"), quoteConvert
 * and the advisor. Pure, no rng; an estimate (not rounded).
 */
export function stormRisk(state: GameState, segment: StreetSegment, method: CableMethod): StormRisk {
  const { city } = state;
  const a = city.nodes[segment.a];
  const b = city.nodes[segment.b];
  if (!a || !b) return { outagesPerYear: 0, repairCostPerYear: 0, outageDaysPerYear: 0 };
  const coverage = stormCoverage(city.width, city.height, a.x + b.x, a.y + b.y);
  let outages = DAYS_PER_YEAR * STORM_CHANCE_PER_DAY * coverage * expectedDamageChance(method);
  if (method === 'underground') outages += (segment.lengthFt / FT_PER_MILE) * DIG_INS_PER_MILE_PER_YEAR;
  return {
    outagesPerYear: outages,
    repairCostPerYear: outages * repairCost(segment, method),
    outageDaysPerYear: outages * meanOutageDays(method),
  };
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

function drawOutageDays(method: CableMethod, rng: Rng): number {
  const days =
    method === 'aerial'
      ? rng.int(OUTAGE_DAYS_AERIAL_MIN, OUTAGE_DAYS_AERIAL_MAX)
      : rng.int(OUTAGE_DAYS_UNDERGROUND_MIN, OUTAGE_DAYS_UNDERGROUND_MAX);
  return Math.max(1, days);
}

/** Step 2: a storm hits. */
function stormHits(state: GameState, rng: Rng): void {
  const { city, network, weather } = state;
  const x = rng.int(0, city.width);
  const y = rng.int(0, city.height);
  const radius = rng.int(STORM_RADIUS_MIN, STORM_RADIUS_MAX);
  const severity = rng.int(1, STORM_SEVERITY_MAX);
  const id = weather.nextStormId++;
  const reach2 = 4 * radius * radius;

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
    if (!rng.chance(severity * damageChance(span.method))) continue;
    damage.push({ span, daysLeft: drawOutageDays(span.method, rng), repairCost: repairCost(segment, span.method) });
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

/** Step 3: excavators cut underground cable. */
function digIns(state: GameState, rng: Rng): void {
  const { city, network, weather } = state;
  const perFtPerDay = DIG_INS_PER_MILE_PER_YEAR / FT_PER_MILE / DAYS_PER_YEAR;
  const cuts: Damage[] = [];
  for (const span of network.spans) {
    if (span.stage !== 'live' || span.outage !== null || span.method !== 'underground') continue;
    const segment = city.segments[span.segment];
    if (!segment) continue;
    if (!rng.chance(segment.lengthFt * perFtPerDay)) continue;
    cuts.push({ span, daysLeft: drawOutageDays('underground', rng), repairCost: repairCost(segment, 'underground') });
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
