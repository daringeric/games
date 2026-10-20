// The card that follows the cursor with a quote or details for whatever is
// under it (rendered from the tools' CardModel): an itemized charge table,
// label/value rows (cost-per-passing values colored by band), amber warnings,
// small print, red blockers and a hint line.

import { el } from './dom';
import type { CardModel } from './tools';

/** Card that follows the cursor with a quote or details for whatever is under it. */
export class FloatingCard {
  // Hidden until the first frame has something to show (and for good if boot fails).
  readonly root = el('div', { class: 'float-card pill-card', attrs: { 'aria-live': 'polite', hidden: '' } });
  private card: CardModel | null = null;
  private key = '';

  render(card: CardModel | null, x: number, y: number, viewW: number, viewH: number): void {
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
    // Sit below-right of the cursor, flipping to stay on screen.
    const w = this.root.offsetWidth;
    const h = this.root.offsetHeight;
    const gap = 18;
    let left = x + gap;
    let top = y + gap;
    if (left + w > viewW - 8) left = x - gap - w;
    if (top + h > viewH - 8) top = y - gap - h;
    this.root.style.transform = `translate(${Math.max(8, Math.round(left))}px, ${Math.max(8, Math.round(top))}px)`;
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
                { class: r.tone ? `tone-value tone-${r.tone === 'muted' ? 'muted' : `cpp-${r.tone}`}` : undefined },
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
    if (card.hint) parts.push(el('p', { class: 'hint-line', text: card.hint }));
    this.root.replaceChildren(...parts);
  }
}
