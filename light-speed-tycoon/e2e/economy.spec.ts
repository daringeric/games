// The economy UI end to end: subscribers in the HUD and report (round 4c/4d:
// the report panel as a small month summary, and the overhead's base /
// per-customer / plant lines in the full books it opens), insolvency and game
// over, milestones, the rate card (round 4c/4d: running costs that grow with
// the company), importing a schemaVersion 1 save, and the debug-hook gate. (Round 4b: the pricing panel's tests moved to
// pricing.spec.ts.)
//
// Round 4c/4d's overhead rows and rate card: ui-summary workstream.
// Owner: start-screen workstream (round 4b: game over and a new game go
// through the start screen; the HUD shows the company); sim-pricing (round
// 4) and ui-economy before.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { briefingMoney } from '../src/sim/advisor';
import { CABINET_START_SPLITTERS, INSOLVENCY_GRACE_MONTHS, OLT_START_PON_PORTS } from '../src/sim/balance';
import { defaultCompanyName } from '../src/sim/company';
import type { MonthlyReport } from '../src/sim/types';
import { formatMonthLong } from '../src/ui/format';
import { open, routeFromCo, startCompany, startScreen, watchErrors } from './helpers';

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

  // The report panel tells the last close in plain words (round 4c/4d: a small month summary).
  const panel = page.getByRole('region', { name: 'Monthly report' });
  const toggle = panel.locator('.panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  const last = (await page.evaluate(() => window.__lst!.getState().finance.reports.at(-1)!)) as MonthlyReport;
  const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
  const month = formatMonthLong(last.year, last.month);
  await expect(panel.locator('.panel-title-text')).toHaveText(month);
  await expect(panel.locator('.panel-cash')).toHaveText(`Cash went ${last.net < 0 ? 'down' : 'up'} ${money(Math.abs(last.net))} · ${money(last.cashEnd)} left`);
  // Money in (the month's bills, all of it from customers) and money out, which add up to the cash change.
  const flows = briefingMoney([last]);
  expect(flows.in - flows.out).toBe(last.net);
  expect(flows.in).toBe(last.totals.revenue);
  await expect(panel.locator('.panel-flow-in .panel-flow-total')).toHaveText(money(flows.in));
  await expect(panel.locator('.panel-flow-out .panel-flow-total')).toHaveText(money(flows.out));
  await expect(panel.locator('.panel-bar-in')).toHaveAttribute('aria-label', `Money in ${money(flows.in)}: Customer bills ${money(flows.in)}.`);
  const inLegend = panel.locator('.panel-flow-in .panel-legend li:not([hidden])');
  await expect(inLegend).toHaveCount(1);
  await expect(inLegend).toHaveText(`Customer bills ${money(flows.in)}`);
  // The customers line: the count, who joined and left, and the take rate in words.
  const stats = last.stats!;
  expect(stats.subscribers).toBeGreaterThan(0);
  await expect(panel.locator('.panel-customers-text')).toHaveText(
    new RegExp(`^${stats.subscribers} customers?( \\(\\+${stats.grossAdds} joined, ${stats.churned + stats.lostService} left\\))? · ${Math.round((stats.subscribers / last.passings) * 100)}% of homes you pass$`),
  );
  await expect(panel.getByRole('button', { name: 'See customers' })).toBeVisible();
  await expect(panel.locator('.mtd')).toHaveText(/^This month so far: \$[\d,]+ spent$/);
  await expect(panel.getByTestId('mtd-spend')).toHaveText(/^\$[\d,]+$/);
  // No debt: no bank word. No jargon anywhere in the panel.
  await expect(panel.getByTestId('panel-bank')).toBeHidden();
  expect(await panel.innerText()).not.toMatch(/ARPU|CPGA|leverage|coverage|covenant|DSCR|\bARR\b|\bOCF\b|\bbps\b|×/i);
  // Round 4c/4d: the overhead, and its lines that add up to it, in the full books the panel opens.
  const overhead = { total: -(last.totals.overhead ?? 0), lines: last.ops?.overhead ?? null };
  expect(overhead.lines).not.toBeNull();
  const booksButton = panel.getByRole('button', { name: 'See the full books' });
  await booksButton.click();
  const books = page.getByRole('dialog', { name: `The full books for ${month}` });
  await expect(books).toBeVisible();
  const running = books.locator('.briefing-books-group.group-running');
  await expect(running.locator('.briefing-books-group-head .num')).toHaveText(money(flows.groups.find((g) => g.key === 'running')!.total));
  await expect(running.locator('.briefing-line[data-key="overheadBase"] dd')).toHaveText(money(overhead.lines!.base));
  await expect(running.locator('.briefing-line[data-key="overheadCustomers"] dd')).toHaveText(money(overhead.lines!.perCustomer));
  await expect(running.locator('.briefing-line[data-key="overheadPlant"] dd')).toHaveText(money(overhead.lines!.perPlant));
  expect(overhead.lines!.base + overhead.lines!.perCustomer + overhead.lines!.perPlant).toBe(overhead.total);
  // The old list's overhead total itself, on screen under "More figures".
  const overheadRow = books.locator('.briefing-figure[data-key="overhead"]');
  await expect(overheadRow.locator('dt')).toContainText('Overhead');
  await expect(overheadRow.locator('dd')).toHaveText(money(overhead.total));
  // The old list's revenue, customers and take rate: the books' bills line and tiles.
  await expect(books.locator('.briefing-lines-in .briefing-line[data-key="bills"] dd')).toHaveText(money(last.totals.revenue!));
  await expect(books.locator('.briefing-tile-subscribers .briefing-tile-value')).toHaveText(String(stats.subscribers));
  await expect(books.locator('.briefing-tile-takeRate .briefing-tile-value')).toHaveText(/^[1-9]\d*%$/);
  await expect(books.locator('.briefing-figure[data-key="arpu"] dd')).toHaveText(/^\$[\d,]+\/mo$/);
  await books.locator('.briefing-close').click();
  await expect(books).toBeHidden();
  await expect(booksButton).toBeFocused();

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
  // Round 4b: it says which company ended, and a new town starts from the start screen.
  const ended = await page.evaluate(() => window.__lst!.getState().company.name);
  await expect(over).toContainText(`${ended} has gone bankrupt.`);
  await over.getByRole('button', { name: 'Start a new town' }).click();
  await startCompany(page);
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

  const current = await page.evaluate(() => window.__lst!.getState().company.name);
  await page.getByRole('button', { name: 'Menu' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: /Import/ }).click();
  await (await chooser).setFiles(file);
  // Round 4b: the confirm names the company it replaces, and the incoming company and town.
  const confirm = page.getByRole('dialog', { name: `Replace ${current}?` });
  const incoming = defaultCompanyName(v1.city.name);
  await expect(confirm).toContainText(`${incoming} in ${v1.city.name}`);
  await confirm.getByRole('button', { name: 'Open imported game' }).click();
  await expect.poll(toasts).toContainEqual(toast('ok', `Imported ${incoming} (${v1.city.name})`));
  expect(await page.evaluate(() => window.__lst!.getState().schemaVersion)).toBe(4);
  // A save from before company names: the default name, at Seed round.
  expect(await page.evaluate(() => window.__lst!.getState().company)).toEqual({ name: incoming, difficulty: 'seed' });
  await expect(page.locator('.hud-town')).toHaveText(v1.city.name);
  await expect(page.getByTestId('hud-company')).toHaveText(incoming);
  // Its reports predate subscribers: the panel has no customers line, but says how the cash moved;
  // the full books read "–" for the customers.
  const panel = page.getByRole('region', { name: 'Monthly report' });
  await expect(panel.locator('.panel-customers')).toBeHidden();
  await expect(panel.locator('.panel-cash')).toHaveText(/^(Cash went (down|up) \$[\d,]+|Cash stayed the same) · \$[\d,]+ (left|overdrawn)$/);
  const toggle = panel.locator('.panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await panel.getByRole('button', { name: 'See the full books' }).click();
  const books = page.locator('dialog.briefing-books-only');
  await expect(books.locator('.briefing-tile-subscribers .briefing-tile-value')).toHaveText('–');
  await expect(books.locator('.briefing-tile-net .briefing-tile-value')).toHaveText(/^[+-]?\$[\d,]+$/);
  await books.locator('.briefing-close').click();
  await expect(books).toBeHidden();
  expect(errors).toEqual([]);
});

