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

  // Nothing is lit on the map yet.
  expect(await page.evaluate(() => window.__lst!.stats())).toMatchObject({ passedLots: 0, liveSpans: 0 });
  await page.evaluate(() => window.__lst!.tick(200));
  const reports = await page.evaluate(() => window.__lst!.getState().finance.reports.map((r) => r.passings));
  expect(reports.length).toBeGreaterThan(0);
  expect(reports.at(-1)).toBeGreaterThan(0);
  await expect(page.getByTestId('hud-passings')).not.toHaveText('0');
  const hudPassings = Number((await page.getByTestId('hud-passings').textContent())?.replace(/,/g, ''));
  expect(hudPassings).toBeGreaterThan(0);

  // The map shows it too: both spans drawn as live cable, and every lot on them drawn as passed.
  const lotsOnRoute = await page.evaluate((segments) => {
    const s = window.__lst!.getState();
    return s.city.parcels.filter((p) => segments.includes(p.segment) && p.appearsDay <= s.day).length;
  }, route!.segments);
  expect(lotsOnRoute).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.__lst!.stats().liveSpans)).toBe(2);
  expect((await page.evaluate(() => window.__lst!.stats())).passedLots).toBe(lotsOnRoute);

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

// --- Regression tests -------------------------------------------------------

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isFontNoise(msg)) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

async function open(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.waitForFunction(() => window.__lst !== undefined);
}

async function currentGame(page: Page): Promise<{ seed: number; day: number; name: string; cash: number; cabinets: number[] }> {
  return page.evaluate(() => {
    const s = window.__lst!.getState();
    return { seed: s.seed, day: s.day, name: s.city.name, cash: s.finance.cash, cabinets: s.network.cabinets.map((c) => c.node) };
  });
}

const speedOf = (page: Page) => page.locator('.speed[aria-pressed="true"]').getAttribute('data-speed');

// Phones, tablets and narrow windows: every control must be on screen and on top.
const LAYOUTS = [
  { name: 'iPad portrait', width: 768, height: 1024, touch: true },
  { name: 'iPad Air portrait', width: 820, height: 1180, touch: true },
  { name: 'small landscape phone', width: 740, height: 360, touch: true },
  { name: 'iPhone landscape', width: 844, height: 390, touch: true },
  { name: 'large landscape phone', width: 932, height: 430, touch: true },
  { name: 'narrow window', width: 721, height: 800, touch: false },
  { name: 'desktop', width: 1280, height: 720, touch: false },
];

for (const layout of LAYOUTS) {
  test.describe(`${layout.name} (${layout.width}x${layout.height})`, () => {
    test.use({ viewport: { width: layout.width, height: layout.height }, hasTouch: layout.touch });

    test('every HUD and tool button is on screen and not covered', async ({ page }) => {
      await open(page, '/?seed=12345');
      // Let the web fonts settle the HUD's width.
      await page.evaluate(() => document.fonts.ready);
      const problems = await page.evaluate(() => {
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>('.speed, .menu-button, .tool, .hint-close')) {
          const r = el.getBoundingClientRect();
          const label = el.getAttribute('aria-label') ?? el.textContent ?? el.className;
          if (r.left < 0 || r.top < 0 || r.right > window.innerWidth || r.bottom > window.innerHeight) {
            out.push(`${label} is off screen at [${Math.round(r.left)}, ${Math.round(r.top)}, ${Math.round(r.right)}, ${Math.round(r.bottom)}]`);
            continue;
          }
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (!hit || !el.contains(hit)) out.push(`${label} is covered by ${hit ? `${hit.tagName}.${hit.className}` : 'nothing'}`);
        }
        return out;
      });
      expect(problems).toEqual([]);
      // The menu opens fully on screen too.
      await page.getByRole('button', { name: 'Menu' }).click();
      const menu = await page.getByRole('menu').boundingBox();
      expect(menu).not.toBeNull();
      expect(menu!.x).toBeGreaterThanOrEqual(0);
      expect(menu!.x + menu!.width).toBeLessThanOrEqual(layout.width);
    });
  });
}

