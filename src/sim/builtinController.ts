// Runs simulations on Proliferate's own rules engine, in the browser: a pool
// of Web Workers plays bot-versus-bot games and their results are folded
// into Stats. Unlike Forge this needs no install and works on static hosting.

import type { GameResult, SimDeck } from '../engine/types';
import type { WorkerRequest, WorkerResponse } from './builtinWorker';
import { limitReached, NO_LIMIT, type RunLimit } from './limit';
import type { Pairing } from './pods';
import { addResult, type Stats } from './stats';

export interface BuiltinSettings {
  podSize: number;
  pairing: Pairing;
  workers: number;
  /** Rounds after which a game is called a draw. */
  maxRounds: number;
  /** When to stop this run (time or number of games); NO_LIMIT = until stopped. */
  limit: RunLimit;
}

export const BUILTIN_MAX_ROUNDS = 40;

export class BuiltinController {
  private workers: Worker[] = [];
  private listeners = new Set<() => void>();
  private recent: { time: number; games: number }[] = [];
  running = false;
  gamesPerSecond = 0;
  lastError: string | null = null;
  /** The current (or last) run's limit and progress. */
  limit: RunLimit = NO_LIMIT;
  gamesThisRun = 0;
  /** True when the last run ended because it hit its time or game limit. */
  finishedByLimit = false;
  private limitTimer: ReturnType<typeof setInterval> | null = null;
  private lastSave = 0;

  constructor(public stats: Stats, private onStats: (s: Stats) => void) {}

  get activeWorkers(): number {
    return this.workers.length;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  private spawn(): Worker {
    return new Worker(new URL('./builtinWorker.ts', import.meta.url), { type: 'module' });
  }

  start(decks: SimDeck[], settings: BuiltinSettings) {
    this.stop();
    this.running = true;
    this.lastError = null;
    this.limit = settings.limit;
    this.gamesThisRun = 0;
    this.finishedByLimit = false;
    // Time limits are also checked on a timer, in case results are slow to arrive.
    if (settings.limit.stopAt !== null) this.limitTimer = setInterval(() => this.checkLimit(), 1000);
    for (let i = 0; i < settings.workers; i++) {
      const w = this.spawn();
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
      w.onerror = (e) => {
        this.lastError = e.message;
        this.notify();
      };
      const msg: WorkerRequest = {
        type: 'start', decks, podSize: settings.podSize, maxRounds: settings.maxRounds,
        seed: (Date.now() + i * 7_919_111) >>> 0, pairing: settings.pairing,
      };
      w.postMessage(msg);
      this.workers.push(w);
    }
    this.notify();
  }

  private checkLimit() {
    if (this.running && limitReached(this.limit, this.gamesThisRun)) {
      this.stop();
      this.finishedByLimit = true;
      this.notify();
    }
  }

  stop() {
    if (this.limitTimer) clearInterval(this.limitTimer);
    this.limitTimer = null;
    for (const w of this.workers) w.terminate();
    this.workers = [];
    if (this.running) this.onStats(this.stats);
    this.running = false;
    this.gamesPerSecond = 0;
    this.recent = [];
    this.notify();
  }

  private onMessage(msg: WorkerResponse) {
    if (msg.type === 'results') {
      if (!this.running) return;
      // With a game limit, count exactly up to it and no further.
      const room = this.limit.maxGames === null ? msg.results.length : Math.max(0, this.limit.maxGames - this.gamesThisRun);
      const results = msg.results.slice(0, room);
      for (const r of results) addResult(this.stats, r);
      this.gamesThisRun += results.length;
      const now = performance.now();
      this.recent.push({ time: now, games: msg.results.length });
      this.recent = this.recent.filter((x) => now - x.time < 3000);
      const span = Math.max(500, now - (this.recent[0]?.time ?? now));
      this.gamesPerSecond = (this.recent.reduce((s, x) => s + x.games, 0) / span) * 1000;
      // Saving is slow for big stats, so do it every couple of seconds rather than per batch.
      if (now - this.lastSave > 2000) {
        this.lastSave = now;
        this.onStats(this.stats);
      }
      this.notify();
      this.checkLimit();
    } else if (msg.type === 'error') {
      this.lastError = msg.message;
      this.notify();
    }
  }

  /** Play one game with a full log in a throwaway worker. */
  sample(decks: SimDeck[], maxRounds = BUILTIN_MAX_ROUNDS): Promise<{ result: GameResult; log: string[] }> {
    return new Promise((resolve, reject) => {
      const w = this.spawn();
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => {
        if (ev.data.type === 'sample') resolve({ result: ev.data.result, log: ev.data.log });
        else if (ev.data.type === 'error') reject(new Error(ev.data.message));
        w.terminate();
      };
      w.onerror = (e) => {
        reject(new Error(e.message));
        w.terminate();
      };
      const msg: WorkerRequest = { type: 'sample', decks, seed: (Math.random() * 2 ** 32) >>> 0, maxRounds };
      w.postMessage(msg);
    });
  }
}