test('the rate card opens from the menu and Esc closes it', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /Rate card/ }).click();
  const card = page.getByRole('dialog', { name: 'Rate card' });
  await expect(card).toBeVisible();
  for (const label of ['Underground bore', 'Make-ready', 'Engineering', 'Cabinet', 'OLT line card', 'Home install', 'Base overhead', 'Pole rent']) {
    await expect(card.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // Round 4c/4d: running costs grow with the company: per customer (each support level), per cabinet, per mile of cable.
  const running = card.locator('.rate-section').filter({ has: page.getByRole('heading', { name: 'Running costs' }) });
  await expect(running.locator('.rate-row dt > span:not(.band-swatch)')).toHaveText([
    'Base overhead',
    'Per customer',
    'Basic support',
    'Good support',
    'Great support',
    'Per cabinet',
    'Per mile of cable',
    'Pole rent',
  ]);
  for (const value of await running.locator('.rate-row dd').allTextContents()) expect(value).toMatch(/^\$[\d,]+(\.\d\d)?\/mo$/);
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
  // Round 4b: a first launch (no saved company) opens on the start screen.
  await expect(startScreen(page)).toBeVisible();
  await startCompany(page, { name: 'Otter Light & Wire' });
  await expect(page.getByTestId('hud-company')).toHaveText('Otter Light & Wire');
  // The flag turns it on.
  await page.goto('/?debug=1');
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(errors).toEqual([]);
});