test('a ?seed link keeps its own progress and never replaces the main game', async ({ page }) => {
  test.setTimeout(90_000);
  // The main game, played to a month close (which autosaves it).
  await open(page, '/');
  await page.evaluate(() => window.__lst!.tick(31));
  const main = await currentGame(page);
  expect(main.day).toBe(31);

  // A seed link opens that town fresh, and a reload resumes it.
  await open(page, '/?seed=777');
  expect(await currentGame(page)).toMatchObject({ seed: 777, day: 0 });
  await page.evaluate(() => window.__lst!.tick(31));
  await page.reload();
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(await currentGame(page)).toMatchObject({ seed: 777, day: 31 });

  // The main game is untouched, and the link still resumes its own town.
  await open(page, '/');
  expect(await currentGame(page)).toEqual(main);
  await open(page, '/?seed=777');
  expect(await currentGame(page)).toMatchObject({ seed: 777, day: 31 });

  // Starting a new game from a seed link makes it the main game.
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /New game/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Start a new town' }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  const fresh = await currentGame(page);
  expect(new URL(page.url()).search).toBe('');
  await page.reload();
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(await currentGame(page)).toEqual(fresh);
});

test('importing a save with impossible map geometry keeps the current game', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const before = await currentGame(page);
  const broken = await page.evaluate(() => {
    const variant = (edit: (s: { city: { width: number; height: number } }) => void) => {
      const s = JSON.parse(JSON.stringify(window.__lst!.getState()));
      edit(s);
      return JSON.stringify(s);
    };
    return [
      variant((s) => ((s.city.width = 100_000), (s.city.height = 100_000))),
      variant((s) => ((s.city.width = 3), (s.city.height = 3))),
    ];
  });
  for (const [i, text] of broken.entries()) {
    await page.getByRole('button', { name: 'Menu' }).click();
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('menuitem', { name: /Import/ }).click();
    await (await chooser).setFiles({ name: `broken-${i}.json`, mimeType: 'application/json', buffer: Buffer.from(text) });
    await expect(page.locator('.toast-err').last()).toContainText('Could not import: Corrupt save: city.');
    expect(await currentGame(page)).toEqual(before);
  }
  expect(errors).toEqual([]);
});

test('says why the game could not start, above the map, with a way past a bad autosave', async ({ page }) => {
  test.setTimeout(60_000);
  // Make boot fail after the map and HUD are on the page, whenever the test asks.
  await page.addInitScript(() => {
    const add = Document.prototype.addEventListener;
    Document.prototype.addEventListener = function (this: Document, ...args: Parameters<Document['addEventListener']>) {
      if (args[0] === 'visibilitychange' && localStorage.getItem('test:break-boot') === '1') throw new Error('Simulated boot failure');
      add.apply(this, args);
    } as Document['addEventListener'];
  });
  await open(page, '/');
  // A month close autosaves the game; the next boot resumes it and fails.
  await page.evaluate(() => {
    window.__lst!.tick(31);
    localStorage.setItem('test:break-boot', '1');
  });
  await page.reload();
  const message = page.locator('.boot-error');
  await expect(message).toContainText('could not start: Simulated boot failure');
  const onTop = await message.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
  });
  expect(onTop).toBe(true);
  await expect(page.locator('.float-card')).toBeHidden();

  // The way out discards the autosave and starts over.
  await page.getByRole('button', { name: /start a new town/i }).click();
  await expect(message).toContainText('could not start: Simulated boot failure');
  expect(await page.evaluate(() => localStorage.getItem('lst:autosave'))).toBeNull();
  // With no autosave to blame, there is nothing to discard.
  await expect(page.getByRole('button', { name: /start a new town/i })).toHaveCount(0);
});

test('a click on the map that closes the menu does nothing else', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.keyboard.press('c');
  await page.getByRole('button', { name: 'Menu' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  // A corner on open map with the menu open.
  const route = await routeFromCo(page, 1);
  expect(route).not.toBeNull();
  const target = route!.nodes[1]!;
  const before = await currentGame(page);

  await clickNode(page, target);
  await expect(page.getByRole('menu')).toBeHidden();
  expect(await currentGame(page)).toEqual(before);

  // With the menu closed, the same click places a cabinet.
  await clickNode(page, target);
  expect((await currentGame(page)).cabinets).toEqual([target]);
  expect(errors).toEqual([]);
});

test('holding Space to pan never toggles pause or fires the tool', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  await page.keyboard.press('c');
  const route = await routeFromCo(page, 1);
  const p = await nodeOnScreen(page, route!.nodes[1]!);
  await page.mouse.move(p.x, p.y);
  await page.evaluate(() => window.__lst!.setSpeed(0));

  // Space held over a click that doesn't drag, released after the mouse...
  await page.keyboard.down(' ');
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up(' ');
  // ...or before it.
  await page.keyboard.down(' ');
  await page.mouse.down();
  await page.keyboard.up(' ');
  await page.mouse.up();
  await page.waitForTimeout(100);
  expect(await speedOf(page)).toBe('0');
  expect((await currentGame(page)).cabinets).toEqual([]);

  // A plain tap still toggles pause.
  await page.keyboard.press(' ');
  await expect(page.locator('.speed[aria-pressed="true"]')).toHaveAttribute('data-speed', '1');
  expect(errors).toEqual([]);
});

