// Balance report: the per-seed numbers behind targets.test.ts,
// targets4.test.ts and targets4b.test.ts, printed only when asked for
// (otherwise this file is a trivial pass):
//
//   TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts
//
// Optional: TUNE_SEEDS=1,2,3 or 1-100 (default TUNING_SEEDS), TUNE_MONTHS=60,
// TUNE_SWEEP=0 to skip the constant-price sweep (the slowest part),
// TUNE_PART=4cd for the round-4c/4d section only (difficulty levels, the
// advisor follower, CASUAL, switching, the growth levers and the marketing
// forecast: what the 100-seed confirmation runs), TUNE_PART=kept for the
// round-2..4b section only (the kept targets), TUNE_PART=mix for SMART's mix
// against all-aerial and all-underground at the small purses only (round
// 4c/4d review, spec D; also part of 4cd).

import { describe, expect, it } from 'vitest';
import { CPP_TARGET, DIFFICULTY_LEVELS, INCUMBENT_PROMO_MIN_PASSINGS, START_CASH } from '../balance';
import { newGame } from '../game';
import { areaTakeRates } from '../incumbent';
import {
  advisorFollowerBot,
  aggressiveBot,
  allAerialBot,
  allUndergroundBot,
  ANSWER_EXPERIMENT_MONTH,
  ANSWER_EXPERIMENT_MONTHS,
  carelessBot,
  casualBot,
  campaignExperiment,
  CEILING_SHARE,
  DISCOUNT_PRICE_MULTIPLIER,
  discountBot,
  MARKETING_FORECAST_MONTHS,
  marketingForecastCheck,
  OVERPRICED_PRICE_MULTIPLIER,
  overpricedBot,
  referralExperiment,
  supportExperiment,
  switchingExperiment,
  SWITCHING_EXPERIMENT_MONTHS,
  FRESH_PROMO_MONTH,
  freshPromoExperiment,
  frozenHoarderBot,
  idleBot,
  incumbentAnswerExperiment,
  leveredBot,
  MATURE_PROMO_MONTH,
  maturePromoExperiment,
  noCheapTierBot,
  priceHikerBot,
  ruralBot,
  smartBot,
  smartLiteBot,
  twoGigOnlyBot,
} from './bots';
import {
  averageArpu,
  averageBorrowingRate,
  averageChurn,
  bestSweepPoint,
  cppProbes,
  cumulativeOperatingCashFlow,
  expectedDamageByBand,
  exposureBandShares,
  finalPassedShare,
  firstPositiveMonth,
  median,
  missedPaymentMonths,
  opsTotals,
  ownershipCostPerPassing,
  passedShare,
  peakDebt,
  priceSweep,
  redWhileOwingShare,
  repaidAfterCall,
  runBot,
  runValue,
  stageHistory,
  stormExposure,
  takeOfAreasLit,
  townBuildOut,
  townFacts,
  TUNING_SEEDS,
  undergroundShare,
  worstStage,
} from './harness';
import type { RunResult } from './harness';

const ENABLED = process.env.TUNE_REPORT === '1';
const SEEDS: readonly number[] = process.env.TUNE_SEEDS
  ? process.env.TUNE_SEEDS.split(',').flatMap((s) => {
      const [a, b] = s.split('-').map((x) => Number(x.trim()));
      if (b === undefined) return [a as number];
      return Array.from({ length: (b as number) - (a as number) + 1 }, (_, i) => (a as number) + i);
    })
  : TUNING_SEEDS;
const PART = process.env.TUNE_PART ?? 'all';
const MONTHS = Number(process.env.TUNE_MONTHS ?? 60);
const SWEEP = process.env.TUNE_SWEEP !== '0';
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

