// Mutate, face-down creatures (manifest, morph) and transforming double-faced cards.

import { describe, expect, it } from 'vitest';
import type { SimDeck } from '../src/engine/types';
import { Game } from '../src/rules/game';
import type { Action, Answer, Decision } from '../src/rules/types';
import { card, creature, forest, spell, stompyDeck } from './helpers';

// The same scripted-table harness as rules.test.ts: every seat passes and
// declines unless a handler says otherwise.
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

type Cast = Extract<Action, { type: 'cast' }>;
const findCast = (actions: Action[], name: string, mutate: boolean) =>
  actions.findIndex((a) => a.type === 'cast' && a.card.name === name && !!a.mutate === mutate);

/** Cast `name` once, for its mutate cost or not, onto whatever `onto` picks. */
function castOnce(name: string, mutate = false, choose?: number[]): Handler {
  let done = false;
  return (_g, d) => {
    if (d.kind === 'choose' && d.reason === 'mutate' && choose) return choose;
    if (done || d.kind !== 'priority') return undefined;
    const i = findCast(d.actions, name, mutate);
    if (i === -1) return undefined;
    done = true;
    return { action: i };
  };
}

const gemrazer = () => creature('Gemrazer', '{3}{G}', 4, 4, 4, {
  keywords: ['Reach', 'Trample'],
  text: 'Mutate {1}{G}{G} (If you cast this spell for its mutate cost, put it over or under target non-Human creature you own. They mutate into the creature on top plus all abilities from under it.)\nReach, trample\nWhenever this creature mutates, destroy target artifact or enchantment an opponent controls.',
});
const egg = () => creature('Mysterious Egg', '{1}', 1, 0, 2, { text: 'Whenever this creature mutates, put a +1/+1 counter on it.' });
const relic = () => spell('Relic', '{1}', 1, 'Artifact', '');

