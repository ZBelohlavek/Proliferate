// Aggregates game results into per-deck and head-to-head statistics.

import type { GameResult, LossReason } from '../engine/types';

export interface DeckStats {
  games: number;
  wins: number;
  draws: number;
  placementSum: number;
  winRoundSum: number;
  /** How this deck eliminated opponents. */
  kills: Record<LossReason, number>;
  /** How this deck was eliminated. */
  deaths: Record<LossReason, number>;
  commanderRoundSum: number;
  commanderGames: number;
  mulligans: number;
  /** Sum over games of 1/podSize — the win rate you'd expect by pure chance. */
  expectedWins: number;
  /**
   * Finish score per game: 1 for winning, 0 for dying first, in between by
   * place ((podSize - place) / (podSize - 1)). Sum and sum of squares.
   * Optional because stats saved by older versions lack them.
   */
  scoreSum?: number;
  scoreSqSum?: number;
  /** Number of wins in each round (index = round). */
  winRounds?: number[];
}

/** How a deck did in games where a given card was early in the library / drawn / cast. */
export interface CardStat {
  /** Optional: stats from before this field existed lack it. */
  early?: number;
  earlyScore?: number;
  drawn: number;
  drawnScore: number;
  cast: number;
  castScore: number;
  /** Games where the card was both drawn and cast. */
  drawnAndCast: number;
}

export interface HeadToHead {
  meetings: number;
  /** Games where the row deck finished ahead of the column deck (ties count half). */
  ahead: number;
}

export interface Stats {
  games: number;
  decks: Record<string, DeckStats>;
  h2h: Record<string, Record<string, HeadToHead>>;
  /** Rating snapshots for the chart. */
  history: { games: number; ratings: Record<string, number> }[];
  /** Per deck, per card name. Optional for stats saved by older versions. */
  cards?: Record<string, Record<string, CardStat>>;
}


function emptyReasons(): Record<LossReason, number> {
  return { combat: 0, commander: 0, noncombat: 0, decked: 0, timeout: 0 };
}

export function emptyStats(): Stats {
  return { games: 0, decks: {}, h2h: {}, history: [], cards: {} };
}

function deckStats(stats: Stats, id: string): DeckStats {
  let d = stats.decks[id];
  if (!d) {
    d = {
      games: 0, wins: 0, draws: 0, placementSum: 0, winRoundSum: 0,
      kills: emptyReasons(), deaths: emptyReasons(),
      commanderRoundSum: 0, commanderGames: 0, mulligans: 0, expectedWins: 0,
    };
    stats.decks[id] = d;
  }
  return d;
}

function h2hCell(stats: Stats, a: string, b: string): HeadToHead {
  stats.h2h[a] ??= {};
  stats.h2h[a][b] ??= { meetings: 0, ahead: 0 };
  return stats.h2h[a][b];
}

