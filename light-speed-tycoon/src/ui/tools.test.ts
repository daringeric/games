import { describe, expect, it } from 'vitest';
import { CABINET_REACH_FT, CPP_TARGET, LOAN_ROUNDING, SPLIT_RATIO } from '../sim/balance';
import { coveragePreview } from '../sim/coverage';
import { creditAvailable, creditLimit } from '../sim/debt';
import { applyCommand, newGame, runDays } from '../sim/game';
import {
  getService,
  ponPortsUsed,
  quoteCabinet,
  quoteCable,
  quoteRemoveCabinet,
  quoteRemoveSpan,
  quoteSplitter,
  segmentCostPerFt,
  spanOnSegment,
} from '../sim/network';
import { makeGridCity } from '../sim/testing/fixtures';
import type { Command, CommandResult, GameState } from '../sim/types';
import { formatMoney, formatNumber, formatPerFt } from './format';
import { ToolController, accountAt, cancelRefund, cashAfterRow, cornerLabel, creditHint, fundsOf, wrongSideWarning } from './tools';
import type { CardModel } from './tools';

// Grid town: nodes (i, j) at (4i, 2j), id j * 4 + i; the CO is node 0 at (0, 0).
// Horizontal segment (i, j) has id j * 3 + i; vertical (i, j) has id 9 + j * 4 + i.
function game(opts: Parameters<typeof makeGridCity>[0] = {}): GameState {
  return newGame(7, { city: makeGridCity(opts) });
}

function dispatcher(state: GameState) {
  return (cmd: Command) => applyCommand(state, cmd);
}

/** A dispatcher that applies commands and remembers them. */
function recorder(state: GameState): { dispatch: (cmd: Command) => CommandResult; commands: Command[] } {
  const commands: Command[] = [];
  return {
    commands,
    dispatch: (cmd) => {
      commands.push(cmd);
      return applyCommand(state, cmd);
    },
  };
}

function row(card: CardModel | null | undefined, label: string): string | undefined {
  return card?.rows.find((r) => r.label === label)?.value;
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
    const quote = quoteCable(state, [0, 1], 'underground');
    expect(view.card?.title).toBe('Underground cable');
    expect(row(view.card, 'Cost')).toBe(formatMoney(quote.cost));
    expect(view.card?.blockers).toEqual([]);

    const cash = state.finance.cash;
    const outcome = tools.click(state, dispatcher(state), 7.8, 0.3);
    expect(outcome?.ok).toBe(true);
    expect(outcome?.message).toContain('2 spans');
    expect(state.network.spans.map((s) => s.segment)).toEqual([0, 1]);
    expect(state.finance.cash).toBe(cash - quote.cost);
    // The run continues from where it ended.
    expect(tools.view(state).overlay.origin).toBe(2);
  });

  it('itemizes the quote: one line per charge, totals, $/ft, passings, cost per passing, timing and refund', () => {
    const state = game({ rock: true });
    const tools = new ToolController();
    tools.setTool('underground');
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(8, 0);
    const card = tools.view(state).card;
    const quote = quoteCable(state, [0, 1], 'underground');

    expect(card?.lines?.map((l) => l.label)).toEqual(quote.lines.map((l) => l.label));
    expect(card?.lines?.map((l) => l.amount)).toEqual(quote.lines.map((l) => formatMoney(l.amount)));
    // The rock surcharge is its own line, priced per foot.
    const rock = quote.lines.find((l) => l.kind === 'rock');
    expect(rock).toBeDefined();
    expect(card?.lines?.find((l) => l.label === rock!.label)?.detail).toBe(`${formatNumber(rock!.quantity)} ft × ${formatPerFt(rock!.rate)}`);
    expect(card?.lines?.find((l) => l.label === 'Engineering')?.detail).toBe('per order');

    expect(row(card, 'Cost')).toBe(formatMoney(quote.cost));
    expect(row(card, 'Per foot')).toBe(formatPerFt(quote.costPerFt));
    expect(row(card, 'Passings')).toBe(formatNumber(quote.passingsAlong));
    expect(row(card, 'In reach')).toBe(`${formatNumber(quote.passingsInReach)} of ${formatNumber(quote.passingsAlong)}`);
    const cpp = card?.rows.find((r) => r.label === 'Cost per passing');
    expect(cpp?.value).toBe(formatMoney(quote.cpp!));
    expect(cpp?.tone).toBe(quote.cppBand);
    expect(cpp?.sub).toBe(`target ${formatMoney(CPP_TARGET)}`);
    expect(row(card, 'Permit')).toBe(`${quote.permitDaysMin}–${quote.permitDaysMax} days`);
    expect(card?.note).toBe(`Cancel while permitting: ${formatMoney(cancelRefund(quote.refundable))} back`);
    // No cabinet yet, so the homes along it are not in reach.
    expect(card?.warnings).toContain(`${formatNumber(quote.passingsAlong)} not yet within ${formatNumber(CABINET_REACH_FT)} ft of a cabinet`);
  });

  it('warns about buildings that face another street and emphasizes the ones the route serves', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('underground');
    // Down A Ave (segment 9): the corner lots beside it front 1st and 2nd St.
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(0, 2);
    const view = tools.view(state);
    const quote = quoteCable(state, [9], 'underground');
    expect(quote.wrongSideParcels.length).toBe(2);
    expect(view.card?.warnings).toContain(wrongSideWarning(2));
    expect(wrongSideWarning(3)).toBe('3 buildings along this route face another street');
    expect(view.overlay.wrongSide).toEqual(quote.wrongSideParcels);
    expect(view.overlay.served).toEqual([]);
    // Along 1st St every home it passes gets its drop point emphasized.
    tools.cancel();
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(4, 0);
    const along = state.city.parcels.filter((p) => p.segment === 0).map((p) => p.id);
    expect(tools.view(state).overlay.served).toEqual(along);
  });

  it('says a remembered make-ready is already surveyed', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'aerial' });
    applyCommand(state, { type: 'removeSpan', span: spanOnSegment(state, 0)!.id });
    const tools = new ToolController();
    tools.setTool('aerial');
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(4, 0);
    const quote = quoteCable(state, [0], 'aerial');
    expect(quote.rememberedPermitDays).not.toBeNull();
    expect(row(tools.view(state).card, 'Make-ready')).toBe(`${quote.permitDaysMin} days (already surveyed)`);
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

