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
- **Monthly report:** subs, gross adds, churn, ARPU by product, CPGA, take rate by area, EBITDA, cash, debt covenants.
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

## Starting balance (rough, to be tuned)

| Item | Value |
|---|---|
| Aerial construction | ~$10/ft, fast, needs make-ready |
| Underground (bore) | ~$30/ft, slower, permits; rock ×2 |
| Drop + ONT install | ~$900 per home |
| GPON | 2.5G down shared per PON, 1:32 split |
| XGS-PON | 10G symmetric shared per PON |
| Peak demand growth | ~20–25% per year per sub |

## Open questions (for later milestones)

- Core router/DWDM interaction depth in M2: abstract "wave slots" vs explicit add/drop channel planning.
- RFQ win-probability formula and how competitor bids are shown.
- Covenant definitions (leverage ratio? minimum cash?) and what happens on breach (warning → penalty rate → game over).
- Audio, tutorial/onboarding.
