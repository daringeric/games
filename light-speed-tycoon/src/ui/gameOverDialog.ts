// Game over: the company ran out of cash, or defaulted on its loans. The save
// is finished (the sim rejects every command and the day is frozen); offer a
// way on: load the last manual save, start a new town, or export this one.
//
// Owner: ui-economy workstream.

import type { GameOver, GameOverReason } from '../sim/types';
import { openSheet } from './confirm';
import type { Sheet } from './confirm';
import { el, icon } from './dom';
import { ICONS } from './icons';

export interface GameOverActions {
  /** Present only when a manual save exists. */
  loadLastSave?: () => void;
  startNewTown(): void;
  exportGame(): void;
}

/** The dialog's subtitle: how the company ended (round 4b: by its name, GameState.company.name). */
export function gameOverSubtitle(reason: GameOverReason, companyName: string): string {
  return reason === 'default' ? `${companyName} has defaulted on its loans.` : `${companyName} has gone bankrupt.`;
}

export class GameOverDialog {
  private sheet: Sheet | null = null;

  get isOpen(): boolean {
    return this.sheet?.isOpen ?? false;
  }

  close(): void {
    this.sheet?.close();
  }

  /** Show (or refresh) the dialog for this ending. */
  show(over: GameOver, companyName: string, actions: GameOverActions): void {
    this.close();
    const sheet = openSheet({
      title: 'Game over',
      subtitle: gameOverSubtitle(over.reason, companyName),
      className: 'game-over',
      // Esc and the close button leave the frozen town on screen; the menu still offers load, new and export.
      backdropCloses: false,
      onClose: () => {
        if (this.sheet === sheet) this.sheet = null;
      },
    });
    this.sheet = sheet;
    sheet.body.append(
      el('div', { class: 'game-over-message' }, [icon(ICONS.warning, 'icon game-over-icon'), el('p', { text: over.message })]),
      el('p', { class: 'sheet-hint', text: 'This town is finished: the clock has stopped and nothing more can be built.' }),
    );
    const button = (label: string, cls: string, run: () => void) =>
      el('button', { class: `btn ${cls}`, text: label, attrs: { type: 'button' }, on: { click: run } });
    const exportButton = button('Export', 'sheet-secondary', () => actions.exportGame());
    const buttons = [exportButton];
    if (actions.loadLastSave) {
      const load = actions.loadLastSave;
      buttons.push(button('Load last save', 'sheet-secondary', () => load()));
    }
    const fresh = button('Start a new town', 'sheet-primary', () => actions.startNewTown());
    buttons.push(fresh);
    sheet.actions.append(...buttons);
    // Start on the harmless close button: a Space meant for the clock must not start a new town.
    sheet.dialog.querySelector<HTMLButtonElement>('.sheet-close')?.focus();
  }
}
