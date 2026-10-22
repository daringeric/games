// The round-4c/4d customers targets (round-4cd spec I.7), checked on
// TUNING_SEEDS through the real sim:
// - realistic switching: SMART at default prices reaches 40-55% take on
//   areas lit 3-5 years; a lineup about 17% cheaper (DISCOUNT) reaches the
//   ceiling a year or more sooner at a lower revenue per customer, an
//   overpriced one (OVERPRICED) grows clearly slower, and neither the cheaper
//   lineup nor the default dominates over five years;
// - the growth levers each pay only in their situation: a neighborhood
//   campaign in a freshly lit area and not in a well-signed one; Great support
//   over a long horizon with high outage exposure and not over a short one
//   with low exposure, Basic support losing customers; referral credits with
//   many happy customers next to unsigned lit homes and not with few happy
//   customers; quoted (customers.quote*) and realized;
// - the marketing forecast (quoteMarketing) is within about 20% of the
//   signups the sim then makes.
// The difficulty, advisor, storm-street and CASUAL targets are in
// targets4cd.test.ts; the intro promo (spec C) in targets4b.test.ts.
//
// When a balance.ts change breaks one of these, re-tune rather than widen a
// band: `TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts` prints the
// per-seed numbers behind every target.

import { describe, expect, it } from 'vitest';
import {
  campaignExperiment,
  discountBot,
  marketingForecastCheck,
  MARKETING_FORECAST_MONTHS,
  referralExperiment,
  smartBot,
  supportExperiment,
  switchingExperiment,
  SWITCHING_EXPERIMENT_MONTHS,
} from './bots';
import type { CampaignExperiment, MarketingForecastCheck, ReferralExperiment, SupportExperiment, SwitchingExperiment } from './bots';
import { runBot, runValue, takeOfAreasLit, TUNING_SEEDS } from './harness';

// ---------------------------------------------------------------------------
// Target bands
// ---------------------------------------------------------------------------

const MONTHS = 60;
/** Seeds of five a "most seeds" target must hold on. */
const MOST_SEEDS = 4;
/** SMART's take rate at month 60 on the areas lit 3 to 5 years (spec I.7: 40-55%), every seed. */
const TAKE_LIT_3_TO_5: [number, number] = [0.4, 0.55];
const LIT_MONTHS: [number, number] = [36, 60];
/** DISCOUNT reaches CEILING_SHARE of the ceiling at the default prices at least this many months before the default lineup does (switching experiment), on most seeds. */
const SOONER_MONTHS = 12;
/** OVERPRICED's take rate two years in is at most this share of the default lineup's (switching experiment), every seed. */
const OVERPRICED_TAKE_MAX = 0.75;
const OVERPRICED_CHECK_MONTH = 24;
/** The marketing forecast is within this share of the realized signups ... */
const FORECAST_TOLERANCE = 0.2;
/** ... on at least this share of its checks (MARKETING_FORECAST_MONTHS on every seed). */
const FORECAST_OK_SHARE = 0.8;

const TEST_TIMEOUT_MS = 900_000;

// ---------------------------------------------------------------------------
// Runs and experiments, played once per seed and shared by the tests below
// ---------------------------------------------------------------------------

const cache = new Map<string, unknown>();

function cached<T>(key: string, make: () => T): T {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key) as T;
}

const smart = (seed: number) => cached(`smart:${seed}`, () => runBot(seed, smartBot(), MONTHS));
const discount = (seed: number) => cached(`discount:${seed}`, () => runBot(seed, discountBot(), MONTHS));
const switching = (seed: number) => cached(`switching:${seed}`, (): SwitchingExperiment => switchingExperiment(seed));
const campaign = (seed: number) => cached(`campaign:${seed}`, (): CampaignExperiment => campaignExperiment(seed));
const support = (seed: number) => cached(`support:${seed}`, (): SupportExperiment => supportExperiment(seed));
const referral = (seed: number) => cached(`referral:${seed}`, (): ReferralExperiment => referralExperiment(seed));
const forecast = (seed: number) => cached(`forecast:${seed}`, (): MarketingForecastCheck[] => MARKETING_FORECAST_MONTHS.map((m) => marketingForecastCheck(seed, m)));

// ---------------------------------------------------------------------------
// Realistic switching
// ---------------------------------------------------------------------------

