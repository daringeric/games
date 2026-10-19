// Tool feedback drawn over the map: cable run previews, the snapped node, a
// ghost cabinet, and hover highlights. Described by a plain OverlaySpec so tool
// logic stays free of Pixi; redrawn only when the spec changes.

import { Container, Graphics } from 'pixi.js';
import type { CableMethod, City, NodeId, ParcelId, SegmentId } from '../sim/types';
import { lotRect, streetLattice } from './geometry';
import { cabinetCenter } from './networkLayer';
import { highlightLine, segmentLine, strokeLines } from './shapes';
import type { Theme } from './theme';

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
}

/**
 * Two containers: `under` (route previews, street highlights) sits below the
 * central office so a planned run tucks in beneath it like real cable; `over`
 * (rings, ghost cabinet, lot outline) sits on top of everything.
 */
export class OverlayLayer {
  readonly under = new Container({ isRenderGroup: true });
  readonly over = new Container({ isRenderGroup: true });
  private readonly lines = new Graphics();
  private readonly marks = new Graphics();
  private key = '';

  constructor(private readonly theme: Theme) {
    this.under.addChild(this.lines);
    this.over.addChild(this.marks);
  }

  /** Redraw for a new spec; returns false when nothing changed. */
  draw(city: City, spec: OverlaySpec): boolean {
    const key = JSON.stringify(spec);
    if (key === this.key) return false;
    this.key = key;
    this.lines.clear();
    this.marks.clear();
    this.drawLines(city, spec);
    this.drawMarks(city, spec);
    return true;
  }

  /** Street highlight and the planned cable run. */
  private drawLines(city: City, spec: OverlaySpec): void {
    const g = this.lines;
    const theme = this.theme;
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

  /** Lot outline, ghost cabinet, and the origin/cursor rings. */
  private drawMarks(city: City, spec: OverlaySpec): void {
    const g = this.marks;
    const theme = this.theme;
    const c = theme.cell;
    if (spec.parcel !== undefined) {
      const p = city.parcels[spec.parcel];
      if (p) {
        const r = lotRect(streetLattice(city), p, theme);
        g.roundRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4, theme.lot.radius + 2).stroke({ width: 2.5, color: theme.overlay.snapFill });
      }
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
