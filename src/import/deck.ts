// Assemble classified cards into a SimDeck and sanity-check it.

import type { Color, SimCard, SimDeck } from '../engine/types';
import { COLORS } from '../engine/types';

export interface ImportedCard {
  card: SimCard;
  count: number;
  isCommander: boolean;
  colorIdentity: Color[];
}

export function buildDeck(opts: {
  id: string;
  name: string;
  source: SimDeck['source'];
  url?: string;
  cards: ImportedCard[];
}): SimDeck {
  let commanderEntries = opts.cards.filter((c) => c.isCommander);
  // No commander marked? Guess: the first legendary creature.
  if (!commanderEntries.length) {
    const guess = opts.cards.find((c) => c.card.isLegendary && c.card.isCreature);
    if (guess) commanderEntries = [guess];
  }
  if (!commanderEntries.length) throw new Error('Couldn\'t find a commander. Mark it with a "Commander" category (Archidekt) or a "Commander" section / *CMDR* tag (text).');

  const identity = new Set<Color>();
  for (const c of commanderEntries) c.colorIdentity.forEach((x) => identity.add(x));

  const commanders = commanderEntries.map((c) => c.card);
  const cards = opts.cards
    .filter((c) => !commanderEntries.includes(c))
    .map((c) => ({ card: c.card, count: c.count }));

  const size = cards.reduce((n, c) => n + c.count, 0) + commanders.length;
  if (size < 60) throw new Error(`Only found ${size} cards — is this a full Commander deck?`);

  return {
    id: opts.id,
    name: opts.name,
    source: opts.source,
    url: opts.url,
    commanders,
    cards,
    colorIdentity: COLORS.filter((c) => identity.has(c)),
    importedAt: Date.now(),
  };
}

export function deckSize(deck: SimDeck): number {
  return deck.cards.reduce((n, c) => n + c.count, 0) + deck.commanders.length;
}

/** Fraction of non-land cards the classifier understood. */
export function modeledFraction(deck: SimDeck): number {
  let total = 0;
  let modeled = 0;
  for (const { card, count } of deck.cards) {
    if (card.isLand) continue;
    total += count;
    if (card.modeled) modeled += count;
  }
  return total ? modeled / total : 1;
}
