# Light Speed Tycoon — Design

A fun-first city-builder/tycoon where you are a fiber builder and provider. The town grows on its own; you build the network, sell service, and compete. Real fiber concepts, simplified for play.

## Pillars

1. **Build it right, profit for decades.** Glass you lay early pays off through every tech upgrade.
2. **Real flavor, not a textbook.** OLTs, splitters, make-ready, take rate, CPGA, MEF circuits — all present, all simplified.
3. **Every layer matters.** Access, core, and transport each create their own capacity and reliability puzzles.

## Settled decisions

| Area | Decision |
|---|---|
| Purpose | Fun game with real flavor (not a training sim) |
| Player role | ISP in a living, self-growing town (not the mayor) |
| Map | Two zooms: **Region** (towns, exchange metro, corridors, transport) and **City** (streets, CO, plant) |
| Maps source | Procedural and fictional; no real places or company names |
| Build model | Core + access (see below) |
| Capacity | Peak-hour demand vs capacity at every layer; congestion drives churn |
| Dedicated services | RFQ board: plan lateral, quote NRC/MRC/term, win on price/interval/competition |
| Outages | Random events + protection (rings, diverse paths, protected waves) |
| Funding | Starting cash + bank debt (interest, covenants) + grants with buildout obligations |
| Competition | Incumbent cable (HFC) + DSL telco from the start; rival fiber overbuilder mid-game |
| Residential sales | Player-set tier lineup, promos, marketing budget; take-rate ramps per street |
| Labor | Construction crews (aerial, underground/boring) and install techs with a visible backlog |
| Tech tree | GPON → XGS-PON → 25/50G-PON; core waves 10G → 100G → 400G |
| Buildings (M1) | Single-family homes, MDUs (fiber to demarc + building router), SMB |
| Right-of-way | Aerial: pole attachment app, make-ready delay, pole rent. Underground: permit delay, higher $/ft, rock zones |
| Goal | Sandbox with optional milestones; lose on bankruptcy or covenant breach |
| Pacing | Real-time, 1 tick = 1 day, pause/1x/2x/4x, monthly close with P&L |
| Platform | Browser, TypeScript + PixiJS |
| Look | **Toy Town**: chunky, sunny top-down vector map with candy-tube fiber, heat-map overlays (chosen over the Lightwave and Field Print directions) |

## Network model

```
Exchange (metro IX)
   │  transport: lease a wave · buy an IRU · build your own route   [Region view]
   ▼
CO site ── core router ── DWDM add/drop
   │  F1 feeder
   ▼
Hub / OLT (PON ports)
   │  F2 distribution, along streets (aerial or underground)
   ▼
Cabinet (splitters, e.g. 1:32)
   │  drop (auto on signup)
   ▼
Home · MDU demarc + building router · SMB
```

- **CO siting:** pick and acquire a CO location per town; cost and constraints vary by site.
- **Transport:** connects a CO to the exchange or to another of your COs. Enables city-to-city expansion and core topology (rings).
- **Capacity chain:** PON port → OLT uplink → core router ports → DWDM waves → transport → IX port. The tightest link is the bottleneck.
- **Dedicated (M3):** DIA, EPL, EVPL, E-Access/ENNI to carriers, waves, dark fiber. Customers include businesses, cell towers, schools, carriers. Won deals carry SLA exposure.

## Economy

- **Revenue:** residential/SMB MRC, MDU bulk, dedicated MRC + NRC, (later) wholesale.
- **Costs:** construction (per ft by method), drops/ONTs, equipment, payroll, pole rent, transport leases, IX ports, marketing, interest, SLA credits.
- **Monthly report:** subs, gross adds, churn, ARPU by product, CPGA, take rate by area, cost per passing vs target, cost per connection, EBITDA, cash, debt covenants.
- **Cost per passing (CPP):** outside-plant build cost (cable, cabinets, splitters) ÷ homes passed; drops/ONTs/install are cost per connection, tracked separately. A tunable target (~$1,000) colors every cable quote and cabinet preview (green ≤ target, amber ≤ 1.5×, red above) and anchors milestones. Scorecard first; lenders price debt off CPP performance once loans land.
- **CO capacity:** each 1:32 splitter consumes one OLT PON port (start: 16 ports = 512 subs). Upgrades at the CO add OLT line cards (+16 ports) and later a second chassis, each with a cost.
- **Cost pressure:** per-pole make-ready on aerial, engineering/permit fees per order, fixed monthly overhead, and a lean starting purse so the starting cash covers only ~25–33% of the town; tuned by headless simulation.
- **Cabinet coverage:** a cabinet serves homes within a street-distance reach (800 ft, tuned so placement matters); splitter ports (32 each) cap subscribers. Placement preview shades the reach and counts homes covered.
- **Competitor response:** incumbents run promos in neighborhoods you enter (ARPU compression); rival overbuilder races for unbuilt areas and RFQs.

## Milestones

| | Scope |
|---|---|
| **M1** One-city access loop | Procedural city; CO given; OLTs, cabinets, aerial/underground cable along streets with make-ready/permits; auto drops; homes/MDUs/SMB; tier pricing + marketing; crews + backlog; peak demand vs capacity; GPON/XGS-PON; cash + loans; incumbent cable + DSL; monthly P&L; milestones; save/load |
| **M2** Core + region | Region map; CO siting in multiple towns; core router + DWDM; transport (lease/IRU/build) to exchange; IX port capacity; wave tech tiers |
| **M3** Dedicated services | RFQ board, lateral planning, quoting, MEF product set, SLAs |
| **M4** Outages + protection | Cuts, storms (aerial-weighted), pole strikes, equipment failure; rings, diverse paths, protected waves; churn + SLA credits |
| **M5** Grants, rival, multi-city | Grant programs with buildout deadlines; rival overbuilder; full city-to-city expansion |

