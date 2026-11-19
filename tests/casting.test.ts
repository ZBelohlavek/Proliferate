// Alternative ways to cast spells (foretell, suspend, plot, spree, channel, madness, buyback, casualty, impending,
// blitz, ...) and "as though it had flash". The cards use their real oracle text with green mana costs, since the
// test table only has Forests; made-up names mark cards whose wording is a real card's with a simpler effect.

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import type { Game } from '../src/rules/game';
import type { Action } from '../src/rules/types';
import { creature, spell } from './helpers';
import { find, type Handler, Table } from './table';

const mammoth = () => creature('Battle Mammoth', '{3}{G}{G}', 5, 6, 5, { text: 'Trample\nForetell {2}{G}{G}', keywords: ['Trample', 'Foretell'] });
const vision = () => spell('Ancestral Vision', '', 0, 'Sorcery', 'Suspend 4—{G} (Rather than cast this card from your hand, pay {G} and exile it with four time counters on it. At the beginning of your upkeep, remove a time counter. When the last is removed, you may cast it without paying its mana cost.)\nTarget player draws three cards.', { keywords: ['Suspend'], colorIdentity: [] });
const plotBear = () => creature('Plotting Bear', '{3}{G}', 4, 4, 4, { text: 'Plot {1}{G} (You may pay {1}{G} and exile this card from your hand. Cast it as a sorcery on a later turn without paying its mana cost. Plot only as a sorcery.)', keywords: ['Plot'] });
const spree = () => spell('Spree Growth', '{G}', 1, 'Instant', 'Spree (Choose one or more additional costs.)\n+ {1} — Target creature gets +2/+2 until end of turn.\n+ {2} — Draw a card.', { keywords: ['Spree'] });
const channelBear = () => creature('Channel Bear', '{3}{G}', 4, 3, 3, { text: 'Channel — {1}{G}, Discard this card: Draw two cards.', keywords: ['Channel'] });
const madBear = () => creature('Mad Bear', '{2}{G}', 3, 3, 3, { text: 'Cycling {G}\nMadness {G} (If you discard this card, discard it into exile. When you do, cast it for its madness cost or put it into your graveyard.)', keywords: ['Cycling', 'Madness'] });
const buyback = () => spell('Buyback Draw', '{2}{G}', 3, 'Instant', 'Buyback {3} (You may pay an additional {3} as you cast this spell. If you do, put this card into your hand as it resolves.)\nDraw a card.', { keywords: ['Buyback'] });
const orrery = () => spell('Vedalken Orrery', '{4}', 4, 'Artifact', 'You may cast spells as though they had flash.');
const leyline = () => spell('Leyline of Abundance', '{2}{G}{G}', 4, 'Enchantment', 'If this card is in your opening hand, you may begin the game with it on the battlefield.\nWhenever you tap a creature for mana, add an additional {G}.');
const dreadReturn = () => spell('Dread Return', '{2}{G}{G}', 4, 'Sorcery', 'Return target creature card from your graveyard to the battlefield.\nFlashback—Sacrifice three creatures. (You may cast this card from your graveyard for its flashback cost. Then exile it.)');
const casualty = () => spell('Casualty Draw', '{2}{G}', 3, 'Sorcery', 'Casualty 2 (As you cast this spell, you may sacrifice a creature with power 2 or greater. When you do, copy this spell.)\nDraw a card.', { keywords: ['Casualty'] });
const replicate = () => spell('Replicate Draw', '{G}', 1, 'Instant', 'Replicate {1}{G} (When you cast this spell, copy it for each time you paid its replicate cost.)\nDraw a card.', { keywords: ['Replicate'] });
const impending = () => creature('Impending Beast', '{3}{G}{G}', 5, 6, 6, { text: "Impending 4—{1}{G} (If you cast this spell for its impending cost, it enters with four time counters and isn't a creature until the last is removed. At the beginning of your end step, remove a time counter from it.)", keywords: ['Impending'] });
const blitz = () => creature('Blitz Brute', '{3}{G}', 4, 4, 3, { text: 'Blitz {2}{G} (If you cast this spell for its blitz cost, it gains haste and "When this creature dies, draw a card." Sacrifice it at the beginning of the next end step.)', keywords: ['Blitz'] });
const gift = () => spell('Gifted Draw', '{1}{G}', 2, 'Sorcery', 'Gift a Food (You may promise an opponent a gift as you cast this spell. If you do, they create a Food token before its other effects.)\nDraw a card. If the gift was promised, instead draw two cards.', { keywords: ['Gift'] });
const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const growth = () => spell('Giant Growth', '{G}', 1, 'Instant', 'Target creature gets +3/+3 until end of turn.');
const sorceryDraw = () => spell('Divination', '{1}{G}', 2, 'Sorcery', 'Draw two cards.');

