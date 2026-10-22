// Game lifecycle: new game, command dispatch and the daily tick.

import { DEFAULT_DIFFICULTY, OLT_START_CARDS, OLT_START_PON_PORTS } from './balance';
import { newAdvisorState, noteAdviceShown, snoozeAdvice } from './advisor';
import { isFirstOfMonth } from './calendar';
import { generateCity } from './citygen';
import type { CityGenOptions } from './citygen';
import { defaultCompanyName, difficultyLevel, isDifficultyId, normalizeCompanyName } from './company';
import { newCustomers, runCampaign, setReferrals, setSupport, stepCustomers } from './customers';
import { drawCredit, endDebtDay, newDebt, prepayLoan, repayCredit, takeTermLoan } from './debt';
import { closeMonth } from './finance';
import { answerIncumbent, setIntroPromo } from './incumbent';
import {
  addOltCard,
  addSplitter,
  advanceNetwork,
  convertSpan,
  getService,
  layCable,
  placeCabinet,
  removeCabinet,
  removeSpan,
} from './network';
import { deriveSeed, withRng } from './rng';
import { accrueDay, newSales, setMarketing, setPricing, stepSales } from './sales';
import type { CableMethod, City, Command, CommandResult, DifficultyId, GameState, IntroPromo, SupportLevel, TermYears, TierSetting } from './types';
import { newWeather, stepWeather } from './weather';

export interface NewGameOptions {
  /** Use this city instead of generating one (tests, scenarios). */
  city?: City;
  cityOptions?: CityGenOptions;
  /** Round 4b: the difficulty (DEFAULT_DIFFICULTY when omitted): it sets the starting cash. */
  difficulty?: DifficultyId;
  /**
   * Round 4b: the company's name as typed (company.normalizeCompanyName
   * applies); omitted: company.defaultCompanyName(the town's name).
   */
  companyName?: string;
}

/**
 * Fresh game: day 0, the difficulty's starting cash
 * (company.difficultyLevel(opts.difficulty ?? DEFAULT_DIFFICULTY).startCash:
 * START_CASH for the default Seed round), company { name, difficulty },
 * empty network with an OLT of OLT_START_CARDS
 * line cards (OLT_START_PON_PORTS GPON ports), rng.events = deriveSeed(seed,
 * 'events'), rng.sales = deriveSeed(seed, 'sales'), rng.weather =
 * deriveSeed(seed, 'weather'), city = opts.city ??
 * generateCity(deriveSeed(seed, 'citygen'), opts.cityOptions), default pricing
 * and marketing, no subscribers, milestones, notices or capex, no debt
 * (debt.newDebt()), no storms yet (weather.newWeather()), an advisor with
 * nothing snoozed or shown (advisor.newAdvisorState()) and (round 4c/4d)
 * the customers model at its defaults (customers.newCustomers(): Good
 * support, referral credits off, nothing known yet). The difficulty and
 * the company name change nothing else: a seed replays identically at every
 * level but for the cash. Throws RangeError for an unknown difficulty or a
 * name normalizeCompanyName rejects (the start screen validates first).
 */
export function newGame(seed: number, opts: NewGameOptions = {}): GameState {
  // Keep the seed as the uint32 that deriveSeed actually mixes, so it saves and
  // validates as one; every derived stream is unchanged by this.
  const base = seed >>> 0;
  const difficulty = opts.difficulty ?? DEFAULT_DIFFICULTY;
  if (!isDifficultyId(difficulty)) throw new RangeError(`newGame: unknown difficulty ${JSON.stringify(difficulty)}`);
  const city = opts.city ?? generateCity(deriveSeed(base, 'citygen'), opts.cityOptions);
  let name = defaultCompanyName(city.name);
  if (opts.companyName !== undefined) {
    const chosen = normalizeCompanyName(opts.companyName);
    if (chosen === null) throw new RangeError(`newGame: company name must be 1-32 characters, got ${JSON.stringify(opts.companyName)}`);
    name = chosen;
  }
  return {
    schemaVersion: 4,
    seed: base,
    company: { name, difficulty },
    day: 0,
    rng: { events: deriveSeed(base, 'events'), sales: deriveSeed(base, 'sales'), weather: deriveSeed(base, 'weather') },
    nextId: 1,
    city,
    network: {
      spans: [],
      cabinets: [],
      olt: { ponPorts: OLT_START_PON_PORTS, cards: OLT_START_CARDS, tech: 'gpon' },
      makeReady: [],
      version: 0,
    },
    finance: { cash: difficultyLevel(difficulty).startCash, monthToDate: [], reports: [], capex: { osp: 0, connect: 0, co: 0 }, negativeMonths: 0 },
    debt: newDebt(),
    sales: newSales(),
    customers: newCustomers(),
    weather: newWeather(),
    advisor: newAdvisorState(),
    milestones: [],
    notices: [],
    nextNoticeId: 1,
    gameOver: null,
  };
}

function reject(reason: string): CommandResult {
  return { ok: false, reason };
}

