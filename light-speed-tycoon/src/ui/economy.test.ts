// Pure models behind the economy UI: report rows (financing and round-4
// operations included; round 4c/4d: the full books' "More figures", with the
// old report panel's other figures checked in the books' tiles and money and
// the new panel's lines), the month-close toast, milestone progress, the rate
// card (round-4 rules included; round 4c/4d's running costs that grow with
// the company), the report's overhead lines, notice tones, the
// game-over subtitle and the debug-hook gate (the pricing preview moved to
// pricingPanel.test.ts and the HUD chips to hud.test.ts in round 4). Money is checked against balance.ts constants and
// sim results, never literal dollar amounts.

import { describe, expect, it } from 'vitest';
import {
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  AERIAL_COST_PER_FT,
  BASE_RATE_BPS,
  CABINET_COST,
  CABINET_REACH_FT,
  CAMPAIGN_COST_MIN,
  CAMPAIGN_COST_PER_UNIT,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  CREDIT_LINE_EXTRA_BPS,
  ENGINEERING_FEE,
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
  INSTALL_COST_HOME,
  INSTALL_COST_MDU_UNIT,
  INSTALL_COST_SMB,
  LEVERAGE_SPREAD_BANDS,
  LEVERAGE_SPREAD_MAX_BPS,
  MAKE_READY_COST_PER_POLE,
  MDU_ROUTER_COST,
  OLT_CARD_COST,
  OLT_START_PON_PORTS,
  OUTAGE_CHURN_BASE,
  OUTAGE_CHURN_MAX,
  OUTAGE_CHURN_PER_DAY,
  OUTAGE_DAYS_AERIAL_MAX,
  OUTAGE_DAYS_AERIAL_MIN,
  OUTAGE_DAYS_UNDERGROUND_MAX,
  OUTAGE_DAYS_UNDERGROUND_MIN,
  OVERHEAD_BASE_PER_MONTH,
  OVERHEAD_PER_CABINET_PER_MONTH,
  OVERHEAD_PER_CUSTOMER_PER_MONTH,
  OVERHEAD_PER_MILE_PER_MONTH,
  PENALTY_STEP_UP_BPS,
  PERMIT_FEE_AERIAL,
  PERMIT_FEE_UNDERGROUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  PRICE_STEP_CHURN_PER_RISE,
  PROMO_BOOST_YOUNG_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  PROMO_STEP_SHARE,
  REFERRAL_CREDIT,
  REPAIR_BASE_AERIAL,
  REPAIR_BASE_UNDERGROUND,
  REPAIR_PER_FT_AERIAL,
  REPAIR_PER_FT_UNDERGROUND,
  SPLITTER_COST,
  STORM_AERIAL_DAMAGE_CHANCE,
  STORM_CHANCE_PER_DAY,
  STORM_EXPOSURE_CANOPY,
  STORM_START_DAY,
  STORM_UNDERGROUND_DAMAGE_CHANCE,
  SUPPORT_LEVELS,
  TERM_EXTRA_BPS,
  TERM_LOAN_YEARS,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
} from '../sim/balance';
import { briefingMoney, buildBriefing } from '../sim/advisor';
import { formatDate } from '../sim/calendar';
import { runDays } from '../sim/game';
import { operatingCashFlow, reportKpis } from '../sim/metrics';
import { MILESTONES } from '../sim/milestones';
import { INSTALLS_PAUSED_PREFIX, INSTALLS_RESUMED_PREFIX } from '../sim/sales';
import { addLivePlant, makeGridCity, makeTestState } from '../sim/testing/fixtures';
import type { DebtStats, GameState, MoneyLineKey, MonthlyReport, Notice, NoticeKind, OpsStats } from '../sim/types';
import { booksView, moneyBars, moneyGroups, wordsText } from './briefing';
import { debugHookEnabled, searchWithoutSeed } from './debugHook';
import {
  formatBpsDelta,
  formatDayRange,
  formatFeet,
  formatMoney,
  formatMonthLong,
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
import { financingRows, monthClosedMessage, reportPanelView, reportRows, subscriberMovements } from './panel';
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

// Round 4c/4d: the report panel became a small version of the month summary
// (panel.test.ts); every figure of its old list is in the full books: the
// tiles and the itemized money (briefing.ts booksView / moneyGroups /
// moneyBars) and the "More figures" rows built in panel.ts (reportRows).

/** The full books' money view for one closed month (what the panel's books and a month's summary itemize). */
const booksMoney = (report: MonthlyReport) => {
  const figures = { money: briefingMoney([report]), span: 1, headline: { cpp: reportKpis(report)?.cpp ?? null, cppTarget: CPP_TARGET } };
  const groups = moneyGroups(figures);
  const line = (key: MoneyLineKey) => groups.flatMap((g) => g.lines).find((l) => l.key === key) ?? null;
  return { bars: moneyBars(figures), groups, line };
};

describe('report rows', () => {
  it('lists the KPIs, support, operations and bank figures the full books do not show elsewhere, formatted from reportKpis', () => {
    const state = litGame();
    const report = state.finance.reports.at(-1)!;
    expect(report.stats!.subscribers).toBeGreaterThan(0);
    const kpis = reportKpis(report)!;
    const rows = reportRows(report);
    expect(rows.map((r) => r.key)).toEqual([
      'arpu',
      'cpga',
      'costPerConnection',
      'operatingCashFlow',
      'support',
      'outages',
      'outageCredits',
      'priceChurn',
      'tierMoves',
      'incumbentPromos',
      'sweep',
      'debt',
      'leverage',
      'coverage',
    ]);
    expect(row(rows, 'arpu').value).toBe(`${formatMoney(kpis.arpu!)}/mo`);
    expect(row(rows, 'operatingCashFlow').value).toBe(formatSignedMoney(operatingCashFlow(report)));
    // The live plant was free, so no cost per passing to color... but connections cost installs.
    expect(row(rows, 'costPerConnection').value).toBe(formatMoney(kpis.costPerConnection!));
    for (const r of rows) expect(r.value).not.toMatch(/NaN|undefined|null|Infinity/);
    // Trade terms only in brackets after their plain meaning.
    expect(row(rows, 'arpu').label).toBe('Average bill per customer (ARPU)');
    expect(row(rows, 'cpga').label).toBe('Marketing per new customer (CPGA)');
    expect(row(rows, 'operatingCashFlow').label).toBe('Bills less running costs (operating cash flow)');

    // The old list's other figures are the full books' tiles and money lines.
    const books = booksView(buildBriefing(state, 1)!);
    const tile = (key: string) => books.tiles.find((t) => t.key === key)!;
    expect(tile('net').value).toBe(formatSignedMoney(report.net));
    expect(tile('subscribers').value).toBe(String(report.stats!.subscribers));
    expect(tile('subscribers').detail).toBe(subscriberMovements(report));
    expect(tile('takeRate').value).toBe(formatPercent(kpis.takeRate!));
    expect(tile('passings').value).toBe(report.passings.toLocaleString('en-US'));
    expect(books.moneyIn.find((l) => l.key === 'bills')!.value).toBe(formatMoney(kpis.revenue));
    const running = books.moneyOut.find((g) => g.key === 'running')!;
    const overhead = running.lines.filter((l) => l.key.startsWith('overhead')).reduce((n, l) => n + l.amount, 0);
    expect(overhead).toBe(-(report.totals.overhead ?? 0));
    // Pole rent is itemized when the month paid any (the books leave $0 lines out).
    const poleRent = running.lines.find((l) => l.key === 'poleRent') ?? null;
    if (report.totals.poleRent) expect(poleRent!.value).toBe(formatMoney(-report.totals.poleRent));
    else expect(poleRent).toBeNull();
    // The books list the report's own rows that have something to say.
    expect(books.more).toEqual(rows.filter((r) => !r.quiet));
    expect(books.moreTitle).toBe(`More figures for ${formatMonthLong(report.year, report.month)}`);
  });

  it('colors negative money red and says – with nothing to divide by; the panel colors the cost per home passed by band', () => {
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
    expect(row(rows, 'operatingCashFlow')).toMatchObject({ value: formatSignedMoney(-400), tone: 'negative' });
    // The month's net, in words: the panel's cash line, and the books' net tile in red.
    const lost = makeTestState();
    lost.finance.reports.push(base);
    expect(reportPanelView(lost).cash).toMatchObject({ headline: `Cash went down ${formatMoney(400)}`, direction: 'down' });
    expect(booksView(buildBriefing(lost, 1)!).tiles.find((t) => t.key === 'net')).toMatchObject({ value: formatSignedMoney(-400), tone: 'negative' });
    // No gross adds: no cost per gross add.
    expect(row(rows, 'cpga').value).toBe('–');
    expect(subscriberMovements(base)).toBe('+0 new, 1 churned, 2 lost service');

    // The cost per home passed's band, in color and in words, where the panel shows it: a building month.
    const building = (capexOsp: number) => {
      const r = { ...base, totals: { ...base.totals, construction: -1_000 }, net: -1_400, stats: { ...base.stats!, capexOsp } };
      const state = makeTestState();
      state.finance.reports.push(r);
      return reportPanelView(state).building!;
    };
    expect(building(CPP_TARGET * 100)).toMatchObject({ band: 'green', bandText: 'Within target' });
    expect(building(CPP_TARGET * 100).text).toContain(`${formatMoney(CPP_TARGET)} per home passed`);
    expect(building(CPP_TARGET * CPP_AMBER_MULTIPLIER * 100)).toMatchObject({ band: 'amber', bandText: 'Over target' });
    expect(building(CPP_TARGET * CPP_AMBER_MULTIPLIER * 100 + 100)).toMatchObject({ band: 'red', bandText: 'Far over target' });
  });

  it('reads – for KPIs with nothing to divide by', () => {
    const state = makeTestState();
    runDays(state, 31);
    const report = state.finance.reports[0]!;
    const rows = reportRows(report);
    for (const key of ['arpu', 'cpga', 'costPerConnection'] as const) expect(row(rows, key).value).toBe('–');
    // The books' tiles and the panel's customers line say the same of the take rate and the cost per home.
    const books = booksView(buildBriefing(state, 1)!);
    expect(books.tiles.find((t) => t.key === 'subscribers')!.value).toBe('0');
    expect(books.tiles.find((t) => t.key === 'takeRate')!.value).toBe('–');
    expect(books.tiles.find((t) => t.key === 'cpp')).toMatchObject({ value: '–', tone: null });
    expect(wordsText(reportPanelView(state).customers!)).toBe('0 customers · no homes passed yet');
  });

  it('reads – for every KPI of a report migrated from a v1 save (no stats)', () => {
    const v1: MonthlyReport = { year: 2027, month: 1, totals: { construction: -5000, poleRent: -20 }, net: -5020, cashEnd: 1, passings: 12 };
    const rows = reportRows(v1);
    for (const key of ['arpu', 'cpga', 'costPerConnection'] as const) expect(row(rows, key).value).toBe('–');
    expect(row(rows, 'operatingCashFlow').value).toBe(formatSignedMoney(operatingCashFlow(v1)));
    for (const key of ['debt', 'leverage', 'coverage'] as const) expect(row(rows, key)).toMatchObject({ value: '–', quiet: true });
    // Round-4 figures read – too, and the books leave them out.
    for (const key of ['support', 'outages', 'outageCredits', 'priceChurn', 'tierMoves', 'incumbentPromos', 'sweep'] as const) {
      expect(row(rows, key)).toMatchObject({ value: '–', quiet: true });
    }
    // Its money is itemized all the same (pole rent and building), and the panel says the cash change without a customers line.
    const money = booksMoney(v1);
    expect(money.line('poleRent')!.value).toBe(formatMoney(20));
    expect(money.line('construction')!.value).toBe(formatMoney(5_000));
    const state = makeTestState();
    state.finance.reports.push(v1);
    const view = reportPanelView(state);
    expect(view.customers).toBeNull();
    expect(view.cash!.text).toBe(`Cash went down ${formatMoney(5_020)} · ${formatMoney(1)} left`);
    // The books: the net, no customer figures, the homes passed, and no customer bills.
    const books = booksView(buildBriefing(state, 1)!);
    const tile = (key: string) => books.tiles.find((t) => t.key === key)!;
    expect(tile('net').value).toBe(formatSignedMoney(-5020));
    expect(tile('subscribers')).toMatchObject({ value: '–', detail: null });
    expect(tile('takeRate').value).toBe('–');
    expect(tile('passings').value).toBe('12');
    expect(books.moneyIn.find((l) => l.key === 'bills')).toBeUndefined();
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
    overhead: null,
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

  it('shows outages (with the spans damaged), price steps, tier moves and the cable company’s promos from report.ops; repairs in the money', () => {
    const o = ops({ outageUnitDays: 340, storms: 2, spansDamaged: 3, outageChurn: 4, priceChurn: 6, tierMoves: 21, incumbentPromos: 1, incumbentChurn: 5, repairs: 7_300 });
    const r = report(o, { repair: -7_300 });
    const rows = reportRows(r);
    expect(row(rows, 'outages')).toMatchObject({ value: '340 customer-days', detail: '2 storms, 3 spans damaged, 4 cancelled', quiet: false });
    expect(row(rows, 'priceChurn')).toMatchObject({ value: '6', quiet: false });
    expect(row(rows, 'tierMoves')).toMatchObject({ value: '21', quiet: false });
    expect(row(rows, 'incumbentPromos')).toMatchObject({ value: '1', detail: '5 cancelled', quiet: false });
    expect(row(rows, 'outageCredits')).toMatchObject({ value: '$0', quiet: true });
    for (const r2 of rows) expect(`${r2.value} ${r2.detail ?? ''}`).not.toMatch(/NaN|undefined|null|Infinity/);
    // The repairs are a running cost in the books' money out.
    expect(booksMoney(r).line('repair')).toMatchObject({ label: 'Storm and dig-in repairs', value: formatMoney(7_300) });
    // Spans damaged without an outage (a dig-in on an empty street) still show.
    expect(row(reportRows(report(ops({ spansDamaged: 1 }))), 'outages')).toMatchObject({ detail: '0 storms, 1 span damaged, 0 cancelled', quiet: false });
  });

  it('shows the outage credits (billing not charged for outage days) right after the outages, quiet when $0', () => {
    const rows = reportRows(report(ops({ outageUnitDays: 340, storms: 1, outageCredits: 812 })));
    expect(row(rows, 'outageCredits')).toMatchObject({ label: 'Outage credits', value: formatMoney(812), tone: null, quiet: false });
    expect(row(rows, 'outageCredits').hint).toMatch(/not charged/);
    const keys = rows.map((r) => r.key);
    expect(keys.indexOf('outageCredits')).toBe(keys.indexOf('outages') + 1);
    expect(row(reportRows(report(ops())), 'outageCredits')).toMatchObject({ value: '$0', quiet: true });
  });

  it('reads zero for a quiet round-4 month, and the books leave those rows out', () => {
    const rows = reportRows(report(ops()));
    expect(row(rows, 'outages')).toMatchObject({ value: '0 customer-days', quiet: true });
    // No repairs: no repairs line in the money either.
    expect(booksMoney(report(ops())).line('repair')).toBeNull();
    for (const key of ['priceChurn', 'tierMoves', 'incumbentPromos'] as const) expect(row(rows, key)).toMatchObject({ value: '0', quiet: true });
    // The KPIs never go quiet.
    for (const key of ['arpu', 'cpga', 'costPerConnection', 'operatingCashFlow'] as const) expect(row(rows, key).quiet).toBe(false);
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
    expect(row(financingRows(report(ops(), {}, debt)), 'sweep')).toMatchObject({ label: 'Spare cash the bank took', value: formatMoney(6_500), detail: '3 frozen closes in a row', quiet: false });
    expect(row(financingRows(report(ops(), {}, { ...debt, sweep: 0, frozenCloses: 0 })), 'sweep')).toMatchObject({ value: '$0', detail: null, quiet: true });
    const { sweep: _sweep, frozenCloses: _closes, accelerationClosesLeft: _left, ...round3 } = debt;
    expect(row(financingRows(report(undefined, {}, round3)), 'sweep')).toMatchObject({ value: '–', quiet: true });
  });

  it('itemizes the overhead’s base / per-customer / plant lines in the books when the close recorded them, and the support part of the per-customer line', () => {
    const lines = { base: 2_000, perCustomer: 1_480, support: 960, perPlant: 730 };
    const total = lines.base + lines.perCustomer + lines.perPlant;
    const r = report(ops({ overhead: lines }), { overhead: -total });
    const money = booksMoney(r);
    const running = money.groups.find((g) => g.key === 'running')!;
    expect(running.total).toBe(total);
    expect(running.lines.map((l) => [l.key, l.label, l.value])).toEqual([
      ['overheadBase', 'Base costs (any size)', formatMoney(lines.base)],
      ['overheadCustomers', 'Per customer (support and billing)', formatMoney(lines.perCustomer)],
      ['overheadPlant', 'Per cabinet and mile of cable', formatMoney(lines.perPlant)],
    ]);
    expect(row(reportRows(r), 'support')).toMatchObject({ label: 'Customer support', value: formatMoney(lines.support), detail: 'included in the per-customer cost', quiet: false });
    // A report from an earlier build (no lines): the overhead in one line, no support figure.
    const old = report(ops(), { overhead: -9_000 });
    expect(booksMoney(old).groups.find((g) => g.key === 'running')!.lines.map((l) => [l.key, l.value])).toEqual([['overhead', formatMoney(9_000)]]);
    expect(row(reportRows(old), 'support')).toMatchObject({ value: '–', quiet: true });
    expect(booksMoney(report(undefined, {})).groups.find((g) => g.key === 'running')!.total).toBe(0);
  });

  it('records the overhead’s lines at a real close, adding up to the month’s overhead', () => {
    const last = litGame(95).finance.reports.at(-1)!;
    const lines = last.ops?.overhead;
    expect(lines).toBeTruthy();
    expect(lines!.base + lines!.perCustomer + lines!.perPlant).toBe(-(last.totals.overhead ?? 0));
    const money = booksMoney(last);
    expect(money.line('overheadBase')!.value).toBe(formatMoney(lines!.base));
    expect(money.line('overheadPlant')!.value).toBe(formatMoney(lines!.perPlant));
    if (lines!.perCustomer > 0) expect(money.line('overheadCustomers')!.value).toBe(formatMoney(lines!.perCustomer));
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

  it('shows debt, leverage and coverage at month end, and the month’s interest, principal and borrowing in the books’ money', () => {
    const r = report(debt(), { interest: -2_345, principal: -6_100, loanProceeds: 50_000 });
    const rows = financingRows(r);
    expect(row(rows, 'debt')).toMatchObject({ value: formatMoney(412_000), quiet: false });
    expect(row(rows, 'leverage')).toMatchObject({ label: 'Years of profit (leverage)', value: '4.58×', tone: null, detail: `limit ${formatRatio(COVENANT_MAX_LEVERAGE)}`, quiet: false });
    expect(row(rows, 'coverage')).toMatchObject({ label: 'Earned per $1 of loan payments (coverage)', value: '1.50×', tone: null, detail: `min ${formatRatio(COVENANT_MIN_COVERAGE)}`, quiet: false });
    const money = booksMoney(r);
    expect(money.line('interest')!.value).toBe(formatMoney(2_345));
    expect(money.line('principal')!.value).toBe(formatMoney(6_100));
    expect(money.groups.find((g) => g.key === 'loans')!.total).toBe(2_345 + 6_100);
    expect(money.bars.in.segments.find((s) => s.key === 'borrowed')).toMatchObject({ label: 'Borrowed', value: formatMoney(50_000) });
  });

  it('reads $0 for money that did not move in a round-3 month, and – for nothing scheduled; with nothing owed the books leave the bank figures out', () => {
    const r = report(debt({ creditBalance: 0, termBalance: 0, leverageX100: 0, coverageX100: null }));
    const rows = financingRows(r);
    expect(row(rows, 'debt')).toMatchObject({ value: '$0', quiet: true });
    expect(row(rows, 'leverage')).toMatchObject({ value: '0.00×', quiet: true });
    expect(row(rows, 'coverage')).toMatchObject({ value: '–', quiet: true });
    // No loan payments and no borrowing in the money either.
    const money = booksMoney(r);
    expect(money.groups.find((g) => g.key === 'loans')).toMatchObject({ total: 0, lines: [] });
    expect(money.bars.in.segments.some((s) => s.key === 'borrowed')).toBe(false);
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

  it('says operating cash flow is before loans, and the panel’s cash change is the whole month, borrowing included', () => {
    // A month whose net is everything in and out: bills, overhead, interest and the borrowing.
    const r = { ...report(debt(), { revenue: 9_000, overhead: -4_000, interest: -1_000, loanProceeds: 20_000 }), net: 24_000, cashEnd: 100_000 };
    const rows = reportRows(r);
    expect(row(rows, 'operatingCashFlow')).toMatchObject({ value: formatSignedMoney(5_000) });
    expect(row(rows, 'operatingCashFlow').hint).toContain('before building, installs and loans');
    const state = makeTestState();
    state.finance.reports.push(r);
    const view = reportPanelView(state);
    expect(view.cash!.headline).toBe(`Cash went up ${formatMoney(24_000)}`);
    expect(view.money!.in.total - view.money!.out.total).toBe(24_000);
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
    expect(value('Pole rent')).toBe(`${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}/mo`);
    expect(value('Target')).toBe(formatMoney(CPP_TARGET));
    expect(value('Amber')).toBe(`up to ${formatMoney(CPP_TARGET * CPP_AMBER_MULTIPLIER)}`);
    expect(value('Red')).toBe(`above ${formatMoney(CPP_TARGET * CPP_AMBER_MULTIPLIER)}`);
    const splitter = sections.flatMap((s) => s.rows).find((r) => r.label.startsWith('Splitter'));
    expect(splitter?.value).toBe(formatMoney(SPLITTER_COST));
  });

  it('lists the running costs that grow with the company: base, per customer, each support level, per cabinet, per mile, pole rent', () => {
    const running = sections.find((s) => s.title === 'Running costs')!;
    expect(running.rows.map((r) => r.label)).toEqual([
      'Base overhead',
      'Per customer',
      ...(['basic', 'good', 'great'] as const).map((id) => `${SUPPORT_LEVELS[id].name} support`),
      'Per cabinet',
      'Per mile of cable',
      'Pole rent',
    ]);
    expect(value('Base overhead')).toBe(`${formatMoney(OVERHEAD_BASE_PER_MONTH)}/mo`);
    expect(value('Per customer')).toBe(`${formatMoney(OVERHEAD_PER_CUSTOMER_PER_MONTH)}/mo`);
    for (const level of Object.values(SUPPORT_LEVELS)) expect(value(`${level.name} support`)).toBe(`${formatMoney(level.costPerSub)}/mo`);
    expect(value('Per cabinet')).toBe(`${formatMoney(OVERHEAD_PER_CABINET_PER_MONTH)}/mo`);
    expect(value('Per mile of cable')).toBe(`${formatMoney(OVERHEAD_PER_MILE_PER_MONTH)}/mo`);
    // The default level says so; each says where to change it.
    expect(running.rows.find((r) => r.label === `${SUPPORT_LEVELS.good.name} support`)!.note).toMatch(/where every company starts/);
    for (const id of ['basic', 'great'] as const) expect(running.rows.find((r) => r.label === `${SUPPORT_LEVELS[id].name} support`)!.note).not.toMatch(/where every company starts/);
    // The old flat overhead is gone from the card.
    expect(running.rows.some((r) => r.label === 'Overhead' || r.label === 'Customer support')).toBe(false);
  });

  it('lists the customer levers (round 4c/4d): campaigns, referral credits and the intro promo, and tree-lined streets under storms', () => {
    const customers = sections.find((s) => s.title === 'Customers')!;
    expect(customers.rows.map((r) => r.label)).toEqual(['Neighborhood campaign', 'Campaign length', 'Referral credit', 'Intro promo reach']);
    expect(value('Neighborhood campaign')).toBe(`${formatMoney(CAMPAIGN_COST_PER_UNIT)} a home`);
    expect(customers.rows[0]!.note).toContain(formatMoney(CAMPAIGN_COST_MIN));
    expect(value('Referral credit')).toBe(`${formatMoney(REFERRAL_CREDIT)} off, both sides`);
    expect(value('Intro promo reach')).toBe(`streets lit within ${plural(PROMO_BOOST_YOUNG_MONTHS, 'month')}`);
    expect(value('Tree-lined streets')).toBe(`up to ${1 + STORM_EXPOSURE_CANOPY} times the storm damage`);
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
