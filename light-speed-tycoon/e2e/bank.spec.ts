// The Bank end to end, round 4c/4d (spec H, "Bank C: health first"): the
// bank's health in one word and sentence, the two checks with their bars,
// Borrow more (amount chips, Other amount, the 5 or 7-year choice and a
// live preview in words), Pay back and Emergency cash opening in place,
// "What happens if I slip?" and the bank's messages. Every action stays
// covered: borrowing from a chip and from Other amount, the 7-year choice,
// taking and paying back emergency cash, paying a loan off early, the
// verified cure's button, the health stepping up to No more borrowing and a
// missed payment ending the game, the frozen line's sweep and countdown and
// then the called loans, the month's financing in the full books the report
// panel opens (round 4c/4d: the panel itself shows only the bank's word),
// the quote cards' cash-after and credit hints, and a phone-width pass with
// no sideways scrolling and comfortable touch targets.
//
// Conditions are set up through window.__lst the way economy.spec.ts does:
// closed months with revenue pushed into finance.reports give the town
// recurring revenue (and so credit); cash is set directly. Figures are checked
// against the sim's own functions (debt.ts) or balance.ts, never literals.
//
// Owner: ui-bank workstream.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { ACCELERATION_CLOSES, BANK_PREFILL_HEADROOM, FROZEN_ACCELERATION_CLOSES, LOAN_ROUNDING, TERM_LOAN_MIN } from '../src/sim/balance';
import { formatMonth } from '../src/sim/calendar';
import { closesUntilAcceleration, creditLimit, maxSafeTermLoan, quoteDraw, quoteTermLoan, termCapacity } from '../src/sim/debt';
import type { GameState } from '../src/sim/types';
import { nodeOnScreen, open, routeFromCo, watchErrors } from './helpers';

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const round = (n: number) => Math.floor(n / LOAN_ROUNDING) * LOAN_ROUNDING;

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

const state = (page: Page) => page.evaluate(() => window.__lst!.getState()) as Promise<GameState>;

/**
 * Test-only: three closed months, each billing `revenue` against `costs` of
 * running costs, so the town has recurring revenue (credit) and a cash flow
 * the bank can measure. A tick lets every panel see them.
 */
async function giveRevenue(page: Page, revenue: number, costs: number): Promise<void> {
  await page.evaluate(
    ({ revenue, costs }) => {
      const lst = window.__lst!;
      const s = lst.getState();
      for (let month = 10; month <= 12; month++) {
        // Quiet operations, as every round-4 close records them (the summary and the full books read the notice cursor from them).
        const ops = { lastNoticeId: s.nextNoticeId - 1, tierMoves: 0, priceChurn: 0, outageChurn: 0, incumbentChurn: 0, outageUnitDays: 0, storms: 0, spansDamaged: 0, repairs: 0, incumbentPromos: 0, mrr: revenue, outageCredits: 0, overhead: null };
        s.finance.reports.push({ year: 2026, month, totals: { revenue, overhead: -costs }, net: revenue - costs, cashEnd: s.finance.cash, passings: 0, ops });
      }
      lst.tick(1);
    },
    { revenue, costs },
  );
}

/** Tick until the next month close (or the end of the game). */
async function tickToNextClose(page: Page): Promise<void> {
  await page.evaluate(() => {
    const lst = window.__lst!;
    const reports = lst.getState().finance.reports.length;
    for (let i = 0; i < 40 && lst.getState().finance.reports.length === reports && !lst.getState().gameOver; i++) lst.tick(1);
  });
}

const bankButton = (page: Page) => page.getByRole('button', { name: 'Bank', exact: true });
const bankDialog = (page: Page) => page.getByRole('dialog', { name: 'Bank', exact: true });

const reportPanel = (page: Page) => page.getByRole('region', { name: 'Monthly report' });

