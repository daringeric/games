// Everything the player does on the map: the tool palette, pointer and
// keyboard input routed to tools (clicks, taps and drag-to-draw), the tool
// overlay and the floating quote card, the $/ft cost overlay and its legend,
// the storm-exposure overlay and its legend (round 4b), the OLT panel and the
// span panel. The two street overlays are mutually exclusive: both recolor
// every street, so switching one on (button or key: O for cost, E for
// exposure) switches the other off, legend included. main.ts builds one MapControls, appends
// its toolbar and card, and calls update() every frame; it never reaches into
// the tools itself. Panels of our own (the OLT panel, the span panel, the
// legend) are mounted here, next to the map canvas. One map panel shows at a
// time; Esc or a right-click closes it, and a map press closes the span panel
// (a press on another span shows that one instead).
//
// Owner: ui-map workstream. main.ts is owned by the ui-economy workstream and
// only uses the public members below.

import type { Camera } from '../render/camera';
import { costOverlayThresholds, EXPOSURE_BANDS } from '../render/cityLayer';
import type { CostOverlayMode } from '../render/cityLayer';
import type { Scene } from '../render/scene';
import type { Theme } from '../render/theme';
import type { Command, ExposureBand, GameState } from '../sim/types';
import { el } from './dom';
import { FloatingCard } from './floatingCard';
import { formatPerFt } from './format';
import { Input } from './input';
import { OltPanel } from './oltPanel';
import { SpanPanel } from './spanPanel';
import type { HintCard, Toasts } from './overlays';
import type { GameSession } from './session';
import { Toolbar } from './toolbar';
import { ToolController } from './tools';
import type { ToolId, ToolOutcome } from './tools';

export interface MapControlsDeps {
  canvas: HTMLCanvasElement;
  camera: Camera;
  theme: Theme;
  scene: Scene;
  session: GameSession;
  toasts: Toasts;
  hint: HintCard;
}

/** The game menu as far as map input needs it: Esc and a map press close it first. */
export interface MenuLike {
  readonly isOpen: boolean;
  close(): void;
}

/** The storm-exposure legend's line per band: what it means and where it tends to be. */
export const EXPOSURE_LEGEND: Record<ExposureBand, string> = {
  sheltered: 'sheltered · fewer storms',
  moderate: 'moderate',
  exposed: 'exposed · tree-lined, rural, wooded, edge',
};

const MODE_LABEL: Record<CostOverlayMode, string> = {
  aerial: 'aerial',
  underground: 'underground',
  cheapest: 'cheaper method per street',
};

export class MapControls {
  /** Tool palette (with the cost overlay switch); main.ts places its root in the page. */
  readonly toolbar: Toolbar;
  /** Floating quote/inspect card; main.ts places its root in the page. */
  readonly card = new FloatingCard();
  /** The OLT panel (opened by clicking the CO); mounted next to the map by MapControls. */
  readonly olt: OltPanel;
  /** The span panel (opened by clicking a live span with the inspect tool); mounted next to the map by MapControls. */
  readonly span: SpanPanel;
  /** Legend of the $/ft cost overlay; mounted next to the map by MapControls. */
  readonly legend: HTMLElement;
  /** Round 4b: legend of the storm-exposure overlay (sheltered / moderate / exposed); mounted next to the map. */
  readonly exposureLegend: HTMLElement;
  private readonly legendMode: HTMLElement;
  private readonly legendNone: HTMLElement;
  private readonly tools = new ToolController();
  private readonly pointer = { x: 0, y: 0, onMap: false };
  /**
   * The hover card is put away when a panel opens: 'next' until the opening
   * press reports its position, then held there until the pointer moves.
   */
  private cardHold: 'next' | { x: number; y: number } | null = null;
  private input: Input | null = null;
  private costOverlay = false;
  private exposureOverlay = false;

  constructor(private readonly deps: MapControlsDeps) {
    this.toolbar = new Toolbar(
      (tool) => this.pickTool(tool),
      () => this.toggleCostOverlay(),
      () => this.toggleExposureOverlay(),
    );
    this.olt = new OltPanel({
      getState: () => deps.session.state,
      dispatch: (cmd) => deps.session.dispatch(cmd),
      toast: (message, ok) => deps.toasts.show(message, ok),
      // One map panel at a time, however it was opened (the map, or the briefing's "Open OLT").
      onOpen: () => this.span.close(),
    });
    this.span = new SpanPanel({
      getState: () => deps.session.state,
      dispatch: (cmd) => deps.session.dispatch(cmd),
      toast: (message, ok) => deps.toasts.show(message, ok),
      onOpen: () => this.olt.close(),
    });
    this.legendMode = el('span', { class: 'cost-legend-mode' });
    this.legendNone = legendItem(deps.theme.costOverlay.none, 'no poles');
    this.legend = buildLegend(deps.theme, this.legendMode, this.legendNone);
    this.exposureLegend = buildExposureLegend(deps.theme);
    this.mount();
  }

