// Kicker, multikicker, offspring, "becomes the target" triggers and Midnight Clock.
// The cards use their real oracle text, with green mana costs since the test
// table only has Forests.

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import type { Game } from '../src/rules/game';
import type { Decision, Target } from '../src/rules/types';
import { card, creature, spell } from './helpers';
import { castOnce, find, type Handler, Table } from './table';

const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const cacophony = () => spell('Maddening Cacophony', '{1}{G}', 2, 'Sorcery', 'Kicker {3}{G}\nEach opponent mills eight cards. If this spell was kicked, instead each opponent mills half their library, rounded up.');
const chalice = () => spell('Everflowing Chalice', '{0}', 0, 'Artifact', 'Multikicker {2} (You may pay an additional {2} any number of times as you cast this spell.)\nThis artifact enters with a charge counter on it for each time it was kicked.\n{T}: Add {C} for each charge counter on this artifact.');
const cometStorm = () => spell('Comet Storm', '{X}{G}{G}', 2, 'Instant', 'Multikicker {1} (You may pay an additional {1} any number of times as you cast this spell.)\nChoose any target, then choose another target for each time this spell was kicked. Comet Storm deals X damage to each of them.');
const skydiver = () => creature('Thieving Skydiver', '{1}{G}', 2, 2, 1, { text: "Kicker {X}. X can't be 0. (You may pay an additional {X} as you cast this spell.)\nFlying\nWhen this creature enters, if it was kicked, gain control of target artifact with mana value X or less. If that artifact is an Equipment, attach it to this creature.", keywords: ['Flying', 'Kicker'] });
const relic = () => spell('Skyclave Relic', '{3}', 3, 'Artifact', 'Kicker {3}\nIndestructible\nWhen this artifact enters, if it was kicked, create two tapped tokens that are copies of this artifact.\n{T}: Add one mana of any color.', { keywords: ['Kicker', 'Indestructible'] });
const solRing = () => spell('Sol Ring', '{1}', 1, 'Artifact', '{T}: Add {C}{C}.');
const thornplate = () => creature('Thornplate Intimidator', '{3}{G}', 4, 4, 3, { text: 'Offspring {3} (You may pay an additional {3} as you cast this spell. If you do, when this creature enters, create a 1/1 token copy of it.)\nWhen this creature enters, target opponent loses 3 life unless they sacrifice a nonland permanent of their choice or discard a card.', keywords: ['Offspring'] });
const vinelasher = () => creature('Iridescent Vinelasher', '{G}', 1, 1, 2, { text: 'Offspring {2} (You may pay an additional {2} as you cast this spell. If you do, when this creature enters, create a 1/1 token copy of it.)\nLandfall — Whenever a land you control enters, this creature deals 1 damage to target opponent.', keywords: ['Offspring'] });
const giantGrowth = () => spell('Giant Growth', '{G}', 1, 'Instant', 'Target creature gets +3/+3 until end of turn.');
const murder = () => spell('Murder', '{1}{G}{G}', 3, 'Instant', 'Destroy target creature.');
const fblthp = () => creature('Fblthp, the Lost', '{1}{G}', 2, 1, 1, { superTypes: ['Legendary'], text: 'When Fblthp enters, draw a card. If it entered from your library or was cast from your library, draw two cards instead.\nWhen Fblthp becomes the target of a spell, shuffle Fblthp into its owner\'s library.' });
const goldspan = () => creature('Goldspan Dragon', '{3}{G}{G}', 5, 4, 4, { text: 'Flying, haste\nWhenever this creature attacks or becomes the target of a spell, create a Treasure token.\nTreasures you control have "{T}, Sacrifice this artifact: Add two mana of any one color."', keywords: ['Flying', 'Haste'] });
const heartfire = () => creature('Heartfire Hero', '{G}', 1, 1, 1, { text: 'Valiant — Whenever this creature becomes the target of a spell or ability you control for the first time each turn, put a +1/+1 counter on it.\nWhen this creature dies, it deals damage equal to its power to each opponent.' });
const image = () => creature('Phantasmal Image', '{1}{G}', 2, 0, 0, { text: 'You may have this creature enter as a copy of any creature on the battlefield, except it\'s an Illusion in addition to its other types and it has "When this creature becomes the target of a spell or ability, sacrifice it."' });
const mammoth = () => creature('Battle Mammoth', '{3}{G}{G}', 5, 6, 5, { text: 'Trample\nWhenever a permanent you control becomes the target of a spell or ability an opponent controls, you may draw a card.\nForetell {2}{G}{G}', keywords: ['Trample', 'Foretell'] });
const stormchaser = () => creature('Stormchaser Drake', '{1}{G}', 2, 2, 1, { text: 'Flying\nWhenever this creature becomes the target of a spell you control, draw a card.', keywords: ['Flying'] });
const nadu = () => creature('Nadu, Winged Wisdom', '{1}{G}{G}', 3, 3, 4, { superTypes: ['Legendary'], text: 'Flying\nCreatures you control have "Whenever this creature becomes the target of a spell or ability, reveal the top card of your library. If it\'s a land card, put it onto the battlefield. Otherwise, put it into your hand. This ability triggers only twice each turn."', keywords: ['Flying'] });
const shovel = () => spell('Shovel', '{0}', 0, 'Artifact — Equipment', 'Equipped creature gets +1/+0.\nEquip {0}');
const clock = () => spell('Midnight Clock', '{2}{G}', 3, 'Artifact', '{T}: Add {G}.\n{2}{G}: Put an hour counter on this artifact.\nAt the beginning of each upkeep, put an hour counter on this artifact.\nWhen the twelfth hour counter is put on this artifact, shuffle your hand and graveyard into your library, then draw seven cards. Exile Midnight Clock.');

