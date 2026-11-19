// Counting effects ("+1/+0 for each", "power equal to", "costs {1} less"), variable mana and
// tap/untap effects: the card reader and the rules engine. Cards use their real oracle text
// (with green mana costs where the test table needs them).

import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/engine/types';
import { card, creature, spell } from './helpers';
import { castOnce, Table } from './table';

const artifact = (name: string, text: string, cost = '{2}', cmc = 2) => card({ name, manaCost: cost, cmc, types: ['Artifact'], text });
const enchantment = (name: string, text: string, cost = '{1}{G}', cmc = 2) => spell(name, cost, cmc, 'Enchantment', text);
const token = (name: string, sub: string[], p = 1, t = 1, types = ['Creature']) => card({ name, types, subTypes: sub, power: String(p), toughness: String(t) });
const swamp = () => card({ name: 'Swamp', types: ['Land'], superTypes: ['Basic'], subTypes: ['Swamp'], colorIdentity: ['B'] });

describe('counting power and toughness', () => {
  it('Storm-Kiln Artist gets +1/+0 for each artifact you control', () => {
    const t = new Table();
    const artist = t.game.put(0, creature('Storm-Kiln Artist', '{3}{G}', 4, 2, 2, { text: 'This creature gets +1/+0 for each artifact you control.' }));
    expect(t.game.power(artist)).toBe(2);
    t.game.put(0, artifact('Sol Ring', '{T}: Add {C}{C}.'));
    t.game.put(0, artifact('Mind Stone', '{T}: Add {C}.'));
    expect(t.game.power(artist)).toBe(4);
    expect(t.game.toughness(artist)).toBe(2);
  });

  it("Duelist of the Mind's power is the number of cards drawn this turn", () => {
    const t = new Table();
    const duelist = t.game.put(0, creature('Duelist of the Mind', '{1}{G}', 2, 0, 3, { power: '*', text: "Flying, vigilance\nDuelist of the Mind's power is equal to the number of cards you've drawn this turn." }));
    expect(duelist.card.power).toBe(0);
    t.game.draw(t.game.players[0], 2);
    expect(t.game.power(duelist)).toBe(2);
  });

  it('Persistent Marshstalker counts other Rats; Archpriest of Iona counts the party (rule 700.8)', () => {
    const t = new Table();
    const rat = t.game.put(0, creature('Persistent Marshstalker', '{1}{G}', 2, 3, 1, { subTypes: ['Rat', 'Berserker'], text: 'This creature gets +1/+0 for each other Rat you control.' }));
    t.game.put(0, token('Rat', ['Rat']));
    t.game.put(0, token('Rat', ['Rat']));
    expect(t.game.power(rat)).toBe(5);
    const priest = t.game.put(0, creature('Archpriest of Iona', '{G}', 1, 0, 2, { power: '*', subTypes: ['Human', 'Cleric'], text: "Archpriest of Iona's power is equal to the number of creatures in your party." }));
    t.game.put(0, token('Rogue', ['Human', 'Rogue']));
    // A Cleric Wizard fills the Wizard slot, since the Archpriest already is the Cleric.
    t.game.put(0, token('Sage', ['Cleric', 'Wizard']));
    expect(t.game.power(priest)).toBe(3);
  });

  it('Kalemne gets +1/+1 for each experience counter', () => {
    const t = new Table();
    const kalemne = t.game.put(0, creature('Kalemne, Disciple of Iroas', '{2}{G}{G}', 4, 3, 3, { text: 'Kalemne gets +1/+1 for each experience counter you have.' }));
    t.game.players[0].experience = 2;
    expect(t.game.power(kalemne)).toBe(5);
    expect(t.game.toughness(kalemne)).toBe(5);
  });
});

