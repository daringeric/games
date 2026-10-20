// The economy UI end to end: subscribers in the HUD and report, the pricing
// panel, insolvency and game over, milestones, the rate card, importing a
// schemaVersion 1 save, and the debug-hook gate.
//
// Owner: ui-economy workstream.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  CABINET_START_SPLITTERS,
  INCUMBENT_DOWN_MBPS,
  INCUMBENT_PRICE,
  INSOLVENCY_GRACE_MONTHS,
  OLT_START_PON_PORTS,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
} from '../src/sim/balance';
import { open, routeFromCo, watchErrors } from './helpers';

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
const closes = (n: number) => `${n} close${n === 1 ? '' : 's'}`;
const speedOf = (page: Page) => page.locator('.speed[aria-pressed="true"]').getAttribute('data-speed');

interface ToastRecord {
  text: string;
  tone: string;
}

/**
 * Record every toast from now on (until the next navigation). Toasts leave
 * after a few seconds, and a software-rendered frame after a big change can
 * outlast that, so tests read this log instead of racing the DOM.
 */
async function recordToasts(page: Page): Promise<() => Promise<ToastRecord[]>> {
  await page.evaluate(() => {
    const w = window as unknown as { __toastLog?: { text: string; tone: string }[] };
    if (w.__toastLog) return;
    const log: { text: string; tone: string }[] = [];
    w.__toastLog = log;
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof HTMLElement) || !node.classList.contains('toast')) continue;
          log.push({ text: node.textContent ?? '', tone: [...node.classList].find((c) => c.startsWith('toast-')) ?? '' });
        }
      }
    }).observe(document.querySelector('.toasts')!, { childList: true });
  });
  return () => page.evaluate(() => (window as unknown as { __toastLog: { text: string; tone: string }[] }).__toastLog);
}

const toast = (tone: 'ok' | 'warn' | 'err', text: string) => expect.objectContaining({ tone: `toast-${tone}`, text: expect.stringContaining(text) });

/** Tick until the next month close (or the end of the game). */
async function tickToNextClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lst = window.__lst!;
    const reports = lst.getState().finance.reports.length;
    for (let i = 0; i < 40 && lst.getState().finance.reports.length === reports && !lst.getState().gameOver; i++) lst.tick(1);
  });
}

