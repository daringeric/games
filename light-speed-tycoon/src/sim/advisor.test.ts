// The month-end briefing and the advisor (round 4). Per rule: it fires and
// does not fire, its severity agrees with its priority band, its reason
// quotes the figures (computed here from the sim, never as literal dollar
// amounts), its action points at the right thing, and what it suggests never
// backfires: the plan's commands are applied to a copy of the game, which
// must stay covenant-compliant and keep at least the next debt service (and
// what the plan promises to keep). Then the briefing, determinism and the
// time budget on a generated town.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CABINET_START_SPLITTERS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  FROZEN_ACCELERATION_CLOSES,
  INCUMBENT_PRICE,
  MAX_SPLITTERS_PER_CABINET,
  OLT_CARD_COST,
  OLT_MAX_CARDS,
  OLT_PORTS_PER_CARD,
  SPLIT_RATIO,
  SPLITTER_COST,
  STORM_LOG_DAYS,
  TERM_LOAN_MIN,
  TIER_DEFAULTS,
  CONVERT_PAYBACK_YEARS,
  MARKETING_PER_PASSING_GOOD,
} from './balance';
import {
  ADVICE_MAX,
  ADVICE_ORDER,
  ADVICE_PRIORITY,
  advicePlans,
  advise,
  ATTENTION_NOTICE_KINDS,
  buildBriefing,
  closeDayOf,
  COVENANT_RISK_MARGIN,
  EXPAND_CANDIDATES_MAX,
  expandCandidates,
  nextCloseDay,
  noticeNeedsAttention,
  planFor,
  rankAdvice,
  TAKE_RATE_LAG_SHARE,
  TAKE_RATE_MATURE_MONTHS,
  TAKE_RATE_MIN_PACE,
} from './advisor';
import type { AdvicePlan } from './advisor';
import { DAYS_PER_YEAR, formatDate } from './calendar';
import { coveragePreview } from './coverage';
import {
  acceleratedSchedule,
  closesUntilAcceleration,
  covenantMetrics,
  cureOptions,
  estimateNextDebtService,
  formatMultiple,
  fundingHint,
  formatRateBps,
  maxSafeTermLoan,
  quoteTermLoan,
  totalDebt,
} from './debt';
import { estimateCashAtClose, formatMoney, monthlyBurn, runwayMonths } from './finance';
import { applyCommand, runDays } from './game';
import { incumbentPromoPrice } from './incumbent';
import { REPAIR_TRAILING_MONTHS } from './metrics';
import { getService, outageImpact, ponPortsUsed, quoteConvert } from './network';
import { churnProbability, closeDayAfter, marketingBoost, stateTakeRate, unitsByTier } from './sales';
import { deserialize, hashState, serialize } from './save';
import { cornerName } from './streets';
import { addLivePlant, makeGridCity, makeLoan, makeTestState, makeTradingState } from './testing/fixtures';
import type { Advice, AdviceId, CableSpan, GameState, Notice, TierId } from './types';
import { outageChurnProbability, repairCost } from './weather';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A grid town fully lit from the CO, run long enough to have subscribers and closed months. */
function litGame(days = 120) {
  const state = makeTestState(makeGridCity({ cols: 3, rows: 2 }));
  addLivePlant(state, { splitters: 4 });
  runDays(state, days);
  return state;
}

/** A wider grid (64 homes) lit from a cabinet at its center. */
function centerGame(days: number, marketing?: number) {
  const state = makeTestState(makeGridCity({ cols: 4, rows: 2, coAt: [2, 1] }));
  addLivePlant(state, { splitters: 4 });
  if (marketing !== undefined) applyCommand(state, { type: 'setMarketing', perMonth: marketing });
  runDays(state, days);
  return state;
}

const clone = (state: GameState): GameState => deserialize(serialize(state));

