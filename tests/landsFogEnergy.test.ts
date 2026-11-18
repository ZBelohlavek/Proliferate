// Land hate, Fogs, energy and charge counters: the card reader and the rules
// engine, with the Comprehensive Rules section each check rests on. Cards use
// their real oracle text (with green mana costs where the test table needs them).

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import type { Game } from '../src/rules/game';
import type { Decision } from '../src/rules/types';
import { card, creature, forest, spell } from './helpers';
import { attackAll, castOnce, find, Table } from './table';

const bears = () => creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
const wurm = () => creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);
const dual = () => card({ name: 'Breeding Pool', types: ['Land'], subTypes: ['Forest', 'Island'], text: '({T}: Add {G} or {U}.)', producedMana: ['G', 'U'], colorIdentity: ['G', 'U'] });
const enchantment = (name: string, text: string, cost = '{2}{G}', cmc = 3) => spell(name, cost, cmc, 'Enchantment', text);
const artifact = (name: string, text: string, cost = '{2}', cmc = 2) => card({ name, manaCost: cost, cmc, types: ['Artifact'], text });
const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));

/** Stop at seat `seat`'s priority in the declare blockers step. */
const atBlockers = (seat: number) => (g: Game, d: Decision) => d.kind === 'priority' && d.seat === seat && g.step === 'declareBlockers';

describe('land hate', () => {
  it('Blood Moon makes nonbasic lands tap only for {R}; basics are unchanged (rule 305.7)', () => {
    const t = new Table();
    const pool = t.game.put(1, dual());
    const basic = t.game.put(1, forest());
    expect(t.game.landProduces(pool)).toEqual(['G', 'U']);
    t.game.put(0, enchantment('Blood Moon', 'Nonbasic lands are Mountains.'));
    expect(t.game.landProduces(pool)).toEqual(['R']);
    expect(t.game.landProduces(basic)).toEqual(['G']);
  });

  it("Back to Basics: nonbasic lands stay tapped through their controller's untap step", () => {
    const t = new Table();
    t.game.put(0, enchantment('Back to Basics', "Nonbasic lands don't untap during their controllers' untap steps."));
    const pool = t.game.put(1, dual(), { tapped: true });
    const basic = t.game.put(1, forest(), { tapped: true });
    t.finishTurn();
    t.until((g) => g.step === 'main1');
    expect(pool.tapped).toBe(true);
    expect(basic.tapped).toBe(false);
  });

  it('Winter Orb: each player untaps only one land', () => {
    const t = new Table();
    t.game.put(0, artifact('Winter Orb', "As long as this artifact is untapped, players can't untap more than one land during their untap steps."));
    const lands = [0, 1, 2].map(() => t.game.put(1, forest(), { tapped: true }));
    t.finishTurn();
    t.until((g) => g.step === 'main1');
    expect(lands.filter((l) => !l.tapped)).toHaveLength(1);
  });

  it("Ghost Quarter destroys a land and its controller fetches a basic; Dingus Egg punishes the loss", () => {
    const t = new Table();
    const quarter = t.game.put(0, card({ name: 'Ghost Quarter', types: ['Land'], text: '{T}: Add {C}.\n{T}, Sacrifice this land: Destroy target land. Its controller may search their library for a basic land card, put it onto the battlefield, then shuffle.' }));
    t.game.put(0, artifact('Dingus Egg', "Whenever a land is put into a graveyard from the battlefield, this artifact deals 2 damage to that land's controller.", '{4}', 4));
    const pool = t.game.put(1, dual());
    const [a, b] = t.game.players;
    const lifeA = a.life;
    const lifeB = b.life;
    t.handlers[0] = (g, d) => {
      if (d.kind === 'target') return { kind: 'perm', id: pool.id };
      if (d.kind === 'priority' && g.findPerm(quarter.id)) {
        const i = d.actions.findIndex((x) => x.type === 'activate' && x.permId === quarter.id);
        if (i !== -1) return { action: i };
      }
      return undefined;
    };
    t.finishTurn();
    expect(t.game.findPerm(pool.id)).toBeNull();
    expect(b.battlefield.filter((q) => q.landInfo && q.card.isBasic)).toHaveLength(1);
    // Both lands went to a graveyard: Ghost Quarter (sacrificed) and Breeding Pool.
    expect(a.life).toBe(lifeA - 2);
    expect(b.life).toBe(lifeB - 2);
  });

  it('Ruination destroys only nonbasic lands; Price of Progress deals 2 for each nonbasic land', () => {
    const t = new Table();
    const [, b] = t.game.players;
    t.lands(0, 6);
    t.game.put(1, dual());
    t.game.put(1, dual());
    t.game.put(1, forest());
    t.game.players[0].hand.push(spell('Price of Progress', '{1}{G}', 2, 'Instant', 'Price of Progress deals damage to each player equal to twice the number of nonbasic lands that player controls.'));
    t.game.players[0].hand.push(spell('Ruination', '{3}{G}', 4, 'Sorcery', 'Destroy all nonbasic lands.'));
    const first = castOnce('Price of Progress');
    const second = castOnce('Ruination', (g) => g.stack.length === 0 && b.life < 40);
    t.handlers[0] = (g, d) => first(g, d) ?? second(g, d);
    const life = b.life;
    t.finishTurn();
    expect(b.life).toBe(life - 4);
    expect(b.battlefield.filter((q) => q.landInfo).map((q) => q.card.name)).toEqual(['Forest']);
  });

  it('Manabarbs: tapping lands for mana costs life', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    t.game.put(1, enchantment('Manabarbs', 'Whenever a player taps a land for mana, Manabarbs deals 1 damage to that player.'));
    a.hand.push(bears());
    t.handlers[0] = castOnce('Grizzly Bears');
    const life = a.life;
    t.finishTurn();
    expect(a.life).toBe(life - 2);
  });

  it("Archon of Emeria: opponents' nonbasic lands enter tapped", () => {
    const t = new Table();
    t.game.put(0, creature('Archon of Emeria', '{2}{W}', 3, 2, 3, { text: "Flying\nEach player can't cast more than one spell each turn.\nNonbasic lands your opponents control enter tapped.", keywords: ['Flying'] }));
    const [, b] = t.game.players;
    b.hand.push(dual());
    t.finishTurn();
    t.handlers[1] = (_g, d) => (d.kind === 'priority' ? (find(d.actions, 'land') === -1 ? undefined : { action: find(d.actions, 'land') }) : undefined);
    t.until(() => b.battlefield.some((q) => q.card.name === 'Breeding Pool'));
    const pool = b.battlefield.find((q) => q.card.name === 'Breeding Pool');
    expect(pool?.tapped).toBe(true);
  });
});

