# Light Speed Tycoon

A fun-first city-builder/tycoon where you build and run a fiber ISP in a town that grows on its own. Design: [`docs/light-speed-tycoon/DESIGN.md`](../docs/light-speed-tycoon/DESIGN.md).

## Run it

```sh
npm install
npm run dev        # http://localhost:5173
npm run check      # typecheck + unit tests + production build
npm run e2e        # Playwright smoke tests against the production build
```

A first launch (no saved game) opens the start screen: company name, difficulty (starting cash) and town. Pages with `?debug=1` (every e2e test) skip it and start a Seed-round game at once unless the URL also has `?start=1`; the menu's New game always shows it. `?seed=N` plays that town in an autosave of its own.

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
    network.ts    cable/cabinet/splitter/OLT orders, build pipeline, service (what's lit)
    coverage.ts   cabinet reach and the placement preview
    sales.ts      subscribers: signups, installs, ports, billing accruals, churn, pricing
    customers.ts  switching by deal value, awareness, why homes haven't switched, happiness, and the growth
                  levers (neighborhood campaigns, support level, referral credits) with their forecasts
    finance.ts    ledger, monthly close, insolvency
    overhead.ts   overhead that scales with the company: base, per customer (with the support level), per unit of plant
    debt.ts       credit line, term loans, underwriting, pricing, covenants, default,
                  the frozen-line sweep and loan acceleration
    weather.ts    storms, dig-ins, span outages and repairs, storm exposure
    terrain.ts    the grove field the map's trees are drawn from (wooded streets are storm-exposed)
    incumbent.ts  the incumbent cable company's local promos
    advisor.ts    the month-end briefing and the advisor's ranked suggestions, snoozes and repeats
    company.ts    the player's company: name rules, suggested names, difficulty levels
    metrics.ts    cost-per-passing bands and report KPIs
    milestones.ts scorecard milestones
    notices.ts    player-facing notices raised by the sim
    game.ts       newGame / applyCommand / tick
    save.ts       serialize / deserialize, v1 -> v2 -> v3 -> v4 migration (v4 extended in place in rounds 4b and 4c/4d)
    testing/      fixtures for unit tests (incl. frozen schemaVersion 1, 2 and 3 saves)
    tuning/       headless bots + balance targets (TUNE_REPORT=1 prints per-seed numbers)
  render/       PixiJS scene drawing and themes
  ui/           HTML/CSS HUD, tools, input, storage
  main.ts       bootstrap
e2e/            Playwright tests
```

## Architecture rules

- **The sim is pure.** Nothing under `src/sim` touches the DOM, Pixi, timers, `Math.random()` or `Date`. Randomness comes from `Rng` streams whose state lives in `GameState`, so a seed plus a command log replays a game exactly.
- **All player actions are `Command`s** sent through `applyCommand`. The UI never mutates `GameState` directly.
- **`GameState` is plain JSON data.** No classes, `Map`s or `Set`s in saved state. Derived data (`ServiceSnapshot`) is recomputed and memoized on `network.version`.
- **Units:** feet, whole dollars, days. Day 0 is Jan 1, 2027. Interest rates are whole basis points (725 = 7.25% a year).
- **IDs:** nodes, segments and parcels have `id === index`. Spans and cabinets draw from `state.nextId`; term loans from `state.debt.nextLoanId`.
- **Render reads, never writes.** Renderers take state and draw it. Input handlers turn pointer events into `Command`s.
- **Deterministic math.** The sim uses arithmetic and `Math.sqrt` only (no `Math.pow`/`log`/`exp`/trig, no `**`), so a seed and a command log replay identically on every engine. `src/sim/purity.test.ts` scans the sim sources for this and the purity rule above.
- **Balance is symbolic.** Tests reference `balance.ts` constants (or quote results), never literal dollar amounts, so tuning never breaks them.
