// Intervening "if" clauses (rule 603.4) the engine can check exactly, instead of guessing how often they hold.

import type { Cond } from './types';

const NUMBERS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, thirty: 30 };
const count = (w: string) => NUMBERS[w] ?? parseInt(w, 10);

/** Read "if <clause>," into a condition, or null when it isn't one the engine can check. */
export function readCondition(clause: string): Cond | null {
  const c = clause.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = c.match(/^you control (an?|one|two|three|four|five|six|seven|\d+)(?: or more)? ((?:nonland |nontoken )?[a-z]+?)s?$/))) return { k: 'youControl', what: m[2], min: count(m[1]) };
  if ((m = c.match(/^you control no ([a-z]+?)s?$/))) return { k: 'youControl', what: m[1], min: 0, max: 0 };
  if (/^(an opponent|defending player) controls more lands than you$/.test(c)) return { k: 'oppMoreLands' };
  if (/^an opponent is the monarch$/.test(c)) return { k: 'oppMonarch' };
  if (/^you're the monarch$|^you are the monarch$/.test(c)) return { k: 'youMonarch' };
  if ((m = c.match(/^you control (\w+) or more permanents you don't own$/))) return { k: 'notOwned', min: count(m[1]) };
  if ((m = c.match(/^there are (\w+) or more lands on the battlefield$/))) return { k: 'landsTotal', min: count(m[1]) };
  if (/^an opponent lost life this turn$/.test(c)) return { k: 'oppLostLife' };
  if (/^you attacked (with a creature )?this turn$/.test(c)) return { k: 'youAttacked' };
  if (/^(this creature|~) attacked this turn$/.test(c)) return { k: 'selfAttacked' };
  if (/^you've drawn more than one card this turn$/.test(c)) return { k: 'drewMore', min: 2 };
  if (/^you have a full party$/.test(c)) return { k: 'fullParty' };
  if (/^(this artifact|this creature|~) is untapped$/.test(c)) return { k: 'selfUntapped' };
  if (/^a creature died (under your control )?this turn$/.test(c)) return { k: 'creatureDied' };
  if (/^it doesn't have the same name as another creature you control or a creature card in your graveyard$/.test(c)) return { k: 'uniqueName' };
  if ((m = c.match(/^there are (\w+) or more counters among artifacts and creatures you control$/))) return { k: 'counters', min: count(m[1]) };
  if (/^(an opponent|a player) discarded a card this turn$/.test(c)) return { k: 'discarded', opponent: c.startsWith('an opponent') };
  return null;
}
