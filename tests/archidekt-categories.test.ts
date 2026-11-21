import { describe, expect, it } from 'vitest';
import { entryInDeck } from '../src/import/archidekt';

describe('Archidekt categories', () => {
  const excluded = new Set(['Maybeboard']);
  it('keeps ordinary cards and commanders', () => {
    expect(entryInDeck(['Removal'], excluded)).toBe(true);
    expect(entryInDeck(['Commander'], excluded)).toBe(true);
    expect(entryInDeck([], excluded)).toBe(true);
  });
  it('skips the sideboard even when Archidekt flags it as included', () => {
    // One for all / Not As Mean Orvar: "Sideboard" has includedInDeck=true, cards are "Sideboard/Instant".
    expect(entryInDeck(['Sideboard', 'Instant'], excluded)).toBe(false);
    expect(entryInDeck(['Draw', 'Sideboard'], excluded)).toBe(false);
  });
  it('skips the maybeboard wherever it is tagged', () => {
    expect(entryInDeck(['Maybeboard', 'Ramp'], excluded)).toBe(false);
    expect(entryInDeck(['Ramp', 'Maybeboard'], excluded)).toBe(false);
  });
  it('decides by the primary category for custom excluded categories', () => {
    const custom = new Set(['Upgrades']);
    expect(entryInDeck(['Upgrades', 'Ramp'], custom)).toBe(false);
    expect(entryInDeck(['Ramp', 'Upgrades'], custom)).toBe(true);
  });
});
