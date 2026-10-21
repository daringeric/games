// The balance targets (balance-tuning briefs, rounds 2 and 3), checked on
// TUNING_SEEDS through the real sim: start cash against the town's build-out,
// cost per passing of typical cable runs by area, a careful operator who
// borrows responsibly (SMART) over five years against the same operator
// without loans, a borrower who takes every dollar offered (LEVERED), a
// rural-heavy borrower (RURAL), a careless overbuilder (CARELESS) and a player
// who does nothing (IDLE). The round-4 targets (build method, storms, prices,
// the frozen line) are in targets4.test.ts.
//
// When a balance.ts change breaks one of these, re-tune rather than widen a
// band: `TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts` prints the
// per-seed numbers behind every target.

import { describe, expect, it } from 'vitest';
import { CPP_SPREAD_BPS, CPP_TARGET, OLT_START_PON_PORTS, START_CASH } from '../balance';
import { newGame } from '../game';
import type { CovenantStage } from '../types';
import { carelessBot, idleBot, leveredBot, ruralBot, smartBot } from './bots';
import {
  averageArpu,
  averageBorrowingRate,
  averageChurn,
  borrowingCapacity,
  cppProbes,
  firstPositiveMonth,
  median,
  missedPaymentMonths,
  passedShare,
  peakDebt,
  redWhileOwingShare,
  runBot,
  townBuildOut,
  townFacts,
  TUNING_SEEDS,
  worstStage,
} from './harness';
import type { CppProbes, RunResult } from './harness';

// ---------------------------------------------------------------------------
// Target bands
// ---------------------------------------------------------------------------

/** START_CASH / townBuildOut: mean over seeds, and every seed. */
const START_SHARE_MEAN: [number, number] = [0.25, 0.33];
const START_SHARE_SEED: [number, number] = [0.22, 0.36];
/** Median quoteCable cpp of dense poled runs, aerial and underground. */
const DENSE_AERIAL_CPP: [number, number] = [400, 600];
const DENSE_UNDERGROUND_CPP: [number, number] = [850, 1_150];
/** Rural runs are red: median cpp at least this many times CPP_TARGET. */
const RURAL_CPP_MIN_MULTIPLE = 2.5;

const SMART_MONTHS = 60;
/** First month with operating cash flow > 0 (financing excluded): median over seeds, and every seed. */
const FIRST_POSITIVE_MEDIAN: [number, number] = [12, 18];
const FIRST_POSITIVE_SEED: [number, number] = [9, 24];
const KPI_MONTH = 36;
const TAKE_RATE_AT_KPI_MONTH: [number, number] = [0.3, 0.45];
const ARPU: [number, number] = [60, 80];
const MONTHLY_CHURN: [number, number] = [0.008, 0.02];
/** Months at which SMART's lifetime cost per passing must be within CPP_TARGET. */
const CPP_CHECK_MONTHS = [KPI_MONTH, SMART_MONTHS];
/**
 * Seeds (of TUNING_SEEDS) on which covering the whole town takes more cabinets
 * than the starting OLT has PON ports, so expanding town-wide needs a CO upgrade.
 */
const OLT_UPGRADE_SEEDS_MIN = 4;

// Round 3: loans and growth.
/** Share of the units present at month 60 that SMART passes: every seed at least, and the median within. */
const GROWTH_SHARE_MIN = 0.5;
const GROWTH_SHARE_MEDIAN: [number, number] = [0.5, 0.7];
/**
 * SMART's share at month 60 beats the same operator without loans
 * (smartBot({ borrow: false }), ~25-35% of the town) by at least this many
 * points on every seed: debt is what keeps it building after break-even.
 */
const GROWTH_MARGIN_MIN = 0.15;
/** Covenant stages SMART may reach: a warning at worst, never the penalty rate or a freeze. */
const SMART_STAGES: readonly CovenantStage[] = ['compliant', 'warning'];
/**
 * SMART really borrows: its peak total debt (credit line + term loans at a
 * month end) is at least this share of START_CASH on every seed. 40% of the
 * starting purse is a second build round: about 350 more passings at SMART's
 * ~$850 per passing with its connects.
 */
const PEAK_DEBT_MIN_SHARE = 0.4;
/** SMART's debt-weighted average borrowing rate, bps, on every seed. */
const SMART_RATE_BPS: [number, number] = [600, 1_100];
/**
 * RURAL's lifetime cost per passing is red at most month ends while it owes
 * (it builds only red areas; town growth on its lit lanes can pull it into
 * amber late), so the bank prices its debt with the red CPP spread.
 */
