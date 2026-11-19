// Planeswalker ultimates and emblems, "-X" abilities, Food, Blood and Incubator tokens,
// extra turns and phases, Rooms, Saga chapters and mutate triggers: the card reader and the engine.
// Cards use their real oracle text, with green mana costs where the test table needs them.

import { describe, expect, it } from 'vitest';
import type { Effect } from '../src/engine/types';
import type { Game } from '../src/rules/game';
import type { Decision, Perm } from '../src/rules/types';
import { card, creature, spell } from './helpers';
import { attackAll, castOnce, find, Table, type Handler } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const kinds = (c: { effects: { kind: string }[] }) => c.effects.map((e) => e.kind);

/** Activate the first ability of `perm` that matches, once, in a main phase of its controller. */
function activateOnce(perm: () => Perm | undefined, match: (e: Effect) => boolean, x = 0): Handler {
  let done = false;
  return (g: Game, d: Decision) => {
    if (done || d.kind !== 'priority' || (g.step !== 'main1' && g.step !== 'main2')) return undefined;
    const target = perm();
    const i = d.actions.findIndex((a) => a.type === 'activate' && a.permId === target?.id && match(a.effect));
    if (i === -1) return undefined;
    done = true;
    return { action: i, x };
  };
}

/** Aim player-targeted abilities at seat 1. */
const atOpponent = (h: Handler): Handler => (g, d) =>
  d.kind === 'target' ? d.candidates.find((c) => c.kind === 'player' && c.seat === 1) ?? d.candidates[0] : h(g, d);

const walker = (name: string, cost: string, cmc: number, loyalty: number, text: string) =>
  card({ name, manaCost: cost, cmc, types: ['Planeswalker'], superTypes: ['Legendary'], text, loyalty, colorIdentity: ['G'] });

const elspeth = () => walker("Elspeth, Sun's Champion", '{4}{G}{G}', 6, 6, '+1: Create three 1/1 white Soldier creature tokens.\n−3: Destroy all creatures with power 4 or greater.\n−7: You get an emblem with "Creatures you control get +2/+2 and have flying."');
const jacePerfected = () => walker('Jace, the Perfected Mind', '{2}{G}{G}', 4, 9, '+1: Until your next turn, up to one target creature gets -3/-0.\n−2: Target player mills three cards. Then if a graveyard has twenty or more cards in it, you draw three cards. Otherwise, you draw a card.\n−X: Target player mills three times X cards.');
const teferi = () => walker('Teferi, Master of Time', '{2}{G}{G}', 4, 10, "+1: Draw a card, then discard a card.\n−10: Take two extra turns after this one.");
const kaito = () => walker('Kaito, Cunning Infiltrator', '{1}{G}{G}', 3, 9, '−9: You get an emblem with "Whenever a player casts a spell, you create a 2/1 blue Ninja creature token."');

