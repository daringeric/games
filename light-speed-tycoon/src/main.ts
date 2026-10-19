// Entry point: boot the game, wire the scene, camera, HUD, tools and input,
// and run the frame loop.

import './ui/style.css';
import { Application } from 'pixi.js';
import { formatMonth } from './sim/calendar';
import { newGame } from './sim/game';
import type { Command, CommandResult, GameState } from './sim/types';
import { Camera } from './render/camera';
import type { Insets } from './render/camera';
import { Scene } from './render/scene';
import { toyTown } from './render/theme';
import type { Theme } from './render/theme';
import { el } from './ui/dom';
import { formatNumber, formatSignedMoney } from './ui/format';
import { Hud } from './ui/hud';
import { Input } from './ui/input';
import { Menu } from './ui/menu';
import { FloatingCard, HintCard, Toasts } from './ui/overlays';
import { ReportPanel } from './ui/panel';
import { GameSession } from './ui/session';
import type { Speed } from './ui/session';
import { AUTOSAVE_KEY, SAVE_KEY, exportSave, importSave, readSave, writeSave } from './ui/storage';
import { applyThemeCss } from './ui/themeCss';
import { Toolbar } from './ui/toolbar';
import { ToolController } from './ui/tools';
import type { ToolId } from './ui/tools';

/** Test and debugging hook. Coordinates are map grid units and CSS client pixels. */
interface DebugHook {
  getState(): GameState;
  dispatch(cmd: Command): CommandResult;
  tick(days?: number): void;
  setSpeed(speed: Speed): void;
  worldToScreen(x: number, y: number): { x: number; y: number };
  screenToWorld(x: number, y: number): { x: number; y: number };
  /** Frame-loop counters: animation frames run, and how many of them drew the map. */
  stats(): { frames: number; renders: number };
}

declare global {
  interface Window {
    __lst?: DebugHook;
  }
}

const HINT = 'Lay fiber out from the CO, then drop a cabinet to light homes.';

function randomSeed(): number {
  // The UI may use Math.random to pick a seed; the sim itself never does.
  return Math.floor(Math.random() * 0x7fffffff);
}

/** ?seed=N starts that town; otherwise resume the autosave, else a random town. */
function initialState(): GameState {
  const param = new URLSearchParams(window.location.search).get('seed');
  if (param !== null && /^\d+$/.test(param)) return newGame(Number(param));
  return readSave(AUTOSAVE_KEY) ?? newGame(randomSeed());
}

/** Let the web fonts arrive before Pixi rasterizes map text, but never block boot for long. */
async function waitForFonts(theme: Theme): Promise<void> {
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load(`700 18px "${theme.fonts.display}"`),
        document.fonts.load(`700 15px "${theme.fonts.ui}"`),
      ]),
      new Promise((resolve) => window.setTimeout(resolve, 2500)),
    ]);
  } catch {
    // System fonts are an acceptable fallback.
  }
}

