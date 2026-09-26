import type { SimDeck } from '../engine/types';
import type { SimController } from '../sim/controller';
import { computeRatings, wilson, type DeckStats } from '../sim/stats';
import type { Settings } from '../storage';
import { RatingChart } from './RatingChart';
import { commanderNames, deckColor, pct } from './format';

interface Props {
  decks: SimDeck[];
  activeDecks: SimDeck[];
  controller: SimController;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}

export function SimPanel({ decks, activeDecks, controller, settings, onSettings, onStart, onStop, onReset }: Props) {
  const stats = controller.stats;
  const maxWorkers = Math.max(1, navigator.hardwareConcurrency || 4);
  const canRun = activeDecks.length >= 2;

  const ratings = computeRatings(stats);
  const rows = decks
    .filter((d) => stats.decks[d.id]?.games)
    .map((d) => ({ deck: d, s: stats.decks[d.id], rating: ratings[d.id] ?? 1500 }))
    .sort((a, b) => b.rating - a.rating);

  return (
    <>
      <section className="panel controls">
        <div className="control-row">
          <label>
            Pod size
            <select value={settings.podSize} onChange={(e) => onSettings({ ...settings, podSize: +e.target.value })} disabled={controller.running}>
              {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} players</option>)}
            </select>
          </label>
          <label>
            CPU threads
            <select value={settings.workers} onChange={(e) => onSettings({ ...settings, workers: +e.target.value })} disabled={controller.running}>
              {Array.from({ length: maxWorkers }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>
            Turn limit
            <select value={settings.maxRounds} onChange={(e) => onSettings({ ...settings, maxRounds: +e.target.value })} disabled={controller.running}>
              {[15, 20, 25, 30, 40].map((n) => <option key={n} value={n}>{n} rounds</option>)}
            </select>
          </label>
          <div className="spacer" />
          {controller.running ? (
            <button className="primary stop" onClick={onStop}>Pause</button>
          ) : (
            <button className="primary" disabled={!canRun} onClick={onStart}>{stats.games ? 'Resume' : 'Start simulating'}</button>
          )}
          <button onClick={() => confirm('Clear all simulation results?') && onReset()} disabled={!stats.games}>Reset results</button>
        </div>
        <div className="kpis">
          <div className="kpi"><span>{stats.games.toLocaleString()}</span>games played</div>
          <div className="kpi"><span>{controller.running ? Math.round(controller.gamesPerSecond).toLocaleString() : '—'}</span>games / second</div>
          <div className="kpi"><span>{activeDecks.length}</span>decks in rotation</div>
          <div className="kpi"><span>{rows.length ? (rows.reduce((s, r) => s + r.s.winRoundSum, 0) / Math.max(1, rows.reduce((s, r) => s + r.s.wins, 0))).toFixed(1) : '—'}</span>avg winning round</div>
        </div>
        {!canRun && <p className="warn">Select at least two decks on the Decks tab.</p>}
        {controller.lastError && <p className="err">{controller.lastError}</p>}
        {settings.podSize > activeDecks.length && canRun && (
          <p className="muted small">Only {activeDecks.length} decks selected, so pods will have {activeDecks.length} players.</p>
        )}
      </section>

      {rows.length > 0 && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>Leaderboard</h2>
              <span className="muted small">Each game counts as a match between every pair of decks in the pod, won by whoever outlasted the other. Rating is fitted to all of those matches (Elo scale: +100 ≈ 64% to outlast an average deck).</span>
            </div>
            <div className="table-wrap">
              <table className="leaderboard">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Deck</th>
                    <th title="Strength rating fitted to all head-to-head results (Elo scale)">Rating</th>
                    <th title="Win rate with 95% confidence interval">Win rate</th>
                    <th title="Win rate relative to a fair share (1 / pod size)">vs. fair</th>
                    <th title="Average finishing position (1 = won)">Avg place</th>
                    <th title="Average round in which this deck won">Win round</th>
                    <th title="How this deck eliminated opponents">Kills by</th>
                    <th title="Average round the commander was first cast">Cmdr out</th>
                    <th>Games</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ deck, s, rating }, i) => (
                    <LeaderRow key={deck.id} rank={i + 1} deck={deck} s={s} rating={rating} color={deckColor(decks, deck.id)} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Head to head</h2>
              <span className="muted small">How often the row deck outlasted the column deck when they shared a pod.</span>
            </div>
            <HeadToHeadGrid decks={rows.map((r) => r.deck)} allDecks={decks} h2h={stats.h2h} />
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Rating over time</h2>
              <span className="muted small">Lines flatten out as the ratings converge — once they stop moving, more games won't change the ranking.</span>
            </div>
            <RatingChart history={stats.history} decks={rows.map((r) => r.deck)} allDecks={decks} />
          </section>
        </>
      )}
    </>
  );
}

