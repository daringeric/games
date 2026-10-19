// Publish the theme to CSS custom properties so style.css holds no colors or
// sizes of its own.

import type { Theme } from '../render/theme';

export function applyThemeCss(theme: Theme, root: HTMLElement = document.documentElement): void {
  const { ui, cable, house, cabinet } = theme;
  const vars: Record<string, string> = {
    '--page': ui.page,
    '--card': ui.card,
    '--card-border': ui.cardBorder,
    '--shadow': ui.shadow,
    '--shadow-offset': `${ui.shadowOffset}px`,
    '--text': ui.text,
    '--text-2': ui.textSecondary,
    '--accent': ui.accent,
    '--active': ui.active,
    '--active-shadow': ui.activeShadow,
    '--active-text': ui.activeText,
    '--chip': ui.chip,
    '--hover': ui.hover,
    '--danger': ui.danger,
    '--danger-bg': ui.dangerBg,
    '--success': ui.success,
    '--success-bg': ui.successBg,
    '--warning': ui.warning,
    '--focus': ui.focus,
    '--radius': `${ui.radius}px`,
    '--pill': `${ui.pillRadius}px`,
    '--touch': `${ui.touch}px`,
    '--gap': `${ui.gap}px`,
    '--fs': `${ui.fontSize}px`,
    '--fs-num': `${ui.numberSize}px`,
    '--font-ui': `'${theme.fonts.ui}', system-ui, sans-serif`,
    '--font-display': `'${theme.fonts.display}', '${theme.fonts.ui}', system-ui, sans-serif`,
    '--tone-aerial': cable.aerial.tube,
    '--tone-underground': cable.underground.tube,
    '--tone-cabinet': cabinet.light,
    '--tone-remove': theme.overlay.remove,
    '--tone-info': house.passed.roof,
    '--passed': house.passed.roof,
    '--passed-dark': house.passed.ridge,
    '--crew': cable.constructing.tube,
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', ui.page);
}
