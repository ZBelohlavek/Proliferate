// Planeswalker ultimates and emblems, Saga chapters, Rooms, extra turns and
// phases, mutate triggers, and Food, Blood and Incubator tokens, for the card reader.
//
// classify.ts calls in here:
// - rewriteEmblems(text, name) once on the whole text.
// - emblemTrigger(line) for trigger and ability wordings classify.ts has no rule for.
// - emblemCost(costText) for activation costs that sacrifice Foods or artifacts.
// - recogniseEmblems(sentence, out, fullLine, readEmblem) on every sentence.

import type { EffectBody, Trigger } from './types';

type Found = { body: EffectBody; note: string; chance?: number };
type EmblemContext = { when: Trigger; body: string; castFilter?: 'any'; loyalty?: number; loyaltyX?: boolean; xTimes?: number; scope?: 'self' | 'any' };

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, x: -1, 'that many': -1 };
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w.trim()) ? parseInt(w, 10) : WORDS[w.trim()] ?? fallback);

/** Static effect kinds this file adds (classify.ts keeps them on a permanent's static lines). */
export const EMBLEM_STATIC_KINDS = ['unlockDiscount', 'pwAbilities'];

/** Activation costs: "sacrifice a Food", "sacrifice two Foods", "sacrifice five artifacts". */
export const EMBLEM_COST = 'sacrifice (?:a|an|one|two|three|four|five) foods?|sacrifice (?:two|three|four|five) artifacts';

export function emblemCost(costText: string): { what: 'food' | 'artifact'; n: number } | undefined {
  const m = costText.match(/sacrifice (a|an|one|two|three|four|five) (foods?|artifacts)/);
  return m ? { what: m[2].startsWith('food') ? 'food' : 'artifact', n: count(m[1], 1) } : undefined;
}

/**
 * Whole-text rewrites:
 * - A legendary card's short name ("Medomai", "Elanor") is its own name: "~".
 * - "Eerie — " is an ability word; what follows is two triggers.
 */
