import { describe, expect, it } from 'vitest';
import { parseManaCost } from '../src/engine/classify';
import type { EffectKind, SimCard } from '../src/engine/types';
import { card } from './helpers';
import { staples } from './staples';

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
    const orb = card({ name: 'Winter Orb', manaCost: '{2}', cmc: 2, types: ['Artifact'], text: "As long as this artifact is untapped, players can't untap more than one land during their untap steps." });
    expect(orb.modeled).toBe(false);
  });
});

describe('coverage of widely played Commander cards', () => {
  const cards = staples();
  const byName = (name: string) => cards.find((c) => c.name === name)!;
  const kinds = (name: string) => byName(name).effects.map((e) => e.kind);

  it('understands nearly all of the sample', () => {
    const blank = cards.filter((c) => !c.modeled).map((c) => c.name);
    expect(cards.length).toBeGreaterThan(160);
    expect(blank.sort()).toEqual(['Deflecting Swat', "Grafdigger's Cage", 'Isochron Scepter', 'Winter Orb']);
  });

  it('reads cards that used to slip past on wording', () => {
    expect(byName('Craterhoof Behemoth').effects).toContainEqual(expect.objectContaining({ kind: 'overrun', scale: 'creatures', trample: true, when: 'resolve' }));
    expect(byName('Blood Artist').effects).toContainEqual(expect.objectContaining({ kind: 'damagePlayer', when: 'creatureDies', scope: 'all' }));
    expect(byName('Zulaport Cutthroat').effects).toContainEqual(expect.objectContaining({ kind: 'drain', when: 'creatureDies', scope: 'any' }));
    expect(byName('Skullclamp').effects).toContainEqual(expect.objectContaining({ kind: 'draw', n: 2, when: 'creatureDies', scope: 'attached' }));
    expect(byName('Skullclamp').effects).toContainEqual(expect.objectContaining({ kind: 'equip', p: 1, t: -1 }));
    expect(kinds('Reanimate')).toEqual(['recursion']);
    expect(kinds('Animate Dead')).toEqual(['recursion']);
    expect(byName('Sun Titan').effects.filter((e) => e.kind === 'recursion').map((e) => e.when).sort()).toEqual(['attack', 'resolve']);
    expect(byName('Swan Song').effects).toContainEqual(expect.objectContaining({ kind: 'counter', target: 'noncreature' }));
    expect(byName('Dark Ritual').effects).toContainEqual(expect.objectContaining({ kind: 'treasure', n: 3 }));
    expect(byName('Exploration').effects).toContainEqual(expect.objectContaining({ kind: 'extraLand', when: 'static' }));
    expect(kinds('Dockside Extortionist')).toEqual(['treasure']);
    expect(byName('Overwhelming Stampede').effects).toContainEqual(expect.objectContaining({ kind: 'overrun', scale: 'power' }));
  });

  it('no longer misreads Finale of Devastation or Approach of the Second Sun', () => {
    expect(byName('Finale of Devastation').effects).toEqual([expect.objectContaining({ kind: 'tutor', creatureToBattlefield: true, xLimit: true })]);
    expect(kinds('Approach of the Second Sun')).toEqual(['approach']);
  });

  it('reads commander abilities', () => {
    expect(byName('Korvold, Fae-Cursed King').effects.filter((e) => e.when === 'sacrifice').map((e) => e.kind).sort()).toEqual(['counters', 'draw']);
    expect(byName('Kaalia of the Vast').effects).toContainEqual(expect.objectContaining({ kind: 'cheat', when: 'attack' }));
    expect(byName("Yuriko, the Tiger's Shadow").effects.filter((e) => e.when === 'combatDamage').map((e) => e.kind).sort()).toEqual(['drain', 'draw']);
    expect(byName('Meren of Clan Nel Toth').effects).toContainEqual(expect.objectContaining({ kind: 'recursion', when: 'upkeep' }));
    expect(byName('Miirym, Sentinel Wyrm').effects).toContainEqual(expect.objectContaining({ kind: 'tokens', when: 'creatureEnters', nontoken: true }));
    expect(byName("Atraxa, Praetors' Voice").effects).toContainEqual(expect.objectContaining({ kind: 'counters', proliferate: true }));
  });

  it('reads rule-changing permanents and opponent triggers', () => {
    expect(kinds('Doubling Season')).toEqual(['doubler', 'doubler']);
    expect(byName('Propaganda').effects).toContainEqual(expect.objectContaining({ kind: 'attackTax', amount: 2 }));
    expect(kinds('Rule of Law')).toEqual(['spellLimit']);
    expect(kinds('Panharmonicon')).toEqual(['etbDoubler']);
    expect(kinds('Rest in Peace').sort()).toEqual(['exileGraveyards', 'graveyardHate']);
    expect(byName('Rhystic Study').effects).toContainEqual(expect.objectContaining({ kind: 'draw', when: 'opponentCast', chance: 0.6 }));
    expect(byName('Smothering Tithe').effects).toContainEqual(expect.objectContaining({ kind: 'treasure', when: 'opponentDraw' }));
    expect(byName('Consecrated Sphinx').effects).toContainEqual(expect.objectContaining({ kind: 'draw', n: 2, when: 'opponentDraw' }));
    expect(kinds('Clone')).toEqual(['clone']);
    expect(byName('Control Magic').effects).toContainEqual(expect.objectContaining({ kind: 'equip', aura: true, steal: true }));
    expect(kinds('Bribery')).toEqual(['steal']);
    expect(kinds('Time Warp')).toEqual(['extraTurn']);
  });
});

