import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

// Web fonts come from Google Fonts; a sandbox or CI box without internet access
// fails those requests, which is not an app error.
function isFontNoise(msg: ConsoleMessage): boolean {
  return /fonts\.(googleapis|gstatic)\.com/.test(msg.location().url);
}

async function clickNode(page: Page, node: number): Promise<void> {
  const p = await page.evaluate((id) => {
    const lst = window.__lst!;
    const n = lst.getState().city.nodes[id]!;
    return lst.worldToScreen(n.x, n.y);
  }, node);
  await page.mouse.click(p.x, p.y);
}

test('lay fiber from the CO, light homes, and see it in the HUD', async ({ page }) => {
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
  const route = await page.evaluate(() => {
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
    for (const first of next(city.coNode)) {
      for (const second of next(first.to)) {
        if (second.to === city.coNode || !onCanvas(first.to) || !onCanvas(second.to)) continue;
        const score = fronting(first.seg) + fronting(second.seg);
        if (!best || score > best.score) {
          best = { nodes: [city.coNode, first.to, second.to], segments: [first.seg, second.seg], score };
        }
      }
    }
    return best;
  });
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

  expect(errors).toEqual([]);
});
