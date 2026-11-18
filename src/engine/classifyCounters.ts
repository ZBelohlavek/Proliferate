// Counters of every kind, station (Spacecraft and Planets) and additional
// combat phases, for the card reader.
//
// classify.ts calls in here:
// - rewriteCounters(text) once on the whole text: counters a permanent keeps
//   on itself (quest, oil, loot, foreshadow ...) are read as charge counters,
//   which the engine already tracks, and the name is kept for the notes.
// - counterTrigger(line) for trigger wordings classify.ts has no rule for.
// - recogniseCounters(sentence, out, fullLine) on every sentence.
// - stationTier(line) for "8+ | Flying" lines (rule 702.184).
// - counterLineHandled(line) for lines that need no effect of their own.

import type { CastFilter, EffectBody, Trigger, TriggerScope } from './types';

type Found = { body: EffectBody; note: string; chance?: number };
type CounterContext = { when: Trigger; scope?: TriggerScope; castFilter?: CastFilter; body: string; chance?: number; oncePerTurn?: boolean };

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, twenty: 20, x: -1, 'that many': -1,
};
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w.trim()) ? parseInt(w, 10) : WORDS[w.trim()] ?? fallback);

/**
 * Counters a permanent puts on itself and spends or counts later. They behave
 * exactly like charge counters (rule 122.1: a counter's name only matters to
 * the abilities that refer to it), so the reader reads them as charge counters.
 */
const SELF_COUNTERS = ['quest', 'oil', 'loot', 'foreshadow', 'night', 'eon', 'storage', 'stash', 'point', 'blessing', 'film', 'fire', 'growth', 'ice', 'page', 'verse', 'gem', 'wish', 'fuse', 'study', 'brick', 'fade', 'pressure', 'feather', 'hatchling'];

/** The name of the self counters a card uses, if any, and its text with them called charge counters. */
export function rewriteCounters(text: string): { text: string; name?: string } {
  for (const name of SELF_COUNTERS) {
    const re = new RegExp(`\\b${name} counters?\\b`, 'g');
    if (!re.test(text)) continue;
    // Only counters on the card itself ("on ~", "from ~", "~ has ... counters", "remove them all").
    if (!new RegExp(`${name} counters? (on|from) ~|~ (has|enters with) [^.]*${name} counters?|${name} counters? on it\\b`).test(text)) continue;
    return { text: text.replace(new RegExp(`\\ban ${name} counter\\b`, 'g'), `a ${name} counter`).replace(new RegExp(`\\b${name} (counters?)\\b`, 'g'), 'charge $1'), name };
  }
  return { text };
}

/** "8+ | Flying": a station threshold (rule 702.184c). Returns the threshold and the rest of the line. */
export function stationTier(line: string): { n: number; rest: string } | null {
  const m = line.match(/^(\d+)\+ \| (.*)$/);
  return m ? { n: parseInt(m[1], 10), rest: m[2] } : null;
}

/** Keywords a station threshold grants on a line of their own ("8+ | flying, deathtouch"). */
export function tierKeywords(rest: string): string[] | null {
  const KW = ['flying', 'deathtouch', 'trample', 'vigilance', 'haste', 'lifelink', 'first strike', 'double strike', 'menace', 'reach', 'hexproof', 'indestructible'];
  const parts = rest.replace(/\.$/, '').split(/,\s*/);
  return parts.every((p) => KW.includes(p)) ? parts : null;
}

/** Intervening "if ~ has N or more charge counters on it" (rule 603.4): the number, and the body without it. */
export function chargeCondition(body: string): { min: number; body: string } | null {
  const m = body.match(/^(?:if|as long as) (?:~|it) has (\w+) or more charge counters on it, (.*)$/);
  return m ? { min: count(m[1], 1), body: m[2] } : null;
}

/**
 * "Then if it has eight or more charge counters on it, remove all of them and ...": checked as the ability
 * resolves, after the counter it just added. Returns the threshold, whether the counters go, and the rest.
 */
export function chargeThenCondition(sentence: string): { n: number; reset: boolean; rest: string } | null {
  const m = sentence.match(/^then if (?:it|~) has (\w+) or more charge counters on it, (remove (?:them all|all of them|those counters) and |you may )?(.*)$/);
  if (!m) return null;
  // Replicating Ring: eight mana rings, kept as Treasures.
  const rest = m[3].replace(/^create eight colorless snow artifact tokens named replicated ring with\s*\.?$/, 'create eight treasure tokens.');
  return { n: count(m[1], 1), reset: !!m[2] && m[2].startsWith('remove'), rest };
}