function fixture(name: 'v3-grid' | 'v3-town'): GameState {
  return deserialize(readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8'));
}

/** A state with closed months that billed `revenue` and spent `costs` (makeTradingState: the 10th of April 2027) and `cash`. */
function trading(revenue: number, costs: number, cash: number): GameState {
  const state = makeTradingState(revenue, costs);
  state.finance.cash = cash;
  return state;
}

/** Give `state` one term loan (makeLoan) taken on day 0. */
function withLoan(state: GameState, principal: number): GameState {
  state.debt.loans = [makeLoan({ principal, originatedDay: 0 })];
  state.debt.nextLoanId = 2;
  return state;
}

/**
 * The plan of rule `id` on `state`, which must fire; every plan a test gets
 * this way is also checked to be well formed and never to backfire.
 */
function plan(state: GameState, id: AdviceId): AdvicePlan {
  const found = planFor(state, id);
  expect(found, `${id} should fire`).not.toBeNull();
  const p = found as AdvicePlan;
  expect(p.advice.id).toBe(id);
  expectWellFormed(p.advice);
  expectNoBackfire(state, p);
  // Deterministic: the same on a second call and on a copy.
  expect(planFor(state, id)).toEqual(p);
  expect(planFor(clone(state), id)).toEqual(p);
  return p;
}

/** The band a severity's priorities lie in. */
const BAND = { urgent: [300, 399], important: [200, 299], tip: [100, 199] } as const;

function expectWellFormed(advice: Advice): void {
  const [lo, hi] = BAND[advice.severity];
  expect(advice.priority).toBeGreaterThanOrEqual(lo);
  expect(advice.priority).toBeLessThanOrEqual(hi);
  const label =
    advice.action.kind === 'openPanel' ? { pricing: 'Open Pricing', bank: 'Open Bank', olt: 'Open OLT' }[advice.action.panel] : 'Show me';
  expect(advice.actionLabel).toBe(label);
  expect(advice.title.length).toBeGreaterThan(0);
  expect(advice.why.length).toBeGreaterThan(0);
  // Plain prose: no unformatted numbers like 1234.5678 or NaN leak through.
  expect(advice.why).not.toMatch(/NaN|undefined|Infinity|\d\.\d{3,}/);
}

/** Commands that borrow or repay (the covenant-safe ones). */
const FINANCING = new Set(['drawCredit', 'takeTermLoan', 'repayCredit', 'prepayLoan']);

/**
 * Apply a plan's commands to a copy: each must succeed, the copy must stay
 * covenant-compliant when the plan borrows or repays, and keep at least the
 * next debt service and what the plan promises to keep (after its extra
 * spend). Returns the copy.
 */
function expectNoBackfire(state: GameState, p: AdvicePlan): GameState {
  const after = clone(state);
  for (const command of p.commands) {
    const result = applyCommand(after, command);
    expect(result, `${p.advice.id}: ${JSON.stringify(command)}`).toMatchObject({ ok: true });
  }
  if (p.commands.some((c) => FINANCING.has(c.type))) expect(covenantMetrics(after).compliant).toBe(true);
  if (p.commands.length > 0) {
    const left = after.finance.cash - p.extraSpend;
    expect(left).toBeGreaterThanOrEqual(estimateNextDebtService(after));
    expect(left).toBeGreaterThanOrEqual(p.keep);
  }
  return after;
}

/**
 * Every plan on `state` is well formed and safe on its own, and following
 * all of them together (in rule order, as advicePlans claims) is safe too;
 * returns the ids that fired.
 */
function expectAllSafe(state: GameState): AdviceId[] {
  const plans = advicePlans(state);
  for (const p of plans) {
    expectWellFormed(p.advice);
    expectNoBackfire(state, p);
  }
  expectTogetherSafe(state, plans);
  return plans.map((p) => p.advice.id);
}

/** Apply every plan's commands to one copy, in rule order: all succeed, compliant if any borrows or repays, and the cash kept covers the next debt service and every plan's promise. */
function expectTogetherSafe(state: GameState, plans: readonly AdvicePlan[]): GameState {
  const after = clone(state);
  const ordered = [...plans].sort((a, b) => ADVICE_ORDER.indexOf(a.advice.id) - ADVICE_ORDER.indexOf(b.advice.id));
  let extra = 0;
  for (const p of ordered) {
    for (const command of p.commands) expect(applyCommand(after, command), `${p.advice.id}: ${JSON.stringify(command)}`).toMatchObject({ ok: true });
    extra += p.extraSpend;
  }
  if (ordered.some((p) => p.commands.some((c) => FINANCING.has(c.type)))) expect(covenantMetrics(after).compliant).toBe(true);
  if (ordered.some((p) => p.commands.length > 0)) {
    expect(after.finance.cash - extra).toBeGreaterThanOrEqual(estimateNextDebtService(after));
    for (const p of ordered) expect(after.finance.cash - extra).toBeGreaterThanOrEqual(p.keep);
  }
  return after;
}

const advice = (id: AdviceId, priority: number): Advice => ({
  id,
  priority,
  severity: priority >= 300 ? 'urgent' : priority >= 200 ? 'important' : 'tip',
  title: id,
  why: id,
  action: { kind: 'openPanel', panel: 'bank' },
  actionLabel: 'Open Bank',
});

const pct = (x: number) => `${Math.round(x * 100)}%`;
const pct1 = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

/** "Apr 1": how the advice names a close. */
function closeName(day: number): string {
  return formatDate(nextCloseDay(day)).replace(/, \d+$/, '');
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

describe('advice frame', () => {
  it('ranks by priority, then by rule order', () => {
    const ranked = rankAdvice([advice('expand', 150), advice('addSplitter', 220), advice('paymentShort', 220), advice('pricing', 150)]);
    expect(ranked.map((a) => a.id)).toEqual(['paymentShort', 'addSplitter', 'pricing', 'expand']);
    expect(new Set(ADVICE_ORDER).size).toBe(ADVICE_ORDER.length);
  });

  it('keeps every rule priority inside a band', () => {
    for (const priority of Object.values(ADVICE_PRIORITY)) {
      expect(priority).toBeGreaterThanOrEqual(100);
      expect(priority).toBeLessThanOrEqual(399);
    }
  });

  it('advises adding a splitter at a full cabinet, and nothing once the game is over', () => {
    const state = litGame(31);
    const cabinet = state.network.cabinets[0]!;
    state.sales.fullCabinets = [cabinet.id];
    const top = advise(state);
    expect(top.length).toBeLessThanOrEqual(ADVICE_MAX);
    const splitter = top.find((a) => a.id === 'addSplitter');
    expect(splitter).toMatchObject({ severity: 'important', action: { kind: 'focusCabinet', cabinet: cabinet.id }, actionLabel: 'Show me' });
    state.gameOver = { day: state.day, reason: 'insolvent', message: 'x' };
    expect(advise(state)).toEqual([]);
    expect(advicePlans(state)).toEqual([]);
    expect(planFor(state, 'addSplitter')).toBeNull();
  });

  it('returns at most `max`, ranked, and the same as the candidates it cuts', () => {
    const state = fixture('v3-grid');
    const all = advicePlans(state).map((p) => p.advice);
    expect(advise(state, 1)).toEqual(all.slice(0, 1));
    expect(advise(state, 0)).toEqual([]);
    expect(advise(state)).toEqual(all.slice(0, ADVICE_MAX));
    expect(rankAdvice(all)).toEqual(all);
  });
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe('paymentShort', () => {
  /** A borrower whose cash at the next close falls short of its loan payment (no subscribers: the month only costs). */
  function shortOfPayment(): GameState {
    const state = withLoan(trading(20_000, 10_000, 0), 60_000);
    state.finance.cash = estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1;
    return state;
  }

  it('fires when the cash projected at the close cannot pay it, with a covenant-safe draw that covers it', () => {
    const state = shortOfPayment();
    const service = estimateNextDebtService(state);
    const projected = estimateCashAtClose(state);
    expect(projected).toBeLessThan(service);
    const p = plan(state, 'paymentShort');
    expect(p.advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.paymentShort, action: { kind: 'openPanel', panel: 'bank' }, actionLabel: 'Open Bank' });
    expect(p.advice.title).toBe(`Cover the ${closeName(state.day)} loan payment`);
    expect(p.advice.why).toContain(formatMoney(service));
    expect(p.advice.why).toContain(formatMoney(projected));
    expect(p.advice.why).toContain(formatMoney(service - projected));
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0]).toMatchObject({ type: 'drawCredit' });
    const draw = (p.commands[0] as { amount: number }).amount;
    expect(p.advice.why).toContain(`${formatMoney(draw)} credit-line draw`);
    // Never backfires: compliant, and the close can pay with the draw (its interest included).
    const after = expectNoBackfire(state, p);
    expect(estimateCashAtClose(after)).toBeGreaterThanOrEqual(estimateNextDebtService(after));
  });

  it('says a missed payment is a default while frozen, and offers no borrowing', () => {
    const state = shortOfPayment();
    state.debt.covenant.stage = 'frozen';
    const p = plan(state, 'paymentShort');
    expect(p.commands).toEqual([]);
    expect(p.advice.why).toMatch(/frozen.*default/);
    expect(p.advice.why).not.toMatch(/draw|term loan/);
  });

  it('says cut spending when no covenant-safe borrowing covers it', () => {
    // No revenue history: nothing to lend against.
    const state = withLoan(trading(0, 10_000, 0), 60_000);
    state.finance.cash = estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1;
    const p = plan(state, 'paymentShort');
    expect(p.commands).toEqual([]);
    expect(p.advice.why).toContain('No covenant-safe borrowing covers it');
    expect(p.advice.why).toContain(formatMoney(state.sales.marketingPerMonth));
  });

  it('does not fire with nothing due or when cash covers it', () => {
    expect(planFor(trading(20_000, 10_000, 0), 'paymentShort')).toBeNull();
    const state = withLoan(trading(20_000, 10_000, 500_000), 60_000);
    expect(planFor(state, 'paymentShort')).toBeNull();
  });
});

describe('loansCalled', () => {
  function called(closesLeft: number): GameState {
    const state = withLoan(trading(20_000, 10_000, 200_000), 60_000);
    state.debt.credit.balance = 20_000;
    state.debt.covenant.stage = 'frozen';
    state.debt.frozenCloses = FROZEN_ACCELERATION_CLOSES;
    state.debt.acceleration = { day: state.day - 9, closesLeft };
    return state;
  }

  it('says what falls due at the next close against projected cash, and over the closes left', () => {
    const state = called(2);
    const schedule = acceleratedSchedule(state);
    const p = plan(state, 'loansCalled');
    expect(p.advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.loansCalled, action: { kind: 'openPanel', panel: 'bank' } });
    expect(p.advice.title).toBe(`Repay ${formatMoney(totalDebt(state))} over the next 2 closes`);
    expect(p.advice.why).toContain(formatMoney(schedule[0]!));
    expect(p.advice.why).toContain(formatMoney(estimateCashAtClose(state)));
    expect(p.advice.why).toContain(formatMoney(schedule.slice(1).reduce((a, b) => a + b, 0)));
    expect(p.advice.why).toContain('default');
    expect(p.commands).toEqual([]);
  });

  it('names the last close when one is left, and does not fire before the call or with nothing owed', () => {
    const last = called(1);
    expect(plan(last, 'loansCalled').advice.title).toBe(`Repay all ${formatMoney(totalDebt(last))} at the ${closeName(last.day)} close`);
    const state = called(2);
    state.debt.acceleration = null;
    expect(planFor(state, 'loansCalled')).toBeNull();
    const paid = called(2);
    paid.debt.loans = [];
    paid.debt.credit.balance = 0;
    expect(planFor(paid, 'loansCalled')).toBeNull();
  });
});

