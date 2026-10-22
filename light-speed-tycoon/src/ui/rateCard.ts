// Rate card: what everything costs, straight from balance.ts, so the player
// can plan a build before quoting it, (round 3) what borrowing costs, and
// (round 4) the rules of storms, pricing and a frozen credit line, and
// (round 4c/4d) the running costs that grow with the company: the base, per
// customer (each support level's cost), per cabinet and per mile of cable.
//
// Owner: ui-economy workstream; round 4c/4d's running costs: ui-summary workstream.

import {
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  ARR_SPIKE_CAP,
  DIG_INS_PER_MILE_PER_YEAR,
  FROZEN_ACCELERATION_CLOSES,
  FROZEN_SWEEP_RESERVE,
  FROZEN_SWEEP_SHARE,
  FUNDING_CUSHION_MONTHS,
  GRANDFATHER_MONTHS_DEFAULT,
  GRANDFATHER_MONTHS_MAX,
  GRANDFATHER_STEP_SHARE,
  INCUMBENT_PROMO_CHURN,
  INCUMBENT_PROMO_DISCOUNT,
  INCUMBENT_PROMO_MIN_PASSINGS,
  INCUMBENT_PROMO_MONTHS,
  INCUMBENT_PROMO_QUIET_MONTHS,
  INCUMBENT_PROMO_TAKE_RATE,
  OUTAGE_CHURN_BASE,
  OUTAGE_CHURN_MAX,
  OUTAGE_CHURN_PER_DAY,
  OUTAGE_DAYS_AERIAL_MAX,
  OUTAGE_DAYS_AERIAL_MIN,
  OUTAGE_DAYS_UNDERGROUND_MAX,
  OUTAGE_DAYS_UNDERGROUND_MIN,
  PRICE_STEP_CHURN_MAX,
  PRICE_STEP_CHURN_PER_RISE,
  PROMO_MAX_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  PROMO_STEP_SHARE,
  REPAIR_BASE_AERIAL,
  REPAIR_BASE_UNDERGROUND,
  REPAIR_PER_FT_AERIAL,
  REPAIR_PER_FT_UNDERGROUND,
  STORM_AERIAL_DAMAGE_CHANCE,
  STORM_CHANCE_PER_DAY,
  STORM_SEVERITY_MAX,
  STORM_START_DAY,
  STORM_UNDERGROUND_DAMAGE_CHANCE,
  TIER_RETIRE_CHURN_BASE,
  TIER_RETIRE_CHURN_MAX,
  TIER_RETIRE_CHURN_PER_RISE,
  AERIAL_COST_PER_FT,
  CABINET_COST,
  CABINET_REACH_FT,
  BASE_RATE_BPS,
  CABINET_START_SPLITTERS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  CREDIT_LIMIT_ARR_MULTIPLE,
  CREDIT_LINE_EXTRA_BPS,
  ENGINEERING_FEE,
  INSTALL_COST_HOME,
  INSTALL_COST_MDU_UNIT,
  INSTALL_COST_SMB,
  LATE_FEE_MIN,
  LATE_FEE_SHARE,
  LEVERAGE_SPREAD_BANDS,
  LEVERAGE_SPREAD_MAX_BPS,
  MAKE_READY_COST_PER_POLE,
  MDU_PORTS_PER_BUILDING,
  MDU_ROUTER_COST,
  OLT_CARD_COST,
  OLT_PORTS_PER_CARD,
  OVERHEAD_BASE_PER_MONTH,
  OVERHEAD_PER_CABINET_PER_MONTH,
  OVERHEAD_PER_CUSTOMER_PER_MONTH,
  OVERHEAD_PER_MILE_PER_MONTH,
  PERMIT_FEE_AERIAL,
  PENALTY_STEP_UP_BPS,
  PERMIT_FEE_UNDERGROUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  POLE_SPACING_FT,
  SPLIT_RATIO,
  SPLITTER_COST,
  SUPPORT_LEVELS,
  TERM_CAPACITY_ARR_MULTIPLE,
  TERM_EXTRA_BPS,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
  UNDERWRITING_MIN_MARGIN,
  STORM_EXPOSURE_CANOPY,
  REPAIR_CANOPY_SHARE,
  OUTAGE_DAYS_CANOPY,
  CAMPAIGN_COST_PER_UNIT,
  CAMPAIGN_COST_MIN,
  CAMPAIGN_DAYS,
  CAMPAIGN_FADE_DAYS,
  CAMPAIGN_COOLDOWN_DAYS,
  REFERRAL_CREDIT,
  REFERRAL_WOM_MULTIPLIER,
  PROMO_BOOST_YOUNG_MONTHS,
} from '../sim/balance';
import { formatDate } from '../sim/calendar';
import type { SupportLevel } from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el } from './dom';
import { formatMultiple } from './bankPanel';
import {
  formatBpsDelta,
  formatDayRange,
  formatFeet,
  formatMoney,
  formatNumber,
  formatOdds,
  formatPercent,
  formatPercentFine,
  formatPerFt,
  formatRate,
  formatRatio,
  plural,
} from './format';

