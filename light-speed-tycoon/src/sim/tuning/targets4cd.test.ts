// The round-4c/4d balance targets (round-4cd spec A, B, D and F), checked on
// TUNING_SEEDS through the real sim:
// - A, fair difficulty: the four levels differ only in starting cash; the
//   careful operator (smartBot, lean below the Seed round's purse) breaks
//   even around month 12-15 at the Seed round and passes 55-65% of the town by
//   month 60, never defaults at Angel-backed or the Seed round, survives
//   Bootstrapped and still grows there, can win at Shoestring, and each level
//   is harder than the one above with no cliff between the Seed round and
//   Bootstrapped;
// - B, the advisor at every budget: following its top suggestion
//   (ADVISOR_FOLLOWER) does at least as well as SMART-lite at every level,
//   never goes bust, breaches or misses a payment, and only borrows into a
//   network that breaks even;
// - D, storm economics street by street: the method choice (the advisor's and
//   SMART's) buries the exposed streets, each paying its extra cost back
//   within the horizon, and keeps the sheltered ones aerial; and at
//   Bootstrapped SMART's mix is worth more than all-aerial and
//   all-underground (at Shoestring, more than all-aerial);
// - F, "it's really quite a tough game": a first-time player (CASUAL) never
//   goes insolvent within three years at the Seed round or Angel-backed.
// The customers targets (spec C and I.7) are in targets4cd.levers.test.ts,
// round 4b's (the intro promo, the incumbent, mixed vs all-aerial and
// all-underground) in targets4b.test.ts.
//
// 100-seed confirmation: DESIGN.md "Round 4c/4d" gives the numbers.
// When a balance.ts change breaks one of these, re-tune rather than widen a
// band: `TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts` prints the
// per-seed numbers behind every target.

import { describe, expect, it } from 'vitest';
import { BUILD_METHOD_HORIZON_YEARS, DIFFICULTY_LEVELS, METHOD_UPFRONT_WEIGHT } from '../balance';
import { newGame } from '../game';
import type { DifficultyId, GameState } from '../types';
import { buryPayback, cityExposure, exposureBand, preferredMethod, streetCanopy } from '../weather';
import { advisorFollowerBot, allAerialBot, allUndergroundBot, casualBot, smartBot, smartLiteBot } from './bots';
import { firstPositiveMonth, median, missedPaymentMonths, passedShare, runBot, runValue, TUNING_SEEDS, worstStage } from './harness';
import type { RunResult } from './harness';

// ---------------------------------------------------------------------------
// Target bands
// ---------------------------------------------------------------------------

const MONTHS = 60;
/** Seeds of five a "most seeds" target must hold on. */
const MOST_SEEDS = 4;
/** Seed round: the median first month with operating cash flow > 0 (spec A: ~12-15). */
const SEED_BREAK_EVEN: [number, number] = [12, 15];
/** Seed round: the median share of the town passed at month 60 (spec A: ~55-65%). */
const SEED_SHARE: [number, number] = [0.55, 0.65];
/**
 * Bootstrapped grows meaningfully: its median share at month 60 is at least
 * this (round 4b's lean operator reached ~20%; spec A: "not 20%").
 */
const BOOTSTRAPPED_SHARE_MIN = 0.35;
/** ... and at least this share of the Seed round's median (no cliff between the two). */
const BOOTSTRAPPED_OF_SEED_MIN = 0.55;
/** Shoestring is winnable (no game over, operating cash flow > 0 at month 60) on at least this many of the five seeds. */
const SHOESTRING_WINS_MIN = 3;
/** CASUAL's horizon (spec F: never insolvent within three years). */
const CASUAL_MONTHS = 36;
const CASUAL_LEVELS: readonly DifficultyId[] = ['seed', 'angel'];
/** A street the method choice buries pays its extra cost back within this many years (weather.buryPayback). */
const BURY_PAYBACK_YEARS = BUILD_METHOD_HORIZON_YEARS / METHOD_UPFRONT_WEIGHT;
/** At least this share of a town's tree-lined exposed poled streets (canopy >= TREE_LINED) are buried by the method choice ... */
const EXPOSED_BURIED_MIN = 0.8;
/** ... and at least this share of its sheltered poled streets stay aerial. */
const SHELTERED_AERIAL_MIN = 0.9;
/** A street this tree-lined (weather.streetCanopy) or more counts as tree-lined. */
const TREE_LINED = 0.5;
/**
 * Round 4c/4d review (spec D at small purses): at Bootstrapped SMART's mix is worth more at month 60 than both
 * all-aerial and all-underground on at least this many of the five seeds and on the mean; at Shoestring more than
 * all-aerial on the mean (against all-underground it is not: see DESIGN.md "What round 4c/4d could not reach").
 */
