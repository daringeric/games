// Round 4c/4d: the Customers dashboard end to end (spec I.5). The contract's
// wiring check (the HUD's Customers button opens it, Esc closes it and hands
// focus back), then on a lit town with customers: each lever changes the
// game (marketing budget with its forecast, support level, referral
// credits), a typed budget and its focus survive the clock running, a
// neighborhood campaign costs its quote and leaves its record, Show me
// glides the map to the area, and a phone-width pass with no horizontal
// scroll and full-size buttons. The marketing assertions that used to live
// in pricing.spec.ts (typing never reaches the map's shortcuts, the budget's
// preview line, Apply sets it) are here now. ui-summary's briefing.spec
// covers the month summary's "See customers" link; pricing.spec covers the
// pricing panel's "Change marketing" link.
//
// Owner: ui-customers workstream.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { MARKETING_MAX_PER_MONTH, SUPPORT_LEVELS } from '../src/sim/balance';
import { nodeOnScreen, open, routeFromCo, watchErrors } from './helpers';

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
const speedOf = (page: Page) => page.locator('.speed[aria-pressed="true"]').getAttribute('data-speed');

interface ToastRecord {
  text: string;
  tone: string;
}

/** Record every toast from now on (toasts leave after a few seconds; tests read this log instead of racing the DOM). */
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

/** Light the best two streets out of the CO with a cabinet there, and run `days` days so homes sign up. Returns the cabinet. */
async function litTownWithCustomers(page: Page, days: number): Promise<{ id: number; node: number }> {
  const route = await routeFromCo(page, 2);
  expect(route, 'a cable route out of the CO').not.toBeNull();
  const result = await page.evaluate(
    ({ segments, days }) => {
      const lst = window.__lst!;
      const co = lst.getState().city.coNode;
      const out = [lst.dispatch({ type: 'layCable', segments, method: 'underground' }), lst.dispatch({ type: 'placeCabinet', node: co })];
      lst.tick(days);
      const c = lst.getState().network.cabinets[0]!;
      return { ok: out.map((r) => r.ok), cabinet: { id: c.id, node: c.node } };
    },
    { segments: route!.segments, days },
  );
  expect(result.ok).toEqual([true, true]);
  return result.cabinet;
}

const customersDialog = (page: Page) => page.getByRole('dialog', { name: 'Customers' });

async function openCustomers(page: Page): Promise<Locator> {
  await page.getByTestId('hud-customers').click();
  const dialog = customersDialog(page);
  await expect(dialog).toBeVisible();
  return dialog;
}

test('the HUD Customers button opens the Customers dashboard, and Esc closes it', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const button = page.getByTestId('hud-customers');
  await expect(button).toBeVisible();
  await button.click();
  const dialog = customersDialog(page);
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => window.__lst!.customersOpen())).toBe(true);
  // A new game: plain words for an empty dashboard.
  await expect(dialog.locator('.customers-headline')).toHaveText('0 customers');
  await expect(dialog.locator('.customers-change')).toHaveText('No month has closed yet.');
  await expect(dialog.getByRole('region', { name: 'Growth' })).toContainText('The chart starts once your first month closes.');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => window.__lst!.customersOpen())).toBe(false);
  await expect(button).toBeFocused();
  expect(errors).toEqual([]);
});