describe('drag to draw', () => {
  it('orders exactly one layCable for the dragged route on release', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('underground');
    const { dispatch, commands } = recorder(state);

    expect(tools.dragStart(state, 0.15, 0.1)).toBe(true);
    expect(tools.dragging).toBe(true);
    tools.dragMove(state, 3.8, 0.2);
    tools.dragMove(state, 7.9, -0.1);
    const view = tools.view(state);
    expect(view.overlay.path).toEqual({ segments: [0, 1], fresh: [0, 1], method: 'underground', ok: true });
    expect(view.overlay.origin).toBe(0);
    expect(view.card?.hint).toMatch(/^Release to order/);
    const quote = quoteCable(state, [0, 1], 'underground');
    expect(row(view.card, 'Cost')).toBe(formatMoney(quote.cost));

    const ledger = state.finance.monthToDate.length;
    const outcome = tools.dragEnd(state, dispatch, 8, 0);
    expect(outcome?.ok).toBe(true);
    expect(commands).toEqual([{ type: 'layCable', segments: [0, 1], method: 'underground' }]);
    expect(state.network.spans.map((s) => s.segment)).toEqual([0, 1]);
    // One order: the per-order fees are charged once, in one ledger entry.
    const entries = state.finance.monthToDate.slice(ledger);
    expect(entries.map((e) => e.category)).toEqual(['construction']);
    expect(entries[0]!.amount).toBe(-quote.cost);
    expect(tools.dragging).toBe(false);
    // A drag doesn't leave a click-by-click run behind.
    expect(tools.drawing).toBe(false);
  });

  it('only starts on a corner in a cable tool', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('underground');
    expect(tools.dragStart(state, 2, 0.9)).toBe(false);
    // A generous pick radius (zoomed out) still needs the press near the corner.
    expect(tools.dragStart(state, 0.7, 0.6, 1)).toBe(true);
    tools.dragCancel();
    tools.setTool('cabinet');
    expect(tools.dragStart(state, 0, 0)).toBe(false);
    tools.setTool('inspect');
    expect(tools.dragStart(state, 0, 0)).toBe(false);
  });

  it('cancels without ordering (Esc, right-click or a second finger)', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('aerial');
    const { dispatch, commands } = recorder(state);
    tools.dragStart(state, 0, 0);
    tools.dragMove(state, 4, 0);
    expect(tools.dragCancel()).toBe(true);
    expect(tools.dragEnd(state, dispatch, 4, 0)).toBeNull();
    expect(commands).toEqual([]);
    expect(tools.dragCancel()).toBe(false);
    // Esc through cancel() ends a drag too.
    tools.dragStart(state, 0, 0);
    tools.dragMove(state, 4, 0);
    expect(tools.cancel()).toBe(true);
    expect(tools.dragEnd(state, dispatch, 4, 0)).toBeNull();
    expect(commands).toEqual([]);
  });

  it('backtracks, orders nothing for a drag that returns to its start, and reports a failed quote', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('underground');
    const { dispatch, commands } = recorder(state);
    tools.dragStart(state, 0, 0);
    tools.dragMove(state, 4, 0);
    tools.dragMove(state, 8, 0);
    tools.dragMove(state, 4, 0);
    expect(tools.view(state).overlay.path?.segments).toEqual([0]);
    tools.dragMove(state, 0, 0);
    expect(tools.dragEnd(state, dispatch, 0, 0)).toBeNull();
    expect(commands).toEqual([]);

    state.finance.cash = 100;
    tools.dragStart(state, 0, 0);
    tools.dragMove(state, 4, 0);
    expect(tools.view(state).card?.blockers.join(' ')).toMatch(/Not enough cash/);
    const outcome = tools.dragEnd(state, dispatch, 4, 0);
    expect(outcome?.ok).toBe(false);
    expect(outcome?.message).toMatch(/Not enough cash/);
    expect(commands).toEqual([]);
  });
});

