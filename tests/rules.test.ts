import { describe, expect, it } from 'vitest';
import type { SimCard, SimDeck } from '../src/engine/types';
import { Game } from '../src/rules/game';
import { playGame, Session } from '../src/rules/session';
import type { Action, Answer, Decision, Perm } from '../src/rules/types';
import { addResult, emptyStats } from '../src/sim/stats';
import { creature, forest, spell, stompyDeck, toolboxDeck } from './helpers';

// ---------------------------------------------------------------------------
// A tiny harness: every seat passes and declines everything unless a handler
// says otherwise, so each test scripts only the plays it is about.
// ---------------------------------------------------------------------------

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
  handlers: Record<number, Handler> = {};

  constructor(players = 2, opts: { maxRounds?: number } = {}) {
    const decks: SimDeck[] = Array.from({ length: players }, (_, i) => stompyDeck(`p${i}`));
    this.game = new Game(decks, 1, { log: true, ...opts });
    this.flow = this.game.run();
    this.next = this.flow.next();
    // Play up to seat 0's first main phase, then clear the table for the test's own setup.
    this.until((g) => g.step === 'main1');
    for (const p of this.game.players) {
      p.hand = [];
      p.battlefield = [];
    }
    this.stale = true;
  }

  /**
   * The decision waiting after setup lists plays from the old hand. Choosing
   * one (it can no longer be made) has the engine ask again with the new state.
   */
  private stale = false;

  get done() {
    return !!this.next.done;
  }

  /** Answer decisions until `stop` is true at a decision point, or the game ends. */
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

  /** Play to the end of the current turn (the next turn's upkeep or later). */
  finishTurn() {
    const turn = this.game.turnNumber;
    this.until((g) => g.turnNumber !== turn);
  }

  lands(seat: number, n: number) {
    for (let i = 0; i < n; i++) this.game.put(seat, forest());
  }
}

const find = (actions: Action[], type: Action['type'], name?: string) =>
  actions.findIndex((a) => a.type === type && (name === undefined || ('card' in a && a.card.name === name)));

/** Cast `name` the first time it is castable, at the first chance. */
function castOnce(name: string, when: (g: Game) => boolean = () => true): Handler {
  let done = false;
  return (g, d) => {
    if (done || d.kind !== 'priority' || !when(g)) return undefined;
    const i = find(d.actions, 'cast', name);
    if (i === -1) return undefined;
    done = true;
    return { action: i };
  };
}

const attackAll = (defender: number): Handler => (_g, d) => (d.kind === 'attackers' ? d.candidates.map((attacker) => ({ attacker, defender })) : undefined);
const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const vanilla = (name: string, p: number, t: number, keywords: string[] = [], extra: Partial<Parameters<typeof creature>[5]> = {}) =>
  creature(name, '{G}', 1, p, t, { keywords, text: keywords.join(', '), ...extra });

describe('rules engine: whole games', () => {
  it('plays bot games of every size to a valid finish', () => {
    for (let seed = 0; seed < 60; seed++) {
      const size = 2 + (seed % 5);
      const decks = Array.from({ length: size }, (_, i) => (i % 2 ? stompyDeck(`s${i}`) : toolboxDeck(`t${i}`)));
      const { result } = playGame(decks, seed);
      expect(result.placements).toHaveLength(size);
      expect(result.placements).not.toContain(0);
      expect(result.eliminations.length).toBe(result.winner === null ? size : size - 1);
      if (result.winner !== null) expect(result.placements[result.winner]).toBe(1);
    }
  });

  it('is deterministic for a given seed', () => {
    const decks = ['a', 'b', 'c'].map((id) => toolboxDeck(id));
    const first = playGame(decks, 99, { log: true });
    const second = playGame(decks, 99, { log: true });
    expect(second.result).toEqual(first.result);
    expect(second.log).toEqual(first.log);
  });

  it('a strictly stronger commander wins more often', () => {
    const stats = emptyStats();
    for (let seed = 0; seed < 200; seed++) {
      const decks = [stompyDeck('strong', 9), stompyDeck('weak1'), stompyDeck('weak2'), stompyDeck('weak3')];
      const shift = seed % 4;
      addResult(stats, playGame([...decks.slice(shift), ...decks.slice(0, shift)], seed).result);
    }
    expect(stats.decks.strong.wins / stats.decks.strong.games).toBeGreaterThan(0.32);
  });

  it('keeps library, hand, battlefield and graveyard cards accounted for', () => {
    const decks = ['a', 'b', 'c', 'd'].map((id) => toolboxDeck(id));
    const game = new Game(decks, 5);
    const bots = playersOf(game, 5);
    const size = 1 + decks[0].cards.reduce((n, c) => n + c.count, 0);
    const flow = game.run();
    let next = flow.next();
    let checks = 0;
    while (!next.done) {
      if (next.value.kind === 'priority' && game.stack.length === 0) {
        for (const p of game.players) {
          if (!p.alive) continue;
          const onBoard = p.battlefield.filter((q) => !q.token).length;
          expect(p.library.length + p.hand.length + p.graveyard.length + p.exile.length + p.commandZone.length + onBoard).toBe(size);
          checks++;
        }
      }
      next = flow.next(bots[next.value.seat].decide(game, next.value));
    }
    expect(checks).toBeGreaterThan(50);
  });
});

