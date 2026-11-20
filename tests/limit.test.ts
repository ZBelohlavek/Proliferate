import { describe, expect, it } from 'vitest';
import { formatCountdown, limitReached, NO_LIMIT, settleProgress } from '../src/sim/limit';

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

describe('until the win rates settle', () => {
  it('waits for every deck to have enough games', () => {
    const p = settleProgress({ a: { games: 20, wins: 0 }, b: { games: 1000, wins: 250 } }, ['a', 'b']);
    expect(p.settled).toBe(false);
    expect(p.widest?.id).toBe('a');
  });
  it('waits while any win rate is uncertain', () => {
    expect(settleProgress({ a: { games: 100, wins: 25 }, b: { games: 1000, wins: 250 } }, ['a', 'b']).settled).toBe(false);
  });
  it('stops once every deck is known to within 5 points', () => {
    const p = settleProgress({ a: { games: 300, wins: 75 }, b: { games: 1000, wins: 250 } }, ['a', 'b']);
    expect(p.settled).toBe(true);
    expect(p.widest!.margin).toBeLessThanOrEqual(0.05);
  });
  it('counts a deck with no games as unsettled', () => {
    expect(settleProgress({}, ['a']).settled).toBe(false);
    expect(settleProgress({}, []).settled).toBe(false);
  });
});