export interface RateRow {
  label: string;
  value: string;
  /** Small print under the label. */
  note?: string;
  /** Color swatch for the cost-per-passing bands. */
  band?: 'green' | 'amber' | 'red';
}

export interface RateSection {
  title: string;
  rows: RateRow[];
}

/** The rate card's content, from balance.ts. */
export function rateCardSections(): RateSection[] {
  const amber = CPP_TARGET * CPP_AMBER_MULTIPLIER;
  return [
    {
      title: 'Cable',
      rows: [
        { label: 'Aerial strand and lash', value: formatPerFt(AERIAL_COST_PER_FT), note: 'Needs poles; make-ready extra' },
        {
          label: 'Aerial with make-ready',
          value: `≈ ${formatPerFt(AERIAL_COST_PER_FT + MAKE_READY_COST_PER_POLE / POLE_SPACING_FT)}`,
          note: `A pole every ${formatFeet(POLE_SPACING_FT)}`,
        },
        { label: 'Underground bore', value: formatPerFt(UNDERGROUND_COST_PER_FT), note: 'Any street, no poles needed' },
        { label: 'Rock surcharge', value: `+${formatPerFt(UNDERGROUND_ROCK_SURCHARGE_PER_FT)}`, note: 'Underground through rocky ground' },
      ],
    },
    {
      title: 'Per order and per pole',
      rows: [
        { label: 'Make-ready', value: `${formatMoney(MAKE_READY_COST_PER_POLE)} per pole`, note: 'Aerial: utility work on each pole' },
        { label: 'Engineering', value: `${formatMoney(ENGINEERING_FEE)} per order`, note: 'Every cable order' },
        { label: 'Pole attachment application', value: `${formatMoney(PERMIT_FEE_AERIAL)} per order`, note: 'Aerial orders' },
        { label: 'City excavation permit', value: `${formatMoney(PERMIT_FEE_UNDERGROUND)} per order`, note: 'Underground orders' },
      ],
    },
    {
      title: 'Equipment',
      rows: [
        {
          label: 'Cabinet',
          value: formatMoney(CABINET_COST),
          note: `Plus ${plural(CABINET_START_SPLITTERS, 'starter splitter')}; passes homes within ${formatFeet(CABINET_REACH_FT)} along cable`,
        },
        { label: `Splitter (1:${SPLIT_RATIO})`, value: formatMoney(SPLITTER_COST), note: `${formatNumber(SPLIT_RATIO)} subscriber ports; uses one OLT PON port` },
        { label: 'OLT line card', value: formatMoney(OLT_CARD_COST), note: `+${formatNumber(OLT_PORTS_PER_CARD)} PON ports at the CO` },
        { label: 'Cabinet reach', value: formatFeet(CABINET_REACH_FT), note: 'Measured along live cable' },
      ],
    },
    {
      title: 'Connections',
      rows: [
        { label: 'Home install', value: formatMoney(INSTALL_COST_HOME), note: 'Drop, ONT and install' },
        { label: 'Business install', value: formatMoney(INSTALL_COST_SMB), note: 'Drop, ONT and install for a shop or office' },
        { label: 'Apartment unit', value: formatMoney(INSTALL_COST_MDU_UNIT), note: 'Each subscribing apartment' },
        {
          label: 'Building router',
          value: formatMoney(MDU_ROUTER_COST),
          note: `Once per apartment building; the whole building rides on ${plural(MDU_PORTS_PER_BUILDING, 'splitter port')}`,
        },
      ],
    },
    runningCostsSection(),
    customersSection(),
    {
      title: 'Cost per passing',
      rows: [
        { label: 'Target', value: formatMoney(CPP_TARGET), note: 'Outside-plant spend per home passed' },
        { label: 'Green', value: `up to ${formatMoney(CPP_TARGET)}`, band: 'green' },
        { label: 'Amber', value: `up to ${formatMoney(amber)}`, band: 'amber' },
        { label: 'Red', value: `above ${formatMoney(amber)}`, band: 'red' },
      ],
    },
    financingSection(),
    frozenLineSection(),
    stormSection(),
    pricingSection(),
  ];
}

