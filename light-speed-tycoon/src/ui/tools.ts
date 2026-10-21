// Tool logic: turns the cursor position (map grid units) into overlay
// feedback, a floating info/quote card, and Commands on click, tap or drag.
// Free of DOM and Pixi so it unit-tests against hand-built states.

import { formatDate } from '../sim/calendar';
import {
  CABINET_REACH_FT,
  CPP_TARGET,
  OLT_MAX_CARDS,
  PERMITTING_CANCEL_REFUND,
  POLE_RENT_PER_POLE_PER_MONTH,
  SPLIT_RATIO,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
} from '../sim/balance';
import { activePromoFor } from '../sim/incumbent';
import { stormRisk } from '../sim/weather';
import { coveragePreview, segmentsWithinReach } from '../sim/coverage';
import {
  cableRoute,
  getService,
  outageImpact,
  ponPortsUsed,
  quoteCabinet,
  quoteCable,
  quoteRemoveCabinet,
  quoteRemoveSpan,
  quoteSplitter,
  rememberedPermitDays,
  segmentCostPerFt,
  spanOnSegment,
} from '../sim/network';
import { accountUnits, cabinetPortCapacity, cabinetPortsUsed } from '../sim/sales';
import { nearestNode, nearestSegment, parcelsServedBy, polesOnSegment, segmentsAtNode } from '../sim/streets';
import type {
  Account,
  Cabinet,
  CableMethod,
  CableQuote,
  CableSpan,
  Command,
  CommandResult,
  CppBand,
  GameState,
  NodeId,
  ParcelId,
  QuoteLine,
  SegmentId,
  ServiceSnapshot,
  SpanId,
} from '../sim/types';
import type { CoverageShade, OverlaySpec } from '../render/overlay';
import { parcelGrid } from '../render/geometry';
import { CableDrag } from './cableDrag';
import { cashAfterRow, creditHint, fundingKey, fundsOf } from './funding';
import type { Funds } from './funding';
import {
  CLASS_LABEL,
  KIND_LABEL,
  METHOD_LABEL,
  formatDayRange,
  formatFeet,
  formatMoney,
  formatNumber,
  formatPerFt,
  formatStage,
  plural,
} from './format';

export type ToolId = 'inspect' | 'aerial' | 'underground' | 'cabinet' | 'remove';

export interface CardRow {
  label: string;
  value: string;
  /** Colors the value: a cost-per-passing band, muted for "nothing to show", negative for money below $0. */
  tone?: CppBand | 'muted' | 'negative';
  /** Small print after the value, e.g. the cost-per-passing target. */
  sub?: string;
}

/** "target $1,000": what a cost per passing is measured against (green at or under it). */
export const CPP_TARGET_NOTE = `target ${formatMoney(CPP_TARGET)}`;

/** One itemized charge of a quote: what it is, quantity x rate, and the amount. */
export interface CardLine {
  label: string;
  detail: string;
  amount: string;
}

export interface CardModel {
  title: string;
  /** Colors the card's accent stripe. */
  tone: 'aerial' | 'underground' | 'cabinet' | 'remove' | 'info';
  /** Itemized charges, shown as a table above the rows. */
  lines?: CardLine[];
  rows: CardRow[];
  /** Amber notes that don't stop the action (e.g. buildings facing another street). */
  warnings?: string[];
  /** Small print under the rows (e.g. what a cancellation would refund). */
  note?: string;
  /** Red reasons the action can't go ahead. */
  blockers: string[];
  /** When cash is short: how the credit line could cover it (shown with the blockers, compact layout too). */
  credit?: string;
  hint?: string;
}

// ---------------------------------------------------------------------------
// Cash after an order, and how to finance it when cash is short (funding.ts,
// owned by the Bank's workstream; re-exported here for existing callers)
// ---------------------------------------------------------------------------

export { cashAfterRow, creditHint, fundsOf } from './funding';
export type { Funds } from './funding';

export interface ToolView {
  overlay: OverlaySpec;
  card: CardModel | null;
}

export interface ToolOutcome {
  ok: boolean;
  /** What to toast; empty for nothing to say. */
  message: string;
  /** A map panel the click asks for (the CO opens the OLT panel, a live span the span panel). */
  open?: 'olt' | 'span';
  /** The span the span panel shows (open 'span'). */
  span?: SpanId;
}

export type Dispatch = (cmd: Command) => CommandResult;

/** How close (grid units) the cursor must be to a corner to inspect what stands there, or to start a drag. */
export const NODE_PICK = 0.42;
/** How close the cursor must be to a street centre line to pick that street. */
const STREET_PICK = 0.3;
const REMOVE_PICK = 0.5;

const OLT_PANEL_HINT = 'to open the OLT panel';

export class ToolController {
  tool: ToolId = 'inspect';
  /** Corner the current click-by-click cable run continues from. */
  private origin: NodeId | null = null;
  private hover: { x: number; y: number } | null = null;
  private cached: { state: GameState; key: string; view: ToolView } | null = null;
  /** Existing cabinets' coverage for the cabinet tool, per network version. */
  private coverageCache: { state: GameState; version: number; shades: CoverageShade[] } | null = null;
  /** The last input was a touch: cards say "tap", and orders take a confirming tap. */
  touch = false;
  /** Touch has no hover: the target a first tap previewed, which a second tap on it confirms. */
  private armed: string | null = null;
  /** A cable run being drawn by dragging from a corner. */
  private drag: CableDrag | null = null;

  setTool(tool: ToolId): void {
    this.tool = tool;
    this.origin = null;
    this.armed = null;
    this.drag = null;
  }

  /** A click-by-click cable run is in progress (it has a start corner). */
  get drawing(): boolean {
    return this.origin !== null;
  }

