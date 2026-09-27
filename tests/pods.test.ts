import { describe, expect, it } from 'vitest';
import { Game } from '../src/engine/game';
import { MAX_PLAYERS, pickPodSize, sanitizePodSize } from '../src/sim/pods';
import { stompyDeck } from './helpers';

describe('pod size', () => {
  it('uses the chosen table size no matter how many decks are selected', () => {
    for (let i = 0; i < 200; i++) expect(pickPodSize(4, 10)).toBe(4);
    expect(pickPodSize(4, 3)).toBe(3); // only three decks available
  });

  it('never seats more than six players', () => {
    for (let i = 0; i < 500; i++) {
      const mixed = pickPodSize(0, 12);
      expect(mixed).toBeGreaterThanOrEqual(2);
      expect(mixed).toBeLessThanOrEqual(MAX_PLAYERS);
    }
    expect(pickPodSize(9, 12)).toBe(MAX_PLAYERS);
  });

  it('cleans up bad saved settings', () => {
    expect(sanitizePodSize(0)).toBe(0);
    expect(sanitizePodSize(5)).toBe(5);
    expect(sanitizePodSize(8)).toBe(4);
    expect(sanitizePodSize('abc')).toBe(4);
    expect(sanitizePodSize(undefined)).toBe(4);
  });

  it('the engine refuses games with more than six players', () => {
    const decks = Array.from({ length: 7 }, (_, i) => stompyDeck(`d${i}`));
    expect(() => new Game(decks, 1)).toThrow(/2–6 players/);
    expect(() => new Game(decks.slice(0, 6), 1)).not.toThrow();
  });
});
