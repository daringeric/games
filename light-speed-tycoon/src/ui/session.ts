// The running game: owns the GameState, the clock speed, and the only paths by
// which the UI changes state (commands and ticks).

import { applyCommand, tick } from '../sim/game';
import type { Command, CommandResult, GameState, MonthlyReport } from '../sim/types';

export type Speed = 0 | 1 | 2 | 4;
export const SPEEDS: readonly Speed[] = [0, 1, 2, 4];

/** Longest frame gap the clock will catch up on (a background tab shouldn't fast-forward months). */
const MAX_FRAME_SECONDS = 0.25;

export class GameSession {
  speed: Speed = 0;
  /** Speed to resume when unpausing. */
  private resumeSpeed: Exclude<Speed, 0> = 1;
  /** Fraction of a day accumulated toward the next tick. */
  private carry = 0;
  private readonly monthListeners: ((report: MonthlyReport) => void)[] = [];
  private readonly replaceListeners: (() => void)[] = [];

  constructor(public state: GameState) {}

  dispatch(cmd: Command): CommandResult {
    return applyCommand(this.state, cmd);
  }

  /** Advance whole days immediately, regardless of speed. */
  advanceDays(days: number): void {
    for (let i = 0; i < days; i++) {
      const before = this.state.finance.reports.length;
      tick(this.state);
      const reports = this.state.finance.reports;
      if (reports.length > before) {
        const report = reports[reports.length - 1];
        if (report) for (const fn of this.monthListeners) fn(report);
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

  setSpeed(speed: Speed): void {
    this.speed = speed;
    if (speed !== 0) this.resumeSpeed = speed;
    else this.carry = 0;
  }

  togglePause(): void {
    this.setSpeed(this.speed === 0 ? this.resumeSpeed : 0);
  }

  replace(state: GameState): void {
    this.state = state;
    this.carry = 0;
    this.setSpeed(0);
    for (const fn of this.replaceListeners) fn();
  }

  onMonthClosed(fn: (report: MonthlyReport) => void): void {
    this.monthListeners.push(fn);
  }

  onReplaced(fn: () => void): void {
    this.replaceListeners.push(fn);
  }
}
