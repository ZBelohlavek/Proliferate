// Runs Forge (https://github.com/Card-Forge/forge) in simulation mode to play
// full-rules Commander games, several processes at a time.
//
// Each game is one `java -jar forge.jar sim -d a.dck b.dck ... -f commander`
// process. Its log is parsed into a GameResult that the page polls for.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { GameResult } from '../src/engine/types.ts';
import { ForgeCardDb } from './forgeCards.ts';
import { parseForgeGames } from './forgeLog.ts';
import { choosePod, type Pairing } from '../src/sim/pods.ts';

export interface ForgeDeckInput {
  id: string;
  name: string;
  commanders: string[];
  cards: { name: string; count: number }[];
}

export interface ForgeStartOptions {
  decks: ForgeDeckInput[];
  podSize: number;
  workers: number;
  /** Forge's per-game clock; a game still running after this is a draw. */
  clockSeconds: number;
  heapMb: number;
  pairing: Pairing;
  /** Stop launching games after this time (ms since epoch), or null. */
  stopAt: number | null;
  /** Stop after this many games in this run, or null. */
  maxGames: number | null;
  /** Games each Forge process plays before restarting (saves Forge's start-up time). */
  gamesPerLaunch: number;
  /** Default, Cautious, Reckless, Experimental, You (learned profile) or Mixed (random per seat). */
  aiProfile: string;
  /** Settings for the "You" profile, written on top of Forge's Default profile. */
  profileOverrides: Record<string, string> | null;
}

/** Forge's built-in AI profiles (files in forge/res/ai). */
const BUILT_IN_PROFILES = ['Default', 'Cautious', 'Reckless', 'Experimental'];
/** File name (without .ai) of the profile learned in the Playstyle quiz. */
export const YOU_PROFILE = 'ProliferateYou';

interface PreparedDeck {
  input: ForgeDeckInput;
  file: string;
  forgeName: string;
}

interface StoredGame {
  result: GameResult;
  summary: string[];
  decks: string[];
  durationMs: number;
}

export class ForgeRunner {
  readonly forgeDir: string | null;
  readonly jar: string | null;
  readonly decksDir: string | null;
  readonly problem: string | null;
  readonly java: string;
  readonly session = Math.random().toString(36).slice(2);

  private db: ForgeCardDb | null = null;
  private running = false;
  private settings: ForgeStartOptions | null = null;
  private prepared: PreparedDeck[] = [];
  private played = new Map<string, number>();
  private procs = new Set<ChildProcess>();
  private games: StoredGame[] = [];
  private errors: string[] = [];
  private finishedAt: number[] = [];
  /** Games launched / finished in the current run, for run limits. */
  private launchedThisRun = 0;
  private finishedThisRun = 0;
  private finishedByLimit = false;

  constructor(projectRoot: string) {
    const candidates = [process.env.FORGE_DIR, join(projectRoot, 'forge'), join(projectRoot, '..', 'forge')].filter(Boolean) as string[];
    let forgeDir: string | null = null;
    let jar: string | null = null;
    for (const dir of candidates) {
      if (!existsSync(dir)) continue;
      const found = readdirSync(dir).find((f) => /^forge-gui-desktop-.*-jar-with-dependencies\.jar$/.test(f));
      if (found) {
        forgeDir = resolve(dir);
        jar = found;
        break;
      }
    }
    this.forgeDir = forgeDir;
    this.jar = jar;
    this.decksDir = forgeDir ? join(this.userDecksDir(forgeDir), 'commander') : null;
    this.java = findJava();
    this.problem = !forgeDir
      ? `Forge not found. Put it in ${join(projectRoot, '..', 'forge')} or set the FORGE_DIR environment variable.`
      : !this.java
        ? 'Java not found. Forge needs Java 17 or newer (https://adoptium.net).'
        : null;
  }

