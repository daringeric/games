// The month-end briefing and the advisor (round 4). Per rule: it fires and
// does not fire, its severity agrees with its priority band, its reason
// quotes the figures (computed here from the sim, never as literal dollar
// amounts), its action points at the right thing, and what it suggests never
// backfires: the plan's commands are applied to a copy of the game, which
// must stay covenant-compliant and keep at least the next debt service (and
// what the plan promises to keep). Then the briefing, determinism and the
// time budget on a generated town.

import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// bestIncumbentAnswer is pricing-balance's (a stub answering 'none' until it
// merges): the incumbentPromo tests drive it, so they hold either way.
vi.mock('./incumbent', async (importOriginal) => {
  const real = await importOriginal<typeof import('./incumbent')>();
  return { ...real, bestIncumbentAnswer: vi.fn(real.bestIncumbentAnswer) };
});

import {
  ADVICE_SNOOZE_MONTHS,
  ADVICE_SNOOZE_URGENT_MONTHS,
  ARR_TRAILING_MONTHS,
  CABINET_REACH_FT,
  CABINET_START_SPLITTERS,
  CONVERT_PAYBACK_YEARS,
  COVENANT_CURE_CLOSES,
  COVENANT_MAX_LEVERAGE,
  CPP_AMBER_MULTIPLIER,
  CPP_SPREAD_BPS,
  CPP_TARGET,
  CUSTOMER_QUOTE_MONTHS,
  DIFFICULTY_LEVELS,
  EXPAND_COVENANT_HEADROOM,
  EXPAND_RESERVE_MONTHS,
  FROZEN_ACCELERATION_CLOSES,
  GROWTH_PAYBACK_MONTHS,
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_CHURN,
  LOAN_ROUNDING,
  MAX_SPLITTERS_PER_CABINET,
  OLT_CARD_COST,
  OLT_MAX_CARDS,
  OLT_PORTS_PER_CARD,
  SPLITTER_COST,
  SPLIT_RATIO,
  STORM_LOG_DAYS,
  SUPPORT_QUOTE_MONTHS,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  TIER_DEFAULTS,
} from './balance';
import {
  ADVICE_KEY_MAX_LENGTH,
  ADVICE_KEYS,
  ADVICE_MAX,
  ADVICE_ORDER,
  ADVICE_PRIORITY,
  ADVICE_SHOWN_MAX,
  ADVICE_TITLE_MAX,
  ADVICE_WHY_MAX,
  advicePlans,
  advise,
  ADVISOR_MEMORY_MAX,
  ATTENTION_NOTICE_KINDS,
  briefingBuiltOn,
  buildBriefing,
  buildTrough,
  closeDayOf,
  COVENANT_RISK_MARGIN,
  SUGGESTED_BORROWING_HEADROOM,
  EXPAND_CANDIDATES_MAX,
  EXPAND_MIN_PASSINGS,
  EXPAND_REACH_MULTIPLE,
  expandCandidates,
  expectedAreaInstalls,
  GROW_MIN_CUSTOMERS,
  LINEUP_MIN_GAIN,
  SUPPORT_MIN_UNITS,
  SUPPORT_SERVICE_SHARE,
  growthOptions,
  isAdviceKey,
  isSnoozed,
  MARKETING_CUT_ROUNDING,
  MARKETING_CUT_SHARE,
  monthlyInstallPace,
  newAdvisorState,
  nextCloseDay,
  noticeNeedsAttention,
  planCustomers,
  planRunningCost,
  plannedInstallPace,
  planFor,
  rankAdvice,
  rankedCorners,
  repeatOf,
  rewordRepeat,
  TAKE_RATE_LAG_SHARE,
  TAKE_RATE_MATURE_MONTHS,
  TAKE_RATE_SLOW_DEAL,
} from './advisor';
import type { AdvicePlan } from './advisor';
import { DAYS_PER_YEAR, formatDate } from './calendar';
import { buildOutPlan } from './coverage';
import {
  acceleratedSchedule,
  closesUntilAcceleration,
  covenantMetrics,
  covenantsWithin,
  cureOptions,
  estimateNextDebtService,
  estimateSweep,
  perDollarWords,
  yearsOfProfitWords,
  fundingHint,
  formatRateBps,
  maxSafeTermLoan,
  quoteTermLoan,
  totalDebt,
} from './debt';
import { estimateCashAtClose, formatMoney, monthlyBurn, monthlyPoleRent, runwayMonths } from './finance';
import { applyCommand, newGame, runDays, tick } from './game';
import * as incumbent from './incumbent';
import { incumbentPromoPrice } from './incumbent';
import { cppBand, REPAIR_TRAILING_MONTHS } from './metrics';
import { getService, outageImpact, outageService, ponPortsUsed, quoteConvert } from './network';
import { churnProbability, closeDayAfter, segmentDemand, stateTakeRate, subscriberUnits, unitsByTier } from './sales';
import { dealFactor, forecastCustomers, happinessReport, MARKETING_STEP, quoteCampaign, quoteSupport } from './customers';
import { deserialize, hashState, serialize } from './save';
import { cornerName } from './streets';
import { fixedCostsPerMonth, perCustomerCost } from './overhead';
import { addLivePlant, makeGridCity, makeLoan, makeTestState, makeTradingState, noDebtStats } from './testing/fixtures';
import { advisorFollowerBot, allAerialBot, ensureIncumbentPromo, smartBot } from './tuning/bots';
import { runBot, TUNING_SEEDS, worstStage } from './tuning/harness';
import type { Bot, BotFactory } from './tuning/harness';
import type { Advice, AdviceId, CableSpan, City, Command, GameState, IncumbentAnswer, Notice, TermYears, TierId, Zone } from './types';
import { exposureBand, outageChurnProbability, repairCost, segmentExposure } from './weather';

const realIncumbent = await vi.importActual<typeof import('./incumbent')>('./incumbent');
const answerMock = vi.mocked(incumbent.bestIncumbentAnswer);
afterEach(() => {
  answerMock.mockImplementation(realIncumbent.bestIncumbentAnswer);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A grid town fully lit from the CO, run long enough to have subscribers and closed months. */
function litGame(days = 120, city: City = makeGridCity({ cols: 3, rows: 2 })) {
  const state = makeTestState(city);
  addLivePlant(state, { splitters: 4 });
  runDays(state, days);
  return state;
}

/**
 * `city` with every street in `zone`, moved `inland` cells in from every map
 * edge: storm exposure (weather.segmentExposure) is the zone's, raised near
 * the edge (and on wooded streets, once storms-balance adds that term). Rural
 * streets come out 'exposed' anywhere; downtown streets well inside the map
 * never do.
 */
function zoned(city: City, zone: Zone, inland = 0): City {
  for (const segment of city.segments) segment.zone = zone;
  if (inland > 0) {
    for (const node of city.nodes) {
      node.x += inland;
      node.y += inland;
    }
    for (const parcel of city.parcels) {
      parcel.x += inland;
      parcel.y += inland;
    }
    city.width += 2 * inland;
    city.height += 2 * inland;
  }
  return city;
}

/** The 3 x 2 grid with rural streets: every street exposed to storms. */
const ruralGrid = () => zoned(makeGridCity({ cols: 3, rows: 2 }), 'rural');
/** The 3 x 2 grid downtown, far inside a big map: no street exposed. */
const shelteredGrid = () => zoned(makeGridCity({ cols: 3, rows: 2 }), 'downtown', 40);

/** A wider grid (64 homes) lit from a cabinet at its center. */
function centerGame(days: number, marketing?: number) {
  const state = makeTestState(makeGridCity({ cols: 4, rows: 2, coAt: [2, 1] }));
  addLivePlant(state, { splitters: 4 });
  if (marketing !== undefined) applyCommand(state, { type: 'setMarketing', perMonth: marketing });
  runDays(state, days);
  return state;
}

const clone = (state: GameState): GameState => deserialize(serialize(state));

function fixture(name: 'v3-grid' | 'v3-town'): GameState {
  return deserialize(readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8'));
}

/** A state with closed months that billed `revenue` and spent `costs` (makeTradingState: the 10th of April 2027) and `cash`. */
function trading(revenue: number, costs: number, cash: number): GameState {
  const state = makeTradingState(revenue, costs);
  state.finance.cash = cash;
  return state;
}

/** Give `state` one term loan (makeLoan) taken on day 0. */
function withLoan(state: GameState, principal: number): GameState {
  state.debt.loans = [makeLoan({ principal, originatedDay: 0 })];
  state.debt.nextLoanId = 2;
  return state;
}

/**
 * The plan of rule `id` on `state`, which must fire; every plan a test gets
 * this way is also checked to be well formed and never to backfire.
 */
function plan(state: GameState, id: AdviceId): AdvicePlan {
  const found = planFor(state, id);
  expect(found, `${id} should fire`).not.toBeNull();
  const p = found as AdvicePlan;
  expect(p.advice.id).toBe(id);
  expectWellFormed(p.advice);
  // Round 4c/4d: a card whose plan borrows says so on its face, not only in the detail.
  if (p.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan')) expect(p.advice.why).toMatch(/borrow|loan/i);
  expectNoBackfire(state, p);
  // Deterministic: the same on a second call and on a copy.
  expect(planFor(state, id)).toEqual(p);
  expect(planFor(clone(state), id)).toEqual(p);
  return p;
}

/** The band a severity's priorities lie in. */
const BAND = { urgent: [300, 399], important: [200, 299], tip: [100, 199] } as const;

/** Advice.key by rule: the rule id, then its subject (round 4b). */
const KEY_PATTERN: Record<AdviceId, RegExp> = {
  paymentShort: /^paymentShort$/,
  loansCalled: /^loansCalled$/,
  covenantCure: /^covenantCure$/,
  frozenSweep: /^frozenSweep$/,
  cashRunway: /^cashRunway$/,
  addSplitter: /^addSplitter:cabinet:\d+$/,
  addOltCard: /^addOltCard$/,
  outages: /^outages:segment:\d+$/,
  stormUnderground: /^stormUnderground:span:\d+$/,
  incumbentPromo: /^incumbentPromo:cabinet:\d+$/,
  takeRate: /^takeRate$/,
  pricing: /^pricing:(fiber500|fiber1g|fiber2g)$/,
  // Round 4c/4d (contract): the new rules' keys (sim-advisor may narrow them).
  lineup: /^lineup:(fiber500|fiber1g|fiber2g)$/,
  support: /^support:(good|great)$/,
  growCustomers: /^growCustomers:(marketing|referrals|hint|campaign:\d+)$/,
  redCpp: /^redCpp$/,
  firstBuild: /^firstBuild(:node:\d+)?$/,
  expand: /^expand:node:\d+$/,
};

/** Everything an advice says: the card's short reason and the longer reasoning behind it (round 4c/4d: the figures moved to the detail). */
const text = (advice: Advice): string => `${advice.why} ${advice.detail}`;

/** The bank's terms, which even a card's detail uses only next to their plain meaning (BANK_TERM_GLOSSED). */
const BANK_JARGON = /covenant|leverage|DSCR|\bARR\b|\bOCF\b|\bbps\b|×/i;
/** Where a detail names the bank's term beside its plain meaning ("passing both of the bank's checks, its covenants"). */
const BANK_TERM_GLOSSED = /\(passing both of the bank's checks, its covenants\)/g;

/** Words the card's first view never uses (spec G/B: plain words; they may appear in the detail, next to their meaning). */
const JARGON = /covenant|leverage|DSCR|\bARR\b|\bOCF\b|operating cash flow|\bbps\b|×|\bCPP\b|cost per passing|PON\b/i;

/**
 * Round 4c/4d (spec B): the card is short and plain: a title of at most
 * ADVICE_TITLE_MAX characters, and a why of at most ADVICE_WHY_MAX that is
 * one sentence (the mockup's register allows a closing "Costs $1,800."),
 * neither with jargon; the cost, when there is one, is whole dollars and
 * named in the why.
 */
/** The rules whose cards these tests have checked against the card limits (expectShort); the last test wants every rule. */
const CHECKED_SHORT = new Set<AdviceId>();

function expectShort(advice: Advice): void {
  CHECKED_SHORT.add(advice.id);
  expect(advice.title.length, advice.title).toBeLessThanOrEqual(ADVICE_TITLE_MAX);
  expect(advice.why.length, advice.why).toBeLessThanOrEqual(ADVICE_WHY_MAX);
  expect(advice.why, advice.why).toMatch(/[.!?]$/);
  // One sentence: a full stop only at the end, once a closing "Costs $X." is set aside.
  const body = advice.why.replace(/ Costs \$[\d,]+\.$/, '');
  expect(body.slice(0, -1), advice.why).not.toMatch(/[.!?]\s/);
  expect(`${advice.title} ${advice.why}`, advice.id).not.toMatch(JARGON);
  // Behind "More about this" too, the bank's terms appear only next to their plain meaning (spec G/H; round 4c/4d check).
  expect((advice.detail ?? '').replace(BANK_TERM_GLOSSED, ''), `${advice.id} detail`).not.toMatch(BANK_JARGON);
  expect(advice.title).not.toMatch(/\u2026$/);
  expect(advice.why).not.toMatch(/\u2026$/);
  expect(typeof advice.detail).toBe('string');
  if (advice.cost !== null) {
    expect(Number.isInteger(advice.cost)).toBe(true);
    expect(advice.cost).toBeGreaterThan(0);
    expect(advice.why, `${advice.id} names its cost`).toContain(formatMoney(advice.cost));
  }
}

function expectWellFormed(advice: Advice): void {
  expect(advice.key).toMatch(KEY_PATTERN[advice.id]);
  expect(isAdviceKey(advice.key)).toBe(true);
  const [lo, hi] = BAND[advice.severity];
  expect(advice.priority).toBeGreaterThanOrEqual(lo);
  expect(advice.priority).toBeLessThanOrEqual(hi);
  const label =
    advice.action.kind === 'openPanel' ? { pricing: 'Open Pricing', bank: 'Open Bank', olt: 'Open OLT', customers: 'Open Customers' }[advice.action.panel] : 'Show me';
  expect(advice.actionLabel).toBe(label);
  expect(advice.title.length).toBeGreaterThan(0);
  expect(advice.why.length).toBeGreaterThan(0);
  // Plain prose: no unformatted numbers like 1234.5678 or NaN leak through.
  expect(text(advice)).not.toMatch(/NaN|undefined|Infinity|\d\.\d{3,}/);
  expectShort(advice);
}

/** Commands that borrow or repay (the covenant-safe ones). */
const FINANCING = new Set(['drawCredit', 'takeTermLoan', 'repayCredit', 'prepayLoan']);

/**
 * Apply a plan's commands to a copy: each must succeed, the copy must stay
 * covenant-compliant when the plan borrows or repays, and keep at least the
 * next debt service and what the plan promises to keep (after its extra
 * spend). Returns the copy.
 */
function expectNoBackfire(state: GameState, p: AdvicePlan): GameState {
  const after = clone(state);
  for (const command of p.commands) {
    const result = applyCommand(after, command);
    expect(result, `${p.advice.id}: ${JSON.stringify(command)}`).toMatchObject({ ok: true });
  }
  if (p.commands.some((c) => FINANCING.has(c.type))) expect(covenantMetrics(after).compliant).toBe(true);
  if (p.commands.length > 0) {
    const left = after.finance.cash - p.extraSpend;
    expect(left).toBeGreaterThanOrEqual(estimateNextDebtService(after));
    expect(left).toBeGreaterThanOrEqual(p.keep);
  }
  return after;
}

/**
 * Every plan on `state` is well formed and safe on its own, and following
 * all of them together (in rule order, as advicePlans claims) is safe too;
 * returns the ids that fired.
 */
function expectAllSafe(state: GameState): AdviceId[] {
  const plans = advicePlans(state);
  for (const p of plans) {
    expectWellFormed(p.advice);
    if (p.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan')) expect(p.advice.why).toMatch(/borrow|loan/i);
    expectNoBackfire(state, p);
  }
  expectTogetherSafe(state, plans);
  return plans.map((p) => p.advice.id);
}

/** Apply every plan's commands to one copy, in rule order: all succeed, compliant if any borrows or repays, and the cash kept covers the next debt service and every plan's promise. */
function expectTogetherSafe(state: GameState, plans: readonly AdvicePlan[]): GameState {
  const after = clone(state);
  const ordered = [...plans].sort((a, b) => ADVICE_ORDER.indexOf(a.advice.id) - ADVICE_ORDER.indexOf(b.advice.id));
  let extra = 0;
  for (const p of ordered) {
    for (const command of p.commands) expect(applyCommand(after, command), `${p.advice.id}: ${JSON.stringify(command)}`).toMatchObject({ ok: true });
    extra += p.extraSpend;
  }
  if (ordered.some((p) => p.commands.some((c) => FINANCING.has(c.type)))) expect(covenantMetrics(after).compliant).toBe(true);
  if (ordered.some((p) => p.commands.length > 0)) {
    expect(after.finance.cash - extra).toBeGreaterThanOrEqual(estimateNextDebtService(after));
    for (const p of ordered) expect(after.finance.cash - extra).toBeGreaterThanOrEqual(p.keep);
  }
  return after;
}

const advice = (id: AdviceId, priority: number): Advice => ({
  id,
  key: id,
  repeat: 0,
  priority,
  severity: priority >= 300 ? 'urgent' : priority >= 200 ? 'important' : 'tip',
  title: id,
  why: id,
  detail: '',
  cost: null,
  action: { kind: 'openPanel', panel: 'bank' },
  actionLabel: 'Open Bank',
});

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** The first wording of at most `max` characters (how the advisor fits a title), else the last. */
const fit = (max: number, ...wordings: string[]): string => wordings.find((w) => w.length <= max) ?? wordings[wordings.length - 1]!;
const pct1 = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;

/** "Apr 1": how the advice names a close. */
function closeName(day: number): string {
  return formatDate(nextCloseDay(day)).replace(/, \d+$/, '');
}

// ---------------------------------------------------------------------------
// Frame
// ---------------------------------------------------------------------------

describe('advice frame', () => {
  it('ranks by priority, then by rule order', () => {
    const ranked = rankAdvice([advice('expand', 150), advice('addSplitter', 220), advice('paymentShort', 220), advice('pricing', 150)]);
    expect(ranked.map((a) => a.id)).toEqual(['paymentShort', 'addSplitter', 'pricing', 'expand']);
    expect(new Set(ADVICE_ORDER).size).toBe(ADVICE_ORDER.length);
  });

  it('keeps every rule priority inside a band', () => {
    for (const priority of Object.values(ADVICE_PRIORITY)) {
      expect(priority).toBeGreaterThanOrEqual(100);
      expect(priority).toBeLessThanOrEqual(399);
    }
  });

  it('advises adding a splitter at a full cabinet, and nothing once the game is over', () => {
    const state = litGame(31);
    const cabinet = state.network.cabinets[0]!;
    state.sales.fullCabinets = [cabinet.id];
    const top = advise(state);
    expect(top.length).toBeLessThanOrEqual(ADVICE_MAX);
    const splitter = top.find((a) => a.id === 'addSplitter');
    expect(splitter).toMatchObject({ severity: 'important', action: { kind: 'focusCabinet', cabinet: cabinet.id }, actionLabel: 'Show me' });
    state.gameOver = { day: state.day, reason: 'insolvent', message: 'x' };
    expect(advise(state)).toEqual([]);
    expect(advicePlans(state)).toEqual([]);
    expect(planFor(state, 'addSplitter')).toBeNull();
  });

  it('returns at most `max`, ranked, and the same as the candidates it cuts', () => {
    const state = fixture('v3-grid');
    const all = advicePlans(state).map((p) => p.advice);
    expect(advise(state, 1)).toEqual(all.slice(0, 1));
    expect(advise(state, 0)).toEqual([]);
    expect(advise(state)).toEqual(all.slice(0, ADVICE_MAX));
    expect(rankAdvice(all)).toEqual(all);
  });
});

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

describe('paymentShort', () => {
  /** A borrower whose cash at the next close falls short of its loan payment (no subscribers: the month only costs). */
  function shortOfPayment(): GameState {
    const state = withLoan(trading(20_000, 10_000, 0), 60_000);
    state.finance.cash = estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1;
    return state;
  }

  it('fires when the cash projected at the close cannot pay it, with a covenant-safe draw that covers it', () => {
    const state = shortOfPayment();
    const service = estimateNextDebtService(state);
    const projected = estimateCashAtClose(state);
    expect(projected).toBeLessThan(service);
    const p = plan(state, 'paymentShort');
    expect(p.advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.paymentShort, action: { kind: 'openPanel', panel: 'bank' }, actionLabel: 'Open Bank' });
    expect(p.advice.title).toBe(`Cover the ${closeName(state.day)} loan payment`);
    expect(text(p.advice)).toContain(formatMoney(service));
    expect(text(p.advice)).toContain(formatMoney(projected));
    expect(text(p.advice)).toContain(formatMoney(service - projected));
    expect(p.commands).toHaveLength(1);
    expect(p.commands[0]).toMatchObject({ type: 'drawCredit' });
    const draw = (p.commands[0] as { amount: number }).amount;
    expect(text(p.advice)).toContain(`${formatMoney(draw)} credit-line draw`);
    // Never backfires: compliant, and the close can pay with the draw (its interest included).
    const after = expectNoBackfire(state, p);
    expect(estimateCashAtClose(after)).toBeGreaterThanOrEqual(estimateNextDebtService(after));
  });

  it('says a missed payment is a default while frozen, and offers no borrowing', () => {
    const state = shortOfPayment();
    state.debt.covenant.stage = 'frozen';
    const p = plan(state, 'paymentShort');
    expect(p.commands).toEqual([]);
    expect(text(p.advice)).toMatch(/frozen.*default/);
    expect(text(p.advice)).not.toMatch(/draw|term loan/);
  });

  it('says cut spending when no covenant-safe borrowing covers it', () => {
    // No revenue history: nothing to lend against.
    const state = withLoan(trading(0, 10_000, 0), 60_000);
    state.finance.cash = estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1;
    const p = plan(state, 'paymentShort');
    expect(p.commands).toEqual([]);
    expect(text(p.advice)).toContain("No borrowing inside the bank's limits covers it");
    expect(text(p.advice)).toContain(formatMoney(state.sales.marketingPerMonth));
  });

  it('does not fire with nothing due or when cash covers it', () => {
    expect(planFor(trading(20_000, 10_000, 0), 'paymentShort')).toBeNull();
    const state = withLoan(trading(20_000, 10_000, 500_000), 60_000);
    expect(planFor(state, 'paymentShort')).toBeNull();
  });
});

describe('loansCalled', () => {
  function called(closesLeft: number): GameState {
    const state = withLoan(trading(20_000, 10_000, 200_000), 60_000);
    state.debt.credit.balance = 20_000;
    state.debt.covenant.stage = 'frozen';
    state.debt.frozenCloses = FROZEN_ACCELERATION_CLOSES;
    state.debt.acceleration = { day: state.day - 9, closesLeft };
    return state;
  }

  it('says what falls due at the next close against projected cash, and over the closes left', () => {
    const state = called(2);
    const schedule = acceleratedSchedule(state);
    const p = plan(state, 'loansCalled');
    expect(p.advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.loansCalled, action: { kind: 'openPanel', panel: 'bank' } });
    expect(p.advice.title).toBe(`Repay ${formatMoney(totalDebt(state))} over the next 2 closes`);
    expect(text(p.advice)).toContain(formatMoney(schedule[0]!));
    expect(text(p.advice)).toContain(formatMoney(estimateCashAtClose(state)));
    expect(text(p.advice)).toContain(formatMoney(schedule.slice(1).reduce((a, b) => a + b, 0)));
    expect(text(p.advice)).toContain('default');
    expect(p.commands).toEqual([]);
  });

  it('names the last close when one is left, and does not fire before the call or with nothing owed', () => {
    const last = called(1);
    expect(plan(last, 'loansCalled').advice.title).toBe(`Repay all ${formatMoney(totalDebt(last))} at the ${closeName(last.day)} close`);
    const state = called(2);
    state.debt.acceleration = null;
    expect(planFor(state, 'loansCalled')).toBeNull();
    const paid = called(2);
    paid.debt.loans = [];
    paid.debt.credit.balance = 0;
    expect(planFor(paid, 'loansCalled')).toBeNull();
  });
});

describe('covenantCure', () => {
  /** A compliant-stage borrower breaching leverage at today's figures: debt far above 5x its underwriting cash flow. */
  function overLevered(cash: number, day?: number): GameState {
    const state = trading(10_000, 9_000, cash);
    if (day !== undefined) state.day = day;
    state.debt.credit.balance = 300_000;
    return state;
  }

  it('on the frozen hoarder (v3-grid): urgent, with the first verified cure, and the cure never backfires', () => {
    const state = fixture('v3-grid');
    const m = covenantMetrics(state);
    expect(m.compliant).toBe(false);
    const option = cureOptions(state)[0]!;
    const p = plan(state, 'covenantCure');
    expect(p.advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.covenantCureUrgent, action: { kind: 'openPanel', panel: 'bank' } });
    // The figures in the Bank's own words (spec G/H: no leverage, covenant or × in the summary, its disclosure included).
    expect(text(p.advice)).toContain(`your debt is ${yearsOfProfitWords(m.leverage!)}`);
    expect(text(p.advice)).toContain(`you earn ${perDollarWords(m.coverage!)} for every $1 of loan payments`);
    expect(text(p.advice)).toContain(`your debt to ${yearsOfProfitWords(option.after.leverage!)}`);
    expect(text(p.advice)).toContain(`leaving ${formatMoney(option.cashAfter)} in cash`);
    expect(`${p.advice.title} ${text(p.advice)}`).not.toMatch(/×|leverage|covenant|term loan #|credit line/i);
    const loan = state.debt.loans.find((l) => l.id === option.loan)!;
    expect(p.advice.title).toBe(option.amount >= loan.balance ? `Pay off loan ${option.loan}` : `Pay ${formatMoney(option.amount)} off loan ${option.loan}`);
    expect(p.commands).toEqual([{ type: 'prepayLoan', loan: option.loan, amount: option.amount }]);
    const after = expectNoBackfire(state, p);
    expect(after.finance.cash).toBeGreaterThanOrEqual(estimateNextDebtService(after));
  });

  it('is important while the close is far off on a compliant stage, urgent when it is near or the stage is penalty', () => {
    const far = overLevered(500_000);
    expect(nextCloseDay(far.day) - far.day).toBeGreaterThan(10);
    const p = plan(far, 'covenantCure');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.covenantCureAtRisk });
    const option = cureOptions(far)[0]!;
    expect(option.kind).toBe('repayCredit');
    expect(p.advice.title).toBe(`Pay back ${formatMoney(option.amount)} of emergency cash`);
    expect(text(p.advice)).toContain(`Pay back ${formatMoney(option.amount)} of emergency cash`);
    expect(text(p.advice)).toContain('a warning from the bank');
    expect(p.commands).toEqual([{ type: 'repayCredit', amount: option.amount }]);
    expectNoBackfire(far, p);

    const near = overLevered(500_000, nextCloseDay(far.day) - 5);
    expect(plan(near, 'covenantCure').advice.severity).toBe('urgent');
    const penalty = overLevered(500_000);
    penalty.debt.covenant.stage = 'penalty';
    expect(plan(penalty, 'covenantCure').advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.covenantCureUrgent });
  });

  it("falls back to the 'grow' figure when no repayment can be afforded, and never says borrow more", () => {
    const state = overLevered(1_000);
    const option = cureOptions(state)[0]!;
    expect(option.kind).toBe('grow');
    const p = plan(state, 'covenantCure');
    expect(p.commands).toEqual([]);
    expect(text(p.advice)).toContain(formatMoney(option.amount));
    // The title on the same basis as the text: operating cash flow raised to (about) this.
    const to = Math.round(option.after.annualOperatingCashFlow / LOAN_ROUNDING) * LOAN_ROUNDING;
    expect(p.advice.title).toBe(`Raise profit to about ${formatMoney(to)} a year`);
    expect(text(p.advice)).not.toMatch(/\bdraw\b|take a .*loan/i);
  });

  it('warns when compliant but close to a limit (no command, no borrowing)', () => {
    // Underwriting cash flow is ARR x the minimum margin here; put leverage just inside the risk margin of the limit.
    const state = trading(10_000, 9_000, 500_000);
    const flow = covenantMetrics(state).underwritingCashFlow;
    state.debt.credit.balance = Math.round(flow * 5 * (1 - COVENANT_RISK_MARGIN / 2));
    const m = covenantMetrics(state);
    expect(m.compliant).toBe(true);
    const p = plan(state, 'covenantCure');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.covenantCureAtRisk });
    expect(text(p.advice)).toContain(`your debt is ${yearsOfProfitWords(m.leverage!)}`);
    expect(text(p.advice)).not.toMatch(/×|leverage|covenant/i);
    expect(text(p.advice)).toContain('Hold off on new borrowing');
    expect(p.commands).toEqual([]);
  });

  it('does not fire on a healthy borrower (v3-town) or with no debt', () => {
    expect(planFor(fixture('v3-town'), 'covenantCure')).toBeNull();
    expect(planFor(trading(10_000, 9_000, 500_000), 'covenantCure')).toBeNull();
  });
});

