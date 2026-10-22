// The report panel's view model (panel.ts, round 4c/4d: a small version of
// the month summary): the cash line, money in and money out on one shared
// scale that add up to the month's cash change exactly, the customers line,
// the building line only while building, the bank's word only with debt (or
// trouble), the spending so far, the first month with no report, what stays
// on screen collapsed, and no jargon anywhere. Built from real sim states
// (the same figures the month summary shows) and from reports written for a
// case. Money is checked against sim results and balance.ts constants, never
// literal dollar amounts.

import { describe, expect, it } from 'vitest';
import { buildBriefing } from '../sim/advisor';
import { CPP_AMBER_MULTIPLIER, CPP_TARGET, FROZEN_ACCELERATION_CLOSES, OLT_START_PON_PORTS } from '../sim/balance';
import { applyCommand, runDays } from '../sim/game';
import { reportKpis } from '../sim/metrics';
import { addLivePlant, makeGridCity, makeLoan, makeTestState, makeTradingState } from '../sim/testing/fixtures';
import type { CovenantStage, GameState, MonthlyReport, MonthlyStats } from '../sim/types';
import { CPP_BAND_TEXT, cashCard, summaryView, wordsText } from './briefing';
import { formatMoney, formatPercent, plural } from './format';
import { CALLED_WORD, HEALTH_WORD } from './health';
import { COLLAPSED_PARTS, PANEL_PARTS, panelText, reportPanelView, visibleParts } from './panel';
import type { ReportPanelView } from './panel';

/** A grid town fully lit from the CO, run `days` (closed months, customers). */
function litGame(days = 120): GameState {
  const state = makeTestState(makeGridCity({ cols: 3, rows: 2 }));
  addLivePlant(state, { splitters: 4 });
  runDays(state, days);
  return state;
}

/** Run to the next month close and return its report. */
function closeNext(state: GameState): MonthlyReport {
  const before = state.finance.reports.length;
  while (state.finance.reports.length === before) runDays(state, 1);
  return state.finance.reports.at(-1)!;
}

function stats(over: Partial<MonthlyStats> = {}): MonthlyStats {
  return {
    subscribers: 31,
    accounts: 31,
    subscriberDays: 31 * 30,
    grossAdds: 4,
    churned: 1,
    lostService: 0,
    connectsTotal: 40,
    capexOsp: 0,
    capexConnect: 0,
    capexCo: 0,
    ponPortsUsed: 1,
    ponPorts: OLT_START_PON_PORTS,
    fullCabinets: 0,
    ...over,
  };
}

/** A closed month whose net is the sum of its totals (as every close writes it). */
function report(totals: MonthlyReport['totals'], over: Partial<MonthlyReport> = {}): MonthlyReport {
  const net = Object.values(totals).reduce((sum, amount) => sum + (amount ?? 0), 0);
  return { year: 2027, month: 8, totals, net, cashEnd: 332_590, passings: 172, stats: stats(), ...over };
}

/** `state` with `r` as its latest closed month. */
function withReport(state: GameState, r: MonthlyReport): GameState {
  state.finance.reports.push(r);
  return state;
}

/** A month that billed customers, borrowed, built and paid its loans. */
const BUILDING_MONTH: MonthlyReport['totals'] = {
  revenue: 9_100,
  loanProceeds: 50_000,
  overhead: -6_400,
  poleRent: -300,
  construction: -61_000,
  equipment: -14_000,
  install: -5_540,
  interest: -1_210,
  principal: -2_400,
};

const JARGON = [/ARPU/i, /CPGA/i, /leverage/i, /coverage/i, /covenant/i, /DSCR/i, /\bARR\b/, /\bOCF\b/, /\bbps\b/i, /×/, /\d+(\.\d+)?x\b/];

function expectPlain(view: ReportPanelView): void {
  for (const expanded of [true, false]) {
    for (const text of panelText(view, expanded)) {
      for (const word of JARGON) expect(text, `"${text}"`).not.toMatch(word);
      expect(text).not.toMatch(/NaN|undefined|null|Infinity/);
    }
  }
}

