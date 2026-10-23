// The Customers dashboard's pure view model (customersPanel.ts, round 4c/4d
// spec I.5): the header figures, the growth series and chart shapes from the
// monthly reports, happiness in plain words, the reasons homes haven't
// switched paired with their levers, area rows and the campaign button's
// states, the levers' forecast lines (marketing, support, referral credits),
// the marketing field's check against setMarketing (moved here with the
// budget from pricingPanel.test.ts), and no jargon on any of it. Money is
// checked against balance.ts constants and the sim's quotes, never literal
// dollar amounts.

import { describe, expect, it } from 'vitest';
import { CAMPAIGN_DAYS, CUSTOMER_QUOTE_MONTHS, MARKETING_MAX_PER_MONTH, REFERRAL_CREDIT, SUPPORT_LEVELS, SUPPORT_QUOTE_MONTHS } from '../sim/balance';
import { formatDate, formatMonth } from '../sim/calendar';
import {
  AREA_TREND_MONTHS,
  customerAreas,
  happinessReport,
  MARKETING_STEP,
  quoteCampaign,
  quoteMarketing,
  quoteReferrals,
  quoteSupport,
  SUPPORT_LEVEL_IDS,
  whyNotSwitched,
} from '../sim/customers';
import { applyCommand, newGame } from '../sim/game';
import { roughMoney, subscriberUnits } from '../sim/sales';
import { cornerName } from '../sim/streets';
import { addLivePlant, closedMonth, makeGridCity, makeTestState } from '../sim/testing/fixtures';
import type {
  CabinetId,
  CampaignQuote,
  CustomerArea,
  GameState,
  HappinessReport,
  MarketingQuote,
  MonthlyReport,
  MonthlyStats,
  ReferralQuote,
  SupportQuote,
  SwitchReasons,
} from '../sim/types';
import {
  aboutCount,
  areaRow,
  campaignButton,
  campaignLengthWords,
  CHART_COLUMN,
  CHART_HEIGHT,
  CUSTOMERS_JARGON,
  customersHeader,
  GROWTH_MONTHS,
  growthGeometry,
  growthSeries,
  growthSummary,
  HAPPINESS_WORDS,
  happinessView,
  horizonWords,
  LEVER_WHAT,
  MARKETING_NOTHING_LIT,
  marketingForecast,
  marketingProblem,
  marketingStepLine,
  niceCeiling,
  referralLines,
  supportOption,
  SWITCH_WORDS,
  switchIntro,
  switchRows,
} from './customersPanel';
import { formatMoney, formatPercent } from './format';

/** A month's stats with these customer figures (the rest zero). */
function stats(subscribers: number, grossAdds: number, churned: number, lostService = 0): MonthlyStats {
  return {
    subscribers,
    accounts: subscribers,
    subscriberDays: subscribers * 30,
    grossAdds,
    churned,
    lostService,
    connectsTotal: 0,
    capexOsp: 0,
    capexConnect: 0,
    capexCo: 0,
    ponPortsUsed: 0,
    ponPorts: 0,
    fullCabinets: 0,
  };
}

/** Closed months from Jan 2027 with these (subscribers, joined, left) figures. */
function reports(figures: readonly [number, number, number][]): MonthlyReport[] {
  return figures.map(([subs, joined, left], i) => ({ ...closedMonth(2027 + Math.floor(i / 12), (i % 12) + 1, 0), stats: stats(subs, joined, left) }));
}

/** A 4x4 town lit from the CO with a cabinet there, half its parcels subscribed. */
function litTown(): { state: GameState; cabinet: CabinetId } {
  const state = makeTestState(makeGridCity({ cols: 4, rows: 4, coAt: [2, 2] }));
  const cabinet = addLivePlant(state, { splitters: 8 }) as CabinetId;
  state.day = 200;
  state.finance.cash = 1_000_000;
  state.sales.accounts = state.city.parcels
    .filter((p) => p.id % 2 === 0)
    .map((p) => ({ parcel: p.id, cabinet, tierUnits: { fiber500: 0, fiber1g: 1, fiber2g: 0 }, since: 0, locks: [] }));
  return { state, cabinet };
}

function reasonsOf(overall: Partial<SwitchReasons['overall']>, areas: SwitchReasons['areas'] = []): SwitchReasons {
  const o = { unaware: 0, deciding: 0, notWorth: 0, tooExpensive: 0, waiting: 0, unsigned: 0, passings: 0, subscribed: 0, notLit: 0, ...overall };
  if (overall.unsigned === undefined) o.unsigned = o.unaware + o.deciding + o.notWorth + o.tooExpensive + o.waiting;
  return { overall: o, areas };
}

