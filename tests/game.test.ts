import { describe, expect, it } from 'vitest';
import { playGame } from '../src/engine/game';
import { addResult, computeRatings, emptyStats, wilson } from '../src/sim/stats';
import { stompyDeck } from './helpers';

describe('game engine', () => {
  it('plays a four-player game to a valid finish', () => {
    const decks = ['a', 'b', 'c', 'd'].map((id) => stompyDeck(id));
    const { result } = playGame(decks, 1);
    expect(result.seats).toEqual(['a', 'b', 'c', 'd']);
    expect(result.rounds).toBeGreaterThan(3);
    expect(result.eliminations.length).toBe(result.winner === null ? 4 : 3);
    if (result.winner !== null) expect(result.placements[result.winner]).toBe(1);
    expect([...result.placements].sort()).not.toContain(0);
  });

  it('is deterministic for a given seed', () => {
    const decks = ['a', 'b', 'c'].map((id) => stompyDeck(id));
    const first = playGame(decks, 99, { log: true });
    const second = playGame(decks, 99, { log: true });
    expect(second.result).toEqual(first.result);
    expect(second.log).toEqual(first.log);
  });

  it('never crashes across many seeds and pod sizes', () => {
    for (let seed = 0; seed < 60; seed++) {
      const size = 2 + (seed % 5);
      const decks = Array.from({ length: size }, (_, i) => stompyDeck(`d${i}`));
      const { result } = playGame(decks, seed);
      expect(result.placements).toHaveLength(size);
    }
  });

  it('a strictly stronger commander wins more often', () => {
    const stats = emptyStats();
    for (let seed = 0; seed < 300; seed++) {
      const decks = [stompyDeck('strong', 9), stompyDeck('weak1'), stompyDeck('weak2'), stompyDeck('weak3')];
      const shift = seed % 4;
      addResult(stats, playGame([...decks.slice(shift), ...decks.slice(0, shift)], seed).result);
    }
    const strong = stats.decks.strong.wins / stats.decks.strong.games;
    expect(strong).toBeGreaterThan(0.3);
    const ratings = computeRatings(stats);
    expect(ratings.strong).toBeGreaterThan(ratings.weak1);
  });
});

describe('stats', () => {
  it('computes a sensible Wilson interval', () => {
    const [lo, hi] = wilson(50, 100);
    expect(lo).toBeCloseTo(0.404, 2);
    expect(hi).toBeCloseTo(0.596, 2);
  });

  it('fits ratings that respect head-to-head results', () => {
    const stats = emptyStats();
    const result = (order: string[]) => ({
      seats: order,
      winner: 0,
      placements: [1, 2, 3],
      rounds: 10,
      eliminations: [],
      commanderRound: [null, null, null],
      mulligans: [0, 0, 0],
    });
    for (let i = 0; i < 30; i++) addResult(stats, result(['x', 'y', 'z']));
    for (let i = 0; i < 10; i++) addResult(stats, result(['y', 'x', 'z']));
    const r = computeRatings(stats);
    expect(r.x).toBeGreaterThan(r.y);
    expect(r.y).toBeGreaterThan(r.z);
    expect((r.x + r.y + r.z) / 3).toBeCloseTo(1500, 0);
  });
});
