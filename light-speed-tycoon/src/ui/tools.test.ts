import { describe, expect, it } from 'vitest';
import { applyCommand, newGame, runDays } from '../sim/game';
import { makeGridCity } from '../sim/testing/fixtures';
import type { GameState } from '../sim/types';
import { ToolController, cornerLabel } from './tools';

// Grid town: nodes (i, j) at (4i, 2j), id j * 4 + i; the CO is node 0 at (0, 0).
// Horizontal segment (i, j) has id j * 3 + i; vertical (i, j) has id 9 + j * 4 + i.
function game(opts: Parameters<typeof makeGridCity>[0] = {}): GameState {
  return newGame(7, { city: makeGridCity(opts) });
}

function dispatcher(state: GameState) {
  return (cmd: Parameters<typeof applyCommand>[1]) => applyCommand(state, cmd);
}

describe('cable tools', () => {
  it('starts a run on click, quotes the hovered route, and orders it on the next click', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('underground');

    tools.hoverAt(0.1, 0.2);
    expect(tools.view(state).overlay.snap).toBe(0);
    expect(tools.click(state, dispatcher(state), 0.1, 0.2)).toBeNull();
    expect(tools.drawing).toBe(true);

    // Hover node (2, 0) at (8, 0): two segments east along 1st St.
    tools.hoverAt(7.8, 0.3);
    const view = tools.view(state);
    expect(view.overlay.path).toEqual({ segments: [0, 1], fresh: [0, 1], method: 'underground', ok: true });
    expect(view.card?.title).toBe('Underground cable');
    expect(view.card?.rows.find((r) => r.label === 'Cost')?.value).toBe('$14,400');
    expect(view.card?.blockers).toEqual([]);

    const cash = state.finance.cash;
    const outcome = tools.click(state, dispatcher(state), 7.8, 0.3);
    expect(outcome?.ok).toBe(true);
    expect(outcome?.message).toContain('2 spans');
    expect(state.network.spans.map((s) => s.segment)).toEqual([0, 1]);
    expect(state.finance.cash).toBe(cash - 14_400);
    // The run continues from where it ended.
    expect(tools.view(state).overlay.origin).toBe(2);
  });

  it('shows blockers for aerial runs without poles and refuses the order', () => {
    const state = game({ hasPoles: false });
    const tools = new ToolController();
    tools.setTool('aerial');
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(4, 0);
    const view = tools.view(state);
    expect(view.overlay.path?.ok).toBe(false);
    expect(view.card?.blockers.join(' ')).toMatch(/No poles/);
    const outcome = tools.click(state, dispatcher(state), 4, 0);
    expect(outcome?.ok).toBe(false);
    expect(state.network.spans).toEqual([]);
  });

  it('routes aerial runs along poles when the shortest route crosses a street without them', () => {
    // 0 -> 5 is 360 ft either way; the plain shortest route takes 2nd St (H(0,1)=3), which has no poles here.
    const state = game();
    state.city.segments[3] = { ...state.city.segments[3]!, hasPoles: false };
    const tools = new ToolController();
    tools.setTool('aerial');
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(4.1, 2.1);
    const view = tools.view(state);
    expect(view.overlay.path).toEqual({ segments: [0, 10], fresh: [0, 10], method: 'aerial', ok: true });
    expect(view.card?.blockers).toEqual([]);
    expect(tools.click(state, dispatcher(state), 4.1, 2.1)?.ok).toBe(true);
    expect(state.network.spans.map((s) => s.segment)).toEqual([0, 10]);

    // Underground keeps the plain shortest route.
    tools.setTool('underground');
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(4.1, 2.1);
    expect(tools.view(state).overlay.path?.segments).toEqual([9, 3]);
  });

  it('ends the run on cancel', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('aerial');
    tools.click(state, dispatcher(state), 0, 0);
    expect(tools.cancel()).toBe(true);
    expect(tools.drawing).toBe(false);
    expect(tools.cancel()).toBe(false);
  });

  it('switching tools drops a run in progress', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('underground');
    tools.click(state, dispatcher(state), 0, 0);
    tools.setTool('aerial');
    expect(tools.drawing).toBe(false);
  });
});

