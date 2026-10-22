// The "Cash after" row and the financing hint on quote cards (funding.ts),
// moved out of tools.test.ts by the round-4 contract with the code they test.
// Money is checked against balance.ts constants and sim results.

import { describe, expect, it } from 'vitest';
import { FUNDING_CUSHION_MONTHS, LOAN_ROUNDING, TERM_LOAN_YEARS } from '../sim/balance';
import { fixedCostsPerMonth } from '../sim/overhead';
import { creditAvailable, creditLimit, estimateNextDebtService, fundingHint, termCapacity } from '../sim/debt';
import { applyCommand, newGame } from '../sim/game';
import { quoteCabinet, quoteCable, quoteSplitter } from '../sim/network';
import { makeGridCity } from '../sim/testing/fixtures';
import type { Command, FundingHint, GameState } from '../sim/types';
import { formatMoney } from './format';
import { cashAfterRow, creditHint, fundingKey, fundsOf, wordHint } from './funding';
import { ToolController } from './tools';
import type { CardModel } from './tools';

// Grid town: nodes (i, j) at (4i, 2j), id j * 4 + i; the CO is node 0 at (0, 0).
function game(opts: Parameters<typeof makeGridCity>[0] = {}): GameState {
  return newGame(7, { city: makeGridCity(opts) });
}

function dispatcher(state: GameState) {
  return (cmd: Command) => applyCommand(state, cmd);
}

function row(card: CardModel | null | undefined, label: string): string | undefined {
  return card?.rows.find((r) => r.label === label)?.value;
}

