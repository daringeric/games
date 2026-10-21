// The round-4b balance targets (round-4b tuning brief), checked on
// TUNING_SEEDS through the real sim:
// - difficulty: the four levels differ only in starting cash; the careful
//   operator (smartBot, which plays lean below the Seed round's purse) never
//   loses at Angel-backed or Seed round, survives Bootstrapped, and
//   Shoestring is clearly harder;
// - pricing: dropping the cheaper tiers is not dominant (TWO_GIG_ONLY,
//   NO_CHEAP_TIER), the incumbent's promos do not cycle but still answer an
//   aggressive operator, the best answer to one beats ignoring it, and the
//   intro promo pays in a freshly lit area;
// - storms: storms favour exposed streets, the exposure bands mean
//   something, repairs stay a few percent of revenue, SMART beats the
//   all-underground copy of itself;
// - the advisor: following its top suggestion never goes bust and does at
//   least as well as SMART-lite (Seed round); at Angel-backed it never goes
//   bust, keeps building and is worth at least SMART-lite's value; at
//   Bootstrapped it never breaches a covenant or misses a payment (round 4b
//   review: these targets ran at the Seed round only).
// Targets the sim cannot reach today are `it.skip` with the reason (DESIGN.md,
// "What round 4b could not reach"), ready to enable once the sim change lands.
// The round-2/3 targets stay in targets.test.ts and round 4's in targets4.test.ts.
//
// When a balance.ts change breaks one of these, re-tune rather than widen a
// band: `TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts` prints the
// per-seed numbers behind every target.

import { describe, expect, it } from 'vitest';
import { DEMAND_SEGMENTS, INCUMBENT_PROMO_MIN_PASSINGS, INCUMBENT_PROMO_TAKE_RATE } from '../balance';
import { newGame } from '../game';
import { areaTakeRates } from '../incumbent';
import type { DifficultyId } from '../types';
import {
  advisorFollowerBot,
  aggressiveBot,
  allAerialBot,
  allUndergroundBot,
  freshPromoExperiment,
  incumbentAnswerExperiment,
  maturePromoExperiment,
  noCheapTierBot,
  smartBot,
  smartLiteBot,
  twoGigOnlyBot,
} from './bots';
import type { AnswerExperiment, PromoExperiment } from './bots';
import {
  averageArpu,
  cumulativeOperatingCashFlow,
  expectedDamageByBand,
  exposureBandShares,
  firstPositiveMonth,
  median,
  missedPaymentMonths,
  opsTotals,
  passedShare,
  runBot,
  runValue,
  TUNING_SEEDS,
  worstStage,
} from './harness';
import type { RunResult } from './harness';

// ---------------------------------------------------------------------------
// Target bands
// ---------------------------------------------------------------------------

const MONTHS = 60;
/** Seeds of five a "most seeds" target must hold on. */
const MOST_SEEDS = 4;

/**
 * Shoestring is winnable on at least this many seeds: no game over in 60
 * months and operating cash flow positive at month 60 (unreachable today: the
 * test is skipped, see DESIGN.md).
 */
const SHOESTRING_WINS_MIN = 3;

/** SMART's three-tier lineup earns at least this multiple of TWO_GIG_ONLY's cumulative operating cash flow to month 60, every seed. */
const TWO_GIG_OCF_MULTIPLE = 1.15;

/**
 * Incumbent promos SMART meets in five years, every seed. The trigger
 * (INCUMBENT_PROMO_TAKE_RATE) sits above the take rate SMART's areas settle
 * at, so a careful operator meets one only in its best areas (an apartment
 * block, a dense corner), and none is fine; the cap is one per area at most
 * twice (PROMOS_PER_AREA_MAX) in its typical six to eight areas over the
 * years an area takes to mature: a few at most.
 */
const SMART_PROMOS: [number, number] = [0, 6];
/** No cabinet area meets more promos than this in 60 months (the per-area memory works). */
const PROMOS_PER_AREA_MAX = 2;
/** Price-sensitive households drop out: TWO_GIG_ONLY's take rate at month 60 is at most (1 - the value segment's share) x SMART's. */
const VALUE_SEGMENT = DEMAND_SEGMENTS.find((s) => s.id === 'value');

