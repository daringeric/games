import { describe, expect, it } from 'vitest';
import { newGame } from '../sim/game';
import { makeGridCity } from '../sim/testing/fixtures';
import type { GameState } from '../sim/types';
import { CableDrag, routeThrough } from './cableDrag';

// Grid town: nodes (i, j) at (4i, 2j), id j * 4 + i; the CO is node 0 at (0, 0).
// Horizontal segment (i, j) has id j * 3 + i; vertical (i, j) has id 9 + j * 4 + i.
function game(opts: Parameters<typeof makeGridCity>[0] = {}): GameState {
  return newGame(7, { city: makeGridCity(opts) });
}

describe('CableDrag', () => {
  it('appends the nearest corner only when it changes', () => {
    const state = game();
    const drag = new CableDrag('underground', 0);
    expect(drag.moveTo(state.city, 0.6, 0.3)).toBe(false);
    expect(drag.corners).toEqual([0]);
    expect(drag.moveTo(state.city, 3.7, 0.2)).toBe(true);
    expect(drag.moveTo(state.city, 4.2, -0.1)).toBe(false);
    expect(drag.moveTo(state.city, 7.9, 0.1)).toBe(true);
    expect(drag.corners).toEqual([0, 1, 2]);
    expect(drag.last).toBe(2);
    expect(drag.route(state)).toEqual([0, 1]);
  });

  it('backtracks when the pointer returns to the previous-but-one corner', () => {
    const state = game();
    const drag = new CableDrag('underground', 0);
    drag.visit(1);
    drag.visit(2);
    expect(drag.visit(1)).toBe(true);
    expect(drag.corners).toEqual([0, 1]);
    expect(drag.route(state)).toEqual([0]);
    expect(drag.visit(0)).toBe(true);
    expect(drag.corners).toEqual([0]);
    expect(drag.route(state)).toEqual([]);
    expect(drag.start).toBe(0);
  });

  it('drops segments the drag passes over twice', () => {
    const state = game();
    const drag = new CableDrag('underground', 0);
    // Around the first block and on along 1st St again.
    for (const node of [1, 5, 4, 0, 1, 2]) drag.visit(node);
    expect(drag.route(state)).toEqual([0, 10, 3, 9, 1]);
  });
});

describe('routeThrough', () => {
  it('concatenates the legs between corners and fills in skipped corners', () => {
    const state = game();
    // 0 -> 2 jumps a corner: the leg routes through node 1.
    expect(routeThrough(state, [0, 2, 6], 'underground')).toEqual([0, 1, 11]);
  });

  it('cancels an exact reversal', () => {
    const state = game();
    // Out to node 2 and back to node 1 retraces segment 1.
    expect(routeThrough(state, [0, 2, 1], 'underground')).toEqual([0]);
    expect(routeThrough(state, [0, 1, 0], 'underground')).toEqual([]);
  });

  it('is null when any leg is unreachable', () => {
    const state = game();
    const island = state.city.nodes.length;
    state.city.nodes.push({ id: island, x: 20, y: 20 });
    expect(routeThrough(state, [0, 1, island], 'underground')).toBeNull();
  });

  it('is empty for fewer than two distinct corners', () => {
    const state = game();
    expect(routeThrough(state, [], 'aerial')).toEqual([]);
    expect(routeThrough(state, [3], 'aerial')).toEqual([]);
    expect(routeThrough(state, [3, 3], 'aerial')).toEqual([]);
  });

  it('keeps aerial legs on poled streets when the detour is short', () => {
    // 0 -> 5 is 360 ft either way; the plain shortest route takes 2nd St (segment 3), which has no poles here.
    const state = game();
    state.city.segments[3] = { ...state.city.segments[3]!, hasPoles: false };
    expect(routeThrough(state, [0, 5], 'aerial')).toEqual([0, 10]);
    expect(routeThrough(state, [0, 5], 'underground')).toEqual([9, 3]);
    const drag = new CableDrag('aerial', 0);
    drag.visit(5);
    expect(drag.route(state)).toEqual([0, 10]);
  });
});