describe('the header', () => {
  it('counts customers today, the last closed month joined and left, and the share of homes you can sell to', () => {
    const { state } = litTown();
    state.finance.reports = reports([
      [10, 10, 0],
      [18, 9, 1],
    ]);
    state.finance.reports[1]!.stats!.lostService = 2;
    const reasons = whyNotSwitched(state);
    const h = customersHeader(state, reasons);
    const units = subscriberUnits(state);
    expect(h.customers).toBe(units);
    expect(h.title).toBe(`${units} customers`);
    expect(h.joined).toBe(9);
    expect(h.left).toBe(3);
    expect(h.change).toBe('+9 joined, -3 left in February 2027');
    expect(h.share).toBe(reasons.overall.subscribed / reasons.overall.passings);
    expect(h.shareLine).toBe(`${formatPercent(h.share!)} of the homes you can sell to are customers.`);
  });

  it('says plainly when no month has closed or nothing is lit, and counts one customer in the singular', () => {
    const state = makeTestState(makeGridCity());
    const h = customersHeader(state, reasonsOf({}));
    expect(h).toMatchObject({ customers: 0, title: '0 customers', joined: null, left: null, change: 'No month has closed yet.', share: null });
    expect(h.shareLine).toBe("You can't sell to any homes yet: light a street first.");
    // A report from before round-2 stats: no figures to quote.
    state.finance.reports = [closedMonth(2027, 1, 0)];
    expect(customersHeader(state, reasonsOf({})).change).toBe('No month has closed yet.');
    const { state: one, cabinet } = litTown();
    one.sales.accounts = [{ parcel: 0, cabinet, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] }];
    expect(customersHeader(one, whyNotSwitched(one)).title).toBe('1 customer');
  });
});

describe('growth', () => {
  it('takes the last 24 closed months with figures, oldest first', () => {
    const figures: [number, number, number][] = [];
    for (let i = 0; i < 30; i++) figures.push([i * 10, 12, 2]);
    const all = reports(figures);
    // A report without stats (an old save's) is skipped.
    all.splice(3, 0, closedMonth(2027, 4, 0));
    const series = growthSeries(all);
    expect(series).toHaveLength(GROWTH_MONTHS);
    expect(series[0]!.customers).toBe((30 - GROWTH_MONTHS) * 10);
    expect(series.at(-1)).toEqual({ year: 2029, month: 6, label: formatMonth(2029, 6), customers: 290, joined: 12, left: 2 });
    expect(growthSeries(all, 3).map((p) => p.customers)).toEqual([270, 280, 290]);
    expect(growthSeries([])).toEqual([]);
  });

  it('counts lost service as left', () => {
    const r = reports([[5, 6, 1]]);
    r[0]!.stats!.lostService = 3;
    expect(growthSeries(r)[0]!.left).toBe(4);
  });

  it('sums the period up in words (the chart\'s accessible text)', () => {
    expect(growthSummary([])).toBe('The chart starts once your first month closes.');
    expect(growthSummary(growthSeries(reports([[7, 7, 0]])))).toBe(`${formatMonth(2027, 1)}: 7 customers at the end of ${formatMonth(2027, 1)}. 7 joined and 0 left.`);
    const series = growthSeries(
      reports([
        [10, 10, 0],
        [25, 17, 2],
        [40, 18, 3],
      ]),
    );
    expect(growthSummary(series)).toBe(`${formatMonth(2027, 1)} to ${formatMonth(2027, 3)}: from 10 to 40 customers. 45 joined and 5 left.`);
  });

  it('rounds a chart top up to 1, 2 or 5 times a power of ten', () => {
    expect(niceCeiling(0)).toBe(10);
    expect(niceCeiling(7)).toBe(10);
    expect(niceCeiling(49)).toBe(50);
    expect(niceCeiling(50)).toBe(50);
    expect(niceCeiling(120)).toBe(200);
    expect(niceCeiling(1_000)).toBe(1_000);
    expect(niceCeiling(1_001)).toBe(2_000);
    expect(niceCeiling(6_000)).toBe(10_000);
  });

  it('draws customers as a line on its own scale, and joined vs left as bars from one baseline on one scale', () => {
    const series = growthSeries(
      reports([
        [10, 10, 0],
        [25, 20, 5],
        [40, 18, 3],
      ]),
    );
    const g = growthGeometry(series);
    expect(g.width).toBe(series.length * CHART_COLUMN);
    expect(g.height).toBe(CHART_HEIGHT);
    expect(g.customersMax).toBe(niceCeiling(40));
    expect(g.line.startsWith(`M${CHART_COLUMN / 2},`)).toBe(true);
    expect(g.line.split('L')).toHaveLength(series.length);
    expect(g.area.endsWith('Z')).toBe(true);
    // One scale for both directions: the biggest joined month reaches the top, the biggest left month the bottom.
    expect(g.joinedMax).toBe(20);
    expect(g.leftMax).toBe(5);
    expect(g.baseline).toBeCloseTo((20 / 25) * CHART_HEIGHT, 1);
    const tallest = g.bars[1]!;
    expect(tallest.joinedY).toBeCloseTo(0, 1);
    expect(tallest.leftY + tallest.leftHeight).toBeCloseTo(CHART_HEIGHT, 1);
    for (const [i, bar] of g.bars.entries()) {
      expect(bar.joinedY + bar.joinedHeight).toBeCloseTo(g.baseline, 1);
      expect(bar.joinedHeight / series[i]!.joined).toBeCloseTo(tallest.joinedHeight / 20, 1);
      if (series[i]!.left > 0) expect(bar.leftHeight / series[i]!.left).toBeCloseTo(tallest.joinedHeight / 20, 1);
      expect(bar.x).toBeGreaterThanOrEqual(i * CHART_COLUMN);
      expect(bar.x + bar.width).toBeLessThanOrEqual((i + 1) * CHART_COLUMN);
    }
    // Nothing joined or left: no bars to scale, the baseline in the middle.
    const flat = growthGeometry(growthSeries(reports([[0, 0, 0]])));
    expect(flat.baseline).toBe(CHART_HEIGHT / 2);
    expect(flat.bars[0]!.joinedHeight).toBe(0);
    expect(growthGeometry([]).line).toBe('');
  });
});