/** One row per bot of the round-4 comparison: growth, plant, storms, money. */
function methodRow(name: string, run: RunResult): Record<string, string> {
  const ops = opsTotals(run);
  const exposure = stormExposure(run);
  return {
    bot: name,
    end: gameOverText(run),
    share: pct(finalPassedShare(run)),
    underground: pct(undergroundShare(run)),
    subs: num(run.reports.at(-1)?.stats?.subscribers),
    'op cash flow': dollars(cumulativeOperatingCashFlow(run)),
    value: dollars(runValue(run)),
    '12y cost/passing': dollars(ownershipCostPerPassing(run)),
    'exp. repairs/yr': dollars(exposure.repairs),
    'exp. days out/yr': exposure.subscriberDaysOut.toFixed(0),
    repairs: dollars(ops.repairs),
    'sub-days out': num(ops.outageUnitDays),
    'outage churn': num(ops.outageChurn),
    'price churn': num(ops.priceChurn),
    'incumbent churn': num(ops.incumbentChurn),
    promos: num(run.notices.incumbentPromo ?? 0),
    rebuilds: num(run.commands.convertSpan ?? 0),
    called: num(run.notices.loansCalled ?? 0),
    'repaid m': num(repaidAfterCall(run)),
  };
}

/** Round 4b: one row per bot of the pricing and advisor comparisons. */
function botRow(name: string, run: RunResult): Record<string, string> {
  const byCabinet = new Map<number, number>();
  for (const p of run.incumbentPromos) byCabinet.set(p.cabinet, (byCabinet.get(p.cabinet) ?? 0) + 1);
  return {
    bot: name,
    end: gameOverText(run),
    'cf+ month': num(firstPositiveMonth(run)),
    share: pct(run.gameOver ? 0 : finalPassedShare(run)),
    subs: num(run.reports.at(-1)?.stats?.subscribers),
    take: pct(run.kpis.at(-1)?.takeRate),
    arpu: dollars(averageArpu(run)),
    'op cash flow': dollars(cumulativeOperatingCashFlow(run)),
    value: dollars(runValue(run)),
    'peak debt': dollars(peakDebt(run)),
    worst: worstStage(run),
    missed: String(missedPaymentMonths(run).length),
    promos: String(run.incumbentPromos.length),
    'per area': String(Math.max(0, ...byCabinet.values())),
  };
}