/** Use a card from hand (`how`) the first time that's offered. */
function handUse(name: string, how: Extract<Action, { type: 'hand' }>['how']): Handler {
  let done = false;
  return (_g, d) => {
    if (done || d.kind !== 'priority') return undefined;
    const i = d.actions.findIndex((a) => a.type === 'hand' && a.card.name === name && a.how === how);
    if (i === -1) return undefined;
    done = true;
    return { action: i };
  };
}

/** Cast `name` the first time an action matching `match` is offered. */
function castWhen(name: string, match: (a: Extract<Action, { type: 'cast' }>, g: Game) => boolean): Handler {
  let done = false;
  return (g, d) => {
    if (done || d.kind !== 'priority') return undefined;
    const i = d.actions.findIndex((a) => a.type === 'cast' && a.card.name === name && match(a, g));
    if (i === -1) return undefined;
    done = true;
    return { action: i };
  };
}

const both = (...hs: Handler[]): Handler => (g, d) => {
  for (const h of hs) {
    const a = h(g, d);
    if (a !== undefined) return a;
  }
  return undefined;
};

const on = (g: Game, seat: number, name: string) => g.players[seat].battlefield.filter((q) => q.card.name === name);

describe('reading alternative casting keywords', () => {
  it('reads foretell, suspend, plot, channel, madness and spree', () => {
    expect(mammoth().casting?.foretell?.cost).toMatchObject({ generic: 2 });
    expect(vision().casting).toMatchObject({ noCost: true, suspend: { n: 4 } });
    expect(vision().effects).toMatchObject([{ kind: 'draw', n: 3 }]);
    expect(plotBear().casting?.plot).toMatchObject({ generic: 1 });
    expect(channelBear().casting?.channel?.effects).toMatchObject([{ kind: 'draw', n: 2 }]);
    expect(madBear().casting?.madness).toMatchObject({ generic: 0 });
    const s = spree();
    expect(s.effects).toEqual([]);
    expect(s.casting?.spree?.modes.map((m) => m.effects[0].kind)).toEqual(['pump', 'draw']);
    for (const c of [mammoth(), vision(), plotBear(), spree(), channelBear(), madBear()]) expect(c.unread).toBeUndefined();
  });

  it('reads optional costs that work like kicker', () => {
    expect(buyback().kicker).toMatchObject({ as: 'buyback', cost: { generic: 3 } });
    expect(casualty().kicker).toMatchObject({ as: 'casualty', casualty: 2 });
    expect(replicate().kicker).toMatchObject({ as: 'replicate', multi: true });
    expect(gift().kicker).toMatchObject({ as: 'gift', gift: 'food', effects: [{ kind: 'draw', n: 2 }] });
    expect(gift().effects).toMatchObject([{ kind: 'draw', n: 1 }]);
    expect(impending().altCost).toMatchObject({ impending: 4 });
    expect(blitz().altCost).toMatchObject({ blitz: true });
  });

  it('reads flash grants, Leylines and Dread Return', () => {
    expect(orrery().effects).toMatchObject([{ kind: 'flashGrant', what: 'all', when: 'static' }]);
    expect(leyline().casting?.leyline).toBe(true);
    expect(dreadReturn().casting?.flashbackSac).toBe(3);
    expect(dreadReturn().unread).toBeUndefined();
  });
});