describe('happiness', () => {
  it('counts each bucket and words the top reasons, naming the area where one holds most of them', () => {
    const { state, cabinet } = litTown();
    const corner = cornerName(state.city, state.network.cabinets[0]!.node);
    const report: HappinessReport = {
      happy: 12,
      okay: 30,
      unhappy: 6,
      reasons: [
        { reason: 'outages', bucket: 'unhappy', units: 5, cabinet },
        { reason: 'goodDeal', bucket: 'happy', units: 12, cabinet: null },
        { reason: 'priceStep', bucket: 'unhappy', units: 1, cabinet: 9_999 },
      ],
      areas: [],
    };
    const view = happinessView(state, report);
    expect(view).toMatchObject({ happy: 12, okay: 30, unhappy: 6, total: 48, summary: 'Happy 12, okay 30, unhappy 6.' });
    expect(view.reasons).toEqual([
      { reason: 'outages', bucket: 'unhappy', units: 5, cabinet, place: corner, text: `${HAPPINESS_WORDS.outages.unhappy} (${corner})`, count: '5 customers' },
      { reason: 'goodDeal', bucket: 'happy', units: 12, cabinet: null, place: null, text: HAPPINESS_WORDS.goodDeal.happy, count: '12 customers' },
      // A cabinet that is gone: no area, so no Show me.
      { reason: 'priceStep', bucket: 'unhappy', units: 1, cabinet: null, place: null, text: HAPPINESS_WORDS.priceStep.unhappy, count: '1 customer' },
    ]);
    expect(happinessView(state, { happy: 0, okay: 0, unhappy: 0, reasons: [], areas: [] }).summary).toBe('No customers yet.');
  });

  it('reads the sim\'s report as it stands', () => {
    const { state } = litTown();
    const report = happinessReport(state);
    const view = happinessView(state, report);
    expect(view.total).toBe(subscriberUnits(state));
    expect(view.happy + view.okay + view.unhappy).toBe(view.total);
    expect(view.reasons.map((r) => r.units)).toEqual(report.reasons.map((r) => r.units));
  });
});

