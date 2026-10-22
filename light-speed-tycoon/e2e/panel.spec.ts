// The report panel end to end (round 4c/4d: a small version of the month
// summary): before the first close; a month that borrowed and built, told in
// the summary's words (the cash line, money in and out on one scale, the
// customers line, the building line, the bank's word, the spending so far);
// "See customers" and the bank's word opening their panels; "See the full
// books" opening the briefing sheet's books view on its own (the game paused
// behind it, not counted as a month-end briefing, Close returning to the
// game and to the button); updates in place; the bank's word through every
// state; a phone pass that starts collapsed, fits without sideways
// scrolling and has comfortable touch targets; and a landscape phone, where
// the collapsed panel shows the bank's word on a second row and a bank
// notice toasts only its headline, so the toast stays on screen under the HUD.
//
// Conditions are set up through window.__lst as bank.spec.ts does (closed
// months with bills pushed into finance.reports give the town credit).
// Figures are checked against the sim's own functions or balance.ts, never
// literals.
//
// Owner: ui-summary workstream.

import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { briefingMoney } from '../src/sim/advisor';
import { CPP_TARGET, LOAN_ROUNDING, TERM_LOAN_MIN } from '../src/sim/balance';
import { bankHealth, creditLimit } from '../src/sim/debt';
import { reportKpis } from '../src/sim/metrics';
import type { GameState, MonthlyReport } from '../src/sim/types';
import { formatMonthLong } from '../src/ui/format';
import { healthSentence, healthWordOf } from '../src/ui/health';
import { open, routeFromCo, watchErrors } from './helpers';

const SEED = '/?seed=12345';
const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
const JARGON = /ARPU|CPGA|leverage|coverage|covenant|DSCR|\bARR\b|\bOCF\b|\bbps\b|×|\d\.\d\dx\b/i;

// Headless Chromium draws WebGL in software, so a month's ticks are slow here.
test.describe.configure({ timeout: 90_000 });

const state = (page: Page) => page.evaluate(() => window.__lst!.getState()) as Promise<GameState>;
const reportPanel = (page: Page) => page.getByRole('region', { name: 'Monthly report' });
const pressedSpeed = (page: Page) => page.locator('.speed[aria-pressed="true"]');
/** The panel's parts on screen, top to bottom. */
const shownParts = (page: Page) =>
  page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.panel [data-part]')].filter((e) => !e.hidden && e.getClientRects().length > 0).map((e) => e.dataset.part));

/** Test-only: three closed months each billing `revenue` against `costs`, so the town has credit. A tick lets every panel see them. */
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

/** A month that borrows and builds: emergency cash, then a street out of the CO and a cabinet, through real commands; then its close. */
async function borrowAndBuild(page: Page): Promise<{ borrowed: number; report: MonthlyReport }> {
  await giveRevenue(page, 40_000, 20_000);
  const limit = creditLimit(await state(page));
  const borrowed = Math.floor(limit / 2 / LOAN_ROUNDING) * LOAN_ROUNDING;
  expect(borrowed).toBeGreaterThan(0);
  const route = await routeFromCo(page, 2);
  expect(route, 'a cable route out of the CO').not.toBeNull();
  const results = await page.evaluate(
    ({ segments, borrowed }) => {
      const lst = window.__lst!;
      const co = lst.getState().city.coNode;
      return [
        lst.dispatch({ type: 'drawCredit', amount: borrowed }),
        lst.dispatch({ type: 'layCable', segments, method: 'underground' }),
        lst.dispatch({ type: 'placeCabinet', node: co }),
      ].map((r) => r.ok);
    },
    { segments: route!.segments, borrowed },
  );
  expect(results).toEqual([true, true, true]);
  await tickToNextClose(page);
  return { borrowed, report: (await state(page)).finance.reports.at(-1)! };
}

/** What the panel's building line says for a report (the summary's words: the cost per home passed against the target). */
function buildingText(report: MonthlyReport, building: number): string {
  const cpp = reportKpis(report)!.cpp;
  return `Building: ${money(building)} · ${cpp === null ? 'no homes passed yet' : `${money(cpp)} per home passed`} (target ${money(CPP_TARGET)})`;
}

