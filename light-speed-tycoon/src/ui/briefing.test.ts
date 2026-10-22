// The month-end summary's pure parts (briefing.ts): when it is due at each
// frequency, the span, the stored preference (storage that throws included),
// the debug-page gate, the round-4c/4d view model (spec G: the headline per
// story, the money bars on one scale that sum to the cash change, the group
// sub-labels with the cost per home passed, the cash card, the customers
// line, the attention lines and their buttons, the next step with its more
// tips and Not now, the full books, no jargon on the first view, the
// quarterly header) built from real advisor.buildBriefing results, and
// where "Show me" points. Money is checked against balance.ts constants and
// sim results, never literal dollar amounts.

import { describe, expect, it } from 'vitest';
import { ADVICE_SNOOZE_MONTHS, ADVICE_SNOOZE_URGENT_MONTHS, COVENANT_MAX_LEVERAGE, COVENANT_MIN_COVERAGE, CPP_TARGET } from '../sim/balance';
import { ATTENTION_MAX, buildBriefing } from '../sim/advisor';
import { applyCommand, runDays } from '../sim/game';
import { addLivePlant, makeGridCity, makeTestState } from '../sim/testing/fixtures';
import type { Advice, AttentionItem, Briefing, BriefingChange, BriefingMoney, CovenantMetrics, GameState, MoneyLineKey, Notice } from '../sim/types';
import {
  BAR_LABEL_MIN_SHARE,
  BRIEFING_FREQUENCIES,
  BRIEFING_STORAGE_KEY,
  BriefingPreference,
  CPP_BAND_TEXT,
  DEFAULT_BRIEFING_FREQUENCY,
  FREQUENCY_LABEL,
  GLANCE_KEYS,
  MONEY_GROUP_LABEL,
  MONEY_LINE_LABEL,
  NOTICE_TEXT_MAX,
  QUARTER_MONTHS,
  SEE_CUSTOMERS,
  STORY_HEADLINE,
  actionPoint,
  attentionLine,
  booksTitle,
  booksView,
  briefingAtClose,
  briefingDue,
  briefingHealth,
  briefingSpan,
  briefingTitle,
  cashCard,
  cashHeadline,
  changeRow,
  condenseNotice,
  cppTargetText,
  cppWords,
  customersLine,
  debtTone,
  firstViewText,
  isCloseTimeBriefing,
  moneyBars,
  moneyGroups,
  nextStep,
  noticeRows,
  readBriefingFrequency,
  snoozeHint,
  startingBriefingSetting,
  summaryHeadline,
  summaryKicker,
  summaryView,
  wordsText,
  writeBriefingFrequency,
  runwayPhrase,
} from './briefing';
import type { PreferenceStorage, SummaryView } from './briefing';
import { formatMoney, formatMonthLong, formatPercent, formatRatio, formatSignedMoney, plural } from './format';
import { HEALTH_TONE, HEALTH_WORD } from './health';
import { reportRows } from './panel';

/** A grid town fully lit from the CO, run `days` (closed months, subscribers). */
function litGame(days = 120): GameState {
  const state = makeTestState(makeGridCity({ cols: 3, rows: 2 }));
  addLivePlant(state, { splitters: 4 });
  runDays(state, days);
  return state;
}

/** Run to the next month close and return its report. */
function closeNext(state: GameState) {
  const before = state.finance.reports.length;
  while (state.finance.reports.length === before) runDays(state, 1);
  return state.finance.reports.at(-1)!;
}

const briefingOf = (days: number, span = 1): Briefing => {
  const b = buildBriefing(litGame(days), span);
  if (!b) throw new Error('no briefing');
  return b;
};

/** A suggestion for view tests (short, as spec B words them). */
function advice(key: string, over: Partial<Advice> = {}): Advice {
  return {
    id: 'expand',
    key,
    repeat: 0,
    priority: 150,
    severity: 'tip',
    title: `Light the street ${key}`,
    why: 'It passes 40 homes for $30,000.',
    detail: '',
    cost: 30_000,
    action: { kind: 'focusNode', node: 1 },
    actionLabel: 'Show me',
    ...over,
  };
}

/** A money partition from lines (in lines, then out lines by group), consistent by construction. */
function money(inLines: Partial<Record<MoneyLineKey, number>>, out: { running?: Partial<Record<MoneyLineKey, number>>; building?: Partial<Record<MoneyLineKey, number>>; loans?: Partial<Record<MoneyLineKey, number>> }): BriefingMoney {
  const lines = (rec: Partial<Record<MoneyLineKey, number>> = {}) =>
    Object.entries(rec)
      .filter(([, v]) => v !== 0)
      .map(([key, amount]) => ({ key: key as MoneyLineKey, amount: amount as number }))
      .sort((a, b) => b.amount - a.amount);
  const groups = (['running', 'building', 'loans'] as const).map((key) => {
    const own = lines(out[key]);
    return { key, total: own.reduce((n, l) => n + l.amount, 0), lines: own };
  });
  const ins = [{ key: 'bills' as MoneyLineKey, amount: inLines.bills ?? 0 }, ...lines({ borrowed: inLines.borrowed ?? 0, otherIn: inLines.otherIn ?? 0 })];
  const total = ins.reduce((n, l) => n + l.amount, 0);
  const spent = groups.reduce((n, g) => n + g.total, 0);
  return { in: total, inLines: ins, out: spent, groups, cashChange: total - spent };
}

class MemoryStorage implements PreferenceStorage {
  readonly items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, value);
  }
}

const throwing: PreferenceStorage = {
  getItem() {
    throw new Error('SecurityError');
  },
  setItem() {
    throw new Error('QuotaExceededError');
  },
};

describe('when a briefing is due', () => {
  const at = (month: number) => ({ month });
  const calm = { needsAttention: false };
  const alarm = { needsAttention: true };

  it('shows every month, every quarter at its last month, or only when something needs attention', () => {
    for (let month = 1; month <= 12; month++) {
      expect(briefingDue(at(month), calm, 'monthly')).toBe(true);
      expect(briefingDue(at(month), calm, 'quarterly')).toBe(month % QUARTER_MONTHS === 0);
      expect(briefingDue(at(month), calm, 'attention')).toBe(false);
      expect(briefingDue(at(month), alarm, 'attention')).toBe(true);
      expect(briefingDue(at(month), alarm, 'off')).toBe(false);
    }
    // Attention-only cannot decide without a briefing.
    expect(briefingDue(at(3), null, 'attention')).toBe(false);
    expect(briefingDue(at(3), null, 'quarterly')).toBe(true);
  });

  it('covers a quarter for quarterly briefings and one month otherwise', () => {
    expect(briefingSpan('quarterly')).toBe(QUARTER_MONTHS);
    for (const setting of ['monthly', 'attention', 'off'] as const) expect(briefingSpan(setting)).toBe(1);
  });

  it('builds the briefing for a close only when one is due, never once the game is over', () => {
    const state = litGame(1);
    const jan = closeNext(state);
    expect(jan.month).toBe(1);
    const monthly = briefingAtClose(state, jan, 'monthly');
    expect(monthly).not.toBeNull();
    expect(monthly!.span).toBe(1);
    expect(monthly!.report).toBe(jan);
    expect(briefingAtClose(state, jan, 'quarterly')).toBeNull();
    expect(briefingAtClose(state, jan, 'off')).toBeNull();

    closeNext(state);
    const mar = closeNext(state);
    expect(mar.month).toBe(3);
    const quarter = briefingAtClose(state, mar, 'quarterly')!;
    expect(quarter.span).toBe(QUARTER_MONTHS);
    expect(quarter.previous).toBeNull();

    state.gameOver = { day: state.day, reason: 'insolvent', message: 'x' };
    expect(briefingAtClose(state, mar, 'monthly')).toBeNull();
  });

  it('shows attention-only briefings when a close posts a notice that needs action', () => {
    const state = litGame(1);
    const quiet = closeNext(state);
    expect(briefingAtClose(state, quiet, 'attention') !== null).toBe(buildBriefing(state)!.needsAttention);
    // Overdrawn at the next close: an insolvency warning, which needs the player.
    state.finance.cash = -1_000_000;
    const overdrawn = closeNext(state);
    const shown = briefingAtClose(state, overdrawn, 'attention');
    expect(shown).not.toBeNull();
    expect(shown!.needsAttention).toBe(true);
    expect(shown!.notices.some((n) => n.kind === 'insolvencyWarning')).toBe(true);
  });
});