  /** Put our own panels next to the map canvas (once it is in the page). */
  private mount(): void {
    if (this.olt.root.isConnected && this.span.root.isConnected) return;
    const host = this.deps.canvas.parentElement ?? document.getElementById('app');
    if (host) host.append(this.legend, this.exposureLegend, this.olt.root, this.span.root);
  }

  /** Start routing pointer and keyboard input to the map (once, after the menu exists). */
  attachInput(menu: MenuLike): void {
    if (this.input) return;
    const { canvas, camera, theme, session } = this.deps;
    const tools = this.tools;
    const pointer = this.pointer;
    const dispatch = (cmd: Command) => session.dispatch(cmd);
    this.input = new Input(canvas, camera, theme.cell, {
      hover: (grid, screen, touch) => {
        if (touch !== undefined) tools.touch = touch;
        pointer.x = screen.x;
        pointer.y = screen.y;
        const hold = this.cardHold;
        if (hold === 'next') this.cardHold = { x: screen.x, y: screen.y };
        else if (hold && (hold.x !== screen.x || hold.y !== screen.y)) this.cardHold = null;
        pointer.onMap = grid !== null && this.cardHold === null;
        if (grid) tools.hoverAt(grid.x, grid.y);
        else tools.clearHover();
      },
      click: (grid, touch) => {
        tools.touch = touch;
        // A map press puts the span panel away (a press on a span opens that one again below).
        this.span.close();
        this.report(touch ? tools.tap(session.state, dispatch, grid.x, grid.y) : tools.click(session.state, dispatch, grid.x, grid.y));
      },
      dragStart(start, pick, touch) {
        tools.touch = touch;
        return tools.dragStart(session.state, start.x, start.y, pick);
      },
      dragMove: (grid, screen) => {
        pointer.x = screen.x;
        pointer.y = screen.y;
        pointer.onMap = true;
        this.cardHold = null;
        tools.dragMove(session.state, grid.x, grid.y);
      },
      dragEnd: (grid) => {
        this.report(tools.dragEnd(session.state, dispatch, grid.x, grid.y));
      },
      dragCancel() {
        tools.dragCancel();
      },
      cancel: () => {
        if (menu.isOpen) {
          menu.close();
          return true;
        }
        if (this.olt.isOpen) {
          this.olt.close();
          return true;
        }
        if (this.span.isOpen) {
          this.span.close();
          return true;
        }
        return tools.cancel();
      },
      escape: () => {
        if (tools.tool !== 'inspect') this.pickTool('inspect');
      },
      pickTool: (tool) => this.pickTool(tool),
      currentTool: () => tools.tool,
      setSpeed: (speed) => session.setSpeed(speed),
      togglePause: () => session.togglePause(),
      toggleOverlay: () => this.toggleCostOverlay(),
      toggleExposureOverlay: () => this.toggleExposureOverlay(),
    });
  }

  /** Toast what a click, tap or drag did, and open whatever panel it asked for. */
  private report(outcome: ToolOutcome | null): void {
    if (!outcome) return;
    if (outcome.open === 'olt') {
      this.olt.open(this.deps.session.state);
      // The panel says it all: put the hover card away until the pointer moves again.
      this.pointer.onMap = false;
      this.cardHold = 'next';
    } else if (outcome.open === 'span' && outcome.span !== undefined) {
      this.span.open(this.deps.session.state, outcome.span);
      this.pointer.onMap = false;
      this.cardHold = 'next';
    }
    if (outcome.message) this.deps.toasts.show(outcome.message, outcome.ok);
    if (outcome.ok && outcome.message) this.deps.hint.hide();
  }

  get tool(): ToolId {
    return this.tools.tool;
  }

  /** Whether the $/ft cost overlay is showing. */
  get costOverlayOn(): boolean {
    return this.costOverlay;
  }

  pickTool(tool: ToolId): void {
    this.tools.setTool(tool);
    this.toolbar.select(tool);
    this.deps.scene.setPoleOverlay(tool === 'aerial');
    this.deps.scene.setRockEmphasis(tool === 'underground');
    this.syncCostOverlay();
  }

  /** Whether the storm-exposure overlay is showing. */
  get exposureOverlayOn(): boolean {
    return this.exposureOverlay;
  }

  /** Show or hide the $/ft cost overlay (toolbar switch, or the O key). Showing it hides the exposure overlay. */
  toggleCostOverlay(on = !this.costOverlay): void {
    if (on && this.exposureOverlay) this.setExposure(false);
    this.costOverlay = on;
    this.toolbar.setOverlay(on);
    this.syncCostOverlay();
  }

  /** Show or hide the storm-exposure overlay (toolbar switch, or the E key). Showing it hides the cost overlay. */
  toggleExposureOverlay(on = !this.exposureOverlay): void {
    if (on && this.costOverlay) {
      this.costOverlay = false;
      this.toolbar.setOverlay(false);
      this.syncCostOverlay();
    }
    this.setExposure(on);
  }

