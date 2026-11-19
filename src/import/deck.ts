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

  const issues = commanderDeckIssues(commanderEntries, opts.cards.filter((c) => !commanderEntries.includes(c)), identity);

  return {
    id: opts.id,
    name: opts.name,
    source: opts.source,
    url: opts.url,
    commanders,
    cards,
    colorIdentity: COLORS.filter((c) => identity.has(c)),
    importedAt: Date.now(),
    ...(issues.length ? { issues } : {}),
  };
}

const PAIRS: Record<string, string> = { friendsForever: 'friendsForever', chooseBackground: 'background', background: 'chooseBackground', doctorsCompanion: 'doctor', doctor: 'doctorsCompanion' };

/** Can these two commanders share a deck? (rule 702.124) */
function canPair(a: SimCard, b: SimCard): boolean {
  const pa = a.pairing;
  const pb = b.pairing;
  if (!pa || !pb) return false;
  if (typeof pa === 'object' || typeof pb === 'object') {
    if (typeof pa === 'object' && 'with' in pa) return pa.with === b.name;
    if (typeof pb === 'object' && 'with' in pb) return pb.with === a.name;
    return typeof pa === 'object' && typeof pb === 'object' && 'group' in pa && 'group' in pb && pa.group === pb.group;
  }
  if (pa === 'partner' && pb === 'partner') return true;
  if (pa === 'friendsForever' && pb === 'friendsForever') return true;
  return PAIRS[pa] === pb;
}

/**
 * Where a deck breaks the Commander deck rules (rules 903.3, 903.5): 100 cards counting the commanders, one copy of
 * each card but basic lands (and cards that say otherwise), everything inside the commanders' color identity, and
 * commanders that may lead a deck together. The deck still imports and plays; these are shown to the player.
 */
export function commanderDeckIssues(commanders: ImportedCard[], cards: ImportedCard[], identity: Set<Color>): string[] {
  const out: string[] = [];
  const size = cards.reduce((n, c) => n + c.count, 0) + commanders.reduce((n, c) => n + c.count, 0);
  if (size !== 100) out.push(`The deck has ${size} cards; a Commander deck has exactly 100, counting the commander (rule 903.5a).`);
  const named = new Map<string, number>();
  for (const c of cards) named.set(c.card.name, (named.get(c.card.name) ?? 0) + c.count);
  for (const c of cards) {
    const n = named.get(c.card.name) ?? 0;
    named.delete(c.card.name);
    const limit = c.card.isBasic ? Infinity : c.card.copyLimit ?? 1;
    if (n > limit) out.push(`${n} copies of ${c.card.name}: only one of each card is allowed, apart from basic lands (rule 903.5b).`);
  }
  const off = cards.filter((c) => c.colorIdentity.some((x) => !identity.has(x)));
  if (off.length) out.push(`Outside the commander's color identity (rule 903.5c): ${off.map((c) => c.card.name).join(', ')}.`);
  for (const c of commanders) {
    if (!c.card.canCommand) out.push(`${c.card.name} can't be a commander: it isn't a legendary creature, Vehicle or Spacecraft (rule 903.3).`);
  }
  if (commanders.length > 2) out.push(`${commanders.length} commanders: a deck has one, or two that can pair (rule 702.124).`);
  if (commanders.length === 2 && !canPair(commanders[0].card, commanders[1].card)) out.push(`${commanders[0].card.name} and ${commanders[1].card.name} can't share the command zone: neither lets the other be a second commander (rule 702.124).`);
  return out;
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
