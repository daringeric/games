// Transient HTML overlays: toasts, the floating quote/inspect card, and the
// first-run hint card.

import { el, icon } from './dom';
import { ICONS } from './icons';
import type { CardModel } from './tools';

const TOAST_MS = 3800;
const MAX_TOASTS = 3;

export class Toasts {
  readonly root = el('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });

  /** A toast with a `key` replaces the visible toast with the same key (e.g. one month report at a time). */
  show(message: string, ok: boolean, key?: string): void {
    const toast = el('div', { class: `toast ${ok ? 'toast-ok' : 'toast-err'}` }, [
      icon(ok ? ICONS.spark : ICONS.close),
      el('span', { text: message }),
    ]);
    if (key) {
      toast.dataset.key = key;
      for (const old of this.root.querySelectorAll<HTMLElement>('.toast')) if (old.dataset.key === key) old.remove();
    }
    this.root.append(toast);
    while (this.root.childElementCount > MAX_TOASTS) this.root.firstElementChild?.remove();
    window.setTimeout(() => {
      toast.classList.add('leaving');
      window.setTimeout(() => toast.remove(), 250);
    }, TOAST_MS);
  }
}

/** Card that follows the cursor with a quote or details for whatever is under it. */
export class FloatingCard {
  // Hidden until the first frame has something to show (and for good if boot fails).
  readonly root = el('div', { class: 'float-card pill-card', attrs: { 'aria-live': 'polite', hidden: '' } });
  private key = '';

  render(card: CardModel | null, x: number, y: number, viewW: number, viewH: number): void {
    if (!card) {
      this.root.hidden = true;
      this.key = '';
      return;
    }
    const key = JSON.stringify(card);
    if (key !== this.key) {
      this.key = key;
      this.root.className = `float-card pill-card tone-${card.tone}`;
      const parts: Node[] = [el('h3', { text: card.title })];
      if (card.rows.length > 0) {
        parts.push(el('dl', {}, card.rows.map((r) => el('div', { class: 'row' }, [el('dt', { text: r.label }), el('dd', { text: r.value })]))));
      }
      if (card.blockers.length > 0) parts.push(el('ul', { class: 'blockers' }, card.blockers.map((b) => el('li', { text: b }))));
      if (card.hint) parts.push(el('p', { class: 'hint-line', text: card.hint }));
      this.root.replaceChildren(...parts);
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
}

export class HintCard {
  readonly root: HTMLElement;

  constructor(text: string) {
    const close = el('button', {
      class: 'btn hint-close',
      text: 'Got it',
      attrs: { type: 'button' },
      on: { click: () => this.hide() },
    });
    this.root = el('aside', { class: 'hint-card pill-card', attrs: { 'aria-label': 'Tip' } }, [
      el('span', { class: 'hint-badge', text: 'Tip' }),
      el('p', { text }),
      close,
    ]);
  }

  hide(): void {
    this.root.hidden = true;
  }
}
