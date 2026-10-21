// The pricing panel end to end: previewing and applying prices and
// marketing, a rejection, grandfathering a rise, the intro promo (moved here
// from economy.spec.ts in round 4b). Round 4b: who signs up (dropping the
// cheap tier warns that price-sensitive households won't), answering the
// cable company's promo with a retention offer, and when an intro promo pays.
//
// Owner: pricing-balance workstream (round 4b).

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  DEMAND_SEGMENTS,
  GRANDFATHER_MONTHS_DEFAULT,
  INCUMBENT_DOWN_MBPS,
  INCUMBENT_PRICE,
  INCUMBENT_PROMO_DISCOUNT,
  PROMO_QUOTE_MONTHS,
  RETENTION_PERCENT_OFF,
  PROMO_MAX_MONTHS,
  PROMO_MAX_PERCENT_OFF,
  TIER_DEFAULTS,
  TIER_PRICE_MAX,
  TIER_PRICE_MIN,
} from '../src/sim/balance';
import { closeDayAfter } from '../src/sim/sales';
import { open, routeFromCo, watchErrors } from './helpers';

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toLocaleString('en-US')}`;
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const moreMonths = (n: number) => `${n} more month${n === 1 ? '' : 's'}`;
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
  await expect(dialog.locator('.boost-hint')).not.toBeEmpty();

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

/** Light the best two streets out of the CO with a cabinet there, and run `days` days so homes sign up. */
async function litTownWithSubscribers(page: Page, days: number): Promise<void> {
  const route = await routeFromCo(page, 2);
  expect(route, 'a cable route out of the CO').not.toBeNull();
  const results = await page.evaluate(
    ({ segments, days }) => {
      const lst = window.__lst!;
      const co = lst.getState().city.coNode;
      const out = [lst.dispatch({ type: 'layCable', segments, method: 'underground' }), lst.dispatch({ type: 'placeCabinet', node: co })];
      lst.tick(days);
      return out;
    },
    { segments: route!.segments, days },
  );
  expect(results.map((r) => r.ok)).toEqual([true, true]);
}

test('a price rise is grandfathered: the preview says who keeps what until when, and they do', async ({ page }) => {
  // Headless Chromium draws WebGL in software, so each map redraw is slow here.
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await litTownWithSubscribers(page, 200);
  // The tier most of them took (round 4b: which one depends on who lives on the route).
  const before = await page.evaluate(() => {
    const s = window.__lst!.getState();
    const units = (id: string) => s.sales.accounts.reduce((n, a) => n + a.tierUnits[id as 'fiber1g'], 0);
    const tier = [...s.sales.pricing.tiers].sort((a, b) => units(b.id) - units(a.id))[0]!;
    return { id: tier.id, price: tier.price, name: tier.name, on1g: units(tier.id), day: s.day };
  });
  expect(before.on1g, `subscribers on ${before.name}`).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Pricing' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pricing & marketing' });
  await expect(dialog).toBeVisible();
  const months = dialog.getByLabel('Grandfathering months');
  await expect(months).toHaveValue(String(GRANDFATHER_MONTHS_DEFAULT));
  await expect(dialog.locator('.grandfather-hint')).toHaveText(new RegExp(`keep their price for ${GRANDFATHER_MONTHS_DEFAULT} months; 0 = from the next bill`));
  const impact = dialog.getByRole('region', { name: "Today's subscribers" });
  await expect(impact).toContainText("No change for today's subscribers.");

  // Raise it, grandfathered for 2 months: the preview names who keeps the old price and until when.
  const raised = before.price + 10;
  await dialog.getByLabel(`${before.name} price per month`).fill(String(raised));
  await months.fill('2');
  await expect(dialog.locator('.grandfather-hint')).toHaveText(/keep their price for 2 months/);
  const keep = new RegExp(`${before.on1g.toLocaleString('en-US')} subscribers? on ${before.name} keeps? ${escapeRe(money(before.price))}/mo until [A-Z][a-z]{2} 1, \\d{4}, then pays? ${escapeRe(money(raised))}/mo\\.`);
  await expect(impact.locator('.impact-lines')).toContainText(keep);
  await expect(impact.getByTestId('pricing-mrr-now')).toHaveText(/^\$[\d,]+\/mo$/);
  await expect(impact.getByTestId('pricing-mrr-after')).toHaveText(/^\$[\d,]+\/mo$/);
  await expect(impact.getByTestId('pricing-cancels')).toHaveText(/^~\d+$/);
  const mrr = await impact.getByTestId('pricing-mrr-now').textContent();
  const after = await impact.getByTestId('pricing-mrr-after').textContent();
  const dollars = (t: string | null) => Number((t ?? '').replace(/[^\d]/g, ''));
  expect(dollars(after)).toBeGreaterThan(dollars(mrr));

  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(toasts).toContainEqual(toast('ok', 'Pricing updated'));

  // Every subscriber on it keeps the old price until the close 2 closes after the next one.
  const locked = await page.evaluate((id) => {
    const s = window.__lst!.getState();
    return s.sales.accounts.filter((a) => a.tierUnits[id] > 0).map((a) => a.locks.find((l) => l.tier === id) ?? null);
  }, before.id);
  expect(locked.length).toBeGreaterThan(0);
  const untilDay = locked[0]!.untilDay;
  for (const lock of locked) expect(lock).toEqual({ tier: before.id, price: before.price, untilDay, reason: 'grandfather' });
  // The next close bills them the old price and keeps their locks.
  await tickToNextClose(page);
  const mid = await page.evaluate((id) => {
    const s = window.__lst!.getState();
    return { day: s.day, locks: s.sales.accounts.filter((a) => a.tierUnits[id] > 0 && a.locks.length > 0).length };
  }, before.id);
  expect(mid.day).toBeLessThan(untilDay);
  expect(mid.locks).toBeGreaterThan(0);
  // Once their lock's close has passed they pay the new price, and were told.
  await page.evaluate((until) => {
    const lst = window.__lst!;
    while (lst.getState().day < until && !lst.getState().gameOver) lst.tick(1);
  }, untilDay);
  const done = await page.evaluate(() => {
    const s = window.__lst!.getState();
    return {
      locks: s.sales.accounts.filter((a) => a.locks.some((l) => l.reason === 'grandfather')).length,
      stepped: s.notices.filter((n) => n.kind === 'priceStep').map((n) => n.message),
    };
  });
  expect(done.locks).toBe(0);
  expect(done.stepped.some((m) => /^Prices stepped up for [\d,]+ subscribers? whose grandfathered prices ended/.test(m))).toBe(true);
  expect(errors).toEqual([]);
});

test('an intro promo is set from the pricing panel and new signups get it', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await page.getByRole('button', { name: 'Got it' }).click();
  await litTownWithSubscribers(page, 30);

  await page.getByRole('button', { name: 'Pricing' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pricing & marketing' });
  await expect(dialog).toBeVisible();
  // Fits a phone: one column, nothing wider than the screen.
  const fits = () =>
    page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('dialog.pricing .sheet-body')!;
      const box = document.querySelector<HTMLElement>('dialog.pricing')!.getBoundingClientRect();
      return body.scrollWidth <= body.clientWidth && box.left >= 0 && box.right <= window.innerWidth;
    });
  expect(await fits()).toBe(true);
  const toggle = dialog.getByLabel('Intro promo for new subscribers');
  const percent = dialog.getByLabel('Intro promo percent off');
  const months = dialog.getByLabel('Intro promo months');
  await expect(toggle).not.toBeChecked();
  await expect(percent).toBeDisabled();
  await expect(dialog.locator('.promo-hint')).toHaveText('No intro promo: new subscribers pay the list price.');
  // Round 4b: even switched off, the panel says when the typed offer would pay.
  const advice = dialog.locator('.promo-advice');
  await expect(advice).toBeVisible();
  await expect(advice).toHaveText(/(Pays now|Doesn't pay|pays once you light new areas)/);
  const homes = dialog.locator('.take-rate').first().locator('dd');
  const plainTake = await homes.textContent();

  await toggle.check();
  await expect(percent).toBeEnabled();
  // The deepest, longest offer, so its lift shows in the whole-percent take rate.
  await percent.fill(String(PROMO_MAX_PERCENT_OFF));
  await months.fill(String(PROMO_MAX_MONTHS));
  await expect(dialog.locator('.promo-hint')).toContainText(
    `New subscribers get ${PROMO_MAX_PERCENT_OFF}% off for the rest of their first month and ${moreMonths(PROMO_MAX_MONTHS)}`,
  );
  // The offer lifts the target take rate, and the advice quotes it over the next months.
  await expect(homes).not.toHaveText(plainTake!);
  await expect(advice).toHaveText(/pays/i);
  await percent.scrollIntoViewIfNeeded();
  expect(await fits()).toBe(true);

  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(toasts).toContainEqual(toast('ok', `intro promo ${PROMO_MAX_PERCENT_OFF}% off for ${PROMO_MAX_MONTHS} month`));
  const applied = await page.evaluate(() => ({ promo: window.__lst!.getState().sales.promo, day: window.__lst!.getState().day }));
  expect(applied.promo).toEqual({ percentOff: PROMO_MAX_PERCENT_OFF, months: PROMO_MAX_MONTHS });

  // New accounts from here on carry the promo lock.
  await page.evaluate(() => window.__lst!.tick(60));
  const fresh = await page.evaluate((day) => {
    const s = window.__lst!.getState();
    return s.sales.accounts.filter((a) => a.since > day).map((a) => a.locks.map((l) => l.reason));
  }, applied.day);
  expect(fresh.length).toBeGreaterThan(0);
  for (const reasons of fresh) expect(reasons).toEqual(['promo']);

  // The panel reopens on the promo, and switching it off is applied too.
  await page.getByRole('button', { name: 'Pricing' }).click();
  await expect(toggle).toBeChecked();
  await expect(percent).toHaveValue(String(PROMO_MAX_PERCENT_OFF));
  await toggle.uncheck();
  await dialog.getByRole('button', { name: 'Apply' }).click();
  await expect.poll(toasts).toContainEqual(toast('ok', 'intro promo off'));
  expect(await page.evaluate(() => window.__lst!.getState().sales.promo)).toBeNull();
  expect(errors).toEqual([]);
});

test('dropping the cheap tier warns that price-sensitive households won\'t sign up', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await page.getByRole('button', { name: 'Pricing' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pricing & marketing' });
  await expect(dialog).toBeVisible();
  const who = dialog.getByRole('region', { name: 'Who signs up' });
  await expect(who).toBeVisible();
  const value = DEMAND_SEGMENTS.find((s) => s.id === 'value')!;
  const share = `${Math.round(value.share * 100)}%`;
  const limit = money(Math.round(value.maxPriceRatio * INCUMBENT_PRICE));
  // With the default lineup every segment finds a plan.
  await expect(who.locator('.segment-row')).toHaveCount(DEMAND_SEGMENTS.length);
  await expect(who.locator('.segment-out')).toHaveCount(0);
  await expect(who.locator('[data-segment="value"]')).toContainText(`Price-sensitive households (${share}):`);

  // Drop 500 Mbps: the cheapest plan is over what price-sensitive households pay.
  await dialog.getByLabel(`Offer ${TIER_DEFAULTS[0]!.name}`).uncheck();
  const warning = who.locator('.segment-out[data-segment="value"]');
  await expect(warning).toHaveText(new RegExp(`^Price-sensitive households \\(${share}\\): only \\d+% sign up: no plan at or under ${escapeRe(limit)}$`));
  // Drop 1 Gig too: they won't sign up at all.
  await dialog.getByLabel(`Offer ${TIER_DEFAULTS[1]!.name}`).uncheck();
  await expect(warning).toHaveText(`Price-sensitive households (${share}) won't sign up: no plan at or under ${limit}`);
  // Back to the full lineup: no warning.
  await dialog.getByLabel(`Offer ${TIER_DEFAULTS[0]!.name}`).check();
  await expect(who.locator('.segment-out')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('the cable company\'s promo is answered with a retention offer: its subscribers get retention locks', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await litTownWithSubscribers(page, 200);
  // A promo the cable company starts at the cabinet today, injected through the debug hook's state.
  const day = await page.evaluate(() => window.__lst!.getState().day);
  const endDay = closeDayAfter(day, 3);
  const injected = await page.evaluate(
    ({ endDay, quietUntil, price }) => {
      const s = window.__lst!.getState();
      const cabinet = s.network.cabinets[0]!.id;
      s.sales.incumbentPromos = [{ cabinet, startDay: s.day, endDay, price, quietUntil, triggerTakePct: 50, answered: false, answeredWithPromo: false }];
      return { cabinet, accounts: s.sales.accounts.filter((a) => a.cabinet === cabinet).length };
    },
    { endDay, quietUntil: closeDayAfter(endDay, 6), price: INCUMBENT_PRICE - INCUMBENT_PROMO_DISCOUNT },
  );
  expect(injected.accounts).toBeGreaterThan(0);

  await page.getByRole('button', { name: 'Pricing' }).click();
  const dialog = page.getByRole('dialog', { name: 'Pricing & marketing' });
  // With the area lit for months and households still waiting, the intro promo line quotes the typed offer.
  await expect(dialog.locator('.promo-advice')).toHaveText(new RegExp(`over the next ${PROMO_QUOTE_MONTHS} months: (about \\d+ more signups?|less than one more signup), \\$[\\d,]+ of margin against \\$[\\d,]+ of discounts\\.$`));
  await expect(dialog.locator('.promo-advice')).toHaveText(/pays/i);
  const rivals = dialog.getByRole('region', { name: 'Incumbent promos' });
  await expect(rivals).toBeVisible();
  await expect(rivals.locator('.retention-line')).toContainText(`Retention offer: ${RETENTION_PERCENT_OFF}% off for its`);
  await expect(rivals.locator('.retention-line')).toHaveText(/costs about \$[\d,]+ .* worth \$[\d,]+: it (pays|doesn't pay)\.$/);
  const answer = rivals.getByRole('button', { name: 'Answer with a retention offer' });
  await expect(answer).toBeEnabled();
  await answer.click();
  await expect(rivals.getByRole('button', { name: 'Answered' })).toBeDisabled();
  await expect(rivals.locator('.retention-line')).toContainText(`Answered: its subscribers pay ${RETENTION_PERCENT_OFF}% less until`);
  await expect.poll(toasts).toContainEqual(toast('ok', `Retention offer sent around`));

  const after = await page.evaluate((cabinet) => {
    const s = window.__lst!.getState();
    return {
      answered: s.sales.incumbentPromos[0]!.answered,
      locks: s.sales.accounts.filter((a) => a.cabinet === cabinet).map((a) => a.locks.map((l) => ({ reason: l.reason, untilDay: l.untilDay }))),
    };
  }, injected.cabinet);
  expect(after.answered).toBe(true);
  expect(after.locks.length).toBe(injected.accounts);
  for (const locks of after.locks) {
    expect(locks.length).toBeGreaterThan(0);
    for (const lock of locks) expect(lock).toEqual({ reason: 'retention', untilDay: endDay });
  }
  // A second answer is refused: the button stays Answered after reopening.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Pricing' }).click();
  await expect(rivals.getByRole('button', { name: 'Answered' })).toBeDisabled();
  expect(errors).toEqual([]);
});