test('lit homes sign up: subscribers and revenue in the HUD, the report and the milestones', async ({ page }) => {
  // Headless Chromium draws WebGL in software, so each map redraw is slow here.
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  await expect(page.getByTestId('hud-subs')).toHaveText('0');
  await expect(page.getByTestId('hud-pon')).toHaveText(`PON 0/${OLT_START_PON_PORTS}`);

  const route = await routeFromCo(page, 2);
  expect(route, 'a cable route out of the CO').not.toBeNull();
  const results = await page.evaluate((segments) => {
    const lst = window.__lst!;
    const co = lst.getState().city.coNode;
    return [lst.dispatch({ type: 'layCable', segments, method: 'underground' }), lst.dispatch({ type: 'placeCabinet', node: co })];
  }, route!.segments);
  expect(results.map((r) => r.ok)).toEqual([true, true]);
  // One cabinet takes one PON port per splitter at the CO.
  await expect(page.getByTestId('hud-pon')).toHaveText(`PON ${CABINET_START_SPLITTERS}/${OLT_START_PON_PORTS}`);

  await page.evaluate(() => window.__lst!.tick(200));
  const subs = await page.evaluate(() => window.__lst!.getState().sales.accounts.length);
  expect(subs).toBeGreaterThan(0);
  await expect.poll(async () => Number((await page.getByTestId('hud-subs').textContent())?.replace(/,/g, ''))).toBeGreaterThan(0);
  await expect(page.getByTestId('hud-mrr')).toHaveText(/^\$[1-9][\d,]*\/mo$/);

  // The report panel shows the last close's revenue and take rate.
  const panel = page.getByRole('region', { name: 'Monthly report' });
  const toggle = panel.locator('.panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(panel.locator('.row-revenue dt')).toHaveText('Revenue');
  await expect(panel.locator('.row-revenue dd')).toHaveText(/^\$[1-9][\d,]*$/);
  await expect(panel.locator('.stat-takeRate dd')).toHaveText(/^[1-9]\d*%$/);
  await expect(panel.locator('.stat-subscribers dd')).toHaveText(/^[1-9][\d,]*$/);
  await expect(panel.getByTestId('mtd-spend')).toHaveText(/^\$[\d,]+$/);

  // Milestones: first light is dated, the rest say how far there is to go.
  await page.getByRole('button', { name: 'Milestones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Milestones' });
  await expect(dialog).toBeVisible();
  const firstLight = dialog.locator('[data-milestone="firstLight"]');
  await expect(firstLight).toContainText('First light');
  await expect(firstLight.locator('.milestone-when')).toHaveText(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  await expect(dialog.locator('[data-milestone="subscribers1000"] .milestone-when')).toHaveText('Not yet');
  await expect(dialog.locator('[data-milestone="subscribers1000"] .milestone-progress')).toContainText('/ 1,000 subscribers');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: 'Milestones' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('the pricing panel previews and applies prices and marketing, and shows a rejection', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  const pricingButton = page.getByRole('button', { name: 'Pricing' });
  await pricingButton.click();
  const dialog = page.getByRole('dialog', { name: 'Pricing & marketing' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Incumbent cable: ${INCUMBENT_DOWN_MBPS} Mbps for ${money(INCUMBENT_PRICE)}/mo`);
  for (const tier of TIER_DEFAULTS) await expect(dialog.getByLabel(`${tier.name} price per month`)).toHaveValue(String(tier.price));

  // The preview follows the edits: a cheaper top tier raises the target take rate.
  const homes = dialog.locator('.take-rate').first().locator('dd');
  const before = await homes.textContent();
  const top = TIER_DEFAULTS[TIER_DEFAULTS.length - 1]!;
  const newPrice = TIER_PRICE_MIN + 5;
  await dialog.getByLabel(`${top.name} price per month`).fill(String(newPrice));
  await expect(homes).not.toHaveText(before!);

  // Typing in a field never reaches the map's shortcuts ("2" is the 2x speed key).
  const marketing = dialog.getByLabel('Marketing budget per month');
  await marketing.fill('');
  await marketing.pressSequentially('2500');
  expect(await speedOf(page)).toBe('0');
  await expect(dialog.locator('.field-hint')).not.toBeEmpty();

  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(toasts).toContainEqual(toast('ok', 'Pricing updated'));
  const sales = await page.evaluate((id) => {
    const s = window.__lst!.getState().sales;
    return { price: s.pricing.tiers.find((t) => t.id === id)!.price, marketing: s.marketingPerMonth };
  }, top.id);
  expect(sales).toEqual({ price: newPrice, marketing: 2500 });

  // An out-of-range price is refused with the sim's reason, and nothing changes.
  await pricingButton.click();
  await expect(dialog.getByLabel(`${top.name} price per month`)).toHaveValue(String(newPrice));
  const first = TIER_DEFAULTS[0]!;
  await dialog.getByLabel(`${first.name} price per month`).fill(String(TIER_PRICE_MAX + 1));
  await expect(dialog.getByLabel(`${first.name} price per month`)).toHaveAttribute('aria-invalid', 'true');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog.getByRole('alert')).toContainText(`${first.name} price must be a whole number`);
  await expect.poll(toasts).toContainEqual(toast('err', `${first.name} price must be a whole number`));
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.__lst!.getState().sales.pricing.tiers[0]!.price)).toBe(first.price);

  // Esc closes it and hands focus back.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(pricingButton).toBeFocused();
  expect(errors).toEqual([]);
});

test('running out of cash warns at each close, then ends the game for good', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await open(page, '/');
  let toasts = await recordToasts(page);
  // A healthy manual save to go back to.
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /Save/ }).click();
  await expect.poll(toasts).toContainEqual(toast('ok', 'Game saved'));
  const town = await page.evaluate(() => window.__lst!.getState().city.name);

  const chip = page.getByTestId('hud-insolvency');
  await expect(chip).toBeHidden();
  // Test-only: drain the bank account directly.
  await page.evaluate(() => {
    window.__lst!.getState().finance.cash = -10_000_000;
  });
  await expect(chip).toHaveText(`Overdrawn: ${closes(INSOLVENCY_GRACE_MONTHS)} left`);

  for (let strike = 1; strike < INSOLVENCY_GRACE_MONTHS; strike++) {
    await tickToNextClose(page);
    await expect.poll(async () => (await toasts()).filter((t) => t.tone === 'toast-warn' && t.text.includes('below zero')).length).toBe(strike);
    await expect(chip).toHaveText(`Overdrawn: ${closes(INSOLVENCY_GRACE_MONTHS - strike)} left`);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  await tickToNextClose(page);
  const over = page.getByRole('dialog', { name: 'Game over' });
  await expect(over).toBeVisible();
  const message = await page.evaluate(() => window.__lst!.getState().gameOver!.message);
  await expect(over).toContainText(message);
  await expect(over.getByRole('button', { name: 'Start a new town' })).toBeVisible();
  await expect(over.getByRole('button', { name: 'Export' })).toBeVisible();
  await expect(over.getByRole('button', { name: 'Load last save' })).toBeVisible();
  await expect(chip).toHaveText('Game over: out of cash');

  // The sim refuses everything and the clock stays frozen.
  const after = await page.evaluate(() => {
    const lst = window.__lst!;
    const result = lst.dispatch({ type: 'setMarketing', perMonth: 0 });
    lst.setSpeed(4);
    return { result, day: lst.getState().day };
  });
  expect(after.result.ok).toBe(false);
  expect(after.result.ok ? '' : after.result.reason).toMatch(/^Game over/);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__lst!.getState().day)).toBe(after.day);
  expect(await speedOf(page)).toBe('0');

  // The close that ended it was autosaved: a reload opens on the dialog again.
  await page.reload();
  await page.waitForFunction(() => window.__lst !== undefined);
  await expect(over).toBeVisible();
  expect(await page.evaluate(() => window.__lst!.getState().gameOver !== null)).toBe(true);

  // Loading the last save plays on.
  toasts = await recordToasts(page);
  await over.getByRole('button', { name: 'Load last save' }).click();
  await expect(over).toBeHidden();
  await expect.poll(toasts).toContainEqual(toast('ok', 'Saved game loaded'));
  expect(await page.evaluate(() => window.__lst!.getState())).toMatchObject({ day: 0, gameOver: null, city: { name: town } });
  await expect(chip).toBeHidden();
  expect(await page.evaluate(() => window.__lst!.dispatch({ type: 'setMarketing', perMonth: 0 }).ok)).toBe(true);
  expect(errors).toEqual([]);
});

test('a game over can start a new town straight away', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=4242');
  await page.evaluate(() => {
    const s = window.__lst!.getState();
    s.finance.cash = -10_000_000;
    s.finance.negativeMonths = 2;
  });
  await page.evaluate(() => window.__lst!.tick(31));
  const over = page.getByRole('dialog', { name: 'Game over' });
  await expect(over).toBeVisible();
  // No manual save in this browser: nothing to load.
  await expect(over.getByRole('button', { name: 'Load last save' })).toHaveCount(0);
  await over.getByRole('button', { name: 'Start a new town' }).click();
  await expect(over).toBeHidden();
  expect(await page.evaluate(() => window.__lst!.getState())).toMatchObject({ day: 0, gameOver: null });
  expect(new URL(page.url()).search).toBe('?debug=1');
  expect(errors).toEqual([]);
});

test('a schemaVersion 1 save imports and migrates', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  const file = path.join(test.info().project.testDir, '../src/sim/testing/v1-town.save.json');
  const v1 = JSON.parse(readFileSync(file, 'utf8')) as { schemaVersion: number; city: { name: string } };
  expect(v1.schemaVersion).toBe(1);

  await page.getByRole('button', { name: 'Menu' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Import/ }).click();
  await (await chooser).setFiles(file);
  await page.getByRole('dialog').getByRole('button', { name: 'Open imported game' }).click();
  await expect.poll(toasts).toContainEqual(toast('ok', `Imported ${v1.city.name}`));
  expect(await page.evaluate(() => window.__lst!.getState().schemaVersion)).toBe(2);
  await expect(page.locator('.hud-town')).toHaveText(v1.city.name);
  // Its reports predate subscribers: their KPIs read "–".
  const panel = page.getByRole('region', { name: 'Monthly report' });
  await expect(panel.locator('.stat-subscribers dd')).toHaveText('–');
  await expect(panel.locator('.stat-net dd')).toHaveText(/^[+-]?\$[\d,]+$/);
  expect(errors).toEqual([]);
});

test('the rate card opens from the menu and Esc closes it', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /Rate card/ }).click();
  const card = page.getByRole('dialog', { name: 'Rate card' });
  await expect(card).toBeVisible();
  for (const label of ['Underground bore', 'Make-ready', 'Engineering', 'Cabinet', 'OLT line card', 'Home install', 'Overhead', 'Pole rent']) {
    await expect(card.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(card).toBeHidden();
  await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('a production page without ?debug=1 has no debug hook', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('hud-date')).toHaveText('Jan 1, 2027');
  await expect(page.getByTestId('hud-subs')).toHaveText('0');
  expect(await page.evaluate(() => window.__lst === undefined)).toBe(true);
  // The flag turns it on.
  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(errors).toEqual([]);
});
