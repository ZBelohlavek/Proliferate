import { describe, expect, it } from 'vitest';
import { Game } from '../src/engine/game';
import { choosePod, MAX_PLAYERS, pickPodSize, sanitizePodSize, shuffle, type Pairing } from '../src/sim/pods';
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

describe('choosing decks for each game', () => {
  const decks = ['A', 'B', 'C', 'D', 'E', 'F'];

  function draw(pairing: Pairing, games: number) {
    const played = new Map<string, number>();
    const pairs = new Map<string, number>();
    const pods = new Set<string>();
    for (let i = 0; i < games; i++) {
      const pod = choosePod(decks, (d) => d, played, 4, pairing);
      expect(new Set(pod).size).toBe(4);
      pods.add([...pod].sort().join(''));
      for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) {
        const key = [pod[a], pod[b]].sort().join('');
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
    return { played, pairs: [...pairs.values()], pods };
  }

  for (const pairing of ['balanced', 'random'] as const) {
    it(`${pairing}: every matchup comes up about equally often`, () => {
      const { pairs, pods } = draw(pairing, 12000);
      expect(pods.size).toBe(15); // all possible 4-deck pods from 6 decks
      expect(pairs).toHaveLength(15);
      expect(Math.max(...pairs) / Math.min(...pairs)).toBeLessThan(1.08);
    });
  }

  it('balanced: every deck plays the same number of games', () => {
    const { played } = draw('balanced', 3000);
    expect(new Set(played.values())).toEqual(new Set([2000]));
  });

  it('shuffles fairly', () => {
    const firsts = new Map<string, number>();
    for (let i = 0; i < 30000; i++) {
      const first = shuffle(['a', 'b', 'c', 'd', 'e'])[0];
      firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    const counts = [...firsts.values()];
    expect(Math.max(...counts) / Math.min(...counts)).toBeLessThan(1.1);
  });
});
