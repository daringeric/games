// Customers (round 4c/4d, owner feedback and decisions 2026-10-22): realistic
// switching that responds to the deal, awareness and why homes have not
// switched, happiness, and three growth levers (neighborhood campaigns,
// support level, referral credits) beside the marketing budget, each with a
// pure forecast the Customers dashboard and the advisor read.
//
// Owner: sim-customers workstream. The contract wrote the saved state
// (GameState.customers, newCustomers), the three commands with their
// validation and bookkeeping (setSupport, setReferrals, runCampaign: cost,
// record, 'marketing' entry), the campaign strength curve and customerAreas;
// sim-customers wrote the rules below and applies them in sales.ts (signups
// in stepSales, churn and price-step memory in closeSalesMonth, the intro
// promo's quote) and incumbent.ts (the retention offer's worth).
//
// The model (balance.ts "Round 4c/4d"; every figure symbolic in tests):
//
// 1. Switching responds to the deal. On each lit street the target ceiling
//    stays sales.targetTakeRate's (demand segments, kind factors, the
//    incumbent's local price, the intro promo valued; ~45-55% of homes at
//    default prices). What the deal changes is the SPEED: each day the
//    street's households inside its gap (target less subscribed) switch at
//      gap x awareness x SWITCH_BASE_PER_DAY x dealFactor
//        x womSwitchFactor (1 + SWITCH_WOM_BOOST x the street's happy share,
//          x REFERRAL_WOM_MULTIPLIER while referral credits are on)
//        x campaignSwitchFactor (1 + CAMPAIGN_SWITCH_BOOST x the area's
//          campaign strength, on the streets lit when it was bought:
//          campaignStrengthOn)
//        x the intro promo's boost (sales.promoSignupFactor) on a young
//          street (lit within PROMO_BOOST_YOUNG_MONTHS) or where the
//          incumbent runs a promo (a contested area), else 1
//    (stepSales keeps one rng draw per street for the fraction). dealFactor
//    = clamp(1 + SWITCH_PER_ADVANTAGE x (dealAdvantage - the default
//    lineup's dealAdvantage against cable's standard price),
//    SWITCH_DEAL_MIN, SWITCH_DEAL_MAX) per building kind, where
//    dealAdvantage is the take-weighted mean over demand segments of each
//    segment's best advantage over cable (sales.segmentDeals) at the
//    street's serving cabinet's incumbent price (incumbent.incumbentPriceFor,
//    so a cable promo slows switching there) with the intro promo valued
//    (its discount share over PROMO_HORIZON_MONTHS: longer and deeper offers
//    switch more, with diminishing returns through the clamp). A street's
//    dealFactor is its kinds' factors weighted by their target units. A
//    price cut speeds switching from the next day; a lineup ~15-20% below the
//    defaults reaches the ceiling sooner, an overpriced one grows clearly
//    slower. The round-4b ramp (a fixed share of the gap a day x (1 +
//    marketing boost)) is retired: marketing works through awareness (the
//    ramp's constants and sales.marketingBoost are gone).
// 2. Awareness (CustomersState.streets, ppm). stepCustomers adds a street the
//    day it is lit at AWARENESS_ON_LIT (a street that already has customers
//    starts where time alone would have taken it since its first customer)
//    and drops it the day it is not lit. A save from before round 4c/4d has
//    its lit streets seeded as it loads (seedStreets: from the day its plant
//    lit each one, network.litSinceDays, or its first customer's if earlier). Each later day a += (1 - a) x g, g = AWARENESS_BASE_PER_DAY +
//    marketingAwarenessPerDay (AWARENESS_MARKETING_*: diminishing in dollars
//    per passing) + CAMPAIGN_AWARENESS_PER_DAY x the area's campaign strength
//    (streets lit when it was bought only) + AWARENESS_WOM_PER_DAY x the
//    street's happy share (x
//    REFERRAL_WOM_MULTIPLIER with credits on). Integer ppm, rounded once per
//    day, never above AWARENESS_PPM.
// 3. Why homes haven't switched (whyNotSwitched): per lit street, its
//    unsigned units split into exactly one reason each: tooExpensive (the
//    households of each demand segment that no offered tier suits, by
//    sales' reservation suit: share x (1 - best suit), within the households
//    beyond the ceiling), notWorth (the rest beyond the ceiling: at today's
//    prices the deal is not worth switching for), unaware (gap x (1 -
//    awareness)), deciding (the aware part of the gap: inside the ceiling,
//    so they switch at today's prices, at awareness x SWITCH_BASE_PER_DAY x
//    the deal and word of mouth; they just haven't yet), waiting (that aware
//    part instead while its cabinet is full, installs are paused or an
//    outage cuts the street off from its cabinet). A campaign moves homes
//    from unaware to deciding, never to notWorth. Whole units, largest-remainder rounding per street so a
//    street's reasons sum exactly to its unsigned units; areas and the total
//    are sums of streets. notLit counts cabled streets not lit.
// 4. Happiness (accountHappiness): a score summed from factors (balance
//    HAPPINESS_*): support level; outage days in the last
//    HAPPINESS_OUTAGE_MEMORY_DAYS (memories); paid vs the market price for
//    the tier (over: priceVsMarket, under: goodDeal, both at the
//    household-equivalent price for a business); paid vs cable's local price
//    for that kind of plan beyond what the market comparison already counts
//    and the premium customers accept for fiber (priceVsCable: nothing
//    unless the incumbent runs a promo there); a price
//    step-up in the last HAPPINESS_PRICE_STEP_MEMORY_DAYS; an install wait in
//    the last HAPPINESS_WAIT_MEMORY_DAYS. Buckets by HAPPY_SCORE_MIN /
//    UNHAPPY_SCORE_MAX. A unit's regular churn is churnFromScore(score) =
//    CHURN_MONTHLY_BASE x clamp(1 - score, HAPPY_CHURN_FLOOR,
//    CHURN_MONTHLY_MAX / CHURN_MONTHLY_BASE) (the priceVsMarket term
//    replaces round 4's CHURN_PRICE_SENSITIVITY: at today's weights it is the same
//    churn). The incumbent is folded into priceVsCable at the local price
//    (ChurnParts.incumbent then carries only the share of the regular churn
//    that factor adds, for attribution), weighted
//    (HAPPINESS_PER_PRICE_OVER_CABLE) so a customer at the
//    default price where cable runs its promo cancels INCUMBENT_PROMO_CHURN
//    a month more than elsewhere (round 4b's cost of an ignored promo); a
//    retention offer lowers what they pay and so answers it (the default
//    offer in full: HAPPINESS_CABLE_PREMIUM_TOLERATED). The acute parts
//    stay as they were and are not double counted: a lock ending (the price
//    part, at its own close) and the month's own outage days (the outage
//    part). Memories are written AFTER a close's churn draws (sales.
//    closeSalesMonth notes price steps after its step 6, closeCustomersMonth
//    the outage days), so an event charges its acute part at its own close
//    and the happiness factor only in the months after. One draw per unit.
//    Happy customers bring neighbors: word of mouth (awareness and speed
//    above) uses each street's happy share.
// 5. Levers: marketing (exists: setMarketing), campaigns (runCampaign),
//    support (setSupport: its cost is in overhead's per-customer line,
//    overhead.ts reads the level), referral credits (setReferrals: a
//    signup's referral share is the part of its street's switching that
//    word of mouth brought while credits are on, (wom - 1) / wom, accrued as
//    round(share x 1000) in month.referralMilli; the close posts
//    round(referralMilli / 1000) x 2 x REFERRAL_CREDIT as 'marketing',
//    "Referral credits for Mar 2027: 9 referrals").
// 6. Quotes (quoteMarketing, quoteCampaign, quoteSupport, quoteReferrals,
//    and sales.quotePromo): pure, no rng, playing the model forward over
//    CUSTOMER_QUOTE_MONTHS from today's state (forecastCustomers: awareness,
//    switching, word of mouth, churn by happiness, free ports, a week at a
//    time compounding the daily rules)
//    against the alternative named in each type. Margins use
//    overhead.perCustomerCost.
//
// Rules: pure sim (no DOM, Date, Math.random); arithmetic and Math.sqrt
// only; deterministic iteration (segments, parcels, cabinets ascending);
// whole dollars at posting; saved numbers are integers.

import {
  AWARENESS_BASE_PER_DAY,
  AWARENESS_MARKETING_HALF_SAT_PER_PASSING,
  AWARENESS_MARKETING_MAX_PER_DAY,
  AWARENESS_ON_LIT,
  AWARENESS_WOM_PER_DAY,
  CAMPAIGN_AWARENESS_PER_DAY,
  CAMPAIGN_COOLDOWN_DAYS,
  CAMPAIGN_COST_MIN,
  CAMPAIGN_COST_PER_UNIT,
  CAMPAIGN_DAYS,
  CAMPAIGN_FADE_DAYS,
  CAMPAIGN_SWITCH_BOOST,
  CHURN_MONTHLY_BASE,
  CHURN_MONTHLY_MAX,
  CUSTOMER_QUOTE_MONTHS,
  DEFAULT_SUPPORT_LEVEL,
  HAPPINESS_CABLE_PREMIUM_TOLERATED,
  HAPPINESS_GOOD_DEAL_MAX,
  HAPPINESS_INSTALL_WAIT,
  HAPPINESS_MARKET_PREMIUM_TOLERATED,
  HAPPINESS_OUTAGE_MEMORY_DAYS,
  HAPPINESS_PER_OUTAGE_DAY,
  HAPPINESS_PER_PRICE_OVER_CABLE,
  HAPPINESS_PER_PRICE_OVER_MARKET,
  HAPPINESS_PER_PRICE_UNDER_MARKET,
  HAPPINESS_PRICE_STEP,
  HAPPINESS_PRICE_STEP_MEMORY_DAYS,
  HAPPINESS_WAIT_MEMORY_DAYS,
  HAPPY_CHURN_FLOOR,
  HAPPY_SCORE_MIN,
  INCUMBENT_PRICE,
  MARKETING_MAX_PER_MONTH,
  MAX_SPLITTERS_PER_CABINET,
  MDU_PORTS_PER_BUILDING,
  OLT_CARD_COST,
  OLT_PORTS_PER_CARD,
  PROMO_BOOST_YOUNG_MONTHS,
  PROMO_STEP_SHARE,
  REFERRAL_CREDIT,
  REFERRAL_WOM_MULTIPLIER,
  SMB_MULTIPLIER_DEFAULT,
  SPLIT_RATIO,
  SPLITTER_COST,
  SUPPORT_LEVELS,
  SUPPORT_QUOTE_MONTHS,
  SWITCH_BASE_PER_DAY,
  SWITCH_DEAL_MAX,
  SWITCH_DEAL_MIN,
  SWITCH_PER_ADVANTAGE,
  SWITCH_WOM_BOOST,
  TIER_DEFAULTS,
  UNHAPPY_SCORE_MAX,
} from './balance';
import { DAYS_PER_YEAR, dateOf, formatMonth } from './calendar';
import { formatMoney, groupThousands, postEntry, postEntryOn } from './finance';
import { getService, litSinceDays, ponPortsUsed } from './network';
import { perCustomerCost } from './overhead';
import {
  accountUnitPrice,
  accountUnits,
  cabinetPortCapacity,
  cabinetPortsUsed,
  defaultPricing,
  installCost,
  promoPrice,
  promoSignupFactor,
  segmentDeals,
  segmentOffset,
  stepChurnProbability,
  subscriberUnits,
  targetTakeRate,
  tierMix,
} from './sales';
import { cornerName, otherEnd, segmentsAtNode } from './streets';
import { outageChurnProbability, stormRisk } from './weather';
import type {
  Account,
  AccountHappiness,
  CableSpan,
  AreaSnapshot,
  CabinetId,
  CampaignQuote,
  CommandResult,
  CustomerArea,
  CustomerMemory,
  CustomerStats,
  CustomersMonth,
  CustomersState,
  GameState,
  HappinessBucket,
  HappinessFactor,
  HappinessReport,
  HappinessReasonCount,
  IntroPromo,
  MarketingQuote,
  NeighborhoodCampaign,
  NodeId,
  ParcelId,
  ParcelKind,
  Pricing,
  ReferralQuote,
  SegmentId,
  ServiceSnapshot,
  StreetAwareness,
  StreetSegment,
  SupportLevel,
  SupportQuote,
  SwitchReasonCounts,
  SwitchReasons,
  TierId,
} from './types';

/** Awareness is saved in parts per million: 0 (nobody knows you) .. AWARENESS_PPM (everybody). */
export const AWARENESS_PPM = 1_000_000;
/** The dashboard's trend compares an area with the close this many closes before the latest (MonthlyReport.customers.areas). */
export const AREA_TREND_MONTHS = 3;
/** Most top reasons happinessReport lists. */
export const HAPPINESS_REASONS_MAX = 4;
/** The dashboard's "what one step would do" for the marketing budget (quoteMarketing at perMonth +/- this). A UI step, not balance. */
export const MARKETING_STEP = 500;
/** Every SupportLevel, cheapest first (the dashboard's choice order). */
export const SUPPORT_LEVEL_IDS: readonly SupportLevel[] = ['basic', 'good', 'great'];

/** Days in an average month: the quotes' day <-> month conversions. */
const DAYS_PER_MONTH = DAYS_PER_YEAR / 12;

/** A street lit within this many days is young: the intro promo's boost applies there (PROMO_BOOST_YOUNG_MONTHS). */
export const PROMO_BOOST_YOUNG_DAYS = Math.round(PROMO_BOOST_YOUNG_MONTHS * DAYS_PER_MONTH);

/**
 * A unit that connects within this many days of its cabinet last turning
 * signups away (CustomersState.waits) or of installs last being paused for
 * cash (pausedDay) waited to be connected (CustomerMemory.waitedDay); a wait
 * record older than this is dropped. A rule length (FULL_HOLD_DAYS-like),
 * not balance.
 */
export const INSTALL_WAIT_WINDOW_DAYS = 30;

const DEFAULT_PRICE: Readonly<Record<TierId, number>> = Object.fromEntries(TIER_DEFAULTS.map((t) => [t.id, t.price])) as Record<TierId, number>;
const KINDS: readonly ParcelKind[] = ['home', 'mdu', 'smb'];

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** x^n for a whole n >= 0, by squaring (arithmetic only). */
function powInt(x: number, n: number): number {
  let result = 1;
  let base = x;
  let k = Math.max(0, Math.floor(n));
  while (k > 0) {
    if (k % 2 === 1) result *= base;
    base *= base;
    k = Math.floor(k / 2);
  }
  return result;
}

