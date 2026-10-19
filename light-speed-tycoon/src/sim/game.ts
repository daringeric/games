// Game lifecycle: new game, command dispatch and the daily tick.

import type { CityGenOptions } from './citygen';
import type { City, Command, CommandResult, GameState } from './types';

const NOT_IMPLEMENTED = 'not implemented';

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
  void seed;
  void opts;
  throw new Error(NOT_IMPLEMENTED);
}

/** Validate and apply one player command. Never throws for bad input; returns { ok: false, reason }. */
export function applyCommand(state: GameState, cmd: Command): CommandResult {
  void state;
  void cmd;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Advance one day: state.day += 1, advanceNetwork, then if the new day is the
 * 1st of a month, closeMonth with the current passings.
 */
export function tick(state: GameState): void {
  void state;
  throw new Error(NOT_IMPLEMENTED);
}

export function runDays(state: GameState, days: number): void {
  void state;
  void days;
  throw new Error(NOT_IMPLEMENTED);
}
