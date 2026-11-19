// Lands, mechanic leftovers and approximations finished in cardRulesLands.ts / cardRulesLate.ts:
// the engine pieces they needed (wheels for everyone, counted draws, High Tide, Genesis digs,
// Three Tree City / Nykthos mana, Lotus Field's sacrifice, manlands with infect).

import { describe, expect, it } from 'vitest';
import { CARD_RULES } from '../src/engine/cardRules';
import { card, creature, forest, spell } from './helpers';
import { castOnce, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const land = (name: string, text: string, extra: Record<string, unknown> = {}) => card({ name, types: ['Land'], text, ...extra });
const island = () => card({ name: 'Island', types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], colorIdentity: ['U'] });

describe('wheels for everyone', () => {
  it('reads Windfall and Wheel of Fortune', () => {
    const windfall = spell('Windfall', '{G}', 1, 'Sorcery', 'Each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way.');
    expect(windfall.effects).toEqual([expect.objectContaining({ kind: 'wheelAll', n: 'max', when: 'resolve' })]);
    const wheel = spell('Wheel of Fortune', '{G}', 1, 'Sorcery', 'Each player discards their hand, then draws seven cards.');
    expect(wheel.effects).toEqual([expect.objectContaining({ kind: 'wheelAll', n: 7 })]);
  });

  it('Windfall: everyone discards and draws as many as the most anyone discarded', () => {
    const t = new Table();
    t.lands(0, 1);
    const [p0, p1] = t.game.players;
    p0.hand.push(spell('Windfall', '{G}', 1, 'Sorcery', 'Each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way.'));
    for (let i = 0; i < 5; i++) p1.hand.push(forest());
    t.handlers[0] = castOnce('Windfall');
    t.until((g) => log(t, /Each player discards their hand/).length > 0 && g.stack.length === 0);
    expect(p1.hand).toHaveLength(5);
    expect(p0.hand).toHaveLength(5);
    expect(p1.graveyard.filter((c) => c.name === 'Forest')).toHaveLength(5);
  });
});

describe('counted draws', () => {
  it('Rishkar\'s Expertise draws the greatest power among your creatures', () => {
    const rishkar = spell("Rishkar's Expertise", '{G}', 1, 'Sorcery', 'Draw cards equal to the greatest power among creatures you control.');
    expect(rishkar.effects[0]).toMatchObject({ kind: 'draw', count: 'greatestPower' });
    const t = new Table();
    t.lands(0, 1);
    const p0 = t.game.players[0];
    t.game.put(0, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    p0.hand.push(rishkar);
    t.handlers[0] = castOnce("Rishkar's Expertise");
    t.until(() => log(t, /draws 6 cards/).length > 0);
    expect(p0.hand).toHaveLength(6);
  });

  it('Sea Gate Restoration draws your hand size plus one', () => {
    const sea = spell('Sea Gate Restoration', '{G}', 1, 'Sorcery', 'Draw cards equal to the number of cards in your hand plus one. You have no maximum hand size for the rest of the game.');
    expect(sea.effects[0]).toMatchObject({ kind: 'draw', count: 'handPlusOne' });
    const t = new Table();
    t.lands(0, 1);
    const p0 = t.game.players[0];
    p0.hand.push(sea, forest(), forest());
    t.handlers[0] = castOnce('Sea Gate Restoration');
    t.until(() => log(t, /draws 3 cards/).length > 0);
    expect(p0.hand).toHaveLength(5);
  });
});

describe('High Tide', () => {
  it('makes one extra {U} for each untapped Island', () => {
    const tide = spell('High Tide', '{G}', 1, 'Instant', 'Until end of turn, whenever a player taps an Island for mana, that player adds an additional {U}.');
    expect(tide.effects[0]).toMatchObject({ kind: 'treasure', ritual: true, islands: true });
    const t = new Table();
    t.lands(0, 1);
    for (let i = 0; i < 4; i++) t.game.put(0, island());
    t.game.players[0].hand.push(tide);
    t.handlers[0] = castOnce('High Tide');
    t.until(() => log(t, /gets 4 mana/).length > 0);
    expect(log(t, /gets 4 mana/)).toHaveLength(1);
  });
});

describe('Genesis digs', () => {
  it('Genesis Ultimatum puts every permanent card among the top five onto the battlefield and the rest into hand', () => {
    const ult = spell('Genesis Ultimatum', '{G}', 1, 'Sorcery', 'Look at the top five cards of your library. Put any number of permanent cards from among them onto the battlefield and the rest into your hand. Exile Genesis Ultimatum.');
    expect(ult.effects[0]).toMatchObject({ kind: 'digPermanent', among: 5, permanents: { rest: 'hand' } });
    const t = new Table();
    t.lands(0, 1);
    const p0 = t.game.players[0];
    p0.library.unshift(creature('Grizzly Bears', '{1}{G}', 2, 2, 2), spell('Giant Growth', '{G}', 1, 'Instant', 'Target creature gets +3/+3 until end of turn.'), forest(), creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4), spell('Shock', '{R}', 1, 'Instant', 'Shock deals 2 damage to any target.'));
    p0.hand.push(ult);
    t.handlers[0] = castOnce('Genesis Ultimatum');
    t.until(() => log(t, /reveals the top 5 cards/).length > 0);
    expect(p0.battlefield.map((q) => q.card.name)).toEqual(expect.arrayContaining(['Grizzly Bears', 'Craw Wurm']));
    expect(p0.hand.map((c) => c.name).sort()).toEqual(['Giant Growth', 'Shock']);
  });
});

describe('lands', () => {
  it('Three Tree City makes one mana for each creature of the chosen type, less the {2}', () => {
    const city = land('Three Tree City', 'As Three Tree City enters, choose a creature type.\n{T}: Add {C}.\n{2}, {T}: Choose a color. Add an amount of mana of that color equal to the number of creatures you control of the chosen type.');
    expect(city.unread).toBeUndefined();
    const t = new Table();
    const p0 = t.game.players[0];
    for (let i = 0; i < 5; i++) t.game.put(0, creature('Llanowar Elves', '{G}', 1, 1, 1, { subTypes: ['Elf', 'Druid'] }));
    t.game.put(0, city);
    const elvesMana = t.game.availableMana(p0);
    // Five Elves: five mana for {2}, three more than the land alone. The Elves are summoning sick here, so only the land counts.
    expect(elvesMana).toBe(3);
  });

  it('Lotus Field makes you sacrifice two lands', () => {
    const lotus = land('Lotus Field', 'Hexproof\nThis land enters tapped.\nWhen this land enters, sacrifice two lands.\n{T}: Add three mana of any one color.');
    expect(lotus.effects).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'landSac', who: 'you', n: 2 })]));
  });

  it('Inkmoth Nexus becomes a 1/1 flier with infect', () => {
    const nexus = land('Inkmoth Nexus', '{T}: Add {C}.\n{1}: This land becomes a 1/1 Phyrexian Blinkmoth artifact creature with flying and infect until end of turn. It\'s still a land. (It deals damage to creatures in the form of -1/-1 counters and to players in the form of poison counters.)');
    expect(nexus.effects).toEqual([expect.objectContaining({ kind: 'becomeCreature', what: 'self', size: { p: 1, t: 1 }, keywords: ['flying', 'infect'] })]);
  });

  it('every land and leftover rule has a reason', () => {
    for (const [name, rule] of Object.entries(CARD_RULES)) expect(rule.why.length, name).toBeGreaterThan(10);
  });
});
