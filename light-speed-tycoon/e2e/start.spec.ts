// The start screen (round 4b): a first launch, a fresh ?seed link, the menu's
// New game and the game-over dialog's "Start a new town" all pass through it;
// Start makes the company chosen there, Esc or Back returns to where it was
// opened from. Debug pages skip the first-launch screen unless ?start=1.
// Round 4c/4d (spec E): on a phone a long company name takes a second line in
// the HUD, and a tap on it shows the whole name.
//
// Owner: start-screen workstream; ui-bank (round 4c/4d).

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { DIFFICULTY_LEVELS } from '../src/sim/balance';
import { COMPANY_NAME_MAX, defaultCompanyName } from '../src/sim/company';
import { formatMoney } from '../src/ui/format';
import { currentGame, open, openWithStart, startCompany, startScreen, watchErrors, withDebug, withStart } from './helpers';

const levelCash = (id: string) => DIFFICULTY_LEVELS.find((l) => l.id === id)!.startCash;
const speedOf = (page: Page) => page.locator('.speed[aria-pressed="true"]').getAttribute('data-speed');
const company = (page: Page) => page.evaluate(() => window.__lst!.getState().company);
const screenOpen = (page: Page) => page.evaluate(() => window.__lst!.startScreenOpen());

/** The start screen's logo banner image: shown, and its file loaded. */
async function bannerLogo(page: Page): Promise<Locator> {
  const logo = startScreen(page).getByRole('img', { name: 'Light Speed Tycoon' });
  await expect(logo).toBeVisible();
  await expect(logo).toHaveAttribute('decoding', 'async');
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
  return logo;
}

