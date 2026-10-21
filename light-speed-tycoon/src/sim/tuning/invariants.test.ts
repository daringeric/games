// Invariants over long mixed bot sessions (bots.ts mixedBot: the careful
// operator, borrowing, plus random removals, cancellations, splitters, OLT
// cards, price and budget changes, credit-line draws and repayments, term
// loans, prepayments and junk), using every command type:
//
// - capex: capex.osp + capex.co === -(every construction, equipment and refund
//   amount ever posted) and capex.connect === -(every install amount);
// - the books: opening cash + every amount ever posted === cash (financing
//   entries - proceeds, principal, interest, late fees - included);
// - debt: total debt moves only by what is posted as loan proceeds and
//   principal (unless a missed payment capitalized interest);
// - a command's cost is exactly the cash it moved; a rejected one moves none;
// - ports: accounts within each cabinet's splitters, splitters within the OLT;
// - round 4: price locks one per tier, only on tiers with units, in tier
//   order; outages only on live spans, and never longer than their method's
//   longest outage; the frozen-line count and the call consistent with the
//   covenant stage and the debt; each close's ops figures consistent with
//   its stats and ledger (price + outage + incumbent cancellations within
//   the month's churn, repairs = -totals.repair);
// - round 4b: retention price locks only until the end of an answered
//   incumbent promo there; the incumbent's promo memory one record per
//   cabinet, ascending, answered only once running (with an intro promo
//   only while one is set); outage credits never
//   negative and every day bills every subscribed unit in full, as revenue
//   or as an outage credit (month accruals: revenue + credits = MRR each
//   day; at a close, revenue + credits = the month's full billing); advisor
//   snoozes and shown entries ascending, one per key, bounded; the company
//   unchanged during play;
// - saves round-trip (and a game reloaded mid-session replays identically);
// - any single-field corruption of a mid-session save is rejected with a
//   SaveError or loads a game that then runs every command and a month close
//   without crashing, with consistent books from then on.

import { describe, expect, it } from 'vitest';
import {
  ACCELERATION_CLOSES,
  FROZEN_ACCELERATION_CLOSES,
  INCUMBENT_PRICE,
  LOAN_ROUNDING,
  OUTAGE_DAYS_AERIAL_MAX,
  OUTAGE_DAYS_UNDERGROUND_MAX,
  START_CASH,
  TERM_LOAN_MIN,
  TERM_LOAN_YEARS,
  TIER_DEFAULTS,
} from '../balance';
import { isFirstOfMonth, MONTH_LENGTHS } from '../calendar';
import { ADVISOR_MEMORY_MAX } from '../advisor';
import { creditAvailable, totalDebt } from '../debt';
import { applyCommand, newGame, runDays, tick } from '../game';
import { getService, ponPortsUsed } from '../network';
import { cabinetPortCapacity, cabinetPortsUsed, monthlyRecurringRevenue, TIER_IDS } from '../sales';
import { deserialize, hashState, SaveError, serialize } from '../save';
import { makeGridCity } from '../testing/fixtures';
import type { GridCityOptions } from '../testing/fixtures';
import type { Command, CommandResult, Company, GameState, MonthlyReport, PriceLockReason, TermYears } from '../types';
import { ensureIncumbentPromo, mixedBot } from './bots';
import { runBot } from './harness';
import type { BotFactory } from './harness';

/** Every player command type: a session must use each one successfully. */
const COMMAND_TYPES: readonly Command['type'][] = [
  'layCable',
  'placeCabinet',
  'removeSpan',
  'addSplitter',
  'removeCabinet',
  'addOltCard',
  'setPricing',
  'setPromo',
  'convertSpan',
  'setMarketing',
  'drawCredit',
  'repayCredit',
  'takeTermLoan',
  'prepayLoan',
  'answerIncumbent',
  'snoozeAdvice',
  'noteAdviceShown',
];
const PLANT_CATEGORIES = ['construction', 'equipment', 'refund'] as const;
const SESSION_SEEDS = [3, 2027];
/**
 * Months a session plays: storms start in its second year, and since round 4b
 * they center toward the exposed edges of the map, so a plant near the CO
 * sees fewer of them; five years give every session storm damage to check.
 */
