// Pricing: the three tiers (price, offered), the business price multiplier,
// how long a price rise is grandfathered for today's subscribers and the
// intro promo for new signups, with a live preview of what the edited values
// would do: target take rate per building kind, tier mix and business
// prices, what today's subscribers pay and until when (sales.quotePricing:
// who keeps what, their monthly bills now and once the step and the expected
// cancellations it lists have happened, retired tiers' moves), the promo's
// prices, and the incumbent's running promos (where, its price, until when,
// your target take rate there vs elsewhere). Apply sends setPricing (with
// grandfatherMonths), then setPromo if it changed; the sim validates each and
// its reason is shown on a rejection.
//
// Round 4c/4d (ui-customers, spec I.5): the marketing budget moved to the
// Customers dashboard, where it has a forecast. This panel shows it read-only
// with a "Change marketing" link (PricingLinks.marketing, wired by main.ts)
// and Apply no longer sends setMarketing. Spec C: the "after" figure is
// quotePricing's mrrAfterChurn, after the expected cancellations it lists.
//
// Round 4b (pricing-balance): "Who signs up" (sales.segmentDemand: each
// demand segment's take rate and favourite tier, and a warning when no plan
// suits one), the intro promo's "when it pays" line (sales.quotePromo), and
// for each running incumbent promo the retention offer's figures
// (incumbent.quoteRetention) with a button that sends answerIncumbent.
//
// Owner: ui-customers workstream (round 4c/4d; pricing-balance in round 4b, sim-pricing in round 4, ui-economy before).

import {
  GRANDFATHER_MONTHS_DEFAULT,
  GRANDFATHER_MONTHS_MAX,
  INCUMBENT_DOWN_MBPS,
  INCUMBENT_PRICE,
  PROMO_MAX_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  RETENTION_PERCENT_OFF,
  SMB_MULTIPLIER_MAX,
  SMB_MULTIPLIER_MIN,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
} from '../sim/balance';
import { formatDate } from '../sim/calendar';
import { activePromos, quoteRetention } from '../sim/incumbent';
import {
  lockOn,
  promoDiscountShare,
  promoPrice,
  quotePricing,
  quotePromo,
  reservationPrice,
  retireDestination,
  roughMoney,
  segmentDemand,
  SUGGESTED_PROMO,
  TIER_IDS,
  targetTakeRate,
  tierMix,
  unitPrice,
  unitsByTier,
} from '../sim/sales';
import { cornerName } from '../sim/streets';
import type {
  CabinetId,
  DemandSegmentId,
  GameState,
  IntroPromo,
  ParcelKind,
  Pricing,
  PricingQuote,
  RetentionQuote,
  TierId,
  TierSetting,
} from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el, setText } from './dom';
import { formatMoney, formatNumber, formatPercent, plural } from './format';
import type { Toasts } from './overlays';
import type { GameSession } from './session';

/** The intro promo controls as typed: values may be out of range or NaN, and kept while it is switched off. */
export interface PromoDraft {
  enabled: boolean;
  percentOff: number;
  months: number;
}

/** What the player has typed: may be out of range or not a number at all (NaN). */
export interface PricingDraft {
  tiers: TierSetting[];
  smbMultiplier: number;
  /** Month closes a price rise waits before reaching today's subscribers (setPricing grandfatherMonths). */
  grandfatherMonths: number;
  promo: PromoDraft;
}

/** Where the promo controls start when the game has no promo (a UI suggestion, not a sim rule: sales.SUGGESTED_PROMO, which the advisor's answer weighs too). */
export const PROMO_DRAFT_START: Readonly<IntroPromo> = SUGGESTED_PROMO;

export interface PricingPreview {
  /** Every field is in range and at least one tier is offered (the sim would accept it). */
  valid: boolean;
  /** Plain-language problems with the draft, for the inline hint. */
  problems: string[];
  /** Target take rate by building kind for the draft prices (and intro promo); null while the draft is invalid. */
  takeRate: Record<ParcelKind, number> | null;
  /** Share of new signups per tier for the draft prices; null while the draft is invalid. */
  mix: Record<TierId, number> | null;
  /** Monthly price a business pays per tier at the draft multiplier; null while invalid. */
  smbPrices: Record<TierId, number> | null;
  /** Household price on the intro promo per tier; null without a valid promo (or valid tiers). */
  promoPrices: Record<TierId, number> | null;
}

/** "The incumbent cable company: 300 Mbps for $75/mo" in the panel's words. */
export function incumbentOffer(): string {
  return `Incumbent cable: ${formatNumber(INCUMBENT_DOWN_MBPS)} Mbps for ${formatMoney(INCUMBENT_PRICE)}/mo`;
}

/** The draft matching the game's current pricing and intro promo; grandfathering starts at the default. */
export function draftFrom(pricing: Pricing, promo: IntroPromo | null = null): PricingDraft {
  return {
    tiers: pricing.tiers.map((t) => ({ id: t.id, price: t.price, offered: t.offered })),
    smbMultiplier: pricing.smbMultiplier,
    grandfatherMonths: GRANDFATHER_MONTHS_DEFAULT,
    promo: promo ? { enabled: true, percentOff: promo.percentOff, months: promo.months } : { enabled: false, ...PROMO_DRAFT_START },
  };
}

