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

describe('"unless that player pays" is the payer\'s choice (rule 118.12)', () => {
  const study = () => card({ name: 'Rhystic Study', manaCost: '{2}{U}', cmc: 3, types: ['Enchantment'], text: 'Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.', colorIdentity: ['U'] });
  for (const pays of [true, false]) {
    it(`the caster ${pays ? 'pays {1} and nothing happens' : "doesn't pay, and the Study draws"}`, () => {
      const t = new Table();
      const [a, b] = t.game.players;
      t.game.put(1, study());
      a.hand.push(creature('Bear', '{1}{G}', 2, 2, 2));
      t.lands(0, 3);
      let asked = '';
      const cast = castOnce('Bear');
      t.handlers[0] = (g, d) => {
        if (d.kind === 'confirm' && d.reason === 'payTax') {
          asked = d.prompt;
          return pays;
        }
        return cast(g, d);
      };
      t.until((g) => g.players[0].battlefield.some((q) => q.card.name === 'Bear'));
      expect(asked).toMatch(/pay \{1\}/);
      const log = t.game.log!.slice(t.game.log!.findIndex((l) => /casts Bear/.test(l)));
      expect(log.some((l) => l === `${b.name} draws 1 card.`)).toBe(!pays);
      expect(a.battlefield.filter((q) => q.landInfo && q.tapped).length).toBe(pays ? 3 : 2);
    });
  }
});

describe('conditions the engine can see are checked, not rolled (rule 603.4)', () => {
  it('Counterbalance counters a spell only when the top card has the same mana value', () => {
    for (const same of [true, false]) {
      const t = new Table();
      const [a, b] = t.game.players;
      t.game.put(1, card({ name: 'Counterbalance', manaCost: '{U}{U}', cmc: 2, types: ['Enchantment'], text: 'Whenever an opponent casts a spell, you may reveal the top card of your library. If you do, counter that spell if it has the same mana value as the revealed card.', colorIdentity: ['U'] }));
      b.library.unshift(creature(same ? 'Two' : 'Five', same ? '{1}{G}' : '{4}{G}', same ? 2 : 5, 1, 1));
      a.hand.push(creature('Bear', '{1}{G}', 2, 2, 2));
      t.lands(0, 2);
      t.handlers[0] = castOnce('Bear');
      t.finishTurn();
      expect(a.battlefield.some((q) => q.card.name === 'Bear')).toBe(!same);
    }
  });

  it('Land Tax triggers only while an opponent has more lands', () => {
    const tax = () => card({ name: 'Land Tax', manaCost: '{W}', cmc: 1, types: ['Enchantment'], text: 'At the beginning of your upkeep, if an opponent controls more lands than you, you may search your library for up to three basic land cards, reveal them, put them into your hand, then shuffle.', colorIdentity: ['W'] });
    expect(tax().effects[0].ifCond).toEqual({ k: 'oppMoreLands' });
    expect(tax().effects[0].chance).toBeUndefined();
  });

  it('"at the beginning of your end step" triggers in the end step, after combat (rule 513.1)', () => {
    const t = new Table();
    const [a] = t.game.players;
    const raider = card({ name: 'End Watcher', manaCost: '{B}', cmc: 1, types: ['Enchantment'], text: 'At the beginning of your end step, if you attacked this turn, you gain 3 life.', colorIdentity: ['B'] });
    expect(raider.effects[0]).toEqual(expect.objectContaining({ when: 'upkeep', at: 'end', ifCond: { k: 'youAttacked' } }));
    t.game.put(0, raider);
    const bear = t.game.put(0, creature('Bear', '{1}{G}', 2, 2, 2));
    t.handlers[0] = (_g, d) => (d.kind === 'attackers' ? [{ attacker: bear.id, defender: 1 }] : undefined);
    const life = a.life;
    t.finishTurn();
    expect(a.life).toBe(life + 3);
  });

  it('"at the beginning of each opponent\'s upkeep" triggers on their turn, not yours', () => {
    const c = card({ name: 'Taxer', manaCost: '{B}', cmc: 1, types: ['Enchantment'], text: "At the beginning of each opponent's upkeep, you gain 1 life.", colorIdentity: ['B'] });
    expect(c.effects[0]).toEqual(expect.objectContaining({ when: 'upkeep', whose: 'opponents' }));
    const t = new Table();
    const [a, b] = t.game.players;
    t.game.put(0, c);
    const g = t.game as any;
    g.pending = [];
    g.fireStep(a, 'upkeep');
    expect(g.pending.length).toBe(0);
    g.fireStep(b, 'upkeep');
    expect(g.pending.length).toBe(1);
    g.pending = [];
    g.fireStep(b, 'end');
    expect(g.pending.length).toBe(0);
  });
});

describe('ward as printed and crew at instant speed', () => {
  it('ward—pay life costs life, not mana (rule 702.21a)', () => {
    const t = new Table();
    const [a] = t.game.players;
    const witch = t.game.put(1, creature('Life Warded', '{2}{B}', 3, 3, 2, { text: 'Ward—Pay 3 life.' }));
    expect(witch.card.ward).toEqual({ life: 3 });
    a.hand.push(bolt('Test Bolt deals 3 damage to any target.'));
    t.lands(0, 1);
    const cast = castOnce('Test Bolt');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: witch.id } : cast(g, d));
    const life = a.life;
    t.finishTurn();
    expect(a.life).toBe(life - 3);
    expect(t.game.findPerm(witch.id)).toBeNull();
  });

  it('ward {4} needs four more mana', () => {
    const t = new Table();
    const [a] = t.game.players;
    const big = t.game.put(1, creature('Mana Warded', '{4}{U}', 5, 3, 3, { text: 'Ward {4}' }));
    expect(big.card.ward).toEqual({ mana: 4 });
    a.hand.push(bolt('Test Bolt deals 3 damage to any target.'));
    t.lands(0, 4);
    let offered: number[] | undefined;
    t.handlers[0] = (_g, d) => {
      if (d.kind === 'target') offered = d.candidates.flatMap((c) => (c.kind === 'perm' ? [c.id] : []));
      return castOnce('Test Bolt')(_g, d);
    };
    t.finishTurn();
    // One land for the spell, four for ward: five needed, only four there.
    expect(offered ?? []).not.toContain(big.id);
  });

  it('a Vehicle can be crewed on an opponent\'s turn, to block (rule 702.122a)', () => {
    const t = new Table();
    const vehicle = t.game.put(1, card({ name: 'Test Wagon', manaCost: '{2}', cmc: 2, types: ['Artifact'], subTypes: ['Vehicle'], power: '4', toughness: '4', text: 'Crew 1', colorIdentity: [] }));
    t.game.put(1, creature('Pilot', '{G}', 1, 1, 1));
    let crewOffered = false;
    t.handlers[1] = (g, d) => {
      if (d.kind === 'priority' && g.activeSeat === 0) {
        const i = d.actions.findIndex((x) => x.type === 'crew' && x.permId === vehicle.id);
        if (i !== -1) crewOffered = true;
      }
      return undefined;
    };
    t.finishTurn();
    expect(crewOffered).toBe(true);
  });
});
