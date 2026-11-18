// Card interactions: cards the engine already reads, checked against each
// other. Each test names the Comprehensive Rules section or Scryfall ruling
// that decides the answer. The cards use their real oracle text (with green
// mana costs, since the test table only has Forests).

import { describe, expect, it } from 'vitest';
import type { Game } from '../src/rules/game';
import { creature, spell } from './helpers';
import { attackAll, castOnce, find, Table } from './table';

const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const wrath = () => spell('Wrath of God', '{2}{G}{G}', 4, 'Sorcery', "Destroy all creatures. They can't be regenerated.");
const bloodArtist = () => creature('Blood Artist', '{1}{G}', 2, 0, 1, { text: 'Whenever this creature or another creature dies, target player loses 1 life and you gain 1 life.' });
const zulaport = () => creature('Zulaport Cutthroat', '{1}{G}', 2, 1, 1, { text: 'Whenever this creature or another creature you control dies, each opponent loses 1 life and you gain 1 life.' });
const sanguineBond = () => spell('Sanguine Bond', '{3}{G}{G}', 5, 'Enchantment', 'Whenever you gain life, target opponent loses that much life.');
const panharmonicon = () => spell('Panharmonicon', '{4}', 4, 'Artifact', 'If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.');
const impactTremors = () => spell('Impact Tremors', '{1}{G}', 2, 'Enchantment', 'Whenever a creature you control enters, this enchantment deals 1 damage to each opponent.');
const doublingSeason = () => spell('Doubling Season', '{4}{G}', 5, 'Enchantment', 'If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead.');
const names = (cards: { name: string }[]) => cards.map((c) => c.name);

/** How many log lines match. */
function logCount(t: Table, re: RegExp): number {
  return t.game.log!.filter((line) => re.test(line)).length;
}

describe('death triggers', () => {
  it('Blood Artist sees itself and every creature that dies with it in a wrath (rule 603.10a)', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    t.game.put(0, bloodArtist());
    t.game.put(0, bears());
    t.game.put(1, bears());
    t.game.put(1, bears());
    a.hand.push(wrath());
    t.handlers[0] = castOnce('Wrath of God');
    t.finishTurn();
    // Four creatures died at once: Blood Artist triggers four times, whichever was destroyed first.
    expect(b.life).toBe(36);
    expect(a.life).toBe(44);
  });

  it('Zulaport Cutthroat triggers on its own death but not on an opponent\'s creatures', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    t.game.put(0, zulaport());
    t.game.put(0, bears());
    t.game.put(1, bears());
    a.hand.push(wrath());
    t.handlers[0] = castOnce('Wrath of God');
    t.finishTurn();
    expect(b.life).toBe(38);
    expect(a.life).toBe(42);
  });

  it('"another creature" (Syr Konrad) does not trigger on its own death, but sees the rest of the wrath', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    t.game.put(0, creature('Syr Konrad, the Grim', '{3}{G}{G}', 5, 5, 4, { superTypes: ['Legendary'], text: 'Whenever another creature dies, or a creature card is put into a graveyard from anywhere other than the battlefield, or a creature card leaves your graveyard, Syr Konrad deals 1 damage to each opponent.' }));
    t.game.put(0, bears());
    t.game.put(1, bears());
    a.hand.push(wrath());
    t.handlers[0] = castOnce('Wrath of God');
    t.finishTurn();
    expect(b.life).toBe(38);
  });

  it('"another nontoken creature" (Grim Haruspex) ignores tokens dying', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 4);
    t.game.put(0, creature('Grim Haruspex', '{2}{G}', 3, 3, 2, { text: 'Whenever another nontoken creature you control dies, draw a card.' }));
    t.game.put(0, bears());
    a.hand.push(spell('Raise the Alarm', '{1}{G}', 2, 'Instant', 'Create two 1/1 white Soldier creature tokens.'), wrath());
    let step = 0;
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority') return undefined;
      const name = step === 0 ? 'Raise the Alarm' : step === 1 && g.stack.length === 0 ? 'Wrath of God' : null;
      const i = name ? find(d.actions, 'cast', name) : -1;
      if (i === -1) return undefined;
      step++;
      return { action: i };
    };
    t.lands(0, 2);
    t.game.log!.length = 0;
    t.finishTurn();
    // Haruspex, a Grizzly Bears and two Soldier tokens die: only the Bears draws a card.
    expect(step).toBe(2);
    expect(logCount(t, /draws 1 card\.$/)).toBe(1);
  });

  it('"one or more other creatures die ... only once each turn" (Morbid Opportunist) draws once for a wrath', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 4);
    t.game.put(0, creature('Morbid Opportunist', '{2}{G}', 3, 1, 3, { text: 'Whenever one or more other creatures die, draw a card. This ability triggers only once each turn.' }));
    t.game.put(0, bears());
    t.game.put(1, bears());
    t.game.put(1, bears());
    a.hand.push(wrath());
    t.handlers[0] = castOnce('Wrath of God');
    t.game.log!.length = 0;
    t.finishTurn();
    expect(logCount(t, /draws 1 card\.$/)).toBe(1);
  });

  it('Skullclamp on a 1-toughness creature kills it and draws two', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    t.game.put(0, spell('Skullclamp', '{1}', 1, 'Artifact', 'Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}', { subTypes: ['Equipment'] }));
    t.game.put(0, creature('Llanowar Elves', '{G}', 1, 1, 1));
    t.game.log!.length = 0;
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority') return undefined;
      const i = d.actions.findIndex((x) => x.type === 'activate');
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(a.graveyard.map((c) => c.name)).toContain('Llanowar Elves');
    expect(logCount(t, /draws 2 cards\.$/)).toBe(1);
  });
});

