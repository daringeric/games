// Lots and buildings. Parcels are split into spatial chunks, each its own
// Graphics, and a chunk is redrawn only when the set of parcels that exist,
// are passed, or subscribe (and how many units) inside it changes. Growth and
// signups then cost one small chunk at a time.
//
// Every building shows its single serving side (Parcel.segment): homes have a
// front walk with a doorstep and a notch at the curb, shops an awning facing
// the street, apartment buildings a demarc box on the serving wall with a
// dashed fiber entry out to the curb.

import { Container, Graphics } from 'pixi.js';
import type { City, Parcel, ParcelId } from '../sim/types';
import { HOME_PATH_WIDTH, MDU_ROOF_PAD, frontageSide, hashInt, homePlan, lotFrame, lotRect, mduDemarc, streetLattice, vary } from './geometry';
import type { LotFrame, Rect, Side, StreetLattice } from './geometry';
import { addDashes, roundBox } from './shapes';
import type { AwningColors, RoofColors, Theme } from './theme';

/** Chunk edge in cells. */
const CHUNK = 16;

/**
 * How a lot is drawn: 'subscribed' when it has an account (subscribed units >
 * 0), else 'passed' when lit, else 'unserved'.
 */
export type ParcelLook = 'unserved' | 'passed' | 'subscribed';

interface Chunk {
  g: Graphics;
  parcels: Parcel[];
  key: string;
  /** Lots drawn in the 'passed' or 'subscribed' look at the last redraw. */
  passed: number;
  /** Lots drawn in the 'subscribed' look at the last redraw. */
  subscribed: number;
}

const NO_SUBSCRIBERS: ReadonlyMap<ParcelId, number> = new Map();

export class ParcelLayer {
  readonly container = new Container({ isRenderGroup: true });
  private chunks: Chunk[] = [];
  private city: City | null = null;
  private lattice: StreetLattice | null = null;
  /** Chunk redraws so far (a test read-out: only chunks whose lots changed are redrawn). */
  chunkRedraws = 0;

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
      this.chunks.push({ g, parcels, key: '', passed: 0, subscribed: 0 });
    }
  }

  /**
   * Redraw the chunks whose existing, passed or subscribed parcels changed
   * (including how many units subscribe at an apartment building); true if
   * any did. `subscribers` maps a parcel to its subscribed units (parcels
   * without an account are absent).
   */
  sync(day: number, passed: ReadonlySet<ParcelId>, subscribers: ReadonlyMap<ParcelId, number> = NO_SUBSCRIBERS): boolean {
    const { city, lattice } = this;
    if (!city || !lattice) return false;
    let changed = false;
    for (const chunk of this.chunks) {
      let appeared = 0;
      let passedHash = 0;
      let subsHash = 0;
      for (const p of chunk.parcels) {
        if (p.appearsDay > day) continue;
        appeared++;
        if (passed.has(p.id)) passedHash = (passedHash + hashInt(p.id)) >>> 0;
        const units = subscribers.get(p.id);
        if (units) subsHash = (subsHash + hashInt(p.id * 4099 + units)) >>> 0;
      }
      const key = `${appeared}:${passedHash}:${subsHash}`;
      if (key === chunk.key) continue;
      chunk.key = key;
      changed = true;
      this.chunkRedraws++;
      chunk.g.clear();
      chunk.passed = 0;
      chunk.subscribed = 0;
      for (const p of chunk.parcels) {
        if (p.appearsDay > day) continue;
        const units = subscribers.get(p.id) ?? 0;
        const look: ParcelLook = units > 0 ? 'subscribed' : passed.has(p.id) ? 'passed' : 'unserved';
        if (!drawParcel(chunk.g, city, lattice, p, look, this.theme, units)) continue;
        if (look !== 'unserved') chunk.passed++;
        if (look === 'subscribed') chunk.subscribed++;
      }
    }
    return changed;
  }

  /**
   * How many lots are drawn passed or subscribed (a debug and test read-out of
   * what the map shows: a subscriber's lot is passed too).
   */
  get passedLots(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.passed, 0);
  }

  /** How many lots are drawn in the subscriber look. */
  get subscribedLots(): number {
    return this.chunks.reduce((sum, chunk) => sum + chunk.subscribed, 0);
  }
}

/**
 * Draw one lot and its building; false when the lot is too small to show.
 * `subscribedUnits` lights that many of an apartment building's unit pips.
 */
export function drawParcel(
  g: Graphics,
  city: City,
  lattice: StreetLattice,
  p: Parcel,
  look: ParcelLook,
  theme: Theme,
  subscribedUnits = 0,
): boolean {
  const lot = lotRect(lattice, p, theme);
  if (lot.w <= 2 || lot.h <= 2) return false;
  const side = frontageSide(city, p);
  const frame = lotFrame(lot, side);
  const h = hashInt(p.id);
  if (p.kind === 'home') drawHome(g, lot, frame, h, look, theme);
  else if (p.kind === 'smb') drawShop(g, lot, frame, h, look, theme);
  else drawApartments(g, lot, side, p.units, look === 'subscribed' ? Math.min(p.units, subscribedUnits) : 0, look, theme);
  return true;
}

