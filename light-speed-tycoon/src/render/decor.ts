// Decorative trees. Placed once per city from the city's seed so a town always
// looks the same, and only on cells no parcel will ever use, clear of every road.

import { Rng, deriveSeed } from '../sim/rng';
import { drawGroveField, groveAt } from '../sim/terrain';
import type { City, StreetClass } from '../sim/types';
import { horizontalStreet, parcelGrid, streetLattice, verticalStreet } from './geometry';
import type { StreetLattice } from './geometry';
import type { Theme } from './theme';

export interface Tree {
  /** Center in world pixels. */
  x: number;
  y: number;
  r: number;
}

/** Distance from a point to the segment (ax, ay)-(bx, by). */
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

/**
 * True when a circle of radius r at world point (x, y) inside cell (cx, cy) stays
 * off every street near that cell, round caps and dead-end bulbs included.
 */
function clearOfStreets(
  lattice: StreetLattice,
  city: City,
  theme: Theme,
  cx: number,
  cy: number,
  x: number,
  y: number,
  r: number,
): boolean {
  const c = theme.cell;
  const blocked = (ax: number, ay: number, bx: number, by: number, cls: StreetClass | undefined) => {
    if (!cls) return false;
    const half = theme.road.width[cls] / 2;
    if (distToSegment(x, y, ax * c, ay * c, bx * c, by * c) < half + r) return true;
    // Dead ends get a wider turnaround bulb.
    const bulb = half * theme.road.culDeSac + r;
    return (
      (Math.hypot(x - ax * c, y - ay * c) < bulb && isDeadEnd(lattice, city, ax, ay)) ||
      (Math.hypot(x - bx * c, y - by * c) < bulb && isDeadEnd(lattice, city, bx, by))
    );
  };
  // Canopies can lean past their cell, so check the streets of the 3x3 neighborhood.
  for (let j = cy - 1; j <= cy + 2; j++) {
    for (let i = cx - 1; i <= cx + 1; i++) {
      if (blocked(i, j, i + 1, j, horizontalStreet(lattice, i, j))) return false;
    }
  }
  for (let j = cy - 1; j <= cy + 1; j++) {
    for (let i = cx - 1; i <= cx + 2; i++) {
      if (blocked(i, j, i, j + 1, verticalStreet(lattice, i, j))) return false;
    }
  }
  return true;
}

function isDeadEnd(lattice: StreetLattice, city: City, x: number, y: number): boolean {
  const id = nodeAt(city, x, y);
  return id !== undefined && lattice.degree[id] === 1;
}

const nodeIndexCache = new WeakMap<City, Map<number, number>>();

function nodeAt(city: City, x: number, y: number): number | undefined {
  let index = nodeIndexCache.get(city);
  if (!index) {
    index = new Map(city.nodes.map((n) => [n.y * (city.width + 1) + n.x, n.id]));
    nodeIndexCache.set(city, index);
  }
  return index.get(y * (city.width + 1) + x);
}

/**
 * Trees for a city, deterministic per seed. Density varies with a coarse noise
 * field (sim/terrain's grove field, which also makes wooded streets more
 * exposed to storms) so backyards and countryside get clumps and clearings
 * instead of an even sprinkle.
 */
export function placeTrees(city: City, theme: Theme): Tree[] {
  const rng = new Rng(deriveSeed(city.seed, 'decor'));
  const lattice = streetLattice(city);
  const parcels = parcelGrid(city);
  const c = theme.cell;
  const { minRadius, maxRadius, density } = theme.tree;

  // The coarse grove field (sim/terrain: the same field the sim calls wooded
  // streets by) comes first from the 'decor' stream; the trees follow from it.
  const field = drawGroveField(city, rng);

  const occupied = (x: number, y: number) =>
    x >= 0 && y >= 0 && x < city.width && y < city.height && parcels[y * city.width + x] !== 0;
  const trees: Tree[] = [];
  for (let cy = 0; cy < city.height; cy++) {
    for (let cx = 0; cx < city.width; cx++) {
      if (occupied(cx, cy)) continue;
      // Backyards (cells beside a lot) get the odd shade tree; open country gets
      // groves where the noise is high and clearings where it is low.
      let backyard = false;
      for (let dy = -1; dy <= 1 && !backyard; dy++) for (let dx = -1; dx <= 1; dx++) if (occupied(cx + dx, cy + dy)) backyard = true;
      const grove = groveAt(field, cx, cy);
      const chance = backyard ? density * 0.6 : density * (0.08 + 0.92 * grove);
      if (!rng.chance(chance)) continue;
      const count = backyard ? 1 : 1 + rng.int(0, Math.round(2 * grove));
      for (let k = 0; k < count; k++) {
        const scale = backyard ? 1 : 1 + 0.25 * grove;
        const r = (minRadius + rng.next() * (maxRadius - minRadius)) * scale * (count > 1 ? 0.85 : 1);
        // Keep the trunk inside the cell; canopies may lean a little past it.
        const margin = Math.min(r * 0.7, c / 2 - 1);
        const x = cx * c + margin + rng.next() * (c - 2 * margin);
        const y = cy * c + margin + rng.next() * (c - 2 * margin);
        if (clearOfStreets(lattice, city, theme, cx, cy, x, y, r)) trees.push({ x, y, r });
      }
    }
  }
  // Draw back to front so lower canopies overlap the ones above them.
  trees.sort((a, b) => a.y - b.y);
  return trees;
}