describe('mutate', () => {
  it('reads mutate costs and "whenever this creature mutates" triggers', () => {
    const g = gemrazer();
    expect(g.mutate?.cost).toMatchObject({ generic: 1, pips: [['G'], ['G']] });
    expect(g.effects).toEqual([expect.objectContaining({ kind: 'removal', when: 'mutates', scope: 'self' })]);
    expect(g.effects[0].chance).toBeUndefined();
    expect(g.unread ?? []).toEqual([]);
    const symbiote = creature('Essence Symbiote', '{1}{G}', 2, 2, 2, { text: 'Whenever a creature you control mutates, put a +1/+1 counter on that creature and you gain 2 life.' });
    expect(symbiote.effects.map((e) => [e.kind, e.when, e.scope])).toEqual([['counters', 'mutates', 'any'], ['gainLife', 'mutates', 'any']]);
    const pollywog = creature('Pollywog Symbiote', '{1}{U}', 2, 1, 3, { text: 'Each creature spell you cast costs {1} less to cast if it has mutate.\nWhenever you cast a creature spell, if it has mutate, draw a card, then discard a card.' });
    expect(pollywog.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'costReduction', filter: 'mutate' }),
      expect.objectContaining({ kind: 'draw', when: 'cast', castFilter: 'mutate' }),
    ]));
    expect(pollywog.effects.find((e) => e.kind === 'draw')?.chance).toBeUndefined();
    const brokkos = creature('Brokkos, Apex of Forever', '{2}{B}{G}{U}', 5, 6, 6, { text: 'Mutate {2}{U/B}{G}{G}\nTrample\nYou may cast this card from your graveyard using its mutate ability.' });
    expect(brokkos.mutate?.fromGraveyard).toBe(true);
  });

  it('cast normally, a mutate creature is an ordinary creature and its mutate trigger never fires', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 4);
    const artifact = t.game.put(1, relic());
    a.hand.push(gemrazer());
    t.handlers[0] = castOnce('Gemrazer');
    t.finishTurn();
    expect(a.battlefield.map((q) => q.card.name)).toContain('Gemrazer');
    expect(b.battlefield).toContain(artifact);
  });

  it('merges onto a creature: one permanent, top card body, all abilities, trigger fires, not summoning sick', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    const host = t.game.put(0, creature('Ram', '{1}{G}', 2, 2, 2, { text: 'Flying', keywords: ['Flying'] }), { counters: 1 });
    const artifact = t.game.put(1, relic());
    a.hand.push(gemrazer());
    t.handlers[0] = castOnce('Gemrazer', true, [0]);
    t.finishTurn();
    const creatures = a.battlefield.filter((q) => q.card.isCreature);
    expect(creatures).toHaveLength(1);
    expect(creatures[0]).toBe(host);
    expect(host.card.name).toBe('Gemrazer');
    expect(t.game.power(host)).toBe(5); // 4/4 on top, plus the counter it kept
    expect(t.game.hasKw(host, 'flying')).toBe(true);
    expect(t.game.hasKw(host, 'trample')).toBe(true);
    expect(host.sick).toBe(false);
    expect(b.battlefield).not.toContain(artifact);
    expect(t.game.log!.some((l) => /mutates onto Ram/.test(l))).toBe(true);
  });

  it('under: keeps the old body, adds the abilities, and every mutate trigger fires again on later mutates', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 6);
    const host = t.game.put(0, creature('Ram', '{1}{G}', 2, 2, 2));
    const relics = [t.game.put(1, relic()), t.game.put(1, relic())];
    a.hand.push(gemrazer(), creature('Sea-Dasher Octopus', '{1}{U}{U}', 3, 3, 3, { text: 'Mutate {1}{G}\nFlash\nWhenever this creature deals combat damage to a player, draw a card.' }));
    t.handlers[0] = (g, d) => {
      if (d.kind === 'choose' && d.reason === 'mutate') return [1];
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      const next = !host.parts ? 'Gemrazer' : host.parts.length === 2 ? 'Sea-Dasher Octopus' : null;
      const i = next ? findCast(d.actions, next, true) : -1;
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(host.parts?.map((x) => x.face.name)).toEqual(['Ram', 'Gemrazer', 'Sea-Dasher Octopus']);
    expect(host.card.name).toBe('Ram');
    expect(t.game.power(host)).toBe(2);
    expect(t.game.hasKw(host, 'trample')).toBe(true);
    // Gemrazer's trigger is part of the merged creature, so the Octopus mutating sets it off again.
    expect(b.battlefield.filter((q) => relics.includes(q))).toHaveLength(0);
  });

  it('the Egg grows each time something mutates onto it', () => {
    const t = new Table();
    const a = t.game.players[0];
    t.lands(0, 6);
    const host = t.game.put(0, egg());
    a.hand.push(gemrazer(), creature('Dirge Bat', '{2}{B}{B}', 4, 3, 3, { text: 'Mutate {4}{B}{B}\nFlash\nFlying' }));
    t.handlers[0] = castOnce('Gemrazer', true, [1]);
    t.finishTurn();
    expect(host.card.name).toBe('Mysterious Egg');
    expect(host.counters).toBe(1);
    expect(t.game.power(host)).toBe(1);
    expect(t.game.hasKw(host, 'trample')).toBe(true);
  });

  it('can only mutate onto a non-Human creature you own', () => {
    const t = new Table();
    const a = t.game.players[0];
    t.lands(0, 3);
    t.game.put(0, creature('Soldier', '{W}', 1, 1, 1, { subTypes: ['Human', 'Soldier'] }));
    t.game.put(1, creature('Theirs', '{G}', 1, 2, 2));
    a.hand.push(gemrazer());
    let offered: Cast[] = [];
    t.handlers[0] = (_g, d) => {
      if (d.kind === 'priority') offered = d.actions.filter((x): x is Cast => x.type === 'cast');
      return undefined;
    };
    t.until((g) => g.step === 'main1' && offered.length > 0);
    expect(offered.some((x) => x.mutate)).toBe(false);
  });

  it('the whole merged permanent dies together; a commander inside goes to the command zone', () => {
    const t = new Table();
    const a = t.game.players[0];
    t.lands(0, 3);
    const commander = a.commandZone[0];
    const host = t.game.put(0, commander, { commander: true });
    a.hand.push(gemrazer());
    t.handlers[0] = castOnce('Gemrazer', true, [0]);
    t.finishTurn();
    expect(host.isCommander).toBe(true);
    expect(host.card.name).toBe('Gemrazer');
    host.damage = 99;
    t.finishTurn();
    expect(a.graveyard.map((c) => c.name)).toContain('Gemrazer');
    expect(a.commandZone).toContain(commander);
  });

  it('enters as an ordinary creature when its target is gone', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 3);
    t.lands(1, 1);
    const host = t.game.put(0, creature('Ram', '{1}{G}', 2, 2, 2));
    a.hand.push(gemrazer());
    b.hand.push(spell('Murder', '{G}', 1, 'Instant', 'Destroy target creature.'));
    t.handlers[0] = castOnce('Gemrazer', true);
    t.handlers[1] = (g, d) => {
      if (d.kind === 'target') return { kind: 'perm', id: host.id };
      if (d.kind !== 'priority' || g.stack.length !== 1 || g.stack[0].mutateOnto === undefined) return undefined;
      const i = d.actions.findIndex((x) => x.type === 'cast' && x.card.name === 'Murder');
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(a.graveyard.map((c) => c.name)).toContain('Ram');
    const gem = a.battlefield.find((q) => q.card.name === 'Gemrazer');
    expect(gem).toBeDefined();
    expect(gem!.parts).toBeUndefined();
    expect(gem!.sick).toBe(true);
  });
});

