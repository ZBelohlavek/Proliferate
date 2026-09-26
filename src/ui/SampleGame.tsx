import { useState } from 'react';
import type { GameResult, SimDeck } from '../engine/types';
import type { SimController } from '../sim/controller';
import type { Settings } from '../storage';
import { deckColor } from './format';

interface Props {
  decks: SimDeck[];
  allDecks: SimDeck[];
  controller: SimController;
  settings: Settings;
}

/** Plays a single game with a full play-by-play log, to sanity-check the AI. */
export function SampleGame({ decks, allDecks, controller, settings }: Props) {
  const [game, setGame] = useState<{ result: GameResult; log: string[]; pod: SimDeck[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function play() {
    const pod = [...decks].sort(() => Math.random() - 0.5).slice(0, Math.min(settings.podSize, decks.length));
    setBusy(true);
    setError(null);
    try {
      const { result, log } = await controller.sample(pod, settings.maxRounds);
      setGame({ result, log, pod });
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  const colorFor = (line: string) => {
    if (!game) return undefined;
    const m = line.match(/\(P(\d)\)/);
    return m ? deckColor(allDecks, game.pod[+m[1] - 1]?.id ?? '') : undefined;
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Watch a game</h2>
        <button className="primary" disabled={busy || decks.length < 2} onClick={play}>
          {busy ? 'Playing…' : game ? 'Play another' : 'Play a random pod'}
        </button>
      </div>
      <p className="muted small">
        Plays one game between randomly chosen selected decks and shows every decision, so you can see how the simulator is piloting your cards.
      </p>
      {error && <p className="err">{error}</p>}
      {game && (
        <>
          <div className="result-banner">
            {game.result.winner !== null
              ? <>Winner: <strong>{game.pod[game.result.winner].name}</strong> on round {game.result.rounds}</>
              : <>Draw — turn limit reached after {game.result.rounds} rounds</>}
          </div>
          <ol className="gamelog">
            {game.log.map((line, i) => {
              const header = line.startsWith('—');
              return (
                <li key={i} className={header ? 'round' : /eliminated|wins/.test(line) ? 'big' : ''} style={{ borderLeftColor: colorFor(line) }}>
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