/** Cast `name` the first time it can be cast kicked `kicks` times (with X = `x`). */
function castKicked(name: string, kicks: number, x = 0): Handler {
  let done = false;
  return (_g, d) => {
    if (done || d.kind !== 'priority') return undefined;
    const i = d.actions.findIndex((a) => a.type === 'cast' && a.card.name === name && (a.kick ?? 0) === kicks);
    if (i === -1) return undefined;
    done = true;
    return { action: i, x };
  };
}

/** Aim at the permanent named `name` (or the player in `seat`) whenever asked for a target. */
function aimAt(name: string | number): Handler {
  return (g, d) => {
    if (d.kind !== 'target') return undefined;
    const hit = d.candidates.find((t) => (typeof name === 'number' ? t.kind === 'player' && t.seat === name : t.kind === 'perm' && g.findPerm(t.id)?.card.name === name));
    return hit ?? undefined;
  };
}

const both = (...hs: Handler[]): Handler => (g, d) => {
  for (const h of hs) {
    const a = h(g, d);
    if (a !== undefined) return a;
  }
  return undefined;
};

describe('reading kicker, multikicker and offspring', () => {
  it('reads the unkicked card as its effects and the kicked version as kicker.effects', () => {
    const c = cacophony();
    expect(c.effects).toMatchObject([{ kind: 'mill', n: 8, who: 'opponents' }]);
    expect(c.kicker).toMatchObject({ cost: { generic: 3 }, effects: [{ kind: 'mill', n: -2 }] });
    expect(c.unread).toBeUndefined();
    const s = skydiver();
    expect(s.effects).toEqual([]);
    expect(s.kicker).toMatchObject({ cost: { x: 1 }, effects: [{ kind: 'steal', what: 'artifact', maxCmc: -1 }] });
    expect(s.unread).toBeUndefined();
    expect(chalice().kicker).toMatchObject({ multi: true });
    expect(chalice().kicker).toMatchObject({ charge: true });
    expect(chalice().charge).toBe(0);
    expect(chalice().unread).toBeUndefined();
    expect(cometStorm().kicker?.effects.filter((e) => e.perKick)).toHaveLength(1);
    expect(thornplate().kicker).toMatchObject({ offspring: true, cost: { generic: 3 } });
    expect(thornplate().kicker?.effects.some((e) => e.kind === 'copySelf' && e.size === 1)).toBe(true);
    expect(relic().kicker?.effects).toContainEqual(expect.objectContaining({ kind: 'copySelf', n: 2, tapped: true }));
  });

  it('reads "becomes the target" triggers and Midnight Clock', () => {
    expect(goldspan().effects.filter((e) => e.kind === 'treasure').map((e) => e.when)).toEqual(['attack', 'targeted']);
    expect(heartfire().effects).toContainEqual(expect.objectContaining({ kind: 'counters', when: 'targeted', targetedBy: 'you', oncePerTurn: true }));
    expect(mammoth().effects).toContainEqual(expect.objectContaining({ kind: 'draw', when: 'targeted', scope: 'any', targetedBy: 'opponents' }));
    expect(nadu().effects).toEqual([expect.objectContaining({ kind: 'revealTop', when: 'targeted', scope: 'any', perTurn: 2 })]);
    expect(image().effects).toMatchObject([{ kind: 'clone', fragile: true }]);
    const c = clock();
    expect(c.effects.map((e) => `${e.kind}/${e.when}`)).toEqual(['mana/static', 'hours/activated', 'hours/eachUpkeep', 'wheel/hourTwelve']);
    expect(c.unread).toBeUndefined();
  });
});

