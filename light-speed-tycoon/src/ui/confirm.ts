// Modal confirmation for actions that replace the town in play. Focus starts on
// the safe choice, so a stray Space or Enter (Space also pauses the game) can
// never confirm, and Esc or a click outside cancels.

import { el } from './dom';

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

    let answer = false;
    const finish = (value: boolean) => {
      answer = value;
      dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(answer);
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

/** True while a confirmation is open; global shortcuts stand aside for it. */
export function isDialogOpen(): boolean {
  return document.querySelector('dialog[open]') !== null;
}
