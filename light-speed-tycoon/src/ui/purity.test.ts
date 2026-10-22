// The UI must change the game only through commands. Drive every tool over a
// frozen mid-game state: any direct write to GameState throws in strict mode.

import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import type { Application } from 'pixi.js';
import { applyCommand, newGame, runDays } from '../sim/game';
import { getService } from '../sim/network';
import { Rng } from '../sim/rng';
import { shortestPath } from '../sim/streets';
import type { Command, CommandResult, GameState } from '../sim/types';
import { townBounds } from '../render/cityLayer';
import { placeTrees } from '../render/decor';
import { dropPoint, lotRect, parcelGrid, streetLattice } from '../render/geometry';
import { Scene } from '../render/scene';
import { toyTown } from '../render/theme';
import { spanPanelModel } from './spanPanel';
import { ToolController } from './tools';
import type { ToolId } from './tools';

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * A generated town with spans in every build stage, cabinets (one with extra
 * splitters, one full), remembered make-ready, subscribers and lit homes; and
 * (round 4) a live span out of service after a storm still on the map, and an
 * aerial span being rebuilt underground.
 */
function midGame(): GameState {
  const state = newGame(31);
  const { city } = state;
  const co = city.coNode;
  const far = (k: number) => city.nodes.reduce((best, n) => (Math.abs(n.x - city.nodes[co]!.x) + Math.abs(n.y - city.nodes[co]!.y) === k ? n.id : best), co);
  applyCommand(state, { type: 'placeCabinet', node: co });
  applyCommand(state, { type: 'layCable', segments: shortestPath(city, co, far(10)) ?? [], method: 'underground' });
  // Round 4c/4d: a lit street switches over years (customers.ts); a campaign
  // the day the first streets light signs the first subscribers in time.
  let day = 0;
  for (; day < 120 && getService(state).passings === 0; day++) runDays(state, 1);
  applyCommand(state, { type: 'runCampaign', cabinet: state.network.cabinets[0]!.id });
  runDays(state, 120 - day);
  applyCommand(state, { type: 'addSplitter', cabinet: state.network.cabinets[0]!.id });
  applyCommand(state, { type: 'placeCabinet', node: far(10) });
  applyCommand(state, { type: 'addOltCard' });
  applyCommand(state, { type: 'layCable', segments: shortestPath(city, co, far(20)) ?? [], method: 'underground' });
  runDays(state, 30);
  applyCommand(state, { type: 'layCable', segments: shortestPath(city, co, far(6)) ?? [], method: 'aerial' });
  // Cancelled while permitting: its make-ready draw is remembered.
  const aerial = state.network.spans.find((s) => s.method === 'aerial');
  if (aerial) applyCommand(state, { type: 'removeSpan', span: aerial.id });
  applyCommand(state, { type: 'layCable', segments: shortestPath(city, co, far(6)) ?? [], method: 'aerial' });
  state.sales.fullCabinets = [state.network.cabinets[0]!.id];
  // Round 4: the first live span is out after a storm two days ago; the last one is aerial and being rebuilt.
  const live = state.network.spans.filter((s) => s.stage === 'live');
  const out = live[0]!;
  const rebuilt = live[live.length - 1]!;
  const centre = city.nodes[city.segments[out.segment]!.a]!;
  state.weather.storms = [{ id: 1, day: state.day - 2, x: centre.x, y: centre.y, radius: 9, severity: 2, spans: [out.id], repairCost: 1_500 }];
  state.weather.nextStormId = 2;
  out.outage = { cause: 'storm', storm: 1, startDay: state.day - 2, daysLeft: 3, repairCost: 1_500 };
  rebuilt.method = 'aerial';
  rebuilt.conversion = { stage: 'constructing', stageDaysLeft: 4, constructDays: 6, cost: 12_000, orderedDay: state.day - 20 };
  state.network.version++;
  return state;
}