/** The full books for the report panel's month, opened from the panel ("See the full books"; the panel opened first if it is collapsed). */
async function openBooksFromPanel(page: Page): Promise<Locator> {
  const panel = reportPanel(page);
  const toggle = panel.locator('.panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await panel.getByRole('button', { name: 'See the full books' }).click();
  const books = page.locator('dialog.briefing-books-only');
  await expect(books).toBeVisible();
  return books;
}

/** Open a disclosure (a <details>) by its summary, if it is closed. */
async function disclose(details: Locator): Promise<void> {
  if (!(await details.evaluate((d) => (d as HTMLDetailsElement).open))) await details.locator('summary').click();
  await expect(details).toHaveAttribute('open', '');
}

/** The chip amounts the builder offers for a largest safe amount (spec H.4: about a third, two thirds, all; rounded down; none under the minimum; no repeats). */
function chipAmounts(safe: number): number[] {
  const out: number[] = [];
  for (const amount of [round(safe / 3), round((safe * 2) / 3), round(safe)]) if (amount >= TERM_LOAN_MIN && !out.includes(amount)) out.push(amount);
  return out;
}

test('a fresh town has no credit: the Bank says why in plain words and offers no amounts', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await expect(page.getByTestId('hud-debt')).toBeHidden();
  await expect(page.getByTestId('hud-covenant')).toBeHidden();
  const company = (await state(page)).company.name;

  await bankButton(page).click();
  const bank = bankDialog(page);
  await expect(bank).toBeVisible();
  await expect(bank.locator('.sheet-title')).toHaveText(`The Bank · ${company}`);
  await expect(bank.getByTestId('bank-health-title')).toHaveText('Bank health: Good');
  await expect(bank.getByTestId('bank-health-sentence')).toHaveText('No loans yet.');
  await expect(bank.getByTestId('bank-health')).toHaveAttribute('data-level', 'good');
  // With no debt the checks read as passed / not needed.
  await expect(bank.getByTestId('bank-check-debt')).toContainText('You owe nothing, so this check passes.');
  await expect(bank.getByTestId('bank-check-coverage')).toContainText('No loan payments yet.');
  await expect(bank.getByTestId('bank-cure')).toBeHidden();
  // Borrow more: one plain sentence instead of chips, and no borrow button.
  await expect(bank.getByTestId('bank-borrow-why')).toHaveText('The bank lends once customers are paying you: sign up customers first.');
  await expect(bank.getByTestId('bank-chip-0')).toBeHidden();
  await expect(bank.getByTestId('bank-chip-other')).toBeHidden();
  await expect(bank.getByTestId('bank-borrow')).toBeHidden();
  // Emergency cash opens in place, says why there is none, and offers nothing to take.
  await bank.getByTestId('bank-credit-toggle').click();
  await expect(bank.getByTestId('bank-credit-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(bank.getByTestId('bank-credit-why')).toContainText('No emergency cash yet');
  await expect(bank.getByLabel('Amount to take')).toBeHidden();
  // One section open at a time: Pay back replaces it.
  await bank.getByTestId('bank-payback-toggle').click();
  await expect(bank.getByTestId('bank-credit')).toBeHidden();
  await expect(bank.getByTestId('bank-payback')).toContainText('No loans to pay back.');
  // Good standing: the slip ladder stays shut, nothing marked; no messages yet.
  const slip = bank.getByTestId('bank-slip');
  await expect(slip).not.toHaveAttribute('open', '');
  await expect(slip.locator('[aria-current="step"]')).toHaveCount(0);
  await expect(bank.getByTestId('bank-messages')).toBeHidden();

  await page.keyboard.press('Escape');
  await expect(bank).toBeHidden();
  await expect(bankButton(page)).toBeFocused();
  expect(errors).toEqual([]);
});

test('takes and pays back emergency cash with previews in words; the debt chip appears and the report shows it at the close', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await giveRevenue(page, 40_000, 20_000);
  const limit = creditLimit(await state(page));
  expect(limit).toBeGreaterThan(2 * LOAN_ROUNDING);

  await bankButton(page).click();
  const bank = bankDialog(page);
  await bank.getByTestId('bank-credit-toggle').click();
  const credit = bank.getByTestId('bank-credit');
  await expect(credit.getByTestId('bank-credit-summary')).toHaveText(`Borrow and repay any time, up to ${money(limit)}. Using now: $0.`);
  await expect(credit.getByTestId('bank-credit-rate')).toHaveText(/^It costs [\d.]+% a year on what you use, charged at each month close\.$/);

  // More than it allows: the preview says so plainly and the button stays off.
  const amount = credit.getByLabel('Amount to take');
  await amount.fill(String(limit + 1));
  await expect(credit.getByTestId('bank-draw-preview')).toHaveText(`You can take up to ${money(limit)} now.`);
  await expect(credit.getByTestId('bank-draw')).toBeDisabled();
  expect((await state(page)).debt.credit.balance).toBe(0);

  // Half of it, from the preset: the preview words what it does to the bank's health.
  const half = Math.floor(limit / 2);
  const before = await state(page);
  const quote = quoteDraw(before, half);
  await credit.getByRole('button', { name: 'Half', exact: true }).click();
  await expect(amount).toHaveValue(String(half));
  const preview = credit.getByTestId('bank-draw-preview');
  await expect(preview).toContainText(`If you take ${money(half)}: still Good.`);
  await expect(preview).toContainText('Debt becomes');
  await expect(preview).toContainText(`About ${money(quote.interestToClose)} of interest if you keep it to the month end.`);
  await expect(preview).toHaveClass(/is-ok/);
  await expect(credit.getByTestId('bank-draw')).toHaveText(`Take ${money(half)}`);
  await credit.getByTestId('bank-draw').click();
  await expect.poll(toasts).toContainEqual(toast('ok', `Took ${money(half)} of emergency cash`));
  let after = await state(page);
  expect(after.debt.credit.balance).toBe(half);
  expect(after.finance.cash).toBe(before.finance.cash + half);
  await expect(credit.getByTestId('bank-credit-summary')).toHaveText(`Borrow and repay any time, up to ${money(limit)}. Using now: ${money(half)}.`);
  await expect(bank.getByTestId('bank-check-coverage')).toContainText('for every $1 of loan payments');

  // Pay part of it back from the same section, with its own preview.
  const back = LOAN_ROUNDING;
  await expect(credit.getByTestId('bank-repay-head')).toHaveText(`You're using ${money(half)} of emergency cash.`);
  await credit.getByLabel('Amount to repay').fill(String(back));
  await expect(credit.getByTestId('bank-repay-preview')).toContainText(`If you pay back ${money(back)}: still Good.`);
  await credit.getByTestId('bank-repay').click();
  await expect.poll(toasts).toContainEqual(toast('ok', `Paid back ${money(back)} of emergency cash`));
  after = await state(page);
  expect(after.debt.credit.balance).toBe(half - back);
  // The pay-back form follows to Pay back, which lists the emergency cash used.
  await bank.getByTestId('bank-payback-toggle').click();
  await expect(bank.getByTestId('bank-payback').getByTestId('bank-repay-head')).toHaveText(`You're using ${money(half - back)} of emergency cash.`);

  // The clock runs behind the sheet: figures refresh in place, a typed amount and focus survive.
  await bank.getByTestId('bank-chip-other').click();
  const termAmount = bank.getByLabel('Amount to borrow');
  await expect(termAmount).toBeFocused();
  await termAmount.fill(String(TERM_LOAN_MIN));
  await page.evaluate(() => window.__lst!.setSpeed(4));
  await expect.poll(async () => (await state(page)).day, { timeout: 10_000 }).toBeGreaterThan(after.day + 2);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await expect(termAmount).toBeFocused();
  await expect(termAmount).toHaveValue(String(TERM_LOAN_MIN));
  await expect(bank.getByTestId('bank-chip-other')).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Escape');
  await expect(bank).toBeHidden();
  const chip = page.getByTestId('hud-debt');
  await expect(chip).toHaveText(`Debt ${money(half - back)}`);
  await expect(chip).toHaveAttribute('title', /emergency cash/);
  await expect(page.getByTestId('hud-cash')).toHaveText(money((await state(page)).finance.cash));
  // The chip opens the Bank too.
  await chip.click();
  await expect(bank).toBeVisible();
  await page.keyboard.press('Escape');

  // The month close charges interest on the line; the full books the report panel opens show the month's financing.
  await tickToNextClose(page);
  const report = (await state(page)).finance.reports.at(-1)!;
  expect(report.debt).toBeDefined();
  expect(report.totals.interest ?? 0).toBeLessThan(0);
  // The panel says the bank's health in the Bank's own word, and the word opens the Bank.
  const word = reportPanel(page).getByTestId('panel-bank');
  await expect(word).toHaveText('Bank: Good');
  await word.click();
  await expect(bank).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(bank).toBeHidden();
  const books = await openBooksFromPanel(page);
  await expect(books.locator('.briefing-line[data-key="interest"] dd')).toHaveText(money(-(report.totals.interest ?? 0)));
  await expect(books.locator('.briefing-lines-in .briefing-line[data-key="borrowed"] dd')).toHaveText(money(half));
  await expect(books.locator('.briefing-line[data-key="principal"] dd')).toHaveText(money(back));
  await expect(books.locator('.briefing-figure[data-key="debt"] dd')).toHaveText(money(report.debt!.creditBalance + report.debt!.termBalance));
  await expect(books.locator('.briefing-figure[data-key="leverage"]')).toContainText('limit');
  await expect(books.locator('.briefing-figure[data-key="coverage"]')).toContainText('min');
  await books.locator('.briefing-close').click();
  await expect(books).toBeHidden();
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  /** Nothing in the open Bank is wider than the screen: no sideways scrolling anywhere. */
  async function fits(page: Page): Promise<void> {
    const fit = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('dialog.bank .sheet-body')!;
      const dialog = document.querySelector<HTMLElement>('dialog.bank')!.getBoundingClientRect();
      let widest = 0;
      for (const el of body.querySelectorAll<HTMLElement>('*')) {
        const r = el.getBoundingClientRect();
        if (r.width > 0) widest = Math.max(widest, r.right);
      }
      return {
        scrollW: body.scrollWidth,
        clientW: body.clientWidth,
        page: document.documentElement.scrollWidth - window.innerWidth,
        left: dialog.left,
        right: dialog.right,
        widest,
      };
    });
    expect(fit.scrollW).toBeLessThanOrEqual(fit.clientW);
    expect(fit.page).toBeLessThanOrEqual(0);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(390);
    expect(fit.widest).toBeLessThanOrEqual(fit.right + 0.5);
  }

  test('borrows over 7 years from a chip, pays part off early, and sees it in the report, all without sideways scrolling', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = watchErrors(page);
    await open(page, '/?seed=12345');
    const toasts = await recordToasts(page);
    await page.getByRole('button', { name: 'Got it' }).tap();
    await giveRevenue(page, 40_000, 20_000);
    const s = await state(page);
    const chips7 = chipAmounts(maxSafeTermLoan(s, 7, BANK_PREFILL_HEADROOM));
    expect(chips7.length).toBe(3);

    await bankButton(page).tap();
    const bank = bankDialog(page);
    await expect(bank).toBeVisible();
    await fits(page);
    const scroll = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('dialog.bank .sheet-body')!;
      return { scrollH: body.scrollHeight, clientH: body.clientHeight };
    });
    expect(scroll.scrollH).toBeGreaterThan(scroll.clientH);

    // The 7-year choice: the chips follow its amounts.
    const term = bank.getByTestId('bank-term');
    const seven = term.getByRole('radio', { name: '7 years' });
    await seven.scrollIntoViewIfNeeded();
    await seven.tap();
    await expect(seven).toHaveAttribute('aria-checked', 'true');
    await expect(term.getByRole('radio', { name: '5 years' })).toHaveAttribute('aria-checked', 'false');
    for (const [i, amount] of chips7.entries()) await expect(bank.getByTestId(`bank-chip-${i}`)).toHaveText(money(amount));
    // The largest safe chip is where the builder starts.
    await expect(bank.getByTestId('bank-chip-2')).toHaveAttribute('aria-pressed', 'true');
    // The chips wrap inside the screen.
    for (const id of ['bank-chip-0', 'bank-chip-1', 'bank-chip-2', 'bank-chip-other']) {
      const box = (await bank.getByTestId(id).boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
    }

    // About a third: the preview and the button follow.
    const third = chips7[0]!;
    const chip = bank.getByTestId('bank-chip-0');
    await chip.tap();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(bank.getByTestId('bank-chip-2')).toHaveAttribute('aria-pressed', 'false');
    const borrow = bank.getByTestId('bank-borrow');
    await expect(borrow).toHaveText(`Borrow ${money(third)}`);
    const preview = bank.getByTestId('bank-term-preview');
    await expect(preview).toContainText(`If you borrow ${money(third)}: still Good.`);
    await expect(preview).toContainText(`${money(quoteTermLoan(s, third, 7).payment)} a month for 7 years at`);

    // Every control is a comfortable touch target.
    for (const control of [seven, borrow, chip, bank.getByTestId('bank-chip-other'), bank.getByTestId('bank-payback-toggle'), bank.getByTestId('bank-credit-toggle')]) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const cash = s.finance.cash;
    await borrow.scrollIntoViewIfNeeded();
    await borrow.tap();
    await expect.poll(toasts).toContainEqual(toast('ok', `Borrowed ${money(third)} over 7 years`));
    let now = await state(page);
    expect(now.debt.loans).toHaveLength(1);
    const loan = now.debt.loans[0]!;
    expect(loan).toMatchObject({ principal: third, balance: third, termMonths: 84 });
    expect(now.finance.cash).toBe(cash + third);

    // Pay back: the loan as one row.
    await bank.getByTestId('bank-payback-toggle').tap();
    const row = bank.locator(`[data-loan="${loan.id}"]`);
    await expect(row.getByTestId(`bank-loan-${loan.id}`)).toHaveText(new RegExp(`^Loan ${loan.id}: \\${money(third)} left · \\$[\\d,]+ a month · 84 months left$`));
    await expect(row).toContainText('7-year loan at');
    await expect(row).toContainText("This month's payment is interest only");
    await expect(bank.getByTestId(`bank-loan-${loan.id}-balance`)).toHaveText(money(third));

    // A few days on (interest builds), pay part of it off early: the preview says what it takes and does.
    await page.evaluate(() => window.__lst!.tick(3));
    await row.getByTestId(`bank-prepay-open-${loan.id}`).tap();
    const prepayAmount = row.getByLabel(`Amount to pay off loan ${loan.id}`);
    await expect(prepayAmount).toHaveValue(String(third));
    await expect(row.getByTestId(`bank-prepay-preview-${loan.id}`)).toContainText('If you pay it off:');
    await expect(row.getByTestId(`bank-prepay-${loan.id}`)).toHaveText(/^Pay off for \$[\d,]+$/);
    await fits(page);
    const part = TERM_LOAN_MIN;
    await prepayAmount.fill(String(part));
    await expect(row.getByTestId(`bank-prepay-preview-${loan.id}`)).toContainText(`If you pay ${money(part)} off early: still Good.`);
    await expect(row.getByTestId(`bank-prepay-preview-${loan.id}`)).toContainText('of interest so far');
    await row.getByTestId(`bank-prepay-${loan.id}`).tap();
    await expect.poll(toasts).toContainEqual(toast('ok', `Paid ${money(part)} off loan ${loan.id}`));
    now = await state(page);
    expect(now.debt.loans[0]!.balance).toBe(third - part);
    await expect(bank.getByTestId(`bank-loan-${loan.id}-balance`)).toHaveText(money(third - part));
    await expect(page.getByTestId('hud-debt')).toHaveText(`Debt ${money(third - part)}`);

    // Emergency cash and the slip ladder fit too.
    await bank.getByTestId('bank-credit-toggle').tap();
    await disclose(bank.getByTestId('bank-slip'));
    await disclose(bank.getByTestId('bank-figures'));
    await fits(page);

    // The month close: interest (the loan's first, interest-only payment), the prepaid principal, debt at month end.
    await page.keyboard.press('Escape');
    await expect(bank).toBeHidden();
    await tickToNextClose(page);
    const report = (await state(page)).finance.reports.at(-1)!;
    expect(report.totals.interest ?? 0).toBeLessThan(0);
    expect(report.totals.principal).toBe(-part);
    const books = await openBooksFromPanel(page);
    await expect(books.locator('.briefing-line[data-key="interest"] dd')).toHaveText(money(-(report.totals.interest ?? 0)));
    await expect(books.locator('.briefing-line[data-key="principal"] dd')).toHaveText(money(part));
    await expect(books.locator('.briefing-lines-in .briefing-line[data-key="borrowed"] dd')).toHaveText(money(third));
    await expect(books.locator('.briefing-figure[data-key="debt"] dd')).toHaveText(money(report.debt!.creditBalance + report.debt!.termBalance));
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    await books.locator('.briefing-close').tap();
    await expect(books).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('a frozen line fits a phone too', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, '/?seed=12345');
    await giveRevenue(page, 40_000, 20_000);
    await page.evaluate(() => {
      const s = window.__lst!.getState();
      s.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
      s.debt.credit.balance = 150_000;
      s.debt.frozenCloses = 2;
      window.__lst!.tick(1);
    });
    await page.getByTestId('hud-covenant').tap();
    const bank = bankDialog(page);
    await expect(bank.getByTestId('bank-frozen')).toBeVisible();
    await expect(bank.getByTestId('bank-slip')).toHaveAttribute('open', '');
    await bank.getByTestId('bank-credit-toggle').tap();
    await fits(page);
    expect(errors).toEqual([]);
  });
});