describe('why homes haven\'t switched', () => {
  it('lists each reason with its count and the lever that addresses it', () => {
    const { state, cabinet } = litTown();
    const corner = cornerName(state.city, state.network.cabinets[0]!.node);
    const reasons = reasonsOf({ unaware: 40, deciding: 20, notWorth: 20, tooExpensive: 10, waiting: 10, passings: 200, subscribed: 100 }, [
      { cabinet, unaware: 40, deciding: 20, notWorth: 20, tooExpensive: 10, waiting: 10, unsigned: 100, passings: 200, subscribed: 100, notLit: 0 },
    ]);
    const rows = switchRows(state, reasons);
    expect(rows.map((r) => r.key)).toEqual(['unaware', 'deciding', 'notWorth', 'tooExpensive', 'waiting']);
    expect(rows.map((r) => [r.label, r.lever])).toEqual([
      ["Don't know you yet", 'Marketing or a neighborhood campaign'],
      ["Know you, haven't switched yet", 'Time and word of mouth; referral credits, a campaign or lower prices speed it up'],
      ['Not worth switching at your price', 'Lower prices or an intro promo'],
      ['Too expensive for them', 'A cheaper plan'],
      ['Waiting for install', 'Add a splitter where a cabinet is full, or keep cash for installs'],
    ]);
    expect(rows.map((r) => r.count)).toEqual([40, 20, 20, 10, 10]);
    expect(rows[0]!.countText).toBe('40 homes');
    expect(rows.map((r) => r.share)).toEqual([0.4, 0.2, 0.2, 0.1, 0.1]);
    expect(rows[0]!.links).toEqual([
      { kind: 'section', section: 'marketing', label: 'Marketing' },
      { kind: 'section', section: 'areas', label: 'Campaigns' },
    ]);
    expect(rows[1]!.links).toEqual([
      { kind: 'section', section: 'referrals', label: 'Referral credits' },
      { kind: 'section', section: 'areas', label: 'Campaigns' },
    ]);
    expect(rows[2]!.links).toEqual([{ kind: 'pricing', label: 'Open Pricing' }]);
    expect(rows[3]!.links).toEqual([{ kind: 'pricing', label: 'Open Pricing' }]);
    expect(rows[4]!.links).toEqual([{ kind: 'showMe', cabinet, label: 'Show me', place: corner }]);
    expect(switchIntro(reasons)).toBe("100 homes you can sell to haven't signed up yet.");
  });

  it('adds Not lit yet only when there are such homes, and has no Show me with nobody waiting', () => {
    const { state } = litTown();
    const without = switchRows(state, reasonsOf({ notWorth: 5, passings: 10, subscribed: 5 }));
    expect(without.map((r) => r.key)).not.toContain('notLit');
    expect(without.find((r) => r.key === 'waiting')!.links).toEqual([]);
    const withNotLit = switchRows(state, reasonsOf({ notWorth: 5, passings: 10, subscribed: 5, notLit: 15 }));
    const notLit = withNotLit.at(-1)!;
    expect(notLit).toMatchObject({ key: 'notLit', label: SWITCH_WORDS.notLit.label, count: 15, share: 0.75, links: [] });
    // Shares of every home counted add up to one.
    expect(withNotLit.reduce((sum, r) => sum + r.share, 0)).toBeCloseTo(1, 9);
  });

  it('matches the sim\'s reasons on a lit town, and says plainly when there is nothing to explain', () => {
    const { state } = litTown();
    const reasons = whyNotSwitched(state);
    const rows = switchRows(state, reasons);
    for (const row of rows) expect(row.count).toBe(reasons.overall[row.key]);
    expect(switchIntro(reasonsOf({}))).toBe('No homes on your fiber yet: build a street and light it.');
    expect(switchIntro(reasonsOf({ passings: 10, subscribed: 10 }))).toBe('Every home you can sell to is a customer.');
    expect(switchIntro(reasonsOf({ passings: 10, subscribed: 10, notLit: 4 }))).toContain('More are on the way');
    expect(switchIntro(reasonsOf({ unaware: 1, passings: 10, subscribed: 9 }))).toBe("1 home you can sell to hasn't signed up yet.");
  });
});

