// Regressions from the round-4 review (month-end briefing and advisor, loan
// polish, pricing realism, storms): each test reproduces a confirmed finding
// (numbered as in the review) and pins the fix. Money and limits come from
// balance.ts constants or quoted results, never literal tuning values.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ADVICE_PRIORITY, advicePlans, advise, buildBriefing, growthOptions, noticeNeedsAttention, planFor } from './advisor';
import { COVENANT_CURE_CLOSES, CPP_AMBER_MULTIPLIER, CPP_SPREAD_BPS, CPP_TARGET, MARKETING_MAX_PER_MONTH, MAX_SPLITTERS_PER_CABINET } from './balance';
import { formatMonth, dateOf } from './calendar';
import {
  closesUntilAcceleration,
  covenantMetrics,
  cureBeatsCall,
  cureFor,
  cureOptions,
  estimateNextDebtService,
  estimateSweep,
  pricingCpp,
  totalDebt,
} from './debt';
import { estimateCashAtClose, formatMoney } from './finance';
import { applyCommand, runDays, tick } from './game';
import { cppBand } from './metrics';
import { getService, isCutOff, outageService, ponPortsUsed } from './network';
import { deserialize } from './save';
import { accountUnits, retireDestination, TIER_IDS, unitsByTier } from './sales';
import { addLivePlant, makeGridCity, makeLoan, makeTestState, makeTradingState } from './testing/fixtures';
import { frozenHoarderBot, smartBot } from './tuning/bots';
import { runBot } from './tuning/harness';
import type { BotFactory } from './tuning/harness';
import type { Account, CabinetId, Command, GameState, MonthlyReport, Notice, ParcelId, SegmentId, TierId } from './types';
import { cutOffOf, outageChurnFor, outageChurnProbability } from './weather';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8');
}

function tiers(units: number, tier: TierId = 'fiber500'): Record<TierId, number> {
  return { fiber500: 0, fiber1g: 0, fiber2g: 0, [tier]: units };
}

function account(parcel: ParcelId, cabinet: CabinetId, units: number, since: number): Account {
  return { parcel, cabinet, tierUnits: tiers(units), since, locks: [] };
}

/**
 * The state right after each month close of `makeBot` played on `seed`
 * (index i: after close i + 1), cached per run. Tests that need a scenario a
 * bot reaches (a frozen line one close before the call, installs posted on
 * the 1st...) take the first close that has it, not a fixed month, so a
 * balance change that moves the bot's path does not lose the scenario.
 */
const closesCache = new Map<string, GameState[]>();
function statesAfterCloses(key: string, seed: number, makeBot: BotFactory, months: number): GameState[] {
  const cached = closesCache.get(key);
  if (cached) return cached;
  const states: GameState[] = [];
  let closes = 0;
  runBot(seed, makeBot, months, {
    afterTick: (s) => {
      if (s.finance.reports.length === closes) return;
      closes = s.finance.reports.length;
      states.push(structuredClone(s));
    },
  });
  closesCache.set(key, states);
  return states;
}

/** The first state after a close (from month `from` on) that `has` the scenario; fails the test when the run never reaches it. */
function firstClose(states: readonly GameState[], from: number, has: (state: GameState) => boolean): GameState {
  const found = states.slice(from - 1).find(has);
  expect(found, 'a close with the scenario').toBeDefined();
  return found!;
}

/** Put a storm outage on the live span of `segment`, `daysLeft` days to repair. */
function breakSpan(state: GameState, segment: SegmentId, daysLeft: number): void {
  const span = state.network.spans.find((s) => s.segment === segment)!;
  span.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft, repairCost: 0 };
  state.network.version++;
}

/** A 3 x 2 grid with every street cabled and a cabinet at the CO; the lots on segment 0 are apartment buildings of `units` units. */
function outageTown(units: number, rngSales = 54321): { state: GameState; cabinet: CabinetId; seg0: ParcelId[] } {
  const city = makeGridCity({ cols: 3, rows: 2, parcelKinds: (p) => (p.segment === 0 ? { kind: 'mdu', units } : undefined) });
  const state = makeTestState(city, { rngSales });
  const cabinet = addLivePlant(state, { splitters: 4 })!;
  state.sales.marketingPerMonth = 0;
  const seg0 = city.parcels.filter((p) => p.segment === 0).map((p) => p.id);
  return { state, cabinet, seg0 };
}

