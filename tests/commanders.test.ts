// The last commanders from the real decks that the card reader only partly read:
// Sigurd's boast, Fblthp, Ultima, Zur, Lord of the Nazgûl, Orvar, Ygra, and Lynde with the Curses her deck runs on.

import { describe, expect, it } from 'vitest';
import { FOOD } from '../src/rules/game';
import { Bot } from '../src/rules/bot';
import { card, creature, spell } from './helpers';
import { attackAll, castOnce, find, Table } from './table';

const WUBRG = ['W', 'U', 'B', 'R', 'G'] as const;
const legend = (name: string, cost: string, cmc: number, p: number, t: number, subTypes: string[], text: string, keywords: string[] = []) =>
  creature(name, cost, cmc, p, t, { superTypes: ['Legendary'], subTypes, text, keywords });

const sigurd = () => legend('Sigurd, Jarl of Ravensthorpe', '{R}{G}{W}', 3, 3, 3, ['Human', 'Warrior'], 'Vigilance, trample, lifelink\nBoast — {1}: Put a lore counter on target Saga you control or remove one from it. (Activate only if this creature attacked this turn and only once each turn.)\nWhenever you put a lore counter on a Saga you control, put a +1/+1 counter on up to one other target creature.', ['Trample', 'Vigilance', 'Lifelink', 'Boast']);
const fblthp = () => legend('Fblthp, the Lost', '{1}{U}', 2, 1, 1, ['Homunculus'], 'When Fblthp enters, draw a card. If it entered from your library or was cast from your library, draw two cards instead.\nWhen Fblthp becomes the target of a spell, shuffle Fblthp into its owner\'s library.');
const ultima = () => legend('Ultima, Origin of Oblivion', '{5}', 5, 4, 4, ['God'], 'Flying\nWhenever Ultima attacks, put a blight counter on target land. For as long as that land has a blight counter on it, it loses all land types and abilities and has "{T}: Add {C}."\nWhenever you tap a land for {C}, add an additional {C}.', ['Flying']);
const zur = () => legend('Zur, Eternal Schemer', '{W}{U}{B}', 3, 1, 4, ['Human', 'Wizard'], 'Flying\nEnchantment creatures you control have deathtouch, lifelink, and hexproof.\n{1}{W}: Target non-Aura enchantment you control becomes a creature in addition to its other types and has base power and base toughness each equal to its mana value.', ['Flying', 'Lifelink']);
const lordOfTheNazgul = () => legend('Lord of the Nazgûl', '{3}{U}{B}', 5, 4, 3, ['Wraith', 'Noble'], 'Flying\nWraiths you control have protection from Ring-bearers.\nWhenever you cast an instant or sorcery spell, create a 3/3 black Wraith creature token with menace. Then if you control nine or more Wraiths, Wraiths you control have base power and toughness 9/9 until end of turn.', ['Flying']);
const orvar = () => legend('Orvar, the All-Form', '{3}{U}', 4, 3, 3, ['Shapeshifter'], 'Changeling\nWhenever you cast an instant or sorcery spell, if it targets one or more other permanents you control, create a token that\'s a copy of one of those permanents.\nWhen a spell or ability an opponent controls causes you to discard this card, create a token that\'s a copy of target permanent.', ['Changeling']);
const ygra = () => legend('Ygra, Eater of All', '{3}{B}{G}', 5, 6, 6, ['Elemental', 'Cat'], 'Ward—Sacrifice a Food.\nOther creatures are Food artifacts in addition to their other types and have "{2}, {T}, Sacrifice this permanent: You gain 3 life."\nWhenever a Food is put into a graveyard from the battlefield, put two +1/+1 counters on Ygra.', ['Ward']);
const lynde = () => legend('Lynde, Cheerful Tormentor', '{1}{U}{B}{R}', 4, 2, 4, ['Human', 'Warlock'], 'Deathtouch\nWhenever a Curse is put into your graveyard from the battlefield, return it to the battlefield attached to you at the beginning of the next end step.\nAt the beginning of your upkeep, you may attach a Curse attached to you to one of your opponents. If you do, draw two cards.', ['Deathtouch']);