describe('areas and campaigns', () => {
  const quote = (over: Partial<CampaignQuote> = {}): CampaignQuote => ({
    ok: true,
    reasons: [],
    cabinet: 1,
    cost: 1_440,
    unsignedUnits: 120,
    unawareUnits: 60,
    extraSignups: 18.4,
    splitterCost: 0,
    costPerCustomer: 78,
    valueGained: 2_000,
    pays: true,
    availableDay: null,
    ...over,
  });
  const area = (over: Partial<CustomerArea> = {}): CustomerArea => ({
    cabinet: 1,
    node: 0,
    passings: 200,
    subscribed: 80,
    takeRate: 0.4,
    monthsLit: 14,
    subscribedBefore: 70,
    campaign: null,
    ...over,
  });

  it('quotes a campaign on the button: cost, about how many more customers, about how much each, and whether it pays', () => {
    const b = campaignButton(quote(), area(), 300);
    expect(b).toEqual({
      label: 'Run a campaign',
      disabled: false,
      reason: null,
      line: `Costs ${formatMoney(1_440)}: about 18 more customers in ${horizonWords()}, about ${formatMoney(78)} each. Pays for itself within ${horizonWords()}.`,
      status: null,
    });
    expect(campaignButton(quote({ pays: false }), area(), 300).line).toContain(`Won't pay for itself within ${horizonWords()}.`);
    expect(campaignButton(quote({ extraSignups: 0.2, costPerCustomer: 7_200 }), area(), 300).line).toBe(
      `Costs ${formatMoney(1_440)}: hardly any more customers here in ${horizonWords()}. Pays for itself within ${horizonWords()}.`,
    );
  });

  it('disables the button with the quote\'s reason, and dates a running campaign or the next one allowed', () => {
    const short = campaignButton(quote({ ok: false, reasons: ['Not enough cash: the campaign costs $1,440, you have $100'] }), area(), 300);
    expect(short.disabled).toBe(true);
    expect(short.reason).toBe('Not enough cash: the campaign costs $1,440, you have $100');
    expect(short.line).not.toBe('');
    const campaign = { cabinet: 1, startDay: 250, endDay: 372, cooldownUntil: 492, cost: 1_440, units: 120 };
    const running = campaignButton(quote({ ok: false, reasons: ['A campaign is already running there'], availableDay: 492 }), area({ campaign }), 300);
    expect(running).toMatchObject({ disabled: true, reason: 'A campaign is already running there', line: '', status: `A campaign runs here until ${formatDate(372)}.` });
    const resting = campaignButton(quote({ ok: false, reasons: ['A campaign ran there recently: the area needs a rest first'], availableDay: 492 }), area({ campaign }), 400);
    expect(resting.status).toBe(`Next campaign from ${formatDate(492)}.`);
    expect(resting.disabled).toBe(true);
    // Not quoted yet: disabled, nothing claimed.
    expect(campaignButton(null, area(), 300)).toEqual({ label: 'Run a campaign', disabled: true, reason: null, line: '', status: null });
  });

  it('describes each area: corner, homes, share signed, months lit and the trend', () => {
    const { state } = litTown();
    const corner = cornerName(state.city, 0);
    const row = areaRow(state, area(), quote());
    expect(row).toMatchObject({ cabinet: 1, place: corner, trend: 10, trendText: `+10 in ${AREA_TREND_MONTHS} months`, trendTone: 'up' });
    expect(row.facts).toBe(`200 homes · ${formatPercent(0.4)} are customers · lit 14 months`);
    expect(areaRow(state, area({ subscribedBefore: null }), null)).toMatchObject({ trend: null, trendText: 'New', trendTone: 'new' });
    expect(areaRow(state, area({ subscribedBefore: 80 }), null)).toMatchObject({ trend: 0, trendText: `No change in ${AREA_TREND_MONTHS} months`, trendTone: 'flat' });
    expect(areaRow(state, area({ subscribedBefore: 83 }), null)).toMatchObject({ trend: -3, trendText: `-3 in ${AREA_TREND_MONTHS} months`, trendTone: 'down' });
    expect(areaRow(state, area({ monthsLit: 0 }), null).facts).toContain('lit this month');
  });

  it('follows the sim: a campaign bought through runCampaign holds the button until its cooldown', () => {
    const { state, cabinet } = litTown();
    const [first] = customerAreas(state);
    const before = quoteCampaign(state, cabinet);
    expect(before.ok).toBe(true);
    const open = areaRow(state, first!, before);
    expect(open.campaign.disabled).toBe(false);
    expect(open.campaign.line).toContain(`Costs ${formatMoney(before.cost)}`);
    expect(applyCommand(state, { type: 'runCampaign', cabinet }).ok).toBe(true);
    const [after] = customerAreas(state);
    const held = areaRow(state, after!, quoteCampaign(state, cabinet));
    expect(held.campaign.disabled).toBe(true);
    expect(held.campaign.reason).toBe('A campaign is already running there');
    expect(held.campaign.status).toBe(`A campaign runs here until ${formatDate(after!.campaign!.endDay)}.`);
    expect(campaignLengthWords()).toBe(`about ${Math.round((CAMPAIGN_DAYS * 12) / 365)} months`);
  });
});

