// Tool feedback drawn over the map: cable run previews, the snapped node, a
// ghost cabinet, hover highlights, the cabinet tool's coverage shading and the
// building tells a planned route would serve. Described by a plain OverlaySpec
// so tool logic stays free of Pixi; each part is redrawn only when its piece
// of the spec changes (and nothing is compared when the spec object is the
// same one as last frame, which the tools' memoized view guarantees).

import { Container, Graphics } from 'pixi.js';
import type { CableMethod, CabinetId, City, NodeId, ParcelId, SegmentId, StreetClass } from '../sim/types';
import { dropPoint, lotRect, streetLattice } from './geometry';
import { cabinetCenter } from './networkLayer';
import { highlightLine, segmentLine, strokeLines } from './shapes';
import type { Line } from './shapes';
import type { Theme } from './theme';

/** A street inside a planned cabinet's reach. */
export interface ReachShade {
  id: SegmentId;
  /** Distance as a fraction of the reach: 0 at the cabinet, approaching 1 at the edge. */
  t: number;
  /** Another active cabinet already serves it (drawn as a muted hatch). */
  elsewhere: boolean;
}

/** One existing cabinet's coverage, shown while the cabinet tool is active. */
export interface CoverageShade {
  cabinet: CabinetId;
  /** Lit streets it serves (ServiceSnapshot.cabinetCoverage). */
  lit: readonly SegmentId[];
  /** Streets within its reach along streets (cable or not): a faint outline. */
  reach: readonly SegmentId[];
}

export interface OverlaySpec {
  /** Planned cable run; `fresh` are the segments that would get new cable. */
  path?: { segments: readonly SegmentId[]; fresh: readonly SegmentId[]; method: CableMethod; ok: boolean };
  /** Node a cable run starts from. */
  origin?: NodeId;
  /** Node under the cursor. */
  snap?: NodeId;
  cabinet?: { node: NodeId; ok: boolean };
  segment?: { id: SegmentId; tone: 'remove' | 'inspect' };
  parcel?: ParcelId;
  /** The street serving the hovered building (Parcel.segment). */
  serving?: SegmentId;
  /** A ring around an existing cabinet: a splitter target, or one the remove tool would take out. */
  ring?: { node: NodeId; tone: 'cabinet' | 'remove' };
  /** Cabinet placement preview: in-reach streets shaded by distance. */
  reach?: readonly ReachShade[];
  /** Existing cabinets' actual coverage (tinted per cabinet) and street reach (faint outline). */
  coverage?: readonly CoverageShade[];
  /** Buildings a planned route would serve: their drop points are emphasized. */
  served?: readonly ParcelId[];
  /** Buildings along a planned route that face another street: outlined in the blocked color. */
  wrongSide?: readonly ParcelId[];
}

/** Distance bands the reach shading is batched into (one stroke per band and street class). */
const REACH_BANDS = 4;
const CLASSES: readonly StreetClass[] = ['local', 'collector', 'arterial'];

/**
 * Two containers: `under` (coverage shading, route previews, street
 * highlights) sits below the central office so a planned run tucks in beneath
 * it like real cable; `over` (rings, ghost cabinet, lot outlines, drop points)
 * sits on top of everything.
 */
export class OverlayLayer {
  readonly under = new Container({ isRenderGroup: true });
  readonly over = new Container({ isRenderGroup: true });
  /** Existing cabinets' coverage: changes only with the network, not with the pointer. */
  private readonly context = new Graphics();
  private readonly lines = new Graphics();
  private readonly marks = new Graphics();
  private spec: OverlaySpec | null = null;
  private city: City | null = null;
  private contextKey = '';
  private key = '';
  /** Redraws of the coverage context (a test read-out). */
  contextRedraws = 0;

  constructor(private readonly theme: Theme) {
    this.under.addChild(this.context, this.lines);
    this.over.addChild(this.marks);
  }

  /** Redraw for a new spec; returns false when nothing changed. */
  draw(city: City, spec: OverlaySpec): boolean {
    if (spec === this.spec && city === this.city) return false;
    const cityChanged = city !== this.city;
    this.spec = spec;
    this.city = city;
    const { coverage, ...rest } = spec;
    const contextKey = coverage ? JSON.stringify(coverage) : '';
    const key = JSON.stringify(rest);
    let changed = false;
    if (cityChanged || contextKey !== this.contextKey) {
      this.contextKey = contextKey;
      this.context.clear();
      if (coverage) this.drawCoverage(city, coverage);
      this.contextRedraws++;
      changed = true;
    }
    if (cityChanged || key !== this.key) {
      this.key = key;
      this.lines.clear();
      this.marks.clear();
      this.drawLines(city, rest);
      this.drawMarks(city, rest);
      changed = true;
    }
    return changed;
  }

