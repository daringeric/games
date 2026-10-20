// Pure models behind the economy UI: report rows (financing included), the
// month-close toast, the pricing preview, milestone progress, the rate card,
// HUD chips (debt and covenant included), notice tones, the game-over
// subtitle and the debug-hook gate. Money is checked against balance.ts constants and
// sim results, never literal dollar amounts.

import { describe, expect, it } from 'vitest';
import {
  CABINET_COST,
  CPP_AMBER_MULTIPLIER,
  CPP_TARGET,
  ENGINEERING_FEE,
  INCUMBENT_DOWN_MBPS,
  INCUMBENT_PRICE,
  INSOLVENCY_GRACE_MONTHS,
  INSTALL_COST_HOME,
  INSTALL_COST_MDU_UNIT,
  INSTALL_COST_SMB,
  MAKE_READY_COST_PER_POLE,
  MARKETING_MAX_PER_MONTH,
  MDU_ROUTER_COST,
  OLT_CARD_COST,
  OLT_START_PON_PORTS,
  OVERHEAD_PER_MONTH,
  PERMIT_FEE_AERIAL,
  PERMIT_FEE_UNDERGROUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  SMB_MULTIPLIER_MAX,
  SMB_MULTIPLIER_MIN,
  SPLITTER_COST,
  SUPPORT_COST_PER_SUB_PER_MONTH,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
  AERIAL_COST_PER_FT,
  CABINET_REACH_FT,
  BASE_RATE_BPS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_SPREAD_BPS,
  CREDIT_LINE_EXTRA_BPS,
  LEVERAGE_SPREAD_BANDS,
  LEVERAGE_SPREAD_MAX_BPS,
  PENALTY_STEP_UP_BPS,
  TERM_EXTRA_BPS,
  TERM_LOAN_YEARS,
} from '../sim/balance';
import { formatDate } from '../sim/calendar';
import { applyCommand, newGame, runDays } from '../sim/game';
import { cppBand, operatingCashFlow, reportKpis } from '../sim/metrics';
import { getService } from '../sim/network';
import { MILESTONES } from '../sim/milestones';
import { INSTALLS_PAUSED_PREFIX, INSTALLS_RESUMED_PREFIX, defaultPricing, marketingBoost, targetTakeRate, tierMix, unitPrice } from '../sim/sales';
import { addLivePlant, makeGridCity, makeTestState } from '../sim/testing/fixtures';
import type { DebtStats, GameState, MonthlyReport, Notice, NoticeKind, TermLoan, TierSetting } from '../sim/types';
import { debugHookEnabled, searchWithoutSeed } from './debugHook';
import { formatBpsDelta, formatFeet, formatMoney, formatPerFt, formatPercent, formatRate, formatRatio, formatSignedMoney, plural } from './format';
import { gameOverSubtitle } from './gameOverDialog';
import { covenantStatus, cppStatus, debtStatus, overdraftStatus, ponStatus, runwayHint } from './hud';
import { milestoneRows } from './milestonesPanel';
import { noticeTone, toastLayout } from './overlays';
import { financingRows, monthClosedMessage, reportRows, subscriberMovements } from './panel';
import type { ReportRow } from './panel';
import { boostHint, draftFrom, incumbentOffer, parseNumberField, pricingPreview } from './pricingPanel';
import type { PricingDraft } from './pricingPanel';
import { rateCardSections } from './rateCard';

/** A grid town fully lit from the CO with plenty of ports, run long enough to have subscribers and closed months. */
function litGame(days = 120): GameState {
  const state = makeTestState(makeGridCity({ cols: 3, rows: 2 }));
  addLivePlant(state, { splitters: 4 });
  runDays(state, days);
  return state;
}

const row = (rows: ReportRow[], key: ReportRow['key']) => {
  const found = rows.find((r) => r.key === key);
  if (!found) throw new Error(`no ${key} row`);
  return found;
};

