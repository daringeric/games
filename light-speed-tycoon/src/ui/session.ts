// The running game: owns the GameState, the clock speed, and the only paths by
// which the UI changes state (commands and ticks). It also relays what the sim
// has to say: closed months, new notices, and the end of the game.
//
// Owner: ui-economy workstream.

import { applyCommand, tick } from '../sim/game';
import { noticesAfter } from '../sim/notices';
import type { Command, CommandResult, GameOver, GameState, MonthlyReport, Notice } from '../sim/types';

export type Speed = 0 | 1 | 2 | 4;
export const SPEEDS: readonly Speed[] = [0, 1, 2, 4];

/** Longest frame gap the clock will catch up on (a background tab shouldn't fast-forward months). */
const MAX_FRAME_SECONDS = 0.25;

/** The newest notice id a state has ever issued (0 when none): history the player has already seen. */
export function latestNoticeId(state: GameState): number {
  let latest = Math.max(0, state.nextNoticeId - 1);
  for (const notice of state.notices) if (notice.id > latest) latest = notice.id;
  return latest;
}

export class GameSession {
  speed: Speed = 0;
  /**
   * Bumped by every tick, command and replace: per-frame views can skip work
   * (walking every subscriber, say) while it is unchanged.
   */
  revision = 0;
  /** Speed to resume when unpausing. */
  private resumeSpeed: Exclude<Speed, 0> = 1;
  /** Fraction of a day accumulated toward the next tick. */
  private carry = 0;
  /** Highest notice id already handed to the notice listeners. */
  private lastNoticeId: number;
  private readonly monthListeners: ((report: MonthlyReport) => void)[] = [];
  private readonly replaceListeners: (() => void)[] = [];
  private readonly noticeListeners: ((notice: Notice) => void)[] = [];
  private readonly gameOverListeners: ((over: GameOver) => void)[] = [];

  constructor(public state: GameState) {
    // Notices already in a loaded game are history, not news.
    this.lastNoticeId = latestNoticeId(state);
  }

  /** True once the game has ended (insolvency): the clock stays stopped and the sim rejects every command. */
  get isOver(): boolean {
    return this.state.gameOver !== null;
  }

  dispatch(cmd: Command): CommandResult {
    const result = applyCommand(this.state, cmd);
    this.revision++;
    this.flushNotices();
    return result;
  }

  /** Advance whole days immediately, regardless of speed (stops early if the game ends). */
  advanceDays(days: number): void {
    for (let i = 0; i < days && !this.state.gameOver; i++) {
      const state = this.state;
      const before = state.finance.reports.length;
      tick(state);
      this.revision++;
      const reports = state.finance.reports;
      if (reports.length > before) {
        const report = reports[reports.length - 1];
        if (report) for (const fn of this.monthListeners) fn(report);
      }
      this.flushNotices();
      // A listener may have replaced the game; only the game that ticked can end here.
      if (state === this.state && state.gameOver) {
        this.halt();
        for (const fn of this.gameOverListeners) fn(state.gameOver);
      }
    }
  }

  /** Called every animation frame with the elapsed real time. One day per second at 1x. */
  update(seconds: number): void {
    if (this.speed === 0) return;
    this.carry += Math.min(seconds, MAX_FRAME_SECONDS) * this.speed;
    const days = Math.floor(this.carry);
    this.carry -= days;
    if (days > 0) this.advanceDays(days);
  }

  /** Change the clock speed. A no-op once the game is over: the day is frozen. */
  setSpeed(speed: Speed): void {
    if (this.state.gameOver) {
      this.halt();
      return;
    }
    this.speed = speed;
    if (speed !== 0) this.resumeSpeed = speed;
    else this.carry = 0;
  }

  togglePause(): void {
    this.setSpeed(this.speed === 0 ? this.resumeSpeed : 0);
  }

  /** Put another game in play, paused. Its notice history is not re-announced. */
  replace(state: GameState): void {
    this.state = state;
    this.halt();
    this.lastNoticeId = latestNoticeId(state);
    this.revision++;
    for (const fn of this.replaceListeners) fn();
  }

  onMonthClosed(fn: (report: MonthlyReport) => void): void {
    this.monthListeners.push(fn);
  }

  onReplaced(fn: () => void): void {
    this.replaceListeners.push(fn);
  }

  /** Every notice the sim posts from now on, once each, oldest first (after each tick and each command). */
  onNotice(fn: (notice: Notice) => void): void {
    this.noticeListeners.push(fn);
  }

  /** The game in play just ended during a tick (the clock is already stopped). Not called for a game loaded already over. */
  onGameOver(fn: (over: GameOver) => void): void {
    this.gameOverListeners.push(fn);
  }

  private halt(): void {
    this.speed = 0;
    this.carry = 0;
  }

  private flushNotices(): void {
    for (const notice of noticesAfter(this.state, this.lastNoticeId)) {
      // Mark it seen first, so a listener that dispatches (and so flushes) cannot hear it twice.
      if (notice.id <= this.lastNoticeId) continue;
      this.lastNoticeId = notice.id;
      for (const fn of this.noticeListeners) fn(notice);
    }
  }
}
