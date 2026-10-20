import { describe, expect, it } from 'vitest';
import { CPP_TARGET } from './balance';
import { checkMilestones, MILESTONES } from './milestones';
import { makeTestState } from './testing/fixtures';
import type { GameState, LedgerCategory, MilestoneId, MonthlyReport, MonthlyStats } from './types';

function stats(overrides: Partial<MonthlyStats> = {}): MonthlyStats {
  return {
    subscribers: 0,
    accounts: 0,
    subscriberDays: 0,
    grossAdds: 0,
    churned: 0,
    lostService: 0,
    connectsTotal: 0,
    capexOsp: 0,
    capexConnect: 0,
    capexCo: 0,
    ponPortsUsed: 1,
    ponPorts: 16,
    fullCabinets: 0,
    ...overrides,
  };
}

function report(passings: number, s: Partial<MonthlyStats> | null, totals: Partial<Record<LedgerCategory, number>> = { overhead: -1 }): MonthlyReport {
  const net = Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);
  const r: MonthlyReport = { year: 2027, month: 3, totals, net, cashEnd: 1_000, passings };
  if (s) r.stats = stats(s);
  return r;
}

function check(r: MonthlyReport, state: GameState = makeTestState()): { state: GameState; earned: MilestoneId[] } {
  state.day = 90;
  state.finance.reports.push(r);
  return { state, earned: checkMilestones(state, r).map((m) => m.id) };
}

describe('checkMilestones', () => {
  it('lists every milestone once, firstLight first', () => {
    const ids = MILESTONES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('firstLight');
    expect(ids).toHaveLength(6);
  });

  it('earns firstLight for the first passing', () => {
    expect(check(report(0, {})).earned).toEqual([]);
    expect(check(report(1, {})).earned).toEqual(['firstLight']);
  });

  it('earns passings1000UnderTarget at 1,000 passings with CPP at or under target', () => {
    expect(check(report(1_000, { capexOsp: CPP_TARGET * 1_000 })).earned).toContain('passings1000UnderTarget');
    expect(check(report(1_000, { capexOsp: CPP_TARGET * 1_000 + 1 })).earned).not.toContain('passings1000UnderTarget');
    expect(check(report(999, { capexOsp: 0 })).earned).not.toContain('passings1000UnderTarget');
  });

  it('earns the subscriber milestones at 100 and 1,000', () => {
    expect(check(report(5_000, { subscribers: 99, capexOsp: 1e12 })).earned).toEqual(['firstLight']);
    expect(check(report(5_000, { subscribers: 100, capexOsp: 1e12 })).earned).toEqual(['firstLight', 'subscribers100']);
    expect(check(report(5_000, { subscribers: 1_000, capexOsp: 1e12 })).earned).toEqual(['firstLight', 'subscribers100', 'subscribers1000']);
  });

  it('earns cashFlowPositive on positive operating cash flow, whatever the capex', () => {
    const positive = report(0, {}, { revenue: 20_000, overhead: -15_000, construction: -500_000, install: -9_000 });
    expect(check(positive).earned).toEqual(['cashFlowPositive']);
    expect(check(report(0, {}, { revenue: 15_000, overhead: -15_000 })).earned).toEqual([]);
  });

  it('earns takeRate30 at a 30% take rate on at least 500 passings', () => {
    expect(check(report(500, { subscribers: 150, capexOsp: 1e12 })).earned).toContain('takeRate30');
    expect(check(report(500, { subscribers: 149, capexOsp: 1e12 })).earned).not.toContain('takeRate30');
    expect(check(report(499, { subscribers: 499, capexOsp: 1e12 })).earned).not.toContain('takeRate30');
  });

  it('records each milestone once, dated the close, with a notice', () => {
    const state = makeTestState();
    const first = check(report(1_200, { subscribers: 400, capexOsp: 0 }, { revenue: 30_000, overhead: -15_000 }), state);
    expect(first.earned).toEqual(['firstLight', 'passings1000UnderTarget', 'subscribers100', 'cashFlowPositive', 'takeRate30']);
    expect(state.milestones).toEqual(first.earned.map((id) => ({ id, day: 90 })));
    expect(state.notices.map((n) => [n.kind, n.milestone, n.message, n.day])).toEqual(
      first.earned.map((id) => ['milestone', id, `Milestone: ${MILESTONES.find((m) => m.id === id)!.title}`, 90]),
    );

    state.day = 120;
    const r = report(1_500, { subscribers: 1_100, capexOsp: 0 }, { revenue: 90_000 });
    state.finance.reports.push(r);
    expect(checkMilestones(state, r).map((m) => m.id)).toEqual(['subscribers1000']);
    expect(state.milestones.at(-1)).toEqual({ id: 'subscribers1000', day: 120 });
    expect(checkMilestones(state, r)).toEqual([]);
    expect(state.notices).toHaveLength(6);
  });

  it('only awards firstLight for a report without stats (migrated from v1)', () => {
    const v1 = report(5_000, null, { revenue: 1_000_000 });
    expect(check(v1).earned).toEqual(['firstLight']);
  });
});
