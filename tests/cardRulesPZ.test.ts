// One-off cards named P to Z (src/engine/cardRulesPZ.ts) and the engine pieces they needed:
// landwalk, skulk, myriad, vanishing, power-based evasion, "you have hexproof", Phyrexian Obliterator,
// bounty kills, proliferate triggers and doubling, end-step bounce and "life total becomes".
// Real oracle text, with green mana costs where the test table needs them.

import { describe, expect, it } from 'vitest';
import { CARD_RULES } from '../src/engine/cardRules';
import { card, creature, spell } from './helpers';
import { attackAll, castOnce, type Handler, Table } from './table';

const bears = (name = 'Grizzly Bears') => creature(name, '{1}{G}', 2, 2, 2);
const island = () => card({ name: 'Island', types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], colorIdentity: ['U'] });
/** Seat `seat` blocks every attacker it can with the given blocker. */
const blockWith = (blockerId: number): Handler => (_g, d) =>
  d.kind === 'blockers' && d.candidates.includes(blockerId) ? [{ blocker: blockerId, attacker: d.attackers[0] }] : undefined;

describe('reading P to Z one-offs', () => {
  it('reads the new keywords: landwalk, skulk, myriad, vanishing and power-based evasion', () => {
    const wrexial = creature('Wrexial, the Risen Deep', '{3}{U}{U}{B}', 6, 5, 8, { text: 'Islandwalk, swampwalk (This creature can\'t be blocked as long as defending player controls an Island or a Swamp.)' });
    expect(wrexial.keywords).toEqual(expect.arrayContaining(['islandwalk', 'swampwalk']));
    expect(wrexial.unread).toBeUndefined();
    expect(creature('Wharf Infiltrator', '{1}{U}', 2, 1, 1, { text: 'Skulk' }).keywords).toContain('skulk');
    expect(creature('Wizards of Thay', '{3}{U}', 4, 3, 3, { text: 'Myriad' }).keywords).toContain('myriad');
    const whale = creature('Dreamtide Whale', '{2}{U}', 3, 7, 5, { text: 'Vanishing 2' });
    expect(whale.vanishing).toBe(2);
    expect(whale.unread).toBeUndefined();
    const stormkeld = creature('Storm Test', '{4}{G}{G}', 6, 6, 7, { text: "This creature can't be blocked by creatures with power 2 or less." });
    expect(stormkeld.keywords).toContain("can't be blocked by power 2 or less");
    expect(stormkeld.unread).toBeUndefined();
    const teyo = spell('Teyo Test', '{2}{W}', 3, 'Enchantment', 'You have hexproof.');
    expect(teyo.effects[0]).toMatchObject({ kind: 'playerHexproof', when: 'static' });
  });

  it('every P to Z entry in the decks reads with nothing left unread', () => {
    for (const name of ['Phyrexian Obliterator', 'Rain of Riches', 'Parcelbeast', 'Tekuthal, Inquiry Dominus', 'Scheming Aspirant']) expect(CARD_RULES[name], name).toBeDefined();
    const aspirant = creature('Scheming Aspirant', '{1}{B}', 2, 1, 3, { text: 'Whenever you proliferate, each opponent loses 2 life and you gain 2 life.' });
    expect(aspirant.effects[0]).toMatchObject({ kind: 'drain', when: 'proliferate' });
    expect(aspirant.unread).toBeUndefined();
  });
});

describe('evasion keywords in combat', () => {
  it('islandwalk: no blocks while the defending player controls an Island (rule 702.14c)', () => {
    const t = new Table();
    t.game.put(0, creature('Cold-Eyed Selkie', '{1}{G}', 2, 1, 1, { text: 'Islandwalk' }));
    const wall = t.game.put(1, bears('Wall'));
    t.game.put(1, island());
    t.handlers[0] = attackAll(1);
    t.handlers[1] = blockWith(wall.id);
    t.finishTurn();
    expect(t.game.players[1].life).toBe(39);
  });

  it('skulk and "can\'t be blocked by power 2 or less" keep the right blockers out', () => {
    const t = new Table();
    const skulk = t.game.put(0, creature('Wharf Infiltrator', '{1}{G}', 2, 1, 1, { text: 'Skulk' }));
    const big = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    const small = t.game.put(1, bears());
    expect(t.game.canBlock(big, skulk)).toBe(false);
    const vanguard = t.game.put(0, creature('Stormkeld Vanguard', '{4}{G}{G}', 6, 6, 7, { text: "This creature can't be blocked by creatures with power 2 or less." }));
    expect(t.game.canBlock(small, vanguard)).toBe(false);
    expect(t.game.canBlock(big, vanguard)).toBe(true);
  });

  it('myriad: a token copy attacks each other opponent and is exiled at end of turn (rule 702.116)', () => {
    const t = new Table(4);
    t.game.put(0, creature('Wizards of Thay', '{3}{G}', 4, 3, 3, { text: 'Myriad' }));
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    expect(t.game.log!.filter((l) => /has myriad: a token copy attacks/.test(l))).toHaveLength(2);
    expect(t.game.players.map((p) => p.life)).toEqual([40, 37, 37, 37]);
    expect(t.game.players[0].battlefield.filter((q) => q.token)).toHaveLength(0);
  });
});

