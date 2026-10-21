// The HUD chips (hud.ts): PON ports, cost per passing, debt, covenant and
// overdraft status, the runway hint. Moved out of economy.test.ts by the
// round-4 contract. Money is checked against balance.ts constants and sim
// results, never literal dollar amounts.

import { describe, expect, it } from 'vitest';
import {
  CPP_AMBER_MULTIPLIER,
  CPP_TARGET,
  INSOLVENCY_GRACE_MONTHS,
  OLT_START_PON_PORTS,
  BASE_RATE_BPS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  COVENANT_MIN_COVERAGE,
  FROZEN_ACCELERATION_CLOSES,
  FROZEN_SWEEP_SHARE,
  PENALTY_STEP_UP_BPS,
} from '../sim/balance';
import { acceleratedSchedule, cureOptions, totalDebt } from '../sim/debt';
import { runDays } from '../sim/game';
import { cppBand, operatingCashFlow, reportKpis } from '../sim/metrics';
import { getService } from '../sim/network';
import { addLivePlant, makeGridCity, makeTestState, makeTradingState } from '../sim/testing/fixtures';
import type { GameState, TermLoan } from '../sim/types';
import { cureAdvice } from './bankPanel';
import { formatBpsDelta, formatMoney, formatPercent, formatRatio, plural } from './format';
import { MRR_TIP, calledChipText, covenantStatus, cppStatus, debtStatus, frozenChipText, overdraftStatus, ponStatus, runwayHint } from './hud';

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
    expect(runwayHint(state)).toBe(`Cash on hand: about ${plural(months, 'month')} of runway at last month's burn (storm repairs spread over the year)`);
  });
});

describe('HUD chips, round 4', () => {
  it('counts the frozen closes left before the bank calls the loans', () => {
    const state = makeTestState();
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    // Frozen with nothing owed: the next close lifts it, nothing to count.
    expect(covenantStatus(state)!.text).toBe('Credit frozen');
    state.debt.credit.balance = 50_000;
    state.debt.frozenCloses = 2;
    const status = covenantStatus(state)!;
    expect(status).toMatchObject({ text: `Credit frozen: ${plural(FROZEN_ACCELERATION_CLOSES - 2, 'close')} to call`, tone: 'danger' });
    expect(status.tip).toContain(formatPercent(FROZEN_SWEEP_SHARE));
    expect(status.tip).toContain(`after ${plural(FROZEN_ACCELERATION_CLOSES - 2, 'more frozen close')} it calls the loans`);
    state.debt.frozenCloses = FROZEN_ACCELERATION_CLOSES - 1;
    expect(covenantStatus(state)!.text).toBe('Credit frozen: 1 close to call');
    expect(frozenChipText(null)).toBe('Credit frozen');
    expect(frozenChipText(4)).toBe('Credit frozen: 4 closes to call');
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
    expect(status.tip).toMatch(/default/);
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

  it('puts the verified cure in the covenant tip', () => {
    const state = makeTradingState(25_000, 20_000);
    state.finance.cash = 2_000_000;
    state.debt.covenant = { stage: 'warning', compliantCloses: 0 };
    state.debt.credit.balance = 2_000_000;
    const cure = cureOptions(state)[0]!;
    expect(cure).toBeDefined();
    expect(covenantStatus(state)!.tip).toContain(`To cure it now: ${cureAdvice(cure)}`);
    // At risk while compliant: the same verified cure.
    state.debt.covenant = { stage: 'compliant', compliantCloses: 0 };
    expect(covenantStatus(state)!.tip).toContain(`To cure it now: ${cureAdvice(cure)}`);
    expect(covenantStatus(state)!.tip).not.toContain('The call stands');
    // Once the loans are called the tip is about the payments, not a cure (a cure lifts the freeze, not the call).
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    state.debt.acceleration = { day: state.day, closesLeft: 2 };
    expect(covenantStatus(state)!.tip).not.toContain('To cure it now');
  });

  it('calls the run-rate MRR, distinct from the Bank\'s lending ARR', () => {
    expect(MRR_TIP).toMatch(/^MRR \(monthly run-rate\)/);
    expect(MRR_TIP).toContain('lending ARR');
    expect(MRR_TIP).not.toMatch(/annual recurring revenue/i);
  });
});
