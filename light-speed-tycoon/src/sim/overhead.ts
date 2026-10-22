// Overhead that scales with the company (round 4c/4d, owner decision
// 2026-10-22): a small base plus costs that grow with the business, per
// customer (with the support level's cost) and per unit of live plant
// (cabinets and route-miles of cable), like a real startup ISP. Difficulty
// still differs ONLY by starting cash.
//
// Owner: sim-economy workstream. Every other module reads overhead only
// through the functions below (debt's funding cushion, the advisor's fixed
// costs, the bots, finance's projections, sales.closeSalesMonth's
// per-customer line), so the rules live here alone.
//
// The scaled model (balance.ts "Scaled overhead"):
//   base        = OVERHEAD_BASE_PER_MONTH
//   perCustomer = (OVERHEAD_PER_CUSTOMER_PER_MONTH + SUPPORT_LEVELS[level].costPerSub)
//                 x subscriber-days / days in the month (accrued daily like
//                 today's support: outage days not charged, sales.accrueDay)
//   support     = SUPPORT_LEVELS[level].costPerSub x subscriber-days / days (part of perCustomer)
//   perPlant    = live cabinets x OVERHEAD_PER_CABINET_PER_MONTH
//                 + route-miles of live cable x OVERHEAD_PER_MILE_PER_MONTH
//                 (plant as it stood on the ended month's last day)
// posted at each close as 'overhead' ledger entries dated the ended month's
// last day (memos naming the line: "Overhead for Mar 2027: office and
// systems", "Customer costs for Mar 2027: 412 customers on Good support",
// "Plant upkeep for Mar 2027: 6 cabinets, 7.4 miles of cable"), each rounded
// once, lines of $0 not posted; MonthlyReport.ops.overhead records the lines
// (base + perCustomer + perPlant = -(totals.overhead) exactly). The support
// level is GameState.customers.supportLevel (customers.setSupport).
//
// Rules: pure sim (no DOM, Date, Math.random), arithmetic and Math.sqrt
// only, whole dollars at posting.

import {
  DEFAULT_SUPPORT_LEVEL,
  OVERHEAD_BASE_PER_MONTH,
  OVERHEAD_PER_CABINET_PER_MONTH,
  OVERHEAD_PER_CUSTOMER_PER_MONTH,
  OVERHEAD_PER_MILE_PER_MONTH,
  SUPPORT_LEVELS,
} from './balance';
import { groupThousands, postEntryOn } from './finance';
import { subscriberUnits } from './sales';
import type { GameState, OverheadLines, OverheadRates, SupportLevel } from './types';

/** Feet in a route-mile (the per-plant line's unit of cable). */
export const FEET_PER_MILE = 5_280;

/** The game's support level (DEFAULT_SUPPORT_LEVEL for a state without customers, as in a hand-built test state). */
export function supportLevelOf(state: GameState): SupportLevel {
  return state.customers?.supportLevel ?? DEFAULT_SUPPORT_LEVEL;
}

/** The support cost per subscribed unit a month at `level` (SUPPORT_LEVELS; the default level's for an unknown one). */
function supportCostOf(level: SupportLevel): number {
  return (SUPPORT_LEVELS[level] ?? SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL]).costPerSub;
}

/** Display name of a support level ("Good"). */
function supportNameOf(level: SupportLevel): string {
  return (SUPPORT_LEVELS[level] ?? SUPPORT_LEVELS[DEFAULT_SUPPORT_LEVEL]).name;
}

/**
 * Live plant today: cabinets in the 'live' stage, and route-miles of live
 * cable (sum of the segments' lengthFt under live spans / FEET_PER_MILE, not
 * rounded).
 */
export function livePlant(state: GameState): { cabinets: number; miles: number } {
  let cabinets = 0;
  for (const cabinet of state.network.cabinets) if (cabinet.stage === 'live') cabinets++;
  let feet = 0;
  for (const span of state.network.spans) {
    if (span.stage !== 'live') continue;
    feet += state.city.segments[span.segment]?.lengthFt ?? 0;
  }
  return { cabinets, miles: feet / FEET_PER_MILE };
}

/**
 * What running costs a month at today's size and rates (OverheadRates):
 * the rate card, the dashboard's support lever and the quotes read it.
 * base OVERHEAD_BASE_PER_MONTH; perCustomer OVERHEAD_PER_CUSTOMER_PER_MONTH
 * + SUPPORT_LEVELS[level].costPerSub, support that level's cost (so support
 * <= perCustomer); perCabinet OVERHEAD_PER_CABINET_PER_MONTH, perMile
 * OVERHEAD_PER_MILE_PER_MONTH; the live plant today (livePlant).
 */
