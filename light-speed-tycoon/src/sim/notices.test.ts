import { describe, expect, it } from 'vitest';
import { NOTICE_LOG_MAX } from './balance';
import { noticesAfter, postNotice } from './notices';
import { makeTestState } from './testing/fixtures';

describe('postNotice', () => {
  it('dates notices today with strictly increasing ids', () => {
    const state = makeTestState();
    state.day = 12;
    const a = postNotice(state, 'cabinetFull', 'Cabinet full', { cabinet: 3 });
    state.day = 13;
    const b = postNotice(state, 'milestone', 'Milestone: First light', { milestone: 'firstLight' });
    const c = postNotice(state, 'insolvencyWarning', 'Low cash');
    expect(state.notices).toEqual([
      { id: 1, day: 12, kind: 'cabinetFull', message: 'Cabinet full', cabinet: 3, milestone: null },
      { id: 2, day: 13, kind: 'milestone', message: 'Milestone: First light', cabinet: null, milestone: 'firstLight' },
      { id: 3, day: 13, kind: 'insolvencyWarning', message: 'Low cash', cabinet: null, milestone: null },
    ]);
    expect([a.id, b.id, c.id]).toEqual([1, 2, 3]);
    expect(state.nextNoticeId).toBe(4);
  });

  it('keeps only the newest NOTICE_LOG_MAX notices, never reusing an id', () => {
    const state = makeTestState();
    const total = NOTICE_LOG_MAX + 7;
    for (let i = 1; i <= total; i++) postNotice(state, 'serviceLost', `Notice ${i}`, { cabinet: 1 });
    expect(state.notices).toHaveLength(NOTICE_LOG_MAX);
    expect(state.notices[0]!.id).toBe(total - NOTICE_LOG_MAX + 1);
    expect(state.notices.at(-1)!).toMatchObject({ id: total, message: `Notice ${total}` });
    for (let i = 1; i < state.notices.length; i++) expect(state.notices[i]!.id).toBe(state.notices[i - 1]!.id + 1);
    expect(state.nextNoticeId).toBe(total + 1);
  });
});

describe('noticesAfter', () => {
  it('returns the notices newer than an id, oldest first', () => {
    const state = makeTestState();
    for (let i = 0; i < 5; i++) postNotice(state, 'oltFull', `n${i}`);
    expect(noticesAfter(state, 0).map((n) => n.id)).toEqual([1, 2, 3, 4, 5]);
    expect(noticesAfter(state, 3).map((n) => n.message)).toEqual(['n3', 'n4']);
    expect(noticesAfter(state, 5)).toEqual([]);
    expect(noticesAfter(state, 99)).toEqual([]);
  });

  it('skips notices that fell out of the log', () => {
    const state = makeTestState();
    for (let i = 0; i < NOTICE_LOG_MAX * 2; i++) postNotice(state, 'oltFull', `n${i}`);
    expect(noticesAfter(state, 0)).toHaveLength(NOTICE_LOG_MAX);
    expect(noticesAfter(state, 0)[0]!.id).toBe(NOTICE_LOG_MAX + 1);
  });
});