describe('frozenSweep', () => {
  it('on the frozen hoarder (v3-grid): the countdown to the call and what lifts the freeze', () => {
    const state = fixture('v3-grid');
    const left = closesUntilAcceleration(state)!;
    const p = plan(state, 'frozenSweep');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.frozenSweep, action: { kind: 'openPanel', panel: 'bank' } });
    // The words the HUD chip, the Bank and the summary's badge use for the same state and countdown.
    expect(p.advice.title).toBe(`Get back to borrowing within ${left} months`);
    expect(p.advice.why).toBe(`The bank takes your spare cash each month and asks for every loan back in ${left} months.`);
    expect(`${p.advice.title} ${p.advice.why}`).not.toMatch(/freeze|frozen|\bcalls?\b|closes?\b/i);
    expect(text(p.advice)).toContain(`${left} more month closes`);
    expect(text(p.advice)).toContain(`${COVENANT_CURE_CLOSES} good month closes in a row`);
    expect(text(p.advice)).toContain("today's figures still fail them");
  });

  it("quotes the last close's sweep, and says when too few closes remain to cure it", () => {
    const state = fixture('v3-grid');
    state.finance.reports.at(-1)!.debt!.sweep = 4_321;
    expect(text(plan(state, 'frozenSweep').advice)).toContain(`took ${formatMoney(4_321)} of your spare cash`);
    state.debt.frozenCloses = FROZEN_ACCELERATION_CLOSES - 1;
    const late = plan(state, 'frozenSweep').advice;
    expect(text(late)).toContain('only paying back everything stops it');
    expect(late.title).toBe(`Pay back ${formatMoney(totalDebt(state))} before the bank asks`);
  });

  it('does not fire unless frozen and not yet called', () => {
    const state = fixture('v3-grid');
    state.debt.acceleration = { day: state.day, closesLeft: 3 };
    expect(planFor(state, 'frozenSweep')).toBeNull();
    expect(planFor(fixture('v3-town'), 'frozenSweep')).toBeNull();
  });
});

