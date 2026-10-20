// Game menu: new game, save/load to browser storage, export/import JSON files,
// and the rate card.
//
// Owner: ui-economy workstream.

import { el } from './dom';

export interface MenuActions {
  newGame(): void;
  save(): void;
  load(): void;
  exportFile(): void;
  importFile(file: File): void;
  rateCard(): void;
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
      item('Rate card', 'What cable, gear and installs cost', actions.rateCard),
      this.fileInput,
    ]);
    this.root.hidden = true;
    // A keyboard press of the button (Enter or Space) clicks with detail 0: only
    // then does focus move into the menu, so a stray Space after opening it with
    // the mouse can't run "New game".
    button.addEventListener('click', (e) => (this.root.hidden ? this.open(e.detail === 0) : this.close()));
    // A press outside closes the menu and does nothing else: it is caught on the
    // way down, before the map can turn it into a tool click (or a pan).
    document.addEventListener(
      'pointerdown',
      (e) => {
        const target = e.target as Node;
        if (this.root.hidden || this.root.contains(target) || button.contains(target)) return;
        this.close();
        e.stopPropagation();
        e.preventDefault();
      },
      { capture: true },
    );
    this.root.addEventListener('keydown', (e) => this.onKeyDown(e));
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** Show the menu; `focusFirst` moves keyboard focus to its first item. */
  open(focusFirst = true): void {
    this.root.hidden = false;
    this.button.setAttribute('aria-expanded', 'true');
    if (focusFirst) this.items()[0]?.focus();
  }

  close(): void {
    // Hand focus back to the menu button instead of dropping it on the page.
    const hadFocus = this.root.contains(document.activeElement);
    this.root.hidden = true;
    this.button.setAttribute('aria-expanded', 'false');
    if (hadFocus) this.button.focus();
  }

  private items(): HTMLButtonElement[] {
    return [...this.root.querySelectorAll<HTMLButtonElement>('.menu-item')];
  }

  /** Arrow keys, Home and End move focus through the items, wrapping at the ends. */
  private onKeyDown(e: KeyboardEvent): void {
    const items = this.items();
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const last = items.length - 1;
    let next: number;
    switch (e.key) {
      case 'ArrowDown':
        next = at < last ? at + 1 : 0;
        break;
      case 'ArrowUp':
        next = at > 0 ? at - 1 : last;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = last;
        break;
      default:
        return;
    }
    e.preventDefault();
    items[next]?.focus();
  }
}