test('at laptop widths the HUD stays on screen with every bank chip: Pause, Menu and the whole chip in view', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = watchErrors(page);
  await page.setViewportSize({ width: 1366, height: 900 });
  await open(page, '/?seed=12345');
  // Every chip the HUD can show at once: lit homes (so cost per home), building in progress, debt and the bank's word.
  const route = await routeFromCo(page, 2);
  expect(route, 'a cable route out of the CO').not.toBeNull();
  await page.evaluate((segments) => {
    const lst = window.__lst!;
    lst.dispatch({ type: 'layCable', segments, method: 'underground' });
    lst.dispatch({ type: 'placeCabinet', node: lst.getState().city.coNode });
    lst.tick(120);
    // More cable in progress (the building chip): the first unbuilt street out of the CO's neighbors that takes an order.
    const s = lst.getState();
    const built = new Set(s.network.spans.map((sp) => sp.segment));
    for (const seg of s.city.segments) {
      if (built.has(seg.id)) continue;
      if (lst.dispatch({ type: 'layCable', segments: [seg.id], method: 'underground' }).ok) break;
    }
  }, route!.segments);
  await giveRevenue(page, 40_000, 20_000);
  const chip = page.getByTestId('hud-covenant');
  const cases: { stage: 'penalty' | 'frozen'; text: RegExp }[] = [
    { stage: 'penalty', text: /^Bank: Higher interest$/ },
    { stage: 'frozen', text: /^Bank: No more borrowing: \d+ months to call$/ },
  ];
  for (const c of cases) {
    await page.evaluate((stage) => {
      const s = window.__lst!.getState();
      s.debt.covenant = { stage, compliantCloses: 0 };
      s.debt.credit.balance = 150_000;
      s.debt.frozenCloses = stage === 'frozen' ? 1 : 0;
      window.__lst!.tick(1);
    }, c.stage);
    await expect(page.getByTestId('hud-debt')).toBeVisible();
    await expect(page.locator('.chip-building')).toBeVisible();
    for (const width of [1180, 1280, 1366]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(chip).toBeVisible();
      if (width > 1100) await expect(chip).toHaveText(c.text);
      const box = await page.evaluate(() => {
        const rect = (el: Element | null) => el!.getBoundingClientRect();
        const pause = rect(document.querySelector('.speed[data-speed="0"]'));
        const menu = rect(document.querySelector('.menu-button'));
        const covenant = document.querySelector<HTMLElement>('[data-testid="hud-covenant"]')!;
        const chipBox = rect(covenant);
        const stats = rect(document.querySelector('.hud-stats'));
        return {
          width: window.innerWidth,
          pauseLeft: pause.left,
          menuRight: menu.right,
          chipLeft: chipBox.left,
          chipRight: chipBox.right,
          chipClipped: covenant.scrollWidth > covenant.clientWidth + 1,
          statsLeft: stats.left,
          statsRight: stats.right,
        };
      });
      const where = `${c.stage} at ${width}px`;
      expect(box.pauseLeft, where).toBeGreaterThanOrEqual(0);
      expect(box.menuRight, where).toBeLessThanOrEqual(box.width);
      expect(box.chipLeft, where).toBeGreaterThanOrEqual(0);
      expect(box.chipRight, where).toBeLessThanOrEqual(box.width);
      expect(box.chipClipped, where).toBe(false);
      expect(box.statsLeft, where).toBeGreaterThanOrEqual(0);
      expect(box.statsRight, where).toBeLessThanOrEqual(box.width);
      // Pause still takes a click.
      await page.locator('.speed[data-speed="0"]').click();
    }
  }
  expect(errors).toEqual([]);
});

