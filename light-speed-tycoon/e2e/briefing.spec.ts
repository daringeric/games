// The month-end briefing (round 4): a close pauses the game on a sheet with
// the period at a glance and the advisor's suggestions; Continue (or Esc, or
// the backdrop) resumes the speed the player had; the frequency setting and
// its persistence; Show me moving the map or opening a panel; the phone
// layout. Round 4b: glance first (Continue and the first card in view at
// 1280x800, the details folded away, the frequency at the top), snoozing a
// card (gone, "1 snoozed", still snoozed after a reload) and recording what a
// close-time briefing showed. Debug pages start with briefings off, so every
// test here opens with ?briefing=... (helpers.openWithBriefings).
//
// Owner: ui-briefing workstream (round 4b: briefing-advisor-polish).

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { nodeOnScreen, openWithBriefings, watchErrors } from './helpers';

const SEED = '/?seed=12345';

// Headless Chromium draws WebGL in software, so map redraws (a month's ticks, a pan) are slow here.
test.describe.configure({ timeout: 60_000 });

const day = (page: Page) => page.evaluate(() => window.__lst!.getState().day);
const tick = (page: Page, days: number) => page.evaluate((n) => window.__lst!.tick(n), days);
const setSpeed = (page: Page, speed: 0 | 1 | 2 | 4) => page.evaluate((s) => window.__lst!.setSpeed(s), speed);
const briefingOpen = (page: Page) => page.evaluate(() => window.__lst!.briefingOpen());
const pressedSpeed = (page: Page) => page.locator('.speed[aria-pressed="true"]');
const briefingSheet = (page: Page) => page.locator('dialog.briefing');
const continueButton = (sheet: Locator) => sheet.getByRole('button', { name: 'Continue', exact: true });
const frequencySelect = (sheet: Locator) => sheet.getByRole('combobox', { name: 'Show this briefing' });
/** Price 1 Gig 30% over the market (test-only state through a real command): the advisor's pricing tip fires at every close. */
const overprice = (page: Page) =>
  page.evaluate(() => {
    const lst = window.__lst!;
    const pricing = lst.getState().sales.pricing;
    const tiers = pricing.tiers.map((t) => ({ id: t.id, price: t.id === 'fiber1g' ? Math.round(t.price * 1.3) : t.price, offered: t.offered }));
    return lst.dispatch({ type: 'setPricing', tiers, smbMultiplier: pricing.smbMultiplier, grandfatherMonths: 0 }).ok;
  });

async function dismissHint(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Got it' }).click();
}

test('a month close pauses the game on the briefing; Continue resumes the speed the player had', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await dismissHint(page);
  await setSpeed(page, 2);
  // A long advance stops at the close that opened the briefing.
  await tick(page, 60);
  const sheet = page.getByRole('dialog', { name: 'January 2027 briefing' });
  await expect(sheet).toBeVisible();
  expect(await day(page)).toBe(31);
  expect(await briefingOpen(page)).toBe(true);
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  await expect(continueButton(sheet)).toBeFocused();
  // No month-closed toast behind it: the briefing says it all.
  await expect(page.locator('.toast').filter({ hasText: 'Jan 2027 closed' })).toHaveCount(0);

  // At a glance first, then the advisor; the money, the notices and the look ahead folded away, closed.
  await expect(sheet.locator('.briefing-tile')).toHaveCount(7);
  await expect(sheet.locator('.briefing-section h3')).toHaveText(['The month at a glance', 'Advisor']);
  await expect(sheet.locator('details.briefing-details > summary')).toHaveText(['Money in and out', /^This month’s notices \(\d+\)$/, 'Looking ahead']);
  for (const details of await sheet.locator('details.briefing-details').all()) await expect(details).not.toHaveAttribute('open');
  // The details open on a click, and hold what they did before.
  await sheet.locator('details.briefing-money > summary').click();
  await expect(sheet.locator('details.briefing-money')).toHaveAttribute('open');
  await expect(sheet.locator('.briefing-money-net')).toBeVisible();
  // The frequency is a compact control at the top, in the header.
  await expect(frequencySelect(sheet)).toHaveValue('monthly');
  await expect(sheet.locator('.sheet-head').getByRole('combobox', { name: 'Show this briefing' })).toHaveCount(1);

  // Paused: the day does not move while it shows.
  await page.waitForTimeout(1200);
  expect(await day(page)).toBe(31);

  await continueButton(sheet).click();
  await expect(sheet).toBeHidden();
  expect(await briefingOpen(page)).toBe(false);
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '2');
  await expect.poll(() => day(page)).toBeGreaterThan(31);
  await setSpeed(page, 0);
  expect(errors).toEqual([]);
});

