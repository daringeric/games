// How the player could pay for what a quote card or a panel prices: the
// "Cash after" row and the financing hint under it ("Draw $X from your credit
// line to afford it"). Shared by the map's quote cards (tools.ts, which
// re-exports these) and the OLT panel.
//
// Owner: ui-bank workstream (round 4, sim-debt: hints from debt.fundingHint
// that keep a cash cushion and consider term loans). Extracted from tools.ts
// by the round-4 contract so the Bank's work never touches the map tools; the
// signatures below are what tools.ts and oltPanel.ts call, so keep them.

import { LOAN_ROUNDING } from '../sim/balance';
import { creditAvailable, fundingHint } from '../sim/debt';
import type { FundingHint, GameState } from '../sim/types';
import { formatMoney } from './format';
import type { CardRow } from './tools';

/** What the player can spend: cash, and what the credit line would lend today. */
export interface Funds {
  cash: number;
  /** debt.creditAvailable: 0 while frozen or before there is a limit. */
  creditAvailable: number;
  /**
   * debt.fundingHint for a cost, when the funds come from a game (fundsOf).
   * Hand-built funds (tests) leave it out and get the plain credit-line rule.
   */
  hint?: (cost: number) => FundingHint;
}

export function fundsOf(state: GameState): Funds {
  return { cash: state.finance.cash, creditAvailable: creditAvailable(state), hint: (cost) => fundingHint(state, cost) };
}

/**
 * Everything fundsOf and the hint read, for view caches (ToolController keys
 * its card on it): when this string is unchanged, so is every funding hint.
 * debt.fundingHint reads cash and the marketing budget (the cushion), the
 * next debt service (the line's balance, dollar-days and rate parts, every
 * loan, the stage, a call, the day), what the line and term loans can lend
 * (the closed months, the stage, a call), the covenants (the closed months,
 * the debt) and the pricing CPP (capex and passings: the network and the day).
 */
export function fundingKey(state: GameState): string {
  const { debt, finance, sales } = state;
  const rate = debt.credit.rate;
  const loans = debt.loans.map((l) => `${l.id}/${l.balance}/${l.payment}/${l.rateBps}/${l.monthsLeft}/${l.originatedDay}`).join(',');
  return [
    state.day,
    finance.cash,
    finance.reports.length,
    finance.capex.osp,
    state.network.version,
    sales.marketingPerMonth,
    debt.credit.balance,
    debt.credit.balanceDollarDays,
    `${rate.baseBps}/${rate.leverageBps}/${rate.cppBps}/${rate.productBps}`,
    debt.covenant.stage,
    debt.acceleration ? `${debt.acceleration.closesLeft}` : '-',
    loans,
  ].join(':');
}

/** The "Cash after" row of a quote card: cash - cost, red below $0. */
export function cashAfterRow(funds: Funds, cost: number): CardRow {
  const after = funds.cash - cost;
  return after < 0 ? { label: 'Cash after', value: formatMoney(after), tone: 'negative' } : { label: 'Cash after', value: formatMoney(after) };
}

/**
 * How the player could pay for `cost`. With funds.hint (a game's funds,
 * fundsOf): debt.fundingHint, which keeps a cash cushion (a month of fixed
 * costs and the next loan payment) and suggests only covenant-safe
 * borrowing, worded by kind (wordHint): nothing when cash covers the cost and
 * the cushion; a draw, a term loan, or both; or how short the safe borrowing
 * falls; and when cash covers the cost but not the cushion it says so. It
 * never suggests a draw that leaves cash near $0. Hand-built funds without a
 * hint (tests) keep the round-3 rule: when cash can't cover `cost`, "Draw $X
 * from your credit line to afford it" if the line has the shortfall (X = the
 * shortfall rounded up to LOAN_ROUNDING, capped at what is available), "Your
 * credit line has only $Y available" if it has some but not enough;
 * otherwise undefined.
 */
export function creditHint(funds: Funds, cost: number): string | undefined {
  if (funds.hint) return wordHint(funds.hint(cost), funds.cash);
  const shortfall = cost - funds.cash;
  if (shortfall <= 0) return undefined;
  const available = Math.max(0, funds.creditAvailable);
  if (available >= shortfall) {
    const draw = Math.min(available, Math.ceil(shortfall / LOAN_ROUNDING) * LOAN_ROUNDING);
    return `Draw ${formatMoney(draw)} from your credit line to afford it`;
  }
  if (available > 0) return `Your credit line has only ${formatMoney(available)} available`;
  return undefined;
}

/** "a $40,000 7-year term loan" */
function termLoanWords(hint: FundingHint): string {
  return `a ${formatMoney(hint.termLoan)} ${hint.termYears}-year term loan`;
}

/**
 * A FundingHint in words, for a quote card or panel (undefined for 'cash':
 * nothing to say). `cash` is today's cash, to say when it covers the cost but
 * not the cushion.
 */
export function wordHint(hint: FundingHint, cash: number): string | undefined {
  const cushion = formatMoney(hint.cushion);
  const coversCost = cash >= hint.cost;
  const keep = coversCost ? `Cash covers it but leaves less than a ${cushion} cushion (a month of costs and the next loan payment): ` : '';
  switch (hint.kind) {
    case 'cash':
      return undefined;
    case 'draw':
      return coversCost
        ? `${keep}draw ${formatMoney(hint.draw)} from your credit line to keep one`
        : `Draw ${formatMoney(hint.draw)} from your credit line to afford it and keep a ${cushion} cushion`;
    case 'term':
      return coversCost
        ? `${keep}${termLoanWords(hint)} in the Bank would keep one`
        : `Take ${termLoanWords(hint)} in the Bank to afford it and keep a ${cushion} cushion (the credit line can't safely cover it)`;
    case 'drawAndTerm':
      return (
        `${coversCost ? keep : ''}${coversCost ? 'draw' : 'Draw'} ${formatMoney(hint.draw)} from your credit line and take ${termLoanWords(hint)} in the Bank ` +
        `${coversCost ? 'to keep one' : `to afford it and keep a ${cushion} cushion`}`
      );
    case 'short': {
      const parts: string[] = [];
      if (hint.draw > 0) parts.push(`a ${formatMoney(hint.draw)} draw`);
      if (hint.termLoan > 0) parts.push(termLoanWords(hint));
      if (parts.length === 0) {
        return coversCost
          ? `Cash covers it but leaves less than a ${cushion} cushion (a month of costs and the next loan payment), and the bank can't safely lend more now`
          : "The bank can't safely lend toward it now: see the Bank for why";
      }
      const most = hint.draw + hint.termLoan;
      const short = formatMoney(Math.max(0, hint.shortfall - most));
      return coversCost
        ? `${keep}the most the bank can safely lend now is ${formatMoney(most)} (${parts.join(' and ')}), ${short} short of a full one`
        : `The most the bank can safely lend now is ${formatMoney(most)} (${parts.join(' and ')}): ${short} short of affording it with a ${cushion} cushion`;
    }
  }
}
