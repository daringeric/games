// window.__lst: the test and debugging hook. Installed only in dev builds or
// when the page URL carries debug=1, so a production page offers no console
// shortcut to rewrite the game. Playwright opens every page with ?debug=1.
//
// Owner: ui-economy workstream.

import type { SceneStats } from '../render/scene';
import type { Command, CommandResult, GameState } from '../sim/types';
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
}

declare global {
  interface Window {
    __lst?: DebugHook;
  }
}

/** The URL flag that turns the hook on in a production build. */
export const DEBUG_PARAM = 'debug';

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
