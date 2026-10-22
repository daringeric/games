// The map scene against real Pixi objects (no renderer: nothing is drawn to a
// screen, but every layer builds its geometry). Checks what the map shows, not
// how it looks.

import { describe, expect, it } from 'vitest';
import { Container, Graphics, Text } from 'pixi.js';
import type { Application } from 'pixi.js';
import { applyCommand, newGame, runDays } from '../sim/game';
import { getService } from '../sim/network';
import { makeGridCity } from '../sim/testing/fixtures';
import type { GameState, ParcelId } from '../sim/types';
import { generateCity } from '../sim/citygen';
import { cityExposure, exposureBand } from '../sim/weather';
import { costOverlayThresholds, drawExposureOverlay, EXPOSURE_BANDS, exposureBands, overlayBand } from './cityLayer';
import { OverlayLayer } from './overlay';
import type { OverlaySpec } from './overlay';
import { drawParcel, ParcelLayer } from './parcelLayer';
import type { ParcelLook } from './parcelLayer';
import { streetLattice } from './geometry';
import { Scene } from './scene';
import { toyTown } from './theme';
import { STORM_SHOW_DAYS } from '../sim/balance';
import { stormFade, stormsToShow } from './networkLayer';

function scene(): Scene {
  return new Scene({ stage: new Container() } as unknown as Application, toyTown);
}

/** Grid town (segments 0..8 run east-west, four homes fronting each of 0..5) with segment 0 cabled and lit. */
function litGame(): GameState {
  const state = newGame(7, { city: makeGridCity() });
  applyCommand(state, { type: 'placeCabinet', node: 0 });
  applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
  return state;
}

/** The central office building's Graphics. */
function coGraphics(s: Scene): Graphics {
  const co = s.world.children.find((c) => c.children.some((child) => child instanceof Text));
  const g = co?.children.find((child) => child instanceof Graphics);
  if (!(g instanceof Graphics)) throw new Error('No central office in the scene');
  return g;
}

/** A Graphics that remembers the colour of every fill. */
class FillRecorder extends Graphics {
  readonly colors: string[] = [];
  override fill(...args: Parameters<Graphics['fill']>): this {
    const style = args[0] as unknown;
    const color = typeof style === 'object' && style !== null && 'color' in style ? (style as { color: unknown }).color : style;
    if (typeof color === 'string') this.colors.push(color.toUpperCase());
    return super.fill(...args);
  }
}

