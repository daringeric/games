// Pricing and marketing: the three tiers (price, offered), the business price
// multiplier and the monthly marketing budget, with a live preview of what the
// edited values would do (target take rate per building kind, tier mix,
// marketing boost) next to the incumbent's offer. Apply sends setPricing then
// setMarketing; the sim validates both and its reason is shown on a rejection.
//
// Owner: ui-economy workstream.

import {
  INCUMBENT_DOWN_MBPS,
  INCUMBENT_PRICE,
  MARKETING_MAX_PER_MONTH,
  SMB_MULTIPLIER_MAX,
  SMB_MULTIPLIER_MIN,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
} from '../sim/balance';
import { getService } from '../sim/network';
import { marketingBoost, targetTakeRate, tierMix, unitPrice } from '../sim/sales';
import type { ParcelKind, Pricing, TierId, TierSetting } from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el, setText } from './dom';
import { formatMoney, formatNumber, formatPercent } from './format';
import type { Toasts } from './overlays';
import type { GameSession } from './session';

/** What the player has typed: may be out of range or not a number at all (NaN). */
export interface PricingDraft {
  tiers: TierSetting[];
  smbMultiplier: number;
  marketingPerMonth: number;
}

export interface PricingPreview {
  /** Every field is in range and at least one tier is offered (the sim would accept it). */
  valid: boolean;
  /** Plain-language problems with the draft, for the inline hint. */
  problems: string[];
  /** Target take rate by building kind for the draft prices; null while the draft is invalid. */
  takeRate: Record<ParcelKind, number> | null;
  /** Share of new signups per tier for the draft prices; null while the draft is invalid. */
  mix: Record<TierId, number> | null;
  /** Monthly price a business pays per tier at the draft multiplier; null while invalid. */
  smbPrices: Record<TierId, number> | null;
  /** Marketing boost to the signup ramp at `passings` (0.45 = signups 45% faster); null when the budget is invalid. */
  boost: number | null;
}

/** "The incumbent cable company: 300 Mbps for $75/mo" in the panel's words. */
export function incumbentOffer(): string {
  return `Incumbent cable: ${formatNumber(INCUMBENT_DOWN_MBPS)} Mbps for ${formatMoney(INCUMBENT_PRICE)}/mo`;
}

/** The draft matching the game's current pricing and budget. */
export function draftFrom(pricing: Pricing, marketingPerMonth: number): PricingDraft {
  return {
    tiers: pricing.tiers.map((t) => ({ id: t.id, price: t.price, offered: t.offered })),
    smbMultiplier: pricing.smbMultiplier,
    marketingPerMonth,
  };
}

/** A number typed into an input: NaN for an empty or malformed field. */
export function parseNumberField(value: string): number {
  const text = value.trim();
  return text === '' ? Number.NaN : Number(text);
}

const isWhole = (n: number) => Number.isInteger(n);

/**
 * Check a draft the way setPricing/setMarketing will, and preview its effect:
 * target take rates and tier mix from sales.ts for the edited prices (names and
 * speeds from `base`), and the marketing boost at `passings`.
 */
export function pricingPreview(base: Pricing, draft: PricingDraft, passings: number): PricingPreview {
  const tierProblems: string[] = [];
  for (const setting of draft.tiers) {
    const name = base.tiers.find((t) => t.id === setting.id)?.name ?? setting.id;
    if (!isWhole(setting.price) || setting.price < TIER_PRICE_MIN || setting.price > TIER_PRICE_MAX) {
      tierProblems.push(`${name}: price must be a whole number from ${formatMoney(TIER_PRICE_MIN)} to ${formatMoney(TIER_PRICE_MAX)}`);
    }
  }
  if (!draft.tiers.some((t) => t.offered)) tierProblems.push('Offer at least one tier');
  const problems = [...tierProblems];
  const smb = draft.smbMultiplier;
  const smbOk = Number.isFinite(smb) && smb >= SMB_MULTIPLIER_MIN && smb <= SMB_MULTIPLIER_MAX;
  if (!smbOk) problems.push(`Business multiplier must be from ${SMB_MULTIPLIER_MIN} to ${SMB_MULTIPLIER_MAX}`);
  const m = draft.marketingPerMonth;
  const marketingOk = isWhole(m) && m >= 0 && m <= MARKETING_MAX_PER_MONTH;
  if (!marketingOk) problems.push(`Marketing must be a whole number from $0 to ${formatMoney(MARKETING_MAX_PER_MONTH)} a month`);

  const boost = marketingOk ? marketingBoost(m, passings) : null;
  // Take rates and the mix depend only on the tiers.
  if (tierProblems.length > 0) return { valid: false, problems, takeRate: null, mix: null, smbPrices: null, boost };

  const pricing: Pricing = {
    tiers: base.tiers.map((tier) => {
      const setting = draft.tiers.find((t) => t.id === tier.id);
      return setting ? { ...tier, price: setting.price, offered: setting.offered } : tier;
    }),
    smbMultiplier: smbOk ? smb : base.smbMultiplier,
  };
  const takeRate = {
    home: targetTakeRate(pricing, 'home'),
    mdu: targetTakeRate(pricing, 'mdu'),
    smb: targetTakeRate(pricing, 'smb'),
  };
  let smbPrices: Record<TierId, number> | null = null;
  if (smbOk) {
    smbPrices = {} as Record<TierId, number>;
    for (const tier of pricing.tiers) smbPrices[tier.id] = unitPrice(pricing, tier.id, 'smb');
  }
  return { valid: problems.length === 0, problems, takeRate, mix: tierMix(pricing), smbPrices, boost };
}

