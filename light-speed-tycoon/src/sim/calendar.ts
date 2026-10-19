// Game calendar. Day 0 is Jan 1 of START_YEAR. Years are 365 days with real
// month lengths and no leap years, so dates are pure arithmetic.

const NOT_IMPLEMENTED = 'not implemented';

export interface GameDate {
  year: number;
  /** 1..12 */
  month: number;
  /** 1..31 */
  day: number;
}

export const DAYS_PER_YEAR = 365;
export const MONTH_LENGTHS: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const MONTH_ABBR: readonly string[] = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Calendar date of a game day (day >= 0). */
export function dateOf(day: number): GameDate {
  void day;
  throw new Error(NOT_IMPLEMENTED);
}

/** Inverse of dateOf. */
export function dayOf(date: GameDate): number {
  void date;
  throw new Error(NOT_IMPLEMENTED);
}

/** True when `day` is the 1st of a month (day 0 included). */
export function isFirstOfMonth(day: number): boolean {
  void day;
  throw new Error(NOT_IMPLEMENTED);
}

/** "Mar 4, 2027" */
export function formatDate(day: number): string {
  void day;
  throw new Error(NOT_IMPLEMENTED);
}

/** "Mar 2027" */
export function formatMonth(year: number, month: number): string {
  void year;
  void month;
  throw new Error(NOT_IMPLEMENTED);
}