test.describe('on a desktop', () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test('tells the last month like the summary, and opens the full books for it on their own', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, SEED);
    await page.getByRole('button', { name: 'Got it' }).click();
    const panel = reportPanel(page);
    const toggle = panel.locator('.panel-toggle');

    // Before the first close: when the report comes, and what this month has spent; nothing to open.
    await expect(panel.locator('.panel-title-text')).toHaveText('Monthly report');
    await expect(panel.locator('.panel-empty')).toHaveText('First report arrives Feb 1.');
    await expect(toggle).toBeDisabled();
    await expect(panel.locator('.mtd')).toHaveText(`This month so far: ${money(0)} spent`);
    await expect(panel.getByRole('button', { name: 'See the full books' })).toBeHidden();
    expect(await shownParts(page)).toEqual(['empty', 'mtd']);

    const { borrowed, report } = await borrowAndBuild(page);
    const flows = briefingMoney([report]);
    const group = (key: string) => flows.groups.find((g) => g.key === key)!.total;
    expect(flows.in - flows.out).toBe(report.net);
    expect(group('building')).toBeGreaterThan(0);

    // Expanded on a desktop: every part, top to bottom.
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const month = formatMonthLong(report.year, report.month);
    await expect(panel.locator('.panel-title-text')).toHaveText(month);
    expect(await shownParts(page)).toEqual(['cash', 'money', 'customers', 'seeCustomers', 'building', 'bank', 'mtd', 'books']);
    await expect(panel.locator('.panel-cash')).toHaveText(`Cash went ${report.net < 0 ? 'down' : 'up'} ${money(Math.abs(report.net))} · ${money(report.cashEnd)} left`);
    // Money in: the borrowing by name (never success green); money out: the summary's three groups.
    const moneyIn = panel.locator('.panel-flow-in');
    await expect(moneyIn.locator('.panel-flow-total')).toHaveText(money(flows.in));
    await expect(moneyIn.locator('.panel-flow-total')).toHaveClass(/total-borrowed/);
    await expect(moneyIn.locator('.panel-legend li[data-key="borrowed"]')).toHaveText(`Borrowed ${money(borrowed)}`);
    const moneyOut = panel.locator('.panel-flow-out');
    await expect(moneyOut.locator('.panel-flow-total')).toHaveText(money(flows.out));
    await expect(moneyOut.locator('.panel-legend li[data-key="building"]')).toHaveText(`Building fiber ${money(group('building'))}`);
    await expect(moneyOut.locator('.panel-legend li[data-key="running"]')).toHaveText(`Running the business ${money(group('running'))}`);
    await expect(panel.locator('.panel-bar-out')).toHaveAttribute('aria-label', new RegExp(`^Money out ${money(flows.out).replace('$', '\\$')}: Running the business`));
    // One scale: the larger bar is the full width, the other in proportion.
    const widths = await page.evaluate(() => {
      const width = (sel: string) => [...document.querySelectorAll<HTMLElement>(`${sel} .panel-seg`)].filter((e) => !e.hidden).reduce((n, e) => n + e.getBoundingClientRect().width, 0);
      return { in: width('.panel-bar-in'), out: width('.panel-bar-out'), track: document.querySelector<HTMLElement>('.panel-bar-out')!.getBoundingClientRect().width };
    });
    const scale = Math.max(flows.in, flows.out);
    expect(Math.abs(widths.out - (widths.track * flows.out) / scale)).toBeLessThan(2);
    expect(Math.abs(widths.in - (widths.track * flows.in) / scale)).toBeLessThan(2);
    // Building, against the target, the band said in words beside its color.
    await expect(panel.locator('.panel-building-text')).toHaveText(buildingText(report, group('building')));
    const kpis = reportKpis(report)!;
    if (kpis.cpp !== null) await expect(panel.locator('.panel-band')).toHaveText(/^(Within|Over|Far over) target$/);
    // The customers line, the bank's word, and this month's spending so far.
    await expect(panel.locator('.panel-customers-text')).toHaveText(/^\d+ customers?( \(\+\d+ joined, \d+ left\))? · (\d+% of homes you pass|no homes passed yet)$/);
    // Today's health, in the Bank's own word and sentence.
    const health = bankHealth(await state(page));
    expect(health.noDebt).toBe(false);
    await expect(panel.getByTestId('panel-bank')).toHaveText(`Bank: ${healthWordOf(health)}`);
    await expect(panel.getByTestId('panel-bank')).toHaveAttribute('title', healthSentence(health));
    await expect(panel.locator('.mtd')).toHaveText(/^This month so far: \$[\d,]+ spent$/);
    expect(await panel.innerText()).not.toMatch(JARGON);

    // Updates in place: the same elements as the days go by.
    await page.evaluate(() => {
      (document.querySelector('.panel-cash-head') as HTMLElement & { marked?: boolean }).marked = true;
      (document.querySelector('.panel-books') as HTMLElement & { marked?: boolean }).marked = true;
    });
    const spentBefore = await panel.getByTestId('mtd-spend').textContent();
    await page.evaluate(() => {
      const lst = window.__lst!;
      lst.dispatch({ type: 'addSplitter', cabinet: lst.getState().network.cabinets[0]!.id });
      lst.tick(2);
    });
    await expect(panel.getByTestId('mtd-spend')).not.toHaveText(spentBefore!);
    expect(await page.evaluate(() => (document.querySelector('.panel-cash-head') as HTMLElement & { marked?: boolean }).marked === true)).toBe(true);
    expect(await page.evaluate(() => (document.querySelector('.panel-books') as HTMLElement & { marked?: boolean }).marked === true)).toBe(true);

    // See customers: the Customers dashboard.
    await panel.getByRole('button', { name: 'See customers' }).click();
    await expect(page.getByRole('dialog', { name: 'Customers' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Customers' })).toBeHidden();

    // See the full books: the books view for this month on its own, the game paused behind it.
    await page.evaluate(() => window.__lst!.setSpeed(2));
    const advisorBefore = (await state(page)).advisor;
    const booksButton = panel.getByRole('button', { name: 'See the full books' });
    await booksButton.click();
    const books = page.getByRole('dialog', { name: `The full books for ${month}` });
    await expect(books).toBeVisible();
    const dayOpened = (await state(page)).day;
    await expect(books.getByRole('heading', { name: 'The full books', exact: true })).toBeVisible();
    await expect(books.getByRole('combobox', { name: 'Show this briefing' })).toBeVisible();
    await expect(books.locator('.briefing-tile')).toHaveCount(7);
    await expect(books.locator('.briefing-part-more h4')).toHaveText(`More figures for ${month}`);
    await expect(books.locator('.briefing-lines-in .briefing-line[data-key="borrowed"] dd')).toHaveText(money(borrowed));
    await expect(books.locator('.briefing-books-group.group-building .briefing-books-group-head .num')).toHaveText(money(group('building')));
    // No summary to go back to: Close is the only way on.
    await expect(books.locator('.sheet-actions .btn')).toHaveText(['Close']);
    await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '0');
    // It is not a month-end briefing: nothing recorded as shown, and the debug hook says no briefing is open.
    expect(await page.evaluate(() => window.__lst!.briefingOpen())).toBe(false);
    await page.waitForTimeout(800);
    const during = await state(page);
    expect(during.day).toBe(dayOpened);
    expect(during.advisor).toEqual(advisorBefore);
    await books.locator('.briefing-close').click();
    await expect(books).toBeHidden();
    await expect(booksButton).toBeFocused();
    await expect(pressedSpeed(page)).toHaveAttribute('data-speed', '2');
    await page.evaluate(() => window.__lst!.setSpeed(0));
    // Esc closes it too.
    await booksButton.click();
    await expect(books).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(books).toBeHidden();

    // Collapsed: the cash line, the customers line and the bank's word only.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(await shownParts(page)).toEqual(['cash', 'customers', 'bank']);
    await toggle.click();
    expect(await shownParts(page)).toContain('books');
    expect(errors).toEqual([]);
  });

  test('says the bank’s health in the shared words through every state, and the word opens the Bank', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, SEED);
    const panel = reportPanel(page);
    const word = panel.getByTestId('panel-bank');
    // No debt yet: no bank word.
    await giveRevenue(page, 40_000, 20_000);
    await expect(panel.locator('.panel-cash')).toBeVisible();
    await expect(word).toBeHidden();
    // Emergency cash: the word appears at once (today's health, as the HUD chip and the Bank show it).
    const limit = creditLimit(await state(page));
    const draw = await page.evaluate((amount) => window.__lst!.dispatch({ type: 'drawCredit', amount }), Math.floor(limit / 2 / LOAN_ROUNDING) * LOAN_ROUNDING);
    expect(draw.ok, JSON.stringify(draw)).toBe(true);
    await expect(word).toHaveText(`Bank: ${healthWordOf(bankHealth(await state(page)))}`);
    await expect(word).toHaveText(/^Bank: (Good|Watch)$/);
    // The month closes with the debt owed: the word stays, beside the month's own figures.
    await tickToNextClose(page);
    await expect(panel.locator('.panel-customers')).toBeVisible();
    await expect(word).toHaveText(`Bank: ${healthWordOf(bankHealth(await state(page)))}`);
    // Bank trouble (test-only state, as other specs set it): the panel, the HUD chip and the Bank use the same word.
    const cases: [string, string, string][] = [
      ['warning', 'Bank: Warning', 'tone-warn'],
      ['penalty', 'Bank: Higher interest', 'tone-danger'],
      ['frozen', 'Bank: No more borrowing', 'tone-danger'],
    ];
    for (const [stage, text, tone] of cases) {
      await page.evaluate((stage) => {
        const s = window.__lst!.getState();
        s.debt.covenant.stage = stage as GameState['debt']['covenant']['stage'];
        window.__lst!.tick(1);
      }, stage);
      await expect(word).toHaveText(text);
      await expect(word).toHaveClass(new RegExp(tone));
      await expect(page.getByTestId('hud-covenant')).toContainText(text.replace('Bank: ', ''));
    }
    await page.evaluate(() => {
      const s = window.__lst!.getState();
      s.debt.acceleration = { day: s.day, closesLeft: 2 };
      window.__lst!.tick(1);
    });
    await expect(word).toHaveText('Bank: Loans called');
    expect(await panel.innerText()).not.toMatch(JARGON);
    // Collapsed, the word stays; it opens the Bank, which says the same.
    await panel.locator('.panel-toggle').click();
    expect(await shownParts(page)).toEqual(['cash', 'customers', 'bank']);
    await word.click();
    const bank = page.getByRole('dialog', { name: 'Bank', exact: true });
    await expect(bank).toBeVisible();
    await expect(bank.getByTestId('bank-health-title')).toHaveText('Bank health: Loans called');
    await page.keyboard.press('Escape');
    await expect(bank).toBeHidden();
    await expect(word).toBeFocused();
    expect(errors).toEqual([]);
  });
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('starts collapsed, fits without sideways scrolling, and every control is a comfortable touch target', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, SEED);
    await page.getByRole('button', { name: 'Got it' }).tap();
    const { report } = await borrowAndBuild(page);
    const panel = reportPanel(page);
    const toggle = panel.locator('.panel-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(panel.locator('.panel-title-text')).toHaveText(formatMonthLong(report.year, report.month));
    expect(await shownParts(page)).toEqual(['cash', 'customers', 'bank']);
    const fits = () =>
      page.evaluate(() => {
        const r = document.querySelector<HTMLElement>('.panel')!.getBoundingClientRect();
        return { page: document.documentElement.scrollWidth - window.innerWidth, left: r.left, right: r.right, width: window.innerWidth, panelScroll: document.querySelector<HTMLElement>('.panel')!.scrollWidth - document.querySelector<HTMLElement>('.panel')!.clientWidth };
      });
    const tall = async () => {
      for (const button of await panel.locator('button:visible').all()) {
        const box = await button.boundingBox();
        expect(box, await button.textContent() ?? '').not.toBeNull();
        expect(box!.height, (await button.textContent()) ?? '').toBeGreaterThanOrEqual(44);
      }
    };
    let fit = await fits();
    expect(fit.page).toBeLessThanOrEqual(0);
    expect(fit.panelScroll).toBeLessThanOrEqual(0);
    expect(fit.left).toBeGreaterThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.width);
    await tall();

    // Opened: every part, still no sideways scrolling, every control tall enough.
    await toggle.tap();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await shownParts(page)).toEqual(['cash', 'money', 'customers', 'seeCustomers', 'building', 'bank', 'mtd', 'books']);
    fit = await fits();
    expect(fit.page).toBeLessThanOrEqual(0);
    expect(fit.panelScroll).toBeLessThanOrEqual(0);
    expect(fit.right).toBeLessThanOrEqual(fit.width);
    await tall();
    expect(await panel.innerText()).not.toMatch(JARGON);

    // The full books fit a phone too.
    await panel.getByRole('button', { name: 'See the full books' }).tap();
    const books = page.locator('dialog.briefing-books-only');
    await expect(books).toBeVisible();
    const sheet = await page.evaluate(() => {
      const body = document.querySelector<HTMLElement>('dialog.briefing .sheet-body')!;
      return { scroll: body.scrollWidth - body.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth };
    });
    expect(sheet.scroll).toBeLessThanOrEqual(0);
    expect(sheet.page).toBeLessThanOrEqual(0);
    expect((await books.locator('.briefing-close').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await books.locator('.briefing-close').tap();
    await expect(books).toBeHidden();
    expect(errors).toEqual([]);
  });
});

