// Top bar: speed controls, date, cash, passings and the build queue.

import { formatDate } from '../sim/calendar';
import { getService } from '../sim/network';
import type { GameState } from '../sim/types';
import { el, icon, setText } from './dom';
import { formatMoney, formatNumber } from './format';
import { ICONS } from './icons';
import { SPEEDS } from './session';
import type { GameSession, Speed } from './session';

export class Hud {
  readonly root: HTMLElement;
  readonly menuButton: HTMLButtonElement;
  private readonly speedButtons = new Map<Speed, HTMLButtonElement>();
  private readonly town: HTMLElement;
  private readonly date: HTMLElement;
  private readonly cash: HTMLElement;
  private readonly passings: HTMLElement;
  private readonly building: HTMLElement;
  private readonly buildingChip: HTMLElement;

  constructor(session: GameSession) {
    const speeds = el('div', { class: 'speed-group', attrs: { role: 'group', 'aria-label': 'Game speed' } });
    for (const speed of SPEEDS) {
      const label = speed === 0 ? 'Pause (Space)' : `${speed}x speed (${speed === 4 ? 3 : speed})`;
      const button = el(
        'button',
        {
          class: 'btn speed',
          attrs: { type: 'button', 'aria-label': label, 'aria-pressed': 'false', 'data-tip': label, 'data-speed': `${speed}` },
          on: { click: () => session.setSpeed(speed) },
        },
        [speed === 0 ? icon(ICONS.pause) : `${speed}x`],
      );
      this.speedButtons.set(speed, button);
      speeds.append(button);
    }

    this.town = el('span', { class: 'hud-town' });
    this.date = el('span', { class: 'hud-date num', attrs: { 'data-testid': 'hud-date' } });
    this.cash = el('span', { class: 'hud-cash num', attrs: { 'data-testid': 'hud-cash' } });
    this.passings = el('span', { class: 'num', attrs: { 'data-testid': 'hud-passings' } });
    this.building = el('span', { class: 'num', attrs: { 'data-testid': 'hud-building' } });
    // Counts every order not yet live: permitting as well as crews on site (the tooltip splits them).
    this.buildingChip = el('span', { class: 'chip chip-building' }, [icon(ICONS.crew), this.building, ' in progress']);
    this.menuButton = el('button', {
      class: 'btn icon-btn menu-button',
      attrs: { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
      html: ICONS.menu,
    });

    const primary = el('div', { class: 'hud-row hud-primary' }, [
      speeds,
      el('div', { class: 'hud-when' }, [this.town, this.date]),
      this.menuButton,
    ]);
    const stats = el('div', { class: 'hud-row hud-stats' }, [
      this.cash,
      el('span', { class: 'chip chip-passings' }, [icon(ICONS.home), this.passings, ' passings']),
      this.buildingChip,
    ]);
    this.root = el('header', { class: 'hud pill-card', attrs: { 'aria-label': 'Game status' } }, [primary, stats]);
  }

  update(session: GameSession): void {
    const state: GameState = session.state;
    for (const [speed, button] of this.speedButtons) {
      const on = String(speed === session.speed);
      if (button.getAttribute('aria-pressed') !== on) button.setAttribute('aria-pressed', on);
    }
    setText(this.town, state.city.name);
    setText(this.date, formatDate(state.day));
    setText(this.cash, formatMoney(state.finance.cash));
    this.cash.classList.toggle('negative', state.finance.cash < 0);
    setText(this.passings, formatNumber(getService(state).passings));

    let permitting = 0;
    let constructing = 0;
    for (const asset of [...state.network.spans, ...state.network.cabinets]) {
      if (asset.stage === 'permitting') permitting++;
      else if (asset.stage === 'constructing') constructing++;
    }
    setText(this.building, formatNumber(permitting + constructing));
    const tip = `${formatNumber(permitting)} permitting, ${formatNumber(constructing)} with crews on site`;
    if (this.buildingChip.title !== tip) this.buildingChip.title = tip;
  }
}