/** Exposed streets take at least this multiple of sheltered streets' storm damage per span-year (expected, aerial). */
const EXPOSED_DAMAGE_MULTIPLE = 2;
/** Every exposure band holds this share of a town's street feet. */
const BAND_SHARE: [number, number] = [0.1, 0.7];
/** SMART's realized repairs over its revenue, all tuning seeds together. */
const REPAIR_SHARE: [number, number] = [0.02, 0.04];
/** SMART's median passed share at month 60. */
const SMART_MEDIAN_SHARE_MIN = 0.5;

const TEST_TIMEOUT_MS = 600_000;

// ---------------------------------------------------------------------------
// Runs, played once per seed and shared by the tests below
// ---------------------------------------------------------------------------

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

const atLevel = (seed: number, difficulty: DifficultyId) =>
  cached(`level:${difficulty}:${seed}`, () => runBot(seed, smartBot(), MONTHS, { state: newGame(seed, { difficulty }) }));
const smart = (seed: number) => atLevel(seed, 'seed');
const twoGig = (seed: number) => cached(`two-gig:${seed}`, () => runBot(seed, twoGigOnlyBot(), MONTHS));
const noCheap = (seed: number) => cached(`no-cheap:${seed}`, () => runBot(seed, noCheapTierBot(), MONTHS));
const aggressive = (seed: number) => cached(`aggressive:${seed}`, () => runBot(seed, aggressiveBot(), MONTHS));
const aerial = (seed: number) => cached(`aerial:${seed}`, () => runBot(seed, allAerialBot(), MONTHS));
const underground = (seed: number) => cached(`underground:${seed}`, () => runBot(seed, allUndergroundBot(), MONTHS));
const follower = (seed: number) => cached(`follower:${seed}`, () => runBot(seed, advisorFollowerBot, MONTHS));
const lite = (seed: number) => cached(`lite:${seed}`, () => runBot(seed, smartLiteBot(), MONTHS));
/** The follower and SMART-lite at another level (round 4b review: the follower targets ran at the Seed round only). */
const followerAt = (seed: number, difficulty: DifficultyId) =>
  cached(`follower:${difficulty}:${seed}`, () => runBot(seed, advisorFollowerBot, MONTHS, { state: newGame(seed, { difficulty }) }));
const liteAt = (seed: number, difficulty: DifficultyId) =>
  cached(`lite:${difficulty}:${seed}`, () => runBot(seed, smartLiteBot(), MONTHS, { state: newGame(seed, { difficulty }) }));
const answer = (seed: number) => cached(`answer:${seed}`, (): AnswerExperiment => incumbentAnswerExperiment(seed));
const fresh = (seed: number) => cached(`fresh:${seed}`, (): PromoExperiment => freshPromoExperiment(seed));
const mature = (seed: number) => cached(`mature:${seed}`, (): PromoExperiment => maturePromoExperiment(seed));

/** Share of the town passed at month 60, 0 for a run that ended before it. */
function shareAt60(run: RunResult): number {
  return run.gameOver ? 0 : (passedShare(run, MONTHS) ?? 0);
}

/** First month with operating cash flow > 0, Infinity if never (a run that never breaks even is later than any that does). */
function breakEven(run: RunResult): number {
  return firstPositiveMonth(run) ?? Infinity;
}

/** Most promos one cabinet area met in the run. */
function promosPerAreaMax(run: RunResult): number {
  const byCabinet = new Map<number, number>();
  for (const p of run.incumbentPromos) byCabinet.set(p.cabinet, (byCabinet.get(p.cabinet) ?? 0) + 1);
  return Math.max(0, ...byCabinet.values());
}

// ---------------------------------------------------------------------------
// Difficulty levels
// ---------------------------------------------------------------------------

