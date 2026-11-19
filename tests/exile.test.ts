import { describe, expect, it } from 'vitest';
import type { SimCard } from '../src/engine/types';
import type { Game } from '../src/rules/game';
import type { Action, Decision } from '../src/rules/types';
import { creature, forest, spell } from './helpers';
import { castOnce, Table, type Handler } from './table';

// Playing cards from exile and the top of a library (rule 611.2), casting spells without paying their mana
// costs (rule 608.2g), rearranging the top of a library, and searching libraries (rule 701.23).

const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const wurm = () => creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);
const blueBear = () => creature('Blue Bear', '{1}{U}', 2, 2, 2, { colorIdentity: ['U'] });

/** Take the first priority action matching `pick`, once. */
function playOnce(pick: (a: Action, g: Game) => boolean): Handler {
  let done = false;
  return (g, d) => {
    if (done || d.kind !== 'priority') return undefined;
    const i = d.actions.findIndex((a) => pick(a, g));
    if (i === -1) return undefined;
    done = true;
    return { action: i };
  };
}

/** Run handlers in order: the first that answers wins. */
const all = (...hs: Handler[]): Handler => (g, d) => {
  for (const h of hs) {
    const a = h(g, d);
    if (a !== undefined) return a;
  }
  return undefined;
};

const actionsOf = (_g: Game, d: Decision) => (d.kind === 'priority' ? d.actions : []);

