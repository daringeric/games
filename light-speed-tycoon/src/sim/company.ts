// The player's company (round 4b): its name and the difficulty it started at.
//
// Owner: start-screen workstream. The contract implemented the rules the
// save format depends on (normalizeCompanyName, defaultCompanyName,
// difficultyLevel: their meaning must not change, save.ts validates with
// them); the start screen adds checkCompanyName (why a name is refused) and
// the suggested names.
//
// Pure sim (README): no randomness of its own (suggestions are indexed, so
// the start screen's "suggest" button steps through them), arithmetic only.
// Names are fictional: built from the generated town's name and fiber-ish
// words, never a real company's name.

import { DEFAULT_DIFFICULTY, DIFFICULTY_LEVELS } from './balance';
import type { DifficultyLevel } from './balance';
import type { DifficultyId } from './types';

/** Longest company name, in UTF-16 code units (owner decision: 1-32 characters). */
export const COMPANY_NAME_MAX = 32;

/**
 * Characters a company name may not hold: control characters (C0, DEL, C1),
 * lone surrogates, invisible format characters (Unicode Cf: the soft hyphen,
 * zero-width spaces, direction marks, bidi embeddings, overrides and
 * isolates, word joiners, the BOM), except the zero-width non-joiner and
 * joiner some scripts and emoji sequences need inside a word, and the
 * letters that draw as blanks (the Hangul fillers, the Braille blank).
 */
const INVISIBLE = /[\p{Cc}\p{Cs}\u115f\u1160\u2800\u3164\uffa0]|(?![\u200c\u200d])\p{Cf}/gu;

/** A character that draws something: not whitespace, a joiner or a combining mark (marks only decorate the character before them). */
const VISIBLE = /[^\s\u200c\u200d\p{M}]/u;

/**
 * The name as the game stores it, or null when it is not acceptable:
 * invisible characters removed (INVISIBLE: controls, format characters such
 * as zero-width spaces and bidi overrides, blank letters), every run of
 * whitespace collapsed to one space, trimmed; null when that leaves nothing
 * that draws (VISIBLE) or more than COMPANY_NAME_MAX code units (never
 * truncated silently: the start screen says why). A stored name is always
 * its own normal form.
 */
export function normalizeCompanyName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = clean(raw);
  return name.length >= 1 && name.length <= COMPANY_NAME_MAX && VISIBLE.test(name) ? name : null;
}

/** Whitespace runs (tabs and newlines included) to one space, then invisible characters out, trimmed. */
function clean(raw: string): string {
  return raw.replace(/\s+/g, ' ').replace(INVISIBLE, '').replace(/ {2,}/g, ' ').trim();
}

/**
 * The company a game gets when no name was chosen (saves from before round
 * 4b, debug pages that skip the start screen, newGame without a name):
 * "<Town> Fiber" ("Otter Junction Fiber"), or the town name cut to fit
 * before " Fiber" when that is too long, or "Fiber Co" for an empty town name.
 */
export function defaultCompanyName(townName: string): string {
  const suffix = ' Fiber';
  const town = clean(townName);
  if (town === '') return 'Fiber Co';
  const whole = normalizeCompanyName(`${town}${suffix}`);
  if (whole !== null) return whole;
  return normalizeCompanyName(`${town.slice(0, COMPANY_NAME_MAX - suffix.length).trim()}${suffix}`) ?? 'Fiber Co';
}

/** Why a typed name is not acceptable, for the start screen's inline message. */
export type CompanyNameProblem = 'empty' | 'tooLong';

export interface CompanyNameCheck {
  /** The name as it would be stored (normalizeCompanyName), or null. */
  name: string | null;
  /** Null when `name` is set. */
  problem: CompanyNameProblem | null;
  /** Length of the cleaned name in UTF-16 code units (what COMPANY_NAME_MAX limits). */
  length: number;
}

/** normalizeCompanyName with the reason when it refuses: nothing visible left once cleaned, or too long. */
export function checkCompanyName(raw: string): CompanyNameCheck {
  const cleaned = clean(raw);
  const length = cleaned.length;
  const name = normalizeCompanyName(raw);
  if (name !== null) return { name, problem: null, length };
  return { name: null, problem: length === 0 || !VISIBLE.test(cleaned) ? 'empty' : 'tooLong', length };
}