const haruspex = () => creature('Grim Haruspex', '{2}{B}', 3, 3, 2, { text: 'Morph {G} (You may cast this card face down as a 2/2 creature for {3}. Turn it face up any time for its morph cost.)\nWhenever another nontoken creature you control dies, draw a card.' });

describe('face-down creatures', () => {
  it('reads morph, disguise and manifest wordings', () => {
    const h = haruspex();
    expect(h.morph?.cost).toMatchObject({ generic: 0, pips: [['G']] });
    expect(h.unread ?? []).toEqual([]);
    const shift = spell('Reality Shift', '{1}{U}', 2, 'Instant', 'Exile target creature. Its controller manifests the top card of their library.');
    expect(shift.effects.map((e) => e.kind)).toEqual(['removal', 'manifest']);
    const fear = creature('Fear of Impostors', '{1}{U}{U}', 3, 3, 2, { text: 'Flash\nWhen this creature enters, counter target spell. Its controller manifests dread.' });
    expect(fear.effects).toEqual([expect.objectContaining({ kind: 'counter' }), expect.objectContaining({ kind: 'manifest', who: 'targetController', dread: true })]);
    const masked = creature('Masked Thing', '{2}{G}', 3, 3, 3, { text: 'Disguise {1}{G}\nWhen this creature is turned face up, draw a card.' });
    expect(masked.morph?.ward).toBe(true);
    expect(masked.effects).toEqual([expect.objectContaining({ kind: 'draw', when: 'turnedFaceUp' })]);
  });

  it('casts a morph face down for {3} as a nameless 2/2, then turns it face up for its morph cost', () => {
    const t = new Table();
    const a = t.game.players[0];
    t.lands(0, 4);
    a.hand.push(haruspex());
    let cast = false;
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      if (!cast) {
        const i = d.actions.findIndex((x) => x.type === 'cast' && x.faceDown);
        if (i === -1) return undefined;
        cast = true;
        return { action: i };
      }
      return undefined;
    };
    t.until((g) => cast && g.stack.length === 0 && a.battlefield.some((q) => q.faceDown));
    const perm = a.battlefield.find((q) => q.faceDown)!;
    expect(perm.card.name).toBe('Face-down creature');
    expect(t.game.power(perm)).toBe(2);
    expect(perm.card.effects).toEqual([]);
    expect(a.battlefield.filter((q) => q.tapped)).toHaveLength(3);
    // The one land left pays the morph cost.
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority') return undefined;
      const i = d.actions.findIndex((x) => x.type === 'turnFaceUp');
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(perm.faceDown).toBeUndefined();
    expect(perm.card.name).toBe('Grim Haruspex');
    expect(t.game.power(perm)).toBe(3);
  });

  it('a face-down creature that dies goes to the graveyard as its real card', () => {
    const t = new Table();
    const a = t.game.players[0];
    t.lands(0, 3);
    a.hand.push(haruspex());
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      const i = d.actions.findIndex((x) => x.type === 'cast' && x.faceDown);
      return i === -1 ? undefined : { action: i };
    };
    t.until((g) => g.stack.length === 0 && a.battlefield.some((q) => q.faceDown));
    a.battlefield.find((q) => q.faceDown)!.damage = 5;
    t.finishTurn();
    expect(a.graveyard.map((c) => c.name)).toContain('Grim Haruspex');
  });

  it("Reality Shift exiles a creature and its controller manifests the top of their library", () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(0, 2);
    const victim = t.game.put(1, creature('Big', '{G}', 1, 6, 6));
    const top = b.library[0];
    a.hand.push(spell('Reality Shift', '{1}{G}', 2, 'Instant', 'Exile target creature. Its controller manifests the top card of their library.'));
    t.handlers[0] = castOnce('Reality Shift');
    t.finishTurn();
    expect(b.exile.map((c) => c.name)).toContain('Big');
    expect(b.battlefield).not.toContain(victim);
    const manifested = b.battlefield.find((q) => q.faceDown);
    expect(manifested?.faceDown).toBe(top);
    expect(manifested && t.game.power(manifested)).toBe(2);
  });

  it("Thieving Amalgam manifests the top of each opponent's library under its controller", () => {
    const t = new Table(3);
    const a = t.game.players[0];
    t.game.put(0, creature('Thieving Amalgam', '{5}{B}{B}', 7, 6, 7, { text: "At the beginning of each opponent's upkeep, you manifest the top card of that player's library." }));
    t.until((g) => g.turnNumber > 3 && g.activeSeat === 0 && g.step === 'main1');
    const stolen = a.battlefield.filter((q) => q.faceDown);
    expect(stolen.slice(0, 2).map((q) => q.owner)).toEqual([1, 2]);
    expect(stolen.length % 2).toBe(0);
    expect(stolen.every((q) => q.owner !== undefined)).toBe(true);
    // A manifested creature card can be turned face up for its mana cost; anything else can't.
    for (const q of stolen) expect(t.game.faceUpCost(q) !== null).toBe(q.faceDown!.isCreature);
  });
});