/** The default support level (the one a new company starts with). */
const DEFAULT_SUPPORT: SupportLevel = 'good';

/** Support levels in the order the Customers dashboard lists them. */
const SUPPORT_ORDER: readonly SupportLevel[] = ['basic', 'good', 'great'];

/** "$100/mo", keeping cents when a rate has them ("$12.50/mo"). */
function perMonth(amount: number): string {
  const whole = Math.round(amount) === amount;
  return whole ? `${formatMoney(amount)}/mo` : `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/mo`;
}

/**
 * Round 4c/4d: what running the company costs each month, from balance.ts:
 * a small base, then costs that grow with it (per customer, with each
 * support level's cost on top; per live cabinet; per mile of live cable),
 * and pole rent.
 */
export function runningCostsSection(): RateSection {
  return {
    title: 'Running costs',
    rows: [
      { label: 'Base overhead', value: perMonth(OVERHEAD_BASE_PER_MONTH), note: 'Office, billing system and network operations, at any size' },
      {
        label: 'Per customer',
        value: perMonth(OVERHEAD_PER_CUSTOMER_PER_MONTH),
        note: 'Billing and accounts for each subscriber, plus the support level below',
      },
      ...SUPPORT_ORDER.map((id) => {
        const level = SUPPORT_LEVELS[id];
        return {
          label: `${level.name} support`,
          value: perMonth(level.costPerSub),
          note: `Per subscriber${id === DEFAULT_SUPPORT ? ' (where every company starts)' : ''}; set it on the Customers dashboard`,
        };
      }),
      { label: 'Per cabinet', value: perMonth(OVERHEAD_PER_CABINET_PER_MONTH), note: 'Each live cabinet: power, cooling and inspections' },
      {
        label: 'Per mile of cable',
        value: perMonth(OVERHEAD_PER_MILE_PER_MONTH),
        note: 'Each route-mile of live cable (5,280 ft): locates, patrols and plant records',
      },
      { label: 'Pole rent', value: perMonth(POLE_RENT_PER_POLE_PER_MONTH), note: 'Per pole carrying your cable' },
    ],
  };
}

/** "about 2 months" for a number of days (the customers section's campaign lengths). */
function aboutMonths(days: number): string {
  return `about ${plural(Math.max(1, Math.round(days / 30.4)), 'month')}`;
}

/**
 * Round 4c/4d: the customer levers' prices and rules, from balance.ts:
 * neighborhood campaigns, referral credits and the intro promo's reach
 * (the support levels are in Running costs).
 */
export function customersSection(): RateSection {
  return {
    title: 'Customers',
    rows: [
      {
        label: 'Neighborhood campaign',
        value: `${formatMoney(CAMPAIGN_COST_PER_UNIT)} a home`,
        note: `Per home not signed up in a cabinet's area, at least ${formatMoney(CAMPAIGN_COST_MIN)}; set it on the Customers dashboard`,
      },
      {
        label: 'Campaign length',
        value: aboutMonths(CAMPAIGN_DAYS),
        note: `At full strength, then it fades over ${aboutMonths(CAMPAIGN_FADE_DAYS)}; the area then rests ${aboutMonths(CAMPAIGN_COOLDOWN_DAYS)} before the next one`,
      },
      {
        label: 'Referral credit',
        value: `${formatMoney(REFERRAL_CREDIT)} off, both sides`,
        note: `For the customer who refers and the neighbor who joins; word of mouth works ${formatNumber(REFERRAL_WOM_MULTIPLIER)} times as hard while it's on`,
      },
      {
        label: 'Intro promo reach',
        value: `streets lit within ${plural(PROMO_BOOST_YOUNG_MONTHS, 'month')}`,
        note: "It speeds up switching there and where the cable company runs a promo; elsewhere it mostly discounts people who'd join anyway",
      },
    ],
  };
}