describe('playing cards from exile', () => {
  it('impulse draw: the exiled cards can be played this turn only (rule 611.2)', () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    const impulse = spell('Reckless Impulse', '{1}{G}', 2, 'Sorcery', 'Exile the top two cards of your library. Until the end of your next turn, you may play those cards.');
    const thisTurn = spell('Light Up the Stage', '{G}', 1, 'Sorcery', 'Exile the top two cards of your library. Until end of turn, you may play those cards.');
    expect(thisTurn.effects[0]).toMatchObject({ kind: 'exilePlay', n: 2, from: 'you', until: 'turn' });
    expect(impulse.effects[0]).toMatchObject({ kind: 'exilePlay', until: 'nextTurn' });
    t.lands(0, 3);
    const b = bears();
    const land = forest();
    p.library.unshift(b, land);
    p.hand = [thisTurn];
    let offered: Action[] = [];
    t.handlers[0] = all(castOnce('Light Up the Stage'), playOnce((a) => a.type === 'cast' && a.from === 'exile' && a.card === b), (g2, d) => {
      if (d.kind === 'priority' && g2.stack.length === 0 && p.exile.includes(land)) offered = actionsOf(g2, d);
      return undefined;
    });
    t.finishTurn();
    expect(p.battlefield.some((q) => q.card === b)).toBe(true);
    // The land was offered from exile (a land drop was left), and once the turn ended it can't be played any more.
    expect(offered.some((a) => a.type === 'land' && a.from === 'exile' && a.card === land)).toBe(true);
    expect(p.exile).toContain(land);
    expect(g.exilePlayable(p)).toEqual([]);
  });

  it("theft: an opponent's card is cast with mana of any type and goes to its owner's graveyard", () => {
    const t = new Table();
    const g = t.game;
    const [p, o] = g.players;
    const gonti = creature('Gonti, Lord of Luxury', '{2}{B}{B}', 4, 2, 3, {
      text: "Deathtouch\nWhen Gonti enters, look at the top four cards of target opponent's library, exile one of them face down, then put the rest on the bottom of that library in a random order. You may cast that card for as long as it remains exiled, and mana of any type can be spent to cast that spell.",
      keywords: ['Deathtouch'],
    });
    const theirs = spell('Blue Insight', '{1}{U}', 2, 'Sorcery', 'Draw two cards.', { colorIdentity: ['U'] });
    o.library.unshift(theirs, forest(), forest(), forest());
    t.lands(0, 2);
    g.put(0, gonti);
    // Gonti's enters ability, put on the stack by hand: it is what the card does as it resolves.
    const it = gonti.effects.find((e) => e.kind === 'exilePlay')!;
    expect(it).toMatchObject({ look: 4, n: 1, from: 'target', until: 'exiled', anyMana: true, castOnly: true });
    g.stack.push({ id: 999, kind: 'ability', controller: 0, card: gonti, effects: [it], targets: [{ kind: 'player', seat: 1 }], x: 0, isCommander: false, sourceId: null, attachTo: null, label: 'Gonti trigger' });
    t.handlers[0] = (g2, d) => {
      if (d.kind === 'choose' && d.reason === 'impulse') return [d.options.findIndex((o2) => o2.card === theirs)];
      return playOnce((a) => a.type === 'cast' && a.from === 'exile' && a.card === theirs)(g2, d);
    };
    const hand = p.hand.length;
    t.finishTurn();
    // Paid with two Forests: the blue pip could be paid with green mana.
    expect(o.graveyard).toContain(theirs);
    expect(p.graveyard).not.toContain(theirs);
    expect(p.hand.length).toBe(hand + 2);
  });

  it('Future Sight: lands and spells from the top of the library; Bolas\'s Citadel pays life', () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    const sight = spell('Future Sight', '{2}{U}{U}{U}', 5, 'Enchantment', 'Play with the top card of your library revealed.\nYou may play lands and cast spells from the top of your library.');
    expect(sight.effects).toEqual([expect.objectContaining({ kind: 'playTop', what: 'any', when: 'static' })]);
    expect(sight.unread).toBeUndefined();
    g.put(0, sight);
    t.lands(0, 2);
    const land = forest();
    const b = bears();
    p.library.unshift(land, b);
    t.handlers[0] = all(playOnce((a) => a.type === 'land' && a.from === 'library'), playOnce((a) => a.type === 'cast' && a.from === 'library' && a.card === b));
    t.finishTurn();
    expect(p.battlefield.some((q) => q.card === land)).toBe(true);
    expect(p.battlefield.some((q) => q.card === b)).toBe(true);

    const t2 = new Table();
    const g2 = t2.game;
    const q = g2.players[0];
    const citadel = spell("Bolas's Citadel", '{3}{B}{B}{B}', 6, 'Artifact', 'You may look at the top card of your library any time.\nYou may play lands and cast spells from the top of your library. If you cast a spell this way, pay life equal to its mana value rather than pay its mana cost.');
    expect(citadel.effects[0]).toMatchObject({ kind: 'playTop', payLife: true });
    g2.put(0, citadel);
    const w = wurm();
    q.library.unshift(w);
    const life = q.life;
    t2.handlers[0] = playOnce((a) => a.type === 'cast' && a.from === 'library' && a.card === w);
    t2.finishTurn();
    expect(q.battlefield.some((x) => x.card === w)).toBe(true);
    expect(q.life).toBe(life - 6);
  });

  it('"play one of those cards": the others lapse once one is played', () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    const ozai = creature('Fire Lord Ozai', '{3}{B}', 4, 4, 4, { text: "{6}: Exile the top card of each opponent's library. Until end of turn, you may play one of those cards without paying its mana cost." });
    expect(ozai.effects[0]).toMatchObject({ kind: 'exilePlay', from: 'opponents', oneOf: true, free: true, until: 'turn' });
    const t3 = new Table(3);
    const g3 = t3.game;
    const [a, b, c] = g3.players;
    const w1 = wurm();
    const w2 = wurm();
    b.library.unshift(w1);
    c.library.unshift(w2);
    g3.stack.push({ id: 998, kind: 'ability', controller: 0, card: ozai, effects: [ozai.effects[0]], targets: [null], x: 0, isCommander: false, sourceId: null, attachTo: null, label: 'Ozai' });
    t3.handlers[0] = playOnce((x) => x.type === 'cast' && x.from === 'exile');
    t3.finishTurn();
    // One Craw Wurm, cast free with no lands; the other stays in exile.
    expect(a.battlefield.filter((q) => q.card.name === 'Craw Wurm').length).toBe(1);
    expect(a.battlefield.find((q) => q.card.name === 'Craw Wurm')!.owner).toBeDefined();
    expect(b.exile.length + c.exile.length).toBe(1);
    void g;
    void p;
  });
});

