// Cash, ledger and monthly close.

import type { GameState, LedgerCategory, MonthlyReport } from './types';

const NOT_IMPLEMENTED = 'not implemented';

/** Record a signed amount (negative = spend) on today's ledger and apply it to cash. */
export function postEntry(state: GameState, category: LedgerCategory, amount: number, memo: string): void {
  void state;
  void category;
  void amount;
  void memo;
  throw new Error(NOT_IMPLEMENTED);
}

/** True when cash covers a non-negative cost. */
export function canAfford(state: GameState, cost: number): boolean {
  void state;
  void cost;
  throw new Error(NOT_IMPLEMENTED);
}

/** Pole rent owed for one month: live aerial spans x poles on their segments x POLE_RENT_PER_POLE_PER_MONTH. */
export function monthlyPoleRent(state: GameState): number {
  void state;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Close the month that just ended. Called by tick() when the new day is the 1st
 * of a month (never for day 0). Posts that month's recurring charges (pole rent)
 * dated the last day of the ended month, totals monthToDate into a MonthlyReport
 * labelled with the ended month's year/month, appends it to finance.reports,
 * clears monthToDate and returns the report.
 */
export function closeMonth(state: GameState, passings: number): MonthlyReport {
  void state;
  void passings;
  throw new Error(NOT_IMPLEMENTED);
}
