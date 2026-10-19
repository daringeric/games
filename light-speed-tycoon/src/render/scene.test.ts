// The map scene against real Pixi objects (no renderer: nothing is drawn to a
// screen, but every layer builds its geometry). Checks what the map shows, not
// how it looks.

import { describe, expect, it } from 'vitest';
import { Container, Graphics, Text } from 'pixi.js';
import type { Application } from 'pixi.js';
import { applyCommand, newGame, runDays } from '../sim/game';
import { getService } from '../sim/network';
import { makeGridCity } from '../sim/testing/fixtures';
import type { GameState } from '../sim/types';
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
    // The ground layer (first in the world) holds the board, roads and trees again.
    expect((s.world.children[0] as Container).children).toHaveLength(3);
  });
});
