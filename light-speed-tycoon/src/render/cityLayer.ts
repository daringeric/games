// Static layers drawn once per city: the grass board, roads, rock stipple,
// trees, the pole overlay shown while planning aerial runs, the stronger rock
// texture shown while planning underground runs, the $/ft cost overlay and
// (round 4b) the storm-exposure overlay.

import type { Graphics } from 'pixi.js';
import {
  AERIAL_COST_PER_FT,
  MAKE_READY_COST_PER_POLE,
  POLE_SPACING_FT,
  UNDERGROUND_COST_PER_FT,
  UNDERGROUND_ROCK_SURCHARGE_PER_FT,
} from '../sim/balance';
import { segmentCostPerFt } from '../sim/network';
import { polesOnSegment } from '../sim/streets';
import type { CableMethod, City, CppBand, ExposureBand, StreetSegment } from '../sim/types';
import { cityExposure, exposureBand } from '../sim/weather';
import type { Tree } from './decor';
import type { Bounds } from './camera';
import { hashInt, mapExit, straightRuns, streetLattice } from './geometry';
import { addCenteredDashes, disc, pointsAlong, segmentLine, strokeLines } from './shapes';
import type { Line } from './shapes';
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
 * Streets that run off the map carry on to the board edge instead of ending in
 * a turnaround bulb.
 */