describe('report rows', () => {
  it('shows every KPI of a round-2 close, formatted from reportKpis', () => {
    const state = litGame();
    const report = state.finance.reports.at(-1)!;
    expect(report.stats!.subscribers).toBeGreaterThan(0);
    const kpis = reportKpis(report)!;
    const rows = reportRows(report);
    expect(rows.map((r) => r.key)).toEqual([
      'net',
      'revenue',
      'subscribers',
      'arpu',
      'cpga',
      'takeRate',
      'cpp',
      'costPerConnection',
      'operatingCashFlow',
      'poleRent',
      'passings',
      'interest',
      'principal',
      'proceeds',
      'debt',
      'leverage',
      'coverage',
    ]);
    expect(row(rows, 'net').value).toBe(formatSignedMoney(report.net));
    expect(row(rows, 'revenue').value).toBe(formatMoney(kpis.revenue));
    expect(row(rows, 'subscribers').value).toBe(String(report.stats!.subscribers));
    expect(row(rows, 'subscribers').detail).toBe(subscriberMovements(report));
    expect(row(rows, 'arpu').value).toBe(`${formatMoney(kpis.arpu!)}/mo`);
    expect(row(rows, 'takeRate').value).toBe(formatPercent(kpis.takeRate!));
    expect(row(rows, 'operatingCashFlow').value).toBe(formatSignedMoney(operatingCashFlow(report)));
    expect(row(rows, 'passings').value).toBe(report.passings.toLocaleString('en-US'));
    expect(row(rows, 'poleRent').value).toBe(formatMoney(-(report.totals.poleRent ?? 0)));
    // The live plant was free, so no cost per passing to color... but connections cost installs.
    expect(row(rows, 'costPerConnection').value).toBe(formatMoney(kpis.costPerConnection!));
    for (const r of rows) expect(r.value).not.toMatch(/NaN|undefined|null|Infinity/);
  });

  it('colors cost per passing by band and negative money red', () => {
    const base: MonthlyReport = {
      year: 2027,
      month: 4,
      totals: { revenue: 500, overhead: -900 },
      net: -400,
      cashEnd: 0,
      passings: 100,
      stats: {
        subscribers: 10,
        accounts: 10,
        subscriberDays: 10 * 30,
        grossAdds: 0,
        churned: 1,
        lostService: 2,
        connectsTotal: 12,
        capexOsp: CPP_TARGET * 100,
        capexConnect: 0,
        capexCo: 0,
        ponPortsUsed: 1,
        ponPorts: OLT_START_PON_PORTS,
        fullCabinets: 0,
      },
    };
    const rows = reportRows(base);
    expect(row(rows, 'cpp')).toMatchObject({ value: formatMoney(CPP_TARGET), tone: 'green' });
    expect(row(rows, 'net').tone).toBe('negative');
    expect(row(rows, 'operatingCashFlow')).toMatchObject({ value: formatSignedMoney(-400), tone: 'negative' });
    // No gross adds: no cost per gross add.
    expect(row(rows, 'cpga').value).toBe('–');
    expect(row(rows, 'subscribers').detail).toBe('+0 new, 1 churned, 2 lost service');

    const amber = reportRows({ ...base, stats: { ...base.stats!, capexOsp: CPP_TARGET * CPP_AMBER_MULTIPLIER * 100 } });
    expect(row(amber, 'cpp').tone).toBe('amber');
    const red = reportRows({ ...base, stats: { ...base.stats!, capexOsp: CPP_TARGET * CPP_AMBER_MULTIPLIER * 100 + 100 } });
    expect(row(red, 'cpp').tone).toBe('red');
  });

  it('reads – for KPIs with nothing to divide by', () => {
    const state = makeTestState();
    runDays(state, 31);
    const report = state.finance.reports[0]!;
    const rows = reportRows(report);
    for (const key of ['arpu', 'cpga', 'takeRate', 'cpp', 'costPerConnection'] as const) expect(row(rows, key).value).toBe('–');
    expect(row(rows, 'subscribers').value).toBe('0');
    expect(row(rows, 'cpp').tone).toBeNull();
  });

  it('reads – for every KPI of a report migrated from a v1 save (no stats)', () => {
    const v1: MonthlyReport = { year: 2027, month: 1, totals: { construction: -5000, poleRent: -20 }, net: -5020, cashEnd: 1, passings: 12 };
    const rows = reportRows(v1);
    for (const key of ['revenue', 'subscribers', 'arpu', 'cpga', 'takeRate', 'cpp', 'costPerConnection'] as const) {
      expect(row(rows, key).value).toBe('–');
    }
    expect(row(rows, 'subscribers').detail).toBeNull();
    expect(row(rows, 'net').value).toBe(formatSignedMoney(-5020));
    expect(row(rows, 'operatingCashFlow').value).toBe(formatSignedMoney(operatingCashFlow(v1)));
    expect(row(rows, 'poleRent').value).toBe(formatMoney(20));
    expect(row(rows, 'passings').value).toBe('12');
    for (const key of ['interest', 'principal', 'proceeds', 'debt', 'leverage', 'coverage'] as const) expect(row(rows, key).value).toBe('–');
  });
});

