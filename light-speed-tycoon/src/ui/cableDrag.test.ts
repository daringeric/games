import { describe, expect, it } from 'vitest';
import { newGame } from '../sim/game';
import { segmentBetween } from '../sim/streets';
import { TUNING_SEEDS } from '../sim/tuning/harness';
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

describe('CableDrag on a generated town', () => {
  /** Drag the pointer in a straight line from one corner to another in `steps` moves. */
  function dragAlong(state: GameState, drag: CableDrag, from: number, to: number, steps = 40): void {
    const a = state.city.nodes[from]!;
    const b = state.city.nodes[to]!;
    for (let i = 1; i <= steps; i++) drag.moveTo(state.city, a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
  }

  it('keeps to the street being dragged when a corner on a parallel street is nearer', () => {
    // Seed 1: Water St runs 420 ft from node 104 to node 105; a Hawthorn Ave corner
    // two cells north is nearer to the pointer than either end at a third of the way.
    const state = newGame(1);
    const segment = segmentBetween(state.city, 104, 105)!;
    expect(state.city.segments[segment]!.name).toBe('Water St');
    for (const method of ['aerial', 'underground'] as const) {
      const drag = new CableDrag(method, 104);
      const a = state.city.nodes[104]!;
      const b = state.city.nodes[105]!;
      for (let i = 1; i <= 40; i++) {
        drag.moveTo(state.city, a.x + ((b.x - a.x) * i) / 40, a.y + ((b.y - a.y) * i) / 40);
        // Never a corner off Water St.
        expect([[104], [104, 105]]).toContainEqual([...drag.corners]);
      }
      expect(drag.route(state)).toEqual([segment]);
    }
  });

  it.each(TUNING_SEEDS)('draws exactly the dragged street for every single-street drag, both ways, on town %i', (seed) => {
    const state = newGame(seed);
    const wrong: string[] = [];
    for (const seg of state.city.segments) {
      for (const [from, to] of [[seg.a, seg.b], [seg.b, seg.a]] as const) {
        const drag = new CableDrag('underground', from);
        dragAlong(state, drag, from, to);
        const route = drag.route(state);
        if (route?.length !== 1 || route[0] !== seg.id) wrong.push(`${from}->${to}: ${JSON.stringify(route)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('follows a street across several corners in one drag', () => {
    // Seed 1: Main St west from the CO (143) through 142 to 141, all poled.
    const state = newGame(1);
    expect(state.city.coNode).toBe(143);
    const first = segmentBetween(state.city, 143, 142)!;
    const second = segmentBetween(state.city, 142, 141)!;
    const drag = new CableDrag('aerial', 143);
    dragAlong(state, drag, 143, 142);
    dragAlong(state, drag, 142, 141);
    expect(drag.corners).toEqual([143, 142, 141]);
    expect(drag.route(state)).toEqual([first, second]);
  });

  it('still jumps to a corner the pointer cuts across to, and routes the streets between', () => {
    const state = game();
    const drag = new CableDrag('underground', 0);
    // Diagonally across the first block to the corner at (4, 2).
    for (let i = 1; i <= 20; i++) drag.moveTo(state.city, (4 * i) / 20, (2 * i) / 20);
    expect(drag.last).toBe(5);
    expect(drag.route(state)).toHaveLength(2);
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
