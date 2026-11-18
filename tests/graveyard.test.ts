import { describe, expect, it } from 'vitest';
import type { SimCard, SimDeck } from '../src/engine/types';
import { Game } from '../src/rules/game';
import type { Action, Answer, Decision } from '../src/rules/types';
import { creature, forest, spell, stompyDeck } from './helpers';

// Mill, reanimation and the other graveyard mechanics, on scripted tables:
// every seat passes and declines unless a handler says otherwise.

type Handler = (g: Game, d: Decision) => Answer | undefined;

function fallback(d: Decision): Answer {
  switch (d.kind) {
    case 'priority': return { action: 0 };
    case 'target': return d.candidates[0];
    case 'attackers': return [];
    case 'blockers': return [];
    case 'choose': return d.options.slice(0, d.min).map((_, i) => i);
    case 'confirm': return d.reason === 'commandZone';
  }
}

class Table {
  readonly game: Game;
  private flow: ReturnType<Game['run']>;
  private next: IteratorResult<Decision, unknown>;
  private stale = false;
  handlers: Record<number, Handler> = {};

  constructor(players = 2) {
    const decks: SimDeck[] = Array.from({ length: players }, (_, i) => stompyDeck(`p${i}`));
    this.game = new Game(decks, 1, { log: true });
    this.flow = this.game.run();
    this.next = this.flow.next();
    this.until((g) => g.step === 'main1');
    for (const p of this.game.players) {
      p.hand = [];
      p.battlefield = [];
    }
    // The waiting decision lists plays from the old hand; answering it makes the engine ask again.
    this.stale = true;
  }

  until(stop: (g: Game, d: Decision) => boolean) {
    if (this.stale) {
      this.stale = false;
      this.next = this.flow.next({ action: 1 });
    }
    for (let i = 0; i < 20_000 && !this.next.done; i++) {
      const d = this.next.value as Decision;
      if (stop(this.game, d)) return;
      this.next = this.flow.next(this.handlers[d.seat]?.(this.game, d) ?? fallback(d));
    }
  }

  lands(seat: number, n: number) {
    for (let i = 0; i < n; i++) this.game.put(seat, forest());
  }

  get log() {
    return this.game.log!.join('\n');
  }
}

/** Take the first action matching `match`, once. */
function once(match: (a: Action) => boolean, extra: Handler = () => undefined): Handler {
  let done = false;
  return (g, d) => {
    if (!done && d.kind === 'priority') {
      const i = d.actions.findIndex(match);
      if (i !== -1) {
        done = true;
        return { action: i };
      }
    }
    return extra(g, d);
  };
}
const castNamed = (name: string) => (a: Action) => a.type === 'cast' && a.card.name === name;
const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const effectsOf = (c: SimCard) => c.effects.map((e) => e.kind);

