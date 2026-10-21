// Cross-module integration: long bot-driven sessions on generated towns, checking
// the seams between game, network, finance and save every simulated day.

import { describe, expect, it } from 'vitest';
import { MARKETING_MAX_PER_MONTH, START_CASH, STORM_LOG_DAYS, TIER_PRICE_MAX, TIER_PRICE_MIN } from './balance';
import { isFirstOfMonth } from './calendar';
import { monthlyPoleRent } from './finance';
import { applyCommand, newGame, tick } from './game';
import { computeService, getService, ponPortsUsed } from './network';
import { Rng } from './rng';
import { cabinetPortCapacity, cabinetPortsUsed, TIER_IDS } from './sales';
import { deserialize, hashState, serialize } from './save';
import { otherEnd, segmentsAtNode, shortestPath } from './streets';
import type { CableMethod, Command, GameState, NodeId, ServiceSnapshot, StreetSegment } from './types';

const TWO_YEARS = 730;
/** Two built-out years with a fresh service computation every day take a few seconds. */
const LONG_TEST_MS = 60_000;
/** Cash for the two-year sessions: the bot spends whatever it has, so plenty keeps it solvent all the way. */
const AMPLE_CASH = START_CASH * 10;

/** A generated-town game whose bot can afford two full years. */
function richGame(seed: number): GameState {
  const state = newGame(seed);
  state.finance.cash = AMPLE_CASH;
  return state;
}

interface Tally {
  ok: Record<string, number>;
  rejected: number;
  removedByStage: Record<string, number>;
  /** Days on which passings rose with no change to the network: town growth on lit streets. */
  growthDays: number;
  reports: number;
  monthsWithSubscribers: number;
  gameOvers: number;
  /** Cash before the session's first day (the books' opening balance). */
  startCash: number | null;
}

function emptyTally(): Tally {
  return { ok: {}, rejected: 0, removedByStage: {}, growthDays: 0, reports: 0, monthsWithSubscribers: 0, gameOvers: 0, startCash: null };
}

/** The mutable part of a game: everything but the immutable city. */
function dynamic(state: GameState): string {
  const { city: _city, ...rest } = state;
  return JSON.stringify(rest);
}

/** Connect capex implied by every install amount ever posted (closed months and the open one). */
function installCapex(state: GameState): number {
  const closed = state.finance.reports.reduce((sum, r) => sum + (r.totals.install ?? 0), 0);
  const open = state.finance.monthToDate.filter((e) => e.category === 'install').reduce((sum, e) => sum + e.amount, 0);
  return 0 - (closed + open);
}

/** Plant capex implied by every construction, equipment and refund amount ever posted. */
function plantCapex(state: GameState): number {
  const categories = ['construction', 'equipment', 'refund'] as const;
  const closed = state.finance.reports.reduce((sum, r) => sum + categories.reduce((t, c) => t + (r.totals[c] ?? 0), 0), 0);
  const open = state.finance.monthToDate.filter((e) => (categories as readonly string[]).includes(e.category)).reduce((sum, e) => sum + e.amount, 0);
  return 0 - (closed + open);
}

/** Port accounting: accounts within each cabinet's splitter ports, splitters within the OLT's PON ports. */
function expectPortsWithinCapacity(state: GameState): void {
  const used = cabinetPortsUsed(state);
  for (const cabinet of state.network.cabinets) {
    expect(used.get(cabinet.id) ?? 0).toBeLessThanOrEqual(cabinetPortCapacity(cabinet));
  }
  expect(ponPortsUsed(state)).toBeLessThanOrEqual(state.network.olt.ponPorts);
}

/**
 * Weather seams (round 4): outages only on live spans, rebuilds only on live
 * aerial ones; interrupted streets are lit streets (and the memo agrees with a
 * fresh computation); the storm log is ordered and recent; the open month's
 * outage days are sorted, one per segment, and its repairs are its 'repair'
 * entries.
 */