describe('commander abilities from real decks', () => {
  const legend = (name: string, text: string, types = ['Creature']) => card({ name, types, superTypes: ['Legendary'], text, power: '3', toughness: '3' });

  it('reads them without leftover lines', () => {
    const cards = [
      legend('Kenrith, the Returned King', '{R}: All creatures gain trample and haste until end of turn.\n{1}{G}: Put a +1/+1 counter on target creature.\n{2}{W}: Target player gains 5 life.\n{3}{U}: Target player draws a card.\n{4}{B}: Put target creature card from a graveyard onto the battlefield under its owner\'s control.'),
      legend('Skithiryx, the Blight Dragon', 'Flying\nInfect\n{B}: Skithiryx gains haste until end of turn.\n{B}{B}: Regenerate Skithiryx.'),
      legend('Mr. House, President and CEO', 'Whenever you roll a 4 or higher, create a 3/3 colorless Robot artifact creature token. If you rolled 6 or higher, instead create that token and a Treasure token.\n{4}, {T}: Roll a six-sided die plus an additional six-sided die for each mana from Treasures spent to activate this ability.'),
      legend('Arcades, the Strategist', 'Flying, vigilance\nWhenever a creature you control with defender enters, draw a card.\nEach creature you control with defender assigns combat damage equal to its toughness rather than its power and can attack as though it didn\'t have defender.'),
      legend('Wick, the Whorled Mind', 'Whenever Wick or another Rat you control enters, create a 1/1 black Snail creature token if you don\'t control a Snail. Otherwise, put a +1/+1 counter on a Snail you control.\n{U}{B}{R}, Sacrifice a Snail: Wick deals damage equal to the sacrificed creature\'s power to each opponent. Then draw cards equal to the sacrificed creature\'s power.'),
      legend('Kilo, Apogee Mind', 'Haste\nWhenever Kilo becomes tapped, proliferate.'),
      legend('Baral, Chief of Compliance', 'Instant and sorcery spells you cast cost {1} less to cast.\nWhenever a spell or ability you control counters a spell, you may draw a card. If you do, discard a card.'),
      legend('Silvar, Devourer of the Free', 'Menace\nSacrifice a Human: Put a +1/+1 counter on Silvar. It gains indestructible until end of turn.'),
      legend('Myrkul, Lord of Bones', 'As long as your life total is less than or equal to half your starting life total, Myrkul has indestructible.\nWhenever another nontoken creature you control dies, you may exile it. If you do, create a token that\'s a copy of that card, except it\'s an enchantment and loses all other card types.'),
      legend('Gev, Scaled Scorch', 'Ward—Pay 2 life.\nOther creatures you control enter with an additional +1/+1 counter on them for each opponent who lost life this turn.\nWhenever you cast a Lizard spell, Gev deals 1 damage to target opponent.'),
      card({ name: 'Folk Hero', types: ['Enchantment'], subTypes: ['Background'], text: 'Commander creatures you own have "Whenever you cast a spell that shares a creature type with this creature, draw a card. This ability triggers only once each turn."' }),
      legend('Jin Sakai, Ghost of Tsushima', 'Whenever Jin Sakai deals combat damage to a player, draw a card.\nWhenever a creature you control attacks a player, if no other creatures are attacking that player, choose one —\n• Standoff — It gains double strike until end of turn.\n• Ghost — It can\'t be blocked this turn.'),
    ];
    for (const c of cards) expect(c.unread, c.name).toBeUndefined();
    expect(kinds(cards[2])).toEqual(['tokens', 'treasure', 'rollDice']);
    expect(cards[2].effects[1].minRoll).toBe(6);
    expect(cards[7].effects.find((e) => e.kind === 'counters')?.activation?.sacCreature).toBe(true);
  });

  it('keeps "it" pumps off other creatures and energy off cards that spend it', () => {
    const treason = card({ name: 'Act of Treason', types: ['Sorcery'], text: 'Gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn.' });
    expect(treason.effects).toEqual([]);
    const courage = card({ name: 'Brave Herald', types: ['Enchantment'], text: 'Whenever another creature you control enters, it gains haste until end of turn.' });
    expect(courage.unread).toHaveLength(1);
    const coup = card({ name: 'Confiscation Coup', types: ['Sorcery'], text: 'Choose target artifact or creature. You get {E}{E}{E}{E}, then you may pay an amount of {E} equal to that permanent\'s mana value. If you do, gain control of it.' });
    expect(kinds(coup)).not.toContain('energy');
  });
});
