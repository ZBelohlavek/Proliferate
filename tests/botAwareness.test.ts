// Bots using mechanics they used to pass over: hideaway lands, extra land drops from abilities,
// activated counterspells and protection, and attacking a dangerous planeswalker through blockers.

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import { card, creature } from './helpers';
import { castOnce, Table } from './table';

const island = () => card({ name: 'Island', types: ['Land'], superTypes: ['Basic'], subTypes: ['Island'], colorIdentity: ['U'] });
const swamp = () => card({ name: 'Swamp', types: ['Land'], superTypes: ['Basic'], subTypes: ['Swamp'], colorIdentity: ['B'] });
const mosswort = () => card({
  name: 'Mosswort Bridge', types: ['Land'], colorIdentity: ['G'], producedMana: ['G'],
  text: 'Hideaway 4 (When this land enters, look at the top four cards of your library, exile one face down, then put the rest on the bottom in a random order.)\nThis land enters tapped.\n{T}: Add {G}.\n{G}, {T}: You may play the exiled card without paying its mana cost if creatures you control have total power 10 or greater.',
});
const murder = () => card({ name: 'Murder', manaCost: '{1}{B}{B}', cmc: 3, types: ['Instant'], text: 'Destroy target creature.', colorIdentity: ['B'] });
const big = () => creature('Huge Wurm', '{6}{G}{G}', 8, 8, 8, { keywords: ['Trample'], text: 'Trample' });
const walker = (loyalty: number) => card({ name: 'Test Walker', manaCost: '{4}{G}{G}', cmc: 6, types: ['Planeswalker'], loyalty, text: '+1: You gain 1 life.', colorIdentity: ['G'] });

/** Seat `seat` is played by a bot for every decision. */
const botSeat = (t: Table, seat: number) => {
  const bot = new Bot(seat, 1);
  t.handlers[seat] = (g, d) => bot.decide(g, d);
};

describe('hideaway lands', () => {
  it('a hideaway land played from hand hides a card (rule 702.75a)', () => {
    const t = new Table();
    const land = mosswort();
    t.game.players[0].hand.push(land);
    t.handlers[0] = (_g, d) => {
      if (d.kind !== 'priority') return undefined;
      const i = d.actions.findIndex((a) => a.type === 'land' && a.card === land);
      return i >= 0 ? { action: i } : undefined;
    };
    t.finishTurn();
    const perm = t.game.players[0].battlefield.find((q) => q.card === land);
    expect(perm?.hidden).toBeTruthy();
  });

  it('a bot plays the hidden card once the condition holds', () => {
    const t = new Table();
    const perm = t.game.put(0, mosswort());
    const hidden = creature('Hidden Giant', '{5}{G}{G}', 7, 7, 7);
    perm.hidden = hidden;
    t.lands(0, 1);
    t.game.put(0, big());
    t.game.put(0, creature('Bear', '{1}{G}', 2, 2, 2));
    botSeat(t, 0);
    t.finishTurn();
    expect(t.game.players[0].battlefield.some((q) => q.card === hidden)).toBe(true);
  });
});

describe('activated answers', () => {
  it("a bot sacrifices Siren Stormtamer to counter removal aimed at its best creature", () => {
    const t = new Table();
    const wurm = t.game.put(1, big());
    const tamer = t.game.put(1, creature('Siren Stormtamer', '{U}', 1, 1, 1, {
      keywords: ['Flying'], colorIdentity: ['U'],
      text: 'Flying\n{U}, Sacrifice this creature: Counter target spell or ability that targets you or a creature you control.',
    }));
    t.game.put(1, island());
    t.game.players[0].hand.push(murder());
    for (let i = 0; i < 3; i++) t.game.put(0, swamp());
    t.handlers[0] = castOnce('Murder');
    botSeat(t, 1);
    t.finishTurn();
    expect(t.game.findPerm(wurm.id)).not.toBeNull();
    expect(t.game.findPerm(tamer.id)).toBeNull();
  });

  it('a bot sacrifices Selfless Spirit to save its best creature from removal', () => {
    const t = new Table();
    const wurm = t.game.put(1, big());
    const spirit = t.game.put(1, creature('Selfless Spirit', '{1}{W}', 2, 2, 1, {
      keywords: ['Flying'], colorIdentity: ['W'],
      text: 'Flying\nSacrifice this creature: Creatures you control gain indestructible until end of turn.',
    }));
    t.game.players[0].hand.push(murder());
    for (let i = 0; i < 3; i++) t.game.put(0, swamp());
    t.handlers[0] = castOnce('Murder');
    botSeat(t, 1);
    t.finishTurn();
    expect(t.game.findPerm(wurm.id)).not.toBeNull();
    expect(t.game.findPerm(spirit.id)).toBeNull();
  });
});

describe('planeswalker attacks', () => {
  it('a bot sends enough attackers through blockers to kill a dangerous planeswalker', () => {
    const t = new Table();
    const pw = t.game.put(1, walker(5));
    t.game.put(1, creature('Squirrel', '{G}', 1, 1, 1));
    for (let i = 0; i < 4; i++) t.game.put(0, creature(`Bear ${i}`, '{2}{G}', 3, 3, 3));
    const bot = new Bot(0, 1);
    let sent = 0;
    t.handlers[0] = (g, d) => {
      if (d.kind !== 'attackers') return undefined;
      const out = bot.decide(g, d) as { planeswalker?: number }[];
      sent = out.filter((a) => a.planeswalker === pw.id).length;
      return out;
    };
    t.finishTurn();
    expect(sent).toBeGreaterThanOrEqual(2);
  });
});
