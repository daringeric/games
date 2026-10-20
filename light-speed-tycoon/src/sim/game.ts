// Game lifecycle: new game, command dispatch and the daily tick.

import { OLT_START_CARDS, OLT_START_PON_PORTS, START_CASH } from './balance';
import { isFirstOfMonth } from './calendar';
import { generateCity } from './citygen';
import type { CityGenOptions } from './citygen';
import { closeMonth } from './finance';
import {
  addOltCard,
  addSplitter,
  advanceNetwork,
  getService,
  layCable,
  placeCabinet,
  removeCabinet,
  removeSpan,
} from './network';
import { deriveSeed, withRng } from './rng';
import { newSales, setMarketing, setPricing, stepSales } from './sales';
import type { CableMethod, City, Command, CommandResult, GameState, TierSetting } from './types';

export interface NewGameOptions {
  /** Use this city instead of generating one (tests, scenarios). */
  city?: City;
  cityOptions?: CityGenOptions;
}

/**
 * Fresh game: day 0, START_CASH, empty network with an OLT of OLT_START_CARDS
 * line cards (OLT_START_PON_PORTS GPON ports), rng.events = deriveSeed(seed,
 * 'events'), rng.sales = deriveSeed(seed, 'sales'), city = opts.city ??
 * generateCity(deriveSeed(seed, 'citygen'), opts.cityOptions), default pricing
 * and marketing, no subscribers, milestones, notices or capex.
 */
export function newGame(seed: number, opts: NewGameOptions = {}): GameState {
  // Keep the seed as the uint32 that deriveSeed actually mixes, so it saves and
  // validates as one; every derived stream is unchanged by this.
  const base = seed >>> 0;
  return {
    schemaVersion: 2,
    seed: base,
    day: 0,
    rng: { events: deriveSeed(base, 'events'), sales: deriveSeed(base, 'sales') },
    nextId: 1,
    city: opts.city ?? generateCity(deriveSeed(base, 'citygen'), opts.cityOptions),
    network: {
      spans: [],
      cabinets: [],
      olt: { ponPorts: OLT_START_PON_PORTS, cards: OLT_START_CARDS, tech: 'gpon' },
      makeReady: [],
      version: 0,
    },
    finance: { cash: START_CASH, monthToDate: [], reports: [], capex: { osp: 0, connect: 0, co: 0 }, negativeMonths: 0 },
    sales: newSales(),
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
      const { tiers, smbMultiplier } = fields;
      if (!Array.isArray(tiers) || !tiers.every(isTierSettingShape)) {
        return reject('setPricing needs a list of tiers, each { id, price, offered }');
      }
      if (typeof smbMultiplier !== 'number') return reject('setPricing needs an SMB multiplier');
      // Unknown ids, prices out of range and the like are rejected by sales.setPricing.
      return setPricing(state, tiers, smbMultiplier);
    }
    case 'setMarketing':
      if (typeof fields.perMonth !== 'number') return reject('setMarketing needs a monthly budget');
      return setMarketing(state, fields.perMonth);
    default:
      return reject(`Unknown command: ${describeType(fields.type)}`);
  }
}

function isTierSettingShape(value: unknown): value is TierSetting {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const t = value as Record<string, unknown>;
  return typeof t.id === 'string' && typeof t.price === 'number' && typeof t.offered === 'boolean';
}

function describeType(type: unknown): string {
  return typeof type === 'string' ? JSON.stringify(type) : type === undefined ? 'missing type' : typeof type;
}

/**
 * Advance one day. Does nothing once the game is over (the day stops
 * advancing). Otherwise, in order:
 *   closing = the new day is the 1st of a month; if so take the passings as
 *     they stood at the end of the ended month (parcels appear by day)
 *   day += 1
 *   if closing: closeMonth (sales stream for churn), which may end the game;
 *     if it did, stop here: no network progress, no sales
 *   advanceNetwork
 *   stepSales for the new day (sales stream)
 * A span that goes live on the 1st, or a lot that appears that day, belongs to
 * the new month. Day 0 never gets a sales step.
 */
export function tick(state: GameState): void {
  if (state.gameOver) return;
  const closing = isFirstOfMonth(state.day + 1);
  // Parcels appear by day, so take passings before the day moves on.
  const passings = closing ? getService(state).passings : 0;
  state.day += 1;
  if (closing) withRng(state, 'sales', (rng) => closeMonth(state, passings, rng));
  if (state.gameOver) return;
  advanceNetwork(state);
  withRng(state, 'sales', (rng) => stepSales(state, rng));
}

/** Run `days` ticks (fewer days pass if the game ends on the way: tick() is then a no-op). */
export function runDays(state: GameState, days: number): void {
  // A NaN or Infinity here would silently do nothing or hang the caller.
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`runDays: bad day count ${days}`);
  for (let i = 0; i < days; i++) tick(state);
}
