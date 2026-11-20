// Saves decks, stats and settings in the browser's localStorage.
// Everything stays on this computer; nothing is uploaded anywhere.

import type { SimDeck } from './engine/types';
import { emptyStats, type Stats } from './sim/stats';
import { DEFAULT_PLAYERS, sanitizePodSize } from './sim/pods';

const KEYS = {
  decks: 'proliferate.decks.v1',
  // Results are kept per engine: the two play differently, so their numbers don't mix.
  stats: 'proliferate.stats.forge.v1',
  builtinStats: 'proliferate.stats.builtin.v1',
  selected: 'proliferate.selected.v1',
  settings: 'proliferate.settings.v1',
};

function read<T>(key: string, fallback: T): T {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    // Unreadable data would otherwise be overwritten by the next save; keep a copy first.
    try {
      if (raw) localStorage.setItem(`${key}.backup-${Date.now()}`, raw);
    } catch {
      /* storage unavailable */
    }
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
export const loadBuiltinStats = () => read<Stats>(KEYS.builtinStats, emptyStats());
export const saveBuiltinStats = (stats: Stats) => write(KEYS.builtinStats, stats);
export const loadSelected = () => read<string[] | null>(KEYS.selected, null);
export const saveSelected = (ids: string[]) => write(KEYS.selected, ids);

/** Forge AI personalities: Forge's own four, "You" (learned in the Playstyle quiz), or a random mix per seat. */
export type AiProfileChoice = 'Default' | 'Cautious' | 'Reckless' | 'Experimental' | 'You' | 'Mixed';

export interface Settings {
  /**
   * Which simulator plays the games: Forge (full rules, on your computer) or
   * Proliferate's built-in engine (in the browser, approximate card text).
   */
  engine: 'forge' | 'builtin';
  /**
   * Set once the built-in engine became the default (2026-11). Settings saved
   * before then picked Forge without anyone choosing it, so they move over once.
   */
  engineDefaultV2: boolean;
  /** Parallel workers for the built-in engine. */
  builtinWorkers: number;
  podSize: number;
  /** Parallel Forge processes. */
  forgeWorkers: number;
  /** Forge calls a game a draw after this many seconds of real time. */
  forgeClockSeconds: number;
  /** Games each Forge process plays before restarting (saves Forge's ~8 s start-up). */
  gamesPerLaunch: number;
  /** Which AI personality pilots the decks. */
  aiProfile: AiProfileChoice;
  /** Linked Archidekt account, for "Find my decks". */
  archidektUsername: string;
  /** How decks are drawn for each game (see Pairing in sim/pods.ts). */
  pairing: 'balanced' | 'random';
  /** How long a simulation run lasts (not the per-game time limit). */
  /** 'settled': until every deck's win rate is known to ±5 points (built-in engine only). */
  runMode: 'untilStopped' | 'time' | 'games' | 'settled';
  runMinutes: number;
  runGames: number;
}

const DEFAULT_SETTINGS: Settings = {
  engine: 'builtin',
  engineDefaultV2: true,
  builtinWorkers: Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1)),
  podSize: DEFAULT_PLAYERS,
  // Forge's AI is multithreaded; beyond ~1 process per 4 threads games just slow each other down.
  forgeWorkers: Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 4) / 4))),
  forgeClockSeconds: 600,
  gamesPerLaunch: 2,
  aiProfile: 'Default',
  archidektUsername: '',
  pairing: 'balanced',
  runMode: 'untilStopped',
  runMinutes: 60,
  runGames: 500,
};

const PROFILES: AiProfileChoice[] = ['Default', 'Cautious', 'Reckless', 'Experimental', 'You', 'Mixed'];

// Merge with defaults so settings saved by older versions gain the new fields
// (and drop ones that no longer exist, like the quick engine's).
export const loadSettings = (): Settings => {
  const saved = read<Partial<Settings> & Record<string, unknown>>(KEYS.settings, {});
  const s: Settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (saved[key] !== undefined) (s as unknown as Record<string, unknown>)[key] = saved[key];
  }
  s.podSize = sanitizePodSize(s.podSize);
  if (!PROFILES.includes(s.aiProfile)) s.aiProfile = 'Default';
  if (s.engine !== 'forge') s.engine = 'builtin';
  if (saved.engineDefaultV2 !== true) {
    s.engine = 'builtin';
    s.engineDefaultV2 = true;
  }
  s.builtinWorkers = Math.min(16, Math.max(1, Math.floor(Number(s.builtinWorkers)) || 1));
  s.gamesPerLaunch = Math.min(5, Math.max(1, Math.floor(Number(s.gamesPerLaunch)) || 2));
  return s;
};
export const saveSettings = (s: Settings) => write(KEYS.settings, s);
