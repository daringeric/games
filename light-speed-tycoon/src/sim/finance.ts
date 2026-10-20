// Cash, ledger and monthly close.

import { INSOLVENCY_GRACE_MONTHS, OVERHEAD_PER_MONTH, POLE_RENT_PER_POLE_PER_MONTH, SUPPORT_COST_PER_SUB_PER_MONTH } from './balance';
import { dateOf, formatMonth, MONTH_LENGTHS } from './calendar';
import { closeDebtMonth, reviewDebt, totalDebt } from './debt';
import { operatingCashFlow } from './metrics';
import { checkMilestones } from './milestones';
import { ponPortsUsed } from './network';
import { postNotice } from './notices';
import type { Rng } from './rng';
import { closeSalesMonth, monthlyRecurringRevenue, subscriberUnits } from './sales';
import { polesOnSegment } from './streets';
import type { GameState, LedgerCategory, LedgerEntry, MonthlyReport, MonthlyStats } from './types';

// Order of category totals in a report; the Record type keeps it exhaustive
// when categories are added.
const CATEGORY_ORDER: Record<LedgerCategory, number> = {
  revenue: 0,
  construction: 1,
  equipment: 2,
  install: 3,
  refund: 4,
  poleRent: 5,
  overhead: 6,
  payroll: 7,
  marketing: 8,
  interest: 9,
  principal: 10,
  loanProceeds: 11,
  other: 12,
};

