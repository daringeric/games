// Milestones: the scorecard in order, with the date each was achieved or a
// short progress hint toward it.
//
// Owner: ui-economy workstream.

import { CPP_TARGET } from '../sim/balance';
import { formatDate } from '../sim/calendar';
import { operatingCashFlow } from '../sim/metrics';
import {
  EFFICIENT_PASSINGS,
  FAVORITE_PASSINGS,
  FAVORITE_TAKE_RATE,
  FIRST_SUBSCRIBERS,
  MANY_SUBSCRIBERS,
  MILESTONES,
} from '../sim/milestones';
import { getService } from '../sim/network';
import { subscriberUnits } from '../sim/sales';
import type { GameState, MilestoneId } from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el, icon } from './dom';
import { formatMoney, formatNumber, formatPercent, formatSignedMoney } from './format';
import { ICONS } from './icons';

export interface MilestoneRow {
  id: MilestoneId;
  title: string;
  description: string;
  /** Day achieved, or null. */
  day: number | null;
  /** "Feb 1, 2027" or "Not yet". */
  when: string;
  /** Where the player stands today, for milestones not yet achieved; null once achieved. */
  progress: string | null;
}

/** Progress toward a milestone from today's figures (milestones are judged at month close). */
function progressHint(id: MilestoneId, state: GameState, passings: number, subscribers: number): string {
  const cpp = passings > 0 ? state.finance.capex.osp / passings : null;
  switch (id) {
    case 'firstLight':
      return passings > 0 ? `${formatNumber(passings)} passed now: counts at the next month close` : 'No homes passed yet';
    case 'passings1000UnderTarget': {
      const cost = cpp === null ? '' : `, cost per passing ${formatMoney(cpp)} (target ${formatMoney(CPP_TARGET)})`;
      return `${formatNumber(passings)} / ${formatNumber(EFFICIENT_PASSINGS)} passings${cost}`;
    }
    case 'subscribers100':
      return `${formatNumber(subscribers)} / ${formatNumber(FIRST_SUBSCRIBERS)} subscribers`;
    case 'subscribers1000':
      return `${formatNumber(subscribers)} / ${formatNumber(MANY_SUBSCRIBERS)} subscribers`;
    case 'cashFlowPositive': {
      const last = state.finance.reports.at(-1);
      return last ? `Last month: ${formatSignedMoney(operatingCashFlow(last))} operating cash flow` : 'No month closed yet';
    }
    case 'takeRate30':
      return passings > 0
        ? `Take rate ${formatPercent(subscribers / passings)} of ${formatPercent(FAVORITE_TAKE_RATE)}, on ${formatNumber(passings)} / ${formatNumber(FAVORITE_PASSINGS)} passings`
        : 'No homes passed yet';
  }
}

/** Every milestone in MILESTONES order, with its achievement date or today's progress. */
export function milestoneRows(state: GameState): MilestoneRow[] {
  const passings = getService(state).passings;
  const subscribers = subscriberUnits(state);
  return MILESTONES.map((def) => {
    const record = state.milestones.find((m) => m.id === def.id);
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      day: record ? record.day : null,
      when: record ? formatDate(record.day) : 'Not yet',
      progress: record ? null : progressHint(def.id, state, passings, subscribers),
    };
  });
}

export class MilestonesPanel {
  private sheet: Sheet | null = null;

  constructor(private readonly getState: () => GameState) {}

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  close(): void {
    this.sheet?.close();
  }

  open(): void {
    if (this.sheet?.isOpen) return;
    const rows = milestoneRows(this.getState());
    const done = rows.filter((r) => r.day !== null).length;
    const sheet = openSheet({
      title: 'Milestones',
      subtitle: `${done} of ${rows.length} achieved. Each is judged at a month close.`,
      className: 'milestones',
      onClose: () => {
        if (this.sheet === sheet) this.sheet = null;
      },
    });
    this.sheet = sheet;
    sheet.body.append(
      el(
        'ol',
        { class: 'milestone-list' },
        rows.map((row) =>
          el('li', { class: `milestone ${row.day !== null ? 'achieved' : 'pending'}`, attrs: { 'data-milestone': row.id } }, [
            icon(ICONS.trophy, 'icon milestone-icon'),
            el('div', { class: 'milestone-text' }, [
              el('h3', { class: 'milestone-title', text: row.title }),
              el('p', { class: 'milestone-desc', text: row.description }),
              row.progress ? el('p', { class: 'milestone-progress', text: row.progress }) : null,
            ]),
            el('span', { class: 'milestone-when', text: row.when }),
          ]),
        ),
      ),
    );
    sheet.dialog.querySelector<HTMLButtonElement>('.sheet-close')?.focus();
  }
}
