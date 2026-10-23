// The pricing panel's pure model (pricingPanel.ts): draft checks and the
// preview of take rates, tier mix and business prices. Moved out of
// economy.test.ts by the round-4 contract. Round 4c/4d: the marketing budget
// moved to the Customers dashboard (its checks and forecast lines are in
// customersPanel.test.ts); here it is a read-only line, and the impact
// figures' "after" counts the expected cancellations (spec C). Money is
// checked against balance.ts constants and sim results, never literal dollar
// amounts.

import { describe, expect, it } from 'vitest';
import {
  GRANDFATHER_MONTHS_DEFAULT,
  GRANDFATHER_MONTHS_MAX,
  GRANDFATHER_STEP_SHARE,
  DEMAND_SEGMENTS,
  RETENTION_PERCENT_OFF,
  INCUMBENT_DOWN_MBPS,
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_DISCOUNT,
  PROMO_MAX_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  SMB_MULTIPLIER_MAX,
  SMB_MULTIPLIER_MIN,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
} from '../sim/balance';
import { formatDate } from '../sim/calendar';
import { applyCommand, newGame } from '../sim/game';
import { quoteRetention, reviewIncumbent } from '../sim/incumbent';
import {
  defaultPricing,
  lockEndDay,
  monthlyRecurringRevenue,
  promoPrice,
  promoQuoteMonths,
  quotePricing,
  quotePromo,
  reservationPrice,
  roughMoney,
  segmentDemand,
  stepChurnProbability,
  targetTakeRate,
  tierMix,
  unitPrice,
} from '../sim/sales';
import { cornerName } from '../sim/streets';
import { addLivePlant, makeGridCity, makeTestState } from '../sim/testing/fixtures';
import type { Account, CabinetId, GameState, TierId, TierSetting } from '../sim/types';
import { formatMoney, formatPercent } from './format';
import {
  draftFrom,
  draftPromo,
  grandfatherHint,
  impactFigures,
  incumbentLine,
  incumbentOffer,
  incumbentRows,
  marketingLine,
  parseNumberField,
  pricingImpact,
  pricingPreview,
  PROMO_DRAFT_START,
  promoAdviceLine,
  promoHint,
  retentionButton,
  retentionLine,
  samePromo,
  SEGMENT_LABELS,
  segmentRows,
} from './pricingPanel';
import type { PricingDraft } from './pricingPanel';