const SESSION_MONTHS = 60;
/**
 * Closes after which the session injects an incumbent promo at its largest
 * cabinet area (bots.ensureIncumbentPromo, a test-only state edit), so the
 * retention offer (answerIncumbent) is exercised: since round 4b the
 * incumbent only answers take rates above where a careful operator's areas
 * settle, which the mixed bot's random prices rarely reach.
 */
const PROMO_INJECT_CLOSES: readonly number[] = [24, 42];
// Round 4b review: an injected promo is also answered at the session's next
// look (the first one that takes; later ones are left to the mixed bot's random
// answers), so the retention offer runs whatever those answers hit: the bot's
// random draws follow what the advisor shows (randomAdviceCommand), so any
// advisor change reshuffles them.
/** Months between full save round-trips during a session (a generated town's save is large). */
const ROUND_TRIP_EVERY_MONTHS = 6;
const LONG_TEST_MS = 120_000;
/**
 * The mixed bot throws money away on purpose (random marketing budgets, prices,
 * removals); this much of START_CASH lets it play whole sessions.
 */
const MIXED_CASH_MULTIPLE = 6;

/** Every amount ever posted: closed months and the open one. */
function postedTotal(state: GameState): number {
  let total = 0;
  for (const report of state.finance.reports) total += report.net;
  for (const entry of state.finance.monthToDate) total += entry.amount;
  return total;
}

/** Every amount ever posted in `categories`. */
function postedIn(state: GameState, categories: readonly string[]): number {
  let total = 0;
  for (const report of state.finance.reports) {
    for (const category of categories) total += (report.totals as Record<string, number | undefined>)[category] ?? 0;
  }
  for (const entry of state.finance.monthToDate) if (categories.includes(entry.category)) total += entry.amount;
  return total;
}

interface Books {
  /** Cash before anything in the session was posted. */
  opening: number;
  /** capex.osp + capex.co + plant postings, and capex.connect + install postings, at the start (0 for a new game). */
  plantBase: number;
  connectBase: number;
  /** Total debt less every loan proceeds and principal amount posted, at the start. */
  debtBase: number;
  /** Closes that had missed a payment at the start. */
  missedBase: number;
}

const DEBT_CATEGORIES = ['loanProceeds', 'principal'] as const;

function missedPayments(state: GameState): number {
  return state.finance.reports.filter((r) => r.debt?.missedPayment).length;
}

function openBooks(state: GameState): Books {
  return {
    opening: state.finance.cash - postedTotal(state),
    plantBase: state.finance.capex.osp + state.finance.capex.co + postedIn(state, PLANT_CATEGORIES),
    connectBase: state.finance.capex.connect + postedIn(state, ['install']),
    debtBase: totalDebt(state) - postedIn(state, DEBT_CATEGORIES),
    missedBase: missedPayments(state),
  };
}

/** Plain-boolean checks (cheap enough to run after every command and tick): the first broken one, or null. */
function brokenInvariant(state: GameState, books: Books): string | null {
  const { finance } = state;
  if (books.opening + postedTotal(state) !== finance.cash) return `books: ${books.opening} + posted ${postedTotal(state)} != cash ${finance.cash}`;
  const plant = finance.capex.osp + finance.capex.co + postedIn(state, PLANT_CATEGORIES);
  if (plant !== books.plantBase) return `plant capex ${finance.capex.osp} + ${finance.capex.co} does not match its ledger (${plant} != ${books.plantBase})`;
  const connect = finance.capex.connect + postedIn(state, ['install']);
  if (connect !== books.connectBase) return `connect capex ${finance.capex.connect} does not match the install ledger`;
  // A missed payment adds its unpaid interest to the balances without a ledger entry.
  if (missedPayments(state) === books.missedBase && totalDebt(state) !== books.debtBase + postedIn(state, DEBT_CATEGORIES)) {
    return `debt ${totalDebt(state)} does not match proceeds and principal posted (${books.debtBase} + ${postedIn(state, DEBT_CATEGORIES)})`;
  }
  const used = cabinetPortsUsed(state);
  for (const cabinet of state.network.cabinets) {
    if ((used.get(cabinet.id) ?? 0) > cabinetPortCapacity(cabinet)) return `cabinet ${cabinet.id} carries more ports than its splitters`;
  }
  if (ponPortsUsed(state) > state.network.olt.ponPorts) return 'more splitters than OLT PON ports';
  return brokenRound4Invariant(state);
}

