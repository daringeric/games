// Cash, ledger and monthly close.

import { POLE_RENT_PER_POLE_PER_MONTH } from './balance';
import { dateOf, formatMonth } from './calendar';
import { polesOnSegment } from './streets';
import type { GameState, LedgerCategory, LedgerEntry, MonthlyReport } from './types';

// Order of category totals in a report; the Record type keeps it exhaustive
// when categories are added.
const CATEGORY_ORDER: Record<LedgerCategory, number> = {
  revenue: 0,
  construction: 1,
  equipment: 2,
  refund: 3,
  poleRent: 4,
  payroll: 5,
  marketing: 6,
  interest: 7,
  other: 8,
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
 * Close the month that just ended. Called by tick() when the new day is the 1st
 * of a month (never for day 0). Posts that month's recurring charges (pole rent)
 * dated the last day of the ended month, totals monthToDate into a MonthlyReport
 * labelled with the ended month's year/month, appends it to finance.reports,
 * clears monthToDate and returns the report.
 */
export function closeMonth(state: GameState, passings: number): MonthlyReport {
  const lastDay = state.day - 1;
  // Throws for day 0: no month has ended yet.
  const ended = dateOf(lastDay);

  const poles = rentedPoles(state);
  if (poles > 0) {
    record(state, {
      day: lastDay,
      category: 'poleRent',
      amount: -poles * POLE_RENT_PER_POLE_PER_MONTH,
      memo: `Pole rent for ${formatMonth(ended.year, ended.month)}: ${groupThousands(poles)} poles x ${formatMoney(POLE_RENT_PER_POLE_PER_MONTH)}`,
    });
  }

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

  const report: MonthlyReport = {
    year: ended.year,
    month: ended.month,
    totals,
    net,
    cashEnd: state.finance.cash,
    passings,
  };
  state.finance.reports.push(report);
  state.finance.monthToDate = [];
  return report;
}