describe('the briefing preference', () => {
  it('reads and writes localStorage key lst:briefing, defaulting to every month', () => {
    const storage = new MemoryStorage();
    expect(BRIEFING_STORAGE_KEY).toBe('lst:briefing');
    expect(readBriefingFrequency(() => storage)).toBe(DEFAULT_BRIEFING_FREQUENCY);
    expect(DEFAULT_BRIEFING_FREQUENCY).toBe('monthly');
    for (const frequency of BRIEFING_FREQUENCIES) {
      expect(writeBriefingFrequency(frequency, () => storage)).toBe(true);
      expect(storage.items.get(BRIEFING_STORAGE_KEY)).toBe(frequency);
      expect(readBriefingFrequency(() => storage)).toBe(frequency);
    }
    storage.items.set(BRIEFING_STORAGE_KEY, 'weekly');
    expect(readBriefingFrequency(() => storage)).toBe(DEFAULT_BRIEFING_FREQUENCY);
  });

  it('survives storage that throws or is missing', () => {
    expect(readBriefingFrequency(() => throwing)).toBe(DEFAULT_BRIEFING_FREQUENCY);
    expect(writeBriefingFrequency('quarterly', () => throwing)).toBe(false);
    const explode = () => {
      throw new Error('blocked');
    };
    expect(readBriefingFrequency(explode)).toBe(DEFAULT_BRIEFING_FREQUENCY);
    expect(writeBriefingFrequency('attention', explode)).toBe(false);
    expect(readBriefingFrequency(() => null)).toBe(DEFAULT_BRIEFING_FREQUENCY);
    expect(writeBriefingFrequency('attention', () => null)).toBe(false);
    expect(readBriefingFrequency()).toBe(DEFAULT_BRIEFING_FREQUENCY);
  });

  it('remembers the choice made on the sheet, and lets the debug hook switch the page alone', () => {
    const storage = new MemoryStorage();
    const pref = new BriefingPreference('off', () => storage);
    expect(pref.current).toBe('off');
    expect(pref.frequency).toBe(DEFAULT_BRIEFING_FREQUENCY);
    expect(pref.choose('quarterly')).toBe(true);
    expect(pref.current).toBe('quarterly');
    expect(storage.items.get(BRIEFING_STORAGE_KEY)).toBe('quarterly');
    pref.set('off');
    expect(pref.current).toBe('off');
    expect(pref.frequency).toBe('quarterly');
    pref.set('attention');
    expect(pref.current).toBe('attention');
    expect(storage.items.get(BRIEFING_STORAGE_KEY)).toBe('quarterly');
    const blocked = new BriefingPreference('monthly', () => throwing);
    expect(blocked.choose('attention')).toBe(false);
    expect(blocked.current).toBe('attention');
  });

  it('labels each frequency for the full books’ select', () => {
    expect(FREQUENCY_LABEL).toEqual({
      monthly: 'Every month',
      quarterly: 'Every quarter',
      attention: 'Only when something needs attention',
    });
  });
});

describe('the debug-page gate', () => {
  it('keeps briefings off on ?debug=1 pages unless the URL asks', () => {
    expect(startingBriefingSetting('?debug=1', 'quarterly')).toBe('off');
    expect(startingBriefingSetting('?seed=5&debug=1', 'monthly')).toBe('off');
    expect(startingBriefingSetting('?debug=1&briefing=1', 'quarterly')).toBe('quarterly');
    expect(startingBriefingSetting('?debug=1&briefing=attention', 'monthly')).toBe('attention');
    expect(startingBriefingSetting('?debug=1&briefing=quarterly', 'monthly')).toBe('quarterly');
    expect(startingBriefingSetting('?debug=1&briefing=nonsense', 'monthly')).toBe('off');
  });

  it('uses the stored preference on ordinary pages, unless turned off', () => {
    expect(startingBriefingSetting('', 'monthly')).toBe('monthly');
    expect(startingBriefingSetting('?seed=12', 'attention')).toBe('attention');
    expect(startingBriefingSetting('?debug=0', 'quarterly')).toBe('quarterly');
    expect(startingBriefingSetting('?briefing=0', 'monthly')).toBe('off');
    expect(startingBriefingSetting('?briefing=off', 'monthly')).toBe('off');
    expect(startingBriefingSetting('?briefing=monthly', 'attention')).toBe('monthly');
  });
});