function playersOf(game: Game, seed: number) {
  // Imported lazily so the harness above stays independent of the bot.
  return game.players.map((p) => new BotClass(p.seat, seed));
}
import { Bot as BotClass } from '../src/rules/bot';

describe('rules engine: turn structure and casting', () => {
  it('starts at 40 life and lets one land be played per turn', () => {
    const t = new Table();
    const p = t.game.players[0];
    expect(p.life).toBe(40);
    p.hand.push(forest(), forest());
    t.handlers[0] = (_g, d) => (d.kind === 'priority' ? { action: Math.max(0, find(d.actions, 'land')) } : undefined);
    t.finishTurn();
    expect(p.battlefield.filter((q) => q.landInfo)).toHaveLength(1);
    expect(p.hand.filter((c) => c.isLand)).toHaveLength(1);
  });

  it('only offers sorcery-speed spells in your own main phase with an empty stack', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.lands(1, 3);
    a.hand.push(bears());
    b.hand.push(bears(), spell('Giant Growth', '{G}', 1, 'Instant', 'Target creature gets +3/+3 until end of turn.'));
    t.game.put(1, bears());
    const offered: string[] = [];
    t.handlers[1] = (_g, d) => {
      if (d.kind === 'priority') for (const x of d.actions) if (x.type === 'cast') offered.push(x.card.name);
      return undefined;
    };
    t.handlers[0] = castOnce('Grizzly Bears');
    t.finishTurn();
    // On the opponent's turn the instant is castable, the creature never is.
    expect(offered).toContain('Giant Growth');
    expect(offered).not.toContain('Grizzly Bears');
  });

  it('summoning-sick creatures cannot attack, and haste lifts that', () => {
    const t = new Table();
    const sick = t.game.put(0, bears(), { sick: true });
    const hasty = t.game.put(0, vanilla('Hasty', 2, 2, ['Haste']), { sick: true });
    let candidates: number[] = [];
    t.handlers[0] = (_g, d) => {
      if (d.kind === 'attackers') candidates = d.candidates;
      return undefined;
    };
    t.finishTurn();
    expect(candidates).toEqual([hasty.id]);
    expect(candidates).not.toContain(sick.id);
  });

  it('a counterspell answers a spell on the stack', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    t.lands(1, 2);
    a.hand.push(bears());
    b.hand.push(spell('Counterspell', '{G}{G}', 2, 'Instant', 'Counter target spell.'));
    t.handlers[0] = castOnce('Grizzly Bears');
    t.handlers[1] = castOnce('Counterspell', (g) => g.stack.length === 1);
    t.finishTurn();
    expect(a.battlefield.some((q) => q.card.name === 'Grizzly Bears')).toBe(false);
    expect(a.graveyard.map((c) => c.name)).toContain('Grizzly Bears');
    expect(b.graveyard.map((c) => c.name)).toContain('Counterspell');
  });

  it('a spell whose target became illegal does not resolve', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 1);
    t.lands(1, 1);
    const victim = t.game.put(1, bears());
    a.hand.push(spell('Lightning Bolt', '{G}', 1, 'Instant', 'Lightning Bolt deals 3 damage to any target.'));
    b.hand.push(spell('Veil', '{G}', 1, 'Instant', 'Target creature you control gains hexproof until end of turn.'));
    t.handlers[0] = (g, d) => {
      if (d.kind === 'target') return { kind: 'perm', id: victim.id };
      return castOnce('Lightning Bolt')(g, d);
    };
    const bolt = t.handlers[0];
    const cast = castOnce('Lightning Bolt');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? bolt(g, d) : cast(g, d));
    t.handlers[1] = castOnce('Veil', (g) => g.stack.length === 1);
    t.finishTurn();
    expect(b.battlefield).toContain(victim);
    expect(t.game.log!.join('\n')).toMatch(/no legal target/);
  });

  it('hexproof stops opponents from targeting, but not its controller', () => {
    const t = new Table();
    const troll = t.game.put(1, vanilla('Troll', 3, 2, ['Hexproof']));
    const bolt = spell('Lightning Bolt', '{G}', 1, 'Instant', 'Lightning Bolt deals 3 damage to any target.');
    const e = bolt.effects[0];
    const ids = (seat: number) => t.game.targetCandidates(t.game.players[seat], e, null)!.flatMap((x) => (x.kind === 'perm' ? [x.id] : []));
    expect(ids(0)).not.toContain(troll.id);
    expect(ids(1)).toContain(troll.id);
  });

  it('enters-the-battlefield triggers use the stack and pick a target', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    const victim = t.game.put(1, bears());
    a.hand.push(creature('Flametongue Kavu', '{3}{G}', 4, 4, 2, { text: 'When Flametongue Kavu enters, it deals 4 damage to target creature.' }));
    t.handlers[0] = castOnce('Flametongue Kavu');
    t.finishTurn();
    expect(b.battlefield).not.toContain(victim);
    expect(b.graveyard.map((c) => c.name)).toContain('Grizzly Bears');
  });

  it('X spells pay for X', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 6);
    a.hand.push(spell('Fireball', '{X}{G}', 1, 'Sorcery', 'Fireball deals X damage to any target.'));
    t.handlers[0] = (_g, d) => {
      if (d.kind === 'target') return { kind: 'player', seat: 1 };
      if (d.kind !== 'priority') return undefined;
      const i = find(d.actions, 'cast', 'Fireball');
      if (i === -1) return undefined;
      expect((d.actions[i] as Extract<Action, { type: 'cast' }>).maxX).toBe(5);
      return { action: i, x: 5 };
    };
    t.finishTurn();
    expect(b.life).toBe(35);
    expect(a.battlefield.filter((q) => q.tapped)).toHaveLength(6);
  });
});

