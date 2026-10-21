// Entry point: boot the game, wire the scene, camera, HUD, map controls and
// menus, the month-end briefing (round 4), the start screen (round 4b), and
// run the frame loop.
//
// Owner: start-screen workstream (round 4b); ui-economy before. Map
// interaction (tools, input, map panels) lives behind MapControls
// (ui-build-tools); this file only places its DOM and calls it each frame.

import './ui/style.css';
import './ui/mapTools.css';
// Round 4: each workstream's styles, after the frozen style.css.
import './ui/bank.css';
import './ui/pricing.css';
import './ui/storms.css';
import './ui/briefing.css';
import './ui/startScreen.css';
import { Application } from 'pixi.js';
import { buildBriefing } from './sim/advisor';
import { MONTH_ABBR, dateOf } from './sim/calendar';
import { newGame } from './sim/game';
import type { AdviceAction, Briefing, GameState } from './sim/types';
import { Camera } from './render/camera';
import type { Insets } from './render/camera';
import { Scene } from './render/scene';
import { toyTown } from './render/theme';
import type { Theme } from './render/theme';
import { BankPanel, isBankNotice, noticeHeadline } from './ui/bankPanel';
import {
  BriefingPreference,
  BriefingSheet,
  PlaceHighlight,
  QUARTER_MONTHS,
  actionPoint,
  briefingAtClose,
  readBriefingFrequency,
  startingBriefingSetting,
} from './ui/briefing';
import { confirmDialog } from './ui/confirm';
import { installDebugHook, searchWithoutSeed, showsFirstLaunchStart } from './ui/debugHook';
import { el } from './ui/dom';
import { GameOverDialog } from './ui/gameOverDialog';
import { Hud } from './ui/hud';
import { MapControls } from './ui/mapControls';
import { Menu } from './ui/menu';
import { MilestonesPanel } from './ui/milestonesPanel';
import { HintCard, Toasts, noticeTone } from './ui/overlays';
import { ReportPanel, monthClosedMessage, monthClosedTone } from './ui/panel';
import { PricingPanel } from './ui/pricingPanel';
import { RateCard } from './ui/rateCard';
import { GameSession, describeGame, latestNoticeId, replaceTitle } from './ui/session';
import { StartScreen } from './ui/startScreen';
import type { StartChoice } from './ui/startScreen';
import {
  AUTOSAVE_KEY,
  SAVE_KEY,
  SEED_AUTOSAVE_KEY,
  exportSave,
  hasSave,
  importSave,
  readSave,
  removeSave,
  writeSave,
} from './ui/storage';
import { applyThemeCss } from './ui/themeCss';

const HINT = 'Lay fiber out from the CO, then drop a cabinet to light homes.';
/** Screens narrow enough that a full debt notice toast would cover most of the map. */
const NARROW_TOASTS = '(max-width: 600px)';
/** How long "Show me" takes to glide the map to the place (instant with reduced motion). */
const SHOW_ME_GLIDE_MS = 450;

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
  /**
   * Round 4b: there is no game to resume, so `state` is only a preview of the
   * town on offer (paused, never autosaved) under the start screen; null
   * when the game starts at once (a resumed game, or a debug page without
   * ?start=1). `fixedSeed`: a ?seed link, so the town cannot be rerolled.
   */
  start: { fixedSeed: boolean } | null;
}

/**
 * ?seed=N plays that town in an autosave of its own (or in the main one, if
 * that already holds it), so a reload resumes it and visiting a seed link never
 * overwrites the main game. Otherwise resume the main autosave, else offer a
 * random town. A town not resumed opens under the start screen (round 4b),
 * except on debug pages, which start it at once as a Seed-round game with the
 * default company name unless the URL has ?start=1.
 */
