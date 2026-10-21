// Round-4 seams across modules, through real play (commands and daily ticks):
// every frozen save (v1, v2 and v3) migrates and then plays a year of
// round-4 play (a grandfathered price rise, an intro promo, an aerial span
// rebuilt underground, a tier retired) with storms on; at every close the
// books balance, the game saves and loads as itself, the close's records
// hang together (report.ops, the notice cursor, outages and rebuilds only
// where the rules allow them), the briefing shows the figures the report,
// the HUD and the Bank show, and every suggestion the advisor makes is safe
// on its own and together with the others. Replays are identical, and an
// operator who follows every suggestion for a year never ends up worse off
// with the bank than one who ignores them.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PROMO_MAX_MONTHS, PROMO_MAX_PERCENT_OFF, TIER_PRICE_MAX } from './balance';
import { advicePlans, ADVICE_ORDER, buildBriefing } from './advisor';
import type { AdvicePlan } from './advisor';
import { covenantMetrics, estimateNextDebtService, totalDebt } from './debt';
import { runwayMonths } from './finance';
import { applyCommand, tick } from './game';
import { quoteConvert } from './network';
import { deserialize, hashState, serialize } from './save';
import type { Command, CovenantStage, GameState, MonthlyReport } from './types';

type Fixture = 'v1-grid' | 'v1-town' | 'v2-grid' | 'v2-town' | 'v3-grid' | 'v3-town';
const FIXTURES: readonly Fixture[] = ['v1-grid', 'v1-town', 'v2-grid', 'v2-town', 'v3-grid', 'v3-town'];

/** Commands that borrow or repay (their plans must leave the covenants compliant). */
const FINANCING = new Set<Command['type']>(['drawCredit', 'repayCredit', 'takeTermLoan', 'prepayLoan']);

const STAGE_RANK: Record<CovenantStage, number> = { compliant: 0, warning: 1, penalty: 2, frozen: 3 };

