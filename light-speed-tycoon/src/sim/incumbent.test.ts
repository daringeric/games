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
  INCUMBENT_PROMO_RETRIGGER_POINTS,
  INCUMBENT_PROMO_TAKE_RATE,
  INSTALL_COST_HOME,
  MARKETING_MAX_PER_MONTH,
  RETENTION_CHURN_CUT,
  RETENTION_PERCENT_OFF,
  RETENTION_STEP_SHARE,
  SIGNUP_RAMP_PER_DAY,
  START_CASH,
  SUPPORT_COST_PER_SUB_PER_MONTH,
} from './balance';
import { dayOf, formatDate } from './calendar';
import { applyCommand, runDays } from './game';
import {
  answerIncumbent,
  bestIncumbentAnswer,
  quoteRetention,
  activePromoFor,
  activePromos,
  areaTakeRates,
  incumbentChurnFor,
  incumbentPriceFor,
  incumbentPromoPrice,
  promosRunningBetween,
  retriggerTakeRate,
  reviewIncumbent,
} from './incumbent';
import { getService } from './network';
import { closeDayAfter, DAYS_PER_MONTH, monthlyRecurringRevenue, quotePromo, retentionPrice, roughMoney, stepChurnProbability, SUGGESTED_PROMO } from './sales';
import { cornerName } from './streets';
import { addLivePlant, makeGridCity, makeTestState } from './testing/fixtures';
import type { Account, CabinetId, City, GameState, IncumbentPromo } from './types';