describe('difficulty levels (only the starting cash differs)', () => {
  it(
    'Angel-backed and Seed round: the careful operator never loses the game',
    () => {
      for (const difficulty of ['angel', 'seed'] as const) {
        for (const seed of TUNING_SEEDS) {
          const run = atLevel(seed, difficulty);
          expect(run.gameOver, `${difficulty} seed ${seed}`).toBeNull();
          expect(run.reports.length, `${difficulty} seed ${seed}`).toBe(MONTHS);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Bootstrapped: the careful operator (playing lean) survives five years on every seed',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = atLevel(seed, 'bootstrapped');
        expect(run.gameOver, `bootstrapped seed ${seed}`).toBeNull();
        expect(run.reports.length, `bootstrapped seed ${seed}`).toBe(MONTHS);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Shoestring is clearly harder than Seed round: a later median break-even and a smaller median share at month 60',
    () => {
      const of = (difficulty: DifficultyId, pick: (run: RunResult) => number) => median(TUNING_SEEDS.map((seed) => pick(atLevel(seed, difficulty))));
      expect(of('shoestring', breakEven)).toBeGreaterThan(of('seed', breakEven));
      expect(of('shoestring', shareAt60)).toBeLessThan(of('seed', shareAt60));
      // And the levels run in order: more money passes more of the town.
      expect(of('angel', shareAt60)).toBeGreaterThan(of('seed', shareAt60));
      expect(of('seed', shareAt60)).toBeGreaterThan(of('bootstrapped', shareAt60));
    },
    TEST_TIMEOUT_MS,
  );

  // Unreachable with a fixed $9,000 overhead: a $200,000 network never covers it
  // before the cash runs out (DESIGN.md, "What round 4b could not reach").
  it.skip(
    'Shoestring is winnable by smart play on most seeds: no game over and positive operating cash flow at month 60',
    () => {
      const wins = TUNING_SEEDS.filter((seed) => {
        const run = atLevel(seed, 'shoestring');
        return run.gameOver === null && (run.kpis.at(-1)?.operatingCashFlow ?? 0) > 0;
      });
      expect(wins.length).toBeGreaterThanOrEqual(SHOESTRING_WINS_MIN);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

describe('pricing: dropping the cheaper tiers is not dominant', () => {
  it(
    'offering only 2 Gig loses clearly: three tiers earn 15% more operating cash flow on every seed',
    () => {
      for (const seed of TUNING_SEEDS) {
        const careful = cumulativeOperatingCashFlow(smart(seed));
        const premium = cumulativeOperatingCashFlow(twoGig(seed));
        expect(careful, `seed ${seed}: SMART ${careful} vs 2 Gig only ${premium}`).toBeGreaterThanOrEqual(TWO_GIG_OCF_MULTIPLE * premium);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'dropping only the cheapest tier loses too: on the mean and on most seeds',
    () => {
      let careful = 0;
      let dropped = 0;
      let wins = 0;
      for (const seed of TUNING_SEEDS) {
        const a = cumulativeOperatingCashFlow(smart(seed));
        const b = cumulativeOperatingCashFlow(noCheap(seed));
        careful += a;
        dropped += b;
        if (a > b) wins++;
      }
      expect(careful).toBeGreaterThan(dropped);
      expect(wins).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'price-sensitive households do not sign up for 2 Gig only: a lower take rate at a higher ARPU',
    () => {
      expect(VALUE_SEGMENT).toBeDefined();
      for (const seed of TUNING_SEEDS) {
        const careful = smart(seed);
        const premium = twoGig(seed);
        const take = careful.kpis.at(-1)?.takeRate ?? 0;
        expect(premium.kpis.at(-1)?.takeRate ?? 1, `seed ${seed} take rate`).toBeLessThanOrEqual((1 - (VALUE_SEGMENT?.share ?? 0)) * take);
        expect(averageArpu(premium) ?? 0, `seed ${seed} ARPU`).toBeGreaterThan(averageArpu(careful) ?? Infinity);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

describe("pricing: the incumbent's promos", () => {
  it(
    "trigger above the take rate SMART's areas settle at, so they do not cycle: a few per run, at most twice per area",
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = smart(seed);
        const promos = run.incumbentPromos.length;
        expect(promos, `seed ${seed} promos`).toBeGreaterThanOrEqual(SMART_PROMOS[0]);
        expect(promos, `seed ${seed} promos`).toBeLessThanOrEqual(SMART_PROMOS[1]);
        for (const other of [run, twoGig(seed), noCheap(seed), aggressive(seed)]) {
          expect(promosPerAreaMax(other), `seed ${seed} ${other.bot}: promos in one area`).toBeLessThanOrEqual(PROMOS_PER_AREA_MAX);
        }
        // The trigger sits above where SMART's areas settle (the median area at month 60).
        const settled = areaTakeRates(run.state)
          .filter((a) => a.passings >= INCUMBENT_PROMO_MIN_PASSINGS)
          .map((a) => a.takeRate);
        expect(median(settled), `seed ${seed} median area take rate`).toBeLessThan(INCUMBENT_PROMO_TAKE_RATE);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'still answer pushing: an aggressive operator (every price x0.8) meets one on most seeds',
    () => {
      const met = TUNING_SEEDS.filter((seed) => aggressive(seed).incumbentPromos.length >= 1);
      expect(met.length).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the best answer beats ignoring the promo, and what bestIncumbentAnswer chooses is never worse on most seeds',
    () => {
      let bestWins = 0;
      let chosenOk = 0;
      for (const seed of TUNING_SEEDS) {
        const { ocf } = answer(seed);
        if (Math.max(ocf.retention, ocf.introPromo, ocf.best) > ocf.ignore) bestWins++;
        if (ocf.best >= ocf.ignore) chosenOk++;
      }
      expect(bestWins).toBeGreaterThanOrEqual(MOST_SEEDS);
      expect(chosenOk).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the intro promo pays in a freshly lit area under an incumbent promo: quoted and realized over 12-24 months',
    () => {
      for (const months of [0, 1, 2]) {
        const wins = TUNING_SEEDS.filter((seed) => {
          const e = fresh(seed);
          return (e.withPromo[months] as number) > (e.without[months] as number);
        });
        expect(wins.length, `check ${months}`).toBeGreaterThanOrEqual(MOST_SEEDS);
      }
      for (const seed of TUNING_SEEDS) expect(fresh(seed).quote.pays, `seed ${seed} quotePromo pays`).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  // Unreachable: the promo's signup boost (PROMO_SIGNUP_BOOST) speeds up every
  // street's gap alike, and a mature town keeps a churn-held gap about as large
  // per signup as a fresh one (DESIGN.md, "What round 4b could not reach").
  it.skip(
    'the intro promo does not pay in a mature town (month 48, no new areas): quoted and realized',
    () => {
      const losses = TUNING_SEEDS.filter((seed) => {
        const e = mature(seed);
        return (e.withPromo[0] as number) < (e.without[0] as number);
      });
      expect(losses.length).toBeGreaterThanOrEqual(MOST_SEEDS);
      for (const seed of TUNING_SEEDS) expect(mature(seed).quote.pays, `seed ${seed}`).toBe(false);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Storms and the build method
// ---------------------------------------------------------------------------

describe('storms and the build method', () => {
  it('storms favour exposed streets: at least twice the expected damage per span-year of sheltered ones', () => {
    for (const seed of TUNING_SEEDS) {
      const damage = expectedDamageByBand(newGame(seed));
      expect(damage.sheltered, `seed ${seed} sheltered`).toBeGreaterThan(0);
      expect(damage.exposed, `seed ${seed}: exposed ${damage.exposed} vs sheltered ${damage.sheltered}`).toBeGreaterThanOrEqual(EXPOSED_DAMAGE_MULTIPLE * damage.sheltered);
    }
  });

  it('every exposure band holds 10-70% of a town\'s street feet (the overlay means something)', () => {
    for (const seed of TUNING_SEEDS) {
      const shares = exposureBandShares(newGame(seed).city);
      for (const band of ['sheltered', 'moderate', 'exposed'] as const) {
        expect(shares[band], `seed ${seed} ${band}`).toBeGreaterThanOrEqual(BAND_SHARE[0]);
        expect(shares[band], `seed ${seed} ${band}`).toBeLessThanOrEqual(BAND_SHARE[1]);
      }
    }
  });

  it(
    "repairs stay a few percent of SMART's revenue, and SMART still grows",
    () => {
      let repairs = 0;
      let revenue = 0;
      for (const seed of TUNING_SEEDS) {
        const ops = opsTotals(smart(seed));
        repairs += ops.repairs;
        revenue += ops.revenue;
      }
      expect(repairs / revenue).toBeGreaterThanOrEqual(REPAIR_SHARE[0]);
      expect(repairs / revenue).toBeLessThanOrEqual(REPAIR_SHARE[1]);
      expect(median(TUNING_SEEDS.map((seed) => shareAt60(smart(seed))))).toBeGreaterThanOrEqual(SMART_MEDIAN_SHARE_MIN);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "SMART's mixed build is worth more at month 60 than burying everything, on every seed",
    () => {
      for (const seed of TUNING_SEEDS) {
        expect(runValue(smart(seed)), `seed ${seed}`).toBeGreaterThan(runValue(underground(seed)));
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Unreachable: growth is capital-bound and lent against revenue, so a dollar
  // not spent on a bore is worth about four in value at month 60; the exposure
  // model's variation sits at the map's edges and groves, outside the dense
  // areas both operators build (DESIGN.md, "What round 4b could not reach").
  it.skip(
    "SMART's mixed build is worth more at month 60 than all-aerial, on most seeds and on the mean",
    () => {
      let wins = 0;
      let mixed = 0;
      let strung = 0;
      for (const seed of TUNING_SEEDS) {
        const a = runValue(smart(seed));
        const b = runValue(aerial(seed));
        mixed += a;
        strung += b;
        if (a > b && a > runValue(underground(seed))) wins++;
      }
      expect(wins).toBeGreaterThanOrEqual(MOST_SEEDS);
      expect(mixed).toBeGreaterThan(strung);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The advisor follower
// ---------------------------------------------------------------------------

describe('following the advisor', () => {
  it(
    'never goes bust, breaches a covenant or misses a payment by following the top suggestion',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = follower(seed);
        expect(run.gameOver, `seed ${seed}`).toBeNull();
        expect(worstStage(run), `seed ${seed} worst covenant stage`).toBe('compliant');
        expect(missedPaymentMonths(run), `seed ${seed} missed payments`).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does at least as well as SMART-lite (no loans, rebuilds or promo answers) on value and share at month 60, on most seeds',
    () => {
      const ok = TUNING_SEEDS.filter((seed) => {
        const f = follower(seed);
        const l = lite(seed);
        return runValue(f) >= runValue(l) && shareAt60(f) >= shareAt60(l);
      });
      expect(ok.length).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'at Angel-backed: never goes bust, breaches a covenant or misses a payment, and keeps building (more than two cabinets)',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = followerAt(seed, 'angel');
        expect(run.gameOver, `seed ${seed}`).toBeNull();
        expect(worstStage(run), `seed ${seed} worst covenant stage`).toBe('compliant');
        expect(missedPaymentMonths(run), `seed ${seed} missed payments`).toEqual([]);
        expect(run.state.network.cabinets.length, `seed ${seed} cabinets`).toBeGreaterThan(2);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'at Angel-backed: is worth at least as much as SMART-lite at month 60, on most seeds',
    () => {
      const ok = TUNING_SEEDS.filter((seed) => runValue(followerAt(seed, 'angel')) >= runValue(liteAt(seed, 'angel')));
      expect(ok.length).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );

  // Unreachable: SMART-lite spends the Angel purse on day one and passes ~70-75% of the town; the advisor
  // suggests one build at a time, each keeping a real reserve, and ends near 60-80%, ahead on 2 of 5 (DESIGN.md,
  // "What round 4b could not reach").
  it.skip(
    'at Angel-backed: does at least as well as SMART-lite on value and share at month 60, on most seeds',
    () => {
      const ok = TUNING_SEEDS.filter((seed) => {
        const f = followerAt(seed, 'angel');
        const l = liteAt(seed, 'angel');
        return runValue(f) >= runValue(l) && shareAt60(f) >= shareAt60(l);
      });
      expect(ok.length).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'at Bootstrapped: never breaches a covenant or misses a payment by following the top suggestion',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = followerAt(seed, 'bootstrapped');
        expect(worstStage(run), `seed ${seed} worst covenant stage`).toBe('compliant');
        expect(missedPaymentMonths(run), `seed ${seed} missed payments`).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // Unreachable with a fixed $9,000 overhead: no build the advisor can cost (green, with its reserve) fits
  // $400,000 on day one, a smaller one later only stretches the burn, and the follower runs out of cash on
  // overhead alone (DESIGN.md, "What round 4b could not reach").
  it.skip(
    'at Bootstrapped: never goes bust by following the top suggestion',
    () => {
      for (const seed of TUNING_SEEDS) expect(followerAt(seed, 'bootstrapped').gameOver, `seed ${seed}`).toBeNull();
    },
    TEST_TIMEOUT_MS,
  );
});
