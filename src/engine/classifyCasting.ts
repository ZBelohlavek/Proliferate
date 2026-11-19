// Alternative casting keywords and flash for the card reader.
//
// Foretell, suspend, plot, transmute, channel, hideaway, impending, warp, prowl,
// blitz, emerge, madness, miracle, cipher, spree and tiered modes, Leylines,
// "cast ~ only ..." timing, odd flashback costs and cycling triggers go into
// SimCard.casting. Optional costs that work like kicker (entwine, buyback,
// bargain, gift, cleave, replicate, casualty) go into SimCard.kicker with `as`.
// "You may cast spells as though they had flash" is read as a flashGrant effect.
//
// classify.ts calls in here at four points:
// - castingBase(text) before reading: the card as cast the ordinary way, with
//   "if this spell was bargained / the gift was promised / ..." clauses dropped
//   and lines that belong to another way of casting it taken out;
// - recogniseCasting(sentence, ...) for flash grants, hideaway and the like;
// - castingKeywords(...) once the card is read, for the keywords themselves
//   (variants are read again through `classify` with the clause kept);
// - castingLineHandled(line) for keyword lines that need no effect of their own.

import type { RawCard } from './classify';
import type { Casting, EffectBody, FlashFilter, ManaCost, SimCard } from './types';

type Found = { body: EffectBody; note: string; chance?: number };

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twenty: 20 };
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w) ? parseInt(w, 10) : WORDS[w] ?? fallback);

const COST = '((?:\\{[^}]+\\})+)';

/** Lines that are a casting keyword (or its reminder-less remains): nothing to read in them as an ability. */
const KEYWORD_LINE = new RegExp([
  '^whenever an opponent casts a spell, if ~ is suspended, remove a time counter from it\\.?$',
  `^foretell ${COST}$`, `^suspend \\d+—${COST}$`, `^plot ${COST}$`, `^transmute ${COST}$`, '^hideaway \\d+$', `^impending \\d+—${COST}$`,
  `^warp ${COST}$`, `^prowl ${COST}$`, `^blitz ${COST}$`, `^emerge (?:from artifact )?${COST}$`, `^madness ${COST}$`, `^miracle ${COST}$`,
  '^cipher$', '^spree$', '^tiered$', `^entwine ${COST}$`, `^buyback ${COST}$`, `^cleave ${COST}$`, `^replicate ${COST}$`, '^casualty \\d+$', '^bargain$',
  '^gift an? [a-z ]+$', '^compleated$', '^companion — .*$', `^channel — ${COST}, discard ~: .*$`, '^when you cycle ~(?: or discard it)?, .*$',
  '^if ~ is in your opening hand, you may begin the game with it on the battlefield\\.?$',
  "^cast ~ only (?:during combat on an opponent's turn|during the declare blockers step on an opponent's turn|before combat or during combat before blockers are declared)\\.?$",
  "^you can't cast ~ during your first, second, or third turns of the game\\.?$",
  '^flashback—sacrifice (?:two|three|four|\\d+) creatures\\.?$',
  "^you may cast ~ as though it had flash\\. if you cast it any time a sorcery couldn't have been cast, .*$",
  '^you may cast ~ as though it had flash by tapping (?:two|three|four) untapped creatures you control with flying in addition to paying its other costs\\.?$',
].join('|'));

/** Clauses that only apply when the spell was cast some other way ("if this spell was bargained, ..."). */
const CONDITIONS = {
  bargain: '(?:this spell|~|it) was bargained',
  gift: 'the gift was promised',
  prowl: "(?:this spell's|~'s) prowl cost was paid",
  exile: '(?:this spell|~|it) was cast from exile',
} as const;
type Condition = keyof typeof CONDITIONS;

