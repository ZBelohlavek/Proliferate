import { describe, expect, it } from 'vitest';
import { formatCountdown, limitReached, NO_LIMIT } from '../src/sim/limit';

describe('run limits', () => {
  it('never stops without a limit', () => {
    expect(limitReached(NO_LIMIT, 1e9, Date.now() + 1e12)).toBe(false);
  });
  it('stops at the time limit', () => {
    const limit = { stopAt: 1000, maxGames: null };
    expect(limitReached(limit, 0, 999)).toBe(false);
    expect(limitReached(limit, 0, 1000)).toBe(true);
  });
  it('stops at the game limit', () => {
    const limit = { stopAt: null, maxGames: 50 };
    expect(limitReached(limit, 49)).toBe(false);
    expect(limitReached(limit, 50)).toBe(true);
  });
  it('formats countdowns', () => {
    expect(formatCountdown(65_000)).toBe('1:05');
    expect(formatCountdown(3_909_000)).toBe('1:05:09');
    expect(formatCountdown(-5)).toBe('0:00');
  });
});
