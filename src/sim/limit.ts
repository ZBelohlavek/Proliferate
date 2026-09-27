// How long a simulation run lasts. This is separate from Forge's per-game
// clock (after which a single game is called a draw).

export interface RunLimit {
  /** Stop starting new games after this time (ms since epoch), or null. */
  stopAt: number | null;
  /** Stop after this many games in this run, or null. */
  maxGames: number | null;
}

export const NO_LIMIT: RunLimit = { stopAt: null, maxGames: null };

export function limitReached(limit: RunLimit, gamesThisRun: number, now = Date.now()): boolean {
  if (limit.stopAt !== null && now >= limit.stopAt) return true;
  if (limit.maxGames !== null && gamesThisRun >= limit.maxGames) return true;
  return false;
}

/** "1:05:09" style countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
