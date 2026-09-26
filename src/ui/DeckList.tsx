import { useState } from 'react';
import type { SimDeck } from '../engine/types';
import { deckSize, modeledFraction } from '../import/deck';
import { ColorPips, commanderNames, deckColor, pct } from './format';

interface Props {
  decks: SimDeck[];
  selected: string[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
  onReport: (id: string) => void;
}

export function DeckList({ decks, selected, onToggle, onRemove, onReport }: Props) {
  const [open, setOpen] = useState<string | null>(null);

  if (!decks.length) {
    return (
      <section className="panel empty">
        <p>No decks yet. Paste an Archidekt link above to get started — you need at least two decks to simulate.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Your decks</h2>
        <span className="muted">Checked decks take part in simulations.</span>
      </div>
      <div className="deck-grid">
        {decks.map((deck) => {
          const modeled = modeledFraction(deck);
          const size = deckSize(deck);
          return (
            <article key={deck.id} className={`deck-card ${selected.includes(deck.id) ? 'on' : 'off'}`} style={{ borderLeftColor: deckColor(decks, deck.id) }}>
              <label className="deck-check">
                <input type="checkbox" aria-label={`Include ${deck.name} in simulations`} checked={selected.includes(deck.id)} onChange={() => onToggle(deck.id)} />
              </label>
              <div className="deck-main">
                <div className="deck-title">
                  {deck.url ? <a href={deck.url} target="_blank" rel="noreferrer">{deck.name}</a> : deck.name}
                  <ColorPips colors={deck.colorIdentity} />
                </div>
                <div className="deck-sub">{commanderNames(deck)}</div>
                <div className="deck-meta">
                  <span className={size === 100 ? '' : 'warn'}>{size} cards</span>
                  <span title="Share of non-land cards the simulator understands. Unmodeled cards are played as blanks.">
                    <span className={`meter ${modeled < 0.8 ? 'low' : ''}`}><span style={{ width: pct(modeled, 0) }} /></span>
                    {pct(modeled, 0)} modeled
                  </span>
                </div>
              </div>
              <div className="deck-actions">
                <button onClick={() => onReport(deck.id)}>Report</button>
                <button onClick={() => setOpen(open === deck.id ? null : deck.id)}>{open === deck.id ? 'Hide' : 'Cards'}</button>
                <button className="danger" onClick={() => confirm(`Remove “${deck.name}”?`) && onRemove(deck.id)}>Remove</button>
              </div>
              {open === deck.id && <DeckDetail deck={deck} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DeckDetail({ deck }: { deck: SimDeck }) {
  const [onlyUnmodeled, setOnlyUnmodeled] = useState(false);
  const rows = [
    ...deck.commanders.map((card) => ({ card, count: 1, commander: true })),
    ...deck.cards.map((c) => ({ ...c, commander: false })),
  ]
    .filter((r) => !onlyUnmodeled || !r.card.modeled)
    .sort((a, b) => Number(b.commander) - Number(a.commander) || Number(a.card.isLand) - Number(b.card.isLand) || a.card.cmc - b.card.cmc);

  return (
    <div className="deck-detail">
      <label className="muted small">
        <input type="checkbox" checked={onlyUnmodeled} onChange={(e) => setOnlyUnmodeled(e.target.checked)} /> Only show cards the simulator doesn't understand
      </label>
      <table>
        <thead>
          <tr><th>#</th><th>Card</th><th>MV</th><th>How the simulator plays it</th></tr>
        </thead>
        <tbody>
          {rows.map(({ card, count, commander }) => (
            <tr key={card.name} className={card.modeled ? '' : 'unmodeled'}>
              <td>{count}</td>
              <td>
                {commander && <span className="tag">CMDR</span>} {card.name}
                <div className="muted small">{card.typeLine}</div>
              </td>
              <td>{card.isLand ? '' : card.cmc}</td>
              <td>{card.notes.join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