describe('cashRunway', () => {
  /** Burning (revenue - costs) a month with `cash`: runway = floor(cash / burn). */
  const burning = (cash: number) => trading(30_000, 40_000, cash);
  /** What cashRunway suggests without financing (round 4c/4d): marketing cut to MARKETING_CUT_SHARE of today's, rounded down; nothing at $0. */
  const trimMarketing = (state: GameState): Command[] => {
    const m = state.sales.marketingPerMonth;
    return m > 0 ? [{ type: 'setMarketing', perMonth: Math.floor((m * MARKETING_CUT_SHARE) / MARKETING_CUT_ROUNDING) * MARKETING_CUT_ROUNDING }] : [];
  };

  it('is important at a few months of runway, with covenant-safe financing that adds two months', () => {
    const state = burning(35_000);
    const runway = runwayMonths(state)!;
    expect(runway).toBe(3);
    const p = plan(state, 'cashRunway');
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.cashRunway, title: 'Extend your cash runway' });
    expect(text(p.advice)).toContain(formatMoney(10_000));
    expect(text(p.advice)).toContain(`${runway} months`);
    expect(text(p.advice)).toContain('2 months');
    expect(p.commands.length).toBeGreaterThan(0);
    expectNoBackfire(state, p);
  });

  it('is urgent at two months or less with no safe financing, and when installs are paused', () => {
    const frozen = burning(15_000);
    frozen.debt.covenant.stage = 'frozen';
    const p = plan(frozen, 'cashRunway');
    expect(p.advice).toMatchObject({ severity: 'urgent', priority: ADVICE_PRIORITY.cashRunwayUrgent });
    expect(text(p.advice)).toContain("No borrowing inside the bank's limits covers it");
    expect(p.commands).toEqual(trimMarketing(frozen));
    expect(p.commands.length).toBe(1);
    // With safe financing the same runway is important, not urgent.
    expect(plan(burning(15_000), 'cashRunway').advice.severity).toBe('important');

    const paused = trading(30_000, 20_000, 300);
    paused.sales.installsPaused = true;
    const q = plan(paused, 'cashRunway');
    expect(q.advice).toMatchObject({ severity: 'urgent', title: 'Raise cash to restart installs' });
    expect(text(q.advice)).toContain(formatMoney(300));
    expectNoBackfire(paused, q);
  });

  it("takes a storm month's repairs at their yearly average, not as a lasting burn", () => {
    // Earning $10,000 a month; one storm month's repairs would read as a burn of $20,000 a month.
    const stormy = trading(30_000, 20_000, 30_000);
    const last = stormy.finance.reports.at(-1)!;
    last.totals.repair = -30_000;
    last.net -= 30_000;
    expect(monthlyBurn(stormy)).toBe(0);
    expect(runwayMonths(stormy)).toBeNull();
    expect(planFor(stormy, 'cashRunway')).toBeNull();
    // Storm months every month of the window are a real burn.
    const battered = trading(30_000, 20_000, 30_000);
    for (const r of battered.finance.reports) {
      r.totals.repair = -60_000;
      r.net -= 60_000;
    }
    const burn = -(10_000 + Math.round((-60_000 * battered.finance.reports.length) / REPAIR_TRAILING_MONTHS));
    expect(burn).toBeGreaterThan(0);
    expect(monthlyBurn(battered)).toBe(burn);
    expect(runwayMonths(battered)).toBe(Math.floor(30_000 / burn));
  });

  it('lands its financing SUGGESTED_BORROWING_HEADROOM inside the covenants, never just inside them', () => {
    // Leverage where a loan of two months' burn passes the covenants, but not with the headroom.
    const state = burning(35_000);
    const flow = covenantMetrics(state).underwritingCashFlow;
    state.debt.credit.balance = Math.round(flow * COVENANT_MAX_LEVERAGE * (1 - SUGGESTED_BORROWING_HEADROOM)) - LOAN_ROUNDING;
    expect(covenantsWithin(covenantMetrics(state), COVENANT_RISK_MARGIN)).toBe(true);
    // What the rule asks for: two months of burn (at least the fixed costs) beyond the cash above the cushion.
    const cost = 2 * Math.max(monthlyBurn(state), fixedCostsPerMonth(state)) + Math.max(0, state.finance.cash - fundingHint(state, 0).cushion);
    expect(['draw', 'term', 'drawAndTerm']).toContain(fundingHint(state, cost).kind);
    expect(['draw', 'term', 'drawAndTerm']).not.toContain(fundingHint(state, cost, SUGGESTED_BORROWING_HEADROOM).kind);
    const p = plan(state, 'cashRunway');
    expect(p.commands).toEqual(trimMarketing(state));
    expect(text(p.advice)).toContain("No borrowing inside the bank's limits covers it");
    // Where it does borrow, the covenants after it keep the headroom, and the card says so.
    const roomy = burning(35_000);
    const q = plan(roomy, 'cashRunway');
    expect(q.commands.length).toBeGreaterThan(0);
    expect(text(q.advice)).toContain(`at least ${pct(SUGGESTED_BORROWING_HEADROOM)} inside the bank's limits`);
    const copy = deserialize(serialize(roomy));
    for (const command of q.commands) expect(applyCommand(copy, command).ok).toBe(true);
    expect(covenantsWithin(covenantMetrics(copy), SUGGESTED_BORROWING_HEADROOM)).toBe(true);
    expect(planFor(copy, 'covenantCure')).toBeNull();
  });

  it('does not borrow to pay old debt with new: past break-even, short of the loan payments it owes', () => {
    // Operating cash flow positive but below the debt service: the burn is the loans' own payments.
    const state = withLoan(trading(30_000, 29_500, 2_000), 60_000);
    const last = state.finance.reports.at(-1)!;
    last.debt = { ...noDebtStats(state), termBalance: totalDebt(state), annualDebtService: covenantMetrics(state).annualDebtService };
    const m = covenantMetrics(state);
    expect(m.annualOperatingCashFlow).toBeGreaterThanOrEqual(0);
    expect(m.annualOperatingCashFlow).toBeLessThan(m.annualDebtService);
    const runway = runwayMonths(state);
    expect(runway).not.toBeNull();
    expect(runway!).toBeLessThanOrEqual(4);
    const p = plan(state, 'cashRunway');
    expect(p.commands).toEqual(trimMarketing(state));
    expect(p.advice.title).toMatch(/^Slow spending: /);
    expect(text(p.advice)).toContain(`Your operating cash flow (${formatMoney(m.annualOperatingCashFlow)} a year) does not cover the ${formatMoney(m.annualDebtService)} a year of loan payments`);
    expect(text(p.advice)).toContain('cannot carry more debt');
    // Borrowing would have been covenant-safe, with the headroom: it is the debt service that stops it.
    const cost = 2 * Math.max(monthlyBurn(state), fixedCostsPerMonth(state));
    expect(['draw', 'term', 'drawAndTerm']).toContain(fundingHint(state, cost, SUGGESTED_BORROWING_HEADROOM).kind);
    // A network still short of break-even may borrow to bridge to it.
    expect(plan(burning(35_000), 'cashRunway').commands.length).toBeGreaterThan(0);
  });

  it('suggests no borrowing once covenantCure has said not to borrow', () => {
    // Burning with a few months of runway, and leverage inside the risk margin of the limit.
    const state = burning(35_000);
    const flow = covenantMetrics(state).underwritingCashFlow;
    state.debt.credit.balance = Math.round(flow * COVENANT_MAX_LEVERAGE * (1 - COVENANT_RISK_MARGIN / 2));
    expect(covenantMetrics(state).compliant).toBe(true);
    // A loan just inside the covenants exists, but not one SUGGESTED_BORROWING_HEADROOM inside them (more than the risk
    // margin), so the runway rule does not borrow on its own either ...
    const cost = 2 * Math.max(monthlyBurn(state), fixedCostsPerMonth(state)) + Math.max(0, state.finance.cash - fundingHint(state, 0).cushion);
    expect(['draw', 'term', 'drawAndTerm']).toContain(fundingHint(state, cost).kind);
    expect(plan(state, 'cashRunway').commands).toEqual(trimMarketing(state));
    // ... and next to the covenant warning it says not to.
    const plans = advicePlans(state);
    expect(text(plans.find((p) => p.advice.id === 'covenantCure')!.advice)).toContain('Hold off on new borrowing');
    const runway = plans.find((p) => p.advice.id === 'cashRunway')!;
    expect(runway.commands).toEqual(trimMarketing(state));
    expect(text(runway.advice)).toContain("don't borrow");
    expect(plans.every((p) => !p.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan'))).toBe(true);
    expectTogetherSafe(state, plans);
  });

  it('never lends into a network that will not pay its way even signed up to target (round 4c/4d, spec B)', () => {
    // The same burn with a marketing budget no network this size can carry: signed up to target it still loses money.
    const state = burning(35_000);
    state.sales.marketingPerMonth = 40_000;
    // A covenant-safe loan exists ...
    const cost = 2 * Math.max(monthlyBurn(state), fixedCostsPerMonth(state)) + Math.max(0, state.finance.cash - fundingHint(state, 0).cushion);
    expect(['draw', 'term', 'drawAndTerm']).toContain(fundingHint(state, cost, SUGGESTED_BORROWING_HEADROOM).kind);
    // ... but the card lends nothing: it cuts marketing and says why.
    const p = plan(state, 'cashRunway');
    expect(p.commands.some((c) => FINANCING.has(c.type))).toBe(false);
    expect(p.commands).toEqual(trimMarketing(state));
    expect(p.advice.title).toMatch(/^Slow spending: /);
    expect(p.advice.why).toContain("loans won't fix it");
    expect(p.advice.detail).toContain('not enough to carry another loan');
    // With a budget the network can carry, the same runway borrows.
    expect(plan(burning(35_000), 'cashRunway').commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan')).toBe(true);
  });

  it('has nothing to cut at $0 of marketing', () => {
    const none = burning(15_000);
    none.debt.covenant.stage = 'frozen';
    none.sales.marketingPerMonth = 0;
    expect(plan(none, 'cashRunway').commands).toEqual([]);
  });

  it('does not fire with a long runway or when not burning', () => {
    expect(planFor(burning(60_000), 'cashRunway')).toBeNull();
    expect(planFor(trading(30_000, 20_000, 5_000), 'cashRunway')).toBeNull();
  });
});

describe('addSplitter', () => {
  it('picks the full cabinet with the most customers waiting, quoting the splitter', () => {
    const state = makeTestState(makeGridCity({ cols: 3, rows: 2 }));
    // A cabinet with nothing to serve (no cable at its corner) gets the lower id ...
    const idle = state.nextId++;
    state.network.cabinets.push({ id: idle, node: state.city.nodes.length - 1, splitters: 1, stage: 'live', stageDaysLeft: 0, cost: 0, orderedDay: 0, liveDay: 0 });
    const busy = addLivePlant(state, { splitters: 4, segments: state.city.segments.filter((s) => s.a !== state.city.nodes.length - 1 && s.b !== state.city.nodes.length - 1).map((s) => s.id) })!;
    runDays(state, 31);
    state.sales.fullCabinets = [idle, busy];
    const p = plan(state, 'addSplitter');
    // ... but the busy one has demand waiting.
    expect(p.advice.action).toEqual({ kind: 'focusCabinet', cabinet: busy });
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.addSplitterFull, actionLabel: 'Show me' });
    const place = cornerName(state.city, state.network.cabinets.find((c) => c.id === busy)!.node);
    expect(p.advice.title).toBe(`Add a splitter at ${place}`);
    expect(text(p.advice)).toContain(formatMoney(SPLITTER_COST));
    expect(text(p.advice)).toContain(`${SPLIT_RATIO} ports`);
    expect(text(p.advice)).toMatch(/about \d+ customers? waiting/);
    expect(p.commands).toEqual([{ type: 'addSplitter', cabinet: busy }]);
    expectNoBackfire(state, p);
  });

  it('flags a nearly full cabinet with demand waiting', () => {
    const state = centerGame(1);
    const cabinet = state.network.cabinets[0]!;
    cabinet.splitters = 1;
    // Hand over ports: 90% of one splitter's, on the first parcels.
    const take = Math.ceil(0.9 * SPLIT_RATIO);
    state.sales.accounts = state.city.parcels.slice(0, take).map((parcel) => ({
      parcel: parcel.id,
      cabinet: cabinet.id,
      tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 },
      since: 0,
      locks: [],
    }));
    state.sales.fullCabinets = [];
    const p = plan(state, 'addSplitter');
    expect(p.advice).toMatchObject({ priority: ADVICE_PRIORITY.addSplitterNearlyFull, action: { kind: 'focusCabinet', cabinet: cabinet.id } });
    expect(text(p.advice)).toContain(`${take} of its ${SPLIT_RATIO} ports in use`);
  });

  it('suggests covenant-safe financing when cash is thin, and waits when nothing safe pays for it', () => {
    const thin = trading(20_000, 10_000, SPLITTER_COST);
    addLivePlant(thin, { splitters: 1 });
    thin.sales.fullCabinets = [thin.network.cabinets[0]!.id];
    const p = plan(thin, 'addSplitter');
    expect(p.advice.priority).toBe(ADVICE_PRIORITY.addSplitterFinanced);
    expect(p.commands.map((c) => c.type)).toEqual(['drawCredit', 'addSplitter']);
    expectNoBackfire(thin, p);

    const broke = trading(0, 10_000, SPLITTER_COST);
    addLivePlant(broke, { splitters: 1 });
    broke.sales.fullCabinets = [broke.network.cabinets[0]!.id];
    const q = plan(broke, 'addSplitter');
    expect(q.advice).toMatchObject({ priority: ADVICE_PRIORITY.addSplitterShort });
    expect(q.advice.title).toMatch(/^Add a splitter at .* when cash allows$/);
    expect(q.commands).toEqual([]);
  });

  it('does not fire without a free slot or a free PON port (that is addOltCard), or with no cabinet in need', () => {
    const state = litGame(31);
    const cabinet = state.network.cabinets[0]!;
    expect(planFor(state, 'addSplitter')).toBeNull();
    state.sales.fullCabinets = [cabinet.id];
    cabinet.splitters = MAX_SPLITTERS_PER_CABINET;
    expect(planFor(state, 'addSplitter')).toBeNull();
    cabinet.splitters = 4;
    state.network.olt.ponPorts = ponPortsUsed(state);
    expect(planFor(state, 'addSplitter')).toBeNull();
    expect(plan(state, 'addOltCard').advice.priority).toBe(ADVICE_PRIORITY.addOltCardNeeded);
  });
});

describe('addOltCard', () => {
  it('is important when a cabinet needs a port and none is free, quoting the card', () => {
    const state = litGame(31);
    const cabinet = state.network.cabinets[0]!;
    state.sales.fullCabinets = [cabinet.id];
    state.network.olt.ponPorts = ponPortsUsed(state);
    const p = plan(state, 'addOltCard');
    expect(p.advice).toMatchObject({ severity: 'important', action: { kind: 'openPanel', panel: 'olt' }, actionLabel: 'Open OLT', title: 'Add an OLT line card' });
    expect(text(p.advice)).toContain(cornerName(state.city, cabinet.node));
    expect(text(p.advice)).toContain(formatMoney(OLT_CARD_COST));
    expect(text(p.advice)).toContain(`${OLT_PORTS_PER_CARD} more`);
    expect(p.commands).toEqual([{ type: 'addOltCard' }]);
    expectNoBackfire(state, p);
  });

  it('is a tip when the ports are nearly all used, and quiet below that or with the chassis full', () => {
    const state = litGame(31);
    const used = ponPortsUsed(state);
    state.network.olt.ponPorts = used;
    expect(plan(state, 'addOltCard').advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.addOltCardNearlyFull });
    state.network.olt.ponPorts = Math.ceil(used / 0.8);
    expect(planFor(state, 'addOltCard')).toBeNull();
    state.network.olt.ponPorts = used;
    state.network.olt.cards = OLT_MAX_CARDS;
    expect(planFor(state, 'addOltCard')).toBeNull();
  });
});

describe('outages', () => {
  /** Put an outage on `span` (days left, repair cost), as weather.stepWeather would. */
  function breakSpan(state: GameState, span: CableSpan, daysLeft: number, repairCost: number): void {
    span.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft, repairCost };
    state.network.version++;
  }

  /** Subscribed units on parcels served by `segment`. */
  function unitsOn(state: GameState, segment: number): number {
    let units = 0;
    for (const a of state.sales.accounts) {
      if (state.city.parcels[a.parcel]!.segment === segment) units += a.tierUnits.fiber500 + a.tierUnits.fiber1g + a.tierUnits.fiber2g;
    }
    return units;
  }

  it('names the street cutting off the most subscribers, the days left, the repair and the churn risk', () => {
    const state = litGame(150);
    const bySubs = [...state.network.spans].sort((a, b) => unitsOn(state, b.segment) - unitsOn(state, a.segment));
    const worst = bySubs[0]!;
    const other = bySubs.find((s) => unitsOn(state, s.segment) > 0 && unitsOn(state, s.segment) < unitsOn(state, worst.segment)) ?? bySubs[1]!;
    breakSpan(state, worst, 4, 2_345);
    breakSpan(state, other, 6, 1_111);
    const units = outageImpact(state, worst.id).subscribers;
    expect(units).toBeGreaterThan(0);
    const p = plan(state, 'outages');
    const street = state.city.segments[worst.segment]!.name;
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.outages, title: `Service is out on ${street}` });
    expect(p.advice.action).toEqual({ kind: 'focusSegment', segment: worst.segment });
    expect(text(p.advice)).toContain(`${units} subscriber`);
    expect(text(p.advice)).toContain('4 days');
    expect(text(p.advice)).toContain(formatMoney(2_345));
    // Out no day yet (the outage starts today), and 3 more before the repair on the 4th: churn for 3 days,
    // charged at the closes after today and after the last day out.
    expect(text(p.advice)).toContain(pct(outageChurnProbability(3)));
    const [first, last] = [closeName(state.day), closeName(state.day + 3)];
    expect(text(p.advice)).toContain(first === last ? `at the ${first} close` : `at the ${first} and ${last} closes`);
    expect(p.commands).toEqual([]);
  });

  it('does not fire with no outage, or when the outage cuts nobody off', () => {
    const state = litGame(150);
    expect(planFor(state, 'outages')).toBeNull();
    // The street with the most subscribers (round 4c/4d: homes switch over months, so not every street has some yet).
    const busiest = [...state.network.spans].sort((a, b) => unitsOn(state, b.segment) - unitsOn(state, a.segment))[0]!;
    expect(unitsOn(state, busiest.segment)).toBeGreaterThan(0);
    breakSpan(state, busiest, 3, 999);
    expect(planFor(state, 'outages')).not.toBeNull();
    // Nobody left whom it cuts off.
    const { cutOff } = outageService(state, getService(state));
    expect(cutOff.size).toBeGreaterThan(0);
    state.sales.accounts = state.sales.accounts.filter((a) => !cutOff.has(a.parcel));
    expect(planFor(state, 'outages')).toBeNull();
  });
});

describe('stormUnderground', () => {
  /** A lit grid (rural by default: every street exposed) with aerial plant, and `hits` storms that damaged the span on the busiest street. */
  function stormy(hits: number, days = 150, city: City = ruralGrid()): { state: GameState; span: CableSpan } {
    const state = litGame(days, city);
    for (const span of state.network.spans) span.method = 'aerial';
    state.network.version++;
    const subs = (seg: number) => state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === seg).length;
    const span = [...state.network.spans].sort((a, b) => subs(b.segment) - subs(a.segment))[0]!;
    for (let i = 0; i < hits; i++) {
      state.weather.storms.push({ id: i + 1, day: state.day - 30 * (hits - i), x: 0, y: 0, radius: 10, severity: 2, spans: [span.id], repairCost: 1 });
    }
    state.weather.nextStormId = hits + 1;
    return { state, span };
  }

  const band = (state: GameState, segment: number) => exposureBand(segmentExposure(state.city, segment));

  it('suggests rebuilding a storm-prone aerial span on an exposed street underground, with the quote against the repairs', () => {
    const { state, span } = stormy(2);
    expect(band(state, span.segment)).toBe('exposed');
    const quote = quoteConvert(state, span.id);
    expect(quote.ok).toBe(true);
    const saved = quote.repairsAvoidedPerYear + 12 * quote.poleRentSaved;
    expect(saved * CONVERT_PAYBACK_YEARS).toBeGreaterThanOrEqual(quote.cost);
    const p = plan(state, 'stormUnderground');
    const street = state.city.segments[span.segment]!.name;
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.stormUnderground, title: `Rebuild ${street} underground` });
    expect(p.advice.key).toBe(ADVICE_KEYS.stormUnderground(span.id));
    expect(p.advice.action).toEqual({ kind: 'focusSegment', segment: span.segment });
    expect(text(p.advice)).toContain('an exposed street');
    expect(text(p.advice)).toContain('2 times');
    expect(text(p.advice)).toContain(formatMoney(2 * repairCost(state.city.segments[span.segment]!, 'aerial')));
    expect(text(p.advice)).toContain(formatMoney(quote.cost));
    expect(text(p.advice)).toContain(formatMoney(quote.repairsAvoidedPerYear));
    expect(text(p.advice)).toContain(`${Math.ceil(quote.cost / saved)} year`);
    expect(p.commands).toEqual([{ type: 'convertSpan', span: span.id }]);
    expectNoBackfire(state, p);
  });

  it('points only at exposed streets: a sheltered street gets no card, however often storms hit it', () => {
    const { state, span } = stormy(3, 150, shelteredGrid());
    expect(band(state, span.segment)).not.toBe('exposed');
    expect(planFor(state, 'stormUnderground')).toBeNull();
    // Make that one street rural (a fresh copy of the city, so its exposure is measured anew): the card comes.
    const copy = clone(state);
    copy.city.segments[span.segment]!.zone = 'rural';
    expect(band(copy, span.segment)).toBe('exposed');
    expect(plan(copy, 'stormUnderground').advice.action).toEqual({ kind: 'focusSegment', segment: span.segment });
  });

  it('on a generated town: rebuilds only when it pays, else says build underground around it (and only there)', () => {
    const state = fixture('v3-town');
    for (const segment of state.city.segments) segment.zone = 'rural';
    const aerial = state.network.spans.filter((s) => s.method === 'aerial' && s.stage === 'live');
    state.weather.storms = [1, 2].map((id) => ({ id, day: state.day - 40 * id, x: 0, y: 0, radius: 9, severity: 2, spans: aerial.map((s) => s.id), repairCost: 1 }));
    state.weather.nextStormId = 3;
    state.finance.cash += 200_000;
    const p = plan(state, 'stormUnderground');
    const segment = (p.advice.action as { segment: number }).segment;
    expect(band(state, segment)).toBe('exposed');
    const span = state.network.spans.find((s) => s.segment === segment)!;
    expect(p.advice.key).toBe(ADVICE_KEYS.stormUnderground(span.id));
    const quote = quoteConvert(state, span.id);
    const name = state.city.segments[segment]!.name;
    expect(text(p.advice)).toContain(formatMoney(quote.cost));
    if ((quote.repairsAvoidedPerYear + 12 * quote.poleRentSaved) * CONVERT_PAYBACK_YEARS >= quote.cost) {
      expect(p.advice.title).toBe(`Rebuild ${name} underground`);
      expect(p.commands).toEqual([{ type: 'convertSpan', span: span.id }]);
    } else {
      expect(p.advice.title).toBe(`Build underground around ${name}`);
      expect(text(p.advice)).toContain('underground instead');
      expect(p.commands).toEqual([]);
    }
  });

  it('falls back to building underground when cash does not cover the rebuild', () => {
    const { state, span } = stormy(2);
    state.finance.cash = 100;
    const p = plan(state, 'stormUnderground');
    expect(p.advice.title).toBe(`Build underground around ${state.city.segments[span.segment]!.name}`);
    expect(text(p.advice)).toContain('build new streets around here underground');
    expect(p.commands).toEqual([]);
  });

  it('gives one card per span: a snoozed span gives way to the next storm-prone one', () => {
    const { state, span } = stormy(2);
    const subs = (seg: number) => state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === seg).length;
    const second = [...state.network.spans].filter((s) => s.id !== span.id).sort((a, b) => subs(b.segment) - subs(a.segment))[0]!;
    for (const storm of state.weather.storms) storm.spans = [span.id, second.id];
    const first = advise(state, 99).find((a) => a.id === 'stormUnderground')!;
    const other = first.key === ADVICE_KEYS.stormUnderground(span.id) ? second : span;
    expect([span.id, second.id].map((id) => ADVICE_KEYS.stormUnderground(id))).toContain(first.key);
    expect(applyCommand(state, { type: 'snoozeAdvice', key: first.key })).toEqual({ ok: true, cost: 0 });
    const next = advise(state, 99).find((a) => a.id === 'stormUnderground')!;
    expect(next.key).toBe(ADVICE_KEYS.stormUnderground(other.id));
    expect(next.action).toEqual({ kind: 'focusSegment', segment: other.segment });
    // planFor ignores snoozes: the rule's own best subject.
    expect(planFor(state, 'stormUnderground')!.advice.key).toBe(first.key);
  });

  it('does not fire for one storm, old storms, underground plant or a span feeding nobody', () => {
    expect(planFor(stormy(1).state, 'stormUnderground')).toBeNull();
    const old = stormy(2);
    old.state.day += STORM_LOG_DAYS + 61;
    expect(planFor(old.state, 'stormUnderground')).toBeNull();
    const buried = stormy(2);
    buried.span.method = 'underground';
    expect(planFor(buried.state, 'stormUnderground')).toBeNull();
    const nobody = stormy(2);
    nobody.state.sales.accounts = [];
    expect(planFor(nobody.state, 'stormUnderground')).toBeNull();
  });
});