describe('indestructible, -X/-X and counters', () => {
  const heroic = () => spell('Heroic Intervention', '{1}{G}', 2, 'Instant', 'Permanents you control gain hexproof and indestructible until end of turn.');

  it('Toxic Deluge kills through Heroic Intervention; a damage sweeper does not (rules 702.12b, 704.5f)', () => {
    const run = (sweeper: ReturnType<typeof spell>) => {
      const t = new Table();
      const [a, b] = t.game.players;
      t.lands(0, 4);
      t.lands(1, 2);
      const wurm = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
      a.hand.push(sweeper);
      b.hand.push(heroic());
      let cast = false;
      t.handlers[0] = (_g, d) => {
        const i = d.kind === 'priority' && !cast ? find(d.actions, 'cast', sweeper.name) : -1;
        if (i === -1) return undefined;
        cast = true;
        return { action: i, x: 6 };
      };
      t.handlers[1] = castOnce('Heroic Intervention', (g) => g.stack.length === 1);
      t.finishTurn();
      expect(names(b.graveyard)).toContain('Heroic Intervention');
      return b.battlefield.includes(wurm);
    };
    expect(run(spell('Toxic Deluge', '{2}{G}', 3, 'Sorcery', 'As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.'))).toBe(false);
    expect(run(spell('Blasphemous Act', '{G}', 1, 'Sorcery', 'Blasphemous Act deals 13 damage to each creature.'))).toBe(true);
  });

  it('proliferate adds +1/+1 counters to your creatures and -1/-1 counters to your opponents\' (Grim Affliction)', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    const mine = t.game.put(0, bears(), { counters: 1 });
    const theirs = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    a.hand.push(spell('Grim Affliction', '{2}{G}', 3, 'Instant', 'Put a -1/-1 counter on target creature, then proliferate.'));
    const cast = castOnce('Grim Affliction');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: theirs.id } : cast(g, d));
    t.finishTurn();
    expect(mine.counters).toBe(2);
    expect(theirs.counters).toBe(-2);
    expect(t.game.toughness(theirs)).toBe(2);
  });
});

