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

/** A file-name-safe slug: lower case ASCII letters and digits joined by single hyphens, accents dropped ("" when none are left). */
export function slug(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The export's file name (round 4b): "<company>-day-<N>.json", by the
 * town's name when the company's has no letters or digits to use, and
 * "light-speed-tycoon" when neither has.
 */
export function exportFileName(state: GameState): string {
  const base = slug(state.company.name) || slug(state.city.name) || 'light-speed-tycoon';
  return `${base}-day-${state.day}.json`;
}

/** Offer the game as a JSON download. */
export function exportSave(state: GameState): void {
  const blob = new Blob([serialize(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = exportFileName(state);
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
