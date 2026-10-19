// Game lifecycle: new game, command dispatch and the daily tick.

import { OLT_START_PON_PORTS, START_CASH } from './balance';
import { isFirstOfMonth } from './calendar';
import { generateCity } from './citygen';
import type { CityGenOptions } from './citygen';
import { closeMonth } from './finance';
import { advanceNetwork, getService, layCable, placeCabinet, removeSpan } from './network';
import { deriveSeed, withRng } from './rng';
import type { CableMethod, City, Command, CommandResult, GameState } from './types';

export interface NewGameOptions {
  /** Use this city instead of generating one (tests, scenarios). */
  city?: City;
  cityOptions?: CityGenOptions;
}

/**
 * Fresh game: day 0, START_CASH, empty network with an OLT of
 * OLT_START_PON_PORTS GPON ports, rng.events = deriveSeed(seed, 'events'),
 * city = opts.city ?? generateCity(deriveSeed(seed, 'citygen'), opts.cityOptions).
 */
export function newGame(seed: number, opts: NewGameOptions = {}): GameState {
  // Keep the seed as the uint32 that deriveSeed actually mixes, so it saves and
  // validates as one; every derived stream is unchanged by this.
  const base = seed >>> 0;
  return {
    schemaVersion: 1,
    seed: base,
    day: 0,
    rng: { events: deriveSeed(base, 'events') },
    nextId: 1,
    city: opts.city ?? generateCity(deriveSeed(base, 'citygen'), opts.cityOptions),
    network: { spans: [], cabinets: [], olt: { ponPorts: OLT_START_PON_PORTS, tech: 'gpon' }, version: 0 },
    finance: { cash: START_CASH, monthToDate: [], reports: [] },
  };
}

function reject(reason: string): CommandResult {
  return { ok: false, reason };
}

/** Validate and apply one player command. Never throws for bad input; returns { ok: false, reason }. */
export function applyCommand(state: GameState, cmd: Command): CommandResult {
  // Commands also come from replays, scripts and the console, so check field
  // types here; network.ts checks values (ids in range, known method, cash).
  const raw: unknown = cmd;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return reject('Command must be an object');
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
    default:
      return reject(`Unknown command: ${describeType(fields.type)}`);
  }
}

function describeType(type: unknown): string {
  return typeof type === 'string' ? JSON.stringify(type) : type === undefined ? 'missing type' : typeof type;
}

/**
 * Advance one day: state.day += 1, advanceNetwork, then if the new day is the
 * 1st of a month, closeMonth with the current passings.
 */
export function tick(state: GameState): void {
  state.day += 1;
  advanceNetwork(state);
  if (isFirstOfMonth(state.day)) closeMonth(state, getService(state).passings);
}

export function runDays(state: GameState, days: number): void {
  // A NaN or Infinity here would silently do nothing or hang the caller.
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`runDays: bad day count ${days}`);
  for (let i = 0; i < days; i++) tick(state);
}
