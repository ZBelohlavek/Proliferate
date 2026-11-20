// Rules the engine used to simplify, played as written now.

import { describe, expect, it } from 'vitest';
import { card, creature } from './helpers';
import { castOnce, Table } from './table';

const walker = (loyalty: number) => card({ name: 'Test Walker', manaCost: '{3}{G}', cmc: 4, types: ['Planeswalker'], loyalty, text: '+1: You gain 1 life.', colorIdentity: ['G'] });
const siege = () => card({
  name: 'Invasion of Testing', manaCost: '{3}{G}', cmc: 4, types: ['Battle'], subTypes: ['Siege'], layout: 'transform', defense: 4, colorIdentity: ['G'],
  text: "(As a Siege enters, choose an opponent to protect it. You and others can attack it. When it's defeated, exile it, then cast it transformed.)",
  back: { name: 'Test Faerie', types: ['Creature'], subTypes: ['Faerie'], text: 'Flying', power: '3', toughness: '3' },
});
const bolt = (text: string) => card({ name: 'Test Bolt', manaCost: '{G}', cmc: 1, types: ['Instant'], text, colorIdentity: ['G'] });

describe('damage to planeswalkers and battles (rules 115.4, 120.3)', () => {
  it('"any target" can hit a planeswalker, and its damage removes loyalty', () => {
    const t = new Table();
    const pw = t.game.put(1, walker(5));
    t.game.players[0].hand.push(bolt('Test Bolt deals 3 damage to any target.'));
    t.lands(0, 1);
    let offered: number[] = [];
    const cast = castOnce('Test Bolt');
    t.handlers[0] = (g, d) => {
      if (d.kind === 'target') {
        offered = d.candidates.flatMap((c) => (c.kind === 'perm' ? [c.id] : []));
        return { kind: 'perm', id: pw.id };
      }
      return cast(g, d);
    };
    t.finishTurn();
    expect(offered).toContain(pw.id);
    expect(t.game.findPerm(pw.id)?.loyalty).toBe(2);
  });

  it('"target creature or planeswalker" can hit a planeswalker but not a battle; "any target" can hit a battle', () => {
    const t = new Table();
    const pw = t.game.put(1, walker(5));
    const battle = t.game.put(0, siege());
    battle.defense = 4;
    battle.protector = 1;
    t.game.put(1, creature('Bear', '{1}{G}', 2, 2, 2));
    const targetsOf = (text: string) => {
      const c = bolt(text);
      return (t.game.targetCandidates(t.game.players[0], c.effects[0], null) ?? []).flatMap((x) => (x.kind === 'perm' ? [x.id] : []));
    };
    const cop = targetsOf('Test Bolt deals 3 damage to target creature or planeswalker.');
    expect(cop).toContain(pw.id);
    expect(cop).not.toContain(battle.id);
    const any = targetsOf('Test Bolt deals 3 damage to any target.');
    expect(any).toContain(battle.id);
    expect(targetsOf('Test Bolt deals 3 damage to target creature.')).not.toContain(pw.id);
  });

  it('burn removes defense from a battle, and a defeated Siege is cast transformed (cast triggers see it)', () => {
    const t = new Table();
    const [a] = t.game.players;
    const battle = t.game.put(0, siege());
    battle.defense = 3;
    battle.protector = 1;
    // "Whenever you cast a creature spell, you gain 1 life."
    t.game.put(0, card({ name: 'Test Watcher', manaCost: '{G}', cmc: 1, types: ['Enchantment'], text: 'Whenever you cast a creature spell, you gain 1 life.', colorIdentity: ['G'] }));
    a.hand.push(bolt('Test Bolt deals 3 damage to any target.'));
    t.lands(0, 1);
    const cast = castOnce('Test Bolt');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: battle.id } : cast(g, d));
    const life = a.life;
    t.finishTurn();
    expect(t.game.findPerm(battle.id)).toBeNull();
    const faerie = a.battlefield.find((q) => q.card.name === 'Test Faerie');
    expect(faerie).toBeDefined();
    expect(t.game.log?.some((l) => /casts Test Faerie transformed without paying its mana cost/.test(l))).toBe(true);
    expect(a.life).toBe(life + 1);
  });
});