describe('graveyard mechanics: reading the cards', () => {
  it('reads mill wordings from real decks', () => {
    const nemesis = creature('Nemesis of Reason', '{3}{U}{B}', 5, 3, 7, { text: 'Whenever Nemesis of Reason attacks, defending player mills ten cards.' });
    expect(nemesis.effects).toContainEqual(expect.objectContaining({ kind: 'mill', n: 10, when: 'attack' }));
    const petitioners = creature('Persistent Petitioners', '{1}{U}', 2, 1, 3, { text: '{1}, {T}: Target player mills a card.\nTap four untapped Advisors you control: Target player mills twelve cards.' });
    const twelve = petitioners.effects.find((e) => e.kind === 'mill' && e.n === 12);
    expect(twelve?.activation?.tapCreatures).toBe(4);
    const grind = spell('Mind Grind', '{X}{U}{B}', 2, 'Sorcery', 'Each opponent reveals cards from the top of their library until they reveal X land cards, then puts all cards revealed this way into their graveyard. X can\'t be 0.');
    expect(grind.effects[0]).toMatchObject({ kind: 'mill', who: 'opponents', untilLands: 3 });
    const bruvac = creature('Bruvac the Grandiloquent', '{2}{U}', 3, 1, 4, { text: 'If an opponent would mill one or more cards, they mill twice that many cards instead.' });
    expect(bruvac.effects).toEqual([expect.objectContaining({ kind: 'millBoost', mult: 2, when: 'static' })]);
    const skinner = creature('The Mindskinner', '{U}{U}{U}', 3, 10, 1, { text: "The Mindskinner can't be blocked.\nIf a source you control would deal damage to an opponent, prevent that damage and each opponent mills that many cards." });
    expect(effectsOf(skinner)).toEqual(['damageToMill']);
    expect(skinner.unread).toBeUndefined();
  });

  it('reads reanimation and other returns, with what they can return', () => {
    const titan = creature('Sun Titan', '{4}{W}{W}', 6, 6, 6, { text: 'Vigilance\nWhenever Sun Titan enters or attacks, you may return target permanent card with mana value 3 or less from your graveyard to the battlefield.' });
    expect(titan.effects[0]).toMatchObject({ kind: 'recursion', what: 'permanent', maxCmc: 3, toBattlefield: true });
    const reanimate = spell('Reanimate', '{B}', 1, 'Sorcery', "Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to that card's mana value.");
    expect(reanimate.effects[0]).toMatchObject({ kind: 'recursion', from: 'any', toBattlefield: true });
    const realms = spell('Rise of the Dark Realms', '{7}{B}{B}', 9, 'Sorcery', 'Put all creature cards from all graveyards onto the battlefield under your control.');
    expect(realms.effects[0]).toMatchObject({ kind: 'recursion', all: true, from: 'any' });
    const wake = spell('Wake the Past', '{5}{R}{W}', 7, 'Sorcery', 'Return all artifact cards from your graveyard to the battlefield. They gain haste until end of turn.');
    expect(wake.effects[0]).toMatchObject({ kind: 'recursion', all: true, what: 'artifact' });
    const loam = spell('Life from the Loam', '{1}{G}', 2, 'Sorcery', 'Return up to three target land cards from your graveyard to your hand.\nDredge 3');
    expect(loam.effects[0]).toMatchObject({ kind: 'recursion', n: 3, what: 'land', toBattlefield: false });
    const buried = spell('Buried Alive', '{2}{B}', 3, 'Sorcery', 'Search your library for up to three creature cards, put them into your graveyard, then shuffle.');
    expect(buried.effects).toEqual([expect.objectContaining({ kind: 'entomb', n: 3, what: 'creature' })]);
  });

  it('reads keywords that use a card from the graveyard', () => {
    const skeleton = creature('Reassembling Skeleton', '{1}{B}', 2, 1, 1, { text: '{1}{B}: Return Reassembling Skeleton from your graveyard to the battlefield tapped.' });
    expect(skeleton.graveyard).toMatchObject({ how: 'return', to: 'battlefield', tapped: true });
    expect(skeleton.effects).toEqual([]);
    expect(skeleton.unread).toBeUndefined();
    const strider = creature('Woe Strider', '{2}{B}', 3, 3, 2, { text: 'Escape—{3}{B}{B}, Exile four other cards from your graveyard.\nWoe Strider escapes with two +1/+1 counters on it.' });
    expect(strider.graveyard).toMatchObject({ how: 'cast', label: 'escape', exileOthers: 4 });
    const engine = creature('Phyrexian Dragon Engine', '{5}', 5, 2, 2, { text: 'Unearth {3}{R}{R}' });
    expect(engine.graveyard).toMatchObject({ label: 'unearth', haste: true, exileAtEnd: true });
    const redcap = creature('Murderous Redcap', '{2}{B/R}{B/R}', 4, 2, 2, { text: 'Persist (When this creature dies, if it had no -1/-1 counters on it, return it to the battlefield under its owner\'s control with a -1/-1 counter on it.)' });
    expect(redcap.persist).toBe('persist');
    const crucible = spell('Crucible of Worlds', '{3}', 3, 'Artifact', 'You may play lands from your graveyard.');
    expect(crucible.effects).toEqual([expect.objectContaining({ kind: 'graveyardPlay', what: 'lands' })]);
    const cage = spell("Grafdigger's Cage", '{1}', 1, 'Artifact', "Creature cards in graveyards and libraries can't enter the battlefield.\nPlayers can't cast spells from graveyards or libraries.");
    expect(effectsOf(cage)).toEqual(['graveyardLock']);
    expect(cage.unread).toBeUndefined();
  });
});

