// Headless balance harness: plays a bot on a generated town for N months
// through the real sim (commands + daily ticks, no DOM), records every monthly
// report and its KPIs, and measures the town the balance targets are about
// (size, build-out cost, cost per passing of typical cable runs).
//
// Owner: balance-tuning workstream. Used by targets.test.ts (the balance
// targets), report.test.ts (TUNE_REPORT=1 prints the numbers) and
// invariants.test.ts (long mixed sessions). Pure and deterministic: bots draw
// from their own Rng, never from the game's streams.

import {
  CABINET_COST,
  CABINET_REACH_FT,
  POLE_RENT_PER_POLE_PER_MONTH,
  SMB_MULTIPLIER_DEFAULT,
  SPLITTER_COST,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
} from '../balance';
import { dayOf, MONTH_LENGTHS } from '../calendar';
import { creditLimit, penaltyBps, termCapacity } from '../debt';
import { applyCommand, newGame, tick } from '../game';
import { reportKpis } from '../metrics';
import type { ReportKpis } from '../metrics';
import { getService, orderFees, quoteCable, spanCharges } from '../network';
import { stateTakeRate } from '../sales';
import { otherEnd, parcelsServedBy, polesOnSegment, segmentsAtNode, segmentsWithin } from '../streets';
import { cityExposure, exposureBand, meanOutageDays, outageChurnProbability, stormRisk, streetCanopy } from '../weather';
import type {
  CabinetId,
  CableMethod,
  City,
  Command,
  CommandResult,
  CovenantStage,
  ExposureBand,
  GameOver,
  GameState,
  MonthlyReport,
  NoticeKind,
  SegmentId,
  StreetSegment,
  TierId,
  Zone,
} from '../types';

/** The seeds every balance target is checked on. */
export const TUNING_SEEDS: readonly number[] = [1, 2027, 424242, 99, 12345];

/** Bots look at the game and act once every this many days (day 0 included). */
export const BOT_INTERVAL_DAYS = 7;

/** Sends one command to the game (applyCommand, counted by the harness). */
export type Send = (cmd: Command) => CommandResult;

/** A scripted player. It changes the game only through `send`. */
export interface Bot {
  readonly name: string;
  /** Called on day 0 and every BOT_INTERVAL_DAYS days after, before that day's tick. */
  act(state: GameState, send: Send): void;
}

export type BotFactory = (seed: number) => Bot;

export interface RunResult {
  seed: number;
  bot: string;
  /** Final state (after the last close played, or the close that ended the game). */
  state: GameState;
  /** Every closed month of the run, oldest first (reports[0] is month 1). */
  reports: MonthlyReport[];
  /** reportKpis of each report (every round-2 close writes stats). */
  kpis: ReportKpis[];
  gameOver: GameOver | null;
  /** 1-based month whose close ended the game, else null. */
  gameOverMonth: number | null;
  /** Successful commands by type, and how many were rejected. */
  commands: Record<string, number>;
  /** 1-based month in which each command type first succeeded. */
  firstMonth: Record<string, number>;
  rejected: number;
  /** Milliseconds the run took by opts.clock (0 without one: the sim never reads a clock itself). */
  ms: number;
  /** borrowingCapacity on the day the run started (before the bot's first look). */
  capacityAtStart: number;
  /** Most borrowingCapacity seen on any day before the first subscriber signed up (whole run if nobody ever did). */
  capacityBeforeFirstSubscriber: number;
  /** borrowingCapacity right after each close of the run (capacityAfterClose[0] after month 1). */
  capacityAfterClose: number[];
  /** Round 4: notices posted during the run, by kind (every one, though the game's log keeps only the newest). */
  notices: Partial<Record<NoticeKind, number>>;
  /** Round 4b: every incumbent promo that started during the run (Sales.incumbentPromos records), in order of start. */
  incumbentPromos: Array<{ cabinet: CabinetId; startDay: number }>;
}

export interface RunOptions {
  /** Start from this state instead of newGame(seed) (e.g. a loaded save). */
  state?: GameState;
  /** Called after every tick (invariant checks). */
  afterTick?: (state: GameState) => void;
  /** Called after every command the bot sends, with the cash before it. */
  afterCommand?: (state: GameState, cmd: Command, result: CommandResult, cashBefore: number) => void;
  /**
   * A millisecond clock to time the run with (tests pass performance.now).
   * Nothing under src/sim reads a clock itself (README purity rule).
   */
  clock?: () => number;
}

/**
 * Play `makeBot(seed)` on newGame(seed) (or opts.state) until `months` month
 * closes have happened or the game is over. The bot acts on day 0 and every
 * BOT_INTERVAL_DAYS days, before that day's tick.
 */
