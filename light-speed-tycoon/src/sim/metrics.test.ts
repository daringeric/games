import { describe, expect, it } from 'vitest';
import { CPP_AMBER_MULTIPLIER, CPP_TARGET } from './balance';
import { CAPEX_CATEGORIES, cppBand, FINANCING_CATEGORIES, operatingCashFlow, passingsWeightedRate, reportKpis } from './metrics';
import type { MonthlyReport, MonthlyStats } from './types';

function stats(overrides: Partial<MonthlyStats> = {}): MonthlyStats {
  return {
    subscribers: 200,
    accounts: 180,
    // June: 190 subscribers on average over its 30 days.
    subscriberDays: 190 * 30,
    grossAdds: 40,
    churned: 3,
    lostService: 0,
    connectsTotal: 250,
    capexOsp: 600_000,
    capexConnect: 212_500,
    capexCo: 18_000,
    ponPortsUsed: 9,
    ponPorts: 16,
    fullCabinets: 1,
    ...overrides,
  };
}

function report(overrides: Partial<MonthlyReport> = {}): MonthlyReport {
  const totals = overrides.totals ?? {
    revenue: 14_000,
    construction: -50_000,
    equipment: -3_000,
    install: -34_000,
    refund: 2_000,
    poleRent: -300,
    overhead: -15_800,
    marketing: -2_000,
  };
  const net = Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);
  return { year: 2027, month: 6, totals, net, cashEnd: 500_000, passings: 800, stats: stats(), ...overrides };
}

describe('cppBand', () => {
  it('is green at or under target, amber up to the multiplier, red above', () => {
    expect(cppBand(0)).toBe('green');
    expect(cppBand(CPP_TARGET)).toBe('green');
    expect(cppBand(CPP_TARGET + 0.01)).toBe('amber');
    expect(cppBand(CPP_TARGET * CPP_AMBER_MULTIPLIER)).toBe('amber');
    expect(cppBand(CPP_TARGET * CPP_AMBER_MULTIPLIER + 0.01)).toBe('red');
  });

  it('treats nonsense as red', () => {
    expect(cppBand(Number.NaN)).toBe('red');
    expect(cppBand(Number.POSITIVE_INFINITY)).toBe('red');
    expect(cppBand(-1)).toBe('red');
  });
});

describe('operatingCashFlow', () => {
  it('is net cash flow without capital spend or its refunds', () => {
    const r = report();
    const capex = CAPEX_CATEGORIES.reduce((s, c) => s + (r.totals[c] ?? 0), 0);
    expect(operatingCashFlow(r)).toBe(r.net - capex);
    expect(operatingCashFlow(r)).toBe(14_000 - 300 - 15_800 - 2_000);
  });

  it('covers exactly construction, equipment, install and refund', () => {
    expect([...CAPEX_CATEGORIES].sort()).toEqual(['construction', 'equipment', 'install', 'refund']);
  });

  it('leaves out financing too: interest, principal and money borrowed (round 3)', () => {
    expect([...FINANCING_CATEGORIES].sort()).toEqual(['interest', 'loanProceeds', 'principal']);
    const plain = report();
    const totals = { ...plain.totals, interest: -1_200, principal: -3_000, loanProceeds: 50_000 };
    const net = Object.values(totals).reduce((a, b) => a + (b ?? 0), 0);
    const levered = report({ totals, net });
    expect(levered.net).toBe(plain.net - 1_200 - 3_000 + 50_000);
    expect(operatingCashFlow(levered)).toBe(operatingCashFlow(plain));
  });

  it('works on reports without stats (migrated from v1) and empty months', () => {
    const v1: MonthlyReport = { year: 2027, month: 1, totals: { construction: -9_000, poleRent: -20 }, net: -9_020, cashEnd: 1, passings: 4 };
    expect(operatingCashFlow(v1)).toBe(-20);
    expect(operatingCashFlow({ ...v1, totals: {}, net: 0 })).toBe(0);
  });
});

describe('reportKpis', () => {
  it('derives every KPI from the report', () => {
    const r = report();
    expect(reportKpis(r)).toEqual({
      revenue: 14_000,
      // Revenue over the month's average subscribers, not its month-end count.
      arpu: 14_000 / 190,
      cpga: 2_000 / 40,
      takeRate: 200 / 800,
      cpp: 600_000 / 800,
      cppBand: cppBand(600_000 / 800),
      costPerConnection: 212_500 / 250,
      operatingCashFlow: operatingCashFlow(r),
    });
  });

  it('is null for a report without stats', () => {
    const { stats: _omit, ...v1 } = report();
    expect(reportKpis(v1)).toBeNull();
  });

  it('uses null for every ratio with a zero denominator', () => {
    const r = report({ totals: {}, net: 0, passings: 0, stats: stats({ subscribers: 0, subscriberDays: 0, grossAdds: 0, connectsTotal: 0, capexConnect: 0 }) });
    expect(reportKpis(r)).toEqual({
      revenue: 0,
      arpu: null,
      cpga: null,
      takeRate: null,
      cpp: null,
      cppBand: null,
      costPerConnection: null,
      operatingCashFlow: 0,
    });
  });

  it('reports zero CPGA when gross adds came without marketing', () => {
    const r = report({ totals: { revenue: 100 }, net: 100 });
    expect(reportKpis(r)?.cpga).toBe(0);
  });

  it('bands the cost per passing', () => {
    const at = (capexOsp: number) => reportKpis(report({ passings: 1_000, stats: stats({ capexOsp }) }))!;
    expect(at(CPP_TARGET * 1_000).cppBand).toBe('green');
    expect(at(CPP_TARGET * CPP_AMBER_MULTIPLIER * 1_000).cppBand).toBe('amber');
    expect(at(CPP_TARGET * CPP_AMBER_MULTIPLIER * 1_000 + 1).cppBand).toBe('red');
  });
});

describe('passingsWeightedRate', () => {
  it("weights each group's rate by its units", () => {
    expect(passingsWeightedRate([{ units: 300, rate: 0.5 }, { units: 100, rate: 0.3 }])).toBeCloseTo((300 * 0.5 + 100 * 0.3) / 400, 12);
    expect(passingsWeightedRate([{ units: 10, rate: 0.42 }])).toBeCloseTo(0.42, 12);
  });

  it('ignores groups with no units, and is null with none at all', () => {
    expect(passingsWeightedRate([{ units: 0, rate: 0.9 }, { units: 5, rate: 0.2 }])).toBeCloseTo(0.2, 12);
    expect(passingsWeightedRate([{ units: 0, rate: 0.9 }])).toBeNull();
    expect(passingsWeightedRate([])).toBeNull();
  });
});
