// The HUD chips (hud.ts): PON ports, cost per passing, debt, the bank's
// health (round 4c/4d: the Bank's own plain words) and overdraft status, the
// runway hint, the company label. Moved out of economy.test.ts by the
// round-4 contract. Money is checked against balance.ts constants and sim
// results, never literal dollar amounts.

import { describe, expect, it } from 'vitest';
import {
  DIFFICULTY_LEVELS,
  CPP_AMBER_MULTIPLIER,
  CPP_TARGET,
  INSOLVENCY_GRACE_MONTHS,
  OLT_START_PON_PORTS,
  BASE_RATE_BPS,
  COVENANT_MAX_LEVERAGE,
  FROZEN_ACCELERATION_CLOSES,
  PENALTY_STEP_UP_BPS,
} from '../sim/balance';
import { acceleratedSchedule, bankHealth, covenantMetrics, cureFor, estimateSweep, totalDebt } from '../sim/debt';
import { defaultCompanyName } from '../sim/company';
import { newGame, runDays } from '../sim/game';
import { cppBand, operatingCashFlow, reportKpis } from '../sim/metrics';
import { getService } from '../sim/network';
import { addLivePlant, makeGridCity, makeTestState, makeTradingState } from '../sim/testing/fixtures';
import type { GameState, TermLoan } from '../sim/types';
import { cureAdvice } from './bankPanel';
import { formatMoney, formatPercentFine, plural } from './format';
import { HEALTH_WORD, healthSentence } from './health';
import { MRR_TIP, calledChipText, covenantStatus, cppStatus, debtStatus, frozenChipText, hudIdentity, overdraftStatus, ponStatus, runwayHint } from './hud';

/** Words the HUD's bank tooltips leave to the Bank's disclosures. */
const JARGON = /leverage|covenant|DSCR|ARR|OCF|bps|×/i;

