// window.__lst: the test and debugging hook. Installed only in dev builds or
// when the page URL carries debug=1, so a production page offers no console
// shortcut to rewrite the game. Playwright opens every page with ?debug=1.
//
// Owner: ui-economy workstream.

import type { SceneStats } from '../render/scene';
import type { Command, CommandResult, GameState } from '../sim/types';
import type { BriefingSetting } from './briefing';
import type { Speed } from './session';

/** Test and debugging hook. Coordinates are map grid units and CSS client pixels. */
export interface DebugHook {
  getState(): GameState;
  dispatch(cmd: Command): CommandResult;
  tick(days?: number): void;
  setSpeed(speed: Speed): void;
  worldToScreen(x: number, y: number): { x: number; y: number };
  screenToWorld(x: number, y: number): { x: number; y: number };
  /**
   * Frame-loop counters (animation frames run, and how many of them drew the
   * map) and what the map shows (Scene.stats(): lots drawn as passed, live
   * spans drawn, live cable redraws, and whatever else the scene reports).
   */
  stats(): { frames: number; renders: number } & SceneStats;
  /**
   * Round 4: switch this page's month-end briefing to a frequency
   * ('monthly' | 'quarterly' | 'attention') or 'off', without storing it as
   * the player's preference. Debug pages start with briefings off unless the
   * URL has ?briefing=1 (the stored preference) or ?briefing=<frequency>.
   */
  setBriefing(setting: BriefingSetting): void;
  /** Round 4: whether the month-end briefing sheet is open (round 4c/4d: not the full books the report panel opens on their own). */
  briefingOpen(): boolean;
  /**
   * Round 4b: whether the start screen is open. Debug pages skip it on a
   * first launch (and on a fresh ?seed link) unless the URL has ?start=1
   * (see START_PARAM); the menu's New game and the game-over dialog show it
   * on every page.
   */
  startScreenOpen(): boolean;
  /** Round 4c/4d: whether the Customers dashboard is open. */
  customersOpen(): boolean;
}

declare global {
  interface Window {
    __lst?: DebugHook;
  }
}

/** The URL flag that turns the hook on in a production build. */
export const DEBUG_PARAM = 'debug';

/** Round 4b: on a debug page, ?start=1 shows the first-launch start screen that debug pages otherwise skip. */
export const START_PARAM = 'start';

/**
 * Round 4b: whether a page with no game to resume shows the start screen
 * (true), or starts a Seed-round game with the default company name at once
 * (false: debug pages, which every e2e test opens, unless ?start=1).
 */
export function showsFirstLaunchStart(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get(DEBUG_PARAM) !== '1' || params.get(START_PARAM) === '1';
}

/** Whether to expose the hook: always in dev, else only with debug=1 in the query string. */
export function debugHookEnabled(search: string, dev: boolean): boolean {
  return dev || new URLSearchParams(search).get(DEBUG_PARAM) === '1';
}

/** Install the hook on window when this page may have it; returns whether it did. */
export function installDebugHook(hook: DebugHook): boolean {
  if (!debugHookEnabled(window.location.search, import.meta.env.DEV)) return false;
  window.__lst = hook;
  return true;
}

/**
 * The query string to keep when the game in play changes: drop ?seed (the
 * new game is the main one now), keep everything else, debug=1 included, so a
 * reload still has the hook. Returns '' or a string starting with '?'.
 */
export function searchWithoutSeed(search: string): string {
  const params = new URLSearchParams(search);
  params.delete('seed');
  const query = params.toString();
  return query ? `?${query}` : '';
}