describe('rules engine: combat', () => {
  /** Seat 0 attacks seat 1 with everything; seat 1 blocks as `blocks` says. Returns after the turn. */
  function fight(setup: (t: Table) => void, blocks: (g: Game, attackers: number[], candidates: number[]) => { blocker: number; attacker: number }[] = () => []) {
    const t = new Table();
    setup(t);
    t.handlers[0] = attackAll(1);
    t.handlers[1] = (g, d) => (d.kind === 'blockers' ? blocks(g, d.attackers, d.candidates) : undefined);
    t.finishTurn();
    return t;
  }
  const blockFirst = (_g: Game, attackers: number[], candidates: number[]) => [{ blocker: candidates[0], attacker: attackers[0] }];

  it('unblocked creatures damage the player; blocked ones fight the blocker', () => {
    let attacker!: Perm;
    let blocker!: Perm;
    const t = fight((x) => {
      attacker = x.game.put(0, bears());
      x.game.put(0, vanilla('Ogre', 3, 3));
      blocker = x.game.put(1, vanilla('Wall', 0, 5));
    }, (_g, attackers, candidates) => [{ blocker: candidates[0], attacker: attackers[0] }]);
    const [a, b] = t.game.players;
    expect(b.life).toBe(37);
    expect(a.battlefield).toContain(attacker);
    expect(b.battlefield).toContain(blocker);
    // Attacking taps the creature (no vigilance); it untaps next turn.
    expect(attacker.tapped).toBe(true);
  });

  it('flying can only be blocked by flying or reach', () => {
    const t = new Table();
    const bird = t.game.put(0, vanilla('Bird', 1, 1, ['Flying']));
    const bear = t.game.put(1, bears());
    const spider = t.game.put(1, vanilla('Spider', 1, 3, ['Reach']));
    expect(t.game.canBlock(bear, bird)).toBe(false);
    expect(t.game.canBlock(spider, bird)).toBe(true);
  });

  it('menace needs two blockers', () => {
    const one = fight((x) => {
      x.game.put(0, vanilla('Menacer', 3, 3, ['Menace']));
      x.game.put(1, vanilla('Wall', 0, 5));
    }, blockFirst);
    expect(one.game.players[1].life).toBe(37);

    const two = fight((x) => {
      x.game.put(0, vanilla('Menacer', 3, 3, ['Menace']));
      x.game.put(1, vanilla('Wall', 0, 5));
      x.game.put(1, vanilla('Wall', 0, 5));
    }, (_g, attackers, candidates) => candidates.map((blocker) => ({ blocker, attacker: attackers[0] })));
    expect(two.game.players[1].life).toBe(40);
  });

  it('first strike kills before the other creature strikes back', () => {
    const t = fight((x) => {
      x.game.put(0, vanilla('Knight', 2, 2, ['First strike']));
      x.game.put(1, vanilla('Ogre', 3, 2));
    }, blockFirst);
    expect(t.game.players[0].battlefield.map((q) => q.card.name)).toEqual(['Knight']);
    expect(t.game.players[1].battlefield).toHaveLength(0);
  });

  it('double strike hits twice', () => {
    const t = fight((x) => x.game.put(0, vanilla('Ace', 2, 1, ['Double strike'])));
    expect(t.game.players[1].life).toBe(36);
  });

  it('trample carries excess damage over; deathtouch needs only 1 per blocker', () => {
    const plain = fight((x) => {
      x.game.put(0, vanilla('Wurm', 6, 6, ['Trample']));
      x.game.put(1, bears());
    }, blockFirst);
    expect(plain.game.players[1].life).toBe(36);

    const deadly = fight((x) => {
      x.game.put(0, vanilla('Basilisk', 6, 6, ['Trample', 'Deathtouch']));
      x.game.put(1, vanilla('Wall', 0, 9));
    }, blockFirst);
    expect(deadly.game.players[1].life).toBe(35);
    expect(deadly.game.players[1].battlefield).toHaveLength(0);
  });

  it('lifelink gains life and vigilance does not tap', () => {
    let angel!: Perm;
    const t = fight((x) => {
      angel = x.game.put(0, vanilla('Angel', 4, 4, ['Lifelink', 'Vigilance']));
    });
    expect(t.game.players[0].life).toBe(44);
    expect(t.game.players[1].life).toBe(36);
    expect(angel.tapped).toBe(false);
  });

  it('indestructible creatures survive lethal damage', () => {
    let brute!: Perm;
    const t = fight((x) => {
      x.game.put(0, vanilla('Giant', 9, 9));
      brute = x.game.put(1, vanilla('Brute', 1, 1, ['Indestructible']));
    }, blockFirst);
    expect(t.game.players[1].battlefield).toContain(brute);
  });

  it('a creature can attack each opponent separately', () => {
    const t = new Table(3);
    const x = t.game.put(0, bears());
    const y = t.game.put(0, vanilla('Ogre', 3, 3));
    t.handlers[0] = (_g, d) => (d.kind === 'attackers' ? [{ attacker: x.id, defender: 1 }, { attacker: y.id, defender: 2 }] : undefined);
    t.finishTurn();
    expect(t.game.players[1].life).toBe(38);
    expect(t.game.players[2].life).toBe(37);
  });
});

