// The month-end summary (round 4; round 4c/4d's "Summary B + next step"): a
// close pauses the game on a sheet that shows the money in and out on one
// scale, the cash card, the customers line, what needs attention and the
// advisor's next step; Continue (or Esc, or the backdrop) resumes the speed
// the player had. Every action: Continue, See the full books and Back (the
// tiles, the itemized money, the notices, the look ahead and the frequency
// select live there), the frequency setting and its persistence, a money
// group's lines, Show me moving the map, Not now (snoozed, counted, still
// snoozed after a reload), the more tips, See customers (the Customers
// dashboard), Open the Bank (the Bank), a phone-width pass and a desktop
// pass. Debug pages start with briefings off, so every test here opens with
// ?briefing=... (helpers.openWithBriefings).
//
// Owner: ui-summary workstream (round 4c/4d); ui-briefing / briefing-advisor-polish before.

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
const booksButton = (sheet: Locator) => sheet.getByRole('button', { name: 'See the full books' });
const backButton = (sheet: Locator) => sheet.getByRole('button', { name: 'Back to the summary' });
const frequencySelect = (sheet: Locator) => sheet.getByRole('combobox', { name: 'Show this briefing' });
const HEADLINES = /^(You earned more than you spent|You spent more than you earned, because you're building|Your bills don't cover your running costs yet|The bank .+)$/;
/** Price 1 Gig 30% over the market (test-only state through a real command): the advisor's pricing tip fires at every close. */
const overprice = (page: Page) =>
  page.evaluate(() => {
    const lst = window.__lst!;
    const pricing = lst.getState().sales.pricing;
    const tiers = pricing.tiers.map((t) => ({ id: t.id, price: t.id === 'fiber1g' ? Math.round(t.price * 1.3) : t.price, offered: t.offered }));
    return lst.dispatch({ type: 'setPricing', tiers, smbMultiplier: pricing.smbMultiplier, grandfatherMonths: 0 }).ok;
  });
/** A cabinet at the CO (test setup through a real command); returns its id and node. */
const cabinetAtCo = (page: Page) =>
  page.evaluate(() => {
    const lst = window.__lst!;
    const s = lst.getState();
    lst.dispatch({ type: 'placeCabinet', node: s.city.coNode });
    const c = s.network.cabinets[0]!;
    return { id: c.id, node: c.node };
  });
/** Mark the first cabinet full (test-only state, as other specs set cash): the advisor suggests a splitter, attention lists it. */
const fillCabinet = (page: Page) =>
  page.evaluate(() => {
    const s = window.__lst!.getState();
    s.sales.fullCabinets = [s.network.cabinets[0]!.id];
  });
const reopenFromMenu = async (page: Page) => {
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: /Latest briefing/ }).click();
};
/** The card for an advice key, opening the more tips first when it is one of them. */
async function revealCard(sheet: Locator, key: string): Promise<Locator> {
  const card = sheet.locator(`.briefing-card[data-key="${key}"]`);
  await expect(card).toHaveCount(1);
  if (!(await card.isVisible())) await sheet.locator('.briefing-tips-summary').click();
  await expect(card).toBeVisible();
  return card;
}

async function dismissHint(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Got it' }).click();
}