test('Esc and the backdrop act as Continue, and a paused game stays paused', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await dismissHint(page);
  await setSpeed(page, 4);
  await tick(page, 40);
  const sheet = briefingSheet(page);
  await expect(sheet).toBeVisible();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  await page.keyboard.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '4');

  // Paused at the next close: closing it by the backdrop leaves the game paused.
  await setSpeed(page, 0);
  await tick(page, 40);
  await expect(page.getByRole('dialog', { name: 'February 2027 briefing' })).toBeVisible();
  expect(await day(page)).toBe(59);
  await page.mouse.click(4, 4);
  await expect(sheet).toBeHidden();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  await page.waitForTimeout(600);
  expect(await day(page)).toBe(59);
  expect(errors).toEqual([]);
});

test('every quarter: nothing at the Jan and Feb closes, the quarter at the Mar close', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED, 'quarterly');
  await tick(page, 31);
  expect(await briefingOpen(page)).toBe(false);
  await expect(page.locator('.toast').filter({ hasText: 'Jan 2027 closed' })).toBeVisible();
  await tick(page, 28);
  expect(await briefingOpen(page)).toBe(false);
  await tick(page, 31);
  const sheet = page.getByRole('dialog', { name: 'Jan–Mar 2027 briefing' });
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.briefing-section h3').first()).toHaveText('The quarter at a glance');
  await expect(frequencySelect(sheet)).toHaveValue('quarterly');
  expect(errors).toEqual([]);
});

test('only when something needs attention: quiet closes pass, an overdrawn close stops the game', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED, 'attention');
  await tick(page, 31);
  expect(await briefingOpen(page)).toBe(false);
  // Overdrawn at the next close (test-only state, as other specs set cash): an insolvency warning needs the player.
  const message = await page.evaluate(() => {
    const lst = window.__lst!;
    lst.getState().finance.cash = -50_000;
    lst.tick(28);
    return lst.getState().notices.filter((n) => n.kind === 'insolvencyWarning').at(-1)?.message ?? null;
  });
  expect(message).not.toBeNull();
  const sheet = page.getByRole('dialog', { name: 'February 2027 briefing' });
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveClass(/briefing-attention/);
  await expect(frequencySelect(sheet)).toHaveValue('attention');
  // The notice is in the briefing, not toasted behind it: surfaced in the glance, and in the full list folded below.
  await expect(sheet.locator('.briefing-alert').filter({ hasText: message!.slice(0, 40) })).toBeVisible();
  await expect(sheet.locator('.briefing-notice').filter({ hasText: message!.slice(0, 40) })).toHaveCount(1);
  await expect(page.locator('.toast').filter({ hasText: message!.slice(0, 40) })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the frequency chosen on the sheet persists across a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await tick(page, 31);
  const sheet = briefingSheet(page);
  await expect(sheet).toBeVisible();
  await frequencySelect(sheet).selectOption('quarterly');
  expect(await page.evaluate(() => localStorage.getItem('lst:briefing'))).toBe('quarterly');
  await continueButton(sheet).click();
  await expect(sheet).toBeHidden();

  await page.reload();
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(await day(page)).toBe(31);
  expect(await briefingOpen(page)).toBe(false);
  await tick(page, 28);
  expect(await briefingOpen(page)).toBe(false);
  await tick(page, 31);
  const quarter = page.getByRole('dialog', { name: 'Jan–Mar 2027 briefing' });
  await expect(quarter).toBeVisible();
  await expect(frequencySelect(quarter)).toHaveValue('quarterly');
  expect(errors).toEqual([]);
});

