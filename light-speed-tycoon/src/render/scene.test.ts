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
import { costOverlayThresholds, overlayBand } from './cityLayer';
import { OverlayLayer } from './overlay';
import type { OverlaySpec } from './overlay';
import { ParcelLayer } from './parcelLayer';
import { Scene } from './scene';
import { toyTown } from './theme';

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
    expect(layer.draw(city, { coverage, snap: 2, reach: [{ id: 3, t: 0.2, elsewhere: false }] })).toBe(true);
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