describe('switching responds to the deal', () => {
  it(
    'SMART at default prices reaches 40-55% take on the areas lit 3-5 years, on every seed',
    () => {
      for (const seed of TUNING_SEEDS) {
        const take = takeOfAreasLit(smart(seed), LIT_MONTHS[0], LIT_MONTHS[1]);
        expect(take, `seed ${seed}`).not.toBeNull();
        expect(take as number, `seed ${seed}`).toBeGreaterThanOrEqual(TAKE_LIT_3_TO_5[0]);
        expect(take as number, `seed ${seed}`).toBeLessThanOrEqual(TAKE_LIT_3_TO_5[1]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'a cheaper lineup reaches the ceiling a year or more sooner at a lower revenue per customer; an overpriced one grows clearly slower',
    () => {
      const later = (m: number | null) => m ?? SWITCHING_EXPERIMENT_MONTHS + 1;
      let sooner = 0;
      for (const seed of TUNING_SEEDS) {
        const e = switching(seed);
        expect(e.cabinets.length, `seed ${seed} areas`).toBeGreaterThan(0);
        if (later(e.discount.monthsToCeiling) + SOONER_MONTHS <= later(e.standard.monthsToCeiling)) sooner++;
        expect(e.discount.arpu, `seed ${seed} ARPU`).toBeLessThan(e.standard.arpu);
        expect(e.overpriced.takes[OVERPRICED_CHECK_MONTH - 1] ?? 1, `seed ${seed} overpriced take`).toBeLessThanOrEqual(
          OVERPRICED_TAKE_MAX * (e.standard.takes[OVERPRICED_CHECK_MONTH - 1] ?? 0),
        );
      }
      expect(sooner).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'neither the cheaper lineup nor the default dominates over five years: each is worth more at month 60 on some seed',
    () => {
      const discountWins = TUNING_SEEDS.filter((seed) => runValue(discount(seed)) > runValue(smart(seed))).length;
      expect(discountWins).toBeGreaterThanOrEqual(1);
      expect(discountWins).toBeLessThanOrEqual(TUNING_SEEDS.length - 1);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The growth levers
// ---------------------------------------------------------------------------

describe('a neighborhood campaign pays in a freshly lit area and not in a well-signed one', () => {
  it(
    'quoted and realized (its own area), on most seeds that have such an area',
    () => {
      let freshAreas = 0;
      let freshPays = 0;
      let signedAreas = 0;
      let signedLoses = 0;
      for (const seed of TUNING_SEEDS) {
        const { fresh, signed } = campaign(seed);
        if (fresh) {
          freshAreas++;
          if (fresh.quote.pays && fresh.areaValue > 0) freshPays++;
        }
        if (signed) {
          signedAreas++;
          if (!signed.quote.pays && signed.areaValue <= 0) signedLoses++;
        }
      }
      expect(freshAreas).toBeGreaterThanOrEqual(MOST_SEEDS);
      expect(freshPays).toBeGreaterThanOrEqual(freshAreas - 1);
      expect(signedAreas).toBeGreaterThanOrEqual(MOST_SEEDS);
      expect(signedLoses).toBeGreaterThanOrEqual(signedAreas - 1);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('support levels', () => {
  it(
    'Great pays over a long horizon with high outage exposure and not over a short one with low exposure; Basic loses customers',
    () => {
      let highLong = 0;
      let lowShort = 0;
      let cases = 0;
      for (const seed of TUNING_SEEDS) {
        const e = support(seed);
        if (e.high.long.value.great > e.high.long.value.good) highLong++;
        if (e.low.short.subscribers.good === 0 || e.low.short.value.great <= e.low.short.value.good) lowShort++;
        for (const c of [e.high.short, e.high.long, e.low.short, e.low.long]) {
          if (c.subscribers.good === 0) continue;
          cases++;
          expect(c.subscribers.basic, `seed ${seed} Basic keeps fewer customers`).toBeLessThan(c.subscribers.good);
        }
        expect(e.high.long.value.basic, `seed ${seed} Basic over the long horizon`).toBeLessThan(e.high.long.value.good);
      }
      expect(cases).toBeGreaterThan(0);
      expect(highLong).toBeGreaterThanOrEqual(MOST_SEEDS);
      expect(lowShort).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );
});

describe('referral credits', () => {
  it(
    'pay with many happy customers next to unsigned lit homes, and not with few happy customers: quoted and realized',
    () => {
      let many = 0;
      for (const seed of TUNING_SEEDS) {
        const e = referral(seed);
        if (e.many.quote.pays && e.many.subsValue > 0) many++;
        expect(e.many.happyShare, `seed ${seed} happy share`).toBeGreaterThan(e.few.happyShare);
        expect(e.few.quote.pays, `seed ${seed} few: quote`).toBe(false);
        expect(e.few.subsValue, `seed ${seed} few: realized`).toBeLessThanOrEqual(0);
      }
      expect(many).toBeGreaterThanOrEqual(MOST_SEEDS);
    },
    TEST_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// The marketing forecast
// ---------------------------------------------------------------------------

describe('the marketing forecast', () => {
  it(
    'is within about 20% of the signups the sim then makes over CUSTOMER_QUOTE_MONTHS',
    () => {
      let ok = 0;
      let checks = 0;
      for (const seed of TUNING_SEEDS) {
        for (const check of forecast(seed)) {
          checks++;
          expect(check.realized, `seed ${seed} month ${check.month} signups`).toBeGreaterThan(0);
          if (Math.abs(check.quoted - check.realized) <= FORECAST_TOLERANCE * check.realized) ok++;
        }
      }
      expect(ok).toBeGreaterThanOrEqual(Math.ceil(FORECAST_OK_SHARE * checks));
    },
    TEST_TIMEOUT_MS,
  );
});
