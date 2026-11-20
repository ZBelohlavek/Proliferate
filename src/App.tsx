import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SimDeck } from './engine/types';
import { ForgeController } from './sim/forgeController';
import { BUILTIN_MAX_ROUNDS, BuiltinController } from './sim/builtinController';
import { SETTLE_MARGIN } from './sim/limit';
import { emptyStats } from './sim/stats';
import {
  loadBuiltinStats, loadDecks, loadSelected, loadSettings, loadStats,
  saveBuiltinStats, saveDecks, saveSelected, saveSettings, saveStats, type Settings,
} from './storage';
import { ImportPanel } from './ui/ImportPanel';
import { DeckList } from './ui/DeckList';
import { SimPanel } from './ui/SimPanel';
import { SampleGame } from './ui/SampleGame';
import { ComparePanel } from './ui/ComparePanel';
import { DeckReport } from './ui/DeckReport';
import { PlaystylePanel } from './ui/PlaystylePanel';
import { PlayPanel } from './ui/PlayPanel';
import { useForgeCheck } from './ui/useForgeCheck';
import { loadProfileAnswers, profileOverrides, saveProfileAnswers, type ProfileAnswer } from './ai/forgeProfile';

type Tab = 'decks' | 'play' | 'simulate' | 'compare' | 'report' | 'playstyle' | 'watch';

