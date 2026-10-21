// Round-3 seams across modules, through real play (commands and daily ticks,
// never hand-set debt): the month close takes debt service after the month's
// operating entries and before the insolvency check; whole-dollar
// amortization is exact over full loan lives; the credit line charges
// interest on every end-of-day balance; covenant breaches escalate and cure
// one stage at a time; a default freezes the game for good; financing never
// touches operations (operating cash flow, cost per passing, subscribers);
// saves round-trip and replay at every covenant stage; and every frozen save
// (v1 and v2) migrates and then plays a year with loans. Round 4: a frozen
// hoarder (the v3 saves) is swept, warned, called after
// FROZEN_ACCELERATION_CLOSES frozen closes and repays within
// ACCELERATION_CLOSES closes, or defaults.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  COVENANT_CURE_CLOSES,
  FROZEN_ACCELERATION_CLOSES,
  LATE_FEE_MIN,
  LATE_FEE_SHARE,
  LEVERAGE_SPREAD_BANDS,
  MARKETING_MAX_PER_MONTH,
  PENALTY_STEP_UP_BPS,
  START_CASH,
  TERM_LOAN_MIN,
} from './balance';
import { DAYS_PER_YEAR, isFirstOfMonth } from './calendar';
import {
  covenantMetrics,
  creditAvailable,
  creditOffer,
  estimateNextDebtService,
  frozenReason,
  priceRate,
  quoteTermLoan,
  rateOf,
  reviewDebt,
  termCapacity,
  totalDebt,
  trailingArr,
} from './debt';
import { applyCommand, tick } from './game';
import { CAPEX_CATEGORIES, FINANCING_CATEGORIES, operatingCashFlow, reportKpis } from './metrics';
import { deserialize, hashState, serialize } from './save';
import { closedMonth, makeTradingState } from './testing/fixtures';
import type { Command, CommandResult, CovenantStage, GameState, LedgerCategory, MonthlyReport, NoticeKind } from './types';

type Fixture = 'v1-grid' | 'v1-town' | 'v2-grid' | 'v2-town' | 'v3-grid' | 'v3-town';

