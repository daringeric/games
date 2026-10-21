import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ACCELERATION_WARNING_CLOSES,
  FROZEN_ACCELERATION_CLOSES,
  INSOLVENCY_GRACE_MONTHS,
  MARKETING_MAX_PER_MONTH,
  MAX_SPLITTERS_PER_CABINET,
  OLT_MAX_CARDS,
  OLT_PORTS_PER_CARD,
  SMB_MULTIPLIER_MAX,
  TERM_LOAN_MIN,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
} from './balance';
import { dateOf, MONTH_LENGTHS } from './calendar';
import { closesUntilAcceleration, creditAvailable, newDebt, termCapacity, totalDebt, trailingArr } from './debt';
import { applyCommand, newGame, runDays, tick } from './game';
import { getService } from './network';
import { deserialize, fnv1a, hashState, SaveError, serialize } from './save';
import { deriveSeed } from './rng';
import { newSales, subscriberUnits } from './sales';
import { nearestNode, nearestSegment } from './streets';
import { makeGridCity } from './testing/fixtures';
import type { GridCityOptions } from './testing/fixtures';
import type { GameState } from './types';
import { newWeather } from './weather';

// Parsed saves are untyped JSON; the corruption tests poke at them freely.
type Save = any;

/** Every fourth lot is a 12-unit apartment building and every other fourth a business. */
const MIXED_LOTS: GridCityOptions['parcelKinds'] = (p) =>
  p.id % 4 === 0 ? { kind: 'mdu', units: 12 } : p.id % 4 === 2 ? { kind: 'smb', units: 1 } : undefined;

/**
 * A game mid-flight and mid-month (Mar 25): live and permitting spans, a live
 * cabinet, closed months, open month-to-date entries, subscribers on homes,
 * businesses and apartment buildings (with building routers), a half-accrued
 * month, a milestone and its notice. Default grid: horizontal segments 0..8,
 * vertical 9..16, CO at node 0.
 */
function playedGame(cityOpts: GridCityOptions = {}): GameState {
  const state = newGame(7, { city: makeGridCity({ parcelKinds: MIXED_LOTS, ...cityOpts }) });
  applyCommand(state, { type: 'setMarketing', perMonth: Math.min(20_000, MARKETING_MAX_PER_MONTH) });
  applyCommand(state, { type: 'placeCabinet', node: 0 });
  applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
  applyCommand(state, { type: 'layCable', segments: [2], method: 'aerial' });
  runDays(state, 80);
  applyCommand(state, { type: 'layCable', segments: [1], method: 'underground' });
  runDays(state, 3);
  return state;
}

/**
 * playedGame on credit: the closed months are given TERM_LOAN_MIN more
 * revenue each (something to lend against), and so is the March under way
 * (so the March close does not dip lending ARR below the drawn line: round 4
 * smooths ARR to at most ARR_SPIKE_CAP x the weakest trailing month), then
 * the real commands draw half
 * the credit line and take a term loan, the game closes March with debt
 * service and report.debt, and a little more is drawn in April so the line
 * has dollar-days. `max` borrows everything the bank offers instead.
 */
function borrowedGame(cityOpts: GridCityOptions = {}, max = false): GameState {
  const state = playedGame(cityOpts);
  for (const report of state.finance.reports) {
    report.totals.revenue = (report.totals.revenue ?? 0) + TERM_LOAN_MIN;
    report.net += TERM_LOAN_MIN;
  }
  state.sales.month.revenueDollarDays += TERM_LOAN_MIN * MONTH_LENGTHS[dateOf(state.day).month]!;
  const draw = max ? creditAvailable(state) : Math.floor(creditAvailable(state) / 2);
  const loan = max ? termCapacity(state) : TERM_LOAN_MIN;
  expect(applyCommand(state, { type: 'drawCredit', amount: draw })).toEqual({ ok: true, cost: -draw });
  expect(applyCommand(state, { type: 'takeTermLoan', amount: loan, termYears: 5 })).toEqual({ ok: true, cost: -loan });
  runDays(state, 10);
  expect(state.finance.reports.at(-1)?.debt?.termBalance).toBe(loan);
  expect(applyCommand(state, { type: 'drawCredit', amount: 1 }).ok).toBe(!max);
  runDays(state, 2);
  return state;
}

/** The default lineup as setPricing tiers, with optional price overrides. */
function tierSettings(prices: Record<string, number> = {}): Array<{ id: string; price: number; offered: boolean }> {
  return TIER_DEFAULTS.map((t) => ({ id: t.id, price: prices[t.id] ?? t.price, offered: true }));
}

/** A storm outage on a live span, as weather.stepWeather writes one. */
function outage(storm = 1): Save {
  return { cause: 'storm', storm, startDay: 0, daysLeft: 3, repairCost: 1_500 };
}

/**
 * Give a parsed current-version save every round-4 record, shaped as the
 * round-4 rules write them: a logged storm and its outage on a live span
 * (made aerial) that is also being converted underground, the month's outage
 * totals and repair entry, a subscriber cut off for 2 days, a grandfathered price lock, an intro promo, an
 * incumbent promo on the first cabinet, a frozen line the bank has called,
 * and the first report's ops and round-4 debt figures.
 */
function populateRound4(s: Save): void {
  const span = s.network.spans.find((x: Save) => x.stage === 'live');
  span.method = 'aerial';
  span.outage = outage(1);
  span.conversion = { stage: 'permitting', stageDaysLeft: 10, constructDays: 2, cost: 9_000, orderedDay: s.day };
  s.weather = {
    storms: [{ id: 1, day: Math.max(0, s.day - 1), x: 1, y: 1, radius: 8, severity: 2, spans: [span.id], repairCost: 1_500 }],
    nextStormId: 2,
    month: { segmentOutageDays: [{ segment: 0, days: 1 }, { segment: 1, days: 2 }], outageUnitDays: 5, storms: 1, spansDamaged: 1, repairs: 1_500 },
    cutOff: [{ parcel: s.sales.accounts[0].parcel, days: 2, charged: 0, units: 1 }],
  };
  s.finance.monthToDate.push({ day: s.day, category: 'repair', amount: -1_500, memo: 'Storm repairs' });
  s.finance.cash -= 1_500;
  const account = s.sales.accounts[0];
  const tier = (['fiber500', 'fiber1g', 'fiber2g'] as const).find((t) => account.tierUnits[t] > 0);
  account.locks = [{ tier, price: 50, untilDay: s.day + 40, reason: 'grandfather' }];
  s.sales.promo = { percentOff: 20, months: 3 };
  s.sales.incumbentPromos = [{ cabinet: s.network.cabinets[0].id, startDay: s.day, endDay: s.day + 90, price: 55, quietUntil: s.day + 270 }];
  s.debt.credit.balance = 5_000;
  s.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
  s.debt.frozenCloses = 6;
  s.debt.acceleration = { day: s.day, closesLeft: 2 };
  Object.assign(s.finance.reports[0].ops, { storms: 1, spansDamaged: 1, repairs: 1_500, outageUnitDays: 5 });
  Object.assign(s.finance.reports[0].debt, { sweep: 1_000, frozenCloses: 6, accelerationClosesLeft: 2 });
}

function expectSaveError(json: string, message: RegExp): void {
  let error: unknown;
  try {
    deserialize(json);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SaveError);
  expect((error as SaveError).name).toBe('SaveError');
  expect((error as SaveError).message).toMatch(message);
}

describe('serialize / deserialize', () => {
  it('round-trips a fresh game', () => {
    const state = newGame(1, { city: makeGridCity() });
    const loaded = deserialize(serialize(state));
    expect(loaded).toEqual(state);
    expect(serialize(loaded)).toBe(serialize(state));
  });

  it('round-trips a game in progress, mid-month, with subscribers', () => {
    const state = playedGame();
    // Make sure the save really covers every kind of record.
    expect(state.network.spans.map((s) => s.stage)).toContain('live');
    expect(state.network.spans.map((s) => s.stage)).toContain('permitting');
    expect(state.network.cabinets[0]?.stage).toBe('live');
    expect(state.finance.reports.length).toBeGreaterThanOrEqual(1);
    expect(state.finance.reports.every((r) => r.stats !== undefined)).toBe(true);
    expect(state.finance.monthToDate.length).toBeGreaterThan(0);
    expect(state.sales.accounts.length).toBeGreaterThan(1);
    expect(state.sales.routerParcels.length).toBeGreaterThan(0);
    expect(state.sales.month.revenueDollarDays).toBeGreaterThan(0);
    expect(state.milestones.length).toBeGreaterThan(0);
    expect(state.notices.length).toBeGreaterThan(0);
    expect(state.finance.capex.connect).toBeGreaterThan(0);

    const loaded = deserialize(serialize(state));
    expect(loaded).toEqual(state);
    expect(loaded).not.toBe(state);
    expect(getService(loaded).passings).toBe(getService(state).passings);
    expect(subscriberUnits(loaded)).toBe(subscriberUnits(state));
  });

  it('round-trips a finished game, which stays finished', () => {
    const state = playedGame();
    state.finance.cash = -1;
    state.finance.negativeMonths = INSOLVENCY_GRACE_MONTHS - 1;
    while (!state.gameOver) tick(state);
    const loaded = deserialize(serialize(state));
    expect(loaded).toEqual(state);
    const frozen = serialize(loaded);
    tick(loaded);
    expect(applyCommand(loaded, { type: 'setMarketing', perMonth: 0 }).ok).toBe(false);
    expect(serialize(loaded)).toBe(frozen);
  });

  it('loads saves made under other balance rules', () => {
    // Commands enforce the current rules; a save only has to be playable.
    const save: Save = JSON.parse(serialize(playedGame()));
    save.sales.pricing.tiers[0].price = TIER_PRICE_MAX * 3;
    save.sales.pricing.tiers[1].offered = false;
    save.sales.pricing.smbMultiplier = SMB_MULTIPLIER_MAX * 2;
    save.sales.marketingPerMonth = MARKETING_MAX_PER_MONTH * 5;
    save.network.olt.cards = OLT_MAX_CARDS + 4;
    save.network.olt.ponPorts = (OLT_MAX_CARDS + 4) * OLT_PORTS_PER_CARD;
    save.network.cabinets[0].splitters = MAX_SPLITTERS_PER_CABINET + 3;
    save.finance.negativeMonths = INSOLVENCY_GRACE_MONTHS + 2;
    const state = deserialize(JSON.stringify(save));
    runDays(state, 40);
    expect(state.day).toBeGreaterThan(save.day);
  });

  it('upgrades a round-2 save from before installs had their own notices', () => {
    const state = playedGame();
    const save: Save = JSON.parse(serialize(state));
    // The early round-2 shape: a v2 save (no debt) with no flag, and install notices posted as cash warnings.
    save.schemaVersion = 2;
    delete save.debt;
    delete save.sales.installsPaused;
    const at = save.nextNoticeId;
    save.notices.push(
      { id: at, day: save.day, kind: 'insolvencyWarning', message: 'Installs paused: cash is short', cabinet: null, milestone: null },
      { id: at + 1, day: save.day, kind: 'insolvencyWarning', message: 'Installs resumed: cash is back', cabinet: null, milestone: null },
      { id: at + 2, day: save.day, kind: 'insolvencyWarning', message: 'Installs paused: short again', cabinet: null, milestone: null },
      { id: at + 3, day: save.day, kind: 'insolvencyWarning', message: 'Cash is below zero', cabinet: null, milestone: null },
    );
    save.nextNoticeId = at + 4;
    const loaded = deserialize(JSON.stringify(save));
    expect(loaded.sales.installsPaused).toBe(true);
    expect(loaded.notices.slice(-4).map((n) => n.kind)).toEqual(['installsPaused', 'installsResumed', 'installsPaused', 'insolvencyWarning']);
    // Same key order as a game that never had the old shape.
    expect(Object.keys(loaded.sales)).toEqual(Object.keys(state.sales));
    expect(serialize(deserialize(serialize(loaded)))).toBe(serialize(loaded));

    // With no install notices left in the log, installs are taken as running.
    const quiet: Save = JSON.parse(serialize(state));
    quiet.schemaVersion = 2;
    delete quiet.debt;
    delete quiet.sales.installsPaused;
    expect(deserialize(JSON.stringify(quiet)).sales).toEqual(state.sales);
  });

  it('round-trips a game on credit: loans, a drawn line, a covenant stage past compliant and reports with debt', () => {
    const state = borrowedGame({}, true);
    // Once the months that carried the loans leave the trailing window, the covenants bite.
    runDays(state, 100);
    expect(state.gameOver).toBeNull();
    expect(state.debt.loans.length).toBeGreaterThan(0);
    expect(state.debt.credit.balance).toBeGreaterThan(0);
    expect(state.debt.credit.balanceDollarDays).toBeGreaterThan(0);
    expect(state.debt.covenant.stage).not.toBe('compliant');
    expect(state.finance.reports.filter((r) => r.debt !== undefined).length).toBeGreaterThan(3);
    expect(state.notices.some((n) => n.kind === 'covenantWarning')).toBe(true);
    const loaded = deserialize(serialize(state));
    expect(loaded).toEqual(state);
    expect(serialize(loaded)).toBe(serialize(state));
    // ...and it keeps playing exactly like the original.
    for (const game of [state, loaded]) {
      applyCommand(game, { type: 'repayCredit', amount: 1_000 });
      applyCommand(game, { type: 'prepayLoan', loan: 1, amount: 500 });
      runDays(game, 70);
    }
    expect(hashState(loaded)).toBe(hashState(state));
  });

  it('writes plain JSON', () => {
    const state = playedGame();
    expect(JSON.parse(serialize(state))).toEqual(state);
  });

  it('continues a reloaded game exactly like the original, through month closes', () => {
    const original = playedGame();
    const reloaded = deserialize(serialize(original));
    for (const state of [original, reloaded]) {
      // Aerial orders draw make-ready from the saved events stream; signups,
      // tier picks and churn draw from the saved sales stream.
      applyCommand(state, { type: 'layCable', segments: [3, 9], method: 'aerial' });
      applyCommand(state, { type: 'removeSpan', span: 1 });
      runDays(state, 40);
      applyCommand(state, { type: 'setPricing', tiers: tierSettings({ fiber1g: 80 }) as never, smbMultiplier: 2 });
      applyCommand(state, { type: 'layCable', segments: [4, 10], method: 'aerial' });
      applyCommand(state, { type: 'placeCabinet', node: 5 });
      runDays(state, 50);
      applyCommand(state, { type: 'setMarketing', perMonth: 2_500 });
      runDays(state, 50);
    }
    expect(original.finance.reports.length).toBeGreaterThanOrEqual(5);
    expect(original.sales.connectsTotal).toBeGreaterThan(0);
    expect(hashState(reloaded)).toBe(hashState(original));
    expect(serialize(reloaded)).toBe(serialize(original));
  });
});

