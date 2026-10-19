import { describe, expect, it } from 'vitest';
import { applyCommand, newGame, runDays } from './game';
import { getService } from './network';
import { deserialize, fnv1a, hashState, SaveError, serialize } from './save';
import { makeGridCity } from './testing/fixtures';
import type { GridCityOptions } from './testing/fixtures';
import type { GameState } from './types';

// Parsed saves are untyped JSON; the corruption tests poke at them freely.
type Save = any;

/**
 * A game mid-flight: live, constructing/permitting and cancelled spans, a live
 * cabinet, a closed month and open month-to-date entries. Default grid:
 * horizontal segments 0..8, vertical 9..16, CO at node 0.
 */
function playedGame(cityOpts: GridCityOptions = {}): GameState {
  const state = newGame(7, { city: makeGridCity(cityOpts) });
  applyCommand(state, { type: 'placeCabinet', node: 0 });
  applyCommand(state, { type: 'layCable', segments: [0], method: 'underground' });
  applyCommand(state, { type: 'layCable', segments: [2], method: 'aerial' });
  runDays(state, 50);
  applyCommand(state, { type: 'layCable', segments: [1], method: 'underground' });
  runDays(state, 3);
  return state;
}

function expectSaveError(json: string, message: RegExp): void {
  let error: unknown;
  try {
    deserialize(json);
  } catch (err) {
    error = err;
  }
  expect(error).toBeInstanceOf(SaveError);
  expect((error as SaveError).name).toBe('SaveError');
  expect((error as SaveError).message).toMatch(message);
}

describe('serialize / deserialize', () => {
  it('round-trips a fresh game', () => {
    const state = newGame(1, { city: makeGridCity() });
    const loaded = deserialize(serialize(state));
    expect(loaded).toEqual(state);
    expect(serialize(loaded)).toBe(serialize(state));
  });

  it('round-trips a game in progress', () => {
    const state = playedGame();
    // Make sure the save really covers every kind of record.
    expect(state.network.spans.map((s) => s.stage)).toContain('live');
    expect(state.network.spans.map((s) => s.stage)).toContain('permitting');
    expect(state.network.cabinets[0]?.stage).toBe('live');
    expect(state.finance.reports).toHaveLength(1);
    expect(state.finance.monthToDate.length).toBeGreaterThan(0);

    const loaded = deserialize(serialize(state));
    expect(loaded).toEqual(state);
    expect(loaded).not.toBe(state);
    expect(getService(loaded).passings).toBe(getService(state).passings);
  });

  it('writes plain JSON', () => {
    const state = playedGame();
    expect(JSON.parse(serialize(state))).toEqual(state);
  });

  it('continues a reloaded game exactly like the original', () => {
    const original = playedGame();
    const reloaded = deserialize(serialize(original));
    for (const state of [original, reloaded]) {
      // Aerial orders draw make-ready from the saved events stream.
      applyCommand(state, { type: 'layCable', segments: [3, 9], method: 'aerial' });
      applyCommand(state, { type: 'removeSpan', span: 1 });
      runDays(state, 40);
      applyCommand(state, { type: 'layCable', segments: [4, 10], method: 'aerial' });
      applyCommand(state, { type: 'placeCabinet', node: 5 });
      runDays(state, 100);
    }
    expect(hashState(reloaded)).toBe(hashState(original));
    expect(serialize(reloaded)).toBe(serialize(original));
  });
});