describe('the marketing budget (moved here from the pricing panel)', () => {
  it('checks a typed budget exactly as setMarketing will', () => {
    const budgets = [-1, 0, 1_500, MARKETING_MAX_PER_MONTH, MARKETING_MAX_PER_MONTH + 1, 10.5, Number.NaN, Number.POSITIVE_INFINITY];
    for (const perMonth of budgets) {
      const state = newGame(1, { city: makeGridCity() });
      const accepted = applyCommand(state, { type: 'setMarketing', perMonth }).ok;
      expect(marketingProblem(perMonth) === null, String(perMonth)).toBe(accepted);
    }
    expect(marketingProblem(-1)).toBe(`Marketing must be a whole number from $0 to ${formatMoney(MARKETING_MAX_PER_MONTH)} a month`);
  });

  const mq = (over: Partial<MarketingQuote> = {}): MarketingQuote => ({
    ok: true,
    reasons: [],
    perMonth: 1_500,
    months: CUSTOMER_QUOTE_MONTHS,
    signupsPerMonth: 12.3,
    extraPerMonth: 4.1,
    splitterCost: 0,
    costPerCustomer: 366,
    ...over,
  });

  it('forecasts what a budget brings: new customers a month and the cost per new customer it brings', () => {
    expect(marketingForecast(mq())).toBe(`At ${formatMoney(1_500)} a month: about 12 new customers a month, about ${formatMoney(366)} per new customer it brings.`);
    expect(marketingForecast(mq({ perMonth: 0, extraPerMonth: 0, costPerCustomer: null, signupsPerMonth: 8 }))).toBe('At $0 a month: about 8 new customers a month, from neighbors and time alone.');
    expect(marketingForecast(mq({ extraPerMonth: 0, costPerCustomer: null }))).toBe(
      `At ${formatMoney(1_500)} a month: about 12 new customers a month, but marketing adds hardly any of them: most homes on your lit streets already know you.`,
    );
    // Fewer extra customers than the count's floor: never a price per customer it says hardly come (round 4c/4d check:
    // "about 3 new customers a month, about $23,360 per new customer it brings" at $500 with most homes aware).
    for (const extraPerMonth of [0.011, 0.0214, 0.05]) {
      const few = marketingForecast(mq({ perMonth: 500, signupsPerMonth: 3.2, extraPerMonth, costPerCustomer: Math.round(500 / extraPerMonth) }));
      expect(few).toBe(`At ${formatMoney(500)} a month: about 3 new customers a month, but marketing adds hardly any of them: most homes on your lit streets already know you.`);
    }
    expect(marketingForecast(mq({ extraPerMonth: 0.06, costPerCustomer: 25_000 }))).toContain(`about ${formatMoney(25_000)} per new customer it brings`);
    expect(marketingForecast(mq({ signupsPerMonth: 1 }))).toContain('about 1 new customer a month');
    expect(marketingForecast(mq({ signupsPerMonth: 0.3 }))).toContain('less than one new customer a month');
    expect(marketingForecast(mq({ signupsPerMonth: 0 }))).toContain('no new customers a month');
    expect(marketingForecast(mq({ ok: false, reasons: ['Game over'] }))).toBe('');
  });

  it('with nothing lit, says marketing helps once a street is lit (never "no new customers, but hardly any of them")', () => {
    const state = newGame(12345);
    const header = customersHeader(state, whyNotSwitched(state));
    expect(header.share).toBeNull();
    for (const perMonth of [MARKETING_STEP, 2 * MARKETING_STEP, MARKETING_MAX_PER_MONTH]) {
      const q = quoteMarketing(state, perMonth);
      expect(q.ok).toBe(true);
      expect(marketingForecast(q, header.share !== null)).toBe(MARKETING_NOTHING_LIT);
      expect(marketingStepLine(q, quoteMarketing(state, perMonth + MARKETING_STEP), quoteMarketing(state, perMonth - MARKETING_STEP), header.share !== null)).toBe('');
    }
    expect(MARKETING_NOTHING_LIT).not.toMatch(/already know you|hardly any/);
    // Once something is lit, the forecast speaks again.
    const { state: lit } = litTown();
    const litHeader = customersHeader(lit, whyNotSwitched(lit));
    expect(litHeader.share).not.toBeNull();
    expect(marketingForecast(quoteMarketing(lit, 1_000), litHeader.share !== null)).toMatch(/^At \$1,000 a month: /);
  });

  it('says what one step up or down would do', () => {
    const base = mq();
    expect(marketingStepLine(base, mq({ signupsPerMonth: 14.5 }), mq({ signupsPerMonth: 12 }))).toBe(
      `${formatMoney(MARKETING_STEP)} more a month: about 2 more a month. ${formatMoney(MARKETING_STEP)} less: less than one fewer a month.`,
    );
    // At the maximum there is no step up; at $0 no step down.
    expect(marketingStepLine(base, null, mq({ signupsPerMonth: 10 }))).toBe(`${formatMoney(MARKETING_STEP)} less: about 2 fewer a month.`);
    expect(marketingStepLine(base, mq({ signupsPerMonth: 12.3 }), null)).toBe(`${formatMoney(MARKETING_STEP)} more a month: about the same.`);
    expect(marketingStepLine(mq({ ok: false }), mq(), mq())).toBe('');
  });

  it('forecasts from the sim\'s quote on a lit town', () => {
    const { state } = litTown();
    const q = quoteMarketing(state, 2_000);
    const line = marketingForecast(q);
    expect(line.startsWith(`At ${formatMoney(2_000)} a month: `)).toBe(true);
    if (q.costPerCustomer !== null) expect(line).toContain(`about ${formatMoney(q.costPerCustomer)} per new customer it brings`);
    const up = quoteMarketing(state, 2_000 + MARKETING_STEP);
    const down = quoteMarketing(state, 2_000 - MARKETING_STEP);
    expect(up.signupsPerMonth).toBeGreaterThanOrEqual(q.signupsPerMonth);
    expect(marketingStepLine(q, up, down)).toMatch(new RegExp(`^\\${formatMoney(MARKETING_STEP)} more a month: .+\\. \\${formatMoney(MARKETING_STEP)} less: .+\\.$`));
  });
});