describe('Fogs (rule 615)', () => {
  it('Fog prevents all combat damage this turn', () => {
    const t = new Table();
    const [, b] = t.game.players;
    t.game.put(0, wurm());
    t.lands(1, 1);
    b.hand.push(spell('Fog', '{G}', 1, 'Instant', 'Prevent all combat damage that would be dealt this turn.'));
    t.handlers[0] = attackAll(1);
    t.handlers[1] = castOnce('Fog', (g) => g.step === 'declareBlockers');
    const life = b.life;
    t.finishTurn();
    expect(b.life).toBe(life);
    expect(log(t, /prevents all combat damage/)).toHaveLength(1);
  });

  it('Maze of Ith untaps an attacker and prevents the damage it would deal', () => {
    const t = new Table();
    const [, b] = t.game.players;
    const big = t.game.put(0, wurm());
    t.game.put(0, bears());
    const maze = t.game.put(1, card({ name: 'Maze of Ith', types: ['Land'], text: '{T}: Untap target attacking creature. Prevent all combat damage that would be dealt to and dealt by that creature this turn.' }));
    t.handlers[0] = attackAll(1);
    t.handlers[1] = (g, d) => {
      if (d.kind === 'target') return { kind: 'perm', id: big.id };
      if (d.kind === 'priority' && g.step === 'declareBlockers') {
        const i = d.actions.findIndex((x) => x.type === 'activate' && x.permId === maze.id);
        if (i !== -1) return { action: i };
      }
      return undefined;
    };
    const life = b.life;
    t.finishTurn();
    expect(b.life).toBe(life - 2);
    expect(big.tapped).toBe(false);
  });

  it('Inkshield prevents the damage to you and makes a 2/1 flyer for each 1 prevented', () => {
    const t = new Table();
    const [, b] = t.game.players;
    t.game.put(0, bears());
    t.game.put(0, bears());
    t.lands(1, 5);
    b.hand.push(spell('Inkshield', '{3}{G}{G}', 5, 'Instant', 'Prevent all combat damage that would be dealt to you this turn. For each 1 damage prevented this way, create a 2/1 white and black Inkling creature token with flying.'));
    t.handlers[0] = attackAll(1);
    t.handlers[1] = castOnce('Inkshield', (g) => g.step === 'declareBlockers');
    const life = b.life;
    t.finishTurn();
    expect(b.life).toBe(life);
    expect(b.battlefield.filter((q) => q.token && q.card.keywords.includes('flying'))).toHaveLength(4);
  });

  it('the bot casts Fog against a lethal attack, and keeps it against a small one', () => {
    for (const [attackers, expectFog] of [[1, false], [5, true]] as const) {
      const t = new Table();
      const [, b] = t.game.players;
      for (let i = 0; i < attackers; i++) t.game.put(0, wurm());
      t.lands(1, 1);
      b.life = 25;
      b.hand.push(spell('Fog', '{G}', 1, 'Instant', 'Prevent all combat damage that would be dealt this turn.'));
      t.handlers[0] = attackAll(1);
      t.until(atBlockers(1));
      const d: Decision = { kind: 'priority', seat: 1, actions: t.game.legalActions(b) };
      const answer = new Bot(1, 7).decide(t.game, d) as { action: number };
      expect(d.actions[answer.action].type === 'cast').toBe(expectFog);
    }
  });
});

