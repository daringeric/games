// The incumbent cable company's response (round 4): where your take rate in a
// cabinet area gets high, it runs a local promo there for a while, which
// lowers your target take rate on those streets and raises churn.
//
// Owner: sim-pricing workstream. The contract implemented the reads
// (activePromoFor, incumbentPriceFor, activePromos, promosRunningBetween).
//
// Pure sim (README): no randomness is needed (a promo starts deterministically
// when its trigger holds), arithmetic only, cabinets in ascending id order.
//
// Where the rules plug in:
//   sales.stepSales     - the take rate and tier mix on a street compare your
//                         tiers with incumbentPriceFor(its serving cabinet)
//   sales.closeSalesMonth - incumbentChurnFor(account.cabinet) joins each
//                         unit's churn at the close
//   finance.closeMonth  - reviewIncumbent after debt.reviewDebt: promos end
//                         and start, with their notices

import {
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_CHURN,
  INCUMBENT_PROMO_DISCOUNT,
  INCUMBENT_PROMO_MIN_PASSINGS,
  INCUMBENT_PROMO_MONTHS,
  INCUMBENT_PROMO_QUIET_MONTHS,
  INCUMBENT_PROMO_TAKE_RATE,
  TIER_DEFAULTS,
} from './balance';
import { formatDate } from './calendar';
import { formatMoney } from './finance';
import { getService } from './network';
import { postNotice } from './notices';
import { closeDayAfter } from './sales';
import { cornerName } from './streets';
import type { CabinetId, GameState, IncumbentPromo } from './types';

/** The promo running at `cabinet` today (startDay <= day < endDay), or null. */
export function activePromoFor(state: GameState, cabinet: CabinetId): IncumbentPromo | null {
  for (const promo of state.sales.incumbentPromos) {
    if (promo.cabinet === cabinet && promo.startDay <= state.day && state.day < promo.endDay) return promo;
  }
  return null;
}

/** The incumbent's price on streets `cabinet` serves today: its promo price while one runs there, else INCUMBENT_PRICE. */
export function incumbentPriceFor(state: GameState, cabinet: CabinetId | undefined): number {
  if (cabinet === undefined) return INCUMBENT_PRICE;
  return activePromoFor(state, cabinet)?.price ?? INCUMBENT_PRICE;
}

/** Promos running today, ascending cabinet. */
export function activePromos(state: GameState): IncumbentPromo[] {
  return state.sales.incumbentPromos.filter((p) => p.startDay <= state.day && state.day < p.endDay);
}

/** Promos that ran on at least one day in fromDay..toDay (inclusive): startDay <= toDay and endDay > fromDay. */
export function promosRunningBetween(state: GameState, fromDay: number, toDay: number): number {
  let count = 0;
  for (const promo of state.sales.incumbentPromos) if (promo.startDay <= toDay && promo.endDay > fromDay) count++;
  return count;
}

/** The incumbent's price while it runs a promo: INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT, at least $1. */
export function incumbentPromoPrice(): number {
  return Math.max(1, INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT);
}

/** Subscribed units on accounts of each cabinet (the incumbent's view of your take rate there). */
function unitsByCabinet(state: GameState): Map<CabinetId, number> {
  const units = new Map<CabinetId, number>();
  for (const account of state.sales.accounts) {
    let n = 0;
    for (const tier of TIER_DEFAULTS) n += account.tierUnits[tier.id];
    units.set(account.cabinet, (units.get(account.cabinet) ?? 0) + n);
  }
  return units;
}

/**
 * Your take rate in each active cabinet's area as the incumbent sees it:
 * subscribed units on accounts of that cabinet / the passings of its
 * coverage (getService(state).cabinetCoverage), for cabinets with passings,
 * ascending. Also used by the pricing panel and the advisor.
 */
export function areaTakeRates(state: GameState): { cabinet: CabinetId; passings: number; units: number; takeRate: number }[] {
  const service = getService(state);
  const units = unitsByCabinet(state);
  const rows: { cabinet: CabinetId; passings: number; units: number; takeRate: number }[] = [];
  for (const cabinet of [...service.activeCabinets].sort((a, b) => a - b)) {
    const passings = service.cabinetCoverage.get(cabinet)?.passings ?? 0;
    if (passings <= 0) continue;
    const n = units.get(cabinet) ?? 0;
    rows.push({ cabinet, passings, units: n, takeRate: n / passings });
  }
  return rows;
}