describe('rules engine: Commander rules and state-based actions', () => {
  it('charges commander tax and offers the command zone when the commander dies', () => {
    const t = new Table();
    const a = t.game.players[0];
    const commander = a.commandZone[0];
    t.lands(0, 10);
    const kill = spell('Murder', '{G}', 1, 'Instant', 'Destroy target creature.');
    a.hand.push(kill);
    expect(t.game.effectiveCost(a, commander, true)).toBe(4);
    let casts = 0;
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      const onBoard = a.battlefield.some((q) => q.isCommander);
      const i = onBoard ? find(d.actions, 'cast', 'Murder') : casts < 2 ? find(d.actions, 'cast', commander.name) : -1;
      if (i === -1) return undefined;
      if (!onBoard) casts++;
      return { action: i };
    };
    t.until((g) => casts === 1 && a.battlefield.some((q) => q.isCommander) && g.stack.length === 0);
    expect(a.battlefield.filter((q) => q.tapped)).toHaveLength(4);
    // Kill it with our own Murder: it goes back to the command zone and now costs 2 more.
    t.until(() => a.commandZone.length === 1 && casts === 1);
    expect(a.graveyard.map((c) => c.name)).toEqual(['Murder']);
    expect(t.game.effectiveCost(a, commander, true)).toBe(6);
  });

  it('21 combat damage from one commander eliminates a player', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    const commander = a.commandZone.pop()!;
    t.game.put(0, { ...commander, power: 21, toughness: 21 }, { commander: true });
    t.handlers[0] = attackAll(1);
    t.until(() => !b.alive);
    expect(b.life).toBe(19);
    expect(t.game.eliminations[0]).toMatchObject({ seat: 1, reason: 'commander', killer: 0 });
    t.until(() => false);
    expect(t.game.winner).toBe(0);
  });

  it('a player at 0 life loses, and drawing from an empty library loses', () => {
    const t = new Table(3);
    const [a, b, c] = t.game.players;
    b.life = 2;
    c.library = [];
    t.game.put(0, bears());
    t.handlers[0] = attackAll(1);
    t.until((g) => g.over);
    expect(b.alive).toBe(false);
    expect(c.alive).toBe(false);
    expect(t.game.eliminations.map((e) => e.reason)).toEqual(['combat', 'decked']);
    expect(t.game.winner).toBe(a.seat);
  });

  it('applies the legend rule', () => {
    const t = new Table();
    const legend: SimCard = creature('Captain', '{G}', 1, 3, 3, { superTypes: ['Legendary'] });
    t.game.put(0, legend);
    t.game.put(0, legend);
    t.finishTurn();
    expect(t.game.players[0].battlefield.filter((q) => q.card.name === 'Captain')).toHaveLength(1);
  });

  it('the first mulligan is free with three or more players, then one card goes to the bottom', () => {
    const decks = ['a', 'b', 'c'].map((id) => stompyDeck(id));
    const game = new Game(decks, 3);
    const flow = game.run();
    let next = flow.next();
    let asked = 0;
    let bottomed = 0;
    while (!next.done && game.turnNumber === 0) {
      const d = next.value;
      let answer = fallback(d);
      if (d.seat === 0 && d.kind === 'confirm' && d.reason === 'mulligan') answer = asked++ < 2;
      if (d.seat === 0 && d.kind === 'choose' && d.reason === 'bottom') bottomed = d.min;
      next = flow.next(answer);
    }
    expect(game.players[0].mulligans).toBe(2);
    expect(bottomed).toBe(1);
    expect(game.players[0].hand).toHaveLength(6 + 1); // six kept, plus the first draw
    expect(game.players[1].hand).toHaveLength(7);
  });

  it('Auras fall off with their creature and Equipment stays', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 6);
    t.lands(1, 1);
    const host = t.game.put(0, bears());
    a.hand.push(
      spell('Rancor', '{G}', 1, 'Enchantment', 'Enchant creature\nEnchanted creature gets +2/+0 and has trample.', { subTypes: ['Aura'] }),
      spell('Warhammer', '{1}', 1, 'Artifact', 'Equipped creature gets +3/+0 and has trample and lifelink.\nEquip {3}', { subTypes: ['Equipment'] }),
    );
    b.hand.push(spell('Murder', '{G}', 1, 'Instant', 'Destroy target creature.'));
    let equipped = false;
    t.handlers[0] = (g, d) => {
      if (d.kind === 'target') return { kind: 'perm', id: host.id };
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      const cast = d.actions.findIndex((x) => x.type === 'cast' && x.from === 'hand');
      if (cast !== -1) return { action: cast };
      const equip = d.actions.findIndex((x) => x.type === 'activate');
      if (equip !== -1 && !equipped) {
        equipped = true;
        return { action: equip };
      }
      return undefined;
    };
    t.until((g) => g.step === 'beginCombat');
    expect(t.game.power(host)).toBe(7);
    expect(t.game.hasKw(host, 'lifelink')).toBe(true);
    t.handlers[1] = castOnce('Murder');
    t.finishTurn();
    expect(a.graveyard.map((c) => c.name).sort()).toEqual(['Grizzly Bears', 'Rancor']);
    const hammer = a.battlefield.find((q) => q.card.name === 'Warhammer')!;
    expect(hammer.attachedTo).toBeNull();
  });

  it('when a player leaves, their spells and permanents leave with them and the game goes on', () => {
    const t = new Table(3);
    const [a, b, c] = t.game.players;
    b.life = 1;
    t.game.put(1, bears());
    t.game.put(0, bears());
    t.handlers[0] = attackAll(1);
    t.finishTurn();
    expect(b.alive).toBe(false);
    expect(b.battlefield).toHaveLength(0);
    expect(t.game.over).toBe(false);
    // The next turn belongs to seat 2, skipping the eliminated player.
    expect(t.game.activeSeat).toBe(c.seat);
    expect(a.alive && c.alive).toBe(true);
  });
});

