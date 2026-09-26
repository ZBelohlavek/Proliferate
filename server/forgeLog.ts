// Turns the text log of one Forge simulation into a GameResult.
//
// Forge names players "Ai(1)-<deck name>", "Ai(2)-...", numbered in the
// order the decks were passed on the command line, so seat k maps to
// seats[k - 1]. The lines we rely on look like:
//
//   Turn: Turn 7 (Ai(2)-deck-b)
//   Mulligan: Ai(1)-deck-a has kept a hand of 7 cards
//   Add To Stack: Ai(1)-deck-a cast Xyris, the Writhing Storm
//   Land: Ai(4)-deck-d played Plains (391)
//   Combat: Ai(2)-deck-b assigned Foo (162), Bar (175) to attack Ai(4)-deck-d.
//   Damage: Tyrant's Familiar (175) deals 17 combat damage to Ai(4)-deck-d.
//   Life: Life: Ai(4)-deck-d 40 > -10
//   Game Outcome: Ai(1)-deck-a has lost because life total reached 0
//   Game Outcome: Ai(2)-deck-b has won because all opponents have lost

import type { Elimination, GameResult, LossReason } from '../src/engine/types.ts';

interface LastDamage {
  index: number;
  combat: boolean;
  sourceSeat: number | null;
}

export interface ParsedForgeGame {
  result: GameResult;
  /** Condensed play-by-play for the "watch a game" view. */
  summary: string[];
}

/**
 * @param lines          stdout of one `forge sim` run (one game)
 * @param seats          our deck id for each Forge seat, in command-line order
 * @param commanderNames the commander card names for each seat
 * @param deckNames      display name for each seat (used in the summary)
 */
