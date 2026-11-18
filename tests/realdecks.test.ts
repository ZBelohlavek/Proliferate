// Cards from the real decks that the engine reads since the coverage pass after
// the parallel branches merged: lockdown Auras, the Ring, "their second card each turn",
// and a handful of one-line cards.

import { describe, expect, it } from 'vitest';
import { creature, spell } from './helpers';
import { attackAll, castOnce, Table } from './table';

const downpour = () => spell('Amphibian Downpour', '{2}{G}', 3, 'Enchantment', 'Flash\nEnchant creature\nEnchanted creature loses all abilities and is a blue Frog creature with base power and toughness 1/1.', { subTypes: ['Aura'] });
const moon = () => spell('Imprisoned in the Moon', '{2}{G}', 3, 'Enchantment', 'Enchant creature, land, or planeswalker\nEnchanted permanent is a colorless land with "{T}: Add {C}" and loses all other card types and abilities.', { subTypes: ['Aura'] });
const naturalize = () => spell('Naturalize', '{1}{G}', 2, 'Instant', 'Destroy target artifact or enchantment.');
const nazgul = () => creature('Nazgûl', '{2}{G}', 3, 1, 2, { subTypes: ['Zombie', 'Wraith', 'Knight'], keywords: ['Deathtouch'], text: 'Deathtouch\nWhen this creature enters, the Ring tempts you.\nWhenever the Ring tempts you, put a +1/+1 counter on each Wraith you control.\nA deck can have up to nine cards named Nazgûl.' });
const flier = () => creature('Serra Angel', '{3}{W}{W}', 5, 4, 4, { keywords: ['Flying', 'Vigilance'], text: 'Flying, vigilance' });

describe('lockdown Auras', () => {
  it('Amphibian Downpour leaves a vanilla 1/1 until the Aura goes', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.lands(1, 2);
    const angel = t.game.put(1, flier());
    a.hand.push(downpour());
    const cast = castOnce('Amphibian Downpour');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: angel.id } : cast(g, d));
    t.until((g) => !!angel.unlocked && g.stack.length === 0);
    expect(t.game.power(angel)).toBe(1);
    expect(t.game.toughness(angel)).toBe(1);
    expect(t.game.hasKw(angel, 'flying')).toBe(false);

    const aura = a.battlefield.find((q) => q.card.name === 'Amphibian Downpour')!;
    b.hand.push(naturalize());
    const cast2 = castOnce('Naturalize');
    t.handlers[1] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: aura.id } : cast2(g, d));
    t.finishTurn();
    expect(angel.unlocked).toBeUndefined();
    expect(t.game.power(angel)).toBe(4);
    expect(t.game.hasKw(angel, 'flying')).toBe(true);
  });

  it('a locked creature that dies goes to the graveyard as its real card', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    const angel = t.game.put(1, flier());
    a.hand.push(downpour());
    const cast = castOnce('Amphibian Downpour');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: angel.id } : cast(g, d));
    t.until((g) => !!angel.unlocked && g.stack.length === 0);
    angel.damage = 1;
    t.finishTurn();
    expect(b.battlefield).not.toContain(angel);
    expect(b.graveyard.map((c) => c.name)).toContain('Serra Angel');
    expect(b.graveyard.find((c) => c.name === 'Serra Angel')!.power).toBe(4);
  });

  it('Imprisoned in the Moon turns a creature into a mana source that is no creature', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    const angel = t.game.put(1, flier());
    a.hand.push(moon());
    const cast = castOnce('Imprisoned in the Moon');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: angel.id } : cast(g, d));
    t.until((g) => !!angel.unlocked && g.stack.length === 0);
    expect(angel.card.isCreature).toBe(false);
    expect(angel.card.effects.some((e) => e.kind === 'mana')).toBe(true);
    expect(t.game.attackCandidates(t.game.players[1])).not.toContain(angel);
  });
});