test('the verified cure leads when a check fails, and its button cures it', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await giveRevenue(page, 40_000, 20_000);
  // A loan, then (test-only) a cash-flow history that cannot carry it: failing both checks while in good standing.
  await page.evaluate(
    ({ min }) => {
      const lst = window.__lst!;
      lst.dispatch({ type: 'takeTermLoan', amount: min * 2, termYears: 5 });
      for (const report of lst.getState().finance.reports) {
        report.totals = { revenue: 100, overhead: -30_000 };
        report.net = 100 - 30_000;
      }
      lst.tick(1);
    },
    { min: TERM_LOAN_MIN },
  );
  const chip = page.getByTestId('hud-covenant');
  await expect(chip).toHaveText('Bank: Watch');
  await chip.click();
  const bank = bankDialog(page);
  await expect(bank.getByTestId('bank-health-title')).toHaveText('Bank health: Watch');
  await expect(bank.getByTestId('bank-health-sentence')).toHaveText("At today's figures you'd fail a check at the next month close.");
  await expect(bank.getByTestId('bank-check-debt')).toHaveAttribute('data-status', 'over');
  await expect(bank.getByTestId('bank-check-debt-status')).toHaveText("Over the bank's limit");
  // Not Good: the slip ladder opens by itself.
  await expect(bank.getByTestId('bank-slip')).toHaveAttribute('open', '');
  const cure = bank.getByTestId('bank-cure');
  await expect(cure).toBeVisible();
  await expect(cure.getByTestId('bank-cure-text')).toHaveText(/^To pass both checks again, /);
  const action = cure.getByTestId('bank-cure-action');
  const label = (await action.textContent()) ?? '';
  expect(label).toMatch(/^Pay /);
  await action.click();
  await expect.poll(toasts).toContainEqual(toast('ok', label.replace(/^Pay back /, 'Paid back ').replace(/^Pay /, 'Paid ')));
  await expect(bank.getByTestId('bank-health-title')).toHaveText('Bank health: Good');
  await expect(cure).toBeHidden();
  await expect(chip).toBeHidden();
  expect(errors).toEqual([]);
});

