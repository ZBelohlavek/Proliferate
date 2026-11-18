// Goad, blink, untap effects, Sagas, Classes, copying spells and alternative costs.

import { describe, expect, it } from 'vitest';
import type { SimDeck } from '../src/engine/types';
import { Bot } from '../src/rules/bot';
import { Game } from '../src/rules/game';
import type { Action, Answer, Decision } from '../src/rules/types';
import { card, creature, forest, spell, stompyDeck } from './helpers';

// The same small harness as in rules.test.ts: every seat passes and declines
// unless a handler says otherwise.
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
  private stale = true;
  handlers: Record<number, Handler> = {};

  constructor(players = 2) {
    const decks: SimDeck[] = Array.from({ length: players }, (_, i) => stompyDeck(`p${i}`));
    this.game = new Game(decks, 1, { log: true });
    this.flow = this.game.run();
    this.next = this.flow.next();
    this.stale = false;
    this.until((g) => g.step === 'main1');
    for (const p of this.game.players) {
      p.hand = [];
      p.battlefield = [];
    }
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

  finishTurn() {
    const turn = this.game.turnNumber;
    this.until((g) => g.turnNumber !== turn);
  }

  lands(seat: number, n: number) {
    for (let i = 0; i < n; i++) this.game.put(seat, forest());
  }
}

const island = () => card({ name: 'Island', types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], colorIdentity: ['U'] });
const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);

/** Take the first action matching `match` the first time it is offered. */
function once(match: (a: Action) => boolean): Handler {
  let done = false;
  return (_g, d) => {
    if (done || d.kind !== 'priority') return undefined;
    const i = d.actions.findIndex(match);
    if (i === -1) return undefined;
    done = true;
    return { action: i };
  };
}
const castOnce = (name: string, from?: string) => once((a) => a.type === 'cast' && a.card.name === name && (from === undefined || a.from === from));

describe('goad', () => {
  it('reads the goad wordings in real decks', () => {
    expect(spell('Disrupt Decorum', '{2}{R}{R}', 4, 'Sorcery', "Goad all creatures you don't control.").effects[0]).toMatchObject({ kind: 'goad', all: true });
    const quasit = creature('Bothersome Quasit', '{1}{R}', 2, 3, 2, { text: 'Menace\nWhenever you cast a noncreature spell, goad target creature an opponent controls.' });
    expect(quasit.effects[0]).toMatchObject({ kind: 'goad', all: false, when: 'cast', castFilter: 'noncreature' });
    const baeloth = creature('Baeloth Barrityl, Entertainer', '{4}{R}', 5, 2, 5, { text: "Creatures your opponents control with power less than Baeloth Barrityl's power are goaded." });
    expect(baeloth.effects[0]).toMatchObject({ kind: 'goad', weaker: true, when: 'static' });
  });

  it('a goaded creature must attack, and must attack someone other than the goader', () => {
    const t = new Table(3);
    const [a, b, c] = t.game.players;
    t.lands(0, 4);
    a.hand.push(spell('Disrupt Decorum', '{2}{G}{G}', 4, 'Sorcery', "Goad all creatures you don't control."));
    const goaded = t.game.put(1, bears());
    t.handlers[0] = castOnce('Disrupt Decorum');
    t.finishTurn();
    expect(goaded.goadedBy).toEqual([0]);
    // Seat 1 declares no attackers; the engine sends the Bears at seat 2, not at seat 0 who goaded them.
    t.until((g) => g.activeSeat === 2);
    expect(c.life).toBe(38);
    expect(a.life).toBe(40);
    expect(b.life).toBe(40);
    // The goad ends when seat 0's next turn begins.
    t.until((g) => g.activeSeat === 0 && g.step === 'main1');
    expect(goaded.goadedBy).toBeUndefined();
  });

  it('static goad only covers creatures weaker than its source', () => {
    const t = new Table(3);
    t.game.put(0, creature('Baeloth Barrityl, Entertainer', '{4}{R}', 5, 2, 5, { text: "Creatures your opponents control with power less than Baeloth Barrityl's power are goaded." }));
    const small = t.game.put(1, creature('Elf', '{G}', 1, 1, 1));
    const big = t.game.put(1, creature('Giant', '{G}', 1, 4, 4));
    expect(t.game.goaders(small)).toEqual([0]);
    expect(t.game.goaders(big)).toEqual([]);
  });
});

