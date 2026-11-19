// The card reader for lockouts, animation and winning or losing the game:
// - lockouts: "activated abilities of creatures can't be activated" (Cursed Totem), "your opponents can't cast
//   spells this turn" (Silence), "creatures lose all abilities" (Dress Down), "can't be countered", "don't cause
//   abilities to trigger" (Hushbringer, Elesh Norn);
// - "isn't a creature" (the Theros gods, Arvinox) and permanents that become creatures (Karn, the Great Creator,
//   Cyberdrive Awakener, Vehicles made creatures without crewing);
// - "you win the game" counts, "you can't lose the game" (Platinum Angel, Phyrexian Unlife) and Pacts.
//
// classify.ts calls in here at four points:
// - lockTrigger(line) reads a whole line this file knows, before the main trigger reader, and returns the
//   trigger it is on with a body that points at what it does (`lockfx#N`). Multi-sentence lines are read whole
//   here so the sentence splitting in classify.ts can't take them apart.
// - recogniseLocks(sentence, out) turns that body, or an effect wording on an ordinary trigger or activated
//   ability ("target land you control becomes an X/X ... creature"), into effects.
// - lockLineHandled(line) names lines that change nothing in this engine.
// - lockValue(effect) is what these effects add to a card's value.
// The engine side is in src/rules/game.ts (search for "Lockouts").

import type { CastFilter, Color, Effect, EffectBody, ManaCost, Trigger, TriggerScope } from './types';

type Found = { body: EffectBody; note: string };
type LockContext = { when: Trigger; scope?: TriggerScope; castFilter?: CastFilter; body: string; loyalty?: number };

/** Static effects from this file: classify.ts keeps them on permanents' static lines. */
export const LOCK_STATIC_KINDS = ['abilityLock', 'castLock', 'uncounterable', 'counterFree', 'loseAbilities', 'triggerLock', 'notCreature', 'cantLose', 'emptyDrawReanimate', 'endSacrifice'];

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, twenty: 20, thirty: 30 };
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w) ? parseInt(w, 10) : WORDS[w] ?? fallback);
const COLOR: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };

/** What whole lines read here do, by number (the `lockfx#N` bodies). */
const REGISTRY: Found[][] = [];
function fx(...found: Found[]): string {
  REGISTRY.push(found);
  return `lockfx#${REGISTRY.length - 1}`;
}
/** The same line always gets the same body, so cards can be read any number of times. */
const SEEN = new Map<string, LockContext | null>();

function parseCost(text: string): ManaCost {
  const cost: ManaCost = { generic: 0, pips: [], x: 0, life: 0 };
  for (const [, sym] of text.matchAll(/\{([^}]+)\}/g)) {
    if (/^\d+$/.test(sym)) cost.generic += parseInt(sym, 10);
    else if (sym === 'x') cost.x++;
    else cost.pips.push(sym.toUpperCase().split('/').filter((s) => 'WUBRGC'.includes(s)) as ManaCost['pips'][number]);
  }
  return cost;
}

/** Lines read whole. Returns null to let classify.ts carry on. */
export function lockTrigger(l: string): LockContext | null {
  if (SEEN.has(l)) return SEEN.get(l)!;
  const ctx = readLine(l);
  SEEN.set(l, ctx);
  return ctx;
}