/** Round-4 state invariants: price locks, outages, the frozen line. The first broken one, or null. */
function brokenRound4Invariant(state: GameState): string | null {
  for (const account of state.sales.accounts) {
    let last = -1;
    for (const lock of account.locks) {
      const order = TIER_IDS.indexOf(lock.tier);
      if (order <= last) return `parcel ${account.parcel}: price locks not one per tier in tier order`;
      last = order;
      if (account.tierUnits[lock.tier] <= 0) return `parcel ${account.parcel}: a price lock on ${lock.tier}, which it has no units on`;
    }
  }
  for (const span of state.network.spans) {
    const outage = span.outage;
    if (outage === null) continue;
    if (span.stage !== 'live') return `span ${span.id}: an outage on a span that is not live`;
    const longest = span.method === 'aerial' ? OUTAGE_DAYS_AERIAL_MAX : OUTAGE_DAYS_UNDERGROUND_MAX;
    if (outage.daysLeft < 1 || state.day - outage.startDay + outage.daysLeft > longest) {
      return `span ${span.id}: an outage from day ${outage.startDay} with ${outage.daysLeft} days left outlasts ${longest} days`;
    }
  }
  const { covenant, frozenCloses, acceleration } = state.debt;
  if (frozenCloses < 0 || (frozenCloses > 0 && covenant.stage !== 'frozen')) return `${frozenCloses} frozen closes at stage ${covenant.stage}`;
  if (acceleration !== null && (acceleration.closesLeft < 1 || acceleration.closesLeft > ACCELERATION_CLOSES)) {
    return `loans called with ${acceleration.closesLeft} closes left`;
  }
  return brokenRound4bInvariant(state);
}

const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Round-4b state invariants: retention locks, the incumbent's promo memory,
 * the advisor's snoozes and shown entries. The first broken one, or null.
 */
function brokenRound4bInvariant(state: GameState): string | null {
  const promos = state.sales.incumbentPromos;
  for (let i = 0; i < promos.length; i++) {
    const p = promos[i]!;
    if (i > 0 && promos[i - 1]!.cabinet >= p.cabinet) return 'incumbent promo records not one per cabinet in ascending order';
    if (!(p.startDay < p.endDay && p.endDay <= p.quietUntil)) return `incumbent promo at ${p.cabinet}: days ${p.startDay} < ${p.endDay} <= ${p.quietUntil} broken`;
    if (p.price < 1 || p.price > INCUMBENT_PRICE || p.triggerTakePct < 0 || p.triggerTakePct > 100) return `incumbent promo at ${p.cabinet}: price ${p.price}, trigger ${p.triggerTakePct}%`;
    if (p.answered && state.day < p.startDay) return `incumbent promo at ${p.cabinet} answered before it started`;
    if (p.answeredWithPromo && state.day < p.startDay) return `incumbent promo at ${p.cabinet} answered with an intro promo before it started`;
    // Answered with an intro promo only while one is set (taking it away un-answers the running promo).
    if (p.answeredWithPromo && p.startDay <= state.day && state.day < p.endDay && state.sales.promo === null) return `incumbent promo at ${p.cabinet} answered with an intro promo that is not set`;
  }
  for (const account of state.sales.accounts) {
    for (const lock of account.locks) {
      // A lock to give back sits only on a retention lock, promised past it, at a dearer price.
      if (lock.resume && (lock.reason !== 'retention' || lock.resume.untilDay <= lock.untilDay || lock.resume.price <= lock.price)) {
        return `parcel ${account.parcel}: a ${lock.reason} lock until day ${lock.untilDay} gives back ${JSON.stringify(lock.resume)}`;
      }
      if (lock.reason !== 'retention' || lock.untilDay <= state.day) continue;
      // A live retention lock lasts until the end of an answered promo it answered.
      if (!promos.some((p) => p.answered && p.endDay === lock.untilDay)) return `parcel ${account.parcel}: a retention lock until day ${lock.untilDay} without an answered promo ending then`;
    }
  }
  const { snoozes, shown } = state.advisor;
  for (const [label, list] of [['snoozes', snoozes], ['shown', shown]] as const) {
    if (list.length > ADVISOR_MEMORY_MAX) return `advisor ${label}: ${list.length} entries`;
    for (let i = 1; i < list.length; i++) if (byKey(list[i - 1]!, list[i]!) >= 0) return `advisor ${label} not one per key in ascending order`;
  }
  for (const e of shown) if (e.times < 1 || e.lastDay < e.firstDay || e.lastDay > state.day) return `advisor shown ${e.key}: ${e.times} times, days ${e.firstDay}..${e.lastDay}`;
  return null;
}