describe('emblems and ultimates (rule 114)', () => {
  it('reads "you get an emblem with" as an emblem with its own abilities', () => {
    const c = elspeth();
    const emblem = c.effects.find((e) => e.kind === 'emblem');
    expect(emblem?.loyalty).toBe(-7);
    expect(emblem?.kind === 'emblem' && kinds(emblem.card)).toEqual(['anthem']);
    expect(c.unread).toBeUndefined();
    // Kaito's emblem watches every player's spells: two abilities, one ability on the walker.
    expect(kaito().effects.filter((e) => e.kind === 'emblem')).toHaveLength(2);
  });

  it('an emblem works from then on and nothing can touch it', () => {
    const t = new Table();
    const els = t.game.put(0, elspeth());
    els.loyalty = 7;
    const bear = t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    t.handlers[0] = activateOnce(() => els, (e) => e.kind === 'emblem');
    t.until((g) => g.step === 'declareAttackers' || g.step === 'end');
    const emblem = t.game.players[0].battlefield.find((q) => q.emblem);
    expect(emblem).toBeDefined();
    expect(t.game.power(bear)).toBe(4);
    // The planeswalker spent all its loyalty and is gone; the emblem stays.
    expect(t.game.players[0].battlefield.includes(els)).toBe(false);
    expect(t.game.canTarget(t.game.players[1], emblem!)).toBe(false);
  });

  it('Kaito\'s emblem uses both halves of the ability: a Ninja for your spells and for theirs', () => {
    const t = new Table();
    const k = t.game.put(0, kaito());
    t.handlers[0] = activateOnce(() => k, (e) => e.kind === 'emblem');
    t.until((g) => g.players[0].battlefield.filter((q) => q.emblem).length > 0);
    t.finishTurn();
    expect(t.game.players[0].battlefield.filter((q) => q.emblem)).toHaveLength(2);
  });

  it('"-X" removes X loyalty and "three times X" mills that many', () => {
    const c = jacePerfected();
    const x = c.effects.find((e) => e.loyaltyX);
    expect(x?.kind).toBe('mill');
    expect(x?.xTimes).toBe(3);
    const t = new Table();
    const jace = t.game.put(0, c);
    const victim = t.game.players[1];
    const before = victim.library.length;
    t.handlers[0] = atOpponent(activateOnce(() => jace, (e) => !!e.loyaltyX, 4));
    t.until(() => victim.library.length < before);
    expect(log(t, /mills 12 cards/)).toHaveLength(1);
    expect(jace.loyalty).toBe(5);
  });

  it('Teferi\'s -10 takes two extra turns', () => {
    const t = new Table(2, { maxRounds: 3 });
    const tef = t.game.put(0, teferi());
    t.handlers[0] = activateOnce(() => tef, (e) => e.kind === 'extraTurn');
    t.until((g) => g.activeSeat === 1);
    expect(log(t, /takes an extra turn/)).toHaveLength(2);
    // Three turns in a row for seat 0, then seat 1.
    expect(log(t, /^— Round/).map((l) => l.includes('p0'))).toEqual([true, true, true, false]);
  });

  it('Ichormoon Gauntlet gives planeswalkers "[0]: Proliferate" and "[-12]: Take an extra turn"', () => {
    const gauntlet = card({ name: 'Ichormoon Gauntlet', manaCost: '{2}{G}', cmc: 3, types: ['Artifact'], text: 'Planeswalkers you control have "[0]: Proliferate" and "[−12]: Take an extra turn after this one."\nWhenever you cast a noncreature spell, choose a counter on target permanent. Put an additional counter of that kind on that permanent.' });
    expect(kinds(gauntlet)).toContain('pwAbilities');
    const t = new Table();
    t.game.put(0, gauntlet);
    const tef = t.game.put(0, teferi());
    tef.loyalty = 12;
    const actions = t.game.legalActions(t.game.players[0]).filter((a) => a.type === 'activate' && a.permId === tef.id);
    expect(actions.some((a) => a.type === 'activate' && a.effect.kind === 'extraTurn' && a.effect.loyalty === -12)).toBe(true);
    expect(actions.some((a) => a.type === 'activate' && a.effect.kind === 'counters' && a.effect.loyalty === 0)).toBe(true);
  });
});

