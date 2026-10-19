# Light Speed Tycoon

A fun-first city-builder/tycoon where you build and run a fiber ISP in a town that grows on its own. Design: [`docs/light-speed-tycoon/DESIGN.md`](../docs/light-speed-tycoon/DESIGN.md).

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run check      # typecheck + unit tests + production build
npm run e2e        # Playwright smoke tests against the production build
```

## Layout

```
src/
  sim/          pure TypeScript simulation — no DOM, no Pixi
    types.ts      shared data model (the contract between modules)
    balance.ts    tunable numbers
    rng.ts        seeded PRNG
    calendar.ts   day <-> date
    citygen.ts    procedural town
    streets.ts    street-graph queries (paths, picking)
    network.ts    cable/cabinet orders, build pipeline, service (what's lit)
    finance.ts    ledger and monthly close
    game.ts       newGame / applyCommand / tick
    save.ts       serialize / deserialize
    testing/      fixtures for unit tests
  render/       PixiJS scene drawing and themes
  ui/           HTML/CSS HUD, tools, input, storage
  main.ts       bootstrap
e2e/            Playwright tests
```

## Architecture rules

- **The sim is pure.** Nothing under `src/sim` touches the DOM, Pixi, timers, `Math.random()` or `Date`. Randomness comes from `Rng` streams whose state lives in `GameState`, so a seed plus a command log replays a game exactly.
- **All player actions are `Command`s** sent through `applyCommand`. The UI never mutates `GameState` directly.
- **`GameState` is plain JSON data.** No classes, `Map`s or `Set`s in saved state. Derived data (`ServiceSnapshot`) is recomputed and memoized on `network.version`.
- **Units:** feet, whole dollars, days. Day 0 is Jan 1, 2027.
- **IDs:** nodes, segments and parcels have `id === index`. Spans and cabinets draw from `state.nextId`.
- **Render reads, never writes.** Renderers take state and draw it. Input handlers turn pointer events into `Command`s.
