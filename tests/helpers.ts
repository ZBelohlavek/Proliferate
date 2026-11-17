// Builders for small synthetic cards and decks used by the tests.

import { classifyCard, type RawCard } from '../src/engine/classify';
import type { Color, SimCard, SimDeck } from '../src/engine/types';

export function card(partial: Partial<RawCard> & { name: string }): SimCard {
  return classifyCard({
    manaCost: '',
    cmc: 0,
    types: [],
    superTypes: [],
    subTypes: [],
    text: '',
    keywords: [],
    colorIdentity: [],
    ...partial,
  });
}

export const forest = () => card({ name: 'Forest', types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], colorIdentity: ['G'] });

export function creature(name: string, cost: string, cmc: number, power: number, toughness: number, extra: Partial<RawCard> = {}): SimCard {
  return card({ name, manaCost: cost, cmc, types: ['Creature'], power: String(power), toughness: String(toughness), colorIdentity: ['G'], ...extra });
}

/** A simple green stompy deck: 38 Forests, a commander, and 61 creatures. */
export function stompyDeck(id: string, commanderSize = 4): SimDeck {
  const commander = creature(`Commander ${id}`, '{2}{G}{G}', 4, commanderSize, commanderSize, { superTypes: ['Legendary'] });
  const bears = creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
  const giants = creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);
  const elves = card({ name: 'Llanowar Elves', manaCost: '{G}', cmc: 1, types: ['Creature'], power: '1', toughness: '1', text: '{T}: Add {G}.', colorIdentity: ['G'] });
  return {
    id,
    name: `Deck ${id}`,
    source: 'text',
    commanders: [commander],
    cards: [
      { card: forest(), count: 38 },
      { card: bears, count: 30 },
      { card: giants, count: 21 },
      { card: elves, count: 10 },
    ],
    colorIdentity: ['G'] as Color[],
    importedAt: 0,
  };
}

const island = () => card({ name: 'Island', types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], colorIdentity: ['U'] });
const mountain = () => card({ name: 'Mountain', types: ['Land'], superTypes: ['Basic'], subTypes: ['Mountain'], colorIdentity: ['R'] });

/** Shorthand for a nonland card with real oracle text. */
export function spell(name: string, cost: string, cmc: number, type: string, text: string, extra: Partial<RawCard> = {}): SimCard {
  return card({ name, manaCost: cost, cmc, types: type.split(' '), text, colorIdentity: ['G'], ...extra });
}

/**
 * A three-color deck that uses most of what the rules engine models:
 * counterspells, removal of every mode, wipes, tricks, Auras, Equipment,
 * tokens, triggers, activated abilities, tutors, recursion and X spells.
 */
