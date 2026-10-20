// Lots and buildings. Parcels are split into spatial chunks, each its own
// Graphics, and a chunk is redrawn only when the set of parcels that exist or
// are passed inside it changes. Growth then costs one small chunk at a time.

import { Container, Graphics } from 'pixi.js';
import type { City, Parcel, ParcelId } from '../sim/types';
import { frontageSide, hashInt, lotFrame, lotRect, streetLattice } from './geometry';
import type { LotFrame, Rect, StreetLattice } from './geometry';
import { roundBox } from './shapes';
import type { AwningColors, RoofColors, Theme } from './theme';

/** Chunk edge in cells. */
const CHUNK = 16;

export type ParcelLook = 'unserved' | 'passed';

interface Chunk {
  g: Graphics;
  parcels: Parcel[];
  key: string;
  /** Lots drawn in the 'passed' look at the last redraw. */
  passed: number;
}

export class ParcelLayer {
  readonly container = new Container({ isRenderGroup: true });
  private chunks: Chunk[] = [];
  private city: City | null = null;
  private lattice: StreetLattice | null = null;

  constructor(private readonly theme: Theme) {}

  setCity(city: City): void {
    for (const chunk of this.chunks) chunk.g.destroy();
    this.chunks = [];
    this.city = city;
    this.lattice = streetLattice(city);
    const cols = Math.ceil(city.width / CHUNK);
    const rows = Math.ceil(city.height / CHUNK);
    const byChunk: Parcel[][] = Array.from({ length: cols * rows }, () => []);
    for (const p of city.parcels) {
      const i = Math.min(rows - 1, Math.floor(p.y / CHUNK)) * cols + Math.min(cols - 1, Math.floor(p.x / CHUNK));
      byChunk[i]?.push(p);
    }
    for (const parcels of byChunk) {
      if (parcels.length === 0) continue;
      const g = new Graphics();
      this.container.addChild(g);
      this.chunks.push({ g, parcels, key: '', passed: 0 });
    }
  }

  /** Redraw the chunks whose existing or passed parcels changed; true if any did. */
  sync(day: number, passed: ReadonlySet<ParcelId>): boolean {
    const { city, lattice } = this;
    if (!city || !lattice) return false;
    let changed = false;
    for (const chunk of this.chunks) {
      let appeared = 0;
      let passedHash = 0;
      for (const p of chunk.parcels) {
        if (p.appearsDay > day) continue;
        appeared++;
        if (passed.has(p.id)) passedHash = (passedHash + hashInt(p.id)) >>> 0;
      }
      const key = `${appeared}:${passedHash}`;
      if (key === chunk.key) continue;
      chunk.key = key;
      changed = true;
      chunk.g.clear();
      chunk.passed = 0;
      for (const p of chunk.parcels) {
        if (p.appearsDay > day) continue;
        const look: ParcelLook = passed.has(p.id) ? 'passed' : 'unserved';
        if (drawParcel(chunk.g, city, lattice, p, look, this.theme) && look === 'passed') chunk.passed++;
      }
    }
    return changed;
  }

  /** How many lots are drawn in the 'passed' look (a debug and test read-out of what the map shows). */
  get passedLots(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.passed, 0);
  }
}

/** Draw one lot and its building; false when the lot is too small to show. */
export function drawParcel(g: Graphics, city: City, lattice: StreetLattice, p: Parcel, look: ParcelLook, theme: Theme): boolean {
  const lot = lotRect(lattice, p, theme);
  if (lot.w <= 2 || lot.h <= 2) return false;
  const frame = lotFrame(lot, frontageSide(city, p));
  const h = hashInt(p.id);
  if (p.kind === 'home') drawHome(g, lot, frame, h, look, theme);
  else if (p.kind === 'smb') drawShop(g, lot, frame, h, look, theme);
  else drawApartments(g, lot, p.units, look, theme);
  return true;
}

/** 0..1 from a slice of a hash, for deterministic per-lot variety. */
function vary(hash: number, shift: number): number {
  return ((hash >>> shift) & 0xff) / 255;
}

