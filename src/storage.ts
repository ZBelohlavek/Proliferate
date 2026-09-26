// Saves decks, stats and settings in the browser's localStorage.
// Everything stays on this computer; nothing is uploaded anywhere.

import type { SimDeck } from './engine/types';
import { emptyStats, type Stats } from './sim/stats';

const KEYS = {
  decks: 'proliferate.decks.v1',
  stats: 'proliferate.stats.v1',
  forgeStats: 'proliferate.stats.forge.v1',
  selected: 'proliferate.selected.v1',
  settings: 'proliferate.settings.v1',
};

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or disabled: the app still works, it just won't remember.
  }
}

export const loadDecks = () => read<SimDeck[]>(KEYS.decks, []);
export const saveDecks = (decks: SimDeck[]) => write(KEYS.decks, decks);
export type Engine = 'quick' | 'forge';

/** Each engine keeps its own results: quick and full-rules games shouldn't be mixed. */
export const loadStats = (engine: Engine) => read<Stats>(engine === 'forge' ? KEYS.forgeStats : KEYS.stats, emptyStats());
export const saveStats = (engine: Engine, stats: Stats) => write(engine === 'forge' ? KEYS.forgeStats : KEYS.stats, stats);
export const loadSelected = () => read<string[] | null>(KEYS.selected, null);
export const saveSelected = (ids: string[]) => write(KEYS.selected, ids);

export interface Settings {
  engine: Engine;
  podSize: number;
  /** Web Workers for the quick engine. */
  workers: number;
  maxRounds: number;
  /** Parallel Forge processes. */
  forgeWorkers: number;
  /** Forge calls a game a draw after this many seconds. */
  forgeClockSeconds: number;
}

const DEFAULT_SETTINGS: Settings = {
  engine: 'quick',
  podSize: 4,
  workers: Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)),
  maxRounds: 25,
  // Forge's AI is multithreaded; beyond ~1 process per 4 threads games just slow each other down.
  forgeWorkers: Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 4) / 4))),
  forgeClockSeconds: 600,
};

// Merge with defaults so settings saved by older versions gain the new fields.
export const loadSettings = (): Settings => ({ ...DEFAULT_SETTINGS, ...read<Partial<Settings>>(KEYS.settings, {}) });
export const saveSettings = (s: Settings) => write(KEYS.settings, s);