/** A price rise of this share is how the rate card quotes per-rise churn ("4% per 10% rise"). */
const RISE_STEP = 0.1;

/** Round 4: storms, dig-ins, outages and repairs, from balance.ts. */
export function stormSection(): RateSection {
  return {
    title: 'Storms and dig-ins',
    rows: [
      { label: 'Storm season', value: `from ${formatDate(STORM_START_DAY)}`, note: 'The first year is calm, for building' },
      {
        label: 'Storm chance',
        value: `${formatOdds(STORM_CHANCE_PER_DAY)} a day`,
        note: `Each storm hits one area of the map, severity 1–${formatNumber(STORM_SEVERITY_MAX)}`,
      },
      { label: 'Aerial span damaged', value: `${formatPercentFine(STORM_AERIAL_DAMAGE_CHANCE)} per severity`, note: 'Each live aerial span in the storm area' },
      {
        label: 'Underground span damaged',
        value: `${formatPercentFine(STORM_UNDERGROUND_DAMAGE_CHANCE)} per severity`,
        note: 'Washouts are rare: buried cable rides out storms',
      },
      {
        label: 'Dig-ins',
        value: `${DIG_INS_PER_MILE_PER_YEAR.toLocaleString('en-US', { maximumFractionDigits: 2 })} a year per mile`,
        note: 'An excavator cuts live underground cable (5,280 ft to the mile)',
      },
      { label: 'Aerial outage', value: formatDayRange(OUTAGE_DAYS_AERIAL_MIN, OUTAGE_DAYS_AERIAL_MAX), note: 'A damaged aerial span is out this long' },
      {
        label: 'Tree-lined streets',
        value: `up to ${formatNumber(1 + STORM_EXPOSURE_CANOPY)} times the storm damage`,
        note:
          `Aerial cable under old street trees: falling limbs do most storm damage, repairs cost up to ${formatNumber(1 + REPAIR_CANOPY_SHARE)} times as much, ` +
          `and outages last ${formatDayRange(Math.min(OUTAGE_DAYS_AERIAL_MAX, OUTAGE_DAYS_AERIAL_MIN + OUTAGE_DAYS_CANOPY), OUTAGE_DAYS_AERIAL_MAX)}. Buried cable there pays back`,
      },
      {
        label: 'Underground outage',
        value: formatDayRange(OUTAGE_DAYS_UNDERGROUND_MIN, OUTAGE_DAYS_UNDERGROUND_MAX),
        note: 'Digging down to the break takes longer',
      },
      { label: 'Aerial repair', value: `${formatMoney(REPAIR_BASE_AERIAL)} + ${formatPerFt(REPAIR_PER_FT_AERIAL)}`, note: 'Per damaged span, by its length' },
      {
        label: 'Underground repair',
        value: `${formatMoney(REPAIR_BASE_UNDERGROUND)} + ${formatPerFt(REPAIR_PER_FT_UNDERGROUND)}`,
        note: 'Per damaged span, by its length',
      },
      {
        label: 'Outage churn',
        value: `${formatPercentFine(OUTAGE_CHURN_BASE)} + ${formatPercentFine(OUTAGE_CHURN_PER_DAY)} a day out`,
        note: `Extra cancellations at the close among subscribers who lost service (the base once per outage), at most ${formatPercent(OUTAGE_CHURN_MAX)}`,
      },
    ],
  };
}

