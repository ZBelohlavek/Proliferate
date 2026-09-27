import { describe, expect, it } from 'vitest';
import { matchSearch } from '../src/import/search';
import { stompyDeck } from './helpers';

describe('deck search', () => {
  const deck = stompyDeck('x');
  it('matches everything on an empty search', () => expect(matchSearch(deck, '  ')).toBe(''));
  it('matches deck names and commanders without a note', () => {
    expect(matchSearch(deck, 'deck x')).toBe('');
    expect(matchSearch(deck, 'COMMANDER')).toBe('');
  });
  it('matches cards and says which one', () => expect(matchSearch(deck, 'wurm')).toBe('contains Craw Wurm'));
  it('rejects decks without a match', () => expect(matchSearch(deck, 'sol ring')).toBeNull());
});