export function overheadRates(state: GameState): OverheadRates {
  const plant = livePlant(state);
  const supportLevel = supportLevelOf(state);
  const support = supportCostOf(supportLevel);
  return {
    base: OVERHEAD_BASE_PER_MONTH,
    perCustomer: OVERHEAD_PER_CUSTOMER_PER_MONTH + support,
    support,
    supportLevel,
    perCabinet: OVERHEAD_PER_CABINET_PER_MONTH,
    perMile: OVERHEAD_PER_MILE_PER_MONTH,
    cabinets: plant.cabinets,
    miles: plant.miles,
  };
}

/**
 * Running cost of one subscribed unit a month (overheadRates().perCustomer:
 * OVERHEAD_PER_CUSTOMER_PER_MONTH + the support level's cost): the margin
 * quotes (sales.quotePromo, incumbent.quoteRetention, the customers quotes,
 * the bots) subtract it from a unit's price.
 */
export function perCustomerCost(state: GameState): number {
  return OVERHEAD_PER_CUSTOMER_PER_MONTH + supportCostOf(supportLevelOf(state));
}

/** The per-plant line for `cabinets` live cabinets and `miles` route-miles of live cable, rounded once. */
function plantLine(cabinets: number, miles: number): number {
  return Math.round(cabinets * OVERHEAD_PER_CABINET_PER_MONTH + miles * OVERHEAD_PER_MILE_PER_MONTH);
}

/**
 * The lines that do not depend on the month's subscriber-days, for plant as
 * it stands now: base OVERHEAD_BASE_PER_MONTH, and perPlant = round(live
 * cabinets x OVERHEAD_PER_CABINET_PER_MONTH + live route-miles x
 * OVERHEAD_PER_MILE_PER_MONTH). At a close (before that day's network
 * progress) "now" is the ended month's last day, so closeOverhead posts
 * exactly these.
 */
export function fixedOverheadLines(state: GameState): { base: number; perPlant: number } {
  const plant = livePlant(state);
  return { base: OVERHEAD_BASE_PER_MONTH, perPlant: plantLine(plant.cabinets, plant.miles) };
}

/**
 * A full month's overhead at today's size: the fixed lines
 * (fixedOverheadLines) plus per customer for today's subscribed units
 * (round(perCustomerCost x units), support round(the level's cost x units),
 * each rounded once).
 */
export function estimateMonthlyOverhead(state: GameState): OverheadLines {
  const fixed = fixedOverheadLines(state);
  const units = subscriberUnits(state);
  const support = supportCostOf(supportLevelOf(state));
  return {
    base: fixed.base,
    perCustomer: Math.round((OVERHEAD_PER_CUSTOMER_PER_MONTH + support) * units),
    support: Math.round(support * units),
    perPlant: fixed.perPlant,
  };
}

/** base + perCustomer + perPlant. */
export function overheadTotal(lines: Pick<OverheadLines, 'base' | 'perCustomer' | 'perPlant'>): number {
  return lines.base + lines.perCustomer + lines.perPlant;
}

/**
 * A month of running costs as the funding cushion counts them
 * (debt.fundingHint's cushion, cure advice, the advisor's reserves, the
 * bots): a full month's overhead at today's size, every line
 * (overheadTotal(estimateMonthlyOverhead): base, per customer with the
 * support level, per plant), plus the marketing budget. Pole rent is left
 * out, as in round 4b: the advisor's expand reserve adds
 * finance.monthlyPoleRent itself, and counting it here too would charge it
 * twice. It follows the network's size: a company that has built nothing
 * keeps a small cushion, and one with thousands of customers a large one.
 */
export function fixedCostsPerMonth(state: GameState): number {
  return overheadTotal(estimateMonthlyOverhead(state)) + state.sales.marketingPerMonth;
}

/** "6 cabinets, 7.4 miles of cable" (parts that are 0 left out; "no plant" when both are). */
function plantPhrase(cabinets: number, miles: number): string {
  const parts: string[] = [];
  if (cabinets > 0) parts.push(`${groupThousands(cabinets)} ${cabinets === 1 ? 'cabinet' : 'cabinets'}`);
  const tenths = Math.round(miles * 10);
  if (tenths > 0) {
    const whole = Math.floor(tenths / 10);
    const text = `${groupThousands(whole)}.${tenths - whole * 10}`;
    parts.push(`${text} ${tenths === 10 ? 'mile' : 'miles'} of cable`);
  } else if (miles > 0) parts.push('under 0.1 miles of cable');
  return parts.length > 0 ? parts.join(', ') : 'no plant';
}

