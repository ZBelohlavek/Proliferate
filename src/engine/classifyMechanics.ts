// Land hate, Fogs, energy and charge counters for the card reader.
//
// classify.ts calls in here for each sentence (recogniseMechanics), for
// trigger wordings it would otherwise drop (mechanicTrigger), for activation
// costs paid in energy or charge counters (mechanicCost) and once for the
// whole text (mechanicKeywords). Kept apart so these rules live in one place.

import type { CastFilter, EffectBody, SimCard, Trigger } from './types';

type Found = { body: EffectBody; note: string; chance?: number };

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, twenty: 20, thirty: 30, fifty: 50, x: -1, 'that many': -1,
};

function count(word: string | undefined, fallback = 1): number {
  if (word === undefined) return fallback;
  const w = word.trim();
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return WORDS[w] ?? fallback;
}

/** Energy symbols in "{e}{e}{e}" or "six {e}". -1 for X or "that many". */
function energyCount(text: string): number {
  const symbols = text.match(/^((?:\{e\})+)/);
  if (symbols) return (symbols[1].match(/\{e\}/g) ?? []).length;
  const word = text.match(/^(\w+(?: many)?) \{e\}/);
  return word ? count(word[1], 1) : 1;
}

/** Energy a whole ability gives ("you get {e}{e}{e}, then you may pay ..."), for estimates. */
function energyGiven(fullLine: string): number {
  const m = fullLine.match(/you get ((?:\{e\})+|\w+ \{e\})/);
  return m ? Math.max(1, energyCount(m[1])) : 0;
}

/**
 * Triggers classify.ts doesn't know. 'static' lines keep their text so the
 * static effect inside can be read (Dingus Egg, Burning Earth, Darksteel Reactor).
 */