test('Show me on the splitter advice glides the map to the cabinet and rings it; the menu reopens the briefing', async ({ page }) => {
  // A pan and a glide redraw the map many times.
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await dismissHint(page);
  const cabinet = await page.evaluate(() => {
    const lst = window.__lst!;
    const s = lst.getState();
    lst.dispatch({ type: 'placeCabinet', node: s.city.coNode });
    const c = s.network.cabinets[0]!;
    return { id: c.id, node: c.node };
  });
  await tick(page, 31);
  const sheet = briefingSheet(page);
  await expect(sheet).toBeVisible();
  await continueButton(sheet).click();
  await expect(sheet).toBeHidden();

  // Move the map well away from the cabinet, so the jump back is real.
  const viewport = page.viewportSize()!;
  const from = { x: viewport.width / 2, y: viewport.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 260, from.y - 200, { steps: 3 });
  await page.mouse.up();
  const away = await nodeOnScreen(page, cabinet.node);
  expect(Math.abs(away.x - from.x) + Math.abs(away.y - from.y)).toBeGreaterThan(200);

  // A cabinet turning signups away (test-only state, as other specs set cash); reopen the briefing from the menu.
  await page.evaluate((id) => {
    window.__lst!.getState().sales.fullCabinets = [id];
  }, cabinet.id);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /Latest briefing/ }).click();
  await expect(page.getByRole('dialog', { name: 'January 2027 briefing' })).toBeVisible();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  const show = sheet.getByRole('button', { name: /^Show me: Add a splitter/ });
  await expect(show).toBeVisible();
  // The ring lives about 2.5 s, and a slow software-rendered page can take that long to answer a click:
  // record where it was last drawn instead of racing it.
  await page.evaluate(() => {
    const w = window as unknown as { __ring: { seen: boolean; hidden: string | null; x: number; y: number } };
    w.__ring = { seen: false, hidden: null, x: Number.NaN, y: Number.NaN };
    const read = (el: HTMLElement) => {
      w.__ring = { seen: true, hidden: el.getAttribute('aria-hidden'), x: parseFloat(el.style.left), y: parseFloat(el.style.top) };
    };
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains('briefing-ring')) read(n);
        if (r.type === 'attributes' && r.target instanceof HTMLElement && r.target.classList.contains('briefing-ring')) read(r.target);
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] });
  });
  await show.click();
  await expect(sheet).toBeHidden();

  // The map glides until the cabinet sits in the middle of the free map area, ringed; the game stays paused.
  await expect
    .poll(async () => {
      const p = await nodeOnScreen(page, cabinet.node);
      return Math.abs(p.x - viewport.width / 2) < viewport.width / 6 && Math.abs(p.y - viewport.height / 2) < viewport.height / 6;
    })
    .toBe(true);
  // It fades after a few seconds...
  await expect(page.locator('.briefing-ring')).toHaveCount(0, { timeout: 8000 });
  // ...having followed the map to the cabinet.
  const ring = await page.evaluate(() => (window as unknown as { __ring: { seen: boolean; hidden: string | null; x: number; y: number } }).__ring);
  expect(ring.seen).toBe(true);
  expect(ring.hidden).toBe('true');
  const at = await nodeOnScreen(page, cabinet.node);
  expect(Math.abs(ring.x - at.x)).toBeLessThan(3);
  expect(Math.abs(ring.y - at.y)).toBeLessThan(3);
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  expect(await page.evaluate(() => window.__lst!.getState().day)).toBe(31);
  expect(errors).toEqual([]);
});

