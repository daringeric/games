// The card that follows the cursor with a quote or details for whatever is
// under it (rendered from the tools' CardModel): an itemized charge table,
// label/value rows (cost-per-passing values colored by band, money below $0
// in red), amber warnings, small print, red blockers, the credit-line note
// when cash is short, and a hint line.

import { el } from './dom';
import type { CardModel, CardRow } from './tools';

/** Screen band the card may use: below the HUD and above a bottom toolbar (CSS px). */
export interface CardSafeArea {
  top: number;
  bottom: number;
}

export interface CardPlacementInput {
  /** Pointer (or finger), CSS px. */
  x: number;
  y: number;
  /** Card size in full, and with its compact layout. */
  w: number;
  h: number;
  compactW: number;
  compactH: number;
  viewW: number;
  viewH: number;
  safe: CardSafeArea;
}

export interface CardPlacement {
  left: number;
  top: number;
  /** Show the compact layout (the full card could not sit clear of the pointer). */
  compact: boolean;
}

const GAP = 18;
const EDGE = 8;

/**
 * Where the card goes: below-right of the pointer, flipping left and up to
 * stay on screen and inside `safe` (clear of the HUD and a bottom toolbar).
 * It never sits on the pointer when it can help it: when it would cover the
 * pointer's column and fits neither below nor above it, the compact layout is
 * tried, and failing that the card docks to the end of the safe band farther
 * from the pointer. (A finger dragging cable must see the run it draws.)
 */
export function placeCard(input: CardPlacementInput): CardPlacement {
  const { x, y, viewW, viewH } = input;
  const safeTop = Math.max(EDGE, input.safe.top);
  const safeBottom = Math.min(viewH - EDGE, input.safe.bottom);
  const place = (w: number, h: number, compact: boolean): CardPlacement & { clear: boolean } => {
    let left = x + GAP;
    if (left + w > viewW - EDGE) left = x - GAP - w;
    left = Math.max(EDGE, Math.min(left, viewW - EDGE - w));
    const coversColumn = left <= x && x <= left + w;
    const below = y + GAP;
    const above = y - GAP - h;
    if (below + h <= safeBottom) return { left, top: below, compact, clear: true };
    if (above >= safeTop) return { left, top: above, compact, clear: true };
    if (!coversColumn) return { left, top: Math.max(safeTop, Math.min(y - h / 2, safeBottom - h)), compact, clear: true };
    // Dock to the end of the safe band farther from the pointer.
    const top = y > (safeTop + safeBottom) / 2 ? safeTop : Math.max(safeTop, safeBottom - h);
    return { left, top, compact, clear: !(top <= y && y <= top + h) };
  };
  const full = place(input.w, input.h, false);
  if (full.clear) return { left: full.left, top: full.top, compact: false };
  const compact = place(input.compactW, input.compactH, true);
  return { left: compact.left, top: compact.top, compact: true };
}

/** Card that follows the cursor with a quote or details for whatever is under it. */
export class FloatingCard {
  // Hidden until the first frame has something to show (and for good if boot fails).
  readonly root = el('div', { class: 'float-card pill-card', attrs: { 'aria-live': 'polite', hidden: '' } });
  private card: CardModel | null = null;
  private key = '';
  /** Full and compact sizes of the built card, measured once per content and view size. */
  private sizes: { key: string; w: number; h: number; compactW: number; compactH: number } | null = null;

  render(card: CardModel | null, x: number, y: number, viewW: number, viewH: number, safe: CardSafeArea = { top: 0, bottom: viewH }): void {
    if (!card) {
      this.root.hidden = true;
      this.card = null;
      this.key = '';
      return;
    }
    // The tools memoize their view, so an unchanged card is the same object: skip the compare.
    if (card !== this.card) {
      this.card = card;
      const key = JSON.stringify(card);
      if (key !== this.key) {
        this.key = key;
        this.build(card);
      }
    }
    this.root.hidden = false;
    const sizes = this.measure(viewW, viewH);
    const { left, top, compact } = placeCard({ x, y, ...sizes, viewW, viewH, safe });
    this.root.classList.toggle('compact', compact);
    this.root.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  /** The card's size in full and compact, re-measured only when its content or the view changes. */
  private measure(viewW: number, viewH: number): { w: number; h: number; compactW: number; compactH: number } {
    const key = `${this.key}|${viewW}x${viewH}`;
    if (this.sizes?.key === key) return this.sizes;
    const root = this.root;
    const was = root.classList.contains('compact');
    root.classList.remove('compact');
    const w = root.offsetWidth;
    const h = root.offsetHeight;
    root.classList.add('compact');
    const compactW = root.offsetWidth;
    const compactH = root.offsetHeight;
    root.classList.toggle('compact', was);
    this.sizes = { key, w, h, compactW, compactH };
    return this.sizes;
  }

  private build(card: CardModel): void {
    const lines = card.lines ?? [];
    this.root.className = `float-card pill-card tone-${card.tone}${lines.length > 0 ? ' has-lines' : ''}`;
    const parts: Node[] = [el('h3', { text: card.title })];
    if (lines.length > 0) {
      parts.push(
        el(
          'table',
          { class: 'quote-lines' },
          [
            el(
              'tbody',
              {},
              lines.map((l) =>
                el('tr', {}, [
                  el('th', { text: l.label, attrs: { scope: 'row' } }),
                  el('td', { class: 'quote-detail', text: l.detail }),
                  el('td', { class: 'quote-amount num', text: l.amount }),
                ]),
              ),
            ),
          ],
        ),
      );
    }
    if (card.rows.length > 0) {
      parts.push(
        el(
          'dl',
          {},
          card.rows.map((r) =>
            el('div', { class: 'row' }, [
              el('dt', { text: r.label }),
              el(
                'dd',
                { class: r.tone ? `tone-value ${valueToneClass(r.tone)}` : undefined },
                r.sub ? [r.value, el('small', { class: 'row-sub', text: r.sub })] : [r.value],
              ),
            ]),
          ),
        ),
      );
    }
    const warnings = card.warnings ?? [];
    if (warnings.length > 0) parts.push(el('ul', { class: 'card-warnings' }, warnings.map((w) => el('li', { text: w }))));
    if (card.note) parts.push(el('p', { class: 'card-note', text: card.note }));
    if (card.blockers.length > 0) parts.push(el('ul', { class: 'blockers' }, card.blockers.map((b) => el('li', { text: b }))));
    if (card.credit) parts.push(el('p', { class: 'card-credit', text: card.credit }));
    if (card.hint) parts.push(el('p', { class: 'hint-line', text: card.hint }));
    this.root.replaceChildren(...parts);
  }
}

/** The class that colors a row's value. */
function valueToneClass(tone: NonNullable<CardRow['tone']>): string {
  if (tone === 'muted' || tone === 'negative') return `tone-${tone}`;
  return `tone-cpp-${tone}`;
}