describe('the report panel before the first month closes', () => {
  it('says when the first report comes, shows the spending so far, and offers no books', () => {
    const state = makeTestState();
    const view = reportPanelView(state);
    expect(view).toMatchObject({ title: 'Monthly report', hasReport: false, empty: 'First report arrives Feb 1.', cash: null, money: null, customers: null, building: null, bank: null });
    expect(view.mtd).toEqual({ amount: formatMoney(0), text: `This month so far: ${formatMoney(0)} spent` });
    // The toggle has nothing to open: the same few lines either way.
    expect(visibleParts(view, true)).toEqual(['empty', 'mtd']);
    expect(visibleParts(view, false)).toEqual(['empty', 'mtd']);
    expectPlain(view);

    // The existing month-to-date figure: everything spent so far this month.
    expect(applyCommand(state, { type: 'placeCabinet', node: state.city.coNode }).ok).toBe(true);
    const spent = state.finance.monthToDate.reduce((sum, e) => sum + (e.amount < 0 ? -e.amount : 0), 0);
    expect(spent).toBeGreaterThan(0);
    expect(reportPanelView(state).mtd.text).toBe(`This month so far: ${formatMoney(spent)} spent`);
  });
});

describe('the report panel after a month close', () => {
  it('splits money in and out exactly as the month summary does, and they add up to the cash change', () => {
    const state = litGame(120);
    const last = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    const view = reportPanelView(state);
    const b = buildBriefing(state, 1)!;
    const summary = summaryView(b);
    // The same bars, segments, shares and words as the summary's first view.
    expect(view.money!.in).toEqual(summary.bars.in);
    expect(view.money!.out).toEqual(summary.bars.out);
    // In minus out is the month's cash change, to the dollar.
    expect(view.money!.in.total - view.money!.out.total).toBe(last.net);
    expect(last.net).toBe(last.cashEnd - previous.cashEnd);
    // The cash line is the summary's cash card heading.
    const card = cashCard(b);
    expect(view.cash).toEqual({ headline: card.headline, left: card.left, direction: card.direction, text: `${card.headline} · ${card.left}` });
    expect(view.title).toBe('April 2027');
    expectPlain(view);
  });

  it('draws both bars on one scale: the larger total is the full width', () => {
    const view = reportPanelView(withReport(makeTestState(), report(BUILDING_MONTH)));
    const { in: moneyIn, out } = view.money!;
    expect(moneyIn.total - out.total).toBe(report(BUILDING_MONTH).net);
    const scale = Math.max(moneyIn.total, out.total);
    expect(out.share).toBe(1);
    expect(moneyIn.share).toBeCloseTo(moneyIn.total / scale, 10);
    for (const bar of [moneyIn, out]) {
      const sum = bar.segments.reduce((n, s) => n + s.share, 0);
      expect(sum).toBeCloseTo(bar.share, 10);
      for (const s of bar.segments) expect(s.share).toBeCloseTo(s.amount / scale, 10);
    }
    // Money in by source (bills, then borrowing), money out by the summary's three groups.
    expect(moneyIn.segments.map((s) => [s.label, s.value])).toEqual([
      ['Customer bills', formatMoney(9_100)],
      ['Borrowed', formatMoney(50_000)],
    ]);
    expect(out.segments.map((s) => [s.label, s.value])).toEqual([
      ['Running the business', formatMoney(6_700)],
      ['Building fiber', formatMoney(80_540)],
      ['Loan payments', formatMoney(3_610)],
    ]);
    expect(view.money!.borrowed).toBe(true);
    expect(view.cash!.text).toBe(`Cash went down ${formatMoney(-report(BUILDING_MONTH).net)} · ${formatMoney(332_590)} left`);
    // A month that only earned: money in is the full width, and nothing borrowed.
    const earned = reportPanelView(withReport(makeTestState(), report({ revenue: 12_000, overhead: -4_000 }))).money!;
    expect(earned.in.share).toBe(1);
    expect(earned.out.share).toBeCloseTo(4_000 / 12_000, 10);
    expect(earned.borrowed).toBe(false);
  });

  it('words the customers line: the count, who joined and left, and the share of homes passed', () => {
    const view = reportPanelView(withReport(makeTestState(), report({ revenue: 9_100 }, { stats: stats({ subscribers: 31, grossAdds: 4, churned: 1 }), passings: 172 })));
    expect(view.customers).toEqual([
      { text: '31 customers', strong: true },
      { text: ' (+4 joined, 1 left)' },
      { text: ` · ${formatPercent(31 / 172)} of homes you pass` },
    ]);
    expect(wordsText(view.customers!)).toBe('31 customers (+4 joined, 1 left) · 18% of homes you pass');
    // Customers who lost service count as left, as the Customers dashboard counts them.
    const lost = reportPanelView(withReport(makeTestState(), report({}, { stats: stats({ subscribers: 1, grossAdds: 0, churned: 1, lostService: 2 }) })));
    expect(wordsText(lost.customers!)).toBe(`1 customer (+0 joined, 3 left) · ${formatPercent(1 / 172)} of homes you pass`);
    // Nobody moved: no brackets; nothing passed yet: said in words.
    const still = reportPanelView(withReport(makeTestState(), report({}, { stats: stats({ subscribers: 0, grossAdds: 0, churned: 0 }), passings: 0 })));
    expect(wordsText(still.customers!)).toBe('0 customers · no homes passed yet');
    // A report from before customers were counted (a schemaVersion 1 save): no customers line; the cash line stays.
    const v1 = reportPanelView(withReport(makeTestState(), report({ construction: -5_000, poleRent: -20 }, { stats: undefined, passings: 12 })));
    expect(v1.customers).toBeNull();
    expect(visibleParts(v1, true)).not.toContain('customers');
    expect(visibleParts(v1, true)).not.toContain('seeCustomers');
    expect(v1.cash!.text).toBe(`Cash went down ${formatMoney(5_020)} · ${formatMoney(332_590)} left`);
    expectPlain(v1);
  });

  it('shows building only in a month that built, with the cost per home passed against the target in words', () => {
    const quiet = reportPanelView(withReport(makeTestState(), report({ revenue: 9_100, overhead: -6_400 })));
    expect(quiet.building).toBeNull();
    expect(visibleParts(quiet, true)).not.toContain('building');

    const build = (capexOsp: number) => reportPanelView(withReport(makeTestState(), report(BUILDING_MONTH, { stats: stats({ capexOsp }), passings: 100 }))).building!;
    const within = build(CPP_TARGET * 100);
    expect(within).toEqual({
      text: `Building: ${formatMoney(80_540)} · ${formatMoney(CPP_TARGET)} per home passed (target ${formatMoney(CPP_TARGET)})`,
      band: 'green',
      bandText: `${CPP_BAND_TEXT.green} target`,
    });
    const over = build(CPP_TARGET * CPP_AMBER_MULTIPLIER * 100);
    expect(over).toMatchObject({ band: 'amber', bandText: 'Over target' });
    const far = build(CPP_TARGET * CPP_AMBER_MULTIPLIER * 100 + 100);
    expect(far).toMatchObject({ band: 'red', bandText: 'Far over target' });
    expect(far.text).toContain(`${formatMoney(CPP_TARGET * CPP_AMBER_MULTIPLIER + 1)} per home passed (target ${formatMoney(CPP_TARGET)})`);
    // The band always comes with its words: never color alone.
    for (const line of [within, over, far]) expect(line.bandText).toBe(`${CPP_BAND_TEXT[line.band!]} target`);
    // Nothing passed yet: no cost per home, said so.
    const none = reportPanelView(withReport(makeTestState(), report(BUILDING_MONTH, { passings: 0 }))).building!;
    expect(none).toEqual({ text: `Building: ${formatMoney(80_540)} · no homes passed yet (target ${formatMoney(CPP_TARGET)})`, band: null, bandText: null });
    // A report without stats has no cost per home to give.
    const v1 = reportPanelView(withReport(makeTestState(), report({ construction: -5_000 }, { stats: undefined }))).building!;
    expect(v1).toEqual({ text: `Building: ${formatMoney(5_000)}`, band: null, bandText: null });
  });

  it('builds and borrows in a real month: borrowed money, building and the bank in the panel, still adding up', () => {
    // Eight months of bills: the bank opens a small credit line.
    const state = litGame(240);
    const cabinet = state.network.cabinets[0]!.id;
    expect(applyCommand(state, { type: 'addSplitter', cabinet }).ok).toBe(true);
    const draw = applyCommand(state, { type: 'drawCredit', amount: 2_000 });
    expect(draw.ok, JSON.stringify(draw)).toBe(true);
    const last = closeNext(state);
    const view = reportPanelView(state);
    expect(view.money!.in.segments.map((s) => s.key)).toContain('borrowed');
    expect(view.money!.out.segments.map((s) => s.key)).toContain('building');
    expect(view.money!.in.total - view.money!.out.total).toBe(last.net);
    const kpis = reportKpis(last)!;
    expect(view.building!.text).toBe(
      `Building: ${view.money!.out.segments.find((s) => s.key === 'building')!.value} · ${formatMoney(kpis.cpp!)} per home passed (target ${formatMoney(CPP_TARGET)})`,
    );
    // Debt owed: the bank's word, as a link.
    expect(view.bank!.text).toMatch(/^Bank: (Good|Watch)$/);
    expect(visibleParts(view, true)).toEqual(['cash', 'money', 'customers', 'seeCustomers', 'building', 'bank', 'mtd', 'books']);
    expectPlain(view);
  });
});