describe('the header and the headline', () => {
  it('names the month (or the quarter) and the company, and keeps the dialog’s name', () => {
    const b = briefingOf(120);
    expect(b.report.month).toBe(4);
    expect(briefingTitle(b)).toBe(`April ${b.report.year} briefing`);
    expect(summaryKicker(b, 'Otter Junction Fiber')).toBe(`April ${b.report.year} · Otter Junction Fiber`);
    expect(summaryKicker(b, '  ')).toBe(`April ${b.report.year}`);
    const q = briefingOf(120, 3);
    expect(briefingTitle(q)).toBe(`Feb–Apr ${q.report.year} briefing`);
    expect(summaryKicker(q, 'Otter Junction Fiber')).toBe(`Feb–Apr ${q.report.year} · Otter Junction Fiber`);
    const view = summaryView(q, 'Otter Junction Fiber');
    expect(view.title).toBe(briefingTitle(q));
    expect(view.period).toBe('quarter');
    expect(summaryView(b).period).toBe('month');
  });

  it('picks the headline from the period’s story; bills short is amber', () => {
    const b = briefingOf(120);
    expect(summaryHeadline({ ...b, story: 'earned' })).toEqual({ text: 'You earned more than you spent', tone: null, health: null });
    expect(summaryHeadline({ ...b, story: 'building' })).toEqual({ text: "You spent more than you earned, because you're building", tone: null, health: null });
    expect(summaryHeadline({ ...b, story: 'billsShort' })).toEqual({ text: "Your bills don't cover your running costs yet", tone: 'warn', health: null });
    expect(STORY_HEADLINE.earned).toBe('You earned more than you spent');
    // The real briefing's story picks one of them.
    expect(summaryView(b).headline.text).toBe(b.story === 'bank' ? summaryHeadline(b).text : STORY_HEADLINE[b.story as Exclude<typeof b.story, 'bank'>]);
  });

  it('leads with the bank when it is worried, in the same words as the Bank and the HUD', () => {
    const b = briefingOf(120);
    const owing = (stage: Briefing['headline']['stage'], called = false): Briefing => ({
      ...b,
      story: 'bank',
      headline: { ...b.headline, debt: 250_000, stage },
      forward: { ...b.forward, accelerationClosesLeft: called ? 2 : null },
    });
    const warning = summaryHeadline(owing('warning'));
    expect(warning.text).toBe('The bank is worried about your loans');
    expect(warning.health).toMatchObject({ level: 'warning', word: HEALTH_WORD.warning, text: `Bank health: ${HEALTH_WORD.warning}`, tone: HEALTH_TONE.warning });
    expect(warning.tone).toBe('warn');
    const penalty = summaryHeadline(owing('penalty'));
    expect(penalty.text).toBe('The bank raised the interest on your loans');
    expect(penalty.health!.text).toBe(`Bank health: ${HEALTH_WORD.penalty}`);
    expect(penalty.tone).toBe('danger');
    const frozen = summaryHeadline(owing('frozen'));
    expect(frozen.text).toBe('The bank has stopped your borrowing');
    expect(frozen.health!.text).toBe(`Bank health: ${HEALTH_WORD.frozen}`);
    const called = summaryHeadline(owing('frozen', true));
    expect(called.text).toBe('The bank wants its loans paid back');
    expect(called.health).toMatchObject({ called: true, tone: 'danger', text: 'Bank health: Loans called' });
    // A healthy company has no bank badge.
    expect(briefingHealth(b)).toMatchObject({ level: 'good', word: HEALTH_WORD.good, called: false, tone: 'ok' });
  });
});

describe('money in and money out', () => {
  it('partitions the period’s money so money in less money out is the cash change, exactly', () => {
    for (const days of [31, 60, 120, 181]) {
      for (const span of [1, 3]) {
        const state = litGame(days);
        const b = buildBriefing(state, span)!;
        const bars = moneyBars(b);
        const groups = moneyGroups(b);
        const inSum = b.money.inLines.reduce((n, l) => n + l.amount, 0);
        expect(inSum).toBe(b.money.in);
        expect(groups.reduce((n, g) => n + g.total, 0)).toBe(b.money.out);
        expect(b.money.in - b.money.out).toBe(b.cash.change);
        expect(b.cash.change).toBe(b.money.cashChange);
        // The ledger agrees: the period's nets add up to the same change.
        const reports = state.finance.reports;
        expect(reports.slice(reports.length - b.span).reduce((n, r) => n + r.net, 0)).toBe(b.cash.change);
        // The bars carry the same totals, and their segments add up to them.
        expect(bars.in.total).toBe(b.money.in);
        expect(bars.out.total).toBe(b.money.out);
        expect(bars.in.segments.reduce((n, s) => n + s.amount, 0)).toBe(b.money.in);
        expect(bars.out.segments.reduce((n, s) => n + s.amount, 0)).toBe(b.money.out);
        // Each group's lines add up to its total (no refund netted here).
        for (const g of groups) expect(g.lines.reduce((n, l) => n + l.amount, 0)).toBe(g.total);
      }
    }
  });

  it('puts both bars on one scale: the larger total is the full width', () => {
    const b = briefingOf(120);
    const spending = moneyBars({ ...b, money: money({ bills: 20_000 }, { running: { payroll: 10_000, overheadBase: 4_000 }, building: { construction: 16_000 } }) });
    expect(spending.scale).toBe(30_000);
    expect(spending.out.share).toBe(1);
    expect(spending.in.share).toBeCloseTo(20_000 / 30_000, 10);
    const earning = moneyBars({ ...b, money: money({ bills: 40_000 }, { running: { payroll: 10_000 } }) });
    expect(earning.scale).toBe(40_000);
    expect(earning.in.share).toBe(1);
    expect(earning.out.share).toBeCloseTo(0.25, 10);
    for (const bars of [spending, earning]) {
      for (const bar of [bars.in, bars.out]) {
        // Segments are measured on the shared scale too, so they fill exactly their bar.
        expect(bar.segments.reduce((n, s) => n + s.share, 0)).toBeCloseTo(bar.share, 10);
        for (const s of bar.segments) expect(s.share).toBeCloseTo(s.amount / bars.scale, 10);
      }
    }
    // Nothing moved: empty bars said in words.
    const still = moneyBars({ ...b, money: money({}, {}) });
    expect(still.scale).toBe(0);
    expect(still.in).toMatchObject({ share: 0, segments: [], empty: 'No money came in this month.' });
    expect(still.out).toMatchObject({ share: 0, segments: [], empty: 'Nothing went out this month.' });
  });

  it('splits money in by source: customer bills, and borrowed or other only when not zero', () => {
    const b = briefingOf(120);
    const bills = moneyBars({ ...b, money: money({ bills: 20_000 }, { running: { payroll: 21_000 } }) });
    expect(bills.in.segments.map((s) => s.key)).toEqual(['bills']);
    // Alone and long enough, its label sits inside the bar (as in the mockup); no legend needed.
    expect(bills.in.segments[0]).toMatchObject({ label: 'Customer bills', inside: true });
    expect(bills.inLegend).toBe(false);
    const borrowed = moneyBars({ ...b, money: money({ bills: 20_000, borrowed: 50_000, otherIn: 1_200 }, { building: { construction: 60_000 } }) });
    expect(borrowed.in.segments.map((s) => [s.key, s.label, s.value])).toEqual([
      ['bills', 'Customer bills', formatMoney(20_000)],
      ['borrowed', 'Borrowed', formatMoney(50_000)],
      ['otherIn', 'Other', formatMoney(1_200)],
    ]);
    // Several sources: a legend names each (never color alone).
    expect(borrowed.inLegend).toBe(true);
    for (const s of borrowed.in.segments) expect(s.inside).toBe(false);
    expect(borrowed.in.description).toBe(`Money in ${formatMoney(71_200)}: Customer bills ${formatMoney(20_000)}, Borrowed ${formatMoney(50_000)}, Other ${formatMoney(1_200)}.`);
    // Bills too short to hold their label: the legend names them.
    const short = moneyBars({ ...b, money: money({ bills: 1_000 }, { running: { payroll: 1_000 / (BAR_LABEL_MIN_SHARE / 2) } }) });
    expect(short.in.segments[0]!.inside).toBe(false);
    expect(short.inLegend).toBe(true);
    // The real briefing (no loans): no borrowed segment.
    expect(moneyBars(b).in.segments.some((s) => s.key === 'borrowed')).toBe(false);
  });

  it('labels the three groups, names their biggest parts and the cost per home passed', () => {
    const b = briefingOf(120);
    const m = money(
      { bills: 30_000 },
      {
        running: { overheadBase: 2_000, overheadCustomers: 3_100, overheadPlant: 600, payroll: 6_000, poleRent: 400, marketing: 1_000, repair: 300 },
        building: { construction: 9_000, install: 900 },
        loans: { interest: 1_500, principal: 6_000 },
      },
    );
    const groups = moneyGroups({ ...b, money: m, headline: { ...b.headline, cpp: 1_040, cppTarget: CPP_TARGET } });
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      ['running', MONEY_GROUP_LABEL.running],
      ['building', MONEY_GROUP_LABEL.building],
      ['loans', MONEY_GROUP_LABEL.loans],
    ]);
    expect(MONEY_GROUP_LABEL).toEqual({ running: 'Running the business', building: 'Building fiber', loans: 'Loan payments' });
    const [running, building, loans] = groups as [(typeof groups)[0], (typeof groups)[0], (typeof groups)[0]];
    expect(running.sub).toBe('staff, customer support and base costs');
    expect(building.sub).toBe('new cable and installs');
    expect(building.note).toBe(`${formatMoney(1_040)} per home passed, target ${formatMoney(CPP_TARGET)}`);
    expect(cppWords(1_040, CPP_TARGET)).toBe(building.note);
    expect(cppWords(null, CPP_TARGET)).toBe(`No homes passed yet, target ${formatMoney(CPP_TARGET)} each`);
    expect(loans.sub).toBe('paying back and interest');
    expect(running.note).toBeNull();
    expect(loans.note).toBeNull();
    // Running the business lists the overhead's three lines first, then payroll, pole rent, marketing, repairs.
    expect(running.lines.map((l) => l.key)).toEqual(['overheadBase', 'overheadCustomers', 'overheadPlant', 'payroll', 'poleRent', 'marketing', 'repair']);
    expect(running.lines.map((l) => l.label)).toEqual(running.lines.map((l) => MONEY_LINE_LABEL[l.key]));
    expect(running.lines[0]).toMatchObject({ amount: 2_000, value: formatMoney(2_000) });
    // An empty group still shows, at $0, and says so.
    const idle = moneyGroups({ ...b, money: money({ bills: 1_000 }, { running: { payroll: 500 } }) });
    expect(idle.find((g) => g.key === 'loans')).toMatchObject({ total: 0, value: formatMoney(0), sub: 'nothing this month', lines: [] });
    expect(moneyGroups({ ...b, span: 3, money: money({}, {}) })[0]!.sub).toBe('nothing this quarter');
    // Every line key has a label of its own within its side.
    const labels = Object.values(MONEY_LINE_LABEL);
    expect(labels.every((l) => /^\S/.test(l))).toBe(true);
  });

  it('shows the overhead’s lines from a real close inside running the business', () => {
    const b = briefingOf(120);
    const running = moneyGroups(b).find((g) => g.key === 'running')!;
    const keys = running.lines.map((l) => l.key);
    if (b.report.ops?.overhead) {
      expect(keys).toEqual(expect.arrayContaining(['overheadBase']));
      expect(keys).not.toContain('overhead');
      const sum = running.lines.filter((l) => l.key.startsWith('overhead')).reduce((n, l) => n + l.amount, 0);
      expect(sum).toBe(-(b.report.totals.overhead ?? 0));
    } else {
      expect(keys).toContain('overhead');
    }
  });
});