describe('cabinet tool', () => {
  it('previews coverage at an empty corner and places a cabinet there', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.3, 1.8);
    const view = tools.view(state);
    const quote = quoteCabinet(state, 5);
    const preview = coveragePreview(state, 5);
    expect(view.overlay.cabinet).toEqual({ node: 5, ok: true });
    expect(view.overlay.reach?.map((r) => r.id)).toEqual(preview.segments.map((s) => s.segment));
    expect(view.overlay.reach?.every((r) => r.t >= 0 && r.t < 1 && !r.elsewhere)).toBe(true);
    expect(row(view.card, 'Passings')).toBe(`${formatNumber(preview.passingsNow)} now`);
    expect(row(view.card, 'Already served')).toBe(formatNumber(preview.passingsServedElsewhere));
    expect(row(view.card, 'Passable today')).toBe(formatNumber(preview.passingsPassableToday));
    expect(view.card?.rows.find((r) => r.label === 'Cable to finish')).toMatchObject({ value: formatMoney(preview.buildOutCost), sub: 'incl. order fees' });
    const cpp = view.card?.rows.find((r) => r.label === 'Cost per passing');
    expect(cpp?.value).toBe(formatMoney(preview.projectedCpp!));
    expect(cpp?.sub).toBe(`projected, target ${formatMoney(CPP_TARGET)}`);
    expect(cpp?.tone).toBe(preview.projectedCppBand);
    expect(row(view.card, 'Ports')).toMatch(new RegExp(`^${preview.ports} `));
    expect(row(view.card, 'Cost')).toBe(formatMoney(quote.cost));

    const outcome = tools.click(state, dispatcher(state), 4.3, 1.8);
    expect(outcome).toEqual({ ok: true, message: `Cabinet ordered at ${cornerLabel(state, 5)} for ${formatMoney(quote.cost)}` });
    expect(state.network.cabinets.map((c) => c.node)).toEqual([5]);
  });

  it('shades streets another cabinet already serves and shows existing coverage', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    applyCommand(state, { type: 'layCable', segments: [0, 1], method: 'underground' });
    runDays(state, 120);
    const service = getService(state);
    const cabinet = state.network.cabinets[0]!;
    expect(service.litSegments.has(0)).toBe(true);

    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(8.1, 0.1);
    const view = tools.view(state);
    const preview = coveragePreview(state, 2);
    const elsewhere = preview.segments.filter((s) => s.servedBy !== null).map((s) => s.segment);
    expect(elsewhere.length).toBeGreaterThan(0);
    expect(view.overlay.reach?.filter((r) => r.elsewhere).map((r) => r.id)).toEqual(elsewhere);
    // Solid shading only where a cabinet here would light the street today (along live cable, not served elsewhere).
    const litToday = preview.segments.filter((s) => s.litOnPlacement && s.servedBy === null).map((s) => s.segment);
    expect(view.overlay.reach?.filter((r) => r.lit).map((r) => r.id)).toEqual(litToday);
    // A cabinet here would take 1st St's second block over (0 ft against 240 ft), but it is already passed.
    expect(preview.segments.find((s) => s.segment === 1)).toMatchObject({ litOnPlacement: true, servedBy: cabinet.id });
    expect(litToday).not.toContain(1);
    expect(row(view.card, 'Already served')).toBe(formatNumber(preview.passingsServedElsewhere));
    expect(row(view.card, 'Passable today')).toBe(formatNumber(preview.passingsPassableToday));
    expect(view.overlay.coverage).toEqual([
      { cabinet: cabinet.id, lit: service.cabinetCoverage.get(cabinet.id)!.segments, reach: expect.arrayContaining([0, 1, 9]) },
    ]);
    // The coverage stays up while the pointer is off the map.
    tools.clearHover();
    expect(tools.view(state).overlay.coverage).toHaveLength(1);
  });

  it('refreshes the existing coverage shading as cabinets are placed and streets light, on the same game state', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('cabinet');
    expect(tools.view(state).overlay.coverage).toEqual([]);
    expect(applyCommand(state, { type: 'placeCabinet', node: 0 }).ok).toBe(true);
    const cabinet = state.network.cabinets[0]!;
    expect(tools.view(state).overlay.coverage?.map((c) => c.cabinet)).toEqual([cabinet.id]);
    expect(tools.view(state).overlay.coverage?.[0]?.lit).toEqual([]);
    expect(applyCommand(state, { type: 'layCable', segments: [0, 1], method: 'underground' }).ok).toBe(true);
    runDays(state, 120);
    const lit = getService(state).cabinetCoverage.get(cabinet.id)!.segments;
    expect(lit.length).toBeGreaterThan(0);
    expect(tools.view(state).overlay.coverage?.[0]?.lit).toEqual(lit);
  });

  it('adds a splitter to an existing cabinet', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 5 });
    const cabinet = state.network.cabinets[0]!;
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.1, 2.2);
    const view = tools.view(state);
    const quote = quoteSplitter(state, cabinet.id);
    expect(view.card?.title).toBe('Add a splitter');
    expect(view.overlay.ring).toEqual({ node: 5, tone: 'cabinet' });
    expect(row(view.card, 'Cost')).toBe(formatMoney(quote.cost));
    expect(row(view.card, 'Splitters')).toBe(`1 → ${quote.splittersAfter}`);
    expect(row(view.card, 'Ports')).toBe(`0 of ${SPLIT_RATIO} used → ${quote.portsAfter}`);
    expect(row(view.card, 'PON ports')).toBe(`${quote.ponPortsUsedAfter} of ${quote.ponPorts} after`);
    expect(view.card?.warnings).toEqual([]);

    const { dispatch, commands } = recorder(state);
    const used = ponPortsUsed(state);
    const outcome = tools.click(state, dispatch, 4.1, 2.2);
    expect(outcome?.ok).toBe(true);
    expect(commands).toEqual([{ type: 'addSplitter', cabinet: cabinet.id }]);
    expect(cabinet.splitters).toBe(2);
    expect(ponPortsUsed(state)).toBe(used + 1);
  });

  it('warns when a cabinet is turning signups away', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 5 });
    state.sales.fullCabinets = [state.network.cabinets[0]!.id];
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4, 2);
    expect(tools.view(state).card?.warnings).toEqual(['Full: turning signups away']);
  });
});

