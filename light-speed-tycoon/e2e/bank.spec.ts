// The Bank end to end: no credit in a fresh town, drawing from the credit line,
// the term-loan builder on a phone, prepaying, the financing rows of the
// monthly report, covenants stepping up to a frozen line and a default that
// ends the game, and the quote cards' cash-after and credit hints.
//
// Conditions are set up through window.__lst the way economy.spec.ts does:
// closed months with revenue pushed into finance.reports give the town
// recurring revenue (and so credit); cash is set directly. Figures are checked
// against the sim's own functions (debt.ts) or balance.ts, never literals.
//
// Owner: ui-bank workstream.

import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { LOAN_ROUNDING, TERM_LOAN_MIN } from '../src/sim/balance';
import { creditLimit, termCapacity } from '../src/sim/debt';
import type { GameState } from '../src/sim/types';
import { nodeOnScreen, open, routeFromCo, watchErrors } from './helpers';

const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;

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
        s.finance.reports.push({ year: 2026, month, totals: { revenue, overhead: -costs }, net: revenue - costs, cashEnd: s.finance.cash, passings: 0 });
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
const bankDialog = (page: Page) => page.getByRole('dialog', { name: 'Bank' });

async function openReportDetails(page: Page): Promise<Locator> {
  const panel = page.getByRole('region', { name: 'Monthly report' });
  const toggle = panel.locator('.panel-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  return panel;
}

test('a fresh town has no credit: the Bank says why and the builder is disabled', async ({ page }) => {
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  await expect(page.getByTestId('hud-debt')).toBeHidden();
  await expect(page.getByTestId('hud-covenant')).toBeHidden();

  await bankButton(page).click();
  const bank = bankDialog(page);
  await expect(bank).toBeVisible();
  await expect(bank.getByTestId('bank-stage')).toHaveText('Compliant');
  const credit = bank.getByTestId('bank-credit');
  await expect(credit).toContainText(/no credit line yet/i);
  await expect(credit.getByTestId('bank-credit-limit')).toHaveText('$0');
  await expect(bank.getByTestId('bank-draw')).toBeDisabled();
  await expect(bank.getByLabel('Amount to draw')).toBeDisabled();
  // The builder: nothing to borrow, every control off, the sim's reason shown.
  const term = bank.getByTestId('bank-term');
  await expect(term.getByLabel('Term loan amount')).toBeDisabled();
  await expect(term.getByRole('radio', { name: '7 years' })).toBeDisabled();
  await expect(bank.getByTestId('bank-borrow')).toBeDisabled();
  await expect(term.locator('.bank-reasons')).toContainText(/no term loans yet/i);
  await expect(bank.getByTestId('bank-loan-list')).toBeHidden();
  await expect(bank.getByTestId('bank-loans')).toContainText('No term loans');

  await page.keyboard.press('Escape');
  await expect(bank).toBeHidden();
  await expect(bankButton(page)).toBeFocused();
  expect(errors).toEqual([]);
});

test('draws from the credit line in the Bank: the debt chip appears, cash goes up, the report shows it at the close', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  await giveRevenue(page, 40_000, 20_000);
  const limit = creditLimit(await state(page));
  expect(limit).toBeGreaterThan(2 * LOAN_ROUNDING);

  await bankButton(page).click();
  const bank = bankDialog(page);
  await expect(bank.getByTestId('bank-credit-limit')).toHaveText(money(limit));
  await expect(bank.getByTestId('bank-credit-available')).toHaveText(money(limit));

  // More than the line allows: refused with the sim's reason, inline and as a toast.
  const amount = bank.getByLabel('Amount to draw');
  await amount.fill(String(limit + 1));
  await bank.getByTestId('bank-draw').click();
  await expect(bank.getByTestId('bank-credit').getByRole('alert')).toContainText('Nothing drawn:');
  await expect.poll(toasts).toContainEqual(toast('err', 'Nothing drawn:'));
  expect((await state(page)).debt.credit.balance).toBe(0);

  // Half the line, from the preset.
  const half = Math.floor(limit / 2);
  const cash = (await state(page)).finance.cash;
  await bank.getByTestId('bank-credit').getByRole('button', { name: 'Half' }).first().click();
  await expect(amount).toHaveValue(String(half));
  await bank.getByTestId('bank-draw').click();
  await expect.poll(toasts).toContainEqual(toast('ok', `Drew ${money(half)} from the credit line`));
  await expect(bank.getByTestId('bank-credit-drawn')).toHaveText(money(half));
  const after = await state(page);
  expect(after.debt.credit.balance).toBe(half);
  expect(after.finance.cash).toBe(cash + half);
  await expect(bank.getByTestId('bank-summary-debt')).toHaveText(money(half));

  // The clock runs behind the sheet: figures refresh in place, a typed amount and focus survive.
  const termAmount = bank.getByLabel('Term loan amount');
  await termAmount.fill(String(TERM_LOAN_MIN));
  await page.evaluate(() => window.__lst!.setSpeed(4));
  await expect.poll(async () => (await state(page)).day, { timeout: 10_000 }).toBeGreaterThan(after.day + 2);
  await page.evaluate(() => window.__lst!.setSpeed(0));
  await expect(termAmount).toBeFocused();
  await expect(termAmount).toHaveValue(String(TERM_LOAN_MIN));

  await page.keyboard.press('Escape');
  await expect(bank).toBeHidden();
  const chip = page.getByTestId('hud-debt');
  await expect(chip).toHaveText(`Debt ${money(half)}`);
  await expect(page.getByTestId('hud-cash')).toHaveText(money((await state(page)).finance.cash));
  // The chip opens the Bank too.
  await chip.click();
  await expect(bank).toBeVisible();
  await page.keyboard.press('Escape');

  // The month close charges interest on the line; the report shows the month's financing.
  await tickToNextClose(page);
  const report = (await state(page)).finance.reports.at(-1)!;
  expect(report.debt).toBeDefined();
  expect(report.totals.interest ?? 0).toBeLessThan(0);
  const panel = await openReportDetails(page);
  await expect(panel.locator('.row-interest dd .num')).toHaveText(money(-(report.totals.interest ?? 0)));
  await expect(panel.locator('.row-proceeds dd .num')).toHaveText(money(half));
  await expect(panel.locator('.row-principal dd .num')).toHaveText('$0');
  await expect(panel.locator('.row-debt dd .num')).toHaveText(money(report.debt!.creditBalance + report.debt!.termBalance));
  await expect(panel.locator('.row-leverage dd')).toContainText('limit');
  await expect(panel.locator('.row-coverage dd')).toContainText('min');
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('takes a 7-year term loan with the builder, prepays part of it, and sees it in the report', async ({ page }) => {
    test.setTimeout(90_000);
    const errors = watchErrors(page);
    await open(page, '/?seed=12345');
    const toasts = await recordToasts(page);
    await page.getByRole('button', { name: 'Got it' }).tap();
    await giveRevenue(page, 40_000, 20_000);
    const capacity = termCapacity(await state(page));
    expect(capacity).toBeGreaterThanOrEqual(4 * TERM_LOAN_MIN);

    await bankButton(page).tap();
    const bank = bankDialog(page);
    await expect(bank).toBeVisible();
    // One column, nothing wider than the screen, the body scrolls.
    const fit = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('dialog.bank .sheet-body')!;
      const dialog = document.querySelector<HTMLElement>('dialog.bank')!.getBoundingClientRect();
      return { scrollW: body.scrollWidth, clientW: body.clientWidth, scrollH: body.scrollHeight, clientH: body.clientHeight, right: dialog.right, left: dialog.left };
    });
    expect(fit.scrollW).toBeLessThanOrEqual(fit.clientW);
    expect(fit.scrollH).toBeGreaterThan(fit.clientH);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(390);

    const term = bank.getByTestId('bank-term');
    const seven = term.getByRole('radio', { name: '7 years' });
    await seven.scrollIntoViewIfNeeded();
    await seven.tap();
    await expect(seven).toHaveAttribute('aria-checked', 'true');
    await expect(term.getByRole('radio', { name: '5 years' })).toHaveAttribute('aria-checked', 'false');
    // A quarter of what the bank will lend.
    const quarter = Math.floor((capacity * 0.25) / LOAN_ROUNDING) * LOAN_ROUNDING;
    await term.getByRole('button', { name: /^25% of what you can borrow/ }).tap();
    await expect(term.getByLabel('Term loan amount')).toHaveValue(String(quarter));
    const borrow = bank.getByTestId('bank-borrow');
    await expect(borrow).toHaveText(`Borrow ${money(quarter)} over 7 years`);
    await expect(term.getByTestId('bank-term-monthly-payment')).toHaveText(/^\$[1-9][\d,]*$/);
    await expect(term.locator('[data-check="leverage"]')).toContainText('→');

    // Every control is a comfortable touch target.
    for (const control of [seven, borrow, term.getByLabel('Term loan amount'), term.getByRole('button', { name: /^50% of/ }), bank.getByTestId('bank-draw')]) {
      const box = await control.boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }

    const cash = (await state(page)).finance.cash;
    await borrow.scrollIntoViewIfNeeded();
    await borrow.tap();
    await expect.poll(toasts).toContainEqual(toast('ok', `Borrowed ${money(quarter)} over 7 years`));
    let s = await state(page);
    expect(s.debt.loans).toHaveLength(1);
    const loan = s.debt.loans[0]!;
    expect(loan).toMatchObject({ principal: quarter, balance: quarter, termMonths: 84 });
    expect(s.finance.cash).toBe(cash + quarter);
    const row = bank.locator(`[data-loan="${loan.id}"]`);
    await expect(row).toContainText(`#${loan.id} · 7 years at`);
    await expect(row).toContainText('first payment: interest only');
    await expect(bank.getByTestId(`bank-loan-${loan.id}-balance`)).toHaveText(money(quarter));

    // Prepay part of it: the quote shows the accrued interest and the cash it takes.
    const part = TERM_LOAN_MIN;
    const prepayAmount = row.getByLabel(`Amount to prepay on loan #${loan.id}`);
    await prepayAmount.scrollIntoViewIfNeeded();
    await prepayAmount.fill(String(part));
    await expect(row.locator('.bank-prepay-quote')).toContainText('Accrued interest');
    await bank.getByTestId(`bank-prepay-${loan.id}`).tap();
    await expect.poll(toasts).toContainEqual(toast('ok', `Prepaid ${money(part)} of loan #${loan.id}`));
    s = await state(page);
    expect(s.debt.loans[0]!.balance).toBe(quarter - part);
    await expect(bank.getByTestId(`bank-loan-${loan.id}-balance`)).toHaveText(money(quarter - part));
    await expect(page.getByTestId('hud-debt')).toHaveText(`Debt ${money(quarter - part)}`);

    // The month close: interest (the loan's first, interest-only payment), the prepaid principal, debt at month end.
    await page.keyboard.press('Escape');
    await expect(bank).toBeHidden();
    await tickToNextClose(page);
    const report = (await state(page)).finance.reports.at(-1)!;
    expect(report.totals.interest ?? 0).toBeLessThan(0);
    expect(report.totals.principal).toBe(-part);
    const panel = await openReportDetails(page);
    await expect(panel.locator('.row-interest dd .num')).toHaveText(money(-(report.totals.interest ?? 0)));
    await expect(panel.locator('.row-principal dd .num')).toHaveText(money(part));
    await expect(panel.locator('.row-proceeds dd .num')).toHaveText(money(quarter));
    await expect(panel.locator('.row-debt dd .num')).toHaveText(money(report.debt!.creditBalance + report.debt!.termBalance));
    expect(errors).toEqual([]);
  });
});

