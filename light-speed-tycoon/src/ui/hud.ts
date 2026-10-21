// Top bar: speed controls, the company (round 4b) over the date with the town
// beside it as a secondary label, cash (with an overdraft warning), the
// pricing, milestones and bank buttons, the menu, and a row of chips:
// passings, cost per passing, subscribers, MRR (the monthly run-rate: what
// subscribers pay per month today; never called ARR, which is the Bank's
// smoothed lending figure), OLT PON ports, the build queue, and (round 3)
// total debt and the covenant stage while they matter (round 4: with the
// frozen line's countdown to the call, and the closes left once called). The
// debt and covenant chips open the Bank panel.
//
// Owner: ui-economy workstream; debt and covenant chips: ui-bank workstream (round 4: sim-debt);
// the company label: start-screen workstream (round 4b).

import {
  ACCELERATION_CLOSES,
  ACCELERATION_WARNING_CLOSES,
  CPP_AMBER_MULTIPLIER,
  CPP_TARGET,
  FROZEN_ACCELERATION_CLOSES,
  FROZEN_SWEEP_SHARE,
  INSOLVENCY_GRACE_MONTHS,
} from '../sim/balance';
import { formatDate } from '../sim/calendar';
import { difficultyLevel, isDifficultyId } from '../sim/company';
import { acceleratedSchedule, closesUntilAcceleration, covenantMetrics, cureOptions, totalDebt } from '../sim/debt';
import { runwayMonths } from '../sim/finance';
import { costPerPassing, cppBand } from '../sim/metrics';
import { getService, ponPortsUsed } from '../sim/network';
import { monthlyRecurringRevenue, subscriberUnits } from '../sim/sales';
import type { CppBand, GameOverReason, GameState } from '../sim/types';
import { STAGE_TONE, brokenCovenants, covenantLimits, cureAdvice, cureText, stageMeaning, stageNext } from './bankPanel';
import { el, icon, setText } from './dom';
import { formatMoney, formatNumber, formatPercent, plural } from './format';
import { ICONS } from './icons';
import { SPEEDS } from './session';
import type { GameSession, Speed } from './session';

export interface HudIdentity {
  /** The primary label: the company's name. */
  company: string;
  /** The secondary label: the town it is wiring up. */
  town: string;
  /** Tooltip: both, and the difficulty it started at. */
  tip: string;
}

/** Round 4b: who is playing where, for the HUD's company and town labels. */
export function hudIdentity(state: GameState): HudIdentity {
  const { name, difficulty } = state.company;
  const level = isDifficultyId(difficulty) ? difficultyLevel(difficulty) : null;
  const started = level ? ` Difficulty: ${level.name} (started with ${formatMoney(level.startCash)}).` : '';
  return { company: name, town: state.city.name, tip: `${name}, wiring up ${state.city.name}.${started}` };
}

/** OLT PON ports at or above this share in use turn the HUD chip amber. */
export const PON_WARN_SHARE = 0.9;

export interface PonStatus {
  /** "PON 11/16" */
  text: string;
  level: 'ok' | 'warn' | 'full';
  tip: string;
}

/** The HUD's OLT chip: PON ports in use (one per splitter) out of the OLT's ports. */
export function ponStatus(state: GameState): PonStatus {
  const used = ponPortsUsed(state);
  const ports = state.network.olt.ponPorts;
  const level = used >= ports ? 'full' : used >= ports * PON_WARN_SHARE ? 'warn' : 'ok';
  const advice =
    level === 'full'
      ? ' All in use: add an OLT line card at the CO before the next cabinet or splitter.'
      : level === 'warn'
        ? ' Nearly full: plan an OLT line card at the CO.'
        : '';
  return {
    text: `PON ${formatNumber(used)}/${formatNumber(ports)}`,
    level,
    tip: `OLT PON ports in use: ${formatNumber(used)} of ${formatNumber(ports)}. Every splitter uses one.${advice}`,
  };
}

export interface CppStatus {
  /** "$812" */
  text: string;
  band: CppBand;
  tip: string;
}

/**
 * The HUD's cost-per-passing chip: lifetime outside-plant spend over today's
 * passings (the same formula as the monthly report's KPI, live), or null
 * while nothing is passed.
 */
