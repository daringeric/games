// The month-end briefing's pure parts (briefing.ts): when it is due at each
// frequency, the span, the stored preference (storage that throws included),
// the debug-page gate, the view model the sheet renders from a real
// advisor.buildBriefing, and where "Show me" points. Money is checked against
// balance.ts constants and sim results, never literal dollar amounts.

import { describe, expect, it } from 'vitest';
import { ADVICE_SNOOZE_MONTHS, ADVICE_SNOOZE_URGENT_MONTHS, COVENANT_MAX_LEVERAGE, COVENANT_MIN_COVERAGE, CPP_TARGET } from '../sim/balance';
import { buildBriefing, COVENANT_RISK_MARGIN } from '../sim/advisor';
import { applyCommand, runDays } from '../sim/game';
import { addLivePlant, makeGridCity, makeTestState } from '../sim/testing/fixtures';
import type { Briefing, BriefingChange, CovenantMetrics, GameState, LedgerCategory, Notice } from '../sim/types';
import {
  ALERTS_MAX,
  BRIEFING_FREQUENCIES,
  BRIEFING_STORAGE_KEY,
  BriefingPreference,
  CATEGORY_LABEL,
  CPP_BAND_TEXT,
  DEFAULT_BRIEFING_FREQUENCY,
  FREQUENCY_LABEL,
  GLANCE_KEYS,
  NOTICE_ROWS_MAX,
  NOTICE_TEXT_MAX,
  QUARTER_MONTHS,
  actionPoint,
  alertRows,
  briefingAtClose,
  briefingDue,
  briefingSpan,
  briefingTitle,
  briefingView,
  changeRow,
  condenseNotice,
  cppTargetText,
  debtTone,
  isCloseTimeBriefing,
  noticeRows,
  readBriefingFrequency,
  snoozeLabel,
  startingBriefingSetting,
  writeBriefingFrequency,
} from './briefing';
import type { PreferenceStorage } from './briefing';
import { formatMoney, formatPercent, formatSignedMoney } from './format';

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
    // Shown exactly when the briefing says something needs attention.
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
    // Junk in storage reads as the default.
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
    // Node has no localStorage: the default storage reads as the default.
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
    // A choice that cannot be stored still applies to the page.
    const blocked = new BriefingPreference('monthly', () => throwing);
    expect(blocked.choose('attention')).toBe(false);
    expect(blocked.current).toBe('attention');
  });

  it('labels each frequency for the radio group', () => {
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

describe('the briefing view', () => {
  const briefingOf = (days: number, span = 1): Briefing => {
    const state = litGame(days);
    const b = buildBriefing(state, span);
    if (!b) throw new Error('no briefing');
    return b;
  };

  it('titles the month in full, or the quarter by its months', () => {
    const b = briefingOf(120);
    expect(b.report.month).toBe(4);
    expect(briefingTitle(b)).toBe(`April ${b.report.year} briefing`);
    const q = briefingOf(120, 3);
    expect(briefingTitle(q)).toBe(`Feb–Apr ${q.report.year} briefing`);
  });

  it('puts the headline at a glance: net, cash, subscribers, passings, take rate, cost per passing and debt', () => {
    const b = briefingOf(120);
    const view = briefingView(b, 'Otter Junction Fiber');
    expect(view.title).toBe(briefingTitle(b));
    // The company name leads the subtitle.
    expect(view.subtitle).toMatch(/^Otter Junction Fiber · game paused\. /);
    expect(briefingView(b).subtitle).toMatch(/^game paused\. /);
    expect(view.tiles.map((t) => t.key)).toEqual(['net', 'cash', 'subscribers', 'passings', 'takeRate', 'cpp', 'debt']);
    expect(view.tiles.map((t) => t.key)).toEqual(GLANCE_KEYS);
    const tile = (key: string) => view.tiles.find((t) => t.key === key)!;
    expect(tile('net').value).toBe(formatSignedMoney(b.headline.net));
    expect(tile('cash').value).toBe(formatMoney(b.headline.cash));
    expect(tile('subscribers').value).toBe(String(b.headline.subscribers));
    expect(tile('takeRate').value).toBe(formatPercent(b.headline.takeRate!));
    expect(tile('debt')).toMatchObject({ value: formatMoney(0), detail: 'No loans', tone: null });
    for (const t of view.tiles) {
      expect(t.label).toMatch(/^\S/);
      expect(`${t.value} ${t.detail ?? ''}`).not.toMatch(/NaN|undefined|null|Infinity/);
    }
  });

  it('colors cost per passing by band and says it in words, against the target', () => {
    const b = briefingOf(60);
    for (const band of ['green', 'amber', 'red'] as const) {
      const view = briefingView({ ...b, headline: { ...b.headline, cpp: CPP_TARGET, cppBand: band } });
      const cpp = view.tiles.find((t) => t.key === 'cpp')!;
      expect(cpp.value).toBe(formatMoney(CPP_TARGET));
      expect(cpp.tone).toBe(band);
      expect(cpp.detail).toBe(`${CPP_BAND_TEXT[band]} the ${formatMoney(CPP_TARGET)} target`);
    }
    expect(cppTargetText('red', CPP_TARGET)).toBe(`Far over the ${formatMoney(CPP_TARGET)} target`);
    const none = briefingView({ ...b, headline: { ...b.headline, cpp: null, cppBand: null } }).tiles.find((t) => t.key === 'cpp')!;
    expect(none).toMatchObject({ value: '–', tone: null, detail: `Target ${formatMoney(CPP_TARGET)}` });
  });

  it('never colors the debt success green: neutral in good standing, amber or red only for covenant trouble', () => {
    const b = briefingOf(60);
    /** Covenant figures with leverage and coverage `share` of the way from comfortable to their limits (1: on them). */
    const covenant = (leverage: number, coverage: number): CovenantMetrics => ({
      ...b.headline.covenant,
      totalDebt: 250_000,
      annualDebtService: 40_000,
      leverage,
      coverage,
      leverageOk: leverage <= COVENANT_MAX_LEVERAGE,
      coverageOk: coverage >= COVENANT_MIN_COVERAGE,
      compliant: leverage <= COVENANT_MAX_LEVERAGE && coverage >= COVENANT_MIN_COVERAGE,
    });
    const clear = covenant(COVENANT_MAX_LEVERAGE * 0.5, COVENANT_MIN_COVERAGE * 2);
    const near = covenant(COVENANT_MAX_LEVERAGE * (1 - COVENANT_RISK_MARGIN / 2), COVENANT_MIN_COVERAGE * 2);
    const breached = covenant(COVENANT_MAX_LEVERAGE * 1.2, COVENANT_MIN_COVERAGE * 2);
    const tile = (over: Partial<Briefing['headline']>, forward: Partial<Briefing['forward']> = {}) =>
      briefingView({ ...b, headline: { ...b.headline, debt: 250_000, ...over }, forward: { ...b.forward, ...forward } }).tiles.find((t) => t.key === 'debt')!;

    // Nothing owed, or owed in good standing with room to spare: no color at all.
    expect(debtTone(b)).toBeNull();
    const good = tile({ stage: 'compliant', covenant: clear });
    expect(good.tone).toBeNull();
    expect(good.detail).toMatch(/^Compliant: leverage .+, coverage .+$/);
    // Compliant but a covenant near its limit (the advisor's warning), or breached at today's figures: amber, said in words.
    const atRisk = tile({ stage: 'compliant', covenant: near });
    expect(atRisk.tone).toBe('warn');
    expect(atRisk.detail).toMatch(/^At risk: leverage /);
    expect(tile({ stage: 'compliant', covenant: breached }).tone).toBe('warn');
    // The warning and penalty stages: amber.
    const warned = tile({ stage: 'warning', covenant: clear });
    expect(warned.tone).toBe('warn');
    expect(warned.detail).toMatch(/^Warning/);
    const unmeasurable = { ...clear, leverage: null };
    const penalty = tile({ stage: 'penalty', covenant: unmeasurable });
    expect(penalty.tone).toBe('warn');
    expect(penalty.detail).toMatch(/^Penalty rate: leverage not measurable, coverage /);
    // Frozen, or the loans called: red.
    const frozen = tile({ stage: 'frozen', covenant: breached });
    expect(frozen.tone).toBe('danger');
    expect(frozen.detail).toMatch(/^Frozen: leverage .+, coverage .+$/);
    const called = tile({ stage: 'frozen', covenant: breached }, { accelerationClosesLeft: 2 });
    expect(called.tone).toBe('danger');
    expect(called.detail).toMatch(/^Loans called: /);
    // Whatever the stage, never the success tone.
    for (const stage of ['compliant', 'warning', 'penalty', 'frozen'] as const) {
      for (const cov of [clear, near, breached]) expect(['warn', 'danger', null]).toContain(tile({ stage, covenant: cov }).tone);
    }
    // Its change against the month before is neutral news, whichever way it went.
    const more = { ...b.changes.find((c) => c.key === 'debt')!, now: 250_000, before: 100_000, delta: 150_000, upIsGood: false };
    const less = { ...more, now: 50_000, delta: -50_000 };
    for (const change of [more, less]) {
      const t = briefingView({ ...b, changes: b.changes.map((c) => (c.key === 'debt' ? change : c)) }).tiles.find((x) => x.key === 'debt')!;
      expect(t.change).toMatchObject({ tone: 'neutral' });
      expect(changeRow(change).tone).toBe('neutral');
    }
    // The sim's own change row says neutral too.
    expect(b.changes.find((c) => c.key === 'debt')!.upIsGood).toBeNull();
  });

  it('puts each tile’s change against the month before in the tile, and keeps only the rest in what changed', () => {
    const b = briefingOf(120);
    const view = briefingView(b);
    expect(view.comparedWith).toBe('March');
    // Every tile says how it moved, in words.
    for (const tile of view.tiles) {
      const row = changeRow(b.changes.find((c) => c.key === tile.key)!);
      expect(tile.change, tile.key).toEqual({ direction: row.direction, text: row.change, before: row.before, tone: row.tone });
      if (tile.change!.direction === 'up' || tile.change!.direction === 'down') expect(tile.change!.text).toMatch(new RegExp(`^${tile.change!.direction} `));
    }
    // What changed holds only what is not a tile: revenue and operating cash flow.
    expect(view.changes.map((c) => c.key)).toEqual(['revenue', 'operatingCashFlow']);
    for (const row of view.changes) expect(row.value).not.toMatch(/NaN|undefined/);
    // The first month has nothing to compare with.
    const first = briefingView(briefingOf(31));
    expect(first.changes).toEqual([]);
    expect(first.comparedWith).toBeNull();
    for (const tile of first.tiles) expect(tile.change).toBeNull();
  });

  it('never shows a figure both in the glance and in what changed', () => {
    for (const days of [60, 120, 181]) {
      for (const span of [1, 3]) {
        const view = briefingView(briefingOf(days, span));
        const tileKeys = new Set<string>(view.tiles.map((t) => t.key));
        for (const row of view.changes) expect(tileKeys.has(row.key), row.key).toBe(false);
        // No tile's small print quotes a what-changed figure (the operating cash flow used to sit under net).
        const figures = view.changes.map((c) => c.value).filter((v) => v !== '–');
        for (const tile of view.tiles) for (const figure of figures) expect(`${tile.value} ${tile.detail ?? ''}`).not.toContain(figure);
      }
    }
  });

  it('folds the money in and out, the notices and the look ahead into closed details', () => {
    const view = briefingView(briefingOf(120));
    expect(view.details).toEqual(['money', 'notices', 'forward']);
    expect(view.noticeCount).toBe(briefingOf(120).notices.length);
  });

  it('turns a change into words: up or down by how much, good or bad by upIsGood, no change when it rounds away', () => {
    const change = (over: Partial<BriefingChange>): BriefingChange => ({
      key: 'cash',
      label: 'Cash',
      now: 1_500,
      before: 1_000,
      delta: 500,
      upIsGood: true,
      unit: 'money',
      ...over,
    });
    expect(changeRow(change({}))).toMatchObject({ direction: 'up', change: `up ${formatMoney(500)}`, tone: 'good', before: `was ${formatMoney(1_000)}` });
    expect(changeRow(change({ now: 500, delta: -500 }))).toMatchObject({ direction: 'down', change: `down ${formatMoney(500)}`, tone: 'bad' });
    // Debt is neutral news whichever way it moves (round 4b).
    expect(changeRow(change({ key: 'debt', upIsGood: false }))).toMatchObject({ direction: 'up', tone: 'neutral' });
    expect(changeRow(change({ key: 'debt', upIsGood: false, now: 500, delta: -500 }))).toMatchObject({ direction: 'down', tone: 'neutral' });
    expect(changeRow(change({ key: 'cpp', upIsGood: false, now: 500, delta: -500 }))).toMatchObject({ direction: 'down', tone: 'good' });
    expect(changeRow(change({ upIsGood: null }))).toMatchObject({ direction: 'up', tone: 'neutral' });
    expect(changeRow(change({ delta: 0.3 }))).toMatchObject({ direction: 'flat', change: 'no change', tone: 'neutral' });
    expect(changeRow(change({ before: null, delta: null }))).toMatchObject({ direction: null, change: '–', before: null, tone: 'neutral' });
    expect(changeRow(change({ now: null, delta: null })).value).toBe('–');
    // Net and operating cash flow read signed; ratios move in points.
    expect(changeRow(change({ key: 'net', now: 1_500 })).value).toBe(formatSignedMoney(1_500));
    expect(changeRow(change({ key: 'takeRate', unit: 'ratio', now: 0.35, before: 0.32, delta: 0.03 }))).toMatchObject({
      value: formatPercent(0.35),
      change: 'up 3.0 pts',
      tone: 'good',
    });
    expect(changeRow(change({ key: 'takeRate', unit: 'ratio', now: 0.35, before: 0.3499, delta: 0.0001 })).direction).toBe('flat');
    expect(changeRow(change({ key: 'subscribers', unit: 'count', now: 1_200, before: 1_000, delta: 200 })).change).toBe('up 200');
  });

  it('groups the money in and out into readable categories that sum to the net', () => {
    const b = briefingOf(120);
    const view = briefingView(b);
    const rows = view.money.flatMap((g) => g.rows);
    expect(rows.map((r) => r.category)).toEqual(expect.arrayContaining(b.breakdown.map((l) => l.category)));
    expect(rows).toHaveLength(b.breakdown.length);
    for (const r of rows) expect(r.label).toBe(CATEGORY_LABEL[r.category]);
    const revenue = rows.find((r) => r.category === 'revenue');
    expect(revenue?.label).toBe('Subscriber billing');
    expect(view.net).toBe(formatSignedMoney(b.headline.net));
    // Every category has a label of its own.
    const labels = Object.values(CATEGORY_LABEL);
    expect(new Set(labels).size).toBe(labels.length);
    expect(Object.keys(CATEGORY_LABEL).sort()).toEqual(
      (['construction', 'equipment', 'install', 'refund', 'poleRent', 'revenue', 'overhead', 'payroll', 'marketing', 'repair', 'interest', 'principal', 'loanProceeds', 'other'] satisfies LedgerCategory[]).sort(),
    );
  });

  it('looks ahead: the next close, its payment, projected cash, runway and the frozen countdown', () => {
    const b = briefingOf(120);
    const view = briefingView(b);
    expect(view.forward.map((r) => r.key)).toEqual(['nextClose', 'payment', 'projectedCash', 'runway']);
    expect(view.forward.find((r) => r.key === 'payment')!.value).toBe('None due');
    expect(view.forward.find((r) => r.key === 'projectedCash')!.value).toBe(formatMoney(b.forward.projectedCash));
    const frozen = briefingView({ ...b, forward: { ...b.forward, nextPayment: 4_000, closesUntilCalled: 2, runwayMonths: 2 } });
    expect(frozen.forward.find((r) => r.key === 'payment')).toMatchObject({ value: formatMoney(4_000), detail: expect.stringMatching(/^due \w{3} 1, \d{4}: /) });
    expect(frozen.forward.find((r) => r.key === 'called')).toMatchObject({ value: 'in 2 closes', tone: 'danger' });
    expect(frozen.forward.find((r) => r.key === 'runway')).toMatchObject({ value: '2 months', tone: 'danger' });
    const called = briefingView({ ...b, forward: { ...b.forward, accelerationClosesLeft: 3 } });
    expect(called.forward.find((r) => r.key === 'acceleration')).toMatchObject({ value: 'everything due within 3 closes', tone: 'danger' });
  });

  it('renders whatever advice there is, with its severity, reason and action label', () => {
    const state = litGame(120);
    const cabinet = state.network.cabinets[0]!;
    state.sales.fullCabinets = [cabinet.id];
    const b = buildBriefing(state)!;
    expect(b.advice.length).toBeGreaterThan(0);
    const view = briefingView(b);
    expect(view.advice).toHaveLength(b.advice.length);
    const split = view.advice.find((a) => a.action.kind === 'focusCabinet');
    expect(split).toBeDefined();
    expect(split!.actionLabel).toBe(b.advice.find((a) => a.id === 'addSplitter')!.actionLabel);
    for (const card of view.advice) {
      expect(card.severityLabel).toMatch(/^(Urgent|Important|Tip)$/);
      expect(card.title).toBeTruthy();
      expect(card.why).toBeTruthy();
      expect(card.key).toBe(b.advice.find((a) => a.title === card.title)!.key);
      expect(card.snoozeLabel).toBe(snoozeLabel(card.severity));
    }
  });

  it('labels the snooze with how long it lasts, and counts what is snoozed', () => {
    const months = (n: number) => (n === 1 ? 'Snooze until next month' : `Snooze ${n} months`);
    expect(snoozeLabel('tip')).toBe(months(ADVICE_SNOOZE_MONTHS));
    expect(snoozeLabel('important')).toBe(months(ADVICE_SNOOZE_MONTHS));
    expect(snoozeLabel('urgent')).toBe(months(ADVICE_SNOOZE_URGENT_MONTHS));
    expect(months(3)).toBe('Snooze 3 months');

    const state = litGame(120);
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    const before = briefingView(buildBriefing(state)!);
    expect(before.snoozed).toBe(0);
    expect(before.snoozedText).toBeNull();
    const card = before.advice[0]!;
    expect(applyCommand(state, { type: 'snoozeAdvice', key: card.key }).ok).toBe(true);
    const after = briefingView(buildBriefing(state)!);
    expect(after.advice.some((a) => a.key === card.key)).toBe(false);
    expect(after.snoozed).toBe(1);
    expect(after.snoozedText).toBe('1 snoozed suggestion');
  });

  it('surfaces notices that need attention in the glance, newest first, keeping the full list', () => {
    const b = briefingOf(60);
    const notice = (id: number, kind: Notice['kind']): Notice => ({ id, day: b.report.month * 30, kind, message: `${kind} ${id}.`, cabinet: null, milestone: null });
    const notices = [notice(1, 'insolvencyWarning'), notice(2, 'milestone'), notice(3, 'covenantWarning'), notice(4, 'creditFrozen'), notice(5, 'cabinetFull')];
    const alerts = alertRows({ notices, needsAttention: true });
    expect(alerts.map((a) => a.text)).toEqual(['creditFrozen 4.', 'covenantWarning 3.']);
    expect(alerts.length).toBeLessThanOrEqual(ALERTS_MAX);
    expect(alertRows({ notices, needsAttention: false })).toEqual([]);
    const view = briefingView({ ...b, notices, needsAttention: true });
    expect(view.alerts).toEqual(alerts);
    expect(view.notices).toHaveLength(notices.length);
  });

  it('knows a close-time briefing from one reopened later in the month', () => {
    const state = litGame(1);
    closeNext(state);
    const atClose = buildBriefing(state)!;
    expect(isCloseTimeBriefing(atClose)).toBe(true);
    runDays(state, 3);
    expect(isCloseTimeBriefing(buildBriefing(state)!)).toBe(false);
    // A copy (not built by buildBriefing) never counts.
    expect(isCloseTimeBriefing({ ...atClose })).toBe(false);
  });
});

describe('notices in the briefing', () => {
  const notice = (id: number, message: string, kind: Notice['kind'] = 'cabinetFull'): Notice => ({ id, day: 59 + id, kind, message, cabinet: null, milestone: null });

  it('keeps short notices whole and cuts long ones to their first sentence', () => {
    expect(condenseNotice('Cabinet full.')).toBe('Cabinet full.');
    const long = `Covenant warning: leverage is over the limit. ${'More words follow here. '.repeat(10)}`;
    expect(condenseNotice(long)).toBe('Covenant warning: leverage is over the limit.');
    const colon = `Covenant breach at the May 2027 close while on warning: leverage 99.52× is over the limit (${'and a long reason '.repeat(8)}).`;
    expect(condenseNotice(colon)).toBe('Covenant breach at the May 2027 close while on warning.');
    const run = 'word '.repeat(60).trim();
    const cut = condenseNotice(run);
    expect(cut.length).toBeLessThanOrEqual(NOTICE_TEXT_MAX);
    expect(cut.endsWith('…')).toBe(true);
  });

  it('folds identical notices together, keeps their order and counts the ones past the limit', () => {
    const notices = [notice(1, 'Cabinet A is full.'), notice(2, 'Cabinet A is full.'), notice(3, 'Milestone!', 'milestone')];
    const { rows, more } = noticeRows(notices);
    expect(rows.map((r) => [r.text, r.count, r.tone])).toEqual([
      ['Cabinet A is full.', 2, 'warn'],
      ['Milestone!', 1, 'ok'],
    ]);
    expect(rows[0]!.toneLabel).toBe('Heads up');
    expect(rows[0]!.when).toBe('Mar 2');
    expect(more).toBe(0);
    const many = Array.from({ length: NOTICE_ROWS_MAX + 3 }, (_, i) => notice(i + 1, `Notice ${i}.`));
    const capped = noticeRows(many);
    expect(capped.rows).toHaveLength(NOTICE_ROWS_MAX);
    expect(capped.more).toBe(3);
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
      if (b) expect(() => briefingView(b, state.city.name)).not.toThrow();
    }
    for (const a of buildBriefing(state)!.advice) expect(() => actionPoint(state, a.action)).not.toThrow();
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
    expect(actionPoint(state, { kind: 'focusCabinet', cabinet: 99_999 })).toBeNull();
    expect(actionPoint(state, { kind: 'focusNode', node: city.nodes.length + 5 })).toBeNull();
  });
});