describe('the cash card', () => {
  const b = briefingOf(120);
  const card = (cash: Partial<Briefing['cash']>, over: Partial<Briefing> = {}) => cashCard({ ...b, ...over, cash: { ...b.cash, ...cash } });

  it('shares its heading with the report panel: how cash moved and what is left', () => {
    expect(cashHeadline({ change: -4_479, end: 43_753 })).toEqual({ headline: `Cash went down ${formatMoney(4_479)}`, left: `${formatMoney(43_753)} left`, direction: 'down' });
    expect(cashHeadline({ change: 1_200, end: -2_100 })).toEqual({ headline: `Cash went up ${formatMoney(1_200)}`, left: `${formatMoney(2_100)} overdrawn`, direction: 'up' });
    expect(cashHeadline({ change: 0, end: 0 })).toEqual({ headline: 'Cash stayed the same', left: `${formatMoney(0)} left`, direction: 'flat' });
    const c = card({ change: -4_479, end: 43_753 });
    expect({ headline: c.headline, left: c.left, direction: c.direction }).toEqual(cashHeadline({ change: -4_479, end: 43_753 }));
  });

  it('says how cash moved, what is left, and how long it lasts when it falls', () => {
    const down = card({ change: -4_479, end: 43_753, paceMonths: 9, building: false, withoutBuilding: -4_479 }, { story: 'billsShort' });
    expect(down.headline).toBe(`Cash went down ${formatMoney(4_479)}`);
    expect(down.left).toBe(`${formatMoney(43_753)} left`);
    expect(down.direction).toBe('down');
    expect(down.lines.map(wordsText)).toEqual(['At this pace your cash lasts about 9 months.']);
    expect(down.lines[0]!.find((w) => w.strong)!.text).toBe('about 9 months');
    // A slow burn on a big purse reads in years, not "about 158 months".
    expect(runwayPhrase(23)).toBe('about 23 months');
    expect(runwayPhrase(24)).toBe('about 2 years');
    expect(runwayPhrase(158)).toBe('about 13 years');
    expect(card({ change: -100, paceMonths: 0, building: false }).lines.map(wordsText)).toEqual(['At this pace your cash runs out before the next month close.']);
    expect(card({ change: -100, end: -2_100, paceMonths: 0, building: false }).left).toBe(`${formatMoney(2_100)} overdrawn`);
    // The pace is the period's own, building included (the mockup's "$43,753 left ... about 10 months" at $4,479 a month), not
    // what running the business alone burns: a month that built a lot never reads "about 10 years".
    expect(card({ change: -32_539, end: 332_590, paceMonths: 10, runwayMonths: 120, building: true, withoutBuilding: -1_999 }).lines.map(wordsText)[0]).toBe(
      'At this pace your cash lasts about 10 months.',
    );
    expect(card({ change: 0, building: false }).headline).toBe('Cash stayed the same');
  });

  it('while building, says what running the business alone made, or plainly that the bills do not cover it yet', () => {
    const building = card({ change: -4_479, paceMonths: 9, runwayMonths: null, building: true, withoutBuilding: 5_426 }, { story: 'building' });
    expect(building.lines.map(wordsText)).toEqual([
      'At this pace your cash lasts about 9 months.',
      `Building is your choice: without it you'd have made ${formatMoney(5_426)} this month.`,
    ]);
    const short = card({ change: -9_000, paceMonths: 12, building: true, withoutBuilding: -3_000 }, { story: 'billsShort' });
    expect(short.lines.map(wordsText)).toEqual([
      'At this pace your cash lasts about 12 months.',
      `Your bills don't cover your running costs yet: even without building you'd have lost ${formatMoney(3_000)} this month.`,
    ]);
    const quarter = card({ change: -4_000, paceMonths: null, building: true, withoutBuilding: 2_000 }, { story: 'building', span: 3 });
    expect(wordsText(quarter.lines[0]!)).toMatch(/ this quarter\.$/);
  });

  it('when cash rises, says how much a month, and how much of it was borrowed', () => {
    const up = card({ change: 3_600, perMonth: 3_600, building: false }, { story: 'earned', money: money({ bills: 10_000 }, { running: { payroll: 6_400 } }) });
    expect(up.headline).toBe(`Cash went up ${formatMoney(3_600)}`);
    expect(up.lines.map(wordsText)).toEqual([`At this pace you add about ${formatMoney(3_600)} a month.`]);
    const loan = money({ bills: 40_000, borrowed: 20_000 }, { running: { payroll: 6_000 }, building: { construction: 30_000 } });
    const borrowed = card({ change: loan.cashChange, building: true, withoutBuilding: 34_000 }, { story: 'earned', money: loan });
    expect(borrowed.lines.map(wordsText)).toEqual([`That includes ${formatMoney(20_000)} you borrowed; without it you'd still have added ${formatMoney(loan.cashChange - 20_000)}.`]);
    const allLoan = money({ bills: 1_000, borrowed: 50_000 }, { building: { construction: 30_000 } });
    expect(card({ change: allLoan.cashChange, building: true, withoutBuilding: 1_000 }, { story: 'building', money: allLoan }).lines.map(wordsText)).toEqual([
      `You borrowed ${formatMoney(50_000)}; without it your cash would have gone down ${formatMoney(50_000 - allLoan.cashChange)}.`,
      `Building is your choice: without it you'd have made ${formatMoney(1_000)} this month.`,
    ]);
  });
});