test('a month close pauses the game on the summary; Continue resumes the speed the player had', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await dismissHint(page);
  await setSpeed(page, 2);
  // A long advance stops at the close that opened the summary.
  await tick(page, 60);
  const sheet = page.getByRole('dialog', { name: 'January 2027 briefing' });
  await expect(sheet).toBeVisible();
  expect(await day(page)).toBe(31);
  expect(await briefingOpen(page)).toBe(true);
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  await expect(continueButton(sheet)).toBeFocused();
  // No month-closed toast behind it: the summary says it all.
  await expect(page.locator('.toast').filter({ hasText: 'Jan 2027 closed' })).toHaveCount(0);

  // The header: the month and the company, then the headline from the period's story.
  const company = await page.evaluate(() => window.__lst!.getState().company.name);
  await expect(sheet.locator('.briefing-kicker')).toHaveText(`January 2027 · ${company}`);
  await expect(sheet.locator('.briefing-headline')).toHaveText(HEADLINES);
  // First view, top to bottom: money in, money out (with its three groups), the cash card, the customers line, the next step.
  await expect(sheet.locator('.sheet-body > *')).toHaveClass([/briefing-money-in/, /briefing-money-out/, /briefing-cash/, /briefing-customers/, /briefing-next/]);
  await expect(sheet.getByRole('heading', { name: 'Money in' })).toBeVisible();
  await expect(sheet.getByRole('heading', { name: 'Money out' })).toBeVisible();
  await expect(sheet.locator('.briefing-bar-out')).toHaveAttribute('aria-label', /^Money out \$[\d,]+: Running the business \$[\d,]+/);
  await expect(sheet.locator('.briefing-cash-title')).toHaveText(/^(Cash went (down|up) \$[\d,]+|Cash stayed the same)$/);
  await expect(sheet.locator('.briefing-cash-left')).toHaveText(/^\$[\d,]+ (left|overdrawn)$/);
  await expect(sheet.locator('.briefing-customers-text')).toHaveText(/^\d[\d,]* customers?( \([+-]\d[\d,]*\))?\. /);
  await expect(sheet.locator('.briefing-step-label')).toHaveText('Your next step');
  await expect(sheet.locator('.briefing-attention-list')).toHaveCount(0);
  // No jargon on the first view.
  const firstView = (await sheet.locator('.sheet-body').innerText()) + (await sheet.locator('.sheet-head').innerText());
  expect(firstView).not.toMatch(/leverage|covenant|DSCR|\bARR\b|\bOCF\b|\bbps\b|×/i);
  // The frequency lives in the full books, not here.
  await expect(frequencySelect(sheet)).toHaveCount(0);

  // Each money-out group is a button that opens its lines, closed by default.
  const groups = sheet.locator('.briefing-group');
  await expect(groups).toHaveCount(3);
  await expect(groups.locator('.briefing-group-name')).toHaveText(['Running the business', 'Building fiber', 'Loan payments']);
  for (const g of await groups.all()) await expect(g).toHaveAttribute('aria-expanded', 'false');
  const running = groups.first();
  await expect(sheet.locator('.group-running .briefing-group-lines')).toBeHidden();
  await running.click();
  await expect(running).toHaveAttribute('aria-expanded', 'true');
  const lines = sheet.locator('.group-running .briefing-group-lines');
  await expect(lines).toBeVisible();
  // Running the business lists the overhead's base line first.
  await expect(lines.locator('.briefing-line').first()).toHaveAttribute('data-key', /^overhead/);
  await running.click();
  await expect(lines).toBeHidden();
  // The building group names the cost per home passed against the target.
  await expect(sheet.locator('.group-building .briefing-group-note')).toHaveText(/(per home passed, target \$[\d,]+|^No homes passed yet, target \$[\d,]+ each)$/);

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

test('See the full books holds the tiles, the itemized money, the notices, the look ahead and the frequency; Back returns; Continue works there', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await dismissHint(page);
  await setSpeed(page, 2);
  await tick(page, 31);
  const sheet = page.getByRole('dialog', { name: 'January 2027 briefing' });
  await expect(sheet).toBeVisible();
  await booksButton(sheet).click();
  // Same dialog, same name; the books view.
  await expect(sheet).toHaveAttribute('data-mode', 'books');
  const books = sheet.locator('.briefing-books');
  await expect(books.getByRole('heading', { name: 'The full books' })).toBeFocused();
  await expect(books.locator('.briefing-tile')).toHaveCount(7);
  await expect(books.locator('.briefing-tile dt')).toHaveText(['Net this month', 'Cash', 'Customers', 'Homes passed', 'Take rate', 'Cost per home passed', 'Debt']);
  await expect(books.locator('.briefing-part h4')).toHaveText(['Money in and out', /^This month’s notices \(\d+\)$/, 'Looking ahead']);
  await expect(books.locator('.briefing-money-net')).toContainText(/Cash change[+-]?\$[\d,]+/);
  // The overhead's lines are itemized under running the business.
  await expect(books.locator('.group-running .briefing-line[data-key="overheadBase"]')).toHaveCount(1);
  await expect(books.locator('.briefing-forward-row')).toHaveCount(4);
  await expect(frequencySelect(sheet)).toHaveValue('monthly');
  // Back to the summary, focus on the button that opened the books.
  await backButton(sheet).click();
  await expect(sheet).toHaveAttribute('data-mode', 'summary');
  await expect(sheet.locator('.briefing-books')).toHaveCount(0);
  await expect(sheet.locator('.briefing-money-in')).toBeVisible();
  await expect(booksButton(sheet)).toBeFocused();
  // Continue from the books view resumes the game too.
  await booksButton(sheet).click();
  await continueButton(sheet).click();
  await expect(sheet).toBeHidden();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '2');
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
  const company = await page.evaluate(() => window.__lst!.getState().company.name);
  await expect(sheet.locator('.briefing-kicker')).toHaveText(`Jan–Mar 2027 · ${company}`);
  await booksButton(sheet).click();
  await expect(sheet.locator('.briefing-tile dt').first()).toHaveText('Net this quarter');
  await expect(sheet.locator('.briefing-part h4').first()).toHaveText('Money in and out this quarter');
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
  // The cash card says it plainly.
  await expect(sheet.locator('.briefing-cash-left')).toHaveText(/^\$[\d,]+ overdrawn$/);
  // The notice is in the full books, not toasted behind the sheet.
  await expect(page.locator('.toast').filter({ hasText: message!.slice(0, 40) })).toHaveCount(0);
  await booksButton(sheet).click();
  await expect(sheet.locator('.briefing-notice').filter({ hasText: message!.slice(0, 40) })).toHaveCount(1);
  await expect(frequencySelect(sheet)).toHaveValue('attention');
  expect(errors).toEqual([]);
});

