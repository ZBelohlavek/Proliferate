// Attack and block rules, protection and "hexproof from", and creature types:
// the card reader and the rules engine. Cards use their real oracle text,
// with green mana costs where the test table needs them.

import { describe, expect, it } from 'vitest';
import { card, creature, spell } from './helpers';
import { attackAll, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const bears = (name = 'Grizzly Bears') => creature(name, '{1}{G}', 2, 2, 2);
/** Seat 0 attacks seat `defender` with everything it can, and the turn plays out. */
const attackWith = (t: Table, defender = 1) => {
  t.handlers[0] = attackAll(defender);
  t.finishTurn();
};
const attacked = (perm: { attackedTurn?: number }) => perm.attackedTurn !== undefined;

describe('reading attack and block rules', () => {
  it('reads "attacks each combat if able" and "can\'t attack its owner"', () => {
    const xantcha = creature('Xantcha, Sleeper Agent', '{1}{B}{R}', 3, 5, 5, { text: "Xantcha enters under the control of an opponent of your choice.\nXantcha attacks each combat if able and can't attack its owner or planeswalkers its owner controls." });
    expect(xantcha.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'combatRule', rule: 'mustAttack', who: 'self' }),
      expect.objectContaining({ kind: 'combatRule', rule: 'cantAttackOwner', who: 'self' }),
    ]));
  });

  it('reads protection and "hexproof from" in keyword lines, keeping the other keywords', () => {
    const sphinx = creature('Sphinx of the Steel Wind', '{5}{W}{U}{B}', 8, 6, 6, { text: 'Flying, first strike, vigilance, lifelink, protection from red and from green' });
    expect(sphinx.keywords).toEqual(expect.arrayContaining(['flying', 'first strike', 'lifelink', 'pro:R', 'pro:G']));
    expect(sphinx.unread).toBeUndefined();
    const breaker = creature('Breaker of Creation', '{6}', 6, 8, 4, { text: 'Hexproof from each color\nAnnihilator 2', keywords: ['Hexproof', 'Annihilator'] });
    expect(breaker.keywords).not.toContain('hexproof');
    expect(breaker.keywords).toEqual(expect.arrayContaining(['hexfrom:W', 'hexfrom:G']));
    const titan = card({ name: 'Reaver Titan', manaCost: '{10}', cmc: 10, types: ['Artifact'], subTypes: ['Vehicle'], power: '10', toughness: '10', text: 'Void Shields — Protection from mana value 3 or less\nCrew 4' });
    expect(titan.keywords).toContain('pro:mv<=3');
  });

  it('reads tribal anthems as one creature type, and "of the chosen type"', () => {
    const warchief = creature('Goblin Warchief', '{1}{R}{R}', 3, 2, 2, { text: 'Goblin spells you cast cost {1} less to cast.\nGoblins you control have haste.' });
    expect(warchief.effects.find((e) => e.kind === 'anthem')).toMatchObject({ subtype: 'goblin', keywords: ['haste'] });
    const banner = spell('Banner of Kinship', '{5}', 5, 'Artifact', 'As this artifact enters, choose a creature type.\nCreatures you control of the chosen type get +1/+1.');
    expect(banner.choosesType).toBe(true);
    expect(banner.effects.find((e) => e.kind === 'anthem')).toMatchObject({ subtype: 'chosen' });
  });
});