describe('covenantCure', () => {
  /** A compliant-stage borrower breaching leverage at today's figures: debt far above 5x its underwriting cash flow. */
  function overLevered(cash: number, day?: number): GameState {
    const state = trading(10_000, 9_000, cash);
    if (day !== undefined) state.day = day;
    state.debt.credit.balance = 300_000;
    return state;
  }

  it('on the frozen hoarder (v3-grid): urgent, with the first verified cure, and the cure never backfires', () => {
    const state = fixture('v3-grid');
    const m = covenantMetrics(state);
    expect(m.compliant).toBe(false);
    const option = cureOptions(state)[0]!;
    const p = plan(state, 'covenantCure');
    expect(p.advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.covenantCureUrgent, action: { kind: 'openPanel', panel: 'bank' } });
    expect(p.advice.why).toContain(option.text);
    expect(p.advice.why).toContain(formatMultiple(m.leverage!));
    expect(p.advice.why).toContain(formatMultiple(m.coverage!));
    expect(p.commands).toEqual([{ type: 'prepayLoan', loan: option.loan, amount: option.amount }]);
    const after = expectNoBackfire(state, p);
    expect(after.finance.cash).toBeGreaterThanOrEqual(estimateNextDebtService(after));
  });

  it('is important while the close is far off on a compliant stage, urgent when it is near or the stage is penalty', () => {
    const far = overLevered(500_000);
    expect(nextCloseDay(far.day) - far.day).toBeGreaterThan(10);
    const p = plan(far, 'covenantCure');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.covenantCureAtRisk });
    const option = cureOptions(far)[0]!;
    expect(option.kind).toBe('repayCredit');
    expect(p.advice.title).toBe(`Repay ${formatMoney(option.amount)} of the credit line`);
    expect(p.commands).toEqual([{ type: 'repayCredit', amount: option.amount }]);
    expectNoBackfire(far, p);

    const near = overLevered(500_000, nextCloseDay(far.day) - 5);
    expect(plan(near, 'covenantCure').advice.severity).toBe('urgent');
    const penalty = overLevered(500_000);
    penalty.debt.covenant.stage = 'penalty';
    expect(plan(penalty, 'covenantCure').advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.covenantCureUrgent });
  });

  it("falls back to the 'grow' figure when no repayment can be afforded, and never says borrow more", () => {
    const state = overLevered(1_000);
    const option = cureOptions(state)[0]!;
    expect(option.kind).toBe('grow');
    const p = plan(state, 'covenantCure');
    expect(p.commands).toEqual([]);
    expect(p.advice.why).toContain(formatMoney(option.amount));
    expect(p.advice.title).toBe(`Grow operating cash flow by ${formatMoney(option.amount)} a year`);
    expect(p.advice.why).not.toMatch(/\bdraw\b|take a .*loan/i);
  });

  it('warns when compliant but close to a limit (no command, no borrowing)', () => {
    // Underwriting cash flow is ARR x the minimum margin here; put leverage just inside the risk margin of the limit.
    const state = trading(10_000, 9_000, 500_000);
    const flow = covenantMetrics(state).underwritingCashFlow;
    state.debt.credit.balance = Math.round(flow * 5 * (1 - COVENANT_RISK_MARGIN / 2));
    const m = covenantMetrics(state);
    expect(m.compliant).toBe(true);
    const p = plan(state, 'covenantCure');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.covenantCureAtRisk });
    expect(p.advice.why).toContain(formatMultiple(m.leverage!));
    expect(p.advice.why).toContain('Hold off on new borrowing');
    expect(p.commands).toEqual([]);
  });

  it('does not fire on a healthy borrower (v3-town) or with no debt', () => {
    expect(planFor(fixture('v3-town'), 'covenantCure')).toBeNull();
    expect(planFor(trading(10_000, 9_000, 500_000), 'covenantCure')).toBeNull();
  });
});

describe('frozenSweep', () => {
  it('on the frozen hoarder (v3-grid): the countdown to the call and what lifts the freeze', () => {
    const state = fixture('v3-grid');
    const left = closesUntilAcceleration(state)!;
    const p = plan(state, 'frozenSweep');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.frozenSweep, action: { kind: 'openPanel', panel: 'bank' } });
    expect(p.advice.title).toBe(`Lift the freeze within ${left} closes`);
    expect(p.advice.why).toContain(`${left} more frozen closes`);
    expect(p.advice.why).toContain(`${COVENANT_CURE_CLOSES} compliant closes in a row`);
    expect(p.advice.why).toContain("today's figures still breach");
  });

  it("quotes the last close's sweep, and says when too few closes remain to cure it", () => {
    const state = fixture('v3-grid');
    state.finance.reports.at(-1)!.debt!.sweep = 4_321;
    expect(plan(state, 'frozenSweep').advice.why).toContain(`swept ${formatMoney(4_321)}`);
    state.debt.frozenCloses = FROZEN_ACCELERATION_CLOSES - 1;
    const late = plan(state, 'frozenSweep').advice;
    expect(late.why).toContain('only repaying everything stops it');
    expect(late.title).toBe(`Repay ${formatMoney(totalDebt(state))} before the bank calls the loans`);
  });

  it('does not fire unless frozen and not yet called', () => {
    const state = fixture('v3-grid');
    state.debt.acceleration = { day: state.day, closesLeft: 3 };
    expect(planFor(state, 'frozenSweep')).toBeNull();
    expect(planFor(fixture('v3-town'), 'frozenSweep')).toBeNull();
  });
});

describe('cashRunway', () => {
  /** Burning (revenue - costs) a month with `cash`: runway = floor(cash / burn). */
  const burning = (cash: number) => trading(30_000, 40_000, cash);

  it('is important at a few months of runway, with covenant-safe financing that adds two months', () => {
    const state = burning(35_000);
    const runway = runwayMonths(state)!;
    expect(runway).toBe(3);
    const p = plan(state, 'cashRunway');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.cashRunway, title: 'Extend your cash runway' });
    expect(p.advice.why).toContain(formatMoney(10_000));
    expect(p.advice.why).toContain(`${runway} months`);
    expect(p.advice.why).toContain('2 months');
    expect(p.commands.length).toBeGreaterThan(0);
    expectNoBackfire(state, p);
  });

  it('is urgent at two months or less with no safe financing, and when installs are paused', () => {
    const frozen = burning(15_000);
    frozen.debt.covenant.stage = 'frozen';
    const p = plan(frozen, 'cashRunway');
    expect(p.advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.cashRunwayUrgent });
    expect(p.advice.why).toContain('No covenant-safe borrowing covers it');
    expect(p.commands).toEqual([]);
    // With safe financing the same runway is important, not urgent.
    expect(plan(burning(15_000), 'cashRunway').advice.severity).toBe('important');

    const paused = trading(30_000, 20_000, 300);
    paused.sales.installsPaused = true;
    const q = plan(paused, 'cashRunway');
    expect(q.advice).toMatchObject({ severity: 'urgent', title: 'Raise cash to restart installs' });
    expect(q.advice.why).toContain(formatMoney(300));
    expectNoBackfire(paused, q);
  });

  it("takes a storm month's repairs at their yearly average, not as a lasting burn", () => {
    // Earning $10,000 a month; one storm month's repairs would read as a burn of $20,000 a month.
    const stormy = trading(30_000, 20_000, 30_000);
    const last = stormy.finance.reports.at(-1)!;
    last.totals.repair = -30_000;
    last.net -= 30_000;
    expect(monthlyBurn(stormy)).toBe(0);
    expect(runwayMonths(stormy)).toBeNull();
    expect(planFor(stormy, 'cashRunway')).toBeNull();
    // Storm months every month of the window are a real burn.
    const battered = trading(30_000, 20_000, 30_000);
    for (const r of battered.finance.reports) {
      r.totals.repair = -60_000;
      r.net -= 60_000;
    }
    const burn = -(10_000 + Math.round((-60_000 * battered.finance.reports.length) / REPAIR_TRAILING_MONTHS));
    expect(burn).toBeGreaterThan(0);
    expect(monthlyBurn(battered)).toBe(burn);
    expect(runwayMonths(battered)).toBe(Math.floor(30_000 / burn));
  });

  it('suggests no borrowing once covenantCure has said not to borrow', () => {
    // Burning with a few months of runway, and leverage inside the risk margin of the limit.
    const state = burning(35_000);
    const flow = covenantMetrics(state).underwritingCashFlow;
    state.debt.credit.balance = Math.round(flow * COVENANT_MAX_LEVERAGE * (1 - COVENANT_RISK_MARGIN / 2));
    expect(covenantMetrics(state).compliant).toBe(true);
    // On its own the runway rule would borrow (covenant-safe) ...
    expect(plan(state, 'cashRunway').commands.length).toBeGreaterThan(0);
    // ... but next to the covenant warning it says not to.
    const plans = advicePlans(state);
    expect(plans.find((p) => p.advice.id === 'covenantCure')!.advice.why).toContain('Hold off on new borrowing');
    const runway = plans.find((p) => p.advice.id === 'cashRunway')!;
    expect(runway.commands).toEqual([]);
    expect(runway.advice.why).toContain("don't borrow");
    expect(plans.every((p) => !p.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan'))).toBe(true);
    expectTogetherSafe(state, plans);
  });

  it('does not fire with a long runway or when not burning', () => {
    expect(planFor(burning(60_000), 'cashRunway')).toBeNull();
    expect(planFor(trading(30_000, 20_000, 5_000), 'cashRunway')).toBeNull();
  });
});