/** Points on the middle of every live span, so tools hover and click them too. */
function spanPoints(state: GameState): { x: number; y: number }[] {
  return state.network.spans
    .filter((s) => s.stage === 'live')
    .map((s) => {
      const seg = state.city.segments[s.segment]!;
      const a = state.city.nodes[seg.a]!;
      const b = state.city.nodes[seg.b]!;
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    });
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
    const { width, height, nodes } = state.city;
    const randomPoint = () => ({ x: rng.next() * (width + 2) - 1, y: rng.next() * (height + 2) - 1 });
    // Every corner that has a cabinet, so the cabinet and remove tools get hovered and clicked on them too;
    // and every live span (the outage and the rebuild among them).
    const cabinetPoints = state.network.cabinets.map((c) => nodes[c.node]!);
    const livePoints = spanPoints(state);
    for (const tool of ['inspect', 'aerial', 'underground', 'cabinet', 'remove'] as ToolId[]) {
      tools.setTool(tool);
      for (let i = 0; i < 120; i++) {
        const { x, y } =
          i % 10 === 0 && cabinetPoints.length > 0
            ? cabinetPoints[i % cabinetPoints.length]!
            : i % 10 === 5
              ? livePoints[i % livePoints.length]!
              : randomPoint();
        tools.touch = i % 4 === 0;
        tools.hoverAt(x, y);
        const view = tools.view(state);
        expect(view).toBeDefined();
        if (i % 6 === 0) {
          const outcome = tools.touch ? tools.tap(state, dispatch, x, y) : tools.click(state, dispatch, x, y);
          if (outcome) expect(outcome.message.length > 0 || outcome.open !== undefined).toBe(true);
        }
      }
      // Drag paths: start on a corner, wander (including back over the way), release or cancel.
      for (let d = 0; d < 12; d++) {
        const start = nodes[Math.floor(rng.next() * nodes.length)]!;
        const began = tools.dragStart(state, start.x + 0.1, start.y - 0.1, 0.5);
        expect(began).toBe(tool === 'aerial' || tool === 'underground');
        let last = { x: start.x, y: start.y };
        for (let m = 0; m < 6; m++) {
          last = m === 4 ? { x: start.x, y: start.y } : randomPoint();
          tools.dragMove(state, last.x, last.y);
          expect(tools.view(state)).toBeDefined();
        }
        if (d % 3 === 0) tools.dragCancel();
        const outcome = tools.dragEnd(state, dispatch, last.x, last.y);
        if (outcome) expect(outcome.message.length).toBeGreaterThan(0);
      }
      tools.cancel();
      tools.clearHover();
      tools.view(state);
    }

    // The span panel's model over every live span, the out one and the one being rebuilt included.
    const opened = new Set<number>();
    tools.setTool('inspect');
    for (const p of livePoints) {
      tools.hoverAt(p.x, p.y);
      const card = tools.view(state).card;
      expect(card).not.toBeNull();
      const outcome = tools.click(state, dispatch, p.x, p.y);
      if (outcome?.open === 'span') {
        opened.add(outcome.span!);
        expect(spanPanelModel(state, outcome.span!)).not.toBeNull();
      }
    }
    const out = state.network.spans.find((s) => s.outage !== null)!;
    const rebuilt = state.network.spans.find((s) => s.conversion !== null)!;
    expect(opened.has(out.id) || opened.has(rebuilt.id)).toBe(true);
    for (const span of state.network.spans) spanPanelModel(state, span.id);
    expect(spanPanelModel(state, out.id)?.status[0]?.tone).toBe('danger');
    expect(spanPanelModel(state, rebuilt.id)?.rebuild?.ok).toBe(false);

    expect(commands.length).toBeGreaterThan(5);
    const types = new Set(commands.map((cmd) => cmd.type));
    for (const type of types) expect(['layCable', 'placeCabinet', 'removeSpan', 'addSplitter', 'removeCabinet']).toContain(type);
    // The new tools were exercised.
    expect(types).toContain('addSplitter');
    expect(types).toContain('removeCabinet');
  });

  it('draws the map from a frozen game without writing to it', () => {
    const state = midGame();
    deepFreeze(state);
    const scene = new Scene({ stage: new Container() } as unknown as Application, toyTown);
    scene.sync(state);
    scene.setRockEmphasis(true);
    scene.setCostOverlay('underground');
    scene.setCostOverlay('cheapest');
    const tools = new ToolController();
    const rng = new Rng(9);
    for (const tool of ['inspect', 'aerial', 'cabinet', 'remove'] as ToolId[]) {
      tools.setTool(tool);
      for (let i = 0; i < 30; i++) {
        tools.hoverAt(rng.next() * state.city.width, rng.next() * state.city.height);
        scene.setOverlay(tools.view(state).overlay);
      }
    }
    scene.sync(state);
    scene.animate(1e9);
    scene.animate(1e9 + 100);
    expect(scene.stats().passedLots).toBeGreaterThan(0);
    expect(scene.stats().subscribedLots).toBeGreaterThan(0);
    expect(scene.stats()).toMatchObject({ outageSpans: 1, rebuildSpans: 1, stormsShown: 1 });
  });

  it('draws map geometry from a frozen city', () => {
    const state = deepFreeze(newGame(32));
    const lattice = streetLattice(state.city);
    for (const p of state.city.parcels.slice(0, 200)) {
      lotRect(lattice, p, toyTown);
      dropPoint(state.city, lattice, p, toyTown);
    }
    expect(parcelGrid(state.city).length).toBe(state.city.width * state.city.height);
    expect(placeTrees(state.city, toyTown).length).toBeGreaterThan(0);
    expect(townBounds(state.city, toyTown).w).toBeGreaterThan(0);
  });
});
