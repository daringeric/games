// The round-4 balance targets (round-4 tuning brief), checked on TUNING_SEEDS
// through the real sim: a careful operator who picks each street's method by
// its lifetime cost (SMART) against all-aerial and all-underground copies of
// itself, storms that hurt aerial plant, a frozen-line hoarder who no longer
// out-grows careful borrowing, default prices near the best constant price,
// extreme price hikes that lose subscribers, and the incumbent's promos.
// The round-2/3 targets (start cash, cost per passing, break-even, growth with
// loans, LEVERED's default...) stay in targets.test.ts.
//
// When a balance.ts change breaks one of these, re-tune rather than widen a
// band: `TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts` prints the
// per-seed numbers behind every target.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { totalDebt } from '../debt';
import { deserialize } from '../save';
import { allAerialBot, allUndergroundBot, frozenHoarderBot, idleBot, priceHikerBot, smartBot } from './bots';
import {
  bestSweepPoint,
  finalPassedShare,
  opsTotals,
  passedShare,
  priceSweep,
  repaidAfterCall,
  runBot,
  stormExposure,
  TUNING_SEEDS,
  undergroundShare,
} from './harness';
import type { RunResult, SweepPoint } from './harness';

// ---------------------------------------------------------------------------
// Target bands
// ---------------------------------------------------------------------------

const MONTHS = 60;
/** SMART's underground share of its plant by feet, on every seed. */
const SMART_UNDERGROUND_SHARE: [number, number] = [0.2, 0.6];
/**
 * ALL_AERIAL's storm exposure over SMART's (harness stormExposure: what
 * storms are expected to cost each plant a year at month 60): repair dollars
 * at least AERIAL_REPAIRS_MULTIPLE times as high on every seed; subscriber-days
 * without service and outage cancellations higher on every seed and at least
 * AERIAL_OUTAGE_MULTIPLE times as high over the seeds together (a storm cuts
 * off only the damaged block, and SMART buries the short blocks, where a
 * repair call-out and a pole weigh most per foot but few subscribers live, so
 * its subscribers are less exposed by less). Realized losses
 * (MonthlyReport.ops) depend on where storms fell and diverge between runs
 * of one seed: the report prints them, and DESIGN.md gives 100-seed totals.
 */
const AERIAL_REPAIRS_MULTIPLE = 1.25;
const AERIAL_OUTAGE_MULTIPLE = 1.15;
/**
 * Default prices sit within this share of the best constant price of the
 * sweep (SMART at multiples of every TIER_DEFAULTS price, scored by
 * cumulative operating cash flow to month 60, mean over the seeds).
 */
const PRICE_OPTIMUM_TOLERANCE = 0.15;
/** Multipliers the target's sweep plays (the report prints the full PRICE_SWEEP_MULTIPLIERS). */
const SWEEP_MULTIPLIERS: readonly number[] = [0.8, 0.9, 1, 1.1, 1.2, 1.3];
/** PRICE_HIKER ends with at most this share of SMART's subscribers on every seed ... */
const HIKER_SUBSCRIBER_SHARE_MAX = 0.5;
/** ... and its price-step cancellations (ops.priceChurn) are at least this many units on every seed. */
const HIKER_PRICE_CHURN_MIN = 10;
/** Incumbent promos SMART meets in five years: a few on every seed, never everywhere all the time. */
const INCUMBENT_PROMOS: [number, number] = [1, 10];
/** Months the frozen v3 fixture is played on: enough for the call (FROZEN_ACCELERATION_CLOSES) and repayment. */
const FIXTURE_MONTHS = 12;

const TEST_TIMEOUT_MS = 300_000;

// ---------------------------------------------------------------------------
// Runs, played once per seed and shared by the tests below
// ---------------------------------------------------------------------------

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

const smart = (seed: number) => cached(`smart:${seed}`, () => runBot(seed, smartBot(), MONTHS));
const aerial = (seed: number) => cached(`aerial:${seed}`, () => runBot(seed, allAerialBot(), MONTHS));
const underground = (seed: number) => cached(`underground:${seed}`, () => runBot(seed, allUndergroundBot(), MONTHS));
const hoarder = (seed: number) => cached(`hoarder:${seed}`, () => runBot(seed, frozenHoarderBot(), MONTHS));
const spender = (seed: number) => cached(`spender:${seed}`, () => runBot(seed, frozenHoarderBot({ spendHoard: true }), MONTHS));
const hiker = (seed: number, grandfatherMonths?: number) =>
  cached(`hiker:${grandfatherMonths}:${seed}`, () => runBot(seed, priceHikerBot(grandfatherMonths), MONTHS));
const sweep = () => cached('sweep', () => priceSweep(TUNING_SEEDS, smartBot(), MONTHS, SWEEP_MULTIPLIERS));

/** Share of the town passed at month 60, 0 for a run that ended before it (a game over passes nothing). */
function shareAt60(run: RunResult): number {
  return run.gameOver ? 0 : (passedShare(run, MONTHS) ?? 0);
}

// ---------------------------------------------------------------------------
// Build method: aerial vs underground
// ---------------------------------------------------------------------------