/** A frozen save from an earlier build, migrated to the current schema. */
function fixture(name: Fixture): GameState {
  return deserialize(readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8'));
}

function apply(state: GameState, cmd: Command): CommandResult {
  const result = applyCommand(state, cmd);
  expect(result, JSON.stringify(cmd)).toMatchObject({ ok: true });
  return result;
}

/** Tick until a month closes (or the game ends); the report that close wrote. */
function closeNext(state: GameState): MonthlyReport {
  const count = state.finance.reports.length;
  for (let i = 0; i < 40 && !state.gameOver; i++) {
    tick(state);
    if (state.finance.reports.length > count) return state.finance.reports.at(-1)!;
  }
  throw new Error('no close within 40 days');
}

/** Tick to the last day of the month (the next tick closes it). */
function toLastDay(state: GameState): void {
  while (!isFirstOfMonth(state.day + 1)) tick(state);
}

/** Everything ever posted in `categories` (all when omitted), closed months and the open one. */
function posted(state: GameState, categories?: readonly LedgerCategory[]): number {
  let sum = 0;
  for (const report of state.finance.reports) {
    if (!categories) sum += report.net;
    else for (const c of categories) sum += report.totals[c] ?? 0;
  }
  for (const e of state.finance.monthToDate) if (!categories || categories.includes(e.category)) sum += e.amount;
  return sum;
}

function kindsSince(state: GameState, afterId: number): NoticeKind[] {
  return state.notices.filter((n) => n.id > afterId).map((n) => n.kind);
}

function lastNoticeId(state: GameState): number {
  return state.notices.at(-1)?.id ?? 0;
}

/**
 * Order underground cable one street at a time until cash is below `target`
 * (or nothing more can be bought): real construction spending.
 */
function spendDownTo(state: GameState, target: number): void {
  const cabled = new Set(state.network.spans.map((s) => s.segment));
  for (const seg of state.city.segments) {
    if (state.finance.cash < target) return;
    if (cabled.has(seg.id)) continue;
    applyCommand(state, { type: 'layCable', segments: [seg.id], method: 'underground' });
  }
}

/** Interest on `dollarDays` at `bps` a year, actual/365, whole dollars (the day-count rule in debt.ts). */
function dayInterest(dollarDays: number, bps: number): number {
  return Math.round((dollarDays * bps) / (10_000 * DAYS_PER_YEAR));
}

/**
 * The Bank panel explains the line's rate with the offer's leverage and CPP:
 * pricing those figures again gives exactly the stored spreads.
 */
function expectOfferExplainsRate(state: GameState): void {
  const offer = creditOffer(state);
  const again = priceRate({ kind: 'line' }, offer.rate.leverage, offer.rate.cpp, state.debt.covenant.stage);
  expect({ leverageBps: offer.rate.leverageBps, cppBps: offer.rate.cppBps }).toEqual({ leverageBps: again.leverageBps, cppBps: again.cppBps });
  expect(offer.rate.cppBand).toBe(again.cppBand);
}

// ---------------------------------------------------------------------------

describe('month-close order with debt', () => {
  /**
   * v2-town with a term loan past its first (stub) month, on the last day of
   * a month: the next tick charges a regular payment.
   */
  function beforeRegularPayment(): GameState {
    const state = fixture('v2-town');
    apply(state, { type: 'takeTermLoan', amount: Math.max(TERM_LOAN_MIN, Math.floor(termCapacity(state) / 4 / 1000) * 1000), termYears: 5 });
    closeNext(state);
    toLastDay(state);
    return state;
  }

  /** Close with `cash` set just before the closing tick; the report and the notices it raised. */
  function closeWithCash(base: GameState, cash: number): { state: GameState; report: MonthlyReport; kinds: NoticeKind[] } {
    const state = structuredClone(base);
    state.finance.cash = cash;
    const mark = lastNoticeId(state);
    const report = closeNext(state);
    return { state, report, kinds: kindsSince(state, mark) };
  }

  it('pays debt service from the cash left after the month\'s revenue and operating costs, never before them', () => {
    const base = beforeRegularPayment();
    const due = estimateNextDebtService(base);
    expect(due).toBeGreaterThan(0);
    // What the close itself posts before the debt step (pole rent, overhead, revenue, marketing, ...).
    const probe = closeWithCash(base, base.finance.cash).report;
    const earlier = base.finance.monthToDate.reduce((sum, e) => sum + e.amount, 0);
    const financing = (probe.totals.interest ?? 0) + (probe.totals.principal ?? 0);
    expect(-financing).toBe(due);
    const atClose = probe.net - earlier - financing;

    // Exactly enough once the close's operating entries are in: paid in full.
    const exact = closeWithCash(base, due - atClose);
    expect(exact.report.debt).toMatchObject({ missedPayment: false });
    expect(exact.report.totals.interest! + exact.report.totals.principal!).toBe(-due);
    expect(exact.state.finance.cash).toBeGreaterThanOrEqual(0);
    // The month's operating entries are the same either way: debt never changes them.
    for (const c of ['revenue', 'overhead', 'poleRent', 'marketing', 'payroll', 'other'] as LedgerCategory[]) {
      expect(exact.report.totals[c], c).toBe(probe.totals[c]);
    }

    // One dollar short: missed. Nothing of the payment is posted, a late fee is.
    const fee = Math.max(LATE_FEE_MIN, Math.round(due * LATE_FEE_SHARE));
    const short = closeWithCash(base, due - atClose - 1);
    expect(short.report.debt).toMatchObject({ missedPayment: true, stage: 'frozen' });
    expect(short.report.totals.principal).toBeUndefined();
    expect(short.report.totals.interest).toBe(-fee);
    expect(short.report.cashEnd).toBe(due - 1 - fee);
    expect(short.kinds).toContain('paymentMissed');

    // Short with cash already below zero at the debt step: the insolvency check runs after the debt review.
    const red = closeWithCash(base, -atClose - 1);
    expect(red.report.debt).toMatchObject({ missedPayment: true, stage: 'frozen' });
    expect(red.report.cashEnd).toBe(-1 - fee);
    expect(red.kinds.indexOf('paymentMissed')).toBeGreaterThanOrEqual(0);
    expect(red.kinds.indexOf('insolvencyWarning')).toBeGreaterThan(red.kinds.indexOf('paymentMissed'));
    // Frozen with debt, no grace is left: the warning says the next close in the red is a default.
    const warning = red.state.notices.filter((n) => n.kind === 'insolvencyWarning').at(-1)!;
    expect(warning.message).toMatch(/credit line is frozen, so the next close in the red is a default/);
    expect(warning.message).not.toMatch(/more closes? in the red/);
    expect(red.state.finance.negativeMonths).toBe(1);
    expect(red.state.gameOver).toBeNull();
  });

  it('calls a payment missed while frozen a default, not insolvency, even on the close that would also be insolvent', () => {
    const base = beforeRegularPayment();
    // What the close posts before its debt step, so cash there can be set to -1.
    const earlier = base.finance.monthToDate.reduce((sum, e) => sum + e.amount, 0);
    const probe = closeWithCash(base, base.finance.cash).report;
    const atClose = probe.net - earlier - (probe.totals.interest ?? 0) - (probe.totals.principal ?? 0);
    // Frozen by a missed payment, two closes in the red already.
    const missed = closeWithCash(base, -atClose - 1);
    expect(missed.report.debt?.stage).toBe('frozen');
    const state = missed.state;
    toLastDay(state);
    state.finance.negativeMonths = 2;
    state.finance.cash = -START_CASH;
    const mark = lastNoticeId(state);
    const report = closeNext(state);
    expect(state.gameOver?.reason).toBe('default');
    expect(report.debt).toMatchObject({ missedPayment: true, stage: 'frozen' });
    expect(kindsSince(state, mark)).toEqual(expect.arrayContaining(['gameOver']));
    expect(kindsSince(state, mark)).not.toContain('insolvencyWarning');
    expect(state.notices.filter((n) => n.kind === 'gameOver')).toHaveLength(1);
  });
});

describe('term loans over their full lives, through real closes', () => {
  it('repay exactly the principal, charge exactly the quoted interest and level payments, 5 and 7 years side by side', () => {
    const state = fixture('v2-town');
    // Test-only: a cash cushion so seven unattended years (installs, round-4 storm repairs) never miss a payment.
    state.finance.cash += START_CASH;
    const amount5 = Math.max(TERM_LOAN_MIN, Math.floor(termCapacity(state) / 10 / 1000) * 1000);
    const q5 = quoteTermLoan(state, amount5, 5);
    expect(q5.ok).toBe(true);
    apply(state, { type: 'takeTermLoan', amount: amount5, termYears: 5 });
    const amount7 = TERM_LOAN_MIN;
    const q7 = quoteTermLoan(state, amount7, 7);
    expect(q7.ok).toBe(true);
    apply(state, { type: 'takeTermLoan', amount: amount7, termYears: 7 });
    const [loan5, loan7] = state.debt.loans.map((l) => structuredClone(l));
    expect(loan5!.payment).toBe(q5.payment);
    expect(loan7!.payment).toBe(q7.payment);
    const firstReport = state.finance.reports.length;

    let closes = 0;
    while (state.debt.loans.length > 0 && closes < 7 * 12 + 2) {
      const report = closeNext(state);
      closes++;
      expect(state.gameOver).toBeNull();
      // Healthy all along: no penalty rate, no missed payment, so the quotes hold.
      expect(report.debt).toMatchObject({ missedPayment: false, stage: 'compliant' });
      expect(Number.isSafeInteger(report.totals.interest ?? 0)).toBe(true);
    }
    // A stub month, then 60 and 84 regular payments: the 7-year loan is the last to go.
    expect(closes).toBe(7 * 12 + 1);
    const reports = state.finance.reports.slice(firstReport);
    const sum = (c: LedgerCategory) => reports.reduce((s, r) => s + (r.totals[c] ?? 0), 0);
    expect(-sum('principal')).toBe(amount5 + amount7);
    expect(-sum('interest')).toBe(q5.totalInterest + q7.totalInterest);
    // Level payments: every regular month charges both payments, except each loan's last.
    const service = reports.map((r) => -(r.totals.interest ?? 0) - (r.totals.principal ?? 0));
    expect(service[0]).toBe(q5.stubInterest + q7.stubInterest);
    for (let m = 1; m < 60; m++) expect(service[m], `month ${m}`).toBe(q5.payment + q7.payment);
    expect(service[60]).toBe(q5.lastPayment + q7.payment);
    for (let m = 61; m < 84; m++) expect(service[m], `month ${m}`).toBe(q7.payment);
    expect(service[84]).toBe(q7.lastPayment);
    expect(state.notices.filter((n) => n.kind === 'loanPaidOff').map((n) => n.message)).toEqual([
      expect.stringContaining(`#${loan5!.id} `),
      expect.stringContaining(`#${loan7!.id} `),
    ]);
    expect(state.finance.reports.at(-1)?.debt).toMatchObject({ termBalance: 0, averageRateBps: null });
  });
});

describe('credit-line interest through real days', () => {
  it('charges every end-of-day balance of the month, draws and repayments mid-month and on its last day included', () => {
    const state = fixture('v2-town');
    // Start a fresh month so every day of it is seen.
    closeNext(state);
    const rate = rateOf(state.debt.credit.rate);
    const limit = creditAvailable(state);
    expect(limit).toBeGreaterThan(3);
    let dollarDays = 0;
    let day = 0;
    while (!isFirstOfMonth(state.day + 1)) {
      // Draw on the 1st, repay part on the 5th, draw again on the 12th, repay what cash allows on the 20th.
      if (day === 0) apply(state, { type: 'drawCredit', amount: Math.floor(limit / 2) });
      if (day === 4) apply(state, { type: 'repayCredit', amount: Math.floor(limit / 4) });
      if (day === 11) apply(state, { type: 'drawCredit', amount: Math.floor(limit / 3) });
      if (day === 19) apply(state, { type: 'repayCredit', amount: 1 });
      dollarDays += state.debt.credit.balance;
      tick(state);
      day++;
    }
    // The last day: a draw that day is held overnight once.
    apply(state, { type: 'drawCredit', amount: 1 });
    dollarDays += state.debt.credit.balance;
    const estimate = estimateNextDebtService(state);
    const balance = state.debt.credit.balance;
    const report = closeNext(state);
    expect(report.totals.interest).toBe(-dayInterest(dollarDays, rate));
    expect(estimate).toBe(dayInterest(dollarDays, rate));
    expect(report.totals.loanProceeds).toBe(Math.floor(limit / 2) + Math.floor(limit / 3) + 1);
    expect(report.totals.principal).toBe(-(Math.floor(limit / 4) + 1));
    // The closing tick counted the last day, then the close started the new month's count from zero.
    expect(state.debt.credit).toMatchObject({ balance, balanceDollarDays: 0 });
    expect(report.debt?.creditBalance).toBe(balance);
  });

  it('repaying on the 1st after a close saves that day\'s interest; the closed month is not charged again', () => {
    const state = fixture('v2-town');
    closeNext(state);
    apply(state, { type: 'drawCredit', amount: creditAvailable(state) });
    const balance = state.debt.credit.balance;
    const rate = rateOf(state.debt.credit.rate);
    // Held every day of the month, then repaid the morning of the 1st.
    let days = 0;
    while (!isFirstOfMonth(state.day + 1)) {
      tick(state);
      days++;
    }
    const report = closeNext(state);
    expect(report.totals.interest).toBe(-dayInterest(balance * (days + 1), rate));
    apply(state, { type: 'repayCredit', amount: balance });
    const next = closeNext(state);
    expect(next.totals.interest).toBeUndefined();
    expect(next.debt).toMatchObject({ creditBalance: 0, termBalance: 0, leverageX100: 0, averageRateBps: null });
  });
});

describe('covenants through real play', () => {
  /**
   * v2-town borrowing everything the bank offers: the line and the largest
   * term loan, which the quote already says breaches a covenant.
   */
  function overBorrowed(): GameState {
    const state = fixture('v2-town');
    apply(state, { type: 'drawCredit', amount: creditAvailable(state) });
    const quote = quoteTermLoan(state, termCapacity(state), 7);
    expect(quote.ok).toBe(true);
    // Borrowing to the limit is a breach by design (a levered builder must be able to borrow itself to death).
    expect(quote.breachesCovenant).toBe(true);
    apply(state, { type: 'takeTermLoan', amount: quote.amount, termYears: 7 });
    return state;
  }

  /**
   * The cure script, keyed by closes since the loan: after the third close
   * (frozen) repay the line and prepay the term loan down to TERM_LOAN_MIN.
   */
  function act(state: GameState, closesSoFar: number): void {
    if (closesSoFar !== 3) return;
    apply(state, { type: 'repayCredit', amount: state.debt.credit.balance });
    const loan = state.debt.loans[0]!;
    apply(state, { type: 'prepayLoan', loan: loan.id, amount: loan.balance - TERM_LOAN_MIN });
  }

  it('escalate warning -> penalty -> frozen, block borrowing while frozen, then cure one stage per COVENANT_CURE_CLOSES compliant closes', () => {
    const state = overBorrowed();
    const stages: CovenantStage[] = [];
    const notices: NoticeKind[] = [];
    const saves: Array<{ closes: number; json: string }> = [];
    const covenantKinds = new Set<NoticeKind>(['covenantWarning', 'covenantPenalty', 'creditFrozen', 'covenantCured', 'paymentMissed']);
    const total = 3 + 3 * COVENANT_CURE_CLOSES;
    const surcharged = new Set<boolean>();
    for (let closes = 0; closes < total; closes++) {
      act(state, closes);
      const stage = state.debt.covenant.stage;
      const loan = structuredClone(state.debt.loans[0]!);
      const lineDollarDaysBefore = state.debt.credit.balanceDollarDays;
      const mark = lastNoticeId(state);
      const report = closeNext(state);
      expect(state.gameOver).toBeNull();
      expect(report.debt?.missedPayment).toBe(false);
      notices.push(...kindsSince(state, mark).filter((k) => covenantKinds.has(k)));
      stages.push(report.debt!.stage);
      // The month's interest carries the penalty surcharge exactly while the stage during the month was penalty or frozen.
      if (closes > 0 && state.debt.credit.balance === 0 && lineDollarDaysBefore === 0) {
        const surcharge = stage === 'penalty' || stage === 'frozen' ? PENALTY_STEP_UP_BPS : 0;
        const charged = -(report.totals.interest ?? 0);
        const expected = Math.round((loan.balance * (loan.rateBps + surcharge)) / 120_000);
        if (closes !== 3) {
          expect(charged, `close ${closes + 1} (${stage})`).toBe(expected);
          surcharged.add(surcharge > 0);
        }
      }
      expectOfferExplainsRate(state);
      // Saved at every stage, loads as itself.
      const json = serialize(state);
      expect(deserialize(json)).toEqual(state);
      saves.push({ closes: closes + 1, json });

      if (report.debt!.stage === 'frozen') {
        // Frozen: no draws, no new term loans, but repaying and prepaying still work.
        expect(creditAvailable(state)).toBe(0);
        expect(termCapacity(state)).toBe(0);
        expect(applyCommand(state, { type: 'drawCredit', amount: 1 })).toEqual({ ok: false, reason: frozenReason(state) });
        expect(applyCommand(state, { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: 5 })).toEqual({ ok: false, reason: frozenReason(state) });
      }
    }
    const cure = (stage: CovenantStage): CovenantStage[] => Array<CovenantStage>(COVENANT_CURE_CLOSES - 1).fill(stage);
    expect(stages).toEqual([
      'warning',
      'penalty',
      'frozen',
      ...cure('frozen'),
      'penalty',
      ...cure('penalty'),
      'warning',
      ...cure('warning'),
      'compliant',
    ]);
    expect(notices).toEqual(['covenantWarning', 'covenantPenalty', 'creditFrozen', 'covenantCured', 'covenantCured', 'covenantCured']);
    // Months with and without the surcharge were both checked.
    expect([...surcharged].sort()).toEqual([false, true]);
    expect(covenantMetrics(state).compliant).toBe(true);
    expect(creditAvailable(state)).toBeGreaterThan(0);

    // Every save replays to the same end as the straight game.
    const end = hashState(state);
    for (const { closes, json } of saves) {
      const copy = deserialize(json);
      for (let c = closes; c < total; c++) {
        act(copy, c);
        closeNext(copy);
      }
      expect(hashState(copy), `from the save after close ${closes}`).toBe(end);
    }
  });

  it('a payment missed while frozen is a default: the game ends and stays exactly as it ended, through saves', () => {
    const state = overBorrowed();
    for (let i = 0; i < 3; i++) closeNext(state);
    expect(state.debt.covenant.stage).toBe('frozen');
    // Spend the cash on plant and marketing so the next payment cannot be made.
    spendDownTo(state, START_CASH / 100);
    apply(state, { type: 'setMarketing', perMonth: MARKETING_MAX_PER_MONTH });
    const report = closeNext(state);
    expect(state.gameOver?.reason).toBe('default');
    expect(state.gameOver?.day).toBe(state.day);
    expect(report.debt).toMatchObject({ missedPayment: true, stage: 'frozen' });
    expect(state.notices.at(-1)).toMatchObject({ kind: 'gameOver', message: state.gameOver!.message });
    expect(state.gameOver!.message).toMatch(/Default/);
    expect(totalDebt(state)).toBeGreaterThan(0);

    // Frozen for good: days stop, every command is rejected, nothing changes.
    const ended = serialize(state);
    for (let i = 0; i < 45; i++) tick(state);
    for (const cmd of [
      { type: 'repayCredit', amount: 1 },
      { type: 'prepayLoan', loan: state.debt.loans[0]!.id, amount: 1 },
      { type: 'drawCredit', amount: 1 },
      { type: 'setMarketing', perMonth: 0 },
    ] as Command[]) {
      const result = applyCommand(state, cmd);
      expect(result.ok).toBe(false);
      expect(result.ok ? '' : result.reason).toMatch(/^Game over: Default/);
    }
    expect(serialize(state)).toBe(ended);
    const loaded = deserialize(ended);
    expect(loaded).toEqual(state);
    for (let i = 0; i < 45; i++) tick(loaded);
    expect(serialize(loaded)).toBe(ended);
  });
});

describe('financing never touches operations', () => {
  it('a borrower and a non-borrower with the same plant have identical months, but for the financing lines', () => {
    const plain = fixture('v2-town');
    const borrower = fixture('v2-town');
    // Test-only: the same cushion of cash for both, so neither runs short of an order or pauses
    // installs (round-4 storm repairs and price rules cost the plain game money too), whatever it borrows.
    for (const state of [plain, borrower]) state.finance.cash += START_CASH;
    const loan = Math.max(TERM_LOAN_MIN, Math.floor(termCapacity(borrower) / 5 / 1000) * 1000);
    apply(borrower, { type: 'takeTermLoan', amount: loan, termYears: 5 });
    const startReports = plain.finance.reports.length;
    for (let month = 0; month < 12; month++) {
      // The same plant for both; only the borrower moves money with the bank.
      for (const state of [plain, borrower]) {
        const seg = state.city.segments.find((s) => !state.network.spans.some((sp) => sp.segment === s.id));
        if (month % 3 === 0 && seg) apply(state, { type: 'layCable', segments: [seg.id], method: 'aerial' });
      }
      if (month % 2 === 0 && creditAvailable(borrower) > 1) apply(borrower, { type: 'drawCredit', amount: Math.floor(creditAvailable(borrower) / 2) });
      else if (borrower.debt.credit.balance > 0) apply(borrower, { type: 'repayCredit', amount: borrower.debt.credit.balance });
      if (month === 6) apply(borrower, { type: 'prepayLoan', loan: borrower.debt.loans[0]!.id, amount: TERM_LOAN_MIN / 2 });
      closeNext(plain);
      closeNext(borrower);
      expect(borrower.debt.covenant.stage).toBe('compliant');
    }
    expect(borrower.finance.reports.slice(startReports).every((r) => !r.debt?.missedPayment)).toBe(true);

    // Operations are identical: network, sales, capex, the random streams.
    expect(borrower.network).toEqual(plain.network);
    expect(borrower.sales).toEqual(plain.sales);
    expect(borrower.finance.capex).toEqual(plain.finance.capex);
    expect(borrower.rng).toEqual(plain.rng);
    expect(borrower.milestones).toEqual(plain.milestones);
    let financing = 0;
    for (let i = startReports; i < plain.finance.reports.length; i++) {
      const a = plain.finance.reports[i]!;
      const b = borrower.finance.reports[i]!;
      expect(b.stats).toEqual(a.stats);
      expect(b.passings).toBe(a.passings);
      expect(reportKpis(b)).toEqual(reportKpis(a));
      expect(operatingCashFlow(b)).toBe(operatingCashFlow(a));
      const flows = FINANCING_CATEGORIES.reduce((s, c) => s + (b.totals[c] ?? 0), 0);
      expect(a.totals.interest ?? 0).toBe(0);
      // Net cash flow = operating + capex + financing.
      const capex = CAPEX_CATEGORIES.reduce((s, c) => s + (b.totals[c] ?? 0), 0);
      expect(b.net).toBe(operatingCashFlow(b) + capex + flows);
      expect(b.net - a.net).toBe(flows);
      financing += flows;
      // The loan's proceeds are in the first month's financing.
      expect(b.cashEnd - a.cashEnd).toBe(financing);
      // Every financing line the borrower has, the plain game lacks, and nothing else differs.
      for (const c of Object.keys(b.totals) as LedgerCategory[]) {
        if (!FINANCING_CATEGORIES.includes(c)) expect(b.totals[c], c).toBe(a.totals[c]);
      }
    }
    expect(financing).not.toBe(0);
  });
});

describe('frozen saves of every version migrate, then play a year with loans', () => {
  it.each(['v1-grid', 'v1-town', 'v2-grid', 'v2-town'] as const)('%s', (name) => {
    let state = fixture(name);
    const old = structuredClone(state.finance.reports);
    const openingCash = state.finance.cash - posted(state);
    // Months of play until the bank will lend (v1 saves predate sales, so revenue comes first).
    apply(state, { type: 'setMarketing', perMonth: Math.min(5_000, MARKETING_MAX_PER_MONTH) });
    for (let m = 0; m < 12 && termCapacity(state) === 0; m++) closeNext(state);
    expect(trailingArr(state)).toBeGreaterThan(0);
    expect(termCapacity(state)).toBeGreaterThanOrEqual(TERM_LOAN_MIN);
    apply(state, { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: 5 });
    if (creditAvailable(state) > 0) apply(state, { type: 'drawCredit', amount: creditAvailable(state) });
    const loanId = state.debt.loans[0]!.id;

    for (let month = 0; month < 12 && !state.gameOver; month++) {
      // Use the line for timing: repay when cash is plentiful, draw when short.
      const due = estimateNextDebtService(state);
      if (state.debt.credit.balance > 0 && state.finance.cash > 4 * due + state.debt.credit.balance) {
        apply(state, { type: 'repayCredit', amount: state.debt.credit.balance });
      } else if (state.finance.cash < 2 * due && creditAvailable(state) > 0) {
        apply(state, { type: 'drawCredit', amount: creditAvailable(state) });
      }
      if (month === 6 && state.debt.loans.length > 0) apply(state, { type: 'prepayLoan', loan: loanId, amount: TERM_LOAN_MIN / 4 });
      const report = closeNext(state);
      expect(report.debt).toBeDefined();
      expect(report.debt!.creditBalance + report.debt!.termBalance).toBe(totalDebt(state));
      expectOfferExplainsRate(state);
      // The books balance, and the game saves and loads as itself at every close.
      expect(openingCash + posted(state)).toBe(state.finance.cash);
      const copy = deserialize(serialize(state));
      expect(copy).toEqual(state);
      state = copy;
    }
    expect(state.gameOver).toBeNull();
    // Paid down along the way, never missed.
    expect(state.debt.loans[0]?.balance ?? 0).toBeLessThan(TERM_LOAN_MIN - TERM_LOAN_MIN / 4);
    expect(state.finance.reports.slice(old.length).every((r) => r.debt && !r.debt.missedPayment)).toBe(true);
    // Months closed before round 3 keep their shape: no debt block (and v1 months no stats).
    expect(state.finance.reports.slice(0, old.length)).toEqual(old);
    for (const r of old) expect(r.debt).toBeUndefined();
  });
});

describe('the line is priced on the figures the Bank shows', () => {
  it('prices leverage just past a band edge as the hundredths the report and the offer show', () => {
    const edge = LEVERAGE_SPREAD_BANDS[0]!;
    const state = makeTradingState(40_000, 10_000);
    const uw = covenantMetrics(state).underwritingCashFlow;
    // Leverage a hair over the first band's edge: 2.004 reads as 2.00.
    state.debt.credit.balance = Math.round(uw * (edge.maxLeverage + 0.004));
    const report = closedMonth(2027, 4, 40_000, 10_000);
    state.finance.reports.push(report);
    reviewDebt(state, report, { due: 0, interestPaid: 0, principalPaid: 0, missed: false, defaulted: false, lateFee: 0, paidOff: [], sweep: 0 });
    expect(report.debt?.leverageX100).toBe(edge.maxLeverage * 100);
    expect(state.debt.credit.rate.leverageBps).toBe(edge.spreadBps);
    expectOfferExplainsRate(state);
  });
});

// ---------------------------------------------------------------------------
// Round 4: the frozen hoarder. A line frozen with debt owed no longer sits on
// its cash forever: the bank sweeps half of each month's positive operating
// cash flow, warns, calls the loans after FROZEN_ACCELERATION_CLOSES frozen
// closes in a row, and collects everything within ACCELERATION_CLOSES closes
// (or the game ends in default).
// ---------------------------------------------------------------------------

describe('a frozen hoarder (round 4)', () => {
  interface CloseLog {
    stage: CovenantStage;
    frozenCloses: number;
    closesLeft: number | null;
    sweep: number;
    kinds: NoticeKind[];
    missed: boolean;
  }

  /** Close months with no commands until the debt is gone (and the call over) or the game ends; one log row per close. */
  function sitOnCash(state: GameState, maxCloses: number): CloseLog[] {
    const openingCash = state.finance.cash - posted(state);
    const log: CloseLog[] = [];
    for (let i = 0; i < maxCloses && !state.gameOver && (totalDebt(state) > 0 || state.debt.acceleration !== null); i++) {
      const mark = lastNoticeId(state);
      const report = closeNext(state);
      log.push({
        stage: report.debt!.stage,
        frozenCloses: report.debt!.frozenCloses!,
        closesLeft: report.debt!.accelerationClosesLeft ?? null,
        sweep: report.debt!.sweep!,
        kinds: kindsSince(state, mark),
        missed: report.debt!.missedPayment,
      });
      // The books balance and the game saves and loads as itself at every close.
      expect(openingCash + posted(state)).toBe(state.finance.cash);
      expect(deserialize(serialize(state))).toEqual(state);
    }
    return log;
  }

  /** The closes (1-based) at which a notice of `kind` was posted. */
  function closesWith(log: readonly CloseLog[], kind: NoticeKind): number[] {
    return log.flatMap((row, i) => (row.kinds.includes(kind) ? [i + 1] : []));
  }

  it('v3-grid (frozen at load, burning cash): warned, called, then repaid in full within the closes the bank allows', () => {
    const state = fixture('v3-grid');
    expect(state.debt.covenant.stage).toBe('frozen');
    const start = state.debt.frozenCloses;
    expect(start).toBeGreaterThan(0);
    const cash = state.finance.cash;
    expect(cash).toBeGreaterThan(totalDebt(state));
    const log = sitOnCash(state, 24);
    expect(state.gameOver).toBeNull();
    // Frozen at every close until the call: counted on from the migrated count.
    const callAt = FROZEN_ACCELERATION_CLOSES - start;
    for (let i = 0; i < callAt; i++) expect(log[i]).toMatchObject({ stage: 'frozen', frozenCloses: start + i + 1 });
    // Warned at the closes leaving 1..ACCELERATION_WARNING_CLOSES before the call, called at the call.
    const warnings: number[] = [];
    for (let left = ACCELERATION_WARNING_CLOSES; left >= 1; left--) warnings.push(callAt - left);
    expect(closesWith(log, 'accelerationWarning')).toEqual(warnings);
    expect(closesWith(log, 'loansCalled')).toEqual([callAt]);
    expect(log[callAt - 1]!.closesLeft).toBe(ACCELERATION_CLOSES);
    // A burning month has nothing to sweep.
    expect(log.every((row) => row.sweep === 0)).toBe(true);
    // Everything repaid within the closes the bank allowed, the call cleared, the line back to good standing.
    expect(log.length).toBeLessThanOrEqual(callAt + ACCELERATION_CLOSES);
    expect(log.every((row) => !row.missed)).toBe(true);
    expect(totalDebt(state)).toBe(0);
    expect(state.debt.acceleration).toBeNull();
    expect(state.debt.covenant.stage).toBe('compliant');
    expect(log.at(-1)!.closesLeft).toBeNull();
  });

  it('v3-town borrowing everything and sitting on the cash: swept while frozen, warned, called, then repaid or in default', () => {
    const state = fixture('v3-town');
    apply(state, { type: 'drawCredit', amount: creditAvailable(state) });
    const quote = quoteTermLoan(state, termCapacity(state), 7);
    expect(quote).toMatchObject({ ok: true, breachesCovenant: true });
    apply(state, { type: 'takeTermLoan', amount: quote.amount, termYears: 7 });
    const log = sitOnCash(state, 30);
    const frozenAt = log.findIndex((row) => row.stage === 'frozen') + 1;
    expect(frozenAt).toBeGreaterThan(0);
    expect(log.slice(0, frozenAt).map((row) => row.stage)).toEqual(['warning', 'penalty', 'frozen'].slice(-frozenAt));
    // The close that froze the line did not sweep; every frozen close after it with cash flow to share did.
    expect(log[frozenAt - 1]!.sweep).toBe(0);
    const swept = closesWith(log, 'debtSwept');
    expect(swept.length).toBeGreaterThan(0);
    expect(Math.min(...swept)).toBeGreaterThan(frozenAt);
    for (const close of swept) expect(log[close - 1]!.sweep).toBeGreaterThan(0);
    // Warned, then called at the FROZEN_ACCELERATION_CLOSES-th frozen close in a row.
    const callAt = frozenAt + FROZEN_ACCELERATION_CLOSES - 1;
    expect(closesWith(log, 'loansCalled')).toEqual([callAt]);
    expect(closesWith(log, 'accelerationWarning').length).toBe(ACCELERATION_WARNING_CLOSES);
    // Then it ends one way or the other within the closes the bank allows.
    expect(log.length).toBeLessThanOrEqual(callAt + ACCELERATION_CLOSES);
    if (state.gameOver) {
      expect(state.gameOver.reason).toBe('default');
      expect(state.gameOver.message).toMatch(/^Default: the bank called your loans/);
    } else {
      expect(totalDebt(state)).toBe(0);
      expect(state.debt.acceleration).toBeNull();
    }
  });
});
