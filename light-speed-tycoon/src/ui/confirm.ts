// Modal dialogs: the confirmation for actions that replace the town in play,
// and the shared sheet the pricing, milestones, rate card and game-over
// dialogs are built on. Both use a native <dialog> opened with showModal(), so
// the rest of the page is inert while one is open (focus stays inside it, and
// the map's keyboard shortcuts stand aside: see isDialogOpen), Esc closes it,
// and focus returns to where it was when it closes.
//
// In the confirmation, focus starts on the safe choice, so a stray Space or
// Enter (Space also pauses the game) can never confirm, and Esc or a click
// outside cancels.
//
// Owner: ui-economy workstream.

import { el, icon } from './dom';
import { ICONS } from './icons';

export interface ConfirmOptions {
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel?: string;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const cancel = el('button', { class: 'btn confirm-cancel', text: opts.cancelLabel ?? 'Keep playing', attrs: { type: 'button' } });
    const ok = el('button', { class: 'btn confirm-ok', text: opts.confirmLabel, attrs: { type: 'button' } });
    const title = el('h2', { class: 'confirm-title', text: opts.title, attrs: { id: 'confirm-title' } });
    const detail = el('p', { class: 'confirm-detail', text: opts.detail, attrs: { id: 'confirm-detail' } });
    const dialog = el('dialog', { class: 'confirm pill-card', attrs: { 'aria-labelledby': 'confirm-title', 'aria-describedby': 'confirm-detail' } }, [
      title,
      detail,
      el('div', { class: 'confirm-actions' }, [cancel, ok]),
    ]);

    // Answer within the click itself, not in the later 'close' event: the
    // dialog disappears at once, and nothing (a script, a test) may see it gone
    // before the confirmed action has run.
    const finish = (value: boolean) => {
      resolve(value);
      dialog.close();
    };
    const returnTo = document.activeElement;
    dialog.addEventListener('close', () => {
      dialog.remove();
      restoreFocus(returnTo);
      // Esc closes without an answer: that is a no.
      resolve(false);
    });
    cancel.addEventListener('click', () => finish(false));
    ok.addEventListener('click', () => finish(true));
    // A press on the backdrop lands on the dialog element itself.
    dialog.addEventListener('pointerdown', (e) => {
      if (e.target === dialog) finish(false);
    });

    document.body.append(dialog);
    dialog.showModal();
    cancel.focus();
  });
}

/** True while a modal dialog is open; global shortcuts stand aside for it. */
export function isDialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}

function restoreFocus(target: Element | null): void {
  if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true });
}

export interface SheetOptions {
  /** Heading, also the dialog's accessible name. */
  title: string;
  /** Short line under the heading (the dialog's accessible description). */
  subtitle?: string;
  /** Extra class names on the <dialog>. */
  className?: string;
  /** Esc and a close button close it (default true). */
  dismissable?: boolean;
  /** A press on the backdrop closes it too (default: when dismissable). */
  backdropCloses?: boolean;
  /** Called once, after it closed and left the page. */
  onClose?: () => void;
}

export interface Sheet {
  readonly dialog: HTMLDialogElement;
  /** Scrolling content area. */
  readonly body: HTMLElement;
  /** Action row along the bottom (empty and hidden until something is put in it). */
  readonly actions: HTMLElement;
  readonly isOpen: boolean;
  close(): void;
}

let sheetCount = 0;

/**
 * Open a modal sheet: a heading, a scrolling body and an action row. Fill
 * `body` and `actions` (synchronously or later), and focus something inside
 * if the close button is the wrong first stop.
 */
export function openSheet(opts: SheetOptions): Sheet {
  const id = `sheet-${++sheetCount}`;
  const dismissable = opts.dismissable ?? true;
  const titleId = `${id}-title`;
  const subtitleId = `${id}-subtitle`;
  const header = el('header', { class: 'sheet-head' }, [
    el('div', { class: 'sheet-heading' }, [
      el('h2', { class: 'sheet-title', text: opts.title, attrs: { id: titleId } }),
      opts.subtitle ? el('p', { class: 'sheet-subtitle', text: opts.subtitle, attrs: { id: subtitleId } }) : null,
    ]),
  ]);
  const body = el('div', { class: 'sheet-body' });
  const actions = el('div', { class: 'sheet-actions' });
  const attrs: Record<string, string> = { 'aria-labelledby': titleId };
  if (opts.subtitle) attrs['aria-describedby'] = subtitleId;
  const dialog = el('dialog', { class: `sheet pill-card ${opts.className ?? ''}`.trim(), attrs }, [header, body, actions]);

  let open = true;
  const close = () => {
    if (open) dialog.close();
  };
  if (dismissable) {
    header.append(
      el('button', {
        class: 'btn icon-btn sheet-close',
        attrs: { type: 'button', 'aria-label': 'Close' },
        on: { click: close },
      }, [icon(ICONS.close)]),
    );
    if (opts.backdropCloses ?? true) {
      // A press on the backdrop lands on the dialog element itself (outside its box).
      dialog.addEventListener('pointerdown', (e) => {
        if (e.target !== dialog) return;
        const r = dialog.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
      });
    }
  } else {
    // Esc would leave the player with no way forward: only the actions close it.
    dialog.addEventListener('cancel', (e) => e.preventDefault());
  }

  const returnTo = document.activeElement;
  dialog.addEventListener('close', () => {
    open = false;
    dialog.remove();
    restoreFocus(returnTo);
    opts.onClose?.();
  });

  document.body.append(dialog);
  dialog.showModal();
  return {
    dialog,
    body,
    actions,
    get isOpen() {
      return open;
    },
    close,
  };
}