describe("the report panel's bank word", () => {
  const stage = (s: CovenantStage, debt = true) => {
    const state = withReport(makeTradingState(30_000), report({ revenue: 30_000 }));
    if (debt) state.debt.loans = [makeLoan({ balance: 60_000, principal: 60_000 })];
    state.debt.covenant = { stage: s, compliantCloses: 0 };
    return reportPanelView(state);
  };

  it('is left out with no debt and good health', () => {
    const view = stage('compliant', false);
    expect(view.bank).toBeNull();
    expect(visibleParts(view, true)).not.toContain('bank');
    expect(visibleParts(view, false)).toEqual(['cash', 'customers']);
  });

  it('says the shared word for every state, never success green', () => {
    expect(stage('compliant').bank).toMatchObject({ word: HEALTH_WORD.good, text: 'Bank: Good', tone: 'ok' });
    expect(stage('warning').bank).toMatchObject({ word: HEALTH_WORD.warning, text: 'Bank: Warning', tone: 'warn' });
    expect(stage('penalty').bank).toMatchObject({ word: HEALTH_WORD.penalty, text: 'Bank: Higher interest', tone: 'danger' });
    expect(stage('frozen').bank).toMatchObject({ word: HEALTH_WORD.frozen, text: 'Bank: No more borrowing', tone: 'danger' });
    // A loan the cash flow can't carry: Watch.
    const heavy = withReport(makeTradingState(30_000), report({ revenue: 30_000 }));
    heavy.debt.loans = [makeLoan({ balance: 2_000_000, principal: 2_000_000 })];
    expect(reportPanelView(heavy).bank).toMatchObject({ word: HEALTH_WORD.watch, text: 'Bank: Watch', tone: 'warn' });
    // The loans called: the word every screen uses for that step.
    const called = withReport(makeTradingState(30_000), report({ revenue: 30_000 }));
    called.debt.loans = [makeLoan({ balance: 60_000, principal: 60_000 })];
    called.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    called.debt.frozenCloses = FROZEN_ACCELERATION_CLOSES;
    called.debt.acceleration = { day: called.day, closesLeft: 3 };
    expect(reportPanelView(called).bank).toMatchObject({ word: CALLED_WORD, text: `Bank: ${CALLED_WORD}`, tone: 'danger' });
    // The tooltip is the Bank's own plain sentence.
    expect(stage('warning').bank!.sentence).toBe('You went over a limit at the last month close. Nothing changes yet.');
    for (const s of ['compliant', 'warning', 'penalty', 'frozen'] as const) expectPlain(stage(s));
  });

  it('still shows bank trouble the HUD shows after the debt is paid off', () => {
    expect(stage('frozen', false).bank).toMatchObject({ text: 'Bank: No more borrowing' });
  });
});