/** The intro promo a draft asks for (setPromo's argument): null when switched off. */
export function draftPromo(draft: PricingDraft): IntroPromo | null {
  return draft.promo.enabled ? { percentOff: draft.promo.percentOff, months: draft.promo.months } : null;
}

/** Whether two intro promos are the same offer (null = none). */
export function samePromo(a: IntroPromo | null, b: IntroPromo | null): boolean {
  if (a === null || b === null) return a === b;
  return a.percentOff === b.percentOff && a.months === b.months;
}

/** A number typed into an input: NaN for an empty or malformed field. */
export function parseNumberField(value: string): number {
  const text = value.trim();
  return text === '' ? Number.NaN : Number(text);
}

const isWhole = (n: number) => Number.isInteger(n);
const inRange = (n: number, min: number, max: number) => isWhole(n) && n >= min && n <= max;

/** The draft's prices and offered flags on `base` (names and speeds from it); the multiplier when valid. */
function pricingFrom(base: Pricing, draft: PricingDraft, smbOk: boolean): Pricing {
  return {
    tiers: base.tiers.map((tier) => {
      const setting = draft.tiers.find((t) => t.id === tier.id);
      return setting ? { ...tier, price: setting.price, offered: setting.offered } : tier;
    }),
    smbMultiplier: smbOk ? draft.smbMultiplier : base.smbMultiplier,
  };
}

function tierProblemsOf(base: Pricing, draft: PricingDraft): string[] {
  const problems: string[] = [];
  for (const setting of draft.tiers) {
    const name = base.tiers.find((t) => t.id === setting.id)?.name ?? setting.id;
    if (!inRange(setting.price, TIER_PRICE_MIN, TIER_PRICE_MAX)) {
      problems.push(`${name}: price must be a whole number from ${formatMoney(TIER_PRICE_MIN)} to ${formatMoney(TIER_PRICE_MAX)}`);
    }
  }
  if (!draft.tiers.some((t) => t.offered)) problems.push('Offer at least one tier');
  return problems;
}

/** The draft's grandfathering is one setPricing accepts. */
export function grandfatherOk(months: number): boolean {
  return inRange(months, 0, GRANDFATHER_MONTHS_MAX);
}

/** The draft's promo is one setPromo accepts (always, when switched off). */
export function promoOk(promo: PromoDraft): boolean {
  return !promo.enabled || (inRange(promo.percentOff, 1, PROMO_MAX_PERCENT_OFF) && inRange(promo.months, 1, PROMO_MAX_MONTHS));
}

/**
 * Check a draft the way setPricing/setPromo will, and preview its effect:
 * target take rates (with the intro promo valued) and tier mix from sales.ts
 * for the edited prices (names and speeds from `base`), business and promo
 * prices. (The marketing budget lives on the Customers dashboard:
 * customersPanel.marketingProblem / marketingForecast.)
 */
export function pricingPreview(base: Pricing, draft: PricingDraft): PricingPreview {
  const tierProblems = tierProblemsOf(base, draft);
  const problems = [...tierProblems];
  const smb = draft.smbMultiplier;
  const smbOk = Number.isFinite(smb) && smb >= SMB_MULTIPLIER_MIN && smb <= SMB_MULTIPLIER_MAX;
  if (!smbOk) problems.push(`Business multiplier must be from ${SMB_MULTIPLIER_MIN} to ${SMB_MULTIPLIER_MAX}`);
  if (!grandfatherOk(draft.grandfatherMonths)) problems.push(`Grandfathering must be a whole number of months from 0 to ${GRANDFATHER_MONTHS_MAX}`);
  const promoValid = promoOk(draft.promo);
  if (!promoValid) {
    if (!inRange(draft.promo.percentOff, 1, PROMO_MAX_PERCENT_OFF)) problems.push(`Intro promo must be a whole percent off from 1% to ${PROMO_MAX_PERCENT_OFF}%`);
    if (!inRange(draft.promo.months, 1, PROMO_MAX_MONTHS)) problems.push(`Intro promo must last a whole number of months from 1 to ${PROMO_MAX_MONTHS}`);
  }
  // Take rates and the mix need valid tiers (the business take rate also follows the multiplier).
  if (tierProblems.length > 0) return { valid: false, problems, takeRate: null, mix: null, smbPrices: null, promoPrices: null };

  const pricing = pricingFrom(base, draft, smbOk);
  const promo = promoValid ? draftPromo(draft) : null;
  const takeRate = {
    home: targetTakeRate(pricing, 'home', INCUMBENT_PRICE, promo),
    mdu: targetTakeRate(pricing, 'mdu', INCUMBENT_PRICE, promo),
    smb: targetTakeRate(pricing, 'smb', INCUMBENT_PRICE, promo),
  };
  let smbPrices: Record<TierId, number> | null = null;
  if (smbOk) {
    smbPrices = {} as Record<TierId, number>;
    for (const tier of pricing.tiers) smbPrices[tier.id] = unitPrice(pricing, tier.id, 'smb');
  }
  let promoPrices: Record<TierId, number> | null = null;
  if (promo) {
    promoPrices = {} as Record<TierId, number>;
    for (const tier of pricing.tiers) promoPrices[tier.id] = promoPrice(tier.price, promo.percentOff);
  }
  return {
    valid: problems.length === 0,
    problems,
    takeRate,
    mix: tierMix(pricing, 'home', INCUMBENT_PRICE, promo),
    smbPrices,
    promoPrices,
  };
}

