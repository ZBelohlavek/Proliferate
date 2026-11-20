// Cards the bots used to misplay, found with tools/misplay.ts over Zach's decks: cards never cast
// (edicts that target no one, permanents whose abilities react later, spells that untap what they cost,
// tutors and impulse draw the cast scores gave no worth), burn triggers aimed at the bot's own creatures,
// counterspells aimed at its own spells, blinks of tokens and stolen creatures, and board wipes that cost
// the bot more than they cost the average opponent.

import { describe, expect, it } from 'vitest';
import { Bot } from '../src/rules/bot';
import type { Decision } from '../src/rules/types';
import { card, creature } from './helpers';
import { Table } from './table';

const botSeat = (t: Table, seat: number) => {
  const bot = new Bot(seat, 1);
  t.handlers[seat] = (g, d) => bot.decide(g, d);
  return bot;
};
const big = (name = 'Huge Wurm') => creature(name, '{6}{G}{G}', 8, 8, 8);

describe('cards bots never cast', () => {
  it('casts a permanent whose only abilities answer later (Strionic Resonator)', () => {
    const t = new Table();
    const resonator = card({ name: 'Strionic Resonator', manaCost: '{2}', cmc: 2, types: ['Artifact'], text: '{2}, {T}: Copy target triggered ability you control. You may choose new targets for the copy.' });
    t.game.players[0].hand.push(resonator);
    t.lands(0, 2);
    botSeat(t, 0);
    t.finishTurn();
    expect(t.game.players[0].battlefield.some((q) => q.card === resonator)).toBe(true);
  });

  it('casts an edict that makes each opponent sacrifice (no target to aim at)', () => {
    const t = new Table();
    const edict = card({ name: 'Test Edict', manaCost: '{1}{G}', cmc: 2, types: ['Sorcery'], colorIdentity: ['G'], text: 'Each opponent sacrifices a creature.' });
    t.game.players[0].hand.push(edict);
    t.lands(0, 2);
    const wurm = t.game.put(1, big());
    botSeat(t, 0);
    t.finishTurn();
    expect(t.game.players[1].battlefield.includes(wurm)).toBe(false);
  });

  it('values a spell that untaps the lands it cost for the cards it draws (Frantic Search)', () => {
    const t = new Table();
    const search = card({ name: 'Test Search', manaCost: '{2}{G}', cmc: 3, types: ['Instant'], colorIdentity: ['G'], text: 'Draw two cards, then discard two cards. Untap up to three lands.' });
    t.lands(0, 3);
    const bot = new Bot(0, 1) as any;
    expect(bot.castScore(t.game, t.game.players[0], search, false, 0, true)).not.toBeNull();
  });
});

describe('targets the right way round', () => {
  it('a forced burn trigger hits an opponent rather than our own creature', () => {
    const t = new Table();
    const mine = t.game.put(0, big('Our Wurm'));
    const src = card({ name: 'Test Pinger', manaCost: '{2}{R}', cmc: 3, types: ['Creature'], power: '1', toughness: '1', text: 'Whenever you cast a spell, this creature deals 1 damage to any target.' });
    const effect = src.effects.find((e) => e.kind === 'removal')!;
    const d: Decision = { kind: 'target', seat: 0, prompt: '', card: src, effect, cancellable: false, candidates: [{ kind: 'perm', id: mine.id }, { kind: 'player', seat: 0 }, { kind: 'player', seat: 1 }] };
    const answer = new Bot(0, 1).decide(t.game, d);
    expect(answer).toEqual({ kind: 'player', seat: 1 });
  });

  it('never blinks a creature it took from an opponent', () => {
    const t = new Table();
    const stolen = t.game.put(0, creature('Their Seer', '{2}{U}', 3, 2, 2, { text: 'When this creature enters, draw two cards.' }));
    stolen.owner = 1;
    const ours = t.game.put(0, creature('Our Bear', '{1}{G}', 2, 2, 2));
    const src = card({ name: 'Test Blink', manaCost: '{W}', cmc: 1, types: ['Instant'], text: 'Exile target creature you control, then return that card to the battlefield under its owner\'s control.' });
    const effect = src.effects.find((e) => e.kind === 'blink')!;
    const d: Decision = { kind: 'target', seat: 0, prompt: '', card: src, effect, cancellable: false, candidates: [{ kind: 'perm', id: stolen.id }, { kind: 'perm', id: ours.id }] };
    expect(new Bot(0, 1).decide(t.game, d)).toEqual({ kind: 'perm', id: ours.id });
  });
});

describe('board wipes', () => {
  it("doesn't wipe when it loses as much as each opponent", () => {
    const t = new Table(4);
    const wrath = card({ name: 'Test Wrath', manaCost: '{2}{G}{G}', cmc: 4, types: ['Sorcery'], colorIdentity: ['G'], text: 'Destroy all creatures.' });
    t.game.put(0, big('Our Wurm'));
    for (const seat of [1, 2, 3]) t.game.put(seat, big(`Wurm ${seat}`));
    t.lands(0, 4);
    const bot = new Bot(0, 1) as any;
    expect(bot.castScore(t.game, t.game.players[0], wrath, false, 0, false)).toBeNull();
    // With more on each opponent's side than ours, it is worth it.
    for (const seat of [1, 2, 3]) t.game.put(seat, big(`Second Wurm ${seat}`));
    expect(bot.castScore(t.game, t.game.players[0], wrath, false, 0, false)).not.toBeNull();
  });
});
