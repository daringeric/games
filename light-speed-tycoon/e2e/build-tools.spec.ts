// Build tools in the real app: drag-to-draw cable (mouse and touch), the
// cabinet tool's coverage card and splitters, cabinet removal, the OLT panel
// and the cost overlay switch.
//
// Owner: ui-map workstream.

import { expect, test } from '@playwright/test';
import type { CDPSession, Page } from '@playwright/test';
import { CABINET_CANCEL_REFUND, OLT_PORTS_PER_CARD } from '../src/sim/balance';
import { nodeOnScreen, open, routeFromCo, watchErrors } from './helpers';

// Headless Chromium draws WebGL in software, so each map redraw is slow here.
test.setTimeout(90_000);

interface Snapshot {
  spans: { segment: number; cost: number }[];
  construction: number[];
  cash: number;
  cabinets: { id: number; node: number; splitters: number; stage: string; cost: number }[];
  ponPorts: number;
  cards: number;
}

function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const s = window.__lst!.getState();
    return {
      spans: s.network.spans.map((span) => ({ segment: span.segment, cost: span.cost })),
      construction: s.finance.monthToDate.filter((e) => e.category === 'construction').map((e) => e.amount),
      cash: s.finance.cash,
      cabinets: s.network.cabinets.map((c) => ({ id: c.id, node: c.node, splitters: c.splitters, stage: c.stage, cost: c.cost })),
      ponPorts: s.network.olt.ponPorts,
      cards: s.network.olt.cards,
    };
  });
}

const ponPortsUsed = (snap: Snapshot) => snap.cabinets.reduce((sum, c) => sum + c.splitters, 0);

/** Drag the mouse with the left button through screen points, a few moves per leg. */
async function mouseDrag(page: Page, points: { x: number; y: number }[], finish: 'release' | 'escape' = 'release'): Promise<void> {
  const [first, ...rest] = points;
  await page.mouse.move(first!.x, first!.y);
  await page.mouse.down();
  for (const p of rest) await page.mouse.move(p.x, p.y, { steps: 8 });
  if (finish === 'escape') await page.keyboard.press('Escape');
  await page.mouse.up();
}

async function touch(cdp: CDPSession, type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number }[]): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((p, i) => ({ x: p.x, y: p.y, id: i + 1 })) });
}

test('an underground drag across two corners orders one route with one charge', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  const route = await routeFromCo(page, 2);
  expect(route, 'a two-segment route out of the CO').not.toBeNull();
  await page.keyboard.press('u');

  const before = await snapshot(page);
  const points = await Promise.all(route!.nodes.map((n) => nodeOnScreen(page, n)));
  await mouseDrag(page, points);

  await expect.poll(async () => (await snapshot(page)).spans.length).toBe(before.spans.length + 2);
  const after = await snapshot(page);
  const fresh = after.spans.slice(before.spans.length);
  expect(fresh.map((s) => s.segment).sort((a, b) => a - b)).toEqual([...route!.segments].sort((a, b) => a - b));
  // One order: exactly one new construction entry, for exactly what the new spans cost.
  const entries = after.construction.slice(before.construction.length);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toBe(-fresh.reduce((sum, s) => sum + s.cost, 0));
  expect(after.cash).toBe(before.cash + entries[0]!);
  await expect(page.locator('.toast-ok').last()).toContainText('Underground cable ordered: 2 spans');
  expect(errors).toEqual([]);
});

