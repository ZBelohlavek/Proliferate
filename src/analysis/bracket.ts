// Estimates a deck's Commander Bracket (Wizards of the Coast, beta).
//
// Official rules as of the February 2026 update
// (https://magic.wizards.com/en/formats/commander#brackets):
//   * Game Changers: Brackets 1–2 allow none, Bracket 3 up to three,
//     Brackets 4–5 any number. This is the one hard rule.
//   * Barometers: two-card infinite combos, extra turns and mass land denial,
//     now framed by how many turns you should expect before winning or losing:
//     B1 9+, B2 8+, B3 6+, B4 4+, B5 any.
//   * Bracket 1 is about theme, not power, so it can't be detected from a list.
//
// Card flags and combos come from Commander Spellbook's estimate-bracket API
// (https://commanderspellbook.com), which tracks the current Game Changers
// list and every known combo. Speed comes from Forge (full-rules) games.

import type { SimDeck } from '../engine/types';
import type { DeckStats } from '../sim/stats';

export interface BracketCombo {
  cards: string[];
  twoCard: boolean;
  /** Commander Spellbook's own tag for the combo. */
  tag: string;
  results: string[];
  massLandDenial: boolean;
  extraTurn: boolean;
  lock: boolean;
  /** Total mana value of the pieces. */
  manaValue: number;
}

export interface BracketData {
  fetchedAt: number;
  /** Commander Spellbook's overall tag for the deck (their scale, not the official one). */
  spellbookTag: string;
  gameChangers: string[];
  massLandDenial: string[];
  extraTurns: string[];
  combos: BracketCombo[];
}

export interface BracketReason {
  /** The lowest bracket this finding allows. */
  floor: number;
  text: string;
}

export interface BracketEstimate {
  bracket: number;
  /** Caveat shown under the number, e.g. "or 1 if theme-first". */
  note: string | null;
  reasons: BracketReason[];
  /** Speed evidence from Forge games, if there was enough. */
  speed: { wins: number; medianRound: number; byRound6: number; byRound8: number } | null;
}

export const BRACKET_NAMES: Record<number, string> = { 1: 'Exhibition', 2: 'Core', 3: 'Upgraded', 4: 'Optimized', 5: 'cEDH' };

