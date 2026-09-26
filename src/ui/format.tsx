// Small presentational helpers shared by several components.

import type { Color, SimDeck } from '../engine/types';

const DECK_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f59f00', '#0c8599', '#e03131', '#5c7cfa', '#66a80f', '#d6336c', '#868e96', '#7048e8'];

/** Stable color per deck, based on its position in the deck list. */
export function deckColor(decks: SimDeck[], id: string): string {
  const i = decks.findIndex((d) => d.id === id);
  return DECK_COLORS[(i === -1 ? 0 : i) % DECK_COLORS.length];
}

export function pct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export function ColorPips({ colors }: { colors: Color[] }) {
  if (!colors.length) return <span className="pip pip-C" title="Colorless">C</span>;
  return (
    <span className="pips">
      {colors.map((c) => (
        <span key={c} className={`pip pip-${c}`} title={c}>
          {c}
        </span>
      ))}
    </span>
  );
}

export function commanderNames(deck: SimDeck): string {
  return deck.commanders.map((c) => c.name).join(' & ');
}