function expectWeatherConsistent(state: GameState, memo: ServiceSnapshot, fresh: ServiceSnapshot): void {
  for (const span of state.network.spans) {
    if (span.outage) {
      expect(span.stage).toBe('live');
      expect(span.outage.daysLeft).toBeGreaterThanOrEqual(1);
    }
    if (span.conversion) expect([span.stage, span.method]).toEqual(['live', 'aerial']);
  }
  expect([...memo.interruptedSegments].sort((a, b) => a - b)).toEqual([...fresh.interruptedSegments].sort((a, b) => a - b));
  for (const segment of memo.interruptedSegments) expect(memo.litSegments.has(segment)).toBe(true);
  const { storms, nextStormId, month } = state.weather;
  for (let i = 0; i < storms.length; i++) {
    const storm = storms[i]!;
    expect(storm.id).toBeLessThan(nextStormId);
    if (i > 0) expect(storm.id).toBeGreaterThan(storms[i - 1]!.id);
    expect(state.day - storm.day).toBeLessThan(STORM_LOG_DAYS);
  }
  const segments = month.segmentOutageDays.map((e) => e.segment);
  expect(segments).toEqual([...new Set(segments)].sort((a, b) => a - b));
  expect(month.segmentOutageDays.every((e) => e.days >= 1 && e.days <= 31)).toBe(true);
  const repairs = 0 - state.finance.monthToDate.filter((e) => e.category === 'repair').reduce((sum, e) => sum + e.amount, 0);
  expect(month.repairs).toBe(repairs);
}

/** Corners the player's plant already reaches (plus the CO). */
function reachedNodes(state: GameState): NodeId[] {
  const nodes = new Set<NodeId>([state.city.coNode]);
  for (const span of state.network.spans) {
    const seg = state.city.segments[span.segment] as StreetSegment;
    nodes.add(seg.a);
    nodes.add(seg.b);
  }
  return [...nodes].sort((a, b) => a - b);
}

/** A random walk of `steps` street segments from `from`. */
function wander(state: GameState, rng: Rng, from: NodeId, steps: number): NodeId {
  let node = from;
  for (let i = 0; i < steps; i++) {
    const out = segmentsAtNode(state.city, node);
    if (out.length === 0) break;
    node = otherEnd(state.city.segments[rng.pick(out)] as StreetSegment, node);
  }
  return node;
}

/**
 * A player bot with its own Rng (never the game's). Mostly grows the plant out
 * from what it already reaches, sometimes over-reaches, cancels, or sends junk.
 */
function botCommand(state: GameState, rng: Rng): Command {
  const { city } = state;
  const roll = rng.next();
  const method: CableMethod = rng.chance(0.55) ? 'aerial' : 'underground';
  if (roll < 0.5) {
    const from = rng.pick(reachedNodes(state));
    const to = wander(state, rng, from, rng.int(1, 8));
    return { type: 'layCable', segments: shortestPath(city, from, to) ?? [], method };
  }
  if (roll < 0.58) {
    // A cross-town order: often too expensive or blocked by missing poles.
    const from = rng.pick(reachedNodes(state));
    return { type: 'layCable', segments: shortestPath(city, from, rng.int(0, city.nodes.length - 1)) ?? [], method };
  }
  if (roll < 0.7) return { type: 'placeCabinet', node: rng.pick(reachedNodes(state)) };
  if (roll < 0.8 && state.network.spans.length > 0) return { type: 'removeSpan', span: rng.pick(state.network.spans).id };
  if (roll < 0.84) {
    // Mostly sensible prices, sometimes out of range (rejected).
    const tiers = TIER_IDS.map((id) => ({ id, price: rng.int(TIER_PRICE_MIN - 5, TIER_PRICE_MAX / 2), offered: rng.chance(0.8) }));
    return { type: 'setPricing', tiers, smbMultiplier: 1 + rng.int(0, 30) / 10 };
  }
  if (roll < 0.88) return { type: 'setMarketing', perMonth: rng.int(-1_000, MARKETING_MAX_PER_MONTH / 4) };
  if (roll < 0.91 && state.network.cabinets.length > 0) return { type: 'addSplitter', cabinet: rng.pick(state.network.cabinets).id };
  // Only thin out a plant with cabinets to spare.
  if (roll < 0.92 && state.network.cabinets.length > 2) return { type: 'removeCabinet', cabinet: rng.pick(state.network.cabinets).id };
  if (roll < 0.93) return { type: 'addOltCard' };
  if (roll < 0.95) {
    // Rebuild a span underground: usually a live aerial one, sometimes one that cannot be (rejected).
    const aerial = state.network.spans.filter((s) => s.method === 'aerial' && s.stage === 'live' && s.conversion === null);
    const pool = aerial.length > 0 && rng.chance(0.8) ? aerial : state.network.spans;
    if (pool.length > 0) return { type: 'convertSpan', span: rng.pick(pool).id };
  }
  const junk: unknown[] = [
    { type: 'layCable', segments: [city.segments.length], method: 'aerial' },
    { type: 'layCable', segments: [], method: 'underground' },
    { type: 'layCable', segments: [0], method: 'laser' },
    { type: 'layCable', segments: '1,2', method: 'aerial' },
    { type: 'placeCabinet', node: -1 },
    { type: 'placeCabinet', node: 1.5 },
    { type: 'removeSpan', span: state.nextId + 7 },
    { type: 'teleport' },
    null,
  ];
  return rng.pick(junk) as Command;
}

