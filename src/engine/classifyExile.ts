// The card reader for playing cards from exile and the top of a library,
// casting spells without paying their mana costs, rearranging the top of a
// library, and searching libraries (search hate and odd tutors).
//
// classify.ts calls in here at four points:
// - exileTrigger(line) reads trigger and cost wordings classify.ts has no rule for.
// - recogniseExile(sentence, fullLine) runs on each sentence before the other
//   recognisers. Many of these abilities take several sentences ("exile the top
//   card ... you may play that card this turn"), so it reads the whole ability:
//   the sentence that starts it carries the effect and the others are taken as
//   read. It returns null for sentences it has nothing to say about.
// - exileLineHandled(line) names lines that are part of an ability read elsewhere.
// - exileValue(effect) is what these effects are worth to the bots.

import type { CastFilter, EffectBody, Trigger, TriggerScope } from './types';
import type { CardKind, PlayWindow, Who } from './typesExile';

type Found = { body: EffectBody; note: string; chance?: number };
type ExileContext = { when: Trigger; scope?: TriggerScope; castFilter?: CastFilter; body: string; chance?: number; loyalty?: number; activationCost?: never };

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w) ? parseInt(w, 10) : w === 'x' ? -1 : WORDS[w] ?? fallback);

/** Rewrites costs the activated-ability reader doesn't know into ones it does. */
export function rewriteExile(l: string): string {
  return l
    // Professional Face-Breaker: a Treasure is one mana, so sacrificing one is read as paying {1}.
    .replace(/^sacrifice a treasure: (exile the top card of your library)/, '{1}: $1')
    // Sunforger: unattaching it is part of the cost; read as just the mana.
    .replace(/^(\{[^}]+\}\{[^}]+\}), unattach ~: (search your library)/, '$1: $2');
}

/** Trigger wordings for these abilities that classify.ts doesn't know. */
export function exileTrigger(l: string): ExileContext | null {
  let m: RegExpMatchArray | null;
  // Wan Shi Tong.
  if ((m = l.match(/^whenever an opponent searches their library,\s*(.*)$/))) return { when: 'opponentSearch', body: m[1] };
  // Fireglass Mentor: the second main phase, read as once a turn (the "if an opponent lost life" part is left to the reader).
  if ((m = l.match(/^at the beginning of your second main phase,\s*(.*)$/))) return { when: 'upkeep', body: m[1] };
  // Tezzeret the Seeker: "-X: search for an artifact with mana value X or less", read as X = 3.
  if ((m = l.match(/^-x: (search your library for an artifact card with mana value x or less.*)$/))) return { when: 'loyalty', loyalty: -3, body: m[1].replace(/mana value x or less/, 'mana value 3 or less') };
  // Static abilities on permanents that classify.ts would drop as unknown triggers or read as something else.
  if (/^(?:you may (?:play lands and cast spells|play lands|cast [a-z, ]+ spells) from the top of your library|once during each of your turns, you may cast a spell from your hand or the top of your library)/.test(l)) return { when: 'static', body: l };
  if (/^(?:if an opponent would search a library|spells and abilities your opponents control can't cause their controller to search|players can't search libraries|while an opponent is searching their library, they exile each card they find)/.test(l)) return { when: 'static', body: l };
  return null;
}

/** "this turn", "until the end of your next turn", "for as long as it remains exiled". */
function windowOf(full: string): PlayWindow {
  if (/until the end of your next turn|until your next end step/.test(full)) return 'nextTurn';
  if (/for as long as (?:it|they|that card|those cards) remains? exiled|as long as you control|exiled with ~/.test(full)) return 'exiled';
  return 'turn';
}

const anyMana = (full: string) => /mana as though it were mana of any (?:color|type)|mana of any type can be spent/.test(full);

/** One ability read whole: the sentence that carries the effect, and the other sentences it takes as read. */
interface Construct {
  anchor: RegExp;
  found: Found[];
  consume?: RegExp;
}

