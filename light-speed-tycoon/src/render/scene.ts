// The map scene. Layers, bottom to top: board, roads, rock stipple, trees,
// strong rock texture (underground tool), $/ft cost overlay, storm-exposure
// overlay (round 4b), pole overlay,
// parcels, recent storms' clouds, cables, coverage shading and route preview,
// central office, cabinets, storm badges, tool marks. The world container is
// a render group, so panning and zooming only change its transform; each
// layer is redrawn only when the state it shows changes (the storm clouds on
// a new storm or a new day, while they fade).

import { Container, Graphics } from 'pixi.js';
import type { Application } from 'pixi.js';
import { getService } from '../sim/network';
import { accountUnits } from '../sim/sales';
import type { City, ExposureBand, GameState, ParcelId, ServiceSnapshot } from '../sim/types';
import type { Bounds, Camera } from './camera';
import { boardBounds, drawBoard, drawCostOverlay, drawExposureOverlay, drawPoleOverlay, drawRoads, drawRock, drawTrees, townBounds } from './cityLayer';
import type { CostOverlayMode } from './cityLayer';
import { buildCentralOffice } from './coLayer';
import { placeTrees } from './decor';
import { NetworkLayer, StormLayer } from './networkLayer';
import { OverlayLayer } from './overlay';
import type { OverlaySpec } from './overlay';
import { ParcelLayer } from './parcelLayer';
import type { Theme } from './theme';

const ANIM_FRAME_MS = 33;

/**
 * Debug/test read-out of what the map shows (window.__lst.stats() spreads it).
 * e2e tests rely on passedLots counting every lot drawn as passed or subscribed.
 */
export interface SceneStats {
  /** Lots drawn passed or subscribed. */
  passedLots: number;
  /** Lots drawn in the subscriber look. */
  subscribedLots: number;
  liveSpans: number;
  liveRedraws: number;
  /** Live spans washed out: connected to the CO but out of every cabinet's reach. */
  dimSpans: number;
  /** Cabinets ringed as full (turning signups away). */
  fullCabinets: number;
  /** The $/ft overlay's mode, or null when it is off. */
  costOverlay: CostOverlayMode | null;
  /** Round 4b: streets the storm-exposure overlay shows in each band, or null when it is off. */
  exposureOverlay: Record<ExposureBand, number> | null;
  /** The strong rock texture is showing (underground tool). */
  rockEmphasis: boolean;
  /** Live spans drawn out of service (storm or dig-in damage). */
  outageSpans: number;
  /** Aerial spans drawn being rebuilt underground. */
  rebuildSpans: number;
  /** Recent storms whose area the map shows (STORM_SHOW_DAYS). */
  stormsShown: number;
}

export class Scene {
  readonly world = new Container({ isRenderGroup: true });
  private readonly ground = new Container({ isRenderGroup: true });
  private readonly poles = new Graphics();
  private readonly rockStrong = new Graphics();
  private readonly cost = new Graphics();
  private rockStrongCity: City | null = null;
  private costMode: CostOverlayMode | null = null;
  private costDrawn: { city: City; mode: CostOverlayMode } | null = null;
  private readonly exposure = new Graphics();
  private exposureOn = false;
  private exposureDrawn: { city: City; bands: Record<ExposureBand, number> } | null = null;
  private readonly parcels: ParcelLayer;
  private readonly network: NetworkLayer;
  private readonly storms: StormLayer;
  private readonly overlay: OverlayLayer;
  private co: Container | null = null;
  private city: City | null = null;
  private state: GameState | null = null;
  private service: ServiceSnapshot | null = null;
  private networkVersion = -1;
  private fullKey = '';
  /** Subscribed units per parcel, recomputed when the state or the day changes. */
  private subscribers: { state: GameState; day: number; units: Map<ParcelId, number> } | null = null;
  /** Something changed since the last frame was drawn. */
  private dirty = true;
  private lastAnimMs = -Infinity;
  private camKey = '';

