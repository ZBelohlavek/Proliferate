import { describe, expect, it } from 'vitest';
import type { SimCard, SimDeck } from '../src/engine/types';
import { Game } from '../src/rules/game';
import type { Answer, Decision } from '../src/rules/types';
import { deckStyle } from '../src/rules/styles';
import { card, creature, spell, stompyDeck } from './helpers';

// Each deck's play style, read from its own list.

const forest = () => card({ name: 'Forest', types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], colorIdentity: ['G'] });

function deckOf(id: string, commander: SimCard, cards: SimCard[]): SimDeck {
  return { id, name: id, source: 'manual', commanders: [commander], cards: [...cards.map((c) => ({ card: c, count: 1 })), { card: forest(), count: 99 - cards.length }], colorIdentity: ['G'] } as unknown as SimDeck;
}

const gear = (i: number) => spell(`Blade ${i}`, '{2}', 2, 'Artifact', 'Equipped creature gets +2/+2.\nEquip {2}', { subTypes: ['Equipment'] });
const maker = (i: number) => spell(`Muster ${i}`, '{2}{G}', 3, 'Sorcery', 'Create three 1/1 green Saproling creature tokens.', { colorIdentity: ['G'] });
const bear = (i: number) => creature(`Bear ${i}`, '{1}{G}', 2, 2, 2);

describe('deck styles', () => {
  it('a deck full of Equipment is Voltron', () => {
    const d = deckOf('voltron', creature('Champion', '{2}{G}', 3, 3, 3), [...Array.from({ length: 10 }, (_, i) => gear(i)), ...Array.from({ length: 10 }, (_, i) => bear(i))]);
    expect(deckStyle(d).styles).toContain('voltron');
    expect(deckStyle(d).styles).not.toContain('tokens');
  });

  it('a deck of token makers goes wide', () => {
    const d = deckOf('tokens', creature('Mother', '{2}{G}', 3, 2, 2), Array.from({ length: 16 }, (_, i) => maker(i)));
    expect(deckStyle(d).styles[0]).toBe('tokens');
  });

  it('a plain creature deck is beatdown', () => {
    expect(deckStyle(stompyDeck('a')).styles).toEqual(['beatdown']);
  });

  it('works the style out once per deck', () => {
    const d = stompyDeck('b');
    expect(deckStyle(d)).toBe(deckStyle(d));
  });
});

describe('board cap', () => {
  it('stops making tokens once a board is huge', () => {
    const game = new Game([stompyDeck('a'), stompyDeck('b')], 3);
    const flow = game.run();
    let next = flow.next();
    const answer = (d: Decision): Answer => {
      if (d.kind === 'priority') {
        const k = d.seat === game.activeSeat && game.step.startsWith('main') ? d.actions.findIndex((a) => a.type === 'cast') : -1;
        return { action: k === -1 ? 0 : k };
      }
      if (d.kind === 'choose') return d.options.slice(0, d.min).map((_, j) => j);
      if (d.kind === 'confirm') return false;
      if (d.kind === 'target') return d.candidates[0];
      return [];
    };
    for (let i = 0; i < 2000 && !next.done && !(game.round >= 1 && game.step === 'main1'); i++) next = flow.next(answer(next.value));
    const seat = game.activeSeat;
    const p = game.players[seat];
    p.battlefield = [];
    for (let i = 0; i < 3; i++) game.put(seat, forest());
    for (let i = 0; i < 260; i++) game.put(seat, bear(i));
    p.hand = [maker(0)];
    for (let i = 0; i < 2000 && !next.done && p.hand.length; i++) next = flow.next(answer(next.value));
    expect(p.hand.length).toBe(0);
    expect(p.battlefield.filter((q) => q.token).length).toBe(0);
  });
});