describe('incumbentPromo', () => {
  /** litGame with the incumbent's promo running (not answered) at the CO cabinet for three more months. */
  function promoted(days = 150): GameState {
    const state = litGame(days);
    const cabinet = state.network.cabinets[0]!;
    const endDay = closeDayAfter(state.day, 3);
    state.sales.incumbentPromos = [{ cabinet: cabinet.id, startDay: state.day - 1, endDay, price: incumbentPromoPrice(), quietUntil: closeDayAfter(endDay, 6), triggerTakePct: 45, answered: false, answeredWithPromo: false }];
    return state;
  }

  /** What bestIncumbentAnswer says when nothing pays. */
  const none = (state: GameState, cabinet: number): IncumbentAnswer => ({ ...realIncumbent.bestIncumbentAnswer(state, cabinet), kind: 'none', promo: null, netValue: 0, text: '' });

  it('when nothing pays: a tip with what the promo costs and that it ends on its own, recommending no remedy', () => {
    answerMock.mockImplementation(none);
    const state = promoted();
    const cabinet = state.network.cabinets[0]!;
    const promo = state.sales.incumbentPromos[0]!;
    const p = plan(state, 'incumbentPromo');
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.incumbentPromoRideOut, action: { kind: 'focusCabinet', cabinet: cabinet.id }, actionLabel: 'Show me' });
    expect(p.advice.key).toBe(ADVICE_KEYS.incumbentPromo(cabinet.id));
    expect(p.advice.title).toBe(fit(ADVICE_TITLE_MAX, `Ride out cable's promo at ${cornerName(state.city, cabinet.node)}`, "Ride out the cable company's promo"));
    // Every lot here is a home: the weighted target is the home target.
    expect(text(p.advice)).toContain(`${pct(stateTakeRate(state, 'home', cabinet.id))} instead of ${pct(stateTakeRate(state, 'home'))}`);
    expect(text(p.advice)).toContain(formatMoney(incumbentPromoPrice()));
    expect(text(p.advice)).toContain(formatMoney(INCUMBENT_PRICE));
    expect(text(p.advice)).toContain('3 months');
    const units = state.sales.accounts.filter((a) => a.cabinet === cabinet.id).reduce((n, a) => n + Object.values(a.tierUnits).reduce((x, y) => x + y, 0), 0);
    const extra = Math.round(units * INCUMBENT_PROMO_CHURN * 3);
    if (extra > 0) expect(text(p.advice)).toContain(`about ${extra} cancellation`);
    expect(text(p.advice)).toContain(`ends on its own on ${formatDate(promo.endDay)}`);
    // No remedy: never marketing, a price cut or a promo the quotes say does not pay.
    expect(text(p.advice)).not.toMatch(/marketing|price cut|Answer with/i);
    expect(p.commands).toEqual([]);
  });

  it('when a remedy pays: recommends exactly bestIncumbentAnswer\'s sentence, with its command', () => {
    const state = promoted();
    const cabinet = state.network.cabinets[0]!;
    const answerText = 'A retention offer (15% off until the promo ends) costs about $1 and keeps about 2 subscribers worth $3: answer it in Pricing.';
    answerMock.mockImplementation((s, c) => ({ ...none(s, c), kind: 'retention', netValue: 2, text: answerText }));
    // Drawn straight from planFor: the stub's answerIncumbent rejects until pricing-balance merges, so the command is not applied here.
    const p = planFor(state, 'incumbentPromo')!;
    expectWellFormed(p.advice);
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.incumbentPromo, action: { kind: 'openPanel', panel: 'pricing' }, actionLabel: 'Open Pricing' });
    expect(p.advice.title).toBe(fit(ADVICE_TITLE_MAX, `Answer cable's promo at ${cornerName(state.city, cabinet.node)}`, "Answer the cable company's promo"));
    expect(p.advice.detail.endsWith(` ${answerText}`)).toBe(true);
    expect(p.commands).toEqual([{ type: 'answerIncumbent', cabinet: cabinet.id }]);
    expect(text(p.advice)).not.toMatch(/marketing/i);

    // An intro promo that pays: set it.
    const introText = 'An intro promo (20% off for 3 months) wins about 4 signups worth $900 for $300 of discounts: set it in Pricing.';
    const promo = { percentOff: 20, months: 3 };
    answerMock.mockImplementation((s, c) => ({ ...none(s, c), kind: 'introPromo', promo, netValue: 600, text: introText }));
    const q = plan(state, 'incumbentPromo');
    expect(q.advice.detail.endsWith(` ${introText}`)).toBe(true);
    expect(q.commands).toEqual([{ type: 'setPromo', promo }]);
  });

  it('holds a paying remedy back while cash is short for the next payment: a discount would cut the revenue that pays it', () => {
    const answerText = 'A retention offer (15% off until the promo ends) costs about $1 and keeps about 2 subscribers worth $3: answer it in Pricing.';
    answerMock.mockImplementation((s, c) => ({ ...none(s, c), kind: 'retention', netValue: 2, text: answerText }));
    const state = withLoan(promoted(), 600_000);
    state.finance.cash = Math.max(0, estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1);
    expect(estimateCashAtClose(state)).toBeLessThan(estimateNextDebtService(state));
    const plans = advicePlans(state);
    expect(plans.some((p) => p.advice.id === 'paymentShort' || p.advice.id === 'cashRunway')).toBe(true);
    expect(plans.some((p) => p.advice.id === 'incumbentPromo')).toBe(false);
    // On its own (no earlier claims), the remedy is still what the rule would say.
    expect(planFor(state, 'incumbentPromo')?.commands).toEqual([{ type: 'answerIncumbent', cabinet: state.network.cabinets[0]!.id }]);
  });

  it('clears once the promo is answered, or when none runs', () => {
    const state = promoted();
    expect(planFor(state, 'incumbentPromo')).not.toBeNull();
    state.sales.incumbentPromos[0]!.answered = true;
    expect(planFor(state, 'incumbentPromo')).toBeNull();
    expect(advise(state, 99).some((a) => a.id === 'incumbentPromo')).toBe(false);
    const over = promoted();
    over.sales.incumbentPromos = [];
    expect(planFor(over, 'incumbentPromo')).toBeNull();
  });

  it('clears once answered with the intro promo it recommended, and does not switch to another remedy', () => {
    // SMART's young game with an incumbent promo at its largest area, where the intro promo is the best answer.
    let found: { state: GameState; cabinet: number } | null = null;
    for (const seed of TUNING_SEEDS) {
      const state = runBot(seed, smartBot(), 4).state;
      if (state.sales.promo !== null) expect(applyCommand(state, { type: 'setPromo', promo: null }).ok).toBe(true);
      const { cabinet } = ensureIncumbentPromo(state);
      if (realIncumbent.bestIncumbentAnswer(state, cabinet).kind === 'introPromo') {
        found = { state, cabinet };
        break;
      }
    }
    expect(found, 'a tuning seed where the intro promo is the best answer').not.toBeNull();
    const { state, cabinet } = found!;
    const key = ADVICE_KEYS.incumbentPromo(cabinet);
    const card = planFor(state, 'incumbentPromo')!;
    expect(card.advice.key).toBe(key);
    expect(card.commands).toHaveLength(1);
    expect(card.commands[0]!.type).toBe('setPromo');
    for (const command of card.commands) expect(applyCommand(state, command).ok).toBe(true);
    const promo = state.sales.incumbentPromos.find((p) => p.cabinet === cabinet)!;
    expect(promo.answeredWithPromo).toBe(true);
    // The intro promo spares no churn: only a retention offer does.
    expect(promo.answered).toBe(false);
    expect(incumbent.answeredPromoAt(state, cabinet, state.day)).toBe(false);
    expect(planFor(state, 'incumbentPromo')).toBeNull();
    expect(advicePlans(state).some((p) => p.advice.key === key)).toBe(false);
    expect(realIncumbent.bestIncumbentAnswer(state, cabinet).kind).toBe('none');
    // Still answered a week on; taking the intro promo away brings the card back.
    runDays(state, 7);
    expect(advicePlans(state).some((p) => p.advice.key === key)).toBe(false);
    expect(applyCommand(state, { type: 'setPromo', promo: null }).ok).toBe(true);
    expect(state.sales.incumbentPromos.find((p) => p.cabinet === cabinet)!.answeredWithPromo).toBe(false);
    expect(planFor(state, 'incumbentPromo')?.advice.key).toBe(key);
  });

  it('an intro promo set where the retention offer was the best answer leaves that card up', () => {
    // Lit over a year ago: the intro promo's boost is for young streets (round 4c/4d), so it is not the best answer here.
    const state = promoted(400);
    const cabinet = state.network.cabinets[0]!;
    const promo = state.sales.incumbentPromos[0]!;
    // setPromo asks the real bestIncumbentAnswer: whatever it says here is not an intro promo, so the promo is not answered by one.
    expect(realIncumbent.bestIncumbentAnswer(state, cabinet.id).kind).not.toBe('introPromo');
    expect(applyCommand(state, { type: 'setPromo', promo: { percentOff: 20, months: 3 } }).ok).toBe(true);
    expect(promo.answeredWithPromo).toBe(false);
    expect(planFor(state, 'incumbentPromo')?.advice.key).toBe(ADVICE_KEYS.incumbentPromo(cabinet.id));
  });

  it('gives one card per cabinet: a snoozed one gives way to the next area', () => {
    answerMock.mockImplementation(none);
    const state = makeTestState(makeGridCity({ cols: 4, rows: 2 }));
    addLivePlant(state, { splitters: 4 });
    const far = state.city.nodes.at(-1)!.id;
    addLivePlant(state, { segments: [], node: far, splitters: 4 });
    runDays(state, 150);
    const cabinets = state.network.cabinets.filter((c) => state.sales.accounts.some((a) => a.cabinet === c.id));
    expect(cabinets.length).toBe(2);
    const endDay = closeDayAfter(state.day, 3);
    state.sales.incumbentPromos = cabinets.map((c) => ({ cabinet: c.id, startDay: state.day - 1, endDay, price: incumbentPromoPrice(), quietUntil: closeDayAfter(endDay, 6), triggerTakePct: 45, answered: false, answeredWithPromo: false }));
    const first = advise(state, 99).find((a) => a.id === 'incumbentPromo')!;
    expect(applyCommand(state, { type: 'snoozeAdvice', key: first.key })).toEqual({ ok: true, cost: 0 });
    const next = advise(state, 99).find((a) => a.id === 'incumbentPromo')!;
    expect(next.key).not.toBe(first.key);
    expect(next.key).toMatch(KEY_PATTERN.incumbentPromo);
    // Answering the second clears it too: then only the snoozed one is left, and it stays snoozed.
    const second = Number(next.key.split(':')[2]);
    state.sales.incumbentPromos.find((p) => p.cabinet === second)!.answered = true;
    expect(advise(state, 99).some((a) => a.id === 'incumbentPromo')).toBe(false);
    expect(buildBriefing(state)!.snoozed).toBeGreaterThanOrEqual(1);
  });

  it('does not fire before the promo starts, after it ends, or where you have no subscribers', () => {
    const state = promoted();
    state.sales.incumbentPromos[0]!.startDay = state.day + 1;
    expect(planFor(state, 'incumbentPromo')).toBeNull();
    const ended = promoted();
    ended.sales.incumbentPromos[0]!.endDay = ended.day;
    expect(planFor(ended, 'incumbentPromo')).toBeNull();
    const empty = promoted();
    empty.sales.accounts = [];
    expect(planFor(empty, 'incumbentPromo')).toBeNull();
  });
});

describe('takeRate', () => {
  /** Days for the first lit areas to count as mature, plus a little. */
  const MATURE = Math.ceil((TAKE_RATE_MATURE_MONTHS * DAYS_PER_YEAR) / 12) + 20;

  /** centerGame with every price `factor` times its market price from day 0. */
  function pricedGame(days: number, factor: number): GameState {
    const state = makeTestState(makeGridCity({ cols: 4, rows: 2, coAt: [2, 1] }));
    addLivePlant(state, { splitters: 4 });
    const tiers = state.sales.pricing.tiers.map((t) => ({ id: t.id, price: Math.round(t.price * factor), offered: t.offered }));
    expect(applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: state.sales.pricing.smbMultiplier }).ok).toBe(true);
    runDays(state, days);
    return state;
  }

  it('fires when mature areas lag their target because the prices slow switching (round 4c/4d: prices only)', () => {
    const state = pricedGame(MATURE, 1.35);
    const deal = dealFactor(state.sales.pricing, 'home', INCUMBENT_PRICE, state.sales.promo);
    expect(deal).toBeLessThan(TAKE_RATE_SLOW_DEAL);
    const passings = getService(state).passings;
    expect(passings).toBeGreaterThanOrEqual(50);
    const target = stateTakeRate(state, 'home');
    const subs = state.sales.accounts.length;
    expect(subs / passings).toBeLessThan(TAKE_RATE_LAG_SHARE * target);
    const p = plan(state, 'takeRate');
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.takeRate, action: { kind: 'openPanel', panel: 'pricing' }, title: 'Your prices slow sign-ups' });
    expect(p.advice.why).toContain(`${pct(subs / passings)} signed (target ${pct(target)})`);
    expect(p.advice.detail).toContain(`${pct(subs / passings)} against a ${pct(target)} target`);
    expect(p.advice.detail).toContain(`about ${pct(deal)} of the speed`);
    expect(p.commands).toEqual([]);
  });

  it('leaves marketing to growCustomers: quiet at the default prices however thin the marketing, and before areas are mature', () => {
    const thin = centerGame(MATURE, 0);
    expect(dealFactor(thin.sales.pricing, 'home', INCUMBENT_PRICE, thin.sales.promo)).toBeGreaterThanOrEqual(TAKE_RATE_SLOW_DEAL);
    expect(planFor(thin, 'takeRate')).toBeNull();
    // Still ramping: lit for less than TAKE_RATE_MATURE_MONTHS (6 months is well short of it).
    expect(TAKE_RATE_MATURE_MONTHS).toBeGreaterThan(6);
    expect(planFor(pricedGame(200, 1.35), 'takeRate')).toBeNull();
  });

  it('is quiet while installs are paused or an earlier suggestion is about cash running short', () => {
    const state = pricedGame(MATURE, 1.35);
    expect(planFor(state, 'takeRate')).not.toBeNull();
    state.sales.installsPaused = true;
    expect(planFor(state, 'takeRate')).toBeNull();
    expect(advicePlans(state).some((p) => p.advice.id === 'takeRate')).toBe(false);
  });
});

describe('pricing', () => {
  function priced(id: TierId, factor: number): GameState {
    const state = litGame(150);
    const tiers = state.sales.pricing.tiers.map((t) => ({ id: t.id, price: t.id === id ? Math.round(t.price * factor) : t.price, offered: t.offered }));
    expect(applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: state.sales.pricing.smbMultiplier })).toMatchObject({ ok: true });
    return state;
  }

  it('above the market: more churn, said in figures', () => {
    const state = priced('fiber1g', 1.3);
    const tier = state.sales.pricing.tiers.find((t) => t.id === 'fiber1g')!;
    const ref = TIER_DEFAULTS.find((t) => t.id === 'fiber1g')!.price;
    const p = plan(state, 'pricing');
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.pricing, title: `Bring ${tier.name} closer to ${formatMoney(ref)}` });
    expect(p.advice.action).toEqual({ kind: 'openPanel', panel: 'pricing' });
    expect(text(p.advice)).toContain(`${pct1(churnProbability(tier))} a month instead of ${pct1(churnProbability({ ...tier, price: ref }))}`);
    expect(text(p.advice)).toContain(pct((tier.price - ref) / ref));
  });

  it('below the market: revenue left on the table', () => {
    const state = priced('fiber500', 0.7);
    const tier = state.sales.pricing.tiers.find((t) => t.id === 'fiber500')!;
    const ref = TIER_DEFAULTS.find((t) => t.id === 'fiber500')!.price;
    const units = unitsByTier(state).fiber500;
    expect(units).toBeGreaterThan(0);
    const p = plan(state, 'pricing');
    expect(text(p.advice)).toContain(`${formatMoney(units * (ref - tier.price))} a month left on the table`);
  });

  it('does not fire within the band, or for a tier not offered', () => {
    expect(planFor(priced('fiber1g', 1.1), 'pricing')).toBeNull();
    const state = litGame(60);
    const tiers = state.sales.pricing.tiers.map((t) => ({ id: t.id, price: t.id === 'fiber2g' ? t.price * 2 : t.price, offered: t.id !== 'fiber2g' }));
    applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: state.sales.pricing.smbMultiplier });
    expect(planFor(state, 'pricing')).toBeNull();
  });
});

describe('redCpp', () => {
  function costly(multiple: number): GameState {
    const state = litGame(60);
    state.finance.capex.osp = Math.round(getService(state).passings * CPP_TARGET * multiple);
    return state;
  }

  it('names the CPP spread a red build adds, as a tip with no debt and important with debt', () => {
    const state = costly(CPP_AMBER_MULTIPLIER + 0.5);
    const cpp = state.finance.capex.osp / getService(state).passings;
    const p = plan(state, 'redCpp');
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.redCpp, action: { kind: 'openPanel', panel: 'bank' } });
    expect(text(p.advice)).toContain(formatMoney(cpp));
    expect(text(p.advice)).toContain(formatRateBps(CPP_SPREAD_BPS.red));
    expect(text(p.advice)).toContain(formatRateBps(CPP_SPREAD_BPS.amber));
    state.debt.credit.balance = 50_000;
    const q = plan(state, 'redCpp');
    expect(q.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.redCppWithDebt });
    expect(text(q.advice)).toContain(formatMoney((50_000 * CPP_SPREAD_BPS.red) / 10_000));
  });

  it('covers amber, and is quiet when green', () => {
    expect(text(plan(costly(1.2), 'redCpp').advice)).toContain(formatRateBps(CPP_SPREAD_BPS.amber));
    expect(planFor(costly(0.5), 'redCpp')).toBeNull();
  });
});