describe('hashState', () => {
  it('is 32-bit FNV-1a', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });

  it('hashes the serialized state as 8 lowercase hex digits', () => {
    const state = playedGame();
    expect(hashState(state)).toBe(fnv1a(serialize(state)));
    expect(hashState(state)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable for equal states and changes with any field', () => {
    const state = playedGame();
    const hash = hashState(state);
    expect(hashState(playedGame())).toBe(hash);
    state.finance.cash += 1;
    expect(hashState(state)).not.toBe(hash);
    state.finance.cash -= 1;
    expect(hashState(state)).toBe(hash);
    state.day += 1;
    expect(hashState(state)).not.toBe(hash);
  });
});

describe('deserialize errors', () => {
  const good = serialize(playedGame());
  /** A make-ready memo on `segment` drawn on day 0. */
  const memo = (segment: number) => ({ segment, method: 'aerial', days: 30, drawnDay: 0 });
  /** The good save with one change applied. */
  const corrupted = (mutate: (save: Save) => void): string => {
    const save: Save = JSON.parse(good);
    mutate(save);
    return JSON.stringify(save);
  };

  it.each(['', '{', 'not json', '{"schemaVersion":1,}'])('rejects bad JSON %j', (json) => {
    expectSaveError(json, /not valid JSON/);
  });

  it.each(['null', '42', '"save"', '[]', 'true'])('rejects a non-object save %s', (json) => {
    expectSaveError(json, /should be a JSON object/);
  });

  it('rejects a missing or unsupported schemaVersion', () => {
    expectSaveError(corrupted((s) => delete s.schemaVersion), /no schemaVersion/);
    expectSaveError(corrupted((s) => (s.schemaVersion = 5)), /Unsupported save version 5 \(this build reads version 4\)/);
    expectSaveError(corrupted((s) => (s.schemaVersion = 0)), /Unsupported save version 0 /);
    expectSaveError(corrupted((s) => (s.schemaVersion = '1')), /Unsupported save version "1" /);
    expectSaveError(corrupted((s) => (s.schemaVersion = null)), /Unsupported save version null /);
  });

  it('rejects numbers JSON can parse but the sim cannot use', () => {
    expectSaveError(good.replace(/"cash":-?\d+/, '"cash":1e999'), /finance\.cash should be an integer, got Infinity/);
    expectSaveError(good.replace(/"day":\d+/, '"day":1e300'), /day should be an integer >= 0, got 1e\+300/);
  });

  const cases: Array<[string, (save: Save) => void, RegExp]> = [
    // Top level
    ['missing city', (s) => delete s.city, /city should be an object, got nothing/],
    ['missing network', (s) => delete s.network, /network should be an object, got nothing/],
    ['finance as an array', (s) => (s.finance = []), /finance should be an object, got an array/],
    ['negative day', (s) => (s.day = -1), /day should be an integer >= 0, got -1/],
    ['fractional day', (s) => (s.day = 1.5), /day should be an integer >= 0, got 1\.5/],
    ['string seed', (s) => (s.seed = 'x'), /seed should be an integer in 0\.\.4294967295, got "x"/],
    ['missing rng', (s) => delete s.rng, /rng should be an object/],
    ['negative rng state', (s) => (s.rng.events = -1), /rng\.events should be an integer in 0\.\.4294967295/],
    ['rng state past uint32', (s) => (s.rng.events = 2 ** 32), /rng\.events/],
    ['zero nextId', (s) => (s.nextId = 0), /nextId should be an integer >= 1, got 0/],
    // City
    ['numeric city name', (s) => (s.city.name = 5), /city\.name should be a string, got 5/],
    ['zero city width', (s) => (s.city.width = 0), /city\.width should be an integer in 1\.\.512/],
    ['city too wide to draw', (s) => (s.city.width = 2e9), /city\.width should be an integer in 1\.\.512, got 2000000000/],
    ['city too tall to draw', (s) => (s.city.height = 100_000), /city\.height should be an integer in 1\.\.512, got 100000/],
    ['missing tileFt', (s) => delete s.city.tileFt, /city\.tileFt should be a number > 0, got nothing/],
    ['nodes not an array', (s) => (s.city.nodes = {}), /city\.nodes should be an array, got an object/],
    ['null node', (s) => (s.city.nodes[0] = null), /city\.nodes\[0\] should be an object, got null/],
    ['node id off its index', (s) => (s.city.nodes[2].id = 5), /city\.nodes\[2\]\.id should be 2 \(its position/],
    ['string node coordinate', (s) => (s.city.nodes[1].x = '4'), /city\.nodes\[1\]\.x should be an integer/],
    ['node far off the map', (s) => (s.city.nodes[3].x = 4_000_000_000_000), /city\.nodes\[3\]\.x should be an integer in 0\.\.12, got 4000000000000/],
    ['node above the map', (s) => (s.city.nodes[3].y = -1), /city\.nodes\[3\]\.y should be an integer in 0\.\.4, got -1/],
    ['node past the map edge', (s) => (s.city.width = 11), /city\.nodes\[3\]\.x should be an integer in 0\.\.11, got 12/],
    ['segment id off its index', (s) => (s.city.segments[3].id = 4), /city\.segments\[3\]\.id should be 3/],
    ['segment endpoint out of range', (s) => (s.city.segments[0].b = 99), /city\.segments\[0\]\.b should be an integer in 0\.\.11, got 99/],
    ['segment from a node to itself', (s) => (s.city.segments[0].b = s.city.segments[0].a), /city\.segments\[0\]\.b should be greater than a \(0\), got 0/],
    ['segment endpoints reversed', (s) => ([s.city.segments[0].a, s.city.segments[0].b] = [1, 0]), /city\.segments\[0\]\.b should be greater than a \(1\), got 0/],
    ['diagonal segment', (s) => (s.city.segments[0].b = 5), /city\.segments\[0\] should run along one grid line, but joins \(0, 0\) to \(4, 2\)/],
    ['segment with both ends at one point', (s) => (s.city.nodes[1].x = 0), /city\.segments\[0\] joins two nodes at the same point \(0, 0\)/],
    ['unknown street class', (s) => (s.city.segments[0].streetClass = 'highway'), /streetClass should be one of "arterial", "collector", "local", got "highway"/],
    ['zero-length segment', (s) => (s.city.segments[1].lengthFt = 0), /city\.segments\[1\]\.lengthFt should be a number > 0, got 0/],
    ['string hasPoles', (s) => (s.city.segments[1].hasPoles = 'yes'), /city\.segments\[1\]\.hasPoles should be true or false/],
    ['missing rock flag', (s) => delete s.city.segments[2].rock, /city\.segments\[2\]\.rock should be true or false, got nothing/],
    ['parcel id off its index', (s) => (s.city.parcels[4].id = 0), /city\.parcels\[4\]\.id should be 4/],
    ['parcel segment out of range', (s) => (s.city.parcels[0].segment = 17), /city\.parcels\[0\]\.segment should be an integer in 0\.\.16, got 17/],
    ['unknown parcel kind', (s) => (s.city.parcels[0].kind = 'castle'), /city\.parcels\[0\]\.kind should be one of/],
    ['zero-width parcel', (s) => (s.city.parcels[0].w = 0), /city\.parcels\[0\]\.w should be an integer >= 1/],
    ['parcel left of the map', (s) => (s.city.parcels[0].x = -1), /city\.parcels\[0\]\.x should be an integer in 0\.\.11, got -1/],
    ['parcel below the map', (s) => (s.city.parcels[0].y = 4), /city\.parcels\[0\]\.y should be an integer in 0\.\.3, got 4/],
    ['parcel running off the map', (s) => (s.city.parcels[0].w = 13), /city\.parcels\[0\] runs off the 12 x 4 map \(cells 0\.\.12 x 0\.\.0\)/],
    ['fractional units', (s) => (s.city.parcels[0].units = 1.5), /city\.parcels\[0\]\.units/],
    ['unknown zone', (s) => (s.city.parcels[0].zone = 'moon'), /city\.parcels\[0\]\.zone should be one of/],
    ['coNode out of range', (s) => (s.city.coNode = 12), /city\.coNode should be an integer in 0\.\.11, got 12/],
    ['city with no nodes', (s) => (s.city.nodes = []), /city\.segments\[0\]\.a refers to a node, but the city has none/],
    // Network
    ['spans missing', (s) => delete s.network.spans, /network\.spans should be an array, got nothing/],
    ['span on an unknown segment', (s) => (s.network.spans[0].segment = 99), /network\.spans\[0\]\.segment should be an integer in 0\.\.16, got 99/],
    ['span id from the future', (s) => (s.network.spans[0].id = s.nextId), /network\.spans\[0\]\.id should be an integer in 1\.\./],
    ['span and cabinet sharing an id', (s) => (s.network.spans[0].id = s.network.cabinets[0].id), /network\.cabinets\[0\]\.id \d+ is used twice/],
    ['two spans on one segment', (s) => (s.network.spans[1].segment = s.network.spans[0].segment), /network\.spans\[1\]\.segment \d+ already has a span/],
    ['unknown cable method', (s) => (s.network.spans[0].method = 'laser'), /network\.spans\[0\]\.method should be one of "aerial", "underground", got "laser"/],
    ['unknown stage', (s) => (s.network.spans[0].stage = 'done'), /network\.spans\[0\]\.stage should be one of/],
    ['negative stageDaysLeft', (s) => (s.network.spans[0].stageDaysLeft = -3), /network\.spans\[0\]\.stageDaysLeft should be an integer >= 0/],
    ['zero constructDays', (s) => (s.network.spans[0].constructDays = 0), /network\.spans\[0\]\.constructDays should be an integer >= 1/],
    ['negative span cost', (s) => (s.network.spans[0].cost = -5), /network\.spans\[0\]\.cost/],
    [
      'live span without a liveDay',
      (s) => (s.network.spans.find((x: Save) => x.stage === 'live').liveDay = null),
      /liveDay should be an integer >= 0, got null/,
    ],
    [
      'permitting span with a liveDay',
      (s) => (s.network.spans.find((x: Save) => x.stage === 'permitting').liveDay = 3),
      /liveDay should be null while permitting, got 3/,
    ],
    ['cabinet on an unknown node', (s) => (s.network.cabinets[0].node = -1), /network\.cabinets\[0\]\.node should be an integer in 0\.\.11, got -1/],
    [
      'two cabinets on one node',
      (s) => s.network.cabinets.push({ ...s.network.cabinets[0], id: s.nextId++ }),
      /network\.cabinets\[1\]\.node 0 already has a cabinet/,
    ],
    ['string splitters', (s) => (s.network.cabinets[0].splitters = '1'), /network\.cabinets\[0\]\.splitters/],
    ['missing OLT', (s) => delete s.network.olt, /network\.olt should be an object, got nothing/],
    ['unknown PON tech', (s) => (s.network.olt.tech = 'docsis'), /network\.olt\.tech should be one of "gpon", "xgspon"/],
    ['negative network version', (s) => (s.network.version = -1), /network\.version should be an integer >= 0/],
    // Finance
    ['string cash', (s) => (s.finance.cash = 'lots'), /finance\.cash should be an integer, got "lots"/],
    ['fractional cash', (s) => (s.finance.cash = 10.5), /finance\.cash should be an integer, got 10\.5/],
    ['unknown ledger category', (s) => (s.finance.monthToDate[0].category = 'bribes'), /finance\.monthToDate\[0\]\.category should be one of/],
    ['fractional ledger amount', (s) => (s.finance.monthToDate[0].amount = -0.5), /finance\.monthToDate\[0\]\.amount should be an integer/],
    ['numeric memo', (s) => (s.finance.monthToDate[0].memo = 3), /finance\.monthToDate\[0\]\.memo should be a string/],
    ['reports not an array', (s) => (s.finance.reports = {}), /finance\.reports should be an array, got an object/],
    ['report month 13', (s) => (s.finance.reports[0].month = 13), /finance\.reports\[0\]\.month should be an integer in 1\.\.12, got 13/],
    ['report before the game began', (s) => (s.finance.reports[0].year = 1999), /finance\.reports\[0\]\.year should be an integer >= 2027/],
    ['unknown report category', (s) => (s.finance.reports[0].totals.bribes = -1), /finance\.reports\[0\]\.totals key should be one of .*, got "bribes"/],
    ['string report total', (s) => (s.finance.reports[0].totals.construction = '-1'), /finance\.reports\[0\]\.totals\.construction should be an integer/],
    ['negative passings', (s) => (s.finance.reports[0].passings = -1), /finance\.reports\[0\]\.passings should be an integer >= 0/],
    // Round 2: rng, network
    ['missing sales stream', (s) => delete s.rng.sales, /rng\.sales should be an integer in 0\.\.4294967295, got nothing/],
    ['sales stream past uint32', (s) => (s.rng.sales = 2 ** 32), /rng\.sales should be an integer in 0\.\.4294967295/],
    ['refundable above cost', (s) => (s.network.spans[0].refundable = s.network.spans[0].cost + 1), /network\.spans\[0\]\.refundable should be an integer in 0\.\.\d+/],
    ['negative refundable', (s) => (s.network.spans[0].refundable = -1), /network\.spans\[0\]\.refundable/],
    ['missing OLT cards', (s) => delete s.network.olt.cards, /network\.olt\.cards should be an integer >= 0, got nothing/],
    ['fractional OLT cards', (s) => (s.network.olt.cards = 1.5), /network\.olt\.cards should be an integer >= 0, got 1\.5/],
    ['makeReady not a list', (s) => (s.network.makeReady = {}), /network\.makeReady should be an array/],
    ['make-ready memo on an unknown segment', (s) => (s.network.makeReady = [memo(99)]), /network\.makeReady\[0\]\.segment should be an integer in 0\.\.16, got 99/],
    ['make-ready memo with an unknown method', (s) => (s.network.makeReady = [{ ...memo(0), method: 'laser' }]), /network\.makeReady\[0\]\.method should be one of/],
    ['make-ready memo of zero days', (s) => (s.network.makeReady = [{ ...memo(0), days: 0 }]), /network\.makeReady\[0\]\.days should be an integer >= 1, got 0/],
    ['make-ready memo drawn in the future', (s) => (s.network.makeReady = [{ ...memo(0), drawnDay: s.day + 1 }]), /network\.makeReady\[0\]\.drawnDay should be an integer in 0\.\.\d+/],
    ['make-ready memos out of order', (s) => (s.network.makeReady = [memo(3), memo(1)]), /network\.makeReady\[1\] should be greater than the entry before it/],
    ['duplicate make-ready memos', (s) => (s.network.makeReady = [memo(1), memo(1)]), /network\.makeReady\[1\] should be greater/],
    ['make-ready methods out of order', (s) => (s.network.makeReady = [{ ...memo(1), method: 'underground' }, memo(1)]), /network\.makeReady\[1\] should be greater/],
    // Finance
    ['missing capex', (s) => delete s.finance.capex, /finance\.capex should be an object, got nothing/],
    ['negative OSP capex', (s) => (s.finance.capex.osp = -1), /finance\.capex\.osp should be an integer >= 0, got -1/],
    ['fractional connect capex', (s) => (s.finance.capex.connect = 0.5), /finance\.capex\.connect should be an integer >= 0/],
    ['missing CO capex', (s) => delete s.finance.capex.co, /finance\.capex\.co should be an integer >= 0, got nothing/],
    ['negative negativeMonths', (s) => (s.finance.negativeMonths = -1), /finance\.negativeMonths should be an integer >= 0, got -1/],
    ['missing negativeMonths', (s) => delete s.finance.negativeMonths, /finance\.negativeMonths should be an integer >= 0, got nothing/],
    ['install entry category typo', (s) => (s.finance.monthToDate[0].category = 'instal'), /finance\.monthToDate\[0\]\.category should be one of/],
    ['stats that are not an object', (s) => (s.finance.reports[0].stats = 7), /finance\.reports\[0\]\.stats should be an object, got 7/],
    ['null stats', (s) => (s.finance.reports[0].stats = null), /finance\.reports\[0\]\.stats should be an object, got null/],
    ['string subscriber count', (s) => (s.finance.reports[0].stats.subscribers = '4'), /finance\.reports\[0\]\.stats\.subscribers should be an integer >= 0/],
    ['negative PON ports in stats', (s) => (s.finance.reports[0].stats.ponPorts = -1), /finance\.reports\[0\]\.stats\.ponPorts should be an integer >= 0/],
    ['stats missing a field', (s) => delete s.finance.reports[0].stats.fullCabinets, /finance\.reports\[0\]\.stats\.fullCabinets should be an integer >= 0, got nothing/],
    // Sales: pricing and marketing
    ['missing sales', (s) => delete s.sales, /sales should be an object, got nothing/],
    ['two tiers', (s) => s.sales.pricing.tiers.pop(), /sales\.pricing\.tiers should list the 3 tiers fiber500, fiber1g, fiber2g, got 2/],
    ['four tiers', (s) => s.sales.pricing.tiers.push({ ...s.sales.pricing.tiers[0] }), /sales\.pricing\.tiers should list the 3 tiers/],
    ['tiers out of order', (s) => s.sales.pricing.tiers.reverse(), /sales\.pricing\.tiers\[0\]\.id should be "fiber500", got "fiber2g"/],
    ['an unknown tier', (s) => (s.sales.pricing.tiers[1].id = 'fiber10g'), /sales\.pricing\.tiers\[1\]\.id should be "fiber1g", got "fiber10g"/],
    ['a zero price', (s) => (s.sales.pricing.tiers[0].price = 0), /sales\.pricing\.tiers\[0\]\.price should be an integer in 1\.\.100000, got 0/],
    ['a fractional price', (s) => (s.sales.pricing.tiers[2].price = 95.5), /sales\.pricing\.tiers\[2\]\.price should be an integer/],
    ['an absurd price', (s) => (s.sales.pricing.tiers[2].price = 1e9), /sales\.pricing\.tiers\[2\]\.price should be an integer in 1\.\.100000/],
    ['a string offered flag', (s) => (s.sales.pricing.tiers[0].offered = 'yes'), /sales\.pricing\.tiers\[0\]\.offered should be true or false/],
    ['no tier offered', (s) => s.sales.pricing.tiers.forEach((t: Save) => (t.offered = false)), /sales\.pricing\.tiers should offer at least one tier/],
    ['a missing tier name', (s) => delete s.sales.pricing.tiers[0].name, /sales\.pricing\.tiers\[0\]\.name should be a string/],
    ['zero tier speed', (s) => (s.sales.pricing.tiers[1].downMbps = 0), /sales\.pricing\.tiers\[1\]\.downMbps should be an integer >= 1/],
    ['a zero business multiplier', (s) => (s.sales.pricing.smbMultiplier = 0), /sales\.pricing\.smbMultiplier should be a number in 0\.01\.\.100, got 0/],
    ['a string business multiplier', (s) => (s.sales.pricing.smbMultiplier = '1.5'), /sales\.pricing\.smbMultiplier should be a number/],
    ['an absurd business multiplier', (s) => (s.sales.pricing.smbMultiplier = 1e6), /sales\.pricing\.smbMultiplier should be a number in 0\.01\.\.100/],
    ['negative marketing', (s) => (s.sales.marketingPerMonth = -1), /sales\.marketingPerMonth should be an integer in 0\.\.1000000000, got -1/],
    ['fractional marketing', (s) => (s.sales.marketingPerMonth = 10.5), /sales\.marketingPerMonth should be an integer/],
    ['absurd marketing', (s) => (s.sales.marketingPerMonth = 1e12), /sales\.marketingPerMonth should be an integer in 0\.\.1000000000/],
    // Sales: accounts and routers
    ['accounts not a list', (s) => (s.sales.accounts = {}), /sales\.accounts should be an array, got an object/],
    ['account on an unknown parcel', (s) => (s.sales.accounts[0].parcel = 999), /sales\.accounts\[0\]\.parcel should be an integer in 0\.\.47, got 999/],
    ['accounts out of order', (s) => s.sales.accounts.reverse(), /sales\.accounts \(by parcel\)\[1\] should be greater than the entry before it/],
    ['two accounts on one parcel', (s) => s.sales.accounts.splice(1, 0, structuredClone(s.sales.accounts[0])), /sales\.accounts \(by parcel\)\[1\] should be greater/],
    ['an unknown tier key', (s) => (s.sales.accounts[0].tierUnits.fiber10g = 1), /sales\.accounts\[0\]\.tierUnits key should be one of "fiber500", "fiber1g", "fiber2g", got "fiber10g"/],
    ['a missing tier key', (s) => delete s.sales.accounts[0].tierUnits.fiber2g, /sales\.accounts\[0\]\.tierUnits\.fiber2g should be an integer >= 0, got nothing/],
    ['negative tier units', (s) => (s.sales.accounts[0].tierUnits.fiber500 = -1), /sales\.accounts\[0\]\.tierUnits\.fiber500 should be an integer >= 0, got -1/],
    ['fractional tier units', (s) => (s.sales.accounts[0].tierUnits.fiber1g = 0.5), /sales\.accounts\[0\]\.tierUnits\.fiber1g should be an integer/],
    ['an account with no units', (s) => (s.sales.accounts[0].tierUnits = { fiber500: 0, fiber1g: 0, fiber2g: 0 }), /sales\.accounts\[0\]\.tierUnits should add up to 1\.\.12 units \(parcel 0 has 12\), got 0/],
    ['more units than the building has', (s) => (s.sales.accounts[0].tierUnits = { fiber500: 13, fiber1g: 0, fiber2g: 0 }), /sales\.accounts\[0\]\.tierUnits should add up to 1\.\.12 units \(parcel 0 has 12\), got 13/],
    [
      'a home with two subscriptions',
      (s) => {
        s.city.parcels[0].kind = 'home';
        s.sales.accounts[0].tierUnits = { fiber500: 1, fiber1g: 1, fiber2g: 0 };
        s.sales.routerParcels = s.sales.routerParcels.filter((p: number) => p !== 0);
      },
      /sales\.accounts\[0\]\.tierUnits should add up to 1 unit for a home, got 2/,
    ],
    ['an account on a cabinet id never issued', (s) => (s.sales.accounts[0].cabinet = s.nextId), /sales\.accounts\[0\]\.cabinet should be an integer in 1\.\.\d+, got \d+/],
    ['an account on cabinet 0', (s) => (s.sales.accounts[0].cabinet = 0), /sales\.accounts\[0\]\.cabinet should be an integer in 1\.\./],
    ['an account from the future', (s) => (s.sales.accounts[0].since = s.day + 1), /sales\.accounts\[0\]\.since should be an integer in 0\.\.\d+/],
    ['a router on a home', (s) => (s.sales.routerParcels = [1]), /sales\.routerParcels\[0\] refers to parcel 1, which is not an apartment building/],
    ['a router on an unknown parcel', (s) => (s.sales.routerParcels = [480]), /sales\.routerParcels\[0\] should be an integer in 0\.\.47, got 480/],
    ['routers out of order', (s) => (s.sales.routerParcels = [4, 0]), /sales\.routerParcels\[1\] should be greater than the entry before it \(4\), got 0/],
    ['duplicate routers', (s) => (s.sales.routerParcels = [0, 0]), /sales\.routerParcels\[1\] should be greater/],
    ['negative connects', (s) => (s.sales.connectsTotal = -1), /sales\.connectsTotal should be an integer >= 0, got -1/],
    ['full cabinets out of order', (s) => (s.sales.fullCabinets = [2, 1]), /sales\.fullCabinets\[1\] should be greater than the entry before it \(2\), got 1/],
    ['a full cabinet id never issued', (s) => (s.sales.fullCabinets = [s.nextId]), /sales\.fullCabinets\[0\] should be an integer in 1\.\./],
    ['a string installs-paused flag', (s) => (s.sales.installsPaused = 'yes'), /sales\.installsPaused should be true or false, got "yes"/],
    ['a null installs-paused flag', (s) => (s.sales.installsPaused = null), /sales\.installsPaused should be true or false, got null/],
    ['missing month accrual', (s) => delete s.sales.month, /sales\.month should be an object, got nothing/],
    ['negative revenue accrual', (s) => (s.sales.month.revenueDollarDays = -1), /sales\.month\.revenueDollarDays should be an integer >= 0, got -1/],
    ['fractional marketing accrual', (s) => (s.sales.month.marketingDollarDays = 1.5), /sales\.month\.marketingDollarDays should be an integer >= 0/],
    ['missing subscriber-days', (s) => delete s.sales.month.subscriberUnitDays, /sales\.month\.subscriberUnitDays should be an integer >= 0, got nothing/],
    ['string gross adds', (s) => (s.sales.month.grossAdds = '2'), /sales\.month\.grossAdds should be an integer >= 0/],
    ['negative lost service', (s) => (s.sales.month.lostService = -2), /sales\.month\.lostService should be an integer >= 0, got -2/],
    ['a parcel too big to simulate', (s) => (s.city.parcels[0].units = 1e9), /city\.parcels\[0\]\.units should be an integer in 0\.\.10000, got 1000000000/],
    // Progress
    ['milestones not a list', (s) => (s.milestones = null), /milestones should be an array, got null/],
    ['an unknown milestone', (s) => (s.milestones[0].id = 'moonshot'), /milestones\[0\]\.id should be one of .*got "moonshot"/],
    ['a milestone twice', (s) => s.milestones.push({ ...s.milestones[0] }), /milestones\[1\]\.id "firstLight" is listed twice/],
    ['a milestone from the future', (s) => (s.milestones[0].day = s.day + 1), /milestones\[0\]\.day should be an integer in 0\.\.\d+/],
    ['notices not a list', (s) => (s.notices = 'none'), /notices should be an array, got "none"/],
    ['a notice id not below nextNoticeId', (s) => (s.notices[0].id = s.nextNoticeId), /notices\[0\]\.id should be an integer in 1\.\./],
    ['notices out of order', (s) => s.notices.push({ ...s.notices[0] }), /notices \(by id\)\[1\] should be greater than the entry before it/],
    ['an unknown notice kind', (s) => (s.notices[0].kind = 'gossip'), /notices\[0\]\.kind should be one of .*got "gossip"/],
    ['a notice from the future', (s) => (s.notices[0].day = s.day + 1), /notices\[0\]\.day should be an integer in 0\.\./],
    ['a numeric notice message', (s) => (s.notices[0].message = 4), /notices\[0\]\.message should be a string, got 4/],
    ['a notice about a cabinet id never issued', (s) => (s.notices[0].cabinet = s.nextId), /notices\[0\]\.cabinet should be an integer in 1\.\./],
    ['a notice about an unknown milestone', (s) => (s.notices[0].milestone = 'moonshot'), /notices\[0\]\.milestone should be one of/],
    ['a missing notice milestone ref', (s) => delete s.notices[0].milestone, /notices\[0\]\.milestone should be one of/],
    ['zero nextNoticeId', (s) => (s.nextNoticeId = 0), /nextNoticeId should be an integer >= 1, got 0/],
    ['missing gameOver', (s) => delete s.gameOver, /gameOver should be an object, got nothing/],
    ['gameOver for an unknown reason', (s) => (s.gameOver = { day: 1, reason: 'bored', message: 'x' }), /gameOver\.reason should be one of "insolvent", "default", got "bored"/],
    ['gameOver in the future', (s) => (s.gameOver = { day: s.day + 1, reason: 'insolvent', message: 'x' }), /gameOver\.day should be an integer in 0\.\.\d+/],
    ['gameOver without a message', (s) => (s.gameOver = { day: 1, reason: 'insolvent' }), /gameOver\.message should be a string, got nothing/],
    // Debt (schemaVersion 3)
    ['missing debt', (s) => delete s.debt, /debt should be an object, got nothing/],
    ['missing credit line', (s) => delete s.debt.credit, /debt\.credit should be an object, got nothing/],
    ['negative credit balance', (s) => (s.debt.credit.balance = -1), /debt\.credit\.balance should be an integer in 0\.\.\d+, got -1/],
    ['an absurd credit balance', (s) => (s.debt.credit.balance = 1e15), /debt\.credit\.balance should be an integer in 0\.\.1000000000000, got 1000000000000000/],
    ['fractional base rate', (s) => (s.debt.credit.rate.baseBps = 5.5), /debt\.credit\.rate\.baseBps should be an integer in 0\.\.100000, got 5\.5/],
    ['missing CPP spread', (s) => delete s.debt.credit.rate.cppBps, /debt\.credit\.rate\.cppBps should be an integer/],
    ['negative dollar-days', (s) => (s.debt.credit.balanceDollarDays = -5), /debt\.credit\.balanceDollarDays should be an integer in 0\.\./],
    ['zero nextLoanId', (s) => (s.debt.nextLoanId = 0), /debt\.nextLoanId should be an integer >= 1, got 0/],
    ['loans not a list', (s) => (s.debt.loans = {}), /debt\.loans should be an array, got an object/],
    ['an unknown covenant stage', (s) => (s.debt.covenant.stage = 'doomed'), /debt\.covenant\.stage should be one of "compliant", "warning", "penalty", "frozen", got "doomed"/],
    ['negative compliant closes', (s) => (s.debt.covenant.compliantCloses = -1), /debt\.covenant\.compliantCloses should be an integer in 0\.\.1000, got -1/],
    ['an unknown notice kind (round-3 kinds listed)', (s) => (s.notices[0].kind = 'loanShark'), /notices\[0\]\.kind should be one of .*"paymentMissed".*got "loanShark"/],
    // Round 4 (schemaVersion 4)
    ['missing weather stream', (s) => delete s.rng.weather, /rng\.weather should be an integer in 0\.\.4294967295, got nothing/],
    ['missing weather', (s) => delete s.weather, /weather should be an object, got nothing/],
    ['zero nextStormId', (s) => (s.weather.nextStormId = 0), /weather\.nextStormId should be an integer >= 1, got 0/],
    ['storms not a list', (s) => (s.weather.storms = {}), /weather\.storms should be an array, got an object/],
    ['missing weather month', (s) => delete s.weather.month, /weather\.month should be an object, got nothing/],
    ['negative outage subscriber-days', (s) => (s.weather.month.outageUnitDays = -1), /weather\.month\.outageUnitDays should be an integer >= 0, got -1/],
    ['a span without its outage field', (s) => delete s.network.spans[0].outage, /network\.spans\[0\]\.outage should be an object, got nothing/],
    ['a span without its conversion field', (s) => delete s.network.spans[0].conversion, /network\.spans\[0\]\.conversion should be an object, got nothing/],
    ['an account without locks', (s) => delete s.sales.accounts[0].locks, /sales\.accounts\[0\]\.locks should be an array, got nothing/],
    ['missing intro promo field', (s) => delete s.sales.promo, /sales\.promo should be an object, got nothing/],
    ['incumbent promos not a list', (s) => (s.sales.incumbentPromos = null), /sales\.incumbentPromos should be an array, got null/],
    ['missing frozen closes', (s) => delete s.debt.frozenCloses, /debt\.frozenCloses should be an integer in 0\.\.10000, got nothing/],
    ['missing acceleration field', (s) => delete s.debt.acceleration, /debt\.acceleration should be an object, got nothing/],
    ['a repair entry category typo', (s) => (s.finance.monthToDate[0].category = 'repairs'), /finance\.monthToDate\[0\]\.category should be one of .*"repair".*got "repairs"/],
    ['an unknown notice kind (round-4 kinds listed)', (s) => (s.notices[0].kind = 'tornado'), /notices\[0\]\.kind should be one of .*"storm".*got "tornado"/],
  ];

  it.each(cases)('rejects %s', (_name, mutate, message) => {
    expectSaveError(corrupted(mutate), message);
  });

  describe('term loans and report debt stats', () => {
    /** The good save with two term loans and a closed month carrying debt stats. */
    const withLoans = (mutate: (save: Save) => void = () => {}): string =>
      corrupted((s) => {
        s.debt.credit.balance = 12_000;
        s.debt.credit.balanceDollarDays = 12_000 * 3;
        s.debt.loans = [
          { id: 1, principal: 50_000, balance: 41_200, rateBps: 725, termMonths: 60, payment: 996, monthsLeft: 50, originatedDay: 0 },
          { id: 3, principal: 20_000, balance: 20_000, rateBps: 800, termMonths: 84, payment: 312, monthsLeft: 84, originatedDay: s.day },
        ];
        s.debt.nextLoanId = 4;
        s.debt.covenant = { stage: 'penalty', compliantCloses: 1 };
        s.finance.reports[0].debt = {
          creditBalance: 12_000,
          termBalance: 61_200,
          creditLimit: 20_000,
          arr: 40_000,
          annualOperatingCashFlow: -15_000,
          annualDebtService: 16_000,
          leverageX100: 732,
          coverageX100: -94,
          stage: 'penalty',
          averageRateBps: 1_060,
          missedPayment: false,
        };
        s.finance.monthToDate.push(
          { day: s.day, category: 'loanProceeds', amount: 20_000, memo: 'Term loan #3' },
          { day: s.day, category: 'principal', amount: -1_000, memo: 'Credit line repayment' },
        );
        s.finance.cash += 19_000;
        mutate(s);
      });

    it('loads and round-trips loans, a drawn line, a covenant stage and report debt stats', () => {
      const state = deserialize(withLoans());
      expect(state.debt.loans.map((l) => l.id)).toEqual([1, 3]);
      expect(state.debt.covenant.stage).toBe('penalty');
      expect(state.finance.reports[0]?.debt?.leverageX100).toBe(732);
      expect(deserialize(serialize(state))).toEqual(state);
      // Unmeasurable leverage and no scheduled debt service are nulls, not missing.
      const nulls = deserialize(
        withLoans((s) => Object.assign(s.finance.reports[0].debt, { leverageX100: null, coverageX100: null, averageRateBps: null })),
      );
      expect(nulls.finance.reports[0]?.debt?.coverageX100).toBeNull();
    });

    const loanCases: Array<[string, (save: Save) => void, RegExp]> = [
      ['a loan id not below nextLoanId', (s) => (s.debt.loans[1].id = 4), /debt\.loans\[1\]\.id should be an integer in 1\.\.3, got 4/],
      ['loans out of order', (s) => (s.debt.loans[1].id = 1), /debt\.loans \(by id\)\[1\] should be greater than the entry before it \(1\), got 1/],
      ['a paid-off loan left in the list', (s) => (s.debt.loans[0].balance = 0), /debt\.loans\[0\]\.balance should be an integer in 1\.\./],
      ['a zero principal', (s) => (s.debt.loans[0].principal = 0), /debt\.loans\[0\]\.principal should be an integer in 1\.\./],
      ['an absurd rate', (s) => (s.debt.loans[0].rateBps = 1e6), /debt\.loans\[0\]\.rateBps should be an integer in 0\.\.100000/],
      ['a zero payment', (s) => (s.debt.loans[0].payment = 0), /debt\.loans\[0\]\.payment should be an integer in 1\.\./],
      ['more months left than the term', (s) => (s.debt.loans[0].monthsLeft = 61), /debt\.loans\[0\]\.monthsLeft should be an integer in 1\.\.60, got 61/],
      ['no months left', (s) => (s.debt.loans[0].monthsLeft = 0), /debt\.loans\[0\]\.monthsLeft should be an integer in 1\.\.60, got 0/],
      ['a century-long term', (s) => (s.debt.loans[0].termMonths = 5_000), /debt\.loans\[0\]\.termMonths should be an integer in 1\.\.1200/],
      ['a loan from the future', (s) => (s.debt.loans[1].originatedDay = s.day + 1), /debt\.loans\[1\]\.originatedDay should be an integer in 0\.\.\d+/],
      ['report debt with a fractional leverage', (s) => (s.finance.reports[0].debt.leverageX100 = 7.3), /finance\.reports\[0\]\.debt\.leverageX100 should be an integer >= 0, got 7\.3/],
      ['report debt missing its coverage', (s) => delete s.finance.reports[0].debt.coverageX100, /finance\.reports\[0\]\.debt\.coverageX100 should be an integer, got nothing/],
      ['report debt with an unknown stage', (s) => (s.finance.reports[0].debt.stage = 'broke'), /finance\.reports\[0\]\.debt\.stage should be one of/],
      ['report debt with a string missed flag', (s) => (s.finance.reports[0].debt.missedPayment = 'no'), /finance\.reports\[0\]\.debt\.missedPayment should be true or false, got "no"/],
      ['report debt with negative debt', (s) => (s.finance.reports[0].debt.termBalance = -1), /finance\.reports\[0\]\.debt\.termBalance should be an integer >= 0, got -1/],
      ['an unknown ledger category', (s) => (s.finance.monthToDate.at(-1).category = 'bailout'), /finance\.monthToDate\[\d+\]\.category should be one of .*"loanProceeds".*got "bailout"/],
    ];

    it.each(loanCases)('rejects %s', (_name, mutate, message) => {
      expectSaveError(withLoans(mutate), message);
    });
  });

  describe('round-4 records', () => {
    /** The good save with every round-4 record populated (as the round-4 rules will write them). */
    const withRound4 = (mutate: (save: Save) => void = () => {}): string =>
      corrupted((s) => {
        populateRound4(s);
        mutate(s);
      });

    it('loads and round-trips storms, outages, a conversion, locks, promos, acceleration and report ops', () => {
      const text = withRound4();
      const state = deserialize(text);
      expect(state.weather.storms).toHaveLength(1);
      expect(state.network.spans.find((x) => x.outage !== null)?.outage?.cause).toBe('storm');
      expect(state.network.spans.some((x) => x.conversion !== null)).toBe(true);
      expect(state.sales.accounts[0]?.locks[0]?.reason).toBe('grandfather');
      expect(state.sales.promo).toEqual({ percentOff: 20, months: 3 });
      expect(state.sales.incumbentPromos).toHaveLength(1);
      expect(state.debt.acceleration?.closesLeft).toBe(2);
      expect(state.finance.reports[0]?.ops?.storms).toBe(1);
      expect(state.weather.cutOff).toHaveLength(1);
      expect(deserialize(serialize(state))).toEqual(state);
      expect(serialize(deserialize(text))).toBe(text);
    });

    it('loads a round-4 save written before subscribers\' days cut off were kept, with none waiting', () => {
      const early = withRound4((s) => delete s.weather.cutOff);
      const state = deserialize(early);
      expect(state.weather.cutOff).toEqual([]);
      expect(Object.keys(state.weather)).toEqual(Object.keys(newWeather()));
    });

    const round4Cases: Array<[string, (save: Save) => void, RegExp]> = [
      ['a storm id not below nextStormId', (s) => (s.weather.storms[0].id = s.weather.nextStormId), /weather\.storms\[0\]\.id should be an integer in 1\.\.\d+/],
      ['a storm from the future', (s) => (s.weather.storms[0].day = s.day + 1), /weather\.storms\[0\]\.day should be an integer in 0\.\.\d+/],
      ['a storm off the map', (s) => (s.weather.storms[0].x = s.city.width + 1), /weather\.storms\[0\]\.x should be an integer in 0\.\.\d+/],
      ['a zero storm radius', (s) => (s.weather.storms[0].radius = 0), /weather\.storms\[0\]\.radius should be an integer in 1\.\./],
      ['a zero storm severity', (s) => (s.weather.storms[0].severity = 0), /weather\.storms\[0\]\.severity should be an integer in 1\.\.100, got 0/],
      ['storm spans out of order', (s) => (s.weather.storms[0].spans = [3, 2]), /weather\.storms\[0\]\.spans\[1\] should be greater than the entry before it/],
      ['a storm span id never issued', (s) => (s.weather.storms[0].spans = [s.nextId]), /weather\.storms\[0\]\.spans\[0\] should be an integer in 1\.\./],
      ['outage days on an unknown segment', (s) => (s.weather.month.segmentOutageDays[0].segment = 999), /weather\.month\.segmentOutageDays\[0\]\.segment should be an integer in 0\.\./],
      ['outage days past a month', (s) => (s.weather.month.segmentOutageDays[0].days = 32), /weather\.month\.segmentOutageDays\[0\]\.days should be an integer in 1\.\.31, got 32/],
      ['outage days out of order', (s) => s.weather.month.segmentOutageDays.reverse(), /weather\.month\.segmentOutageDays \(by segment\)\[1\] should be greater/],
      ['days cut off on an unknown parcel', (s) => (s.weather.cutOff[0].parcel = 9_999), /weather\.cutOff\[0\]\.parcel should be an integer in 0\.\./],
      ['negative days cut off', (s) => (s.weather.cutOff[0].days = -1), /weather\.cutOff\[0\]\.days should be an integer in 0\.\./],
      ['an outage with no days at all', (s) => (s.weather.cutOff[0].days = 0), /weather\.cutOff\[0\]\.charged should be an integer in 1\.\./],
      ['negative days charged', (s) => (s.weather.cutOff[0].charged = -1), /weather\.cutOff\[0\]\.charged should be an integer in 0\.\./],
      ['zero units cut off', (s) => (s.weather.cutOff[0].units = 0), /weather\.cutOff\[0\]\.units should be an integer in 1\.\./],
      ['days cut off out of order', (s) => s.weather.cutOff.push({ ...s.weather.cutOff[0] }), /weather\.cutOff \(by parcel\)\[1\] should be greater/],
      ['days cut off that are not a list', (s) => (s.weather.cutOff = {}), /weather\.cutOff should be an array/],
      ['an outage on a permitting span', (s) => (s.network.spans.find((x: Save) => x.stage === 'permitting').outage = outage()), /network\.spans\[\d+\]\.outage should be null while permitting/],
      ['an outage with an unknown cause', (s) => (s.network.spans.find((x: Save) => x.outage).outage.cause = 'alien'), /\.outage\.cause should be one of "storm", "digIn", got "alien"/],
      ['an outage from a storm never logged', (s) => (s.network.spans.find((x: Save) => x.outage).outage.storm = 99), /\.outage\.storm should be an integer in 1\.\.\d+, got 99/],
      ['an outage with no days left', (s) => (s.network.spans.find((x: Save) => x.outage).outage.daysLeft = 0), /\.outage\.daysLeft should be an integer >= 1, got 0/],
      ['a negative repair cost', (s) => (s.network.spans.find((x: Save) => x.outage).outage.repairCost = -1), /\.outage\.repairCost should be an integer >= 0, got -1/],
      ['a conversion of an underground span', (s) => (s.network.spans.find((x: Save) => x.conversion).method = 'underground'), /\.conversion should be null except on a live aerial span/],
      ['a conversion in an unknown stage', (s) => (s.network.spans.find((x: Save) => x.conversion).conversion.stage = 'live'), /\.conversion\.stage should be one of "permitting", "constructing", got "live"/],
      ['a conversion of zero construction days', (s) => (s.network.spans.find((x: Save) => x.conversion).conversion.constructDays = 0), /\.conversion\.constructDays should be an integer >= 1/],
      ['a lock on an unknown tier', (s) => (s.sales.accounts[0].locks[0].tier = 'fiber10g'), /sales\.accounts\[0\]\.locks\[0\]\.tier should be one of/],
      ['a zero lock price', (s) => (s.sales.accounts[0].locks[0].price = 0), /sales\.accounts\[0\]\.locks\[0\]\.price should be an integer in 1\.\./],
      ['a lock for an unknown reason', (s) => (s.sales.accounts[0].locks[0].reason = 'friend'), /sales\.accounts\[0\]\.locks\[0\]\.reason should be one of "grandfather", "notice", "promo"/],
      ['two locks on one tier', (s) => s.sales.accounts[0].locks.push({ ...s.sales.accounts[0].locks[0] }), /sales\.accounts\[0\]\.locks \(by tier\)\[1\] should be greater/],
      ['a promo of zero percent', (s) => (s.sales.promo.percentOff = 0), /sales\.promo\.percentOff should be an integer in 1\.\.100, got 0/],
      ['a promo of zero months', (s) => (s.sales.promo.months = 0), /sales\.promo\.months should be an integer in 1\.\./],
      ['an incumbent promo on a cabinet id never issued', (s) => (s.sales.incumbentPromos[0].cabinet = s.nextId), /sales\.incumbentPromos\[0\]\.cabinet should be an integer in 1\.\./],
      ['an incumbent promo ending before it starts', (s) => (s.sales.incumbentPromos[0].endDay = s.sales.incumbentPromos[0].startDay), /sales\.incumbentPromos\[0\]\.endDay should be an integer >= \d+/],
      ['an incumbent promo quiet before it ends', (s) => (s.sales.incumbentPromos[0].quietUntil = s.sales.incumbentPromos[0].endDay - 1), /sales\.incumbentPromos\[0\]\.quietUntil should be an integer >= \d+/],
      ['negative frozen closes', (s) => (s.debt.frozenCloses = -1), /debt\.frozenCloses should be an integer in 0\.\.10000, got -1/],
      ['an acceleration with no closes left', (s) => (s.debt.acceleration.closesLeft = 0), /debt\.acceleration\.closesLeft should be an integer in 1\.\./],
      ['an acceleration from the future', (s) => (s.debt.acceleration.day = s.day + 1), /debt\.acceleration\.day should be an integer in 0\.\.\d+/],
      ['report ops missing a field', (s) => delete s.finance.reports[0].ops.mrr, /finance\.reports\[0\]\.ops\.mrr should be an integer >= 0, got nothing/],
      ['report ops with negative repairs', (s) => (s.finance.reports[0].ops.repairs = -5), /finance\.reports\[0\]\.ops\.repairs should be an integer >= 0, got -5/],
      ['report debt with a negative sweep', (s) => (s.finance.reports[0].debt.sweep = -1), /finance\.reports\[0\]\.debt\.sweep should be an integer in 0\.\./],
      ['report debt with zero acceleration closes left', (s) => (s.finance.reports[0].debt.accelerationClosesLeft = 0), /finance\.reports\[0\]\.debt\.accelerationClosesLeft should be an integer in 1\.\./],
    ];

    it.each(round4Cases)('rejects %s', (_name, mutate, message) => {
      expectSaveError(withRound4(mutate), message);
    });
  });

  it('covers a save with every round-2 record present', () => {
    const save: Save = JSON.parse(good);
    expect(save.sales.accounts.length).toBeGreaterThan(1);
    expect(save.sales.routerParcels).toContain(0);
    expect(save.sales.accounts[0].parcel).toBe(0);
    expect(save.milestones[0].id).toBe('firstLight');
    expect(save.notices.length).toBeGreaterThan(0);
    expect(save.notices[0].milestone).not.toBeNull();
    expect(save.finance.reports[0].stats).toBeDefined();
  });

  it('rejects map geometry that would crash street picking on a generated town', () => {
    const town: Save = JSON.parse(serialize(newGame(9)));
    town.city.nodes[3].x = 4_000_000_000_000;
    expectSaveError(JSON.stringify(town), /city\.nodes\[3\]\.x should be an integer in 0\.\.\d+, got 4000000000000/);
    // The untouched town loads and picks.
    const loaded = deserialize(serialize(newGame(9)));
    expect(nearestNode(loaded.city, 10, 10)).toBeGreaterThanOrEqual(0);
  });

  it('either rejects or loads a playable game for any single-field corruption', () => {
    // A tiny town keeps this exhaustive sweep fast: every path in the save,
    // every kind of wrong value. It is on credit, so every debt path is swept:
    // a drawn line with dollar-days, a term loan, reports with debt stats.
    const text = serialize(borrowedGame({ cols: 1, rows: 1, blockW: 2, blockH: 2 }));
    const paths: Array<Array<string | number>> = [];
    const walk = (value: unknown, path: Array<string | number>): void => {
      if (path.length > 0) paths.push(path);
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
      else if (typeof value === 'object' && value !== null) {
        for (const [key, v] of Object.entries(value)) walk(v, [...path, key]);
      }
    };
    walk(JSON.parse(text), []);
    expect(paths.length).toBeGreaterThan(100);
    // The play-through below crosses month closes with subscribers on the books.
    const base = deserialize(text);
    expect(base.sales.accounts.length).toBeGreaterThan(0);
    expect(paths.some((p) => p[0] === 'sales' && p[1] === 'accounts')).toBe(true);
    expect(base.debt.loans).toHaveLength(1);
    expect(base.debt.credit.balance).toBeGreaterThan(0);
    expect(base.debt.credit.balanceDollarDays).toBeGreaterThan(0);
    expect(paths.some((p) => p[0] === 'finance' && p[2] === 2 && p[3] === 'debt')).toBe(true);

    const DELETE = Symbol('delete');
    const replacements: unknown[] = [DELETE, null, 'x', -1, 0, 1.5, true, {}, []];
    const failures: string[] = [];
    for (const path of paths) {
      for (const replacement of replacements) {
        const save: Save = JSON.parse(text);
        const parent = path.slice(0, -1).reduce((node: Save, key) => node[key], save);
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
        // Anything that loads must keep playing without crashing.
        try {
          applyCommand(state, { type: 'layCable', segments: [0, 1, 2, 3], method: 'aerial' });
          applyCommand(state, { type: 'placeCabinet', node: 3 });
          applyCommand(state, { type: 'removeSpan', span: 2 });
          applyCommand(state, { type: 'setPricing', tiers: tierSettings({ fiber500: 60 }) as never, smbMultiplier: 1.75 });
          applyCommand(state, { type: 'drawCredit', amount: 1_000 });
          applyCommand(state, { type: 'prepayLoan', loan: 1, amount: 100 });
          runDays(state, 31);
          applyCommand(state, { type: 'setMarketing', perMonth: 0 });
          applyCommand(state, { type: 'repayCredit', amount: 500 });
          applyCommand(state, { type: 'takeTermLoan', amount: TERM_LOAN_MIN, termYears: 7 });
          runDays(state, 31);
          getService(state);
          // Hovering and clicking the map picks streets through the spatial index.
          nearestNode(state.city, 1, 1);
          nearestSegment(state.city, 1, 1, 0.5);
          deserialize(serialize(state));
        } catch (err) {
          failures.push(`${label}: loaded, then ${String(err)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('either rejects or loads a playable game for any single-field corruption of a round-4 record', () => {
    // The tiny town on credit with every round-4 record populated; only the
    // round-4 paths are swept (the sweep above covers the rest).
    const save0: Save = JSON.parse(serialize(borrowedGame({ cols: 1, rows: 1, blockW: 2, blockH: 2 })));
    populateRound4(save0);
    const text = JSON.stringify(save0);
    expect(() => deserialize(text)).not.toThrow();
    const ROUND4 = new Set(['weather', 'outage', 'conversion', 'locks', 'promo', 'incumbentPromos', 'frozenCloses', 'acceleration', 'ops', 'sweep', 'accelerationClosesLeft']);
    const paths: Array<Array<string | number>> = [];
    const walk = (value: unknown, path: Array<string | number>): void => {
      if (path.some((key) => typeof key === 'string' && ROUND4.has(key))) paths.push(path);
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
      else if (typeof value === 'object' && value !== null) {
        for (const [key, v] of Object.entries(value)) walk(v, [...path, key]);
      }
    };
    walk(save0, []);
    expect(paths.length).toBeGreaterThan(40);

    const DELETE = Symbol('delete');
    const replacements: unknown[] = [DELETE, null, 'x', -1, 0, 1, 1.5, true, {}, [], 1e9];
    const failures: string[] = [];
    for (const path of paths) {
      for (const replacement of replacements) {
        const save: Save = JSON.parse(text);
        const parent = path.slice(0, -1).reduce((node: Save, key) => node[key], save);
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
        try {
          applyCommand(state, { type: 'setPricing', tiers: tierSettings({ fiber500: 70 }) as never, smbMultiplier: 1.5, grandfatherMonths: 1 });
          applyCommand(state, { type: 'setPromo', promo: { percentOff: 10, months: 2 } });
          applyCommand(state, { type: 'convertSpan', span: state.network.spans[0]?.id ?? 1 });
          applyCommand(state, { type: 'repayCredit', amount: 500 });
          runDays(state, 70);
          getService(state);
          deserialize(serialize(state));
        } catch (err) {
          failures.push(`${label}: loaded, then ${String(err)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

/** Saves written by the round-1 (schemaVersion 1) build, frozen before round 2 began. */
function v1Fixture(name: 'v1-grid' | 'v1-town'): string {
  return readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8');
}

describe('schemaVersion 1 saves', () => {
  it.each(['v1-grid', 'v1-town'] as const)('migrates the frozen %s save and keeps the game', (name) => {
    const text = v1Fixture(name);
    const v1: Save = JSON.parse(text);
    expect(v1.schemaVersion).toBe(1);
    const state = deserialize(text);
    expect(state.schemaVersion).toBe(4);

    // The town, plant, money and history are the player's own.
    expect(state.city).toEqual(v1.city);
    expect(state.day).toBe(v1.day);
    expect(state.nextId).toBe(v1.nextId);
    expect(state.rng.events).toBe(v1.rng.events);
    expect(state.rng.sales).toBe(deriveSeed(v1.seed, 'sales'));
    expect(state.rng.weather).toBe(deriveSeed(v1.seed, 'weather'));
    expect(state.finance.cash).toBe(v1.finance.cash);
    expect(state.finance.reports).toEqual(v1.finance.reports);
    expect(state.finance.monthToDate).toEqual(v1.finance.monthToDate);
    expect(state.network.cabinets).toEqual(v1.network.cabinets);
    expect(state.network.spans).toEqual(v1.network.spans.map((s: Save) => ({ ...s, refundable: s.cost, outage: null, conversion: null })));
    expect(state.network.olt).toEqual({ ...v1.network.olt, cards: Math.ceil(v1.network.olt.ponPorts / OLT_PORTS_PER_CARD) });
    expect(state.network.makeReady).toEqual([]);

    // Capex is everything v1 spent net of refunds.
    const capexCategories = ['construction', 'equipment', 'refund'];
    const closed = v1.finance.reports.reduce(
      (sum: number, r: Save) => sum + capexCategories.reduce((t, c) => t + (r.totals[c] ?? 0), 0),
      0,
    );
    const open = v1.finance.monthToDate.filter((e: Save) => capexCategories.includes(e.category)).reduce((t: number, e: Save) => t + e.amount, 0);
    expect(state.finance.capex).toEqual({ osp: -(closed + open), connect: 0, co: 0 });
    expect(state.finance.capex.osp).toBeGreaterThan(0);
    expect(state.finance.negativeMonths).toBe(0);
    expect(state.sales).toEqual(newSales());
    expect(state.milestones).toEqual([]);
    expect(state.notices).toEqual([]);
    expect(state.nextNoticeId).toBe(1);
    expect(state.gameOver).toBeNull();
    // ...and on through v2 to v3: nothing borrowed; and to v4: no storms yet.
    expect(state.debt).toEqual(newDebt());
    expect(state.weather).toEqual(newWeather());

    // Service is unchanged by the migration, and the migrated game saves as v4.
    const again = deserialize(serialize(state));
    expect(again).toEqual(state);
    expect(getService(again).passings).toBe(getService(state).passings);
  });

  it('migrates into the same key order as a fresh game, so equal games hash alike', () => {
    const state = deserialize(v1Fixture('v1-grid'));
    const keys = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(keys)
        : typeof value === 'object' && value !== null
          ? Object.entries(value).map(([k, v]) => [k, keys(v)])
          : null;
    const fresh = newGame(state.seed, { city: state.city });
    expect(Object.keys(state)).toEqual(Object.keys(fresh));
    expect(keys(state.network.olt)).toEqual(keys(fresh.network.olt));
    expect(Object.keys(state.finance)).toEqual(Object.keys(fresh.finance));
  });

  it('still rejects a corrupt v1 save with the field named', () => {
    const v1: Save = JSON.parse(v1Fixture('v1-grid'));
    v1.network.spans[0].segment = 999;
    expectSaveError(JSON.stringify(v1), /network\.spans\[0\]\.segment should be an integer in 0\.\.16, got 999/);
  });
});

describe('schemaVersion 1 saves under the round-2 cabinet reach', () => {
  /** The frozen round-1 town with every street cabled live from the cabinets it already has. */
  function v1TownFullyCabled(): Save {
    const v1: Save = JSON.parse(v1Fixture('v1-town'));
    const cabled = new Set(v1.network.spans.map((s: Save) => s.segment));
    for (const seg of v1.city.segments) {
      if (cabled.has(seg.id)) continue;
      v1.network.spans.push({ id: v1.nextId++, segment: seg.id, method: 'underground', stage: 'live', stageDaysLeft: 0, constructDays: 1, cost: 0, orderedDay: 0, liveDay: 0 });
    }
    for (const s of v1.network.spans) Object.assign(s, { stage: 'live', stageDaysLeft: 0, liveDay: s.liveDay ?? 0 });
    expect(v1.network.cabinets.some((c: Save) => c.stage === 'live')).toBe(true);
    v1.network.version++;
    return v1;
  }

  it('explains, once, the passings a migrated town loses to the new reach', () => {
    const state = deserialize(JSON.stringify(v1TownFullyCabled()));
    const lost = state.notices.filter((n) => n.kind === 'rulesUpdated');
    expect(lost).toHaveLength(1);
    expect(lost[0]?.message).toMatch(/Cabinets changed in this version: each now lights streets within [\d,]+ ft/);
    const [, out, of] = /so ([\d,]+) of your ([\d,]+) passings are out of reach/.exec(lost[0]?.message ?? '') ?? [];
    const passedNow = getService(state).passings;
    expect(Number(of?.replace(/,/g, '')) - Number(out?.replace(/,/g, ''))).toBe(passedNow);
    expect(Number(out?.replace(/,/g, ''))).toBeGreaterThan(0);

    // Saving and loading the migrated game doesn't repeat it.
    const again = deserialize(serialize(state));
    expect(again.notices.filter((n) => n.kind === 'rulesUpdated')).toHaveLength(1);
  });

  it.each(['v1-grid', 'v1-town'] as const)('says nothing when the frozen %s save keeps all its passings', (name) => {
    expect(deserialize(v1Fixture(name)).notices).toEqual([]);
  });
});

/**
 * Saves written by the round-2 (schemaVersion 2) build, frozen before round 3
 * changed GameState: v2-grid is a hand-played Gridville (seed 7, mixed lots,
 * day 357: live and permitting cable, two cabinets, a splitter, subscribers
 * on homes, businesses and apartment buildings); v2-town is the SMART bot on
 * the seed-2027 town for 20 months plus 11 days (mid-month, ~200 subscribers,
 * four milestones).
 */
function v2Fixture(name: 'v2-grid' | 'v2-town'): string {
  return readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8');
}

/**
 * A migrated game with everything round 4 added taken out again (the weather
 * stream and state, span outages and conversions, price locks, the promo
 * settings, the frozen counters), to compare with the save it came from.
 */
function withoutRound4(state: GameState): Save {
  const copy: Save = structuredClone(state);
  delete copy.rng.weather;
  delete copy.weather;
  for (const span of copy.network.spans) {
    expect(span.outage).toBeNull();
    expect(span.conversion).toBeNull();
    delete span.outage;
    delete span.conversion;
  }
  for (const account of copy.sales.accounts) {
    expect(account.locks).toEqual([]);
    delete account.locks;
  }
  expect(copy.sales.promo).toBeNull();
  expect(copy.sales.incumbentPromos).toEqual([]);
  delete copy.sales.promo;
  delete copy.sales.incumbentPromos;
  delete copy.debt.frozenCloses;
  delete copy.debt.acceleration;
  return copy;
}

describe('schemaVersion 2 saves', () => {
  it.each(['v2-grid', 'v2-town'] as const)('migrates the frozen %s save with no debt and keeps everything else', (name) => {
    const text = v2Fixture(name);
    const v2: Save = JSON.parse(text);
    expect(v2.schemaVersion).toBe(2);
    expect(v2.debt).toBeUndefined();
    // A real mid-game save: subscribers, closed months with stats, an open month.
    expect(v2.sales.accounts.length).toBeGreaterThan(0);
    expect(v2.finance.reports.length).toBeGreaterThan(6);
    expect(v2.finance.reports.every((r: Save) => r.stats !== undefined)).toBe(true);
    expect(v2.finance.monthToDate.length).toBeGreaterThan(0);

    const state = deserialize(text);
    expect(state.schemaVersion).toBe(4);
    expect(state.debt).toEqual(newDebt());
    expect(state.weather).toEqual(newWeather());
    const { schemaVersion: _from, ...kept } = v2;
    const { schemaVersion: _to, debt: _debt, ...rest } = withoutRound4(state);
    expect(rest).toEqual(kept);
    expect(state.finance.reports.every((r) => r.debt === undefined)).toBe(true);
    // Nothing to explain: the rules that changed in round 3 do not take anything away.
    expect(state.notices).toEqual(v2.notices);

    // Same key order as a fresh game, so a migrated game hashes like a fresh one.
    expect(Object.keys(state)).toEqual(Object.keys(newGame(state.seed, { city: state.city })));
    expect(deserialize(serialize(state))).toEqual(state);
  });

  it.each(['v2-grid', 'v2-town'] as const)('keeps playing the frozen %s save through month closes', (name) => {
    const state = deserialize(v2Fixture(name));
    const passings = getService(state).passings;
    const reports = state.finance.reports.length;
    const subscribers = subscriberUnits(state);
    expect(passings).toBeGreaterThan(0);
    expect(subscribers).toBeGreaterThan(0);
    runDays(state, 62);
    expect(state.gameOver).toBeNull();
    expect(state.finance.reports.length).toBe(reports + 2);
    expect(state.finance.reports.at(-1)?.stats?.subscribers).toBeGreaterThan(0);
    expect(getService(state).passings).toBeGreaterThanOrEqual(passings);
    expect(deserialize(serialize(state))).toEqual(state);
  });

  it.each(['v2-grid', 'v2-town'] as const)('borrows on the frozen %s save, closes months and defaults deterministically', (name) => {
    const play = (reloadAfterMonths: number | null): GameState => {
      let state = deserialize(v2Fixture(name));
      expect(trailingArr(state)).toBeGreaterThan(0);
      const draw = creditAvailable(state);
      const loan = termCapacity(state);
      expect(draw).toBeGreaterThan(0);
      expect(loan).toBeGreaterThanOrEqual(TERM_LOAN_MIN);
      expect(applyCommand(state, { type: 'drawCredit', amount: draw })).toEqual({ ok: true, cost: -draw });
      expect(applyCommand(state, { type: 'takeTermLoan', amount: loan, termYears: 7 })).toEqual({ ok: true, cost: -loan });
      // Then spend like there is no tomorrow.
      expect(applyCommand(state, { type: 'setMarketing', perMonth: MARKETING_MAX_PER_MONTH }).ok).toBe(true);
      for (let month = 1; month <= 60 && !state.gameOver; month++) {
        runDays(state, 30);
        if (month === reloadAfterMonths) state = deserialize(serialize(state));
      }
      return state;
    };
    const straight = play(null);
    expect(straight.gameOver?.reason).toBe('default');
    // Covenant breaches (or a missed payment) froze the line first; the payment missed while frozen was the default.
    const kinds = straight.notices.map((n) => n.kind);
    const froze = Math.max(kinds.lastIndexOf('creditFrozen'), kinds.lastIndexOf('paymentMissed'));
    expect(froze).toBeGreaterThanOrEqual(0);
    expect(froze).toBeLessThan(kinds.lastIndexOf('gameOver'));
    expect(straight.finance.reports.at(-2)?.debt?.stage).toBe('frozen');
    expect(kinds).not.toContain('insolvencyWarning');
    expect(totalDebt(straight)).toBeGreaterThan(0);
    expect(straight.finance.reports.at(-1)?.debt).toMatchObject({ missedPayment: true, stage: 'frozen' });
    // The same every time, and through a save on the way.
    expect(hashState(play(null))).toBe(hashState(straight));
    expect(hashState(play(2))).toBe(hashState(straight));
    expect(deserialize(serialize(straight))).toEqual(straight);
  });

  it('plays a migrated v2 game exactly like the same game loaded twice', () => {
    const a = deserialize(v2Fixture('v2-grid'));
    const b = deserialize(v2Fixture('v2-grid'));
    for (const state of [a, b]) {
      applyCommand(state, { type: 'layCable', segments: [6, 7], method: 'aerial' });
      runDays(state, 45);
    }
    expect(hashState(a)).toBe(hashState(b));
  });

  it('validates a v2 save as v2 before migrating it, naming the bad field', () => {
    const bad = (mutate: (save: Save) => void): string => {
      const save: Save = JSON.parse(v2Fixture('v2-grid'));
      mutate(save);
      return JSON.stringify(save);
    };
    expectSaveError(bad((s) => (s.network.spans[0].segment = 999)), /network\.spans\[0\]\.segment should be an integer in 0\.\.16, got 999/);
    // Round-3 records cannot appear in a round-2 save.
    expectSaveError(bad((s) => (s.notices[0].kind = 'paymentMissed')), /notices\[0\]\.kind should be one of .*got "paymentMissed"/);
    expectSaveError(bad((s) => (s.finance.monthToDate[0].category = 'loanProceeds')), /finance\.monthToDate\[0\]\.category should be one of .*got "loanProceeds"/);
    expectSaveError(bad((s) => (s.gameOver = { day: 1, reason: 'default', message: 'x' })), /gameOver\.reason should be one of "insolvent", got "default"/);
    // A stray debt object in a v2 save is replaced by the migration, not trusted.
    expect(deserialize(bad((s) => (s.debt = { junk: true }))).debt).toEqual(newDebt());
  });
});

/**
 * Saves written by the round-3 (schemaVersion 3) build, frozen before round 4
 * changed GameState: v3-town is the borrowing SMART bot on the seed-2027 town
 * for 30 months plus 11 days (mid-month, 339 subscribers, a drawn credit line
 * and 10 term loans, compliant); v3-grid is a hand-played 4 x 3 Gridville
 * (seed 7, mixed lots, aerial and underground cable, two cabinets) that
 * borrowed all the bank offered, went warning, penalty and frozen, and sits on
 * its cash: frozen for the last two closes, mid-month on day 440, with its
 * 2 Gig tier no longer offered.
 */
function v3Fixture(name: 'v3-grid' | 'v3-town'): string {
  return readFileSync(new URL(`./testing/${name}.save.json`, import.meta.url), 'utf8');
}

describe('schemaVersion 3 saves', () => {
  it.each(['v3-grid', 'v3-town'] as const)('migrates the frozen %s save, keeping the game and adding round 4 empty', (name) => {
    const text = v3Fixture(name);
    const v3: Save = JSON.parse(text);
    expect(v3.schemaVersion).toBe(3);
    expect(v3.weather).toBeUndefined();
    // A real mid-game save on credit: subscribers, loans, closed months with debt stats, an open month.
    expect(v3.sales.accounts.length).toBeGreaterThan(0);
    expect(v3.debt.loans.length).toBeGreaterThan(0);
    expect(v3.finance.reports.length).toBeGreaterThan(6);
    expect(v3.finance.reports.every((r: Save) => r.stats !== undefined && r.debt !== undefined)).toBe(true);
    expect(v3.finance.monthToDate.length).toBeGreaterThan(0);

    const state = deserialize(text);
    expect(state.schemaVersion).toBe(4);
    expect(state.rng).toEqual({ events: v3.rng.events, sales: v3.rng.sales, weather: deriveSeed(v3.seed, 'weather') });
    expect(state.weather).toEqual(newWeather());
    expect(state.debt.acceleration).toBeNull();
    expect(state.finance.reports.every((r) => r.ops === undefined && r.debt?.sweep === undefined)).toBe(true);

    // Everything else is the player's own, untouched (but the notices explaining the round-4 rules
    // that reach this game: one per unoffered tier with subscribers, and the new frozen rules).
    const frozen = v3.debt.covenant.stage === 'frozen';
    const retired = v3.sales.pricing.tiers.filter(
      (t: Save) => !t.offered && v3.sales.accounts.some((a: Save) => a.tierUnits[t.id] > 0),
    ).length;
    const { schemaVersion: _from, ...kept } = v3;
    const { schemaVersion: _to, ...rest } = withoutRound4(state);
    const added = retired + (frozen ? 1 : 0);
    expect(rest.notices.slice(0, v3.notices.length)).toEqual(kept.notices);
    expect({ ...rest, notices: kept.notices, nextNoticeId: kept.nextNoticeId }).toEqual(kept);
    expect(rest.nextNoticeId).toBe(v3.nextNoticeId + added);
    expect(state.notices.slice(v3.notices.length).map((n) => n.kind)).toEqual(Array.from({ length: added }, () => 'rulesUpdated'));

    // Same key order as a fresh game everywhere round 4 added keys, so a migrated game hashes like a fresh one.
    const fresh = newGame(state.seed, { city: state.city });
    applyCommand(fresh, { type: 'layCable', segments: [0], method: 'aerial' });
    expect(Object.keys(state)).toEqual(Object.keys(fresh));
    expect(Object.keys(state.rng)).toEqual(Object.keys(fresh.rng));
    expect(Object.keys(state.network.spans[0]!)).toEqual(Object.keys(fresh.network.spans[0]!));
    expect(Object.keys(state.sales)).toEqual(Object.keys(newSales()));
    expect(Object.keys(state.debt)).toEqual(Object.keys(newDebt()));
    expect(deserialize(serialize(state))).toEqual(state);
    expect(serialize(deserialize(serialize(state)))).toBe(serialize(state));
  });

  it('counts a frozen line\'s trailing frozen closes, and tells the player the new rules once', () => {
    const grid = deserialize(v3Fixture('v3-grid'));
    expect(grid.debt.covenant.stage).toBe('frozen');
    expect(grid.debt.frozenCloses).toBe(2);
    expect(closesUntilAcceleration(grid)).toBe(FROZEN_ACCELERATION_CLOSES - 2);
    const note = grid.notices.at(-1)!;
    expect(note.kind).toBe('rulesUpdated');
    expect(note.message).toMatch(/while your credit line is frozen, the bank takes \d+% of each month's operating cash flow/);
    expect(note.message).toContain(`after ${FROZEN_ACCELERATION_CLOSES} frozen month closes in a row it calls the loans`);
    // Saving and loading the migrated game doesn't repeat it.
    const told = grid.notices.filter((n) => n.kind === 'rulesUpdated').length;
    expect(deserialize(serialize(grid)).notices.filter((n) => n.kind === 'rulesUpdated')).toHaveLength(told);

    const town = deserialize(v3Fixture('v3-town'));
    expect(town.debt.covenant.stage).toBe('compliant');
    expect(town.debt.frozenCloses).toBe(0);
    expect(closesUntilAcceleration(town)).toBeNull();
  });

  it('leaves a game frozen for years its warning closes before the bank calls the loans', () => {
    const save: Save = JSON.parse(v3Fixture('v3-grid'));
    for (const report of save.finance.reports.slice(-8)) report.debt.stage = 'frozen';
    const state = deserialize(JSON.stringify(save));
    expect(state.debt.frozenCloses).toBe(FROZEN_ACCELERATION_CLOSES - ACCELERATION_WARNING_CLOSES - 1);
    expect(closesUntilAcceleration(state)).toBe(ACCELERATION_WARNING_CLOSES + 1);
    // Frozen with nothing owed counts nothing (the next close lifts the freeze).
    const paid: Save = JSON.parse(v3Fixture('v3-grid'));
    paid.debt.credit.balance = 0;
    paid.debt.credit.balanceDollarDays = 0;
    paid.debt.loans = [];
    const cleared = deserialize(JSON.stringify(paid));
    expect(cleared.debt.frozenCloses).toBe(0);
    expect(cleared.notices.some((n) => n.kind === 'rulesUpdated' && /frozen/.test(n.message))).toBe(false);
  });

  it.each(['v3-grid', 'v3-town'] as const)('keeps playing the frozen %s save through month closes', (name) => {
    const state = deserialize(v3Fixture(name));
    const passings = getService(state).passings;
    const reports = state.finance.reports.length;
    expect(passings).toBeGreaterThan(0);
    expect(subscriberUnits(state)).toBeGreaterThan(0);
    runDays(state, 62);
    expect(state.gameOver).toBeNull();
    expect(state.finance.reports.length).toBe(reports + 2);
    const last = state.finance.reports.at(-1)!;
    expect(last.stats?.subscribers).toBeGreaterThan(0);
    // Round-4 closes write ops and the round-4 debt figures.
    expect(last.ops).toBeDefined();
    expect(last.ops?.lastNoticeId).toBe(state.nextNoticeId - 1);
    expect(last.debt?.frozenCloses).toBe(state.debt.frozenCloses);
    expect(getService(state).passings).toBeGreaterThanOrEqual(passings);
    expect(deserialize(serialize(state))).toEqual(state);
  });

  it.each(['v3-grid', 'v3-town'] as const)('plays the migrated %s save exactly like the same game saved and reloaded', (name) => {
    const play = (reloadAfter: number | null): GameState => {
      let state = deserialize(v3Fixture(name));
      applyCommand(state, { type: 'setMarketing', perMonth: 4_000 });
      for (let month = 1; month <= 6; month++) {
        runDays(state, 30);
        if (month === reloadAfter) state = deserialize(serialize(state));
      }
      return state;
    };
    const straight = play(null);
    expect(hashState(play(3))).toBe(hashState(straight));
    expect(hashState(play(null))).toBe(hashState(straight));
  });

  it('validates a v3 save as v3 before migrating it, naming the bad field', () => {
    const bad = (mutate: (save: Save) => void): string => {
      const save: Save = JSON.parse(v3Fixture('v3-town'));
      mutate(save);
      return JSON.stringify(save);
    };
    expectSaveError(bad((s) => (s.network.spans[0].segment = 1e6)), /network\.spans\[0\]\.segment should be an integer in 0\.\.\d+, got 1000000/);
    expectSaveError(bad((s) => (s.debt.loans[0].balance = 0)), /debt\.loans\[0\]\.balance should be an integer in 1\.\./);
    // Round-4 records cannot appear in a round-3 save.
    expectSaveError(bad((s) => (s.notices[0].kind = 'storm')), /notices\[0\]\.kind should be one of .*got "storm"/);
    expectSaveError(bad((s) => (s.finance.monthToDate[0].category = 'repair')), /finance\.monthToDate\[0\]\.category should be one of .*got "repair"/);
    expectSaveError(bad((s) => delete s.rng.sales), /rng\.sales should be an integer/);
    // Stray round-4 fields in a v3 save are replaced by the migration, not trusted.
    const stray = deserialize(
      bad((s) => {
        s.weather = { junk: true };
        s.rng.weather = 5;
        s.debt.frozenCloses = 99;
        s.sales.promo = { percentOff: 90, months: 99 };
        s.network.spans[0].outage = { junk: true };
        s.sales.accounts[0].locks = [{ junk: true }];
      }),
    );
    expect(stray.weather).toEqual(newWeather());
    expect(stray.rng.weather).toBe(deriveSeed(stray.seed, 'weather'));
    expect(stray.debt.frozenCloses).toBe(0);
    expect(stray.sales.promo).toBeNull();
    expect(stray.network.spans[0]?.outage).toBeNull();
    expect(stray.sales.accounts[0]?.locks).toEqual([]);
  });
});
