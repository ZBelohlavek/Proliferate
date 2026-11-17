import { useState } from 'react';
import type { GameResult, SimDeck } from '../engine/types';
import type { ForgeController } from '../sim/forgeController';
import type { BuiltinController } from '../sim/builtinController';
import { choosePod } from '../sim/pods';
import { deckColor } from './format';

interface ShownGame {
  result: GameResult;
  log: string[];
  /** Deck ids per seat. */
  seats: string[];
  note: string;
}

interface Props {
  allDecks: SimDeck[];
  activeDecks: SimDeck[];
  forge: ForgeController;
  builtin: BuiltinController;
  podSize: number;
  /** True when the built-in engine is the selected simulator. */
  useBuiltin: boolean;
}

/** Shows a game play by play: a fresh one on the built-in engine, or the most recent game Forge finished. */
export function SampleGame({ allDecks, activeDecks, forge, builtin, podSize, useBuiltin }: Props) {
  const [game, setGame] = useState<ShownGame | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOf = (id: string) => allDecks.find((d) => d.id === id)?.name ?? id;

  async function load() {
    setBusy(true);
    setError(null);
    try {
      if (useBuiltin) {
        if (activeDecks.length < 2) throw new Error('select at least two decks');
        const pod = choosePod(activeDecks, (d) => d.id, new Map(), podSize, 'random');
        const started = performance.now();
        const g = await builtin.sample(pod);
        setGame({ result: g.result, log: g.log, seats: g.result.seats, note: `Played on Proliferate's engine in ${Math.round(performance.now() - started)} ms.` });
        setBusy(false);
        return;
      }
      const g = await forge.latestGame();
      setGame({ result: g.result, log: g.summary, seats: g.decks, note: `Forge game #${g.index + 1}, took ${(g.durationMs / 1000).toFixed(0)}s to simulate.` });
    } catch (err) {
      setError(useBuiltin ? `Couldn't play a game: ${(err as Error).message}.` : `No finished games yet — start a run on the Simulate tab first. (${(err as Error).message})`);
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
        <h2>Watch a game</h2>
        <button className="primary" disabled={busy} onClick={load}>{busy ? 'Loading…' : useBuiltin ? (game ? 'Play another game' : 'Play a game') : game ? 'Show the latest game' : 'Show latest Forge game'}</button>
      </div>
      <p className="muted small">
        {useBuiltin
          ? 'A fresh bot-versus-bot game between your selected decks on Proliferate\'s own engine, play by play.'
          : 'The most recent game Forge finished, play by play: every spell, attack and life change under the full rules.'}
      </p>
      {error && <p className="err">{error}</p>}
      {game && (
        <>
          <div className="result-banner">
            {game.result.winner !== null
              ? <>Winner: <strong>{nameOf(game.seats[game.result.winner])}</strong> in round {game.result.rounds}</>
              : <>Draw after {game.result.rounds} rounds</>}
            <span className="muted small"> · {game.note}</span>
          </div>
          <ol className="gamelog">
            {game.log.map((line, i) => {
              const header = line.startsWith('—');
              return (
                <li key={i} className={header ? 'round' : /has lost|has won|is eliminated|wins on/.test(line) ? 'big' : ''} style={{ borderLeftColor: colorFor(line) }}>
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