  constructor(
    app: Application,
    private readonly theme: Theme,
  ) {
    this.parcels = new ParcelLayer(theme);
    this.network = new NetworkLayer(theme);
    this.storms = new StormLayer(theme);
    this.overlay = new OverlayLayer(theme);
    this.poles.visible = false;
    this.rockStrong.visible = false;
    this.cost.visible = false;
    this.exposure.visible = false;
    this.world.addChild(
      this.ground,
      this.rockStrong,
      this.cost,
      this.exposure,
      this.poles,
      this.parcels.container,
      this.storms.under,
      this.network.below,
      this.overlay.under,
      this.network.above,
      this.storms.over,
      this.overlay.over,
    );
    app.stage.addChild(this.world);
  }

  /** World bounds of the whole board, which the camera keeps in view. */
  bounds(city: City): Bounds {
    return boardBounds(city, this.theme);
  }

  /** World bounds of the built-up town, which the opening view frames. */
  townBounds(city: City): Bounds {
    return townBounds(city, this.theme);
  }

  /**
   * Bring every layer up to date with the state; cheap when nothing changed.
   * Throws if the city can't be built; syncing a good state afterwards rebuilds
   * the map from scratch.
   */
  sync(state: GameState): void {
    if (state.city !== this.city || state !== this.state) {
      // A new city, or a loaded game that can reuse version numbers: redraw everything.
      if (state.city !== this.city) this.setCity(state.city);
      this.state = state;
      this.service = null;
      this.networkVersion = -1;
      this.fullKey = '';
    }
    const service = getService(state);
    const subscribers = this.subscribedUnits(state);
    if (service !== this.service || subscribers.changed) {
      this.service = service;
      if (this.parcels.sync(state.day, new Set(service.passedParcels), subscribers.units)) this.dirty = true;
    }
    const fullKey = state.sales.fullCabinets.join(',');
    if (state.network.version !== this.networkVersion || fullKey !== this.fullKey) {
      this.networkVersion = state.network.version;
      this.fullKey = fullKey;
      this.network.sync(state, service);
      this.dirty = true;
    }
    if (this.storms.sync(state)) this.dirty = true;
  }

  /** Subscribed units per parcel (from Sales.accounts), recomputed once per state and day. */
  private subscribedUnits(state: GameState): { units: ReadonlyMap<ParcelId, number>; changed: boolean } {
    const cached = this.subscribers;
    if (cached && cached.state === state && cached.day === state.day) return { units: cached.units, changed: false };
    const units = new Map<ParcelId, number>();
    for (const account of state.sales.accounts) units.set(account.parcel, accountUnits(account));
    this.subscribers = { state, day: state.day, units };
    return { units, changed: true };
  }

  /** Advance map animations, at most ~30 times a second: they are small and subtle. */
  animate(ms: number): void {
    if (!this.network.animating || ms - this.lastAnimMs < ANIM_FRAME_MS) return;
    this.lastAnimMs = ms;
    this.network.animate(ms);
    this.dirty = true;
  }

  applyCamera(camera: Camera): void {
    const key = `${camera.scale}|${camera.x}|${camera.y}`;
    if (key === this.camKey) return;
    this.camKey = key;
    this.world.scale.set(camera.scale);
    this.world.position.set(camera.x, camera.y);
    this.dirty = true;
  }

  setPoleOverlay(visible: boolean): void {
    if (this.poles.visible === visible) return;
    this.poles.visible = visible;
    this.dirty = true;
  }

  /** Show the strong rock texture (while the underground tool is active). Drawn on first use per city. */
  setRockEmphasis(on: boolean): void {
    if (on && this.city && this.rockStrongCity !== this.city) {
      this.rockStrong.clear();
      drawRock(this.rockStrong, this.city, this.theme, true);
      this.rockStrongCity = this.city;
      if (this.rockStrong.visible) this.dirty = true;
    }
    if (this.rockStrong.visible === on) return;
    this.rockStrong.visible = on;
    this.dirty = true;
  }

  /** Color every street by its $/ft band for a method (or the cheaper buildable one); null hides the overlay. */
  setCostOverlay(mode: CostOverlayMode | null): void {
    this.costMode = mode;
    this.refreshCostOverlay();
  }

