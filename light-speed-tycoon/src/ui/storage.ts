// Browser storage and file import/export. Storage can be missing or throw
// (private windows, blocked site data, quota), so every access is guarded and
// callers get a plain success flag or null.

import { deserialize, serialize } from '../sim/save';
import type { GameState } from '../sim/types';

export const AUTOSAVE_KEY = 'lst:autosave';
/** Autosave for a town opened from a ?seed= link, kept apart so a link never overwrites the main game. */
export const SEED_AUTOSAVE_KEY = 'lst:autosave:seed';
export const SAVE_KEY = 'lst:save';

export function readSave(key: string): GameState | null {
  let text: string | null = null;
  try {
    text = window.localStorage.getItem(key);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    return deserialize(text);
  } catch {
    return null;
  }
}

export function writeSave(key: string, state: GameState): boolean {
  try {
    window.localStorage.setItem(key, serialize(state));
    return true;
  } catch {
    return false;
  }
}

export function removeSave(key: string): boolean {
  try {
    window.localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function hasSave(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    return false;
  }
}

/** Offer the game as a JSON download. */
export function exportSave(state: GameState): void {
  const blob = new Blob([serialize(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${state.city.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-day-${state.day}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  // Give the download a moment to start before releasing the blob.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Parse an imported save file; throws SaveError (or a read error) on bad input. */
export async function importSave(file: File): Promise<GameState> {
  return deserialize(await file.text());
}