describe('aerial vs underground', () => {
  it(
    'SMART lays 20-60% of its plant underground on every seed',
    () => {
      for (const seed of TUNING_SEEDS) {
        const share = undergroundShare(smart(seed));
        expect(share, `seed ${seed} underground share`).not.toBeNull();
        expect(share as number, `seed ${seed} underground share`).toBeGreaterThanOrEqual(SMART_UNDERGROUND_SHARE[0]);
        expect(share as number, `seed ${seed} underground share`).toBeLessThanOrEqual(SMART_UNDERGROUND_SHARE[1]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'an all-aerial operator is clearly more exposed to storms: repairs, subscriber-days out and outage cancellations',
    () => {
      const total = { careful: { subscriberDaysOut: 0, outageChurn: 0 }, exposed: { subscriberDaysOut: 0, outageChurn: 0 } };
      for (const seed of TUNING_SEEDS) {
        const careful = stormExposure(smart(seed));
        const exposed = stormExposure(aerial(seed));
        expect(careful.repairs, `seed ${seed} SMART repairs`).toBeGreaterThan(0);
        expect(exposed.repairs, `seed ${seed} repairs: all-aerial ${exposed.repairs} vs SMART ${careful.repairs}`).toBeGreaterThanOrEqual(
          AERIAL_REPAIRS_MULTIPLE * careful.repairs,
        );
        for (const pick of ['subscriberDaysOut', 'outageChurn'] as const) {
          expect(exposed[pick], `seed ${seed} ${pick}: all-aerial ${exposed[pick]} vs SMART ${careful[pick]}`).toBeGreaterThan(careful[pick]);
          total.careful[pick] += careful[pick];
          total.exposed[pick] += exposed[pick];
        }
        // And storms really happen: repairs on the books.
        expect(opsTotals(smart(seed)).repairs + opsTotals(aerial(seed)).repairs, `seed ${seed} repairs`).toBeGreaterThan(0);
      }
      for (const pick of ['subscriberDaysOut', 'outageChurn'] as const) {
        expect(total.exposed[pick], `${pick} over the seeds`).toBeGreaterThanOrEqual(AERIAL_OUTAGE_MULTIPLE * total.careful[pick]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'neither method dominates: underground everywhere is durable but passes less of the town on every seed',
    () => {
      // (Aerial everywhere passes more with the same money but pays in storm
      // losses: the test above. SMART's mix sits between the two.)
      for (const seed of TUNING_SEEDS) {
        const careful = smart(seed);
        const durable = underground(seed);
        expect(finalPassedShare(durable), `seed ${seed} all-underground share`).toBeLessThan(finalPassedShare(careful));
        expect(opsTotals(durable).repairs, `seed ${seed} all-underground repairs`).toBeLessThan(opsTotals(careful).repairs);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('pricing realism', () => {
  it(
    'puts default prices within 15% of the best constant price',
    () => {
      const points: SweepPoint[] = sweep();
      const best = bestSweepPoint(points);
      expect(best).not.toBeNull();
      expect(Math.abs((best as SweepPoint).multiplier - 1), `best multiplier ${best?.multiplier}`).toBeLessThanOrEqual(PRICE_OPTIMUM_TOLERANCE + 1e-9);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'loses subscribers to extreme price hikes, grandfathered or not, with the price-step churn on the books',
    () => {
      for (const grandfatherMonths of [undefined, 0]) {
        for (const seed of TUNING_SEEDS) {
          const run = hiker(seed, grandfatherMonths);
          const label = `seed ${seed} grandfather ${grandfatherMonths ?? 'default'}`;
          const subscribers = run.reports.at(-1)?.stats?.subscribers ?? 0;
          const careful = smart(seed).reports.at(-1)?.stats?.subscribers ?? 0;
          expect(subscribers, `${label} subscribers`).toBeLessThanOrEqual(HIKER_SUBSCRIBER_SHARE_MAX * careful);
          expect(opsTotals(run).priceChurn, `${label} price-step churn`).toBeGreaterThanOrEqual(HIKER_PRICE_CHURN_MIN);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "meets the incumbent's promo a few times in SMART's dense areas",
    () => {
      for (const seed of TUNING_SEEDS) {
        const promos = smart(seed).notices.incumbentPromo ?? 0;
        expect(promos, `seed ${seed} incumbent promos`).toBeGreaterThanOrEqual(INCUMBENT_PROMOS[0]);
        expect(promos, `seed ${seed} incumbent promos`).toBeLessThanOrEqual(INCUMBENT_PROMOS[1]);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The frozen line
// ---------------------------------------------------------------------------

describe('the frozen line', () => {
  it(
    'stops a hoarder out-growing careful borrowing: it ends up repaying through the call, or defaults',
    () => {
      for (const seed of TUNING_SEEDS) {
        const careful = shareAt60(smart(seed));
        for (const run of [hoarder(seed), spender(seed)]) {
          const label = `seed ${seed} ${run.bot}`;
          expect(shareAt60(run), `${label} share at month ${MONTHS}`).toBeLessThan(careful);
          const defaulted = run.gameOver?.reason === 'default';
          expect(defaulted || repaidAfterCall(run) !== null, `${label} defaulted or repaid through the call`).toBe(true);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'calls the loans of the frozen hoarder fixture (v3-grid) played on, and they are repaid',
    () => {
      const state = deserialize(readFileSync(new URL('../testing/v3-grid.save.json', import.meta.url), 'utf8'));
      expect(state.debt.covenant.stage).toBe('frozen');
      const run = runBot(state.seed, idleBot, FIXTURE_MONTHS, { state });
      expect(run.gameOver).toBeNull();
      expect(run.notices.loansCalled ?? 0).toBeGreaterThanOrEqual(1);
      expect(repaidAfterCall(run)).not.toBeNull();
      expect(totalDebt(run.state)).toBe(0);
      expect(run.state.debt.covenant.stage).toBe('compliant');
    },
    TEST_TIMEOUT_MS,
  );
});