describe('addSplitter', () => {
  it('picks the full cabinet with the most customers waiting, quoting the splitter', () => {
    const state = makeTestState(makeGridCity({ cols: 3, rows: 2 }));
    // A cabinet with nothing to serve (no cable at its corner) gets the lower id ...
    const idle = state.nextId++;
    state.network.cabinets.push({ id: idle, node: state.city.nodes.length - 1, splitters: 1, stage: 'live', stageDaysLeft: 0, cost: 0, orderedDay: 0, liveDay: 0 });
    const busy = addLivePlant(state, { splitters: 4, segments: state.city.segments.filter((s) => s.a !== state.city.nodes.length - 1 && s.b !== state.city.nodes.length - 1).map((s) => s.id) })!;
    runDays(state, 31);
    state.sales.fullCabinets = [idle, busy];
    const p = plan(state, 'addSplitter');
    // ... but the busy one has demand waiting.
    expect(p.advice.action).toEqual({ kind: 'focusCabinet', cabinet: busy });
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.addSplitterFull, actionLabel: 'Show me' });
    const place = cornerName(state.city, state.network.cabinets.find((c) => c.id === busy)!.node);
    expect(p.advice.title).toBe(`Add a splitter at ${place}`);
    expect(p.advice.why).toContain(formatMoney(SPLITTER_COST));
    expect(p.advice.why).toContain(`${SPLIT_RATIO} ports`);
    expect(p.advice.why).toMatch(/about \d+ customers? waiting/);
    expect(p.commands).toEqual([{ type: 'addSplitter', cabinet: busy }]);
    expectNoBackfire(state, p);
  });

  it('flags a nearly full cabinet with demand waiting', () => {
    const state = centerGame(1);
    const cabinet = state.network.cabinets[0]!;
    cabinet.splitters = 1;
    // Hand over ports: 90% of one splitter's, on the first parcels.
    const take = Math.ceil(0.9 * SPLIT_RATIO);
    state.sales.accounts = state.city.parcels.slice(0, take).map((parcel) => ({
      parcel: parcel.id,
      cabinet: cabinet.id,
      tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 },
      since: 0,
      locks: [],
    }));
    state.sales.fullCabinets = [];
    const p = plan(state, 'addSplitter');
    expect(p.advice).toMatchObject({ priority: ADVICE_PRIORITY.addSplitterNearlyFull, action: { kind: 'focusCabinet', cabinet: cabinet.id } });
    expect(p.advice.why).toContain(`${take} of its ${SPLIT_RATIO} ports in use`);
  });

  it('suggests covenant-safe financing when cash is thin, and waits when nothing safe pays for it', () => {
    const thin = trading(20_000, 10_000, SPLITTER_COST);
    addLivePlant(thin, { splitters: 1 });
    thin.sales.fullCabinets = [thin.network.cabinets[0]!.id];
    const p = plan(thin, 'addSplitter');
    expect(p.advice.priority).toBe(ADVICE_PRIORITY.addSplitterFinanced);
    expect(p.commands.map((c) => c.type)).toEqual(['drawCredit', 'addSplitter']);
    expectNoBackfire(thin, p);

    const broke = trading(0, 10_000, SPLITTER_COST);
    addLivePlant(broke, { splitters: 1 });
    broke.sales.fullCabinets = [broke.network.cabinets[0]!.id];
    const q = plan(broke, 'addSplitter');
    expect(q.advice).toMatchObject({ priority: ADVICE_PRIORITY.addSplitterShort });
    expect(q.advice.title).toMatch(/^Add a splitter at .* when cash allows$/);
    expect(q.commands).toEqual([]);
  });

  it('does not fire without a free slot or a free PON port (that is addOltCard), or with no cabinet in need', () => {
    const state = litGame(31);
    const cabinet = state.network.cabinets[0]!;
    expect(planFor(state, 'addSplitter')).toBeNull();
    state.sales.fullCabinets = [cabinet.id];
    cabinet.splitters = MAX_SPLITTERS_PER_CABINET;
    expect(planFor(state, 'addSplitter')).toBeNull();
    cabinet.splitters = 4;
    state.network.olt.ponPorts = ponPortsUsed(state);
    expect(planFor(state, 'addSplitter')).toBeNull();
    expect(plan(state, 'addOltCard').advice.priority).toBe(ADVICE_PRIORITY.addOltCardNeeded);
  });
});

describe('addOltCard', () => {
  it('is important when a cabinet needs a port and none is free, quoting the card', () => {
    const state = litGame(31);
    const cabinet = state.network.cabinets[0]!;
    state.sales.fullCabinets = [cabinet.id];
    state.network.olt.ponPorts = ponPortsUsed(state);
    const p = plan(state, 'addOltCard');
    expect(p.advice).toMatchObject({ severity: 'important', action: { kind: 'openPanel', panel: 'olt' }, actionLabel: 'Open OLT', title: 'Add an OLT line card' });
    expect(p.advice.why).toContain(cornerName(state.city, cabinet.node));
    expect(p.advice.why).toContain(formatMoney(OLT_CARD_COST));
    expect(p.advice.why).toContain(`${OLT_PORTS_PER_CARD} more`);
    expect(p.commands).toEqual([{ type: 'addOltCard' }]);
    expectNoBackfire(state, p);
  });

  it('is a tip when the ports are nearly all used, and quiet below that or with the chassis full', () => {
    const state = litGame(31);
    const used = ponPortsUsed(state);
    state.network.olt.ponPorts = used;
    expect(plan(state, 'addOltCard').advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.addOltCardNearlyFull });
    state.network.olt.ponPorts = Math.ceil(used / 0.8);
    expect(planFor(state, 'addOltCard')).toBeNull();
    state.network.olt.ponPorts = used;
    state.network.olt.cards = OLT_MAX_CARDS;
    expect(planFor(state, 'addOltCard')).toBeNull();
  });
});

