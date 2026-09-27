import { useMemo, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { deckSize, modeledFraction } from '../import/deck';
import { ColorPips, commanderNames, deckColor, pct } from './format';
import { matchSearch } from '../import/search';

interface Props {
  decks: SimDeck[];
  selected: string[];
  /** Deck id -> cards Forge doesn't know; null when Forge isn't available. */
  forgeMissing: Record<string, string[]> | null;
  onToggle: (id: string) => void;
  onSetSelected: (ids: string[], on: boolean) => void;
  onRemove: (id: string) => void;
  onReport: (id: string) => void;
}

export function DeckList({ decks, selected, forgeMissing, onToggle, onSetSelected, onRemove, onReport }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const shown = useMemo(
    () => decks.map((deck) => ({ deck, why: matchSearch(deck, query) })).filter((x) => x.why !== null),
    [decks, query],
  );
  const shownIds = shown.map((x) => x.deck.id);
  const forgeProblems = forgeMissing ? decks.filter((d) => (forgeMissing[d.id]?.length ?? 0) > 0) : [];
  const selectedProblems = forgeProblems.filter((d) => selected.includes(d.id));

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
        <span className="muted">{selected.length} of {decks.length} selected — checked decks take part in simulations.</span>
      </div>
      <div className="deck-toolbar">
        <input
          type="search"
          placeholder="Search by deck name, commander or card…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button onClick={() => onSetSelected(shownIds, true)} disabled={!shown.length}>Select {query ? 'shown' : 'all'}</button>
        <button onClick={() => onSetSelected(shownIds, false)} disabled={!shown.length}>Unselect {query ? 'shown' : 'all'}</button>
      </div>
      {forgeMissing && selectedProblems.length > 0 && (
        <div className="forge-warning">
          <span>
            <strong>{selectedProblems.length}</strong> selected deck{selectedProblems.length === 1 ? ' has' : 's have'} cards Forge doesn&apos;t recognise.
            Forge games leave those cards out, which makes the deck weaker than it really is.
          </span>
          <button onClick={() => onSetSelected(selectedProblems.map((d) => d.id), false)}>Unselect {selectedProblems.length === 1 ? 'it' : 'them'}</button>
        </div>
      )}
      {query && <p className="muted small">Showing {shown.length} of {decks.length} decks.</p>}
      <div className="deck-grid">
        {shown.map(({ deck, why }) => {
          const unknown = forgeMissing?.[deck.id];
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
                <div className="deck-sub">{commanderNames(deck)}{why && <span className="muted small"> · {why}</span>}</div>
                <div className="deck-meta">
                  <span className={size === 100 ? '' : 'warn'}>{size} cards</span>
                  <span title="Share of non-land cards the simulator understands. Unmodeled cards are played as blanks.">
                    <span className={`meter ${modeled < 0.8 ? 'low' : ''}`}><span style={{ width: pct(modeled, 0) }} /></span>
                    {pct(modeled, 0)} modeled
                  </span>
                  {unknown && (unknown.length === 0
                    ? <span className="forge-ok" title="Forge has scripts for every card in this deck">Forge ✓</span>
                    : <span className="forge-bad" title={`Forge doesn't recognise: ${unknown.join(', ')}`}>Forge: {unknown.length} unknown card{unknown.length === 1 ? '' : 's'}</span>)}
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