describe('life gain and life loss', () => {
  it('Sanguine Bond makes the opponent lose as much life as lifelink gained', () => {
    const t = new Table();
    const [, b] = t.game.players;
    t.game.put(0, sanguineBond());
    t.game.put(0, creature('Vampire Nighthawk', '{1}{G}{G}', 3, 3, 3, { keywords: ['Lifelink'], text: 'Lifelink' }));
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    // 3 combat damage, then 3 more from Sanguine Bond (not a fixed amount).
    expect(b.life).toBe(34);
  });

  it('lifelink damage to a blocker and the player at once is one life gain event (Sanguine Bond triggers once)', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.game.put(0, sanguineBond());
    t.game.put(0, creature('Lifelink Wurm', '{4}{G}', 5, 5, 5, { keywords: ['Lifelink', 'Trample'], text: 'Lifelink, trample' }));
    t.game.put(1, bears());
    t.handlers[0] = attackAll(1);
    t.handlers[1] = (_g, d) => (d.kind === 'blockers' ? [{ blocker: d.candidates[0], attacker: d.attackers[0] }] : undefined);
    t.game.log!.length = 0;
    t.finishTurn();
    expect(a.life).toBe(45);
    expect(b.life).toBe(40 - 3 - 5);
    expect(logCount(t, /hits .* for 5/)).toBe(1);
  });

  it('"you gain life equal to the life lost" counts only life really lost (Teferi\'s Protection)', () => {
    const t = new Table(3);
    const [a, b, c] = t.game.players;
    t.lands(0, 3);
    c.shielded = true;
    a.hand.push(spell('Exsanguinate Lite', '{2}{G}', 3, 'Sorcery', 'Each opponent loses 2 life. You gain life equal to the life lost this way.'));
    t.handlers[0] = castOnce('Exsanguinate Lite');
    t.finishTurn();
    expect(b.life).toBe(38);
    expect(c.life).toBe(40);
    expect(a.life).toBe(42);
  });
});

describe('attack triggers', () => {
  it('"whenever a nontoken creature you control attacks" (Mardu Ascendancy) ignores attacking tokens', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(0, spell('Mardu Ascendancy', '{R}{W}{B}', 3, 'Enchantment', 'Whenever a nontoken creature you control attacks, create a 1/1 red Goblin creature token that\'s tapped and attacking.'));
    t.game.put(0, bears());
    for (let i = 0; i < 3; i++) t.game.put(0, creature('Goblin', '', 0, 1, 1)).token = true;
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    // Four attackers, one of them nontoken: one new Goblin.
    expect(a.battlefield.filter((q) => q.token)).toHaveLength(4);
  });
});

describe('commanders', () => {
  it('a commander that dies still sets off death triggers on its way to the command zone (rule 903.9a)', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(1, 2);
    t.game.put(0, zulaport());
    const commander = t.game.put(0, creature('Commander p0', '{2}{G}{G}', 4, 4, 4, { superTypes: ['Legendary'] }), { commander: true });
    b.hand.push(spell('Murder', '{1}{G}', 2, 'Instant', 'Destroy target creature.'));
    const cast = castOnce('Murder');
    t.handlers[1] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: commander.id } : cast(g, d));
    t.finishTurn();
    expect(names(a.commandZone)).toContain('Commander p0');
    expect(b.life).toBe(39);
  });
});

