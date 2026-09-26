import type { SimDeck } from '../engine/types';
import type { Stats } from '../sim/stats';
import { deckColor } from './format';

const W = 1000;
const H = 300;
const PAD = { left: 44, right: 12, top: 12, bottom: 28 };

/** Line chart of each deck's rating as games accumulate. Plain SVG, no library. */
export function RatingChart({ history, decks, allDecks }: { history: Stats['history']; decks: SimDeck[]; allDecks: SimDeck[] }) {
  if (history.length < 2) return <p className="muted">The chart appears after a few dozen games.</p>;

  const maxGames = history[history.length - 1].games;
  let lo = Infinity;
  let hi = -Infinity;
  for (const h of history) {
    for (const d of decks) {
      const r = h.ratings[d.id];
      if (r === undefined) continue;
      lo = Math.min(lo, r);
      hi = Math.max(hi, r);
    }
  }
  lo = Math.floor((lo - 20) / 50) * 50;
  hi = Math.ceil((hi + 20) / 50) * 50;

  const x = (g: number) => PAD.left + (g / maxGames) * (W - PAD.left - PAD.right);
  const y = (r: number) => PAD.top + (1 - (r - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const ticks: number[] = [];
  const step = hi - lo > 400 ? 100 : 50;
  for (let t = lo; t <= hi; t += step) ticks.push(t);

  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Rating over time">
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} className={t === 1500 ? 'grid base' : 'grid'} />
            <text x={PAD.left - 6} y={y(t) + 4} textAnchor="end" className="axis">{t}</text>
          </g>
        ))}
        <text x={W - PAD.right} y={H - 8} textAnchor="end" className="axis">{maxGames.toLocaleString()} games</text>
        <text x={PAD.left} y={H - 8} className="axis">0</text>
        {decks.map((d) => {
          const points = history.filter((h) => h.ratings[d.id] !== undefined).map((h) => `${x(h.games).toFixed(1)},${y(h.ratings[d.id]).toFixed(1)}`);
          if (points.length < 2) return null;
          return <polyline key={d.id} points={points.join(' ')} fill="none" stroke={deckColor(allDecks, d.id)} strokeWidth={2} strokeLinejoin="round" />;
        })}
      </svg>
      <div className="legend">
        {decks.map((d) => (
          <span key={d.id}><span className="swatch" style={{ background: deckColor(allDecks, d.id) }} />{d.name}</span>
        ))}
      </div>
    </div>
  );
}