test('the health steps up from Watch to Warning, Higher interest and No more borrowing, and a payment missed then ends the game', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  const company = (await state(page)).company.name;
  await giveRevenue(page, 40_000, 20_000);
  // Borrow, then (test-only) rewrite the months it lent against into a cash-flow history that cannot carry the debt.
  const result = await page.evaluate(
    ({ min }) => {
      const lst = window.__lst!;
      const r = lst.dispatch({ type: 'takeTermLoan', amount: min * 4, termYears: 5 });
      for (const report of lst.getState().finance.reports) {
        report.totals = { revenue: 100, overhead: -30_000 };
        report.net = 100 - 30_000;
      }
      return r;
    },
    { min: TERM_LOAN_MIN },
  );
  expect(result.ok).toBe(true);
  // Still in good standing, but at today's figures it fails the checks: the HUD warns ahead of the close, in the Bank's words.
  const chip = page.getByTestId('hud-covenant');
  await expect(chip).toHaveText('Bank: Watch');
  await expect(chip).toHaveClass(/chip-warn/);
  await expect(chip).toHaveAttribute('title', /^Bank health: Watch\. /);
  expect((await state(page)).debt.covenant.stage).toBe('compliant');

  const notice = async (kind: string) => {
    const found = (await state(page)).notices.find((n) => n.kind === kind);
    expect(found, `a ${kind} notice`).toBeDefined();
    return found!.message;
  };

  await tickToNextClose(page);
  await expect(chip).toHaveText('Bank: Warning');
  await expect(chip).toHaveClass(/chip-warn/);
  expect((await state(page)).debt.covenant.stage).toBe('warning');
  await expect.poll(toasts).toContainEqual(toast('warn', await notice('covenantWarning')));

  await tickToNextClose(page);
  await expect(chip).toHaveText('Bank: Higher interest');
  await expect(chip).toHaveClass(/chip-danger/);
  await expect.poll(toasts).toContainEqual(toast('warn', await notice('covenantPenalty')));

  await tickToNextClose(page);
  // No more borrowing: the chip counts the months left before the bank asks for every loan back.
  await expect(chip).toHaveText(`Bank: No more borrowing: ${FROZEN_ACCELERATION_CLOSES - 1} months to call`);
  await expect(chip).toHaveClass(/chip-danger/);
  expect((await state(page)).debt.covenant.stage).toBe('frozen');
  await expect.poll(toasts).toContainEqual(toast('err', await notice('creditFrozen')));

  // The chip opens the Bank: its health in the same words, nothing to borrow or take, the ladder at its step.
  await chip.click();
  const bank = bankDialog(page);
  await expect(bank.getByTestId('bank-health-title')).toHaveText('Bank health: No more borrowing');
  await expect(bank.getByTestId('bank-health-sentence')).toContainText(`asks for every loan back in ${FROZEN_ACCELERATION_CLOSES - 1} months`);
  await expect(bank.getByTestId('bank-health')).toHaveAttribute('data-level', 'frozen');
  const slip = bank.getByTestId('bank-slip');
  await expect(slip).toHaveAttribute('open', '');
  await expect(slip.locator('[aria-current="step"]')).toHaveAttribute('data-step', 'frozen');
  await expect(slip.getByTestId('bank-missed-rule')).toHaveText("If you can't make a payment, borrowing stops at once and you pay a late fee.");
  await expect(bank.getByTestId('bank-borrow-why')).toContainText('No more borrowing for now');
  await expect(bank.getByTestId('bank-borrow')).toBeHidden();
  await bank.getByTestId('bank-credit-toggle').click();
  await expect(bank.getByTestId('bank-credit-why')).toContainText('No emergency cash while the bank has stopped lending');
  await expect(bank.getByLabel('Amount to take')).toBeHidden();
  // The higher interest is one tap away, in how the rate is set.
  const lineRate = bank.getByTestId('bank-credit-rate-details');
  await disclose(lineRate);
  await expect(lineRate.locator('.rate-penalty')).toBeVisible();
  // The bank's messages, newest first, collapsed until asked for.
  const messages = bank.getByTestId('bank-messages');
  await expect(messages).not.toHaveAttribute('open', '');
  await expect(messages.locator('summary')).toHaveText(/^Bank messages \(\d+\)$/);
  await disclose(messages);
  await expect(bank.getByTestId('bank-notice-list').locator('li').first()).toContainText(await notice('creditFrozen'));
  await expect(bank.getByTestId('bank-notice-list')).toContainText(await notice('covenantWarning'));
  // What the bank counts: the cash projected at the close beside the next payment.
  await disclose(bank.getByTestId('bank-figures'));
  await expect(bank.getByTestId('bank-fig-cash-at-the-close')).toHaveText(/^≈ -?\$[\d,]+$/);

  // Test-only: no cash for the next payment. The close defaults; the Bank closes for the game-over dialog.
  await page.evaluate(() => {
    window.__lst!.getState().finance.cash = 0;
  });
  await tickToNextClose(page);
  expect((await state(page)).gameOver).toMatchObject({ reason: 'default' });
  const over = page.getByRole('dialog', { name: 'Game over' });
  await expect(over).toBeVisible();
  await expect(bank).toBeHidden();
  await expect(over).toContainText(`${company} has defaulted on its loans.`);
  await expect(page.getByTestId('hud-insolvency')).toHaveText('Game over: loan default');
  expect(errors).toEqual([]);
});

