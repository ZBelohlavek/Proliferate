// Drives the Forge backend (server/forgeRunner.ts) from the page: starts and
// stops runs, and polls for finished games to fold into Stats.

import type { GameResult, SimDeck } from '../engine/types';
import { addResult, type Stats } from './stats';

export interface ForgeStatus {
  available: boolean;
  problem: string | null;
  forgeDir: string | null;
  version: string | null;
  session: string;
  running: boolean;
  activeGames: number;
  completed: number;
  gamesPerMinute: number;
  errors: string[];
  /** The current (or last) run's limit and progress. */
  run: { stopAt: number | null; maxGames: number | null; games: number; finishing: boolean; finishedByLimit: boolean } | null;
}

export interface ForgeSettings {
  podSize: number;
  pairing: 'balanced' | 'random';
  stopAt: number | null;
  maxGames: number | null;
  /** Games per Forge process before it restarts. */
  gamesPerLaunch: number;
  /** Forge AI personality: Default, Cautious, Reckless, Experimental, You, or Mixed (random per seat). */
  aiProfile: string;
  /** Settings for the "You" personality, learned in the Playstyle quiz. */
  profileOverrides: Record<string, string> | null;
  workers: number;
  clockSeconds: number;
}

export interface ForgeGameLog {
  index: number;
  result: GameResult;
  decks: string[];
  summary: string[];
  durationMs: number;
}

const CURSOR_KEY = 'proliferate.forgeCursor.v1';

/** Deck in the shape the backend expects: plain card names and counts. */
export function toForgeDeck(deck: SimDeck) {
  return {
    id: deck.id,
    name: deck.name,
    commanders: deck.commanders.map((c) => c.name),
    cards: deck.cards.map((c) => ({ name: c.card.name, count: c.count })),
  };
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/forge/${path}`, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data as T;
}

export class ForgeController {
  status: ForgeStatus | null = null;
  lastError: string | null = null;
  warnings: { deckId: string; missing: string[] }[] = [];
  private listeners = new Set<() => void>();
  private cursor: { session: string; since: number };
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(public stats: Stats, private onStats: (s: Stats) => void) {
    let saved = { session: '', since: 0 };
    try {
      saved = JSON.parse(localStorage.getItem(CURSOR_KEY) ?? '') ?? saved;
    } catch {
      /* first run */
    }
    this.cursor = saved;
  }

  /** Poll the backend every few seconds while the page is open. Safe to call repeatedly. */
  startPolling() {
    if (this.timer) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), 3000);
  }

  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get running(): boolean {
    return !!this.status?.running;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  async start(decks: SimDeck[], settings: ForgeSettings) {
    try {
      const res = await api<{ warnings: { deckId: string; missing: string[] }[] }>('start', { decks: decks.map(toForgeDeck), ...settings });
      this.warnings = res.warnings;
      this.lastError = null;
    } catch (err) {
      this.lastError = (err as Error).message;
    }
    await this.poll();
  }

  async stop() {
    try {
      await api('stop', {});
    } catch (err) {
      this.lastError = (err as Error).message;
    }
    await this.poll();
  }

  /** Forget results already counted (after the user resets stats). */
  resetCursor() {
    if (this.status) this.cursor = { session: this.status.session, since: this.status.completed };
    this.saveCursor();
  }

  latestGame(): Promise<ForgeGameLog> {
    return api<ForgeGameLog>('log?index=-1');
  }

  private saveCursor() {
    try {
      localStorage.setItem(CURSOR_KEY, JSON.stringify(this.cursor));
    } catch {
      /* storage unavailable */
    }
  }

  private async poll() {
    try {
      this.status = await api<ForgeStatus>('status');
    } catch {
      this.status = null; // backend not reachable (e.g. static hosting)
      this.notify();
      return;
    }
    // A new server session means the old results are gone; start from 0.
    if (this.cursor.session !== this.status.session) this.cursor = { session: this.status.session, since: 0 };
    if (this.status.completed > this.cursor.since) {
      const res = await api<{ session: string; total: number; results: GameResult[] }>(`results?since=${this.cursor.since}`);
      for (const r of res.results) addResult(this.stats, r);
      this.cursor.since = res.total;
      this.saveCursor();
      this.onStats(this.stats);
    }
    this.notify();
  }
}