describe('expand', () => {
  /** A wide grid of homes with an apartment building on every street (green to build), and a little plant by the CO: room to grow. */
  function growing(): GameState {
    const state = makeTestState(makeGridCity({ cols: 8, rows: 4, parcelKinds: (p) => (p.id % 8 === 0 ? { kind: 'mdu', units: 24 } : undefined) }));
    addLivePlant(state, { segments: [0, 1, 8, 9], splitters: 2 });
    runDays(state, 31);
    return state;
  }

  /**
   * The reserve expand keeps without a loan: EXPAND_RESERVE_MONTHS of running costs, debt service and installs (and
   * round 4c/4d, of what the new plant adds to them), the new area's installs and the cushion; or, when deeper, the
   * cash its ramp needs (the cushion plus buildTrough).
   */
  function reserveOf(state: GameState, node: number): number {
    const m = covenantMetrics(state);
    const service = Math.max(estimateNextDebtService(state), Math.ceil(m.annualDebtService / 12));
    const subscribed = new Map(state.sales.accounts.map((a) => [a.parcel, Object.values(a.tierUnits).reduce((x, y) => x + y, 0)]));
    const installs = Math.max(monthlyInstallPace(state), plannedInstallPace(state, subscribed));
    const fixed = fixedCostsPerMonth(state);
    const build = buildOutPlan(state, node);
    const area = expectedAreaInstalls(state, build, getService(state).passings);
    const months = EXPAND_RESERVE_MONTHS * (fixed + monthlyPoleRent(state) + service + installs + planRunningCost(state, build)) + area + fundingHint(state, 0).cushion;
    return Math.max(months, fundingHint(state, 0).cushion + buildTrough(state, build));
  }

  /** Every corner expandCandidates may consider (no cabinet, near the planned plant, clear of every cabinet's reach), with its distance to the plant. */
  function eligibleCorners(state: GameState): { node: number; d2: number }[] {
    const { city, network } = state;
    const plant = new Set<number>([city.coNode, ...network.cabinets.map((c) => c.node)]);
    for (const span of network.spans) {
      plant.add(city.segments[span.segment]!.a);
      plant.add(city.segments[span.segment]!.b);
    }
    const cabinets = network.cabinets.map((c) => city.nodes[c.node]!);
    const near = (EXPAND_REACH_MULTIPLE * CABINET_REACH_FT) / city.tileFt;
    const apart = CABINET_REACH_FT / city.tileFt;
    const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);
    const out: { node: number; d2: number }[] = [];
    for (const node of city.nodes) {
      if (cabinets.some((c) => c.id === node.id)) continue;
      const d2 = Math.min(...[...plant].map((p) => dist2(city.nodes[p]!, node)));
      if (d2 > near * near || cabinets.some((c) => dist2(c, node) < apart * apart)) continue;
      out.push({ node: node.id, d2 });
    }
    return out;
  }

  /** Most passings of a green build-out (at least EXPAND_MIN_PASSINGS, with a cabinet) among `nodes`, 0 for none. */
  function bestGreen(state: GameState, nodes: readonly number[]): number {
    let best = 0;
    for (const node of nodes) {
      const b = buildOutPlan(state, node);
      if (b.cpp !== null && cppBand(b.cpp) === 'green' && b.passings >= EXPAND_MIN_PASSINGS && b.commands.some((c) => c.type === 'placeCabinet')) best = Math.max(best, b.passings);
    }
    return best;
  }

  it('prices the corners on the cable that could pass the most, not the lowest-numbered ones (round 4b review)', () => {
    // Angel-backed seed 1 after its first build (round 4c/4d: the firstBuild card's): a feeder runs through town, and every corner on it is 0 ft from the plant.
    const state = newGame(1, { difficulty: 'angel' });
    expect(planFor(state, 'expand')).toBeNull();
    const first = planFor(state, 'firstBuild')!;
    for (const command of first.commands) expect(applyCommand(state, command).ok).toBe(true);
    const eligible = eligibleCorners(state);
    const onCable = eligible.filter((c) => c.d2 === 0);
    expect(onCable.length).toBeGreaterThan(EXPAND_CANDIDATES_MAX);
    // What ranking by distance with the node id as tie-break would price ...
    const byId = [...eligible].sort((a, b) => a.d2 - b.d2 || a.node - b.node).slice(0, EXPAND_CANDIDATES_MAX).map((c) => c.node);
    const candidates = expandCandidates(state);
    expect(candidates).toHaveLength(EXPAND_CANDIDATES_MAX);
    expect(candidates).not.toEqual(byId);
    // ... against what it prices now: eligible corners still, and the best green build-out among them beats the old pick.
    for (const node of candidates) expect(eligible.some((c) => c.node === node)).toBe(true);
    const now = bestGreen(state, candidates);
    expect(now).toBeGreaterThan(bestGreen(state, byId));
    expect(now).toBeGreaterThanOrEqual(bestGreen(state, eligible.map((c) => c.node)) / 2);
  });

  it('prices a green build-out whenever the eligible corners hold one: reach is measured along streets, not in a straight line (round 4b check)', () => {
    // Angel-backed towns with their two largest green build-outs built (the largest of all, then the largest still
    // eligible), a year on: green build-outs are left beside the plant. Measured in a straight line, a corner's
    // reach took in streets across blocks no street joins: amber and red corners looked green, filled the six
    // candidates, and expand said nothing with $700k+ in hand.
    const largestGreen = (state: GameState, nodes: readonly number[]): number => {
      let best = -1;
      let most = 0;
      for (const node of nodes) {
        const passings = bestGreen(state, [node]);
        if (passings > most) [best, most] = [node, passings];
      }
      return best;
    };
    for (const seed of [7, 13]) {
      const state = newGame(seed, { difficulty: 'angel' });
      for (const nodes of [() => state.city.nodes.map((n) => n.id), () => eligibleCorners(state).map((c) => c.node)]) {
        const node = largestGreen(state, nodes());
        expect(node, `seed ${seed}`).toBeGreaterThanOrEqual(0);
        for (const command of buildOutPlan(state, node).commands) expect(applyCommand(state, command).ok).toBe(true);
      }
      runDays(state, DAYS_PER_YEAR);
      const eligible = eligibleCorners(state).map((c) => c.node);
      expect(bestGreen(state, eligible), `seed ${seed}: a green build-out is left`).toBeGreaterThan(0);
      expect(bestGreen(state, expandCandidates(state)), `seed ${seed}: the candidates price one`).toBeGreaterThan(0);
      const p = planFor(state, 'expand');
      expect(p, `seed ${seed}`).not.toBeNull();
      expect(cppBand(buildOutPlan(state, (p!.advice.action as { node: number }).node).cpp!), `seed ${seed}`).toBe('green');
    }
  }, 60_000);

  it('keeps suggesting builds after the first ones: an Angel-backed follower places more than two cabinets', () => {
    for (const seed of [1, 2027]) {
      const run = runBot(seed, advisorFollowerBot, 24, { state: newGame(seed, { difficulty: 'angel' }) });
      expect(run.gameOver, `seed ${seed}`).toBeNull();
      expect(run.state.network.cabinets.length, `seed ${seed} cabinets`).toBeGreaterThan(2);
    }
  }, 120_000);

  it('builds exactly coverage.buildOutPlan at the best green corner, from cash above a real reserve', () => {
    const state = growing();
    const candidates = expandCandidates(state);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(EXPAND_CANDIDATES_MAX);
    const p = plan(state, 'expand');
    expect(p.advice.action.kind).toBe('focusNode');
    const node = (p.advice.action as { node: number }).node;
    expect(candidates).toContain(node);
    expect(p.advice.key).toBe(ADVICE_KEYS.expand(node));
    const build = buildOutPlan(state, node);
    expect(build.cpp).not.toBeNull();
    expect(cppBand(build.cpp!)).toBe('green');
    expect(build.passings).toBeGreaterThanOrEqual(EXPAND_MIN_PASSINGS);
    // No green candidate signs more customers at your prices (round 4c/4d: passings counted apartment units that sign up less).
    for (const other of candidates) {
      const q = buildOutPlan(state, other);
      if (q.cpp !== null && cppBand(q.cpp) === 'green') expect(planCustomers(state, q)).toBeLessThanOrEqual(planCustomers(state, build));
    }
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.expandCash, title: `Build a cabinet at ${cornerName(state.city, node)}` });
    expect(text(p.advice)).toContain(`${build.passings} passings`);
    expect(text(p.advice)).toContain(formatMoney(build.cpp!));
    expect(text(p.advice)).toContain(formatMoney(build.cost));
    // Exactly what was costed: the plan's commands, nothing spent beyond them.
    expect(p.commands).toEqual(build.commands);
    expect(p.spend).toBe(build.cost);
    expect(p.extraSpend).toBe(0);
    expect(p.keep).toBe(reserveOf(state, node));
    expect(text(p.advice)).toContain(formatMoney(p.keep));
    // The reserve holds months of running costs and the new area's installs on top of the cushion.
    expect(p.keep).toBeGreaterThan(fundingHint(state, 0).cushion + EXPAND_RESERVE_MONTHS * (fixedCostsPerMonth(state) - state.sales.marketingPerMonth));
    expect(expectedAreaInstalls(state, build, getService(state).passings)).toBeGreaterThan(0);
    const after = expectNoBackfire(state, p);
    expect(after.finance.cash).toBe(state.finance.cash - build.cost);
    expect(after.finance.cash).toBeGreaterThanOrEqual(p.keep);
  });

  it('borrows the rest with a term loan that leaves the covenants EXPAND_COVENANT_HEADROOM inside their limits', () => {
    const state = growing();
    const first = plan(state, 'expand');
    // Revenue history to lend against, and cash short of the build plus the reserve.
    const history = makeTradingState(60_000, 20_000);
    state.finance.reports = history.finance.reports;
    state.finance.cash = first.keep + Math.round(first.spend / 2);
    const p = plan(state, 'expand');
    expect(p.advice.priority).toBe(ADVICE_PRIORITY.expandLoan);
    const loan = p.commands[0] as Extract<Command, { type: 'takeTermLoan' }>;
    expect(loan.type).toBe('takeTermLoan');
    expect(loan.amount).toBeGreaterThanOrEqual(TERM_LOAN_MIN);
    expect(loan.amount).toBeLessThanOrEqual(maxSafeTermLoan(state, loan.termYears, EXPAND_COVENANT_HEADROOM));
    const quote = quoteTermLoan(state, loan.amount, loan.termYears);
    expect(covenantsWithin(quote.after, EXPAND_COVENANT_HEADROOM)).toBe(true);
    const node = (p.advice.action as { node: number }).node;
    expect(p.commands.slice(1)).toEqual(buildOutPlan(state, node).commands);
    // The reserve counts the new loan's payments too.
    expect(p.keep).toBe(reserveOf(state, node) + EXPAND_RESERVE_MONTHS * quote.payment + quote.stubInterest);
    expect(text(p.advice)).toContain(`${formatMoney(loan.amount)} ${loan.termYears}-year term loan`);
    expect(text(p.advice)).toContain(`${pct(EXPAND_COVENANT_HEADROOM)} inside the bank's limits`);
    const after = expectNoBackfire(state, p);
    expect(covenantsWithin(covenantMetrics(after), EXPAND_COVENANT_HEADROOM)).toBe(true);
  });

  it('never fires beside covenantCure: not with a covenant within COVENANT_RISK_MARGIN of its limit, snoozed or not', () => {
    const state = growing();
    state.finance.reports = makeTradingState(60_000, 20_000).finance.reports;
    expect(planFor(state, 'expand')).not.toBeNull();
    // Debt until leverage is just inside the risk margin: covenantCure warns, and expand stays quiet.
    let debt = 0;
    while (covenantsWithin(covenantMetrics(state), COVENANT_RISK_MARGIN)) {
      debt += LOAN_ROUNDING * 10;
      state.debt.credit.balance = debt;
    }
    expect(covenantMetrics(state).compliant).toBe(true);
    expect(planFor(state, 'covenantCure')).not.toBeNull();
    expect(planFor(state, 'expand')).toBeNull();
    // Snoozing the warning does not let expand through.
    const cure = advise(state, 99).find((a) => a.id === 'covenantCure')!;
    expect(applyCommand(state, { type: 'snoozeAdvice', key: cure.key }).ok).toBe(true);
    expect(advise(state, 99).some((a) => a.id === 'expand')).toBe(false);
  });

  it('does not fire when not compliant, with installs paused, below the reserve or with no PON port', () => {
    const warned = growing();
    warned.debt.covenant.stage = 'warning';
    expect(planFor(warned, 'expand')).toBeNull();
    const paused = growing();
    paused.sales.installsPaused = true;
    expect(planFor(paused, 'expand')).toBeNull();
    const poor = growing();
    poor.finance.cash = 1_000;
    expect(planFor(poor, 'expand')).toBeNull();
    const full = growing();
    full.network.olt.ponPorts = ponPortsUsed(full) + CABINET_START_SPLITTERS - 1;
    expect(planFor(full, 'expand')).toBeNull();
    // Just short of the build plus the reserve, with nothing to borrow against: nothing.
    const short = growing();
    const p = plan(short, 'expand');
    short.finance.cash = p.keep + p.spend - 1;
    const q = planFor(short, 'expand');
    if (q) expect((q.advice.action as { node: number }).node).not.toBe((p.advice.action as { node: number }).node);
  });

  it('a snoozed corner gives way to the next best one', () => {
    const state = growing();
    const first = advise(state, 99).find((a) => a.id === 'expand')!;
    expect(applyCommand(state, { type: 'snoozeAdvice', key: first.key })).toEqual({ ok: true, cost: 0 });
    const next = advise(state, 99).find((a) => a.id === 'expand');
    if (next) expect(next.key).not.toBe(first.key);
    expect(buildBriefing(state)!.snoozed).toBeGreaterThanOrEqual(1);
  });

  it('is safe to follow: after the plan, the next two closes bring no covenant warning, breach, missed or short payment', () => {
    // States from several towns: following expand from the first months (cash), and borrowing variants a year in.
    const checked = { cash: 0, loan: 0 };
    /** Apply `p` to a copy of `state`, then play to the second close after it. */
    const follow = (state: GameState, p: AdvicePlan, label: string) => {
      const s = clone(state);
      for (const command of p.commands) expect(applyCommand(s, command), `${label}: ${JSON.stringify(command)}`).toMatchObject({ ok: true });
      expect(s.finance.cash, label).toBeGreaterThanOrEqual(p.keep);
      checked[p.commands[0]!.type === 'takeTermLoan' ? 'loan' : 'cash']++;
      const firstNotice = s.nextNoticeId;
      const start = s.finance.reports.length;
      while (s.finance.reports.length < start + 2 && !s.gameOver) {
        const closes = s.finance.reports.length;
        tick(s);
        if (s.finance.reports.length === closes) continue;
        // At each close: no covenant trouble, no payment trouble.
        expect(s.gameOver, label).toBeNull();
        expect(covenantMetrics(s).compliant, `${label}: breach`).toBe(true);
        expect(s.debt.covenant.stage, label).toBe('compliant');
        expect(planFor(s, 'covenantCure'), `${label}: covenantCure`).toBeNull();
        expect(planFor(s, 'paymentShort'), `${label}: paymentShort`).toBeNull();
      }
      const bad = s.notices.filter((n) => n.id >= firstNotice && ['paymentMissed', 'covenantWarning', 'covenantPenalty', 'creditFrozen', 'insolvencyWarning'].includes(n.kind));
      expect(bad.map((n) => n.message), label).toEqual([]);
    };
    const expandFollower = (seed: number): Bot => ({
      name: 'expand-follower',
      act(state, send) {
        // Round 4c/4d: a new company's first build is firstBuild's card, built the same way.
        const p = advicePlans(state).find((x) => (x.advice.id === 'expand' || x.advice.id === 'firstBuild') && x.commands.length > 0);
        if (!p) return;
        follow(state, p, `seed ${seed} day ${state.day}`);
        for (const command of p.commands) send(command);
      },
    });
    for (const seed of [2027, 424242, 99]) {
      const year = runBot(seed, expandFollower, 12).state;
      // A year in, with cash for only half the build beyond the reserve: the plan borrows (when the bank lends enough).
      const rich = clone(year);
      rich.finance.cash += 300_000;
      const cashPlan = planFor(rich, 'expand');
      if (!cashPlan) continue;
      const tight = clone(year);
      tight.finance.cash = cashPlan.keep + Math.round(cashPlan.spend / 2);
      let loanPlan = planFor(tight, 'expand');
      // The bank may lend less than half of a large build: then cash short of it by half of the largest loan it makes safely.
      const lends = maxSafeTermLoan(year, TERM_LOAN_YEARS[TERM_LOAN_YEARS.length - 1] as TermYears, EXPAND_COVENANT_HEADROOM);
      if (!loanPlan && lends >= 2 * TERM_LOAN_MIN) {
        tight.finance.cash = cashPlan.keep + cashPlan.spend - Math.round(lends / 2);
        loanPlan = planFor(tight, 'expand');
      }
      if (loanPlan) follow(tight, loanPlan, `seed ${seed} borrowing`);
    }
    expect(checked.cash).toBeGreaterThanOrEqual(3);
    expect(checked.loan).toBeGreaterThanOrEqual(1);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Round 4c/4d (spec B): advice at every budget
// ---------------------------------------------------------------------------

/** The streets a plan's layCable commands lay. */
function laidBy(commands: readonly Command[]): number[] {
  const out: number[] = [];
  for (const c of commands) if (c.type === 'layCable') out.push(...c.segments);
  return out.sort((a, b) => a - b);
}

describe('firstBuild (round 4c/4d, spec B)', () => {
  it('gives a new company at every difficulty a concrete first build sized to its cash', () => {
    for (const seed of [1, 2027]) {
      let previous = Number.POSITIVE_INFINITY;
      // Easiest first: the purse shrinks level by level.
      for (const level of DIFFICULTY_LEVELS) {
        const state = newGame(seed, { difficulty: level.id });
        const label = `seed ${seed} ${level.id}`;
        const p = plan(state, 'firstBuild');
        expect(p.advice, label).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.firstBuild, actionLabel: 'Show me' });
        expect(p.advice.action.kind).toBe('focusNode');
        const node = (p.advice.action as { node: number }).node;
        expect(p.advice.key).toBe(ADVICE_KEYS.firstBuild(node));
        // The top of the summary on day one, and nothing else claims that spot.
        expect(advise(state)[0]?.key, label).toBe(p.advice.key);
        // A cabinet and its cable at that corner, from cash (a new company has nothing to borrow against).
        expect(p.commands[0]).toEqual({ type: 'placeCabinet', node });
        expect(p.commands.slice(1).every((c) => c.type === 'layCable')).toBe(true);
        expect(p.commands.some((c) => FINANCING.has(c.type))).toBe(false);
        // Exactly buildOutPlan's build-out, or the part of it the cash covers.
        const full = buildOutPlan(state, node);
        const allowed = new Set([...full.feeder, ...full.reach]);
        for (const segment of laidBy(p.commands)) expect(allowed.has(segment), `${label} street ${segment}`).toBe(true);
        for (const segment of full.feeder) expect(laidBy(p.commands)).toContain(segment);
        // Sized to the cash: the build and the reserve fit, the reserve holds the cushion and the ramp's trough.
        expect(p.spend + p.keep, label).toBeLessThanOrEqual(state.finance.cash);
        expect(p.keep).toBeGreaterThanOrEqual(fundingHint(state, 0).cushion);
        if (laidBy(p.commands).length === laidBy(full.commands).length) {
          expect(p.spend).toBe(full.cost);
          expect(p.keep).toBeGreaterThanOrEqual(fundingHint(state, 0).cushion + buildTrough(state, full));
        }
        expect(p.advice.cost).toBe(p.spend);
        // The card: the corner, the homes, the cost per home and the cost, in plain words.
        expect(p.advice.title).toBe(fit(ADVICE_TITLE_MAX, `Light ${cornerName(state.city, node)} first`, `Light ${cornerName(state.city, node).split(' & ')[0]} first`, 'Light your first streets'));
        expect(p.advice.why).toMatch(/lights [\d,]+ homes? at \$[\d,]+ each\. Costs \$[\d,]+\.$/);
        expect(p.advice.detail).toContain(`(target ${formatMoney(CPP_TARGET)})`);
        // Following it costs what the card says.
        const after = expectNoBackfire(state, p);
        expect(state.finance.cash - after.finance.cash).toBe(p.spend);
        // A smaller purse never buys a bigger first build.
        expect(p.spend, label).toBeLessThanOrEqual(previous);
        previous = p.spend;
      }
    }
  }, 60_000);

  it('builds what it costed: followed on the smallest purses, the cash never ends a month below zero in the first year', () => {
    for (const level of ['bootstrapped', 'shoestring'] as const) {
      const state = newGame(1, { difficulty: level });
      const p = planFor(state, 'firstBuild')!;
      for (const command of p.commands) expect(applyCommand(state, command).ok).toBe(true);
      runDays(state, DAYS_PER_YEAR);
      expect(state.gameOver, level).toBeNull();
      expect(getService(state).passings, level).toBeGreaterThan(0);
      for (const report of state.finance.reports) expect(report.cashEnd, `${level} ${report.year}-${report.month}`).toBeGreaterThanOrEqual(0);
    }
  }, 60_000);

  it('says the first cabinet is being built until it lights homes, then gives way to the rest', () => {
    const state = newGame(2027, { difficulty: 'seed' });
    for (const command of planFor(state, 'firstBuild')!.commands) expect(applyCommand(state, command).ok).toBe(true);
    const wait = plan(state, 'firstBuild');
    expect(wait.advice).toMatchObject({ key: 'firstBuild', priority: ADVICE_PRIORITY.firstBuildWait, severity: 'tip', action: { kind: 'openPanel', panel: 'customers' } });
    expect(wait.commands).toEqual([]);
    expect(planFor(state, 'expand')).toBeNull();
    while (getService(state).passings === 0) runDays(state, 7);
    expect(planFor(state, 'firstBuild')).toBeNull();
  });

  it('suggests no second area while the first is still being built (the Seed round seed 13 follower built two in its first week)', () => {
    const state = newGame(13, { difficulty: 'seed' });
    for (const command of planFor(state, 'firstBuild')!.commands) expect(applyCommand(state, command).ok).toBe(true);
    for (let week = 0; getService(state).passings === 0; week++) {
      expect(week, 'the first area lights within a year').toBeLessThan(52);
      runDays(state, 7);
      if (getService(state).passings > 0) break;
      expect(planFor(state, 'expand'), `day ${state.day}`).toBeNull();
      expect(advicePlans(state)[0]?.advice.id, `day ${state.day}`).not.toBe('expand');
    }
  });

  it('suggests no growth lever whose spend would take the covenants past the headroom (the Bootstrapped seed 1 follower ran a campaign right after its financed build and breached)', () => {
    // A lever's spend comes off the operating cash flow the covenants measure: the trailing ARR_TRAILING_MONTHS
    // closes, annualized, so a campaign's price counts 12 / ARR_TRAILING_MONTHS times for a quarter.
    let offered = 0;
    const checking: BotFactory = (seed) => {
      const inner = advisorFollowerBot(seed);
      return {
        name: inner.name,
        act(state, send) {
          if (totalDebt(state) > 0) {
            for (const option of growthOptions(state)) {
              const command = option.commands[0];
              let cut: number | null = null;
              if (command?.type === 'runCampaign') cut = (quoteCampaign(state, command.cabinet).cost * 12) / ARR_TRAILING_MONTHS;
              else if (command?.type === 'setMarketing') cut = 12 * (command.perMonth - state.sales.marketingPerMonth);
              else if (command?.type === 'setReferrals') cut = (12 * option.cost) / CUSTOMER_QUOTE_MONTHS;
              if (cut === null) continue;
              offered++;
              const after = covenantMetrics(state, { addDebt: 0, addAnnualDebtService: 0, addAnnualOperatingCashFlow: -cut });
              expect(covenantsWithin(after, EXPAND_COVENANT_HEADROOM), `day ${state.day}: ${option.lever}`).toBe(true);
            }
          }
          inner.act(state, send);
        },
      };
    };
    const run = runBot(1, checking, 48, { state: newGame(1, { difficulty: 'bootstrapped' }) });
    expect(run.state.debt.loans.length, 'the follower borrowed for a build').toBeGreaterThan(0);
    expect(worstStage(run)).toBe('compliant');
    expect(offered, "levers weighed while in debt").toBeGreaterThan(0);
  }, 120_000);

  it('where no area the starting purse covers pays its way whole, still gives a concrete build that cuts the monthly loss (Shoestring seed 12345)', () => {
    const state = newGame(12345, { difficulty: 'shoestring' });
    const p = plan(state, 'firstBuild');
    expect(advise(state)[0]?.key).toBe(p.advice.key);
    const node = (p.advice.action as { node: number }).node;
    expect(node).not.toBe(state.city.coNode);
    expect(p.advice.key).toBe(ADVICE_KEYS.firstBuild(node));
    expect(p.commands[0]).toEqual({ type: 'placeCabinet', node });
    expect(p.commands.slice(1).length).toBeGreaterThan(0);
    expect(p.commands.slice(1).every((c) => c.type === 'layCable')).toBe(true);
    // Sized to the cash: the build and its ramp's trough fit, with at least the funding cushion kept.
    expect(p.spend + p.keep).toBeLessThanOrEqual(state.finance.cash);
    expect(p.keep).toBeGreaterThanOrEqual(fundingHint(state, 0).cushion);
    // The card names the street, the homes, the cost per home and the cost, and says plainly it may not carry the office.
    expect(p.advice.title).toBe(fit(ADVICE_TITLE_MAX, `Light ${cornerName(state.city, node)} first`, `Light ${cornerName(state.city, node).split(' & ')[0]} first`, 'Light your first streets'));
    expect(p.advice.why).toMatch(/lights [\d,]+ homes? at \$[\d,]+ each.* Costs \$[\d,]+\.$/);
    expect(p.advice.detail).toContain("No area your cash covers pays all the office's running costs");
    expectShort(p.advice);
    // Following it builds it, and the follower then lights homes instead of watching the office drain the cash.
    const after = expectNoBackfire(state, p);
    expect(after.network.cabinets.map((c) => c.node)).toEqual([node]);
    runDays(after, DAYS_PER_YEAR);
    expect(after.gameOver).toBeNull();
    expect(getService(after).passings).toBeGreaterThan(0);
  }, 60_000);

  it('with too little cash for any area that pays its way, says so instead of nothing (no command)', () => {
    const state = newGame(1, { difficulty: 'shoestring' });
    state.finance.cash = 40_000;
    const p = plan(state, 'firstBuild');
    expect(p.advice).toMatchObject({ key: 'firstBuild', priority: ADVICE_PRIORITY.firstBuild, title: 'Pick a dense street to light first', action: { kind: 'focusNode', node: state.city.coNode } });
    expect(p.commands).toEqual([]);
    expect(advise(state)[0]?.id).toBe('firstBuild');
  });

  it('does not fire once the company has a cabinet lighting homes, or while the bank holds borrowing back', () => {
    expect(planFor(litGame(31), 'firstBuild')).toBeNull();
    const state = newGame(1, { difficulty: 'seed' });
    state.debt.covenant.stage = 'warning';
    expect(planFor(state, 'firstBuild')).toBeNull();
  });
});