describe('support level and referral credits', () => {
  const sq = (over: Partial<SupportQuote> = {}): SupportQuote => ({
    level: 'great',
    months: SUPPORT_QUOTE_MONTHS,
    ok: true,
    reasons: [],
    costPerMonth: 700,
    costChange: 300,
    happy: 90,
    okay: 10,
    unhappy: 0,
    cancellationsPerMonth: 1.4,
    signupsPerMonth: 9,
    splitterCost: 0,
    netValue: 1_234,
    pays: true,
    ...over,
  });

  it('offers each level with its price, its effect and how it compares with the level now', () => {
    expect(supportOption('good', 100, sq())).toEqual({
      level: 'great',
      name: SUPPORT_LEVELS.great.name,
      current: false,
      price: `${formatMoney(SUPPORT_LEVELS.great.costPerSub)} a customer a month`,
      effect: `${formatMoney(700)} a month for your 100 customers. About 1 cancels a month; 90 happy.`,
      verdict: `Better than now by about ${roughMoney(1_234)} over ${horizonWords(SUPPORT_QUOTE_MONTHS)}.`,
    });
    expect(supportOption('good', 100, sq({ level: 'basic', netValue: -420, pays: false })).verdict).toBe(`Worse than now by about ${roughMoney(420)} over ${horizonWords(SUPPORT_QUOTE_MONTHS)}.`);
    // Round 4c/4d fix: the support quote looks three years ahead, and the verdict says so.
    expect(horizonWords(SUPPORT_QUOTE_MONTHS)).toBe('three years');
    expect(horizonWords(CUSTOMER_QUOTE_MONTHS)).toBe('a year');
    expect(supportOption('great', 100, sq()).verdict).toBe('Your level now.');
    expect(supportOption('great', 100, sq()).current).toBe(true);
    expect(supportOption('good', 100, sq({ cancellationsPerMonth: 3.2 })).effect).toContain('About 3 cancel a month');
    expect(supportOption('good', 100, sq({ cancellationsPerMonth: 0.2 })).effect).toContain('Less than one cancel a month');
    expect(supportOption('good', 100, sq({ cancellationsPerMonth: 0 })).effect).toContain('Hardly anyone cancels');
    expect(supportOption('good', 0, sq({ costPerMonth: 0, netValue: 0 }))).toMatchObject({ effect: 'No customers yet, so it costs nothing today.', verdict: `About the same as now over ${horizonWords(SUPPORT_QUOTE_MONTHS)}.` });
  });

  it('reads every level from the sim\'s quotes', () => {
    const { state } = litTown();
    const units = subscriberUnits(state);
    for (const level of SUPPORT_LEVEL_IDS) {
      const q = quoteSupport(state, level);
      const option = supportOption(state.customers.supportLevel, units, q);
      expect(option.current).toBe(level === state.customers.supportLevel);
      expect(option.effect).toContain(formatMoney(q.costPerMonth));
      expect(option.price).toBe(`${formatMoney(SUPPORT_LEVELS[level].costPerSub)} a customer a month`);
    }
  });

  const rq = (over: Partial<ReferralQuote> = {}): ReferralQuote => ({
    on: true,
    ok: true,
    reasons: [],
    referralsPerMonth: 3.2,
    costPerMonth: 3.2 * 2 * REFERRAL_CREDIT,
    extraPerMonth: 1.1,
    splitterCost: 0,
    costPerCustomer: 145,
    netValue: 480,
    pays: true,
    ...over,
  });

  it('words referral credits: what they would bring and whether turning them on (or keeping them) pays', () => {
    const lines = referralLines(false, rq());
    expect(lines).toEqual({
      on: false,
      state: 'Off',
      forecast: `About 3 referrals a month, about ${roughMoney(3.2 * 2 * REFERRAL_CREDIT)} a month in credits: about 1 more customer a month (about ${formatMoney(145)} each).`,
      verdict: `Turning them on: worth about ${roughMoney(480)} over ${horizonWords()}.`,
    });
    expect(referralLines(true, rq({ netValue: -300, pays: false })).verdict).toBe(`Keeping them on: costs about ${roughMoney(300)} more than it brings over ${horizonWords()}.`);
    expect(referralLines(true, rq({ netValue: 10 })).verdict).toBe(`Keeping them on: about break-even over ${horizonWords()}.`);
    expect(referralLines(false, rq({ referralsPerMonth: 0, costPerMonth: 0, extraPerMonth: 0, costPerCustomer: null })).forecast).toBe(
      'Hardly any referrals expected now, so credits would cost little and bring few customers.',
    );
    expect(referralLines(true, rq()).state).toBe('On');
    // Fewer extra customers than the count's floor: never "no more customers a month (about $987 each)".
    for (const extraPerMonth of [0.011, 0.03, 0.05]) {
      const few = referralLines(false, rq({ referralsPerMonth: 0.6, costPerMonth: 30, extraPerMonth, costPerCustomer: Math.round(30 / extraPerMonth) }));
      expect(few.forecast).toBe(`About 1 referral a month, about ${roughMoney(30)} a month in credits: hardly any of them extra.`);
      expect(few.forecast).not.toMatch(/no more customers|each\)/);
    }
    // A few dollars of credits never round to "about $0".
    expect(referralLines(false, rq({ referralsPerMonth: 0.07, costPerMonth: 3.7, extraPerMonth: 0.01, costPerCustomer: 370 })).forecast).toBe(
      'Less than one referral a month, a few dollars a month in credits: hardly any of them extra.',
    );
    const { state } = litTown();
    const real = referralLines(state.customers.referrals, quoteReferrals(state, true));
    expect(real.state).toBe(state.customers.referrals ? 'On' : 'Off');
  });
});

