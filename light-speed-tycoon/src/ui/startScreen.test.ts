// The start screen's view-model (startScreen.ts): name validation and its
// message, suggestion stepping, the difficulty cards and their arrow keys,
// the remembered pick, and what Start sends. Money is checked against
// balance.ts and formatMoney, never literal dollar amounts.

import { describe, expect, it } from 'vitest';
import { DEFAULT_DIFFICULTY, DIFFICULTY_LEVELS } from '../sim/balance';
import { COMPANY_NAME_MAX, normalizeCompanyName, suggestCompanyName } from '../sim/company';
import { newGame } from '../sim/game';
import { showsFirstLaunchStart } from './debugHook';
import { formatMoney } from './format';
import { exportFileName, slug } from './storage';
import {
  DIFFICULTY_STORAGE_KEY,
  NAME_HINT,
  StartModel,
  difficultyCards,
  nameStatus,
  readStoredDifficulty,
  stepDifficulty,
  storeDifficulty,
  townLine,
} from './startScreen';
import type { KeyValueStore } from './startScreen';

const TOWN = 'Otter Junction';

describe('nameStatus', () => {
  it('accepts a name in its stored form, with the hint and a count', () => {
    expect(nameStatus('  Otter   Fiber ')).toEqual({ name: 'Otter Fiber', message: NAME_HINT, count: `11/${COMPANY_NAME_MAX}` });
  });

  it('refuses an empty name and says so', () => {
    for (const raw of ['', '   ', '\t\n']) {
      const status = nameStatus(raw);
      expect(status.name).toBeNull();
      expect(status.message).toBe('Give your company a name.');
      expect(status.count).toBe(`0/${COMPANY_NAME_MAX}`);
    }
  });

  it('refuses a name over the limit and says how long it is (never truncates)', () => {
    const status = nameStatus('x'.repeat(COMPANY_NAME_MAX + 1));
    expect(status.name).toBeNull();
    expect(status.message).toContain(`${COMPANY_NAME_MAX} characters or fewer`);
    expect(status.message).toContain(`${COMPANY_NAME_MAX + 1}`);
    expect(nameStatus('x'.repeat(COMPANY_NAME_MAX)).name).toBe('x'.repeat(COMPANY_NAME_MAX));
  });

  it('agrees with normalizeCompanyName, markup included (it is only ever text)', () => {
    for (const raw of ['<b>Fiber</b>', 'a\u0000b', ' ', 'Bramble Light & Wire']) expect(nameStatus(raw).name).toBe(normalizeCompanyName(raw));
  });
});

describe('difficulty cards', () => {
  it('shows every level, easiest first, with its investment and feel, and one checked', () => {
    const cards = difficultyCards('bootstrapped');
    expect(cards.map((c) => c.id)).toEqual(DIFFICULTY_LEVELS.map((l) => l.id));
    for (const [i, card] of cards.entries()) {
      const level = DIFFICULTY_LEVELS[i]!;
      expect(card).toEqual({ id: level.id, name: level.name, investment: formatMoney(level.startCash), feel: level.feel, checked: level.id === 'bootstrapped' });
    }
    expect(cards.filter((c) => c.checked)).toHaveLength(1);
  });

  it('moves the selection with the arrow keys, wrapping, and Home/End', () => {
    const ids = DIFFICULTY_LEVELS.map((l) => l.id);
    const first = ids[0]!;
    const last = ids.at(-1)!;
    expect(stepDifficulty(first, 'ArrowRight')).toBe(ids[1]);
    expect(stepDifficulty(first, 'ArrowDown')).toBe(ids[1]);
    expect(stepDifficulty(ids[1]!, 'ArrowLeft')).toBe(first);
    expect(stepDifficulty(ids[1]!, 'ArrowUp')).toBe(first);
    expect(stepDifficulty(last, 'ArrowRight')).toBe(first);
    expect(stepDifficulty(first, 'ArrowLeft')).toBe(last);
    expect(stepDifficulty(ids[2]!, 'Home')).toBe(first);
    expect(stepDifficulty(ids[1]!, 'End')).toBe(last);
    expect(stepDifficulty(first, 'Enter')).toBeNull();
    expect(stepDifficulty(first, 'a')).toBeNull();
  });
});

describe('the remembered difficulty', () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };
  const throwing: KeyValueStore = {
    getItem: () => {
      throw new Error('blocked');
    },
    setItem: () => {
      throw new Error('blocked');
    },
  };

  it('is Seed round until something is stored', () => {
    expect(readStoredDifficulty(() => memory())).toBe(DEFAULT_DIFFICULTY);
    expect(DEFAULT_DIFFICULTY).toBe('seed');
  });

  it('round-trips a pick under lst:difficulty', () => {
    const store = memory();
    expect(storeDifficulty(() => store, 'shoestring')).toBe(true);
    expect(store.data.get(DIFFICULTY_STORAGE_KEY)).toBe('shoestring');
    expect(DIFFICULTY_STORAGE_KEY).toBe('lst:difficulty');
    expect(readStoredDifficulty(() => store)).toBe('shoestring');
  });

  it('ignores junk and survives storage that throws or is missing', () => {
    const store = memory();
    store.data.set(DIFFICULTY_STORAGE_KEY, 'nightmare');
    expect(readStoredDifficulty(() => store)).toBe(DEFAULT_DIFFICULTY);
    expect(readStoredDifficulty(() => throwing)).toBe(DEFAULT_DIFFICULTY);
    expect(readStoredDifficulty(() => null)).toBe(DEFAULT_DIFFICULTY);
    expect(
      readStoredDifficulty(() => {
        throw new Error('SecurityError');
      }),
    ).toBe(DEFAULT_DIFFICULTY);
    expect(storeDifficulty(() => throwing, 'angel')).toBe(false);
    expect(storeDifficulty(() => null, 'angel')).toBe(false);
  });
});

