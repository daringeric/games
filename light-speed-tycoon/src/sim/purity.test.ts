// The README's sim rules, checked on the source: nothing under src/sim (tests
// aside) touches timers, the clock, Math.random, the DOM, or engine-approximated
// maths (Math.pow/log/exp/trig/hypot/cbrt and the ** operator), so a seed and a
// command log replay identically on every JS engine. Determinism tests run on
// one engine and cannot catch engine-dependent maths; this can.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SIM_DIR = fileURLToPath(new URL('.', import.meta.url));

function simSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...simSources(path));
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(path);
  }
  return out.sort();
}

/**
 * Source with comments, string literals and the text of template literals
 * blanked out (lengths and line breaks kept), so doc comments like a JSDoc
 * opener or prose that says "Date" don't trip the scan. A template literal's
 * ${...} expressions are code and stay in.
 */
function codeOnly(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  // Code from `start` to the end, or (inside a template's ${) to its closing brace.
  const code = (start: number, inTemplate: boolean): [string, number] => {
    let out = '';
    let i = start;
    let depth = 0;
    while (i < source.length) {
      const c = source[i] as string;
      const next = source[i + 1];
      if (c === '/' && next === '/') {
        const end = source.indexOf('\n', i);
        const stop = end < 0 ? source.length : end;
        out += blank(source.slice(i, stop));
        i = stop;
      } else if (c === '/' && next === '*') {
        const end = source.indexOf('*/', i + 2);
        const stop = end < 0 ? source.length : end + 2;
        out += blank(source.slice(i, stop));
        i = stop;
      } else if (c === '"' || c === "'") {
        let j = i + 1;
        while (j < source.length && source[j] !== c) j += source[j] === '\\' ? 2 : 1;
        out += c + blank(source.slice(i + 1, j)) + c;
        i = j + 1;
      } else if (c === '`') {
        const [text, end] = template(i + 1);
        out += '`' + text;
        i = end;
      } else {
        if (inTemplate && c === '{') depth++;
        if (inTemplate && c === '}') {
          if (depth === 0) return [out, i];
          depth--;
        }
        out += c;
        i++;
      }
    }
    return [out, i];
  };
  // A template literal from just after its opening backtick: text blanked, ${...} scanned as code.
  const template = (start: number): [string, number] => {
    let out = '';
    let i = start;
    while (i < source.length) {
      const c = source[i] as string;
      if (c === '\\') {
        out += blank(source.slice(i, i + 2));
        i += 2;
      } else if (c === '`') {
        return [out + '`', i + 1];
      } else if (c === '$' && source[i + 1] === '{') {
        const [inner, end] = code(i + 2, true);
        out += '${' + inner + '}';
        i = end + 1;
      } else {
        out += blank(c);
        i++;
      }
    }
    return [out, i];
  };
  return code(0, false)[0];
}

const FORBIDDEN: readonly [RegExp, string][] = [
  [/\bMath\.(pow|log|log2|log10|log1p|exp|expm1|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|hypot|cbrt|random)\b/, 'engine-approximated or random Math function'],
  [/\*\*/, '** (exponentiation is engine-approximated, like Math.pow)'],
  [/\bDate\b/, 'Date'],
  [/\bperformance\s*\./, 'performance timer'],
  [/\b(setTimeout|setInterval|requestAnimationFrame|queueMicrotask)\b/, 'timer'],
  [/\b(window|document|localStorage)\b/, 'DOM'],
  [/from\s+['"]pixi/, 'Pixi'],
];

/** Every forbidden use in a source text, as "line: what". */
function violations(source: string): string[] {
  const found: string[] = [];
  codeOnly(source)
    .split('\n')
    .forEach((line, i) => {
      for (const [pattern, what] of FORBIDDEN) if (pattern.test(line)) found.push(`${i + 1}: ${what}`);
    });
  return found;
}

describe('sim purity (README architecture rules)', () => {
  it('finds forbidden code and ignores comments and strings', () => {
    expect(violations('const d = (a - b) ** 2;')).toEqual(['1: ** (exponentiation is engine-approximated, like Math.pow)']);
    expect(violations('const t = performance.now();')).toEqual(['1: performance timer']);
    expect(violations('x = Math.pow(2, 3) + Math.sqrt(4);')).toEqual(['1: engine-approximated or random Math function']);
    expect(violations('const r = Math.random();')).toHaveLength(1);
    expect(violations('if (Date.now() < 0) {}')).toEqual(['1: Date']);
    expect(violations('setTimeout(f, 1);')).toEqual(['1: timer']);
    expect(violations('/** Day 0 is Jan 1: not a Date. */\nconst a = 1; // Math.pow is banned\nconst s = "Date ** 2";')).toEqual([]);
    expect(violations('const ok = Math.sqrt(a * a + b * b) * Math.min(1, 2);')).toEqual([]);
    // A template literal's text is prose, but its ${...} expressions are code (nested ones too).
    expect(violations('const s = `Date ** 2 at ${formatMoney(cost)} {not code}`;')).toEqual([]);
    expect(violations('const s = `${Math.pow(2, 3)} homes`;')).toEqual(['1: engine-approximated or random Math function']);
    expect(violations('const s = `on ${day > 0 ? `day ${Date.now()}` : "{x}"} and ${{ a: 1 }.a}`;')).toEqual(['1: Date']);
    expect(violations('const s = `a ${b} c`; const d = x ** 2;')).toEqual(['1: ** (exponentiation is engine-approximated, like Math.pow)']);
  });

  const files = simSources(SIM_DIR);

  it('scans the sim sources', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('sales.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith(join('tuning', 'harness.ts')))).toBe(true);
  });

  it.each(files.map((f) => [relative(SIM_DIR, f), f]))('%s uses arithmetic and Math.sqrt only, and no clock, timer or DOM', (_name, file) => {
    expect(violations(readFileSync(file, 'utf8'))).toEqual([]);
  });
});
