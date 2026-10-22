// Round 4c/4d: the Bank's plain health words, shared by the Bank, the HUD
// chip and the month summary (ui/health.ts; ui-bank owns it).

import { describe, expect, it } from 'vitest';
import { COVENANT_CURE_CLOSES, FROZEN_ACCELERATION_CLOSES, PENALTY_STEP_UP_BPS } from '../sim/balance';
import { bankHealth } from '../sim/debt';
import { makeLoan, makeTradingState } from '../sim/testing/fixtures';
import type { BankHealth, BankHealthLevel } from '../sim/types';
import { formatPercentFine } from './format';
import { CALLED_WORD, HEALTH_ICON, HEALTH_TONE, HEALTH_WORD, healthSentence, healthTitle, healthTitleOf, stepBackText } from './health';
import { calledChipText } from './hud';

const JARGON = /leverage|covenant|DSCR|ARR|OCF|bps|×/i;
const LEVELS: BankHealthLevel[] = ['good', 'watch', 'warning', 'penalty', 'frozen'];

function health(level: BankHealthLevel, over: Partial<BankHealth> = {}): BankHealth {
  return { ...bankHealth(makeTradingState(30_000)), level, noDebt: false, ...over };
}

describe('bank health words', () => {
  it('has one plain word per level, never color alone', () => {
    expect(HEALTH_WORD).toEqual({ good: 'Good', watch: 'Watch', warning: 'Warning', penalty: 'Higher interest', frozen: 'No more borrowing' });
    expect(HEALTH_TONE).toEqual({ good: 'ok', watch: 'warn', warning: 'warn', penalty: 'danger', frozen: 'danger' });
    // Each level has its own icon shape beside its color.
    expect(new Set(LEVELS.map((l) => HEALTH_ICON[l])).size).toBe(LEVELS.length);
    expect(healthTitle('penalty')).toBe('Bank health: Higher interest');
    // Once the bank asks for every loan back, every screen names that step (the slip ladder's own name for it).
    expect(healthTitleOf({ level: 'penalty', called: true })).toBe(`Bank health: ${CALLED_WORD}`);
    expect(healthTitleOf({ level: 'penalty', called: false })).toBe(healthTitle('penalty'));
    expect(calledChipText(2).startsWith(`${CALLED_WORD}: `)).toBe(true);
  });

  it('says one plain sentence per level, without jargon', () => {
    const sentences = [
      healthSentence(health('good', { noDebt: true })),
      healthSentence(health('good')),
      healthSentence(health('watch', { nearLimit: true })),
      healthSentence(health('watch', { failingNow: true })),
      healthSentence(health('warning')),
      healthSentence(health('penalty', { penaltyBps: PENALTY_STEP_UP_BPS })),
      healthSentence(health('frozen', { closesUntilCalled: 3 })),
      healthSentence(health('frozen', { closesUntilCalled: 0 })),
      healthSentence(health('frozen', { closesUntilCalled: null, called: true })),
      healthSentence(health('frozen', { noDebt: true, closesUntilCalled: null })),
    ];
    expect(sentences[0]).toBe('No loans yet.');
    expect(sentences[1]).toBe('The bank checks two things each month. You pass both.');
    expect(sentences[2]).toBe("You pass both checks, but you're close to a limit.");
    expect(sentences[3]).toBe("At today's figures you'd fail a check at the next month close.");
    expect(sentences[4]).toBe('You went over a limit at the last month close. Nothing changes yet.');
    expect(sentences[5]).toBe(`You went over again. Every loan now costs ${formatPercentFine(PENALTY_STEP_UP_BPS / 10_000)} more.`);
    expect(sentences[6]).toBe("You can't borrow, the bank takes your spare cash each month, and if this goes on it asks for every loan back in 3 months.");
    expect(sentences[7]).toContain('at the next month close');
    expect(sentences[8]).toBe("The bank has asked for every loan back. You can't borrow until it's all repaid.");
    expect(sentences[9]).toBe('You owe nothing now, so the bank clears everything at the next month close.');
    for (const sentence of sentences) expect(sentence).not.toMatch(JARGON);
  });

  it('reads a real game: no debt is Good, a loan the cash flow cannot carry is Watch, a long freeze counts down', () => {
    const state = makeTradingState(30_000);
    expect(bankHealth(state).level).toBe('good');
    state.debt.loans = [makeLoan({ balance: 2_000_000, principal: 2_000_000 })];
    expect(HEALTH_WORD[bankHealth(state).level]).toBe('Watch');
    state.debt.covenant = { stage: 'frozen', compliantCloses: 0 };
    state.debt.frozenCloses = 2;
    expect(healthSentence(bankHealth(state))).toContain(`in ${FROZEN_ACCELERATION_CLOSES - 2} months`);
  });

  it('names how to step back down', () => {
    expect(stepBackText()).toBe(`${COVENANT_CURE_CLOSES} good month closes in a row move you back one step; with no debt the bank clears everything at the next close.`);
  });
});
