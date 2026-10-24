// The game's logo outside the start screen (start.spec.ts covers that): the
// menu's header, the favicon and touch icon, the web manifest and the link
// preview tags, all served by the production build.
//
// Owner: integrator (logo).

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { open, watchErrors } from './helpers';

/** The menu's logo: shown, its file loaded. */
async function menuLogo(page: Page) {
  const logo = page.locator('.menu').getByRole('img', { name: 'Light Speed Tycoon' });
  await expect(logo).toBeVisible();
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
  return logo;
}

/** Fetch `href` (as the page would resolve it): status, type and the first bytes. */
async function fetchFrom(page: Page, href: string) {
  const res = await page.request.get(new URL(href, page.url()).href);
  return { status: res.status(), type: res.headers()['content-type'] ?? '', body: await res.body() };
}

test('the menu shows the logo above its items, outside the menu list and never focused', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.evaluate(() => window.__lst!.setSpeed(0));
  const menuButton = page.getByRole('button', { name: 'Menu' });
  await menuButton.click();
  const logo = await menuLogo(page);
  // Not an item: the list holds the seven items and nothing else.
  await expect(page.getByRole('menu').getByRole('img')).toHaveCount(0);
  await expect(page.getByRole('menuitem')).toHaveCount(7);
  const box = (await logo.boundingBox())!;
  const first = (await page.getByRole('menuitem', { name: /New game/ }).boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(40);
  expect(box.height).toBeLessThanOrEqual(56);
  expect(box.y + box.height).toBeLessThanOrEqual(first.y);
  // On its strip of navy, centred in the card.
  const strip = await page.locator('.menu-brand').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, background: getComputedStyle(el).backgroundImage };
  });
  expect(strip.background).toContain('linear-gradient');
  expect(Math.abs(box.x - strip.left - (strip.right - (box.x + box.width)))).toBeLessThanOrEqual(1);
  expect(await logo.evaluate((img) => img.tabIndex)).toBe(-1);
  await menuButton.click();
  await expect(page.getByRole('menu')).toBeHidden();

  // From the keyboard, focus lands on New game and the arrows move through the items alone.
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? document.activeElement?.tagName);
  expect(await focused()).toBe('New game');
  await page.keyboard.press('ArrowUp');
  expect(await focused()).toBe('Rate card');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('New game');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(menuButton).toBeFocused();
  expect(errors).toEqual([]);
});

/** Every logo file the page asks for, as it asks. */
function watchLogoRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (req) => {
    if (/\/logo-\d+[^/]*\.webp$/.test(new URL(req.url()).pathname)) urls.push(req.url());
  });
  return urls;
}

test('a resumed game fetches no logo file until the menu first opens', async ({ page }) => {
  const errors = watchErrors(page);
  const logos = watchLogoRequests(page);
  // No start screen: the only logo is the menu's, hidden until the menu opens.
  await open(page, '/?seed=12345');
  await page.waitForLoadState('networkidle');
  expect(await page.locator('.start-screen').count()).toBe(0);
  expect(logos).toEqual([]);
  await page.getByRole('button', { name: 'Menu' }).click();
  await menuLogo(page);
  expect(logos).toHaveLength(1);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the menu logo shows, and the menu stays on screen', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?seed=12345');
    await page.getByRole('button', { name: 'Menu' }).tap();
    const logo = await menuLogo(page);
    const box = (await logo.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeLessThanOrEqual(56);
    const menu = (await page.locator('.menu').boundingBox())!;
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
});

test.describe('on a high-density phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

  test('the start screen fetches one logo file, the one its banner shows', async ({ page }) => {
    const errors = watchErrors(page);
    const logos = watchLogoRequests(page);
    await open(page, '/?start=1');
    const banner = page.locator('.start-logo');
    await expect.poll(() => banner.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
    await page.waitForLoadState('networkidle');
    // The hidden menu's logo (drawn smaller, so another file at this density) waits for the menu.
    expect(logos).toEqual([await banner.evaluate((img: HTMLImageElement) => img.currentSrc)]);
    expect(errors).toEqual([]);
  });
});

test('the page has a favicon, a touch icon and a manifest, all served', async ({ page }) => {
  await page.goto('/');
  const icon = page.locator('link[rel="icon"]');
  await expect(icon).toHaveAttribute('type', 'image/png');
  await expect(icon).toHaveAttribute('sizes', '32x32');
  const favicon = await fetchFrom(page, (await icon.getAttribute('href'))!);
  expect(favicon.status).toBe(200);
  expect(favicon.type).toContain('image/png');
  expect(favicon.body.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect([favicon.body.readUInt32BE(16), favicon.body.readUInt32BE(20)]).toEqual([32, 32]);

  const touch = await fetchFrom(page, (await page.locator('link[rel="apple-touch-icon"]').getAttribute('href'))!);
  expect(touch.status).toBe(200);
  expect(touch.type).toContain('image/png');
  expect([touch.body.readUInt32BE(16), touch.body.readUInt32BE(20)]).toEqual([180, 180]);

  const manifestHref = (await page.locator('link[rel="manifest"]').getAttribute('href'))!;
  const manifestUrl = new URL(manifestHref, page.url()).href;
  const manifest = await fetchFrom(page, manifestHref);
  expect(manifest.status).toBe(200);
  const json = JSON.parse(manifest.body.toString('utf8')) as { name: string; icons: { src: string; sizes: string }[] };
  expect(json.name).toBe('Light Speed Tycoon');
  for (const entry of json.icons) {
    // Manifest icon paths resolve against the manifest's own URL.
    const res = await page.request.get(new URL(entry.src, manifestUrl).href);
    expect(res.status(), entry.src).toBe(200);
    expect(res.headers()['content-type']).toContain('image/png');
  }
});

test('the page has link-preview tags, and the preview image ships with the build', async ({ page }) => {
  await page.goto('/');
  const meta = (selector: string) => page.locator(`meta[${selector}]`).getAttribute('content');
  const description = await meta('name="description"');
  expect(description).toBeTruthy();
  expect(await meta('property="og:title"')).toBe('Light Speed Tycoon');
  expect(await meta('property="og:description"')).toBe(description);
  expect(await meta('property="og:type"')).toBe('website');
  const image = (await meta('property="og:image"'))!;
  // Absolute, as link previews need: the deployed site's copy of the file served here.
  expect(image).toMatch(/^https:\/\/[^/]+\/og-image\.jpg$/);
  expect(await meta('property="og:image:width"')).toBe('1200');
  expect(await meta('property="og:image:height"')).toBe('630');
  expect(await meta('property="og:image:alt"')).toContain('Light Speed Tycoon');
  expect(await meta('name="twitter:card"')).toBe('summary_large_image');
  const local = await fetchFrom(page, new URL(image).pathname.slice(1));
  expect(local.status).toBe(200);
  expect(local.type).toContain('image/jpeg');
});
