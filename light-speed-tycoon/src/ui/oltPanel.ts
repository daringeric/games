// The OLT panel, opened by clicking the central office with the inspect tool:
// PON ports in use, line cards, splitters per cabinet, and the button that
// buys another line card (addOltCard), with the cash it would leave (and the
// credit line when cash is short). A non-modal dialog: the map keeps running
// behind it, Esc (routed by MapControls) or the close button shuts it.

import { OLT_MAX_CARDS, OLT_PORTS_PER_CARD, SPLIT_RATIO } from '../sim/balance';
import { ponPortsUsed, quoteOltCard } from '../sim/network';
import type { Command, CommandResult, GameState } from '../sim/types';
import { el, icon, setText } from './dom';
import { formatMoney, formatNumber, formatStage, plural } from './format';
import { ICONS } from './icons';
import { cashAfterRow, cornerLabel, creditHint, fundsOf } from './tools';

export interface OltPanelDeps {
  /** The game in play when the button is pressed. */
  getState(): GameState;
  dispatch(cmd: Command): CommandResult;
  toast(message: string, ok: boolean): void;
}

let panelIds = 0;

export class OltPanel {
  readonly root: HTMLElement;
  private readonly meter: HTMLElement;
  private readonly meterFill: HTMLElement;
  private readonly ports: HTMLElement;
  private readonly cards: HTMLElement;
  private readonly tech: HTMLElement;
  private readonly sub: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly list: HTMLUListElement;
  private readonly button: HTMLButtonElement;
  private readonly buttonDetail: HTMLElement;
  private readonly blockers: HTMLUListElement;
  private readonly cashAfter: HTMLElement;
  private readonly credit: HTMLElement;
  private key = '';
  private listKey = '';
  private blockersKey = '';
  private game: GameState | null = null;