describe('the Ring tempts you', () => {
  it('Nazgûl entering tempts its controller, names a ring-bearer and grows the Wraiths', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    const old = t.game.put(0, nazgul());
    a.hand.push(nazgul());
    t.handlers[0] = castOnce('Nazgûl');
    t.until((g) => a.battlefield.filter((q) => q.card.name === 'Nazgûl').length === 2 && g.stack.length === 0 && a.ringLevel > 0);
    t.finishTurn();
    expect(a.ringLevel).toBe(1);
    expect(a.ringBearer).not.toBeNull();
    // Both Nazgûl see the Ring tempt, so each Wraith gets two counters (tribal wording is read as all your creatures).
    expect(old.counters).toBe(2);
  });

  it('the ring-bearer cannot be blocked by a creature with greater power, and at level 4 drains on a hit', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    const bearer = t.game.put(0, creature('Hobbit', '{G}', 1, 1, 1));
    const big = t.game.put(1, creature('Ogre', '{2}{G}', 3, 3, 3));
    a.ringLevel = 4;
    a.ringBearer = bearer.id;
    expect(t.game.canBlock(big, bearer)).toBe(false);
    const lives = t.game.players.map((p) => p.life);
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    // 1 combat damage plus 3 from the Ring.
    expect(b.life).toBe(lives[1] - 4);
  });
});

