// Tool logic: turns the cursor position (map grid units) into overlay
// feedback, a floating info/quote card, and Commands on click. Free of DOM and
// Pixi so it unit-tests against hand-built states.

import { formatDate } from '../sim/calendar';
import { cableRoute, getService, quoteCabinet, quoteCable, spanOnSegment } from '../sim/network';
import { nearestNode, nearestSegment, polesOnSegment, segmentsAtNode } from '../sim/streets';
import { SPLIT_RATIO } from '../sim/balance';
import type { Cabinet, CableMethod, Command, CommandResult, GameState, NodeId, SegmentId, ServiceSnapshot } from '../sim/types';
import type { OverlaySpec } from '../render/overlay';
import { parcelGrid } from '../render/geometry';
import {
  CLASS_LABEL,
  KIND_LABEL,
  METHOD_LABEL,
  formatDayRange,
  formatFeet,
  formatMoney,
  formatNumber,
  formatStage,
  plural,
} from './format';

export type ToolId = 'inspect' | 'aerial' | 'underground' | 'cabinet' | 'remove';

export interface CardRow {
  label: string;
  value: string;
}

export interface CardModel {
  title: string;
  /** Colors the card's accent stripe. */
  tone: 'aerial' | 'underground' | 'cabinet' | 'remove' | 'info';
  rows: CardRow[];
  /** Red reasons the action can't go ahead. */
  blockers: string[];
  hint?: string;
}

export interface ToolView {
  overlay: OverlaySpec;
  card: CardModel | null;
}

export interface ToolOutcome {
  ok: boolean;
  message: string;
}

export type Dispatch = (cmd: Command) => CommandResult;

/** How close (grid units) the cursor must be to a corner to inspect what stands there. */
const NODE_PICK = 0.42;
/** How close the cursor must be to a street centre line to pick that street. */
const STREET_PICK = 0.3;
const REMOVE_PICK = 0.5;

export class ToolController {
  tool: ToolId = 'inspect';
  /** Corner the current cable run continues from. */
  private origin: NodeId | null = null;
  private hover: { x: number; y: number } | null = null;
  private cached: { state: GameState; key: string; view: ToolView } | null = null;
  /** The last input was a touch: cards say "tap", and orders take a confirming tap. */
  touch = false;
  /** Touch has no hover: the target a first tap previewed, which a second tap on it confirms. */
  private armed: string | null = null;

  setTool(tool: ToolId): void {
    this.tool = tool;
    this.origin = null;
    this.armed = null;
  }

  get drawing(): boolean {
    return this.origin !== null;
  }

  /** End a cable run in progress; true if there was one. */
  cancel(): boolean {
    const was = this.origin !== null;
    this.origin = null;
    this.armed = null;
    return was;
  }

  hoverAt(x: number, y: number): void {
    this.hover = { x, y };
  }

  clearHover(): void {
    this.hover = null;
  }

