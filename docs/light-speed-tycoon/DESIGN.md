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
| Funding | Starting cash + bank debt (a revolving credit line and 5- or 7-year term loans, underwritten on recurring revenue, priced on leverage and cost per passing, with escalating covenants: see Financing) + grants with buildout obligations (later) |
| Competition | Incumbent cable (HFC) + DSL telco from the start; rival fiber overbuilder mid-game |
| Residential sales | Player-set tier lineup, promos, marketing budget; take-rate ramps per street |
| Labor | Construction crews (aerial, underground/boring) and install techs with a visible backlog |
| Tech tree | GPON → XGS-PON → 25/50G-PON; core waves 10G → 100G → 400G |
| Buildings (M1) | Single-family homes, MDUs (fiber to demarc + building router), SMB |
| Right-of-way | Aerial: pole attachment app, make-ready delay, pole rent. Underground: permit delay, higher $/ft, rock zones |
| Goal | Sandbox with optional milestones; lose on insolvency (three month closes in a row below $0) or loan default (a payment missed while the credit line is frozen, after repeated covenant breaches or an earlier missed payment) |
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
- **Cost per passing (CPP):** outside-plant build cost (cable, cabinets, splitters) ÷ homes passed; drops/ONTs/install are cost per connection, tracked separately. A tunable target (~$1,000) colors every cable quote and cabinet preview (green ≤ target, amber ≤ 1.5×, red above) and anchors milestones. Lenders price debt off lifetime CPP: efficient builds get cheaper money (see Financing).
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

## Financing (round 3, settled)

Owner decisions of 2026-10-20 (products, ARR underwriting, risk pricing, escalating covenants, default as game over), with the details the implementation and tuning settled. Values are in the balance table below.