  /** A cable run is being drawn by dragging. */
  get dragging(): boolean {
    return this.drag !== null;
  }

  /** End a drag or cable run in progress; true if there was one. */
  cancel(): boolean {
    const was = this.origin !== null || this.drag !== null;
    this.origin = null;
    this.armed = null;
    this.drag = null;
    return was;
  }

  hoverAt(x: number, y: number): void {
    this.hover = { x, y };
  }

  clearHover(): void {
    this.hover = null;
  }

  // -------------------------------------------------------------------------
  // Drag to draw
  // -------------------------------------------------------------------------

  /**
   * A press that started at grid point (x, y) became a drag. In a cable tool,
   * when it started within `pick` grid units (at least NODE_PICK) of a corner,
   * it starts drawing a run from that corner (replacing any click-by-click run)
   * and returns true; otherwise false (the input layer pans or ignores it).
   */
  dragStart(state: GameState, x: number, y: number, pick = NODE_PICK): boolean {
    if (this.tool !== 'aerial' && this.tool !== 'underground') return false;
    const node = nearestNode(state.city, x, y);
    const n = state.city.nodes[node];
    if (!n || Math.hypot(n.x - x, n.y - y) > Math.max(NODE_PICK, pick)) return false;
    this.drag = new CableDrag(this.tool, node);
    this.origin = null;
    this.armed = null;
    this.hoverAt(x, y);
    return true;
  }

  /** The drag moved over grid point (x, y): follow it to the nearest corner. */
  dragMove(state: GameState, x: number, y: number): void {
    this.hoverAt(x, y);
    this.drag?.moveTo(state.city, x, y);
  }

  /**
   * The drag was released at (x, y): order ONE layCable along the drawn route
   * when its quote is ok, else report why not. Null when the drag never left
   * its start corner (nothing to order or say).
   */
  dragEnd(state: GameState, dispatch: Dispatch, x: number, y: number): ToolOutcome | null {
    const drag = this.drag;
    if (!drag) return null;
    this.dragMove(state, x, y);
    this.drag = null;
    if (drag.corners.length < 2) return null;
    const route = drag.route(state);
    if (!route) return { ok: false, message: 'No street route along that drag' };
    if (route.length === 0) return null;
    return this.orderCable(state, dispatch, route, drag.method);
  }

  /** Esc, a right-click or a second finger during a drag: drop it without ordering. */
  dragCancel(): boolean {
    const was = this.drag !== null;
    this.drag = null;
    return was;
  }

  // -------------------------------------------------------------------------
  // View
  // -------------------------------------------------------------------------

  /** Overlay and card for the current hover; memoized on everything it reads. */
  view(state: GameState): ToolView {
    const key = [
      this.tool,
      this.origin,
      this.touch,
      this.hoverKey(state),
      this.drag ? `${this.drag.method}:${this.drag.corners.join('.')}` : '-',
      state.network.version,
      fundingKey(state),
      state.day,
    ].join('|');
    // A new or loaded game can share every key field with the old one (a fresh
    // town is day 0, version 0, start cash), so the state itself is part of the key.
    if (this.cached?.state === state && this.cached.key === key) return this.cached.view;
    const view = this.compute(state);
    this.cached = { state, key, view };
    return view;
  }

  /**
   * What of the hover position the view depends on: nothing while dragging
   * (the drag's corners are keyed instead), the nearest corner for the cable
   * and cabinet tools, the exact point for the others. A pointer moving within
   * one corner's area then costs no recompute (no route, quote or preview).
   */
  private hoverKey(state: GameState): string {
    const h = this.hover;
    if (this.drag || !h) return '-';
    if (this.tool === 'aerial' || this.tool === 'underground' || this.tool === 'cabinet') return `n${nearestNode(state.city, h.x, h.y)}`;
    return `${h.x.toFixed(2)},${h.y.toFixed(2)}`;
  }

  /**
   * Act on a touch tap at (x, y). With no hover on touch screens, the first tap
   * on a new target only previews it (the card shows the quote) and a second tap
   * on the same target acts. Picking a run's start corner needs no confirming.
   */
  tap(state: GameState, dispatch: Dispatch, x: number, y: number): ToolOutcome | null {
    this.touch = true;
    this.hoverAt(x, y);
    const target = this.tapTarget(state, x, y);
    if (target !== null && target !== this.armed) {
      this.armed = target;
      return null;
    }
    this.armed = null;
    return this.click(state, dispatch, x, y);
  }

  /** What a tap at (x, y) would act on, for tools whose taps cost money; null acts at once. */
  private tapTarget(state: GameState, x: number, y: number): string | null {
    switch (this.tool) {
      case 'aerial':
      case 'underground': {
        if (this.origin === null) return null;
        const node = nearestNode(state.city, x, y);
        return node === this.origin ? null : `node:${node}`;
      }
      case 'cabinet': {
        const node = nearestNode(state.city, x, y);
        const here = cabinetAt(state, node);
        return here ? `splitter:${here.id}` : `node:${node}`;
      }
      case 'remove': {
        const cabinet = removableCabinet(state, x, y);
        if (cabinet) return `cabinet:${cabinet.id}`;
        const seg = removableSegment(state, x, y);
        return seg === null ? null : `segment:${seg}`;
      }
      case 'inspect':
        return null;
    }
  }