describe('P to Z engine pieces', () => {
  it('Phyrexian Obliterator: whoever damages it sacrifices that many permanents', () => {
    const t = new Table();
    t.game.put(0, creature('Phyrexian Obliterator', '{B}{B}{B}{B}', 4, 5, 5, { text: 'Trample\nWhenever a source deals damage to this creature, that source\'s controller sacrifices that many permanents of their choice.' }));
    const blocker = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    for (let i = 0; i < 5; i++) t.game.put(1, bears(`Bear ${i}`));
    t.handlers[0] = attackAll(1);
    t.handlers[1] = blockWith(blocker.id);
    t.finishTurn();
    // The Wurm dealt 6: it and five Bears (or whatever they choose) are gone, six permanents in all.
    expect(t.game.players[1].battlefield).toHaveLength(0);
  });

  it('Reaper of Sheoldred gives the damaging player a poison counter', () => {
    const t = new Table();
    const reaper = t.game.put(1, creature('Reaper of Sheoldred', '{4}{G}', 5, 2, 5, { text: 'Infect\nWhenever a source deals damage to this creature, that source\'s controller gets a poison counter.' }));
    t.game.put(0, bears());
    t.handlers[0] = attackAll(1);
    t.handlers[1] = blockWith(reaper.id);
    t.finishTurn();
    expect(t.game.players[0].poison).toBe(1);
  });

  it('Termination Facilitator: a creature with a bounty counter dies to any damage', () => {
    const t = new Table();
    t.game.put(0, creature('Termination Facilitator', '{1}{G}', 2, 1, 3, { text: '{T}: Put a bounty counter on target creature or planeswalker. Activate only as a sorcery.\nWhenever a creature or planeswalker an opponent controls with a bounty counter on it is dealt damage, destroy it.' }));
    const wurm = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    wurm.bounty = true;
    t.game.put(0, bears());
    t.handlers[0] = attackAll(1);
    t.handlers[1] = blockWith(wurm.id);
    t.finishTurn();
    expect(t.game.players[1].graveyard.map((c) => c.name)).toContain('Craw Wurm');
  });

  it('Tekuthal makes proliferate happen twice, and Scheming Aspirant drains on each', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.game.put(0, creature('Tekuthal, Inquiry Dominus', '{2}{U}{U}', 4, 3, 5, { text: 'Flying\nIf you would proliferate, proliferate twice instead.' }));
    t.game.put(0, creature('Scheming Aspirant', '{1}{B}', 2, 1, 3, { text: 'Whenever you proliferate, each opponent loses 2 life and you gain 2 life.' }));
    const bear = t.game.put(0, bears(), { counters: 1 });
    b.poison = 1;
    a.hand.push(spell('Grow Test', '{1}{G}', 2, 'Instant', 'Proliferate.'));
    t.handlers[0] = castOnce('Grow Test');
    t.finishTurn();
    expect(bear.counters).toBe(3);
    expect(b.poison).toBe(3);
    expect(b.life).toBe(36);
  });

  it('player hexproof keeps opponents from targeting that player', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(1, spell('Teyo Test', '{2}{W}', 3, 'Enchantment', 'You have hexproof.'));
    const bolt = spell('Lava Spike', '{G}', 1, 'Sorcery', 'Lava Spike deals 3 damage to target player or planeswalker.');
    const e = bolt.effects[0];
    expect(t.game.targetCandidates(a, e, null)?.some((x) => x.kind === 'player' && x.seat === 1)).toBe(false);
  });

  it('vanishing: sacrificed when the last time counter comes off', () => {
    const t = new Table();
    const whale = t.game.put(0, creature('Dreamtide Whale', '{2}{U}', 3, 7, 5, { text: 'Vanishing 2' }));
    for (let i = 0; i < 4 && t.game.players[0].battlefield.includes(whale); i++) t.finishTurn();
    expect(t.game.players[0].graveyard.map((c) => c.name)).toContain('Dreamtide Whale');
  });

  it('Reinforced Ronin goes back to hand at the end step; The Endstone sets life to 20', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(0, creature('Reinforced Ronin', '{G}', 1, 2, 2, { text: 'Haste\nAt the beginning of your end step, return this creature to its owner\'s hand.' }));
    t.game.put(0, spell('The Endstone', '{7}', 7, 'Legendary Artifact', 'Whenever you play a land or cast a spell, draw a card.\nAt the beginning of your end step, your life total becomes half your starting life total, rounded up.'));
    t.finishTurn();
    expect(a.hand.map((c) => c.name)).toContain('Reinforced Ronin');
    expect(a.life).toBe(20);
  });

  it('Reidane taxes only noncreature spells with mana value 4 or more', () => {
    const reidane = creature('Reidane, God of the Worthy', '{2}{W}', 3, 2, 3, { text: 'Flying, vigilance\nSnow lands your opponents control enter tapped.\nNoncreature spells your opponents cast with mana value 4 or greater cost {2} more to cast.' });
    expect(reidane.effects.find((e) => e.kind === 'spellTax')).toMatchObject({ amount: 2, minCmc: 4 });
    expect(reidane.unread).toBeUndefined();
  });
});