export function cppStatus(state: GameState): CppStatus | null {
  const passings = getService(state).passings;
  const cpp = costPerPassing(state.finance.capex.osp, passings);
  if (cpp === null) return null;
  return {
    text: formatMoney(cpp),
    band: cppBand(cpp),
    tip:
      `Cost per passing: ${formatMoney(cpp)} of cable, cabinets and splitters per home passed ` +
      `(${formatMoney(state.finance.capex.osp)} over ${plural(passings, 'passing')}). ` +
      `Target ${formatMoney(CPP_TARGET)}: green at or under it, amber up to ${formatMoney(CPP_TARGET * CPP_AMBER_MULTIPLIER)}, red above.`,
  };
}

export interface DebtStatus {
  /** "Debt $412,000" */
  text: string;
  total: number;
  /** "Credit line $12,000 · Term loans $400,000 (2)" and where to see more. */
  tip: string;
}

/** The HUD's debt chip: everything owed, or null while nothing is (the chip hides). */
export function debtStatus(state: GameState): DebtStatus | null {
  const total = totalDebt(state);
  if (total <= 0) return null;
  const line = state.debt.credit.balance;
  const loans = state.debt.loans;
  const term = total - line;
  const parts = [`Credit line ${formatMoney(line)}`, `term loans ${formatMoney(term)}${loans.length > 0 ? ` (${plural(loans.length, 'loan')})` : ''}`];
  return {
    text: `Debt ${formatMoney(total)}`,
    total,
    tip: `Debt: ${parts.join(', ')}. Open the Bank for rates, payments and covenants.`,
  };
}

export interface CovenantStatus {
  /**
   * "Covenant warning" / "Penalty rate" / "Credit frozen: 4 closes to call",
   * "Loans called: 2 closes left", or "Covenant at risk" while compliant with
   * today's figures in breach.
   */
  text: string;
  tone: 'warn' | 'danger';
  /** What it means, what comes next and how to cure it (a verified cure, debt.cureOptions). */
  tip: string;
}

const COVENANT_CHIP_TEXT = { warning: 'Covenant warning', penalty: 'Penalty rate', frozen: 'Credit frozen' } as const;

/** "Credit frozen: 4 closes to call" (frozen with debt, not yet called), or "Credit frozen" otherwise. */
export function frozenChipText(closesUntilCall: number | null): string {
  if (closesUntilCall === null) return COVENANT_CHIP_TEXT.frozen;
  if (closesUntilCall <= 0) return `${COVENANT_CHIP_TEXT.frozen}: call at the next close`;
  return `${COVENANT_CHIP_TEXT.frozen}: ${plural(closesUntilCall, 'close')} to call`;
}

/** "Loans called: 2 closes left" */
export function calledChipText(closesLeft: number): string {
  return `Loans called: ${plural(Math.max(1, closesLeft), 'close')} left`;
}

/** " To cure it now: ..." with the first verified cure, or ''. */
function remedyTip(state: GameState): string {
  const advice = cureAdvice(cureOptions(state)[0]);
  return advice === '' ? '' : ` To cure it now: ${advice}`;
}

/**
 * The HUD's covenant chip, or null while the loans are in good standing
 * (compliant) and today's figures keep the covenants. Compliant with today's
 * figures in breach, it warns ahead of the close ("Covenant at risk"),
 * hedged: the close tests that month's figures, which can still pass. Frozen
 * with debt it counts the frozen closes left before the bank calls the loans
 * (debt.closesUntilAcceleration); once called, whatever the stage, the closes
 * left to repay everything, both danger.
 */
