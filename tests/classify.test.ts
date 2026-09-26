import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../src/engine/classify';
import type { EffectKind, SimCard } from '../src/engine/types';
import { card } from './helpers';

const kinds = (c: SimCard): EffectKind[] => c.effects.map((e) => e.kind);

describe('parseManaCost', () => {
  it('parses generic, colored, hybrid, X and Phyrexian symbols', () => {
    expect(parseManaCost('{3}{G}{G}')).toEqual({ generic: 3, pips: [['G'], ['G']], x: 0, life: 0 });
    expect(parseManaCost('{X}{R}')).toEqual({ generic: 0, pips: [['R']], x: 1, life: 0 });
    expect(parseManaCost('{G/U}{C}').pips).toEqual([['G', 'U'], ['C']]);
    expect(parseManaCost('{1}{G/P}').life).toBe(2);
  });
});

describe('classifyCard', () => {
  it('recognises mana rocks and merges multiple mana abilities', () => {
    const sol = card({ name: 'Sol Ring', manaCost: '{1}', cmc: 1, types: ['Artifact'], text: '{T}: Add {C}{C}.' });
    expect(sol.effects).toEqual([{ kind: 'mana', amount: 2, colors: ['C'], when: 'static' }]);

    const talisman = card({
      name: 'Talisman of Dominance', manaCost: '{2}', cmc: 2, types: ['Artifact'],
      text: '{T}: Add {C}.\n{T}: Add {U} or {B}. Talisman of Dominance deals 1 damage to you.',
    });
    expect(talisman.effects).toHaveLength(1);
    expect(talisman.effects[0]).toMatchObject({ kind: 'mana', amount: 1, colors: ['C', 'U', 'B'] });
  });

  it('recognises land ramp', () => {
    const cultivate = card({
      name: 'Cultivate', manaCost: '{2}{G}', cmc: 3, types: ['Sorcery'],
      text: 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.',
    });
    expect(cultivate.effects[0]).toMatchObject({ kind: 'ramp', lands: 1, toHand: 1, tapped: true });
  });

  it('recognises removal, wipes and counterspells', () => {
    const swords = card({ name: 'Swords to Plowshares', manaCost: '{W}', cmc: 1, types: ['Instant'], text: 'Exile target creature. Its controller gains life equal to its power.' });
    expect(swords.effects[0]).toMatchObject({ kind: 'removal', target: 'creature', mode: 'exile' });

    const wrath = card({ name: 'Wrath of God', manaCost: '{2}{W}{W}', cmc: 4, types: ['Sorcery'], text: "Destroy all creatures. They can't be regenerated." });
    expect(wrath.effects[0]).toMatchObject({ kind: 'wipe', target: 'creatures', mode: 'destroy', oneSided: false });

    const counterspell = card({ name: 'Counterspell', manaCost: '{U}{U}', cmc: 2, types: ['Instant'], text: 'Counter target spell.' });
    expect(kinds(counterspell)).toEqual(['counter']);
  });

  it('uses the card name and "this creature" interchangeably', () => {
    const old = card({ name: 'Ohran Viper', types: ['Creature'], power: '1', toughness: '3', text: 'Whenever Ohran Viper deals combat damage to a player, you may draw a card.' });
    const modern = card({ name: 'Ohran Viper', types: ['Creature'], power: '1', toughness: '3', text: 'Whenever this creature deals combat damage to a player, you may draw a card.' });
    expect(old.effects).toEqual(modern.effects);
    expect(old.effects[0]).toMatchObject({ kind: 'draw', n: 1, when: 'combatDamage', scope: 'self' });
  });

  it('keeps conditions on cast triggers and marks intervening-if triggers as conditional', () => {
    const yshtola = card({
      name: "Y'shtola, Night's Blessed", manaCost: '{1}{W}{U}{B}', cmc: 4, types: ['Creature'], superTypes: ['Legendary'], power: '2', toughness: '4',
      text: "Vigilance\nAt the beginning of each end step, if a player lost 4 or more life this turn, you draw a card.\nWhenever you cast a noncreature spell with mana value 3 or greater, Y'shtola deals 2 damage to each opponent and you gain 2 life.",
    });
    const draw = yshtola.effects.find((e) => e.kind === 'draw')!;
    expect(draw).toMatchObject({ when: 'upkeep', chance: 0.5 });
    const drain = yshtola.effects.find((e) => e.kind === 'drain')!;
    expect(drain).toMatchObject({ when: 'cast', castFilter: 'noncreature', minCmc: 3, n: 2, gain: 2 });
  });

  it('keeps X as X so the engine can use the amount paid', () => {
    const exsanguinate = card({ name: 'Exsanguinate', manaCost: '{X}{B}{B}', cmc: 2, types: ['Sorcery'], text: 'Each opponent loses X life. You gain life equal to the life lost this way.' });
    expect(exsanguinate.effects[0]).toMatchObject({ kind: 'drain', n: -1, gain: -1 });
  });

  it('parses activated abilities with sacrifice costs', () => {
    const bauble = card({
      name: "Wayfarer's Bauble", manaCost: '{1}', cmc: 1, types: ['Artifact'],
      text: '{2}, {T}, Sacrifice this artifact: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
    });
    expect(bauble.effects[0]).toMatchObject({ kind: 'ramp', when: 'activated', activation: { tap: true, sacrifice: true } });
  });

  it('reads basic land types and entering tapped', () => {
    const temple = card({ name: 'Temple of Mystery', types: ['Land'], text: 'This land enters tapped.\nWhen this land enters, scry 1.\n{T}: Add {G} or {U}.' });
    expect(temple.land).toEqual({ produces: ['G', 'U'], tapped: true });
    const shock = card({ name: 'Breeding Pool', types: ['Land'], subTypes: ['Forest', 'Island'], text: "As this land enters, you may pay 2 life. If you don't, it enters tapped." });
    expect(shock.land).toEqual({ produces: ['G', 'U'], tapped: false });
  });

  it('flags cards it cannot understand', () => {
    const propaganda = card({ name: 'Propaganda', manaCost: '{2}{U}', cmc: 3, types: ['Enchantment'], text: "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you." });
    expect(propaganda.modeled).toBe(false);
  });
});
