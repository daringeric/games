// SCRATCH (tuner exploration; deleted before handing over). EXPLORE=1 only.
import { describe, expect, it } from 'vitest';
import { newGame } from '../game';
import type { DifficultyId } from '../types';
import { advisorFollowerBot, allAerialBot, allUndergroundBot, smartBot, smartLiteBot } from './bots';
import * as Bots from './bots';
import {
  averageArpu,
  averageChurn,
  cumulativeOperatingCashFlow,
  finalPassedShare,
  firstPositiveMonth,
  medianMonthsToCeiling,
  missedPaymentMonths,
  opsTotals,
  peakDebt,
  runBot,
  runValue,
  takeOfAreasLit,
  undergroundShare,
  worstStage,
} from './harness';
import type { BotFactory, RunResult } from './harness';
import { constantPriceBot } from './harness';

const ENABLED = process.env.EXPLORE === '1';
const SEEDS = (process.env.SEEDS ?? '1,2027,424242,99,12345').split(',').flatMap((s) => {
  const [a, b] = s.split('-').map(Number);
  if (b === undefined) return [a as number];
  const out: number[] = [];
  for (let i = a as number; i <= b; i++) out.push(i);
  return out;
});
const DIFFS = (process.env.DIFFS ?? 'seed').split(',') as DifficultyId[];
const BOTS = (process.env.BOTS ?? 'smart').split(',');
const MONTHS = Number(process.env.MONTHS ?? 60);
const MODE = process.env.XMODE ?? 'runs';

function bot(name: string): BotFactory {
  switch (name) {
    case 'smart':
      return smartBot();
    case 'lite':
      return smartLiteBot();
    case 'follower':
      return advisorFollowerBot;
    case 'aerial':
      return allAerialBot();
    case 'underground':
      return allUndergroundBot();
    case 'casual':
      return Bots.casualBot();
    case 'discount':
      return Bots.discountBot();
    case 'overpriced':
      return Bots.overpricedBot();
    case 'levers':
      return Bots.smartLeversBot();
    case 'mixed':
      return Bots.mixedBot();
    default: {
      if (name.startsWith('x')) return constantPriceBot(smartBot(), Number(name.slice(1)));
      if (name === 'hiker') return Bots.priceHikerBot();
      if (name === 'ugl') return Bots.allUndergroundBot({ ...Bots.SMART_LEVERS_OPTIONS, name: 'ugl' });
      if (name === 'aerl') return Bots.allAerialBot({ ...Bots.SMART_LEVERS_OPTIONS, name: 'aerl' });
      if (name === 'camp') return smartBot({ campaigns: true, name: 'camp' });
      if (name === 'ref') return smartBot({ referrals: 'quote', name: 'ref' });
      if (name === 'hiker0') return Bots.priceHikerBot(0);
      if (name === 'aggressive') return Bots.aggressiveBot();
      if (name.startsWith('casualx')) return constantPriceBot(Bots.casualBot(), Number(name.slice(7)));
      const f = (Bots as unknown as Record<string, unknown>)[name];
      if (typeof f === 'function') return (f as () => BotFactory)();
      throw new Error(`unknown bot ${name}`);
    }
  }
}

