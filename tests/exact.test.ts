// The last cards in Zach's decks that used to be played as something close ("≈"), now played as printed
// (cardRulesExact.ts), and the engine pieces they needed: piles, phasing, ripple, counts worked out as they
// resolve, soulbond, evolve, reconfigure, Treasures that stay, damage-only Phyrexian Unlife and Angel's Grace.

import { describe, expect, it } from 'vitest';
import type { SimCard } from '../src/engine/types';
import { card, creature, spell } from './helpers';
import { castOnce, Table } from './table';

const log = (t: Table, re: RegExp) => t.game.log!.filter((l) => re.test(l));
const g = (t: Table) => t.game as unknown as Record<string, any>;
const artifact = (name: string, cost: string, cmc: number, text = '') => card({ name, manaCost: cost, cmc, types: ['Artifact'], text });
const enchantment = (name: string, cost: string, cmc: number, text = '') => card({ name, manaCost: cost, cmc, types: ['Enchantment'], text });
const filler = (cmc: number): SimCard => creature(`Filler ${cmc}`, `{${cmc}}`, cmc, 1, 1);

describe('cards that play as printed (cardRulesExact.ts)', () => {
  it("Tasha's Hideous Laughter exiles until the mana values reach 20", () => {
    const t = new Table();
    t.lands(0, 3);
    const [a, b] = t.game.players;
    b.library = Array.from({ length: 10 }, () => filler(5));
    a.hand.push(spell("Tasha's Hideous Laughter", '{3}', 3, 'Sorcery', ''));
    t.handlers[0] = castOnce("Tasha's Hideous Laughter");
    t.until((gm) => gm.step !== 'main1');
    expect(b.exile).toHaveLength(4);
    expect(log(t, /exiles 4 cards .*total mana value 20/)).toHaveLength(1);
  });

  it('Fact or Fiction: the opponent splits five cards; one pile to hand, the other to the graveyard', () => {
    const t = new Table();
    t.lands(0, 4);
    const a = t.game.players[0];
    a.library = [filler(1), filler(2), filler(3), filler(4), filler(5), filler(6)];
    a.hand.push(spell('Fact or Fiction', '{4}', 4, 'Instant', ''));
    t.handlers[0] = castOnce('Fact or Fiction');
    t.until((gm) => gm.step !== 'main1');
    expect(a.hand.length + a.graveyard.filter((c) => c.name.startsWith('Filler')).length).toBe(5);
    expect(log(t, /splits the cards/)).toHaveLength(1);
  });

  it('Living Death: graveyard creatures come back, battlefield creatures go', () => {
    const t = new Table();
    t.lands(0, 5);
    const [a, b] = t.game.players;
    const dead = creature('Old Wurm', '{6}', 6, 6, 6);
    a.graveyard.push(dead);
    t.game.put(1, creature('Their Bear', '{2}', 2, 2, 2));
    a.hand.push(spell('Living Death', '{5}', 5, 'Sorcery', ''));
    t.handlers[0] = castOnce('Living Death');
    t.until((gm) => gm.step !== 'main1');
    expect(a.battlefield.some((q) => q.card === dead)).toBe(true);
    expect(b.battlefield.some((q) => q.card.name === 'Their Bear')).toBe(false);
    expect(b.graveyard.some((c) => c.name === 'Their Bear')).toBe(true);
    expect(a.graveyard.includes(dead)).toBe(false);
  });

  it('Selective Obliteration keeps colorless permanents and the chosen color', () => {
    const t = new Table();
    t.lands(0, 5);
    const b = t.game.players[1];
    const rock = t.game.put(1, artifact('Mind Stone', '{2}', 2, '{T}: Add {C}.'));
    const gold = t.game.put(1, card({ name: 'Gold Thing', manaCost: '{W}{U}', cmc: 2, types: ['Enchantment'], colorIdentity: ['W', 'U'] }));
    t.game.players[0].hand.push(spell('Selective Obliteration', '{5}', 5, 'Sorcery', ''));
    t.handlers[0] = castOnce('Selective Obliteration');
    t.until((gm) => gm.step !== 'main1');
    expect(b.battlefield.includes(rock)).toBe(true);
    expect(b.battlefield.includes(gold)).toBe(false);
  });

  it('The Great Henge costs {X} less for the greatest power among your creatures', () => {
    const t = new Table();
    const a = t.game.players[0];
    const henge = artifact('The Great Henge', '{7}{G}{G}', 9);
    expect(t.game.effectiveCost(a, henge, false)).toBe(9);
    t.game.put(0, creature('Big One', '{5}', 5, 5, 5));
    expect(t.game.effectiveCost(a, henge, false)).toBe(4);
  });

  it('Seal of the Guildpact: {1} less for each chosen color the spell is', () => {
    const t = new Table();
    const a = t.game.players[0];
    t.game.put(0, artifact('Seal of the Guildpact', '{5}', 5));
    const seal = a.battlefield[0];
    seal.chosenColors = ['G', 'U'];
    const gu = creature('Two Colors', '{2}{G}{U}', 4, 2, 2, { colorIdentity: ['G', 'U'] });
    expect(t.game.effectiveCost(a, gu, false)).toBe(2);
  });

  it("Mauhúr: one extra +1/+1 counter on an Orc, none on others", () => {
    const t = new Table();
    t.game.put(0, creature('Mauhúr, Uruk-hai Captain', '{2}', 2, 2, 2, { subTypes: ['Orc', 'Soldier'] }));
    const orc = t.game.put(0, creature('Orc Grunt', '{1}', 1, 1, 1, { subTypes: ['Orc'] }));
    const elf = t.game.put(0, creature('Elf Scout', '{1}', 1, 1, 1, { subTypes: ['Elf'] }));
    t.game.putCounters(orc, 1);
    t.game.putCounters(elf, 1);
    expect(orc.counters).toBe(2);
    expect(elf.counters).toBe(1);
  });

  it("Vraska's -2 leaves the creature on the battlefield as a Treasure", () => {
    const t = new Table();
    const b = t.game.players[1];
    const bear = t.game.put(1, creature('Their Bear', '{2}', 2, 2, 2));
    const vraska = card({ name: "Vraska, Betrayal's Sting", manaCost: '{6}', cmc: 6, types: ['Planeswalker'], loyalty: '6' });
    const minus = vraska.effects.find((e) => e.kind === 'becomeTreasure')!;
    const flow = g(t).resolveEffect(t.game.players[0], minus, null, 0, { kind: 'perm', id: bear.id });
    while (!flow.next().done);
    expect(b.battlefield.includes(bear)).toBe(true);
    expect(bear.card.isCreature).toBe(false);
    expect(bear.card.isArtifact).toBe(true);
    expect(t.game.availableMana(b)).toBe(1);
  });

  it('Phyrexian Unlife: at 0 life damage becomes poison, other life loss stays life loss', () => {
    const t = new Table();
    const a = t.game.players[0];
    t.game.put(0, enchantment('Phyrexian Unlife', '{3}', 3));
    a.life = 0;
    const dealt = t.game.damageAfter(t.game.players[1], null, null, a, 3, false);
    t.game.loseLife(a, dealt, t.game.players[1], 'noncombat');
    expect(a.poison).toBe(3);
    expect(a.life).toBe(0);
    t.game.loseLife(a, 2, t.game.players[1], 'noncombat');
    expect(a.life).toBe(-2);
  });

  it("Angel's Grace: damage can't take you below 1 this turn", () => {
    const t = new Table();
    t.lands(0, 1);
    const a = t.game.players[0];
    a.hand.push(spell("Angel's Grace", '{1}', 1, 'Instant', ''));
    t.handlers[0] = castOnce("Angel's Grace");
    t.until(() => a.graceTurn !== undefined);
    a.graceTurn = t.game.turnNumber;
    a.life = 5;
    const dealt = t.game.damageAfter(t.game.players[1], null, null, a, 20, false);
    t.game.loseLife(a, dealt, t.game.players[1], 'noncombat');
    expect(a.life).toBe(1);
  });

  it('March of Swirling Mist phases a creature out until its next untap step', () => {
    const t = new Table();
    const a = t.game.players[0];
    const bear = t.game.put(0, creature('My Bear', '{2}', 2, 2, 2));
    g(t).phaseOut(bear);
    expect(a.battlefield.includes(bear)).toBe(false);
    expect(a.phased).toContain(bear);
    g(t).phaseIn(a);
    expect(a.battlefield.includes(bear)).toBe(true);
  });

  it('Tandem Lookout pairs with a creature as it enters (soulbond)', () => {
    const t = new Table();
    t.lands(0, 3);
    const a = t.game.players[0];
    const bear = t.game.put(0, creature('My Bear', '{2}', 2, 2, 2));
    a.hand.push(creature('Tandem Lookout', '{3}', 3, 2, 1));
    t.handlers[0] = castOnce('Tandem Lookout');
    t.until((gm) => gm.step !== 'main1');
    const lookout = a.battlefield.find((q) => q.card.name === 'Tandem Lookout')!;
    expect(lookout.pairedWith).toBe(bear.id);
    expect(bear.pairedWith).toBe(lookout.id);
  });

  it('Pollywog Prodigy evolves when a bigger creature enters', () => {
    const t = new Table();
    t.lands(0, 6);
    const a = t.game.players[0];
    const frog = t.game.put(0, creature('Pollywog Prodigy', '{2}', 2, 1, 3));
    a.hand.push(creature('Craw Wurm', '{6}', 6, 6, 4));
    t.handlers[0] = castOnce('Craw Wurm');
    t.until((gm) => gm.step !== 'main1');
    expect(frog.counters).toBe(1);
  });

  it("Codie: you can't cast permanent spells", () => {
    const t = new Table();
    t.lands(0, 3);
    const a = t.game.players[0];
    t.game.put(0, artifact('Codie, Vociferous Codex', '{3}', 3));
    a.hand.push(creature('Grizzly Bears', '{2}', 2, 2, 2));
    expect(t.game.legalActions(a).some((x) => x.type === 'cast')).toBe(false);
  });

  it('Sphere of Safety taxes each attacker by the enchantments you control', () => {
    const t = new Table();
    const b = t.game.players[1];
    t.game.put(1, enchantment('Sphere of Safety', '{5}', 5));
    t.game.put(1, enchantment('Other Aura Thing', '{1}', 1));
    const bear = t.game.put(0, creature('My Bear', '{2}', 2, 2, 2));
    expect(g(t).attackTax(b, bear)).toBe(2);
  });

  it('Coppercoat Vanguard pumps other Humans only', () => {
    const t = new Table();
    t.game.put(0, creature('Coppercoat Vanguard', '{2}', 2, 2, 2, { subTypes: ['Human', 'Soldier'] }));
    const human = t.game.put(0, creature('Human Guy', '{1}', 1, 1, 1, { subTypes: ['Human'] }));
    const elf = t.game.put(0, creature('Elf Guy', '{1}', 1, 1, 1, { subTypes: ['Elf'] }));
    expect(t.game.power(human)).toBe(2);
    expect(t.game.power(elf)).toBe(1);
  });

  it('Wick: a second Rat grows the Snail instead of making another', () => {
    const t = new Table();
    t.lands(0, 6);
    const a = t.game.players[0];
    a.hand.push(creature('Wick, the Whorled Mind', '{4}', 4, 2, 4, { subTypes: ['Rat', 'Warlock'] }));
    a.hand.push(creature('Sewer Rat', '{1}', 1, 1, 1, { subTypes: ['Rat'] }));
    let cast = 0;
    t.handlers[0] = (gm, d) => {
      if (d.kind !== 'priority' || gm.stack.length) return undefined;
      const name = cast === 0 ? 'Wick, the Whorled Mind' : cast === 1 ? 'Sewer Rat' : null;
      const i = name ? d.actions.findIndex((x) => x.type === 'cast' && x.card.name === name) : -1;
      if (i === -1) return undefined;
      cast++;
      return { action: i };
    };
    t.until((gm) => gm.step !== 'main1');
    const snails = a.battlefield.filter((q) => /Snail/.test(q.card.name));
    expect(snails).toHaveLength(1);
    expect(snails[0].counters).toBe(1);
  });

  it('Razorfield Ripper is not a creature while attached by reconfigure', () => {
    const t = new Table();
    t.lands(0, 2);
    const a = t.game.players[0];
    const ripper = t.game.put(0, creature('Razorfield Ripper', '{3}', 3, 3, 3));
    const bear = t.game.put(0, creature('My Bear', '{2}', 2, 2, 2));
    const equip = ripper.card.effects.find((e) => e.kind === 'equip')!;
    t.handlers[0] = (gm, d) => {
      if (d.kind === 'target') return { kind: 'perm', id: bear.id };
      if (d.kind !== 'priority' || ripper.attachedTo !== null || gm.stack.length) return undefined;
      const i = d.actions.findIndex((x) => x.type === 'activate' && x.permId === ripper.id && x.effect === equip);
      return i === -1 ? undefined : { action: i };
    };
    t.until(() => ripper.attachedTo === bear.id);
    expect(ripper.card.isCreature).toBe(false);
    (t.game as unknown as { removePerm: (q: unknown, to: string) => void }).removePerm(bear, 'graveyard');
    g(t).stateBasedActions();
    expect(ripper.card.isCreature).toBe(true);
    expect(a.battlefield.includes(ripper)).toBe(true);
  });
  it("Tishana's Tidebinder counters an ability and blanks its source while it stays", () => {
    const t = new Table();
    const engine = t.game.put(1, creature('Ability Engine', '{2}', 2, 2, 2, { text: 'Flying' }));
    const binder = t.game.put(0, creature("Tishana's Tidebinder", '{2}{G}', 3, 3, 2));
    t.game.stack.push({ id: 9999, kind: 'ability', controller: 1, card: engine.card, effects: [], targets: [], x: 0, isCommander: false, sourceId: engine.id, attachTo: null, label: 'Ability Engine (ability)' });
    const counter = binder.card.effects.find((e) => e.kind === 'counterAbility')!;
    expect(g(t).targetCandidates(t.game.players[0], counter, binder)).toEqual([{ kind: 'stack', id: 9999 }]);
    const flow = g(t).resolveEffect(t.game.players[0], counter, binder, 0, { kind: 'stack', id: 9999 });
    while (!flow.next().done);
    expect(t.game.stack).toHaveLength(0);
    expect(t.game.hasKw(engine, 'flying')).toBe(false);
    (t.game as unknown as { removePerm: (q: unknown, to: string) => void }).removePerm(binder, 'graveyard');
    expect(t.game.hasKw(engine, 'flying')).toBe(true);
  });
});
