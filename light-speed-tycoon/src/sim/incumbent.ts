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
//
// Round 4b (pricing-balance workstream; the contract added the types, the
// IncumbentPromo fields and documented stubs): the trigger sits above the
// steady-state take rate and remembers the last promo per area
// (triggerTakePct, INCUMBENT_PROMO_RETRIGGER_POINTS), and the player can
// answer a running promo with a retention offer (answerIncumbent,
// quoteRetention) that pays where the promo would otherwise cost
// subscribers.

import {
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_CHURN,
  INCUMBENT_PROMO_DISCOUNT,
  INCUMBENT_PROMO_MIN_PASSINGS,
  INCUMBENT_PROMO_MONTHS,
  INCUMBENT_PROMO_QUIET_MONTHS,
  INCUMBENT_PROMO_RETRIGGER_POINTS,
  INCUMBENT_PROMO_TAKE_RATE,
  PROMO_QUOTE_MONTHS,
  RETENTION_CHURN_CUT,
  RETENTION_PERCENT_OFF,
  RETENTION_STEP_SHARE,
  SIGNUP_RAMP_PER_DAY,
  SUPPORT_COST_PER_SUB_PER_MONTH,
  TIER_DEFAULTS,
} from './balance';
import { formatDate } from './calendar';
import { formatMoney } from './finance';
import { getService } from './network';
import { postNotice } from './notices';
import {
  accountUnits,
  closeDayAfter,
  DAYS_PER_MONTH,
  installCost,
  lockOn,
  marketingBoost,
  promoSignupFactor,
  putLock,
  quotePromo,
  retentionPrice,
  roughMoney,
  setPromo,
  stateTakeRate,
  stepChurnProbability,
  SUGGESTED_PROMO,
  unitPrice,
} from './sales';
import { cornerName } from './streets';
import type { CabinetId, CommandResult, GameState, IncumbentAnswer, IncumbentPromo, IntroPromo, PriceLock, PriceLockResume, RetentionQuote } from './types';

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
 * Round 4b: the take rate the next promo at a cabinet whose last promo is
 * `record` needs: record.triggerTakePct / 100 + INCUMBENT_PROMO_RETRIGGER_POINTS.
 */
export function retriggerTakeRate(record: IncumbentPromo): number {
  return record.triggerTakePct / 100 + INCUMBENT_PROMO_RETRIGGER_POINTS;
}

/**
 * Month close step (finance.closeMonth, after debt.reviewDebt and before the
 * insolvency check; never once the game is over): end and start incumbent
 * promos. Cabinets ascending:
 * 1. A promo that ended since the previous close (previous close < endDay <=
 *    state.day) posts 'incumbentPromoEnded' (Notice.cabinet set). Round 4b:
 *    a record stays after its quietUntil as the area's memory (one per
 *    cabinet); only the records of cabinets that no longer exist are dropped
 *    (silently).
 * 2. Each active cabinet (getService(state).activeCabinets) with at least
 *    INCUMBENT_PROMO_MIN_PASSINGS passings in its coverage whose take rate
 *    (areaTakeRates) is at least INCUMBENT_PROMO_TAKE_RATE gets a promo,
 *    unless it has a record and either state.day < its quietUntil (running
 *    or quiet) or the take rate is below retriggerTakeRate(record) (round 4b:
 *    a mature area does not cycle forever). The promo, replacing any record:
 *    { cabinet, startDay: day, endDay: the close INCUMBENT_PROMO_MONTHS
 *    closes later, price: incumbentPromoPrice(), quietUntil:
 *    INCUMBENT_PROMO_QUIET_MONTHS closes after endDay, triggerTakePct:
 *    round(take rate x 100), answered: false, answeredWithPromo: false }; it
 *    posts 'incumbentPromo' with the cabinet's corner, the take rate, the
 *    promo price and how long.
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
    kept.push(promo);
  }

  const months = Math.max(1, INCUMBENT_PROMO_MONTHS);
  const quiet = Math.max(0, INCUMBENT_PROMO_QUIET_MONTHS);
  const price = incumbentPromoPrice();
  const started: IncumbentPromo[] = [];
  for (const area of areaTakeRates(state)) {
    if (area.passings < INCUMBENT_PROMO_MIN_PASSINGS || area.takeRate < INCUMBENT_PROMO_TAKE_RATE) continue;
    const record = kept.find((p) => p.cabinet === area.cabinet);
    if (record && (day < record.quietUntil || area.takeRate < retriggerTakeRate(record))) continue;
    const endDay = closeDayAfter(day, months);
    const promo: IncumbentPromo = {
      cabinet: area.cabinet,
      startDay: day,
      endDay,
      price,
      quietUntil: closeDayAfter(endDay, quiet),
      triggerTakePct: Math.max(0, Math.min(100, Math.round(area.takeRate * 100))),
      answered: false,
      answeredWithPromo: false,
    };
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
  const renewed = new Set(started.map((p) => p.cabinet));
  state.sales.incumbentPromos = [...kept.filter((p) => !renewed.has(p.cabinet)), ...started].sort((a, b) => a.cabinet - b.cabinet);
}

/**
 * Round 4b: whether the promo running at `cabinet` on `day` (default
 * yesterday, as incumbentChurnFor) was answered with a retention offer
 * (IncumbentPromo.answered). sales.closeSalesMonth spares the units it
 * covers RETENTION_CHURN_CUT of the promo's churn.
 */