test('a quote card shows the cash an order leaves, and the credit line when cash is short', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await page.getByRole('button', { name: 'Got it' }).click();
  await giveRevenue(page, 40_000, 20_000);
  const route = await routeFromCo(page, 1);
  expect(route, 'a corner on open map next to the CO').not.toBeNull();
  const corner = route!.nodes[1]!;

  await page.keyboard.press('c');
  const p = await nodeOnScreen(page, corner);
  await page.mouse.move(p.x, p.y);
  const card = page.locator('.float-card');
  await expect(card).toContainText('Cash after');
  await expect(card.locator('.card-credit')).toHaveCount(0);

  // Test-only: short of cash. The card goes red and offers the credit line.
  await page.evaluate(() => {
    window.__lst!.getState().finance.cash = 1;
    window.__lst!.tick(1);
  });
  await page.mouse.move(p.x + 1, p.y + 1);
  // The hint keeps a cash cushion (a month of costs and the next loan payment): never a draw that leaves about $0.
  await expect(card.locator('.card-credit')).toHaveText(/^Draw \$[\d,]+ from your credit line to afford it and keep a \$[\d,]+ cushion$/);
  await expect(card.locator('.tone-negative')).toHaveText(/^-\$[\d,]+$/);
  expect(errors).toEqual([]);
});