/** The line under the marketing budget: what it does for signups at today's passings. */
export function boostHint(boost: number | null, marketingPerMonth: number, passings: number): string {
  if (boost === null) return '';
  if (marketingPerMonth <= 0) return 'No marketing: signups come at their natural pace.';
  if (passings <= 0) return 'No homes passed yet: marketing has nobody to sell to, but it is still billed.';
  return `Signups come ${formatPercent(boost)} faster at today's ${formatNumber(passings)} passings.`;
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

/** Open the pricing panel over the game; at most one at a time. */
export class PricingPanel {
  private sheet: Sheet | null = null;

  constructor(
    private readonly session: GameSession,
    private readonly toasts: Toasts,
  ) {}

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  close(): void {
    this.sheet?.close();
  }

  open(): void {
    if (this.sheet?.isOpen) return;
    const state = this.session.state;
    const base = state.sales.pricing;
    const draft = draftFrom(base, state.sales.marketingPerMonth);
    const sheet = openSheet({
      title: 'Pricing & marketing',
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
    const marketingInput = numberInput(draft.marketingPerMonth, {
      min: '0',
      max: String(MARKETING_MAX_PER_MONTH),
      step: '100',
      inputmode: 'numeric',
      'aria-label': 'Marketing budget per month',
      id: 'pricing-marketing',
    });
    const boostLine = el('p', { class: 'field-hint' });
    const takeRates = new Map<ParcelKind, HTMLElement>();
    const preview = el('dl', { class: 'take-rates' });
    for (const [kind, label] of KIND_NAMES) {
      const value = el('span', { class: 'num' });
      takeRates.set(kind, value);
      preview.append(el('div', { class: 'take-rate' }, [el('dt', { text: label }), el('dd', {}, [value])]));
    }
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
        el('label', { class: 'field-label', text: 'Marketing', attrs: { for: 'pricing-marketing' } }),
        el('span', { class: 'money-field' }, [el('span', { text: '$', attrs: { 'aria-hidden': 'true' } }), marketingInput, el('span', { class: 'per', text: '/mo' })]),
      ]),
      boostLine,
      el('section', { class: 'preview', attrs: { 'aria-label': 'Target take rate' } }, [el('h3', { text: 'Target take rate' }), preview]),
      problems,
      error,
    );

    const passings = getService(state).passings;
    const read = (): PricingDraft => ({
      tiers: rows.map((r) => ({ id: r.id, price: parseNumberField(r.price.value), offered: r.offered.checked })),
      smbMultiplier: parseNumberField(smbInput.value),
      marketingPerMonth: parseNumberField(marketingInput.value),
    });
    const refresh = () => {
      const now = read();
      const p = pricingPreview(base, now, passings);
      for (const row of rows) {
        const setting = now.tiers.find((t) => t.id === row.id) as TierSetting;
        const bad = !Number.isInteger(setting.price) || setting.price < TIER_PRICE_MIN || setting.price > TIER_PRICE_MAX;
        row.price.setAttribute('aria-invalid', String(bad));
        setText(row.mix, p.mix && row.offered.checked ? formatPercent(p.mix[row.id]) : '–');
        setText(row.smb, p.smbPrices ? `Business ${formatMoney(p.smbPrices[row.id])}/mo` : '');
      }
      smbInput.setAttribute('aria-invalid', String(!Number.isFinite(now.smbMultiplier) || now.smbMultiplier < SMB_MULTIPLIER_MIN || now.smbMultiplier > SMB_MULTIPLIER_MAX));
      marketingInput.setAttribute('aria-invalid', String(p.boost === null));
      for (const [kind, value] of takeRates) setText(value, p.takeRate ? formatPercent(p.takeRate[kind]) : '–');
      setText(boostLine, boostHint(p.boost, now.marketingPerMonth, passings));
      setText(problems, p.problems.join('. '));
      problems.hidden = p.problems.length === 0;
    };
    sheet.body.addEventListener('input', () => {
      error.hidden = true;
      refresh();
    });
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
      const priced = this.session.dispatch({ type: 'setPricing', tiers: now.tiers, smbMultiplier: now.smbMultiplier });
      if (!priced.ok) {
        fail(`Pricing not changed: ${priced.reason}`);
        return;
      }
      const marketed = this.session.dispatch({ type: 'setMarketing', perMonth: now.marketingPerMonth });
      if (!marketed.ok) {
        fail(`Prices updated, but the marketing budget was not: ${marketed.reason}`);
        return;
      }
      sheet.close();
      this.toasts.show(`Pricing updated; marketing ${formatMoney(now.marketingPerMonth)}/mo`, true);
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