test.describe('on a landscape phone', () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

  test('a bank notice toasts its headline, on screen between the HUD and the collapsed panel with the bank’s word', async ({ page }) => {
    const errors = watchErrors(page);
    await open(page, SEED);
    await page.evaluate(() => document.fonts.ready);
    await page.getByRole('button', { name: 'Got it' }).tap();
    await giveRevenue(page, 40_000, 20_000);
    // Borrow, then (test-only, as bank.spec.ts does) rewrite the months it lent against into a cash-flow history that cannot carry the debt.
    const loan = await page.evaluate(
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
    expect(loan.ok, JSON.stringify(loan)).toBe(true);
    // Three closes: Warning, Higher interest, then No more borrowing, each with its bank notice.
    for (let i = 0; i < 3; i++) await tickToNextClose(page);
    const s = await state(page);
    expect(s.debt.covenant.stage).toBe('frozen');
    const frozen = s.notices.filter((n) => n.kind === 'creditFrozen').at(-1);
    expect(frozen, 'a creditFrozen notice').toBeDefined();

    // The panel stays collapsed: the cash line, the customers line and the bank's word.
    const panel = reportPanel(page);
    await expect(panel.locator('.panel-toggle')).toHaveAttribute('aria-expanded', 'false');
    expect(await shownParts(page)).toEqual(['cash', 'customers', 'bank']);
    await expect(panel.getByTestId('panel-bank')).toHaveText('Bank: No more borrowing');

    // The notice toasts only its headline (the Bank lists it in full), as on a narrow phone.
    const start = frozen!.message.slice(0, 40);
    const toast = page.locator('.toast').filter({ hasText: start });
    await expect(toast).toHaveCount(1);
    await expect(toast).toHaveText(/ Full notice in the Bank\.$/);
    const shown = (await toast.textContent())!;
    expect(shown.length).toBeLessThan(frozen!.message.length);
    expect(frozen!.message.startsWith(shown.replace(/ Full notice in the Bank\.$/, '').replace(/[.…]$/, ''))).toBe(true);
    // Let the slide-in animation finish, then measure: the toast is whole on screen, under the HUD and clear of the panel.
    await page.waitForTimeout(400);
    const box = await page.evaluate((start) => {
      const r = (e: Element) => e.getBoundingClientRect();
      const t = [...document.querySelectorAll('.toast')].find((e) => e.textContent?.startsWith(start))!;
      return { toast: r(t).toJSON(), hud: r(document.querySelector('.hud')!).toJSON(), panel: r(document.querySelector('.panel')!).toJSON() };
    }, start);
    expect(box.toast.top, JSON.stringify(box)).toBeGreaterThanOrEqual(box.hud.bottom);
    expect(box.toast.bottom, JSON.stringify(box)).toBeLessThanOrEqual(box.panel.top);
    expect(errors).toEqual([]);
  });
});