/**
 * Suggested-name patterns, in the order the start screen's "Suggest a name"
 * steps through them, after defaultCompanyName: `town` is the whole town name
 * ("Otter Junction"), `first` its first word ("Otter"). Every fixed word here is
 * generic or invented (no real ISP or telecom brand: company.test.ts checks a
 * blocklist), and the town words come from the generated town.
 */
const PATTERNS: readonly ((t: TownWords) => string)[] = [
  (t) => `${t.first} Light & Wire`,
  (t) => `${t.first} Glassworks`,
  (t) => `${t.first} Broadband Co-op`,
  (t) => `${t.town} Glass & Light`,
  (t) => `${t.first} Strand & Splice`,
  (t) => `${t.town} Fiberworks`,
  (t) => `${t.first} Photon Co.`,
  (t) => `${t.town} Light Co-op`,
  (t) => `${t.first} Fiber Collective`,
  (t) => `${t.first} Line & Lantern`,
  (t) => `${t.town} Broadband`,
  (t) => `${t.first} Wireworks`,
  (t) => `${t.town} Fiber Guild`,
  (t) => `${t.first} Lightworks`,
];

/** Names for a town whose words fit few of the patterns (an empty or very long name): invented, never real. */
const FALLBACK_NAMES: readonly string[] = ['Toy Town Fiber', 'Pocket Light & Wire', 'Tin Can Broadband', 'Lantern Glassworks'];
/** Fewest names suggestCompanyName cycles through (FALLBACK_NAMES top it up). */
const MIN_SUGGESTIONS = 4;

interface TownWords {
  town: string;
  first: string;
}

/**
 * Every suggested name for a town, without repeats: defaultCompanyName first,
 * then PATTERNS in order (those that fit COMPANY_NAME_MAX), topped up from
 * FALLBACK_NAMES when few of them fit, so there are always several.
 */
function suggestions(townName: string): string[] {
  const all = [defaultCompanyName(townName)];
  const add = (raw: string) => {
    const name = normalizeCompanyName(raw);
    if (name !== null && !all.includes(name)) all.push(name);
  };
  const town = clean(townName);
  if (town !== '') {
    const t: TownWords = { town, first: town.split(' ')[0] as string };
    for (const pattern of PATTERNS) add(pattern(t));
  }
  for (const name of FALLBACK_NAMES) {
    if (all.length >= MIN_SUGGESTIONS) break;
    add(name);
  }
  return all;
}

/**
 * The `n`-th suggested company name for a town (n is any integer; it cycles,
 * and a negative n counts back from the end), always acceptable to
 * normalizeCompanyName and never a real company's name: the town's words with
 * fiber-ish ones ("Otter Junction Fiber", "Otter Light & Wire", "Otter
 * Glassworks", "Otter Broadband Co-op", ...). n = 0 is
 * defaultCompanyName. Deterministic; consecutive suggestions always differ.
 */
export function suggestCompanyName(townName: string, n: number): string {
  const all = suggestions(townName);
  const i = Number.isInteger(n) ? ((n % all.length) + all.length) % all.length : 0;
  return all[i] as string;
}

/** How many different names suggestCompanyName cycles through for this town. */
export function suggestionCount(townName: string): number {
  return suggestions(townName).length;
}

/** Whether `value` is a DifficultyId. */
export function isDifficultyId(value: unknown): value is DifficultyId {
  return typeof value === 'string' && DIFFICULTY_LEVELS.some((level) => level.id === value);
}

/** The DIFFICULTY_LEVELS entry for `id` (throws RangeError for an unknown id: callers validate first). */
export function difficultyLevel(id: DifficultyId = DEFAULT_DIFFICULTY): DifficultyLevel {
  const level = DIFFICULTY_LEVELS.find((l) => l.id === id);
  if (!level) throw new RangeError(`Unknown difficulty: ${String(id)}`);
  return level;
}
