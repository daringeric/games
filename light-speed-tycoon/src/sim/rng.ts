// Seedable PRNG. The sim never calls Math.random(); every random draw comes from
// an Rng whose uint32 state is either derived from the game seed (city generation)
// or stored in GameState.rng (events during play), so a seed plus a command log
// reproduces a game exactly.

import type { GameState, RngStreams } from './types';

/** mulberry32 over a uint32 state. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  /** Current uint32 state; feeding it to `new Rng(state)` continues the same sequence. */
  get state(): number {
    return this.s;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform integer in [min, maxInclusive]. */
  int(min: number, maxInclusive: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(maxInclusive) || maxInclusive < min) {
      throw new RangeError(`Rng.int: bad range [${min}, ${maxInclusive}]`);
    }
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform pick from a non-empty array (throws on empty). */
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('Rng.pick: empty array');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Fisher-Yates shuffle in place; returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = items[i] as T;
      items[i] = items[j] as T;
      items[j] = tmp;
    }
    return items;
  }
}

/** Well-mixed uint32 seed from a base seed and a label, e.g. deriveSeed(seed, 'citygen'). */
export function deriveSeed(seed: number, label: string): number {
  // FNV-1a over the label, keyed by the seed, then murmur3's fmix32 to spread bits.
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Run fn with an Rng over state.rng[stream], then write the advanced state back. */
export function withRng<T>(state: GameState, stream: keyof RngStreams, fn: (rng: Rng) => T): T {
  const rng = new Rng(state.rng[stream]);
  try {
    return fn(rng);
  } finally {
    state.rng[stream] = rng.state;
  }
}