describe('pricing preview', () => {
  const pricing = defaultPricing();
  const draft = (edit: (d: PricingDraft) => void = () => {}): PricingDraft => {
    const d = draftFrom(pricing);
    edit(d);
    return d;
  };

  it('previews the take rate, tier mix and business prices of the edited values', () => {
    const d = draft((x) => {
      x.tiers[1]!.price = TIER_PRICE_MIN + 10;
      x.smbMultiplier = SMB_MULTIPLIER_MAX;
    });
    const edited = { ...pricing, smbMultiplier: SMB_MULTIPLIER_MAX, tiers: pricing.tiers.map((t, i) => (i === 1 ? { ...t, price: TIER_PRICE_MIN + 10 } : t)) };
    const p = pricingPreview(pricing, d);
    expect(p.valid).toBe(true);
    expect(p.problems).toEqual([]);
    expect(p.takeRate).toEqual({ home: targetTakeRate(edited, 'home'), mdu: targetTakeRate(edited, 'mdu'), smb: targetTakeRate(edited, 'smb') });
    expect(p.mix).toEqual(tierMix(edited));
    expect(p.smbPrices).toEqual({
      fiber500: unitPrice(edited, 'fiber500', 'smb'),
      fiber1g: unitPrice(edited, 'fiber1g', 'smb'),
      fiber2g: unitPrice(edited, 'fiber2g', 'smb'),
    });
    // A cheaper gig tier raises the target take rate.
    expect(p.takeRate!.home).toBeGreaterThan(targetTakeRate(pricing, 'home'));
  });

  it('lowers the business take rate as the business multiplier rises, leaving households alone', () => {
    const at = (m: number) => pricingPreview(pricing, draft((x) => (x.smbMultiplier = m))).takeRate!;
    const low = at(SMB_MULTIPLIER_MIN);
    const high = at(SMB_MULTIPLIER_MAX);
    expect(high.smb).toBeLessThan(low.smb);
    expect(high.home).toBe(low.home);
    expect(high.mdu).toBe(low.mdu);
  });

  it('flags an out-of-range or missing price and previews nothing for the tiers', () => {
    for (const bad of [TIER_PRICE_MAX + 1, TIER_PRICE_MIN - 1, 55.5, Number.NaN]) {
      const p = pricingPreview(pricing, draft((x) => (x.tiers[0]!.price = bad)));
      expect(p.valid).toBe(false);
      expect(p.problems[0]).toContain('500 Mbps');
      expect(p.takeRate).toBeNull();
      expect(p.mix).toBeNull();
      expect(p.smbPrices).toBeNull();
    }
  });

  it('needs at least one tier offered', () => {
    const p = pricingPreview(pricing, draft((x) => x.tiers.forEach((t) => (t.offered = false))));
    expect(p.valid).toBe(false);
    expect(p.problems).toContain('Offer at least one tier');
  });

  it('keeps the take-rate preview when only the multiplier is wrong', () => {
    const smb = pricingPreview(pricing, draft((x) => (x.smbMultiplier = SMB_MULTIPLIER_MAX + 1)));
    expect(smb.valid).toBe(false);
    expect(smb.takeRate).not.toBeNull();
    expect(smb.smbPrices).toBeNull();
  });

  // The marketing half of the old check (setMarketing) moved with the budget: customersPanel.test.ts checks
  // marketingProblem against setMarketing over the same budgets.
  it('calls a draft valid exactly when the sim accepts setPricing', () => {
    const prices = [TIER_PRICE_MIN - 1, TIER_PRICE_MIN, 64, TIER_PRICE_MAX, TIER_PRICE_MAX + 1, 70.5, Number.NaN];
    const multipliers = [0.5, 1, 1.25, SMB_MULTIPLIER_MAX, SMB_MULTIPLIER_MAX + 0.01, Number.NaN];
    const grandfathering = [0, GRANDFATHER_MONTHS_DEFAULT, GRANDFATHER_MONTHS_MAX, GRANDFATHER_MONTHS_MAX + 1, -1, 1.5, Number.NaN];
    let checked = 0;
    for (const price of prices) {
      for (const smbMultiplier of multipliers) {
        for (const grandfatherMonths of grandfathering) {
          for (const offered of [true, false]) {
            const tiers: TierSetting[] = pricing.tiers.map((t, i) => ({ id: t.id, price: i === 2 ? price : t.price, offered: i === 0 ? offered : false }));
            const d: PricingDraft = { ...draftFrom(pricing), tiers, smbMultiplier, grandfatherMonths };
            const state = newGame(1, { city: makeGridCity() });
            const a = applyCommand(state, { type: 'setPricing', tiers, smbMultiplier, grandfatherMonths });
            expect(pricingPreview(state.sales.pricing, d).valid, JSON.stringify(d)).toBe(a.ok);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it('reads number fields, with empty or junk as NaN', () => {
    expect(parseNumberField(' 55 ')).toBe(55);
    expect(parseNumberField('1.5')).toBe(1.5);
    expect(parseNumberField('')).toBeNaN();
    expect(parseNumberField('   ')).toBeNaN();
    expect(parseNumberField('abc')).toBeNaN();
  });

  it('starts from the game pricing and quotes the incumbent', () => {
    const d = draftFrom(pricing);
    expect(d.tiers).toEqual(pricing.tiers.map((t) => ({ id: t.id, price: t.price, offered: t.offered })));
    expect(d).toMatchObject({ smbMultiplier: pricing.smbMultiplier, grandfatherMonths: GRANDFATHER_MONTHS_DEFAULT });
    expect(d).not.toHaveProperty('marketingPerMonth');
    expect(d.promo).toEqual({ enabled: false, ...PROMO_DRAFT_START });
    expect(draftFrom(pricing, { percentOff: 15, months: 2 }).promo).toEqual({ enabled: true, percentOff: 15, months: 2 });
    expect(incumbentOffer()).toBe(`Incumbent cable: ${INCUMBENT_DOWN_MBPS} Mbps for ${formatMoney(INCUMBENT_PRICE)}/mo`);
  });

  it('shows the marketing budget read-only (the Customers dashboard sets it)', () => {
    expect(marketingLine(1_234)).toBe(`${formatMoney(1_234)} a month`);
    expect(marketingLine(0)).toBe('None');
  });
});

describe('grandfathering and the intro promo in the draft', () => {
  const pricing = defaultPricing();
  const draft = (edit: (d: PricingDraft) => void = () => {}): PricingDraft => {
    const d = draftFrom(pricing);
    edit(d);
    return d;
  };

  it('checks grandfathering the way setPricing does, and explains it', () => {
    for (const months of [0, 1, GRANDFATHER_MONTHS_DEFAULT, GRANDFATHER_MONTHS_MAX]) {
      expect(pricingPreview(pricing, draft((d) => (d.grandfatherMonths = months))).valid).toBe(true);
    }
    for (const months of [-1, 1.5, GRANDFATHER_MONTHS_MAX + 1, Number.NaN]) {
      const p = pricingPreview(pricing, draft((d) => (d.grandfatherMonths = months)));
      expect(p.valid).toBe(false);
      expect(p.problems).toContain(`Grandfathering must be a whole number of months from 0 to ${GRANDFATHER_MONTHS_MAX}`);
      // The rest still previews.
      expect(p.takeRate).not.toBeNull();
      expect(grandfatherHint(months)).toBe('');
    }
    expect(grandfatherHint(6)).toBe('Existing subscribers keep their price for 6 months; 0 = from the next bill. Cuts reach everyone at once.');
    expect(grandfatherHint(1)).toContain('for 1 month;');
    expect(grandfatherHint(0)).toContain('from the next bill');
  });

  it('checks the promo the way setPromo does, values it in the take rate and prices it', () => {
    const off = pricingPreview(pricing, draft());
    expect(off.promoPrices).toBeNull();
    expect(promoHint(pricing, draft(), off)).toBe('No intro promo: new subscribers pay the list price.');
    // Switched off, whatever is typed in it does not count.
    expect(pricingPreview(pricing, draft((d) => (d.promo = { enabled: false, percentOff: Number.NaN, months: 99 }))).valid).toBe(true);

    const on = draft((d) => (d.promo = { enabled: true, percentOff: 20, months: 3 }));
    const p = pricingPreview(pricing, on);
    expect(p.valid).toBe(true);
    const promo = draftPromo(on)!;
    expect(promo).toEqual({ percentOff: 20, months: 3 });
    expect(p.takeRate!.home).toBe(targetTakeRate(pricing, 'home', INCUMBENT_PRICE, promo));
    expect(p.takeRate!.home).toBeGreaterThan(off.takeRate!.home);
    expect(p.mix).toEqual(tierMix(pricing, 'home', INCUMBENT_PRICE, promo));
    for (const tier of pricing.tiers) expect(p.promoPrices![tier.id]).toBe(promoPrice(tier.price, 20));
    const hint = promoHint(pricing, on, p);
    expect(hint).toContain('20% off for the rest of their first month and 3 more months');
    expect(hint).toContain(`1 Gig ${formatMoney(promoPrice(pricing.tiers[1]!.price, 20))}`);

    for (const bad of [
      { enabled: true, percentOff: 0, months: 3 },
      { enabled: true, percentOff: PROMO_MAX_PERCENT_OFF + 1, months: 3 },
      { enabled: true, percentOff: 10, months: 0 },
      { enabled: true, percentOff: 10, months: PROMO_MAX_MONTHS + 1 },
      { enabled: true, percentOff: 10.5, months: 2 },
    ]) {
      const state = newGame(1, { city: makeGridCity() });
      const d = draft((x) => (x.promo = bad));
      const accepted = applyCommand(state, { type: 'setPromo', promo: draftPromo(d) }).ok;
      const q = pricingPreview(pricing, d);
      expect(q.valid, JSON.stringify(bad)).toBe(accepted);
      expect(q.valid).toBe(false);
      expect(q.problems.join(' ')).toMatch(/Intro promo must/);
    }
  });

  it('knows when the promo changed', () => {
    expect(samePromo(null, null)).toBe(true);
    expect(samePromo({ percentOff: 10, months: 2 }, { percentOff: 10, months: 2 })).toBe(true);
    expect(samePromo({ percentOff: 10, months: 2 }, null)).toBe(false);
    expect(samePromo({ percentOff: 10, months: 2 }, { percentOff: 10, months: 3 })).toBe(false);
  });
});

describe('the preview of today\'s subscribers', () => {
  function account(parcel: number, units: Partial<Record<TierId, number>>): Account {
    return { parcel, cabinet: 1, tierUnits: { fiber500: units.fiber500 ?? 0, fiber1g: units.fiber1g ?? 0, fiber2g: units.fiber2g ?? 0 }, since: 0, locks: [] };
  }
  function market(): GameState {
    const state = makeTestState(makeGridCity());
    state.day = 70; // Mar 12, 2027
    const accounts: Account[] = [];
    for (let p = 0; p < 12; p++) accounts.push(account(p, { fiber1g: 1 }));
    for (let p = 12; p < 17; p++) accounts.push(account(p, { fiber500: 1 }));
    for (let p = 17; p < 20; p++) accounts.push(account(p, { fiber2g: 1 }));
    state.sales.accounts = accounts;
    return state;
  }

  it('says who keeps what until when, who pays less at once, and quotes MRR and cancellations', () => {
    const state = market();
    const d = draftFrom(state.sales.pricing);
    const old1g = d.tiers[1]!.price;
    const old500 = d.tiers[0]!.price;
    d.tiers[1]!.price = old1g + 10;
    d.tiers[0]!.price = old500 - 5;
    d.grandfatherMonths = 4;
    const impact = pricingImpact(state, d);
    const until = lockEndDay(state.day, 4);
    expect(impact.quote).toEqual(quotePricing(state, d.tiers, d.smbMultiplier, 4));
    expect(impact.lines).toEqual([
      `5 subscribers on 500 Mbps pay ${formatMoney(old500 - 5)}/mo at once.`,
      `12 subscribers on 1 Gig keep ${formatMoney(old1g)}/mo until ${formatDate(until)}, then pay ${formatMoney(old1g + 10)}/mo.`,
    ]);
    expect(impact.quote!.mrrAfterLocks).toBeGreaterThan(impact.quote!.mrrNow);
    expect(impact.quote!.expectedChurn).toBe(Math.round(12 * stepChurnProbability(old1g, old1g + 10, GRANDFATHER_STEP_SHARE)));

    d.grandfatherMonths = 0;
    expect(pricingImpact(state, d).lines[1]).toBe(`12 subscribers on 1 Gig pay ${formatMoney(old1g + 10)}/mo from the next bill (${formatDate(lockEndDay(state.day, 0))}).`);

    // A subscriber already on an intro promo keeps it until its own end.
    state.sales.accounts[0]!.locks = [{ tier: 'fiber1g', price: old1g - 20, untilDay: lockEndDay(state.day, 1), reason: 'promo' }];
    d.grandfatherMonths = 4;
    expect(pricingImpact(state, d).lines.slice(1)).toEqual([
      `11 subscribers on 1 Gig keep ${formatMoney(old1g)}/mo until ${formatDate(until)}, then pay ${formatMoney(old1g + 10)}/mo.`,
      `1 subscriber on 1 Gig keeps its current offer until it ends, then pays ${formatMoney(old1g + 10)}/mo.`,
    ]);
  });

  it('says where a retired tier\'s subscribers move at the close', () => {
    const state = market();
    const d = draftFrom(state.sales.pricing);
    d.tiers[2]!.offered = false;
    const impact = pricingImpact(state, d);
    expect(impact.lines).toEqual([`At the month close 3 subscribers on 2 Gig move to 1 Gig (${formatMoney(d.tiers[1]!.price)}/mo).`]);
    expect(impact.quote!.unitsMoving).toBe(3);
  });

  it('quotes the bills after the step net of the expected cancellations it lists (spec C)', () => {
    const state = market();
    // Drop the two cheaper tiers: their subscribers move up at the close, and some cancel.
    const d = draftFrom(state.sales.pricing);
    d.tiers[0]!.offered = false;
    d.tiers[1]!.offered = false;
    const { quote } = pricingImpact(state, d);
    expect(quote!.expectedChurn).toBeGreaterThan(0);
    expect(quote!.mrrAfterChurn).toBeLessThan(quote!.mrrAfterLocks);
    const figures = impactFigures(quote);
    expect(figures).toEqual({
      now: `${formatMoney(quote!.mrrNow)}/mo`,
      after: `${formatMoney(quote!.mrrAfterChurn)}/mo`,
      cancels: `~${quote!.expectedChurn}`,
      note: `"After the step" is what today's subscribers pay once raised prices reach them and retired tiers move, after the ~${quote!.expectedChurn} ${quote!.expectedChurn === 1 ? 'cancellation' : 'cancellations'} expected.`,
    });
    // Nothing changes: no cancellations to count, and the note says only what the figure is.
    const same = impactFigures(pricingImpact(state, draftFrom(state.sales.pricing)).quote);
    expect(same.after).toBe(same.now);
    expect(same.cancels).toBe('~0');
    expect(same.note).not.toContain('cancellation');
    // An invalid draft: dashes.
    expect(impactFigures(null)).toEqual({ now: '–', after: '–', cancels: '–', note: '' });
  });

  it('has nothing to quote for an invalid draft, and little to say with no subscribers', () => {
    const state = market();
    const bad = draftFrom(state.sales.pricing);
    bad.tiers[0]!.price = Number.NaN;
    expect(pricingImpact(state, bad)).toEqual({ quote: null, lines: [] });
    const empty = makeTestState(makeGridCity());
    const impact = pricingImpact(empty, draftFrom(empty.sales.pricing));
    expect(impact.lines).toEqual(['No subscribers yet: everyone who signs up pays the new prices.']);
    expect(impact.quote!.mrrNow).toBe(monthlyRecurringRevenue(empty));
    expect(pricingImpact(state, draftFrom(state.sales.pricing)).lines).toEqual(["No change for today's subscribers."]);
  });
});

describe('the incumbent\'s promos in the panel', () => {
  it('lists each running promo with its corner, price, end and your target there vs elsewhere, at the draft prices', () => {
    const state = makeTestState(makeGridCity());
    const cabinet = addLivePlant(state) as CabinetId;
    state.day = 100;
    const price = INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT;
    state.sales.incumbentPromos = [{ cabinet, startDay: 90, endDay: 151, price, quietUntil: 334, triggerTakePct: 45, answered: false, answeredWithPromo: false }];
    const d = draftFrom(state.sales.pricing);
    const [row] = incumbentRows(state, d);
    const corner = cornerName(state.city, state.network.cabinets[0]!.node);
    expect(row).toEqual({
      cabinet,
      place: corner,
      price,
      endDay: 151,
      takeThere: targetTakeRate(state.sales.pricing, 'home', price),
      takeElsewhere: targetTakeRate(state.sales.pricing, 'home'),
      retention: quoteRetention(state, cabinet),
      answered: false,
    });
    expect(row!.takeThere).toBeLessThan(row!.takeElsewhere);
    expect(incumbentLine(row!)).toBe(
      `Around ${corner}: cable at ${formatMoney(price)}/mo until ${formatDate(151)}. Your target take rate there ${formatPercent(row!.takeThere)} (elsewhere ${formatPercent(row!.takeElsewhere)}).`,
    );
    // A cut in the draft answers it.
    d.tiers = d.tiers.map((t) => ({ ...t, price: t.price - 10 }));
    expect(incumbentRows(state, d)[0]!.takeThere).toBeGreaterThan(row!.takeThere);
    // Nothing running, nothing listed.
    state.day = 151;
    expect(incumbentRows(state, d)).toEqual([]);
  });
});

describe('who signs up (round 4b)', () => {
  const pricing = defaultPricing();

  it('lists each demand segment\'s share, take rate and favourite tier at the draft prices', () => {
    const d = draftFrom(pricing);
    const rows = segmentRows(pricing, d)!;
    const demand = segmentDemand(pricing);
    expect(rows.map((r) => r.segment)).toEqual(demand.map((seg) => seg.segment));
    for (const [i, row] of rows.entries()) {
      const seg = demand[i]!;
      expect(row).toMatchObject({ segment: seg.segment, label: SEGMENT_LABELS[seg.segment], share: seg.share, takeRate: seg.takeRate, tier: seg.tier, warning: null });
      const tierName = pricing.tiers.find((t) => t.id === seg.tier)!.name;
      expect(row.text).toBe(`${SEGMENT_LABELS[seg.segment]} (${formatPercent(seg.share)}): ${formatPercent(seg.takeRate)} sign up, mostly ${tierName}`);
    }
    // Invalid tiers: nothing to show.
    const bad = draftFrom(pricing);
    bad.tiers[0]!.price = Number.NaN;
    expect(segmentRows(pricing, bad)).toBeNull();
  });

  it('warns when no plan suits a segment: dropping 500 Mbps loses the price-sensitive households', () => {
    const d = draftFrom(pricing);
    d.tiers[0]!.offered = false;
    d.tiers[1]!.offered = false;
    const value = segmentRows(pricing, d)!.find((r) => r.segment === 'value')!;
    const share = DEMAND_SEGMENTS.find((seg) => seg.id === 'value')!.share;
    expect(value.tier).toBeNull();
    expect(value.warning).toBe(`Price-sensitive households (${formatPercent(share)}) won't sign up: no plan at or under ${formatMoney(reservationPrice('value'))}`);
    expect(value.text).toBe(value.warning);
    // Dropping only 500 Mbps: 1 Gig is a little over their reservation, so only a few sign up.
    const no500 = draftFrom(pricing);
    no500.tiers[0]!.offered = false;
    const few = segmentRows(pricing, no500)!.find((r) => r.segment === 'value')!;
    expect(few.tier).toBe('fiber1g');
    expect(few.warning).toBe(`Price-sensitive households (${formatPercent(share)}): only ${formatPercent(few.takeRate)} sign up: no plan at or under ${formatMoney(reservationPrice('value'))}`);
    expect(few.takeRate).toBeLessThan(segmentRows(pricing, draftFrom(pricing))!.find((r) => r.segment === 'value')!.takeRate / 2);
    // Mainstream households still find a plan.
    expect(segmentRows(pricing, no500)!.find((r) => r.segment === 'mainstream')!.warning).toBeNull();
    // The draft's intro promo counts, as in the take-rate preview.
    const withPromo = draftFrom(pricing);
    withPromo.promo = { enabled: true, percentOff: PROMO_MAX_PERCENT_OFF, months: PROMO_MAX_MONTHS };
    const rows = segmentRows(pricing, withPromo)!;
    expect(rows.map((r) => r.takeRate)).toEqual(segmentDemand(pricing, 'home', INCUMBENT_PRICE, draftPromo(withPromo)).map((seg) => seg.takeRate));
  });
});

describe('when an intro promo pays (round 4b)', () => {
  it('shows quotePromo\'s advice and figures for the typed offer, even while it is switched off', () => {
    const state = makeTestState(makeGridCity({ cols: 4, rows: 4, coAt: [2, 2] }));
    addLivePlant(state);
    const d = draftFrom(state.sales.pricing);
    expect(d.promo.enabled).toBe(false);
    const quote = quotePromo(state, PROMO_DRAFT_START);
    expect(quote.waitingUnits).toBeGreaterThan(0);
    const line = promoAdviceLine(state, d);
    expect(line.startsWith(quote.advice)).toBe(true);
    expect(line).toContain(
      `${PROMO_DRAFT_START.percentOff}% off for ${PROMO_DRAFT_START.months} months, over the next ${promoQuoteMonths(PROMO_DRAFT_START)} months: ` +
        (quote.extraSignups < 1 ? 'less than one more signup' : `about ${quote.extraSignups} more signup`),
    );
    expect(line).toContain(`${roughMoney(quote.valueGained)} of margin against ${roughMoney(quote.discountCost)} of discounts.`);
    // The verdict either way (whether this offer pays here is the balance's call: PROMO_BOOST_YOUNG_MONTHS).
    expect(line).toMatch(quote.pays ? /^Pays now/ : /^Doesn't pay/);
    // An offer that is not valid: the general advice.
    d.promo.percentOff = Number.NaN;
    expect(promoAdviceLine(state, d)).toBe(quotePromo(state, null).advice);
    // Nothing once the game is over.
    state.gameOver = { day: 0, reason: 'insolvent', message: 'Out of cash' };
    expect(promoAdviceLine(state, draftFrom(state.sales.pricing))).toBe('');
  });
});

describe('the retention offer in the panel (round 4b)', () => {
  function contested(): { state: GameState; cabinet: CabinetId } {
    const state = makeTestState(makeGridCity({ cols: 4, rows: 4, coAt: [2, 2] }));
    const cabinet = addLivePlant(state, { splitters: 8 }) as CabinetId;
    state.day = 151; // Jun 1, 2027
    state.finance.cash = 1_000_000;
    state.sales.accounts = state.city.parcels.map((p) => ({ parcel: p.id, cabinet, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 0, locks: [] }));
    reviewIncumbent(state);
    expect(state.sales.incumbentPromos).toHaveLength(1);
    return { state, cabinet };
  }

  it('shows the offer\'s figures and an enabled button, then Answered once sent', () => {
    const { state, cabinet } = contested();
    const d = draftFrom(state.sales.pricing);
    const [row] = incumbentRows(state, d);
    const q = row!.retention;
    expect(q).toEqual(quoteRetention(state, cabinet));
    expect(retentionLine(row!)).toBe(
      `Retention offer: ${RETENTION_PERCENT_OFF}% off for its ${q.units} subscribers until ${formatDate(row!.endDay)} costs about ${roughMoney(q.totalCost)} ` +
        `(${formatMoney(q.monthlyCost)}/mo) and keeps about ${q.cancellationsAvoided} subscribers who would cancel, worth ${roughMoney(q.valueSaved)}: ` +
        `${q.pays ? 'it pays' : "it doesn't pay"}.`,
    );
    expect(retentionButton(row!)).toEqual({ label: 'Answer with a retention offer', disabled: false, reason: null });
    expect(applyCommand(state, { type: 'answerIncumbent', cabinet }).ok).toBe(true);
    const [after] = incumbentRows(state, d);
    expect(after!.answered).toBe(true);
    expect(retentionButton(after!)).toEqual({ label: 'Answered', disabled: true, reason: null });
    expect(retentionLine(after!)).toBe(`Answered: its subscribers pay ${RETENTION_PERCENT_OFF}% less until ${formatDate(after!.endDay)}, which spares them the promo's extra cancellations.`);
  });

  it('disables the button with the reason when no offer is possible', () => {
    const { state } = contested();
    state.sales.accounts = [];
    const [row] = incumbentRows(state, draftFrom(state.sales.pricing));
    expect(retentionButton(row!)).toEqual({ label: 'Answer with a retention offer', disabled: true, reason: 'Nobody subscribes there yet' });
    expect(retentionLine(row!)).toBe('No retention offer: Nobody subscribes there yet.');
  });
});