- **Products.** A revolving **credit line**: draw and repay any time; interest on each day's end-of-day balance (actual/365), charged at the month close; the limit is 0.5 × ARR and grows with the business. **Term loans** for builds: a fixed amount over 5 or 7 years, level monthly payments of principal and interest with exact whole-dollar amortization (the rounding lands on the last payment); the level payment is always the one that repays the loan at the rate charged, so it is re-set over the months left whenever the penalty below starts or stops and after a missed payment (the surcharge is paid as it accrues, never as a lump at the end); the first close after origination charges only the stub interest; prepay any part at any time with the interest accrued since the 1st (the payment is re-amortized over the months left). Term capacity is 3 × ARR less the term balances owed; the smallest loan is $10,000.
- **Underwriting on recurring revenue.** ARR is the revenue of the last 3 closed months × 4, so there is nothing to borrow before the first subscriber pays and very little for the first months (early tension). The lender's cash flow is max(annualized trailing operating cash flow, 35% of ARR): the **cash-flow floor** judges a young network on its recurring revenue while its operating cash flow is ≤ 0 or small; with no revenue and no positive cash flow, debt is unmeasurable (a breach). **Leverage** = total debt ÷ that cash flow; **debt-service coverage** = that cash flow ÷ the debt service scheduled over the next 12 months (each loan's payments, plus a year of interest on the line's balance).
- **Risk pricing.** Rate = base 5% + leverage spread (≤ 2×: none, ≤ 3×: +0.75%, ≤ 4×: +1.5%, ≤ 5×: +2.5%, above or unmeasurable: +4%) + **CPP spread** on lifetime cost per passing (green: none, amber: +1%, red: +2.5%; none before anything is passed) + product (credit line +1%, 7-year loan +0.5%). The quotes show each part, with a plain-language CPP line ("Cost per passing $742 is under target: no CPP spread").
- **Fixed vs floating.** A term loan's rate is fixed at origination, priced on pro forma leverage (with the new loan, to the hundredth as the quote shows it). The credit line floats: it is re-priced at every close on that close's leverage (to the hundredth, as the report shows it) and the ended month's cost per passing.
- **Covenants with escalation and cure.** Tested at every close after the debt service: leverage ≤ 5× and coverage ≥ 1.2× (when anything is scheduled), both to the hundredth as the Bank and the report show them (5.00× passes); the debt service counts each loan's real payments over the next 12 months, its last one included. A breach steps the stage up: **warning** (a notice, nothing else) → **penalty** (+3% on every balance) → **frozen** (no draws and no new term loans; repaying and prepaying still work; the penalty stays). Two compliant closes in a row step it down one stage (cure); repaying all debt clears it at the next close, whatever the stage (until then a frozen line stays frozen, and says so). The bank will still write a loan whose quote says it would breach (capacity, 3.5 × ARR with the line, is about twice what the covenants allow on the floor): the quote warns, and that is the reckless player's path.
- **Missed payment.** Debt service comes out of the cash left after the month's revenue and running costs. If that is short, nothing is paid: the unpaid interest is added to what is owed, the schedule slips a month (the payments are re-set to repay the larger balance over it), a **late fee** of max($1,000, 5% of what was due) is charged, and the line jumps straight to frozen.
- **Default.** A payment missed while frozen ends the game (game-over reason "default", the same machinery as insolvency); the insolvency check runs after the debt review. A **reminder** notice is posted 5 days before a close when the cash projected at the close (today's cash plus the month's billing, less its overhead, pole rent, marketing, support and installs at the month's pace) is below the estimated debt service; the Bank shows the same projection beside the next payment. With the line frozen and debt owed, the insolvency warning and the HUD say that the next close in the red is a default (no grace closes are left).
- **Accounting.** Interest (late fees included), principal and loan proceeds are ledger categories: operating cash flow excludes them (it is what the covenants measure), net cash flow includes them, and cost per passing is untouched by debt.

## Round 4: briefing, loan polish, pricing realism, aerial vs underground (settled)

Owner decisions of 2026-10-20 (the month-end briefing is the owner's idea), with the shapes the round-4 contract fixed (`types.ts`, schemaVersion 4). Values are in `balance.ts` (its Round 4 section, plus the round-2 values the round-4 tuning moved); the tables below say where they landed and why.

- **Month-end briefing.** At a month close the game pauses and a sheet shows the period at a glance (net, cash, subscribers, passings, take rate, cost per passing vs target, debt and covenant status), what changed against the period before, the period's notices, the revenue and cost breakdown, and a forward look (next payment, cash projected after the next close's payment and, while frozen, its sweep, runway, the frozen-line countdown). Continue resumes the speed the player had. A per-browser setting (not game state): every month (default), every quarter (a quarter's briefing sums its three months against the three before) or only when something needs attention (urgent advice or a notice that needs action; a storm or dig-in only while plant is still out at the close, a full cabinet, a full OLT or paused installs only while still so at the close). Off in headless play and, unless asked, in tests (`?debug=1` pages). The data is `advisor.buildBriefing`, pure; the period's notices come from a cursor each round-4 close records (`MonthlyReport.ops.lastNoticeId`).
- **Advisor.** 1-3 ranked suggestions from deterministic rules in the pure sim (`advisor.advise`), each with a reason built from the figures and an action the UI performs: move the camera to a cabinet, corner or street, or open Pricing, the Bank or the OLT panel. Rules never advise what would backfire: cures and financing are verified pro forma (`debt.cureFor` over `debt.cureOptions`, `debt.fundingHint`), and once the bank has called the loans, or would call them before a cure could lift the freeze, the only cure offered is repaying everything (when cash covers it).
- **Frozen line.** While frozen, each close sweeps half of the month's positive operating cash flow (never cash below a small reserve) to repay the line, then term loans. After 6 frozen closes in a row the bank calls the loans: everything owed falls due over the next 3 closes, and a close that cannot pay is a default. Saves from round 3 that are frozen keep at least two warning closes before the call, and are told the new rule once.
- **Loans.** Term loans taken in the same month are priced together (no discount for slicing one loan). Lending ARR is smoothed (the trailing mean counts for at most 1.5 × the weakest trailing month), so a one-month price spike cannot inflate capacity (never doubles it); the Bank says "lending ARR" and the HUD's run-rate is "MRR". The Bank leads with covenant status, previews covenants on draws, and its term-loan builder starts at the largest covenant-safe amount (settling round 3's open question: the full capacity breached the covenants; the reckless amount stays one edit away); quote cards suggest financing that keeps a cash cushion and considers term loans.
- **Pricing realism.** A price rise reaches today's subscribers only when its price lock ends (setPricing `grandfatherMonths`, default 6; 0 = at the next bill), with a one-off churn step by the size of the rise (half as much for grandfathered or promo subscribers); new subscribers pay the new price; cuts reach everyone at once. An optional intro promo (percent off for N months) lifts the take-rate model and ends in a smaller step. Dropping a tier moves its subscribers at the next close to the offered tier nearest in price; some cancel, more the bigger the jump. Where your take rate in a cabinet area reaches 45% on 100+ passings, the incumbent runs a promo there for 6 months ($20 off), lowering your target take rate locally and adding churn; then it stays quiet there for 6 months. Default prices are what the market bears: $60 / $75 / $95, the best constant price for a careful operator (round 4 tuning below).
- **Storms and dig-ins.** From the second year, seeded storms (their own random stream, so they never shift make-ready, signups or churn) hit an area of the map and damage aerial spans far more often than underground ones; underground plant suffers occasional dig-ins. A damaged span is out for some days: the streets it cuts off stay passed (scorecards and passings ignore outages) but their subscribers have no service, nobody signs up there, and at each close they churn more by the days they were out (each subscriber by its own days: one whose cabinet the outage cuts off is out unless another cabinet that still reaches its street has a port free for it, the service rule applied without dropping anyone; one who signed up after the repair is not; an outage over a close pays its base churn once, at the first close); while the street's own cabinet is cut off, new signups there go only to a cabinet that still reaches it with a free port; repairs are an operating cost. The covenants count repairs once, at their total over the past 12 closes, instead of annualizing a storm month from the three-month window (that turned one $7k storm into a $28k cut in the lender's cash flow and could breach a covenant on its own). The runway (HUD, briefing, advisor) takes the same view of repairs (a twelfth of the past year's) and counts the scheduled debt service (a twelfth of the year's), not a voluntary repayment, so neither a storm month nor paying down the line reads as a lasting burn and prompts advice to borrow; and once the advisor has warned that a covenant is breached or near its limit, no other suggestion in that briefing borrows, but for a covenant-safe draw that covers the payment the next close must make (ranked first), which the warning names as the only borrowing to do. About seven storms a year, each a disc of 5-15 map cells; a live aerial span in one is damaged with a 7% chance per unit of severity (1-3), an underground one 0.2%, and underground plant has 0.15 dig-ins a mile a year. An aerial span can be rebuilt underground in place (permit and construction; the aerial cable serves until the rebuild is live). Goal: neither method dominates.
- **Tuning.** The integrator's interim values (lending-ARR cap 1.5, incumbent trigger 45%, storm radius 5-15 cells) held; the round-4 tuning moved prices, the take-rate and churn weights, pole rent, the underground bore, storm frequency and damage, aerial repair costs and outage churn (see "Round 4: targets and where they landed" below).



