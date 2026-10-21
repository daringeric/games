// The span panel's model: what it shows for a live span (facts, outage and
// rebuild status, storm history, storm risk as either method, pole rent) and
// the rebuild-underground action priced by quoteConvert. The DOM part is
// covered end to end (e2e/build-tools.spec.ts).

import { describe, expect, it } from 'vitest';
import { POLE_RENT_PER_POLE_PER_MONTH } from '../sim/balance';
import { formatDate } from '../sim/calendar';
import { newGame } from '../sim/game';
import { quoteConvert, spanOnSegment } from '../sim/network';
import { polesOnSegment } from '../sim/streets';
import { addLivePlant, makeGridCity } from '../sim/testing/fixtures';
import type { GameState } from '../sim/types';
import { exposureBand, segmentExposure, stormAreaName, stormRisk } from '../sim/weather';
import { formatMoney } from './format';
import { spanPanelModel } from './spanPanel';
import { EXPOSURE_LABEL, stormRiskText } from './tools';

/** The grid with every street live (1st St's first block aerial), a cabinet at the CO, and a subscriber on that block. */
function wired(): GameState {
  const state = newGame(7, { city: makeGridCity() });
  addLivePlant(state);
  spanOnSegment(state, 0)!.method = 'aerial';
  const parcel = state.city.parcels.find((p) => p.segment === 0)!.id;
  state.sales.accounts = [{ parcel, cabinet: state.network.cabinets[0]!.id, tierUnits: { fiber500: 1, fiber1g: 0, fiber2g: 0 }, since: 0, locks: [] }];
  state.day = 500;
  state.network.version++;
  return state;
}