describe('trigger doublers', () => {
  it('Panharmonicon doubles "a creature enters" triggers for tokens, but only for its controller', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    t.game.put(0, panharmonicon());
    t.game.put(0, impactTremors());
    t.game.put(1, panharmonicon());
    t.game.put(1, impactTremors());
    a.hand.push(spell('Dragon Fodder', '{1}{G}', 2, 'Sorcery', 'Create two 1/1 red Goblin creature tokens.'));
    t.handlers[0] = castOnce('Dragon Fodder');
    t.finishTurn();
    // Two tokens, each triggering Impact Tremors twice. The opponent's copies don't trigger at all.
    expect(b.life).toBe(36);
    expect(a.life).toBe(40);
  });

  it('Panharmonicon does not double an enchantment entering or landfall; Elesh Norn does', () => {
    const run = (doubler: ReturnType<typeof spell>) => {
      const t = new Table();
      const [a, b] = t.game.players;
      t.lands(0, 2);
      t.game.put(0, doubler);
      t.game.put(0, creature('Iridescent Vinelasher', '{B}', 1, 1, 2, { text: 'Landfall — Whenever a land you control enters, this creature deals 1 damage to target opponent.' }));
      a.hand.push(spell('Prosperous Bounty', '{1}{G}', 2, 'Enchantment', 'When this enchantment enters, it deals 1 damage to each opponent.'));
      a.hand.push(t.game.players[0].deck.cards[0].card);
      t.handlers[0] = (g, d) => {
        if (d.kind !== 'priority') return undefined;
        const land = find(d.actions, 'land');
        if (land !== -1) return { action: land };
        const i = g.stack.length === 0 ? find(d.actions, 'cast', 'Prosperous Bounty') : -1;
        return i === -1 ? undefined : { action: i };
      };
      t.finishTurn();
      return 40 - b.life;
    };
    expect(run(panharmonicon())).toBe(2);
    expect(run(creature('Elesh Norn, Mother of Machines', '{4}{G}', 5, 4, 7, { superTypes: ['Legendary'], text: 'Vigilance\nIf a permanent entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.\nPermanents entering don\'t cause abilities of permanents your opponents control to trigger.' }))).toBe(4);
  });

  it('Isshin doubles attack triggers and leaves enters triggers alone', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    t.game.put(0, creature('Isshin, Two Heavens as One', '{R}{W}{B}', 3, 3, 4, { superTypes: ['Legendary'], text: 'If a creature attacking causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.' }));
    t.game.put(0, creature('Raider', '{2}{G}', 3, 2, 2, { text: 'Whenever this creature attacks, draw a card.' }));
    a.hand.push(creature('Healer', '{1}{G}', 2, 1, 1, { text: 'When this creature enters, you gain 1 life.' }));
    const cast = castOnce('Healer');
    t.handlers[0] = (g, d) => (d.kind === 'attackers' ? d.candidates.filter((id) => g.findPerm(id)?.card.name === 'Raider').map((attacker) => ({ attacker, defender: 1 })) : cast(g, d));
    t.game.log!.length = 0;
    t.finishTurn();
    // Two draws from the Raider attacking, one life from the Healer entering.
    expect(logCount(t, /draws 1 card\.$/)).toBe(2);
    expect(a.life).toBe(41);
  });

  it('Drivnod doubles dies triggers', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    t.game.put(0, creature('Drivnod, Carnage Dominus', '{3}{G}{G}', 5, 8, 3, { superTypes: ['Legendary'], text: 'If a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.' }));
    t.game.put(0, zulaport());
    a.hand.push(spell('Murder', '{1}{G}', 2, 'Instant', 'Destroy target creature.'));
    const cast = castOnce('Murder');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: a.battlefield.find((q) => q.card.name === 'Zulaport Cutthroat')!.id } : cast(g, d));
    t.finishTurn();
    expect(b.life).toBe(38);
  });

  it('Veyran doubles magecraft for instants and sorceries, not for creature spells', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    t.game.put(0, creature('Veyran, Voice of Duality', '{1}{U}{R}', 3, 2, 2, { superTypes: ['Legendary'], text: 'Magecraft — Whenever you cast or copy an instant or sorcery spell, Veyran gets +1/+1 until end of turn.\nIf you casting or copying an instant or sorcery spell causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.' }));
    t.game.put(0, creature('Beast Whisperer', '{2}{G}{G}', 4, 4, 3, { text: 'Whenever you cast a creature spell, draw a card.' }));
    t.game.put(0, creature('Archmage Emeritus', '{2}{U}{U}', 4, 2, 2, { text: 'Magecraft — Whenever you cast or copy an instant or sorcery spell, draw a card.' }));
    a.hand.push(spell('Opt', '{G}', 1, 'Instant', 'Scry 1.'), creature('Llanowar Elves', '{G}', 1, 1, 1));
    let n = 0;
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority' || n >= 2) return undefined;
      const i = find(d.actions, 'cast');
      if (i === -1) return undefined;
      n++;
      return { action: i };
    };
    t.game.log!.length = 0;
    t.finishTurn();
    // Opt: Emeritus twice. Elves: Beast Whisperer once.
    expect(n).toBe(2);
    expect(logCount(t, /draws 1 card\.$/)).toBe(3);
  });
});