describe('playing against bots', () => {
  it('stops for the person and lets bots play the rest', () => {
    const decks = ['me', 'b1', 'b2', 'b3'].map((id) => toolboxDeck(id));
    const session = new Session(decks, 11, 0);
    let asked = 0;
    for (let i = 0; i < 5000 && !session.result; i++) {
      session.run();
      const d = session.pending;
      if (!d) break;
      expect(d.seat).toBe(0);
      asked++;
      // Play like a bot would, to reach a natural end.
      session.answer(new BotClass(0, 11).decide(session.game, d));
    }
    expect(session.result).not.toBeNull();
    expect(asked).toBeGreaterThan(10);
    expect(session.game.log!.length).toBeGreaterThan(50);
  });

  it('a cast can be taken back at the target prompt without paying', () => {
    const decks = ['me', 'b1'].map((id) => stompyDeck(id));
    const session = new Session(decks, 4, 0, { fullControl: true, startSeat: 0 });
    session.run();
    // Keep the hand, then set the table up by hand.
    while (session.pending && session.pending.kind !== 'priority') {
      session.answer(fallback(session.pending));
      session.run();
    }
    const g = session.game;
    const me = g.players[0];
    while (session.pending && !(g.step === 'main1' && g.activeSeat === 0)) {
      session.answer(fallback(session.pending));
      session.run();
    }
    me.hand = [spell('Murder', '{G}', 1, 'Instant', 'Destroy target creature.')];
    me.battlefield = [];
    g.put(0, forest());
    g.put(1, bears());
    session.answer({ action: 0 });
    session.run();
    while (session.pending && find((session.pending as Extract<Decision, { kind: 'priority' }>).actions ?? [], 'cast', 'Murder') === -1) {
      session.answer(fallback(session.pending));
      session.run();
    }
    const d = session.pending as Extract<Decision, { kind: 'priority' }>;
    session.answer({ action: find(d.actions, 'cast', 'Murder') });
    session.run();
    expect(session.pending?.kind).toBe('target');
    session.answer(null);
    session.run();
    expect(me.hand.map((c) => c.name)).toEqual(['Murder']);
    expect(me.battlefield.every((q) => !q.tapped)).toBe(true);
    expect(session.pending?.kind).toBe('priority');
  });
});