export function parseForgeLog(lines: string[], seats: string[], commanderNames: string[][], deckNames: string[]): ParsedForgeGame | null {
  const n = seats.length;
  const idRanges: { min: number; max: number }[] = Array.from({ length: n }, () => ({ min: Infinity, max: -Infinity }));
  const noteId = (seat: number, id: number) => {
    const r = idRanges[seat];
    if (!r) return;
    r.min = Math.min(r.min, id);
    r.max = Math.max(r.max, id);
  };

  // Pass 1: learn which card ids belong to which player (ids are handed out in blocks per player).
  for (const line of lines) {
    let m = line.match(/^Land: Ai\((\d+)\)-.* played .* \((\d+)\)$/);
    if (m) {
      noteId(+m[1] - 1, +m[2]);
      continue;
    }
    m = line.match(/^Combat: Ai\((\d+)\)-.*? assigned (.*) to attack /);
    if (m) for (const id of m[2].matchAll(/\((\d+)\)/g)) noteId(+m[1] - 1, +id[1]);
  }
  const seatOfId = (id: number): number | null => {
    let best: number | null = null;
    let bestDistance = Infinity;
    idRanges.forEach((r, seat) => {
      if (r.min === Infinity) return;
      const distance = id < r.min ? r.min - id : id > r.max ? id - r.max : 0;
      if (distance < bestDistance) {
        best = seat;
        bestDistance = distance;
      }
    });
    return best;
  };

  // Pass 2: walk the game.
  let round = 0;
  // Turn order position relative to whoever went first (Forge picks the starting player at random).
  let firstSeat = -1;
  let prevPosition = Infinity;
  const roundAt: number[] = [];
  const commanderRound: (number | null)[] = seats.map(() => null);
  const mulligans = seats.map(() => 0);
  const lastTurnIndex = seats.map(() => -1);
  const lethalIndex: (number | null)[] = seats.map(() => null);
  const lastDamage: (LastDamage | null)[] = seats.map(() => null);
  const lastAttacker: (number | null)[] = seats.map(() => null);
  const outcome: ({ kind: 'won' | 'lost' | 'drew'; because: string } | null)[] = seats.map(() => null);
  let draw = false;
  const summary: string[] = [];
  const pretty = (line: string) => line.replace(/Ai\((\d+)\)-[^\s.,)\]]+/g, (_, k) => `${deckNames[+k - 1] ?? `Player ${k}`} (P${k})`);

  lines.forEach((line, i) => {
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^Turn: Turn (\d+) \(Ai\((\d+)\)-/))) {
      const seat = +m[2] - 1;
      if (firstSeat === -1) firstSeat = seat;
      const position = (seat - firstSeat + n) % n;
      if (position <= prevPosition) round++;
      prevPosition = position;
      lastTurnIndex[seat] = i;
      summary.push(`— Round ${round}, ${deckNames[seat]} (P${seat + 1}) —`);
    } else if ((m = line.match(/^Mulligan: Ai\((\d+)\)-.* has kept a hand of (\d+) cards/))) {
      mulligans[+m[1] - 1] = Math.max(0, 7 - +m[2]);
      summary.push(pretty(line.replace(/^Mulligan: /, '')));
    } else if ((m = line.match(/^Add To Stack: Ai\((\d+)\)-\S* cast (.+?)(?: targeting .*)?$/))) {
      const seat = +m[1] - 1;
      if (commanderRound[seat] === null && commanderNames[seat]?.some((c) => c.split(' // ')[0] === m![2])) commanderRound[seat] = Math.max(round, 1);
      summary.push(pretty(line.replace(/^Add To Stack: /, '')));
    } else if ((m = line.match(/^Add To Stack: Ai\((\d+)\)-\S* activated /))) {
      summary.push(pretty(line.replace(/^Add To Stack: /, '')));
    } else if (line.startsWith('Land: ')) {
      summary.push(pretty(line.replace(/^Land: /, '').replace(/ \(\d+\)$/, '')));
    } else if ((m = line.match(/^Combat: Ai\((\d+)\)-.*? assigned .* to attack Ai\((\d+)\)-/))) {
      lastAttacker[+m[2] - 1] = +m[1] - 1;
      summary.push(pretty(line.replace(/^Combat: /, '').replace(/ \(\d+\)/g, '')));
    } else if ((m = line.match(/^Damage: .*? \((\d+)\) deals (\d+) (combat )?damage to Ai\((\d+)\)-/))) {
      const target = +m[4] - 1;
      const combat = !!m[3];
      lastDamage[target] = { index: i, combat, sourceSeat: combat ? (lastAttacker[target] ?? seatOfId(+m[1])) : seatOfId(+m[1]) };
    } else if ((m = line.match(/^Life: Life: Ai\((\d+)\)-.* (-?\d+) > (-?\d+)\s*$/))) {
      const seat = +m[1] - 1;
      const after = +m[3];
      lethalIndex[seat] = after <= 0 ? (lethalIndex[seat] ?? i) : null;
      summary.push(pretty(line.replace(/^Life: Life: /, '').replace(/ (-?\d+) > (-?\d+)\s*$/, ': life $1 → $2')));
    } else if ((m = line.match(/^Game Outcome: Ai\((\d+)\)-.* has (won|lost|drawn|conceded)(?: because (.*))?/))) {
      const kind = m[2] === 'won' ? 'won' : m[2] === 'drawn' ? 'drew' : 'lost';
      outcome[+m[1] - 1] = { kind, because: (m[3] ?? m[2]).toLowerCase() };
      summary.push(pretty(line.replace(/^Game Outcome: /, '')));
    } else if (/^Game Result: .*\b(draw|drawn)\b/i.test(line)) {
      draw = true;
    }
    roundAt[i] = round;
  });

  if (outcome.every((o) => o === null)) return null;

  // Order the losers by when they died.
  const losers: { seat: number; index: number; reason: LossReason; killer: number | null }[] = [];
  outcome.forEach((o, seat) => {
    if (!o || o.kind !== 'lost') return;
    const damage = lastDamage[seat];
    let reason: LossReason;
    if (/commander/.test(o.because)) reason = 'commander';
    else if (/draw|library|mill/.test(o.because)) reason = 'decked';
    else if (/life/.test(o.because) && damage && lethalIndex[seat] !== null && lethalIndex[seat]! - damage.index <= 3) reason = damage.combat ? 'combat' : 'noncombat';
    else reason = 'noncombat';

    const index = lethalIndex[seat] ?? damage?.index ?? lastTurnIndex[seat] + 0.5;
    let killer: number | null = null;
    if (reason === 'commander' || reason === 'combat') killer = damage?.sourceSeat ?? lastAttacker[seat];
    else if (reason === 'noncombat' && damage && index - damage.index <= 40) killer = damage.sourceSeat;
    if (killer === seat) killer = null;
    losers.push({ seat, index, reason, killer });
  });
  losers.sort((a, b) => a.index - b.index);

  const placements = seats.map(() => 0);
  const eliminations: Elimination[] = [];
  losers.forEach((l, i) => {
    const tiedWithPrevious = i > 0 && losers[i - 1].index === l.index;
    placements[l.seat] = tiedWithPrevious ? placements[losers[i - 1].seat] : n - i;
    eliminations.push({ seat: l.seat, round: roundAt[Math.floor(l.index)] ?? round, reason: l.reason, killer: l.killer });
  });

  const survivors = seats.map((_, s) => s).filter((s) => !losers.some((l) => l.seat === s));
  let winner: number | null = null;
  if (!draw && survivors.length === 1 && outcome[survivors[0]]?.kind === 'won') {
    winner = survivors[0];
    placements[winner] = 1;
  } else {
    const shared = (1 + survivors.length) / 2;
    for (const s of survivors) {
      placements[s] = shared;
      eliminations.push({ seat: s, round, reason: 'timeout', killer: null });
    }
  }

  return {
    result: { seats, winner, placements, rounds: round, eliminations, commanderRound, mulligans },
    summary,
  };
}
