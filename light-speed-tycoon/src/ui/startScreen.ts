// The start screen (round 4b): name the company, pick a difficulty (the
// starting investment), see the town that will be generated (and reroll it),
// then Start. Shown for a new game only: a first launch with no saved
// company, a fresh ?seed link, the menu's New game (after the replace
// confirm) and the game-over dialog's "Start a new town". The game's logo
// heads it as a title banner (logo.ts), a badge beside the heading on short
// screens.
//
// The logic is a small pure view-model (StartModel and the functions above
// it), unit-tested in startScreen.test.ts without a DOM; StartScreen only
// draws it. The company name is only ever set as text (input value and
// textContent), never as HTML.
//
// The UI picks seeds (the reroll button calls a callback from main.ts, which
// may use Math.random); the sim never does.
//
// Owner: start-screen workstream.

import { DEFAULT_DIFFICULTY, DIFFICULTY_LEVELS } from '../sim/balance';
import { COMPANY_NAME_MAX, checkCompanyName, isDifficultyId, suggestCompanyName } from '../sim/company';
import type { DifficultyId } from '../sim/types';
import { el, icon } from './dom';
import { formatMoney } from './format';
import { logoImage } from './logo';

/** Per-browser memory of the last difficulty picked (a convenience: never game state). */
export const DIFFICULTY_STORAGE_KEY = 'lst:difficulty';

/** What Start hands main.ts: everything newGame needs. */
export interface StartChoice {
  seed: number;
  difficulty: DifficultyId;
  /** Already in normalizeCompanyName's form. */
  companyName: string;
}

// ---------------------------------------------------------------------------
// View-model (pure)
// ---------------------------------------------------------------------------

/** The line under the name field while the name is fine. */
export const NAME_HINT = 'Shown on your HUD, briefings, bank letters and save files.';

export interface NameStatus {
  /** The name Start would use, or null while it is not acceptable. */
  name: string | null;
  /** The line under the field: a hint while it is fine, else why it is not. */
  message: string;
  /** "12/32": the cleaned length against COMPANY_NAME_MAX. */
  count: string;
}

/** Live validation of the name field (company.checkCompanyName): the name, and what to say about it. */
export function nameStatus(raw: string): NameStatus {
  const check = checkCompanyName(raw);
  const count = `${check.length}/${COMPANY_NAME_MAX}`;
  if (check.problem === 'empty') return { name: null, message: 'Give your company a name.', count };
  if (check.problem === 'tooLong') {
    return { name: null, message: `Keep it to ${COMPANY_NAME_MAX} characters or fewer (this one has ${check.length}).`, count };
  }
  return { name: check.name, message: NAME_HINT, count };
}

/** One difficulty card. */
export interface DifficultyCard {
  id: DifficultyId;
  name: string;
  /** The starting investment, formatted ("$750,000"). */
  investment: string;
  feel: string;
  checked: boolean;
}

/** The four cards, easiest first (DIFFICULTY_LEVELS order), with `selected` checked. */
export function difficultyCards(selected: DifficultyId): DifficultyCard[] {
  return DIFFICULTY_LEVELS.map((level) => ({
    id: level.id,
    name: level.name,
    investment: formatMoney(level.startCash),
    feel: level.feel,
    checked: level.id === selected,
  }));
}

/**
 * The radio group's arrow keys: the level `key` moves the selection to
 * (Right/Down next, Left/Up previous, wrapping; Home first, End last), or
 * null for any other key.
 */
export function stepDifficulty(current: DifficultyId, key: string): DifficultyId | null {
  const ids = DIFFICULTY_LEVELS.map((level) => level.id);
  const at = Math.max(0, ids.indexOf(current));
  const last = ids.length - 1;
  let next: number;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = at < last ? at + 1 : 0;
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = at > 0 ? at - 1 : last;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = last;
      break;
    default:
      return null;
  }
  return ids[next] ?? null;
}

/** "Your town: Otter Junction" */
export function townLine(townName: string): string {
  return `Your town: ${townName}`;
}

