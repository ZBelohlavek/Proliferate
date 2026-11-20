import { describe, expect, it } from 'vitest';
import type { SimCard, SimDeck } from '../src/engine/types';
import { Bot } from '../src/rules/bot';
import { Game } from '../src/rules/game';
import type { Answer, Decision } from '../src/rules/types';
import { comboPlan, SPELLBOOK, wantedPieces } from '../src/rules/wincons';
import { card, spell, stompyDeck } from './helpers';

// Each deck's game plan: the combos its own list holds (hand-written ones and Commander
// Spellbook's), Proteus Staff stacking the library, and the bot steering towards the plan.

const artifact = (name: string, cost: string, cmc: number, text = '') => card({ name, manaCost: cost, cmc, types: ['Artifact'], text, colorIdentity: ['U'] });
const island = () => card({ name: 'Island', types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], colorIdentity: ['U'] });
const fblthp = () => card({
  name: 'Fblthp, the Lost', manaCost: '{1}{U}', cmc: 2, types: ['Creature'], superTypes: ['Legendary'], subTypes: ['Homunculus'], power: '1', toughness: '1', colorIdentity: ['U'],
  text: 'When Fblthp enters, draw a card. If it entered from your library or was cast from your library, draw two cards instead.\nWhen Fblthp becomes the target of a spell, shuffle Fblthp into its owner\'s library.',
});
const staff = () => artifact('Proteus Staff', '{3}', 3, "{2}{U}, {T}: Put target creature on the bottom of its owner's library. That creature's controller reveals cards from the top of their library until they reveal a creature card. The player puts that card onto the battlefield and the rest on the bottom of their library in any order. Activate only as a sorcery.");
const scepter = () => artifact('Isochron Scepter', '{2}', 2, 'Imprint — When this artifact enters, you may exile an instant card with mana value 2 or less from your hand.\n{2}, {T}: You may copy the exiled card. If you do, you may cast the copy without paying its mana cost.');
const reversal = () => spell('Dramatic Reversal', '{1}{U}', 2, 'Instant', 'Untap all nonland permanents you control.', { colorIdentity: ['U'] });
const shredder = () => artifact('Codex Shredder', '{1}', 1, '{T}: Target player mills a card.');
const filler = (i: number) => spell(`Filler ${i}`, '{3}{U}', 4, 'Sorcery', 'Scry 1.', { colorIdentity: ['U'] });

/** A creatureless blue deck led by Fblthp, the Lost, with the Scepter combo and its finisher in it. */
function fblthpDeck(): SimDeck {
  const cards: SimCard[] = [staff(), scepter(), reversal(), shredder(), ...Array.from({ length: 50 }, (_, i) => filler(i))];
  return { id: 'fblthp', name: 'Fblthp', source: 'manual', commanders: [fblthp()], cards: [...cards.map((c) => ({ card: c, count: 1 })), { card: island(), count: 45 }], colorIdentity: ['U'] } as unknown as SimDeck;
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
  return { game, until };
}

