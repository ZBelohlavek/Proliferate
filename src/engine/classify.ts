// Turns a card's oracle text into a SimCard the engine can play.
//
// This is pattern matching, not a rules engine: each line of oracle text is
// checked against regular expressions for common EDH effects (ramp, draw,
// removal, wipes, tokens, ...). Lines we don't recognise are ignored. The
// `notes` list records what we understood so users can audit their decks.

import { applyCardRule, CARD_RULES } from './cardRules';
import type {
  CastFilter,
  CurseAbility,
  CurseAct,
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
import { chargeMana, energyGateOf, MECHANIC_COST, mechanicCost, mechanicKeywords, mechanicLineHandled, mechanicTrigger, recogniseMechanics } from './classifyMechanics';
import { recogniseBoard } from './classifyBoard';
import { recogniseRare, rareTrigger, rewriteRare } from './classifyRare';
import { LOCK_STATIC_KINDS, lockLineHandled, lockTrigger, lockValue, recogniseLocks } from './classifyLocks';
import { EMBLEM_COST, EMBLEM_STATIC_KINDS, emblemCost, emblemTrigger, recogniseEmblems, rewriteEmblems } from './classifyEmblems';
import { recogniseReplace, replaceTrigger, rewriteReplace } from './classifyReplace';
import { castingBase, castingKeywords, castingLineHandled, recogniseCasting } from './classifyCasting';
import { combatLineHandled, combatTrigger, describeProtection, protectionKeywords, recogniseCombat, tribeOf } from './classifyCombat';
import { countingKeywords, countingLineHandled, countingMana, manaNote, countingTrigger, recogniseCounting, rewriteCounting } from './classifyCounting';
import { chargeCondition, chargeThenCondition, counterLineHandled, counterTrigger, recogniseCounters, rewriteCounters, stationTier, tierKeywords } from './classifyCounters';
import { controlLineHandled, controlTrigger, controlValue, recogniseControl } from './classifyControl';
import { exileLineHandled, exileTrigger, exileValue, recogniseExile, rewriteExile } from './classifyExile';
import { graveyardKeywords, graveyardLineHandled, graveyardTrigger, graveyardValue, recogniseGraveyard, recogniseRecursion } from './classifyGraveyard';

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
  back?: { name: string; types: string[]; subTypes: string[]; text: string; superTypes?: string[]; power?: string | null; toughness?: string | null; loyalty?: string | number | null; /** Rooms: the other door's mana cost. */ manaCost?: string } | null;
  imageUrl?: string;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
  x: -1, 'that many': 2, 'a number of': 2,
};

function num(word: string | undefined, fallback = 1): number {
  if (word === undefined) return fallback;
  const w = word.trim().toLowerCase();
  if (/^\d+$/.test(w)) return parseInt(w, 10);
  return NUMBER_WORDS[w] ?? fallback;
}

const NUM = '(eleven|twelve|thirteen|fourteen|fifteen|twenty|a|an|one|two|three|four|five|six|seven|eight|nine|ten|x|\\d+|that many|a number of)';

const BASIC_LAND_TYPES: Record<string, Mana> = {
  plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G', wastes: 'C',
};

