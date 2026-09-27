import { useMemo, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { deckSize } from '../import/deck';
import { ColorPips, commanderNames, deckColor } from './format';
import { matchSearch } from '../import/search';
import { Help } from './Help';
import type { DeckForgeCheck } from './useForgeCheck';

interface Props {
  decks: SimDeck[];
  selected: string[];
  /** Deck id -> Forge's view of its cards; null when Forge isn't available. */
  forgeCheck: Record<string, DeckForgeCheck> | null;
  onToggle: (id: string) => void;
  onSetSelected: (ids: string[], on: boolean) => void;
  onRemove: (id: string) => void;
  onReport: (id: string) => void;
}

export function DeckList({ decks, selected, forgeCheck, onToggle, onSetSelected, onRemove, onReport }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const shown = useMemo(
    () => decks.map((deck) => ({ deck, why: matchSearch(deck, query) })).filter((x) => x.why !== null),
    [decks, query],
  );
  const shownIds = shown.map((x) => x.deck.id);
  const forgeProblems = forgeCheck ? decks.filter((d) => (forgeCheck[d.id]?.missing.length ?? 0) > 0) : [];
  const selectedProblems = forgeProblems.filter((d) => selected.includes(d.id));

  if (!decks.length) {
    return (
      <section className="panel empty">
        <p>No decks yet. Link your Archidekt account or paste a deck link above to get started — you need at least two decks to simulate.</p>
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Your decks <Help>
          Tick a deck to include it in simulations.
          <br /><br /><strong>Forge ✓</strong> — Forge knows every card. <strong>N unknown</strong> — Forge has no script for those cards, so they&apos;d be left out of its games.
          <br /><br /><strong>AI plays N poorly</strong> — cards Forge&apos;s own developers flag as ones its AI doesn&apos;t use well. The deck still works, but results may underrate it a little. Click <strong>Cards</strong> to see which.
        </Help></h2>
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
      {selectedProblems.length > 0 && (
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
          const check = forgeCheck?.[deck.id];
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
                  {check && (check.missing.length === 0
                    ? <span className="forge-ok" title="Forge has scripts for every card in this deck">Forge ✓</span>
                    : <span className="forge-bad" title={`Forge doesn't recognise: ${check.missing.join(', ')}`}>Forge: {check.missing.length} unknown card{check.missing.length === 1 ? '' : 's'}</span>)}
                  {check && check.aiWeak.length > 0 && (
                    <span className="forge-weak" title={`Forge's AI doesn't play these well: ${check.aiWeak.join(', ')}`}>AI plays {check.aiWeak.length} poorly</span>
                  )}
                </div>
              </div>
              <div className="deck-actions">
                <button onClick={() => onReport(deck.id)}>Report</button>
                <button onClick={() => setOpen(open === deck.id ? null : deck.id)}>{open === deck.id ? 'Hide' : 'Cards'}</button>
                <button className="danger" onClick={() => confirm(`Remove “${deck.name}”?`) && onRemove(deck.id)}>Remove</button>
              </div>
              {open === deck.id && <DeckDetail deck={deck} check={check} />}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function DeckDetail({ deck, check }: { deck: SimDeck; check: DeckForgeCheck | undefined }) {
  const [onlyFlagged, setOnlyFlagged] = useState(false);
  const statusOf = (name: string) =>
    check?.missing.includes(name) ? 'unknown' : check?.aiWeak.includes(name) ? 'weak' : null;
  const rows = [
    ...deck.commanders.map((card) => ({ card, count: 1, commander: true })),
    ...deck.cards.map((c) => ({ ...c, commander: false })),
  ]
    .filter((r) => !onlyFlagged || statusOf(r.card.name))
    .sort((a, b) => Number(b.commander) - Number(a.commander) || Number(a.card.isLand) - Number(b.card.isLand) || a.card.cmc - b.card.cmc);

  return (
    <div className="deck-detail">
      {check && (
        <label className="muted small">
          <input type="checkbox" checked={onlyFlagged} onChange={(e) => setOnlyFlagged(e.target.checked)} /> Only show cards Forge doesn&apos;t know or plays poorly
        </label>
      )}
      <table>
        <thead>
          <tr><th>#</th><th>Card</th><th>MV</th><th>Forge</th></tr>
        </thead>
        <tbody>
          {rows.map(({ card, count, commander }) => {
            const status = statusOf(card.name);
            return (
              <tr key={card.name} className={status === 'unknown' ? 'unmodeled' : ''}>
                <td>{count}</td>
                <td>
                  {commander && <span className="tag">CMDR</span>} {card.name}
                  <div className="muted small">{card.typeLine}</div>
                </td>
                <td>{card.isLand ? '' : card.cmc}</td>
                <td>
                  {status === 'unknown' && <span className="forge-bad">Not in Forge — left out</span>}
                  {status === 'weak' && <span className="forge-weak">Forge&apos;s AI plays it poorly</span>}
                  {!status && check && <span className="muted">✓</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