export function covenantStatus(state: GameState): CovenantStatus | null {
  const { stage, compliantCloses } = state.debt.covenant;
  const owed = totalDebt(state);
  const call = state.debt.acceleration;
  if (call !== null && owed > 0) {
    const schedule = acceleratedSchedule(state);
    const next = schedule[0] ?? 0;
    return {
      text: calledChipText(call.closesLeft),
      tone: 'danger',
      tip:
        `Loans called: after ${FROZEN_ACCELERATION_CLOSES} frozen closes in a row the bank wants everything you owe (${formatMoney(owed)}) ` +
        `within ${plural(Math.max(1, call.closesLeft), 'close')}: about ${formatMoney(next)} at the next close. ` +
        'A close that cannot pay what falls due is a default that ends the game. Open the Bank for each payment.',
    };
  }
  if (stage === 'compliant') {
    if (owed <= 0) return null;
    const metrics = covenantMetrics(state);
    if (metrics.compliant) return null;
    return {
      text: 'Covenant at risk',
      tone: 'warn',
      tip:
        `Covenant at risk: at today's figures your debt breaks ${brokenCovenants(metrics)} (the bank requires ${covenantLimits()} at each month close). ` +
        `The next close tests that month's figures: a breach then brings a warning first.${remedyTip(state)} Open the Bank for the figures.`,
    };
  }
  const tone = STAGE_TONE[stage] === 'danger' ? 'danger' : 'warn';
  const left = stage === 'frozen' ? closesUntilAcceleration(state) : null;
  const text = stage === 'frozen' ? frozenChipText(left) : COVENANT_CHIP_TEXT[stage];
  const countdown =
    left === null
      ? ''
      : ` While frozen, the bank takes ${formatPercent(FROZEN_SWEEP_SHARE)} of each month's positive operating cash flow to repay what you owe, ` +
        `and ${left <= 0 ? 'the next close' : `after ${plural(left, 'more frozen close')}`} it calls the loans: everything falls due within ${plural(ACCELERATION_CLOSES, 'close')}.` +
        (left <= ACCELERATION_WARNING_CLOSES ? ' The call is close.' : '');
  return {
    text,
    tone,
    tip:
      `${COVENANT_CHIP_TEXT[stage]}: the bank requires ${covenantLimits()} at each month close. ` +
      `${stageMeaning(stage)} ${stageNext(stage)}${countdown} To step back down: ${cureText(stage, compliantCloses)}${remedyTip(state)}`,
  };
}

const GAME_OVER_TEXT: Readonly<Record<GameOverReason, string>> = {
  insolvent: 'Game over: out of cash',
  default: 'Game over: loan default',
};

export interface OverdraftStatus {
  /** "Overdrawn: 2 closes left" */
  text: string;
  tone: 'warn' | 'danger';
  tip: string;
}

/**
 * The HUD's insolvency warning, or null while cash is at or above $0 and the
 * last month close was too. "Closes left" counts the negative month closes the
 * bank still tolerates (INSOLVENCY_GRACE_MONTHS in a row end the game). With
 * the credit line frozen and debt owed it tolerates none: a close in the red
 * cannot pay its loan payments, and a payment missed while frozen is a
 * default that ends the game.
 */
export function overdraftStatus(state: GameState): OverdraftStatus | null {
  const { cash, negativeMonths } = state.finance;
  if (state.gameOver) return { text: GAME_OVER_TEXT[state.gameOver.reason] ?? GAME_OVER_TEXT.insolvent, tone: 'danger', tip: state.gameOver.message };
  if (cash >= 0 && negativeMonths <= 0) return null;
  const owed = totalDebt(state) > 0;
  if (owed && (state.debt.covenant.stage === 'frozen' || state.debt.acceleration !== null)) {
    const why = state.debt.acceleration !== null ? 'The bank has called your loans' : 'Your credit line is frozen with debt owed';
    const rule =
      `${why}, so no close in the red is tolerated: a month close that cannot pay what falls due ` +
      'is a default, and the game ends. No draws or new loans now: keep cash above the payment due at the close.';
    return cash < 0
      ? { text: 'Overdrawn: no closes left', tone: 'danger', tip: `Cash is below $0. ${rule}` }
      : { text: 'Recovering: no closes left', tone: 'warn', tip: `Cash is back above $0: keep it there through the next month close. ${rule}` };
  }
  const left = Math.max(0, INSOLVENCY_GRACE_MONTHS - negativeMonths);
  const closes = plural(left, 'close');
  const rule =
    `${plural(INSOLVENCY_GRACE_MONTHS, 'month close')} in a row with cash below $0 and the bank shuts you down; ` +
    'a close with cash at or above $0 clears the count.';
  if (cash < 0) {
    const so = negativeMonths > 0 ? `${plural(negativeMonths, 'close')} in the red so far. ` : '';
    return { text: `Overdrawn: ${closes} left`, tone: 'danger', tip: `Cash is below $0. ${so}${rule}` };
  }
  return {
    text: `Recovering: ${closes} left`,
    tone: 'warn',
    tip: `Cash is back above $0 after ${plural(negativeMonths, 'close')} in the red: keep it there through the next month close. ${rule}`,
  };
}

