// Turns a card's oracle text into a SimCard the engine can play.
//
// This is pattern matching, not a rules engine: each line of oracle text is
// checked against regular expressions for common EDH effects (ramp, draw,
// removal, wipes, tokens, ...). Lines we don't recognise are ignored. The
// `notes` list records what we understood so users can audit their decks.

import type {
  CastFilter,
  Color,
  Effect,
  EffectBody,
  LandInfo,
  Mana,
  ManaCost,
  RemovalTarget,
  SimCard,
  Trigger,
  TriggerScope,
} from './types';

/** Card data normalised from either Archidekt or Scryfall. */
export interface RawCard {
  name: string;
  manaCost: string;
  cmc: number;
  types: string[];
  superTypes: string[];
  subTypes: string[];
  text: string;
  power?: string | null;
  toughness?: string | null;
  keywords: string[];
  colorIdentity: Color[];
  /** Mana a land can produce, if the data source tells us. */
  producedMana?: Mana[];
  layout?: string;
  back?: { name: string; types: string[]; subTypes: string[]; text: string } | null;
  imageUrl?: string;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  x: -1, 'that many': 2, 'a number of': 2,
};

function num(word: string | undefined, fallback = 1): number {
  if (word === undefined) return fallback;
  const w = word.trim().toLowerCase();
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return NUMBER_WORDS[w] ?? fallback;
}

const NUM = '(a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\\d+|that many|a number of)';

const BASIC_LAND_TYPES: Record<string, Mana> = {
  plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G', wastes: 'C',
};

const KNOWN_KEYWORDS = [
  'flying', 'trample', 'haste', 'vigilance', 'deathtouch', 'lifelink', 'menace', 'first strike',
  'double strike', 'indestructible', 'hexproof', 'shroud', 'reach', 'defender', 'flash', 'ward',
];

// ---------------------------------------------------------------------------
// Mana cost parsing
// ---------------------------------------------------------------------------