describe('cabinet tool', () => {
  it('quotes and places a cabinet at the nearest corner', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.3, 1.8);
    const view = tools.view(state);
    expect(view.overlay.cabinet).toEqual({ node: 5, ok: true });
    expect(view.card?.rows.find((r) => r.label === 'Cost')?.value).toBe('$16,200');
    const outcome = tools.click(state, dispatcher(state), 4.3, 1.8);
    expect(outcome).toEqual({ ok: true, message: `Cabinet ordered at ${cornerLabel(state, 5)} for $16,200` });
    expect(state.network.cabinets.map((c) => c.node)).toEqual([5]);
    // A second one on the same corner is refused with the sim's reason.
    expect(tools.click(state, dispatcher(state), 4.3, 1.8)?.ok).toBe(false);
  });
});

describe('remove tool', () => {
  it('highlights a cabled street and refunds it while permitting', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    const cash = state.finance.cash;
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(2, 0.2);
    const view = tools.view(state);
    expect(view.overlay.segment).toEqual({ id: 0, tone: 'remove' });
    expect(view.card?.rows.find((r) => r.label === 'Refund')?.value).toBe('$7,200');
    const outcome = tools.click(state, dispatcher(state), 2, 0.2);
    expect(outcome?.message).toMatch(/\$7,200 refunded/);
    expect(state.network.spans).toEqual([]);
    expect(state.finance.cash).toBe(cash + 7_200);
  });

  it('says there is no refund once crews have started', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    runDays(state, 60);
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(2, 0);
    expect(tools.view(state).card?.rows.find((r) => r.label === 'Refund')?.value).toBe('No refund');
    expect(tools.click(state, dispatcher(state), 2, 0)?.message).toMatch(/no refund/);
  });

  it('ignores streets without cable', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(2, 0);
    expect(tools.view(state)).toEqual({ overlay: {}, card: null });
    expect(tools.click(state, dispatcher(state), 2, 0)).toBeNull();
  });
});

describe('inspect tool', () => {
  it('describes the CO, streets and homes under the cursor', () => {
    const state = game();
    const tools = new ToolController();

    tools.hoverAt(0.1, 0.1);
    expect(tools.view(state).card?.title).toBe('Central office');

    tools.hoverAt(2, 0.1);
    const street = tools.view(state);
    expect(street.card?.title).toBe('1st St');
    expect(street.card?.rows.find((r) => r.label === 'Cable')?.value).toBe('None yet');
    expect(street.overlay.segment).toEqual({ id: 0, tone: 'inspect' });

    tools.hoverAt(1.5, 0.6);
    const home = tools.view(state);
    expect(home.card?.title).toBe('Home');
    expect(home.card?.rows.find((r) => r.label === 'Fiber')?.value).toBe('Unserved');
  });

  it('marks homes passed once the network lights their street', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    runDays(state, 120);
    const tools = new ToolController();
    tools.hoverAt(1.5, 0.6);
    expect(tools.view(state).card?.rows.find((r) => r.label === 'Fiber')?.value).toBe('Passed, ready for service');
    tools.hoverAt(0.1, 0.1);
    expect(tools.view(state).card?.rows.find((r) => r.label === 'Cabinet here')?.value).toMatch(/Active/);
  });

  it('memoizes the view until something it reads changes', () => {
    const state = game();
    const tools = new ToolController();
    tools.hoverAt(2, 0.1);
    const first = tools.view(state);
    expect(tools.view(state)).toBe(first);
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    expect(tools.view(state)).not.toBe(first);
  });

  it('recomputes the view when only the day changes', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    const tools = new ToolController();
    tools.hoverAt(2, 0.1);
    const cable = () => tools.view(state).card?.rows.find((r) => r.label === 'Cable')?.value;
    const before = cable();
    expect(before).toMatch(/permitting, \d+ days left/);
    const version = state.network.version;
    const cash = state.finance.cash;
    runDays(state, 3);
    // Still permitting: nothing but the day moved.
    expect(state.network.version).toBe(version);
    expect(state.finance.cash).toBe(cash);
    expect(cable()).not.toBe(before);
  });

  it('recomputes the view when only the network changes', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    runDays(state, 120);
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(2, 0.1);
    expect(tools.view(state).card?.title).toBe('Remove cable on 1st St');
    // Removing live cable refunds nothing, so cash and day stay put.
    const cash = state.finance.cash;
    expect(tools.click(state, dispatcher(state), 2, 0.1)?.ok).toBe(true);
    expect(state.finance.cash).toBe(cash);
    tools.hoverAt(2, 0.1);
    expect(tools.view(state).card).toBeNull();
  });

  it('recomputes the view when only cash changes', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.1, 2.1);
    expect(tools.view(state).card?.blockers).toEqual([]);
    state.finance.cash = 100;
    expect(tools.view(state).card?.blockers).toEqual(['Not enough cash: need $16,200, have $100']);
  });
});