export function drawRoads(g: Graphics, city: City, theme: Theme): void {
  const { road } = theme;
  const c = theme.cell;
  const lattice = streetLattice(city);
  const margin = theme.board.margin * c;
  // Widest road meeting each node sizes its junction disc and stops centre dashes short of it.
  const nodeHalf = new Float32Array(city.nodes.length);
  for (const seg of city.segments) {
    const half = road.width[seg.streetClass] / 2;
    nodeHalf[seg.a] = Math.max(nodeHalf[seg.a] ?? 0, half);
    nodeHalf[seg.b] = Math.max(nodeHalf[seg.b] ?? 0, half);
  }
  const exits = city.nodes.map((n) => mapExit(city, lattice, n.id));
  // Dead ends widen into a turnaround bulb; map exits have no junction at all.
  const junction = (id: number) => (exits[id] ? 0 : (nodeHalf[id] ?? 0) * (lattice.degree[id] === 1 ? road.culDeSac : 1));

  const pave = (grow: number, color: string) => {
    const rect = (l: Line, half: number) => {
      const x = Math.min(l.ax, l.bx);
      const y = Math.min(l.ay, l.by);
      if (l.ay === l.by) g.rect(x, y - half, Math.abs(l.bx - l.ax), 2 * half);
      else g.rect(x - half, y, 2 * half, Math.abs(l.by - l.ay));
    };
    for (const seg of city.segments) {
      const half = road.width[seg.streetClass] / 2 + grow;
      rect(segmentLine(city, seg, theme), half);
      for (const id of [seg.a, seg.b]) {
        const out = exits[id];
        const n = city.nodes[id];
        if (out && n) rect({ ax: n.x * c, ay: n.y * c, bx: n.x * c + out.dx * margin, by: n.y * c + out.dy * margin }, half);
      }
    }
    for (const n of city.nodes) {
      if ((nodeHalf[n.id] ?? 0) === 0 || exits[n.id]) continue;
      // Big turnaround bulbs get a true circle; junction discs stay low-poly.
      if (lattice.degree[n.id] === 1) g.circle(n.x * c, n.y * c, junction(n.id) + grow);
      else disc(g, n.x * c, n.y * c, junction(n.id) + grow);
    }
    if (city.segments.length > 0) g.fill(color);
  };
  pave(road.edgeWidth, road.edge);
  pave(0, road.fill);

  // Centre dashes follow whole straight runs so they don't break where citygen
  // splits a long street, and stop short of junctions and bulbs.
  let dashes = 0;
  for (const run of straightRuns(city, lattice)) {
    const a = city.nodes[run.a];
    const b = city.nodes[run.b];
    if (!a || !b) continue;
    const len = Math.hypot(b.x - a.x, b.y - a.y) * c;
    const ux = ((b.x - a.x) * c) / len;
    const uy = ((b.y - a.y) * c) / len;
    // Positive trims pull an end in from its junction; a map exit instead extends to the board edge.
    const trim = (id: number) => (exits[id] ? -margin : junction(id) + road.gap / 2);
    const ta = trim(run.a);
    const tb = trim(run.b);
    const line: Line = { ax: a.x * c + ux * ta, ay: a.y * c + uy * ta, bx: b.x * c - ux * tb, by: b.y * c - uy * tb };
    dashes += addCenteredDashes(g, line, road.dash, road.gap, 0);
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

/**
 * Stipple on rocky streets (StreetSegment.rock): a subtle scatter of grit
 * across the road, or (`strong`) a denser, darker one for while the
 * underground tool is active. Deterministic per segment. Returns the number of
 * rock segments drawn.
 */
export function drawRock(g: Graphics, city: City, theme: Theme, strong: boolean): number {
  const { road, rock } = theme;
  const step = strong ? 6 : 8;
  const size = strong ? 2.3 : 1.7;
  const rows = strong ? [-0.66, -0.22, 0.22, 0.66] : [-0.5, 0.05, 0.55];
  let count = 0;
  for (const seg of city.segments) {
    if (!seg.rock) continue;
    count++;
    const l = segmentLine(city, seg, theme);
    const len = Math.hypot(l.bx - l.ax, l.by - l.ay);
    if (len <= 0) continue;
    const ux = (l.bx - l.ax) / len;
    const uy = (l.by - l.ay) / len;
    const half = road.width[seg.streetClass] / 2;
    let i = 0;
    for (let t = step / 2; t < len; t += step, i++) {
      rows.forEach((row, k) => {
        const h = hashInt(seg.id * 7919 + i * 31 + k);
        // Staggered rows, nudged a little so the grit doesn't read as a grid.
        const along = t + ((i + k) % 2 === 0 ? 0 : step / 2) + (((h & 0xff) / 255) - 0.5) * step * 0.5;
        if (along <= 0 || along >= len) return;
        const across = (row + ((((h >>> 8) & 0xff) / 255) - 0.5) * 0.18) * half;
        const x = l.ax + ux * along - uy * across;
        const y = l.ay + uy * along + ux * across;
        g.rect(x - size / 2, y - size / 2, size, size);
      });
    }
  }
  if (count > 0) g.fill({ color: strong ? rock.strong : rock.stipple, alpha: strong ? rock.strongAlpha : rock.alpha });
  return count;
}

/** What the $/ft overlay prices: one method, or per street the cheaper method it can be built with. */
export type CostOverlayMode = CableMethod | 'cheapest';

/**
 * All-in $/ft for cabling `seg` under an overlay mode (network.segmentCostPerFt,
 * before per-order fees); null where the method can't be built (aerial
 * without poles).
 */
export function overlayCostPerFt(seg: StreetSegment, mode: CostOverlayMode): number | null {
  if (mode !== 'cheapest') return segmentCostPerFt(seg, mode);
  const under = segmentCostPerFt(seg, 'underground');
  const aerial = segmentCostPerFt(seg, 'aerial');
  if (aerial === null) return under;
  if (under === null) return aerial;
  return Math.min(aerial, under);
}

/**
 * Where the overlay's colors change, in $/ft, from the build rates: green up
 * to halfway between typical aerial (strand plus make-ready at the usual pole
 * spacing) and an underground bore in soil, amber up to halfway between soil
 * and rock, red above. So aerial streets read green, soil bores amber and rock
 * red, in every mode, whatever the tuned rates are. (A single cost-per-passing
 * threshold would paint every underground street the same red.)
 */
export function costOverlayThresholds(): { green: number; amber: number } {
  const aerial = AERIAL_COST_PER_FT + MAKE_READY_COST_PER_POLE / POLE_SPACING_FT;
  const soil = UNDERGROUND_COST_PER_FT;
  const rock = UNDERGROUND_COST_PER_FT + UNDERGROUND_ROCK_SURCHARGE_PER_FT;
  return { green: (aerial + soil) / 2, amber: (soil + rock) / 2 };
}

/** The overlay's color band for a street's all-in $/ft (see costOverlayThresholds); null where it can't be built. */
export function overlayBand(seg: StreetSegment, mode: CostOverlayMode): CppBand | null {
  const perFt = overlayCostPerFt(seg, mode);
  if (perFt === null) return null;
  const { green, amber } = costOverlayThresholds();
  return perFt <= green ? 'green' : perFt <= amber ? 'amber' : 'red';
}

/** Every street colored by its $/ft band (theme.cpp), or the "can't build" color. */
export function drawCostOverlay(g: Graphics, city: City, theme: Theme, mode: CostOverlayMode): void {
  const buckets: Record<CppBand | 'none', Line[]> = { green: [], amber: [], red: [], none: [] };
  for (const seg of city.segments) buckets[overlayBand(seg, mode) ?? 'none'].push(segmentLine(city, seg, theme));
  const { costOverlay } = theme;
  for (const band of ['none', 'green', 'amber', 'red'] as const) {
    strokeLines(g, buckets[band], {
      width: costOverlay.width,
      color: band === 'none' ? costOverlay.none : theme.cpp[band],
      alpha: costOverlay.alpha,
      cap: 'round',
      join: 'round',
    });
  }
}

/** The storm-exposure overlay's bands, least to most exposed (drawn in this order, so exposed streets sit on top). */
export const EXPOSURE_BANDS: readonly ExposureBand[] = ['sheltered', 'moderate', 'exposed'];

/** Every street's storm-exposure band (weather.exposureBand of weather.cityExposure), by segment id. */
export function exposureBands(city: City): ExposureBand[] {
  const exposure = cityExposure(city);
  return city.segments.map((seg) => exposureBand(exposure[seg.id] ?? 1));
}

/**
 * Every street colored by its storm-exposure band (theme.exposureOverlay).
 * Returns how many streets it drew in each band.
 */
export function drawExposureOverlay(g: Graphics, city: City, theme: Theme): Record<ExposureBand, number> {
  const buckets: Record<ExposureBand, Line[]> = { sheltered: [], moderate: [], exposed: [] };
  const bands = exposureBands(city);
  for (const seg of city.segments) buckets[bands[seg.id] ?? 'moderate'].push(segmentLine(city, seg, theme));
  const { exposureOverlay } = theme;
  for (const band of EXPOSURE_BANDS) {
    strokeLines(g, buckets[band], { width: exposureOverlay.width, color: exposureOverlay.band[band], alpha: exposureOverlay.alpha, cap: 'round', join: 'round' });
  }
  return { sheltered: buckets.sheltered.length, moderate: buckets.moderate.length, exposed: buckets.exposed.length };
}