describe('remove tool', () => {
  it('highlights a cabled street and refunds its construction while permitting', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    const span = spanOnSegment(state, 0)!;
    const refund = cancelRefund(span.refundable);
    const cash = state.finance.cash;
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(2, 0.2);
    const view = tools.view(state);
    expect(view.overlay.segment).toEqual({ id: 0, tone: 'remove' });
    expect(row(view.card, 'Refund')).toBe(formatMoney(refund));
    expect(view.card?.hint).toMatch(/fees and make-ready are kept/);
    const outcome = tools.click(state, dispatcher(state), 2, 0.2);
    expect(outcome?.message).toBe(`Cable on 1st St cancelled, ${formatMoney(refund)} refunded`);
    expect(state.network.spans).toEqual([]);
    expect(state.finance.cash).toBe(cash + refund);
  });

  it('says there is no refund once crews have started', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    runDays(state, 60);
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(2, 0);
    expect(row(tools.view(state).card, 'Refund')).toBe('No refund');
    expect(tools.click(state, dispatcher(state), 2, 0)?.message).toMatch(/no refund/);
  });

  it('warns about subscribers cut off beyond a live feeder, not only those on its street', () => {
    const state = game();
    // Live cable east along 1st St (segments 0, 1, 2) from the CO cabinet; subscribers on 3rd-segment lots only.
    applyCommand(state, { type: 'layCable', segments: [0, 1, 2], method: 'underground' });
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    runDays(state, 80);
    const cabinet = state.network.cabinets[0]!.id;
    const far = state.city.parcels.filter((p) => p.segment === 2).map((p) => p.id);
    expect(far.length).toBeGreaterThan(1);
    state.sales.accounts = far.map((parcel) => ({ parcel, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0 }));
    const feeder = spanOnSegment(state, 0)!;
    const quote = quoteRemoveSpan(state, feeder.id);
    expect(quote.subscribersAffected).toBe(far.length);
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(2, 0.2);
    const card = tools.view(state).card;
    expect(card?.title).toBe('Remove cable on 1st St');
    expect(row(card, 'Passings lost')).toBe(formatNumber(quote.passingsLost));
    expect(card?.warnings).toEqual([`${far.length} subscribers (some beyond this street) lose service`]);
  });

  it('ignores streets without cable', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(2, 0);
    expect(tools.view(state)).toEqual({ overlay: {}, card: null });
    expect(tools.click(state, dispatcher(state), 2, 0)).toBeNull();
  });

  it('removes a cabinet, refunded while permitting', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 5 });
    const cabinet = state.network.cabinets[0]!;
    const quote = quoteRemoveCabinet(state, cabinet.id);
    expect(quote.refund).toBeGreaterThan(0);
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(4.2, 2.1);
    const view = tools.view(state);
    expect(view.card?.title).toBe(`Remove cabinet at ${cornerLabel(state, 5)}`);
    expect(view.overlay.ring).toEqual({ node: 5, tone: 'remove' });
    expect(row(view.card, 'Refund')).toBe(formatMoney(quote.refund));
    expect(row(view.card, 'Subscribers')).toBe('None affected');
    expect(row(view.card, 'PON ports freed')).toBe(String(quote.ponPortsFreed));

    const cash = state.finance.cash;
    const { dispatch, commands } = recorder(state);
    const outcome = tools.click(state, dispatch, 4.2, 2.1);
    expect(commands).toEqual([{ type: 'removeCabinet', cabinet: cabinet.id }]);
    expect(outcome?.message).toBe(`Cabinet at ${cornerLabel(state, 5)} cancelled, ${formatMoney(quote.refund)} refunded`);
    expect(state.network.cabinets).toEqual([]);
    expect(state.finance.cash).toBe(cash + quote.refund);
  });

  it('counts the subscribers a cabinet removal disconnects', () => {
    const state = game();
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    const cabinet = state.network.cabinets[0]!;
    state.sales.accounts = [{ parcel: 0, cabinet: cabinet.id, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0 }];
    runDays(state, 30);
    // (The account disconnects at the next daily step because nothing is lit; put it back for the quote.)
    state.sales.accounts = [{ parcel: 0, cabinet: cabinet.id, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0 }];
    const tools = new ToolController();
    tools.setTool('remove');
    tools.hoverAt(0.1, 0.1);
    const card = tools.view(state).card;
    expect(row(card, 'Refund')).toBe('No refund');
    expect(row(card, 'Subscribers')).toBe('1 loses service');
    expect(card?.warnings).toEqual(['1 subscriber loses service']);
  });
});