describe('expand above the CPP target (round 4c/4d)', () => {
  it('suggests an amber area only from cash, once nothing burns and no green build fits', () => {
    // An Angel-backed follower lights the green areas first; later, with cash idle and nothing burning, the amber ones.
    let found: { state: GameState; p: AdvicePlan } | null = null;
    let closes = 0;
    runBot(1, advisorFollowerBot, 48, {
      state: newGame(1, { difficulty: 'angel' }),
      afterTick: (s) => {
        if (found || s.finance.reports.length === closes) return;
        closes = s.finance.reports.length;
        const p = planFor(s, 'expand');
        // The plan itself must be amber: a smaller, green plan at a corner whose whole build-out is amber is a green expand.
        if (p && (p.advice.detail ?? '').includes(`costs more per home than the ${formatMoney(CPP_TARGET)} target`)) found = { state: clone(s), p };
      },
    });
    expect(found, 'an amber expand on the Angel-backed follower').not.toBeNull();
    const { state, p } = found!;
    expect(runwayMonths(state)).toBeNull();
    expect(p.commands.some((c) => FINANCING.has(c.type))).toBe(false);
    expect(p.advice.detail).toContain('paid from cash');
    // No green build-out the cash covers was left among the corners it prices.
    for (const node of expandCandidates(state)) {
      const b = buildOutPlan(state, node);
      if (b.cpp !== null && cppBand(b.cpp) === 'green' && b.passings >= EXPAND_MIN_PASSINGS && b.commands.some((c) => c.type === 'placeCabinet')) {
        expect(b.cost + fundingHint(state, 0).cushion).toBeGreaterThan(state.finance.cash);
      }
    }
    expectNoBackfire(state, p);
    expectWellFormed(p.advice);
  }, 120_000);
});

