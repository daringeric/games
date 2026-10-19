// The map scene. Layers, bottom to top: board, roads, trees, pole overlay,
// parcels, cables, route preview, central office, cabinets, tool marks. The
// world container is a render group, so panning and zooming only change its
// transform; each layer is redrawn only when the state it shows changes.

import { Container, Graphics } from 'pixi.js';
import type { Application } from 'pixi.js';
import { getService } from '../sim/network';
import type { City, GameState, ServiceSnapshot } from '../sim/types';
import type { Bounds, Camera } from './camera';
import { boardBounds, drawBoard, drawPoleOverlay, drawRoads, drawTrees, townBounds } from './cityLayer';
import { buildCentralOffice } from './coLayer';
import { placeTrees } from './decor';
import { NetworkLayer } from './networkLayer';
import { OverlayLayer } from './overlay';
import type { OverlaySpec } from './overlay';
import { ParcelLayer } from './parcelLayer';
import type { Theme } from './theme';

const ANIM_FRAME_MS = 33;

export class Scene {
  readonly world = new Container({ isRenderGroup: true });
  private readonly ground = new Container({ isRenderGroup: true });
  private readonly poles = new Graphics();
  private readonly parcels: ParcelLayer;
  private readonly network: NetworkLayer;
  private readonly overlay: OverlayLayer;
  private co: Container | null = null;
  private city: City | null = null;
  private state: GameState | null = null;
  private service: ServiceSnapshot | null = null;
  private networkVersion = -1;
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
    this.overlay = new OverlayLayer(theme);
    this.poles.visible = false;
    this.world.addChild(
      this.ground,
      this.poles,
      this.parcels.container,
      this.network.below,
      this.overlay.under,
      this.network.above,
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
    }
    const service = getService(state);
    if (service !== this.service) {
      this.service = service;
      if (this.parcels.sync(state.day, new Set(service.passedParcels))) this.dirty = true;
    }
    if (state.network.version !== this.networkVersion) {
      this.networkVersion = state.network.version;
      this.network.sync(state, service);
      this.dirty = true;
    }
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

  setOverlay(spec: OverlaySpec): void {
    if (this.city && this.overlay.draw(this.city, spec)) this.dirty = true;
  }

  /** What the map currently shows, for debugging and tests: lots drawn as passed, live spans drawn, live cable redraws. */
  stats(): { passedLots: number; liveSpans: number; liveRedraws: number } {
    return { passedLots: this.parcels.passedLots, liveSpans: this.network.liveSpans, liveRedraws: this.network.liveRedraws };
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
    const trees = new Graphics();
    drawTrees(trees, placeTrees(city, this.theme), this.theme);
    this.ground.addChild(board, roads, trees);

    this.poles.clear();
    drawPoleOverlay(this.poles, city, this.theme);
    this.parcels.setCity(city);

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
  }
}
