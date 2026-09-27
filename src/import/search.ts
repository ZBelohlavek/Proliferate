import type { SimDeck } from '../engine/types';

/** Why a deck matches the search, or null if it doesn't. */
export function matchSearch(deck: SimDeck, query: string): string | null {
  const q = query.trim().toLowerCase();
  if (!q) return '';
  if (deck.name.toLowerCase().includes(q)) return '';
  const commander = deck.commanders.find((c) => c.name.toLowerCase().includes(q));
  if (commander) return '';
  const card = deck.cards.find((c) => c.card.name.toLowerCase().includes(q));
  return card ? `contains ${card.card.name}` : null;
}