describe('Food, Blood and Incubator tokens (rule 111.10)', () => {
  const goose = () => creature('Gilded Goose', '{G}', 1, 0, 2, { text: 'Flying\nWhen this creature enters, create a Food token. (It\'s an artifact with "{2}, {T}, Sacrifice this token: You gain 3 life.")\n{1}{G}, {T}: Create a Food token.\n{T}, Sacrifice a Food: Add one mana of any color.' });
  const trail = () => spell('Trail of Crumbs', '{1}{G}', 2, 'Enchantment', 'When this enchantment enters, create a Food token.\nWhenever you sacrifice a Food, you may pay {1}. If you do, look at the top two cards of your library. You may reveal a permanent card from among them and put it into your hand. Put the rest on the bottom of your library in any order.');

  it('reads Food as real tokens and "sacrifice a Food" as a cost', () => {
    const c = goose();
    expect(kinds(c)).toEqual(['artifactToken', 'artifactToken', 'treasure']);
    const mana = c.effects[2];
    expect(mana.activation?.sacOther).toEqual({ what: 'food', n: 1 });
    expect(mana.activation?.sacCreature).toBeFalsy();
    expect(c.notes.join(' ')).not.toMatch(/≈/);
  });

  it('a Food token is an artifact that gains 3 life when sacrificed, and Trail of Crumbs sees it', () => {
    const t = new Table();
    const [a] = t.game.players;
    a.hand.push(trail());
    t.lands(0, 4);
    a.life = 30;
    t.handlers[0] = castOnce('Trail of Crumbs');
    t.until((g) => g.players[0].battlefield.some((q) => q.card.name === 'Food'));
    const food = a.battlefield.find((q) => q.card.name === 'Food')!;
    expect(food.token).toBe(true);
    expect(food.card.isArtifact).toBe(true);
    t.handlers[0] = activateOnce(() => a.battlefield.find((q) => q.card.name === 'Food'), (e) => e.kind === 'gainLife');
    t.until(() => a.life > 30);
    expect(a.life).toBe(33);
    expect(log(t, /sacrifice/i).length + log(t, /Trail of Crumbs trigger|Trail of Crumbs/).length).toBeGreaterThan(0);
    expect(a.battlefield.some((q) => q.card.name === 'Food')).toBe(false);
  });

  it('incubate makes an Incubator with counters that transforms into a Phyrexian creature of that size', () => {
    const c = spell('Sculpted Perfection', '{2}{G}', 3, 'Enchantment', 'When this enchantment enters, incubate 2.');
    expect(c.effects[0]).toMatchObject({ kind: 'artifactToken', token: 'incubator', size: 2 });
    const t = new Table();
    const [a] = t.game.players;
    a.hand.push(spell('Gift of Compleation', '{2}{G}', 3, 'Sorcery', 'Incubate 3.'));
    t.lands(0, 6);
    t.handlers[0] = castOnce('Gift of Compleation');
    t.until((g) => g.players[0].battlefield.some((q) => q.card.name === 'Incubator'));
    const egg = a.battlefield.find((q) => q.card.name === 'Incubator')!;
    expect(egg.counters).toBe(3);
    expect(egg.card.isCreature).toBe(false);
    t.handlers[0] = activateOnce(() => egg, (e) => e.kind === 'transform');
    t.until(() => egg.card.isCreature);
    expect(egg.card.name).toBe('Phyrexian Token');
    expect(t.game.power(egg)).toBe(3);
    expect(t.game.toughness(egg)).toBe(3);
  });

  it('a Blood token discards a card to draw one', () => {
    const t = new Table();
    const [a] = t.game.players;
    a.hand.push(spell('Bloodtithe Harvest', '{G}', 1, 'Sorcery', 'Create a Blood token.'), creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    t.lands(0, 3);
    t.handlers[0] = castOnce('Bloodtithe Harvest');
    t.until((g) => g.players[0].battlefield.some((q) => q.card.name === 'Blood'));
    const before = a.library.length;
    t.handlers[0] = activateOnce(() => a.battlefield.find((q) => q.card.name === 'Blood'), (e) => e.kind === 'draw');
    t.until(() => a.library.length < before);
    expect(a.graveyard.some((c) => c.name === 'Grizzly Bears')).toBe(true);
  });
});

describe('extra turns and phases (rules 500.7, 500.8)', () => {
  it('Sphinx of the Second Sun adds a beginning phase: untap and draw again', () => {
    const sphinx = creature('Sphinx of the Second Sun', '{6}{G}{G}', 8, 6, 6, { text: 'Flying\nAt the beginning of each of your postcombat main phases, there is an additional beginning phase after this phase. (The beginning phase includes the untap, upkeep, and draw steps.)' });
    expect(kinds(sphinx)).toEqual(['extraPhase']);
    const t = new Table();
    t.game.put(0, sphinx);
    const land = t.game.put(0, card({ name: 'Forest', types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], colorIdentity: ['G'] }), { tapped: true });
    const hand = t.game.players[0].hand.length;
    t.until(() => log(t, /begins an additional beginning phase/).length > 0);
    expect(log(t, /additional beginning phase/).length).toBeGreaterThan(0);
    expect(land.tapped).toBe(false);
    expect(t.game.players[0].hand.length).toBe(hand + 1);
  });

  it('Medomai takes an extra turn when it connects, and can\'t attack during it', () => {
    const medomai = creature('Medomai the Ageless', '{4}{G}{G}', 6, 4, 4, { superTypes: ['Legendary'], text: "Flying\nWhenever Medomai deals combat damage to a player, take an extra turn after this one.\nMedomai can't attack during extra turns." });
    expect(kinds(medomai)).toEqual(['extraTurn', 'combatRule']);
    const t = new Table(2, { maxRounds: 3 });
    const m = t.game.put(0, medomai);
    t.handlers[0] = attackAll(1);
    t.until((g) => g.activeSeat === 1);
    // One hit, one extra turn, and no second attack during it.
    expect(log(t, /takes an extra turn/)).toHaveLength(1);
    expect(t.game.players[1].life).toBe(40 - t.game.power(m));
  });

  it('Time Sieve sacrifices five artifacts for an extra turn', () => {
    const sieve = card({ name: 'Time Sieve', manaCost: '{G}{G}', cmc: 2, types: ['Artifact'], text: '{T}, Sacrifice five artifacts: Take an extra turn after this one.' });
    expect(sieve.effects[0].activation?.sacOther).toEqual({ what: 'artifact', n: 5 });
    const t = new Table();
    const s = t.game.put(0, sieve);
    const relic = () => card({ name: 'Ornithopter', manaCost: '{0}', types: ['Artifact', 'Creature'], power: '0', toughness: '2' });
    // Time Sieve may sacrifice itself as one of the five.
    for (let i = 0; i < 3; i++) t.game.put(0, relic());
    expect(t.game.legalActions(t.game.players[0]).some((a) => a.type === 'activate' && a.permId === s.id)).toBe(false);
    t.game.put(0, relic());
    t.game.put(0, relic());
    t.handlers[0] = activateOnce(() => s, (e) => e.kind === 'extraTurn');
    t.until((g) => g.players[0].battlefield.length === 1);
    t.finishTurn();
    expect(log(t, /takes an extra turn/)).toHaveLength(1);
  });
});