test('covenant breaches step the stage up to a frozen line, and a payment missed while frozen is a default', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = watchErrors(page);
  await open(page, '/?seed=12345');
  const toasts = await recordToasts(page);
  const town = (await state(page)).city.name;
  await giveRevenue(page, 40_000, 20_000);
  // Borrow most of what the bank allows, then (test-only) rewrite the months it lent against
  // into a cash-flow history that cannot carry the debt.
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
  // Still compliant, but at today's figures the debt breaks the covenants: the HUD warns ahead of the close.
  const chip = page.getByTestId('hud-covenant');
  await expect(chip).toHaveText('Covenant at risk');
  await expect(chip).toHaveClass(/chip-warn/);
  expect((await state(page)).debt.covenant.stage).toBe('compliant');

  const notice = async (kind: string) => {
    const found = (await state(page)).notices.find((n) => n.kind === kind);
    expect(found, `a ${kind} notice`).toBeDefined();
    return found!.message;
  };

  await tickToNextClose(page);
  await expect(chip).toHaveText('Covenant warning');
  await expect(chip).toHaveClass(/chip-warn/);
  expect((await state(page)).debt.covenant.stage).toBe('warning');
  await expect.poll(toasts).toContainEqual(toast('warn', await notice('covenantWarning')));

  await tickToNextClose(page);
  await expect(chip).toHaveText('Penalty rate');
  await expect(chip).toHaveClass(/chip-warn/);
  await expect.poll(toasts).toContainEqual(toast('warn', await notice('covenantPenalty')));

  await tickToNextClose(page);
  await expect(chip).toHaveText('Credit frozen');
  await expect(chip).toHaveClass(/chip-danger/);
  expect((await state(page)).debt.covenant.stage).toBe('frozen');
  await expect.poll(toasts).toContainEqual(toast('err', await notice('creditFrozen')));

  // The chip opens the Bank: frozen, nothing to draw or borrow, and a missed payment now ends the game.
  await chip.click();
  const bank = bankDialog(page);
  await expect(bank.getByTestId('bank-covenant-stage')).toHaveText('Frozen');
  await expect(bank.getByTestId('bank-covenant-next')).toContainText('default');
  await expect(bank.getByTestId('bank-draw')).toBeDisabled();
  await expect(bank.getByTestId('bank-borrow')).toBeDisabled();
  await expect(bank.locator('.rate-penalty').first()).toBeVisible();
  // The long debt notices can be reread in the Bank, newest first; the next payment is set against the cash projected at the close.
  await expect(bank.getByTestId('bank-notice-list').locator('li').first()).toContainText(await notice('creditFrozen'));
  await expect(bank.getByTestId('bank-notice-list')).toContainText(await notice('covenantWarning'));
  await expect(bank.getByTestId('bank-summary-cash-at-the-close')).toHaveText(/^≈ -?\$[\d,]+$/);

  // Test-only: no cash for the next payment. The close defaults; the Bank closes for the game-over dialog.
  await page.evaluate(() => {
    window.__lst!.getState().finance.cash = 0;
  });
  await tickToNextClose(page);
  expect((await state(page)).gameOver).toMatchObject({ reason: 'default' });
  const over = page.getByRole('dialog', { name: 'Game over' });
  await expect(over).toBeVisible();
  await expect(bank).toBeHidden();
  await expect(over).toContainText(`${town} has defaulted on its loans.`);
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
  await expect(card.locator('.card-credit')).toHaveText(/^Draw \$[\d,]+ from your credit line to afford it$/);
  await expect(card.locator('.tone-negative')).toHaveText(/^-\$[\d,]+$/);
  expect(errors).toEqual([]);
});
