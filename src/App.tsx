import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { SimDeck } from './engine/types';
import { SimController } from './sim/controller';
import { ForgeController } from './sim/forgeController';
import { emptyStats } from './sim/stats';
import {
  loadDecks, loadSelected, loadSettings, loadStats,
  saveDecks, saveSelected, saveSettings, saveStats, type Settings,
} from './storage';
import { ImportPanel } from './ui/ImportPanel';
import { DeckList } from './ui/DeckList';
import { SimPanel } from './ui/SimPanel';
import { SampleGame } from './ui/SampleGame';
import { ComparePanel } from './ui/ComparePanel';
import { DeckReport } from './ui/DeckReport';
import { PlaystylePanel } from './ui/PlaystylePanel';
import { fitWeights, loadAnswers, saveAnswers, type Answer } from './ai/playstyle';

type Tab = 'decks' | 'simulate' | 'compare' | 'report' | 'playstyle' | 'watch';

export default function App() {
  const [tab, setTab] = useState<Tab>('decks');
  const [decks, setDecks] = useState<SimDeck[]>(loadDecks);
  const [selected, setSelected] = useState<string[]>(() => loadSelected() ?? loadDecks().map((d) => d.id));
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [reportDeck, setReportDeck] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Answer[]>(loadAnswers);
  useEffect(() => saveAnswers(answers), [answers]);
  // Learned weights, or null for the default AI.
  const playstyle = useMemo(() => (settings.usePlaystyle && answers.length ? fitWeights(answers) : null), [settings.usePlaystyle, answers]);
  const openReport = (id: string) => {
    setReportDeck(id);
    setTab('report');
  };

  // Both controllers live for the whole session: the built-in engine (Web
  // Workers) and Forge (local backend). React re-renders when either updates.
  const quickRef = useRef<SimController | null>(null);
  const forgeRef = useRef<ForgeController | null>(null);
  if (!quickRef.current) quickRef.current = new SimController(loadStats('quick'));
  if (!forgeRef.current) forgeRef.current = new ForgeController(loadStats('forge'), (stats) => saveStats('forge', stats));
  const quick = quickRef.current;
  const forge = forgeRef.current;
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const unsubscribers = [throttledSubscribe(quick, rerender), throttledSubscribe(forge, rerender)];
    return () => unsubscribers.forEach((u) => u());
  }, [quick, forge]);
  useEffect(() => {
    forge.startPolling();
    return () => forge.stopPolling();
  }, [forge]);

  useEffect(() => saveDecks(decks), [decks]);
  useEffect(() => saveSelected(selected), [selected]);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => {
    const id = setInterval(() => saveStats('quick', quick.stats), 5000);
    const flush = () => saveStats('quick', quick.stats);
    window.addEventListener('beforeunload', flush);
    return () => {
      clearInterval(id);
      window.removeEventListener('beforeunload', flush);
    };
  }, [quick]);

  const activeDecks = useMemo(() => decks.filter((d) => selected.includes(d.id)), [decks, selected]);
  const engine = settings.engine;
  // Players per game: 2–6, or 0 for mixed sizes. The workers cap it at 6 and at the number of decks.
  const podSize = settings.podSize;

  const addDeck = (deck: SimDeck) => {
    setDecks((ds) => [...ds.filter((d) => d.id !== deck.id), deck]);
    setSelected((s) => (s.includes(deck.id) ? s : [...s, deck.id]));
  };
  const removeDeck = (id: string) => {
    setDecks((ds) => ds.filter((d) => d.id !== id));
    setSelected((s) => s.filter((x) => x !== id));
  };
  const toggleDeck = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const startSim = () => {
    if (engine === 'forge') {
      void forge.start(activeDecks, { podSize, pairing: settings.pairing, workers: settings.forgeWorkers, clockSeconds: settings.forgeClockSeconds });
    } else {
      quick.start(activeDecks, { podSize, pairing: settings.pairing, workers: settings.workers, maxRounds: settings.maxRounds, playstyle });
    }
  };
  const stopSim = () => (engine === 'forge' ? void forge.stop() : quick.stop());
  const resetStats = () => {
    if (engine === 'forge') {
      void forge.stop();
      forge.stats = emptyStats();
      forge.resetCursor();
      saveStats('forge', forge.stats);
    } else {
      quick.stop();
      quick.stats = emptyStats();
      saveStats('quick', quick.stats);
    }
    rerender();
  };

  // Stop simulating if the deck selection changes underneath a running sim
  // (but not on first load, when a Forge run may already be in progress).
  const firstSelection = useRef(true);
  useEffect(() => {
    if (firstSelection.current) {
      firstSelection.current = false;
      return;
    }
    if (quick.running) quick.stop();
    if (forge.running) void forge.stop();
  }, [selected, quick, forge]);

  const anyRunning = quick.running || forge.running;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo">⟳</span>
          <div>
            <h1>Proliferate</h1>
            <p>EDH deck simulator</p>
          </div>
        </div>
        <nav className="tabs">
          <button className={tab === 'decks' ? 'active' : ''} onClick={() => setTab('decks')}>
            Decks <span className="badge">{decks.length}</span>
          </button>
          <button className={tab === 'simulate' ? 'active' : ''} onClick={() => setTab('simulate')}>
            Simulate {anyRunning && <span className="live-dot" />}
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
            <DeckList decks={decks} selected={selected} onToggle={toggleDeck} onRemove={removeDeck} onReport={openReport} />
            {decks.length >= 2 && (
              <div className="cta">
                <button className="primary" onClick={() => setTab('simulate')}>
                  Simulate {activeDecks.length} selected decks →
                </button>
              </div>
            )}
          </>
        )}
        {tab === 'simulate' && (
          <SimPanel
            decks={decks}
            activeDecks={activeDecks}
            quick={quick}
            forge={forge}
            settings={settings}
            onSettings={setSettings}
            onStart={startSim}
            onStop={stopSim}
            onReset={resetStats}
          />
        )}
        {tab === 'compare' && (
          <ComparePanel decks={decks} selected={selected} quickStats={quick.stats} forgeStats={forge.stats} onOpenReport={openReport} />
        )}
        {tab === 'report' && (
          <DeckReport decks={decks} deckId={reportDeck} onDeck={setReportDeck} quickStats={quick.stats} forgeStats={forge.stats} />
        )}
        {tab === 'playstyle' && (
          <PlaystylePanel
            decks={decks}
            selected={selected}
            answers={answers}
            onAnswer={(a) => setAnswers((xs) => [...xs, a])}
            onResetAnswers={() => setAnswers([])}
            usePlaystyle={settings.usePlaystyle}
            onUsePlaystyle={(on) => setSettings((s) => ({ ...s, usePlaystyle: on }))}
          />
        )}
        {tab === 'watch' && <SampleGame decks={activeDecks} allDecks={decks} quick={quick} forge={forge} settings={settings} playstyle={playstyle} />}
      </main>

      <footer>
        Card data from <a href="https://archidekt.com">Archidekt</a> and <a href="https://scryfall.com">Scryfall</a>. Proliferate is
        unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Decks and results are stored only in this browser.
      </footer>
    </div>
  );
}

/** Re-render at most ~4 times a second while the simulation streams results. */
function throttledSubscribe(controller: { subscribe: (fn: () => void) => () => void }, fn: () => void): () => void {
  let pending = false;
  const unsubscribe = controller.subscribe(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => {
      pending = false;
      fn();
    }, 250);
  });
  return unsubscribe;
}
