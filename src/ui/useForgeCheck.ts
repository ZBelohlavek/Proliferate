import { useEffect, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { toForgeDeck } from '../sim/forgeController';

export interface DeckForgeCheck {
  /** Cards Forge has no script for; they're left out of Forge games. */
  missing: string[];
  /** Cards Forge's developers mark as ones its AI can't play well. */
  aiWeak: string[];
}

/**
 * Asks the Forge backend about each deck's cards. Returns deck id -> check,
 * or null while Forge is unavailable.
 */
export function useForgeCheck(decks: SimDeck[], forgeAvailable: boolean): Record<string, DeckForgeCheck> | null {
  const [result, setResult] = useState<Record<string, DeckForgeCheck> | null>(null);
  const key = decks.map((d) => `${d.id}@${d.importedAt}`).join('|');

  useEffect(() => {
    if (!forgeAvailable || !decks.length) {
      setResult(null);
      return;
    }
    let cancelled = false;
    fetch('/api/forge/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decks: decks.map(toForgeDeck) }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((rows: { deckId: string; missing: string[]; aiWeak?: string[] }[]) => {
        if (!cancelled) setResult(Object.fromEntries(rows.map((r) => [r.deckId, { missing: r.missing, aiWeak: r.aiWeak ?? [] }])));
      })
      .catch(() => {
        if (!cancelled) setResult(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, forgeAvailable]);

  return result;
}