describe('advice while cash burns (round 4c/4d, spec B)', () => {
  it('is never silent: following the advisor at every difficulty, every close that burns cash has a next step that fits the card', () => {
    for (const level of DIFFICULTY_LEVELS) {
      let burning = 0;
      let closes = 0;
      runBot(2027, advisorFollowerBot, 15, {
        state: newGame(2027, { difficulty: level.id }),
        afterTick: (s) => {
          if (s.finance.reports.length === closes || s.gameOver) return;
          closes = s.finance.reports.length;
          if (runwayMonths(s) === null) return;
          burning++;
          const next = buildBriefing(s)!.advice[0];
          expect(next, `${level.id} close ${closes}`).toBeDefined();
          expectShort(next!);
        },
      });
      expect(burning, level.id).toBeGreaterThan(0);
    }
  }, 300_000);

  it('looks past the first candidates for a build the cash covers, smaller ones included (spec B)', () => {
    // A Shoestring purse: the corners that pass the most cost more than it, so the build comes from further down the
    // ranking or is a smaller part of a good area, and it fits.
    const state = newGame(424242, { difficulty: 'shoestring' });
    const p = plan(state, 'firstBuild');
    expect(p.spend + p.keep).toBeLessThanOrEqual(state.finance.cash);
    const node = (p.advice.action as { node: number }).node;
    expect(rankedCorners(state).length).toBeGreaterThan(EXPAND_CANDIDATES_MAX);
    const first = rankedCorners(state).slice(0, EXPAND_CANDIDATES_MAX);
    const whole = buildOutPlan(state, node);
    expect(!first.includes(node) || whole.cost > p.spend || first.every((n) => buildOutPlan(state, n).cost + fundingHint(state, 0).cushion > state.finance.cash)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Round 4c/4d (spec I.6): growing on what you built
// ---------------------------------------------------------------------------

describe('growthOptions and growCustomers (round 4c/4d, spec I.6)', () => {
  /** The 64-home grid lit from its center `days` ago: few homes signed up yet, cash to spare. */
  function freshTown(days = 45): GameState {
    const state = makeTestState(makeGridCity({ cols: 4, rows: 2, coAt: [2, 1] }));
    addLivePlant(state, { splitters: 4 });
    runDays(state, days);
    return state;
  }

  /** What a customer brings a month there (what a unit pays less the per-customer running cost). */
  function marginOf(state: GameState): number {
    const f = forecastCustomers(state);
    return (f.units > 0 ? f.price : f.signupPrice) - perCustomerCost(state);
  }

  it('weighs marketing, a campaign, referral credits and new fiber per customer, cheapest first, each one followable', () => {
    const state = freshTown();
    const options = growthOptions(state);
    expect(options.length).toBeGreaterThan(0);
    const margin = marginOf(state);
    for (let i = 1; i < options.length; i++) expect(options[i]!.costPerCustomer!).toBeGreaterThanOrEqual(options[i - 1]!.costPerCustomer!);
    for (const option of options) {
      expect(option.customers).toBeGreaterThanOrEqual(GROW_MIN_CUSTOMERS);
      expect(option.costPerCustomer).toBe(Math.round(option.cost / option.customers));
      // Each is something the player can do now.
      const copy = clone(state);
      for (const command of option.commands) expect(applyCommand(copy, command), `${option.lever}: ${JSON.stringify(command)}`).toMatchObject({ ok: true });
      if (option.lever === 'build') {
        expect(option.commands.some((c) => c.type === 'placeCabinet')).toBe(true);
        continue;
      }
      // A lever is sensible: its cost per customer is paid back by GROWTH_PAYBACK_MONTHS of what a customer brings.
      expect(option.costPerCustomer!).toBeLessThanOrEqual(GROWTH_PAYBACK_MONTHS * margin);
      if (option.lever === 'campaign') {
        expect(option.commands).toEqual([{ type: 'runCampaign', cabinet: option.cabinet }]);
        expect(option.cost).toBe(quoteCampaign(state, option.cabinet!).cost);
      } else if (option.lever === 'marketing') {
        expect(option.commands).toEqual([{ type: 'setMarketing', perMonth: state.sales.marketingPerMonth + MARKETING_STEP }]);
        expect(option.cost).toBe(MARKETING_STEP * CUSTOMER_QUOTE_MONTHS);
      } else {
        expect(option.commands).toEqual([{ type: 'setReferrals', on: true }]);
      }
    }
  });

  it('offers nothing the player cannot afford, and nothing while installs are paused', () => {
    const poor = freshTown();
    poor.finance.cash = 100;
    expect(growthOptions(poor)).toEqual([]);
    const paused = freshTown();
    paused.sales.installsPaused = true;
    expect(growthOptions(paused)).toEqual([]);
    expect(planFor(paused, 'growCustomers')).toBeNull();
    // Once the game is over, nothing.
    const over = freshTown();
    over.gameOver = { day: over.day, reason: 'insolvent', message: 'x' };
    expect(growthOptions(over)).toEqual([]);
  });

  it('names the cheapest lever in plain words, with what it beat in the detail, and its plan is safe to follow', () => {
    const state = freshTown();
    const best = growthOptions(state)[0]!;
    expect(best.lever).not.toBe('build');
    const p = plan(state, 'growCustomers');
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.growCustomers });
    expect(p.commands).toEqual(best.commands);
    expect(p.advice.key).toBe(best.lever === 'campaign' ? ADVICE_KEYS.growCustomers('campaign', best.cabinet!) : ADVICE_KEYS.growCustomers(best.lever as 'marketing' | 'referrals'));
    expect(p.advice.detail).toContain(formatMoney(best.cost));
    expect(p.advice.detail).toContain(`(${formatMoney(best.costPerCustomer!)} each)`);
    if (best.lever === 'campaign') {
      expect(p.advice.action).toEqual({ kind: 'focusCabinet', cabinet: best.cabinet });
      expect(p.advice.cost).toBe(best.cost);
      expect(p.spend).toBe(best.cost);
    } else {
      expect(p.advice.action).toEqual({ kind: 'openPanel', panel: 'customers' });
      expect(p.extraSpend).toBeGreaterThan(0);
    }
    const signed = state.sales.accounts.length / getService(state).passings;
    expect(text(p.advice)).toContain(`Your lit streets are ${pct(signed)} signed up`);
  });

  it('cuts marketing that no longer brings customers for what it costs', () => {
    const state = freshTown(400);
    // Referral credits already on: with happy customers they would otherwise be the cheaper lever offered first.
    expect(applyCommand(state, { type: 'setReferrals', on: true }).ok).toBe(true);
    expect(applyCommand(state, { type: 'setMarketing', perMonth: 20_000 }).ok).toBe(true);
    const p = plan(state, 'growCustomers');
    expect(p.advice.key).toBe(ADVICE_KEYS.growCustomers('marketing'));
    expect(p.commands).toEqual([{ type: 'setMarketing', perMonth: 20_000 - MARKETING_STEP }]);
    expect(p.advice.title).toBe(`Cut marketing to ${formatMoney(20_000 - MARKETING_STEP)} a month`);
    expect(p.advice.cost).toBeNull();
    // And never both: no raise is offered at a budget worth cutting.
    expect(growthOptions(state).some((o) => o.lever === 'marketing')).toBe(false);
  });

  it('while cash burns and no lever is worth it, says what more customers would do (no command)', () => {
    const state = freshTown(70);
    applyCommand(state, { type: 'setMarketing', perMonth: 0 });
    const burn = monthlyBurn(state);
    expect(burn).toBeGreaterThan(0);
    // Five months of burn: past the runway warning, short of what a lever must leave.
    state.finance.cash = 5 * burn + Math.round(burn / 2);
    expect(runwayMonths(state)).toBe(5);
    expect(planFor(state, 'cashRunway')).toBeNull();
    const p = plan(state, 'growCustomers');
    expect(p.advice).toMatchObject({ key: ADVICE_KEYS.growCustomers('hint'), priority: ADVICE_PRIORITY.growCustomersHint, action: { kind: 'openPanel', panel: 'customers' } });
    expect(p.commands).toEqual([]);
    expect(p.advice.why).toContain('more customers is how you stop burning cash');
  });

  it('is quiet with nothing lit, with installs paused, and when the streets are signed up and nothing burns', () => {
    expect(planFor(newGame(1), 'growCustomers')).toBeNull();
    const state = freshTown();
    state.sales.installsPaused = true;
    expect(planFor(state, 'growCustomers')).toBeNull();
  });
});

describe('support (round 4c/4d, spec I.6)', () => {
  /** A lit town with apartment buildings (enough customers for support advice: SUPPORT_MIN_UNITS) after `days` days. */
  function supported(days = 240): GameState {
    const state = makeTestState(makeGridCity({ cols: 4, rows: 2, coAt: [2, 1], parcelKinds: (p) => (p.id % 4 === 0 ? { kind: 'mdu', units: 20 } : undefined) }));
    addLivePlant(state, { splitters: MAX_SPLITTERS_PER_CABINET });
    runDays(state, days);
    expect(state.sales.accounts.reduce((n, a) => n + a.tierUnits.fiber500 + a.tierUnits.fiber1g + a.tierUnits.fiber2g, 0)).toBeGreaterThanOrEqual(SUPPORT_MIN_UNITS);
    return state;
  }

  /** supported(), with every customer remembering `days` days without service last week. */
  function hitByOutages(days: number): GameState {
    const state = supported();
    state.customers.memories = state.sales.accounts.map((a) => ({ parcel: a.parcel, outageDays: days, outageDay: state.day - 7, priceStepDay: null, waitedDay: null }));
    return state;
  }

  it('suggests Great support when outages make customers unhappy and it pays, with its cost a month', () => {
    const state = hitByOutages(6);
    const quote = quoteSupport(state, 'great');
    expect(quote.pays).toBe(true);
    const p = plan(state, 'support');
    expect(p.advice).toMatchObject({ key: ADVICE_KEYS.support('great'), priority: ADVICE_PRIORITY.support, title: 'Switch to Great support', action: { kind: 'openPanel', panel: 'customers' } });
    expect(p.commands).toEqual([{ type: 'setSupport', level: 'great' }]);
    expect(p.advice.cost).toBe(quote.costChange);
    expect(p.advice.why).toContain(formatMoney(quote.costChange));
    expect(p.extraSpend).toBe(EXPAND_RESERVE_MONTHS * quote.costChange);
  });

  it('suggests Great support in a real storm-hit game where outages make customers unhappy (all-aerial seed 1, month 34), over three years', () => {
    // Round 4c/4d fix: over CUSTOMER_QUOTE_MONTHS with no outage foreseen the quote never paid there, so the card never showed.
    const state = runBot(1, allAerialBot(), 34).state;
    const units = subscriberUnits(state);
    let service = 0;
    for (const reason of happinessReport(state).reasons) if (reason.bucket === 'unhappy' && reason.reason === 'outages') service += reason.units;
    expect(service).toBeGreaterThanOrEqual(SUPPORT_SERVICE_SHARE * units);
    const quote = quoteSupport(state, 'great');
    expect(quote.months).toBe(SUPPORT_QUOTE_MONTHS);
    expect(quote.pays).toBe(true);
    const p = plan(state, 'support');
    expect(p.advice).toMatchObject({ key: ADVICE_KEYS.support('great'), title: 'Switch to Great support' });
    expect(p.commands).toEqual([{ type: 'setSupport', level: 'great' }]);
    expect(p.advice.detail).toContain('over the next three years with the outages your cable can expect');
  }, 120_000);

  it('on Basic, says what it costs in customers and the level to go back to', () => {
    const state = supported();
    expect(applyCommand(state, { type: 'setSupport', level: 'basic' }).ok).toBe(true);
    const p = plan(state, 'support');
    expect(p.advice.title).toMatch(/^Go back to (Good|Great) support$/);
    expect(p.advice.why).toMatch(/Basic support .*customers? a year/);
    const level = (p.commands[0] as { level: string }).level;
    expect(p.advice.key).toBe(`support:${level}`);
    expect(quoteSupport(state, level as 'good' | 'great').pays).toBe(true);
  });

  it('is quiet on Great, with service that makes nobody unhappy, or while installs are paused', () => {
    const calm = supported();
    expect(planFor(calm, 'support')).toBeNull();
    const great = hitByOutages(6);
    expect(applyCommand(great, { type: 'setSupport', level: 'great' }).ok).toBe(true);
    expect(planFor(great, 'support')).toBeNull();
    const paused = hitByOutages(6);
    paused.sales.installsPaused = true;
    expect(planFor(paused, 'support')).toBeNull();
  });
});

describe('lineup (round 4c/4d, spec B)', () => {
  function lineup(offered: (id: TierId) => boolean, factor = 1): GameState {
    const state = litGame(150);
    const tiers = state.sales.pricing.tiers.map((t) => ({ id: t.id, price: Math.round(t.price * factor), offered: offered(t.id) }));
    expect(applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: state.sales.pricing.smbMultiplier }).ok).toBe(true);
    return state;
  }

  it('flags the cheap tier dropped: the price-conscious homes sign up far less, and the plan offers it again at its market price', () => {
    const state = lineup((id) => id !== 'fiber500');
    const market = TIER_DEFAULTS.find((t) => t.id === 'fiber500')!.price;
    const p = plan(state, 'lineup');
    expect(p.advice).toMatchObject({ key: ADVICE_KEYS.lineup('fiber500'), priority: ADVICE_PRIORITY.lineup, title: 'Offer 500 Mbps again', action: { kind: 'openPanel', panel: 'pricing' } });
    expect(p.commands).toEqual([
      {
        type: 'setPricing',
        tiers: state.sales.pricing.tiers.map((t) => ({ id: t.id, price: t.id === 'fiber500' ? market : t.price, offered: t.offered || t.id === 'fiber500' })),
        smbMultiplier: state.sales.pricing.smbMultiplier,
      },
    ]);
    expect(p.advice.why).toContain(formatMoney(market));
    // Following it lifts the households' target take rate by at least LINEUP_MIN_GAIN, and the card goes.
    const after = expectNoBackfire(state, p);
    expect(stateTakeRate(after, 'home') - stateTakeRate(state, 'home')).toBeGreaterThanOrEqual(LINEUP_MIN_GAIN);
    expect(planFor(after, 'lineup')).toBeNull();
  });

  it('with only the top tier left, names the share of homes no plan suits, and puts both cheap tiers back', () => {
    const state = lineup((id) => id === 'fiber2g');
    const unserved = segmentDemand(state.sales.pricing, 'home').filter((d) => !(d.takeRate > 0));
    expect(unserved.length).toBeGreaterThan(0);
    const share = unserved.reduce((n, d) => n + d.share, 0);
    const p = plan(state, 'lineup');
    expect(p.advice.title).toBe('Offer 500 Mbps and 1 Gig again');
    expect(p.advice.why).toContain(`No plan suits ${pct(share)} of homes`);
    const after = expectNoBackfire(state, p);
    expect(after.sales.pricing.tiers.every((t) => t.offered)).toBe(true);
    for (const segment of unserved) expect(segmentDemand(after.sales.pricing, 'home').find((d) => d.segment === segment.segment)!.takeRate).toBeGreaterThan(0);
  });

  it('is quiet with the full lineup or only the top tier dropped', () => {
    expect(planFor(litGame(150), 'lineup')).toBeNull();
    expect(planFor(lineup((id) => id !== 'fiber2g'), 'lineup')).toBeNull();
  });
});

describe('suggestions shown together (round 4c/4d)', () => {
  it('a growth lever, support and a build in one call stay safe together, each counting what the others spend', () => {
    const state = makeTestState(makeGridCity({ cols: 8, rows: 4, parcelKinds: (p) => (p.id % 8 === 0 ? { kind: 'mdu', units: 24 } : undefined) }));
    addLivePlant(state, { segments: [0, 1, 8, 9], splitters: 2 });
    runDays(state, 120);
    state.customers.memories = state.sales.accounts.map((a) => ({ parcel: a.parcel, outageDays: 6, outageDay: state.day - 7, priceStepDay: null, waitedDay: null }));
    const ids = expectAllSafe(state);
    expect(ids).toEqual(expect.arrayContaining(['growCustomers']));
    const plans = advicePlans(state);
    const grow = plans.find((p) => p.advice.id === 'growCustomers');
    const build = plans.find((p) => p.advice.id === 'expand');
    if (grow && build && grow.spend > 0) {
      // expand's check counted the lever's spend: alone, it may keep less.
      expect(state.finance.cash - grow.spend - build.spend).toBeGreaterThanOrEqual(build.keep - (build.commands[0]?.type === 'takeTermLoan' ? (build.commands[0] as { amount: number }).amount : 0));
    }
  });
});

// ---------------------------------------------------------------------------
// Never backfires, on realistic states
// ---------------------------------------------------------------------------

describe('following the top suggestion', () => {
  it('never brings on its own covenant-risk warning: Bootstrapped, where the runway loans used to land on the limit', () => {
    // paymentShort alone may borrow up to the limits (a missed payment is worse than the warning, which then says so).
    expect(SUGGESTED_BORROWING_HEADROOM).toBeGreaterThan(COVENANT_RISK_MARGIN);
    const seen: string[] = [];
    let borrowed = 0;
    let runwayLoans = 0;
    // The review's towns with the one cabinet the advisor used to build there on day one (the biggest green
    // build-out near the CO that leaves a third of the purse), a network whose burn the runway loans bridge
    // for years; and seed 1, where the advisor builds one itself.
    const oneCabinet = (seed: number): GameState => {
      const state = newGame(seed, { difficulty: 'bootstrapped' });
      if (seed === 1) return state;
      const co = state.city.nodes[state.city.coNode]!;
      const near = (EXPAND_REACH_MULTIPLE * CABINET_REACH_FT) / state.city.tileFt;
      let best: ReturnType<typeof buildOutPlan> | null = null;
      for (const node of state.city.nodes) {
        if ((node.x - co.x) * (node.x - co.x) + (node.y - co.y) * (node.y - co.y) > near * near) continue;
        const b = buildOutPlan(state, node.id);
        if (b.cpp === null || cppBand(b.cpp) !== 'green' || b.passings < EXPAND_MIN_PASSINGS || b.cost > (state.finance.cash * 2) / 3) continue;
        if (!best || b.passings > best.passings) best = b;
      }
      for (const command of best!.commands) expect(applyCommand(state, command).ok).toBe(true);
      return state;
    };
    for (const seed of [1, 99, 12345]) {
      const follower: Bot = {
        name: 'checked-follower',
        act(state, send) {
          const top = advicePlans(state)[0];
          if (!top || top.commands.length === 0) return;
          const before = planFor(state, 'covenantCure');
          for (const cmd of top.commands) if (!send(cmd).ok) break;
          if (top.advice.id === 'paymentShort') return;
          const borrows = top.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan');
          if (borrows) borrowed++;
          if (borrows && top.advice.id === 'cashRunway') runwayLoans++;
          const after = planFor(state, 'covenantCure');
          const where = `seed ${seed} day ${state.day}: ${top.advice.id} ${JSON.stringify(top.commands)}`;
          if (before === null && after !== null) seen.push(`${where} -> ${after.advice.title}`);
          // What the card promised: the covenants at least SUGGESTED_BORROWING_HEADROOM inside their limits.
          if (borrows && top.advice.id !== 'expand' && !covenantsWithin(covenantMetrics(state), SUGGESTED_BORROWING_HEADROOM)) seen.push(`${where} -> inside the headroom no more`);
        },
      };
      runBot(seed, () => follower, 60, { state: oneCabinet(seed) });
    }
    expect(borrowed).toBeGreaterThan(0);
    expect(runwayLoans).toBeGreaterThan(0);
    expect(seen).toEqual([]);
  }, 600_000);
});

describe('never backfires', () => {
  it('on the frozen v3 fixtures and variations of the healthy borrower', () => {
    const grid = fixture('v3-grid');
    expect(expectAllSafe(grid)).toEqual(expect.arrayContaining(['covenantCure', 'frozenSweep']));
    expectAllSafe(fixture('v3-town'));

    // The healthy borrower short of its next payment, over-borrowed, with thin marketing, a storm-prone street and an outage.
    const short = fixture('v3-town');
    short.finance.cash += estimateNextDebtService(short) - estimateCashAtClose(short) - 1;
    expect(expectAllSafe(short)).toContain('paymentShort');

    const levered = fixture('v3-town');
    levered.debt.credit.balance += 300_000;
    expect(expectAllSafe(levered)).toContain('covenantCure');

    const quiet = fixture('v3-town');
    applyCommand(quiet, { type: 'setMarketing', perMonth: 0 });
    expectAllSafe(quiet);

    const stormy = fixture('v3-town');
    for (const segment of stormy.city.segments) segment.zone = 'rural';
    const aerial = stormy.network.spans.filter((s) => s.method === 'aerial' && s.stage === 'live');
    stormy.weather.storms = [1, 2].map((id) => ({ id, day: stormy.day - 40 * id, x: 0, y: 0, radius: 9, severity: 2, spans: aerial.map((s) => s.id), repairCost: 1 }));
    stormy.weather.nextStormId = 3;
    stormy.finance.cash += 200_000;
    expectAllSafe(stormy);

    const out = fixture('v3-town');
    for (const span of out.network.spans.slice(0, 5)) span.outage = { cause: 'storm', storm: null, startDay: out.day, daysLeft: 3, repairCost: 2_000 };
    out.network.version++;
    expectAllSafe(out);

    const rich = fixture('v3-town');
    rich.finance.cash += 500_000;
    expectAllSafe(rich);
  });
});

describe('suggestions shown together', () => {
  /** A full cabinet and a storm-prone aerial street feeding subscribers, on cash that covers the rebuild alone but not with the splitter. */
  function tight(): { state: GameState; span: CableSpan } {
    const state = litGame(150, ruralGrid());
    for (const span of state.network.spans) span.method = 'aerial';
    state.network.version++;
    const subs = (seg: number) => state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === seg).length;
    const span = [...state.network.spans].sort((a, b) => subs(b.segment) - subs(a.segment))[0]!;
    state.weather.storms = [1, 2].map((id) => ({ id, day: state.day - 30 * (3 - id), x: 0, y: 0, radius: 10, severity: 2, spans: [span.id], repairCost: 1 }));
    state.weather.nextStormId = 3;
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    const cost = quoteConvert(state, span.id).cost;
    state.finance.cash = 0;
    state.finance.cash = fundingHint(state, 0).cushion + cost + Math.floor(SPLITTER_COST / 2);
    return { state, span };
  }

  it('count what earlier suggestions spend: a purchase cash covers alone is not suggested on top of another', () => {
    const { state, span } = tight();
    // Alone, each is affordable.
    expect(plan(state, 'stormUnderground').commands).toEqual([{ type: 'convertSpan', span: span.id }]);
    expect(plan(state, 'addSplitter').commands).toEqual([{ type: 'addSplitter', cabinet: state.network.cabinets[0]!.id }]);
    // Together, the splitter (earlier in rule order) claims its cost, so the rebuild waits.
    const plans = advicePlans(state);
    expect(plans.find((p) => p.advice.id === 'addSplitter')!.commands).toHaveLength(1);
    const storm = plans.find((p) => p.advice.id === 'stormUnderground')!;
    expect(storm.commands).toEqual([]);
    expect(storm.advice.title).toMatch(/^Build underground around /);
    expectTogetherSafe(state, plans);
    // A snoozed suggestion claims nothing: with the splitter snoozed, cash covers the rebuild again.
    const splitterKey = plans.find((p) => p.advice.id === 'addSplitter')!.advice.key;
    expect(applyCommand(state, { type: 'snoozeAdvice', key: splitterKey }).ok).toBe(true);
    const after = advicePlans(state);
    expect(after.some((p) => p.advice.id === 'addSplitter')).toBe(false);
    expect(after.find((p) => p.advice.id === 'stormUnderground')!.commands).toEqual([{ type: 'convertSpan', span: span.id }]);
  });

  it('never suggest borrowing twice: a later purchase waits once an earlier suggestion borrows', () => {
    // Short of the next payment (a draw), with a full cabinet that cash cannot pay for.
    const state = withLoan(trading(20_000, 10_000, 0), 60_000);
    addLivePlant(state, { splitters: 1 });
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    state.finance.cash = estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1;
    expect(plan(state, 'addSplitter').commands.map((c) => c.type)).toEqual(['drawCredit', 'addSplitter']);
    const plans = advicePlans(state);
    expect(plans.find((p) => p.advice.id === 'paymentShort')!.commands.map((c) => c.type)).toEqual(['drawCredit']);
    const splitter = plans.find((p) => p.advice.id === 'addSplitter')!;
    expect(splitter.commands).toEqual([]);
    expect(splitter.advice.title).toMatch(/when cash allows$/);
    expectTogetherSafe(state, plans);
  });
});

// ---------------------------------------------------------------------------
// Determinism and cost
// ---------------------------------------------------------------------------

describe('determinism and cost', () => {
  it('is deterministic, the same on a copy, and never writes the state', () => {
    for (const state of [fixture('v3-grid'), fixture('v3-town'), litGame(150)]) {
      const before = hashState(state);
      const a = advicePlans(state);
      expect(advicePlans(state)).toEqual(a);
      expect(advicePlans(clone(state))).toEqual(a);
      expect(hashState(state)).toBe(before);
    }
  });

  it('advises on a generated town well inside the time budget', () => {
    const json = serialize(fixture('v3-town'));
    // Some outages and a promo, so the heavier rules run too.
    const busy = deserialize(json);
    for (const span of busy.network.spans.slice(0, 8)) span.outage = { cause: 'storm', storm: null, startDay: busy.day, daysLeft: 3, repairCost: 2_000 };
    busy.network.version++;
    busy.finance.cash += 500_000;
    const busyJson = serialize(busy);
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      for (const text of [json, busyJson]) {
        const state = deserialize(text);
        const t = performance.now();
        advise(state);
        times.push(performance.now() - t);
      }
    }
    times.sort((a, b) => a - b);
    expect(times[Math.floor(times.length / 2)]).toBeLessThan(30);
  });
});

// ---------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------