describe('casting spells without paying their mana costs', () => {
  it('Villainous Wealth: cast the exiled cards with mana value X or less as it resolves (rule 608.2g)', () => {
    const t = new Table();
    const g = t.game;
    const [p, o] = g.players;
    const wealth = spell('Villainous Wealth', '{X}{B}{G}{U}', 3, 'Sorcery', 'Target opponent exiles the top X cards of their library. You may cast any number of spells with mana value X or less from among them without paying their mana costs.');
    expect(wealth.effects[0]).toMatchObject({ kind: 'freeCast', from: 'top', n: -1, who: 'target', maxCmc: -1, casts: 99 });
    const b1 = blueBear();
    const w = wurm();
    o.library.unshift(b1, w, forest());
    g.stack.push({ id: 997, kind: 'spell', controller: 0, card: wealth, effects: [wealth.effects[0]], targets: [{ kind: 'player', seat: 1 }], x: 3, isCommander: false, sourceId: null, attachTo: null, label: 'Villainous Wealth' });
    t.handlers[0] = (_g, d) => (d.kind === 'choose' && d.reason === 'freeCast' ? [0] : undefined);
    t.finishTurn();
    const stolen = p.battlefield.find((q) => q.card === b1);
    expect(stolen?.owner).toBe(1);
    // The Wurm (mana value 6) couldn't be cast; it and the Forest stay exiled.
    expect(o.exile).toContain(w);
    expect(o.exile.length).toBe(2);
  });

  it('discover: reveal until a nonland card with mana value N or less, cast it free, the rest go to the bottom', () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    const disc = spell('Trumpeting Carnosaur Lite', '{2}{G}', 3, 'Sorcery', 'Discover 3.');
    expect(disc.effects[0]).toMatchObject({ kind: 'freeCast', from: 'until', discover: true, maxCmc: 3, elseHand: true });
    const w = wurm();
    const b = bears();
    const land = forest();
    p.library.unshift(w, land, b);
    p.hand = [disc];
    t.lands(0, 3);
    t.handlers[0] = all(castOnce('Trumpeting Carnosaur Lite'), (_g, d) => (d.kind === 'choose' && d.reason === 'freeCast' ? [0] : undefined));
    t.finishTurn();
    expect(p.battlefield.some((q) => q.card === b)).toBe(true);
    expect(p.library.slice(-2)).toEqual(expect.arrayContaining([w, land]));
  });

  it('discover: a card not cast goes to hand', () => {
    const t = new Table();
    const p = t.game.players[0];
    const disc = spell('Discoverer', '{2}{G}', 3, 'Sorcery', 'Discover 3.');
    const b = bears();
    p.library.unshift(b);
    p.hand = [disc];
    t.lands(0, 3);
    t.handlers[0] = castOnce('Discoverer');
    t.finishTurn();
    expect(p.hand).toContain(b);
  });

  it("Memory Plunder casts an opponent's instant or sorcery from their graveyard", () => {
    const t = new Table();
    const g = t.game;
    const [p, o] = g.players;
    const plunder = spell('Memory Plunder', '{U/B}{U/B}{U/B}{U/B}', 4, 'Instant', "You may cast target instant or sorcery card from an opponent's graveyard without paying its mana cost.");
    const theirs = spell('Big Draw', '{4}{U}', 5, 'Sorcery', 'Draw three cards.');
    o.graveyard.push(theirs);
    g.stack.push({ id: 996, kind: 'spell', controller: 0, card: plunder, effects: [plunder.effects[0]], targets: [null], x: 0, isCommander: false, sourceId: null, attachTo: null, label: 'Memory Plunder' });
    t.handlers[0] = (_g, d) => (d.kind === 'choose' && d.reason === 'freeCast' ? [0] : undefined);
    const hand = p.hand.length;
    t.finishTurn();
    expect(p.hand.length).toBeGreaterThanOrEqual(hand + 3);
    expect(o.graveyard).toContain(theirs);
  });

  it('One with the Multiverse: one spell a turn for free, from hand or the top of the library', () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    const one = spell('One with the Multiverse', '{6}{U}{U}', 8, 'Enchantment', 'You may look at the top card of your library any time.\nYou may play lands and cast spells from the top of your library.\nOnce during each of your turns, you may cast a spell from your hand or the top of your library without paying its mana cost.');
    expect(one.unread).toBeUndefined();
    g.put(0, one);
    const w1 = wurm();
    const w2 = wurm();
    p.hand = [w1, w2];
    let freeOffers = 0;
    t.handlers[0] = (_g2, d) => {
      if (d.kind !== 'priority') return undefined;
      const i = d.actions.findIndex((a) => a.type === 'cast' && a.free);
      if (i === -1) return undefined;
      freeOffers++;
      return { action: i };
    };
    t.finishTurn();
    expect(freeOffers).toBe(1);
    expect(p.battlefield.filter((q) => q.card.name === 'Craw Wurm').length).toBe(1);
  });
});

describe('rearranging the top of the library', () => {
  it('Ponder: put the top three back in the chosen order, or shuffle', () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    const ponder = spell('Ponder', '{G}', 1, 'Sorcery', 'Look at the top three cards of your library, then put them back in any order. You may shuffle.\nDraw a card.');
    expect(ponder.effects[0]).toEqual(expect.objectContaining({ kind: 'rearrange', n: 3, shuffle: true }));
    expect(ponder.notes.join(' ')).not.toMatch(/≈/);
    const [a, b, c]: SimCard[] = [bears(), wurm(), forest()];
    p.library.unshift(a, b, c);
    p.hand = [ponder];
    t.lands(0, 1);
    t.handlers[0] = all(castOnce('Ponder'), (_g, d) => (d.kind === 'choose' && d.reason === 'rearrange' ? [2, 0, 1] : undefined));
    t.finishTurn();
    // Forest, Bears, Wurm; then the Forest is drawn.
    expect(p.hand).toContain(c);
    expect(p.library.slice(0, 2)).toEqual([a, b]);
  });

  it("Sensei's Divining Top looks at three for {1}", () => {
    const top = spell("Sensei's Divining Top", '{1}', 1, 'Artifact', '{1}: Look at the top three cards of your library, then put them back in any order.\n{T}: Draw a card, then put this artifact on top of its owner\'s library.');
    expect(top.effects).toEqual([expect.objectContaining({ kind: 'rearrange', n: 3, when: 'activated' })]);
    expect(top.notes.join(' ')).not.toMatch(/≈/);
  });
});

