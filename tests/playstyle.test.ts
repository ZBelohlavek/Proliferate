import { describe, expect, it } from 'vitest';
import { agreement, argmax, defaultWeights, FEATURES, fitWeights, type Answer } from '../src/ai/playstyle';
import { makeScenario } from '../src/ai/scenario';
import { playGame } from '../src/engine/game';
import { stompyDeck } from './helpers';

const LOW_LIFE = FEATURES.attack.findIndex((f) => f.key === 'lowLife');

/** Attack question where the AI prefers option 0 but the player always hits the lowest-life opponent. */
function lowLifeAnswer(seed: number): Answer {
  const options = [0, 1, 2].map((i) => {
    const x = new Array(FEATURES.attack.length).fill(0);
    x[0] = i === 0 ? 3 : 1 + ((seed + i) % 3) * 0.2; // AI score favours option 0
    x[LOW_LIFE] = i === 2 ? 0.8 : 0.1 * i; // option 2 is the low-life player
    return x;
  });
  return { kind: 'attack', options, chosen: 2, aiChoice: 0, at: seed };
}

describe('playstyle learning', () => {
  it('starts out identical to the default AI', () => {
    const w = fitWeights([]);
    expect(w).toEqual(defaultWeights());
  });

  it('learns a consistent preference and predicts it on unseen answers', () => {
    const answers = Array.from({ length: 20 }, (_, i) => lowLifeAnswer(i));
    const w = fitWeights(answers);
    expect(w.attack[LOW_LIFE]).toBeGreaterThan(1);
    expect(argmax(w.attack, lowLifeAnswer(99).options)).toBe(2);
    const score = agreement(answers)!;
    expect(score.defaultAi).toBe(0);
    expect(score.yourStyle).toBeGreaterThan(0.9);
  });

  it('stays close to the default with only a couple of answers', () => {
    const w = fitWeights([lowLifeAnswer(1)]);
    expect(Math.abs(w.attack[LOW_LIFE])).toBeLessThan(1.5);
  });
});

describe('scenarios', () => {
  it('builds a frozen board for every question type', () => {
    const decks = ['a', 'b', 'c', 'd'].map((id) => stompyDeck(id));
    for (const kind of ['threat', 'attack', 'cast'] as const) {
      const s = makeScenario(decks, decks[0], kind);
      expect(s, kind).not.toBeNull();
      expect(s!.options.length).toBeGreaterThan(1);
      expect(s!.options.every((x) => x.length === FEATURES[kind].length)).toBe(true);
      expect(s!.players.filter((p) => p.you)).toHaveLength(1);
      expect(s!.aiChoice).toBeLessThan(s!.options.length);
    }
  });

  it('games run with a learned playstyle', () => {
    const decks = ['a', 'b', 'c', 'd'].map((id) => stompyDeck(id));
    const w = fitWeights(Array.from({ length: 10 }, (_, i) => lowLifeAnswer(i)));
    for (let seed = 0; seed < 20; seed++) {
      const { result } = playGame(decks, seed, { playstyle: w });
      expect(result.placements.every((p) => p > 0)).toBe(true);
    }
  });
});
