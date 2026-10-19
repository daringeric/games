import { describe, expect, it } from 'vitest';
import { dateOf, dayOf, formatDate, formatMonth, isFirstOfMonth } from './calendar';

describe('calendar', () => {
  it('maps day 0 to Jan 1 2027', () => {
    expect(dateOf(0)).toEqual({ year: 2027, month: 1, day: 1 });
    expect(formatDate(0)).toBe('Jan 1, 2027');
  });

  it('handles month and year boundaries', () => {
    expect(dateOf(30)).toEqual({ year: 2027, month: 1, day: 31 });
    expect(dateOf(31)).toEqual({ year: 2027, month: 2, day: 1 });
    expect(dateOf(58)).toEqual({ year: 2027, month: 2, day: 28 });
    expect(dateOf(59)).toEqual({ year: 2027, month: 3, day: 1 });
    expect(dateOf(364)).toEqual({ year: 2027, month: 12, day: 31 });
    expect(dateOf(365)).toEqual({ year: 2028, month: 1, day: 1 });
  });

  it('round-trips every day for three years', () => {
    for (let d = 0; d < 365 * 3; d++) expect(dayOf(dateOf(d))).toBe(d);
  });

  it('finds month starts', () => {
    const starts = [];
    for (let d = 0; d < 365; d++) if (isFirstOfMonth(d)) starts.push(d);
    expect(starts).toEqual([0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]);
  });

  it('formats months and rejects bad input', () => {
    expect(formatMonth(2027, 3)).toBe('Mar 2027');
    expect(() => dateOf(-1)).toThrow(RangeError);
    expect(() => dateOf(1.5)).toThrow(RangeError);
    expect(() => dayOf({ year: 2027, month: 2, day: 29 })).toThrow(RangeError);
  });
});