describe('one-line cards from the real decks', () => {
  it('Faerie Mastermind draws on an opponent\'s second card of the turn only', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.game.put(0, creature('Faerie Mastermind', '{1}{U}', 2, 2, 1, { keywords: ['Flying', 'Flash'], text: 'Flash\nFlying\nWhenever an opponent draws their second card each turn, you draw a card.\n{3}{U}: Each player draws a card.' }));
    const hand = a.hand.length;
    b.drawsThisTurn = 0;
    t.game.draw(b, 1);
    t.until((g) => g.stack.length === 0);
    expect(a.hand.length).toBe(hand);
    t.game.draw(b, 1);
    t.finishTurn();
    expect(a.hand.length).toBeGreaterThanOrEqual(hand + 1);
  });

  it('reads Mana Crypt, Herald\'s Horn, Cloud Key, High Tide, Eerie Interlude and Dispatch', () => {
    const crypt = spell('Mana Crypt', '{0}', 0, 'Artifact', 'At the beginning of your upkeep, flip a coin. If you lose the flip, this artifact deals 3 damage to you.\n{T}: Add {C}{C}.');
    const horn = spell('Herald\'s Horn', '{3}', 3, 'Artifact', 'As this artifact enters, choose a creature type.\nCreature spells you cast of the chosen type cost {1} less to cast.\nAt the beginning of your upkeep, look at the top card of your library. If it\'s a creature card of the chosen type, you may reveal it and put it into your hand.');
    const key = spell('Cloud Key', '{3}', 3, 'Artifact', 'As this artifact enters, choose artifact, creature, enchantment, instant, or sorcery.\nSpells you cast of the chosen type cost {1} less to cast.');
    const tide = spell('High Tide', '{U}', 1, 'Instant', 'Until end of turn, whenever a player taps an Island for mana, that player adds an additional {U}.');
    const interlude = spell('Eerie Interlude', '{2}{W}', 3, 'Instant', 'Exile any number of target creatures you control. Return those cards to the battlefield under their owner\'s control at the beginning of the next end step.');
    const dispatch = spell('Dispatch', '{W}', 1, 'Instant', 'Tap target creature.\nMetalcraft — If you control three or more artifacts, exile that creature.');
    for (const c of [crypt, horn, key, tide, interlude]) expect(c.unread, c.name).toBeUndefined();
    expect(crypt.effects.some((e) => e.kind === 'loseLife' && e.chance === 0.5)).toBe(true);
    expect(horn.effects.some((e) => e.kind === 'costReduction' && e.filter === 'creature')).toBe(true);
    expect(key.effects.some((e) => e.kind === 'costReduction')).toBe(true);
    expect(tide.effects.some((e) => e.kind === 'treasure' && e.ritual)).toBe(true);
    expect(interlude.effects.some((e) => e.kind === 'blink' && e.n > 1)).toBe(true);
    expect(dispatch.effects.some((e) => e.kind === 'removal' && e.mode === 'exile')).toBe(true);
  });

  it('Narset keeps opponents to one card a turn, Notion Thief takes their extra draws, Teferi doubles yours', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    const narset = t.game.put(0, spell('Narset, Parter of Veils', '{1}{U}{U}', 3, 'Planeswalker', "Each opponent can't draw more than one card each turn.", { loyalty: '5' }));
    b.drawsThisTurn = 0;
    const before = b.hand.length;
    t.game.draw(b, 3);
    expect(b.hand.length).toBe(before + 1);
    a.battlefield.splice(a.battlefield.indexOf(narset), 1);

    t.game.put(0, creature('Notion Thief', '{2}{U}{B}', 4, 3, 1, { text: "Flash\nIf an opponent would draw a card except the first one they draw in each of their draw steps, instead that player skips that draw and you draw a card." }));
    const mine = a.hand.length;
    const theirs = b.hand.length;
    t.game.draw(b, 2);
    expect(b.hand.length).toBe(theirs);
    expect(a.hand.length).toBe(mine + 2);

    t.game.put(1, spell("Teferi's Ageless Insight", '{2}{U}{U}', 4, 'Enchantment', "If you would draw a card except the first one you draw in each of your draw steps, draw two cards instead."));
    const now = a.hand.length;
    a.battlefield = a.battlefield.filter((q) => q.card.name !== 'Notion Thief');
    t.game.put(0, spell("Teferi's Ageless Insight", '{2}{U}{U}', 4, 'Enchantment', "If you would draw a card except the first one you draw in each of your draw steps, draw two cards instead."));
    t.game.draw(a, 1);
    expect(a.hand.length).toBe(now + 2);
  });

  it('Mindcrank mills an opponent for the life they lose', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.game.put(0, spell('Mindcrank', '{2}', 2, 'Artifact', 'Whenever an opponent loses life, that player mills that many cards. (Damage dealt by sources without infect causes loss of life.)'));
    const lib = b.library.length;
    t.game.loseLife(b, 3, a, 'noncombat');
    expect(b.library.length).toBe(lib - 3);
  });

  it('Mystic Remora asks for more each upkeep and is sacrificed once it costs too much', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 8);
    const remora = t.game.put(0, spell('Mystic Remora', '{U}', 1, 'Enchantment', 'Cumulative upkeep {1} (At the beginning of your upkeep, put an age counter on this permanent, then sacrifice it unless you pay its upkeep cost for each age counter on it.)\nWhenever an opponent casts a noncreature spell, you may draw a card unless that player pays {4}.'));
    expect(remora.card.unread).toBeUndefined();
    for (let i = 0; i < 4 && a.battlefield.includes(remora); i++) {
      t.finishTurn();
      t.finishTurn();
    }
    expect(a.battlefield).not.toContain(remora);
    expect(t.game.log!.some((l) => l.includes('pays cumulative upkeep for Mystic Remora'))).toBe(true);
  });

  it('reads firebending, goaded deaths, tribal combat damage and the Army trigger on commanders', () => {
    const azula = creature('Fire Lord Azula', '{1}{U}{B}{R}', 4, 4, 4, { text: 'Firebending 2\nWhenever you cast a spell while Fire Lord Azula is attacking, copy that spell. You may choose new targets for the copy.' });
    const baeloth = creature('Baeloth Barrityl, Entertainer', '{4}{R}', 5, 2, 5, { text: "Creatures your opponents control with power less than Baeloth Barrityl's power are goaded.\nWhenever a goaded attacking or blocking creature dies, you create a Treasure token." });
    const alela = creature('Alela, Cunning Conqueror', '{2}{U}{B}', 4, 2, 4, { keywords: ['Flying'], text: "Flying\nWhenever you cast your first spell during each opponent's turn, create a 1/1 blue Faerie creature token with flying.\nWhenever one or more Faeries you control deal combat damage to a player, goad target creature that player controls." });
    for (const c of [azula, baeloth, alela]) expect(c.unread, c.name).toBeUndefined();
    expect(azula.effects.some((e) => e.kind === 'treasure' && e.when === 'attack' && e.n === 2)).toBe(true);
    expect(baeloth.effects.some((e) => e.kind === 'treasure' && e.when === 'creatureDies')).toBe(true);
    expect(alela.effects.some((e) => e.kind === 'goad' && e.when === 'combatDamage')).toBe(true);
  });
});