  /** Act on a click at grid point (x, y). Returns a message to toast, or null for nothing to report. */
  click(state: GameState, dispatch: Dispatch, x: number, y: number): ToolOutcome | null {
    const { city } = state;
    switch (this.tool) {
      case 'aerial':
      case 'underground': {
        const target = nearestNode(city, x, y);
        if (this.origin === null) {
          this.origin = target;
          return null;
        }
        if (target === this.origin) return null;
        const method: CableMethod = this.tool;
        const path = cableRoute(state, this.origin, target, method);
        if (!path) return { ok: false, message: 'No street route to that corner' };
        const outcome = this.orderCable(state, dispatch, path, method);
        if (outcome.ok) this.origin = target;
        return outcome;
      }
      case 'cabinet': {
        const node = nearestNode(city, x, y);
        const here = cabinetAt(state, node);
        if (here) {
          const result = dispatch({ type: 'addSplitter', cabinet: here.id });
          if (!result.ok) return { ok: false, message: result.reason };
          const splitters = here.splitters;
          return {
            ok: true,
            message: `Splitter added at ${cornerLabel(state, node)} for ${formatMoney(result.cost)}: ${splitters} × 1:${SPLIT_RATIO}, ${formatNumber(splitters * SPLIT_RATIO)} ports`,
          };
        }
        const result = dispatch({ type: 'placeCabinet', node });
        if (!result.ok) return { ok: false, message: result.reason };
        return { ok: true, message: `Cabinet ordered at ${cornerLabel(state, node)} for ${formatMoney(result.cost)}` };
      }
      case 'remove': {
        const cabinet = removableCabinet(state, x, y);
        if (cabinet) {
          const where = cornerLabel(state, cabinet.node);
          const quote = quoteRemoveCabinet(state, cabinet.id);
          const result = dispatch({ type: 'removeCabinet', cabinet: cabinet.id });
          if (!result.ok) return { ok: false, message: result.reason };
          const lost = quote.subscribersAffected > 0 ? `; ${loseService(quote.subscribersAffected)}` : '';
          return {
            ok: true,
            message:
              result.cost < 0
                ? `Cabinet at ${where} cancelled, ${formatMoney(-result.cost)} refunded${lost}`
                : `Cabinet at ${where} removed, no refund once crews have started${lost}`,
          };
        }
        const seg = removableSegment(state, x, y);
        const span = seg === null ? undefined : spanOnSegment(state, seg);
        if (seg === null || !span) return null;
        const name = city.segments[seg]?.name ?? 'street';
        const result = dispatch({ type: 'removeSpan', span: span.id });
        if (!result.ok) return { ok: false, message: result.reason };
        return {
          ok: true,
          message:
            result.cost < 0
              ? `Cable on ${name} cancelled, ${formatMoney(-result.cost)} refunded`
              : `Cable on ${name} removed, no refund once crews have started`,
        };
      }
      case 'inspect': {
        if (isNearCo(state, x, y)) return { ok: true, message: '', open: 'olt' };
        const span = inspectableSpan(state, x, y);
        return span ? { ok: true, message: '', open: 'span', span: span.id } : null;
      }
    }
  }

  /** Order a cable route (one layCable: per-order fees once) and describe the result. */
  private orderCable(state: GameState, dispatch: Dispatch, route: SegmentId[], method: CableMethod): ToolOutcome {
    const quote = quoteCable(state, route, method);
    if (!quote.ok) return { ok: false, message: quote.reasons.join('; ') };
    const result = dispatch({ type: 'layCable', segments: route, method });
    if (!result.ok) return { ok: false, message: result.reason };
    const spans = plural(quote.newSegments.length, 'span');
    return {
      ok: true,
      message: `${METHOD_LABEL[method]} cable ordered: ${spans}, ${formatFeet(quote.lengthFt)} for ${formatMoney(result.cost)}`,
    };
  }

  private compute(state: GameState): ToolView {
    if (this.drag) return this.dragView(state, this.drag);
    const h = this.hover;
    const context: OverlaySpec = this.tool === 'cabinet' ? { coverage: this.coverageShades(state) } : {};
    if (!h) return { overlay: this.origin === null ? context : { ...context, origin: this.origin }, card: null };
    switch (this.tool) {
      case 'aerial':
      case 'underground':
        return this.cableView(state, this.tool, h.x, h.y);
      case 'cabinet': {
        const view = cabinetView(state, nearestNode(state.city, h.x, h.y), this.touch);
        return { overlay: { ...context, ...view.overlay }, card: view.card };
      }
      case 'remove':
        return removeView(state, h.x, h.y, this.touch);
      case 'inspect':
        return inspectView(state, h.x, h.y, this.touch);
    }
  }

  /** Existing cabinets' lit streets and street reach, recomputed when the network changes. */
  private coverageShades(state: GameState): CoverageShade[] {
    const c = this.coverageCache;
    if (c && c.state === state && c.version === state.network.version) return c.shades;
    const service = getService(state);
    const shades = state.network.cabinets.map((cab) => ({
      cabinet: cab.id,
      lit: service.cabinetCoverage.get(cab.id)?.segments ?? [],
      reach: segmentsWithinReach(state.city, cab.node, CABINET_REACH_FT).map((r) => r.segment),
    }));
    this.coverageCache = { state, version: state.network.version, shades };
    return shades;
  }