describe('graveyard mechanics: the engine', () => {
  it('reanimates from an opponent\'s graveyard, and the card goes back to its owner later', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 1);
    const big = creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);
    b.graveyard.push(big);
    a.hand.push(spell('Reanimate', '{G}', 1, 'Sorcery', 'Put target creature card from a graveyard onto the battlefield under your control.'));
    t.handlers[0] = once(castNamed('Reanimate'));
    t.until(() => a.battlefield.some((q) => q.card === big));
    const perm = a.battlefield.find((q) => q.card === big)!;
    expect(perm.owner).toBe(1);
    expect(b.graveyard).not.toContain(big);
    expect(t.log).toContain(`from ${b.name}'s graveyard`);
  });

  it('returns every matching card with a mass return, and nothing past Grafdigger\'s Cage', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    const relics = [spell('Mind Stone', '{2}', 2, 'Artifact', '{T}: Add {C}.'), spell('Wayfarer\'s Bauble', '{1}', 1, 'Artifact', '')];
    a.graveyard.push(...relics, bears());
    a.hand.push(spell('Wake the Past', '{G}', 1, 'Sorcery', 'Return all artifact cards from your graveyard to the battlefield.'));
    t.handlers[0] = once(castNamed('Wake the Past'));
    t.until(() => a.graveyard.length === 2);
    expect(a.battlefield.filter((q) => relics.includes(q.card))).toHaveLength(2);
    expect(a.graveyard.map((c) => c.name)).toEqual(['Grizzly Bears', 'Wake the Past']);

    // With a Cage out, the Bears stay put.
    t.game.put(1, spell("Grafdigger's Cage", '{1}', 1, 'Artifact', "Creature cards in graveyards and libraries can't enter the battlefield."));
    a.hand.push(spell('Zombify', '{G}', 1, 'Sorcery', 'Return target creature card from your graveyard to the battlefield.'));
    const before = t.game.legalActions(a).filter((x) => x.type === 'cast' && x.card.name === 'Zombify');
    expect(before).toHaveLength(0);
  });

  it('Bruvac doubles mill and The Mindskinner turns combat damage into mill', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    t.game.put(0, creature('Bruvac the Grandiloquent', '{2}{U}', 3, 1, 4, { text: 'If an opponent would mill one or more cards, they mill twice that many cards instead.' }));
    const skinner = t.game.put(0, creature('The Mindskinner', '{U}{U}{U}', 3, 10, 1, { text: "The Mindskinner can't be blocked.\nIf a source you control would deal damage to an opponent, prevent that damage and each opponent mills that many cards." }));
    a.hand.push(spell('Thought Scour', '{G}', 1, 'Instant', 'Target player mills two cards.'));
    t.handlers[0] = once(castNamed('Thought Scour'), (_g, d) => {
      if (d.kind === 'target') return { kind: 'player', seat: 1 };
      if (d.kind === 'attackers') return [{ attacker: skinner.id, defender: 1 }];
      return undefined;
    });
    t.until((g) => g.activeSeat === 1 || g.round > 1);
    // 2 doubled to 4, then 10 combat damage doubled to 20 milled; no life lost.
    expect(t.log).toContain(`${b.name} mills 4 cards`);
    expect(t.log).toContain(`${b.name} mills 20 cards`);
    expect(t.log).toContain(`damage to ${b.name} is prevented`);
    expect(b.life).toBe(40);
  });

  it('persist brings a creature back once, with a -1/-1 counter', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 4);
    const clique = creature('Kitchen Finks', '{G}', 1, 3, 2, { text: 'Persist' });
    t.game.put(0, clique);
    const bolt = spell('Fatal Push', '{G}', 1, 'Instant', 'Destroy target creature.');
    a.hand.push(bolt, spell('Fatal Push', '{G}', 1, 'Instant', 'Destroy target creature.'));
    let casts = 0;
    t.handlers[0] = (_g, d) => {
      if (d.kind === 'priority' && casts < 2 && !t.game.stack.length) {
        const i = d.actions.findIndex((x) => x.type === 'cast' && x.card.name === 'Fatal Push');
        if (i !== -1 && a.battlefield.some((q) => q.card === clique)) {
          casts++;
          return { action: i };
        }
      }
      return undefined;
    };
    t.until(() => t.log.includes('returns to the battlefield with a -1/-1 counter') && !t.game.stack.length);
    const back = a.battlefield.find((q) => q.card === clique)!;
    expect(back.counters).toBe(-1);
    expect(t.game.power(back)).toBe(2);
    t.until(() => (t.log.match(/Kitchen Finks \(.*\) is destroyed/g) ?? []).length >= 2 && !t.game.stack.length);
    expect(a.battlefield.some((q) => q.card === clique)).toBe(false);
    expect(a.graveyard).toContain(clique);
  });

  it('unearth returns a creature with haste and exiles it at the end step', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    const engine = creature('Dragon Engine', '{5}', 5, 4, 4, { text: 'Unearth {G}' });
    a.graveyard.push(engine);
    t.handlers[0] = once((x) => x.type === 'graveyard' && x.card === engine, (_g, d) => (d.kind === 'attackers' ? d.candidates.map((attacker) => ({ attacker, defender: 1 })) : undefined));
    t.until((g) => g.step === 'end');
    expect(t.game.players[1].life).toBe(36);
    t.until((g) => g.step === 'cleanup' || g.activeSeat === 1);
    expect(a.exile).toContain(engine);
    expect(a.battlefield.some((q) => q.card === engine)).toBe(false);
  });

  it('escape casts from the graveyard by exiling other cards', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    const strider = creature('Woe Strider', '{2}{G}', 3, 3, 2, { text: 'Escape—{1}{G}{G}, Exile two other cards from your graveyard.' });
    const fodder = [bears(), bears()];
    a.graveyard.push(strider, ...fodder);
    t.handlers[0] = once((x) => x.type === 'cast' && x.from === 'graveyard' && x.card === strider);
    t.until(() => a.battlefield.some((q) => q.card === strider));
    expect(a.exile).toEqual(expect.arrayContaining(fodder));
    expect(a.graveyard).toHaveLength(0);
    expect(t.log).toContain('with escape');
  });

  it('Crucible of Worlds plays a land from the graveyard; Muldrotha casts one permanent of each type', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    t.game.put(0, creature('Muldrotha, the Gravetide', '{3}{B}{G}{U}', 6, 6, 6, { text: 'During each of your turns, you may play a land and cast a permanent spell of each permanent type from your graveyard.' }));
    const land = forest();
    const one = bears();
    const two = creature('Elvish Visionary', '{1}{G}', 2, 1, 1);
    a.graveyard.push(land, one, two);
    const actions = t.game.legalActions(a);
    expect(actions.some((x) => x.type === 'land' && x.fromGraveyard)).toBe(true);
    t.handlers[0] = once((x) => x.type === 'cast' && x.from === 'graveyard' && x.card === one);
    t.until(() => a.battlefield.some((q) => q.card === one) && !t.game.stack.length);
    // A creature was already cast from the graveyard this turn.
    expect(t.game.legalActions(a).some((x) => x.type === 'cast' && x.card === two)).toBe(false);
    expect(t.game.legalActions(a).some((x) => x.type === 'land' && x.fromGraveyard)).toBe(true);
  });

  it('Buried Alive puts creatures from the library into the graveyard', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    a.hand.push(spell('Buried Alive', '{G}', 1, 'Sorcery', 'Search your library for up to three creature cards, put them into your graveyard, then shuffle.'));
    t.handlers[0] = once(castNamed('Buried Alive'), (_g, d) => (d.kind === 'choose' && d.reason === 'entomb' ? [0, 1, 2] : undefined));
    t.until(() => a.graveyard.length >= 4);
    expect(a.graveyard.filter((c) => c.isCreature)).toHaveLength(3);
  });

  it('milling an opponent sets off "whenever an opponent mills" and Dauthi exiles their cards instead', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    const loAndLi = t.game.put(0, creature('Lo and Li, Royal Advisors', '{3}{U}{B}', 5, 3, 3, { text: 'Whenever an opponent discards a card or mills one or more cards, put a +1/+1 counter on each Advisor you control.' }));
    a.hand.push(spell('Thought Scour', '{G}', 1, 'Instant', 'Target player mills two cards.'));
    t.handlers[0] = once(castNamed('Thought Scour'), (_g, d) => (d.kind === 'target' ? { kind: 'player', seat: 1 } : undefined));
    t.until(() => loAndLi.counters > 0);
    expect(loAndLi.counters).toBe(1);

    t.game.put(0, creature('Dauthi Voidwalker', '{B}{B}', 2, 3, 2, { text: "If a card would be put into an opponent's graveyard from anywhere, instead exile it with a void counter on it." }));
    a.hand.push(spell('Thought Scour', '{G}', 1, 'Instant', 'Target player mills two cards.'));
    const graveyard = b.graveyard.length;
    t.handlers[0] = once(castNamed('Thought Scour'), (_g, d) => (d.kind === 'target' ? { kind: 'player', seat: 1 } : undefined));
    t.until(() => b.exile.length >= 2);
    expect(b.graveyard).toHaveLength(graveyard);
    // Our own spell still goes to our graveyard.
    expect(a.graveyard.filter((c) => c.name === 'Thought Scour')).toHaveLength(2);
  });

  it('Persistent Petitioners taps four creatures to mill twelve', () => {
    const t = new Table();
    const b = t.game.players[1];
    const petitioner = () => creature('Persistent Petitioners', '{1}{U}', 2, 1, 3, { text: '{1}, {T}: Target player mills a card.\nTap four untapped Advisors you control: Target player mills twelve cards.' });
    // Five of them and a land, so the {1}, {T} ability keeps a choice open after the big one.
    const perms = [0, 1, 2, 3, 4].map((i) => t.game.put(0, petitioner(), { sick: i < 4 }));
    t.lands(0, 1);
    t.handlers[0] = once((x) => x.type === 'activate' && x.effect.kind === 'mill' && x.effect.n === 12, (_g, d) => (d.kind === 'target' ? { kind: 'player', seat: 1 } : undefined));
    t.until(() => t.log.includes('mills 12 cards') && !t.game.stack.length);
    expect(t.log).toContain(`${b.name} mills 12 cards`);
    expect(perms.filter((q) => q.tapped)).toHaveLength(4);
  });

  it('bots reanimate the best creature and use returns from the graveyard in real games', async () => {
    const { playGame } = await import('../src/rules/session');
    const reanimator = (id: string): SimDeck => {
      const deck = stompyDeck(id);
      const one = (c: SimCard, count = 1) => ({ card: c, count });
      deck.cards = [
        { card: forest(), count: 38 },
        one(spell('Buried Alive', '{2}{G}', 3, 'Sorcery', 'Search your library for up to three creature cards, put them into your graveyard, then shuffle.'), 4),
        one(spell('Reanimate', '{G}', 1, 'Sorcery', 'Put target creature card from a graveyard onto the battlefield under your control.'), 6),
        one(creature('Reassembling Skeleton', '{1}{G}', 2, 1, 1, { text: '{1}{G}: Return Reassembling Skeleton from your graveyard to the battlefield tapped.' }), 6),
        one(creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4), 20),
        one(creature('Grizzly Bears', '{1}{G}', 2, 2, 2), 25),
      ];
      return deck;
    };
    let reanimated = 0;
    let returned = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const { result, log: lines } = playGame([reanimator('a'), stompyDeck('b'), stompyDeck('c')], seed, { log: true });
      const log = lines!.join('\n');
      reanimated += (log.match(/returns Craw Wurm/g) ?? []).length;
      returned += (log.match(/returns Reassembling Skeleton from their graveyard/g) ?? []).length;
      expect(result.placements.length).toBe(3);
    }
    expect(reanimated).toBeGreaterThan(0);
    expect(returned).toBeGreaterThan(0);
  });
});
