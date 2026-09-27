// Per-card performance from Forge games.
//
// Forge's logs show which cards each player cast (and which lands they
// played), but not what they drew. Comparing games where a card was cast
// against games where it wasn't is biased: decks that survive longer cast
// more cards, so almost every card looks good in absolute terms. We therefore
// report each card *relative to the rest of the same deck* — its impact minus
// the deck's median card impact. That cancels the shared bias and answers
// the useful question: which cards pull their weight compared to your others?

import type { SimCard, SimDeck } from '../engine/types';
import type { Stats } from '../sim/stats';

export type Verdict = 'weak' | 'strong' | 'neutral' | 'unknown';

export interface CardPerformance {
  name: string;
  card: SimCard;
  count: number;
  /** Games where this deck cast (or, for lands, played) the card. */
  seen: number;
  /** Finish-score difference vs. the deck's typical card, in points. null = not enough data. */
  impact: number | null;
  /** 95% margin of error on `impact`. */
  margin: number | null;
  verdict: Verdict;
}

export interface CardReport {
  games: number;
  rows: CardPerformance[];
  /** Why the report can't be trusted yet, if applicable. */
  notice: string | null;
}

const MIN_SAMPLES = 30;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function cardReport(stats: Stats, deck: SimDeck): CardReport {
  const d = stats.decks[deck.id];
  const perCard = stats.cards?.[deck.id] ?? {};
  const games = d?.games ?? 0;
  const scoreSum = d?.scoreSum ?? 0;
  const mean = games ? scoreSum / games : 0;
  const variance = games ? Math.max(0.01, (d?.scoreSqSum ?? 0) / games - mean * mean) : 0;

  // Raw difference in finish score (0–100) between games with and without the card cast.
  const raw = deck.cards.map(({ card, count }) => {
    const s = perCard[card.name];
    const seen = s?.cast ?? 0;
    const seenScore = s?.castScore ?? 0;
    const unseen = games - seen;
    let impact: number | null = null;
    let margin: number | null = null;
    if (seen >= MIN_SAMPLES && unseen >= MIN_SAMPLES) {
      impact = (seenScore / seen - (scoreSum - seenScore) / unseen) * 100;
      margin = 1.96 * Math.sqrt(variance * (1 / seen + 1 / unseen)) * 100;
    }
    return { card, count, seen, impact, margin };
  });

  // The deck's typical card (median over non-land cards with enough data) is the zero point.
  const spellImpacts = raw.filter((r) => !r.card.isLand && r.impact !== null).map((r) => r.impact!);
  const baseline = spellImpacts.length >= 5 ? median(spellImpacts) : 0;

  const rows: CardPerformance[] = raw.map((r) => {
    const impact = r.impact === null ? null : r.impact - baseline;
    let verdict: Verdict = 'unknown';
    if (impact !== null && r.margin !== null) {
      if (impact + r.margin < 0) verdict = 'weak';
      else if (impact - r.margin > 0) verdict = 'strong';
      else verdict = 'neutral';
    }
    return { name: r.card.name, card: r.card, count: r.count, seen: r.seen, impact, margin: r.margin, verdict };
  });

  let notice: string | null = null;
  if (!games) notice = 'No games yet — run some simulations first.';
  else if (!stats.cards?.[deck.id]) notice = 'These results were recorded before card tracking existed. Reset results and simulate again to get card data.';
  else if (games < 200) notice = `Only ${games} games so far. Card numbers need a couple of hundred games before they mean much.`;

  return { games, rows, notice };
}