const pct = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${(n * 100).toFixed(1)}%`);
const k = (n: number | null | undefined) => (n === null || n === undefined ? '-' : `${(n / 1000).toFixed(0)}k`);

function row(b: string, d: string, seed: number, run: RunResult): string {
  const ops = opsTotals(run);
  const last = run.kpis.at(-1);
  let minCash = Infinity;
  for (const r of run.reports) minCash = Math.min(minCash, r.cashEnd);
  const warn = run.notices.insolvencyWarning ?? 0;
  return [
    b.padEnd(10),
    d.padEnd(12),
    String(seed).padStart(6),
    (run.gameOver ? `${run.gameOver.reason}@${run.gameOverMonth}` : 'alive').padEnd(14),
    `cf+ ${String(firstPositiveMonth(run) ?? '-').padStart(3)}`,
    `share ${pct(run.gameOver ? 0 : finalPassedShare(run)).padStart(6)}`,
    `take36 ${pct(run.kpis[35]?.takeRate).padStart(6)}`,
    `take ${pct(last?.takeRate).padStart(6)}`,
    `a3-5 ${pct(takeOfAreasLit(run, 36, 60)).padStart(6)}`,
    `c80 ${String(medianMonthsToCeiling(run, 0.8, 36) ?? '-').padStart(3)}`,
    `c90 ${String(medianMonthsToCeiling(run, 0.9, 36) ?? '-').padStart(3)}`,
    `subs ${String(run.reports.at(-1)?.stats?.subscribers ?? 0).padStart(5)}`,
    `hap ${pct((run.reports.at(-1)?.customers?.happy ?? 0) / Math.max(1, run.reports.at(-1)?.stats?.subscribers ?? 0))}`,
    `ocf ${k(last?.operatingCashFlow).padStart(5)}`,
    `cumocf ${k(cumulativeOperatingCashFlow(run)).padStart(6)}`,
    `val ${k(runValue(run)).padStart(6)}`,
    `minC ${k(minCash).padStart(6)}`,
    `warn ${warn}`,
    `debt ${k(peakDebt(run)).padStart(5)}`,
    `${worstStage(run)}`.padEnd(10),
    `miss ${missedPaymentMonths(run).length}`,
    `rep ${pct(ops.revenue > 0 ? ops.repairs / ops.revenue : null)}`,
    `ug ${pct(undergroundShare(run))}`,
    `cpp36 ${Math.round(run.kpis[35]?.cpp ?? 0)}`,
    `cpp60 ${Math.round(run.kpis.at(-1)?.cpp ?? 0)}`,
    `arpu ${(averageArpu(run) ?? 0).toFixed(1)}`,
    `churn ${pct(averageChurn(run))}`,
    `promos ${run.incumbentPromos.length}`,
    `ppa ${Math.max(0, ...[...run.incumbentPromos.reduce((m, p) => m.set(p.cabinet, (m.get(p.cabinet) ?? 0) + 1), new Map<number, number>()).values()])}`,
    `pchurn ${ops.priceChurn}`,
    `loans ${run.commands.takeTermLoan ?? 0}`,
  ].join(' ');
}

describe.runIf(ENABLED && MODE === 'runs')('explore', () => {
  it('runs', () => {
    const lines: string[] = [];
    for (const b of BOTS) {
      for (const d of DIFFS) {
        for (const seed of SEEDS) {
          const run = runBot(seed, bot(b), MONTHS, { state: newGame(seed, { difficulty: d }) });
          lines.push(row(b, d, seed, run));
          process.stdout.write(`${lines.at(-1)}\n`);
        }
      }
    }
    expect(lines.length).toBeGreaterThan(0);
  }, 3_600_000);
});

describe.runIf(ENABLED && MODE !== 'runs')('experiments', () => {
  it('runs', () => {
    for (const seed of SEEDS) {
      let out: unknown;
      switch (MODE) {
        case 'forecast':
          out = Bots.MARKETING_FORECAST_MONTHS.map((m) => Bots.marketingForecastCheck(seed, m));
          break;
        case 'campaign':
          out = Bots.campaignExperiment(seed);
          break;
        case 'support':
          out = Bots.supportExperiment(seed);
          break;
        case 'referral':
          out = Bots.referralExperiment(seed);
          break;
        case 'answer':
          out = Bots.incumbentAnswerExperiment(seed);
          break;
        case 'fresh':
          out = Bots.freshPromoExperiment(seed);
          break;
        case 'switching': {
          const e = Bots.switchingExperiment(seed);
          out = Object.fromEntries((['standard', 'discount', 'overpriced'] as const).map((k) => [k, { m: e[k].monthsToCeiling, ceil: e[k].ceiling, take: e[k].take, t12: e[k].takes[11], t24: e[k].takes[23], arpu: e[k].arpu, rph: e[k].revenuePerHome, ocf: e[k].ocf }]));
          break;
        }
        case 'mature':
          out = Bots.maturePromoExperiment(seed);
          break;
        case 'mature2': {
          const start = runBot(seed, smartBot(), Bots.MATURE_PROMO_MONTH).state;
          const arm = (standingPromo: { percentOff: number; months: number } | null) => {
            const run = runBot(seed, smartBot({ maxProjectsPerLook: 0, incumbentAnswer: 'none', standingPromo }), Bots.MATURE_PROMO_MONTHS, { state: structuredClone(start) });
            const sum = (f: (r: (typeof run.reports)[number]) => number) => run.reports.reduce((a, r) => a + f(r), 0);
            return {
              ocf: cumulativeOperatingCashFlow(run),
              rev: sum((r) => r.totals.revenue ?? 0),
              adds: sum((r) => r.stats?.grossAdds ?? 0),
              churned: sum((r) => r.stats?.churned ?? 0),
              inc: sum((r) => r.ops?.incumbentChurn ?? 0),
              pchurn: sum((r) => r.ops?.priceChurn ?? 0),
              install: sum((r) => r.totals.install ?? 0),
              opex: sum((r) => (r.totals.overhead ?? 0) + (r.totals.marketing ?? 0)),
              promos: run.incumbentPromos.length,
              subs: run.reports.at(-1)?.stats?.subscribers,
            };
          };
          out = { with: arm({ percentOff: 20, months: 3 }), without: arm(null) };
          break;
        }
        default:
          throw new Error(`unknown mode ${MODE}`);
      }
      process.stdout.write(`${MODE} seed ${seed}: ${JSON.stringify(out, (key, v) => (key === 'reasons' ? undefined : typeof v === 'number' ? Math.round(v * 100) / 100 : v))}\n`);
    }
    expect(1).toBe(1);
  }, 3_600_000);
});

describe.runIf(process.env.TRACE === '1')('trace', () => {
  it('traces one run', () => {
    const seed = Number(process.env.SEED ?? 1);
    const d = (process.env.DIFF ?? 'seed') as DifficultyId;
    const b = process.env.BOT ?? 'smart';
    const run = runBot(seed, bot(b), MONTHS, {
      state: newGame(seed, { difficulty: d }),
      afterCommand: (s, cmd, result, cashBefore) => {
        if (process.env.CMDS === '1' && result.ok && cmd.type !== 'setMarketing') process.stdout.write(`  d${s.day} ${cmd.type} ${JSON.stringify(cmd).slice(0, 120)} cost ${cashBefore - s.finance.cash}\n`);
      },
    });
    run.reports.forEach((r, i) => {
      const kp = run.kpis[i]!;
      const t = r.totals as Record<string, number | undefined>;
      process.stdout.write(
        `m${i + 1} cash ${r.cashEnd} pass ${r.passings} subs ${r.stats?.subscribers} add ${r.stats?.grossAdds} churn ${r.stats?.churned} hap ${r.customers?.happy} ocf ${kp.operatingCashFlow} rev ${t.revenue ?? 0} ovh ${t.overhead ?? 0} mkt ${t.marketing ?? 0} pole ${t.poleRent ?? 0} rep ${t.repair ?? 0} inst ${t.install ?? 0} capex ${(t.construction ?? 0) + (t.equipment ?? 0)} int ${t.interest ?? 0} debt ${(r.debt?.creditBalance ?? 0) + (r.debt?.termBalance ?? 0)} ${r.debt?.stage}\n`,
      );
    });
    process.stdout.write(`${run.gameOver ? JSON.stringify(run.gameOver) : 'alive'}\n`);
  }, 600_000);
});

import { dealAdvantage, dealFactor } from '../customers';
import { targetTakeRate, tierMix } from '../sales';
import { defaultPricing } from '../sales';
import { scaledPrices } from './harness';
describe.runIf(process.env.FACTS === '1')('facts', () => {
  it('prices', () => {
    for (const m of [0.7, 0.8, 0.83, 0.9, 1, 1.1, 1.2, 1.3]) {
      const base = defaultPricing();
      const pricing = { ...base, tiers: base.tiers.map((t, i) => ({ ...t, price: scaledPrices(m)[i]!.price })) };
      const mix = tierMix(pricing, 'home');
      let price = 0;
      for (const t of pricing.tiers) price += mix[t.id] * t.price;
      const take = targetTakeRate(pricing, 'home');
      process.stdout.write(`x${m}: take home ${(take * 100).toFixed(1)}% mdu ${(targetTakeRate(pricing, 'mdu') * 100).toFixed(1)}% smb ${(targetTakeRate(pricing, 'smb') * 100).toFixed(1)}% adv ${(dealAdvantage(pricing, 'home') ?? 0).toFixed(3)} deal ${dealFactor(pricing, 'home').toFixed(2)} price ${price.toFixed(1)} rev/home ${(take * price).toFixed(1)} mix ${JSON.stringify(Object.fromEntries(Object.entries(mix).map(([k, v]) => [k, v.toFixed(2)])))}\n`);
    }
    expect(1).toBe(1);
  });
});

import { cityExposure as cityExp, exposureBand as expBand, stormRisk as risk, streetCanopy as canopyOfSeg } from '../weather';
describe.runIf(process.env.PLANT === '1')('plant', () => {
  it('plant by band', () => {
    for (const b of BOTS) for (const seed of SEEDS) {
      const run = runBot(seed, bot(b), MONTHS, { state: newGame(seed, { difficulty: (DIFFS[0] ?? 'seed') as DifficultyId }) });
      const s = run.state;
      const exp = cityExp(s.city);
      const rows: Record<string, { ft: number; spans: number; rep: number }> = {};
      for (const span of s.network.spans) {
        const seg = s.city.segments[span.segment]!;
        const band = expBand(exp[seg.id] ?? 1) + (canopyOfSeg(s.city, seg) >= 0.5 ? '+can' : '');
        const key = `${span.method}:${band}`;
        rows[key] ??= { ft: 0, spans: 0, rep: 0 };
        rows[key].ft += seg.lengthFt;
        rows[key].spans++;
        rows[key].rep += risk(s, seg, span.method).repairCostPerYear;
      }
      const ops = opsTotals(run);
      const rev = run.reports.slice(-12).reduce((t, r) => t + (r.totals.revenue ?? 0), 0);
      process.stdout.write(`${b} seed ${seed}: rev12 ${Math.round(rev / 1000)}k repairs(run) ${Math.round(ops.repairs / 1000)}k ${Object.entries(rows).sort().map(([k, v]) => `${k} ${Math.round(v.ft / 1000)}kft/${v.spans} $${Math.round(v.rep / 1000)}k`).join(' | ')}\n`);
    }
    expect(1).toBe(1);
  }, 3_600_000);
});

describe.runIf(process.env.CANOPY === '1')('canopy', () => {
  it('why aerial', () => {
    for (const seed of SEEDS) {
      const run = runBot(seed, bot(BOTS[0] ?? 'smart'), MONTHS, { state: newGame(seed) });
      const s = run.state;
      const econ = Bots.subscriberEconomics(s);
      for (const span of s.network.spans) {
        const seg = s.city.segments[span.segment]!;
        if (span.method !== 'aerial' || canopyOfSeg(s.city, seg) < 0.5) continue;
        const a = Bots.lifetimeCost(s, seg, 'aerial', 0, 0, Bots.SMART_DEFAULTS, econ);
        const u = Bots.lifetimeCost(s, seg, 'underground', 0, 0, Bots.SMART_DEFAULTS, econ);
        const r = risk(s, seg, 'aerial');
        process.stdout.write(`seed ${seed} span ${span.id} seg ${seg.id} len ${seg.lengthFt} poles ${seg.hasPoles} can ${canopyOfSeg(s.city, seg).toFixed(2)} exp ${(cityExp(s.city)[seg.id] ?? 0).toFixed(2)} rep/yr ${Math.round(r.repairCostPerYear)} out/yr ${r.outagesPerYear.toFixed(2)} life aerial ${Math.round(a)} ug ${Math.round(u)} pref ${preferred(s, seg)} built day ${span.orderedDay}\n`);
      }
    }
    expect(1).toBe(1);
  }, 3_600_000);
});
import { preferredMethod as preferred } from '../weather';

describe.runIf(process.env.DBG === '1')('dbg', () => {
  it('campaign areas', () => {
    const e = Bots.campaignExperiment(1);
    process.stdout.write(`${JSON.stringify(e.fresh?.cabinet)} ${e.fresh?.areaValue}\n`);
    const run = runBot(1, smartBot(), 6);
    for (const r of run.reports) process.stdout.write(`areas ${JSON.stringify(r.customers?.areas)}\n`);
    expect(1).toBe(1);
  }, 600_000);
});

import { advicePlans as plans } from '../advisor';
describe.runIf(process.env.ADV === '1')('advice', () => {
  it('follower advice trace', () => {
    const seed = Number(process.env.SEED ?? 12345);
    const d = (process.env.DIFF ?? 'shoestring') as DifficultyId;
    let last = '';
    runBot(seed, (s0) => {
      const inner = advisorFollowerBot(s0);
      return {
        name: 'trace',
        act(state, send) {
          const p = plans(state);
          const line = p.slice(0, 3).map((a) => `${a.advice.key} [${a.commands.map((c) => c.type).join(',')}]`).join(' | ');
          if (line !== last && state.day < Number(process.env.UNTIL ?? 400)) process.stdout.write(`d${state.day} cash ${state.finance.cash}: ${line}\n`);
          last = line;
          inner.act(state, send);
        },
      };
    }, Number(process.env.MONTHS ?? 14), { state: newGame(seed, { difficulty: d }) });
    expect(1).toBe(1);
  }, 600_000);
});

import { forecastCustomers } from '../customers';
describe.runIf(process.env.FC === '1')('forecast debug', () => {
  it('month by month', () => {
    const seed = Number(process.env.SEED ?? 424242);
    const month = Number(process.env.M ?? 24);
    const start = runBot(seed, smartBot(), month).state;
    const f = (m: number) => forecastCustomers(start, { months: m });
    process.stdout.write(`start day ${start.day} promo ${JSON.stringify(start.sales.promo)} incumbent ${JSON.stringify(start.sales.incumbentPromos.map((p) => [p.cabinet, p.startDay, p.endDay]))} subs ${start.sales.accounts.length} full ${start.sales.fullCabinets} paused ${start.sales.installsPaused} mkt ${start.sales.marketingPerMonth}\n`);
    const run = runBot(seed, smartBot({ maxProjectsPerLook: 0, managePromo: false, convert: false }), 12, { state: JSON.parse(JSON.stringify(start)) });
    let prev = 0;
    for (let m = 1; m <= 12; m++) {
      const fc = f(m);
      const r = run.reports[m - 1]!;
      process.stdout.write(`m${m}: forecast signups ${(fc.signups - prev).toFixed(1)} (cum ${fc.signups.toFixed(1)}, cancels ${fc.cancellations.toFixed(1)}) realized adds ${r.stats?.grossAdds} churn ${r.stats?.churned} lost ${r.stats?.lostService} subs ${r.stats?.subscribers} passings ${r.passings} promo ${JSON.stringify(run.state.sales.promo)}\n`);
      prev = fc.signups;
    }
    expect(1).toBe(1);
  }, 600_000);
});

import { reportDebt } from './harness';
describe.runIf(process.env.VAL === '1')('value parts', () => {
  it('value parts', () => {
    for (const b of BOTS) for (const seed of SEEDS) {
      const run = runBot(seed, bot(b), MONTHS, { state: newGame(seed, { difficulty: (DIFFS[0] ?? 'seed') as DifficultyId }) });
      const last = run.reports.at(-1)!;
      const t12 = run.kpis.slice(-12).reduce((t, k) => t + k.operatingCashFlow, 0);
      const r12 = run.reports.slice(-12).reduce((t, r) => t + (r.totals.revenue ?? 0), 0);
      const rep12 = run.reports.slice(-12).reduce((t, r) => t + (r.totals.repair ?? 0), 0);
      const ovh12 = run.reports.slice(-12).reduce((t, r) => t + (r.totals.overhead ?? 0), 0);
      const pole12 = run.reports.slice(-12).reduce((t, r) => t + (r.totals.poleRent ?? 0), 0);
      const mkt12 = run.reports.slice(-12).reduce((t, r) => t + (r.totals.marketing ?? 0), 0);
      const int12 = run.reports.slice(-12).reduce((t, r) => t + (r.totals.interest ?? 0), 0);
      process.stdout.write(`${b} seed ${seed}: val ${Math.round(runValue(run) / 1000)}k cash ${Math.round(last.cashEnd / 1000)}k debt ${Math.round(reportDebt(last) / 1000)}k ocf12 ${Math.round(t12 / 1000)}k rev12 ${Math.round(r12 / 1000)}k rep12 ${Math.round(rep12 / 1000)}k ovh12 ${Math.round(ovh12 / 1000)}k pole12 ${Math.round(pole12 / 1000)}k mkt12 ${Math.round(mkt12 / 1000)}k int12 ${Math.round(int12 / 1000)}k passings ${last.passings} subs ${last.stats?.subscribers}\n`);
    }
    expect(1).toBe(1);
  }, 3_600_000);
});