/** Tooltip for the cash figure: months of runway at the monthly burn (finance.runwayMonths), when burning. */
export function runwayHint(state: GameState): string {
  const months = runwayMonths(state);
  if (months === null) return 'Cash on hand';
  if (state.debt.acceleration !== null && totalDebt(state) > 0) {
    return `Cash on hand: about ${plural(months, 'month')} of runway at last month's operating loss (storm repairs spread over the year) and the called loans' next payment`;
  }
  return `Cash on hand: about ${plural(months, 'month')} of runway at last month's burn (storm repairs spread over the year)`;
}

/** The MRR chip's tooltip: what the figure is, and that the Bank lends on a different one. */
export const MRR_TIP =
  'MRR (monthly run-rate): what your subscribers pay per month at today’s prices, price locks included. ' +
  'The Bank lends on a different figure, lending ARR: your trailing months’ revenue, smoothed.';

export interface HudActions {
  pricing(): void;
  milestones(): void;
  /** Open the Bank panel (the bank button, the debt and covenant chips). */
  bank(): void;
}

export class Hud {
  readonly root: HTMLElement;
  readonly menuButton: HTMLButtonElement;
  readonly pricingButton: HTMLButtonElement;
  readonly milestonesButton: HTMLButtonElement;
  readonly bankButton: HTMLButtonElement;
  private readonly speedButtons = new Map<Speed, HTMLButtonElement>();
  private readonly when: HTMLElement;
  private readonly company: HTMLElement;
  private readonly town: HTMLElement;
  private readonly date: HTMLElement;
  private readonly cash: HTMLElement;
  private readonly alert: HTMLElement;
  private readonly alertText: HTMLElement;
  private readonly passings: HTMLElement;
  private readonly subs: HTMLElement;
  private readonly mrr: HTMLElement;
  private readonly pon: HTMLElement;
  private readonly ponChip: HTMLElement;
  private readonly building: HTMLElement;
  private readonly buildingChip: HTMLElement;
  private readonly cpp: HTMLElement;
  private readonly cppChip: HTMLElement;
  private readonly debt: HTMLElement;
  private readonly debtChip: HTMLButtonElement;
  private readonly covenant: HTMLElement;
  private readonly covenantChip: HTMLButtonElement;
  /** Session revision and state the subscriber figures were last computed for. */
  private seen: { revision: number; state: GameState | null } = { revision: -1, state: null };