function LeaderRow({ rank, deck, s, rating, color }: { rank: number; deck: SimDeck; s: DeckStats; rating: number; color: string }) {
  const [lo, hi] = wilson(s.wins, s.games);
  const winRate = s.wins / s.games;
  const fair = s.expectedWins / s.games;
  const ratio = winRate / fair;
  const kills = s.kills.combat + s.kills.commander + s.kills.noncombat;
  return (
    <tr>
      <td className="rank">{rank}</td>
      <td>
        <div className="deck-name"><span className="swatch" style={{ background: color }} />{deck.name}</div>
        <div className="muted small">{commanderNames(deck)}</div>
      </td>
      <td className="num strong">{Math.round(rating)}</td>
      <td className="num">
        {pct(winRate)}
        <div className="ci" title={`95% confidence: ${pct(lo)} – ${pct(hi)}`}>
          <span className="ci-bar" style={{ left: pct(lo), width: pct(Math.max(0.005, hi - lo)) }} />
          <span className="ci-mark" style={{ left: pct(winRate) }} />
          <span className="ci-fair" style={{ left: pct(fair) }} />
        </div>
      </td>
      <td className={`num ${ratio >= 1.1 ? 'good' : ratio <= 0.9 ? 'bad' : ''}`}>{ratio.toFixed(2)}×</td>
      <td className="num">{(s.placementSum / s.games).toFixed(2)}</td>
      <td className="num">{s.wins ? (s.winRoundSum / s.wins).toFixed(1) : '—'}</td>
      <td className="kills">
        {kills > 0 ? (
          <div className="stack" title={`Combat ${s.kills.combat} · Commander damage ${s.kills.commander} · Drain/burn ${s.kills.noncombat}`}>
            <span className="k-combat" style={{ flex: s.kills.combat }} />
            <span className="k-commander" style={{ flex: s.kills.commander }} />
            <span className="k-noncombat" style={{ flex: s.kills.noncombat }} />
          </div>
        ) : '—'}
      </td>
      <td className="num">{s.commanderGames ? (s.commanderRoundSum / s.commanderGames).toFixed(1) : '—'}</td>
      <td className="num muted">{s.games.toLocaleString()}</td>
    </tr>
  );
}

function HeadToHeadGrid({ decks, allDecks, h2h }: { decks: SimDeck[]; allDecks: SimDeck[]; h2h: Record<string, Record<string, { meetings: number; ahead: number }>> }) {
  if (decks.length < 2) return <p className="muted">Needs at least two decks with results.</p>;
  return (
    <div className="table-wrap">
      <table className="h2h">
        <thead>
          <tr>
            <th />
            {decks.map((d) => (
              <th key={d.id} title={d.name}><span className="swatch" style={{ background: deckColor(allDecks, d.id) }} />{short(d.name)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {decks.map((row) => (
            <tr key={row.id}>
              <th title={row.name}><span className="swatch" style={{ background: deckColor(allDecks, row.id) }} />{short(row.name)}</th>
              {decks.map((col) => {
                if (row.id === col.id) return <td key={col.id} className="self">—</td>;
                const cell = h2h[row.id]?.[col.id];
                if (!cell?.meetings) return <td key={col.id} className="muted">·</td>;
                const rate = cell.ahead / cell.meetings;
                // Diverging color: green when the row deck wins more, red when it loses more.
                const strength = Math.min(1, Math.abs(rate - 0.5) * 2.5);
                const bg = rate >= 0.5 ? `rgba(47, 158, 68, ${strength * 0.55})` : `rgba(224, 49, 49, ${strength * 0.55})`;
                return (
                  <td key={col.id} style={{ background: bg }} title={`${row.name} outlasted ${col.name} in ${pct(rate)} of ${cell.meetings} shared games`}>
                    {pct(rate, 0)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function short(name: string): string {
  return name.length > 14 ? name.slice(0, 13) + '…' : name;
}