describe('blink and untap', () => {
  it('a blinked creature enters again: enters abilities happen, counters and damage are gone', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    const drifter = creature('Mulldrifter', '{4}{U}', 5, 2, 2, { text: 'Flying\nWhen this creature enters, draw two cards.', keywords: ['Flying'] });
    const perm = t.game.put(0, drifter, { counters: 2 });
    a.hand.push(spell('Cloudshift', '{G}', 1, 'Instant', 'Exile target creature you control, then return that card to the battlefield under your control.'));
    t.handlers[0] = castOnce('Cloudshift');
    t.until(() => a.hand.length === 2);
    const back = a.battlefield.find((q) => q.card === drifter)!;
    expect(back).toBeDefined();
    expect(back.id).not.toBe(perm.id);
    expect(back.counters).toBe(0);
    expect(a.battlefield).not.toContain(perm);
    expect(t.game.log!.join('\n')).toContain('is exiled and returns');
  });

  it('reads blink wordings: repeated, two targets, and any number', () => {
    const closet = spell("Conjurer's Closet", '{5}', 5, 'Artifact', 'At the beginning of your end step, you may exile target creature you control, then return that card to the battlefield under your control.');
    expect(closet.effects[0]).toMatchObject({ kind: 'blink', n: 1, what: 'creature', when: 'upkeep' });
    const flicker = spell('Ghostly Flicker', '{2}{U}', 3, 'Instant', 'Exile two target artifacts, creatures, and/or lands you control, then return those cards to the battlefield under your control.');
    expect(flicker.effects[0]).toMatchObject({ kind: 'blink', n: 2, what: 'permanent' });
  });

  it('untap effects: lands as a creature enters, and permanents during other players\' untap steps', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 5);
    a.hand.push(creature('Peregrine Drake', '{4}{G}', 5, 2, 3, { text: 'Flying\nWhen this creature enters, untap up to five lands.', keywords: ['Flying'] }));
    t.handlers[0] = castOnce('Peregrine Drake');
    t.until(() => a.battlefield.some((q) => q.card.name === 'Peregrine Drake') && t.game.stack.length === 0);
    expect(a.battlefield.filter((q) => q.landInfo && q.tapped)).toHaveLength(0);

    const muster = card({ name: 'Seedborn Muster', manaCost: '{2}{G}{G}', cmc: 4, types: ['Creature'], power: '2', toughness: '4', text: "Untap all permanents you control during each other player's untap step." });
    expect(muster.effects[0]).toMatchObject({ kind: 'untapAlways', what: 'all' });
    t.game.put(1, muster);
    const land = t.game.put(1, forest(), { tapped: true });
    t.until((g) => g.activeSeat === 0 && g.turnNumber > 2);
    expect(t.game.turnNumber).toBe(3);
    expect(land.tapped).toBe(false);
    expect(b.battlefield).toContain(land);
  });
});