test('the Bank leads with health, starts at the largest safe chip, and previews borrowing from Other amount, over the limit included', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  // Thin cash flow on healthy revenue: the bank lends a lot, but not all of it keeps the checks.
  await giveRevenue(page, 40_000, 36_000);
  const s = await state(page);
  const safe5 = maxSafeTermLoan(s, 5);
  const capacity = termCapacity(s);
  expect(safe5).toBeGreaterThanOrEqual(TERM_LOAN_MIN);
  expect(safe5).toBeLessThan(capacity);

  await bankButton(page).click();
  const bank = bankDialog(page);
  await expect(bank.locator('.sheet-title')).toHaveText(`The Bank · ${s.company.name}`);
  // Health first, then the two checks, then Borrow more.
  const top = async (id: string) => (await bank.getByTestId(id).boundingBox())!.y;
  expect(await top('bank-health')).toBeLessThan(await top('bank-checks'));
  expect(await top('bank-checks')).toBeLessThan(await top('bank-term'));
  await expect(bank.getByTestId('bank-health-title')).toHaveText('Bank health: Good');
  await expect(bank.getByTestId('bank-check-debt')).toContainText("You owe nothing");
  // The first view carries no jargon.
  for (const id of ['bank-health', 'bank-checks', 'bank-term']) {
    const text = await bank.getByTestId(id).evaluate((el) => {
      const clone = el.cloneNode(true) as HTMLElement;
      for (const d of clone.querySelectorAll('details')) d.remove();
      return clone.innerText;
    });
    expect(text).not.toMatch(/leverage|covenant|DSCR|ARR|×/i);
  }

  // The builder starts at the largest chip: BANK_PREFILL_HEADROOM inside the limits.
  const start = (years: 5 | 7) => maxSafeTermLoan(s, years, BANK_PREFILL_HEADROOM);
  const chips5 = chipAmounts(start(5));
  expect(chips5.at(-1)).toBe(start(5));
  const safeChip = bank.getByTestId(`bank-chip-${chips5.length - 1}`);
  await expect(safeChip).toHaveText(money(start(5)));
  await expect(safeChip).toHaveAttribute('aria-pressed', 'true');
  await expect(bank.getByLabel('Amount to borrow')).toBeHidden();
  await expect(bank.getByTestId('bank-term-preview')).toContainText(`If you borrow ${money(start(5))}: still Good.`);
  await expect(bank.getByTestId('bank-borrow')).toHaveText(`Borrow ${money(start(5))}`);
  // The exact largest safe amount and the rate's parts are one tap away.
  const rate = bank.getByTestId('bank-rate-details');
  await disclose(rate);
  await expect(bank.getByTestId('bank-term-details')).toContainText(`The most you can borrow over 5 years and still pass both checks: ${money(safe5)}.`);
  await expect(rate.locator('[data-rate="base"]')).toBeVisible();

  // The 7-year term has its own amounts; the builder follows them until the player picks one.
  await bank.getByRole('radio', { name: '7 years' }).click();
  const chips7 = chipAmounts(start(7));
  await expect(bank.getByTestId(`bank-chip-${chips7.length - 1}`)).toHaveText(money(start(7)));
  await expect(bank.getByTestId(`bank-chip-${chips7.length - 1}`)).toHaveAttribute('aria-pressed', 'true');
  await expect(bank.getByTestId('bank-term-details')).toContainText(`over 7 years and still pass both checks: ${money(maxSafeTermLoan(s, 7))}`);

  // Other amount: all the bank will lend is one tap away, with the over-the-limit words.
  await bank.getByTestId('bank-chip-other').click();
  const amount = bank.getByLabel('Amount to borrow');
  await expect(amount).toBeVisible();
  await expect(amount).toBeFocused();
  await expect(amount).toHaveAttribute('max', String(capacity));
  await amount.fill(String(capacity));
  const preview = bank.getByTestId('bank-term-preview');
  await expect(preview).toHaveClass(/is-danger/);
  await expect(preview).toContainText(`If you borrow ${money(capacity)}: this would put you over the bank's limit: you'd get a warning at the next month close.`);
  await expect(bank.getByTestId('bank-borrow')).toBeEnabled();
  // More than the bank lends: said plainly, and the button is off.
  await amount.fill(String(capacity + LOAN_ROUNDING));
  await expect(preview).toHaveText(`The most the bank will lend now is ${money(capacity)}.`);
  await expect(bank.getByTestId('bank-borrow')).toBeDisabled();

  // Borrow a typed amount over 7 years.
  const typed = 2 * TERM_LOAN_MIN;
  await amount.fill(String(typed));
  await expect(preview).toContainText(`If you borrow ${money(typed)}: still Good.`);
  await bank.getByTestId('bank-borrow').click();
  await expect.poll(toasts).toContainEqual(toast('ok', `Borrowed ${money(typed)} over 7 years`));
  const after = await state(page);
  expect(after.debt.loans.at(-1)).toMatchObject({ principal: typed, termMonths: 84 });
  // The builder starts again at the largest chip, and names same-month re-pricing only when it applies.
  const next7 = chipAmounts(start(7) === 0 ? 0 : maxSafeTermLoan(after, 7, BANK_PREFILL_HEADROOM));
  if (next7.length > 0) {
    await expect(bank.getByTestId(`bank-chip-${next7.length - 1}`)).toHaveAttribute('aria-pressed', 'true');
    const repriced = quoteTermLoan(after, next7.at(-1)!, 7).repriced.length > 0;
    const lines = bank.getByTestId('bank-term-repriced');
    if (repriced) await expect(lines).toContainText(/^Loan \d+, taken this month, would go from/);
    else await expect(lines).toBeHidden();
  }

  // Emergency cash previews its effect before anything is taken.
  await bank.getByTestId('bank-credit-toggle').click();
  const take = Math.floor(creditLimit(after) / 2);
  await bank.getByLabel('Amount to take').fill(String(take));
  const drawPreview = bank.getByTestId('bank-draw-preview');
  await expect(drawPreview).toBeVisible();
  await expect(drawPreview).toContainText(`If you take ${money(take)}:`);
  await expect(drawPreview).toContainText('Debt becomes');
  await bank.getByLabel('Amount to take').fill('');
  await expect(drawPreview).toBeHidden();
  expect(errors).toEqual([]);
});

