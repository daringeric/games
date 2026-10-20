// Balance report: the per-seed numbers behind targets.test.ts, printed only
// when asked for (otherwise this file is a trivial pass):
//
//   TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts
//
// Optional: TUNE_SEEDS=1,2,3 (default TUNING_SEEDS), TUNE_MONTHS=60.

import { describe, expect, it } from 'vitest';
import { CPP_TARGET, START_CASH } from '../balance';
import { newGame } from '../game';
import { carelessBot, idleBot, leveredBot, ruralBot, smartBot } from './bots';
import {
  averageArpu,
  averageBorrowingRate,
  averageChurn,
  cppProbes,
  firstPositiveMonth,
  median,
  missedPaymentMonths,
  passedShare,
  peakDebt,
  redWhileOwingShare,
  runBot,
  stageHistory,
  townBuildOut,
  townFacts,
  TUNING_SEEDS,
  worstStage,
} from './harness';
import type { RunResult } from './harness';

const ENABLED = process.env.TUNE_REPORT === '1';
const SEEDS: readonly number[] = process.env.TUNE_SEEDS
  ? process.env.TUNE_SEEDS.split(',').map((s) => Number(s.trim()))
  : TUNING_SEEDS;
const MONTHS = Number(process.env.TUNE_MONTHS ?? 60);
/** Months shown in the per-seed table. */
const SHOWN_MONTHS = [1, 3, 6, 9, 12, 15, 18, 24, 30, 36, 48, 60];
/** Months shown in the per-seed financing table. */
const DEBT_MONTHS = [12, 24, 36, 48, 60];