describe('searching libraries', () => {
  const tutor = () => spell('Demonic Tutor', '{1}{G}', 2, 'Sorcery', 'Search your library for a card, put that card into your hand, then shuffle.');

  it('Aven Mindcensor: an opponent searches only the top four cards', () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    g.put(1, creature('Aven Mindcensor', '{2}{W}', 3, 2, 1, { text: 'Flash\nFlying\nIf an opponent would search a library, that player searches the top four cards of that library instead.', keywords: ['Flash', 'Flying'] }));
    p.hand = [tutor()];
    t.lands(0, 2);
    let options = -1;
    t.handlers[0] = all(castOnce('Demonic Tutor'), (_g, d) => {
      if (d.kind === 'choose' && d.reason === 'tutor') options = d.options.length;
      return undefined;
    });
    t.finishTurn();
    expect(options).toBeGreaterThan(0);
    expect(options).toBeLessThanOrEqual(4);
  });

  it("Ashiok, Dream Render: an opponent's tutor finds nothing", () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    g.put(1, spell('Ashiok, Dream Render', '{1}{U/B}{U/B}', 3, 'Planeswalker', "Spells and abilities your opponents control can't cause their controller to search their library."));
    p.hand = [tutor()];
    t.lands(0, 2);
    t.handlers[0] = castOnce('Demonic Tutor');
    t.finishTurn();
    expect(p.hand.length).toBe(0);
    expect(g.log!.some((l) => /can't search/.test(l))).toBe(true);
  });

  it('Opposition Agent: the card found is exiled and its controller may play it', () => {
    const t = new Table();
    const g = t.game;
    const [p, o] = g.players;
    g.put(1, creature('Opposition Agent', '{2}{B}', 3, 3, 2, { text: "Flash\nYou control your opponents while they're searching their libraries.\nWhile an opponent is searching their library, they exile each card they find. You may play those cards for as long as they remain exiled, and you may spend mana as though it were mana of any color to cast them.", keywords: ['Flash'] }));
    p.hand = [tutor()];
    t.lands(0, 2);
    t.handlers[0] = castOnce('Demonic Tutor');
    t.finishTurn();
    expect(p.hand.length).toBe(0);
    expect(p.exile.length).toBe(1);
    expect(g.exilePlayable(o).map((m) => m.card)).toEqual(p.exile);
  });

  it('Leonin Arbiter: searching costs {2}', () => {
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    g.put(1, creature('Leonin Arbiter', '{1}{W}', 2, 2, 2, { text: "Players can't search libraries. Any player may pay {2} for that player to ignore this effect until end of turn." }));
    p.hand = [tutor()];
    t.lands(0, 4);
    t.handlers[0] = castOnce('Demonic Tutor');
    t.finishTurn();
    expect(p.hand.length).toBe(1);
    expect(g.log!.some((l) => /pays \{2\} to search/.test(l))).toBe(true);
  });

  it('Protean Hulk finds creatures with total mana value 6 or less', () => {
    const hulk = creature('Protean Hulk', '{5}{G}{G}', 7, 6, 6, { text: 'When this creature dies, search your library for any number of creature cards with total mana value 6 or less, put them onto the battlefield, then shuffle.' });
    expect(hulk.effects[0]).toMatchObject({ kind: 'search', what: 'creature', to: 'battlefield', totalCmc: 6, n: 99, when: 'creatureDies' });
    const t = new Table();
    const g = t.game;
    const p = g.players[0];
    p.library = [bears(), bears(), bears(), bears(), wurm(), forest()];
    g.stack.push({ id: 995, kind: 'ability', controller: 0, card: hulk, effects: [{ ...hulk.effects[0], when: 'resolve' }], targets: [null], x: 0, isCommander: false, sourceId: null, attachTo: null, label: 'Hulk' });
    t.handlers[0] = (_g, d) => (d.kind === 'choose' && d.reason === 'take' ? [d.options.findIndex((o) => o.card?.name === 'Grizzly Bears')].filter((i) => i >= 0) : undefined);
    t.finishTurn();
    const found = p.battlefield.filter((q) => q.card.isCreature);
    expect(found.reduce((n, q) => n + q.card.cmc, 0)).toBeLessThanOrEqual(6);
    expect(found.length).toBe(3);
  });
});