  constructor(session: GameSession, actions: HudActions) {
    const speeds = el('div', { class: 'speed-group', attrs: { role: 'group', 'aria-label': 'Game speed' } });
    for (const speed of SPEEDS) {
      const label = speed === 0 ? 'Pause (Space)' : `${speed}x speed (${speed === 4 ? 3 : speed})`;
      const button = el(
        'button',
        {
          class: 'btn speed',
          attrs: { type: 'button', 'aria-label': label, 'aria-pressed': 'false', 'data-tip': label, 'data-speed': `${speed}` },
          on: { click: () => session.setSpeed(speed) },
        },
        [speed === 0 ? icon(ICONS.pause) : `${speed}x`],
      );
      this.speedButtons.set(speed, button);
      speeds.append(button);
    }

    this.company = el('span', { class: 'hud-company', attrs: { 'data-testid': 'hud-company' } });
    this.town = el('span', { class: 'hud-town', attrs: { 'data-testid': 'hud-town' } });
    this.date = el('span', { class: 'hud-date num', attrs: { 'data-testid': 'hud-date' } });
    // The company on top; the date with the town beside it (the town gives way first when there is no room).
    this.when = el('div', { class: 'hud-when' }, [this.company, el('span', { class: 'hud-when-line' }, [this.date, this.town])]);
    this.cash = el('span', { class: 'hud-cash num', attrs: { 'data-testid': 'hud-cash' } });
    this.alertText = el('span');
    this.alert = el('span', { class: 'chip chip-alert hud-alert', attrs: { 'data-testid': 'hud-insolvency', role: 'status' } }, [
      icon(ICONS.warning),
      this.alertText,
    ]);
    this.alert.hidden = true;

    const action = (label: string, tip: string, svg: string, run: () => void) =>
      el('button', {
        class: `btn icon-btn hud-action hud-action-${label.toLowerCase()}`,
        attrs: { type: 'button', 'aria-label': label, 'data-tip': tip, 'aria-haspopup': 'dialog' },
        html: svg,
        on: { click: run },
      });
    this.pricingButton = action('Pricing', 'Pricing and marketing', ICONS.tag, actions.pricing);
    this.milestonesButton = action('Milestones', 'Milestones', ICONS.trophy, actions.milestones);
    this.bankButton = action('Bank', 'Bank: credit line and loans', ICONS.bank, actions.bank);
    this.menuButton = el('button', {
      class: 'btn icon-btn menu-button',
      attrs: { type: 'button', 'aria-label': 'Menu', 'aria-haspopup': 'true', 'aria-expanded': 'false' },
      html: ICONS.menu,
    });

    const label = (text: string) => el('span', { class: 'chip-label', text });
    this.passings = el('span', { class: 'num', attrs: { 'data-testid': 'hud-passings' } });
    this.subs = el('span', { class: 'num', attrs: { 'data-testid': 'hud-subs' } });
    this.mrr = el('span', { class: 'num', attrs: { 'data-testid': 'hud-mrr' } });
    this.pon = el('span', { class: 'num', attrs: { 'data-testid': 'hud-pon' } });
    this.building = el('span', { class: 'num', attrs: { 'data-testid': 'hud-building' } });
    this.cpp = el('span', { class: 'num', attrs: { 'data-testid': 'hud-cpp' } });
    this.cppChip = el('span', { class: 'chip chip-cpp', attrs: { hidden: '' } }, [
      el('span', { class: 'cpp-dot', attrs: { 'aria-hidden': 'true' } }),
      this.cpp,
      label(' per passing'),
    ]);
    this.ponChip = el('span', { class: 'chip chip-pon' }, [icon(ICONS.chip), this.pon]);
    // Counts every order not yet live: permitting as well as crews on site (the tooltip splits them).
    this.buildingChip = el('span', { class: 'chip chip-building' }, [icon(ICONS.crew), this.building, label(' in progress')]);
    // Debt and the covenant stage: buttons into the Bank, shown only while they matter.
    this.debt = el('span', { class: 'num' });
    this.debtChip = el(
      'button',
      {
        class: 'chip chip-button chip-debt',
        attrs: { type: 'button', 'data-testid': 'hud-debt', 'aria-haspopup': 'dialog', hidden: '' },
        on: { click: actions.bank },
      },
      [icon(ICONS.bank), this.debt],
    );
    this.covenant = el('span');
    this.covenantChip = el(
      'button',
      {
        class: 'chip chip-button chip-covenant chip-warn',
        attrs: { type: 'button', 'data-testid': 'hud-covenant', 'aria-haspopup': 'dialog', hidden: '' },
        on: { click: actions.bank },
      },
      [icon(ICONS.warning), this.covenant],
    );
    const stats = el('div', { class: 'hud-stats' }, [
      el('span', { class: 'chip chip-passings', attrs: { title: 'Homes and businesses your lit network passes' } }, [
        icon(ICONS.home),
        this.passings,
        label(' passings'),
      ]),
      this.cppChip,
      el('span', { class: 'chip chip-subs', attrs: { title: 'Subscribers: homes, businesses and apartments with service' } }, [
        icon(ICONS.users),
        this.subs,
        label(' subs'),
      ]),
      el('span', { class: 'chip chip-mrr', attrs: { title: MRR_TIP, 'data-testid': 'hud-mrr-chip' } }, [icon(ICONS.coins), label('MRR '), this.mrr]),
      this.ponChip,
      this.buildingChip,
      this.debtChip,
      this.covenantChip,
    ]);

    this.root = el('header', { class: 'hud pill-card', attrs: { 'aria-label': 'Game status' } }, [
      speeds,
      this.when,
      this.cash,
      this.alert,
      el('div', { class: 'hud-actions' }, [this.pricingButton, this.milestonesButton, this.bankButton]),
      this.menuButton,
      stats,
    ]);
  }