const SMALL_PURSE_MIX_WINS_MIN = 3;
/** Round 4c/4d review: the Seed-round town of the 100-seed confirmation that defaulted after a severe storm (month 22). */
const SEED_ROUND_STORM_TOWN = 91;

const TEST_TIMEOUT_MS = 900_000;
const LEVELS: readonly DifficultyId[] = DIFFICULTY_LEVELS.map((l) => l.id);

// ---------------------------------------------------------------------------
// Runs, played once per seed and shared by the tests below
// ---------------------------------------------------------------------------

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

const at = (seed: number, difficulty: DifficultyId) => newGame(seed, { difficulty });
const smart = (seed: number, difficulty: DifficultyId) => cached(`smart:${difficulty}:${seed}`, () => runBot(seed, smartBot(), MONTHS, { state: at(seed, difficulty) }));
const follower = (seed: number, difficulty: DifficultyId) =>
  cached(`follower:${difficulty}:${seed}`, () => runBot(seed, advisorFollowerBot, MONTHS, { state: at(seed, difficulty) }));
const lite = (seed: number, difficulty: DifficultyId) => cached(`lite:${difficulty}:${seed}`, () => runBot(seed, smartLiteBot(), MONTHS, { state: at(seed, difficulty) }));
const strung = (seed: number, difficulty: DifficultyId) =>
  cached(`aerial:${difficulty}:${seed}`, () => runBot(seed, allAerialBot(), MONTHS, { state: at(seed, difficulty) }));
const buried = (seed: number, difficulty: DifficultyId) =>
  cached(`underground:${difficulty}:${seed}`, () => runBot(seed, allUndergroundBot(), MONTHS, { state: at(seed, difficulty) }));
const casual = (seed: number, difficulty: DifficultyId) =>
  cached(`casual:${difficulty}:${seed}`, () => runBot(seed, casualBot(), CASUAL_MONTHS, { state: at(seed, difficulty) }));

/** Share of the town passed at month 60, 0 for a run that ended before it. */
function shareAt60(run: RunResult): number {
  return run.gameOver ? 0 : (passedShare(run, MONTHS) ?? 0);
}

/** First month with operating cash flow > 0, Infinity if never. */
function breakEven(run: RunResult): number {
  return firstPositiveMonth(run) ?? Infinity;
}

/** Won: no game over in 60 months and operating cash flow positive at month 60. */
function won(run: RunResult): boolean {
  return run.gameOver === null && run.reports.length === MONTHS && (run.kpis.at(-1)?.operatingCashFlow ?? 0) > 0;
}

function medianOf(difficulty: DifficultyId, pick: (run: RunResult) => number, play = smart): number {
  return median(TUNING_SEEDS.map((seed) => pick(play(seed, difficulty))));
}

// ---------------------------------------------------------------------------
// A. Fair difficulty
// ---------------------------------------------------------------------------

