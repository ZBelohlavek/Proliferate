import { describe, expect, it } from 'vitest';
import type { SimCard, SimDeck } from '../src/engine/types';
import { Bot } from '../src/rules/bot';
import { Game } from '../src/rules/game';
import type { Answer, Decision } from '../src/rules/types';
import { card, spell, stompyDeck } from './helpers';

// Ways to win without combat: combos, alternative win conditions, mill credit, proliferating poison.

const artifact = (name: string, cost: string, cmc: number, text = '') => card({ name, manaCost: cost, cmc, types: ['Artifact'], text });
const enchantment = (name: string, cost: string, cmc: number, text = '') => card({ name, manaCost: cost, cmc, types: ['Enchantment'], text, colorIdentity: ['B'] });

const sanguineBond = () => enchantment('Sanguine Bond', '{3}{B}{B}', 5, 'Whenever you gain life, target opponent loses that much life.');
const exquisiteBlood = () => enchantment('Exquisite Blood', '{4}{B}', 5, 'Whenever an opponent loses life, you gain that much life.');
const revel = () => enchantment('Revel in Riches', '{4}{B}', 5, "Whenever a creature an opponent controls dies, create a Treasure token. (It's an artifact with \"{T}, Sacrifice this token: Add one mana of any color.\")\nAt the beginning of your upkeep, if you control ten or more Treasures, you win the game.");
const scepter = () => artifact('Isochron Scepter', '{2}', 2, 'Imprint — When this artifact enters, you may exile an instant card with mana value 2 or less from your hand.\n{2}, {T}: You may copy the exiled card. If you do, you may cast the copy without paying its mana cost.');
const reversal = () => spell('Dramatic Reversal', '{1}{U}', 2, 'Instant', 'Untap all nonland permanents you control.', { colorIdentity: ['U'] });
const solRing = () => artifact('Sol Ring', '{1}', 1, '{T}: Add {C}{C}.');
const signet = () => artifact('Arcane Signet', '{2}', 2, "{T}: Add one mana of any color in your commander's color identity.");
const shredder = () => artifact('Codex Shredder', '{1}', 1, '{T}: Target player mills a card.');

/** A stompy deck with some extra cards shuffled in, so the engine knows the seat plays them. */
function deckWith(id: string, extra: SimCard[]): SimDeck {
  const d = stompyDeck(id);
  d.cards = [...d.cards.slice(0, 1), { ...d.cards[1], count: d.cards[1].count - extra.length }, ...d.cards.slice(2), ...extra.map((c) => ({ card: c, count: 1 }))];
  return d;
}

function passer(d: Decision): Answer {
  switch (d.kind) {
    case 'priority': return { action: 0 };
    case 'target': return d.candidates[0];
    case 'attackers': return [];
    case 'blockers': return [];
    case 'choose': return d.options.slice(0, d.min).map((_, i) => i);
    case 'confirm': return d.reason === 'commandZone';
  }
}

/** A game where nobody does anything, played up to seat 0's first main phase, with empty boards and hands. */
function quietGame(decks: SimDeck[]) {
  const game = new Game(decks, 7, { log: true });
  const flow = game.run();
  let next = flow.next();
  const until = (stop: (g: Game) => boolean, answer: (d: Decision) => Answer = passer) => {
    for (let i = 0; i < 20_000 && !next.done; i++) {
      if (stop(game)) return;
      next = flow.next(answer(next.value));
    }
  };
  until((g) => g.step === 'main1');
  for (const p of game.players) {
    p.hand = [];
    p.battlefield = [];
  }
  return { game, until, done: () => !!next.done, result: () => (next.done ? next.value : null) };
}

