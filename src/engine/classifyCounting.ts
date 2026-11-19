// Counting effects, variable mana and tap/untap effects for the card reader.
//
// classify.ts calls in here once for the whole text (countingKeywords: "gets +1/+0 for each ...",
// "costs {1} less for each ...", affinity), for each sentence (recogniseCounting), for mana abilities
// whose amount is a count or that don't tap (countingMana), for trigger wordings it would otherwise drop
// (countingTrigger) and for lines read from the whole text (countingLineHandled). Kept apart so these rules
// live in one place.

import type { Effect, EffectBody, Mana, ManaCost, SimCard, Trigger } from './types';

/** What countingMana needs to know about the ability's cost. */
export type LineManaContext = { tap?: boolean; removeCounters?: { n: number; from: 'self' | 'any' } };

type Found = { body: EffectBody; note: string; chance?: number };

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w) ? parseInt(w, 10) : WORDS[w] ?? fallback);

/** Creature types in English plural or singular ("rats", "wizard") as the engine's subtype name ("Rat"). */
function subtypeName(word: string): string {
  const w = word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
  return w.charAt(0).toUpperCase() + w.slice(1);
}

const SCALE_WORDS: { re: RegExp; by: NonNullable<SimCard['scales']>['by']; what: string }[] = [
  { re: /^artifacts? you control$/, by: 'artifacts', what: 'artifact you control' },
  { re: /^enchantments? you control$/, by: 'enchantments', what: 'enchantment you control' },
  { re: /^creatures? you control$/, by: 'creatures', what: 'creature you control' },
  { re: /^lands? you control$/, by: 'lands', what: 'land you control' },
  { re: /^cards? in your hand$/, by: 'hand', what: 'card in your hand' },
  { re: /^cards? in your graveyard$/, by: 'graveyard', what: 'card in your graveyard' },
  { re: /^creature cards? in your graveyard$/, by: 'graveyardCreatures', what: 'creature card in your graveyard' },
  { re: /^card your opponents own in exile$/, by: 'oppExile', what: 'card your opponents own in exile' },
  { re: /^colou?r among permanents you control$/, by: 'colors', what: 'color among permanents you control' },
  { re: /^experience counter you have$/, by: 'experience', what: 'experience counter you have' },
];

/** "~ gets +1/+0 for each artifact you control" and friends: the count, or null. */
function scaleOf(what: string): { by: NonNullable<SimCard['scales']>['by']; what: string; subtype?: string; other?: boolean } | null {
  for (const s of SCALE_WORDS) if (s.re.test(what)) return { by: s.by, what: s.what };
  const tribe = what.match(/^(other )?([a-z]+) you control$/);
  if (tribe && !/permanent|token|nonland/.test(tribe[2])) return { by: 'subtype', subtype: subtypeName(tribe[2]), other: !!tribe[1], what: `${tribe[1] ? 'other ' : ''}${subtypeName(tribe[2])} you control` };
  return null;
}

