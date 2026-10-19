// Small Pixi drawing helpers shared by the map layers. Everything is batched:
// callers add many sub-paths and then fill/stroke once per style.

import type { Graphics, StrokeInput } from 'pixi.js';
import type { City, SegmentId, StreetSegment } from '../sim/types';
import type { Theme } from './theme';

export interface Line {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

/** World-pixel endpoints of a segment. */
export function segmentLine(city: City, segment: SegmentId | StreetSegment, theme: Theme): Line {
  const seg = typeof segment === 'number' ? (city.segments[segment] as StreetSegment) : segment;
  const a = city.nodes[seg.a];
  const b = city.nodes[seg.b];
  const c = theme.cell;
  return { ax: (a?.x ?? 0) * c, ay: (a?.y ?? 0) * c, bx: (b?.x ?? 0) * c, by: (b?.y ?? 0) * c };
}

/**
 * Stroke many lines as one instruction. Skips empty input: Pixi re-strokes the
 * previous fill's path when stroke() follows it with nothing new drawn.
 */
export function strokeLines(g: Graphics, lines: readonly Line[], style: StrokeInput): void {
  if (lines.length === 0) return;
  for (const l of lines) g.moveTo(l.ax, l.ay).lineTo(l.bx, l.by);
  g.stroke(style);
}

/**
 * Add dashes along a line as sub-paths and return how many. `phase` shifts the
 * pattern along the line (for marching stripes); `inset` keeps dashes off both ends.
 */
export function addDashes(g: Graphics, l: Line, dash: number, gap: number, inset = 0, phase = 0): number {
  const len = Math.hypot(l.bx - l.ax, l.by - l.ay);
  const usable = len - 2 * inset;
  if (usable <= 0) return 0;
  const ux = (l.bx - l.ax) / len;
  const uy = (l.by - l.ay) / len;
  const period = dash + gap;
  let count = 0;
  for (let t = -(((phase % period) + period) % period); t < usable; t += period) {
    const s = Math.max(0, t);
    const e = Math.min(usable, t + dash);
    if (e - s < 0.5) continue;
    g.moveTo(l.ax + ux * (inset + s), l.ay + uy * (inset + s)).lineTo(l.ax + ux * (inset + e), l.ay + uy * (inset + e));
    count++;
  }
  return count;
}

/** Dashes centered on the usable part of a line, so both ends look the same. */
export function addCenteredDashes(g: Graphics, l: Line, dash: number, gap: number, inset: number): number {
  const len = Math.hypot(l.bx - l.ax, l.by - l.ay);
  const usable = len - 2 * inset;
  const n = Math.floor((usable + gap) / (dash + gap));
  if (n <= 0) return 0;
  const lead = (usable - (n * dash + (n - 1) * gap)) / 2;
  return addDashes(g, l, dash, gap, inset + lead, 0);
}

/** The line nudged toward the top-left light source by `d` and pulled in by `trim` at each end. */
export function highlightLine(l: Line, d: number, trim: number): Line {
  const len = Math.hypot(l.bx - l.ax, l.by - l.ay) || 1;
  const ux = (l.bx - l.ax) / len;
  const uy = (l.by - l.ay) / len;
  // Horizontal lines shift up, vertical ones shift left.
  const ox = Math.abs(uy) > Math.abs(ux) ? -d : 0;
  const oy = Math.abs(ux) >= Math.abs(uy) ? -d : 0;
  const t = Math.min(trim, len / 2);
  return { ax: l.ax + ux * t + ox, ay: l.ay + uy * t + oy, bx: l.bx - ux * t + ox, by: l.by - uy * t + oy };
}

/** Points spaced evenly along a line, `count` of them, each in the middle of its share. */
export function pointsAlong(l: Line, count: number): { x: number; y: number }[] {
  const pts: { x: number; y: number }[] = [];
  for (let k = 0; k < count; k++) {
    const t = (k + 0.5) / count;
    pts.push({ x: l.ax + (l.bx - l.ax) * t, y: l.ay + (l.by - l.ay) * t });
  }
  return pts;
}

export function midpoint(l: Line): { x: number; y: number } {
  return { x: (l.ax + l.bx) / 2, y: (l.ay + l.by) / 2 };
}

// Pixi tessellates rounded corners and circles by radius, which for a town of
// a few thousand small shapes adds up to millions of vertices. These helpers
// build lean polygons instead; at map scale nobody can count the facets.

const CORNER_STEPS = 3;
/** Arc points per corner, clockwise on screen (y down): top-left, top-right, bottom-right, bottom-left. */
const CORNER_ARCS = [Math.PI, Math.PI * 1.5, 0, Math.PI * 0.5].map((start) =>
  Array.from({ length: CORNER_STEPS + 1 }, (_, i) => {
    const a = start + (i / CORNER_STEPS) * (Math.PI / 2);
    return [Math.cos(a), Math.sin(a)] as const;
  }),
);

/** Which corners to round: top-left, top-right, bottom-right, bottom-left. */
export type Corners = readonly [boolean, boolean, boolean, boolean];
const ALL_CORNERS: Corners = [true, true, true, true];

/** Add a low-poly rounded rectangle to the path (fill or stroke it afterwards). */
export function roundBox(g: Graphics, x: number, y: number, w: number, h: number, r: number, corners: Corners = ALL_CORNERS): Graphics {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2));
  if (rad < 0.5) return g.rect(x, y, w, h);
  const pts: number[] = [];
  const centres = [
    [x + rad, y + rad, x, y],
    [x + w - rad, y + rad, x + w, y],
    [x + w - rad, y + h - rad, x + w, y + h],
    [x + rad, y + h - rad, x, y + h],
  ] as const;
  centres.forEach(([cx, cy, sharpX, sharpY], i) => {
    if (!corners[i]) pts.push(sharpX, sharpY);
    else for (const [cos, sin] of CORNER_ARCS[i] ?? []) pts.push(cx + cos * rad, cy + sin * rad);
  });
  return g.poly(pts, true);
}

const DISC_SIDES = 16;
const DISC_TRIG = Array.from({ length: DISC_SIDES }, (_, i) => {
  const a = (i / DISC_SIDES) * Math.PI * 2;
  return [Math.cos(a), Math.sin(a)] as const;
});

/** Add a low-poly circle to the path. */
export function disc(g: Graphics, x: number, y: number, r: number): Graphics {
  const pts: number[] = [];
  for (const [cos, sin] of DISC_TRIG) pts.push(x + cos * r, y + sin * r);
  return g.poly(pts, true);
}
