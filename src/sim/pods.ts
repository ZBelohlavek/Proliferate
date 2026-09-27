/** No game ever seats more than this many players, however many decks are selected. */
export const MAX_PLAYERS = 6;

/** Standard Commander table size, used unless you pick something else. */
export const DEFAULT_PLAYERS = 4;

/**
 * How many players sit at the next game.
 * podSize 2–6 is a fixed table size; 0 means "mixed": a random size from 2 to 6
 * each game. Never more than MAX_PLAYERS or the number of decks available.
 */
export function pickPodSize(podSize: number, deckCount: number): number {
  const max = Math.min(MAX_PLAYERS, deckCount);
  if (podSize === 0) return 2 + Math.floor(Math.random() * (max - 1));
  return Math.max(2, Math.min(podSize, max));
}

/** Clean up a pod-size setting (from storage or a request) to 0 (mixed) or 2–6. */
export function sanitizePodSize(value: unknown): number {
  const n = Number(value);
  if (n === 0) return 0;
  return Number.isInteger(n) && n >= 2 && n <= MAX_PLAYERS ? n : DEFAULT_PLAYERS;
}

/**
 * How decks are drawn for each game:
 * - 'balanced': random, but decks that have played the fewest games go first,
 *   so every deck gets about the same number of games.
 * - 'random':   every game draws a fresh, uniformly random set of decks.
 */
export type Pairing = 'balanced' | 'random';

/** Unbiased in-place shuffle (Fisher–Yates). */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * Pick the decks for the next game and seat them in a random order.
 * `played` counts games per deck id and is updated.
 */
export function choosePod<T>(decks: T[], idOf: (d: T) => string, played: Map<string, number>, podSize: number, pairing: Pairing, random: () => number = Math.random): T[] {
  const size = pickPodSize(podSize, decks.length);
  let pod: T[];
  if (pairing === 'random') {
    pod = shuffle([...decks], random).slice(0, size);
  } else {
    // Shuffle first so ties between equally-played decks are broken at random.
    const shuffled = shuffle([...decks], random);
    shuffled.sort((a, b) => (played.get(idOf(a)) ?? 0) - (played.get(idOf(b)) ?? 0));
    pod = shuffled.slice(0, size);
  }
  for (const d of pod) played.set(idOf(d), (played.get(idOf(d)) ?? 0) + 1);
  // Random seats: going first matters.
  return shuffle(pod, random);
}
