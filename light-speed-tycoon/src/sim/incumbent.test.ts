// The incumbent's promos (round 4): the contract's reads, then the trigger,
// how long a promo runs and stays quiet, removed cabinets, churn and notices.
// Thresholds and prices come from balance.ts, never literals.

import { describe, expect, it } from 'vitest';
import {
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_CHURN,
  INCUMBENT_PROMO_DISCOUNT,
  INCUMBENT_PROMO_MIN_PASSINGS,
  INCUMBENT_PROMO_MONTHS,
  INCUMBENT_PROMO_QUIET_MONTHS,
  INCUMBENT_PROMO_TAKE_RATE,
  START_CASH,
} from './balance';
import { dayOf, formatDate } from './calendar';
import { runDays } from './game';
import {
  activePromoFor,
  activePromos,
  areaTakeRates,
  incumbentChurnFor,
  incumbentPriceFor,
  incumbentPromoPrice,
  promosRunningBetween,
  reviewIncumbent,
} from './incumbent';
import { getService } from './network';
import { closeDayAfter } from './sales';
import { cornerName } from './streets';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { Account, CabinetId, City, GameState } from './types';

describe('incumbent contract', () => {
  it('reads the promo running at a cabinet and the incumbent price there', () => {
    const state = makeTestState();
    state.day = 100;
    state.sales.incumbentPromos = [
      { cabinet: 3, startDay: 90, endDay: 150, price: INCUMBENT_PRICE - 20, quietUntil: 330 },
      { cabinet: 7, startDay: 31, endDay: 90, price: INCUMBENT_PRICE - 10, quietUntil: 270 },
    ];
    expect(activePromoFor(state, 3)?.price).toBe(INCUMBENT_PRICE - 20);
    expect(activePromoFor(state, 7)).toBeNull();
    expect(incumbentPriceFor(state, 3)).toBe(INCUMBENT_PRICE - 20);
    expect(incumbentPriceFor(state, 7)).toBe(INCUMBENT_PRICE);
    expect(incumbentPriceFor(state, undefined)).toBe(INCUMBENT_PRICE);
    expect(activePromos(state).map((p) => p.cabinet)).toEqual([3]);
    // Both ran on some day of 59..89; only the first on 90..120.
    expect(promosRunningBetween(state, 59, 89)).toBe(1);
    expect(promosRunningBetween(state, 31, 95)).toBe(2);
    expect(promosRunningBetween(state, 150, 180)).toBe(0);
  });
});

// 128 one-unit homes, every street in reach of one cabinet at the CO.
const TOWN = makeGridCity({ cols: 4, rows: 4, coAt: [2, 2] });
/** A close day to review at (Jun 1, 2027). */
const JUN1 = dayOf({ year: 2027, month: 6, day: 1 });

function home(parcel: number, cabinet: CabinetId): Account {
  return { parcel, cabinet, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 0, locks: [] };
}

interface Area {
  state: GameState;
  cabinet: CabinetId;
  passings: number;
}

/** A lit town on JUN1 whose cabinet serves `subscribed` homes (or the share of its passings `take` names, rounded up). */
function area(opts: { subscribed?: number; take?: number; city?: City } = {}): Area {
  const state = makeTestState(opts.city ?? TOWN);
  const cabinet = addLivePlant(state, { splitters: 8 }) as CabinetId;
  state.day = JUN1;
  state.finance.cash = START_CASH * 10;
  const passings = getService(state).cabinetCoverage.get(cabinet)!.passings;
  const n = opts.subscribed ?? Math.ceil((opts.take ?? 0) * passings);
  state.sales.accounts = state.city.parcels.slice(0, n).map((p) => home(p.id, cabinet));
  return { state, cabinet, passings };
}

/** The smallest subscriber count at which the incumbent answers on `passings`. */
function threshold(passings: number): number {
  let n = Math.ceil(INCUMBENT_PROMO_TAKE_RATE * passings);
  while (n > 0 && (n - 1) / passings >= INCUMBENT_PROMO_TAKE_RATE) n--;
  while (n / passings < INCUMBENT_PROMO_TAKE_RATE) n++;
  return n;
}