/**
 * Post the month's fixed overhead lines at a close (finance.closeMonth step
 * 2), each an 'overhead' ledger entry dated `lastDay` (the ended month's last
 * day; `label` its "Mar 2027"), each rounded once and not posted when $0:
 *   base     -OVERHEAD_BASE_PER_MONTH, "Overhead for Mar 2027: office and systems";
 *   perPlant -round(live cabinets x OVERHEAD_PER_CABINET_PER_MONTH + live
 *            route-miles x OVERHEAD_PER_MILE_PER_MONTH), plant as it stood on
 *            the ended month's last day (the close runs before the new day's
 *            network progress), "Plant upkeep for Mar 2027: 6 cabinets, 7.4
 *            miles of cable".
 * Returns { base, perPlant } as posted (0 for a line not posted). The
 * per-customer line is posted by postCustomerOverhead (sales.closeSalesMonth
 * step 3), from the month's subscriber-days.
 */
export function closeOverhead(state: GameState, lastDay: number, label: string): { base: number; perPlant: number } {
  const base = Math.round(OVERHEAD_BASE_PER_MONTH);
  if (base !== 0) postEntryOn(state, lastDay, 'overhead', -base, `Overhead for ${label}: office and systems`);
  const plant = livePlant(state);
  const perPlant = plantLine(plant.cabinets, plant.miles);
  if (perPlant !== 0) postEntryOn(state, lastDay, 'overhead', -perPlant, `Plant upkeep for ${label}: ${plantPhrase(plant.cabinets, plant.miles)}`);
  return { base, perPlant };
}

/**
 * Post the month's per-customer overhead at a close, dated `lastDay`, from
 * the month's subscriber-days (MonthAccrual.subscriberUnitDays: outage days
 * already left out), and return what was posted: { perCustomer, support }
 * (support is part of perCustomer). sales.closeSalesMonth calls it (step 3)
 * before it resets the month, so sales.ts never prices the line itself.
 *   perCustomer = round((OVERHEAD_PER_CUSTOMER_PER_MONTH +
 *                 SUPPORT_LEVELS[level].costPerSub) x subscriberUnitDays / daysInMonth)
 *   support     = round(SUPPORT_LEVELS[level].costPerSub x subscriberUnitDays / daysInMonth)
 * each rounded once (so support <= perCustomer), at the support level the
 * game has at the close (a level changed during the month counts for the
 * whole month: the accrual keeps subscriber-days, not support dollars). One
 * 'overhead' entry of -perCustomer, "Customer costs for Mar 2027: 412
 * customers on Good support" (the month's average subscribed units,
 * rounded, at least 1), not posted when $0.
 */
export function postCustomerOverhead(
  state: GameState,
  lastDay: number,
  label: string,
  subscriberUnitDays: number,
  daysInMonth: number,
): { perCustomer: number; support: number } {
  if (!(daysInMonth > 0) || !(subscriberUnitDays > 0)) return { perCustomer: 0, support: 0 };
  const level = supportLevelOf(state);
  const supportRate = supportCostOf(level);
  const perCustomer = Math.round(((OVERHEAD_PER_CUSTOMER_PER_MONTH + supportRate) * subscriberUnitDays) / daysInMonth);
  const support = Math.min(perCustomer, Math.round((supportRate * subscriberUnitDays) / daysInMonth));
  if (perCustomer !== 0) {
    const customers = Math.max(1, Math.round(subscriberUnitDays / daysInMonth));
    const who = `${groupThousands(customers)} ${customers === 1 ? 'customer' : 'customers'}`;
    postEntryOn(state, lastDay, 'overhead', -perCustomer, `Customer costs for ${label}: ${who} on ${supportNameOf(level)} support`);
  }
  return { perCustomer, support };
}

/** The OverheadLines of a close from its fixed lines and its per-customer and support amounts (whole dollars). */
export function overheadLinesOf(fixed: { base: number; perPlant: number }, perCustomer: number, support: number): OverheadLines {
  return { base: fixed.base, perCustomer, support, perPlant: fixed.perPlant };
}