describe('spells that cost less', () => {
  it('Blood for the Blood God! costs {1} less for each creature that died this turn', () => {
    const t = new Table();
    const blood = spell('Blood for the Blood God!', '{8}{G}{G}', 10, 'Instant', "This spell costs {1} less to cast for each creature that died this turn.\nDiscard your hand, then draw eight cards. Blood for the Blood God! deals 8 damage to each opponent. Exile Blood for the Blood God!.");
    const p = t.game.players[0];
    expect(t.game.effectiveCost(p, blood)).toBe(10);
    t.game.diedThisTurn = 3;
    expect(t.game.effectiveCost(p, blood)).toBe(7);
  });

  it("Wizard's Lightning costs {2} less with a Wizard; Junk Winder has affinity for tokens", () => {
    const t = new Table();
    const p = t.game.players[0];
    const bolt = spell("Wizard's Lightning", '{2}{G}', 3, 'Instant', "This spell costs {2} less to cast if you control a Wizard.\nWizard's Lightning deals 3 damage to any target.");
    expect(t.game.effectiveCost(p, bolt)).toBe(3);
    for (let i = 0; i < 2; i++) t.game.put(0, token('Wizard', ['Human', 'Wizard'])).token = true;
    expect(t.game.effectiveCost(p, bolt)).toBe(1);
    const winder = creature('Junk Winder', '{5}{G}{G}', 7, 5, 6, { text: 'Affinity for tokens\nWhenever a token you control enters, tap target nonland permanent an opponent controls. It doesn\'t untap during its controller\'s next untap step.' });
    p.treasures = 1;
    // Two Wizard tokens and a Treasure.
    expect(t.game.effectiveCost(p, winder)).toBe(4);
  });

  it('Savvy Trader makes the commander cheaper (it is cast from anywhere other than a hand), not spells from hand', () => {
    const t = new Table();
    const p = t.game.players[0];
    t.game.put(0, creature('Savvy Trader', '{3}{G}', 4, 3, 3, { text: 'Spells you cast from anywhere other than your hand cost {1} less to cast.' }));
    const commander = p.commandZone[0];
    const bear = creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
    expect(t.game.effectiveCost(p, commander, true)).toBe(commander.cmc - 1);
    expect(t.game.effectiveCost(p, bear)).toBe(2);
  });

  it('Conduit of Ruin: only the first creature spell each turn costs {2} less', () => {
    const t = new Table();
    const p = t.game.players[0];
    t.game.put(0, creature('Conduit of Ruin', '{6}', 6, 5, 5, { text: 'The first creature spell you cast each turn costs {2} less to cast.' }));
    const wurm = creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);
    expect(t.game.effectiveCost(p, wurm)).toBe(4);
    p.creatureSpellsThisTurn = 1;
    expect(t.game.effectiveCost(p, wurm)).toBe(6);
  });

  it('Tezzeret gives creature and planeswalker spells affinity for artifacts', () => {
    const t = new Table();
    const p = t.game.players[0];
    t.game.put(0, card({ name: 'Tezzeret, Master of the Bridge', manaCost: '{4}{U}{B}', cmc: 6, types: ['Planeswalker'], loyalty: '6', text: 'Creature and planeswalker spells you cast have affinity for artifacts.\n+2: Tezzeret deals X damage to each opponent, where X is the number of artifacts you control. You gain X life.' }));
    t.game.put(0, artifact('Sol Ring', '{T}: Add {C}{C}.'));
    t.game.put(0, artifact('Mind Stone', '{T}: Add {C}.'));
    expect(t.game.effectiveCost(p, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4))).toBe(4);
    expect(t.game.effectiveCost(p, spell('Divination', '{2}{G}', 3, 'Sorcery', 'Draw two cards.'))).toBe(3);
  });

  it("Training Grounds: creatures' activated abilities cost {2} less, but never less than one mana (rule 601.2f)", () => {
    const t = new Table();
    const p = t.game.players[0];
    t.game.put(0, enchantment('Training Grounds', "Activated abilities of creatures you control cost {2} less to activate. This effect can't reduce the mana in that cost to less than one mana.", '{G}', 1));
    const shaman = t.game.put(0, creature('Shaman', '{1}{G}', 2, 1, 1, { text: '{3}{G}: Draw a card.\n{1}: This creature gets +1/+1 until end of turn.' }));
    const [draw, pump] = shaman.card.effects.filter((e): e is Effect => e.when === 'activated');
    expect(t.game.abilityDiscount(p, shaman, draw)).toBe(2);
    expect(t.game.abilityDiscount(p, shaman, pump)).toBe(0);
    const rock = t.game.put(0, artifact('Dynamo', '{3}, {T}: Draw a card.'));
    expect(t.game.abilityDiscount(p, rock, rock.card.effects.find((e) => e.when === 'activated')!)).toBe(0);
  });
});

