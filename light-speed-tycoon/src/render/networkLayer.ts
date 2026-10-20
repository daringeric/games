// Player-built plant: cable spans in their build stages, poles, cabinets and
// stage markers. Redrawn only when network.version changes; the marching
// construction stripes and cabinet glow live in small render groups of their
// own so animating them never re-batches the rest of the map. A cabinet's glow
// pulses for a few seconds when it lights up and then holds steady, so a
// finished network costs no frames while the map sits idle.
//
// Live cable (tubes, highlights and their poles) is most of the geometry in a
// built-out town and the costliest to tessellate, so it has a Graphics of its
// own, redrawn only when the set of live spans changes: an order, a permit or
// a cabinet coming through leaves it alone.
//
// Two containers: `below` (cables and markers) sits under the central office
// so cables run in beneath it; `above` (cabinets) sits over it so a cabinet at
// the CO stays visible.

import { Container, Graphics } from 'pixi.js';
import { polesOnSegment } from '../sim/streets';
import type { CableMethod, CableSpan, City, GameState, NodeId, ServiceSnapshot } from '../sim/types';
import { addDashes, highlightLine, midpoint, pointsAlong, segmentLine, strokeLines } from './shapes';
import type { Line } from './shapes';
import type { Theme } from './theme';

/** Where a cabinet is drawn: on its corner, or tucked on the CO's front corner when it stands at the CO. */
export function cabinetCenter(city: City, node: NodeId, theme: Theme): { x: number; y: number } {
  const n = city.nodes[node];
  const x = (n?.x ?? 0) * theme.cell;
  const y = (n?.y ?? 0) * theme.cell;
  if (node !== city.coNode) return { x, y };
  return { x: x + theme.co.width / 2 - 3, y: y + theme.co.height / 2 - 1 };
}

/** How long a newly active cabinet's glow pulses before it settles. */
export const GLOW_PULSE_MS = 4000;
const GLOW_STEADY_ALPHA = 0.5;

export class NetworkLayer {
  readonly below = new Container({ isRenderGroup: true });
  readonly above = new Container({ isRenderGroup: true });
  private readonly live = new Graphics();
  private readonly cables = new Graphics();
  private readonly stripeGroup = new Container({ isRenderGroup: true });
  private readonly stripes = new Graphics();
  private readonly glowGroup = new Container({ isRenderGroup: true });
  private readonly glow = new Graphics();
  private readonly markers = new Graphics();
  private readonly cabinets = new Graphics();
  private constructing: { line: Line; method: CableMethod }[] = [];
  /** When each active cabinet was first seen active (performance.now ms), for this game. */
  private activeSince = new Map<number, number>();
  private game: GameState | null = null;
  /** The glow pulses until this time; afterwards it is drawn steady once and left alone. */
  private pulseUntil = -Infinity;
  private glowSettled = true;
  /** Ids of the live spans `live` shows, or null when it must be redrawn. */
  private liveKey: string | null = null;
  /** Live spans drawn, and how many times the live cable has been redrawn (debug and test read-outs). */
  liveSpans = 0;
  liveRedraws = 0;

  constructor(private readonly theme: Theme) {
    this.stripeGroup.addChild(this.stripes);
    this.glowGroup.addChild(this.glow);
    this.below.addChild(this.live, this.cables, this.stripeGroup, this.markers);
    this.above.addChild(this.glowGroup, this.cabinets);
  }