export function runBot(seed: number, makeBot: BotFactory, months: number, opts: RunOptions = {}): RunResult {
  const started = opts.clock?.() ?? 0;
  const state = opts.state ?? newGame(seed);
  const bot = makeBot(seed);
  const commands: Record<string, number> = {};
  const firstMonth: Record<string, number> = {};
  let rejected = 0;
  const startReports = state.finance.reports.length;
  const capacityAtStart = borrowingCapacity(state);
  let capacityBeforeFirstSubscriber = 0;
  const capacityAfterClose: number[] = [];
  const notices: Partial<Record<NoticeKind, number>> = {};
  let lastNotice = state.nextNoticeId - 1;
  const countNotices = () => {
    if (state.nextNoticeId - 1 <= lastNotice) return;
    for (const notice of state.notices) if (notice.id > lastNotice) notices[notice.kind] = (notices[notice.kind] ?? 0) + 1;
    lastNotice = state.nextNoticeId - 1;
  };
  const noSubscriberYet = () => state.sales.accounts.length === 0 && state.sales.connectsTotal === 0;
  const promoSeen = new Set<string>(state.sales.incumbentPromos.map((p) => `${p.cabinet}:${p.startDay}`));
  const incumbentPromos: Array<{ cabinet: CabinetId; startDay: number }> = [];
  const countPromos = () => {
    for (const p of state.sales.incumbentPromos) {
      const key = `${p.cabinet}:${p.startDay}`;
      if (promoSeen.has(key)) continue;
      promoSeen.add(key);
      incumbentPromos.push({ cabinet: p.cabinet, startDay: p.startDay });
    }
  };
  const send: Send = (cmd) => {
    const cashBefore = state.finance.cash;
    const result = applyCommand(state, cmd);
    countNotices();
    if (result.ok) {
      commands[cmd.type] = (commands[cmd.type] ?? 0) + 1;
      firstMonth[cmd.type] ??= state.finance.reports.length - startReports + 1;
    } else {
      rejected++;
    }
    opts.afterCommand?.(state, cmd, result, cashBefore);
    return result;
  };
  while (state.finance.reports.length - startReports < months && !state.gameOver) {
    if (noSubscriberYet()) capacityBeforeFirstSubscriber = Math.max(capacityBeforeFirstSubscriber, borrowingCapacity(state));
    if (state.day % BOT_INTERVAL_DAYS === 0) bot.act(state, send);
    const closes = state.finance.reports.length;
    tick(state);
    countNotices();
    if (state.finance.reports.length > closes) {
      capacityAfterClose.push(borrowingCapacity(state));
      countPromos();
    }
    opts.afterTick?.(state);
  }
  const reports = state.finance.reports.slice(startReports);
  const kpis = reports.map((r) => {
    const k = reportKpis(r);
    if (!k) throw new Error('a round-2 month close wrote no stats');
    return k;
  });
  return {
    seed,
    bot: bot.name,
    state,
    reports,
    kpis,
    gameOver: state.gameOver,
    gameOverMonth: state.gameOver ? reports.length : null,
    commands,
    firstMonth,
    rejected,
    ms: opts.clock ? opts.clock() - started : 0,
    capacityAtStart,
    capacityBeforeFirstSubscriber,
    capacityAfterClose,
    notices,
    incumbentPromos,
  };
}

// ---------------------------------------------------------------------------
// Financing measures (round 3)
// ---------------------------------------------------------------------------

/** What the bank would lend now: the credit-line limit plus term-loan capacity (debt.creditLimit + debt.termCapacity). */
export function borrowingCapacity(state: GameState): number {
  return creditLimit(state) + termCapacity(state);
}

/** Total debt at a report's month end (credit line + term loans); 0 for a report without debt stats. */
export function reportDebt(report: MonthlyReport): number {
  return report.debt ? report.debt.creditBalance + report.debt.termBalance : 0;
}

/** Most total debt at any month end of the run. */
export function peakDebt(result: RunResult): number {
  return result.reports.reduce((peak, r) => Math.max(peak, reportDebt(r)), 0);
}

/**
 * Debt-weighted average borrowing rate of the run, bps: sum(total debt x
 * averageRateBps) / sum(total debt) over the month ends with debt (penalty
 * included, as DebtStats records it); null if the run never borrowed.
 * `withoutPenalty`: only month ends whose stage carries no penalty surcharge
 * ('compliant' or 'warning'), i.e. the risk pricing alone.
 */
export function averageBorrowingRate(result: RunResult, withoutPenalty = false): number | null {
  let weighted = 0;
  let total = 0;
  for (const report of result.reports) {
    const debt = reportDebt(report);
    const rate = report.debt?.averageRateBps;
    if (debt <= 0 || rate === null || rate === undefined) continue;
    if (withoutPenalty && penaltyBps(report.debt?.stage ?? 'compliant') > 0) continue;
    weighted += debt * rate;
    total += debt;
  }
  return total > 0 ? weighted / total : null;
}

const STAGE_RANK: Record<CovenantStage, number> = { compliant: 0, warning: 1, penalty: 2, frozen: 3 };

/** The worst covenant stage any close of the run ended in ('compliant' for a run without debt stats). */
export function worstStage(result: RunResult): CovenantStage {
  let worst: CovenantStage = 'compliant';
  for (const report of result.reports) {
    const stage = report.debt?.stage;
    if (stage && STAGE_RANK[stage] > STAGE_RANK[worst]) worst = stage;
  }
  return worst;
}

/** Stage changes of the run as "m7 warning, m8 penalty, ..." entries: [month, stage after that close]. */
export function stageHistory(result: RunResult): Array<[number, CovenantStage]> {
  const changes: Array<[number, CovenantStage]> = [];
  let last: CovenantStage = 'compliant';
  result.reports.forEach((report, i) => {
    const stage = report.debt?.stage ?? 'compliant';
    if (stage !== last) changes.push([i + 1, stage]);
    last = stage;
  });
  return changes;
}

/** Share of the month ends with debt at which lifetime cost per passing was red (metrics.cppBand); null without debt. */
export function redWhileOwingShare(result: RunResult): number | null {
  let owing = 0;
  let red = 0;
  result.reports.forEach((report, i) => {
    if (reportDebt(report) <= 0) return;
    owing++;
    if (result.kpis[i]?.cppBand === 'red') red++;
  });
  return owing > 0 ? red / owing : null;
}

/** 1-based months whose close missed its debt service. */
export function missedPaymentMonths(result: RunResult): number[] {
  const months: number[] = [];
  result.reports.forEach((report, i) => {
    if (report.debt?.missedPayment) months.push(i + 1);
  });
  return months;
}