/** Round 4: price rises, price locks, retired tiers, intro promos and the incumbent's promos, from balance.ts. */
export function pricingSection(): RateSection {
  return {
    title: 'Pricing',
    rows: [
      {
        label: 'Price lock on a rise',
        value: plural(GRANDFATHER_MONTHS_DEFAULT, 'month'),
        note: `Today's subscribers keep their price this long (you can choose 0–${formatNumber(GRANDFATHER_MONTHS_MAX)}); new subscribers pay the new price; cuts reach everyone at once`,
      },
      {
        label: 'Price-step churn',
        value: `${formatPercentFine(PRICE_STEP_CHURN_PER_RISE * RISE_STEP)} per ${formatPercent(RISE_STEP)} rise`,
        note: `Cancellations when a higher price reaches subscribers, at most ${formatPercent(PRICE_STEP_CHURN_MAX)}`,
      },
      { label: 'After a price lock', value: `${formatPercent(GRANDFATHER_STEP_SHARE)} of that`, note: 'Grandfathered subscribers take a rise better' },
      { label: 'After an intro promo', value: `${formatPercent(PROMO_STEP_SHARE)} of that`, note: 'When a new subscriber’s promo price ends' },
      {
        label: 'Retired tier churn',
        value: `${formatPercentFine(TIER_RETIRE_CHURN_BASE)} + ${formatPercentFine(TIER_RETIRE_CHURN_PER_RISE * RISE_STEP)} per ${formatPercent(RISE_STEP)} dearer`,
        note: `Subscribers on a tier you stop offering move to the nearest-priced tier at the next close; at most ${formatPercent(TIER_RETIRE_CHURN_MAX)} cancel`,
      },
      {
        label: 'Intro promo',
        value: `up to ${formatNumber(PROMO_MAX_PERCENT_OFF)}% off`,
        note: `For new signups, for up to ${plural(PROMO_MAX_MONTHS, 'month')}`,
      },
      {
        label: 'Incumbent promo trigger',
        value: `${formatPercent(INCUMBENT_PROMO_TAKE_RATE)} take rate`,
        note: `In a cabinet area with at least ${plural(INCUMBENT_PROMO_MIN_PASSINGS, 'passing')}`,
      },
      {
        label: 'Incumbent promo',
        value: `${formatMoney(INCUMBENT_PROMO_DISCOUNT)} off for ${plural(INCUMBENT_PROMO_MONTHS, 'month')}`,
        note: `Lowers your target take rate there; then quiet there for ${plural(INCUMBENT_PROMO_QUIET_MONTHS, 'month')}`,
      },
      {
        label: 'Incumbent promo churn',
        value: `+${formatPercentFine(INCUMBENT_PROMO_CHURN)} a month`,
        note: 'For your subscribers in that area while the promo runs',
      },
    ],
  };
}

/** Round 4: a frozen credit line's sweep and the loans being called, and the lending rules around them, from balance.ts. */
export function frozenLineSection(): RateSection {
  return {
    title: 'Frozen line and loan rules',
    rows: [
      {
        label: 'Frozen sweep',
        value: `${formatPercent(FROZEN_SWEEP_SHARE)} of cash flow`,
        note: `Each frozen close repays debt with this share of the month's positive operating cash flow, never taking cash below ${formatMoney(FROZEN_SWEEP_RESERVE)}`,
      },
      {
        label: 'Loans called',
        value: `after ${plural(FROZEN_ACCELERATION_CLOSES, 'frozen close')}`,
        note: `In a row. Then everything owed falls due over ${plural(ACCELERATION_CLOSES, 'close')}, and a close that cannot pay is a default`,
      },
      { label: 'Call warning', value: `${plural(ACCELERATION_WARNING_CLOSES, 'close')} ahead`, note: 'A notice before the bank calls the loans' },
      {
        label: 'Lending ARR cap',
        value: `${formatMultiple(ARR_SPIKE_CAP)} weakest month`,
        note: 'Trailing revenue counts for at most this much of its weakest month, so a price spike cannot inflate what the bank lends',
      },
      {
        label: 'Funding cushion',
        value: plural(FUNDING_CUSHION_MONTHS, 'month'),
        note: 'Of fixed costs (plus the next payment) that financing hints and cure advice leave in cash',
      },
    ],
  };
}