/** Where the banner sits: its image and strip, the card, and the heading below it. */
async function bannerLayout(page: Page) {
  return page.evaluate(() => {
    const box = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const dialog = document.querySelector('.start-screen')!;
    const img = dialog.querySelector('img')!;
    const body = dialog.querySelector<HTMLElement>('.start-body')!;
    return {
      dialog: box(dialog),
      card: { left: dialog.clientLeft, width: dialog.clientWidth },
      strip: box(dialog.querySelector('.start-banner')!),
      img: box(img),
      title: box(dialog.querySelector('.start-title')!),
      body: box(body),
      town: box(dialog.querySelector('.start-town')!),
      bodyOverflow: body.scrollHeight - body.clientHeight,
      sideways: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

/** Set the name field the way a paste past its maxlength would (typing stops at COMPANY_NAME_MAX). */
async function forceName(page: Page, value: string): Promise<void> {
  await startScreen(page)
    .getByLabel('Company name')
    .evaluate((input: HTMLInputElement, v) => {
      input.value = v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
}

test('a first launch opens on the start screen and starts the company chosen there', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchErrors(page);
  await openWithStart(page, '/');
  const screen = startScreen(page);
  await expect(screen).toBeVisible();
  expect(await screenOpen(page)).toBe(true);
  // The game's logo heads the screen (it replaced the small "Light Speed Tycoon" eyebrow line).
  await bannerLogo(page);
  const name = screen.getByLabel('Company name');
  await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('maxlength', String(COMPANY_NAME_MAX));

  // The map behind shows the town on offer, and the name starts as its default.
  const preview = await page.evaluate(() => window.__lst!.getState());
  await expect(screen.locator('.start-town-name')).toHaveText(`Your town: ${preview.city.name}`);
  await expect(name).toHaveValue(defaultCompanyName(preview.city.name));
  // The HUD behind belongs to that preview, not to the company being chosen: no name or cash in it to contradict the cards.
  await expect(page.getByTestId('hud-company')).toBeHidden();
  await expect(page.getByTestId('hud-cash')).toBeHidden();

  // Nothing to go back to: no Back button, and Esc (even twice) does nothing.
  await expect(screen.getByRole('button', { name: 'Back' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(screen).toBeVisible();
  expect(await screenOpen(page)).toBe(true);

  // Suggest steps to another name.
  const suggest = screen.getByRole('button', { name: 'Suggest a name' });
  const first = await name.inputValue();
  await suggest.click();
  await expect(name).not.toHaveValue(first);
  const second = await name.inputValue();
  await suggest.click();
  await expect(name).not.toHaveValue(second);

  // An empty or too-long name disables Start and says why.
  const start = screen.getByRole('button', { name: 'Start', exact: true });
  const message = screen.locator('.start-name-msg');
  await name.fill('   ');
  await expect(start).toBeDisabled();
  await expect(message).toHaveText('Give your company a name.');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await forceName(page, 'x'.repeat(COMPANY_NAME_MAX + 1));
  await expect(start).toBeDisabled();
  await expect(message).toContainText(`${COMPANY_NAME_MAX} characters or fewer`);
  // Typing stops at the limit.
  await name.fill('');
  await name.pressSequentially('y'.repeat(COMPANY_NAME_MAX + 3));
  expect((await name.inputValue()).length).toBe(COMPANY_NAME_MAX);
  await expect(start).toBeEnabled();
  // Markup is just text.
  await name.fill('<b>Heron</b> Broadband');
  await expect(start).toBeEnabled();
  await name.fill('Heron Broadband Co-op');
  await expect(start).toBeEnabled();
  await expect(name).toHaveAttribute('aria-invalid', 'false');

  // Seed round is preselected; the arrow keys move the selection.
  const card = (label: string) => screen.getByRole('radio', { name: new RegExp(label) });
  await expect(screen.getByRole('radiogroup')).toBeVisible();
  await expect(screen.getByRole('radio')).toHaveCount(DIFFICULTY_LEVELS.length);
  await expect(card('Seed round')).toHaveAttribute('aria-checked', 'true');
  for (const level of DIFFICULTY_LEVELS) await expect(card(level.name)).toContainText(level.feel);
  await card('Seed round').focus();
  await page.keyboard.press('ArrowRight');
  await expect(card('Bootstrapped')).toHaveAttribute('aria-checked', 'true');
  await expect(card('Bootstrapped')).toBeFocused();
  await expect(card('Seed round')).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('ArrowLeft');
  await expect(card('Seed round')).toHaveAttribute('aria-checked', 'true');
  await card('Bootstrapped').click();
  await expect(card('Bootstrapped')).toHaveAttribute('aria-checked', 'true');

  // New town: another seed, shown behind the screen and named on it; a typed name stays.
  await screen.getByRole('button', { name: 'New town' }).click();
  await expect.poll(() => page.evaluate(() => window.__lst!.getState().seed)).not.toBe(preview.seed);
  const town = await page.evaluate(() => ({ seed: window.__lst!.getState().seed, name: window.__lst!.getState().city.name }));
  await expect(screen.locator('.start-town-name')).toHaveText(`Your town: ${town.name}`);
  await expect(name).toHaveValue('Heron Broadband Co-op');

  await start.click();
  await expect(screen).toBeHidden();
  expect(await screenOpen(page)).toBe(false);
  const state = await page.evaluate(() => {
    const s = window.__lst!.getState();
    return { seed: s.seed, day: s.day, town: s.city.name, cash: s.finance.cash, company: s.company };
  });
  // The town seen is the town played, at the level picked.
  expect(state).toEqual({ seed: town.seed, day: 0, town: town.name, cash: levelCash('bootstrapped'), company: { name: 'Heron Broadband Co-op', difficulty: 'bootstrapped' } });
  await expect(page.getByTestId('hud-company')).toHaveText('Heron Broadband Co-op');
  await expect(page.getByTestId('hud-company')).toBeVisible();
  await expect(page.getByTestId('hud-cash')).toBeVisible();
  await expect(page.getByTestId('hud-cash')).toHaveText(formatMoney(levelCash('bootstrapped')));
  await expect(page.getByTestId('hud-town')).toHaveText(town.name);
  await expect(page.locator('.hint-card')).toBeVisible();

  // It was autosaved: a reload resumes it, with no start screen.
  await page.reload();
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(await screenOpen(page)).toBe(false);
  await expect(startScreen(page)).toHaveCount(0);
  expect(await company(page)).toEqual({ name: 'Heron Broadband Co-op', difficulty: 'bootstrapped' });
  expect((await currentGame(page)).seed).toBe(town.seed);
  expect(errors).toEqual([]);
});

test('New game asks to replace the company, then the start screen; Esc and Back return to the same game', async ({ page }) => {
  test.setTimeout(60_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  // Debug pages skip the first-launch screen: a Seed-round game with the default name.
  expect(await screenOpen(page)).toBe(false);
  const ours = await company(page);
  const before = await currentGame(page);
  expect(ours).toEqual({ name: defaultCompanyName(before.name), difficulty: 'seed' });
  await expect(page.getByTestId('hud-company')).toHaveText(ours.name);
  await page.evaluate(() => window.__lst!.tick(10));

  const menuButton = page.getByRole('button', { name: 'Menu' });
  const screen = startScreen(page);
  const openNewGame = async () => {
    await menuButton.click();
    await page.getByRole('menuitem', { name: /New game/ }).click();
    const confirm = page.getByRole('dialog', { name: `Replace ${ours.name}?` });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(ours.name);
    await confirm.getByRole('button', { name: 'Start a new town' }).click();
    await expect(screen).toBeVisible();
    await expect(screen.getByLabel('Company name')).toBeFocused();
  };

  // The clock stops while the screen is up, and Esc brings back the same game at the speed it had.
  await page.getByRole('button', { name: '2x speed (2)' }).click();
  await openNewGame();
  const day = await page.evaluate(() => window.__lst!.getState().day);
  await page.waitForTimeout(1200);
  expect(await page.evaluate(() => window.__lst!.getState().day)).toBe(day);
  await page.keyboard.press('Escape');
  await expect(screen).toBeHidden();
  expect(await speedOf(page)).toBe('2');
  await page.evaluate(() => window.__lst!.setSpeed(0));
  const kept = await currentGame(page);
  expect(kept.seed).toBe(before.seed);
  expect(kept.day).toBeGreaterThanOrEqual(day);
  expect(await company(page)).toEqual(ours);

  // Back does the same, leaving the day where it was.
  await openNewGame();
  await expect(screen.getByRole('button', { name: 'New town' })).toBeVisible();
  await screen.getByRole('button', { name: 'Back' }).click();
  await expect(screen).toBeHidden();
  expect(await currentGame(page)).toEqual(kept);
  expect(await speedOf(page)).toBe('0');

  // Start replaces the game: the main one now (?seed dropped, debug=1 kept).
  await openNewGame();
  await startCompany(page, { name: 'Bramble Light & Wire', difficulty: 'shoestring' });
  const fresh = await page.evaluate(() => {
    const s = window.__lst!.getState();
    return { seed: s.seed, day: s.day, cash: s.finance.cash, company: s.company };
  });
  expect(fresh.seed).not.toBe(before.seed);
  expect(fresh).toMatchObject({ day: 0, cash: levelCash('shoestring'), company: { name: 'Bramble Light & Wire', difficulty: 'shoestring' } });
  expect(new URL(page.url()).search).toBe('?debug=1');
  await expect(page.getByTestId('hud-company')).toHaveText('Bramble Light & Wire');
  await expect(page.locator('.toast-ok').last()).toContainText('Bramble Light & Wire is open for business');
  await page.reload();
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(await company(page)).toEqual(fresh.company);
  // The last pick is remembered for the next new game.
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await menuButton.click();
  await page.getByRole('menuitem', { name: /New game/ }).click();
  await page.getByRole('dialog', { name: 'Replace Bramble Light & Wire?' }).getByRole('button', { name: 'Start a new town' }).click();
  await expect(screen.getByRole('radio', { name: /Shoestring/ })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(screen).toBeHidden();
  expect(errors).toEqual([]);
});

test('a game over offers the start screen, and Esc goes back to the game-over dialog', async ({ page }) => {
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
  const ended = await currentGame(page);
  const screen = startScreen(page);

  await over.getByRole('button', { name: 'Start a new town' }).click();
  await expect(screen).toBeVisible();
  await expect(over).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(screen).toBeHidden();
  await expect(over).toBeVisible();
  expect(await currentGame(page)).toEqual(ended);

  await over.getByRole('button', { name: 'Start a new town' }).click();
  await startCompany(page, { name: 'Juniper Glassworks', difficulty: 'angel' });
  await expect(over).toBeHidden();
  expect(await page.evaluate(() => window.__lst!.getState())).toMatchObject({
    day: 0,
    gameOver: null,
    company: { name: 'Juniper Glassworks', difficulty: 'angel' },
    finance: { cash: levelCash('angel') },
  });
  expect((await currentGame(page)).seed).not.toBe(ended.seed);
  expect(new URL(page.url()).search).toBe('?debug=1');
  expect(errors).toEqual([]);
});

test('a fresh ?seed link offers that town alone, and never touches the main autosave', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithStart(page, '/?seed=777');
  const screen = startScreen(page);
  await expect(screen).toBeVisible();
  // The town is fixed by the link: no reroll.
  await expect(screen.getByRole('button', { name: 'New town' })).toHaveCount(0);
  const town = await page.evaluate(() => window.__lst!.getState().city.name);
  await expect(screen.locator('.start-town-name')).toHaveText(`Your town: ${town}`);
  await startCompany(page, { name: 'Wren Line & Lantern' });
  expect(await currentGame(page)).toMatchObject({ seed: 777, day: 0, name: town });
  expect(await company(page)).toEqual({ name: 'Wren Line & Lantern', difficulty: 'seed' });
  expect(new URL(page.url()).searchParams.get('seed')).toBe('777');
  expect(await page.evaluate(() => localStorage.getItem('lst:autosave'))).toBeNull();
  await page.reload();
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(await screenOpen(page)).toBe(false);
  expect(await company(page)).toEqual({ name: 'Wren Line & Lantern', difficulty: 'seed' });
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('a long company name takes a second line in the HUD, and a tap shows it whole', async ({ page }) => {
    const errors = watchErrors(page);
    await openWithStart(page, '/');
    const name = 'Wolverine Prairie Fiber and Wire';
    expect(name.length).toBeLessThanOrEqual(COMPANY_NAME_MAX);
    await startCompany(page, { name });
    await page.evaluate(() => document.fonts.ready);
    const label = page.getByTestId('hud-company');
    await expect(label).toHaveText(name);
    await expect(label).toHaveAccessibleName(name);
    // More than one line before it is cut short, and never wider than its column.
    const shape = await label.evaluate((el) => {
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
      return { lines: el.getBoundingClientRect().height / lineHeight, scrollW: el.scrollWidth, clientW: el.clientWidth };
    });
    expect(shape.lines).toBeGreaterThan(1.5);
    expect(shape.scrollW).toBeLessThanOrEqual(shape.clientW);

    // A tap shows the whole name on screen; a tap elsewhere hides it.
    const full = page.getByTestId('hud-company-full');
    await expect(full).toBeHidden();
    await label.tap();
    await expect(full).toBeVisible();
    await expect(label).toHaveAttribute('aria-expanded', 'true');
    await expect(full.locator('.hud-company-full-name')).toHaveText(name);
    await expect(full).toBeInViewport({ ratio: 1 });
    const box = (await full.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await page.touchscreen.tap(195, 600);
    await expect(full).toBeHidden();
    await expect(label).toHaveAttribute('aria-expanded', 'false');
    // Again, and Escape hides it; a second tap on the name toggles it off too.
    await label.tap();
    await expect(full).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(full).toBeHidden();
    await label.tap();
    await expect(full).toBeVisible();
    await label.tap();
    await expect(full).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('the start screen fits without sideways scrolling, and Start is in view and reachable by keyboard', async ({ page }) => {
    const errors = watchErrors(page);
    await openWithStart(page, '/');
    await page.evaluate(() => document.fonts.ready);
    const screen = startScreen(page);
    await expect(screen).toBeVisible();
    // The logo banner: loaded, 110-150 px tall, across the card above the heading.
    await bannerLogo(page);
    const banner = await bannerLayout(page);
    expect(banner.img.height).toBeGreaterThanOrEqual(110);
    expect(banner.img.height).toBeLessThanOrEqual(150);
    expect(banner.strip.width).toBeCloseTo(banner.card.width, 0);
    expect(banner.img.width).toBeLessThanOrEqual(banner.card.width);
    expect(banner.img.bottom).toBeLessThanOrEqual(banner.title.top);
    const fit = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('.start-screen')!;
      const body = dialog.querySelector<HTMLElement>('.start-body')!;
      const r = dialog.getBoundingClientRect();
      return {
        page: document.documentElement.scrollWidth - window.innerWidth,
        dialog: dialog.scrollWidth - dialog.clientWidth,
        body: body.scrollWidth - body.clientWidth,
        left: r.left,
        right: window.innerWidth - r.right,
      };
    });
    expect(fit.page).toBeLessThanOrEqual(0);
    expect(fit.dialog).toBeLessThanOrEqual(0);
    expect(fit.body).toBeLessThanOrEqual(0);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeGreaterThanOrEqual(0);
    const start = screen.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeInViewport({ ratio: 1 });
    // Every difficulty card is reachable too.
    for (const radio of await screen.getByRole('radio').all()) {
      const box = (await radio.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }

    // Tab from the name field to Start, then Enter starts.
    await expect(screen.getByLabel('Company name')).toBeFocused();
    for (let i = 0; i < 8 && !(await start.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
    await expect(start).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(screen).toBeHidden();
    expect(await company(page)).toMatchObject({ difficulty: 'seed' });
    expect(errors).toEqual([]);
  });
});

test.describe('the logo banner', () => {
  test('heads the card on a desktop: 160-220 px tall, edge to edge, centred, nothing moving as it loads', async ({ page }) => {
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    // Hold the logo files back, to see the space they will fill already held.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/logo-(640|1280).*\.webp$/, async (route) => {
      await held;
      await route.continue();
    });
    // Not waiting for the load event: the held logo would hold it back.
    await page.goto(withDebug(withStart('/')), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__lst !== undefined);
    await page.evaluate(() => document.fonts.ready);
    const screen = startScreen(page);
    await expect(screen).toBeVisible();
    expect(await screen.locator('img').evaluate((img: HTMLImageElement) => img.complete)).toBe(false);
    const before = await bannerLayout(page);
    release();
    await bannerLogo(page);
    const after = await bannerLayout(page);
    expect(after.img).toEqual(before.img);
    expect(after.title).toEqual(before.title);

    expect(after.img.height).toBeGreaterThanOrEqual(160);
    expect(after.img.height).toBeLessThanOrEqual(220);
    // At the top of the card, across its full width, the logo in the middle of it.
    expect(after.strip.top).toBeCloseTo(after.dialog.top + 1, 0);
    expect(after.strip.left).toBeCloseTo(after.dialog.left + after.card.left, 0);
    expect(after.strip.width).toBeCloseTo(after.card.width, 0);
    expect(after.strip.height).toBeCloseTo(after.img.height, 0);
    expect(Math.abs(after.img.left - after.strip.left - (after.strip.right - after.img.right))).toBeLessThanOrEqual(1);
    expect(after.img.bottom).toBeLessThanOrEqual(after.title.top);
    // The heading still names the dialog, and the whole card fits.
    await expect(screen.getByRole('heading', { name: 'Start your fiber company' })).toBeVisible();
    expect(after.bodyOverflow).toBeLessThanOrEqual(0);
    expect(after.sideways).toBeLessThanOrEqual(0);
    await expect(screen.getByRole('button', { name: 'Start', exact: true })).toBeInViewport({ ratio: 1 });
    expect(errors).toEqual([]);
  });

  // Laptop screens: 1280x800, a 1366x768 screen's or a 1024x768 one's full
  // height, and 1280x720 (about what a 1536x864 screen leaves under the browser's
  // bars, and Playwright's own desktop size). The form's spacing tightens and the
  // banner gives up height as the screen does, so the whole card still fits, the
  // town row included, with the banner never under 140 px.
  for (const { width, height, min, max } of [
    { width: 1280, height: 800, min: 160, max: 210 },
    { width: 1366, height: 768, min: 160, max: 210 },
    { width: 1024, height: 768, min: 160, max: 210 },
    { width: 1280, height: 720, min: 140, max: 209 },
  ]) {
    test(`fits the whole card on a ${width}x${height} laptop screen, the banner ${min}-${max} px tall`, async ({ page }) => {
      const errors = watchErrors(page);
      await page.setViewportSize({ width, height });
      await openWithStart(page, '/');
      await page.evaluate(() => document.fonts.ready);
      await bannerLogo(page);
      const banner = await bannerLayout(page);
      // Within half a pixel: the image's height comes out of its width at the logo's ratio.
      expect(banner.img.height).toBeGreaterThanOrEqual(min - 0.5);
      expect(banner.img.height).toBeLessThanOrEqual(max + 0.5);
      expect(banner.bodyOverflow).toBeLessThanOrEqual(0);
      // The last row, the town and its New town button, in full above the footer.
      expect(banner.town.bottom).toBeLessThanOrEqual(banner.body.bottom);
      expect(banner.dialog.top).toBeGreaterThanOrEqual(0);
      expect(banner.dialog.bottom).toBeLessThanOrEqual(height);
      expect(banner.sideways).toBeLessThanOrEqual(0);
      const screen = startScreen(page);
      await expect(screen.getByRole('button', { name: 'New town' })).toBeInViewport({ ratio: 1 });
      await expect(screen.getByRole('button', { name: 'Start', exact: true })).toBeInViewport({ ratio: 1 });
      expect(errors).toEqual([]);
    });
  }

  test('on a shorter laptop screen keeps a 140 px banner and scrolls the form under it, Start in view', async ({ page }) => {
    // 1366x657: a 1366x768 screen less the browser's bars. Too short for the whole card.
    const errors = watchErrors(page);
    await page.setViewportSize({ width: 1366, height: 657 });
    await openWithStart(page, '/');
    await page.evaluate(() => document.fonts.ready);
    await bannerLogo(page);
    const banner = await bannerLayout(page);
    expect(banner.img.height).toBeGreaterThanOrEqual(139.5);
    expect(banner.img.height).toBeLessThanOrEqual(141);
    expect(banner.dialog.top).toBeGreaterThanOrEqual(0);
    expect(banner.dialog.bottom).toBeLessThanOrEqual(657);
    expect(banner.sideways).toBeLessThanOrEqual(0);
    const screen = startScreen(page);
    const start = screen.getByRole('button', { name: 'Start', exact: true });
    await expect(start).toBeInViewport({ ratio: 1 });
    // The town row is a scroll away, and Start stays put while the form scrolls.
    expect(banner.bodyOverflow).toBeGreaterThan(0);
    await screen.locator('.start-body').evaluate((body) => (body.scrollTop = body.scrollHeight));
    const newTown = screen.getByRole('button', { name: 'New town' });
    await expect(newTown).toBeInViewport({ ratio: 1 });
    await expect(start).toBeInViewport({ ratio: 1 });
    expect(errors).toEqual([]);
  });

  test.describe('on a landscape phone', () => {
    test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

    test('becomes a small badge beside the heading, and Start stays in view and reachable by keyboard', async ({ page }) => {
      const errors = watchErrors(page);
      await openWithStart(page, '/');
      await page.evaluate(() => document.fonts.ready);
      const screen = startScreen(page);
      await bannerLogo(page);
      const banner = await bannerLayout(page);
      expect(banner.img.height).toBeLessThanOrEqual(56);
      // Beside the heading, not above it.
      expect(banner.img.right).toBeLessThanOrEqual(banner.title.left);
      expect(banner.img.bottom).toBeGreaterThan(banner.title.top);
      expect(banner.dialog.top).toBeGreaterThanOrEqual(0);
      expect(banner.dialog.bottom).toBeLessThanOrEqual(390);
      expect(banner.sideways).toBeLessThanOrEqual(0);
      const start = screen.getByRole('button', { name: 'Start', exact: true });
      await expect(start).toBeInViewport({ ratio: 1 });
      await expect(screen.getByLabel('Company name')).toBeFocused();
      for (let i = 0; i < 8 && !(await start.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
      await expect(start).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(screen).toBeHidden();
      expect(errors).toEqual([]);
    });
  });
});

test('a wide screen shows the company with a long town name beside the date', async ({ page }) => {
  // Integrator, round 4b: centred with left: 50%, the HUD used to shrink to its narrowest layout,
  // which dropped a town name like this one ("Fennel Junction") although the screen had room.
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await open(page, '/?seed=424242');
  const town = page.getByTestId('hud-town');
  await expect(town).toHaveText(await page.evaluate(() => window.__lst!.getState().city.name));
  const boxes = await page.evaluate(() => {
    const box = (sel: string) => document.querySelector(sel)!.getBoundingClientRect();
    const line = box('.hud-when-line');
    const t = box('.hud-town');
    const d = box('.hud-date');
    return { town: { top: t.top, left: t.left, right: t.right }, date: { top: d.top, right: d.right }, line: { top: line.top, bottom: line.bottom, right: line.right } };
  });
  // On the date's line (not wrapped onto the hidden second line), after the date, inside the column.
  expect(boxes.town.top).toBeGreaterThanOrEqual(boxes.line.top - 1);
  expect(boxes.town.top).toBeLessThan(boxes.line.bottom);
  expect(boxes.town.left).toBeGreaterThanOrEqual(boxes.date.right);
  expect(boxes.town.right).toBeLessThanOrEqual(boxes.line.right + 0.5);
  await expect(page.getByTestId('hud-company')).toBeVisible();
  expect(errors).toEqual([]);
});