describe('outages', () => {
  /** Put an outage on `span` (days left, repair cost), as weather.stepWeather would. */
  function breakSpan(state: GameState, span: CableSpan, daysLeft: number, repairCost: number): void {
    span.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft, repairCost };
    state.network.version++;
  }

  /** Subscribed units on parcels served by `segment`. */
  function unitsOn(state: GameState, segment: number): number {
    let units = 0;
    for (const a of state.sales.accounts) {
      if (state.city.parcels[a.parcel]!.segment === segment) units += a.tierUnits.fiber500 + a.tierUnits.fiber1g + a.tierUnits.fiber2g;
    }
    return units;
  }

  it('names the street cutting off the most subscribers, the days left, the repair and the churn risk', () => {
    const state = litGame(150);
    const bySubs = [...state.network.spans].sort((a, b) => unitsOn(state, b.segment) - unitsOn(state, a.segment));
    const worst = bySubs[0]!;
    const other = bySubs.find((s) => unitsOn(state, s.segment) > 0 && unitsOn(state, s.segment) < unitsOn(state, worst.segment)) ?? bySubs[1]!;
    breakSpan(state, worst, 4, 2_345);
    breakSpan(state, other, 6, 1_111);
    const units = outageImpact(state, worst.id).subscribers;
    expect(units).toBeGreaterThan(0);
    const p = plan(state, 'outages');
    const street = state.city.segments[worst.segment]!.name;
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.outages, title: `Service is out on ${street}` });
    expect(p.advice.action).toEqual({ kind: 'focusSegment', segment: worst.segment });
    expect(p.advice.why).toContain(`${units} subscriber`);
    expect(p.advice.why).toContain('4 days');
    expect(p.advice.why).toContain(formatMoney(2_345));
    expect(p.advice.why).toContain(pct(outageChurnProbability(4)));
    expect(p.commands).toEqual([]);
  });

  it('does not fire with no outage, or when the outage cuts nobody off', () => {
    const state = litGame(150);
    expect(planFor(state, 'outages')).toBeNull();
    breakSpan(state, state.network.spans[0]!, 3, 999);
    expect(planFor(state, 'outages')).not.toBeNull();
    // Nobody left on the streets it cuts off.
    const cut = getService(state).interruptedSegments;
    expect(cut.size).toBeGreaterThan(0);
    state.sales.accounts = state.sales.accounts.filter((a) => !cut.has(state.city.parcels[a.parcel]!.segment));
    expect(planFor(state, 'outages')).toBeNull();
  });
});

describe('stormUnderground', () => {
  /** litGame with aerial plant, and `hits` storms that damaged the span on the busiest street. */
  function stormy(hits: number, days = 150): { state: GameState; span: CableSpan } {
    const state = litGame(days);
    for (const span of state.network.spans) span.method = 'aerial';
    state.network.version++;
    const subs = (seg: number) => state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === seg).length;
    const span = [...state.network.spans].sort((a, b) => subs(b.segment) - subs(a.segment))[0]!;
    for (let i = 0; i < hits; i++) {
      state.weather.storms.push({ id: i + 1, day: state.day - 30 * (hits - i), x: 0, y: 0, radius: 10, severity: 2, spans: [span.id], repairCost: 1 });
    }
    state.weather.nextStormId = hits + 1;
    return { state, span };
  }

  it('suggests rebuilding a storm-prone aerial span underground, with the quote against the repairs', () => {
    const { state, span } = stormy(2);
    const quote = quoteConvert(state, span.id);
    expect(quote.ok).toBe(true);
    const p = plan(state, 'stormUnderground');
    const street = state.city.segments[span.segment]!.name;
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.stormUnderground, title: `Rebuild ${street} underground` });
    expect(p.advice.action).toEqual({ kind: 'focusSegment', segment: span.segment });
    expect(p.advice.why).toContain('2 times');
    expect(p.advice.why).toContain(formatMoney(2 * repairCost(state.city.segments[span.segment]!, 'aerial')));
    expect(p.advice.why).toContain(formatMoney(quote.cost));
    expect(p.advice.why).toContain(formatMoney(quote.repairsAvoidedPerYear));
    const saved = quote.repairsAvoidedPerYear + 12 * quote.poleRentSaved;
    expect(saved * CONVERT_PAYBACK_YEARS).toBeGreaterThanOrEqual(quote.cost);
    expect(p.advice.why).toContain(`${Math.ceil(quote.cost / saved)} year`);
    expect(p.commands).toEqual([{ type: 'convertSpan', span: span.id }]);
    expectNoBackfire(state, p);
  });

  it('does not suggest a rebuild that would not pay for itself (on a generated town)', () => {
    const state = fixture('v3-town');
    const aerial = state.network.spans.filter((s) => s.method === 'aerial' && s.stage === 'live');
    state.weather.storms = [1, 2].map((id) => ({ id, day: state.day - 40 * id, x: 0, y: 0, radius: 9, severity: 2, spans: aerial.map((s) => s.id), repairCost: 1 }));
    state.weather.nextStormId = 3;
    state.finance.cash += 200_000;
    const p = plan(state, 'stormUnderground');
    const segment = (p.advice.action as { segment: number }).segment;
    const span = state.network.spans.find((s) => s.segment === segment)!;
    const quote = quoteConvert(state, span.id);
    expect((quote.repairsAvoidedPerYear + 12 * quote.poleRentSaved) * CONVERT_PAYBACK_YEARS).toBeLessThan(quote.cost);
    expect(p.advice.title).toBe(`Build underground around ${state.city.segments[segment]!.name}`);
    expect(p.advice.why).toContain(formatMoney(quote.cost));
    expect(p.advice.why).toContain('underground instead');
    expect(p.commands).toEqual([]);
  });

  it('falls back to building underground when cash does not cover the rebuild', () => {
    const { state, span } = stormy(2);
    state.finance.cash = 100;
    const p = plan(state, 'stormUnderground');
    expect(p.advice.title).toBe(`Build underground around ${state.city.segments[span.segment]!.name}`);
    expect(p.commands).toEqual([]);
  });

  it('does not fire for one storm, old storms, underground plant or a span feeding nobody', () => {
    expect(planFor(stormy(1).state, 'stormUnderground')).toBeNull();
    const old = stormy(2);
    old.state.day += STORM_LOG_DAYS + 61;
    expect(planFor(old.state, 'stormUnderground')).toBeNull();
    const buried = stormy(2);
    buried.span.method = 'underground';
    expect(planFor(buried.state, 'stormUnderground')).toBeNull();
    const nobody = stormy(2);
    nobody.state.sales.accounts = [];
    expect(planFor(nobody.state, 'stormUnderground')).toBeNull();
  });
});

describe('incumbentPromo', () => {
  function promoted(): GameState {
    const state = litGame(150);
    const cabinet = state.network.cabinets[0]!;
    const endDay = closeDayAfter(state.day, 3);
    state.sales.incumbentPromos = [{ cabinet: cabinet.id, startDay: state.day - 1, endDay, price: incumbentPromoPrice(), quietUntil: closeDayAfter(endDay, 6) }];
    return state;
  }

  it('compares the target take rate there with elsewhere, and suggests a promo or marketing, not a price cut', () => {
    const state = promoted();
    const cabinet = state.network.cabinets[0]!;
    const p = plan(state, 'incumbentPromo');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.incumbentPromo, action: { kind: 'openPanel', panel: 'pricing' }, actionLabel: 'Open Pricing' });
    expect(p.advice.title).toContain(cornerName(state.city, cabinet.node));
    // Every lot here is a home: the weighted target is the home target.
    expect(p.advice.why).toContain(`${pct(stateTakeRate(state, 'home', cabinet.id))} instead of ${pct(stateTakeRate(state, 'home'))}`);
    expect(p.advice.why).toContain(formatMoney(incumbentPromoPrice()));
    expect(p.advice.why).toContain(formatMoney(INCUMBENT_PRICE));
    expect(p.advice.why).toContain('3 months');
    expect(p.advice.why).toContain('intro promo');
    expect(p.advice.why).toContain('rather than a permanent price cut');
  });

  it('does not fire before the promo starts, after it ends, or where you have no subscribers', () => {
    const state = promoted();
    state.sales.incumbentPromos[0]!.startDay = state.day + 1;
    expect(planFor(state, 'incumbentPromo')).toBeNull();
    const ended = promoted();
    ended.sales.incumbentPromos[0]!.endDay = ended.day;
    expect(planFor(ended, 'incumbentPromo')).toBeNull();
    const empty = promoted();
    empty.sales.accounts = [];
    expect(planFor(empty, 'incumbentPromo')).toBeNull();
  });
});