test('keyboard users can press buttons with Space and move through the menu', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.evaluate(() => window.__lst!.setSpeed(0));

  // Space presses a keyboard-focused button instead of toggling pause.
  const gotIt = page.getByRole('button', { name: 'Got it' });
  await gotIt.focus();
  await page.keyboard.press(' ');
  await expect(page.locator('.hint-card')).toBeHidden();
  expect(await speedOf(page)).toBe('0');

  // Space opens the menu from its button, the arrow keys move through it, and Esc returns focus to the button.
  const menuButton = page.getByRole('button', { name: 'Menu' });
  await menuButton.focus();
  await page.keyboard.press(' ');
  await expect(page.getByRole('menu')).toBeVisible();
  const focused = () => page.evaluate(() => document.activeElement?.querySelector('.menu-label')?.textContent ?? document.activeElement?.getAttribute('aria-label'));
  expect(await focused()).toBe('New game');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('Save');
  await page.keyboard.press('End');
  expect(await focused()).toBe('Import');
  await page.keyboard.press('ArrowDown');
  expect(await focused()).toBe('New game');
  await page.keyboard.press('ArrowUp');
  expect(await focused()).toBe('Import');
  await page.keyboard.press('Home');
  expect(await focused()).toBe('New game');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  expect(await focused()).toBe('Menu');

  // Space on a menu item runs it.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press(' ');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(page.locator('.toast-ok').last()).toContainText('Game saved');
  expect(await speedOf(page)).toBe('0');

  // After a mouse click on a button, Space still pauses rather than clicking it again.
  await page.getByRole('button', { name: '2x speed (2)' }).click();
  await expect(page.locator('.speed[aria-pressed="true"]')).toHaveAttribute('data-speed', '2');
  await page.keyboard.press(' ');
  await expect(page.locator('.speed[aria-pressed="true"]')).toHaveAttribute('data-speed', '0');
  expect(errors).toEqual([]);
});

test('replacing the town asks first, and a stray double Space can never wipe it', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.evaluate(() => window.__lst!.tick(10));
  const before = await currentGame(page);
  const menuButton = page.getByRole('button', { name: 'Menu' });
  const dialog = page.getByRole('dialog');

  // Keyboard: Space opens the menu with "New game" focused, Space again asks; focus sits on the safe choice.
  await menuButton.focus();
  await page.keyboard.press(' ');
  await page.keyboard.press(' ');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Keep playing' })).toBeFocused();
  await page.keyboard.press(' ');
  await expect(dialog).toBeHidden();
  expect(await currentGame(page)).toEqual(before);

  // Esc and a click on the backdrop cancel too, and the map ignores keys while it's open.
  await menuButton.click();
  await page.getByRole('menuitem', { name: /New game/ }).click();
  await expect(dialog).toBeVisible();
  await page.keyboard.press('c');
  await expect(page.locator('.tool[aria-pressed="true"]')).not.toHaveAttribute('data-tool', 'cabinet');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await menuButton.click();
  await page.getByRole('menuitem', { name: /New game/ }).click();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  expect(await currentGame(page)).toEqual(before);

  // Confirming replaces the town.
  await menuButton.click();
  await page.getByRole('menuitem', { name: /New game/ }).click();
  await dialog.getByRole('button', { name: 'Start a new town' }).click();
  await expect(dialog).toBeHidden();
  expect(await currentGame(page)).toMatchObject({ day: 0 });
  expect((await currentGame(page)).seed).not.toBe(before.seed);
  expect(errors).toEqual([]);
});