## Technical defaults (Claude's call, revisit if needed)

- **Stack:** Vite + TypeScript + PixiJS; Vitest for the sim; Playwright for UI checks.
- **Architecture:** pure-TS simulation core with no rendering dependencies, run on a fixed daily tick; renderer and UI read sim state. Keeps the sim unit-testable and deterministic.
- **Determinism:** seeded RNG for map generation and events, so a seed reproduces a game.
- **City representation:** street graph (intersections + segments) over a tile grid; parcels attach to segments; cable is placed on segments.
- **Saves:** localStorage autosave + JSON export/import.

## Starting balance (tuned by headless bots, round 2)

Values live in `light-speed-tycoon/src/sim/balance.ts`; `src/sim/tuning/targets.test.ts` checks the targets below on five seeds (1, 2027, 424242, 99, 12345) and `TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts` prints the per-seed numbers.

| Item | Value |
|---|---|
| Start cash | $750,000 (covers ~30% of the town's build-out) |
| Aerial | $11/ft + make-ready $450 per pole (a pole every 150 ft, so ~$3/ft); make-ready 30–90 days, 15% chance of 120–210 |
| Underground (bore) | $28/ft; rock +$22/ft (~$50/ft all-in); city permit 14–45 days |
| Per cable order | engineering $1,500 + pole attachment application $500 (aerial) or city permit $1,000 (underground); fees and make-ready never refunded |
| Cabinet | $28,000 incl. pad and install, plus its first 1:32 splitter; 8 splitter slots |
| Cabinet reach | 800 ft along live cable: the best downtown corner reaches ~500 units, a typical one 150–200; ~17–22 cabinets cover the town |
| Splitter (1:32) | $1,800; takes one OLT PON port; an apartment building's router uses one port for the whole building |
| OLT | 1 line card of 16 PON ports to start; +16 ports per card at $12,000; 8 cards per chassis. Covering a whole town takes 17–22 cabinets, so town-wide expansion needs a card |
| Cost per passing target | $1,000 (green ≤ $1,000, amber ≤ $1,500, red above) |
| Tiers | 500 Mbps $55 · 1 Gig $70 · 2 Gig $95; businesses ×1.5; incumbent cable $75 for 300/20 |
| Target take rate | 0.31 + 0.25 × best tier's value advantage over the incumbent: ~49% of homes at default prices, apartments ×0.8, businesses ×0.6 |
| Signup ramp | each day a lit street closes 1/550 of its gap to the target × (1 + marketing boost, up to 1.5; half of that at $3 per passing per month) |
| Churn | 1.1% a month, rising with price increases over the defaults |
| Installs (connect capex) | home $700 · business $1,100 · apartment $250 per unit + $5,000 building router once |
| Operating costs | overhead $9,000/month; support $4 per subscriber per month; pole rent $2 per pole per month |
| Insolvency | the third month close in a row below $0 ends the game |
| GPON / XGS-PON (later) | 2.5G down shared per PON / 10G symmetric, 1:32 split |
| Peak demand growth (later) | ~20–25% per year per sub |

**Targets and where they landed** (five tuning seeds; in brackets, 100 seeds):

| Target | Band | Result |
|---|---|---|
| Start cash ÷ town build-out (all streets the cheaper way, fees, greedy cabinet cover) | 25–33% mean, 22–36% each seed | 29.7% mean, 28–32% (100 seeds: 29.7%, 26–35%) |
| Cost per passing, dense poled streets, aerial | median $400–600 | $426–514 per seed (100 seeds: median $499) |
| Same streets underground | median $850–1,150 | $941–1,026 (median $988) |
| Rural runs | median ≥ $2,500 (red) | $3,318–5,118 (lowest seed $2,752) |
| Careful play (SMART bot): bankrupt in 5 years | never | never (0 of 100) |
| First month with operating cash flow > 0 | median month 12–18, each seed 9–24 | median 15, months 12–16 (100 seeds: median 14, 11–19) |
| Take rate at month 36 | 30–45% | 37–40% (34–41%) |
| ARPU / monthly churn | $60–80 / 0.8–2% | $67–71 / 1.0–1.3% ($67–74 / 0.9–1.4%) |
| Lifetime cost per passing at month 36 | ≤ $1,000 | $712–845 (highest $933) |
| Capacity matters | a splitter on every seed by month 36; covering the whole town needs more cabinets than the starting 16 PON ports | splitters from month 5; 17–22 cabinets to cover each tuning town |
| Careless overbuild (no reserve, maximum marketing) | bankrupt within 36 months on ≥ 4 of 5 | bankrupt at month 3 on every seed |
| A player who builds nothing | survives ≥ 24 months | survives (about 75 months of runway) |

Careful play passes ~35–40% of the town from its starting cash and, without loans, grows slowly after break-even (about 690 passings at month 60, median of 100 seeds): loans are the intended lever for faster expansion.

## Open questions (for later milestones)

- Core router/DWDM interaction depth in M2: abstract "wave slots" vs explicit add/drop channel planning.
- RFQ win-probability formula and how competitor bids are shown.
- Covenant definitions (leverage ratio? minimum cash?) and what happens on breach (warning → penalty rate → game over).
- Audio, tutorial/onboarding.