describe('spanPanelModel', () => {
  it('has nothing for an unknown span or cable still being built', () => {
    const state = wired();
    expect(spanPanelModel(state, 9_999)).toBeNull();
    const span = spanOnSegment(state, 0)!;
    Object.assign(span, { stage: 'constructing', stageDaysLeft: 2, liveDay: null });
    expect(spanPanelModel(state, span.id)).toBeNull();
  });

  it('describes a live aerial span: facts, pole rent, storm risk both ways, and the rebuild at its quote', () => {
    const state = wired();
    const span = spanOnSegment(state, 0)!;
    const seg = state.city.segments[0]!;
    const model = spanPanelModel(state, span.id)!;
    expect(model.title).toBe('Cable on 1st St');
    expect(model.method).toBe('aerial');
    expect(model.facts.find((f) => f.label === 'Pole rent')).toMatchObject({
      value: `${formatMoney(polesOnSegment(seg) * POLE_RENT_PER_POLE_PER_MONTH)}/mo`,
    });
    expect(model.status).toEqual([]);
    expect(model.history).toEqual([]);
    expect(model.risk.map((r) => [r.method, r.current, r.repairs])).toEqual([
      ['aerial', true, stormRiskText(stormRisk(state, seg, 'aerial').repairCostPerYear)],
      ['underground', false, stormRiskText(stormRisk(state, seg, 'underground').repairCostPerYear)],
    ]);
    const quote = quoteConvert(state, span.id);
    expect(model.rebuild).toMatchObject({ label: `Rebuild underground: ${formatMoney(quote.cost)}`, ok: true, reasons: [] });
    expect(model.rebuild?.rows.find((r) => r.label === 'Pole rent saved')?.value).toBe(`${formatMoney(quote.poleRentSaved)}/mo`);
    expect(model.rebuild?.rows.find((r) => r.label === 'Repairs avoided')?.value).toBe(`about ${formatMoney(quote.repairsAvoidedPerYear)} a year`);
  });

  it('says why the rebuild cannot go ahead, with the credit line when cash is short', () => {
    const state = wired();
    const span = spanOnSegment(state, 0)!;
    state.finance.cash = 10;
    const model = spanPanelModel(state, span.id)!;
    expect(model.rebuild?.ok).toBe(false);
    expect(model.rebuild?.reasons).toEqual(quoteConvert(state, span.id).reasons);
    expect(model.rebuild?.reasons[0]).toMatch(/^Not enough cash/);
  });

  it('shows an outage with who it cuts off, the storms that hit the span, newest first, and a rebuild under way', () => {
    const state = wired();
    const span = spanOnSegment(state, 0)!;
    state.weather.storms = [
      { id: 3, day: 300, x: 2, y: 0, radius: 9, severity: 1, spans: [span.id], repairCost: 1_000 },
      { id: 4, day: 400, x: 9, y: 3, radius: 9, severity: 2, spans: [span.id + 1], repairCost: 1_000 },
      { id: 5, day: 498, x: 6, y: 2, radius: 20, severity: 3, spans: [span.id, span.id + 2], repairCost: 3_000 },
    ];
    state.weather.nextStormId = 6;
    span.outage = { cause: 'storm', storm: 5, startDay: 498, daysLeft: 2, repairCost: 1_500 };
    span.conversion = { stage: 'constructing', stageDaysLeft: 3, constructDays: 4, cost: 9_000, orderedDay: 480 };
    state.network.version++;
    const model = spanPanelModel(state, span.id)!;
    expect(model.history).toEqual([
      { when: formatDate(498), text: `Major storm near ${stormAreaName(state.city, { x: 6, y: 2 })}: out of service now` },
      { when: formatDate(300), text: `Squall near ${stormAreaName(state.city, { x: 2, y: 0 })}` },
    ]);
    expect(model.status).toEqual([
      { tone: 'danger', text: `Out of service: storm damage, 2 days to repair, ${formatMoney(1_500)}; 1 subscriber cut off` },
      { tone: 'info', text: 'Being rebuilt underground: crews digging, 3 days left. The aerial cable serves until then.' },
    ]);
    expect(model.rebuild?.ok).toBe(false);
    expect(model.rebuild?.reasons).toEqual(['The cable on 1st St is already being rebuilt underground']);
  });

  it('offers no rebuild for underground cable and pays no pole rent', () => {
    const state = wired();
    const span = spanOnSegment(state, 1)!;
    const model = spanPanelModel(state, span.id)!;
    expect(model.method).toBe('underground');
    expect(model.rebuild).toBeNull();
    expect(model.facts.find((f) => f.label === 'Pole rent')?.value).toBe('None');
    expect(model.risk.find((r) => r.current)?.method).toBe('underground');
  });

  it("shows the street's storm exposure, and the rebuild quote's, toned when exposed", () => {
    // Rural streets on the map's edge: exposed.
    const state = wired();
    for (const seg of state.city.segments) seg.zone = 'rural';
    const span = spanOnSegment(state, 0)!;
    const model = spanPanelModel(state, span.id)!;
    expect(exposureBand(segmentExposure(state.city, 0))).toBe('exposed');
    expect(model.facts.find((f) => f.label === 'Storm exposure')).toEqual({ label: 'Storm exposure', value: 'Exposed', tone: 'exposed', sub: 'storms hit here more' });
    const quote = quoteConvert(state, span.id);
    expect(quote.exposure).toBe('exposed');
    expect(model.rebuild?.rows.find((r) => r.label === 'Street exposure')).toEqual({ label: 'Street exposure', value: 'Exposed', tone: 'exposed', sub: 'where burying pays most' });

    // The default grid's own streets: whatever band they have, the panel names it, untoned unless exposed.
    const plain = wired();
    const plainSpan = spanOnSegment(plain, 0)!;
    const band = exposureBand(segmentExposure(plain.city, 0));
    const facts = spanPanelModel(plain, plainSpan.id)!;
    expect(facts.facts.find((f) => f.label === 'Storm exposure')?.value).toBe(EXPOSURE_LABEL[band]);
    expect(facts.rebuild?.rows.find((r) => r.label === 'Street exposure')?.value).toBe(EXPOSURE_LABEL[quoteConvert(plain, plainSpan.id).exposure]);
    // Underground spans show their street's exposure too.
    const ug = spanPanelModel(plain, spanOnSegment(plain, 1)!.id)!;
    expect(ug.facts.find((f) => f.label === 'Storm exposure')?.value).toBe(EXPOSURE_LABEL[exposureBand(segmentExposure(plain.city, 1))]);
  });
});