describe('keywords from the partly read cards', () => {
  it('toxic gives poison on combat damage', () => {
    const t = new Table();
    const [, b] = t.game.players;
    t.game.put(0, creature('Blightbelly Rat', '{1}{G}', 2, 2, 2, { text: 'Toxic 1 (Players dealt combat damage by this creature also get a poison counter.)\nWhen this creature dies, proliferate.' }));
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    expect(b.poison).toBe(1);
  });

  it("shadow, fear and \"can't block\" limit blocks", () => {
    const t = new Table();
    const shade = t.game.put(0, creature('Dauthi Slayer', '{B}{B}', 2, 2, 2, { keywords: ['Shadow'], text: 'Shadow' }));
    const fearful = t.game.put(0, creature('Shriekmaw', '{4}{B}', 5, 3, 2, { keywords: ['Fear'], text: 'Fear' }));
    const bear = t.game.put(1, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    const champ = t.game.put(1, creature('Bloodsoaked Champion', '{B}', 1, 1, 1, { text: "Bloodsoaked Champion can't block." }));
    expect(t.game.canBlock(bear, shade)).toBe(false);
    expect(t.game.canBlock(bear, fearful)).toBe(false);
    expect(t.game.canBlock(champ, t.game.put(0, creature('Ox', '{1}{G}', 2, 2, 2)))).toBe(false);
    expect(champ.card.unread).toBeUndefined();
  });

  it('reads prowess, annihilator and constellation', () => {
    const prodigy = creature('Swiftspear', '{R}', 1, 1, 2, { text: 'Haste\nProwess' });
    const artisan = creature('Artisan of Kozilek', '{9}', 9, 10, 9, { text: 'Annihilator 2' });
    const eidolon = creature('Eidolon of Blossoms', '{2}{G}{G}', 4, 2, 2, { types: ['Enchantment', 'Creature'], text: 'Constellation — Whenever this creature or another enchantment you control enters, draw a card.' });
    for (const c of [prodigy, artisan, eidolon]) expect(c.unread, c.name).toBeUndefined();
    expect(prodigy.effects.some((e) => e.kind === 'pump' && e.when === 'cast')).toBe(true);
    expect(artisan.effects.filter((e) => e.kind === 'removal' && e.mode === 'edict' && e.when === 'attack').length).toBe(2);
    expect(eidolon.effects.some((e) => e.kind === 'draw' && e.when === 'permEnters')).toBe(true);
  });
});

describe('ninjutsu', () => {
  it('swaps a ninja in for an unblocked attacker; it deals the damage and its trigger fires', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    const scout = t.game.put(0, creature('Scout', '{G}', 1, 1, 1));
    const ninja = creature('Ninja of the Deep Hours', '{3}{G}', 4, 2, 2, { text: 'Ninjutsu {1}{G} ({1}{G}, Return an unblocked attacker you control to hand: Put this card onto the battlefield from your hand tapped and attacking.)\nWhenever this creature deals combat damage to a player, you may draw a card.' });
    a.hand.push(ninja);
    expect(ninja.unread).toBeUndefined();
    const life = b.life;
    let used = false;
    t.handlers[0] = (g, d) => {
      if (d.kind === 'attackers') return [{ attacker: scout.id, defender: 1 }];
      if (d.kind === 'priority' && !used) {
        const i = d.actions.findIndex((x) => x.type === 'ninjutsu');
        if (i !== -1) {
          used = true;
          return { action: i };
        }
      }
      return undefined;
    };
    const hand = a.hand.length;
    t.finishTurn();
    expect(used).toBe(true);
    expect(a.hand).toContain(scout.card);
    expect(a.battlefield.some((q) => q.card.name === 'Ninja of the Deep Hours')).toBe(true);
    expect(b.life).toBe(life - 2);
    // Scout back in hand (+1), ninja out of hand (-1), one card drawn (+1).
    expect(a.hand.length).toBe(hand + 1);
  });
});

