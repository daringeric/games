// Long seeded random sessions on a grid town, mixing every command type with
// random debt commands (valid and junk), checking the money every step:
//   - the books: opening cash + everything ever posted = cash;
//   - each accepted command's cost is exactly the cash it moved (negated);
//   - a rejected command changes nothing at all;
//   - total debt moves only by proceeds (+), principal entries (-) and, at a
//     close whose payment was missed, capitalized interest (+);
//   - a save mid-session replays identically; nothing throws.

import { describe, expect, it } from 'vitest';
import { MARKETING_MAX_PER_MONTH, START_CASH, TERM_LOAN_MIN, TERM_LOAN_YEARS, TIER_DEFAULTS } from './balance';
import { isFirstOfMonth } from './calendar';
import { creditAvailable, termCapacity, totalDebt } from './debt';
import { applyCommand, newGame, tick } from './game';
import { Rng } from './rng';
import { deserialize, hashState, serialize } from './save';
import { makeGridCity } from './testing/fixtures';
import type { Command, GameState, LedgerCategory } from './types';

/** Apartment buildings and businesses among the homes, so revenue (and borrowing capacity) builds quickly. */
const CITY = makeGridCity({
  cols: 6,
  rows: 4,
  coAt: [3, 2],
  parcelKinds: (p) => (p.id % 4 === 0 ? { kind: 'mdu', units: 12 } : p.id % 4 === 1 ? { kind: 'smb', units: 1 } : undefined),
});

const JUNK: unknown[] = [Number.NaN, -1, 0, 1.5, 1e20, Number.POSITIVE_INFINITY, '500', null, undefined, {}];

/** Every amount ever posted in `categories` (all when omitted): closed months and the open one. */
function posted(state: GameState, categories?: readonly LedgerCategory[]): number {
  let sum = 0;
  for (const report of state.finance.reports) {
    if (!categories) sum += report.net;
    else for (const c of categories) sum += report.totals[c] ?? 0;
  }
  for (const entry of state.finance.monthToDate) if (!categories || categories.includes(entry.category)) sum += entry.amount;
  return sum;
}

/** Debt-moving flows so far: proceeds in (+) and principal repaid (-). */
function debtFlows(state: GameState): number {
  return posted(state, ['loanProceeds', 'principal']);
}

/** A uniform whole number in 1..max (max >= 1). */
function upTo(rng: Rng, max: number): number {
  return rng.int(1, Math.max(1, Math.floor(max)));
}

/**
 * How a session plays: a cap on the random marketing budget, the share of
 * what the bank offers it borrows at most, and the cash below which it orders
 * no plant.
 */
interface Style {
  marketingMax: number;
  borrowShare: number;
  buildAbove: number;
}

/** Borrows a little, builds only from a cushion of cash and keeps marketing modest: still playing years later. */
const PRUDENT: Style = { marketingMax: 3_000, borrowShare: 0.15, buildAbove: START_CASH / 2 };
/** Borrows what is offered and builds on a whim. */
const MIDDLING: Style = { marketingMax: 8_000, borrowShare: 1, buildAbove: 0 };
/** Borrows everything and burns cash on marketing until the loans go unpaid. */
const RECKLESS: Style = { marketingMax: START_CASH / 10, borrowShare: 1, buildAbove: Number.NEGATIVE_INFINITY };

/**
 * One random command, decided from the state and the session's own stream
 * only (so a reloaded copy decides the same).
 */
