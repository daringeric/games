import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

// Web fonts come from Google Fonts; a sandbox or CI box without internet access
// fails those requests, which is not an app error.
function isFontNoise(msg: ConsoleMessage): boolean {
  return /fonts\.(googleapis|gstatic)\.com/.test(msg.location().url);
}

async function nodeOnScreen(page: Page, node: number): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const lst = window.__lst!;
    const n = lst.getState().city.nodes[id]!;
    return lst.worldToScreen(n.x, n.y);
  }, node);
}

async function clickNode(page: Page, node: number): Promise<void> {
  const p = await nodeOnScreen(page, node);
  await page.mouse.click(p.x, p.y);
}

/** The best `length`-segment route out of the CO by homes fronting it, with every corner on open map. */
async function routeFromCo(page: Page, length: 1 | 2): Promise<{ nodes: number[]; segments: number[]; score: number } | null> {
  return page.evaluate((length) => {
    const lst = window.__lst!;
    const { city } = lst.getState();
    const onCanvas = (id: number) => {
      const n = city.nodes[id]!;
      const p = lst.worldToScreen(n.x, n.y);
      return document.elementFromPoint(p.x, p.y)?.tagName === 'CANVAS';
    };
    const fronting = (seg: number) => city.parcels.filter((p) => p.segment === seg && p.appearsDay === 0).length;
    const next = (node: number) =>
      city.segments.filter((s) => s.a === node || s.b === node).map((s) => ({ seg: s.id, to: s.a === node ? s.b : s.a }));
    let best: { nodes: number[]; segments: number[]; score: number } | null = null;
    const consider = (nodes: number[], segments: number[]) => {
      if (!nodes.every(onCanvas)) return;
      const score = segments.reduce((sum, seg) => sum + fronting(seg), 0);
      if (!best || score > best.score) best = { nodes, segments, score };
    };
    for (const first of next(city.coNode)) {
      if (length === 1) consider([city.coNode, first.to], [first.seg]);
      else {
        for (const second of next(first.to)) {
          if (second.to !== city.coNode) consider([city.coNode, first.to, second.to], [first.seg, second.seg]);
        }
      }
    }
    return best;
  }, length);
}

test('lay fiber from the CO, light homes, and see it in the HUD', async ({ page }) => {
  // Headless Chromium draws WebGL in software, so each map redraw is slow here.
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isFontNoise(msg)) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/?seed=12345');
  await page.waitForFunction(() => window.__lst !== undefined);
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByTestId('hud-date')).toHaveText('Jan 1, 2027');
  await page.getByRole('button', { name: 'Got it' }).click();

  // A two-segment route out of the CO that fronts homes, with every corner on
  // open map (not under a HUD card) so real clicks land on the canvas.
  const route = await routeFromCo(page, 2);
  expect(route, 'a cable route out of the CO').not.toBeNull();
  expect(route!.score).toBeGreaterThan(0);

  const cashBefore = await page.evaluate(() => window.__lst!.getState().finance.cash);
  await page.keyboard.press('u');
  await expect(page.getByRole('button', { name: 'Underground cable (U)' })).toHaveAttribute('aria-pressed', 'true');
  for (const node of route!.nodes) await clickNode(page, node);

  const afterCable = await page.evaluate(() => {
    const s = window.__lst!.getState();
    return { cash: s.finance.cash, spans: s.network.spans.map((span) => span.segment) };
  });
  expect(afterCable.cash).toBeLessThan(cashBefore);
  expect(afterCable.spans).toEqual(expect.arrayContaining(route!.segments));
  await expect(page.getByTestId('hud-building')).toHaveText('2');

  await page.keyboard.press('Escape');
  await page.keyboard.press('c');
  await expect(page.getByRole('button', { name: 'Cabinet (C)' })).toHaveAttribute('aria-pressed', 'true');
  await clickNode(page, route!.nodes[0]!);
  const cabinets = await page.evaluate(() => window.__lst!.getState().network.cabinets.map((c) => c.node));
  expect(cabinets).toEqual([route!.nodes[0]]);

  await page.evaluate(() => window.__lst!.tick(200));
  const reports = await page.evaluate(() => window.__lst!.getState().finance.reports.map((r) => r.passings));
  expect(reports.length).toBeGreaterThan(0);
  expect(reports.at(-1)).toBeGreaterThan(0);
  await expect(page.getByTestId('hud-passings')).not.toHaveText('0');
  const hudPassings = Number((await page.getByTestId('hud-passings').textContent())?.replace(/,/g, ''));
  expect(hudPassings).toBeGreaterThan(0);

  // An idle map draws nothing: once the newly lit cabinet's glow settles, a
  // paused game with no crews at work renders no frames while the loop runs on.
  const stats = () => page.evaluate(() => window.__lst!.stats());
  await expect
    .poll(
      async () => {
        const before = await stats();
        await page.waitForTimeout(1500);
        const after = await stats();
        expect(after.frames).toBeGreaterThan(before.frames);
        return after.renders - before.renders;
      },
      { timeout: 30_000 },
    )
    .toBe(0);

  // Ticking at 4x redraws only for what changed (a lot appearing or lighting
  // up), never every frame.
  const before = await stats();
  const dayBefore = await page.evaluate(() => window.__lst!.getState().day);
  await page.evaluate(() => window.__lst!.setSpeed(4));
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  const after = await stats();
  const days = (await page.evaluate(() => window.__lst!.getState().day)) - dayBefore;
  expect(days).toBeGreaterThan(0);
  expect(after.renders - before.renders).toBeLessThanOrEqual(days);
  expect(after.frames - before.frames).toBeGreaterThan(after.renders - before.renders);

  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a tap previews a cable quote and a second tap orders it', async ({ page }) => {
    test.setTimeout(90_000);
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error' && !isFontNoise(msg)) errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto('/?seed=12345');
    await page.waitForFunction(() => window.__lst !== undefined);
    await page.getByRole('button', { name: 'Got it' }).tap();
    const route = await routeFromCo(page, 1);
    expect(route, 'a cable route out of the CO').not.toBeNull();

    await page.getByRole('button', { name: 'Underground cable (U)' }).tap();
    const [start, end] = await Promise.all(route!.nodes.map((n) => nodeOnScreen(page, n)));
    await page.touchscreen.tap(start!.x, start!.y);
    await page.touchscreen.tap(end!.x, end!.y);

    // Nothing is bought yet; the card shows the quote and asks for a second tap.
    const card = page.locator('.float-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Cost');
    await expect(card).toContainText('Tap this corner again to order');
    expect(await page.evaluate(() => window.__lst!.getState().network.spans.length)).toBe(0);

    await page.touchscreen.tap(end!.x, end!.y);
    await expect(page.getByTestId('hud-building')).toHaveText('1');
    const spans = await page.evaluate(() => window.__lst!.getState().network.spans.map((s) => s.segment));
    expect(spans).toEqual(route!.segments);
    expect(errors).toEqual([]);
  });
});