Values live in `light-speed-tycoon/src/sim/balance.ts`; `src/sim/tuning/targets.test.ts` (rounds 2 and 3) and `targets4.test.ts` (round 4) check the targets below on five seeds (1, 2027, 424242, 99, 12345) and `TUNE_REPORT=1 npx vitest run src/sim/tuning/report.test.ts` prints the per-seed numbers (`TUNE_SEEDS=…`, `TUNE_MONTHS=…`, `TUNE_SWEEP=0` to skip the price sweep). The 100-seed figures are seeds 1–100.

| Item | Value |
|---|---|
| Start cash | $750,000 (covers ~30% of the town's build-out) |
| Aerial | $11/ft + make-ready $450 per pole (a pole every 150 ft, so ~$3/ft); make-ready 30–90 days, 15% chance of 120–210 |
| Underground (bore) | $26/ft (round 4; was $28); rock +$22/ft (~$48/ft all-in); city permit 14–45 days |
| Per cable order | engineering $1,500 + pole attachment application $500 (aerial) or city permit $1,000 (underground); fees and make-ready never refunded |
| Cabinet | $28,000 incl. pad and install, plus its first 1:32 splitter; 8 splitter slots |
| Cabinet reach | 800 ft along live cable: the best downtown corner reaches ~500 units, a typical one 150–200; ~17–22 cabinets cover the town |
| Splitter (1:32) | $1,800; takes one OLT PON port; an apartment building's router uses one port for the whole building |
| OLT | 1 line card of 16 PON ports to start; +16 ports per card at $12,000; 8 cards per chassis. Covering a whole town takes 17–22 cabinets, so town-wide expansion needs a card |
| Cost per passing target | $1,000 (green ≤ $1,000, amber ≤ $1,500, red above) |
| Tiers | 500 Mbps $60 · 1 Gig $75 · 2 Gig $95 (round 4; was $55 · $70 · $95): the best constant price for a careful operator; businesses ×1.5; incumbent cable $75 for 300/20 |
| Target take rate | 0.356 + 0.3 × best tier's value advantage over the incumbent (round 4; was 0.31 + 0.25): ~55% of homes at default prices (was ~49%), apartments ×0.8, businesses ×0.6; 3–70% (was 60%); +10% on every price costs ~3 points |
| Signup ramp | each day a lit street closes 1/550 of its gap to the target × (1 + marketing boost, up to 1.5; half of that at $3 per passing per month) |
| Churn | 1.1% a month at or under the default (market) price, × (1 + 10 × the share paid over it) (round 4; was × 2): 10% over doubles it |
| Installs (connect capex) | home $700 · business $1,100 · apartment $250 per unit + $5,000 building router once |
| Operating costs | overhead $9,000/month; support $4 per subscriber per month; pole rent $7 per pole per month (round 4; was $2) |
| Insolvency | the third month close in a row below $0 ends the game |
| ARR (borrowing base) | revenue of the last 3 closed months × 4; round 4 (lending ARR): their mean counts for at most 1.5 × the weakest of them |
| Credit line | limit 0.5 × ARR (rounded down to $1,000); floating rate: base + 1% + leverage and CPP spreads, re-priced at each close; interest on daily balances |
| Term loans | 5 or 7 years; $10,000 up to 3 × ARR less term balances owed; fixed rate at origination: base (+0.5% for 7 years) + spreads on pro forma leverage; level monthly payments |
| Base rate | 5% a year (a careful borrower pays about 7%) |
| Leverage spread | ≤ 2×: none · ≤ 3×: +0.75% · ≤ 4×: +1.5% · ≤ 5×: +2.5% · above, or unmeasurable: +4% |
| CPP spread | lifetime cost per passing green: none · amber: +1% · red: +2.5% |
| Underwriting cash flow | max(annualized trailing operating cash flow, 35% of ARR); round 4: storm and dig-in repairs count at their past-12-month total, not annualized |
| Covenants | leverage ≤ 5×, debt-service coverage ≥ 1.2× at every close; breach: warning → penalty (+3% on every balance) → frozen (no new borrowing); 2 compliant closes in a row step back one stage |
| Missed payment / default | late fee max($1,000, 5% of what was due), unpaid interest added to the debt, line frozen; a payment missed while frozen is a default (game over); reminder 5 days before a close when cash is short |
| Storms (round 4) | from the second year, ~7 a year (1 in 50 days; was 1 in 60), each a disc of 5–15 map cells, severity 1–3; a live span in it is damaged with 7% × severity if aerial (was 6%), 0.2% × severity if underground; dig-ins 0.15 a mile a year on underground plant |
| Outages and repairs (round 4) | aerial span out 2–6 days, repair $1,200 + $1/ft (was + $3/ft: mostly the crew's call-out); underground out 4–12 days, repair $4,000 + $1/ft |
| Outage churn (round 4) | a subscriber cut off d days by one outage: +5% + 1% × d, at most 25%, charged at the closes the days fall before (an outage over a close pays the 5% once) (was 1% + 0.4% × d, at most 10%) |
| Price locks (round 4) | a rise waits 6 closes for today's subscribers (0–24; 0 = next bill); when a lock ends, one-off churn 40% × the rise's share × (1, or ½ for grandfathered and promo locks), at most 50% |
| Intro promo / retired tier (round 4) | up to 50% off for up to 12 months, valued as its discount over 24 months; a retired tier's units move to the nearest-priced offered tier, 5% + 60% × the rise cancel (at most 60%) |
| Incumbent promo (round 4) | at 45% take on 100+ passings in a cabinet area: $20 off for 6 months there (+1% churn a month), then 6 quiet months |
| Frozen line (round 4) | each frozen close sweeps 50% of the month's positive operating cash flow above a $25,000 reserve; 6 frozen closes in a row call the loans, due over 3 closes |
| GPON / XGS-PON (later) | 2.5G down shared per PON / 10G symmetric, 1:32 split |
| Peak demand growth (later) | ~20–25% per year per sub |

**Targets and where they landed** (five tuning seeds; in brackets, 100 seeds: seeds 1–100). The careful operator (SMART) has borrowed since round 3, and since round 4 it also picks each street's method, keeps a storm reserve and answers the incumbent's promos, so every row is re-measured with the round-4 values and bots; no band changed.

| Target | Band | Result (round 4) |
|---|---|---|
| Start cash ÷ town build-out (all streets the cheaper way, fees, greedy cabinet cover) | 25–33% mean, 22–36% each seed | 30.1% mean, 29–32% (100 seeds: 30.3%, 25–34%) |
| Cost per passing, dense poled streets, aerial | median $400–600 | $426–514 per seed (100 seeds: median $501; one town $397) |
| Same streets underground | median $850–1,150 | $877–957 (median $922; three towns $838–848: the bore went from $28 to $26 a foot) |
| Rural runs | median ≥ $2,500 (red) | $3,318–5,118 (lowest town $2,997) |
| Careful play (SMART): game over in 5 years (any reason) | never | never (0 of 100) |
| First month with operating cash flow > 0 (financing excluded) | median month 12–18, each seed 9–24 | median 13, months 11–14 (100 seeds: median 13, 10–19) |
| Take rate at month 36 | 30–45% | 34–37% (34–41%) |
| ARPU / monthly churn | $60–80 / 0.8–2% | $73–74 / 1.25–1.49% ($71–77 / 1.1–1.7%); ARPU rose with the prices but stays in the band |
| Lifetime cost per passing at months 36 and 60 | ≤ $1,000 | $868–896 and $881–936 (100 seeds: medians $888 and $931; one town $1,003 at month 36, another $1,021 at month 60) |
| Capacity matters | a splitter on every seed by month 36; covering the whole town needs more cabinets than the starting 16 PON ports | splitters from month 4–6 (100 of 100 by month 36); an OLT card in months 37–46 (98 of 100, months 31–59); every town needs more than 16 cabinets |
| Careless overbuild (no reserve, maximum marketing, no loans) | bankrupt (insolvent or default) within 36 months on ≥ 4 of 5 | insolvent at month 3 on every seed (100 of 100) |
| A player who builds nothing | survives ≥ 24 months | survives ($510,000 left at month 24) |
| **Round 3:** SMART's passings at month 60 ÷ units present that day | ≥ 50% each seed, median 50–70% | 61–66%, median 63% (100 seeds: median 64%, 95 of 100 at 50% or more, lowest 46%) |
| The same operator without loans (`smartBot({ borrow: false })`) | reported; SMART at least 15 points ahead on every seed | 28–32%, so 29–38 points ahead (23–41%; at least 20 points ahead on every seed) |
| SMART borrows responsibly | no default, no missed payment, never past a covenant warning | compliant at every close on every seed, nothing missed (100 of 100: not even a warning) |
| SMART really borrows: peak total debt | ≥ 40% of start cash ($300,000) | $740,000–966,000 (lowest $445,000, median $827,000) |
| SMART's debt-weighted average borrowing rate | 6–11% on every seed | 7.02–7.05% (7.00–7.09%) |
| A rural-heavy borrower (red lifetime CPP) pays visibly more | at least SMART + 1% on every seed | 9.86–10.24%, 9.45–9.62% without penalty months; red at 86–100% of its month ends with debt (≥ SMART + 1 point on 100 of 100, on risk pricing alone on 99; red ≥ 75% of the time on 94) |
| Borrowing every dollar offered (LEVERED) | game over by default within 60 months on ≥ 4 of 5 | default at month 11–14 on every seed after warning, penalty, frozen and a missed payment (100 of 100, months 5–17) |
| Early tension: what the bank would lend (credit limit + term capacity) | $0 on day 0 and before the first subscriber; ≤ 10% of start cash after month 3 | $0 before the first subscriber; $0 after month 3 (at most $1,000) |

**How the bots borrow.** SMART takes a 7-year term loan for its next cabinet project when the project is not red on its own and the projected lifetime cost per passing after it (what the bank prices on) stays at most 90% of the target (round 4: 97%, and 98% for what it builds with its own cash, since its underground plant raises it), sized to the project plus its expected connects, and only when the quote keeps a buffer (pro forma leverage ≤ 80% of the 5× limit, coverage ≥ 1.2 × the 1.2× minimum) and its reserve, which counts the next debt service and leans on the undrawn line instead of idle cash, is covered. It draws on the line when cash dips under a small floor (a month of fixed costs, the next debt service, 60 days of installs), repays when cash is above its full reserve, and repays first if a covenant is at risk. LEVERED takes every term loan the bank allows and the whole line, ignoring covenants and warnings, builds amber and red areas with heavy marketing and keeps nothing for debt service once the bank lends. The RURAL bot builds only red areas and borrows within SMART's buffers even when its reserve is short; a red-only network never covers the $9,000 overhead, so it ends in default (months 27–51), but its rate is the point.

**Why no financing value moved.** The architect's starting values met every target once SMART borrowed sensibly, so the tuning went into the bots, not the knobs. SMART ends up at leverage ~3× and coverage ~1.5× (its coverage buffer binds in later years), and the leverage band it borrows in (3–4×) sets its ~7%. LEVERED's 3.5 × ARR is ~10× leverage on the floor, so it breaches at its first close with debt and defaults a few months later. The round-2 operator sat on a $40–100k reserve for years; letting its reserve lean on the undrawn line and funding each project's expected connects with the loan took it to 54–65% of the tuning towns. Borrowing only for areas green on their own then stalled some towns once the green areas ran out (100 seeds: median 60%, 8 seeds under half), so SMART now borrows for any non-red project that keeps its lifetime cost per passing under 90% of the target (median 65%, 4 under half). Loosening the cash-flow floor or the coverage minimum would add growth too, but would also let an unviable network borrow longer while compliant (the RURAL bot is compliant until the month its cash runs out), so they stay.

Careful play passes ~35–40% of the town from its starting cash; without loans it then grows slowly (about 30% of the town at month 60, median of 100 seeds). With loans it keeps building after break-even and passes about two thirds of the town by month 60 (64%, median of 100 seeds), at ~7% and never near a covenant breach (round 4: not one warning in 100 runs, storms included).

**Round 4: targets and where they landed** (`targets4.test.ts`; five tuning seeds, in brackets seeds 1–100).

| Target | Band | Result |
|---|---|---|
| SMART still grows and never defaults; LEVERED still defaults | median ≥ 50% at month 60, no game over; LEVERED default on ≥ 4 of 5 | see the table above: median 63% (64%), never a game over, LEVERED defaults on every seed |
| SMART lays a meaningful share of its plant underground | 20–60% of its plant's feet, every seed | 20.8–32.4% (100 seeds: median 27.7%, 18.5–39.3%, 98 of 100 in the band) |
| An all-aerial copy of SMART (`allAerialBot`) suffers visible storm losses | repairs, subscriber-days without service and outage cancellations clearly higher | expected yearly exposure of the month-60 plant (harness `stormExposure`): repairs 1.27–1.46× SMART's on every seed, subscriber-days and cancellations 1.10–1.33× (1.23× over the five). Realized on 100 seeds: repairs $4.51M vs $3.37M (1.34×), subscriber-days out 83,379 vs 57,863 (1.44×), outage cancellations 1,950 vs 1,328 (1.47×); repairs 3.1% vs 2.5% of revenue |
| Neither method dominates | all-underground and all-aerial both do worse than SMART's mix | all-underground (`allUndergroundBot`) passes 20–32% of the town against SMART's 61–66% (31% median; less than SMART on 100 of 100, worth less on 98) with almost no storm losses. All-aerial loses more to storms (above) but passes more: 67–76% (70% median; more than SMART on 90 of 100). Not met for all-aerial on growth: see "What round 4 could not reach" |
| A frozen-line hoarder no longer out-grows careful borrowing | below SMART's passed share at month 60 on every seed; ends in a default or repaying through the call | FROZEN_HOARDER: 27–33% when it stops, repays everything through the call at months 16–22, borrows everything again and defaults at months 28–38 (100 of 100 below SMART; 98 repaid through a call, 99 defaulted). The spending hoarder (builds with the hoard): default at months 7–13 (100 of 100). The frozen v3-grid fixture played on: called and repaid in full, standing back to compliant |
| Default prices near what the market bears | within ~15% of the best constant price | the sweep (SMART at 0.7–1.6 × every default price, kept constant; mean cumulative operating cash flow to month 60) peaks at ×1.0: $545k against $439k at ×1.1 and $366k at ×0.9 (100 seeds, sweep at ×0.9–1.2: ×1.0 $545k, ×1.1 $491k; best per seed ×1.0 on 64, ×1.1 on 34, ×1.2 on 2) |
| Extreme hikes lose subscribers | PRICE_HIKER ends with clearly fewer subscribers; price-step churn visible in `ops.priceChurn` | +15% every 6 months: 49–129 subscribers when it ends against SMART's 504–586 (at most half of SMART's on 100 of 100, both variants); 15–26 price-step cancellations when grandfathered, 40–48 when passed on at the next bill. Its revenue collapses and it defaults in months 32–41 (100 of 100) |
| The incumbent answers in SMART's dense areas | a few promos in 5 years, growth intact | 5–7 promos per run (100 seeds: 1–9, median 5); 28–36 cancellations they caused; SMART answers each with its intro promo (used on 99 of 100) |

**How the bots play (round 4).** All read the game through public sim functions only (`stormRisk`, `quoteConvert`, `quoteRemoveSpan`, `maxSafeTermLoan`, `fundingHint`, `cureOptions`, `activePromos`) and act only through commands.
- **SMART** picks each new street's method by its cost over a 12-year horizon: construction, make-ready and fees, pole rent, `stormRisk` repairs and the outage churn of the street's own subscribers (the street grid gives the rest of the plant a second path: removing any one span of a SMART network cuts off at most a few dozen subscribers), plus, for a street whose way to the cabinet is all underground, the margin it loses waiting for make-ready (30–90 days, sometimes 120–210, against a 14–45-day permit). That buries the short blocks, where one pole's rent and a repair crew's call-out cover little cable, and strings the long blocks. When a lifetime plan would break its cost-per-passing tests (what the bank prices on: it borrows while the projected lifetime CPP stays under 97% of the target and builds with its own cash under 98%), it keeps only the burials that save the most for what they cost more, then all aerial. It sizes loans within `maxSafeTermLoan` and its own buffers, buys a splitter or OLT card with a covenant-safe draw (`fundingHint`) when cash cannot, keeps a year of expected repairs above its cash floor and two in its building reserve, rebuilds a storm-hit aerial span underground when `quoteConvert` pays back within 10 years (one rebuild in 100 runs: a rebuild's bore and fees rarely do), keeps the default prices with default grandfathering, runs 20% off for 3 months for new signups while the incumbent runs a promo in any of its areas (extra marketing on the contested passings did no better over 20 seeds), and past a warning takes the first `cureOptions` repayment or deleverages and builds nothing until compliant (it never needed to).
- **ALL_AERIAL / ALL_UNDERGROUND**: SMART with every street aerial where it has poles (never rebuilding), or every street underground.
- **FROZEN_HOARDER**: SMART without loans until the bank lends, then every dollar offered whenever offered (LEVERED's borrowing), never repaying by choice; it stops building and sits on the cash (marketing and splitters only). With `spendHoard` it builds with the hoard, keeping a year of scheduled debt service: round 3's exploit of a frozen line.
- **PRICE_HIKER**: SMART raising every offered tier 15% every 6 closes, grandfathered for the default 6 months or passed on at the next bill.
- **The constant-price sweep** (`harness.priceSweep`): SMART with every tier at a multiple of its default price from day 0, kept there.
- **RURAL** keeps round 3's cash rules (no storm reserve), so its debt keeps buying red lanes; **MIXED** now also sets intro promos, rebuilds spans, grandfathers rises (or passes them on) and retires tiers, and the invariant sessions check price locks (one per tier, only on tiers with units), outages (only on live spans, never longer than their method's longest), the frozen-line count and the call against the stage and the debt, each close's ops figures against its stats and ledger, and the books.

**Why values moved (round 4).**
- **Prices and demand.** With the round-3 take model a careful operator earned most at about 1.3 × the defaults (500 Mbps near $70): the target take rate fell only ~2 points per 10% on every price, and nobody churned for paying more. Prices went to $60 / $75 / $95, the take model to 0.356 + 0.3 × advantage (a 55% target at the new prices against 49% before, ~3 points per 10%) and churn sensitivity from 2 to 10 (10% over the market price doubles a subscriber's churn), which puts the best constant price at the defaults on 64 of 100 towns and within 10% on 98. A steeper take slope alone would have done it, but `sales.test.ts` (rightly) wants a business at a 4× multiplier still above the minimum take rate, which caps the slope; and the cap of 0.6 had to rise to 0.7 so a faster tier at a slower tier's price still out-sells it. ARPU went from ~$68 to ~$74, still in the $60–80 band; break-even and the take rate at month 36 stayed in their bands.
- **Aerial vs underground.** Pole rent went from $2 to $7 a pole a month (4–5% of a careful operator's revenue), the bore from $28 to $26 a foot (the lowest that keeps dense underground runs in the $850–1,150 band), storms from 1 in 60 days to 1 in 50 with aerial damage 7% (was 6%) per unit of severity, an aerial repair to $1,200 + $1 a foot (was + $3: mostly the crew's call-out), outage churn to 5% + 1% a day (was 1% + 0.4%). Together: a short aerial block costs nearly as much to keep as a long one, so burying it pays within ~10 years, and the long blocks stay aerial. The storm radius stayed at the integrator's 5–15 cells: a per-span repair cost raised further made single storm months big enough to push a fully borrowed operator past its coverage covenant (it took a year of expected repairs held above the cash floor to make SMART storm-proof at these values).
- **Kept:** lending-ARR cap 1.5 (a one-month spike still cannot double borrowing), incumbent trigger 45% (5 promos a run, never everywhere), the frozen-line sweep and call (they finish every hoarder), make-ready timing (SMART's method choice already counts the wait where it matters), grandfathering, promo and retirement churn.

**What round 4 could not reach, and the sim changes that would.**
- **All-aerial out-grows the mix.** Burying a street costs about twice what stringing it does, and growth here is capital-bound and amplified by lending on revenue: every dollar saved passes more homes, which raise ARR, which the bank lends against. An all-aerial copy of SMART passes ~6 points more of the town by month 60 and is worth more at month 60 (cash − debt + 12 years of operating cash flow: more on 73 of 100); in a 20-seed probe it was still ahead after 10 years; SMART's 12-year cost of owning its plant per passing is about equal ($1,205 vs $1,214, all-underground $1,020). No storm, rent or churn level tried made the mix win on growth without crippling every aerial operator (repairs past ~8% of revenue froze and defaulted careful players on bad storm years). Making the mix genuinely better would need the sim to give underground an edge where it is built, e.g. make-ready cost drawn per street (some blocks need pole replacements costing more than a bore), storm exposure that varies by area, or aerial plant that wears out.
- **Subscribers are only modestly less exposed.** A storm cuts off only the damaged block, and SMART buries the short blocks, where few subscribers live; the long residential blocks are aerial in both strategies, so all-aerial's subscribers are only 10–33% more exposed (expected outage days and cancellations), not twice.
- **Storm sequences diverge between strategies.** Each storm draws a damage roll for every span in its area from the weather stream, so two plants on one seed soon see different storms; realized storm losses compare luck as much as plant on a handful of seeds. The round-4 target therefore checks expected exposure per seed and quotes realized totals on 100 seeds. Drawing each storm's damage from its own sub-stream (weather.ts) would make the realized comparison fair seed by seed.
- **Rebuilds rarely pay.** A rebuild pays the whole bore and $2,500 of fees to save a span's pole rent, repairs and outage churn (~$150–250 a year), so SMART rebuilt one span in 100 runs and the advisor's rebuild suggestion stays rare.
- **Churn's price reference is `TIER_DEFAULTS`** (sales.ts): a player who sets prices is compared with the defaults, not with what the market would bear at the moment; decoupling them would need a sales.ts change.

## Open questions (for later milestones)

- Core router/DWDM interaction depth in M2: abstract "wave slots" vs explicit add/drop channel planning.
- RFQ win-probability formula and how competitor bids are shown.
- Audio, tutorial/onboarding.