export function parseManaCost(cost: string): ManaCost {
  const result: ManaCost = { generic: 0, pips: [], x: 0, life: 0 };
  const symbols = cost.match(/\{[^}]+\}/g) ?? [];
  for (const raw of symbols) {
    const s = raw.slice(1, -1).toUpperCase();
    if (/^\d+$/.test(s)) result.generic += parseInt(s, 10);
    else if (s === 'X') result.x += 1;
    else if (s === 'C') result.pips.push(['C']);
    else if ('WUBRG'.includes(s) && s.length === 1) result.pips.push([s as Color]);
    else if (s.includes('/P')) result.life += 2; // Phyrexian: always pay life
    else if (s.includes('/')) {
      // Hybrid like G/U, or 2/W (which we treat as the colored half).
      const parts = s.split('/').filter((p) => 'WUBRG'.includes(p) && p.length === 1) as Color[];
      if (parts.length) result.pips.push(parts);
      else result.generic += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Lowercase, strip reminder text, and replace the card's own name with "~". */
export function normaliseText(name: string, text: string): string {
  let t = text.toLowerCase().replace(/\([^)]*\)/g, '');
  const names = name.toLowerCase().split(' // ');
  for (const full of names) {
    t = t.split(full).join('~');
    const short = full.split(',')[0];
    if (short.length > 3 && short !== full) t = t.split(short).join('~');
  }
  t = t.replace(
    /\bthis (creature|artifact|enchantment|land|permanent|planeswalker|spell|card|vehicle|equipment|aura|token)\b/g,
    '~',
  );
  return t.replace(/−/g, '-');
}

function parseProduced(addText: string): { amount: number; colors: Mana[] | 'any' } | null {
  const t = addText.trim();
  if (/(one|two|three) mana of any (one )?(color|type)|mana of any color|any combination of colors/.test(t)) {
    const m = t.match(/^(one|two|three|x)/);
    return { amount: Math.max(1, num(m?.[1], 1)), colors: 'any' };
  }
  const syms = t.match(/^((\{[wubrgc]\})+)(( or | and\/or |, )(\{[wubrgc]\})+)*/);
  if (!syms) {
    // "add {c} for each ..." etc: count the first symbol group only.
    const first = t.match(/\{([wubrgc])\}/);
    if (!first) return null;
    return { amount: 1, colors: [first[1].toUpperCase() as Mana] };
  }
  const groups = syms[0].split(/ or | and\/or |, /);
  // "{G}{G}" -> 2 mana of G. "{G} or {U}" -> 1 mana, choice of colors.
  const amount = Math.max(...groups.map((g) => (g.match(/\{/g) ?? []).length));
  const colors = new Set<Mana>();
  for (const g of groups) for (const m of g.matchAll(/\{([wubrgc])\}/g)) colors.add(m[1].toUpperCase() as Mana);
  return { amount, colors: [...colors] };
}

function parseKeywords(raw: RawCard, text: string): string[] {
  const kws = new Set<string>();
  for (const k of raw.keywords) {
    const lk = k.toLowerCase();
    if (KNOWN_KEYWORDS.includes(lk)) kws.add(lk);
  }
  // Keyword lines at the start of the oracle text, e.g. "flying, vigilance".
  for (const line of text.split('\n')) {
    const parts = line.split(/,\s*/).map((p) => p.trim().replace(/ \{.*$/, ''));
    if (parts.every((p) => KNOWN_KEYWORDS.includes(p) || p.startsWith('ward'))) {
      for (const p of parts) kws.add(p.startsWith('ward') ? 'ward' : p);
    }
  }
  if (/~ can't be blocked(\.|$)/m.test(text)) kws.add('unblockable');
  return [...kws];
}

// ---------------------------------------------------------------------------
// Effect recognisers. Each takes one sentence/line and returns effects found.
// ---------------------------------------------------------------------------

type Found = { body: EffectBody; note: string };

function removalTargetOf(phrase: string): RemovalTarget | null {
  if (/nonland permanent|target permanent|target ([\w-]+ )?permanent/.test(phrase)) return 'permanent';
  if (/creature or planeswalker|target ([\w-]+ ){0,2}creature(?! card)|creature an opponent controls|creature you don't control/.test(phrase)) return 'creature';
  if (/artifact or enchantment|target artifact|target enchantment|artifact, enchantment/.test(phrase)) return 'artifactEnchantment';
  if (/noncreature/.test(phrase)) return 'noncreature';
  if (/planeswalker/.test(phrase)) return 'planeswalker';
  return null;
}

/** `line` is one sentence; `fullLine` is the whole ability, for context that spans sentences. */
function recogniseEffects(line: string, card: { isPermanent: boolean; isCreature: boolean }, fullLine = line): Found[] {
  const out: Found[] = [];
  let m: RegExpMatchArray | null;

  // --- Ramp: search for basic lands onto the battlefield -----------------
  m = line.match(new RegExp(`search your library for (up to )?${NUM} (basic land|land|basic \\w+|forest|plains|island|swamp|mountain)[^.]*? cards?`));
  if (m && /battlefield/.test(line)) {
    const n = num(m[2], 1);
    const tapped = /battlefield tapped/.test(line);
    let lands = n;
    let toHand = 0;
    if (/put one onto the battlefield[^.]*and the other into your hand/.test(line)) {
      lands = 1;
      toHand = 1;
    }
    out.push({ body: { kind: 'ramp', lands: Math.max(lands, 1), toHand, tapped }, note: `Ramp: ${lands} land${lands > 1 ? 's' : ''} to battlefield${toHand ? ' + 1 to hand' : ''}` });
  } else if (/search your library for (a|an|up to one|one) [^.]*card/.test(line) && !/land card/.test(line)) {
    out.push({ body: { kind: 'tutor' }, note: 'Tutor' });
  } else if (/search your library for [^.]*land cards?[^.]*hand/.test(line)) {
    out.push({ body: { kind: 'draw', n: 1 }, note: 'Land to hand (≈ draw 1)' });
  }

  if (/put (a|up to one) land card from your hand onto the battlefield|you may play an additional land/.test(line)) {
    out.push({ body: { kind: 'extraLand' }, note: 'Extra land drop' });
  }

  // --- Card draw -----------------------------------------------------------
  m = line.match(new RegExp(`(?:you |target player |each player )?draws? ${NUM} (additional )?cards?`));
  if (m && !/opponent draws|that player draws|each opponent draws/.test(line)) {
    const n = num(m[1], 1);
    out.push({ body: { kind: 'draw', n }, note: `Draw ${n === -1 ? 'X' : n}` });
  } else if (/draw cards equal to|draws cards equal to/.test(line)) {
    out.push({ body: { kind: 'draw', n: 3 }, note: 'Draw (≈3)' });
  } else if ((m = line.match(/put (two|three|four|\d) of (them|those cards) into your hand/))) {
    const n = num(m[1], 2);
    out.push({ body: { kind: 'draw', n }, note: `Dig for ${n}` });
  } else if (/exile the top (card|two cards|three cards) of your library[^.]*(you may play|you may cast)/.test(line)) {
    const n = /three/.test(line) ? 3 : /two/.test(line) ? 2 : 1;
    out.push({ body: { kind: 'draw', n }, note: `Impulse draw ${n}` });
  }

  // --- Board wipes ---------------------------------------------------------
  m = line.match(/(destroy|exile) all (other |non-?\w+ )?(creatures|nonland permanents|artifacts, creatures|creatures and planeswalkers|artifacts and creatures|creatures your opponents control|creatures you don't control|nonland permanents your opponents control)/);
  if (m) {
    const oneSided = /opponents control|you don't control/.test(m[3]);
    const target = /nonland/.test(m[3]) ? 'nonland' : 'creatures';
    out.push({ body: { kind: 'wipe', target, mode: m[1] as 'destroy' | 'exile', amount: 0, oneSided }, note: `Board wipe (${m[1]} ${target}${oneSided ? ', one-sided' : ''})` });
  } else if ((m = line.match(new RegExp(`deals? ${NUM} damage to each creature( and each (player|planeswalker))?`)))) {
    const amount = num(m[1], 2);
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount, oneSided: false }, note: `Damage sweeper ${amount === -1 ? 'X' : amount}` });
  } else if ((m = line.match(new RegExp(`deals? ${NUM} damage to each creature (your opponents control|you don't control)`)))) {
    const amount = num(m[1], 2);
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount, oneSided: true }, note: `One-sided sweeper ${amount}` });
  } else if (/return all (nonland permanents|creatures)( [^.]*)? to their owners'? hands/.test(line)) {
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'bounce', amount: 0, oneSided: /you don't control|opponents control/.test(line) }, note: 'Mass bounce' });
  } else if ((m = line.match(/all creatures get -(\d+|x)\/-(\d+|x)/))) {
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount: num(m[2], 2), oneSided: false }, note: 'Shrink sweeper' });
  } else if (/each player sacrifices all (colored )?(permanents|nonland permanents)/.test(line)) {
    out.push({ body: { kind: 'wipe', target: 'nonland', mode: 'destroy', amount: 0, oneSided: false }, note: 'Mass sacrifice (permanents)' });
  } else if (/each (player|opponent) sacrifices (all|each) creatures?/.test(line)) {
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'destroy', amount: 0, oneSided: /opponent/.test(line) }, note: 'Mass sacrifice' });
  }

  // --- Spot removal --------------------------------------------------------
  if (!out.some((f) => f.body.kind === 'wipe')) {
    m = line.match(/(destroy|exile) (up to one )?(another )?(target [^.,;]*)/);
    if (m && !/from (a|your|target player's|an opponent's) graveyard|target card|cards? in/.test(m[4]) && !/you control(?! and)/.test(m[4])) {
      const target = removalTargetOf(m[4]);
      if (target) out.push({ body: { kind: 'removal', target, mode: m[1] as 'destroy' | 'exile', amount: 0 }, note: `Removal: ${m[1]} ${target}` });
    }
    if (!out.some((f) => f.body.kind === 'removal') && /(the owner of target (nonland )?permanent shuffles it|put target (nonland )?permanent (on the bottom|into its owner's library))/.test(line)) {
      out.push({ body: { kind: 'removal', target: 'permanent', mode: 'exile', amount: 0 }, note: 'Removal: tuck permanent' });
    }
    if (!out.some((f) => f.body.kind === 'removal')) {
      m = line.match(/return (up to one )?(target [^.]*?) to (its|their) owner'?s'? hand/);
      if (m && !/you control/.test(m[2]) && !/graveyard/.test(m[2])) {
        const target = removalTargetOf(m[2]);
        if (target) out.push({ body: { kind: 'removal', target, mode: 'bounce', amount: 0 }, note: `Bounce ${target}` });
      }
    }
    if (!out.some((f) => f.body.kind === 'removal')) {
      m = line.match(new RegExp(`deals? ${NUM} damage to (any target|target creature|target creature or planeswalker|target creature or player|target attacking|target tapped creature|up to one target creature)`));
      if (m) {
        const amount = num(m[1], 2);
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount }, note: `Deal ${amount === -1 ? 'X' : amount} damage to a creature` });
      } else if (/deals damage equal to its power to (another |any )?(target|up to one target)|fights (target|another target|up to one target) creature/.test(line)) {
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'fight', amount: 0 }, note: 'Fight / bite removal' });
      } else if (/(target player|target opponent|each opponent) sacrifices (a|an) (creature|attacking creature|nonland permanent)/.test(line)) {
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'edict', amount: 0 }, note: 'Edict' });
      } else if ((m = line.match(/target creature( an opponent controls| you don't control)? gets -(\d+|x)\/-(\d+|x)/))) {
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount: num(m[3], 3) }, note: 'Shrink removal' });
      }
    }
  }

  // --- Counterspells -------------------------------------------------------
  m = line.match(/counter target (\w+ )?(\w+ )?spell/);
  if (m && !/activated|triggered/.test(line.slice(0, 40))) {
    const phrase = (m[1] ?? '') + (m[2] ?? '');
    const target = /noncreature|instant|sorcery/.test(phrase) ? 'noncreature' : /creature/.test(phrase) ? 'creature' : 'any';
    out.push({ body: { kind: 'counter', target }, note: `Counterspell (${target})` });
  }

  // --- Tokens --------------------------------------------------------------
  m = line.match(new RegExp(`create ${NUM} (tapped )?(\\d+|x)\\/(\\d+|x) ([^.]*?)creature tokens?([^.]*)`));
  if (m) {
    let n = num(m[1], 1);
    if (/for each|equal to/.test(line) && n === 1) n = 3;
    const p = num(m[3], 1);
    const t = num(m[4], 1);
    const kws = KNOWN_KEYWORDS.filter((k) => (m![6] ?? '').includes(k));
    out.push({ body: { kind: 'tokens', n, power: p === -1 ? 3 : p, toughness: t === -1 ? 3 : t, keywords: kws }, note: `Make ${n === -1 ? 'X' : n}× ${p === -1 ? 'X' : p}/${t === -1 ? 'X' : t} token${n === 1 ? '' : 's'}` });
  } else if ((m = line.match(new RegExp(`create ${NUM} tokens? that'?s? a copy of`)))) {
    out.push({ body: { kind: 'tokens', n: num(m[1], 1), power: 3, toughness: 3, keywords: [] }, note: 'Token copy (≈3/3)' });
  }

  // --- Anthems / overruns / pumps -------------------------------------------
  m = line.match(/(other )?(creatures|creature tokens|\w+ creatures|\w+s) you control get \+(\d+|x)\/\+(\d+|x)/);
  if (m) {
    const p = num(m[3], 1);
    const t = num(m[4], 1);
    if (/until end of turn/.test(line)) {
      out.push({ body: { kind: 'overrun', p, t, trample: /trample/.test(line) }, note: `Team pump +${p}/+${t} this turn` });
    } else if (card.isPermanent) {
      out.push({ body: { kind: 'anthem', p, t }, note: `Anthem +${p}/+${t}` });
    }
  } else if ((m = line.match(/(equipped|enchanted) creature gets \+(\d+)\/\+(\d+)/))) {
    const kws = KNOWN_KEYWORDS.filter((k) => line.includes(k));
    out.push({ body: { kind: 'equip', p: num(m[2], 1), t: num(m[3], 1), keywords: kws, aura: m[1] === 'enchanted' }, note: `${m[1] === 'equipped' ? 'Equipment' : 'Aura'} +${m[2]}/+${m[3]}` });
  } else if ((m = line.match(/(equipped|enchanted) creature (has|gains) ([a-z, ]+)/))) {
    const kws = KNOWN_KEYWORDS.filter((k) => m![3].includes(k));
    if (kws.length) out.push({ body: { kind: 'equip', p: 0, t: 0, keywords: kws, aura: m[1] === 'enchanted' }, note: `Grants ${kws.join(', ')}` });
  } else if ((m = line.match(/target creature( you control)? gets \+(\d+|x)\/\+(\d+|x) until end of turn/))) {
    const protect = /hexproof|indestructible|protection/.test(line);
    out.push({ body: { kind: 'pump', p: num(m[2], 2), t: num(m[3], 2), protect }, note: `Combat trick +${m[2]}/+${m[3]}` });
  } else if (!card.isPermanent && /target (creature|permanent) can't be the target of spells or abilities your opponents control/.test(line)) {
    out.push({ body: { kind: 'protect' }, note: 'Protection spell' });
  } else if (!card.isPermanent && /(target (creature|permanent)s? you control|creatures you control|permanents you control)[^.]*(gains?|gain|have) [^.]*(hexproof|indestructible|protection|shroud)/.test(line)) {
    out.push({ body: { kind: 'protect' }, note: 'Protection spell' });
  }

  // --- Counters on self ----------------------------------------------------
  m = line.match(new RegExp(`put ${NUM} \\+1\\/\\+1 counters? on (~|each creature you control|target creature you control|each other creature you control)`));
  if (m) {
    const n = num(m[1], 1);
    const all = /each/.test(m[2]);
    out.push({ body: { kind: 'counters', n: n === -1 ? 2 : n, all }, note: `+1/+1 counter${n > 1 ? 's' : ''}${all ? ' on team' : ''}` });
  }

  // --- Life drain / burn ---------------------------------------------------
  m = line.match(new RegExp(`each opponent loses ${NUM} life`)) ?? line.match(new RegExp(`deals? ${NUM} damage to each opponent`));
  if (m) {
    const n = num(m[1], 1);
    const fixedGain = fullLine.match(new RegExp(`you gain ${NUM} life`));
    const gain = /you gain life equal/.test(fullLine) ? -1 : fixedGain ? num(fixedGain[1], 1) : 0;
    out.push({ body: { kind: 'drain', n, gain }, note: `Drain each opponent ${n === -1 ? 'X' : n}` });
  } else if ((m = line.match(new RegExp(`(target (player|opponent) loses|deals? ${NUM} damage to (target (player|opponent)|any target))`)))) {
    const amt = line.match(new RegExp(`(loses|deals?) ${NUM}`));
    const n = num(amt?.[2], 2);
    if (!out.some((f) => f.body.kind === 'removal')) out.push({ body: { kind: 'damagePlayer', n }, note: `Burn a player for ${n === -1 ? 'X' : n}` });
  }
  m = line.match(new RegExp(`you gain ${NUM} life`));
  if (m && !out.some((f) => f.body.kind === 'drain')) {
    const n = num(m[1], 1);
    out.push({ body: { kind: 'gainLife', n }, note: `Gain ${n === -1 ? 'X' : n} life` });
  }

  // --- Recursion -----------------------------------------------------------
  m = line.match(/return (up to (one|two|three) )?(target |a |an )?(creature|permanent|nonland permanent|artifact or creature|creature or planeswalker)? ?cards? from your graveyard to (your hand|the battlefield)/);
  if (m) {
    const n = m[2] ? num(m[2], 1) : 1;
    out.push({ body: { kind: 'recursion', n, toBattlefield: /battlefield/.test(m[5]) }, note: `Reanimate/regrow ${n}` });
  }

  // --- Cost reduction ------------------------------------------------------
  m = line.match(/(\w+ )?(\w+ )?spells you cast cost \{(\d)\} less/);
  if (m) {
    const phrase = (m[1] ?? '') + (m[2] ?? '');
    const filter: CastFilter = /noncreature/.test(phrase) ? 'noncreature' : /creature/.test(phrase) ? 'creature' : /instant|sorcery/.test(phrase) ? 'instantSorcery' : /artifact/.test(phrase) ? 'artifact' : /enchantment/.test(phrase) ? 'enchantment' : 'any';
    out.push({ body: { kind: 'costReduction', amount: parseInt(m[3], 10), filter }, note: `Cost reduction {${m[3]}} (${filter})` });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Trigger detection
// ---------------------------------------------------------------------------

interface LineContext {
  when: Trigger;
  scope?: TriggerScope;
  castFilter?: CastFilter;
  body: string;
  activationCost?: ManaCost;
  tap?: boolean;
  sacrifice?: boolean;
  minCmc?: number;
  chance?: number;
  oncePerTurn?: boolean;
}

function detectTrigger(line: string, isPermanent: boolean): LineContext {
  // Strip ability words like "Landfall — " / "Constellation — ".
  let l = line.replace(/^[a-z' ]+ — (?=(when|whenever|at|if|as|~|you|creatures|target|each|draw|create))/, '');
  let m: RegExpMatchArray | null;

  if ((m = l.match(/^(when|whenever) ~ (enters|is turned face up)[^,]*,\s*(.*)$/))) return { when: 'resolve', body: m[3] };
  if ((m = l.match(/^when you cast (this spell|~),\s*(.*)$/))) return { when: 'resolve', body: m[2] };
  if ((m = l.match(/^at the beginning of (your|each) (upkeep|end step|precombat main phase|combat on your turn|draw step|first main phase)[^,]*,\s*(.*)$/))) return { when: 'upkeep', body: m[3] };
  if ((m = l.match(/^at the beginning of each (player's|opponent's) (upkeep|end step)[^,]*,\s*(.*)$/))) return { when: 'upkeep', body: m[3] };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) deals combat damage to (a player|an opponent|one or more|a player or|a player, )[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'self', body: m[3] };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) deals (combat )?damage[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'self', body: m[3] };
  if ((m = l.match(/^whenever one or more (\w+ )?creatures you control deal combat damage to a player[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'oneOrMore', body: m[2] };
  if ((m = l.match(/^whenever (a|another) (\w+ )?creature you control deals combat damage to (a player|an opponent)[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'any', body: m[4] };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) attacks[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'self', body: m[2] };
  if ((m = l.match(/^whenever (you attack|one or more creatures you control attack)[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'oneOrMore', body: m[2] };
  if ((m = l.match(/^whenever (a|another) (\w+ )?creature you control attacks[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'any', body: m[3] };
  if ((m = l.match(/^whenever you cast (an? |your )?([^,]*?)spell([^,]*),\s*(.*)$/))) {
    const what = m[2] + m[3];
    const castFilter: CastFilter = /noncreature/.test(what) ? 'noncreature' : /instant|sorcery/.test(what) ? 'instantSorcery' : /creature/.test(what) ? 'creature' : /artifact/.test(what) ? 'artifact' : /enchantment/.test(what) ? 'enchantment' : 'any';
    const mv = what.match(/mana value (\d+) or greater/);
    return { when: 'cast', castFilter, body: m[4], minCmc: mv ? parseInt(mv[1], 10) : undefined };
  }
  if ((m = l.match(/^whenever (a|another|one or more)( nontoken)? (\w+ )?(creatures?|tokens?)( you control)? (enters?|enter)[^,]*,\s*(.*)$/))) return { when: 'creatureEnters', body: m[7] };
  if ((m = l.match(/^whenever (a|another|one or more)( nontoken)? (\w+ )?creatures?( you control)? (dies|die|is put into a graveyard)[^,]*,\s*(.*)$/))) return { when: 'creatureDies', body: m[6] };
  if ((m = l.match(/^whenever a land( you control)? enters[^,]*,\s*(.*)$/))) return { when: 'landfall', body: m[2] };
  if ((m = l.match(/^when ~ dies,\s*(.*)$/))) return { when: 'creatureDies', scope: 'self', body: m[1] };

  // Planeswalker loyalty abilities: treat the first + or 0 ability as a per-turn effect.
  if ((m = l.match(/^(\+\d+|0): (.*)$/))) return { when: 'upkeep', body: m[2] };
  if (/^-\d+: /.test(l)) return { when: 'static', body: '' };

  // Activated abilities: "COST: EFFECT" where cost is mana/tap symbols.
  const COST_PART = '(?:(?:\\{[^}]+\\})+|sacrifice ~|pay \\d+ life)';
  if ((m = l.match(new RegExp(`^(${COST_PART}(?:, ${COST_PART})*):\\s*(.*)$`)))) {
    const costText = m[1];
    const tap = /\{t\}/.test(costText);
    const cost = parseManaCost(costText.replace(/\{t\}|\{q\}/g, ''));
    return { when: 'activated', body: m[2], activationCost: cost, tap, sacrifice: /sacrifice ~/.test(costText) };
  }

  // Other triggered/conditional lines we don't model.
  if (/^(when|whenever|at the beginning)/.test(l)) return { when: 'static', body: '' };

  l = l.replace(/^(kicker|flashback|buyback|entwine|overload) [^\n]*$/, '');
  return { when: isPermanent ? 'static' : 'resolve', body: l };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

function landInfo(raw: { types: string[]; subTypes: string[]; text: string; name: string }, fallbackProduced: Mana[] | undefined, identity: Color[]): LandInfo {
  const text = normaliseText(raw.name, raw.text);
  const colors = new Set<Mana>();
  let any = false;
  for (const st of raw.subTypes) {
    const c = BASIC_LAND_TYPES[st.toLowerCase()];
    if (c) colors.add(c);
  }
  for (const line of text.split('\n')) {
    const m = line.match(/\{t\}(?:, [^:]*)?: add (.*)$/);
    if (m) {
      const p = parseProduced(m[1]);
      if (p) {
        if (p.colors === 'any') any = true;
        else p.colors.forEach((c) => colors.add(c));
      }
    }
    // Fetch lands: "sacrifice ~: search your library for a basic land/forest card"
    if (/sacrifice ~[^:]*: search your library for/.test(line)) any = true;
  }
  if (!colors.size && !any && fallbackProduced) fallbackProduced.forEach((c) => colors.add(c));
  const tapped =
    /~ enters (the battlefield )?tapped\.?$/m.test(text) ||
    /battlefield tapped/.test(text) && /sacrifice ~/.test(text) ||
    /^when ~ enters, return a land you control/m.test(text);
  if (any) return { produces: 'any', tapped };
  if (!colors.size && identity.length === 0) colors.add('C');
  return { produces: colors.size ? [...colors] : 'any', tapped };
}

export function classifyCard(raw: RawCard): SimCard {
  const types = raw.types.map((t) => t.toLowerCase());
  const supers = raw.superTypes.map((t) => t.toLowerCase());
  const isLand = types.includes('land');
  const isCreature = types.includes('creature');
  const isPermanent = !types.includes('instant') && !types.includes('sorcery');
  const text = normaliseText(raw.name, raw.text);
  const keywords = parseKeywords(raw, text);

  const card: SimCard = {
    name: raw.name,
    cost: parseManaCost(raw.manaCost),
    cmc: raw.cmc,
    typeLine: [raw.superTypes.join(' '), raw.types.join(' ')].join(' ').trim() + (raw.subTypes.length ? ` — ${raw.subTypes.join(' ')}` : ''),
    isLand,
    isCreature,
    isArtifact: types.includes('artifact'),
    isEnchantment: types.includes('enchantment'),
    isPlaneswalker: types.includes('planeswalker'),
    isInstant: types.includes('instant'),
    isSorcery: types.includes('sorcery'),
    isLegendary: supers.includes('legendary'),
    isBasic: supers.includes('basic'),
    power: parsePT(raw.power),
    toughness: parsePT(raw.toughness),
    keywords,
    effects: [],
    value: 0,
    modeled: false,
    notes: [],
    imageUrl: raw.imageUrl,
  };

  if (isLand) {
    card.land = landInfo(raw, raw.producedMana, raw.colorIdentity);
    card.notes.push(`Land: ${card.land.produces === 'any' ? 'any color' : card.land.produces.join('')}${card.land.tapped ? ' (enters tapped)' : ''}`);
    card.modeled = true;
  }
  if (raw.back && raw.back.types.map((t) => t.toLowerCase()).includes('land') && !isLand) {
    const info = landInfo(raw.back, undefined, raw.colorIdentity);
    card.backLand = { ...info, tapped: info.tapped || /enters tapped/.test(raw.back.text.toLowerCase()), name: raw.back.name };
    card.notes.push(`Back face is a land (${raw.back.name})`);
  }

  // "Choose one —" modal spells: keep only the best bullet.
  const isModal = /choose one( or both)? —|choose one\./.test(text);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const modalFound: { found: Found; ctx: LineContext }[] = [];

  for (const rawLine of lines) {
    const bullet = rawLine.startsWith('•');
    const line = rawLine.replace(/^•\s*/, '');
    if (isLand && (/: add /.test(line) || /sacrifice ~[^:]*: search/.test(line))) continue;
    const ctx = detectTrigger(line, isPermanent);
    if (!ctx.body) continue;
    // Intervening "if" clauses: we can't check the condition, so assume it holds half the time.
    if (ctx.when !== 'resolve' && ctx.when !== 'static' && /^if [^,]+, /.test(ctx.body)) {
      ctx.chance = 0.5;
      ctx.body = ctx.body.replace(/^if [^,]+, /, '');
    }
    if (/only once each turn/.test(line)) ctx.oncePerTurn = true;
    // A line can hold several sentences, e.g. "Draw two cards. Create a Treasure."
    const sentences = ctx.body.replace(/"[^"]*"/g, '').split(/(?<=\.)\s+(?=[a-z~])/);
    for (const sentence of sentences) {
      const found = recogniseEffects(sentence, { isPermanent, isCreature }, ctx.body);
      // Mana abilities on nonland permanents (rocks and dorks).
      const manaMatch = ctx.when === 'activated' ? sentence.match(/^add (.*)$/) : null;
      if (manaMatch) {
        const p = parseProduced(manaMatch[1]);
        const paid = ctx.activationCost ? ctx.activationCost.generic + ctx.activationCost.pips.length : 0;
        if (p && ctx.tap && !ctx.sacrifice) {
          const net = Math.max(p.amount - paid, paid > 0 ? 1 : 0);
          const existing = card.effects.find((e) => e.kind === 'mana');
          if (existing && existing.kind === 'mana') {
            // Several mana abilities (e.g. Talismans): keep the best amount and all colors.
            existing.amount = Math.max(existing.amount, net);
            if (existing.colors !== 'any') existing.colors = p.colors === 'any' ? 'any' : [...new Set([...existing.colors, ...p.colors])];
          } else if (net > 0) {
            card.effects.push({ kind: 'mana', amount: net, colors: p.colors, when: 'static' });
          }
        }
        continue;
      }
      for (const f of found) {
        if (isModal && bullet) {
          modalFound.push({ found: f, ctx });
          continue;
        }
        pushEffect(card, f, ctx);
      }
    }
  }

  const manaEffect = card.effects.find((e) => e.kind === 'mana');
  if (manaEffect && manaEffect.kind === 'mana') {
    card.notes.push(`Mana: +${manaEffect.amount} ${manaEffect.colors === 'any' ? 'any color' : manaEffect.colors.join('/')}`);
  }

  if (modalFound.length) {
    const priority = ['wipe', 'removal', 'counter', 'draw', 'tokens', 'ramp', 'pump', 'protect'];
    modalFound.sort((a, b) => rank(priority, a.found.body.kind) - rank(priority, b.found.body.kind));
    pushEffect(card, modalFound[0].found, modalFound[0].ctx);
    card.notes[card.notes.length - 1] += ' (modal)';
  }

  // Treasure makers count as small ramp on resolve.
  if (/create (a|one|two) treasure tokens?/.test(text) && !card.effects.some((e) => e.kind === 'mana')) {
    const n = /create two treasure/.test(text) ? 2 : 1;
    if (isPermanent && /^(when|whenever) ~ enters/m.test(text) || !isPermanent) {
      card.effects.push({ kind: 'treasure', n, when: 'resolve' });
      card.notes.push(`Treasure ×${n} (one-shot mana)`);
    }
  }

  if (isCreature && card.cost.x > 0 && /enters with x \+1\/\+1 counters?/.test(text)) {
    card.entersWithX = true;
    card.notes.push('Enters with X +1/+1 counters');
  } else if (isCreature && /enters with (\w+) \+1\/\+1 counters?/.test(text)) {
    const n = num(text.match(/enters with (\w+) \+1\/\+1 counter/)![1], 1);
    if (n > 0) {
      card.power += n;
      card.toughness += n;
      card.notes.push(`Enters with ${n} +1/+1 counters`);
    }
  }

  if (isCreature) card.notes.unshift(`Creature ${card.power}/${card.toughness}${keywords.length ? ' — ' + keywords.join(', ') : ''}`);
  else if (keywords.includes('flash')) card.notes.push('Flash');

  card.modeled = isLand || (isCreature && (card.power > 0 || card.toughness > 0 || !!card.entersWithX)) || card.effects.length > 0;
  if (!card.modeled) card.notes.push('Not modeled — treated as a blank card');
  card.value = cardValue(card);
  return card;
}

function rank(order: string[], kind: string): number {
  const i = order.indexOf(kind);
  return i === -1 ? order.length : i;
}

function pushEffect(card: SimCard, f: Found, ctx: LineContext) {
  const effect: Effect = { ...f.body, when: ctx.when } as Effect;
  if (ctx.scope) effect.scope = ctx.scope;
  if (ctx.castFilter) effect.castFilter = ctx.castFilter;
  if (ctx.minCmc) effect.minCmc = ctx.minCmc;
  if (ctx.chance) effect.chance = ctx.chance;
  if (ctx.oncePerTurn) effect.oncePerTurn = true;
  if (ctx.when === 'activated') {
    if (!ctx.activationCost) return;
    effect.activation = { cost: ctx.activationCost, tap: !!ctx.tap, sacrifice: !!ctx.sacrifice };
  }
  // Static lines on a permanent only make sense for static effects.
  const staticKinds = ['anthem', 'equip', 'costReduction'];
  if (ctx.when === 'static' && !staticKinds.includes(effect.kind)) return;
  if (staticKinds.includes(effect.kind) && ctx.when !== 'static' && ctx.when !== 'resolve') return;
  if (staticKinds.includes(effect.kind)) effect.when = 'static';
  card.effects.push(effect);
  let note = describeTrigger(ctx) + f.note;
  if (ctx.chance) note += ' (conditional, ~50%)';
  if (ctx.oncePerTurn) note += ' (once per turn)';
  card.notes.push(note);
}

function describeTrigger(ctx: LineContext): string {
  switch (ctx.when) {
    case 'upkeep': return 'Each turn: ';
    case 'attack': return 'On attack: ';
    case 'combatDamage': return 'On combat damage: ';
    case 'cast': return `On casting ${ctx.castFilter === 'any' ? 'a spell' : ctx.castFilter + ' spells'}${ctx.minCmc ? ` (MV ${ctx.minCmc}+)` : ''}: `;
    case 'creatureEnters': return 'When a creature enters: ';
    case 'creatureDies': return ctx.scope === 'self' ? 'When it dies: ' : 'When a creature dies: ';
    case 'landfall': return 'Landfall: ';
    case 'activated': return 'Activated: ';
    default: return '';
  }
}

function parsePT(v: string | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 2 : n;
}

/** Rough card quality score used for AI decisions (what to cast, what to kill). */
export function cardValue(card: SimCard): number {
  if (card.isLand) return 1;
  let v = 0;
  if (card.isCreature) {
    v += card.power + card.toughness * 0.5;
    const kw = card.keywords;
    if (kw.includes('flying') || kw.includes('unblockable')) v += card.power * 0.5;
    if (kw.includes('double strike')) v += card.power;
    if (kw.includes('deathtouch') || kw.includes('lifelink') || kw.includes('trample')) v += 1;
    if (kw.includes('indestructible') || kw.includes('hexproof')) v += 1.5;
  }
  for (const e of card.effects) {
    const repeating = e.when !== 'resolve';
    const mult = repeating ? 2.5 : 1;
    switch (e.kind) {
      case 'ramp': v += 2.5 * Math.max(e.lands, 1) + e.toHand; break;
      case 'mana': v += 2.5 * e.amount; break;
      case 'costReduction': v += 2 * e.amount; break;
      case 'draw': v += 1.5 * Math.max(e.n, 2) * mult; break;
      case 'removal': v += 3 * mult; break;
      case 'wipe': v += 4; break;
      case 'counter': v += 2.5; break;
      case 'tokens': v += Math.max(e.n, 2) * (e.power + e.toughness) * 0.4 * mult; break;
      case 'anthem': v += 3 * (e.p + e.t); break;
      case 'overrun': v += 3 + e.p; break;
      case 'pump': v += 1; break;
      case 'equip': v += 1 + e.p + e.keywords.length; break;
      case 'protect': v += 1.5; break;
      case 'drain': v += xOr3(e.n) * 1.5 * mult; break;
      case 'damagePlayer': v += xOr3(e.n) * 0.5 * mult; break;
      case 'gainLife': v += 0.2 * xOr3(e.n); break;
      case 'tutor': v += 3; break;
      case 'recursion': v += 2 * e.n; break;
      case 'counters': v += e.n * (e.all ? 2 : 1) * mult; break;
      case 'extraLand': v += 1.5; break;
      case 'treasure': v += 1.2 * e.n; break;
    }
  }
  return Math.max(v, card.cmc * 0.4);
}

function xOr3(n: number): number {
  return n === -1 ? 3 : n;
}
