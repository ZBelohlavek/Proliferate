// Runs a pool of simulation workers and folds their results into Stats.

import type { GameResult, SimDeck } from '../engine/types';
import type { WorkerRequest, WorkerResponse } from './protocol';
import { addResult, type Stats } from './stats';

export interface RunSettings {
  podSize: number;
  workers: number;
  maxRounds: number;
}

export class SimController {
  private workers: Worker[] = [];
  private listeners = new Set<() => void>();
  private recent: { time: number; games: number }[] = [];
  running = false;
  gamesPerSecond = 0;
  lastError: string | null = null;

  constructor(public stats: Stats) {}

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify() {
    for (const fn of this.listeners) fn();
  }

  private spawn(): Worker {
    return new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  }

  start(decks: SimDeck[], settings: RunSettings) {
    this.stop();
    this.running = true;
    this.lastError = null;
    for (let i = 0; i < settings.workers; i++) {
      const w = this.spawn();
      w.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
      const msg: WorkerRequest = {
        type: 'start',
        decks,
        podSize: settings.podSize,
        maxRounds: settings.maxRounds,
        seed: (Date.now() + i * 7_919_111) >>> 0,
      };
      w.postMessage(msg);
      this.workers.push(w);
    }
    this.notify();
  }

  stop() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.running = false;
    this.gamesPerSecond = 0;
    this.recent = [];
    this.notify();
  }

  private onMessage(msg: WorkerResponse) {
    if (msg.type === 'results') {
      for (const r of msg.results) addResult(this.stats, r);
      const now = performance.now();
      this.recent.push({ time: now, games: msg.results.length });
      this.recent = this.recent.filter((x) => now - x.time < 3000);
      const span = Math.max(500, now - (this.recent[0]?.time ?? now));
      this.gamesPerSecond = (this.recent.reduce((s, x) => s + x.games, 0) / span) * 1000;
      this.notify();
    } else if (msg.type === 'error') {
      this.lastError = msg.message;
      this.notify();
    }
  }

  /** Play one game with full logging in a throwaway worker. */
  sample(decks: SimDeck[], maxRounds: number): Promise<{ result: GameResult; log: string[] }> {
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