/** Units on parcels that exist on `day` (appearsDay <= day). */
export function unitsPresent(city: City, day: number): number {
  let units = 0;
  for (const parcel of city.parcels) if (parcel.appearsDay <= day) units += parcel.units;
  return units;
}

/** Last day of the month a report closed. */
export function reportLastDay(report: MonthlyReport): number {
  return dayOf({ year: report.year, month: report.month, day: MONTH_LENGTHS[report.month - 1] as number });
}

/**
 * Share of the town's units passed at the end of 1-based `month`: the report's
 * passings over the units on parcels present on that month's last day (the
 * passings were counted then too); null past the end of the run.
 */
export function passedShare(result: RunResult, month: number): number | null {
  const report = result.reports[month - 1];
  if (!report) return null;
  const units = unitsPresent(result.state.city, reportLastDay(report));
  return units > 0 ? report.passings / units : null;
}

// ---------------------------------------------------------------------------
// Round 4c/4d: cabinet areas over time (switching speed and ceiling)
// ---------------------------------------------------------------------------

/** One cabinet area of a run: when its cabinet went live, its ceiling and its take rate at each close since. */
export interface AreaCurve {
  cabinet: CabinetId;
  liveDay: number;
  /** Passings at the run's end. */
  passings: number;
  /**
   * Its ceiling take rate at the run's end: the target take rate of every
   * unit it passes (sales.stateTakeRate of its kind there, the incumbent's
   * local price and the run's prices) over its passings.
   */
  ceiling: number;
  /** Take rate (subscribed units / passings, CustomerStats.areas) at each close from the one its cabinet went live in, with the whole months since it went live. */
  takes: Array<{ months: number; take: number }>;
}

/** Every cabinet area of the run that went live and is active at its end (CustomerStats.areas at each close, cabinet liveDay). */
export function areaCurves(result: RunResult): AreaCurve[] {
  const { state } = result;
  const service = getService(state);
  const target = new Map<CabinetId, number>();
  for (const [segment, cabinet] of service.servingCabinet) {
    for (const pid of parcelsServedBy(state.city, segment)) {
      const parcel = state.city.parcels[pid];
      if (!parcel || parcel.appearsDay > state.day) continue;
      target.set(cabinet, (target.get(cabinet) ?? 0) + parcel.units * stateTakeRate(state, parcel.kind, cabinet));
    }
  }
  const curves: AreaCurve[] = [];
  for (const cabinet of state.network.cabinets) {
    if (cabinet.liveDay === null || !service.activeCabinets.has(cabinet.id)) continue;
    const passings = service.cabinetCoverage.get(cabinet.id)?.passings ?? 0;
    if (passings <= 0) continue;
    const takes: Array<{ months: number; take: number }> = [];
    for (const report of result.reports) {
      const area = report.customers?.areas.find((a) => a.cabinet === cabinet.id);
      const last = reportLastDay(report);
      if (!area || area.passings <= 0 || last < cabinet.liveDay) continue;
      takes.push({ months: Math.floor(((last - cabinet.liveDay) * 12) / 365), take: area.units / area.passings });
    }
    curves.push({ cabinet: cabinet.id, liveDay: cabinet.liveDay, passings, ceiling: (target.get(cabinet.id) ?? 0) / passings, takes });
  }
  return curves;
}

/**
 * Take rate at the run's end over the cabinet areas lit between
 * `minMonths` and `maxMonths` months before it (units / passings pooled;
 * null when there are none): spec I.7's "take on areas lit 3-5 years".
 */
export function takeOfAreasLit(result: RunResult, minMonths: number, maxMonths: number): number | null {
  let units = 0;
  let passings = 0;
  for (const curve of areaCurves(result)) {
    const months = ((result.state.day - curve.liveDay) * 12) / 365;
    if (months < minMonths || months > maxMonths) continue;
    const last = curve.takes.at(-1);
    if (!last) continue;
    units += last.take * curve.passings;
    passings += curve.passings;
  }
  return passings > 0 ? units / passings : null;
}

/** Whole months after its cabinet went live until an area's take first reached `share` of its ceiling; null if it never did in the run. */
export function monthsToCeiling(curve: AreaCurve, share: number): number | null {
  for (const point of curve.takes) if (point.take >= share * curve.ceiling) return point.months;
  return null;
}

/**
 * Median over the run's areas lit at least `minMonths` before its end of
 * monthsToCeiling(`share`), an area that never got there counting as the
 * months it has been lit plus one (later than any that did); null with no
 * such area.
 */
export function medianMonthsToCeiling(result: RunResult, share: number, minMonths: number): number | null {
  const values: number[] = [];
  for (const curve of areaCurves(result)) {
    const lit = Math.floor(((result.state.day - curve.liveDay) * 12) / 365);
    if (lit < minMonths || curve.ceiling <= 0) continue;
    values.push(monthsToCeiling(curve, share) ?? lit + 1);
  }
  return values.length > 0 ? median(values) : null;
}

/** 1-based month of the first close with operating cash flow > 0, or null. */
export function firstPositiveMonth(result: RunResult): number | null {
  const i = result.kpis.findIndex((k) => k.operatingCashFlow > 0);
  return i < 0 ? null : i + 1;
}