test('each lever changes the game: marketing budget, support level and referral credits', async ({ page }) => {
  // Headless Chromium draws WebGL in software, so each map redraw is slow here.
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await litTownWithCustomers(page, 200);
  const dialog = await openCustomers(page);

  // The header and the sections read the game.
  const state = await page.evaluate(() => {
    const s = window.__lst!.getState();
    const units = s.sales.accounts.reduce((n, a) => n + a.tierUnits.fiber500 + a.tierUnits.fiber1g + a.tierUnits.fiber2g, 0);
    const last = s.finance.reports.at(-1)!.stats!;
    return { units, joined: last.grossAdds, left: last.churned + last.lostService, marketing: s.sales.marketingPerMonth };
  });
  expect(state.units).toBeGreaterThan(0);
  await expect(dialog.locator('.customers-headline')).toHaveText(`${state.units.toLocaleString('en-US')} customers`);
  await expect(dialog.locator('.customers-change')).toHaveText(new RegExp(`^\\+${state.joined} joined, -${state.left} left in [A-Z][a-z]+ \\d{4}$`));
  await expect(dialog.locator('.customers-share')).toHaveText(/^\d+% of the homes you can sell to are customers\.$/);
  await expect(dialog.locator('.customers-chart-svg')).toHaveCount(2);
  await expect(dialog.locator('.customers-chart-summary')).toHaveText(/ joined and \d+ left\.$/);
  const reasons = dialog.getByRole('region', { name: "Why homes haven't switched" });
  // One row per reason (and Not lit yet only when some homes are), each with the lever that addresses it.
  expect(await reasons.locator('.customers-switch-row').count()).toBeGreaterThanOrEqual(4);
  await expect(reasons.locator('[data-reason="tooExpensive"] .customers-switch-lever')).toHaveText('A cheaper plan');
  await expect(reasons.locator('[data-reason="unaware"] .customers-switch-lever')).toHaveText('Marketing or a neighborhood campaign');
  await expect(reasons.locator('[data-reason="notWorth"] .customers-switch-lever')).toHaveText('Lower prices or an intro promo');

  // Marketing: typing never reaches the map's shortcuts ("2" is the 2x speed key), the forecast follows the typed budget.
  const budget = dialog.getByLabel('Marketing budget per month');
  await expect(budget).toHaveValue(String(state.marketing));
  await expect(dialog.locator('.customers-lever-now')).toHaveText(`Now ${money(state.marketing)} a month`);
  await budget.fill('');
  await budget.pressSequentially('2500');
  expect(await speedOf(page)).toBe('0');
  const forecast = dialog.locator('.marketing-forecast');
  await expect(forecast).toHaveText(/^At \$2,500 a month: (about [\d,]+|less than one|no) new customers? a month/);
  await expect(dialog.locator('.marketing-step')).toHaveText(/^\$500 more a month: .+\. \$500 less: .+\.$/);
  // An out-of-range budget is flagged and cannot be applied.
  await budget.fill(String(MARKETING_MAX_PER_MONTH + 1));
  await expect(budget).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('.customers-problem')).toHaveText(`Marketing must be a whole number from $0 to ${money(MARKETING_MAX_PER_MONTH)} a month`);
  await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();
  await budget.fill('2500');
  await expect(budget).toHaveAttribute('aria-invalid', 'false');
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(toasts).toContainEqual(toast('ok', 'Marketing set to $2,500 a month'));
  expect(await page.evaluate(() => window.__lst!.getState().sales.marketingPerMonth)).toBe(2500);
  await expect(dialog.locator('.customers-lever-now')).toHaveText('Now $2,500 a month');
  await expect(dialog.getByRole('button', { name: 'Apply' })).toBeDisabled();

  // Support level: Great, then the state and the pressed choice follow.
  const support = dialog.getByRole('group', { name: 'Support level' });
  await expect(support.locator('[data-level="good"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(support.locator('[data-level="great"] .customers-choice-price')).toHaveText(`${money(SUPPORT_LEVELS.great.costPerSub)} a customer a month`);
  await expect(support.locator('[data-level="great"] .customers-choice-verdict')).toHaveText(/^(Better|Worse) than now by about \$[\d,]+ over a year\.$|^About the same as now over a year\.$/);
  await support.locator('[data-level="great"]').click();
  await expect.poll(toasts).toContainEqual(toast('ok', `Support set to ${SUPPORT_LEVELS.great.name}`));
  expect(await page.evaluate(() => window.__lst!.getState().customers.supportLevel)).toBe('great');
  await expect(support.locator('[data-level="great"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(support.locator('[data-level="good"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(support.locator('[data-level="great"] .customers-choice-verdict')).toHaveText('Your level now.');

  // Referral credits: on, then off again.
  const referrals = dialog.getByRole('switch', { name: 'Referral credits' });
  await expect(referrals).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.locator('.referral-verdict')).toHaveText(/^Turning them on: /);
  await referrals.click();
  await expect.poll(toasts).toContainEqual(toast('ok', 'Referral credits on'));
  expect(await page.evaluate(() => window.__lst!.getState().customers.referrals)).toBe(true);
  await expect(referrals).toHaveAttribute('aria-checked', 'true');
  await expect(dialog.locator('.referral-verdict')).toHaveText(/^Keeping them on: /);
  await referrals.click();
  await expect.poll(toasts).toContainEqual(toast('ok', 'Referral credits off'));
  expect(await page.evaluate(() => window.__lst!.getState().customers.referrals)).toBe(false);

  // Figures refresh in place while the clock runs: a typed budget and its focus survive.
  await budget.fill('3100');
  await budget.focus();
  const before = await page.evaluate(() => window.__lst!.getState().day);
  await page.evaluate(() => window.__lst!.tick(5));
  await expect.poll(() => page.evaluate(() => window.__lst!.getState().day)).toBe(before + 5);
  await expect(forecast).toHaveText(/^At \$3,100 a month: /);
  await expect(budget).toHaveValue('3100');
  await expect(budget).toBeFocused();
  expect(errors).toEqual([]);
});

test('a neighborhood campaign costs its quote and is recorded; Show me glides the map to the area', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  const hint = page.getByRole('button', { name: 'Got it' });
  if (await hint.isVisible()) await hint.click();
  const cabinet = await litTownWithCustomers(page, 120);
  const dialog = await openCustomers(page);

  const area = dialog.locator(`.customers-area[data-cabinet="${cabinet.id}"]`);
  await expect(area).toBeVisible();
  await expect(area.locator('.customers-area-facts')).toHaveText(/^[\d,]+ homes? · \d+% are customers · lit (\d+ months?|this month)$/);
  const quoteLine = area.locator('.customers-area-quote');
  await expect(quoteLine).toHaveText(/^Costs \$[\d,]+: /);
  const quoted = Number(((await quoteLine.textContent()) ?? '').match(/^Costs \$([\d,]+)/)![1]!.replace(/,/g, ''));
  const run = area.getByRole('button', { name: /^Run a campaign/ });
  await expect(run).toBeEnabled();
  const cashBefore = await page.evaluate(() => window.__lst!.getState().finance.cash);
  await run.click();
  await expect.poll(toasts).toContainEqual(toast('ok', `Campaign started at`));
  const after = await page.evaluate((id) => {
    const s = window.__lst!.getState();
    return {
      cash: s.finance.cash,
      record: s.customers.campaigns.find((c) => c.cabinet === id) ?? null,
      entry: s.finance.monthToDate.filter((e) => e.category === 'marketing').at(-1) ?? null,
      day: s.day,
    };
  }, cabinet.id);
  expect(cashBefore - after.cash).toBe(quoted);
  expect(after.record).toMatchObject({ cabinet: cabinet.id, startDay: after.day, cost: quoted });
  expect(after.entry).toMatchObject({ amount: -quoted, memo: expect.stringMatching(/^Neighborhood campaign at /) });
  // The button now waits for the campaign and its rest.
  await expect(run).toBeDisabled();
  await expect(area.locator('.customers-area-reason')).toHaveText('A campaign is already running there');
  await expect(area.locator('.customers-area-status')).toHaveText(/^A campaign runs here until [A-Z][a-z]{2} \d{1,2}, \d{4}\.$/);

  // Show me: the sheet closes and the map glides until the cabinet sits in the middle of the free map area.
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  const viewport = page.viewportSize()!;
  const from = { x: viewport.width / 2, y: viewport.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x - 260, from.y - 200, { steps: 3 });
  await page.mouse.up();
  const away = await nodeOnScreen(page, cabinet.node);
  expect(Math.abs(away.x - viewport.width / 2) > viewport.width / 6 || Math.abs(away.y - viewport.height / 2) > viewport.height / 6).toBe(true);
  await openCustomers(page);
  await area.getByRole('button', { name: /^Show me/ }).click();
  await expect(dialog).toBeHidden();
  await expect
    .poll(async () => {
      const p = await nodeOnScreen(page, cabinet.node);
      return Math.abs(p.x - viewport.width / 2) < viewport.width / 6 && Math.abs(p.y - viewport.height / 2) < viewport.height / 6;
    })
    .toBe(true);
  // Show me moves the map only: the game stays paused where it was.
  expect(await speedOf(page)).toBe('0');
  expect(errors).toEqual([]);
});

test('the dashboard fits a phone: one column, no horizontal scroll, full-size buttons', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/?seed=12345');
  await page.evaluate(() => window.__lst!.setSpeed(0));
  const hint = page.getByRole('button', { name: 'Got it' });
  if (await hint.isVisible()) await hint.click();
  await litTownWithCustomers(page, 120);
  const dialog = await openCustomers(page);
  const fits = () =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('dialog.customers .sheet-body')!;
      const box = document.querySelector<HTMLElement>('dialog.customers')!.getBoundingClientRect();
      return body.scrollWidth <= body.clientWidth && box.left >= 0 && box.right <= window.innerWidth && document.documentElement.scrollWidth <= window.innerWidth;
    });
  expect(await fits()).toBe(true);
  // Every section, scrolled into view in turn, fits; every visible button is a full touch target.
  for (const name of ['Growth', 'How happy they are', "Why homes haven't switched", 'Areas', 'Ways to grow']) {
    const section = dialog.getByRole('region', { name });
    await section.scrollIntoViewIfNeeded();
    await expect(section).toBeVisible();
    expect(await fits(), name).toBe(true);
  }
  const small = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('dialog.customers button')]
      .filter((b) => b.offsetParent !== null && b.getBoundingClientRect().height < 44)
      .map((b) => b.getAttribute('aria-label') ?? b.textContent),
  );
  expect(small).toEqual([]);
  // The support choices stack in one column.
  const lefts = await dialog.locator('.customers-choice').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().left)));
  expect(new Set(lefts).size).toBe(1);
  // Opening at the marketing lever scrolls it into view and focuses the budget.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Pricing' }).click();
  await page.getByRole('dialog', { name: 'Pricing', exact: true }).getByRole('button', { name: /Change marketing/ }).click();
  const budget = customersDialog(page).getByLabel('Marketing budget per month');
  await expect(budget).toBeFocused();
  await expect(budget).toBeInViewport();
  expect(await fits()).toBe(true);
  expect(errors).toEqual([]);
});
