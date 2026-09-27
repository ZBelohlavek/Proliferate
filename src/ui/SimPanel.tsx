import { useEffect, useState } from 'react';
import type { SimDeck } from '../engine/types';
import type { ForgeController } from '../sim/forgeController';
import { formatCountdown } from '../sim/limit';
import { computeRatings, emptyStats, wilson, type DeckStats, type Stats } from '../sim/stats';
import type { AiProfileChoice, Settings } from '../storage';
import type { DeckForgeCheck } from './useForgeCheck';
import { RatingChart } from './RatingChart';
import { Help } from './Help';
import { commanderNames, deckColor, pct } from './format';

interface Props {
  decks: SimDeck[];
  activeDecks: SimDeck[];
  forge: ForgeController;
  forgeCheck: Record<string, DeckForgeCheck> | null;
  /** Number of Playstyle quiz answers behind the "You" personality. */
  profileAnswers: number;
  onUnselect: (ids: string[]) => void;
  settings: Settings;
  onSettings: (s: Settings) => void;
  onStart: () => void;
  onStop: () => void;
  onReset: () => void;
  onOpenPlaystyle: () => void;
}

const PERSONALITIES: { value: AiProfileChoice; label: string }[] = [
  { value: 'Default', label: 'Default' },
  { value: 'You', label: 'You (learned from your answers)' },
  { value: 'Cautious', label: 'Cautious' },
  { value: 'Reckless', label: 'Reckless' },
  { value: 'Experimental', label: 'Experimental' },
  { value: 'Mixed', label: 'Mixed (random per player)' },
];