describe('takeRate', () => {
  /** Days for the first lit areas to count as mature, plus a little. */
  const MATURE = Math.ceil((TAKE_RATE_MATURE_MONTHS * DAYS_PER_YEAR) / 12) + 20;

  it('fires when mature areas lag their target on thin marketing, saying what more marketing does', () => {
    const state = centerGame(MATURE, 0);
    const passings = getService(state).passings;
    expect(passings).toBeGreaterThanOrEqual(50);
    const target = stateTakeRate(state, 'home');
    const subs = state.sales.accounts.length;
    expect(subs / passings).toBeLessThan(TAKE_RATE_LAG_SHARE * target);
    const p = plan(state, 'takeRate');
    const suggested = Math.ceil((MARKETING_PER_PASSING_GOOD * passings) / 100) * 100;
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.takeRate, action: { kind: 'openPanel', panel: 'pricing' } });
    expect(p.advice.title).toBe(`Raise marketing to ${formatMoney(suggested)} a month`);
    expect(p.advice.why).toContain(`${pct(subs / passings)} against a ${pct(target)} target`);
    expect(p.advice.why).toContain(formatMultiple(1 + marketingBoost(suggested, passings)));
  });

  it('does not fire with enough marketing, or before areas have been lit long enough', () => {
    const marketed = centerGame(MATURE, 0);
    applyCommand(marketed, { type: 'setMarketing', perMonth: MARKETING_PER_PASSING_GOOD * getService(marketed).passings });
    expect(planFor(marketed, 'takeRate')).toBeNull();
    // Still ramping: lit for less than TAKE_RATE_MATURE_MONTHS (6 months is well short of it).
    expect(TAKE_RATE_MATURE_MONTHS).toBeGreaterThan(6);
    expect(planFor(centerGame(MATURE - 60, 0), 'takeRate')).toBeNull();
    expect(planFor(centerGame(200, 0), 'takeRate')).toBeNull();
  });

  it('does not fire when more marketing would barely speed signups up', () => {
    // A town big enough that the suggestion (rounded up to $100) is close to the good level.
    const state = makeTestState(makeGridCity({ cols: 4, rows: 2, coAt: [2, 1], parcelKinds: (p) => (p.id % 4 === 0 ? { kind: 'mdu', units: 20 } : undefined) }));
    addLivePlant(state, { splitters: MAX_SPLITTERS_PER_CABINET });
    applyCommand(state, { type: 'setMarketing', perMonth: 0 });
    runDays(state, MATURE);
    expect(planFor(state, 'takeRate')).not.toBeNull();
    const passings = getService(state).passings;
    const suggested = Math.ceil((MARKETING_PER_PASSING_GOOD * passings) / 100) * 100;
    // Just under the good level: raising it to the suggestion is less than TAKE_RATE_MIN_PACE faster.
    const near = Math.floor(MARKETING_PER_PASSING_GOOD * passings) - 1;
    expect((1 + marketingBoost(suggested, passings)) / (1 + marketingBoost(near, passings))).toBeLessThan(TAKE_RATE_MIN_PACE);
    applyCommand(state, { type: 'setMarketing', perMonth: near });
    expect(planFor(state, 'takeRate')).toBeNull();
  });
});

describe('pricing', () => {
  function priced(id: TierId, factor: number): GameState {
    const state = litGame(150);
    const tiers = state.sales.pricing.tiers.map((t) => ({ id: t.id, price: t.id === id ? Math.round(t.price * factor) : t.price, offered: t.offered }));
    expect(applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: state.sales.pricing.smbMultiplier })).toMatchObject({ ok: true });
    return state;
  }

  it('above the market: more churn, said in figures', () => {
    const state = priced('fiber1g', 1.3);
    const tier = state.sales.pricing.tiers.find((t) => t.id === 'fiber1g')!;
    const ref = TIER_DEFAULTS.find((t) => t.id === 'fiber1g')!.price;
    const p = plan(state, 'pricing');
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.pricing, title: `Bring ${tier.name} closer to ${formatMoney(ref)}` });
    expect(p.advice.action).toEqual({ kind: 'openPanel', panel: 'pricing' });
    expect(p.advice.why).toContain(`${pct1(churnProbability(tier))} a month instead of ${pct1(churnProbability({ ...tier, price: ref }))}`);
    expect(p.advice.why).toContain(pct((tier.price - ref) / ref));
  });

  it('below the market: revenue left on the table', () => {
    const state = priced('fiber500', 0.7);
    const tier = state.sales.pricing.tiers.find((t) => t.id === 'fiber500')!;
    const ref = TIER_DEFAULTS.find((t) => t.id === 'fiber500')!.price;
    const units = unitsByTier(state).fiber500;
    expect(units).toBeGreaterThan(0);
    const p = plan(state, 'pricing');
    expect(p.advice.why).toContain(`${formatMoney(units * (ref - tier.price))} a month left on the table`);
  });

  it('does not fire within the band, or for a tier not offered', () => {
    expect(planFor(priced('fiber1g', 1.1), 'pricing')).toBeNull();
    const state = litGame(60);
    const tiers = state.sales.pricing.tiers.map((t) => ({ id: t.id, price: t.id === 'fiber2g' ? t.price * 2 : t.price, offered: t.id !== 'fiber2g' }));
    applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: state.sales.pricing.smbMultiplier });
    expect(planFor(state, 'pricing')).toBeNull();
  });
});

describe('redCpp', () => {
  function costly(multiple: number): GameState {
    const state = litGame(60);
    state.finance.capex.osp = Math.round(getService(state).passings * CPP_TARGET * multiple);
    return state;
  }

  it('names the CPP spread a red build adds, as a tip with no debt and important with debt', () => {
    const state = costly(CPP_AMBER_MULTIPLIER + 0.5);
    const cpp = state.finance.capex.osp / getService(state).passings;
    const p = plan(state, 'redCpp');
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.redCpp, action: { kind: 'openPanel', panel: 'bank' } });
    expect(p.advice.why).toContain(formatMoney(cpp));
    expect(p.advice.why).toContain(formatRateBps(CPP_SPREAD_BPS.red));
    expect(p.advice.why).toContain(formatRateBps(CPP_SPREAD_BPS.amber));
    state.debt.credit.balance = 50_000;
    const q = plan(state, 'redCpp');
    expect(q.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.redCppWithDebt });
    expect(q.advice.why).toContain(formatMoney((50_000 * CPP_SPREAD_BPS.red) / 10_000));
  });

  it('covers amber, and is quiet when green', () => {
    expect(plan(costly(1.2), 'redCpp').advice.why).toContain(formatRateBps(CPP_SPREAD_BPS.amber));
    expect(planFor(costly(0.5), 'redCpp')).toBeNull();
  });
});

