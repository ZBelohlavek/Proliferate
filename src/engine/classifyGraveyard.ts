// Graveyard wordings for the card reader: mill, reanimation and other
// recursion, graveyard hate, and the keywords that use a card from the
// graveyard (escape, retrace, unearth, embalm, persist, ...).
//
// classify.ts calls in here for each sentence (recogniseGraveyard,
// recogniseRecursion), for trigger wordings (graveyardTrigger) and once for
// the whole text (graveyardKeywords). Kept apart so the graveyard rules live
// in one place.

import type { EffectBody, GraveyardUse, ManaCost, RecursionWhat, SimCard } from './types';

type Found = { body: EffectBody; note: string };

const WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20, x: -1, 'that many': 2,
};
const N = '(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|x|\\d+|that many)';

function count(word: string | undefined, fallback = 1): number {
  if (word === undefined) return fallback;
  const w = word.trim();
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return WORDS[w] ?? fallback;
}

function parseCost(cost: string): ManaCost {
  const result: ManaCost = { generic: 0, pips: [], x: 0, life: 0 };
  for (const raw of cost.match(/\{[^}]+\}/g) ?? []) {
    const s = raw.slice(1, -1).toUpperCase();
    if (/^\d+$/.test(s)) result.generic += parseInt(s, 10);
    else if (s === 'X') result.x += 1;
    else if (s === 'C') result.pips.push(['C']);
    else if ('WUBRG'.includes(s) && s.length === 1) result.pips.push([s as 'W']);
    else if (s.includes('/P')) result.life += 2;
    else if (s.includes('/')) {
      const parts = s.split('/').filter((p) => 'WUBRG'.includes(p) && p.length === 1) as 'W'[];
      if (parts.length) result.pips.push(parts);
      else result.generic += 1;
    }
  }
  return result;
}

const millNote = (n: number, who: string, untilLands?: number) =>
  `Mill ${untilLands ? `until ${untilLands === 1 ? 'a land' : `${untilLands} lands`}` : n === -2 ? 'half a library' : n === -1 ? 'X' : n === -3 ? '2X' : n} (${who === 'you' ? 'yourself' : who === 'all' ? 'everyone' : who === 'opponents' ? 'each opponent' : 'a player'})`;

