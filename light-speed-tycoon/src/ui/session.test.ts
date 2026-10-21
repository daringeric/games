import { describe, expect, it } from 'vitest';
import { INSOLVENCY_GRACE_MONTHS } from '../sim/balance';
import { newGame } from '../sim/game';
import { makeGridCity } from '../sim/testing/fixtures';
import type { GameOver, MonthlyReport, Notice } from '../sim/types';
import { GameSession, latestNoticeId } from './session';

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

describe('GameSession interrupt (the month-end briefing)', () => {
  it('stops a multi-day advance after the tick whose close interrupted, and stops the clock', () => {
    const s = session();
    s.setSpeed(2);
    const closes: number[] = [];
    s.onMonthClosed((r) => {
      closes.push(r.month);
      s.interrupt();
    });
    s.advanceDays(60);
    // Day 31 is Feb 1: the January close ran on that tick, and nothing after it.
    expect(s.state.day).toBe(31);
    expect(closes).toEqual([1]);
    expect(s.interrupted).toBe(true);
    expect(s.speed).toBe(0);
    // The clock stays stopped while interrupted.
    for (let i = 0; i < 20; i++) s.update(0.25);
    expect(s.state.day).toBe(31);
  });

  it('resumes the speed in effect when it interrupted', () => {
    const s = session();
    s.setSpeed(2);
    s.interrupt();
    expect(s.speed).toBe(0);
    s.resume();
    expect(s.interrupted).toBe(false);
    expect(s.speed).toBe(2);
    s.update(1);
    expect(s.state.day).toBe(0);
    for (let i = 0; i < 4; i++) s.update(0.25);
    expect(s.state.day).toBe(2);
  });

  it('remembers paused as paused, and the first speed when interrupted twice', () => {
    const s = session();
    s.interrupt();
    expect(s.interrupted).toBe(true);
    s.resume();
    expect(s.speed).toBe(0);

    s.setSpeed(4);
    s.interrupt();
    s.interrupt();
    s.resume();
    expect(s.speed).toBe(4);
    // Nothing to resume: a no-op.
    s.setSpeed(1);
    s.resume();
    expect(s.speed).toBe(1);
  });

  it('keeps the unpause speed, so play after a pause from the briefing goes back to it', () => {
    const s = session();
    s.setSpeed(2);
    s.interrupt();
    // "Show me" ends the interrupt but stays paused.
    s.setSpeed(0);
    expect(s.interrupted).toBe(false);
    s.togglePause();
    expect(s.speed).toBe(2);
  });

  it('is ended by setSpeed and replace', () => {
    const s = session();
    s.setSpeed(4);
    s.interrupt();
    s.setSpeed(1);
    expect(s.interrupted).toBe(false);
    s.resume();
    expect(s.speed).toBe(1);

    s.interrupt();
    s.replace(newGame(4, { city: makeGridCity() }));
    expect(s.interrupted).toBe(false);
    s.resume();
    expect(s.speed).toBe(0);
  });

  it('lets a later advance run in full once the briefing is dealt with', () => {
    const s = session();
    let stop = true;
    s.onMonthClosed(() => {
      if (stop) s.interrupt();
    });
    s.advanceDays(45);
    expect(s.state.day).toBe(31);
    s.resume();
    stop = false;
    s.advanceDays(45);
    expect(s.state.day).toBe(76);
  });

  it('does not resume a game that ended at the close', () => {
    const s = session();
    s.state.day = 30;
    s.state.finance.cash = -1_000_000;
    s.state.finance.negativeMonths = INSOLVENCY_GRACE_MONTHS - 1;
    s.setSpeed(2);
    s.interrupt();
    s.advanceDays(1);
    expect(s.isOver).toBe(true);
    s.resume();
    expect(s.speed).toBe(0);
  });
});