export function answeredPromoAt(state: GameState, cabinet: CabinetId, day: number = state.day - 1): boolean {
  for (const promo of state.sales.incumbentPromos) {
    if (promo.cabinet === cabinet && promo.startDay <= day && day < promo.endDay) return promo.answered;
  }
  return false;
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

// ---------------------------------------------------------------------------
// Round 4b: the retention offer
// ---------------------------------------------------------------------------

/** Month closes in (day, endDay]: how many closes a lock ending at endDay still covers. */
function closesUntil(day: number, endDay: number): number {
  let n = 0;
  while (n < 1_000 && closeDayAfter(day, n + 1) <= endDay) n++;
  return n;
}

/** Why no retention offer is possible at `cabinet` today, or null when it is. */
function retentionRefusal(state: GameState, cabinet: CabinetId, promo: IncumbentPromo | null, units: number): string | null {
  if (state.gameOver) return `Game over: ${state.gameOver.message}`;
  if (!state.network.cabinets.some((c) => c.id === cabinet)) return 'That cabinet no longer exists';
  if (!promo) return 'The cable company runs no promo there now';
  if (promo.answered) return "You already answered the cable company's promo there";
  if (units <= 0) return 'Nobody subscribes there yet';
  return null;
}

/**
 * What answering the promo running at `cabinet` with a retention offer would
 * cost and save (see RetentionQuote). Pure, no rng. Per subscribed unit on
 * accounts of that cabinet (L = its tier's list price, R =
 * sales.retentionPrice(L), RETENTION_PERCENT_OFF off):
 * - one already locked at or below R keeps its lock (no cost) and is covered
 *   while that lock lasts (closes until the earlier of its untilDay and the
 *   promo's endDay); any other gets a 'retention' lock at R until endDay:
 *   monthlyCost adds what it pays now less what it would pay (a business
 *   at its multiplier), and it is covered for `months` (closes until
 *   endDay), then steps back up (stepChurnProbability(R, back,
 *   RETENTION_STEP_SHARE)), `back` being L, or the dearer lock's price when
 *   that lock was promised past endDay (answerIncumbent gives it back then);
 * - cancellationsAvoided = covered unit-months x INCUMBENT_PROMO_CHURN x
 *   RETENTION_CHURN_CUT less the step's cancellations (at least 0);
 * - one cancellation costs the reinstall (installCost, router already in)
 *   plus its margin (list price less SUPPORT_COST_PER_SUB_PER_MONTH) until
 *   the gap is signed up again: 1 / today's ramp days (SIGNUP_RAMP_PER_DAY x
 *   (1 + marketing boost) x the intro promo's factor), plus, while the
 *   promo's target take rate there (stateTakeRate at its price, over the
 *   area's passings) is at or below the units already subscribed (nobody
 *   signs up there until it ends), the wait for its end: (months - 1) / 2
 *   on average over the closes left;
 * - totalCost = monthlyCost x months; pays = valueSaved > totalCost.
 * ok false (with the reason) when the game is over, the cabinet is gone, no
 * promo runs there, it is already answered or nobody subscribes there.
 */
export function quoteRetention(state: GameState, cabinet: CabinetId): RetentionQuote {
  const promo = activePromoFor(state, cabinet);
  const accounts = state.sales.accounts.filter((a) => a.cabinet === cabinet);
  let units = 0;
  for (const account of accounts) units += accountUnits(account);
  const refusal = retentionRefusal(state, cabinet, promo, units);
  const quote: RetentionQuote = {
    ok: refusal === null,
    reasons: refusal === null ? [] : [refusal],
    cabinet,
    units,
    percentOff: RETENTION_PERCENT_OFF,
    months: 0,
    monthlyCost: 0,
    totalCost: 0,
    cancellationsAvoided: 0,
    valueSaved: 0,
    pays: false,
  };
  if (!promo) return quote;
  const months = closesUntil(state.day, promo.endDay);
  quote.months = months;
  if (refusal !== null) return quote;

  const pricing = state.sales.pricing;
  const routers = new Set(state.sales.routerParcels);
  let monthlyCost = 0;
  let coveredUnitMonths = 0;
  let stepCancels = 0;
  let margin = 0;
  let reinstall = 0;
  for (const account of accounts) {
    const kind = state.city.parcels[account.parcel]?.kind ?? 'home';
    for (const tier of pricing.tiers) {
      const n = account.tierUnits[tier.id];
      if (n === 0) continue;
      const list = tier.price;
      const offer = retentionPrice(list);
      const lock = lockOn(account, tier.id);
      const paid = lock ? Math.min(lock.price, list) : list;
      margin += n * (unitPrice(pricing, tier.id, kind) - SUPPORT_COST_PER_SUB_PER_MONTH);
      reinstall += n * installCost(kind, kind !== 'mdu' || routers.has(account.parcel));
      if (lock && paid <= offer) {
        coveredUnitMonths += n * closesUntil(state.day, Math.min(lock.untilDay, promo.endDay));
        continue;
      }
      if (offer >= list) continue;
      const bill = (household: number) => (kind === 'smb' ? Math.round(household * pricing.smbMultiplier) : household);
      monthlyCost += n * (bill(paid) - bill(offer));
      coveredUnitMonths += n * months;
      // The step at the promo's end: back to a longer lock it would replace (answerIncumbent resumes it), else to the list price.
      const resume = resumeOf(lock, promo.endDay);
      stepCancels += n * stepChurnProbability(offer, resume ? Math.min(resume.price, list) : list, RETENTION_STEP_SHARE);
    }
  }
  const avoided = coveredUnitMonths * INCUMBENT_PROMO_CHURN * Math.min(1, Math.max(0, RETENTION_CHURN_CUT)) - stepCancels;

  // What one cancellation costs there.
  const service = getService(state);
  const ramp = SIGNUP_RAMP_PER_DAY * (1 + marketingBoost(state.sales.marketingPerMonth, service.passings)) * promoSignupFactor(state.sales.promo);
  const refillMonths = ramp > 0 ? 1 / (ramp * DAYS_PER_MONTH) : 0;
  const kinds = areaPassings(state, cabinet);
  let promoTarget = 0;
  for (const kind of ['home', 'mdu', 'smb'] as const) promoTarget += kinds[kind] * stateTakeRate(state, kind, cabinet);
  const waitMonths = promoTarget <= units ? (months - 1) / 2 : 0;
  const perCancel = (margin / units) * (refillMonths + waitMonths) + reinstall / units;
  const saved = avoided * perCancel;

  quote.monthlyCost = monthlyCost;
  quote.totalCost = monthlyCost * months;
  quote.cancellationsAvoided = Math.max(0, Math.round(avoided));
  quote.valueSaved = Math.max(0, Math.round(saved));
  quote.pays = saved > quote.totalCost;
  return quote;
}

/** Passings (units present) per building kind on the streets `cabinet` serves today. */
function areaPassings(state: GameState, cabinet: CabinetId): Record<'home' | 'mdu' | 'smb', number> {
  const service = getService(state);
  const out = { home: 0, mdu: 0, smb: 0 };
  for (const id of service.passedParcels) {
    const parcel = state.city.parcels[id];
    if (!parcel || service.servingCabinet.get(parcel.segment) !== cabinet) continue;
    out[parcel.kind] += parcel.units;
  }
  return out;
}

/**
 * answerIncumbent command. Rejects (state untouched, reason from
 * quoteRetention) unless quoteRetention(state, cabinet).ok; then every
 * account on `cabinet` gets, on each tier it has units on, a PriceLock
 * { reason 'retention', price: sales.retentionPrice(list) (max(1, round(list
 * x (100 - RETENTION_PERCENT_OFF) / 100))), untilDay: the promo's endDay }
 * unless it already holds a lock at or below that price there (kept; a
 * dearer lock is replaced, and when it was promised past the promo's end it
 * becomes the new lock's `resume`, so the promise is never cut short: its
 * units go back to it when the retention lock ends), the promo's `answered`
 * becomes true, and returns
 * { ok: true, cost: 0 } (the discount bills from the next daily accrual).
 * While the promo runs, a unit on a retention lock, or on a cheaper lock it
 * kept, is spared RETENTION_CHURN_CUT of the promo's extra churn
 * (sales.closeSalesMonth); when a retention lock ends its price steps back
 * up with churn share RETENTION_STEP_SHARE (sales.stepShare).
 */
export function answerIncumbent(state: GameState, cabinet: CabinetId): CommandResult {
  if (state.gameOver) return { ok: false, reason: `Game over: ${state.gameOver.message}` };
  const quote = quoteRetention(state, cabinet);
  const promo = activePromoFor(state, cabinet);
  if (!quote.ok || !promo) return { ok: false, reason: quote.reasons[0] ?? 'No retention offer is possible there' };
  const pricing = state.sales.pricing;
  for (const account of state.sales.accounts) {
    if (account.cabinet !== cabinet) continue;
    for (const tier of pricing.tiers) {
      if (account.tierUnits[tier.id] === 0) continue;
      const price = retentionPrice(tier.price);
      if (price >= tier.price) continue;
      const lock = lockOn(account, tier.id);
      if (lock && lock.price <= price) continue;
      const resume = resumeOf(lock, promo.endDay);
      putLock(account, resume ? { tier: tier.id, price, untilDay: promo.endDay, reason: 'retention', resume } : { tier: tier.id, price, untilDay: promo.endDay, reason: 'retention' });
    }
  }
  promo.answered = true;
  return { ok: true, cost: 0 };
}

/**
 * The lock a retention lock ending at `endDay` gives back (PriceLock.resume)
 * when it replaces `lock`: `lock` itself when it was promised past endDay
 * (a retention lock's own resume when that is), else none.
 */
function resumeOf(lock: PriceLock | undefined, endDay: number): PriceLockResume | null {
  if (!lock) return null;
  if (lock.reason === 'retention') return lock.resume && lock.resume.untilDay > endDay ? { ...lock.resume } : null;
  return lock.untilDay > endDay ? { price: lock.price, untilDay: lock.untilDay, reason: lock.reason } : null;
}

/**
 * The best answer to the promo running at `cabinet` (see IncumbentAnswer).
 * Pure, no rng. None when the game is over, no promo runs there or it is
 * answered (with a retention offer, or with the intro promo this
 * recommended: IncumbentPromo.answeredWithPromo); else the remedy with the
 * largest positive net value:
 * - the retention offer (quoteRetention) when it pays: valueSaved - totalCost;
 * - an intro promo (sales.SUGGESTED_PROMO, the one the pricing panel starts
 *   at) when no intro promo is set, its town-wide quote (sales.quotePromo)
 *   pays, and it brings at least one extra signup on the streets that
 *   cabinet serves (so it really answers the promo there):
 *   valueGained - discountCost;
 * none when neither pays. `text` names the remedy, its cost and what it
 * saves, e.g. "A retention offer (15% off until Jun 1, 2029) costs about
 * $1,800 and keeps about 9 subscribers worth $4,100: answer it in Pricing."
 * The advisor renders it verbatim.
 */
export function bestIncumbentAnswer(state: GameState, cabinet: CabinetId): IncumbentAnswer {
  const retention = quoteRetention(state, cabinet);
  const none: IncumbentAnswer = { cabinet, kind: 'none', retention, promo: null, netValue: 0, text: '' };
  const running = activePromoFor(state, cabinet);
  if (state.gameOver || !running || running.answered || running.answeredWithPromo) return none;
  let best = none;
  if (retention.ok && retention.pays) {
    const net = retention.valueSaved - retention.totalCost;
    if (net > 0) {
      const kept = Math.max(1, retention.cancellationsAvoided);
      best = {
        cabinet,
        kind: 'retention',
        retention,
        promo: null,
        netValue: net,
        text:
          `A retention offer (${retention.percentOff}% off until ${formatDate(running.endDay)}) costs about ${roughMoney(retention.totalCost)} ` +
          `and keeps about ${kept} subscriber${kept === 1 ? '' : 's'} worth ${roughMoney(retention.valueSaved)}: answer it in Pricing.`,
      };
    }
  }
  if (state.sales.promo === null) {
    const offer: IntroPromo = { ...SUGGESTED_PROMO };
    const town = quotePromo(state, offer);
    const area = quotePromo(state, offer, cabinet);
    const net = town.valueGained - town.discountCost;
    if (town.ok && town.pays && area.extraSignups >= 1 && net > best.netValue) {
      best = {
        cabinet,
        kind: 'introPromo',
        retention,
        promo: offer,
        netValue: net,
        text:
          `An intro promo (${offer.percentOff}% off for ${offer.months} month${offer.months === 1 ? '' : 's'}) brings about ${area.extraSignups} more ` +
          `signup${area.extraSignups === 1 ? '' : 's'} around ${cabinetCorner(state, cabinet)} within ${PROMO_QUOTE_MONTHS} months, worth about ` +
          `${roughMoney(town.valueGained)} against ${roughMoney(town.discountCost)} of discounts town-wide: set it in Pricing.`,
      };
    }
  }
  return best;
}

/**
 * setPromo command (game.applyCommand routes it here; sales.setPromo checks
 * and sets the intro promo). Round 4b: setting an intro promo answers every
 * running promo whose best answer (bestIncumbentAnswer, read before the
 * change) was an intro promo: its answeredWithPromo becomes true, so the
 * advisor's card that recommended it clears instead of falling back to
 * another remedy. Taking the intro promo away (null) makes every running
 * promo's answeredWithPromo false again (its card comes back). A rejected
 * promo changes nothing.
 */
export function setIntroPromo(state: GameState, promo: IntroPromo | null): CommandResult {
  const running = activePromos(state);
  const answering = promo === null || state.gameOver ? [] : running.filter((p) => !p.answered && !p.answeredWithPromo && bestIncumbentAnswer(state, p.cabinet).kind === 'introPromo');
  const result = setPromo(state, promo);
  if (!result.ok) return result;
  if (promo === null) for (const p of running) p.answeredWithPromo = false;
  for (const p of answering) p.answeredWithPromo = true;
  return result;
}
