// Saves decks, stats and settings in the browser's localStorage.
// Everything stays on this computer; nothing is uploaded anywhere.

import type { SimDeck } from './engine/types';
import { emptyStats, type Stats } from './sim/stats';

const KEYS = {
  decks: 'proliferate.decks.v1',
  stats: 'proliferate.stats.v1',
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
export const loadStats = () => read<Stats>(KEYS.stats, emptyStats());
export const saveStats = (stats: Stats) => write(KEYS.stats, stats);
export const loadSelected = () => read<string[] | null>(KEYS.selected, null);
export const saveSelected = (ids: string[]) => write(KEYS.selected, ids);

export interface Settings {
  podSize: number;
  workers: number;
  maxRounds: number;
}

export const loadSettings = (): Settings =>
  read<Settings>(KEYS.settings, {
    podSize: 4,
    workers: Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)),
    maxRounds: 25,
  });
export const saveSettings = (s: Settings) => write(KEYS.settings, s);