export function SimPanel({ decks, activeDecks, forge, forgeCheck, profileAnswers, onUnselect, settings, onSettings, onStart, onStop, onReset, onOpenPlaystyle }: Props) {
  const allStats = forge.stats;
  // Optional filter: show only games with a given number of players.
  const [sizeFilter, setSizeFilter] = useState('all');
  const sizes = Object.keys(allStats.bySize ?? {}).filter((k) => allStats.bySize![k].games > 0).sort();
  const stats: Stats = sizeFilter === 'all' ? allStats : allStats.bySize?.[sizeFilter] ?? emptyStats();
  const status = forge.status;
  const running = forge.running;
  const ready = !!status?.available;
  const cores = Math.max(1, navigator.hardwareConcurrency || 4);
  const enoughDecks = activeDecks.length >= 2;
  const canRun = enoughDecks && ready;
  const set = (patch: Partial<Settings>) => onSettings({ ...settings, ...patch });

  const ratings = computeRatings(stats);
  const rows = decks
    .filter((d) => stats.decks[d.id]?.games)
    .map((d) => ({ deck: d, s: stats.decks[d.id], rating: ratings[d.id] ?? 1500 }))
    .sort((a, b) => b.rating - a.rating);

  const deckName = (id: string) => decks.find((d) => d.id === id)?.name ?? id;
  // Every game with a winner gives exactly one deck a win, so finished games = total wins.
  const finished = Object.values(allStats.decks).reduce((sum, d) => sum + d.wins, 0);
  const draws = Math.max(0, allStats.games - finished);

  // Progress of the current run against its "Run for" limit.
  const run = status?.run ?? null;
  const finishing = !!run?.finishing;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!(running || finishing) || !run?.stopAt) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, finishing, run?.stopAt]);
  let runStatus: string | null = null;
  if (running && run?.stopAt) runStatus = `Stops starting new games in ${formatCountdown(run.stopAt - now)} · ${run.games.toLocaleString()} games this run`;
  else if (running && run?.maxGames) runStatus = `${run.games.toLocaleString()} / ${run.maxGames.toLocaleString()} games this run`;
  else if (running) runStatus = `Running until you stop it · ${run?.games.toLocaleString() ?? 0} games this run`;
  else if (finishing) runStatus = `Limit reached — finishing the ${status?.activeGames ?? 0} game${status?.activeGames === 1 ? '' : 's'} already in progress…`;
  else if (run?.finishedByLimit) runStatus = `Run finished: reached its ${run.maxGames ? `${run.maxGames.toLocaleString()}-game` : 'time'} limit after ${run.games.toLocaleString()} games.`;

  const problems = forgeCheck ? activeDecks.filter((d) => (forgeCheck[d.id]?.missing.length ?? 0) > 0) : [];

  return (
    <>
      <section className="panel controls">
        <div className="control-row">
          <label>
            <span>Players per game <Help>How many decks sit at each game — 4 is standard Commander. If you select more decks than this, each game uses a random subset. Never more than 6. <strong>Mixed</strong> varies the table size from 2 to 6 so you can compare decks at every size.</Help></span>
            <select value={settings.podSize} onChange={(e) => set({ podSize: +e.target.value })} disabled={running}>
              {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n} players{n === 4 ? ' (standard)' : ''}</option>)}
              <option value={0}>Mixed (2–6 players)</option>
            </select>
          </label>
          <label>
            <span>Matchups <Help>Every game draws a new random set of decks and seats them in a random order. <strong>Balanced</strong> picks decks that have played fewer games first (ties at random), so every deck gets the same number of games. <strong>Fully random</strong> is a completely fresh draw each game. Both give every pairing an equal chance.</Help></span>
            <select value={settings.pairing} onChange={(e) => set({ pairing: e.target.value as Settings['pairing'] })} disabled={running}>
              <option value="balanced">Random, balanced</option>
              <option value="random">Fully random</option>
            </select>
          </label>
          <label>
            <span>AI personality <Help>
              Which Forge AI profile pilots the decks. <strong>Default</strong> is Forge&apos;s standard AI. <strong>You</strong> is Default adjusted by your Playstyle answers (how often you attack into trades, counter spells, hold combat tricks, trade blockers and destroy artifacts). <strong>Cautious</strong>, <strong>Reckless</strong> and <strong>Experimental</strong> are Forge&apos;s built-in alternatives. <strong>Mixed</strong> gives each player a random one of Forge&apos;s four every game.
              <br /><br />Forge&apos;s shuffles are fair for every personality — its old &quot;AI shuffle cheat&quot; setting is switched off in simulations.
            </Help></span>
            <select value={settings.aiProfile} onChange={(e) => set({ aiProfile: e.target.value as AiProfileChoice })} disabled={running}>
              {PERSONALITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </select>
          </label>
          <label>
            <span>Forge processes <Help>How many Forge games run at once. Each uses several CPU cores and about 1 GB of RAM. Beyond roughly one process per 4 CPU threads, games just slow each other down.</Help></span>
            <select value={settings.forgeWorkers} onChange={(e) => set({ forgeWorkers: +e.target.value })} disabled={running}>
              {Array.from({ length: Math.min(16, cores) }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>
            <span>Games per launch <Help>How many games each Forge process plays before restarting. Forge takes ~8 seconds to start, so 2–3 saves that time — the same pod plays those games back to back, with the starting player rotating. 1 = a fresh random pod every game.</Help></span>
            <select value={settings.gamesPerLaunch} onChange={(e) => set({ gamesPerLaunch: +e.target.value })} disabled={running}>
              {[1, 2, 3, 5].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label>
            <span>Draw after <Help>If a single Forge game is still going after this long, it&apos;s called a draw. This is <strong>real time</strong> — how long your computer spends on that one game (Magic has no in-game clock). A 4-player game usually takes 35 seconds to 4 minutes, so this mostly catches stuck games like board stalls or loops. Running many Forge processes at once makes each game slower, so watch the draw count. It&apos;s per game — not how long the whole simulation runs (that&apos;s &quot;Run for&quot;).</Help></span>
            <select value={settings.forgeClockSeconds} onChange={(e) => set({ forgeClockSeconds: +e.target.value })} disabled={running}>
              {[300, 600, 900, 1800].map((n) => <option key={n} value={n}>{n / 60} min real time</option>)}
            </select>
          </label>
          <label>
            <span>Run for <Help>How long to keep simulating: until you press Stop, for a set time, or for a set number of games. Separate from the per-game limit. Runs keep to this even with the browser closed; when time is up, games already in progress finish and still count.</Help></span>
            <select
              value={settings.runMode === 'time' ? `t${settings.runMinutes}` : settings.runMode}
              onChange={(e) => {
                const v = e.target.value;
                if (v.startsWith('t')) set({ runMode: 'time', runMinutes: +v.slice(1) });
                else set({ runMode: v as Settings['runMode'] });
              }}
              disabled={running || finishing}
            >
              <option value="untilStopped">Until I stop</option>
              {[15, 30, 60, 120, 240, 480, 720, 1440].map((m) => (
                <option key={m} value={`t${m}`}>{m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}`}</option>
              ))}
              <option value="games">A number of games…</option>
            </select>
          </label>
          {settings.runMode === 'games' && (
            <label>
              Games
              <input
                type="number"
                min={1}
                step={10}
                value={settings.runGames}
                onChange={(e) => set({ runGames: Math.max(1, Math.floor(+e.target.value || 1)) })}
                disabled={running || finishing}
                style={{ width: 110 }}
              />
            </label>
          )}
          <div className="spacer" />
          {running ? (
            <button className="primary stop" onClick={onStop}>Stop</button>
          ) : (
            <button className="primary" disabled={!canRun || finishing} onClick={onStart}>{allStats.games ? 'Resume' : 'Start simulating'}</button>
          )}
          <button onClick={() => confirm('Clear all results?') && onReset()} disabled={!allStats.games}>Reset results</button>
        </div>

        {settings.aiProfile === 'You' && (
          <p className="small">
            {profileAnswers
              ? <>Playing with <strong>your</strong> profile, learned from {profileAnswers} Playstyle answer{profileAnswers === 1 ? '' : 's'}. </>
              : <>You haven&apos;t answered any Playstyle questions yet, so &quot;You&quot; is the same as Default. </>}
            <button className="link" onClick={onOpenPlaystyle}>Answer more questions →</button>
          </p>
        )}

        {runStatus && <p className={`run-status ${running || finishing ? 'live' : ''}`}>{runStatus}</p>}

        <div className="kpis">
          <div className="kpi">
            <span>{finished.toLocaleString()}</span>
            games finished{draws > 0 && <> · {draws.toLocaleString()} draw{draws === 1 ? '' : 's'} ({pct(draws / allStats.games, 1)})</>}
            <Help>Games that ended with a winner. <strong>Draws</strong> are games cut off by the &quot;Draw after&quot; time limit. Lots of draws means the limit is ending games early — raise it to see how decks actually close games out.</Help>
          </div>
          <div className="kpi"><span>{running ? (status?.gamesPerMinute || 0).toFixed(1) : '—'}</span>games per minute</div>
          <div className="kpi"><span>{status?.activeGames ?? 0}</span>games in progress</div>
          <div className="kpi">
            <span>{rows.length ? (rows.reduce((s, r) => s + r.s.winRoundSum, 0) / Math.max(1, rows.reduce((s, r) => s + r.s.wins, 0))).toFixed(1) : '—'}</span>
            avg winning round <Help>On average, the round in which games were won. A round is one turn for every player, so round 8 ≈ each player&apos;s 8th turn.</Help>
          </div>
        </div>

        {!status && (
          <p className="warn">The Forge backend isn&apos;t reachable. Simulations need the local server (<code>npm run dev</code>); they can&apos;t run on static hosting.</p>
        )}
        {status && !status.available && <p className="warn">{status.problem}</p>}
        {ready && (
          <p className="muted small">
            Forge {status!.version} at <code>{status!.forgeDir}</code> plays every game under the full Magic rules with its own card scripts and AI. Games keep running
            while this page is closed, as long as the dev server is up.
          </p>
        )}
        {problems.length > 0 && (
          <div className="forge-warning">
            <span>
              Forge doesn&apos;t recognise some cards in {problems.map((d) => `${d.name} (${forgeCheck![d.id].missing.length})`).join(', ')} and would play without them.
            </span>
            <button onClick={() => onUnselect(problems.map((d) => d.id))} disabled={running}>Unselect {problems.length === 1 ? 'it' : 'them'}</button>
          </div>
        )}
        {forge.warnings.map((w) => (
          <p key={w.deckId} className="warn small">
            {deckName(w.deckId)}: Forge doesn&apos;t know {w.missing.join(', ')}, so {w.missing.length === 1 ? 'it was' : 'they were'} left out of the deck.
          </p>
        ))}
        {status?.errors.map((e, i) => <p key={i} className="err small">{e}</p>)}
        {!enoughDecks && <p className="warn">Select at least two decks on the Decks tab.</p>}
        {forge.lastError && <p className="err">{forge.lastError}</p>}
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
              <span className="muted small">Ranked by rating <Help>Each game counts as a mini-match between every pair of decks at the table, won by whoever lasted longer. The <strong>rating</strong> is fitted to all of those matches on an Elo-like scale: 1500 is average, and a deck rated 100 points higher outlasts an average deck about 64% of the time. It uses every game, not just wins, so it settles faster than win rate.</Help> — click any ⓘ to see what a column means.</span>
            </div>
            <div className="table-wrap">
              <table className="leaderboard">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Deck</th>
                    <th>Rating <Help>Strength on an Elo-like scale: 1500 is average; +100 means outlasting an average deck about 64% of the time. Fitted to every pairing in every game.</Help></th>
                    <th>Win rate <Help>
                      Share of games this deck won. The little bar under it shows how sure we are:
                      <br /><br /><strong>Shaded band</strong> — the 95% range: the deck&apos;s true win rate is very probably in here. It shrinks as more games are played.
                      <br /><strong>Coloured tick</strong> — the win rate measured so far.
                      <br /><strong>Thin grey line</strong> — a fair share (1 ÷ number of players, e.g. 25% in 4-player games). Band entirely right of it = genuinely better than average; entirely left = genuinely worse.
                    </Help></th>
                    <th>vs. fair <Help>Win rate divided by a fair share. 1.00× = wins exactly as often as chance would give it; 1.50× = 50% more often; 0.50× = half as often. Green above 1.1×, red below 0.9×.</Help></th>
                    <th>Avg place <Help>Average finishing position: 1 = won, 4 = first out in a 4-player game. Lower is better. Unlike win rate, this also rewards coming second.</Help></th>
                    <th>Win round <Help>Average round in which this deck won its games. Lower = faster deck.</Help></th>
                    <th>Kills by <Help>How this deck knocked opponents out. <span className="legend-swatch k-combat" /> combat damage, <span className="legend-swatch k-commander" /> 21 commander damage, <span className="legend-swatch k-noncombat" /> drain / burn / other life loss. Hover the bar for exact numbers.</Help></th>
                    <th>Cmdr out <Help>Average round in which the commander was first cast.</Help></th>
                    <th>Mulligans <Help>Average number of mulligans per game, counting Commander&apos;s free first mulligan. High numbers point to a shaky mana base or too many expensive cards. (Games from before this was tracked may count slightly low.)</Help></th>
                    <th>Games <Help>Games this deck has played. More games = narrower win-rate band = more trustworthy numbers.</Help></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(({ deck, s, rating }, i) => (
                    <LeaderRow key={deck.id} rank={i + 1} deck={deck} s={s} rating={rating} color={deckColor(decks, deck.id)} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="legend-row">
              <span className="item">
                <span className="legend-ci">
                  <span className="ci-bar" style={{ left: '20%', width: '45%' }} />
                  <span className="ci-mark" style={{ left: '42%' }} />
                  <span className="ci-fair" style={{ left: '30%' }} />
                </span>
                Win-rate bar: shaded band = likely range (95%), coloured tick = measured win rate, thin grey line = fair share
              </span>
              <span className="item"><span className="legend-swatch k-combat" />combat</span>
              <span className="item"><span className="legend-swatch k-commander" />commander damage</span>
              <span className="item"><span className="legend-swatch k-noncombat" />drain / burn</span>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <h2>Head to head <Help>Each cell: how often the <strong>row</strong> deck lasted longer than the <strong>column</strong> deck in games where both played. 50% = even. Green = the row deck usually wins that matchup, red = usually loses. Hover a cell for the number of games.</Help></h2>
              <span className="muted small">How often the row deck outlasted the column deck when they shared a pod.</span>
            </div>
            <HeadToHeadGrid decks={rows.map((r) => r.deck)} allDecks={decks} h2h={stats.h2h} />
          </section>

          {sizes.length > 1 && (
            <section className="panel">
              <div className="panel-head">
                <h2>By player count <Help>Each deck&apos;s win rate at each table size, compared with a fair share (1 in 2 for 1v1, 1 in 4 for 4-player…). 1.00× = exactly fair. Decks with &quot;each opponent&quot; effects often get stronger with more players; big single threats often do best 1v1. Cells need 20+ games to show.</Help></h2>
              </div>
              <PlayerCountGrid decks={decks} stats={allStats} sizes={sizes} />
            </section>
          )}

          <section className="panel">
            <div className="panel-head">
              <h2>Rating over time</h2>
              <span className="muted small">Lines flatten out as the ratings converge — once they stop moving, more games won&apos;t change the ranking.</span>
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
      <td className="num">{(s.mulligans / s.games).toFixed(2)}</td>
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