const curse = (name: string, cost: string, cmc: number, text: string) => spell(name, cost, cmc, 'Enchantment', `Enchant player\n${text}`, { subTypes: ['Aura', 'Curse'] });
const opulence = () => curse('Curse of Opulence', '{R}', 1, 'Whenever enchanted player is attacked, create a Gold token. Each opponent attacking that player does the same. (A Gold token is an artifact with "Sacrifice this token: Add one mana of any color.")');
const scarabs = () => curse('Torment of Scarabs', '{3}{B}', 4, "At the beginning of enchanted player's upkeep, that player loses 3 life unless they sacrifice a nonland permanent of their choice or discard a card.");
const deathsHold = () => curse("Curse of Death's Hold", '{3}{B}{B}', 5, 'Creatures enchanted player controls get -1/-1.');
const bloodletting = () => curse('Curse of Bloodletting', '{3}{R}{R}', 5, 'If a source would deal damage to enchanted player, it deals double that damage to that player instead.');

const saga = () => spell('Story Saga', '{2}{W}', 3, 'Enchantment', '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after IV.)\nI, II, III — Draw a card.\nIV — You gain 4 life.', { subTypes: ['Saga'] });
const propaganda = () => spell('Propaganda', '{2}{U}', 3, 'Enchantment', "Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.");
const murder = () => spell('Murder', '{1}{B}{B}', 3, 'Instant', 'Destroy target creature.');
const naturalize = () => spell('Naturalize', '{1}{G}', 2, 'Instant', 'Destroy target artifact or enchantment.');
const mindRot = () => spell('Mind Rot', '{2}{B}', 3, 'Sorcery', 'Target player discards two cards.');
const wastes = () => card({ name: 'Wastes', types: ['Land'], superTypes: ['Basic'], producedMana: ['C'] });
const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const wraith = () => creature('Nazgûl', '{2}{B}', 3, 1, 2, { subTypes: ['Zombie', 'Wraith', 'Knight'], keywords: ['Deathtouch'], text: 'Deathtouch' });

/** Mana of every color for `seat`: Treasures it may spend on anything. */
function treasures(t: Table, seat: number, n: number) {
  const p = t.game.players[seat];
  p.identity = [...WUBRG];
  p.treasures = n;
}

describe('the card reader reads these commanders whole', () => {
  it('leaves no line of them unread', () => {
    for (const c of [sigurd(), fblthp(), ultima(), zur(), lordOfTheNazgul(), orvar(), ygra(), lynde()]) expect(c.unread, c.name).toBeUndefined();
    expect(fblthp().effects.filter((e) => e.kind === 'draw')).toHaveLength(1);
    expect(sigurd().effects.find((e) => e.kind === 'lore')?.activation?.boast).toBe(true);
  });

  it('reads Curses as abilities about the enchanted player', () => {
    expect(opulence().curse).toEqual([{ on: 'attacked', act: 'gold', n: 1 }]);
    expect(scarabs().curse).toEqual([{ on: 'theirUpkeep', act: 'torment', n: 3 }]);
    expect(deathsHold().curse).toEqual([{ on: 'static', act: 'shrink', n: 1 }]);
    expect(bloodletting().unread).toBeUndefined();
  });
});

