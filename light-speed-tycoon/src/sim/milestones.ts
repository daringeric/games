// Scorecard milestones. Achievements are saved in GameState.milestones (id +
// day, each id at most once, in the order achieved); definitions live here.
//
// Owner: sim-economy workstream. MILESTONES (ids, titles, descriptions) is
// part of the contract so the UI can list them; checkMilestones is a stub.

import { CPP_TARGET } from './balance';
import { operatingCashFlow, reportKpis } from './metrics';
import type { ReportKpis } from './metrics';
import { postNotice } from './notices';
import type { GameState, MilestoneId, MilestoneRecord, MonthlyReport } from './types';

// Thresholds are part of each milestone's definition (its title and
// description quote them), not balance knobs.
const EFFICIENT_PASSINGS = 1_000;
const FIRST_SUBSCRIBERS = 100;
const MANY_SUBSCRIBERS = 1_000;
const FAVORITE_TAKE_RATE = 0.3;
const FAVORITE_PASSINGS = 500;

export interface MilestoneDef {
  id: MilestoneId;
  /** Short title for the milestones panel and the achievement toast. */
  title: string;
  /** What it takes, in one sentence. */
  description: string;
}

/** Every milestone, in the order the milestones panel lists them. */
export const MILESTONES: readonly MilestoneDef[] = [
  { id: 'firstLight', title: 'First light', description: 'Pass your first home.' },
  {
    id: 'passings1000UnderTarget',
    title: 'Efficient builder',
    description: 'Close a month with 1,000 or more passings and a cost per passing at or under target.',
  },
  { id: 'subscribers100', title: 'First hundred', description: 'Close a month with 100 subscribers.' },
  { id: 'cashFlowPositive', title: 'In the black', description: 'Close a month with positive operating cash flow.' },
  { id: 'subscribers1000', title: 'A thousand strong', description: 'Close a month with 1,000 subscribers.' },
  {
    id: 'takeRate30',
    title: 'Neighborhood favorite',
    description: 'Close a month with a 30% take rate on at least 500 passings.',
  },
];

/**
 * Called by the month close right after `report` is appended (so
 * state.finance.reports.at(-1) === report). Appends a MilestoneRecord dated
 * state.day for every milestone not yet achieved whose condition the report
 * meets, posts a 'milestone' notice for each, and returns the new records
 * (in MILESTONES order). Conditions (all evaluated on the report, using
 * metrics.reportKpis; a report without stats can only earn firstLight):
 *   firstLight              report.passings >= 1
 *   passings1000UnderTarget report.passings >= 1000 and kpis.cpp <= CPP_TARGET
 *   subscribers100          stats.subscribers >= 100
 *   cashFlowPositive        operatingCashFlow(report) > 0
 *   subscribers1000         stats.subscribers >= 1000
 *   takeRate30              report.passings >= 500 and kpis.takeRate >= 0.3
 */
export function checkMilestones(state: GameState, report: MonthlyReport): MilestoneRecord[] {
  const achieved = new Set<MilestoneId>(state.milestones.map((m) => m.id));
  const kpis = reportKpis(report);
  const earned: MilestoneRecord[] = [];
  for (const def of MILESTONES) {
    if (achieved.has(def.id) || !meets(def.id, report, kpis)) continue;
    const record: MilestoneRecord = { id: def.id, day: state.day };
    state.milestones.push(record);
    earned.push(record);
    achieved.add(def.id);
    postNotice(state, 'milestone', `Milestone: ${def.title}`, { milestone: def.id });
  }
  return earned;
}

function meets(id: MilestoneId, report: MonthlyReport, kpis: ReportKpis | null): boolean {
  if (id === 'firstLight') return report.passings >= 1;
  // Everything else needs a round-2 report (one with stats).
  if (!kpis || !report.stats) return false;
  switch (id) {
    case 'passings1000UnderTarget':
      return report.passings >= EFFICIENT_PASSINGS && kpis.cpp !== null && kpis.cpp <= CPP_TARGET;
    case 'subscribers100':
      return report.stats.subscribers >= FIRST_SUBSCRIBERS;
    case 'cashFlowPositive':
      return operatingCashFlow(report) > 0;
    case 'subscribers1000':
      return report.stats.subscribers >= MANY_SUBSCRIBERS;
    case 'takeRate30':
      return report.passings >= FAVORITE_PASSINGS && kpis.takeRate !== null && kpis.takeRate >= FAVORITE_TAKE_RATE;
  }
}