  private cableView(state: GameState, method: CableMethod, x: number, y: number): ToolView {
    const { city } = state;
    const snap = nearestNode(city, x, y);
    const title = `${METHOD_LABEL[method]} cable`;
    if (this.origin === null) {
      return {
        overlay: { snap },
        card: {
          title,
          tone: method,
          rows: [{ label: 'Start at', value: cornerLabel(state, snap) }],
          blockers: [],
          hint: `${this.touch ? 'Tap' : 'Click'} a corner to start the run, or drag from a corner along the streets. Fiber must reach back to the CO.`,
        },
      };
    }
    const origin = this.origin;
    if (snap === origin) {
      return {
        overlay: { origin, snap },
        card: {
          title,
          tone: method,
          rows: [],
          blockers: [],
          hint: this.touch ? 'Tap another corner to plan a run. Pick another tool to stop.' : 'Point at another corner to plan a run. Esc to stop.',
        },
      };
    }
    const path = cableRoute(state, origin, snap, method);
    if (!path) {
      return { overlay: { origin, snap }, card: { title, tone: method, rows: [], blockers: ['No street route to that corner'] } };
    }
    const quote = quoteCable(state, path, method);
    const hint = this.touch
      ? quote.ok
        ? 'Tap this corner again to order'
        : 'Tap another corner, or pick another tool to stop'
      : quote.ok
        ? 'Click to order · Esc to stop'
        : 'Esc to stop';
    return {
      overlay: { origin, snap, ...routeOverlay(state, path, quote, method) },
      card: cableQuoteCard(method, quote, hint, fundsOf(state), cableExposure(state, quote.newSegments, method)),
    };
  }

  private dragView(state: GameState, drag: CableDrag): ToolView {
    const method = drag.method;
    const title = `${METHOD_LABEL[method]} cable`;
    const origin = drag.start;
    const snap = drag.last;
    const release = this.touch ? 'Lift your finger' : 'Release';
    if (drag.corners.length < 2) {
      return {
        overlay: { origin, snap },
        card: {
          title,
          tone: method,
          rows: [{ label: 'From', value: cornerLabel(state, origin) }],
          blockers: [],
          hint: `Drag along the streets to plan a run. ${this.touch ? 'Two fingers cancel.' : 'Esc to cancel.'}`,
        },
      };
    }
    const route = drag.route(state);
    if (!route) {
      return { overlay: { origin, snap }, card: { title, tone: method, rows: [], blockers: ['No street route along that drag'] } };
    }
    const quote = quoteCable(state, route, method);
    const hint = quote.ok
      ? `${release} to order · ${this.touch ? 'two fingers cancel' : 'Esc to cancel'}`
      : `Drag back to undo · ${this.touch ? 'two fingers cancel' : 'Esc to cancel'}`;
    return {
      overlay: { origin, snap, ...routeOverlay(state, route, quote, method) },
      card: cableQuoteCard(method, quote, hint, fundsOf(state), cableExposure(state, quote.newSegments, method)),
    };
  }
}

// ---------------------------------------------------------------------------
// Cable quotes
// ---------------------------------------------------------------------------

/** The planned route's overlay: the run, the buildings it would serve, and those facing another street. */
function routeOverlay(state: GameState, path: readonly SegmentId[], quote: CableQuote, method: CableMethod): OverlaySpec {
  const served: ParcelId[] = [];
  for (const seg of quote.newSegments) {
    for (const id of parcelsServedBy(state.city, seg)) {
      const p = state.city.parcels[id];
      if (p && p.appearsDay <= state.day) served.push(id);
    }
  }
  return {
    path: { segments: [...path], fresh: quote.newSegments, method, ok: quote.ok },
    served,
    wrongSide: quote.wrongSideParcels,
  };
}

function lineDetail(line: QuoteLine): string {
  switch (line.unit) {
    case 'ft':
      return `${formatFeet(line.quantity)} × ${formatPerFt(line.rate)}`;
    case 'pole':
      return `${formatNumber(line.quantity)} × ${formatMoney(line.rate)}`;
    case 'order':
      return 'per order';
  }
}

/** "3 buildings along this route face another street" */
export function wrongSideWarning(count: number): string {
  return count === 1 ? '1 building along this route faces another street' : `${formatNumber(count)} buildings along this route face another street`;
}

/** The refund a cancellation during permitting would bring for a quote. */
export function cancelRefund(refundable: number): number {
  return Math.round(refundable * PERMITTING_CANCEL_REFUND);
}

/** What cable of a method costs to keep once live (cableExposure). */
export interface CableExposure {
  /** Expected storm (and, underground, dig-in) repair dollars a year, from weather.stormRisk. */
  repairsPerYear: number;
  /** Pole rent a month (aerial; 0 underground). */
  poleRentPerMonth: number;
}

/**
 * What cable of `method` on these segments would cost to keep: expected
 * repairs a year (weather.stormRisk) and pole rent a month. The quote cards
 * show it so the aerial / underground trade-off is visible.
 */
export function cableExposure(state: GameState, segments: readonly SegmentId[], method: CableMethod): CableExposure {
  let repairsPerYear = 0;
  let poles = 0;
  for (const id of segments) {
    const segment = state.city.segments[id];
    if (!segment) continue;
    repairsPerYear += stormRisk(state, segment, method).repairCostPerYear;
    if (method === 'aerial') poles += polesOnSegment(segment);
  }
  return { repairsPerYear, poleRentPerMonth: poles * POLE_RENT_PER_POLE_PER_MONTH };
}

/** "about $340 a year in repairs" (under a dollar: "under $1 a year"). */
export function stormRiskText(dollarsPerYear: number): string {
  return dollarsPerYear < 1 ? 'under $1 a year in repairs' : `about ${formatMoney(dollarsPerYear)} a year in repairs`;
}

/**
 * Itemized quote card: charges, total and $/ft, cash after (with `funds`),
 * passings, cost per passing, timing, storm risk and pole rent (with
 * `exposure`), warnings, refund, and the credit line when cash is short.
 */