const SPELLBOOK_TAGS: Record<string, string> = { R: 'Ruthless', S: 'Spicy', P: 'Powerful', O: 'Oddball', C: 'Core', E: 'Exhibition', B: 'Banned' };

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function fetchBracketData(deck: SimDeck): Promise<BracketData> {
  const body = {
    commanders: deck.commanders.map((c) => ({ card: c.name, quantity: 1 })),
    main: deck.cards.map((c) => ({ card: c.card.name, quantity: c.count })),
  };
  const res = await fetch('https://backend.commanderspellbook.com/estimate-bracket', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Commander Spellbook request failed (HTTP ${res.status}).`);
  const data: any = await res.json();

  const mvOf = new Map<string, number>();
  for (const c of [...deck.commanders, ...deck.cards.map((e) => e.card)]) {
    mvOf.set(c.name, c.cmc);
    mvOf.set(c.name.split(' // ')[0], c.cmc);
  }
  const names = (pred: (c: any) => boolean) => (data.cards ?? []).filter(pred).map((c: any) => c.card.name as string);

  return {
    fetchedAt: Date.now(),
    spellbookTag: SPELLBOOK_TAGS[data.bracketTag] ?? data.bracketTag ?? '?',
    gameChangers: names((c) => c.gameChanger),
    massLandDenial: names((c) => c.massLandDenial),
    extraTurns: names((c) => c.extraTurn),
    combos: (data.combos ?? [])
      .filter((v: any) => v.relevant)
      .map((v: any) => {
        const cards: string[] = (v.combo?.uses ?? []).map((u: any) => u.card.name);
        return {
          cards,
          twoCard: !!(v.definitelyTwoCard || v.arguablyTwoCard),
          tag: SPELLBOOK_TAGS[v.combo?.bracketTag] ?? '',
          results: (v.combo?.produces ?? []).map((p: any) => p.feature?.name).filter(Boolean),
          massLandDenial: !!v.massLandDenial,
          extraTurn: !!v.extraTurn,
          lock: !!(v.lock || v.skipTurns || v.controlAllOpponents),
          manaValue: cards.reduce((s, n) => s + (mvOf.get(n) ?? mvOf.get(n.split(' // ')[0]) ?? 0), 0),
        } satisfies BracketCombo;
      }),
  };
}

/** Rounds at which the deck won, from Forge results (full rules, so turn counts are meaningful). */
function speedEvidence(forge: DeckStats | undefined): BracketEstimate['speed'] {
  const byRound = forge?.winRounds;
  if (!byRound) return null;
  const rounds: number[] = [];
  byRound.forEach((count, round) => {
    for (let i = 0; i < (count ?? 0); i++) rounds.push(round);
  });
  if (rounds.length < 8) return null;
  rounds.sort((a, b) => a - b);
  const share = (limit: number) => rounds.filter((r) => r <= limit).length / rounds.length;
  return { wins: rounds.length, medianRound: rounds[Math.floor(rounds.length / 2)], byRound6: share(6), byRound8: share(8) };
}

export function estimateBracket(data: BracketData, forge?: DeckStats): BracketEstimate {
  const reasons: BracketReason[] = [];
  const list = (xs: string[]) => (xs.length > 4 ? `${xs.slice(0, 4).join(', ')} and ${xs.length - 4} more` : xs.join(', '));

  // Hard rule: Game Changers.
  const gc = data.gameChangers.length;
  if (gc >= 4) reasons.push({ floor: 4, text: `${gc} Game Changers (${list(data.gameChangers)}) — more than three means Bracket 4 or higher.` });
  else if (gc >= 1) reasons.push({ floor: 3, text: `${gc} Game Changer${gc > 1 ? 's' : ''} (${list(data.gameChangers)}) — any Game Changer means Bracket 3 or higher; three is the Bracket 3 limit.` });
  else reasons.push({ floor: 1, text: 'No Game Changers, so Brackets 1–2 are possible.' });

  // Barometers.
  if (data.massLandDenial.length) {
    reasons.push({ floor: 4, text: `Mass land denial (${list(data.massLandDenial)}) — not expected below Bracket 4.` });
  }
  const turnCombo = data.combos.find((c) => c.extraTurn);
  if (turnCombo) reasons.push({ floor: 4, text: `Repeatable extra turns: ${turnCombo.cards.join(' + ')}.` });
  else if (data.extraTurns.length >= 3) reasons.push({ floor: 3, text: `${data.extraTurns.length} extra-turn cards (${list(data.extraTurns)}) — chaining extra turns doesn't fit Brackets 1–2.` });
  else if (data.extraTurns.length) reasons.push({ floor: 1, text: `Extra-turn card${data.extraTurns.length > 1 ? 's' : ''} (${list(data.extraTurns)}) — fine on its own as long as they aren't chained.` });

  const lock = data.combos.find((c) => c.lock || c.massLandDenial);
  if (lock) reasons.push({ floor: 4, text: `Lock / land-denial combo: ${lock.cards.join(' + ')}.` });

  const twoCard = data.combos.filter((c) => c.twoCard);
  if (twoCard.length) {
    const fast = twoCard.filter((c) => c.manaValue <= 6 || c.tag === 'Ruthless');
    if (fast.length) {
      const c = fast[0];
      reasons.push({ floor: 4, text: `Fast two-card combo: ${c.cards.join(' + ')} (${c.manaValue} mana total${c.results.length ? `, ${c.results.slice(0, 2).join(', ')}` : ''}) — can end games before turn six.` });
    } else {
      const c = twoCard[0];
      reasons.push({ floor: 3, text: `Two-card combo: ${c.cards.join(' + ')} (${c.manaValue} mana total) — game-ending combos aren't expected in Brackets 1–2.` });
    }
  }
  const multiCard = data.combos.filter((c) => !c.twoCard);
  if (multiCard.length) reasons.push({ floor: 1, text: `${multiCard.length} combo${multiCard.length > 1 ? 's' : ''} needing three or more pieces (e.g. ${multiCard[0].cards.join(' + ')}).` });

  // Speed, from full-rules games.
  const speed = speedEvidence(forge);
  if (speed) {
    if (speed.byRound6 >= 0.25) reasons.push({ floor: 4, text: `Wins by round 6 in ${Math.round(speed.byRound6 * 100)}% of its Forge wins — Bracket 3 expects at least six turns.` });
    else if (speed.byRound8 >= 0.25) reasons.push({ floor: 3, text: `Wins by round 8 in ${Math.round(speed.byRound8 * 100)}% of its Forge wins — Brackets 1–2 expect eight or more turns.` });
    else reasons.push({ floor: 1, text: `Median Forge win in round ${speed.medianRound} — pace fits the lower brackets.` });
  }

  const bracket = Math.max(2, ...reasons.map((r) => r.floor));
  let note: string | null = null;
  if (bracket === 2) note = 'or 1 if theme-first';
  if (bracket === 4 && speed && speed.medianRound <= 4) note = 'maybe 5 (cEDH speed)';
  return { bracket, note, reasons: reasons.sort((a, b) => b.floor - a.floor), speed };
}

const CACHE_PREFIX = 'proliferate.bracket.v1.';

export function cachedBracketData(deck: SimDeck): BracketData | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + deck.id);
    if (!raw) return null;
    const { importedAt, data } = JSON.parse(raw);
    // Re-check after re-imports and weekly (the Game Changers list changes).
    if (importedAt !== deck.importedAt || Date.now() - data.fetchedAt > 7 * 86_400_000) return null;
    return data;
  } catch {
    return null;
  }
}

export function cacheBracketData(deck: SimDeck, data: BracketData) {
  try {
    localStorage.setItem(CACHE_PREFIX + deck.id, JSON.stringify({ importedAt: deck.importedAt, data }));
  } catch {
    /* storage full: we'll just fetch again next time */
  }
}
