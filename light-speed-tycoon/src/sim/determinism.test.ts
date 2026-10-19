import { describe, expect, it } from 'vitest';
import { applyCommand, newGame, runDays } from './game';
import { getService } from './network';
import { deserialize, hashState, serialize } from './save';
import { shortestPath } from './streets';
import { makeGridCity } from './testing/fixtures';
import type { Command, CommandResult, GameState } from './types';

// Commands interleaved with day counts. Default grid: horizontal segments 0..8,
// vertical 9..16, CO at node 0. Every aerial order draws make-ready (with its
// long-delay chance) from the events stream, so later draws depend on earlier ones.
const SCRIPT: ReadonlyArray<Command | number> = [
  { type: 'placeCabinet', node: 0 },
  { type: 'layCable', segments: [0, 9], method: 'aerial' },
  { type: 'layCable', segments: [1], method: 'underground' },
  20,
  { type: 'layCable', segments: [2, 12], method: 'aerial' },
  45,
  { type: 'placeCabinet', node: 5 },
  { type: 'layCable', segments: [3, 4, 5], method: 'aerial' },
  { type: 'removeSpan', span: 4 },
  60,
  { type: 'layCable', segments: [10, 13], method: 'aerial' },
  { type: 'layCable', segments: [6, 7], method: 'underground' },
  90,
  // Rejected; must not disturb anything.
  { type: 'layCable', segments: [99], method: 'aerial' },
  { type: 'layCable', segments: [8, 16], method: 'aerial' },
  120,
];

interface Session {
  state: GameState;
  results: CommandResult[];
}

function play(state: GameState, steps: ReadonlyArray<Command | number> = SCRIPT): Session {
  const results: CommandResult[] = [];
  for (const step of steps) {
    if (typeof step === 'number') runDays(state, step);
    else results.push(applyCommand(state, step));
  }
  return { state, results };
}

function gridSession(seed: number): Session {
  return play(newGame(seed, { city: makeGridCity() }));
}

/** When each span was ordered and went live: the visible footprint of the RNG. */
function timeline(state: GameState): Array<[number, number, number | null]> {
  return state.network.spans.map((s) => [s.segment, s.orderedDay, s.liveDay]);
}

describe('determinism', () => {
  it('replays a scripted session identically from the same seed', () => {
    const a = gridSession(2027);
    const b = gridSession(2027);
    expect(a.state.day).toBe(335);
    expect(a.results).toEqual(b.results);
    expect(a.state.finance.reports).toHaveLength(11);
    expect(a.state.finance.reports).toEqual(b.state.finance.reports);
    expect(hashState(a.state)).toBe(hashState(b.state));
    expect(serialize(a.state)).toBe(serialize(b.state));
  });

  it('exercises the make-ready RNG', () => {
    const { state, results } = gridSession(2027);
    expect(results.filter((r) => r.ok)).toHaveLength(results.length - 1);
    expect(state.rng.events).not.toBe(newGame(2027, { city: makeGridCity() }).rng.events);
    // Aerial orders placed on different days spent different times in make-ready.
    const makeReady = new Set(
      state.network.spans
        .filter((s) => s.method === 'aerial' && s.liveDay !== null)
        .map((s) => (s.liveDay as number) - s.orderedDay - s.constructDays),
    );
    expect(makeReady.size).toBeGreaterThan(1);
  });

  it('diverges for a different seed', () => {
    const a = gridSession(2027);
    const b = gridSession(2028);
    expect(hashState(a.state)).not.toBe(hashState(b.state));
    expect(timeline(a.state)).not.toEqual(timeline(b.state));
  });

  it('replays identically through a save and load mid-session', () => {
    const straight = gridSession(7);
    const half = SCRIPT.indexOf(60);
    const first = play(newGame(7, { city: makeGridCity() }), SCRIPT.slice(0, half));
    const second = play(deserialize(serialize(first.state)), SCRIPT.slice(half));
    expect([...first.results, ...second.results]).toEqual(straight.results);
    expect(hashState(second.state)).toBe(hashState(straight.state));
  });

  it('keeps games independent when stepped side by side', () => {
    const solo = gridSession(11);
    const a = newGame(11, { city: makeGridCity() });
    const b = newGame(12, { city: makeGridCity() });
    // Alternate steps between two games sharing one City object.
    b.city = a.city;
    for (const step of SCRIPT) {
      play(a, [step]);
      play(b, [step]);
      getService(b);
    }
    expect(hashState(a)).toBe(hashState(solo.state));
  });

  it('replays a session on a generated city', () => {
    const generatedSession = (seed: number): Session => {
      const state = newGame(seed);
      const { city } = state;
      const far = city.coNode === city.nodes.length - 1 ? 0 : city.nodes.length - 1;
      const route = shortestPath(city, city.coNode, far) ?? [];
      const poled = city.segments.filter((s) => s.hasPoles && !route.includes(s.id)).map((s) => s.id);
      return play(state, [
        { type: 'placeCabinet', node: city.coNode },
        { type: 'layCable', segments: route, method: 'underground' },
        30,
        { type: 'layCable', segments: poled.slice(0, 4), method: 'aerial' },
        60,
        { type: 'layCable', segments: poled.slice(4, 8), method: 'aerial' },
        120,
      ]);
    };

    const a = generatedSession(99);
    const b = generatedSession(99);
    expect(a.results[0]?.ok).toBe(true);
    expect(a.results[1]?.ok).toBe(true);
    expect(a.results).toEqual(b.results);
    expect(hashState(a.state)).toBe(hashState(b.state));
    // The route from the CO is lit by now, and the generated town survives a save.
    expect(getService(a.state).litSegments.size).toBeGreaterThan(0);
    expect(deserialize(serialize(a.state))).toEqual(a.state);
    expect(hashState(generatedSession(100).state)).not.toBe(hashState(a.state));
  });
});
