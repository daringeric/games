// Transient HTML overlays: toasts and the first-run hint card. (The floating
// quote/inspect card lives in floatingCard.ts with the map tools.)
//
// Owner: ui-economy workstream.

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

/** How a sim notice is toasted: milestones and resumed installs are good news, the end of the game is bad, the rest need attention. */
export function noticeTone(notice: Notice): ToastTone {
  switch (notice.kind) {
    case 'milestone':
    case 'installsResumed':
      return 'ok';
    case 'gameOver':
      return 'err';
    case 'insolvencyWarning':
    case 'installsPaused':
    case 'cabinetFull':
    case 'serviceLost':
    case 'oltFull':
    case 'rulesUpdated':
      return 'warn';
  }
}

/** A screen box in CSS px. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface ToastLayoutInput {
  viewW: number;
  viewH: number;
  /** The stylesheet's bottom offset for the toasts at this screen size. */
  baseBottom: number;
  hudBottom: number;
  /** The monthly report panel and the toolbar, when shown. */
  panel: Box | null;
  toolbar: Box | null;
}

export interface ToastLayout {
  /** Centre x of the toast column, or null for the stylesheet's (mid-screen). */
  center: number | null;
  /** Narrower column than the stylesheet's, or null. */
  maxWidth: number | null;
  /** Bottom offset of the column (CSS px from the bottom of the screen). */
  bottom: number;
  /** Height the column may stack up to (under the HUD) before the oldest toasts are dropped. */
  maxHeight: number;
}

/** Widest toast column (matches .toasts max-width: min(520px, 100vw - 32px)). */
const TOAST_COLUMN_MAX = 520;
const TOAST_EDGE = 16;
/** A column beside the report panel narrower than this would wrap toasts too much: go above it instead. */
const TOAST_SIDE_MIN = 260;
const TOAST_GAP = 10;

/**
 * Where the toast column goes so it never covers the monthly report panel: at
 * the stylesheet's spot when that is clear; beside the panel when there is
 * room between it and a toolbar on the left (wide screens); otherwise above
 * whatever it would cover (the panel, a bottom toolbar), no higher than the HUD.
 */
export function toastLayout(input: ToastLayoutInput): ToastLayout {
  const { viewW, viewH, panel, toolbar } = input;
  const shown = (b: Box | null): b is Box => b !== null && b.right > b.left && b.bottom > b.top && b.top < viewH;
  const under = (b: Box, left: number, right: number) => b.left < right && b.right > left;
  let width = Math.min(TOAST_COLUMN_MAX, viewW - 2 * TOAST_EDGE);
  let center: number | null = null;
  let maxWidth: number | null = null;
  let left = (viewW - width) / 2;
  if (shown(panel) && under(panel, left, left + width)) {
    // A toolbar down the left side bounds the room beside the panel.
    const leftBar = shown(toolbar) && toolbar.right < viewW / 2 && toolbar.top < viewH / 2 ? toolbar.right + TOAST_GAP : TOAST_EDGE;
    const room = panel.left - TOAST_GAP - leftBar;
    if (room >= TOAST_SIDE_MIN) {
      width = Math.min(width, room);
      left = leftBar + (room - width) / 2;
      center = left + width / 2;
      maxWidth = width;
    }
  }
  let bottom = input.baseBottom;
  for (const box of [panel, toolbar]) {
    if (shown(box) && under(box, left, left + width)) bottom = Math.max(bottom, viewH - box.top + TOAST_GAP);
  }
  return { center, maxWidth, bottom, maxHeight: Math.max(0, viewH - bottom - input.hudBottom - TOAST_GAP) };
}

export class Toasts {
  readonly root = el('div', { class: 'toasts', attrs: { role: 'status', 'aria-live': 'polite' } });
  /** Height the column may stack up to before older toasts are dropped (see keepClear). */
  private room = Infinity;

  /** Move the column clear of the report panel and toolbar (call when either, the HUD or the screen changes size). */
  keepClear(view: Omit<ToastLayoutInput, 'baseBottom'>): void {
    const style = this.root.style;
    style.left = '';
    style.maxWidth = '';
    style.bottom = '';
    const baseBottom = Number.parseFloat(getComputedStyle(this.root).bottom) || 0;
    const layout = toastLayout({ ...view, baseBottom });
    if (layout.center !== null) style.left = `${Math.round(layout.center)}px`;
    if (layout.maxWidth !== null) style.maxWidth = `${Math.floor(layout.maxWidth)}px`;
    style.bottom = `${Math.round(layout.bottom)}px`;
    this.room = layout.maxHeight;
    this.trim();
  }

  /** Drop the oldest toasts while the stack is taller than its room (the newest always stays). */
  private trim(): void {
    while (this.root.childElementCount > 1 && this.root.offsetHeight > this.room) this.root.firstElementChild?.remove();
  }

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
    this.trim();
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