export function addResult(stats: Stats, r: GameResult) {
  stats.games++;
  const n = r.seats.length;

  r.seats.forEach((id, seat) => {
    const d = deckStats(stats, id);
    d.games++;
    d.expectedWins += 1 / n;
    d.placementSum += r.placements[seat];
    d.mulligans += r.mulligans[seat];
    if (r.winner === seat) {
      d.wins++;
      d.winRoundSum += r.rounds;
      d.winRounds ??= [];
      d.winRounds[r.rounds] = (d.winRounds[r.rounds] ?? 0) + 1;
    }
    const score = finishScore(r.placements[seat], n);
    d.scoreSum = (d.scoreSum ?? 0) + score;
    d.scoreSqSum = (d.scoreSqSum ?? 0) + score * score;

    const seen = r.cards?.[seat];
    if (seen) {
      stats.cards ??= {};
      const byName = (stats.cards[id] ??= {});
      const stat = (name: string) => (byName[name] ??= { drawn: 0, drawnScore: 0, cast: 0, castScore: 0, drawnAndCast: 0 });
      for (const name of new Set(seen.early ?? [])) {
        const c = stat(name);
        c.early = (c.early ?? 0) + 1;
        c.earlyScore = (c.earlyScore ?? 0) + score;
      }
      const drawn = new Set(seen.drawn);
      for (const name of drawn) {
        const c = stat(name);
        c.drawn++;
        c.drawnScore += score;
      }
      for (const name of seen.cast) {
        const c = stat(name);
        c.cast++;
        c.castScore += score;
        if (drawn.has(name)) c.drawnAndCast++;
      }
    }
    if (r.winner === null && r.eliminations.some((e) => e.seat === seat && e.reason === 'timeout')) d.draws++;
    const cr = r.commanderRound[seat];
    if (cr !== null) {
      d.commanderRoundSum += cr;
      d.commanderGames++;
    }
  });

  for (const e of r.eliminations) {
    deckStats(stats, r.seats[e.seat]).deaths[e.reason]++;
    if (e.killer !== null) deckStats(stats, r.seats[e.killer]).kills[e.reason]++;
  }

  // Head-to-head: every pair in the pod is a mini-match decided by finishing position.
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      const a = r.seats[i];
      const b = r.seats[j];
      const score = r.placements[i] < r.placements[j] ? 1 : r.placements[i] === r.placements[j] ? 0.5 : 0;
      const cell = h2hCell(stats, a, b);
      cell.meetings++;
      cell.ahead += score;
    }
  }

  const every = stats.games < 500 ? 25 : stats.games < 5000 ? 100 : 500;
  if (stats.games % every === 0) {
    const ratings = computeRatings(stats);
    for (const id of Object.keys(ratings)) ratings[id] = Math.round(ratings[id]);
    stats.history.push({ games: stats.games, ratings });
    if (stats.history.length > 400) stats.history = stats.history.filter((_, i) => i % 2 === 0);
  }
}

/**
 * Bradley–Terry strength ratings fitted to all head-to-head results, on an
 * Elo-like scale (1500 = average, +100 ≈ 64% to outlast an average deck).
 * Unlike running Elo, this doesn't drift with the order of games: it's the
 * single set of ratings that best explains every result so far.
 */
export function computeRatings(stats: Stats): Record<string, number> {
  const ids = Object.keys(stats.decks).filter((id) => stats.decks[id].games > 0);
  const strength: Record<string, number> = {};
  for (const id of ids) strength[id] = 1;

  for (let iter = 0; iter < 200; iter++) {
    let maxChange = 0;
    for (const i of ids) {
      let wins = 0.5; // small prior so undefeated/winless decks stay finite
      let denom = 1 / (strength[i] + 1);
      for (const j of ids) {
        if (i === j) continue;
        const cell = stats.h2h[i]?.[j];
        if (!cell?.meetings) continue;
        wins += cell.ahead;
        denom += cell.meetings / (strength[i] + strength[j]);
      }
      const next = wins / denom;
      maxChange = Math.max(maxChange, Math.abs(next - strength[i]) / strength[i]);
      strength[i] = next;
    }
    if (maxChange < 1e-6) break;
  }

  // Centre on 1500.
  const logMean = ids.reduce((s, id) => s + Math.log10(strength[id]), 0) / Math.max(1, ids.length);
  const out: Record<string, number> = {};
  for (const id of ids) out[id] = 1500 + 400 * (Math.log10(strength[id]) - logMean);
  return out;
}

/** 1 = won, 0 = eliminated first. Ties (shared places) land in between. */
export function finishScore(placement: number, podSize: number): number {
  return podSize > 1 ? (podSize - placement) / (podSize - 1) : 1;
}

/** 95% Wilson score interval for a proportion. */
export function wilson(successes: number, trials: number): [number, number] {
  if (trials === 0) return [0, 0];
  const z = 1.96;
  const p = successes / trials;
  const denom = 1 + (z * z) / trials;
  const centre = (p + (z * z) / (2 * trials)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denom;
  return [Math.max(0, centre - margin), Math.min(1, centre + margin)];
}