/** Borrowing: rates and their parts, limits, covenants and fees, from balance.ts. */
export function financingSection(): RateSection {
  const amber = CPP_TARGET * CPP_AMBER_MULTIPLIER;
  const rows: RateRow[] = [
    { label: 'Base rate', value: `${formatRate(BASE_RATE_BPS)} a year`, note: 'Every loan starts here; spreads add to it' },
    { label: 'Credit line premium', value: formatBpsDelta(CREDIT_LINE_EXTRA_BPS), note: 'Draw and repay any time; the rate floats, re-priced each month close' },
    ...TERM_LOAN_YEARS.map((years) => ({
      label: `${years}-year term premium`,
      value: formatBpsDelta(TERM_EXTRA_BPS[years]),
      note: 'Fixed for the life of the loan',
    })),
  ];
  let from = 0;
  for (const band of LEVERAGE_SPREAD_BANDS) {
    rows.push({
      label: from === 0 ? `Leverage up to ${formatRatio(band.maxLeverage)}` : `Leverage ${formatRatio(from)}–${formatRatio(band.maxLeverage)}`,
      value: formatBpsDelta(band.spreadBps),
      note: from === 0 ? 'Debt over the cash flow the bank counts' : undefined,
    });
    from = band.maxLeverage;
  }
  rows.push(
    { label: `Leverage above ${formatRatio(from)}`, value: formatBpsDelta(LEVERAGE_SPREAD_MAX_BPS), note: 'Or when there is no cash flow to measure it against' },
    { label: 'Cost per passing: green', value: formatBpsDelta(CPP_SPREAD_BPS.green), note: `Up to ${formatMoney(CPP_TARGET)}; nothing passed yet pays none`, band: 'green' },
    { label: 'Cost per passing: amber', value: formatBpsDelta(CPP_SPREAD_BPS.amber), note: `Up to ${formatMoney(amber)}`, band: 'amber' },
    { label: 'Cost per passing: red', value: formatBpsDelta(CPP_SPREAD_BPS.red), note: `Above ${formatMoney(amber)}`, band: 'red' },
    { label: 'Penalty rate', value: formatBpsDelta(PENALTY_STEP_UP_BPS), note: 'On every balance after repeated covenant breaches, until cured' },
    {
      label: 'Credit limit',
      value: `${formatMultiple(CREDIT_LIMIT_ARR_MULTIPLE)} lending ARR`,
      note: 'Lending ARR: annual recurring revenue of your last closed months, smoothed',
    },
    {
      label: 'Term loan capacity',
      value: `${formatMultiple(TERM_CAPACITY_ARR_MULTIPLE)} lending ARR`,
      note: `Less the term loans you owe; at least ${formatMoney(TERM_LOAN_MIN)} a loan`,
    },
    { label: 'Terms', value: TERM_LOAN_YEARS.map((y) => `${y}`).join(' or ') + ' years', note: 'Level monthly payments of principal and interest' },
    {
      label: 'Leverage covenant',
      value: `max ${formatRatio(COVENANT_MAX_LEVERAGE)}`,
      note: `Cash flow counted: yearly operating cash flow (storm repairs at their past-year total), or ${formatPercent(UNDERWRITING_MIN_MARGIN)} of lending ARR if that is more`,
    },
    { label: 'Coverage covenant', value: `min ${formatRatio(COVENANT_MIN_COVERAGE)}`, note: 'That cash flow over the next 12 months of debt service' },
    {
      label: 'Cure',
      value: plural(COVENANT_CURE_CLOSES, 'close'),
      note: 'Compliant month closes in a row step back one stage: warning, penalty rate, frozen',
    },
    {
      label: 'Late fee',
      value: `${formatPercent(LATE_FEE_SHARE)}, min ${formatMoney(LATE_FEE_MIN)}`,
      note: 'Of a missed payment; it freezes the credit line. Missed while frozen: default',
    },
  );
  return { title: 'Financing', rows };
}

export class RateCard {
  private sheet: Sheet | null = null;

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  close(): void {
    this.sheet?.close();
  }

  open(): void {
    if (this.sheet?.isOpen) return;
    const sheet = openSheet({
      title: 'Rate card',
      subtitle: 'What everything costs. Quotes itemize these for each order.',
      className: 'rate-card',
      onClose: () => {
        if (this.sheet === sheet) this.sheet = null;
      },
    });
    this.sheet = sheet;
    for (const section of rateCardSections()) {
      sheet.body.append(
        el('section', { class: 'rate-section' }, [
          el('h3', { text: section.title }),
          el(
            'dl',
            {},
            section.rows.map((row) =>
              el('div', { class: 'rate-row' }, [
                el('dt', {}, [
                  row.band ? el('span', { class: `band-swatch cpp-bg-${row.band}`, attrs: { 'aria-hidden': 'true' } }) : null,
                  el('span', { text: row.label }),
                  row.note ? el('small', { text: row.note }) : null,
                ]),
                el('dd', { class: 'num', text: row.value }),
              ]),
            ),
          ),
        ]),
      );
    }
    sheet.dialog.querySelector<HTMLButtonElement>('.sheet-close')?.focus();
  }
}
