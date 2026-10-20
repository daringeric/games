// Scorecard math shared by quotes, previews, reports and the UI: cost-per-
// passing bands and the KPIs derived from a closed month. Everything here is
// a pure function of its arguments; nothing is saved.
//
// Owner: sim-economy workstream (cppBand is implemented by the contract so the
// network and UI workstreams can use it from day one).

import { CPP_AMBER_MULTIPLIER, CPP_TARGET } from './balance';
import { MONTH_LENGTHS } from './calendar';
import type { CppBand, LedgerCategory, MonthlyReport } from './types';

/**
 * Color band for a cost per passing (dollars per unit passed):
 * green <= CPP_TARGET, amber <= CPP_TARGET x CPP_AMBER_MULTIPLIER, red above.
 * Non-finite or negative input is treated as red (it means "no passings").
 */
export function cppBand(cpp: number): CppBand {
  if (!Number.isFinite(cpp) || cpp < 0) return 'red';
  if (cpp <= CPP_TARGET) return 'green';
  if (cpp <= CPP_TARGET * CPP_AMBER_MULTIPLIER) return 'amber';
  return 'red';
}

/** Ledger categories that are capital spend (or its refunds) rather than operating cash flow. */
export const CAPEX_CATEGORIES: readonly LedgerCategory[] = ['construction', 'equipment', 'install', 'refund'];

/** KPIs derived from one closed month. Ratios are plain fractions; money is unrounded dollars. */
export interface ReportKpis {
  /** totals.revenue ?? 0. */
  revenue: number;
  /**
   * revenue / average subscribers over the month (stats.subscriberDays / days
   * in the month), so a month of fast growth or heavy churn is not skewed by
   * the month-end count; null when nobody was billed.
   */
  arpu: number | null;
  /** Cost per gross add: -(totals.marketing ?? 0) / stats.grossAdds; null when there were no gross adds. */
  cpga: number | null;
  /** stats.subscribers / passings; null when passings is 0. */
  takeRate: number | null;
  /** Cost per passing: stats.capexOsp / passings (lifetime OSP capex over current passings); null when passings is 0. */
  cpp: number | null;
  cppBand: CppBand | null;
  /** stats.capexConnect / stats.connectsTotal; null when nothing has connected yet. */
  costPerConnection: number | null;
  /** operatingCashFlow(report). */
  operatingCashFlow: number;
}

/**
 * Net cash flow excluding capital spend: report.net minus the totals of
 * CAPEX_CATEGORIES (i.e. revenue - overhead - pole rent - marketing - payroll
 * - interest - other). This is the "cash-flow positive" of the milestone and
 * the tuning targets. Works on v1-migrated reports too (they have totals).
 */
export function operatingCashFlow(report: MonthlyReport): number {
  let capex = 0;
  for (const category of CAPEX_CATEGORIES) capex += report.totals[category] ?? 0;
  return report.net - capex;
}

/**
 * Every KPI of a closed month, or null for a report without `stats` (one
 * migrated from a schemaVersion 1 save): the UI shows "-" for those months.
 */
export function reportKpis(report: MonthlyReport): ReportKpis | null {
  const stats = report.stats;
  if (!stats) return null;
  const revenue = report.totals.revenue ?? 0;
  const cpp = report.passings > 0 ? stats.capexOsp / report.passings : null;
  return {
    revenue,
    arpu: stats.subscriberDays > 0 ? (revenue * (MONTH_LENGTHS[report.month - 1] ?? 30)) / stats.subscriberDays : null,
    // 0 - x, not -x: no marketing must read as 0, not -0.
    cpga: stats.grossAdds > 0 ? (0 - (report.totals.marketing ?? 0)) / stats.grossAdds : null,
    takeRate: report.passings > 0 ? stats.subscribers / report.passings : null,
    cpp,
    cppBand: cpp === null ? null : cppBand(cpp),
    costPerConnection: stats.connectsTotal > 0 ? stats.capexConnect / stats.connectsTotal : null,
    operatingCashFlow: operatingCashFlow(report),
  };
}