/** The text with clauses under `cond` applied (`on`) or dropped. */
function conditioned(text: string, cond: Condition, on: boolean): string {
  const c = CONDITIONS[cond];
  let t = text;
  if (on) {
    // "Return target creature. If the gift was promised, instead return target nonland permanent.": the second replaces the first.
    t = t.replace(new RegExp(`(^|\\.\\s+)[^.\\n]*\\.\\s*if ${c}, instead ([^.]*\\.)`, 'gm'), '$1$2');
    // "~ deals 2 damage ... If this spell was cast from exile, it deals 5 damage ... instead."
    t = t.replace(new RegExp(`(^|\\.\\s+)[^.\\n]*\\.\\s*if ${c}, ([^.]*) instead\\.`, 'gm'), '$1$2.');
    // "Then if the gift was promised and that creature isn't legendary, create ...": an addition.
    t = t.replace(new RegExp(`(?:then )?if ${c}(?: and [^,]*)?, ([^.]*\\.)`, 'g'), '$1');
    t = t.replace(/(^|\.\s+)it deals /gm, '$1~ deals ');
  } else {
    t = t.replace(new RegExp(`\\s*(?:then )?if ${c}[^.]*\\.`, 'g'), '');
  }
  return t;
}

/** Spree and tiered mode lines: "+ {2} — ..." and "• fire — {0} — ...". */
const SPREE_MODE = new RegExp(`^\\+ ${COST} — (.*)$`);
const TIER_MODE = new RegExp(`^•\\s*([a-z' ]+) — ${COST} — (.*)$`);

/** Drop the keyword lines (so reading a variant again can't recurse) and the lines of other casting modes. */
function stripped(text: string): string {
  return text.split('\n').filter((l) => !KEYWORD_LINE.test(l.trim()) && !SPREE_MODE.test(l.trim()) && !TIER_MODE.test(l.trim())).join('\n')
    // Inspiring Refrain, Charnel Serenade: suspending itself again is read as a keyword.
    .replace(/\s*exile ~ with (\w+) time counters on it\./g, '');
}

/** The card's text as cast the ordinary way, for the main reading. */
export function castingBase(text: string): string {
  let t = text.split('\n').map((l) => l.trim()).join('\n');
  for (const cond of Object.keys(CONDITIONS) as Condition[]) t = conditioned(t, cond, false);
  // Cleave: the ordinary version keeps the bracketed words (classifyRare drops brackets, which is the cleaved version).
  t = t.replace(/ \[([^\]]*)\]/g, ' $1');
  return t.split('\n').filter((l) => {
    const line = l.trim();
    return !SPREE_MODE.test(line) && !TIER_MODE.test(line) && !/^channel — /.test(line) && !/^when you cycle ~/.test(line);
  }).join('\n').replace(/\s*exile ~ with (\w+) time counters on it\./g, '');
}

export function castingLineHandled(line: string): boolean {
  return KEYWORD_LINE.test(line) || SPREE_MODE.test(line) || TIER_MODE.test(line);
}