const DISCOUNT_EACH: { re: RegExp; per: NonNullable<SimCard['discount']>['per']; what: string }[] = [
  { re: /^creature that died this turn$/, per: 'diedThisTurn', what: 'creature that died this turn' },
  { re: /^card type among cards in your graveyard$/, per: 'graveyardTypes', what: 'card type in your graveyard' },
  { re: /^creature in your party$/, per: 'party', what: 'creature in your party' },
  { re: /^instant and sorcery card in your graveyard$/, per: 'spellsInGraveyard', what: 'instant and sorcery card in your graveyard' },
  { re: /^\{e\}\s*you've paid or lost this turn$/, per: 'energyPaid', what: 'energy paid this turn' },
];

const DISCOUNT_IF: { re: RegExp; per: NonNullable<SimCard['discount']>['per']; what: string; approx?: boolean }[] = [
  { re: /^you control a creature with power 4 or greater$/, per: 'bigCreature', what: 'you control a creature with power 4 or more' },
  { re: /^an opponent has three or more poison counters$/, per: 'poisoned', what: 'an opponent has 3+ poison counters' },
  { re: /^it targets a legendary creature$/, per: 'legendaryTarget', what: 'an opponent has a legendary creature to target', approx: true },
  { re: /^it targets an attacking creature$/, per: 'attackingTarget', what: 'a creature is attacking', approx: true },
];

/** Read from the whole text: counted power and toughness, and spells that cost less. */
export function countingKeywords(text: string, card: SimCard, raw: { power?: string | null; toughness?: string | null }) {
  let m: RegExpMatchArray | null;
  // "~ gets +1/+0 for each artifact you control", "this spacecraft gets +1/+0 for each ...".
  if (!card.scales && (m = text.match(/^(?:~|this spacecraft|this vehicle) gets \+1\/\+(0|1) for each ([a-z' {}]+?)\.?\s*$/m))) {
    const s = scaleOf(m[2]);
    if (s) {
      card.scales = { by: s.by, toughness: m[1] === '1', ...(s.subtype ? { subtype: s.subtype } : {}), ...(s.other ? { other: true } : {}) };
      card.notes.push(`Gets +1/+${m[1]} for each ${s.what}`);
    }
  }
  // Power equal to a count the main reader doesn't know.
  if (!card.scales && (m = text.match(/^~'s power is equal to (1 plus )?the number of (cards you've drawn this turn|creatures in your party|card types among cards in your opponents' graveyards)\.?\s*$/m))) {
    const by = /drawn/.test(m[2]) ? 'drawnThisTurn' as const : /party/.test(m[2]) ? 'party' as const : 'oppGraveyardTypes' as const;
    card.scales = { by, toughness: false };
    card.power = parseInt(String(raw.power ?? '0'), 10) || 0;
    card.notes.push(`Power equal to ${m[1] ? '1 plus ' : ''}the number of ${m[2]}`);
  }

  // Spells that cost less: "for each ...", "if ...", affinity.
  if (!card.discount) {
    if ((m = text.match(/^~ costs \{(\d)\} less to cast for each (.+?)\.?\s*$/m))) {
      const d = DISCOUNT_EACH.find((x) => x.re.test(m![2]));
      if (d) {
        card.discount = { per: d.per, amount: parseInt(m[1], 10) };
        card.notes.push(`Costs {${m[1]}} less for each ${d.what}`);
      }
    } else if ((m = text.match(/^(?:[a-z]+ — )?~ costs \{(\d)\} less to cast if (?:you control an? ([a-z]+)|(.+?))\.?\s*$/m))) {
      const amount = parseInt(m[1], 10);
      if (m[2]) {
        card.discount = { per: 'subtype', subtype: subtypeName(m[2]), amount, once: true };
        card.notes.push(`Costs {${amount}} less if you control a ${subtypeName(m[2])}`);
      } else {
        const d = DISCOUNT_IF.find((x) => x.re.test(m![3]));
        if (d) {
          card.discount = { per: d.per, amount, once: true };
          card.notes.push(`Costs {${amount}} less if ${d.what}${d.approx ? ' (≈ it is then aimed there when it can be)' : ''}`);
        }
      }
    } else if ((m = text.match(/^affinity for (tokens|[a-z]+)\s*$/m)) && m[1] !== 'artifacts') {
      card.discount = m[1] === 'tokens' ? { per: 'tokens', amount: 1 } : { per: 'subtype', subtype: subtypeName(m[1]), amount: 1 };
      card.notes.push(`Affinity: costs {1} less for each ${m[1] === 'tokens' ? 'token' : subtypeName(m[1])} you control`);
    }
  }
  // "Costs {X} less, where X is ...": Cavern-Hoard Dragon, Excalibur, Sword of Eden.
  if (!card.discount && (m = text.match(/^~ costs \{x\} less to cast, where x is the (greatest number of artifacts an opponent controls|total mana value of historic permanents you control)/m))) {
    const opp = m[1].startsWith('greatest');
    card.discount = { per: opp ? 'opponentArtifacts' : 'historicValue', amount: 1 };
    card.notes.push(`Costs {1} less for each ${opp ? 'artifact the opponent with the most controls' : 'mana value among your artifacts, legends and Sagas'}`);
  }
  // Strive: the engine casts it with one target, so the extra cost never comes up.
  if (/^strive — /m.test(text)) card.notes.push('Strive: cast with one target, so no extra cost');

  // Whole-text mana abilities: "sacrifice an artifact: add {c}{c}" (Krark-Clan Ironworks) isn't an activation the main reader knows.
  if ((m = text.match(/^sacrifice an artifact: add ((?:\{c\})+)\.?$/m))) {
    const n = (m[1].match(/\{c\}/g) ?? []).length;
    card.effects.push({ kind: 'mana', amount: n, colors: ['C'], sacArtifact: true, when: 'static' } as Effect);
    card.notes.push(`Sacrifice an artifact: add ${'{C}'.repeat(n)} (spare artifact tokens become mana when needed)`);
  }
  // Mana Vault: never worth paying {4} to untap it in the upkeep.
  if (/^at the beginning of your upkeep, you may pay \{4\}\. if you do, untap ~/m.test(text)) card.notes.push('Upkeep untap for {4}: never paid (≈ it nets less mana than the {4} it costs)');
  // Thran Turbine: mana that can't pay for spells, in the upkeep, when bots activate nothing.
  if (/^at the beginning of your upkeep, you may add \{c\}\{c\}\. this mana can't be spent to cast spells/m.test(text)) card.notes.push('Upkeep {C}{C} only for abilities (≈ unused: bots activate nothing in the upkeep)');
}

/** Lines countingKeywords reads from the whole text. */
export function countingLineHandled(line: string): boolean {
  return /^(~|this spacecraft|this vehicle) gets \+1\/\+(0|1) for each |^~'s power is equal to (1 plus )?the number of (cards you've drawn this turn|creatures in your party|card types among cards in your opponents' graveyards)|^(?:[a-z]+ — )?~ costs \{\d\} less to cast (for each|if) |^~ costs \{x\} less to cast, where x is the (greatest number of artifacts an opponent controls|total mana value of historic permanents you control)|^affinity for |^strive — |^sacrifice an artifact: add (\{c\})+|^at the beginning of your upkeep, you may pay \{4\}\. if you do, untap ~|^at the beginning of your upkeep, you may add \{c\}\{c\}\. this mana can't be spent/.test(line);
}

/** Lines the main trigger reader would drop: kept whole as static text (or rewritten) for recogniseCounting. */
export function countingTrigger(l: string): { when: Trigger; body: string } | null {
  let m: RegExpMatchArray | null;
  if (/^whenever you tap (a swamp|a land|a permanent for \{c\}) for mana, add (an additional|one mana)|^whenever you tap a permanent for \{c\}, add an additional \{c\}|^whenever a land's ability causes you to add one or more mana of the chosen color/.test(l)) return { when: 'static', body: l };
  if (/^at the beginning of your upkeep, sacrifice ~ unless you pay (\{[^}]+\})+/.test(l)) return { when: 'static', body: l };
  // Mana Vault: "at the beginning of your draw step, if ~ is tapped, it deals 1 damage to you".
  if ((m = l.match(/^at the beginning of your (?:upkeep|draw step), if ~ is tapped, (?:~|it) deals (\d+) damage to you/))) return { when: 'upkeep', body: `tapped pain ${m[1]}` };
  return null;
}

/** Ability words the main reader doesn't strip before an activation cost ("corrupted — {t}: ..."). */
export function rewriteCounting(l: string): string {
  return l.replace(/^corrupted — (?=\{)/, '');
}

/**
 * A mana ability whose amount is a count, that doesn't tap, or that only works some of the time.
 * Returns the effect to add, or null to leave the sentence to the main reader.
 */
export function countingMana(sentence: string, line: string, ctx: LineManaContext): Effect | null {
  let m: RegExpMatchArray | null;
  const colorsOf = (s: string): Mana[] | 'any' => (/any (one )?color|any combination of colors/.test(s) ? 'any' : [...new Set([...s.matchAll(/\{([wubrgc])\}/g)].map((x) => x[1].toUpperCase() as Mana))]);
  // Vivi Ornitier: "{0}: add x mana in any combination of {u} and/or {r}, where x is ~'s power. activate only during your turn and only once each turn."
  if ((m = sentence.match(/^add x mana (?:in any combination of|of any one color)([^,]*), where x is ~'s power/))) {
    return { kind: 'mana', amount: 1, colors: m[1] ? colorsOf(m[1]) : 'any', count: 'power', ...(!ctx.tap && /once each turn/.test(line) ? { oncePerTurn: true } : {}), when: 'static' } as Effect;
  }
  // Faeburrow Elder: "for each color among permanents you control, add one mana of that color".
  if (ctx.tap && /^for each color among permanents you control, add one mana of that color/.test(sentence)) {
    return { kind: 'mana', amount: 1, colors: 'any', count: 'colors', when: 'static' } as Effect;
  }
  // Sanctum Weaver: "add x mana of any one color, where x is the number of enchantments you control".
  if (ctx.tap && /^add x mana of any one color, where x is the number of enchantments you control/.test(sentence)) {
    return { kind: 'mana', amount: 1, colors: 'any', count: 'enchantments', when: 'static' } as Effect;
  }
  // Glistening Sphere: "corrupted — {t}: add three mana of any one color. activate only if an opponent has three or more poison counters."
  if (ctx.tap && (m = sentence.match(/^add (two|three) mana of any one color/)) && /activate only if an opponent has three or more poison counters/.test(line)) {
    return { kind: 'mana', amount: count(m[1], 3), colors: 'any', corrupted: true, when: 'static' } as Effect;
  }
  // Crystalline Crawler: "remove a +1/+1 counter from ~: add one mana of any color".
  if (!ctx.tap && ctx.removeCounters?.from === 'self' && (m = sentence.match(/^add (one mana of any color|\{[wubrgc]\})/))) {
    return { kind: 'mana', amount: 1, colors: colorsOf(m[1]), fromCounters: true, when: 'static' } as Effect;
  }
  return null;
}

/** What makes a mana ability unusual, for the deck page (empty for a plain one). */
export function manaNote(e: Extract<EffectBody, { kind: 'mana' }>): string {
  if (e.count === 'power') return ` for each point of its power${e.oncePerTurn ? ', once a turn on your turn, without tapping' : ''}`;
  if (e.count === 'enchantments') return ' for each enchantment you control';
  if (e.count === 'colors') return ' for each color among permanents you control';
  if (e.corrupted) return ' while an opponent has 3+ poison counters';
  if (e.fromCounters) return ' for each +1/+1 counter removed from it';
  if (e.sacArtifact) return ' for each spare artifact token sacrificed';
  return '';
}

/** `line` is one sentence; `fullLine` is the whole ability, quotes included. */
export function recogniseCounting(line: string, out: Found[], fullLine: string) {
  let m: RegExpMatchArray | null;

  // --- Activated abilities cost less ---------------------------------------
  if ((m = line.match(/^activated abilities of creatures (you control )?cost \{(\d)\} less to activate/))) {
    out.push({ body: { kind: 'abilityDiscount', amount: parseInt(m[2], 10), of: m[1] ? 'yours' : 'creatures' }, note: `Activated abilities of ${m[1] ? 'your ' : ''}creatures cost {${m[2]}} less (not below one mana)` });
  } else if ((m = line.match(/^abilities you activate that aren't mana abilities cost \{(\d)\} less to activate/))) {
    out.push({ body: { kind: 'abilityDiscount', amount: parseInt(m[1], 10), of: 'all' }, note: `Your non-mana abilities cost {${m[1]}} less (not below one mana)` });
  }

  // --- Spells cost less, depending on where they are cast from, or the first each turn -------------
  if ((m = line.match(/^spells you cast from (your graveyard or from exile|your graveyard|anywhere other than your hand) cost \{(\d)\} less to cast/))) {
    const from = /exile/.test(m[1]) ? 'graveyardOrExile' as const : /graveyard/.test(m[1]) ? 'graveyard' as const : 'notHand' as const;
    out.push({ body: { kind: 'costReduction', amount: parseInt(m[2], 10), filter: 'any', from }, note: `Spells you cast from ${m[1]} cost {${m[2]}} less${from === 'notHand' ? ' (your commander too)' : ''}` });
  } else if ((m = line.match(/^the first (creature|instant or sorcery) spell you cast each turn costs \{(\d|u)\}\s*less to cast/))) {
    const filter = m[1] === 'creature' ? 'creature' as const : 'instantSorcery' as const;
    const amount = m[2] === 'u' ? 1 : parseInt(m[2], 10);
    out.push({ body: { kind: 'costReduction', amount, filter, first: true }, note: `The first ${m[1]} spell each turn costs {${amount}} less${m[2] === 'u' ? ' (≈ one flooded land)' : ''}` });
  } else if ((m = line.match(/^colorless spells you cast with mana value (\d+) or greater cost \{(\d)\} less to cast/))) {
    out.push({ body: { kind: 'costReduction', amount: parseInt(m[2], 10), filter: 'colorless', minCmc: parseInt(m[1], 10) }, note: `Colorless spells with mana value ${m[1]}+ cost {${m[2]}} less` });
  } else if (/^creature and planeswalker spells you cast have affinity for artifacts/.test(line)) {
    out.push({ body: { kind: 'costReduction', amount: 1, filter: 'creatureOrPlaneswalker', affinity: true }, note: 'Your creature and planeswalker spells cost {1} less for each artifact you control' });
  }
  // Accursed Witch: only opponents' spells aimed at it, which bots don't plan around.
  if (/^spells your opponents cast that target ~ cost \{\d\} less to cast/.test(line)) out.push({ body: { kind: 'costReduction', amount: 0, filter: 'any' }, note: "Opponents' spells aimed at it cost less (≈ ignored)" });

  // --- Variable mana -------------------------------------------------------
  if (/^lands you control have "\{t\}: add one mana of any color\.?"/.test(fullLine)) out.push({ body: { kind: 'landRule', rule: 'everyType' }, note: 'Your lands tap for any color' });
  if (/^creature tokens you control have "\{t\}: add one mana of any color\.?"/.test(fullLine)) out.push({ body: { kind: 'tokenMana' }, note: 'Your creature tokens tap for one mana of any color' });
  if (/^whenever you tap a swamp for mana, add an additional \{b\}/.test(line)) out.push({ body: { kind: 'manaBoost', what: 'swamps' }, note: 'Your Swamps tap for {B}{B}' });
  else if (/^whenever you tap a land for mana, add one mana of any type that land produced/.test(line)) out.push({ body: { kind: 'manaBoost', what: 'lands' }, note: 'Your lands tap for two mana' });
  else if (/^whenever you tap a permanent for \{c\}, add an additional \{c\}/.test(line)) out.push({ body: { kind: 'manaBoost', what: 'colorless' }, note: 'Your lands and artifacts that tap for {C} make one more {C}' });
  else if (/^whenever a land's ability causes you to add one or more mana of the chosen color, add an additional one mana of that color/.test(line)) out.push({ body: { kind: 'manaBoost', what: 'chosenColor' }, note: "Your lands of the chosen color (your deck's main color) make one more mana" });
  if (/^you may add an amount of \{c\} equal to the number of creatures you control that share a creature type with it/.test(line)) {
    out.push({ body: { kind: 'treasure', n: 1, ritual: true, shareType: true }, note: '{C} for each creature you control that shares a creature type with it (one-shot mana)' });
  }
  if ((m = line.match(/^at the beginning of your upkeep, sacrifice ~ unless you pay ((?:\{[^}]+\})+)/))) {
    out.push({ body: { kind: 'upkeepCost', cost: parseCost(m[1]) }, note: `Each upkeep: pay ${m[1].toUpperCase()} or sacrifice it` });
  }
  if ((m = line.match(/^tapped pain (\d+)$/))) out.push({ body: { kind: 'loseLife', n: parseInt(m[1], 10), ifTapped: true }, note: `Deals ${m[1]} damage to you while it stays tapped` });

  // --- Tap and untap -------------------------------------------------------
  if ((m = line.match(/^tap (?:another |up to one )?target (artifact, creature, or land|creature without flying|creature an opponent controls|creature|nonland permanent(?: an opponent controls)?|permanent)\.?$/))) {
    const what = m[1];
    if (/doesn't untap during its controller's next untap step/.test(fullLine)) {
      out.push({ body: { kind: 'stun', tap: true }, note: `Tap an opponent's ${/creature/.test(what) ? 'creature' : 'nonland permanent'}; it skips its next untap` });
    } else {
      const target = what === 'artifact, creature, or land' || what === 'permanent' ? 'any' as const : /nonland/.test(what) ? 'nonland' as const : 'creature' as const;
      out.push({ body: { kind: 'tap', target, ...(/without flying/.test(what) ? { noFlying: true } : {}) }, note: `Tap an opponent's ${target === 'any' ? 'artifact, creature or land' : target === 'nonland' ? 'nonland permanent' : `creature${/without flying/.test(what) ? ' without flying' : ''}`}` });
    }
  } else if (/^(?:when you do, )?you may tap or untap target creature/.test(line) && /you may pay \{1\}/.test(fullLine)) {
    out.push({ body: { kind: 'tap', target: 'creature' }, note: "Tap an opponent's creature (≈ the {1} isn't paid)", chance: 0.6 });
  } else if (/^target creature an opponent controls doesn't untap during its controller's next untap step/.test(line)) {
    out.push({ body: { kind: 'stun', tapped: true }, note: "A tapped creature of an opponent's skips its next untap" });
  }
  if (/^untap (that creature|it)\.?$/.test(line) && /target creature/.test(fullLine) && !/gain control|gains control/.test(fullLine)) {
    out.push({ body: { kind: 'untap', what: 'permanent', n: 1 }, note: 'Untap a creature' });
  }
  if (/^if you cast it, untap all lands you control/.test(line)) out.push({ body: { kind: 'untap', what: 'lands', n: 99 }, note: 'Untap all your lands (when cast)' });
  if (/^players skip their untap steps/.test(line)) out.push({ body: { kind: 'untapRule', rule: 'none' }, note: 'Nobody untaps' });
  else if (/^creatures with power 3 or greater don't untap during their controllers' untap steps/.test(line)) out.push({ body: { kind: 'untapRule', rule: 'bigCreatures' }, note: "Creatures with power 3 or more don't untap" });
  // Myr Battlesphere: tap the other Myr for power and damage.
  if ((m = line.match(/^you may tap x untapped ([a-z]+) you control/)) && /gets \+x\/\+0 until end of turn and deals x damage to the player/.test(fullLine)) {
    out.push({ body: { kind: 'tapAllies', subtype: subtypeName(m[1]) }, note: `Tap your other untapped ${subtypeName(m[1])}: +X/+0 and X damage to the defending player` });
  }
  // Aetherspouts: attacking creatures go on top or bottom of their owners' libraries.
  if (/^for each attacking creature, its owner puts it on their choice of the top or bottom of their library/.test(line)) {
    out.push({ body: { kind: 'fog', who: 'you', bounce: true, tuck: true }, note: "The creatures attacking you go into their owners' libraries (≈ only those attacking you)" });
  }
}

function parseCost(s: string): ManaCost {
  const cost: ManaCost = { generic: 0, pips: [], x: 0, life: 0 };
  for (const [, sym] of s.matchAll(/\{([^}]+)\}/g)) {
    if (/^\d+$/.test(sym)) cost.generic += parseInt(sym, 10);
    else if (sym === 'x') cost.x++;
    else cost.pips.push(sym.split('/').map((c) => c.toUpperCase()) as Mana[]);
  }
  return cost;
}