/** A frozen save from an earlier build, migrated to the current schema. */
function fixture(name: Fixture): GameState {
  return deserialize(readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8'));
}

const clone = (state: GameState): GameState => deserialize(serialize(state));

/** Tick until a month closes (or the game ends); the report that close wrote, or null if the game ended first. */
function closeNext(state: GameState): MonthlyReport | null {
  const count = state.finance.reports.length;
  for (let i = 0; i < 40 && !state.gameOver; i++) {
    tick(state);
    if (state.finance.reports.length > count) return state.finance.reports.at(-1)!;
  }
  if (state.gameOver) return null;
  throw new Error('no close within 40 days');
}

/** Everything ever posted: closed months' net and the open month's entries. */
function posted(state: GameState): number {
  let sum = 0;
  for (const report of state.finance.reports) sum += report.net;
  for (const e of state.finance.monthToDate) sum += e.amount;
  return sum;
}

/**
 * Each plan's commands succeed on a copy; one that borrows or repays leaves
 * the covenants compliant; the cash left (less what the plan spends later)
 * covers the next debt service and what the plan promises to keep. Then the
 * same for all plans together, in rule order.
 */
function expectPlansSafe(state: GameState, plans: readonly AdvicePlan[], label: string): void {
  const check = (after: GameState, list: readonly AdvicePlan[], what: string) => {
    let extra = 0;
    for (const p of list) {
      for (const command of p.commands) expect(applyCommand(after, command), `${what}: ${JSON.stringify(command)}`).toMatchObject({ ok: true });
      extra += p.extraSpend;
    }
    if (list.some((p) => p.commands.some((c) => FINANCING.has(c.type)))) expect(covenantMetrics(after).compliant, `${what} compliant`).toBe(true);
    if (list.some((p) => p.commands.length > 0)) {
      expect(after.finance.cash - extra, `${what} keeps the next payment`).toBeGreaterThanOrEqual(estimateNextDebtService(after));
      for (const p of list) expect(after.finance.cash - extra, `${what} keeps ${p.advice.id}'s promise`).toBeGreaterThanOrEqual(p.keep);
    }
  };
  for (const p of plans) check(clone(state), [p], `${label} ${p.advice.id}`);
  const ordered = [...plans].sort((a, b) => ADVICE_ORDER.indexOf(a.advice.id) - ADVICE_ORDER.indexOf(b.advice.id));
  check(clone(state), ordered, `${label} together`);
}

/** The round-4 commands sent after the given close of the year (1-based), when they apply. */
function roundFourMoves(state: GameState, close: number): void {
  const pricing = state.sales.pricing;
  if (close === 1) {
    // A rise on the top offered tier, grandfathered for three closes.
    const top = [...pricing.tiers].reverse().find((t) => t.offered);
    if (top) {
      const tiers = pricing.tiers.map((t) => ({ ...t, price: t === top ? Math.min(TIER_PRICE_MAX, t.price + 10) : t.price }));
      expect(applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: pricing.smbMultiplier, grandfatherMonths: 3 }).ok).toBe(true);
    }
  } else if (close === 2) {
    expect(applyCommand(state, { type: 'setPromo', promo: { percentOff: Math.min(20, PROMO_MAX_PERCENT_OFF), months: Math.min(3, PROMO_MAX_MONTHS) } }).ok).toBe(true);
  } else if (close === 4) {
    // Rebuild the first live aerial span underground when cash allows.
    for (const span of state.network.spans) {
      if (span.method !== 'aerial' || span.stage !== 'live' || span.conversion !== null) continue;
      if (quoteConvert(state, span.id).ok) expect(applyCommand(state, { type: 'convertSpan', span: span.id }).ok).toBe(true);
      break;
    }
  } else if (close === 6) {
    // Retire the cheapest offered tier while another stays offered: its subscribers move or cancel at the next close.
    const offered = pricing.tiers.filter((t) => t.offered);
    if (offered.length > 1) {
      const cheapest = offered.reduce((a, b) => (b.price < a.price ? b : a));
      const tiers = pricing.tiers.map((t) => ({ ...t, offered: t === cheapest ? false : t.offered }));
      expect(applyCommand(state, { type: 'setPricing', tiers, smbMultiplier: pricing.smbMultiplier }).ok).toBe(true);
    }
  } else if (close === 8) {
    expect(applyCommand(state, { type: 'setPromo', promo: null }).ok).toBe(true);
  }
}

interface YearLog {
  state: GameState;
  stages: CovenantStage[];
  missed: number;
  advisedCommands: number;
}

/**
 * Play the year from the save's day: the round-4 moves, and (with `follow`)
 * every command the advisor suggests at each close. Checks the seams at
 * every close.
 */
