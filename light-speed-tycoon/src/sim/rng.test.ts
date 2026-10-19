import { describe, expect, it } from 'vitest';
import { Rng, deriveSeed } from './rng';

describe('Rng', () => {
  it('is deterministic for a seed and resumable from its state', () => {
    const a = new Rng(42);
    const first = [a.next(), a.next(), a.next()];
    const b = new Rng(42);
    expect([b.next(), b.next(), b.next()]).toEqual(first);

    const resumed = new Rng(a.state);
    expect(resumed.next()).toBe(a.next());
  });

  it('stays in range', () => {
    const rng = new Rng(7);
    for (let i = 0; i < 2000; i++) {
      const f = rng.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = rng.int(-3, 3);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(-3);
      expect(n).toBeLessThanOrEqual(3);
    }
  });

  it('hits both ends of an int range', () => {
    const rng = new Rng(1);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rng.int(0, 4));
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects bad ranges and empty picks', () => {
    const rng = new Rng(1);
    expect(() => rng.int(5, 4)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('shuffles in place as a permutation', () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = new Rng(9).shuffle(items);
    expect(out).toBe(items);
    expect([...out].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('deriveSeed', () => {
  it('is stable and separates labels and seeds', () => {
    expect(deriveSeed(1, 'citygen')).toBe(deriveSeed(1, 'citygen'));
    expect(deriveSeed(1, 'citygen')).not.toBe(deriveSeed(1, 'events'));
    expect(deriveSeed(1, 'citygen')).not.toBe(deriveSeed(2, 'citygen'));
    const s = deriveSeed(123, 'x');
    expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true);
  });
});
