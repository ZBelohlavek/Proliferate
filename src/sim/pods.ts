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