describe('the customers line', () => {
  it('counts customers, their change and the share of passed homes that buy', () => {
    const b = briefingOf(120);
    const change = (delta: number | null): BriefingChange[] => b.changes.map((c) => (c.key === 'subscribers' ? { ...c, delta } : c));
    const line = customersLine({ ...b, headline: { ...b.headline, subscribers: 372, takeRate: 0.38 }, changes: change(9) })!;
    expect(wordsText(line)).toBe('372 customers (+9). 38% of the homes you pass buy from you.');
    expect(line.find((w) => w.strong)!.text).toBe('372 customers');
    expect(wordsText(customersLine({ ...b, headline: { ...b.headline, subscribers: 40, takeRate: 0.1 }, changes: change(-3) })!)).toBe(
      '40 customers (-3). 10% of the homes you pass buy from you.',
    );
    expect(wordsText(customersLine({ ...b, headline: { ...b.headline, subscribers: 1, takeRate: null }, changes: change(null) })!)).toBe('1 customer. No homes passed yet.');
    // An old report without subscriber figures: no line.
    expect(customersLine({ ...b, headline: { ...b.headline, subscribers: null } })).toBeNull();
    // From a real close.
    const real = wordsText(customersLine(b)!);
    expect(real).toContain(plural(b.headline.subscribers!, 'customer'));
    expect(real).toContain(`${formatPercent(b.headline.takeRate!)} of the homes you pass buy from you.`);
    // See customers opens the Customers dashboard.
    expect(SEE_CUSTOMERS).toEqual({ kind: 'openPanel', panel: 'customers' });
  });
});

describe('needs attention', () => {
  const bank = { kind: 'openPanel', panel: 'bank' } as const;
  const item = (over: Partial<AttentionItem> & Pick<AttentionItem, 'kind'>): AttentionItem => ({ action: bank, place: null, count: null, stage: null, ...over });

  it('words each kind in one short line with its button: Open the Bank for the bank, Show me for a place', () => {
    const stage = attentionLine(item({ kind: 'bankStage', stage: 'warning' }));
    expect(stage).toMatchObject({ button: 'Open the Bank', action: bank, tone: 'warn' });
    expect(stage.text).toContain(`Bank health is now ${HEALTH_WORD.warning}`);
    expect(attentionLine(item({ kind: 'bankStage', stage: 'frozen' }))).toMatchObject({ tone: 'danger' });
    expect(attentionLine(item({ kind: 'bankStage', stage: 'frozen' })).text).toContain(HEALTH_WORD.frozen);
    const watch = attentionLine(item({ kind: 'bankWatch' }));
    expect(watch).toMatchObject({ button: 'Open the Bank', tone: 'warn' });
    expect(watch.text).toContain(`Bank health: ${HEALTH_WORD.watch}`);
    expect(attentionLine(item({ kind: 'loansCalled', count: 3, stage: 'frozen' }))).toMatchObject({
      button: 'Open the Bank',
      tone: 'danger',
      text: 'The bank wants every loan back within 3 month closes.',
    });
    const segment = { kind: 'focusSegment', segment: 4 } as const;
    expect(attentionLine(item({ kind: 'outage', action: segment, place: 'Elm St', count: 1 }))).toMatchObject({ button: 'Show me', action: segment, text: 'Cable is out of service on Elm St.' });
    expect(attentionLine(item({ kind: 'outage', action: segment, place: 'Elm St', count: 3 })).text).toBe('3 cable spans are out of service, one on Elm St.');
    const node = { kind: 'focusNode', node: 7 } as const;
    expect(attentionLine(item({ kind: 'storm', action: node, place: 'Elm St & 3rd Ave', count: 1 }))).toMatchObject({
      button: 'Show me',
      text: 'A storm hit near Elm St & 3rd Ave. The damage is repaired.',
    });
    const cabinet = { kind: 'focusCabinet', cabinet: 12 } as const;
    expect(attentionLine(item({ kind: 'cabinetFull', action: cabinet, place: 'Spring St & 11th', count: 12 }))).toMatchObject({
      button: 'Show me',
      action: cabinet,
      text: 'The cabinet at Spring St & 11th is full: 12 homes waiting.',
    });
    expect(attentionLine(item({ kind: 'cabinetFull', action: cabinet, place: 'Spring St & 11th', count: null })).text).toBe('The cabinet at Spring St & 11th is full and turning signups away.');
  });

  it('shows the sim’s attention items in order, none when nothing needs the player', () => {
    const state = litGame(120);
    const cabinet = state.network.cabinets[0]!;
    state.sales.fullCabinets = [cabinet.id];
    const b = buildBriefing(state)!;
    const view = summaryView(b);
    expect(view.attention.map((a) => a.kind)).toEqual(b.attention.map((a) => a.kind));
    expect(view.attention.length).toBeLessThanOrEqual(ATTENTION_MAX);
    const full = view.attention.find((a) => a.kind === 'cabinetFull');
    expect(full).toMatchObject({ button: 'Show me', action: { kind: 'focusCabinet', cabinet: cabinet.id } });
    expect(summaryView({ ...b, attention: [] }).attention).toEqual([]);
  });
});