describe('non-combat wins', () => {
  it('Sanguine Bond and Exquisite Blood together win on the spot', () => {
    const t = quietGame([deckWith('a', [sanguineBond(), exquisiteBlood()]), stompyDeck('b'), stompyDeck('c')]);
    t.game.put(0, sanguineBond());
    t.game.put(0, exquisiteBlood());
    t.until(() => false);
    const r = t.result()!;
    expect(r.winner).toBe(0);
    expect(r.eliminations.every((e) => e.reason === 'noncombat' && e.killer === 0)).toBe(true);
    expect(t.game.log!.some((l) => l.includes('Sanguine Bond loop'))).toBe(true);
  });

  it('one half of the combo alone does nothing', () => {
    const t = quietGame([deckWith('a', [sanguineBond(), exquisiteBlood()]), stompyDeck('b')]);
    t.game.put(0, sanguineBond());
    const round = t.game.round;
    t.until((g) => g.round > round + 1);
    expect(t.game.players.every((p) => p.alive)).toBe(true);
  });

  it('Revel in Riches wins at upkeep with ten Treasures', () => {
    const t = quietGame([deckWith('a', [revel()]), stompyDeck('b')]);
    t.game.put(0, revel());
    t.game.players[0].treasures = 10;
    t.until(() => false);
    expect(t.result()!.winner).toBe(0);
    expect(t.game.log!.some((l) => l.includes('wins the game (Revel in Riches)'))).toBe(true);
  });

  it("Revel in Riches makes a Treasure when an opponent's creature dies", () => {
    const t = quietGame([deckWith('a', [revel()]), stompyDeck('b')]);
    t.game.put(0, revel());
    const victim = t.game.put(1, card({ name: 'Bear', manaCost: '{1}{G}', cmc: 2, types: ['Creature'], power: '2', toughness: '2' }));
    victim.damage = 5;
    t.until((g) => g.players[0].treasures > 0 || g.round > 2);
    expect(t.game.players[0].treasures).toBe(1);
  });

  it('Isochron Scepter imprints Dramatic Reversal and, with rocks and a mill ability, mills everyone out', () => {
    const t = quietGame([deckWith('a', [scepter(), reversal(), solRing(), signet(), shredder()]), stompyDeck('b'), stompyDeck('c')]);
    for (let i = 0; i < 4; i++) t.game.put(0, card({ name: 'Island', types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], colorIdentity: ['U'] }));
    t.game.put(0, solRing());
    t.game.put(0, signet());
    t.game.put(0, shredder());
    t.game.players[0].hand = [scepter(), reversal()];
    // Cast the Scepter: it exiles Dramatic Reversal as it enters.
    let cast = false;
    t.until(
      (g) => g.players.slice(1).every((p) => p.library.length === 0) || g.round > 3,
      (d) => {
        if (!cast && d.kind === 'priority' && d.seat === 0) {
          const i = d.actions.findIndex((a) => a.type === 'cast' && a.card.name === 'Isochron Scepter');
          if (i !== -1) {
            cast = true;
            return { action: i };
          }
        }
        return passer(d);
      },
    );
    expect(t.game.imprinted.size).toBe(1);
    expect([...t.game.imprinted.values()][0].name).toBe('Dramatic Reversal');
    expect(t.game.players[1].library.length).toBe(0);
    expect(t.game.players[2].library.length).toBe(0);
    t.until(() => false);
    const r = t.result()!;
    expect(r.winner).toBe(0);
    // Running out of cards is credited to the player who milled them.
    expect(r.eliminations.every((e) => e.reason === 'decked' && e.killer === 0)).toBe(true);
  });

  it('Gray Merchant drains for devotion to black', () => {
    const merchant = card({ name: 'Gray Merchant of Asphodel', manaCost: '{3}{B}{B}', cmc: 5, types: ['Creature'], power: '2', toughness: '4', colorIdentity: ['B'],
      text: 'When this creature enters, each opponent loses X life, where X is your devotion to black. You gain life equal to the life lost this way.' });
    expect(merchant.effects[0]).toMatchObject({ kind: 'drain', devotion: 'B' });
    const t = quietGame([stompyDeck('a'), stompyDeck('b')]);
    t.game.put(0, enchantment('Bitterblossom', '{1}{B}', 2));
    t.game.players[0].hand = [merchant];
    for (let i = 0; i < 5; i++) t.game.put(0, card({ name: 'Swamp', types: ['Land'], superTypes: ['Basic'], subTypes: ['Swamp'], colorIdentity: ['B'] }));
    let cast = false;
    t.until((g) => g.players[1].life < 40 || g.round > 2, (d) => {
      if (!cast && d.kind === 'priority' && d.seat === 0) {
        const i = d.actions.findIndex((a) => a.type === 'cast' && a.card.name === merchant.name);
        if (i !== -1) {
          cast = true;
          return { action: i };
        }
      }
      return passer(d);
    });
    // Bitterblossom's {B} plus Gray Merchant's own {B}{B}.
    expect(t.game.players[1].life).toBe(37);
  });

  it('proliferate adds poison to poisoned opponents', () => {
    const t = quietGame([stompyDeck('a'), stompyDeck('b')]);
    t.game.players[1].poison = 9;
    t.game.players[0].hand = [spell('Tezzeret\'s Gambit', '{3}{U/P}', 4, 'Sorcery', 'Draw two cards, then proliferate.', { colorIdentity: ['U'] })];
    for (let i = 0; i < 4; i++) t.game.put(0, card({ name: 'Island', types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], colorIdentity: ['U'] }));
    let cast = false;
    t.until(() => false, (d) => {
      if (!cast && d.kind === 'priority' && d.seat === 0) {
        const i = d.actions.findIndex((a) => a.type === 'cast');
        if (i !== -1) {
          cast = true;
          return { action: i };
        }
      }
      return passer(d);
    });
    expect(t.result()!.winner).toBe(0);
    expect(t.game.players[1].poison).toBe(10);
  });

  it('the bot takes a lethal burn spell over anything else', () => {
    const t = quietGame([stompyDeck('a'), stompyDeck('b')]);
    t.game.players[1].life = 3;
    const bolt = spell('Lightning Bolt', '{R}', 1, 'Instant', 'Lightning Bolt deals 3 damage to any target.', { colorIdentity: ['R'] });
    const bomb = card({ name: 'Big Dragon', manaCost: '{4}', cmc: 4, types: ['Creature'], power: '6', toughness: '6' });
    t.game.players[0].hand = [bomb, bolt];
    for (let i = 0; i < 5; i++) t.game.put(0, card({ name: 'Mountain', types: ['Land'], superTypes: ['Basic'], subTypes: ['Mountain'], colorIdentity: ['R'] }));
    const bot = new Bot(0, 1);
    t.until((g) => !g.players[1].alive || g.round > 2, (d) => (d.seat === 0 ? bot.decide(t.game, d) : passer(d)));
    expect(t.game.players[1].alive).toBe(false);
    expect(t.game.players[0].castNames.has('Lightning Bolt')).toBe(true);
  });
});