describe('cash after an order, and the credit line when cash is short', () => {
  /** Closed months with `revenue` each, so the town has ARR and a credit limit. */
  function withRevenue(state: GameState, revenue: number, months = 3): GameState {
    for (let m = 1; m <= months; m++) {
      state.finance.reports.push({ year: 2027, month: m, totals: { revenue }, net: revenue, cashEnd: state.finance.cash, passings: 0 });
    }
    return state;
  }

  it('shows cash after (red below $0) and how the credit line could cover a shortfall', () => {
    expect(cashAfterRow({ cash: 1_000, creditAvailable: 0 }, 400)).toEqual({ label: 'Cash after', value: formatMoney(600) });
    expect(cashAfterRow({ cash: 1_000, creditAvailable: 0 }, 1_500)).toEqual({ label: 'Cash after', value: formatMoney(-500), tone: 'negative' });

    // Cash covers it: nothing to say.
    expect(creditHint({ cash: 1_000, creditAvailable: 50_000 }, 1_000)).toBeUndefined();
    // No credit: nothing to offer.
    expect(creditHint({ cash: 1_000, creditAvailable: 0 }, 5_000)).toBeUndefined();
    // The shortfall rounds up to LOAN_ROUNDING...
    const shortfall = LOAN_ROUNDING + 1;
    expect(creditHint({ cash: 1_000, creditAvailable: 10 * LOAN_ROUNDING }, 1_000 + shortfall)).toBe(
      `Draw ${formatMoney(2 * LOAN_ROUNDING)} from your credit line to afford it`,
    );
    // ...capped at what is available.
    expect(creditHint({ cash: 0, creditAvailable: shortfall }, shortfall)).toBe(`Draw ${formatMoney(shortfall)} from your credit line to afford it`);
    // Some credit, not enough.
    expect(creditHint({ cash: 0, creditAvailable: shortfall - 1 }, shortfall)).toBe(`Your credit line has only ${formatMoney(shortfall - 1)} available`);
    // Overdrawn already: the whole cost plus the hole is the shortfall.
    expect(creditHint({ cash: -LOAN_ROUNDING, creditAvailable: 10 * LOAN_ROUNDING }, LOAN_ROUNDING)).toBe(
      `Draw ${formatMoney(2 * LOAN_ROUNDING)} from your credit line to afford it`,
    );
  });

  it('puts cash after and the credit hint on the cabinet, splitter and cable quote cards', () => {
    const state = withRevenue(game(), 100 * LOAN_ROUNDING);
    expect(creditAvailable(state)).toBeGreaterThan(0);
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.1, 2.1);
    const cabinet = quoteCabinet(state, 5);
    let card = tools.view(state).card!;
    expect(card.rows.find((r) => r.label === 'Cash after')).toEqual({ label: 'Cash after', value: formatMoney(state.finance.cash - cabinet.cost) });
    expect(card.credit).toBeUndefined();

    state.finance.cash = 100;
    card = tools.view(state).card!;
    expect(card.rows.find((r) => r.label === 'Cash after')).toMatchObject({ value: formatMoney(100 - cabinet.cost), tone: 'negative' });
    expect(card.credit).toBe(creditHint(fundsOf(state), cabinet.cost));
    // A game's funds word debt.fundingHint: a draw that covers the cost and keeps a cushion.
    const hint = fundingHint(state, cabinet.cost);
    expect(hint.kind).toBe('draw');
    expect(card.credit).toBe(`Draw ${formatMoney(hint.draw)} from your credit line to afford it and keep a ${formatMoney(hint.cushion)} cushion`);
    expect(100 + hint.draw - cabinet.cost).toBeGreaterThanOrEqual(hint.cushion);

    state.finance.cash = 1_000_000;
    expect(applyCommand(state, { type: 'placeCabinet', node: 0 }).ok).toBe(true);
    state.finance.cash = 10;
    tools.hoverAt(0.1, 0.1);
    const splitter = quoteSplitter(state, state.network.cabinets[0]!.id);
    card = tools.view(state).card!;
    expect(card.title).toBe('Add a splitter');
    expect(row(card, 'Cash after')).toBe(formatMoney(10 - splitter.cost));
    expect(card.credit).toBe(creditHint(fundsOf(state), splitter.cost));

    tools.setTool('underground');
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(8, 0);
    const cable = quoteCable(state, [0, 1], 'underground');
    card = tools.view(state).card!;
    expect(row(card, 'Cash after')).toBe(formatMoney(10 - cable.cost));
    expect(card.credit).toBe(creditHint(fundsOf(state), cable.cost));
  });

  it('recomputes the card when only the credit line or the covenant stage changes', () => {
    const state = withRevenue(game(), 100 * LOAN_ROUNDING);
    state.finance.cash = 100;
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.1, 2.1);
    expect(tools.view(state).card?.credit).toMatch(/^Draw/);
    // The line fully drawn (cash unchanged): a term loan instead, of the longest term.
    state.debt.credit.balance = creditLimit(state);
    expect(termCapacity(state)).toBeGreaterThan(0);
    expect(tools.view(state).card?.credit).toMatch(new RegExp(`^Take a \\$[\\d,]+ ${TERM_LOAN_YEARS.at(-1)}-year term loan in the Bank`));
    state.debt.credit.balance = 0;
    expect(tools.view(state).card?.credit).toMatch(/^Draw/);
    // Frozen: nothing to borrow, and the card says so.
    state.debt.covenant.stage = 'frozen';
    expect(tools.view(state).card?.credit).toBe("The bank can't safely lend toward it now: see the Bank for why");
  });

  it('keeps a cushion: says so when cash covers the cost but not a month of costs and the next payment', () => {
    const state = withRevenue(game(), 100 * LOAN_ROUNDING);
    state.sales.marketingPerMonth = 2_000;
    const cushion = FUNDING_CUSHION_MONTHS * fixedCostsPerMonth(state) + estimateNextDebtService(state);
    const cost = 20 * LOAN_ROUNDING;
    state.finance.cash = cost + cushion - 1;
    const hint = fundingHint(state, cost);
    expect(hint).toMatchObject({ kind: 'draw', cushion, shortfall: 1, draw: LOAN_ROUNDING });
    expect(creditHint(fundsOf(state), cost)).toBe(
      `Cash covers it but leaves less than a ${formatMoney(cushion)} cushion (a month of costs and the next loan payment): draw ${formatMoney(LOAN_ROUNDING)} from your credit line to keep one`,
    );
    state.finance.cash = cost + cushion;
    expect(creditHint(fundsOf(state), cost)).toBeUndefined();
  });
});