describe('the collapsed report panel', () => {
  it('keeps the cash line, the customers line and the bank word only', () => {
    expect(COLLAPSED_PARTS).toEqual(['cash', 'customers', 'bank']);
    const state = withReport(makeTradingState(30_000), report(BUILDING_MONTH));
    state.debt.loans = [makeLoan({ balance: 60_000, principal: 60_000 })];
    state.debt.covenant = { stage: 'warning', compliantCloses: 0 };
    const view = reportPanelView(state);
    // Expanded: every part there is, top to bottom.
    expect(visibleParts(view, true)).toEqual(PANEL_PARTS.filter((p) => p !== 'empty'));
    expect(visibleParts(view, false)).toEqual(['cash', 'customers', 'bank']);
    expect(panelText(view, false)).toEqual([
      'August 2027',
      `Cash went down ${formatMoney(-report(BUILDING_MONTH).net)} · ${formatMoney(332_590)} left`,
      `${plural(31, 'customer')} (+4 joined, 1 left) · ${formatPercent(31 / 172)} of homes you pass`,
      'Bank: Warning',
    ]);
    // Expanded it adds the bars, See customers, building, the spending so far and See the full books.
    const open = panelText(view, true);
    for (const text of ['Money in', 'Money out', 'See customers', 'See the full books', view.building!.text, view.mtd.text]) expect(open).toContain(text);
  });
});

describe('no jargon in the report panel', () => {
  it('says everything in plain words, in every state', () => {
    const state = litGame(120);
    expectPlain(reportPanelView(state));
    for (const s of ['compliant', 'warning', 'penalty', 'frozen'] as const) {
      const trading = withReport(makeTradingState(30_000), report(BUILDING_MONTH));
      trading.debt.loans = [makeLoan({ balance: 2_000_000, principal: 2_000_000 })];
      trading.debt.covenant = { stage: s, compliantCloses: 0 };
      expectPlain(reportPanelView(trading));
    }
    expectPlain(reportPanelView(withReport(makeTestState(), report({}, { stats: undefined, net: 0 }))));
    expectPlain(reportPanelView(withReport(makeTestState(), report({ revenue: -40, refund: 300 }))));
  });
});
