// Spacecraft and Planets (station), named counters, bounty and poison counters,
// extra combat phases and the energy spells: the card reader and the rules engine.
// Cards use their real oracle text, with green mana costs where the test table needs them.

import { describe, expect, it } from 'vitest';
import type { Decision } from '../src/rules/types';
import { card, creature, spell } from './helpers';
import { attackAll, castOnce, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const kinds = (c: { effects: { kind: string }[] }) => c.effects.map((e) => e.kind);

const battlecruiser = () => card({
  name: 'Entropic Battlecruiser', manaCost: '{3}{B}', cmc: 4, types: ['Artifact'], subTypes: ['Spacecraft'], power: '3', toughness: '10',
  text: "Station (Tap another creature you control: Put charge counters equal to its power on this Spacecraft. Station only as a sorcery. It's an artifact creature at 8+.)\n1+ | Whenever an opponent discards a card, they lose 3 life.\n8+ | Flying, deathtouch\nWhenever this Spacecraft attacks, each opponent discards a card. Each opponent who can't loses 3 life.",
});
const beastmaster = () => spell('Beastmaster Ascension', '{2}{G}', 3, 'Enchantment', 'Whenever a creature you control attacks, you may put a quest counter on this enchantment.\nAs long as this enchantment has seven or more quest counters on it, creatures you control get +5/+5.');
const shay = () => creature('Shay Cormac', '{G}{G}', 2, 1, 1, { text: '{1}: Permanents your opponents control lose hexproof, indestructible, protection, shroud, and ward until end of turn.\nWhenever a creature an opponent controls becomes the target of a spell or ability you control, put a bounty counter on that creature.\nWhenever a creature with a bounty counter on it dies, put two +1/+1 counters on Shay Cormac.' });

describe('station (rule 702.184)', () => {
  it('reads the station thresholds and the creature threshold', () => {
    const c = battlecruiser();
    expect(c.station?.creatureAt).toBe(8);
    expect(c.station?.tiers.map((t) => t.n)).toEqual([1, 8]);
    expect(c.station?.tiers[1].keywords).toEqual(expect.arrayContaining(['flying', 'deathtouch']));
    expect(c.isCreature).toBe(false);
  });

  it('tapping a creature puts charge counters equal to its power; at 8+ the Spacecraft is a creature with its keywords', () => {
    const t = new Table();
    const ship = t.game.put(0, battlecruiser());
    const wurm = t.game.put(0, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.step !== 'main1') return undefined;
      const i = d.actions.findIndex((a) => a.type === 'station');
      return i === -1 ? undefined : { action: i };
    };
    t.until((g) => g.step !== 'main1');
    expect(wurm.tapped).toBe(true);
    expect(ship.charge).toBe(8);
    expect(ship.card.isCreature).toBe(true);
    expect(t.game.hasKw(ship, 'flying')).toBe(true);
    expect(log(t, /Entropic Battlecruiser is now a 3\/10 artifact creature/)).toHaveLength(1);
  });

  it('the bot stations a Spacecraft with creatures that would not attack anyway', () => {
    const t = new Table();
    const ship = t.game.put(0, battlecruiser());
    t.game.put(0, creature('Wall of Wood', '{G}', 1, 0, 3));
    t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    expect(t.game.legalActions(t.game.players[0]).some((a) => a.type === 'station')).toBe(true);
    expect(t.game.stationRoom(ship)).toBe(true);
  });
});

describe('named counters', () => {
  it('reads quest counters as charge counters with a threshold, and keeps the name', () => {
    const c = beastmaster();
    expect(c.counterName).toBe('quest');
    const anthem = c.effects.find((e) => e.kind === 'anthem');
    expect(anthem?.minCharge).toBe(7);
  });

  it('Beastmaster Ascension pumps the team only at seven or more quest counters', () => {
    const t = new Table();
    const asc = t.game.put(0, beastmaster());
    const bears = t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    asc.charge = 6;
    expect(t.game.power(bears)).toBe(2);
    asc.charge = 7;
    expect(t.game.power(bears)).toBe(7);
  });

  it('Simic Ascendancy reads its growth counters and its win at twenty', () => {
    const c = spell('Simic Ascendancy', '{G}{U}', 2, 'Enchantment', '{1}{G}{U}: Put a +1/+1 counter on target creature you control.\nWhenever one or more +1/+1 counters are put on a creature you control, put that many growth counters on this enchantment.\nAt the beginning of your upkeep, if this enchantment has twenty or more growth counters on it, you win the game.');
    expect(c.counterName).toBe('growth');
    expect(c.effects.some((e) => e.when === 'countersPut' && e.kind === 'charge')).toBe(true);
    expect(c.effects.some((e) => e.kind === 'winGame' && e.minCharge === 20)).toBe(true);
  });

  it('"you win the game" without a counter condition is not read as a win', () => {
    const c = spell('Revel in Riches', '{4}{B}', 5, 'Enchantment', 'Whenever a creature an opponent controls dies, create a Treasure token.\nAt the beginning of your upkeep, if you control ten or more Treasures, you win the game.');
    expect(kinds(c)).not.toContain('winGame');
  });
});

