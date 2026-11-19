// Commander as a format, and bots that play by the rules.
//
// The rules referee (src/rules/legality.ts) watches whole bot games and reports anything the rules would not
// allow: an offered play at the wrong time, a payment with tapped or missing mana, a creature that should have
// died, a player who should have lost, a card in two places. The scripted tests below pin the Commander rules
// and the fixes the referee led to.

import { describe, expect, it } from 'vitest';
import { classifyCard } from '../src/engine/classify';
import type { Color, SimDeck } from '../src/engine/types';
import { buildDeck, type ImportedCard } from '../src/import/deck';
import { Bot } from '../src/rules/bot';
import { Referee, refereeGame } from '../src/rules/legality';
import { card, creature, forest, stompyDeck, toolboxDeck } from './helpers';
import { stapleDecks } from './staples';
import { Table } from './table';

describe('the rules referee', () => {
  it('finds nothing illegal in bot games with the staple decks', () => {
    const problems: string[] = [];
    let attacks = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const { referee } = refereeGame(stapleDecks(), seed);
      problems.push(...referee.violations.map((v) => `seed ${seed} ${v.rule} (${v.cr}): ${v.msg}`));
      attacks += referee.seen.attacks;
    }
    expect(problems).toEqual([]);
    expect(attacks).toBeGreaterThan(0);
  }, 60_000);

  it('finds nothing illegal in two-player and six-player games', () => {
    const problems: string[] = [];
    for (let seed = 1; seed <= 4; seed++) {
      for (const decks of [[toolboxDeck('a'), stompyDeck('b')], [0, 1, 2, 3, 4, 5].map((i) => (i % 2 ? toolboxDeck(`t${i}`) : stompyDeck(`s${i}`)))]) {
        const { referee } = refereeGame(decks, seed);
        problems.push(...referee.violations.map((v) => `seed ${seed} ${v.rule}: ${v.msg}`));
      }
    }
    expect(problems).toEqual([]);
  }, 60_000);

  it('catches an illegal offer when the engine makes one', () => {
    const t = new Table();
    const g = t.game;
    const ref = new Referee(g);
    // A land offered on someone else's turn is flagged.
    g.players[1].hand.push(forest());
    ref.before({ kind: 'priority', seat: 1, actions: [{ type: 'pass' }, { type: 'land', card: g.players[1].hand[0], back: false }] });
    expect(ref.violations.map((v) => v.rule)).toContain('land-timing');
  });
});

describe('Commander game rules', () => {
  it('each player starts at 40 life with their commander in the command zone and seven cards (rules 903.6, 903.7)', () => {
    const t = new Table(4);
    for (const p of t.game.players) {
      expect(p.life).toBe(40);
      expect(p.commandZone.length + p.battlefield.filter((q) => q.isCommander).length).toBeLessThanOrEqual(1);
    }
  });

  it('commander tax goes up by two each time it is cast from the command zone (rule 903.8)', () => {
    const t = new Table();
    const p = t.game.players[0];
    const cmd = p.deck.commanders[0];
    expect(t.game.commanderTax(p, cmd, true)).toBe(0);
    p.commanderCasts.set(cmd.name, 2);
    expect(t.game.commanderTax(p, cmd, true)).toBe(4);
    expect(t.game.effectiveCost(p, cmd, true)).toBe(cmd.cmc + 4);
    // Cast from anywhere else, there is no tax.
    expect(t.game.commanderTax(p, cmd, false)).toBe(0);
  });

  it('21 combat damage from one commander knocks a player out, even at high life (rule 903.10a)', () => {
    const t = new Table(3);
    const [a, b] = t.game.players;
    const cmd = t.game.put(0, a.deck.commanders[0], { commander: true });
    b.commanderDamage.set(`0:${cmd.card.name}`, 18);
    b.life = 100;
    t.handlers[0] = (_g, d) => (d.kind === 'attackers' ? [{ attacker: cmd.id, defender: 1 }] : undefined);
    t.finishTurn();
    expect(b.alive).toBe(false);
    expect(t.game.eliminations.find((e) => e.seat === 1)?.reason).toBe('commander');
  });

  it('a creature can attack a planeswalker; its damage removes loyalty and the player takes none (rules 508.1b, 120.3c)', () => {
    const t = new Table();
    const [, b] = t.game.players;
    const walker = card({ name: 'Test Walker', manaCost: '{3}{G}', cmc: 4, types: ['Planeswalker'], loyalty: 5, text: '+1: You gain 1 life.', colorIdentity: ['G'] });
    const pw = t.game.put(1, walker);
    expect(pw.loyalty).toBe(5);
    const bear = t.game.put(0, creature('Bear', '{1}{G}', 2, 3, 3));
    let offered: number[] | undefined;
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'attackers') return undefined;
      offered = d.planeswalkers;
      return [{ attacker: bear.id, defender: 1, planeswalker: pw.id }];
    };
    t.finishTurn();
    expect(offered).toEqual([pw.id]);
    expect(pw.loyalty).toBe(2);
    expect(b.life).toBe(40);
  });

  it('bots attack a planeswalker they can finish with an unblockable creature', () => {
    const t = new Table();
    const walker = card({ name: 'Test Walker', manaCost: '{3}{G}', cmc: 4, types: ['Planeswalker'], loyalty: 3, text: '+1: You gain 1 life.', colorIdentity: ['G'] });
    const pw = t.game.put(1, walker);
    t.game.put(0, creature('Bird', '{1}{G}', 2, 3, 3, { keywords: ['Flying'], text: 'Flying' }));
    // Seat 0 plays as a bot for its attack.
    const bot = new Bot(0, 1);
    t.handlers[0] = (g, d) => (d.kind === 'attackers' ? bot.decide(g, d) : undefined);
    t.finishTurn();
    expect(t.game.findPerm(pw.id)).toBeNull();
  });

  it('a land played from an opponent’s exile still belongs to them (rule 108.3)', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    const land = forest();
    b.exile.push(land);
    (t.game as any).grantPlay(a, land, b, { until: 'turn', source: 'test' });
    expect((t.game as any).playLandFrom(a, land, 'exile')).toBe(true);
    const perm = a.battlefield.find((q) => q.card === land)!;
    expect(perm.owner).toBe(1);
  });

  it('a player who leaves takes their cards with them: nobody can play their exiled cards (rule 800.4a)', () => {
    const t = new Table(3);
    const [a, b] = t.game.players;
    const land = forest();
    b.exile.push(land);
    (t.game as any).grantPlay(a, land, b, { until: 'exiled', source: 'test' });
    b.life = 0;
    t.finishTurn();
    expect(b.alive).toBe(false);
    expect(a.mayPlay ?? []).toEqual([]);
    expect(b.exile).toEqual([]);
  });
});