function randomCommand(state: GameState, rng: Rng, style: Style): Command {
  const { city, network, debt } = state;
  const roll = rng.int(0, 99);
  const junk = (): never => rng.pick(JUNK) as never;
  const building = roll < 23 && state.finance.cash > style.buildAbove;
  if (roll < 23 && !building) return { type: 'setMarketing', perMonth: rng.int(0, Math.min(style.marketingMax, MARKETING_MAX_PER_MONTH)) };
  if (roll < 12) {
    const segments = [rng.int(0, city.segments.length - 1), rng.int(0, city.segments.length - 1)];
    return { type: 'layCable', segments, method: rng.chance(0.5) ? 'aerial' : 'underground' };
  }
  if (roll < 16) return { type: 'placeCabinet', node: rng.int(0, city.nodes.length - 1) };
  if (roll < 17) return { type: 'removeSpan', span: network.spans.length > 0 && rng.chance(0.3) ? rng.pick(network.spans).id : 999 };
  if (roll < 21) return { type: 'addSplitter', cabinet: network.cabinets.length > 0 ? rng.pick(network.cabinets).id : 999 };
  if (roll < 22) return { type: 'removeCabinet', cabinet: network.cabinets.length > 1 && rng.chance(0.3) ? rng.pick(network.cabinets).id : 999 };
  if (roll < 23) return { type: 'addOltCard' };
  if (roll < 26) {
    return {
      type: 'setPricing',
      tiers: TIER_DEFAULTS.map((t) => ({ id: t.id, price: t.price + rng.int(-10, 25), offered: true })),
      smbMultiplier: 1.5,
    };
  }
  if (roll < 29) return { type: 'setMarketing', perMonth: rng.int(0, Math.min(style.marketingMax, MARKETING_MAX_PER_MONTH)) };
  // Financing: mostly sensible amounts, some at or past the edges.
  if (roll < 42) {
    const available = Math.floor(creditAvailable(state) * style.borrowShare);
    return { type: 'drawCredit', amount: available > 0 && rng.chance(0.85) ? upTo(rng, available) : upTo(rng, available + 10_000) };
  }
  if (roll < 52) {
    const most = Math.min(debt.credit.balance, Math.max(0, state.finance.cash));
    return { type: 'repayCredit', amount: most > 0 && rng.chance(0.85) ? upTo(rng, most) : upTo(rng, debt.credit.balance + 1_000) };
  }
  if (roll < 62) {
    const capacity = Math.floor(termCapacity(state) * style.borrowShare);
    const amount = capacity >= TERM_LOAN_MIN && rng.chance(0.8) ? rng.int(TERM_LOAN_MIN, capacity) : upTo(rng, capacity + TERM_LOAN_MIN * 2);
    return { type: 'takeTermLoan', amount, termYears: rng.pick(TERM_LOAN_YEARS) };
  }
  if (roll < 72) {
    if (debt.loans.length === 0) return { type: 'prepayLoan', loan: rng.int(0, 5), amount: upTo(rng, TERM_LOAN_MIN) };
    const loan = rng.pick(debt.loans);
    const amount = rng.chance(0.3) ? loan.balance : upTo(rng, loan.balance * (rng.chance(0.9) ? 1 : 2));
    return { type: 'prepayLoan', loan: loan.id, amount };
  }
  // Junk of every shape.
  switch (rng.int(0, 3)) {
    case 0:
      return { type: 'drawCredit', amount: junk() };
    case 1:
      return { type: 'repayCredit', amount: junk() };
    case 2:
      return { type: 'takeTermLoan', amount: rng.chance(0.5) ? junk() : TERM_LOAN_MIN, termYears: rng.chance(0.5) ? junk() : (6 as never) };
    default:
      return { type: 'prepayLoan', loan: rng.chance(0.5) ? junk() : 1, amount: junk() };
  }
}

interface Tally {
  accepted: Record<string, number>;
  rejected: number;
  missedCloses: number;
  capitalized: number;
  frozenCloses: number;
}

/**
 * The opening of every session: a cabinet at the CO and every street cabled
 * underground, with heavy marketing, so subscribers (and ARR) arrive.
 */
function opening(state: GameState): void {
  const all = state.city.segments.map((s) => s.id);
  expect(applyCommand(state, { type: 'placeCabinet', node: state.city.coNode }).ok).toBe(true);
  expect(applyCommand(state, { type: 'layCable', segments: all, method: 'underground' }).ok).toBe(true);
  expect(applyCommand(state, { type: 'setMarketing', perMonth: Math.min(6_000, MARKETING_MAX_PER_MONTH) }).ok).toBe(true);
  for (let i = 0; i < 3; i++) applyCommand(state, { type: 'addSplitter', cabinet: state.network.cabinets[0]!.id });
}

interface Session {
  state: GameState;
  tally: Tally;
}

/**
 * `days` days of play from a fresh game on CITY: each day a few random
 * commands (each checked), then a tick (checked). `reloadAt` swaps the game
 * for a save-and-load copy of itself at that day.
 */