async function boot(): Promise<void> {
  const theme = toyTown;
  applyThemeCss(theme);
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app element');

  const session = new GameSession(initialState());
  await waitForFonts(theme);

  const app = new Application();
  await app.init({
    resizeTo: window,
    background: theme.board.background,
    // Dense screens are smooth enough without MSAA, which is costly at 2x.
    antialias: (window.devicePixelRatio || 1) < 2,
    autoDensity: true,
    resolution: Math.min(2, window.devicePixelRatio || 1),
    preference: 'webgl',
    autoStart: false,
  });
  app.canvas.setAttribute('aria-label', 'Town map');
  root.append(app.canvas);

  const scene = new Scene(app, theme);
  const camera = new Camera();
  const tools = new ToolController();
  const toasts = new Toasts();
  const card = new FloatingCard();
  const hint = new HintCard(HINT);
  const hud = new Hud(session);
  const panel = new ReportPanel();
  const toolbar = new Toolbar((tool) => pickTool(tool));
  root.append(hud.root, toolbar.root, panel.root, hint.root, toasts.root, card.root);

  const autosave = () => writeSave(AUTOSAVE_KEY, session.state);
  const replaceGame = (state: GameState, message: string) => {
    session.replace(state);
    toasts.show(message, true);
  };
  const menu = new Menu(hud.menuButton, {
    newGame: () => {
      // Drop ?seed so a reload resumes this game from the autosave.
      window.history.replaceState(null, '', window.location.pathname);
      replaceGame(newGame(randomSeed()), 'A new town to wire up!');
      autosave();
    },
    save: () => {
      const ok = writeSave(SAVE_KEY, session.state);
      toasts.show(ok ? 'Game saved' : 'Could not save: browser storage is unavailable', ok);
    },
    load: () => {
      const saved = readSave(SAVE_KEY);
      if (saved) replaceGame(saved, 'Saved game loaded');
      else toasts.show('No saved game yet', false);
    },
    exportFile: () => exportSave(session.state),
    importFile: (file) => {
      importSave(file).then(
        (state) => replaceGame(state, `Imported ${state.city.name}`),
        (err: unknown) => toasts.show(`Could not import: ${err instanceof Error ? err.message : 'unreadable file'}`, false),
      );
    },
  });
  hud.root.append(menu.root);

  const fitCamera = () => {
    camera.setViewport(window.innerWidth, window.innerHeight);
    camera.setBounds(scene.bounds(session.state.city));
    camera.fit(fitInsets(), scene.townBounds(session.state.city));
  };
  const fitInsets = (): Insets => {
    const vh = window.innerHeight;
    const hudBox = hud.root.getBoundingClientRect();
    const bar = toolbar.root.getBoundingClientRect();
    const report = panel.root.getBoundingClientRect();
    // At phone width the toolbar and report sit along the bottom.
    if (bar.top > vh / 2) return { top: hudBox.bottom + 8, right: 8, bottom: vh - Math.min(bar.top, report.top) + 8, left: 8 };
    return { top: hudBox.bottom + 12, right: 12, bottom: 12, left: bar.right + 12 };
  };

  session.onMonthClosed((report) => {
    autosave();
    toasts.show(
      `${formatMonth(report.year, report.month)} closed: net ${formatSignedMoney(report.net)}, ${formatNumber(report.passings)} passings`,
      true,
      'month',
    );
  });
  session.onReplaced(() => {
    tools.cancel();
    scene.sync(session.state);
    fitCamera();
  });

  function pickTool(tool: ToolId): void {
    tools.setTool(tool);
    toolbar.select(tool);
    scene.setPoleOverlay(tool === 'aerial');
  }

  const pointer = { x: 0, y: 0, onMap: false };
  new Input(app.canvas, camera, theme.cell, {
    hover(grid, screen, touch) {
      if (touch !== undefined) tools.touch = touch;
      pointer.x = screen.x;
      pointer.y = screen.y;
      pointer.onMap = grid !== null;
      if (grid) tools.hoverAt(grid.x, grid.y);
      else tools.clearHover();
    },
    click(grid, touch) {
      const dispatch = (cmd: Command) => session.dispatch(cmd);
      tools.touch = touch;
      const outcome = touch ? tools.tap(session.state, dispatch, grid.x, grid.y) : tools.click(session.state, dispatch, grid.x, grid.y);
      if (!outcome) return;
      toasts.show(outcome.message, outcome.ok);
      if (outcome.ok) hint.hide();
    },
    cancel() {
      if (menu.isOpen) {
        menu.close();
        return true;
      }
      return tools.cancel();
    },
    escape() {
      if (tools.tool !== 'inspect') pickTool('inspect');
    },
    pickTool,
    currentTool: () => tools.tool,
    setSpeed: (speed) => session.setSpeed(speed),
    togglePause: () => session.togglePause(),
  });

  window.addEventListener('resize', () => camera.setViewport(window.innerWidth, window.innerHeight));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave();
  });

  const counters = { frames: 0, renders: 0 };
  window.__lst = {
    getState: () => session.state,
    dispatch: (cmd) => session.dispatch(cmd),
    tick: (days = 1) => session.advanceDays(days),
    setSpeed: (speed) => session.setSpeed(speed),
    worldToScreen: (x, y) => {
      const p = camera.worldToScreen(x * theme.cell, y * theme.cell);
      const r = app.canvas.getBoundingClientRect();
      return { x: p.x + r.left, y: p.y + r.top };
    },
    screenToWorld: (x, y) => {
      const r = app.canvas.getBoundingClientRect();
      const p = camera.screenToWorld(x - r.left, y - r.top);
      return { x: p.x / theme.cell, y: p.y / theme.cell };
    },
    stats: () => ({ ...counters }),
  };

  scene.sync(session.state);
  pickTool('inspect');
  fitCamera();

  let last = performance.now();
  const frame = (now: number) => {
    session.update((now - last) / 1000);
    last = now;
    const state = session.state;
    scene.sync(state);
    const view = tools.view(state);
    scene.setOverlay(view.overlay);
    card.render(pointer.onMap ? view.card : null, pointer.x, pointer.y, window.innerWidth, window.innerHeight);
    hud.update(session);
    panel.update(state);
    scene.applyCamera(camera);
    scene.animate(now);
    counters.frames++;
    if (scene.takeDirty()) {
      counters.renders++;
      app.render();
    }
    window.requestAnimationFrame(frame);
  };
  window.requestAnimationFrame(frame);
}

boot().catch((err: unknown) => {
  const root = document.getElementById('app') ?? document.body;
  root.append(
    el('p', { class: 'boot-error', text: `Light Speed Tycoon could not start: ${err instanceof Error ? err.message : String(err)}` }),
  );
  throw err;
});
