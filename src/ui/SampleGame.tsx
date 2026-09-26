import { useState } from 'react';
import type { GameResult, SimDeck } from '../engine/types';
import type { SimController } from '../sim/controller';
import type { ForgeController } from '../sim/forgeController';
import type { Settings } from '../storage';
import { pickPodSize } from '../sim/pods';
import { deckColor } from './format';

interface Props {
  decks: SimDeck[];
  allDecks: SimDeck[];
  quick: SimController;
  forge: ForgeController;
  settings: Settings;
}

interface ShownGame {
  result: GameResult;
  log: string[];
  /** Deck ids per seat. */
  seats: string[];
  note?: string;
}

/**
 * Shows a play-by-play of one game: a fresh quick-engine game, or the most
 * recent game Forge finished (Forge games take too long to play on demand).
 */
export function SampleGame({ decks, allDecks, quick, forge, settings }: Props) {
  const [game, setGame] = useState<ShownGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isForge = settings.engine === 'forge';
  const nameOf = (id: string) => allDecks.find((d) => d.id === id)?.name ?? id;

  async function play() {
    setBusy(true);
    setError(null);
    try {
      if (isForge) {
        const g = await forge.latestGame();
        setGame({ result: g.result, log: g.summary, seats: g.decks, note: `Forge game #${g.index + 1}, took ${(g.durationMs / 1000).toFixed(0)}s to simulate.` });
      } else {
        const pod = [...decks].sort(() => Math.random() - 0.5).slice(0, pickPodSize(settings.podSize, decks.length));
        const { result, log } = await quick.sample(pod, settings.maxRounds);
        setGame({ result, log, seats: pod.map((d) => d.id) });
      }
    } catch (err) {
      setError(isForge ? `No finished Forge games yet. Start an Accurate run on the Simulate tab first. (${(err as Error).message})` : (err as Error).message);
    }
    setBusy(false);
  }

  const colorFor = (line: string) => {
    if (!game) return undefined;
    const m = line.match(/\(P(\d)\)/);
    return m ? deckColor(allDecks, game.seats[+m[1] - 1] ?? '') : undefined;
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Watch a game {isForge ? '— Forge' : '— quick engine'}</h2>
        <button className="primary" disabled={busy || (!isForge && decks.length < 2)} onClick={play}>
          {busy ? 'Loading…' : isForge ? 'Show latest Forge game' : game ? 'Play another' : 'Play a random pod'}
        </button>
      </div>
      <p className="muted small">
        {isForge
          ? 'Shows the most recent game Forge finished: every spell, attack and life change under the full rules.'
          : 'Plays one game between randomly chosen selected decks and shows every decision, so you can see how the simulator is piloting your cards.'}
        {' '}Switch engines on the Simulate tab.
      </p>
      {error && <p className="err">{error}</p>}
      {game && (
        <>
          <div className="result-banner">
            {game.result.winner !== null
              ? <>Winner: <strong>{nameOf(game.seats[game.result.winner])}</strong> in round {game.result.rounds}</>
              : <>Draw after {game.result.rounds} rounds</>}
            {game.note && <span className="muted small"> · {game.note}</span>}
          </div>
          <ol className="gamelog">
            {game.log.map((line, i) => {
              const header = line.startsWith('—');
              return (
                <li key={i} className={header ? 'round' : /eliminated|wins|has lost|has won/.test(line) ? 'big' : ''} style={{ borderLeftColor: colorFor(line) }}>
                  {line}
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}
