import { describe, expect, it } from 'vitest';
import { parseArchidektId } from '../src/import/archidekt';
import { parseDecklist } from '../src/import/text';

describe('parseArchidektId', () => {
  it('accepts deck URLs and bare ids', () => {
    expect(parseArchidektId('https://archidekt.com/decks/7031486/buffs_by_hans')).toBe('7031486');
    expect(parseArchidektId('archidekt.com/decks/42')).toBe('42');
    expect(parseArchidektId(' 123 ')).toBe('123');
    expect(parseArchidektId('https://moxfield.com/decks/abc')).toBeNull();
  });
});

describe('parseDecklist', () => {
  it('reads Archidekt exports with categories', () => {
    const lines = parseDecklist('1x Xyris, the Writhing Storm (c21) 1 [Commander{top}]\n1x Sol Ring (cmm) 410 [Ramp]\n15x Wastes (cmm) 1056 [Land]\n1x Maybe Card (abc) 1 [Maybeboard{noDeck}{noPrice}]');
    expect(lines).toEqual([
      { name: 'Xyris, the Writhing Storm', count: 1, isCommander: true },
      { name: 'Sol Ring', count: 1, isCommander: false },
      { name: 'Wastes', count: 15, isCommander: false },
    ]);
  });

  it('reads section headers and *CMDR* markers', () => {
    const lines = parseDecklist('Commander\n1 Atraxa, Praetors\' Voice\n\nDeck\n1 Sol Ring\n\nSideboard\n1 Swords to Plowshares');
    expect(lines).toEqual([
      { name: "Atraxa, Praetors' Voice", count: 1, isCommander: true },
      { name: 'Sol Ring', count: 1, isCommander: false },
    ]);
    expect(parseDecklist('1 Kenrith, the Returned King *CMDR*')[0]).toMatchObject({ name: 'Kenrith, the Returned King', isCommander: true });
  });
});