/** The card types named in "return target artifact or creature card", as a recursion filter. */
export function recursionWhat(phrase: string): RecursionWhat | undefined | null {
  const p = phrase.trim().replace(/^(another|other) /, '').replace(/\bnon-?legendary /, '').replace(/ that isn't a god$/, '');
  if (!p || p === 'card') return 'any';
  if (/creature$/.test(p) && !/artifact|enchantment|land|planeswalker/.test(p)) return undefined;
  if (/creature (and\/or|or) planeswalker/.test(p)) return 'creatureOrPlaneswalker';
  if (/artifact (and\/or|or) creature|creature (and\/or|or) artifact/.test(p)) return 'artifactOrCreature';
  if (/artifact (and\/or|or) enchantment|artifact and\/or non-aura enchantment/.test(p)) return 'artifactOrEnchantment';
  if (/^(nonland )?permanent$|^(multicolored |historic )?permanent$|^historic$/.test(p)) return 'permanent';
  if (/^legendary( permanent)?$/.test(p)) return 'legendary';
  if (/instant (and\/or|or) sorcery|^instant$|^sorcery$/.test(p)) return 'instantSorcery';
  if (/^(artifact|equipment|vehicle|[a-z]+ artifact)$/.test(p)) return 'artifact';
  if (/^(enchantment|aura|saga|curse|[a-z]+ enchantment)$/.test(p)) return 'enchantment';
  if (/^(basic )?land$/.test(p)) return 'land';
  if (/^planeswalker$/.test(p)) return 'planeswalker';
  // Creature types ("rat", "bat, lizard, rat, or squirrel") are creatures.
  if (/^[a-z]+(, [a-z]+)*,? (or|and\/or) [a-z]+$|^[a-z]+$/.test(p)) return undefined;
  return null;
}

const describeWhat = (what: RecursionWhat | undefined) => ({
  any: 'card', artifact: 'artifact', enchantment: 'enchantment', instantSorcery: 'instant or sorcery', land: 'land', planeswalker: 'planeswalker',
  creatureOrPlaneswalker: 'creature or planeswalker', artifactOrCreature: 'artifact or creature', artifactOrEnchantment: 'artifact or enchantment',
  permanent: 'permanent', legendary: 'legendary',
}[what ?? 'creature' as RecursionWhat] ?? 'creature');

/**
 * Returning cards from graveyards: "return target creature card from your graveyard to the battlefield",
 * "put target creature card from a graveyard onto the battlefield under your control", "return all artifact cards
 * from your graveyard to the battlefield", and so on.
 */
export function recogniseRecursion(line: string, fullLine: string): Found[] {
  let m: RegExpMatchArray | null;
  const out: Found[] = [];
  // Corrupted (Geth's Summons): only with three or more poison counters on an opponent, which rarely happens.
  if (/three or more poison counters/.test(fullLine)) return out;
  const push = (n: number, toBattlefield: boolean, what: RecursionWhat | undefined, extra: Partial<Extract<EffectBody, { kind: 'recursion' }>> = {}) => {
    const where = extra.toTop ? 'on top of your library' : toBattlefield ? 'to the battlefield' : 'to your hand';
    const whose = extra.from === 'any' ? (extra.all ? 'all graveyards' : 'a graveyard') : extra.from === 'opponents' ? "an opponent's graveyard" : 'your graveyard';
    const kind = what === 'any' ? '' : `${describeWhat(what)} `;
    const how = extra.all ? `all ${kind}cards` : `${n === 1 ? 'a' : n} ${kind}card${n === 1 ? '' : 's'}`;
    out.push({
      body: { kind: 'recursion', n, toBattlefield, ...(what ? { what } : {}), ...extra },
      note: `Return ${how}${extra.maxCmc !== undefined ? ` (mana value ${extra.maxCmc} or less)` : ''} from ${whose} ${where}`.replace(/^Return a a/, 'Return an a').replace(/^Return a (artifact|enchantment|instant|planeswalker|legendary)/, 'Return an $1'),
    });
  };
  const maxCmc = (s: string) => {
    const mv = s.match(/mana value (\d+|x) or less/);
    return mv ? (mv[1] === 'x' ? undefined : parseInt(mv[1], 10)) : undefined;
  };

  // Mass returns: "return all creature cards from your graveyard to the battlefield".
  if ((m = line.match(/(?:return|put) all ([a-z ,/-]*?) ?cards?( with mana value \d+ or less)? from (your graveyard|all graveyards|each player's graveyard|their graveyards?) (to|onto) (the battlefield|your hand)( tapped)?/))) {
    const what = /^(creature)?$/.test(m[1]) ? undefined : recursionWhat(m[1].replace(/ and /, ' or '));
    if (what !== null) push(3, /battlefield/.test(m[5]), what, { all: true, ...(m[3] !== 'your graveyard' ? { from: 'any' as const } : {}), ...(m[6] ? { tapped: true } : {}), ...(m[2] ? { maxCmc: maxCmc(m[2]) } : {}) });
    return out;
  }
  if (/return any number of (target )?permanent cards with different names from your graveyard to the battlefield/.test(line)) {
    push(3, true, 'permanent', { all: true });
    return out;
  }
  if (/return any number of target creature cards with total (power|mana value) \w+ or less from your graveyard to the battlefield/.test(line)) {
    push(2, true, undefined);
    return out;
  }

  // One or a few cards.
  m = line.match(/(?:return|put) (up to (one|two|three|x) |one or two |any number of )?(target |a |an |another target )?([a-z ,/-]*?) ?cards?( (?:each )?(?:with|that) [^.]*?)? from (your|a|an opponent's|target opponent's|target player's|that player's|their|any) graveyards? (to your hand|to the battlefield|onto the battlefield|on top of (?:your|its owner's) library)( tapped)?/);
  if (m && !/^(~|it|that card|those cards)$/.test(m[4])) {
    const what = recursionWhat(m[4]);
    if (what === null) return out;
    const n = m[1] === 'one or two ' ? 2 : m[1] === 'any number of ' || m[2] === 'x' ? 3 : m[2] ? Math.max(1, count(m[2], 1)) : 1;
    const from = m[6] === 'your' || m[6] === 'their' ? undefined : /opponent's|player's/.test(m[6]) ? 'opponents' as const : 'any' as const;
    const toTop = /library/.test(m[7]);
    const cap = m[5] ? maxCmc(m[5]) : undefined;
    // Two targets in one sentence: "return target creature card and up to one target ... creature card".
    const second = /card and (up to one )?target [^.]* cards? from/.test(line) ? 1 : 0;
    push(n + second, /battlefield/.test(m[7]), what, { ...(from ? { from } : {}), ...(toTop ? { toTop } : {}), ...(m[8] ? { tapped: true } : {}), ...(cap !== undefined ? { maxCmc: cap } : {}) });
    return out;
  }
  if (/return enchanted creature card to the battlefield/.test(line)) {
    push(1, true, undefined, { from: 'any' });
    return out;
  }
  if (/return the chosen cards to the battlefield/.test(line) && /in your graveyard/.test(fullLine)) {
    push(2, true, undefined);
    return out;
  }
  // "Choose target creature card in your graveyard" (and then return it, or cast it this turn: Emry).
  // Captain N'ghathrod: "choose target artifact or creature card in an opponent's graveyard ... put it onto the battlefield under your control".
  if ((m = line.match(/^choose target ([a-z ]*?) ?card in (your|an opponent's|a) graveyard/))) {
    const what = recursionWhat(m[1]);
    const from = m[2] === 'your' ? undefined : m[2] === 'a' ? 'any' as const : 'opponents' as const;
    if (what !== null) push(1, /put (it|that card) onto the battlefield/.test(fullLine), what, from ? { from } : {});
    return out;
  }
  // "Choose a card at random in your graveyard. If it's a creature card, put it onto the battlefield." (Deadbridge Chant)
  if (/^choose a card at random in your graveyard/.test(line)) {
    push(1, false, 'any');
    return out;
  }
  if (/return a card at random from your graveyard to your hand/.test(line)) push(1, false, 'any');
  return out;
}

/**
 * Mill, self-mill, entomb, graveyard hate and graveyard rules, for one sentence. Adds to `out`, what classify.ts
 * already found in the sentence. `fullLine` is the whole ability.
 */
export function recogniseGraveyard(line: string, out: Found[], fullLine = line): void {
  let m: RegExpMatchArray | null;
  const has = (kind: EffectBody['kind']) => out.some((f) => f.body.kind === kind);

  // --- Mill ---------------------------------------------------------------
  // "If you're the monarch, each of those players mills ten cards instead": the first sentence already counts.
  const instead = / instead\.?$/.test(line) && fullLine.indexOf(line) > 0 && /mills? /.test(fullLine.slice(0, fullLine.indexOf(line)));
  if (!has('mill') && !instead) {
    if ((m = line.match(new RegExp(`(defending player|enchanted player|any number of target players each|each of those players|target player|target opponent|each opponent|each player|you may|you) mills? (${N}|three times x|twice x|cards equal to)( cards?)?`)))) {
      const who = /each opponent/.test(m[1]) || /any number/.test(m[1]) ? 'opponents' : m[1] === 'each player' ? 'all' : /^you/.test(m[1]) ? 'you' : 'target';
      const n = /three times x|twice x/.test(m[2]) ? -3 : m[2] === 'cards equal to' ? 3 : count(m[3], 2);
      out.push({ body: { kind: 'mill', n, who }, note: millNote(n, who) });
    } else if ((m = line.match(/(each opponent|target opponent|target player|each player|that player) reveals cards from the top of their library until they reveal (a|x|two|three) (nonland|land) cards?/))) {
      if (m[3] === 'land') {
        const who = m[1] === 'each opponent' ? 'opponents' : m[1] === 'each player' ? 'all' : 'target';
        const lands = m[2] === 'x' ? 3 : count(m[2], 1);
        out.push({ body: { kind: 'mill', n: 0, who, untilLands: lands }, note: millNote(0, who, lands) });
      }
    } else if (/put the rest into your graveyard/.test(line) && (m = fullLine.match(new RegExp(`(?:reveal|look at) the top ${N} cards of your library`)))) {
      const n = Math.max(1, count(m[1], 3) - 1);
      out.push({ body: { kind: 'mill', n, who: 'you' }, note: millNote(n, 'you') });
    } else if ((m = line.match(new RegExp(`put the top ${N} cards? of (your|their|target player's|each player's) library into (your|their|that player's|his or her) graveyard`)))) {
      const n = count(m[1], 1);
      const who = m[2] === 'your' ? 'you' : m[2] === "each player's" ? 'all' : 'target';
      out.push({ body: { kind: 'mill', n, who }, note: millNote(n, who) });
    }
  }

  // --- Entomb: library to graveyard ------------------------------------------
  if ((m = line.match(new RegExp(`search your library for (?:up to )?${N} (creature )?cards?(?: with different names)?[^.]*?(?:,|and) put (?:them|it|that card|those cards) into your graveyard`)))) {
    const n = Math.max(1, count(m[1], 1));
    // "Search your library for a card, put it into your graveyard" isn't a tutor.
    const tutor = out.findIndex((f) => f.body.kind === 'tutor');
    if (tutor !== -1) out.splice(tutor, 1);
    out.push({ body: { kind: 'entomb', n, what: m[2] ? 'creature' : 'any' }, note: `Put ${n} ${m[2] ? 'creature ' : ''}card${n > 1 ? 's' : ''} from your library into your graveyard` });
  } else if (/put (that card|the chosen cards?) into your hand and the rest into your graveyard|put the chosen cards into your graveyard and the rest into your hand/.test(line)) {
    if (!has('tutor')) out.push({ body: { kind: 'tutor' }, note: 'Tutor' });
    out.push({ body: { kind: 'entomb', n: 2, what: 'any' }, note: 'The other cards go into your graveyard' });
  } else if (/^put the (bottom|top) card of your library into your graveyard/.test(line) && /if it's a creature card[^.]*put it onto the battlefield/.test(fullLine)) {
    out.push({ body: { kind: 'millReanimate', fromBottom: /bottom/.test(line) }, note: 'Mill a card; a small enough creature card goes onto the battlefield' });
  }

  // --- Graveyard rules ----------------------------------------------------------
  if (/^if an opponent would mill one or more cards, they mill twice that many cards instead/.test(line)) out.push({ body: { kind: 'millBoost', mult: 2, plus: 0 }, note: 'Opponents mill twice as many cards' });
  else if ((m = line.match(new RegExp(`^if an opponent would mill one or more cards, they mill that many cards plus ${N} instead`)))) {
    const plus = count(m[1], 1);
    out.push({ body: { kind: 'millBoost', mult: 1, plus }, note: `Opponents mill ${plus} more cards` });
  }
  if (/^if a source you control would deal damage to an opponent, prevent that damage and each opponent mills that many cards/.test(line)) {
    out.splice(0, out.length, { body: { kind: 'damageToMill' }, note: 'Damage your sources would deal to opponents makes them mill instead' });
  }
  if (/^you may play lands from your graveyard/.test(line)) out.push({ body: { kind: 'graveyardPlay', what: 'lands' }, note: 'Play lands from your graveyard' });
  if (/you may play a land and cast a permanent spell of each permanent type from your graveyard/.test(line)) out.push({ body: { kind: 'graveyardPlay', what: 'permanents' }, note: 'Play lands and cast permanents from your graveyard (one of each type a turn)' });
  if ((m = line.match(/^you may cast artifact spells from your graveyard(?: by paying (\d+) life)?/))) {
    const life = m[1] ? parseInt(m[1], 10) : 0;
    const finality = /finality counter/.test(fullLine);
    out.push({ body: { kind: 'graveyardPlay', what: 'artifacts', ...(life ? { lifeCost: life } : {}), ...(finality ? { finality } : {}) }, note: `Cast artifacts from your graveyard${life ? ` for ${life} more life` : ''}${finality ? ' (exiled when they leave)' : ''}` });
  }
  if (/^(creature|nonland permanent) cards in graveyards and libraries can't enter the battlefield/.test(line)) {
    out.push({ body: { kind: 'graveyardLock' }, note: "Cards can't come back from graveyards" });
  }
  if (/^if a card would be put into an opponent's graveyard from anywhere, instead exile it/.test(line)) {
    out.push({ body: { kind: 'graveyardHate', opponents: true }, note: "Opponents' cards are exiled instead of going to their graveyards" });
  }

  // --- Graveyard hate: one card at a time -------------------------------------------
  // Psionic Ritual, Mnemonic Deluge: exiling the card is how you copy and cast it, not graveyard hate.
  if (!has('exileGraveyards') && !has('removal') && !/\bcopy\b|you may cast/.test(fullLine)) {
    if ((m = line.match(/exile all ([a-z ]*?)cards from target (player|opponent)'s graveyard/))) {
      out.push({ body: { kind: 'exileGraveyards', all: false, cards: 15 }, note: "Exile an opponent's graveyard" });
    } else if ((m = line.match(/exile (up to (one|two|three|twice x|x) )?(target |a )?([a-z ]*?) ?cards? from (a|an opponent's|target player's|target opponent's|any) graveyards?|exile (up to (?:twice )?x) target cards from graveyards/))) {
      const n = m[6] ? 3 : m[2] ? (/x/.test(m[2]) ? 3 : count(m[2], 1)) : 1;
      out.push({ body: { kind: 'exileGraveyards', all: false, cards: n }, note: `Exile ${n === 1 ? 'a card' : `${n} cards`} from opponents' graveyards` });
    } else if (/put target card from a graveyard on the bottom of its owner's library/.test(line)) {
      out.push({ body: { kind: 'exileGraveyards', all: false, cards: 1 }, note: "Put a card from an opponent's graveyard on the bottom of their library" });
    }
  }

  // "Put a +1/+1 counter on each Advisor you control" (Lo and Li): tribal wording, read as your creatures.
  if (!has('counters') && (m = line.match(/put (a|two) \+1\/\+1 counters? on each (?!creature|other)[a-z]+ you control/))) {
    out.push({ body: { kind: 'counters', n: count(m[1], 1), all: true }, note: `+1/+1 counter${m[1] === 'a' ? '' : 's'} on team` });
  }
}

/** Trigger wordings about milling. Returns null when the line isn't one. */
export function graveyardTrigger(l: string): { when: 'milled'; scope: 'self' | 'any' | 'all'; creature: boolean; body: string } | null {
  let m: RegExpMatchArray | null;
  if ((m = l.match(/^whenever (an opponent|a player|one or more opponents|you)(?: discards a card or)? mills? one or more (creature )?cards[^,]*,\s*(.*)$/))) {
    return { when: 'milled', scope: m[1] === 'you' ? 'self' : m[1] === 'a player' ? 'all' : 'any', creature: !!m[2], body: m[3] };
  }
  if ((m = l.match(/^whenever one or more (creature )?cards are put into (your|an opponent's) graveyard from (your|their) library[^,]*,\s*(.*)$/))) {
    return { when: 'milled', scope: m[2] === 'your' ? 'self' : 'any', creature: !!m[1], body: m[4] };
  }
  return null;
}

/** Lines graveyardKeywords reads, which need no effect of their own. */
export function graveyardLineHandled(line: string): boolean {
  if (/^(persist|undying|retrace|unearth|embalm|eternalize|disturb)\b|^escape—|^~ escapes with/.test(line)) return true;
  // Grafdigger's Cage's second line: the first one already reads as the whole lock.
  if (/^players can't cast spells from graveyards or libraries/.test(line)) return true;
  return RETURN_SELF.test(line.replace(ABILITY_WORD, ''));
}

const ABILITY_WORD = /^[a-z' ]+ — (?=\{)/;
const RETURN_SELF = /^((?:\{[^}]+\})+)(, sacrifice (?:a|an|another) (creature|artifact or creature))?: return ~ from your graveyard to (the battlefield|your hand)( tapped)?\.?( activate only (?:as a sorcery|if [^.]*)\.?)?$/;

/** Keywords and abilities that use the card from its owner's graveyard. Sets card.graveyard / card.persist. */
export function graveyardKeywords(text: string, card: SimCard): void {
  const isPermanent = !card.isInstant && !card.isSorcery;
  let m: RegExpMatchArray | null;
  if (card.isCreature && (m = text.match(/^(persist|undying)\s*$/m))) {
    card.persist = m[1] as 'persist' | 'undying';
    card.notes.push(m[1] === 'persist' ? 'Persist: comes back with a -1/-1 counter the first time it dies' : 'Undying: comes back with a +1/+1 counter the first time it dies');
  }
  let use: GraveyardUse | null = null;
  if ((m = text.match(/^escape—((?:\{[^}]+\})+), exile (\w+) other cards? from your graveyard/m))) {
    use = { how: 'cast', cost: parseCost(m[1]), label: 'escape', exileOthers: count(m[2], 3), ...(isPermanent ? {} : { exiled: true }) };
  } else if (/^retrace\s*$/m.test(text)) {
    use = { how: 'cast', cost: card.cost, label: 'retrace', discardLand: true };
  } else if ((m = text.match(/^disturb ((?:\{[^}]+\})+)/m))) {
    use = { how: 'cast', cost: parseCost(m[1]), label: 'disturb', exiled: true };
  } else if (card.isCreature && (m = text.match(/^unearth ((?:\{[^}]+\})+)/m))) {
    use = { how: 'return', cost: parseCost(m[1]), label: 'unearth', to: 'battlefield', haste: true, exileAtEnd: true, sorcery: true };
  } else if (card.isCreature && (m = text.match(/^(embalm|eternalize) ((?:\{[^}]+\})+)/m))) {
    use = { how: 'return', cost: parseCost(m[2]), label: m[1], to: 'battlefield', token: true, sorcery: true, ...(m[1] === 'eternalize' ? { size: 4 } : {}) };
  } else {
    for (const line of text.split('\n')) {
      const r = line.trim().replace(ABILITY_WORD, '').match(RETURN_SELF);
      if (!r) continue;
      use = {
        how: 'return', cost: parseCost(r[1]), label: 'return', to: r[4] === 'your hand' ? 'hand' : 'battlefield',
        ...(r[5] ? { tapped: true } : {}), ...(r[2] ? { sacCreature: true } : {}), ...(/sorcery/.test(r[6] ?? '') ? { sorcery: true } : {}),
      };
      break;
    }
  }
  if (!use) return;
  card.graveyard = use;
  const cost = (use.cost.x ? '{X}' : '') + (use.cost.generic ? `{${use.cost.generic}}` : '') + use.cost.pips.map((p) => `{${p.join('/')}}`).join('');
  card.notes.push({
    escape: `Escape ${cost}: cast from your graveyard, exiling ${use.exileOthers} other cards`,
    retrace: 'Retrace: cast from your graveyard by also discarding a land',
    disturb: `Disturb ${cost}: cast from your graveyard`,
    unearth: `Unearth ${cost}: returns with haste for a turn`,
    embalm: `Embalm ${cost}: a token copy from your graveyard`,
    eternalize: `Eternalize ${cost}: a 4/4 token copy from your graveyard`,
  }[use.label] ?? `${cost}${use.sacCreature ? ', sacrifice a creature' : ''}: return it from your graveyard to ${use.to === 'hand' ? 'your hand' : 'the battlefield'}`);
}

/** How much the graveyard effects add to a card's value (see cardValue). */
export function graveyardValue(e: EffectBody, mult: number): number {
  switch (e.kind) {
    case 'entomb': return 1 + 0.5 * e.n;
    case 'millBoost': return 3;
    case 'damageToMill': return 4;
    case 'graveyardPlay': return e.what === 'lands' ? 2.5 : 4;
    case 'graveyardLock': return 2;
    case 'millReanimate': return 1.5 * mult;
    default: return 0;
  }
}