/** Sentence recognisers: flash grants, playing a hidden card, plotting from hand, Moonsnare Prototype's tuck. */
export function recogniseCasting(line: string, out: Found[], fullLine: string) {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^(until your next turn, )?you may cast (spells|sorcery spells|artifact spells|colorless spells|colorless spells and artifact spells|noncreature spells|aura and equipment spells|creature spells) (this turn )?as though they had flash/))) {
    const what: FlashFilter = ({ spells: 'all', 'sorcery spells': 'sorcery', 'artifact spells': 'artifact', 'colorless spells': 'colorless', 'colorless spells and artifact spells': 'artifactOrColorless', 'noncreature spells': 'noncreature', 'aura and equipment spells': 'auraEquipment', 'creature spells': 'all' } as const)[m[2] as 'spells'];
    const until = m[1] ? 'yourNextTurn' as const : m[3] ? 'turn' as const : undefined;
    out.push({ body: { kind: 'flashGrant', what, ...(until ? { until } : {}) }, note: `You may cast ${m[2]} as though they had flash${until === 'turn' ? ' this turn' : until ? ' until your next turn' : ''}` });
  }
  if (/^you may cast the first creature spell you cast each turn as though it had flash/.test(line)) {
    out.push({ body: { kind: 'flashGrant', what: 'creatureFirst' }, note: 'Your first creature spell each turn has flash' });
  }
  if (/you may play the exiled card without paying its mana cost/.test(line)) {
    const gy = fullLine.match(/(\w+) or more cards in your graveyard/);
    const cond = /total power 10 or greater/.test(line) ? 'power10' as const : /attacked with three or more creatures this turn/.test(line) ? 'attacked3' as const : /an opponent was dealt 7 or more damage this turn/.test(line) ? 'damage7' as const : undefined;
    const why = gy ? ` with ${count(gy[1], 20)}+ cards in your graveyard` : cond === 'power10' ? ' if your creatures have total power 10+' : cond === 'attacked3' ? ' if you attacked with three or more creatures this turn' : cond === 'damage7' ? ' if an opponent was dealt 7+ damage this turn' : '';
    out.push({ body: { kind: 'playHidden', ...(gy ? { graveyard: count(gy[1], 20) } : {}), ...(cond ? { cond } : {}) }, note: `Play the hidden card for free${why}` });
  }
  if ((m = line.match(/^you may exile a nonland card with mana value (\d+) or less from your hand/)) && /becomes plotted/.test(fullLine)) {
    out.push({ body: { kind: 'plotFromHand', maxCmc: parseInt(m[1], 10) }, note: `Plot a nonland card with mana value ${m[1]} or less from your hand` });
  }
  // Cleave's ordinary version (Alchemist's Retrieval): bouncing your own permanent saves it from removal.
  if (/^return target nonland permanent you control to its owner's hand/.test(line)) {
    out.push({ body: { kind: 'protect' }, note: 'Return a permanent of yours to hand (≈ saves it from removal)' });
  }
  if (/^the owner of target nonland permanent puts it on their choice of the top or bottom of their library/.test(line)) {
    out.push({ body: { kind: 'removal', target: 'permanent', mode: 'bounce', amount: 0 }, note: 'Put a nonland permanent on top of or under its owner\'s library (≈ bounce)' });
  }
}

const upper = (s: string) => s.toUpperCase();
const ZERO: ManaCost = { generic: 0, pips: [], x: 0, life: 0 };

/**
 * Read the casting keywords of a card already read the ordinary way. `text` is the card's full normalised
 * text; `classify` reads variant texts (the card cast another way).
 */