const RURAL_RED_WHILE_OWING_MIN = 0.75;
const LEVERED_DEFAULT_SEEDS_MIN = 4;
/** Borrowing capacity (credit limit + term capacity) after month 3's close, at most this share of START_CASH. */
const EARLY_CAPACITY_MONTH = 3;
const EARLY_CAPACITY_MAX_SHARE = 0.1;

const CARELESS_MONTHS = 36;
const CARELESS_BANKRUPT_SEEDS_MIN = 4;
const IDLE_SURVIVES_MONTHS = 24;

/**
 * Wall-clock guard per 60-month SMART run. The target is about 2 s on a
 * developer machine (report.test.ts prints the times); the test allows a
 * loaded CI box plenty of slack and only catches a pathological slowdown.
 */
const RUN_MS_GUARD = 10_000;
/** Generous per-test timeout: the first test that needs a seed's run plays it. */
const TEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Runs, played once per seed and shared by the tests below
// ---------------------------------------------------------------------------

const cache = new Map<string, RunResult | CppProbes>();

function cached<T extends RunResult | CppProbes>(key: string, make: () => T): T {
  let value = cache.get(key) as T | undefined;
  if (!value) {
    value = make();
    cache.set(key, value);
  }
  return value;
}

const smart = (seed: number) => cached(`smart:${seed}`, () => runBot(seed, smartBot(), SMART_MONTHS, { clock: () => performance.now() }));
const smartNoDebt = (seed: number) => cached(`smart-no-debt:${seed}`, () => runBot(seed, smartBot({ borrow: false }), SMART_MONTHS));
const levered = (seed: number) => cached(`levered:${seed}`, () => runBot(seed, leveredBot(), SMART_MONTHS));
const rural = (seed: number) => cached(`rural:${seed}`, () => runBot(seed, ruralBot(), SMART_MONTHS));
const careless = (seed: number) => cached(`careless:${seed}`, () => runBot(seed, carelessBot, CARELESS_MONTHS));
const idle = (seed: number) => cached(`idle:${seed}`, () => runBot(seed, idleBot, IDLE_SURVIVES_MONTHS));
const probes = (seed: number) => cached(`probes:${seed}`, () => cppProbes(seed));

function expectWithin(value: number | null, [min, max]: [number, number], label: string): void {
  expect(value, label).not.toBeNull();
  expect(value as number, label).toBeGreaterThanOrEqual(min);
  expect(value as number, label).toBeLessThanOrEqual(max);
}

// ---------------------------------------------------------------------------
// The town the targets are about
// ---------------------------------------------------------------------------

describe('the generated town (what the balance was tuned on)', () => {
  it('stays the size and shape the targets assume', () => {
    // If citygen changes these, the balance needs re-tuning, not these bounds.
    for (const seed of TUNING_SEEDS) {
      const facts = townFacts(newGame(seed).city);
      const label = `seed ${seed}`;
      expectWithin(facts.unitsDay0, [1_400, 2_100], `${label} day-0 units`);
      expectWithin(facts.unitsFull, [1_900, 2_700], `${label} units at full growth`);
      expectWithin(facts.streetFt, [90_000, 120_000], `${label} street ft`);
      expectWithin(facts.poledShare, [0.7, 0.9], `${label} poled share`);
      expectWithin(facts.rockShare, [0.04, 0.2], `${label} rock share`);
      expectWithin(facts.ftPerUnit.residential, [45, 75], `${label} residential ft per unit`);
      expectWithin(facts.ftPerUnit.downtown, [20, 45], `${label} downtown ft per unit`);
      expectWithin(facts.ftPerUnit.rural, [150, 350], `${label} rural ft per unit`);
    }
  });
});

// ---------------------------------------------------------------------------
// (1) Start cash covers only a quarter to a third of the town
// ---------------------------------------------------------------------------

describe('start cash against the town build-out', () => {
  it('covers 25-33% of the build-out on average and 22-36% on every seed', () => {
    const shares = TUNING_SEEDS.map((seed) => START_CASH / townBuildOut(newGame(seed).city).total);
    shares.forEach((share, i) => expectWithin(share, START_SHARE_SEED, `seed ${TUNING_SEEDS[i]}`));
    expectWithin(shares.reduce((a, b) => a + b, 0) / shares.length, START_SHARE_MEAN, 'mean');
  });
});

// ---------------------------------------------------------------------------
// (2) Cost per passing of typical runs
// ---------------------------------------------------------------------------