export function cableQuoteCard(method: CableMethod, quote: CableQuote, hint: string, funds?: Funds, exposure?: CableExposure): CardModel {
  const rows: CardRow[] = [
    { label: 'Cost', value: formatMoney(quote.cost) },
    ...(funds && quote.newSegments.length > 0 ? [cashAfterRow(funds, quote.cost)] : []),
    { label: 'Per foot', value: quote.lengthFt > 0 ? formatPerFt(quote.costPerFt) : '–', tone: quote.lengthFt > 0 ? undefined : 'muted' },
    { label: 'Length', value: `${formatFeet(quote.lengthFt)} · ${plural(quote.newSegments.length, 'span')}` },
    {
      label: 'Passings',
      value: `${formatNumber(quote.passingsAlong)}${quote.passingsFuture > 0 ? ` (+${formatNumber(quote.passingsFuture)} later)` : ''}`,
    },
    {
      label: 'In reach',
      value: quote.passingsAlong > 0 ? `${formatNumber(quote.passingsInReach)} of ${formatNumber(quote.passingsAlong)}` : '–',
      tone: quote.passingsAlong > 0 ? undefined : 'muted',
    },
    quote.cpp === null
      ? { label: 'Cost per passing', value: 'No homes along it', tone: 'muted' }
      : { label: 'Cost per passing', value: formatMoney(quote.cpp), tone: quote.cppBand ?? undefined, sub: CPP_TARGET_NOTE },
    {
      label: method === 'aerial' ? 'Make-ready' : 'Permit',
      value:
        formatDayRange(quote.permitDaysMin, quote.permitDaysMax) + (quote.rememberedPermitDays !== null ? ' (already surveyed)' : ''),
    },
    { label: 'Build', value: plural(quote.constructDays, 'day') },
  ];
  if (exposure && quote.newSegments.length > 0) {
    rows.push({
      label: 'Storm risk',
      value: stormRiskText(exposure.repairsPerYear),
      sub: method === 'aerial' ? `+ ${formatMoney(exposure.poleRentPerMonth)}/mo pole rent` : 'no pole rent',
    });
  }
  const warnings: string[] = [];
  if (quote.wrongSideParcels.length > 0) warnings.push(wrongSideWarning(quote.wrongSideParcels.length));
  if (quote.passingsAlong > quote.passingsInReach) {
    warnings.push(
      `${formatNumber(quote.passingsAlong - quote.passingsInReach)} not yet within ${formatFeet(CABINET_REACH_FT)} of a cabinet`,
    );
  }
  return {
    title: `${METHOD_LABEL[method]} cable`,
    tone: method,
    lines: quote.lines.map((line) => ({ label: line.label, detail: lineDetail(line), amount: formatMoney(line.amount) })),
    rows,
    warnings,
    note: quote.newSegments.length > 0 ? `Cancel while permitting: ${formatMoney(cancelRefund(quote.refundable))} back` : undefined,
    blockers: quote.reasons,
    credit: funds ? creditHint(funds, quote.cost) : undefined,
    hint,
  };
}

// ---------------------------------------------------------------------------
// Cabinet tool
// ---------------------------------------------------------------------------

function cabinetAt(state: GameState, node: NodeId): Cabinet | undefined {
  return state.network.cabinets.find((c) => c.node === node);
}

function cabinetView(state: GameState, node: NodeId, touch: boolean): ToolView {
  const here = cabinetAt(state, node);
  return here ? splitterView(state, here, touch) : coverageView(state, node, touch);
}

/** Hovering an empty corner: what a cabinet there would cover, and what it costs. */
function coverageView(state: GameState, node: NodeId, touch: boolean): ToolView {
  const quote = quoteCabinet(state, node);
  const funds = fundsOf(state);
  const preview = coveragePreview(state, node);
  const reach = preview.segments.map((s) => ({
    id: s.segment,
    t: Math.round((s.distanceFt / preview.reachFt) * 100) / 100,
    elsewhere: s.servedBy !== null,
    lit: s.servedBy === null && s.litOnPlacement,
  }));
  return {
    overlay: { snap: node, cabinet: { node, ok: quote.ok }, reach },
    card: {
      title: 'Cabinet',
      tone: 'cabinet',
      rows: [
        { label: 'At', value: cornerLabel(state, node) },
        {
          label: 'Passings',
          value: `${formatNumber(preview.passingsNow)} now${preview.passingsFuture > 0 ? `, +${formatNumber(preview.passingsFuture)} later` : ''}`,
        },
        { label: 'Already served', value: formatNumber(preview.passingsServedElsewhere) },
        { label: 'Passable today', value: formatNumber(preview.passingsPassableToday) },
        { label: 'Cable to finish', value: formatMoney(preview.buildOutCost), sub: preview.buildOutCost > 0 ? 'incl. order fees' : undefined },
        preview.projectedCpp === null
          ? { label: 'Cost per passing', value: 'Nothing new to pass', tone: 'muted' }
          : {
              label: 'Cost per passing',
              value: formatMoney(preview.projectedCpp),
              tone: preview.projectedCppBand ?? undefined,
              sub: `projected, ${CPP_TARGET_NOTE}`,
            },
        { label: 'Ports', value: `${formatNumber(preview.ports)} (1:${SPLIT_RATIO}, 1 PON port)` },
        { label: 'Cost', value: formatMoney(quote.cost) },
        cashAfterRow(funds, quote.cost),
        { label: 'Ready in', value: plural(quote.permitDays + quote.constructDays, 'day') },
      ],
      blockers: quote.reasons,
      credit: creditHint(funds, quote.cost),
      hint: quote.ok
        ? `${touch ? 'Tap again' : 'Click'} to place. It lights streets within ${formatFeet(preview.reachFt)} along cable joined to the CO: solid streets light today, shaded ones once cabled.`
        : undefined,
    },
  };
}

