// The UI must change the game only through commands. Drive every tool over a
// frozen mid-game state: any direct write to GameState throws in strict mode.

import { describe, expect, it } from 'vitest';
import { applyCommand, newGame, runDays } from '../sim/game';
import { Rng } from '../sim/rng';
import { shortestPath } from '../sim/streets';
import type { Command, CommandResult, GameState } from '../sim/types';
import { townBounds } from '../render/cityLayer';
import { placeTrees } from '../render/decor';
import { lotRect, parcelGrid, streetLattice } from '../render/geometry';
import { toyTown } from '../render/theme';
import { ToolController } from './tools';
import type { ToolId } from './tools';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** A generated town with spans in every build stage, cabinets, and lit homes. */
function midGame(): GameState {
  const state = newGame(31);
  const { city } = state;
  const co = city.coNode;
  const far = (k: number) => city.nodes.reduce((best, n) => (Math.abs(n.x - city.nodes[co]!.x) + Math.abs(n.y - city.nodes[co]!.y) === k ? n.id : best), co);
  applyCommand(state, { type: 'placeCabinet', node: co });
  applyCommand(state, { type: 'layCable', segments: shortestPath(city, co, far(10)) ?? [], method: 'underground' });
  runDays(state, 120);
  applyCommand(state, { type: 'layCable', segments: shortestPath(city, co, far(20)) ?? [], method: 'underground' });
  runDays(state, 30);
  applyCommand(state, { type: 'layCable', segments: shortestPath(city, co, far(6)) ?? [], method: 'aerial' });
  return state;
}

describe('UI purity', () => {
  it('reads a frozen game through every tool without writing to it', () => {
    const state = midGame();
    const stages = new Set(state.network.spans.map((s) => s.stage));
    expect(stages.size).toBeGreaterThanOrEqual(2);
    deepFreeze(state);

    const commands: Command[] = [];
    let flip = false;
    // Records what the tools ask for and answers alternately yes and no.
    const dispatch = (cmd: Command): CommandResult => {
      commands.push(cmd);
      flip = !flip;
      return flip ? { ok: true, cost: 100 } : { ok: false, reason: 'Refused by the test' };
    };

    const rng = new Rng(5);
    const tools = new ToolController();
    const { width, height } = state.city;
    for (const tool of ['inspect', 'aerial', 'underground', 'cabinet', 'remove'] as ToolId[]) {
      tools.setTool(tool);
      for (let i = 0; i < 120; i++) {
        const x = rng.next() * (width + 2) - 1;
        const y = rng.next() * (height + 2) - 1;
        tools.hoverAt(x, y);
        const view = tools.view(state);
        expect(view).toBeDefined();
        if (i % 6 === 0) {
          const outcome = tools.click(state, dispatch, x, y);
          if (outcome) expect(outcome.message.length).toBeGreaterThan(0);
        }
      }
      tools.clearHover();
      tools.view(state);
    }

    expect(commands.length).toBeGreaterThan(5);
    for (const cmd of commands) expect(['layCable', 'placeCabinet', 'removeSpan']).toContain(cmd.type);
  });

  it('draws map geometry from a frozen city', () => {
    const state = deepFreeze(newGame(32));
    const lattice = streetLattice(state.city);
    for (const p of state.city.parcels.slice(0, 200)) lotRect(lattice, p, toyTown);
    expect(parcelGrid(state.city).length).toBe(state.city.width * state.city.height);
    expect(placeTrees(state.city, toyTown).length).toBeGreaterThan(0);
    expect(townBounds(state.city, toyTown).w).toBeGreaterThan(0);
  });
});