export function mechanicTrigger(l: string): { when: Trigger; body: string; chance?: number; castFilter?: CastFilter } | null {
  let m: RegExpMatchArray | null;
  if ((m = l.match(/^whenever you get one or more \{e\}\s*(during your turn)?,\s*(.*)$/))) return { when: 'energy', body: m[2], ...(m[1] ? { chance: 0.6 } : {}) };
  if (/^whenever a land is put into a graveyard from the battlefield, [^.]*damage to that land's controller/.test(l)) return { when: 'static', body: l };
  if (/^whenever (a player taps (a|a nonbasic) land for mana|an opponent taps a land for mana|a land an opponent controls is tapped for mana)/.test(l)) return { when: 'static', body: l };
  if (/^when ~ has (\w+) or more charge counters on it, you win the game/.test(l)) return { when: 'static', body: l };
  // Era of Innovation.
  if ((m = l.match(/^whenever an artifact or artificer you control enters,\s*(.*)$/))) return { when: 'permEnters', castFilter: 'artifact', body: m[1] };
  // Aetherworks Marvel: mostly creatures dying.
  if ((m = l.match(/^whenever a permanent you control is put into a graveyard[^,]*,\s*(.*)$/))) return { when: 'creatureDies', body: m[1] };
  return null;
}

/** "Pay {E}{E}", "pay six {E}", "pay X {E}" and "remove three charge counters from ~" in an activation cost. */
export const MECHANIC_COST = 'pay (?:(?:\\{e\\})+|\\w+ \\{e\\})|remove (?:a|an|one|two|three|four|five|six|ten|twenty|fifty|x|\\d+) charge counters? from ~|exile ~';

export function mechanicCost(costText: string): { energy?: number; charge?: number; exileSelf?: boolean } {
  const out: { energy?: number; charge?: number; exileSelf?: boolean } = {};
  const energy = costText.match(/pay ((?:\{e\})+|\w+ \{e\})/);
  if (energy) out.energy = energyCount(energy[1]);
  const charge = costText.match(/remove (\w+) charge counters? from ~/);
  if (charge) out.charge = count(charge[1], 1) === -1 ? 1 : count(charge[1], 1);
  if (/(^|, )exile ~/.test(costText)) out.exileSelf = true;
  return out;
}

/** Read from the whole text: sunburst, and charge counters a permanent enters with. */
export function mechanicKeywords(text: string, card: SimCard) {
  if (/^sunburst\s*$/m.test(text)) {
    card.sunburst = true;
    card.notes.push(`Sunburst: enters with a ${card.isCreature ? '+1/+1' : 'charge'} counter for each color of mana spent`);
  }
  const enters = text.match(/^~ enters with (\w+) charge counters? on it/m);
  if (enters) {
    // Multikicker (Everflowing Chalice) isn't paid, so it enters with the one counter a cheap cast gives.
    card.charge = /for each time it was kicked/.test(text) ? 1 : count(enters[1], 1);
    card.notes.push(`Enters with ${card.charge === -1 ? 'X' : card.charge} charge counter${card.charge === 1 ? '' : 's'}`);
  }
}

export function mechanicLineHandled(line: string): boolean {
  return /^sunburst\s*$|^~ enters with (\w+) charge counters? on it/.test(line);
}

/** `line` is one sentence; `fullLine` is the whole ability. */
export function recogniseMechanics(line: string, out: Found[], fullLine: string) {
  let m: RegExpMatchArray | null;

  // --- Land hate ---------------------------------------------------------------
  if ((m = line.match(/^nonbasic lands are (mountains|islands)/))) {
    out.push({ body: { kind: 'landRule', rule: m[1] === 'mountains' ? 'nonbasicMountains' : 'nonbasicIslands' }, note: `Nonbasic lands are ${m[1][0].toUpperCase()}${m[1].slice(1)} (they tap only for {${m[1] === 'mountains' ? 'R' : 'U'}})` });
  }
  if (/^nonbasic lands don't untap during their controllers' untap steps/.test(line)) out.push({ body: { kind: 'landRule', rule: 'nonbasicNoUntap' }, note: "Nonbasic lands don't untap" });
  if (/players can't untap more than one nonbasic land during their untap steps/.test(line)) out.push({ body: { kind: 'landRule', rule: 'untapOneNonbasic' }, note: 'Players untap at most one nonbasic land a turn' });
  else if (/players can't untap more than one land during their untap steps/.test(line)) out.push({ body: { kind: 'landRule', rule: 'untapOneLand' }, note: 'Players untap at most one land a turn' });
  if (/nonbasic lands your opponents control enter tapped/.test(line)) out.push({ body: { kind: 'landRule', rule: 'oppNonbasicTapped' }, note: "Opponents' nonbasic lands enter tapped" });
  if (/^lands you control are every basic land type in addition to their other types/.test(line)) out.push({ body: { kind: 'landRule', rule: 'everyType' }, note: 'Your lands tap for any color' });
  if ((m = line.match(/^whenever a player taps (a|a nonbasic) land for mana, (?:~|it) deals (\w+) damage to that player/))) {
    const nonbasic = m[1] !== 'a';
    out.push({ body: { kind: 'tapPunish', what: 'damage', n: count(m[2], 1), ...(nonbasic ? { nonbasic } : {}) }, note: `Tapping a ${nonbasic ? 'nonbasic ' : ''}land for mana deals ${count(m[2], 1)} damage to that player` });
  } else if (/^whenever a player taps a land for mana, if it's not that player's turn, destroy that land/.test(line)) {
    out.push({ body: { kind: 'tapPunish', what: 'destroyOffTurn', n: 0 }, note: "A land tapped for mana outside its controller's turn is destroyed" });
  } else if (/^whenever (an opponent taps a land for mana|a land an opponent controls is tapped for mana), tap all lands that player controls/.test(line)) {
    out.push({ body: { kind: 'tapPunish', what: 'tapAll', n: 0, opponents: true }, note: 'An opponent tapping a land for mana taps all their lands' });
  }
  if ((m = line.match(/^whenever a land is put into a graveyard from the battlefield, (?:~|it) deals (\w+) damage to that land's controller/))) {
    out.push({ body: { kind: 'landDiesPunish', n: count(m[1], 2) }, note: `A land going to a graveyard deals ${count(m[1], 2)} damage to its controller` });
  }
  if ((m = line.match(/(?:^|sacrifice ~ and )destroy all (nonbasic )?lands/))) {
    const replace = /search (their|his or her) library for a basic land/.test(fullLine);
    out.push({ body: { kind: 'landWipe', nonbasic: !!m[1], ...(replace ? { replace } : {}) }, note: `Destroy all ${m[1] ? 'nonbasic ' : ''}lands${replace ? ' (each player may fetch a basic land for each)' : ''}` });
  }
  if ((m = line.match(/^(?:each player|that player) sacrifices (a|an|two|three) (?:untapped )?lands?/))) {
    out.push({ body: { kind: 'landSac', n: count(m[1], 1), who: 'each' }, note: `Each player sacrifices ${count(m[1], 1)} land${count(m[1], 1) > 1 ? 's' : ''}` });
  } else if ((m = line.match(/^each opponent sacrifices (a|an|two|three) lands?/))) {
    out.push({ body: { kind: 'landSac', n: count(m[1], 1), who: 'opponents' }, note: `Each opponent sacrifices ${count(m[1], 1)} land${count(m[1], 1) > 1 ? 's' : ''}` });
  } else if ((m = line.match(/^each player sacrifices all lands they control except for (\w+)/))) {
    out.push({ body: { kind: 'landSac', n: 0, who: 'each', keep: count(m[1], 3) }, note: `Each player sacrifices all but ${count(m[1], 3)} lands` });
  }
  if ((m = line.match(/deals damage to each player equal to (twice )?the number of nonbasic lands that player controls/))) {
    out.push({ body: { kind: 'nonbasicBurn', per: m[1] ? 2 : 1 }, note: `Damage to each player: ${m[1] ? 'twice ' : ''}their nonbasic lands` });
  }
  if ((m = line.match(/(?:^|^when you do, |^if you do, )destroy target (nonbasic )?land( an opponent controls| defending player controls)?/))) {
    const replace = /searche?s? (their|his or her) library for a basic land/.test(fullLine);
    out.push({ body: { kind: 'removal', target: m[1] ? 'nonbasicLand' : 'land', mode: 'destroy', amount: 0, ...(replace ? { replace } : {}) }, note: `Destroy a ${m[1] ? 'nonbasic ' : ''}land${replace ? ' (its controller may fetch a basic land)' : ''}` });
  }

  // --- Fog -----------------------------------------------------------------------
  if (/^prevent all combat damage that would be dealt this turn/.test(line)) out.push({ body: { kind: 'fog', who: 'all' }, note: 'Fog: prevent all combat damage this turn' });
  else if (/^prevent all combat damage that would be dealt to you( and planeswalkers you control)? this turn/.test(line)) {
    const tokens = /for each 1 damage prevented this way, create/.test(fullLine);
    out.push({ body: { kind: 'fog', who: 'you', ...(tokens ? { tokens } : {}) }, note: `Prevent all combat damage to you this turn${tokens ? ' (a 2/1 flyer for each 1 prevented)' : ''}` });
  } else if (/^prevent all combat damage that would be dealt to and dealt by that creature this turn/.test(line) && /untap target attacking creature/.test(fullLine)) {
    out.push({ body: { kind: 'fog', who: 'creature', untap: true }, note: 'Untap an attacking creature and prevent combat damage to and by it' });
  } else if (/prevent all damage that would be dealt to you this turn by a source of your choice|prevent all damage that would be dealt to and dealt by target permanent an opponent controls/.test(line)) {
    out.push({ body: { kind: 'fog', who: 'creature' }, note: "Prevent the damage one opponent's creature would deal this turn" });
  }

  // Inkshield: the tokens come from the damage prevented (see the fog above), not a fixed number.
  if (/^for each 1 damage prevented this way, create/.test(line)) for (let i = out.length - 1; i >= 0; i--) if (out[i].body.kind === 'tokens') out.splice(i, 1);

  // --- Energy --------------------------------------------------------------------
  if ((m = line.match(/(?:you|and) get ((?:\{e\})+|(?:x|that many|\w+) \{e\}|an amount of \{e\})/))) {
    // "An amount of {E} equal to the mana spent / the nonbasic lands that player controls": a few.
    const n = /^an amount/.test(m[1]) ? 3 : energyCount(m[1]);
    out.push({ body: { kind: 'energy', n }, note: `You get ${n === -1 ? 'X' : n} energy` });
  }
  // Aether Revolt: "whenever you get one or more {E}, ~ deals that much damage to any target".
  if (/^~ deals that much damage to any target/.test(line)) out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount: -1, anyTarget: true }, note: 'Deal that much damage to any target' });
  // Aethersquall Ancient.
  if (/^return all other creatures to their owners' hands/.test(line)) out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'bounce', amount: 0, oneSided: false }, note: 'Return all other creatures to their owners\' hands' });
  // Aetherworks Marvel: cast a spell from the top six for free, about the first permanent.
  if (/^you may cast a spell from among them without paying its mana cost/.test(line)) out.push({ body: { kind: 'digPermanent' }, note: 'Cast a spell from the top six cards for free' });
  if (/if you would get one or more \{e\}\s*, you get twice that many \{e\} instead/.test(line)) out.push({ body: { kind: 'energyBoost', mult: 2, plus: 0 }, note: 'Energy you get is doubled' });
  else if ((m = line.match(/if you would get one or more \{e\}\s*, you get that many plus (\w+) \{e\} instead/))) out.push({ body: { kind: 'energyBoost', mult: 1, plus: count(m[1], 1) }, note: `You get ${count(m[1], 1)} more energy each time` });
  // Galvanic Discharge: the damage is the energy paid.
  if (/^~ deals that much damage to that (permanent|creature)/.test(line) && /pay any amount of \{e\}/.test(fullLine)) {
    out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount: energyGiven(fullLine), energyPaid: true }, note: 'Damage to a creature equal to the energy paid' });
  }
  // Confiscation Coup: steal it by paying energy equal to its mana value.
  if (/^if you do, gain control of it/.test(line) && /pay an amount of \{e\} equal to that permanent's mana value/.test(fullLine)) {
    out.push({ body: { kind: 'steal', from: 'battlefield', payEnergy: energyGiven(fullLine) }, note: 'Steal a creature by paying energy equal to its mana value' });
  }

  // --- Charge counters -------------------------------------------------------------
  // "Put a charge counter on ~. Add X mana ...": part of the mana ability (Empowered Autogenerator).
  if ((m = line.match(/put (a|an|one|two|three|x|\w+) charge counters? on ~/)) && !/add x mana/.test(fullLine)) {
    const n = Math.max(1, count(m[1], 1));
    out.push({ body: { kind: 'charge', n }, note: `${n} charge counter${n > 1 ? 's' : ''} on itself` });
  } else if ((m = line.match(/put (a|an|one|two|three|x|\w+) charge counters? on (?:up to one )?(?:other )?target artifact/))) {
    const n = Math.max(1, count(m[1], 1));
    out.push({ body: { kind: 'charge', n, target: 'artifact' }, note: `${n} charge counter${n > 1 ? 's' : ''} on an artifact` });
  }
  if ((m = line.match(/^add \{(\w)\} for each charge counter on ~/))) {
    out.push({ body: { kind: 'treasure', n: 0, ritual: true, byCharge: true }, note: `{${m[1].toUpperCase()}} for each charge counter (one-shot mana)` });
  }
  if ((m = line.match(/^when ~ has (\w+) or more charge counters on it, you win the game/))) {
    out.push({ body: { kind: 'chargeWin', n: count(m[1], 20) }, note: `Wins the game at ${count(m[1], 20)} charge counters` });
  }
}

