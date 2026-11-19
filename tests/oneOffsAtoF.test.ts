// One-off cards from A to F (src/engine/cardRules.ts) and the small engine pieces added with them
// (src/engine/classifyBoard.ts): lasting -N/-N on opponents' creatures, opponents' permanents entering
// tapped, "whenever an artifact (enchantment) is put into a graveyard from the battlefield", and
// "costs {X} less, where X is ...". Cards use their real oracle text, with green mana costs where the
// test table needs them.

import { describe, expect, it } from 'vitest';
import { cardValue } from '../src/engine/classify';
import { CARD_RULES } from '../src/engine/cardRules';
import { card, creature, spell } from './helpers';
import { castOnce, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const artifact = (name: string, cost: string, cmc: number, text: string) => card({ name, manaCost: cost, cmc, types: ['Artifact'], text });
const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);

const eleshNorn = () => creature('Elesh Norn, Grand Cenobite', '{5}{W}{W}', 7, 4, 7, {
  text: 'Vigilance\nOther creatures you control get +2/+2.\nCreatures your opponents control get -2/-2.',
});
const authority = () => card({ name: 'Authority of the Consuls', manaCost: '{W}', cmc: 1, types: ['Enchantment'], text: 'Creatures your opponents control enter tapped.\nWhenever a creature an opponent controls enters, you gain 1 life.' });
const disciple = () => creature('Disciple of the Vault', '{B}', 1, 1, 1, { text: 'Whenever an artifact is put into a graveyard from the battlefield, you may have target opponent lose 1 life.' });
const reaper = () => creature("Ashiok's Reaper", '{3}{B}', 4, 3, 3, { text: 'Whenever an enchantment you control is put into a graveyard from the battlefield, draw a card.' });

describe('one-off cards A to F: reading', () => {
  it('every entry reads without unread lines, and blank entries are worth nothing to cast', () => {
    for (const name of ['Alora, Merry Thief', 'Bria, Riptide Rogue', 'Celebr-8000', 'Fiery Confluence', 'Darksteel Monolith']) expect(CARD_RULES[name]).toBeDefined();
    const celebr = creature('Celebr-8000', '{5}', 5, 3, 3, {
      keywords: ['Menace', 'Vigilance', 'Lifelink', 'Flying', 'Indestructible'],
      text: 'At the beginning of combat on your turn, roll two six-sided dice. For each result of 1, this creature gets +1/+1 until end of turn. For each other result, it gains the indicated ability until end of turn. If you rolled doubles, it also gains double strike until end of turn.\n• 2 — menace\n• 3 — vigilance\n• 4 — lifelink\n• 5 — flying\n• 6 — indestructible',
    });
    // The card data's keyword list names every die result; the rule clears it.
    expect(celebr.keywords).toEqual([]);
    expect(celebr.unread).toBeUndefined();
    const claws = artifact('Claws of Gix', '{0}', 0, '{1}, Sacrifice a permanent: You gain 1 life.');
    expect(claws.effects).toEqual([]);
    expect(claws.ruled).toBeDefined();
    expect(cardValue(claws)).toBe(0);
  });

  it('reads the general wordings added with these cards', () => {
    expect(eleshNorn().effects).toContainEqual(expect.objectContaining({ kind: 'oppAnthem', p: -2, t: -2, when: 'static' }));
    expect(authority().effects).toEqual([
      expect.objectContaining({ kind: 'oppEnterTapped', when: 'static' }),
      expect.objectContaining({ kind: 'gainLife', n: 1, when: 'opponentCreatureEnters' }),
    ]);
    expect(disciple().effects).toEqual([expect.objectContaining({ when: 'permDies', castFilter: 'artifact', scope: 'all' })]);
    expect(reaper().effects).toEqual([expect.objectContaining({ kind: 'draw', when: 'permDies', castFilter: 'enchantment', scope: 'any' })]);
    // A one-time "-2/-2 until end of turn" is still a sweeper.
    const wurm = spell('Shrivel', '{1}{B}', 2, 'Sorcery', 'All creatures get -1/-1 until end of turn.');
    expect(wurm.effects[0]).toMatchObject({ kind: 'wipe', shrink: 'temp' });
  });
});

