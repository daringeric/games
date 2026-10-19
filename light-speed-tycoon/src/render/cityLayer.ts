// Static layers drawn once per city: the grass board, roads, trees, and the
// pole overlay shown while planning aerial runs.

import type { Graphics } from 'pixi.js';
import { polesOnSegment } from '../sim/streets';
import type { City } from '../sim/types';
import type { Tree } from './decor';
import type { Bounds } from './camera';
import { streetLattice } from './geometry';
import { addCenteredDashes, disc, pointsAlong, segmentLine } from './shapes';
import type { Theme } from './theme';

/** World rect of the board: the map plus a grass margin. */
export function boardBounds(city: City, theme: Theme): Bounds {
  const c = theme.cell;
  const m = theme.board.margin * c;
  return { x: -m, y: -m, w: city.width * c + 2 * m, h: city.height * c + 2 * m };
}

/**
 * World rect around the built-up town: the middle 90% of day-0 lots plus a
 * margin, so the opening view frames houses rather than empty countryside.
 */
export function townBounds(city: City, theme: Theme): Bounds {
  const lots = city.parcels.filter((p) => p.appearsDay === 0);
  if (lots.length === 0) return boardBounds(city, theme);
  const xs = lots.map((p) => p.x + p.w / 2).sort((a, b) => a - b);
  const ys = lots.map((p) => p.y + p.h / 2).sort((a, b) => a - b);
  const pick = (v: number[], q: number) => v[Math.min(v.length - 1, Math.floor(q * v.length))] ?? 0;
  const pad = 2;
  const c = theme.cell;
  const x0 = Math.max(0, pick(xs, 0.05) - pad);
  const y0 = Math.max(0, pick(ys, 0.05) - pad);
  const x1 = Math.min(city.width, pick(xs, 0.95) + pad);
  const y1 = Math.min(city.height, pick(ys, 0.95) + pad);
  return { x: x0 * c, y: y0 * c, w: (x1 - x0) * c, h: (y1 - y0) * c };
}

export function drawBoard(g: Graphics, city: City, theme: Theme): void {
  const b = boardBounds(city, theme);
  const { radius, shadowOffset, shadow, grass } = theme.board;
  g.roundRect(b.x, b.y + shadowOffset, b.w, b.h, radius).fill(shadow);
  g.roundRect(b.x, b.y, b.w, b.h, radius).fill(grass);
}

/**
 * Roads as plain rectangles (segments are axis-aligned) plus a disc at every
 * node, which gives the same rounded junctions as round caps for a fraction of
 * the triangles. Curbs go under every road first so fills merge at junctions.
 */
export function drawRoads(g: Graphics, city: City, theme: Theme): void {
  const { road } = theme;
  const c = theme.cell;
  const lattice = streetLattice(city);
  // Widest road meeting each node sizes its junction disc and stops centre dashes short of it.
  const nodeHalf = new Float32Array(city.nodes.length);
  for (const seg of city.segments) {
    const half = road.width[seg.streetClass] / 2;
    nodeHalf[seg.a] = Math.max(nodeHalf[seg.a] ?? 0, half);
    nodeHalf[seg.b] = Math.max(nodeHalf[seg.b] ?? 0, half);
  }
  // Dead ends widen into a turnaround bulb.
  const junction = (id: number) => (nodeHalf[id] ?? 0) * (lattice.degree[id] === 1 ? road.culDeSac : 1);

  const pave = (grow: number, color: string) => {
    for (const seg of city.segments) {
      const l = segmentLine(city, seg, theme);
      const half = road.width[seg.streetClass] / 2 + grow;
      const x = Math.min(l.ax, l.bx);
      const y = Math.min(l.ay, l.by);
      if (l.ay === l.by) g.rect(x, y - half, Math.abs(l.bx - l.ax), 2 * half);
      else g.rect(x - half, y, 2 * half, Math.abs(l.by - l.ay));
    }
    for (const n of city.nodes) {
      if ((nodeHalf[n.id] ?? 0) === 0) continue;
      // Big turnaround bulbs get a true circle; junction discs stay low-poly.
      if (lattice.degree[n.id] === 1) g.circle(n.x * c, n.y * c, junction(n.id) + grow);
      else disc(g, n.x * c, n.y * c, junction(n.id) + grow);
    }
    if (city.segments.length > 0) g.fill(color);
  };
  pave(road.edgeWidth, road.edge);
  pave(0, road.fill);

  let dashes = 0;
  for (const seg of city.segments) {
    const inset = Math.max(junction(seg.a), junction(seg.b)) + road.gap / 2;
    dashes += addCenteredDashes(g, segmentLine(city, seg, theme), road.dash, road.gap, inset);
  }
  if (dashes > 0) g.stroke({ width: road.centerLineWidth, color: road.centerLine, cap: 'butt' });
}

export function drawTrees(g: Graphics, trees: readonly Tree[], theme: Theme): void {
  const { tree } = theme;
  // Shadows, then canopies, then highlights: three fills for the whole forest.
  for (const t of trees) disc(g, t.x + t.r * 0.22, t.y + t.r * 0.32, t.r);
  if (trees.length > 0) g.fill(tree.shadow);
  for (const t of trees) disc(g, t.x, t.y, t.r);
  if (trees.length > 0) g.fill(tree.body);
  for (const t of trees) disc(g, t.x - t.r * 0.28, t.y - t.r * 0.3, t.r * 0.48);
  if (trees.length > 0) g.fill(tree.highlight);
}

/** Every utility pole in town, shown faintly while the aerial tool is active. */
export function drawPoleOverlay(g: Graphics, city: City, theme: Theme): void {
  const { aerial } = theme.cable;
  const pts: { x: number; y: number }[] = [];
  for (const seg of city.segments) {
    pts.push(...pointsAlong(segmentLine(city, seg, theme), polesOnSegment(seg)));
  }
  for (const p of pts) disc(g, p.x, p.y, aerial.poleRadius);
  if (pts.length > 0) g.fill(aerial.poleRim);
  for (const p of pts) disc(g, p.x, p.y, aerial.poleRadius - 1.3);
  if (pts.length > 0) g.fill(aerial.pole);
}
