// Financing (debt.ts): the state helpers, underwriting and covenant metrics,
// pricing, amortization, offers and quotes, the four commands and the daily
// step. The month close (closeDebtMonth / reviewDebt through
// finance.closeMonth) is covered in finance.test.ts; long random sessions in
// debtSession.test.ts.

import { describe, expect, it } from 'vitest';
import {
  ARR_TRAILING_MONTHS,
  BASE_RATE_BPS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  CREDIT_LIMIT_ARR_MULTIPLE,
  CREDIT_LINE_EXTRA_BPS,
  LEVERAGE_SPREAD_BANDS,
  LEVERAGE_SPREAD_MAX_BPS,
  LOAN_ROUNDING,
  PAYMENT_REMINDER_DAYS,
  PENALTY_STEP_UP_BPS,
  TERM_CAPACITY_ARR_MULTIPLE,
  TERM_EXTRA_BPS,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  UNDERWRITING_MIN_MARGIN,
} from './balance';
import { dateOf, dayOf, DAYS_PER_YEAR, MONTH_ABBR, MONTH_LENGTHS } from './calendar';
import {
  amortize,
  annualDebtService,
  annualOperatingCashFlow,
  covenantMetrics,
  creditAvailable,
  creditLimit,
  creditOffer,
  drawCredit,
  endDebtDay,
  estimateNextDebtService,
  formatMultiple,
  formatRateBps,
  frozenReason,
  levelPayment,
  leverageSpreadBps,
  newDebt,
  penaltyBps,
  prepayLoan,
  priceRate,
  pricingCpp,
  quotePrepay,
  quoteTermLoan,
  rateOf,
  repayCredit,
  stubDays,
  takeTermLoan,
  termCapacity,
  totalDebt,
  trailingArr,
} from './debt';
import { closeMonth, estimateCashAtClose, formatMoney } from './finance';
import { cppBand, operatingCashFlow } from './metrics';
import { getService } from './network';
import { Rng } from './rng';
import { addLivePlant, closedMonth, makeLoan, makeTestState, makeTradingState } from './testing/fixtures';
import type { CommandResult, CovenantStage, GameState, MonthlyReport, TermLoan, TermYears } from './types';

/** A closed month with only revenue on the books (enough for the trailing figures). */
function report(month: number, revenue: number): MonthlyReport {
  return { year: 2027, month, totals: revenue > 0 ? { revenue } : {}, net: revenue, cashEnd: 0, passings: 0 };
}

function withRevenue(...revenues: number[]): GameState {
  const state = makeTestState();
  state.finance.reports = revenues.map((r, i) => report(i + 1, r));
  return state;
}

describe('newDebt', () => {
  it('starts with nothing borrowed, compliant, the line priced at base plus its product adjustment', () => {
    expect(newDebt()).toEqual({
      credit: {
        balance: 0,
        rate: { baseBps: BASE_RATE_BPS, leverageBps: 0, cppBps: 0, productBps: CREDIT_LINE_EXTRA_BPS },
        balanceDollarDays: 0,
      },
      loans: [],
      nextLoanId: 1,
      covenant: { stage: 'compliant', compliantCloses: 0 },
    });
    // Fresh objects every time: a game must never share debt state with another.
    expect(newDebt()).not.toBe(newDebt());
    expect(newDebt().loans).not.toBe(newDebt().loans);
  });

  it('is what a new game starts with', () => {
    expect(makeTestState().debt).toEqual(newDebt());
  });
});

describe('totalDebt, rateOf, penaltyBps', () => {
  it('adds the line and every loan', () => {
    const state = makeTestState();
    expect(totalDebt(state)).toBe(0);
    state.debt.credit.balance = 1_500;
    state.debt.loans.push(
      { id: 1, principal: 40_000, balance: 30_000, rateBps: 700, termMonths: 60, payment: 800, monthsLeft: 40, originatedDay: 0 },
      { id: 2, principal: 20_000, balance: 20_000, rateBps: 750, termMonths: 84, payment: 300, monthsLeft: 84, originatedDay: 0 },
    );
    expect(totalDebt(state)).toBe(1_500 + 30_000 + 20_000);
  });

  it('sums rate parts without the penalty, which follows the stage', () => {
    expect(rateOf({ baseBps: 500, leverageBps: 150, cppBps: 100, productBps: 50 })).toBe(800);
    expect(penaltyBps('compliant')).toBe(0);
    expect(penaltyBps('warning')).toBe(0);
    expect(penaltyBps('penalty')).toBe(PENALTY_STEP_UP_BPS);
    expect(penaltyBps('frozen')).toBe(PENALTY_STEP_UP_BPS);
  });
});