test('Esc mid-drag orders nothing', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  const route = await routeFromCo(page, 2);
  await page.keyboard.press('u');
  const before = await snapshot(page);
  const points = await Promise.all(route!.nodes.map((n) => nodeOnScreen(page, n)));

  // Mid-drag the card shows the live quote.
  await page.mouse.move(points[0]!.x, points[0]!.y);
  await page.mouse.down();
  await page.mouse.move(points[1]!.x, points[1]!.y, { steps: 8 });
  await page.mouse.move(points[2]!.x, points[2]!.y, { steps: 8 });
  const card = page.locator('.float-card');
  await expect(card).toContainText('Release to order');
  await expect(card).toContainText('Cost per passing');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await page.waitForTimeout(100);

  const after = await snapshot(page);
  expect(after.spans).toEqual(before.spans);
  expect(after.construction).toEqual(before.construction);
  expect(after.cash).toBe(before.cash);
  // The tool stays picked, ready for the next run.
  await expect(page.getByRole('button', { name: 'Underground cable (U)' })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('cabinet tool: coverage card, then splitters, then removal refunds it', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  const route = await routeFromCo(page, 1);
  const corner = route!.nodes[1]!;
  const p = await nodeOnScreen(page, corner);
  await page.keyboard.press('c');

  // Hovering an empty corner previews what a cabinet there would cover.
  await page.mouse.move(p.x, p.y);
  const card = page.locator('.float-card');
  await expect(card).toContainText('Passings');
  await expect(card).toContainText('Cost per passing');

  // Place it, then click it again: a second splitter, one more PON port in use.
  const before = await snapshot(page);
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await snapshot(page)).cabinets.length).toBe(before.cabinets.length + 1);
  const placed = await snapshot(page);
  const cabinet = placed.cabinets.find((c) => c.node === corner)!;
  expect(cabinet.splitters).toBe(1);
  await expect(card).toContainText('Add a splitter');
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await snapshot(page)).cabinets.find((c) => c.node === corner)?.splitters).toBe(2);
  const split = await snapshot(page);
  expect(ponPortsUsed(split)).toBe(ponPortsUsed(placed) + 1);

  // The remove tool cancels it while it is still permitting, refunded.
  const permitting = split.cabinets.find((c) => c.node === corner)!;
  expect(permitting.stage).toBe('permitting');
  const refund = Math.round(permitting.cost * CABINET_CANCEL_REFUND);
  await page.keyboard.press('x');
  await page.mouse.move(p.x + 1, p.y);
  await expect(card).toContainText('Remove cabinet');
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await snapshot(page)).cabinets.some((c) => c.node === corner)).toBe(false);
  const removed = await snapshot(page);
  expect(removed.cash).toBe(split.cash + refund);
  expect(ponPortsUsed(removed)).toBe(ponPortsUsed(split) - permitting.splitters);
  expect(errors).toEqual([]);
});

test('clicking the CO opens the OLT panel, which adds line cards', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  const co = await page.evaluate(() => window.__lst!.getState().city.coNode);
  const p = await nodeOnScreen(page, co);
  await page.keyboard.press('i');
  await page.mouse.click(p.x, p.y);

  const panel = page.getByTestId('olt-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('role', 'dialog');
  const before = await snapshot(page);
  await expect(panel.getByTestId('olt-ports')).toHaveText(`0 of ${before.ponPorts}`);
  await panel.getByRole('button', { name: /Add line card/ }).click();
  await expect.poll(async () => (await snapshot(page)).ponPorts).toBe(before.ponPorts + OLT_PORTS_PER_CARD);
  const after = await snapshot(page);
  expect(after.cards).toBe(before.cards + 1);
  // Read back from state: every card brings the same number of ports.
  expect(after.ponPorts - before.ponPorts).toBe(after.ponPorts / after.cards);
  await expect(panel.getByTestId('olt-ports')).toHaveText(`0 of ${after.ponPorts}`);

  // Esc closes it; the close button does too.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.mouse.click(p.x, p.y);
  await expect(panel).toBeVisible();
  await panel.getByRole('button', { name: 'Close OLT panel' }).click();
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

test('the OLT panel keeps focus, presses and its scrolled cabinet list while the days go by', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  // A dozen cabinets (one PON port each), so the panel's list scrolls.
  const placed = await page.evaluate(() => {
    const lst = window.__lst!;
    const { city } = lst.getState();
    let n = 0;
    for (const node of city.nodes) {
      if (n >= 12) break;
      if (node.id !== city.coNode && lst.dispatch({ type: 'placeCabinet', node: node.id }).ok) n++;
    }
    return n;
  });
  expect(placed).toBe(12);
  const co = await page.evaluate(() => window.__lst!.getState().city.coNode);
  const p = await nodeOnScreen(page, co);
  await page.keyboard.press('i');
  await page.mouse.click(p.x, p.y);
  const panel = page.getByTestId('olt-panel');
  await expect(panel).toBeVisible();
  const cards = () => page.evaluate(() => window.__lst!.getState().network.olt.cards);
  const day = () => page.evaluate(() => window.__lst!.getState().day);

  // Keyboard: focus the button, let days pass with the clock running, then press Enter.
  const button = panel.getByTestId('olt-add-card');
  await button.focus();
  const startDay = await day();
  await page.evaluate(() => window.__lst!.setSpeed(1));
  await expect.poll(day, { timeout: 15_000 }).toBeGreaterThanOrEqual(startDay + 2);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await expect(button).toBeFocused();
  const before = await cards();
  await page.keyboard.press('Enter');
  await expect.poll(cards).toBe(before + 1);
  // Still the same button, still focused after it acted.
  await expect(button).toBeFocused();

  // Mouse: a press and release that straddle a new day still click.
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.evaluate(() => window.__lst!.tick(1));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.mouse.up();
  await expect.poll(cards).toBe(before + 2);

  // The cabinet list keeps its scroll position as days go by.
  const list = panel.locator('.olt-cabinets');
  await list.evaluate((el) => (el.scrollTop = 120));
  const scrolled = await list.evaluate((el) => el.scrollTop);
  expect(scrolled).toBeGreaterThan(0);
  await page.evaluate(() => window.__lst!.tick(1));
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  expect(await list.evaluate((el) => el.scrollTop)).toBe(scrolled);
  expect(errors).toEqual([]);
});

test('the cost overlay switch flips with a click or the O key', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toggle = page.getByTestId('cost-overlay-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle).toHaveClass(/\btool\b/);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('cost-legend')).toBeVisible();
  expect(await page.evaluate(() => window.__lst!.stats())).toMatchObject({ costOverlay: 'cheapest' });
  // It prices the active cable tool's method.
  await page.keyboard.press('a');
  await expect.poll(() => page.evaluate(() => window.__lst!.stats().costOverlay)).toBe('aerial');
  await page.keyboard.press('o');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByTestId('cost-legend')).toBeHidden();
  expect(await page.evaluate(() => window.__lst!.stats())).toMatchObject({ costOverlay: null });
  expect(errors).toEqual([]);
});