/**
 * Validate and apply one player command. Never throws for bad input; returns
 * { ok: false, reason }. Once state.gameOver is set every command is rejected.
 *
 * Financing (round 3): drawCredit { amount: number }, repayCredit
 * { amount: number }, takeTermLoan { amount: number, termYears: number } and
 * prepayLoan { loan: number, amount: number } are field-type checked here
 * and handed to debt.ts, which checks values (whole dollars, limits, terms,
 * cash, the covenant stage).
 *
 * Round 4: setPricing's optional grandfatherMonths must be a number when
 * present (sales.setPricing checks its range); setPromo { promo: null |
 * { percentOff: number, months: number } } goes to sales.setPromo;
 * convertSpan { span: number } goes to network.convertSpan with the events
 * stream (its permit draw).
 *
 * Round 4b: answerIncumbent { cabinet: number } goes to
 * incumbent.answerIncumbent; setPromo goes through incumbent.setIntroPromo
 * (which notes the incumbent promos an intro promo answers) to sales.setPromo; snoozeAdvice { key: string } to
 * advisor.snoozeAdvice; noteAdviceShown { keys: string[] } to
 * advisor.noteAdviceShown (each checks values: ranges, lengths, whether
 * the promo or the suggestion exists).
 *
 * Round 4c/4d: runCampaign { cabinet: number } goes to
 * customers.runCampaign, setSupport { level: string } to
 * customers.setSupport, setReferrals { on: boolean } to
 * customers.setReferrals (each checks values: an existing live cabinet, a
 * known level, cash).
 */
export function applyCommand(state: GameState, cmd: Command): CommandResult {
  // Commands also come from replays, scripts and the console, so check field
  // types here; network.ts and sales.ts check values (ids in range, known
  // method, prices in range, cash).
  const raw: unknown = cmd;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reject('Command must be an object');
  if (state.gameOver) return reject(`Game over: ${state.gameOver.message}`);
  const fields = raw as Record<string, unknown>;
  switch (fields.type) {
    case 'layCable': {
      const { segments, method } = fields;
      if (!Array.isArray(segments)) return reject('layCable needs a list of street segments');
      if (!segments.every((id): id is number => typeof id === 'number')) {
        return reject('layCable segments must be numbers');
      }
      if (typeof method !== 'string') return reject('layCable needs a cable method');
      // An unknown method string is rejected by layCable with a message naming it.
      return withRng(state, 'events', (rng) => layCable(state, segments, method as CableMethod, rng));
    }
    case 'placeCabinet':
      if (typeof fields.node !== 'number') return reject('placeCabinet needs a street corner (node id)');
      return placeCabinet(state, fields.node);
    case 'removeSpan':
      if (typeof fields.span !== 'number') return reject('removeSpan needs a cable span id');
      return removeSpan(state, fields.span);
    case 'addSplitter':
      if (typeof fields.cabinet !== 'number') return reject('addSplitter needs a cabinet id');
      return addSplitter(state, fields.cabinet);
    case 'removeCabinet':
      if (typeof fields.cabinet !== 'number') return reject('removeCabinet needs a cabinet id');
      return removeCabinet(state, fields.cabinet);
    case 'addOltCard':
      return addOltCard(state);
    case 'setPricing': {
      const { tiers, smbMultiplier, grandfatherMonths } = fields;
      if (!Array.isArray(tiers) || !tiers.every(isTierSettingShape)) {
        return reject('setPricing needs a list of tiers, each { id, price, offered }');
      }
      if (typeof smbMultiplier !== 'number') return reject('setPricing needs an SMB multiplier');
      if (grandfatherMonths !== undefined && typeof grandfatherMonths !== 'number') {
        return reject('setPricing grandfatherMonths must be a number of months');
      }
      // Unknown ids, prices out of range and the like are rejected by sales.setPricing.
      return grandfatherMonths === undefined ? setPricing(state, tiers, smbMultiplier) : setPricing(state, tiers, smbMultiplier, grandfatherMonths);
    }
    case 'setPromo': {
      const { promo } = fields;
      if (promo !== null && !isPromoShape(promo)) return reject('setPromo needs promo: null or { percentOff, months }');
      // Out-of-range values are rejected by sales.setPromo (round 4b: through incumbent.setIntroPromo, which notes an answered promo).
      return setIntroPromo(state, promo);
    }
    case 'convertSpan': {
      const { span } = fields;
      if (typeof span !== 'number') return reject('convertSpan needs a cable span id');
      return withRng(state, 'events', (rng) => convertSpan(state, span, rng));
    }
    case 'setMarketing':
      if (typeof fields.perMonth !== 'number') return reject('setMarketing needs a monthly budget');
      return setMarketing(state, fields.perMonth);
    case 'drawCredit':
      if (typeof fields.amount !== 'number') return reject('drawCredit needs an amount in dollars');
      return drawCredit(state, fields.amount);
    case 'repayCredit':
      if (typeof fields.amount !== 'number') return reject('repayCredit needs an amount in dollars');
      return repayCredit(state, fields.amount);
    case 'takeTermLoan':
      if (typeof fields.amount !== 'number') return reject('takeTermLoan needs an amount in dollars');
      // An unknown term (6 years, 1.5) is rejected by takeTermLoan naming the terms on offer.
      if (typeof fields.termYears !== 'number') return reject('takeTermLoan needs a term in years');
      return takeTermLoan(state, fields.amount, fields.termYears as TermYears);
    case 'prepayLoan':
      if (typeof fields.loan !== 'number') return reject('prepayLoan needs a loan id');
      if (typeof fields.amount !== 'number') return reject('prepayLoan needs an amount in dollars');
      return prepayLoan(state, fields.loan, fields.amount);
    case 'answerIncumbent':
      if (typeof fields.cabinet !== 'number') return reject('answerIncumbent needs a cabinet id');
      return answerIncumbent(state, fields.cabinet);
    case 'snoozeAdvice':
      if (typeof fields.key !== 'string') return reject('snoozeAdvice needs the suggestion key');
      return snoozeAdvice(state, fields.key);
    case 'noteAdviceShown': {
      const { keys } = fields;
      if (!Array.isArray(keys) || !keys.every((k): k is string => typeof k === 'string')) {
        return reject('noteAdviceShown needs a list of suggestion keys');
      }
      return noteAdviceShown(state, keys);
    }
    case 'runCampaign':
      if (typeof fields.cabinet !== 'number') return reject('runCampaign needs a cabinet id');
      return runCampaign(state, fields.cabinet);
    case 'setSupport':
      if (typeof fields.level !== 'string') return reject('setSupport needs a support level');
      // An unknown level is rejected by customers.setSupport naming the levels.
      return setSupport(state, fields.level as SupportLevel);
    case 'setReferrals':
      if (typeof fields.on !== 'boolean') return reject('setReferrals needs on: true or false');
      return setReferrals(state, fields.on);
    default:
      return reject(`Unknown command: ${describeType(fields.type)}`);
  }
}

