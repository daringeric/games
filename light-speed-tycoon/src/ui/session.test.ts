import { describe, expect, it } from 'vitest';
import { newGame } from '../sim/game';
import { makeGridCity } from '../sim/testing/fixtures';
import type { MonthlyReport } from '../sim/types';
import { GameSession } from './session';

const session = () => new GameSession(newGame(3, { city: makeGridCity() }));

describe('GameSession clock', () => {
  it('starts paused and does not advance while paused', () => {
    const s = session();
    expect(s.speed).toBe(0);
    s.update(10);
    expect(s.state.day).toBe(0);
  });

  it('runs one day per second at 1x, carrying fractions between frames', () => {
    const s = session();
    s.setSpeed(1);
    for (let i = 0; i < 60; i++) s.update(1 / 60);
    expect(s.state.day).toBe(1);
    s.setSpeed(4);
    for (let i = 0; i < 30; i++) s.update(1 / 60);
    expect(s.state.day).toBe(3);
  });

  it('does not fast-forward through a long frame gap', () => {
    const s = session();
    s.setSpeed(4);
    s.update(60);
    expect(s.state.day).toBe(1);
  });

  it('toggles pause back to the last speed', () => {
    const s = session();
    s.setSpeed(2);
    s.togglePause();
    expect(s.speed).toBe(0);
    s.togglePause();
    expect(s.speed).toBe(2);
  });

  it('reports each closed month', () => {
    const s = session();
    const months: MonthlyReport[] = [];
    s.onMonthClosed((r) => months.push(r));
    s.advanceDays(59);
    expect(months.map((r) => r.month)).toEqual([1, 2]);
  });

  it('replaces the game paused and tells listeners', () => {
    const s = session();
    let replaced = 0;
    s.onReplaced(() => replaced++);
    s.setSpeed(4);
    const next = newGame(4, { city: makeGridCity() });
    s.replace(next);
    expect(s.state).toBe(next);
    expect(s.speed).toBe(0);
    expect(replaced).toBe(1);
  });

  it('dispatches commands through the sim', () => {
    const s = session();
    expect(s.dispatch({ type: 'placeCabinet', node: 0 }).ok).toBe(true);
    expect(s.state.network.cabinets).toHaveLength(1);
  });
});
