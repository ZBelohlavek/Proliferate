import { useState } from 'react';
import type { SimDeck } from '../engine/types';
import type { SimController } from '../sim/controller';
import type { ForgeController } from '../sim/forgeController';
import { computeRatings, emptyStats, wilson, type DeckStats, type Stats } from '../sim/stats';
import type { Settings } from '../storage';
import { RatingChart } from './RatingChart';
import { commanderNames, deckColor, pct } from './format';

interface Props {
  decks: SimDeck[];
  activeDecks: SimDeck[];
  quick: SimController;
  forge: ForgeController;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
}

export function SimPanel({ decks, activeDecks, quick, forge, settings, onSettings, onStart, onStop, onReset }: Props) {
  const isForge = settings.engine === 'forge';
  const allStats = isForge ? forge.stats : quick.stats;
  // Optional filter: show only games with a given number of players.
  const [sizeFilter, setSizeFilter] = useState('all');
  const sizes = Object.keys(allStats.bySize ?? {}).filter((k) => allStats.bySize![k].games > 0).sort();
  const stats: Stats = sizeFilter === 'all' ? allStats : allStats.bySize?.[sizeFilter] ?? emptyStats();
  const running = isForge ? forge.running : quick.running;
  const lastError = isForge ? forge.lastError : quick.lastError;
  const forgeStatus = forge.status;
  const forgeReady = !!forgeStatus?.available;
  const cores = Math.max(1, navigator.hardwareConcurrency || 4);
  const enoughDecks = activeDecks.length >= 2;
  const canRun = enoughDecks && (!isForge || forgeReady);
  const set = (patch: Partial<Settings>) => onSettings({ ...settings, ...patch });

  const ratings = computeRatings(stats);
  const rows = decks
    .filter((d) => stats.decks[d.id]?.games)
    .map((d) => ({ deck: d, s: stats.decks[d.id], rating: ratings[d.id] ?? 1500 }))
    .sort((a, b) => b.rating - a.rating);

  const rate = isForge
    ? forgeStatus?.running ? (forgeStatus.gamesPerMinute || 0).toFixed(1) : '—'
    : quick.running ? Math.round(quick.gamesPerSecond).toLocaleString() : '—';
  const deckName = (id: string) => decks.find((d) => d.id === id)?.name ?? id;

  return (
    <>
      <section className="panel controls">
        <div className="engine-switch">
          <button className={!isForge ? 'active' : ''} onClick={() => set({ engine: 'quick' })} disabled={running}>
            <strong>Quick</strong>
            <span>Built-in simplified engine · thousands of games per second</span>
          </button>
          <button className={isForge ? 'active' : ''} onClick={() => set({ engine: 'forge' })} disabled={running}>
            <strong>Accurate (Forge)</strong>
            <span>Full Magic rules · about a game per minute per process</span>
          </button>
        </div>

        {!isForge && (
          <p className="small">
            Pilot: <strong>{settings.usePlaystyle ? 'your playstyle' : 'default AI'}</strong>
            <span className="muted"> — change it on the Playstyle tab.{allStats.games > 0 && ' Switching pilots mid-run mixes two play styles into the same results, so reset first for clean numbers.'}</span>
          </p>
        )}

        <div className="control-row">
          <label title="How many decks sit at each game. Selected decks rotate through the seats, so every deck plays about equally. Never more than 6.">
            Players per game
            <select value={settings.podSize} onChange={(e) => set({ podSize: +e.target.value })} disabled={running}>
              {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} players{n === 4 ? ' (standard)' : ''}</option>)}
              <option value={0}>Mixed (2–6 players)</option>
            </select>
          </label>
          <label title="Every game draws a new random set of decks and seats them in random order. Balanced also makes sure every deck plays about the same number of games.">
            Matchups
            <select value={settings.pairing} onChange={(e) => set({ pairing: e.target.value as Settings['pairing'] })} disabled={running}>
              <option value="balanced">Random, balanced</option>
              <option value="random">Fully random</option>
            </select>
          </label>
          {isForge ? (
            <>
              <label title="Each Forge process plays one game at a time and uses 1–2 GB of RAM.">
                Forge processes
                <select value={settings.forgeWorkers} onChange={(e) => set({ forgeWorkers: +e.target.value })} disabled={running}>
                  {Array.from({ length: Math.min(16, cores) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label title="Games still running after this long are called a draw.">
                Time limit
                <select value={settings.forgeClockSeconds} onChange={(e) => set({ forgeClockSeconds: +e.target.value })} disabled={running}>
                  {[300, 600, 900, 1800].map((n) => <option key={n} value={n}>{n / 60} min per game</option>)}
                </select>
              </label>
            </>
          ) : (
            <>
              <label>
                CPU threads
                <select value={settings.workers} onChange={(e) => set({ workers: +e.target.value })} disabled={running}>
                  {Array.from({ length: cores }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </label>
              <label>
                Turn limit
                <select value={settings.maxRounds} onChange={(e) => set({ maxRounds: +e.target.value })} disabled={running}>
                  {[15, 20, 25, 30, 40].map((n) => <option key={n} value={n}>{n} rounds</option>)}
                </select>
              </label>
            </>
          )}
          <div className="spacer" />
          {running ? (
            <button className="primary stop" onClick={onStop}>{isForge ? 'Stop' : 'Pause'}</button>
          ) : (
            <button className="primary" disabled={!canRun} onClick={onStart}>{allStats.games ? 'Resume' : 'Start simulating'}</button>
          )}
          <button onClick={() => confirm(`Clear all ${isForge ? 'Forge' : 'quick'} results?`) && onReset()} disabled={!allStats.games}>Reset results</button>
        </div>

        <div className="kpis">
          <div className="kpi"><span>{allStats.games.toLocaleString()}</span>games played</div>
          <div className="kpi"><span>{rate}</span>games per {isForge ? 'minute' : 'second'}</div>
          <div className="kpi">
            <span>{isForge ? (forgeStatus?.activeGames ?? 0) : activeDecks.length}</span>
            {isForge ? 'games in progress' : 'decks in rotation'}
          </div>
          <div className="kpi"><span>{rows.length ? (rows.reduce((s, r) => s + r.s.winRoundSum, 0) / Math.max(1, rows.reduce((s, r) => s + r.s.wins, 0))).toFixed(1) : '—'}</span>avg winning round</div>
        </div>

        {isForge && !forgeStatus && (
          <p className="warn">The Forge backend isn&apos;t reachable. Accurate mode needs the local server (<code>npm run dev</code>); it can&apos;t run on static hosting.</p>
        )}
        {isForge && forgeStatus && !forgeStatus.available && <p className="warn">{forgeStatus.problem}</p>}
        {isForge && forgeReady && (
          <p className="muted small">
            Forge {forgeStatus!.version} at <code>{forgeStatus!.forgeDir}</code>. Every card is played by Forge&apos;s own card scripts and AI under the full rules.
            Games keep running while this page is closed, as long as the dev server is up.
          </p>
        )}
        {isForge && forge.warnings.map((w) => (
          <p key={w.deckId} className="warn small">
            {deckName(w.deckId)}: Forge doesn&apos;t know {w.missing.join(', ')}, so {w.missing.length === 1 ? 'it was' : 'they were'} left out of the deck.
          </p>
        ))}
        {isForge && forgeStatus?.errors.map((e, i) => <p key={i} className="err small">{e}</p>)}
        {!enoughDecks && <p className="warn">Select at least two decks on the Decks tab.</p>}
        {lastError && <p className="err">{lastError}</p>}
        {settings.podSize !== 0 && activeDecks.length > settings.podSize && (
          <p className="muted small">
            Every game seats a random {settings.podSize} of your {activeDecks.length} selected decks in random order
            {settings.pairing === 'balanced' ? ', favouring decks that have played fewer games so everyone plays about equally.' : ' — a completely fresh draw each game.'}
          </p>
        )}
        {settings.podSize === 0 && enoughDecks && (
          <p className="muted small">Each game picks a random pod size from 2 to {Math.min(6, activeDecks.length)} players, so you can see how each deck does at every table size below.</p>
        )}
        {settings.podSize > activeDecks.length && enoughDecks && (
          <p className="muted small">Only {activeDecks.length} decks selected, so pods will have {activeDecks.length} players.</p>
        )}
      </section>

      {rows.length > 0 && (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>Leaderboard</h2>
              {sizes.length > 1 && (
                <div className="seg">
                  <button className={sizeFilter === 'all' ? 'active' : ''} onClick={() => setSizeFilter('all')}>All pods</button>
                  {sizes.map((k) => (
                    <button key={k} className={sizeFilter === k ? 'active' : ''} onClick={() => setSizeFilter(k)}>{k} players</button>
                  ))}
                </div>
              )}
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

          {sizes.length > 1 && (
            <section className="panel">
              <div className="panel-head">
                <h2>By player count</h2>
                <span className="muted small">Win rate compared with a fair share at each table size (1.00× = wins exactly 1 in N). Some decks shine 1v1, others in big pods.</span>
              </div>
              <PlayerCountGrid decks={decks} stats={allStats} sizes={sizes} />
            </section>
          )}

          <section className="panel">
            <div className="panel-head">
              <h2>Rating over time</h2>
              <span className="muted small">Lines flatten out as the ratings converge — once they stop moving, more games won't change the ranking.</span>
            </div>
            <RatingChart history={allStats.history} decks={rows.map((r) => r.deck)} allDecks={decks} />
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

function PlayerCountGrid({ decks, stats, sizes }: { decks: SimDeck[]; stats: Stats; sizes: string[] }) {
  const rows = decks.filter((d) => stats.decks[d.id]?.games);
  return (
    <div className="table-wrap">
      <table className="h2h">
        <thead>
          <tr>
            <th />
            {sizes.map((k) => <th key={k}>{k} players</th>)}
            <th>Best at</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            let best: string | null = null;
            let bestRatio = 0;
            const cells = sizes.map((k) => {
              const s = stats.bySize?.[k]?.decks[d.id];
              if (!s || s.games < 20) return <td key={k} className="muted" title="Fewer than 20 games">{s ? '·' : ''}</td>;
              const ratio = s.wins / s.expectedWins;
              const [lo, hi] = wilson(s.wins, s.games);
              const fair = s.expectedWins / s.games;
              if (ratio > bestRatio) {
                bestRatio = ratio;
                best = k;
              }
              // Green above a fair share, red below; stronger colour = further from fair.
              const strength = Math.min(1, Math.abs(ratio - 1));
              const bg = ratio >= 1 ? `rgba(47, 158, 68, ${strength * 0.55})` : `rgba(224, 49, 49, ${strength * 0.55})`;
              return (
                <td key={k} style={{ background: bg }} title={`Won ${pct(s.wins / s.games)} of ${s.games} games (95%: ${pct(lo)}–${pct(hi)}); fair share ${pct(fair)}`}>
                  {ratio.toFixed(2)}×
                </td>
              );
            });
            return (
              <tr key={d.id}>
                <th title={d.name}><span className="swatch" style={{ background: deckColor(decks, d.id) }} />{d.name.length > 26 ? d.name.slice(0, 25) + '…' : d.name}</th>
                {cells}
                <td>{best ? `${best} players` : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