describe('deck plans', () => {
  it('finds the combos a deck holds every piece of', () => {
    const t = quietGame([fblthpDeck(), stompyDeck('b')]);
    const plan = comboPlan(t.game.players[0]);
    expect(plan.combos.map((c) => c.name)).toContain('Isochron Scepter + Dramatic Reversal');
    // Codex Shredder turns the infinite mana into a win, so it is part of the plan too.
    expect(plan.finishers).toContain('Codex Shredder');
    expect(comboPlan(t.game.players[1]).combos).toEqual([]);
  });

  it('wants the missing pieces of the nearest combo first', () => {
    const t = quietGame([fblthpDeck(), stompyDeck('b')]);
    const p = t.game.players[0];
    p.hand = [scepter()];
    const wanted = wantedPieces(p);
    expect(wanted[0]).toBe('Dramatic Reversal');
    expect(wanted).toContain('Codex Shredder');
  });

  it('a Spellbook loop aimed at one opponent finishes one of them a turn, once its pieces are ready', () => {
    const tree = card({ name: 'Tree of Perdition', manaCost: '{3}{B}', cmc: 4, types: ['Creature'], power: '0', toughness: '13', text: 'Defender\n{T}: Exchange your life total with target opponent\'s toughness.', colorIdentity: ['B'] });
    const bloodletter = card({ name: 'Bloodletter of Aclazotz', manaCost: '{1}{B}{B}{B}', cmc: 4, types: ['Creature'], power: '2', toughness: '4', text: 'Flying\nIf an opponent would lose life during your turn, they lose twice that much life instead.', colorIdentity: ['B'] });
    const base = stompyDeck('a');
    const deck = { ...base, cards: [...base.cards, { card: tree, count: 1 }, { card: bloodletter, count: 1 }] };
    const t = quietGame([deck, stompyDeck('b'), stompyDeck('c')]);
    expect(comboPlan(t.game.players[0]).combos.map((c) => c.name)).toContain('Tree of Perdition + Bloodletter of Aclazotz');
    // A summoning-sick Tree can't tap yet.
    t.game.put(0, tree, { sick: true });
    t.game.put(0, bloodletter);
    t.until((g) => g.players.some((p) => !p.alive) || g.round > 3);
    const dead = t.game.players.filter((p) => !p.alive);
    expect(dead.length).toBe(1);
    expect(t.game.log!.some((l) => l.includes('loops Tree of Perdition + Bloodletter of Aclazotz'))).toBe(true);
  });

  it('every generated Spellbook combo names its pieces and their zones', () => {
    expect(SPELLBOOK.length).toBeGreaterThan(50);
    for (const c of SPELLBOOK) {
      expect(c.zones!.length).toBe(c.pieces.length);
      for (const z of c.zones!) expect(z).toMatch(/^[BHGECLS]+$/);
    }
  });
});

describe('Proteus Staff', () => {
  it("tucks an opponent's creature and gives them the next creature from their library", () => {
    const t = quietGame([stompyDeck('a'), stompyDeck('b')]);
    for (let i = 0; i < 3; i++) t.game.put(0, island());
    t.game.put(0, staff());
    const bear = card({ name: 'Bear', manaCost: '{1}{G}', cmc: 2, types: ['Creature'], power: '2', toughness: '2' });
    t.game.put(1, bear);
    const lib = t.game.players[1].library;
    const firstCreature = lib.find((c) => c.isCreature)!;
    const before = lib.indexOf(firstCreature) + 1;
    t.until((g) => g.log!.some((l) => l.includes(' and finds ')) || g.round > 2, (d) => {
      if (d.kind === 'priority' && d.seat === 0) {
        const i = d.actions.findIndex((a) => a.type === 'activate' && t.game.findPerm(a.permId)?.card.name === 'Proteus Staff');
        if (i !== -1) return { action: i };
      }
      return passer(d);
    });
    const p1 = t.game.players[1];
    expect(p1.battlefield.some((q) => q.card === bear)).toBe(false);
    expect(p1.battlefield.some((q) => q.card === firstCreature)).toBe(true);
    // The tucked creature is at the bottom, under the cards revealed on the way to the new one.
    expect(p1.library.length - 1 - p1.library.indexOf(bear)).toBe(before - 1);
  });

  it('with Fblthp as the only creature, stacks the whole library and draws the combo', () => {
    const t = quietGame([fblthpDeck(), stompyDeck('b')]);
    const p = t.game.players[0];
    for (let i = 0; i < 4; i++) t.game.put(0, island());
    t.game.put(0, staff());
    t.game.put(0, artifact('Sol Ring', '{1}', 1, '{T}: Add {C}{C}.'));
    p.commandZone = [];
    t.game.put(0, p.deck.commanders[0], { commander: true });
    // Bury the combo deep: the Staff should bring it to the top.
    p.library = [...p.library.filter((c) => !['Isochron Scepter', 'Dramatic Reversal', 'Codex Shredder'].includes(c.name)), scepter(), reversal(), shredder()];
    const libSize = p.library.length;
    const bot = new Bot(0, 7);
    t.until((g) => p.hand.length >= 2 || g.round > 2, (d) => (d.seat === 0 ? bot.decide(t.game, d) : passer(d)));
    expect(t.game.log!.some((l) => l.includes(`reveals ${libSize + 1} cards and finds Fblthp, the Lost`))).toBe(true);
    // Fblthp came back from the library: it draws two, the two pieces it put on top.
    expect(p.battlefield.some((q) => q.card.name === 'Fblthp, the Lost')).toBe(true);
    const names = p.hand.map((c) => c.name);
    expect(names).toContain('Isochron Scepter');
    expect(names).toContain('Dramatic Reversal');
    expect(p.library[0].name).toBe('Codex Shredder');
  });
});
