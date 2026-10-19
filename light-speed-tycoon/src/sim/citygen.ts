// Procedural town generator.

import type { City } from './types';

export interface CityGenOptions {
  /** Map width in cells. Default 96. */
  width?: number;
  /** Map height in cells. Default 64. */
  height?: number;
  /** Override the generated town name. */
  name?: string;
}

/**
 * Generate a fictional town from a seed. Pure and deterministic: the same seed
 * and options always produce a deep-equal City. Must satisfy every invariant in
 * types.ts (ids equal indexes; segments axis-aligned between adjacent nodes with
 * no node strictly between them; a < b; every parcel touches its frontage
 * segment; no two parcels overlap; parcels never sit on a street line; the street
 * graph is connected; coNode is a valid node).
 */
export function generateCity(seed: number, opts: CityGenOptions = {}): City {
  void seed;
  void opts;
  throw new Error('not implemented');
}