/** Play from state.day up to `untilDay`, checking every seam along the way. */
function play(state: GameState, bot: Rng, untilDay: number, tally: Tally): void {
  if (state.finance.reports.length === 0 && state.day === 0) tally.startCash ??= state.finance.cash;
  while (state.day < untilDay && !state.gameOver) {
    const orders = bot.int(0, 3);
    for (let i = 0; i < orders; i++) {
      const cmd = botCommand(state, bot);
      const before = dynamic(state);
      const cash = state.finance.cash;
      const target = cmd && cmd.type === 'removeSpan' ? state.network.spans.find((s) => s.id === cmd.span) : undefined;
      const result = applyCommand(state, cmd);
      if (!result.ok) {
        tally.rejected++;
        expect(result.reason.length).toBeGreaterThan(0);
        // A rejected command leaves the game, its RNG included, exactly as it was.
        expect(dynamic(state)).toBe(before);
        continue;
      }
      const kind = cmd.type === 'layCable' ? `${cmd.type}:${cmd.method}` : cmd.type;
      tally.ok[kind] = (tally.ok[kind] ?? 0) + 1;
      if (target) tally.removedByStage[target.stage] = (tally.removedByStage[target.stage] ?? 0) + 1;
      // `cost` is the net spend: what left the bank (negative for a refund).
      expect(cash - state.finance.cash).toBe(result.cost);
      // Capex moves with its ledger entry: plant (osp + co) and connections.
      expect(state.finance.capex.osp + state.finance.capex.co).toBe(plantCapex(state));
      expect(ponPortsUsed(state)).toBeLessThanOrEqual(state.network.olt.ponPorts);
      // Spending needs the cash up front; a refund can leave an overdraft negative.
      if (result.cost > 0) expect(state.finance.cash).toBeGreaterThanOrEqual(0);
    }

    const days = bot.int(1, 12);
    for (let d = 0; d < days && state.day < untilDay && !state.gameOver; d++) {
      const reportsBefore = state.finance.reports.length;
      const versionBefore = state.network.version;
      const passingsBefore = getService(state).passings;
      const rentBefore = monthlyPoleRent(state);
      tick(state);

      // getService is memoized on network version and day; parcels appear by day,
      // so it must always agree with a fresh computation.
      const fresh = computeService(state);
      const memo = getService(state);
      expect(memo.day).toBe(state.day);
      expect(memo.passings).toBe(fresh.passings);
      expect(memo.passedParcels).toEqual(fresh.passedParcels);
      expect([...memo.litSegments].sort((a, b) => a - b)).toEqual([...fresh.litSegments].sort((a, b) => a - b));
      if (state.network.version === versionBefore && memo.passings > passingsBefore) tally.growthDays++;
      // Connect capex is exactly what the install entries paid.
      expect(state.finance.capex.connect).toBe(installCapex(state));
      // Subscribers only where the plant passes them, on active cabinets, within ports.
      for (const account of state.sales.accounts) {
        expect(memo.activeCabinets.has(account.cabinet)).toBe(true);
        expect(memo.litSegments.has(state.city.parcels[account.parcel]!.segment)).toBe(true);
      }
      expectPortsWithinCapacity(state);
      expect(state.finance.capex.osp + state.finance.capex.co).toBe(plantCapex(state));
      expectWeatherConsistent(state, memo, fresh);
      if (state.gameOver) {
        // Only a month close ends the game, and it stops that day cold.
        expect(isFirstOfMonth(state.day)).toBe(true);
        tally.gameOvers++;
      }

      if (!isFirstOfMonth(state.day)) {
        expect(state.finance.reports.length).toBe(reportsBefore);
        continue;
      }
      expect(state.finance.reports.length).toBe(reportsBefore + 1);
      tally.reports++;
      const report = state.finance.reports.at(-1)!;
      expect(report.stats).toBeDefined();
      expect(report.stats!.accounts).toBeLessThanOrEqual(report.stats!.subscribers);
      expect(report.stats!.ponPortsUsed).toBeLessThanOrEqual(report.stats!.ponPorts);
      // Captured at the close, before the new day's installs.
      expect(report.stats!.capexConnect).toBe(0 - state.finance.reports.reduce((sum, r) => sum + (r.totals.install ?? 0), 0));
      if (report.stats!.subscribers > 0) tally.monthsWithSubscribers++;
      const prevCash = state.finance.reports.at(-2)?.cashEnd ?? tally.startCash;
      if (prevCash === null) throw new Error('play() must start at day 0 for its first report');
      // After the close only the new day's installs (and its storm repairs) have posted.
      expect(state.finance.monthToDate.every((e) => (e.category === 'install' || e.category === 'repair') && e.day === state.day)).toBe(true);
      // The month's repairs are its 'repair' entries.
      expect(report.ops?.repairs).toBe(0 - (report.totals.repair ?? 0));
      const sinceClose = state.finance.monthToDate.reduce((sum, e) => sum + e.amount, 0);
      expect(report.cashEnd).toBe(state.finance.cash - sinceClose);
      expect(report.cashEnd - prevCash).toBe(report.net);
      expect(Object.values(report.totals).reduce((a, b) => a + (b ?? 0), 0)).toBe(report.net);
      // Passings and pole rent are taken as the month ended: before the new day's
      // network progress and town growth.
      expect(report.passings).toBe(passingsBefore);
      expect((report.totals.poleRent ?? 0) + rentBefore).toBe(0);

      // Every month-end save must load back to the identical game.
      const json = serialize(state);
      const loaded = deserialize(json);
      expect(serialize(loaded)).toBe(json);
      expect(getService(loaded).passings).toBe(fresh.passings);
    }
  }
}

