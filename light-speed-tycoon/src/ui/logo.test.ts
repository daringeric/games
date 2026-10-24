// The game's logo and the files made from it (scripts/logo-assets.py): the
// banner's img attributes, each file's size and pixel dimensions (read from
// its header), and the page's icon, manifest and link-preview tags.

import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LOGO_ALT, LOGO_HEIGHT, LOGO_SRCSET, LOGO_WIDTH, logoAttrs } from './logo';

const file = (path: string) => new URL(`../../${path}`, import.meta.url);
const bytes = (path: string) => readFileSync(file(path));
const kb = (path: string) => statSync(file(path)).size / 1024;

/** A PNG's size, from its IHDR chunk. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect(buf.subarray(12, 16).toString('latin1')).toBe('IHDR');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** A WebP's size, from its VP8 (lossy), VP8L (lossless) or VP8X (extended) header. */
function webpSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 4).toString('latin1')).toBe('RIFF');
  expect(buf.subarray(8, 12).toString('latin1')).toBe('WEBP');
  const chunk = buf.subarray(12, 16).toString('latin1');
  if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  expect(chunk).toBe('VP8X');
  return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
}

/** A JPEG's size, from its first start-of-frame marker. */
function jpegSize(buf: Buffer): { width: number; height: number } {
  expect(buf.readUInt16BE(0)).toBe(0xffd8);
  let at = 2;
  while (at < buf.length) {
    const marker = buf.readUInt16BE(at);
    const length = buf.readUInt16BE(at + 2);
    // SOF0..SOF15, less DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xffc0 && marker <= 0xffcf && ![0xffc4, 0xffc8, 0xffcc].includes(marker)) {
      return { width: buf.readUInt16BE(at + 7), height: buf.readUInt16BE(at + 5) };
    }
    at += 2 + length;
  }
  throw new Error('no start-of-frame marker');
}

describe('the logo image', () => {
  it('names the game, offers both files by width, and holds its shape while it loads', () => {
    const attrs = logoAttrs('394px');
    expect(attrs.alt).toBe('Light Speed Tycoon');
    expect(attrs.alt).toBe(LOGO_ALT);
    expect(attrs.decoding).toBe('async');
    expect(attrs.sizes).toBe('394px');
    expect(attrs.srcset).toBe(LOGO_SRCSET);
    const candidates = attrs.srcset!.split(', ').map((c) => c.split(' '));
    expect(candidates.map(([, w]) => w)).toEqual(['640w', '1280w']);
    expect(candidates[0]![0]).toMatch(/logo-640.*\.webp$/);
    expect(candidates[1]![0]).toMatch(/logo-1280.*\.webp$/);
    expect(attrs.src).toBe(candidates[0]![0]);
    expect(attrs.width).toBe(String(LOGO_WIDTH));
    expect(attrs.height).toBe(String(LOGO_HEIGHT));
    // Never dragged off the menu onto the map as a picture.
    expect(attrs.draggable).toBe('false');
  });

  it('loads at once unless asked to wait (the hidden menu copy waits until it is shown)', () => {
    expect(logoAttrs('394px')).not.toHaveProperty('loading');
    const lazy = logoAttrs('98px', { loading: 'lazy' });
    expect(lazy.loading).toBe('lazy');
    // Everything else as before.
    const { loading: _loading, ...rest } = lazy;
    expect(rest).toEqual(logoAttrs('98px'));
  });

  it('matches the files: 640 and 1280 wide, one aspect ratio, each within its budget', () => {
    const small = webpSize(bytes('src/assets/logo-640.webp'));
    const large = webpSize(bytes('src/assets/logo-1280.webp'));
    expect(small.width).toBe(640);
    expect(large).toEqual({ width: LOGO_WIDTH, height: LOGO_HEIGHT });
    expect(Math.abs(small.width / small.height - LOGO_WIDTH / LOGO_HEIGHT)).toBeLessThan(0.01);
    expect(kb('src/assets/logo-640.webp')).toBeLessThanOrEqual(60);
    expect(kb('src/assets/logo-1280.webp')).toBeLessThanOrEqual(160);
  });
});

describe('the icons and link preview', () => {
  it('has a square icon at every size the page and manifest name', () => {
    for (const [path, size] of [
      ['public/favicon-32.png', 32],
      ['public/apple-touch-icon.png', 180],
      ['public/icon-192.png', 192],
      ['public/icon-512.png', 512],
    ] as const) {
      expect(pngSize(bytes(path)), path).toEqual({ width: size, height: size });
    }
  });

  it('has a 1200x630 preview image', () => {
    expect(jpegSize(bytes('public/og-image.jpg'))).toEqual({ width: 1200, height: 630 });
  });

  it('links the favicon, touch icon and manifest, and tags the page for link previews', () => {
    const html = readFileSync(file('index.html'), 'utf8');
    const meta = (attr: 'name' | 'property', key: string) => html.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(html).toContain('<link rel="manifest" href="/site.webmanifest" />');
    // The existing tags stay; the preview reuses the description.
    expect(html).toContain('<title>Light Speed Tycoon</title>');
    const description = meta('name', 'description');
    expect(description).toBeTruthy();
    expect(meta('property', 'og:description')).toBe(description);
    expect(meta('property', 'og:title')).toBe('Light Speed Tycoon');
    expect(meta('property', 'og:type')).toBe('website');
    // Link previews need an absolute URL: the deployed copy of public/og-image.jpg.
    expect(meta('property', 'og:image')).toBe('https://games-five-mu.vercel.app/og-image.jpg');
    expect(meta('property', 'og:image:width')).toBe('1200');
    expect(meta('property', 'og:image:height')).toBe('630');
    expect(meta('property', 'og:image:alt')).toMatch(/Light Speed Tycoon/);
    expect(meta('name', 'twitter:card')).toBe('summary_large_image');
  });

  it('has a manifest whose icons exist, on the logo navy', () => {
    const manifest = JSON.parse(readFileSync(file('public/site.webmanifest'), 'utf8')) as {
      name: string;
      short_name: string;
      display: string;
      background_color: string;
      theme_color: string;
      icons: { src: string; sizes: string; type: string }[];
    };
    expect(manifest.name).toBe('Light Speed Tycoon');
    expect(manifest.short_name.length).toBeGreaterThan(0);
    expect(manifest.display).toBe('standalone');
    expect(manifest.background_color).toMatch(/^#[0-9a-f]{6}$/);
    expect(manifest.theme_color).toBe(manifest.background_color);
    expect(manifest.icons.map((i) => i.sizes)).toEqual(['192x192', '512x512']);
    for (const icon of manifest.icons) {
      const { width, height } = pngSize(bytes(`public/${icon.src}`));
      expect(`${width}x${height}`).toBe(icon.sizes);
      expect(icon.type).toBe('image/png');
    }
  });
});
