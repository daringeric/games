// The span panel, opened by clicking a live cable span with the inspect tool:
// what the span is and what it cost, whether it is out of service or being
// rebuilt, the storms that hit it, its expected storm repairs as aerial and
// as underground plant, its pole rent, and for aerial spans the button that
// rebuilds it underground (convertSpan) at quoteConvert's price, with the
// reasons when it cannot. A non-modal dialog like the OLT panel: the map
// keeps running behind it; Esc, a map press (routed by MapControls) or the
// close button shuts it.
//
// spanPanelModel is the pure part (unit-tested and driven over a frozen
// game in purity.test.ts); SpanPanel renders it and updates in place.

import { formatDate } from '../sim/calendar';
import { outageImpact, quoteConvert } from '../sim/network';
import { polesOnSegment } from '../sim/streets';
import type { CableMethod, CableSpan, Command, CommandResult, GameState, SpanId, StormRisk } from '../sim/types';
import { stormAreaName, stormLabel, stormRisk } from '../sim/weather';
import { el, icon, setText } from './dom';
import { cashAfterRow, creditHint, fundsOf } from './funding';
import { METHOD_LABEL, formatDayRange, formatFeet, formatMoney, formatStage, plural } from './format';
import { ICONS } from './icons';
import { outageText, rebuildText, spanPoleRent, stormRiskText } from './tools';
import type { CardRow } from './tools';

/** One storm that hit the span (newest first). */
export interface SpanStormEntry {
  /** "Mar 3, 2028" */
  when: string;
  /** "Major storm near Elm St & 3rd Ave: out of service now" */
  text: string;
}

/** Expected yearly exposure of the span as one method. */
export interface SpanRiskRow {
  method: CableMethod;
  label: string;
  /** "0.4/yr" */
  outages: string;
  /** "about $340 a year in repairs" */
  repairs: string;
  /** "$340/yr" (the table cell) */
  repairsShort: string;
  /** Days out of service: "1.6/yr" */
  daysOut: string;
  /** The span is this method today. */
  current: boolean;
}

export interface SpanRebuildModel {
  /** "Rebuild underground: $12,340" */
  label: string;
  ok: boolean;
  /** Why it cannot go ahead (quoteConvert's reasons); empty when ok. */
  reasons: string[];
  /** Permit, build, pole rent saved, repairs avoided, cash after. */
  rows: CardRow[];
  /** How the credit line could cover it when cash is short. */
  credit?: string;
}

export interface SpanPanelModel {
  span: SpanId;
  /** "Cable on Elm St" */
  title: string;
  method: CableMethod;
  facts: CardRow[];
  /** Red: out of service (with who is cut off); info: the underground rebuild under way. */
  status: { tone: 'danger' | 'info'; text: string }[];
  history: SpanStormEntry[];
  risk: SpanRiskRow[];
  /** Aerial spans: the rebuild-underground action. Null for underground spans. */
  rebuild: SpanRebuildModel | null;
}

function outagesText(n: number): string {
  if (n <= 0) return 'none';
  if (n < 0.1) return 'under 0.1/yr';
  return `${(Math.round(n * 10) / 10).toFixed(1)}/yr`;
}

function daysText(n: number): string {
  if (n <= 0) return 'none';
  if (n < 0.1) return 'under 0.1/yr';
  return `${(Math.round(n * 10) / 10).toFixed(1)}/yr`;
}

function riskRow(method: CableMethod, risk: StormRisk, current: CableMethod): SpanRiskRow {
  return {
    method,
    label: METHOD_LABEL[method],
    outages: outagesText(risk.outagesPerYear),
    repairs: stormRiskText(risk.repairCostPerYear),
    repairsShort: risk.repairCostPerYear < 1 ? 'under $1/yr' : `${formatMoney(risk.repairCostPerYear)}/yr`,
    daysOut: daysText(risk.outageDaysPerYear),
    current: method === current,
  };
}

