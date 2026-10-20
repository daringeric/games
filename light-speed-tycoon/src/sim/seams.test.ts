// Round-2 seams across modules: players' schemaVersion 1 saves keep playing
// under the round-2 rules (sales, overhead, reach, ports), the books and capex
// stay consistent the whole way, and a seed plus commands replays identically
// with the sales stream in play, through saves.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MARKETING_DEFAULT_PER_MONTH, TIER_DEFAULTS } from './balance';
import { applyCommand, runDays } from './game';
import { computeService, getService, ponPortsUsed } from './network';
import { cabinetPortCapacity, cabinetPortsUsed, subscriberUnits, TIER_IDS } from './sales';
import { deserialize, hashState, serialize } from './save';
import { segmentsAtNode } from './streets';
import type { Command, GameState, StreetSegment } from './types';

/** Saves written by the round-1 (schemaVersion 1) build, frozen before round 2 began. */
function v1Fixture(name: 'v1-grid' | 'v1-town'): string {
  return readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8');
}

/** Every amount ever posted, closed months and the open one. */
function postedTotal(state: GameState): number {
  return (
    state.finance.reports.reduce((sum, r) => sum + r.net, 0) + state.finance.monthToDate.reduce((sum, e) => sum + e.amount, 0)
  );
}

function postedIn(state: GameState, categories: readonly string[]): number {
  const closed = state.finance.reports.reduce((sum, r) => sum + categories.reduce((t, c) => t + ((r.totals as Record<string, number>)[c] ?? 0), 0), 0);
  const open = state.finance.monthToDate.filter((e) => categories.includes(e.category)).reduce((sum, e) => sum + e.amount, 0);
  return closed + open;
}

/**
 * A month of sensible play, decided from the state alone (so two copies of a
 * game get the same commands): cable the uncabled streets touching the plant
 * underground in one order, a cabinet at the CO if there is none, a splitter
 * wherever signups are being turned away, and a price and marketing nudge.
 */
function monthOfCommands(state: GameState, month: number): Command[] {
  const { city, network } = state;
  const cabled = new Set(network.spans.map((s) => s.segment));
  const reached = new Set([city.coNode]);
  for (const span of network.spans) {
    const seg = city.segments[span.segment] as StreetSegment;
    reached.add(seg.a);
    reached.add(seg.b);
  }
  const next = new Set<number>();
  for (const node of [...reached].sort((a, b) => a - b)) {
    for (const id of segmentsAtNode(city, node)) {
      if (!cabled.has(id) && next.size < 6) next.add(id);
    }
  }
  const commands: Command[] = [];
  if (next.size > 0) commands.push({ type: 'layCable', segments: [...next], method: 'underground' });
  if (!network.cabinets.some((c) => c.node === city.coNode)) commands.push({ type: 'placeCabinet', node: city.coNode });
  for (const id of state.sales.fullCabinets) commands.push({ type: 'addSplitter', cabinet: id });
  if (month === 2) {
    commands.push({
      type: 'setPricing',
      tiers: TIER_IDS.map((id, i) => ({ id, price: (TIER_DEFAULTS[i]?.price ?? 50) + 5, offered: true })),
      smbMultiplier: 2,
    });
  }
  if (month === 3) commands.push({ type: 'setMarketing', perMonth: MARKETING_DEFAULT_PER_MONTH * 3 });
  return commands;
}

interface Played {
  state: GameState;
  ok: number;
}

/** A year of monthOfCommands on `state`, checking the books, capex, ports and service every month. */
function playYear(state: GameState, opts: { reloadAtMonth?: number } = {}): Played {
  const openingCash = state.finance.cash - postedTotal(state);
  const capexBase = { plant: state.finance.capex.osp + state.finance.capex.co + postedIn(state, ['construction', 'equipment', 'refund']) };
  let ok = 0;
  for (let month = 0; month < 12; month++) {
    if (opts.reloadAtMonth === month) state = deserialize(serialize(state));
    for (const cmd of monthOfCommands(state, month)) {
      const cash = state.finance.cash;
      const result = applyCommand(state, cmd);
      if (result.ok) {
        ok++;
        expect(cash - state.finance.cash).toBe(result.cost);
      }
    }
    runDays(state, 30);
    expect(state.gameOver).toBeNull();

    // The books: the opening balance plus every posted amount is today's cash.
    expect(openingCash + postedTotal(state)).toBe(state.finance.cash);
    // Capex moves with its ledger entries (v1 plant capex was rebuilt from the v1 ledger).
    expect(state.finance.capex.osp + state.finance.capex.co + postedIn(state, ['construction', 'equipment', 'refund'])).toBe(capexBase.plant);
    expect(state.finance.capex.connect).toBe(-postedIn(state, ['install']));
    // Ports: accounts within each cabinet's splitters, splitters within the OLT.
    const used = cabinetPortsUsed(state);
    for (const cabinet of state.network.cabinets) expect(used.get(cabinet.id) ?? 0).toBeLessThanOrEqual(cabinetPortCapacity(cabinet));
    expect(ponPortsUsed(state)).toBeLessThanOrEqual(state.network.olt.ponPorts);
    // Subscribers only where the plant passes them, on the cabinet they joined.
    const service = getService(state);
    expect(service.passings).toBe(computeService(state).passings);
    for (const account of state.sales.accounts) {
      expect(service.activeCabinets.has(account.cabinet)).toBe(true);
      expect(service.litSegments.has(state.city.parcels[account.parcel]!.segment)).toBe(true);
    }
  }
  return { state, ok };
}

describe('schemaVersion 1 saves under the round-2 rules', () => {
  it.each(['v1-grid', 'v1-town'] as const)('the frozen %s save plays a year of round-2 commands with consistent books', (name) => {
    const migrated = deserialize(v1Fixture(name));
    const reportsBefore = migrated.finance.reports.length;
    const { state, ok } = playYear(migrated);

    expect(ok).toBeGreaterThan(3);
    // Twelve more closes, each with round-2 stats; the migrated ones keep none.
    expect(state.finance.reports.length).toBeGreaterThanOrEqual(reportsBefore + 11);
    expect(state.finance.reports.slice(0, reportsBefore).every((r) => r.stats === undefined)).toBe(true);
    expect(state.finance.reports.slice(reportsBefore).every((r) => r.stats !== undefined)).toBe(true);
    // Sales ran on the migrated plant: subscribers signed up, billed and churned.
    expect(subscriberUnits(state)).toBeGreaterThan(0);
    expect(state.finance.reports.some((r) => (r.totals.revenue ?? 0) > 0)).toBe(true);
    expect(state.finance.reports.slice(reportsBefore).every((r) => (r.totals.overhead ?? 0) < 0)).toBe(true);
    expect(state.milestones.map((m) => m.id)).toContain('firstLight');
    // And it still saves and loads as the same game.
    expect(serialize(deserialize(serialize(state)))).toBe(serialize(state));
  });

  it.each(['v1-grid', 'v1-town'] as const)('the migrated %s save replays identically, straight or through a save mid-year', (name) => {
    const straight = playYear(deserialize(v1Fixture(name))).state;
    const again = playYear(deserialize(v1Fixture(name))).state;
    const reloaded = playYear(deserialize(v1Fixture(name)), { reloadAtMonth: 5 }).state;
    expect(hashState(again)).toBe(hashState(straight));
    expect(hashState(reloaded)).toBe(hashState(straight));
    expect(straight.sales.connectsTotal).toBeGreaterThan(0);
  });

});