describe('financing report rows', () => {
  const debt = (over: Partial<DebtStats> = {}): DebtStats => ({
    creditBalance: 12_000,
    termBalance: 400_000,
    creditLimit: 50_000,
    arr: 100_000,
    annualOperatingCashFlow: 90_000,
    annualDebtService: 60_000,
    leverageX100: 458,
    coverageX100: 150,
    stage: 'compliant',
    averageRateBps: 725,
    missedPayment: false,
    ...over,
  });
  const report = (d: DebtStats | undefined, totals: MonthlyReport['totals'] = {}): MonthlyReport => ({
    year: 2028,
    month: 2,
    totals,
    net: 0,
    cashEnd: 0,
    passings: 10,
    debt: d,
  });

  it('shows the month’s interest, principal and borrowing, and debt, leverage and coverage at month end', () => {
    const rows = financingRows(report(debt(), { interest: -2_345, principal: -6_100, loanProceeds: 50_000 }));
    expect(row(rows, 'interest')).toMatchObject({ value: formatMoney(2_345), tone: null });
    expect(row(rows, 'principal').value).toBe(formatMoney(6_100));
    expect(row(rows, 'proceeds').value).toBe(formatMoney(50_000));
    expect(row(rows, 'debt').value).toBe(formatMoney(412_000));
    expect(row(rows, 'leverage')).toMatchObject({ value: '4.58×', tone: null, detail: `limit ${formatRatio(COVENANT_MAX_LEVERAGE)}` });
    expect(row(rows, 'coverage')).toMatchObject({ value: '1.50×', tone: null, detail: `min ${formatRatio(COVENANT_MIN_COVERAGE)}` });
  });

  it('reads $0 for money that did not move in a round-3 month, and – for nothing scheduled', () => {
    const rows = financingRows(report(debt({ creditBalance: 0, termBalance: 0, leverageX100: 0, coverageX100: null })));
    for (const key of ['interest', 'principal', 'proceeds', 'debt'] as const) expect(row(rows, key).value).toBe('$0');
    expect(row(rows, 'leverage').value).toBe('0.00×');
    expect(row(rows, 'coverage').value).toBe('–');
  });

  it('marks a covenant breach, and debt with no cash flow as not measurable', () => {
    const over = financingRows(report(debt({ leverageX100: COVENANT_MAX_LEVERAGE * 100 + 1, coverageX100: COVENANT_MIN_COVERAGE * 100 - 1 })));
    expect(row(over, 'leverage').tone).toBe('breach');
    expect(row(over, 'coverage').tone).toBe('breach');
    const atLimit = financingRows(report(debt({ leverageX100: COVENANT_MAX_LEVERAGE * 100, coverageX100: COVENANT_MIN_COVERAGE * 100 })));
    expect(row(atLimit, 'leverage').tone).toBeNull();
    expect(row(atLimit, 'coverage').tone).toBeNull();
    const unmeasurable = financingRows(report(debt({ leverageX100: null })));
    expect(row(unmeasurable, 'leverage')).toMatchObject({ value: 'not measurable', tone: 'breach' });
  });

  it('keeps net as the full cash flow and says operating cash flow is before financing', () => {
    const rows = reportRows(report(debt(), { revenue: 9_000, overhead: -4_000, interest: -1_000, loanProceeds: 20_000 }));
    expect(row(rows, 'operatingCashFlow').hint).toContain('financing');
    expect(row(rows, 'net').hint).toContain('financing included');
  });
});

describe('month-close toast', () => {
  const stats = (subscribers: number): MonthlyReport['stats'] => ({
    subscribers,
    accounts: subscribers,
    subscriberDays: subscribers * 31,
    grossAdds: 0,
    churned: 0,
    lostService: 0,
    connectsTotal: subscribers,
    capexOsp: 0,
    capexConnect: 0,
    capexCo: 0,
    ponPortsUsed: 0,
    ponPorts: OLT_START_PON_PORTS,
    fullCabinets: 0,
  });
  const report = (subscribers: number | null, passings: number, net: number): MonthlyReport => ({
    year: 2027,
    month: 3,
    totals: {},
    net,
    cashEnd: 0,
    passings,
    stats: subscribers === null ? undefined : stats(subscribers),
  });

  it('names the month, net, subscribers and passings', () => {
    expect(monthClosedMessage(report(412, 1034, 1200))).toBe('Mar 2027 closed: net +$1,200, 412 subs, 1,034 passings');
    expect(monthClosedMessage(report(1, 1, -3))).toBe('Mar 2027 closed: net -$3, 1 sub, 1 passing');
  });

  it('leaves out subscribers for a report without stats', () => {
    expect(monthClosedMessage(report(null, 7, 0))).toBe('Mar 2027 closed: net $0, 7 passings');
  });

  it('says when the close missed its debt payment', () => {
    const missed: MonthlyReport = {
      ...report(null, 7, 0),
      debt: {
        creditBalance: 1,
        termBalance: 0,
        creditLimit: 0,
        arr: 0,
        annualOperatingCashFlow: 0,
        annualDebtService: 0,
        leverageX100: null,
        coverageX100: null,
        stage: 'frozen',
        averageRateBps: null,
        missedPayment: true,
      },
    };
    expect(monthClosedMessage(missed)).toBe('Mar 2027 closed: net $0, 7 passings, payment missed');
    expect(monthClosedMessage({ ...missed, debt: { ...missed.debt!, missedPayment: false } })).toBe('Mar 2027 closed: net $0, 7 passings');
  });
});

