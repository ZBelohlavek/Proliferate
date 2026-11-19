// Three cards from the real decks that were read too generously and skewed bot win rates:
// Mister Negative's life swap, Mirko's power limit and Court of Vantress's monarch-only copy.

import { describe, expect, it } from 'vitest';
import { creature, spell } from './helpers';
import { castOnce, Table } from './table';

describe('win-rate misreads', () => {
  it('Mister Negative swaps life totals with the opponent highest on life and draws nothing', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 7);
    a.life = 12;
    b.life = 37;
    // A generic cost so forests can pay for it; only the enters trigger matters here.
    const neg = creature('Mister Negative', '{7}', 7, 5, 5, { keywords: ['Vigilance', 'Lifelink'], text: 'Vigilance, lifelink\nDarkforce Inversion — When Mister Negative enters, you may exchange life totals with target opponent. If you lost life this way, draw that many cards.' });
    expect(neg.unread).toBeUndefined();
    expect(neg.effects.some((e) => e.kind === 'draw')).toBe(false);
    a.hand.push(neg);
    const hand = a.hand.length;
    t.handlers[0] = castOnce('Mister Negative');
    t.until((g) => a.battlefield.some((q) => q.card.name === 'Mister Negative') && g.stack.length === 0);
    expect(a.life).toBe(37);
    expect(b.life).toBe(12);
    expect(a.hand.length).toBe(hand - 1);
  });

  it('Mirko only returns a creature with less power than Mirko, with a finality counter', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(0, creature('Mirko, Obsessive Theorist', '{1}{U}{B}', 3, 1, 3, { keywords: ['Flying', 'Vigilance'], text: "Flying, vigilance\nWhenever you surveil, put a +1/+1 counter on Mirko.\nAt the beginning of your end step, you may return target creature card with power less than Mirko's from your graveyard to the battlefield with a finality counter on it. (If it would die, exile it instead.)" }));
    const big = creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);
    const small = creature('Ornithopter', '{0}', 0, 0, 2, { keywords: ['Flying'], text: 'Flying' });
    a.graveyard.push(big, small);
    t.finishTurn();
    t.finishTurn();
    expect(a.graveyard).toContain(big);
    const thopter = a.battlefield.find((q) => q.card.name === 'Ornithopter');
    expect(thopter).toBeDefined();
    thopter!.damage = 2;
    t.finishTurn();
    expect(a.battlefield).not.toContain(thopter);
    expect(a.graveyard.map((c) => c.name)).not.toContain('Ornithopter');
  });

  it("Court of Vantress copies an artifact only while you're the monarch", () => {
    const court = () => spell('Court of Vantress', '{2}{U}{U}', 4, 'Enchantment', "When this enchantment enters, you become the monarch.\nAt the beginning of your upkeep, choose up to one other target enchantment or artifact. If you're the monarch, you may create a token that's a copy of it. If you're not the monarch, you may have this enchantment become a copy of it, except it has this ability.");
    const rock = () => spell('Mind Stone', '{2}', 2, 'Artifact', '{T}: Add {C}.\n{1}, {T}, Sacrifice this artifact: Draw a card.');
    expect(court().effects.some((e) => e.kind === 'tokens')).toBe(false);

    const t = new Table();
    const [a, b] = t.game.players;
    t.game.put(0, court());
    t.game.put(0, rock());
    t.game.monarch = b.seat;
    t.finishTurn();
    t.finishTurn();
    expect(a.battlefield.filter((q) => q.card.name === 'Mind Stone')).toHaveLength(1);

    t.game.monarch = a.seat;
    t.finishTurn();
    t.finishTurn();
    expect(a.battlefield.filter((q) => q.card.name === 'Mind Stone').length).toBeGreaterThan(1);
  });
});

describe('turn counting', () => {
  it('counts each turn a player takes once', () => {
    const t = new Table();
    const [a] = t.game.players;
    const before = a.turnsTaken ?? 0;
    t.finishTurn();
    t.finishTurn();
    expect(a.turnsTaken).toBe(before + 1);
  });
});