/** The open month's customer figures of a new month. */
export function emptyCustomersMonth(): CustomersMonth {
  return { referralMilli: 0, campaignSpend: 0 };
}

/**
 * The customers state of a new game (and of every save from before round
 * 4c/4d): DEFAULT_SUPPORT_LEVEL, referral credits off, no streets known
 * yet (the first daily step adds the lit ones), no campaigns, memories or
 * waits, installs never paused, an empty month.
 */
export function newCustomers(): CustomersState {
  return {
    supportLevel: DEFAULT_SUPPORT_LEVEL,
    referrals: false,
    streets: [],
    campaigns: [],
    memories: [],
    waits: [],
    pausedDay: null,
    month: emptyCustomersMonth(),
  };
}

export function isSupportLevel(value: unknown): value is SupportLevel {
  return typeof value === 'string' && (SUPPORT_LEVEL_IDS as readonly string[]).includes(value);
}

function reject(reason: string): CommandResult {
  return { ok: false, reason };
}

function describeValue(value: unknown): string {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function plural(n: number, one: string, many: string): string {
  return `${groupThousands(n)} ${n === 1 ? one : many}`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * setSupport command: `level` one of SUPPORT_LEVEL_IDS (else rejected,
 * state untouched). Sets customers.supportLevel; free ({ ok: true, cost: 0 }).
 * The level's cost per customer accrues from the next daily step
 * (overhead's per-customer line) and its happiness from then on.
 */
export function setSupport(state: GameState, level: SupportLevel): CommandResult {
  if (!isSupportLevel(level)) {
    return reject(`The support level must be one of ${SUPPORT_LEVEL_IDS.map((l) => SUPPORT_LEVELS[l].name).join(', ')}, got ${describeValue(level)}`);
  }
  state.customers.supportLevel = level;
  return { ok: true, cost: 0 };
}

/** setReferrals command: `on` must be a boolean (else rejected). Sets customers.referrals; free. Credits are charged per referral signup at the close. */
export function setReferrals(state: GameState, on: boolean): CommandResult {
  if (typeof on !== 'boolean') return reject(`Referral credits are on or off (true or false), got ${describeValue(on)}`);
  state.customers.referrals = on;
  return { ok: true, cost: 0 };
}

/** A campaign's price for an area with `unsignedUnits` lit units not signed up: max(CAMPAIGN_COST_MIN, round(units x CAMPAIGN_COST_PER_UNIT)). */
export function campaignCost(unsignedUnits: number): number {
  return Math.max(CAMPAIGN_COST_MIN, Math.round(Math.max(0, unsignedUnits) * CAMPAIGN_COST_PER_UNIT));
}

/** The campaign record of a cabinet's area (running, fading or cooling down), or null. */
export function campaignFor(state: GameState, cabinet: CabinetId): NeighborhoodCampaign | null {
  return state.customers.campaigns.find((c) => c.cabinet === cabinet) ?? null;
}

/**
 * How strong a campaign is on `day`, 0..1: 0 before startDay and from
 * endDay on; 1 for CAMPAIGN_DAYS from startDay; then falling linearly to 0
 * at endDay (over CAMPAIGN_FADE_DAYS at purchase).
 */
export function campaignStrength(campaign: Pick<NeighborhoodCampaign, 'startDay' | 'endDay'>, day: number): number {
  if (day < campaign.startDay || day >= campaign.endDay) return 0;
  const full = campaign.startDay + CAMPAIGN_DAYS;
  if (day < full) return 1;
  const fade = campaign.endDay - full;
  return fade > 0 ? (campaign.endDay - day) / fade : 0;
}

/** Lit units not signed up on the streets a cabinet serves today (the campaign's size). */
export function unsignedUnitsIn(state: GameState, cabinet: CabinetId): number {
  const area = reasonsIn(state, cabinet).areas.find((a) => a.cabinet === cabinet);
  return area ? area.unsigned : 0;
}

/**
 * runCampaign command (see CampaignQuote): rejected (state untouched) when
 * quoteCampaign(state, cabinet) is not ok (game over, not a cabinet, not
 * live and active, nothing lit there, a campaign running or the area
 * cooling down, cash short). Otherwise posts 'marketing' -cost ("Neighborhood
 * campaign at Elm St & 3rd Ave"), adds cost to month.campaignSpend, and
 * records { cabinet, startDay: day, endDay: day + CAMPAIGN_DAYS +
 * CAMPAIGN_FADE_DAYS, cooldownUntil: endDay + CAMPAIGN_COOLDOWN_DAYS, cost,
 * units } in place of the area's old record (ascending cabinet). Returns
 * { ok: true, cost }. The awareness burst and the switching boost start
 * with the next daily step (stepCustomers, stepSales), on the streets lit
 * today (what it is priced on: campaignStrengthOn), not on those its
 * cabinet lights later in its run.
 */
export function runCampaign(state: GameState, cabinet: CabinetId): CommandResult {
  const quote = quoteCampaign(state, cabinet);
  if (!quote.ok) return reject(quote.reasons[0] ?? 'No campaign can run there now');
  const node = state.network.cabinets.find((c) => c.id === cabinet)?.node;
  const place = node === undefined ? 'a cabinet' : cornerName(state.city, node);
  postEntry(state, 'marketing', -quote.cost, `Neighborhood campaign at ${place}`);
  state.customers.month.campaignSpend += quote.cost;
  // The streets it is priced on are the ones lit now: each gets its entry (lit today if it had none) so the boost knows them.
  trackLitStreets(state);
  const record = campaignRecord(cabinet, state.day, quote.cost, quote.unsignedUnits);
  state.customers.campaigns = [...state.customers.campaigns.filter((c) => c.cabinet !== cabinet), record].sort((a, b) => a.cabinet - b.cabinet);
  return { ok: true, cost: quote.cost };
}

function campaignRecord(cabinet: CabinetId, day: number, cost: number, units: number): NeighborhoodCampaign {
  const endDay = day + CAMPAIGN_DAYS + CAMPAIGN_FADE_DAYS;
  return { cabinet, startDay: day, endDay, cooldownUntil: endDay + CAMPAIGN_COOLDOWN_DAYS, cost, units };
}

/** A cabinet's running campaign on a day: its strength and the day it was bought. */
interface CampaignOn {
  strength: number;
  startDay: number;
}

/** Each cabinet's campaign strength on `day` and its purchase day (cabinets with a record only). */
function campaignStrengths(campaigns: readonly NeighborhoodCampaign[], day: number): Map<CabinetId, CampaignOn> {
  const out = new Map<CabinetId, CampaignOn>();
  for (const c of campaigns) {
    const s = campaignStrength(c, day);
    if (s > 0) out.set(c.cabinet, { strength: s, startDay: c.startDay });
  }
  return out;
}

/**
 * The campaign strength a street lit since `litDay` gets from its area's
 * running campaign (`on`, or none): the campaign's strength when the street
 * was lit when it was bought (litDay <= startDay), else 0. Round 4c/4d fix: a
 * campaign is priced on the homes lit when it is bought (quoteCampaign,
 * unsignedUnitsIn), so streets its cabinet lights later in its run are not
 * part of it.
 */
export function campaignStrengthOn(on: CampaignOn | undefined, litDay: number): number {
  return on !== undefined && litDay <= on.startDay ? on.strength : 0;
}

// ---------------------------------------------------------------------------
// Switching and awareness (model 1 and 2): pure helpers stepSales and the
// forecasts share
// ---------------------------------------------------------------------------

/**
 * The deal a lineup offers a building kind over cable at `incumbentPrice`
 * with the intro promo valued: the mean over demand segments of each
 * segment's best advantage over the incumbent among the tiers that suit it
 * (sales.segmentDeals), weighted by share x take; null when no segment signs
 * up (nothing suits anyone). Pure.
 */
export function dealAdvantage(pricing: Pricing, kind: ParcelKind, incumbentPrice: number = INCUMBENT_PRICE, promo: IntroPromo | null = null): number | null {
  let weight = 0;
  let sum = 0;
  for (const deal of segmentDeals(pricing, kind, incumbentPrice, promo)) {
    if (deal.advantage === null || !(deal.take > 0)) continue;
    const w = deal.share * deal.take;
    weight += w;
    sum += w * deal.advantage;
  }
  return weight > 0 ? sum / weight : null;
}

const defaultDeals = new Map<ParcelKind, number>();

/** The default lineup's dealAdvantage for a kind against cable's standard price, no promo (the reference dealFactor 1 means). */
export function defaultDealAdvantage(kind: ParcelKind): number {
  let value = defaultDeals.get(kind);
  if (value === undefined) {
    value = dealAdvantage(defaultPricing(), kind, INCUMBENT_PRICE, null) ?? 0;
    defaultDeals.set(kind, value);
  }
  return value;
}

/**
 * How much faster (or slower) a kind's households switch for this deal than
 * for the default lineup against cable's standard price: clamp(1 +
 * SWITCH_PER_ADVANTAGE x (dealAdvantage - defaultDealAdvantage),
 * SWITCH_DEAL_MIN, SWITCH_DEAL_MAX); SWITCH_DEAL_MIN when nothing suits
 * anyone. 1 at the default prices where cable runs no promo. Pure.
 */
export function dealFactor(pricing: Pricing, kind: ParcelKind, incumbentPrice: number = INCUMBENT_PRICE, promo: IntroPromo | null = null): number {
  const advantage = dealAdvantage(pricing, kind, incumbentPrice, promo);
  if (advantage === null) return SWITCH_DEAL_MIN;
  return clamp(1 + SWITCH_PER_ADVANTAGE * (advantage - defaultDealAdvantage(kind)), SWITCH_DEAL_MIN, SWITCH_DEAL_MAX);
}

/** dealFactor for every building kind. */
export function dealFactors(pricing: Pricing, incumbentPrice: number = INCUMBENT_PRICE, promo: IntroPromo | null = null): Record<ParcelKind, number> {
  return { home: dealFactor(pricing, 'home', incumbentPrice, promo), mdu: dealFactor(pricing, 'mdu', incumbentPrice, promo), smb: dealFactor(pricing, 'smb', incumbentPrice, promo) };
}

/** How much stronger word of mouth is: REFERRAL_WOM_MULTIPLIER with referral credits on, else 1. */
export function womMultiplier(referrals: boolean): number {
  return referrals ? REFERRAL_WOM_MULTIPLIER : 1;
}

/** Word of mouth's speed-up of switching on a street whose customers are `happyShare` happy: 1 + SWITCH_WOM_BOOST x happyShare x womMultiplier. */
export function womSwitchFactor(happyShare: number, referrals: boolean): number {
  return 1 + SWITCH_WOM_BOOST * clamp(happyShare, 0, 1) * womMultiplier(referrals);
}

/** A signup's referral share: the part of its street's switching word of mouth brought, (wom - 1) / wom, while credits are on; 0 off. */
export function referralShareOf(happyShare: number, referrals: boolean): number {
  if (!referrals) return 0;
  const wom = womSwitchFactor(happyShare, true);
  return wom > 0 ? (wom - 1) / wom : 0;
}

/** A campaign's speed-up of switching in its area: 1 + CAMPAIGN_SWITCH_BOOST x strength. */
export function campaignSwitchFactor(strength: number): number {
  return 1 + CAMPAIGN_SWITCH_BOOST * clamp(strength, 0, 1);
}

/** A street lit since `litDay` is young on `day` (the intro promo's boost applies): lit fewer than PROMO_BOOST_YOUNG_DAYS days. */
export function isYoungStreet(litDay: number, day: number): boolean {
  return day - litDay < PROMO_BOOST_YOUNG_DAYS;
}

/** The intro promo's switching boost on a street: sales.promoSignupFactor(promo) when it is young or contested (cable runs a promo there), else 1. */
export function promoBoost(promo: IntroPromo | null, young: boolean, contested: boolean): number {
  return young || contested ? promoSignupFactor(promo) : 1;
}

/**
 * Round 4c/4d fix (spec C): whether the intro promo is valued on a street:
 * a promo is set and the street is young or contested (where its boost
 * applies). There it lifts the target, the signup mix and the deal factor
 * (its discount share, sales.promoDiscountShare); elsewhere it only
 * discounts its signups.
 */
export function promoApplies(promo: IntroPromo | null, young: boolean, contested: boolean): boolean {
  return promo !== null && (young || contested);
}

/** Share of a street's gap that switches in a day: awareness x SWITCH_BASE_PER_DAY x the factors (at most 1). */
export function switchRate(awareness: number, deal: number, wom: number, campaign: number, boost: number): number {
  return Math.min(1, Math.max(0, awareness * SWITCH_BASE_PER_DAY * deal * wom * campaign * boost));
}

/**
 * Marketing's daily awareness gain on every lit street, with diminishing
 * returns: AWARENESS_MARKETING_MAX_PER_DAY x m / (m +
 * AWARENESS_MARKETING_HALF_SAT_PER_PASSING x max(1, passings)); 0 for $0.
 */
export function marketingAwarenessPerDay(perMonth: number, passings: number): number {
  const m = perMonth;
  const saturation = m + AWARENESS_MARKETING_HALF_SAT_PER_PASSING * Math.max(1, passings);
  return m > 0 && saturation > 0 ? (AWARENESS_MARKETING_MAX_PER_DAY * m) / saturation : 0;
}

/** A street's daily awareness gain g (a += (1 - a) x g): base + marketing + campaign + word of mouth (model 2). */
export function awarenessGainPerDay(marketing: number, campaign: number, happyShare: number, referrals: boolean): number {
  return AWARENESS_BASE_PER_DAY + marketing + CAMPAIGN_AWARENESS_PER_DAY * clamp(campaign, 0, 1) + AWARENESS_WOM_PER_DAY * clamp(happyShare, 0, 1) * womMultiplier(referrals);
}

/** One day of awareness growth in ppm: ppm + round((AWARENESS_PPM - ppm) x min(1, gain)), at most AWARENESS_PPM. */
export function nextAwareness(ppm: number, gain: number): number {
  const g = clamp(gain, 0, 1);
  return Math.min(AWARENESS_PPM, Math.max(0, ppm + Math.round((AWARENESS_PPM - ppm) * g)));
}

function streetIndex(streets: readonly StreetAwareness[], segment: SegmentId): StreetAwareness | undefined {
  let lo = 0;
  let hi = streets.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = streets[mid] as StreetAwareness;
    if (entry.segment === segment) return entry;
    if (entry.segment < segment) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** A street's awareness as a share 0..1: its CustomersState.streets entry, or AWARENESS_ON_LIT (where a street starts) without one. */
export function awarenessOf(state: GameState, segment: SegmentId): number {
  const entry = streetIndex(state.customers.streets, segment);
  return entry ? entry.awareness / AWARENESS_PPM : AWARENESS_ON_LIT;
}

/** What stepSales needs per lit street beyond the deal (switchingDay). */
export interface StreetSwitching {
  /** Share of the gap switching today before the deal factor: awareness x SWITCH_BASE_PER_DAY x word of mouth x campaign x the promo's boost. */
  rate: number;
  /** A signup's referral share there (referralShareOf). */
  referral: number;
  /** Round 4c/4d fix: the intro promo is valued there (promoApplies: set, and the street young or contested). */
  promoApplies: boolean;
}

/**
 * The switching rule for one day (stepSales): per lit street (its serving
 * cabinet and whether cable runs a promo there), the rate before the deal
 * factor and the referral share. Reads awareness, happiness, campaigns and
 * the intro promo as they stand. Pure.
 */
export function switchingDay(state: GameState): (segment: SegmentId, cabinet: CabinetId, contested: boolean) => StreetSwitching {
  const { customers, day } = state;
  const happy = streetHappiness(state);
  const strengths = campaignStrengths(customers.campaigns, day);
  const promo = state.sales.promo;
  const referrals = customers.referrals;
  return (segment, cabinet, contested) => {
    const entry = streetIndex(customers.streets, segment);
    const awareness = entry ? entry.awareness / AWARENESS_PPM : AWARENESS_ON_LIT;
    const young = entry ? isYoungStreet(entry.litDay, day) : true;
    const h = happy.get(segment);
    const share = h && h.units > 0 ? h.happy / h.units : 0;
    const strength = campaignStrengthOn(strengths.get(cabinet), entry ? entry.litDay : day);
    const wom = womSwitchFactor(share, referrals);
    return {
      rate: switchRate(awareness, 1, wom, campaignSwitchFactor(strength), promoBoost(promo, young, contested)),
      referral: referralShareOf(share, referrals),
      promoApplies: promoApplies(promo, young, contested),
    };
  };
}

/**
 * Whether a unit connecting on `cabinet` today waited (INSTALL_WAIT_WINDOW_DAYS
 * of the cabinet's last wait record, or of installs last being paused).
 */
export function waitedOn(state: GameState): (cabinet: CabinetId) => boolean {
  const { customers, day } = state;
  const paused = customers.pausedDay !== null && day - customers.pausedDay <= INSTALL_WAIT_WINDOW_DAYS;
  const recent = new Set<CabinetId>();
  for (const wait of customers.waits) if (day - wait.day <= INSTALL_WAIT_WINDOW_DAYS) recent.add(wait.cabinet);
  return (cabinet) => paused || recent.has(cabinet);
}

// ---------------------------------------------------------------------------
// Happiness (model 4)
// ---------------------------------------------------------------------------

/** A unit's regular monthly churn at happiness `score`: CHURN_MONTHLY_BASE x clamp(1 - score, HAPPY_CHURN_FLOOR, CHURN_MONTHLY_MAX / CHURN_MONTHLY_BASE). */
export function churnFromScore(score: number): number {
  if (!(CHURN_MONTHLY_BASE > 0)) return 0;
  return CHURN_MONTHLY_BASE * clamp(1 - score, HAPPY_CHURN_FLOOR, CHURN_MONTHLY_MAX / CHURN_MONTHLY_BASE);
}

/** The happiness bucket of a score (balance HAPPY_SCORE_MIN, UNHAPPY_SCORE_MAX). */
export function bucketOf(score: number): HappinessBucket {
  return score >= HAPPY_SCORE_MIN ? 'happy' : score <= UNHAPPY_SCORE_MAX ? 'unhappy' : 'okay';
}

/** The price factors of one unit (each 0 or of its sign). */
export interface PriceScores {
  priceVsCable: number;
  priceVsMarket: number;
  goodDeal: number;
}

/**
 * The price factors of a unit of `kind` paying `paid` a month (household
 * price, its lock included) on `tier`, where cable charges `cablePrice`
 * (incumbent.incumbentPriceFor its cabinet). A business compares its
 * household-equivalent price (paid x smbMultiplier / SMB_MULTIPLIER_DEFAULT).
 * With over / under = the share above / below the tier's market price
 * (TIER_DEFAULTS) and overCable = the share above cable's local price for
 * that kind of plan (cablePrice x the tier's market price / INCUMBENT_PRICE):
 *   priceVsMarket = -HAPPINESS_PER_PRICE_OVER_MARKET x max(0, over -
 *                   HAPPINESS_MARKET_PREMIUM_TOLERATED) (round 4c/4d fix: a
 *                   modest premium is accepted)
 *   goodDeal      = min(HAPPINESS_GOOD_DEAL_MAX, HAPPINESS_PER_PRICE_UNDER_MARKET x under)
 *   priceVsCable  = -HAPPINESS_PER_PRICE_OVER_CABLE x max(0, overCable - over - HAPPINESS_CABLE_PREMIUM_TOLERATED)
 * (priceVsCable is 0 wherever cable charges its standard price, and for a
 * unit on the default retention offer where it runs its promo). Pure.
 */
export function priceScores(tier: TierId, kind: ParcelKind, paid: number, smbMultiplier: number, cablePrice: number = INCUMBENT_PRICE): PriceScores {
  const market = DEFAULT_PRICE[tier] ?? paid;
  const equivalent = kind === 'smb' ? (paid * smbMultiplier) / SMB_MULTIPLIER_DEFAULT : paid;
  const over = market > 0 ? Math.max(0, equivalent - market) / market : 0;
  const under = market > 0 ? Math.max(0, market - equivalent) / market : 0;
  const local = (cablePrice * market) / INCUMBENT_PRICE;
  const overCable = local > 0 ? Math.max(0, equivalent - local) / local : 0;
  const overTolerated = overCable - over - HAPPINESS_CABLE_PREMIUM_TOLERATED;
  return {
    priceVsCable: overTolerated > 0 ? -HAPPINESS_PER_PRICE_OVER_CABLE * overTolerated : 0,
    priceVsMarket: over > HAPPINESS_MARKET_PREMIUM_TOLERATED ? -HAPPINESS_PER_PRICE_OVER_MARKET * (over - HAPPINESS_MARKET_PREMIUM_TOLERATED) : 0,
    goodDeal: under > 0 ? Math.min(HAPPINESS_GOOD_DEAL_MAX, HAPPINESS_PER_PRICE_UNDER_MARKET * under) : 0,
  };
}

/** The memory factors of an account on `day` (each 0 or negative). */
interface MemoryScores {
  outages: number;
  priceStep: number;
  installWait: number;
}

const NO_MEMORY: MemoryScores = { outages: 0, priceStep: 0, installWait: 0 };

function memoryScores(memory: CustomerMemory | undefined, day: number): MemoryScores {
  if (!memory) return NO_MEMORY;
  const outages = memory.outageDay !== null && memory.outageDays > 0 && day - memory.outageDay < HAPPINESS_OUTAGE_MEMORY_DAYS ? -HAPPINESS_PER_OUTAGE_DAY * memory.outageDays : 0;
  const priceStep = memory.priceStepDay !== null && day - memory.priceStepDay < HAPPINESS_PRICE_STEP_MEMORY_DAYS ? -HAPPINESS_PRICE_STEP : 0;
  const installWait = memory.waitedDay !== null && day - memory.waitedDay < HAPPINESS_WAIT_MEMORY_DAYS ? -HAPPINESS_INSTALL_WAIT : 0;
  return { outages, priceStep, installWait };
}

function memoryIndex(memories: readonly CustomerMemory[], parcel: ParcelId): CustomerMemory | undefined {
  let lo = 0;
  let hi = memories.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const entry = memories[mid] as CustomerMemory;
    if (entry.parcel === parcel) return entry;
    if (entry.parcel < parcel) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

/** The incumbent's price per cabinet where its promo ran on `day` (others: INCUMBENT_PRICE). */
function cablePricesOn(state: GameState, day: number): Map<CabinetId, number> {
  const out = new Map<CabinetId, number>();
  for (const promo of state.sales.incumbentPromos) if (promo.startDay <= day && day < promo.endDay) out.set(promo.cabinet, promo.price);
  return out;
}

/** What evaluating happiness needs for one day. */
interface HappinessContext {
  state: GameState;
  /** Memories age against this day. */
  day: number;
  support: number;
  cable: Map<CabinetId, number>;
  /** Price factors of a unit paying its tier's list price, by cable price, kind and tier (filled as asked: most units pay the list price). */
  atList: Map<number, Map<string, PriceScores>>;
}

function happinessContext(state: GameState, opts: { supportLevel?: SupportLevel; priceDay?: number } = {}): HappinessContext {
  const level = opts.supportLevel ?? state.customers.supportLevel;
  return { state, day: state.day, support: SUPPORT_LEVELS[level]?.happiness ?? 0, cable: cablePricesOn(state, opts.priceDay ?? state.day), atList: new Map() };
}

/** priceScores of a unit paying `paid`, from the context's list-price table when that is what it pays. */
function unitPriceScores(ctx: HappinessContext, tier: TierId, kind: ParcelKind, paid: number, list: number, cablePrice: number): PriceScores {
  const smb = ctx.state.sales.pricing.smbMultiplier;
  if (paid !== list) return priceScores(tier, kind, paid, smb, cablePrice);
  let byCable = ctx.atList.get(cablePrice);
  if (!byCable) {
    byCable = new Map<string, PriceScores>();
    ctx.atList.set(cablePrice, byCable);
  }
  const key = kind + tier;
  let scores = byCable.get(key);
  if (!scores) {
    scores = priceScores(tier, kind, paid, smb, cablePrice);
    byCable.set(key, scores);
  }
  return scores;
}

/** One account's factors: the account-wide ones, and the price ones weighted by its units per tier. */
interface AccountScores {
  units: number;
  memory: MemoryScores;
  price: PriceScores;
  /** Score without the support factor. */
  base: number;
}

function accountScores(ctx: HappinessContext, account: Account): AccountScores {
  const { state } = ctx;
  const kind = state.city.parcels[account.parcel]?.kind ?? 'home';
  const memory = memoryScores(memoryIndex(state.customers.memories, account.parcel), ctx.day);
  const cablePrice = ctx.cable.get(account.cabinet) ?? INCUMBENT_PRICE;
  const pricing = state.sales.pricing;
  let units = 0;
  let cable = 0;
  let market = 0;
  let deal = 0;
  for (const tier of pricing.tiers) {
    const n = account.tierUnits[tier.id];
    if (!n) continue;
    const lock = account.locks.length > 0 ? account.locks.find((l) => l.tier === tier.id) : undefined;
    const paid = lock ? Math.min(lock.price, tier.price) : tier.price;
    const p = unitPriceScores(ctx, tier.id, kind, paid, tier.price, cablePrice);
    units += n;
    cable += n * p.priceVsCable;
    market += n * p.priceVsMarket;
    deal += n * p.goodDeal;
  }
  const price = units > 0 ? { priceVsCable: cable / units, priceVsMarket: market / units, goodDeal: deal / units } : { priceVsCable: 0, priceVsMarket: 0, goodDeal: 0 };
  return { units, memory, price, base: memory.outages + memory.priceStep + memory.installWait + price.priceVsCable + price.priceVsMarket + price.goodDeal };
}

function happinessOf(ctx: HappinessContext, account: Account): AccountHappiness {
  const s = accountScores(ctx, account);
  const factors: HappinessFactor[] = [];
  const push = (reason: HappinessFactor['reason'], score: number) => {
    if (score !== 0) factors.push({ reason, score });
  };
  push('support', ctx.support);
  push('outages', s.memory.outages);
  push('priceVsCable', s.price.priceVsCable);
  push('priceVsMarket', s.price.priceVsMarket);
  push('goodDeal', s.price.goodDeal);
  push('priceStep', s.memory.priceStep);
  push('installWait', s.memory.installWait);
  factors.sort((a, b) => a.score - b.score);
  let score = 0;
  for (const factor of factors) score += factor.score;
  return { parcel: account.parcel, cabinet: account.cabinet, units: s.units, score, bucket: bucketOf(score), factors };
}

/**
 * One account's happiness today (see AccountHappiness and model 4 above):
 * the support level, outage days in memory, its price factors (each unit
 * at what it pays, lock included, against the market and cable's price at
 * its cabinet today; an account with units on several tiers averages them
 * by units), a recent price step and an install wait. Pure.
 */
export function accountHappiness(state: GameState, account: Account): AccountHappiness {
  return happinessOf(happinessContext(state), account);
}

/**
 * Happy and subscribed units per street (the account's parcel's segment)
 * today: word of mouth's happy share is happy / units. Pure.
 */
export function streetHappiness(state: GameState, supportLevel?: SupportLevel): Map<SegmentId, { happy: number; units: number }> {
  const ctx = happinessContext(state, supportLevel === undefined ? {} : { supportLevel });
  const out = new Map<SegmentId, { happy: number; units: number }>();
  const parcels = state.city.parcels;
  for (const account of state.sales.accounts) {
    const parcel = parcels[account.parcel];
    if (!parcel) continue;
    const s = accountScores(ctx, account);
    let row = out.get(parcel.segment);
    if (!row) {
      row = { happy: 0, units: 0 };
      out.set(parcel.segment, row);
    }
    row.units += s.units;
    if (s.base + ctx.support >= HAPPY_SCORE_MIN) row.happy += s.units;
  }
  return out;
}

/** A unit's regular churn and, of it, the part its priceVsCable factor adds (ChurnParts.regular and .incumbent at a close). */
export interface RegularChurn {
  regular: number;
  cable: number;
}

/**
 * The regular churn of each unit at a close (sales.closeSalesMonth step 5):
 * for a unit of `account` on `tier` paying `paid` (household price, its lock
 * included), its score (support + the account's memory factors, read before
 * this close writes any + its price factors at that price, cable's price at
 * its cabinet on `priceDay`: the ended month's last day at a close) gives
 * churnFromScore(score); `cable` = churnFromScore(score) -
 * churnFromScore(score - priceVsCable), `regular` the rest. Pure.
 */
export function regularChurnReader(state: GameState, priceDay: number = state.day): (account: Account, tier: TierId, paid: number) => RegularChurn {
  const ctx = happinessContext(state, { priceDay });
  const pricing = state.sales.pricing;
  let last: Account | null = null;
  let memory = 0;
  return (account, tier, paid) => {
    if (account !== last) {
      const m = memoryScores(memoryIndex(state.customers.memories, account.parcel), ctx.day);
      memory = m.outages + m.priceStep + m.installWait;
      last = account;
    }
    const kind = state.city.parcels[account.parcel]?.kind ?? 'home';
    const p = priceScores(tier, kind, paid, pricing.smbMultiplier, ctx.cable.get(account.cabinet) ?? INCUMBENT_PRICE);
    const score = ctx.support + memory + p.priceVsCable + p.priceVsMarket + p.goodDeal;
    const all = churnFromScore(score);
    const without = churnFromScore(score - p.priceVsCable);
    return { regular: Math.min(all, without), cable: Math.max(0, all - without) };
  };
}

/**
 * Happiness across the network (see HappinessReport): every account's
 * accountHappiness, units by bucket, per cabinet, and the top reasons (for
 * each account in the happy or unhappy bucket, its biggest factor in that
 * direction; reasons by units, at most HAPPINESS_REASONS_MAX, each with the
 * area holding more than half of its units, else null). Pure.
 */
export function happinessReport(state: GameState, supportLevel?: SupportLevel): HappinessReport {
  const ctx = happinessContext(state, supportLevel === undefined ? {} : { supportLevel });
  let happy = 0;
  let okay = 0;
  let unhappy = 0;
  const areas = new Map<CabinetId, { happy: number; okay: number; unhappy: number }>();
  const reasons = new Map<string, { count: HappinessReasonCount; byArea: Map<CabinetId, number> }>();
  for (const account of state.sales.accounts) {
    const h = happinessOf(ctx, account);
    const area = areas.get(h.cabinet) ?? { happy: 0, okay: 0, unhappy: 0 };
    area[h.bucket] += h.units;
    areas.set(h.cabinet, area);
    if (h.bucket === 'happy') happy += h.units;
    else if (h.bucket === 'unhappy') unhappy += h.units;
    else okay += h.units;
    if (h.bucket === 'okay') continue;
    const top = h.bucket === 'unhappy' ? h.factors.find((f) => f.score < 0) : [...h.factors].reverse().find((f) => f.score > 0);
    if (!top) continue;
    const key = `${h.bucket}:${top.reason}`;
    const entry = reasons.get(key) ?? { count: { reason: top.reason, bucket: h.bucket, units: 0, cabinet: null }, byArea: new Map<CabinetId, number>() };
    entry.count.units += h.units;
    entry.byArea.set(h.cabinet, (entry.byArea.get(h.cabinet) ?? 0) + h.units);
    reasons.set(key, entry);
  }
  const top: HappinessReasonCount[] = [];
  for (const { count, byArea } of reasons.values()) {
    let best: CabinetId | null = null;
    for (const [cabinet, units] of [...byArea.entries()].sort(([a], [b]) => a - b)) if (units * 2 > count.units) best = cabinet;
    top.push({ ...count, cabinet: best });
  }
  top.sort((a, b) => b.units - a.units || (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0) || (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0));
  return {
    happy,
    okay,
    unhappy,
    reasons: top.slice(0, HAPPINESS_REASONS_MAX),
    areas: [...areas.entries()].sort(([a], [b]) => a - b).map(([cabinet, counts]) => ({ cabinet, ...counts })),
  };
}

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

function emptyMemory(parcel: ParcelId): CustomerMemory {
  return { parcel, outageDays: 0, outageDay: null, priceStepDay: null, waitedDay: null };
}

/** The memory with every expired field cleared on `day` (outage days with their day), or null when nothing is left. */
function liveMemory(memory: CustomerMemory, day: number): CustomerMemory | null {
  const outageLive = memory.outageDay !== null && memory.outageDays > 0 && day - memory.outageDay < HAPPINESS_OUTAGE_MEMORY_DAYS;
  const stepLive = memory.priceStepDay !== null && day - memory.priceStepDay < HAPPINESS_PRICE_STEP_MEMORY_DAYS;
  const waitLive = memory.waitedDay !== null && day - memory.waitedDay < HAPPINESS_WAIT_MEMORY_DAYS;
  if (!outageLive && !stepLive && !waitLive) return null;
  return {
    parcel: memory.parcel,
    outageDays: outageLive ? memory.outageDays : 0,
    outageDay: outageLive ? memory.outageDay : null,
    priceStepDay: stepLive ? memory.priceStepDay : null,
    waitedDay: waitLive ? memory.waitedDay : null,
  };
}

/** Apply `update` to the memories of `parcels` (accounts that exist), then keep memories ascending, one per parcel, live ones only. */
function updateMemories(state: GameState, parcels: Iterable<ParcelId>, update: (memory: CustomerMemory) => void): void {
  const byParcel = new Map<ParcelId, CustomerMemory>();
  for (const memory of state.customers.memories) byParcel.set(memory.parcel, { ...memory });
  let changed = false;
  for (const parcel of parcels) {
    const memory = byParcel.get(parcel) ?? emptyMemory(parcel);
    update(memory);
    byParcel.set(parcel, memory);
    changed = true;
  }
  if (changed) state.customers.memories = pruneMemories(state, [...byParcel.values()].sort((a, b) => a.parcel - b.parcel));
}

/** Memories of accounts that still exist, with expired fields cleared and empty ones dropped (ascending kept). */
function pruneMemories(state: GameState, memories: readonly CustomerMemory[]): CustomerMemory[] {
  if (memories.length === 0) return [];
  const accounts = new Set<ParcelId>();
  for (const account of state.sales.accounts) accounts.add(account.parcel);
  const out: CustomerMemory[] = [];
  for (const memory of memories) {
    if (!accounts.has(memory.parcel)) continue;
    const live = liveMemory(memory, state.day);
    if (live) out.push(live);
  }
  return out;
}

/**
 * sales.closeSalesMonth, after its churn draws and its step 6: the accounts
 * on `parcels` had their price step up at this close (a lock ending with a
 * rise, units moved to a dearer tier): priceStepDay = today. Accounts gone
 * (every unit cancelled) are skipped.
 */
export function notePriceSteps(state: GameState, parcels: Iterable<ParcelId>): void {
  const day = state.day;
  updateMemories(state, parcels, (memory) => {
    memory.priceStepDay = day;
  });
}

/** sales.stepSales: the accounts on `parcels` connected today after waiting (waitedOn): waitedDay = today. */
export function noteInstallWaits(state: GameState, parcels: Iterable<ParcelId>): void {
  const day = state.day;
  updateMemories(state, parcels, (memory) => {
    memory.waitedDay = day;
  });
}

// ---------------------------------------------------------------------------
// Daily step and month close
// ---------------------------------------------------------------------------

/**
 * A street seen lit for the first time today: AWARENESS_ON_LIT from today,
 * unless it was lit before (`since`: a save from before round 4c/4d, whose
 * streets list is empty, or one of its streets with customers): then from
 * that day, at the awareness time alone (AWARENESS_BASE_PER_DAY) would have
 * brought it to.
 */
function newStreet(segment: SegmentId, day: number, since: number | undefined): StreetAwareness {
  const start = Math.round(AWARENESS_ON_LIT * AWARENESS_PPM);
  if (since === undefined || since >= day) return { segment, litDay: day, awareness: start };
  const litDay = Math.max(0, since);
  const keep = powInt(1 - clamp(AWARENESS_BASE_PER_DAY, 0, 1), day - litDay);
  return { segment, litDay, awareness: Math.min(AWARENESS_PPM, Math.round(AWARENESS_PPM - (AWARENESS_PPM - start) * keep)) };
}

/**
 * Add an entry for every street lit today that has none yet (as
 * stepCustomers would on its next step: newStreet, lit today unless it has
 * customers from before), keeping streets ascending; nothing else changes.
 * runCampaign calls it so the streets a campaign is priced on are known to
 * be lit by its purchase day (campaignStrengthOn).
 */
function trackLitStreets(state: GameState): void {
  const known = new Set(state.customers.streets.map((s) => s.segment));
  const missing = [...getService(state).litSegments].filter((segment) => !known.has(segment));
  if (missing.length === 0) return;
  const first = firstCustomerDays(state);
  state.customers.streets = [...state.customers.streets, ...missing.map((segment) => newStreet(segment, state.day, first.get(segment)))].sort((a, b) => a.segment - b.segment);
}

/** The earliest account's `since` per street (its parcel's segment). */
function firstCustomerDays(state: GameState): Map<SegmentId, number> {
  const first = new Map<SegmentId, number>();
  for (const account of state.sales.accounts) {
    const parcel = state.city.parcels[account.parcel];
    if (!parcel) continue;
    const seen = first.get(parcel.segment);
    if (seen === undefined || account.since < seen) first.set(parcel.segment, account.since);
  }
  return first;
}

/**
 * Round 4c/4d fix: the streets of a save from before round 4c/4d (its
 * customers state is customers.newCustomers(), streets empty), seeded when
 * it loads (save.ts) from what its plant says: every street lit today gets
 * litDay = the earlier of the day its plant first lit it
 * (network.litSinceDays) and its first customer's day, and the awareness
 * time alone would have brought it to since then (newStreet). A street lit
 * years ago is neither young (the intro promo's boost) nor back at
 * AWARENESS_ON_LIT. A save that already has streets is left as it is.
 */
export function seedStreets(state: GameState): void {
  if (state.customers.streets.length > 0) return;
  const since = litSinceDays(state);
  if (since.size === 0) return;
  const first = firstCustomerDays(state);
  state.customers.streets = [...since.keys()]
    .sort((a, b) => a - b)
    .map((segment) => {
      const lit = since.get(segment);
      const customer = first.get(segment);
      return newStreet(segment, state.day, customer === undefined ? lit : lit === undefined ? customer : Math.min(lit, customer));
    });
}

/**
 * One day of the customers model, run by tick() after weather.stepWeather
 * and before sales.stepSales for the new day (never day 0, never after game
 * over). No rng. In order:
 * 1. Streets: every lit segment (ascending) keeps its entry; a newly lit one
 *    is added (newStreet: AWARENESS_ON_LIT, litDay today); segments no
 *    longer lit are dropped.
 * 2. Awareness: every street that already had an entry grows by
 *    awarenessGainPerDay (marketing at today's budget over today's
 *    passings, its area's campaign strength today when the street was lit
 *    by the campaign's purchase day, its happy share today, referral
 *    credits), nextAwareness.
 * 3. Waits: each cabinet in Sales.fullCabinets (the list as yesterday's
 *    step left it) gets today; records older than INSTALL_WAIT_WINDOW_DAYS
 *    or of cabinets gone are dropped. pausedDay = today while installs are
 *    paused; null once older than INSTALL_WAIT_WINDOW_DAYS.
 * 4. Memories: expired fields cleared, empty ones and those of accounts gone
 *    dropped.
 * 5. Campaign records past cooldownUntil, or whose cabinet is gone, dropped.
 */
export function stepCustomers(state: GameState): void {
  const service = getService(state);
  const { customers, day } = state;
  const old = customers.streets;
  const lit = [...service.litSegments].sort((a, b) => a - b);
  let firstCustomer: Map<SegmentId, number> | null = null;
  const happy = streetHappiness(state);
  const strengths = campaignStrengths(customers.campaigns, day);
  const marketing = marketingAwarenessPerDay(state.sales.marketingPerMonth, service.passings);
  const streets: StreetAwareness[] = [];
  let i = 0;
  for (const segment of lit) {
    while (i < old.length && (old[i] as StreetAwareness).segment < segment) i++;
    const prev = i < old.length && (old[i] as StreetAwareness).segment === segment ? (old[i] as StreetAwareness) : null;
    if (!prev) {
      firstCustomer ??= firstCustomerDays(state);
      streets.push(newStreet(segment, day, firstCustomer.get(segment)));
      continue;
    }
    const h = happy.get(segment);
    const share = h && h.units > 0 ? h.happy / h.units : 0;
    const cabinet = service.servingCabinet.get(segment);
    const strength = cabinet === undefined ? 0 : campaignStrengthOn(strengths.get(cabinet), prev.litDay);
    const gain = awarenessGainPerDay(marketing, strength, share, customers.referrals);
    streets.push({ segment, litDay: prev.litDay, awareness: nextAwareness(prev.awareness, gain) });
  }
  customers.streets = streets;

  const cabinets = new Set(state.network.cabinets.map((c) => c.id));
  const waits = new Map<CabinetId, number>();
  for (const wait of customers.waits) if (cabinets.has(wait.cabinet) && day - wait.day <= INSTALL_WAIT_WINDOW_DAYS) waits.set(wait.cabinet, wait.day);
  for (const cabinet of state.sales.fullCabinets) if (cabinets.has(cabinet)) waits.set(cabinet, day);
  customers.waits = [...waits.entries()].sort(([a], [b]) => a - b).map(([cabinet, d]) => ({ cabinet, day: d }));
  if (state.sales.installsPaused) customers.pausedDay = day;
  else if (customers.pausedDay !== null && day - customers.pausedDay > INSTALL_WAIT_WINDOW_DAYS) customers.pausedDay = null;

  customers.memories = pruneMemories(state, customers.memories);
  customers.campaigns = customers.campaigns.filter((c) => c.cooldownUntil > day && cabinets.has(c.cabinet));
}

/**
 * The customers part of a month close, called by finance.closeMonth right
 * after sales.closeSalesMonth (churn done, price steps noted) and before
 * weather.closeWeatherMonth (so the month's outage days are still in
 * Weather.cutOff), at state.day = the close day, with the ended month's
 * last day for the entries' date. In order:
 * 1. Referral credits: n = round(month.referralMilli / 1000); when n > 0,
 *    'marketing' -(n x 2 x REFERRAL_CREDIT) dated lastDay, "Referral credits
 *    for Mar 2027: 9 referrals".
 * 2. Outage memories (after the churn draws): each account with days cut
 *    off in the month (Weather.cutOff, days > 0) adds them to its
 *    outageDays (restarting from them when its last outage day is
 *    HAPPINESS_OUTAGE_MEMORY_DAYS or more before lastDay), outageDay =
 *    lastDay, at most CUT_OFF_DAYS_MAX days.
 * 3. The stats (MonthlyReport.customers): customerSnapshot after both, the
 *    month's referral signups and credits and campaign spend.
 * 4. The month resets; campaign records past their cooldown (or of cabinets
 *    gone) are dropped.
 */
/**
 * The referral credits the next close posts for the open month so far
 * (closeCustomersMonth step 1): referrals = round(month.referralMilli /
 * 1000), credits = referrals x 2 x REFERRAL_CREDIT. finance's cash-at-close
 * projection counts them, so it stays exact on the month's last day.
 */
export function referralCreditsDue(state: GameState): { referrals: number; credits: number } {
  const referrals = Math.max(0, Math.round(state.customers.month.referralMilli / 1000));
  return { referrals, credits: referrals * 2 * REFERRAL_CREDIT };
}

export function closeCustomersMonth(state: GameState, lastDay: number): CustomerStats {
  const month = state.customers.month;
  const { referrals, credits } = referralCreditsDue(state);
  if (credits > 0) {
    const ended = dateOf(lastDay);
    postEntryOn(state, lastDay, 'marketing', -credits, `Referral credits for ${formatMonth(ended.year, ended.month)}: ${plural(referrals, 'referral', 'referrals')}`);
  }
  const outages = state.weather.cutOff.filter((e) => e.days > 0);
  if (outages.length > 0) {
    const days = new Map<ParcelId, number>();
    for (const entry of outages) days.set(entry.parcel, entry.days);
    const accounts = new Set(state.sales.accounts.map((a) => a.parcel));
    updateMemories(
      state,
      [...days.keys()].filter((p) => accounts.has(p)),
      (memory) => {
        const add = days.get(memory.parcel) ?? 0;
        const keep = memory.outageDay !== null && lastDay - memory.outageDay < HAPPINESS_OUTAGE_MEMORY_DAYS ? memory.outageDays : 0;
        memory.outageDays = Math.min(OUTAGE_MEMORY_DAYS_MAX, keep + add);
        memory.outageDay = lastDay;
      },
    );
  }
  const stats: CustomerStats = { ...customerSnapshot(state), referralSignups: referrals, referralCredits: credits, campaignSpend: month.campaignSpend };
  state.customers.month = emptyCustomersMonth();
  const cabinets = new Set(state.network.cabinets.map((c) => c.id));
  state.customers.campaigns = state.customers.campaigns.filter((c) => c.cooldownUntil > state.day && cabinets.has(c.cabinet));
  return stats;
}

/** Most outage days one memory holds (weather.CUT_OFF_DAYS_MAX: a save validates up to four times it). */
const OUTAGE_MEMORY_DAYS_MAX = 366;

/**
 * The parts of CustomerStats that are a pure read of the state now:
 * subscribed units by happiness bucket (accountHappiness) and the per-area
 * snapshot (active cabinets serving lit streets, ascending: passings on
 * the streets they serve, subscribed units on those same streets). A quiet
 * close's stats are this with zero referrals and campaign spend.
 * Round 4c/4d fix: subscribed units are counted by the street's serving
 * cabinet, as the passings, whyNotSwitched's area rows, unsignedUnitsIn and
 * quoteCampaign count them (an account stays on its old cabinet while that
 * still reaches the street: sales.serviceChanges), so an area's take rate
 * never counts customers on streets a nearer cabinet now serves.
 */
export function customerSnapshot(state: GameState): Pick<CustomerStats, 'happy' | 'okay' | 'unhappy' | 'areas'> {
  const report = happinessReport(state);
  const service = getService(state);
  const units = unitsByServingCabinet(state, service);
  const areas: AreaSnapshot[] = [];
  for (const cabinet of [...service.cabinetCoverage.keys()].sort((a, b) => a - b)) {
    const coverage = service.cabinetCoverage.get(cabinet);
    if (!coverage || coverage.segments.length === 0) continue;
    areas.push({ cabinet, passings: coverage.passings, units: units.get(cabinet) ?? 0 });
  }
  return { happy: report.happy, okay: report.okay, unhappy: report.unhappy, areas };
}

/** Subscribed units per cabinet area: each account's units under its street's serving cabinet (its own cabinet when the street has none). */
function unitsByServingCabinet(state: GameState, service: ServiceSnapshot): Map<CabinetId, number> {
  const units = new Map<CabinetId, number>();
  const parcels = state.city.parcels;
  for (const account of state.sales.accounts) {
    const segment = parcels[account.parcel]?.segment;
    const cabinet = (segment === undefined ? undefined : service.servingCabinet.get(segment)) ?? account.cabinet;
    units.set(cabinet, (units.get(cabinet) ?? 0) + accountUnits(account));
  }
  return units;
}

// ---------------------------------------------------------------------------
// Why homes haven't switched (model 3)
// ---------------------------------------------------------------------------

function emptyCounts(): SwitchReasonCounts {
  return { unaware: 0, deciding: 0, notWorth: 0, tooExpensive: 0, waiting: 0, unsigned: 0, passings: 0, subscribed: 0, notLit: 0 };
}

function addCounts(into: SwitchReasonCounts, row: SwitchReasonCounts): void {
  into.unaware += row.unaware;
  into.deciding += row.deciding;
  into.notWorth += row.notWorth;
  into.tooExpensive += row.tooExpensive;
  into.waiting += row.waiting;
  into.unsigned += row.unsigned;
  into.passings += row.passings;
  into.subscribed += row.subscribed;
}

/** Whole numbers summing exactly to `total` from shares `raw` (largest remainder; ties to the earlier entry). */
function largestRemainder(raw: readonly number[], total: number): number[] {
  const floors = raw.map((v) => Math.max(0, Math.floor(v)));
  let left = total - floors.reduce((a, b) => a + b, 0);
  const order = raw.map((v, i) => ({ i, frac: Math.max(0, v) - Math.floor(Math.max(0, v)) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; left > 0 && order.length > 0; k = (k + 1) % order.length) {
    floors[(order[k] as { i: number }).i]! += 1;
    left--;
  }
  // Rounding never overshoots (the shares sum to total), but stay exact if it ever did.
  for (let k = floors.length - 1; left < 0 && k >= 0; k--) {
    const take = Math.min(floors[k]!, -left);
    floors[k]! -= take;
    left += take;
  }
  return floors;
}

/** Share of a kind's households no offered tier suits (sum over segments of share x (1 - best suit)). */
function tooExpensiveShare(pricing: Pricing, kind: ParcelKind, incumbentPrice: number, promo: IntroPromo | null): number {
  let share = 0;
  for (const deal of segmentDeals(pricing, kind, incumbentPrice, promo)) share += deal.share * (1 - clamp(deal.suit, 0, 1));
  return share;
}

/**
 * Why lit households have not signed up, overall and per cabinet area (see
 * SwitchReasons and model 3 above). Pure. Per lit street (passed parcels
 * by segment, its serving cabinet, the incumbent's price there): unsigned =
 * passed units - subscribed; target = its whole-unit target as stepSales
 * rounds it; gap = min(unsigned, target - subscribed); beyond = unsigned -
 * gap; tooExpensive = min(beyond, its households no offered tier suits);
 * notWorth = the rest of beyond; unaware = gap x (1 - awareness); the aware
 * part of the gap is waiting while the serving cabinet is in
 * Sales.fullCabinets, installs are paused or an outage cuts the street off
 * from it, else deciding; largest-remainder whole units per street. notLit: units on
 * existing parcels of streets with cable in any stage that are not lit.
 */
export function whyNotSwitched(state: GameState): SwitchReasons {
  return reasonsIn(state);
}

/** whyNotSwitched, over the streets `only` serves when given (its one area row; notLit then 0). */
function reasonsIn(state: GameState, only?: CabinetId): SwitchReasons {
  const service = getService(state);
  const pricing = state.sales.pricing;
  const promo = state.sales.promo;
  const subscribed = new Map<ParcelId, number>();
  for (const account of state.sales.accounts) subscribed.set(account.parcel, accountUnits(account));
  const full = new Set(state.sales.fullCabinets);
  const paused = state.sales.installsPaused;
  const cable = cablePricesOn(state, state.day);
  const models = new Map<number, { take: Record<ParcelKind, number>; expensive: Record<ParcelKind, number> }>();
  // Round 4c/4d fix: the intro promo valued only where it applies (promoApplies: young or contested streets).
  const modelAt = (price: number, valued: boolean) => {
    const key = price * 2 + (valued ? 1 : 0);
    let model = models.get(key);
    if (!model) {
      const take = { home: 0, mdu: 0, smb: 0 };
      const expensive = { home: 0, mdu: 0, smb: 0 };
      const offer = valued ? promo : null;
      for (const kind of KINDS) {
        take[kind] = targetTakeRate(pricing, kind, price, offer);
        expensive[kind] = tooExpensiveShare(pricing, kind, price, offer);
      }
      model = { take, expensive };
      models.set(key, model);
    }
    return model;
  };
  const streets = new Map<SegmentId, { cabinet: CabinetId; target: number; expensive: number; units: number; subscribed: number }>();
  for (const id of service.passedParcels) {
    const parcel = state.city.parcels[id];
    if (!parcel) continue;
    const cabinet = service.servingCabinet.get(parcel.segment);
    if (cabinet === undefined || (only !== undefined && cabinet !== only)) continue;
    let row = streets.get(parcel.segment);
    if (!row) {
      row = { cabinet, target: 0, expensive: 0, units: 0, subscribed: 0 };
      streets.set(parcel.segment, row);
    }
    const entry = streetIndex(state.customers.streets, parcel.segment);
    const valued = promoApplies(promo, entry ? isYoungStreet(entry.litDay, state.day) : true, cable.has(cabinet));
    const model = modelAt(cable.get(cabinet) ?? INCUMBENT_PRICE, valued);
    row.target += model.take[parcel.kind] * parcel.units;
    row.expensive += model.expensive[parcel.kind] * parcel.units;
    row.units += parcel.units;
    row.subscribed += subscribed.get(id) ?? 0;
  }
  const overall = emptyCounts();
  const areas = new Map<CabinetId, SwitchReasonCounts>();
  for (const segment of [...streets.keys()].sort((a, b) => a - b)) {
    const row = streets.get(segment)!;
    const unsigned = Math.max(0, row.units - row.subscribed);
    const target = Math.max(0, Math.ceil(row.target - segmentOffset(state.seed, segment)));
    const gap = Math.min(unsigned, Math.max(0, target - row.subscribed));
    const beyond = unsigned - gap;
    const awareness = awarenessOf(state, segment);
    const cut = service.cutOffCabinets.get(segment)?.has(row.cabinet) ?? false;
    const blocked = full.has(row.cabinet) || paused || cut;
    const expensive = Math.min(beyond, row.expensive);
    const aware = gap * awareness;
    const [unaware, deciding, notWorth, tooExpensive, waiting] = largestRemainder(
      [gap - aware, blocked ? 0 : aware, beyond - expensive, expensive, blocked ? aware : 0],
      unsigned,
    ) as [number, number, number, number, number];
    const counts: SwitchReasonCounts = { ...emptyCounts(), unaware, deciding, notWorth, tooExpensive, waiting, unsigned, passings: row.units, subscribed: row.subscribed };
    addCounts(overall, counts);
    let area = areas.get(row.cabinet);
    if (!area) {
      area = emptyCounts();
      areas.set(row.cabinet, area);
    }
    addCounts(area, counts);
  }
  // Cabled streets not lit yet: their cable is still being built, or no cabinet reaches them.
  if (only === undefined) {
    const cabled = new Set<SegmentId>();
    for (const span of state.network.spans) cabled.add(span.segment);
    for (const parcel of state.city.parcels) {
      if (parcel.appearsDay > state.day || !cabled.has(parcel.segment) || service.litSegments.has(parcel.segment)) continue;
      overall.notLit += parcel.units;
    }
  }
  return {
    overall,
    areas: [...areas.entries()].sort(([a], [b]) => a - b).map(([cabinet, counts]) => ({ cabinet, ...counts })),
  };
}

/** Whole months from `from` to `to` (days), rounded down: (to - from) x 12 / 365. */
function monthsBetween(from: number, to: number): number {
  return Math.max(0, Math.floor(((to - from) * 12) / DAYS_PER_YEAR));
}

/**
 * The dashboard's Areas list (see CustomerArea): every active cabinet
 * serving lit streets, ascending cabinet, with its passings, subscribed
 * units, take rate, months since it went live, its subscribed units at the
 * close AREA_TREND_MONTHS before the latest report (when that report has
 * customer stats), and its campaign record. Pure.
 */
export function customerAreas(state: GameState): CustomerArea[] {
  const snapshot = customerSnapshot(state);
  const reports = state.finance.reports;
  const before = reports[reports.length - 1 - AREA_TREND_MONTHS]?.customers;
  return snapshot.areas.map((area) => {
    const cabinet = state.network.cabinets.find((c) => c.id === area.cabinet);
    const past = before?.areas.find((a) => a.cabinet === area.cabinet);
    return {
      cabinet: area.cabinet,
      node: cabinet?.node ?? state.city.coNode,
      passings: area.passings,
      subscribed: area.units,
      takeRate: area.passings > 0 ? area.units / area.passings : null,
      monthsLit: cabinet && cabinet.liveDay !== null ? monthsBetween(cabinet.liveDay, state.day) : null,
      subscribedBefore: past ? past.units : null,
      campaign: campaignFor(state, area.cabinet),
    };
  });
}

// ---------------------------------------------------------------------------
// The forecast (model 6): the switching model played forward
// ---------------------------------------------------------------------------

/** What to change in a forecast (forecastCustomers); omitted: as the game stands. */
export interface ForecastOptions {
  marketingPerMonth?: number;
  supportLevel?: SupportLevel;
  referrals?: boolean;
  /** A campaign bought today in this cabinet's area (replacing its record). */
  campaignAt?: CabinetId;
  /** The intro promo (null: none); default the game's. */
  promo?: IntroPromo | null;
  /** Only the streets this cabinet serves. */
  cabinet?: CabinetId;
  /** Default CUSTOMER_QUOTE_MONTHS. */
  months?: number;
  /**
   * Round 4c/4d fix: foresee the outages each street's own live cable can
   * expect (streetOutageExposure): their acute churn, and the outage memory
   * a share of its customers carries at any time (happiness, so churn and
   * word of mouth). Default false (the other quotes see no future outage).
   */
  outages?: boolean;
}

/** What a street's own cable's expected outages do to its customers in a forecast (streetOutageExposure). */
interface OutageExposure {
  /** Share of its customers remembering an outage at any time (one within HAPPINESS_OUTAGE_MEMORY_DAYS). */
  share: number;
  /** The happiness score that memory costs (HAPPINESS_PER_OUTAGE_DAY x the mean days out of one outage). */
  penalty: number;
  /** Extra monthly churn the outages cause when they happen (outagesPerYear / 12 x outageChurnProbability of the mean days). */
  churn: number;
}

const NO_EXPOSURE: OutageExposure = { share: 0, penalty: 0, churn: 0 };

/**
 * Round 4c/4d fix: the live segments on the way from a cabinet's node to
 * each segment it can reach over live cable, the segment itself last
 * (shortest by length, ties to the lower segment id): an outage on any of
 * them cuts the street off from that cabinet. Arithmetic only.
 */
function cabinetPaths(state: GameState, node: NodeId, live: ReadonlySet<SegmentId>): Map<SegmentId, readonly SegmentId[]> {
  const city = state.city;
  const dist = new Map<NodeId, number>([[node, 0]]);
  const via = new Map<NodeId, SegmentId>();
  const done = new Set<NodeId>();
  for (;;) {
    let u: NodeId | null = null;
    let best = Number.POSITIVE_INFINITY;
    for (const [n, d] of dist) if (!done.has(n) && (d < best || (d === best && u !== null && n < u))) (u = n), (best = d);
    if (u === null) break;
    done.add(u);
    for (const id of segmentsAtNode(city, u)) {
      if (!live.has(id)) continue;
      const seg = city.segments[id] as StreetSegment;
      const v = otherEnd(seg, u);
      const d = best + seg.lengthFt;
      const old = dist.get(v);
      if (old === undefined || d < old) {
        dist.set(v, d);
        via.set(v, id);
      }
    }
  }
  const pathTo = (n: NodeId): SegmentId[] => {
    const out: SegmentId[] = [];
    for (let at = n, guard = 0; at !== node && guard < city.segments.length; guard++) {
      const id = via.get(at);
      if (id === undefined) break;
      out.push(id);
      at = otherEnd(city.segments[id] as StreetSegment, at);
    }
    return out;
  };
  const paths = new Map<SegmentId, readonly SegmentId[]>();
  for (const id of live) {
    const seg = city.segments[id] as StreetSegment;
    const da = dist.get(seg.a);
    const db = dist.get(seg.b);
    if (da === undefined && db === undefined) continue;
    const near = db === undefined || (da !== undefined && da <= db) ? seg.a : seg.b;
    paths.set(id, [...pathTo(near).filter((s) => s !== id), id]);
  }
  return paths;
}

/**
 * Round 4c/4d fix: the outage exposure of a street's customers from the live
 * spans on its way from its serving cabinet, its own included (`path`:
 * weather.stormRisk at each span's method, summed): with outages at rate r a
 * year of mean d days each, a customer remembers one with probability
 * 1 - (1 - r / 365)^HAPPINESS_OUTAGE_MEMORY_DAYS, costing
 * HAPPINESS_PER_OUTAGE_DAY x d of happiness, and each outage cancels
 * outageChurnProbability(d) of them. Pure, an estimate (another way round
 * from another cabinet is ignored).
 */
function streetOutageExposure(state: GameState, spans: ReadonlyMap<SegmentId, readonly CableSpan[]>, path: readonly SegmentId[]): OutageExposure {
  let perYear = 0;
  let days = 0;
  for (const segment of path) {
    const seg = state.city.segments[segment];
    const list = spans.get(segment);
    if (!seg || !list) continue;
    for (const span of list) {
      const risk = stormRisk(state, seg, span.method);
      perYear += risk.outagesPerYear;
      days += risk.outageDaysPerYear;
    }
  }
  if (!(perYear > 0)) return NO_EXPOSURE;
  const mean = days / perYear;
  const daily = Math.min(1, perYear / DAYS_PER_YEAR);
  return {
    share: 1 - powInt(1 - daily, HAPPINESS_OUTAGE_MEMORY_DAYS),
    penalty: HAPPINESS_PER_OUTAGE_DAY * mean,
    churn: (perYear / 12) * outageChurnProbability(mean),
  };
}

/** What forecastCustomers expects over its horizon (not rounded). */
export interface CustomerForecast {
  days: number;
  /** Units waiting today on the streets counted (target less subscribed). */
  gap: number;
  /** Subscribed units on those streets today. */
  units: number;
  /** Gross signups. */
  signups: number;
  /** Of them, credited to referral credits. */
  referrals: number;
  /** Expected cancellations (regular churn by happiness, the intro promo's step, foreseen outages' churn). */
  cancellations: number;
  /** Subscriber-days. */
  unitDays: number;
  /** Subscriber-days of new signups on the intro promo's discount (inside the horizon). */
  promoUnitDays: number;
  /** What a unit pays a month there on average (today's bills per unit; the new signups' list price with nobody subscribed). */
  price: number;
  /** The average list price a new signup picks (the household mix, with the promo valued where it applies). */
  signupPrice: number;
  /** Share of the gap switching a day today, gap-weighted (units-weighted with no gap) over the streets counted. */
  rate: number;
  /** Of `gap`, the units on young streets (isYoungStreet: the intro promo's boost applies) and on streets where cable runs a promo. */
  youngGap: number;
  contestedGap: number;
  /**
   * Round 4c/4d fix: splitters the signups need beyond today's ports over the
   * horizon (whole splitters per cabinet, up to MAX_SPLITTERS_PER_CABINET):
   * the forecast lets signups take ports a player adds as cabinets fill, so
   * the quotes charge for them (splittersCost).
   */
  splitters: number;
  /** Round 4c/4d fix: the signups' install capex (sales.installCost of each street's open units; a building's router once), dollars. */
  installs: number;
  /** Round 4c/4d fix: subscribed units at the horizon's end, and the units still waiting then (the streets' open gaps), on the streets counted. */
  unitsEnd: number;
  gapEnd: number;
}

/** forecastCustomers advances this many days at a time, compounding the daily rules over each step (a week: within a few percent of day by day). */
const FORECAST_STEP_DAYS = 7;

/** A street in the forecast. */
interface ForecastStreet {
  cabinet: CabinetId;
  gap: number;
  inTarget: number;
  surplus: number;
  awareness: number;
  /** Its deal factor while the intro promo applies there (or throughout when it never does), and once it no longer does. */
  deal: number;
  dealAfter: number;
  /** Whole units its target falls by when the intro promo stops applying there (round 4c/4d fix; 0 when it never applies). */
  lift: number;
  litDay: number;
  contestedUntil: number;
  /** Happy share of today's customers there, and of new signups (on the list price, and while on the intro promo's discount). */
  happyOld: number;
  happyNew: number;
  happyPromo: number;
  /** Monthly churn of today's customers there (average), and of new signups (likewise). */
  churnOld: number;
  churnNew: number;
  churnPromo: number;
  /** Ports a new signup takes (new accounts' ports over open units). */
  portsPerUnit: number;
  /** Install capex of a new signup there (over its open units). */
  installPerUnit: number;
}

/** A new signup's tier in a forecast model: its share of signups, its score on the list price and on the intro promo's price. */
interface SignupTier {
  share: number;
  score: number;
  promoScore: number;
}

/** A score's happy share and churn with a street's outage exposure (a share of customers carrying the outage memory's penalty), its acute churn added. */
function exposed(score: number, e: OutageExposure): { happy: number; churn: number } {
  const keep = 1 - e.share;
  const happy = keep * (score >= HAPPY_SCORE_MIN ? 1 : 0) + e.share * (score - e.penalty >= HAPPY_SCORE_MIN ? 1 : 0);
  const churn = keep * churnFromScore(score) + (e.share > 0 ? e.share * churnFromScore(score - e.penalty) : 0) + e.churn;
  return { happy, churn };
}

/**
 * The customers model played forward from today over `months`, a week
 * (FORECAST_STEP_DAYS) at a time compounding the daily rules (pure, no rng): per lit street (only `cabinet`'s with that
 * option), its gap, subscribed units within and above its target, awareness
 * (model 2 at the budget, campaign strength, word of mouth), switching
 * (model 1: awareness x SWITCH_BASE_PER_DAY x its deal factor x word of
 * mouth x campaign x the promo's boost while young or contested), and
 * cancellations at its customers' happiness churn (today's customers at
 * their scores with the forecast's support level, new signups at the price
 * of the household mix: while on the intro promo's discount at that price),
 * which reopen the gap. Round 4c/4d fixes: the intro promo is valued in a
 * street's target and deal factor only while it applies there (young or
 * contested: promoApplies), its target falling back after; its cohorts take
 * the step churn as their locks end and reopen the gap; new accounts take
 * ports per cabinet up to MAX_SPLITTERS_PER_CABINET splitters (splitters
 * are added as a cabinet fills, as SMART, CASUAL and the advisor do;
 * `splitters` counts those needed beyond today's); `installs` is the
 * signups' install capex; with `outages`, each street's own cable's expected
 * outages (streetOutageExposure). Future streets, parcels, cash and
 * incumbent promos are not foreseen (nor outages without `outages`).
 */
export function forecastCustomers(state: GameState, opts: ForecastOptions = {}): CustomerForecast {
  const service = getService(state);
  const day0 = state.day;
  const months = opts.months ?? CUSTOMER_QUOTE_MONTHS;
  const days = Math.max(0, Math.round(months * DAYS_PER_MONTH));
  const marketing = marketingAwarenessPerDay(opts.marketingPerMonth ?? state.sales.marketingPerMonth, service.passings);
  const level = opts.supportLevel ?? state.customers.supportLevel;
  const referrals = opts.referrals ?? state.customers.referrals;
  const promo = opts.promo === undefined ? state.sales.promo : opts.promo;
  const pricing = state.sales.pricing;
  const ctx = happinessContext(state, { supportLevel: level });
  const cable = ctx.cable;
  const mult = womMultiplier(referrals);
  const boost = promoSignupFactor(promo);

  // Per incumbent price and whether the intro promo is valued there: take rates, deal factors and what a new signup is like.
  interface Model {
    take: Record<ParcelKind, number>;
    deal: Record<ParcelKind, number>;
    tiers: SignupTier[];
    price: number;
  }
  const models = new Map<number, Model>();
  const modelAt = (price: number, valued: boolean): Model => {
    const key = price * 2 + (valued ? 1 : 0);
    let model = models.get(key);
    if (!model) {
      const offer = valued ? promo : null;
      const take = { home: 0, mdu: 0, smb: 0 };
      for (const kind of KINDS) take[kind] = targetTakeRate(pricing, kind, price, offer);
      const mix = tierMix(pricing, 'home', price, offer);
      const tiers: SignupTier[] = [];
      let list = 0;
      for (const tier of pricing.tiers) {
        const share = mix[tier.id];
        if (!(share > 0)) continue;
        const p = priceScores(tier.id, 'home', tier.price, pricing.smbMultiplier, price);
        // Every signup gets the promo's lock while one is set (sales.promoLock), valued or not.
        const paid = promo ? Math.min(tier.price, promoPrice(tier.price, promo.percentOff)) : tier.price;
        const q = paid === tier.price ? p : priceScores(tier.id, 'home', paid, pricing.smbMultiplier, price);
        tiers.push({ share, score: ctx.support + p.priceVsCable + p.priceVsMarket + p.goodDeal, promoScore: ctx.support + q.priceVsCable + q.priceVsMarket + q.goodDeal });
        list += share * tier.price;
      }
      model = { take, deal: dealFactors(pricing, price, offer), tiers, price: list };
      models.set(key, model);
    }
    return model;
  };

  // Each street's own live cable's expected outages (with `outages`).
  const spansOn = new Map<SegmentId, CableSpan[]>();
  if (opts.outages) {
    for (const span of state.network.spans) {
      if (span.stage !== 'live') continue;
      const list = spansOn.get(span.segment);
      if (list) list.push(span);
      else spansOn.set(span.segment, [span]);
    }
  }
  const exposures = new Map<SegmentId, OutageExposure>();
  const paths = new Map<CabinetId, Map<SegmentId, readonly SegmentId[]>>();
  const live = new Set(spansOn.keys());
  const exposureOf = (segment: SegmentId): OutageExposure => {
    if (!opts.outages) return NO_EXPOSURE;
    let e = exposures.get(segment);
    if (!e) {
      const cabinet = service.servingCabinet.get(segment);
      const node = cabinet === undefined ? undefined : state.network.cabinets.find((c) => c.id === cabinet)?.node;
      let fromCabinet = cabinet === undefined ? undefined : paths.get(cabinet);
      if (cabinet !== undefined && node !== undefined && !fromCabinet) {
        fromCabinet = cabinetPaths(state, node, live);
        paths.set(cabinet, fromCabinet);
      }
      e = streetOutageExposure(state, spansOn, fromCabinet?.get(segment) ?? [segment]);
      exposures.set(segment, e);
    }
    return e;
  };

  // Accounts per parcel, and their happiness at the forecast's support level.
  const accountAt = new Map<ParcelId, Account>();
  for (const account of state.sales.accounts) accountAt.set(account.parcel, account);
  const routers = new Set(state.sales.routerParcels);

  interface Row {
    cabinet: CabinetId;
    /** Target units and deal-weighted target units with the promo valued and without. */
    rawOn: number;
    dealOn: number;
    rawOff: number;
    dealOff: number;
    valued: boolean;
    sub: number;
    open: number;
    newPorts: number;
    installs: number;
    happy: number;
    churn: number;
    billed: number;
  }
  const rows = new Map<SegmentId, Row>();
  const contested = new Map<CabinetId, number>();
  for (const p of state.sales.incumbentPromos) if (p.startDay <= day0 && day0 < p.endDay) contested.set(p.cabinet, p.endDay);
  for (const id of service.passedParcels) {
    const parcel = state.city.parcels[id];
    if (!parcel) continue;
    const cabinet = service.servingCabinet.get(parcel.segment);
    if (cabinet === undefined || (opts.cabinet !== undefined && cabinet !== opts.cabinet)) continue;
    let row = rows.get(parcel.segment);
    if (!row) {
      const entry = streetIndex(state.customers.streets, parcel.segment);
      const litDay = entry ? entry.litDay : day0;
      const valued = promoApplies(promo, isYoungStreet(litDay, day0 + 1), day0 + 1 < (contested.get(cabinet) ?? -1));
      row = { cabinet, rawOn: 0, dealOn: 0, rawOff: 0, dealOff: 0, valued, sub: 0, open: 0, newPorts: 0, installs: 0, happy: 0, churn: 0, billed: 0 };
      rows.set(parcel.segment, row);
    }
    const price = cable.get(cabinet) ?? INCUMBENT_PRICE;
    const off = modelAt(price, false);
    const tOff = off.take[parcel.kind] * parcel.units;
    row.rawOff += tOff;
    row.dealOff += tOff * off.deal[parcel.kind];
    if (row.valued) {
      const on = modelAt(price, true);
      const tOn = on.take[parcel.kind] * parcel.units;
      row.rawOn += tOn;
      row.dealOn += tOn * on.deal[parcel.kind];
    }
    const account = accountAt.get(id);
    const sub = account ? accountUnits(account) : 0;
    const open = Math.max(0, parcel.units - sub);
    row.sub += sub;
    row.open += open;
    if (!account && parcel.units > 0) row.newPorts += parcel.kind === 'mdu' ? MDU_PORTS_PER_BUILDING : 1;
    if (open > 0) row.installs += open * installCost(parcel.kind, true) + (parcel.kind === 'mdu' && !routers.has(id) ? installCost('mdu', false) - installCost('mdu', true) : 0);
    if (account) {
      const s = accountScores(ctx, account);
      const score = s.base + ctx.support;
      const e = exposureOf(parcel.segment);
      // A customer remembering an outage now keeps that memory's score; the others carry the street's expected share of one.
      const h = s.memory.outages < 0 ? { happy: score >= HAPPY_SCORE_MIN ? 1 : 0, churn: churnFromScore(score) + e.churn } : exposed(score, e);
      row.happy += s.units * h.happy;
      row.churn += s.units * h.churn;
      for (const tier of pricing.tiers) {
        const n = account.tierUnits[tier.id];
        if (n) row.billed += n * accountUnitPrice(state, account, tier.id);
      }
    }
  }

  const strengthOf = new Map<CabinetId, NeighborhoodCampaign>();
  for (const c of state.customers.campaigns) strengthOf.set(c.cabinet, c);
  if (opts.campaignAt !== undefined) strengthOf.set(opts.campaignAt, campaignRecord(opts.campaignAt, day0, 0, 0));

  const streets: ForecastStreet[] = [];
  let gapTotal = 0;
  let units = 0;
  let billed = 0;
  let signupPrice = 0;
  let priceWeight = 0;
  let rateNum = 0;
  let rateDen = 0;
  let rateUnits = 0;
  let rateUnitsNum = 0;
  let youngGap = 0;
  let contestedGap = 0;
  for (const segment of [...rows.keys()].sort((a, b) => a - b)) {
    const row = rows.get(segment)!;
    const offset = segmentOffset(state.seed, segment);
    const targetOff = Math.max(0, Math.ceil(row.rawOff - offset));
    const targetOn = row.valued ? Math.max(0, Math.ceil(row.rawOn - offset)) : targetOff;
    const target = row.valued ? targetOn : targetOff;
    const entry = streetIndex(state.customers.streets, segment);
    const price = cable.get(row.cabinet) ?? INCUMBENT_PRICE;
    const model = modelAt(price, row.valued);
    const e = exposureOf(segment);
    let happyNew = 0;
    let churnNew = 0;
    let happyPromo = 0;
    let churnPromo = 0;
    for (const tier of model.tiers) {
      const atList = exposed(tier.score, e);
      const atPromo = exposed(tier.promoScore, e);
      happyNew += tier.share * atList.happy;
      churnNew += tier.share * atList.churn;
      happyPromo += tier.share * atPromo.happy;
      churnPromo += tier.share * atPromo.churn;
    }
    const dealOff = row.rawOff > 0 ? row.dealOff / row.rawOff : SWITCH_DEAL_MIN;
    const street: ForecastStreet = {
      cabinet: row.cabinet,
      gap: Math.min(row.open, Math.max(0, target - row.sub)),
      inTarget: Math.min(row.sub, target),
      surplus: Math.max(0, row.sub - target),
      awareness: entry ? entry.awareness / AWARENESS_PPM : AWARENESS_ON_LIT,
      deal: row.valued ? (row.rawOn > 0 ? row.dealOn / row.rawOn : SWITCH_DEAL_MIN) : dealOff,
      dealAfter: dealOff,
      lift: targetOn - targetOff,
      litDay: entry ? entry.litDay : day0,
      contestedUntil: contested.get(row.cabinet) ?? -1,
      happyOld: row.sub > 0 ? row.happy / row.sub : 0,
      happyNew,
      happyPromo,
      churnOld: row.sub > 0 ? row.churn / row.sub : churnNew,
      churnNew,
      churnPromo,
      portsPerUnit: row.open > 0 ? row.newPorts / row.open : 0,
      installPerUnit: row.open > 0 ? row.installs / row.open : 0,
    };
    streets.push(street);
    gapTotal += street.gap;
    if (isYoungStreet(street.litDay, day0 + 1)) youngGap += street.gap;
    if (day0 + 1 < street.contestedUntil) contestedGap += street.gap;
    units += row.sub;
    billed += row.billed;
    // The average new signup's list price, over the streets weighted by their gaps.
    signupPrice += (street.gap + 1e-9) * model.price;
    priceWeight += street.gap + 1e-9;
    // Today's rate there (the first forecast day's, before awareness grows).
    const h = row.sub > 0 ? row.happy / row.sub : 0;
    const record = strengthOf.get(row.cabinet);
    const strength = record && street.litDay <= record.startDay ? campaignStrength(record, day0 + 1) : 0;
    const young = isYoungStreet(street.litDay, day0 + 1);
    const rate = switchRate(street.awareness, street.deal, womSwitchFactor(h, referrals), campaignSwitchFactor(strength), young || day0 + 1 < street.contestedUntil ? boost : 1);
    rateNum += street.gap * rate;
    rateDen += street.gap;
    rateUnitsNum += (row.sub + row.open) * rate;
    rateUnits += row.sub + row.open;
  }
  signupPrice = priceWeight > 0 ? signupPrice / priceWeight : modelAt(INCUMBENT_PRICE, false).price;

  // The day loop runs on flat arrays (it is the quotes' hot path).
  const n = streets.length;
  const cabinetAt = new Map<CabinetId, number>();
  state.network.cabinets.forEach((c, i) => cabinetAt.set(c.id, i));
  // Ports up to a full cabinet (MAX_SPLITTERS_PER_CABINET splitters): a player adds splitters as a cabinet fills.
  const used = cabinetPortsUsed(state);
  const fullPorts = MAX_SPLITTERS_PER_CABINET * SPLIT_RATIO;
  const freePorts = new Float64Array(state.network.cabinets.length);
  const portCap = new Float64Array(state.network.cabinets.length);
  const peakUsed = new Float64Array(state.network.cabinets.length);
  state.network.cabinets.forEach((c, i) => {
    const inUse = used.get(c.id) ?? 0;
    portCap[i] = Math.max(fullPorts, cabinetPortCapacity(c));
    freePorts[i] = Math.max(0, (portCap[i] as number) - inUse);
    peakUsed[i] = inUse;
  });
  const campaigns: { at: number; record: NeighborhoodCampaign }[] = [];
  for (const [cabinet, record] of strengthOf) {
    const at = cabinetAt.get(cabinet);
    if (at !== undefined) campaigns.push({ at, record });
  }
  const strengthToday = new Float64Array(state.network.cabinets.length);
  const gap = new Float64Array(n);
  const inTarget = new Float64Array(n);
  const surplus = new Float64Array(n);
  const added = new Float64Array(n);
  const awareness = new Float64Array(n);
  const deal = new Float64Array(n);
  const lift = new Float64Array(n);
  const boostUntil = new Float64Array(n);
  const happyOld = new Float64Array(n);
  const happyNew = new Float64Array(n);
  const happyPromo = new Float64Array(n);
  const churnOld = new Float64Array(n);
  const churnNew = new Float64Array(n);
  const churnPromo = new Float64Array(n);
  const ports = new Float64Array(n);
  const installPerUnit = new Float64Array(n);
  const cab = new Int32Array(n);
  // 1 where the area's campaign covers the street (lit when it was bought: campaignStrengthOn).
  const inCampaign = new Uint8Array(n);
  streets.forEach((street, i) => {
    gap[i] = street.gap;
    inTarget[i] = street.inTarget;
    surplus[i] = street.surplus;
    awareness[i] = street.awareness;
    deal[i] = street.deal;
    lift[i] = street.lift;
    boostUntil[i] = Math.max(street.litDay + PROMO_BOOST_YOUNG_DAYS, street.contestedUntil);
    happyOld[i] = street.happyOld;
    happyNew[i] = street.happyNew;
    happyPromo[i] = street.happyPromo;
    churnOld[i] = street.churnOld / DAYS_PER_MONTH;
    churnNew[i] = street.churnNew / DAYS_PER_MONTH;
    churnPromo[i] = street.churnPromo / DAYS_PER_MONTH;
    ports[i] = street.portsPerUnit;
    installPerUnit[i] = street.installPerUnit;
    cab[i] = cabinetAt.get(street.cabinet) ?? -1;
    const record = strengthOf.get(street.cabinet);
    inCampaign[i] = record && street.litDay <= record.startDay ? 1 : 0;
  });

  const promoDays = promo ? Math.round((promo.months + 0.5) * DAYS_PER_MONTH) : 0;
  const stepChurn = promo ? stepChurnProbability(signupPrice * (1 - promo.percentOff / 100), signupPrice, PROMO_STEP_SHARE) : 0;
  // Each step's signups (for the intro promo's step churn when its locks end, and the share of new signups still on it), by the step's first day.
  const cohorts: { day: number; signups: number }[] = [];
  let cohortsEnded = 0;
  let locked = 0;
  const womAwareness = AWARENESS_WOM_PER_DAY * mult;
  const womSwitch = SWITCH_WOM_BOOST * mult;
  const baseGain = AWARENESS_BASE_PER_DAY + marketing;
  let signups = 0;
  let referred = 0;
  let cancellations = 0;
  let unitDays = 0;
  let promoUnitDays = 0;
  let installs = 0;
  // FORECAST_STEP_DAYS days at a time, compounding the daily rules over the step (the quotes' hot path).
  for (let t = 0; t < days; t += FORECAST_STEP_DAYS) {
    const span = Math.min(FORECAST_STEP_DAYS, days - t);
    const first = day0 + 1 + t;
    const mid = first + Math.floor(span / 2);
    for (const c of campaigns) strengthToday[c.at] = campaignStrength(c.record, mid);
    // Cohorts whose promo locks have ended by now take their step churn: those households cancel and reopen the gap.
    if (promo) {
      while (cohortsEnded < cohorts.length && (cohorts[cohortsEnded] as { day: number }).day + promoDays <= first) {
        const cohort = cohorts[cohortsEnded] as { signups: number };
        locked -= cohort.signups;
        if (stepChurn > 0 && cohort.signups > 0) {
          let pool = 0;
          for (let i = 0; i < n; i++) pool += added[i] as number;
          const lost = Math.min(pool, cohort.signups * stepChurn);
          if (pool > 0 && lost > 0) {
            for (let i = 0; i < n; i++) {
              const take = (lost * (added[i] as number)) / pool;
              added[i] = (added[i] as number) - take;
              gap[i] = (gap[i] as number) + take;
              const at = cab[i] as number;
              if (at >= 0) freePorts[at] = (freePorts[at] as number) + take * (ports[i] as number);
            }
            cancellations += lost;
          }
        }
        cohortsEnded++;
      }
    }
    const lockedShare = promo && signups > 0 ? Math.min(1, Math.max(0, locked / signups)) : 0;
    let today = 0;
    for (let i = 0; i < n; i++) {
      // The intro promo no longer applies here (the street aged out, cable's promo ended): its target and deal fall back.
      if ((lift[i] as number) !== 0 && mid >= (boostUntil[i] as number)) {
        gap[i] = (gap[i] as number) - (lift[i] as number);
        lift[i] = 0;
        deal[i] = (streets[i] as ForecastStreet).dealAfter;
      }
      const old = (inTarget[i] as number) + (surplus[i] as number);
      const fresh = added[i] as number;
      const total = old + fresh;
      const hNew = lockedShare > 0 ? lockedShare * (happyPromo[i] as number) + (1 - lockedShare) * (happyNew[i] as number) : (happyNew[i] as number);
      const h = total > 0 ? ((happyOld[i] as number) * old + hNew * fresh) / total : 0;
      const at = cab[i] as number;
      const strength = campaigns.length > 0 && at >= 0 && inCampaign[i] === 1 ? (strengthToday[at] as number) : 0;
      // Model 2 over the step: a_k = 1 - (1 - a) x q^k with q = 1 - g; switching sees their mean.
      let gain = baseGain + CAMPAIGN_AWARENESS_PER_DAY * strength + womAwareness * h;
      if (gain > 1) gain = 1;
      const a0 = awareness[i] as number;
      const q = 1 - gain;
      const qSpan = powInt(q, span);
      const meanA = gain > 0 ? 1 - ((1 - a0) * q * (1 - qSpan)) / (span * gain) : a0;
      awareness[i] = 1 - (1 - a0) * qSpan;
      // Model 1 at that mean awareness, compounded over the step.
      const wom = 1 + womSwitch * h;
      let rate = meanA * SWITCH_BASE_PER_DAY * (deal[i] as number) * wom * (1 + CAMPAIGN_SWITCH_BOOST * strength) * (mid < (boostUntil[i] as number) ? boost : 1);
      if (rate > 1) rate = 1;
      const open = gap[i] as number;
      let x = open > 0 ? open * (1 - powInt(1 - rate, span)) : 0;
      const ppu = ports[i] as number;
      if (x > 0 && ppu > 0 && at >= 0) {
        const free = freePorts[at] as number;
        if (x * ppu > free) x = free / ppu;
        freePorts[at] = free - x * ppu;
        const inUse = (portCap[at] as number) - (freePorts[at] as number);
        if (inUse > (peakUsed[at] as number)) peakUsed[at] = inUse;
      }
      const startUnits = total;
      gap[i] = open - x;
      added[i] = fresh + x;
      signups += x;
      today += x;
      installs += x * (installPerUnit[i] as number);
      if (referrals) referred += x * ((wom - 1) / wom);
      if (promo) promoUnitDays += x * Math.min(promoDays, days - t - span / 2);
      const keepOld = powInt(1 - (churnOld[i] as number), span);
      const cNew = lockedShare > 0 ? lockedShare * (churnPromo[i] as number) + (1 - lockedShare) * (churnNew[i] as number) : (churnNew[i] as number);
      const keepNew = powInt(1 - cNew, span);
      const lostIn = (inTarget[i] as number) * (1 - keepOld);
      const lostOver = (surplus[i] as number) * (1 - keepOld);
      const lostNew = (added[i] as number) * (1 - keepNew);
      inTarget[i] = (inTarget[i] as number) - lostIn;
      surplus[i] = (surplus[i] as number) - lostOver;
      added[i] = (added[i] as number) - lostNew;
      gap[i] = (gap[i] as number) + lostIn + lostNew;
      if (ppu > 0 && at >= 0) freePorts[at] = (freePorts[at] as number) + (lostIn + lostOver + lostNew) * ppu;
      cancellations += lostIn + lostOver + lostNew;
      const endUnits = (inTarget[i] as number) + (surplus[i] as number) + (added[i] as number);
      unitDays += ((startUnits + endUnits) / 2) * span;
    }
    if (promo) {
      cohorts.push({ day: first, signups: today });
      locked += today;
    }
  }
  let unitsEnd = 0;
  let gapEnd = 0;
  for (let i = 0; i < n; i++) {
    unitsEnd += (inTarget[i] as number) + (surplus[i] as number) + (added[i] as number);
    gapEnd += Math.max(0, gap[i] as number);
  }
  // Whole splitters each cabinet needs beyond today's to hold its busiest day's ports.
  let splitters = 0;
  state.network.cabinets.forEach((c, i) => {
    const over = (peakUsed[i] as number) - cabinetPortCapacity(c);
    if (over > 1e-6) splitters += Math.min(Math.max(0, MAX_SPLITTERS_PER_CABINET - c.splitters), Math.ceil(over / SPLIT_RATIO - 1e-9));
  });
  return {
    days,
    gap: gapTotal,
    units,
    signups,
    referrals: referred,
    cancellations,
    unitDays: Math.max(0, unitDays),
    promoUnitDays,
    price: units > 0 ? billed / units : signupPrice,
    signupPrice,
    rate: rateDen > 0 ? rateNum / rateDen : rateUnits > 0 ? rateUnitsNum / rateUnits : 0,
    youngGap,
    contestedGap,
    splitters,
    installs,
    unitsEnd,
    gapEnd,
  };
}

/**
 * Round 4c/4d fix: what `splitters` more splitters cost (the quotes' charge
 * for the ports their extra signups need): SPLITTER_COST each, plus an OLT
 * line card (OLT_CARD_COST) for every OLT_PORTS_PER_CARD PON ports they need
 * beyond the free ones. Whole dollars, 0 for none.
 */
export function splittersCost(state: GameState, splitters: number): number {
  if (!(splitters > 0)) return 0;
  const cards = Math.max(0, Math.ceil((ponPortsUsed(state) + splitters - state.network.olt.ponPorts) / OLT_PORTS_PER_CARD));
  return Math.round(splitters * SPLITTER_COST + cards * OLT_CARD_COST);
}

/** The splitters a forecast needs beyond another's, priced (splittersCost of each; at least 0). */
function extraSplittersCost(state: GameState, more: CustomerForecast, base: CustomerForecast): number {
  return Math.max(0, splittersCost(state, more.splitters) - splittersCost(state, base.splitters));
}

/**
 * Share of a cabinet area's gap switching a day today (forecastCustomers'
 * rate over its streets): the speed a cancellation there is replaced at
 * (incumbent.quoteRetention).
 */
export function areaSwitchRate(state: GameState, cabinet: CabinetId): number {
  return forecastCustomers(state, { cabinet, months: 0 }).rate;
}

/**
 * Subscriber-months a cancellation costs within `days` when its area
 * switches at `rate` of the gap a day (it reopens one unit of gap): the sum
 * over the days of (1 - rate)^t, in months; and the share of it replaced by
 * then (1 - (1 - rate)^days). Arithmetic only.
 */
export function lostMonthsPerCancellation(rate: number, days: number): { months: number; replaced: number } {
  const r = clamp(rate, 0, 1);
  if (r <= 0) return { months: days / DAYS_PER_MONTH, replaced: 0 };
  const keep = powInt(1 - r, days);
  return { months: (1 - keep) / r / DAYS_PER_MONTH, replaced: 1 - keep };
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/** Margin of one subscribed unit a month: what it pays less the running cost per customer (overhead.perCustomerCost), at least 0. */
function marginOf(price: number, perCustomer: number): number {
  return Math.max(0, price - perCustomer);
}

/**
 * What a marketing budget of `perMonth` would do (see MarketingQuote).
 * Pure. ok/reasons as setMarketing decides (and false once the game is
 * over). Figures: forecastCustomers at this budget and at $0 over
 * CUSTOMER_QUOTE_MONTHS: signups a month, the extra ones the budget brings,
 * the splitters they need (splitterCost) and (the budget over the horizon
 * plus splitterCost) per extra customer.
 */
export function quoteMarketing(state: GameState, perMonth: number): MarketingQuote {
  const reasons: string[] = [];
  if (state.gameOver) reasons.push(`Game over: ${state.gameOver.message}`);
  if (typeof perMonth !== 'number' || !Number.isInteger(perMonth) || perMonth < 0 || perMonth > MARKETING_MAX_PER_MONTH) {
    reasons.push(`The marketing budget is a whole number of dollars from $0 to ${formatMoney(MARKETING_MAX_PER_MONTH)} a month`);
  }
  const quote: MarketingQuote = { ok: reasons.length === 0, reasons, perMonth, months: CUSTOMER_QUOTE_MONTHS, signupsPerMonth: 0, extraPerMonth: 0, splitterCost: 0, costPerCustomer: null };
  if (!quote.ok) return quote;
  const withBudget = forecastCustomers(state, { marketingPerMonth: perMonth });
  const without = perMonth === 0 ? withBudget : forecastCustomers(state, { marketingPerMonth: 0 });
  const at = withBudget.signups / CUSTOMER_QUOTE_MONTHS;
  const none = without.signups / CUSTOMER_QUOTE_MONTHS;
  quote.signupsPerMonth = Math.max(0, at);
  quote.extraPerMonth = Math.max(0, at - none);
  quote.splitterCost = extraSplittersCost(state, withBudget, without);
  quote.costPerCustomer =
    perMonth > 0 && quote.extraPerMonth >= 0.01 ? Math.round((perMonth * CUSTOMER_QUOTE_MONTHS + quote.splitterCost) / (quote.extraPerMonth * CUSTOMER_QUOTE_MONTHS)) : null;
  return quote;
}

/**
 * What a neighborhood campaign at `cabinet` would do (see CampaignQuote).
 * Pure. ok/reasons (runCampaign uses them): the game is not over; `cabinet`
 * is a cabinet that is live and active (service.activeCabinets) and serves
 * lit streets with households not signed up; no campaign record there holds
 * it back (state.day < cooldownUntil; availableDay names it); cash covers
 * the cost. cost and unsignedUnits from unsignedUnitsIn / campaignCost,
 * unawareUnits from whyNotSwitched. Figures: forecastCustomers over that
 * area's streets with a campaign bought today and without:
 * extraSignups, the splitters they need (splitterCost), (cost +
 * splitterCost) / extra, valueGained = the extra subscriber-months x (what
 * a unit pays there less overhead.perCustomerCost), pays = valueGained >
 * cost + splitterCost.
 */
export function quoteCampaign(state: GameState, cabinet: CabinetId): CampaignQuote {
  const reasons: string[] = [];
  const quote: CampaignQuote = {
    ok: false,
    reasons,
    cabinet,
    cost: 0,
    unsignedUnits: 0,
    unawareUnits: 0,
    extraSignups: 0,
    splitterCost: 0,
    costPerCustomer: null,
    valueGained: 0,
    pays: false,
    availableDay: null,
  };
  if (state.gameOver) reasons.push(`Game over: ${state.gameOver.message}`);
  const found = typeof cabinet === 'number' ? state.network.cabinets.find((c) => c.id === cabinet) : undefined;
  if (!found) {
    reasons.push(`There is no cabinet #${describeValue(cabinet)}`);
    return quote;
  }
  const service = getService(state);
  const area = reasonsIn(state, cabinet).areas.find((a) => a.cabinet === cabinet);
  quote.unsignedUnits = area?.unsigned ?? 0;
  quote.unawareUnits = area?.unaware ?? 0;
  quote.cost = campaignCost(quote.unsignedUnits);
  if (found.stage !== 'live' || !service.activeCabinets.has(cabinet)) reasons.push('That cabinet is not lighting any streets yet');
  else if (!area || area.passings === 0) reasons.push('That cabinet passes no homes yet');
  else if (quote.unsignedUnits === 0) reasons.push('Every home that cabinet passes is already a customer');
  const record = campaignFor(state, cabinet);
  if (record && state.day < record.cooldownUntil) {
    quote.availableDay = record.cooldownUntil;
    reasons.push(state.day < record.endDay ? 'A campaign is already running there' : 'A campaign ran there recently: the area needs a rest first');
  }
  if (reasons.length === 0 && state.finance.cash < quote.cost) {
    reasons.push(`Not enough cash: the campaign costs ${formatMoney(quote.cost)}, you have ${formatMoney(state.finance.cash)}`);
  }
  quote.ok = reasons.length === 0;
  if (area && area.passings > 0 && quote.unsignedUnits > 0 && !(record && state.day < record.endDay)) {
    const without = forecastCustomers(state, { cabinet });
    const withIt = forecastCustomers(state, { cabinet, campaignAt: cabinet });
    const extra = Math.max(0, withIt.signups - without.signups);
    const margin = marginOf(withIt.price, perCustomerCost(state));
    quote.extraSignups = extra;
    quote.splitterCost = extraSplittersCost(state, withIt, without);
    quote.costPerCustomer = extra >= 0.01 ? Math.round((quote.cost + quote.splitterCost) / extra) : null;
    quote.valueGained = Math.max(0, Math.round(((withIt.unitDays - without.unitDays) / DAYS_PER_MONTH) * margin));
    quote.pays = quote.valueGained > quote.cost + quote.splitterCost;
  }
  return quote;
}

/**
 * What support level `level` would do against today's (see SupportQuote).
 * Pure. ok/reasons as setSupport decides (and false once the game is over).
 * costPerMonth and costChange: SUPPORT_LEVELS cost x today's subscribed
 * units. Buckets: happinessReport at that level. Figures: forecastCustomers
 * at that level and at today's over SUPPORT_QUOTE_MONTHS with the outages
 * each street's cable can expect (round 4c/4d fix: `outages`; Great support
 * earns its keep by keeping storm-hit customers, which shows only over
 * years): cancellations and signups a month at that level; netValue = its
 * subscriber-months x its margin (what a unit pays less
 * overhead.perCustomerCost with that level's support cost in place of
 * today's) less today's level's and the splitters it needs more
 * (splitterCost); pays = netValue > 0 (never for today's own level).
 */
export function quoteSupport(state: GameState, level: SupportLevel): SupportQuote {
  const reasons: string[] = [];
  if (state.gameOver) reasons.push(`Game over: ${state.gameOver.message}`);
  if (!isSupportLevel(level)) reasons.push(`The support level is one of ${SUPPORT_LEVEL_IDS.map((l) => SUPPORT_LEVELS[l].name).join(', ')}`);
  const current = state.customers.supportLevel;
  const units = subscriberUnits(state);
  const valid = isSupportLevel(level);
  const spec = valid ? SUPPORT_LEVELS[level] : SUPPORT_LEVELS[current];
  const costPerMonth = Math.round(spec.costPerSub * units);
  const currentCost = Math.round(SUPPORT_LEVELS[current].costPerSub * units);
  const report = happinessReport(state, valid ? level : current);
  // Round 4c/4d fix: over years, with the outages the plant can expect (spec I.4/I.7: Great pays with high outage exposure or long horizons).
  const horizon = { months: SUPPORT_QUOTE_MONTHS, outages: true };
  const at = forecastCustomers(state, { ...horizon, supportLevel: valid ? level : current });
  const quote: SupportQuote = {
    level,
    months: SUPPORT_QUOTE_MONTHS,
    ok: reasons.length === 0,
    reasons,
    costPerMonth,
    costChange: costPerMonth - currentCost,
    happy: report.happy,
    okay: report.okay,
    unhappy: report.unhappy,
    cancellationsPerMonth: at.days > 0 ? at.cancellations / SUPPORT_QUOTE_MONTHS : 0,
    signupsPerMonth: at.days > 0 ? at.signups / SUPPORT_QUOTE_MONTHS : 0,
    splitterCost: 0,
    netValue: 0,
    pays: false,
  };
  if (!valid || level === current) return quote;
  const today = forecastCustomers(state, horizon);
  const perCustomer = perCustomerCost(state);
  const marginAt = marginOf(at.price, perCustomer - SUPPORT_LEVELS[current].costPerSub + spec.costPerSub);
  const marginNow = marginOf(today.price, perCustomer);
  quote.splitterCost = extraSplittersCost(state, at, today);
  quote.netValue = Math.round((at.unitDays * marginAt - today.unitDays * marginNow) / DAYS_PER_MONTH - quote.splitterCost);
  quote.pays = quote.netValue > 0;
  return quote;
}

/**
 * What referral credits `on` (true) or off would do (see ReferralQuote).
 * Pure. ok false only once the game is over or `on` is not a boolean.
 * Figures: forecastCustomers with credits on and off over
 * CUSTOMER_QUOTE_MONTHS. On: referrals a month (the credited share of
 * signups), their credits (2 x REFERRAL_CREDIT each), the extra signups a
 * month, the splitters they need (splitterCost), (credits + splitterCost)
 * per extra customer, and netValue = the extra subscriber-months x the
 * margin (what a unit pays less overhead.perCustomerCost) less the credits
 * and splitterCost. Off: no referrals or credits, netValue the negative of
 * on's.
 */
export function quoteReferrals(state: GameState, on: boolean): ReferralQuote {
  const reasons: string[] = [];
  if (state.gameOver) reasons.push(`Game over: ${state.gameOver.message}`);
  if (typeof on !== 'boolean') reasons.push('Referral credits are on or off');
  const quote: ReferralQuote = { on, ok: reasons.length === 0, reasons, referralsPerMonth: 0, costPerMonth: 0, extraPerMonth: 0, splitterCost: 0, costPerCustomer: null, netValue: 0, pays: false };
  if (typeof on !== 'boolean') return quote;
  const withCredits = forecastCustomers(state, { referrals: true });
  const without = forecastCustomers(state, { referrals: false });
  const credits = withCredits.referrals * 2 * REFERRAL_CREDIT;
  const margin = marginOf(withCredits.price, perCustomerCost(state));
  const splitters = extraSplittersCost(state, withCredits, without);
  const value = ((withCredits.unitDays - without.unitDays) / DAYS_PER_MONTH) * margin - credits - splitters;
  if (on) {
    quote.referralsPerMonth = withCredits.referrals / CUSTOMER_QUOTE_MONTHS;
    quote.costPerMonth = quote.referralsPerMonth * 2 * REFERRAL_CREDIT;
    quote.extraPerMonth = Math.max(0, (withCredits.signups - without.signups) / CUSTOMER_QUOTE_MONTHS);
    quote.splitterCost = splitters;
    quote.costPerCustomer = quote.extraPerMonth >= 0.01 ? Math.round((quote.costPerMonth + splitters / CUSTOMER_QUOTE_MONTHS) / quote.extraPerMonth) : null;
    quote.netValue = Math.round(value);
  } else {
    quote.netValue = Math.round(-value);
  }
  quote.pays = quote.netValue > 0;
  return quote;
}