/**
 * Round 4b: every day bills every subscribed unit in full, as revenue or as
 * an outage credit. Tracks the open month's accruals between ticks: each
 * tick adds exactly the day's MRR (sales.monthlyRecurringRevenue: price
 * locks included) to revenue + credit dollar-days; a close posts revenue and
 * ops.outageCredits that add up to the month's full billing (to the rounding
 * of each). Returns a checker to call after every tick.
 */
function billingChecker(): (state: GameState) => string | null {
  let full: number | null = null;
  let closes = -1;
  return (state) => {
    const month = state.sales.month;
    const sum = month.revenueDollarDays + month.outageCreditDollarDays;
    const mrr = monthlyRecurringRevenue(state);
    const reports = state.finance.reports;
    let problem: string | null = null;
    if (full !== null && closes >= 0 && reports.length > closes) {
      const report = reports.at(-1) as MonthlyReport;
      const billed = (report.totals.revenue ?? 0) + (report.ops?.outageCredits ?? 0);
      const monthDays = MONTH_LENGTHS[report.month - 1] as number;
      if (Math.abs(billed - full / monthDays) > 1.01) problem = `${report.year}-${report.month}: revenue + credits ${billed} vs full billing ${(full / monthDays).toFixed(2)}`;
      if (Math.abs(sum - mrr) > 1e-6 * Math.max(1, mrr)) problem ??= `day ${state.day}: the close day accrued ${sum} vs MRR ${mrr}`;
    } else if (full !== null && Math.abs(sum - full - mrr) > 1e-6 * Math.max(1, mrr)) {
      problem = `day ${state.day}: accrued ${sum - full} vs MRR ${mrr}`;
    }
    full = sum;
    closes = reports.length;
    return problem;
  };
}

/** Invariants of one closed month's report (round 4: ops, the frozen line at the close). The first broken one, or null. */
function brokenCloseInvariant(report: MonthlyReport): string | null {
  const label = `${report.year}-${report.month}`;
  const { ops, stats, debt } = report;
  if (!ops || !stats || !debt) return `${label}: a round-4 close without ops, stats or debt figures`;
  if (ops.priceChurn < 0 || ops.outageChurn < 0 || ops.incumbentChurn < 0) return `${label}: negative churn figures`;
  if (ops.priceChurn + ops.outageChurn + ops.incumbentChurn > stats.churned) {
    return `${label}: price ${ops.priceChurn} + outage ${ops.outageChurn} + incumbent ${ops.incumbentChurn} cancellations exceed the ${stats.churned} churned`;
  }
  if (ops.repairs !== 0 - (report.totals.repair ?? 0)) return `${label}: repairs ${ops.repairs} vs ledger ${report.totals.repair ?? 0}`;
  if (ops.outageUnitDays < 0 || ops.storms < 0 || ops.spansDamaged < 0) return `${label}: negative outage figures`;
  if (ops.outageCredits < 0) return `${label}: negative outage credits ${ops.outageCredits}`;
  if (ops.outageCredits > 0 && ops.outageUnitDays === 0) return `${label}: outage credits ${ops.outageCredits} without a subscriber-day out`;
  const owed = debt.creditBalance + debt.termBalance;
  const frozenCloses = debt.frozenCloses ?? 0;
  if (frozenCloses > 0 && (debt.stage !== 'frozen' || owed === 0)) return `${label}: ${frozenCloses} frozen closes at stage ${debt.stage} owing ${owed}`;
  const left = debt.accelerationClosesLeft ?? null;
  if (left !== null && (owed === 0 || left < 1 || left > ACCELERATION_CLOSES)) return `${label}: loans called with ${left} closes left owing ${owed}`;
  if (frozenCloses >= FROZEN_ACCELERATION_CLOSES && owed > 0 && left === null) return `${label}: ${frozenCloses} frozen closes and the loans not called`;
  return null;
}