const dollars = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `$${Math.round(n).toLocaleString('en-US')}`);
const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '-' : `${(n * 100).toFixed(digits)}%`);
const num = (n: number | null | undefined) => (n === null || n === undefined ? '-' : String(n));
const bps = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${(n / 100).toFixed(2)}%`);
const times = (x100: number | null | undefined) => (x100 === null || x100 === undefined ? '-' : `${(x100 / 100).toFixed(2)}x`);
const stages = (run: RunResult) => stageHistory(run).map(([m, stage]) => `m${m} ${stage}`).join(', ') || 'compliant throughout';
const gameOverText = (run: RunResult) => (run.gameOver ? `${run.gameOver.reason} m${run.gameOverMonth}` : 'alive');

function table(rows: Array<Record<string, string>>): string {
  const first = rows[0];
  if (!first) return '';
  const keys = Object.keys(first);
  const width = keys.map((k) => Math.max(k.length, ...rows.map((r) => (r[k] ?? '').length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padStart(width[i] as number)).join('  ');
  return [line(keys), ...rows.map((r) => line(keys.map((k) => r[k] ?? '')))].join('\n');
}

function monthTable(run: RunResult): string {
  return table(
    SHOWN_MONTHS.filter((m) => m <= run.reports.length).map((m) => {
      const report = run.reports[m - 1]!;
      const kpis = run.kpis[m - 1]!;
      return {
        month: String(m),
        cash: dollars(report.cashEnd),
        passings: num(report.passings),
        subs: num(report.stats?.subscribers),
        take: pct(kpis.takeRate),
        cpp: dollars(kpis.cpp),
        'op cash flow': dollars(kpis.operatingCashFlow),
        'net cash flow': dollars(report.net),
        pon: `${report.stats?.ponPortsUsed ?? '-'}/${report.stats?.ponPorts ?? '-'}`,
      };
    }),
  );
}

function debtTable(run: RunResult): string {
  return table(
    DEBT_MONTHS.filter((m) => m <= run.reports.length).map((m) => {
      const debt = run.reports[m - 1]!.debt;
      return {
        month: String(m),
        line: dollars(debt?.creditBalance),
        limit: dollars(debt?.creditLimit),
        term: dollars(debt?.termBalance),
        arr: dollars(debt?.arr),
        'ann. op cash flow': dollars(debt?.annualOperatingCashFlow),
        leverage: times(debt?.leverageX100),
        coverage: times(debt?.coverageX100),
        rate: bps(debt?.averageRateBps),
        stage: debt?.stage ?? '-',
      };
    }),
  );
}

describe('balance report', () => {
  it.runIf(!ENABLED)('prints nothing unless TUNE_REPORT=1', () => {
    expect(ENABLED).toBe(false);
  });

  it.runIf(ENABLED)(
    'prints the per-seed numbers behind every balance target',
    () => {
      const summary: Array<Record<string, string>> = [];
      const out: string[] = [];
      for (const seed of SEEDS) {
        const city = newGame(seed).city;
        const facts = townFacts(city);
        const buildOut = townBuildOut(city);
        const probes = cppProbes(seed);
        const smart = runBot(seed, smartBot(), MONTHS, { clock: () => performance.now() });
        const noDebt = runBot(seed, smartBot({ borrow: false }), MONTHS);
        const levered = runBot(seed, leveredBot(), MONTHS);
        const rural = runBot(seed, ruralBot(), MONTHS);
        const careless = runBot(seed, carelessBot, Math.min(36, MONTHS));
        const idle = runBot(seed, idleBot, Math.min(24, MONTHS));
        const k36 = smart.kpis[35];
        const last = smart.reports.length;
        out.push(
          `\n=== seed ${seed}: ${facts.unitsDay0} units (${facts.unitsFull} at full growth), ` +
            `${Math.round(facts.streetFt).toLocaleString('en-US')} ft of street, ${pct(facts.poledShare, 0)} poled, ${pct(facts.rockShare, 0)} rock; ` +
            `ft per unit residential ${facts.ftPerUnit.residential?.toFixed(0)}, downtown ${facts.ftPerUnit.downtown?.toFixed(0)}, rural ${facts.ftPerUnit.rural?.toFixed(0)}`,
          `build-out ${dollars(buildOut.total)} (cable ${dollars(buildOut.cable)}, fees ${dollars(buildOut.fees)}, ` +
            `${buildOut.cabinets} cabinets ${dollars(buildOut.cabinetCost)}): start cash covers ${pct(START_CASH / buildOut.total)}`,
          `SMART (${smart.ms.toFixed(0)} ms): commands ${JSON.stringify(smart.commands)}, rejected ${smart.rejected}, ` +
            `game over ${smart.gameOverMonth ?? 'never'}`,
          monthTable(smart),
          `SMART financing: peak debt ${dollars(peakDebt(smart))}, average rate ${bps(averageBorrowingRate(smart))}, ` +
            `stages: ${stages(smart)}, missed payments: ${missedPaymentMonths(smart).join(', ') || 'none'}; ` +
            `borrowing capacity after month 3 ${dollars(smart.capacityAfterClose[2])}`,
          debtTable(smart),
          `Passed at month ${last}: ${pct(passedShare(smart, last))} of the town with loans, ${pct(passedShare(noDebt, last))} without ` +
            `(${num(smart.reports.at(-1)?.passings)} vs ${num(noDebt.reports.at(-1)?.passings)} units)`,
          `LEVERED: ${gameOverText(levered)}, peak debt ${dollars(peakDebt(levered))}, stages: ${stages(levered)}, ` +
            `missed payments: ${missedPaymentMonths(levered).join(', ') || 'none'}`,
          `RURAL: ${gameOverText(rural)}, peak debt ${dollars(peakDebt(rural))}, average rate ${bps(averageBorrowingRate(rural))} ` +
            `(${bps(averageBorrowingRate(rural, true))} without penalty months), red cost per passing at ${pct(redWhileOwingShare(rural), 0)} of month ends with debt`,
          `CARELESS: game over ${careless.gameOverMonth === null ? 'never' : `month ${careless.gameOverMonth} (${careless.gameOver?.reason})`}; ` +
            `IDLE: ${idle.gameOver ? `game over month ${idle.gameOverMonth}` : `alive at month ${idle.reports.length}, ${dollars(idle.state.finance.cash)}`}`,
        );
        summary.push({
          seed: String(seed),
          'cash share': pct(START_CASH / buildOut.total),
          'cpp aerial': dollars(median(probes.denseAerial.map((p) => p.cpp))),
          'cpp ugnd': dollars(median(probes.denseUnderground.map((p) => p.cpp))),
          'cpp rural': dollars(median(probes.rural.map((p) => p.cpp))),
          'cf+ month': num(firstPositiveMonth(smart)),
          'take m36': pct(k36?.takeRate),
          arpu: dollars(averageArpu(smart)),
          churn: pct(averageChurn(smart), 2),
          'cpp m36': dollars(k36?.cpp),
          'cpp m60': dollars(smart.kpis[59]?.cpp),
          splitter: num(smart.firstMonth.addSplitter ?? null),
          'olt card': num(smart.firstMonth.addOltCard ?? null),
          'pass m60': num(smart.reports[59]?.passings),
          share: pct(passedShare(smart, last)),
          'no loans': pct(passedShare(noDebt, last)),
          'peak debt': dollars(peakDebt(smart)),
          rate: bps(averageBorrowingRate(smart)),
          worst: worstStage(smart),
          missed: String(missedPaymentMonths(smart).length),
          'cap m3': dollars(smart.capacityAfterClose[2]),
          levered: gameOverText(levered),
          'rural rate': bps(averageBorrowingRate(rural)),
          careless: careless.gameOverMonth === null ? 'alive' : `bust m${careless.gameOverMonth}`,
          idle: idle.gameOver ? `bust m${idle.gameOverMonth}` : 'alive',
          ms: smart.ms.toFixed(0),
        });
      }
      out.push(
        `\n=== summary (targets: cash share 25-33% mean, cpp aerial $400-600, underground $850-1,150, rural >= ${dollars(2.5 * CPP_TARGET)}, ` +
          `cash-flow positive month 12-18 median, take 30-45%, ARPU $60-80, churn 0.8-2%, cpp <= ${dollars(CPP_TARGET)} at months 36 and 60; ` +
          `share passed at month 60 >= 50% (median 50-70%), 15+ points over no loans; peak debt >= ${dollars(0.4 * START_CASH)}; ` +
          `rate 6-11%, rural >= SMART + 1%; worst stage warning; no missed payments; capacity after month 3 <= ${dollars(0.1 * START_CASH)}; ` +
          `LEVERED defaults on 4+ of 5)`,
        table(summary),
      );
      // Straight to stdout: the default reporter hides console.log of passing tests.
      process.stdout.write(`${out.join('\n')}\n`);
      expect(summary.length).toBe(SEEDS.length);
    },
    600_000,
  );
});
