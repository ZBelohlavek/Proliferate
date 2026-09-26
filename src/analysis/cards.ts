// Per-card performance: how does a deck do in games where a card shows up?
//
// Quick engine: we record which cards the shuffle put in the opening hand or
// the next 8 library cards. That's pure luck, so comparing the deck's finish
// score in games where a card started "early" against games where it didn't is
// a fair test of the card. (Comparing games where a card was *drawn* is not:
// decks that survive longer draw more cards, so every card looks good.)
//
// Forge: its logs don't reveal draws, only what was cast. "When cast" is
// weaker evidence — cards get cast more in longer games and when you're
// already ahead — so the page labels it clearly.

import type { SimCard, SimDeck } from '../engine/types';
import type { Stats } from '../sim/stats';

export type Basis = 'early' | 'cast';
export type Verdict = 'weak' | 'strong' | 'dead' | 'neutral' | 'unknown';

export interface CardPerformance {
  name: string;
  card: SimCard;
  count: number;
  /** Games where the card started early in the deck (or was cast, for Forge). */
  seen: number;
  /** Finish-score difference, seen vs not seen, in percentage points. null = not enough data. */
  impact: number | null;
  /** 95% margin of error on `impact`. */
  margin: number | null;
  /** Share of games where the card was cast after being drawn (quick engine only). */
  castRate: number | null;
  verdict: Verdict;
}

export interface CardReport {
  basis: Basis;
  games: number;
  rows: CardPerformance[];
  /** Why the report can't be trusted yet, if applicable. */
  notice: string | null;
}

const MIN_SAMPLES = 30;

export function cardReport(stats: Stats, deck: SimDeck, basis: Basis): CardReport {
  const d = stats.decks[deck.id];
  const perCard = stats.cards?.[deck.id] ?? {};
  const games = d?.games ?? 0;
  const scoreSum = d?.scoreSum ?? 0;
  const mean = games ? scoreSum / games : 0;
  const variance = games ? Math.max(0.01, (d?.scoreSqSum ?? 0) / games - mean * mean) : 0;

  const rows: CardPerformance[] = deck.cards.map(({ card, count }) => {
    const s = perCard[card.name];
    const seen = s ? (basis === 'early' ? s.early ?? 0 : s.cast) : 0;
    const seenScore = s ? (basis === 'early' ? s.earlyScore ?? 0 : s.castScore) : 0;
    const unseen = games - seen;

    let impact: number | null = null;
    let margin: number | null = null;
    if (seen >= MIN_SAMPLES && unseen >= MIN_SAMPLES) {
      impact = (seenScore / seen - (scoreSum - seenScore) / unseen) * 100;
      margin = 1.96 * Math.sqrt(variance * (1 / seen + 1 / unseen)) * 100;
    }
    const castRate = basis === 'early' && s && s.drawn >= MIN_SAMPLES ? s.drawnAndCast / s.drawn : null;

    let verdict: Verdict = 'unknown';
    if (impact !== null && margin !== null) {
      if (impact + margin < 0) verdict = 'weak';
      else if (impact - margin > 0) verdict = 'strong';
      else verdict = 'neutral';
    }
    // Spells that sit in hand most of the time are "dead", whatever their impact.
    const reactive = card.effects.length > 0 && card.effects.every((e) => e.kind === 'counter' || e.kind === 'pump' || e.kind === 'protect');
    if (castRate !== null && castRate < 0.35 && !card.isLand && !reactive && verdict !== 'strong') verdict = 'dead';

    return { name: card.name, card, count, seen, impact, margin, castRate, verdict };
  });

  let notice: string | null = null;
  if (!games) notice = 'No games yet — run some simulations first.';
  else if (!stats.cards?.[deck.id] || (basis === 'early' && !Object.values(stats.cards[deck.id]).some((c) => c.early))) {
    notice = 'These results were recorded before card tracking existed. Reset results and simulate again to get card data.';
  }
  else if (games < 400) notice = `Only ${games} games so far. Card impacts need a few hundred games (ideally thousands) before they mean much.`;

  return { basis, games, rows, notice };
}