describe('inspect tool', () => {
  it('describes the CO, streets and homes under the cursor', () => {
    const state = game();
    const tools = new ToolController();

    tools.hoverAt(0.1, 0.1);
    const co = tools.view(state).card;
    expect(co?.title).toBe('Central office');
    expect(row(co, 'PON ports in use')).toBe(`0 of ${state.network.olt.ponPorts}`);
    expect(co?.hint).toMatch(/Click to open the OLT panel/);

    tools.hoverAt(2, 0.1);
    const street = tools.view(state);
    expect(street.card?.title).toBe('1st St');
    expect(row(street.card, 'Cable')).toBe('None yet');
    expect(street.overlay.segment).toEqual({ id: 0, tone: 'inspect' });

    tools.hoverAt(1.5, 0.6);
    const home = tools.view(state);
    expect(home.card?.title).toBe('Home');
    expect(row(home.card, 'Fiber')).toBe('Unserved');
    // Its lot is outlined and its serving street highlighted.
    expect(home.overlay).toEqual({ parcel: 2, serving: 0 });
  });

  it('opens the OLT panel from a click on the CO, and nothing elsewhere', () => {
    const state = game();
    const tools = new ToolController();
    expect(tools.click(state, dispatcher(state), 0.1, 0.1)).toEqual({ ok: true, message: '', open: 'olt' });
    expect(tools.tap(state, dispatcher(state), 0.1, 0.1)).toEqual({ ok: true, message: '', open: 'olt' });
    expect(tools.click(state, dispatcher(state), 2, 0.1)).toBeNull();
  });

  it('shows a street’s rates per method', () => {
    const state = game({ rock: true });
    const seg = state.city.segments[0]!;
    const tools = new ToolController();
    tools.hoverAt(2, 0.1);
    const card = tools.view(state).card;
    expect(row(card, 'Aerial')).toBe(`${formatPerFt(segmentCostPerFt(seg, 'aerial')!)} incl. make-ready`);
    expect(row(card, 'Underground')).toBe(`${formatPerFt(segmentCostPerFt(seg, 'underground')!)} incl. rock`);
    expect(row(card, 'Ground')).toMatch(/^Rock/);

    const bare = game({ hasPoles: false });
    tools.hoverAt(2, 0.1);
    expect(row(tools.view(bare).card, 'Aerial')).toBe('No poles');
  });

  it('shows a remembered make-ready on the street', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'aerial' });
    const days = state.network.makeReady[0]!.days;
    applyCommand(state, { type: 'removeSpan', span: spanOnSegment(state, 0)!.id });
    const tools = new ToolController();
    tools.hoverAt(2, 0.1);
    expect(row(tools.view(state).card, 'Make-ready on file')).toBe(`${days} days`);
  });

  it('marks homes passed once the network lights their street, and subscribers', () => {
    const state = game();
    applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
    applyCommand(state, { type: 'placeCabinet', node: 0 });
    runDays(state, 120);
    const tools = new ToolController();
    tools.hoverAt(1.5, 0.6);
    const expected = accountAt(state, 2) ? 'Subscriber' : 'Passed, ready for service';
    expect(row(tools.view(state).card, 'Fiber')).toBe(expected);
    tools.hoverAt(0.1, 0.1);
    expect(row(tools.view(state).card, 'Cabinet here')).toMatch(/Active/);

    // An apartment building counts its subscribing units.
    const mdus = newGame(7, { city: makeGridCity({ parcelKinds: (p) => (p.id === 2 ? { kind: 'mdu', units: 12 } : undefined) }) });
    applyCommand(mdus, { type: 'placeCabinet', node: 0 });
    mdus.sales.accounts = [{ parcel: 2, cabinet: mdus.network.cabinets[0]!.id, tierUnits: { fiber500: 2, fiber1g: 1, fiber2g: 0 }, since: 0 }];
    tools.hoverAt(1.5, 0.6);
    const card = tools.view(mdus).card;
    expect(card?.title).toBe('Apartment building');
    expect(row(card, 'Fiber')).toBe('Subscriber');
    expect(row(card, 'Subscribers')).toBe('3 of 12 units');
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
    const cable = () => row(tools.view(state).card, 'Cable');
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
    const blockers = tools.view(state).card?.blockers;
    expect(blockers).toEqual(quoteCabinet(state, 5).reasons);
    expect(blockers?.join(' ')).toMatch(/Not enough cash/);
  });
});

