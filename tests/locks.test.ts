// Lockouts, "isn't a creature" and animation, and winning or losing the game:
// the card reader (src/engine/classifyLocks.ts) and the rules engine.
// Cards use their real oracle text, with green mana costs where the test table needs them.

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import { card, creature, forest, spell } from './helpers';
import { castOnce, find, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const kinds = (c: { effects: { kind: string }[] }) => c.effects.map((e) => e.kind);
const artifact = (name: string, cost: string, cmc: number, text: string) => card({ name, manaCost: cost, cmc, types: ['Artifact'], text });

const elves = () => creature('Llanowar Elves', '{G}', 1, 1, 1, { text: '{T}: Add {G}.' });
const solRing = () => artifact('Sol Ring', '{1}', 1, '{T}: Add {C}{C}.');
const cursedTotem = () => artifact('Cursed Totem', '{2}', 2, "Activated abilities of creatures can't be activated.");
const karn = () => card({
  name: 'Karn, the Great Creator', manaCost: '{4}', cmc: 4, types: ['Planeswalker'], loyalty: '5',
  text: "Activated abilities of artifacts your opponents control can't be activated.\n+1: Until your next turn, up to one target noncreature artifact becomes an artifact creature with power and toughness each equal to its mana value.\n−2: You may reveal an artifact card you own from outside the game or choose a face-up artifact card you own in exile. Put that card into your hand.",
});
const bolt = () => spell('Lightning Bolt', '{G}', 1, 'Instant', 'Lightning Bolt deals 3 damage to any target.');
const counterspell = () => spell('Counterspell', '{G}{G}', 2, 'Instant', 'Counter target spell.');
const etbDraw = () => creature('Elvish Visionary', '{1}{G}', 2, 1, 1, { text: 'When this creature enters, draw a card.' });
const heliod = () => card({
  name: 'Heliod, God of the Sun', manaCost: '{3}{G}', cmc: 4, types: ['Enchantment', 'Creature'], superTypes: ['Legendary'], power: '5', toughness: '6', colorIdentity: ['G'],
  text: "Indestructible\nAs long as your devotion to green is less than five, Heliod isn't a creature.\nOther creatures you control have vigilance.",
});

/** A handler that activates the first ability matching `kind` once. */
const activateOnce = (kind: string, when: (step: string) => boolean = () => true) => {
  let done = false;
  return (g: Table['game'], d: Parameters<NonNullable<Table['handlers'][number]>>[1]) => {
    if (done || d.kind !== 'priority' || !when(g.step)) return undefined;
    const i = d.actions.findIndex((a) => a.type === 'activate' && a.effect.kind === kind);
    if (i === -1) return undefined;
    done = true;
    return { action: i };
  };
};

describe('lockouts: activated abilities', () => {
  it('reads Cursed Totem, Karn, Linvala and Grand Abolisher', () => {
    expect(cursedTotem().effects[0]).toMatchObject({ kind: 'abilityLock', perms: 'creatures', who: 'all', when: 'static' });
    expect(karn().effects[0]).toMatchObject({ kind: 'abilityLock', perms: 'artifacts', who: 'opponents' });
    const linvala = creature('Linvala, Keeper of Silence', '{2}{W}{W}', 4, 3, 4, { text: "Flying\nActivated abilities of creatures your opponents control can't be activated." });
    expect(linvala.effects).toEqual([expect.objectContaining({ kind: 'abilityLock', perms: 'creatures', who: 'opponents' })]);
    const abolisher = creature('Grand Abolisher', '{W}{W}', 2, 2, 2, { text: "During your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments." });
    expect(kinds(abolisher)).toEqual(['castLock', 'abilityLock']);
    expect(abolisher.unread).toBeUndefined();
  });

  it('Cursed Totem stops mana creatures too, for everyone (rule 605.1a)', () => {
    const t = new Table();
    const p0 = t.game.players[0];
    t.game.put(0, elves());
    t.game.put(1, elves());
    expect(t.game.availableMana(p0)).toBe(1);
    t.game.put(1, cursedTotem());
    expect(t.game.availableMana(p0)).toBe(0);
    expect(t.game.availableMana(t.game.players[1])).toBe(0);
  });

  it("Karn shuts off opponents' mana rocks and Treasures, not his controller's", () => {
    const t = new Table();
    const [p0, p1] = t.game.players;
    t.game.put(0, solRing());
    t.game.put(1, solRing());
    p0.treasures = 2;
    t.game.put(1, karn());
    expect(t.game.availableMana(p0)).toBe(0);
    expect(t.game.availableMana(p1)).toBe(2);
  });

  it('Grand Abolisher: no spells from opponents during its controller turn', () => {
    const t = new Table();
    t.lands(1, 2);
    t.game.players[1].hand.push(bolt());
    t.game.put(0, creature('Grand Abolisher', '{W}{W}', 2, 2, 2, { text: "During your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments." }));
    expect(find(t.game.legalActions(t.game.players[1]), 'cast', 'Lightning Bolt')).toBe(-1);
  });
});

describe('lockouts: casting spells', () => {
  it("Silence: the opponents can't cast spells for the rest of the turn, and can again on the next", () => {
    const t = new Table();
    t.lands(0, 1);
    t.lands(1, 2);
    const silence = spell('Silence', '{G}', 1, 'Instant', "Your opponents can't cast spells this turn.");
    expect(kinds(silence)).toEqual(['silence']);
    // A land in hand keeps seat 0 deciding in its main phase after Silence resolves.
    t.game.players[0].hand.push(silence, forest());
    t.game.players[1].hand.push(bolt());
    t.handlers[0] = castOnce('Silence');
    t.until((g) => g.stack.length === 0 && log(t, /can't cast spells this turn/).length > 0);
    expect(t.game.step).toBe('main1');
    expect(find(t.game.legalActions(t.game.players[1]), 'cast', 'Lightning Bolt')).toBe(-1);
    t.finishTurn();
    expect(find(t.game.legalActions(t.game.players[1]), 'cast', 'Lightning Bolt')).not.toBe(-1);
  });

  it('Teferi, Time Raveler: opponents only at sorcery speed; Void Winnower: no even mana values', () => {
    const t = new Table();
    t.lands(1, 3);
    const p1 = t.game.players[1];
    p1.hand.push(bolt(), counterspell());
    const teferi = card({ name: 'Teferi, Time Raveler', manaCost: '{1}{W}{U}', cmc: 3, types: ['Planeswalker'], loyalty: '4', text: 'Each opponent can cast spells only any time they could cast a sorcery.\n+1: Until your next turn, you may cast sorcery spells as though they had flash.\n−3: Return up to one target artifact, creature, or enchantment to its owner\'s hand. Draw a card.' });
    t.game.put(0, teferi);
    expect(t.game.castLocked(p1, bolt(), 'hand')).toBe(true);
    t.game.players[0].battlefield = [];
    const winnower = creature('Void Winnower', '{9}', 9, 11, 9, { text: "Your opponents can't cast spells with even mana values. (Zero is even.)\nYour opponents can't block with creatures with even mana values." });
    t.game.put(0, winnower);
    expect(t.game.castLocked(p1, counterspell(), 'hand')).toBe(true);
    expect(t.game.castLocked(p1, bolt(), 'hand')).toBe(false);
  });

  it("Chimil: spells can't be countered", () => {
    const t = new Table();
    t.lands(0, 2);
    t.lands(1, 2);
    t.game.put(0, artifact('Chimil, the Inner Sun', '{6}', 6, "Spells you control can't be countered."));
    t.game.players[0].hand.push(creature('Craw Wurm', '{1}{G}', 2, 6, 4));
    t.game.players[1].hand.push(counterspell());
    t.handlers[0] = castOnce('Craw Wurm');
    t.until((g) => g.stack.length > 0);
    expect(find(t.game.legalActions(t.game.players[1]), 'cast', 'Counterspell')).toBe(-1);
  });

  it('Vexing Bauble counters a spell cast without spending mana', () => {
    const t = new Table();
    t.game.put(1, artifact('Vexing Bauble', '{1}', 1, 'Whenever a player casts a spell, if no mana was spent to cast it, counter that spell.\n{1}, {T}, Sacrifice this artifact: Draw a card.'));
    t.game.players[0].hand.push(artifact('Ornithopter', '{0}', 0, 'Flying'));
    t.handlers[0] = castOnce('Ornithopter');
    t.until((g) => g.step !== 'main1');
    expect(log(t, /Ornithopter is countered/)).toHaveLength(1);
    expect(t.game.players[0].battlefield.some((q) => q.card.name === 'Ornithopter')).toBe(false);
  });

  it('Jin-Gitaxias counters the first noncreature spell an opponent casts each turn', () => {
    const t = new Table();
    t.lands(0, 2);
    const jin = creature('Jin-Gitaxias, Progress Tyrant', '{5}{U}{U}', 7, 5, 5, { text: 'Whenever an opponent casts an artifact, instant, or sorcery spell, counter that spell. This ability triggers only once each turn.' });
    expect(jin.effects[0]).toMatchObject({ kind: 'counter', when: 'opponentCast', subject: true, oncePerTurn: true });
    t.game.put(1, jin);
    t.game.players[0].hand.push(spell('Divination', '{G}', 1, 'Sorcery', 'Draw two cards.'));
    t.handlers[0] = castOnce('Divination');
    t.until((g) => g.step !== 'main1');
    expect(log(t, /Divination is countered/)).toHaveLength(1);
  });
});

describe('lockouts: losing abilities and stopping triggers', () => {
  it('Dress Down blanks every creature until it is sacrificed at the end step', () => {
    const t = new Table();
    const dress = card({ name: 'Dress Down', manaCost: '{1}{U}', cmc: 2, types: ['Enchantment'], keywords: ['Flash'], text: 'Flash\nWhen this enchantment enters, draw a card.\nCreatures lose all abilities.\nAt the beginning of the end step, sacrifice this enchantment.' });
    expect(dress.unread).toBeUndefined();
    const flyer = t.game.put(1, creature('Serra Angel', '{3}{W}{W}', 5, 4, 4, { text: 'Flying, vigilance', keywords: ['Flying', 'Vigilance'] }));
    t.game.put(0, dress);
    t.game.players[0].hand.push(forest());
    t.until((_g, d) => d.kind === 'priority');
    expect(t.game.step).toBe('main1');
    expect(t.game.hasKw(flyer, 'flying')).toBe(false);
    t.finishTurn();
    expect(log(t, /Dress Down .* is sacrificed at the end step/)).toHaveLength(1);
    expect(t.game.hasKw(flyer, 'flying')).toBe(true);
  });

  it("Tishana's Tidebinder blanks an opponent's permanent while it stays", () => {
    const t = new Table();
    t.lands(0, 3);
    const tide = creature("Tishana's Tidebinder", '{2}{G}', 3, 3, 2, { text: 'Flash\nWhen this creature enters, counter up to one target activated or triggered ability. If an ability of an artifact, creature, or planeswalker is countered this way, that permanent loses all abilities for as long as this creature remains on the battlefield. (Mana abilities can\'t be targeted.)', keywords: ['Flash'] });
    expect(kinds(tide)).toEqual(['blank']);
    t.game.put(1, solRing());
    t.game.players[0].hand.push(tide);
    t.handlers[0] = castOnce("Tishana's Tidebinder");
    t.until((g) => g.step !== 'main1');
    expect(t.game.availableMana(t.game.players[1])).toBe(0);
    const binder = t.game.players[0].battlefield.find((q) => q.card.name === "Tishana's Tidebinder")!;
    (t.game as unknown as { removePerm: (q: unknown, to: string) => void }).removePerm(binder, 'graveyard');
    expect(t.game.availableMana(t.game.players[1])).toBe(2);
  });

  it("Hushbringer: creatures entering don't trigger abilities", () => {
    const t = new Table();
    t.lands(0, 2);
    t.game.put(1, creature('Hushbringer', '{1}{W}', 2, 1, 2, { text: "Flying, lifelink\nCreatures entering or dying don't cause abilities to trigger." }));
    t.game.players[0].hand.push(etbDraw());
    t.handlers[0] = castOnce('Elvish Visionary');
    t.until((g) => g.step !== 'main1');
    expect(t.game.players[0].hand).toHaveLength(0);
  });

  it("Elesh Norn: permanents entering don't trigger her opponents' abilities", () => {
    const t = new Table();
    t.lands(0, 2);
    const norn = creature('Elesh Norn, Mother of Machines', '{4}{W}', 5, 4, 7, { text: 'Vigilance\nIf a permanent entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.\nPermanents entering don\'t cause abilities of permanents your opponents control to trigger.' });
    expect(norn.unread).toBeUndefined();
    t.game.put(1, norn);
    t.game.players[0].hand.push(etbDraw());
    t.handlers[0] = castOnce('Elvish Visionary');
    t.until((g) => g.step !== 'main1');
    expect(t.game.players[0].hand).toHaveLength(0);
  });
});

describe("'isn't a creature' and animation", () => {
  it("a god isn't a creature until its devotion is high enough", () => {
    const t = new Table();
    const god = t.game.put(0, heliod());
    t.until((g) => g.step === 'main1');
    t.game.legalActions(t.game.players[0]);
    t.until((_g, d) => d.kind === 'priority');
    expect(god.card.isCreature).toBe(false);
    for (let i = 0; i < 2; i++) t.game.put(0, creature('Leatherback Baloth', '{G}{G}{G}', 3, 4, 5));
    t.finishTurn();
    expect(god.card.isCreature).toBe(true);
  });

  it('Karn +1 makes a noncreature artifact a creature until his next turn', () => {
    const t = new Table();
    const k = t.game.put(0, karn());
    const rock = t.game.put(0, artifact('Mind Stone', '{2}', 2, '{T}: Add {C}.'));
    const plus = k.card.effects.find((e) => e.when === 'loyalty' && e.loyalty === 1)!;
    expect(plus).toMatchObject({ kind: 'becomeCreature', what: 'artifact', size: 'cmc', until: 'yourNextTurn' });
    t.handlers[0] = activateOnce('becomeCreature');
    t.finishTurn();
    expect(rock.card.isCreature).toBe(true);
    expect(t.game.power(rock)).toBe(2);
    t.until((g) => g.activeSeat === 0);
    expect(rock.card.isCreature).toBe(false);
  });

  it('Cyberdrive Awakener: every noncreature artifact is a 4/4 until end of turn', () => {
    const t = new Table();
    t.lands(0, 2);
    const rock = t.game.put(0, solRing());
    t.game.players[0].hand.push(creature('Cyberdrive Awakener', '{1}{G}', 2, 4, 4, { text: 'Flying\nOther artifact creatures you control have flying.\nWhen this creature enters, each noncreature artifact you control becomes a 4/4 artifact creature until end of turn.' }));
    t.handlers[0] = castOnce('Cyberdrive Awakener');
    t.until((g) => g.step === 'declareAttackers' || g.step === 'beginCombat');
    expect(rock.card.isCreature).toBe(true);
    expect(t.game.power(rock)).toBe(4);
    t.finishTurn();
    expect(rock.card.isCreature).toBe(false);
  });

  it('Depthshaker Titan: the animated artifacts are sacrificed at the end step', () => {
    const t = new Table();
    t.lands(0, 2);
    t.game.put(0, artifact('Ornithopter Nest', '{2}', 2, 'Whenever you cast a spell, you gain 1 life.'));
    t.game.players[0].hand.push(creature('Depthshaker Titan', '{1}{G}', 2, 5, 5, { text: 'When this creature enters, any number of target noncreature artifacts you control become 3/3 artifact creatures. Sacrifice them at the beginning of the next end step.' }));
    t.handlers[0] = castOnce('Depthshaker Titan');
    t.finishTurn();
    expect(t.game.players[0].battlefield.some((q) => q.card.name === 'Ornithopter Nest')).toBe(false);
  });

  it('Destiny Spinner makes a land an X/X with trample and haste', () => {
    const c = creature('Destiny Spinner', '{1}{G}', 2, 2, 3, { text: "Creature and enchantment spells you control can't be countered.\n{3}{G}: Target land you control becomes an X/X Elemental creature with trample and haste until end of turn, where X is the number of enchantments you control. It's still a land." });
    expect(c.unread).toBeUndefined();
    expect(c.effects[1]).toMatchObject({ kind: 'becomeCreature', what: 'land', size: 'enchantments', keywords: ['haste', 'trample'], when: 'activated' });
  });
});

describe('winning and losing', () => {
  it('reads the upkeep wins, the Toad, Platinum Angel, Unlife, Pacts and Out of the Tombs', () => {
    const revel = spell('Revel in Riches', '{4}{B}', 5, 'Enchantment', 'Whenever a creature an opponent controls dies, create a Treasure token.\nAt the beginning of your upkeep, if you control ten or more Treasures, you win the game.');
    expect(revel.effects[1]).toMatchObject({ kind: 'winIf', cond: 'treasures', n: 10, when: 'upkeep' });
    const trisk = creature('Triskaidekaphile', '{1}{U}', 2, 1, 3, { text: 'You have no maximum hand size.\nAt the beginning of your upkeep, if you have exactly thirteen cards in your hand, you win the game.\n{3}{U}: Draw a card.' });
    expect(trisk.unread).toBeUndefined();
    const toad = creature('Twenty-Toed Toad', '{3}{U}', 4, 3, 3, { text: 'Whenever this creature attacks, you win the game if there are twenty or more counters on it or you have twenty or more cards in hand.' });
    expect(toad.effects[0]).toMatchObject({ kind: 'winIf', cond: 'counters', n: 20, orHand: 20, when: 'attack' });
    const pact = spell('Pact of Negation', '{0}', 0, 'Instant', "Counter target spell.\nAt the beginning of your next upkeep, pay {3}{U}{U}. If you don't, you lose the game.");
    expect(pact.effects[1]).toMatchObject({ kind: 'pact', cost: { generic: 3, pips: [['U'], ['U']] } });
    const tombs = spell('Out of the Tombs', '{2}{B}', 3, 'Enchantment', "If you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield. If you can't, you lose the game.");
    expect(kinds(tombs)).toEqual(['emptyDrawReanimate']);
  });

  it('Revel in Riches wins at the beginning of the upkeep with ten Treasures', () => {
    const t = new Table();
    t.game.put(0, spell('Revel in Riches', '{4}{B}', 5, 'Enchantment', 'At the beginning of your upkeep, if you control ten or more Treasures, you win the game.'));
    t.game.players[0].treasures = 10;
    t.until(() => false);
    expect(t.game.winner).toBe(0);
    expect(log(t, /wins the game \(Revel in Riches\)/)).toHaveLength(1);
  });

  it("Platinum Angel: its controller doesn't lose at 0 life, and opponents can't win", () => {
    const t = new Table();
    const [p0, p1] = t.game.players;
    const angel = t.game.put(1, artifact('Platinum Angel', '{7}', 7, "Flying\nYou can't lose the game and your opponents can't win the game."));
    p1.life = -5;
    t.game.put(0, spell('Revel in Riches', '{4}{B}', 5, 'Enchantment', 'At the beginning of your upkeep, if you control ten or more Treasures, you win the game.'));
    p0.treasures = 10;
    t.finishTurn();
    t.finishTurn();
    expect(p1.alive).toBe(true);
    expect(log(t, /would win the game \(Revel in Riches\), but can't win/).length).toBeGreaterThan(0);
    (t.game as unknown as { removePerm: (q: unknown, to: string) => void }).removePerm(angel, 'graveyard');
    t.until((_g, d) => d.kind === 'priority');
    t.until((_g, d) => d.kind === 'priority' && !p1.alive);
    expect(p1.alive).toBe(false);
  });

  it('Phyrexian Unlife: no loss at 0 life, but damage then becomes poison', () => {
    const t = new Table();
    const p1 = t.game.players[1];
    t.game.put(1, spell('Phyrexian Unlife', '{2}{W}', 3, 'Enchantment', "You don't lose the game for having 0 or less life.\nAs long as you have 0 or less life, all damage is dealt to you as though its source had infect. (Damage is dealt to you in the form of poison counters.)"));
    p1.life = 0;
    t.game.loseLife(p1, 4, t.game.players[0], 'combat');
    expect(p1.life).toBe(0);
    expect(p1.poison).toBe(4);
    t.finishTurn();
    expect(p1.alive).toBe(true);
    t.game.loseLife(p1, 6, t.game.players[0], 'combat');
    t.finishTurn();
    expect(p1.alive).toBe(false);
  });

  it('a Pact that is not paid for loses the game at its caster\'s next upkeep', () => {
    const t = new Table();
    t.lands(1, 2);
    t.lands(0, 1);
    t.game.players[0].hand.push(bolt());
    t.game.players[1].hand.push(spell('Pact of Negation', '{0}', 0, 'Instant', "Counter target spell.\nAt the beginning of your next upkeep, pay {3}{G}{G}. If you don't, you lose the game."));
    t.handlers[0] = castOnce('Lightning Bolt');
    t.handlers[1] = (g, d) => (d.kind === 'priority' && g.stack.length ? (find(d.actions, 'cast', 'Pact of Negation') === -1 ? undefined : { action: find(d.actions, 'cast', 'Pact of Negation') }) : undefined);
    t.until((g) => g.activeSeat === 1 && g.step === 'draw');
    expect(log(t, /Lightning Bolt is countered/)).toHaveLength(1);
    expect(log(t, /can't pay for Pact of Negation and loses the game/)).toHaveLength(1);
  });

  it('the bot only casts a Pact it can pay for', () => {
    const t = new Table();
    const bot = new Bot(1, 1);
    const pact = spell('Pact of Negation', '{0}', 0, 'Instant', "Counter target spell.\nAt the beginning of your next upkeep, pay {3}{G}{G}. If you don't, you lose the game.");
    const p1 = t.game.players[1];
    p1.hand.push(pact);
    t.lands(1, 2);
    const unpayable = (bot as unknown as { pactPayable: (g: unknown, p: unknown, c: unknown) => boolean }).pactPayable(t.game, p1, pact);
    expect(unpayable).toBe(false);
    t.lands(1, 4);
    expect((bot as unknown as { pactPayable: (g: unknown, p: unknown, c: unknown) => boolean }).pactPayable(t.game, p1, pact)).toBe(true);
  });

  it('Out of the Tombs returns a creature instead of losing to an empty library', () => {
    const t = new Table();
    const p0 = t.game.players[0];
    t.game.put(0, spell('Out of the Tombs', '{2}{B}', 3, 'Enchantment', "If you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield. If you can't, you lose the game."));
    p0.library = [];
    p0.graveyard = [creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4)];
    t.game.draw(p0, 1);
    expect(p0.drewFromEmpty).toBe(false);
    expect(p0.battlefield.some((q) => q.card.name === 'Craw Wurm')).toBe(true);
    t.game.draw(p0, 1);
    expect(p0.lost).toBe(true);
  });
});
