import { describe, expect, it } from 'vitest';
import { DEFAULT_DIFFICULTY, DIFFICULTY_LEVELS, START_CASH } from './balance';
import {
  COMPANY_NAME_MAX,
  checkCompanyName,
  defaultCompanyName,
  difficultyLevel,
  isDifficultyId,
  normalizeCompanyName,
  suggestCompanyName,
  suggestionCount,
} from './company';
import { newGame } from './game';

describe('normalizeCompanyName', () => {
  it('trims, collapses whitespace and drops control characters', () => {
    expect(normalizeCompanyName('  Otter   Junction\tFiber  ')).toBe('Otter Junction Fiber');
    expect(normalizeCompanyName('Wren\u0007 Fiber')).toBe('Wren Fiber');
    expect(normalizeCompanyName('Bramble Light & Wire')).toBe('Bramble Light & Wire');
  });

  it('refuses nothing, too long, or not a string (never truncates)', () => {
    expect(normalizeCompanyName('')).toBeNull();
    expect(normalizeCompanyName('   ')).toBeNull();
    expect(normalizeCompanyName('x'.repeat(COMPANY_NAME_MAX))).toBe('x'.repeat(COMPANY_NAME_MAX));
    expect(normalizeCompanyName('x'.repeat(COMPANY_NAME_MAX + 1))).toBeNull();
    expect(normalizeCompanyName(42)).toBeNull();
    expect(normalizeCompanyName(null)).toBeNull();
  });

  it('drops invisible format characters and bidi overrides, and refuses a name with nothing visible', () => {
    // Zero-width space, word joiners, soft hyphen, left-to-right mark, right-to-left override, blank letters (Hangul filler, Braille blank).
    for (const raw of ['​', '⁠⁠', '­', '‎', '‮', 'ㅤ', '⠀', 'ᅟᅠ', 'ﾠ', '‍', '́', ' ​ ​ ']) {
      expect(normalizeCompanyName(raw), JSON.stringify(raw)).toBeNull();
      expect(checkCompanyName(raw), JSON.stringify(raw)).toMatchObject({ name: null, problem: 'empty' });
      expect(() => newGame(1, { companyName: raw }), JSON.stringify(raw)).toThrow(RangeError);
    }
    expect(normalizeCompanyName('‮Fiber Co')).toBe('Fiber Co');
    expect(normalizeCompanyName('Otter​ Junction⁦ Fiber⁩')).toBe('Otter Junction Fiber');
    expect(normalizeCompanyName('FiberㅤCo')).toBe('FiberCo');
    expect(checkCompanyName('‮Fiber Co')).toEqual({ name: 'Fiber Co', problem: null, length: 8 });
    // Joiners a script or an emoji sequence needs stay inside a visible name.
    expect(normalizeCompanyName('Fiber \u{1F468}‍\u{1F4BB}')).toBe('Fiber \u{1F468}‍\u{1F4BB}');
    expect(normalizeCompanyName('Café Fiber')).toBe('Café Fiber');
  });

  it('keeps markup as plain text (the UI renders names as text)', () => {
    expect(normalizeCompanyName('<b>Fiber</b>')).toBe('<b>Fiber</b>');
  });

  it('is idempotent', () => {
    for (const raw of ['  a  b ', 'Otter Junction Fiber', 'x\u0000y', '‮Fiber ​ Co']) {
      const once = normalizeCompanyName(raw);
      expect(once).not.toBeNull();
      expect(normalizeCompanyName(once)).toBe(once);
    }
  });
});