function capitalize(text: string): string {
  return text.length > 0 ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

/** The storms in the log that damaged this span, newest first. */
function stormHistory(state: GameState, span: CableSpan): SpanStormEntry[] {
  const out: SpanStormEntry[] = [];
  for (let i = state.weather.storms.length - 1; i >= 0; i--) {
    const storm = state.weather.storms[i];
    if (!storm || !storm.spans.includes(span.id)) continue;
    const now = span.outage?.storm === storm.id ? ': out of service now' : '';
    out.push({ when: formatDate(storm.day), text: `${capitalize(stormLabel(storm.severity))} near ${stormAreaName(state.city, storm)}${now}` });
  }
  return out;
}

/** Everything the span panel shows for `spanId`, or null when there is no such live span. Pure. */
export function spanPanelModel(state: GameState, spanId: SpanId): SpanPanelModel | null {
  const span = state.network.spans.find((s) => s.id === spanId);
  const segment = span ? state.city.segments[span.segment] : undefined;
  if (!span || !segment || span.stage !== 'live') return null;

  const poles = polesOnSegment(segment);
  const facts: CardRow[] = [
    { label: 'Cable', value: `${METHOD_LABEL[span.method]}, ${formatStage(span.stage, span.stageDaysLeft).toLowerCase()}` },
    { label: 'Length', value: formatFeet(segment.lengthFt) },
    { label: 'In service since', value: span.liveDay === null ? '–' : formatDate(span.liveDay) },
    { label: 'Paid', value: formatMoney(span.cost) },
    span.method === 'aerial'
      ? { label: 'Pole rent', value: `${formatMoney(spanPoleRent(state, span))}/mo`, sub: plural(poles, 'pole') }
      : { label: 'Pole rent', value: 'None', tone: 'muted' },
  ];

  const status: SpanPanelModel['status'] = [];
  const outage = outageText(state, span);
  if (outage) status.push({ tone: 'danger', text: outage });
  const rebuilding = rebuildText(span);
  if (rebuilding) status.push({ tone: 'info', text: `Being rebuilt underground: ${rebuilding.toLowerCase()}. The aerial cable serves until then.` });

  const risk = [riskRow('aerial', stormRisk(state, segment, 'aerial'), span.method), riskRow('underground', stormRisk(state, segment, 'underground'), span.method)];

  let rebuild: SpanRebuildModel | null = null;
  if (span.method === 'aerial') {
    const quote = quoteConvert(state, span.id);
    const funds = fundsOf(state);
    rebuild = {
      label: `Rebuild underground: ${formatMoney(quote.cost)}`,
      ok: quote.ok,
      reasons: quote.reasons,
      rows: [
        { label: 'Permit', value: formatDayRange(quote.permitDaysMin, quote.permitDaysMax) },
        { label: 'Build', value: plural(quote.constructDays, 'day') },
        { label: 'Pole rent saved', value: `${formatMoney(quote.poleRentSaved)}/mo` },
        { label: 'Repairs avoided', value: quote.repairsAvoidedPerYear > 0 ? `about ${formatMoney(quote.repairsAvoidedPerYear)} a year` : 'little', sub: 'expected' },
        cashAfterRow(funds, quote.cost),
      ],
      credit: quote.ok ? undefined : creditHint(funds, quote.cost),
    };
  }

  return {
    span: span.id,
    title: `Cable on ${segment.name}`,
    method: span.method,
    facts,
    status,
    history: stormHistory(state, span),
    risk,
    rebuild,
  };
}

/** "37 subscribers cut off" for a toast, or ''. */
function cutOffNote(state: GameState, span: SpanId): string {
  const { subscribers } = outageImpact(state, span);
  return subscribers > 0 ? ` (${plural(subscribers, 'subscriber')} still cut off until repairs finish)` : '';
}

export interface SpanPanelDeps {
  /** The game in play when the button is pressed. */
  getState(): GameState;
  dispatch(cmd: Command): CommandResult;
  toast(message: string, ok: boolean): void;
  /** Called whenever the panel opens (MapControls closes the other map panels: one shows at a time). */
  onOpen?(): void;
}

const BOLT_ICON =
  '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/></svg>';

let panelIds = 0;

export class SpanPanel {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly facts: HTMLElement;
  private readonly status: HTMLElement;
  private readonly history: HTMLUListElement;
  private readonly historyEmpty: HTMLElement;
  private readonly risk: HTMLTableSectionElement;
  private readonly rebuildBox: HTMLElement;
  private readonly rebuildRows: HTMLElement;
  private readonly button: HTMLButtonElement;
  private readonly blockers: HTMLUListElement;
  private readonly credit: HTMLElement;
  private readonly underground: HTMLElement;
  private spanId: SpanId | null = null;
  private game: GameState | null = null;
  private key = '';
  private parts: Record<string, string> = {};

  constructor(private readonly deps: SpanPanelDeps) {
    const titleId = `span-panel-title-${++panelIds}`;
    const close = el('button', {
      class: 'btn icon-btn span-close',
      html: ICONS.close,
      attrs: { type: 'button', 'aria-label': 'Close span panel' },
      on: { click: () => this.close() },
    });
    // Built once and updated in place (the clock runs behind a non-modal
    // panel): a rebuild every game day would drop focus and lose clicks.
    this.title = el('h2', { class: 'span-title', attrs: { id: titleId } });
    this.facts = el('dl', { class: 'span-facts' });
    this.status = el('div', { class: 'span-status' });
    this.history = el('ul', { class: 'span-history', attrs: { 'data-testid': 'span-history' } });
    this.historyEmpty = el('p', { class: 'span-empty', text: 'No storm has damaged it in the last two years.' });
    this.risk = el('tbody');
    const riskTable = el('table', { class: 'span-risk', attrs: { 'data-testid': 'span-risk' } }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: 'As', attrs: { scope: 'col' } }),
          el('th', { text: 'Outages', attrs: { scope: 'col' } }),
          el('th', { text: 'Days out', attrs: { scope: 'col' } }),
          el('th', { text: 'Repairs', attrs: { scope: 'col' } }),
        ]),
      ]),
      this.risk,
    ]);
    this.rebuildRows = el('dl', { class: 'span-facts span-rebuild-rows' });
    this.button = el('button', {
      class: 'btn span-convert',
      attrs: { type: 'button', 'data-testid': 'span-convert' },
      on: { click: () => this.convert() },
    });
    this.blockers = el('ul', { class: 'blockers' });
    this.credit = el('p', { class: 'card-credit', attrs: { hidden: '' } });
    this.rebuildBox = el('div', { class: 'span-rebuild' }, [
      el('h3', { class: 'span-sub', text: 'Rebuild underground' }),
      this.rebuildRows,
      this.button,
      this.blockers,
      this.credit,
    ]);
    this.underground = el('p', { class: 'span-empty', text: 'Underground: no pole rent, and storms rarely reach it (an excavator can still cut it).' });
    const body = el('div', { class: 'span-body' }, [
      this.facts,
      this.status,
      el('h3', { class: 'span-sub', text: 'Storm history' }),
      this.history,
      this.historyEmpty,
      el('h3', { class: 'span-sub', text: 'Expected storm damage' }),
      riskTable,
      this.rebuildBox,
      this.underground,
    ]);
    this.root = el(
      'section',
      {
        class: 'span-panel pill-card',
        attrs: { role: 'dialog', 'aria-labelledby': titleId, 'data-testid': 'span-panel', tabindex: '-1', hidden: '' },
      },
      [el('header', { class: 'span-head' }, [icon(BOLT_ICON, 'icon span-icon'), this.title, close]), body],
    );
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** The span shown, or null when closed. */
  get span(): SpanId | null {
    return this.isOpen ? this.spanId : null;
  }

  open(state: GameState, span: SpanId): void {
    this.deps.onOpen?.();
    this.spanId = span;
    this.root.hidden = false;
    this.update(state, true);
    if (this.isOpen) this.root.focus({ preventScroll: true });
  }

  close(): void {
    this.root.hidden = true;
  }

  /** Refresh while open; touches the DOM only for what changed, and never replaces the button. Closes when the span is gone. */
  update(state: GameState, force = false): void {
    if (!this.isOpen || this.spanId === null) return;
    const key = [state.network.version, state.day, state.weather.nextStormId, state.finance.cash, state.debt.credit.balance, state.debt.covenant.stage].join('|');
    if (!force && state === this.game && key === this.key) return;
    this.game = state;
    this.key = key;
    const model = spanPanelModel(state, this.spanId);
    if (!model) {
      this.close();
      return;
    }
    this.render(model);
  }

  /** Run `draw` only when `value` changed since the last render of `part`. */
  private changed(part: string, value: unknown): boolean {
    const text = JSON.stringify(value);
    if (this.parts[part] === text) return false;
    this.parts[part] = text;
    return true;
  }

  private render(model: SpanPanelModel): void {
    setText(this.title, model.title);
    this.root.dataset.method = model.method;
    if (this.changed('facts', model.facts)) this.facts.replaceChildren(...model.facts.map(factRow));
    if (this.changed('status', model.status)) {
      this.status.replaceChildren(
        ...model.status.map((s) => el('p', { class: `span-note span-note-${s.tone}`, text: s.text, attrs: { 'data-testid': `span-${s.tone}` } })),
      );
    }
    if (this.changed('history', model.history)) {
      this.history.replaceChildren(
        ...model.history.map((h) => el('li', {}, [el('span', { class: 'span-when', text: h.when }), el('span', { class: 'span-what', text: h.text })])),
      );
    }
    this.history.hidden = model.history.length === 0;
    this.historyEmpty.hidden = model.history.length > 0;
    if (this.changed('risk', model.risk)) {
      this.risk.replaceChildren(
        ...model.risk.map((r) =>
          el('tr', { class: r.current ? 'is-current' : '' }, [
            el('th', { text: r.current ? `${r.label} (now)` : r.label, attrs: { scope: 'row' } }),
            el('td', { text: r.outages }),
            el('td', { text: r.daysOut }),
            el('td', { text: r.repairsShort, attrs: { title: r.repairs } }),
          ]),
        ),
      );
    }
    const rebuild = model.rebuild;
    this.rebuildBox.hidden = rebuild === null;
    this.underground.hidden = rebuild !== null;
    if (rebuild) {
      if (this.changed('rebuildRows', rebuild.rows)) this.rebuildRows.replaceChildren(...rebuild.rows.map(factRow));
      setText(this.button, rebuild.label);
      if (this.button.disabled !== !rebuild.ok) this.button.disabled = !rebuild.ok;
      this.blockers.hidden = rebuild.ok;
      if (this.changed('blockers', rebuild.reasons)) this.blockers.replaceChildren(...rebuild.reasons.map((r) => el('li', { text: r })));
      const credit = rebuild.credit ?? '';
      setText(this.credit, credit);
      this.credit.hidden = credit === '';
    }
  }

  private convert(): void {
    const span = this.spanId;
    if (span === null) return;
    const state = this.deps.getState();
    const street = state.city.segments[state.network.spans.find((s) => s.id === span)?.segment ?? -1]?.name ?? 'the street';
    const result = this.deps.dispatch({ type: 'convertSpan', span });
    const after = this.deps.getState();
    if (result.ok) {
      const conversion = after.network.spans.find((s) => s.id === span)?.conversion;
      const timing = conversion ? `: city permit ${plural(conversion.stageDaysLeft, 'day')}, then ${plural(conversion.constructDays, 'day')} of digging` : '';
      this.deps.toast(`Underground rebuild ordered on ${street} for ${formatMoney(result.cost)}${timing}${cutOffNote(after, span)}`, true);
    } else {
      this.deps.toast(result.reason, false);
    }
    this.update(after, true);
  }
}

function factRow(row: CardRow): HTMLElement {
  const value = el('dd', { class: `num${row.tone ? ` tone-${row.tone}` : ''}`, text: row.value });
  if (row.sub) value.append(el('small', { class: 'span-sub-note', text: ` ${row.sub}` }));
  return el('div', { class: 'row' }, [el('dt', { text: row.label }), value]);
}
