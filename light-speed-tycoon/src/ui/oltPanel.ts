// The OLT panel, opened by clicking the central office with the inspect tool:
// PON ports in use, line cards, splitters per cabinet, and the button that
// buys another line card (addOltCard). A non-modal dialog: the map keeps
// running behind it, Esc (routed by MapControls) or the close button shuts it.

import { OLT_MAX_CARDS, OLT_PORTS_PER_CARD, SPLIT_RATIO } from '../sim/balance';
import { ponPortsUsed, quoteOltCard } from '../sim/network';
import type { Command, CommandResult, GameState } from '../sim/types';
import { el, icon } from './dom';
import { formatMoney, formatNumber, formatStage, plural } from './format';
import { ICONS } from './icons';
import { cornerLabel } from './tools';

export interface OltPanelDeps {
  /** The game in play when the button is pressed. */
  getState(): GameState;
  dispatch(cmd: Command): CommandResult;
  toast(message: string, ok: boolean): void;
}

let panelIds = 0;

export class OltPanel {
  readonly root: HTMLElement;
  private readonly body: HTMLElement;
  private key = '';
  private game: GameState | null = null;

  constructor(private readonly deps: OltPanelDeps) {
    const titleId = `olt-panel-title-${++panelIds}`;
    const close = el('button', {
      class: 'btn icon-btn olt-close',
      html: ICONS.close,
      attrs: { type: 'button', 'aria-label': 'Close OLT panel' },
      on: { click: () => this.close() },
    });
    this.body = el('div', { class: 'olt-body' });
    this.root = el(
      'section',
      {
        class: 'olt-panel pill-card',
        attrs: { role: 'dialog', 'aria-labelledby': titleId, 'data-testid': 'olt-panel', tabindex: '-1', hidden: '' },
      },
      [
        el('header', { class: 'olt-head' }, [
          icon(ICONS.chip, 'icon olt-icon'),
          el('h2', { class: 'olt-title', text: 'OLT at the central office', attrs: { id: titleId } }),
          close,
        ]),
        this.body,
      ],
    );
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(state: GameState): void {
    this.root.hidden = false;
    this.update(state, true);
    this.root.focus({ preventScroll: true });
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Refresh while open; rebuilds only when something it shows changed. */
  update(state: GameState, force = false): void {
    if (!this.isOpen) return;
    const { olt } = state.network;
    // The day too: cabinet stages count down their days.
    const key = [state.network.version, state.day, olt.ponPorts, olt.cards, state.finance.cash, state.gameOver ? 1 : 0].join('|');
    if (!force && state === this.game && key === this.key) return;
    this.game = state;
    this.key = key;
    this.build(state);
  }

  private build(state: GameState): void {
    const { olt, cabinets } = state.network;
    const used = ponPortsUsed(state);
    const quote = quoteOltCard(state);
    const pct = olt.ponPorts > 0 ? Math.min(100, Math.round((used / olt.ponPorts) * 100)) : 100;

    const meter = el('div', {
      class: `olt-meter${used >= olt.ponPorts ? ' is-full' : ''}`,
      attrs: {
        role: 'meter',
        'aria-label': 'PON ports in use',
        'aria-valuemin': '0',
        'aria-valuemax': String(olt.ponPorts),
        'aria-valuenow': String(used),
      },
    }, [el('span', { class: 'olt-meter-fill', attrs: { style: `width: ${pct}%` } })]);

    const summary = el('dl', { class: 'olt-stats' }, [
      el('div', { class: 'row' }, [
        el('dt', { text: 'PON ports in use' }),
        el('dd', { class: 'num', text: `${formatNumber(used)} of ${formatNumber(olt.ponPorts)}`, attrs: { 'data-testid': 'olt-ports' } }),
      ]),
      el('div', { class: 'row' }, [
        el('dt', { text: 'Line cards' }),
        el('dd', { class: 'num', text: `${olt.cards} of ${OLT_MAX_CARDS}`, attrs: { 'data-testid': 'olt-cards' } }),
      ]),
      el('div', { class: 'row' }, [
        el('dt', { text: 'Technology' }),
        el('dd', { text: `${olt.tech === 'gpon' ? 'GPON' : 'XGS-PON'}, ${OLT_PORTS_PER_CARD} ports per card` }),
      ]),
    ]);

    const list =
      cabinets.length === 0
        ? el('p', { class: 'olt-empty', text: 'No cabinets yet. Each splitter in a cabinet uses one PON port.' })
        : el(
            'ul',
            { class: 'olt-cabinets' },
            cabinets.map((c) =>
              el('li', {}, [
                el('span', { class: 'olt-cab-name', text: cornerLabel(state, c.node) }),
                el('span', { class: 'olt-cab-split num', text: `${c.splitters} × 1:${SPLIT_RATIO}` }),
                el('span', { class: 'olt-cab-stage', text: formatStage(c.stage, c.stageDaysLeft) }),
              ]),
            ),
          );

    const button = el(
      'button',
      {
        class: 'btn olt-add',
        attrs: { type: 'button', 'data-testid': 'olt-add-card' },
        on: { click: () => this.addCard() },
      },
      [
        el('span', { class: 'olt-add-label', text: 'Add line card' }),
        el('span', { class: 'olt-add-detail', text: `${formatMoney(quote.cost)} · ${plural(quote.ponPortsAfter, 'PON port')} after` }),
      ],
    );
    button.disabled = !quote.ok;
    const parts: Node[] = [
      meter,
      summary,
      el('h3', { class: 'olt-sub', text: `Splitters by cabinet (${formatNumber(used)})` }),
      list,
      button,
    ];
    if (!quote.ok) parts.push(el('ul', { class: 'blockers' }, quote.reasons.map((r) => el('li', { text: r }))));
    this.body.replaceChildren(...parts);
  }

  private addCard(): void {
    const state = this.deps.getState();
    const result = this.deps.dispatch({ type: 'addOltCard' });
    if (result.ok) {
      const { olt } = state.network;
      this.deps.toast(`Line card added for ${formatMoney(result.cost)}: ${olt.cards} of ${OLT_MAX_CARDS}, ${formatNumber(olt.ponPorts)} PON ports`, true);
    } else {
      this.deps.toast(result.reason, false);
    }
    this.update(this.deps.getState(), true);
  }
}