describe('expand', () => {
  /** A wide grid with a little plant by the CO: room to grow. */
  function growing(): GameState {
    const state = makeTestState(makeGridCity({ cols: 8, rows: 4 }));
    addLivePlant(state, { segments: [0, 1, 8, 9], splitters: 2 });
    runDays(state, 31);
    return state;
  }

  it('points at the best green corner near the plant, funded from cash above the reserve', () => {
    const state = growing();
    const candidates = expandCandidates(state);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(EXPAND_CANDIDATES_MAX);
    const p = plan(state, 'expand');
    expect(p.advice.action.kind).toBe('focusNode');
    const node = (p.advice.action as { node: number }).node;
    expect(candidates).toContain(node);
    const preview = coveragePreview(state, node);
    expect(preview.projectedCppBand).toBe('green');
    const newly = preview.passingsNow - preview.passingsServedElsewhere;
    for (const other of candidates) {
      const q = coveragePreview(state, other);
      if (q.projectedCppBand === 'green') expect(q.passingsNow - q.passingsServedElsewhere).toBeLessThanOrEqual(newly);
    }
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.expandCash, title: `Build a cabinet at ${cornerName(state.city, node)}` });
    expect(p.advice.why).toContain(`${newly} passings`);
    expect(p.advice.why).toContain(formatMoney(preview.projectedCpp!));
    expect(p.advice.why).toContain(formatMoney(preview.cabinetCost + preview.buildOutCost));
    expect(p.commands).toEqual([{ type: 'placeCabinet', node }]);
    expect(p.extraSpend).toBe(preview.buildOutCost);
    // Never more than the funds above the reserve.
    expect(state.finance.cash - preview.cabinetCost - preview.buildOutCost).toBeGreaterThanOrEqual(p.keep);
    expectNoBackfire(state, p);
  });

  it('borrows the rest with a covenant-safe term loan when cash above the reserve falls short', () => {
    const state = growing();
    const first = plan(state, 'expand');
    const node = (first.advice.action as { node: number }).node;
    const preview = coveragePreview(state, node);
    // Revenue history to lend against, and cash just above the reserve.
    const history = makeTradingState(60_000, 20_000);
    state.finance.reports = history.finance.reports;
    state.finance.cash = first.keep + Math.round((preview.cabinetCost + preview.buildOutCost) / 2);
    const p = plan(state, 'expand');
    expect(p.advice.priority).toBe(ADVICE_PRIORITY.expandLoan);
    const loan = p.commands.find((c) => c.type === 'takeTermLoan') as { amount: number; termYears: 5 | 7 } | undefined;
    expect(loan).toBeDefined();
    expect(loan!.amount).toBeGreaterThanOrEqual(TERM_LOAN_MIN);
    expect(loan!.amount).toBeLessThanOrEqual(maxSafeTermLoan(state, loan!.termYears));
    expect(quoteTermLoan(state, loan!.amount, loan!.termYears).after.compliant).toBe(true);
    expect(p.advice.why).toContain(`${formatMoney(loan!.amount)} ${loan!.termYears}-year term loan`);
    expectNoBackfire(state, p);
  });

  it('does not fire when not compliant, with installs paused, below the reserve or with no PON port', () => {
    const warned = growing();
    warned.debt.covenant.stage = 'warning';
    expect(planFor(warned, 'expand')).toBeNull();
    const paused = growing();
    paused.sales.installsPaused = true;
    expect(planFor(paused, 'expand')).toBeNull();
    const poor = growing();
    poor.finance.cash = 1_000;
    expect(planFor(poor, 'expand')).toBeNull();
    const full = growing();
    full.network.olt.ponPorts = ponPortsUsed(full) + CABINET_START_SPLITTERS - 1;
    expect(planFor(full, 'expand')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Never backfires, on realistic states
// ---------------------------------------------------------------------------

describe('never backfires', () => {
  it('on the frozen v3 fixtures and variations of the healthy borrower', () => {
    const grid = fixture('v3-grid');
    expect(expectAllSafe(grid)).toEqual(expect.arrayContaining(['covenantCure', 'frozenSweep']));
    expectAllSafe(fixture('v3-town'));

    // The healthy borrower short of its next payment, over-borrowed, with thin marketing, a storm-prone street and an outage.
    const short = fixture('v3-town');
    short.finance.cash += estimateNextDebtService(short) - estimateCashAtClose(short) - 1;
    expect(expectAllSafe(short)).toContain('paymentShort');

    const levered = fixture('v3-town');
    levered.debt.credit.balance += 300_000;
    expect(expectAllSafe(levered)).toContain('covenantCure');

    const quiet = fixture('v3-town');
    applyCommand(quiet, { type: 'setMarketing', perMonth: 0 });
    expectAllSafe(quiet);

    const stormy = fixture('v3-town');
    const aerial = stormy.network.spans.filter((s) => s.method === 'aerial' && s.stage === 'live');
    stormy.weather.storms = [1, 2].map((id) => ({ id, day: stormy.day - 40 * id, x: 0, y: 0, radius: 9, severity: 2, spans: aerial.map((s) => s.id), repairCost: 1 }));
    stormy.weather.nextStormId = 3;
    stormy.finance.cash += 200_000;
    expectAllSafe(stormy);

    const out = fixture('v3-town');
    for (const span of out.network.spans.slice(0, 5)) span.outage = { cause: 'storm', storm: null, startDay: out.day, daysLeft: 3, repairCost: 2_000 };
    out.network.version++;
    expectAllSafe(out);

    const rich = fixture('v3-town');
    rich.finance.cash += 500_000;
    expectAllSafe(rich);
  });
});

describe('suggestions shown together', () => {
  /** A full cabinet and a storm-prone aerial street feeding subscribers, on cash that covers the rebuild alone but not with the splitter. */
  function tight(): { state: GameState; span: CableSpan } {
    const state = litGame(150);
    for (const span of state.network.spans) span.method = 'aerial';
    state.network.version++;
    const subs = (seg: number) => state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === seg).length;
    const span = [...state.network.spans].sort((a, b) => subs(b.segment) - subs(a.segment))[0]!;
    state.weather.storms = [1, 2].map((id) => ({ id, day: state.day - 30 * (3 - id), x: 0, y: 0, radius: 10, severity: 2, spans: [span.id], repairCost: 1 }));
    state.weather.nextStormId = 3;
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    const cost = quoteConvert(state, span.id).cost;
    state.finance.cash = 0;
    state.finance.cash = fundingHint(state, 0).cushion + cost + Math.floor(SPLITTER_COST / 2);
    return { state, span };
  }

  it('count what earlier suggestions spend: a purchase cash covers alone is not suggested on top of another', () => {
    const { state, span } = tight();
    // Alone, each is affordable.
    expect(plan(state, 'stormUnderground').commands).toEqual([{ type: 'convertSpan', span: span.id }]);
    expect(plan(state, 'addSplitter').commands).toEqual([{ type: 'addSplitter', cabinet: state.network.cabinets[0]!.id }]);
    // Together, the splitter (earlier in rule order) claims its cost, so the rebuild waits.
    const plans = advicePlans(state);
    expect(plans.find((p) => p.advice.id === 'addSplitter')!.commands).toHaveLength(1);
    const storm = plans.find((p) => p.advice.id === 'stormUnderground')!;
    expect(storm.commands).toEqual([]);
    expect(storm.advice.title).toMatch(/^Build underground around /);
    expectTogetherSafe(state, plans);
  });

  it('never suggest borrowing twice: a later purchase waits once an earlier suggestion borrows', () => {
    // Short of the next payment (a draw), with a full cabinet that cash cannot pay for.
    const state = withLoan(trading(20_000, 10_000, 0), 60_000);
    addLivePlant(state, { splitters: 1 });
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    state.finance.cash = estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1;
    expect(plan(state, 'addSplitter').commands.map((c) => c.type)).toEqual(['drawCredit', 'addSplitter']);
    const plans = advicePlans(state);
    expect(plans.find((p) => p.advice.id === 'paymentShort')!.commands.map((c) => c.type)).toEqual(['drawCredit']);
    const splitter = plans.find((p) => p.advice.id === 'addSplitter')!;
    expect(splitter.commands).toEqual([]);
    expect(splitter.advice.title).toMatch(/when cash allows$/);
    expectTogetherSafe(state, plans);
  });
});

// ---------------------------------------------------------------------------
// Determinism and cost
// ---------------------------------------------------------------------------

describe('determinism and cost', () => {
  it('is deterministic, the same on a copy, and never writes the state', () => {
    for (const state of [fixture('v3-grid'), fixture('v3-town'), litGame(150)]) {
      const before = hashState(state);
      const a = advicePlans(state);
      expect(advicePlans(state)).toEqual(a);
      expect(advicePlans(clone(state))).toEqual(a);
      expect(hashState(state)).toBe(before);
    }
  });

  it('advises on a generated town well inside the time budget', () => {
    const json = serialize(fixture('v3-town'));
    // Some outages and a promo, so the heavier rules run too.
    const busy = deserialize(json);
    for (const span of busy.network.spans.slice(0, 8)) span.outage = { cause: 'storm', storm: null, startDay: busy.day, daysLeft: 3, repairCost: 2_000 };
    busy.network.version++;
    busy.finance.cash += 500_000;
    const busyJson = serialize(busy);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      for (const text of [json, busyJson]) {
        const state = deserialize(text);
        const t = performance.now();
        advise(state);
        times.push(performance.now() - t);
      }
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------

describe('buildBriefing', () => {
  it('is null before the first close', () => {
    expect(buildBriefing(makeTestState())).toBeNull();
  });

  it('describes the month that just closed: headline, changes, notices, breakdown and the forward look', () => {
    const state = litGame(31 + 28);
    const b = buildBriefing(state)!;
    const report = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    expect(b.report).toBe(report);
    expect(b.previous).toBe(previous);
    expect(b.span).toBe(1);
    expect(b.label).toBe('Feb 2027');
    expect(b.headline).toMatchObject({ net: report.net, cash: report.cashEnd, passings: report.passings, cppTarget: CPP_TARGET, stage: 'compliant' });
    const net = b.changes.find((c) => c.key === 'net')!;
    expect(net).toMatchObject({ now: report.net, before: previous.net, delta: report.net - previous.net, upIsGood: true });
    expect(b.changes.find((c) => c.key === 'subscribers')?.now).toBe(report.stats?.subscribers);
    // The breakdown is the month's totals, revenue first.
    expect(b.breakdown.map((x) => x.category)[0]).toBe('revenue');
    expect(b.breakdown.reduce((sum, x) => sum + x.amount, 0)).toBe(report.net);
    // The month's notices: after February's predecessor's cursor, up to its own.
    for (const n of b.notices) {
      expect(n.id).toBeGreaterThan(previous.ops!.lastNoticeId);
      expect(n.id).toBeLessThanOrEqual(report.ops!.lastNoticeId);
    }
    expect(b.forward.nextCloseDay).toBe(state.day + 31);
    expect(b.forward.closesUntilCalled).toBeNull();
    expect(b.advice).toEqual(advise(state));
  });

  it('covers a quarter: flows summed over three months against the three before', () => {
    const state = litGame(181);
    applyCommand(state, { type: 'setMarketing', perMonth: 2_000 });
    const b = buildBriefing(state, 3)!;
    const reports = state.finance.reports;
    expect(b.span).toBe(3);
    expect(b.label).toBe('Apr-Jun 2027');
    const sum = (rs: typeof reports) => rs.reduce((t, r) => t + r.net, 0);
    expect(b.headline.net).toBe(sum(reports.slice(-3)));
    expect(b.changes.find((c) => c.key === 'net')?.before).toBe(sum(reports.slice(-6, -3)));
    expect(b.previous).toBe(reports.at(-4));
    const revenue = b.breakdown.find((x) => x.category === 'revenue')!.amount;
    expect(revenue).toBe(reports.slice(-3).reduce((t, r) => t + (r.totals.revenue ?? 0), 0));
    // A quarter asked for with fewer months closed covers what there is.
    expect(buildBriefing(litGame(31 + 28), 3)!.span).toBe(2);
  });

  it('takes the notices of reports without a cursor (older saves) by close day', () => {
    const state = litGame(31 + 28 + 31);
    for (const report of state.finance.reports) delete report.ops;
    const report = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    const b = buildBriefing(state)!;
    const expected = state.notices.filter((n) => n.day > closeDayOf(previous) && n.day <= closeDayOf(report));
    expect(b.notices).toEqual(expected);
    // The migrated v3 fixtures have no cursors at all: they still brief.
    const grid = buildBriefing(fixture('v3-grid'))!;
    const last = fixture('v3-grid').finance.reports.at(-1)!;
    for (const n of grid.notices) expect(n.day).toBeLessThanOrEqual(closeDayOf(last));
  });

  it('needs attention for urgent advice or an attention notice in the period, and not otherwise', () => {
    // The frozen hoarder: urgent cure advice.
    const grid = buildBriefing(fixture('v3-grid'))!;
    expect(grid.advice.some((a) => a.severity === 'urgent')).toBe(true);
    expect(grid.needsAttention).toBe(true);

    const state = litGame(31 + 28);
    const quiet = buildBriefing(state)!;
    const attention = quiet.notices.some((n) => noticeNeedsAttention(state, n)) || quiet.advice.some((a) => a.severity === 'urgent');
    expect(quiet.needsAttention).toBe(attention);

    // Strip the period of attention notices, then add one.
    const report = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    state.notices = state.notices.filter((n) => !ATTENTION_NOTICE_KINDS.has(n.kind));
    expect(buildBriefing(state)!.needsAttention).toBe(false);
    const id = previous.ops!.lastNoticeId + 1;
    report.ops!.lastNoticeId = Math.max(report.ops!.lastNoticeId, id);
    const notice: Notice = { id, day: state.day, kind: 'insolvencyWarning', message: 'x', cabinet: null, milestone: null };
    state.notices = [...state.notices.filter((n) => n.id !== notice.id), notice].sort((a, b) => a.id - b.id);
    expect(buildBriefing(state)!.needsAttention).toBe(true);
  });

  it('counts a storm in the period as needing attention only while plant is still out', () => {
    const state = litGame(31 + 28);
    const report = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    state.notices = state.notices.filter((n) => !ATTENTION_NOTICE_KINDS.has(n.kind));
    const id = previous.ops!.lastNoticeId + 1;
    report.ops!.lastNoticeId = Math.max(report.ops!.lastNoticeId, id);
    const storm: Notice = { id, day: state.day - 3, kind: 'storm', message: 'A storm hit', cabinet: null, milestone: null };
    state.notices = [...state.notices.filter((n) => n.id !== id), storm].sort((a, b) => a.id - b.id);
    const urgent = buildBriefing(state)!.advice.some((a) => a.severity === 'urgent');
    expect(urgent).toBe(false);
    // Repaired before the close: news, not attention.
    expect(state.network.spans.every((s) => s.outage === null)).toBe(true);
    expect(noticeNeedsAttention(state, storm)).toBe(false);
    expect(buildBriefing(state)!.needsAttention).toBe(false);
    // Still out: attention.
    state.network.spans[0]!.outage = { cause: 'storm', storm: 1, startDay: state.day - 3, daysLeft: 2, repairCost: 1_000 };
    state.network.version++;
    expect(noticeNeedsAttention(state, storm)).toBe(true);
    expect(buildBriefing(state)!.needsAttention).toBe(true);
  });

  it('reads the forward look from the debt: the next payment, projected cash and the countdown', () => {
    const state = fixture('v3-grid');
    const b = buildBriefing(state)!;
    expect(b.forward.nextPayment).toBe(estimateNextDebtService(state));
    expect(b.forward.projectedCash).toBe(estimateCashAtClose(state) - estimateNextDebtService(state));
    expect(b.forward.closesUntilCalled).toBe(closesUntilAcceleration(state));
    expect(b.forward.runwayMonths).toBe(runwayMonths(state));
    expect(b.headline.debt).toBe(totalDebt(state));
    expect(b.headline.stage).toBe('frozen');
  });
});
