// Game calendar. Day 0 is Jan 1 of START_YEAR. Years are 365 days with real
// month lengths and no leap years, so dates are pure arithmetic.

import { START_YEAR } from './balance';

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

/** Day-of-year on which each month starts (0-based). */
const MONTH_STARTS: readonly number[] = MONTH_LENGTHS.reduce<number[]>((starts, _len, i) => {
  starts.push(i === 0 ? 0 : (starts[i - 1] as number) + (MONTH_LENGTHS[i - 1] as number));
  return starts;
}, []);

function assertDay(day: number): void {
  if (!Number.isInteger(day) || day < 0) throw new RangeError(`Invalid game day: ${day}`);
}

/** Calendar date of a game day (day >= 0). */
export function dateOf(day: number): GameDate {
  assertDay(day);
  const year = START_YEAR + Math.floor(day / DAYS_PER_YEAR);
  const doy = day % DAYS_PER_YEAR;
  let month = 11;
  while ((MONTH_STARTS[month] as number) > doy) month--;
  return { year, month: month + 1, day: doy - (MONTH_STARTS[month] as number) + 1 };
}

/** Inverse of dateOf. */
export function dayOf(date: GameDate): number {
  const start = MONTH_STARTS[date.month - 1];
  const len = MONTH_LENGTHS[date.month - 1];
  if (start === undefined || len === undefined || date.day < 1 || date.day > len || date.year < START_YEAR) {
    throw new RangeError(`Invalid game date: ${date.year}-${date.month}-${date.day}`);
  }
  return (date.year - START_YEAR) * DAYS_PER_YEAR + start + date.day - 1;
}

/** True when `day` is the 1st of a month (day 0 included). */
export function isFirstOfMonth(day: number): boolean {
  return dateOf(day).day === 1;
}

/** "Mar 4, 2027" */
export function formatDate(day: number): string {
  const d = dateOf(day);
  return `${MONTH_ABBR[d.month - 1]} ${d.day}, ${d.year}`;
}

/** "Mar 2027" */
export function formatMonth(year: number, month: number): string {
  return `${MONTH_ABBR[month - 1]} ${year}`;
}