  private refreshCostOverlay(): void {
    const mode = this.costMode;
    const city = this.city;
    if (mode && city && (this.costDrawn?.city !== city || this.costDrawn.mode !== mode)) {
      this.cost.clear();
      drawCostOverlay(this.cost, city, this.theme, mode);
      this.costDrawn = { city, mode };
      this.dirty = true;
    }
    const visible = mode !== null && city !== null;
    if (this.cost.visible !== visible) {
      this.cost.visible = visible;
      this.dirty = true;
    }
  }

  /** Color every street by its storm-exposure band (weather.exposureBand), or hide the overlay. Drawn on first use per city. */
  setExposureOverlay(on: boolean): void {
    this.exposureOn = on;
    this.refreshExposureOverlay();
  }

  private refreshExposureOverlay(): void {
    const city = this.city;
    if (this.exposureOn && city && this.exposureDrawn?.city !== city) {
      this.exposure.clear();
      this.exposureDrawn = { city, bands: drawExposureOverlay(this.exposure, city, this.theme) };
      this.dirty = true;
    }
    const visible = this.exposureOn && city !== null;
    if (this.exposure.visible !== visible) {
      this.exposure.visible = visible;
      this.dirty = true;
    }
  }

  setOverlay(spec: OverlaySpec): void {
    if (this.city && this.overlay.draw(this.city, spec)) this.dirty = true;
  }

  /** What the map currently shows, for debugging and tests. */
  stats(): SceneStats {
    return {
      passedLots: this.parcels.passedLots,
      subscribedLots: this.parcels.subscribedLots,
      liveSpans: this.network.liveSpans,
      liveRedraws: this.network.liveRedraws,
      dimSpans: this.network.dimSpans,
      fullCabinets: this.network.fullRings,
      costOverlay: this.cost.visible ? this.costMode : null,
      exposureOverlay: this.exposure.visible && this.exposureDrawn ? { ...this.exposureDrawn.bands } : null,
      rockEmphasis: this.rockStrong.visible,
      outageSpans: this.network.outageSpans,
      rebuildSpans: this.network.rebuildSpans,
      stormsShown: this.storms.shown,
    };
  }

  /** Whether the frame needs drawing; clears the flag. An idle map costs no GPU time. */
  takeDirty(): boolean {
    const dirty = this.dirty;
    this.dirty = false;
    return dirty;
  }

  private setCity(city: City): void {
    // Set only once the city is fully built, so one that fails midway is rebuilt
    // from scratch rather than left half drawn.
    this.city = null;
    this.dirty = true;
    for (const child of this.ground.removeChildren()) child.destroy();
    const board = new Graphics();
    drawBoard(board, city, this.theme);
    const roads = new Graphics();
    drawRoads(roads, city, this.theme);
    const rock = new Graphics();
    drawRock(rock, city, this.theme, false);
    const trees = new Graphics();
    drawTrees(trees, placeTrees(city, this.theme), this.theme);
    this.ground.addChild(board, roads, rock, trees);

    this.poles.clear();
    drawPoleOverlay(this.poles, city, this.theme);
    this.parcels.setCity(city);
    // Redrawn for the new streets: the strong rock texture now if it is showing, else on first use.
    this.rockStrong.clear();
    this.rockStrongCity = null;
    if (this.rockStrong.visible) {
      drawRock(this.rockStrong, city, this.theme, true);
      this.rockStrongCity = city;
    }
    this.costDrawn = null;
    this.exposureDrawn = null;

    // Graphics.destroy given options keeps its context (and the GPU buffers
    // behind it) unless asked: say so, or every new town leaks the old building.
    if (this.co) {
      this.co.destroy({ children: true, context: true });
      this.co = null;
    }
    this.co = buildCentralOffice(city, this.theme);
    // Over cables and previews so they run in under the building; under cabinets and tool marks.
    this.world.addChildAt(this.co, this.world.getChildIndex(this.network.above));
    this.overlay.draw(city, {});
    this.city = city;
    this.refreshCostOverlay();
    this.refreshExposureOverlay();
  }
}