/** Screen boxes of the floating card, its itemized amounts, the HUD and the toolbar. */
function layout(page: Page): Promise<{
  card: { left: number; top: number; right: number; bottom: number; scrollWidth: number; clientWidth: number; compact: boolean } | null;
  amounts: number[];
  hud: { bottom: number };
  toolbar: { top: number };
}> {
  return page.evaluate(() => {
    const card = document.querySelector<HTMLElement>('.float-card');
    const box = card && !card.hidden ? card.getBoundingClientRect() : null;
    const amounts = card ? [...card.querySelectorAll('.quote-amount')].map((e) => e.getBoundingClientRect().right) : [];
    return {
      card: box
        ? { left: box.left, top: box.top, right: box.right, bottom: box.bottom, scrollWidth: card!.scrollWidth, clientWidth: card!.clientWidth, compact: card!.classList.contains('compact') }
        : null,
      amounts,
      hud: { bottom: document.querySelector('.hud')!.getBoundingClientRect().bottom },
      toolbar: { top: document.querySelector('.toolbar')!.getBoundingClientRect().top },
    };
  });
}

/** The segment joining two corners. */
function segmentBetween(page: Page, a: number, b: number): Promise<number> {
  return page.evaluate(
    ([a, b]) => window.__lst!.getState().city.segments.find((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a))!.id,
    [a, b] as const,
  );
}

test.describe('drawing on a wide screen', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('a drag along one street orders that street, not a detour round a nearer corner on the next street', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?seed=1');
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.keyboard.press('a');
    // Water St, 420 ft from node 104 to 105: a Hawthorn Ave corner is nearer the pointer a third of the way along.
    const water = await segmentBetween(page, 104, 105);
    const [a, b] = await Promise.all([nodeOnScreen(page, 104), nodeOnScreen(page, 105)]);
    const before = await snapshot(page);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + (b.x - a.x) * 0.3, a.y + (b.y - a.y) * 0.3, { steps: 12 });
    await expect(page.locator('.float-card')).toContainText('Drag along the streets');
    await page.mouse.move(b.x, b.y, { steps: 28 });
    await expect(page.locator('.float-card')).toContainText('1 span');
    await page.mouse.up();
    await expect.poll(async () => (await snapshot(page)).spans.length).toBe(before.spans.length + 1);
    expect((await snapshot(page)).spans.slice(before.spans.length).map((s) => s.segment)).toEqual([water]);
    expect(errors).toEqual([]);
  });

  test('itemized quote amounts stay inside the card', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?seed=1');
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: 'Got it' }).click();
    await page.keyboard.press('a');
    const points = await Promise.all([143, 142, 141, 140].map((n) => nodeOnScreen(page, n)));
    await page.mouse.move(points[0]!.x, points[0]!.y);
    await page.mouse.down();
    for (const p of points.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
    await expect(page.locator('.float-card .quote-lines')).toContainText('Pole attachment application');
    const { card, amounts } = await layout(page);
    expect(amounts.length).toBeGreaterThanOrEqual(3);
    for (const right of amounts) expect(right).toBeLessThanOrEqual(card!.right);
    expect(card!.scrollWidth).toBeLessThanOrEqual(card!.clientWidth);
    await page.keyboard.press('Escape');
    await page.mouse.up();
    expect(errors).toEqual([]);
  });
});

