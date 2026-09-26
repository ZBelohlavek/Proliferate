import { useEffect, useState } from 'react';
import type { SimDeck } from '../engine/types';
import { cacheBracketData, cachedBracketData, fetchBracketData, type BracketData } from '../analysis/bracket';

export interface BracketState {
  data: BracketData | null;
  loading: boolean;
  error: string | null;
}

/** Loads Commander Spellbook bracket data for each deck (cached in localStorage). */
export function useBracketData(decks: SimDeck[]): { states: Record<string, BracketState>; refresh: (deck: SimDeck) => void } {
  const [states, setStates] = useState<Record<string, BracketState>>({});
  const [version, setVersion] = useState(0);
  const key = decks.map((d) => `${d.id}@${d.importedAt}`).join('|');

  useEffect(() => {
    let cancelled = false;
    for (const deck of decks) {
      const cached = cachedBracketData(deck);
      if (cached) {
        setStates((s) => ({ ...s, [deck.id]: { data: cached, loading: false, error: null } }));
        continue;
      }
      setStates((s) => ({ ...s, [deck.id]: { data: s[deck.id]?.data ?? null, loading: true, error: null } }));
      fetchBracketData(deck)
        .then((data) => {
          cacheBracketData(deck, data);
          if (!cancelled) setStates((s) => ({ ...s, [deck.id]: { data, loading: false, error: null } }));
        })
        .catch((err: Error) => {
          if (!cancelled) setStates((s) => ({ ...s, [deck.id]: { data: null, loading: false, error: err.message } }));
        });
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  const refresh = (deck: SimDeck) => {
    try {
      localStorage.removeItem(`proliferate.bracket.v1.${deck.id}`);
    } catch {
      /* ignore */
    }
    setVersion((v) => v + 1);
  };
  return { states, refresh };
}