/** The storage the remembered difficulty lives in; any access may throw (private windows, blocked site data). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** The difficulty this browser picked last, or DEFAULT_DIFFICULTY (nothing stored, junk, or no storage). */
export function readStoredDifficulty(store: () => KeyValueStore | null): DifficultyId {
  try {
    const value = store()?.getItem(DIFFICULTY_STORAGE_KEY);
    return isDifficultyId(value) ? value : DEFAULT_DIFFICULTY;
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

/** Remember the pick for next time; false when storage is unavailable (it only lasts this visit, then). */
export function storeDifficulty(store: () => KeyValueStore | null, id: DifficultyId): boolean {
  try {
    const s = store();
    if (!s) return false;
    s.setItem(DIFFICULTY_STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

/**
 * The start screen's state: the town (its seed and name), the name field
 * (the raw text, which suggestion it came from, and whether the player has
 * typed over it), and the difficulty. Every change goes through a method;
 * the screen reads the getters.
 */
export class StartModel {
  private seedValue: number;
  private town: string;
  /** Index of the current suggestion (suggestCompanyName). */
  private suggestion = 0;
  /** The name field's text, as typed. */
  private raw: string;
  /** The player typed their own name: a new town keeps it rather than suggesting for the new town. */
  private edited = false;
  private picked: DifficultyId;

  constructor(seed: number, townName: string, difficulty: DifficultyId = DEFAULT_DIFFICULTY) {
    this.seedValue = seed;
    this.town = townName;
    this.raw = suggestCompanyName(townName, 0);
    this.picked = isDifficultyId(difficulty) ? difficulty : DEFAULT_DIFFICULTY;
  }

  get seed(): number {
    return this.seedValue;
  }

  get townName(): string {
    return this.town;
  }

  /** The name field's text. */
  get name(): string {
    return this.raw;
  }

  get difficulty(): DifficultyId {
    return this.picked;
  }

  get status(): NameStatus {
    return nameStatus(this.raw);
  }

  get cards(): DifficultyCard[] {
    return difficultyCards(this.picked);
  }

  /** The player typed in the name field. */
  type(raw: string): void {
    this.raw = raw;
    this.edited = raw !== suggestCompanyName(this.town, this.suggestion);
  }

  /** "Suggest a name": the next suggestion for this town (replacing whatever was typed). */
  suggest(): string {
    this.suggestion++;
    this.raw = suggestCompanyName(this.town, this.suggestion);
    this.edited = false;
    return this.raw;
  }

  /** A new town ("New town"): an untouched suggestion follows it, a typed name stays. */
  reroll(seed: number, townName: string): void {
    this.seedValue = seed;
    this.town = townName;
    if (!this.edited) this.raw = suggestCompanyName(townName, this.suggestion);
  }

  pick(id: DifficultyId): void {
    if (isDifficultyId(id)) this.picked = id;
  }

  /** What Start sends, or null while the name is not acceptable (Start is disabled then). */
  payload(): StartChoice | null {
    const name = this.status.name;
    return name === null ? null : { seed: this.seedValue, difficulty: this.picked, companyName: name };
  }
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export interface StartScreenOptions {
  /** The town the screen starts on. */
  seed: number;
  /** The name of the town a seed generates. */
  townName(seed: number): string;
  /** A new random seed for "New town"; leave out to fix the town (a ?seed link): the button is hidden. */
  newSeed?: () => number;
  /** The town changed (after townName): main.ts shows it behind the screen on a first launch. */
  onReroll?: (seed: number) => void;
  /** Start: the screen has closed. */
  onStart(choice: StartChoice): void;
  /**
   * Esc or Back: the screen has closed. Leave out when there is nothing to
   * go back to (a first launch): there is no Back button and Esc does nothing.
   */
  onCancel?: () => void;
}

/** The browser's localStorage, or null where touching it throws. */
function browserStore(): KeyValueStore | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const BACK_ICON = svg('<path d="M15 5l-7 7 7 7"/>');
const DICE_ICON = svg('<rect x="4" y="4" width="16" height="16" rx="4"/><circle cx="9" cy="9" r="1.3" fill="currentColor"/><circle cx="15" cy="15" r="1.3" fill="currentColor"/><circle cx="15" cy="9" r="1.3" fill="currentColor"/><circle cx="9" cy="15" r="1.3" fill="currentColor"/>');
const SPARKLE_ICON = svg('<path d="M10 4l1.6 4.4L16 10l-4.4 1.6L10 16l-1.6-4.4L4 10l4.4-1.6z"/><path d="M18 15v5M15.5 17.5h5"/>');
const TOWN_ICON = svg('<path d="M3 20h18"/><path d="M5 20v-8l4-3 4 3v8"/><path d="M13 20v-11l3-2 3 2v11"/>');

/**
 * The width the title banner's logo is drawn at (startScreen.css: its height
 * times the logo's aspect ratio): a badge beside the heading on short
 * screens, then phones, then the rest. The browser picks the file from it.
 */
const BANNER_SIZES = '(max-height: 500px) 84px, (max-width: 600px) 282px, 394px';

let screenCount = 0;

/** The start screen: a modal dialog (the map and its shortcuts stand aside while it is open). */
export class StartScreen {
  private dialog: HTMLDialogElement | null = null;

  get isOpen(): boolean {
    return this.dialog?.open ?? false;
  }

  /** Close without starting or going back (another game took over). */
  close(): void {
    const dialog = this.dialog;
    this.dialog = null;
    dialog?.close();
  }

  /** Show the screen (closing any open one first). */
  open(opts: StartScreenOptions): void {
    this.close();
    const id = `start-${++screenCount}`;
    const model = new StartModel(opts.seed, opts.townName(opts.seed), readStoredDifficulty(browserStore));
    const cancellable = opts.onCancel !== undefined;

    // The name field.
    const nameId = `${id}-name`;
    const messageId = `${id}-name-msg`;
    const input = el('input', {
      class: 'field start-name',
      attrs: {
        id: nameId,
        type: 'text',
        maxlength: String(COMPANY_NAME_MAX),
        autocomplete: 'off',
        autocapitalize: 'words',
        spellcheck: 'false',
        enterkeyhint: 'go',
        'aria-describedby': messageId,
      },
    });
    input.value = model.name;
    const count = el('span', { class: 'start-count num', attrs: { 'aria-hidden': 'true' } });
    const message = el('p', { class: 'start-name-msg', attrs: { id: messageId, 'aria-live': 'polite' } });
    const suggest = el('button', { class: 'btn start-suggest', attrs: { type: 'button' } }, [icon(SPARKLE_ICON), 'Suggest a name']);

    // The difficulty cards.
    const groupLabelId = `${id}-difficulty`;
    const group = el('div', { class: 'start-cards', attrs: { role: 'radiogroup', 'aria-labelledby': groupLabelId } });
    const cards = new Map<DifficultyId, HTMLButtonElement>();
    for (const card of model.cards) {
      const button = el(
        'button',
        {
          class: 'start-card',
          attrs: { type: 'button', role: 'radio', 'aria-checked': 'false', 'data-difficulty': card.id },
          on: { click: () => pick(card.id, false) },
        },
        [
          el('span', { class: 'start-card-dot', attrs: { 'aria-hidden': 'true' } }),
          el('span', { class: 'start-card-name', text: card.name }),
          el('span', { class: 'start-card-cash num', text: card.investment }),
          el('span', { class: 'start-card-feel', text: card.feel }),
        ],
      );
      cards.set(card.id, button);
      group.append(button);
    }

    // The town.
    const townName = el('span', { class: 'start-town-name', attrs: { 'aria-live': 'polite' } });
    const reroll = opts.newSeed
      ? el('button', { class: 'btn start-reroll', attrs: { type: 'button' } }, [icon(DICE_ICON), 'New town'])
      : null;

    const go = el('button', { class: 'btn start-go', text: 'Start', attrs: { type: 'button' } });
    const back = cancellable
      ? el('button', { class: 'btn start-back', attrs: { type: 'button' } }, [icon(BACK_ICON), 'Back'])
      : null;

    const titleId = `${id}-title`;
    const ledeId = `${id}-lede`;
    const dialog = el('dialog', { class: 'start-screen pill-card', attrs: { 'aria-labelledby': titleId, 'aria-describedby': ledeId } }, [
      // The game's logo as the title banner, on its own navy.
      el('div', { class: 'start-banner' }, [logoImage('start-logo', BANNER_SIZES)]),
      el('header', { class: 'start-head' }, [
        el('div', { class: 'start-heading' }, [
          el('h2', { class: 'start-title', text: 'Start your fiber company', attrs: { id: titleId } }),
          el('p', { class: 'start-lede', text: 'Name it, pick your backing, and wire up a town that grows on its own.', attrs: { id: ledeId } }),
        ]),
        back,
      ]),
      el('div', { class: 'start-body' }, [
        el('section', { class: 'start-section' }, [
          el('div', { class: 'start-label-row' }, [el('label', { class: 'start-label', text: 'Company name', attrs: { for: nameId } }), count]),
          el('div', { class: 'start-name-row' }, [input, suggest]),
          message,
        ]),
        el('section', { class: 'start-section' }, [
          el('div', { class: 'start-label-row' }, [
            el('h3', { class: 'start-label', text: 'Difficulty', attrs: { id: groupLabelId } }),
            el('span', { class: 'start-note', text: 'Only your starting investment differs' }),
          ]),
          group,
        ]),
        el('section', { class: 'start-section start-town' }, [
          icon(TOWN_ICON, 'icon start-town-icon'),
          el('p', { class: 'start-town-line' }, [townName]),
          reroll,
        ]),
      ]),
      el('footer', { class: 'start-actions' }, [go]),
    ]);

    const showName = () => {
      const status = model.status;
      if (input.value !== model.name) input.value = model.name;
      count.textContent = status.count;
      message.textContent = status.message;
      const bad = status.name === null;
      message.classList.toggle('start-name-error', bad);
      input.setAttribute('aria-invalid', String(bad));
      go.disabled = bad;
    };
    const showCards = () => {
      for (const [cardId, button] of cards) {
        const on = cardId === model.difficulty;
        button.setAttribute('aria-checked', String(on));
        // Roving tab stop: Tab reaches the group once, at the checked card.
        button.tabIndex = on ? 0 : -1;
      }
    };
    const showTown = () => {
      townName.textContent = townLine(model.townName);
    };
    function pick(next: DifficultyId, focus: boolean): void {
      model.pick(next);
      showCards();
      if (focus) cards.get(next)?.focus();
    }

    input.addEventListener('input', () => {
      model.type(input.value);
      showName();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        start();
      }
    });
    suggest.addEventListener('click', () => {
      model.suggest();
      showName();
    });
    group.addEventListener('keydown', (e) => {
      const next = stepDifficulty(model.difficulty, e.key);
      if (next === null) return;
      e.preventDefault();
      pick(next, true);
    });
    reroll?.addEventListener('click', () => {
      const seed = opts.newSeed!();
      model.reroll(seed, opts.townName(seed));
      showTown();
      showName();
      opts.onReroll?.(seed);
    });

    // How it closes: Start, or (when there is somewhere to go back to) Esc and Back.
    let outcome: 'start' | 'cancel' | null = null;
    const returnTo = document.activeElement;
    const finish = (how: 'start' | 'cancel') => {
      outcome = how;
      this.dialog = null;
      dialog.close();
    };
    const start = () => {
      if (model.payload() !== null) finish('start');
    };
    go.addEventListener('click', start);
    back?.addEventListener('click', () => finish('cancel'));
    // Esc: back when there is somewhere to go back to, else nothing. (Chrome
    // may still force a close on a repeated Esc; 'close' below reopens it.)
    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !cancellable) e.preventDefault();
    });
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      if (cancellable) finish('cancel');
    });
    dialog.addEventListener('close', () => {
      if (outcome === null && this.dialog === dialog) {
        // Closed by the browser itself: that is Esc, so back, or with nowhere to go back to, stay open.
        if (!cancellable) {
          dialog.showModal();
          input.focus();
          return;
        }
        outcome = 'cancel';
        this.dialog = null;
      }
      dialog.remove();
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus({ preventScroll: true });
      const choice = model.payload();
      if (outcome === 'start' && choice) {
        // Remembered for the next new game in this browser (a convenience: it may not stick).
        storeDifficulty(browserStore, choice.difficulty);
        opts.onStart(choice);
      }
      else if (outcome === 'cancel') opts.onCancel?.();
    });

    showName();
    showCards();
    showTown();
    this.dialog = dialog;
    document.body.append(dialog);
    dialog.showModal();
    input.focus();
    // Ready to type over: the suggestion is a starting point.
    input.select();
  }
}
