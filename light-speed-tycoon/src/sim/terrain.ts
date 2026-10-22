// Terrain (round 4b): the coarse grove field the map's trees are drawn from,
// shared by the sim (weather.segmentExposure: wooded streets are more exposed
// to storms) and the renderer (render/decor.placeTrees), so the streets the
// sim calls wooded are the ones the player sees among trees.
//
// Owner: storms-balance workstream.
//
// Pure sim (README): deterministic from the city alone (its seed, size and
// parcels), arithmetic only, never stored in GameState.
//
// The field: one uniform value per GROVE_NOISE_CELLS x GROVE_NOISE_CELLS
// block of cells, drawn first from new Rng(deriveSeed(city.seed, 'decor'))
// (placeTrees then carries on with the same Rng to place the trees, so the
// draws and the trees are exactly those of round 4), blended bilinearly.
// A cell's grove (0..1) is clamp((noise - GROVE_LOW) / GROVE_SPAN): open
// country gets groves where it is high and clearings where it is low.
//
// Round 4c/4d (sim-economy, spec D): street canopy. Where the same field is
// high inside the town, the neighborhood is an old, tree-lined one: its
// streets run under mature trees whatever the lots along them
// (canopyAt: clamp((noise - CANOPY_LOW) / CANOPY_SPAN)). Weather counts it
// on residential streets (weather.segmentExposure), so storm exposure
// varies block by block inside the town, not only at its wooded edges, and
// the open country next to those neighborhoods carries the map's groves.

import { CANOPY_LOW, CANOPY_SPAN } from './balance';
import { Rng, deriveSeed } from './rng';
import type { City } from './types';

/** Cells per grove noise block. */
export const GROVE_NOISE_CELLS = 6;
/** Noise at or below this is a clearing (grove 0) ... */
const GROVE_LOW = 0.3;
/** ... and at or above GROVE_LOW + this a full grove (grove 1). */
const GROVE_SPAN = 0.4;
/**
 * Cells each way from a point that woodedAt looks at for open land (a
 * (2 x this) x (2 x this) window of cells centred on the point): trees grow
 * only off the lots, so a street through a built-up block reads as less
 * wooded than one through open country, as on the map.
 */
const WOODED_WINDOW = 2;

/** The coarse noise values, one per block, row by row (width x height of them). */
export interface GroveField {
  /** Blocks across: ceil(city.width / GROVE_NOISE_CELLS) + 2. */
  width: number;
  /** Blocks down: ceil(city.height / GROVE_NOISE_CELLS) + 2. */
  height: number;
  /** Uniform [0, 1) draws, values[j * width + i]. */
  values: number[];
}

/**
 * Draw a city's grove field from `rng`: exactly width x height rng.next()
 * draws, row by row. render/decor.placeTrees calls it first on its 'decor'
 * Rng, then places trees with the same Rng.
 */
export function drawGroveField(city: Pick<City, 'width' | 'height'>, rng: Rng): GroveField {
  const width = Math.ceil(city.width / GROVE_NOISE_CELLS) + 2;
  const height = Math.ceil(city.height / GROVE_NOISE_CELLS) + 2;
  const values: number[] = [];
  for (let i = 0; i < width * height; i++) values.push(rng.next());
  return { width, height, values };
}

/** The noise (0..1) at cell coordinates (x, y): the four nearest block values blended bilinearly. */
export function groveNoise(field: GroveField, x: number, y: number): number {
  const fx = x / GROVE_NOISE_CELLS;
  const fy = y / GROVE_NOISE_CELLS;
  const ix = Math.floor(fx);
  const iy = Math.floor(fy);
  const tx = fx - ix;
  const ty = fy - iy;
  const at = (i: number, j: number) => field.values[j * field.width + i] ?? 0;
  const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
  const bottom = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
  return top * (1 - ty) + bottom * ty;
}

/** How much of a grove the cell (x, y) is in, 0 (clearing) .. 1 (full grove): placeTrees' tree density in open country. */
export function groveAt(field: GroveField, x: number, y: number): number {
  return Math.max(0, Math.min(1, (groveNoise(field, x, y) - GROVE_LOW) / GROVE_SPAN));
}

const fieldCache = new WeakMap<City, GroveField>();

/** The grove field of `city` (the one placeTrees draws), memoized per city. */
export function cityGroveField(city: City): GroveField {
  let field = fieldCache.get(city);
  if (!field) {
    field = drawGroveField(city, new Rng(deriveSeed(city.seed, 'decor')));
    fieldCache.set(city, field);
  }
  return field;
}

const lotCache = new WeakMap<City, Uint8Array>();

/** 1 for every cell any parcel (now or later) covers, by y * width + x; memoized per city. */
function lotCells(city: City): Uint8Array {
  let cells = lotCache.get(city);
  if (cells) return cells;
  cells = new Uint8Array(city.width * city.height);
  for (const p of city.parcels) {
    for (let y = Math.max(0, p.y); y < Math.min(city.height, p.y + p.h); y++) {
      for (let x = Math.max(0, p.x); x < Math.min(city.width, p.x + p.w); x++) cells[y * city.width + x] = 1;
    }
  }
  lotCache.set(city, cells);
  return cells;
}

/**
 * How wooded the map point (x, y) is, 0..1 (map grid units: corners of
 * cells): the mean, over the cells within WOODED_WINDOW of it, of each
 * cell's grove (groveAt, the density of the trees placeTrees draws there)
 * where no lot covers the cell, and 0 on lots. Cells off the map count as
 * open country. Pure, deterministic from the city.
 */
export function woodedAt(city: City, x: number, y: number): number {
  const field = cityGroveField(city);
  const lots = lotCells(city);
  const x0 = Math.floor(x) - WOODED_WINDOW;
  const y0 = Math.floor(y) - WOODED_WINDOW;
  let sum = 0;
  let n = 0;
  for (let cy = y0; cy < y0 + 2 * WOODED_WINDOW; cy++) {
    for (let cx = x0; cx < x0 + 2 * WOODED_WINDOW; cx++) {
      n++;
      const inside = cx >= 0 && cy >= 0 && cx < city.width && cy < city.height;
      if (inside && lots[cy * city.width + cx] === 1) continue;
      // Off the map: the grove of the nearest cell on it.
      const gx = Math.max(0, Math.min(city.width - 1, cx));
      const gy = Math.max(0, Math.min(city.height - 1, cy));
      sum += groveAt(field, gx, gy);
    }
  }
  return n > 0 ? sum / n : 0;
}

/**
 * How much of a street at map point (x, y) runs under mature trees, 0 (open)
 * .. 1 (fully tree-lined): clamp((groveNoise - CANOPY_LOW) / CANOPY_SPAN) of
 * the city's grove field there, lots or not (street trees and old yards: a
 * tree-lined block is tree-lined whatever is built along it). The field
 * varies over GROVE_NOISE_CELLS-cell blocks, so canopy comes in
 * neighborhoods: on the tuning towns a fifth to a third of the residential
 * street feet have some, most of them fully tree-lined (the span is narrow).
 * Pure, deterministic from the city (its seed and size), never stored.
 */
export function canopyAt(city: City, x: number, y: number): number {
  return canopyIn(cityGroveField(city), x, y);
}

/**
 * canopyAt from a grove field already drawn (render/decor.placeTrees, which
 * draws the city's field itself): clamp((groveNoise - CANOPY_LOW) /
 * CANOPY_SPAN) at map point (x, y).
 */
export function canopyIn(field: GroveField, x: number, y: number): number {
  return Math.max(0, Math.min(1, (groveNoise(field, x, y) - CANOPY_LOW) / CANOPY_SPAN));
}