describe('token and counter doublers', () => {
  it('Doubling Season doubles Treasure tokens but not ritual mana', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    t.game.put(0, doublingSeason());
    a.hand.push(spell('Strike It Rich', '{G}', 1, 'Sorcery', 'Create a Treasure token.'), spell('Dark Ritual', '{G}', 1, 'Instant', 'Add {B}{B}{B}.'));
    const rich = castOnce('Strike It Rich');
    const ritual = castOnce('Dark Ritual', (g) => g.stack.length === 0 && a.treasures > 0);
    t.handlers[0] = (g, d) => rich(g, d) ?? ritual(g, d);
    t.finishTurn();
    // Strike It Rich: 2 Treasures. Dark Ritual, paid with the second Forest: 3 mana, not 6.
    expect(names(a.graveyard)).toEqual(['Strike It Rich', 'Dark Ritual']);
    expect(a.treasures).toBe(5);
  });

  it('Doubling Season doubles a planeswalker\'s starting loyalty and X +1/+1 counters it enters with', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 6);
    t.game.put(0, doublingSeason());
    a.hand.push(card4Walker(), creature('Hangarback Walker', '{X}{X}', 0, 0, 0, { text: 'This creature enters with X +1/+1 counters on it.\nWhen this creature dies, create a 1/1 colorless Thopter artifact creature token with flying for each +1/+1 counter on this creature.' }));
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority') return undefined;
      const walker = find(d.actions, 'cast', 'Test Walker');
      if (walker !== -1) return { action: walker };
      const hang = find(d.actions, 'cast', 'Hangarback Walker');
      return hang === -1 ? undefined : { action: hang, x: 1 };
    };
    t.finishTurn();
    const walker = a.battlefield.find((q) => q.card.name === 'Test Walker')!;
    const hangar = a.battlefield.find((q) => q.card.name === 'Hangarback Walker')!;
    expect(walker.loyalty).toBe(6);
    expect(hangar.counters).toBe(2);
  });
});

function card4Walker() {
  return spell('Test Walker', '{2}{G}{G}', 4, 'Planeswalker', '+1: You gain 1 life.', { loyalty: 3 });
}