describe('energy counters (rule 122.1, 107.14)', () => {
  it('Aether Refinery doubles energy; "whenever you get {E}" triggers once per event', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    t.game.put(0, artifact('Aether Refinery', 'If you would get one or more {E} (energy counters), you get twice that many {E} instead.', '{4}{G}{G}', 6));
    t.game.put(0, artifact('Fabrication Module', 'Whenever you get one or more {E} (energy counters), put a +1/+1 counter on target creature you control.\n{4}, {T}: You get {E}.', '{3}', 3));
    const bear = t.game.put(0, bears());
    a.hand.push(artifact('Aether Hub Relic', 'When this artifact enters, you get {E}{E} (two energy counters).', '{2}', 2));
    t.handlers[0] = castOnce('Aether Hub Relic');
    t.finishTurn();
    expect(a.energy).toBe(4);
    expect(bear.counters).toBe(1);
  });

  it('an ability that costs energy needs the energy, and spends it', () => {
    const t = new Table();
    const [a] = t.game.players;
    const roil = t.game.put(0, creature('Roil Cartographer', '{1}{U}', 2, 1, 3, { text: 'Landfall — Whenever a land you control enters, you get {E} (an energy counter).\n{T}, Pay six {E}: Draw three cards.' }), { sick: false });
    const canDraw = () => t.game.legalActions(a).some((x) => x.type === 'activate' && x.permId === roil.id && x.effect.kind === 'draw');
    a.energy = 5;
    expect(canDraw()).toBe(false);
    a.energy = 7;
    expect(canDraw()).toBe(true);
    const hand = a.hand.length;
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority') return undefined;
      const i = d.actions.findIndex((x) => x.type === 'activate' && x.permId === roil.id);
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(a.energy).toBe(1);
    expect(a.hand.length).toBe(hand + 3);
  });

  it('Galvanic Discharge pays just the energy the kill needs and keeps the rest', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 1);
    const target = t.game.put(1, bears());
    a.energy = 2;
    a.hand.push(spell('Galvanic Discharge', '{G}', 1, 'Instant', 'Choose target creature or planeswalker. You get {E}{E}{E} (three energy counters), then you may pay any amount of {E}. Galvanic Discharge deals that much damage to that permanent.'));
    const cast = castOnce('Galvanic Discharge');
    t.handlers[0] = (g, d) => (d.kind === 'target' ? { kind: 'perm', id: target.id } : cast(g, d));
    t.finishTurn();
    expect(t.game.findPerm(target.id)).toBeNull();
    expect(a.energy).toBe(3);
  });

  it('Solar Transformer pays energy for colored mana', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.game.put(0, artifact('Solar Transformer', 'This artifact enters tapped.\nWhen this artifact enters, you get {E}{E}{E} (three energy counters).\n{T}: Add {C}.\n{T}, Pay {E}: Add one mana of any color.'));
    a.energy = 1;
    expect(t.game.colorsAvailable(a).has('G')).toBe(true);
    a.hand.push(creature('Llanowar Scout', '{G}', 1, 1, 1));
    t.handlers[0] = castOnce('Llanowar Scout');
    t.finishTurn();
    expect(a.battlefield.some((q) => q.card.name === 'Llanowar Scout')).toBe(true);
    expect(a.energy).toBe(0);
  });
});

