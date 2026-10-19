// Tool palette: vertical on the left, a bottom bar at phone width.

import { el, icon } from './dom';
import { ICONS } from './icons';
import type { ToolId } from './tools';

interface ToolInfo {
  id: ToolId;
  key: string;
  label: string;
  tip: string;
}

export const TOOLS: readonly ToolInfo[] = [
  { id: 'inspect', key: 'I', label: 'Inspect', tip: 'Inspect: hover anything for details, drag to pan' },
  { id: 'aerial', key: 'A', label: 'Aerial cable', tip: 'Aerial cable: cheap and quick to build, needs poles' },
  { id: 'underground', key: 'U', label: 'Underground cable', tip: 'Underground cable: costs more, no poles needed' },
  { id: 'cabinet', key: 'C', label: 'Cabinet', tip: 'Cabinet: splits light out to the streets around it' },
  { id: 'remove', key: 'X', label: 'Remove cable', tip: 'Remove: cancel cable (refunded while permitting)' },
];

export class Toolbar {
  readonly root: HTMLElement;
  private readonly buttons = new Map<ToolId, HTMLButtonElement>();

  constructor(onPick: (tool: ToolId) => void) {
    this.root = el('nav', { class: 'toolbar pill-card', attrs: { 'aria-label': 'Tools' } });
    for (const tool of TOOLS) {
      const button = el(
        'button',
        {
          class: `btn tool tool-${tool.id}`,
          attrs: {
            type: 'button',
            'aria-label': `${tool.label} (${tool.key})`,
            'aria-pressed': 'false',
            'aria-keyshortcuts': tool.key,
            'data-tip': `${tool.tip} (${tool.key})`,
            'data-tool': tool.id,
          },
          on: { click: () => onPick(tool.id) },
        },
        [icon(ICONS[tool.id]), el('kbd', { text: tool.key, attrs: { 'aria-hidden': 'true' } })],
      );
      this.buttons.set(tool.id, button);
      this.root.append(button);
    }
  }

  select(tool: ToolId): void {
    for (const [id, button] of this.buttons) button.setAttribute('aria-pressed', String(id === tool));
  }
}