describe('foretell, suspend and plot (rules 702.143, 702.62, 702.170)', () => {
  it('a foretold card is cast on a later turn for its foretell cost, not that turn', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 4);
    a.hand.push(mammoth());
    t.handlers[0] = handUse('Battle Mammoth', 'foretell');
    let sameTurn = -1;
    t.until((g, d) => {
      if (d.kind === 'priority' && d.seat === 0 && a.held?.length && sameTurn === -1) sameTurn = d.actions.findIndex((x) => x.type === 'cast' && x.from === 'foretell');
      return g.turnNumber > 1;
    });
    expect(a.held).toMatchObject([{ way: 'foretell' }]);
    expect(sameTurn).toBe(-1);
    t.handlers[0] = castWhen('Battle Mammoth', (x) => x.from === 'foretell');
    t.until((g) => g.turnNumber === 3 && g.step === 'main2');
    // Four lands pay {2}{G}{G}: the full {3}{G}{G} would need five.
    expect(on(t.game, 0, 'Battle Mammoth')).toHaveLength(1);
    expect(a.held ?? []).toHaveLength(0);
  });

  it('a card with no mana cost can only be suspended, and is cast free when the last time counter comes off', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    a.hand.push(vision());
    let castable = -2;
    t.handlers[0] = (g, d) => {
      if (d.kind === 'priority' && castable === -2) castable = find(d.actions, 'cast', 'Ancestral Vision');
      return handUse('Ancestral Vision', 'suspend')(g, d);
    };
    t.finishTurn();
    expect(castable).toBe(-1);
    expect(a.held).toMatchObject([{ way: 'suspend', time: 4 }]);
    // Seat 0's upkeeps on turns 3, 5, 7 and 9 take the four counters off.
    const before = a.hand.length;
    t.handlers[0] = (_g, d) => (d.kind === 'target' ? d.candidates.find((c) => c.kind === 'player' && c.seat === 0) : undefined);
    t.until((g) => g.turnNumber === 7 && g.step === 'main1');
    expect(a.held?.[0]?.time).toBe(1);
    t.until((g) => g.turnNumber === 9 && g.step === 'main1');
    expect(a.held ?? []).toHaveLength(0);
    // Three from Ancestral Vision plus the draw steps of turns 3, 5, 7 and 9.
    expect(a.hand.length).toBe(before + 3 + 4);
    expect(a.graveyard.some((c) => c.name === 'Ancestral Vision')).toBe(true);
  });

  it('a plotted card is cast free on a later turn, as a sorcery', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    a.hand.push(plotBear());
    t.handlers[0] = handUse('Plotting Bear', 'plot');
    t.finishTurn();
    expect(a.held).toMatchObject([{ way: 'plot' }]);
    t.handlers[0] = castWhen('Plotting Bear', (x) => x.from === 'plot');
    t.until((g) => g.turnNumber === 3 && g.step === 'main2');
    expect(on(t.game, 0, 'Plotting Bear')).toHaveLength(1);
    // Free: both lands still untapped after casting it.
    expect(a.battlefield.filter((q) => q.landInfo && q.tapped)).toHaveLength(0);
  });
});

