// Pure models behind the economy UI: report rows (financing and round-4
// operations included), the month-close toast, milestone progress, the rate
// card (round-4 rules included), notice tones, the
// game-over subtitle and the debug-hook gate (the pricing preview moved to
// pricingPanel.test.ts and the HUD chips to hud.test.ts in round 4). Money is checked against balance.ts constants and
// sim results, never literal dollar amounts.

import { describe, expect, it } from 'vitest';
import {
  CABINET_COST,
  CPP_AMBER_MULTIPLIER,
  CPP_TARGET,
  ENGINEERING_FEE,
  INSTALL_COST_HOME,
  INSTALL_COST_MDU_UNIT,
  INSTALL_COST_SMB,
  MAKE_READY_COST_PER_POLE,
  MDU_ROUTER_COST,
  OLT_CARD_COST,
  OLT_START_PON_PORTS,
  OVERHEAD_PER_MONTH,
  PERMIT_FEE_AERIAL,
  PERMIT_FEE_UNDERGROUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  SPLITTER_COST,
  SUPPORT_COST_PER_SUB_PER_MONTH,
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
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  FROZEN_ACCELERATION_CLOSES,
  FROZEN_SWEEP_RESERVE,
  FROZEN_SWEEP_SHARE,
  FUNDING_CUSHION_MONTHS,
  GRANDFATHER_MONTHS_DEFAULT,
  GRANDFATHER_MONTHS_MAX,
  GRANDFATHER_STEP_SHARE,
  INCUMBENT_PROMO_CHURN,
  INCUMBENT_PROMO_DISCOUNT,
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
  PRICE_STEP_CHURN_PER_RISE,
  PROMO_MAX_PERCENT_OFF,
  PROMO_STEP_SHARE,
  REPAIR_BASE_AERIAL,
  REPAIR_BASE_UNDERGROUND,
  REPAIR_PER_FT_AERIAL,
  REPAIR_PER_FT_UNDERGROUND,
  STORM_AERIAL_DAMAGE_CHANCE,
  STORM_CHANCE_PER_DAY,
  STORM_START_DAY,
  STORM_UNDERGROUND_DAMAGE_CHANCE,
} from '../sim/balance';
import { formatDate } from '../sim/calendar';
import { runDays } from '../sim/game';
import { operatingCashFlow, reportKpis } from '../sim/metrics';
import { MILESTONES } from '../sim/milestones';
import { INSTALLS_PAUSED_PREFIX, INSTALLS_RESUMED_PREFIX } from '../sim/sales';
import { addLivePlant, makeGridCity, makeTestState } from '../sim/testing/fixtures';
import type { DebtStats, GameState, MonthlyReport, Notice, NoticeKind, OpsStats } from '../sim/types';
import { debugHookEnabled, searchWithoutSeed } from './debugHook';
import {
  formatBpsDelta,
  formatDayRange,
  formatFeet,
  formatMoney,
  formatPerFt,
  formatPercent,
  formatPercentFine,
  formatRate,
  formatRatio,
  formatSignedMoney,
  plural,
} from './format';
import { gameOverSubtitle } from './gameOverDialog';
import { milestoneRows } from './milestonesPanel';
import { noticeTone, toastLayout } from './overlays';
import { financingRows, monthClosedMessage, reportRows, subscriberMovements } from './panel';
import type { ReportRow } from './panel';
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
      'repairs',
      'passings',
      'outages',
      'outageCredits',
      'priceChurn',
      'tierMoves',
      'incumbentPromos',
      'interest',
      'principal',
      'sweep',
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
    // Round-4 figures read – too, and the panel leaves them out.
    for (const key of ['repairs', 'outages', 'outageCredits', 'priceChurn', 'tierMoves', 'incumbentPromos', 'sweep'] as const) {
      expect(row(rows, key)).toMatchObject({ value: '–', quiet: true });
    }
  });
});

