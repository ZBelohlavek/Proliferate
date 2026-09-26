import { useMemo, useState, type ReactNode } from 'react';
import type { SimDeck } from '../engine/types';
import { BRACKET_NAMES, estimateBracket } from '../analysis/bracket';
import { cardReport } from '../analysis/cards';
import { composition, type Composition } from '../analysis/composition';
import { computeRatings, type Stats } from '../sim/stats';
import { ColorPips, commanderNames, deckColor, pct } from './format';
import { useBracketData } from './useBracket';

interface Props {
  decks: SimDeck[];
  selected: string[];
  quickStats: Stats;
  forgeStats: Stats;
  onOpenReport: (deckId: string) => void;
}

const MAX_COLUMNS = 6;

export function ComparePanel({ decks, selected, quickStats, forgeStats, onOpenReport }: Props) {
  const [chosen, setChosen] = useState<string[]>(() => selected.slice(0, MAX_COLUMNS));
  const columns = decks.filter((d) => chosen.includes(d.id));
  const { states } = useBracketData(columns);
  const quickRatings = useMemo(() => computeRatings(quickStats), [quickStats, quickStats.games]);
  const forgeRatings = useMemo(() => computeRatings(forgeStats), [forgeStats, forgeStats.games]);
  const comps = useMemo(() => new Map(columns.map((d) => [d.id, composition(d)])), [columns]);

  const toggle = (id: string) =>
    setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : c.length >= MAX_COLUMNS ? c : [...c, id]));

  if (decks.length === 0) return <section className="panel empty"><p>Import some decks first.</p></section>;

  const row = (label: ReactNode, cell: (d: SimDeck) => ReactNode, hint?: string) => (
    <tr>
      <th title={hint}>{label}</th>
      {columns.map((d) => <td key={d.id}>{cell(d)}</td>)}
    </tr>
  );
  const section = (title: string) => (
    <tr className="section"><th colSpan={columns.length + 1}>{title}</th></tr>
  );
  const sim = (stats: Stats, ratings: Record<string, number>, d: SimDeck, what: 'rating' | 'win' | 'place' | 'games') => {
    const s = stats.decks[d.id];
    if (!s?.games) return <span className="muted">—</span>;
    if (what === 'rating') return <strong>{Math.round(ratings[d.id] ?? 1500)}</strong>;
    if (what === 'win') return <>{pct(s.wins / s.games)} <span className="muted small">({(s.wins / s.expectedWins).toFixed(2)}× fair)</span></>;
    if (what === 'place') return (s.placementSum / s.games).toFixed(2);
    return s.games.toLocaleString();
  };
  const comp = (key: keyof Composition, digits = 0) => (d: SimDeck) => {
    const v = comps.get(d.id)![key] as number;
    return digits ? v.toFixed(digits) : v;
  };

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2>Compare decks</h2>
          <span className="muted small">Pick up to {MAX_COLUMNS} decks to see side by side.</span>
        </div>
        <div className="chips">
          {decks.map((d) => (
            <button key={d.id} className={`chip ${chosen.includes(d.id) ? 'on' : ''}`} onClick={() => toggle(d.id)}>
              <span className="swatch" style={{ background: deckColor(decks, d.id) }} />
              {d.name}
            </button>
          ))}
        </div>
      </section>

      {columns.length > 0 && (
        <section className="panel">
          <div className="table-wrap">
            <table className="compare">
              <thead>
                <tr>
                  <th />
                  {columns.map((d) => (
                    <th key={d.id}>
                      <div className="deck-name"><span className="swatch" style={{ background: deckColor(decks, d.id) }} />{d.name}</div>
                      <div className="muted small">{commanderNames(d)}</div>
                      <ColorPips colors={d.colorIdentity} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {section('Bracket')}
                {row('Estimated bracket', (d) => {
                  const st = states[d.id];
                  if (!st || st.loading) return <span className="muted">Checking…</span>;
                  if (!st.data) return <span className="err small">{st.error ?? 'Unavailable'}</span>;
                  const est = estimateBracket(st.data, forgeStats.decks[d.id]);
                  return (
                    <div>
                      <span className={`bracket-badge b${est.bracket}`}>{est.bracket}</span> <strong>{BRACKET_NAMES[est.bracket]}</strong>
                      {est.note && <div className="small muted">{est.note}</div>}
                      <div className="small">{est.reasons[0]?.text}</div>
                    </div>
                  );
                }, 'Estimated from the official Commander Brackets rules. Open the full report for every reason.')}
                {row('Game Changers', (d) => states[d.id]?.data ? states[d.id].data!.gameChangers.length : '…')}
                {row('Two-card combos', (d) => states[d.id]?.data ? states[d.id].data!.combos.filter((c) => c.twoCard).length : '…')}
                {row('Commander Spellbook', (d) => states[d.id]?.data?.spellbookTag ?? '…', "Commander Spellbook's own power label (their scale, not the official brackets)")}

                {section('Quick simulation')}
                {row('Rating', (d) => sim(quickStats, quickRatings, d, 'rating'))}
                {row('Win rate', (d) => sim(quickStats, quickRatings, d, 'win'))}
                {row('Avg place', (d) => sim(quickStats, quickRatings, d, 'place'))}
                {row('Games', (d) => sim(quickStats, quickRatings, d, 'games'))}
                {row('By player count', (d) => <BySize stats={quickStats} deckId={d.id} />, 'Win rate vs a fair share at each pod size (run with Mixed pod sizes to fill this in)')}

                {section('Accurate simulation (Forge)')}
                {row('Rating', (d) => sim(forgeStats, forgeRatings, d, 'rating'))}
                {row('Win rate', (d) => sim(forgeStats, forgeRatings, d, 'win'))}
                {row('Avg winning round', (d) => {
                  const s = forgeStats.decks[d.id];
                  return s?.wins ? (s.winRoundSum / s.wins).toFixed(1) : <span className="muted">—</span>;
                })}
                {row('Games', (d) => sim(forgeStats, forgeRatings, d, 'games'))}

                {section('Deck makeup (approximate)')}
                {row('Lands', comp('lands'))}
                {row('Avg mana value', comp('avgManaValue', 2), 'Average mana value of non-land cards')}
                {row('Mana curve', (d) => <Curve curve={comps.get(d.id)!.curve} color={deckColor(decks, d.id)} />)}
                {row('Creatures', comp('creatures'))}
                {row('Ramp', comp('ramp'), 'Mana rocks, dorks, land ramp, treasures, cost reducers')}
                {row('Card draw', comp('draw'))}
                {row('Spot removal', comp('removal'))}
                {row('Board wipes', comp('wipes'))}
                {row('Counterspells', comp('counters'))}
                {row('Tutors', comp('tutors'))}
                {row('Protection', comp('protection'))}
                {row('Understood by quick engine', (d) => pct(comps.get(d.id)!.modeled, 0))}

                {section('Cards (quick engine)')}
                {row('Weakest', (d) => <CardList deck={d} stats={quickStats} which="weak" />)}
                {row('Strongest', (d) => <CardList deck={d} stats={quickStats} which="strong" />)}
                {row('', (d) => <button onClick={() => onOpenReport(d.id)}>Full report →</button>)}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Curve({ curve, color }: { curve: number[]; color: string }) {
  const max = Math.max(1, ...curve);
  return (
    <div className="curve" title={curve.map((n, i) => `${i === 7 ? '7+' : i}: ${n}`).join(' · ')}>
      {curve.map((n, i) => (
        <div key={i} className="curve-col">
          <div className="curve-bar" style={{ height: `${(n / max) * 100}%`, background: color }} />
          <span>{i === 7 ? '7+' : i}</span>
        </div>
      ))}
    </div>
  );
}

function CardList({ deck, stats, which }: { deck: SimDeck; stats: Stats; which: 'weak' | 'strong' }) {
  const report = cardReport(stats, deck, 'early');
  if (report.notice && report.games < 400) return <span className="muted small">Needs more games</span>;
  const rows = report.rows
    .filter((r) => !r.card.isLand && r.card.modeled && r.impact !== null)
    .sort((a, b) => (which === 'weak' ? a.impact! - b.impact! : b.impact! - a.impact!))
    .slice(0, 3);
  return (
    <ul className="mini-list">
      {rows.map((r) => (
        <li key={r.name}>
          {r.name} <span className={r.impact! < 0 ? 'bad small' : 'good small'}>{r.impact! > 0 ? '+' : ''}{r.impact!.toFixed(1)}</span>
        </li>
      ))}
    </ul>
  );
}

function BySize({ stats, deckId }: { stats: Stats; deckId: string }) {
  const entries = Object.entries(stats.bySize ?? {})
    .map(([size, s]) => ({ size, d: s.decks[deckId] }))
    .filter((e) => e.d && e.d.games >= 20)
    .sort((a, b) => +a.size - +b.size);
  if (entries.length < 2) return <span className="muted small">Run with Mixed pod sizes</span>;
  return (
    <div className="small">
      {entries.map(({ size, d }) => {
        const ratio = d.wins / d.expectedWins;
        return (
          <div key={size}>
            {size}p: <span className={ratio >= 1.1 ? 'good' : ratio <= 0.9 ? 'bad' : ''}>{ratio.toFixed(2)}×</span>
          </div>
        );
      })}
    </div>
  );
}