describe('Sagas and Classes', () => {
  const saga = () => spell('The Test Saga', '{1}{G}', 2, 'Enchantment', '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Draw a card.\nII — You gain 3 life.\nIII — Create a 3/3 green Beast creature token.', { subTypes: ['Saga'] });

  it('reads chapters', () => {
    const s = saga();
    expect(s.saga).toBe(3);
    expect(s.effects.map((e) => [e.kind, e.when, e.chapters])).toEqual([['draw', 'chapter', [1]], ['gainLife', 'chapter', [2]], ['tokens', 'chapter', [3]]]);
    const shared = spell('Summon: Test', '{2}{G}', 3, 'Enchantment Creature', 'I, II — Crescent Fang — Draw a card.\nIII — You gain 3 life.', { subTypes: ['Saga'], power: '3', toughness: '3' });
    expect(shared.effects[0]).toMatchObject({ kind: 'draw', chapters: [1, 2] });
    expect(shared.saga).toBe(3);
  });

  it('a Saga does one chapter a turn and is sacrificed after the last', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    const s = saga();
    a.hand.push(s);
    t.handlers[0] = castOnce('The Test Saga');
    t.finishTurn();
    expect(a.hand).toHaveLength(1);
    const perm = a.battlefield.find((q) => q.card === s)!;
    expect(perm.lore).toBe(1);
    // Lore counter 2 comes in seat 0's next precombat main phase, not before.
    t.until(() => !a.battlefield.includes(perm));
    const log = t.game.log!;
    const at = (text: string) => log.findIndex((l) => l.includes(text));
    expect(at('lore counter 2')).toBeGreaterThan(at('Round 2, Commander p0'));
    expect(at('lore counter 3')).toBeGreaterThan(at('Round 3, Commander p0'));
    expect(a.life).toBe(43);
    expect(a.battlefield.some((q) => q.token && q.card.power === 3)).toBe(true);
    expect(a.battlefield).not.toContain(perm);
    expect(a.graveyard).toContain(s);
  });

  it('a Class gains levels as a sorcery, and each level adds its abilities', () => {
    const wizard = spell('Wizard Class', '{G}', 1, 'Enchantment', '(Gain the next level as a sorcery to add its ability.)\nYou have no maximum hand size.\n{2}{G}: Level 2\nWhen this Class becomes level 2, draw two cards.\n{4}{G}: Level 3\nWhenever you draw a card, put a +1/+1 counter on target creature you control.', { subTypes: ['Class'] });
    expect(wizard.effects.map((e) => e.kind)).toEqual(['noMaxHand']);
    expect(wizard.levels?.map((l) => [l.level, l.cost.generic, l.effects.map((e) => e.kind)])).toEqual([[2, 2, ['draw']], [3, 4, ['counters']]]);
    expect(wizard.unread).toBeUndefined();

    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 8);
    const perm = t.game.put(0, wizard);
    const bear = t.game.put(0, bears());
    let levels = 0;
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority' || levels >= 2) return undefined;
      const i = d.actions.findIndex((x) => x.type === 'level');
      if (i === -1) return undefined;
      levels++;
      return { action: i };
    };
    t.until(() => perm.level === 3);
    expect(a.hand).toHaveLength(2);
    expect(perm.card.effects.some((e) => e.kind === 'counters' && e.when === 'draw')).toBe(true);
    // Level 3: drawing puts a counter on a creature.
    t.until((g) => g.activeSeat === 0 && g.step === 'main1');
    expect(bear.counters).toBeGreaterThan(0);
  });
});