function drawHome(g: Graphics, lot: Rect, f: LotFrame, hash: number, look: ParcelLook, theme: Theme): void {
  const { house, lot: lotStyle } = theme;
  roundBox(g, lot.x, lot.y, lot.w, lot.h, lotStyle.radius).fill(lotStyle.lawn);

  const along = clamp(f.front * (0.64 + 0.12 * vary(hash, 0)), 14, 46);
  const deep = clamp(f.depth * (0.5 + 0.1 * vary(hash, 8)), 12, 26);
  const setback = clamp(f.depth * 0.14, 3, 8);
  const u = (f.front - along) * (0.3 + 0.4 * vary(hash, 16));
  const body = f.toWorld(u, setback, along, deep);

  // Front path from the door to the curb.
  const pathW = 3.5;
  const path = f.toWorld(u + along / 2 - pathW / 2, 0, pathW, setback + 1);
  g.rect(path.x, path.y, path.w, path.h).fill(house.path);

  // Some homes get a garage wing beside the main roof.
  const room = f.front - along - u;
  const wing = vary(hash, 24) > 0.5 && room > 10 ? f.toWorld(u + along - 3, setback + deep * 0.28, Math.min(12, room - 2), deep * 0.72) : null;

  const [sx, sy] = house.shadowOffset;
  const roofs = look === 'passed' ? house.passed : house.unserved;
  if (wing) roundBox(g, wing.x + sx, wing.y + sy, wing.w, wing.h, house.radius).fill(house.shadow);
  roundBox(g, body.x + sx, body.y + sy, body.w, body.h, house.radius).fill(house.shadow);
  if (wing) drawRoof(g, wing, roofs, theme);
  drawRoof(g, body, roofs, theme);
}

/**
 * Gable roof seen from above: a rounded slab whose slope facing away from the
 * top-left light is shaded, split by a ridge along the long axis.
 */
function drawRoof(g: Graphics, r: Rect, colors: RoofColors, theme: Theme): void {
  const { house } = theme;
  const rad = Math.min(house.radius, r.w / 2, r.h / 2);
  // Ridge-colored slab with the roof inset by the outline width: a crisp toy edge without a stroke.
  const o = house.outline;
  roundBox(g, r.x, r.y, r.w, r.h, rad).fill(colors.ridge);
  roundBox(g, r.x + o, r.y + o, r.w - 2 * o, r.h - 2 * o, rad - o / 2).fill(colors.roof);
  const inset = Math.min(2.5, rad);
  if (r.w >= r.h) {
    const y = r.y + r.h / 2;
    roundBox(g, r.x + o, y, r.w - 2 * o, r.h / 2 - o, rad - o / 2, [false, false, true, true]).fill({ color: colors.ridge, alpha: 0.5 });
    g.moveTo(r.x + inset, y).lineTo(r.x + r.w - inset, y);
  } else {
    const x = r.x + r.w / 2;
    roundBox(g, x, r.y + o, r.w / 2 - o, r.h - 2 * o, rad - o / 2, [false, true, true, false]).fill({ color: colors.ridge, alpha: 0.5 });
    g.moveTo(x, r.y + inset).lineTo(x, r.y + r.h - inset);
  }
  g.stroke({ width: house.ridgeWidth, color: colors.ridge, cap: 'butt' });
}

