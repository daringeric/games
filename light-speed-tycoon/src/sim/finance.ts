// Cash, ledger and monthly close.

import { INSOLVENCY_GRACE_MONTHS, OVERHEAD_PER_MONTH, POLE_RENT_PER_POLE_PER_MONTH, SUPPORT_COST_PER_SUB_PER_MONTH } from './balance';
import { dateOf, formatMonth, MONTH_LENGTHS } from './calendar';
import { closeDebtMonth, estimateNextDebtService, reviewDebt, totalDebt } from './debt';
import { promosRunningBetween, reviewIncumbent } from './incumbent';
import { CAPEX_CATEGORIES, FINANCING_CATEGORIES, operatingCashFlow, REPAIR_TRAILING_MONTHS, trailingRepairs } from './metrics';
import { checkMilestones } from './milestones';
import { ponPortsUsed } from './network';
import { postNotice } from './notices';
import type { Rng } from './rng';
import { closeSalesMonth, monthlyRecurringRevenue, subscriberUnits } from './sales';
import { polesOnSegment } from './streets';
import type { GameState, LedgerCategory, LedgerEntry, MonthlyReport, MonthlyStats } from './types';
import { closeWeatherMonth } from './weather';

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
  repair: 9,
  interest: 10,
  principal: 11,
  loanProceeds: 12,
  other: 13,
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

/** What the next close will post for the open month (closeMonth steps 1-3), estimated at today's rates (estimateCashAtClose). */
interface CloseFlows {
  /** Billing: revenue accrued so far plus today's subscribers at today's prices for the days left. */
  revenue: number;
  /** Marketing and support: accrued so far plus today's rates for the days left (positive = money out). */
  marketing: number;
  support: number;
  /** OVERHEAD_PER_MONTH and pole rent for today's live aerial spans (positive = money out). */
  overhead: number;
  poleRent: number;
  /**
   * Installs still to come this month (capex, <= 0): the days left at the
   * pace of the month so far and the last closed month together, so a
   * projection made early in the month (the briefing's, on the 1st) does not
   * scale one day's installs up to a month or leave the month's out.
   */
  installsLeft: number;
}

function estimateCloseFlows(state: GameState): CloseFlows {
  const { finance, sales } = state;
  const date = dateOf(state.day);
  const daysInMonth = MONTH_LENGTHS[date.month - 1] as number;
  // Days still to accrue: tick() accrues each day as it moves onto it (day 0 on the first tick).
  const left = daysInMonth - date.day + (state.day === 0 ? 1 : 0);
  const month = sales.month;
  let installs = 0;
  for (const entry of finance.monthToDate) if (entry.category === 'install') installs += entry.amount;
  // The pace: this month's installs so far with the last closed month's, over their days.
  const last = finance.reports.at(-1);
  const lastInstalls = last ? (last.totals.install ?? 0) : 0;
  const lastDays = last ? (MONTH_LENGTHS[last.month - 1] as number) : 0;
  return {
    revenue: Math.round((month.revenueDollarDays + monthlyRecurringRevenue(state) * left) / daysInMonth),
    marketing: Math.round((month.marketingDollarDays + sales.marketingPerMonth * left) / daysInMonth),
    support: Math.round((SUPPORT_COST_PER_SUB_PER_MONTH * (month.subscriberUnitDays + subscriberUnits(state) * left)) / daysInMonth),
    overhead: OVERHEAD_PER_MONTH,
    poleRent: monthlyPoleRent(state),
    installsLeft: Math.round(((installs + lastInstalls) * left) / (date.day + lastDays)),
  };
}

/**
 * Cash the next month close will have at its debt step (closeMonth steps 1-3
 * done): today's cash, plus the billing it will post (revenue accrued so far,
 * plus today's subscribers at today's prices for the days of the month not
 * yet accrued), less pole rent for today's live aerial spans, the overhead,
 * marketing and support (accrued so far plus today's rates for the days
 * left), and installs for the days left at the pace of this month so far and
 * the last closed month together (CloseFlows.installsLeft). Exact on
 * the month's last day, when nothing is left to accrue; before that an
 * estimate (signups, churn and commands change it). The payment reminder
 * (debt.endDebtDay) and the Bank's next payment compare it with
 * debt.estimateNextDebtService. Pure read, O(accounts + ledger entries).
 * Round 4b: the billing and support accrued so far are already net of
 * outage days (sales.accrueDay); the days left are estimated at today's MRR
 * and subscribers, so an outage under way counts as repaired by then (it
 * lasts days, and the estimate errs by the few days' credit at most).
 */
export function estimateCashAtClose(state: GameState): number {
  const f = estimateCloseFlows(state);
  return state.finance.cash + f.revenue - f.marketing - f.support - f.overhead - f.poleRent + f.installsLeft;
}

/**
 * Operating cash flow (metrics.operatingCashFlow rules: capex and financing
 * left out) the open month will report at its close: the operating entries
 * posted so far this month (repairs, say) plus the billing and running costs
 * the close will post, at estimateCashAtClose's figures. Exact on the
 * month's last day. The frozen-line sweep estimate (debt.estimateSweep)
 * reads it. Pure read.
 */
export function estimateMonthOperatingCashFlow(state: GameState): number {
  const f = estimateCloseFlows(state);
  return monthOperatingCashFlow(state) + f.revenue - f.marketing - f.support - f.overhead - f.poleRent;
}

/**
 * The operating entries of the open month so far: the sum of monthToDate
 * outside metrics.CAPEX_CATEGORIES and FINANCING_CATEGORIES. At a close's
 * debt step (closeMonth steps 1-3 done) it is the ended month's operating
 * cash flow, which the frozen-line sweep takes its share of.
 */