describe('"first spell" and "second spell each turn"', () => {
  const lotho = () => creature('Lotho, Corrupt Shirriff', '{W}{B}', 2, 2, 1, { superTypes: ['Legendary'], text: 'Whenever a player casts their second spell each turn, you lose 1 life and create a Treasure token.' });
  const cheap = (name: string) => spell(name, '{G}', 1, 'Instant', 'You gain 1 life.');

  it('Lotho triggers on the second spell only, not the first or third', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    t.game.put(0, lotho());
    a.hand.push(cheap('One'), cheap('Two'), cheap('Three'));
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      const i = find(d.actions, 'cast');
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(names(a.graveyard)).toEqual(['One', 'Two', 'Three']);
    expect(a.treasures).toBe(1);
  });

  it('Pain Distributor gives its controller a Treasure only for their own first spell', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    t.lands(1, 1);
    t.game.put(0, creature('Pain Distributor', '{2}{R}', 3, 2, 3, { keywords: ['Menace'], text: 'Menace\nWhenever a player casts their first spell each turn, they create a Treasure token.' }));
    a.hand.push(cheap('One'), cheap('Two'));
    b.hand.push(cheap('Theirs'));
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      const i = find(d.actions, 'cast');
      return i === -1 ? undefined : { action: i };
    };
    t.handlers[1] = castOnce('Theirs');
    t.finishTurn();
    expect(names(a.graveyard)).toEqual(['One', 'Two']);
    expect(names(b.graveyard)).toEqual(['Theirs']);
    // One for seat 0's first spell; seat 1's spell makes seat 1 a Treasure, which the engine leaves out, never seat 0.
    expect(a.treasures).toBe(1);
  });

  it('Wavebreak Hippocamp draws only for the first spell during an opponent\'s turn', () => {
    const t = new Table();
    const [, b] = t.game.players;
    t.lands(1, 2);
    t.game.put(1, creature('Wavebreak Hippocamp', '{2}{G}', 3, 2, 2, { text: "Whenever you cast your first spell during each opponent's turn, draw a card." }));
    t.game.players[1].hand.push(cheap('Mine 1'), cheap('Mine 2'));
    t.handlers[1] = (g, d) => {
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      const i = find(d.actions, 'cast');
      return i === -1 ? undefined : { action: i };
    };
    t.game.log!.length = 0;
    t.finishTurn();
    // Seat 1 cast both on seat 0's turn: one draw.
    expect(names(b.graveyard)).toEqual(['Mine 1', 'Mine 2']);
    expect(logCount(t, /draws 1 card\.$/)).toBe(1);
  });
});

describe('static effects', () => {
  it('a lord ("other creatures you control") does not pump itself; two lords pump each other', () => {
    const t = new Table();
    const lord = () => creature('King Darien XLVIII', '{1}{G}{W}', 3, 2, 3, { superTypes: ['Legendary'], text: 'Other creatures you control get +1/+1.' });
    const darien = t.game.put(0, lord());
    const bear = t.game.put(0, bears());
    expect([t.game.power(darien), t.game.toughness(darien)]).toEqual([2, 3]);
    expect([t.game.power(bear), t.game.toughness(bear)]).toEqual([3, 3]);
    const other = t.game.put(0, creature('Elvish Archdruid', '{1}{G}{G}', 3, 2, 2, { text: 'Other creatures you control get +1/+1.' }));
    expect(t.game.power(darien)).toBe(3);
    expect(t.game.power(other)).toBe(3);
    expect(t.game.power(bear)).toBe(4);
  });

  it('attack taxes from different permanents add up (Propaganda + Ghostly Prison)', () => {
    const t = new Table();
    const [, b] = t.game.players;
    const tax = "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.";
    t.game.put(1, spell('Propaganda', '{2}{G}', 3, 'Enchantment', tax));
    t.game.put(1, spell('Ghostly Prison', '{2}{G}', 3, 'Enchantment', tax));
    t.game.put(0, bears());
    t.game.put(0, bears());
    t.lands(0, 5);
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    // {4} per attacker: five lands pay for one.
    expect(b.life).toBe(38);
  });

  it('only one mode of "as this enters, choose Mardu or Jeskai" is used', () => {
    const siege = spell('Windcrag Siege', '{1}{R}{W}', 3, 'Enchantment', 'As this enchantment enters, choose Mardu or Jeskai.\n• Mardu — If a creature attacking causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.\n• Jeskai — At the beginning of your upkeep, create a 1/1 red Goblin creature token. It gains lifelink and haste until end of turn.');
    expect(siege.effects).toHaveLength(1);
  });
});