export default function App() {
  const [tab, setTab] = useState<Tab>('decks');
  const [decks, setDecks] = useState<SimDeck[]>(loadDecks);
  const [selected, setSelected] = useState<string[]>(() => loadSelected() ?? loadDecks().map((d) => d.id));
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [reportDeck, setReportDeck] = useState<string | null>(null);
  const [answers, setAnswers] = useState<ProfileAnswer[]>(loadProfileAnswers);
  useEffect(() => saveProfileAnswers(answers), [answers]);
  const openReport = (id: string) => {
    setReportDeck(id);
    setTab('report');
  };

  // The Forge controller lives for the whole session; React re-renders when it updates.
  const forgeRef = useRef<ForgeController | null>(null);
  if (!forgeRef.current) forgeRef.current = new ForgeController(loadStats(), saveStats);
  const forge = forgeRef.current;
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => throttledSubscribe(forge, rerender), [forge]);
  useEffect(() => {
    forge.startPolling();
    return () => forge.stopPolling();
  }, [forge]);

  // Proliferate's own engine runs in this page's Web Workers.
  const builtinRef = useRef<BuiltinController | null>(null);
  if (!builtinRef.current) builtinRef.current = new BuiltinController(loadBuiltinStats(), saveBuiltinStats);
  const builtin = builtinRef.current;
  useEffect(() => throttledSubscribe(builtin, rerender), [builtin]);
  useEffect(() => () => builtin.stop(), [builtin]);
  const useBuiltin = settings.engine === 'builtin';
  /** Results of whichever engine is selected; the two are never mixed. */
  const stats = useBuiltin ? builtin.stats : forge.stats;

  useEffect(() => saveDecks(decks), [decks]);
  useEffect(() => saveSelected(selected), [selected]);
  useEffect(() => saveSettings(settings), [settings]);

  const activeDecks = useMemo(() => decks.filter((d) => selected.includes(d.id)), [decks, selected]);

  const addDeck = (deck: SimDeck) => {
    setDecks((ds) => [...ds.filter((d) => d.id !== deck.id), deck]);
    setSelected((s) => (s.includes(deck.id) ? s : [...s, deck.id]));
  };
  const removeDeck = (id: string) => {
    setDecks((ds) => ds.filter((d) => d.id !== id));
    setSelected((s) => s.filter((x) => x !== id));
  };
  const toggleDeck = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  /** Select or unselect many decks at once. */
  const setDecksSelected = (ids: string[], on: boolean) =>
    setSelected((s) => (on ? [...new Set([...s, ...ids])] : s.filter((x) => !ids.includes(x))));

  const startSim = () => {
    if (useBuiltin) {
      builtin.start(activeDecks, {
        podSize: settings.podSize,
        pairing: settings.pairing,
        workers: settings.builtinWorkers,
        maxRounds: BUILTIN_MAX_ROUNDS,
        limit: {
          stopAt: settings.runMode === 'time' ? Date.now() + settings.runMinutes * 60_000 : null,
          maxGames: settings.runMode === 'games' ? settings.runGames : null,
          settle: settings.runMode === 'settled' ? SETTLE_MARGIN : null,
        },
      });
      return;
    }
    void forge.start(activeDecks, {
      // Players per game: 2–6, or 0 for mixed sizes (capped at 6 and at the number of decks).
      podSize: settings.podSize,
      pairing: settings.pairing,
      workers: settings.forgeWorkers,
      clockSeconds: settings.forgeClockSeconds,
      gamesPerLaunch: settings.gamesPerLaunch,
      aiProfile: settings.aiProfile,
      // The "You" personality is written from your Playstyle answers when the run starts.
      profileOverrides: settings.aiProfile === 'You' ? profileOverrides(answers) : null,
      // How long this run lasts — separate from Forge's per-game time limit.
      stopAt: settings.runMode === 'time' ? Date.now() + settings.runMinutes * 60_000 : null,
      maxGames: settings.runMode === 'games' ? settings.runGames : null,
    });
  };
  const stopSim = () => {
    if (useBuiltin) builtin.stop();
    else void forge.stop();
  };
  const resetStats = () => {
    if (useBuiltin) {
      builtin.stop();
      builtin.stats = emptyStats();
      saveBuiltinStats(builtin.stats);
      rerender();
      return;
    }
    void forge.stop();
    forge.stats = emptyStats();
    forge.resetCursor();
    saveStats(forge.stats);
    rerender();
  };

  // Stop simulating if the deck selection really changes underneath a running
  // sim. Compare with the previous selection rather than trusting the effect
  // to run only on changes: React re-runs effects on hot reload and in dev
  // mode, and that must never stop a run in progress.
  const previousSelection = useRef(selected.join('|'));
  useEffect(() => {
    const key = selected.join('|');
    if (key === previousSelection.current) return;
    previousSelection.current = key;
    if (forge.running) void forge.stop();
    if (builtin.running) builtin.stop();
  }, [selected, forge, builtin]);

  // Which cards Forge doesn't know or plays poorly, per deck (null when Forge isn't available).
  const forgeCheck = useForgeCheck(decks, !!forge.status?.available);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⟳</span>
          <div>
            <h1>Proliferate</h1>
            <p>Play and simulate Commander decks</p>
          </div>
        </div>
        <nav className="tabs">
          <button className={tab === 'decks' ? 'active' : ''} onClick={() => setTab('decks')}>
            Decks <span className="badge">{decks.length}</span>
          </button>
          <button className={tab === 'play' ? 'active' : ''} onClick={() => setTab('play')}>
            Play
          </button>
          <button className={tab === 'simulate' ? 'active' : ''} onClick={() => setTab('simulate')}>
            Simulate {(forge.running || builtin.running) && <span className="live-dot" />}
          </button>
          <button className={tab === 'compare' ? 'active' : ''} onClick={() => setTab('compare')}>
            Compare
          </button>
          <button className={tab === 'report' ? 'active' : ''} onClick={() => setTab('report')}>
            Deck report
          </button>
          <button className={tab === 'playstyle' ? 'active' : ''} onClick={() => setTab('playstyle')}>
            Playstyle
          </button>
          <button className={tab === 'watch' ? 'active' : ''} onClick={() => setTab('watch')}>
            Watch a game
          </button>
        </nav>
      </header>

      <main>
        {tab === 'decks' && (
          <>
            <ImportPanel
              decks={decks}
              archidektUsername={settings.archidektUsername}
              onArchidektUsername={(name) => setSettings((s) => ({ ...s, archidektUsername: name }))}
              onImported={addDeck}
            />
            <DeckList
              decks={decks}
              selected={selected}
              forgeCheck={forgeCheck}
              onToggle={toggleDeck}
              onSetSelected={setDecksSelected}
              onRemove={removeDeck}
              onReport={openReport}
            />
            {decks.length >= 2 && (
              <div className="cta">
                <button className="primary" onClick={() => setTab('simulate')}>
                  Simulate {activeDecks.length} selected decks →
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'play' && <PlayPanel decks={decks} />}
        {tab === 'simulate' && (
          <SimPanel
            decks={decks}
            activeDecks={activeDecks}
            forge={forge}
            builtin={builtin}
            forgeCheck={forgeCheck}
            profileAnswers={answers.length}
            onUnselect={(ids) => setDecksSelected(ids, false)}
            settings={settings}
            onSettings={setSettings}
            onStart={startSim}
            onStop={stopSim}
            onReset={resetStats}
            onOpenPlaystyle={() => setTab('playstyle')}
          />
        )}
        {tab === 'compare' && <ComparePanel decks={decks} selected={selected} stats={stats} onOpenReport={openReport} />}
        {tab === 'report' && <DeckReport decks={decks} deckId={reportDeck} onDeck={setReportDeck} stats={stats} />}
        {tab === 'playstyle' && (
          <PlaystylePanel
            decks={decks}
            selected={selected}
            answers={answers}
            onAnswer={(a) => setAnswers((xs) => [...xs, a])}
            onResetAnswers={() => setAnswers([])}
            usingProfile={settings.aiProfile === 'You'}
            onUseProfile={(on) => setSettings((s) => ({ ...s, aiProfile: on ? 'You' : 'Default' }))}
          />
        )}
        {tab === 'watch' && <SampleGame allDecks={decks} activeDecks={activeDecks} forge={forge} builtin={builtin} podSize={settings.podSize} useBuiltin={useBuiltin} />}
      </main>

      <footer>
        Games are played by Proliferate&apos;s own engine or by <a href="https://github.com/Card-Forge/forge">Forge</a>, the open-source Magic rules engine. Card data from{' '}
        <a href="https://archidekt.com">Archidekt</a> and <a href="https://scryfall.com">Scryfall</a>. Proliferate is unofficial Fan Content permitted
        under the Wizards of the Coast Fan Content Policy. Decks and results are stored only in this browser.
      </footer>
    </div>
  );
}

/** Re-render at most ~4 times a second while results stream in. */
function throttledSubscribe(controller: { subscribe: (fn: () => void) => () => void }, fn: () => void): () => void {
  let pending = false;
  return controller.subscribe(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      fn();
    }, 250);
  });
}
