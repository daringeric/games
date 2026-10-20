// The sim's outbox of player-facing notices (cabinet full, service lost,
// insolvency warnings, milestones, game over). The UI toasts every notice with
// an id above the highest it has shown; it never removes them (the sim keeps
// the newest NOTICE_LOG_MAX).
//
// Owner: sim-economy workstream. postNotice is implemented by the contract
// because the network and economy workstreams both raise notices.

import { NOTICE_LOG_MAX } from './balance';
import type { CabinetId, GameState, MilestoneId, Notice, NoticeKind } from './types';

export interface NoticeRefs {
  cabinet?: CabinetId;
  milestone?: MilestoneId;
}

/**
 * Append a notice dated state.day with id state.nextNoticeId (then increment
 * it), dropping the oldest notices beyond NOTICE_LOG_MAX. Returns the notice.
 */
export function postNotice(state: GameState, kind: NoticeKind, message: string, refs: NoticeRefs = {}): Notice {
  const notice: Notice = {
    id: state.nextNoticeId++,
    day: state.day,
    kind,
    message,
    cabinet: refs.cabinet ?? null,
    milestone: refs.milestone ?? null,
  };
  state.notices.push(notice);
  if (state.notices.length > NOTICE_LOG_MAX) state.notices.splice(0, state.notices.length - NOTICE_LOG_MAX);
  return notice;
}

/** Notices with an id greater than `afterId`, oldest first (what the UI has not shown yet). */
export function noticesAfter(state: GameState, afterId: number): Notice[] {
  return state.notices.filter((n) => n.id > afterId);
}