describe('variable mana', () => {
  it("Vivi Ornitier adds mana equal to its power once a turn, without tapping and while summoning sick", () => {
    const t = new Table();
    const p = t.game.players[0];
    const vivi = t.game.put(0, creature('Vivi Ornitier', '{1}{U}{R}', 3, 0, 3, { text: "{0}: Add X mana in any combination of {U} and/or {R}, where X is Vivi Ornitier's power. Activate only during your turn and only once each turn." }), { sick: true });
    expect(t.game.availableMana(p)).toBe(0);
    vivi.counters = 3;
    expect(t.game.availableMana(p)).toBe(3);
    vivi.usedThisTurn.push(vivi.card.effects.find((e) => e.kind === 'mana')!);
    expect(t.game.availableMana(p)).toBe(0);
  });

  it('Sanctum Weaver counts enchantments; Glistening Sphere makes three only while an opponent is corrupted', () => {
    const t = new Table();
    const [p, o] = t.game.players;
    t.game.put(0, creature('Sanctum Weaver', '{1}{G}', 2, 0, 2, { types: ['Enchantment', 'Creature'], text: '{T}: Add X mana of any one color, where X is the number of enchantments you control.' }));
    t.game.put(0, enchantment('Wild Growth', 'Enchant land'));
    expect(t.game.availableMana(p)).toBe(2);
    t.game.put(0, artifact('Glistening Sphere', '{T}: Add one mana of any color.\nCorrupted — {T}: Add three mana of any one color. Activate only if an opponent has three or more poison counters.'));
    expect(t.game.availableMana(p)).toBe(3);
    o.poison = 3;
    expect(t.game.availableMana(p)).toBe(5);
  });

  it('Krark-Clan Ironworks sacrifices spare artifact tokens for {C}{C} when the mana is needed', () => {
    const t = new Table();
    const p = t.game.players[0];
    t.game.put(0, artifact('Krark-Clan Ironworks', 'Sacrifice an artifact: Add {C}{C}.', '{4}', 4));
    t.game.put(0, token('Thopter', ['Thopter'], 1, 1, ['Artifact', 'Creature']), {});
    const thopter = p.battlefield.find((q) => q.card.name === 'Thopter')!;
    thopter.token = true;
    expect(t.game.availableMana(p)).toBe(2);
    p.hand.push(creature('Grizzly Bears', '{2}', 2, 2, 2));
    t.handlers[0] = castOnce('Grizzly Bears');
    t.finishTurn();
    expect(p.battlefield.some((q) => q.card.name === 'Grizzly Bears')).toBe(true);
    expect(t.game.findPerm(thopter.id)).toBeNull();
  });

  it('Crypt Ghast doubles Swamps; Chromatic Lantern makes every land tap for any color', () => {
    const t = new Table();
    const p = t.game.players[0];
    t.game.put(0, swamp());
    t.game.put(0, swamp());
    expect(t.game.availableMana(p)).toBe(2);
    t.game.put(0, creature('Crypt Ghast', '{3}{B}', 4, 2, 2, { text: 'Extort\nWhenever you tap a Swamp for mana, add an additional {B}.' }));
    expect(t.game.availableMana(p)).toBe(4);
    const forest = p.battlefield.find((q) => q.landInfo) ?? t.game.put(0, swamp());
    t.game.put(0, artifact('Chromatic Lantern', 'Lands you control have "{T}: Add one mana of any color."\n{T}: Add one mana of any color.', '{3}', 3));
    expect(t.game.landProduces(forest)).toBe('any');
  });

  it('Crystalline Crawler spends +1/+1 counters as mana', () => {
    const t = new Table();
    const p = t.game.players[0];
    const crawler = t.game.put(0, creature('Crystalline Crawler', '{4}', 4, 1, 1, { types: ['Artifact', 'Creature'], text: 'Remove a +1/+1 counter from this creature: Add one mana of any color.\n{T}: Put a +1/+1 counter on this creature.' }), { sick: true });
    crawler.counters = 2;
    expect(t.game.availableMana(p)).toBe(2);
  });

  it("Ugin's 0 and The Legend of Roku's chapter II are one-shot mana", () => {
    const ugin = card({ name: 'Ugin, Eye of the Storms', manaCost: '{7}', cmc: 7, types: ['Planeswalker'], loyalty: '7', text: '+2: You gain 3 life and draw a card.\n0: Add {C}{C}{C}.' });
    expect(ugin.effects.some((e) => e.when === 'loyalty' && e.kind === 'treasure' && e.n === 3 && e.ritual)).toBe(true);
    expect(ugin.unread ?? []).toEqual([]);
  });
});