describe('control changes and copies', () => {
  const sower = () => creature('Sower of Temptation', '{2}{G}{G}', 4, 2, 2, { keywords: ['Flying'], text: 'Flying\nWhen this creature enters, gain control of target creature for as long as this creature remains on the battlefield.' });
  const murder = () => spell('Murder', '{1}{G}', 2, 'Instant', 'Destroy target creature.');

  it('Sower of Temptation\'s creature goes back when Sower leaves (rule 611.2b)', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    t.lands(1, 2);
    const victim = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    a.hand.push(sower());
    t.handlers[0] = castOnce('Sower of Temptation');
    t.until((g) => a.battlefield.includes(victim) && g.stack.length === 0);
    const flier = a.battlefield.find((q) => q.card.name === 'Sower of Temptation')!;
    b.hand.push(murder());
    const cast = castOnce('Murder');
    t.handlers[1] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: flier.id } : cast(g, d));
    t.finishTurn();
    expect(b.battlefield).toContain(victim);
    expect(a.battlefield).not.toContain(victim);
  });

  it('Control Magic\'s creature goes back when the Aura is destroyed', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    t.lands(1, 2);
    const victim = t.game.put(1, bears());
    a.hand.push(spell('Control Magic', '{2}{G}{G}', 4, 'Enchantment', 'Enchant creature\nYou control enchanted creature.', { subTypes: ['Aura'] }));
    const cast = castOnce('Control Magic');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: victim.id } : cast(g, d));
    t.until((g) => a.battlefield.includes(victim) && g.stack.length === 0);
    const aura = a.battlefield.find((q) => q.card.name === 'Control Magic')!;
    b.hand.push(spell('Naturalize', '{1}{G}', 2, 'Instant', 'Destroy target artifact or enchantment.'));
    const cast2 = castOnce('Naturalize');
    t.handlers[1] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: aura.id } : cast2(g, d));
    t.finishTurn();
    expect(b.battlefield).toContain(victim);
  });

  it('a "for as long as you control" steal does nothing if its source is already gone', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 5);
    t.lands(1, 2);
    const victim = t.game.put(1, bears());
    a.hand.push(creature('Mind Flayer', '{3}{G}{G}', 5, 3, 3, { text: 'Dominate Monster — When this creature enters, gain control of target creature for as long as you control this creature.' }));
    t.handlers[0] = castOnce('Mind Flayer');
    // Kill the Flayer in response to its trigger.
    b.hand.push(murder());
    const cast = castOnce('Murder', (g: Game) => g.stack.some((s) => s.kind === 'ability'));
    t.handlers[1] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: a.battlefield.find((q) => q.card.name === 'Mind Flayer')!.id } : cast(g, d));
    t.finishTurn();
    expect(a.graveyard.map((c) => c.name)).toContain('Mind Flayer');
    expect(b.battlefield).toContain(victim);
  });

  it('Spark Double copies only your own creature, is not legendary, and enters with an extra +1/+1 counter', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 4);
    const legend = t.game.put(0, creature('Legendary Bear', '{1}{G}', 2, 2, 2, { superTypes: ['Legendary'] }));
    t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    a.hand.push(creature('Spark Double', '{3}{G}', 4, 0, 0, { text: "You may have this creature enter as a copy of a creature or planeswalker you control, except it enters with an additional +1/+1 counter on it if it's a creature, it enters with an additional loyalty counter on it if it's a planeswalker, and it isn't legendary." }));
    const offered: string[] = [];
    const cast = castOnce('Spark Double');
    t.handlers[0] = (g, d) => {
      if (d.kind === 'choose' && d.reason === 'clone') offered.push(...d.options.map((o) => o.label));
      return cast(g, d);
    };
    t.finishTurn();
    expect(offered).toEqual([]); // only one legal choice, so no question
    const copies = a.battlefield.filter((q) => q.card.name === 'Legendary Bear');
    expect(copies).toHaveLength(2);
    expect(a.battlefield).toContain(legend);
    expect(t.game.power(copies[1])).toBe(3);
  });

  it('a stolen commander\'s combat damage still counts as that commander\'s (rule 903.10a)', () => {
    const t = new Table(3);
    const [a, , c] = t.game.players;
    const commander = t.game.put(1, creature('Commander p1', '{2}{G}{G}', 4, 4, 4, { superTypes: ['Legendary'] }), { commander: true });
    t.lands(0, 4);
    a.hand.push(spell('Control Magic', '{2}{G}{G}', 4, 'Enchantment', 'Enchant creature\nYou control enchanted creature.', { subTypes: ['Aura'] }));
    const cast = castOnce('Control Magic');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: commander.id } : cast(g, d));
    t.finishTurn();
    // Next time seat 0 attacks, the commander hits seat 2.
    t.until((g) => g.activeSeat === 0 && g.step === 'main1');
    t.handlers[0] = attackAll(2);
    t.finishTurn();
    expect(c.commanderDamage.get('1:Commander p1')).toBe(4);
    expect(c.commanderDamage.has('0:Commander p1')).toBe(false);
  });

  it('each Treasure spent is its own sacrifice (Juri triggers per Treasure)', () => {
    const t = new Table();
    const [a] = t.game.players;
    const juri = t.game.put(0, creature('Juri, Master of the Revue', '{B}{R}', 2, 1, 1, { superTypes: ['Legendary'], text: 'Whenever you sacrifice a permanent, put a +1/+1 counter on Juri.' }));
    a.treasures = 2;
    a.hand.push(bears());
    t.handlers[0] = castOnce('Grizzly Bears');
    t.finishTurn();
    expect(a.treasures).toBe(0);
    expect(juri.counters).toBe(2);
  });
});