export function rewriteEmblems(text: string, name: string, legendary: boolean): string {
  const first = name.toLowerCase().split(/[ ,]/)[0];
  if (legendary && first.length > 3 && /^[a-z]+$/.test(first) && !['lord', 'lady', 'king', 'queen', 'captain', 'professor'].includes(first) && !name.includes(',')) {
    text = text.replace(new RegExp(`(?<!\\b(?:a|an|another|each|target|that|other|enchanted|equipped) )\\b${first}\\b(?= (?:deals|enters|attacks|can't|dies|gets|has|is)\\b)`, 'g'), '~');
  }
  return text
    .replace(/^eerie — /m, '')
    // Tezzeret, Cruel Captain's emblem: the counters go on an artifact, which becomes a creature if it wasn't one (≈ a creature).
    .replace(/put (\w+) \+1\/\+1 counters on target artifact you control\. if it's not a creature, it becomes a 0\/0 robot artifact creature\./, 'put $1 +1/+1 counters on target creature you control.')
    // Liliana of the Dark Realms' emblem: Swamps tap for four black mana (≈ six extra mana each turn).
    .replace(/swamps you control have '\{t\}: add \{b\}\{b\}\{b\}\{b\}\.'/, 'at the beginning of your upkeep, create six treasure tokens.')
    // Smaug and other named legendary tokens: read as the creature token they are.
    .replace(/create ([a-z' ]+), a legendary (\d+\/\d+) ([a-z ]+?) creature token with ([a-z, ]+?),? and "[^"]*"\.?/, 'create a $2 $3 creature token with $4.');
}

export function emblemTrigger(l: string): EmblemContext | null {
  let m: RegExpMatchArray | null;
  // Rooms (rule 709.5h, 709.5i).
  if ((m = l.match(/^when you unlock this door,\s*(.*)$/))) return { when: 'unlock', body: m[1] };
  if ((m = l.match(/^whenever you fully unlock a room,\s*(.*)$/))) return { when: 'fullyUnlock', body: m[1] };
  if (/^unlock costs you pay cost \{(\d)\} less/.test(l)) return { when: 'static', body: l };
  // Food: "whenever you sacrifice a Food" (Trail of Crumbs), "one or more Foods" (Camellia).
  if ((m = l.match(/^whenever you sacrifice (?:a|one or more) foods?,\s*(.*)$/))) return { when: 'sacrificeFood', body: m[1] };
  // Jace, Unraveler of Secrets' emblem.
  if (/^whenever an opponent casts their first spell each turn, counter that spell/.test(l)) return { when: 'opponentCast', castFilter: 'any', body: 'counter the spell that set this off.' };
  // Sphinx of the Second Sun.
  if ((m = l.match(/^at the beginning of (?:each of )?your postcombat main phases?,\s*(.*)$/))) return { when: 'postcombatMain', body: m[1] };
  // Ichormoon Gauntlet: planeswalkers you control have "[0]: proliferate" and "[-12]: take an extra turn".
  if (/^planeswalkers you control have "\[0\]: proliferate"/.test(l)) return { when: 'static', body: l };
  // "-X:" loyalty abilities (rule 606.4): X is chosen as it is activated. "Three times X" multiplies it.
  if ((m = l.match(/^-x: (.*)$/))) {
    const thrice = m[1].match(/^(.*?)\b(two|three|four) times x\b(.*)$/);
    if (thrice) return { when: 'loyalty', loyalty: 0, loyaltyX: true, xTimes: count(thrice[2], 1), body: `${thrice[1]}x${thrice[3]}` };
    return { when: 'loyalty', loyalty: 0, loyaltyX: true, body: m[1] };
  }
  // Ichormoon's granted abilities and Comet's "[+2]" style, written with brackets.
  if ((m = l.match(/^\[([+-]?\d+)\]: (.*)$/))) return { when: 'loyalty', loyalty: parseInt(m[1], 10), body: m[2] };
  return null;
}

/** "You get an emblem with "..."": the quoted abilities, if this sentence makes an emblem. */
export function emblemText(line: string, fullLine: string): string | null {
  if (!/\byou get an emblem with\b/.test(line)) return null;
  const m = fullLine.match(/you get an emblem with "(.*)"\.?$/);
  return m ? m[1].replace(/'/g, '"').replace(/\bthis emblem\b/g, '~') : null;
}

export function recogniseEmblems(line: string, out: Found[], fullLine: string, readEmblem: (text: string) => { body: EffectBody; note: string } | null): void {
  const push = (body: EffectBody, note: string, chance?: number): void => void out.push({ body, note, ...(chance !== undefined ? { chance } : {}) });
  let m: RegExpMatchArray | null;

  // --- Emblems (rule 114) ---------------------------------------------------
  const quoted = emblemText(line, fullLine);
  if (quoted !== null) {
    const read = readEmblem(quoted);
    if (read) out.push(read);
    return;
  }

  // --- Food, Blood, Incubator tokens (rule 111.10, 701.53) -------------------
  if (/create a food token or a treasure token/.test(line)) return push({ kind: 'treasure', n: 1 }, 'Treasure ×1 (or a Food)');
  if ((m = line.match(/\bcreate (a|an|one|two|three|four|five|x|that many) food tokens?/)) && !/treasure/.test(line)) {
    const n = count(m[1], 1);
    return push({ kind: 'artifactToken', token: 'food', n }, `Food ×${n === -1 ? 'X' : n}`);
  }
  if ((m = line.match(/\bcreate (a|an|one|two|three|four|five|x|that many) blood tokens?/))) {
    const n = count(m[1], 1);
    return push({ kind: 'artifactToken', token: 'blood', n }, `Blood ×${n === -1 ? 'X' : n}`);
  }
  if ((m = line.match(/\bincubate (\d+|x)( twice| x times)?/))) {
    // "Incubate X, where X is ...": counted as 3, as before real Incubators.
    const size = m[1] === 'x' ? 3 : count(m[1], 2);
    const n = m[2] === ' twice' ? 2 : m[2] === ' x times' ? -1 : 1;
    return push({ kind: 'artifactToken', token: 'incubator', n, size }, `Incubate ${size === -1 ? 'X' : size}${n === 2 ? ' twice' : n === -1 ? ' X times' : ''}`);
  }
  // Trail of Crumbs: pay {1} to look at two and take a permanent card (≈ draw one, most of the time).
  if (/^you may pay \{1\}\.?$/.test(line) && /look at the top two cards of your library\. you may reveal a permanent card from among them and put it into your hand/.test(fullLine)) return push({ kind: 'draw', n: 1 }, 'Pay {1}: look at two, take a permanent (≈ draw 1)', 0.6);
  if (/^(?:you may )?transform (?:up to one )?target incubator token you control/.test(line)) return push({ kind: 'hatch' }, 'Transform an Incubator token');

  // --- Extra turns and phases (rules 500.7, 500.8) ---------------------------
  if ((m = line.match(/^take (two|three) extra turns after this one/))) return push({ kind: 'extraTurn', n: count(m[1], 2) }, `${m[1][0].toUpperCase()}${m[1].slice(1)} extra turns`);
  if (/^there is an additional beginning phase after this phase/.test(line)) return push({ kind: 'extraPhase', phase: 'beginning' }, 'An additional beginning phase (untap, upkeep, draw)');
  if (/^planeswalkers you control have "\[0\]: proliferate"/.test(fullLine) && !out.length) {
    return push({ kind: 'pwAbilities' }, 'Your planeswalkers have [0]: proliferate and [-12]: take an extra turn');
  }
  if ((m = line.match(/^unlock costs you pay cost \{(\d)\} less/))) return push({ kind: 'unlockDiscount', n: parseInt(m[1], 10) }, `Unlock costs {${m[1]}} less`);

  // --- Planeswalker ultimates ---------------------------------------------------
  // Vraska, Betrayal's Sting: "if target player has fewer than nine poison counters, they get ... equal to the difference".
  if (/^(?:if target player has fewer than nine poison counters, )?they get a number of poison counters equal to the difference/.test(line)) return push({ kind: 'poison', n: 9, who: 'target', upTo: 9 }, 'Target player goes up to nine poison counters');
  // Jace, Memory Adept: the opponents draw twenty, which decks them.
  if (/^any number of target players each draw twenty cards/.test(line)) return push({ kind: 'mill', n: 20, who: 'opponents' }, 'Opponents each draw twenty cards (≈ mill 20)');
  // Professor Onyx: seven times "discard or lose 3".
  if (/^each opponent may discard a card/.test(line) && /^each opponent may discard a card\. if they don't, they lose 3 life\. repeat this process six more times/.test(fullLine)) return push({ kind: 'drain', n: 12, gain: 0 }, 'Each opponent discards or loses 3 life, seven times (≈ lose 12)');
  // Huatli: life equal to the greatest toughness among your creatures.
  if (/^you gain life equal to the greatest (toughness|power) among creatures you control/.test(line)) return push({ kind: 'gainLife', n: 5 }, 'Gain life equal to your biggest creature (≈ 5)');
  // Ugin, the Spirit Dragon -X: a one-sided-ish wipe of colored permanents.
  if (/^exile each permanent with mana value x or less that's one or more colors/.test(line)) return push({ kind: 'wipe', target: 'nonland', mode: 'exile', amount: 0, oneSided: false, maxCmc: -1, colored: true }, 'Exile each colored permanent with mana value X or less');
  // Tezzeret the Seeker -X: an artifact with mana value X or less onto the battlefield.
  if (/^search your library for an artifact card with mana value x or less, put it onto the battlefield/.test(line)) {
    for (let i = out.length - 1; i >= 0; i--) if (out[i].body.kind === 'tutor') out.splice(i, 1);
    return push({ kind: 'tutor', artifactToBattlefield: true, xLimit: true }, 'Artifact with mana value X or less onto the battlefield');
  }
  // Tezzeret, Master of the Bridge -8: the artifacts among the top ten cards.
  if (/^exile the top ten cards of your library/.test(line) && /^exile the top ten cards of your library\. put all artifact cards from among them onto the battlefield/.test(fullLine)) return push({ kind: 'digPermanent', artifacts: true, among: 10 }, 'Artifacts among your top ten cards onto the battlefield');
  // Liliana of the Veil -6: two piles, they sacrifice one (≈ half their permanents).
  if (/^separate all permanents target player controls into two piles/.test(line)) return push({ kind: 'sacrificeHalf' }, 'Target player sacrifices half their permanents (two piles)');

  // --- Saga chapters (rule 714) ----------------------------------------------

  // Fall of the Impostor: the biggest creature of target opponent (≈ exile target creature).
  if (/^exile a creature with the greatest power among creatures target opponent controls/.test(line)) return push({ kind: 'removal', target: 'creature', mode: 'exile', amount: 0 }, 'Exile the biggest creature of an opponent (≈ target creature)');
  // Summon: Esper Ramuh: damage equal to a count (≈ 3).
  if (/^~ deals damage equal to the number of [^.]* in your graveyard to target creature an opponent controls/.test(line)) return push({ kind: 'removal', target: 'creature', mode: 'damage', amount: 3 }, 'Damage to a creature equal to a graveyard count (≈ 3)');
  // Jace, Unraveler of Secrets' emblem: "counter that spell" on an opponent's first spell each turn.
  if (/^counter the spell that set this off/.test(line)) return push({ kind: 'counter', target: 'any' }, 'Counter that spell');

  // --- Mutate triggers (rule 702.140d) ----------------------------------------
  if ((m = line.match(/^tap up to (x|one|two|three) target creatures?/)) && /(?:those creatures|it|that creature) (?:doesn't|don't) untap during (?:its|their) controller's next untap step/.test(fullLine)) {
    return push({ kind: 'stun', tap: true, n: m[1] === 'x' ? -1 : count(m[1], 1) }, `Tap ${m[1] === 'x' ? 'X' : m[1]} creatures; they don't untap next time`);
  }
  if (/^(?:you may )?cast target noncreature card with mana value 3 or less from your graveyard without paying its mana cost/.test(line)) return push({ kind: 'freeFromGraveyard', maxCmc: 3, noncreature: true }, 'Cast a noncreature card with mana value 3 or less from your graveyard free');
}