describe('fixes the referee led to', () => {
  it('Darksteel Monolith makes colorless spells from hand free, not commanders from the command zone (rule 903.8)', () => {
    const t = new Table();
    const p = t.game.players[0];
    t.game.put(0, card({ name: 'Darksteel Monolith', manaCost: '{7}', cmc: 7, types: ['Artifact'], text: 'Indestructible\nOnce each turn, you may pay {0} rather than pay the mana cost for a colorless spell you cast from your hand.', colorIdentity: [] }));
    const golem = card({ name: 'Colorless Golem', manaCost: '{5}', cmc: 5, types: ['Artifact', 'Creature'], power: '4', toughness: '4', colorIdentity: [] });
    expect(t.game.effectiveCost(p, golem, false)).toBe(0);
    p.commanderCasts.set(golem.name, 1);
    expect(t.game.effectiveCost(p, golem, true)).toBe(7);
  });

  it('a Clone locked by an Aura goes to the graveyard as the Clone, not as what it copied', () => {
    const t = new Table();
    const [a] = t.game.players;
    const clone = card({ name: 'Clone', manaCost: '{3}{U}', cmc: 4, types: ['Creature'], power: '0', toughness: '0', text: 'You may have Clone enter as a copy of any creature on the battlefield.', colorIdentity: ['U'] });
    const bear = creature('Bear', '{1}{G}', 2, 2, 2);
    const perm = t.game.put(0, bear);
    perm.printed = clone;
    perm.unlocked = bear;
    (t.game as any).removePerms([perm], 'graveyard');
    expect(a.graveyard).toContain(clone);
    expect(a.graveyard).not.toContain(bear);
  });
});

describe('Commander deck rules (rule 903.5)', () => {
  const imported = (name: string, count: number, identity: Color[], extra: Parameters<typeof card>[0] | object = {}): ImportedCard => {
    const c = card({ name, manaCost: '{1}', cmc: 1, types: ['Creature'], power: '1', toughness: '1', colorIdentity: identity, ...extra });
    return { card: c, count, isCommander: false, colorIdentity: identity };
  };
  const commander = (name: string, text = '', identity: Color[] = ['G']): ImportedCard => ({
    card: classifyCard({ name, manaCost: '{2}{G}', cmc: 3, types: ['Creature'], superTypes: ['Legendary'], subTypes: [], text, keywords: [], colorIdentity: identity, power: '3', toughness: '3' }),
    count: 1, isCommander: true, colorIdentity: identity,
  });
  const basics = (n: number): ImportedCard => ({ card: forest(), count: n, isCommander: false, colorIdentity: ['G'] });
  const filler = (n: number) => Array.from({ length: n }, (_, i) => imported(`Card ${i}`, 1, ['G']));
  const deck = (cards: ImportedCard[]): SimDeck => buildDeck({ id: 'd', name: 'D', source: 'text', cards });

  it('a legal deck has no issues', () => {
    expect(deck([commander('Boss'), basics(40), ...filler(59)]).issues).toBeUndefined();
  });

  it('flags the wrong size, duplicates and cards outside the color identity', () => {
    const issues = deck([commander('Boss'), basics(40), imported('Twice', 2, ['G']), imported('Red Card', 1, ['R']), ...filler(50)]).issues!;
    expect(issues.some((i) => i.includes('94 cards'))).toBe(true);
    expect(issues.some((i) => i.includes('2 copies of Twice'))).toBe(true);
    expect(issues.some((i) => i.includes('Red Card'))).toBe(true);
  });

  it('allows any number of a card that says so', () => {
    const rats = { card: classifyCard({ name: 'Relentless Rats', manaCost: '{1}{B}{B}', cmc: 3, types: ['Creature'], superTypes: [], subTypes: ['Rat'], text: 'Relentless Rats gets +1/+1 for each other creature you control named Relentless Rats.\nA deck can have any number of cards named Relentless Rats.', keywords: [], colorIdentity: ['G'], power: '2', toughness: '2' }), count: 20, isCommander: false, colorIdentity: ['G'] as Color[] };
    expect(deck([commander('Boss'), basics(40), rats, ...filler(39)]).issues).toBeUndefined();
  });

  it('checks that two commanders can share the command zone', () => {
    const ok = deck([commander('A', 'Partner', ['G']), commander('B', 'Partner', ['G']), basics(40), ...filler(58)]).issues;
    expect(ok).toBeUndefined();
    const bad = deck([commander('A', '', ['G']), commander('B', '', ['G']), basics(40), ...filler(58)]).issues!;
    expect(bad.some((i) => i.includes("can't share the command zone"))).toBe(true);
  });
});