describe('hashState', () => {
  it('is 32-bit FNV-1a', () => {
    expect(fnv1a('')).toBe('811c9dc5');
    expect(fnv1a('a')).toBe('e40c292c');
    expect(fnv1a('foobar')).toBe('bf9cf968');
  });

  it('hashes the serialized state as 8 lowercase hex digits', () => {
    const state = playedGame();
    expect(hashState(state)).toBe(fnv1a(serialize(state)));
    expect(hashState(state)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is stable for equal states and changes with any field', () => {
    const state = playedGame();
    const hash = hashState(state);
    expect(hashState(playedGame())).toBe(hash);
    state.finance.cash += 1;
    expect(hashState(state)).not.toBe(hash);
    state.finance.cash -= 1;
    expect(hashState(state)).toBe(hash);
    state.day += 1;
    expect(hashState(state)).not.toBe(hash);
  });
});

describe('deserialize errors', () => {
  const good = serialize(playedGame());
  /** The good save with one change applied. */
  const corrupted = (mutate: (save: Save) => void): string => {
    const save: Save = JSON.parse(good);
    mutate(save);
    return JSON.stringify(save);
  };

  it.each(['', '{', 'not json', '{"schemaVersion":1,}'])('rejects bad JSON %j', (json) => {
    expectSaveError(json, /not valid JSON/);
  });

  it.each(['null', '42', '"save"', '[]', 'true'])('rejects a non-object save %s', (json) => {
    expectSaveError(json, /should be a JSON object/);
  });

  it('rejects a missing or unsupported schemaVersion', () => {
    expectSaveError(corrupted((s) => delete s.schemaVersion), /no schemaVersion/);
    expectSaveError(corrupted((s) => (s.schemaVersion = 2)), /Unsupported save version 2 /);
    expectSaveError(corrupted((s) => (s.schemaVersion = 0)), /Unsupported save version 0 /);
    expectSaveError(corrupted((s) => (s.schemaVersion = '1')), /Unsupported save version "1" /);
    expectSaveError(corrupted((s) => (s.schemaVersion = null)), /Unsupported save version null /);
  });

  it('rejects numbers JSON can parse but the sim cannot use', () => {
    expectSaveError(good.replace(/"cash":-?\d+/, '"cash":1e999'), /finance\.cash should be an integer, got Infinity/);
    expectSaveError(good.replace(/"day":\d+/, '"day":1e300'), /day should be an integer >= 0, got 1e\+300/);
  });

  const cases: Array<[string, (save: Save) => void, RegExp]> = [
    // Top level
    ['missing city', (s) => delete s.city, /city should be an object, got nothing/],
    ['missing network', (s) => delete s.network, /network should be an object, got nothing/],
    ['finance as an array', (s) => (s.finance = []), /finance should be an object, got an array/],
    ['negative day', (s) => (s.day = -1), /day should be an integer >= 0, got -1/],
    ['fractional day', (s) => (s.day = 1.5), /day should be an integer >= 0, got 1\.5/],
    ['string seed', (s) => (s.seed = 'x'), /seed should be an integer in 0\.\.4294967295, got "x"/],
    ['missing rng', (s) => delete s.rng, /rng should be an object/],
    ['negative rng state', (s) => (s.rng.events = -1), /rng\.events should be an integer in 0\.\.4294967295/],
    ['rng state past uint32', (s) => (s.rng.events = 2 ** 32), /rng\.events/],
    ['zero nextId', (s) => (s.nextId = 0), /nextId should be an integer >= 1, got 0/],
    // City
    ['numeric city name', (s) => (s.city.name = 5), /city\.name should be a string, got 5/],
    ['zero city width', (s) => (s.city.width = 0), /city\.width should be an integer >= 1/],
    ['missing tileFt', (s) => delete s.city.tileFt, /city\.tileFt should be a number > 0, got nothing/],
    ['nodes not an array', (s) => (s.city.nodes = {}), /city\.nodes should be an array, got an object/],
    ['null node', (s) => (s.city.nodes[0] = null), /city\.nodes\[0\] should be an object, got null/],
    ['node id off its index', (s) => (s.city.nodes[2].id = 5), /city\.nodes\[2\]\.id should be 2 \(its position/],
    ['string node coordinate', (s) => (s.city.nodes[1].x = '4'), /city\.nodes\[1\]\.x should be an integer/],
    ['segment id off its index', (s) => (s.city.segments[3].id = 4), /city\.segments\[3\]\.id should be 3/],
    ['segment endpoint out of range', (s) => (s.city.segments[0].b = 99), /city\.segments\[0\]\.b should be an integer in 0\.\.11, got 99/],
    ['unknown street class', (s) => (s.city.segments[0].streetClass = 'highway'), /streetClass should be one of "arterial", "collector", "local", got "highway"/],
    ['zero-length segment', (s) => (s.city.segments[1].lengthFt = 0), /city\.segments\[1\]\.lengthFt should be a number > 0, got 0/],
    ['string hasPoles', (s) => (s.city.segments[1].hasPoles = 'yes'), /city\.segments\[1\]\.hasPoles should be true or false/],
    ['missing rock flag', (s) => delete s.city.segments[2].rock, /city\.segments\[2\]\.rock should be true or false, got nothing/],
    ['parcel id off its index', (s) => (s.city.parcels[4].id = 0), /city\.parcels\[4\]\.id should be 4/],
    ['parcel segment out of range', (s) => (s.city.parcels[0].segment = 17), /city\.parcels\[0\]\.segment should be an integer in 0\.\.16, got 17/],
    ['unknown parcel kind', (s) => (s.city.parcels[0].kind = 'castle'), /city\.parcels\[0\]\.kind should be one of/],
    ['zero-width parcel', (s) => (s.city.parcels[0].w = 0), /city\.parcels\[0\]\.w should be an integer >= 1/],
    ['fractional units', (s) => (s.city.parcels[0].units = 1.5), /city\.parcels\[0\]\.units/],
    ['unknown zone', (s) => (s.city.parcels[0].zone = 'moon'), /city\.parcels\[0\]\.zone should be one of/],
    ['coNode out of range', (s) => (s.city.coNode = 12), /city\.coNode should be an integer in 0\.\.11, got 12/],
    ['city with no nodes', (s) => (s.city.nodes = []), /city\.segments\[0\]\.a refers to a node, but the city has none/],
    // Network
    ['spans missing', (s) => delete s.network.spans, /network\.spans should be an array, got nothing/],
    ['span on an unknown segment', (s) => (s.network.spans[0].segment = 99), /network\.spans\[0\]\.segment should be an integer in 0\.\.16, got 99/],
    ['span id from the future', (s) => (s.network.spans[0].id = s.nextId), /network\.spans\[0\]\.id should be an integer in 1\.\./],
    ['span and cabinet sharing an id', (s) => (s.network.spans[0].id = s.network.cabinets[0].id), /network\.cabinets\[0\]\.id \d+ is used twice/],
    ['two spans on one segment', (s) => (s.network.spans[1].segment = s.network.spans[0].segment), /network\.spans\[1\]\.segment \d+ already has a span/],
    ['unknown cable method', (s) => (s.network.spans[0].method = 'laser'), /network\.spans\[0\]\.method should be one of "aerial", "underground", got "laser"/],
    ['unknown stage', (s) => (s.network.spans[0].stage = 'done'), /network\.spans\[0\]\.stage should be one of/],
    ['negative stageDaysLeft', (s) => (s.network.spans[0].stageDaysLeft = -3), /network\.spans\[0\]\.stageDaysLeft should be an integer >= 0/],
    ['zero constructDays', (s) => (s.network.spans[0].constructDays = 0), /network\.spans\[0\]\.constructDays should be an integer >= 1/],
    ['negative span cost', (s) => (s.network.spans[0].cost = -5), /network\.spans\[0\]\.cost/],
    [
      'live span without a liveDay',
      (s) => (s.network.spans.find((x: Save) => x.stage === 'live').liveDay = null),
      /liveDay should be an integer >= 0, got null/,
    ],
    [
      'permitting span with a liveDay',
      (s) => (s.network.spans.find((x: Save) => x.stage === 'permitting').liveDay = 3),
      /liveDay should be null while permitting, got 3/,
    ],
    ['cabinet on an unknown node', (s) => (s.network.cabinets[0].node = -1), /network\.cabinets\[0\]\.node should be an integer in 0\.\.11, got -1/],
    [
      'two cabinets on one node',
      (s) => s.network.cabinets.push({ ...s.network.cabinets[0], id: s.nextId++ }),
      /network\.cabinets\[1\]\.node 0 already has a cabinet/,
    ],
    ['string splitters', (s) => (s.network.cabinets[0].splitters = '1'), /network\.cabinets\[0\]\.splitters/],
    ['missing OLT', (s) => delete s.network.olt, /network\.olt should be an object, got nothing/],
    ['unknown PON tech', (s) => (s.network.olt.tech = 'docsis'), /network\.olt\.tech should be one of "gpon", "xgspon"/],
    ['negative network version', (s) => (s.network.version = -1), /network\.version should be an integer >= 0/],
    // Finance
    ['string cash', (s) => (s.finance.cash = 'lots'), /finance\.cash should be an integer, got "lots"/],
    ['fractional cash', (s) => (s.finance.cash = 10.5), /finance\.cash should be an integer, got 10\.5/],
    ['unknown ledger category', (s) => (s.finance.monthToDate[0].category = 'bribes'), /finance\.monthToDate\[0\]\.category should be one of/],
    ['fractional ledger amount', (s) => (s.finance.monthToDate[0].amount = -0.5), /finance\.monthToDate\[0\]\.amount should be an integer/],
    ['numeric memo', (s) => (s.finance.monthToDate[0].memo = 3), /finance\.monthToDate\[0\]\.memo should be a string/],
    ['reports not an array', (s) => (s.finance.reports = {}), /finance\.reports should be an array, got an object/],
    ['report month 13', (s) => (s.finance.reports[0].month = 13), /finance\.reports\[0\]\.month should be an integer in 1\.\.12, got 13/],
    ['report before the game began', (s) => (s.finance.reports[0].year = 1999), /finance\.reports\[0\]\.year should be an integer >= 2027/],
    ['unknown report category', (s) => (s.finance.reports[0].totals.bribes = -1), /finance\.reports\[0\]\.totals key should be one of .*, got "bribes"/],
    ['string report total', (s) => (s.finance.reports[0].totals.construction = '-1'), /finance\.reports\[0\]\.totals\.construction should be an integer/],
    ['negative passings', (s) => (s.finance.reports[0].passings = -1), /finance\.reports\[0\]\.passings should be an integer >= 0/],
  ];

  it.each(cases)('rejects %s', (_name, mutate, message) => {
    expectSaveError(corrupted(mutate), message);
  });

  it('either rejects or loads a playable game for any single-field corruption', () => {
    // A tiny town keeps this exhaustive sweep fast: every path in the save,
    // every kind of wrong value.
    const text = serialize(playedGame({ cols: 1, rows: 1, blockW: 2, blockH: 2 }));
    const paths: Array<Array<string | number>> = [];
    const walk = (value: unknown, path: Array<string | number>): void => {
      if (path.length > 0) paths.push(path);
      if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
      else if (typeof value === 'object' && value !== null) {
        for (const [key, v] of Object.entries(value)) walk(v, [...path, key]);
      }
    };
    walk(JSON.parse(text), []);
    expect(paths.length).toBeGreaterThan(100);

    const DELETE = Symbol('delete');
    const replacements: unknown[] = [DELETE, null, 'x', -1, 0, 1.5, true, {}, []];
    const failures: string[] = [];
    for (const path of paths) {
      for (const replacement of replacements) {
        const save: Save = JSON.parse(text);
        const parent = path.slice(0, -1).reduce((node: Save, key) => node[key], save);
        const key = path[path.length - 1] as string | number;
        if (replacement === DELETE) delete parent[key];
        else parent[key] = replacement;
        const label = `${path.join('.')} = ${replacement === DELETE ? '<deleted>' : JSON.stringify(replacement)}`;

        let state: GameState;
        try {
          state = deserialize(JSON.stringify(save));
        } catch (err) {
          if (!(err instanceof SaveError)) failures.push(`${label}: threw ${String(err)}`);
          continue;
        }
        // Anything that loads must keep playing without crashing.
        try {
          applyCommand(state, { type: 'layCable', segments: [0, 1, 2, 3], method: 'aerial' });
          applyCommand(state, { type: 'placeCabinet', node: 3 });
          applyCommand(state, { type: 'removeSpan', span: 2 });
          runDays(state, 62);
          getService(state);
          deserialize(serialize(state));
        } catch (err) {
          failures.push(`${label}: loaded, then ${String(err)}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