export function monthOperatingCashFlow(state: GameState): number {
  let flow = 0;
  for (const entry of state.finance.monthToDate) {
    if (CAPEX_CATEGORIES.includes(entry.category) || FINANCING_CATEGORIES.includes(entry.category)) continue;
    flow += entry.amount;
  }
  return flow;
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
 *   3. sales.closeSalesMonth: revenue, marketing, support, churn, accrual
 *      reset (round 4: tier moves, price steps, outage and incumbent churn);
 *      then weather.closeWeatherMonth (the month's outage totals, reset);
 *   4. debt.closeDebtMonth: the month's debt service (credit-line interest,
 *      term-loan payments; round 4: the frozen sweep and accelerated
 *      repayments) out of the cash left after 1-3, or a missed payment
 *      (interest capitalized, a late fee);
 *   5. totals, net and the MonthlyReport (labelled with the ended month), with
 *      `stats` from the month-end state: subscribers/accounts after churn, the
 *      SalesClose counts, sales.connectsTotal, finance.capex, PON ports in use
 *      / olt.ponPorts, sales.fullCabinets.length; append it to finance.reports
 *      and clear monthToDate;
 *   6. milestones.checkMilestones(state, report);
 *   7. debt.reviewDebt: default (game over) / missed payment / covenant
 *      review and its notices, the credit line's re-pricing, report.debt;
 *   7b. incumbent.reviewIncumbent: incumbent promos end and start (round 4;
 *      skipped once a default has ended the game);
 *   8. checkInsolvency(state) (nothing once a default has ended the game);
 *   9. report.ops (round 4) with lastNoticeId = nextNoticeId - 1, after
 *      every notice of the close.
 * Returns the report. Every report it writes has `stats`, `debt` (zeros
 * with no debt) and `ops`.
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
  const weather = closeWeatherMonth(state);
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
  const incumbentPromos = promosRunningBetween(state, lastDay - ended.day + 1, lastDay);

  checkMilestones(state, report);
  reviewDebt(state, report, debtClose);
  if (!state.gameOver) reviewIncumbent(state);
  checkInsolvency(state);
  report.ops = {
    lastNoticeId: state.nextNoticeId - 1,
    tierMoves: sales.tierMoves,
    priceChurn: sales.priceChurn,
    outageChurn: sales.outageChurn,
    incumbentChurn: sales.incumbentChurn,
    outageUnitDays: weather.outageUnitDays,
    storms: weather.storms,
    spansDamaged: weather.spansDamaged,
    repairs: weather.repairs,
    incumbentPromos,
    mrr: monthlyRecurringRevenue(state),
    outageCredits: sales.outageCredits,
  };
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
 * bank shuts you down."). With the credit line frozen and debt outstanding, or
 * the loans called (round 4: debt.acceleration), the warning says instead
 * that the next close in the red is a default: such a close cannot pay what
 * falls due, and a payment missed while frozen or called ends the game
 * (debt.reviewDebt) before any grace runs out. If cash >= 0:
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
  const owing = totalDebt(state) > 0;
  const next =
    owing && state.debt.acceleration !== null
      ? 'The bank has called your loans, so the next close in the red is a default: it cannot pay what falls due and the game ends.'
      : owing && state.debt.covenant.stage === 'frozen'
        ? 'Your credit line is frozen, so the next close in the red is a default: it cannot pay its loan payments, the bank calls your loans and the game ends.'
        : `${left} more close${left === 1 ? '' : 's'} in the red and the bank shuts you down.`;
  postNotice(state, 'insolvencyWarning', `Cash is below zero at the ${label} close (${formatMoney(finance.cash)}). ${next}`);
}

/**
 * The monthly burn behind runwayMonths (and the advisor's runway advice), in
 * whole dollars, 0 when not burning: minus the last closed month's operating
 * cash flow (metrics.operatingCashFlow) plus its debt service (money
 * borrowed is not income, so loanProceeds is left out). Round 4: that
 * month's storm and dig-in repairs count at their monthly average over the
 * last metrics.REPAIR_TRAILING_MONTHS closes instead (one storm month is not
 * a lasting burn); the debt service is the scheduled one, a twelfth of the
 * close's report.debt.annualDebtService (repaying the line or prepaying a
 * loan is a choice, not a burn), or totals.interest + totals.principal on a
 * report from before round 3; and once the bank has called the loans it is
 * what falls due at the next close (debt.estimateNextDebtService), far more
 * than the month before paid. 0 with no closed month yet. Pure read.
 */
export function monthlyBurn(state: GameState): number {
  const reports = state.finance.reports;
  const last = reports.at(-1);
  if (!last) return 0;
  const service =
    state.debt.acceleration !== null && totalDebt(state) > 0
      ? -estimateNextDebtService(state)
      : last.debt
        ? -Math.round(last.debt.annualDebtService / 12)
        : (last.totals.interest ?? 0) + (last.totals.principal ?? 0);
  const repairs = Math.round(trailingRepairs(reports) / REPAIR_TRAILING_MONTHS);
  const flow = operatingCashFlow(last) - (last.totals.repair ?? 0) + repairs + service;
  return flow < 0 ? -flow : 0;
}

/**
 * Months of runway at the current burn (monthlyBurn), for the HUD warning,
 * the briefing and the advisor: null when there is no closed month yet or
 * nothing is burning; otherwise floor(max(0, cash) / burn). Pure read.
 */
export function runwayMonths(state: GameState): number | null {
  const burn = monthlyBurn(state);
  if (burn <= 0) return null;
  return Math.floor(Math.max(0, state.finance.cash) / burn);
}