describe('incumbent contract', () => {
  it('reads the promo running at a cabinet and the incumbent price there', () => {
    const state = makeTestState();
    state.day = 100;
    state.sales.incumbentPromos = [
      { cabinet: 3, startDay: 90, endDay: 150, price: INCUMBENT_PRICE - 20, quietUntil: 330, triggerTakePct: 45, answered: false, answeredWithPromo: false },
      { cabinet: 7, startDay: 31, endDay: 90, price: INCUMBENT_PRICE - 10, quietUntil: 270, triggerTakePct: 45, answered: false, answeredWithPromo: false },
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
      {
        cabinet,
        startDay: JUN1,
        endDay,
        price,
        quietUntil: closeDayAfter(endDay, INCUMBENT_PROMO_QUIET_MONTHS),
        triggerTakePct: Math.round((threshold(passings) / passings) * 100),
        answered: false,
        answeredWithPromo: false,
      },
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
    // Round 4b: at quietUntil the record stays as the area's memory, and the same take rate starts no new promo.
    expect(state.day).toBe(promo.quietUntil);
    expect(noticesOf(state, 'incumbentPromo')).toHaveLength(1);
    expect(state.sales.incumbentPromos).toEqual([promo]);
    for (let c = 1; c <= 24; c++) {
      state.day = closeDayAfter(promo.quietUntil, c);
      reviewIncumbent(state);
    }
    expect(noticesOf(state, 'incumbentPromo')).toHaveLength(1);
    expect(state.sales.incumbentPromos).toEqual([promo]);
  });

  it('remembers the last promo in an area: the next needs the take rate INCUMBENT_PROMO_RETRIGGER_POINTS above the one that started it', () => {
    const { passings } = area();
    const first = threshold(passings);
    const { state, cabinet } = area({ subscribed: first });
    reviewIncumbent(state);
    const promo = { ...state.sales.incumbentPromos[0]! };
    expect(promo.triggerTakePct).toBe(Math.round((first / passings) * 100));
    const needed = retriggerTakeRate(promo);
    expect(needed).toBeCloseTo(promo.triggerTakePct / 100 + INCUMBENT_PROMO_RETRIGGER_POINTS, 12);
    let next = first;
    while (next / passings < needed) next++;
    expect(next).toBeLessThanOrEqual(passings);
    const homesFor = (n: number) => state.city.parcels.slice(0, n).map((p) => home(p.id, cabinet));

    // Still quiet: however high the take rate, nothing.
    state.sales.accounts = homesFor(next);
    state.day = promo.endDay;
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toEqual([promo]);
    // After quietUntil: just under the retrigger take rate, nothing; at it, a new promo replaces the record.
    state.day = promo.quietUntil;
    state.sales.accounts = homesFor(next - 1);
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toEqual([promo]);
    state.day = closeDayAfter(promo.quietUntil, 1);
    state.sales.accounts = homesFor(next);
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toHaveLength(1);
    expect(state.sales.incumbentPromos[0]).toMatchObject({
      cabinet,
      startDay: state.day,
      endDay: closeDayAfter(state.day, INCUMBENT_PROMO_MONTHS),
      triggerTakePct: Math.round((next / passings) * 100),
      answered: false,
      answeredWithPromo: false,
    });
    expect(noticesOf(state, 'incumbentPromo')).toHaveLength(2);
  });

  it('still needs INCUMBENT_PROMO_TAKE_RATE where the last promo started low', () => {
    const { passings } = area();
    const { state, cabinet } = area({ subscribed: threshold(passings) - 1 });
    state.sales.incumbentPromos = [{ cabinet, startDay: 0, endDay: 31, price: incumbentPromoPrice(), quietUntil: 59, triggerTakePct: 0, answered: true, answeredWithPromo: false }];
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toHaveLength(1);
    expect(state.sales.incumbentPromos[0]!.startDay).toBe(0);
    expect(noticesOf(state, 'incumbentPromo')).toHaveLength(0);
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
      { cabinet: other, startDay: 0, endDay: 31, price: incumbentPromoPrice(), quietUntil: closeDayAfter(JUN1, 2), triggerTakePct: 45, answered: false, answeredWithPromo: false },
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
    state.sales.incumbentPromos = [{ cabinet: 4, startDay: start, endDay: end, price: incumbentPromoPrice(), quietUntil: end + 200, triggerTakePct: 45, answered: false, answeredWithPromo: false }];
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

describe('the retention offer (round 4b)', () => {
  const list1g = (state: GameState) => state.sales.pricing.tiers.find((t) => t.id === 'fiber1g')!.price;

  /** Every home of TOWN subscribed on 1 Gig, and the incumbent's promo just started there (JUN1). */
  function contested(marketing = 0): Area & { promo: IncumbentPromo } {
    const made = area({ take: 1 });
    made.state.sales.marketingPerMonth = marketing;
    reviewIncumbent(made.state);
    return { ...made, promo: made.state.sales.incumbentPromos[0]! };
  }

  it('is not possible where the incumbent runs no promo, and the command says why without touching the game', () => {
    const state = makeTestState(makeGridCity());
    const cabinet = addLivePlant(state)!;
    const quote = quoteRetention(state, cabinet);
    expect(quote).toMatchObject({ ok: false, cabinet, pays: false });
    expect(quote.reasons).toEqual(['The cable company runs no promo there now']);
    const before = JSON.stringify(state);
    const result = answerIncumbent(state, cabinet);
    expect(result).toEqual({ ok: false, reason: 'The cable company runs no promo there now' });
    expect(JSON.stringify(state)).toBe(before);
  });

  it('quotes the discount, the cancellations it avoids and what they are worth, from the documented rule', () => {
    const { state, cabinet, passings, promo } = contested();
    const list = list1g(state);
    const offer = retentionPrice(list);
    expect(offer).toBe(Math.max(1, Math.round((list * (100 - RETENTION_PERCENT_OFF)) / 100)));
    expect(offer).toBeLessThan(list);
    const q = quoteRetention(state, cabinet);
    expect(q).toMatchObject({
      ok: true,
      reasons: [],
      cabinet,
      units: passings,
      percentOff: RETENTION_PERCENT_OFF,
      months: INCUMBENT_PROMO_MONTHS,
      monthlyCost: passings * (list - offer),
      totalCost: passings * (list - offer) * INCUMBENT_PROMO_MONTHS,
    });
    const avoided =
      passings * INCUMBENT_PROMO_CHURN * Math.min(1, RETENTION_CHURN_CUT) * INCUMBENT_PROMO_MONTHS - passings * stepChurnProbability(offer, list, RETENTION_STEP_SHARE);
    expect(q.cancellationsAvoided).toBe(Math.max(0, Math.round(avoided)));
    // No marketing and no intro promo: a lost subscriber's gap refills at the bare ramp, after the promo (its
    // target there is below today's subscribers, so nobody signs up meanwhile), and costs a reinstall.
    const refill = 1 / (SIGNUP_RAMP_PER_DAY * DAYS_PER_MONTH);
    const wait = (INCUMBENT_PROMO_MONTHS - 1) / 2;
    expect(q.valueSaved).toBe(Math.max(0, Math.round(avoided * ((list - SUPPORT_COST_PER_SUB_PER_MONTH) * (refill + wait) + INSTALL_COST_HOME))));
    expect(q.pays).toBe(q.valueSaved > q.totalCost);
    expect(promo.answered).toBe(false);
  });

  it('is worth less where marketing refills a lost subscriber sooner, and with fewer months left', () => {
    const quiet = quoteRetention(contested(0).state, contested(0).cabinet);
    const loud = contested(MARKETING_MAX_PER_MONTH);
    expect(quoteRetention(loud.state, loud.cabinet).valueSaved).toBeLessThan(quiet.valueSaved);
    const late = contested(0);
    late.state.day = late.promo.endDay - 1;
    const q = quoteRetention(late.state, late.cabinet);
    expect(q.months).toBe(1);
    expect(q.totalCost).toBe(q.monthlyCost);
    expect(q.cancellationsAvoided).toBeLessThan(quiet.cancellationsAvoided);
  });

  it('says why not: answered already, nobody subscribes there, game over', () => {
    const { state, cabinet } = contested();
    expect(answerIncumbent(state, cabinet)).toEqual({ ok: true, cost: 0 });
    expect(quoteRetention(state, cabinet).reasons).toEqual(["You already answered the cable company's promo there"]);
    const before = JSON.stringify(state);
    expect(answerIncumbent(state, cabinet)).toEqual({ ok: false, reason: "You already answered the cable company's promo there" });
    expect(JSON.stringify(state)).toBe(before);

    const empty = area({ subscribed: 0 });
    empty.state.sales.incumbentPromos = [{ cabinet: empty.cabinet, startDay: JUN1, endDay: closeDayAfter(JUN1, 2), price: incumbentPromoPrice(), quietUntil: closeDayAfter(JUN1, 4), triggerTakePct: 50, answered: false, answeredWithPromo: false }];
    expect(quoteRetention(empty.state, empty.cabinet)).toMatchObject({ ok: false, reasons: ['Nobody subscribes there yet'], months: 2 });

    const over = contested();
    over.state.gameOver = { day: JUN1, reason: 'insolvent', message: 'Out of cash' };
    expect(quoteRetention(over.state, over.cabinet).reasons).toEqual(['Game over: Out of cash']);
    expect(answerIncumbent(over.state, over.cabinet)).toEqual({ ok: false, reason: 'Game over: Out of cash' });
  });

  it('locks every subscriber there at the retention price until the promo ends, keeping cheaper locks, for free', () => {
    const { state, cabinet, promo } = contested();
    const list = list1g(state);
    const offer = retentionPrice(list);
    const accounts = state.sales.accounts;
    accounts[0]!.locks = [{ tier: 'fiber1g', price: offer - 5, untilDay: closeDayAfter(JUN1, 2), reason: 'promo' }];
    accounts[1]!.locks = [{ tier: 'fiber1g', price: offer + 1, untilDay: closeDayAfter(JUN1, 20), reason: 'grandfather' }];
    accounts.push({ parcel: state.city.parcels.length - 1, cabinet: cabinet + 100, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] });
    const quote = quoteRetention(state, cabinet);
    const mrr = monthlyRecurringRevenue(state);
    const cash = state.finance.cash;
    expect(applyCommand(state, { type: 'answerIncumbent', cabinet })).toEqual({ ok: true, cost: 0 });
    expect(state.finance.cash).toBe(cash);
    expect(state.sales.incumbentPromos[0]!.answered).toBe(true);
    expect(promo.answered).toBe(true);
    expect(accounts[0]!.locks).toEqual([{ tier: 'fiber1g', price: offer - 5, untilDay: closeDayAfter(JUN1, 2), reason: 'promo' }]);
    // A dearer lock promised past the promo's end is not cut short: it resumes when the retention lock ends.
    expect(accounts[1]!.locks).toEqual([
      { tier: 'fiber1g', price: offer, untilDay: promo.endDay, reason: 'retention', resume: { price: offer + 1, untilDay: closeDayAfter(JUN1, 20), reason: 'grandfather' } },
    ]);
    for (const account of accounts.slice(2)) {
      if (account.cabinet !== cabinet) expect(account.locks).toEqual([]);
      else expect(account.locks).toEqual([{ tier: 'fiber1g', price: offer, untilDay: promo.endDay, reason: 'retention' }]);
    }
    expect(mrr - monthlyRecurringRevenue(state)).toBe(quote.monthlyCost);
  });

  it('never cuts a longer grandfathered price short: it resumes when the offer ends, and the quote counts the step back to it', () => {
    const { state, cabinet, passings, promo } = contested();
    const list = list1g(state);
    const offer = retentionPrice(list);
    const kept = list - 1;
    expect(kept).toBeGreaterThan(offer);
    // Every subscriber holds a grandfathered price promised a year past the promo's end.
    const grandfatherEnd = closeDayAfter(promo.endDay, 12);
    for (const account of state.sales.accounts) account.locks = [{ tier: 'fiber1g', price: kept, untilDay: grandfatherEnd, reason: 'grandfather' }];
    const q = quoteRetention(state, cabinet);
    // The step at the promo's end goes back to the grandfathered price, not to the list price.
    const avoided = passings * INCUMBENT_PROMO_CHURN * Math.min(1, RETENTION_CHURN_CUT) * INCUMBENT_PROMO_MONTHS - passings * stepChurnProbability(offer, kept, RETENTION_STEP_SHARE);
    expect(q).toMatchObject({ ok: true, monthlyCost: passings * (kept - offer), totalCost: passings * (kept - offer) * INCUMBENT_PROMO_MONTHS });
    expect(q.cancellationsAvoided).toBe(Math.max(0, Math.round(avoided)));
    expect(applyCommand(state, { type: 'answerIncumbent', cabinet }).ok).toBe(true);
    for (const account of state.sales.accounts) {
      expect(account.locks).toEqual([{ tier: 'fiber1g', price: offer, untilDay: promo.endDay, reason: 'retention', resume: { price: kept, untilDay: grandfatherEnd, reason: 'grandfather' } }]);
    }
    // At the promo's last close the survivors go back to the grandfathered price until it was due to end ...
    runDays(state, promo.endDay - state.day);
    expect(state.day).toBe(promo.endDay);
    expect(state.sales.accounts.length).toBeGreaterThan(0);
    for (const account of state.sales.accounts) expect(account.locks).toEqual([{ tier: 'fiber1g', price: kept, untilDay: grandfatherEnd, reason: 'grandfather' }]);
    expect(noticesOf(state, 'priceStep').at(-1)?.message).toMatch(/whose retention offers ended/);
    // ... and only then step up to the list price.
    runDays(state, grandfatherEnd - state.day);
    for (const account of state.sales.accounts) expect(account.locks).toEqual([]);
    expect(noticesOf(state, 'priceStep').at(-1)?.message).toMatch(/whose grandfathered prices ended/);
  });

  it('resumes an intro-promo price promised past the promo too, and drops it when a price cut reaches it', () => {
    const { state, cabinet, promo } = contested();
    const list = list1g(state);
    const offer = retentionPrice(list);
    const intro = offer + 2;
    expect(intro).toBeLessThan(list);
    const introEnd = closeDayAfter(promo.endDay, 2);
    for (const account of state.sales.accounts) account.locks = [{ tier: 'fiber1g', price: intro, untilDay: introEnd, reason: 'promo' }];
    expect(applyCommand(state, { type: 'answerIncumbent', cabinet }).ok).toBe(true);
    const account = state.sales.accounts[0]!;
    expect(account.locks[0]).toMatchObject({ reason: 'retention', price: offer, resume: { price: intro, untilDay: introEnd, reason: 'promo' } });
    // Cut the list price to the intro price: the retention price still beats it, the resumed one would not.
    const tiers = state.sales.pricing.tiers.map((t) => ({ id: t.id, price: t.id === 'fiber1g' ? intro : t.price, offered: t.offered }));
    expect(applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: state.sales.pricing.smbMultiplier }).ok).toBe(true);
    runDays(state, promo.endDay - state.day);
    for (const a of state.sales.accounts) expect(a.locks).toEqual([]);
  });
});

describe('the best answer to a promo (round 4b)', () => {
  it('is none where no promo runs', () => {
    const state = makeTestState(makeGridCity());
    const cabinet = addLivePlant(state)!;
    expect(bestIncumbentAnswer(state, cabinet)).toMatchObject({ cabinet, kind: 'none', promo: null, netValue: 0, text: '' });
  });

  it('is the retention offer when it pays, in one sentence with its figures, and none once answered', () => {
    // With no marketing a lost subscriber takes longest to replace, which is when keeping one pays.
    const { state, cabinet } = area({ take: 1 });
    state.sales.marketingPerMonth = 0;
    reviewIncumbent(state);
    const promo = state.sales.incumbentPromos[0]!;
    const quote = quoteRetention(state, cabinet);
    expect(quote.pays).toBe(true);
    const answer = bestIncumbentAnswer(state, cabinet);
    expect(answer).toEqual({
      cabinet,
      kind: 'retention',
      retention: quote,
      promo: null,
      netValue: quote.valueSaved - quote.totalCost,
      text:
        `A retention offer (${RETENTION_PERCENT_OFF}% off until ${formatDate(promo.endDay)}) costs about ${roughMoney(quote.totalCost)} ` +
        `and keeps about ${quote.cancellationsAvoided} subscribers worth ${roughMoney(quote.valueSaved)}: answer it in Pricing.`,
    });
    applyCommand(state, { type: 'answerIncumbent', cabinet });
    expect(bestIncumbentAnswer(state, cabinet)).toMatchObject({ kind: 'none', netValue: 0, text: '' });
  });

  it('is none when nothing pays: one close left, the step back up costs more than the month saves', () => {
    const { state, cabinet } = area({ take: 1 });
    reviewIncumbent(state);
    state.day = state.sales.incumbentPromos[0]!.endDay - 1;
    expect(quoteRetention(state, cabinet).pays).toBe(false);
    expect(bestIncumbentAnswer(state, cabinet)).toMatchObject({ kind: 'none', promo: null, netValue: 0, text: '' });
  });

  it('is an intro promo when one pays town-wide and brings signups where the promo runs', () => {
    const { state, cabinet } = area({ subscribed: 10 });
    state.sales.incumbentPromos = [{ cabinet, startDay: JUN1, endDay: closeDayAfter(JUN1, INCUMBENT_PROMO_MONTHS), price: incumbentPromoPrice(), quietUntil: closeDayAfter(JUN1, 12), triggerTakePct: 45, answered: false, answeredWithPromo: false }];
    const town = quotePromo(state, { ...SUGGESTED_PROMO });
    expect(town.pays).toBe(true);
    expect(quotePromo(state, { ...SUGGESTED_PROMO }, cabinet).extraSignups).toBeGreaterThanOrEqual(1);
    const answer = bestIncumbentAnswer(state, cabinet);
    expect(answer).toMatchObject({ kind: 'introPromo', promo: SUGGESTED_PROMO, netValue: town.valueGained - town.discountCost });
    expect(answer.text).toMatch(new RegExp(`^An intro promo \\(${SUGGESTED_PROMO.percentOff}% off for ${SUGGESTED_PROMO.months} months?\\) brings about \\d+ more signups? around .+: set it in Pricing\\.$`));
    // Not while an intro promo is already set.
    state.sales.promo = { ...SUGGESTED_PROMO };
    expect(bestIncumbentAnswer(state, cabinet).kind).not.toBe('introPromo');
  });
});