describe('your next step', () => {
  it('leads with the first suggestion and folds the rest into the more tips', () => {
    const b = briefingOf(120);
    const steps = nextStep({ ...b, advice: [advice('a', { detail: 'Longer reasoning here.' }), advice('b'), advice('c', { severity: 'urgent' })], snoozed: 0 });
    expect(steps.next).toMatchObject({ key: 'a', title: 'Light the street a', why: 'It passes 40 homes for $30,000.', detail: 'Longer reasoning here.', actionLabel: 'Show me' });
    expect(steps.tips.map((t) => t.key)).toEqual(['b', 'c']);
    expect(steps.tipsLabel).toBe('2 more tips');
    expect(steps.tips[0]!.detail).toBeNull();
    expect(steps.empty).toBeNull();
    expect(nextStep({ ...b, advice: [advice('a'), advice('b')], snoozed: 0 }).tipsLabel).toBe('1 more tip');
    expect(nextStep({ ...b, advice: [advice('a')], snoozed: 0 })).toMatchObject({ tips: [], tipsLabel: null });
    // Not now says how long it hides a suggestion.
    expect(steps.next!.snoozeHint).toBe(snoozeHint('tip'));
    expect(steps.tips[1]!.snoozeHint).toBe(snoozeHint('urgent'));
    const months = (n: number) => (n === 1 ? 'Hide this until next month' : `Hide this for ${n} months`);
    expect(snoozeHint('important')).toBe(months(ADVICE_SNOOZE_MONTHS));
    expect(snoozeHint('urgent')).toBe(months(ADVICE_SNOOZE_URGENT_MONTHS));
  });

  it('never says "Nothing pressing" while cash falls', () => {
    const b = briefingOf(120);
    const falling = nextStep({ ...b, advice: [], snoozed: 0, cash: { ...b.cash, change: -2_000 } });
    expect(falling.next).toBeNull();
    expect(falling.empty).not.toMatch(/nothing pressing/i);
    expect(falling.empty).toBeTruthy();
    const rising = nextStep({ ...b, advice: [], snoozed: 0, cash: { ...b.cash, change: 2_000 } });
    expect(rising.empty).toMatch(/^Nothing pressing/);
  });

  it('Not now snoozes through a command: the rebuilt summary leaves it out and counts it', () => {
    const state = litGame(120);
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    const before = summaryView(buildBriefing(state)!);
    expect(before.steps.next).not.toBeNull();
    expect(before.steps.snoozedText).toBeNull();
    const card = before.steps.next!;
    expect(applyCommand(state, { type: 'snoozeAdvice', key: card.key }).ok).toBe(true);
    const after = summaryView(buildBriefing(state)!);
    expect([after.steps.next, ...after.steps.tips].some((c) => c?.key === card.key)).toBe(false);
    expect(after.steps.snoozedText).toBe('1 snoozed suggestion');
    // A real splitter suggestion keeps its action and label.
    const split = [before.steps.next, ...before.steps.tips].find((c) => c?.action.kind === 'focusCabinet');
    expect(split).toBeDefined();
  });
});