describe('Sigurd, Jarl of Ravensthorpe', () => {
  it('can boast only after attacking, once a turn, and each lore counter grows another creature', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    const jarl = t.game.put(0, sigurd());
    const bear = t.game.put(0, bears());
    const story = t.game.put(0, saga());
    story.lore = 0;
    const boastIndex = (d: { actions: { type: string; effect?: { kind: string } }[] }) => d.actions.findIndex((x) => x.type === 'activate' && x.effect?.kind === 'lore');
    // Not before it attacked.
    expect(t.game.legalActions(a).some((x) => x.type === 'activate' && x.effect.kind === 'lore')).toBe(false);
    t.handlers[0] = (g, d) => {
      if (d.kind === 'attackers') return [{ attacker: jarl.id, defender: 1 }];
      if (d.kind === 'priority' && g.step === 'main2' && boastIndex(d) !== -1) return { action: boastIndex(d) };
      if (d.kind === 'choose' && d.reason === 'counters') return [d.options.findIndex((o) => o.permId === bear.id)];
      return undefined;
    };
    t.until((g) => g.log!.some((l) => /activates Sigurd/.test(l)) && g.stack.length === 0);
    const boasted = t.game.turnNumber;
    t.until((g) => g.turnNumber !== boasted);
    expect(t.game.log!.filter((l) => /activates Sigurd/.test(l))).toHaveLength(1);
    // Every lore counter (the turn's own and the boast's) put a +1/+1 counter on the bear.
    expect(story.lore).toBeGreaterThanOrEqual(2);
    expect(bear.counters).toBe(story.lore);
  });
});

describe('Fblthp, the Lost', () => {
  it('draws one card, and a spell aimed at it finds it gone', () => {
    expect(fblthp().effects.find((e) => e.kind === 'draw')).toMatchObject({ n: 1 });
    const t = new Table();
    const [a, b] = t.game.players;
    const lost = t.game.put(1, fblthp());
    treasures(t, 0, 3);
    a.hand.push(murder());
    const cast = castOnce('Murder');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: lost.id } : cast(g, d));
    t.until((g) => g.log!.some((l) => /Murder has no legal target/.test(l)));
    expect(b.library.map((c) => c.name)).toContain('Fblthp, the Lost');
    expect(b.graveyard.map((c) => c.name)).not.toContain('Fblthp, the Lost');
    expect(t.game.log!.some((l) => /Murder has no legal target/.test(l))).toBe(true);
  });
});

describe('Ultima, Origin of Oblivion', () => {
  it('blights a land when it attacks, and doubles lands that tap for {C}', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    const god = t.game.put(0, ultima());
    t.game.put(0, wastes());
    t.game.put(0, wastes());
    expect(t.game.availableMana(a)).toBe(4);
    const theirs = t.game.put(1, forest());
    expect([...t.game.colorsAvailable(b)]).toContain('G');
    t.handlers[0] = (_g, d) => (d.kind === 'attackers' ? [{ attacker: god.id, defender: 1 }] : d.kind === 'target' ? { kind: 'perm', id: theirs.id } : undefined);
    t.finishTurn();
    expect(theirs.landInfo?.produces).toEqual(['C']);
    expect([...t.game.colorsAvailable(b)]).not.toContain('G');
    // The blight stays (no one removes the counter).
    t.finishTurn();
    expect(theirs.landInfo?.produces).toEqual(['C']);
  });
});

const forest = () => card({ name: 'Forest', types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], colorIdentity: ['G'] });

describe('Zur, Eternal Schemer', () => {
  it('turns an enchantment into a creature as big as its mana value, with deathtouch, lifelink and hexproof', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(0, zur());
    const prop = t.game.put(0, propaganda());
    treasures(t, 0, 2);
    t.handlers[0] = (_g, d) => (d.kind === 'priority' ? (() => { const i = d.actions.findIndex((x) => x.type === 'activate' && x.effect.kind === 'animate'); return i === -1 ? undefined : { action: i }; })() : undefined);
    t.until(() => prop.card.isCreature && t.game.stack.length === 0);
    expect(t.game.power(prop)).toBe(3);
    expect(t.game.toughness(prop)).toBe(3);
    expect(t.game.hasKw(prop, 'deathtouch')).toBe(true);
    expect(t.game.hasKw(prop, 'hexproof')).toBe(true);
    // Still Propaganda underneath: an attack tax for opponents, and the real card if it dies.
    expect(prop.card.effects.some((e) => e.kind === 'attackTax')).toBe(true);
    prop.damage = 3;
    t.finishTurn();
    expect(a.graveyard.find((c) => c.name === 'Propaganda')?.isCreature).toBe(false);
  });

  it('the bot animates its biggest enchantment before combat', () => {
    const t = new Table();
    const bot = new Bot(0, 1);
    t.game.put(0, zur());
    const prop = t.game.put(0, propaganda());
    treasures(t, 0, 2);
    t.handlers[0] = (g, d) => (d.kind === 'priority' && g.step === 'main1' ? bot.decide(g, d) : undefined);
    t.until((g) => g.step !== 'main1' && g.step !== 'untap' && g.step !== 'upkeep' && g.step !== 'draw');
    expect(prop.card.isCreature).toBe(true);
  });
});