/** sRGB hex -> [r, g, b] in 0..255. */
function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hue([r, g, b]: [number, number, number]): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast of `color` laid at `alpha` over `under`, against `under`. */
function washContrast(color: string, alpha: number, under: string): number {
  const c = rgb(color);
  const u = rgb(under);
  const mixed = c.map((v, i) => alpha * v + (1 - alpha) * (u[i] as number)) as [number, number, number];
  const [hi, lo] = [luminance(u), luminance(mixed)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('cabinet coverage colours', () => {
  const { coverage, road, lot } = toyTown;

  it('belong to the Toy Town teal family of the CO and cabinets, not a saturated blue', () => {
    for (const color of [coverage.reach, coverage.litToday, coverage.litGlow, toyTown.cabinet.body]) {
      const h = hue(rgb(color));
      expect(h, color).toBeGreaterThanOrEqual(160);
      expect(h, color).toBeLessThanOrEqual(185);
    }
  });

  it('read over the cream roads and the pale lawns, even at the faintest reach band', () => {
    for (const under of [road.fill, lot.lawn]) {
      expect(washContrast(coverage.reach, coverage.reachAlphaFar, under), under).toBeGreaterThanOrEqual(1.2);
      expect(washContrast(coverage.reach, coverage.reachAlphaNear, under), under).toBeGreaterThanOrEqual(2);
      // Streets a cabinet would light today stand out from the reach shading.
      expect(washContrast(coverage.litToday, coverage.litTodayAlpha, under), under).toBeGreaterThan(washContrast(coverage.reach, coverage.reachAlphaNear, under));
    }
  });
});

describe('drawParcel', () => {
  // Lot 0 an apartment building, lot 1 a shop, the rest homes.
  const city = makeGridCity({
    parcelKinds: (p) => (p.id === 0 ? { kind: 'mdu', units: 12 } : p.id === 1 ? { kind: 'smb', units: 1 } : undefined),
  });
  const lattice = streetLattice(city);
  const fills = (id: ParcelId, look: ParcelLook, units = 0): string[] => {
    const g = new FillRecorder();
    expect(drawParcel(g, city, lattice, city.parcels[id]!, look, toyTown, units)).toBe(true);
    return g.colors;
  };
  const up = (c: string) => c.toUpperCase();

  it('roofs a subscribing home in the subscriber colours, and a passed one in the passed colours', () => {
    const home = city.parcels.findIndex((p) => p.kind === 'home');
    expect(fills(home, 'subscribed')).toContain(up(toyTown.house.subscriber.roof));
    expect(fills(home, 'subscribed')).not.toContain(up(toyTown.house.passed.roof));
    expect(fills(home, 'passed')).toContain(up(toyTown.house.passed.roof));
    expect(fills(home, 'passed')).not.toContain(up(toyTown.house.subscriber.roof));
  });

  it('lights an apartment building unit pip per subscribing unit, and none for a passed one', () => {
    expect(fills(0, 'subscribed', 5)).toContain(up(toyTown.mdu.pipLit));
    expect(fills(0, 'passed')).not.toContain(up(toyTown.mdu.pipLit));
  });

  it('gives a subscribing shop the served awning, and a passed one the passed awning', () => {
    expect(fills(1, 'subscribed')).toContain(up(toyTown.smb.awningServed.stripe));
    expect(fills(1, 'subscribed')).not.toContain(up(toyTown.smb.awningPassed.stripe));
    expect(fills(1, 'passed')).toContain(up(toyTown.smb.awningPassed.stripe));
  });
});

describe('Scene', () => {
  it('draws lit homes as passed and live cable once the network lights a street', () => {
    const state = litGame();
    const s = scene();
    s.sync(state);
    expect(s.stats()).toMatchObject({ passedLots: 0, liveSpans: 0 });

    runDays(state, 120);
    s.sync(state);
    const passed = getService(state).passedParcels.length;
    expect(passed).toBe(4);
    expect(s.stats()).toMatchObject({ passedLots: passed, liveSpans: 1 });
  });

  it('redraws live cable only when the set of live spans changes', () => {
    const state = litGame();
    runDays(state, 120);
    const s = scene();
    s.sync(state);
    const { liveRedraws } = s.stats();

    // Orders and permits bump network.version but leave the live cable alone.
    applyCommand(state, { type: 'placeCabinet', node: 5 });
    applyCommand(state, { type: 'layCable', segments: [1], method: 'aerial' });
    s.sync(state);
    expect(s.stats()).toMatchObject({ liveSpans: 1, liveRedraws });
    while (state.network.spans[1]!.stage === 'permitting') runDays(state, 1);
    s.sync(state);
    expect(s.stats()).toMatchObject({ liveSpans: 1, liveRedraws });

    // A span going live redraws it.
    while (state.network.spans[1]!.stage !== 'live') runDays(state, 1);
    s.sync(state);
    expect(s.stats()).toMatchObject({ liveSpans: 2, liveRedraws: liveRedraws + 1 });

    // So does another game, even one with no live cable at all.
    s.sync(newGame(9, { city: makeGridCity() }));
    expect(s.stats()).toMatchObject({ liveSpans: 0, liveRedraws: liveRedraws + 2 });
  });

  it('redraws live cable for another game whose live spans have the same ids', () => {
    const first = litGame();
    runDays(first, 120);
    // Same ids, different street: segment 9 runs south from the CO.
    const second = newGame(8, { city: makeGridCity() });
    applyCommand(second, { type: 'placeCabinet', node: 0 });
    applyCommand(second, { type: 'layCable', segments: [9], method: 'underground' });
    runDays(second, 120);
    const live = (g: GameState) => g.network.spans.filter((sp) => sp.stage === 'live').map((sp) => sp.id);
    expect(live(second)).toEqual(live(first));

    const s = scene();
    s.sync(first);
    const { liveRedraws } = s.stats();
    s.sync(second);
    expect(s.stats()).toMatchObject({ liveSpans: 1, liveRedraws: liveRedraws + 1 });
  });

  it('destroys the old central office, its GPU context included, when the city changes', () => {
    const s = scene();
    s.sync(newGame(1, { city: makeGridCity() }));
    const old = coGraphics(s);
    const context = old.context;
    s.sync(newGame(2, { city: makeGridCity({ cols: 4 }) }));
    expect(old.destroyed).toBe(true);
    expect(context.destroyed).toBe(true);
    expect(coGraphics(s)).not.toBe(old);
  });

  it('rebuilds the whole map for a good game after a city that fails to build', () => {
    const state = litGame();
    runDays(state, 120);
    const s = scene();
    s.sync(state);
    const before = s.stats();
    expect(before.passedLots).toBe(4);

    // Too big for the per-cell buffers: building it throws partway through.
    const huge = newGame(3, { city: { ...makeGridCity(), width: Number.MAX_SAFE_INTEGER } });
    expect(() => s.sync(huge)).toThrow(RangeError);

    s.sync(state);
    expect(s.stats()).toMatchObject({ passedLots: before.passedLots, liveSpans: before.liveSpans });
    expect(coGraphics(s).destroyed).toBe(false);
    // The ground layer (first in the world) holds the board, roads, rock stipple and trees again.
    expect((s.world.children[0] as Container).children).toHaveLength(4);
  });

  it('draws subscribers, counting their lots as passed too', () => {
    const state = litGame();
    state.sales.marketingPerMonth = 20_000;
    runDays(state, 120);
    for (let i = 0; i < 40 && state.sales.accounts.length === 0; i++) runDays(state, 10);
    expect(state.sales.accounts.length).toBeGreaterThan(0);
    const s = scene();
    s.sync(state);
    const passed = getService(state).passedParcels;
    const subscribed = state.sales.accounts.map((a) => a.parcel);
    expect(s.stats().subscribedLots).toBe(subscribed.length);
    // Every subscriber's lot is lit, so passedLots still counts each passed lot exactly once.
    expect(subscribed.every((p) => passed.includes(p))).toBe(true);
    expect(s.stats().passedLots).toBe(passed.length);
  });

  it('keeps subscriber looks current while one game state plays on (the app mutates it in place)', () => {
    const state = litGame();
    state.sales.marketingPerMonth = 20_000;
    const s = scene();
    s.sync(state);
    expect(s.stats().subscribedLots).toBe(0);
    let subscribed = 0;
    for (let day = 0; day < 900 && subscribed < 2; day++) {
      runDays(state, 1);
      s.sync(state);
      subscribed = new Set(state.sales.accounts.map((a) => a.parcel)).size;
      expect(s.stats().subscribedLots, `day ${state.day}`).toBe(subscribed);
    }
    expect(subscribed).toBeGreaterThan(0);
  });

  it('rings full cabinets, redrawing when the full list changes even if the network did not', () => {
    const state = litGame();
    const s = scene();
    s.sync(state);
    s.takeDirty();
    expect(s.stats().fullCabinets).toBe(0);
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    s.sync(state);
    expect(s.takeDirty()).toBe(true);
    expect(s.stats().fullCabinets).toBe(1);
    s.sync(state);
    expect(s.takeDirty()).toBe(false);
    state.sales.fullCabinets = [];
    s.sync(state);
    expect(s.stats().fullCabinets).toBe(0);
  });

  it('washes out live cable that reaches the CO but no cabinet', () => {
    // 1st St runs eight blocks of 240 ft east of the CO: the last block starts beyond the reach.
    const state = newGame(7, { city: makeGridCity({ cols: 8 }) });
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    applyCommand(state, { type: 'layCable', segments: [0, 1, 2, 3, 4, 5, 6, 7], method: 'underground' });
    runDays(state, 150);
    const service = getService(state);
    expect(service.connectedSegments.size).toBe(8);
    expect(service.litSegments.has(7)).toBe(false);
    const s = scene();
    s.sync(state);
    expect(s.stats()).toMatchObject({ liveSpans: 8, dimSpans: 8 - service.litSegments.size });
    expect(s.stats().dimSpans).toBeGreaterThan(0);
  });

  it('toggles the rock texture and the cost overlay, drawing a frame only on a change', () => {
    const state = newGame(7, { city: makeGridCity({ rock: true }) });
    const s = scene();
    s.sync(state);
    s.takeDirty();
    s.setRockEmphasis(true);
    expect(s.takeDirty()).toBe(true);
    s.setRockEmphasis(true);
    expect(s.takeDirty()).toBe(false);
    expect(s.stats().rockEmphasis).toBe(true);

    expect(s.stats().costOverlay).toBeNull();
    s.setCostOverlay('aerial');
    expect(s.takeDirty()).toBe(true);
    s.setCostOverlay('aerial');
    expect(s.takeDirty()).toBe(false);
    s.setCostOverlay('cheapest');
    expect(s.takeDirty()).toBe(true);
    expect(s.stats().costOverlay).toBe('cheapest');
    s.setCostOverlay(null);
    expect(s.takeDirty()).toBe(true);
    expect(s.stats()).toMatchObject({ costOverlay: null });
    // A new city keeps the overlay choice.
    s.setCostOverlay('underground');
    s.sync(newGame(8, { city: makeGridCity({ cols: 4 }) }));
    expect(s.stats().costOverlay).toBe('underground');
  });

  it('skips an unchanged overlay spec without comparing it', () => {
    const state = litGame();
    const s = scene();
    s.sync(state);
    const spec: OverlaySpec = { snap: 1, path: { segments: [0], fresh: [0], method: 'underground', ok: true } };
    s.setOverlay(spec);
    expect(s.takeDirty()).toBe(true);
    s.setOverlay(spec);
    expect(s.takeDirty()).toBe(false);
    // An equal spec in a new object draws nothing new either.
    s.setOverlay({ ...spec });
    expect(s.takeDirty()).toBe(false);
    s.setOverlay({ ...spec, snap: 2 });
    expect(s.takeDirty()).toBe(true);
  });
});

describe('ParcelLayer', () => {
  // 36 x 4 cells: three chunks side by side.
  const city = makeGridCity({ cols: 6, blockW: 6 });
  const westHome = city.parcels.find((p) => p.x === 1 && p.y === 0)!.id;
  const eastHome = city.parcels.find((p) => p.x === 34 && p.y === 0)!.id;
  const eastMdu = (() => {
    const p = city.parcels.find((q) => q.x === 33 && q.y === 0)!;
    p.kind = 'mdu';
    p.units = 12;
    return p.id;
  })();

  it('redraws only the chunk whose subscriptions changed, and when an apartment building gains units', () => {
    const layer = new ParcelLayer(toyTown);
    layer.setCity(city);
    const passed = new Set<ParcelId>([westHome, eastHome, eastMdu]);
    expect(layer.sync(0, passed)).toBe(true);
    const base = layer.chunkRedraws;
    expect(layer.passedLots).toBe(3);
    expect(layer.subscribedLots).toBe(0);

    expect(layer.sync(0, passed, new Map([[westHome, 1]]))).toBe(true);
    expect(layer.chunkRedraws).toBe(base + 1);
    expect(layer.subscribedLots).toBe(1);
    expect(layer.passedLots).toBe(3);

    // Same subscriptions: nothing to redraw.
    expect(layer.sync(0, passed, new Map([[westHome, 1]]))).toBe(false);

    // An apartment building gaining a unit redraws its chunk alone.
    expect(layer.sync(0, passed, new Map([[westHome, 1], [eastMdu, 3]]))).toBe(true);
    expect(layer.chunkRedraws).toBe(base + 2);
    expect(layer.sync(0, passed, new Map([[westHome, 1], [eastMdu, 4]]))).toBe(true);
    expect(layer.chunkRedraws).toBe(base + 3);
    expect(layer.subscribedLots).toBe(2);

    // A subscriber whose street went dark this very day still draws (and counts) as one.
    expect(layer.sync(0, new Set([eastHome]), new Map([[westHome, 1]]))).toBe(true);
    expect(layer.subscribedLots).toBe(1);
    expect(layer.passedLots).toBe(2);
  });
});

describe('OverlayLayer', () => {
  it('redraws the cabinet coverage context only when the coverage changes', () => {
    const city = makeGridCity();
    const layer = new OverlayLayer(toyTown);
    const coverage = [{ cabinet: 1, lit: [0], reach: [0, 1, 9] }];
    expect(layer.draw(city, { coverage, snap: 1 })).toBe(true);
    const redraws = layer.contextRedraws;
    // The pointer moves: the hover marks redraw, the coverage doesn't.
    expect(layer.draw(city, { coverage, snap: 2, reach: [{ id: 3, t: 0.2, elsewhere: false, lit: false }] })).toBe(true);
    expect(layer.contextRedraws).toBe(redraws);
    expect(layer.draw(city, { coverage: [{ cabinet: 1, lit: [0, 1], reach: [0, 1, 9] }], snap: 2 })).toBe(true);
    expect(layer.contextRedraws).toBe(redraws + 1);
    expect(layer.draw(city, { snap: 2 })).toBe(true);
    expect(layer.contextRedraws).toBe(redraws + 2);
  });

  it('draws building tells for a planned route without throwing on unknown ids', () => {
    const city = makeGridCity();
    const layer = new OverlayLayer(toyTown);
    expect(layer.draw(city, { served: [0, 2, 999], wrongSide: [1, 999], serving: 0, ring: { node: 5, tone: 'remove' } })).toBe(true);
  });
});

describe('cost overlay bands', () => {
  // One 600 ft street, re-dressed per case: poles, rock.
  const base = makeGridCity({ blockW: 10 }).segments[0]!;
  const street = (hasPoles: boolean, rock: boolean) => ({ ...base, hasPoles, rock });

  it('tells aerial, soil bores and rock apart in every mode', () => {
    const { green, amber } = costOverlayThresholds();
    expect(green).toBeLessThan(amber);
    expect(overlayBand(street(true, false), 'aerial')).toBe('green');
    expect(overlayBand(street(true, true), 'aerial')).toBe('green');
    expect(overlayBand(street(false, false), 'aerial')).toBeNull();
    expect(overlayBand(street(true, false), 'underground')).toBe('amber');
    expect(overlayBand(street(true, true), 'underground')).toBe('red');
    // The cheaper buildable method: aerial where poled, else the bore.
    expect(overlayBand(street(true, true), 'cheapest')).toBe('green');
    expect(overlayBand(street(false, false), 'cheapest')).toBe('amber');
    expect(overlayBand(street(false, true), 'cheapest')).toBe('red');
  });
});

describe('storms and outages on the map', () => {
  /** litGame with its span live (and aerial), on a day well into the game. */
  function liveGame(): GameState {
    const state = litGame();
    runDays(state, 120);
    state.network.spans[0]!.method = 'aerial';
    state.network.version++;
    return state;
  }

  it('draws a span out of service broken, and pulses it without redrawing the cable', () => {
    const state = liveGame();
    const s = scene();
    s.sync(state);
    const { liveRedraws } = s.stats();
    expect(s.stats()).toMatchObject({ outageSpans: 0 });
    // Let the new cabinet's glow settle: an idle map draws nothing.
    const t0 = 1e9;
    s.animate(t0);
    s.takeDirty();
    s.animate(t0 + 100);
    expect(s.takeDirty()).toBe(false);

    state.network.spans[0]!.outage = { cause: 'storm', storm: null, startDay: state.day, daysLeft: 3, repairCost: 1_000 };
    state.network.version++;
    s.sync(state);
    expect(s.stats()).toMatchObject({ outageSpans: 1, liveSpans: 1, liveRedraws });
    s.takeDirty();
    // The pulse: frames move, the cable is not redrawn.
    s.animate(t0 + 200);
    expect(s.takeDirty()).toBe(true);
    s.animate(t0 + 300);
    expect(s.takeDirty()).toBe(true);
    expect(s.stats().liveRedraws).toBe(liveRedraws);

    // Repaired: no broken span, and nothing left to animate.
    state.network.spans[0]!.outage = null;
    state.network.version++;
    s.sync(state);
    expect(s.stats().outageSpans).toBe(0);
    s.takeDirty();
    s.animate(t0 + 400);
    expect(s.takeDirty()).toBe(false);
  });

  it('marks an underground rebuild, and redraws the cable once the span is underground', () => {
    const state = liveGame();
    const s = scene();
    s.sync(state);
    const { liveRedraws } = s.stats();
    const span = state.network.spans[0]!;
    span.conversion = { stage: 'permitting', stageDaysLeft: 5, constructDays: 2, cost: 0, orderedDay: state.day };
    state.network.version++;
    s.sync(state);
    expect(s.stats()).toMatchObject({ rebuildSpans: 1, liveRedraws });
    span.conversion.stage = 'constructing';
    state.network.version++;
    s.sync(state);
    expect(s.stats().rebuildSpans).toBe(1);
    // Done: the same span id, now underground.
    span.conversion = null;
    span.method = 'underground';
    state.network.version++;
    s.sync(state);
    expect(s.stats()).toMatchObject({ rebuildSpans: 0, liveSpans: 1, liveRedraws: liveRedraws + 1 });
  });

  it('shows the clouds of recent storms, fading, redrawn only on a new storm or a new day', () => {
    const state = liveGame();
    const s = scene();
    s.sync(state);
    expect(s.stats().stormsShown).toBe(0);
    s.takeDirty();
    const storm = (id: number, day: number) => ({ id, day, x: 4, y: 2, radius: 9, severity: 2, spans: [], repairCost: 0 });
    state.weather.storms = [storm(1, state.day - STORM_SHOW_DAYS), storm(2, state.day - 1)];
    state.weather.nextStormId = 3;
    s.sync(state);
    expect(s.takeDirty()).toBe(true);
    expect(s.stats().stormsShown).toBe(1);
    expect(stormsToShow(state).map((x) => x.id)).toEqual([2]);
    s.sync(state);
    expect(s.takeDirty()).toBe(false);

    // Another storm today.
    state.weather.storms.push(storm(3, state.day));
    state.weather.nextStormId = 4;
    s.sync(state);
    expect(s.takeDirty()).toBe(true);
    expect(s.stats().stormsShown).toBe(2);
    // A day later both fade a step: redrawn.
    state.day++;
    s.sync(state);
    expect(s.takeDirty()).toBe(true);
    // Long after, none.
    state.day += STORM_SHOW_DAYS;
    s.sync(state);
    expect(s.stats().stormsShown).toBe(0);
  });

  it('fades a storm from full strength the day it hits to nothing at STORM_SHOW_DAYS', () => {
    expect(stormFade(0)).toBe(1);
    expect(stormFade(STORM_SHOW_DAYS / 2)).toBeCloseTo(0.5);
    expect(stormFade(STORM_SHOW_DAYS)).toBe(0);
    expect(stormFade(STORM_SHOW_DAYS * 3)).toBe(0);
  });
});

describe('storm-exposure overlay (round 4b)', () => {
  /** A Graphics that remembers the colour of every stroke. */
  class StrokeRecorder extends Graphics {
    readonly colors: string[] = [];
    override stroke(...args: Parameters<Graphics['stroke']>): this {
      const style = args[0] as unknown;
      const color = typeof style === 'object' && style !== null && 'color' in style ? (style as { color: unknown }).color : style;
      if (typeof color === 'string') this.colors.push(color.toUpperCase());
      return super.stroke(...args);
    }
  }

  it('colors every street by its exposure band, light to dark, exposed drawn last', () => {
    const city = generateCity(2027);
    const bands = exposureBands(city);
    const exposure = cityExposure(city);
    expect(bands).toEqual(city.segments.map((s) => exposureBand(exposure[s.id]!)));
    const g = new StrokeRecorder();
    const counts = drawExposureOverlay(g, city, toyTown);
    for (const band of EXPOSURE_BANDS) expect(counts[band], band).toBe(bands.filter((b) => b === band).length);
    expect(counts.sheltered + counts.moderate + counts.exposed).toBe(city.segments.length);
    // A generated town has all three bands, one stroke each, in order.
    expect(counts.sheltered).toBeGreaterThan(0);
    expect(counts.exposed).toBeGreaterThan(0);
    expect(g.colors).toEqual(EXPOSURE_BANDS.map((band) => toyTown.exposureOverlay.band[band].toUpperCase()));
  });

  it('uses band colours that darken with exposure and read over the cream roads and the grass', () => {
    const { band } = toyTown.exposureOverlay;
    const lum = (c: string) => luminance(rgb(c));
    expect(lum(band.sheltered)).toBeGreaterThan(lum(band.moderate));
    expect(lum(band.moderate)).toBeGreaterThan(lum(band.exposed));
    for (const under of [toyTown.road.fill, toyTown.board.grass]) {
      for (const color of Object.values(band)) expect(washContrast(color, toyTown.exposureOverlay.alpha, under), `${color} on ${under}`).toBeGreaterThanOrEqual(1.3);
    }
    // Not the cost overlay's colours: the two overlays never read alike.
    for (const color of Object.values(band)) expect(Object.values(toyTown.cpp).map((c) => c.toUpperCase())).not.toContain(color.toUpperCase());
  });

  it('toggles on the scene, drawing a frame only on a change, and redraws for a new city', () => {
    const state = newGame(7, { city: makeGridCity() });
    const s = scene();
    s.sync(state);
    s.takeDirty();
    expect(s.stats().exposureOverlay).toBeNull();
    s.setExposureOverlay(true);
    expect(s.takeDirty()).toBe(true);
    s.setExposureOverlay(true);
    expect(s.takeDirty()).toBe(false);
    const counts = s.stats().exposureOverlay!;
    const bands = exposureBands(state.city);
    for (const band of EXPOSURE_BANDS) expect(counts[band]).toBe(bands.filter((b) => b === band).length);
    s.setExposureOverlay(false);
    expect(s.takeDirty()).toBe(true);
    expect(s.stats().exposureOverlay).toBeNull();
    // A new city keeps the choice and draws its own streets.
    s.setExposureOverlay(true);
    const other = newGame(8, { city: makeGridCity({ cols: 4 }) });
    s.sync(other);
    const drawn = s.stats().exposureOverlay!;
    expect(drawn.sheltered + drawn.moderate + drawn.exposed).toBe(other.city.segments.length);
    // The cost overlay is a separate layer: the scene shows whatever it is told (MapControls keeps them apart).
    s.setCostOverlay('cheapest');
    expect(s.stats()).toMatchObject({ costOverlay: 'cheapest' });
  });
});