  /** Existing cabinets: lit streets tinted per cabinet, and a faint outline along the streets each could reach. */
  private drawCoverage(city: City, coverage: readonly CoverageShade[]): void {
    const g = this.context;
    const { road, coverage: style } = this.theme;
    const tints = style.tints.length > 0 ? style.tints : [this.theme.cabinet.light];
    const outlines: Line[][] = tints.map(() => []);
    const lit: Line[][] = tints.map(() => []);
    coverage.forEach((cab, i) => {
      const t = i % tints.length;
      for (const id of cab.reach) {
        const seg = city.segments[id];
        if (!seg) continue;
        const l = segmentLine(city, seg, this.theme);
        const off = road.width[seg.streetClass] / 2 + 2.5;
        outlines[t]?.push(offsetLine(l, off), offsetLine(l, -off));
      }
      for (const id of cab.lit) if (city.segments[id]) lit[t]?.push(segmentLine(city, id, this.theme));
    });
    tints.forEach((color, t) => {
      strokeLines(g, outlines[t] ?? [], { width: 1.6, color, alpha: style.outlineAlpha, cap: 'butt' });
      strokeLines(g, lit[t] ?? [], { width: road.width.arterial - 4, color, alpha: style.tintAlpha, cap: 'round', join: 'round' });
    });
  }

  /** Reach shading, street highlights and the planned cable run. */
  private drawLines(city: City, spec: OverlaySpec): void {
    const g = this.lines;
    const theme = this.theme;
    if (spec.reach) this.drawReach(city, spec.reach);
    if (spec.serving !== undefined && city.segments[spec.serving]) {
      const line = segmentLine(city, spec.serving, theme);
      strokeLines(g, [line], { width: theme.road.width.arterial + 6, color: theme.overlay.snapFill, alpha: 0.6, cap: 'round' });
      strokeLines(g, [line], { width: 4, color: theme.overlay.snapRing, alpha: 0.85, cap: 'round' });
    }
    if (spec.segment) {
      const line = segmentLine(city, spec.segment.id, theme);
      const remove = spec.segment.tone === 'remove';
      strokeLines(g, [line], {
        width: theme.road.width.arterial + 6,
        color: remove ? theme.overlay.remove : theme.overlay.snapFill,
        alpha: remove ? 0.38 : 0.55,
        cap: 'round',
      });
    }
    if (spec.path) {
      const { method, ok } = spec.path;
      const style = theme.cable[method];
      const fresh = new Set(spec.path.fresh);
      const lines = spec.path.segments.filter((s) => fresh.has(s)).map((s) => segmentLine(city, s, theme));
      const reused = spec.path.segments.filter((s) => !fresh.has(s)).map((s) => segmentLine(city, s, theme));
      // Opaque strokes: translucent ones double up where round caps overlap at corners.
      // Already-cabled stretches the route rides along get a light outline only.
      strokeLines(g, reused, { width: style.width + 6, color: theme.overlay.snapFill, alpha: 0.6, cap: 'round', join: 'round' });
      strokeLines(g, lines, { width: style.width + 5, color: theme.overlay.snapFill, cap: 'round', join: 'round' });
      strokeLines(g, lines, { width: style.width, color: ok ? style.tube : theme.overlay.blocked, cap: 'round', join: 'round' });
      const shine = lines.map((l) => highlightLine(l, style.width * 0.18, style.width * 0.6));
      if (ok) strokeLines(g, shine, { width: Math.max(1.2, style.width * 0.3), color: style.highlight, cap: 'round' });
    }
  }

  /** In-reach streets shaded strongest near the cabinet; streets another cabinet serves get a muted hatch. */
  private drawReach(city: City, reach: readonly ReachShade[]): void {
    const g = this.lines;
    const { road, coverage: style } = this.theme;
    const bands = new Map<string, Line[]>();
    const hatch: Line[] = [];
    for (const r of reach) {
      const seg = city.segments[r.id];
      if (!seg) continue;
      const line = segmentLine(city, seg, this.theme);
      if (r.elsewhere) {
        addHatch(hatch, line, road.width[seg.streetClass] / 2 + 1, 7);
        continue;
      }
      const band = Math.min(REACH_BANDS - 1, Math.max(0, Math.floor(r.t * REACH_BANDS)));
      const key = `${band}|${seg.streetClass}`;
      let list = bands.get(key);
      if (!list) bands.set(key, (list = []));
      list.push(line);
    }
    for (let band = 0; band < REACH_BANDS; band++) {
      const alpha = style.reachAlphaNear + ((style.reachAlphaFar - style.reachAlphaNear) * band) / (REACH_BANDS - 1);
      for (const cls of CLASSES) {
        strokeLines(g, bands.get(`${band}|${cls}`) ?? [], { width: road.width[cls] + 4, color: style.reach, alpha, cap: 'butt' });
      }
    }
    strokeLines(g, hatch, { width: 2, color: style.elsewhere, alpha: 0.8, cap: 'round' });
  }

