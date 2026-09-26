import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { SimDeck } from './engine/types';
import { SimController } from './sim/controller';
import { emptyStats } from './sim/stats';
import {
  loadDecks, loadSelected, loadSettings, loadStats,
  saveDecks, saveSelected, saveSettings, saveStats, type Settings,
} from './storage';
import { ImportPanel } from './ui/ImportPanel';
import { DeckList } from './ui/DeckList';
import { SimPanel } from './ui/SimPanel';
import { SampleGame } from './ui/SampleGame';

type Tab = 'decks' | 'simulate' | 'watch';

export default function App() {
  const [tab, setTab] = useState<Tab>('decks');
  const [decks, setDecks] = useState<SimDeck[]>(loadDecks);
  const [selected, setSelected] = useState<string[]>(() => loadSelected() ?? loadDecks().map((d) => d.id));
  const [settings, setSettings] = useState<Settings>(loadSettings);

  // The controller lives for the whole session; React re-renders on its updates.
  const controllerRef = useRef<SimController | null>(null);
  if (!controllerRef.current) controllerRef.current = new SimController(loadStats());
  const controller = controllerRef.current;
  useSyncExternalStore(
    (fn) => throttledSubscribe(controller, fn),
    () => controller.stats.games + (controller.running ? 0.5 : 0) + (controller.lastError ? 0.25 : 0),
  );

  useEffect(() => saveDecks(decks), [decks]);
  useEffect(() => saveSelected(selected), [selected]);
  useEffect(() => saveSettings(settings), [settings]);
  useEffect(() => {
    const id = setInterval(() => saveStats(controller.stats), 5000);
    const flush = () => saveStats(controller.stats);
    window.addEventListener('beforeunload', flush);
    return () => {
      clearInterval(id);
      window.removeEventListener('beforeunload', flush);
    };
  }, [controller]);

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

  const startSim = () => controller.start(activeDecks, { ...settings, podSize: Math.min(settings.podSize, activeDecks.length) });
  const resetStats = () => {
    controller.stop();
    controller.stats = emptyStats();
    saveStats(controller.stats);
  };

  // Stop simulating if the deck selection changes underneath a running sim.
  useEffect(() => {
    if (controller.running) controller.stop();
  }, [selected, controller]);

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
            Simulate {controller.running && <span className="live-dot" />}
          </button>
          <button className={tab === 'watch' ? 'active' : ''} onClick={() => setTab('watch')}>
            Watch a game
          </button>
        </nav>
      </header>

      <main>
        {tab === 'decks' && (
          <>
            <ImportPanel onImported={addDeck} />
            <DeckList decks={decks} selected={selected} onToggle={toggleDeck} onRemove={removeDeck} />
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
            controller={controller}
            settings={settings}
            onSettings={setSettings}
            onStart={startSim}
            onStop={() => controller.stop()}
            onReset={resetStats}
          />
        )}
        {tab === 'watch' && <SampleGame decks={activeDecks} allDecks={decks} controller={controller} settings={settings} />}
      </main>

      <footer>
        Card data from <a href="https://archidekt.com">Archidekt</a> and <a href="https://scryfall.com">Scryfall</a>. Proliferate is
        unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. Decks and results are stored only in this browser.
      </footer>
    </div>
  );
}

/** Re-render at most ~4 times a second while the simulation streams results. */
function throttledSubscribe(controller: SimController, fn: () => void): () => void {
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
