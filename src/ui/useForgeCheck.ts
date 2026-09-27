import { useEffect, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { toForgeDeck } from '../sim/forgeController';

/**
 * Asks the Forge backend which cards in each deck it doesn't have scripts
 * for. Returns deck id -> unknown card names, or null while unavailable.
 */
export function useForgeCheck(decks: SimDeck[], forgeAvailable: boolean): Record<string, string[]> | null {
  const [missing, setMissing] = useState<Record<string, string[]> | null>(null);
  const key = decks.map((d) => `${d.id}@${d.importedAt}`).join('|');

  useEffect(() => {
    if (!forgeAvailable || !decks.length) {
      setMissing(null);
      return;
    }
    let cancelled = false;
    fetch('/api/forge/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decks: decks.map(toForgeDeck) }),
    })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((rows: { deckId: string; missing: string[] }[]) => {
        if (!cancelled) setMissing(Object.fromEntries(rows.map((r) => [r.deckId, r.missing])));
      })
      .catch(() => {
        if (!cancelled) setMissing(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, forgeAvailable]);

  return missing;
}
