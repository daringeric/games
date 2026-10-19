// Small report panel: the last closed month and this month's spending so far.

import { MONTH_ABBR, dateOf, formatMonth } from '../sim/calendar';
import type { GameState } from '../sim/types';
import { el, setText } from './dom';
import { formatMoney, formatNumber, formatSignedMoney } from './format';

export class ReportPanel {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly net: HTMLElement;
  private readonly poleRent: HTMLElement;
  private readonly passings: HTMLElement;
  private readonly mtdLabel: HTMLElement;
  private readonly mtd: HTMLElement;
  private readonly lastRow: HTMLElement;
  private readonly empty: HTMLElement;
  private key = '';

  constructor() {
    const stat = (label: string, value: HTMLElement) => el('div', { class: 'stat' }, [el('dt', { text: label }), el('dd', {}, [value])]);
    this.title = el('h2', { class: 'panel-title' });
    this.net = el('span', { class: 'num' });
    this.poleRent = el('span', { class: 'num' });
    this.passings = el('span', { class: 'num' });
    this.mtdLabel = el('span');
    this.mtd = el('span', { class: 'num', attrs: { 'data-testid': 'mtd-spend' } });
    this.empty = el('p', { class: 'panel-empty' });
    this.lastRow = el('dl', { class: 'stats' }, [
      stat('Net', this.net),
      stat('Pole rent', this.poleRent),
      stat('Passings', this.passings),
    ]);
    this.root = el('section', { class: 'panel pill-card', attrs: { 'aria-label': 'Monthly report' } }, [
      this.title,
      this.lastRow,
      this.empty,
      el('p', { class: 'mtd' }, [this.mtdLabel, ' ', this.mtd]),
    ]);
  }

  update(state: GameState): void {
    const { finance } = state;
    const key = `${finance.reports.length}|${finance.monthToDate.length}|${state.day}`;
    if (key === this.key) return;
    this.key = key;

    const last = finance.reports[finance.reports.length - 1];
    this.lastRow.hidden = !last;
    this.empty.hidden = !!last;
    if (last) {
      setText(this.title, `${formatMonth(last.year, last.month)} report`);
      setText(this.net, formatSignedMoney(last.net));
      this.net.classList.toggle('negative', last.net < 0);
      setText(this.poleRent, formatMoney(-(last.totals.poleRent ?? 0)));
      setText(this.passings, formatNumber(last.passings));
    } else {
      setText(this.title, 'Monthly report');
      const next = dateOf(state.day);
      const month = next.month === 12 ? 1 : next.month + 1;
      setText(this.empty, `First report arrives ${MONTH_ABBR[month - 1]} 1.`);
    }

    const spent = finance.monthToDate.reduce((sum, e) => sum + (e.amount < 0 ? -e.amount : 0), 0);
    const now = dateOf(state.day);
    setText(this.mtdLabel, `Spent in ${MONTH_ABBR[now.month - 1]} so far`);
    setText(this.mtd, formatMoney(spent));
  }
}