  sync(state: GameState, service: ServiceSnapshot, now = performance.now()): void {
    const { city, network } = state;
    if (state !== this.game) {
      // Cabinet and span ids restart in another game.
      this.game = state;
      this.activeSince.clear();
      this.liveKey = null;
    }
    const theme = this.theme;
    const { cable } = theme;
    for (const g of [this.cables, this.markers, this.cabinets, this.glow]) g.clear();

    const byStage = { permitting: [] as CableSpan[], constructing: [] as CableSpan[], live: [] as CableSpan[] };
    for (const span of network.spans) byStage[span.stage].push(span);
    const lineOf = (s: CableSpan) => segmentLine(city, s.segment, theme);
    const ofMethod = (spans: CableSpan[], method: CableMethod) => spans.filter((s) => s.method === method).map(lineOf);

    // Permitting: faint dashed plan in the method's color.
    for (const method of ['underground', 'aerial'] as const) {
      const lines = ofMethod(byStage.permitting, method);
      let dashes = 0;
      for (const l of lines) dashes += addDashes(this.cables, l, cable.permitting.dash, cable.permitting.gap, 2);
      if (dashes > 0) {
        this.cables.stroke({ width: cable.permitting.width, color: cable[method].tube, alpha: cable.permitting.alpha, cap: 'round' });
      }
    }

    // Constructing: orange tube at the method's width; stripes are animated.
    this.constructing = byStage.constructing.map((s) => ({ line: lineOf(s), method: s.method }));
    for (const method of ['underground', 'aerial'] as const) {
      const lines = ofMethod(byStage.constructing, method);
      strokeLines(this.cables, lines, { width: cable[method].width, color: cable.constructing.tube, cap: 'round', join: 'round' });
    }

    // Live: candy tubes with a highlight stripe, redrawn only when the live set changes.
    // A span's segment and method never change, so its id stands for its drawing.
    const liveKey = byStage.live.map((s) => s.id).join(',');
    if (liveKey !== this.liveKey) {
      this.liveKey = liveKey;
      this.liveRedraws++;
      this.live.clear();
      this.liveSpans = 0;
      for (const method of ['underground', 'aerial'] as const) {
        const style = cable[method];
        const lines = ofMethod(byStage.live, method);
        this.liveSpans += lines.length;
        strokeLines(this.live, lines, { width: style.width, color: style.tube, cap: 'round', join: 'round' });
        const shine = lines.map((l) => highlightLine(l, style.width * 0.18, style.width * 0.6));
        strokeLines(this.live, shine, { width: Math.max(1.2, style.width * 0.3), color: style.highlight, cap: 'round' });
      }
      this.drawPoles(this.live, this.polesOf(city, byStage.live));
    }

    // Peg poles carry every aerial span that is being built (live ones are drawn with the live cable).
    this.drawPoles(this.cables, this.polesOf(city, byStage.constructing));

    for (const span of byStage.permitting) this.drawPermitBadge(midpoint(lineOf(span)), span.method);
    for (const span of byStage.constructing) this.drawCrewTruck(lineOf(span));

    this.drawCabinets(city, state, service, now);
    // Stripes for the new set of crews (or none, clearing finished ones).
    this.animate(now);
  }

  /** True while something on the map moves (construction stripes, a cabinet that just lit up). */
  get animating(): boolean {
    return this.constructing.length > 0 || !this.glowSettled;
  }

  /** Per-frame: march the construction stripes and pulse newly lit cabinet glows. */
  animate(ms: number): void {
    const { cable } = this.theme;
    const style = cable.constructing;
    this.stripes.clear();
    const phase = (ms / 1000) * style.stripeSpeed;
    for (const method of ['underground', 'aerial'] as const) {
      let dashes = 0;
      for (const c of this.constructing) {
        if (c.method === method) dashes += addDashes(this.stripes, c.line, style.stripeLength, style.stripeLength, 0, phase);
      }
      // Narrower than the tube so an orange rim frames each white stripe.
      if (dashes > 0) this.stripes.stroke({ width: cable[method].width - 2, color: style.stripe, cap: 'butt' });
    }
    if (ms < this.pulseUntil) {
      // Starts and ends at the steady alpha, so settling doesn't jump.
      const t = (this.pulseUntil - ms) / GLOW_PULSE_MS;
      this.glow.alpha = GLOW_STEADY_ALPHA + 0.3 * Math.sin(t * Math.PI * 3) * t;
    } else {
      this.glow.alpha = GLOW_STEADY_ALPHA;
      this.glowSettled = true;
    }
  }

  /** Pole positions along the aerial spans among `spans`. */
  private polesOf(city: City, spans: readonly CableSpan[]): { x: number; y: number }[] {
    const poles: { x: number; y: number }[] = [];
    for (const span of spans) {
      const seg = city.segments[span.segment];
      if (span.method === 'aerial' && seg) poles.push(...pointsAlong(segmentLine(city, seg, this.theme), polesOnSegment(seg)));
    }
    return poles;
  }

  private drawPoles(g: Graphics, points: { x: number; y: number }[]): void {
    const { aerial } = this.theme.cable;
    if (points.length === 0) return;
    for (const p of points) g.circle(p.x, p.y, aerial.poleRadius);
    g.fill(aerial.poleRim);
    for (const p of points) g.circle(p.x, p.y, aerial.poleRadius - 1.3);
    g.fill(aerial.pole);
  }

