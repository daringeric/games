import { describe, expect, it } from 'vitest';
import { TILE_FT } from './balance';
import { LAST_GROWTH_DAY, generateCity, type CityGenOptions } from './citygen';
import type { City, StreetSegment, Zone } from './types';

const SEEDS = Array.from({ length: 40 }, (_, i) => i * 7919 + 1);

const SIZES: { label: string; opts: CityGenOptions; seeds: number[] }[] = [
  { label: 'default 96x64', opts: {}, seeds: SEEDS },
  { label: 'small 48x32', opts: { width: 48, height: 32 }, seeds: SEEDS },
  { label: 'minimum 32x24', opts: { width: 32, height: 24 }, seeds: SEEDS.slice(0, 10) },
];

const cache = new Map<string, City[]>();
function citiesFor(size: (typeof SIZES)[number]): City[] {
  let cities = cache.get(size.label);
  if (!cities) {
    cities = size.seeds.map((seed) => generateCity(seed, size.opts));
    cache.set(size.label, cities);
  }
  return cities;
}

interface Geom {
  horizontal: boolean;
  line: number;
  from: number;
  to: number;
}

function geom(city: City, s: StreetSegment): Geom {
  const a = city.nodes[s.a]!;
  const b = city.nodes[s.b]!;
  return a.y === b.y
    ? { horizontal: true, line: a.y, from: Math.min(a.x, b.x), to: Math.max(a.x, b.x) }
    : { horizontal: false, line: a.x, from: Math.min(a.y, b.y), to: Math.max(a.y, b.y) };
}

function degrees(city: City): number[] {
  const deg = new Array<number>(city.nodes.length).fill(0);
  for (const s of city.segments) {
    deg[s.a]!++;
    deg[s.b]!++;
  }
  return deg;
}

/**
 * Runs a check over every city and fails once with the first few problems;
 * one expect per city keeps 90 cities x thousands of lots fast.
 */
function checkAll(cities: City[], check: (city: City, fail: (msg: string) => void) => void): void {
  const problems: string[] = [];
  for (const city of cities) check(city, (msg) => problems.push(`seed ${city.seed}: ${msg}`));
  expect(problems.slice(0, 10)).toEqual([]);
}

/** Parcel id per cell, or -1, reporting overlaps and out-of-bounds lots. */
function occupancy(city: City, fail: (msg: string) => void): Int32Array {
  const occ = new Int32Array(city.width * city.height).fill(-1);
  for (const p of city.parcels) {
    if (!(Number.isInteger(p.x) && Number.isInteger(p.y) && p.w >= 1 && p.h >= 1)) fail(`parcel ${p.id} shape`);
    if (!(p.x >= 0 && p.y >= 0 && p.x + p.w <= city.width && p.y + p.h <= city.height)) {
      fail(`parcel ${p.id} out of bounds`);
      continue;
    }
    for (let y = p.y; y < p.y + p.h; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        if (occ[y * city.width + x] !== -1) fail(`parcel ${p.id} overlaps at ${x},${y}`);
        occ[y * city.width + x] = p.id;
      }
    }
  }
  return occ;
}