export function toolboxDeck(id: string): SimDeck {
  const commander = creature(`Toolbox ${id}`, '{1}{G}{U}{R}', 4, 4, 4, {
    superTypes: ['Legendary'], keywords: ['Trample'], colorIdentity: ['G', 'U', 'R'],
    text: 'Trample\nWhenever Toolbox deals combat damage to a player, draw a card.',
  });
  const one = (c: SimCard) => ({ card: c, count: 1 });
  const cards = [
    { card: forest(), count: 14 },
    { card: island(), count: 11 },
    { card: mountain(), count: 11 },
    one(card({ name: 'Command Tower', types: ['Land'], text: '{T}: Add one mana of any color in your commander\'s color identity.' })),
    one(card({ name: 'Thornwood Falls', types: ['Land'], text: 'Thornwood Falls enters tapped.\n{T}: Add {G} or {U}.' })),
    one(spell('Sol Ring', '{1}', 1, 'Artifact', '{T}: Add {C}{C}.')),
    one(spell('Arcane Signet', '{2}', 2, 'Artifact', '{T}: Add one mana of any color in your commander\'s color identity.')),
    one(creature('Llanowar Elves', '{G}', 1, 1, 1, { text: '{T}: Add {G}.' })),
    one(spell('Cultivate', '{2}{G}', 3, 'Sorcery', 'Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.')),
    one(spell('Rampant Growth', '{1}{G}', 2, 'Sorcery', 'Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.')),
    one(spell('Counterspell', '{U}{U}', 2, 'Instant', 'Counter target spell.')),
    one(spell('Negate', '{1}{U}', 2, 'Instant', 'Counter target noncreature spell.')),
    one(spell('Essence Scatter', '{1}{U}', 2, 'Instant', 'Counter target creature spell.')),
    one(spell('Beast Within', '{2}{G}', 3, 'Instant', 'Destroy target permanent. Its controller creates a 3/3 green Beast creature token.')),
    one(spell('Lightning Bolt', '{R}', 1, 'Instant', 'Lightning Bolt deals 3 damage to any target.')),
    one(spell('Fireball', '{X}{R}', 1, 'Sorcery', 'Fireball deals X damage to any target.')),
    one(spell('Chaos Warp', '{2}{R}', 3, 'Instant', 'The owner of target permanent shuffles it into their library, then reveals the top card of their library.')),
    one(spell('Unsummon', '{U}', 1, 'Instant', 'Return target creature to its owner\'s hand.')),
    one(spell('Rabid Bite', '{1}{G}', 2, 'Sorcery', 'Target creature you control deals damage equal to its power to target creature you don\'t control.')),
    one(spell('Blasphemous Act', '{8}{R}', 9, 'Sorcery', 'Blasphemous Act deals 13 damage to each creature.')),
    one(spell('Evacuation', '{3}{U}{U}', 5, 'Instant', 'Return all creatures to their owners\' hands.')),
    one(spell('Vandalblast', '{R}', 1, 'Sorcery', 'Destroy target artifact you don\'t control.')),
    one(spell('Giant Growth', '{G}', 1, 'Instant', 'Target creature gets +3/+3 until end of turn.')),
    one(spell('Snakeskin Veil', '{G}', 1, 'Instant', 'Put a +1/+1 counter on target creature you control. It gains hexproof until end of turn.')),
    one(spell('Heroic Intervention', '{1}{G}', 2, 'Instant', 'Permanents you control gain hexproof and indestructible until end of turn.')),
    one(spell('Overrun', '{2}{G}{G}{G}', 5, 'Sorcery', 'Creatures you control get +3/+3 and gain trample until end of turn.')),
    one(spell('Rancor', '{G}', 1, 'Enchantment', 'Enchant creature\nEnchanted creature gets +2/+0 and has trample.', { subTypes: ['Aura'] })),
    one(spell('Loxodon Warhammer', '{3}', 3, 'Artifact', 'Equipped creature gets +3/+0 and has trample and lifelink.\nEquip {3}', { subTypes: ['Equipment'] })),
    one(spell('Swiftfoot Boots', '{2}', 2, 'Artifact', 'Equipped creature has hexproof and haste.\nEquip {1}', { subTypes: ['Equipment'] })),
    one(spell('Glorious Anthem', '{1}{G}{G}', 3, 'Enchantment', 'Creatures you control get +1/+1.')),
    one(spell('Harmonize', '{2}{G}{G}', 4, 'Sorcery', 'Draw three cards.')),
    one(spell('Divination', '{2}{U}', 3, 'Sorcery', 'Draw two cards.')),
    one(spell('Mystical Tutor', '{U}', 1, 'Instant', 'Search your library for an instant or sorcery card, reveal it, then shuffle and put that card on top.')),
    one(spell('Eternal Witness Rite', '{1}{G}', 2, 'Sorcery', 'Return target creature card from your graveyard to your hand.')),
    one(spell('Reanimating Rite', '{3}{G}', 4, 'Sorcery', 'Return target creature card from your graveyard to the battlefield.')),
    one(spell('Dragon Fodder', '{1}{R}', 2, 'Sorcery', 'Create two 1/1 red Goblin creature tokens.')),
    one(spell('Hordeling Outburst', '{1}{R}{R}', 3, 'Sorcery', 'Create three 1/1 red Goblin creature tokens.')),
    one(spell('Strike It Rich', '{R}', 1, 'Sorcery', 'Create a Treasure token.')),
    one(spell('Exsanguinate-ish', '{X}{R}{R}', 2, 'Sorcery', 'Each opponent loses X life. You gain life equal to the life lost this way.')),
    one(spell('Lava Spike', '{R}', 1, 'Sorcery', 'Lava Spike deals 3 damage to target player.')),
    one(spell('Diabolic-ish Edict', '{1}{R}', 2, 'Instant', 'Target player sacrifices a creature.')),
    one(spell('Exploration-ish', '{G}', 1, 'Sorcery', 'Put a land card from your hand onto the battlefield.')),
    one(creature('Reclamation Sage', '{2}{G}', 3, 2, 1, { text: 'When Reclamation Sage enters, you may destroy target artifact or enchantment.' })),
    one(creature('Mulldrifter', '{4}{U}', 5, 2, 2, { keywords: ['Flying'], text: 'Flying\nWhen Mulldrifter enters, draw two cards.' })),
    one(creature('Flametongue Kavu', '{3}{R}', 4, 4, 2, { text: 'When Flametongue Kavu enters, it deals 4 damage to target creature.' })),
    one(creature('Acidic Slime', '{3}{G}{G}', 5, 2, 2, { keywords: ['Deathtouch'], text: 'Deathtouch\nWhen Acidic Slime enters, destroy target artifact, enchantment, or land.' })),
    one(creature('Avenger of Zendikar-ish', '{5}{G}{G}', 7, 5, 5, { text: 'When Avenger enters, create three 0/1 green Plant creature tokens.\nLandfall — Whenever a land you control enters, put a +1/+1 counter on each creature you control.' })),
    one(creature('Serra Angel-ish', '{3}{U}{U}', 5, 4, 4, { keywords: ['Flying', 'Vigilance'], text: 'Flying, vigilance' })),
    one(creature('Giant Spider', '{3}{G}', 4, 2, 4, { keywords: ['Reach'], text: 'Reach' })),
    one(creature('Goblin Heelcutter-ish', '{3}{R}', 4, 3, 2, { keywords: ['Menace', 'Haste'], text: 'Menace, haste' })),
    one(creature('White Knight-ish', '{R}{R}', 2, 2, 2, { keywords: ['First strike'], text: 'First strike' })),
    one(creature('Fencing Ace-ish', '{1}{R}', 2, 1, 1, { keywords: ['Double strike'], text: 'Double strike' })),
    one(creature('Vampire Nighthawk-ish', '{1}{G}{G}', 3, 2, 3, { keywords: ['Flying', 'Deathtouch', 'Lifelink'], text: 'Flying, deathtouch, lifelink' })),
    one(creature('Wall of Omens-ish', '{1}{U}', 2, 0, 4, { keywords: ['Defender'], text: 'Defender\nWhen Wall enters, draw a card.' })),
    one(creature('Troll Ascetic-ish', '{1}{G}{G}', 3, 3, 2, { keywords: ['Hexproof'], text: 'Hexproof' })),
    one(creature('Darksteel Brute', '{4}', 4, 4, 4, { keywords: ['Indestructible'], text: 'Indestructible' })),
    one(creature('Ward Beast', '{2}{G}', 3, 3, 3, { keywords: ['Ward'], text: 'Ward {2}' })),
    one(creature('Hangarback-ish', '{X}{X}', 0, 0, 0, { text: 'Hangarback enters with X +1/+1 counters on it.' })),
    one(creature('Young Pyromancer', '{1}{R}', 2, 2, 1, { text: 'Whenever you cast an instant or sorcery spell, create a 1/1 red Elemental creature token.' })),
    one(creature('Blood Artist-ish', '{1}{R}', 2, 0, 1, { text: 'Whenever a creature you control dies, each opponent loses 1 life and you gain 1 life.' })),
    one(creature('Prodigal Pyromancer', '{2}{R}', 3, 1, 1, { text: '{T}: Prodigal Pyromancer deals 1 damage to any target.' })),
    one(creature('Shivan Dragon-ish', '{4}{R}{R}', 6, 5, 5, { keywords: ['Flying'], text: 'Flying\nWhenever Shivan attacks, create a 1/1 red Goblin creature token.' })),
    one(creature('Solemn Simulacrum', '{4}', 4, 2, 2, { text: 'When Solemn Simulacrum enters, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.\nWhen Solemn Simulacrum dies, you may draw a card.' })),
    one(creature('Elvish Visionary', '{1}{G}', 2, 1, 1, { text: 'When Elvish Visionary enters, draw a card.' })),
    one(creature('Ambush Viper', '{1}{G}', 2, 2, 1, { keywords: ['Flash', 'Deathtouch'], text: 'Flash\nDeathtouch' })),
    one(creature('Captain Legend', '{2}{G}', 3, 3, 3, { superTypes: ['Legendary'] })),
    one(spell('Mystery Box', '{2}', 2, 'Artifact', 'Whenever you roll a die, venture into the dungeon.')),
    { card: creature('Grizzly Bears', '{1}{G}', 2, 2, 2), count: 5 },
    { card: creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4), count: 3 },
  ];
  const size = cards.reduce((n, c) => n + c.count, 0);
  if (size < 99) cards.push({ card: creature('Hill Giant', '{3}{R}', 4, 3, 3), count: 99 - size });
  return { id, name: `Toolbox ${id}`, source: 'text', commanders: [commander], cards, colorIdentity: ['U', 'R', 'G'] as Color[], importedAt: 0 };
}