describe('buildBriefing', () => {
  it('is null before the first close', () => {
    expect(buildBriefing(makeTestState())).toBeNull();
  });

  it('describes the month that just closed: headline, changes, notices, breakdown and the forward look', () => {
    const state = litGame(31 + 28);
    const b = buildBriefing(state)!;
    const report = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    expect(b.report).toBe(report);
    expect(b.previous).toBe(previous);
    expect(b.span).toBe(1);
    expect(b.label).toBe('Feb 2027');
    expect(b.headline).toMatchObject({ net: report.net, cash: report.cashEnd, passings: report.passings, cppTarget: CPP_TARGET, stage: 'compliant' });
    const net = b.changes.find((c) => c.key === 'net')!;
    expect(net).toMatchObject({ now: report.net, before: previous.net, delta: report.net - previous.net, upIsGood: true });
    expect(b.changes.find((c) => c.key === 'subscribers')?.now).toBe(report.stats?.subscribers);
    // The breakdown is the month's totals, revenue first.
    expect(b.breakdown.map((x) => x.category)[0]).toBe('revenue');
    expect(b.breakdown.reduce((sum, x) => sum + x.amount, 0)).toBe(report.net);
    // The month's notices: after February's predecessor's cursor, up to its own.
    for (const n of b.notices) {
      expect(n.id).toBeGreaterThan(previous.ops!.lastNoticeId);
      expect(n.id).toBeLessThanOrEqual(report.ops!.lastNoticeId);
    }
    expect(b.forward.nextCloseDay).toBe(state.day + 31);
    expect(b.forward.closesUntilCalled).toBeNull();
    expect(b.advice).toEqual(advise(state));
  });

  it('covers a quarter: flows summed over three months against the three before', () => {
    const state = litGame(181);
    applyCommand(state, { type: 'setMarketing', perMonth: 2_000 });
    const b = buildBriefing(state, 3)!;
    const reports = state.finance.reports;
    expect(b.span).toBe(3);
    expect(b.label).toBe('Apr-Jun 2027');
    const sum = (rs: typeof reports) => rs.reduce((t, r) => t + r.net, 0);
    expect(b.headline.net).toBe(sum(reports.slice(-3)));
    expect(b.changes.find((c) => c.key === 'net')?.before).toBe(sum(reports.slice(-6, -3)));
    expect(b.previous).toBe(reports.at(-4));
    const revenue = b.breakdown.find((x) => x.category === 'revenue')!.amount;
    expect(revenue).toBe(reports.slice(-3).reduce((t, r) => t + (r.totals.revenue ?? 0), 0));
    // A quarter asked for with fewer months closed covers what there is.
    expect(buildBriefing(litGame(31 + 28), 3)!.span).toBe(2);
  });

  it('takes the notices of reports without a cursor (older saves) by close day', () => {
    const state = litGame(31 + 28 + 31);
    for (const report of state.finance.reports) delete report.ops;
    const report = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    const b = buildBriefing(state)!;
    const expected = state.notices.filter((n) => n.day > closeDayOf(previous) && n.day <= closeDayOf(report));
    expect(b.notices).toEqual(expected);
    // The migrated v3 fixtures have no cursors at all: they still brief.
    const grid = buildBriefing(fixture('v3-grid'))!;
    const last = fixture('v3-grid').finance.reports.at(-1)!;
    for (const n of grid.notices) expect(n.day).toBeLessThanOrEqual(closeDayOf(last));
  });

  it('needs attention for urgent advice or an attention notice in the period, and not otherwise', () => {
    // The frozen hoarder: urgent cure advice.
    const grid = buildBriefing(fixture('v3-grid'))!;
    expect(grid.advice.some((a) => a.severity === 'urgent')).toBe(true);
    expect(grid.needsAttention).toBe(true);

    const state = litGame(31 + 28);
    const quiet = buildBriefing(state)!;
    const attention = quiet.notices.some((n) => noticeNeedsAttention(state, n)) || quiet.advice.some((a) => a.severity === 'urgent');
    expect(quiet.needsAttention).toBe(attention);

    // Strip the period of attention notices, then add one.
    const report = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    state.notices = state.notices.filter((n) => !ATTENTION_NOTICE_KINDS.has(n.kind));
    expect(buildBriefing(state)!.needsAttention).toBe(false);
    const id = previous.ops!.lastNoticeId + 1;
    report.ops!.lastNoticeId = Math.max(report.ops!.lastNoticeId, id);
    const notice: Notice = { id, day: state.day, kind: 'insolvencyWarning', message: 'x', cabinet: null, milestone: null };
    state.notices = [...state.notices.filter((n) => n.id !== notice.id), notice].sort((a, b) => a.id - b.id);
    expect(buildBriefing(state)!.needsAttention).toBe(true);
  });

  it('counts a storm in the period as needing attention only while plant is still out', () => {
    const state = litGame(31 + 28);
    const report = state.finance.reports.at(-1)!;
    const previous = state.finance.reports.at(-2)!;
    state.notices = state.notices.filter((n) => !ATTENTION_NOTICE_KINDS.has(n.kind));
    const id = previous.ops!.lastNoticeId + 1;
    report.ops!.lastNoticeId = Math.max(report.ops!.lastNoticeId, id);
    const storm: Notice = { id, day: state.day - 3, kind: 'storm', message: 'A storm hit', cabinet: null, milestone: null };
    state.notices = [...state.notices.filter((n) => n.id !== id), storm].sort((a, b) => a.id - b.id);
    const urgent = buildBriefing(state)!.advice.some((a) => a.severity === 'urgent');
    expect(urgent).toBe(false);
    // Repaired before the close: news, not attention.
    expect(state.network.spans.every((s) => s.outage === null)).toBe(true);
    expect(noticeNeedsAttention(state, storm)).toBe(false);
    expect(buildBriefing(state)!.needsAttention).toBe(false);
    // Still out: attention.
    state.network.spans[0]!.outage = { cause: 'storm', storm: 1, startDay: state.day - 3, daysLeft: 2, repairCost: 1_000 };
    state.network.version++;
    expect(noticeNeedsAttention(state, storm)).toBe(true);
    expect(buildBriefing(state)!.needsAttention).toBe(true);
  });

  it('reads the forward look from the debt: the next payment, projected cash and the countdown', () => {
    const state = fixture('v3-grid');
    const b = buildBriefing(state)!;
    expect(b.forward.nextPayment).toBe(estimateNextDebtService(state));
    // Frozen: the close also takes the sweep.
    expect(b.forward.sweep).toBe(estimateSweep(state));
    expect(b.forward.projectedCash).toBe(estimateCashAtClose(state) - estimateNextDebtService(state) - estimateSweep(state));
    expect(b.forward.closesUntilCalled).toBe(closesUntilAcceleration(state));
    expect(b.forward.runwayMonths).toBe(runwayMonths(state));
    expect(b.headline.debt).toBe(totalDebt(state));
    expect(b.headline.stage).toBe('frozen');
  });
});

describe('snoozes and repeats (round 4b)', () => {
  /** A lit game whose 1 Gig is priced 30% over the market (and, with `twoTiers`, 500 Meg 40% under it): the pricing tip fires. */
  function overpriced(twoTiers = false): GameState {
    const state = litGame(150);
    const factor = (id: string) => (id === 'fiber1g' ? 1.3 : twoTiers && id === 'fiber500' ? 0.6 : 1);
    const tiers = state.sales.pricing.tiers.map((t) => ({ id: t.id, price: Math.round(t.price * factor(t.id)), offered: t.offered }));
    expect(applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: state.sales.pricing.smbMultiplier })).toMatchObject({ ok: true });
    return state;
  }

  /** Run to the next month close. */
  function closeNext(state: GameState): void {
    const before = state.finance.reports.length;
    while (state.finance.reports.length === before) tick(state);
  }

  /** What the sheet does when a close-time briefing opens: note the keys it shows. */
  function noteBriefing(state: GameState): Advice[] {
    const briefing = buildBriefing(state)!;
    expect(briefingBuiltOn(briefing)).toBe(state.day);
    expect(applyCommand(state, { type: 'noteAdviceShown', keys: briefing.advice.map((a) => a.key) })).toEqual({ ok: true, cost: 0 });
    return briefing.advice;
  }

  it('every advice has a key naming its rule and subject, and a repeat count', () => {
    const state = overpriced();
    const all = advicePlans(state).map((p) => p.advice);
    expect(all.length).toBeGreaterThan(0);
    for (const a of all) {
      expect(a.key).toMatch(KEY_PATTERN[a.id]);
      expect(a.repeat).toBe(0);
    }
    expect(all.find((a) => a.id === 'pricing')!.key).toBe(ADVICE_KEYS.pricing('fiber1g'));
  });

  it('never repeats a suggestion word for word in briefings in a row', () => {
    const state = overpriced();
    const whys: string[] = [];
    const details: string[] = [];
    let first = 0;
    for (let i = 0; i < 4; i++) {
      closeNext(state);
      if (i === 0) first = state.day;
      const shown = noteBriefing(state).find((a) => a.id === 'pricing');
      expect(shown, `briefing ${i + 1}`).toBeDefined();
      expect(shown!.repeat).toBe(i);
      whys.push(shown!.why);
      details.push(shown!.detail);
    }
    for (let i = 1; i < details.length; i++) {
      expect(`${whys[i]} ${details[i]}` !== `${whys[i - 1]} ${details[i - 1]}`, `briefings ${i} and ${i + 1}`).toBe(true);
    }
    // Round 4c/4d: the card's short reason stays as it is (it must fit the card); the repeat note leads the detail
    // behind it, saying since when and how many briefings running.
    for (const why of whys) {
      expect(why).not.toMatch(/Still open/);
      expect(why.length).toBeLessThanOrEqual(ADVICE_WHY_MAX);
    }
    const covered = formatDate(first - 1).slice(0, 3);
    expect(details[0]).not.toMatch(/^Still open/);
    expect(details[1]).toMatch(new RegExp(`^Still open since the ${covered} \\d{4} briefing \\(2nd briefing in a row\\)\\. `));
    expect(details[2]).toContain('(3rd briefing in a row)');
    expect(details[3]).toContain('(4th briefing in a row)');
    expect(details[3]!.endsWith(details[0]!.slice(-40))).toBe(true);
    // A rebuild later the same day (the sheet after a snooze) words it the same way.
    const again = buildBriefing(state)!.advice.find((a) => a.id === 'pricing')!;
    expect(again.why).toBe(whys[3]);
    expect(again.detail).toBe(details[3]);
    // rewordRepeat leaves new advice alone.
    const fresh = advice('pricing', ADVICE_PRIORITY.pricing);
    expect(rewordRepeat(state, fresh)).toBe(fresh);
  });

  it('a snoozed suggestion leaves advise() and the briefing until its snooze ends, then comes back', () => {
    const state = overpriced();
    const pricing = advise(state).find((a) => a.id === 'pricing');
    expect(pricing).toBeDefined();
    expect(applyCommand(state, { type: 'snoozeAdvice', key: pricing!.key })).toEqual({ ok: true, cost: 0 });
    const until = closeDayAfter(state.day, ADVICE_SNOOZE_MONTHS);
    expect(state.advisor.snoozes).toEqual([{ key: pricing!.key, untilDay: until, severity: pricing!.severity }]);
    expect(advise(state).some((a) => a.key === pricing!.key)).toBe(false);
    expect(advicePlans(state).some((p) => p.advice.key === pricing!.key)).toBe(false);
    expect(isSnoozed(state, pricing!)).toBe(true);
    // A worse situation (a higher severity) shows it again at once.
    expect(isSnoozed(state, { key: pricing!.key, severity: 'urgent' })).toBe(false);
    // Hidden at every close before the snooze ends, counted as snoozed; back on the close it ends at.
    while (state.day < until - 1) {
      closeNext(state);
      if (state.day >= until) break;
      const briefing = buildBriefing(state)!;
      expect(briefing.advice.some((a) => a.key === pricing!.key)).toBe(false);
      expect(briefing.snoozed).toBeGreaterThanOrEqual(1);
    }
    expect(state.day).toBe(until);
    expect(isSnoozed(state, pricing!)).toBe(false);
    expect(advise(state, 99).some((a) => a.key === pricing!.key)).toBe(true);
  });

  it('snoozes an urgent suggestion only until the next month', () => {
    const state = withLoan(trading(20_000, 10_000, 0), 60_000);
    state.finance.cash = estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1;
    const urgent = advise(state).find((a) => a.id === 'paymentShort')!;
    expect(urgent.severity).toBe('urgent');
    expect(applyCommand(state, { type: 'snoozeAdvice', key: urgent.key }).ok).toBe(true);
    expect(state.advisor.snoozes[0]).toEqual({ key: 'paymentShort', untilDay: closeDayAfter(state.day, ADVICE_SNOOZE_URGENT_MONTHS), severity: 'urgent' });
    expect(advise(state).some((a) => a.id === 'paymentShort')).toBe(false);
  });

  it('shows a snoozed suggestion again when it turns more severe', () => {
    // Compliant but near the leverage limit: covenantCure warns (important).
    const state = trading(10_000, 9_000, 500_000);
    let debt = 0;
    while (covenantsWithin(covenantMetrics(state), COVENANT_RISK_MARGIN)) {
      debt += LOAN_ROUNDING * 10;
      state.debt.credit.balance = debt;
    }
    const warning = advise(state, 99).find((a) => a.id === 'covenantCure')!;
    expect(warning.severity).toBe('important');
    expect(applyCommand(state, { type: 'snoozeAdvice', key: warning.key }).ok).toBe(true);
    expect(advise(state, 99).some((a) => a.id === 'covenantCure')).toBe(false);
    // Breached on the penalty stage: urgent, and it shows despite the snooze.
    state.debt.credit.balance = debt * 3;
    state.debt.covenant.stage = 'penalty';
    const breach = advise(state, 99).find((a) => a.id === 'covenantCure');
    expect(breach?.severity).toBe('urgent');
  });

  it('passes over a snoozed subject to the next one, and counts it as snoozed', () => {
    const state = overpriced(true);
    const first = advise(state, 99).find((a) => a.id === 'pricing')!;
    expect(first.key).toBe(ADVICE_KEYS.pricing('fiber500'));
    expect(buildBriefing(state)!.snoozed).toBe(0);
    expect(applyCommand(state, { type: 'snoozeAdvice', key: first.key }).ok).toBe(true);
    const next = advise(state, 99).find((a) => a.id === 'pricing')!;
    expect(next.key).toBe(ADVICE_KEYS.pricing('fiber1g'));
    expect(buildBriefing(state)!.snoozed).toBe(1);
    // The one shown in its place can be snoozed too; then neither shows, both count.
    expect(applyCommand(state, { type: 'snoozeAdvice', key: next.key }).ok).toBe(true);
    expect(advise(state, 99).some((a) => a.id === 'pricing')).toBe(false);
    expect(buildBriefing(state)!.snoozed).toBe(2);
    expect(state.advisor.snoozes.map((x) => x.key)).toEqual([ADVICE_KEYS.pricing('fiber1g'), ADVICE_KEYS.pricing('fiber500')]);
  });

  it('replaces a snooze on the same key, drops ended ones and keeps at most ADVISOR_MEMORY_MAX', () => {
    const state = overpriced();
    const key = advise(state).find((a) => a.id === 'pricing')!.key;
    state.advisor.snoozes = Array.from({ length: ADVISOR_MEMORY_MAX }, (_, i) => ({ key: `old:${String(i).padStart(2, '0')}`, untilDay: state.day + 40 + i, severity: 'tip' as const }));
    state.advisor.snoozes.push({ key: 'ended', untilDay: state.day, severity: 'tip' });
    state.advisor.snoozes.sort((a, b) => (a.key < b.key ? -1 : 1));
    expect(applyCommand(state, { type: 'snoozeAdvice', key }).ok).toBe(true);
    const keys = state.advisor.snoozes.map((x) => x.key);
    expect(keys).toHaveLength(ADVISOR_MEMORY_MAX);
    expect(keys).toContain(key);
    expect(keys).not.toContain('ended');
    // The soonest-ending went first; ascending key.
    expect(keys).not.toContain('old:00');
    expect([...keys].sort()).toEqual(keys);
    // Snoozing it again just moves its end.
    state.day += 1;
    expect(applyCommand(state, { type: 'snoozeAdvice', key }).ok).toBe(true);
    expect(state.advisor.snoozes.filter((x) => x.key === key)).toHaveLength(1);
  });

  it('always keeps the new snooze when the memory is full, even one ending sooner than every other', () => {
    // An urgent snooze (one close) ends before tips snoozed for three: the memory evicts among the others.
    const state = withLoan(trading(20_000, 10_000, 0), 60_000);
    state.finance.cash = estimateNextDebtService(state) + state.finance.cash - estimateCashAtClose(state) - 1;
    const urgent = advise(state).find((a) => a.id === 'paymentShort')!;
    expect(urgent.severity).toBe('urgent');
    const later = closeDayAfter(state.day, ADVICE_SNOOZE_MONTHS);
    expect(later).toBeGreaterThan(closeDayAfter(state.day, ADVICE_SNOOZE_URGENT_MONTHS));
    state.advisor.snoozes = Array.from({ length: ADVISOR_MEMORY_MAX }, (_, i) => ({ key: `tip:${String(i).padStart(2, '0')}`, untilDay: later, severity: 'tip' as const }));
    expect(applyCommand(state, { type: 'snoozeAdvice', key: urgent.key })).toEqual({ ok: true, cost: 0 });
    const keys = state.advisor.snoozes.map((x) => x.key);
    expect(keys).toHaveLength(ADVISOR_MEMORY_MAX);
    expect(keys).toContain(urgent.key);
    expect([...keys].sort()).toEqual(keys);
    expect(isSnoozed(state, urgent)).toBe(true);
    expect(advise(state).some((a) => a.key === urgent.key)).toBe(false);
    // A tip snoozed the same day as 32 others whose keys sort first is kept too.
    const pricingState = overpriced();
    const key = advise(pricingState).find((a) => a.id === 'pricing')!.key;
    const until = closeDayAfter(pricingState.day, ADVICE_SNOOZE_MONTHS);
    pricingState.advisor.snoozes = Array.from({ length: ADVISOR_MEMORY_MAX }, (_, i) => ({ key: `a:${String(i).padStart(2, '0')}`, untilDay: until, severity: 'tip' as const }));
    expect(applyCommand(pricingState, { type: 'snoozeAdvice', key }).ok).toBe(true);
    expect(pricingState.advisor.snoozes.map((x) => x.key)).toContain(key);
    expect(pricingState.advisor.snoozes).toHaveLength(ADVISOR_MEMORY_MAX);
  });

  it('refuses to snooze a suggestion that is not showing, or a malformed key', () => {
    const state = overpriced();
    const before = JSON.stringify(state);
    expect(applyCommand(state, { type: 'snoozeAdvice', key: 'expand:node:99999' }).ok).toBe(false);
    expect(applyCommand(state, { type: 'snoozeAdvice', key: 'has space' }).ok).toBe(false);
    expect(applyCommand(state, { type: 'snoozeAdvice', key: 'x'.repeat(ADVICE_KEY_MAX_LENGTH + 1) }).ok).toBe(false);
    expect(JSON.stringify(state)).toBe(before);
  });

  it('counts briefings in a row that showed a key', () => {
    const state = overpriced();
    const key = advise(state).find((a) => a.id === 'pricing')!.key;
    expect(applyCommand(state, { type: 'noteAdviceShown', keys: [key] }).ok).toBe(true);
    expect(state.advisor.shown).toEqual([{ key, firstDay: state.day, lastDay: state.day, times: 1 }]);
    expect(repeatOf(state, key)).toBe(0);
    const first = state.day;
    runDays(state, 31);
    expect(repeatOf(state, key)).toBe(1);
    expect(advise(state).find((a) => a.key === key)?.repeat).toBe(1);
    expect(applyCommand(state, { type: 'noteAdviceShown', keys: [key] }).ok).toBe(true);
    expect(state.advisor.shown).toEqual([{ key, firstDay: first, lastDay: state.day, times: 2 }]);
    // Noting the same briefing twice the same day changes nothing.
    const shown = structuredClone(state.advisor.shown);
    expect(applyCommand(state, { type: 'noteAdviceShown', keys: [key] }).ok).toBe(true);
    expect(state.advisor.shown).toEqual(shown);
    // A briefing without it breaks the run.
    runDays(state, 31);
    expect(applyCommand(state, { type: 'noteAdviceShown', keys: ['cashRunway'] }).ok).toBe(true);
    expect(state.advisor.shown.map((e) => e.key)).toEqual(['cashRunway']);
    expect(repeatOf(state, key)).toBe(0);
    // Bad lists are refused whole.
    expect(applyCommand(state, { type: 'noteAdviceShown', keys: ['a', 'a'] }).ok).toBe(false);
    expect(applyCommand(state, { type: 'noteAdviceShown', keys: ['no spaces please'] }).ok).toBe(false);
    expect(applyCommand(state, { type: 'noteAdviceShown', keys: Array.from({ length: ADVICE_SHOWN_MAX + 1 }, (_, i) => `k${i}`) }).ok).toBe(false);
  });

  it('knows the day a briefing was built: the close day for the close-time one, later for a reopened one', () => {
    const state = litGame(31);
    const atClose = buildBriefing(state)!;
    expect(briefingBuiltOn(atClose)).toBe(closeDayOf(atClose.report));
    runDays(state, 5);
    const reopened = buildBriefing(state)!;
    expect(reopened.report).toBe(atClose.report);
    expect(briefingBuiltOn(reopened)).toBe(closeDayOf(atClose.report) + 5);
    expect(briefingBuiltOn({ ...atClose })).toBeNull();
  });

  it('a new game remembers nothing', () => {
    expect(newAdvisorState()).toEqual({ snoozes: [], shown: [] });
    expect(newGame(7).advisor).toEqual({ snoozes: [], shown: [] });
  });
});

describe('the card limits (round 4c/4d, spec B)', () => {
  it('were checked on every rule: each fired in the scenarios above, and each card fit the 45/90 limits with its detail and cost', () => {
    // Runs after every test above (vitest runs a file's tests in order): every rule's card went through expectShort.
    expect([...ADVICE_ORDER].filter((id) => !CHECKED_SHORT.has(id))).toEqual([]);
  });
});