describe.each(SIZES)('generateCity invariants ($label)', (size) => {
  const cities = () => citiesFor(size);

  it('honors the requested size', () => {
    for (const city of cities()) {
      expect(city.width).toBe(size.opts.width ?? 96);
      expect(city.height).toBe(size.opts.height ?? 64);
      expect(city.tileFt).toBe(TILE_FT);
    }
  });

  it('aligns ids with array indexes', () => {
    checkAll(cities(), (city, fail) => {
      city.nodes.forEach((n, i) => n.id !== i && fail(`node ${i} has id ${n.id}`));
      city.segments.forEach((s, i) => s.id !== i && fail(`segment ${i} has id ${s.id}`));
      city.parcels.forEach((p, i) => p.id !== i && fail(`parcel ${i} has id ${p.id}`));
    });
  });

  it('runs segments along grid lines between adjacent nodes', () => {
    checkAll(cities(), (city, fail) => {
      const nodeAt = new Set<string>();
      for (const n of city.nodes) {
        const key = `${n.x},${n.y}`;
        if (!Number.isInteger(n.x) || !Number.isInteger(n.y)) fail(`node ${n.id} off the lattice`);
        if (n.x < 0 || n.x > city.width || n.y < 0 || n.y > city.height) fail(`node ${n.id} out of bounds`);
        if (nodeAt.has(key)) fail(`duplicate node at ${key}`);
        nodeAt.add(key);
      }
      const unitEdges = new Set<string>();
      for (const s of city.segments) {
        const a = city.nodes[s.a];
        const b = city.nodes[s.b];
        if (!a || !b) {
          fail(`segment ${s.id} has a missing endpoint`);
          continue;
        }
        if (s.a >= s.b) fail(`segment ${s.id} has a >= b`);
        if ((a.x === b.x) === (a.y === b.y)) fail(`segment ${s.id} is not axis-aligned`);
        const g = geom(city, s);
        if (s.lengthFt !== (g.to - g.from) * TILE_FT) fail(`segment ${s.id} length ${s.lengthFt}`);
        for (let t = g.from + 1; t < g.to; t++) {
          if (nodeAt.has(g.horizontal ? `${t},${g.line}` : `${g.line},${t}`)) fail(`node strictly inside segment ${s.id}`);
        }
        for (let t = g.from; t < g.to; t++) {
          const key = `${g.horizontal ? 'h' : 'v'}${g.line}:${t}`;
          if (unitEdges.has(key)) fail(`segments overlap at ${key}`);
          unitEdges.add(key);
        }
      }
    });
  });

  it('keeps the street graph connected', () => {
    for (const city of cities()) {
      const adj: number[][] = city.nodes.map(() => []);
      for (const s of city.segments) {
        adj[s.a]!.push(s.b);
        adj[s.b]!.push(s.a);
      }
      const seen = new Set<number>([0]);
      const queue = [0];
      while (queue.length > 0) {
        for (const next of adj[queue.shift()!]!) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      expect(seen.size, `seed ${city.seed}`).toBe(city.nodes.length);
    }
  });

  it('puts every parcel on its frontage segment', () => {
    checkAll(cities(), (city, fail) => {
      for (const p of city.parcels) {
        const s = city.segments[p.segment];
        if (!s) {
          fail(`parcel ${p.id} has no segment`);
          continue;
        }
        const g = geom(city, s);
        const fronts = g.horizontal
          ? (p.y === g.line || p.y + p.h === g.line) && p.x >= g.from && p.x + p.w <= g.to
          : (p.x === g.line || p.x + p.w === g.line) && p.y >= g.from && p.y + p.h <= g.to;
        if (!fronts) fail(`parcel ${p.id} does not front segment ${s.id}`);
      }
    });
  });

  it('keeps parcels in bounds, apart and off the streets', () => {
    checkAll(cities(), (city, fail) => {
      const occ = occupancy(city, fail);
      const at = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < city.width && y < city.height ? occ[y * city.width + x]! : -1;
      // A street edge runs through a parcel's interior exactly when the same
      // parcel owns the cells on both sides of it.
      for (const s of city.segments) {
        const g = geom(city, s);
        for (let t = g.from; t < g.to; t++) {
          const [p, q] = g.horizontal ? [at(t, g.line - 1), at(t, g.line)] : [at(g.line - 1, t), at(g.line, t)];
          if (p !== -1 && p === q) fail(`segment ${s.id} crosses parcel ${p}`);
        }
      }
    });
  });

  it('places the CO at an arterial junction', () => {
    for (const city of cities()) {
      const deg = degrees(city);
      expect(city.coNode).toBeGreaterThanOrEqual(0);
      expect(city.coNode).toBeLessThan(city.nodes.length);
      expect(deg[city.coNode]).toBeGreaterThanOrEqual(2);
      const touchesArterial = city.segments.some(
        (s) => s.streetClass === 'arterial' && (s.a === city.coNode || s.b === city.coNode),
      );
      expect(touchesArterial, `seed ${city.seed}`).toBe(true);
    }
  });

  it('zones lots sensibly', () => {
    checkAll(cities(), (city, fail) => {
      for (const p of city.parcels) {
        if (p.kind === 'mdu' && (p.units < 8 || p.units > 48 || p.w * p.h < 2)) fail(`mdu ${p.id} has ${p.units} units`);
        if (p.kind !== 'mdu' && p.units !== 1) fail(`${p.kind} ${p.id} has ${p.units} units`);
        if (p.zone === 'industrial' && p.kind === 'home') fail(`home ${p.id} in the industrial zone`);
      }
      const downtown = city.parcels.filter((p) => p.zone === 'downtown');
      if (!downtown.some((p) => p.kind === 'smb')) fail('no downtown smb');
      if (!downtown.some((p) => p.kind === 'mdu')) fail('no downtown mdu');
      if (!city.parcels.some((p) => p.zone === 'residential' && p.kind === 'home')) fail('no homes');
      if (!city.segments.some((s) => s.zone === 'downtown')) fail('no downtown streets');
    });
  });

  it('names and classes streets by line', () => {
    checkAll(cities(), (city, fail) => {
      const byLine = new Map<string, { name: string; cls: string }>();
      const lineOfName = new Map<string, string>();
      for (const s of city.segments) {
        const g = geom(city, s);
        const line = `${g.horizontal ? 'h' : 'v'}${g.line}`;
        const seen = byLine.get(line) ?? { name: s.name, cls: s.streetClass };
        byLine.set(line, seen);
        if (s.name !== seen.name || s.streetClass !== seen.cls) fail(`line ${line} mixes ${seen.name} and ${s.name}`);
        const owner = lineOfName.get(s.name) ?? line;
        lineOfName.set(s.name, owner);
        if (owner !== line) fail(`${s.name} names both ${owner} and ${line}`);
        if (s.name.length === 0) fail(`segment ${s.id} has no name`);
      }
      const arterials = new Set(city.segments.filter((s) => s.streetClass === 'arterial').map((s) => s.name));
      if (!arterials.has('Main St')) fail('no Main St');
      if (arterials.size < 2 || arterials.size > 3) fail(`${arterials.size} arterials`);
      if (!city.segments.some((s) => s.streetClass === 'collector')) fail('no collectors');
      if (!city.segments.some((s) => s.streetClass === 'local')) fail('no locals');
    });
  });

  it('keeps rock and day-0 shares in range', () => {
    expect(LAST_GROWTH_DAY).toBe(1825);
    checkAll(cities(), (city, fail) => {
      const rock = city.segments.filter((s) => s.rock).length / city.segments.length;
      if (rock < 0.05 || rock > 0.2) fail(`rock share ${rock}`);
      const day0 = city.parcels.filter((p) => p.appearsDay === 0).length / city.parcels.length;
      if (day0 < 0.7 || day0 > 0.8) fail(`day-0 share ${day0}`);
      for (const p of city.parcels) {
        if (!Number.isInteger(p.appearsDay) || p.appearsDay < 0 || p.appearsDay > LAST_GROWTH_DAY) {
          fail(`parcel ${p.id} appears on day ${p.appearsDay}`);
        }
      }
    });
  });

  it('mixes aerial and underground right-of-way', () => {
    const poles = new Map<Zone, [number, number]>();
    for (const city of cities()) {
      expect(city.segments.some((s) => s.hasPoles)).toBe(true);
      expect(city.segments.some((s) => !s.hasPoles)).toBe(true);
      for (const s of city.segments) {
        const tally = poles.get(s.zone) ?? [0, 0];
        tally[0]++;
        if (s.hasPoles) tally[1]++;
        poles.set(s.zone, tally);
      }
    }
    const share = (zone: Zone) => {
      const [all, withPoles] = poles.get(zone) ?? [0, 0];
      return all === 0 ? NaN : withPoles / all;
    };
    expect(share('downtown')).toBeLessThan(0.3);
    expect(share('residential')).toBeGreaterThan(0.6);
    if (poles.has('rural')) expect(share('rural')).toBeGreaterThan(0.8);
    if (poles.has('industrial')) expect(share('industrial')).toBeGreaterThan(0.8);
  });
});

describe('generateCity', () => {
  const defaults = () => citiesFor(SIZES[0]!);

  it('is deterministic per seed and options', () => {
    for (const seed of SEEDS.slice(0, 5)) {
      expect(generateCity(seed)).toEqual(generateCity(seed));
      expect(generateCity(seed, { width: 48, height: 32 })).toEqual(generateCity(seed, { width: 48, height: 32 }));
    }
    const prints = new Set(defaults().map((c) => JSON.stringify(c.segments) + JSON.stringify(c.parcels)));
    expect(prints.size).toBe(SEEDS.length);
    expect(generateCity(1)).not.toEqual(generateCity(2));
  });

  it('names the town unless told to', () => {
    for (const city of defaults()) expect(city.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    expect(new Set(defaults().map((c) => c.name)).size).toBeGreaterThan(10);
    expect(generateCity(5, { name: 'Testville' }).name).toBe('Testville');
    // The name override doesn't change the town itself.
    expect(generateCity(5, { name: 'Testville' }).segments).toEqual(generateCity(5).segments);
  });

  it('rejects maps that are too small or not whole cells', () => {
    expect(() => generateCity(1, { width: 20, height: 64 })).toThrow(RangeError);
    expect(() => generateCity(1, { width: 96, height: 10 })).toThrow(RangeError);
    expect(() => generateCity(1, { width: 96.5 })).toThrow(RangeError);
  });

  it('is mostly local streets at the default size', () => {
    checkAll(defaults(), (city, fail) => {
      const count = (cls: string) => city.segments.filter((s) => s.streetClass === cls).length;
      if (count('local') < city.segments.length * 0.4) fail(`only ${count('local')} locals`);
      if (count('local') <= count('collector')) fail('more collectors than locals');
    });
  });

  it('hits the scale target at the default size', () => {
    for (const city of defaults()) {
      expect(city.segments.length, `seed ${city.seed}`).toBeGreaterThanOrEqual(250);
      expect(city.segments.length, `seed ${city.seed}`).toBeLessThanOrEqual(600);
      const units = city.parcels.reduce((sum, p) => sum + p.units, 0);
      expect(units, `seed ${city.seed}`).toBeGreaterThanOrEqual(1500);
      expect(units, `seed ${city.seed}`).toBeLessThanOrEqual(3500);
    }
  });

  it('has every zone at the default size', () => {
    for (const city of defaults()) {
      const zones = new Set(city.parcels.map((p) => p.zone));
      expect([...zones].sort(), `seed ${city.seed}`).toEqual(['downtown', 'industrial', 'residential', 'rural']);
      expect(city.parcels.some((p) => p.zone === 'industrial' && p.kind === 'smb')).toBe(true);
    }
  });

  it('grows in clusters: whole new streets fill in over time', () => {
    for (const city of defaults()) {
      const bySegment = new Map<number, number[]>();
      for (const p of city.parcels) bySegment.set(p.segment, [...(bySegment.get(p.segment) ?? []), p.appearsDay]);
      const newStreets = [...bySegment.values()].filter((days) => days.length >= 3 && days.every((d) => d > 0));
      expect(newStreets.length, `seed ${city.seed}`).toBeGreaterThanOrEqual(3);
      const later = city.parcels.filter((p) => p.appearsDay > 0);
      const residential = later.filter((p) => p.zone === 'residential').length;
      expect(residential / later.length, `seed ${city.seed}`).toBeGreaterThan(0.8);
    }
  });

  it('puts downtown near but not exactly at the center', () => {
    for (const city of defaults()) {
      const downtown = city.parcels.filter((p) => p.zone === 'downtown');
      const cx = downtown.reduce((sum, p) => sum + p.x + p.w / 2, 0) / downtown.length;
      const cy = downtown.reduce((sum, p) => sum + p.y + p.h / 2, 0) / downtown.length;
      expect(Math.abs(cx - city.width / 2), `seed ${city.seed}`).toBeLessThan(city.width * 0.2);
      expect(Math.abs(cy - city.height / 2), `seed ${city.seed}`).toBeLessThan(city.height * 0.2);
      const main = city.segments.filter((s) => s.name === 'Main St').map((s) => city.nodes[s.a]!.y);
      expect(main[0], `seed ${city.seed}`).not.toBe(city.height / 2);
    }
  });

  it('generates well under 200 ms', () => {
    generateCity(123); // warm up the JIT
    let worst = 0;
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      generateCity(1000 + i);
      worst = Math.max(worst, performance.now() - start);
    }
    expect(worst).toBeLessThan(200);
  });
});