describe('charge counters', () => {
  it('Darksteel Reactor wins the game at twenty charge counters', () => {
    const t = new Table();
    const reactor = t.game.put(0, artifact('Darksteel Reactor', 'Indestructible\nAt the beginning of your upkeep, you may put a charge counter on this artifact.\nWhen this artifact has twenty or more charge counters on it, you win the game.', '{4}', 4));
    reactor.charge = 19;
    t.until((g) => g.over || (g.activeSeat === 0 && g.turnNumber > 1 && g.step === 'main1'));
    expect(t.game.over).toBe(true);
    expect(t.game.winner).toBe(0);
  });

  it('Golem Foundry gets counters from artifact spells and turns three into a Golem', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 2);
    const foundry = t.game.put(0, artifact('Golem Foundry', 'Whenever you cast an artifact spell, you may put a charge counter on this artifact.\nRemove three charge counters from this artifact: Create a 3/3 colorless Golem artifact creature token.', '{3}', 3));
    foundry.charge = 2;
    a.hand.push(artifact('Mind Stone', '{T}: Add {C}.'));
    const cast = castOnce('Mind Stone');
    t.handlers[0] = (g, d) => {
      const c = cast(g, d);
      if (c) return c;
      if (d.kind !== 'priority') return undefined;
      const i = d.actions.findIndex((x) => x.type === 'activate' && x.permId === foundry.id);
      return i === -1 ? undefined : { action: i };
    };
    t.finishTurn();
    expect(foundry.charge).toBe(0);
    expect(a.battlefield.filter((q) => q.token && q.card.power === 3)).toHaveLength(1);
  });

  it('Astral Cornucopia makes one mana per charge counter; Pentad Prism spends its counters', () => {
    const t = new Table();
    const [a] = t.game.players;
    const horn = t.game.put(0, artifact('Astral Cornucopia', 'This artifact enters with X charge counters on it.\n{T}: Choose a color. Add one mana of that color for each charge counter on this artifact.', '{X}{X}{X}', 0));
    horn.charge = 3;
    const prism = t.game.put(0, artifact('Pentad Prism', 'Sunburst (This artifact enters with a charge counter on it for each color of mana spent to cast it.)\nRemove a charge counter from this artifact: Add one mana of any color.'));
    prism.charge = 2;
    expect(t.game.availableMana(a)).toBe(5);
    a.hand.push(creature('Big Thing', '{3}{G}{G}', 5, 5, 5));
    t.handlers[0] = castOnce('Big Thing');
    t.finishTurn();
    expect(a.battlefield.some((q) => q.card.name === 'Big Thing')).toBe(true);
    expect(prism.charge).toBe(0);
  });

  it('proliferate adds charge counters and energy (rule 701.34a)', () => {
    const t = new Table();
    const [a] = t.game.players;
    t.lands(0, 3);
    const foundry = t.game.put(0, artifact('Golem Foundry', 'Remove three charge counters from this artifact: Create a 3/3 colorless Golem artifact creature token.', '{3}', 3));
    foundry.charge = 1;
    a.energy = 2;
    a.hand.push(spell('Tezzeret\'s Gambit', '{2}{G}', 3, 'Sorcery', 'Draw two cards, then proliferate.'));
    t.handlers[0] = castOnce("Tezzeret's Gambit");
    t.finishTurn();
    expect(foundry.charge).toBe(2);
    expect(a.energy).toBe(3);
  });
});