/** Trigger wordings classify.ts doesn't know. */
export function counterTrigger(l: string): CounterContext | null {
  let m: RegExpMatchArray | null;
  // Bloodchief Ascension's quest counters are counted by the engine (see Game.questCounters).
  if (/^at the beginning of each end step, if an opponent lost 2 or more life this turn, you may put a charge counter on ~/.test(l)) return { when: 'static', body: '' };
  // Vat of Rebirth, Tarrian's Soulcleaver: mostly creatures dying.
  if ((m = l.match(/^whenever (?:another|an?) artifact or creature (?:you control )?is put into a graveyard from the battlefield,\s*(.*)$/))) return { when: 'creatureDies', scope: /you control/.test(l) ? undefined : 'all', body: m[1] };
  // Crimes (rule 700.13): targeting an opponent or what they have. Kept as about half the spells you cast.
  if ((m = l.match(/^whenever you commit a crime,\s*(.*)$/))) return { when: 'cast', castFilter: 'any', body: m[1], chance: 0.5 };
  // Full Throttle: the untapping is part of the spell.
  if (/^at the beginning of each combat this turn, untap all creatures that attacked this turn/.test(l)) return { when: 'resolve', body: 'untap attackers at each combat' };
  // Genji Glove: only the first combat makes another one.
  if ((m = l.match(/^whenever equipped creature attacks, if it's the first combat phase of the turn, untap it\. (after this phase, there is an additional combat phase)\.?$/))) {
    return { when: 'attack', scope: 'self', body: `${m[1]} the first time` };
  }
  // Goldspan Dragon: the granted ability is in quotes, which the reader drops.
  if (/^treasures you control have "\{t\}, sacrifice ~: add two mana of any one color\."?"?$/.test(l)) return { when: 'static', body: 'treasures you control tap for two mana' };
  // Shay Cormac.
  if ((m = l.match(/^whenever a creature an opponent controls becomes the target of a spell or ability you control,\s*(.*)$/))) return { when: 'static', body: `bounty on target: ${m[1]}` };
  // Bounty Board, Shay Cormac: what a bounty pays.
  if ((m = l.match(/^whenever a creature with a bounty counter on it dies,\s*(.*)$/))) return { when: 'static', body: `bounty payout: ${m[1]}` };
  // Fear of Sleep Paralysis: rooms are rare; enchantments entering is the trigger.
  if ((m = l.match(/^whenever ~ or another enchantment you control enters and whenever you fully unlock a room,\s*(.*)$/))) return { when: 'permEnters', castFilter: 'enchantment', body: m[1] };
  // Laelia: her own attack exiles the top card of the library.
  if ((m = l.match(/^whenever one or more cards are put into exile from your library and\/or your graveyard,\s*(.*)$/))) return { when: 'attack', scope: 'self', body: m[1] };
  // Honored Dreyleader and friends: some of what enters is the right type.
  if ((m = l.match(/^whenever another (squirrel|food|squirrel or food) you control enters,\s*(.*)$/))) return { when: 'creatureEnters', body: m[2], chance: 0.4 };
  // Rapacious Guest.
  if ((m = l.match(/^whenever you sacrifice a food,\s*(.*)$/))) return { when: 'sacrifice', body: m[1], chance: 0.5 };
  // Simic Ascendancy, Knighted Myr: "whenever one or more +1/+1 counters are put on ...".
  if ((m = l.match(/^whenever one or more \+1\/\+1 counters are put on (~|a creature you control|a permanent you control|another creature you control),\s*(.*)$/))) {
    return { when: 'countersPut', scope: m[1] === '~' ? 'self' : 'any', body: m[2] };
  }
  return null;
}

/** `line` is one sentence; `fullLine` is the whole ability. */
export function recogniseCounters(line: string, out: Found[], fullLine: string) {
  let m: RegExpMatchArray | null;

  // --- Additional combat phases ------------------------------------------------
  // Illusionist's Gambit (an extra combat in which the attackers must turn on someone else) isn't modelled.
  if ((m = line.match(/there(?: is| are|'s) (an|two|three) additional combat phases?|there is an additional combat phase after this phase/)) && !/remove all attacking creatures from combat/.test(fullLine)) {
    const n = count(m[1], 1);
    const main = /followed by an additional main phase/.test(line);
    const lastMain = /^after the second main phase/.test(line);
    const inCombat = /if it's your combat phase/.test(line);
    const firstOnly = /the first time$/.test(line);
    const untapAttacked = /at the beginning of that combat, untap all creatures that attacked this turn/.test(fullLine);
    out.push({
      body: { kind: 'extraCombat', n, ...(main ? { main } : {}), ...(lastMain ? { after: 'lastMain' as const } : {}), ...(inCombat ? { inCombat } : {}), ...(firstOnly ? { firstOnly } : {}), ...(untapAttacked ? { untapAttacked } : {}) },
      note: `${n === 1 ? 'An additional combat phase' : `${n} additional combat phases`}${main ? ' and main phase' : ''}${firstOnly ? ' (first combat only)' : ''}${inCombat ? ' (during your combat)' : ''}`,
    });
  }
  // --- Poison counters (rule 122.1f) -----------------------------------------------
  if ((m = line.match(/^(each opponent|each player|target player|target opponent) gets? (a|an|one|two|three|\w+) poison counters?/))) {
    const who = m[1] === 'each opponent' ? 'opponents' : m[1] === 'each player' ? 'each' : 'target';
    const n = count(m[2], 1);
    out.push({ body: { kind: 'poison', n, who }, note: `${who === 'opponents' ? 'Each opponent gets' : who === 'each' ? 'Each player gets' : 'A player gets'} ${n} poison counter${n > 1 ? 's' : ''}` });
    // Phyresis Outbreak: then their creatures shrink for each poison counter.
    if (/then each creature your opponents control gets -1\/-1 until end of turn for each poison counter/.test(fullLine)) out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount: 1, oneSided: true, shrink: 'temp' }, note: 'One-sided shrink (≈ -1/-1)' });
  }
  // --- Keyword counters (rule 122.1b) ------------------------------------------------
  if ((m = line.match(/^put an? (indestructible|flying|first strike|deathtouch|lifelink|trample|vigilance|menace|hexproof|reach) counter on (~|target god|target creature you control)/))) {
    out.push({ body: { kind: 'kwCounter', kw: m[1], on: m[2] === '~' ? 'self' : 'yours' }, note: `${m[1][0].toUpperCase()}${m[1].slice(1)} counter on ${m[2] === '~' ? 'itself' : 'a creature you control'}` });
  }
  // --- Bounty counters --------------------------------------------------------------
  if (/^bounty on target: put a bounty counter on that creature/.test(line)) out.push({ body: { kind: 'bountyOnTarget' }, note: 'Bounty counter on each opposing creature you target' });
  if ((m = line.match(/^bounty payout: (?:each of its controller's opponents draws a card and gains 2 life|put (two|three|a) \+1\/\+1 counters? on ~)/))) {
    const n = m[1] ? count(m[1], 2) : 0;
    out.push({ body: { kind: 'bountyPayout', what: m[1] ? 'counters' : 'drawGain', n }, note: m[1] ? `When a creature with a bounty counter dies: ${n} +1/+1 counters on itself` : "When a creature with a bounty counter dies: its controller's opponents draw 1 and gain 2" });
  }
  if (/^destroy target creature with a bounty counter on it/.test(line)) {
    for (let i = out.length - 1; i >= 0; i--) if (out[i].body.kind === 'removal') out.splice(i, 1);
    out.push({ body: { kind: 'removal', target: 'creature', mode: 'destroy', amount: 0, bountyOnly: true }, note: 'Destroy a creature with a bounty counter' });
  }
  if (/^put a \+1\/\+1 counter on each artifact creature you control/.test(line)) out.push({ body: { kind: 'counters', n: 1, all: true, artifact: true }, note: '+1/+1 counter on each artifact creature you control' });
  if ((m = line.match(/^put (a|an|one|two|three) loyalty counters? on (~|\w+)\.?$/))) out.push({ body: { kind: 'loyaltyUp', n: count(m[1], 1) }, note: `${count(m[1], 1)} loyalty counter${count(m[1], 1) > 1 ? 's' : ''} on itself` });
  if ((m = line.match(/^double the number of each kind of counter on (any number of target permanents|target permanent)/))) {
    out.push({ body: { kind: 'doubleCounters', on: m[1] === 'target permanent' ? 'best' : 'yours' }, note: m[1] === 'target permanent' ? 'Double the counters on one of your permanents' : 'Double the counters on your permanents' });
  }
  // Midnight Banshee: a -1/-1 counter on each nonblack creature (its own deck is black: kept one-sided).
  if (/^put a -1\/-1 counter on each nonblack creature/.test(line)) out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount: 1, oneSided: true, shrink: 'counters' }, note: "A -1/-1 counter on each nonblack creature (≈ opponents')" });
  // Fated Firepower, Solphim.
  if (/^if a source you control would deal damage to an opponent or a permanent an opponent controls, it deals that much damage plus an amount of damage equal to the number of charge counters on ~ instead/.test(line)) {
    out.push({ body: { kind: 'damageBonus', perCharge: true }, note: 'Your damage to opponents gets +1 for each counter on it' });
  }
  if (/^if a source you control would deal noncombat damage to an opponent or a permanent an opponent controls, it deals double that damage/.test(line)) {
    out.push({ body: { kind: 'damageBonus', double: true, noncombat: true }, note: 'Your noncombat damage to opponents is doubled' });
  }
  // Tarrian's Soulcleaver: the equipped creature (≈ one of your creatures).
  if (/^put a \+1\/\+1 counter on equipped creature/.test(line)) out.push({ body: { kind: 'counters', n: 1, all: false }, note: '+1/+1 counter on the equipped creature' });
  // --- Aether Spike, Wrath of the Skies, Goldspan Dragon, granted ward ------------------------
  if (/^counter that spell unless its controller pays \{1\} for each \{e\} paid this way/.test(line)) out.push({ body: { kind: 'counter', target: 'any' }, note: 'Counter a spell unless they pay {1} for each energy paid (≈ hard counter)' });
  if (/^destroy each artifact, creature, and enchantment with mana value less than or equal to the amount of \{e\} paid this way/.test(line)) {
    out.push({ body: { kind: 'wipe', target: 'nonland', mode: 'destroy', amount: 0, oneSided: false, byEnergy: true }, note: 'Destroy each artifact, creature and enchantment with mana value up to the energy paid' });
  }
  if (/^treasures you control tap for two mana/.test(line)) out.push({ body: { kind: 'treasureBoost' }, note: 'Your Treasures tap for two mana' });
  if ((m = line.match(/^(?:each )?other (\w+?)s? you control gets? \+(\d+)\/\+(\d+) and ha(?:s|ve) ward \{\d\}/))) {
    out.push({ body: { kind: 'anthem', p: parseInt(m[2], 10), t: parseInt(m[3], 10), keywords: ['ward'], other: true }, note: `Other ${m[1]}s get +${m[2]}/+${m[3]} and ward (≈ all your creatures)` });
  }
  if (/^as long as enchanted creature is legendary, it gets \+1\/\+1 and has ward/.test(line)) out.push({ body: { kind: 'equip', p: 1, t: 1, keywords: ['ward'], aura: true }, note: 'Aura: +1/+1 and ward on a legendary creature' });
  // Yuna: "during your turn, ~ and enchantment creatures you control have trample, lifelink, and ward {2}".
  if (/^during your turn, ~ and enchantment creatures you control have trample, lifelink, and ward/.test(line)) out.push({ body: { kind: 'anthem', p: 0, t: 0, keywords: ['trample', 'lifelink', 'ward'], only: 'enchantment' }, note: 'Your enchantment creatures have trample, lifelink and ward (≈ always)' });
  // Adapt N (rule 701.46): +1/+1 counters on itself if it has none.
  if ((m = line.match(/^adapt (\d+)/))) out.push({ body: { kind: 'counters', n: parseInt(m[1], 10), all: false }, note: `Adapt ${m[1]}` });

  // --- Charge counters ------------------------------------------------------------
  // Simic Ascendancy: "put that many growth counters on ~".
  if (/^put that many charge counters on ~/.test(line)) out.push({ body: { kind: 'charge', n: -1 }, note: 'That many charge counters on itself' });
  if (/^you win the game\.?$/.test(line)) out.push({ body: { kind: 'winGame' }, note: 'You win the game' });
  if (/^that player loses the game\.?$/.test(line)) out.push({ body: { kind: 'loseGame' }, note: 'That player loses the game' });
  // Boon of the Spirit Realm: the anthem grows with the counters.
  if (/get \+1\/\+1 for each charge counter on ~/.test(line)) for (const f of out) if (f.body.kind === 'anthem') {
    f.body.perCharge = true;
    f.note = 'Your creatures get +1/+1 for each counter on it';
  }
  // Inspirit: "your choice of a +1/+1 counter or two charge counters on up to one other target artifact".
  if (/^put your choice of a \+1\/\+1 counter or two charge counters on (?:up to one )?other target artifact/.test(line)) {
    out.push({ body: { kind: 'charge', n: 2, target: 'artifact', orCounter: true }, note: 'Two charge counters or a +1/+1 counter on another artifact' });
  }
  if (/^untap attackers at each combat$|^at the beginning of that combat, untap all creatures that attacked this turn/.test(line)) {
    // World at War: this sentence isn't an untap now; the creatures untap as the extra combat begins.
    for (let i = out.length - 1; i >= 0; i--) if (out[i].body.kind === 'untap') out.splice(i, 1);
    if (/^untap attackers/.test(line)) out.push({ body: { kind: 'extraCombat', n: 0, untapAttacked: true }, note: 'Creatures that attacked untap at the beginning of each combat this turn' });
  }
}

/** Lines that need no effect of their own. */
export function counterLineHandled(line: string): boolean {
  return /^station$|^rebound$/.test(line);
}