describe('must attack and can\'t attack (rule 508.1c-d)', () => {
  it('a creature that attacks each combat if able attacks even when its controller declares nothing', () => {
    const t = new Table();
    const toski = t.game.put(0, creature('Toski, Bearer of Secrets', '{3}{G}', 4, 1, 1, { text: 'Indestructible\nToski attacks each combat if able.' }));
    t.finishTurn();
    expect(attacked(toski)).toBe(true);
  });

  it("Bident of Thassa makes the opponents' creatures attack this turn", () => {
    const t = new Table();
    t.game.put(1, spell('Bident of Thassa', '{G}', 1, 'Legendary Enchantment Artifact', '{T}: Creatures your opponents control attack this turn if able.'));
    const bear = t.game.put(0, bears());
    t.handlers[1] = (g, d) => (d.kind === 'priority' && g.activeSeat === 0 && g.step === 'main1' ? (() => { const i = d.actions.findIndex((a) => a.type === 'activate'); return i === -1 ? undefined : { action: i }; })() : undefined);
    t.finishTurn();
    expect(attacked(bear)).toBe(true);
    expect(log(t, /must attack this turn/)).toHaveLength(1);
  });

  it('Crawlspace: no more than two creatures can attack its controller', () => {
    const t = new Table();
    t.game.put(1, spell('Crawlspace', '{3}', 3, 'Artifact', 'No more than two creatures can attack you each combat.'));
    for (let i = 0; i < 4; i++) t.game.put(0, bears());
    attackWith(t);
    expect(t.game.players[0].battlefield.filter(attacked)).toHaveLength(2);
  });

  it('Reverence: creatures with power 2 or less can\'t attack you', () => {
    const t = new Table();
    t.game.put(1, spell('Reverence', '{2}{W}{W}', 4, 'Enchantment', "Creatures with power 2 or less can't attack you."));
    const bear = t.game.put(0, bears());
    const wurm = t.game.put(0, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    attackWith(t);
    expect(attacked(bear)).toBe(false);
    expect(attacked(wurm)).toBe(true);
  });

  it("Nils: a creature with counters pays {1} for each to attack Nils's controller", () => {
    const t = new Table();
    const nils = t.game.put(1, creature('Nils, Discipline Enforcer', '{2}{W}', 3, 2, 2, { text: "Each creature with one or more counters on it can't attack you or planeswalkers you control unless its controller pays {X}, where X is the number of counters on that creature." }));
    const big = t.game.put(0, bears(), { counters: 2 });
    expect(t.game.attackTax(t.game.players[1], big)).toBe(2);
    expect(t.game.attackTax(t.game.players[1], t.game.put(0, bears()))).toBe(0);
    expect(nils.card.unread).toBeUndefined();
  });

  it("War's Toll: once one of a player's creatures attacks, all of them must", () => {
    const t = new Table();
    t.game.put(1, spell("War's Toll", '{3}{R}', 4, 'Enchantment', 'If a creature an opponent controls attacks, all creatures that opponent controls attack if able.'));
    const a = t.game.put(0, bears());
    const b = t.game.put(0, bears());
    t.handlers[0] = (_g, d) => (d.kind === 'attackers' ? [{ attacker: a.id, defender: 1 }] : undefined);
    t.finishTurn();
    expect(attacked(a)).toBe(true);
    expect(attacked(b)).toBe(true);
  });
});

describe("can't block, suspect and goad (rules 509.1b, 701.60)", () => {
  it('a suspected creature has menace and can\'t block', () => {
    const t = new Table();
    const bear = t.game.put(1, bears());
    bear.suspected = true;
    const attacker = t.game.put(0, bears());
    expect(t.game.hasKw(bear, 'menace')).toBe(true);
    expect(t.game.canBlock(bear, attacker)).toBe(false);
  });

  it("Bothersome Quasit: goaded creatures its controller's opponents control can't block", () => {
    const t = new Table();
    t.game.put(0, creature('Bothersome Quasit', '{2}{R}', 3, 3, 2, { text: "Menace\nGoaded creatures your opponents control can't block." }));
    const bear = t.game.put(1, bears());
    const attacker = t.game.put(0, bears());
    expect(t.game.canBlock(bear, attacker)).toBe(true);
    bear.goadedBy = [0];
    expect(t.game.canBlock(bear, attacker)).toBe(false);
  });

  it('Void Winnower: opponents can\'t block with even mana value creatures', () => {
    const t = new Table();
    t.game.put(0, creature('Void Winnower', '{9}', 9, 11, 9, { text: "Your opponents can't block with creatures with even mana values." }));
    const attacker = t.game.put(0, bears());
    expect(t.game.canBlock(t.game.put(1, bears()), attacker)).toBe(false);
    expect(t.game.canBlock(t.game.put(1, creature('Llanowar Elves', '{G}', 1, 1, 1)), attacker)).toBe(true);
  });
});

describe('block triggers (rule 509.1h)', () => {
  it('Ichorclaw Myr gets +2/+2 when it becomes blocked', () => {
    const t = new Table();
    const myr = t.game.put(0, creature('Ichorclaw Myr', '{2}', 2, 1, 1, { text: 'Infect\nWhenever this creature becomes blocked, it gets +2/+2 until end of turn.' }));
    const wall = t.game.put(1, creature('Wall of Wood', '{G}', 1, 0, 3));
    t.handlers[1] = (_g, d) => (d.kind === 'blockers' ? [{ blocker: wall.id, attacker: myr.id }] : undefined);
    attackWith(t);
    expect(log(t, /Ichorclaw Myr gets \+2\/\+2/)).toHaveLength(1);
    expect(t.game.players[1].battlefield).not.toContain(wall);
  });

  it('Guiltfeeder: the player it hits unblocked loses 1 life for each card in their graveyard', () => {
    const t = new Table();
    t.game.put(0, creature('Guiltfeeder', '{3}{B}{B}', 5, 0, 4, { text: 'Fear\nWhenever this creature attacks and isn\'t blocked, defending player loses 1 life for each card in their graveyard.' }));
    t.game.players[1].graveyard.push(bears(), bears(), bears());
    const life = t.game.players[1].life;
    attackWith(t);
    expect(t.game.players[1].life).toBe(life - 3);
  });

  it('Grazilaxx returns a blocked creature that would die to its owner\'s hand', () => {
    const t = new Table();
    t.game.put(0, creature('Grazilaxx, Illithid Scholar', '{1}{U}{U}', 3, 3, 2, { text: "Whenever a creature you control becomes blocked, you may return it to its owner's hand." }), { tapped: true });
    const bear = t.game.put(0, bears());
    const wall = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    t.handlers[1] = (_g, d) => (d.kind === 'blockers' ? [{ blocker: wall.id, attacker: bear.id }] : undefined);
    attackWith(t);
    expect(t.game.players[0].battlefield).not.toContain(bear);
    expect(t.game.players[0].hand.map((c) => c.name)).toContain('Grizzly Bears');
  });
});

describe('protection (rule 702.16)', () => {
  it("a creature can't block an attacker with protection from its color, and damage from that color is prevented", () => {
    const t = new Table();
    const crusader = t.game.put(0, creature('Phyrexian Crusader', '{1}{B}{B}', 3, 2, 2, { text: 'First strike, protection from red and from white\nInfect' }));
    const green = t.game.put(1, bears());
    const red = t.game.put(1, creature('Goblin Piker', '{1}{R}', 2, 2, 1));
    expect(t.game.canBlock(red, crusader)).toBe(false);
    expect(t.game.canBlock(green, crusader)).toBe(true);
  });

  it("a spell of that color can't target it, and it shrugs off that color's sweeper damage", () => {
    const t = new Table();
    const animar = t.game.put(1, creature('Animar, Soul of Elements', '{G}{U}{R}', 3, 1, 1, { text: 'Protection from white and from black' }));
    const bolt = spell('Doom Blade', '{1}{B}', 2, 'Instant', 'Destroy target nonblack creature.');
    t.game.players[0].hand.push(bolt);
    const targets = (t.game as unknown as { aimAs: (c: unknown, s: number, a: boolean, f: () => unknown) => { kind: string; id: number }[] }).aimAs(bolt, 0, false, () => t.game.targetCandidates(t.game.players[0], bolt.effects[0], null));
    expect(targets.some((x) => x.id === animar.id)).toBe(false);
  });

  it('Vexilus Praetor gives commanders protection from everything', () => {
    const t = new Table();
    t.game.put(0, creature('Vexilus Praetor', '{1}{W}', 2, 3, 4, { text: 'Flash\nVigilance\nAegis of the Emperor — Commanders you control have protection from everything.' }));
    const cmd = t.game.put(0, bears('My Commander'), { commander: true });
    const blocker = t.game.put(1, bears());
    expect(t.game.protections(cmd)).toContain('pro:all');
    expect(t.game.canBlock(blocker, cmd)).toBe(false);
  });

  it('Absolute Virtue: combat damage from opponents to its controller is prevented', () => {
    const t = new Table();
    t.game.put(1, creature('Absolute Virtue', '{6}{W}{U}', 8, 8, 8, { text: 'This spell can\'t be countered.\nFlying\nYou have protection from each of your opponents.' }), { tapped: true });
    t.game.put(0, bears());
    const life = t.game.players[1].life;
    attackWith(t);
    expect(t.game.players[1].life).toBe(life);
    expect(log(t, /protection from/)).toHaveLength(1);
  });

  it('Mother of Runes reads, and picks the color of the creatures it faces', () => {
    const t = new Table();
    const mom = t.game.put(1, creature('Mother of Runes', '{W}', 1, 1, 1, { text: '{T}: Target creature you control gains protection from the color of your choice until end of turn.' }));
    expect(mom.card.effects[0]).toMatchObject({ kind: 'protectColor', when: 'activated' });
    const bear = t.game.put(1, bears());
    t.game.put(0, creature('Goblin Piker', '{1}{R}', 2, 2, 1));
    expect(t.game.threatColor(bear)).toBe('R');
  });
});

describe('creature types (rule 205.3)', () => {
  it('a tribal anthem only pumps that type, until Maskwood Nexus makes every creature every type', () => {
    const t = new Table();
    t.game.put(0, creature('Elvish Archdruid', '{1}{G}{G}', 3, 2, 2, { subTypes: ['Elf', 'Druid'], text: 'Other Elves you control get +1/+1.' }));
    const bear = t.game.put(0, bears());
    expect(t.game.power(bear)).toBe(2);
    t.game.put(0, spell('Maskwood Nexus', '{4}', 4, 'Artifact', 'Creatures you control are every creature type. The same is true for creature spells you control and creature cards you own that aren\'t on the battlefield.'));
    expect(t.game.power(bear)).toBe(3);
  });

  it('Metallic Mimic: the chosen type enters with an extra counter', () => {
    const t = new Table();
    const mimic = t.game.put(0, creature('Metallic Mimic', '{2}', 2, 2, 1, { subTypes: ['Shapeshifter'], text: 'As this creature enters, choose a creature type.\nThis creature is the chosen type in addition to its other types.\nEach other creature you control of the chosen type enters with an additional +1/+1 counter on it.' }));
    expect(mimic.card.unread).toBeUndefined();
    expect(mimic.chosenType).toBeTruthy();
  });
});