describe('two-year sessions on generated towns', () => {
  for (const seed of [1, 2027, 424_242]) {
    it(`seed ${seed}: plays 730 days of mixed commands with consistent books, service, sales and saves`, () => {
      const state = richGame(seed);
      const tally = emptyTally();
      play(state, new Rng(seed ^ 0x5eed), TWO_YEARS, tally);

      expect(state.gameOver).toBeNull();
      expect(state.day).toBe(TWO_YEARS);
      expect(state.finance.reports).toHaveLength(24);
      expect(tally.reports).toBe(24);
      expect(state.finance.reports.at(-1)).toMatchObject({ year: 2028, month: 12 });
      expect(state.finance.reports.every((r) => r.stats !== undefined)).toBe(true);

      // The books balance: start cash plus every posted amount is today's cash.
      const closed = state.finance.reports.reduce((sum, r) => sum + r.net, 0);
      const open = state.finance.monthToDate.reduce((sum, e) => sum + e.amount, 0);
      expect(AMPLE_CASH + closed + open).toBe(state.finance.cash);
      expect(state.finance.capex.connect).toBe(installCapex(state));

      // The bot really exercised every path, so the checks above are not vacuous.
      expect(tally.ok['layCable:aerial'] ?? 0).toBeGreaterThan(5);
      expect(tally.ok['layCable:underground'] ?? 0).toBeGreaterThan(5);
      expect(tally.ok.placeCabinet ?? 0).toBeGreaterThan(0);
      expect(tally.ok.removeSpan ?? 0).toBeGreaterThan(3);
      expect(tally.ok.setPricing ?? 0).toBeGreaterThan(0);
      expect(tally.ok.setMarketing ?? 0).toBeGreaterThan(0);
      expect(tally.ok.addSplitter ?? 0).toBeGreaterThan(0);
      expect(tally.rejected).toBeGreaterThan(10);
      expect(Object.keys(tally.removedByStage).length).toBeGreaterThanOrEqual(2);
      expect(state.network.spans.filter((s) => s.stage === 'live').length).toBeGreaterThan(10);
      // The bot cancels and removes plant too, so it may end dark; it must have lit homes on the way.
      expect(Math.max(...state.finance.reports.map((r) => r.passings))).toBeGreaterThan(0);
      expect(state.finance.reports.some((r) => (r.totals.poleRent ?? 0) < 0)).toBe(true);
      // Sales ran: subscribers billed, connected and churned.
      expect(tally.monthsWithSubscribers).toBeGreaterThan(6);
      expect(state.finance.reports.some((r) => (r.totals.revenue ?? 0) > 0)).toBe(true);
      expect(state.finance.reports.some((r) => (r.totals.install ?? 0) < 0)).toBe(true);
      expect(state.sales.connectsTotal).toBeGreaterThan(0);
      expect(state.milestones.map((m) => m.id)).toContain('firstLight');
      // Storm season (the second year) came with the weather on: storms, and the bot's rebuilds.
      expect(state.finance.reports.reduce((sum, r) => sum + (r.ops?.storms ?? 0), 0)).toBeGreaterThan(0);
      expect(tally.ok.convertSpan ?? 0).toBeGreaterThan(0);

      // The final save loads, and keeps playing like the original.
      const loaded = deserialize(serialize(state));
      tick(loaded);
      tick(state);
      expect(hashState(loaded)).toBe(hashState(state));
    }, LONG_TEST_MS);
  }

  it('ends an over-spending session at a month close and freezes it, through a save', () => {
    // A tight purse: the bot spends it down and the fixed costs do the rest.
    const state = newGame(2027);
    state.finance.cash = Math.round(START_CASH / 8);
    const tally = emptyTally();
    play(state, new Rng(99), TWO_YEARS * 2, tally);
    expect(state.gameOver).not.toBeNull();
    expect(tally.gameOvers).toBe(1);
    const over = state.gameOver!;
    expect(over).toMatchObject({ day: state.day, reason: 'insolvent' });
    expect(isFirstOfMonth(over.day)).toBe(true);
    expect(state.finance.cash).toBeLessThan(0);
    expect(state.notices.at(-1)).toMatchObject({ kind: 'gameOver', day: over.day });
    // Every negative close before the last one warned.
    const warnings = state.notices.filter((n) => n.kind === 'insolvencyWarning' && n.message.startsWith('Cash is below zero'));
    expect(warnings.length).toBeGreaterThan(0);

    // Frozen: no days pass, every command bounces, and a save keeps it that way.
    const loaded = deserialize(serialize(state));
    expect(loaded.gameOver).toEqual(over);
    for (const game of [state, loaded]) {
      const before = serialize(game);
      tick(game);
      expect(applyCommand(game, { type: 'setMarketing', perMonth: 0 }).ok).toBe(false);
      expect(applyCommand(game, { type: 'placeCabinet', node: game.city.coNode }).ok).toBe(false);
      expect(serialize(game)).toBe(before);
    }
  }, LONG_TEST_MS);

  it('lights homes that appear on already-lit streets without any network change', () => {
    // Found by search over seeds: plant that stays fixed while the town grows.
    let found = false;
    for (const seed of [1, 2027, 424_242, 7, 99]) {
      const state = richGame(seed);
      const tally = emptyTally();
      play(state, new Rng(seed ^ 0x5eed), TWO_YEARS, tally);
      if (tally.growthDays > 0) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  }, LONG_TEST_MS);

  it('replays identically through a save and load at the one-year mark', () => {
    const seed = 2027;
    // Both runs stop at day 365 so the bot's schedule matches; only the save differs.
    const straight = richGame(seed);
    const straightBot = new Rng(77);
    const straightTally = emptyTally();
    play(straight, straightBot, 365, straightTally);
    play(straight, straightBot, TWO_YEARS, straightTally);

    const bot = new Rng(77);
    const tally = emptyTally();
    let reloaded = richGame(seed);
    play(reloaded, bot, 365, tally);
    reloaded = deserialize(serialize(reloaded));
    play(reloaded, bot, TWO_YEARS, tally);

    expect(straight.sales.connectsTotal).toBeGreaterThan(0);
    expect(reloaded.finance.reports).toEqual(straight.finance.reports);
    expect(hashState(reloaded)).toBe(hashState(straight));
  }, LONG_TEST_MS);
});