  private setExposure(on: boolean): void {
    this.exposureOverlay = on;
    this.toolbar.setExposureOverlay(on);
    this.deps.scene.setExposureOverlay(on);
    this.exposureLegend.hidden = !on;
    this.placeLegend();
  }

  /** The overlay prices the active cable tool's method, otherwise each street's cheaper buildable method. */
  private syncCostOverlay(): void {
    const tool = this.tools.tool;
    const mode: CostOverlayMode = tool === 'aerial' || tool === 'underground' ? tool : 'cheapest';
    this.deps.scene.setCostOverlay(this.costOverlay ? mode : null);
    this.legend.hidden = !this.costOverlay;
    this.legendMode.textContent = MODE_LABEL[mode];
    // Only aerial can be unbuildable (no poles); the other modes always have underground.
    this.legendNone.hidden = mode !== 'aerial';
    this.placeLegend();
  }

  /**
   * Desktop: the legend sits by the toolbar (CSS). Phones, where the toolbar
   * runs along the bottom: just under the HUD, whatever height it has grown to.
   */
  private placeLegend(): void {
    const shown = [this.legend, this.exposureLegend].filter((legend) => !legend.hidden);
    if (shown.length === 0) return;
    const bar = this.toolbar.root.getBoundingClientRect();
    let top = '';
    if (bar.height > 0 && bar.top > window.innerHeight / 2) {
      const hud = document.querySelector('.hud')?.getBoundingClientRect();
      if (hud && hud.height > 0) top = `${Math.round(hud.bottom + 8)}px`;
    }
    for (const legend of shown) if (legend.style.top !== top) legend.style.top = top;
  }

  /** The band the floating card may use: under the HUD, and above the toolbar when it runs along the bottom (phones). */
  private cardSafeArea(): { top: number; bottom: number } {
    const viewH = window.innerHeight;
    const hud = document.querySelector('.hud')?.getBoundingClientRect();
    const bar = this.toolbar.root.getBoundingClientRect();
    const top = hud && hud.height > 0 ? hud.bottom + 8 : 0;
    const bottom = bar.height > 0 && bar.top > viewH / 2 ? bar.top - 8 : viewH;
    return { top, bottom };
  }

  /** A new or loaded game replaced the old one: drop any run in progress and close map panels. */
  reset(): void {
    this.tools.cancel();
    this.olt.close();
    this.span.close();
    this.cardHold = null;
  }

  /** Per frame, after scene.sync(state): tool overlay, the floating card and open panels. */
  update(state: GameState): void {
    this.mount();
    const view = this.tools.view(state);
    this.deps.scene.setOverlay(view.overlay);
    const { pointer } = this;
    this.card.render(pointer.onMap ? view.card : null, pointer.x, pointer.y, window.innerWidth, window.innerHeight, this.cardSafeArea());
    this.olt.update(state);
    this.span.update(state);
    this.placeLegend();
  }
}

function legendItem(color: string, text: string): HTMLElement {
  return el('li', {}, [el('span', { class: 'cost-swatch', attrs: { style: `background: ${color}` } }), el('span', { text })]);
}

/**
 * The cost overlay's legend: what each band means in dollars per foot (all-in
 * cable cost before per-order fees; see costOverlayThresholds: aerial reads
 * green, soil bores amber, rock red).
 */
function buildLegend(theme: Theme, mode: HTMLElement, none: HTMLElement): HTMLElement {
  const { green, amber } = costOverlayThresholds();
  return el(
    'aside',
    { class: 'cost-legend pill-card', attrs: { 'aria-label': 'Cost overlay legend', 'data-testid': 'cost-legend', hidden: '' } },
    [
      el('p', { class: 'cost-legend-title' }, ['Cable $/ft · ', mode]),
      el('ul', {}, [
        legendItem(theme.cpp.green, `≤ ${formatPerFt(green)} · aerial`),
        legendItem(theme.cpp.amber, `≤ ${formatPerFt(amber)} · bore`),
        legendItem(theme.cpp.red, 'more · rock'),
        none,
      ]),
    ],
  );
}

/**
 * The storm-exposure overlay's legend: one swatch per band (theme.exposureOverlay),
 * light to dark as storms get likelier (weather.exposureBand of weather.segmentExposure).
 */
function buildExposureLegend(theme: Theme): HTMLElement {
  return el(
    'aside',
    { class: 'cost-legend exposure-legend pill-card', attrs: { 'aria-label': 'Storm exposure legend', 'data-testid': 'exposure-legend', hidden: '' } },
    [
      el('p', { class: 'cost-legend-title' }, ['Storm exposure']),
      el(
        'ul',
        {},
        EXPOSURE_BANDS.map((band) => {
          const item = legendItem(theme.exposureOverlay.band[band], EXPOSURE_LEGEND[band]);
          item.setAttribute('data-band', band);
          return item;
        }),
      ),
    ],
  );
}