describe('trailingArr and the credit limit', () => {
  it('is zero before the first close and with no revenue', () => {
    expect(trailingArr(makeTestState())).toBe(0);
    expect(trailingArr(withRevenue(0, 0))).toBe(0);
    expect(creditLimit(makeTestState())).toBe(0);
    expect(creditAvailable(makeTestState())).toBe(0);
  });

  it('annualizes the trailing closed months, however many there are so far', () => {
    expect(trailingArr(withRevenue(1_000))).toBe(12_000);
    const revenues = [1_000, 2_000, 3_000, 4_000, 5_000, 6_000, 7_000];
    for (let n = 1; n <= revenues.length; n++) {
      const months = revenues.slice(0, n);
      const window = months.slice(-ARR_TRAILING_MONTHS);
      const expected = Math.round((window.reduce((a, b) => a + b, 0) * 12) / window.length);
      expect(trailingArr(withRevenue(...months)), `${n} months`).toBe(expected);
    }
  });

  it('sets the limit at a multiple of ARR, rounded down, and offers what is not drawn unless frozen', () => {
    const state = withRevenue(10_417, 10_417, 10_417);
    const arr = trailingArr(state);
    const limit = Math.floor((arr * CREDIT_LIMIT_ARR_MULTIPLE) / LOAN_ROUNDING) * LOAN_ROUNDING;
    expect(creditLimit(state)).toBe(limit);
    expect(limit % LOAN_ROUNDING).toBe(0);
    expect(limit).toBeGreaterThan(0);
    expect(creditAvailable(state)).toBe(limit);

    state.debt.credit.balance = limit - LOAN_ROUNDING;
    expect(creditAvailable(state)).toBe(LOAN_ROUNDING);
    // A shrunken limit (or capitalized interest) can leave the line over its limit: nothing to draw, never negative.
    state.debt.credit.balance = limit + 5;
    expect(creditAvailable(state)).toBe(0);

    state.debt.credit.balance = 0;
    state.debt.covenant.stage = 'frozen';
    expect(creditAvailable(state)).toBe(0);
    state.debt.covenant.stage = 'penalty';
    expect(creditAvailable(state)).toBe(limit);
  });

  it('only moves at a month close: it reads closed months, not the open one', () => {
    const state = withRevenue(5_000, 5_000, 5_000);
    const before = trailingArr(state);
    state.finance.monthToDate.push({ day: state.day, category: 'revenue', amount: 99_999, memo: 'not closed yet' });
    expect(trailingArr(state)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Round 3, sim-debt: everything else
// ---------------------------------------------------------------------------

/** Monthly revenue of the trading states below (a test input, not a balance figure). */
const REVENUE = 25_000;
/** 10,000 bps x days a year: the divisor of day-count interest. */
const DAY_DIVISOR = 10_000 * DAYS_PER_YEAR;

/** Leverage and coverage as covenantMetrics gives them: to the hundredth. */
function hundredth(x: number): number {
  return Math.round(x * 100) / 100;
}

/** REVENUE billed in each trailing month, `costs` spent; the 10th of the month after. */
function trading(costs = 0): GameState {
  return makeTradingState(REVENUE, costs);
}

/** First day of the month state.day is in. */
function monthStartOf(state: GameState): number {
  return state.day - dateOf(state.day).day + 1;
}

/** The day of the next close (the 1st of next month). */
function nextCloseDay(state: GameState): number {
  const date = dateOf(state.day);
  return monthStartOf(state) + (MONTH_LENGTHS[date.month - 1] as number);
}

function re(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

function okCost(result: CommandResult): number {
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.cost : Number.NaN;
}

/** Run a command expecting a rejection matching `reason`, with the state untouched. */
function expectRejected(state: GameState, run: (s: GameState) => CommandResult, reason: RegExp): void {
  const before = structuredClone(state);
  const result = run(state);
  expect(result.ok).toBe(false);
  expect(result.ok ? '' : result.reason).toMatch(reason);
  expect(state).toEqual(before);
}

const ZERO_STATS = {
  subscribers: 0,
  accounts: 0,
  subscriberDays: 0,
  grossAdds: 0,
  churned: 0,
  lostService: 0,
  connectsTotal: 0,
  capexOsp: 0,
  capexConnect: 0,
  capexCo: 0,
  ponPortsUsed: 0,
  ponPorts: 0,
  fullCabinets: 0,
};

const JUNK_AMOUNTS: unknown[] = [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1000', null, 2 ** 60];

describe('annualOperatingCashFlow', () => {
  it('is zero before the first close', () => {
    expect(annualOperatingCashFlow(makeTestState())).toBe(0);
  });

  it('annualizes the trailing window like trailingArr, leaving out capex and financing', () => {
    const flows: Array<[number, number]> = [
      [5_000, 8_000],
      [6_000, 7_500],
      [9_000, 4_000],
      [12_000, 3_000],
      [2_000, 9_000],
    ];
    const reports = flows.map(([revenue, costs], i) => {
      const r = closedMonth(2027, i + 1, revenue, costs);
      const other = { construction: -50_000, install: -3_000, interest: -700, principal: -1_000, loanProceeds: 20_000 };
      Object.assign(r.totals, other);
      r.net += Object.values(other).reduce((a, b) => a + b, 0);
      return r;
    });
    for (let n = 1; n <= reports.length; n++) {
      const state = makeTestState();
      state.finance.reports = reports.slice(0, n);
      const window = flows.slice(0, n).slice(-ARR_TRAILING_MONTHS);
      const flow = window.reduce((sum, [revenue, costs]) => sum + revenue - costs, 0);
      expect(annualOperatingCashFlow(state), `${n} months`).toBe(Math.round((flow * 12) / window.length));
      const viaMetrics = state.finance.reports.slice(-ARR_TRAILING_MONTHS).reduce((sum, r) => sum + operatingCashFlow(r), 0);
      expect(annualOperatingCashFlow(state)).toBe(Math.round((viaMetrics * 12) / window.length));
    }
  });
});

describe('annualDebtService', () => {
  /** The first `n` payments of `loan`'s exact schedule at `bps` (what the closes charge while the stage holds). */
  function scheduled(loan: TermLoan, bps: number, n: number): number {
    return amortize(loan.balance, bps, loan.monthsLeft, loan.payment)
      .slice(0, n)
      .reduce((sum, p) => sum + p.interest + p.principal, 0);
  }

  it('is a year of each loan\'s scheduled payments (fewer when fewer are left, the last one exact) plus a year of line interest at today\'s rate', () => {
    const state = makeTestState();
    expect(annualDebtService(state)).toBe(0);
    const long = makeLoan({ id: 1, monthsLeft: 40 });
    const ending = makeLoan({ id: 2, monthsLeft: 5, balance: 7_000, principal: 60_000 });
    state.debt.loans = [long, ending];
    const loans = scheduled(long, long.rateBps, 12) + scheduled(ending, ending.rateBps, 5);
    // Level payments: a year of the long loan is 12 of them; the ending one's last absorbs the rounding.
    expect(scheduled(long, long.rateBps, 12)).toBe(long.payment * 12);
    expect(Math.abs(scheduled(ending, ending.rateBps, 5) - ending.payment * 5)).toBeLessThanOrEqual(5);
    expect(annualDebtService(state)).toBe(loans);
    state.debt.credit.balance = 25_000;
    const rate = rateOf(state.debt.credit.rate);
    expect(annualDebtService(state)).toBe(loans + Math.round((25_000 * rate) / 10_000));
    // The penalty surcharge on every balance (loan payments as they stand: a close re-sets them).
    state.debt.covenant.stage = 'penalty';
    const penalized = scheduled(long, long.rateBps + PENALTY_STEP_UP_BPS, 12) + scheduled(ending, ending.rateBps + PENALTY_STEP_UP_BPS, 5);
    expect(annualDebtService(state)).toBe(penalized + Math.round((25_000 * (rate + PENALTY_STEP_UP_BPS)) / 10_000));
  });
});

describe('covenantMetrics', () => {
  it('passes with no debt, whatever the cash flows', () => {
    for (const state of [makeTestState(), trading(), trading(REVENUE * 3), makeTradingState(0, 9_000)]) {
      expect(covenantMetrics(state)).toMatchObject({
        totalDebt: 0,
        annualDebtService: 0,
        leverage: 0,
        coverage: null,
        leverageOk: true,
        coverageOk: true,
        compliant: true,
      });
    }
  });

  it('underwrites on operating cash flow, or on the ARR floor when that is higher', () => {
    const strong = trading(REVENUE / 5);
    strong.debt.credit.balance = 100_000;
    const s = covenantMetrics(strong);
    expect(s.arr).toBe(REVENUE * 12);
    expect(s.annualOperatingCashFlow).toBe((REVENUE - REVENUE / 5) * 12);
    expect(s.underwritingCashFlow).toBe(Math.max(s.annualOperatingCashFlow, s.arr * UNDERWRITING_MIN_MARGIN));
    expect(s.totalDebt).toBe(100_000);
    expect(s.leverage).toBe(hundredth(100_000 / s.underwritingCashFlow));
    expect(s.annualDebtService).toBe(annualDebtService(strong));
    expect(s.coverage).toBe(hundredth(s.underwritingCashFlow / s.annualDebtService));

    // Burning cash: a young network is judged on its recurring revenue.
    const young = trading(REVENUE * 2);
    young.debt.credit.balance = 100_000;
    const y = covenantMetrics(young);
    expect(y.annualOperatingCashFlow).toBe(-REVENUE * 12);
    expect(y.underwritingCashFlow).toBe(y.arr * UNDERWRITING_MIN_MARGIN);
    expect(y.leverage).toBe(hundredth(100_000 / (y.arr * UNDERWRITING_MIN_MARGIN)));
  });

  it('cannot measure debt without revenue or positive cash flow: a breach', () => {
    for (const state of [makeTradingState(0, 5_000), makeTradingState(0, 0), makeTestState()]) {
      state.debt.credit.balance = 1_000;
      const m = covenantMetrics(state);
      expect(m.underwritingCashFlow).toBeLessThanOrEqual(0);
      expect(m.leverage).toBeNull();
      expect(m.leverageOk).toBe(false);
      expect(m.compliant).toBe(false);
      // Coverage is still a figure (<= 0 here), and fails.
      expect(m.coverage).toBe(hundredth(m.underwritingCashFlow / m.annualDebtService));
      expect(m.coverageOk).toBe(false);
    }
  });

  it('allows leverage and coverage that read at their limits to the hundredth, and no further', () => {
    // No costs: operating cash flow is all of revenue, so it is the underwriting cash flow.
    const state = trading();
    const uw = covenantMetrics(state).underwritingCashFlow;
    expect(uw).toBe(REVENUE * 12);
    const atLimit = uw * COVENANT_MAX_LEVERAGE;
    expect(Number.isInteger(atLimit)).toBe(true);
    // An interest-free loan with years to run: its annual debt service is 12 level payments.
    const paymentFor = (coverage: number) => Math.ceil(uw / coverage / 12);
    const payment = Math.floor(uw / COVENANT_MIN_COVERAGE / 12);
    state.debt.loans = [makeLoan({ balance: atLimit, principal: atLimit, rateBps: 0, monthsLeft: 120, payment })];
    let m = covenantMetrics(state);
    expect(m.leverage).toBe(COVENANT_MAX_LEVERAGE);
    expect(m.annualDebtService).toBe(payment * 12);
    expect(m.coverage).toBeGreaterThanOrEqual(COVENANT_MIN_COVERAGE);
    expect(m).toMatchObject({ leverageOk: true, coverageOk: true, compliant: true });

    // A little over the limit that still reads as the limit is within it ...
    state.debt.loans[0]!.balance = atLimit + Math.floor(uw * 0.004);
    m = covenantMetrics(state);
    expect(m.leverage).toBe(COVENANT_MAX_LEVERAGE);
    expect(m.leverageOk).toBe(true);
    // ... and the next hundredth is over it.
    state.debt.loans[0]!.balance = atLimit + Math.ceil(uw * 0.006);
    m = covenantMetrics(state);
    expect(m.leverage).toBe(hundredth(COVENANT_MAX_LEVERAGE + 0.01));
    expect(m).toMatchObject({ leverageOk: false, coverageOk: true, compliant: false });

    state.debt.loans[0]!.balance = atLimit;
    state.debt.loans[0]!.payment = paymentFor(COVENANT_MIN_COVERAGE - 0.004);
    m = covenantMetrics(state);
    expect(m.coverage).toBe(COVENANT_MIN_COVERAGE);
    expect(m).toMatchObject({ leverageOk: true, coverageOk: true, compliant: true });
    state.debt.loans[0]!.payment = paymentFor(COVENANT_MIN_COVERAGE - 0.006);
    m = covenantMetrics(state);
    expect(m.coverage).toBe(hundredth(COVENANT_MIN_COVERAGE - 0.01));
    expect(m).toMatchObject({ leverageOk: true, coverageOk: false, compliant: false });
  });

  it('adds a pro forma loan to the debt and the debt service, changing nothing', () => {
    const state = trading();
    state.debt.credit.balance = 40_000;
    const base = covenantMetrics(state);
    const pro = covenantMetrics(state, { addDebt: 70_000, addAnnualDebtService: 9_000 });
    expect(pro.totalDebt).toBe(base.totalDebt + 70_000);
    expect(pro.annualDebtService).toBe(base.annualDebtService + 9_000);
    expect(pro.underwritingCashFlow).toBe(base.underwritingCashFlow);
    expect(pro.leverage).toBe(hundredth(pro.totalDebt / base.underwritingCashFlow));
    expect(pro.coverage).toBe(hundredth(base.underwritingCashFlow / pro.annualDebtService));
    expect(covenantMetrics(state)).toEqual(base);
    // A pro forma loan on no debt makes leverage measurable (or not) like real debt.
    const fresh = makeTradingState(0, 0);
    expect(covenantMetrics(fresh, { addDebt: TERM_LOAN_MIN, addAnnualDebtService: 1 }).leverage).toBeNull();
  });
});

describe('pricing', () => {
  it('spreads leverage by band, edges inclusive, and charges the most when it cannot be measured', () => {
    expect(leverageSpreadBps(null)).toBe(LEVERAGE_SPREAD_MAX_BPS);
    expect(leverageSpreadBps(Number.NaN)).toBe(LEVERAGE_SPREAD_MAX_BPS);
    expect(leverageSpreadBps(0)).toBe(LEVERAGE_SPREAD_BANDS[0]!.spreadBps);
    LEVERAGE_SPREAD_BANDS.forEach((band, i) => {
      expect(leverageSpreadBps(band.maxLeverage), `at ${band.maxLeverage}`).toBe(band.spreadBps);
      const next = LEVERAGE_SPREAD_BANDS[i + 1]?.spreadBps ?? LEVERAGE_SPREAD_MAX_BPS;
      expect(leverageSpreadBps(band.maxLeverage + 1e-9), `just above ${band.maxLeverage}`).toBe(next);
    });
    expect(leverageSpreadBps(1e9)).toBe(LEVERAGE_SPREAD_MAX_BPS);
  });

  it('prices on the lifetime cost per passing the HUD shows, null while nothing is passed', () => {
    const state = makeTestState();
    state.finance.capex.osp = 50_000;
    expect(pricingCpp(state)).toBeNull();
    addLivePlant(state);
    const passings = getService(state).passings;
    expect(passings).toBeGreaterThan(0);
    expect(pricingCpp(state)).toBe(50_000 / passings);
  });

  it('adds base, leverage, CPP and product, with the stage\'s penalty on top', () => {
    const products = [{ kind: 'line' as const }, ...TERM_LOAN_YEARS.map((years) => ({ kind: 'term' as const, years }))];
    const cpps = [null, 0, CPP_TARGET, CPP_TARGET + 1, CPP_TARGET * CPP_AMBER_MULTIPLIER, CPP_TARGET * CPP_AMBER_MULTIPLIER + 1];
    const stages: CovenantStage[] = ['compliant', 'warning', 'penalty', 'frozen'];
    for (const product of products) {
      for (const cpp of cpps) {
        for (const stage of stages) {
          for (const leverage of [0, 2.5, null]) {
            const productBps = product.kind === 'line' ? CREDIT_LINE_EXTRA_BPS : TERM_EXTRA_BPS[product.years];
            const cppBps = cpp === null ? 0 : CPP_SPREAD_BPS[cppBand(cpp)];
            const rateBps = BASE_RATE_BPS + leverageSpreadBps(leverage) + cppBps + productBps;
            expect(priceRate(product, leverage, cpp, stage)).toEqual({
              baseBps: BASE_RATE_BPS,
              leverageBps: leverageSpreadBps(leverage),
              cppBps,
              productBps,
              penaltyBps: penaltyBps(stage),
              rateBps,
              effectiveRateBps: rateBps + penaltyBps(stage),
              leverage,
              cpp,
              cppBand: cpp === null ? null : cppBand(cpp),
            });
          }
        }
      }
    }
    // Efficient builds get cheaper money: green, amber, red.
    expect(priceRate({ kind: 'line' }, 0, CPP_TARGET, 'compliant').cppBps).toBe(CPP_SPREAD_BPS.green);
    expect(priceRate({ kind: 'line' }, 0, CPP_TARGET + 1, 'compliant').cppBps).toBe(CPP_SPREAD_BPS.amber);
    expect(priceRate({ kind: 'line' }, 0, CPP_TARGET * CPP_AMBER_MULTIPLIER + 1, 'compliant').cppBps).toBe(CPP_SPREAD_BPS.red);
  });

  it('formats rates and multiples with whole-number arithmetic', () => {
    expect(formatRateBps(725)).toBe('7.25%');
    expect(formatRateBps(500)).toBe('5.00%');
    expect(formatRateBps(5)).toBe('0.05%');
    expect(formatMultiple(4.123)).toBe('4.12\u00d7');
    expect(formatMultiple(5)).toBe('5.00\u00d7');
    expect(formatMultiple(-0.5)).toBe('-0.50\u00d7');
  });
});

/** What is still owed after `months` payments of `payment` on an exact (unrounded) schedule. */
function owedAfter(amount: number, rateBps: number, months: number, payment: number): number {
  const r = rateBps / 120_000;
  let balance = amount;
  for (let m = 0; m < months; m++) balance = balance * (1 + r) - payment;
  return balance;
}

/** The schedule rule written out on its own: interest rounds on the balance, principal fills the payment, the last payment takes the rest. */
function scheduleRule(amount: number, rateBps: number, months: number, payment: number) {
  const rows: Array<{ interest: number; principal: number; balance: number }> = [];
  let balance = amount;
  for (let m = 0; m < months; m++) {
    const interest = Math.round((balance * rateBps) / 120_000);
    const principal = m === months - 1 ? balance : Math.max(0, Math.min(balance, payment - interest));
    balance -= principal;
    rows.push({ interest, principal, balance });
  }
  return rows;
}

const LOANS: Array<[number, number, number]> = [
  [TERM_LOAN_MIN, BASE_RATE_BPS, 60],
  [TERM_LOAN_MIN * 37, BASE_RATE_BPS + LEVERAGE_SPREAD_MAX_BPS + PENALTY_STEP_UP_BPS, 84],
  [123_457, 1_234, 7],
  [1, BASE_RATE_BPS, 60],
  [999_999, 1, 12],
  [50_000, 9_999, 1],
  [77_777, 0, 13],
];

describe('levelPayment', () => {
  it('is the smallest whole-dollar payment that repays the loan on time', () => {
    for (const [amount, rateBps, months] of LOANS) {
      const payment = levelPayment(amount, rateBps, months);
      expect(Number.isInteger(payment)).toBe(true);
      expect(payment).toBeGreaterThanOrEqual(1);
      expect(owedAfter(amount, rateBps, months, payment), `${amount} at ${rateBps} over ${months}`).toBeLessThanOrEqual(1e-6 * amount);
      if (payment > 1) expect(owedAfter(amount, rateBps, months, payment - 1)).toBeGreaterThan(0);
    }
  });

  it('splits evenly at a zero rate and adds a month of interest to a one-month loan', () => {
    expect(levelPayment(10_001, 0, 10)).toBe(Math.ceil(10_001 / 10));
    expect(levelPayment(60_000, 0, 60)).toBe(60_000 / 60);
    expect(levelPayment(50_000, BASE_RATE_BPS, 1)).toBe(Math.ceil(50_000 + (50_000 * BASE_RATE_BPS) / 120_000));
  });

  it('never throws or returns a fraction for odd input', () => {
    expect(levelPayment(0, BASE_RATE_BPS, 60)).toBe(0);
    expect(levelPayment(-5, BASE_RATE_BPS, 60)).toBe(0);
    expect(levelPayment(Number.NaN, BASE_RATE_BPS, 60)).toBe(0);
    expect(levelPayment(1_000, BASE_RATE_BPS, 0)).toBe(levelPayment(1_000, BASE_RATE_BPS, 1));
    expect(levelPayment(1_000, BASE_RATE_BPS, Number.NaN)).toBe(levelPayment(1_000, BASE_RATE_BPS, 1));
    expect(levelPayment(1_000, Number.NaN, 10)).toBe(100);
    // The largest balance, rate and term a save may carry: still a whole number.
    const huge = levelPayment(1e12, 100_000, 1_200);
    expect(Number.isInteger(huge)).toBe(true);
    expect(huge).toBeGreaterThanOrEqual(Math.ceil((1e12 * 100_000) / 120_000));
  });
});

describe('amortize', () => {
  it('follows the schedule rule, principal summing exactly to the amount', () => {
    for (const [amount, rateBps, months] of LOANS) {
      const payment = levelPayment(amount, rateBps, months);
      const rows = amortize(amount, rateBps, months, payment);
      expect(rows).toEqual(scheduleRule(amount, rateBps, months, payment));
      expect(rows).toHaveLength(months);
      expect(rows.reduce((sum, r) => sum + r.principal, 0)).toBe(amount);
      expect(rows.at(-1)!.balance).toBe(0);
      expect(rows.every((r) => Number.isInteger(r.interest) && r.interest >= 0 && r.principal >= 0)).toBe(true);
      // Every regular payment is the level payment until the loan is repaid; the last takes the remainder.
      rows.slice(0, -1).forEach((row, i) => {
        const before = i === 0 ? amount : rows[i - 1]!.balance;
        if (row.balance > 0) expect(row.interest + row.principal).toBe(payment);
        else expect(row.principal).toBe(before);
      });
    }
  });

  it('charges no interest at a zero rate', () => {
    const rows = amortize(10_001, 0, 10, levelPayment(10_001, 0, 10));
    expect(rows.every((r) => r.interest === 0)).toBe(true);
    expect(rows.at(-1)!.principal).toBe(10_001 - 9 * Math.ceil(10_001 / 10));
  });

  it('repays a one-month loan in one payment, and stops once an oversized payment has repaid it', () => {
    expect(amortize(50_000, BASE_RATE_BPS, 1, 1)).toEqual([
      { interest: Math.round((50_000 * BASE_RATE_BPS) / 120_000), principal: 50_000, balance: 0 },
    ]);
    const rows = amortize(10_000, BASE_RATE_BPS, 6, 6_000);
    expect(rows[1]!.balance).toBe(0);
    expect(rows.slice(2)).toEqual(Array.from({ length: 4 }, () => ({ interest: 0, principal: 0, balance: 0 })));
    expect(amortize(10_000, BASE_RATE_BPS, 0, 100)).toEqual([]);
  });
});

describe('stubDays', () => {
  it('counts the days a balance is held to the month end, both ends included', () => {
    const at = (month: number, day: number, year = 2027) => stubDays(dayOf({ year, month, day }));
    expect(stubDays(0)).toBe(MONTH_LENGTHS[0]);
    expect(at(1, 31)).toBe(1);
    expect(at(2, 1)).toBe(MONTH_LENGTHS[1]);
    expect(at(2, 28)).toBe(1);
    expect(at(4, 10)).toBe(MONTH_LENGTHS[3]! - 9);
    expect(at(12, 31)).toBe(1);
    expect(at(1, 1, 2028)).toBe(MONTH_LENGTHS[0]);
  });
});

describe('termCapacity', () => {
  it('is nothing before there is recurring revenue', () => {
    expect(termCapacity(makeTestState())).toBe(0);
  });

  it('lends a multiple of ARR less the term loans owed, rounded down', () => {
    const state = trading();
    const room = trailingArr(state) * TERM_CAPACITY_ARR_MULTIPLE;
    const full = Math.floor(room / LOAN_ROUNDING) * LOAN_ROUNDING;
    expect(full).toBeGreaterThanOrEqual(TERM_LOAN_MIN);
    expect(termCapacity(state)).toBe(full);
    state.debt.loans = [makeLoan({ balance: 12_345 })];
    const less = Math.floor((room - 12_345) / LOAN_ROUNDING) * LOAN_ROUNDING;
    expect(termCapacity(state)).toBe(less);
    // The credit line has its own limit.
    state.debt.credit.balance = 30_000;
    expect(termCapacity(state)).toBe(less);
    state.debt.covenant.stage = 'penalty';
    expect(termCapacity(state)).toBe(less);
  });

  it('is nothing below the smallest loan, and nothing while frozen', () => {
    expect(TERM_LOAN_MIN % LOAN_ROUNDING).toBe(0);
    const state = trading();
    const room = Math.floor(trailingArr(state) * TERM_CAPACITY_ARR_MULTIPLE);
    state.debt.loans = [makeLoan({ balance: room - TERM_LOAN_MIN })];
    expect(termCapacity(state)).toBe(TERM_LOAN_MIN);
    state.debt.loans[0]!.balance += 1;
    expect(termCapacity(state)).toBe(0);
    state.debt.loans = [];
    state.debt.covenant.stage = 'frozen';
    expect(termCapacity(state)).toBe(0);
  });
});

describe('creditOffer', () => {
  it('offers nothing before there is recurring revenue, and says why', () => {
    const offer = creditOffer(makeTestState());
    expect(offer).toMatchObject({ limit: 0, balance: 0, available: 0, maxRepay: 0, frozen: false, accruedInterest: 0, arr: 0 });
    expect(offer.reasons).toHaveLength(1);
    expect(offer.reasons[0]).toMatch(/^No credit line yet: the bank lends against recurring revenue, so sign up subscribers first/);
    expect(offer.reasons[0]).toContain(`${CREDIT_LIMIT_ARR_MULTIPLE}\u00d7`);
    // Before any close, the line is priced as newDebt priced it.
    expect(offer.rate).toEqual({ ...newDebt().credit.rate, penaltyBps: 0, rateBps: rateOf(newDebt().credit.rate), effectiveRateBps: rateOf(newDebt().credit.rate), leverage: 0, cpp: null, cppBand: null });
  });

  it('offers the limit less the balance, repayments up to cash, and the line\'s rate with today\'s penalty', () => {
    const state = trading();
    const limit = creditLimit(state);
    expect(limit).toBeGreaterThan(10_000);
    state.debt.credit.balance = 10_000;
    state.debt.credit.balanceDollarDays = 10_000 * 9;
    state.finance.cash = 4_000;
    const offer = creditOffer(state);
    expect(offer).toMatchObject({ limit, balance: 10_000, available: limit - 10_000, maxRepay: 4_000, frozen: false, arr: trailingArr(state), reasons: [] });
    const rate = rateOf(state.debt.credit.rate);
    expect(offer.rate).toEqual({ ...state.debt.credit.rate, penaltyBps: 0, rateBps: rate, effectiveRateBps: rate, leverage: 0, cpp: null, cppBand: null });
    expect(offer.accruedInterest).toBe(Math.round((10_000 * 9 * rate) / DAY_DIVISOR));
    state.finance.cash = -50;
    expect(creditOffer(state).maxRepay).toBe(0);
    state.finance.cash = 1e7;
    expect(creditOffer(state).maxRepay).toBe(10_000);

    state.debt.covenant.stage = 'penalty';
    const penalized = creditOffer(state);
    expect(penalized.rate).toMatchObject({ penaltyBps: PENALTY_STEP_UP_BPS, rateBps: rate, effectiveRateBps: rate + PENALTY_STEP_UP_BPS });
    expect(penalized.accruedInterest).toBe(Math.round((10_000 * 9 * (rate + PENALTY_STEP_UP_BPS)) / DAY_DIVISOR));
    expect(penalized.available).toBe(limit - 10_000);
  });

  it('shows the leverage and cost per passing the last close priced the line on', () => {
    const state = trading();
    const last = state.finance.reports.at(-1)!;
    last.passings = 400;
    last.stats = { ...ZERO_STATS, capexOsp: 600_000 };
    last.debt = {
      creditBalance: 1,
      termBalance: 0,
      creditLimit: 0,
      arr: 0,
      annualOperatingCashFlow: 0,
      annualDebtService: 0,
      leverageX100: 312,
      coverageX100: null,
      stage: 'compliant',
      averageRateBps: null,
      missedPayment: false,
    };
    let offer = creditOffer(state);
    expect(offer.rate.leverage).toBe(3.12);
    expect(offer.rate.cpp).toBe(600_000 / 400);
    expect(offer.rate.cppBand).toBe(cppBand(600_000 / 400));
    last.debt.leverageX100 = null;
    last.passings = 0;
    offer = creditOffer(state);
    expect(offer.rate.leverage).toBeNull();
    expect(offer.rate.cpp).toBeNull();
    expect(offer.rate.cppBand).toBeNull();
  });

  it('explains a frozen, a full and an over-limit line', () => {
    const frozen = trading();
    frozen.debt.covenant.stage = 'frozen';
    frozen.debt.credit.balance = 1_000;
    const f = creditOffer(frozen);
    expect(f).toMatchObject({ frozen: true, available: 0 });
    expect(f.reasons).toHaveLength(1);
    expect(f.reasons[0]).toMatch(/frozen/);
    expect(f.reasons[0]).toContain(`${COVENANT_CURE_CLOSES} month close`);
    expect(f.reasons[0]).toContain(formatMultiple(COVENANT_MAX_LEVERAGE));
    expect(f.reasons[0]).toContain(formatMultiple(COVENANT_MIN_COVERAGE));

    const full = trading();
    full.debt.credit.balance = creditLimit(full);
    expect(creditOffer(full).reasons).toEqual([expect.stringMatching(/fully drawn/)]);
    full.debt.credit.balance += 5;
    expect(creditOffer(full).reasons).toEqual([expect.stringMatching(/over its limit/)]);
  });
});

describe('quoteTermLoan', () => {
  it('writes a loan within capacity, priced on pro forma leverage and today\'s CPP', () => {
    const state = trading(REVENUE / 2);
    addLivePlant(state);
    // Lifetime CPP at the top of the amber band.
    state.finance.capex.osp = Math.floor(getService(state).passings * CPP_TARGET * CPP_AMBER_MULTIPLIER);
    state.debt.credit.balance = 20_000;
    const amount = TERM_LOAN_MIN * 4;
    for (const years of TERM_LOAN_YEARS) {
      const q = quoteTermLoan(state, amount, years);
      const before = covenantMetrics(state);
      const leverage = (before.totalDebt + amount) / before.underwritingCashFlow;
      const rate = priceRate({ kind: 'term', years }, leverage, pricingCpp(state), 'compliant');
      const months = years * 12;
      const payment = levelPayment(amount, rate.rateBps, months);
      const rows = amortize(amount, rate.rateBps, months, payment);
      const stub = Math.round((amount * stubDays(state.day) * rate.effectiveRateBps) / DAY_DIVISOR);
      const after = covenantMetrics(state, { addDebt: amount, addAnnualDebtService: payment * Math.min(12, months) });
      expect(q).toEqual({
        ok: true,
        reasons: [],
        amount,
        termYears: years,
        termMonths: months,
        maxAmount: termCapacity(state),
        rate,
        payment,
        lastPayment: rows.at(-1)!.interest + rows.at(-1)!.principal,
        stubInterest: stub,
        totalInterest: stub + rows.reduce((sum, r) => sum + r.interest, 0),
        before,
        after,
        breachesCovenant: !after.compliant,
        cashAfter: state.finance.cash + amount,
      });
      expect(q.rate.cppBand).toBe('amber');
      expect(q.rate.cppBps).toBe(CPP_SPREAD_BPS.amber);
      expect(q.stubInterest).toBeGreaterThan(0);
    }
    // A pure read.
    expect(state.debt.loans).toEqual([]);
  });

  it('fixes the rate without the penalty, which it charges on the stub', () => {
    const state = trading();
    state.debt.covenant.stage = 'penalty';
    const q = quoteTermLoan(state, TERM_LOAN_MIN, 5);
    expect(q.rate.penaltyBps).toBe(PENALTY_STEP_UP_BPS);
    expect(q.rate.effectiveRateBps).toBe(q.rate.rateBps + PENALTY_STEP_UP_BPS);
    // The level payment repays it at the rate charged while the penalty lasts (re-set when it lifts).
    expect(q.payment).toBe(levelPayment(TERM_LOAN_MIN, q.rate.effectiveRateBps, 60));
    expect(q.stubInterest).toBe(Math.round((TERM_LOAN_MIN * stubDays(state.day) * q.rate.effectiveRateBps) / DAY_DIVISOR));
  });

  it('lists every blocker and never throws for junk', () => {
    const terms = `Term must be ${TERM_LOAN_YEARS.join(' or ')} years`;
    const fresh = quoteTermLoan(makeTestState(), TERM_LOAN_MIN, 5);
    expect(fresh.ok).toBe(false);
    expect(fresh.maxAmount).toBe(0);
    expect(fresh.reasons).toEqual([expect.stringMatching(new RegExp(`^No term loans yet: the bank lends up to ${TERM_CAPACITY_ARR_MULTIPLE}\u00d7`))]);

    const state = trading();
    const capacity = termCapacity(state);
    const unknown = quoteTermLoan(state, TERM_LOAN_MIN, 6 as TermYears);
    expect(unknown).toMatchObject({ ok: false, reasons: [terms], termMonths: 0, payment: 0, lastPayment: 0 });
    for (const years of ['5', 'constructor', null, Number.NaN, 5.5]) {
      const q = quoteTermLoan(state, TERM_LOAN_MIN, years as never);
      expect(q.reasons).toEqual([terms]);
      expect(Number.isInteger(q.rate.rateBps)).toBe(true);
      expect(q.rate.productBps).toBe(0);
    }
    for (const amount of JUNK_AMOUNTS) {
      const q = quoteTermLoan(state, amount as number, 7);
      expect(q.ok, String(amount)).toBe(false);
      expect(q.reasons).toEqual([expect.stringMatching(/^A term loan must be a whole number of dollars/)]);
      expect(q.payment).toBe(0);
      expect(Number.isFinite(q.totalInterest)).toBe(true);
      expect(Number.isFinite(q.cashAfter)).toBe(true);
    }
    expect(quoteTermLoan(state, TERM_LOAN_MIN - 1, 5).reasons).toEqual([`The smallest term loan is ${formatMoney(TERM_LOAN_MIN)}`]);
    // Below the minimum still quotes a payment, so the player sees the cost.
    expect(quoteTermLoan(state, TERM_LOAN_MIN - 1, 5).payment).toBeGreaterThan(0);
    const over = quoteTermLoan(state, capacity + LOAN_ROUNDING, 5);
    expect(over.reasons).toEqual([expect.stringMatching(re(`The most the bank will lend now is ${formatMoney(capacity)}`))]);
    expect(over.reasons[0]).toContain(formatMoney(trailingArr(state)));
    expect(quoteTermLoan(state, capacity, 5).ok).toBe(true);
    // Several blockers at once.
    expect(quoteTermLoan(state, 1.5, 6 as TermYears).reasons).toHaveLength(2);

    const frozen = trading();
    frozen.debt.covenant.stage = 'frozen';
    const fq = quoteTermLoan(frozen, TERM_LOAN_MIN, 5);
    expect(fq).toMatchObject({ ok: false, maxAmount: 0 });
    expect(fq.reasons).toEqual([expect.stringMatching(/frozen/)]);

    const over2 = trading();
    over2.gameOver = { day: over2.day, reason: 'insolvent', message: 'x' };
    expect(quoteTermLoan(over2, TERM_LOAN_MIN, 5).reasons).toEqual(['The game is over']);

    // Used up: room left below the smallest loan.
    const used = trading();
    used.debt.loans = [makeLoan({ balance: Math.floor(trailingArr(used) * TERM_CAPACITY_ARR_MULTIPLE) })];
    expect(quoteTermLoan(used, TERM_LOAN_MIN, 5).reasons).toEqual([expect.stringMatching(/^No term-loan room left/)]);
  });

  it('warns of a covenant breach without blocking the loan', () => {
    const state = trading();
    const uw = covenantMetrics(state).underwritingCashFlow;
    state.debt.credit.balance = uw * COVENANT_MAX_LEVERAGE;
    const q = quoteTermLoan(state, TERM_LOAN_MIN, 5);
    expect(q.before.leverageOk).toBe(true);
    expect(q.after.leverageOk).toBe(false);
    expect(q.breachesCovenant).toBe(true);
    expect(q.ok).toBe(true);
    expect(okCost(takeTermLoan(state, TERM_LOAN_MIN, 5))).toBe(-TERM_LOAN_MIN);
  });

  it('prices unmeasurable pro forma leverage at the top spread', () => {
    const state = makeTradingState(0, 1_000);
    expect(quoteTermLoan(state, TERM_LOAN_MIN, 5).rate.leverage).toBeNull();
    expect(quoteTermLoan(state, TERM_LOAN_MIN, 5).rate.leverageBps).toBe(LEVERAGE_SPREAD_MAX_BPS);
  });
});

describe('quotePrepay', () => {
  function withLoans(): GameState {
    const state = trading();
    state.debt.loans = [
      makeLoan({ id: 1, originatedDay: 0 }),
      makeLoan({ id: 2, originatedDay: state.day - 3, rateBps: BASE_RATE_BPS + 250 }),
      makeLoan({ id: 3, originatedDay: state.day }),
    ];
    state.debt.nextLoanId = 4;
    state.finance.cash = 1e7;
    return state;
  }

  it('charges interest accrued since the later of origination and the 1st of the month', () => {
    const state = withLoans();
    const amount = 10_000;
    const days = [state.day - monthStartOf(state), 3, 0];
    state.debt.loans.forEach((loan, i) => {
      const q = quotePrepay(state, loan.id, amount);
      const accrued = Math.round((amount * days[i]! * loan.rateBps) / DAY_DIVISOR);
      expect(q).toEqual({
        ok: true,
        reasons: [],
        loan: loan.id,
        amount,
        accruedInterest: accrued,
        total: amount + accrued,
        paysOff: false,
        paymentAfter: levelPayment(loan.balance - amount, loan.rateBps, loan.monthsLeft),
      });
    });
    expect(quotePrepay(state, 1, amount).accruedInterest).toBeGreaterThan(0);
    // The penalty is charged on accrued interest too.
    state.debt.covenant.stage = 'frozen';
    const loan = state.debt.loans[0]!;
    expect(quotePrepay(state, 1, amount).accruedInterest).toBe(Math.round((amount * days[0]! * (loan.rateBps + PENALTY_STEP_UP_BPS)) / DAY_DIVISOR));
    expect(quotePrepay(state, 1, amount).ok).toBe(true);
    // Paying the whole balance closes the loan.
    expect(quotePrepay(state, 1, loan.balance)).toMatchObject({ ok: true, paysOff: true, paymentAfter: 0 });
  });

  it('rejects an unknown loan, odd amounts, more than is owed and too little cash', () => {
    const state = withLoans();
    expect(quotePrepay(state, 99, 1_000).reasons).toEqual(['There is no open term loan #99']);
    for (const amount of JUNK_AMOUNTS) {
      const q = quotePrepay(state, 1, amount as number);
      expect(q.ok).toBe(false);
      expect(q.reasons).toEqual([expect.stringMatching(/^A prepayment must be a whole number of dollars/)]);
      expect(Number.isFinite(q.accruedInterest)).toBe(true);
    }
    const loan = state.debt.loans[0]!;
    expect(quotePrepay(state, 1, loan.balance + 1).reasons).toEqual([`Loan #1 has only ${formatMoney(loan.balance)} left to repay`]);
    const q = quotePrepay(state, 1, 10_000);
    state.finance.cash = q.total - 1;
    expect(quotePrepay(state, 1, 10_000).reasons).toEqual([
      `Not enough cash: need ${formatMoney(q.total)} (${formatMoney(10_000)} plus ${formatMoney(q.accruedInterest)} of accrued interest), have ${formatMoney(q.total - 1)}`,
    ]);
    state.finance.cash = q.total;
    expect(quotePrepay(state, 1, 10_000).ok).toBe(true);
  });
});

describe('estimateNextDebtService', () => {
  it('is nothing with no debt', () => {
    expect(estimateNextDebtService(trading())).toBe(0);
  });

  it('adds the line\'s interest to month end and each loan\'s stub, regular or last payment', () => {
    const state = trading();
    const start = monthStartOf(state);
    state.debt.credit.balance = 30_000;
    state.debt.credit.balanceDollarDays = 30_000 * (state.day - start);
    const regular = makeLoan({ id: 1, originatedDay: 0 });
    const stub = makeLoan({ id: 2, originatedDay: state.day - 2 });
    const last = makeLoan({ id: 3, originatedDay: 0, monthsLeft: 1, balance: 5_432, principal: 60_000 });
    state.debt.loans = [regular, stub, last];
    state.debt.covenant.stage = 'penalty';
    const p = PENALTY_STEP_UP_BPS;
    const line = Math.round(((30_000 * (state.day - start) + 30_000 * stubDays(state.day)) * (rateOf(state.debt.credit.rate) + p)) / DAY_DIVISOR);
    const regularInterest = Math.round((regular.balance * (regular.rateBps + p)) / 120_000);
    const regularPayment = regularInterest + Math.min(regular.balance, Math.max(0, regular.payment - regularInterest));
    const stubInterest = Math.round((stub.balance * stubDays(stub.originatedDay) * (stub.rateBps + p)) / DAY_DIVISOR);
    const lastPayment = last.balance + Math.round((last.balance * (last.rateBps + p)) / 120_000);
    expect(estimateNextDebtService(state)).toBe(line + regularPayment + stubInterest + lastPayment);
  });
});

describe('drawCredit', () => {
  it('draws up to what is available, as loan proceeds', () => {
    const state = trading();
    const available = creditAvailable(state);
    const cash = state.finance.cash;
    expect(okCost(drawCredit(state, 7_000))).toBe(-7_000);
    expect(state.finance.cash).toBe(cash + 7_000);
    expect(state.debt.credit.balance).toBe(7_000);
    expect(state.finance.monthToDate).toEqual([{ day: state.day, category: 'loanProceeds', amount: 7_000, memo: 'Credit line draw' }]);
    expect(okCost(drawCredit(state, available - 7_000))).toBe(7_000 - available);
    expect(creditAvailable(state)).toBe(0);
    expect(state.finance.cash).toBe(cash + available);
    // Debt never touches capex: CPP is unaffected.
    expect(state.finance.capex).toEqual({ osp: 0, connect: 0, co: 0 });
    // The day's balance accrues at the end of the day, not on the draw.
    expect(state.debt.credit.balanceDollarDays).toBe(0);
  });

  it('rejects odd amounts, a frozen line, no line yet and more than is available, changing nothing', () => {
    const state = trading();
    for (const amount of JUNK_AMOUNTS) expectRejected(state, (s) => drawCredit(s, amount as number), /^A credit line draw must be a whole number of dollars/);
    expectRejected(makeTestState(), (s) => drawCredit(s, 1_000), /^No credit line yet: the bank lends against recurring revenue/);
    const available = creditAvailable(state);
    expectRejected(state, (s) => drawCredit(s, available + 1), re(`Only ${formatMoney(available)} is available on the credit line`));
    const frozen = trading();
    frozen.debt.covenant.stage = 'frozen';
    expectRejected(frozen, (s) => drawCredit(s, 1_000), /^Your credit line is frozen/);
    const full = trading();
    full.debt.credit.balance = creditLimit(full);
    expectRejected(full, (s) => drawCredit(s, 1), /fully drawn/);
  });
});

describe('repayCredit', () => {
  it('repays from cash as principal, frozen or not', () => {
    const state = trading();
    okCost(drawCredit(state, 20_000));
    const cash = state.finance.cash;
    expect(okCost(repayCredit(state, 5_000))).toBe(5_000);
    expect(state.finance.cash).toBe(cash - 5_000);
    expect(state.debt.credit.balance).toBe(15_000);
    expect(state.finance.monthToDate.at(-1)).toEqual({ day: state.day, category: 'principal', amount: -5_000, memo: 'Credit line repayment' });
    state.debt.covenant.stage = 'frozen';
    expect(okCost(repayCredit(state, 15_000))).toBe(15_000);
    expect(state.debt.credit.balance).toBe(0);
  });

  it('rejects odd amounts, nothing drawn, more than is drawn and more than cash, changing nothing', () => {
    const state = trading();
    expectRejected(state, (s) => repayCredit(s, 100), /^Nothing is drawn on the credit line/);
    okCost(drawCredit(state, 8_000));
    for (const amount of JUNK_AMOUNTS) expectRejected(state, (s) => repayCredit(s, amount as number), /^A credit line repayment must be a whole number/);
    expectRejected(state, (s) => repayCredit(s, 8_001), re(`Only ${formatMoney(8_000)} is drawn on the credit line`));
    state.finance.cash = 7_999;
    expectRejected(state, (s) => repayCredit(s, 8_000), re(`Not enough cash: need ${formatMoney(8_000)}, have ${formatMoney(7_999)}`));
  });
});

describe('takeTermLoan', () => {
  it('books the quoted loan with the next id and the proceeds', () => {
    const state = trading();
    const cash = state.finance.cash;
    const q = quoteTermLoan(state, TERM_LOAN_MIN * 3, 7);
    expect(okCost(takeTermLoan(state, TERM_LOAN_MIN * 3, 7))).toBe(-TERM_LOAN_MIN * 3);
    expect(state.finance.cash).toBe(cash + TERM_LOAN_MIN * 3);
    expect(state.debt.loans).toEqual([
      {
        id: 1,
        principal: TERM_LOAN_MIN * 3,
        balance: TERM_LOAN_MIN * 3,
        rateBps: q.rate.rateBps,
        termMonths: 84,
        payment: q.payment,
        monthsLeft: 84,
        originatedDay: state.day,
      },
    ]);
    expect(state.debt.nextLoanId).toBe(2);
    expect(state.finance.monthToDate).toEqual([
      { day: state.day, category: 'loanProceeds', amount: TERM_LOAN_MIN * 3, memo: `Term loan #1: 7 years at ${formatRateBps(q.rate.rateBps)}` },
    ]);
    // The second loan is priced on the leverage the first one added.
    const q2 = quoteTermLoan(state, TERM_LOAN_MIN, 5);
    expect(okCost(takeTermLoan(state, TERM_LOAN_MIN, 5))).toBe(-TERM_LOAN_MIN);
    expect(state.debt.loans.map((l) => [l.id, l.termMonths, l.rateBps])).toEqual([
      [1, 84, q.rate.rateBps],
      [2, 60, q2.rate.rateBps],
    ]);
    expect(state.debt.nextLoanId).toBe(3);
    expect(state.finance.capex).toEqual({ osp: 0, connect: 0, co: 0 });
  });

  it('rejects with the quote\'s first reason, changing nothing', () => {
    const state = trading();
    expectRejected(state, (s) => takeTermLoan(s, TERM_LOAN_MIN, 6 as TermYears), re(`Term must be ${TERM_LOAN_YEARS.join(' or ')} years`));
    for (const amount of JUNK_AMOUNTS) expectRejected(state, (s) => takeTermLoan(s, amount as number, 5), /^A term loan must be a whole number of dollars/);
    expectRejected(state, (s) => takeTermLoan(s, TERM_LOAN_MIN - 1, 5), re(`The smallest term loan is ${formatMoney(TERM_LOAN_MIN)}`));
    expectRejected(state, (s) => takeTermLoan(s, termCapacity(s) + 1, 5), re(`The most the bank will lend now is ${formatMoney(termCapacity(state))}`));
    expectRejected(makeTestState(), (s) => takeTermLoan(s, TERM_LOAN_MIN, 5), /^No term loans yet/);
    const frozen = trading();
    frozen.debt.covenant.stage = 'frozen';
    expectRejected(frozen, (s) => takeTermLoan(s, TERM_LOAN_MIN, 5), /^Your credit line is frozen/);
  });
});

describe('prepayLoan', () => {
  function borrowed(): GameState {
    const state = trading();
    okCost(takeTermLoan(state, TERM_LOAN_MIN * 5, 5));
    okCost(takeTermLoan(state, TERM_LOAN_MIN, 7));
    state.day += 6;
    state.finance.monthToDate = [];
    return state;
  }

  it('pays principal plus accrued interest and re-amortizes the rest over the same months', () => {
    const state = borrowed();
    const loan = structuredClone(state.debt.loans[0]!);
    const q = quotePrepay(state, 1, TERM_LOAN_MIN);
    expect(q.accruedInterest).toBeGreaterThan(0);
    const cash = state.finance.cash;
    const cost = okCost(prepayLoan(state, 1, TERM_LOAN_MIN));
    expect(cost).toBe(TERM_LOAN_MIN + q.accruedInterest);
    expect(cash - state.finance.cash).toBe(cost);
    expect(state.finance.monthToDate).toEqual([
      { day: state.day, category: 'interest', amount: -q.accruedInterest, memo: 'Accrued interest, loan #1' },
      { day: state.day, category: 'principal', amount: -TERM_LOAN_MIN, memo: 'Prepayment, loan #1' },
    ]);
    expect(state.debt.loans[0]).toEqual({ ...loan, balance: loan.balance - TERM_LOAN_MIN, payment: q.paymentAfter });
    expect(q.paymentAfter).toBeLessThan(loan.payment);
  });

  it('closes a loan paid in full, frozen or not, and posts no interest on the day it was taken', () => {
    const state = borrowed();
    state.debt.covenant.stage = 'frozen';
    const balance = state.debt.loans[1]!.balance;
    const q = quotePrepay(state, 2, balance);
    expect(okCost(prepayLoan(state, 2, balance))).toBe(balance + q.accruedInterest);
    expect(state.debt.loans.map((l) => l.id)).toEqual([1]);

    const same = trading();
    okCost(takeTermLoan(same, TERM_LOAN_MIN, 5));
    same.finance.monthToDate = [];
    expect(okCost(prepayLoan(same, 1, TERM_LOAN_MIN))).toBe(TERM_LOAN_MIN);
    expect(same.finance.monthToDate.map((e) => e.category)).toEqual(['principal']);
    expect(same.debt.loans).toEqual([]);
    expect(same.debt.nextLoanId).toBe(2);
  });

  it('rejects an unknown loan, odd amounts, more than is owed and too little cash, changing nothing', () => {
    const state = borrowed();
    expectRejected(state, (s) => prepayLoan(s, 7, 1_000), /^There is no open term loan #7/);
    expectRejected(state, (s) => prepayLoan(s, Number.NaN, 1_000), /^There is no open term loan #NaN/);
    for (const amount of JUNK_AMOUNTS) expectRejected(state, (s) => prepayLoan(s, 1, amount as number), /^A prepayment must be a whole number/);
    expectRejected(state, (s) => prepayLoan(s, 2, TERM_LOAN_MIN + 1), re(`Loan #2 has only ${formatMoney(TERM_LOAN_MIN)} left to repay`));
    state.finance.cash = TERM_LOAN_MIN;
    expectRejected(state, (s) => prepayLoan(s, 2, TERM_LOAN_MIN), /^Not enough cash: need/);
  });
});

describe('endDebtDay', () => {
  it('adds the end-of-day balance to the dollar-days', () => {
    const state = trading();
    state.debt.credit.balance = 12_000;
    endDebtDay(state);
    endDebtDay(state);
    expect(state.debt.credit.balanceDollarDays).toBe(24_000);
    expect(state.notices).toEqual([]);
  });

  /** Run endDebtDay over the rest of the month; the days a notice was posted, with the estimate taken that morning. */
  function remindersThroughMonth(state: GameState): Array<{ day: number; estimate: number; message: string }> {
    const posted: Array<{ day: number; estimate: number; message: string }> = [];
    const close = nextCloseDay(state);
    for (let day = state.day; day < close; day++) {
      state.day = day;
      const estimate = estimateNextDebtService(state);
      const before = state.notices.length;
      endDebtDay(state);
      for (const n of state.notices.slice(before)) {
        expect(n.kind).toBe('paymentDue');
        posted.push({ day, estimate, message: n.message });
      }
    }
    return posted;
  }

  it('reminds once, PAYMENT_REMINDER_DAYS before a close, when the cash projected at the close is short of the payments due', () => {
    const state = trading();
    state.debt.loans = [makeLoan({ originatedDay: 0 })];
    state.debt.nextLoanId = 2;
    state.finance.cash = 0;
    const close = nextCloseDay(state);
    const probe = structuredClone(state);
    probe.day = close - PAYMENT_REMINDER_DAYS;
    const atClose = estimateCashAtClose(probe);
    const posted = remindersThroughMonth(state);
    expect(posted.map((p) => p.day)).toEqual([close - PAYMENT_REMINDER_DAYS]);
    const date = dateOf(close);
    const due = posted[0]!.estimate;
    expect(posted[0]!.message).toBe(
      `Loan payments of about ${formatMoney(due)} are due at the ${MONTH_ABBR[date.month - 1]} 1 close, ` +
        `and after this month's billing and running costs cash is projected at about ${formatMoney(atClose)} then ($0 today), ` +
        `${formatMoney(due - atClose)} short: draw on the credit line or raise cash before then, or the payment is missed: a late fee and a frozen credit line.`,
    );
  });

  it('warns of a default while frozen, and counts today\'s balance once', () => {
    const state = trading();
    state.debt.covenant.stage = 'frozen';
    state.debt.credit.balance = 50_000;
    state.debt.credit.balanceDollarDays = 50_000 * (state.day - monthStartOf(state));
    state.finance.cash = 10;
    const posted = remindersThroughMonth(state);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.message).toMatch(/raise cash before then \(the credit line has nothing to draw\), or it is a default/);
    // The estimate that morning was the whole month's interest at the end-of-day balance.
    const effective = rateOf(state.debt.credit.rate) + PENALTY_STEP_UP_BPS;
    const days = MONTH_LENGTHS[dateOf(posted[0]!.day).month - 1]!;
    expect(posted[0]!.estimate).toBe(Math.round((50_000 * days * effective) / DAY_DIVISOR));
    expect(state.debt.credit.balanceDollarDays).toBe(50_000 * days);
  });

  it('stays quiet with enough cash, with no debt, and once the game is over', () => {
    const state = trading();
    state.debt.loans = [makeLoan({ originatedDay: 0 })];
    state.debt.nextLoanId = 2;
    const probe = structuredClone(state);
    probe.day = nextCloseDay(probe) - PAYMENT_REMINDER_DAYS;
    // Exactly enough left at the close, after the month's running costs.
    state.finance.cash = estimateNextDebtService(probe) + (probe.finance.cash - estimateCashAtClose(probe));
    expect(remindersThroughMonth(state)).toEqual([]);
    state.finance.cash -= 1;
    expect(remindersThroughMonth(structuredClone({ ...state, day: probe.day - 1 }))).toHaveLength(1);

    const none = trading();
    none.finance.cash = -100;
    expect(remindersThroughMonth(none)).toEqual([]);

    const over = trading();
    over.debt.credit.balance = 5_000;
    over.finance.cash = -100;
    over.gameOver = { day: over.day, reason: 'default', message: 'x' };
    over.day = nextCloseDay(over) - PAYMENT_REMINDER_DAYS;
    endDebtDay(over);
    expect(over.debt.credit.balanceDollarDays).toBe(0);
    expect(over.notices).toEqual([]);
  });
});

describe('closing a month with debt from a loaded save', () => {
  /** closeMonth on the 1st after state.day, with a throwaway sales stream. */
  function closeNext(state: GameState): MonthlyReport {
    state.day = nextCloseDay(state);
    return closeMonth(state, 0, new Rng(1));
  }

  function postedWhole(state: GameState, report: MonthlyReport): void {
    for (const total of Object.values(report.totals)) expect(Number.isInteger(total)).toBe(true);
    expect(Number.isInteger(state.finance.cash)).toBe(true);
  }

  it('handles a payment below its interest, a zero rate, a one-month term and a balance above the principal', () => {
    const state = trading();
    state.finance.cash = 1e7;
    state.debt.loans = [
      makeLoan({ id: 1, payment: 1, balance: 80_000, principal: 60_000 }),
      makeLoan({ id: 2, rateBps: 0 }),
      makeLoan({ id: 3, termMonths: 1, monthsLeft: 1, balance: 3_333, principal: 3_333 }),
    ];
    state.debt.nextLoanId = 4;
    const [below, zero] = structuredClone(state.debt.loans);
    const report = closeNext(state);
    postedWhole(state, report);
    // Below its interest: interest only, no principal, a month less to go.
    expect(state.debt.loans[0]).toMatchObject({ id: 1, balance: below!.balance, monthsLeft: below!.monthsLeft - 1 });
    // Zero rate: all principal.
    expect(state.debt.loans[1]).toMatchObject({ id: 2, balance: zero!.balance - zero!.payment });
    // One month: repaid in full and closed.
    expect(state.debt.loans.map((l) => l.id)).toEqual([1, 2]);
    expect(state.notices.filter((n) => n.kind === 'loanPaidOff').map((n) => n.message)).toEqual([expect.stringMatching(/^Term loan #3 is paid off/)]);
    expect(report.totals.principal).toBe(-(zero!.payment + 3_333));
  });

  it('cures a stage whose compliant closes already reached the cure count, and rounds a huge balance to whole dollars', () => {
    const state = trading();
    state.finance.cash = 1e13;
    state.debt.covenant = { stage: 'penalty', compliantCloses: COVENANT_CURE_CLOSES + 5 };
    state.debt.credit.balance = 1_000;
    state.debt.credit.balanceDollarDays = 999_999_999_999 * 7 + 3;
    const report = closeNext(state);
    postedWhole(state, report);
    expect(state.debt.covenant).toEqual({ stage: 'warning', compliantCloses: 0 });
    expect(report.debt?.stage).toBe('warning');
  });

  it('charges a line over its limit like any other balance', () => {
    const state = trading();
    state.finance.cash = 1e7;
    const over = creditLimit(state) * 2;
    state.debt.credit.balance = over;
    state.debt.credit.balanceDollarDays = over * (state.day - monthStartOf(state));
    const report = closeNext(state);
    postedWhole(state, report);
    expect(report.debt?.creditBalance).toBe(over);
    expect(report.totals.interest).toBeLessThan(0);
  });
});

describe('frozenReason', () => {
  it('names the limits in the frozen reason', () => {
    const state = trading();
    state.debt.covenant.stage = 'frozen';
    state.debt.credit.balance = 1_000;
    const reason = creditOffer(state).reasons[0]!;
    expect(reason).toBe(frozenReason(state));
    expect(reason).toMatch(/^Your credit line is frozen after a covenant breach or a missed payment/);
    expect(reason).toContain('repaying and prepaying still work');
  });

  it('says the next close lifts a freeze once nothing is owed', () => {
    const state = trading();
    state.debt.covenant.stage = 'frozen';
    const reason = frozenReason(state);
    const close = dateOf(nextCloseDay(state));
    expect(reason).toMatch(/^Your credit line is frozen after a covenant breach or a missed payment, but you owe nothing now/);
    expect(reason).toContain(`at the next month close (the ${MONTH_ABBR[close.month - 1]} 1 close)`);
    expect(reason).not.toContain(`${COVENANT_CURE_CLOSES} month close`);
  });
});

