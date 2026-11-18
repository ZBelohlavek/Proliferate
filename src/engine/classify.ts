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
  /** Printed loyalty of a planeswalker. */
  loyalty?: string | number | null;
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
  'double strike', 'indestructible', 'hexproof', 'shroud', 'reach', 'defender', 'flash', 'ward', 'infect',
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
  if (/^~ can't be countered/m.test(text)) kws.add('uncounterable');
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
  } else if (/search target (opponent|player)'s library for (a|an) creature card and put (that card|it) onto the battlefield under your control/.test(line)) {
    out.push({ body: { kind: 'steal', from: 'library' }, note: "Take the best creature from an opponent's library" });
  } else if (/search your library (and\/or graveyard )?for (a|an|up to one|one) [^.]*card/.test(line) && !/land card/.test(line)) {
    if (/creature card[^.]*put (it|that card) onto the battlefield/.test(line)) {
      const xLimit = /mana value x or less/.test(line);
      out.push({ body: { kind: 'tutor', creatureToBattlefield: true, ...(xLimit ? { xLimit } : {}) }, note: `Tutor a creature${xLimit ? ' (mana value X or less)' : ''} onto the battlefield` });
    }
    else out.push({ body: { kind: 'tutor' }, note: 'Tutor' });
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
  } else if (/^exile the top (card|two cards|three cards) of your library\.?$/.test(line) && /you may (play|cast) (it|them|that card|those cards)/.test(fullLine)) {
    const n = /three/.test(line) ? 3 : /two/.test(line) ? 2 : 1;
    out.push({ body: { kind: 'draw', n }, note: `Impulse draw ${n}` });
  } else if (/you may cast (it|that card|them|any number of spells from among[^.]*) without paying/.test(line)) {
    const n = /any number/.test(line) ? 2 : 1;
    out.push({ body: { kind: 'draw', n }, note: `Free spells off the top (≈ draw ${n})` });
  } else if (/put one pile into your hand/.test(line)) {
    out.push({ body: { kind: 'draw', n: 3 }, note: 'Dig (≈ draw 3)' });
  } else if (!/search/.test(fullLine) && /(reveal|look at|exile) the top card of your library[^.]*put (that card|it) into your hand|^put that card into your hand/.test(line)) {
    out.push({ body: { kind: 'draw', n: 1 }, note: 'Draw 1' });
  }

  // --- Scry, surveil, mill, discard ----------------------------------------
  if ((m = line.match(new RegExp(`\\b(scry|surveil) ${NUM}`)))) {
    const n = Math.max(1, num(m[2], 1));
    out.push({ body: { kind: 'scry', n, surveil: m[1] === 'surveil' }, note: `${m[1] === 'surveil' ? 'Surveil' : 'Scry'} ${n}` });
  } else if ((m = line.match(new RegExp(`look at the top ${NUM}? ?cards? of your library, then put (them|it) back`)))) {
    out.push({ body: { kind: 'scry', n: Math.max(1, num(m[1], 1)), surveil: false }, note: 'Rearrange the top of your library (≈ scry)' });
  }
  if ((m = line.match(new RegExp(`(target player|target opponent|that player|each opponent|each player|each other player|you|^)\\s?mills? (${NUM}|twice x|half their library|cards equal to)`)))) {
    const who = /each opponent|each other/.test(m[1]) ? 'opponents' : /each player/.test(m[1]) ? 'all' : m[1] === 'you' || m[1] === '' ? 'you' : 'target';
    const n = m[2] === 'half their library' ? -2 : m[2] === 'twice x' ? -1 : m[2] === 'cards equal to' ? 3 : num(m[3], 2);
    out.push({ body: { kind: 'mill', n, who }, note: `Mill ${n === -2 ? 'half a library' : n === -1 ? 'X' : n} (${who === 'you' ? 'yourself' : who === 'all' ? 'everyone' : who === 'opponents' ? 'each opponent' : 'a player'})` });
  }
  if ((m = line.match(new RegExp(`(target player|target opponent|that player|each opponent) discards ${NUM} cards?`)))) {
    const who = m[1] === 'each opponent' ? 'opponents' : 'target';
    out.push({ body: { kind: 'discard', n: Math.max(1, num(m[2], 1)), who }, note: `${who === 'opponents' ? 'Each opponent' : 'A player'} discards ${Math.max(1, num(m[2], 1))}` });
  }
  if (/if you would draw a card while your library has no cards in it, you win the game instead/.test(line)) out.push({ body: { kind: 'winOnEmptyDraw' }, note: 'Win the game instead of drawing from an empty library' });
  if (/you become the monarch/.test(line)) out.push({ body: { kind: 'monarch' }, note: 'You become the monarch (draw a card each end step)' });
  if (/^you have no maximum hand size/.test(line)) out.push({ body: { kind: 'noMaxHand' }, note: 'No maximum hand size' });

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
  } else if ((m = line.match(/(all creatures|each other creature|each creature|creatures your opponents control|creatures you don't control) gets? -(\d+|x)\/-(\d+|x)/))) {
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount: num(m[3], 2), oneSided: /opponents|don't/.test(m[1]) }, note: 'Shrink sweeper' });
  } else if ((m = line.match(new RegExp(`put ${NUM} -1\\/-1 counters? on each creature( target player controls| your opponents control| you don't control)?`)))) {
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount: num(m[1], 1), oneSided: !!m[2] }, note: 'Shrink sweeper (-1/-1 counters)' });
  } else if (/each player sacrifices all (colored )?(permanents|nonland permanents)/.test(line)) {
    out.push({ body: { kind: 'wipe', target: 'nonland', mode: 'destroy', amount: 0, oneSided: false }, note: 'Mass sacrifice (permanents)' });
  } else if (/each (player|opponent) sacrifices (all|each) creatures?/.test(line)) {
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'destroy', amount: 0, oneSided: /opponent/.test(line) }, note: 'Mass sacrifice' });
  }

  // --- Spot removal --------------------------------------------------------
  if (!out.some((f) => f.body.kind === 'wipe')) {
    m = line.replace(/(non\w+), (non\w+)/, '$1 $2').match(/(destroy|exile) (up to (?:one|two|three) )?(another |other )?(target [^.,;]*)/);
    if (m && !/from (a|your|target player's|an opponent's) graveyard|target card|cards? in/.test(m[4]) && !/you control(?! and)|you own/.test(m[4])) {
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
        const anyTarget = m[2] === 'any target' || m[2] === 'target creature or player';
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount, ...(anyTarget ? { anyTarget } : {}) }, note: `Deal ${amount === -1 ? 'X' : amount} damage to ${anyTarget ? 'any target' : 'a creature'}` });
      } else if (/deals damage equal to its power to (another |any )?(target|up to one target)|fights (target|another target|up to one target) creature/.test(line)) {
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'fight', amount: 0 }, note: 'Fight / bite removal' });
      } else if ((m = line.match(/(target player|target opponent|each opponent|each player|each other player) sacrifices (a|an|two|three) (?:nontoken )?(creatures?|attacking creature|nonland permanent)/))) {
        const each = /each (opponent|other)/.test(m[1]) ? 'opponents' as const : m[1] === 'each player' ? 'all' as const : undefined;
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'edict', amount: 0, ...(each ? { each } : {}) }, note: each === 'all' ? 'Each player sacrifices a creature' : each ? 'Each opponent sacrifices a creature' : 'Edict' });
      } else if ((m = line.match(/target creature( an opponent controls| you don't control)? gets -(\d+|x)\/-(\d+|x)/))) {
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount: num(m[3], 3) }, note: 'Shrink removal' });
      } else if ((m = line.match(new RegExp(`put ${NUM} -1\\/-1 counters? on (up to one )?target creature`)))) {
        const amount = num(m[1], 1);
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount }, note: `Shrink removal (${amount === -1 ? 'X' : amount} -1/-1 counters)` });
      }
    }
  }

  // --- Counterspells -------------------------------------------------------
  m = line.match(/counter target ([^.]*?)spell/);
  if (m && !/activated|triggered/.test(line.slice(0, 40))) {
    const phrase = m[1] ?? '';
    const target = /noncreature/.test(phrase) ? 'noncreature' : /creature/.test(phrase) ? 'creature' : /instant|sorcery|enchantment|artifact|planeswalker/.test(phrase) ? 'noncreature' : 'any';
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

  m = line.match(new RegExp(`create ${NUM} (tapped )?(?:treasure|gold) tokens?`));
  if (m) {
    const raw = num(m[1], 1);
    const n = raw === -1 || /for each|equal to/.test(line) ? 3 : raw;
    out.push({ body: { kind: 'treasure', n }, note: `Treasure ×${n} (one-shot mana)` });
  }

  if ((m = line.match(/\bincubate (\d+)/))) {
    const n = parseInt(m[1], 10);
    out.push({ body: { kind: 'tokens', n: 1, power: n, toughness: n, keywords: [] }, note: `Incubate ${n} (≈ a ${n}/${n} Phyrexian token)` });
  }
  if ((m = line.match(/\bamass (?:\w+ )?(\d+)/))) {
    const n = parseInt(m[1], 10);
    out.push({ body: { kind: 'tokens', n: 1, power: n, toughness: n, keywords: [] }, note: `Amass ${n} (≈ a ${n}/${n} Army token)` });
  }
  if (/create (a|an|one|two) food tokens?/.test(line) && !/treasure/.test(line)) out.push({ body: { kind: 'gainLife', n: 3 }, note: 'Food (≈ gain 3 life)' });

  // --- Anthems / overruns / pumps -------------------------------------------
  m = /^if x is/.test(line) ? null : line.match(/(other )?(creatures|creature tokens|\w+ creatures|\w+s) you control (?:of the chosen type )?(?:gain [a-z, ]+ and )?get \+(\d+|x)\/\+(\d+|x)/);
  if (m) {
    const p = num(m[3], 1);
    const t = num(m[4], 1);
    if (/until end of turn/.test(line)) {
      const scale = p !== -1 ? undefined : /x is the number of creatures/.test(line) ? 'creatures' as const : /greatest power/.test(line) ? 'power' as const : undefined;
      const size = scale === 'creatures' ? 'your creature count' : scale === 'power' ? 'your greatest power' : p === -1 ? 'X' : String(p);
      out.push({ body: { kind: 'overrun', p, t, trample: /trample/.test(line), ...(scale ? { scale } : {}) }, note: scale || p === -1 ? `Team pump +X/+X this turn (X = ${size})` : `Team pump +${p}/+${t} this turn` });
    } else if (card.isPermanent) {
      out.push({ body: { kind: 'anthem', p, t }, note: `Anthem +${p}/+${t}` });
    }
  } else if (card.isPermanent && (m = line.match(/^(?:other )?creatures you control have ([a-z, ]+)\.?$/)) && KNOWN_KEYWORDS.some((k) => m![1].includes(k))) {
    const kws = KNOWN_KEYWORDS.filter((k) => m![1].includes(k));
    out.push({ body: { kind: 'anthem', p: 0, t: 0, keywords: kws }, note: `Your creatures have ${kws.join(', ')}` });
  } else if ((m = line.match(/^creatures you control gain ([a-z, ]+) until end of turn/)) && KNOWN_KEYWORDS.some((k) => m![1].includes(k)) && !/hexproof|indestructible/.test(m[1])) {
    const kws = KNOWN_KEYWORDS.filter((k) => m![1].includes(k));
    out.push({ body: { kind: 'overrun', p: 0, t: 0, trample: kws.includes('trample'), grant: kws }, note: `Your creatures gain ${kws.join(', ')} this turn` });
  } else if (card.isPermanent && /each creature gets \+1\/\+1 for each other creature/.test(line)) {
    out.push({ body: { kind: 'anthem', p: 2, t: 2 }, note: 'Tribal anthem (≈ +2/+2)' });
  } else if ((m = line.match(/(equipped|enchanted) creature gets \+(\d+)\/([+-]\d+)/))) {
    const kws = KNOWN_KEYWORDS.filter((k) => line.includes(k));
    out.push({ body: { kind: 'equip', p: num(m[2], 1), t: parseInt(m[3], 10), keywords: kws, aura: m[1] === 'enchanted' }, note: `${m[1] === 'equipped' ? 'Equipment' : 'Aura'} +${m[2]}/${m[3]}` });
  } else if (/^you control enchanted creature/.test(line)) {
    out.push({ body: { kind: 'equip', p: 0, t: 0, keywords: [], aura: true, steal: true }, note: 'Aura: take control of the creature' });
  } else if ((m = line.match(/(equipped|enchanted) creature (has|gains) ([a-z, ]+)/))) {
    const kws = KNOWN_KEYWORDS.filter((k) => m![3].includes(k));
    if (kws.length) out.push({ body: { kind: 'equip', p: 0, t: 0, keywords: kws, aura: m[1] === 'enchanted' }, note: `Grants ${kws.join(', ')}` });
  } else if ((m = line.match(/target creature( you control)? gets \+(\d+|x)\/\+(\d+|x) until end of turn/))) {
    const protect = /hexproof|indestructible|protection/.test(line);
    out.push({ body: { kind: 'pump', p: num(m[2], 2), t: num(m[3], 2), protect }, note: `Combat trick +${m[2]}/+${m[3]}` });
  } else if ((m = line.match(/target creature( you control)? (can't be blocked this turn|gains ([a-z, ]+) until end of turn)/)) && (m[2].startsWith("can't") || KNOWN_KEYWORDS.some((k) => m![3].includes(k)))) {
    const grant = m[2].startsWith("can't") ? ['unblockable'] : KNOWN_KEYWORDS.filter((k) => m![3].includes(k));
    const protect = grant.includes('hexproof') || grant.includes('indestructible');
    out.push({ body: { kind: 'pump', p: 0, t: 0, protect, grant }, note: `Gives a creature ${grant.join(', ')} this turn` });
  } else if (!card.isPermanent && /target (creature|permanent) can't be the target of spells or abilities your opponents control/.test(line)) {
    out.push({ body: { kind: 'protect' }, note: 'Protection spell' });
  } else if (/your life total can't change|you gain protection from everything/.test(line)) {
    const all = !card.isPermanent;
    out.push({ body: { kind: 'protect', player: true, ...(all ? { all } : {}) }, note: all ? 'Protects you and everything you control until your next turn' : 'You are protected until your next turn' });
  } else if (!card.isPermanent && /(target (creature|permanent)s? you control|creatures you control|permanents you control)[^.]*(gains?|gain|have) [^.]*(hexproof|indestructible|protection|shroud)/.test(line)) {
    const all = !/target/.test(line);
    out.push({ body: { kind: 'protect', ...(all ? { all } : {}) }, note: all ? 'Protects your whole board' : 'Protection spell' });
  }

  // --- Counters on self ----------------------------------------------------
  m = line.match(new RegExp(`put ${NUM} \\+1\\/\\+1 counters? on (~|each creature you control|target creature you control|each other creature you control)`));
  if (m) {
    const n = num(m[1], 1);
    const all = /each/.test(m[2]);
    out.push({ body: { kind: 'counters', n: n === -1 ? 2 : n, all }, note: `+1/+1 counter${n > 1 ? 's' : ''}${all ? ' on team' : ''}` });
  }

  if (/\bproliferate\b/.test(line)) {
    out.push({ body: { kind: 'counters', n: 1, all: true, proliferate: true }, note: 'Proliferate (+1 counter on creatures that have one)' });
  }

  // --- Life drain / burn ---------------------------------------------------
  m = line.match(new RegExp(`each opponent loses ${NUM} life`)) ?? line.match(new RegExp(`deals? ${NUM} damage to each opponent`)) ?? line.match(/each opponent loses life (equal) to/);
  if (m) {
    const n = m[1] === 'equal' ? 2 : num(m[1], 1);
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
  m = line.match(/(?:\byou|\band) lose (\d+) life/);
  if (m && !/unless|rather than|if you do|you may/.test(line)) out.push({ body: { kind: 'loseLife', n: parseInt(m[1], 10) }, note: `You lose ${m[1]} life` });

  // --- Recursion -----------------------------------------------------------
  m = line.match(/return (up to (one|two|three) )?(target |a |an )?(creature|permanent|nonland permanent|artifact or creature|creature or planeswalker)? ?cards?( with [^.]*?)? from your graveyard to (your hand|the battlefield)/);
  if (m) {
    const n = m[2] ? num(m[2], 1) : 1;
    const what = !m[4] && !/battlefield/.test(m[6]) ? { what: 'any' as const } : m[4] === 'permanent' || m[4] === 'nonland permanent' ? { what: 'any' as const } : {};
    out.push({ body: { kind: 'recursion', n, toBattlefield: /battlefield/.test(m[6]), ...what }, note: `Reanimate/regrow ${n}` });
  } else if ((m = line.match(/(?:return|put) (?:another )?target (artifact|enchantment|instant or sorcery|instant|sorcery|creature|permanent)? ?card from your graveyard (to your hand|on top of your library|onto the battlefield)/))) {
    const what = m[1] === 'artifact' ? 'artifact' as const : m[1] === 'enchantment' ? 'enchantment' as const : m[1] && /instant|sorcery/.test(m[1]) ? 'instantSorcery' as const : m[1] === 'creature' ? undefined : 'any' as const;
    const toTop = /library/.test(m[2]);
    out.push({ body: { kind: 'recursion', n: 1, toBattlefield: /battlefield/.test(m[2]), ...(what ? { what } : {}), ...(toTop ? { toTop } : {}) }, note: `Return ${m[1] ? `an ${m[1]}`.replace('an c', 'a c').replace('an p', 'a p').replace('an s', 'a s') : 'a'} card from your graveyard ${m[2]}` });
  } else if (/put target creature card from (a|your|any|an opponent's) graveyard onto the battlefield|return enchanted creature card to the battlefield/.test(line)) {
    out.push({ body: { kind: 'recursion', n: 1, toBattlefield: true }, note: 'Reanimate 1' });
  } else if (/return the chosen cards to the battlefield/.test(line) && /in your graveyard/.test(fullLine)) {
    out.push({ body: { kind: 'recursion', n: 2, toBattlefield: true }, note: 'Reanimate 2' });
  } else if (/^choose target creature card in your graveyard/.test(line)) {
    out.push({ body: { kind: 'recursion', n: 1, toBattlefield: false }, note: 'Regrow a creature' });
  }

  // --- Cost reduction ------------------------------------------------------
  m = line.match(/(\w+ )?(\w+ )?spells (?:you cast |of the chosen type )cost \{(\d)\} less/);
  if (m) {
    const phrase = (m[1] ?? '') + (m[2] ?? '');
    const filter: CastFilter = /noncreature/.test(phrase) ? 'noncreature' : /creature/.test(phrase) ? 'creature' : /instant|sorcery/.test(phrase) ? 'instantSorcery' : /artifact/.test(phrase) ? 'artifact' : /enchantment/.test(phrase) ? 'enchantment' : 'any';
    out.push({ body: { kind: 'costReduction', amount: parseInt(m[3], 10), filter }, note: `Cost reduction {${m[3]}} (${filter})` });
  }

  // --- Rule-changing permanents ----------------------------------------------
  if (/it creates twice that many/.test(line)) out.push({ body: { kind: 'doubler', tokens: true, counters: false }, note: 'Doubles the tokens you make' });
  if (/it puts twice that many of those counters/.test(line)) out.push({ body: { kind: 'doubler', tokens: false, counters: true }, note: 'Doubles the +1/+1 counters you place' });
  if (/causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time/.test(line)) {
    out.push({ body: { kind: 'etbDoubler' }, note: 'Your enters abilities trigger twice' });
  }
  if ((m = line.match(/creatures can't attack you( or planeswalkers you control)? unless their controller pays \{(\d)\} for each/))) {
    out.push({ body: { kind: 'attackTax', amount: parseInt(m[2], 10) }, note: `Attack tax: {${m[2]}} per creature attacking you` });
  }
  if ((m = line.match(/^(noncreature )?spells (your opponents cast )?cost \{(\d)\} more to cast/))) {
    out.push({ body: { kind: 'spellTax', amount: parseInt(m[3], 10), filter: m[1] ? 'noncreature' : 'any', ...(m[2] ? {} : { all: true }) }, note: `${m[1] ? 'Noncreature spells' : 'Spells'}${m[2] ? ' your opponents cast' : ''} cost {${m[3]}} more` });
  }
  if ((m = line.match(/^whenever a land enters[^,]*, (?:~|[a-z-]+) deals (\d+) damage to that land's controller/))) {
    out.push({ body: { kind: 'landPunish', n: parseInt(m[1], 10) }, note: `A land entering costs its controller ${m[1]} life` });
  }
  if ((m = line.match(/^each creature (you control )?(with defender )?assigns combat damage equal to its toughness rather than its power/))) {
    out.push({ body: { kind: 'toughnessMatters', defenders: !!m[2] }, note: m[2] ? 'Your defenders attack and deal damage with their toughness' : 'Creatures deal combat damage with their toughness' });
  }
  if (/^creatures you control with power or toughness 1 or less can't be blocked/.test(line)) {
    out.push({ body: { kind: 'anthem', p: 0, t: 0, keywords: ['unblockable'], small: true }, note: "Your creatures with power or toughness 1 or less can't be blocked" });
  }
  if (/exile cards from the top of your library until you exile (a|x) (nonland )?permanent cards?[^.]*\. put (that card|those permanent cards|those cards) onto the battlefield/.test(fullLine) && /^exile cards from the top/.test(line)) {
    out.push({ body: { kind: 'digPermanent' }, note: 'Put the first permanent from the top of your library onto the battlefield' });
  }
  if (/return any number of target creature cards with total (power|mana value) \w+ or less from your graveyard to the battlefield/.test(line)) {
    out.push({ body: { kind: 'recursion', n: 2, toBattlefield: true }, note: 'Reanimate creatures (≈ 2)' });
  }
  if (/each player can't cast more than one spell each turn/.test(line)) out.push({ body: { kind: 'spellLimit' }, note: 'Each player may cast only one spell a turn' });
  if (/your opponents can't cast spells from anywhere other than their hands/.test(line)) out.push({ body: { kind: 'commandLock' }, note: "Opponents can't cast their commanders" });
  if (/would be put into a graveyard from anywhere, exile it instead/.test(line)) out.push({ body: { kind: 'graveyardHate' }, note: 'Cards are exiled instead of going to graveyards' });
  if (/exile all graveyards/.test(line)) out.push({ body: { kind: 'exileGraveyards', all: true }, note: 'Exile all graveyards' });
  else if (/exile (target player's|target opponent's|each opponent's) graveyard/.test(line)) out.push({ body: { kind: 'exileGraveyards', all: false }, note: "Exile opponents' graveyards" });

  // --- Copying, stealing, cheating into play, extra turns ----------------------
  if (/you may have ~ enter as a copy of (any |a |another |target )?(nonland permanent|creature|artifact or creature)/.test(line)) {
    out.push({ body: { kind: 'clone' }, note: 'Enters as a copy of the best creature on the battlefield' });
  }
  if (/gain control of target (\w+ )?(creature|permanent|nonland permanent)/.test(line) && !/until end of turn/.test(fullLine)) {
    out.push({ body: { kind: 'steal', from: 'battlefield' }, note: 'Take control of a creature' });
  }
  if (/put (a|an|up to one) ([^.]*?)(creature|permanent) card[^.]*? from your hand onto the battlefield/.test(line)) {
    out.push({ body: { kind: 'cheat' }, note: 'Put a creature from your hand onto the battlefield' });
  }
  if (/takes? an extra turn after this one/.test(line)) out.push({ body: { kind: 'extraTurn' }, note: 'Extra turn' });
  if (/you've cast another spell named ~ this game, you win the game/.test(line)) {
    out.push({ body: { kind: 'approach' }, note: 'Gain 7 life the first time, win the game the second' });
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
  sacCreature?: boolean;
  minCmc?: number;
  chance?: number;
  oncePerTurn?: boolean;
  nontoken?: boolean;
  loyalty?: number;
}

function detectTrigger(line: string, isPermanent: boolean): LineContext {
  // Strip ability words like "Landfall — " / "Constellation — ".
  let l = line.replace(/^[a-z' ]+ — (?=(when|whenever|at|if|as|~|you|creatures|target|each|draw|create))/, '');
  let m: RegExpMatchArray | null;

  if (/^whenever a land enters[^,]*, [^.]* damage to that land's controller/.test(l)) return { when: 'static', body: l };
  if ((m = l.match(/^whenever a land( you control)? enters[^,]*,\s*(.*)$/))) return { when: 'landfall', body: m[2] };
  if ((m = l.match(/^(when|whenever) ~ (enters|is turned face up)[^,]*,\s*(.*)$/))) return { when: 'resolve', body: m[3] };
  if ((m = l.match(/^whenever an opponent casts (?:an? |their )?([^,]*?)spell([^,]*),\s*(.*)$/))) {
    const what = m[1] + m[2];
    const castFilter: CastFilter = /noncreature/.test(what) ? 'noncreature' : /instant|sorcery/.test(what) ? 'instantSorcery' : /creature/.test(what) ? 'creature' : /artifact/.test(what) ? 'artifact' : /enchantment/.test(what) ? 'enchantment' : 'any';
    return { when: 'opponentCast', castFilter, body: m[3], oncePerTurn: /first/.test(what) || undefined };
  }
  if ((m = l.match(/^whenever you draw (a card|your (first|second|third) card each turn)[^,]*,\s*(.*)$/))) return { when: 'draw', body: m[3], oncePerTurn: m[2] ? true : undefined };
  if ((m = l.match(/^whenever (?:an|another) (artifact|enchantment)(?: you control)? enters(?: under your control| the battlefield under your control)?,\s*(.*)$/))) return { when: 'permEnters', castFilter: m[1] as CastFilter, body: m[2] };
  if ((m = l.match(/^whenever you gain life[^,]*,\s*(.*)$/))) return { when: 'gainLife', body: m[1] };
  // Mutate is played as an ordinary creature, so "whenever this mutates" happens when it enters.
  if ((m = l.match(/^whenever ~ mutates,\s*(.*)$/))) return { when: 'resolve', body: m[1], chance: 0.5 };
  if ((m = l.match(/^whenever an opponent draws a card[^,]*,\s*(.*)$/))) return { when: 'opponentDraw', body: m[1] };
  if ((m = l.match(/^whenever you sacrifice (a|an|another) (\w+ )?(permanent|creature|artifact|token)[^,]*,\s*(.*)$/))) return { when: 'sacrifice', body: m[4] };
  if ((m = l.match(/^whenever (equipped|enchanted) creature dies,\s*(.*)$/))) return { when: 'creatureDies', scope: 'attached', body: m[2] };
  if ((m = l.match(/^whenever ~ or another creature( you control)? dies,\s*(.*)$/))) return { when: 'creatureDies', scope: m[1] ? 'any' : 'all', body: m[2] };
  if ((m = l.match(/^when you cast (this spell|~),\s*(.*)$/))) return { when: 'resolve', body: m[2] };
  if ((m = l.match(/^at the beginning of (your|each) (upkeep|end step|precombat main phase|combat on your turn|draw step|first main phase)[^,]*,\s*(.*)$/))) return { when: 'upkeep', body: m[3] };
  if ((m = l.match(/^at the beginning of each (player's|opponent's) (upkeep|end step)[^,]*,\s*(.*)$/))) return { when: 'upkeep', body: m[3] };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) deals combat damage to (a player|an opponent|one or more|a player or|a player, )[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'self', body: m[3] };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) deals (combat )?damage[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'self', body: m[3] };
  if ((m = l.match(/^whenever one or more (\w+ )?creatures you control deal combat damage to a player[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'oneOrMore', body: m[2] };
  if ((m = l.match(/^whenever (a|another) (\w+ )?(?:creature|\w+) you control deals combat damage to (a player|an opponent)[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'any', body: m[4] };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) attacks[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'self', body: m[2] };
  if ((m = l.match(/^whenever (you attack|one or more (?:\w+ )?\w+ you control attack)[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'oneOrMore', body: m[2] };
  if ((m = l.match(/^whenever (a|another) (\w+ )?(?:creature|\w+) you control attacks[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'any', body: m[3] };
  if ((m = l.match(/^whenever you cast (an? |your )?([^,]*?)spell([^,]*),\s*(.*)$/))) {
    const what = m[2] + m[3];
    const castFilter: CastFilter = /noncreature/.test(what) ? 'noncreature' : /instant|sorcery/.test(what) ? 'instantSorcery' : /creature/.test(what) ? 'creature' : /artifact/.test(what) ? 'artifact' : /enchantment/.test(what) ? 'enchantment' : 'any';
    const mv = what.match(/mana value (\d+) or greater/);
    return { when: 'cast', castFilter, body: m[4], minCmc: mv ? parseInt(mv[1], 10) : undefined };
  }
  if ((m = l.match(/^whenever (a|another|one or more)( nontoken)? (\w+ )?(creatures?|tokens?)( you control)? (enters?|enter)[^,]*,\s*(.*)$/))) return { when: 'creatureEnters', body: m[7], nontoken: !!m[2] || undefined };
  // Tribal wording: "whenever another nontoken Dragon you control enters". Treated as any creature.
  if ((m = l.match(/^whenever (a|another|one or more)( other)?( nontoken)? (?!artifact|enchantment|permanent|planeswalker|player|opponent|land|spell)(\w+) you control( of the chosen type)? (enters?)[^,]*,\s*(.*)$/))) return { when: 'creatureEnters', body: m[7], nontoken: !!m[3] || undefined };
  if ((m = l.match(/^whenever (a|another|one or more)( nontoken)? (\w+ )?creatures?( you control)? (dies|die|is put into a graveyard)[^,]*,\s*(.*)$/))) return { when: 'creatureDies', scope: m[4] ? undefined : 'all', body: m[6] };
  if ((m = l.match(/^when ~ dies[^,]*,\s*(.*)$/))) return { when: 'creatureDies', scope: 'self', body: m[1] };

  // Planeswalker loyalty abilities: treat the first + or 0 ability as a per-turn effect.
  if ((m = l.match(/^([+-]?\d+): (.*)$/))) return { when: 'loyalty', loyalty: parseInt(m[1], 10), body: m[2] };
  if (/^-x: /.test(l)) return { when: 'static', body: '' };

  // Activated abilities: "COST: EFFECT" where cost is mana/tap symbols.
  const COST_PART = '(?:(?:\\{[^}]+\\})+|sacrifice ~|sacrifice (?:a|an|another) creature|pay \\d+ life)';
  if ((m = l.match(new RegExp(`^(${COST_PART}(?:, ${COST_PART})*):\\s*(.*)$`)))) {
    const costText = m[1];
    const tap = /\{t\}/.test(costText);
    const cost = parseManaCost(costText.replace(/\{t\}|\{q\}/g, ''));
    const life = costText.match(/pay (\d+) life/);
    if (life) cost.life += parseInt(life[1], 10);
    return { when: 'activated', body: m[2], activationCost: cost, tap, sacrifice: /sacrifice ~/.test(costText), sacCreature: /sacrifice (a|an|another) creature/.test(costText) };
  }

  // Other triggered/conditional lines we don't model.
  if (/^(when|whenever|at the beginning)/.test(l)) return { when: 'static', body: '' };

  l = l.replace(/^(kicker|flashback|buyback|entwine|overload) [^\n]*$/, '');
  return { when: isPermanent ? 'static' : 'resolve', body: l };
}

/** Most lines are one ability. "Whenever ~ enters or attacks" is two triggers with the same effect. */
function detectTriggers(line: string, isPermanent: boolean): LineContext[] {
  // "Whenever a player casts a spell" watches you and your opponents.
  const anyone = line.match(/^(.*?)whenever a player casts (.*)$/);
  if (anyone) return [detectTrigger(`${anyone[1]}whenever you cast ${anyone[2]}`, isPermanent), detectTrigger(`${anyone[1]}whenever an opponent casts ${anyone[2]}`, isPermanent)];
  const both = line.match(/^(.*?whenever [^,]*?)\benters or attacks\b([^,]*,.*)$/);
  if (both) return [detectTrigger(`${both[1]}enters${both[2]}`, isPermanent), detectTrigger(`${both[1]}attacks${both[2]}`, isPermanent)];
  return [detectTrigger(line, isPermanent)];
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
  const isModal = /choose (one|two|one or both|one or more|up to one|up to two) —|choose one\./.test(text);
  // "When ~ enters, choose one —": the bullets that follow happen on that trigger.
  let header: LineContext[] | null = null;
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const modalFound: { found: Found; ctx: LineContext }[] = [];
  let manaLines = 0;
  const unread: string[] = [];
  /** Note a line as unread unless something later claims it. Lines the engine handles elsewhere are skipped. */
  let pendingLine: { text: string; before: number } | null = null;
  const settle = () => {
    if (pendingLine && card.effects.length + modalFound.length + manaLines === pendingLine.before && !handledElsewhere(pendingLine.text, keywords, isLand)) unread.push(pendingLine.text);
    pendingLine = null;
  };
  const lineRead = (text: string) => {
    settle();
    pendingLine = { text, before: card.effects.length + modalFound.length + manaLines };
  };

  for (const rawLine of lines) {
    const bullet = rawLine.startsWith('•');
    const line = rawLine.replace(/^•\s*/, '');
    if (isLand && (/: add /.test(line) || /sacrifice ~[^:]*: search/.test(line))) continue;
    lineRead(line);
    if (!bullet) header = /choose (one|two|one or both|one or more|up to one|up to two) —$/.test(line) ? detectTriggers(line, isPermanent).filter((c) => c.when !== 'static' || !isPermanent) : null;
    // Bullets can carry a name ("Sell Contraband — Create a Treasure token.").
    const option = bullet ? line.replace(/^[a-z' ]{3,30} — /, '') : line;
    const contexts = bullet && header?.length ? header.map((h) => ({ ...h, body: option })) : detectTriggers(option, isPermanent);
    for (const ctx of contexts) {
    if (!ctx.body) continue;
    // "Unless that player pays": assume opponents pay some of the time.
    if ((ctx.when === 'opponentCast' || ctx.when === 'opponentDraw') && /unless (that player|they) pays?|that player may pay/.test(ctx.body)) ctx.chance = 0.6;
    // Intervening "if" clauses: we can't check the condition, so assume it holds half the time.
    if (ctx.when !== 'resolve' && ctx.when !== 'static' && /^if [^,]+, /.test(ctx.body)) {
      ctx.chance = 0.5;
      ctx.body = ctx.body.replace(/^if [^,]+, /, '');
    }
    if (/only once each turn/.test(line)) ctx.oncePerTurn = true;
    // "Their second spell each turn", "your second card": at most once a turn, and often not at all.
    if (/^[^,]*\b(second|third)\b[^,]*,/.test(line) && ctx.when !== 'draw') {
      ctx.oncePerTurn = true;
      ctx.chance = 0.5;
    }
    // "With mana value equal to the chosen number" and the like: only some spells qualify.
    if ((ctx.when === 'opponentCast' || ctx.when === 'cast') && /^whenever [^.]*\b(chosen number|chosen name|same name as)\b/.test(line)) ctx.chance = 0.25;
    // Voting: only one outcome happens. With bots at the table, assume the last one listed (ties usually go there).
    if (/votes? for/.test(ctx.body)) ctx.body = ctx.body.split(/(?<=\.)\s+/).slice(-1)[0];
    // Kicker isn't paid: drop what the kicked version does instead.
    ctx.body = ctx.body.replace(/\s*if (this spell|~|it) was kicked, instead [^.]*\./g, '');
    // Sensei's Divining Top: the draw costs the Top itself, so it isn't card advantage.
    if (ctx.when === 'activated' && /put ~ on top of (its owner's|your) library/.test(ctx.body)) ctx.body = '';
    // A line can hold several sentences, e.g. "Draw two cards. Create a Treasure."
    const sentences = ctx.body.replace(/"[^"]*"/g, '').split(/(?<=\.)\s+(?=[a-z~])/);
    for (const sentence of sentences) {
      const found = recogniseEffects(sentence, { isPermanent, isCreature }, ctx.body);
      // Mana abilities on nonland permanents (rocks and dorks).
      const manaMatch = ctx.when === 'activated' ? sentence.match(/^(?:for each [^,]*, )?add (.*)$/) : null;
      // Rituals: mana from an instant or sorcery is kept as that many Treasures.
      const ritual = (!isPermanent || /^when ~ enters/.test(line)) && ctx.when === 'resolve' ? sentence.match(/^add (.*)$/) : null;
      if (ritual) {
        const p = parseProduced(ritual[1]);
        const n = /for each/.test(sentence) ? 3 : p?.amount ?? 0;
        const f: Found = { body: { kind: 'treasure', n }, note: `Ritual: ${n} one-shot mana` };
        if (n > 0) {
          if (isModal && bullet) modalFound.push({ found: f, ctx });
          else pushEffect(card, f, ctx);
        }
        continue;
      }
      if (manaMatch) {
        const p = /^for each color/.test(sentence) ? { amount: 2, colors: 'any' as const } : parseProduced(manaMatch[1]);
        if (p && ctx.sacCreature) {
          pushEffect(card, { body: { kind: 'treasure', n: p.amount }, note: `Sacrifice a creature for ${p.amount} mana` }, ctx);
          continue;
        }
        const paid = ctx.activationCost ? ctx.activationCost.generic + ctx.activationCost.pips.length : 0;
        if (p && ctx.tap && !ctx.sacrifice) {
          manaLines++;
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
  }
  settle();
  if (unread.length) card.unread = unread;

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

  if (card.isPlaneswalker) {
    const printed = parseInt(String(raw.loyalty ?? ''), 10);
    // Importers that don't report loyalty: it is usually close to the mana value.
    card.loyalty = Number.isNaN(printed) ? Math.max(3, Math.min(raw.cmc, 6)) : printed;
    card.notes.unshift(`Planeswalker, loyalty ${card.loyalty}`);
  }
  if (!isLand && isPermanent && /^~ enters tapped\.?$/m.test(text)) {
    card.entersTapped = true;
    card.notes.push('Enters tapped');
  }
  if (keywords.includes('uncounterable')) card.notes.push("Can't be countered");
  if (/^as an additional cost to cast ~, pay x life/m.test(text)) {
    card.xFromLife = true;
    card.notes.push('X is paid in life');
  }
  if (isPermanent && /^~ doesn't untap during your untap step/m.test(text)) {
    card.noUntap = true;
    card.notes.push("Doesn't untap by itself");
  }
  if (/^if you control a commander, you may cast ~ without paying its mana cost/m.test(text)) {
    card.freeWithCommander = true;
    card.notes.push('Free while you control a commander');
  }
  const cycling = text.match(/^((?:basic )?[a-z]*)cycling ((?:\{[^}]+\})+)/m);
  if (cycling) {
    card.cycling = { cost: parseManaCost(cycling[2]) };
    if (cycling[1]) card.cycling.land = true;
    card.notes.push(cycling[1] ? `${cycling[1][0].toUpperCase()}${cycling[1].slice(1)}cycling ${cycling[2].toUpperCase()}: discard to search for a land` : `Cycling ${cycling[2].toUpperCase()}: discard to draw a card`);
  }
  const flashback = !isPermanent && text.match(/^flashback ((?:\{[^}]+\})+)/m);
  if (flashback) {
    card.flashback = parseManaCost(flashback[1]);
    card.notes.push(`Flashback ${flashback[1].toUpperCase()}: cast again from your graveyard`);
  }
  const crew = !isCreature && isPermanent && text.match(/^crew (\d+)/m);
  if (crew) {
    card.crew = parseInt(crew[1], 10);
    card.notes.unshift(`Vehicle ${card.power}/${card.toughness}${card.keywords.length ? ` — ${card.keywords.join(', ')}` : ''}, crew ${card.crew}`);
  }
  const stun = isPermanent && text.match(/^~ enters tapped with (\w+) stun counters? on it/m);
  if (stun) {
    card.entersTapped = true;
    card.stun = num(stun[1], 1);
    card.notes.push(`Enters tapped with ${card.stun} stun counters`);
  }
  const overload = !isPermanent && text.match(/^overload ((?:\{[^}]+\})+)/m);
  if (overload) {
    const effects = card.effects.filter((e) => e.when === 'resolve').map((e): Effect => {
      if (e.kind === 'removal' && e.mode !== 'edict' && e.mode !== 'fight') {
        const target = e.target === 'creature' ? 'creatures' as const : e.target === 'artifactEnchantment' && /target artifact you don't control/.test(text) ? 'artifacts' as const : 'nonland' as const;
        return { kind: 'wipe', target, mode: e.mode, amount: e.amount, oneSided: true, when: 'resolve' };
      }
      if (e.kind === 'pump') return { kind: 'overrun', p: e.p, t: e.t, trample: false, ...(e.grant ? { grant: e.grant } : {}), when: 'resolve' };
      return e;
    });
    card.overload = { cost: parseManaCost(overload[1]), effects };
    card.notes.push(`Overload ${overload[1].toUpperCase()}: hits everything instead of one target`);
  }
  if (!isPermanent && /^storm\b/m.test(text)) {
    card.storm = true;
    card.notes.push('Storm: copied for each spell cast before it this turn');
  }
  const cda = isCreature && text.match(/^~'s power (and toughness are each|is) equal to the number of (cards in your hand|cards in your graveyard|cards in (?:your opponents'|the chosen player's|all) graveyards?|creature cards in all graveyards|instant and sorcery cards in your graveyard|artifacts you control|creatures you control|lands you control|(?:islands|swamps|forests|mountains|plains) you control|[a-z, /]+ you control)/m);
  if (cda) {
    const what = cda[2];
    const by = what === 'cards in your hand' ? 'hand' : what === 'cards in your graveyard' ? 'graveyard' : /creature cards in all/.test(what) ? 'allGraveyardCreatures' : /chosen player's/.test(what) ? 'oneGraveyard' : /graveyards?$/.test(what) ? 'oppGraveyards' : /instant and sorcery/.test(what) ? 'spellsInGraveyard' : /artifacts/.test(what) ? 'artifacts' : /lands|islands|swamps|forests|mountains|plains/.test(what) ? 'lands' : 'creatures';
    card.scales = { by, toughness: /toughness/.test(cda[1]) };
    // The printed "*" is the count itself ("1+*" keeps its 1).
    if (/\*/.test(String(raw.power ?? ''))) card.power = parseInt(String(raw.power), 10) || 0;
    if (/\*/.test(String(raw.toughness ?? ''))) card.toughness = card.scales.toughness ? parseInt(String(raw.toughness), 10) || 0 : card.toughness;
    card.notes.push(`Power${card.scales.toughness ? ' and toughness' : ''} equal to the number of ${what}`);
  }
  const extra = text.match(/^as an additional cost to cast ~, (sacrifice (?:a|an) (creature|artifact or creature|artifact)|discard (a|two) cards?|sacrifice an artifact or discard a card)\.?$/m);
  if (extra) {
    if (/or discard/.test(extra[1])) card.extraCost = { sacrifice: 'artifact', discard: 1, either: true };
    else if (extra[2]) card.extraCost = { sacrifice: extra[2] === 'creature' ? 'creature' : extra[2] === 'artifact' ? 'artifact' : 'artifactOrCreature' };
    else card.extraCost = { discard: extra[3] === 'two' ? 2 : 1 };
    card.notes.push(`Additional cost: ${extra[1]}`);
  }
  const perEach = text.match(/^~ costs \{(\d)\} less to cast for each (creature on the battlefield|creature card in your graveyard|artifact you control|creature you control)/m);
  if (perEach) {
    const per = perEach[2] === 'creature on the battlefield' ? 'allCreatures' : perEach[2] === 'creature card in your graveyard' ? 'graveyardCreatures' : perEach[2] === 'artifact you control' ? 'artifacts' : 'creatures';
    card.discount = { per, amount: parseInt(perEach[1], 10) };
  } else if (/^(affinity for artifacts|improvise)/m.test(text)) card.discount = { per: 'artifacts', amount: 1 };
  else if (/^convoke/m.test(text)) card.discount = { per: 'creatures', amount: 1 };
  else if (/^delve/m.test(text)) card.discount = { per: 'graveyard', amount: 1 };
  if (card.discount) card.notes.push(`Costs {${card.discount.amount}} less for each ${{ artifacts: 'artifact you control', creatures: 'creature you control', allCreatures: 'creature on the battlefield', graveyardCreatures: 'creature card in your graveyard', graveyard: 'card in your graveyard' }[card.discount.per]}`);

  // Playing off the top of the library every turn is roughly an extra card a turn.
  if (isPermanent && /you may (play lands and )?cast spells from the top of your library/.test(text)) {
    card.effects.push({ kind: 'draw', n: 1, when: 'upkeep' });
    card.notes.push('Each turn: play off the top of your library (≈ draw 1)');
  }
  // Approach of the Second Sun handles its own life gain.
  if (card.effects.some((e) => e.kind === 'approach')) {
    card.effects = card.effects.filter((e) => e.kind !== 'gainLife');
    card.notes = card.notes.filter((n) => !/^Gain \d+ life$/.test(n));
  }

  // Equipment: remember the equip cost so the rules engine can charge it.
  const equipCost = text.match(/^equip((?:\{[^}]+\})+)/m) ?? text.match(/^equip (?:[a-z ]+ )?((?:\{[^}]+\})+)/m);
  if (equipCost) {
    for (const e of card.effects) if (e.kind === 'equip' && !e.aura) e.cost = parseManaCost(equipCost[1]);
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

  card.modeled = isLand || (isCreature && (card.power > 0 || card.toughness > 0 || !!card.entersWithX || !!card.scales)) || card.effects.length > 0 || !!card.cycling || !!card.crew;
  if (!card.modeled) card.notes.push('Not modeled — treated as a blank card');
  else for (const line of card.unread ?? []) card.notes.push(`Not read: "${line.length > 90 ? `${line.slice(0, 90)}…` : line}"`);
  card.value = cardValue(card);
  return card;
}

/** Lines that need no effect of their own: keyword lines, attachment boilerplate, things read from the whole text. */
function handledElsewhere(line: string, keywords: string[], isLand: boolean): boolean {
  const parts = line.split(/,\s*/).map((p) => p.trim().replace(/ \{.*$/, '').replace(/[.]$/, ''));
  if (parts.every((p) => keywords.includes(p) || (p.startsWith('ward') && keywords.includes('ward')))) return true;
  if (/^(enchant |equip\b|choose (one|two|one or both|one or more|up to \w+)\b)/.test(line) || /choose (one|two|one or both|one or more|up to one|up to two) —$/.test(line)) return true;
  if (/^~ can't be blocked\.?$/.test(line) && keywords.includes('unblockable')) return true;
  if (/enters with (x|\w+) \+1\/\+1 counters?/.test(line)) return true;
  if (isLand && /enters tapped|^as ~ enters|^\(|^~ is every|basic land type/.test(line)) return true;
  // Read from the whole text into flags on the card.
  if (/^~ doesn't untap during your untap step|^if you control a commander, you may cast ~ without paying its mana cost|^as an additional cost to cast ~, (sacrifice (a|an) (creature|artifact|artifact or creature)|discard (a|two) cards?|sacrifice an artifact or discard a card)\.?$/.test(line)) return true;
  if (/^~ enters tapped\.?$|^~ can't be countered|^affinity for artifacts|^improvise|^convoke|^delve|^~ costs \{\d\} less to cast for each (creature on the battlefield|creature card in your graveyard|artifact you control|creature you control)|^as an additional cost to cast ~, pay x life|^mutate |^(basic )?[a-z]*cycling (\{[^}]+\})+|^flashback (\{[^}]+\})+|^overload (\{[^}]+\})+|^crew \d+|^~ enters tapped with \w+ stun counters? on it|^storm\b|^~'s power (and toughness are each|is) equal to the number of (cards in your hand|cards in your graveyard|cards in (your opponents'|the chosen player's|all) graveyards?|creature cards in all graveyards|instant and sorcery cards in your graveyard|[a-z, \/]+ you control)/.test(line)) return true;
  // Text that changes nothing in this engine: deck-building rules, creature types, hidden-information permissions.
  if (/^a deck can have|^changeling|^choose a background|^as ~ enters, choose a creature type|^you may look at the top card of your library any time|^exile ~\.?$|^devoid|^partner|^~ is all colors/.test(line)) return true;
  return false;
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
  if (ctx.nontoken) effect.nontoken = true;
  if (ctx.loyalty !== undefined) effect.loyalty = ctx.loyalty;
  if (ctx.when === 'activated') {
    if (!ctx.activationCost) return;
    effect.activation = { cost: ctx.activationCost, tap: !!ctx.tap, sacrifice: !!ctx.sacrifice, ...(ctx.sacCreature ? { sacCreature: true } : {}) };
  }
  // Static lines on a permanent only make sense for static effects.
  const staticKinds = ['spellTax', 'landPunish', 'toughnessMatters', 'anthem', 'equip', 'costReduction', 'noMaxHand', 'winOnEmptyDraw', 'doubler', 'etbDoubler', 'attackTax', 'spellLimit', 'commandLock', 'graveyardHate', 'clone'];
  // "You may play an additional land on each of your turns" is static; a one-off extra land drop is not.
  if (effect.kind === 'extraLand' && ctx.when === 'static') {
    card.effects.push(effect);
    card.notes.push('Extra land drop every turn');
    return;
  }
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
    case 'creatureDies': return ctx.scope === 'self' ? 'When it dies: ' : ctx.scope === 'attached' ? 'When the creature wearing it dies: ' : ctx.scope === 'all' ? 'When any creature dies: ' : 'When a creature dies: ';
    case 'landfall': return 'Landfall: ';
    case 'opponentCast': return `When an opponent casts ${ctx.castFilter === 'any' ? 'a spell' : `${ctx.castFilter} spells`}: `;
    case 'opponentDraw': return 'When an opponent draws: ';
    case 'sacrifice': return 'When you sacrifice: ';
    case 'draw': return 'When you draw: ';
    case 'permEnters': return `When an ${ctx.castFilter} enters under your control: `;
    case 'gainLife': return 'When you gain life: ';
    case 'activated': return 'Activated: ';
    case 'loyalty': return `${(ctx.loyalty ?? 0) > 0 ? '+' : ''}${ctx.loyalty}: `;
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
      case 'loseLife': v -= 0.1 * e.n; break;
      case 'tutor': v += 3; break;
      case 'recursion': v += 2 * e.n; break;
      case 'counters': v += e.n * (e.all ? 2 : 1) * mult; break;
      case 'extraLand': v += 1.5; break;
      case 'treasure': v += 1.2 * e.n * (e.when === 'activated' ? 1 : mult); break;
      case 'doubler': v += 4; break;
      case 'etbDoubler': v += 3; break;
      case 'attackTax': v += 1.5 * e.amount; break;
      case 'spellLimit': case 'commandLock': case 'graveyardHate': v += 2; break;
      case 'exileGraveyards': v += 0.5; break;
      case 'clone': v += 5; break;
      case 'steal': v += 6; break;
      case 'cheat': v += 3 * mult; break;
      case 'extraTurn': v += 6; break;
      case 'approach': v += 10; break;
      case 'scry': v += 0.3 * e.n * mult; break;
      case 'mill': v += (e.who === 'you' ? 0.3 : 1) * mult; break;
      case 'discard': v += e.n * mult; break;
      case 'noMaxHand': v += 0.5; break;
      case 'winOnEmptyDraw': v += 2; break;
      case 'monarch': v += 4; break;
    }
  }
  return Math.max(v, card.cmc * 0.4);
}

function xOr3(n: number): number {
  return n === -1 ? 3 : n;
}