/** A sentence that only says how or when the exiled cards may be played. */
const PERMISSION = /^(?:(?:until (?:end of turn|the end of your next turn)|for as long as [^,]+|during your turn|if you(?:'re| are) the monarch, until end of turn), )*(?:you may (?:look at|play|cast|spend)|then )|^(?:then )?choose one of them|^if you cast (?:a spell|it) this way|^(?:and )?mana of any type can be spent|^you may spend mana as though|^creature cards exiled this way gain|^(?:then )?put (?:the rest|the exiled cards|each other card)|^(?:then )?that player puts|^if you don't cast it|^then each player who owns|^if that spell would be put into a graveyard|^exile ~\.?$|^copy that card|^at the beginning of the next end step, if any of those cards remain exiled|^spells you cast from exile this turn cost/;

function constructs(full: string): Construct[] {
  const out: Construct[] = [];
  let m: RegExpMatchArray | null;
  const push = (anchor: RegExp, body: EffectBody, note: string, chance?: number) => out.push({ anchor, found: [{ body, note, ...(chance !== undefined ? { chance } : {}) }], consume: PERMISSION });

  // --- Rearranging the top of the library -------------------------------------------
  if ((m = full.match(/^look at the top (\w+) cards of your library, then put them back in any order/))) {
    const n = count(m[1], 3);
    const shuffle = /you may shuffle/.test(full);
    out.push({ anchor: /^look at the top \w+ cards of your library, then put them back in any order/, found: [{ body: { kind: 'rearrange', n, ...(shuffle ? { shuffle } : {}) }, note: `Look at the top ${n} and put them back in any order${shuffle ? ', or shuffle' : ''}` }], consume: /^you may shuffle/ });
  }

  // --- Playing off the top of the library (static) ------------------------------------
  if (/^you may play lands and cast spells from the top of your library/.test(full)) {
    const payLife = /pay life equal to its mana value rather than pay/.test(full);
    push(/^you may play lands and cast spells from the top of your library/, { kind: 'playTop', what: 'any', ...(payLife ? { payLife } : {}) }, `You may play the top card of your library${payLife ? ', paying life instead of mana for spells' : ''}`);
  } else if (/^you may play lands from the top of your library/.test(full)) {
    push(/^you may play lands from the top/, { kind: 'playTop', what: 'land' }, 'You may play lands from the top of your library');
  } else if ((m = full.match(/^(?:as long as you control three or more creatures with different powers, )?you may cast (artifact spells and colorless spells|creature spells|(\w+), (\w+), (\w+), and (\w+) spells) from the top of your library/))) {
    const coven = /^as long as you control three or more creatures with different powers/.test(full);
    const subtypes = m[2] ? [m[2], m[3], m[4], m[5]].map((s) => s[0].toUpperCase() + s.slice(1)) : undefined;
    const what: CardKind = /artifact/.test(m[1]) ? 'artifactOrColorless' : 'creature';
    push(/^(?:as long as [^,]+, )?you may cast [a-z, ]+ spells from the top of your library/, { kind: 'playTop', what, ...(subtypes ? { subtypes } : {}), ...(coven ? { coven } : {}) }, `You may cast ${subtypes ? subtypes.join(', ') : what === 'creature' ? 'creature' : 'artifact and colorless'} spells from the top of your library${coven ? ' (with three different powers)' : ''}`);
  }
  if (/^once during each of your turns, you may cast a spell from your hand or the top of your library without paying its mana cost/.test(full)) {
    push(/^once during each of your turns/, { kind: 'freeEachTurn' }, 'Once each turn, a spell from your hand or the top of your library for free');
  }

  // --- Search rules ---------------------------------------------------------------------
  if (/^if an opponent would search a library, that player searches the top four cards of that library instead/.test(full)) push(/^if an opponent would search/, { kind: 'searchRule', rule: 'top4' }, 'Opponents search only the top four cards of a library');
  if (/^spells and abilities your opponents control can't cause their controller to search their library/.test(full)) push(/^spells and abilities your opponents control/, { kind: 'searchRule', rule: 'noSearch' }, "Opponents can't search their libraries");
  if (/^players can't search libraries\. any player may pay \{2\}/.test(full)) push(/^players can't search libraries/, { kind: 'searchRule', rule: 'pay2' }, "Nobody can search a library without paying {2}");
  if (/^while an opponent is searching their library, they exile each card they find/.test(full)) push(/^while an opponent is searching their library/, { kind: 'searchRule', rule: 'agent' }, 'Cards opponents find while searching are exiled, and you may play them');

  // --- Free spells while it resolves ---------------------------------------------------
  if (/^exile the top card of each player's library, then you may cast any number of spells from among those cards without paying/.test(full)) {
    push(/^exile the top card of each player's library, then/, { kind: 'freeCast', from: 'top', n: 1, who: 'each', casts: 99, rest: 'exile' }, "Exile the top card of each library and cast any of them for free");
  } else if ((m = full.match(/(?:^|\. )(target opponent|that player|each opponent) exiles cards from the top of their library until they exile an instant or sorcery card/))) {
    const who: Who = m[1] === 'target opponent' ? 'target' : m[1] === 'that player' ? 'targetController' : 'opponents';
    const rest = /shuffles the rest into their library/.test(full) ? 'shuffle' as const : 'bottom' as const;
    push(/^(?:target opponent|that player|each opponent) exiles cards from the top of their library until/, { kind: 'freeCast', from: 'until', n: 0, who, only: 'instantSorcery', casts: 1, rest }, `${who === 'opponents' ? 'Each opponent' : who === 'target' ? 'An opponent' : 'That player'} reveals until an instant or sorcery; cast it for free${who === 'opponents' ? ' (≈ one of them)' : ''}`);
    // Wand of Wonder: the d20 sets how many may be cast; read as one.
    if (/^roll a d20\./.test(full)) out[out.length - 1].consume = new RegExp(`${PERMISSION.source}|^roll a d20`);
  }
  if ((m = full.match(/^target opponent reveals the top (\w+) cards of their library\. you may cast an instant or sorcery spell from among them without paying/))) {
    const n = count(m[1], 7);
    push(/^target opponent reveals the top/, { kind: 'freeCast', from: 'top', n, who: 'target', only: 'instantSorcery', casts: 1, rest: 'graveyard' }, `Cast an instant or sorcery from the top ${n} of an opponent's library for free; they mill the rest`);
  }
  if (/^target opponent exiles the top x cards of their library\. you may cast any number of spells with mana value x or less from among them without paying/.test(full)) {
    push(/^target opponent exiles the top x cards/, { kind: 'freeCast', from: 'top', n: -1, who: 'target', maxCmc: -1, casts: 99, rest: 'exile' }, "Exile the top X of an opponent's library and cast any of them with mana value X or less for free");
  }
  if (/^exile a card at random from each opponent's graveyard\. you may cast any number of spells from among cards exiled this way without paying/.test(full)) {
    push(/^exile a card at random from each opponent's graveyard/, { kind: 'freeCast', from: 'graveyard', random: true, n: 1, who: 'opponents', casts: 99 }, "A random card from each opponent's graveyard; cast any of them for free (their owners' life loss not counted)");
  }
  if (/^each player exiles cards from the top of their library until they exile a nonland card\. an opponent chooses a nonland card exiled this way\. you may cast up to two spells/.test(full)) {
    push(/^each player exiles cards from the top/, { kind: 'freeCast', from: 'until', n: 0, who: 'each', only: 'nonland', casts: 2, rest: 'exile' }, "Each player reveals until a nonland card; cast two of them for free (≈ the opponent's pick not counted)");
    out[out.length - 1].consume = /^an opponent chooses|^you may cast up to two/;
  }
  if (/^reveal the top card of your library\. you may cast it without paying its mana cost if it's a spell with lesser mana value/.test(full)) {
    push(/^reveal the top card of your library/, { kind: 'freeCast', from: 'top', n: 1, who: 'you', maxCmc: -2, casts: 1, rest: 'hand' }, 'Reveal the top card: cast it free if it costs less, else put it into your hand');
  }
  if (/^reveal the top x cards of your library, where x is that spell's mana value\. you may cast a spell with mana value x or less from among cards revealed this way without paying/.test(full)) {
    push(/^reveal the top x cards of your library, where x is that spell's mana value/, { kind: 'freeCast', from: 'top', n: -2, who: 'you', maxCmc: -3, casts: 1, rest: 'bottom' }, "Reveal as many cards as the spell's mana value and cast one of them for free");
  }
  if (/^look at that many cards from the top of your library\. you may exile a nonland card from among them/.test(full)) {
    push(/^look at that many cards from the top/, { kind: 'freeCast', from: 'top', n: -1, who: 'you', casts: 1, rest: 'bottom' }, 'Look at as many cards as the damage dealt and cast one for free');
    out[out.length - 1].consume = /^you may exile a nonland card|^put the rest|^you may cast the exiled card/;
  }
  if ((m = full.match(/^look at the top (x|\w+) cards of your library(?:, where x is [^.]*)?\. you may cast a spell with mana value (\d+) or less from among them without paying/))) {
    const n = m[1] === 'x' ? 2 : count(m[1], 3);
    push(/^look at the top \w+ cards of your library/, { kind: 'freeCast', from: 'top', n, who: 'you', maxCmc: parseInt(m[2], 10), casts: 1, rest: 'bottom' }, `Look at the top ${n}${m[1] === 'x' ? ' (≈ X)' : ''} and cast one with mana value ${m[2]} or less for free`);
  }
  if ((m = full.match(/^look at the top (\w+) cards of your library\. you may exile a legendary creature card from among them/))) {
    const n = count(m[1], 6);
    push(/^look at the top \w+ cards of your library/, { kind: 'freeCast', from: 'top', n, who: 'you', only: 'legendaryCreature', casts: 1, rest: 'bottom' }, `Cast a legendary creature from the top ${n} for free`);
    out[out.length - 1].consume = /^you may exile a legendary creature|^put the rest|^until end of turn, you may cast the exiled card/;
  }
  if (/^look at that player's hand\. you may cast a spell from among those cards without paying/.test(full)) {
    push(/^look at that player's hand/, { kind: 'freeCast', from: 'hand', n: 0, who: 'targetController', casts: 1 }, "Cast a spell from that player's hand for free");
  }
  if ((m = full.match(/^you may cast target (instant or sorcery|nonland permanent) card from (an opponent's|that player's) graveyard/))) {
    const pay = /mana of any type can be spent/.test(full) && !/without paying/.test(full);
    const only: CardKind = m[1] === 'instant or sorcery' ? 'instantSorcery' : 'nonlandPermanent';
    const who: Who = m[2] === "an opponent's" ? 'opponents' : 'targetController';
    const exileAfter = /if that spell would be put into a graveyard, exile it instead/.test(full);
    push(/^you may cast target [a-z ]+ card from/, { kind: 'freeCast', from: 'graveyard', n: 0, who, only, casts: 1, ...(pay ? { pay, anyMana: true } : {}), ...(exileAfter ? { exileAfter } : {}) }, `Cast ${only === 'instantSorcery' ? 'an instant or sorcery' : 'a nonland permanent'} from ${who === 'opponents' ? "an opponent's" : "that player's"} graveyard${pay ? ', paying with mana of any type' : ' for free'}`);
  }
  if ((m = full.match(/^exile (target|each) card that's an instant or sorcery from your graveyard\. for each card exiled this way, copy it, and you may cast the copy without paying/))) {
    const each = m[1] === 'each';
    push(/^exile (?:target|each) card that's an instant or sorcery from your graveyard/, { kind: 'freeCast', from: 'graveyard', n: 0, who: 'you', only: 'instantSorcery', casts: each ? 99 : 1, copy: true }, `Cast a copy of ${each ? 'each instant and sorcery' : 'an instant or sorcery'} in your graveyard for free`);
    out[out.length - 1].consume = /^for each card exiled this way|^exile ~/;
  }
  if (/^exile target instant or sorcery card from a graveyard(?: and copy it)?\./.test(full) && /you may cast the cop(?:y|ies) without paying/.test(full)) {
    const copies = /copy that card three times/.test(full) ? 3 : 1;
    push(/^exile target instant or sorcery card from a graveyard/, { kind: 'freeCast', from: 'graveyard', n: 0, who: 'each', only: 'instantSorcery', casts: 1, copy: true, ...(copies > 1 ? { copies } : {}) }, `Cast ${copies > 1 ? 'three copies' : 'a copy'} of an instant or sorcery from a graveyard for free`);
    out[out.length - 1].consume = /^copy that card|^you may cast the cop|^exile ~/;
  }
  if (/^you may cast an instant or sorcery spell from among them without paying/.test(full) || /\. you may cast an instant or sorcery spell from among them without paying/.test(full) && /mills (\w+) cards/.test(full)) {
    // Jace's Mindseeker: from among the milled cards, read as the graveyard they went to.
    push(/^you may cast an instant or sorcery spell from among them without paying/, { kind: 'freeCast', from: 'graveyard', n: 0, who: 'targetController', only: 'instantSorcery', casts: 1 }, 'Cast an instant or sorcery from among the milled cards for free (≈ from that graveyard)');
  }
  if ((m = full.match(/^you may cast a spell with mana value (\d+) or less from your hand without paying/))) {
    push(/^you may cast a spell with mana value \d+ or less from your hand/, { kind: 'freeCast', from: 'hand', n: 0, who: 'you', maxCmc: parseInt(m[1], 10), casts: 1 }, `Cast a spell with mana value ${m[1]} or less from your hand for free`);
  }
  if ((m = full.match(/^discover (\d+|x)/))) {
    const n = m[1] === 'x' ? -1 : parseInt(m[1], 10);
    out.push({ anchor: /^discover (?:\d+|x)/, found: [{ body: { kind: 'freeCast', from: 'until', n: 0, who: 'you', only: 'nonland', maxCmc: n, casts: 1, rest: 'bottom', elseHand: true, discover: true }, note: `Discover ${m[1].toUpperCase()}: a spell with mana value ${m[1].toUpperCase()} or less for free, or into your hand` }] });
  }

  // --- Searching for cards ---------------------------------------------------------------
  if ((m = full.match(/^(?:converge — )?search your library for a creature, instant, or sorcery card with mana value less than or equal to the number of colors of mana spent/))) {
    push(/^(?:converge — )?search your library for a creature, instant, or sorcery card/, { kind: 'search', what: 'creatureInstantSorcery', to: 'cast', n: 1, maxCmc: 4 }, 'Find a creature, instant or sorcery with mana value up to the colors spent (≈ 4) and cast it for free');
  }
  if ((m = full.match(/^search your library for a (red or white|[a-z]+) instant card with mana value (\d+) or less and cast that card without paying/))) {
    const colors = m[1] === 'red or white' ? ['R', 'W'] : undefined;
    push(/^search your library for a [a-z ]*instant card with mana value/, { kind: 'search', what: 'instant', to: 'cast', n: 1, maxCmc: parseInt(m[2], 10), ...(colors ? { colors } : {}) }, `Find ${m[1] === 'red or white' ? 'a red or white' : 'an'} instant with mana value ${m[2]} or less and cast it for free`);
  }
  if (/^search your library for any number of colorless nonland cards, exile them, then shuffle\. until end of turn, you may cast those cards without paying/.test(full)) {
    push(/^search your library for any number of colorless nonland cards/, { kind: 'search', what: 'colorlessNonland', to: 'exilePlay', n: 99 }, 'Find any number of colorless spells and cast them for free this turn');
  }
  if ((m = full.match(/^(?:you may )?search your library for an? (artifact|enchantment|creature) card with mana value (\d+|x) or less, put (?:it|that card) onto the battlefield/))) {
    const maxCmc = m[2] === 'x' ? -1 : parseInt(m[2], 10);
    push(/^(?:you may )?search your library for an? (?:artifact|enchantment|creature) card with mana value/, { kind: 'search', what: m[1] as CardKind, to: 'battlefield', n: 1, maxCmc }, `Find ${m[1] === 'artifact' ? 'an artifact' : m[1] === 'enchantment' ? 'an enchantment' : 'a creature'} with mana value ${m[2].toUpperCase()} or less and put it onto the battlefield`);
  }
  if ((m = full.match(/^search your library for any number of creature cards with total mana value (\d+) or less, put them onto the battlefield/))) {
    push(/^search your library for any number of creature cards with total mana value/, { kind: 'search', what: 'creature', to: 'battlefield', n: 99, totalCmc: parseInt(m[1], 10) }, `Find creatures with total mana value ${m[1]} or less and put them onto the battlefield`);
  }
  if (/^target player searches their library for a card, then shuffles and puts that card on top/.test(full)) {
    push(/^target player searches their library for a card/, { kind: 'search', what: 'any', to: 'top', n: 1 }, 'Find a card and put it on top of your library');
  }

  // --- Exiling cards to play later -----------------------------------------------------
  const impulse = (anchor: RegExp, n: number, from: Who, note: string, extra: Partial<Extract<EffectBody, { kind: 'exilePlay' }>> = {}, chance?: number) => {
    const until = extra.until ?? windowOf(full);
    const oneOf = /choose one of them|play one of those cards/.test(full);
    const free = /without paying its mana cost/.test(full) && !/if you're the monarch/.test(full);
    const payLife = /pay life equal to its mana value rather than paying/.test(full);
    const castOnly = /you may cast (?:that card|that spell|those cards|spells from among|permanent spells|the exiled card)/.test(full) && !/you may play/.test(full);
    const body: EffectBody = { kind: 'exilePlay', n, from, until, ...(oneOf ? { oneOf } : {}), ...(free ? { free } : {}), ...(payLife ? { payLife } : {}), ...(anyMana(full) ? { anyMana: true } : {}), ...(castOnly ? { castOnly } : {}), ...extra };
    const window = until === 'turn' ? 'this turn' : until === 'nextTurn' ? 'until your next turn ends' : 'while exiled';
    push(anchor, body, `${note}; play ${oneOf ? 'one of them' : n === 1 ? 'it' : 'them'} ${window}${free ? ' for free' : payLife ? ' for life' : anyMana(full) ? ' with any mana' : ''}`, chance);
  };
  if ((m = full.match(/(?:^|\. )(?:if you do, )?exile the top (card|two cards|three cards|four cards|x cards) of your library(?:\.|, then choose one of them\.)/)) && (/you may (?:play|cast)/.test(full) || /creature cards exiled this way gain/.test(full))) {
    const n = m[1] === 'card' ? 1 : m[1] === 'x cards' ? 1 : count(m[1].split(' ')[0], 1);
    const lukka = /creature cards exiled this way gain/.test(full);
    const discard = /^you may discard a card\. if you do, exile the top/.test(full);
    impulse(/^(?:if you do, )?exile the top (?:card|\w+ cards) of your library/, n, 'you', `Exile the top ${m[1] === 'x cards' ? 'X (≈ 1) cards' : m[1] === 'card' ? 'card' : `${n} cards`} of your library${discard ? ' (after discarding a card, about half the time)' : ''}`, lukka ? { only: 'creature', castOnly: true, until: 'exiled', whileSource: true } : {}, discard ? 0.5 : undefined);
    if (/^you may discard a card\. if you do, exile the top/.test(full)) out[out.length - 1].consume = new RegExp(`${PERMISSION.source}|^you may discard a card`);
  } else if (/^exile the top card of your library\.?$/.test(full)) {
    // Mystic Forge: digging past a card it can't cast.
    push(/^exile the top card of your library/, { kind: 'exilePlay', n: 1, from: 'you', until: 'turn', only: 'none' }, 'Exile the top card of your library (to dig)');
  }
  if ((m = full.match(/^exile the (top|bottom) card of each (opponent's|player's) library/))) {
    const from: Who = m[2] === "player's" ? 'each' : 'opponents';
    const permanents = /cast permanent spells from among them/.test(full);
    impulse(/^exile the (?:top|bottom) card of each (?:opponent's|player's) library/, 1, from, `Exile the ${m[1]} card of each ${from === 'each' ? 'player' : 'opponent'}'s library`, { ...(m[1] === 'bottom' ? { bottom: true } : {}), ...(permanents ? { only: 'permanent' as const, castOnly: true } : {}) });
  }
  if ((m = full.match(/^look at the top (\w+) cards of target opponent's library, exile (one|two) of them face down, then put the rest on the bottom/))) {
    impulse(/^look at the top \w+ cards of target opponent's library/, count(m[2]), 'target', `Look at the top ${count(m[1])} of an opponent's library and exile ${m[2]}`, { look: count(m[1]) });
  }
  if ((m = full.match(/^look at the top (\w+) cards of target opponent's library\. exile one of them face down and put the other on the bottom/))) {
    impulse(/^exile one of them face down and put the other on the bottom/, 1, 'target', `Look at the top ${count(m[1])} of an opponent's library and exile one`, { look: count(m[1]) });
    out[out.length - 1].consume = new RegExp(`${PERMISSION.source}|^look at the top \\w+ cards of target opponent's library`);
  }
  if ((m = full.match(/^exile the top (card|x cards) of target opponent's library/))) {
    const n = m[1] === 'card' ? 1 : 2;
    impulse(/^exile the top (?:card|x cards) of target opponent's library/, n, 'target', `Exile the top ${m[1] === 'card' ? 'card' : 'X (≈ 2) cards'} of an opponent's library`);
  }
  if (/^look at the top card of that player's library, then exile it face down/.test(full)) {
    impulse(/^look at the top card of that player's library/, 1, 'active', "Exile the top card of that player's library");
  }
  if (/^that player exiles the top card of their library\.?$/.test(full)) {
    // Nightveil Specter: played while it stays (its other line).
    push(/^that player exiles the top card of their library/, { kind: 'exilePlay', n: 1, from: 'targetController', until: 'exiled', whileSource: true }, "That player exiles their top card; you may play it while you keep this");
  }
  if (/^each opponent exiles a card from their hand until ~ leaves the battlefield/.test(full)) {
    push(/^each opponent exiles a card from their hand/, { kind: 'exilePlay', n: 1, from: 'opponents', zone: 'hand', until: 'exiled', whileSource: true, anyMana: true }, "Each opponent exiles a card from their hand; you may play them while you keep this (≈ they don't get them back)");
  }
  if (/^exile target permanent card from your graveyard\. you may play that card/.test(full)) {
    impulse(/^exile target permanent card from your graveyard/, 1, 'you', 'Exile a permanent card from your graveyard', { zone: 'graveyard', only: 'permanent' });
  }
  if (/^exile all opponents' graveyards\. you may cast spells from among those cards this turn/.test(full)) {
    impulse(/^exile all opponents' graveyards/, 99, 'opponents', "Exile opponents' graveyards", { zone: 'graveyard', castOnly: true, until: 'turn' });
    out[out.length - 1].found[0].note = "Exile opponents' graveyards; cast their spells this turn with any mana (≈ the rest stay exiled)";
  }
  return out;
}

/**
 * Reads one sentence of an ability (`full` is the whole ability). Returns the effects it starts, [] for a sentence that
 * belongs to an ability read from another sentence, or null when it isn't one of these.
 */
export function recogniseExile(line: string, full: string): Found[] | null {
  const all = constructs(full);
  if (!all.length) return null;
  for (const c of all) if (c.anchor.test(line)) return c.found;
  for (const c of all) if (c.consume?.test(line)) return [];
  return null;
}

/** Lines that are part of an ability read elsewhere, or that change nothing here. */
export function exileLineHandled(line: string): boolean {
  return /^(?:body thief — )?you may play lands and cast spells from among cards exiled with ~\.|^play with the top card of your library revealed|^you control your opponents while they're searching their libraries|^spell mastery — if there are two or more instant and\/or sorcery cards in your graveyard, you may cast up to two|^\d+—\d+ \| x is (?:one|two|three)\.?$|^20 \| x is three\.?$|^creatures you control but don't own are mercenaries/.test(line);
}

/** How much these effects are worth on a card (see cardValue in classify.ts). */
export function exileValue(e: EffectBody, mult: number): number {
  switch (e.kind) {
    case 'exilePlay': {
      if (e.only === 'none') return 0.5;
      const n = e.n >= 99 ? 3 : Math.max(e.n, 1) * (e.from === 'opponents' || e.from === 'each' ? 2.5 : 1);
      const kept = e.oneOf ? 1 : n;
      return 1.3 * kept * (e.until === 'turn' ? 0.8 : 1) * mult + (e.free ? 2 : 0);
    }
    case 'freeCast': return (e.casts >= 99 ? 4 : 2 + e.casts) * mult;
    case 'playTop': return e.what === 'any' ? 6 : e.what === 'land' ? 3 : 3.5;
    case 'freeEachTurn': return 6;
    case 'rearrange': return 0.4 * e.n * mult;
    case 'searchRule': return e.rule === 'agent' ? 3 : 1.5;
    case 'search': return (e.to === 'cast' || e.to === 'battlefield' ? 4 : 3) + (e.n >= 99 ? 2 : 0);
    default: return 0;
  }
}