export function castingKeywords(raw: RawCard, text: string, card: SimCard, classify: (raw: RawCard) => SimCard, parseCost: (cost: string) => ManaCost) {
  const c: Casting = {};
  let m: RegExpMatchArray | null;
  // Reminder text leaves trailing spaces behind ("transmute {1}{u}{u} ").
  text = text.split('\n').map((l) => l.trim()).join('\n');
  const base = stripped(text);
  /** The card read again from different text (a variant). Its unread lines count as the card's. */
  const variant = (t: string, asSpell = false): SimCard => {
    const v = classify({ ...raw, name: `${raw.name} (variant)`, text: t, back: null, ...(asSpell ? { types: ['Sorcery'], subTypes: [], superTypes: [], power: null, toughness: null, loyalty: null } : {}) });
    for (const u of v.unread ?? []) if (!(card.unread ?? []).includes(u)) (card.unread ??= []).push(u);
    return v;
  };
  const resolveOf = (v: SimCard) => v.effects.filter((e) => e.when === 'resolve');
  const has = (cond: Condition) => new RegExp(`if ${CONDITIONS[cond]}`).test(text);

  if ((m = text.match(new RegExp(`^foretell ${COST}$`, 'm')))) {
    c.foretell = { cost: parseCost(m[1]) };
    if (has('exile')) c.foretell.effects = variant(conditioned(base, 'exile', true)).effects;
    card.notes.push(`Foretell ${upper(m[1])}: on your turn pay {2} to exile it face down, cast it later for ${upper(m[1])}${c.foretell.effects ? ' (stronger when cast from exile)' : ''}`);
  }
  if ((m = text.match(new RegExp(`^suspend (\\d+)—${COST}$`, 'm')))) {
    c.suspend = { n: parseInt(m[1], 10), cost: parseCost(m[2]) };
    const again = text.match(/exile ~ with (\w+) time counters on it\./);
    if (again) c.suspend.again = count(again[1], 3);
    if (/^whenever an opponent casts a spell, if ~ is suspended, remove a time counter from it/m.test(text)) c.suspend.onOpponentCast = true;
    if (!raw.manaCost) c.noCost = true;
    card.notes.push(`Suspend ${m[1]}—${upper(m[2])}: exile it with ${m[1]} time counters, cast free when the last comes off${card.isCreature ? ' (with haste)' : ''}${again ? `; suspends itself again for ${c.suspend.again}` : ''}${c.noCost ? ' (no mana cost: suspend is the only way to cast it)' : ''}`);
  }
  if ((m = text.match(new RegExp(`^plot ${COST}$`, 'm')))) {
    c.plot = parseCost(m[1]);
    card.notes.push(`Plot ${upper(m[1])}: exile it now, cast it free as a sorcery on a later turn`);
  }
  if ((m = text.match(new RegExp(`^transmute ${COST}$`, 'm')))) {
    c.transmute = parseCost(m[1]);
    card.notes.push(`Transmute ${upper(m[1])}: discard it to find a card with mana value ${card.cmc}`);
  }
  if ((m = text.match(new RegExp(`^channel — ${COST}, discard ~: (.*)$`, 'm')))) {
    const effects = resolveOf(variant(m[2], true));
    if (effects.length) {
      c.channel = { cost: parseCost(m[1]), effects };
      card.notes.push(`Channel ${upper(m[1])}: discard it for "${m[2].replace(/\.$/, '')}"`);
    } else (card.unread ??= []).push(`channel — ${m[1]}, discard ~: ${m[2]}`);
  }
  if ((m = text.match(/^hideaway (\d+)$/m))) {
    c.hideaway = parseInt(m[1], 10);
    card.notes.push(`Hideaway ${m[1]}: exiles one of the top ${m[1]} cards face down as it enters`);
  }
  // Impending, warp, prowl, blitz and emerge are alternative costs (rule 118.9), read into SimCard.altCost.
  const alt = (mana: ManaCost, extra: Partial<NonNullable<SimCard['altCost']>>, note: string) => {
    if (card.altCost) return;
    card.altCost = { mana, ...extra };
    card.notes.push(note);
  };
  if ((m = text.match(new RegExp(`^impending (\\d+)—${COST}$`, 'm')))) {
    alt(parseCost(m[2]), { impending: parseInt(m[1], 10) }, `Impending ${m[1]}—${upper(m[2])}: cast cheap, not a creature until ${m[1]} of your end steps have passed`);
  }
  if ((m = text.match(new RegExp(`^warp ${COST}$`, 'm')))) {
    alt(parseCost(m[1]), { warp: true }, `Warp ${upper(m[1])}: cast cheap from hand, exiled at end of turn, castable from exile later`);
  }
  if ((m = text.match(new RegExp(`^prowl ${COST}$`, 'm')))) {
    alt(parseCost(m[1]), { prowl: true, ...(has('prowl') ? { effects: variant(conditioned(base, 'prowl', true)).effects } : {}) }, `Prowl ${upper(m[1])}: after a Rogue of yours hits a player this turn`);
  }
  if ((m = text.match(new RegExp(`^blitz ${COST}$`, 'm')))) {
    alt(parseCost(m[1]), { blitz: true }, `Blitz ${upper(m[1])}: haste, draws a card when it dies, sacrificed at end of turn`);
  }
  if ((m = text.match(new RegExp(`^emerge (from artifact )?${COST}$`, 'm')))) {
    alt(parseCost(m[2]), { emerge: m[1] ? 'artifact' : 'creature' }, `Emerge ${upper(m[2])}: sacrifice ${m[1] ? 'an artifact' : 'a creature'} and pay less by its mana value`);
  }
  if ((m = text.match(new RegExp(`^madness ${COST}$`, 'm')))) {
    c.madness = parseCost(m[1]);
    card.notes.push(`Madness ${upper(m[1])}: cast it for that when you discard it`);
  }
  if ((m = text.match(new RegExp(`^miracle ${COST}$`, 'm')))) {
    c.miracle = parseCost(m[1]);
    card.notes.push(`Miracle ${upper(m[1])}: cast it for that when it is the first card you draw in a turn`);
  }
  if (/^cipher$/m.test(text)) {
    c.cipher = true;
    card.notes.push('Cipher: encoded on a creature, cast again each time it hits a player');
  }
  if (/^spree$|^tiered$/m.test(text)) {
    const one = /^tiered$/m.test(text);
    const modes: NonNullable<Casting['spree']>['modes'] = [];
    for (const line of text.split('\n')) {
      const s = line.trim().match(SPREE_MODE);
      const t = line.trim().match(TIER_MODE);
      if (!s && !t) continue;
      const cost = s ? s[1] : t![2];
      const body = s ? s[2] : t![3];
      const effects = resolveOf(variant(body));
      if (effects.length) modes.push({ cost: parseCost(cost), effects, label: t ? t[1] : `+${upper(cost)}` });
    }
    if (modes.length) {
      c.spree = { modes, ...(one ? { one } : {}) };
      card.effects = card.effects.filter((e) => e.when !== 'resolve');
      card.notes.push(`${one ? 'Tiered: one of' : 'Spree: any of'} ${modes.length} modes, each with its own extra cost`);
    }
  }
  if (/^if ~ is in your opening hand, you may begin the game with it on the battlefield/m.test(text)) {
    c.leyline = true;
    card.notes.push('Starts the game on the battlefield if it is in your opening hand');
  }
  if ((m = text.match(/^cast ~ only (during combat on an opponent's turn|during the declare blockers step on an opponent's turn|before combat or during combat before blockers are declared)/m))) {
    c.timing = m[1].startsWith('during combat') ? 'opponentCombat' : m[1].startsWith('during the declare') ? 'opponentBlockers' : 'beforeBlockers';
    card.notes.push(`Cast only ${m[1]}`);
  }
  if (/^you can't cast ~ during your first, second, or third turns of the game/m.test(text)) {
    c.fromTurn = 4;
    card.notes.push("Can't be cast in your first three turns");
  }
  if ((m = text.match(/^flashback—sacrifice (two|three|four|\d+) creatures/m))) {
    c.flashbackSac = count(m[1], 3);
    card.flashback = { ...ZERO, pips: [] };
    card.notes.push(`Flashback: sacrifice ${m[1]} creatures to cast it from your graveyard`);
  }
  if ((m = text.match(/^you may cast ~ as though it had flash by tapping (two|three|four) untapped creatures you control with flying/m))) {
    c.flashByTapping = count(m[1], 3);
    card.notes.push(`Flash by tapping ${m[1]} untapped flyers`);
  }
  if (/^you may cast ~ as though it had flash\. if you cast it any time a sorcery couldn't have been cast/m.test(text)) {
    card.notes.push('≈ Cast only as a sorcery (at instant speed it would be sacrificed at cleanup)');
  }
  if (/^companion — /m.test(text)) card.notes.push('Companion: no effect while it is in the deck itself');
  if (/^compleated$/m.test(text)) {
    // Phyrexian mana paid with colored mana keeps the full loyalty (rule 702.150): the bot always pays that way.
    const phyrexian = [...raw.manaCost.matchAll(/\{([WUBRG])\/P\}/gi)];
    for (const p of phyrexian) {
      card.cost.life = Math.max(0, card.cost.life - 2);
      card.cost.pips.push([p[1].toUpperCase() as 'W']);
    }
    card.notes.push('Compleated: pays its Phyrexian mana with colored mana, so it keeps its full loyalty');
  }
  // "When you cycle ~, ..." (Fractured Sanity).
  if (card.cycling && (m = text.match(/^when you cycle ~(?: or discard it)?, (.*)$/m))) {
    const effects = resolveOf(variant(m[1], true));
    if (effects.length) {
      card.cycling.effects = effects;
      card.notes.push(`When cycled: ${m[1].replace(/\.$/, '')}`);
    } else (card.unread ??= []).push(`when you cycle ~, ${m[1]}`);
  }

  // Optional costs that work like kicker.
  if (!card.kicker) {
    if ((m = text.match(new RegExp(`^entwine ${COST}$`, 'm')))) {
      // All the modes: the bullets read as plain lines.
      const all = base.split('\n').filter((l) => !/choose (one|two) —$/.test(l.trim())).map((l) => l.replace(/^\s*•\s*/, '')).join('\n');
      card.kicker = { cost: parseCost(m[1]), as: 'entwine', effects: variant(all).effects };
      card.notes.push(`Entwine ${upper(m[1])}: all the modes`);
    } else if ((m = text.match(new RegExp(`^buyback ${COST}$`, 'm')))) {
      card.kicker = { cost: parseCost(m[1]), as: 'buyback', effects: card.effects };
      card.notes.push(`Buyback ${upper(m[1])}: back to your hand as it resolves`);
    } else if (/^bargain$/m.test(text)) {
      card.kicker = { cost: { ...ZERO, pips: [] }, as: 'bargain', effects: has('bargain') ? variant(conditioned(base, 'bargain', true)).effects : card.effects };
      card.notes.push('Bargain: sacrifice an artifact, enchantment or token for the stronger version');
    } else if ((m = text.match(/^gift an? ([a-z ]+)$/m))) {
      const what = /extra turn/.test(m[1]) ? 'extraTurn' : /fish/.test(m[1]) ? 'fish' : /food/.test(m[1]) ? 'food' : /treasure/.test(m[1]) ? 'treasure' : /octopus/.test(m[1]) ? 'octopus' : 'card';
      card.kicker = { cost: { ...ZERO, pips: [] }, as: 'gift', gift: what, effects: has('gift') ? variant(conditioned(base, 'gift', true)).effects : card.effects };
      card.notes.push(`Gift ${m[1]}: an opponent gets it, and the spell gets stronger`);
    } else if ((m = text.match(new RegExp(`^cleave ${COST}$`, 'm')))) {
      card.kicker = { cost: parseCost(m[1]), as: 'cleave', effects: variant(base.replace(/ \[[^\]]*\]/g, '')).effects };
      card.notes.push(`Cleave ${upper(m[1])}: cast for that without the bracketed words`);
    } else if ((m = text.match(new RegExp(`^replicate ${COST}$`, 'm')))) {
      card.kicker = { cost: parseCost(m[1]), as: 'replicate', multi: true, effects: card.effects };
      card.notes.push(`Replicate ${upper(m[1])}: a copy for each time it is paid`);
    } else if ((m = text.match(/^casualty (\d+)$/m))) {
      card.kicker = { cost: { ...ZERO, pips: [] }, as: 'casualty', casualty: parseInt(m[1], 10), effects: card.effects };
      card.notes.push(`Casualty ${m[1]}: sacrifice a creature with power ${m[1]}+ to copy it`);
    }
  }
  if (Object.keys(c).length) card.casting = c;
}