/** A command's cost is the cash it moved; a rejected one moves none. */
function commandMismatch(state: GameState, cmd: Command, result: CommandResult, cashBefore: number): string | null {
  const moved = cashBefore - state.finance.cash;
  if (result.ok ? moved === result.cost : moved === 0) return null;
  return `${cmd?.type}: ${result.ok ? `cost ${result.cost}` : 'rejected'} but cash moved ${moved}`;
}

describe('long mixed sessions on generated towns', () => {
  it.each(SESSION_SEEDS)(
    'seed %i: every command, consistent books and capex, saves that round-trip',
    (seed) => {
      const state = newGame(seed);
      state.finance.cash = START_CASH * MIXED_CASH_MULTIPLE;
      const books = openBooks(state);
      const problems: string[] = [];
      let roundTrips = 0;
      let closesChecked = 0;
      const lockReasons = new Set<PriceLockReason>();
      const company: Company = { ...state.company };
      const billing = billingChecker();
      // The injected promo to answer at the bot's next look, until one answer has gone through.
      let toAnswer: number | null = null;
      let answered = false;
      const mixed = mixedBot();
      const bot: BotFactory = (botSeed) => {
        const inner = mixed(botSeed);
        return {
          name: inner.name,
          act(s, send) {
            inner.act(s, send);
            if (toAnswer !== null && send({ type: 'answerIncumbent', cabinet: toAnswer }).ok) answered = true;
            toAnswer = null;
          },
        };
      };
      const run = runBot(seed, bot, SESSION_MONTHS, {
        state,
        afterCommand: (s, cmd, result, cashBefore) => {
          const problem = commandMismatch(s, cmd, result, cashBefore) ?? brokenInvariant(s, books);
          if (problem && problems.length < 10) problems.push(`day ${s.day} after ${cmd?.type}: ${problem}`);
          for (const account of s.sales.accounts) for (const lock of account.locks) lockReasons.add(lock.reason);
        },
        afterTick: (s) => {
          if (isFirstOfMonth(s.day) && PROMO_INJECT_CLOSES.includes(s.finance.reports.length) && s.sales.accounts.length > 0) {
            const { cabinet } = ensureIncumbentPromo(s);
            if (!answered) toAnswer = cabinet;
          }
          const problem = brokenInvariant(s, books) ?? billing(s);
          if (problem && problems.length < 10) problems.push(`day ${s.day}: ${problem}`);
          if ((s.company.name !== company.name || s.company.difficulty !== company.difficulty) && problems.length < 10) problems.push(`day ${s.day}: the company changed`);
          for (; closesChecked < s.finance.reports.length; closesChecked++) {
            const closeProblem = brokenCloseInvariant(s.finance.reports[closesChecked] as MonthlyReport);
            if (closeProblem && problems.length < 10) problems.push(`day ${s.day}: ${closeProblem}`);
          }
          if (isFirstOfMonth(s.day) && s.finance.reports.length % ROUND_TRIP_EVERY_MONTHS === 0) {
            const text = serialize(s);
            const loaded = deserialize(text);
            expect(loaded).toEqual(s);
            expect(serialize(loaded)).toBe(text);
            roundTrips++;
          }
        },
      });
      expect(problems).toEqual([]);
      expect(run.gameOver).toBeNull();
      expect(run.reports.length).toBe(SESSION_MONTHS);
      expect(roundTrips).toBeGreaterThanOrEqual(SESSION_MONTHS / ROUND_TRIP_EVERY_MONTHS - 1);
      for (const type of COMMAND_TYPES) expect(run.commands[type] ?? 0, type).toBeGreaterThan(0);
      expect(run.rejected).toBeGreaterThan(0);
      // The session really exercised the economy: subscribers billed, plant removed and re-ordered.
      expect(run.state.sales.connectsTotal).toBeGreaterThan(0);
      expect(run.state.network.makeReady.length).toBeGreaterThan(0);
      // Round 4: grandfathered and passed-on price rises, intro promos, retired tiers, storms; round 4b: retention offers.
      expect([...lockReasons].sort()).toEqual(['grandfather', 'notice', 'promo', 'retention']);
      expect(run.notices.priceStep ?? 0).toBeGreaterThan(0);
      expect(run.notices.tierRetired ?? 0).toBeGreaterThan(0);
      expect(run.notices.storm ?? 0).toBeGreaterThan(0);
      expect(closesChecked).toBe(SESSION_MONTHS);
    },
    LONG_TEST_MS,
  );

  it(
    'replays its commands identically, straight through or with a save and load mid-session',
    () => {
      const seed = SESSION_SEEDS[0] as number;
      const months = 24;
      const fresh = () => {
        const state = newGame(seed);
        state.finance.cash = START_CASH * MIXED_CASH_MULTIPLE;
        return state;
      };
      // Record every command the bot sends (rejected ones too) with its day.
      const log: Array<{ day: number; cmd: Command }> = [];
      const played = runBot(seed, mixedBot(), months, {
        state: fresh(),
        afterCommand: (s, cmd) => log.push({ day: s.day, cmd: JSON.parse(JSON.stringify(cmd)) as Command }),
      });
      expect(log.length).toBeGreaterThan(100);

      const replay = (reloadDay: number | null): GameState => {
        let state = fresh();
        let next = 0;
        while (state.finance.reports.length < months && !state.gameOver) {
          if (state.day === reloadDay) state = deserialize(serialize(state));
          while (next < log.length && log[next]!.day === state.day) applyCommand(state, log[next++]!.cmd);
          tick(state);
        }
        return state;
      };
      const target = hashState(played.state);
      expect(hashState(replay(null))).toBe(target);
      expect(hashState(replay(Math.floor((months * 30) / 2)))).toBe(target);
    },
    LONG_TEST_MS,
  );
});

