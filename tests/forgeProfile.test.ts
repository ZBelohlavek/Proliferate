import { describe, expect, it } from 'vitest';
import { estimateRates, profileOverrides, type ProfileAnswer } from '../src/ai/forgeProfile';
import { makeScenario, QUESTION_KINDS } from '../src/ai/scenario';
import { stompyDeck } from './helpers';

const answer = (kind: ProfileAnswer['kind'], yes: boolean, context: ProfileAnswer['context'] = {}): ProfileAnswer => ({ kind, yes, context, at: 0 });

describe('Forge profile learning', () => {
  it('matches Forge Default with no answers', () => {
    const o = profileOverrides([]);
    expect(o.CHANCE_TO_ATTACK_INTO_TRADE).toBe('0');
    expect(o.CHANCE_TO_COUNTER_CMC_1).toBe('30');
    expect(o.CHANCE_TO_COUNTER_CMC_2).toBe('75');
    expect(o.CHANCE_TO_COUNTER_CMC_3).toBe('100');
    expect(o.CHANCE_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK).toBe('65');
    expect(o.MIN_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK).toBe('30');
    expect(o.MAX_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK).toBe('70');
    expect(o.ACTIVELY_DESTROY_ARTS_AND_NONAURA_ENCHS).toBe('true');
  });

  it('moves toward your answers, blended with the default', () => {
    const answers = Array.from({ length: 12 }, () => answer('attackTrade', true, { oppHasMana: true }));
    const o = profileOverrides(answers);
    // 12 yes answers + 4 pseudo-answers at 0%: 12/16 = 75%
    expect(o.CHANCE_TO_ATTACK_INTO_TRADE).toBe('75');
    expect(o.PLAY_AGGRO).toBe('true');
  });

  it('routes counterspell answers by mana value and trick answers inverted', () => {
    const answers = [
      ...Array.from({ length: 8 }, () => answer('counter', false, { manaValue: 5 })),
      ...Array.from({ length: 8 }, () => answer('trick', true)), // cast now = don't wait
    ];
    const rates = Object.fromEntries(estimateRates(answers).map((r) => [r.key, r]));
    expect(rates.CHANCE_TO_COUNTER_CMC_3.answers).toBe(8);
    expect(rates.CHANCE_TO_COUNTER_CMC_3.value).toBeCloseTo(4 / 12);
    expect(rates.CHANCE_TO_COUNTER_CMC_1.answers).toBe(0);
    expect(rates.CHANCE_TO_HOLD_COMBAT_TRICKS_UNTIL_BLOCK.value).toBeCloseTo((0.65 * 4) / 12);
  });

  it('splits block answers by life total', () => {
    const answers = [answer('blockTrade', true, { life: 35 }), answer('blockTrade', false, { life: 8 })];
    const rates = Object.fromEntries(estimateRates(answers).map((r) => [r.key, r]));
    expect(rates.MIN_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK.answers).toBe(1);
    expect(rates.MAX_CHANCE_TO_RANDOMLY_TRADE_ON_BLOCK.answers).toBe(1);
  });
});

describe('quiz scenarios', () => {
  it('builds real board states for the question types', () => {
    const decks = ['a', 'b', 'c', 'd'].map((id) => stompyDeck(id));
    // The stompy test decks have creatures but no artifacts/enchantments, so skip that one.
    for (const kind of QUESTION_KINDS.filter((k) => k !== 'destroyArtifact')) {
      const s = makeScenario(decks, decks[0], kind);
      expect(s, kind).not.toBeNull();
      expect(s!.kind).toBe(kind);
      expect(s!.situation.length).toBeGreaterThan(20);
      expect(s!.players.filter((p) => p.you)).toHaveLength(1);
      if (kind === 'counter') expect(s!.context.manaValue).toBeGreaterThan(0);
      if (kind === 'blockTrade') expect(s!.context.life).toBeGreaterThan(0);
    }
  });
});
