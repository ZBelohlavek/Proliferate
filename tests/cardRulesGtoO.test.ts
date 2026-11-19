// One-off card rules G to O (src/engine/cardRulesGtoO.ts) and the small engine keywords they
// needed: cascade, living weapon, mentor, fabricate, assist, "whenever you discard", maximum
// hand size, Kroxa's escape check and Mithril Coat's attach. Real oracle text, with green costs
// since the test table only has Forests.

import { describe, expect, it } from 'vitest';
import { CARD_RULES_G_TO_O } from '../src/engine/cardRulesGtoO';
import { creature, spell } from './helpers';
import { castOnce, Table } from './table';

const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const filler = () => spell('Giant Growth', '{G}', 1, 'Instant', 'Target creature gets +3/+3 until end of turn.');

describe('one-off card rules, G to O', () => {
  it('every entry says why and is in alphabetical order', () => {
    const names = Object.keys(CARD_RULES_G_TO_O);
    for (const name of names) {
      expect(CARD_RULES_G_TO_O[name].why.length, name).toBeGreaterThan(10);
      expect(name[0] >= 'G' && name[0] <= 'O', name).toBe(true);
    }
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('reads the keyword lines it adds', () => {
    const apprentice = creature('Marionette Apprentice', '{1}{G}', 2, 1, 2, { text: 'Fabricate 1 (When this creature enters, put a +1/+1 counter on it or create a 1/1 colorless Servo artifact creature token.)\nWhenever another creature or artifact you control is put into a graveyard from the battlefield, each opponent loses 1 life.' });
    expect(apprentice.effects.some((e) => e.kind === 'tokens' && e.when === 'resolve' && e.power === 1)).toBe(true);
    const danny = creature('Mentor Test', '{2}{G}', 3, 3, 3, { text: 'Mentor (Whenever this creature attacks, put a +1/+1 counter on target attacking creature with lesser power.)' });
    expect(danny.unread).toBeUndefined();
    expect(danny.effects.some((e) => e.kind === 'counters' && e.when === 'attack')).toBe(true);
    const bounds = spell('Out of Bounds', '{3}{G}', 4, 'Instant', 'Assist (Another player can pay up to {3} of this spell\'s cost.)\nCounter target spell.');
    expect(bounds.unread).toBeUndefined();
    const wanderer = creature('Maelstrom Wanderer', '{5}{G}{G}{G}', 8, 7, 5, { text: 'Creatures you control have haste.\nCascade, cascade' });
    expect(wanderer.cascade).toBe(2);
  });

  it('"Other Goblin creatures you control" is Goblins only', () => {
    const auntie = creature('Goblin Lord Test', '{2}{G}', 3, 2, 2, { text: 'Other Goblin creatures you control get +1/+1.' });
    expect(auntie.effects).toContainEqual(expect.objectContaining({ kind: 'anthem', subtype: 'goblin', other: true }));
  });

  it('cascade casts a cheaper spell from the top of the library for free', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 8);
    a.library = [spell('Forest', '', 0, 'Land', ''), bears(), ...Array.from({ length: 10 }, filler)];
    a.hand.push(creature('Maelstrom Wanderer', '{5}{G}{G}{G}', 8, 7, 5, { text: 'Creatures you control have haste.\nCascade, cascade' }));
    const cast = castOnce('Maelstrom Wanderer');
    t.handlers[0] = (g, d) => (d.kind === 'choose' && d.reason === 'freeCast' ? [0] : cast(g, d));
    t.finishTurn();
    expect(a.battlefield.some((q) => q.card.name === 'Grizzly Bears')).toBe(true);
    expect(a.battlefield.some((q) => q.card.name === 'Maelstrom Wanderer')).toBe(true);
  });

  it('living weapon makes a Germ wearing the Equipment', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 4);
    a.hand.push(spell('Lashwrithe', '{4}', 4, 'Artifact', 'Living weapon\nEquipped creature gets +1/+1 for each Swamp you control.\nEquip {B/P}{B/P}', { subTypes: ['Equipment'] }));
    t.handlers[0] = castOnce('Lashwrithe');
    t.finishTurn();
    const germ = a.battlefield.find((q) => q.token && q.card.isCreature);
    const rig = a.battlefield.find((q) => q.card.name === 'Lashwrithe');
    expect(germ).toBeDefined();
    expect(rig?.attachedTo).toBe(germ!.id);
  });

  it('Mithril Coat attaches itself to a legendary creature as it enters', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    t.game.put(0, bears());
    const legend = t.game.put(0, creature('Legendary Bear', '{1}{G}', 2, 2, 2, { superTypes: ['Legendary'] }));
    a.hand.push(spell('Mithril Coat', '{3}', 3, 'Artifact', 'Flash\nIndestructible\nWhen Mithril Coat enters, attach it to target legendary creature you control.\nEquipped creature has indestructible.\nEquip {3}', { subTypes: ['Equipment'] }));
    t.handlers[0] = castOnce('Mithril Coat');
    t.finishTurn();
    expect(a.battlefield.find((q) => q.card.name === 'Mithril Coat')?.attachedTo).toBe(legend.id);
  });

  it("Jin-Gitaxias makes opponents discard their hand at cleanup; Gnat Miser takes one card", () => {
    const t = new Table();
    const [, b] = t.game.players;
    t.game.put(0, creature('Gnat Miser', '{G}', 1, 1, 1, { text: "Each opponent's maximum hand size is reduced by one." }));
    b.hand.push(...Array.from({ length: 9 }, filler));
    t.finishTurn();
    t.finishTurn();
    expect(b.hand.length).toBe(6);
    t.game.put(0, creature('Jin-Gitaxias, Core Augur', '{8}{G}{G}', 10, 5, 4, { superTypes: ['Legendary'], text: "Flash\nAt the beginning of your end step, draw seven cards.\nEach opponent's maximum hand size is reduced by seven." }));
    t.finishTurn();
    t.finishTurn();
    expect(b.hand.length).toBe(0);
  });

  it('"Whenever you discard a card" triggers on discarding to hand size (Monument to Endurance)', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.game.put(0, spell('Monument to Endurance', '{3}', 3, 'Artifact', 'Whenever you discard a card, choose one that hasn\'t been chosen this turn —\n• Draw a card.\n• Create a Treasure token.\n• Each opponent loses 3 life.'));
    a.hand.push(...Array.from({ length: 9 }, filler));
    const life = b.life;
    t.finishTurn();
    expect(b.life).toBe(life - 3);
  });

  it('Kroxa is sacrificed when cast from hand', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    a.hand.push(creature("Kroxa, Titan of Death's Hunger", '{G}{G}', 2, 6, 6, { superTypes: ['Legendary'], text: "When Kroxa enters, sacrifice it unless it escaped.\nWhenever Kroxa enters or attacks, each opponent discards a card, then each opponent who didn't discard a nonland card this way loses 3 life.\nEscape—{B}{B}{R}{R}, Exile five other cards from your graveyard." }));
    t.handlers[0] = castOnce("Kroxa, Titan of Death's Hunger");
    t.finishTurn();
    expect(a.battlefield.some((q) => q.card.name.startsWith('Kroxa'))).toBe(false);
    expect(a.graveyard.some((c) => c.name.startsWith('Kroxa'))).toBe(true);
  });
});