// ---------------------------------------------------------------------------
// Single-field corruption of a mid-session save
// ---------------------------------------------------------------------------

/** Every fourth lot is a 12-unit apartment building and every other fourth a business. */
const MIXED_LOTS: GridCityOptions['parcelKinds'] = (p) =>
  p.id % 4 === 0 ? { kind: 'mdu', units: 12 } : p.id % 4 === 2 ? { kind: 'smb', units: 1 } : undefined;

/**
 * A small-town mixed session long enough to hold every kind of record: spans
 * at every stage, cabinets with extra splitters, extra OLT cards, make-ready
 * memos, subscribers with building routers, closed months with stats and debt
 * stats, notices and milestones, a credit-line balance and an open term loan.
 */
function midSessionSave(): string {
  const city = makeGridCity({ cols: 3, rows: 3, parcelKinds: MIXED_LOTS });
  const state = newGame(11, { city });
  const run = runBot(11, mixedBot({ minNewUnits: 1 }), 9, { state });
  // Pick up mid-month with plant still in permitting.
  const s = run.state;
  applyCommand(s, { type: 'layCable', segments: city.segments.map((seg) => seg.id), method: 'underground' });
  applyCommand(s, { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: TERM_LOAN_YEARS.at(-1) as TermYears });
  // A credit-line balance too, whatever the bot's own draws and repayments left.
  if (s.debt.credit.balance === 0) applyCommand(s, { type: 'drawCredit', amount: Math.min(LOAN_ROUNDING, creditAvailable(s)) });
  runDays(s, 10);
  return serialize(s);
}

/** Paths into a parsed save; long arrays contribute only their first and last element. */
function savePaths(save: unknown): Array<Array<string | number>> {
  const paths: Array<Array<string | number>> = [];
  const walk = (value: unknown, path: Array<string | number>): void => {
    if (path.length > 0) paths.push(path);
    if (Array.isArray(value)) {
      const picks = value.length <= 2 ? value.map((_, i) => i) : [0, value.length - 1];
      for (const i of picks) walk(value[i], [...path, i]);
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, v] of Object.entries(value)) walk(v, [...path, key]);
    }
  };
  walk(save, []);
  return paths;
}

