// How long a simulation run lasts. This is separate from Forge's per-game
// clock (after which a single game is called a draw).

import { wilson } from './stats';

export interface RunLimit {
  /** Stop starting new games after this time (ms since epoch), or null. */
  stopAt: number | null;
  /** Stop after this many games in this run, or null. */
  maxGames: number | null;
  /** Stop once every deck's win rate is known to this margin (see `settleProgress`), or null/absent. */
  settle?: number | null;
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

/** "Until the results settle": stop once every deck's win rate is known to within this many points either way. */
export const SETTLE_MARGIN = 0.05;
/** Never call a deck settled on fewer games than this, however lopsided its record. */
export const SETTLE_MIN_GAMES = 40;

export interface SettleProgress {
  settled: boolean;
  /** The deck whose win rate is least certain, and its 95% margin (half the interval's width). */
  widest: { id: string; margin: number } | null;
}

/**
 * How close a run is to settled: each deck's 95% Wilson interval for its win rate,
 * from all results so far. Settled when every deck has played `SETTLE_MIN_GAMES`
 * games and its margin is at most `margin`.
 */
export function settleProgress(records: Record<string, { games: number; wins: number } | undefined>, ids: string[], margin = SETTLE_MARGIN): SettleProgress {
  let widest: SettleProgress['widest'] = null;
  let settled = ids.length > 0;
  for (const id of ids) {
    const r = records[id] ?? { games: 0, wins: 0 };
    const [lo, hi] = wilson(r.wins, r.games);
    const m = r.games ? (hi - lo) / 2 : 1;
    if (r.games < SETTLE_MIN_GAMES || m > margin) settled = false;
    if (!widest || m > widest.margin) widest = { id, margin: m };
  }
  return { settled, widest };
}