const KNOWN_KEYWORDS = [
  'flying', 'trample', 'haste', 'vigilance', 'deathtouch', 'lifelink', 'menace', 'first strike',
  'double strike', 'indestructible', 'hexproof', 'shroud', 'reach', 'defender', 'flash', 'ward', 'infect', 'wither',
  'shadow', 'fear',
  // Evasion and attack keywords handled in the rules engine's canBlock and combat (rules 702.14, 702.118, 702.116).
  'skulk', 'islandwalk', 'swampwalk', 'forestwalk', 'mountainwalk', 'plainswalk', 'myriad',
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
    // "Medomai the Ageless", "Oketra the True": the text calls it by its first name.
    const first = full.match(/^([a-z]{4,}) the [a-z]/)?.[1];
    if (first) t = t.replace(new RegExp(`\\b${first}\\b(?!')`, 'g'), '~');
  }
  t = t.replace(
    /\bthis (creature|artifact|enchantment|land|permanent|planeswalker|spell|card|vehicle|equipment|aura|token|saga|class)\b/g,
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
    // Protection and "hexproof from" (rule 702.16, 702.11d) can sit in a keyword line: see classifyCombat.ts.
    if (parts.every((p) => KNOWN_KEYWORDS.includes(p) || p.startsWith('ward') || protectionKeywords(p))) {
      for (const p of parts) {
        const pro = protectionKeywords(p);
        if (pro) for (const k of pro) kws.add(k);
        else kws.add(p.startsWith('ward') ? 'ward' : p);
      }
    }
  }
  // "Hexproof from each color" isn't hexproof (rule 702.11d), though card data lists the keyword.
  if (kws.has('hexproof') && /hexproof from/.test(text) && !/(^|, )hexproof(,|$)/m.test(text)) kws.delete('hexproof');
  if (/~ can't be blocked(\.|$)/m.test(text)) kws.add('unblockable');
  // Stormkeld Vanguard, Azure Beastbinder: evasion against small or big blockers (checked in the rules engine's canBlock).
  const evade = text.match(/^~ can't be blocked by creatures with power (\d+) or (less|greater)\.?$/m);
  if (evade) kws.add(`can't be blocked by power ${evade[1]} or ${evade[2]}`);
  if (/^~ can't block\.?$/m.test(text)) kws.add("can't block");
  if (/^~ can't be countered/m.test(text)) kws.add('uncounterable');
  return [...kws];
}

// ---------------------------------------------------------------------------
// Effect recognisers. Each takes one sentence/line and returns effects found.
// ---------------------------------------------------------------------------

/** chance: this part of the ability only happens some of the time (a condition in the same sentence). */
type Found = { body: EffectBody; note: string; chance?: number; minRoll?: number; /** "That player" (see Effect.thatPlayer). */ thatPlayer?: boolean; /** "If it had no counters on it". */ noCounters?: boolean; /** Paid in energy when it happens, or skipped ("you may pay {E}{E}. When you do"). */ energyCost?: number; chargeAtResolve?: { n: number; reset: boolean } };

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
  // Gaining control, copies, token replacement, changing targets (classifyControl.ts): read whole there.
  const control = recogniseControl(line, fullLine, card);
  if (control) return control;
  const out: Found[] = [];
  let m: RegExpMatchArray | null;
  // Playing cards from exile or the top of a library, free spells, searching (classifyExile.ts): whole abilities, read first.
  const exiled = recogniseExile(line, fullLine);
  if (exiled) return exiled;

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

  // Mister Negative: "exchange life totals with target opponent. If you lost life this way, draw that many cards."
  if (/exchange life totals with target opponent/.test(line)) {
    out.push({ body: { kind: 'exchangeLife' }, note: 'Swap life totals with the opponent highest on life' });
  }

  // --- Card draw -----------------------------------------------------------
  m = line.match(new RegExp(`(?:you |target player |each player )?draws? ${NUM} (additional )?cards?`));
  if (m && !/opponent draws|that player draws|each opponent draws/.test(line) && !/exchange life totals/.test(fullLine)) {
    const n = num(m[1], 1);
    out.push({ body: { kind: 'draw', n }, note: `Draw ${n === -1 ? 'X' : n}` });
  } else if (/draw cards equal to|draws cards equal to/.test(line)) {
    out.push({ body: { kind: 'draw', n: 3 }, note: 'Draw (≈3)' });
  } else if ((m = line.match(/put (one|two|three|four|\d) of (them|those cards) into your hand/))) {
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
  if (/^(you have|players have) no maximum hand size/.test(line)) out.push({ body: { kind: 'noMaxHand' }, note: 'No maximum hand size' });

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
  } else if (/^creatures your opponents control get -\d+\/-\d+\.?$/.test(line)) {
    // Elesh Norn: a lasting -2/-2, not a one-time sweeper (classifyBoard.ts).
    recogniseBoard(line, out);
  } else if ((m = line.match(/(all creatures|each other creature|each creature|creatures your opponents control|creatures you don't control) gets? -(\d+|x)\/-(\d+|x)/))) {
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount: num(m[3], 2), oneSided: /opponents|don't/.test(m[1]), shrink: 'temp' }, note: 'Shrink sweeper' });
  } else if ((m = line.match(new RegExp(`put ${NUM} -1\\/-1 counters? on each creature( target player controls| your opponents control| you don't control)?`)))) {
    out.push({ body: { kind: 'wipe', target: 'creatures', mode: 'damage', amount: num(m[1], 1), oneSided: !!m[2], shrink: 'counters' }, note: 'Shrink sweeper (-1/-1 counters)' });
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
      } else if ((m = line.match(/(target player|target opponent|each opponent|each player|each other player) sacrifices (a|an|two|three) (?:nontoken )?(creatures?|attacking creature|nonland permanent|permanent)/))) {
        const each = /each (opponent|other)/.test(m[1]) ? 'opponents' as const : m[1] === 'each player' ? 'all' as const : undefined;
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'edict', amount: 0, ...(each ? { each } : {}) }, note: `${each === 'all' ? 'Each player sacrifices' : each ? 'Each opponent sacrifices' : 'Edict:'} a ${m[3] === 'permanent' ? 'permanent (≈ a creature)' : 'creature'}` });
      } else if ((m = line.match(/target creature( an opponent controls| you don't control)? gets -(\d+|x)\/-(\d+|x)/))) {
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount: num(m[3], 3), shrink: 'temp' }, note: 'Shrink removal' });
      } else if ((m = line.match(new RegExp(`put ${NUM} -1\\/-1 counters? on (up to one )?target creature`)))) {
        const amount = num(m[1], 1);
        out.push({ body: { kind: 'removal', target: 'creature', mode: 'damage', amount, shrink: 'counters' }, note: `Shrink removal (${amount === -1 ? 'X' : amount} -1/-1 counters)` });
      }
    }
  }

  // --- Counterspells -------------------------------------------------------
  m = line.match(/counter target ([^.]*?)spell/) ?? line.match(/^exile (any number of )?target (spell)s?\.?$/);
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
    // "1/1 white Soldier", "2/2 black Zombie Knight": the creature types, for tribal anthems and triggers.
    const subtypes = m[5].trim().split(/\s+/).filter((w) => w && !/^(white|blue|black|red|green|colorless|and|artifact|enchantment|legendary|snow|tapped|attacking|\w+-colored)$/.test(w));
    // Jace's Illusions: "when this token becomes the target of a spell, sacrifice it".
    const fragile = /~ becomes the target of a spell( or ability)?, sacrifice it/.test(fullLine) ? (/target of a spell or ability/.test(fullLine) ? 'any' as const : 'spell' as const) : undefined;
    out.push({ body: { kind: 'tokens', n, power: p === -1 ? 3 : p, toughness: t === -1 ? 3 : t, keywords: kws, ...(fragile ? { fragile } : {}), ...(subtypes.length ? { subtypes } : {}) }, note: `Make ${n === -1 ? 'X' : n}× ${p === -1 ? 'X' : p}/${t === -1 ? 'X' : t} token${n === 1 ? '' : 's'}${fragile ? ' (sacrificed when targeted)' : ''}` });
  } else if ((m = line.match(new RegExp(`create ${NUM} (tapped )?tokens? (?:that'?s a copy|that are copies) of ~`)))) {
    // Skyclave Relic, Jace, Mirror Mage, Jace, Cunning Castaway: token copies of the permanent itself.
    const n = num(m[1], 1);
    const loyalty = line.match(/starting loyalty is (\d+)/);
    const nonlegendary = /(not|isn't|aren't) legendary/.test(line);
    out.push({
      body: { kind: 'copySelf', n, ...(m[2] ? { tapped: true } : {}), ...(nonlegendary ? { nonlegendary } : {}), ...(loyalty ? { loyalty: parseInt(loyalty[1], 10) } : {}) },
      note: `${n === 1 ? 'A token copy' : `${n} token copies`} of itself${m[2] ? ', tapped' : ''}`,
    });
  } else if (/^choose up to one other target enchantment or artifact\. if you're the monarch, you may create a token that's a copy of it/.test(fullLine)) {
    // Court of Vantress: copies only while you're the monarch; the "become a copy" half is left out.
    if (/^choose up to one/.test(line)) out.push({ body: { kind: 'copyPermanent', monarch: true }, note: "Token copy of another artifact or enchantment while you're the monarch" });
  } else if ((m = line.match(new RegExp(`create ${NUM} tokens? that'?s? a copy of`)))) {
    out.push({ body: { kind: 'tokens', n: num(m[1], 1), power: 3, toughness: 3, keywords: [] }, note: 'Token copy (≈3/3)' });
  }

  m = line.match(new RegExp(`create ${NUM} (tapped )?(?:treasure|gold) tokens?`));
  if (m) {
    const raw = num(m[1], 1);
    const n = raw === -1 || /for each|equal to/.test(line) ? 3 : raw;
    out.push({ body: { kind: 'treasure', n }, note: `Treasure ×${n} (one-shot mana)` });
  }

  // --- Ultimates, emblems, Food/Blood/Incubator, extra turns, Rooms (see classifyEmblems.ts) ---
  recogniseEmblems(line, out, fullLine, readEmblem);
  if ((m = line.match(/\bamass (?:\w+ )?(\d+)/))) {
    const n = parseInt(m[1], 10);
    out.push({ body: { kind: 'tokens', n: 1, power: n, toughness: n, keywords: [], army: true }, note: `Amass ${n} (+${n}/+${n} counters on your Army)` });
  }

  // --- Anthems / overruns / pumps -------------------------------------------
  m = /^if x is/.test(line) ? null : line.match(/(other )?(creatures|creature tokens|\w+ creatures|\w+s) you control (of the chosen type )?(?:gain [a-z, ]+ and )?get \+(\d+|x)\/\+(\d+|x)/);
  if (m) {
    const p = num(m[4], 1);
    const t = num(m[5], 1);
    // "Other Elves you control", "creatures you control of the chosen type": one creature type only (see classifyCombat.ts).
    const plural = m[2].replace(/^other /, '');
    // "Other Goblin creatures you control": a creature type before "creatures" (not a color or card type).
    const typed = plural.match(/^(\w+) creatures$/);
    const subtype = m[3] ? 'chosen' : /^\w+s$/.test(plural) && plural !== 'creatures' ? tribeOf(plural) ?? undefined
      : typed && !/^(artifact|enchantment|legendary|nontoken|token|attacking|blocking|tapped|untapped|white|blue|black|red|green|colorless|multicolored|monocolored|nonland|snow|other|commander|nonlegendary|modified|outlaw|nonhuman)$/.test(typed[1]) ? typed[1] : undefined;
    if (/until end of turn/.test(line)) {
      const scale = p !== -1 ? undefined : /x is the number of creatures/.test(line) ? 'creatures' as const : /greatest power/.test(line) ? 'power' as const : undefined;
      const size = scale === 'creatures' ? 'your creature count' : scale === 'power' ? 'your greatest power' : p === -1 ? 'X' : String(p);
      out.push({ body: { kind: 'overrun', p, t, trample: /trample/.test(line), ...(scale ? { scale } : {}) }, note: scale || p === -1 ? `Team pump +X/+X this turn (X = ${size})` : `Team pump +${p}/+${t} this turn` });
    } else if (card.isPermanent) {
      const other = !!m[1] || /^other /.test(m[2]);
      out.push({ body: { kind: 'anthem', p, t, ...(other ? { other } : {}), ...(subtype ? { subtype } : {}) }, note: `Anthem +${p}/+${t}${other ? ' (other creatures)' : ''}${subtype ? ` (${subtype === 'chosen' ? 'the chosen creature type' : `${subtype}s`} only)` : ''}` });
    }
  } else if (card.isPermanent && (m = line.match(/^(other )?(?:(enchantment|artifact) creatures|(artifact|enchantment)s|creatures|(?!spells|lands|permanents|planeswalkers|tokens|nontoken)[a-z]+s) you control have ([a-z, ]+)\.?$/)) && KNOWN_KEYWORDS.some((k) => m![4].includes(k))) {
    // Tribal wording ("Horrors you control have menace") is treated as all your creatures, as elsewhere.
    // "Artifacts you control have indestructible" only matters to artifact creatures here.
    const kws = KNOWN_KEYWORDS.filter((k) => m![4].includes(k));
    const only = (m[2] ?? m[3]) as 'enchantment' | 'artifact' | undefined;
    const other = !!m[1];
    const word = line.match(/^(?:other )?([a-z]+) you control have/)?.[1];
    const subtype = !only && word && word !== 'creatures' ? tribeOf(word) ?? undefined : undefined;
    out.push({ body: { kind: 'anthem', p: 0, t: 0, keywords: kws, ...(only ? { only } : {}), ...(other ? { other } : {}), ...(subtype ? { subtype } : {}) }, note: `Your ${other ? 'other ' : ''}${only ? `${only} ` : ''}${subtype ? `${subtype}s` : 'creatures'} have ${kws.join(', ')}` });
  } else if (card.isPermanent && (m = line.match(/^creatures you control but don't own get \+(\d+)\/\+(\d+)/))) {
    out.push({ body: { kind: 'anthem', p: num(m[1], 1), t: num(m[2], 1), only: 'stolen' }, note: `Creatures you took get +${m[1]}/+${m[2]}` });
  } else if ((m = line.match(/^(?:creatures you control|all creatures) gain ([a-z, ]+) until end of turn/)) && KNOWN_KEYWORDS.some((k) => m![1].includes(k)) && !/hexproof|indestructible/.test(m[1])) {
    const kws = KNOWN_KEYWORDS.filter((k) => m![1].includes(k));
    out.push({ body: { kind: 'overrun', p: 0, t: 0, trample: kws.includes('trample'), grant: kws }, note: `Your creatures gain ${kws.join(', ')} this turn` });
  } else if (card.isPermanent && /each creature gets \+1\/\+1 for each other creature/.test(line)) {
    out.push({ body: { kind: 'anthem', p: 2, t: 2 }, note: 'Tribal anthem (≈ +2/+2)' });
  } else if ((m = line.match(/(equipped|enchanted) creature gets \+(\d+)\/([+-]\d+)/))) {
    const kws = KNOWN_KEYWORDS.filter((k) => line.includes(k));
    out.push({ body: { kind: 'equip', p: num(m[2], 1), t: parseInt(m[3], 10), keywords: kws, aura: m[1] === 'enchanted' }, note: `${m[1] === 'equipped' ? 'Equipment' : 'Aura'} +${m[2]}/${m[3]}` });
  } else if ((m = line.match(/^enchanted creature (?:loses all abilities and )?is an? [a-z ]+ creature with base power and toughness (\d+)\/(\d+)/)) && /loses all (other )?abilities/.test(line)) {
    // Frogify-style Auras: the creature stays, as a vanilla body (Amphibian Downpour, Darksteel Mutation).
    const size = { p: parseInt(m[1], 10), t: parseInt(m[2], 10) };
    out.push({ body: { kind: 'equip', p: 0, t: 0, keywords: [], aura: true, lock: 'blank', lockSize: size }, note: `Aura: the enchanted creature loses all abilities and is a ${size.p}/${size.t}` });
  } else if (/^enchanted permanent is a colorless land[^.]*loses all other card types and abilities/.test(line)) {
    out.push({ body: { kind: 'equip', p: 0, t: 0, keywords: [], aura: true, lock: 'land' }, note: 'Aura: the enchanted permanent becomes a land that taps for {C}' });
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
  } else if (card.isPermanent && !(/^it /.test(line) && /target/.test(fullLine)) && (m = line.match(/^(?:~|it) (?:gets \+(\d+)\/\+(\d+) and )?(gains ([a-z, ]+) until end of turn|can't be blocked this turn)/)) && (m[3].startsWith("can't") || KNOWN_KEYWORDS.some((k) => m![4].includes(k)))) {
    const grant = m[3].startsWith("can't") ? ['unblockable'] : KNOWN_KEYWORDS.filter((k) => m![4].includes(k));
    const protect = grant.includes('indestructible') || grant.includes('hexproof');
    out.push({ body: { kind: 'pump', p: m[1] ? num(m[1], 1) : 0, t: m[2] ? num(m[2], 1) : 0, protect, grant, self: true }, note: `It gains ${grant.join(', ').replace('unblockable', "can't be blocked")} this turn` });
  } else if (card.isPermanent && (m = line.match(/^~ gets \+(\d+)\/\+(\d+) until end of turn\.?$/))) {
    out.push({ body: { kind: 'pump', p: num(m[1], 1), t: num(m[2], 1), protect: false, grant: [], self: true }, note: `It gets +${m[1]}/+${m[2]} this turn` });
  } else if (/^regenerate ~\.?$/.test(line)) {
    out.push({ body: { kind: 'pump', p: 0, t: 0, protect: false, grant: ['regenerate'], self: true }, note: 'Regenerate (the next time it would be destroyed this turn, it is tapped and removed from combat instead)' });
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
  m = line.match(new RegExp(`put ${NUM} \\+1\\/\\+1 counters? on (~|each creature you control|(?:up to one )?(?:other )?target creature(?: you control)?|each other creature you control|each (?:other )?[a-z]+ you control|a creature (?:you|they) control|(?:it|that creature)(?=\.|,? and |$))`));
  if (m) {
    const n = num(m[1], 1);
    const all = /each/.test(m[2]);
    const byExperience = /equal to the number of experience counters/.test(line);
    const other = !all && /other target creature/.test(m[2]);
    out.push({ body: { kind: 'counters', n: n === -1 ? 2 : n, all, ...(byExperience ? { byExperience } : {}), ...(other ? { other } : {}) }, note: byExperience ? '+1/+1 counters equal to your experience counters' : `+1/+1 counter${n > 1 ? 's' : ''}${all ? ' on team' : ''}` });
  }

  if (/\bproliferate\b/.test(line)) {
    out.push({ body: { kind: 'counters', n: 1, all: true, proliferate: true }, note: 'Proliferate (+1 counter on creatures that have one)' });
  }

  // --- Life drain / burn ---------------------------------------------------
  m = line.match(new RegExp(`each opponent (?:with no cards in hand )?loses ${NUM} life`)) ?? line.match(new RegExp(`deals? ${NUM} damage to each opponent`)) ?? line.match(/each opponent loses life (equal) to/) ?? line.match(/deals damage (equal) to [^.]* to each opponent/);
  if (m) {
    const n = m[1] === 'equal' ? 2 : num(m[1], 1);
    if (/each opponent with no cards in hand/.test(line)) {
      out.push({ body: { kind: 'drain', n, gain: 0, emptyHand: true }, note: `Each opponent with no cards in hand loses ${n} life` });
    } else {
      const fixedGain = fullLine.match(new RegExp(`you gain ${NUM} life`));
      const gain = /you gain life equal/.test(fullLine) ? -1 : fixedGain ? num(fixedGain[1], 1) : 0;
      // Gray Merchant: "where X is your devotion to black".
      const devotion = n === -1 ? fullLine.match(/where x is your devotion to (white|blue|black|red|green)/) : null;
      const color = devotion ? ({ white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' } as const)[devotion[1] as 'white'] : undefined;
      const damage = /deals? (?:\w+ )?damage[^.]*to each opponent/.test(line);
      out.push({ body: { kind: 'drain', n, gain, ...(color ? { devotion: color } : {}), ...(damage ? { damage } : {}) }, note: `Drain each opponent ${color ? `your devotion to ${devotion![1]}` : n === -1 ? 'X' : n}` });
    }
  } else if ((m = line.match(new RegExp(`(target (player|opponent) loses|deals? ${NUM} damage to (target (player|opponent)|any target))`)))) {
    const amt = line.match(new RegExp(`(loses|deals?) ${NUM}`));
    const n = num(amt?.[2], 2);
    if (!out.some((f) => f.body.kind === 'removal')) out.push({ body: { kind: 'damagePlayer', n }, note: `Burn a player for ${n === -1 ? 'X' : n}` });
  }
  m = line.match(new RegExp(`(?:you|target player) gains? ${NUM} life`));
  if (m && !out.some((f) => f.body.kind === 'drain')) {
    const n = num(m[1], 1);
    out.push({ body: { kind: 'gainLife', n }, note: `Gain ${n === -1 ? 'X' : n} life` });
  }
  m = line.match(/(?:\byou|\band) lose (\d+) life/);
  if (m && !/unless|rather than|if you do|you may/.test(line)) out.push({ body: { kind: 'loseLife', n: parseInt(m[1], 10) }, note: `You lose ${m[1]} life` });

  // --- Recursion (see classifyGraveyard.ts) ------------------------------------
  out.push(...recogniseRecursion(line, fullLine));

  // --- Cost reduction ------------------------------------------------------
  if ((m = line.match(/^each creature spell you cast costs \{(\d)\} less to cast if it has mutate/))) {
    out.push({ body: { kind: 'costReduction', amount: parseInt(m[1], 10), filter: 'mutate' }, note: `Cost reduction {${m[1]}} (spells with mutate)` });
  }
  m = line.match(/(\w+ )?(\w+ )?spells (?:you cast )?(?:of the chosen type )?cost \{(\d)\} less/);
  if (m) {
    const phrase = (m[1] ?? '') + (m[2] ?? '');
    const filter: CastFilter = /noncreature/.test(phrase) ? 'noncreature' : /creature/.test(phrase) ? 'creature' : /instant|sorcery/.test(phrase) ? 'instantSorcery' : /artifact/.test(phrase) ? 'artifact' : /enchantment/.test(phrase) ? 'enchantment' : 'any';
    out.push({ body: { kind: 'costReduction', amount: parseInt(m[3], 10), filter }, note: `Cost reduction {${m[3]}} (${filter})` });
  }

  // --- Rule-changing permanents ----------------------------------------------
  if (/it creates twice that many|^if one or more tokens would be created under your control, twice that many of those tokens are created instead/.test(line)) out.push({ body: { kind: 'doubler', tokens: true, counters: false }, note: 'Doubles the tokens you make' });
  if (/it puts twice that many of those counters/.test(line)) out.push({ body: { kind: 'doubler', tokens: false, counters: true }, note: 'Doubles the +1/+1 counters you place' });
  if ((m = line.match(/^if (an artifact or creature entering|a permanent entering|a creature entering|a creature attacking|a creature dying|you casting or copying an instant or sorcery spell)(?: the battlefield)? causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time/))) {
    const event = /attacking/.test(m[1]) ? 'attack' as const : /dying/.test(m[1]) ? 'dies' as const : /casting/.test(m[1]) ? 'magecraft' as const : /permanent/.test(m[1]) ? 'permanentEnters' as const : 'enters' as const;
    const what = { enters: 'an artifact or creature entering', permanentEnters: 'a permanent entering', attack: 'a creature attacking', dies: 'a creature dying', magecraft: 'casting an instant or sorcery' }[event];
    out.push({ body: { kind: 'etbDoubler', ...(event === 'enters' ? {} : { event }) }, note: `Abilities set off by ${what} trigger twice` });
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
    out.push({ body: { kind: 'toughnessMatters', defenders: !!m[2], ...(m[1] ? { yours: true } : {}) }, note: m[2] ? 'Your defenders attack and deal damage with their toughness' : 'Creatures deal combat damage with their toughness' });
  }
  if (/^creatures you control with power or toughness 1 or less can't be blocked/.test(line)) {
    out.push({ body: { kind: 'anthem', p: 0, t: 0, keywords: ['unblockable'], small: true }, note: "Your creatures with power or toughness 1 or less can't be blocked" });
  }
  if (/exile cards from the top of your library until you exile (a|x) (nonland )?permanent cards?[^.]*\. put (that card|those permanent cards|those cards) onto the battlefield/.test(fullLine) && /^exile cards from the top/.test(line)) {
    out.push({ body: { kind: 'digPermanent' }, note: 'Put the first permanent from the top of your library onto the battlefield' });
  }
  if (/each player can't cast more than one spell each turn/.test(line)) out.push({ body: { kind: 'spellLimit' }, note: 'Each player may cast only one spell a turn' });
  if (/your opponents can't cast spells from anywhere other than their hands/.test(line)) out.push({ body: { kind: 'commandLock' }, note: "Opponents can't cast their commanders" });
  if (/would be put into a graveyard from anywhere, exile it instead/.test(line)) out.push({ body: { kind: 'graveyardHate' }, note: 'Cards are exiled instead of going to graveyards' });
  if (/exile all graveyards/.test(line)) out.push({ body: { kind: 'exileGraveyards', all: true }, note: 'Exile all graveyards' });
  else if (/exile (target player's|target opponent's|each opponent's) graveyard/.test(line)) out.push({ body: { kind: 'exileGraveyards', all: false }, note: "Exile opponents' graveyards" });

  // --- Copying, stealing, cheating into play, extra turns ----------------------
  if ((m = line.match(/you may have ~ enter as a copy of (any |a |another |target )?(nonland permanent|creature|artifact or creature)( or planeswalker)?( you control| an opponent controls)?/))) {
    const from = m[4] === ' you control' ? 'yours' as const : m[4] ? 'opponents' as const : undefined;
    const nonlegendary = /(it isn't|it's not|isn't) legendary/.test(line);
    const extraCounter = /enters with an additional \+1\/\+1 counter/.test(line);
    out.push({
      body: { kind: 'clone', ...(from ? { from } : {}), ...(nonlegendary ? { nonlegendary } : {}), ...(extraCounter ? { extraCounter } : {}), ...(/becomes the target of a spell or ability, sacrifice it/.test(fullLine) ? { fragile: true } : {}) },
      note: `Enters as a copy of the best creature ${from === 'yours' ? 'you control' : from ? 'an opponent controls' : 'on the battlefield'}${nonlegendary ? " (it isn't legendary)" : ''}${/becomes the target of a spell or ability, sacrifice it/.test(fullLine) ? ' (sacrificed when targeted)' : ''}`,
    });
  }
  if ((m = line.match(/gain control of target artifact( with mana value (x|\d+) or less)?/)) && !/until end of turn/.test(fullLine)) {
    // Thieving Skydiver: an Equipment it takes is attached to it.
    const maxCmc = m[2] === 'x' ? -1 : m[2] ? parseInt(m[2], 10) : undefined;
    out.push({ body: { kind: 'steal', from: 'battlefield', what: 'artifact', ...(maxCmc !== undefined ? { maxCmc } : {}) }, note: `Take control of an artifact${maxCmc === -1 ? ' with mana value X or less' : maxCmc !== undefined ? ` with mana value ${maxCmc} or less` : ''}` });
  } else if (/gain control of target (\w+ )?(creature|permanent|nonland permanent)/.test(line) && !/until end of turn/.test(fullLine)) {
    const whileSource = /for as long as (you control ~|~ remains on the battlefield)/.test(line);
    out.push({ body: { kind: 'steal', from: 'battlefield', ...(whileSource ? { whileSource } : {}) }, note: whileSource ? 'Take control of a creature while you keep this' : 'Take control of a creature' });
  }
  if (/put (a|an|up to one) ([^.]*?)(creature|permanent) card[^.]*? from your hand onto the battlefield/.test(line)) {
    out.push({ body: { kind: 'cheat' }, note: 'Put a creature from your hand onto the battlefield' });
  }
  if (/takes? an extra turn after this one/.test(line)) out.push({ body: { kind: 'extraTurn' }, note: 'Extra turn' });

  // --- Transforming double-faced cards ---------------------------------------------
  // "Activate only if ..." conditions aren't checked, so those transforms stay unread (Matzalantli, the Temples).
  const transform = /activate only if/.test(fullLine) ? null : recogniseTransform(line);
  if (transform) out.push(transform);

  // --- Face-down creatures (manifest, manifest dread) ------------------------------
  if ((m = line.match(/^(its controller|you|that player) manifests? (the top card of (?:your|their|that player's) library|dread)/))) {
    const dread = m[2] === 'dread';
    const who = m[1] === 'you' ? (/that player's library/.test(m[2]) ? 'opponents' as const : 'you' as const) : 'targetController' as const;
    out.push({ body: { kind: 'manifest', who, ...(dread ? { dread } : {}) }, note: who === 'targetController' ? `Its controller gets a face-down 2/2 (manifest${dread ? ' dread' : ''})` : who === 'opponents' ? "Manifest the top card of each opponent's library (a face-down 2/2 for you)" : `Manifest${dread ? ' dread' : ' the top card of your library'} (a face-down 2/2)` });
  } else if ((m = line.match(/^manifest (the top card of your library|dread)/))) {
    const dread = m[1] === 'dread';
    out.push({ body: { kind: 'manifest', who: 'you', ...(dread ? { dread } : {}) }, note: `Manifest${dread ? ' dread' : ' the top card of your library'} (a face-down 2/2)` });
  }
  // Mindleecher: the top card of each opponent's library, to play while it stays exiled. About a card each.
  if (/^exile the top card of each opponent's library face down\. you may look at and play those cards/.test(fullLine) && /^exile the top card/.test(line)) {
    out.push({ body: { kind: 'draw', n: 2 }, note: "Play the top card of each opponent's library (≈ draw 2)" });
  }
  if (/you've cast another spell named ~ this game, you win the game/.test(line)) {
    out.push({ body: { kind: 'approach' }, note: 'Gain 7 life the first time, win the game the second' });
  }

  // --- Mill, entomb, graveyard rules (see classifyGraveyard.ts) -----------------
  recogniseGraveyard(line, out, fullLine);
  // --- Odds and ends from the real decks -----------------------------------------
  // Mana Crypt: lose the flip half the time.
  if ((m = line.match(/^if you lose the flip, ~ deals (\d+) damage to you/))) out.push({ body: { kind: 'loseLife', n: parseInt(m[1], 10) }, note: `Coin flip: ${m[1]} damage to you half the time`, chance: 0.5 });
  // High Tide: about three Islands' worth of extra mana for the caster this turn.
  if (/^until end of turn, whenever a player taps an island for mana, that player adds an additional \{u\}/.test(line)) out.push({ body: { kind: 'treasure', n: 3, ritual: true }, note: 'Ritual: ≈3 extra blue mana from Islands this turn' });
  // Eerie Interlude: the creatures come back at end of turn, so it dodges a wipe and replays enters abilities.
  if (/^exile any number of target creatures you control\.?$/.test(line) && /return those cards to the battlefield/.test(fullLine)) out.push({ body: { kind: 'blink', n: 5, what: 'creature' }, note: 'Blink any number of creatures you control (back at end of turn)' });
  // Dispatch: only with three artifacts out.
  if (/^(?:metalcraft — )?if you control three or more artifacts, exile that creature/.test(line)) out.push({ body: { kind: 'removal', target: 'creature', mode: 'exile', amount: 0 }, note: 'Exile a creature (with metalcraft)', chance: 0.5 });
  // Herald's Horn: a creature of the chosen type on top goes to hand.
  if (/^if it's a creature card of the chosen type, you may reveal it and put it into your hand/.test(line)) out.push({ body: { kind: 'draw', n: 1 }, note: 'Draw 1 (if the top card is the chosen type)', chance: 0.35 });
  if ((m = line.match(/^annihilator (\d+)$/))) {
    const n = parseInt(m[1], 10);
    for (let i = 0; i < n; i++) out.push({ body: { kind: 'removal', target: 'permanent', mode: 'edict', amount: 0, each: 'opponents' }, note: i ? '' : `Annihilator ${n}: opponents sacrifice ${n} permanent${n > 1 ? 's' : ''}` });
  }
  if ((m = line.match(/^firebending (\d+|x)$/))) {
    const n = m[1] === 'x' ? 3 : parseInt(m[1], 10);
    out.push({ body: { kind: 'treasure', n, ritual: true }, note: `Firebending: ${m[1] === 'x' ? 'X' : n} red mana when it attacks` });
  }
  // Draw replacement and limits.
  if (/^if you would draw a card except the first one you draw in each of your draw steps, draw two cards instead/.test(line)) out.push({ body: { kind: 'drawRule', rule: 'double' }, note: 'Your extra draws are doubled' });
  if (/^if an opponent would draw a card except the first one they draw in each of their draw steps, instead that player skips that draw and you draw a card/.test(line)) out.push({ body: { kind: 'drawRule', rule: 'steal' }, note: "Opponents' extra draws come to you" });
  if (/^each opponent can't draw more than one card each turn/.test(line)) out.push({ body: { kind: 'drawRule', rule: 'limit' }, note: 'Opponents draw at most one card a turn' });
  if (/^whenever an opponent loses life, that player mills that many cards/.test(line)) out.push({ body: { kind: 'lifeLossMill' }, note: 'Opponents mill a card for each life they lose' });
  // Commander abilities read one by one (Sigurd, Fblthp, Ultima, Zur, Lord of the Nazgûl, Orvar, Ygra, Lynde).
  if (/^put a lore counter on target saga you control/.test(line)) out.push({ body: { kind: 'lore' }, note: 'Put a lore counter on a Saga you control' });
  if (/^when ~ becomes the target of a spell, shuffle ~ into its owner's library/.test(line)) out.push({ body: { kind: 'shuffleWhenTargeted' }, note: 'Shuffled into its library when a spell targets it' });
  if (/^put a blight counter on target land/.test(line)) out.push({ body: { kind: 'blight' }, note: 'Blight a land: it loses its abilities and taps for {C}' });
  if (/^whenever you tap a land for \{c\}, add an additional \{c\}/.test(line)) out.push({ body: { kind: 'colorlessBoost' }, note: 'Lands that tap for {C} make {C}{C}' });
  if (/^target non-aura enchantment you control becomes a creature in addition to its other types and has base power and base toughness each equal to its mana value/.test(line)) out.push({ body: { kind: 'animate' }, note: 'Animate an enchantment (P/T equal to its mana value)' });
  if ((m = line.match(/^(\w+?)s you control have protection from ring-bearers/))) out.push({ body: { kind: 'ringProtection', subtype: m[1][0].toUpperCase() + m[1].slice(1) }, note: `Your ${m[1]}s have protection from ring-bearers` });
  if (/^when a spell or ability an opponent controls causes you to discard ~, create a token that's a copy of target permanent/.test(line)) out.push({ body: { kind: 'copyOnDiscard' }, note: 'Discarded by an opponent: copy a permanent' });
  if (/^other creatures are food artifacts in addition to their other types/.test(line)) out.push({ body: { kind: 'foodCreatures' }, note: 'Other creatures are Food ({2}, {T}, sacrifice: gain 3 life)' });
  if (/^whenever a curse is put into your graveyard from the battlefield, return it to the battlefield attached to you/.test(line)) out.push({ body: { kind: 'returnCurses' }, note: 'Curses that leave come back on you at the next end step' });
  if ((m = line.match(/^pass a curse for (\d+)$/))) out.push({ body: { kind: 'passCurse', n: parseInt(m[1], 10) }, note: `Move a Curse from you to an opponent and draw ${m[1]}` });
  // The Ring tempts you (rule 701.54): a ring-bearer that grows stronger each time.
  if (/\bthe ring tempts you\b/.test(line) && !/^whenever the ring tempts you|^when the ring tempts you/.test(line)) out.push({ body: { kind: 'ringTempts' }, note: 'The Ring tempts you' });

  // --- Goad, blink, untap, copying spells ---------------------------------------
  if ((m = line.match(/\bgoad (all|each) creatures? (you don't control|your opponents control|target (?:player|opponent) controls|that player controls)/))) {
    out.push({ body: { kind: 'goad', all: !/target|that player/.test(m[2]) }, note: /target|that player/.test(m[2]) ? "Goad a player's creatures" : "Goad every creature your opponents control" });
  } else if (/\bgoad (target|up to (?:one|two|three|x) target) creatures?/.test(line)) {
    out.push({ body: { kind: 'goad', all: false }, note: 'Goad a creature (it must attack someone else)' });
  } else if (/^creatures your opponents control with power less than ~'s power are goaded/.test(line)) {
    out.push({ body: { kind: 'goad', all: true, weaker: true }, note: "Opponents' creatures with less power than it are goaded" });
  }
  if ((m = line.match(/exile (up to (?:one|two) |two |any number of )?(?:other )?(?:target )?([a-z, /-]+?) you control, then return (?:it|that card|them|those cards) to the battlefield/))) {
    const n = !m[1] ? 1 : /two/.test(m[1]) ? 2 : /any number/.test(m[1]) ? 5 : 1;
    const what = /creature/.test(m[2]) && !/permanent|artifact|land/.test(m[2]) ? 'creature' as const : 'permanent' as const;
    out.push({ body: { kind: 'blink', n, what }, note: `Blink ${n === 5 ? 'any number of' : n === 2 ? 'two' : 'a'} ${what === 'creature' ? 'creature' : 'permanent'}${n > 1 ? 's' : ''} you control (enters again)` });
  }
  if (/^untap/.test(line) && !/you may pay \{/.test(fullLine)) {
    if ((m = line.match(/^untap (?:all|each) (permanents|artifacts|creatures)? ?you control during each other player's untap step/))) {
      out.push({ body: { kind: 'untapAlways', what: m[1] === 'artifacts' ? 'artifacts' : 'all' }, note: `Your ${m[1] ?? 'permanents'} untap during each other player's untap step too` });
    } else if (/^untap ~ during each other player's untap step/.test(line)) {
      out.push({ body: { kind: 'untapAlways', what: 'self' }, note: "Untaps during each other player's untap step too" });
    } else if ((m = line.match(/^untap (all|up to (\w+)|target|two target) lands?( you control)?/))) {
      const n = m[1] === 'all' ? 99 : m[2] ? Math.max(1, num(m[2], 1)) : m[1] === 'two target' ? 2 : 1;
      out.push({ body: { kind: 'untap', what: 'lands', n }, note: n === 99 ? 'Untap all your lands' : `Untap ${n} land${n > 1 ? 's' : ''}` });
    } else if (/^untap all nonland permanents you control/.test(line)) {
      out.push({ body: { kind: 'untap', what: 'nonland', n: 99 }, note: 'Untap all your nonland permanents' });
    } else if (/^untap all artifacts you control/.test(line)) {
      out.push({ body: { kind: 'untap', what: 'artifacts', n: 99 }, note: 'Untap all your artifacts' });
    } else if (/^untap (all|each) (?:other )?(creatures you control|creatures that attacked this turn|attacking creatures|[a-z]+ you control)/.test(line)) {
      out.push({ body: { kind: 'untap', what: 'creatures', n: 99 }, note: 'Untap your creatures' });
    } else if ((m = line.match(/^untap (up to (one|two|three) )?(another )?target (artifact|creature|permanent|legendary permanent|nonland permanent|artifact, creature, or land|artifact or creature)s?(?! an opponent)/)) && !/attacking/.test(line)) {
      const n = m[2] ? num(m[2], 1) : 1;
      out.push({ body: { kind: 'untap', what: 'permanent', n }, note: `Untap ${n > 1 ? `${n} permanents` : 'a permanent'}` });
    } else if (/^untap ~\.?$/.test(line)) {
      out.push({ body: { kind: 'untap', what: 'self', n: 1 }, note: 'Untaps itself' });
    }
  } else if (/^you may tap or untap target (artifact, creature, or land|permanent)/.test(line)) {
    out.push({ body: { kind: 'untap', what: 'permanent', n: 1 }, note: 'Untap a permanent' });
  }
  if ((m = line.match(/^copy target (instant or sorcery|instant|sorcery|instant, sorcery, or \w+|instant and\/or sorcery) spell( you control)?/))) {
    out.push({ body: { kind: 'copySpell', what: 'spell', ...(m[2] ? { yours: true } : {}) }, note: `Copy an instant or sorcery spell${m[2] ? ' you control' : ''}` });
  } else if (/^copy target (activated or triggered|triggered) ability you control/.test(line)) {
    out.push({ body: { kind: 'copySpell', what: 'ability', yours: true }, note: 'Copy a triggered ability you control' });
  } else if (/^copy (that spell|it)( twice)?\.?($| you may choose new targets)/.test(line)) {
    out.push({ body: { kind: 'copySpell', what: 'trigger' }, note: 'Copy that spell' });
  }
  // --- Commander abilities -------------------------------------------------------
  if ((m = line.match(/^other creatures you control enter with an additional (?:(\w+) )?\+1\/\+1 counters? on them for each opponent who lost life this turn/))) {
    out.push({ body: { kind: 'enterCounters', n: num(m[1], 1) }, note: 'Your other creatures enter with an extra +1/+1 counter per opponent who lost life this turn' });
  }
  if ((m = line.match(/^other creatures have base power and toughness (\d+)\/(\d+)/))) {
    out.push({ body: { kind: 'baseSize', p: num(m[1], 2), t: num(m[2], 2) }, note: `Other creatures are ${m[1]}/${m[2]} before bonuses` });
  }
  // Creature types (rule 205.3): Metallic Mimic, Maskwood Nexus, Leyline of Transformation.
  if (/^each other creature you control of the chosen type enters with an additional \+1\/\+1 counter on it/.test(line)) out.push({ body: { kind: 'enterCounters', n: 1, chosen: true }, note: 'Your other creatures of the chosen type enter with an extra +1/+1 counter' });
  if (/^creatures you control are every creature type/.test(line)) out.push({ body: { kind: 'creatureTypes', every: true }, note: 'Your creatures are every creature type' });
  if (/^creatures you control are the chosen type in addition to their other types/.test(line)) out.push({ body: { kind: 'creatureTypes', every: false }, note: 'Your creatures are also the chosen type' });
  if (/you get an experience counter/.test(line)) out.push({ body: { kind: 'experience' }, note: 'You get an experience counter' });
  // --- Land hate, Fogs, energy, charge counters (see classifyMechanics.ts) ------------
  recogniseMechanics(line, out, fullLine);
  // --- Counters, station and additional combats (see classifyCounters.ts) ---------
  recogniseCounters(line, out, fullLine);
  // --- Lockouts, animation, winning and losing (see classifyLocks.ts) -------------
  recogniseLocks(line, out, fullLine);
  // --- Attack and block rules, goad, suspect, protection (see classifyCombat.ts) ---
  recogniseCombat(line, out, fullLine);
  // --- Counting effects, variable mana, tap and untap (see classifyCounting.ts) ------
  recogniseCounting(line, out, fullLine);
  if ((m = line.match(/(tap up to one target creature and )?put a stun counter on (?:up to one )?(?:target (nonland permanent|creature|permanent|tapped creature)|it\b)/)) && (m[2] || m[1])) {
    const tap = !!m[1];
    const tapped = m[2] === 'tapped creature';
    out.push({ body: { kind: 'stun', ...(tap ? { tap } : {}), ...(tapped ? { tapped } : {}) }, note: `${tap ? 'Tap a creature and put' : 'Put'} a stun counter on ${tapped ? 'a tapped creature' : "an opponent's permanent"}` });
  }
  if ((m = line.match(/put a bounty counter on target (nonblack )?creature(?! an opponent controls)/))) {
    out.push({ body: { kind: 'bounty', plain: true, any: true }, note: `Bounty counter on a ${m[1] ? 'nonblack ' : ''}creature` });
  } else if (/put a bounty counter on target creature an opponent controls/.test(line)) {
    out.push({ body: { kind: 'bounty' }, note: "Bounty on an opponent's creature (when it dies, its controller's opponents draw 1 and gain 2)" });
  }
  if (/^sacrifice another permanent\.?$/.test(line)) out.push({ body: { kind: 'sacrificeOther' }, note: 'Sacrifice another permanent' });
  if (/^target opponent becomes the monarch/.test(line)) out.push({ body: { kind: 'monarch', opponent: true }, note: 'An opponent becomes the monarch' });
  if ((m = line.match(/roll (a|two|three) six-sided (?:die|dice)/))) {
    const n = num(m[1], 1);
    out.push({ body: { kind: 'rollDice', n }, note: `Roll ${n === 1 ? 'a die' : `${n} dice`}` });
  }
  if (/^if you rolled 6 or higher, instead create that token and a treasure token/.test(line)) {
    out.push({ body: { kind: 'treasure', n: 1 }, note: 'Treasure ×1', minRoll: 6 });
  }
  if ((m = line.match(/^(as long as your life total is less than or equal to half your starting life total|during your turn), ~ has (indestructible|hexproof|lifelink|flying|trample|deathtouch)/))) {
    const cond = m[1].startsWith('during') ? 'yourTurn' as const : 'halfLife' as const;
    out.push({ body: { kind: 'selfKeyword', keyword: m[2], cond }, note: `Has ${m[2]} ${cond === 'yourTurn' ? 'during your turn' : 'at half life or less'}` });
  }
  if (/create a tapped and attacking token that's a copy of (up to one )?(other )?target (nontoken )?creature you control/.test(line)) {
    out.push({ body: { kind: 'copyCreature', temporary: /sacrifice that token/.test(fullLine) }, note: 'Attacking token copy of another creature you control' });
  }
  // Omnath, Locus of All: the top card goes to your hand either way, sometimes with three mana.
  if (/^if you don't reveal it, put it into your hand/.test(line)) out.push({ body: { kind: 'draw', n: 1 }, note: 'Draw 1' });
  if (/^if you do, add three mana in any combination of its colors/.test(line)) out.push({ body: { kind: 'treasure', n: 3 }, note: '3 one-shot mana', chance: 0.35 });
  // Meren: onto the battlefield when the experience count is high enough, else to hand.
  if (/^choose target creature card in your graveyard/.test(line) && /experience counters/.test(fullLine)) {
    const old = out.findIndex((f) => f.body.kind === 'recursion');
    if (old !== -1) out.splice(old, 1);
    out.push({ body: { kind: 'recursion', n: 1, toBattlefield: false, byExperience: true }, note: 'Return a creature: to the battlefield if its mana value ≤ your experience, else to hand' });
  }
  // Noble Heritage: opponents who take the counters can't touch you.
  if (/^for each opponent who does, you gain protection from that player/.test(line)) out.push({ body: { kind: 'protect', player: true }, note: 'Protection from opponents who took counters', chance: 0.5 });

  // --- "Becomes the target" bodies and Midnight Clock ------------------------
  if (/^shuffle ~ into its owner's library/.test(line)) out.push({ body: { kind: 'shuffleSelf' }, note: 'Shuffles itself into the library' });
  if (/^sacrifice (it|~)\.?$/.test(line)) out.push({ body: { kind: 'sacrificeSelf' }, note: 'Sacrifices itself' });
  if (/^reveal the top card of your library and put it into your hand, or onto the battlefield if it is a land/.test(line)) out.splice(0, out.length, { body: { kind: 'revealTop' }, note: 'Reveal the top card: a land onto the battlefield, else into your hand (twice a turn for each creature)' });
  if ((m = line.match(new RegExp(`^put ${NUM} hour counters? on ~`)))) out.push({ body: { kind: 'hours', n: num(m[1], 1) }, note: 'An hour counter' });
  if (/^shuffle your hand( and graveyard)? into your library, then draw seven cards/.test(line)) {
    const graveyard = /hand and graveyard/.test(line);
    const exileSelf = /exile ~/.test(fullLine);
    // The wheel is the whole sentence: not a separate "draw seven".
    out.splice(0, out.length, { body: { kind: 'wheel', n: 7, graveyard, ...(exileSelf ? { exileSelf } : {}) }, note: `Shuffle your hand${graveyard ? ' and graveyard' : ''} into your library and draw seven${exileSelf ? ', then exile it' : ''}` });
  }
  // --- Replacement effects, prevention, trigger doublers, "that player" (classifyReplace.ts) ---
  recogniseReplace(line, out, fullLine);
  // --- Flash grants, hideaway, plotting (classifyCasting.ts) ------------------------
  recogniseCasting(line, out, fullLine);
  // --- Rarer wordings nothing above read (classifyRare.ts) -----------------------
  if (!out.length) recogniseRare(line, out, card, fullLine);

  return out;
}

const BIG_NUMBERS: Record<string, number> = { eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20 };

/** "Transform ~", "exile ~, then return it to the battlefield transformed", "when ~ dies, return it ... transformed". */
function recogniseTransform(line: string): Found | null {
  let cond: { count: 'creatures' | 'graveyard'; n: number; subtype?: string } | undefined;
  const ifClause = line.match(/\bif (?:you control (\w+) or more (\w+)|there are (\w+) or more cards in your graveyard|you have (\w+) or more cards in your graveyard), /);
  if (ifClause) {
    const word = ifClause[1] ?? ifClause[3] ?? ifClause[4];
    const n = BIG_NUMBERS[word] ?? num(word, 0);
    if (n > 0) cond = ifClause[1] ? { count: 'creatures', n, ...(ifClause[2] !== 'creatures' ? { subtype: ifClause[2].replace(/s$/, '') } : {}) } : { count: 'graveyard', n };
  }
  const when = cond ? ` once you have ${cond.n} ${cond.count === 'graveyard' ? 'cards in your graveyard' : cond.subtype ? `${cond.subtype}s` : 'creatures'}` : '';
  if (/(?:^|\bthen )(?:if [^,]+, )?(?:you may )?transform ~(?:, then untap it)?\.?$/.test(line)) {
    return { body: { kind: 'transform', ...(cond ? { cond } : {}) }, note: `Transform${when}` };
  }
  if (/(?:^|, )exile ~, then return (?:it|him|her|~) to the battlefield transformed under (?:its owner's|his owner's|her owner's|your) control\.?$/.test(line) || /^exile this saga, then return it to the battlefield transformed under your control/.test(line)) {
    return { body: { kind: 'transform', reenter: true, ...(cond ? { cond } : {}) }, note: `Exile it and return it transformed${when}` };
  }
  const back = line.match(/^return (?:it|~) to the battlefield (tapped and )?transformed under (?:its owner's|your) control\.?$/);
  if (back) return { body: { kind: 'transform', fromGraveyard: true, ...(back[1] ? { tapped: true } : {}) }, note: `Returns to the battlefield transformed${back[1] ? ' and tapped' : ''}` };
  return null;
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
  /** "Tap four untapped Advisors you control" as part of the cost. */
  tapCreatures?: number;
  minCmc?: number;
  chance?: number;
  oncePerTurn?: boolean;
  nontoken?: boolean;
  loyalty?: number;
  chapters?: number[];
  minRoll?: number;
  selfToo?: boolean;
  nth?: number;
  turn?: 'own' | 'others';
  /** "-X:" loyalty abilities and "three times X" (see classifyEmblems.ts). */
  loyaltyX?: boolean;
  xTimes?: number;
  /** "Sacrifice a Food", "sacrifice five artifacts" as an activation cost. */
  sacOther?: { what: 'food' | 'artifact'; n: number };
  /** Activation costs paid in energy or charge counters (see classifyMechanics.ts). */
  energy?: number;
  charge?: number;
  sorcery?: boolean;
  boast?: boolean;
  /** "If ~ has N or more charge counters on it". */
  minCharge?: number;
  /** Activation costs: discard cards, put -1/-1 counters on itself, remove counters (see classifyCounters.ts). */
  discard?: number;
  shrinkSelf?: number;
  removeCounters?: { n: number; from: 'self' | 'any' };
  targetedBy?: 'you' | 'opponents';
  spellOnly?: boolean;
  perTurn?: number;
  /** 'leaves' triggers: the zones it counts (see Effect.zones). */
  zones?: ('graveyard' | 'exile' | 'hand' | 'library')[];
  /** 'playerAttacks': "with three or more creatures". */
  minAttackers?: number;
  /** Tribal triggers: only this creature type ('chosen': the type chosen as it entered). */
  ofType?: string;
}

const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7 };

function detectTrigger(line: string, isPermanent: boolean): LineContext {
  // Saga chapters: "I, II — Draw a card." Chapter abilities can carry a name ("Aerial Blast — ...").
  const chapter = line.match(/^((?:i|ii|iii|iv|v|vi|vii)(?:, (?:i|ii|iii|iv|v|vi|vii))*) — (.*)$/);
  if (chapter) {
    return { when: 'chapter', chapters: chapter[1].split(', ').map((r) => ROMAN[r]), body: chapter[2].replace(/^[a-z' !.,-]{3,30} — /, '') };
  }
  // Strip ability words like "Landfall — " / "Constellation — ".
  let l = line.replace(/^[a-z' ]+ — (?=(when|whenever|at|if|as|~|you|creatures|target|each|draw|create))/, '');
  let m: RegExpMatchArray | null;
  // Rarer wordings (classifyRare.ts).
  l = rewriteExile(rewriteRare(l));
  // Lockouts, animation, winning and losing (classifyLocks.ts).
  const locked = lockTrigger(l);
  if (locked) return locked;
  l = rewriteReplace(l);
  // Rooms, Food, extra phases and "-X" loyalty abilities (classifyEmblems.ts).
  const emblem = emblemTrigger(l);
  if (emblem) return emblem;
  const exiled = exileTrigger(l);
  if (exiled) return exiled;
  const rare = rareTrigger(l);
  if (rare) return rare;
  const replaced = replaceTrigger(l);
  if (replaced) return replaced;
  const control = controlTrigger(l);
  if (control) return control;
  // Counting effects, variable mana, tap and untap (classifyCounting.ts).
  l = rewriteCounting(l);
  const counting = countingTrigger(l);
  if (counting) return counting;

  const mech = mechanicTrigger(l);
  if (mech) return mech;
  const counted = counterTrigger(l);
  if (counted) return counted;
  const fought = combatTrigger(l);
  if (fought) return fought;
  const milled = graveyardTrigger(l);
  if (milled) return { when: milled.when, scope: milled.scope, body: milled.body, ...(milled.creature ? { castFilter: 'creature' as const } : {}) };
  if (/^whenever a land enters[^,]*, [^.]* damage to that land's controller/.test(l)) return { when: 'static', body: l };
  if (/^whenever an opponent loses life, that player mills that many cards/.test(l)) return { when: 'static', body: l };
  // Prowess (rule 702.108): +1/+1 whenever you cast a noncreature spell.
  if (/^prowess$/.test(l)) return { when: 'cast', castFilter: 'noncreature', body: '~ gets +1/+1 until end of turn' };
  // Annihilator N (rule 702.86): the defending player sacrifices N permanents.
  if ((m = l.match(/^annihilator (\d+)$/))) return { when: 'attack', scope: 'self', body: `annihilator ${m[1]}` };
  // Constellation and the like: "whenever ~ or another enchantment you control enters".
  if ((m = l.match(/^whenever ~ or another (artifact|enchantment) you control enters,\s*(.*)$/))) return { when: 'permEnters', castFilter: m[1] as 'artifact' | 'enchantment', body: m[2] };
  // Firebending N (Avatar): whenever this creature attacks, add N {R} for the rest of combat. Kept as one-shot mana.
  if ((m = l.match(/^firebending (\d+|x)/))) return { when: 'attack', scope: 'self', body: `firebending ${m[1]}` };
  // Baeloth: only goaded creatures, so about a third of the deaths at the table.
  if ((m = l.match(/^whenever a goaded (?:attacking or blocking )?creature dies,\s*(.*)$/))) return { when: 'creatureDies', scope: 'all', body: m[1], chance: 0.35 };
  // Read whole by recogniseEffects (the static abilities of Fblthp, Ultima, Orvar and Lynde).
  if (/^when ~ becomes the target of a spell, shuffle ~|^whenever you tap a land for \{c\}, add an additional \{c\}|^when a spell or ability an opponent controls causes you to discard ~|^whenever a curse is put into your graveyard from the battlefield/.test(l)) return { when: 'static', body: l };
  // Lynde: the draw only happens if a Curse moved, so the two sentences are one effect.
  if ((m = l.match(/^at the beginning of your upkeep, you may attach a curse attached to you to one of your opponents\. if you do, draw (\w+) cards?/))) return { when: 'upkeep', body: `pass a curse for ${num(m[1], 2)}` };
  if ((m = l.match(/^whenever you put (?:a|one or more) lore counters? on a saga you control,\s*(.*)$/))) return { when: 'lore', body: m[1] };
  // Boast (rule 702.142): an activated ability usable only after this creature attacked, once a turn.
  if ((m = l.match(/^boast — ((?:\{[^}]+\})+):\s*(.*)$/))) {
    const cost = parseManaCost(m[1]);
    return { when: 'activated', body: m[2], activationCost: cost, tap: false, sacrifice: false, boast: true };
  }
  // Midnight Clock: an hour counter at every player's upkeep, and the twelfth one sets off the wheel.
  if ((m = l.match(/^at the beginning of each upkeep, (put an? \w+ counter on ~.*)$/))) return { when: 'eachUpkeep', body: m[1] };
  if ((m = l.match(/^when the twelfth hour counter is put on ~,\s*(.*)$/))) return { when: 'hourTwelve', body: m[1] };
  // "Becomes the target of a spell or ability" (rule 603.2): Nadu grants it to every creature you control.
  if (/^creatures you control have "whenever ~ becomes the target of a spell or ability, reveal the top card of your library\. if it's a land card, put it onto the battlefield\. otherwise, put it into your hand\. this ability triggers only twice each turn\.?"\.?$/.test(l)) {
    return { when: 'targeted', scope: 'any', castFilter: 'creature', perTurn: 2, body: 'reveal the top card of your library and put it into your hand, or onto the battlefield if it is a land' };
  }
  if ((m = l.match(/^whenever a (permanent|creature) you control becomes the target of a spell or ability( an opponent controls| you control)?,\s*(.*)$/))) {
    return { when: 'targeted', scope: 'any', ...(m[1] === 'creature' ? { castFilter: 'creature' as const } : {}), ...(m[2] ? { targetedBy: m[2] === ' you control' ? 'you' as const : 'opponents' as const } : {}), body: m[3] };
  }
  if ((m = l.match(/^(?:when|whenever) ~ becomes the target of a spell( or ability)?( you control| an opponent controls)?( for the first time each turn)?,\s*(.*)$/))) {
    return { when: 'targeted', scope: 'self', ...(m[1] ? {} : { spellOnly: true }), ...(m[2] ? { targetedBy: m[2] === ' you control' ? 'you' as const : 'opponents' as const } : {}), ...(m[3] ? { oncePerTurn: true } : {}), body: m[4] };
  }
  // Commander-specific trigger wordings.
  if ((m = l.match(/^whenever ~ becomes tapped,\s*(.*)$/))) return { when: 'attack', scope: 'self', body: m[1] };
  if ((m = l.match(/^whenever you surveil,\s*(.*)$/))) return { when: 'surveil', body: m[1] };
  if ((m = l.match(/^whenever a spell or ability you control counters a spell,\s*(.*)$/))) return { when: 'countered', body: m[1] };
  if ((m = l.match(/^whenever you roll (?:a (\d+) or higher|a die),\s*(.*)$/))) return { when: 'dieRoll', minRoll: m[1] ? parseInt(m[1], 10) : undefined, body: m[2] };
  if ((m = l.match(/^whenever an opponent becomes the monarch,\s*(.*)$/))) return { when: 'opponentMonarch', body: m[1] };
  if ((m = l.match(/^whenever a noncreature artifact is sacrificed[^,]*,\s*(.*)$/))) return { when: 'sacrifice', body: m[1] };
  // Ygra makes every other creature a Food, so a Food going to a graveyard is mostly a creature dying.
  if ((m = l.match(/^whenever a food is put into a graveyard from the battlefield,\s*(.*)$/))) return { when: 'creatureDies', scope: 'all', body: m[1] };
  if ((m = l.match(/^whenever a creature an opponent controls dies,\s*(.*)$/))) return { when: 'creatureDies', scope: 'opponents', body: m[1] };
  // Tribal deaths ("whenever a God dies"): only some creatures count.
  if ((m = l.match(/^whenever (?:a|another) (?!creature|nontoken|token|land|permanent|player|opponent|artifact|enchantment|food)(\w+)( you control)? dies,\s*(.*)$/))) {
    const ofType = tribeOf(m[1]);
    return { when: 'creatureDies', scope: m[2] ? undefined : 'all', ...(ofType ? { ofType } : { chance: 0.4 }), body: m[3] };
  }
  if ((m = l.match(/^whenever a land( you control)? enters[^,]*,\s*(.*)$/))) return { when: 'landfall', body: m[2] };
  if ((m = l.match(/^(?:when|whenever) ~ is turned face up[^,]*,\s*(.*)$/))) return { when: 'turnedFaceUp', body: m[1] };
  if ((m = l.match(/^(when|whenever) ~ (enters|is turned face up)[^,]*,\s*(.*)$/))) return { when: 'resolve', body: m[3] };
  if ((m = l.match(/^whenever an opponent casts (?:an? |their )?([^,]*?)spell([^,]*),\s*(.*)$/))) {
    const what = m[1] + m[2];
    const castFilter: CastFilter = /noncreature/.test(what) ? 'noncreature' : /instant|sorcery/.test(what) ? 'instantSorcery' : /creature/.test(what) ? 'creature' : /artifact/.test(what) ? 'artifact' : /enchantment/.test(what) ? 'enchantment' : 'any';
    return { when: 'opponentCast', castFilter, body: m[3], oncePerTurn: /first/.test(what) || undefined };
  }
  if ((m = l.match(/^whenever you draw (a card|your (first|second|third) card each turn)[^,]*,\s*(.*)$/))) return { when: 'draw', body: m[3], oncePerTurn: m[2] ? true : undefined };
  if ((m = l.match(/^whenever (?:an|another) (artifact|enchantment)(?: you control)? enters(?: under your control| the battlefield under your control)?,\s*(.*)$/))) return { when: 'permEnters', castFilter: m[1] as CastFilter, body: m[2] };
  if ((m = l.match(/^whenever you gain life[^,]*,\s*(.*)$/))) return { when: 'gainLife', body: m[1] };
  if ((m = l.match(/^whenever ~ mutates,\s*(.*)$/))) return { when: 'mutates', scope: 'self', body: m[1] };
  if ((m = l.match(/^whenever a creature you control mutates,\s*(.*)$/))) return { when: 'mutates', scope: 'any', body: m[1] };
  if ((m = l.match(/^whenever an opponent draws their (second|third) card each turn,\s*(.*)$/))) return { when: 'opponentDraw', body: m[2], nth: m[1] === 'second' ? 2 : 3 };
  if ((m = l.match(/^whenever an opponent draws a card[^,]*,\s*(.*)$/))) return { when: 'opponentDraw', body: m[1] };
  if ((m = l.match(/^whenever the ring tempts you,\s*(.*)$/))) return { when: 'ringTempts', body: m[1] };
  if ((m = l.match(/^whenever you sacrifice (a|an|another) (\w+ )?(permanent|creature|artifact|token)[^,]*,\s*(.*)$/))) return { when: 'sacrifice', body: m[4] };
  if ((m = l.match(/^whenever (equipped|enchanted) creature dies,\s*(.*)$/))) return { when: 'creatureDies', scope: 'attached', body: m[2] };
  if ((m = l.match(/^whenever ~ or another (nontoken )?creature( you control)? dies,\s*(.*)$/))) return { when: 'creatureDies', scope: m[2] ? 'any' : 'all', body: m[3], selfToo: true, nontoken: !!m[1] || undefined };
  if ((m = l.match(/^when you cast (this spell|~),\s*(.*)$/))) return { when: 'resolve', body: m[2] };
  // Classes: "When this Class becomes level 2" happens as that level is gained (see classifyCard).
  if ((m = l.match(/^when ~ becomes level \d+,\s*(.*)$/))) return { when: 'resolve', body: m[1] };
  if ((m = l.match(/^at the beginning of (your|each) (upkeep|end step|precombat main phase|combat on your turn|draw step|first main phase)[^,]*,\s*(.*)$/))) return { when: 'upkeep', body: m[3] };
  if ((m = l.match(/^at the beginning of each (player's|opponent's) (upkeep|end step)[^,]*,\s*(.*)$/))) return { when: 'upkeep', body: m[3] };
  if ((m = l.match(/^at the beginning of combat on your turn[^,]*,\s*(.*)$/))) return { when: 'upkeep', body: m[1] };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) deals combat damage to (a player|an opponent|one or more|a player or|a player, )[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'self', body: m[3] };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) deals (combat )?damage[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'self', body: m[3] };
  if ((m = l.match(/^whenever one or more (\w+ )?(?:creatures|[a-z]+s) you control( that [^,]*?)? deal combat damage to a player[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'oneOrMore', body: m[3], chance: m[2] ? 0.5 : undefined };
  if ((m = l.match(/^whenever (a|an|another) (\w+ )?(?:creature|\w+) you control deals combat damage to (a player|an opponent)[^,]*,\s*(.*)$/))) return { when: 'combatDamage', scope: 'any', body: m[4], nontoken: m[2] === 'nontoken ' || undefined };
  if ((m = l.match(/^whenever (~|equipped creature|enchanted creature) attacks[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'self', body: m[2] };
  if ((m = l.match(/^whenever (you attack|one or more (?:\w+ )?\w+ you control attack)[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'oneOrMore', body: m[2] };
  if ((m = l.match(/^whenever (a|another) (\w+ )?(?:creature|\w+) you control attacks[^,]*,\s*(.*)$/))) return { when: 'attack', scope: 'any', body: m[3], nontoken: m[2] === 'nontoken ' || undefined };
  if ((m = l.match(/^whenever you cast a creature spell, if it has mutate,\s*(.*)$/))) return { when: 'cast', castFilter: 'mutate', body: m[1] };
  if ((m = l.match(/^whenever you cast (an? |your )?([^,]*?)spell([^,]*),\s*(.*)$/))) {
    const what = m[2] + m[3];
    // "Of the chosen type", "Faerie or Wizard permanent": creature spells of one tribe, so only some of them.
    const tribal = /chosen type|\w+ or \w+ permanent/.test(what);
    const castFilter: CastFilter = /noncreature/.test(what) ? 'noncreature' : /instant|sorcery/.test(what) ? 'instantSorcery' : /creature/.test(what) || tribal ? 'creature' : /artifact|colorless/.test(what) ? 'artifact' : /enchantment/.test(what) ? 'enchantment' : 'any';
    const mv = what.match(/mana value (\d+) or greater/);
    // "While ~ is attacking" and the like: rarely true when spells are cast.
    // "A spell from exile", "a spell that shares a creature type with ~": only some of your spells.
    const chance = / while /.test(what) ? 0.15 : tribal ? 0.6 : /from exile|shares a creature type/.test(what) ? 0.5 : undefined;
    return { when: 'cast', castFilter, body: m[4], minCmc: mv ? parseInt(mv[1], 10) : undefined, chance };
  }
  if ((m = l.match(/^whenever (a|another|one or more)( nontoken)? (\w+ )?(creatures?|tokens?)( you control)?( with \w+)? (enters?|enter)[^,]*,\s*(.*)$/))) return { when: 'creatureEnters', body: m[8], nontoken: !!m[2] || undefined, chance: m[6] ? 0.7 : undefined };
  // Tribal wording: "whenever another nontoken Dragon you control enters". Treated as any creature.
  // Tribal wording: "whenever another nontoken Dragon you control enters" only counts that creature type.
  if ((m = l.match(/^whenever (a|another|one or more)( other)?( nontoken)? (?!artifact|enchantment|permanent|planeswalker|player|opponent|land|spell)(\w+) you control( of the chosen type)? (enters?)[^,]*,\s*(.*)$/))) {
    const ofType = m[5] ? 'chosen' : tribeOf(m[4]) ?? undefined;
    return { when: 'creatureEnters', body: m[7], nontoken: !!m[3] || undefined, ...(ofType ? { ofType } : {}) };
  }
  if ((m = l.match(/^whenever (?:a|another)( nontoken)? creature( you control)? of the chosen type (enters|dies)[^,]*,\s*(.*)$/))) {
    return m[3] === 'dies' ? { when: 'creatureDies', scope: m[2] ? undefined : 'all', body: m[4], ofType: 'chosen', nontoken: !!m[1] || undefined } : { when: 'creatureEnters', body: m[4], ofType: 'chosen', nontoken: !!m[1] || undefined };
  }
  if ((m = l.match(/^whenever (a|another|one or more)( nontoken)? (\w+ )?creatures?( you control)? (dies|die|is put into a graveyard)[^,]*,\s*(.*)$/))) {
    // "A creature you control dies" on a creature sees its own death too; "another" and "other" don't.
    const selfToo = m[1] !== 'another' && m[3] !== 'other ' || undefined;
    return { when: 'creatureDies', scope: m[4] ? undefined : 'all', body: m[6], nontoken: !!m[2] || undefined, selfToo };
  }
  if ((m = l.match(/^when ~ dies[^,]*,\s*(.*)$/))) return { when: 'creatureDies', scope: 'self', body: m[1] };

  // Planeswalker loyalty abilities: treat the first + or 0 ability as a per-turn effect.
  if ((m = l.match(/^([+-]?\d+): (.*)$/))) return { when: 'loyalty', loyalty: parseInt(m[1], 10), body: m[2] };
  if (/^-x: /.test(l)) return { when: 'static', body: '' };

  // Activated abilities: "COST: EFFECT" where cost is mana/tap symbols.
  const COST_PART = '(?:(?:\\{[^}]+\\})+|' + MECHANIC_COST + '|' + EMBLEM_COST + '|sacrifice ~|sacrifice (?:a|an|another) (?!artifact|land|permanent|enchantment|treasure|food|clue)\\w+|pay \\d+ life|tap (?:two|three|four|five) untapped [a-z]+ you control)';
  if ((m = l.match(new RegExp(`^(${COST_PART}(?:, ${COST_PART})*):\\s*(.*)$`)))) {
    const costText = m[1];
    const tap = /\{t\}/.test(costText);
    const extra = mechanicCost(costText);
    const cost = parseManaCost(costText.replace(new RegExp(MECHANIC_COST, 'g'), '').replace(/\{t\}|\{q\}/g, ''));
    // {X} in an activation cost: assume the smallest useful X, 1.
    cost.generic += cost.x;
    cost.x = 0;
    const life = costText.match(/pay (\d+) life/);
    if (life) cost.life += parseInt(life[1], 10);
    const tapCreatures = costText.match(/tap (two|three|four|five) untapped/);
    return { when: 'activated', body: m[2], activationCost: cost, tap, sacrifice: /sacrifice ~/.test(costText) || !!extra.exileSelf, ...(extra.energy ? { energy: extra.energy } : {}), ...(extra.charge ? { charge: extra.charge } : {}), ...(extra.discard ? { discard: extra.discard } : {}), ...(extra.shrinkSelf ? { shrinkSelf: extra.shrinkSelf } : {}), ...(extra.removeCounters ? { removeCounters: extra.removeCounters } : {}), sacCreature: /sacrifice (a|an|another) (?!~|foods?\b)\w+/.test(costText), ...(emblemCost(costText) ? { sacOther: emblemCost(costText) } : {}), ...(tapCreatures ? { tapCreatures: num(tapCreatures[1], 4) } : {}) };
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
  const twice = line.match(/^whenever ([^,]*?) and whenever ([^,]*),\s*(.*)$/);
  if (twice) return [detectTrigger(`whenever ${twice[1]}, ${twice[3]}`, isPermanent), detectTrigger(`whenever ${twice[2]}, ${twice[3]}`, isPermanent)];
  const selfOrOther = line.match(/^whenever ~ or another ([\w ]+?) you control enters,\s*(.*)$/);
  if (selfOrOther) return [detectTrigger(`when ~ enters, ${selfOrOther[2]}`, isPermanent), detectTrigger(`whenever another nontoken ${selfOrOther[1]} you control enters, ${selfOrOther[2]}`, isPermanent)];
  // Goldspan Dragon: "whenever ~ attacks or becomes the target of a spell".
  const attackOrTarget = line.match(/^whenever ~ attacks or (becomes the target of [^,]*),\s*(.*)$/);
  if (attackOrTarget) return [detectTrigger(`whenever ~ attacks, ${attackOrTarget[2]}`, isPermanent), detectTrigger(`whenever ~ ${attackOrTarget[1]}, ${attackOrTarget[2]}`, isPermanent)];
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

/** "Kicker {2}{U}", "Multikicker {1}", "Kicker {X}. X can't be 0.", "Offspring {3}" (rules 702.33, 702.175). */
const KICKER_LINE = /^(multikicker|kicker|offspring) ((?:\{[^}]+\})+)[^\n]*$/m;

/** The card's text with its kicker cost paid (`kicked`) or not: "if it was kicked" clauses kept or dropped. */
function kickerText(text: string, kicked: boolean): string {
  let t = text.replace(new RegExp(KICKER_LINE.source + '\\n?', 'm'), '');
  // Comet Storm: one more target for each time it was kicked (the engine adds the extra targets).
  t = t.replace(/choose any target, then choose another target for each time ~ was kicked\. ~ deals (x|\d+) damage to each of them\./, '~ deals $1 damage to any target.');
  if (kicked) {
    // "Mill eight cards. If this spell was kicked, instead mill half their library": the second sentence replaces the first.
    t = t.replace(/(^|\.\s+)[^.\n]*\.\s*if (?:~|it) was kicked, instead ([^.]*\.)/gm, '$1$2');
    t = t.replace(/(^|\.\s+)[^.\n]*\.\s*if (?:~|it) was kicked, ([^.]*) instead\./gm, '$1$2.');
    t = t.replace(/^(when ~ enters), if (?:~|it) was kicked, /gm, '$1, ');
  } else {
    t = t.replace(/\s*if (?:~|it) was kicked, instead [^.]*\./g, '').replace(/\s*if (?:~|it) was kicked, [^.]* instead\./g, '');
    t = t.replace(/^when ~ enters, if (?:~|it) was kicked, [^\n]*\n?/gm, '');
  }
  return t.replace(/\n+$/, '');
}

/** Read what the card does with its kicker (or offspring) paid. `card` has already been read without it. */
function readKicker(raw: RawCard, card: SimCard, line: RegExpMatchArray, text: string) {
  const what = line[1] as 'kicker' | 'multikicker' | 'offspring';
  const cost = parseManaCost(line[2]);
  const label = `${what[0].toUpperCase()}${what.slice(1)} ${line[2].toUpperCase()}`;
  // Everflowing Chalice: no charge counters unkicked, one for each kick (the engine counts them).
  const charge = /^~ enters with an? charge counter on it for each time it was kicked/m.test(text);
  if (charge) {
    card.charge = 0;
    card.notes = card.notes.map((n) => (/^Enters with \d+ charge counter/.test(n) ? 'Enters with a charge counter for each time it was kicked' : n));
  }
  if (what === 'offspring') {
    // Offspring (rule 702.175a): when it enters, if the cost was paid, a 1/1 token copy of it.
    card.kicker = { cost, offspring: true, effects: [...card.effects, { kind: 'copySelf', n: 1, size: 1, when: 'resolve' }] };
    card.notes.push(`${label}: also makes a 1/1 token copy of it`);
    return;
  }
  const kicked = classifyCard({ ...raw, text: kickerText(text, true), back: null });
  const effects = [...kicked.effects];
  // Multikicker on a spell: each kick adds another copy of its targeted damage (Comet Storm).
  if (what === 'multikicker') for (const e of kicked.effects) if (e.kind === 'removal' && e.when === 'resolve') effects.push({ ...e, perKick: true });
  card.kicker = { cost, ...(what === 'multikicker' ? { multi: true } : {}), ...(charge ? { charge } : {}), effects };
  const extra = kicked.notes.filter((n) => !card.notes.includes(n) && !/^Creature |^Not read|^Not modeled|^Planeswalker|^Mana: |^Enters with /.test(n));
  card.notes.push(`${label}${what === 'multikicker' ? ' (any number of times)' : ''}${extra.length ? `: ${extra.join('; ')}` : ''}`);
  for (const u of kicked.unread ?? []) if (!(card.unread ?? []).includes(u)) (card.unread ??= []).push(u);
}

/** The abilities of an emblem (rule 114), read like a permanent's: "you get an emblem with "..."". */
function readEmblem(text: string): { body: EffectBody; note: string } | null {
  const card = classifyCard({ name: 'An emblem', manaCost: '', cmc: 0, types: [], superTypes: [], subTypes: [], text, power: null, toughness: null, keywords: [], colorIdentity: [] });
  if (!card.effects.length) return null;
  card.typeLine = 'Emblem';
  card.value = 0;
  const what = card.notes.filter((n) => !/^Not read/.test(n)).join('; ');
  return { body: { kind: 'emblem', card }, note: `Emblem: ${what}` };
}

export function classifyCard(raw: RawCard): SimCard {
  // Cards with their own rule may be read from rewritten text (see cardRules.ts).
  const rule = CARD_RULES[raw.name.split(' // ')[0]];
  if (rule?.text !== undefined) raw = { ...raw, text: rule.text };
  if (rule?.keywords) raw = { ...raw, keywords: rule.keywords };
  const types = raw.types.map((t) => t.toLowerCase());
  const supers = raw.superTypes.map((t) => t.toLowerCase());
  const isLand = types.includes('land');
  const isCreature = types.includes('creature');
  const isPermanent = !types.includes('instant') && !types.includes('sorcery');
  const fullText = normaliseText(raw.name, raw.text);
  // Kicker, multikicker and offspring: the card is read without the extra cost paid; the kicked version is read at the end.
  const kickLine = fullText.match(KICKER_LINE);
  // Quest, oil, loot and other counters a permanent keeps on itself are read as charge counters.
  const named = rewriteCounters(castingBase(kickLine ? kickerText(fullText, false) : fullText));
  const text = rewriteEmblems(named.text, raw.name, raw.superTypes.some((t) => t.toLowerCase() === 'legendary'));
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

  if (named.name) card.counterName = named.name;
  if (/as ~ enters, choose a creature type/.test(text)) card.choosesType = true;
  if (isLand) {
    card.land = landInfo(raw, raw.producedMana, raw.colorIdentity);
    card.notes.push(`Land: ${card.land.produces === 'any' ? 'any color' : card.land.produces.join('')}${card.land.tapped ? ' (enters tapped)' : ''}`);
    card.modeled = true;
  }
  // Transforming cards (rule 712) are cast front face up; only modal double-faced cards can be played as their back.
  const transforms = raw.layout === 'transform' || raw.layout === 'meld';
  if (raw.back && transforms) {
    const b = raw.back;
    const backTypes = b.types.map((t) => t.toLowerCase());
    // Some data sources leave out the back face's power and toughness: use the front's.
    const missing = backTypes.includes('creature') && (b.power === undefined || b.power === null);
    card.back = classifyCard({
      name: b.name, manaCost: '', cmc: raw.cmc, types: b.types, superTypes: b.superTypes ?? raw.superTypes, subTypes: b.subTypes, text: b.text,
      power: missing ? raw.power ?? '2' : b.power, toughness: missing ? raw.toughness ?? '2' : b.toughness, keywords: [],
      colorIdentity: raw.colorIdentity, loyalty: b.loyalty ?? null, imageUrl: raw.imageUrl,
    });
    card.notes.push(`Transforms into ${b.name}${card.back.isLand ? ' (a land)' : card.back.isCreature ? ` (${card.back.power}/${card.back.toughness})` : ''}`);
  }
  if (raw.back && !transforms && raw.back.types.map((t) => t.toLowerCase()).includes('land') && !isLand) {
    const info = landInfo(raw.back, undefined, raw.colorIdentity);
    card.backLand = { ...info, tapped: info.tapped || /enters tapped/.test(raw.back.text.toLowerCase()), name: raw.back.name };
    card.notes.push(`Back face is a land (${raw.back.name})`);
  }

  // "Choose one —" modal spells: keep only the best bullet.
  // "As ~ enters, choose Mardu or Jeskai": only one of the bullets applies, like a modal spell.
  const isModal = /choose (one|two|one or both|one or more|up to one|up to two) —|choose one\./.test(text) || /^as ~ enters, choose [a-z]+ or [a-z]+\.$/m.test(text);
  // "When ~ enters, choose one —": the bullets that follow happen on that trigger.
  let header: LineContext[] | null = null;
  // Backgrounds: 'Commander creatures you own have "..."' is read as the Background's own ability.
  const lines = text.split('\n').map((l) => l.trim().replace(/^commander creatures you own have "(.*)"\.?$/, '$1')).filter(Boolean);
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

  /** Station thresholds: where each one's abilities start in card.effects and card.notes. */
  const stationMarks: { n: number; from: number; notesFrom: number; keywords: string[] }[] = [];
  /** Classes: where each level's abilities start in card.effects and card.notes. */
  const levelMarks: { level: number; cost: ManaCost; from: number; notesFrom: number }[] = [];

  const bulletLines = new Set<string>();
  const cursed = isPermanent && /^enchant player$/m.test(text);
  for (const rawLine of lines) {
    const effectsBefore = card.effects.length;
    const bullet = rawLine.startsWith('•');
    let line = rawLine.replace(/^•\s*/, '');
    if (bullet) bulletLines.add(line);
    // Station thresholds (rule 702.184): "8+ | Flying". What follows belongs to that threshold.
    const tier = isPermanent ? stationTier(line) : null;
    if (tier) {
      settle();
      const kws = tierKeywords(tier.rest);
      stationMarks.push({ n: tier.n, from: card.effects.length, notesFrom: card.notes.length, keywords: kws ?? [] });
      if (kws) continue;
      line = tier.rest;
      // Uthros, Titanic Godcore: "{U}, {T}: Add {U} for each artifact you control" (a land's mana lines are otherwise read from its land info).
      const perArtifact = isLand ? line.match(/^\{(\w)\}, \{t\}: add \{(\w)\} for each artifact you control/) : null;
      if (perArtifact) {
        card.effects.push({ kind: 'mana', amount: 1, colors: [perArtifact[2].toUpperCase() as Mana], perArtifact: true, when: 'static' });
        card.notes.push(`Taps for {${perArtifact[2].toUpperCase()}} for each artifact you control (less the {${perArtifact[1].toUpperCase()}} it costs)`);
        continue;
      }
    }
    if (isLand && (/: add /.test(line) || /sacrifice ~[^:]*: search/.test(line))) continue;
    // Curses (Auras with "Enchant player"): their abilities are about the enchanted player, read on their own.
    if (cursed) {
      const abilities = curseLine(line);
      if (abilities) {
        settle();
        (card.curse ??= []).push(...abilities);
        continue;
      }
    }
    lineRead(line);
    const levelLine = line.match(/^((?:\{[^}]+\})+): level (\d+)$/);
    if (levelLine) {
      levelMarks.push({ level: parseInt(levelLine[2], 10), cost: parseManaCost(levelLine[1]), from: card.effects.length, notesFrom: card.notes.length });
      continue;
    }
    if (!bullet) header = /choose (one|two|one or both|one or more|up to one|up to two) —$/.test(line) ? detectTriggers(line, isPermanent).filter((c) => c.when !== 'static' || !isPermanent) : null;
    // Bullets can carry a name ("Sell Contraband — Create a Treasure token.").
    const option = bullet ? line.replace(/^[a-z' ]{3,30} — /, '') : line;
    const contexts = bullet && header?.length ? header.map((h) => ({ ...h, body: option })) : detectTriggers(option, isPermanent);
    for (const ctx of contexts) {
    if (!ctx.body) continue;
    // "Unless that player pays": assume opponents pay some of the time.
    if ((ctx.when === 'opponentCast' || ctx.when === 'opponentDraw') && /unless (that player|they) pays?|that player may pay/.test(ctx.body)) ctx.chance = 0.6;
    // "If ~ has four or more quest counters on it": checked against the counters (see classifyCounters.ts).
    const charged = ctx.when !== 'activated' ? chargeCondition(ctx.body) : null;
    if (charged) {
      ctx.minCharge = charged.min;
      ctx.body = charged.body;
    }
    // Intervening "if" clauses: we can't check the condition, so assume it holds half the time.
    if (ctx.when !== 'resolve' && ctx.when !== 'static' && /^if [^,]+, /.test(ctx.body) && !/^if [^,]+, (?:you may )?transform ~/.test(ctx.body)) {
      ctx.chance = 0.5;
      ctx.body = ctx.body.replace(/^if [^,]+, /, '');
    }
    if (/only once each turn|for the first time each turn/.test(line)) ctx.oncePerTurn = true;
    if (ctx.when === 'activated' && /activate only as a sorcery/.test(line)) ctx.sorcery = true;
    // "Their first spell each turn", "your second spell during each opponent's turn": the engine counts spells, so check exactly.
    const nth = (ctx.when === 'cast' || ctx.when === 'opponentCast') ? line.match(/^whenever [^,]*\b(first|second|third) spell\b([^,]*),/) : null;
    if (nth) {
      ctx.nth = { first: 1, second: 2, third: 3 }[nth[1]];
      ctx.oncePerTurn = undefined;
      if (/during (their|your) turn/.test(nth[2])) ctx.turn = 'own';
      else if (/during (each|an) opponent's turn/.test(nth[2])) ctx.turn = 'others';
    } else if (/^whenever [^,]*\b(second|third)\b[^,]*,/.test(line) && ctx.when !== 'draw' && !ctx.nth) {
      // "Your second card", "the second time": at most once a turn, and often not at all.
      ctx.oncePerTurn = true;
      ctx.chance = 0.5;
    }
    // "Whenever a player casts ..., they create": what the caster gets, not you. Kept only for your own spells.
    if (ctx.when === 'opponentCast' && /^(they|that player) (create|draw|gain)/.test(ctx.body) && /whenever a player casts/.test(line)) continue;
    // "With mana value equal to the chosen number" and the like: only some spells qualify.
    if ((ctx.when === 'opponentCast' || ctx.when === 'cast') && /^whenever [^.]*\b(chosen number|chosen name|same name as)\b/.test(line)) ctx.chance = 0.25;
    // Voting: only one outcome happens. With bots at the table, assume the last one listed (ties usually go there).
    if (/votes? for/.test(ctx.body)) ctx.body = ctx.body.split(/(?<=\.)\s+/).slice(-1)[0];
    // Kicker isn't paid: drop what the kicked version does instead.
    ctx.body = ctx.body.replace(/\s*if (this spell|~|it) was kicked, instead [^.]*\./g, '');
    // Fblthp: the bigger draw only when it came from the library, which is rare.
    ctx.body = ctx.body.replace(/\s*if it entered from your library or was cast from your library, draw two cards instead\./, '');
    // Sensei's Divining Top: the draw costs the Top itself, so it isn't card advantage.
    if (ctx.when === 'activated' && /put ~ on top of (its owner's|your) library/.test(ctx.body)) ctx.body = '';
    // A line can hold several sentences, e.g. "Draw two cards. Create a Treasure."
    const sentences = ctx.body.replace(/"[^"]*"/g, '').split(/(?<=\.)\s+(?=[a-z~])/);
    // "You may pay {E}{E}{E}. When you do, ...": what follows costs that much energy (see classifyMechanics.ts).
    let energyGate = 0;
    for (let sentence of sentences) {
      const gate = energyGateOf(sentence);
      if (gate) {
        energyGate = gate;
        if (!/^you get /.test(sentence)) continue;
      }
      if (energyGate && !gate) sentence = sentence.replace(/^(when|if) you (do|pay), /, '');
      // "Then if it has eight or more charge counters on it, remove all of them and ...": checked as it resolves.
      const threshold = chargeThenCondition(sentence);
      if (threshold) sentence = threshold.rest;
      // "Whenever another creature enters, it gains haste": "it" is the newcomer, which a self-only pump can't reach.
      const found = recogniseEffects(sentence, { isPermanent, isCreature }, ctx.body).filter((f) => !(f.body.kind === 'pump' && f.body.self && ctx.when === 'creatureEnters'));
      // Sanguine Bond: "loses that much life" is the life just gained (X = the amount, see the engine's gainLife).
      if (ctx.when === 'gainLife' && /loses? that much life/.test(sentence)) for (const f of found) if (f.body.kind === 'damagePlayer' || f.body.kind === 'drain') { f.body.n = -1; f.note = f.note.replace(/\d+$/, 'that much'); }
      // Mana abilities on nonland permanents (rocks and dorks).
      const manaMatch = ctx.when === 'activated' ? sentence.match(/^(?:for each [^,]*, )?add (.*)$/) : null;
      // Rituals: mana from an instant or sorcery is kept as that many Treasures.
      // Planeswalkers' and Sagas' "add {C}{C}{C}" (Ugin, The Legend of Roku) are one-shot mana too.
      const ritual = ((!isPermanent || /^when ~ enters/.test(line)) && ctx.when === 'resolve') || ctx.when === 'loyalty' || ctx.when === 'chapter' ? sentence.match(/^add (.*)$/) : null;
      if (ritual) {
        const p = parseProduced(ritual[1]);
        const n = /for each/.test(sentence) ? 3 : p?.amount ?? 0;
        const f: Found = { body: { kind: 'treasure', n, ritual: true }, note: `Ritual: ${n} one-shot mana` };
        if (n > 0) {
          if (isModal && bullet) modalFound.push({ found: f, ctx });
          else pushEffect(card, f, ctx);
        }
        continue;
      }
      // Mana counted from something, from +1/+1 counters, or only some of the time (classifyCounting.ts).
      const counted = manaMatch ? countingMana(sentence, line, ctx) : null;
      if (counted) {
        manaLines++;
        card.effects.push(counted);
        continue;
      }
      // Mana from charge counters (Astral Cornucopia, Empowered Autogenerator, Pentad Prism) or paid with energy (Solar Transformer).
      const charged = manaMatch ? chargeMana(sentence, line, !!ctx.tap) : null;
      if (charged) {
        manaLines++;
        card.effects.push({ ...charged, when: 'static' } as Effect);
        continue;
      }
      if (manaMatch && ctx.energy && ctx.tap) {
        const p = /any combination of colors/.test(sentence) ? { amount: count3(sentence), colors: 'any' as const } : parseProduced(manaMatch[1]);
        if (p) {
          manaLines++;
          card.effects.push({ kind: 'mana', amount: p.amount, colors: p.colors, energy: ctx.energy, when: 'static' });
          continue;
        }
      }
      if (manaMatch) {
        const p = /^for each color/.test(sentence) ? { amount: 2, colors: 'any' as const } : parseProduced(manaMatch[1]);
        if (p && (ctx.sacCreature || ctx.sacOther)) {
          pushEffect(card, { body: { kind: 'treasure', n: p.amount, ritual: true }, note: `Sacrifice a ${ctx.sacOther ? 'Food' : 'creature'} for ${p.amount} mana` }, ctx);
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
        if (threshold) {
          f.chargeAtResolve = { n: threshold.n, reset: threshold.reset };
          f.note += ` (at ${threshold.n} counters${threshold.reset ? ', removing them' : ''})`;
        }
        if (energyGate && !(gate && f.body.kind === 'energy')) f.energyCost = energyGate;
        if (isModal && bullet) {
          modalFound.push({ found: f, ctx });
          continue;
        }
        pushEffect(card, f, ctx);
      }
    }
    }
    // "{T}: Draw a card ... then return him to the battlefield transformed": the transform rides along with the ability.
    const added = card.effects.slice(effectsBefore);
    if (added.length > 1) for (const e of added) if (e.kind === 'transform' && e.when === 'activated') e.rider = true;
  }
  settle();
  // A modal ability plays its best option, so the other bullets aren't missing anything once one was read.
  if (modalFound.some((f) => f.ctx.when !== 'static' || ['anthem', 'costReduction'].includes(f.found.body.kind))) for (let i = unread.length - 1; i >= 0; i--) if (bulletLines.has(unread[i])) unread.splice(i, 1);
  if (unread.length) card.unread = unread;

  // Classes: abilities after a "Level N" line only apply once the Class reaches that level.
  if (levelMarks.length) {
    card.levels = levelMarks.map((mk, i) => ({ level: mk.level, cost: mk.cost, effects: card.effects.slice(mk.from, levelMarks[i + 1]?.from ?? card.effects.length) }));
    card.effects = card.effects.slice(0, levelMarks[0].from);
    for (let i = levelMarks.length - 1; i >= 0; i--) {
      const end = levelMarks[i + 1]?.notesFrom ?? card.notes.length;
      for (let j = levelMarks[i].notesFrom; j < end; j++) card.notes[j] = `Level ${levelMarks[i].level}: ${card.notes[j]}`;
      card.notes.splice(levelMarks[i].notesFrom, 0, `Level ${levelMarks[i].level} for ${levelMarks[i].cost.generic ? `{${levelMarks[i].cost.generic}}` : ''}${levelMarks[i].cost.pips.map((pip) => `{${pip.join('/')}}`).join('')}`);
    }
  }
  // Station (rule 702.184): abilities after "N+ |" only apply once the permanent has N charge counters.
  if (stationMarks.length) {
    const creatureAt = raw.text.match(/it's an artifact creature at (\d+)\+/i);
    card.station = {
      tiers: stationMarks.map((mk, i) => ({ n: mk.n, keywords: mk.keywords, effects: card.effects.slice(mk.from, stationMarks[i + 1]?.from ?? card.effects.length) })),
      ...(creatureAt ? { creatureAt: parseInt(creatureAt[1], 10) } : {}),
    };
    card.effects = card.effects.slice(0, stationMarks[0].from);
    for (let i = stationMarks.length - 1; i >= 0; i--) {
      const end = stationMarks[i + 1]?.notesFrom ?? card.notes.length;
      for (let j = stationMarks[i].notesFrom; j < end; j++) card.notes[j] = `${stationMarks[i].n}+ charge: ${card.notes[j]}`;
      if (stationMarks[i].keywords.length) card.notes.splice(stationMarks[i].notesFrom, 0, `${stationMarks[i].n}+ charge: ${stationMarks[i].keywords.join(', ')}`);
    }
    card.notes.push(`Station: tap another creature to add charge counters equal to its power${creatureAt ? ` (a ${card.power}/${card.toughness} artifact creature at ${creatureAt[1]}+)` : ''}`);
  }
  // Sagas: a lore counter each turn sets off the matching chapter; the last one ends it.
  if (raw.subTypes.some((t) => t.toLowerCase() === 'saga')) {
    const chapters = [...text.matchAll(/^((?:i|ii|iii|iv|v|vi|vii)(?:, (?:i|ii|iii|iv|v|vi|vii))*) — /gm)].flatMap((m) => m[1].split(', ').map((r) => ROMAN[r]));
    if (chapters.length) {
      card.saga = Math.max(...chapters);
      card.notes.unshift(`Saga with ${card.saga} chapters, one each turn`);
    }
  }

  const manaEffect = card.effects.find((e) => e.kind === 'mana');
  if (manaEffect && manaEffect.kind === 'mana') {
    card.notes.push(`Mana: +${manaEffect.amount} ${manaEffect.colors === 'any' ? 'any color' : manaEffect.colors.join('/')}${manaNote(manaEffect)}`);
  }
  // Further mana abilities that only work some of the time or count something (Glistening Sphere's corrupted one).
  for (const e of card.effects) if (e !== manaEffect && e.kind === 'mana' && manaNote(e)) card.notes.push(`Mana: +${e.amount} ${e.colors === 'any' ? 'any color' : e.colors.join('/')}${manaNote(e)}`);

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
  graveyardKeywords(text, card);
  mechanicKeywords(text, card);
  const ninjutsu = isCreature && text.match(/^(commander )?ninjutsu ((?:\{[^}]+\})+)/m);
  if (ninjutsu) {
    card.ninjutsu = { cost: parseManaCost(ninjutsu[2]), ...(ninjutsu[1] ? { commander: true } : {}) };
    card.notes.push(`${ninjutsu[1] ? 'Commander n' : 'N'}injutsu ${ninjutsu[2].toUpperCase()}: swaps in for an unblocked attacker`);
  }
  const toxic = isCreature && text.match(/^toxic (\d+)/m);
  if (toxic) {
    card.toxic = parseInt(toxic[1], 10);
    card.notes.push(`Toxic ${toxic[1]}: poison counters on combat damage to a player`);
  }
  const cumulative = isPermanent && text.match(/^cumulative upkeep ((?:\{[^}]+\})+)/m);
  if (cumulative) {
    card.cumulativeUpkeep = parseManaCost(cumulative[1]);
    card.notes.push(`Cumulative upkeep ${cumulative[1].toUpperCase()}: pays more each turn, then is sacrificed`);
  }
  // Vanishing N (rule 702.63): N time counters, one comes off each upkeep, sacrificed when the last does.
  const vanishing = isPermanent && text.match(/^vanishing (\d+)$/m);
  if (vanishing) {
    card.vanishing = parseInt(vanishing[1], 10);
    card.notes.push(`Vanishing ${vanishing[1]}: sacrificed at your ${vanishing[1] === "1" ? "next upkeep" : `upkeep ${vanishing[1]} turns after it enters`}`);
  }
  const morph = isPermanent && text.match(/^(morph|megamorph|disguise) ((?:\{[^}]+\})+)/m);
  if (morph) {
    card.morph = { cost: parseManaCost(morph[2]), ...(morph[1] === 'megamorph' ? { counter: true } : {}), ...(morph[1] === 'disguise' ? { ward: true } : {}) };
    card.notes.push(`${morph[1][0].toUpperCase()}${morph[1].slice(1)} ${morph[2].toUpperCase()}: may be cast face down as a 2/2 for {3}, then turned face up`);
  }
  const mutate = isCreature && text.match(/^mutate ((?:\{[^}]+\})+)/m);
  if (mutate) {
    card.mutate = { cost: parseManaCost(mutate[1]) };
    if (/^you may cast ~ from your graveyard using its mutate ability/m.test(text)) card.mutate.fromGraveyard = true;
    card.notes.push(`Mutate ${mutate[1].toUpperCase()}: merge with a non-Human creature you own${card.mutate.fromGraveyard ? ' (also from your graveyard)' : ''}`);
  }
  const crew = !isCreature && isPermanent && text.match(/^crew (\d+)/m);
  if (crew) {
    card.crew = parseInt(crew[1], 10);
    card.notes.unshift(`Vehicle ${card.power}/${card.toughness}${card.keywords.length ? ` — ${card.keywords.map((k) => (/^(pro|hexfrom):/.test(k) ? describeProtection(k) : k)).join(', ')}` : ''}, crew ${card.crew}`);
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
  const COLOR_WORDS: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
  let alt: RegExpMatchArray | null;
  if ((alt = text.match(/^(if it's not your turn, )?you may (pay (\w+) life and )?exile an? (white|blue|black|red|green) card from your hand rather than pay ~'s mana cost/m))) {
    card.altCost = { mana: parseManaCost(''), pitch: COLOR_WORDS[alt[4]], ...(alt[2] ? { life: num(alt[3], 1) } : {}), ...(alt[1] ? { notYourTurn: true } : {}) };
    card.notes.push(`Free by exiling a ${alt[4]} card from your hand${alt[2] ? ` and paying ${num(alt[3], 1)} life` : ''}${alt[1] ? " (not on your turn)" : ''}`);
  } else if ((alt = text.match(/^(if an opponent cast (\w+) or more spells this turn, )?you may pay ((?:\{[^}]+\})+) rather than pay ~'s mana cost( if there are (\w+) or more creatures on the battlefield)?\.?$/m))) {
    card.altCost = { mana: parseManaCost(alt[3]), ...(alt[1] ? { opponentSpells: num(alt[2], 3) } : {}), ...(alt[4] ? { creatures: num(alt[5], 13) } : {}) };
    card.notes.push(`Costs ${alt[3].toUpperCase()} instead${alt[1] ? ` if an opponent cast ${alt[2]} spells this turn` : ''}${alt[4] ? ` with ${alt[5]} or more creatures out` : ''}`);
  } else if ((alt = text.match(/^you may return (an|two) islands? you control to (?:its|their) owner's hand rather than pay ~'s mana cost/m))) {
    card.altCost = { mana: parseManaCost(''), returnIslands: num(alt[1], 1) };
    card.notes.push(`Free by returning ${alt[1] === 'an' ? 'an Island' : 'two Islands'} to your hand`);
  } else if (isPermanent && (alt = text.match(/^evoke ((?:\{[^}]+\})+)|^evoke—exile an? (white|blue|black|red|green) card from your hand/m))) {
    card.altCost = alt[1] ? { mana: parseManaCost(alt[1]), evoke: true } : { mana: parseManaCost(''), pitch: COLOR_WORDS[alt[2]], evoke: true };
    card.notes.push(`Evoke ${alt[1] ? alt[1].toUpperCase() : `by exiling a ${alt[2]} card`}: sacrificed as it enters, after its enters abilities`);
  } else if (isCreature && (alt = text.match(/^dash ((?:\{[^}]+\})+)/m))) {
    card.altCost = { mana: parseManaCost(alt[1]), dash: true };
    card.notes.push(`Dash ${alt[1].toUpperCase()}: haste, back to hand at end of turn`);
  }
  // Cascade (rule 702.85), once for each instance ("cascade, cascade").
  const cascade = text.match(/^cascade((?:, cascade)*)$/m);
  if (cascade) {
    card.cascade = 1 + (cascade[1].match(/cascade/g)?.length ?? 0);
    card.notes.push(`Cascade${card.cascade > 1 ? ` ×${card.cascade}` : ''}: as it is cast, exile cards until a cheaper nonland card and cast it free`);
  }
  // Assist (rule 702.132): another player may help pay. Bots always pay the whole cost themselves.
  if (/^assist$/m.test(text)) card.notes.push('Assist: another player may help pay (bots pay it all themselves)');
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
  if (card.discount) card.notes.push(`Costs {${card.discount.amount}} less for each ${({ artifacts: 'artifact you control', creatures: 'creature you control', allCreatures: 'creature on the battlefield', graveyardCreatures: 'creature card in your graveyard', graveyard: 'card in your graveyard' } as Record<string, string>)[card.discount.per]}`);
  // "Gets +1/+0 for each ...", other counted powers, and other ways spells cost less (classifyCounting.ts).
  countingKeywords(text, card, raw);

  // Playing off the top of the library every turn is roughly an extra card a turn (unless read as a real permission, classifyExile.ts).
  if (isPermanent && /you may (play lands and )?cast spells from the top of your library/.test(text) && !card.effects.some((e) => e.kind === 'playTop')) {
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

  if (card.curse?.length) card.notes.unshift(`Curse (enchants a player): ${card.curse.map(describeCurse).join('; ')}`);
  const kwWords = keywords.map((k) => (/^(pro|hexfrom):/.test(k) ? describeProtection(k) : k));
  if (isCreature) card.notes.unshift(`Creature ${card.power}/${card.toughness}${keywords.length ? ' — ' + kwWords.join(', ') : ''}`);
  else if (keywords.some((k) => /^(pro|hexfrom):/.test(k)) && card.crew === undefined) card.notes.unshift(`Has ${kwWords.join(', ')}`);
  else if (keywords.includes('flash')) card.notes.push('Flash');

  if (kickLine) readKicker(raw, card, kickLine, fullText);
  // Foretell, suspend, plot, spree, bargain, gift and the other casting keywords (classifyCasting.ts).
  castingKeywords(raw, fullText, card, classifyCard, parseManaCost);

  // Rooms (rule 709.5): the other door is read on its own, and unlocked later for its mana cost.
  if (raw.back && raw.subTypes.some((t) => t.toLowerCase() === 'room')) {
    const b = raw.back;
    const front = parseManaCost(raw.manaCost);
    // Data without the back door's cost: what the card's total mana value leaves over.
    const rest = Math.max(0, raw.cmc - front.generic - front.pips.length);
    const manaCost = b.manaCost || `{${rest}}`;
    const cost = parseManaCost(manaCost);
    const door = classifyCard({ name: b.name, manaCost, cmc: cost.generic + cost.pips.length, types: b.types, superTypes: b.superTypes ?? [], subTypes: b.subTypes, text: b.text, power: null, toughness: null, keywords: [], colorIdentity: raw.colorIdentity, imageUrl: raw.imageUrl });
    card.room = { door };
    card.notes.push(`Room: ${b.name} is the other door (cast it, or unlock it for ${manaCost.toUpperCase()})${door.effects.length ? `: ${door.notes.filter((n) => !/^Not /.test(n)).join('; ')}` : ''}`);
    for (const u of door.unread ?? []) (card.unread ??= []).push(u);
  }
  // After the Room's other door, so an entry for a Room covers both doors.
  if (rule) applyCardRule(card, rule);
  card.modeled = !!card.room?.door.modeled || !!card.kicker || isLand || (isCreature && (card.power > 0 || card.toughness > 0 || !!card.entersWithX || !!card.scales)) || card.effects.length > 0 || !!card.cycling || !!card.crew || !!card.mutate || !!card.morph || !!card.graveyard || !!card.levels?.some((l) => l.effects.length) || !!card.curse?.length || !!card.sunburst || !!card.station || !!card.casting;
  if (!card.modeled) card.notes.push('Not modeled — treated as a blank card');
  else for (const line of card.unread ?? []) card.notes.push(`Not read: "${line.length > 90 ? `${line.slice(0, 90)}…` : line}"`);
  // Notes call quest, oil and other self counters by their own name (they are read as charge counters).
  if (named.name) card.notes = card.notes.map((n) => n.replace(/\bcharge counter/g, `${named.name} counter`));
  card.value = cardValue(card);
  return card;
}

/**
 * A line of a Curse (rule 303.4): what happens to the enchanted player. null when the line isn't a Curse ability;
 * an empty list for lines that belong to one read elsewhere (Curse of Vengeance's payoff, Curse of Hospitality's exile).
 */
function curseLine(line: string): CurseAbility[] | null {
  let m: RegExpMatchArray | null;
  if ((m = line.match(/^whenever enchanted player is attacked, (.*?)\.? each opponent attacking that player does the same/))) {
    const body = m[1];
    if (/create a gold token|create a treasure token/.test(body)) return [{ on: 'attacked', act: 'gold', n: 1 }];
    if (/create a 2\/2 black zombie/.test(body)) return [{ on: 'attacked', act: 'zombie', n: 1 }];
    if ((m = body.match(/you gain (\d+) life/))) return [{ on: 'attacked', act: 'gainLife', n: parseInt(m[1], 10) }];
    if (/you draw a card/.test(body)) return [{ on: 'attacked', act: 'draw', n: 1 }];
    return null;
  }
  if (/^whenever a player attacks enchanted player with one or more creatures, that attacking player may create a tapped 2\/2/.test(line)) return [{ on: 'attacked', act: 'attackerZombie', n: 1 }];
  if (/^at the beginning of enchanted player's upkeep, ~ deals damage to that player equal to the number of curses attached to them/.test(line)) return [{ on: 'theirUpkeep', act: 'thirst', n: 1 }];
  if ((m = line.match(/^at the beginning of enchanted player's upkeep, that player loses (\d+) life unless they sacrifice a nonland permanent/))) return [{ on: 'theirUpkeep', act: 'torment', n: parseInt(m[1], 10) }];
  if (/^at the beginning of enchanted player's upkeep, any number of target players other than that player each draw cards equal to the number of curses/.test(line)) return [{ on: 'theirUpkeep', act: 'surveil', n: 1 }];
  if (/^at the beginning of enchanted player's upkeep, that player reveals cards from the top of their library until they reveal a creature card\. put that card onto the battlefield under your control/.test(line)) return [{ on: 'theirUpkeep', act: 'unbinding', n: 1 }];
  if ((m = line.match(/^at the beginning of enchanted player's upkeep, that player sacrifices a creature or planeswalker[^.]*\. if the player can't, they lose (\d+) life/))) return [{ on: 'theirUpkeep', act: 'cruel', n: parseInt(m[1], 10) }];
  if ((m = line.match(/^at the beginning of enchanted player's draw step, that player draws (\w+) additional cards?/))) return [{ on: 'theirDraw', act: 'obsessionDraw', n: num(m[1], 2) }];
  if (/^at the beginning of enchanted player's end step, that player discards their hand/.test(line)) return [{ on: 'theirEnd', act: 'obsessionDiscard', n: 1 }];
  if (/^at the beginning of each end step, enchanted player mills x cards, where x is the number of cards put into their graveyard from anywhere this turn/.test(line)) return [{ on: 'eachEnd', act: 'fraying', n: 1 }];
  if (/^at the beginning of your upkeep, you may search your library for a curse card[^.]*put it onto the battlefield attached to that player/.test(line)) return [{ on: 'yourUpkeep', act: 'misfortunes', n: 1 }];
  if ((m = line.match(/^whenever enchanted player draws a card, they lose (\d+) life and you gain \d+ life/))) return [{ on: 'draws', act: 'drain', n: parseInt(m[1], 10) }];
  if ((m = line.match(/^whenever enchanted player casts a spell other than the first spell they cast each turn[^,]*, ~ deals (\d+) damage to them/))) return [{ on: 'casts', act: 'burn', n: parseInt(m[1], 10), filter: 'notFirst' }];
  if (/^whenever enchanted player casts a noncreature spell, roll a d6\. ~ deals damage to that player equal to the result\. then attach ~ to another one of your opponents/.test(line)) return [{ on: 'casts', act: 'hex', n: 1, filter: 'noncreature' }];
  if (/^whenever enchanted player casts a spell, put a spite counter on ~/.test(line)) return [{ on: 'casts', act: 'spite', n: 1 }];
  if (/^when enchanted player loses the game, you gain x life and draw x cards, where x is the number of spite counters/.test(line)) return [];
  if ((m = line.match(/^whenever a creature enchanted player controls enters, that player loses (\d+) life and you gain \d+ life/))) return [{ on: 'creatureEnters', act: 'drain', n: parseInt(m[1], 10) }];
  if (/^whenever a land enchanted player controls enters, you create a 2\/2 black zombie/.test(line)) return [{ on: 'landEnters', act: 'restless', n: 1 }];
  if ((m = line.match(/^creatures enchanted player controls get -(\d+)\/-\d+/))) return [{ on: 'static', act: 'shrink', n: parseInt(m[1], 10) }];
  if (/^if a source would deal damage to enchanted player, it deals double that damage/.test(line)) return [{ on: 'static', act: 'double', n: 2 }];
  if (/^creatures attacking enchanted player have trample/.test(line)) return [{ on: 'static', act: 'hospitality', n: 1 }];
  if (/^whenever a creature deals combat damage to enchanted player, that player exiles the top card of their library\. until end of turn, that creature's controller may play that card/.test(line)) return [];
  return null;
}

function describeCurse(c: CurseAbility): string {
  const when = { attacked: 'when they are attacked', theirUpkeep: 'their upkeep', theirDraw: 'their draw step', theirEnd: 'their end step', yourUpkeep: 'your upkeep', eachEnd: 'each end step', draws: 'when they draw', casts: 'when they cast a spell', creatureEnters: 'when a creature of theirs enters', landEnters: 'when a land of theirs enters', static: 'always' }[c.on];
  const what: Record<CurseAct, string> = {
    gold: 'a Gold token for you and each attacker', zombie: 'a 2/2 Zombie for you and each attacker', gainLife: `${c.n} life for you and each attacker`, draw: 'a card for you and each attacker',
    attackerZombie: 'each attacker may make a tapped 2/2 Zombie', thirst: 'damage equal to their Curses', torment: `they lose ${c.n} unless they sacrifice or discard`, surveil: 'you draw a card per Curse on them',
    unbinding: 'you get the first creature off their library', cruel: `they sacrifice a creature or lose ${c.n}`, drain: `they lose ${c.n}, you gain ${c.n}`, burn: `${c.n} damage to them`,
    hex: 'a d6 of damage, then it moves on', spite: 'a spite counter (you gain and draw that many when they lose)', restless: 'you make a 2/2 Zombie', fraying: 'they mill what went to their graveyard this turn',
    obsessionDraw: `they draw ${c.n} more`, obsessionDiscard: 'they discard their hand', misfortunes: 'put another Curse on them from your library', shrink: `their creatures get -${c.n}/-${c.n}`,
    double: 'damage to them is doubled', hospitality: 'attackers have trample and steal their top card',
  };
  return `${when}: ${what[c.act]}`;
}

/** Lines that need no effect of their own: keyword lines, attachment boilerplate, things read from the whole text. */
function handledElsewhere(line: string, keywords: string[], isLand: boolean): boolean {
  const parts = line.split(/,\s*/).map((p) => p.trim().replace(/ \{.*$/, '').replace(/[.]$/, ''));
  if (parts.every((p) => keywords.includes(p) || (p.startsWith('ward') && keywords.includes('ward')) || protectionKeywords(p)?.every((k) => keywords.includes(k)))) return true;
  if (combatLineHandled(line)) return true;
  if (/^(enchant |equip\b|choose (one|two|one or both|one or more|up to \w+)\b)/.test(line) || /choose (one|two|one or both|one or more|up to one|up to two) —$/.test(line)) return true;
  if (/^~ can't be blocked\.?$/.test(line) && keywords.includes('unblockable')) return true;
  if (/^~ can't block\.?$/.test(line)) return true;
  if (controlLineHandled(line)) return true;
  if (/^toxic \d+$/.test(line)) return true;
  if (/enters with (x|\w+) \+1\/\+1 counters?/.test(line)) return true;
  if (isLand && /enters tapped|^as ~ enters|^\(|^~ is every|basic land type/.test(line)) return true;
  // Read from the whole text into flags on the card.
  if (/^~ doesn't untap during your untap step|^if you control a commander, you may cast ~ without paying its mana cost|^as an additional cost to cast ~, (sacrifice (a|an) (creature|artifact|artifact or creature)|discard (a|two) cards?|sacrifice an artifact or discard a card)\.?$/.test(line)) return true;
  if (/^~ enters tapped\.?$|^~ can't be countered|^affinity for artifacts|^improvise|^convoke|^delve|^~ costs \{\d\} less to cast for each (creature on the battlefield|creature card in your graveyard|artifact you control|creature you control)|^as an additional cost to cast ~, pay x life|^mutate |^you may cast ~ from your graveyard using its mutate ability|^(morph|megamorph|disguise) \{|^(basic )?[a-z]*cycling (\{[^}]+\})+|^flashback (\{[^}]+\})+|^overload (\{[^}]+\})+|^crew \d+|^~ enters tapped with \w+ stun counters? on it|^storm\b|^cascade(, cascade)*$|^assist$|^~'s power (and toughness are each|is) equal to the number of (cards in your hand|cards in your graveyard|cards in (your opponents'|the chosen player's|all) graveyards?|creature cards in all graveyards|instant and sorcery cards in your graveyard|[a-z, \/]+ you control)/.test(line)) return true;
  // Class levels, Saga boilerplate and alternative costs, read from the whole text.
  if (/^(\{[^}]+\})+: level \d+$|^evoke\b|^dash (\{[^}]+\})+|rather than pay ~'s mana cost/.test(line)) return true;
  // Text that changes nothing in this engine: deck-building rules, creature types, hidden-information permissions.
  if (graveyardLineHandled(line) || mechanicLineHandled(line) || counterLineHandled(line) || exileLineHandled(line) || countingLineHandled(line) || castingLineHandled(line) || lockLineHandled(line)) return true;
  if (/^~ is also an? [a-z, ]+\.?$|^as ~ enters, choose a number|^you can't cast permanent spells|^a deck can have|^changeling|^choose a background|^as ~ enters, choose a creature type|^as ~ enters, choose [a-z]+ or [a-z]+\.$|^as ~ enters, choose artifact, creature, enchantment, instant, or sorcery|^~ is the chosen type in addition to its other types|^(commander )?ninjutsu (\{[^}]+\})+$|^cumulative upkeep (\{[^}]+\})+$|^vanishing \d+$|^~ can't be blocked by creatures with power \d+ or (less|greater)\.?$|^if you would lose unspent mana, that mana becomes \w+ instead|^you may look at the top card of your library any time|^exile ~\.?$|^devoid|^partner|^~ is all colors/.test(line)) return true;
  return false;
}

/** "Add three mana in any combination of colors". */
function count3(sentence: string): number {
  const m = sentence.match(/^add (\w+) mana/);
  return m ? num(m[1], 1) : 1;
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
  const chance = f.chance !== undefined ? (ctx.chance ?? 1) * f.chance : ctx.chance;
  if (chance) effect.chance = chance;
  if (f.minRoll ?? ctx.minRoll) effect.minRoll = f.minRoll ?? ctx.minRoll;
  if (ctx.oncePerTurn) effect.oncePerTurn = true;
  if (f.energyCost) effect.energyCost = f.energyCost;
  if (f.chargeAtResolve) effect.chargeAtResolve = f.chargeAtResolve;
  if (ctx.nontoken) effect.nontoken = true;
  if (ctx.selfToo) effect.selfToo = true;
  if (ctx.nth) effect.nth = ctx.nth;
  if (ctx.turn) effect.turn = ctx.turn;
  if (ctx.targetedBy) effect.targetedBy = ctx.targetedBy;
  if (ctx.spellOnly) effect.spellOnly = true;
  if (ctx.perTurn) effect.perTurn = ctx.perTurn;
  if (ctx.zones) effect.zones = ctx.zones;
  if (ctx.minAttackers) effect.minAttackers = ctx.minAttackers;
  if (f.thatPlayer) effect.thatPlayer = true;
  if (f.noCounters) effect.noCounters = true;
  if (ctx.ofType) effect.ofType = ctx.ofType;
  if (ctx.loyalty !== undefined) effect.loyalty = ctx.loyalty;
  if (ctx.loyaltyX) effect.loyaltyX = true;
  if (ctx.xTimes) effect.xTimes = ctx.xTimes;
  if (ctx.chapters) effect.chapters = ctx.chapters;
  // "You win the game" only with a counter condition the engine checks (Simic Ascendancy); the rest are in wincons.ts.
  if ((effect.kind === 'winGame' || effect.kind === 'loseGame') && !ctx.minCharge && !f.chargeAtResolve) return;
  if (ctx.minCharge) {
    effect.minCharge = ctx.minCharge;
    f = { ...f, note: `${f.note} (with ${ctx.minCharge}+ counters)` };
  }
  // "Copy that spell" only means something on a cast trigger.
  if (effect.kind === 'copySpell' && effect.what === 'trigger' && ctx.when !== 'cast' && ctx.when !== 'opponentCast') return;
  // Baeloth Barrityl: a static goad.
  if (effect.kind === 'goad' && effect.weaker) {
    if (ctx.when !== 'static') return;
    card.effects.push(effect);
    card.notes.push(f.note);
    return;
  }
  if (ctx.when === 'activated') {
    if (!ctx.activationCost) return;
    effect.activation = {
      cost: ctx.activationCost, tap: !!ctx.tap, sacrifice: !!ctx.sacrifice, ...(ctx.sacCreature ? { sacCreature: true } : {}), ...(ctx.sacOther ? { sacOther: ctx.sacOther } : {}), ...(ctx.tapCreatures ? { tapCreatures: ctx.tapCreatures } : {}), ...(ctx.boast ? { boast: true } : {}),
      ...(ctx.energy ? { energy: ctx.energy } : {}), ...(ctx.charge ? { charge: ctx.charge } : {}), ...(ctx.sorcery ? { sorcery: true } : {}),
      ...(ctx.discard ? { discard: ctx.discard } : {}), ...(ctx.shrinkSelf ? { shrinkSelf: ctx.shrinkSelf } : {}), ...(ctx.removeCounters ? { removeCounters: ctx.removeCounters } : {}),
    };
  }
  // Static lines on a permanent only make sense for static effects.
  const staticKinds = ['spellTax', 'landPunish', 'toughnessMatters', 'anthem', 'equip', 'costReduction', 'noMaxHand', 'winOnEmptyDraw', 'doubler', 'etbDoubler', 'attackTax', 'spellLimit', 'commandLock', 'graveyardHate', 'clone', 'selfKeyword', 'baseSize', 'enterCounters', 'untapAlways', 'millBoost', 'damageToMill', 'graveyardPlay', 'graveyardLock', 'drawRule', 'lifeLossMill', 'shuffleWhenTargeted', 'colorlessBoost', 'ringProtection', 'copyOnDiscard', 'foodCreatures', 'returnCurses', 'landRule', 'tapPunish', 'landDiesPunish', 'energyBoost', 'chargeWin', 'bountyPayout', 'bountyOnTarget', 'damageBonus', 'treasureBoost', 'playTop', 'freeEachTurn', 'searchRule', 'abilityDiscount', 'manaBoost', 'tokenMana', 'untapRule', 'upkeepCost', 'damageMod', 'noPrevent', 'lifeRule', 'deathExile', 'shuffleInstead', 'triggerDoubler', 'copyOpponentEtb', 'nabArtifacts', 'stolenDrain', 'tokenReplace', 'copyDoubler', 'givenAway', 'handSize', 'combatRule', 'goadPunish', 'playerProtection', 'oppAnthem', 'oppEnterTapped', 'commanderKeywords', 'creatureTypes', ...EMBLEM_STATIC_KINDS, ...LOCK_STATIC_KINDS, 'playerHexproof', 'damagedPunish', 'bountyDestroy', 'proliferateTwice'];
  // "You may play an additional land on each of your turns" is static; a one-off extra land drop is not.
  if (effect.kind === 'extraLand' && ctx.when === 'static') {
    card.effects.push(effect);
    card.notes.push('Extra land drop every turn');
    return;
  }
  // Flash grants are static on a permanent (Vedalken Orrery) and last a while from a spell or loyalty ability (Borne Upon a Wind, Teferi).
  if (ctx.when === 'static' && effect.kind === 'flashGrant') {
    card.effects.push(effect);
    card.notes.push(f.note);
    return;
  }
  if (ctx.when === 'static' && !staticKinds.includes(effect.kind)) return;
  if (staticKinds.includes(effect.kind) && ctx.when !== 'static' && ctx.when !== 'resolve') return;
  if (staticKinds.includes(effect.kind)) effect.when = 'static';
  card.effects.push(effect);
  // A second effect read from the same sentence ("can't attack or block") shares the first one's note.
  if (!f.note) return;
  let note = describeTrigger(ctx) + f.note;
  if (effect.minRoll) note += ` (on a ${effect.minRoll}+)`;
  else if (chance) note += ` (conditional, ~${Math.round(chance * 100)}%)`;
  if (ctx.oncePerTurn) note += ' (once per turn)';
  if (ctx.ofType) note += ` (${ctx.ofType === 'chosen' ? 'the chosen creature type' : `${ctx.ofType}s`} only)`;
  if (ctx.nth) note += ` (${['first', 'second', 'third'][ctx.nth - 1]} ${ctx.when === 'opponentDraw' ? 'card' : 'spell'} ${ctx.turn === 'own' ? 'during their own turn' : ctx.turn === 'others' ? "during an opponent's turn" : 'each turn'})`;
  card.notes.push(note);
}

function describeTrigger(ctx: LineContext): string {
  switch (ctx.when) {
    case 'upkeep': return 'Each turn: ';
    case 'attack': return 'On attack: ';
    case 'combatDamage': return 'On combat damage: ';
    case 'cast': return `On casting ${ctx.castFilter === 'any' ? 'a spell' : ctx.castFilter === 'mutate' ? 'spells with mutate' : ctx.castFilter + ' spells'}${ctx.minCmc ? ` (MV ${ctx.minCmc}+)` : ''}: `;
    case 'creatureEnters': return 'When a creature enters: ';
    case 'creatureDies': return ctx.scope === 'self' ? 'When it dies: ' : ctx.scope === 'attached' ? 'When the creature wearing it dies: ' : ctx.scope === 'all' ? 'When any creature dies: ' : ctx.scope === 'opponents' ? "When an opponent's creature dies: " : 'When a creature dies: ';
    case 'landfall': return 'Landfall: ';
    case 'opponentCast': return `When an opponent casts ${ctx.castFilter === 'any' ? 'a spell' : `${ctx.castFilter} spells`}: `;
    case 'opponentDraw': return 'When an opponent draws: ';
    case 'opponentDiscard': return 'When an opponent discards: ';
    case 'discard': return 'When you discard: ';
    case 'opponentLoseLife': return 'When an opponent loses life: ';
    case 'leaves': return ctx.scope === 'self' ? (ctx.zones ? 'When it dies or is exiled: ' : 'When it leaves the battlefield: ') : 'When a token of yours leaves the battlefield: ';
    case 'opponentActivate': return 'When an opponent activates an ability: ';
    case 'playerAttacks': return ctx.minAttackers ? `When a player attacks with ${ctx.minAttackers}+ creatures: ` : ctx.scope === 'opponents' ? 'When an opponent attacks another opponent: ' : 'When a player attacks your opponents: ';
    case 'playerSacrifice': return ctx.scope === 'opponents' ? 'When an opponent sacrifices: ' : 'When a player sacrifices: ';
    case 'opponentCrime': return 'When an opponent commits a crime: ';
    case 'opponentSacrifice': return ctx.scope === 'all' ? 'When an opponent sacrifices or discards a permanent card: ' : 'When an opponent sacrifices a nontoken permanent: ';
    case 'ringTempts': return 'When the Ring tempts you: ';
    case 'lore': return 'When you add a lore counter to a Saga: ';
    case 'sacrifice': return 'When you sacrifice: ';
    case 'draw': return 'When you draw: ';
    case 'permEnters': return `When an ${ctx.castFilter} enters under your control: `;
    case 'gainLife': return 'When you gain life: ';
    case 'milled': return ctx.scope === 'self' ? 'When you mill: ' : ctx.scope === 'all' ? 'When a player mills: ' : 'When an opponent mills: ';
    case 'activated': return 'Activated: ';
    case 'surveil': return 'When you surveil: ';
    case 'countered': return 'When you counter a spell: ';
    case 'dieRoll': return 'When you roll a die: ';
    case 'opponentMonarch': return 'When an opponent becomes the monarch: ';
    case 'loyalty': return ctx.loyaltyX ? '-X: ' : `${(ctx.loyalty ?? 0) > 0 ? '+' : ''}${ctx.loyalty}: `;
    case 'chapter': return `Chapter ${(ctx.chapters ?? []).map((c) => ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][c]).join(', ')}: `;
    case 'mutates': return ctx.scope === 'any' ? 'When a creature you control mutates: ' : 'When it mutates: ';
    case 'turnedFaceUp': return 'When it is turned face up: ';
    case 'targeted': return `When ${ctx.scope === 'self' ? 'it' : ctx.castFilter === 'creature' ? 'a creature you control' : 'a permanent you control'} becomes the target of ${ctx.targetedBy === 'you' ? 'your' : ctx.targetedBy === 'opponents' ? "an opponent's" : 'a'} spell${ctx.spellOnly ? '' : ' or ability'}: `;
    case 'eachUpkeep': return 'Each upkeep: ';
    case 'hourTwelve': return 'At the twelfth hour counter: ';
    case 'blocked': return ctx.scope === 'self' ? 'When it becomes blocked: ' : 'When a creature you control becomes blocked: ';
    case 'unblocked': return 'When it attacks and isn\'t blocked: ';
    case 'opponentSearch': return 'When an opponent searches their library: ';
    case 'proliferate': return 'When you proliferate: ';
    case 'countersPut': return ctx.scope === 'self' ? 'When it gets +1/+1 counters: ' : 'When your creatures get +1/+1 counters: ';
    case 'crewed': return 'When it becomes crewed: ';
    case 'unlock': return 'When this door unlocks: ';
    case 'fullyUnlock': return 'When you fully unlock a Room: ';
    case 'sacrificeFood': return 'When you sacrifice a Food: ';
    case 'postcombatMain': return 'Each postcombat main phase: ';
    case 'opponentCreatureEnters': return "When an opponent's creature enters: ";
    case 'permDies': return `When ${ctx.scope === 'all' ? 'an' : 'your'} ${ctx.castFilter ?? 'artifact'} goes to a graveyard: `;
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
    const repeating = e.when !== 'resolve' && e.when !== 'chapter' && e.when !== 'mutates';
    const mult = repeating ? 2.5 : 1;
    switch (e.kind) {
      case 'ramp': v += 2.5 * Math.max(e.lands, 1) + e.toHand; break;
      case 'mana': v += 2.5 * (e.count || e.fromCounters ? 2 : e.corrupted || e.sacArtifact ? 1 : e.amount); break;
      case 'costReduction': v += 2 * e.amount; break;
      case 'oppAnthem': v -= 4 * (e.p + e.t); break;
      case 'oppEnterTapped': v += 2; break;
      case 'draw': v += 1.5 * Math.max(e.n, 2) * mult; break;
      case 'removal': v += 3 * mult; break;
      case 'wipe': v += 4; break;
      case 'counter': v += 2.5; break;
      case 'tokens': v += Math.max(e.n, 2) * (e.power + e.toughness) * 0.4 * mult; break;
      case 'anthem': v += 3 * (e.p + e.t); break;
      case 'overrun': v += 3 + e.p; break;
      case 'pump': v += 1; break;
      case 'equip': v += e.lock ? 4 : e.steal ? 6 : 1 + e.p + e.keywords.length; break;
      case 'protect': v += 1.5; break;
      case 'drain': v += xOr3(e.n) * 1.5 * mult; break;
      case 'damagePlayer': v += xOr3(e.n) * 0.5 * mult; break;
      case 'gainLife': v += 0.2 * xOr3(e.n); break;
      case 'loseLife': v -= 0.1 * e.n; break;
      case 'tutor': v += 3; break;
      case 'recursion': v += 2 * e.n * (e.all ? 1.5 : 1); break;
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
      case 'goad': v += (e.all ? 4 : 1.5) * (e.when === 'static' ? 1.5 : mult); break;
      case 'blink': v += 1.5 * Math.min(e.n, 2) * mult; break;
      case 'untap': v += (e.what === 'lands' ? Math.min(e.n, 6) : e.what === 'nonland' ? 4 : e.what === 'self' ? 0 : 1) * (e.when === 'activated' ? 0.5 : mult); break;
      case 'untapAlways': v += e.what === 'self' ? 1 : 3; break;
      case 'copySpell': v += 2.5 * mult; break;
      case 'experience': v += 1; break;
      case 'stun': v += 0.5 * mult; break;
      case 'ringTempts': v += 1.5 * mult; break;
      case 'lore': v += 1; break;
      case 'blight': v += 1 * mult; break;
      case 'colorlessBoost': v += 3; break;
      case 'animate': v += 2; break;
      case 'ringProtection': case 'copyOnDiscard': case 'shuffleWhenTargeted': v += 0.5; break;
      case 'foodCreatures': v += 1.5; break;
      case 'returnCurses': v += 2; break;
      case 'passCurse': v += 1.5 * e.n * mult; break;
      case 'drawRule': v += e.rule === 'limit' ? 2 : 4; break;
      case 'lifeLossMill': v += 2; break;
      case 'bounty': v += 1.5; break;
      case 'extraCombat': v += 3 + 2 * e.n; break;
      case 'poison': v += e.n * (e.who === 'each' ? 0.3 : 1) * mult; break;
      case 'kwCounter': v += 1.5; break;
      case 'bountyPayout': case 'bountyOnTarget': v += 1.5; break;
      case 'damageBonus': v += e.double ? 4 : 3; break;
      case 'treasureBoost': v += 2; break;
      case 'loyaltyUp': v += 0.5 * mult; break;
      case 'doubleCounters': v += 2; break;
      case 'winGame': case 'loseGame': v += 4; break;
      case 'rollDice': v += 1.5; break;
      case 'selfKeyword': v += 1; break;
      case 'copyCreature': v += 3 * mult; break;
      case 'baseSize': v += 2; break;
      case 'enterCounters': v += 1.5; break;
      case 'manifest': v += e.who === 'targetController' ? -1 : 2 * mult; break;
      case 'abilityDiscount': v += 1.5 * e.amount; break;
      case 'manaBoost': v += e.what === 'swamps' || e.what === 'colorless' ? 3 : 4; break;
      case 'tokenMana': v += 2; break;
      case 'tap': v += 0.8 * mult; break;
      case 'tapAllies': v += 2; break;
      case 'untapRule': case 'upkeepCost': v += 0.5; break;
      case 'transform': v += card.back ? Math.max(0, card.back.value - v) * 0.5 : 0; break;
      case 'damageMod': v += e.op === 'times' ? 4 * (e.n - 1) : e.op === 'plus' ? 2 * e.n : 2; break;
      case 'lifeRule': case 'noPrevent': v += 1.5; break;
      case 'loseHalf': v += 3 * mult; break;
      case 'deathExile': v += e.keep ? 2 : 1; break;
      case 'reanimateExiled': v += e.all ? 4 : 2; break;
      case 'returnDied': case 'returnAs': v += 2; break;
      case 'triggerDoubler': v += 3; break;
      case 'copyOpponentEtb': v += 2; break;
      case 'preventNext': case 'deathShield': v += 1.5; break;
      case 'handSize': v += e.who === 'opponents' ? Math.min(4, -e.n) : 0; break;
      case 'attachSelf': break;
      default: v += controlValue(e, mult) ?? graveyardValue(e, mult) + exileValue(e, mult) + lockValue(e, mult);
    }
  }
  for (const c of card.curse ?? []) v += c.act === 'unbinding' || c.act === 'cruel' || c.act === 'double' ? 5 : c.act === 'misfortunes' || c.act === 'obsessionDraw' ? 1 : 2.5;
  if (card.graveyard) v += card.graveyard.how === 'cast' ? v * 0.3 + 1 : 2;
  if (card.persist) v += 2;
  // Cascade: a free spell of lesser mana value for each instance.
  if (card.cascade) v += Math.min(card.cmc, 5) * 0.8 * card.cascade;
  for (const level of card.levels ?? []) for (const e of level.effects) v += e.kind === 'draw' ? 1.5 * e.n : 1;
  // Station: what the thresholds give, discounted for the creatures it takes to get there; a Spacecraft's body too.
  if (card.station) {
    for (const t of card.station.tiers) v += (t.effects.length * 1.5 + t.keywords.length * 0.5) * 0.6;
    if (card.station.creatureAt !== undefined) v += (card.power + card.toughness * 0.5) * 0.6;
  }
  return Math.max(v, card.cmc * 0.4);
}

function xOr3(n: number): number {
  return n === -1 ? 3 : n;
}