describe('plain words', () => {
  it('shows no jargon anywhere on the dashboard\'s face', () => {
    const { state, cabinet } = litTown();
    state.finance.reports = reports([
      [10, 10, 0],
      [18, 9, 1],
    ]);
    const reasons = whyNotSwitched(state);
    const texts: string[] = [];
    const h = customersHeader(state, reasons);
    texts.push(h.title, h.change, h.shareLine, growthSummary(growthSeries(state.finance.reports)), switchIntro(reasons));
    for (const row of switchRows(state, reasonsOf({ unaware: 1, deciding: 1, notWorth: 1, tooExpensive: 1, waiting: 1, notLit: 1, passings: 5 }, [{ cabinet, unaware: 1, deciding: 1, notWorth: 1, tooExpensive: 1, waiting: 1, unsigned: 5, passings: 5, subscribed: 0, notLit: 0 }]))) {
      texts.push(row.label, row.countText, row.lever, ...row.links.map((l) => l.label));
    }
    const view = happinessView(state, happinessReport(state));
    texts.push(view.summary, ...view.reasons.map((r) => r.text));
    for (const words of Object.values(HAPPINESS_WORDS)) texts.push(words.happy, words.unhappy);
    for (const a of customerAreas(state)) {
      const row = areaRow(state, a, quoteCampaign(state, a.cabinet));
      texts.push(row.facts, row.trendText, row.campaign.line, row.campaign.reason ?? '', row.campaign.status ?? '');
    }
    texts.push(...Object.values(LEVER_WHAT));
    const q = quoteMarketing(state, 1_000);
    texts.push(marketingForecast(q), marketingStepLine(q, quoteMarketing(state, 1_500), quoteMarketing(state, 500)), marketingProblem(-1) ?? '');
    for (const level of SUPPORT_LEVEL_IDS) {
      const o = supportOption(state.customers.supportLevel, subscriberUnits(state), quoteSupport(state, level));
      texts.push(o.name, o.price, o.effect, o.verdict);
    }
    const r = referralLines(false, quoteReferrals(state, true));
    texts.push(r.forecast, r.verdict, aboutCount(3));
    for (const text of texts) expect(text, text).not.toMatch(CUSTOMERS_JARGON);
    expect(texts.join(' ')).not.toMatch(/\p{Extended_Pictographic}/u);
  });
});