describe('pricing preview', () => {
  const pricing = defaultPricing();
  const draft = (edit: (d: PricingDraft) => void = () => {}): PricingDraft => {
    const d = draftFrom(pricing, 1_000);
    edit(d);
    return d;
  };

  it('previews the take rate, tier mix, business prices and marketing boost of the edited values', () => {
    const d = draft((x) => {
      x.tiers[1]!.price = TIER_PRICE_MIN + 10;
      x.smbMultiplier = SMB_MULTIPLIER_MAX;
      x.marketingPerMonth = 2_500;
    });
    const edited = { ...pricing, smbMultiplier: SMB_MULTIPLIER_MAX, tiers: pricing.tiers.map((t, i) => (i === 1 ? { ...t, price: TIER_PRICE_MIN + 10 } : t)) };
    const p = pricingPreview(pricing, d, 800);
    expect(p.valid).toBe(true);
    expect(p.problems).toEqual([]);
    expect(p.takeRate).toEqual({ home: targetTakeRate(edited, 'home'), mdu: targetTakeRate(edited, 'mdu'), smb: targetTakeRate(edited, 'smb') });
    expect(p.mix).toEqual(tierMix(edited));
    expect(p.smbPrices).toEqual({
      fiber500: unitPrice(edited, 'fiber500', 'smb'),
      fiber1g: unitPrice(edited, 'fiber1g', 'smb'),
      fiber2g: unitPrice(edited, 'fiber2g', 'smb'),
    });
    expect(p.boost).toBe(marketingBoost(2_500, 800));
    // A cheaper gig tier raises the target take rate.
    expect(p.takeRate!.home).toBeGreaterThan(targetTakeRate(pricing, 'home'));
  });

  it('lowers the business take rate as the business multiplier rises, leaving households alone', () => {
    const at = (m: number) => pricingPreview(pricing, draft((x) => (x.smbMultiplier = m)), 100).takeRate!;
    const low = at(SMB_MULTIPLIER_MIN);
    const high = at(SMB_MULTIPLIER_MAX);
    expect(high.smb).toBeLessThan(low.smb);
    expect(high.home).toBe(low.home);
    expect(high.mdu).toBe(low.mdu);
  });

  it('flags an out-of-range or missing price and previews nothing for the tiers', () => {
    for (const bad of [TIER_PRICE_MAX + 1, TIER_PRICE_MIN - 1, 55.5, Number.NaN]) {
      const p = pricingPreview(pricing, draft((x) => (x.tiers[0]!.price = bad)), 100);
      expect(p.valid).toBe(false);
      expect(p.problems[0]).toContain('500 Mbps');
      expect(p.takeRate).toBeNull();
      expect(p.mix).toBeNull();
      // The marketing half still previews.
      expect(p.boost).toBe(marketingBoost(1_000, 100));
    }
  });

  it('needs at least one tier offered', () => {
    const p = pricingPreview(pricing, draft((x) => x.tiers.forEach((t) => (t.offered = false))), 100);
    expect(p.valid).toBe(false);
    expect(p.problems).toContain('Offer at least one tier');
  });

  it('keeps the take-rate preview when only the multiplier or the budget is wrong', () => {
    const smb = pricingPreview(pricing, draft((x) => (x.smbMultiplier = SMB_MULTIPLIER_MAX + 1)), 100);
    expect(smb.valid).toBe(false);
    expect(smb.takeRate).not.toBeNull();
    expect(smb.smbPrices).toBeNull();
    const marketing = pricingPreview(pricing, draft((x) => (x.marketingPerMonth = MARKETING_MAX_PER_MONTH + 1)), 100);
    expect(marketing.valid).toBe(false);
    expect(marketing.boost).toBeNull();
    expect(marketing.takeRate).not.toBeNull();
  });

  it('calls a draft valid exactly when the sim accepts setPricing and setMarketing', () => {
    const prices = [TIER_PRICE_MIN - 1, TIER_PRICE_MIN, 64, TIER_PRICE_MAX, TIER_PRICE_MAX + 1, 70.5, Number.NaN];
    const multipliers = [0.5, 1, 1.25, SMB_MULTIPLIER_MAX, SMB_MULTIPLIER_MAX + 0.01, Number.NaN];
    const budgets = [-1, 0, 1_500, MARKETING_MAX_PER_MONTH, MARKETING_MAX_PER_MONTH + 1, 10.5, Number.NaN];
    let checked = 0;
    for (const price of prices) {
      for (const smbMultiplier of multipliers) {
        for (const marketingPerMonth of budgets) {
          for (const offered of [true, false]) {
            const tiers: TierSetting[] = pricing.tiers.map((t, i) => ({ id: t.id, price: i === 2 ? price : t.price, offered: i === 0 ? offered : false }));
            const d: PricingDraft = { tiers, smbMultiplier, marketingPerMonth };
            const state = newGame(1, { city: makeGridCity() });
            const a = applyCommand(state, { type: 'setPricing', tiers, smbMultiplier });
            const b = applyCommand(state, { type: 'setMarketing', perMonth: marketingPerMonth });
            expect(pricingPreview(state.sales.pricing, d, 0).valid, JSON.stringify(d)).toBe(a.ok && b.ok);
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
    const d = draftFrom(pricing, 1_234);
    expect(d.tiers).toEqual(pricing.tiers.map((t) => ({ id: t.id, price: t.price, offered: t.offered })));
    expect(d).toMatchObject({ smbMultiplier: pricing.smbMultiplier, marketingPerMonth: 1_234 });
    expect(incumbentOffer()).toBe(`Incumbent cable: ${INCUMBENT_DOWN_MBPS} Mbps for ${formatMoney(INCUMBENT_PRICE)}/mo`);
  });

  it('explains what the marketing budget does', () => {
    expect(boostHint(null, -5, 10)).toBe('');
    expect(boostHint(0, 0, 10)).toContain('natural pace');
    expect(boostHint(marketingBoost(500, 0), 500, 0)).toContain('No homes passed yet');
    const boost = marketingBoost(500, 300);
    expect(boostHint(boost, 500, 300)).toBe(`Signups come ${formatPercent(boost)} faster at today's 300 passings.`);
  });
});

describe('milestone rows', () => {
  it('lists every milestone in order, none achieved in a new game, each with a progress hint', () => {
    const rows = milestoneRows(makeTestState());
    expect(rows.map((r) => r.id)).toEqual(MILESTONES.map((m) => m.id));
    expect(rows.map((r) => r.title)).toEqual(MILESTONES.map((m) => m.title));
    for (const r of rows) {
      expect(r).toMatchObject({ day: null, when: 'Not yet' });
      expect(r.progress).toBeTruthy();
    }
    expect(rows.find((r) => r.id === 'subscribers100')!.progress).toBe('0 / 100 subscribers');
    expect(rows.find((r) => r.id === 'cashFlowPositive')!.progress).toBe('No month closed yet');
  });

  it('dates the achieved ones and shows progress toward the rest', () => {
    const state = litGame();
    const first = state.milestones.find((m) => m.id === 'firstLight');
    expect(first).toBeDefined();
    const rows = milestoneRows(state);
    expect(rows.find((r) => r.id === 'firstLight')).toMatchObject({ day: first!.day, when: formatDate(first!.day), progress: null });
    const subs = state.sales.accounts.reduce((n, a) => n + a.tierUnits.fiber500 + a.tierUnits.fiber1g + a.tierUnits.fiber2g, 0);
    expect(rows.find((r) => r.id === 'subscribers1000')!.progress).toBe(`${subs} / 1,000 subscribers`);
    const last = state.finance.reports.at(-1)!;
    const inTheBlack = rows.find((r) => r.id === 'cashFlowPositive')!;
    if (state.milestones.some((m) => m.id === 'cashFlowPositive')) expect(inTheBlack.progress).toBeNull();
    else expect(inTheBlack.progress).toBe(`Last month: ${formatSignedMoney(operatingCashFlow(last))} operating cash flow`);
  });
});

describe('rate card', () => {
  const sections = rateCardSections();
  const value = (label: string) => {
    for (const s of sections) for (const r of s.rows) if (r.label === label) return r.value;
    throw new Error(`no ${label}`);
  };

  it('lists every rate from balance.ts', () => {
    expect(value('Aerial strand and lash')).toBe(formatPerFt(AERIAL_COST_PER_FT));
    expect(value('Underground bore')).toBe(formatPerFt(UNDERGROUND_COST_PER_FT));
    expect(value('Rock surcharge')).toBe(`+${formatPerFt(UNDERGROUND_ROCK_SURCHARGE_PER_FT)}`);
    expect(value('Make-ready')).toBe(`${formatMoney(MAKE_READY_COST_PER_POLE)} per pole`);
    expect(value('Engineering')).toBe(`${formatMoney(ENGINEERING_FEE)} per order`);
    expect(value('Pole attachment application')).toBe(`${formatMoney(PERMIT_FEE_AERIAL)} per order`);
    expect(value('City excavation permit')).toBe(`${formatMoney(PERMIT_FEE_UNDERGROUND)} per order`);
    expect(value('Cabinet')).toBe(formatMoney(CABINET_COST));
    expect(value('OLT line card')).toBe(formatMoney(OLT_CARD_COST));
    expect(value('Cabinet reach')).toBe(formatFeet(CABINET_REACH_FT));
    expect(value('Home install')).toBe(formatMoney(INSTALL_COST_HOME));
    expect(value('Business install')).toBe(formatMoney(INSTALL_COST_SMB));
    expect(value('Apartment unit')).toBe(formatMoney(INSTALL_COST_MDU_UNIT));
    expect(value('Building router')).toBe(formatMoney(MDU_ROUTER_COST));
    expect(value('Overhead')).toBe(`${formatMoney(OVERHEAD_PER_MONTH)}/mo`);
    expect(value('Customer support')).toBe(`${formatMoney(SUPPORT_COST_PER_SUB_PER_MONTH)}/mo`);
    expect(value('Pole rent')).toBe(`${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}/mo`);
    expect(value('Target')).toBe(formatMoney(CPP_TARGET));
    expect(value('Amber')).toBe(`up to ${formatMoney(CPP_TARGET * CPP_AMBER_MULTIPLIER)}`);
    expect(value('Red')).toBe(`above ${formatMoney(CPP_TARGET * CPP_AMBER_MULTIPLIER)}`);
    const splitter = sections.flatMap((s) => s.rows).find((r) => r.label.startsWith('Splitter'));
    expect(splitter?.value).toBe(formatMoney(SPLITTER_COST));
  });

  it('lists what borrowing costs, from balance.ts', () => {
    const financing = sections.find((s) => s.title === 'Financing')!;
    const rate = (label: string) => financing.rows.find((r) => r.label === label)?.value;
    expect(rate('Base rate')).toBe(`${formatRate(BASE_RATE_BPS)} a year`);
    expect(rate('Credit line premium')).toBe(formatBpsDelta(CREDIT_LINE_EXTRA_BPS));
    for (const years of TERM_LOAN_YEARS) expect(rate(`${years}-year term premium`)).toBe(formatBpsDelta(TERM_EXTRA_BPS[years]));
    expect(rate(`Leverage up to ${formatRatio(LEVERAGE_SPREAD_BANDS[0]!.maxLeverage)}`)).toBe(formatBpsDelta(LEVERAGE_SPREAD_BANDS[0]!.spreadBps));
    expect(rate(`Leverage above ${formatRatio(LEVERAGE_SPREAD_BANDS.at(-1)!.maxLeverage)}`)).toBe(formatBpsDelta(LEVERAGE_SPREAD_MAX_BPS));
    expect(rate('Cost per passing: amber')).toBe(formatBpsDelta(CPP_SPREAD_BPS.amber));
    expect(rate('Cost per passing: red')).toBe(formatBpsDelta(CPP_SPREAD_BPS.red));
    expect(rate('Penalty rate')).toBe(formatBpsDelta(PENALTY_STEP_UP_BPS));
    expect(rate('Leverage covenant')).toBe(`max ${formatRatio(COVENANT_MAX_LEVERAGE)}`);
    expect(rate('Coverage covenant')).toBe(`min ${formatRatio(COVENANT_MIN_COVERAGE)}`);
    expect(rate('Cure')).toBe(plural(COVENANT_CURE_CLOSES, 'close'));
    // One leverage row per band, plus the one above them.
    expect(financing.rows.filter((r) => r.label.startsWith('Leverage ') && !r.label.includes('covenant')).length).toBe(LEVERAGE_SPREAD_BANDS.length + 1);
  });

  it('has no empty or broken values', () => {
    for (const s of sections) {
      expect(s.rows.length).toBeGreaterThan(0);
      for (const r of s.rows) {
        for (const text of [r.label, r.value, r.note ?? 'none']) expect(text).toMatch(/^\S(.*\S)?$/);
        expect(`${r.label} ${r.value} ${r.note ?? ''}`).not.toMatch(/NaN|undefined|Infinity/);
      }
    }
  });
});

describe('HUD chips', () => {
  it('counts PON ports in use against the OLT, amber from 90% and red when full', () => {
    const state = makeTestState();
    expect(ponStatus(state)).toMatchObject({ text: `PON 0/${OLT_START_PON_PORTS}`, level: 'ok' });
    state.network.olt.ponPorts = 10;
    addLivePlant(state, { segments: [], node: 0, splitters: 8 });
    expect(ponStatus(state)).toMatchObject({ text: 'PON 8/10', level: 'ok' });
    addLivePlant(state, { segments: [], node: 1, splitters: 1 });
    expect(ponStatus(state)).toMatchObject({ text: 'PON 9/10', level: 'warn' });
    addLivePlant(state, { segments: [], node: 2, splitters: 1 });
    expect(ponStatus(state).level).toBe('full');
    expect(ponStatus(state).tip).toContain('line card');
  });

  it('warns about an overdraft with the closes the bank still allows', () => {
    const state = makeTestState();
    expect(overdraftStatus(state)).toBeNull();
    state.finance.cash = -1;
    expect(overdraftStatus(state)).toMatchObject({ text: `Overdrawn: ${plural(INSOLVENCY_GRACE_MONTHS, 'close')} left`, tone: 'danger' });
    state.finance.negativeMonths = INSOLVENCY_GRACE_MONTHS - 1;
    expect(overdraftStatus(state)!.text).toBe(`Overdrawn: ${plural(1, 'close')} left`);
    state.finance.cash = 0;
    expect(overdraftStatus(state)).toMatchObject({ text: `Recovering: ${plural(1, 'close')} left`, tone: 'warn' });
    state.gameOver = { day: 31, reason: 'insolvent', message: 'Out of cash.' };
    expect(overdraftStatus(state)).toMatchObject({ text: 'Game over: out of cash', tone: 'danger', tip: 'Out of cash.' });
    state.gameOver = { day: 31, reason: 'default', message: 'Defaulted.' };
    expect(overdraftStatus(state)).toMatchObject({ text: 'Game over: loan default', tone: 'danger', tip: 'Defaulted.' });
  });

  const loan = (id: number, balance: number): TermLoan => ({
    id,
    principal: balance,
    balance,
    rateBps: BASE_RATE_BPS,
    termMonths: 84,
    payment: 1,
    monthsLeft: 84,
    originatedDay: 0,
  });

  it('shows total debt only while something is owed, splitting line and loans in the tooltip', () => {
    const state = makeTestState();
    expect(debtStatus(state)).toBeNull();
    state.debt.credit.balance = 12_000;
    expect(debtStatus(state)).toMatchObject({ text: `Debt ${formatMoney(12_000)}`, total: 12_000 });
    state.debt.loans = [loan(1, 150_000), loan(2, 250_000)];
    const status = debtStatus(state)!;
    expect(status.text).toBe(`Debt ${formatMoney(412_000)}`);
    expect(status.tip).toContain(`Credit line ${formatMoney(12_000)}`);
    expect(status.tip).toContain(`term loans ${formatMoney(400_000)} (2 loans)`);
    state.debt.credit.balance = 0;
    expect(debtStatus(state)!.tip).toContain(`Credit line ${formatMoney(0)}`);
  });

  it('shows the covenant stage only when not compliant, warn then danger, with what it means and how to cure', () => {
    const state = makeTestState();
    expect(covenantStatus(state)).toBeNull();
    state.debt.covenant = { stage: 'warning', compliantCloses: 0 };
    expect(covenantStatus(state)).toMatchObject({ text: 'Covenant warning', tone: 'warn' });
    expect(covenantStatus(state)!.tip).toContain(formatRatio(COVENANT_MAX_LEVERAGE));
    expect(covenantStatus(state)!.tip).toContain(formatRatio(COVENANT_MIN_COVERAGE));
    expect(covenantStatus(state)!.tip).toContain(plural(COVENANT_CURE_CLOSES, 'compliant month close'));
    state.debt.covenant = { stage: 'penalty', compliantCloses: 1 };
    expect(covenantStatus(state)).toMatchObject({ text: 'Penalty rate', tone: 'warn' });
    expect(covenantStatus(state)!.tip).toContain(formatBpsDelta(PENALTY_STEP_UP_BPS));
    expect(covenantStatus(state)!.tip).toContain(`1 of ${COVENANT_CURE_CLOSES} so far`);
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    expect(covenantStatus(state)).toMatchObject({ text: 'Credit frozen', tone: 'danger' });
    expect(covenantStatus(state)!.tip).toContain('default');
  });

  it('shows the live cost per passing by the same formula as the report, banded against the target', () => {
    const state = makeTestState();
    expect(cppStatus(state)).toBeNull();
    const lit = litGame(31);
    lit.finance.capex.osp = CPP_TARGET * getService(lit).passings;
    expect(cppStatus(lit)).toMatchObject({ text: formatMoney(CPP_TARGET), band: 'green' });
    // Right after a month close the chip and the report's KPI agree.
    const closing = makeTestState(makeGridCity({ cols: 3, rows: 2 }));
    addLivePlant(closing, { splitters: 4 });
    closing.finance.capex.osp = 123_457;
    runDays(closing, 31);
    const kpis = reportKpis(closing.finance.reports.at(-1)!)!;
    expect(kpis.cpp).toBeGreaterThan(0);
    expect(cppStatus(closing)!.text).toBe(formatMoney(kpis.cpp!));
    expect(cppStatus(closing)!.band).toBe(kpis.cppBand);
    lit.finance.capex.osp = CPP_TARGET * CPP_AMBER_MULTIPLIER * getService(lit).passings + getService(lit).passings;
    expect(cppStatus(lit)!.band).toBe(cppBand(lit.finance.capex.osp / getService(lit).passings));
    expect(cppStatus(lit)!.band).toBe('red');
    expect(cppStatus(lit)!.tip).toContain(`Target ${formatMoney(CPP_TARGET)}`);
  });

  it('gives the runway at last month’s burn in the cash tooltip', () => {
    const state = makeTestState();
    expect(runwayHint(state)).toBe('Cash on hand');
    runDays(state, 31);
    const months = Math.floor(state.finance.cash / -operatingCashFlow(state.finance.reports[0]!));
    expect(runwayHint(state)).toBe(`Cash on hand: about ${plural(months, 'month')} of runway at last month's operating loss`);
  });
});

describe('notice tones', () => {
  const notice = (kind: NoticeKind, message = 'x'): Notice => ({ id: 1, day: 0, kind, message, cabinet: null, milestone: null });

  it('celebrates milestones, warns about trouble and calls the end of the game an error', () => {
    expect(noticeTone(notice('milestone'))).toBe('ok');
    for (const kind of ['cabinetFull', 'serviceLost', 'oltFull', 'insolvencyWarning'] as const) expect(noticeTone(notice(kind))).toBe('warn');
    expect(noticeTone(notice('gameOver'))).toBe('err');
  });

  it('tones the bank’s notices: cures and payoffs are good news, missed payments and a freeze are errors', () => {
    for (const kind of ['covenantCured', 'loanPaidOff'] as const) expect(noticeTone(notice(kind))).toBe('ok');
    for (const kind of ['paymentMissed', 'creditFrozen', 'gameOver'] as const) expect(noticeTone(notice(kind))).toBe('err');
    for (const kind of ['paymentDue', 'covenantWarning', 'covenantPenalty'] as const) expect(noticeTone(notice(kind))).toBe('warn');
  });

  it('tells install pauses (trouble) from resumes (good news) by kind, not by wording', () => {
    expect(noticeTone(notice('installsPaused', `${INSTALLS_PAUSED_PREFIX}: cash is short`))).toBe('warn');
    expect(noticeTone(notice('installsResumed', `${INSTALLS_RESUMED_PREFIX}: cash is back`))).toBe('ok');
    expect(noticeTone(notice('installsResumed', 'Back in business'))).toBe('ok');
    // A cash warning is a warning whatever it says.
    expect(noticeTone(notice('insolvencyWarning', `${INSTALLS_RESUMED_PREFIX}: cash is back`))).toBe('warn');
  });
});

describe('game over subtitle', () => {
  it('says how the company ended', () => {
    expect(gameOverSubtitle('insolvent', 'Elmwood')).toBe('Elmwood has gone bankrupt.');
    expect(gameOverSubtitle('default', 'Elmwood')).toBe('Elmwood has defaulted on its loans.');
  });
});

describe('toast layout', () => {
  const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });

  it('keeps the stylesheet spot when nothing is under the toast column', () => {
    // Desktop: report panel bottom-right, toolbar down the left.
    const layout = toastLayout({ viewW: 1440, viewH: 900, baseBottom: 18, hudBottom: 120, panel: box(1128, 600, 1428, 888), toolbar: box(12, 300, 78, 600) });
    expect(layout).toEqual({ center: null, maxWidth: null, bottom: 18, maxHeight: 900 - 18 - 120 - 10 });
  });

  it('moves beside the report panel when there is room between it and the toolbar', () => {
    // 932 x 430: the centred column would reach over the panel.
    const panel = box(620, 281, 920, 418);
    const layout = toastLayout({ viewW: 932, viewH: 430, baseBottom: 18, hudBottom: 110, panel, toolbar: box(12, 60, 78, 400) });
    expect(layout.bottom).toBe(18);
    expect(layout.center! + layout.maxWidth! / 2).toBeLessThanOrEqual(panel.left);
    expect(layout.center! - layout.maxWidth! / 2).toBeGreaterThanOrEqual(78);
  });

  it('stacks above a full-width panel and toolbar on phones, no higher than the HUD', () => {
    const panel = box(8, 227, 732, 276);
    const layout = toastLayout({ viewW: 740, viewH: 360, baseBottom: 136, hudBottom: 100, panel, toolbar: box(190, 290, 550, 352) });
    expect(layout.center).toBeNull();
    expect(360 - layout.bottom).toBeLessThanOrEqual(panel.top);
    expect(layout.maxHeight).toBe(360 - layout.bottom - 100 - 10);
  });
});

describe('debug hook gate', () => {
  it('opens in dev builds, or with debug=1 in the URL', () => {
    expect(debugHookEnabled('', true)).toBe(true);
    expect(debugHookEnabled('', false)).toBe(false);
    expect(debugHookEnabled('?debug=1', false)).toBe(true);
    expect(debugHookEnabled('?seed=5&debug=1', false)).toBe(true);
    expect(debugHookEnabled('?debug=0', false)).toBe(false);
    expect(debugHookEnabled('?debug', false)).toBe(false);
    expect(debugHookEnabled('?seed=1', false)).toBe(false);
  });

  it('drops only the seed when the game in play changes', () => {
    expect(searchWithoutSeed('?seed=5&debug=1')).toBe('?debug=1');
    expect(searchWithoutSeed('?debug=1&seed=5')).toBe('?debug=1');
    expect(searchWithoutSeed('?seed=5')).toBe('');
    expect(searchWithoutSeed('')).toBe('');
    expect(searchWithoutSeed('?debug=1')).toBe('?debug=1');
  });
});