describe('Lord of the Nazgûl', () => {
  it('Wraiths can’t be blocked by a ring-bearer', () => {
    const t = new Table();
    const [, b] = t.game.players;
    t.game.put(0, lordOfTheNazgul());
    const w = t.game.put(0, wraith());
    const bearer = t.game.put(1, bears());
    const other = t.game.put(1, bears());
    b.ringBearer = bearer.id;
    b.ringLevel = 1;
    w.attacking = 1;
    expect(t.game.canBlock(bearer, w)).toBe(false);
    expect(t.game.canBlock(other, w)).toBe(true);
    expect(t.game.protectedFrom(w, bearer)).toBe(true);
  });
});

describe('Orvar, the All-Form', () => {
  it('discarded by an opponent, it copies a permanent', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    treasures(t, 0, 3);
    a.hand.push(mindRot());
    b.hand.push(orvar(), bears());
    const angel = t.game.put(0, creature('Serra Angel', '{3}{W}{W}', 5, 4, 4, { keywords: ['Flying', 'Vigilance'], text: 'Flying, vigilance' }));
    const cast = castOnce('Mind Rot');
    t.handlers[0] = (g, d) => (d.kind === 'target' && d.candidates.some((c) => c.kind === 'player') ? { kind: 'player', seat: 1 } : cast(g, d));
    t.handlers[1] = (_g, d) => (d.kind === 'choose' && d.reason === 'clone' ? [d.options.findIndex((o) => o.permId === angel.id)] : undefined);
    t.until((g) => b.hand.length === 0 && g.stack.length === 0 && b.battlefield.length > 0);
    expect(b.battlefield.map((q) => q.card.name)).toContain('Serra Angel');
    expect(b.battlefield.find((q) => q.card.name === 'Serra Angel')?.token).toBe(true);
  });
});

describe('Ygra, Eater of All', () => {
  it('makes every other creature a Food that gains 3 life and feeds Ygra', () => {
    const t = new Table();
    const [a] = t.game.players;
    const cat = t.game.put(0, ygra());
    const bear = t.game.put(0, bears());
    t.lands(0, 2);
    const food = t.game.legalActions(a).find((x) => x.type === 'activate' && x.effect === FOOD);
    expect(food && food.type === 'activate' && food.permId).toBe(bear.id);
    expect(t.game.legalActions(a).some((x) => x.type === 'activate' && x.effect === FOOD && x.permId === cat.id)).toBe(false);
    t.handlers[0] = (_g, d) => (d.kind === 'priority' ? (() => { const i = d.actions.findIndex((x) => x.type === 'activate' && x.effect === FOOD); return i === -1 ? undefined : { action: i }; })() : undefined);
    t.until((g) => !a.battlefield.includes(bear) && g.stack.length === 0);
    expect(a.life).toBe(43);
    expect(cat.counters).toBe(2);
  });

  it('lets artifact removal hit creatures', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(1, ygra());
    const bear = t.game.put(1, bears());
    t.lands(0, 2);
    a.hand.push(naturalize());
    expect(find(t.game.legalActions(a), 'cast', 'Naturalize')).not.toBe(-1);
    const cast = castOnce('Naturalize');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: bear.id } : cast(g, d));
    t.until((g) => !t.game.players[1].battlefield.includes(bear) && g.stack.length === 0);
    expect(t.game.players[1].graveyard.map((c) => c.name)).toContain('Grizzly Bears');
  });
});

