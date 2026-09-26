import { describe, expect, it } from 'vitest';
import { estimateBracket, type BracketData } from '../src/analysis/bracket';
import { cardReport } from '../src/analysis/cards';
import { addResult, emptyStats } from '../src/sim/stats';
import type { GameResult } from '../src/engine/types';
import { stompyDeck } from './helpers';

const base: BracketData = { fetchedAt: 0, spellbookTag: 'Core', gameChangers: [], massLandDenial: [], extraTurns: [], combos: [] };
const combo = (cards: string[], manaValue: number, extra: Partial<BracketData['combos'][number]> = {}) => ({
  cards, twoCard: cards.length === 2, tag: 'Spicy', results: ['Win the game'], massLandDenial: false, extraTurn: false, lock: false, manaValue, ...extra,
});

describe('estimateBracket', () => {
  it('defaults to 2 with no Game Changers or combos', () => {
    const e = estimateBracket(base);
    expect(e.bracket).toBe(2);
    expect(e.note).toContain('or 1');
  });

  it('follows the Game Changer limits', () => {
    expect(estimateBracket({ ...base, gameChangers: ['Rhystic Study'] }).bracket).toBe(3);
    expect(estimateBracket({ ...base, gameChangers: ['A', 'B', 'C'] }).bracket).toBe(3);
    expect(estimateBracket({ ...base, gameChangers: ['A', 'B', 'C', 'D'] }).bracket).toBe(4);
  });

  it('uses combos, land denial and extra turns as barometers', () => {
    expect(estimateBracket({ ...base, massLandDenial: ['Armageddon'] }).bracket).toBe(4);
    expect(estimateBracket({ ...base, combos: [combo(['Sanguine Bond', 'Exquisite Blood'], 10)] }).bracket).toBe(3);
    expect(estimateBracket({ ...base, combos: [combo(["Thassa's Oracle", 'Demonic Consultation'], 3)] }).bracket).toBe(4);
    expect(estimateBracket({ ...base, extraTurns: ['Time Warp'] }).bracket).toBe(2);
    expect(estimateBracket({ ...base, extraTurns: ['Time Warp', 'Temporal Manipulation', 'Capture of Jingzhou'] }).bracket).toBe(3);
  });

  it('uses Forge win speed when there is enough data', () => {
    const fast = { winRounds: [0, 0, 0, 0, 3, 3, 2, 1, 1] } as never; // 10 wins, 8 by round 6
    const e = estimateBracket(base, fast);
    expect(e.bracket).toBe(4);
    expect(e.speed?.wins).toBe(10);
  });
});

describe('cardReport', () => {
  it('finds a card that makes the deck lose when it shows up early', () => {
    const deck = stompyDeck('d');
    const stats = emptyStats();
    const game = (won: boolean, early: string[]): GameResult => ({
      seats: ['d', 'x'], winner: won ? 0 : 1, placements: won ? [1, 2] : [2, 1], rounds: 10, eliminations: [],
      commanderRound: [null, null], mulligans: [0, 0],
      cards: [{ early, drawn: early, cast: early }, { early: [], drawn: [], cast: [] }],
    });
    // Craw Wurm shows up early in half the games and the deck loses those far more often.
    for (let i = 0; i < 400; i++) {
      const hasWurm = i % 2 === 0;
      const won = hasWurm ? i % 10 === 0 : i % 10 !== 1;
      addResult(stats, game(won, hasWurm ? ['Craw Wurm', 'Grizzly Bears'] : ['Grizzly Bears']));
    }
    const report = cardReport(stats, deck, 'early');
    const wurm = report.rows.find((r) => r.name === 'Craw Wurm')!;
    expect(wurm.verdict).toBe('weak');
    expect(wurm.impact!).toBeLessThan(-50);
    // Bears were in every game, so there's nothing to compare against.
    expect(report.rows.find((r) => r.name === 'Grizzly Bears')!.verdict).toBe('unknown');
  });
});