/** Every command type, then across a month close, on a loaded game. */
function playEveryCommand(state: GameState): void {
  const span = state.network.spans[0]?.id ?? 1;
  const cabinet = state.network.cabinets[0]?.id ?? 1;
  const commands: Command[] = [
    { type: 'layCable', segments: [0, 1, 2], method: 'aerial' },
    { type: 'layCable', segments: [3, 4], method: 'underground' },
    { type: 'placeCabinet', node: 5 },
    { type: 'addSplitter', cabinet },
    { type: 'addOltCard' },
    { type: 'setPricing', tiers: TIER_DEFAULTS.map((t) => ({ id: t.id, price: t.price + 5, offered: true })), smbMultiplier: 2 },
    { type: 'setMarketing', perMonth: 2_000 },
    { type: 'removeSpan', span },
    { type: 'removeCabinet', cabinet },
    { type: 'drawCredit', amount: LOAN_ROUNDING },
    { type: 'repayCredit', amount: LOAN_ROUNDING / 2 },
    { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: TERM_LOAN_YEARS[0] as TermYears },
    { type: 'prepayLoan', loan: state.debt.loans[0]?.id ?? 1, amount: LOAN_ROUNDING },
  ];
  for (const cmd of commands) applyCommand(state, cmd);
  runDays(state, 35);
  getService(state);
}

describe('single-field corruption of a mid-session save', () => {
  it(
    'either rejects the save or loads a game that runs every command with consistent books',
    () => {
      const text = midSessionSave();
      const base = deserialize(text);
      // The save holds every kind of record worth corrupting.
      const stages = new Set(base.network.spans.map((s) => s.stage));
      expect(stages.has('permitting')).toBe(true);
      expect(stages.has('live')).toBe(true);
      expect(base.network.cabinets.length).toBeGreaterThan(0);
      expect(base.sales.accounts.length).toBeGreaterThan(0);
      expect(base.sales.routerParcels.length).toBeGreaterThan(0);
      expect(base.finance.reports.length).toBeGreaterThan(3);
      expect(base.finance.monthToDate.length).toBeGreaterThan(0);
      expect(base.notices.length).toBeGreaterThan(0);
      expect(base.debt.loans.length).toBeGreaterThan(0);
      expect(base.debt.credit.balance).toBeGreaterThan(0);
      expect(base.finance.reports.at(-1)?.debt).toBeDefined();

      const paths = savePaths(JSON.parse(text));
      expect(paths.length).toBeGreaterThan(200);
      const DELETE = Symbol('delete');
      const replacements: unknown[] = [DELETE, null, 'x', -1, 0, 1.5, true, {}, []];
      const failures: string[] = [];
      let loadedCount = 0;
      for (const path of paths) {
        for (const replacement of replacements) {
          // Parsed saves are untyped JSON; poke at them freely.
          const save = JSON.parse(text) as Record<string | number, unknown>;
          const parent = path.slice(0, -1).reduce<any>((node, key) => node[key], save);
          const key = path[path.length - 1] as string | number;
          if (replacement === DELETE) delete parent[key];
          else parent[key] = replacement;
          const label = `${path.join('.')} = ${replacement === DELETE ? '<deleted>' : JSON.stringify(replacement)}`;

          let state: GameState;
          try {
            state = deserialize(JSON.stringify(save));
          } catch (err) {
            if (!(err instanceof SaveError)) failures.push(`${label}: threw ${String(err)}`);
            continue;
          }
          loadedCount++;
          try {
            const books = openBooks(state);
            playEveryCommand(state);
            const problem = brokenInvariant(state, books);
            if (problem) failures.push(`${label}: loaded, then ${problem}`);
            deserialize(serialize(state));
          } catch (err) {
            failures.push(`${label}: loaded, then ${String(err)}`);
          }
          if (failures.length >= 20) break;
        }
      }
      expect(failures).toEqual([]);
      // Plenty of harmless corruptions (a memo, a name, a past month's figure) load and play on.
      expect(loadedCount).toBeGreaterThan(50);
    },
    LONG_TEST_MS,
  );
});