function noticesOf(state: GameState, kind: string) {
  return state.notices.filter((n) => n.kind === kind);
}

describe('reviewIncumbent', () => {
  it('starts a promo where your take rate reaches the threshold on enough passings, and says where', () => {
    const { passings } = area();
    expect(passings).toBeGreaterThanOrEqual(INCUMBENT_PROMO_MIN_PASSINGS);
    const { state, cabinet } = area({ subscribed: threshold(passings) });
    reviewIncumbent(state);
    const endDay = closeDayAfter(JUN1, INCUMBENT_PROMO_MONTHS);
    const price = Math.max(1, INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT);
    expect(incumbentPromoPrice()).toBe(price);
    expect(state.sales.incumbentPromos).toEqual([
      { cabinet, startDay: JUN1, endDay, price, quietUntil: closeDayAfter(endDay, INCUMBENT_PROMO_QUIET_MONTHS) },
    ]);
    expect(endDay).toBe(dayOf({ year: 2027, month: 6 + INCUMBENT_PROMO_MONTHS, day: 1 }));
    expect(activePromoFor(state, cabinet)).not.toBeNull();
    expect(incumbentPriceFor(state, cabinet)).toBe(price);
    const notices = noticesOf(state, 'incumbentPromo');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ day: JUN1, cabinet, milestone: null });
    const corner = cornerName(state.city, state.network.cabinets[0]!.node);
    const take = Math.round((threshold(passings) / passings) * 100);
    expect(notices[0]!.message).toContain(`your ${take}% take rate around ${corner}`);
    expect(notices[0]!.message).toContain(`$${price}/mo promo for ${INCUMBENT_PROMO_MONTHS} months (until ${formatDate(endDay)})`);
  });

  it('waits while the take rate is below the threshold', () => {
    const { passings } = area();
    const { state } = area({ subscribed: threshold(passings) - 1 });
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toEqual([]);
    expect(state.notices).toEqual([]);
  });

  it('ignores an area with too few passings, however high your take rate', () => {
    const tiny = makeGridCity({ cols: 1, rows: 1, blockW: 2, blockH: 2 });
    const { state, passings } = area({ city: tiny, take: 1 });
    expect(passings).toBeLessThan(INCUMBENT_PROMO_MIN_PASSINGS);
    expect(areaTakeRates(state)[0]!.takeRate).toBe(1);
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toEqual([]);
  });

  it('measures each cabinet area as its accounts over its coverage passings', () => {
    const { state, cabinet, passings } = area({ subscribed: 10 });
    expect(areaTakeRates(state)).toEqual([{ cabinet, passings, units: 10, takeRate: 10 / passings }]);
  });

  it('runs INCUMBENT_PROMO_MONTHS closes, says when it ends, then stays quiet INCUMBENT_PROMO_QUIET_MONTHS closes', () => {
    const { state, cabinet } = area({ take: 1 });
    reviewIncumbent(state);
    const promo = { ...state.sales.incumbentPromos[0]! };
    // Runs until the day before endDay.
    state.day = promo.endDay - 1;
    expect(activePromoFor(state, cabinet)).not.toBeNull();
    state.day = promo.endDay;
    expect(activePromoFor(state, cabinet)).toBeNull();

    for (let c = 1; c <= INCUMBENT_PROMO_MONTHS + INCUMBENT_PROMO_QUIET_MONTHS; c++) {
      state.day = closeDayAfter(JUN1, c);
      reviewIncumbent(state);
      const ended = noticesOf(state, 'incumbentPromoEnded');
      expect(ended, `close ${c}`).toHaveLength(c >= INCUMBENT_PROMO_MONTHS ? 1 : 0);
      if (c < INCUMBENT_PROMO_MONTHS + INCUMBENT_PROMO_QUIET_MONTHS) {
        // Running, then quiet: the same record, and no second promo however high the take rate.
        expect(state.sales.incumbentPromos).toEqual([promo]);
        expect(noticesOf(state, 'incumbentPromo')).toHaveLength(1);
      }
    }
    const ended = noticesOf(state, 'incumbentPromoEnded')[0]!;
    expect(ended).toMatchObject({ day: promo.endDay, cabinet });
    expect(ended.message).toContain(`back to $${INCUMBENT_PRICE}/mo`);
    // At quietUntil the record goes, and a take rate still high starts the next promo that same close.
    expect(state.day).toBe(promo.quietUntil);
    expect(noticesOf(state, 'incumbentPromo')).toHaveLength(2);
    expect(state.sales.incumbentPromos).toEqual([{ ...promo, startDay: promo.quietUntil, endDay: closeDayAfter(promo.quietUntil, INCUMBENT_PROMO_MONTHS), quietUntil: closeDayAfter(promo.quietUntil, INCUMBENT_PROMO_MONTHS + INCUMBENT_PROMO_QUIET_MONTHS) }]);
  });

  it('drops a promo record quietly once its cabinet is gone', () => {
    const { state, cabinet } = area({ take: 1 });
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toHaveLength(1);
    state.network.cabinets = [];
    state.network.version++;
    const notices = state.notices.length;
    state.day = closeDayAfter(JUN1, 1);
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toEqual([]);
    expect(state.notices).toHaveLength(notices);
    void cabinet;
  });

  it('keeps one record per cabinet, sorted by cabinet', () => {
    const { state, cabinet } = area({ take: 1 });
    const other = addLivePlant(state, { segments: [], node: state.city.nodes.length - 1 }) as CabinetId;
    state.sales.incumbentPromos = [
      { cabinet: other, startDay: 0, endDay: 31, price: incumbentPromoPrice(), quietUntil: closeDayAfter(JUN1, 2) },
    ];
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos.map((p) => p.cabinet)).toEqual([cabinet, other].sort((a, b) => a - b));
  });
});