/** Accounts kept sorted by parcel (the sales invariant). */
function addAccounts(state: GameState, ...accounts: Account[]): void {
  state.sales.accounts = [...state.sales.accounts.filter((a) => !accounts.some((b) => b.parcel === a.parcel)), ...accounts].sort(
    (a, b) => a.parcel - b.parcel,
  );
}

/** Tick until a month closes; that close's report. */
function tickThroughClose(state: GameState): MonthlyReport {
  const count = state.finance.reports.length;
  for (let i = 0; i < 40 && !state.gameOver; i++) {
    tick(state);
    if (state.finance.reports.length > count) return state.finance.reports.at(-1)!;
  }
  throw new Error('no close within 40 days');
}

// ---------------------------------------------------------------------------
// #1: a v3 save's grandfathered subscribers on an unoffered tier
// ---------------------------------------------------------------------------

describe('#1 subscribers on an unoffered tier in a v3 save', () => {
  it('are told at load that they move at the next close, naming the tier, the count, where to and when', () => {
    const v3 = JSON.parse(fixture('v3-grid'));
    const state = deserialize(fixture('v3-grid'));
    const retired = state.sales.pricing.tiers.filter((t) => !t.offered && unitsByTier(state)[t.id] > 0);
    expect(retired.length).toBeGreaterThan(0);
    const added = state.notices.slice(v3.notices.length);
    const today = dateOf(state.day);
    const close = formatMonth(today.year, today.month);
    for (const tier of retired) {
      const to = state.sales.pricing.tiers.find((t) => t.id === retireDestination(state.sales.pricing.tiers, tier.id))!;
      const units = unitsByTier(state)[tier.id];
      const note = added.find((n) => n.kind === 'rulesUpdated' && n.message.includes(tier.name));
      expect(note, tier.name).toBeDefined();
      expect(note!.message).toContain(`${units} subscribers on ${tier.name}`);
      expect(note!.message).toContain(`move to ${to.name}`);
      expect(note!.message).toContain(`${close} close`);
      expect(note!.message).toContain(formatMoney(tier.price));
      expect(note!.message).toContain(formatMoney(to.price));
    }
    // ... and what the notice said is what the close does.
    const moved = tickThroughClose(state);
    expect(moved.ops?.tierMoves).toBeGreaterThan(0);
    for (const tier of retired) expect(unitsByTier(state)[tier.id]).toBe(0);
  });

  it('says nothing when no unoffered tier has subscribers', () => {
    const save = JSON.parse(fixture('v3-grid'));
    for (const acc of save.sales.accounts) {
      for (const id of TIER_IDS) {
        const tier = save.sales.pricing.tiers.find((t: { id: string }) => t.id === id);
        if (!tier.offered && acc.tierUnits[id] > 0) {
          acc.tierUnits.fiber500 += acc.tierUnits[id];
          acc.tierUnits[id] = 0;
        }
      }
    }
    const state = deserialize(JSON.stringify(save));
    const added = state.notices.slice(save.notices.length);
    expect(added.some((n) => /no longer offer/.test(n.message))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #2-#4: outage churn reaches the subscribers actually cut off, once per outage
// ---------------------------------------------------------------------------

describe('#2 outage churn and subscribers who connected after the repair', () => {
  it('charges no outage churn to a subscriber who signed up after the street was repaired', () => {
    let units = 0;
    let late = 0;
    let outageChurn = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const state = makeTestState(makeGridCity({ cols: 3, rows: 2 }), { rngSales: seed });
      const cabinet = addLivePlant(state, { splitters: 4 })!;
      // Round 4c/4d: homes switch as they hear of you, so the town gets the strongest push there is (the most marketing
      // and a neighborhood campaign), over more towns, for enough of them to sign up in a month.
      expect(applyCommand(state, { type: 'setMarketing', perMonth: MARKETING_MAX_PER_MONTH }).ok).toBe(true);
      expect(applyCommand(state, { type: 'runCampaign', cabinet }).ok).toBe(true);
      breakSpan(state, 0, 3); // out on days 1-2, before anyone can sign up there
      runDays(state, 30); // Jan 31
      const onSeg0 = state.sales.accounts.filter((a) => state.city.parcels[a.parcel]!.segment === 0);
      units += onSeg0.reduce((n, a) => n + accountUnits(a), 0);
      late += onSeg0.filter((a) => a.since >= 3).reduce((n, a) => n + accountUnits(a), 0);
      const report = tickThroughClose(state);
      expect(report.ops?.outageUnitDays).toBe(0);
      outageChurn += report.ops?.outageChurn ?? 0;
    }
    expect(units).toBeGreaterThan(20);
    expect(late).toBe(units);
    expect(outageChurn).toBe(0);
  });

  it('charges only the units an apartment building had cut off, not units it added after the repair', () => {
    const { state, cabinet, seg0 } = outageTown(4_000);
    const [cut, after] = seg0 as [ParcelId, ParcelId];
    addAccounts(state, account(cut, cabinet, 10, 0));
    breakSpan(state, 0, 3);
    runDays(state, 5);
    expect(cutOffOf(state, cut)).toEqual({ days: 2, charged: 0, units: 10 });
    // After the repair: the cut-off building fills up, and a new building signs up in full.
    const building = state.sales.accounts.find((a) => a.parcel === cut)!;
    building.tierUnits.fiber500 = 4_000;
    addAccounts(state, account(after, cabinet, 4_000, state.day));
    expect(cutOffOf(state, after)).toBeNull();
    const report = tickThroughClose(state);
    // At most the 10 units that were cut off can cancel for the outage (7% of 8,000 would be ~560).
    expect(report.ops?.outageChurn).toBeLessThanOrEqual(10);
    expect(cutOffOf(state, cut)).toBeNull();
  });
});

describe('#3 a subscriber whose own cabinet an outage cuts off', () => {
  /** A 3 x 1 ring with cabinet A at the CO (node 0) and cabinet B at node 3; both reach segment 1. */
  function ring(bSplitters: number) {
    const state = makeTestState(makeGridCity({ cols: 3, rows: 1 }));
    const a = addLivePlant(state, { segments: [0, 1, 2, 3, 4, 5, 6, 9], node: 0, splitters: 1 })!;
    const b = addLivePlant(state, { segments: [], node: 3, splitters: bSplitters })!;
    state.sales.marketingPerMonth = 0;
    const parcel = state.city.parcels.find((p) => p.segment === 1)!;
    return { state, a, b, parcel };
  }

  it('has no service when the outage cuts its cabinet off and the cabinet that still reaches the street has no port for it', () => {
    const { state, a, b, parcel } = ring(0);
    expect(getService(state).segmentCabinets.get(1)).toEqual([a, b]);
    addAccounts(state, account(parcel.id, a, 1, 0));
    breakSpan(state, 0, 6);
    const service = getService(state);
    // B still reaches the street, so it is not dark, but A's subscriber is cut off: B has no free port.
    expect(service.interruptedSegments.has(1)).toBe(false);
    expect(isCutOff(service, 1, a)).toBe(true);
    expect(isCutOff(service, 1, b)).toBe(false);
    expect(outageService(state, service).cutOff.has(parcel.id)).toBe(true);
    runDays(state, 3);
    expect(state.weather.month.outageUnitDays).toBeGreaterThanOrEqual(3);
    expect(cutOffOf(state, parcel.id)?.days).toBe(3);
  });

  it('is served meanwhile by a cabinet that still reaches the street with a free port, as the service rule would', () => {
    const { state, a, b, parcel } = ring(1);
    addAccounts(state, account(parcel.id, a, 1, 0));
    breakSpan(state, 0, 6);
    const outage = outageService(state, getService(state));
    expect(outage.cutOff.has(parcel.id)).toBe(false);
    expect(outage.lent.get(b)).toBe(1);
    runDays(state, 3);
    expect(cutOffOf(state, parcel.id)).toBeNull();
  });

  it('connects new subscribers there only to a cabinet that still reaches the street and has a free port', () => {
    const signups = (bSplitters: number, wiredTo?: (cabinet: CabinetId, b: CabinetId) => void): number => {
      let n = 0;
      for (let seed = 1; seed <= 40; seed++) {
        const { state, b } = ring(bSplitters);
        state.rng.sales = seed;
        state.sales.marketingPerMonth = 5_000;
        breakSpan(state, 0, 25);
        runDays(state, 20);
        for (const acc of state.sales.accounts) {
          if (state.city.parcels[acc.parcel]!.segment !== 1) continue;
          wiredTo?.(acc.cabinet, b);
          n++;
        }
      }
      return n;
    };
    // B still reaches the street: signups go to B, never to A (cut off).
    expect(signups(1, (cabinet, b) => expect(cabinet).toBe(b))).toBeGreaterThan(0);
    // B has no free port: nobody signs up until the repair.
    expect(signups(0)).toBe(0);
  });

  it('keeps service for a subscriber on the cabinet that still reaches the street', () => {
    const { state, b, parcel } = ring(1);
    addAccounts(state, account(parcel.id, b, 1, 0));
    breakSpan(state, 0, 6);
    runDays(state, 3);
    expect(cutOffOf(state, parcel.id)).toBeNull();
    expect(state.weather.month.outageUnitDays).toBe(0);
  });
});

describe('#4 an outage that spans a month close', () => {
  it('pays its base churn once: each close charges its own days, the second only what the outage added', () => {
    let units = 0;
    let atFirst = 0;
    let atSecond = 0;
    for (const seed of [1, 2]) {
      const { state, cabinet, seg0 } = outageTown(2_500, seed);
      for (const parcel of seg0) addAccounts(state, account(parcel, cabinet, 2_500, 0));
      units += seg0.length * 2_500;
      runDays(state, 29); // Jan 30
      breakSpan(state, 0, 3); // out Jan 31 and Feb 1, back Feb 2
      tick(state); // Jan 31
      expect(cutOffOf(state, seg0[0]!)).toMatchObject({ days: 1, charged: 0 });
      const first = tickThroughClose(state); // Feb 1: Jan 31 charged; still out, so kept
      atFirst += first.ops?.outageChurn ?? 0;
      expect(cutOffOf(state, seg0[0]!)).toMatchObject({ days: 1, charged: 1 });
      runDays(state, 5); // repaired Feb 2
      expect(cutOffOf(state, seg0[0]!)).toMatchObject({ days: 1, charged: 1 });
      const second = tickThroughClose(state); // Mar 1: Feb 1 charged, without the base again
      atSecond += second.ops?.outageChurn ?? 0;
      expect(cutOffOf(state, seg0[0]!)).toBeNull();
    }
    expect(outageChurnFor(1, 1)).toBeCloseTo(outageChurnProbability(2) - outageChurnProbability(1), 12);
    // The first close charges the base and a day; the second only a day.
    expect(atFirst / units).toBeGreaterThan(outageChurnProbability(1) * 0.8);
    expect(atSecond / units).toBeLessThan(outageChurnProbability(1) / 2);
    // Together about outageChurnProbability(2), as inside one month, not outageChurnProbability(1) twice.
    const rate = (atFirst + atSecond) / units;
    expect(rate).toBeGreaterThan(outageChurnProbability(2) * 0.8);
    expect(rate).toBeLessThan((outageChurnProbability(2) + 2 * outageChurnProbability(1)) / 2);
  });

  it('starts a new outage with its base again once the old one is over', () => {
    const { state, cabinet, seg0 } = outageTown(10);
    addAccounts(state, account(seg0[0]!, cabinet, 10, 0));
    runDays(state, 29);
    breakSpan(state, 0, 3);
    tickThroughClose(state); // Feb 1: still out
    expect(cutOffOf(state, seg0[0]!)).toMatchObject({ days: 1, charged: 1 });
    runDays(state, 3);
    tickThroughClose(state); // Mar 1: charged and dropped
    expect(cutOffOf(state, seg0[0]!)).toBeNull();
    breakSpan(state, 0, 2);
    tick(state);
    expect(cutOffOf(state, seg0[0]!)).toMatchObject({ days: 1, charged: 0 });
  });
});

// ---------------------------------------------------------------------------
// #8: the cash projected at the next close, from a briefing on the 1st
// ---------------------------------------------------------------------------

describe('#8 the cash projected at the next close from the 1st of the month', () => {
  /** Cash at the next close's debt step, playing on with no commands. */
  function cashAtDebtStep(state: GameState): number {
    const copy = structuredClone(state);
    const report = tickThroughClose(copy);
    return report.cashEnd - (report.totals.interest ?? 0) - (report.totals.principal ?? 0);
  }

  it('does not scale one day of installs up to a month, so a healthy operator gets no false payment alarm', () => {
    // A mature, healthy operator (SMART in its fifth year) at a close where installs landed on the 1st.
    const installsOnThe1st = (s: GameState) => s.finance.monthToDate.some((e) => e.category === 'install' && e.day === s.day);
    const state = firstClose(statesAfterCloses('smart:12345', 12345, smartBot(), 60), 48, installsOnThe1st);
    expect(dateOf(state.day).day).toBe(1);
    // The briefing runs right after the close, with the 1st's installs already posted.
    expect(installsOnThe1st(state)).toBe(true);
    const projected = estimateCashAtClose(state);
    const actual = cashAtDebtStep(state);
    // Off by less than a month of installs (scaling the 1st's up to the month missed by several months' worth).
    const monthOfInstalls = -(state.finance.reports.at(-1)!.totals.install ?? 0);
    expect(monthOfInstalls).toBeGreaterThan(0);
    expect(Math.abs(projected - actual)).toBeLessThan(monthOfInstalls);
    expect(actual).toBeGreaterThan(estimateNextDebtService(state));
    const briefing = buildBriefing(state)!;
    expect(briefing.advice.map((a) => a.id)).not.toContain('paymentShort');
    expect(briefing.forward.projectedCash).toBeGreaterThan(0);
    // Round 4c/4d: the 60-month SMART run behind it takes several seconds with the scaled overhead and the customers model.
  }, 60_000);

  it('counts the month\'s installs when none landed on the 1st', () => {
    const { state } = runBot(1, smartBot(), 21);
    const today = state.finance.monthToDate.filter((e) => e.category === 'install' && e.day === state.day);
    for (const entry of today) state.finance.cash -= entry.amount;
    state.finance.monthToDate = state.finance.monthToDate.filter((e) => !today.includes(e));
    expect(state.finance.reports.at(-1)?.totals.install ?? 0).toBeLessThan(0);
    // Installs still come this month, at about last month's pace.
    expect(estimateCashAtClose(state)).toBeLessThan(estimateCashAtClose({ ...state, finance: { ...state.finance, reports: [] } }));
  });
});

// ---------------------------------------------------------------------------
// #5: a payment draw next to "hold off on new borrowing"
// ---------------------------------------------------------------------------

describe('#5 a briefing with a short payment and covenants near their limit', () => {
  function nearLimitAndShort(): GameState {
    const state = makeTradingState(100_000, 70_000);
    const loan = makeLoan({ principal: 1_900_000, termMonths: 84, rateBps: 500 });
    state.debt.loans = [loan];
    state.debt.nextLoanId = 2;
    state.finance.cash = 20_000;
    return state;
  }

  it('borrows only for the payment, and the covenant warning says to borrow nothing beyond it', () => {
    const state = nearLimitAndShort();
    const m = covenantMetrics(state);
    expect(m.compliant).toBe(true);
    expect(estimateCashAtClose(state)).toBeLessThan(estimateNextDebtService(state));
    const plans = advicePlans(state);
    const shown = advise(state).map((a) => a.id);
    expect(shown).toEqual(expect.arrayContaining(['paymentShort', 'covenantCure']));
    const short = plans.find((p) => p.advice.id === 'paymentShort')!;
    const cure = plans.find((p) => p.advice.id === 'covenantCure')!;
    expect(short.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan')).toBe(true);
    // No other plan borrows, and the warning names the payment's borrowing as the exception.
    for (const p of plans) {
      if (p === short) continue;
      expect(p.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan'), p.advice.id).toBe(false);
    }
    // Round 4c/4d: the card says it in plain words; the reasoning behind it names the exception.
    expect(cure.advice.why).toMatch(/borrow nothing beyond the payment above/);
    expect(cure.advice.detail).toMatch(/Beyond the borrowing suggested above/);
    expect(`${cure.advice.why} ${cure.advice.detail}`).not.toMatch(/(^|\. )Hold off on new borrowing/);
    // On its own (nothing borrowed before it) the warning still says plainly to hold off.
    const alone = planFor(state, 'covenantCure')!.advice;
    expect(alone.why).toMatch(/hold off on new borrowing/);
    expect(alone.detail).toMatch(/Hold off on new borrowing/);
  });
});

// ---------------------------------------------------------------------------
// #6: the red-CPP spread and fixed-rate term loans
// ---------------------------------------------------------------------------

describe('#6 the CPP spread advice', () => {
  function redWithLoan(): GameState {
    const state = makeTradingState(60_000, 30_000);
    state.debt.loans = [makeLoan({ principal: 400_000, termMonths: 84, rateBps: 550 })];
    state.debt.nextLoanId = 2;
    state.finance.cash = 200_000;
    addLivePlant(state);
    state.finance.capex.osp = Math.round(getService(state).passings * CPP_TARGET * (CPP_AMBER_MULTIPLIER + 1));
    return state;
  }

  it('quotes no cost on term loans the spread never re-prices, and stays a tip with nothing drawn', () => {
    const state = redWithLoan();
    expect(cppBand(pricingCpp(state)!)).toBe('red');
    expect(state.debt.credit.balance).toBe(0);
    const p = planFor(state, 'redCpp')!;
    expect(p.advice).toMatchObject({ severity: 'tip', priority: ADVICE_PRIORITY.redCpp });
    const said = `${p.advice.why} ${p.advice.detail}`;
    expect(said).not.toMatch(/today's .* of debt|a year on/);
    expect(p.advice.detail).toMatch(/term loans keep the rates they were taken at/);
  });

  it('prices the spread on the line\'s balance only, important while the line is drawn', () => {
    const state = redWithLoan();
    state.debt.credit.balance = 50_000;
    const p = planFor(state, 'redCpp')!;
    expect(p.advice).toMatchObject({ severity: 'important', priority: ADVICE_PRIORITY.redCppWithDebt });
    expect(p.advice.detail).toContain(formatMoney((50_000 * CPP_SPREAD_BPS.red) / 10_000));
    expect(`${p.advice.why} ${p.advice.detail}`).not.toContain(formatMoney(((50_000 + state.debt.loans[0]!.balance) * CPP_SPREAD_BPS.red) / 10_000));
  });
});

// ---------------------------------------------------------------------------
// #7: the briefing's cash after the next close, while frozen
// ---------------------------------------------------------------------------

describe('#7 the forward look while the line is frozen', () => {
  it('takes the frozen-line sweep out of the cash projected at the next close, and the close agrees', () => {
    const state = deserialize(fixture('v3-town'));
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    state.debt.frozenCloses = 1;
    state.finance.cash += 60_000;
    // The last day of the month: the estimates are exact.
    while (dateOf(state.day + 1).day !== 1) tick(state);
    const sweep = estimateSweep(state);
    expect(sweep).toBeGreaterThan(0);
    const projected = estimateCashAtClose(state) - estimateNextDebtService(state) - sweep;
    const report = tickThroughClose(state);
    expect(report.debt?.sweep).toBe(sweep);
    expect(report.cashEnd).toBe(projected);
    // Right after the close (still frozen), the briefing's forward look counts the next sweep.
    const b = buildBriefing(state)!;
    expect(state.debt.covenant.stage).toBe('frozen');
    expect(b.forward.sweep).toBe(estimateSweep(state));
    expect(b.forward.sweep).toBeGreaterThan(0);
    expect(b.forward.projectedCash).toBe(estimateCashAtClose(state) - estimateNextDebtService(state) - estimateSweep(state));
  });
});

// ---------------------------------------------------------------------------
// #9: cure advice when the bank calls the loans first
// ---------------------------------------------------------------------------

describe('#9 covenant cures and the bank\'s call', () => {
  function follow(state: GameState, commands: readonly Command[]): GameState {
    const copy = structuredClone(state);
    for (const cmd of commands) expect(applyCommand(copy, cmd), JSON.stringify(cmd)).toMatchObject({ ok: true });
    return copy;
  }

  /** FROZEN_HOARDER on 12345, close by close: it freezes, the bank calls its loans, and it runs out of cash to repay them. */
  const hoarder = () => statesAfterCloses('hoarder:12345', 12345, frozenHoarderBot(), 40);

  it('one close before the call, suggests repaying everything (which stops it), not a cure that cannot finish in time', () => {
    // Frozen, not yet called, the call due before a cure could lift the freeze, with a prepayment that would pass today's tests.
    const state = firstClose(hoarder(), 1, (s) => {
      const left = closesUntilAcceleration(s);
      return s.debt.covenant.stage === 'frozen' && s.debt.acceleration === null && left !== null && left < COVENANT_CURE_CLOSES && cureOptions(s)[0]?.kind === 'prepayLoan';
    });
    expect(state.debt.covenant.stage).toBe('frozen');
    expect(closesUntilAcceleration(state)).toBeLessThan(COVENANT_CURE_CLOSES);
    expect(covenantMetrics(state).compliant).toBe(false);
    // A single prepayment would pass today's tests, but the call comes first.
    expect(cureOptions(state)[0]?.kind).toBe('prepayLoan');
    expect(cureBeatsCall(state)).toBe(false);
    const plans = advicePlans(state);
    const cure = plans.find((p) => p.advice.id === 'covenantCure')!;
    expect(cure.advice.severity).toBe('urgent');
    expect(cure.advice.title).toBe(`Repay all ${formatMoney(totalDebt(state))} you owe`);
    expect(plans.every((p) => !/^Prepay|Grow operating/.test(p.advice.title))).toBe(true);
    // Following it: no debt, no call, and the close clears the stage.
    const after = follow(state, cure.commands);
    expect(totalDebt(after)).toBe(0);
    tickThroughClose(after);
    expect(after.debt.acceleration).toBeNull();
    expect(after.debt.covenant.stage).toBe('compliant');
    // The Bank's cure box shows the same.
    expect(cureFor(state)?.kind).toBe('repayAll');
  });

  it('once the loans are called, suggests repaying everything when cash covers it, never a growth target', () => {
    const state = firstClose(hoarder(), 1, (s) => s.debt.acceleration !== null && s.finance.cash >= totalDebt(s));
    expect(state.debt.acceleration).not.toBeNull();
    expect(cureOptions(state)[0]?.kind).toBe('grow');
    const plans = advicePlans(state);
    const cure = plans.find((p) => p.advice.id === 'covenantCure')!;
    expect(cure.advice.title).toBe(`Repay all ${formatMoney(totalDebt(state))} you owe`);
    expect(plans.some((p) => /Grow operating cash flow/.test(p.advice.title))).toBe(false);
    // Repaying is not borrowing: a later card never calls it "the borrowing suggested above".
    for (const p of plans) expect(`${p.advice.why} ${p.advice.detail ?? ''}`, p.advice.id).not.toMatch(/borrowing suggested above/);
    const runway = plans.find((p) => p.advice.id === 'cashRunway');
    if (runway) {
      // Round 4c/4d: the card's sentence is short and its reasoning is in the detail; it never suggests borrowing.
      expect(runway.commands.some((c) => c.type === 'drawCredit' || c.type === 'takeTermLoan')).toBe(false);
      expect(runway.advice.why).not.toMatch(/: borrow|borrowing \$/);
      expect(`${runway.advice.why} ${runway.advice.detail ?? ''}`).toMatch(/don't borrow|loans won't fix it|cannot carry more debt/);
    }
    const after = follow(state, cure.commands);
    tickThroughClose(after);
    expect(after.debt.acceleration).toBeNull();
    expect(after.debt.covenant.stage).toBe('compliant');
  });

  it('with the loans called and too little cash to repay them, gives no cure card, and one card for a last close that cannot pay', () => {
    // Round 4c/4d: with the scaled overhead the hoarder keeps more cash than it owes once called, so its first called
    // close is taken with the cash short of the debt (what a worse year would have left).
    const called = firstClose(hoarder(), 1, (s) => s.debt.acceleration !== null && s.gameOver === null);
    const state = structuredClone(called);
    state.finance.cash = Math.min(state.finance.cash, totalDebt(state) - 1);
    expect(state.debt.acceleration).not.toBeNull();
    expect(state.finance.cash).toBeLessThan(totalDebt(state));
    expect(cureFor(state)).toBeNull();
    const ids = advicePlans(state).map((p) => p.advice.id);
    expect(ids).not.toContain('covenantCure');
    if (state.debt.acceleration!.closesLeft <= 1 && ids.includes('paymentShort')) expect(ids).not.toContain('loansCalled');
  });
});

// ---------------------------------------------------------------------------
// #10: "needs attention" for a cabinet the player already fixed
// ---------------------------------------------------------------------------

describe('#10 attention for capacity notices', () => {
  it('does not stop the game for a cabinet-full notice the player fixed before the close', () => {
    // Play until a close whose period has a cabinet-full notice, with that cabinet no longer full.
    let state = runBot(12345, smartBot({ splitterAt: 5, marketingPerPassing: 0.25, borrow: false }), 4).state;
    let found = false;
    for (let month = 5; month <= 14 && !found; month++) {
      state = runBot(12345, smartBot({ splitterAt: 5, marketingPerPassing: 0.25, borrow: false }), 1, { state }).state;
      const b = buildBriefing(state)!;
      const fixed = b.notices.filter((n) => n.kind === 'cabinetFull' && n.cabinet !== null && !state.sales.fullCabinets.includes(n.cabinet));
      if (fixed.length === 0 || b.notices.some((n) => n.kind === 'cabinetFull' && !fixed.includes(n))) continue;
      found = true;
      for (const n of fixed) expect(noticeNeedsAttention(state, n)).toBe(false);
      if (!b.advice.some((a) => a.severity === 'urgent') && !b.notices.some((n) => noticeNeedsAttention(state, n))) {
        expect(b.needsAttention).toBe(false);
      }
    }
    expect(found).toBe(true);
  });

  it('still needs attention while the cabinet, the OLT or the install pause stands', () => {
    const state = makeTestState();
    const cabinet = addLivePlant(state)!;
    const notice = (kind: Notice['kind'], cab: CabinetId | null = null) => ({ kind, cabinet: cab });
    expect(noticeNeedsAttention(state, notice('cabinetFull', cabinet))).toBe(false);
    state.sales.fullCabinets = [cabinet];
    expect(noticeNeedsAttention(state, notice('cabinetFull', cabinet))).toBe(true);
    expect(noticeNeedsAttention(state, notice('installsPaused'))).toBe(false);
    state.sales.installsPaused = true;
    expect(noticeNeedsAttention(state, notice('installsPaused'))).toBe(true);
    expect(noticeNeedsAttention(state, notice('oltFull'))).toBe(false);
    state.network.olt.ponPorts = ponPortsUsed(state);
    expect(noticeNeedsAttention(state, notice('oltFull'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #11: growth tips next to a cash squeeze; "the next loan payment" with no debt
// ---------------------------------------------------------------------------

describe('#11 the take-rate tip and capacity wording when cash is short', () => {
  it('suggests no more marketing (or other spending on growth) while installs are paused', () => {
    const { state } = runBot(12345, smartBot({ splitterAt: 5, marketingPerPassing: 0.25, borrow: false }), 24);
    // Round 4c/4d: marketing is growCustomers' to weigh (the take-rate tip is about prices only).
    expect(planFor(state, 'growCustomers')).not.toBeNull();
    state.sales.installsPaused = true;
    expect(planFor(state, 'growCustomers')).toBeNull();
    expect(planFor(state, 'takeRate')).toBeNull();
    expect(growthOptions(state)).toEqual([]);
    const ids = advicePlans(state).map((p) => p.advice.id);
    expect(ids).not.toContain('growCustomers');
    expect(ids).not.toContain('takeRate');
  });

  it('asks for a cushion, not "the next loan payment", from a company that owes nothing', () => {
    const { state } = runBot(12345, smartBot({ splitterAt: 5, marketingPerPassing: 0.25, borrow: false }), 30);
    expect(totalDebt(state)).toBe(0);
    const cabinet = state.network.cabinets.find((c) => c.splitters < MAX_SPLITTERS_PER_CABINET)!;
    state.sales.fullCabinets = [cabinet.id];
    state.finance.cash = 100;
    // Installs paused for cash: the cash-runway suggestion borrows first, so the splitter has to wait for cash.
    state.sales.installsPaused = true;
    const plans = advicePlans(state);
    expect(plans.find((q) => q.advice.id === 'cashRunway')?.commands.length).toBeGreaterThan(0);
    const p = plans.find((q) => q.advice.id === 'addSplitter')!;
    expect(p.advice.title).toMatch(/when cash allows/);
    expect(`${p.advice.why} ${p.advice.detail}`).not.toMatch(/loan payment/);
    expect(p.advice.detail).toMatch(/a cushion/);
  });
});

// ---------------------------------------------------------------------------
// #12: the 'grow' cure's figures
// ---------------------------------------------------------------------------

describe('#12 the grow cure', () => {
  it('states today\'s operating cash flow and the target on one basis', () => {
    const state = makeTradingState(5_000, 12_000);
    state.debt.loans = [makeLoan({ principal: 500_000, termMonths: 84 })];
    state.debt.nextLoanId = 2;
    state.finance.cash = 1_000;
    const option = cureOptions(state)[0]!;
    expect(option.kind).toBe('grow');
    const m = covenantMetrics(state);
    expect(m.annualOperatingCashFlow).toBeLessThan(m.underwritingCashFlow);
    expect(option.after.annualOperatingCashFlow).toBe(m.annualOperatingCashFlow + option.amount);
    expect(option.text).not.toMatch(/in all/);
    expect(option.text).toContain(`from ${formatMoney(m.annualOperatingCashFlow)} to ${formatMoney(option.after.annualOperatingCashFlow)} a year`);
    expect(option.text).toContain(`the bank counts ${formatMoney(m.underwritingCashFlow)}`);
    const p = planFor(state, 'covenantCure')!;
    expect(p.advice.title).toMatch(/^Raise cash flow to about \$[\d,]+ a year$/);
  });
});