describe('amass and the monarch', () => {
  it('amass grows the one Army you control instead of making another (rule 701.47a)', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    a.hand.push(spell('Orc Call', '{G}', 1, 'Sorcery', 'Amass Orcs 2.'), spell('Orc Call Again', '{G}', 1, 'Sorcery', 'Amass Orcs 1.'));
    const first = castOnce('Orc Call');
    const second = castOnce('Orc Call Again');
    t.handlers[0] = (g, d) => first(g, d) ?? second(g, d);
    t.finishTurn();
    const armies = a.battlefield.filter((q) => q.card.isCreature);
    expect(armies).toHaveLength(1);
    expect(t.game.power(armies[0])).toBe(3);
  });

  it('Garland keeps a creature only while that player is the monarch (rule 611.2b)', () => {
    const t = new Table(3);
    const [a, b, c] = t.game.players;
    const target = t.game.put(1, bears());
    t.game.put(2, bears());
    t.lands(0, 4);
    a.hand.push(creature('Garland, Royal Kidnapper', '{2}{G}{G}', 4, 3, 4, { superTypes: ['Legendary'], text: "When Garland enters, target opponent becomes the monarch.\nWhenever an opponent becomes the monarch, gain control of target creature that player controls for as long as they're the monarch.\nCreatures you control but don't own get +2/+2 and can't be sacrificed." }));
    const cast = castOnce('Garland, Royal Kidnapper');
    // The monarch goes to seat 1; the stolen creature must be one of seat 1's.
    t.handlers[0] = (g, d) => (d.kind === 'target' ? (d.candidates.find((x) => x.kind === 'player' && x.seat === 1) ?? d.candidates[0]) : cast(g, d));
    t.finishTurn();
    expect(t.game.monarch).toBe(1);
    expect(target.seat).toBe(0);
    // Seat 2 takes the crown: the creature goes home, and Garland takes one of seat 2's instead.
    (t.game as unknown as { setMonarch(p: unknown): void }).setMonarch(c);
    expect(target.seat).toBe(1);
    expect(b.battlefield).toContain(target);
  });
});