describe('incumbentChurnFor', () => {
  it('adds INCUMBENT_PROMO_CHURN for every month a promo ran there, judged on the ended month\'s last day', () => {
    const state = makeTestState();
    const start = JUN1;
    const end = closeDayAfter(start, INCUMBENT_PROMO_MONTHS);
    state.sales.incumbentPromos = [{ cabinet: 4, startDay: start, endDay: end, price: incumbentPromoPrice(), quietUntil: end + 200 }];
    // The close it started: it had not run yet.
    state.day = start;
    expect(incumbentChurnFor(state, 4)).toBe(0);
    // Every later close up to and including the one it ended.
    let closes = 0;
    for (let c = 1; c <= INCUMBENT_PROMO_MONTHS + 2; c++) {
      state.day = closeDayAfter(start, c);
      if (incumbentChurnFor(state, 4) === INCUMBENT_PROMO_CHURN) closes++;
      else expect(incumbentChurnFor(state, 4)).toBe(0);
    }
    expect(closes).toBe(INCUMBENT_PROMO_MONTHS);
    expect(incumbentChurnFor(state, 5, start + 3)).toBe(0);
    expect(incumbentChurnFor(state, 4, start + 3)).toBe(INCUMBENT_PROMO_CHURN);
  });
});

describe('the incumbent in play', () => {
  it('answers a high take rate at a month close, and the report counts its promo and churn', () => {
    const { state, cabinet } = area({ take: 1 });
    state.day = JUN1 - 3;
    state.sales.marketingPerMonth = 0;
    runDays(state, 3); // the Jun 1 close
    expect(state.sales.incumbentPromos.map((p) => p.cabinet)).toEqual([cabinet]);
    expect(noticesOf(state, 'incumbentPromo')).toHaveLength(1);
    const first = state.finance.reports.at(-1)!;
    expect(first.ops!.incumbentPromos).toBe(0);
    expect(first.ops!.lastNoticeId).toBe(state.nextNoticeId - 1);
    runDays(state, 30); // the Jul 1 close: it ran all June
    const report = state.finance.reports.at(-1)!;
    expect(report.month).toBe(6);
    expect(report.ops!.incumbentPromos).toBe(1);
    expect(report.ops!.incumbentChurn).toBeGreaterThanOrEqual(0);
    expect(report.ops!.incumbentChurn).toBeLessThanOrEqual(report.stats!.churned);
  });
});