function drawHome(g: Graphics, lot: Rect, f: LotFrame, hash: number, look: ParcelLook, theme: Theme): void {
  const { house, lot: lotStyle } = theme;
  roundBox(g, lot.x, lot.y, lot.w, lot.h, lotStyle.radius).fill(lotStyle.lawn);

  const { u, along, deep, setback, walkU } = homePlan(f, hash);
  const body = f.toWorld(u, setback, along, deep);

  // Front walk from the door to the curb, with a notch cut into the curb
  // where it meets the street and a doorstep at the door: the serving side.
  const pathW = HOME_PATH_WIDTH;
  const gap = theme.lot.curbGap;
  const path = f.toWorld(walkU - pathW / 2, -gap, pathW, setback + gap + 1);
  g.rect(path.x, path.y, path.w, path.h).fill(house.path);
  const notch = f.toWorld(walkU - pathW / 2 - 1.5, -gap, pathW + 3, gap + 0.8);
  const step = f.toWorld(walkU - pathW / 2 - 1.5, Math.max(0, setback - 2.2), pathW + 3, 2.2);
  g.rect(notch.x, notch.y, notch.w, notch.h).rect(step.x, step.y, step.w, step.h).fill(house.doorstep);

  // Some homes get a garage wing beside the main roof.
  const room = f.front - along - u;
  const wing = vary(hash, 24) > 0.5 && room > 10 ? f.toWorld(u + along - 3, setback + deep * 0.28, Math.min(12, room - 2), deep * 0.72) : null;

  const [sx, sy] = house.shadowOffset;
  const roofs = look === 'subscribed' ? house.subscriber : look === 'passed' ? house.passed : house.unserved;
  if (wing) roundBox(g, wing.x + sx, wing.y + sy, wing.w, wing.h, house.radius).fill(house.shadow);
  roundBox(g, body.x + sx, body.y + sy, body.w, body.h, house.radius).fill(house.shadow);
  if (wing) drawRoof(g, wing, roofs, theme);
  drawRoof(g, body, roofs, theme);
  if (look === 'subscribed') drawSparkle(g, body, house.subscriber.sparkle);
}

/** A small four-point glint on a subscriber's roof. */
function drawSparkle(g: Graphics, r: Rect, color: string): void {
  const x = r.x + r.w * 0.28;
  const y = r.y + r.h * 0.3;
  const s = Math.max(2.2, Math.min(4, Math.min(r.w, r.h) * 0.2));
  const k = s * 0.28;
  g.poly([x, y - s, x + k, y - k, x + s, y, x + k, y + k, x, y + s, x - k, y + k, x - s, y, x - k, y - k], true).fill(color);
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

  const awning: AwningColors = look === 'subscribed' ? smb.awningServed : look === 'passed' ? smb.awningPassed : smb.awningUnserved;
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

function drawApartments(g: Graphics, lot: Rect, side: Side, units: number, lit: number, look: ParcelLook, theme: Theme): void {
  const { mdu, house, lot: lotStyle, demarc } = theme;
  roundBox(g, lot.x, lot.y, lot.w, lot.h, lotStyle.radius).fill(lotStyle.plaza);
  const pad = MDU_ROOF_PAD;
  const roof: Rect = { x: lot.x + pad, y: lot.y + pad, w: lot.w - 2 * pad, h: lot.h - 2 * pad };
  const [sx, sy] = house.shadowOffset;
  roundBox(g, roof.x + sx + 0.5, roof.y + sy + 1, roof.w, roof.h, mdu.radius).fill(house.shadow);
  // Edge ring: butter when the building is passed (or subscribes), slate otherwise.
  const served = look !== 'unserved';
  const ring = served ? 3 : 1.5;
  roundBox(g, roof.x, roof.y, roof.w, roof.h, mdu.radius).fill(served ? mdu.passedRing : mdu.roofEdge);
  roundBox(g, roof.x + ring, roof.y + ring, roof.w - 2 * ring, roof.h - 2 * ring, mdu.radius - ring / 2).fill(mdu.roof);

  // Demarc on the serving wall, with the fiber entry dashed out to the curb.
  const tell = mduDemarc(lot, side, theme);
  const e = tell.entry;
  if (addDashes(g, { ax: e.ax, ay: e.ay, bx: e.bx, by: e.by }, 2.5, 2) > 0) g.stroke({ width: 1.4, color: demarc.entry, cap: 'butt' });
  const b = tell.box;
  roundBox(g, b.x - 1, b.y - 1, b.w + 2, b.h + 2, 2).fill(demarc.edge);
  roundBox(g, b.x, b.y, b.w, b.h, 1.5).fill(demarc.box);

  // One pip per unit in an even grid that matches the roof's shape; the first
  // `lit` (subscribing units) glow coral.
  const inner = 6;
  const iw = roof.w - 2 * inner;
  const ih = roof.h - 2 * inner;
  if (iw <= 4 || ih <= 4 || units <= 0) return;
  const cols = Math.max(1, Math.round(Math.sqrt((units * iw) / ih)));
  const rows = Math.ceil(units / cols);
  const cw = iw / cols;
  const ch = ih / rows;
  const size = Math.max(2, Math.min(cw, ch) * 0.62);
  const pip = (i: number) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    g.rect(roof.x + inner + c * cw + (cw - size) / 2, roof.y + inner + r * ch + (ch - size) / 2, size, size);
  };
  const litCount = Math.max(0, Math.min(units, lit));
  for (let i = 0; i < litCount; i++) pip(i);
  if (litCount > 0) g.fill(mdu.pipLit);
  for (let i = litCount; i < units; i++) pip(i);
  if (litCount < units) g.fill(mdu.pip);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