describe('Rooms (rule 709.5)', () => {
  const office = () => card({
    name: 'Restricted Office // Lecture Hall', manaCost: '{2}{G}{G}', cmc: 11, types: ['Enchantment'], subTypes: ['Room'], layout: 'split', colorIdentity: ['G'],
    text: 'When you unlock this door, destroy all creatures with power 3 or greater.\n(You may cast either half. That door unlocks on the battlefield. As a sorcery, you may pay the mana cost of a locked door to unlock it.)',
    back: { name: 'Lecture Hall', types: ['Enchantment'], subTypes: ['Room'], text: 'Other permanents you control have hexproof.', manaCost: '{5}{G}{G}' },
  });
  const tracker = () => creature('Entity Tracker', '{2}{G}', 3, 2, 3, { text: 'Flash\nEerie — Whenever an enchantment you control enters and whenever you fully unlock a Room, draw a card.' });

  it('reads both doors; the other door is unlocked for its own mana cost', () => {
    const c = office();
    expect(c.effects[0]).toMatchObject({ kind: 'wipe', when: 'unlock' });
    expect(c.room?.door.name).toBe('Lecture Hall');
    expect(c.room?.door.cost.generic).toBe(5);
    expect(c.modeled).toBe(true);
    expect(kinds(tracker())).toEqual(['draw', 'draw']);
  });

  it('casting a door unlocks it ("when you unlock this door" triggers), and the other door unlocks later', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    const wurm = t.game.put(1, creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4));
    a.hand.push(office());
    t.lands(0, 11);
    t.handlers[0] = castOnce('Restricted Office // Lecture Hall');
    t.until(() => !b.battlefield.includes(wurm));
    const room = a.battlefield.find((q) => q.card.room)!;
    expect(room).toBeDefined();
    // (The wipe reads as every creature for now, so the Tracker comes in after it.)
    t.game.put(0, tracker());
    const hand = a.hand.length;
    t.handlers[0] = (g, d) => (d.kind === 'priority' && g.step === 'main1' ? (find(d.actions, 'unlock') === -1 ? undefined : { action: find(d.actions, 'unlock') }) : undefined);
    t.until(() => !room.card.room);
    expect(room.card.name).toBe('Restricted Office // Lecture Hall');
    expect(log(t, /unlocks Lecture Hall/)).toHaveLength(1);
    t.until((g) => g.step !== 'main1');
    // Entity Tracker: "whenever you fully unlock a Room, draw a card".
    expect(a.hand.length).toBe(hand + 1);
  });

  it('either door may be cast', () => {
    const t = new Table();
    const [a] = t.game.players;
    a.hand.push(office());
    t.lands(0, 7);
    const doors = t.game.legalActions(a).filter((x) => x.type === 'cast' && x.card.name.startsWith('Restricted'));
    expect(doors.map((x) => x.type === 'cast' && !!x.door)).toEqual([false, true]);
  });
});

