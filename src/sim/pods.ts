/** podSize 0 means "mixed": a random size from 2 to 6 (or the number of decks) each game. */
export function pickPodSize(podSize: number, deckCount: number): number {
  const max = Math.min(6, deckCount);
  if (podSize === 0) return 2 + Math.floor(Math.random() * (max - 1));
  return Math.min(podSize, deckCount);
}
