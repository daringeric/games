// Transient HTML overlays: toasts and the first-run hint card. (The floating
// quote/inspect card lives in floatingCard.ts with the map tools.)
//
// Owner: ui-economy workstream.

import { INSTALLS_RESUMED_PREFIX } from '../sim/sales';
import type { Notice } from '../sim/types';
import { el, icon } from './dom';
import { ICONS } from './icons';

const TOAST_MS = 3800;
/** Warnings carry instructions ("add a splitter..."): give them time to be read. */
const WARN_TOAST_MS = 6500;
const MAX_TOASTS = 3;

/** ok = good news, warn = needs attention, err = something failed or went badly wrong. */
export type ToastTone = 'ok' | 'warn' | 'err';

const TONE_ICON: Record<ToastTone, string> = { ok: ICONS.spark, warn: ICONS.warning, err: ICONS.close };

/** How a sim notice is toasted: milestones are good news, the end of the game is bad, the rest need attention. */
export function noticeTone(notice: Notice): ToastTone {
  switch (notice.kind) {
    case 'milestone':
      return 'ok';
    case 'gameOver':
      return 'err';
    case 'insolvencyWarning':
      // "Installs resumed" rides on the cash-trouble kind (sales.ts) but is good news.
      return notice.message.startsWith(INSTALLS_RESUMED_PREFIX) ? 'ok' : 'warn';
    case 'cabinetFull':
    case 'serviceLost':
    case 'oltFull':
      return 'warn';
  }
}

export class Toasts {
  readonly root = el('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });

  /**
   * Show a toast. `tone` is a ToastTone, or a boolean for ok (true) / err (false).
   * A toast with a `key` replaces the visible toast with the same key (e.g. one month report at a time).
   */
  show(message: string, tone: ToastTone | boolean, key?: string): void {
    const t: ToastTone = tone === true ? 'ok' : tone === false ? 'err' : tone;
    const toast = el('div', { class: `toast toast-${t}` }, [icon(TONE_ICON[t]), el('span', { text: message })]);
    if (key) {
      toast.dataset.key = key;
      for (const old of this.root.querySelectorAll<HTMLElement>('.toast')) if (old.dataset.key === key) old.remove();
    }
    this.root.append(toast);
    while (this.root.childElementCount > MAX_TOASTS) this.root.firstElementChild?.remove();
    window.setTimeout(
      () => {
        toast.classList.add('leaving');
        window.setTimeout(() => toast.remove(), 250);
      },
      t === 'warn' ? WARN_TOAST_MS : TOAST_MS,
    );
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