function playYear(name: Fixture, follow: boolean): YearLog {
  let state = fixture(name);
  const openingCash = state.finance.cash - posted(state);
  const stages: CovenantStage[] = [];
  let missed = 0;
  let advisedCommands = 0;
  let previousCursor = state.finance.reports.at(-1)?.ops?.lastNoticeId ?? 0;
  for (let close = 1; close <= 12 && !state.gameOver; close++) {
    const report = closeNext(state);
    if (!report) break;
    const label = `${name} close ${close}`;

    // The books balance, and the game saves and loads as itself.
    expect(openingCash + posted(state), `${label} books`).toBe(state.finance.cash);
    const copy = deserialize(serialize(state));
    expect(copy, `${label} round trip`).toEqual(state);
    state = copy;

    // The close's round-4 records.
    expect(report.ops, `${label} ops`).toBeDefined();
    const ops = report.ops!;
    expect(ops.lastNoticeId).toBeGreaterThanOrEqual(previousCursor);
    expect(ops.lastNoticeId).toBeLessThan(state.nextNoticeId);
    previousCursor = ops.lastNoticeId;
    expect(ops.repairs + (report.totals.repair ?? 0), `${label} repairs`).toBe(0);
    for (const span of state.network.spans) {
      if (span.outage) expect(span.stage, `${label} outage on a live span`).toBe('live');
      if (span.conversion) expect([span.stage, span.method], `${label} rebuild of a live aerial span`).toEqual(['live', 'aerial']);
    }
    stages.push(report.debt!.stage);
    if (report.debt!.missedPayment) missed++;

    // The briefing shows the figures the report, the HUD and the Bank show.
    if (!state.gameOver) {
      const briefing = buildBriefing(state)!;
      expect(briefing.report).toEqual(report);
      expect(briefing.headline.cash).toBe(report.cashEnd);
      expect(briefing.headline.passings).toBe(report.passings);
      expect(briefing.headline.subscribers).toBe(report.stats!.subscribers);
      expect(briefing.headline.debt).toBe(totalDebt(state));
      expect(briefing.headline.debt).toBe(report.debt!.creditBalance + report.debt!.termBalance);
      expect(briefing.headline.stage).toBe(report.debt!.stage);
      const metrics = covenantMetrics(state);
      expect(briefing.headline.covenant).toEqual(metrics);
      expect(metrics.leverage === null ? null : Math.round(metrics.leverage * 100)).toBe(report.debt!.leverageX100);
      expect(metrics.annualOperatingCashFlow).toBe(report.debt!.annualOperatingCashFlow);
      expect(briefing.forward.nextPayment).toBe(estimateNextDebtService(state));
      expect(briefing.forward.runwayMonths).toBe(runwayMonths(state));

      // Every suggestion is safe alone and together.
      const plans = advicePlans(state);
      expectPlansSafe(state, plans, label);
      if (follow) {
        const ordered = [...plans].sort((a, b) => ADVICE_ORDER.indexOf(a.advice.id) - ADVICE_ORDER.indexOf(b.advice.id));
        for (const p of ordered) {
          for (const command of p.commands) {
            expect(applyCommand(state, command), `${label} follows ${p.advice.id}`).toMatchObject({ ok: true });
            advisedCommands++;
          }
        }
      }
    }
    if (!state.gameOver) roundFourMoves(state, close);
  }
  return { state, stages, missed, advisedCommands };
}

describe('every frozen save migrates, then plays a year of round-4 play with storms on', () => {
  it.each(FIXTURES)('%s: books, round trips, close records, briefing figures and safe advice at every close; replays identically', (name) => {
    const a = playYear(name, false);
    const b = playYear(name, false);
    expect(hashState(b.state)).toBe(hashState(a.state));
    expect(a.state.finance.reports.length).toBeGreaterThan(fixture(name).finance.reports.length);
  });
});

describe('following the advisor never backfires', () => {
  it.each(FIXTURES)('%s: a year following every suggestion is never worse off with the bank than a year ignoring them', (name) => {
    const ignored = playYear(name, false);
    const followed = playYear(name, true);
    expect(followed.missed).toBeLessThanOrEqual(ignored.missed);
    if (!ignored.state.gameOver) expect(followed.state.gameOver).toBeNull();
    const worst = (stages: CovenantStage[]) => Math.max(0, ...stages.map((s) => STAGE_RANK[s]));
    expect(worst(followed.stages)).toBeLessThanOrEqual(worst(ignored.stages));
  });
});

describe('the year exercises the round-4 rules', () => {
  it('storms damage plant and the advisor suggests real commands across the frozen saves', () => {
    let damaged = 0;
    let advised = 0;
    for (const name of FIXTURES) {
      const start = fixture(name).finance.reports.length;
      const followed = playYear(name, true);
      advised += followed.advisedCommands;
      for (const r of followed.state.finance.reports.slice(start)) damaged += r.ops?.spansDamaged ?? 0;
    }
    expect(damaged).toBeGreaterThan(0);
    expect(advised).toBeGreaterThan(0);
  });
});