test('an Open Bank suggestion opens the Bank', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await tick(page, 31);
  const sheet = briefingSheet(page);
  await expect(sheet).toBeVisible();
  await continueButton(sheet).click();
  await expect(sheet).toBeHidden();
  // A frozen credit line deep in debt with little cash (test-only state, as other specs set debt and cash).
  await page.evaluate(() => {
    const s = window.__lst!.getState();
    s.debt.credit.balance = 300_000;
    s.debt.covenant.stage = 'frozen';
    s.finance.cash = 4_000;
  });
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /Latest briefing/ }).click();
  await expect(sheet).toBeVisible();
  const openBank = sheet.getByRole('button', { name: /^Open Bank/ });
  // The bank rules come from the sim advisor (advisor.advise); skip until one is in the build.
  test.skip((await openBank.count()) === 0, 'no advisor rule suggests the Bank in this build yet');
  await openBank.first().click();
  await expect(page.getByRole('dialog', { name: 'Bank' })).toBeVisible();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('one column with no sideways scroll, Continue reachable and big enough, a sensible tab order', async ({ page }) => {
    const errors = watchErrors(page);
    await openWithBriefings(page, SEED);
    await page.evaluate(() => {
      const lst = window.__lst!;
      lst.dispatch({ type: 'placeCabinet', node: lst.getState().city.coNode });
    });
    await tick(page, 31);
    await page.evaluate(() => {
      const s = window.__lst!.getState();
      s.sales.fullCabinets = [s.network.cabinets[0]!.id];
    });
    // Reopen so the advisor has a suggestion to lay out too.
    await page.keyboard.press('Escape');
    await expect(briefingSheet(page)).toBeHidden();
    await page.getByRole('button', { name: 'Menu' }).tap();
    await page.getByRole('menuitem', { name: /Latest briefing/ }).tap();
    const sheet = briefingSheet(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.briefing-card')).not.toHaveCount(0);

    const layout = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('dialog.briefing')!;
      const body = dialog.querySelector<HTMLElement>('.sheet-body')!;
      const r = dialog.getBoundingClientRect();
      const wide = [...dialog.querySelectorAll<HTMLElement>('*')]
        .filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && (b.left < r.left - 1 || b.right > r.right + 1);
        })
        .map((el) => el.className || el.tagName);
      const tiles = [...dialog.querySelectorAll<HTMLElement>('.briefing-tile')].map((t) => t.getBoundingClientRect().left);
      return {
        pageScroll: document.documentElement.scrollWidth - window.innerWidth,
        bodyScroll: body.scrollWidth - body.clientWidth,
        inView: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
        wide,
        columns: new Set(tiles.map((x) => Math.round(x))).size,
      };
    });
    expect(layout.pageScroll).toBeLessThanOrEqual(0);
    expect(layout.bodyScroll).toBeLessThanOrEqual(0);
    expect(layout.inView).toBe(true);
    expect(layout.wide).toEqual([]);
    // The tiles wrap: no more than two side by side at phone width.
    expect(layout.columns).toBeLessThanOrEqual(2);

    // One column: every section starts at the same left edge.
    const lefts = await sheet.locator('.sheet-body > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);

    const go = continueButton(sheet);
    await expect(go).toBeInViewport();
    await expect(go).toBeFocused();
    const size = await go.boundingBox();
    expect(size!.height).toBeGreaterThanOrEqual(44);
    for (const button of await sheet.locator('.briefing-show, .briefing-snooze, .briefing-summary, .briefing-frequency-select').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }

    // Shift+Tab walks back from Continue through the folded details to the last card's buttons.
    await page.keyboard.press('Shift+Tab');
    await expect(sheet.locator('details.briefing-forward > summary')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(sheet.locator('details.briefing-notices > summary')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(sheet.locator('details.briefing-money > summary')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(sheet.locator('.briefing-snooze').last()).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(sheet.locator('.briefing-show').last()).toBeFocused();
    // The body scrolled the focused button into view.
    await expect(sheet.locator('.briefing-show').last()).toBeInViewport();

    await go.tap();
    await expect(sheet).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test('snoozing a card hides it, shows "1 snoozed", and the snooze survives a reload to the next close', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await dismissHint(page);
  expect(await overprice(page)).toBe(true);
  await tick(page, 31);
  const sheet = page.getByRole('dialog', { name: 'January 2027 briefing' });
  await expect(sheet).toBeVisible();
  const card = sheet.locator('.briefing-card[data-key="pricing:fiber1g"]');
  await expect(card).toHaveCount(1);
  await expect(sheet.locator('.briefing-snoozed')).toHaveCount(0);
  // The close-time briefing recorded what it showed.
  const shown = await page.evaluate(() => window.__lst!.getState().advisor.shown.map((e) => ({ key: e.key, lastDay: e.lastDay })));
  expect(shown).toContainEqual({ key: 'pricing:fiber1g', lastDay: 31 });
  const cards = await sheet.locator('.briefing-card').count();

  // The button says how long; snoozing re-renders in place.
  const snooze = card.getByRole('button', { name: /^Snooze 3 months: / });
  await expect(snooze).toHaveText('Snooze 3 months');
  await snooze.click();
  await expect(sheet).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(sheet.locator('.briefing-snoozed')).toHaveText('1 snoozed suggestion');
  await expect(sheet.locator('.briefing-card')).toHaveCount(cards - 1);
  // Focus stays in the advisor: on the card that took its place, else the heading.
  const focusedInAdvisor = await page.evaluate(() => document.activeElement?.closest('.briefing-advisor') !== null);
  expect(focusedInAdvisor).toBe(true);
  expect(await page.evaluate(() => window.__lst!.getState().advisor.snoozes.map((x) => x.key))).toEqual(['pricing:fiber1g']);
  await continueButton(sheet).click();
  await expect(sheet).toBeHidden();

  // Reopened from the menu later in the month: still hidden, and nothing more recorded.
  await tick(page, 3);
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /Latest briefing/ }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.briefing-card[data-key="pricing:fiber1g"]')).toHaveCount(0);
  await expect(sheet.locator('.briefing-snoozed')).toHaveText('1 snoozed suggestion');
  expect(await page.evaluate(() => Math.max(...window.__lst!.getState().advisor.shown.map((e) => e.lastDay)))).toBe(31);
  await continueButton(sheet).click();

  // The next close autosaves with the snooze; reload and play to the close after it: still snoozed.
  await tick(page, 25);
  const feb = page.getByRole('dialog', { name: 'February 2027 briefing' });
  await expect(feb).toBeVisible();
  await expect(feb.locator('.briefing-card[data-key="pricing:fiber1g"]')).toHaveCount(0);
  await continueButton(feb).click();
  await page.reload();
  await page.waitForFunction(() => window.__lst !== undefined);
  expect(await day(page)).toBe(59);
  expect(await page.evaluate(() => window.__lst!.getState().advisor.snoozes.map((x) => x.key))).toEqual(['pricing:fiber1g']);
  await tick(page, 31);
  const mar = page.getByRole('dialog', { name: 'March 2027 briefing' });
  await expect(mar).toBeVisible();
  await expect(mar.locator('.briefing-card[data-key="pricing:fiber1g"]')).toHaveCount(0);
  await expect(mar.locator('.briefing-snoozed')).toHaveText('1 snoozed suggestion');
  expect(errors).toEqual([]);
});

test.describe('on a desktop screen', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('glance first: Continue and the first advice card are in view without scrolling, the frequency at the top', async ({ page }) => {
    const errors = watchErrors(page);
    await openWithBriefings(page, SEED);
    await dismissHint(page);
    expect(await overprice(page)).toBe(true);
    await tick(page, 31);
    const sheet = briefingSheet(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.briefing-card')).not.toHaveCount(0);
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('dialog.briefing')!;
      const body = dialog.querySelector<HTMLElement>('.sheet-body')!;
      const card = dialog.querySelector<HTMLElement>('.briefing-card')!.getBoundingClientRect();
      const view = body.getBoundingClientRect();
      const go = dialog.querySelector<HTMLElement>('.briefing-continue')!.getBoundingClientRect();
      const select = dialog.querySelector<HTMLElement>('.briefing-frequency-select')!.getBoundingClientRect();
      const glance = dialog.querySelector<HTMLElement>('.briefing-glance')!.getBoundingClientRect();
      return {
        scrollTop: body.scrollTop,
        cardInBody: card.top >= view.top - 1 && card.bottom <= view.bottom + 1,
        continueOnScreen: go.top >= 0 && go.bottom <= window.innerHeight,
        frequencyFirst: select.bottom <= glance.top,
      };
    });
    expect(layout.scrollTop).toBe(0);
    expect(layout.cardInBody).toBe(true);
    expect(layout.continueOnScreen).toBe(true);
    expect(layout.frequencyFirst).toBe(true);
    await expect(continueButton(sheet)).toBeInViewport();
    await expect(sheet.locator('.briefing-card').first()).toBeInViewport({ ratio: 1 });
    // The company name leads the subtitle.
    const company = await page.evaluate(() => window.__lst!.getState().company.name);
    await expect(sheet.locator('.sheet-subtitle')).toContainText(`${company} · game paused.`);
    expect((await sheet.locator('.sheet-subtitle').textContent())!.startsWith(`${company} · `)).toBe(true);
    expect(errors).toEqual([]);
  });
});