describe('cash after an order, and the credit line when cash is short', () => {
  /** Closed months with `revenue` each, so the town has ARR and a credit limit. */
  function withRevenue(state: GameState, revenue: number, months = 3): GameState {
    for (let m = 1; m <= months; m++) {
      state.finance.reports.push({ year: 2027, month: m, totals: { revenue }, net: revenue, cashEnd: state.finance.cash, passings: 0 });
    }
    return state;
  }

  it('shows cash after (red below $0) and how the credit line could cover a shortfall', () => {
    expect(cashAfterRow({ cash: 1_000, creditAvailable: 0 }, 400)).toEqual({ label: 'Cash after', value: formatMoney(600) });
    expect(cashAfterRow({ cash: 1_000, creditAvailable: 0 }, 1_500)).toEqual({ label: 'Cash after', value: formatMoney(-500), tone: 'negative' });

    // Cash covers it: nothing to say.
    expect(creditHint({ cash: 1_000, creditAvailable: 50_000 }, 1_000)).toBeUndefined();
    // No credit: nothing to offer.
    expect(creditHint({ cash: 1_000, creditAvailable: 0 }, 5_000)).toBeUndefined();
    // The shortfall rounds up to LOAN_ROUNDING...
    const shortfall = LOAN_ROUNDING + 1;
    expect(creditHint({ cash: 1_000, creditAvailable: 10 * LOAN_ROUNDING }, 1_000 + shortfall)).toBe(
      `Draw ${formatMoney(2 * LOAN_ROUNDING)} from your credit line to afford it`,
    );
    // ...capped at what is available.
    expect(creditHint({ cash: 0, creditAvailable: shortfall }, shortfall)).toBe(`Draw ${formatMoney(shortfall)} from your credit line to afford it`);
    // Some credit, not enough.
    expect(creditHint({ cash: 0, creditAvailable: shortfall - 1 }, shortfall)).toBe(`Your credit line has only ${formatMoney(shortfall - 1)} available`);
    // Overdrawn already: the whole cost plus the hole is the shortfall.
    expect(creditHint({ cash: -LOAN_ROUNDING, creditAvailable: 10 * LOAN_ROUNDING }, LOAN_ROUNDING)).toBe(
      `Draw ${formatMoney(2 * LOAN_ROUNDING)} from your credit line to afford it`,
    );
  });

  it('puts cash after and the credit hint on the cabinet, splitter and cable quote cards', () => {
    const state = withRevenue(game(), 100 * LOAN_ROUNDING);
    expect(creditAvailable(state)).toBeGreaterThan(0);
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.1, 2.1);
    const cabinet = quoteCabinet(state, 5);
    let card = tools.view(state).card!;
    expect(card.rows.find((r) => r.label === 'Cash after')).toEqual({ label: 'Cash after', value: formatMoney(state.finance.cash - cabinet.cost) });
    expect(card.credit).toBeUndefined();

    state.finance.cash = 100;
    card = tools.view(state).card!;
    expect(card.rows.find((r) => r.label === 'Cash after')).toMatchObject({ value: formatMoney(100 - cabinet.cost), tone: 'negative' });
    expect(card.credit).toBe(creditHint(fundsOf(state), cabinet.cost));
    expect(card.credit).toMatch(/^Draw \$[\d,]+ from your credit line to afford it$/);

    state.finance.cash = 1_000_000;
    expect(applyCommand(state, { type: 'placeCabinet', node: 0 }).ok).toBe(true);
    state.finance.cash = 10;
    tools.hoverAt(0.1, 0.1);
    const splitter = quoteSplitter(state, state.network.cabinets[0]!.id);
    card = tools.view(state).card!;
    expect(card.title).toBe('Add a splitter');
    expect(row(card, 'Cash after')).toBe(formatMoney(10 - splitter.cost));
    expect(card.credit).toBe(creditHint(fundsOf(state), splitter.cost));

    tools.setTool('underground');
    tools.click(state, dispatcher(state), 0, 0);
    tools.hoverAt(8, 0);
    const cable = quoteCable(state, [0, 1], 'underground');
    card = tools.view(state).card!;
    expect(row(card, 'Cash after')).toBe(formatMoney(10 - cable.cost));
    expect(card.credit).toBe(creditHint(fundsOf(state), cable.cost));
  });

  it('recomputes the card when only the credit line or the covenant stage changes', () => {
    const state = withRevenue(game(), 100 * LOAN_ROUNDING);
    state.finance.cash = 100;
    const tools = new ToolController();
    tools.setTool('cabinet');
    tools.hoverAt(4.1, 2.1);
    expect(tools.view(state).card?.credit).toMatch(/^Draw/);
    // The line fully drawn (cash unchanged): nothing left to offer.
    state.debt.credit.balance = creditLimit(state);
    expect(tools.view(state).card?.credit).toBeUndefined();
    state.debt.credit.balance = 0;
    expect(tools.view(state).card?.credit).toMatch(/^Draw/);
    // Frozen: no draws.
    state.debt.covenant.stage = 'frozen';
    expect(tools.view(state).card?.credit).toBeUndefined();
  });
});