describe('kicker in play (rule 702.33)', () => {
  it('offers the kicked version only when the extra cost can be paid', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    a.hand.push(cacophony());
    let kicked = -2;
    t.until((_g, d) => {
      if (d.kind !== 'priority' || d.seat !== 0) return false;
      kicked = d.actions.findIndex((x) => x.type === 'cast' && !!x.kick);
      return find(d.actions, 'cast', 'Maddening Cacophony') !== -1;
    });
    expect(kicked).toBe(-1);
  });

  it('Maddening Cacophony kicked mills half of each opponent\'s library instead of eight', () => {
    const t = new Table(3);
    const [a, b, c] = t.game.players;
    t.lands(0, 6);
    a.hand.push(cacophony());
    const libB = b.library.length;
    const libC = c.library.length;
    t.handlers[0] = castKicked('Maddening Cacophony', 1);
    t.finishTurn();
    expect(b.graveyard.length).toBe(Math.ceil(libB / 2));
    expect(c.graveyard.length).toBe(Math.ceil(libC / 2));
    expect(t.game.log!.some((l) => /casts Maddening Cacophony kicked/.test(l))).toBe(true);
  });

  it('Maddening Cacophony unkicked mills eight', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 6);
    a.hand.push(cacophony());
    t.handlers[0] = castKicked('Maddening Cacophony', 0);
    t.finishTurn();
    expect(b.graveyard.length).toBe(8);
  });

  it('Everflowing Chalice taps for one mana for each time it was kicked, and for nothing unkicked (rule 702.33c)', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 4);
    a.hand.push(chalice(), chalice());
    t.handlers[0] = both(castKicked('Everflowing Chalice', 2), castKicked('Everflowing Chalice', 0));
    t.until((g) => a.battlefield.filter((q) => q.card.name === 'Everflowing Chalice').length === 2 && g.stack.length === 0);
    const [kicked, plain] = a.battlefield.filter((q) => q.card.name === 'Everflowing Chalice').sort((x, y) => (y.kicked ?? 0) - (x.kicked ?? 0));
    expect(kicked.kicked).toBe(2);
    expect(plain.kicked).toBeUndefined();
    for (const q of a.battlefield) q.tapped = q.card.name !== 'Everflowing Chalice';
    expect(t.game.availableMana(a)).toBe(2);
  });

  it('Comet Storm kicked once hits two different targets', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 6);
    t.game.put(1, bears());
    a.hand.push(cometStorm());
    const aims: Target[] = [];
    t.handlers[0] = both(castKicked('Comet Storm', 1, 3), (_g, d) => {
      if (d.kind !== 'target') return undefined;
      const pick = d.candidates.find((c) => c.kind === 'player' && c.seat === 1) ?? d.candidates.find((c) => c.kind === 'perm');
      if (pick) aims.push(pick);
      return pick;
    });
    t.finishTurn();
    expect(aims).toHaveLength(2);
    expect(b.life).toBe(37);
    expect(b.battlefield.some((q) => q.card.name === 'Grizzly Bears')).toBe(false);
  });

  it('Thieving Skydiver kicked for X takes an artifact with mana value X or less', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.game.put(1, solRing());
    a.hand.push(skydiver());
    t.handlers[0] = castKicked('Thieving Skydiver', 1, 1);
    t.finishTurn();
    expect(a.battlefield.some((q) => q.card.name === 'Sol Ring')).toBe(true);
    expect(b.battlefield.some((q) => q.card.name === 'Sol Ring')).toBe(false);
  });

  it('Skyclave Relic kicked makes two tapped token copies of itself', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 6);
    a.hand.push(relic());
    t.handlers[0] = castKicked('Skyclave Relic', 1);
    t.finishTurn();
    const relics = a.battlefield.filter((q) => q.card.name === 'Skyclave Relic');
    expect(relics).toHaveLength(3);
    expect(relics.filter((q) => q.token)).toHaveLength(2);
    // The copies aren't kicked, so they didn't make copies of their own.
    expect(relics.filter((q) => q.kicked)).toHaveLength(1);
  });

  it('a kicked permanent that dies goes to the graveyard as the plain card', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 6);
    a.hand.push(relic());
    t.handlers[0] = castKicked('Skyclave Relic', 1);
    t.finishTurn();
    const original = a.battlefield.find((q) => q.card.name === 'Skyclave Relic' && !q.token)!;
    expect(original.card.kicker).toBeDefined();
    expect(original.card.effects.some((e) => e.kind === 'copySelf')).toBe(false);
  });
});