describe('cost per passing of typical single orders', () => {
  it(
    'is about $500 aerial and about CPP_TARGET underground on dense streets, and red in the country',
    () => {
      const all = { aerial: [] as number[], underground: [] as number[], rural: [] as number[] };
      for (const seed of TUNING_SEEDS) {
        const p = probes(seed);
        const label = `seed ${seed}`;
        // Every town has dense poled runs and rural runs to measure.
        expect(p.denseAerial.length, `${label} dense runs`).toBeGreaterThanOrEqual(5);
        expect(p.rural.length, `${label} rural runs`).toBeGreaterThanOrEqual(1);
        const aerial = p.denseAerial.map((x) => x.cpp);
        const underground = p.denseUnderground.map((x) => x.cpp);
        const ruralRuns = p.rural.map((x) => x.cpp);
        expectWithin(median(aerial), DENSE_AERIAL_CPP, `${label} dense aerial median cpp`);
        expectWithin(median(underground), DENSE_UNDERGROUND_CPP, `${label} dense underground median cpp`);
        expect(median(ruralRuns), `${label} rural median cpp`).toBeGreaterThanOrEqual(RURAL_CPP_MIN_MULTIPLE * CPP_TARGET);
        all.aerial.push(...aerial);
        all.underground.push(...underground);
        all.rural.push(...ruralRuns);
      }
      expectWithin(median(all.aerial), DENSE_AERIAL_CPP, 'dense aerial median cpp, all seeds');
      expectWithin(median(all.underground), DENSE_UNDERGROUND_CPP, 'dense underground median cpp, all seeds');
      expect(median(all.rural), 'rural median cpp, all seeds').toBeGreaterThanOrEqual(RURAL_CPP_MIN_MULTIPLE * CPP_TARGET);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (3) A careful operator who borrows responsibly, over five years
// ---------------------------------------------------------------------------

describe('SMART: a careful operator', () => {
  it(
    'never loses the game in five years',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = smart(seed);
        expect(run.gameOver, `seed ${seed}`).toBeNull();
        expect(run.reports.length, `seed ${seed}`).toBe(SMART_MONTHS);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'turns operating cash-flow positive in months 12-18 (median), 9-24 on every seed',
    () => {
      const months = TUNING_SEEDS.map((seed) => {
        const month = firstPositiveMonth(smart(seed));
        expectWithin(month, FIRST_POSITIVE_SEED, `seed ${seed} first cash-flow positive month`);
        return month as number;
      });
      expectWithin(median(months), FIRST_POSITIVE_MEDIAN, 'median first cash-flow positive month');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'reaches a 30-45% take rate by month 36 at an ARPU of $60-80 and 0.8-2% monthly churn',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = smart(seed);
        expectWithin(run.kpis[KPI_MONTH - 1]?.takeRate ?? null, TAKE_RATE_AT_KPI_MONTH, `seed ${seed} take rate`);
        expectWithin(averageArpu(run), ARPU, `seed ${seed} ARPU`);
        expectWithin(averageChurn(run), MONTHLY_CHURN, `seed ${seed} churn`);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps lifetime cost per passing within CPP_TARGET at months 36 and 60',
    () => {
      for (const seed of TUNING_SEEDS) {
        for (const month of CPP_CHECK_MONTHS) {
          const cpp = smart(seed).kpis[month - 1]?.cpp ?? null;
          expect(cpp, `seed ${seed} month ${month}`).not.toBeNull();
          expect(cpp as number, `seed ${seed} month ${month}`).toBeLessThanOrEqual(CPP_TARGET);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'needs more capacity: a splitter on every seed by month 36, and a CO upgrade to cover the town',
    () => {
      let upgrades = 0;
      for (const seed of TUNING_SEEDS) {
        const run = smart(seed);
        expect(run.firstMonth.addSplitter ?? Infinity, `seed ${seed} first splitter month`).toBeLessThanOrEqual(KPI_MONTH);
        // One cabinet takes at least one PON port: a town needing more cabinets than ports needs an OLT card.
        if (townBuildOut(newGame(seed).city).cabinets > OLT_START_PON_PORTS) upgrades++;
      }
      expect(upgrades).toBeGreaterThanOrEqual(OLT_UPGRADE_SEEDS_MIN);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'plays five years quickly enough to tune with',
    () => {
      for (const seed of TUNING_SEEDS) expect(smart(seed).ms, `seed ${seed} ms`).toBeLessThan(RUN_MS_GUARD);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (4) Loans and growth (round 3)
// ---------------------------------------------------------------------------

describe('SMART with loans: growth', () => {
  it(
    'passes at least half the town by month 60 (median 50-70%), well ahead of the same operator without loans',
    () => {
      const shares = TUNING_SEEDS.map((seed) => {
        const share = passedShare(smart(seed), SMART_MONTHS);
        const without = passedShare(smartNoDebt(seed), SMART_MONTHS);
        expect(share, `seed ${seed} share passed`).not.toBeNull();
        expect(without, `seed ${seed} share passed without loans`).not.toBeNull();
        expect(share as number, `seed ${seed} share passed`).toBeGreaterThanOrEqual(GROWTH_SHARE_MIN);
        expect((share as number) - (without as number), `seed ${seed} share over the no-loan operator`).toBeGreaterThanOrEqual(GROWTH_MARGIN_MIN);
        return share as number;
      });
      expectWithin(median(shares), GROWTH_SHARE_MEDIAN, 'median share passed at month 60');
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'borrows responsibly: never past a covenant warning, never a missed payment, meaningful debt',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = smart(seed);
        expect(SMART_STAGES, `seed ${seed} worst covenant stage`).toContain(worstStage(run));
        expect(missedPaymentMonths(run), `seed ${seed} missed payments`).toEqual([]);
        expect(peakDebt(run), `seed ${seed} peak debt`).toBeGreaterThanOrEqual(PEAK_DEBT_MIN_SHARE * START_CASH);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'pays a sensible rate, and a rural-heavy (red cost per passing) borrower pays visibly more',
    () => {
      for (const seed of TUNING_SEEDS) {
        const rate = averageBorrowingRate(smart(seed));
        expectWithin(rate, SMART_RATE_BPS, `seed ${seed} SMART average rate (bps)`);
        const run = rural(seed);
        // It owes with a red lifetime cost per passing: the CPP spread applies.
        expect(redWhileOwingShare(run) ?? 0, `seed ${seed} RURAL red share while owing`).toBeGreaterThanOrEqual(RURAL_RED_WHILE_OWING_MIN);
        const ruralRate = averageBorrowingRate(run);
        // Without any penalty month too: the gap is risk pricing, not a covenant surcharge.
        const ruralRiskRate = averageBorrowingRate(run, true);
        expect(ruralRate, `seed ${seed} RURAL rate`).not.toBeNull();
        expect(ruralRiskRate, `seed ${seed} RURAL rate without penalty months`).not.toBeNull();
        expect(ruralRate as number, `seed ${seed} RURAL rate`).toBeGreaterThanOrEqual((rate as number) + CPP_SPREAD_BPS.amber);
        expect(ruralRiskRate as number, `seed ${seed} RURAL rate without penalty months`).toBeGreaterThanOrEqual((rate as number) + CPP_SPREAD_BPS.amber);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'keeps early-game tension: nothing to borrow before the first subscriber, little after three months',
    () => {
      for (const seed of TUNING_SEEDS) {
        expect(borrowingCapacity(newGame(seed)), `seed ${seed} capacity on day 0`).toBe(0);
        const run = smart(seed);
        expect(run.capacityAtStart, `seed ${seed} capacity at the start`).toBe(0);
        expect(run.capacityBeforeFirstSubscriber, `seed ${seed} capacity before the first subscriber`).toBe(0);
        expect(run.capacityAfterClose[EARLY_CAPACITY_MONTH - 1] ?? Infinity, `seed ${seed} capacity after month ${EARLY_CAPACITY_MONTH}`).toBeLessThanOrEqual(
          EARLY_CAPACITY_MAX_SHARE * START_CASH,
        );
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe('LEVERED: borrowing every dollar the bank offers', () => {
  it(
    'defaults on its loans within five years on most seeds',
    () => {
      const defaulted = TUNING_SEEDS.filter((seed) => {
        const run = levered(seed);
        return run.gameOver?.reason === 'default' && (run.gameOverMonth ?? Infinity) <= SMART_MONTHS;
      });
      expect(defaulted.length).toBeGreaterThanOrEqual(LEVERED_DEFAULT_SEEDS_MIN);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// (5) Careless overbuild goes bankrupt; (6) a new player is not killed early
// ---------------------------------------------------------------------------

describe('CARELESS: overbuilding without a reserve', () => {
  it(
    'goes bankrupt within three years on most seeds',
    () => {
      const bankrupt = TUNING_SEEDS.filter((seed) => {
        const run = careless(seed);
        const reason = run.gameOver?.reason;
        return (reason === 'insolvent' || reason === 'default') && (run.gameOverMonth ?? Infinity) <= CARELESS_MONTHS;
      });
      expect(bankrupt.length).toBeGreaterThanOrEqual(CARELESS_BANKRUPT_SEEDS_MIN);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('IDLE: a player who builds nothing', () => {
  it(
    'survives at least two years',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = idle(seed);
        expect(run.gameOver, `seed ${seed}`).toBeNull();
        expect(run.reports.length, `seed ${seed}`).toBe(IDLE_SURVIVES_MONTHS);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