function isTierSettingShape(value: unknown): value is TierSetting {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === 'string' && typeof t.price === 'number' && typeof t.offered === 'boolean';
}

function isPromoShape(value: unknown): value is IntroPromo {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const p = value as Record<string, unknown>;
  return typeof p.percentOff === 'number' && typeof p.months === 'number';
}

function describeType(type: unknown): string {
  return typeof type === 'string' ? JSON.stringify(type) : type === undefined ? 'missing type' : typeof type;
}

/**
 * Advance one day. Does nothing once the game is over (the day stops
 * advancing). Otherwise, in order:
 *   debt.endDebtDay: the credit line accrues the day's end-of-day balance
 *     (so every day of a month counts, its last day included, before the
 *     close) and the 'paymentDue' reminder is posted when due
 *   on day 0 only: accrue day 0's billing (sales.accrueDay) at the settings
 *     in effect as the day ends, so commands sent on day 0 count and the first
 *     month bills all of its days (day 0 gets no sales step otherwise)
 *   closing = the new day is the 1st of a month; if so take the passings as
 *     they stood at the end of the ended month (parcels appear by day)
 *   day += 1
 *   if closing: closeMonth (sales stream for churn), which may end the game;
 *     if it did, stop here: no network progress, no sales
 *   advanceNetwork
 *   weather.stepWeather for the new day (weather stream; round 4): repairs,
 *     storms, dig-ins and the month's outage accruals. It sees today's
 *     network progress (a span that went live today can be hit), and the
 *     sales step sees its outages the same day (no signups on a cut-off street)
 *   customers.stepCustomers for the new day (round 4c/4d, no rng): the lit
 *     streets' awareness, campaign strength, waits and memories, before
 *     the signups that read them
 *   stepSales for the new day (sales stream)
 * A span that goes live on the 1st, or a lot that appears that day, belongs to
 * the new month. Day 0 never gets a sales step (no signups or churn), only its
 * accruals.
 */
export function tick(state: GameState): void {
  if (state.gameOver) return;
  endDebtDay(state);
  if (state.day === 0) accrueDay(state);
  const closing = isFirstOfMonth(state.day + 1);
  // Parcels appear by day, so take passings before the day moves on.
  const passings = closing ? getService(state).passings : 0;
  state.day += 1;
  if (closing) withRng(state, 'sales', (rng) => closeMonth(state, passings, rng));
  if (state.gameOver) return;
  advanceNetwork(state);
  withRng(state, 'weather', (rng) => stepWeather(state, rng));
  stepCustomers(state);
  withRng(state, 'sales', (rng) => stepSales(state, rng));
}

/** Run `days` ticks (fewer days pass if the game ends on the way: tick() is then a no-op). */
export function runDays(state: GameState, days: number): void {
  // A NaN or Infinity here would silently do nothing or hang the caller.
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`runDays: bad day count ${days}`);
  for (let i = 0; i < days; i++) tick(state);
}
