import { describe, expect, it } from 'vitest';
import { forgeSlug } from '../server/forgeCards';
import { parseForgeGames, parseForgeLog } from '../server/forgeLog';

describe('forgeSlug', () => {
  it('matches Forge card file names', () => {
    expect(forgeSlug("Y'shtola, Night's Blessed")).toBe('yshtola_nights_blessed');
    expect(forgeSlug('Khalni Ambush // Khalni Territory')).toBe('khalni_ambush_khalni_territory');
    expect(forgeSlug('Lim-Dûl the Necromancer')).toBe('lim_dul_the_necromancer');
  });
});

// A trimmed 3-player game in Forge's real log format.
const LOG = `
Simulation mode
Mulligan: Ai(1)-P-a has kept a hand of 7 cards
Mulligan: Ai(2)-P-b has mulliganed down to 7 cards.
Mulligan: Ai(2)-P-b has mulliganed down to 6 cards.
Mulligan: Ai(2)-P-b has kept a hand of 6 cards
Mulligan: Ai(3)-P-c has kept a hand of 7 cards
Turn: Turn 1 (Ai(1)-P-a)
Land: Ai(1)-P-a played Forest (12)
Turn: Turn 2 (Ai(2)-P-b)
Land: Ai(2)-P-b played Island (140)
Turn: Turn 3 (Ai(3)-P-c)
Land: Ai(3)-P-c played Swamp (230)
Turn: Turn 4 (Ai(1)-P-a)
Add To Stack: Ai(1)-P-a cast Commander A
Turn: Turn 5 (Ai(2)-P-b)
Turn: Turn 6 (Ai(3)-P-c)
Add To Stack: Ai(3)-P-c cast Exsanguinate
Life: Life: Ai(2)-P-b 5 > 0
Life: Life: Ai(1)-P-a 40 > 35
Turn: Turn 7 (Ai(1)-P-a)
Combat: Ai(1)-P-a assigned Commander A (15), Bear (20) to attack Ai(3)-P-c.
Damage: Commander A (15) deals 30 combat damage to Ai(3)-P-c.
Life: Life: Ai(3)-P-c 30 > 0
Game Outcome: Turn 7
Game Outcome: Ai(1)-P-a has won because all opponents have lost
Game Outcome: Ai(2)-P-b has lost because life total reached 0
Game Outcome: Ai(3)-P-c has lost because life total reached 0
Game Result: Game 1 ended in 1234 ms. Ai(1)-P-a has won!
`.trim().split('\n');

describe('parseForgeLog', () => {
  it('turns a Forge log into a GameResult', () => {
    const parsed = parseForgeLog(LOG, ['a', 'b', 'c'], [['Commander A'], ['Commander B'], ['Commander C']], ['Deck A', 'Deck B', 'Deck C']);
    expect(parsed).not.toBeNull();
    const r = parsed!.result;
    expect(r.winner).toBe(0);
    expect(r.rounds).toBe(3);
    expect(r.placements).toEqual([1, 3, 2]); // b died first, then c
    expect(r.mulligans).toEqual([0, 2, 0]); // a free mulligan to 7, then one to 6
    expect(r.commanderRound).toEqual([2, null, null]);
    expect(r.eliminations).toEqual([
      { seat: 1, round: 2, reason: 'noncombat', killer: null },
      { seat: 2, round: 3, reason: 'combat', killer: 0 },
    ]);
    expect(parsed!.summary).toContain('Deck A (P1) cast Commander A');
  });

  it('counts rounds from whoever went first', () => {
    const turns = [
      'Turn: Turn 1 (Ai(3)-P-c)', 'Turn: Turn 2 (Ai(1)-P-a)', 'Turn: Turn 3 (Ai(2)-P-b)', // round 1
      'Turn: Turn 4 (Ai(3)-P-c)', 'Turn: Turn 5 (Ai(1)-P-a)', // round 2
      'Game Outcome: Ai(1)-P-a has won because all opponents have lost',
      'Game Outcome: Ai(2)-P-b has lost because life total reached 0',
      'Game Outcome: Ai(3)-P-c has lost because life total reached 0',
    ];
    const parsed = parseForgeLog(turns, ['a', 'b', 'c'], [[], [], []], ['A', 'B', 'C'])!;
    expect(parsed.result.rounds).toBe(2);
    expect(parsed.summary.filter((l) => l.startsWith('—'))).toEqual([
      '— Round 1, C (P3) —', '— Round 1, A (P1) —', '— Round 1, B (P2) —', '— Round 2, C (P3) —', '— Round 2, A (P1) —',
    ]);
  });

  it('treats a game with no outcome as a failure', () => {
    expect(parseForgeLog(['Simulation mode', 'Could not load deck - x.dck, match cannot start'], ['a', 'b'], [[], []], ['A', 'B'])).toBeNull();
  });

  it('records draws when the clock runs out', () => {
    const drawn = [
      'Turn: Turn 1 (Ai(1)-P-a)',
      'Turn: Turn 2 (Ai(2)-P-b)',
      'Game Outcome: Ai(1)-P-a has drawn because the game was a draw',
      'Game Outcome: Ai(2)-P-b has drawn because the game was a draw',
      'Game Result: Game 1 ended in a draw!',
    ];
    const r = parseForgeLog(drawn, ['a', 'b'], [[], []], ['A', 'B'])!.result;
    expect(r.winner).toBeNull();
    expect(r.placements).toEqual([1.5, 1.5]);
  });
});

describe('parseForgeGames', () => {
  it('splits a multi-game log at each Game Result line', () => {
    const two = [...LOG, ...LOG.map((l) => l.replace('Game 1 ended', 'Game 2 ended'))];
    const games = parseForgeGames(two, ['a', 'b', 'c'], [[], [], []], ['A', 'B', 'C']);
    expect(games).toHaveLength(2);
    expect(games.every((g) => g.result.winner === 0)).toBe(true);
  });
  it('ignores a game cut off before its result', () => {
    const cut = [...LOG, 'Turn: Turn 1 (Ai(1)-P-a)', 'Land: Ai(1)-P-a played Forest (12)'];
    expect(parseForgeGames(cut, ['a', 'b', 'c'], [[], [], []], ['A', 'B', 'C'])).toHaveLength(1);
  });
});