test('a frozen line shows the sweep and the countdown, then what falls due once the bank asks for every loan back', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await giveRevenue(page, 40_000, 20_000);
  // Test-only: a frozen line owing money, a month that bills well (so the close sweeps part of its operating cash flow).
  await page.evaluate(() => {
    const s = window.__lst!.getState();
    s.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    s.debt.credit.balance = 150_000;
    s.debt.frozenCloses = 1;
    s.finance.cash = 400_000;
    s.sales.month.revenueDollarDays = 60_000 * 31;
  });
  await tickToNextClose(page);
  let s = await state(page);
  const last = s.finance.reports.at(-1)!;
  const sweep = last.debt!.sweep!;
  expect(sweep).toBeGreaterThan(0);
  expect(s.notices.some((n) => n.kind === 'debtSwept')).toBe(true);
  const left = closesUntilAcceleration(s)!;
  expect(left).toBe(FROZEN_ACCELERATION_CLOSES - 2);
  const chip = page.getByTestId('hud-covenant');
  await expect(chip).toHaveText(`Bank: No more borrowing: ${left} months to call`);

  await chip.click();
  const bank = bankDialog(page);
  const frozen = bank.getByTestId('bank-frozen');
  await expect(frozen).toBeVisible();
  await expect(bank.getByTestId('bank-frozen-last')).toHaveText(`Last time it took ${money(sweep)}, at the ${formatMonth(last.year, last.month)} close.`);
  await expect(bank.getByTestId('bank-frozen-countdown')).toContainText(`the bank asks for every loan back in ${left} months`);
  await expect(bank.getByTestId('bank-frozen-sweep')).toHaveText(/the bank takes about \$[\d,]+ of your spare cash to pay down what you owe\.$|none is expected at the next close\.$/);
  // The sweep notice can be reread in the Bank's messages.
  await disclose(bank.getByTestId('bank-messages'));
  await expect(bank.getByTestId('bank-notice-list')).toContainText('The bank swept');
  await page.keyboard.press('Escape');

  // Test-only: one frozen close short of the call (and no good close toward stepping back). The next close calls the loans.
  await page.evaluate((n) => {
    const debt = window.__lst!.getState().debt;
    debt.frozenCloses = n;
    debt.covenant.compliantCloses = 0;
  }, FROZEN_ACCELERATION_CLOSES - 1);
  await tickToNextClose(page);
  s = await state(page);
  expect(s.debt.acceleration?.closesLeft).toBe(ACCELERATION_CLOSES);
  await expect(chip).toHaveText(`Loans called: ${ACCELERATION_CLOSES} closes left`);
  await chip.click();
  // Round 4c/4d: the Bank's title names the step the HUD chip and the month summary name.
  await expect(bank.getByTestId('bank-health-title')).toHaveText('Bank health: Loans called');
  await expect(bank.getByTestId('bank-health-sentence')).toHaveText("The bank has asked for every loan back. You can't borrow until it's all repaid.");
  await expect(bank.getByTestId('bank-frozen-called')).toContainText('The bank has asked for every loan back');
  await expect(bank.getByTestId('bank-frozen-called').locator('li')).toHaveCount(ACCELERATION_CLOSES);
  await expect(bank.getByTestId('bank-frozen-end')).toContainText('the game ends');
  await expect(bank.getByTestId('bank-slip').locator('[aria-current="step"]')).toHaveAttribute('data-step', 'called');
  await expect(bank.getByTestId('bank-borrow')).toBeHidden();
  await expect(bank.getByTestId('bank-borrow-why')).toContainText('asked for every loan back');
  await bank.getByTestId('bank-credit-toggle').click();
  await expect(bank.getByLabel('Amount to take')).toBeHidden();
  expect(errors).toEqual([]);
});