  /** Where this Forge install keeps decks (honours forge.profile.properties). */
  private userDecksDir(forgeDir: string): string {
    const profile = join(forgeDir, 'forge.profile.properties');
    const props: Record<string, string> = {};
    if (existsSync(profile)) {
      for (const line of readFileSync(profile, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z]+)\s*=\s*(.*?)\s*$/);
        if (m && m[2]) props[m[1]] = resolve(forgeDir, m[2]);
      }
    }
    if (props.decksDir) return props.decksDir;
    if (props.userDir) return join(props.userDir, 'decks');
    const appData = process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
    return process.platform === 'win32' ? join(appData, 'Forge', 'decks') : join(homedir(), '.forge', 'decks');
  }

  private cardDb(): ForgeCardDb {
    if (!this.db) this.db = new ForgeCardDb(join(this.forgeDir!, 'res', 'cardsfolder', 'cardsfolder.zip'));
    return this.db;
  }

  status() {
    const now = Date.now();
    this.finishedAt = this.finishedAt.filter((t) => now - t < 10 * 60_000);
    const windowMs = Math.min(10 * 60_000, now - (this.finishedAt[0] ?? now)) || 1;
    return {
      available: !this.problem,
      problem: this.problem,
      forgeDir: this.forgeDir,
      version: this.jar?.match(/desktop-(.*?)-jar/)?.[1] ?? null,
      session: this.session,
      running: this.running,
      activeGames: this.procs.size,
      completed: this.games.length,
      run: this.settings
        ? {
            stopAt: this.settings.stopAt,
            maxGames: this.settings.maxGames,
            games: this.finishedThisRun,
            finishing: !this.running && this.procs.size > 0,
            finishedByLimit: this.finishedByLimit,
          }
        : null,
      gamesPerMinute: this.finishedAt.length > 1 ? (this.finishedAt.length / windowMs) * 60_000 : 0,
      errors: this.errors.slice(-5),
    };
  }

  /** Check which cards Forge doesn't know, per deck. */
  /** Per deck: cards Forge doesn't know, and cards its AI is flagged as playing poorly. */
  check(decks: ForgeDeckInput[]): { deckId: string; missing: string[]; aiWeak: string[] }[] {
    if (this.problem) return [];
    const db = this.cardDb();
    return decks.map((d) => {
      const names = [...d.commanders, ...d.cards.map((c) => c.name)];
      return {
        deckId: d.id,
        missing: names.filter((name) => !db.lookup(name)),
        aiWeak: names.filter((name) => db.lookup(name) && db.isAiWeak(name)),
      };
    });
  }

  /**
   * Write the "You" AI profile: Forge's Default profile with the settings
   * learned in the Playstyle quiz swapped in. Forge reads every *.ai file in
   * res/ai, so the new profile can then be named with -a.
   */
  private writeYouProfile(overrides: Record<string, string>) {
    const dir = join(this.forgeDir!, 'res', 'ai');
    const lines = readFileSync(join(dir, 'Default.ai'), 'utf8').split(/\r?\n/);
    const safe = Object.entries(overrides).filter(([k, v]) => /^[A-Z0-9_]+$/.test(k) && /^[\w.-]+$/.test(v));
    const pending = new Map(safe);
    const out = lines.map((line) => {
      const key = line.match(/^([A-Z0-9_]+)=/)?.[1];
      if (key && pending.has(key)) {
        const value = pending.get(key)!;
        pending.delete(key);
        return `${key}=${value}`;
      }
      return line;
    });
    for (const [k, v] of pending) out.push(`${k}=${v}`);
    out.unshift('# Written by Proliferate from your Playstyle quiz answers (Forge Default + your settings).');
    writeFileSync(join(dir, `${YOU_PROFILE}.ai`), out.join('\n'));
  }

  /** The -a profile name for each seat. */
  private profilesFor(size: number): string[] {
    const choice = this.settings!.aiProfile;
    return Array.from({ length: size }, () => {
      if (choice === 'You') return YOU_PROFILE;
      if (choice === 'Mixed') return BUILT_IN_PROFILES[Math.floor(Math.random() * BUILT_IN_PROFILES.length)];
      return BUILT_IN_PROFILES.includes(choice) ? choice : 'Default';
    });
  }

  start(opts: ForgeStartOptions) {
    if (this.problem) throw new Error(this.problem);
    this.stop();
    const warnings = this.check(opts.decks).filter((w) => w.missing.length);
    this.prepared = opts.decks.map((d) => this.writeDeck(d));
    if (opts.aiProfile === 'You') this.writeYouProfile(opts.profileOverrides ?? {});
    this.settings = opts;
    this.played.clear();
    this.running = true;
    this.launchedThisRun = 0;
    this.finishedThisRun = 0;
    this.finishedByLimit = false;
    for (let i = 0; i < opts.workers; i++) this.launch();
    return { warnings };
  }

  stop() {
    this.running = false;
    for (const p of this.procs) killTree(p);
    this.procs.clear();
  }

  results(since: number) {
    return { session: this.session, total: this.games.length, results: this.games.slice(since).map((g) => g.result) };
  }

  gameLog(index: number) {
    const i = index < 0 ? this.games.length - 1 : index;
    const g = this.games[i];
    return g ? { index: i, result: g.result, decks: g.decks, summary: g.summary, durationMs: g.durationMs } : null;
  }

  private writeDeck(d: ForgeDeckInput): PreparedDeck {
    const db = this.cardDb();
    const forgeName = `P-${d.id.replace(/[^A-Za-z0-9-]/g, '')}`;
    const line = (name: string, count: number) => {
      const known = db.lookup(name);
      return known ? `${count} ${known}` : null;
    };
    const commanders = d.commanders.map((c) => line(c, 1)).filter(Boolean);
    const main = d.cards.map((c) => line(c.name, c.count)).filter(Boolean);
    const text = `[metadata]\nName=${forgeName}\n[Commander]\n${commanders.join('\n')}\n[Main]\n${main.join('\n')}\n`;
    mkdirSync(this.decksDir!, { recursive: true });
    const file = `proliferate_${forgeName}.dck`;
    writeFileSync(join(this.decksDir!, file), text);
    return { input: d, file, forgeName };
  }

  /** A fresh random pod for every game (see choosePod in src/sim/pods.ts). */
  private choosePod(): PreparedDeck[] {
    return choosePod(this.prepared, (d) => d.input.id, this.played, this.settings!.podSize, this.settings!.pairing);
  }

  /** True once the run's time or game budget is used up. */
  private limitReached(): boolean {
    const s = this.settings!;
    if (s.stopAt !== null && Date.now() >= s.stopAt) return true;
    if (s.maxGames !== null && this.launchedThisRun >= s.maxGames) return true;
    return false;
  }

  /** Games the next launch should play: gamesPerLaunch, but never past a game limit. */
  private gamesForNextLaunch(): number {
    const s = this.settings!;
    const n = Math.max(1, s.gamesPerLaunch);
    return s.maxGames === null ? n : Math.max(1, Math.min(n, s.maxGames - this.launchedThisRun));
  }

  private launch() {
    if (!this.running || !this.settings) return;
    if (this.limitReached()) {
      // Out of budget: start nothing new, but let games already running finish and count.
      this.running = false;
      this.finishedByLimit = true;
      return;
    }
    const games = this.gamesForNextLaunch();
    this.launchedThisRun += games;
    const pod = this.choosePod();
    const { clockSeconds, heapMb } = this.settings;
    // -n plays several games with the same pod (Forge rotates the starting player);
    // -c is Forge's per-game clock; -a gives each seat an AI profile.
    const args = [
      `-Xmx${heapMb}m`, '-Dio.netty.tryReflectionSetAccessible=true', '-Dfile.encoding=UTF-8',
      '-jar', this.jar!, 'sim', '-d', ...pod.map((d) => d.file), '-f', 'commander', '-n', String(games), '-c', String(clockSeconds),
      '-a', ...this.profilesFor(pod.length),
    ];
    const started = Date.now();
    const proc = spawn(this.java, args, { cwd: this.forgeDir!, windowsHide: true });
    this.procs.add(proc);

    let out = '';
    proc.stdout.on('data', (chunk) => (out += chunk));
    proc.stderr.on('data', (chunk) => (out += chunk));
    const killTimer = setTimeout(() => killTree(proc), (clockSeconds * games + 120) * 1000);

    proc.on('error', (err) => this.error(`Couldn't start Java: ${err.message}. Is Java 17+ installed?`));
    proc.on('close', () => {
      clearTimeout(killTimer);
      const wasTracked = this.procs.delete(proc);
      if (!wasTracked) return; // stopped by the user
      const lines = out.split(/\r?\n/);
      const parsedGames = parseForgeGames(
        lines,
        pod.map((d) => d.input.id),
        pod.map((d) => d.input.commanders),
        pod.map((d) => d.input.name),
      );
      const parsed = parsedGames.length > 0;
      // Forge names cards by their front face; map back to the deck's own names.
      const byFront = pod.map((d) => {
        const m = new Map<string, string>();
        for (const name of [...d.input.commanders, ...d.input.cards.map((c) => c.name)]) m.set(name.split(' // ')[0], name);
        return m;
      });
      const each = (Date.now() - started) / Math.max(1, parsedGames.length);
      for (const game of parsedGames) {
        game.result.cards?.forEach((seatCards, seat) => {
          seatCards.cast = seatCards.cast.map((n) => byFront[seat].get(n) ?? byFront[seat].get(n.split(' // ')[0]) ?? n);
        });
        this.games.push({ result: game.result, summary: game.summary.slice(0, 4000), decks: pod.map((d) => d.input.id), durationMs: each });
        this.finishedAt.push(Date.now());
        this.finishedThisRun++;
        // Only keep full play-by-play for recent games.
        if (this.games.length > 20) this.games[this.games.length - 21].summary = [];
      }
      if (!parsed) {
        const hint = lines.find((l) => /could not load deck|exception|error/i.test(l)) ?? lines.filter(Boolean).slice(-1)[0] ?? 'no output';
        this.error(`A Forge game produced no result: ${hint.slice(0, 300)}`);
      }
      if (this.running) setTimeout(() => this.launch(), parsed ? 0 : 5000);
    });
  }

  private error(message: string) {
    this.errors.push(`${new Date().toLocaleTimeString()} ${message}`);
    if (this.errors.length > 50) this.errors.shift();
  }
}

/**
 * The real java binary. On Windows the `java` on PATH is often a launcher stub
 * that starts the JDK as a child process, so killing it would orphan the game;
 * asking Java for its own java.home gets the real executable.
 */
function findJava(): string {
  const candidates = [process.env.JAVA_HOME && join(process.env.JAVA_HOME, 'bin', 'java'), 'java'].filter(Boolean) as string[];
  for (const candidate of candidates) {
    // Java prints its settings to stderr.
    const res = spawnSync(candidate, ['-XshowSettings:properties', '-version'], { encoding: 'utf8', windowsHide: true });
    const home = `${res.stdout ?? ''}${res.stderr ?? ''}`.match(/java\.home = (.*)/)?.[1];
    if (home) return join(home.trim(), 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  }
  return '';
}

/** Kill a process and its children (Forge can outlive a plain kill on Windows). */
function killTree(proc: ChildProcess) {
  if (proc.pid && process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true });
  } else {
    proc.kill();
  }
}
