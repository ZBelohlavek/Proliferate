// Card-specific rules (src/engine/cardRules.ts): cards read from their own entry instead of
// the general reader. Real oracle text, with green mana costs since the test table only has Forests.

import { describe, expect, it } from 'vitest';
import { CARD_RULES } from '../src/engine/cardRules';
import { creature, spell } from './helpers';
import { attackAll, castOnce, Table } from './table';

const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const wurm = () => creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);
const ornithopter = () => spell('Ornithopter', '{0}', 0, 'Artifact Creature', 'Flying', { power: '0', toughness: '2' });
const manaDrain = () => spell('Mana Drain', '{G}{G}', 2, 'Instant', 'Counter target spell. At the beginning of your next main phase, add an amount of {C} equal to that spell\'s mana value.');
const misstep = () => spell('Mental Misstep', '{G}', 1, 'Instant', '({U/P} can be paid with either {U} or 2 life.)\nCounter target spell with mana value 1.');

describe('card-specific rules', () => {
  it('every rule says why, and gives the card something to do', () => {
    for (const [name, rule] of Object.entries(CARD_RULES)) {
      expect(rule.why.length, name).toBeGreaterThan(10);
      expect(rule.text !== undefined || !!rule.effects?.length || !!rule.add?.length, name).toBe(true);
    }
  });

  it('a ruled card is read from its rule, counts as fully read and says so', () => {
    const loran = creature('Loran of the Third Path', '{2}{W}', 3, 2, 1, { superTypes: ['Legendary'], text: 'Vigilance\nWhen Loran enters, destroy up to one target artifact or enchantment.\n{T}: You and target opponent each draw a card.' });
    expect(loran.unread).toBeUndefined();
    expect(loran.effects.some((e) => e.kind === 'removal' && e.when === 'resolve')).toBe(true);
    expect(loran.ruled).toMatch(/short name/);
    expect(loran.notes.some((n) => n.startsWith('Own rule:'))).toBe(true);
  });

  it('a card without data gets its text from the rule (Power Conduit)', () => {
    const conduit = spell('Power Conduit', '{2}', 2, 'Artifact', '');
    expect(conduit.modeled).toBe(true);
    expect(conduit.effects.some((e) => e.kind === 'charge')).toBe(true);
  });

  it('effects in a rule replace what the reader found (Breach the Multiverse)', () => {
    const breach = spell('Breach the Multiverse', '{5}{B}{B}', 7, 'Sorcery', 'Each player mills ten cards. For each player, choose a creature or planeswalker card in that player\'s graveyard. Put those cards onto the battlefield under your control. Then each creature you control becomes a Phyrexian in addition to its other types.');
    expect(breach.effects.map((e) => e.kind)).toEqual(['mill', 'recursion']);
    expect(breach.notes.filter((n) => /^Mill/.test(n))).toHaveLength(1);
  });

  it('Breach the Multiverse takes creatures from every graveyard', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 7);
    a.library = Array.from({ length: 20 }, () => bears());
    b.library = Array.from({ length: 20 }, () => wurm());
    a.hand.push(spell('Breach the Multiverse', '{5}{G}{G}', 7, 'Sorcery', 'Each player mills ten cards. For each player, choose a creature or planeswalker card in that player\'s graveyard. Put those cards onto the battlefield under your control. Then each creature you control becomes a Phyrexian in addition to its other types.'));
    const cast = castOnce('Breach the Multiverse');
    let max = 0;
    t.handlers[0] = (g, d) => {
      if (d.kind === 'choose' && d.reason === 'recursion') {
        max = d.max;
        return [d.options.findIndex((o) => o.label.startsWith('Craw Wurm')), d.options.findIndex((o) => o.label === 'Grizzly Bears')];
      }
      return cast(g, d);
    };
    t.finishTurn();
    expect(max).toBe(4);
    expect(a.battlefield.some((q) => q.card.name === 'Craw Wurm')).toBe(true);
    expect(a.battlefield.some((q) => q.card.name === 'Grizzly Bears')).toBe(true);
  });

  it('Mana Drain gives mana equal to the countered spell\'s mana value', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 6);
    t.lands(1, 2);
    a.hand.push(wurm());
    b.hand.push(manaDrain());
    t.handlers[0] = castOnce('Craw Wurm');
    t.handlers[1] = castOnce('Mana Drain', (g) => g.stack.length === 1);
    t.finishTurn();
    expect(a.graveyard.map((c) => c.name)).toContain('Craw Wurm');
    // The mana comes at the beginning of b's next main phase (it waits in the pool until then).
    expect(b.pool).toEqual([expect.objectContaining({ n: 6, until: 'nextMain' })]);
  });

  it('Mental Misstep can only counter a spell with mana value 1', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    t.lands(1, 1);
    a.hand.push(bears());
    b.hand.push(misstep());
    let offered = false;
    t.handlers[0] = castOnce('Grizzly Bears');
    t.handlers[1] = (g, d) => {
      if (d.kind === 'priority' && g.stack.length === 1 && d.actions.some((x) => x.type === 'cast' && x.card.name === 'Mental Misstep')) offered = true;
      return undefined;
    };
    t.finishTurn();
    expect(offered).toBe(false);
    expect(a.battlefield.some((q) => q.card.name === 'Grizzly Bears')).toBe(true);
  });

  it('Aetherize returns the creatures attacking you to their owners\' hands', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.game.put(0, wurm());
    t.game.put(0, ornithopter());
    t.lands(1, 4);
    b.hand.push(spell('Aetherize', '{3}{G}', 4, 'Instant', 'Return all attacking creatures to their owner\'s hand.'));
    t.handlers[0] = attackAll(1);
    t.handlers[1] = castOnce('Aetherize', (g) => g.step === 'declareBlockers');
    const life = b.life;
    t.finishTurn();
    expect(b.life).toBe(life);
    expect(a.battlefield.some((q) => q.card.isCreature)).toBe(false);
    expect(a.hand.map((c) => c.name).sort()).toEqual(['Craw Wurm', 'Ornithopter']);
  });

  it('Massacre Wurm punishes each opponent\'s creature dying', () => {
    const massacre = creature('Massacre Wurm', '{3}{B}{B}{B}', 6, 6, 5, { text: 'When this creature enters, creatures your opponents control get -2/-2 until end of turn.\nWhenever a creature an opponent controls dies, that player loses 2 life.' });
    expect(massacre.unread).toBeUndefined();
    expect(massacre.effects.some((e) => e.when === 'creatureDies' && e.scope === 'opponents' && e.kind === 'damagePlayer' && e.n === 2)).toBe(true);
  });
});
