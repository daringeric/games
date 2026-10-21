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
//
// Cabinets carry a splitter-count badge, and a red ring while they are turning
// signups away (Sales.fullCabinets). Live cable that reaches the CO but lies
// beyond every cabinet's reach is washed out: it lights nothing.
//
// Round 4: a span out of service (storm or dig-in damage) is drawn broken: its
// tube washed out under red dashes, with a red bolt badge; the dashes and
// badges pulse in a render group of their own (an alpha change per frame, no
// redraw). An aerial span being rebuilt underground shows the planned bore
// dashed beside it in the underground color, with the permit clipboard while
// permitting and the crew truck while crews dig. StormLayer draws the areas
// of recent storms as translucent clouds with a lightning badge, fading by
// age, redrawn only when the set of storms shown or their ages change.

import { Container, Graphics, Text } from 'pixi.js';
import { STORM_SHOW_DAYS } from '../sim/balance';
import { polesOnSegment } from '../sim/streets';
import type { CableMethod, CableSpan, CabinetId, City, GameState, NodeId, ServiceSnapshot, Storm } from '../sim/types';
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
  /** Out-of-service dashes and bolt badges: pulsed by alpha in animate(). */
  private readonly outageGroup = new Container({ isRenderGroup: true });
  private readonly outageMarks = new Graphics();
  private readonly cabinets = new Graphics();
  /** Splitter-count labels, one per cabinet, reused across redraws. */
  private readonly badges = new Container();
  private badgeTexts: Text[] = [];
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
  /** Live spans drawn washed out (connected to the CO, out of every cabinet's reach), and cabinets ringed as full. */
  dimSpans = 0;
  fullRings = 0;
  /** Live spans drawn out of service, and aerial spans drawn being rebuilt underground. */
  outageSpans = 0;
  rebuildSpans = 0;

  constructor(private readonly theme: Theme) {
    this.stripeGroup.addChild(this.stripes);
    this.glowGroup.addChild(this.glow);
    this.outageGroup.addChild(this.outageMarks);
    this.below.addChild(this.live, this.cables, this.stripeGroup, this.markers, this.outageGroup);
    this.above.addChild(this.glowGroup, this.cabinets, this.badges);
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
    for (const g of [this.cables, this.markers, this.cabinets, this.glow, this.outageMarks]) g.clear();

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
    // A span's segment never changes and its method only when an underground
    // rebuild finishes, so its id and method stand for its drawing.
    const liveKey = byStage.live.map((s) => (s.method === 'aerial' ? s.id : -s.id)).join(',');
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

    // Live cable that reaches the CO but no cabinet's reach lights nothing: wash it out.
    this.dimSpans = 0;
    for (const method of ['underground', 'aerial'] as const) {
      const dim = byStage.live.filter(
        (s) => s.method === method && service.connectedSegments.has(s.segment) && !service.litSegments.has(s.segment),
      );
      this.dimSpans += dim.length;
      strokeLines(this.cables, dim.map(lineOf), { width: cable[method].width + 1.5, color: cable.dim.color, alpha: cable.dim.alpha, cap: 'round', join: 'round' });
    }

    // Peg poles carry every aerial span that is being built (live ones are drawn with the live cable).
    this.drawPoles(this.cables, this.polesOf(city, byStage.constructing));

    // Underground rebuilds of live aerial spans: the planned bore, dashed beside the aerial cable.
    const rebuilding = byStage.live.filter((s) => s.conversion !== null);
    this.rebuildSpans = rebuilding.length;
    const { rebuild } = cable;
    let bores = 0;
    for (const span of rebuilding) bores += addDashes(this.cables, offsetLine(lineOf(span), rebuild.offset), rebuild.dash, rebuild.gap, 2);
    if (bores > 0) this.cables.stroke({ width: rebuild.width, color: cable.underground.tube, alpha: rebuild.alpha, cap: 'round' });

    // Out of service: the tube washed out under pulsing red dashes, with a bolt badge.
    const out = byStage.live.filter((s) => s.outage !== null);
    this.outageSpans = out.length;
    const { cut } = cable;
    for (const method of ['underground', 'aerial'] as const) {
      const lines = out.filter((s) => s.method === method).map(lineOf);
      strokeLines(this.cables, lines, { width: cable[method].width + 2, color: cut.wash, alpha: cut.washAlpha, cap: 'round', join: 'round' });
      let dashes = 0;
      for (const l of lines) dashes += addDashes(this.outageMarks, l, cut.dash, cut.gap, 2);
      if (dashes > 0) this.outageMarks.stroke({ width: Math.max(3, cable[method].width - 1), color: cut.burst, cap: 'round' });
    }

    for (const span of byStage.permitting) this.drawPermitBadge(midpoint(lineOf(span)), span.method);
    for (const span of byStage.constructing) this.drawCrewTruck(lineOf(span));
    for (const span of rebuilding) {
      const line = lineOf(span);
      if (span.conversion?.stage === 'constructing') this.drawCrewTruck(line);
      else this.drawPermitBadge(alongLine(line, 0.25), 'underground');
    }
    for (const span of out) this.drawOutageBadge(midpoint(lineOf(span)));

    this.drawCabinets(city, state, service, now);
    // Stripes for the new set of crews (or none, clearing finished ones).
    this.animate(now);
  }

  /** True while something on the map moves (construction stripes, a cabinet that just lit up, a span out of service). */
  get animating(): boolean {
    return this.constructing.length > 0 || !this.glowSettled || this.outageSpans > 0;
  }

  /** Per-frame: march the construction stripes, pulse newly lit cabinet glows and out-of-service marks. */
  animate(ms: number): void {
    const { cable } = this.theme;
    if (this.outageSpans > 0) {
      const t = (ms % cable.cut.pulseMs) / cable.cut.pulseMs;
      this.outageGroup.alpha = 0.55 + 0.45 * (0.5 + 0.5 * Math.cos(t * Math.PI * 2));
    } else {
      this.outageGroup.alpha = 1;
    }
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

  /** Red badge with a white bolt and yellow sparks: this span is out of service. */
  private drawOutageBadge(p: { x: number; y: number }): void {
    const g = this.outageMarks;
    const { cut } = this.theme.cable;
    const r = cut.badgeRadius;
    // Sparks first, so the badge sits on top of them.
    for (const [dx, dy] of [
      [1, -1],
      [1, 1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      g.moveTo(p.x + dx * r * 0.85, p.y + dy * r * 0.85).lineTo(p.x + dx * r * 1.45, p.y + dy * r * 1.45);
    }
    g.stroke({ width: 2, color: cut.spark, cap: 'round' });
    g.circle(p.x + 0.8, p.y + 1.5, r).fill({ color: this.theme.house.shadow, alpha: 0.9 });
    g.circle(p.x, p.y, r).fill(cut.burst).stroke({ width: 1.8, color: cut.core });
    const s = r * 0.62;
    g.poly([p.x + s * 0.15, p.y - s, p.x - s * 0.55, p.y + s * 0.12, p.x - s * 0.02, p.y + s * 0.12, p.x - s * 0.2, p.y + s, p.x + s * 0.58, p.y - s * 0.18, p.x + s * 0.05, p.y - s * 0.18]).fill(cut.core);
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
    const full = new Set<CabinetId>(state.sales?.fullCabinets ?? []);
    this.fullRings = 0;
    for (const id of [...this.activeSince.keys()]) if (!service.activeCabinets.has(id)) this.activeSince.delete(id);
    state.network.cabinets.forEach((cab, i) => {
      const { x: cx, y: cy } = cabinetCenter(city, cab.node, this.theme);
      const x = cx - s / 2;
      const y = cy - s / 2;
      const active = service.activeCabinets.has(cab.id);
      if (full.has(cab.id)) {
        // Turning signups away: a red ring, so the player knows where to add a splitter.
        g.roundRect(x - 5, y - 5, s + 10, s + 10, cabinet.radius + 5).stroke({ width: 3, color: cabinet.full });
        this.fullRings++;
      }
      g.roundRect(x + 1, y + 3, s, s, cabinet.radius).fill(this.theme.co.side);
      g.roundRect(x, y, s, s, cabinet.radius)
        .fill(active ? cabinet.body : cabinet.dimBody)
        .stroke({ width: 2.5, color: active ? cabinet.border : cabinet.dimBorder, alignment: 1 });
      g.circle(cx, cy, 3.4).fill(active ? cabinet.light : cabinet.dimLight);
      this.drawBadge(i, cx + s / 2 - 1, cy - s / 2 + 1, cab.splitters);
      if (active) {
        this.glow.circle(cx, cy, s * 0.85).fill(cabinet.glow);
        if (!this.activeSince.has(cab.id)) {
          this.activeSince.set(cab.id, now);
          this.pulseUntil = now + GLOW_PULSE_MS;
          this.glowSettled = false;
        }
      }
    });
    // Drop the labels of cabinets that are gone.
    for (const text of this.badgeTexts.splice(state.network.cabinets.length)) text.destroy();
  }

  /** Dark disc on the cabinet's corner with its splitter count. */
  private drawBadge(index: number, x: number, y: number, splitters: number): void {
    const { cabinet, fonts } = this.theme;
    const r = cabinet.badgeRadius;
    this.cabinets.circle(x, y, r + 1.2).fill(cabinet.border);
    this.cabinets.circle(x, y, r).fill(cabinet.badge);
    let text = this.badgeTexts[index];
    if (!text) {
      text = new Text({
        text: '',
        style: { fontFamily: `${fonts.display}, ${fonts.ui}, sans-serif`, fontWeight: '700', fontSize: 10, fill: cabinet.badgeText },
        // Rendered large so it stays crisp when zoomed in.
        resolution: 4,
      });
      text.anchor.set(0.5);
      this.badgeTexts[index] = text;
      this.badges.addChild(text);
    }
    const label = String(splitters);
    if (text.text !== label) text.text = label;
    text.position.set(x, y + 0.5);
  }
}

/** The line shifted sideways by `d`: horizontal lines down, vertical ones right (the planned bore beside a cable). */
function offsetLine(l: Line, d: number): Line {
  const horizontal = Math.abs(l.bx - l.ax) >= Math.abs(l.by - l.ay);
  return horizontal ? { ...l, ay: l.ay + d, by: l.by + d } : { ...l, ax: l.ax + d, bx: l.bx + d };
}

/** The point `t` (0..1) of the way along a line. */
function alongLine(l: Line, t: number): { x: number; y: number } {
  return { x: l.ax + (l.bx - l.ax) * t, y: l.ay + (l.by - l.ay) * t };
}

/** Storms the map shows today: those that hit within STORM_SHOW_DAYS days, oldest first. */
export function stormsToShow(state: GameState): Storm[] {
  return (state.weather?.storms ?? []).filter((s) => s.day <= state.day && state.day - s.day < STORM_SHOW_DAYS);
}

/** How strongly a storm `age` days old is drawn: 1 the day it hit, fading toward 0 at STORM_SHOW_DAYS. */
export function stormFade(age: number): number {
  return Math.max(0, Math.min(1, 1 - age / STORM_SHOW_DAYS));
}

/**
 * The areas of recent storms: translucent cloud discs (`under`, beneath the
 * cables, so damage stays crisp) and their lightning badges (`over`, above
 * cabinets). Redrawn only when the storms shown or their ages change.
 */
export class StormLayer {
  readonly under = new Container({ isRenderGroup: true });
  readonly over = new Container({ isRenderGroup: true });
  private readonly discs = new Graphics();
  private readonly badges = new Graphics();
  private key: string | null = null;
  private game: GameState | null = null;
  /** Storms drawn (debug and test read-out). */
  shown = 0;
  redraws = 0;

  constructor(private readonly theme: Theme) {
    this.under.addChild(this.discs);
    this.over.addChild(this.badges);
  }

  /** Bring the clouds up to date; true when anything was redrawn. */
  sync(state: GameState): boolean {
    const storms = stormsToShow(state);
    const key = storms.map((s) => `${s.id}:${state.day - s.day}`).join(',');
    if (state === this.game && key === this.key) return false;
    this.game = state;
    this.key = key;
    this.redraws++;
    this.discs.clear();
    this.badges.clear();
    const { cell, storm } = this.theme;
    for (const s of storms) {
      const fade = stormFade(state.day - s.day);
      const x = s.x * cell;
      const y = s.y * cell;
      const r = Math.max(1, s.radius) * cell;
      this.discs.circle(x, y, r).fill({ color: storm.cloud, alpha: storm.alpha * fade });
      this.discs.circle(x, y, r).stroke({ width: 4, color: storm.rim, alpha: storm.rimAlpha * fade });
      this.drawBadge(x, y, Math.max(0.35, fade));
    }
    this.shown = storms.length;
    return true;
  }

  /** A puffy cloud with a yellow bolt under it. */
  private drawBadge(x: number, y: number, alpha: number): void {
    const g = this.badges;
    const { storm, house } = this.theme;
    const r = storm.badgeRadius;
    const puffs: [number, number, number][] = [
      [-r * 0.55, r * 0.1, r * 0.55],
      [0, -r * 0.2, r * 0.72],
      [r * 0.6, r * 0.12, r * 0.5],
    ];
    for (const [dx, dy, pr] of puffs) g.circle(x + dx + 1, y + dy + 2, pr);
    g.fill({ color: house.shadow, alpha });
    for (const [dx, dy, pr] of puffs) g.circle(x + dx, y + dy, pr + 1.6);
    g.fill({ color: storm.badgeRim, alpha });
    for (const [dx, dy, pr] of puffs) g.circle(x + dx, y + dy, pr);
    g.fill({ color: storm.badge, alpha });
    const s = r * 0.7;
    const by = y + r * 0.35;
    g.poly([x + s * 0.2, by - s * 0.4, x - s * 0.45, by + s * 0.45, x - s * 0.02, by + s * 0.45, x - s * 0.25, by + s * 1.2, x + s * 0.5, by + s * 0.25, x + s * 0.06, by + s * 0.25])
      .fill({ color: storm.bolt, alpha })
      .stroke({ width: 1, color: storm.badgeRim, alpha });
  }
}