function readLine(l: string): LockContext | null {
  let m: RegExpMatchArray | null;
  const line = l.replace(/\.$/, '');

  // --- Lockouts -------------------------------------------------------------------
  // Cursed Totem, Linvala, Karn: "activated abilities of creatures (your opponents control) can't be activated".
  if ((m = line.match(/^activated abilities of (creatures|artifacts)( your opponents control)? can't be activated$/))) {
    const perms = m[1] as 'creatures' | 'artifacts';
    const who = m[2] ? 'opponents' as const : 'all' as const;
    return { when: 'static', body: fx({ body: { kind: 'abilityLock', perms, who }, note: `Activated abilities of ${who === 'opponents' ? "opponents' " : ''}${perms} can't be activated (mana abilities too)` }) };
  }
  // Grand Abolisher.
  if (/^during your turn, your opponents can't cast spells or activate abilities of artifacts, creatures, or enchantments$/.test(line)) {
    return { when: 'static', body: fx(
      { body: { kind: 'castLock', who: 'opponents', rule: 'yourTurn' }, note: "Opponents can't cast spells during your turn" },
      { body: { kind: 'abilityLock', perms: 'nonland', who: 'opponents', yourTurn: true }, note: "Opponents can't activate abilities of artifacts, creatures or enchantments during your turn" },
    ) };
  }
  if (/^your opponents can't cast spells this turn$/.test(line)) return { when: 'resolve', body: fx({ body: { kind: 'silence' }, note: "Opponents can't cast spells this turn" }) };
  if (/^your opponents can't cast spells during your turn$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'castLock', who: 'opponents', rule: 'yourTurn' }, note: "Opponents can't cast spells during your turn" }) };
  if (/^each opponent can cast spells only any time they could cast a sorcery$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'castLock', who: 'opponents', rule: 'sorcerySpeed' }, note: 'Opponents cast spells only at sorcery speed' }) };
  if (/^your opponents can't cast spells with even mana values$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'castLock', who: 'opponents', rule: 'evenCmc' }, note: "Opponents can't cast spells with even mana values" }) };
  if (/^each opponent can't cast noncreature spells with mana value greater than the number of lands that player controls$/.test(line)) {
    return { when: 'static', body: fx({ body: { kind: 'castLock', who: 'opponents', rule: 'overLands' }, note: "Opponents can't cast noncreature spells costing more than their land count" }) };
  }
  if (/^players can't cast noncreature spells from graveyards or exile$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'castLock', who: 'all', rule: 'graveyard' }, note: "No one can cast noncreature spells from graveyards" }) };
  // Soulless Jailer: the same lock as Grafdigger's Cage keeps graveyard cards off the battlefield.
  if (/^permanent cards in graveyards can't enter the battlefield$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'graveyardLock' }, note: "Cards in graveyards can't enter the battlefield (≈ also stops casting from graveyards, like Grafdigger's Cage)" }) };
  if (/^each player can't cast more than one non-phyrexian spell each turn$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'castLock', who: 'all', rule: 'oneNonPhyrexian' }, note: 'Each player may cast only one non-Phyrexian spell a turn' }) };
  // "Can't be countered".
  if (/^spells you control can't be countered$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'uncounterable', filter: 'any' }, note: "Your spells can't be countered" }) };
  if (/^creature and enchantment spells you control can't be countered$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'uncounterable', filter: 'creatureOrEnchantment' }, note: "Your creature and enchantment spells can't be countered" }) };
  if ((m = line.match(/^spells with flash you cast cost \{(\d+)\} less to cast and can't be countered$/))) {
    return { when: 'static', body: fx(
      { body: { kind: 'costReduction', amount: parseInt(m[1], 10), filter: 'flash' }, note: `Your spells with flash cost {${m[1]}} less` },
      { body: { kind: 'uncounterable', filter: 'flash' }, note: "Your spells with flash can't be countered" },
    ) };
  }
  // Vexing Bauble, Lavinia ("whenever a player casts" arrives here split into "you" and "an opponent").
  if ((m = line.match(/^whenever (you cast|an opponent casts) a spell, if no mana was spent to cast it, counter that spell$/))) {
    const who = m[1] === 'you cast' ? 'all' as const : 'opponents' as const;
    return { when: 'static', body: fx({ body: { kind: 'counterFree', who }, note: `Counters ${who === 'all' ? 'any' : "opponents'"} spells cast without spending mana` }) };
  }
  // Lose all abilities.
  if (/^creatures lose all abilities$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'loseAbilities', what: 'creatures' }, note: 'Creatures lose all abilities' }) };
  if (/^non-horror creatures with slime counters on them lose all abilities and have base power and toughness 2\/2$/.test(line)) {
    return { when: 'static', body: fx({ body: { kind: 'loseAbilities', what: 'slimed' }, note: 'Slimed non-Horror creatures are vanilla 2/2s' }) };
  }
  // Dress Down, Ball Lightning: "at the beginning of the end step, sacrifice ~" (each end step, whoever's turn it is).
  if (/^at the beginning of the end step, sacrifice ~$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'endSacrifice' }, note: 'Sacrificed at the end step' }) };
  // Tishana's Tidebinder: ≈ the permanent is chosen as it enters, whether or not one of its abilities is on the stack.
  if (/^when ~ enters, counter up to one target activated or triggered ability\. if an ability of an artifact, creature, or planeswalker is countered this way, that permanent loses all abilities for as long as ~ remains on the battlefield/.test(l)) {
    return { when: 'resolve', body: fx({ body: { kind: 'blank', until: 'source' }, note: "An opponent's artifact, creature or planeswalker loses all abilities while this stays (≈ no ability on the stack needed)" }) };
  }
  // Azure Beastbinder.
  if (/^whenever ~ attacks, up to one target artifact, creature, or planeswalker an opponent controls loses all abilities until your next turn\. if it's a creature, it also has base power and toughness 2\/2 until your next turn/.test(l)) {
    return { when: 'attack', scope: 'self', body: fx({ body: { kind: 'blank', until: 'yourNextTurn', size: { p: 2, t: 2 } }, note: "An opponent's artifact, creature or planeswalker loses all abilities (a creature is 2/2) until your next turn" }) };
  }
  // Hushbringer, Elesh Norn.
  if (/^creatures entering or dying don't cause abilities to trigger$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'triggerLock', event: 'creatures', who: 'all' }, note: "Creatures entering or dying don't trigger abilities" }) };
  if (/^permanents entering don't cause abilities of permanents your opponents control to trigger$/.test(line)) {
    return { when: 'static', body: fx({ body: { kind: 'triggerLock', event: 'enters', who: 'opponents' }, note: "Permanents entering don't trigger opponents' abilities" }) };
  }

  // --- "Isn't a creature" and animation -------------------------------------------
  if ((m = line.match(/^as long as your devotion to (white|blue|black|red|green)(?: and (white|blue|black|red|green))? is less than (\w+), ~ isn't a creature$/))) {
    const devotion = [COLOR[m[1]], ...(m[2] ? [COLOR[m[2]]] : [])];
    const n = count(m[3], 5);
    return { when: 'static', body: fx({ body: { kind: 'notCreature', devotion, n }, note: `Not a creature until your devotion to ${devotion.join('')} is ${n}` }) };
  }
  if ((m = line.match(/^~ isn't a creature unless you control (\w+) or more permanents you don't own$/))) {
    const n = count(m[1], 3);
    return { when: 'static', body: fx({ body: { kind: 'notCreature', stolen: true, n }, note: `Not a creature until you control ${n} permanents you don't own` }) };
  }
  // Cacophony Unleashed: "whenever ~ or another enchantment you control enters" arrives split.
  if ((m = l.match(/^whenever another nontoken enchantment you control enters, (until end of turn, ~ becomes .*)$/))) return { when: 'permEnters', castFilter: 'enchantment', body: m[1] };
  // Mobilizer Mech.
  if ((m = l.match(/^whenever ~ becomes crewed,\s*(.*)$/))) return { when: 'crewed', scope: 'self', body: m[1] };

  // --- Winning and losing ------------------------------------------------------------
  if ((m = line.match(/^at the beginning of your upkeep, if (?:you control (\w+) or more (treasures|artifacts)|you have exactly (\w+) cards in your hand), you win the game$/))) {
    const found: Found = m[2]
      ? { body: { kind: 'winIf', cond: m[2] as 'treasures' | 'artifacts', n: count(m[1], 10) }, note: `You win with ${count(m[1], 10)} or more ${m[2]}` }
      : { body: { kind: 'winIf', cond: 'handExactly', n: count(m[3], 13) }, note: `You win with exactly ${count(m[3], 13)} cards in hand` };
    return { when: 'upkeep', body: fx(found) };
  }
  if ((m = line.match(/^whenever ~ attacks, you win the game if there are (\w+) or more counters on it or you have (\w+) or more cards in hand$/))) {
    const n = count(m[1], 20);
    const hand = count(m[2], 20);
    return { when: 'attack', scope: 'self', body: fx({ body: { kind: 'winIf', cond: 'counters', n, orHand: hand }, note: `You win with ${n} counters on it or ${hand} cards in hand` }) };
  }
  if (/^you can't lose the game and your opponents can't win the game$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'cantLose', opponentsCantWin: true }, note: "You can't lose and your opponents can't win" }) };
  if (/^you don't lose the game for having 0 or less life$/.test(line)) return { when: 'static', body: fx({ body: { kind: 'cantLose', lifeOnly: true }, note: "You don't lose for having 0 or less life" }) };
  if (/^as long as ~ is attached to a creature, you don't lose the game for having 0 or less life$/.test(line)) {
    return { when: 'static', body: fx({ body: { kind: 'cantLose', lifeOnly: true, attached: true }, note: "While attached: you don't lose for having 0 or less life" }) };
  }
  if (/^as long as you have 0 or less life, all damage is dealt to you as though its source had infect/.test(line)) {
    return { when: 'static', body: fx({ body: { kind: 'cantLose', lifeOnly: true, infect: true }, note: 'At 0 or less life, damage to you is poison counters (≈ all life loss)' }) };
  }
  if ((m = line.match(/^at the beginning of your next upkeep, pay ((?:\{[^}]+\})+)\. if you don't, you lose the game$/))) {
    const cost = parseCost(m[1]);
    return { when: 'resolve', body: fx({ body: { kind: 'pact', cost }, note: `Next upkeep: pay ${m[1].toUpperCase()} or lose the game` }) };
  }
  if (/^if you would draw a card while your library has no cards in it, instead return a creature card from your graveyard to the battlefield\. if you can't, you lose the game$/.test(line)) {
    return { when: 'static', body: fx({ body: { kind: 'emptyDrawReanimate' }, note: 'Drawing from an empty library returns a creature from your graveyard instead' }) };
  }

  // --- Planeswalker abilities read whole ------------------------------------------
  if ((m = l.match(/^([+-]\d+): (until your next turn, up to one target noncreature artifact becomes an artifact creature with power and toughness each equal to its mana value|artifacts you control become artifact creatures with base power and toughness (\d+)\/(\d+) until end of turn|target creature becomes a treasure artifact with .* and loses all other card types and abilities)\.?$/))) {
    const loyalty = parseInt(m[1], 10);
    const found = m[3]
      ? becomes('artifacts', { p: +m[3], t: +m[4] }, [], 'eot')
      : /treasure/.test(m[2])
        ? { body: { kind: 'becomeTreasure' } as EffectBody, note: 'A creature becomes a Treasure (≈ removed; its controller gets a Treasure)' }
        : becomes('artifact', 'cmc', [], 'yourNextTurn');
    return { when: 'loyalty', loyalty, body: fx(found) };
  }
  return null;
}

function becomes(what: Extract<EffectBody, { kind: 'becomeCreature' }>['what'], size: Extract<EffectBody, { kind: 'becomeCreature' }>['size'], keywords: string[], until: 'eot' | 'yourNextTurn' | 'sacAtEnd'): Found {
  const label: Record<string, string> = {
    self: 'This', artifact: 'A noncreature artifact', artifacts: 'Your noncreature artifacts', vehicle: 'A Vehicle', vehicles: 'Your Vehicles', land: 'A land you control', treasures: 'Your Treasures',
  };
  const many = what.endsWith('s');
  const sz = size === undefined ? '' : size === 'cmc' ? '' : size === 'enchantments' ? ' X/X' : ` ${size.p}/${size.t}`;
  const after = size === 'cmc' ? ' with P/T equal to its mana value' : size === 'enchantments' ? ' (X = your enchantments)' : '';
  const kw = keywords.length ? ` with ${keywords.join(', ')}` : '';
  const end = until === 'eot' ? 'until end of turn' : until === 'yourNextTurn' ? 'until your next turn' : 'and are sacrificed at the end step';
  const body = many ? `become${sz} creatures` : `becomes a${sz} creature`;
  return { body: { kind: 'becomeCreature', what, ...(size !== undefined ? { size } : {}), ...(keywords.length ? { keywords } : {}), until }, note: `${label[what]} ${body}${after}${kw} ${end}` };
}

const KEYWORDS = ['flying', 'haste', 'trample', 'menace', 'deathtouch', 'vigilance', 'lifelink', 'infect'];
function keywordsIn(text: string): string[] {
  return KEYWORDS.filter((k) => new RegExp(`\\b${k}\\b`).test(text));
}

/** Effects for a sentence (or a `lockfx#N` body from lockTrigger). */
export function recogniseLocks(line: string, out: Found[], fullLine = line) {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^lockfx#(\d+)$/))) {
    out.push(...REGISTRY[parseInt(m[1], 10)]);
    return;
  }
  // Sludge Monster.
  if (/^put a slime counter on up to one other target creature/.test(line)) {
    out.push({ body: { kind: 'slime' }, note: 'A slime counter on another creature' });
    return;
  }
  // Argent Mutation, Liquimetal Torque.
  if (/^target (nonland )?permanent becomes an artifact in addition to its other types until end of turn/.test(line)) {
    out.push({ body: { kind: 'becomeArtifact' }, note: 'A permanent becomes an artifact until end of turn' });
    return;
  }
  // --- Becoming creatures ----------------------------------------------------------
  const kws = keywordsIn(line);
  // Cyberdrive Awakener, Depthshaker Titan.
  if ((m = line.match(/^(?:each|any number of target) noncreature artifacts? you control becomes? (?:a )?(\d+)\/(\d+) artifact creatures?(?: until end of turn)?/))) {
    const sac = /sacrifice them at the beginning of the next end step/.test(fullLine);
    out.push(becomes('artifacts', { p: +m[1], t: +m[2] }, kws, sac ? 'sacAtEnd' : 'eot'));
    return;
  }
  // Katsumasa.
  if ((m = line.match(/^until end of turn, target noncreature artifact you control becomes an artifact creature(?: and gains ([a-z]+))?/))) {
    const size = /base power and toughness 1\/1/.test(fullLine) ? { p: 1, t: 1 } : undefined;
    out.push(becomes('artifact', size, m[1] ? [m[1]] : [], 'eot'));
    return;
  }
  // Destiny Spinner.
  if (/^target land you control becomes an x\/x [a-z ]*creature .*until end of turn, where x is the number of enchantments you control/.test(line)) {
    out.push(becomes('land', 'enchantments', kws, 'eot'));
    return;
  }
  // Peacewalker Colossus, Mobilizer Mech, Chandra, Spark Hunter, Armed and Armored.
  if (/^(?:up to one )?(?:another |other )?target vehicle you control becomes an artifact creature until end of turn/.test(line)) {
    out.push(becomes('vehicle', undefined, kws, 'eot'));
    return;
  }
  if (/^choose up to one target vehicle you control\.?$/.test(line) && (m = fullLine.match(/until end of turn, it becomes an artifact creature(?: and gains ([a-z]+))?/))) {
    out.push(becomes('vehicle', undefined, m[1] ? [m[1]] : [], 'eot'));
    return;
  }
  if (/^vehicles you control become artifact creatures until end of turn/.test(line)) {
    out.push(becomes('vehicles', undefined, [], 'eot'));
    return;
  }
  // Bespoke Battlewagon, Cacophony Unleashed.
  if (/^~ becomes an artifact creature until end of turn/.test(line)) {
    out.push(becomes('self', undefined, [], 'eot'));
    return;
  }
  if ((m = line.match(/^until end of turn, ~ becomes a (?:legendary )?(\d+)\/(\d+) [a-z ]*creature/))) {
    out.push(becomes('self', { p: +m[1], t: +m[2] }, kws, 'eot'));
    return;
  }
  // Vihaan.
  if ((m = line.match(/^you may have treasures you control become (\d+)\/(\d+) [a-z ]*artifact creatures in addition to their other types until end of turn/))) {
    out.push(becomes('treasures', { p: +m[1], t: +m[2] }, [], 'eot'));
  }
}

/** Lines that change nothing in this engine. */
export function lockLineHandled(line: string): boolean {
  // Bring the Ending: the engine's "counter unless they pay" always counters, so the corrupted version is already what happens.
  return /^corrupted — counter that spell instead if its controller has three or more poison counters/.test(line)
    // Armed and Armored: the equipment part rides along with the Vehicles (≈ not modeled).
    || /^choose a dwarf you control\. attach any number of equipment you control to it/.test(line)
    || /^it's still (a land|an enchantment)\.?$/.test(line)
    || /^until end of turn, it becomes an artifact creature and gains [a-z]+\.?$/.test(line);
}

/** What these effects add to a card's value (see cardValue in classify.ts). */
export function lockValue(e: Effect, mult: number): number {
  switch (e.kind) {
    case 'abilityLock': return e.who === 'opponents' ? 3 : 1.5;
    case 'castLock': return e.rule === 'all' || e.rule === 'yourTurn' || e.rule === 'sorcerySpeed' ? 3 : 2;
    case 'silence': return 2;
    case 'uncounterable': return 1;
    case 'counterFree': return 1.5;
    case 'loseAbilities': return 2;
    case 'blank': return 2 * mult;
    case 'slime': return 1 * mult;
    case 'triggerLock': return 2;
    case 'notCreature': return -3;
    case 'becomeCreature': return (e.what === 'self' ? 1 : 2) * (e.when === 'activated' ? 1 : mult);
    case 'becomeArtifact': return 0.2;
    case 'becomeTreasure': return 3;
    case 'winIf': return 4;
    case 'cantLose': return e.opponentsCantWin ? 5 : 2;
    case 'pact': return -1;
    case 'emptyDrawReanimate': return 1;
    case 'endSacrifice': return -1;
    default: return 0;
  }
}