function openGame(): Opening {
  const search = window.location.search;
  const showStart = showsFirstLaunchStart(search);
  const param = new URLSearchParams(search).get('seed');
  if (param !== null && /^\d+$/.test(param)) {
    // newGame keeps the seed as a uint32.
    const seed = Number(param) >>> 0;
    for (const key of [SEED_AUTOSAVE_KEY, AUTOSAVE_KEY]) {
      const saved = readSave(key);
      if (saved?.seed === seed) return { state: saved, autosaveKey: key, resumed: true, start: null };
    }
    return { state: newGame(seed), autosaveKey: SEED_AUTOSAVE_KEY, resumed: false, start: showStart ? { fixedSeed: true } : null };
  }
  const saved = readSave(AUTOSAVE_KEY);
  if (saved) return { state: saved, autosaveKey: AUTOSAVE_KEY, resumed: true, start: null };
  return { state: newGame(randomSeed()), autosaveKey: AUTOSAVE_KEY, resumed: false, start: showStart ? { fixedSeed: false } : null };
}

/** The name of the town a seed generates (the same town at every difficulty). */
function townOf(seed: number): string {
  return newGame(seed).city.name;
}

/** The game the start screen's choice makes. */
function gameFor(choice: StartChoice): GameState {
  return newGame(choice.seed, { difficulty: choice.difficulty, companyName: choice.companyName });
}