describe('spree, channel and madness', () => {
  it('spree pays for each chosen mode', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 4);
    t.game.put(0, bears());
    a.hand.push(spree());
    const hand = a.hand.length;
    let offered: number[] = [];
    t.handlers[0] = (g, d) => {
      if (d.kind === 'priority' && !offered.length) offered = d.actions.flatMap((x) => (x.type === 'cast' && x.card.name === 'Spree Growth' ? [x.modes ?? 0] : []));
      return castWhen('Spree Growth', (x) => x.modes === 3)(g, d);
    };
    t.until((g) => g.stack.length === 0 && on(g, 0, 'Grizzly Bears')[0] && g.power(on(g, 0, 'Grizzly Bears')[0]) === 4);
    // Both modes: {G} + {1} + {2} = four lands.
    expect(offered.sort()).toEqual([1, 2, 3]);
    expect(a.hand.length).toBe(hand - 1 + 1);
    expect(a.battlefield.filter((q) => q.landInfo && !q.tapped)).toHaveLength(0);
  });

  it('channel discards the card for its effect', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    a.hand.push(channelBear());
    t.handlers[0] = handUse('Channel Bear', 'channel');
    t.until((g) => g.stack.length === 0 && a.graveyard.some((c) => c.name === 'Channel Bear'));
    expect(a.hand).toHaveLength(2);
  });

  it('a madness card discarded by cycling it can be cast for its madness cost', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    a.hand.push(madBear());
    t.handlers[0] = both((_g, d) => (d.kind === 'priority' && a.hand.some((c) => c.name === 'Mad Bear') ? { action: find(d.actions, 'cycle', 'Mad Bear') } : undefined), castWhen('Mad Bear', (x) => x.from === 'madness'));
    t.until((g) => g.stack.length === 0 && on(g, 0, 'Mad Bear').length === 1);
    expect(on(t.game, 0, 'Mad Bear')).toHaveLength(1);
    expect(a.hand).toHaveLength(1);
  });

  it('a madness card that isn\'t cast goes to the graveyard', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    a.hand.push(madBear());
    t.handlers[0] = (_g, d) => (d.kind === 'priority' && a.hand.some((c) => c.name === 'Mad Bear') ? { action: find(d.actions, 'cycle', 'Mad Bear') } : undefined);
    t.finishTurn();
    expect(a.graveyard.some((c) => c.name === 'Mad Bear')).toBe(true);
    expect(a.exile.some((c) => c.name === 'Mad Bear')).toBe(false);
  });
});

describe('optional costs like kicker', () => {
  it('buyback returns the spell to its owner\'s hand', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 6);
    a.hand.push(buyback());
    t.handlers[0] = castWhen('Buyback Draw', (x) => x.kick === 1);
    t.until((g) => g.stack.length === 0 && a.hand.length === 2);
    expect(a.hand.some((c) => c.name === 'Buyback Draw')).toBe(true);
    expect(a.graveyard.some((c) => c.name === 'Buyback Draw')).toBe(false);
  });

  it('casualty sacrifices a creature with enough power and copies the spell', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    t.game.put(0, bears());
    a.hand.push(casualty());
    t.handlers[0] = castWhen('Casualty Draw', (x) => x.kick === 1);
    t.until((g) => g.stack.length === 0 && a.hand.length === 2);
    expect(on(t.game, 0, 'Grizzly Bears')).toHaveLength(0);
    expect(a.hand).toHaveLength(2);
  });

  it('replicate copies the spell once for each time it was paid', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 5);
    a.hand.push(replicate());
    t.handlers[0] = castWhen('Replicate Draw', (x) => x.kick === 2);
    t.until((g) => g.stack.length === 0 && a.hand.length === 3);
    expect(a.hand).toHaveLength(3);
  });

  it('a promised gift gives the opponent a Food (as 3 life) and the spell its better effect', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    a.hand.push(gift());
    t.handlers[0] = castWhen('Gifted Draw', (x) => x.kick === 1);
    t.until((g) => g.stack.length === 0 && a.hand.length === 2);
    expect(a.hand).toHaveLength(2);
    expect(b.life).toBe(43);
  });
});