/** The read-only marketing line (round 4c/4d: the budget is set on the Customers dashboard). */
export function marketingLine(marketingPerMonth: number): string {
  return marketingPerMonth > 0 ? `${formatMoney(marketingPerMonth)} a month` : 'None';
}

/** What the impact figures say (pricingImpact's quote), in the panel's plain words; dashes while the draft is invalid. */
export interface ImpactFigures {
  /** "$12,400/mo": what today's subscribers pay a month right after the change (grandfathered prices held). */
  now: string;
  /** "$12,900/mo": the same once the step has happened, less what the expected cancellations paid (quotePricing.mrrAfterChurn). */
  after: string;
  /** "~4": the expected cancellations. */
  cancels: string;
  /** The line under the figures: what "after" counts. */
  note: string;
}

/** The three impact figures and the note under them (spec C: the after figure counts the cancellations it lists). Pure. */
export function impactFigures(quote: PricingQuote | null): ImpactFigures {
  if (!quote) return { now: '–', after: '–', cancels: '–', note: '' };
  const n = quote.expectedChurn;
  return {
    now: `${formatMoney(quote.mrrNow)}/mo`,
    after: `${formatMoney(quote.mrrAfterChurn)}/mo`,
    cancels: `~${formatNumber(n)}`,
    note:
      n > 0
        ? `"After the step" is what today's subscribers pay once raised prices reach them and retired tiers move, after the ~${plural(n, 'cancellation')} expected.`
        : `"After the step" is what today's subscribers pay once raised prices reach them and retired tiers move.`,
  };
}

/** The line under the grandfathering control. */
export function grandfatherHint(months: number): string {
  if (!grandfatherOk(months)) return '';
  if (months === 0) return 'Existing subscribers pay a price rise from the next bill (0 = from the next bill). Cuts reach everyone at once.';
  return `Existing subscribers keep their price for ${plural(months, 'month')}; 0 = from the next bill. Cuts reach everyone at once.`;
}

/** The line under the intro promo controls: the offer at the draft's prices, offered tiers only. */
export function promoHint(base: Pricing, draft: PricingDraft, preview: PricingPreview): string {
  if (!draft.promo.enabled) return 'No intro promo: new subscribers pay the list price.';
  if (!preview.promoPrices) return '';
  const offers = TIER_IDS.filter((id) => draft.tiers.find((t) => t.id === id)?.offered).map(
    (id) => `${base.tiers.find((t) => t.id === id)?.name ?? id} ${formatMoney(preview.promoPrices![id])}`,
  );
  return (
    `New subscribers get ${draft.promo.percentOff}% off for the rest of their first month and ${plural(draft.promo.months, 'more month')}` +
    ` (${offers.join(', ')}), then the list price.`
  );
}

/**
 * The intro promo's "when it pays" line: sales.quotePromo for the offer the
 * controls hold (even while switched off, so the player sees when one would
 * pay; with no valid offer typed, the general advice), its advice sentence
 * and, for an offer with households waiting, its figures over
 * promoQuoteMonths (quote.months). Empty once the game is over. Pure.
 */
export function promoAdviceLine(state: GameState, draft: PricingDraft): string {
  const typed = inRange(draft.promo.percentOff, 1, PROMO_MAX_PERCENT_OFF) && inRange(draft.promo.months, 1, PROMO_MAX_MONTHS);
  const offer: IntroPromo | null = typed ? { percentOff: draft.promo.percentOff, months: draft.promo.months } : null;
  const quote = quotePromo(state, offer);
  if (!quote.ok) return '';
  if (offer === null || quote.waitingUnits <= 0) return quote.advice;
  return (
    `${quote.advice} ${offer.percentOff}% off for ${plural(offer.months, 'month')}, over the next ${quote.months} months: ` +
    `${quote.extraSignups < 1 ? 'less than one more signup' : `about ${plural(quote.extraSignups, 'more signup')}`}, ` +
    `${roughMoney(quote.valueGained)} of margin against ${roughMoney(quote.discountCost)} of discounts.`
  );
}

/** The panel's name for each demand segment (balance.DEMAND_SEGMENTS). */
export const SEGMENT_LABELS: Readonly<Record<DemandSegmentId, string>> = {
  value: 'Price-sensitive households',
  mainstream: 'Mainstream households',
  speed: 'Speed seekers',
};

/** One "Who signs up" row (segmentRows). */
export interface SegmentRow {
  segment: DemandSegmentId;
  label: string;
  share: number;
  /** The segment's target take rate at the draft prices (a household's). */
  takeRate: number;
  /** The tier it mostly takes; null when no plan suits it (it does not sign up). */
  tier: TierId | null;
  /** "Price-sensitive households (35%): 54% sign up, mostly 500 Mbps", or the warning when no plan suits them. */
  text: string;
  /**
   * When no offered plan is at or under the segment's reservation price:
   * "Price-sensitive households (35%) won't sign up: no plan at or under
   * $68" (no plan suits them at all), or "... only 12% sign up: no plan at
   * or under $68" (the cheapest is a little above it); else null.
   */
  warning: string | null;
}