describe('the full books', () => {
  it('lists the rest of the latest report under "More figures", each trade term beside its plain meaning', () => {
    const b = briefingOf(120);
    const books = booksView(b);
    expect(books.moreTitle).toBe(`More figures for ${formatMonthLong(b.report.year, b.report.month)}`);
    expect(books.more).toEqual(reportRows(b.report).filter((r) => !r.quiet));
    expect(books.more.map((r) => r.key).slice(0, 4)).toEqual(['arpu', 'cpga', 'costPerConnection', 'operatingCashFlow']);
    // With a loan: the bank's figures at month end, the limits beside them.
    const owed: Briefing = {
      ...b,
      report: {
        ...b.report,
        debt: {
          creditBalance: 0,
          termBalance: 90_000,
          creditLimit: 0,
          arr: 100_000,
          annualOperatingCashFlow: 40_000,
          annualDebtService: 20_000,
          leverageX100: 225,
          coverageX100: 200,
          stage: 'compliant',
          averageRateBps: 725,
          missedPayment: false,
          sweep: 0,
          frozenCloses: 0,
          accelerationClosesLeft: null,
        },
      },
    };
    const rows = booksView(owed).more;
    expect(rows.filter((r) => ['debt', 'leverage', 'coverage'].includes(r.key)).map((r) => [r.label, r.value, r.detail])).toEqual([
      ['Debt at month end', formatMoney(90_000), null],
      ['Years of profit (leverage)', '2.25×', `limit ${formatRatio(COVENANT_MAX_LEVERAGE)}`],
      ['Earned per $1 of loan payments (coverage)', '2.00×', `min ${formatRatio(COVENANT_MIN_COVERAGE)}`],
    ]);
    // A trade term only ever follows its plain meaning, in brackets.
    for (const r of rows) {
      if (/ARPU|CPGA|leverage|coverage|operating cash flow/i.test(r.label)) expect(r.label, r.label).toMatch(/^[A-Z][a-z][^()]* \((ARPU|CPGA|leverage|coverage|operating cash flow)\)$/);
      expect(`${r.value} ${r.detail ?? ''}`).not.toMatch(/NaN|undefined|null|Infinity/);
    }
    // A quarter's books still show the latest month's own figures.
    const quarter = booksView(briefingOf(120, 3));
    expect(quarter.moreTitle).toBe(`More figures for ${formatMonthLong(b.report.year, b.report.month)}`);
  });

  it('names the books on their own after the period (the report panel opens them so)', () => {
    const b = briefingOf(120);
    expect(booksTitle(b)).toBe(`The full books for ${formatMonthLong(b.report.year, b.report.month)}`);
    expect(booksTitle(briefingOf(120, 3))).toMatch(/^The full books for [A-Z][a-z]{2}–[A-Z][a-z]{2} \d{4}$/);
  });

  it('keeps every glance tile, each with its change against the period before', () => {
    const b = briefingOf(120);
    const books = booksView(b);
    expect(books.tiles.map((t) => t.key)).toEqual(['net', 'cash', 'subscribers', 'passings', 'takeRate', 'cpp', 'debt']);
    expect(books.tiles.map((t) => t.key)).toEqual(GLANCE_KEYS);
    const tile = (key: string) => books.tiles.find((t) => t.key === key)!;
    expect(tile('net').value).toBe(formatSignedMoney(b.headline.net));
    expect(tile('cash').value).toBe(formatMoney(b.headline.cash));
    expect(tile('subscribers').value).toBe(String(b.headline.subscribers));
    expect(tile('takeRate').value).toBe(formatPercent(b.headline.takeRate!));
    expect(tile('debt')).toMatchObject({ value: formatMoney(0), detail: 'No loans', tone: null });
    expect(books.comparedWith).toBe('March');
    for (const t of books.tiles) {
      const row = changeRow(b.changes.find((c) => c.key === t.key)!);
      expect(t.change, t.key).toEqual({ direction: row.direction, text: row.change, before: row.before, tone: row.tone });
      expect(`${t.value} ${t.detail ?? ''}`).not.toMatch(/NaN|undefined|null|Infinity/);
    }
    // What changed holds only what is not a tile.
    expect(books.changes.map((c) => c.key)).toEqual(['revenue', 'operatingCashFlow']);
    const first = booksView(briefingOf(31));
    expect(first.changes).toEqual([]);
    expect(first.comparedWith).toBeNull();
    for (const t of first.tiles) expect(t.change).toBeNull();
  });

  it('colors cost per home passed by band and says it in words, against the target', () => {
    const b = briefingOf(60);
    for (const band of ['green', 'amber', 'red'] as const) {
      const cpp = booksView({ ...b, headline: { ...b.headline, cpp: CPP_TARGET, cppBand: band } }).tiles.find((t) => t.key === 'cpp')!;
      expect(cpp.value).toBe(formatMoney(CPP_TARGET));
      expect(cpp.tone).toBe(band);
      expect(cpp.detail).toBe(`${CPP_BAND_TEXT[band]} the ${formatMoney(CPP_TARGET)} target`);
    }
    expect(cppTargetText('red', CPP_TARGET)).toBe(`Far over the ${formatMoney(CPP_TARGET)} target`);
    const none = booksView({ ...b, headline: { ...b.headline, cpp: null, cppBand: null } }).tiles.find((t) => t.key === 'cpp')!;
    expect(none).toMatchObject({ value: '–', tone: null, detail: `Target ${formatMoney(CPP_TARGET)}` });
  });

  it('never colors debt success green: the bank’s health words and tone only', () => {
    const b = briefingOf(60);
    const covenant = (leverage: number | null, coverage: number): CovenantMetrics => ({
      ...b.headline.covenant,
      totalDebt: 250_000,
      annualDebtService: 40_000,
      leverage,
      coverage,
      leverageOk: leverage !== null && leverage <= COVENANT_MAX_LEVERAGE,
      coverageOk: coverage >= COVENANT_MIN_COVERAGE,
      compliant: leverage !== null && leverage <= COVENANT_MAX_LEVERAGE && coverage >= COVENANT_MIN_COVERAGE,
    });
    const clear = covenant(COVENANT_MAX_LEVERAGE * 0.3, COVENANT_MIN_COVERAGE * 3);
    const breached = covenant(COVENANT_MAX_LEVERAGE * 1.2, COVENANT_MIN_COVERAGE * 2);
    const tile = (over: Partial<Briefing['headline']>, forward: Partial<Briefing['forward']> = {}) => {
      const bb = { ...b, headline: { ...b.headline, debt: 250_000, ...over }, forward: { ...b.forward, ...forward } };
      return { tile: booksView(bb).tiles.find((t) => t.key === 'debt')!, health: briefingHealth(bb), tone: debtTone(bb) };
    };
    expect(debtTone(b)).toBeNull();
    const good = tile({ stage: 'compliant', covenant: clear });
    expect(good.tile).toMatchObject({ tone: null, detail: `Bank health: ${HEALTH_WORD.good}` });
    const watch = tile({ stage: 'compliant', covenant: breached });
    expect(watch.tile).toMatchObject({ tone: 'warn', detail: `Bank health: ${HEALTH_WORD.watch}` });
    expect(tile({ stage: 'warning', covenant: clear }).tile).toMatchObject({ tone: 'warn', detail: `Bank health: ${HEALTH_WORD.warning}` });
    expect(tile({ stage: 'penalty', covenant: clear }).tile).toMatchObject({ tone: 'danger', detail: `Bank health: ${HEALTH_WORD.penalty}` });
    expect(tile({ stage: 'frozen', covenant: breached }).tile).toMatchObject({ tone: 'danger', detail: `Bank health: ${HEALTH_WORD.frozen}` });
    expect(tile({ stage: 'frozen', covenant: breached }, { accelerationClosesLeft: 2 }).tile).toMatchObject({ tone: 'danger', detail: 'Bank health: Loans called' });
    for (const stage of ['compliant', 'warning', 'penalty', 'frozen'] as const) {
      for (const cov of [clear, breached, covenant(null, 0)]) expect(['warn', 'danger', null]).toContain(tile({ stage, covenant: cov }).tile.tone);
    }
    // Its change is neutral news whichever way it went.
    const more = { ...b.changes.find((c) => c.key === 'debt')!, now: 250_000, before: 100_000, delta: 150_000, upIsGood: false };
    expect(changeRow(more).tone).toBe('neutral');
    expect(changeRow({ ...more, now: 50_000, delta: -50_000 }).tone).toBe('neutral');
    expect(b.changes.find((c) => c.key === 'debt')!.upIsGood).toBeNull();
  });

  it('itemizes money in and out (the overhead’s lines included) and nets them to the cash change', () => {
    const b = briefingOf(120);
    const books = booksView(b);
    expect(books.moneyIn.reduce((n, l) => n + l.amount, 0)).toBe(b.money.in);
    expect(books.moneyOut.map((g) => g.key)).toEqual(['running', 'building', 'loans']);
    expect(books.moneyOut.reduce((n, g) => n + g.total, 0)).toBe(b.money.out);
    expect(books.inTotal).toBe(formatMoney(b.money.in));
    expect(books.outTotal).toBe(formatMoney(b.money.out));
    expect(books.net).toBe(formatSignedMoney(b.cash.change));
    expect(books.netNegative).toBe(b.cash.change < 0);
    const lines = books.moneyOut.flatMap((g) => g.lines.map((l) => l.key));
    if (b.report.ops?.overhead) expect(lines).toContain('overheadBase');
  });

  it('lists every notice of the period, folding identical ones, and looks ahead', () => {
    const b = briefingOf(120);
    const notice = (id: number, message: string, kind: Notice['kind'] = 'cabinetFull'): Notice => ({ id, day: 59 + id, kind, message, cabinet: null, milestone: null });
    const many = Array.from({ length: 12 }, (_, i) => notice(i + 1, `Notice ${i}.`));
    const books = booksView({ ...b, notices: [...many, notice(20, 'Notice 0.')] });
    expect(books.notices).toHaveLength(12);
    expect(books.notices[0]!.count).toBe(2);
    expect(books.noticeCount).toBe(13);
    expect(books.forward.map((r) => r.key)).toEqual(['nextClose', 'payment', 'projectedCash', 'runway']);
    expect(books.forward.find((r) => r.key === 'payment')!.value).toBe('None due');
    expect(books.forward.find((r) => r.key === 'projectedCash')!.value).toBe(formatMoney(b.forward.projectedCash));
    const frozen = booksView({ ...b, forward: { ...b.forward, nextPayment: 4_000, closesUntilCalled: 2, runwayMonths: 2 } });
    expect(frozen.forward.find((r) => r.key === 'payment')).toMatchObject({ value: formatMoney(4_000), detail: expect.stringMatching(/^due \w{3} 1, \d{4}: /) });
    expect(frozen.forward.find((r) => r.key === 'called')).toMatchObject({ value: 'in 2 closes', tone: 'danger' });
    expect(frozen.forward.find((r) => r.key === 'runway')).toMatchObject({ value: 'about 2 months', tone: 'danger' });
    const called = booksView({ ...b, forward: { ...b.forward, accelerationClosesLeft: 3 } });
    expect(called.forward.find((r) => r.key === 'acceleration')).toMatchObject({ value: 'everything due within 3 closes', tone: 'danger' });
  });

  it('turns a change into words: up or down by how much, good or bad by upIsGood, no change when it rounds away', () => {
    const change = (over: Partial<BriefingChange>): BriefingChange => ({ key: 'cash', label: 'Cash', now: 1_500, before: 1_000, delta: 500, upIsGood: true, unit: 'money', ...over });
    expect(changeRow(change({}))).toMatchObject({ direction: 'up', change: `up ${formatMoney(500)}`, tone: 'good', before: `was ${formatMoney(1_000)}` });
    expect(changeRow(change({ now: 500, delta: -500 }))).toMatchObject({ direction: 'down', change: `down ${formatMoney(500)}`, tone: 'bad' });
    expect(changeRow(change({ key: 'cpp', upIsGood: false, now: 500, delta: -500 }))).toMatchObject({ direction: 'down', tone: 'good' });
    expect(changeRow(change({ upIsGood: null }))).toMatchObject({ direction: 'up', tone: 'neutral' });
    expect(changeRow(change({ delta: 0.3 }))).toMatchObject({ direction: 'flat', change: 'no change', tone: 'neutral' });
    expect(changeRow(change({ before: null, delta: null }))).toMatchObject({ direction: null, change: '–', before: null, tone: 'neutral' });
    expect(changeRow(change({ key: 'takeRate', unit: 'ratio', now: 0.35, before: 0.32, delta: 0.03 }))).toMatchObject({ value: formatPercent(0.35), change: 'up 3.0 pts', tone: 'good' });
  });

  it('keeps short notices whole and cuts long ones to their first sentence', () => {
    expect(condenseNotice('Cabinet full.')).toBe('Cabinet full.');
    const long = `Covenant warning: leverage is over the limit. ${'More words follow here. '.repeat(10)}`;
    expect(condenseNotice(long)).toBe('Covenant warning: leverage is over the limit.');
    const run = 'word '.repeat(60).trim();
    const cut = condenseNotice(run);
    expect(cut.length).toBeLessThanOrEqual(NOTICE_TEXT_MAX);
    expect(cut.endsWith('…')).toBe(true);
    const rows = noticeRows([
      { id: 1, day: 60, kind: 'cabinetFull', message: 'Cabinet A is full.', cabinet: null, milestone: null },
      { id: 2, day: 61, kind: 'milestone', message: 'Milestone!', cabinet: null, milestone: null },
    ]);
    expect(rows.map((r) => [r.text, r.tone, r.toneLabel, r.when])).toEqual([
      ['Cabinet A is full.', 'warn', 'Heads up', 'Mar 2'],
      ['Milestone!', 'ok', 'Good news', 'Mar 3'],
    ]);
  });
});