describe('one-off cards A to F: engine', () => {
  it("Elesh Norn: opponents' creatures get -2/-2 while it stays, and x/2s die", () => {
    const t = new Table();
    const big = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    t.game.put(1, bears());
    t.game.put(0, eleshNorn());
    const mine = t.game.put(0, bears());
    expect(t.game.power(big)).toBe(4);
    expect(t.game.toughness(big)).toBe(2);
    expect(t.game.power(mine)).toBe(4);
    // State-based actions (rule 704.5f) run as the game goes on.
    t.lands(0, 1);
    t.game.players[0].hand.push(creature('Llanowar Elves', '{G}', 1, 1, 1));
    t.handlers[0] = castOnce('Llanowar Elves');
    t.until((g) => g.stack.length === 0 && g.players[0].battlefield.some((q) => q.card.name === 'Llanowar Elves'));
    expect(t.game.players[1].battlefield.map((q) => q.card.name)).toEqual(['Craw Wurm']);
  });

  it("Authority of the Consuls: an opponent's creature enters tapped and its owner's opponent gains 1", () => {
    const t = new Table();
    t.game.put(1, authority());
    t.lands(0, 2);
    t.game.players[0].hand.push(bears());
    t.handlers[0] = castOnce('Grizzly Bears');
    const life = t.game.players[1].life;
    t.until((g) => g.stack.length === 0 && g.players[0].battlefield.some((q) => q.card.name === 'Grizzly Bears'));
    t.until((g) => g.stack.length === 0);
    expect(t.game.players[0].battlefield.find((q) => q.card.name === 'Grizzly Bears')?.tapped).toBe(true);
    expect(t.game.players[1].life).toBe(life + 1);
  });

  it('Disciple of the Vault: an artifact going to a graveyard (any player\'s) makes an opponent lose 1', () => {
    const t = new Table();
    t.game.put(0, disciple());
    t.game.put(1, artifact('Sol Ring', '{1}', 1, '{T}: Add {C}{C}.'));
    t.lands(0, 2);
    t.game.players[0].hand.push(spell('Shatter', '{1}{G}', 2, 'Instant', 'Destroy target artifact.'));
    t.handlers[0] = castOnce('Shatter');
    const life = t.game.players[1].life;
    t.until((g) => g.players[1].graveyard.some((c) => c.name === 'Sol Ring') && g.stack.length === 0);
    expect(t.game.players[1].life).toBe(life - 1);
  });

  it('Cavern-Hoard Dragon costs {1} less for each artifact of the opponent with the most', () => {
    const t = new Table(3);
    const dragon = creature('Cavern-Hoard Dragon', '{7}{R}{R}', 9, 6, 6, {
      keywords: ['Flying', 'Trample', 'Haste'],
      text: 'This spell costs {X} less to cast, where X is the greatest number of artifacts an opponent controls.\nFlying, trample, haste\nWhenever this creature deals combat damage to a player, you create a Treasure token for each artifact that player controls.',
    });
    expect(dragon.discount).toEqual({ per: 'opponentArtifacts', amount: 1 });
    const p0 = t.game.players[0];
    const full = t.game.effectiveCost(p0, dragon);
    t.game.put(1, artifact('Sol Ring', '{1}', 1, '{T}: Add {C}{C}.'));
    t.game.put(2, artifact('Mind Stone', '{2}', 2, '{T}: Add {C}.'));
    t.game.put(2, artifact('Arcane Signet', '{2}', 2, '{T}: Add one mana of any color.'));
    expect(t.game.effectiveCost(p0, dragon)).toBe(full - 2);
    expect(log(t, /never/)).toEqual([]);
  });
});