describe('alternative costs', () => {
  it('impending: enters with time counters as a non-creature, which come off at our end step', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    a.hand.push(impending());
    t.handlers[0] = castWhen('Impending Beast', (x) => x.from === 'alt');
    t.until((g) => g.stack.length === 0 && on(g, 0, 'Impending Beast').length === 1);
    const [q] = on(t.game, 0, 'Impending Beast');
    expect(q.card.isCreature).toBe(false);
    expect(q.impending).toBeLessThanOrEqual(4);
    expect(t.game.log!.some((l) => /Impending Beast/.test(l) && /impending/i.test(l))).toBe(true);
    t.until((g) => g.turnNumber === 9);
    // Four of our end steps (turns 1, 3, 5, 7): the counters are gone and it's a 6/6 creature again.
    expect(q.impending).toBeUndefined();
    expect(q.card.isCreature).toBe(true);
    expect(t.game.power(q)).toBe(6);
  });

  it('blitz: haste, sacrificed at the end step, and a card when it dies', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    a.hand.push(blitz());
    t.handlers[0] = both(castWhen('Blitz Brute', (x) => x.from === 'alt'), (_g, d) => (d.kind === 'attackers' ? d.candidates.map((attacker) => ({ attacker, defender: 1 })) : undefined));
    t.finishTurn();
    expect(b.life).toBe(36);
    expect(a.graveyard.some((c) => c.name === 'Blitz Brute')).toBe(true);
    expect(a.hand).toHaveLength(1 + 0);
  });

  it('Dread Return\'s flashback sacrifices three creatures', () => {
    const t = new Table();
    const [a] = t.game.players;
    for (let i = 0; i < 3; i++) t.game.put(0, bears());
    a.graveyard.push(dreadReturn(), mammoth());
    t.handlers[0] = castWhen('Dread Return', (x) => x.from === 'graveyard');
    t.until((g) => g.stack.length === 0 && on(g, 0, 'Battle Mammoth').length === 1);
    expect(on(t.game, 0, 'Grizzly Bears')).toHaveLength(0);
    expect(a.exile.some((c) => c.name === 'Dread Return')).toBe(true);
  });
});

describe('casting as though it had flash', () => {
  it('Vedalken Orrery lets a sorcery be cast on an opponent\'s turn', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    a.hand.push(sorceryDraw());
    // Without it, seat 0 is never offered Divination on seat 1's turn.
    let without = -1;
    t.finishTurn();
    t.until((g, d) => {
      if (d.kind === 'priority' && d.seat === 0 && g.activeSeat === 1 && without === -1) without = find(d.actions, 'cast', 'Divination');
      return g.activeSeat === 0;
    });
    expect(without).toBe(-1);
    t.game.put(0, orrery());
    let withOrrery = -2;
    t.until((g, d) => {
      if (g.activeSeat === 1 && d.kind === 'priority' && d.seat === 0) {
        withOrrery = find(d.actions, 'cast', 'Divination');
        return withOrrery !== -1;
      }
      return g.activeSeat === 0;
    });
    expect(withOrrery).not.toBe(-1);
  });

  it('a Leyline in the opening hand starts on the battlefield', () => {
    // Leylines are checked against the hands dealt at the start of the game; check the rule directly.
    const t = new Table();
    const [a] = t.game.players;
    a.hand.push(leyline(), growth());
    (t.game as unknown as { beginWithLeylines(p: typeof a): void }).beginWithLeylines(a);
    expect(on(t.game, 0, 'Leyline of Abundance')).toHaveLength(1);
    expect(a.hand.map((c) => c.name)).toEqual(['Giant Growth']);
  });
});

describe('the bot', () => {
  it('suspends a card with no mana cost and casts a madness card it discarded', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    a.hand.push(vision(), madBear());
    const bot = new Bot(0, 1);
    t.handlers[0] = (g, d) => {
      // Cycle the madness card ourselves; everything else is the bot's call.
      if (d.kind === 'priority' && a.hand.some((c) => c.name === 'Mad Bear')) {
        const i = find(d.actions, 'cycle', 'Mad Bear');
        if (i !== -1) return { action: i };
      }
      return bot.decide(g, d);
    };
    t.until((g) => g.turnNumber > 1);
    expect(a.held).toMatchObject([{ card: { name: 'Ancestral Vision' }, way: 'suspend' }]);
    expect(on(t.game, 0, 'Mad Bear')).toHaveLength(1);
  });
});