describe('copying spells', () => {
  it('"whenever you cast ..., copy that spell" copies it', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    t.game.put(0, spell('Echo Chamber', '{3}', 3, 'Enchantment', 'Whenever you cast an instant or sorcery spell, copy that spell.'));
    a.hand.push(spell('Ponder', '{G}', 1, 'Sorcery', 'Draw a card.'));
    t.handlers[0] = castOnce('Ponder');
    t.until(() => a.graveyard.length === 1);
    expect(a.hand).toHaveLength(2);
    // The copy isn't a card: only the Ponder itself goes to the graveyard.
    expect(a.graveyard.map((c) => c.name)).toEqual(['Ponder']);
  });

  it('a copy of a permanent spell becomes a token', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    t.game.put(0, spell('Creature Echo', '{3}', 3, 'Enchantment', 'Whenever you cast a creature spell, copy that spell.'));
    a.hand.push(bears());
    t.handlers[0] = castOnce('Grizzly Bears');
    t.finishTurn();
    const bearsOut = a.battlefield.filter((q) => q.card.name === 'Grizzly Bears');
    expect(bearsOut).toHaveLength(2);
    expect(bearsOut.filter((q) => q.token)).toHaveLength(1);
  });

  it('a bot copies an opponent\'s card draw with Twincast', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 1);
    t.lands(1, 2);
    a.hand.push(spell('Big Draw', '{G}', 1, 'Sorcery', 'Draw three cards.'));
    b.hand.push(spell('Twincast', '{G}{G}', 2, 'Instant', 'Copy target instant or sorcery spell. You may choose new targets for the copy.', { colorIdentity: ['U'] }));
    const bot = new Bot(1, 1);
    t.handlers[0] = castOnce('Big Draw');
    t.handlers[1] = (g, d) => bot.decide(g, d);
    t.until(() => a.hand.length === 3);
    expect(b.hand).toHaveLength(3);
  });
});

describe('alternative costs', () => {
  it('reads Force of Will, Daze, evoke and dash', () => {
    const fow = spell('Force of Will', '{3}{U}{U}', 5, 'Instant', "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.");
    expect(fow.altCost).toMatchObject({ pitch: 'U', life: 1 });
    expect(fow.unread).toBeUndefined();
    expect(spell('Daze', '{1}{U}', 2, 'Instant', "You may return an Island you control to its owner's hand rather than pay this spell's mana cost.\nCounter target spell unless its controller pays {1}.").altCost).toMatchObject({ returnIslands: 1 });
    expect(creature('Mulldrifter', '{4}{U}', 5, 2, 2, { text: 'Flying\nWhen this creature enters, draw two cards.\nEvoke {2}{U}' }).altCost).toMatchObject({ evoke: true, mana: { generic: 2 } });
    expect(creature('Ragavan, Nimble Pilferer', '{R}', 1, 2, 1, { text: 'Dash {1}{R}' }).altCost).toMatchObject({ dash: true });
  });

  it('Force of Will counters a spell for a blue card and 1 life', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    a.hand.push(bears());
    const fodder = spell('Blue Thing', '{1}{U}', 2, 'Sorcery', 'Draw a card.');
    b.hand.push(spell('Force of Will', '{3}{U}{U}', 5, 'Instant', "You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell."), fodder);
    t.handlers[0] = castOnce('Grizzly Bears');
    t.handlers[1] = (g, d) => (g.stack.length ? castOnce('Force of Will', 'alt')(g, d) : undefined);
    t.until(() => a.graveyard.length === 1);
    expect(a.graveyard[0].name).toBe('Grizzly Bears');
    expect(b.exile).toContain(fodder);
    expect(b.life).toBe(39);
  });

  it('evoke: the creature does its enters ability and is sacrificed', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    const drifter = creature('Mulldrifter', '{4}{U}', 5, 2, 2, { text: 'Flying\nWhen this creature enters, draw two cards.\nEvoke {2}{U}', keywords: ['Flying'], colorIdentity: ['U'] });
    a.hand.push(drifter);
    t.game.put(0, island());
    t.handlers[0] = castOnce('Mulldrifter', 'alt');
    t.until(() => a.hand.length === 2);
    expect(a.graveyard).toContain(drifter);
    expect(a.battlefield.some((q) => q.card === drifter)).toBe(false);
  });

  it('dash: the creature has haste and returns to hand at the end step', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    const raider = creature('Dash Raider', '{2}{G}', 3, 3, 3, { text: 'Dash {1}{G}' });
    a.hand.push(raider);
    t.handlers[0] = (g, d) => (d.kind === 'attackers' ? d.candidates.map((attacker) => ({ attacker, defender: 1 })) : castOnce('Dash Raider', 'alt')(g, d));
    t.finishTurn();
    expect(b.life).toBe(37);
    expect(a.hand).toContain(raider);
  });
});