  /** White badge: an hourglass for aerial make-ready, a clipboard for an underground permit. */
  private drawPermitBadge(p: { x: number; y: number }, method: CableMethod): void {
    const g = this.markers;
    const { permitting } = this.theme.cable;
    const color = this.theme.cable[method].tube;
    const r = permitting.badgeRadius;
    g.circle(p.x + 0.8, p.y + 1.5, r).fill({ color: this.theme.house.shadow, alpha: 0.9 });
    g.circle(p.x, p.y, r).fill(permitting.badge).stroke({ width: 1.5, color });
    if (method === 'aerial') {
      const s = r * 0.55;
      g.poly([p.x - s * 0.8, p.y - s, p.x + s * 0.8, p.y - s, p.x, p.y]).fill(color);
      g.poly([p.x, p.y, p.x + s * 0.8, p.y + s, p.x - s * 0.8, p.y + s]).fill(color);
    } else {
      g.roundRect(p.x - 3, p.y - 3.4, 6, 7.6, 1.2).fill(color);
      g.roundRect(p.x - 1.7, p.y - 4.6, 3.4, 2.4, 0.8).fill(permitting.badge).stroke({ width: 1, color });
      g.moveTo(p.x - 1.6, p.y).lineTo(p.x + 1.6, p.y).moveTo(p.x - 1.6, p.y + 2).lineTo(p.x + 1.6, p.y + 2);
      g.stroke({ width: 0.9, color: permitting.badge });
    }
  }

  /** Little orange crew truck parked beside the trench mid-span, nose along the street. */
  private drawCrewTruck(l: Line): void {
    const g = this.markers;
    const { constructing } = this.theme.cable;
    const mid = midpoint(l);
    const horizontal = Math.abs(l.bx - l.ax) >= Math.abs(l.by - l.ay);
    const len = 20;
    const wid = 11;
    // Parked alongside rather than on the orange tube, where it would vanish.
    const off = this.theme.cable.underground.width / 2 + wid / 2 + 1;
    const p = horizontal ? { x: mid.x, y: mid.y + off } : { x: mid.x + off, y: mid.y };
    const w = horizontal ? len : wid;
    const h = horizontal ? wid : len;
    const x = p.x - w / 2;
    const y = p.y - h / 2;
    g.roundRect(x + 1, y + 2.5, w, h, 3).fill(this.theme.house.shadow);
    // Wheels peek out at the corners.
    const wheels: [number, number][] = horizontal
      ? [[x + 2.5, y - 1.5], [x + w - 6.5, y - 1.5], [x + 2.5, y + h - 2.5], [x + w - 6.5, y + h - 2.5]]
      : [[x - 1.5, y + 2.5], [x + w - 2.5, y + 2.5], [x - 1.5, y + h - 6.5], [x + w - 2.5, y + h - 6.5]];
    for (const [wx, wy] of wheels) g.rect(wx, wy, 4, 4);
    g.fill(constructing.crewWheel);
    g.roundRect(x, y, w, h, 3).fill(constructing.crew).stroke({ width: 1.2, color: constructing.crewWheel, alignment: 1 });
    const cab = horizontal ? { x: x + w - 7, y: y + 2, w: 5, h: h - 4 } : { x: x + 2, y: y + 2, w: w - 4, h: 5 };
    g.roundRect(cab.x, cab.y, cab.w, cab.h, 1.5).fill(constructing.crewCab);
    // Cable drum on the bed.
    const drum = horizontal ? { x: x + w * 0.36, y: p.y } : { x: p.x, y: y + h * 0.64 };
    g.circle(drum.x, drum.y, 3).fill(constructing.crewCab).stroke({ width: 1.2, color: constructing.crewWheel });
  }

  private drawCabinets(city: City, state: GameState, service: ServiceSnapshot, now: number): void {
    const { cabinet } = this.theme;
    const g = this.cabinets;
    const s = cabinet.size;
    for (const id of [...this.activeSince.keys()]) if (!service.activeCabinets.has(id)) this.activeSince.delete(id);
    for (const cab of state.network.cabinets) {
      const { x: cx, y: cy } = cabinetCenter(city, cab.node, this.theme);
      const x = cx - s / 2;
      const y = cy - s / 2;
      const active = service.activeCabinets.has(cab.id);
      g.roundRect(x + 1, y + 3, s, s, cabinet.radius).fill(this.theme.co.side);
      g.roundRect(x, y, s, s, cabinet.radius)
        .fill(active ? cabinet.body : cabinet.dimBody)
        .stroke({ width: 2.5, color: active ? cabinet.border : cabinet.dimBorder, alignment: 1 });
      g.circle(cx, cy, 3.4).fill(active ? cabinet.light : cabinet.dimLight);
      if (active) {
        this.glow.circle(cx, cy, s * 0.85).fill(cabinet.glow);
        if (!this.activeSince.has(cab.id)) {
          this.activeSince.set(cab.id, now);
          this.pulseUntil = now + GLOW_PULSE_MS;
          this.glowSettled = false;
        }
      }
    }
  }
}
