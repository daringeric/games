// Tool palette: vertical on the left, a bottom bar at phone width. After the
// tools come the view switches (not tools): the $/ft cost overlay and (round
// 4b) the storm-exposure overlay. MapControls keeps the two overlays apart:
// switching one on switches the other off.

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
  { id: 'inspect', key: 'I', label: 'Inspect', tip: 'Inspect: hover anything for details, drag to pan. Click the CO for the OLT' },
  { id: 'aerial', key: 'A', label: 'Aerial cable', tip: 'Aerial cable: cheap and quick to build, needs poles. Click corner to corner, or drag along streets' },
  { id: 'underground', key: 'U', label: 'Underground cable', tip: 'Underground cable: costs more, no poles needed. Click corner to corner, or drag along streets' },
  { id: 'cabinet', key: 'C', label: 'Cabinet', tip: 'Cabinet: splits light out to the streets around it. Click one to add a splitter' },
  { id: 'remove', key: 'X', label: 'Remove', tip: 'Remove: cancel cable or a cabinet (refunded while permitting)' },
];

export const OVERLAY_KEY = 'O';
/** Round 4b: the storm-exposure overlay's key. */
export const EXPOSURE_KEY = 'E';

export class Toolbar {
  readonly root: HTMLElement;
  /** The $/ft cost overlay switch. */
  readonly overlayButton: HTMLButtonElement;
  /** Round 4b: the storm-exposure overlay switch. */
  readonly exposureButton: HTMLButtonElement;
  private readonly buttons = new Map<ToolId, HTMLButtonElement>();

  constructor(onPick: (tool: ToolId) => void, onToggleOverlay: () => void = () => {}, onToggleExposure: () => void = () => {}) {
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
    this.overlayButton = el(
      'button',
      {
        class: 'btn tool tool-overlay',
        attrs: {
          type: 'button',
          'aria-label': `Cost overlay (${OVERLAY_KEY})`,
          'aria-pressed': 'false',
          'aria-keyshortcuts': OVERLAY_KEY,
          'data-tip': `Cost overlay: color every street by what a foot of cable costs there (${OVERLAY_KEY})`,
          'data-testid': 'cost-overlay-toggle',
        },
        on: { click: () => onToggleOverlay() },
      },
      [icon(ICONS.layers), el('kbd', { text: OVERLAY_KEY, attrs: { 'aria-hidden': 'true' } })],
    );
    this.exposureButton = el(
      'button',
      {
        class: 'btn tool tool-exposure',
        attrs: {
          type: 'button',
          'aria-label': `Storm exposure overlay (${EXPOSURE_KEY})`,
          'aria-pressed': 'false',
          'aria-keyshortcuts': EXPOSURE_KEY,
          'data-tip': `Storm exposure: color every street by how often storms hit it, sheltered to exposed (${EXPOSURE_KEY})`,
          'data-testid': 'exposure-overlay-toggle',
        },
        on: { click: () => onToggleExposure() },
      },
      [icon(ICONS.storm), el('kbd', { text: EXPOSURE_KEY, attrs: { 'aria-hidden': 'true' } })],
    );
    this.root.append(this.overlayButton, this.exposureButton);
  }

  select(tool: ToolId): void {
    for (const [id, button] of this.buttons) button.setAttribute('aria-pressed', String(id === tool));
  }

  /** Show the cost overlay switch as on or off. */
  setOverlay(on: boolean): void {
    this.overlayButton.setAttribute('aria-pressed', String(on));
  }

  /** Show the storm-exposure overlay switch as on or off. */
  setExposureOverlay(on: boolean): void {
    this.exposureButton.setAttribute('aria-pressed', String(on));
  }
}
