import { describe, expect, it } from 'vitest';
import {
  formatBpsDelta,
  formatDayRange,
  formatMaybeMoney,
  formatMoney,
  formatPercent,
  formatPerFt,
  formatRate,
  formatRatio,
  formatSignedMoney,
  formatStage,
  plural,
} from './format';

describe('format', () => {
  it('formats whole dollars with separators and a leading minus', () => {
    expect(formatMoney(1_500_000)).toBe('$1,500,000');
    expect(formatMoney(-3000)).toBe('-$3,000');
    expect(formatMoney(0)).toBe('$0');
    expect(formatSignedMoney(1200)).toBe('+$1,200');
    expect(formatSignedMoney(-6)).toBe('-$6');
    expect(formatSignedMoney(0)).toBe('$0');
  });

  it('pluralizes counts', () => {
    expect(plural(1, 'span')).toBe('1 span');
    expect(plural(2, 'span')).toBe('2 spans');
    expect(plural(1200, 'day')).toBe('1,200 days');
  });

  it('formats day ranges and build stages', () => {
    expect(formatDayRange(14, 45)).toBe('14–45 days');
    expect(formatDayRange(10, 10)).toBe('10 days');
    expect(formatStage('permitting', 12)).toBe('Permitting, 12 days left');
    expect(formatStage('constructing', 1)).toBe('Under construction, 1 day left');
    expect(formatStage('live', 0)).toBe('Live');
  });

  it('formats per-foot rates, percents and missing KPIs', () => {
    expect(formatPerFt(14.2)).toBe('$14.20/ft');
    expect(formatPerFt(1234.5)).toBe('$1,234.50/ft');
    expect(formatPercent(0.384)).toBe('38%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatMaybeMoney(520.4)).toBe('$520');
    expect(formatMaybeMoney(null)).toBe('–');
  });

  it('formats interest rates and spreads from basis points', () => {
    expect(formatRate(725)).toBe('7.25%');
    expect(formatRate(500)).toBe('5.00%');
    expect(formatRate(5)).toBe('0.05%');
    expect(formatRate(0)).toBe('0.00%');
    expect(formatRate(1250)).toBe('12.50%');
    expect(formatBpsDelta(150)).toBe('+1.50%');
    expect(formatBpsDelta(0)).toBe('+0.00%');
    expect(formatBpsDelta(-25)).toBe('-0.25%');
  });

  it('formats leverage and coverage multiples, with an en dash when not measurable', () => {
    expect(formatRatio(4.123)).toBe('4.12×');
    expect(formatRatio(5)).toBe('5.00×');
    expect(formatRatio(1.2)).toBe('1.20×');
    expect(formatRatio(0)).toBe('0.00×');
    expect(formatRatio(-0.456)).toBe('-0.46×');
    expect(formatRatio(1234.5)).toBe('1,234.50×');
    expect(formatRatio(null)).toBe('–');
    expect(formatRatio(Number.POSITIVE_INFINITY)).toBe('–');
  });
});