describe('StartModel', () => {
  it('starts on the default name for the town, Seed round, ready to start', () => {
    const model = new StartModel(42, TOWN);
    expect(model.name).toBe(suggestCompanyName(TOWN, 0));
    expect(model.difficulty).toBe(DEFAULT_DIFFICULTY);
    expect(model.cards.find((c) => c.checked)?.id).toBe(DEFAULT_DIFFICULTY);
    expect(model.payload()).toEqual({ seed: 42, difficulty: DEFAULT_DIFFICULTY, companyName: suggestCompanyName(TOWN, 0) });
  });

  it('opens on a remembered difficulty, but never an unknown one', () => {
    expect(new StartModel(1, TOWN, 'angel').difficulty).toBe('angel');
    expect(new StartModel(1, TOWN, 'nightmare' as never).difficulty).toBe(DEFAULT_DIFFICULTY);
  });

  it('steps through suggestions, each one different, replacing what was typed', () => {
    const model = new StartModel(1, TOWN);
    const seen = [model.name];
    for (let i = 1; i <= 5; i++) {
      expect(model.suggest()).toBe(suggestCompanyName(TOWN, i));
      expect(model.name).not.toBe(seen.at(-1));
      seen.push(model.name);
    }
    model.type('My Own Fiber');
    expect(model.suggest()).toBe(suggestCompanyName(TOWN, 6));
  });

  it('disables Start while the name is empty or too long, and sends the stored form', () => {
    const model = new StartModel(7, TOWN);
    model.type('');
    expect(model.status.name).toBeNull();
    expect(model.payload()).toBeNull();
    model.type('x'.repeat(COMPANY_NAME_MAX + 1));
    expect(model.payload()).toBeNull();
    model.type('  Heron   Broadband  Co-op ');
    model.pick('bootstrapped');
    expect(model.payload()).toEqual({ seed: 7, difficulty: 'bootstrapped', companyName: 'Heron Broadband Co-op' });
    // The payload is something newGame accepts, and it gets the level's cash and the town shown.
    const choice = model.payload()!;
    const state = newGame(choice.seed, { difficulty: choice.difficulty, companyName: choice.companyName });
    expect(state.company).toEqual({ name: 'Heron Broadband Co-op', difficulty: 'bootstrapped' });
    expect(state.finance.cash).toBe(DIFFICULTY_LEVELS.find((l) => l.id === 'bootstrapped')!.startCash);
    expect(state.city.name).toBe(newGame(choice.seed).city.name);
  });

  it('a new town carries an untouched suggestion along, and keeps a typed name', () => {
    const model = new StartModel(1, TOWN);
    model.suggest();
    model.reroll(2, 'Wren Bluff');
    expect(model.seed).toBe(2);
    expect(model.townName).toBe('Wren Bluff');
    expect(model.name).toBe(suggestCompanyName('Wren Bluff', 1));
    model.type('Kestrel Wire Co');
    model.reroll(3, 'Amber Glen');
    expect(model.name).toBe('Kestrel Wire Co');
    expect(model.payload()).toMatchObject({ seed: 3, companyName: 'Kestrel Wire Co' });
    // Typing the suggestion back counts as untouched.
    model.type(suggestCompanyName('Amber Glen', 1));
    model.reroll(4, 'Sorrel Run');
    expect(model.name).toBe(suggestCompanyName('Sorrel Run', 1));
  });

  it('ignores an unknown difficulty', () => {
    const model = new StartModel(1, TOWN);
    model.pick('angel');
    model.pick('nightmare' as never);
    expect(model.difficulty).toBe('angel');
  });

  it('names the town it will generate', () => {
    expect(townLine('Otter Junction')).toBe('Your town: Otter Junction');
  });
});

describe('when the first-launch start screen shows', () => {
  it('shows on a normal page, and on a debug page only with ?start=1', () => {
    expect(showsFirstLaunchStart('')).toBe(true);
    expect(showsFirstLaunchStart('?seed=12')).toBe(true);
    expect(showsFirstLaunchStart('?debug=1')).toBe(false);
    expect(showsFirstLaunchStart('?seed=12&debug=1')).toBe(false);
    expect(showsFirstLaunchStart('?debug=1&start=1')).toBe(true);
    expect(showsFirstLaunchStart('?debug=0')).toBe(true);
  });
});

describe('the company in export file names', () => {
  it('slugs names to lower-case ASCII words', () => {
    expect(slug('Bramble Light & Wire')).toBe('bramble-light-wire');
    expect(slug('  Café   Fibre! ')).toBe('cafe-fibre');
    expect(slug('<b>x</b>')).toBe('b-x-b');
    expect(slug('光ファイバー')).toBe('');
  });

  it('names the export after the company and the day, else the town', () => {
    const state = newGame(5, { companyName: 'Heron Broadband Co-op' });
    state.day = 123;
    expect(exportFileName(state)).toBe('heron-broadband-co-op-day-123.json');
    const unnamed = newGame(5, { companyName: '光ファイバー' });
    expect(exportFileName(unnamed)).toBe(`${slug(unnamed.city.name)}-day-0.json`);
    unnamed.city.name = '';
    expect(exportFileName(unnamed)).toBe('light-speed-tycoon-day-0.json');
  });
});