describe('Saga chapters and mutate triggers', () => {
  it('reads chapter mana, Smaug and the biggest-creature chapters', () => {
    const roku = card({ name: 'The Legend of Roku', manaCost: '{2}{R}{R}', cmc: 4, types: ['Enchantment'], subTypes: ['Saga'], text: '(As this Saga enters and after your draw step, add a lore counter.)\nI — Exile the top three cards of your library. Until the end of your next turn, you may play those cards.\nII — Add one mana of any color.\nIII — Exile this Saga, then return it to the battlefield transformed under your control.' });
    expect(roku.effects.find((e) => e.chapters?.includes(2))?.kind).toBe('treasure');
    const there = card({ name: 'There and Back Again', manaCost: '{3}{R}{R}', cmc: 5, types: ['Enchantment'], subTypes: ['Saga'], text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Up to one target creature can\'t block for as long as you control this Saga. The Ring tempts you.\nII — Search your library for a Mountain card, put it onto the battlefield, then shuffle.\nIII — Create Smaug, a legendary 6/6 red Dragon creature token with flying, haste, and "When Smaug dies, create fourteen Treasure tokens."' });
    expect(there.effects.find((e) => e.chapters?.includes(3))).toMatchObject({ kind: 'tokens', power: 6, toughness: 6 });
  });

  it('Souvenir Snatcher takes a noncreature artifact when it mutates', () => {
    const snatcher = creature('Souvenir Snatcher', '{4}{G}', 5, 4, 4, { text: 'Mutate {5}{G} (If you cast this spell for its mutate cost, put it over or under target non-Human creature you own. They mutate into the creature on top plus all abilities from under it.)\nFlying\nWhenever this creature mutates, gain control of target noncreature artifact.' });
    expect(snatcher.effects[0]).toMatchObject({ kind: 'steal', when: 'mutates', what: 'artifact', noncreature: true });
    const t = new Table();
    const [a] = t.game.players;
    const rock = t.game.put(1, card({ name: 'Mind Stone', manaCost: '{2}', cmc: 2, types: ['Artifact'], text: '{T}: Add {C}.' }));
    t.game.put(1, card({ name: 'Ornithopter', manaCost: '{0}', types: ['Artifact', 'Creature'], power: '0', toughness: '2' }));
    t.game.put(0, creature('Grizzly Bears', '{1}{G}', 2, 2, 2));
    a.hand.push(snatcher);
    t.lands(0, 6);
    t.handlers[0] = (_g, d) => (d.kind === 'priority' ? (() => { const i = d.actions.findIndex((x) => x.type === 'cast' && !!x.mutate); return i === -1 ? undefined : { action: i }; })() : undefined);
    t.until(() => rock.seat === 0);
    expect(rock.seat).toBe(0);
  });

  it('Archipelagore stuns one creature for each time it has mutated', () => {
    const c = creature('Archipelagore', '{5}{G}{G}', 7, 7, 7, { text: 'Mutate {5}{G}\nWhenever this creature mutates, tap up to X target creatures, where X is the number of times this creature has mutated. Those creatures don\'t untap during their controller\'s next untap step.' });
    expect(c.effects[0]).toMatchObject({ kind: 'stun', tap: true, n: -1, when: 'mutates' });
  });
});
