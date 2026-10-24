// The game's logo (the owner's artwork): the start screen's title banner and
// the menu's header. The files are made from the original by
// scripts/logo-assets.py (trimmed to the logo's glow, edges eased into the
// theme's logoBackdrop), imported here so Vite gives them hashed, long-cached
// /assets URLs. The logo sits on a strip of its own navy (--logo-backdrop):
// it is a dark image and the Toy Town cards are light.

import logo640 from '../assets/logo-640.webp';
import logo1280 from '../assets/logo-1280.webp';
import { el } from './dom';

/** The logo's text alternative: what it says. */
export const LOGO_ALT = 'Light Speed Tycoon';

/** The larger file's size: the img's width and height (its aspect ratio before it loads). */
export const LOGO_WIDTH = 1280;
export const LOGO_HEIGHT = 682;

/** Both files, by width: the browser picks one for the size shown and the screen's density. */
export const LOGO_SRCSET = `${logo640} 640w, ${logo1280} 1280w`;

/**
 * The img attributes for the logo shown at `sizes` (the CSS width it takes,
 * per media condition): the small file as the fallback src, explicit width
 * and height so nothing moves while it loads, decoded off the main thread,
 * and never dragged off as a picture. `extra` adds to them or overrides them:
 * `{ loading: 'lazy' }` for a copy that starts hidden (the menu's), which the
 * browser then fetches only once it is shown; a hidden img otherwise loads
 * at once, and at a high density it is another file than the start screen's.
 */
export function logoAttrs(sizes: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    src: logo640,
    srcset: LOGO_SRCSET,
    sizes,
    width: String(LOGO_WIDTH),
    height: String(LOGO_HEIGHT),
    alt: LOGO_ALT,
    decoding: 'async',
    draggable: 'false',
    ...extra,
  };
}

/** The logo as an img with class `cls`, shown at `sizes` (`extra`: see logoAttrs). */
export function logoImage(cls: string, sizes: string, extra: Record<string, string> = {}): HTMLImageElement {
  return el('img', { class: cls, attrs: logoAttrs(sizes, extra) });
}