/** A grid town fully lit from the CO with plenty of ports, run long enough to have subscribers and closed months. */
function litGame(days = 120): GameState {
  const state = makeTestState(makeGridCity({ cols: 3, rows: 2 }));
  addLivePlant(state, { splitters: 4 });
  runDays(state, days);
  return state;
}

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
    // Frozen with debt owed, the bank tolerates no close in the red: it would be a default.
    state.debt.covenant.stage = 'frozen';
    state.debt.credit.balance = 1_000;
    expect(overdraftStatus(state)).toMatchObject({ text: 'Recovering: no closes left', tone: 'warn' });
    state.finance.cash = -1;
    expect(overdraftStatus(state)).toMatchObject({ text: 'Overdrawn: no closes left', tone: 'danger' });
    expect(overdraftStatus(state)!.tip).toMatch(/default/);
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

  it('shows total debt only while something is owed, splitting emergency cash and loans in the tooltip', () => {
    const state = makeTestState();
    expect(debtStatus(state)).toBeNull();
    state.debt.credit.balance = 12_000;
    expect(debtStatus(state)).toMatchObject({ text: `Debt ${formatMoney(12_000)}`, total: 12_000 });
    state.debt.loans = [loan(1, 150_000), loan(2, 250_000)];
    const status = debtStatus(state)!;
    expect(status.text).toBe(`Debt ${formatMoney(412_000)}`);
    expect(status.tip).toContain(`${formatMoney(12_000)} of emergency cash`);
    expect(status.tip).toContain(`${formatMoney(400_000)} in loans (2 loans)`);
    expect(status.tip).not.toMatch(JARGON);
    state.debt.credit.balance = 0;
    expect(debtStatus(state)!.tip).toContain(`${formatMoney(0)} of emergency cash`);
  });

  it('shows the bank chip only while the health is not Good, in the Bank’s own words, warn then danger', () => {
    const state = makeTestState();
    expect(covenantStatus(state)).toBeNull();
    state.debt.credit.balance = 10_000;
    state.debt.covenant = { stage: 'warning', compliantCloses: 0 };
    expect(covenantStatus(state)).toMatchObject({ text: `Bank: ${HEALTH_WORD.warning}`, tone: 'warn' });
    expect(covenantStatus(state)!.tip).toContain(`Bank health: ${HEALTH_WORD.warning}. ${healthSentence(bankHealth(state))}`);
    state.debt.covenant = { stage: 'penalty', compliantCloses: 1 };
    expect(covenantStatus(state)).toMatchObject({ text: 'Bank: Higher interest', tone: 'danger' });
    expect(covenantStatus(state)!.tip).toContain(`${formatPercentFine(PENALTY_STEP_UP_BPS / 10_000)} more`);
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    expect(covenantStatus(state)).toMatchObject({ text: `Bank: No more borrowing: ${plural(FROZEN_ACCELERATION_CLOSES, 'month')} to call`, tone: 'danger' });
    for (const stage of ['warning', 'penalty', 'frozen'] as const) {
      state.debt.covenant = { stage, compliantCloses: 0 };
      expect(covenantStatus(state)!.tip).not.toMatch(JARGON);
    }
  });

  it('warns on Watch: close to a limit, or failing a check at today’s figures', () => {
    const state = makeTradingState(25_000, 0);
    const uw = covenantMetrics(state).underwritingCashFlow;
    // Within the watch headroom of the leverage limit, still passing.
    state.debt.loans = [{ ...loan(1, Math.floor(uw * COVENANT_MAX_LEVERAGE * 0.95)), monthsLeft: 600 }];
    expect(bankHealth(state)).toMatchObject({ level: 'watch', nearLimit: true });
    expect(covenantStatus(state)).toMatchObject({ text: 'Bank: Watch', tone: 'warn' });
    expect(covenantStatus(state)!.tip).toContain("you're close to a limit");
    expect(covenantStatus(state)!.tip).not.toContain('To pass both checks again');
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
    expect(runwayHint(state)).toBe(`Cash on hand: about ${plural(months, 'month')} of runway at last month's burn (storm repairs spread over the year)`);
  });
});

