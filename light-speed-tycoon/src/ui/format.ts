// Display formatting for the HUD, cards and toasts.

import type { BuildStage, CableMethod, ParcelKind, StreetClass } from '../sim/types';

/** 12400 -> "12,400" */
export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

/** Whole dollars: 12400 -> "$12,400", -3000 -> "-$3,000". */
export function formatMoney(amount: number): string {
  const rounded = Math.round(amount);
  return `${rounded < 0 ? '-' : ''}$${formatNumber(Math.abs(rounded))}`;
}

/** Signed dollars with an explicit plus: "+$1,200" / "-$300" / "$0". */
export function formatSignedMoney(amount: number): string {
  const rounded = Math.round(amount);
  return rounded > 0 ? `+${formatMoney(rounded)}` : formatMoney(rounded);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatNumber(n)} ${n === 1 ? one : many}`;
}

export function formatFeet(ft: number): string {
  return `${formatNumber(ft)} ft`;
}

/** "14-45 days", or "10 days" when the range is a single value. */
export function formatDayRange(min: number, max: number): string {
  return min === max ? plural(min, 'day') : `${formatNumber(min)}–${plural(max, 'day')}`;
}

export const METHOD_LABEL: Record<CableMethod, string> = {
  aerial: 'Aerial',
  underground: 'Underground',
};

export const CLASS_LABEL: Record<StreetClass, string> = {
  arterial: 'Arterial',
  collector: 'Collector',
  local: 'Local street',
};

export const KIND_LABEL: Record<ParcelKind, string> = {
  home: 'Home',
  mdu: 'Apartment building',
  smb: 'Small business',
};

const STAGE_LABEL: Record<BuildStage, string> = {
  permitting: 'Permitting',
  constructing: 'Under construction',
  live: 'Live',
};

/** "Permitting, 12 days left" / "Live" */
export function formatStage(stage: BuildStage, daysLeft: number): string {
  return stage === 'live' ? STAGE_LABEL.live : `${STAGE_LABEL[stage]}, ${plural(daysLeft, 'day')} left`;
}

/** Dollars per foot with cents: 14.2 -> "$14.20/ft". */
export function formatPerFt(dollarsPerFt: number): string {
  return `$${dollarsPerFt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/ft`;
}

/** A 0..1 fraction as a whole percent: 0.384 -> "38%". */
export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

/** A KPI that may be missing (no passings, a v1-era report): whole dollars or an en dash. */
export function formatMaybeMoney(amount: number | null): string {
  return amount === null ? '–' : formatMoney(amount);
}

/** An annual rate in basis points: 725 -> "7.25%". */
export function formatRate(bps: number): string {
  const rounded = Math.round(bps);
  const sign = rounded < 0 ? '-' : '';
  const abs = Math.abs(rounded);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`;
}

/** A spread in basis points with an explicit sign: 150 -> "+1.50%", -25 -> "-0.25%", 0 -> "+0.00%". */
export function formatBpsDelta(bps: number): string {
  const text = formatRate(bps);
  return text.startsWith('-') ? text : `+${text}`;
}

/** A multiple such as leverage or coverage: 4.123 -> "4.12×"; null (not measurable) -> "–". */
export function formatRatio(x: number | null): string {
  if (x === null || !Number.isFinite(x)) return '–';
  const hundredths = Math.round(x * 100);
  const sign = hundredths < 0 ? '-' : '';
  const abs = Math.abs(hundredths);
  return `${sign}${formatNumber(Math.floor(abs / 100))}.${String(abs % 100).padStart(2, '0')}×`;
}

// Round 4 (ui-briefing): the month-end briefing's titles and finer rates.

export const MONTH_NAMES: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "March 2028" */
export function formatMonthLong(year: number, month: number): string {
  return `${MONTH_NAMES[month - 1] ?? '?'} ${year}`;
}

/**
 * A 0..1 fraction as a percent that keeps small rates readable (up to two
 * decimals, trailing zeros dropped): 0.06 -> "6%", 0.002 -> "0.2%",
 * 0.0125 -> "1.25%". formatPercent rounds to whole percents.
 */
export function formatPercentFine(fraction: number): string {
  const percent = Number((fraction * 100).toFixed(2));
  return `${percent.toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
}

/** A change in a 0..1 ratio as percentage points, unsigned, one decimal: 0.021 -> "2.1 pts", 0.01 -> "1.0 pt". */
export function formatPoints(fractionDelta: number): string {
  const tenths = Math.round(Math.abs(fractionDelta) * 1000);
  return `${Math.floor(tenths / 10)}.${tenths % 10} ${tenths === 10 ? 'pt' : 'pts'}`;
}

/** "1 in 60" for a chance of 1/60 (rounded to a whole "in"). */
export function formatOdds(chance: number): string {
  return chance > 0 ? `1 in ${formatNumber(1 / chance)}` : 'never';
}