describe('wordHint', () => {
  const base: FundingHint = { cost: 50_000, cushion: 12_000, shortfall: 22_000, kind: 'draw', draw: 22_000, termLoan: 0, termYears: 7 };

  it('words every kind of hint, and says nothing when cash covers it and the cushion', () => {
    expect(wordHint({ ...base, kind: 'cash', shortfall: 0, draw: 0 }, 80_000)).toBeUndefined();
    expect(wordHint(base, 40_000)).toBe(`Draw ${formatMoney(22_000)} from your credit line to afford it and keep a ${formatMoney(12_000)} cushion`);
    expect(wordHint({ ...base, kind: 'term', draw: 0, termLoan: 30_000 }, 40_000)).toBe(
      `Take a ${formatMoney(30_000)} 7-year term loan in the Bank to afford it and keep a ${formatMoney(12_000)} cushion (the credit line can't safely cover it)`,
    );
    expect(wordHint({ ...base, kind: 'drawAndTerm', draw: 10_000, termLoan: 20_000 }, 40_000)).toBe(
      `Draw ${formatMoney(10_000)} from your credit line and take a ${formatMoney(20_000)} 7-year term loan in the Bank to afford it and keep a ${formatMoney(12_000)} cushion`,
    );
    expect(wordHint({ ...base, kind: 'short', draw: 5_000, termLoan: 10_000 }, 40_000)).toBe(
      `The most the bank can safely lend now is ${formatMoney(15_000)} (a ${formatMoney(5_000)} draw and a ${formatMoney(10_000)} 7-year term loan): ${formatMoney(7_000)} short of affording it with a ${formatMoney(12_000)} cushion`,
    );
    expect(wordHint({ ...base, kind: 'short', draw: 0, termLoan: 0 }, 40_000)).toBe("The bank can't safely lend toward it now: see the Bank for why");
  });

  it('says when cash covers the cost but not the cushion', () => {
    for (const kind of ['draw', 'term', 'drawAndTerm', 'short'] as const) {
      const text = wordHint({ ...base, kind, draw: kind === 'term' ? 0 : 1_000, termLoan: kind === 'draw' ? 0 : 10_000, shortfall: 5_000 }, 55_000)!;
      expect(text, kind).toMatch(new RegExp(`^Cash covers it but leaves less than a \\${formatMoney(12_000)} cushion`));
    }
  });
});

describe('fundingKey', () => {
  it('changes with everything a funding hint reads', () => {
    const state = game();
    state.debt.loans = [{ id: 1, principal: 50_000, balance: 40_000, rateBps: 700, termMonths: 60, payment: 900, monthsLeft: 40, originatedDay: 0 }];
    state.debt.nextLoanId = 2;
    const key = fundingKey(state);
    const changes: Array<[string, (s: GameState) => void]> = [
      ['marketing', (s) => (s.sales.marketingPerMonth += 1)],
      ['stage', (s) => (s.debt.covenant.stage = 'frozen')],
      ['cash', (s) => (s.finance.cash += 1)],
      ['line balance', (s) => (s.debt.credit.balance += 1)],
      ['line dollar-days', (s) => (s.debt.credit.balanceDollarDays += 1)],
      ['line rate', (s) => (s.debt.credit.rate.leverageBps += 25)],
      ['loan balance', (s) => (s.debt.loans[0]!.balance -= 1)],
      ['loan payment', (s) => (s.debt.loans[0]!.payment += 1)],
      ['loan rate', (s) => (s.debt.loans[0]!.rateBps += 1)],
      ['loan months', (s) => (s.debt.loans[0]!.monthsLeft -= 1)],
      ['a call', (s) => (s.debt.acceleration = { day: 0, closesLeft: 2 })],
      ['a closed month', (s) => s.finance.reports.push({ year: 2027, month: 1, totals: {}, net: 0, cashEnd: 0, passings: 0 })],
      ['capex', (s) => (s.finance.capex.osp += 1)],
      ['the network', (s) => (s.network.version += 1)],
      ['the day', (s) => (s.day += 1)],
    ];
    for (const [what, change] of changes) {
      const copy = structuredClone(state);
      change(copy);
      expect(fundingKey(copy), what).not.toBe(key);
    }
    expect(fundingKey(structuredClone(state))).toBe(key);
  });
});