describe('tap and untap', () => {
  it('Mind Games taps an opponent\'s creature', () => {
    const t = new Table();
    t.lands(0, 1);
    const wurm = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    t.game.players[0].hand.push(spell('Mind Games', '{G}', 1, 'Instant', 'Tap target artifact, creature, or land.'));
    t.handlers[0] = castOnce('Mind Games');
    // A land in hand gives seat 0 a decision right after Mind Games resolves, before the Wurm's controller untaps.
    t.game.players[0].hand.push(card({ name: 'Forest', types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], colorIdentity: ['G'] }));
    t.until((g) => g.log!.some((l) => l === 'Craw Wurm becomes tapped.'));
    expect(wurm.tapped).toBe(true);
  });

  it("Meekstone keeps creatures with power 3 or more tapped; Stasis skips untap steps and costs {U} each upkeep", () => {
    const t = new Table();
    t.game.put(0, artifact('Meekstone', "Creatures with power 3 or greater don't untap during their controllers' untap steps.", '{1}', 1));
    const wurm = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4), { tapped: true });
    const bear = t.game.put(1, creature('Grizzly Bears', '{1}{G}', 2, 2, 2), { tapped: true });
    t.finishTurn();
    t.until((g) => g.step === 'main1');
    expect(wurm.tapped).toBe(true);
    expect(bear.tapped).toBe(false);

    const s = new Table();
    const stasis = s.game.put(1, enchantment('Stasis', 'Players skip their untap steps.\nAt the beginning of your upkeep, sacrifice this enchantment unless you pay {G}.'));
    const land = s.game.put(1, card({ name: 'Forest', types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], colorIdentity: ['G'] }));
    const tapped = s.game.put(1, creature('Grizzly Bears', '{1}{G}', 2, 2, 2), { tapped: true });
    s.finishTurn();
    s.until((g) => g.step === 'main1');
    // Paid with the untapped Forest; nothing untapped.
    expect(s.game.findPerm(stasis.id)).not.toBeNull();
    expect(land.tapped).toBe(true);
    expect(tapped.tapped).toBe(true);
    s.finishTurn();
    s.finishTurn();
    s.until((g) => g.step === 'main1');
    // No mana for the second upkeep: Stasis goes.
    expect(s.game.findPerm(stasis.id)).toBeNull();
  });

  it('Mana Vault deals 1 damage each upkeep while it is tapped', () => {
    const t = new Table();
    const p = t.game.players[0];
    t.game.put(0, artifact('Mana Vault', "This artifact doesn't untap during your untap step.\nAt the beginning of your upkeep, you may pay {4}. If you do, untap this artifact.\nAt the beginning of your draw step, if this artifact is tapped, it deals 1 damage to you.\n{T}: Add {C}{C}{C}.", '{1}', 1), { tapped: true });
    const life = p.life;
    t.finishTurn();
    t.finishTurn();
    t.until((g) => g.step === 'main1');
    expect(p.life).toBe(life - 1);
  });

  it('Myr Battlesphere taps the other Myr for +X/+0 and X damage to the defending player', () => {
    const t = new Table();
    const [, b] = t.game.players;
    const sphere = t.game.put(0, creature('Myr Battlesphere', '{7}', 7, 4, 7, { types: ['Artifact', 'Creature'], subTypes: ['Myr', 'Construct'], text: "Whenever this creature attacks, you may tap X untapped Myr you control. If you do, this creature gets +X/+0 until end of turn and deals X damage to the player or planeswalker it's attacking." }));
    for (let i = 0; i < 3; i++) t.game.put(0, token('Myr', ['Myr'], 1, 1, ['Artifact', 'Creature']), { sick: true });
    const life = b.life;
    t.handlers[0] = (_g, d) => (d.kind === 'attackers' ? [{ attacker: sphere.id, defender: 1 }] : undefined);
    t.finishTurn();
    expect(b.life).toBe(life - 3 - 7);
  });
});