describe('offspring (rule 702.175)', () => {
  it('makes a 1/1 token copy whose enters ability happens too', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 7);
    a.hand.push(thornplate());
    t.handlers[0] = castKicked('Thornplate Intimidator', 1);
    t.finishTurn();
    const copies = a.battlefield.filter((q) => q.card.name === 'Thornplate Intimidator');
    expect(copies).toHaveLength(2);
    const token = copies.find((q) => q.token)!;
    expect(t.game.power(token)).toBe(1);
    expect(t.game.toughness(token)).toBe(1);
    // Two enters triggers: 3 life each.
    expect(b.life).toBe(34);
  });

  it('the token copy keeps the creature\'s other abilities (Iridescent Vinelasher)', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    a.hand.push(vinelasher());
    t.handlers[0] = castKicked('Iridescent Vinelasher', 1);
    t.until(() => a.battlefield.filter((q) => q.card.name === 'Iridescent Vinelasher').length === 2);
    const life = b.life;
    t.game.put(0, card({ name: 'Forest', types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], producedMana: ['G'], colorIdentity: ['G'] }));
    expect(b.life).toBe(life);
    expect(a.battlefield.find((q) => q.token)?.card.effects.some((e) => e.when === 'landfall')).toBe(true);
  });
});

describe('"becomes the target" triggers (rule 603.2)', () => {
  it('Fblthp shuffles itself away when an opponent\'s removal spell targets it, and the spell does nothing', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.game.put(1, fblthp());
    a.hand.push(murder());
    t.handlers[0] = both(castOnce('Murder'), aimAt('Fblthp, the Lost'));
    t.finishTurn();
    expect(b.battlefield.some((q) => q.card.name === 'Fblthp, the Lost')).toBe(false);
    expect(b.graveyard.some((c) => c.name === 'Fblthp, the Lost')).toBe(false);
    expect(t.game.log!.some((l) => /Fblthp, the Lost is shuffled into [^.]*'s library/.test(l))).toBe(true);
    expect(t.game.log!.some((l) => /Murder has no legal target/.test(l))).toBe(true);
  });

  it('Goldspan Dragon makes a Treasure when a spell targets it', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    t.game.put(0, goldspan());
    a.hand.push(giantGrowth());
    t.handlers[0] = both(castOnce('Giant Growth'), aimAt('Goldspan Dragon'));
    t.until(() => a.treasures > 0);
    expect(a.treasures).toBe(1);
  });

  it('valiant (Heartfire Hero) adds a counter only the first time each turn, and only for its controller\'s spells', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    const hero = t.game.put(0, heartfire());
    a.hand.push(giantGrowth(), giantGrowth());
    t.handlers[0] = both(castOnce('Giant Growth'), aimAt('Heartfire Hero'));
    t.until((g) => g.step === 'main1' && g.stack.length === 0 && a.hand.length === 1 && hero.counters === 1);
    t.handlers[0] = both(castOnce('Giant Growth'), aimAt('Heartfire Hero'));
    t.until((g) => a.hand.length === 0 && g.stack.length === 0);
    expect(hero.counters).toBe(1);
  });

  it('Phantasmal Image is sacrificed when it becomes the target of an ability or spell', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    t.game.put(1, bears());
    a.hand.push(image(), giantGrowth());
    t.handlers[0] = both(castOnce('Phantasmal Image'), (g, d) => (d.kind === 'priority' && a.battlefield.some((q) => q.printed?.name === 'Phantasmal Image') ? castOnce('Giant Growth')(g, d) : undefined), aimAt('Grizzly Bears'));
    t.finishTurn();
    expect(a.battlefield.some((q) => q.printed?.name === 'Phantasmal Image')).toBe(false);
    expect(a.graveyard.some((c) => c.name === 'Phantasmal Image')).toBe(true);
  });

  it('Battle Mammoth draws when an opponent targets its controller\'s permanent, not when its controller does', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.game.put(1, mammoth());
    t.game.put(1, bears());
    a.hand.push(murder());
    t.handlers[0] = both(castOnce('Murder'), aimAt('Grizzly Bears'));
    t.finishTurn();
    const log = t.game.log!.join('\n');
    expect(log).toMatch(/casts Murder targeting Grizzly Bears[^\n]*\n[^\n]*\(P2\) draws 1 card\.\n[^\n]*Grizzly Bears[^\n]* is destroyed/);
    expect(b.battlefield.some((q) => q.card.name === 'Grizzly Bears')).toBe(false);
  });

  it('Stormchaser Drake draws only for its controller\'s own spells', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 1);
    t.game.put(0, stormchaser());
    t.game.put(1, stormchaser());
    a.hand.push(giantGrowth());
    t.handlers[0] = both(castOnce('Giant Growth'), aimAt('Stormchaser Drake'));
    const handB = b.hand.length;
    t.until((g) => a.hand.length === 1 && g.stack.length === 0);
    expect(a.hand.length).toBe(1);
    expect(b.hand.length).toBe(handB);
  });

  it('Nadu reveals a card each time a creature you control becomes a target, at most twice per creature each turn', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(0, nadu());
    t.game.put(0, bears());
    const eq = t.game.put(0, shovel());
    // Only Grizzly Bears is a legal equip target; equip it three times (to Nadu, then back, and so on).
    let equips = 0;
    t.handlers[0] = (g, d) => {
      if (d.kind === 'priority' && equips < 3 && g.stack.length === 0) {
        const i = d.actions.findIndex((x) => x.type === 'activate' && x.permId === eq.id);
        if (i !== -1) {
          equips++;
          return { action: i };
        }
      }
      if (d.kind === 'target') return d.candidates.find((c) => c.kind === 'perm' && g.findPerm(c.id)?.card.name === 'Grizzly Bears') ?? d.candidates[0];
      return undefined;
    };
    const before = a.hand.length + a.battlefield.length;
    t.until((g) => equips === 3 && g.stack.length === 0 && g.step === 'main1');
    t.finishTurn();
    const reveals = t.game.log!.filter((l) => /reveals/.test(l)).length;
    expect(reveals).toBeGreaterThanOrEqual(2);
    expect(reveals).toBeLessThanOrEqual(3);
    expect(a.hand.length + a.battlefield.length).toBeGreaterThan(before);
  });
});

