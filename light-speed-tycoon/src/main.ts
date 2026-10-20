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
import { confirmDialog } from './ui/confirm';
import { Menu } from './ui/menu';
import { FloatingCard, HintCard, Toasts } from './ui/overlays';
import { ReportPanel } from './ui/panel';
import { GameSession } from './ui/session';
import type { Speed } from './ui/session';
import { AUTOSAVE_KEY, SAVE_KEY, SEED_AUTOSAVE_KEY, exportSave, importSave, readSave, removeSave, writeSave } from './ui/storage';
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
  /**
   * Frame-loop counters (animation frames run, and how many of them drew the
   * map) and what the map shows: lots drawn as passed, live spans drawn, and
   * how many times the live cable was redrawn.
   */
  stats(): { frames: number; renders: number; passedLots: number; liveSpans: number; liveRedraws: number };
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

interface Opening {
  state: GameState;
  /** Where the game autosaves. */
  autosaveKey: string;
  /** The game was resumed from that autosave rather than started fresh. */
  resumed: boolean;
}

/**
 * ?seed=N plays that town in an autosave of its own (or in the main one, if
 * that already holds it), so a reload resumes it and visiting a seed link never
 * overwrites the main game. Otherwise resume the main autosave, else start a
 * random town.
 */
function openGame(): Opening {
  const param = new URLSearchParams(window.location.search).get('seed');
  if (param !== null && /^\d+$/.test(param)) {
    // newGame keeps the seed as a uint32.
    const seed = Number(param) >>> 0;
    for (const key of [SEED_AUTOSAVE_KEY, AUTOSAVE_KEY]) {
      const saved = readSave(key);
      if (saved?.seed === seed) return { state: saved, autosaveKey: key, resumed: true };
    }
    return { state: newGame(seed), autosaveKey: SEED_AUTOSAVE_KEY, resumed: false };
  }
  const saved = readSave(AUTOSAVE_KEY);
  return { state: saved ?? newGame(randomSeed()), autosaveKey: AUTOSAVE_KEY, resumed: saved !== null };
}

/** The autosave this boot resumed, so a failed boot can offer to discard it. */
let resumedFrom: string | null = null;

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

  const opening = openGame();
  if (opening.resumed) resumedFrom = opening.autosaveKey;
  let autosaveKey = opening.autosaveKey;
  const session = new GameSession(opening.state);
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

  const autosave = () => writeSave(autosaveKey, session.state);
  /**
   * Put a new, loaded or imported game in play; false if it can't be shown, in
   * which case the current game stays and a toast says why. The game in play
   * becomes the main one: ?seed is dropped so a reload resumes it from the
   * main autosave.
   */
  const replaceGame = (state: GameState, message: string): boolean => {
    const previous = session.state;
    try {
      session.replace(state);
    } catch (err) {
      session.replace(previous);
      toasts.show(`Could not open that game: ${err instanceof Error ? err.message : String(err)}`, false);
      return false;
    }
    window.history.replaceState(null, '', window.location.pathname);
    autosaveKey = AUTOSAVE_KEY;
    toasts.show(message, true);
    return true;
  };
  /** Ask before anything replaces the town in play; it is autosaved over, so there's no undo. */
  const confirmReplace = (confirmLabel: string, detail: string) =>
    confirmDialog({ title: `Replace ${session.state.city.name}?`, detail, confirmLabel });
  const menu = new Menu(hud.menuButton, {
    newGame: () => {
      void confirmReplace('Start a new town', 'Your current town will be replaced by a fresh one. Save or export first if you want to come back to it.').then((yes) => {
        if (yes && replaceGame(newGame(randomSeed()), 'A new town to wire up!')) autosave();
      });
    },
    save: () => {
      const ok = writeSave(SAVE_KEY, session.state);
      toasts.show(ok ? 'Game saved' : 'Could not save: browser storage is unavailable', ok);
    },
    load: () => {
      const saved = readSave(SAVE_KEY);
      if (!saved) {
        toasts.show('No saved game yet', false);
        return;
      }
      void confirmReplace('Load saved game', `Your current town will be replaced by your last save (${saved.city.name}).`).then((yes) => {
        if (yes) replaceGame(saved, 'Saved game loaded');
      });
    },
    exportFile: () => exportSave(session.state),
    importFile: (file) => {
      importSave(file).then(
        (state) =>
          confirmReplace('Open imported game', `Your current town will be replaced by ${state.city.name} from ${file.name}.`).then((yes) => {
            if (yes) replaceGame(state, `Imported ${state.city.name}`);
          }),
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
    stats: () => ({ ...counters, ...scene.stats() }),
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
  const message = el('div', { class: 'boot-error pill-card', attrs: { role: 'alert' } }, [
    el('p', { text: `Light Speed Tycoon could not start: ${err instanceof Error ? err.message : String(err)}` }),
  ]);
  // A saved town that breaks the game would break every visit: offer a way past it.
  const saved = resumedFrom;
  if (saved !== null) {
    message.append(
      el('p', { class: 'boot-error-detail', text: 'If your saved town is the trouble, you can discard it and start over.' }),
      el('button', {
        class: 'btn boot-error-reset',
        text: 'Discard it and start a new town',
        attrs: { type: 'button' },
        on: {
          click: () => {
            removeSave(saved);
            window.location.reload();
          },
        },
      }),
    );
  }
  // Clear the half-built game: the map canvas would cover the message.
  root.replaceChildren(message);
  throw err;
});