/**
 * "Who signs up" at the draft prices and intro promo (sales.segmentDemand
 * for households against the incumbent's usual price): per segment its
 * share, take rate and favourite tier, with a warning when the cheapest
 * offered plan (less the promo's discount share, as the model weighs it) is
 * above its reservation (sales.reservationPrice): they do not sign up, or
 * only a few do. Null while the draft's tiers are invalid. Pure.
 */
export function segmentRows(base: Pricing, draft: PricingDraft): SegmentRow[] | null {
  if (tierProblemsOf(base, draft).length > 0) return null;
  const smbOk = Number.isFinite(draft.smbMultiplier) && draft.smbMultiplier >= SMB_MULTIPLIER_MIN && draft.smbMultiplier <= SMB_MULTIPLIER_MAX;
  const pricing = pricingFrom(base, draft, smbOk);
  const promo = promoOk(draft.promo) ? draftPromo(draft) : null;
  const discount = promoDiscountShare(promo);
  let cheapest = Infinity;
  for (const tier of pricing.tiers) if (tier.offered) cheapest = Math.min(cheapest, tier.price - tier.price * discount);
  return segmentDemand(pricing, 'home', INCUMBENT_PRICE, promo).map((seg) => {
    const label = SEGMENT_LABELS[seg.segment];
    const who = `${label} (${formatPercent(seg.share)})`;
    const tierName = seg.tier === null ? null : (base.tiers.find((t) => t.id === seg.tier)?.name ?? seg.tier);
    const reservation = reservationPrice(seg.segment);
    const noPlan = `no plan at or under ${formatMoney(reservation)}`;
    const warning =
      seg.tier === null ? `${who} won't sign up: ${noPlan}` : cheapest > reservation ? `${who}: only ${formatPercent(seg.takeRate)} sign up: ${noPlan}` : null;
    return {
      segment: seg.segment,
      label,
      share: seg.share,
      takeRate: seg.takeRate,
      tier: seg.tier,
      text: warning ?? `${who}: ${formatPercent(seg.takeRate)} sign up, mostly ${tierName}`,
      warning,
    };
  });
}

