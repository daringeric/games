// Rate card: what everything costs, straight from balance.ts, so the player
// can plan a build before quoting it, and (round 3) what borrowing costs.
//
// Owner: ui-economy workstream.

import {
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
  OVERHEAD_PER_MONTH,
  PERMIT_FEE_AERIAL,
  PENALTY_STEP_UP_BPS,
  PERMIT_FEE_UNDERGROUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  POLE_SPACING_FT,
  SPLIT_RATIO,
  SPLITTER_COST,
  SUPPORT_COST_PER_SUB_PER_MONTH,
  TERM_CAPACITY_ARR_MULTIPLE,
  TERM_EXTRA_BPS,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
  UNDERWRITING_MIN_MARGIN,
} from '../sim/balance';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el } from './dom';
import { formatMultiple } from './bankPanel';
import { formatBpsDelta, formatFeet, formatMoney, formatNumber, formatPercent, formatPerFt, formatRate, formatRatio, plural } from './format';

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
    {
      title: 'Running costs',
      rows: [
        { label: 'Overhead', value: `${formatMoney(OVERHEAD_PER_MONTH)}/mo`, note: 'Network operations, billing, office' },
        { label: 'Customer support', value: `${formatMoney(SUPPORT_COST_PER_SUB_PER_MONTH)}/mo`, note: 'Per subscriber' },
        { label: 'Pole rent', value: `${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}/mo`, note: 'Per pole carrying your cable' },
      ],
    },
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
  ];
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
      value: `${formatMultiple(CREDIT_LIMIT_ARR_MULTIPLE)} ARR`,
      note: 'Annual recurring revenue of your last closed months',
    },
    {
      label: 'Term loan capacity',
      value: `${formatMultiple(TERM_CAPACITY_ARR_MULTIPLE)} ARR`,
      note: `Less the term loans you owe; at least ${formatMoney(TERM_LOAN_MIN)} a loan`,
    },
    { label: 'Terms', value: TERM_LOAN_YEARS.map((y) => `${y}`).join(' or ') + ' years', note: 'Level monthly payments of principal and interest' },
    {
      label: 'Leverage covenant',
      value: `max ${formatRatio(COVENANT_MAX_LEVERAGE)}`,
      note: `Cash flow counted: yearly operating cash flow, or ${formatPercent(UNDERWRITING_MIN_MARGIN)} of ARR if that is more`,
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