describe('GameSession notices', () => {
  /** A game whose cash is deep in the red, so every month close posts a notice. */
  const broke = () => {
    const s = session();
    s.state.finance.cash = -1_000_000;
    return s;
  };

  it('hands each new notice to listeners once, oldest first, after the tick that posted it', () => {
    const s = broke();
    const seen: Notice[] = [];
    s.onNotice((n) => seen.push(n));
    s.advanceDays(30);
    expect(seen).toEqual([]);
    s.advanceDays(1);
    expect(seen.map((n) => n.kind)).toEqual(['insolvencyWarning']);
    s.advanceDays(28);
    expect(seen.map((n) => n.kind)).toEqual(['insolvencyWarning', 'insolvencyWarning']);
    expect(seen[0]!.id).toBeLessThan(seen[1]!.id);
    expect(seen).toEqual(s.state.notices.filter((n) => n.kind === 'insolvencyWarning'));
    // Nothing new: nothing repeated.
    s.advanceDays(3);
    expect(seen).toHaveLength(2);
  });

  it('relays month closes before the notices that close posted', () => {
    const s = broke();
    const order: string[] = [];
    s.onMonthClosed((r) => order.push(`month ${r.month}`));
    s.onNotice((n) => order.push(n.kind));
    s.advanceDays(31);
    expect(order).toEqual(['month 1', 'insolvencyWarning']);
  });

  it('hands over notices a command posts', () => {
    const s = session();
    s.state.network.olt.ponPorts = 1;
    const seen: Notice[] = [];
    s.onNotice((n) => seen.push(n));
    expect(s.dispatch({ type: 'placeCabinet', node: 0 }).ok).toBe(true);
    expect(seen.map((n) => n.kind)).toEqual(['oltFull']);
    expect(s.dispatch({ type: 'placeCabinet', node: 1 }).ok).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('does not re-announce the history of a game it opens or replaces with', () => {
    const old = broke();
    old.advanceDays(59);
    expect(old.state.notices.length).toBeGreaterThanOrEqual(2);
    const history = old.state;

    const opened = new GameSession(structuredClone(history));
    const seenOpened: Notice[] = [];
    opened.onNotice((n) => seenOpened.push(n));
    opened.advanceDays(1);
    expect(seenOpened).toEqual([]);

    const s = session();
    const seen: Notice[] = [];
    s.onNotice((n) => seen.push(n));
    s.replace(history);
    s.advanceDays(1);
    expect(seen).toEqual([]);
    // ...but the next new one is news (the third negative close ends that game).
    s.advanceDays(30);
    expect(seen.map((n) => n.kind)).toEqual(['gameOver']);
    expect(seen[0]!.id).toBe(history.nextNoticeId - 1);
  });

  it('announces a lower-numbered notice in a replacement game after its own history', () => {
    const s = broke();
    s.advanceDays(59);
    const seen: Notice[] = [];
    s.onNotice((n) => seen.push(n));
    // A fresh game's ids start again at 1: they are new to this game.
    const fresh = newGame(9, { city: makeGridCity() });
    fresh.finance.cash = -5;
    s.replace(fresh);
    s.advanceDays(31);
    expect(seen.map((n) => [n.id, n.kind])).toEqual([[1, 'insolvencyWarning']]);
  });

  it('never announces a notice twice when a listener dispatches', () => {
    const s = broke();
    const seen: number[] = [];
    s.onNotice((n) => {
      seen.push(n.id);
      s.dispatch({ type: 'setMarketing', perMonth: 0 });
    });
    s.advanceDays(59);
    expect(seen).toEqual(s.state.notices.map((n) => n.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('bumps its revision on every tick, command and replace', () => {
    const s = session();
    const r0 = s.revision;
    s.advanceDays(2);
    expect(s.revision).toBe(r0 + 2);
    s.dispatch({ type: 'setMarketing', perMonth: 0 });
    expect(s.revision).toBe(r0 + 3);
    s.replace(newGame(5, { city: makeGridCity() }));
    expect(s.revision).toBe(r0 + 4);
  });
});

describe('GameSession game over', () => {
  /** One more negative close (the Jan close, tomorrow) ends the game. */
  const nearlyOver = () => {
    const s = session();
    s.state.day = 30;
    s.state.finance.cash = -1_000_000;
    s.state.finance.negativeMonths = INSOLVENCY_GRACE_MONTHS - 1;
    return s;
  };

  it('stops the clock when the game ends, tells listeners once, and ignores later speed changes', () => {
    const s = nearlyOver();
    const overs: GameOver[] = [];
    const notices: string[] = [];
    s.onGameOver((g) => overs.push(g));
    s.onNotice((n) => notices.push(n.kind));
    s.setSpeed(4);
    for (let i = 0; i < 20; i++) s.update(0.25);
    expect(s.state.gameOver).not.toBeNull();
    expect(s.isOver).toBe(true);
    expect(s.speed).toBe(0);
    expect(s.state.day).toBe(31);
    expect(overs).toEqual([s.state.gameOver]);
    expect(notices).toEqual(['gameOver']);

    s.setSpeed(2);
    expect(s.speed).toBe(0);
    s.togglePause();
    expect(s.speed).toBe(0);
    for (let i = 0; i < 20; i++) s.update(0.25);
    s.advanceDays(40);
    expect(s.state.day).toBe(31);
    expect(overs).toHaveLength(1);
  });

  it('stops advancing days mid-batch once the game ends', () => {
    const s = nearlyOver();
    let ended = 0;
    s.onGameOver(() => ended++);
    const revision = s.revision;
    s.advanceDays(100);
    expect(s.state.day).toBe(31);
    expect(s.revision).toBe(revision + 1);
    expect(ended).toBe(1);
  });

  it('opens a game that is already over paused and frozen, without announcing it again', () => {
    const over = nearlyOver();
    over.advanceDays(1);
    const s = new GameSession(structuredClone(over.state));
    let ended = 0;
    const notices: Notice[] = [];
    s.onGameOver(() => ended++);
    s.onNotice((n) => notices.push(n));
    s.setSpeed(4);
    expect(s.speed).toBe(0);
    s.advanceDays(5);
    expect(s.state.day).toBe(31);
    expect(ended).toBe(0);
    expect(notices).toEqual([]);

    // Replacing it with a live game makes the clock usable again.
    s.replace(newGame(8, { city: makeGridCity() }));
    s.setSpeed(2);
    expect(s.speed).toBe(2);
  });

  it('replacing a running game with one that is over leaves the clock stopped', () => {
    const over = nearlyOver();
    over.advanceDays(1);
    const s = session();
    s.setSpeed(4);
    s.replace(over.state);
    expect(s.speed).toBe(0);
    s.setSpeed(1);
    expect(s.speed).toBe(0);
  });
});

describe('latestNoticeId', () => {
  it('is the newest id the game has issued, or 0', () => {
    const state = newGame(3, { city: makeGridCity() });
    expect(latestNoticeId(state)).toBe(0);
    state.notices.push({ id: 4, day: 0, kind: 'oltFull', message: 'x', cabinet: null, milestone: null });
    state.nextNoticeId = 5;
    expect(latestNoticeId(state)).toBe(4);
    // Older notices dropped from the log still count as issued.
    state.notices = [];
    expect(latestNoticeId(state)).toBe(4);
  });
});