function drawShop(g: Graphics, lot: Rect, f: LotFrame, hash: number, look: ParcelLook, theme: Theme): void {
  const { smb, house, lot: lotStyle } = theme;
  roundBox(g, lot.x, lot.y, lot.w, lot.h, lotStyle.radius).fill(lotStyle.plaza);

  // Deep lots park cars out front; shallow ones put the shop right on the sidewalk.
  const deepLot = f.depth > theme.cell * 1.4;
  const awningDepth = 5;
  const parking = deepLot ? clamp(f.depth * 0.38, 14, theme.cell * 1.4) : 0;
  const v = (deepLot ? parking : 3) + awningDepth;
  const side = clamp(f.front * 0.08, 2.5, 6);
  const body = f.toWorld(side, v, f.front - 2 * side, Math.max(8, f.depth - v - 3));

  if (deepLot) {
    const stall = 9;
    const stalls = Math.floor((f.front - 2 * side) / stall);
    for (let i = 1; i < stalls; i++) {
      const line = f.toWorld(side + i * stall, 3, 0, parking - 6);
      g.moveTo(line.x, line.y).lineTo(line.x + line.w, line.y + line.h);
    }
    if (stalls > 1) g.stroke({ width: 1.2, color: lotStyle.parkingLine, cap: 'butt' });
  }

  const [sx, sy] = house.shadowOffset;
  roundBox(g, body.x + sx, body.y + sy, body.w, body.h, smb.radius).fill(house.shadow);
  roundBox(g, body.x, body.y, body.w, body.h, smb.radius).fill(smb.frontEdge);
  roundBox(g, body.x + 1.5, body.y + 1.5, body.w - 3, body.h - 3, smb.radius - 0.75).fill(smb.front);
  // A rooftop unit on bigger stores.
  if (body.w > 22 && body.h > 16) {
    const unit = f.toWorld(side + (f.front - 2 * side) * (0.25 + 0.4 * vary(hash, 4)), v + 4, 8, 6);
    roundBox(g, unit.x, unit.y, unit.w, unit.h, 1.5).fill(smb.frontEdge);
  }

  const awning: AwningColors = look === 'passed' ? smb.awningPassed : smb.awningUnserved;
  const strip = f.toWorld(side - 1, v - awningDepth, f.front - 2 * side + 2, awningDepth + 1);
  roundBox(g, strip.x, strip.y, strip.w, strip.h, 1.5).fill(awning.base);
  const stripeW = 4;
  const count = Math.floor((f.front - 2 * side + 2) / stripeW);
  for (let i = 0; i < count; i += 2) {
    const s = f.toWorld(side - 1 + i * stripeW, v - awningDepth, stripeW, awningDepth + 1);
    g.rect(s.x, s.y, s.w, s.h);
  }
  if (count > 0) g.fill(awning.stripe);
}

function drawApartments(g: Graphics, lot: Rect, units: number, look: ParcelLook, theme: Theme): void {
  const { mdu, house, lot: lotStyle } = theme;
  roundBox(g, lot.x, lot.y, lot.w, lot.h, lotStyle.radius).fill(lotStyle.plaza);
  const pad = 4;
  const roof: Rect = { x: lot.x + pad, y: lot.y + pad, w: lot.w - 2 * pad, h: lot.h - 2 * pad };
  const [sx, sy] = house.shadowOffset;
  roundBox(g, roof.x + sx + 0.5, roof.y + sy + 1, roof.w, roof.h, mdu.radius).fill(house.shadow);
  // Edge ring: butter when the building is passed, slate otherwise.
  const ring = look === 'passed' ? 3 : 1.5;
  roundBox(g, roof.x, roof.y, roof.w, roof.h, mdu.radius).fill(look === 'passed' ? mdu.passedRing : mdu.roofEdge);
  roundBox(g, roof.x + ring, roof.y + ring, roof.w - 2 * ring, roof.h - 2 * ring, mdu.radius - ring / 2).fill(mdu.roof);

  // One pip per unit in an even grid that matches the roof's shape.
  const inner = 6;
  const iw = roof.w - 2 * inner;
  const ih = roof.h - 2 * inner;
  if (iw <= 4 || ih <= 4 || units <= 0) return;
  const cols = Math.max(1, Math.round(Math.sqrt((units * iw) / ih)));
  const rows = Math.ceil(units / cols);
  const cw = iw / cols;
  const ch = ih / rows;
  const size = Math.max(2, Math.min(cw, ch) * 0.62);
  for (let i = 0; i < units; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    g.rect(roof.x + inner + c * cw + (cw - size) / 2, roof.y + inner + r * ch + (ch - size) / 2, size, size);
  }
  g.fill(mdu.pip);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