/** The verb form that agrees with a count: agree(1, 'pays', 'pay') = 'pays'. */
function agree(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** What a setPricing would do to today's subscribers, for the preview (pricingImpact). */
export interface PricingImpact {
  /** sales.quotePricing of the draft; null while it is not a valid setPricing. */
  quote: PricingQuote | null;
  /** Plain-language lines: who keeps what until when, who pays less at once, retired tiers' moves. */
  lines: string[];
}

/**
 * Today's subscribers under the draft (sales.quotePricing plus per-tier
 * lines): a rise on a tier with subscribers ("312 subscribers on 1 Gig keep
 * $70/mo until Aug 1, 2028, then pay $80/mo"), a cut ("... pay $50/mo at
 * once"), a tier no longer offered ("At the month close 40 subscribers on
 * 2 Gig move to 1 Gig"). Pure.
 */
export function pricingImpact(state: GameState, draft: PricingDraft): PricingImpact {
  const quote = quotePricing(state, draft.tiers, draft.smbMultiplier, draft.grandfatherMonths);
  if (!quote.ok) return { quote: null, lines: [] };
  const units = unitsByTier(state);
  const pricing = state.sales.pricing;
  const name = (id: TierId) => pricing.tiers.find((t) => t.id === id)?.name ?? id;
  const lines: string[] = [];
  let total = 0;
  for (const id of TIER_IDS) total += units[id];
  if (total === 0) return { quote, lines: ['No subscribers yet: everyone who signs up pays the new prices.'] };
  for (const id of TIER_IDS) {
    const n = units[id];
    const setting = draft.tiers.find((t) => t.id === id);
    if (n === 0 || !setting) continue;
    const who = `${plural(n, 'subscriber')} on ${name(id)}`;
    if (!setting.offered) {
      const to = retireDestination(draft.tiers, id);
      const toPrice = draft.tiers.find((t) => t.id === to)?.price;
      if (to !== null && toPrice !== undefined) lines.push(`At the month close ${who} ${agree(n, 'moves', 'move')} to ${name(to)} (${formatMoney(toPrice)}/mo).`);
      continue;
    }
    const old = pricing.tiers.find((t) => t.id === id)?.price ?? setting.price;
    if (setting.price > old) {
      // Units already on a lock keep it (their own end); the rest get one ending at locksEndDay.
      let held = 0;
      for (const account of state.sales.accounts) if (account.tierUnits[id] > 0 && lockOn(account, id)) held += account.tierUnits[id];
      const fresh = n - held;
      if (fresh > 0 && quote.locksEndDay !== null) {
        const freshWho = `${plural(fresh, 'subscriber')} on ${name(id)}`;
        lines.push(
          draft.grandfatherMonths === 0
            ? `${freshWho} ${agree(fresh, 'pays', 'pay')} ${formatMoney(setting.price)}/mo from the next bill (${formatDate(quote.locksEndDay)}).`
            : `${freshWho} ${agree(fresh, 'keeps', 'keep')} ${formatMoney(old)}/mo until ${formatDate(quote.locksEndDay)}, ` +
                `then ${agree(fresh, 'pays', 'pay')} ${formatMoney(setting.price)}/mo.`,
        );
      }
      if (held > 0) {
        lines.push(
          `${plural(held, 'subscriber')} on ${name(id)} ${agree(held, 'keeps its', 'keep their')} current offer until it ends, ` +
            `then ${agree(held, 'pays', 'pay')} ${formatMoney(setting.price)}/mo.`,
        );
      }
    } else if (setting.price < old) {
      lines.push(`${who} ${agree(n, 'pays', 'pay')} ${formatMoney(setting.price)}/mo at once.`);
    }
  }
  if (lines.length === 0) lines.push('No change for today\'s subscribers.');
  return { quote, lines };
}

/** One incumbent promo running today, for the panel. */
export interface IncumbentRow {
  cabinet: CabinetId;
  /** The cabinet's corner ("Elm St & 3rd Ave"). */
  place: string;
  price: number;
  /** The day it ends (its price goes back to INCUMBENT_PRICE). */
  endDay: number;
  /** Your households' target take rate on streets that cabinet serves, and where the incumbent runs no promo (draft prices when valid). */
  takeThere: number;
  takeElsewhere: number;
  /** Round 4b: the retention offer that would answer it (incumbent.quoteRetention at the game's prices). */
  retention: RetentionQuote;
  /** Round 4b: already answered with a retention offer (IncumbentPromo.answered). */
  answered: boolean;
}

/** The incumbent's promos running today (incumbent.activePromos), ascending cabinet, at the draft's prices and promo when valid. */
export function incumbentRows(state: GameState, draft: PricingDraft): IncumbentRow[] {
  const running = activePromos(state);
  if (running.length === 0) return [];
  const base = state.sales.pricing;
  const tiersOk = tierProblemsOf(base, draft).length === 0;
  const smbOk = Number.isFinite(draft.smbMultiplier) && draft.smbMultiplier >= SMB_MULTIPLIER_MIN && draft.smbMultiplier <= SMB_MULTIPLIER_MAX;
  const pricing = tiersOk ? pricingFrom(base, draft, smbOk) : base;
  const promo = tiersOk ? (promoOk(draft.promo) ? draftPromo(draft) : state.sales.promo) : state.sales.promo;
  const elsewhere = targetTakeRate(pricing, 'home', INCUMBENT_PRICE, promo);
  return running.map((p) => {
    const cabinet = state.network.cabinets.find((c) => c.id === p.cabinet);
    return {
      cabinet: p.cabinet,
      place: cabinet ? cornerName(state.city, cabinet.node) : 'a removed cabinet',
      price: p.price,
      endDay: p.endDay,
      takeThere: targetTakeRate(pricing, 'home', p.price, promo),
      takeElsewhere: elsewhere,
      retention: quoteRetention(state, p.cabinet),
      answered: p.answered,
    };
  });
}

/**
 * The retention offer under an incumbent promo row: once answered, what its
 * subscribers pay until when; else the offer's figures (cost, cancellations
 * avoided, their worth, whether it pays), or why it is not possible.
 */
export function retentionLine(row: IncumbentRow): string {
  const q = row.retention;
  if (row.answered) return `Answered: its subscribers pay ${RETENTION_PERCENT_OFF}% less until ${formatDate(row.endDay)}, which spares them the promo's extra cancellations.`;
  if (!q.ok) return `No retention offer: ${q.reasons[0] ?? 'not possible there'}.`;
  return (
    `Retention offer: ${q.percentOff}% off for its ${plural(q.units, 'subscriber')} until ${formatDate(row.endDay)} costs about ${roughMoney(q.totalCost)} ` +
    `(${formatMoney(q.monthlyCost)}/mo) and keeps ${q.cancellationsAvoided < 1 ? 'less than one subscriber' : `about ${plural(q.cancellationsAvoided, 'subscriber')}`} ` +
    `who would cancel, worth ${roughMoney(q.valueSaved)}: ` +
    `${q.pays ? 'it pays' : "it doesn't pay"}.`
  );
}

/** The "Answer with a retention offer" button for a row: "Answered" once done; disabled, with the reason, when not possible. */
export function retentionButton(row: IncumbentRow): { label: string; disabled: boolean; reason: string | null } {
  if (row.answered) return { label: 'Answered', disabled: true, reason: null };
  if (!row.retention.ok) return { label: 'Answer with a retention offer', disabled: true, reason: row.retention.reasons[0] ?? 'Not possible there' };
  return { label: 'Answer with a retention offer', disabled: false, reason: null };
}

/** "Around Elm St & 3rd Ave: cable at $55/mo until Dec 1, 2027. Your target take rate there 38% (elsewhere 49%)." */
export function incumbentLine(row: IncumbentRow): string {
  return (
    `Around ${row.place}: cable at ${formatMoney(row.price)}/mo until ${formatDate(row.endDay)}. ` +
    `Your target take rate there ${formatPercent(row.takeThere)} (elsewhere ${formatPercent(row.takeElsewhere)}).`
  );
}

const KIND_NAMES: readonly [ParcelKind, string][] = [
  ['home', 'Homes'],
  ['mdu', 'Apartments'],
  ['smb', 'Businesses'],
];

interface TierInputs {
  id: TierId;
  price: HTMLInputElement;
  offered: HTMLInputElement;
  mix: HTMLElement;
  smb: HTMLElement;
}

/**
 * Round 4c/4d: where the pricing panel links to (main.ts wires it): the
 * Customers dashboard's marketing lever (spec I.5: Pricing keeps prices,
 * tiers and the promo, and links to the marketing lever there).
 */
export interface PricingLinks {
  /** Open the Customers dashboard at its marketing lever. */
  marketing?: () => void;
}

/** Open the pricing panel over the game; at most one at a time. */
export class PricingPanel {
  private sheet: Sheet | null = null;

  constructor(
    private readonly session: GameSession,
    private readonly toasts: Toasts,
    /** Round 4c/4d (contract): links out of the panel; ui-customers uses them. */
    protected readonly links: PricingLinks = {},
  ) {}

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  close(): void {
    this.sheet?.close();
  }

  /** One running incumbent promo: where, its price, your targets, and the retention offer with its button (answerIncumbent). */
  private incumbentItem(row: IncumbentRow, refresh: () => void, fail: (message: string) => void): HTMLElement {
    const state = retentionButton(row);
    const button = el('button', {
      class: 'btn retention-answer',
      text: state.label,
      attrs: { type: 'button', 'data-cabinet': String(row.cabinet), ...(state.reason ? { title: state.reason } : {}) },
    });
    button.disabled = state.disabled;
    button.addEventListener('click', () => {
      const result = this.session.dispatch({ type: 'answerIncumbent', cabinet: row.cabinet });
      if (!result.ok) {
        fail(`No retention offer sent: ${result.reason}`);
        return;
      }
      this.toasts.show(`Retention offer sent around ${row.place}: ${RETENTION_PERCENT_OFF}% off until ${formatDate(row.endDay)}`, true);
      refresh();
    });
    return el('li', { class: 'incumbent-row', attrs: { 'data-cabinet': String(row.cabinet) } }, [
      el('span', { class: 'incumbent-line', text: incumbentLine(row) }),
      el('span', { class: row.answered ? 'retention-line answered' : 'retention-line', text: retentionLine(row) }),
      button,
    ]);
  }

  open(): void {
    if (this.sheet?.isOpen) return;
    const state = this.session.state;
    const base = state.sales.pricing;
    const draft = draftFrom(base, state.sales.promo);
    const sheet = openSheet({
      title: 'Pricing',
      subtitle: incumbentOffer(),
      className: 'pricing',
      onClose: () => {
        if (this.sheet === sheet) this.sheet = null;
      },
    });
    this.sheet = sheet;

    const numberInput = (value: number, attrs: Record<string, string>) =>
      el('input', { class: 'field num', attrs: { type: 'number', inputmode: 'decimal', value: String(value), ...attrs } });

    // Tiers.
    const rows: TierInputs[] = [];
    const tbody = el('tbody');
    for (const tier of base.tiers) {
      const setting = draft.tiers.find((t) => t.id === tier.id) as TierSetting;
      const price = numberInput(setting.price, {
        min: String(TIER_PRICE_MIN),
        max: String(TIER_PRICE_MAX),
        step: '1',
        'aria-label': `${tier.name} price per month`,
        'data-tier': tier.id,
      });
      const offered = el('input', { attrs: { type: 'checkbox', 'aria-label': `Offer ${tier.name}`, 'data-tier': tier.id } });
      offered.checked = setting.offered;
      const mix = el('span', { class: 'num' });
      const smb = el('span', { class: 'tier-smb' });
      rows.push({ id: tier.id, price, offered, mix, smb });
      tbody.append(
        el('tr', {}, [
          el('th', { attrs: { scope: 'row' } }, [
            el('span', { class: 'tier-name', text: tier.name }),
            el('span', { class: 'tier-speed', text: `${formatNumber(tier.downMbps)}/${formatNumber(tier.upMbps)} Mbps` }),
          ]),
          el('td', {}, [el('label', { class: 'money-field' }, [el('span', { text: '$', attrs: { 'aria-hidden': 'true' } }), price, el('span', { class: 'per', text: '/mo' })]), smb]),
          el('td', { class: 'tier-offered' }, [offered]),
          el('td', { class: 'tier-mix' }, [mix]),
        ]),
      );
    }
    const table = el('table', { class: 'tier-table' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'Tier', attrs: { scope: 'col' } }),
          el('th', { text: 'Price', attrs: { scope: 'col' } }),
          el('th', { text: 'Offered', attrs: { scope: 'col' } }),
          el('th', { text: 'Mix', attrs: { scope: 'col', title: 'Share of new signups choosing each tier' } }),
        ]),
      ]),
      tbody,
    ]);

    const smbInput = numberInput(draft.smbMultiplier, {
      min: String(SMB_MULTIPLIER_MIN),
      max: String(SMB_MULTIPLIER_MAX),
      step: '0.05',
      'aria-label': 'Business price multiplier',
      id: 'pricing-smb',
    });
    const grandfatherInput = numberInput(draft.grandfatherMonths, {
      min: '0',
      max: String(GRANDFATHER_MONTHS_MAX),
      step: '1',
      inputmode: 'numeric',
      'aria-label': 'Grandfathering months',
      id: 'pricing-grandfather',
    });
    const grandfatherLine = el('p', { class: 'field-hint grandfather-hint' });
    const promoToggle = el('input', { attrs: { type: 'checkbox', 'aria-label': 'Intro promo for new subscribers', id: 'pricing-promo' } });
    promoToggle.checked = draft.promo.enabled;
    const promoPercent = numberInput(draft.promo.percentOff, {
      min: '1',
      max: String(PROMO_MAX_PERCENT_OFF),
      step: '1',
      inputmode: 'numeric',
      'aria-label': 'Intro promo percent off',
    });
    const promoMonths = numberInput(draft.promo.months, {
      min: '1',
      max: String(PROMO_MAX_MONTHS),
      step: '1',
      inputmode: 'numeric',
      'aria-label': 'Intro promo months',
    });
    const promoLine = el('p', { class: 'field-hint promo-hint' });
    const promoAdvice = el('p', { class: 'field-hint promo-advice', attrs: { 'aria-live': 'polite' } });
    // Marketing: read-only here; the Customers dashboard sets it, with a forecast.
    const marketingValue = el('span', { class: 'pricing-marketing-value', text: marketingLine(state.sales.marketingPerMonth), attrs: { 'data-testid': 'pricing-marketing' } });
    const marketingLink = el('button', {
      class: 'btn pricing-marketing-link',
      text: 'Change marketing',
      attrs: { type: 'button', 'aria-label': 'Change marketing on the Customers dashboard' },
    });
    marketingLink.addEventListener('click', () => {
      sheet.close();
      this.links.marketing?.();
    });
    marketingLink.hidden = this.links.marketing === undefined;
    const takeRates = new Map<ParcelKind, HTMLElement>();
    const preview = el('dl', { class: 'take-rates' });
    for (const [kind, label] of KIND_NAMES) {
      const value = el('span', { class: 'num' });
      takeRates.set(kind, value);
      preview.append(el('div', { class: 'take-rate' }, [el('dt', { text: label }), el('dd', {}, [value])]));
    }

    // Who signs up: the demand segments.
    const segmentList = el('ul', { class: 'segment-list' });
    const segments = el('section', { class: 'preview who-signs-up', attrs: { 'aria-label': 'Who signs up' } }, [el('h3', { text: 'Who signs up' }), segmentList]);

    // Today's subscribers: the quote.
    const impactLines = el('ul', { class: 'impact-lines' });
    const mrrNow = el('span', { class: 'num', attrs: { 'data-testid': 'pricing-mrr-now' } });
    const mrrAfter = el('span', { class: 'num', attrs: { 'data-testid': 'pricing-mrr-after' } });
    const cancels = el('span', { class: 'num', attrs: { 'data-testid': 'pricing-cancels' } });
    const impactNote = el('p', { class: 'impact-note' });
    const figure = (label: string, value: HTMLElement, title: string) =>
      el('div', { class: 'impact-figure', attrs: { title } }, [el('dt', { text: label }), el('dd', {}, [value])]);
    const impact = el('section', { class: 'preview pricing-impact', attrs: { 'aria-label': "Today's subscribers" } }, [
      el('h3', { text: "Today's subscribers" }),
      impactLines,
      el('dl', { class: 'impact-figures' }, [
        figure('Bills now', mrrNow, 'What today\'s subscribers pay a month right after the change, grandfathered prices held'),
        figure('After the step', mrrAfter, 'The same once the grandfathered prices end and retired tiers have moved, after the expected cancellations'),
        figure('May cancel', cancels, 'Expected cancellations when prices step up and retired tiers move'),
      ]),
      impactNote,
    ]);

    // The incumbent's running promos.
    const incumbentList = el('ul', { class: 'incumbent-list' });
    const incumbent = el('section', { class: 'preview incumbent-promos', attrs: { 'aria-label': 'Incumbent promos' } }, [
      el('h3', { text: 'Incumbent promos' }),
      incumbentList,
    ]);

    const problems = el('p', { class: 'sheet-hint' });
    const error = el('p', { class: 'sheet-error', attrs: { role: 'alert' } });
    error.hidden = true;

    sheet.body.append(
      table,
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field-label', text: 'Businesses pay', attrs: { for: 'pricing-smb' } }),
        el('span', { class: 'mult-field' }, [smbInput, el('span', { text: '× the home price', attrs: { 'aria-hidden': 'true' } })]),
      ]),
      el('div', { class: 'field-row' }, [
        el('label', { class: 'field-label', text: 'Grandfather rises', attrs: { for: 'pricing-grandfather' } }),
        el('span', { class: 'mult-field' }, [grandfatherInput, el('span', { class: 'per', text: 'months', attrs: { 'aria-hidden': 'true' } })]),
      ]),
      grandfatherLine,
      el('div', { class: 'field-row promo-row' }, [
        el('label', { class: 'field-label promo-toggle', attrs: { for: 'pricing-promo' } }, [promoToggle, el('span', { text: 'Intro promo' })]),
        el('span', { class: 'promo-fields' }, [
          promoPercent,
          el('span', { class: 'per', text: '% off for', attrs: { 'aria-hidden': 'true' } }),
          promoMonths,
          el('span', { class: 'per', text: 'mo', attrs: { 'aria-hidden': 'true' } }),
        ]),
      ]),
      promoLine,
      promoAdvice,
      el('div', { class: 'field-row pricing-marketing-row' }, [
        el('span', { class: 'field-label', text: 'Marketing' }),
        el('span', { class: 'pricing-marketing-now' }, [marketingValue, marketingLink]),
      ]),
      el('p', { class: 'field-hint pricing-marketing-hint', text: 'Set it on the Customers dashboard, with what it would bring.' }),
      el('section', { class: 'preview', attrs: { 'aria-label': 'Target take rate' } }, [el('h3', { text: 'Target take rate' }), preview]),
      segments,
      impact,
      incumbent,
      problems,
      error,
    );

    const read = (): PricingDraft => ({
      tiers: rows.map((r) => ({ id: r.id, price: parseNumberField(r.price.value), offered: r.offered.checked })),
      smbMultiplier: parseNumberField(smbInput.value),
      grandfatherMonths: parseNumberField(grandfatherInput.value),
      promo: { enabled: promoToggle.checked, percentOff: parseNumberField(promoPercent.value), months: parseNumberField(promoMonths.value) },
    });
    const refresh = () => {
      const now = read();
      const game = this.session.state;
      const p = pricingPreview(base, now);
      for (const row of rows) {
        const setting = now.tiers.find((t) => t.id === row.id) as TierSetting;
        row.price.setAttribute('aria-invalid', String(!inRange(setting.price, TIER_PRICE_MIN, TIER_PRICE_MAX)));
        setText(row.mix, p.mix && row.offered.checked ? formatPercent(p.mix[row.id]) : '–');
        setText(row.smb, p.smbPrices ? `Business ${formatMoney(p.smbPrices[row.id])}/mo` : '');
      }
      smbInput.setAttribute('aria-invalid', String(!Number.isFinite(now.smbMultiplier) || now.smbMultiplier < SMB_MULTIPLIER_MIN || now.smbMultiplier > SMB_MULTIPLIER_MAX));
      grandfatherInput.setAttribute('aria-invalid', String(!grandfatherOk(now.grandfatherMonths)));
      promoPercent.disabled = !now.promo.enabled;
      promoMonths.disabled = !now.promo.enabled;
      promoPercent.setAttribute('aria-invalid', String(now.promo.enabled && !inRange(now.promo.percentOff, 1, PROMO_MAX_PERCENT_OFF)));
      promoMonths.setAttribute('aria-invalid', String(now.promo.enabled && !inRange(now.promo.months, 1, PROMO_MAX_MONTHS)));
      for (const [kind, value] of takeRates) setText(value, p.takeRate ? formatPercent(p.takeRate[kind]) : '–');
      setText(grandfatherLine, grandfatherHint(now.grandfatherMonths));
      setText(promoLine, promoHint(base, now, p));
      setText(promoAdvice, promoAdviceLine(game, now));
      promoAdvice.hidden = promoAdvice.textContent === '';
      const who = segmentRows(base, now);
      segments.hidden = who === null;
      segmentList.replaceChildren(
        ...(who ?? []).map((row) =>
          el('li', { class: row.warning ? 'segment-row segment-out' : 'segment-row', text: row.text, attrs: { 'data-segment': row.segment } }),
        ),
      );

      const effect = pricingImpact(game, now);
      impactLines.replaceChildren(...effect.lines.map((line) => el('li', { text: line })));
      const figures = impactFigures(effect.quote);
      setText(mrrNow, figures.now);
      setText(mrrAfter, figures.after);
      setText(cancels, figures.cancels);
      setText(impactNote, figures.note);
      impactNote.hidden = figures.note === '';
      setText(marketingValue, marketingLine(game.sales.marketingPerMonth));

      const rivals = incumbentRows(game, now);
      incumbent.hidden = rivals.length === 0;
      // fail is declared below; the closure reads it only on a click.
      incumbentList.replaceChildren(...rivals.map((row) => this.incumbentItem(row, refresh, (message) => fail(message))));

      setText(problems, p.problems.join('. '));
      problems.hidden = p.problems.length === 0;
    };
    const edited = () => {
      error.hidden = true;
      refresh();
    };
    sheet.body.addEventListener('input', edited);
    sheet.body.addEventListener('change', edited);
    refresh();

    const apply = el('button', { class: 'btn sheet-primary', text: 'Apply', attrs: { type: 'button' } });
    const cancel = el('button', { class: 'btn sheet-secondary', text: 'Cancel', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => sheet.close());
    const fail = (message: string) => {
      setText(error, message);
      error.hidden = false;
      this.toasts.show(message, false);
    };
    apply.addEventListener('click', () => {
      const now = read();
      const priced = this.session.dispatch({
        type: 'setPricing',
        tiers: now.tiers,
        smbMultiplier: now.smbMultiplier,
        grandfatherMonths: now.grandfatherMonths,
      });
      if (!priced.ok) {
        fail(`Pricing not changed: ${priced.reason}`);
        return;
      }
      const promo = draftPromo(now);
      const promoChanged = !samePromo(promo, this.session.state.sales.promo);
      if (promoChanged) {
        const promoted = this.session.dispatch({ type: 'setPromo', promo });
        if (!promoted.ok) {
          fail(`Prices updated, but the intro promo was not: ${promoted.reason}`);
          return;
        }
      }
      sheet.close();
      const promoNote = !promoChanged ? '' : promo ? `; intro promo ${promo.percentOff}% off for ${plural(promo.months, 'month')}` : '; intro promo off';
      this.toasts.show(`Pricing updated${promoNote}`, true);
    });
    // Enter in a field applies, as in a form.
    sheet.body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement && e.target.type === 'number') {
        e.preventDefault();
        apply.click();
      }
    });
    sheet.actions.append(cancel, apply);
    rows[0]?.price.focus();
  }
}
