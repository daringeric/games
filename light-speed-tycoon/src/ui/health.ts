// The Bank's health in plain words (round 4c/4d, spec H): one word per
// debt.bankHealth level and one plain sentence, shared by the Bank panel
// (its health status), the HUD's bank chip and the month summary ("Needs
// attention", the bank headline), so all three always say the same thing.
// No jargon (no "leverage", "covenant", "DSCR"): those words appear only
// inside the Bank's disclosures, next to their plain meaning.
//
// Owner: ui-bank workstream (the HUD and the month summary import the words).

import { COVENANT_CURE_CLOSES } from '../sim/balance';
import type { BankHealth, BankHealthLevel } from '../sim/types';
import { formatPercentFine, plural } from './format';

/** The word for each level: "Bank health: Good". */
export const HEALTH_WORD: Readonly<Record<BankHealthLevel, string>> = {
  good: 'Good',
  watch: 'Watch',
  warning: 'Warning',
  penalty: 'Higher interest',
  frozen: 'No more borrowing',
};

/** Tone beside the word (never color alone: the word and the icon's shape carry it too). */
export type HealthTone = 'ok' | 'warn' | 'danger';

export const HEALTH_TONE: Readonly<Record<BankHealthLevel, HealthTone>> = {
  good: 'ok',
  watch: 'warn',
  warning: 'warn',
  penalty: 'danger',
  frozen: 'danger',
};

/**
 * The status icon's shape for each level, so the level never rests on color
 * alone: a check in a circle (good), "!" in a circle (watch), "!" in a
 * triangle (warning), an up arrow in a triangle (penalty: interest went up),
 * a bar in an octagon (frozen: a stop sign).
 */
export const HEALTH_ICON: Readonly<Record<BankHealthLevel, 'check' | 'watch' | 'warning' | 'rate' | 'stop'>> = {
  good: 'check',
  watch: 'watch',
  warning: 'warning',
  penalty: 'rate',
  frozen: 'stop',
};

/** "Bank health: Good" */
export function healthTitle(level: BankHealthLevel): string {
  return `Bank health: ${HEALTH_WORD[level]}`;
}

/**
 * The word once the bank has asked for every loan back, whatever the stage:
 * the Bank's title, the HUD chip ("Loans called: 2 closes left") and the
 * month summary's badge all say it, as the slip ladder names that step.
 */
export const CALLED_WORD = 'Loans called';

/** The word for a health: CALLED_WORD once the loans are called, else HEALTH_WORD[level]. */
export function healthWordOf(health: Pick<BankHealth, 'level' | 'called'>): string {
  return health.called ? CALLED_WORD : HEALTH_WORD[health.level];
}

/** "Bank health: Good", or "Bank health: Loans called" once the bank has asked for every loan back. */
export function healthTitleOf(health: Pick<BankHealth, 'level' | 'called'>): string {
  return `Bank health: ${healthWordOf(health)}`;
}

/**
 * The plain sentence under "Bank health: <word>" (spec H.2): what the
 * level means now. Frozen names the months left before the bank asks for
 * every loan back when it counts down (BankHealth.closesUntilCalled); once
 * the bank has asked for them (BankHealth.called) that leads, whatever the
 * stage.
 */
export function healthSentence(health: BankHealth): string {
  if (health.called) return "The bank has asked for every loan back. You can't borrow until it's all repaid.";
  if (health.noDebt && health.level !== 'good') return 'You owe nothing now, so the bank clears everything at the next month close.';
  switch (health.level) {
    case 'good':
      return health.noDebt ? 'No loans yet.' : 'The bank checks two things each month. You pass both.';
    case 'watch':
      return health.failingNow
        ? "At today's figures you'd fail a check at the next month close."
        : "You pass both checks, but you're close to a limit.";
    case 'warning':
      return 'You went over a limit at the last month close. Nothing changes yet.';
    case 'penalty':
      return `You went over again. Every loan now costs ${formatPercentFine(health.penaltyBps / 10_000)} more.`;
    case 'frozen': {
      const left = health.closesUntilCalled;
      const when = left === null ? '' : left <= 0 ? ' at the next month close' : ` in ${plural(left, 'month')}`;
      return `You can't borrow, the bank takes your spare cash each month, and if this goes on it asks for every loan back${when}.`;
    }
  }
}

/** How to step back down (spec H.6): "2 good month closes in a row move you back one step; with no debt the bank clears everything at the next close." */
export function stepBackText(): string {
  return `${plural(COVENANT_CURE_CLOSES, 'good month close')} in a row move you back one step; with no debt the bank clears everything at the next close.`;
}