const dfc = (name: string, front: Partial<Parameters<typeof card>[0]>, back: NonNullable<Parameters<typeof card>[0]['back']>) =>
  card({ name: `${name} // ${back.name}`, layout: 'transform', colorIdentity: ['G'], ...front, back });

describe('transforming double-faced cards', () => {
  it('reads the back face, and a transforming land back is not a land you can play from hand', () => {
    const ojer = dfc('Ojer Axonil, Deepest Might', { manaCost: '{2}{G}{G}', cmc: 4, types: ['Creature'], superTypes: ['Legendary'], power: '4', toughness: '4', text: 'Trample\nWhen Ojer Axonil dies, return it to the battlefield tapped and transformed under its owner\'s control.' },
      { name: 'Temple of Power', types: ['Land'], subTypes: [], text: '{T}: Add {G}.' });
    expect(ojer.backLand).toBeUndefined();
    expect(ojer.back?.isLand).toBe(true);
    expect(ojer.effects).toEqual([expect.objectContaining({ kind: 'transform', fromGraveyard: true, tapped: true, when: 'creatureDies' })]);
    const mdfc = card({ name: 'Bridge // Land', layout: 'modal_dfc', manaCost: '{1}{G}', cmc: 2, types: ['Sorcery'], text: 'Draw a card.', back: { name: 'Land', types: ['Land'], subTypes: [], text: '{T}: Add {G}.' } });
    expect(mdfc.backLand).toBeDefined();
    expect(mdfc.back).toBeUndefined();
  });

  it('a "when this dies, return it transformed" creature comes back as its land', () => {
    const t = new Table();
    const [a, b] = t.game.players;
    t.lands(1, 1);
    const ojer = dfc('Ojer Axonil, Deepest Might', { types: ['Creature'], power: '4', toughness: '4', text: 'When Ojer Axonil dies, return it to the battlefield tapped and transformed under its owner\'s control.' },
      { name: 'Temple of Power', types: ['Land'], subTypes: [], text: '{T}: Add {G}.' });
    const perm = t.game.put(0, ojer);
    b.hand.push(spell('Murder', '{G}', 1, 'Instant', 'Destroy target creature.'));
    t.handlers[1] = (g, d) => {
      if (d.kind !== 'priority' || g.activeSeat !== 0 || g.stack.length) return undefined;
      const i = d.actions.findIndex((x) => x.type === 'cast' && x.card.name === 'Murder');
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(a.battlefield).not.toContain(perm);
    const temple = a.battlefield.find((q) => q.card.name === 'Temple of Power');
    expect(temple?.landInfo).toBeDefined();
    expect(temple?.tapped).toBe(true);
    expect(temple?.front).toBe(ojer);
    expect(a.graveyard).not.toContain(ojer);
  });

  it('an upkeep transform waits for its condition, then flips in place', () => {
    const t = new Table();
    const captain = dfc('Hanweir Militia Captain', { types: ['Creature'], power: '2', toughness: '2', text: 'At the beginning of your upkeep, if you control four or more creatures, transform this creature.' },
      { name: 'Westvale Cult Leader', types: ['Creature'], subTypes: ['Human', 'Cleric'], text: "Westvale Cult Leader's power and toughness are each equal to the number of creatures you control.", power: '*', toughness: '*' });
    expect(captain.effects).toEqual([expect.objectContaining({ kind: 'transform', when: 'upkeep', cond: { count: 'creatures', n: 4 } })]);
    expect(captain.effects[0].chance).toBeUndefined();
    const perm = t.game.put(0, captain);
    t.game.put(0, creature('Bear', '{G}', 1, 2, 2));
    // Two creatures: no transform at the next upkeep.
    t.until((g) => g.turnNumber === 3);
    t.until((g) => g.activeSeat === 0 && g.step === 'main1');
    expect(perm.card.name).toBe('Hanweir Militia Captain // Westvale Cult Leader');
    t.game.put(0, creature('Bear', '{G}', 1, 2, 2));
    t.game.put(0, creature('Bear', '{G}', 1, 2, 2));
    const turn = t.game.turnNumber;
    t.until((g) => g.turnNumber > turn + 1 && g.activeSeat === 0 && g.step === 'main1');
    expect(perm.card.name).toBe('Westvale Cult Leader');
    expect(perm.front).toBe(captain);
    expect(t.game.power(perm)).toBe(4);
  });

  it('an activated "exile it, then return it transformed" brings back the other face as a new permanent', () => {
    const t = new Table();
    const a = t.game.players[0];
    t.lands(0, 2);
    const clive = dfc('Clive, Ifrit\'s Dominant', { types: ['Creature'], superTypes: ['Legendary'], power: '5', toughness: '5', text: '{1}{G}, {T}: Exile Clive, then return it to the battlefield transformed under its owner\'s control. Activate only as a sorcery.' },
      { name: 'Ifrit, Warden of Inferno', types: ['Creature'], subTypes: ['Demon'], text: 'Flying\nWhen Ifrit enters, draw two cards.', power: '6', toughness: '6' });
    const perm = t.game.put(0, clive, { commander: true });
    const hand = a.hand.length;
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      const i = d.actions.findIndex((x) => x.type === 'activate' && x.effect.kind === 'transform');
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(a.battlefield).not.toContain(perm);
    const ifrit = a.battlefield.find((q) => q.card.name === 'Ifrit, Warden of Inferno');
    expect(ifrit?.front).toBe(clive);
    expect(ifrit?.isCommander).toBe(true);
    expect(ifrit && t.game.power(ifrit)).toBe(6);
    expect(a.hand.length).toBe(hand + 2);
    expect(a.commandZone).not.toContain(clive);
  });

  it("a rider transform goes off with the ability it is part of (Jace, Vryn's Prodigy)", () => {
    const t = new Table();
    const a = t.game.players[0];
    const jace = dfc('Jace, Vryn\'s Prodigy', { types: ['Creature'], power: '0', toughness: '2', text: '{T}: Draw a card, then discard a card. If there are five or more cards in your graveyard, exile Jace, then return him to the battlefield transformed under his owner\'s control.' },
      { name: 'Jace, Telepath Unbound', types: ['Planeswalker'], subTypes: ['Jace'], text: '+1: Up to one target creature gets -2/-0 until your next turn.', loyalty: 5 });
    const perm = t.game.put(0, jace);
    let offered: Action[] = [];
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'priority' || g.stack.length) return undefined;
      offered = d.actions;
      const i = d.actions.findIndex((x) => x.type === 'activate');
      return i === -1 ? undefined : { action: i };
    };
    a.graveyard.push(...a.library.splice(0, 5));
    t.finishTurn();
    expect(offered.filter((x) => x.type === 'activate' && x.effect.kind === 'transform')).toHaveLength(0);
    expect(a.battlefield).not.toContain(perm);
    const walker = a.battlefield.find((q) => q.card.name === 'Jace, Telepath Unbound');
    expect(walker?.loyalty).toBe(5);
  });
});

void card;