describe('view cache across games', () => {
  it('recomputes for a new game that matches the old one on day, version and cash', () => {
    // A fresh town on a different street plan: same day 0, version 0 and start cash.
    const first = game();
    const second = newGame(8, { city: makeGridCity({ hasPoles: false }) });
    const tools = new ToolController();
    tools.hoverAt(2, 0.1);
    expect(row(tools.view(first).card, 'Poles')).not.toMatch(/None/);
    expect(row(tools.view(second).card, 'Poles')).toMatch(/None/);
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
    expect(row(preview.card, 'Cost')).toBe(formatMoney(quoteCable(state, [0, 1], 'underground').cost));
    expect(preview.card?.hint).toBe('Tap this corner again to order');

    // A tap on a different corner moves the preview instead of ordering.
    expect(tools.tap(state, dispatch, 4.1, 0.1)).toBeNull();
    expect(state.network.spans).toEqual([]);

    // Second tap on the previewed corner orders it.
    const outcome = tools.tap(state, dispatch, 4.2, -0.1);
    expect(outcome?.ok).toBe(true);
    expect(state.network.spans.map((s) => s.segment)).toEqual([0]);
  });

  it('asks for a confirming tap before placing a cabinet, adding a splitter or removing cable', () => {
    const state = game();
    const tools = new ToolController();
    const dispatch = dispatcher(state);
    tools.setTool('cabinet');
    expect(tools.tap(state, dispatch, 4.3, 1.8)).toBeNull();
    expect(state.network.cabinets).toEqual([]);
    expect(tools.view(state).card?.hint).toMatch(/^Tap again to place/);
    expect(tools.tap(state, dispatch, 4.1, 2.1)?.ok).toBe(true);
    expect(state.network.cabinets.map((c) => c.node)).toEqual([5]);

    // The cabinet is now there: the next tap previews a splitter, the one after adds it.
    expect(tools.tap(state, dispatch, 4.1, 2.1)).toBeNull();
    expect(tools.view(state).card?.hint).toMatch(/^Tap again to add/);
    expect(state.network.cabinets[0]!.splitters).toBe(1);
    expect(tools.tap(state, dispatch, 4, 2)?.ok).toBe(true);
    expect(state.network.cabinets[0]!.splitters).toBe(2);

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

  it('says "lift your finger" while a finger draws', () => {
    const state = game();
    const tools = new ToolController();
    tools.setTool('underground');
    tools.touch = true;
    tools.dragStart(state, 0, 0);
    tools.dragMove(state, 4, 0);
    expect(tools.view(state).card?.hint).toMatch(/^Lift your finger to order/);
  });
});