describe('bounty and poison counters', () => {
  it('Shay Cormac puts a bounty counter on a creature it targets and grows when it dies', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    const s = t.game.put(0, shay());
    const victim = t.game.put(1, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    a.hand.push(spell('Murder', '{G}', 1, 'Instant', 'Destroy target creature.'));
    const cast = castOnce('Murder');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: victim.id } : cast(g, d));
    t.finishTurn();
    expect(t.game.findPerm(victim.id)).toBeNull();
    expect(s.counters).toBe(2);
  });

  it('reads "that player gets a poison counter" style effects', () => {
    const c = spell('Infectious Inquiry', '{2}{B}', 3, 'Sorcery', 'You draw a card and you lose 1 life. Each opponent gets a poison counter.');
    expect(kinds(c)).toContain('poison');
  });
});

describe('extra combat phases', () => {
  it('reads Relentless Assault and Lightning Runner', () => {
    const ra = spell('Relentless Assault', '{2}{G}{G}', 4, 'Sorcery', 'Untap all creatures that attacked this turn. After this main phase, there is an additional combat phase followed by an additional main phase.');
    const e = ra.effects.find((x) => x.kind === 'extraCombat');
    expect(e).toBeDefined();
    const runner = creature('Lightning Runner', '{3}{G}{G}', 5, 2, 2, { text: 'Double strike, haste\nWhenever this creature attacks, you get {E}{E} (two energy counters), then you may pay eight {E}. If you pay, untap all creatures you control, and after this phase, there is an additional combat phase.' });
    expect(kinds(runner)).toContain('extraCombat');
  });

  it('Relentless Assault cast after combat gives a second combat where the creatures attack again', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    a.hand.push(spell('Relentless Assault', '{2}{G}{G}', 4, 'Sorcery', 'Untap all creatures that attacked this turn. After this main phase, there is an additional combat phase followed by an additional main phase.'));
    const life = b.life;
    const cast = castOnce('Relentless Assault', (g) => g.step === 'main2');
    const attack = attackAll(1);
    t.handlers[0] = (g, d: Decision) => cast(g, d) ?? attack(g, d);
    t.finishTurn();
    expect(b.life).toBe(life - 4);
  });
});

describe('energy spells and treasures', () => {
  it('Wrath of the Skies destroys only what the energy paid reaches', () => {
    const c = spell('Wrath of the Skies', '{X}{W}{W}', 2, 'Sorcery', 'You get X {E} (energy counters), then you may pay any amount of {E}. Destroy each artifact, creature, and enchantment with mana value less than or equal to the amount of {E} paid this way.');
    const w = c.effects.find((e) => e.kind === 'wipe');
    expect(w && 'byEnergy' in w && w.byEnergy).toBe(true);
  });

  it('Aether Spike reads as a counterspell', () => {
    const c = spell('Aether Spike', '{1}{U}', 2, 'Instant', 'Choose target spell. You get {E}{E} (two energy counters), then you may pay any amount of {E}. Counter that spell unless its controller pays {1} for each {E} paid this way.');
    expect(kinds(c)).toContain('counter');
  });

  it("Goldspan Dragon's Treasures tap for two mana", () => {
    const t = new Table();
    const [a] = t.game.players;
    a.treasures = 2;
    const before = t.game.availableMana(a);
    t.game.put(0, creature('Goldspan Dragon', '{3}{G}{G}', 5, 4, 4, { text: 'Flying, haste\nWhenever this creature attacks or becomes the target of a spell, create a Treasure token.\nTreasures you control have "{T}, Sacrifice this artifact: Add two mana of any one color."' }));
    expect(t.game.availableMana(a)).toBe(before + 2);
  });
});