describe('view cache across games', () => {
  it('recomputes for a new game that matches the old one on day, version and cash', () => {
    // A fresh town on a different street plan: same day 0, version 0 and start cash.
    const first = game();
    const second = newGame(8, { city: makeGridCity({ hasPoles: false }) });
    const tools = new ToolController();
    tools.hoverAt(2, 0.1);
    expect(tools.view(first).card?.rows.find((r) => r.label === 'Poles')?.value).not.toMatch(/None/);
    expect(tools.view(second).card?.rows.find((r) => r.label === 'Poles')?.value).toMatch(/None/);
  });
});

describe('touch taps', () => {
  it('previews a cable run on the first tap and orders it on a second tap at the same corner', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('underground');
    const dispatch = dispatcher(state);

    // Picking the start corner needs no confirming.
    expect(tools.tap(state, dispatch, 0.1, 0.1)).toBeNull();
    expect(tools.drawing).toBe(true);

    // First tap on a target: quote only, nothing ordered.
    expect(tools.tap(state, dispatch, 7.8, 0.2)).toBeNull();
    expect(state.network.spans).toEqual([]);
    const preview = tools.view(state);
    expect(preview.overlay.path?.segments).toEqual([0, 1]);
    expect(preview.card?.rows.find((r) => r.label === 'Cost')?.value).toBe('$14,400');
    expect(preview.card?.hint).toBe('Tap this corner again to order');

    // A tap on a different corner moves the preview instead of ordering.
    expect(tools.tap(state, dispatch, 4.1, 0.1)).toBeNull();
    expect(state.network.spans).toEqual([]);

    // Second tap on the previewed corner orders it.
    const outcome = tools.tap(state, dispatch, 4.2, -0.1);
    expect(outcome?.ok).toBe(true);
    expect(state.network.spans.map((s) => s.segment)).toEqual([0]);
  });

  it('asks for a confirming tap before placing a cabinet or removing cable', () => {
    const state = game();
    const tools = new ToolController();
    const dispatch = dispatcher(state);
    tools.setTool('cabinet');
    expect(tools.tap(state, dispatch, 4.3, 1.8)).toBeNull();
    expect(state.network.cabinets).toEqual([]);
    expect(tools.view(state).card?.hint).toMatch(/^Tap again to place/);
    expect(tools.tap(state, dispatch, 4.1, 2.1)?.ok).toBe(true);
    expect(state.network.cabinets.map((c) => c.node)).toEqual([5]);

    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    tools.setTool('remove');
    expect(tools.tap(state, dispatch, 2, 0.2)).toBeNull();
    expect(state.network.spans).toHaveLength(1);
    expect(tools.view(state).card?.hint).toMatch(/Tap again to remove\.$/);
    expect(tools.tap(state, dispatch, 2.2, 0.1)?.ok).toBe(true);
    expect(state.network.spans).toEqual([]);
  });

  it('drops a pending preview when the tool changes', () => {
    const state = game();
    const tools = new ToolController();
    const dispatch = dispatcher(state);
    tools.setTool('cabinet');
    tools.tap(state, dispatch, 4.3, 1.8);
    tools.setTool('inspect');
    tools.setTool('cabinet');
    expect(tools.tap(state, dispatch, 4.3, 1.8)).toBeNull();
    expect(state.network.cabinets).toEqual([]);
  });

  it('keeps mouse clicks immediate and their hints in mouse terms', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.3, 1.8);
    expect(tools.view(state).card?.hint).toMatch(/^Click to place/);
    expect(tools.click(state, dispatcher(state), 4.3, 1.8)?.ok).toBe(true);
  });
});