describe('no jargon on the first view', () => {
  const JARGON = [/leverage/i, /covenant/i, /DSCR/i, /\bARR\b/, /\bOCF\b/, /\bbps\b/i, /×/];
  const check = (view: SummaryView) => {
    for (const text of firstViewText(view)) {
      for (const word of JARGON) expect(text, `"${text}"`).not.toMatch(word);
      expect(text).not.toMatch(/NaN|undefined|null|Infinity/);
    }
  };

  it('says everything on the first view in plain words, in every story and attention case', () => {
    const state = litGame(120);
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    const real = buildBriefing(state)!;
    const plain = [advice('a'), advice('b'), advice('c')];
    const items: AttentionItem[] = [
      { kind: 'bankStage', action: { kind: 'openPanel', panel: 'bank' }, place: null, count: null, stage: 'penalty' },
      { kind: 'bankWatch', action: { kind: 'openPanel', panel: 'bank' }, place: null, count: null, stage: null },
      { kind: 'loansCalled', action: { kind: 'openPanel', panel: 'bank' }, place: null, count: 2, stage: 'frozen' },
      { kind: 'outage', action: { kind: 'focusSegment', segment: 1 }, place: 'Elm St', count: 2, stage: null },
      { kind: 'storm', action: { kind: 'focusNode', node: 1 }, place: 'Elm St & 3rd Ave', count: 2, stage: null },
      { kind: 'cabinetFull', action: { kind: 'focusCabinet', cabinet: 1 }, place: 'Elm St & 3rd Ave', count: 4, stage: null },
    ];
    const loan = money({ bills: 10_000, borrowed: 50_000, otherIn: 300 }, { running: { overheadBase: 2_000, payroll: 4_000 }, building: { construction: 30_000 }, loans: { interest: 900, principal: 2_000 } });
    for (const story of ['earned', 'building', 'billsShort', 'bank'] as const) {
      for (const stage of ['compliant', 'warning', 'penalty', 'frozen'] as const) {
        for (const span of [1, 3]) {
          const b: Briefing = {
            ...real,
            span,
            story,
            advice: plain,
            attention: items.slice(0, ATTENTION_MAX),
            money: loan,
            headline: { ...real.headline, debt: 120_000, stage },
            cash: { ...real.cash, change: loan.cashChange, building: true, withoutBuilding: 3_100 },
          };
          check(summaryView(b, 'Otter Junction Fiber'));
          for (const item of items) check(summaryView({ ...b, attention: [item] }));
        }
      }
    }
    // The real briefing's own figures and words (the advisor's text aside) are plain too.
    check(summaryView({ ...real, advice: plain }));
  });
});

describe('never writing the game', () => {
  const deepFreeze = <T>(value: T): T => {
    if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
      Object.freeze(value);
      for (const child of Object.values(value)) deepFreeze(child);
    }
    return value;
  };

  it('builds, words and points from a frozen state (any write would throw)', () => {
    const state = litGame(95);
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    const report = state.finance.reports.at(-1)!;
    deepFreeze(state);
    for (const setting of ['monthly', 'quarterly', 'attention', 'off'] as const) {
      const b = briefingAtClose(state, report, setting);
      if (b) expect(() => summaryView(b, state.company.name)).not.toThrow();
    }
    for (const a of buildBriefing(state)!.advice) expect(() => actionPoint(state, a.action)).not.toThrow();
  });

  it('knows a close-time briefing from one reopened later in the month', () => {
    const state = litGame(1);
    closeNext(state);
    const atClose = buildBriefing(state)!;
    expect(isCloseTimeBriefing(atClose)).toBe(true);
    runDays(state, 3);
    expect(isCloseTimeBriefing(buildBriefing(state)!)).toBe(false);
    expect(isCloseTimeBriefing({ ...atClose })).toBe(false);
  });
});

describe('Show me', () => {
  it('points at a node, a cabinet or the middle of a segment, and nowhere for a panel or a cabinet that is gone', () => {
    const state = litGame(31);
    const { city } = state;
    const node = city.nodes[1]!;
    expect(actionPoint(state, { kind: 'focusNode', node: 1 })).toEqual({ x: node.x, y: node.y });
    const cabinet = state.network.cabinets[0]!;
    const at = city.nodes[cabinet.node]!;
    expect(actionPoint(state, { kind: 'focusCabinet', cabinet: cabinet.id })).toEqual({ x: at.x, y: at.y });
    const seg = city.segments[0]!;
    const a = city.nodes[seg.a]!;
    const b = city.nodes[seg.b]!;
    expect(actionPoint(state, { kind: 'focusSegment', segment: seg.id })).toEqual({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    expect(actionPoint(state, { kind: 'openPanel', panel: 'bank' })).toBeNull();
    expect(actionPoint(state, SEE_CUSTOMERS)).toBeNull();
    expect(actionPoint(state, { kind: 'focusCabinet', cabinet: 99_999 })).toBeNull();
    expect(actionPoint(state, { kind: 'focusNode', node: city.nodes.length + 5 })).toBeNull();
  });
});