describe('defaultCompanyName', () => {
  it('is "<Town> Fiber"', () => {
    expect(defaultCompanyName('Otter Junction')).toBe('Otter Junction Fiber');
  });

  it('fits a long town name and survives an empty one', () => {
    const long = defaultCompanyName('Millstone Crossing Upon The Long River');
    expect(long.endsWith(' Fiber')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(COMPANY_NAME_MAX);
    expect(normalizeCompanyName(long)).toBe(long);
    expect(defaultCompanyName('')).toBe('Fiber Co');
  });
});

/**
 * Real ISP, cable and telecom brands (and product names) a suggested name must
 * never contain. Matched as whole words, case-insensitively; the longer,
 * distinctive ones also as parts of a word ("Otterspectrum").
 */
const REAL_BRANDS = [
  'Comcast', 'Xfinity', 'Verizon', 'Fios', 'AT&T', 'U-verse', 'Spectrum', 'Charter', 'Cox', 'Frontier', 'Lumen',
  'CenturyLink', 'Quantum', 'Windstream', 'Kinetic', 'Sonic', 'Ting', 'Google', 'Starlink', 'Optimum', 'Altice',
  'Lightpath', 'Suddenlink', 'Mediacom', 'Altafiber', 'Cincinnati Bell', 'Brightspeed', 'Ziply', 'Metronet',
  'Astound', 'RCN', 'Grande', 'Wave', 'WOW', 'Breezeline', 'Sparklight', 'Cable One', 'Midco', 'Hotwire',
  'Fidium', 'Consolidated', 'Ripple', 'Clearwave', 'Everstream', 'Bluepeak', 'Lumos', 'Allo', 'Glo', 'Surf',
  'EarthLink', 'Viasat', 'HughesNet', 'Starry', 'T-Mobile', 'Sprint', 'Cogent', 'Zayo', 'Openreach', 'Hyperoptic',
  'Gigaclear', 'Vodafone', 'Virgin', 'Sky', 'BT', 'Telstra', 'Optus', 'Rogers', 'Bell', 'Telus', 'Shaw', 'Orange',
];

/** The brand words found in `name`. */
function brandsIn(name: string): string[] {
  const lower = name.toLowerCase();
  return REAL_BRANDS.filter((brand) => {
    const b = brand.toLowerCase();
    const escaped = b.replace(/[.*+?^${}()|[\]\\&-]/g, (c) => `\\${c}`);
    return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`).test(lower) || (b.length >= 6 && lower.includes(b));
  });
}

/** Every suggestion for a town, once round the cycle. */
function allSuggestions(town: string): string[] {
  return Array.from({ length: suggestionCount(town) }, (_, n) => suggestCompanyName(town, n));
}

/** Town names the game generates (a spread of seeds), plus odd ones a test city or an old save might carry. */
const TOWNS = [
  ...new Set(Array.from({ length: 24 }, (_, seed) => newGame(seed).city.name)),
  'Otter Junction',
  'Wren',
  'Millstone Crossing',
  'Millstone Crossing Upon The Long River',
  'x'.repeat(40),
  '',
  '  Bramble   Ford ',
];

describe('suggestCompanyName', () => {
  it('starts with the default name, then steps through acceptable names and cycles', () => {
    const town = 'Otter Junction';
    expect(suggestCompanyName(town, 0)).toBe(defaultCompanyName(town));
    const names = allSuggestions(town);
    expect(names.length).toBeGreaterThan(10);
    expect(new Set(names).size).toBe(names.length);
    expect(suggestCompanyName(town, names.length)).toBe(names[0]);
    expect(suggestCompanyName(town, -1)).toBe(names.at(-1));
    expect(suggestCompanyName(town, 1.5)).toBe(names[0]);
    // The owner's examples are the kind of name it makes.
    expect(names).toEqual(expect.arrayContaining(['Otter Junction Fiber', 'Otter Light & Wire', 'Otter Glassworks', 'Otter Broadband Co-op']));
  });

  it('always gives acceptable names, and consecutive suggestions differ, for any town', () => {
    for (const town of TOWNS) {
      const names = allSuggestions(town);
      expect(names.length, town).toBeGreaterThanOrEqual(4);
      expect(names[0]).toBe(defaultCompanyName(town));
      for (let n = 0; n < names.length * 2; n++) {
        const name = suggestCompanyName(town, n);
        expect(normalizeCompanyName(name), `${town} #${n}`).toBe(name);
        expect(suggestCompanyName(town, n + 1), `${town} #${n}`).not.toBe(name);
      }
    }
  });

  it('builds on the town’s own words', () => {
    for (const town of TOWNS.slice(0, 10)) {
      const first = town.split(' ')[0] as string;
      for (const name of allSuggestions(town)) expect(name.startsWith(first), `${name} from ${town}`).toBe(true);
    }
  });

  it('never suggests a real company’s name', () => {
    // The check itself catches brands.
    expect(brandsIn('Otter Spectrum Fiber')).toEqual(['Spectrum']);
    expect(brandsIn('AT&T Fiber')).toEqual(['AT&T']);
    expect(brandsIn('Wrenstarlink')).toEqual(['Starlink']);
    expect(brandsIn('Casting Fiber')).toEqual([]);
    for (const town of TOWNS) {
      for (const name of allSuggestions(town)) expect(brandsIn(name), name).toEqual([]);
    }
  });

  it('is deterministic', () => {
    expect(allSuggestions('Bramble Ford')).toEqual(allSuggestions('Bramble Ford'));
    expect(suggestCompanyName('Bramble Ford', 3)).toBe(suggestCompanyName('Bramble Ford', 3));
  });
});

describe('checkCompanyName', () => {
  it('says why a name is refused, and agrees with normalizeCompanyName', () => {
    expect(checkCompanyName('  Otter   Fiber ')).toEqual({ name: 'Otter Fiber', problem: null, length: 11 });
    expect(checkCompanyName('   ')).toEqual({ name: null, problem: 'empty', length: 0 });
    expect(checkCompanyName('\u0007')).toMatchObject({ name: null, problem: 'empty' });
    expect(checkCompanyName('x'.repeat(COMPANY_NAME_MAX + 1))).toEqual({ name: null, problem: 'tooLong', length: COMPANY_NAME_MAX + 1 });
    for (const raw of ['', ' a ', 'x'.repeat(COMPANY_NAME_MAX), 'x'.repeat(COMPANY_NAME_MAX + 1), 'a\tb', '<i>x</i>']) {
      expect(checkCompanyName(raw).name).toBe(normalizeCompanyName(raw));
    }
  });
});

describe('difficulty levels', () => {
  it('knows every level and finds it', () => {
    for (const level of DIFFICULTY_LEVELS) {
      expect(isDifficultyId(level.id)).toBe(true);
      expect(difficultyLevel(level.id)).toBe(level);
    }
    expect(isDifficultyId('nightmare')).toBe(false);
    expect(() => difficultyLevel('nightmare' as never)).toThrow(RangeError);
    expect(difficultyLevel().startCash).toBe(START_CASH);
    expect(difficultyLevel(DEFAULT_DIFFICULTY).id).toBe('seed');
  });
});