/** The toast that greets a game started from the start screen. */
function welcome(state: GameState): string {
  return `${state.company.name} is open for business in ${state.city.name}!`;
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
  const toasts = new Toasts();
  const hint = new HintCard(HINT);
  const pricing = new PricingPanel(session, toasts);
  const bank = new BankPanel(session, toasts);
  const milestones = new MilestonesPanel(() => session.state);
  const rateCard = new RateCard();
  const gameOver = new GameOverDialog();
  const startScreen = new StartScreen();
  const hud = new Hud(session, { pricing: () => pricing.open(), milestones: () => milestones.open(), bank: () => bank.open() });
  const panel = new ReportPanel();
  const controls = new MapControls({ canvas: app.canvas, camera, theme, scene, session, toasts, hint });
  const toolbar = controls.toolbar;
  root.append(hud.root, toolbar.root, panel.root, hint.root, toasts.root, controls.card.root);

  /** A map point (grid units) in CSS client pixels. */
  const worldToClient = (x: number, y: number) => {
    const p = camera.worldToScreen(x * theme.cell, y * theme.cell);
    const r = app.canvas.getBoundingClientRect();
    return { x: p.x + r.left, y: p.y + r.top };
  };

  // Cards that sit under the HUD (the tip, the short-screen toolbar, the menu) follow its height.
  const publishHudBottom = () =>
    document.documentElement.style.setProperty('--hud-bottom', `${Math.round(hud.root.getBoundingClientRect().bottom)}px`);
  hud.update(session);
  publishHudBottom();
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(publishHudBottom).observe(hud.root);

  // Toasts keep clear of the report panel (it grows when opened or when a month closes) and the toolbar.
  const box = (e: HTMLElement) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom } : null;
  };
  const placeToasts = () =>
    toasts.keepClear({
      viewW: window.innerWidth,
      viewH: window.innerHeight,
      hudBottom: hud.root.getBoundingClientRect().bottom,
      panel: box(panel.root),
      toolbar: box(toolbar.root),
    });
  placeToasts();
  window.addEventListener('resize', placeToasts);
  if (typeof ResizeObserver !== 'undefined') {
    const watch = new ResizeObserver(placeToasts);
    for (const el of [panel.root, toolbar.root, hud.root]) watch.observe(el);
  }

  /** Round 4b: the game in play is only the start screen's preview of a town (never autosaved). */
  let previewing = false;
  /**
   * Round 4b review: while previewing, the HUD's company and cash are the
   * preview's (the town's default name, the Seed round's purse), not the
   * company being chosen on the screen in front: hidden until Start.
   */
  const setPreviewing = (on: boolean) => {
    previewing = on;
    hud.root.classList.toggle('hud-previewing', on);
  };
  setPreviewing(opening.start !== null);
  const autosave = () => {
    if (!previewing) writeSave(autosaveKey, session.state);
  };
  /**
   * Put a new, loaded or imported game in play; false if it can't be shown, in
   * which case the current game stays and a toast says why. The game in play
   * becomes the main one: ?seed is dropped (debug=1 stays) so a reload resumes
   * it from the main autosave. (`keepKey`: a game started under the start
   * screen at boot keeps the autosave it opened with, so a fresh ?seed link
   * still never overwrites the main game.)
   */
  const replaceGame = (state: GameState, message: string, keepKey = false): boolean => {
    const previous = session.state;
    try {
      session.replace(state);
    } catch (err) {
      session.replace(previous);
      toasts.show(`Could not open that game: ${err instanceof Error ? err.message : String(err)}`, false);
      return false;
    }
    if (!keepKey) {
      window.history.replaceState(null, '', `${window.location.pathname}${searchWithoutSeed(window.location.search)}`);
      autosaveKey = AUTOSAVE_KEY;
    }
    setPreviewing(false);
    toasts.show(message, true);
    return true;
  };
  /**
   * Round 4b: the start screen for a new game in place of the one in play
   * (the menu's New game, the game-over dialog). The clock stops while it is
   * up; Start replaces the game, Esc or Back calls `back` with the game in
   * play untouched.
   */
  const chooseNewGame = (back: () => void) => {
    session.interrupt();
    startScreen.open({
      seed: randomSeed(),
      townName: townOf,
      newSeed: randomSeed,
      onStart: (choice) => {
        const state = gameFor(choice);
        if (replaceGame(state, welcome(state))) autosave();
        else back();
      },
      onCancel: back,
    });
  };
  /** The game-over dialog's "Start a new town": the start screen, and back to the dialog if cancelled. */
  const startNewTown = () => {
    gameOver.close();
    chooseNewGame(() => {
      session.resume();
      showGameOver();
    });
  };
  const loadSave = (saved: GameState) => replaceGame(saved, 'Saved game loaded');
  /** Ask before anything replaces the game in play; it is autosaved over, so there's no undo. */
  const confirmReplace = (confirmLabel: string, detail: string) => confirmDialog({ title: replaceTitle(session.state), detail, confirmLabel });
  const menu = new Menu(hud.menuButton, {
    newGame: () => {
      const current = session.state.company.name;
      void confirmReplace(
        'Start a new town',
        `${current} will be replaced by a new company in a fresh town. Save or export first if you want to come back to it.`,
      ).then((yes) => {
        // Back from the start screen: the same game, its clock as it was.
        if (yes) chooseNewGame(() => session.resume());
      });
    },
    save: () => {
      // A bankrupt town would overwrite the save the game-over dialog offers to go back to.
      if (session.isOver) {
        toasts.show('This town is bankrupt, so it was not saved over your last save. Export it to keep it.', 'warn');
        return;
      }
      const ok = writeSave(SAVE_KEY, session.state);
      toasts.show(ok ? 'Game saved' : 'Could not save: browser storage is unavailable', ok);
    },
    load: () => {
      const saved = readSave(SAVE_KEY);
      if (!saved) {
        toasts.show('No saved game yet', false);
        return;
      }
      void confirmReplace('Load saved game', `Your current game will be replaced by your last save: ${describeGame(saved)}.`).then((yes) => {
        if (yes) loadSave(saved);
      });
    },
    exportFile: () => exportSave(session.state),
    importFile: (file) => {
      importSave(file).then(
        (state) =>
          confirmReplace('Open imported game', `Your current game will be replaced by ${describeGame(state)} from ${file.name}.`).then((yes) => {
            if (yes) replaceGame(state, `Imported ${state.company.name} (${state.city.name})`);
          }),
        (err: unknown) => toasts.show(`Could not import: ${err instanceof Error ? err.message : 'unreadable file'}`, false),
      );
    },
    briefing: () => reopenBriefing(),
    rateCard: () => rateCard.open(),
  });
  hud.root.append(menu.root);

  /** The game in play has ended: stop everything and offer a way on. */
  const showGameOver = () => {
    const over = session.state.gameOver;
    if (!over) {
      gameOver.close();
      return;
    }
    controls.reset();
    pricing.close();
    bank.close();
    milestones.close();
    rateCard.close();
    briefing.dismiss();
    if (menu.isOpen) menu.close();
    gameOver.show(over, session.state.company.name, {
      loadLastSave: hasSave(SAVE_KEY)
        ? () => {
            const saved = readSave(SAVE_KEY);
            if (saved) loadSave(saved);
            else toasts.show('Your last save could not be read', false);
          }
        : undefined,
      startNewTown,
      exportGame: () => exportSave(session.state),
    });
  };

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

  // Round 4: the month-end briefing. How often it shows is a per-browser
  // preference (never game state); ?debug=1 pages start with it off.
  const briefingPref = new BriefingPreference(startingBriefingSetting(window.location.search, readBriefingFrequency()));
  const highlight = new PlaceHighlight(worldToClient);
  /** Notices up to this id are listed in the open briefing: they are not toasted as well. */
  let briefingNotices = 0;
  /** The middle of the map area the HUD, toolbar and report leave free, in canvas pixels. */
  const mapFocus = () => {
    const insets = fitInsets();
    const r = app.canvas.getBoundingClientRect();
    return {
      x: insets.left + Math.max(0, r.width - insets.left - insets.right) / 2,
      y: insets.top + Math.max(0, r.height - insets.top - insets.bottom) / 2,
    };
  };
  /** An advice's "Show me": glide the map to the place and ring it, or open the panel. */
  const showMe = (action: AdviceAction) => {
    if (action.kind === 'openPanel') {
      if (action.panel === 'pricing') pricing.open();
      else if (action.panel === 'bank') bank.open();
      else controls.olt.open(session.state);
      return;
    }
    const point = actionPoint(session.state, action);
    if (!point) {
      toasts.show('That place is no longer on the map.', 'warn');
      return;
    }
    const still = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const focus = mapFocus();
    camera.glideTo(point.x * theme.cell, point.y * theme.cell, performance.now(), still ? 0 : SHOW_ME_GLIDE_MS, focus.x, focus.y);
    highlight.show(point.x, point.y);
  };
  const briefing = new BriefingSheet({
    preference: briefingPref,
    // Continue (or Esc, or the backdrop): back to the speed the player had.
    onContinue: () => session.resume(),
    onAction: (action) => {
      // Show me leaves the game paused; play picks up the speed the player had.
      session.setSpeed(0);
      showMe(action);
    },
    onStoreFailed: () => toasts.show('Browser storage is unavailable, so that choice lasts until you reload.', 'warn'),
    // Round 4b: snoozes and the shown-suggestions record go through the session like every command.
    dispatch: (cmd) => session.dispatch(cmd),
    rebuild: (span) => buildBriefing(session.state, span),
  });
  /** Pause the game and show a briefing. */
  const openBriefing = (shown: Briefing) => {
    session.interrupt();
    briefingNotices = shown.report.ops?.lastNoticeId ?? latestNoticeId(session.state);
    briefing.open(shown, session.state.company.name);
  };
  /** The menu's "Latest briefing": the last close again, with today's advice and forward look. */
  const reopenBriefing = () => {
    const state = session.state;
    const last = state.finance.reports.at(-1);
    if (session.isOver) {
      showGameOver();
      return;
    }
    if (!last) {
      const now = dateOf(state.day);
      toasts.show(`No briefing yet: the first one comes at the month close on ${MONTH_ABBR[now.month % 12]} 1.`, 'warn');
      return;
    }
    const span = briefingPref.frequency === 'quarterly' && last.month % QUARTER_MONTHS === 0 ? QUARTER_MONTHS : 1;
    const shown = buildBriefing(state, span);
    if (shown) openBriefing(shown);
  };

  session.onMonthClosed((report) => {
    // Autosaves the close that ends a game too: reloading shows the game-over dialog again.
    autosave();
    // A close that ends the game shows the game-over dialog instead (briefingAtClose is null).
    const due = briefingAtClose(session.state, report, briefingPref.current);
    if (due) {
      // The briefing says it all: no month-closed toast behind it.
      openBriefing(due);
      return;
    }
    toasts.show(monthClosedMessage(report), monthClosedTone(report), 'month');
  });
  session.onNotice((notice) => {
    // The game-over dialog says it in full; a toast behind it would only repeat it.
    if (notice.kind === 'gameOver') return;
    // The open briefing lists the close's notices; later ones toast as usual.
    if (briefing.isOpen && notice.id <= briefingNotices) return;
    // On a phone a full debt notice covers most of the map: toast its headline, the Bank lists it in full.
    const narrow = typeof window.matchMedia === 'function' && window.matchMedia(NARROW_TOASTS).matches;
    toasts.show(narrow && isBankNotice(notice.kind) ? noticeHeadline(notice.message) : notice.message, noticeTone(notice));
  });
  session.onGameOver(showGameOver);
  session.onReplaced(() => {
    // The replace already paused the game: close the briefing without resuming.
    briefing.dismiss();
    highlight.clear();
    controls.reset();
    pricing.close();
    bank.close();
    milestones.close();
    scene.sync(session.state);
    fitCamera();
    showGameOver();
  });

  controls.attachInput(menu);

  window.addEventListener('resize', () => {
    camera.setViewport(window.innerWidth, window.innerHeight);
    publishHudBottom();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autosave();
  });

  const counters = { frames: 0, renders: 0 };
  installDebugHook({
    getState: () => session.state,
    dispatch: (cmd) => session.dispatch(cmd),
    tick: (days = 1) => session.advanceDays(days),
    setSpeed: (speed) => session.setSpeed(speed),
    worldToScreen: worldToClient,
    screenToWorld: (x, y) => {
      const r = app.canvas.getBoundingClientRect();
      const p = camera.screenToWorld(x - r.left, y - r.top);
      return { x: p.x / theme.cell, y: p.y / theme.cell };
    },
    stats: () => ({ ...counters, ...scene.stats() }),
    setBriefing: (setting) => briefingPref.set(setting),
    briefingOpen: () => briefing.isOpen,
    startScreenOpen: () => startScreen.isOpen,
  });

  scene.sync(session.state);
  controls.pickTool('inspect');
  fitCamera();
  // A game autosaved at the close that ended it opens on its game-over dialog.
  showGameOver();

  // Round 4b: no game to resume. The map behind the start screen shows the
  // town on offer (a paused preview, never autosaved); Start puts the game in
  // play on that same seed, so the town seen is the town played.
  if (opening.start) {
    /** The last town generated for the screen, so a reroll generates it once for its name and the map. */
    let preview = session.state;
    const previewOf = (seed: number) => {
      if (preview.seed !== seed >>> 0) preview = newGame(seed);
      return preview;
    };
    const fixedSeed = opening.start.fixedSeed;
    const offerFirstGame = () =>
      startScreen.open({
        seed: session.state.seed,
        townName: (seed) => previewOf(seed).city.name,
        newSeed: fixedSeed ? undefined : randomSeed,
        onReroll: (seed) => session.replace(previewOf(seed)),
        onStart: (choice) => {
          const state = gameFor(choice);
          // Nothing to go back to: if the game could not be shown (the toast says why), choose again.
          if (!replaceGame(state, welcome(state), true)) {
            offerFirstGame();
            return;
          }
          autosave();
          hint.show();
        },
      });
    hint.hide();
    offerFirstGame();
  }

  let last = performance.now();
  const frame = (now: number) => {
    session.update((now - last) / 1000);
    last = now;
    const state = session.state;
    scene.sync(state);
    controls.update(state);
    hud.update(session);
    panel.update(state);
    bank.update(session);
    camera.step(now);
    scene.applyCamera(camera);
    highlight.update();
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