function session(seed: number, days: number, opts: { style?: Style; reloadAt?: number } = {}): Session {
  let state = newGame(seed, { city: CITY });
  const style = opts.style ?? MIDDLING;
  const openingCash = state.finance.cash;
  const rng = new Rng(seed * 7919 + 1);
  const tally: Tally = { accepted: {}, rejected: 0, missedCloses: 0, capitalized: 0, frozenCloses: 0 };
  opening(state);

  for (let day = 0; day < days && !state.gameOver; day++) {
    if (day === opts.reloadAt) state = deserialize(serialize(state));
    const commands = rng.int(0, 3);
    for (let i = 0; i < commands; i++) {
      const cmd = randomCommand(state, rng, style);
      const before = serialize(state);
      const cash = state.finance.cash;
      const debt = totalDebt(state);
      const flows = debtFlows(state);
      const result = applyCommand(state, cmd);
      if (result.ok) {
        tally.accepted[cmd.type] = (tally.accepted[cmd.type] ?? 0) + 1;
        expect(result.cost, JSON.stringify(cmd)).toBe(cash - state.finance.cash);
        expect(totalDebt(state) - debt, JSON.stringify(cmd)).toBe(debtFlows(state) - flows);
      } else {
        tally.rejected++;
        expect(typeof result.reason).toBe('string');
        expect(serialize(state), JSON.stringify(cmd)).toBe(before);
      }
    }

    const debt = totalDebt(state);
    const flows = debtFlows(state);
    const closing = isFirstOfMonth(state.day + 1);
    tick(state);
    const capitalized = totalDebt(state) - debt - (debtFlows(state) - flows);
    if (closing) {
      const report = state.finance.reports.at(-1)!;
      expect(report.debt).toBeDefined();
      if (report.debt!.missedPayment) {
        tally.missedCloses++;
        expect(capitalized).toBeGreaterThanOrEqual(0);
        tally.capitalized += capitalized;
      } else {
        expect(capitalized).toBe(0);
      }
      if (report.debt!.stage === 'frozen') tally.frozenCloses++;
      expect(report.debt!.creditBalance + report.debt!.termBalance).toBe(totalDebt(state));
    } else {
      expect(capitalized).toBe(0);
    }
    // The books balance every day.
    expect(openingCash + posted(state)).toBe(state.finance.cash);
    expect(Number.isSafeInteger(state.finance.cash)).toBe(true);
  }
  return { state, tally };
}

const SEEDS = [1, 2, 3, 4, 5, 6];
const DAYS = 3 * 365;
/** Long sessions with a save check every day take a few seconds. */
const LONG_TEST_MS = 60_000;

describe('random sessions with debt', () => {
  it(
    'keeps the books, the costs and the debt exact through every command and close',
    () => {
      const totals: Tally = { accepted: {}, rejected: 0, missedCloses: 0, capitalized: 0, frozenCloses: 0 };
      const endings: string[] = [];
      for (const seed of SEEDS) {
        // Prudent, middling and reckless players: some still playing at the end, some in default.
        const { state, tally } = session(seed, DAYS, { style: [PRUDENT, MIDDLING, RECKLESS][seed % 3] });
        for (const [type, n] of Object.entries(tally.accepted)) totals.accepted[type] = (totals.accepted[type] ?? 0) + n;
        totals.rejected += tally.rejected;
        totals.missedCloses += tally.missedCloses;
        totals.capitalized += tally.capitalized;
        totals.frozenCloses += tally.frozenCloses;
        endings.push(state.gameOver?.reason ?? "playing");
        // Whatever happened, the game saves and loads as itself.
        expect(deserialize(serialize(state))).toEqual(state);
      }
      // The sessions really exercised the bank: every debt command was accepted and rejected along the way...
      for (const type of ['drawCredit', 'repayCredit', 'takeTermLoan', 'prepayLoan', 'placeCabinet', 'addSplitter', 'setPricing', 'setMarketing']) {
        expect(totals.accepted[type] ?? 0, type).toBeGreaterThan(0);
      }
      expect(totals.rejected).toBeGreaterThan(100);
      // ...and the covenants, a missed payment and a default all happened somewhere.
      expect(totals.frozenCloses).toBeGreaterThan(0);
      expect(totals.missedCloses).toBeGreaterThan(0);
      expect(totals.capitalized).toBeGreaterThan(0);
      expect(endings).toContain('default');
      // ...while the prudent players were still in business at the end.
      expect(endings).toContain('playing');
    },
    LONG_TEST_MS,
  );

  it(
    'replays identically, straight or through a save and load mid-session',
    () => {
      const runs: Array<[number, Style, number]> = [
        [3, PRUDENT, 403],
        [2, MIDDLING, 77],
        [4, RECKLESS, 45],
      ];
      for (const [seed, style, reloadAt] of runs) {
        const straight = session(seed, 2 * 365, { style });
        // The reload lands while the game is still on.
        expect(straight.state.gameOver === null || straight.state.gameOver.day > reloadAt).toBe(true);
        const again = session(seed, 2 * 365, { style });
        const reloaded = session(seed, 2 * 365, { style, reloadAt });
        expect(hashState(again.state)).toBe(hashState(straight.state));
        expect(hashState(reloaded.state)).toBe(hashState(straight.state));
        expect(straight.tally.accepted.takeTermLoan ?? 0).toBeGreaterThan(0);
      }
    },
    LONG_TEST_MS,
  );
});
