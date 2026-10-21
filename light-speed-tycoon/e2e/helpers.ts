// Shared Playwright helpers. Every spec opens pages through open(), which adds
// ?debug=1: production builds only expose window.__lst with that flag (see
// src/ui/debugHook.ts). Replacing the game in play keeps the flag in the URL,
// so a reload after a new game, a load or an import still has the hook.
// Debug pages start with the month-end briefing off (round 4): a spec that
// wants it opens with openWithBriefings() or calls setBriefing().
//
// Owner: ui-economy workstream (round 4b: start-screen added the start-screen
// helpers at the end). Other specs import these; if a spec needs a
// helper that is not here, define it in that spec.

import type { ConsoleMessage, Locator, Page } from '@playwright/test';

// Web fonts come from Google Fonts; a sandbox or CI box without internet access
// fails those requests, which is not an app error.
export function isFontNoise(msg: ConsoleMessage): boolean {
  return /fonts\.(googleapis|gstatic)\.com/.test(msg.location().url);
}

/** Collect console errors and page errors (font noise excluded); assert it stays empty. */
export function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !isFontNoise(msg)) errors.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

/** `url` with debug=1 added to its query string. */
export function withDebug(url: string): string {
  const [path = '/', query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('debug', '1');
  return `${path}?${params.toString()}`;
}

/** Go to `url` (with ?debug=1) and wait for the debug hook. */
export async function open(page: Page, url: string): Promise<void> {
  await page.goto(withDebug(url));
  await page.waitForFunction(() => window.__lst !== undefined);
}

/** A briefing setting for a debug page: '1' (the stored preference, every month by default), a frequency, or 'off'. */
export type BriefingParam = '1' | 'monthly' | 'quarterly' | 'attention' | 'off';

/** `url` with briefing=<setting> added (see src/ui/briefing.ts startingBriefingSetting). */
export function withBriefing(url: string, setting: BriefingParam = '1'): string {
  const [path = '/', query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('briefing', setting);
  return `${path}?${params.toString()}`;
}

/** Open `url` like open(), with month-end briefings on ('1': the stored preference). */
export async function openWithBriefings(page: Page, url: string, setting: BriefingParam = '1'): Promise<void> {
  await open(page, withBriefing(url, setting));
}

/** Switch this page's month-end briefings without storing a preference (window.__lst.setBriefing). */
export async function setBriefing(page: Page, setting: Exclude<BriefingParam, '1'>): Promise<void> {
  await page.evaluate((s) => window.__lst!.setBriefing(s), setting);
}

export async function nodeOnScreen(page: Page, node: number): Promise<{ x: number; y: number }> {
  return page.evaluate((id) => {
    const lst = window.__lst!;
    const n = lst.getState().city.nodes[id]!;
    return lst.worldToScreen(n.x, n.y);
  }, node);
}

export async function clickNode(page: Page, node: number): Promise<void> {
  const p = await nodeOnScreen(page, node);
  await page.mouse.click(p.x, p.y);
}

/** The best `length`-segment route out of the CO by homes fronting it, with every corner on open map. */
export async function routeFromCo(page: Page, length: 1 | 2): Promise<{ nodes: number[]; segments: number[]; score: number } | null> {
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

export async function currentGame(page: Page): Promise<{ seed: number; day: number; name: string; cash: number; cabinets: number[] }> {
  return page.evaluate(() => {
    const s = window.__lst!.getState();
    return { seed: s.seed, day: s.day, name: s.city.name, cash: s.finance.cash, cabinets: s.network.cabinets.map((c) => c.node) };
  });
}

// --- Round 4b: the start screen ---------------------------------------------
// Debug pages skip the first-launch start screen (and a fresh ?seed link's)
// and start a Seed-round game with the default company name, so every spec
// above behaves as before. ?start=1 shows it; the menu's New game and the
// game-over dialog's "Start a new town" show it on every page.

/** `url` with start=1 added: a debug page that shows the first-launch start screen. */
export function withStart(url: string): string {
  const [path = '/', query = ''] = url.split('?');
  const params = new URLSearchParams(query);
  params.set('start', '1');
  return `${path}?${params.toString()}`;
}

/** Open `url` like open(), with the first-launch start screen shown (when there is no game to resume). */
export async function openWithStart(page: Page, url: string): Promise<void> {
  await open(page, withStart(url));
}

/** The start screen dialog. */
export function startScreen(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Start your fiber company' });
}

/** The difficulty cards' titles on the start screen, by id. */
export const DIFFICULTY_NAMES = {
  angel: 'Angel-backed',
  seed: 'Seed round',
  bootstrapped: 'Bootstrapped',
  shoestring: 'Shoestring',
} as const;

/**
 * On the open start screen: type a company name and pick a difficulty (each
 * only when given), then press Start and wait for the screen to close.
 */
export async function startCompany(page: Page, opts: { name?: string; difficulty?: keyof typeof DIFFICULTY_NAMES } = {}): Promise<void> {
  const screen = startScreen(page);
  await screen.waitFor();
  if (opts.name !== undefined) await screen.getByLabel('Company name').fill(opts.name);
  if (opts.difficulty) await screen.getByRole('radio', { name: new RegExp(DIFFICULTY_NAMES[opts.difficulty]) }).click();
  await screen.getByRole('button', { name: 'Start', exact: true }).click();
  await screen.waitFor({ state: 'hidden' });
}