  constructor(private readonly deps: OltPanelDeps) {
    const titleId = `olt-panel-title-${++panelIds}`;
    const close = el('button', {
      class: 'btn icon-btn olt-close',
      html: ICONS.close,
      attrs: { type: 'button', 'aria-label': 'Close OLT panel' },
      on: { click: () => this.close() },
    });
    // The panel is non-modal and the clock runs behind it, so everything below
    // is built once and updated in place: a rebuild every game day would drop
    // keyboard focus, lose a click whose press and release straddle it, and
    // scroll the cabinet list back to the top.
    this.meterFill = el('span', { class: 'olt-meter-fill' });
    this.meter = el(
      'div',
      { class: 'olt-meter', attrs: { role: 'meter', 'aria-label': 'PON ports in use', 'aria-valuemin': '0' } },
      [this.meterFill],
    );
    this.ports = el('dd', { class: 'num', attrs: { 'data-testid': 'olt-ports' } });
    this.cards = el('dd', { class: 'num', attrs: { 'data-testid': 'olt-cards' } });
    this.tech = el('dd');
    const summary = el('dl', { class: 'olt-stats' }, [
      el('div', { class: 'row' }, [el('dt', { text: 'PON ports in use' }), this.ports]),
      el('div', { class: 'row' }, [el('dt', { text: 'Line cards' }), this.cards]),
      el('div', { class: 'row' }, [el('dt', { text: 'Technology' }), this.tech]),
    ]);
    this.sub = el('h3', { class: 'olt-sub' });
    this.empty = el('p', { class: 'olt-empty', text: 'No cabinets yet. Each splitter in a cabinet uses one PON port.' });
    this.list = el('ul', { class: 'olt-cabinets' });
    this.buttonDetail = el('span', { class: 'olt-add-detail' });
    this.button = el(
      'button',
      {
        class: 'btn olt-add',
        attrs: { type: 'button', 'data-testid': 'olt-add-card' },
        on: { click: () => this.addCard() },
      },
      [el('span', { class: 'olt-add-label', text: 'Add line card' }), this.buttonDetail],
    );
    this.blockers = el('ul', { class: 'blockers' });
    this.cashAfter = el('span', { class: 'num', attrs: { 'data-testid': 'olt-cash-after' } });
    const cashAfter = el('p', { class: 'olt-cash-after' }, [el('span', { text: 'Cash after ' }), this.cashAfter]);
    this.credit = el('p', { class: 'card-credit', attrs: { 'data-testid': 'olt-credit', hidden: '' } });
    const body = el('div', { class: 'olt-body' }, [this.meter, summary, this.sub, this.empty, this.list, this.button, cashAfter, this.credit, this.blockers]);
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
        body,
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

  /** Refresh while open; touches the DOM only when something it shows changed, and never replaces the button. */
  update(state: GameState, force = false): void {
    if (!this.isOpen) return;
    const { olt } = state.network;
    // The day too: cabinet stages count down their days.
    const key = [
      state.network.version,
      state.day,
      olt.ponPorts,
      olt.cards,
      state.finance.cash,
      state.debt.credit.balance,
      state.debt.covenant.stage,
      state.gameOver ? 1 : 0,
    ].join('|');
    if (!force && state === this.game && key === this.key) return;
    this.game = state;
    this.key = key;
    this.refresh(state);
  }

  private refresh(state: GameState): void {
    const { olt, cabinets } = state.network;
    const used = ponPortsUsed(state);
    const quote = quoteOltCard(state);
    const pct = olt.ponPorts > 0 ? Math.min(100, Math.round((used / olt.ponPorts) * 100)) : 100;

    this.meter.classList.toggle('is-full', used >= olt.ponPorts);
    setAttr(this.meter, 'aria-valuemax', String(olt.ponPorts));
    setAttr(this.meter, 'aria-valuenow', String(used));
    if (this.meterFill.style.width !== `${pct}%`) this.meterFill.style.width = `${pct}%`;
    setText(this.ports, `${formatNumber(used)} of ${formatNumber(olt.ponPorts)}`);
    setText(this.cards, `${olt.cards} of ${OLT_MAX_CARDS}`);
    setText(this.tech, `${olt.tech === 'gpon' ? 'GPON' : 'XGS-PON'}, ${OLT_PORTS_PER_CARD} ports per card`);
    setText(this.sub, `Splitters by cabinet (${formatNumber(used)})`);

    this.empty.hidden = cabinets.length > 0;
    this.list.hidden = cabinets.length === 0;
    const rows = cabinets.map((c) => [cornerLabel(state, c.node), `${c.splitters} × 1:${SPLIT_RATIO}`, formatStage(c.stage, c.stageDaysLeft)] as const);
    const listKey = JSON.stringify(rows);
    if (listKey !== this.listKey) {
      this.listKey = listKey;
      // Same list element, rows rewritten: the player's scroll position stays.
      const scroll = this.list.scrollTop;
      this.list.replaceChildren(
        ...rows.map(([name, split, stage]) =>
          el('li', {}, [
            el('span', { class: 'olt-cab-name', text: name }),
            el('span', { class: 'olt-cab-split num', text: split }),
            el('span', { class: 'olt-cab-stage', text: stage }),
          ]),
        ),
      );
      this.list.scrollTop = scroll;
    }

    setText(this.buttonDetail, `${formatMoney(quote.cost)} · ${plural(quote.ponPortsAfter, 'PON port')} after`);
    const funds = fundsOf(state);
    const after = cashAfterRow(funds, quote.cost);
    setText(this.cashAfter, after.value);
    this.cashAfter.classList.toggle('negative', after.tone === 'negative');
    const credit = creditHint(funds, quote.cost) ?? '';
    setText(this.credit, credit);
    this.credit.hidden = credit === '';
    if (this.button.disabled !== !quote.ok) this.button.disabled = !quote.ok;
    this.blockers.hidden = quote.ok;
    const blockersKey = quote.reasons.join('\n');
    if (blockersKey !== this.blockersKey) {
      this.blockersKey = blockersKey;
      this.blockers.replaceChildren(...quote.reasons.map((r) => el('li', { text: r })));
    }
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

function setAttr(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