test.describe('on a touch phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('the quote card stays off the finger drawing a run, and off the HUD and toolbar', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?seed=1');
    await page.getByRole('button', { name: 'Got it' }).tap();
    await page.getByRole('button', { name: 'Aerial cable (A)' }).tap();
    const cdp = await page.context().newCDPSession(page);
    // East from the CO along the street, one corner and then a second.
    const corners = await page.evaluate(() => {
      const { city } = window.__lst!.getState();
      const east = (id: number) => {
        const n = city.nodes[id]!;
        const seg = city.segments.find((s) => (s.a === id || s.b === id) && city.nodes[s.a === id ? s.b : s.a]!.y === n.y && city.nodes[s.a === id ? s.b : s.a]!.x > n.x)!;
        return seg.a === id ? seg.b : seg.a;
      };
      const first = east(city.coNode);
      return [city.coNode, first, east(first)];
    });
    const points = await Promise.all(corners.map((n) => nodeOnScreen(page, n)));
    await touch(cdp, 'touchStart', [points[0]!]);
    let finger = points[0]!;
    for (const [from, to] of [[points[0]!, points[1]!], [points[1]!, points[2]!]] as const) {
      for (let i = 1; i <= 10; i++) {
        finger = { x: from.x + ((to.x - from.x) * i) / 10, y: from.y + ((to.y - from.y) * i) / 10 };
        await touch(cdp, 'touchMove', [finger]);
      }
      await expect(page.locator('.float-card')).toContainText('two fingers cancel');
      const { card, hud, toolbar } = await layout(page);
      const covered = card!.left <= finger.x && finger.x <= card!.right && card!.top <= finger.y && finger.y <= card!.bottom;
      expect(covered, `card ${JSON.stringify(card)} over the finger at ${finger.x}, ${finger.y}`).toBe(false);
      expect(card!.top).toBeGreaterThanOrEqual(hud.bottom);
      expect(card!.bottom).toBeLessThanOrEqual(toolbar.top);
    }
    // A second finger cancels rather than ordering.
    await touch(cdp, 'touchStart', [finger, { x: finger.x + 40, y: finger.y }]);
    await touch(cdp, 'touchEnd', []);
    expect(errors).toEqual([]);
  });

  test('a one-finger drag from a corner orders a route; a pinch zooms and orders nothing', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?seed=12345');
    await page.getByRole('button', { name: 'Got it' }).tap();
    const route = await routeFromCo(page, 1);
    expect(route, 'a cable route out of the CO').not.toBeNull();
    await page.getByRole('button', { name: 'Underground cable (U)' }).tap();
    const cdp = await page.context().newCDPSession(page);

    const [start, end] = await Promise.all(route!.nodes.map((n) => nodeOnScreen(page, n)));
    const before = await snapshot(page);
    await touch(cdp, 'touchStart', [start!]);
    for (let i = 1; i <= 10; i++) {
      await touch(cdp, 'touchMove', [{ x: start!.x + ((end!.x - start!.x) * i) / 10, y: start!.y + ((end!.y - start!.y) * i) / 10 }]);
    }
    await touch(cdp, 'touchEnd', []);
    await expect.poll(async () => (await snapshot(page)).spans.length).toBe(before.spans.length + 1);
    const drawn = await snapshot(page);
    expect(drawn.spans.slice(before.spans.length).map((s) => s.segment)).toEqual(route!.segments);
    expect(drawn.construction.length).toBe(before.construction.length + 1);

    // Two fingers spreading apart zoom in and buy nothing, even starting on corners.
    const spread = async () => {
      const [a, b] = await Promise.all([nodeOnScreen(page, route!.nodes[0]!), nodeOnScreen(page, route!.nodes[1]!)]);
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const gapBefore = await spread();
    const cx = 195;
    const cy = 420;
    await touch(cdp, 'touchStart', [{ x: cx - 30, y: cy }, { x: cx + 30, y: cy }]);
    for (let i = 1; i <= 8; i++) {
      await touch(cdp, 'touchMove', [{ x: cx - 30 - i * 10, y: cy }, { x: cx + 30 + i * 10, y: cy }]);
    }
    await touch(cdp, 'touchEnd', []);
    await expect.poll(spread).toBeGreaterThan(gapBefore * 1.3);
    const pinched = await snapshot(page);
    expect(pinched.spans).toEqual(drawn.spans);
    expect(pinched.construction).toEqual(drawn.construction);
    expect(pinched.cabinets).toEqual(drawn.cabinets);
    expect(errors).toEqual([]);
  });
});
