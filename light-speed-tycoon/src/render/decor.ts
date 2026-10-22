// Decorative trees. Placed once per city from the city's seed so a town always
// looks the same, and only on cells no parcel will ever use, clear of every road.
// Round 4c/4d: street trees line the curbs of tree-lined blocks (placeStreetTrees),
// the streets the sim counts as under canopy and so storm-exposed.

import { Rng, deriveSeed } from '../sim/rng';
import { canopyIn, drawGroveField, groveAt } from '../sim/terrain';
import type { City, StreetClass } from '../sim/types';
import { streetCanopy } from '../sim/weather';
import { hashInt, horizontalStreet, parcelGrid, streetLattice, verticalStreet } from './geometry';
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

/** A backyard cell's chance of a tree, as a share of theme.tree.density, on an open block ... */
const BACKYARD_SHARE = 0.6;
/** ... plus this share x the block's canopy (sim/terrain.canopyIn: 1 on a fully tree-lined block). */
const BACKYARD_CANOPY_SHARE = 0.9;

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
      // Backyards (cells beside a lot) get the odd shade tree, and many more in
      // an old tree-lined neighborhood (sim/terrain canopy: the streets the sim
      // counts as under trees, weather.streetCanopy, so the storm-exposed blocks
      // read as leafy on the map); open country gets groves where the noise is
      // high and clearings where it is low.
      let backyard = false;
      for (let dy = -1; dy <= 1 && !backyard; dy++) for (let dx = -1; dx <= 1; dx++) if (occupied(cx + dx, cy + dy)) backyard = true;
      const grove = groveAt(field, cx, cy);
      const chance = backyard ? density * (BACKYARD_SHARE + BACKYARD_CANOPY_SHARE * canopyIn(field, cx + 0.5, cy + 0.5)) : density * (0.08 + 0.92 * grove);
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

/** A street carries street trees from this canopy up (weather.streetCanopy: 0 open .. 1 fully tree-lined) ... */
export const STREET_TREE_MIN_CANOPY = 0.5;
/** ... one at each lot line on each curb with this chance x its canopy. */
const STREET_TREE_CHANCE = 0.85;
/** Street trees are this share of theme.tree's radii: young street trees, smaller than the groves'. */
const STREET_TREE_SCALE = 0.7;

/**
 * Round 4c/4d: street trees along tree-lined blocks, so the streets the sim
 * counts as under canopy (weather.streetCanopy at least
 * STREET_TREE_MIN_CANOPY: residential blocks under mature trees, the most
 * storm-exposed aerial plant) read as leafy on the map; the town's lots
 * leave too few free cells for placeTrees' backyard trees to show it. One
 * small tree at each lot line (every interior grid point of the segment, the
 * corners left clear) on each curb, with chance STREET_TREE_CHANCE x the
 * street's canopy from a stable hash (no Rng: placeTrees' draws are
 * unchanged), set back from the road so its canopy stays off the roadway.
 * Deterministic per city, back to front.
 */
export function placeStreetTrees(city: City, theme: Theme): Tree[] {
  const c = theme.cell;
  const { minRadius, maxRadius } = theme.tree;
  const trees: Tree[] = [];
  for (const seg of city.segments) {
    const canopy = streetCanopy(city, seg);
    if (!(canopy >= STREET_TREE_MIN_CANOPY)) continue;
    const a = city.nodes[seg.a];
    const b = city.nodes[seg.b];
    if (!a || !b) continue;
    const horizontal = a.y === b.y;
    const cells = Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
    const half = theme.road.width[seg.streetClass] / 2;
    for (let k = 1; k < cells; k++) {
      for (const side of [-1, 1] as const) {
        const h = hashInt(seg.id * 4_099 + k * 2 + (side > 0 ? 1 : 0));
        if ((h % 1_000) / 1_000 >= STREET_TREE_CHANCE * canopy) continue;
        const r = STREET_TREE_SCALE * (minRadius + (((h >>> 10) % 100) / 100) * (maxRadius - minRadius));
        const off = half + theme.lot.curbGap + 0.6 * r;
        const along = (Math.min(horizontal ? a.x : a.y, horizontal ? b.x : b.y) + k) * c;
        trees.push(horizontal ? { x: along, y: a.y * c + side * off, r } : { x: a.x * c + side * off, y: along, r });
      }
    }
  }
  trees.sort((p, q) => p.y - q.y || p.x - q.x);
  return trees;
}
