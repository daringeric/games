// Terrain (round 4b): the grove field shared by the map's trees
// (render/decor) and storm exposure (weather.segmentExposure's wooded term).
// Round 4c/4d: street canopy from the same field (tree-lined neighborhoods
// inside the town, weather.segmentExposure's canopy term).

import { describe, expect, it } from 'vitest';
import { generateCity } from './citygen';
import { Rng, deriveSeed } from './rng';
import { CANOPY_LOW, CANOPY_SPAN } from './balance';
import { canopyAt, cityGroveField, drawGroveField, GROVE_NOISE_CELLS, groveAt, groveNoise, woodedAt } from './terrain';
import { makeGridCity } from './testing/fixtures';
import type { City } from './types';

describe('the grove field', () => {
  it("is the first draws of the city's 'decor' stream, one per block, two blocks spare each way", () => {
    const city = generateCity(2027);
    const field = cityGroveField(city);
    expect(field.width).toBe(Math.ceil(city.width / GROVE_NOISE_CELLS) + 2);
    expect(field.height).toBe(Math.ceil(city.height / GROVE_NOISE_CELLS) + 2);
    const rng = new Rng(deriveSeed(city.seed, 'decor'));
    expect(field.values).toEqual(Array.from({ length: field.width * field.height }, () => rng.next()));
    // Memoized per city; deterministic per seed.
    expect(cityGroveField(city)).toBe(field);
    expect(cityGroveField(generateCity(2027)).values).toEqual(field.values);
    expect(cityGroveField(generateCity(2028)).values).not.toEqual(field.values);
  });

  it('draws exactly width x height values from the Rng it is given, leaving the rest for the trees', () => {
    const city = { width: 20, height: 13 };
    const a = new Rng(9);
    const field = drawGroveField(city, a);
    const b = new Rng(9);
    for (let i = 0; i < field.width * field.height; i++) b.next();
    expect(a.state).toBe(b.state);
  });

  it('blends the block values bilinearly and maps them to a 0..1 grove', () => {
    const field = { width: 3, height: 3, values: [0, 1, 0, 1, 0, 1, 0, 1, 0] };
    expect(groveNoise(field, 0, 0)).toBe(0);
    expect(groveNoise(field, GROVE_NOISE_CELLS, 0)).toBe(1);
    expect(groveNoise(field, GROVE_NOISE_CELLS / 2, 0)).toBeCloseTo(0.5, 12);
    expect(groveNoise(field, GROVE_NOISE_CELLS / 2, GROVE_NOISE_CELLS / 2)).toBeCloseTo(0.5, 12);
    expect(groveAt(field, 0, 0)).toBe(0);
    expect(groveAt(field, GROVE_NOISE_CELLS, 0)).toBe(1);
    expect(groveAt(field, GROVE_NOISE_CELLS / 2, 0)).toBeCloseTo(0.5, 12);
  });
});

describe('woodedAt', () => {
  it('stays within 0..1 everywhere, off the map too', () => {
    const city = generateCity(99);
    for (let y = -2; y <= city.height + 2; y += 3) {
      for (let x = -2; x <= city.width + 2; x += 3) {
        const w = woodedAt(city, x, y);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });

  it('counts groves on open land only: clearing the lots never makes a point less wooded, and often more', () => {
    const city: City = { ...makeGridCity({ cols: 4, rows: 3, blockW: 6, blockH: 6 }), seed: 42 };
    const open: City = { ...city, parcels: [] };
    let higher = 0;
    for (let y = 0; y <= city.height; y++) {
      for (let x = 0; x <= city.width; x++) {
        expect(woodedAt(open, x, y)).toBeGreaterThanOrEqual(woodedAt(city, x, y));
        if (woodedAt(open, x, y) > woodedAt(city, x, y)) higher++;
      }
    }
    expect(higher).toBeGreaterThan(0);
    // With every cell around it open, a point's woodedness is its cells' mean grove.
    const field = cityGroveField(open);
    let sum = 0;
    for (let cy = 6; cy < 10; cy++) for (let cx = 6; cx < 10; cx++) sum += groveAt(field, cx, cy);
    expect(woodedAt(open, 8, 8)).toBeCloseTo(sum / 16, 12);
  });
});

describe('canopyAt (round 4c/4d)', () => {
  it('maps the grove noise to 0..1 between CANOPY_LOW and CANOPY_LOW + CANOPY_SPAN', () => {
    const city = generateCity(2027);
    const field = cityGroveField(city);
    let open = 0;
    let lined = 0;
    for (let y = 0; y <= city.height; y += 2) {
      for (let x = 0; x <= city.width; x += 2) {
        const noise = groveNoise(field, x, y);
        const canopy = canopyAt(city, x, y);
        expect(canopy).toBeCloseTo(Math.max(0, Math.min(1, (noise - CANOPY_LOW) / CANOPY_SPAN)), 12);
        expect(canopy).toBeGreaterThanOrEqual(0);
        expect(canopy).toBeLessThanOrEqual(1);
        if (noise <= CANOPY_LOW) expect(canopy).toBe(0);
        if (noise >= CANOPY_LOW + CANOPY_SPAN) expect(canopy).toBe(1);
        if (canopy === 0) open++;
        if (canopy === 1) lined++;
      }
    }
    // Most of the map is open; some of it is fully tree-lined.
    expect(open).toBeGreaterThan(lined);
    expect(lined).toBeGreaterThan(0);
  });

  it('is drawn independently of the lots: building on a block never changes its canopy', () => {
    const city = generateCity(99);
    const cleared: City = { ...city, parcels: [] };
    for (let y = 0; y <= city.height; y += 3) for (let x = 0; x <= city.width; x += 3) expect(canopyAt(cleared, x, y)).toBe(canopyAt(city, x, y));
  });

  it('comes in neighborhoods: the canopy varies block by block inside the town, deterministically per seed', () => {
    const a = generateCity(424242);
    const b = generateCity(424242);
    const values: number[] = [];
    for (let y = 0; y <= a.height; y++) {
      for (let x = 0; x <= a.width; x++) {
        expect(canopyAt(b, x, y)).toBe(canopyAt(a, x, y));
        values.push(canopyAt(a, x, y));
      }
    }
    // Neighbouring points (a cell apart) differ far less than the field does overall.
    let step = 0;
    let n = 0;
    for (let y = 0; y <= a.height; y++) {
      for (let x = 0; x < a.width; x++) {
        step += Math.abs(canopyAt(a, x + 1, y) - canopyAt(a, x, y));
        n++;
      }
    }
    const mean = values.reduce((t, v) => t + v, 0) / values.length;
    const spread = values.reduce((t, v) => t + Math.abs(v - mean), 0) / values.length;
    expect(step / n).toBeLessThan(spread / 2);
  });
});