describe('Curses', () => {
  it('Curse of Opulence pays its controller and each attacker', () => {
    const t = new Table(3);
    const [a, b] = t.game.players;
    treasures(t, 0, 1);
    a.hand.push(opulence());
    t.game.put(1, bears());
    const cast = castOnce('Curse of Opulence');
    t.handlers[0] = (g, d) => (d.kind === 'target' && d.candidates.every((c) => c.kind === 'player') ? { kind: 'player', seat: 2 } : cast(g, d));
    // Seat 1 attacks the cursed player: both of them get a Gold token.
    t.handlers[1] = attackAll(2);
    t.until(() => a.treasures > 0 && b.treasures > 0);
    expect(a.battlefield.find((q) => q.card.name === 'Curse of Opulence')?.cursing).toBe(2);
    expect(a.treasures).toBe(1);
    expect(b.treasures).toBe(1);
    expect(t.game.log!.filter((l) => /Gold token/.test(l))).toHaveLength(2);
  });

  it('Torment of Scarabs and Curse of Death’s Hold hurt the enchanted player', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    treasures(t, 0, 9);
    a.hand.push(scarabs(), deathsHold());
    const bear = t.game.put(1, bears());
    t.handlers[0] = (_g, d) => {
      if (d.kind === 'target') return { kind: 'player', seat: 1 };
      if (d.kind !== 'priority') return undefined;
      const i = d.actions.findIndex((x) => x.type === 'cast' && x.card.curse);
      return i === -1 ? undefined : { action: i };
    };
    // Their upkeep: the scripted player takes the first option, losing 3 life.
    let shrunk = false;
    t.until((g) => {
      if (a.battlefield.filter((q) => q.cursing === 1).length === 2) shrunk ||= g.power(bear) === 1 && g.toughness(bear) === 1;
      return b.life < 40;
    });
    expect(shrunk).toBe(true);
    expect(b.life).toBe(37);
  });

  it('Curse of Bloodletting doubles combat damage', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    treasures(t, 0, 5);
    a.hand.push(bloodletting());
    const bear = t.game.put(0, bears());
    const cast = castOnce('Curse of Bloodletting');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'player', seat: 1 } : d.kind === 'attackers' ? [{ attacker: bear.id, defender: 1 }] : cast(g, d));
    t.finishTurn();
    expect(b.life).toBe(36);
  });

  it('a Curse on a player who left goes to the graveyard, and Lynde brings it back on herself, then passes it on', () => {
    const t = new Table(3);
    const [a, , c] = t.game.players;
    t.game.put(0, lynde());
    treasures(t, 0, 1);
    a.hand.push(opulence());
    const cast = castOnce('Curse of Opulence');
    t.handlers[0] = (g, d) => (d.kind === 'target' && d.candidates.every((x) => x.kind === 'player') ? { kind: 'player', seat: d.prompt.startsWith('Move') ? 1 : 2 } : cast(g, d));
    t.until((g) => a.battlefield.some((q) => q.cursing === 2) && g.stack.length === 0);
    c.life = 0;
    let home = false;
    const hand = a.hand.length;
    t.until(() => {
      const back = a.battlefield.find((q) => q.card.name === 'Curse of Opulence');
      if (back?.cursing === 0) home = true;
      return back?.cursing === 1;
    });
    expect(c.alive).toBe(false);
    expect(home).toBe(true);
    expect(a.battlefield.find((q) => q.card.name === 'Curse of Opulence')?.cursing).toBe(1);
    expect(t.game.log!.some((l) => /Curse of Opulence returns to the battlefield attached to/.test(l))).toBe(true);
    expect(a.hand.length).toBeGreaterThanOrEqual(hand + 2);
  });
});