function cabinetCorner(state: GameState, cabinet: CabinetId): string {
  const found = state.network.cabinets.find((c) => c.id === cabinet);
  return found ? cornerName(state.city, found.node) : 'a cabinet';
}

/**
 * Month close step (finance.closeMonth, after debt.reviewDebt and before the
 * insolvency check; never once the game is over): end and start incumbent
 * promos. Cabinets ascending:
 * 1. A promo that ended since the previous close (previous close < endDay <=
 *    state.day) posts 'incumbentPromoEnded' (Notice.cabinet set). Records
 *    whose quietUntil <= state.day are dropped, and so are those of cabinets
 *    that no longer exist (silently).
 * 2. Each active cabinet (getService(state).activeCabinets) with at least
 *    INCUMBENT_PROMO_MIN_PASSINGS passings in its coverage and no record
 *    (running or quiet) whose take rate (areaTakeRates) is at least
 *    INCUMBENT_PROMO_TAKE_RATE gets a promo: { cabinet, startDay: day,
 *    endDay: the close INCUMBENT_PROMO_MONTHS closes later, price:
 *    incumbentPromoPrice(), quietUntil: INCUMBENT_PROMO_QUIET_MONTHS closes
 *    after endDay }, and posts 'incumbentPromo' with the cabinet's corner,
 *    the take rate, the promo price and how long.
 * Sales.incumbentPromos stays sorted by cabinet, at most one per cabinet.
 */
export function reviewIncumbent(state: GameState): void {
  const day = state.day;
  // The close before this one (the 1st of the previous month at a close).
  const since = day >= 1 ? closeDayAfter(day - 1, 0) : day;
  const cabinets = new Set(state.network.cabinets.map((c) => c.id));
  const kept: IncumbentPromo[] = [];
  for (const promo of [...state.sales.incumbentPromos].sort((a, b) => a.cabinet - b.cabinet)) {
    if (!cabinets.has(promo.cabinet)) continue;
    if (kept.some((p) => p.cabinet === promo.cabinet)) continue;
    if (promo.endDay <= day && promo.endDay > since) {
      postNotice(
        state,
        'incumbentPromoEnded',
        `The cable company's promo around ${cabinetCorner(state, promo.cabinet)} has ended: its price there is back to ${formatMoney(INCUMBENT_PRICE)}/mo.`,
        { cabinet: promo.cabinet },
      );
    }
    if (promo.quietUntil <= day) continue;
    kept.push(promo);
  }

  const months = Math.max(1, INCUMBENT_PROMO_MONTHS);
  const quiet = Math.max(0, INCUMBENT_PROMO_QUIET_MONTHS);
  const price = incumbentPromoPrice();
  const started: IncumbentPromo[] = [];
  for (const area of areaTakeRates(state)) {
    if (area.passings < INCUMBENT_PROMO_MIN_PASSINGS || area.takeRate < INCUMBENT_PROMO_TAKE_RATE) continue;
    if (kept.some((p) => p.cabinet === area.cabinet)) continue;
    const endDay = closeDayAfter(day, months);
    const promo: IncumbentPromo = { cabinet: area.cabinet, startDay: day, endDay, price, quietUntil: closeDayAfter(endDay, quiet) };
    started.push(promo);
    postNotice(
      state,
      'incumbentPromo',
      `The cable company is answering your ${Math.round(area.takeRate * 100)}% take rate around ${cabinetCorner(state, area.cabinet)} ` +
        `with a ${formatMoney(price)}/mo promo for ${months} month${months === 1 ? '' : 's'} (until ${formatDate(endDay)}): ` +
        'expect fewer signups and more cancellations there.',
      { cabinet: area.cabinet },
    );
  }
  state.sales.incumbentPromos = [...kept, ...started].sort((a, b) => a.cabinet - b.cabinet);
}

/**
 * Extra monthly churn probability for units on accounts of `cabinet` when
 * the incumbent's promo ran there on `day`: INCUMBENT_PROMO_CHURN, else 0.
 * `day` defaults to yesterday: at a close (sales.closeSalesMonth, which adds
 * it to each unit's churn) that is the ended month's last day, so every
 * month a promo ran adds its churn, the month it ended included.
 */
export function incumbentChurnFor(state: GameState, cabinet: CabinetId, day: number = state.day - 1): number {
  for (const promo of state.sales.incumbentPromos) {
    if (promo.cabinet === cabinet && promo.startDay <= day && day < promo.endDay) return INCUMBENT_PROMO_CHURN;
  }
  return 0;
}