describe('balance report', () => {
  it.runIf(!ENABLED)('prints nothing unless TUNE_REPORT=1', () => {
    expect(ENABLED).toBe(false);
  });

  it.runIf(ENABLED && (PART === 'all' || PART === 'kept'))(
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
        const aerial = runBot(seed, allAerialBot(), MONTHS);
        const underground = runBot(seed, allUndergroundBot(), MONTHS);
        const hoarder = runBot(seed, frozenHoarderBot(), MONTHS);
        const spender = runBot(seed, frozenHoarderBot({ spendHoard: true }), MONTHS);
        const hiker = runBot(seed, priceHikerBot(), MONTHS);
        const hikerNotice = runBot(seed, priceHikerBot(0), MONTHS);
        const levels = DIFFICULTY_LEVELS.map((level) => ({ level, run: runBot(seed, smartBot(), MONTHS, { state: newGame(seed, { difficulty: level.id }) }) }));
        const twoGig = runBot(seed, twoGigOnlyBot(), MONTHS);
        const noCheap = runBot(seed, noCheapTierBot(), MONTHS);
        const aggressive = runBot(seed, aggressiveBot(), MONTHS);
        const follower = runBot(seed, advisorFollowerBot, MONTHS);
        const lite = runBot(seed, smartLiteBot(), MONTHS);
        const answer = incumbentAnswerExperiment(seed);
        const fresh = freshPromoExperiment(seed);
        const mature = maturePromoExperiment(seed);
        const bands = exposureBandShares(city);
        const damage = expectedDamageByBand(newGame(seed));
        const settled = areaTakeRates(smart.state).filter((a) => a.passings >= INCUMBENT_PROMO_MIN_PASSINGS).map((a) => a.takeRate);
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
          'Round 4: build method, storms, the frozen line and prices',
          table([
            methodRow('SMART', smart),
            methodRow('ALL_AERIAL', aerial),
            methodRow('ALL_UNDERGROUND', underground),
            methodRow('FROZEN_HOARDER', hoarder),
            methodRow('hoarder (spends)', spender),
            methodRow('PRICE_HIKER', hiker),
            methodRow('PRICE_HIKER (0 months)', hikerNotice),
            methodRow('no loans', noDebt),
          ]),
          'Round 4b: difficulty levels (SMART; lean below the Seed round purse)',
          table(levels.map(({ level, run }) => botRow(`${level.name} ${dollars(level.startCash)}`, run))),
          'Round 4b: pricing, the incumbent and the advisor',
          table([
            botRow('SMART', smart),
            botRow('TWO_GIG_ONLY', twoGig),
            botRow('NO_CHEAP_TIER', noCheap),
            botRow('AGGRESSIVE (x0.8)', aggressive),
            botRow('ADVISOR_FOLLOWER', follower),
            botRow('SMART-lite', lite),
          ]),
          `SMART's area take rates at month ${MONTHS} (areas with ${INCUMBENT_PROMO_MIN_PASSINGS}+ passings): ${settled.map((t) => pct(t, 0)).join(' ')} (median ${pct(median(settled))})`,
          `Incumbent promo at cabinet ${answer.cabinet} (${answer.injected ? 'injected' : 'running'}) at month ${ANSWER_EXPERIMENT_MONTH}, then ${ANSWER_EXPERIMENT_MONTHS} months of SMART operating: ` +
            `ignore ${dollars(answer.ocf.ignore)}, retention ${dollars(answer.ocf.retention)}, intro promo ${dollars(answer.ocf.introPromo)}, ` +
            `bestIncumbentAnswer (${answer.chosen}, quoted ${dollars(answer.netValue)}) ${dollars(answer.ocf.best)}; incumbent cancellations ` +
            `${answer.incumbentChurn.ignore}/${answer.incumbentChurn.retention}/${answer.incumbentChurn.introPromo}/${answer.incumbentChurn.best}`,
          `Intro promo, fresh area (month ${FRESH_PROMO_MONTH}, incumbent promo at its largest area): quote pays ${fresh.quote.pays} (gain ${dollars(fresh.quote.valueGained)} vs discount ${dollars(fresh.quote.discountCost)}); ` +
            `op cash flow at 12/18/24 months with ${fresh.withPromo.map(dollars).join('/')} vs without ${fresh.without.map(dollars).join('/')}`,
          `Intro promo, mature town (month ${MATURE_PROMO_MONTH}, no new areas): quote pays ${mature.quote.pays} (gain ${dollars(mature.quote.valueGained)} vs discount ${dollars(mature.quote.discountCost)}); ` +
            `12 months with ${dollars(mature.withPromo[0])} vs without ${dollars(mature.without[0])}`,
          `Storm exposure: street feet sheltered ${pct(bands.sheltered)}, moderate ${pct(bands.moderate)}, exposed ${pct(bands.exposed)}; ` +
            `expected aerial damage per span-year sheltered ${damage.sheltered.toFixed(3)}, moderate ${damage.moderate.toFixed(3)}, exposed ${damage.exposed.toFixed(3)} ` +
            `(${(damage.exposed / Math.max(1e-9, damage.sheltered)).toFixed(1)}x)`,
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
          ugnd: pct(undergroundShare(smart)),
          'aerial repairs x': `${(stormExposure(aerial).repairs / Math.max(1, stormExposure(smart).repairs)).toFixed(2)} (${(opsTotals(aerial).repairs / Math.max(1, opsTotals(smart).repairs)).toFixed(2)})`,
          'aerial out x': `${(stormExposure(aerial).subscriberDaysOut / Math.max(1e-9, stormExposure(smart).subscriberDaysOut)).toFixed(2)} (${(opsTotals(aerial).outageUnitDays / Math.max(1, opsTotals(smart).outageUnitDays)).toFixed(2)})`,
          'all-ugnd share': pct(finalPassedShare(underground)),
          promos: num(smart.incumbentPromos.length),
          'aggr promos': num(aggressive.incumbentPromos.length),
          '3 tiers/2G': (cumulativeOperatingCashFlow(smart) / Math.max(1, cumulativeOperatingCashFlow(twoGig))).toFixed(2),
          '3 tiers/1G+2G': (cumulativeOperatingCashFlow(smart) / Math.max(1, cumulativeOperatingCashFlow(noCheap))).toFixed(2),
          'answer best-ignore': dollars(Math.max(answer.ocf.retention, answer.ocf.introPromo, answer.ocf.best) - answer.ocf.ignore),
          'chosen-ignore': dollars(answer.ocf.best - answer.ocf.ignore),
          'fresh promo +': dollars((fresh.withPromo[1] ?? 0) - (fresh.without[1] ?? 0)),
          'mature promo +': dollars((mature.withPromo[0] ?? 0) - (mature.without[0] ?? 0)),
          'value vs aerial': dollars(runValue(smart) - runValue(aerial)),
          'value vs ugnd': dollars(runValue(smart) - runValue(underground)),
          'boot': gameOverText(levels.find((l) => l.level.id === 'bootstrapped')?.run as RunResult),
          'shoe': gameOverText(levels.find((l) => l.level.id === 'shoestring')?.run as RunResult),
          follower: `${gameOverText(follower)} ${pct(follower.gameOver ? 0 : finalPassedShare(follower))}/${pct(finalPassedShare(lite))}`,
          hoarder: hoarder.gameOver ? `${hoarder.gameOver.reason} m${hoarder.gameOverMonth}` : `repaid m${repaidAfterCall(hoarder) ?? '-'}`,
          'hiker subs': `${num(hiker.reports.at(-1)?.stats?.subscribers)}/${num(smart.reports.at(-1)?.stats?.subscribers)}`,
          ms: smart.ms.toFixed(0),
        });
      }
      out.push(
        `\n=== summary (targets: cash share 25-33% mean, cpp aerial $400-600, underground $850-1,150, rural >= ${dollars(2.5 * CPP_TARGET)}, ` +
          `cash-flow positive month 12-18 median, take 30-45%, ARPU $60-80, churn 0.8-2%, cpp <= ${dollars(CPP_TARGET)} at months 36 and 60; ` +
          `share passed at month 60 >= 50% (median 50-70%), 15+ points over no loans; peak debt >= ${dollars(0.4 * START_CASH)}; ` +
          `rate 6-11%, rural >= SMART + 1%; worst stage warning; no missed payments; capacity after month 3 <= ${dollars(0.1 * START_CASH)}; ` +
          `LEVERED defaults on 4+ of 5; round 4: SMART underground 20-60%, all-aerial storm exposure (realized in brackets): repairs >= 1.25x, sub-days out >= 1.1x SMART's, ` +
          `all-underground passes less, hoarders repay through the call or default, hikers end with <= half SMART's subscribers; ` +
          `round 4b: 0-6 incumbent promos, at most 2 per area, AGGRESSIVE meets one on 4+ of 5, 3 tiers >= 1.15x 2 Gig only, beat 1 Gig + 2 Gig on 4+ and the mean, ` +
          `the best answer beats ignoring on 4+ and bestIncumbentAnswer never worse on 4+, the intro promo pays in a fresh area, bootstrapped survives)`,
        table(summary),
      );
      if (SWEEP) {
        const points = priceSweep(SEEDS, smartBot(), MONTHS);
        const best = bestSweepPoint(points);
        out.push(
          `\n=== constant-price sweep: SMART at multiples of every TIER_DEFAULTS price, mean over ${SEEDS.length} seeds; ` +
            `best by operating cash flow to month ${MONTHS}: x${best?.multiplier} (target: within 15% of x1)`,
          table(
            points.map((p) => ({
              'x price': p.multiplier.toFixed(1),
              'op cash flow': dollars(p.operatingCashFlow),
              value: dollars(p.value),
              share: pct(p.passedShare),
              subs: p.subscribers.toFixed(0),
              take: pct(p.takeRate),
              arpu: dollars(p.arpu),
              churn: pct(p.churn, 2),
              'game overs': String(p.gameOvers),
            })),
          ),
        );
      }
      // Straight to stdout: the default reporter hides console.log of passing tests.
      process.stdout.write(`${out.join('\n')}\n`);
      expect(summary.length).toBe(SEEDS.length);
    },
    3_600_000,
  );

  it.runIf(ENABLED && (PART === 'all' || PART === '4cd'))(
    'prints the round-4c/4d numbers: difficulty levels, the follower, CASUAL, switching, the levers, the forecast',
    () => {
      const out: string[] = [];
      const levels: Array<Record<string, string>> = [];
      const customers: Array<Record<string, string>> = [];
      for (const seed of SEEDS) {
        const shareOf = (run: RunResult) => (run.gameOver ? 0 : (passedShare(run, run.reports.length) ?? 0));
        const won = (run: RunResult) => run.gameOver === null && (run.kpis.at(-1)?.operatingCashFlow ?? 0) > 0;
        for (const level of DIFFICULTY_LEVELS) {
          const state = () => newGame(seed, { difficulty: level.id });
          const smart = runBot(seed, smartBot(), MONTHS, { state: state() });
          const follower = runBot(seed, advisorFollowerBot, MONTHS, { state: state() });
          const lite = runBot(seed, smartLiteBot(), MONTHS, { state: state() });
          const casual = level.id === 'seed' || level.id === 'angel' ? runBot(seed, casualBot(), 36, { state: state() }) : null;
          levels.push({
            seed: String(seed),
            level: level.name,
            smart: gameOverText(smart),
            won: won(smart) ? 'yes' : 'no',
            'cf+': num(firstPositiveMonth(smart)),
            share: pct(shareOf(smart)),
            value: dollars(runValue(smart)),
            'min cash': dollars(Math.min(...smart.reports.map((r) => r.cashEnd))),
            worst: worstStage(smart),
            follower: gameOverText(follower),
            'f worst': worstStage(follower),
            'f missed': String(missedPaymentMonths(follower).length),
            'f share': pct(shareOf(follower)),
            'f value': dollars(runValue(follower)),
            'f loans': num(follower.commands.takeTermLoan ?? 0),
            'f cf+': num(firstPositiveMonth(follower)),
            'lite share': pct(shareOf(lite)),
            'lite value': dollars(runValue(lite)),
            'f >= lite': runValue(follower) >= runValue(lite) && shareOf(follower) >= shareOf(lite) ? 'yes' : 'no',
            casual: casual ? `${gameOverText(casual)} min ${dollars(Math.min(...casual.reports.map((r) => r.cashEnd)))} warn ${casual.notices.insolvencyWarning ?? 0}` : '-',
          });
        }
        const smart = runBot(seed, smartBot(), MONTHS);
        const discount = runBot(seed, discountBot(), MONTHS);
        const overpriced = runBot(seed, overpricedBot(), MONTHS);
        const sw = switchingExperiment(seed);
        const camp = campaignExperiment(seed);
        const sup = supportExperiment(seed);
        const ref = referralExperiment(seed);
        const fc = MARKETING_FORECAST_MONTHS.map((m) => marketingForecastCheck(seed, m));
        const ceil = (m: number | null) => (m === null ? `>${SWITCHING_EXPERIMENT_MONTHS}` : String(m));
        customers.push({
          seed: String(seed),
          'take lit 3-5y': pct(takeOfAreasLit(smart, 36, 60)),
          'value std/disc/over': `${dollars(runValue(smart))}/${dollars(runValue(discount))}/${dollars(runValue(overpriced))}`,
          'subs std/disc/over': `${num(smart.reports.at(-1)?.stats?.subscribers)}/${num(discount.reports.at(-1)?.stats?.subscribers)}/${num(overpriced.reports.at(-1)?.stats?.subscribers)}`,
          'ceiling months std/disc': `${ceil(sw.standard.monthsToCeiling)}/${ceil(sw.discount.monthsToCeiling)}`,
          'take 12/24 std': `${pct(sw.standard.takes[11], 0)}/${pct(sw.standard.takes[23], 0)}`,
          'take 12/24 disc': `${pct(sw.discount.takes[11], 0)}/${pct(sw.discount.takes[23], 0)}`,
          'take 12/24 over': `${pct(sw.overpriced.takes[11], 0)}/${pct(sw.overpriced.takes[23], 0)}`,
          'arpu std/disc': `${dollars(sw.standard.arpu)}/${dollars(sw.discount.arpu)}`,
          'campaign fresh': camp.fresh ? `${camp.fresh.quote.pays ? 'pays' : 'no'} ${dollars(camp.fresh.areaValue)}` : '-',
          'campaign signed': camp.signed ? `${camp.signed.quote.pays ? 'pays' : 'no'} ${dollars(camp.signed.areaValue)}` : '-',
          'great-good hi long': dollars(sup.high.long.value.great - sup.high.long.value.good),
          'great-good lo short': dollars(sup.low.short.value.great - sup.low.short.value.good),
          'basic subs -': num(sup.high.long.subscribers.good - sup.high.long.subscribers.basic),
          'referrals many': `${ref.many.quote.pays ? 'pays' : 'no'} ${dollars(ref.many.subsValue)}`,
          'referrals few': `${ref.few.quote.pays ? 'pays' : 'no'} ${dollars(ref.few.subsValue)}`,
          forecast: fc.map((c) => `${c.quoted.toFixed(0)}/${c.realized}`).join(' '),
        });
      }
      out.push(
        `\n=== round 4c/4d: difficulty levels (SMART, ADVISOR_FOLLOWER, SMART-lite; CASUAL 36 months at Seed round and Angel-backed)`,
        table(levels),
        `\n=== round 4c/4d: customers (targets: take on areas lit 3-5 years 40-55%; DISCOUNT x${DISCOUNT_PRICE_MULTIPLIER} reaches ${pct(CEILING_SHARE, 0)} of the default lineup's ceiling >= 12 months sooner at a lower ARPU, ` +
          `OVERPRICED x${OVERPRICED_PRICE_MULTIPLIER} clearly slower; campaigns pay fresh, not signed; Great pays high/long, not low/short; Basic loses customers; ` +
          `referrals pay with many happy customers, not with few; forecast quoted/realized within 20%)`,
        table(customers),
      );
      process.stdout.write(`${out.join('\n')}\n`);
      expect(levels.length).toBe(SEEDS.length * DIFFICULTY_LEVELS.length);
    },
    7_200_000,
  );
  it.runIf(ENABLED && (PART === 'all' || PART === '4cd' || PART === 'mix'))(
    "prints SMART's mix against all-aerial and all-underground at the small purses (round 4c/4d review, spec D)",
    () => {
      const rows: Array<Record<string, string>> = [];
      for (const seed of SEEDS) {
        for (const level of ['bootstrapped', 'shoestring'] as const) {
          const state = () => newGame(seed, { difficulty: level });
          const mix = runBot(seed, smartBot(), MONTHS, { state: state() });
          const strung = runBot(seed, allAerialBot(), MONTHS, { state: state() });
          const buried = runBot(seed, allUndergroundBot(), MONTHS, { state: state() });
          const [m, a, u] = [mix, strung, buried].map((run) => runValue(run));
          rows.push({
            seed: String(seed),
            level,
            'mix value': dollars(m as number),
            'aerial value': dollars(a as number),
            'underground value': dollars(u as number),
            'mix ahead of both': (m as number) > (a as number) && (m as number) > (u as number) ? 'yes' : 'no',
            'game overs mix/aerial/ug': [mix, strung, buried].map((run) => (run.gameOver ? '1' : '0')).join('/'),
          });
        }
      }
      process.stdout.write(`\n=== round 4c/4d review: SMART's mix vs all-aerial and all-underground at Bootstrapped and Shoestring (runValue at month ${MONTHS})\n${table(rows)}\n`);
      expect(rows.length).toBe(SEEDS.length * 2);
    },
    7_200_000,
  );
});
