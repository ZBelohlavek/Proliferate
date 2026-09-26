// Builders for small synthetic cards and decks used by the tests.

import { classifyCard, type RawCard } from '../src/engine/classify';
import type { Color, SimCard, SimDeck } from '../src/engine/types';

export function card(partial: Partial<RawCard> & { name: string }): SimCard {
  return classifyCard({
    manaCost: '',
    cmc: 0,
    types: [],
    superTypes: [],
    subTypes: [],
    text: '',
    keywords: [],
    colorIdentity: [],
    ...partial,
  });
}

export const forest = () => card({ name: 'Forest', types: ['Land'], superTypes: ['Basic'], subTypes: ['Forest'], colorIdentity: ['G'] });

export function creature(name: string, cost: string, cmc: number, power: number, toughness: number, extra: Partial<RawCard> = {}): SimCard {
  return card({ name, manaCost: cost, cmc, types: ['Creature'], power: String(power), toughness: String(toughness), colorIdentity: ['G'], ...extra });
}

/** A simple green stompy deck: 38 Forests, a commander, and 61 creatures. */
export function stompyDeck(id: string, commanderSize = 4): SimDeck {
  const commander = creature(`Commander ${id}`, '{2}{G}{G}', 4, commanderSize, commanderSize, { superTypes: ['Legendary'] });
  const bears = creature('Grizzly Bears', '{1}{G}', 2, 2, 2);
  const giants = creature('Craw Wurm', '{4}{G}{G}', 6, 6, 4);
  const elves = card({ name: 'Llanowar Elves', manaCost: '{G}', cmc: 1, types: ['Creature'], power: '1', toughness: '1', text: '{T}: Add {G}.', colorIdentity: ['G'] });
  return {
    id,
    name: `Deck ${id}`,
    source: 'text',
    commanders: [commander],
    cards: [
      { card: forest(), count: 38 },
      { card: bears, count: 30 },
      { card: giants, count: 21 },
      { card: elves, count: 10 },
    ],
    colorIdentity: ['G'] as Color[],
    importedAt: 0,
  };
}