/** Whole number with thousands separators: 12400 -> "12,400". */
export function groupThousands(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Whole dollars for display: 12400 -> "$12,400", -3000 -> "-$3,000". */
export function formatMoney(amount: number): string {
  const rounded = Math.round(amount);
  return `${rounded < 0 ? '-' : ''}$${groupThousands(Math.abs(rounded))}`;
}

function record(state: GameState, entry: LedgerEntry): void {
  // Money is whole dollars everywhere; a fractional amount is a bug upstream.
  if (!Number.isInteger(entry.amount)) throw new RangeError(`Ledger amount must be whole dollars, got ${entry.amount}`);
  state.finance.monthToDate.push(entry);
  state.finance.cash += entry.amount;
}

/** Record a signed amount (negative = spend) on today's ledger and apply it to cash. */
export function postEntry(state: GameState, category: LedgerCategory, amount: number, memo: string): void {
  record(state, { day: state.day, category, amount, memo });
}

/**
 * Like postEntry, dated `day` instead of today: month-close charges are dated
 * the ended month's last day.
 */
export function postEntryOn(state: GameState, day: number, category: LedgerCategory, amount: number, memo: string): void {
  record(state, { day, category, amount, memo });
}

/** True when cash covers a non-negative cost. */
export function canAfford(state: GameState, cost: number): boolean {
  return Number.isFinite(cost) && cost >= 0 && state.finance.cash >= cost;
}

/** Poles carrying live aerial cable. */
function rentedPoles(state: GameState): number {
  let poles = 0;
  for (const span of state.network.spans) {
    if (span.method !== 'aerial' || span.stage !== 'live') continue;
    const segment = state.city.segments[span.segment];
    if (segment) poles += polesOnSegment(segment);
  }
  return poles;
}

/** Pole rent owed for one month: live aerial spans x poles on their segments x POLE_RENT_PER_POLE_PER_MONTH. */
export function monthlyPoleRent(state: GameState): number {
  return rentedPoles(state) * POLE_RENT_PER_POLE_PER_MONTH;
}

/**
 * Cash the next month close will have at its debt step (closeMonth steps 1-3
 * done): today's cash, plus the billing it will post (revenue accrued so far,
 * plus today's subscribers at today's prices for the days of the month not
 * yet accrued), less pole rent for today's live aerial spans, the overhead,
 * marketing and support (accrued so far plus today's rates for the days
 * left), and installs for the days left at the month's pace so far. Exact on
 * the month's last day, when nothing is left to accrue; before that an
 * estimate (signups, churn and commands change it). The payment reminder
 * (debt.endDebtDay) and the Bank's next payment compare it with
 * debt.estimateNextDebtService. Pure read, O(accounts + ledger entries).
 */
export function estimateCashAtClose(state: GameState): number {
  const { finance, sales } = state;
  const date = dateOf(state.day);
  const daysInMonth = MONTH_LENGTHS[date.month - 1] as number;
  // Days still to accrue: tick() accrues each day as it moves onto it (day 0 on the first tick).
  const left = daysInMonth - date.day + (state.day === 0 ? 1 : 0);
  const month = sales.month;
  const revenue = Math.round((month.revenueDollarDays + monthlyRecurringRevenue(state) * left) / daysInMonth);
  const marketing = Math.round((month.marketingDollarDays + sales.marketingPerMonth * left) / daysInMonth);
  const support = Math.round((SUPPORT_COST_PER_SUB_PER_MONTH * (month.subscriberUnitDays + subscriberUnits(state) * left)) / daysInMonth);
  let installs = 0;
  for (const entry of finance.monthToDate) if (entry.category === 'install') installs += entry.amount;
  const installsLeft = Math.round((installs * left) / date.day);
  return finance.cash + revenue - marketing - support - OVERHEAD_PER_MONTH - monthlyPoleRent(state) + installsLeft;
}

/**
 * Close the month that just ended. Called by tick() when the new day is the 1st
 * of a month (never for day 0), before that day's network progress and sales
 * step, so the network is as it stood on the ended month's last day. `rng` is
 * the sales stream (churn), taken by tick() from state.rng.sales.
 *
 * In order, every ledger entry dated the ended month's last day:
 *   1. pole rent for live aerial spans;
 *   2. 'overhead' -OVERHEAD_PER_MONTH ("Overhead for Mar 2027");
 *   3. sales.closeSalesMonth: revenue, marketing, support, churn, accrual reset;
 *   4. debt.closeDebtMonth: the month's debt service (credit-line interest,
 *      term-loan payments) out of the cash left after 1-3, or a missed
 *      payment (interest capitalized, a late fee);
 *   5. totals, net and the MonthlyReport (labelled with the ended month), with
 *      `stats` from the month-end state: subscribers/accounts after churn, the
 *      SalesClose counts, sales.connectsTotal, finance.capex, PON ports in use
 *      / olt.ponPorts, sales.fullCabinets.length; append it to finance.reports
 *      and clear monthToDate;
 *   6. milestones.checkMilestones(state, report);
 *   7. debt.reviewDebt: default (game over) / missed payment / covenant
 *      review and its notices, the credit line's re-pricing, report.debt;
 *   8. checkInsolvency(state) (nothing once a default has ended the game).
 * Returns the report. Every report it writes has `stats` and `debt` (zeros
 * with no debt).
 */
export function closeMonth(state: GameState, passings: number, rng: Rng): MonthlyReport {
  const lastDay = state.day - 1;
  // Throws for day 0: no month has ended yet.
  const ended = dateOf(lastDay);
  const label = formatMonth(ended.year, ended.month);

  const poles = rentedPoles(state);
  if (poles > 0) {
    record(state, {
      day: lastDay,
      category: 'poleRent',
      amount: -poles * POLE_RENT_PER_POLE_PER_MONTH,
      memo: `Pole rent for ${label}: ${groupThousands(poles)} poles x ${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}`,
    });
  }
  if (OVERHEAD_PER_MONTH > 0) {
    record(state, { day: lastDay, category: 'overhead', amount: -OVERHEAD_PER_MONTH, memo: `Overhead for ${label}` });
  }

  const sales = closeSalesMonth(state, rng, MONTH_LENGTHS[ended.month - 1] as number, lastDay);
  const debtClose = closeDebtMonth(state, lastDay);

  const sums = new Map<LedgerCategory, number>();
  let net = 0;
  for (const entry of state.finance.monthToDate) {
    sums.set(entry.category, (sums.get(entry.category) ?? 0) + entry.amount);
    net += entry.amount;
  }
  const totals: Partial<Record<LedgerCategory, number>> = {};
  for (const [category, total] of [...sums].sort(([a], [b]) => CATEGORY_ORDER[a] - CATEGORY_ORDER[b])) {
    totals[category] = total;
  }

  const { capex } = state.finance;
  const stats: MonthlyStats = {
    subscribers: subscriberUnits(state),
    accounts: state.sales.accounts.length,
    subscriberDays: sales.subscriberDays,
    grossAdds: sales.grossAdds,
    churned: sales.churned,
    lostService: sales.lostService,
    connectsTotal: state.sales.connectsTotal,
    capexOsp: capex.osp,
    capexConnect: capex.connect,
    capexCo: capex.co,
    ponPortsUsed: ponPortsUsed(state),
    ponPorts: state.network.olt.ponPorts,
    fullCabinets: state.sales.fullCabinets.length,
  };
  const report: MonthlyReport = {
    year: ended.year,
    month: ended.month,
    totals,
    net,
    cashEnd: state.finance.cash,
    passings,
    stats,
  };
  state.finance.reports.push(report);
  state.finance.monthToDate = [];

  checkMilestones(state, report);
  reviewDebt(state, report, debtClose);
  checkInsolvency(state);
  return report;
}

/** "Mar 2027" for the month the latest close ended (falls back to the current month). */
function latestCloseLabel(state: GameState): string {
  const report = state.finance.reports.at(-1);
  if (report) return formatMonth(report.year, report.month);
  const date = dateOf(Math.max(0, state.day - 1));
  return formatMonth(date.year, date.month);
}

/**
 * Insolvency rule, run at the end of every month close (after the report is
 * appended). If state.finance.cash < 0: negativeMonths += 1; when it reaches
 * INSOLVENCY_GRACE_MONTHS set state.gameOver = { day: state.day, reason:
 * 'insolvent', message } and post a 'gameOver' notice; otherwise post an
 * 'insolvencyWarning' notice saying how many more negative closes end the game
 * ("Cash is below zero at the Mar 2027 close. 2 more closes in the red and the
 * bank shuts you down."). With the credit line frozen and debt outstanding the
 * warning says instead that the next close in the red is a default: such a
 * close cannot pay its loan payments, and a payment missed while frozen ends
 * the game (debt.reviewDebt) before any grace runs out. If cash >= 0:
 * negativeMonths = 0 (no notice). Does nothing once gameOver is set.
 */
export function checkInsolvency(state: GameState): void {
  if (state.gameOver) return;
  const { finance } = state;
  if (finance.cash >= 0) {
    finance.negativeMonths = 0;
    return;
  }
  finance.negativeMonths += 1;
  const label = latestCloseLabel(state);
  const left = INSOLVENCY_GRACE_MONTHS - finance.negativeMonths;
  if (left <= 0) {
    const closes = finance.negativeMonths === 1 ? 'a month close' : `${finance.negativeMonths} month closes in a row`;
    const message =
      `Out of cash: ${closes} ended below zero (${formatMoney(finance.cash)} at the ${label} close), ` +
      'so the bank has shut the company down.';
    state.gameOver = { day: state.day, reason: 'insolvent', message };
    postNotice(state, 'gameOver', message);
    return;
  }
  const next =
    state.debt.covenant.stage === 'frozen' && totalDebt(state) > 0
      ? 'Your credit line is frozen, so the next close in the red is a default: it cannot pay its loan payments, the bank calls your loans and the game ends.'
      : `${left} more close${left === 1 ? '' : 's'} in the red and the bank shuts you down.`;
  postNotice(state, 'insolvencyWarning', `Cash is below zero at the ${label} close (${formatMoney(finance.cash)}). ${next}`);
}

/**
 * Months of runway at the current burn, for the HUD warning. The burn is the
 * last closed month's operating cash flow (metrics.operatingCashFlow) plus its
 * debt service (totals.interest and totals.principal, both <= 0; money
 * borrowed is not income, so loanProceeds is left out). Null when there is no
 * closed month yet or that flow was >= 0; otherwise
 * floor(max(0, cash) / -flow). Pure read.
 */
export function runwayMonths(state: GameState): number | null {
  const last = state.finance.reports.at(-1);
  if (!last) return null;
  const flow = operatingCashFlow(last) + (last.totals.interest ?? 0) + (last.totals.principal ?? 0);
  if (flow >= 0) return null;
  return Math.floor(Math.max(0, state.finance.cash) / -flow);
}