  /** Overlay and card for the current hover; memoized on everything it reads. */
  view(state: GameState): ToolView {
    const h = this.hover;
    const key = [
      this.tool,
      this.origin,
      this.touch,
      h ? `${h.x.toFixed(2)},${h.y.toFixed(2)}` : '-',
      state.network.version,
      state.finance.cash,
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
      case 'cabinet':
        return `node:${nearestNode(state.city, x, y)}`;
      case 'remove': {
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
        const quote = quoteCable(state, path, method);
        const result = dispatch({ type: 'layCable', segments: path, method });
        if (!result.ok) return { ok: false, message: result.reason };
        this.origin = target;
        const spans = plural(quote.newSegments.length, 'span');
        return {
          ok: true,
          message: `${METHOD_LABEL[method]} cable ordered: ${spans}, ${formatFeet(quote.lengthFt)} for ${formatMoney(result.cost)}`,
        };
      }
      case 'cabinet': {
        const node = nearestNode(city, x, y);
        const result = dispatch({ type: 'placeCabinet', node });
        if (!result.ok) return { ok: false, message: result.reason };
        return { ok: true, message: `Cabinet ordered at ${cornerLabel(state, node)} for ${formatMoney(result.cost)}` };
      }
      case 'remove': {
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
      case 'inspect':
        return null;
    }
  }

  private compute(state: GameState): ToolView {
    const h = this.hover;
    const origin = this.origin ?? undefined;
    if (!h) return { overlay: origin === undefined ? {} : { origin }, card: null };
    switch (this.tool) {
      case 'aerial':
      case 'underground':
        return this.cableView(state, this.tool, h.x, h.y);
      case 'cabinet':
        return cabinetView(state, nearestNode(state.city, h.x, h.y), this.touch);
      case 'remove':
        return removeView(state, h.x, h.y, this.touch);
      case 'inspect':
        return inspectView(state, h.x, h.y);
    }
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
          hint: `${this.touch ? 'Tap' : 'Click'} a corner to start the run. Fiber must reach back to the CO.`,
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
    const rows: CardRow[] = [
      { label: 'Length', value: `${formatFeet(quote.lengthFt)} · ${plural(quote.newSegments.length, 'span')}` },
      { label: 'Cost', value: formatMoney(quote.cost) },
      {
        label: method === 'aerial' ? 'Make-ready' : 'Permit',
        value: formatDayRange(quote.permitDaysMin, quote.permitDaysMax),
      },
      { label: 'Build', value: plural(quote.constructDays, 'day') },
    ];
    return {
      overlay: { origin, snap, path: { segments: path, fresh: quote.newSegments, method, ok: quote.ok } },
      card: {
        title,
        tone: method,
        rows,
        blockers: quote.reasons,
        hint: this.touch
          ? quote.ok
            ? 'Tap this corner again to order'
            : 'Tap another corner, or pick another tool to stop'
          : quote.ok
            ? 'Click to order · Esc to stop'
            : 'Esc to stop',
      },
    };
  }
}

function cabinetView(state: GameState, node: NodeId, touch: boolean): ToolView {
  const quote = quoteCabinet(state, node);
  return {
    overlay: { snap: node, cabinet: { node, ok: quote.ok } },
    card: {
      title: 'Cabinet',
      tone: 'cabinet',
      rows: [
        { label: 'At', value: cornerLabel(state, node) },
        { label: 'Cost', value: formatMoney(quote.cost) },
        { label: 'Permit', value: plural(quote.permitDays, 'day') },
        { label: 'Build', value: plural(quote.constructDays, 'day') },
        { label: 'Splitter', value: `1:${SPLIT_RATIO}, uses 1 PON port` },
      ],
      blockers: quote.reasons,
      hint: quote.ok ? `${touch ? 'Tap again' : 'Click'} to place. It lights streets once cable joins it to the CO.` : undefined,
    },
  };
}

function removableSegment(state: GameState, x: number, y: number): SegmentId | null {
  const seg = nearestSegment(state.city, x, y, REMOVE_PICK);
  return seg !== null && spanOnSegment(state, seg) ? seg : null;
}

function removeView(state: GameState, x: number, y: number, touch: boolean): ToolView {
  const seg = removableSegment(state, x, y);
  const span = seg === null ? undefined : spanOnSegment(state, seg);
  if (seg === null || !span) return { overlay: {}, card: null };
  const name = state.city.segments[seg]?.name ?? 'street';
  const refund = span.stage === 'permitting';
  return {
    overlay: { segment: { id: seg, tone: 'remove' } },
    card: {
      title: `Remove cable on ${name}`,
      tone: 'remove',
      rows: [
        { label: 'Cable', value: `${METHOD_LABEL[span.method]}, ${formatStage(span.stage, span.stageDaysLeft).toLowerCase()}` },
        { label: 'Refund', value: refund ? formatMoney(span.cost) : 'No refund' },
      ],
      blockers: [],
      hint:
        (refund ? 'Still permitting: cancelling refunds it in full.' : 'Crews have started, so removing it refunds nothing.') +
        (touch ? ' Tap again to remove.' : ''),
    },
  };
}

function inspectView(state: GameState, x: number, y: number): ToolView {
  const { city, network } = state;
  const service = getService(state);
  const node = nearestNode(city, x, y);
  const n = city.nodes[node];
  const nearNode = n ? Math.hypot(n.x - x, n.y - y) <= NODE_PICK : false;

  if (nearNode && node === city.coNode) {
    const used = network.cabinets.reduce((sum, c) => sum + c.splitters, 0);
    const here = network.cabinets.find((c) => c.node === node);
    const liveFt = network.spans
      .filter((s) => s.stage === 'live')
      .reduce((sum, s) => sum + (city.segments[s.segment]?.lengthFt ?? 0), 0);
    const rows: CardRow[] = [
      { label: 'OLT', value: `${network.olt.tech === 'gpon' ? 'GPON' : 'XGS-PON'}, ${plural(network.olt.ponPorts, 'PON port')}` },
      { label: 'Ports in use', value: `${formatNumber(used)} of ${formatNumber(network.olt.ponPorts)}` },
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
        hint: 'All fiber starts here.',
      },
    };
  }

  const cabinet = nearNode ? network.cabinets.find((c) => c.node === node) : undefined;
  if (cabinet) {
    return {
      overlay: {},
      card: {
        title: 'Cabinet',
        tone: 'cabinet',
        rows: [
          { label: 'At', value: cornerLabel(state, node) },
          { label: 'Status', value: cabinetStatus(cabinet, service) },
          { label: 'Splitters', value: `${cabinet.splitters} × 1:${SPLIT_RATIO}` },
          { label: 'Ordered', value: formatDate(cabinet.orderedDay) },
        ],
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
            service.litSegments.has(seg) ? ', lit' : ''
          }`
        : 'None yet';
      return {
        overlay: { segment: { id: seg, tone: 'inspect' } },
        card: {
          title: s.name,
          tone: span ? span.method : 'info',
          rows: [
            { label: 'Street', value: `${CLASS_LABEL[s.streetClass]}, ${formatFeet(s.lengthFt)}` },
            { label: 'Poles', value: poles > 0 ? `${poles}` : 'None (underground only)' },
            { label: 'Ground', value: s.rock ? 'Rock (underground costs double)' : 'Soil' },
            { label: 'Cable', value: cable },
          ],
          blockers: [],
        },
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
      const units = p.kind === 'mdu' ? plural(p.units, 'unit') : p.kind === 'smb' ? '1 business' : '1 household';
      return {
        overlay: { parcel: p.id },
        card: {
          title: KIND_LABEL[p.kind],
          tone: 'info',
          rows: [
            { label: 'Size', value: units },
            { label: 'Fiber', value: passed ? 'Passed, ready for service' : 'Unserved' },
            { label: 'Street', value: city.segments[p.segment]?.name ?? '' },
          ],
          blockers: [],
        },
      };
    }
  }
  return { overlay: {}, card: null };
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