/** Average voluntary churn per month over the run: sum(churned) / sum(month-start subscribers), months with subscribers only. */
export function averageChurn(result: RunResult): number | null {
  let churned = 0;
  let base = 0;
  let prevSubs = 0;
  for (const report of result.reports) {
    const stats = report.stats;
    if (!stats) continue;
    // Subscribers exposed to this close's churn: month-end count plus those who just left.
    const exposed = stats.subscribers + stats.churned;
    if (prevSubs > 0 || exposed > 0) {
      churned += stats.churned;
      base += exposed;
    }
    prevSubs = stats.subscribers;
  }
  return base > 0 ? churned / base : null;
}

/** Mean ARPU over months that billed anyone. */
export function averageArpu(result: RunResult, fromMonth = 1, toMonth = result.kpis.length): number | null {
  const values = result.kpis
    .slice(fromMonth - 1, toMonth)
    .map((k) => k.arpu)
    .filter((v): v is number => v !== null);
  return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

// ---------------------------------------------------------------------------
// Round 4 measures: plant by method, outages, prices, the frozen line
// ---------------------------------------------------------------------------

/** Feet of cable by method at the end of the run (every span, any stage; a rebuilt span counts as underground). */
export function plantFeet(result: RunResult): Record<CableMethod, number> {
  const feet: Record<CableMethod, number> = { aerial: 0, underground: 0 };
  for (const span of result.state.network.spans) feet[span.method] += result.state.city.segments[span.segment]?.lengthFt ?? 0;
  return feet;
}

/** Underground share of the run's plant by feet (plantFeet); null with no plant. */
export function undergroundShare(result: RunResult): number | null {
  const feet = plantFeet(result);
  const total = feet.aerial + feet.underground;
  return total > 0 ? feet.underground / total : null;
}

/** Round-4 operating figures (MonthlyReport.ops) summed over the run, with the month's voluntary churn. */
export interface OpsTotals {
  churned: number;
  priceChurn: number;
  outageChurn: number;
  incumbentChurn: number;
  tierMoves: number;
  outageUnitDays: number;
  storms: number;
  spansDamaged: number;
  repairs: number;
  /** Months x incumbent promos running in them (ops.incumbentPromos summed). */
  incumbentPromoMonths: number;
  revenue: number;
}

export function opsTotals(result: RunResult): OpsTotals {
  const totals: OpsTotals = {
    churned: 0,
    priceChurn: 0,
    outageChurn: 0,
    incumbentChurn: 0,
    tierMoves: 0,
    outageUnitDays: 0,
    storms: 0,
    spansDamaged: 0,
    repairs: 0,
    incumbentPromoMonths: 0,
    revenue: 0,
  };
  for (const report of result.reports) {
    totals.churned += report.stats?.churned ?? 0;
    totals.revenue += report.totals.revenue ?? 0;
    const ops = report.ops;
    if (!ops) continue;
    totals.priceChurn += ops.priceChurn;
    totals.outageChurn += ops.outageChurn;
    totals.incumbentChurn += ops.incumbentChurn;
    totals.tierMoves += ops.tierMoves;
    totals.outageUnitDays += ops.outageUnitDays;
    totals.storms += ops.storms;
    totals.spansDamaged += ops.spansDamaged;
    totals.repairs += ops.repairs;
    totals.incumbentPromoMonths += ops.incumbentPromos;
  }
  return totals;
}

/** Sum of the monthly operating cash flow (financing and capex excluded) over months 1..toMonth. */
export function cumulativeOperatingCashFlow(result: RunResult, toMonth = result.kpis.length): number {
  let flow = 0;
  for (const kpi of result.kpis.slice(0, toMonth)) flow += kpi.operatingCashFlow;
  return flow;
}

/** What owning the run's plant costs a year at its last close: pole rent on its aerial spans and the expected storm and dig-in repairs (weather.stormRisk by method). */
export function plantRunningCostPerYear(result: RunResult): { poleRent: number; repairs: number } {
  const { state } = result;
  let poles = 0;
  let repairs = 0;
  for (const span of state.network.spans) {
    const segment = state.city.segments[span.segment];
    if (!segment) continue;
    if (span.method === 'aerial') poles += polesOnSegment(segment);
    repairs += stormRisk(state, segment, span.method).repairCostPerYear;
  }
  return { poleRent: poles * POLE_RENT_PER_POLE_PER_MONTH * 12, repairs };
}

/** What storms are expected to cost the run's plant a year at its last close (weather.stormRisk per span, by its method). */
export interface StormExposure {
  /** Repair dollars. */
  repairs: number;
  /** Subscriber-days without service: each span's expected days out x the subscribers on its street. */
  subscriberDaysOut: number;
  /** Cancellations: each span's expected outages x its street's subscribers x the outage churn of an average outage. */
  outageChurn: number;
}

/**
 * The run's storm exposure (StormExposure) at its last close. Realized storm
 * losses (MonthlyReport.ops) depend on where the storms happened to fall, and
 * two runs of one seed see different storms once their plant differs (each
 * storm draws per span in its area from the weather stream), so comparing
 * strategies on a few seeds compares their luck as much as their plant; this
 * compares the plant.
 */
export function stormExposure(result: RunResult): StormExposure {
  const { state } = result;
  const subscribers = new Map<SegmentId, number>();
  for (const account of state.sales.accounts) {
    const parcel = state.city.parcels[account.parcel];
    if (!parcel) continue;
    let units = 0;
    for (const id of Object.keys(account.tierUnits) as TierId[]) units += account.tierUnits[id];
    subscribers.set(parcel.segment, (subscribers.get(parcel.segment) ?? 0) + units);
  }
  const exposure: StormExposure = { repairs: 0, subscriberDaysOut: 0, outageChurn: 0 };
  for (const span of state.network.spans) {
    const segment = state.city.segments[span.segment];
    if (!segment) continue;
    const risk = stormRisk(state, segment, span.method);
    const subs = subscribers.get(span.segment) ?? 0;
    exposure.repairs += risk.repairCostPerYear;
    exposure.subscriberDaysOut += risk.outageDaysPerYear * subs;
    exposure.outageChurn += risk.outagesPerYear * subs * outageChurnProbability(meanOutageDays(span.method, streetCanopy(state.city, segment)));
  }
  return exposure;
}

/**
 * Cost per passing over `years` of owning the plant: lifetime outside-plant
 * capex plus `years` x its yearly running cost (plantRunningCostPerYear),
 * over the passings at the last close; null with nothing passed. The
 * aerial-versus-underground trade-off in one figure: aerial is cheaper up
 * front and dearer to own, underground the reverse.
 */
export function ownershipCostPerPassing(result: RunResult, years = VALUE_YEARS): number | null {
  const last = result.reports.at(-1);
  if (!last || last.passings <= 0) return null;
  const running = plantRunningCostPerYear(result);
  return (result.state.finance.capex.osp + years * (running.poleRent + running.repairs)) / last.passings;
}

/**
 * Years of trailing operating cash flow runValue counts (and the years
 * ownershipCostPerPassing counts running costs for): round 4's horizon for
 * SMART's method choice (round 4b weighs storms twice over 13 years:
 * SMART_DEFAULTS.horizonYears, stormWeight).
 */
export const VALUE_YEARS = 12;

/**
 * What the run has built, valued at its last close: cash - debt + `years` x
 * the operating cash flow of the last 12 closes (fewer at the start). A
 * long-run view: plant that costs more up front but less to run (pole rent,
 * repairs, outage churn) shows here, while cumulative cash flow only sees
 * the first five years. A run that ended in game over is worth its cash less
 * its debt only.
 */
export function runValue(result: RunResult, years = VALUE_YEARS): number {
  const last = result.reports.at(-1);
  if (!last) return result.state.finance.cash;
  const debt = reportDebt(last);
  if (result.gameOver) return last.cashEnd - debt;
  const trailing = result.kpis.slice(-12);
  let flow = 0;
  for (const kpi of trailing) flow += kpi.operatingCashFlow;
  const annual = trailing.length > 0 ? (flow * 12) / trailing.length : 0;
  return last.cashEnd - debt + years * annual;
}

/**
 * The run deleveraged through the frozen line's call: some close had the
 * loans called (DebtStats.accelerationClosesLeft set) and a later close owed
 * nothing. 1-based month of that close, else null.
 */
export function repaidAfterCall(result: RunResult): number | null {
  let called = false;
  for (let i = 0; i < result.reports.length; i++) {
    const report = result.reports[i] as MonthlyReport;
    if (report.debt?.accelerationClosesLeft != null) called = true;
    else if (called && reportDebt(report) === 0) return i + 1;
  }
  return null;
}

/** 1-based month of the first close that ended frozen, or null. */
export function firstFrozenMonth(result: RunResult): number | null {
  const i = result.reports.findIndex((r) => r.debt?.stage === 'frozen');
  return i < 0 ? null : i + 1;
}

/** Share of the town passed at the run's last close (passedShare of its last month); 0 for a run with no closes. */
export function finalPassedShare(result: RunResult): number {
  return passedShare(result, result.reports.length) ?? 0;
}

// ---------------------------------------------------------------------------
// Round 4: the constant-price sweep
// ---------------------------------------------------------------------------

/** Price multipliers the sweep tries, x every tier's TIER_DEFAULTS price. */
export const PRICE_SWEEP_MULTIPLIERS: readonly number[] = [0.7, 0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6];

/** Household prices `multiplier` x TIER_DEFAULTS (rounded, within TIER_PRICE_MIN..TIER_PRICE_MAX), every tier offered. */
export function scaledPrices(multiplier: number): Array<{ id: TierId; price: number; offered: boolean }> {
  return TIER_DEFAULTS.map((t) => ({
    id: t.id,
    price: Math.min(TIER_PRICE_MAX, Math.max(TIER_PRICE_MIN, Math.round(t.price * multiplier))),
    offered: true,
  }));
}

/**
 * `makeInner` (a bot that keeps whatever prices it finds, e.g. SMART), with
 * every tier set to `multiplier` x its TIER_DEFAULTS price before its first
 * look and kept there (SMB multiplier at its default).
 */
export function constantPriceBot(makeInner: BotFactory, multiplier: number): BotFactory {
  return (seed) => {
    const inner = makeInner(seed);
    let set = multiplier === 1;
    return {
      name: `${inner.name}@${multiplier}`,
      act(state, send) {
        if (!set) set = send({ type: 'setPricing', tiers: scaledPrices(multiplier), smbMultiplier: SMB_MULTIPLIER_DEFAULT }).ok;
        inner.act(state, send);
      },
    };
  };
}

export interface SweepPoint {
  multiplier: number;
  /** Mean over the seeds of cumulative operating cash flow to the last month (cumulativeOperatingCashFlow). */
  operatingCashFlow: number;
  /** Mean runValue over the seeds. */
  value: number;
  /** Means over the seeds: share passed, subscribers and take rate at the last close, ARPU and churn over the run. */
  passedShare: number;
  subscribers: number;
  takeRate: number;
  arpu: number;
  churn: number;
  /** Seeds that ended in game over. */
  gameOvers: number;
}

/**
 * The constant-price sweep: `makeInner` at each multiplier (constantPriceBot)
 * on every seed for `months`, averaged per multiplier.
 */
export function priceSweep(
  seeds: readonly number[],
  makeInner: BotFactory,
  months: number,
  multipliers: readonly number[] = PRICE_SWEEP_MULTIPLIERS,
): SweepPoint[] {
  return multipliers.map((multiplier) => {
    const point: SweepPoint = { multiplier, operatingCashFlow: 0, value: 0, passedShare: 0, subscribers: 0, takeRate: 0, arpu: 0, churn: 0, gameOvers: 0 };
    for (const seed of seeds) {
      const run = runBot(seed, constantPriceBot(makeInner, multiplier), months);
      point.operatingCashFlow += cumulativeOperatingCashFlow(run) / seeds.length;
      point.value += runValue(run) / seeds.length;
      point.passedShare += finalPassedShare(run) / seeds.length;
      point.subscribers += (run.reports.at(-1)?.stats?.subscribers ?? 0) / seeds.length;
      point.takeRate += (run.kpis.at(-1)?.takeRate ?? 0) / seeds.length;
      point.arpu += (averageArpu(run) ?? 0) / seeds.length;
      point.churn += (averageChurn(run) ?? 0) / seeds.length;
      if (run.gameOver) point.gameOvers++;
    }
    return point;
  });
}

/** The sweep point with the highest cumulative operating cash flow (the first on a tie). */
export function bestSweepPoint(points: readonly SweepPoint[]): SweepPoint | null {
  let best: SweepPoint | null = null;
  for (const point of points) if (!best || point.operatingCashFlow > best.operatingCashFlow) best = point;
  return best;
}

// ---------------------------------------------------------------------------
// Town facts
// ---------------------------------------------------------------------------

export interface TownFacts {
  /** Units on parcels present on day 0, and at full growth. */
  unitsDay0: number;
  unitsFull: number;
  streetFt: number;
  /** Shares of street length with poles / on rock. */
  poledShare: number;
  rockShare: number;
  /** Street feet per day-0 unit, by the zone of the serving street (null: no units). */
  ftPerUnit: Record<Zone, number | null>;
}

export function townFacts(city: City): TownFacts {
  let unitsDay0 = 0;
  let unitsFull = 0;
  let streetFt = 0;
  let poled = 0;
  let rock = 0;
  const zoneFt: Record<Zone, number> = { downtown: 0, residential: 0, industrial: 0, rural: 0 };
  const zoneUnits: Record<Zone, number> = { downtown: 0, residential: 0, industrial: 0, rural: 0 };
  for (const seg of city.segments) {
    streetFt += seg.lengthFt;
    if (seg.hasPoles) poled += seg.lengthFt;
    if (seg.rock) rock += seg.lengthFt;
    zoneFt[seg.zone] += seg.lengthFt;
  }
  for (const parcel of city.parcels) {
    unitsFull += parcel.units;
    if (parcel.appearsDay > 0) continue;
    unitsDay0 += parcel.units;
    const seg = city.segments[parcel.segment];
    if (seg) zoneUnits[seg.zone] += parcel.units;
  }
  const ftPerUnit = {} as Record<Zone, number | null>;
  for (const zone of Object.keys(zoneFt) as Zone[]) {
    ftPerUnit[zone] = zoneUnits[zone] > 0 ? zoneFt[zone] / zoneUnits[zone] : null;
  }
  return {
    unitsDay0,
    unitsFull,
    streetFt,
    poledShare: streetFt > 0 ? poled / streetFt : 0,
    rockShare: streetFt > 0 ? rock / streetFt : 0,
    ftPerUnit,
  };
}

/** Cheapest buildable method on a segment (aerial where poled and not dearer) and its charges before fees. */
export function cheapestMethod(segment: StreetSegment): { method: CableMethod; cost: number } {
  const underground = spanCharges(segment, 'underground').total;
  if (segment.hasPoles) {
    const aerial = spanCharges(segment, 'aerial').total;
    if (aerial <= underground) return { method: 'aerial', cost: aerial };
  }
  return { method: 'underground', cost: underground };
}

/** Feet of street per cable order assumed by townBuildOut (a typical drag-to-draw order). */
export const BUILD_OUT_ORDER_FT = 2_000;

export interface TownBuildOut {
  /** Every segment cabled with its cheaper buildable method (spanCharges totals). */
  cable: number;
  /** Per-order fees, one order per BUILD_OUT_ORDER_FT of street of each method. */
  fees: number;
  /** Cabinets in the greedy cover. */
  cabinets: number;
  /** cabinets x (CABINET_COST + SPLITTER_COST). */
  cabinetCost: number;
  total: number;
}

/**
 * What it costs to light the whole town: every street segment cabled the
 * cheaper buildable way, per-order fees at one order per BUILD_OUT_ORDER_FT of
 * street, and a greedy cabinet cover (repeatedly the corner whose street reach
 * covers the most still-uncovered segments that serve parcels, present or
 * future, until all are covered) at CABINET_COST + SPLITTER_COST each.
 */
export function townBuildOut(city: City): TownBuildOut {
  let cable = 0;
  const methodFt: Record<CableMethod, number> = { aerial: 0, underground: 0 };
  for (const seg of city.segments) {
    const cheapest = cheapestMethod(seg);
    cable += cheapest.cost;
    methodFt[cheapest.method] += seg.lengthFt;
  }
  let fees = 0;
  for (const method of ['aerial', 'underground'] as const) {
    fees += Math.ceil(methodFt[method] / BUILD_OUT_ORDER_FT) * orderFees(method);
  }

  const serving = new Set<SegmentId>();
  for (const parcel of city.parcels) serving.add(parcel.segment);
  const reachOf = city.nodes.map((node) =>
    segmentsWithin(city, node.id, CABINET_REACH_FT)
      .map((r) => r.segment)
      .filter((s) => serving.has(s)),
  );
  const uncovered = new Set(serving);
  let cabinets = 0;
  while (uncovered.size > 0) {
    let best = -1;
    let bestCount = 0;
    reachOf.forEach((segments, node) => {
      let count = 0;
      for (const s of segments) if (uncovered.has(s)) count++;
      if (count > bestCount) {
        bestCount = count;
        best = node;
      }
    });
    if (best < 0) break; // unreachable leftovers (cannot happen on a connected town)
    for (const s of reachOf[best] ?? []) uncovered.delete(s);
    cabinets++;
  }
  const cabinetCost = cabinets * (CABINET_COST + SPLITTER_COST);
  return { cable, fees, cabinets, cabinetCost, total: cable + fees + cabinetCost };
}

// ---------------------------------------------------------------------------
// Cost-per-passing probes: quoteCable on typical single-order runs
// ---------------------------------------------------------------------------

export const PROBE_MIN_FT = 1_500;
export const PROBE_MAX_FT = 2_500;
/** A "dense" run has at least one day-0 unit per this many feet of street. */
export const DENSE_FT_PER_UNIT = 35;
/** Rural runs may bridge onto non-rural streets this sparse (ft per unit or more). */
const RURAL_BRIDGE_FT_PER_UNIT = 120;
/** Share of a rural run's length that must be rural-zone street. */
const RURAL_MIN_SHARE = 0.6;

export interface CppProbe {
  segments: SegmentId[];
  method: CableMethod;
  lengthFt: number;
  cost: number;
  passings: number;
  /** quoteCable(...).cpp: cost (fees included) per unit passed along the run. */
  cpp: number;
}

export interface CppProbes {
  denseAerial: CppProbe[];
  denseUnderground: CppProbe[];
  rural: CppProbe[];
}

function day0Units(city: City, segment: SegmentId): number {
  let units = 0;
  for (const pid of parcelsServedBy(city, segment)) {
    const parcel = city.parcels[pid];
    if (parcel && parcel.appearsDay === 0) units += parcel.units;
  }
  return units;
}

interface RunRules {
  /** A run may start on this segment. */
  start: (seg: StreetSegment) => boolean;
  /** A run may grow onto this segment. */
  allowed: (seg: StreetSegment) => boolean;
  /** Growth takes the allowed neighbour with the highest preference (ties: lower id). */
  prefer: (seg: StreetSegment) => number;
  /** A finished run of PROBE_MIN_FT..PROBE_MAX_FT is kept when this accepts it. */
  accept: (run: readonly SegmentId[]) => boolean;
}

/**
 * Disjoint connected runs of PROBE_MIN_FT..PROBE_MAX_FT: from each unused
 * start segment (ascending id), repeatedly add the most preferred allowed
 * neighbour that still fits, until the run is long enough.
 */
function growRuns(city: City, rules: RunRules): SegmentId[][] {
  const used = new Set<SegmentId>();
  const runs: SegmentId[][] = [];
  for (const start of city.segments) {
    if (used.has(start.id) || !rules.start(start)) continue;
    const run: SegmentId[] = [start.id];
    const inRun = new Set<SegmentId>(run);
    let ft = start.lengthFt;
    while (ft < PROBE_MIN_FT) {
      let best: StreetSegment | null = null;
      for (const id of run) {
        const seg = city.segments[id] as StreetSegment;
        for (const node of [seg.a, seg.b]) {
          for (const next of segmentsAtNode(city, node)) {
            if (inRun.has(next) || used.has(next)) continue;
            const nseg = city.segments[next] as StreetSegment;
            if (!rules.allowed(nseg) || ft + nseg.lengthFt > PROBE_MAX_FT) continue;
            const better =
              best === null ||
              rules.prefer(nseg) > rules.prefer(best) ||
              (rules.prefer(nseg) === rules.prefer(best) && nseg.id < best.id);
            if (better) best = nseg;
          }
        }
      }
      if (!best) break;
      run.push(best.id);
      inRun.add(best.id);
      ft += best.lengthFt;
    }
    if (ft >= PROBE_MIN_FT && ft <= PROBE_MAX_FT && rules.accept(run)) {
      for (const id of run) used.add(id);
      runs.push(run);
    }
  }
  return runs;
}

function probe(state: GameState, segments: SegmentId[], method: CableMethod): CppProbe | null {
  const quote = quoteCable(state, segments, method);
  if (quote.cpp === null || quote.newSegments.length !== segments.length) return null;
  return { segments, method, lengthFt: quote.lengthFt, cost: quote.cost, passings: quote.passingsAlong, cpp: quote.cpp };
}

/**
 * Cost per passing of typical single orders on a fresh game of `seed` (day
 * 0): dense poled residential/downtown runs quoted aerial and underground, and
 * rural runs quoted aerial when every segment is poled, else underground
 * (runs that pass nobody are skipped). Quotes are made with ample cash (cash
 * never changes a quote's cpp).
 */
export function cppProbes(seed: number): CppProbes {
  const state = newGame(seed);
  state.finance.cash = Number.MAX_SAFE_INTEGER;
  const { city } = state;
  const units = city.segments.map((seg) => day0Units(city, seg.id));
  const unitsOf = (id: SegmentId) => units[id] ?? 0;
  const lengthOf = (run: readonly SegmentId[]) => run.reduce((ft, id) => ft + (city.segments[id] as StreetSegment).lengthFt, 0);
  const townStreet = (seg: StreetSegment) => seg.hasPoles && (seg.zone === 'residential' || seg.zone === 'downtown');

  // (a)/(b) Dense poled residential/downtown: at least one unit per DENSE_FT_PER_UNIT
  // over the whole run (a run may cross a short side street with no lots).
  const dense = growRuns(city, {
    start: (seg) => townStreet(seg) && unitsOf(seg.id) * DENSE_FT_PER_UNIT >= seg.lengthFt,
    allowed: townStreet,
    prefer: (seg) => unitsOf(seg.id) / seg.lengthFt,
    accept: (run) => run.reduce((u, id) => u + unitsOf(id), 0) * DENSE_FT_PER_UNIT >= lengthOf(run),
  });
  // (c) Rural: mostly rural-zone streets; rural lanes are short, so a run may
  // continue onto sparse (under one unit per RURAL_BRIDGE_FT_PER_UNIT) non-downtown streets.
  const isRural = (seg: StreetSegment) => seg.zone === 'rural';
  const rural = growRuns(city, {
    start: isRural,
    allowed: (seg) => isRural(seg) || (seg.zone !== 'downtown' && unitsOf(seg.id) * RURAL_BRIDGE_FT_PER_UNIT <= seg.lengthFt),
    prefer: (seg) => (isRural(seg) ? 1 : 0),
    accept: (run) => {
      const ruralFt = run.reduce((ft, id) => ft + (isRural(city.segments[id] as StreetSegment) ? (city.segments[id] as StreetSegment).lengthFt : 0), 0);
      return ruralFt >= RURAL_MIN_SHARE * lengthOf(run);
    },
  });

  const out: CppProbes = { denseAerial: [], denseUnderground: [], rural: [] };
  for (const run of dense) {
    const aerial = probe(state, run, 'aerial');
    const underground = probe(state, run, 'underground');
    if (aerial) out.denseAerial.push(aerial);
    if (underground) out.denseUnderground.push(underground);
  }
  for (const run of rural) {
    const poled = run.every((id) => (city.segments[id] as StreetSegment).hasPoles);
    const result = probe(state, run, poled ? 'aerial' : 'underground');
    if (result) out.rural.push(result);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Street-graph helpers for bots
// ---------------------------------------------------------------------------

/** Shortest-path tree from `from` over street length, bounded to nodes closer than `limitFt`. */
export interface StreetTree {
  dist: Map<number, number>;
  /** Segment used to reach each node (absent for `from`). */
  via: Map<number, SegmentId>;
}

export function streetTree(city: City, from: number, limitFt: number): StreetTree {
  const dist = new Map<number, number>([[from, 0]]);
  const via = new Map<number, SegmentId>();
  const done = new Set<number>();
  // Small graphs (a few hundred nodes): a linear-scan frontier is plenty.
  const frontier = new Set<number>([from]);
  while (frontier.size > 0) {
    let u = -1;
    let best = Infinity;
    for (const n of frontier) {
      const d = dist.get(n) as number;
      if (d < best || (d === best && n < u)) {
        best = d;
        u = n;
      }
    }
    frontier.delete(u);
    done.add(u);
    for (const segId of segmentsAtNode(city, u)) {
      const seg = city.segments[segId] as StreetSegment;
      const v = otherEnd(seg, u);
      if (done.has(v)) continue;
      const d = best + seg.lengthFt;
      if (d >= limitFt) continue;
      const cur = dist.get(v);
      if (cur === undefined || d < cur) {
        dist.set(v, d);
        via.set(v, segId);
        frontier.add(v);
      }
    }
  }
  return { dist, via };
}

/** Segments on the tree path from the tree's root to `node` (empty for the root or an unreached node). */
export function treePath(city: City, tree: StreetTree, node: number): SegmentId[] {
  const path: SegmentId[] = [];
  let at = node;
  for (let guard = 0; guard < city.nodes.length; guard++) {
    const seg = tree.via.get(at);
    if (seg === undefined) break;
    path.push(seg);
    at = otherEnd(city.segments[seg] as StreetSegment, at);
  }
  return path;
}

// ---------------------------------------------------------------------------
// Round 4b: storm exposure bands
// ---------------------------------------------------------------------------

/** Share of a town's street feet in each storm-exposure band (weather.exposureBand of weather.segmentExposure). */
export function exposureBandShares(city: City): Record<ExposureBand, number> {
  const exposure = cityExposure(city);
  const feet: Record<ExposureBand, number> = { sheltered: 0, moderate: 0, exposed: 0 };
  let total = 0;
  for (const seg of city.segments) {
    feet[exposureBand(exposure[seg.id] ?? 1)] += seg.lengthFt;
    total += seg.lengthFt;
  }
  for (const band of Object.keys(feet) as ExposureBand[]) feet[band] = total > 0 ? feet[band] / total : 0;
  return feet;
}

/**
 * Expected storm damage per span-year of aerial cable in each exposure band:
 * weather.stormRisk(..., 'aerial').outagesPerYear averaged over the town's
 * poled streets in the band (0 for a band with none).
 */
export function expectedDamageByBand(state: GameState): Record<ExposureBand, number> {
  const exposure = cityExposure(state.city);
  const sum: Record<ExposureBand, number> = { sheltered: 0, moderate: 0, exposed: 0 };
  const count: Record<ExposureBand, number> = { sheltered: 0, moderate: 0, exposed: 0 };
  for (const seg of state.city.segments) {
    if (!seg.hasPoles) continue;
    const band = exposureBand(exposure[seg.id] ?? 1);
    sum[band] += stormRisk(state, seg, 'aerial').outagesPerYear;
    count[band]++;
  }
  for (const band of Object.keys(sum) as ExposureBand[]) sum[band] = count[band] > 0 ? sum[band] / count[band] : 0;
  return sum;
}