describe('Midnight Clock', () => {
  it('gets an hour counter at every upkeep and wheels at the twelfth, then is exiled', () => {
    const t = new Table(2, { maxRounds: 30 });
    const [a] = t.game.players;
    const c = t.game.put(0, clock());
    c.hours = 10;
    a.graveyard.push(bears(), bears());
    a.hand.push(bears());
    t.finishTurn(); // seat 1's upkeep: 11
    expect(c.hours).toBe(11);
    t.finishTurn(); // seat 0's upkeep: 12, the wheel
    expect(a.battlefield.includes(c)).toBe(false);
    expect(a.exile.some((x) => x.name === 'Midnight Clock')).toBe(true);
    expect(a.graveyard.filter((x) => x.name === 'Grizzly Bears')).toHaveLength(0);
    expect(t.game.log!.some((l) => /shuffles \d+ cards? into their library and draws 7/.test(l))).toBe(true);
  });
});

describe('bots and the new mechanics', () => {
  const botTurn = (t: Table, seat: number) => {
    // No commander to spend the mana on first.
    t.game.players[seat].commandZone = [];
    const bot = new Bot(seat, 1);
    t.handlers[seat] = (g: Game, d: Decision) => bot.decide(g, d);
  };

  it('a bot kicks Maddening Cacophony when it has the mana', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 6);
    a.hand.push(cacophony());
    botTurn(t, 0);
    t.finishTurn();
    expect(t.game.log!.some((l) => /casts Maddening Cacophony kicked/.test(l))).toBe(true);
  });

  it('a bot kicks Thieving Skydiver for an artifact worth taking, and casts it plain otherwise', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    t.game.put(1, solRing());
    a.hand.push(skydiver());
    botTurn(t, 0);
    t.finishTurn();
    expect(a.battlefield.some((q) => q.card.name === 'Sol Ring')).toBe(true);

    const u = new Table();
    u.lands(0, 3);
    u.game.players[0].hand.push(skydiver());
    botTurn(u, 0);
    u.finishTurn();
    expect(u.game.log!.some((l) => /casts Thieving Skydiver\./.test(l))).toBe(true);
  });

  it('a bot pays offspring when it can, and kicks Everflowing Chalice as far as the mana goes', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 7);
    a.hand.push(thornplate());
    botTurn(t, 0);
    t.finishTurn();
    expect(a.battlefield.filter((q) => q.card.name === 'Thornplate Intimidator')).toHaveLength(2);

    const u = new Table();
    const [c] = u.game.players;
    u.lands(0, 4);
    c.hand.push(chalice());
    botTurn(u, 0);
    u.finishTurn();
    expect(c.battlefield.find((q) => q.card.name === 'Everflowing Chalice')?.kicked).toBe(2);
  });
});
