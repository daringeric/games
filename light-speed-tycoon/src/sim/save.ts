// Save/load. Pure string <-> GameState; browser storage lives in the UI layer.

import type { GameState } from './types';

const NOT_IMPLEMENTED = 'not implemented';

export class SaveError extends Error {
  override name = 'SaveError';
}

/** JSON text of the full game state. */
export function serialize(state: GameState): string {
  void state;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * Parse and validate a save. Throws SaveError for malformed JSON, a missing or
 * unsupported schemaVersion, or a structurally invalid state.
 */
export function deserialize(json: string): GameState {
  void json;
  throw new Error(NOT_IMPLEMENTED);
}

/** Short stable hash (FNV-1a, hex) of serialize(state); used by determinism tests. */
export function hashState(state: GameState): string {
  void state;
  throw new Error(NOT_IMPLEMENTED);
}
