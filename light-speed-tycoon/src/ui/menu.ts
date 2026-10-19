// Game menu: new game, save/load to browser storage, export/import JSON files.

import { el } from './dom';

export interface MenuActions {
  newGame(): void;
  save(): void;
  load(): void;
  exportFile(): void;
  importFile(file: File): void;
}

export class Menu {
  readonly root: HTMLElement;
  private readonly fileInput: HTMLInputElement;

  constructor(
    private readonly button: HTMLButtonElement,
    actions: MenuActions,
  ) {
    this.fileInput = el('input', {
      class: 'visually-hidden',
      attrs: { type: 'file', accept: 'application/json,.json', 'aria-label': 'Import a saved game file', tabindex: '-1' },
    });
    this.fileInput.addEventListener('change', () => {
      const file = this.fileInput.files?.[0];
      this.fileInput.value = '';
      if (file) actions.importFile(file);
    });
    const item = (label: string, detail: string, run: () => void) =>
      el(
        'button',
        {
          class: 'btn menu-item',
          attrs: { type: 'button', role: 'menuitem' },
          on: {
            click: () => {
              this.close();
              run();
            },
          },
        },
        [el('span', { class: 'menu-label', text: label }), el('span', { class: 'menu-detail', text: detail })],
      );
    this.root = el('div', { class: 'menu pill-card', attrs: { role: 'menu', 'aria-label': 'Game menu' } }, [
      item('New game', 'A fresh town from a new seed', actions.newGame),
      item('Save', 'Keep this game in your browser', actions.save),
      item('Load', 'Go back to your last save', actions.load),
      item('Export', 'Download the game as a file', actions.exportFile),
      item('Import', 'Open a downloaded game file', () => this.fileInput.click()),
      this.fileInput,
    ]);
    this.root.hidden = true;
    button.addEventListener('click', () => (this.root.hidden ? this.open() : this.close()));
    document.addEventListener('pointerdown', (e) => {
      const target = e.target as Node;
      if (!this.root.hidden && !this.root.contains(target) && !button.contains(target)) this.close();
    });
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    this.root.querySelector<HTMLButtonElement>('.menu-item')?.focus();
  }

  close(): void {
    this.root.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
  }
}