/**
 * Mana abilities whose amount is the source's charge counters. `sentence` starts with "add".
 * Returns the mana effect, or null when the sentence isn't one of these.
 */
export function chargeMana(sentence: string, fullLine: string, tap: boolean): EffectBody | null {
  if (!/charge counter/.test(fullLine)) return null;
  if (/^add (one mana of that color|\{c\}|\{\w\}|x mana of any one color)[^.]*(for each charge counter on ~|where x is the number of charge counters on ~)/.test(sentence)) {
    const colors = /\{c\}/.test(sentence) ? ['C' as const] : 'any' as const;
    return { kind: 'mana', amount: 1, colors, charge: /put a charge counter on ~\. add/.test(fullLine) ? 'grow' : 'tap' };
  }
  if (!tap && /^add one mana of any color/.test(sentence)) return { kind: 'mana', amount: 1, colors: 'any', charge: 'spend' };
  return null;
}

/** "You may pay {E}{E}{E}." / "..., then you may pay eight {E}.": the energy the rest of the ability costs, or 0. */
export function energyGateOf(sentence: string): number {
  const m = sentence.match(/(?:^|, then )you may pay ((?:\{e\})+|\w+ \{e\})\s*\.?$/);
  return m ? Math.max(1, energyCount(m[1])) : 0;
}