/** Hovering an existing cabinet with the cabinet tool: add a splitter. */
function splitterView(state: GameState, cabinet: Cabinet, touch: boolean): ToolView {
  const quote = quoteSplitter(state, cabinet.id);
  const funds = fundsOf(state);
  const used = cabinetPortsUsed(state).get(cabinet.id) ?? 0;
  const warnings = state.sales.fullCabinets.includes(cabinet.id) ? ['Full: turning signups away'] : [];
  return {
    overlay: { snap: cabinet.node, ring: { node: cabinet.node, tone: 'cabinet' } },
    card: {
      title: 'Add a splitter',
      tone: 'cabinet',
      rows: [
        { label: 'At', value: cornerLabel(state, cabinet.node) },
        { label: 'Cost', value: formatMoney(quote.cost) },
        cashAfterRow(funds, quote.cost),
        { label: 'Splitters', value: `${cabinet.splitters} → ${quote.splittersAfter}` },
        {
          label: 'Ports',
          value: `${formatNumber(used)} of ${formatNumber(cabinetPortCapacity(cabinet))} used → ${formatNumber(quote.portsAfter)}`,
        },
        { label: 'PON ports', value: `${formatNumber(quote.ponPortsUsedAfter)} of ${formatNumber(quote.ponPorts)} after` },
      ],
      warnings,
      blockers: quote.reasons,
      credit: creditHint(funds, quote.cost),
      hint: quote.ok ? `${touch ? 'Tap again' : 'Click'} to add a 1:${SPLIT_RATIO} splitter (uses 1 PON port).` : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// Remove tool
// ---------------------------------------------------------------------------

function removableCabinet(state: GameState, x: number, y: number): Cabinet | undefined {
  const node = nearestNode(state.city, x, y);
  const n = state.city.nodes[node];
  if (!n || Math.hypot(n.x - x, n.y - y) > REMOVE_PICK) return undefined;
  return cabinetAt(state, node);
}

function removableSegment(state: GameState, x: number, y: number): SegmentId | null {
  const seg = nearestSegment(state.city, x, y, REMOVE_PICK);
  return seg !== null && spanOnSegment(state, seg) ? seg : null;
}

function removeView(state: GameState, x: number, y: number, touch: boolean): ToolView {
  const cabinet = removableCabinet(state, x, y);
  if (cabinet) return removeCabinetView(state, cabinet, touch);
  const seg = removableSegment(state, x, y);
  const span = seg === null ? undefined : spanOnSegment(state, seg);
  if (seg === null || !span) return { overlay: {}, card: null };
  const name = state.city.segments[seg]?.name ?? 'street';
  const permitting = span.stage === 'permitting';
  // Live cable can cut off more than its own street: the quote counts everyone downstream too.
  const quote = quoteRemoveSpan(state, span.id);
  const refund = quote.refund;
  const onStreet = subscribersOnSegment(state, seg);
  const warnings: string[] = [];
  if (quote.subscribersAffected > 0) {
    warnings.push(loseService(quote.subscribersAffected, quote.subscribersAffected > onStreet ? ' (some beyond this street)' : ' on this street'));
  }
  const rows: CardRow[] = [
    { label: 'Cable', value: `${METHOD_LABEL[span.method]}, ${formatStage(span.stage, span.stageDaysLeft).toLowerCase()}` },
    { label: 'Refund', value: refund > 0 ? formatMoney(refund) : 'No refund' },
  ];
  if (span.stage === 'live') rows.push({ label: 'Passings lost', value: formatNumber(quote.passingsLost) });
  return {
    overlay: { segment: { id: seg, tone: 'remove' } },
    card: {
      title: `Remove cable on ${name}`,
      tone: 'remove',
      rows,
      warnings,
      blockers: [],
      hint:
        (permitting
          ? refund < span.cost
            ? 'Still permitting: cancelling refunds construction; fees and make-ready are kept.'
            : 'Still permitting: cancelling refunds it in full.'
          : 'Crews have started, so removing it refunds nothing.') + (touch ? ' Tap again to remove.' : ''),
    },
  };
}

function removeCabinetView(state: GameState, cabinet: Cabinet, touch: boolean): ToolView {
  const quote = quoteRemoveCabinet(state, cabinet.id);
  const where = cornerLabel(state, cabinet.node);
  return {
    overlay: { ring: { node: cabinet.node, tone: 'remove' } },
    card: {
      title: `Remove cabinet at ${where}`,
      tone: 'remove',
      rows: [
        { label: 'Status', value: formatStage(cabinet.stage, cabinet.stageDaysLeft) },
        { label: 'Refund', value: quote.refund > 0 ? formatMoney(quote.refund) : 'No refund' },
        {
          label: 'Subscribers',
          value:
            quote.subscribersAffected > 0
              ? `${formatNumber(quote.subscribersAffected)} ${quote.subscribersAffected === 1 ? 'loses' : 'lose'} service`
              : 'None affected',
        },
        { label: 'PON ports freed', value: formatNumber(quote.ponPortsFreed) },
      ],
      warnings: quote.subscribersAffected > 0 ? [loseService(quote.subscribersAffected)] : [],
      blockers: quote.reasons,
      hint:
        (cabinet.stage === 'permitting' ? 'Still permitting: cancelling refunds it in full.' : 'Crews have started, so removing it refunds nothing.') +
        (touch ? ' Tap again to remove.' : ''),
    },
  };
}

/** "1 subscriber loses service" / "12 subscribers on this street lose service" */
function loseService(units: number, where = ''): string {
  return `${plural(units, 'subscriber')}${where} ${units === 1 ? 'loses' : 'lose'} service`;
}

/** Subscribed units on parcels this street serves. */
function subscribersOnSegment(state: GameState, seg: SegmentId): number {
  let units = 0;
  for (const account of state.sales.accounts) {
    if (state.city.parcels[account.parcel]?.segment === seg) units += accountUnits(account);
  }
  return units;
}

// ---------------------------------------------------------------------------
// Inspect
// ---------------------------------------------------------------------------

function isNearCo(state: GameState, x: number, y: number): boolean {
  const { city } = state;
  const node = nearestNode(city, x, y);
  const n = city.nodes[node];
  return node === city.coNode && n !== undefined && Math.hypot(n.x - x, n.y - y) <= NODE_PICK;
}

/** The account at a parcel (accounts are sorted by parcel). */
export function accountAt(state: GameState, parcel: ParcelId): Account | undefined {
  const accounts = state.sales.accounts;
  let lo = 0;
  let hi = accounts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const a = accounts[mid] as Account;
    if (a.parcel === parcel) return a;
    if (a.parcel < parcel) lo = mid + 1;
    else hi = mid - 1;
  }
  return undefined;
}

function inspectView(state: GameState, x: number, y: number, touch: boolean): ToolView {
  const { city, network } = state;
  const service = getService(state);
  const node = nearestNode(city, x, y);
  const n = city.nodes[node];
  const nearNode = n ? Math.hypot(n.x - x, n.y - y) <= NODE_PICK : false;

  if (nearNode && node === city.coNode) {
    const used = ponPortsUsed(state);
    const here = cabinetAt(state, node);
    const liveFt = network.spans
      .filter((s) => s.stage === 'live')
      .reduce((sum, s) => sum + (city.segments[s.segment]?.lengthFt ?? 0), 0);
    const rows: CardRow[] = [
      { label: 'OLT', value: `${network.olt.tech === 'gpon' ? 'GPON' : 'XGS-PON'}, ${plural(network.olt.ponPorts, 'PON port')}` },
      { label: 'PON ports in use', value: `${formatNumber(used)} of ${formatNumber(network.olt.ponPorts)}` },
      { label: 'Line cards', value: `${network.olt.cards} of ${OLT_MAX_CARDS}` },
      { label: 'Live cable', value: formatFeet(liveFt) },
      { label: 'Passings', value: formatNumber(service.passings) },
    ];
    if (here) rows.push({ label: 'Cabinet here', value: cabinetStatus(here, service) });
    return {
      overlay: {},
      card: {
        title: 'Central office',
        tone: 'info',
        rows,
        blockers: [],
        hint: `All fiber starts here. ${touch ? 'Tap' : 'Click'} ${OLT_PANEL_HINT}.`,
      },
    };
  }

  const cabinet = nearNode ? cabinetAt(state, node) : undefined;
  if (cabinet) {
    const used = cabinetPortsUsed(state).get(cabinet.id) ?? 0;
    const coverage = service.cabinetCoverage.get(cabinet.id);
    const rows: CardRow[] = [
      { label: 'At', value: cornerLabel(state, node) },
      { label: 'Status', value: cabinetStatus(cabinet, service) },
      { label: 'Splitters', value: `${cabinet.splitters} × 1:${SPLIT_RATIO}` },
      { label: 'Ports', value: `${formatNumber(used)} of ${formatNumber(cabinetPortCapacity(cabinet))} in use` },
    ];
    if (coverage) rows.push({ label: 'Passings', value: formatNumber(coverage.passings) });
    rows.push({ label: 'Ordered', value: formatDate(cabinet.orderedDay) });
    const warnings = state.sales.fullCabinets.includes(cabinet.id) ? ['Full: turning signups away'] : [];
    const promo = activePromoFor(state, cabinet.id);
    if (promo) {
      rows.push({ label: 'Incumbent promo', value: `${formatMoney(promo.price)}/mo until ${formatDate(promo.endDay)}`, tone: 'negative' });
      warnings.push(`The cable company is running a ${formatMoney(promo.price)} promo here: fewer signups and more cancellations until ${formatDate(promo.endDay)}`);
    }
    return {
      overlay: { ring: { node, tone: 'cabinet' } },
      card: {
        title: 'Cabinet',
        tone: 'cabinet',
        rows,
        warnings,
        blockers: [],
      },
    };
  }

  const seg = nearestSegment(city, x, y, STREET_PICK);
  if (seg !== null) {
    const s = city.segments[seg];
    if (s) {
      const span = spanOnSegment(state, seg);
      const poles = polesOnSegment(s);
      const cable = span
        ? `${METHOD_LABEL[span.method]}, ${formatStage(span.stage, span.stageDaysLeft).toLowerCase()}${
            service.litSegments.has(seg) ? ', lit' : service.connectedSegments.has(seg) ? ', out of cabinet reach' : ''
          }`
        : 'None yet';
      const aerialFt = segmentCostPerFt(s, 'aerial');
      const undergroundFt = segmentCostPerFt(s, 'underground');
      const rows: CardRow[] = [
        { label: 'Street', value: `${CLASS_LABEL[s.streetClass]}, ${formatFeet(s.lengthFt)}` },
        { label: 'Aerial', value: aerialFt === null ? 'No poles' : `${formatPerFt(aerialFt)} incl. make-ready` },
        { label: 'Underground', value: undergroundFt === null ? '–' : `${formatPerFt(undergroundFt)}${s.rock ? ' incl. rock' : ''}` },
        { label: 'Poles', value: poles > 0 ? `${poles}` : 'None (underground only)' },
        { label: 'Ground', value: s.rock ? `Rock (+${formatPerFt(UNDERGROUND_ROCK_SURCHARGE_PER_FT)} underground)` : 'Soil' },
        { label: 'Cable', value: cable },
      ];
      const aerialMemo = rememberedPermitDays(state, seg, 'aerial');
      const undergroundMemo = rememberedPermitDays(state, seg, 'underground');
      if (aerialMemo !== null) rows.push({ label: 'Make-ready on file', value: plural(aerialMemo, 'day') });
      if (undergroundMemo !== null) rows.push({ label: 'Permit on file', value: plural(undergroundMemo, 'day') });
      const warnings: string[] = [];
      let hint: string | undefined;
      if (span && span.stage === 'live') {
        rows.push(...liveSpanRows(state, span));
        const outage = outageText(state, span);
        if (outage) warnings.push(outage);
        hint = `${touch ? 'Tap' : 'Click'} for its storm history${span.method === 'aerial' ? ' and the underground rebuild' : ''}.`;
      }
      return {
        overlay: { segment: { id: seg, tone: 'inspect' } },
        card: { title: s.name, tone: span ? span.method : 'info', rows, warnings, blockers: [], hint },
      };
    }
  }

  const cx = Math.floor(x);
  const cy = Math.floor(y);
  if (cx >= 0 && cy >= 0 && cx < city.width && cy < city.height) {
    const id = (parcelGrid(city)[cy * city.width + cx] ?? 0) - 1;
    const p = city.parcels[id];
    if (p && p.appearsDay <= state.day) {
      const passed = service.passedParcels.includes(p.id);
      const account = accountAt(state, p.id);
      const subscribed = account ? accountUnits(account) : 0;
      const units = p.kind === 'mdu' ? plural(p.units, 'unit') : p.kind === 'smb' ? '1 business' : '1 household';
      const fiber = subscribed > 0 ? 'Subscriber' : passed ? 'Passed, ready for service' : 'Unserved';
      const rows: CardRow[] = [
        { label: 'Size', value: units },
        { label: 'Fiber', value: fiber },
      ];
      if (p.kind === 'mdu' && subscribed > 0) rows.push({ label: 'Subscribers', value: `${formatNumber(subscribed)} of ${formatNumber(p.units)} units` });
      rows.push({ label: 'Served from', value: city.segments[p.segment]?.name ?? '' });
      return {
        overlay: { parcel: p.id, serving: p.segment },
        card: {
          title: KIND_LABEL[p.kind],
          tone: 'info',
          rows,
          blockers: [],
          hint: p.kind === 'mdu' ? 'Fiber enters at the demarc on the side facing its street.' : undefined,
        },
      };
    }
  }
  return { overlay: {}, card: null };
}

/** The live span the inspect tool would open at (x, y): not on the CO or a cabinet's corner, which their own cards take. */
function inspectableSpan(state: GameState, x: number, y: number): CableSpan | undefined {
  const { city } = state;
  const node = nearestNode(city, x, y);
  const n = city.nodes[node];
  if (n && Math.hypot(n.x - x, n.y - y) <= NODE_PICK && (node === city.coNode || cabinetAt(state, node))) return undefined;
  const seg = nearestSegment(city, x, y, STREET_PICK);
  const span = seg === null ? undefined : spanOnSegment(state, seg);
  return span && span.stage === 'live' ? span : undefined;
}

const CAUSE_LABEL = { storm: 'storm damage', digIn: 'cut by an excavator' } as const;

/**
 * "Out of service: storm damage, 3 days to repair, $1,500; 37 subscribers cut
 * off", or null for a span in service.
 */
export function outageText(state: GameState, span: CableSpan): string | null {
  const outage = span.outage;
  if (!outage) return null;
  const { subscribers } = outageImpact(state, span.id);
  const cut = subscribers > 0 ? `; ${plural(subscribers, 'subscriber')} cut off` : '';
  return `Out of service: ${CAUSE_LABEL[outage.cause]}, ${plural(outage.daysLeft, 'day')} to repair, ${formatMoney(outage.repairCost)}${cut}`;
}

/** "Underground rebuild: permit, 12 days left" / "Underground rebuild: digging, 3 days left", or null. */
export function rebuildText(span: CableSpan): string | null {
  const c = span.conversion;
  if (!c) return null;
  return `${c.stage === 'permitting' ? 'City permit' : 'Crews digging'}, ${plural(Math.max(0, c.stageDaysLeft), 'day')} left`;
}

/** Monthly pole rent a live span pays (aerial only). */
export function spanPoleRent(state: GameState, span: CableSpan): number {
  const segment = state.city.segments[span.segment];
  return span.method === 'aerial' && span.stage === 'live' && segment ? polesOnSegment(segment) * POLE_RENT_PER_POLE_PER_MONTH : 0;
}

/** Inspect rows for a live span: its service, any rebuild, pole rent and storm risk. */
function liveSpanRows(state: GameState, span: CableSpan): CardRow[] {
  const rows: CardRow[] = [];
  const segment = state.city.segments[span.segment];
  if (span.outage) rows.push({ label: 'Service', value: `Out, ${plural(span.outage.daysLeft, 'day')} to repair`, tone: 'negative' });
  const rebuild = rebuildText(span);
  if (rebuild) rows.push({ label: 'Underground rebuild', value: rebuild });
  if (span.method === 'aerial') rows.push({ label: 'Pole rent', value: `${formatMoney(spanPoleRent(state, span))}/mo` });
  if (segment) rows.push({ label: 'Storm risk', value: stormRiskText(stormRisk(state, segment, span.method).repairCostPerYear) });
  return rows;
}

function cabinetStatus(cabinet: Cabinet, service: ServiceSnapshot): string {
  if (cabinet.stage !== 'live') return formatStage(cabinet.stage, cabinet.stageDaysLeft);
  return service.activeCabinets.has(cabinet.id) ? 'Active, lighting connected streets' : 'Live, not cabled to the CO';
}

/** "Main St & Elm Ave" */
export function cornerLabel(state: GameState, node: NodeId): string {
  const names: string[] = [];
  for (const id of segmentsAtNode(state.city, node)) {
    const name = state.city.segments[id]?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names.join(' & ') || `Corner ${node}`;
}