describe('A. difficulty levels: only the starting cash differs', () => {
  it('a new game differs between levels only in its starting cash and its level', () => {
    for (const seed of TUNING_SEEDS) {
      const strip = (s: GameState) => ({ ...s, finance: { ...s.finance, cash: 0 }, company: { ...s.company, difficulty: 'seed' } });
      const base = JSON.stringify(strip(at(seed, 'seed')));
      for (const level of DIFFICULTY_LEVELS) {
        const state = at(seed, level.id);
        expect(state.finance.cash, `${level.id} cash`).toBe(level.startCash);
        expect(JSON.stringify(strip(state)), `seed ${seed} ${level.id}`).toBe(base);
      }
    }
  });

  it(
    'Seed round: breaks even around month 12-15 and passes 55-65% of the town by month 60 (medians), never losing',
    () => {
      for (const seed of TUNING_SEEDS) expect(smart(seed, 'seed').gameOver, `seed ${seed}`).toBeNull();
      const breakEvenMonth = medianOf('seed', breakEven);
      expect(breakEvenMonth).toBeGreaterThanOrEqual(SEED_BREAK_EVEN[0]);
      expect(breakEvenMonth).toBeLessThanOrEqual(SEED_BREAK_EVEN[1]);
      const share = medianOf('seed', shareAt60);
      expect(share).toBeGreaterThanOrEqual(SEED_SHARE[0]);
      expect(share).toBeLessThanOrEqual(SEED_SHARE[1]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'regression town from the 100-seed confirmation: the Seed round SMART on seed 91, whose cash a severe storm took below zero with its line drawn, bridges it and never defaults',
    () => {
      const run = smart(SEED_ROUND_STORM_TOWN, 'seed');
      expect(run.gameOver).toBeNull();
      expect(missedPaymentMonths(run)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Angel-backed: relaxed, never loses the game and passes more of the town than the Seed round',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = smart(seed, 'angel');
        expect(run.gameOver, `seed ${seed}`).toBeNull();
        expect(worstStage(run), `seed ${seed} worst covenant stage`).not.toBe('frozen');
      }
      expect(medianOf('angel', shareAt60)).toBeGreaterThan(medianOf('seed', shareAt60));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Bootstrapped: survives every seed and grows meaningfully, with no cliff from the Seed round',
    () => {
      for (const seed of TUNING_SEEDS) {
        const run = smart(seed, 'bootstrapped');
        expect(run.gameOver, `seed ${seed}`).toBeNull();
        expect(run.reports.length, `seed ${seed}`).toBe(MONTHS);
      }
      const share = medianOf('bootstrapped', shareAt60);
      expect(share).toBeGreaterThanOrEqual(BOOTSTRAPPED_SHARE_MIN);
      expect(share).toBeGreaterThanOrEqual(BOOTSTRAPPED_OF_SEED_MIN * medianOf('seed', shareAt60));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Shoestring: winnable by smart play on most seeds, and clearly the hardest (later break-even, smaller share)',
    () => {
      const wins = TUNING_SEEDS.filter((seed) => won(smart(seed, 'shoestring')));
      expect(wins.length).toBeGreaterThanOrEqual(SHOESTRING_WINS_MIN);
      expect(medianOf('shoestring', breakEven)).toBeGreaterThan(medianOf('bootstrapped', breakEven));
      expect(medianOf('shoestring', shareAt60)).toBeLessThan(medianOf('bootstrapped', shareAt60));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'the curve is smooth: each level passes less of the town and is worth less at month 60 than the one above it',
    () => {
      for (let i = 1; i < LEVELS.length; i++) {
        const easier = LEVELS[i - 1] as DifficultyId;
        const harder = LEVELS[i] as DifficultyId;
        expect(medianOf(harder, shareAt60), `${harder} vs ${easier} share`).toBeLessThan(medianOf(easier, shareAt60));
        expect(medianOf(harder, (r) => runValue(r)), `${harder} vs ${easier} value`).toBeLessThan(medianOf(easier, (r) => runValue(r)));
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// B. The advisor at every budget
// ---------------------------------------------------------------------------

describe('B. following the advisor at every level', () => {
  it(
    'never goes bust, breaches a covenant or misses a payment by following the top suggestion',
    () => {
      for (const difficulty of LEVELS) {
        for (const seed of TUNING_SEEDS) {
          const run = follower(seed, difficulty);
          expect(run.gameOver, `${difficulty} seed ${seed}`).toBeNull();
          expect(worstStage(run), `${difficulty} seed ${seed} worst covenant stage`).toBe('compliant');
          expect(missedPaymentMonths(run), `${difficulty} seed ${seed} missed payments`).toEqual([]);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'regression towns from the 100-seed confirmation: the Seed round seed 13 follower, which built a second area in its first week, never goes bust',
    () => {
      const run = follower(13, 'seed');
      expect(run.gameOver).toBeNull();
      expect(missedPaymentMonths(run)).toEqual([]);
      expect(Math.min(...run.reports.map((r) => r.cashEnd))).toBeGreaterThanOrEqual(0);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'Shoestring seed 12345, where no area the purse covers pays its way whole: the follower still builds, lights homes and does at least as well as SMART-lite',
    () => {
      const run = follower(12345, 'shoestring');
      expect(run.state.network.cabinets.length).toBeGreaterThan(0);
      expect(run.reports.at(-1)?.passings ?? 0).toBeGreaterThan(0);
      expect(run.gameOver).toBeNull();
      const l = lite(12345, 'shoestring');
      expect(runValue(run)).toBeGreaterThanOrEqual(runValue(l));
      expect(shareAt60(run)).toBeGreaterThanOrEqual(shareAt60(l));
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'does at least as well as SMART-lite on value and share at month 60, on most seeds, at every level',
    () => {
      for (const difficulty of LEVELS) {
        const ok = TUNING_SEEDS.filter((seed) => {
          const f = follower(seed, difficulty);
          const l = lite(seed, difficulty);
          return runValue(f) >= runValue(l) && shareAt60(f) >= shareAt60(l);
        });
        expect(ok.length, difficulty).toBeGreaterThanOrEqual(MOST_SEEDS);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'only borrows into a network that breaks even: every run that took a loan is cash-flow positive by month 60',
    () => {
      for (const difficulty of LEVELS) {
        for (const seed of TUNING_SEEDS) {
          const run = follower(seed, difficulty);
          if (!(run.commands.takeTermLoan ?? 0)) continue;
          expect(firstPositiveMonth(run), `${difficulty} seed ${seed}`).not.toBeNull();
          expect(run.kpis.at(-1)?.operatingCashFlow ?? 0, `${difficulty} seed ${seed}`).toBeGreaterThan(0);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// D. Storm economics, street by street
// ---------------------------------------------------------------------------

describe('D. the method choice buries exposed streets that pay it back and strings sheltered ones', () => {
  it('on every tuning town: tree-lined exposed streets are buried, each paying back within the horizon; sheltered ones stay aerial', () => {
    for (const seed of TUNING_SEEDS) {
      const state = newGame(seed);
      const exposure = cityExposure(state.city);
      let exposed = 0;
      let buried = 0;
      let sheltered = 0;
      let aerial = 0;
      for (const segment of state.city.segments) {
        if (!segment.hasPoles || segment.zone !== 'residential') continue;
        const method = preferredMethod(state, segment);
        if (method === 'underground') {
          const payback = buryPayback(state, segment);
          expect(payback?.years ?? 0, `seed ${seed} segment ${segment.id}`).toBeLessThanOrEqual(BURY_PAYBACK_YEARS + 1e-9);
        }
        const band = exposureBand(exposure[segment.id] ?? 1);
        if (band === 'exposed' && streetCanopy(state.city, segment) >= TREE_LINED) {
          exposed++;
          if (method === 'underground') buried++;
        } else if (band === 'sheltered') {
          sheltered++;
          if (method === 'aerial') aerial++;
        }
      }
      expect(exposed, `seed ${seed} tree-lined exposed streets`).toBeGreaterThan(0);
      expect(buried / exposed, `seed ${seed} buried share of tree-lined exposed streets`).toBeGreaterThanOrEqual(EXPOSED_BURIED_MIN);
      if (sheltered > 0) expect(aerial / sheltered, `seed ${seed} aerial share of sheltered streets`).toBeGreaterThanOrEqual(SHELTERED_AERIAL_MIN);
    }
  });
});

describe('D. SMART\'s mixed build at the small purses', () => {
  // Round 4c/4d review: round 4b's lean planner ranked areas and streets at the cheapest method's prices and then
  // built them with the street-by-street mix, so a small purse bought sparse areas; burying everything matched or
  // beat it at Bootstrapped and Shoestring. LEAN_OPTIONS now prices what it builds (chosenCosts), plans every
  // candidate area (bestOfPlans) and weighs the make-ready wait (waitWeight); all three bots share the planner.
  it(
    'at Bootstrapped is worth more at month 60 than all-aerial and all-underground, on the mean and on most seeds; at Shoestring more than all-aerial on the mean',
    () => {
      for (const difficulty of ['bootstrapped', 'shoestring'] as const) {
        let mixed = 0;
        let aerial = 0;
        let underground = 0;
        let wins = 0;
        for (const seed of TUNING_SEEDS) {
          const m = runValue(smart(seed, difficulty));
          const a = runValue(strung(seed, difficulty));
          const u = runValue(buried(seed, difficulty));
          mixed += m;
          aerial += a;
          underground += u;
          if (m > a && m > u) wins++;
        }
        expect(mixed, `${difficulty}: mix vs all-aerial`).toBeGreaterThan(aerial);
        if (difficulty === 'bootstrapped') {
          expect(mixed, `${difficulty}: mix vs all-underground`).toBeGreaterThan(underground);
          expect(wins, difficulty).toBeGreaterThanOrEqual(SMALL_PURSE_MIX_WINS_MIN);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// F. A first-time player survives
// ---------------------------------------------------------------------------

describe('F. CASUAL: a first-time player is never insolvent within three years at the Seed round or Angel-backed', () => {
  it(
    'no game over and no month-end with negative cash, on every tuning seed',
    () => {
      for (const difficulty of CASUAL_LEVELS) {
        for (const seed of TUNING_SEEDS) {
          const run = casual(seed, difficulty);
          expect(run.gameOver, `${difficulty} seed ${seed}`).toBeNull();
          expect(run.reports.length, `${difficulty} seed ${seed}`).toBe(CASUAL_MONTHS);
          expect(Math.min(...run.reports.map((r) => r.cashEnd)), `${difficulty} seed ${seed} lowest month-end cash`).toBeGreaterThanOrEqual(0);
          expect(run.notices.insolvencyWarning ?? 0, `${difficulty} seed ${seed} insolvency warnings`).toBe(0);
          // It really plays: a cabinet, streets lit and customers.
          expect(run.state.network.cabinets.length, `${difficulty} seed ${seed} cabinets`).toBe(1);
          expect(run.reports.at(-1)?.stats?.subscribers ?? 0, `${difficulty} seed ${seed} customers`).toBeGreaterThan(0);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
