// Rate card: what everything costs, straight from balance.ts, so the player
// can plan a build before quoting it.
//
// Owner: ui-economy workstream.

import {
  AERIAL_COST_PER_FT,
  CABINET_COST,
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  CPP_AMBER_MULTIPLIER,
  CPP_TARGET,
  ENGINEERING_FEE,
  INSTALL_COST_HOME,
  INSTALL_COST_MDU_UNIT,
  INSTALL_COST_SMB,
  MAKE_READY_COST_PER_POLE,
  MDU_ROUTER_COST,
  OLT_CARD_COST,
  OLT_PORTS_PER_CARD,
  OVERHEAD_PER_MONTH,
  PERMIT_FEE_AERIAL,
  PERMIT_FEE_UNDERGROUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  POLE_SPACING_FT,
  SPLIT_RATIO,
  SPLITTER_COST,
  SUPPORT_COST_PER_SUB_PER_MONTH,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
} from '../sim/balance';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el } from './dom';
import { formatFeet, formatMoney, formatNumber, formatPerFt, plural } from './format';

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
        { label: 'Building router', value: formatMoney(MDU_ROUTER_COST), note: 'Once per apartment building, on one splitter port' },
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
  ];
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