  /** Lot outlines, drop points, ghost cabinet, cabinet ring, and the origin/cursor rings. */
  private drawMarks(city: City, spec: OverlaySpec): void {
    const g = this.marks;
    const theme = this.theme;
    const c = theme.cell;
    const lattice = streetLattice(city);
    if (spec.wrongSide && spec.wrongSide.length > 0) {
      for (const id of spec.wrongSide) {
        const p = city.parcels[id];
        if (!p) continue;
        const r = lotRect(lattice, p, theme);
        g.roundRect(r.x - 1.5, r.y - 1.5, r.w + 3, r.h + 3, theme.lot.radius + 1.5);
      }
      g.stroke({ width: 2.2, color: theme.overlay.blocked, alpha: 0.9 });
    }
    if (spec.served && spec.served.length > 0) {
      const points = spec.served.flatMap((id) => {
        const p = city.parcels[id];
        return p ? [dropPoint(city, lattice, p, theme)] : [];
      });
      for (const pt of points) g.circle(pt.x, pt.y, 4.2);
      if (points.length > 0) g.fill({ color: theme.overlay.snapFill, alpha: 0.95 });
      for (const pt of points) g.circle(pt.x, pt.y, 4.2);
      if (points.length > 0) g.stroke({ width: 2, color: theme.demarc.emphasis });
    }
    if (spec.parcel !== undefined) {
      const p = city.parcels[spec.parcel];
      if (p) {
        const r = lotRect(lattice, p, theme);
        g.roundRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4, theme.lot.radius + 2).stroke({ width: 2.5, color: theme.overlay.snapFill });
      }
    }
    if (spec.ring && city.nodes[spec.ring.node]) {
      const { x: cx, y: cy } = cabinetCenter(city, spec.ring.node, theme);
      const s = theme.cabinet.size + 12;
      g.roundRect(cx - s / 2, cy - s / 2, s, s, theme.cabinet.radius + 6)
        .fill({ color: theme.overlay.snapFill, alpha: 0.25 })
        .stroke({ width: 3, color: spec.ring.tone === 'remove' ? theme.overlay.remove : theme.overlay.snapRing });
    }
    if (spec.cabinet) {
      const { x: cx, y: cy } = cabinetCenter(city, spec.cabinet.node, theme);
      const s = theme.cabinet.size;
      g.roundRect(cx - s / 2, cy - s / 2, s, s, theme.cabinet.radius)
        .fill({ color: theme.cabinet.body, alpha: 0.6 })
        .stroke({ width: 2.5, color: spec.cabinet.ok ? theme.cabinet.border : theme.overlay.blocked, alignment: 1 });
      g.circle(cx, cy, 3.4).fill({ color: theme.cabinet.light, alpha: 0.8 });
    }
    for (const [id, ring] of [
      [spec.origin, theme.cable.underground.tube],
      [spec.snap, theme.overlay.snapRing],
    ] as const) {
      const node = id === undefined ? undefined : city.nodes[id];
      if (!node) continue;
      if (id === city.coNode) {
        // Ring the whole building rather than covering its label.
        const { co } = theme;
        const pad = 5;
        const x = node.x * c - co.width / 2 - pad;
        const y = node.y * c - co.height / 2 - co.depth / 2 - pad;
        g.roundRect(x, y, co.width + 2 * pad, co.height + co.depth + 2 * pad, co.radius + pad).stroke({ width: 3, color: ring });
        continue;
      }
      g.circle(node.x * c, node.y * c, 8.5).fill({ color: theme.overlay.snapFill, alpha: 0.9 }).stroke({ width: 3, color: ring });
      g.circle(node.x * c, node.y * c, 2.6).fill(ring);
    }
  }
}

/** The line shifted sideways by `d` (positive: to the right of a -> b on screen). */
function offsetLine(l: Line, d: number): Line {
  const len = Math.hypot(l.bx - l.ax, l.by - l.ay) || 1;
  const nx = -(l.by - l.ay) / len;
  const ny = (l.bx - l.ax) / len;
  return { ax: l.ax + nx * d, ay: l.ay + ny * d, bx: l.bx + nx * d, by: l.by + ny * d };
}

/** Diagonal ticks across a street every `step` px, `half` px either side of its centre line. */
function addHatch(out: Line[], l: Line, half: number, step: number): void {
  const len = Math.hypot(l.bx - l.ax, l.by - l.ay);
  if (len <= 0) return;
  const ux = (l.bx - l.ax) / len;
  const uy = (l.by - l.ay) / len;
  const nx = -uy;
  const ny = ux;
  const lean = half * 0.7;
  for (let t = step / 2; t < len; t += step) {
    const x = l.ax + ux * t;
    const y = l.ay + uy * t;
    out.push({ ax: x - nx * half - ux * lean, ay: y - ny * half - uy * lean, bx: x + nx * half + ux * lean, by: y + ny * half + uy * lean });
  }
}