  update(session: GameSession): void {
    const state: GameState = session.state;
    const over = state.gameOver !== null;
    for (const [speed, button] of this.speedButtons) {
      const on = String(speed === session.speed);
      if (button.getAttribute('aria-pressed') !== on) button.setAttribute('aria-pressed', on);
      // The clock is frozen once the game is over.
      if (button.disabled !== over) button.disabled = over;
    }
    if (this.seen.state !== state) {
      // Names only change with the game in play.
      const who = hudIdentity(state);
      setText(this.company, who.company);
      setText(this.town, who.town);
      if (this.when.title !== who.tip) this.when.title = who.tip;
    }
    setText(this.date, formatDate(state.day));
    setText(this.cash, formatMoney(state.finance.cash));
    this.cash.classList.toggle('negative', state.finance.cash < 0);
    setText(this.passings, formatNumber(getService(state).passings));

    const overdraft = overdraftStatus(state);
    this.alert.hidden = overdraft === null;
    this.root.classList.toggle('alerting', overdraft !== null);
    if (overdraft) {
      setText(this.alertText, overdraft.text);
      this.alert.classList.toggle('chip-danger', overdraft.tone === 'danger');
      this.alert.classList.toggle('chip-warn', overdraft.tone === 'warn');
      if (this.alert.title !== overdraft.tip) this.alert.title = overdraft.tip;
    }

    // Subscriber figures walk every account: only when something happened.
    if (session.revision !== this.seen.revision || state !== this.seen.state) {
      this.seen = { revision: session.revision, state };
      setText(this.subs, formatNumber(subscriberUnits(state)));
      setText(this.mrr, `${formatMoney(monthlyRecurringRevenue(state))}/mo`);
      const pon = ponStatus(state);
      setText(this.pon, pon.text);
      this.ponChip.classList.toggle('chip-warn', pon.level === 'warn');
      this.ponChip.classList.toggle('chip-danger', pon.level === 'full');
      if (this.ponChip.title !== pon.tip) this.ponChip.title = pon.tip;
      const tip = runwayHint(state);
      if (this.cash.title !== tip) this.cash.title = tip;
      const cpp = cppStatus(state);
      this.cppChip.hidden = cpp === null;
      if (cpp) {
        setText(this.cpp, cpp.text);
        for (const band of ['green', 'amber', 'red'] as const) this.cppChip.classList.toggle(`band-${band}`, cpp.band === band);
        if (this.cppChip.title !== cpp.tip) this.cppChip.title = cpp.tip;
      }
      const debt = debtStatus(state);
      this.debtChip.hidden = debt === null;
      if (debt) {
        setText(this.debt, debt.text);
        if (this.debtChip.title !== debt.tip) this.debtChip.title = debt.tip;
        setLabel(this.debtChip, `${debt.text}: loans and payments`);
      }
      const covenant = covenantStatus(state);
      this.covenantChip.hidden = covenant === null;
      // Narrower screens drop the chip labels to make room for these two (see style.css).
      this.root.classList.toggle('has-debt', debt !== null || covenant !== null);
      if (covenant) {
        setText(this.covenant, covenant.text);
        this.covenantChip.classList.toggle('chip-warn', covenant.tone === 'warn');
        this.covenantChip.classList.toggle('chip-danger', covenant.tone === 'danger');
        if (this.covenantChip.title !== covenant.tip) this.covenantChip.title = covenant.tip;
        setLabel(this.covenantChip, `${covenant.text}: what it means`);
      }
    }

    let permitting = 0;
    let constructing = 0;
    for (const asset of [...state.network.spans, ...state.network.cabinets]) {
      if (asset.stage === 'permitting') permitting++;
      else if (asset.stage === 'constructing') constructing++;
    }
    setText(this.building, formatNumber(permitting + constructing));
    const tip = `${formatNumber(permitting)} permitting, ${formatNumber(constructing)} with crews on site`;
    if (this.buildingChip.title !== tip) this.buildingChip.title = tip;
  }
}

function setLabel(node: HTMLElement, label: string): void {
  if (node.getAttribute('aria-label') !== label) node.setAttribute('aria-label', label);
}
