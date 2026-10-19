// Test-only helpers: small, hand-checkable cities that don't depend on the generator.

import { TILE_FT } from '../balance';
import type { City, Parcel, StreetNode, StreetSegment } from '../types';

export interface GridCityOptions {
  /** Blocks across. Default 3. */
  cols?: number;
  /** Blocks down. Default 2. */
  rows?: number;
  /** Block width in cells. Default 4. */
  blockW?: number;
  /** Block height in cells. Default 2 (two back-to-back rows of lots). */
  blockH?: number;
  /** Poles on every segment. Default true. */
  hasPoles?: boolean;
  /** Rock under every segment. Default false. */
  rock?: boolean;
  /** Lattice coordinates (in blocks) of the CO node. Default [0, 0]. */
  coAt?: [number, number];
}

/**
 * A perfect grid town. Node (i, j) sits at (i * blockW, j * blockH) and has id
 * j * (cols + 1) + i. Horizontal segments come first (id = j * cols + i, joining
 * node (i, j) to (i + 1, j)), then vertical ones (id = H + j * (cols + 1) + i,
 * joining (i, j) to (i, j + 1), where H = (rows + 1) * cols).
 *
 * Every block has a top row of home lots fronting the street above it and, when
 * blockH >= 2, a bottom row fronting the street below it. All parcels exist
 * from day 0.
 */
export function makeGridCity(opts: GridCityOptions = {}): City {
  const cols = opts.cols ?? 3;
  const rows = opts.rows ?? 2;
  const blockW = opts.blockW ?? 4;
  const blockH = opts.blockH ?? 2;
  const hasPoles = opts.hasPoles ?? true;
  const rock = opts.rock ?? false;
  const [coI, coJ] = opts.coAt ?? [0, 0];

  const nodeId = (i: number, j: number) => j * (cols + 1) + i;
  const hSeg = (i: number, j: number) => j * cols + i;
  const H = (rows + 1) * cols;
  const vSeg = (i: number, j: number) => H + j * (cols + 1) + i;

  const nodes: StreetNode[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i <= cols; i++) {
      nodes.push({ id: nodeId(i, j), x: i * blockW, y: j * blockH });
    }
  }

  const segments: StreetSegment[] = [];
  for (let j = 0; j <= rows; j++) {
    for (let i = 0; i < cols; i++) {
      segments.push({
        id: hSeg(i, j),
        a: nodeId(i, j),
        b: nodeId(i + 1, j),
        streetClass: 'local',
        name: `${j + 1}${ordinalSuffix(j + 1)} St`,
        lengthFt: blockW * TILE_FT,
        hasPoles,
        rock,
        zone: 'residential',
      });
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i <= cols; i++) {
      segments.push({
        id: vSeg(i, j),
        a: nodeId(i, j),
        b: nodeId(i, j + 1),
        streetClass: 'local',
        name: `${String.fromCharCode(65 + (i % 26))} Ave`,
        lengthFt: blockH * TILE_FT,
        hasPoles,
        rock,
        zone: 'residential',
      });
    }
  }

  const parcels: Parcel[] = [];
  const addHome = (x: number, y: number, segment: number) => {
    parcels.push({
      id: parcels.length,
      kind: 'home',
      segment,
      x,
      y,
      w: 1,
      h: 1,
      units: 1,
      appearsDay: 0,
      zone: 'residential',
    });
  };
  for (let bj = 0; bj < rows; bj++) {
    for (let bi = 0; bi < cols; bi++) {
      for (let cx = 0; cx < blockW; cx++) {
        const x = bi * blockW + cx;
        addHome(x, bj * blockH, hSeg(bi, bj));
        if (blockH >= 2) addHome(x, bj * blockH + blockH - 1, hSeg(bi, bj + 1));
      }
    }
  }

  return {
    seed: 0,
    name: 'Gridville',
    width: cols * blockW,
    height: rows * blockH,
    tileFt: TILE_FT,
    nodes,
    segments,
    parcels,
    coNode: nodeId(coI, coJ),
  };
}

function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  return ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
}
