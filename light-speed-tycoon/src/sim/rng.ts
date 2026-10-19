// Seedable PRNG. The sim never calls Math.random(); every random draw comes from
// an Rng whose uint32 state is either derived from the game seed (city generation)
// or stored in GameState.rng (events during play), so a seed plus a command log
// reproduces a game exactly.

import type { GameState, RngStreams } from './types';

const NOT_IMPLEMENTED = 'not implemented';

/** mulberry32 over a uint32 state. */
export class Rng {
  constructor(seed: number) {
    void seed;
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Current uint32 state; feeding it to `new Rng(state)` continues the same sequence. */
  get state(): number {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Uniform float in [0, 1). */
  next(): number {
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Uniform integer in [min, maxInclusive]. */
  int(min: number, maxInclusive: number): number {
    void min;
    void maxInclusive;
    throw new Error(NOT_IMPLEMENTED);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    void p;
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Uniform pick from a non-empty array (throws on empty). */
  pick<T>(items: readonly T[]): T {
    void items;
    throw new Error(NOT_IMPLEMENTED);
  }

  /** Fisher-Yates shuffle in place; returns the same array. */
  shuffle<T>(items: T[]): T[] {
    void items;
    throw new Error(NOT_IMPLEMENTED);
  }
}

/** Well-mixed uint32 seed from a base seed and a label, e.g. deriveSeed(seed, 'citygen'). */
export function deriveSeed(seed: number, label: string): number {
  void seed;
  void label;
  throw new Error(NOT_IMPLEMENTED);
}

/** Run fn with an Rng over state.rng[stream], then write the advanced state back. */
export function withRng<T>(state: GameState, stream: keyof RngStreams, fn: (rng: Rng) => T): T {
  void state;
  void stream;
  void fn;
  throw new Error(NOT_IMPLEMENTED);
}