describe('round-4 report rows', () => {
  const ops = (over: Partial<OpsStats> = {}): OpsStats => ({
    lastNoticeId: 12,
    tierMoves: 0,
    priceChurn: 0,
    outageChurn: 0,
    incumbentChurn: 0,
    outageUnitDays: 0,
    storms: 0,
    spansDamaged: 0,
    repairs: 0,
    incumbentPromos: 0,
    mrr: 0,
    outageCredits: 0,
    ...over,
  });
  const report = (o: OpsStats | undefined, totals: MonthlyReport['totals'] = {}, debt?: DebtStats): MonthlyReport => ({
    year: 2028,
    month: 5,
    totals,
    net: 0,
    cashEnd: 0,
    passings: 10,
    ops: o,
    debt,
  });

  it('shows repairs, outages, price steps, tier moves and incumbent promos from report.ops', () => {
    const o = ops({ outageUnitDays: 340, storms: 2, spansDamaged: 3, outageChurn: 4, priceChurn: 6, tierMoves: 21, incumbentPromos: 1, incumbentChurn: 5, repairs: 7_300 });
    const rows = reportRows(report(o, { repair: -7_300 }));
    expect(row(rows, 'repairs')).toMatchObject({ value: formatMoney(7_300), detail: '3 spans damaged', quiet: false });
    expect(row(rows, 'outages')).toMatchObject({ value: '340 sub-days', detail: '2 storms, 4 cancelled', quiet: false });
    expect(row(rows, 'priceChurn')).toMatchObject({ value: '6', quiet: false });
    expect(row(rows, 'tierMoves')).toMatchObject({ value: '21', quiet: false });
    expect(row(rows, 'incumbentPromos')).toMatchObject({ value: '1', detail: '5 cancelled', quiet: false });
    expect(row(rows, 'outageCredits')).toMatchObject({ value: '$0', quiet: true });
    for (const r of rows) expect(`${r.value} ${r.detail ?? ''}`).not.toMatch(/NaN|undefined|null|Infinity/);
  });

  it('shows the outage credits (billing not charged for outage days) right after the outages, quiet when $0', () => {
    const rows = reportRows(report(ops({ outageUnitDays: 340, storms: 1, outageCredits: 812 })));
    expect(row(rows, 'outageCredits')).toMatchObject({ label: 'Outage credits', value: formatMoney(812), tone: null, quiet: false });
    expect(row(rows, 'outageCredits').hint).toMatch(/not charged/);
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf('outageCredits')).toBe(keys.indexOf('outages') + 1);
    expect(row(reportRows(report(ops())), 'outageCredits')).toMatchObject({ value: '$0', quiet: true });
  });

  it('reads zero for a quiet round-4 month, and the panel leaves those rows out', () => {
    const rows = reportRows(report(ops()));
    expect(row(rows, 'repairs')).toMatchObject({ value: '$0', detail: null, quiet: true });
    expect(row(rows, 'outages')).toMatchObject({ value: '0 sub-days', quiet: true });
    for (const key of ['priceChurn', 'tierMoves', 'incumbentPromos'] as const) expect(row(rows, key)).toMatchObject({ value: '0', quiet: true });
    // Rows from before round 4 never go quiet.
    for (const r of rows) if (!['repairs', 'outages', 'outageCredits', 'priceChurn', 'tierMoves', 'incumbentPromos', 'sweep'].includes(r.key)) expect(r.quiet).toBeUndefined();
  });

  it('shows the frozen line’s sweep, or – on a report from before round 4', () => {
    const debt: DebtStats = {
      creditBalance: 90_000,
      termBalance: 0,
      creditLimit: 0,
      arr: 100_000,
      annualOperatingCashFlow: 50_000,
      annualDebtService: 10_000,
      leverageX100: 180,
      coverageX100: 500,
      stage: 'frozen',
      averageRateBps: 1_000,
      missedPayment: false,
      sweep: 6_500,
      frozenCloses: 3,
      accelerationClosesLeft: null,
    };
    expect(row(financingRows(report(ops(), {}, debt)), 'sweep')).toMatchObject({ value: formatMoney(6_500), detail: '3 frozen closes in a row', quiet: false });
    expect(row(financingRows(report(ops(), {}, { ...debt, sweep: 0, frozenCloses: 0 })), 'sweep')).toMatchObject({ value: '$0', detail: null, quiet: true });
    const { sweep: _sweep, frozenCloses: _closes, accelerationClosesLeft: _left, ...round3 } = debt;
    expect(row(financingRows(report(undefined, {}, round3)), 'sweep')).toMatchObject({ value: '–', quiet: true });
  });

  it('mentions storms and a sweep in the month-close toast', () => {
    const base = report(ops({ storms: 2 }));
    expect(monthClosedMessage(base)).toBe('May 2028 closed: net $0, 10 passings, 2 storms');
    const swept = report(ops(), {}, {
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
      missedPayment: false,
      sweep: 4_000,
    });
    expect(monthClosedMessage(swept)).toBe(`May 2028 closed: net $0, 10 passings, ${formatMoney(4_000)} swept`);
    expect(monthClosedMessage(report(ops()))).toBe('May 2028 closed: net $0, 10 passings');
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

  it('lists the round-4 rules: storms, pricing and the frozen line, from balance.ts', () => {
    expect(sections.map((s) => s.title)).toEqual(expect.arrayContaining(['Storms and dig-ins', 'Pricing', 'Frozen line and loan rules']));
    expect(value('Storm season')).toBe(`from ${formatDate(STORM_START_DAY)}`);
    expect(value('Storm chance')).toBe(`1 in ${Math.round(1 / STORM_CHANCE_PER_DAY)} a day`);
    expect(value('Aerial span damaged')).toBe(`${formatPercentFine(STORM_AERIAL_DAMAGE_CHANCE)} per severity`);
    expect(value('Underground span damaged')).toBe(`${formatPercentFine(STORM_UNDERGROUND_DAMAGE_CHANCE)} per severity`);
    expect(value('Aerial outage')).toBe(formatDayRange(OUTAGE_DAYS_AERIAL_MIN, OUTAGE_DAYS_AERIAL_MAX));
    expect(value('Underground outage')).toBe(formatDayRange(OUTAGE_DAYS_UNDERGROUND_MIN, OUTAGE_DAYS_UNDERGROUND_MAX));
    expect(value('Aerial repair')).toBe(`${formatMoney(REPAIR_BASE_AERIAL)} + ${formatPerFt(REPAIR_PER_FT_AERIAL)}`);
    expect(value('Underground repair')).toBe(`${formatMoney(REPAIR_BASE_UNDERGROUND)} + ${formatPerFt(REPAIR_PER_FT_UNDERGROUND)}`);
    expect(value('Outage churn')).toBe(`${formatPercentFine(OUTAGE_CHURN_BASE)} + ${formatPercentFine(OUTAGE_CHURN_PER_DAY)} a day out`);
    expect(value('Price lock on a rise')).toBe(plural(GRANDFATHER_MONTHS_DEFAULT, 'month'));
    expect(value('Price-step churn')).toBe(`${formatPercentFine(PRICE_STEP_CHURN_PER_RISE / 10)} per 10% rise`);
    expect(value('After a price lock')).toBe(`${formatPercent(GRANDFATHER_STEP_SHARE)} of that`);
    expect(value('After an intro promo')).toBe(`${formatPercent(PROMO_STEP_SHARE)} of that`);
    expect(value('Intro promo')).toBe(`up to ${PROMO_MAX_PERCENT_OFF}% off`);
    expect(value('Incumbent promo trigger')).toBe(`${formatPercent(INCUMBENT_PROMO_TAKE_RATE)} take rate`);
    expect(value('Incumbent promo')).toBe(`${formatMoney(INCUMBENT_PROMO_DISCOUNT)} off for ${plural(INCUMBENT_PROMO_MONTHS, 'month')}`);
    expect(value('Incumbent promo churn')).toBe(`+${formatPercentFine(INCUMBENT_PROMO_CHURN)} a month`);
    expect(value('Frozen sweep')).toBe(`${formatPercent(FROZEN_SWEEP_SHARE)} of cash flow`);
    expect(value('Loans called')).toBe(`after ${plural(FROZEN_ACCELERATION_CLOSES, 'frozen close')}`);
    expect(value('Call warning')).toBe(`${plural(ACCELERATION_WARNING_CLOSES, 'close')} ahead`);
    expect(value('Funding cushion')).toBe(plural(FUNDING_CUSHION_MONTHS, 'month'));
    const notes = sections.flatMap((s) => s.rows).map((r) => r.note ?? '');
    expect(notes.some((n) => n.includes(formatMoney(FROZEN_SWEEP_RESERVE)))).toBe(true);
    expect(notes.some((n) => n.includes(plural(ACCELERATION_CLOSES, 'close')))).toBe(true);
    expect(notes.some((n) => n.includes(String(GRANDFATHER_MONTHS_MAX)))).toBe(true);
    expect(notes.some((n) => n.includes(formatPercent(OUTAGE_CHURN_MAX)))).toBe(true);
    expect(notes.some((n) => n.includes(plural(INCUMBENT_PROMO_QUIET_MONTHS, 'month')))).toBe(true);
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

  it('tones the round-4 notices: restored service and ended promos are good news, called loans an error, the rest warnings', () => {
    for (const kind of ['serviceRestored', 'incumbentPromoEnded'] as const) expect(noticeTone(notice(kind))).toBe('ok');
    expect(noticeTone(notice('loansCalled'))).toBe('err');
    for (const kind of ['debtSwept', 'accelerationWarning', 'tierRetired', 'priceStep', 'incumbentPromo', 'storm', 'digIn'] as const) {
      expect(noticeTone(notice(kind))).toBe('warn');
    }
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