test('the frequency chosen in the full books persists across a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await tick(page, 31);
  const sheet = briefingSheet(page);
  await expect(sheet).toBeVisible();
  await booksButton(sheet).click();
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
  await booksButton(quarter).click();
  await expect(frequencySelect(quarter)).toHaveValue('quarterly');
  expect(errors).toEqual([]);
});

test('Show me on the splitter advice glides the map to the cabinet and rings it; the menu reopens the summary', async ({ page }) => {
  // A pan and a glide redraw the map many times.
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await dismissHint(page);
  const cabinet = await cabinetAtCo(page);
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

  await fillCabinet(page);
  await reopenFromMenu(page);
  await expect(page.getByRole('dialog', { name: 'January 2027 briefing' })).toBeVisible();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  // The full cabinet needs attention too, with its own Show me.
  await expect(sheet.locator('.briefing-alert[data-kind="cabinetFull"]').getByRole('button', { name: /^Show me: The cabinet at .+ is full/ })).toBeVisible();
  const key = `addSplitter:cabinet:${cabinet.id}`;
  const card = await revealCard(sheet, key);
  const show = card.getByRole('button', { name: /^Show me: Add a splitter/ });
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
  await expect(page.locator('.briefing-ring')).toHaveCount(0, { timeout: 8000 });
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

test('Open the Bank on a bank line opens the Bank; See customers opens the Customers dashboard', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await tick(page, 31);
  const sheet = briefingSheet(page);
  await expect(sheet).toBeVisible();
  // See customers: the sheet closes on the Customers dashboard, the game still paused.
  await sheet.getByRole('button', { name: 'See customers' }).click();
  await expect(sheet).toBeHidden();
  const customers = page.getByRole('dialog', { name: 'Customers' });
  await expect(customers).toBeVisible();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  expect(await page.evaluate(() => window.__lst!.customersOpen())).toBe(true);
  await page.keyboard.press('Escape');
  await expect(customers).toBeHidden();

  // Debt with nothing behind it yet (test-only state, as other specs set debt): the bank would fail a check today.
  await page.evaluate(() => {
    window.__lst!.getState().debt.credit.balance = 300_000;
  });
  await reopenFromMenu(page);
  await expect(sheet).toBeVisible();
  const line = sheet.locator('.briefing-alert[data-kind="bankWatch"]');
  await expect(line).toBeVisible();
  await expect(line).toContainText('Bank health: Watch');
  await expect(sheet.getByRole('heading', { name: 'Needs attention' })).toBeVisible();
  await line.getByRole('button', { name: 'Open the Bank' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Bank' })).toBeVisible();
  await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
  expect(errors).toEqual([]);
});

test('the bank leads the headline when it is worried, in its own plain words', async ({ page }) => {
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await tick(page, 31);
  const sheet = briefingSheet(page);
  await expect(sheet).toBeVisible();
  await continueButton(sheet).click();
  // A warning from the bank with debt owed (test-only state, as other specs set the covenant stage).
  await page.evaluate(() => {
    const s = window.__lst!.getState();
    s.debt.credit.balance = 300_000;
    s.debt.covenant.stage = 'warning';
  });
  await reopenFromMenu(page);
  await expect(sheet.locator('.briefing-headline')).toHaveText('The bank is worried about your loans');
  await expect(sheet.locator('.briefing-health')).toHaveText('Bank health: Warning');
  // Debt is never success green.
  await booksButton(sheet).click();
  const debt = sheet.locator('.briefing-tile-debt');
  await expect(debt.locator('.briefing-tile-detail')).toHaveText('Bank health: Warning');
  await expect(debt.locator('.briefing-tile-value')).toHaveClass(/tone-warn/);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('one column with no sideways scroll, the legend stacked, Continue always in reach and big enough', async ({ page }) => {
    const errors = watchErrors(page);
    await openWithBriefings(page, SEED);
    await cabinetAtCo(page);
    await tick(page, 31);
    await fillCabinet(page);
    // Reopen so the advisor and the attention lines have something to lay out too.
    await page.keyboard.press('Escape');
    await expect(briefingSheet(page)).toBeHidden();
    await page.getByRole('button', { name: 'Menu' }).tap();
    await page.getByRole('menuitem', { name: /Latest briefing/ }).tap();
    const sheet = briefingSheet(page);
    await expect(sheet).toBeVisible();
    await expect(sheet.locator('.briefing-card-main')).toHaveCount(1);
    await expect(sheet.locator('.briefing-alert')).not.toHaveCount(0);
    // Open every group and the more tips: the widest the first view gets.
    for (const g of await sheet.locator('.briefing-group:not([disabled])').all()) await g.tap();
    if (await sheet.locator('.briefing-tips-summary').count()) await sheet.locator('.briefing-tips-summary').tap();

    const layout = async () =>
      page.evaluate(() => {
        const dialog = document.querySelector<HTMLElement>('dialog.briefing')!;
        const body = dialog.querySelector<HTMLElement>('.sheet-body')!;
        const r = dialog.getBoundingClientRect();
        const wide = [...dialog.querySelectorAll<HTMLElement>('*')]
          .filter((el) => {
            const b = el.getBoundingClientRect();
            return b.width > 0 && (b.left < r.left - 1 || b.right > r.right + 1);
          })
          .map((el) => el.className || el.tagName);
        const legend = [...dialog.querySelectorAll<HTMLElement>('.briefing-group-item')].map((t) => Math.round(t.getBoundingClientRect().left));
        return {
          pageScroll: document.documentElement.scrollWidth - window.innerWidth,
          bodyScroll: body.scrollWidth - body.clientWidth,
          inView: r.left >= 0 && r.right <= window.innerWidth && r.top >= 0 && r.bottom <= window.innerHeight,
          wide,
          legendColumns: new Set(legend).size,
        };
      });
    const first = await layout();
    expect(first.pageScroll).toBeLessThanOrEqual(0);
    expect(first.bodyScroll).toBeLessThanOrEqual(0);
    expect(first.inView).toBe(true);
    expect(first.wide).toEqual([]);
    // The legend stacks: one group per row.
    expect(first.legendColumns).toBe(1);
    // One column: every section starts at the same left edge.
    const lefts = await sheet.locator('.sheet-body > *').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
    expect(new Set(lefts).size).toBe(1);

    const go = continueButton(sheet);
    await expect(go).toBeInViewport();
    expect((await go.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    for (const button of await sheet.locator('.briefing-show, .briefing-snooze, .briefing-group, .briefing-alert-action, .briefing-see-customers, .briefing-tips-summary, .briefing-books-open').all()) {
      expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    // Scrolled to the end, Continue is still in reach (the footer stays).
    await sheet.locator('.sheet-body').evaluate((b) => {
      b.scrollTop = b.scrollHeight;
    });
    await expect(go).toBeInViewport();
    await expect(booksButton(sheet)).toBeInViewport();

    // The full books fit too.
    await booksButton(sheet).tap();
    const books = await layout();
    expect(books.pageScroll).toBeLessThanOrEqual(0);
    expect(books.bodyScroll).toBeLessThanOrEqual(0);
    expect(books.wide).toEqual([]);
    expect((await frequencySelect(sheet).boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await expect(go).toBeInViewport();
    await backButton(sheet).tap();
    // Shift+Tab from Continue reaches See the full books, then the body.
    await go.focus();
    await page.keyboard.press('Shift+Tab');
    await expect(booksButton(sheet)).toBeFocused();
    await go.tap();
    await expect(sheet).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test('Not now hides a suggestion, counts it, and the snooze survives a reload to the next close; the more tips list the rest', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await openWithBriefings(page, SEED);
  await dismissHint(page);
  expect(await overprice(page)).toBe(true);
  await cabinetAtCo(page);
  await tick(page, 31);
  const sheet = page.getByRole('dialog', { name: 'January 2027 briefing' });
  await expect(sheet).toBeVisible();
  // The close-time summary recorded what it showed.
  const shown = await page.evaluate(() => window.__lst!.getState().advisor.shown.map((e) => ({ key: e.key, lastDay: e.lastDay })));
  expect(shown).toContainEqual({ key: 'pricing:fiber1g', lastDay: 31 });

  // The more tips: a quiet disclosure, closed, naming how many there are; each tip has Show me and Not now.
  const tips = sheet.locator('.briefing-tips');
  const tipCount = await sheet.locator('.briefing-card-tip').count();
  expect(tipCount).toBeGreaterThan(0);
  await expect(tips).not.toHaveAttribute('open');
  await expect(sheet.locator('.briefing-tips-summary')).toHaveText(tipCount === 1 ? '1 more tip' : `${tipCount} more tips`);
  await sheet.locator('.briefing-tips-summary').click();
  await expect(tips).toHaveAttribute('open');
  for (const tip of await sheet.locator('.briefing-card-tip').all()) {
    await expect(tip.locator('.briefing-show')).toBeVisible();
    await expect(tip.getByRole('button', { name: /^Not now: / })).toBeVisible();
  }
  const cards = await sheet.locator('.briefing-card').count();
  await expect(sheet.locator('.briefing-snoozed')).toHaveCount(0);

  // Not now re-renders in place: the card is gone, counted, and focus stays in the next step.
  const card = await revealCard(sheet, 'pricing:fiber1g');
  const notNow = card.getByRole('button', { name: /^Not now: / });
  await expect(notNow).toHaveText('Not now');
  await expect(notNow).toHaveAttribute('title', 'Hide this for 3 months');
  await notNow.click();
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.briefing-card[data-key="pricing:fiber1g"]')).toHaveCount(0);
  await expect(sheet.locator('.briefing-snoozed')).toHaveText('1 snoozed suggestion');
  await expect(sheet.locator('.briefing-card')).toHaveCount(cards - 1);
  expect(await page.evaluate(() => document.activeElement?.closest('.briefing-next') !== null)).toBe(true);
  expect(await page.evaluate(() => window.__lst!.getState().advisor.snoozes.map((x) => x.key))).toEqual(['pricing:fiber1g']);
  await continueButton(sheet).click();
  await expect(sheet).toBeHidden();

  // Reopened from the menu later in the month: still hidden, and nothing more recorded.
  await tick(page, 3);
  await reopenFromMenu(page);
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

  test('a centered card: the header, both bars on one scale and Continue in view without scrolling', async ({ page }) => {
    const errors = watchErrors(page);
    await openWithBriefings(page, SEED);
    await dismissHint(page);
    await cabinetAtCo(page);
    await tick(page, 31);
    const sheet = briefingSheet(page);
    await expect(sheet).toBeVisible();
    const layout = await page.evaluate(() => {
      const dialog = document.querySelector<HTMLElement>('dialog.briefing')!;
      const body = dialog.querySelector<HTMLElement>('.sheet-body')!;
      const r = dialog.getBoundingClientRect();
      const go = dialog.querySelector<HTMLElement>('.briefing-continue')!.getBoundingClientRect();
      const out = dialog.querySelector<HTMLElement>('.briefing-bar-out')!.getBoundingClientRect();
      const width = (sel: string) => [...dialog.querySelectorAll<HTMLElement>(`${sel} .briefing-seg`)].reduce((n, s) => n + s.getBoundingClientRect().width, 0);
      const amount = (sel: string) => Number(dialog.querySelector<HTMLElement>(sel)!.textContent!.replace(/[^\d]/g, ''));
      return {
        scrollTop: body.scrollTop,
        centered: Math.abs(r.left + r.width / 2 - window.innerWidth / 2) <= 2,
        continueOnScreen: go.top >= 0 && go.bottom <= window.innerHeight,
        barsOnScreen: out.bottom <= body.getBoundingClientRect().bottom,
        inWidth: width('.briefing-bar-in'),
        outWidth: width('.briefing-bar-out'),
        trackWidth: out.width,
        moneyIn: amount('.total-in'),
        moneyOut: amount('.total-out'),
      };
    });
    expect(layout.scrollTop).toBe(0);
    expect(layout.centered).toBe(true);
    expect(layout.continueOnScreen).toBe(true);
    expect(layout.barsOnScreen).toBe(true);
    // One scale: the larger total fills the bar, the other is in proportion.
    const scale = Math.max(layout.moneyIn, layout.moneyOut);
    expect(scale).toBeGreaterThan(0);
    expect(Math.abs(layout.inWidth - (layout.trackWidth * layout.moneyIn) / scale)).toBeLessThan(2);
    expect(Math.abs(layout.outWidth - (layout.trackWidth * layout.moneyOut) / scale)).toBeLessThan(2);
    await expect(continueButton(sheet)).toBeInViewport();
    await expect(sheet.locator('.briefing-headline')).toBeInViewport();
    // The company name leads the header.
    const company = await page.evaluate(() => window.__lst!.getState().company.name);
    expect((await sheet.locator('.briefing-kicker').textContent())!.endsWith(` · ${company}`)).toBe(true);
    expect(errors).toEqual([]);
  });
});