describe('HUD chips, round 4', () => {
  it('counts the months left before the bank asks for every loan back', () => {
    const state = makeTestState();
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    // Frozen with nothing owed: the next close lifts it, nothing to count.
    expect(covenantStatus(state)!.text).toBe('Bank: No more borrowing');
    state.debt.credit.balance = 50_000;
    state.debt.frozenCloses = 2;
    const status = covenantStatus(state)!;
    expect(status).toMatchObject({ text: `Bank: No more borrowing: ${plural(FROZEN_ACCELERATION_CLOSES - 2, 'month')} to call`, tone: 'danger' });
    expect(status.tip).toContain(`asks for every loan back in ${plural(FROZEN_ACCELERATION_CLOSES - 2, 'month')}`);
    state.debt.frozenCloses = FROZEN_ACCELERATION_CLOSES - 1;
    expect(covenantStatus(state)!.text).toBe('Bank: No more borrowing: 1 month to call');
    expect(covenantStatus(state)!.tip).toContain('That call is close.');
    expect(frozenChipText(null)).toBe('Bank: No more borrowing');
    expect(frozenChipText(4)).toBe('Bank: No more borrowing: 4 months to call');
    expect(frozenChipText(0)).toBe('Bank: No more borrowing: call at the next close');
  });

  it('names the sweep in the tip when the next close takes spare cash', () => {
    const state = makeTradingState(40_000, 20_000);
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    state.debt.credit.balance = 150_000;
    state.debt.frozenCloses = 1;
    state.finance.cash = 400_000;
    state.sales.month.revenueDollarDays = 60_000 * 31;
    const sweep = estimateSweep(state);
    expect(sweep).toBeGreaterThan(0);
    expect(covenantStatus(state)!.tip).toContain(`takes about ${formatMoney(sweep)} of your spare cash`);
  });

  it('shows the closes left once the loans are called, whatever the stage', () => {
    const state = makeTestState();
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    state.debt.credit.balance = 60_000;
    state.debt.frozenCloses = FROZEN_ACCELERATION_CLOSES;
    state.debt.acceleration = { day: 0, closesLeft: 2 };
    const status = covenantStatus(state)!;
    expect(status).toMatchObject({ text: 'Loans called: 2 closes left', tone: 'danger' });
    expect(status.tip).toContain(formatMoney(totalDebt(state)));
    expect(status.tip).toContain(formatMoney(acceleratedSchedule(state)[0]!));
    expect(status.tip).toMatch(/the game ends/);
    expect(status.tip).not.toMatch(JARGON);
    // A cure steps the freeze down; the call stays.
    state.debt.covenant = { stage: 'penalty', compliantCloses: 0 };
    state.debt.acceleration.closesLeft = 1;
    expect(covenantStatus(state)!.text).toBe('Loans called: 1 close left');
    expect(calledChipText(3)).toBe('Loans called: 3 closes left');
    // Called with cash below $0: no close in the red is tolerated.
    state.finance.cash = -1;
    expect(overdraftStatus(state)).toMatchObject({ text: 'Overdrawn: no closes left', tone: 'danger' });
    expect(overdraftStatus(state)!.tip).toMatch(/called your loans/);
  });

  it('puts the verified cure in the tip, in plain words', () => {
    const state = makeTradingState(25_000, 20_000);
    state.finance.cash = 2_000_000;
    state.debt.covenant = { stage: 'warning', compliantCloses: 0 };
    state.debt.credit.balance = 2_000_000;
    const cure = cureFor(state)!;
    expect(cure).not.toBeNull();
    expect(covenantStatus(state)!.tip).toContain(cureAdvice(cure));
    expect(cureAdvice(cure)).not.toMatch(JARGON);
    // Failing today while in good standing (Watch): the same verified cure.
    state.debt.covenant = { stage: 'compliant', compliantCloses: 0 };
    expect(covenantStatus(state)).toMatchObject({ text: 'Bank: Watch', tone: 'warn' });
    expect(covenantStatus(state)!.tip).toContain(cureAdvice(cure));
    // Once the loans are called the tip is about the payments.
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    state.debt.acceleration = { day: state.day, closesLeft: 2 };
    expect(covenantStatus(state)!.tip).not.toContain('To pass both checks again');
  });

  it('calls the run-rate MRR, distinct from the Bank\'s lending ARR', () => {
    expect(MRR_TIP).toMatch(/^MRR \(monthly run-rate\)/);
    expect(MRR_TIP).toContain('lending ARR');
    expect(MRR_TIP).not.toMatch(/annual recurring revenue/i);
  });
});

describe('HUD company label, round 4b', () => {
  it('shows the company first and the town second, with the difficulty in the tooltip', () => {
    const level = DIFFICULTY_LEVELS.find((l) => l.id === 'bootstrapped')!;
    const state = newGame(9, { difficulty: level.id, companyName: 'Heron Broadband Co-op' });
    const who = hudIdentity(state);
    expect(who.company).toBe('Heron Broadband Co-op');
    expect(who.town).toBe(state.city.name);
    expect(who.tip).toContain('Heron Broadband Co-op');
    expect(who.tip).toContain(state.city.name);
    expect(who.tip).toContain(level.name);
    expect(who.tip).toContain(formatMoney(level.startCash));
  });

  it('names a game started without a name after its town, at Seed round', () => {
    const state = newGame(9);
    const seed = DIFFICULTY_LEVELS.find((l) => l.id === 'seed')!;
    expect(hudIdentity(state)).toMatchObject({ company: defaultCompanyName(state.city.name), town: state.city.name });
    expect(hudIdentity(state).tip).toContain(seed.name);
  });
});
