// Gaining control, copies, token replacement and changing targets, for the card reader.
//
// classify.ts calls in here:
// - controlTrigger(line) for trigger wordings classify.ts has no rule for
//   (an opponent sacrificing, "when enchanted creature dies", Treasure Nabber's static).
// - recogniseControl(sentence, fullLine, card) first on every sentence. When it
//   returns a list, that list is what the sentence does and nothing else reads it,
//   so "untap that creature. it gains haste" after a steal isn't read again as a
//   pump of the card's own creature.
// - controlValue(effect, mult) for how much each effect is worth to the bot.
//
// The engine side is in src/rules/game.ts (search for "Control, copies").

import type { CastFilter, CopyFilter, EffectBody, Trigger, TriggerScope } from './types';

type Found = { body: EffectBody; note: string; chance?: number };
type ControlContext = { when: Trigger; scope?: TriggerScope; castFilter?: CastFilter; body: string; chance?: number; oncePerTurn?: boolean; nontoken?: boolean };

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, x: -1, 'that many': -1 };
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w) ? parseInt(w, 10) : WORDS[w] ?? fallback);

const KEYWORDS = ['flying', 'haste', 'trample', 'menace', 'vigilance', 'lifelink', 'deathtouch', 'first strike', 'double strike', 'indestructible', 'hexproof'];

/** Trigger wordings for the abilities in this file. */
export function controlTrigger(l: string): ControlContext | null {
  let m: RegExpMatchArray | null;
  // Tergrid, It That Betrays: the card an opponent sacrificed (or discarded) comes to you.
  if ((m = l.match(/^whenever an opponent sacrifices a nontoken permanent( or discards a permanent card)?,\s*(.*)$/))) return { when: 'opponentSacrifice', ...(m[1] ? { scope: 'all' as const } : {}), body: m[2] };
  // Auras and Equipment that bring the creature back under your control (Minion's Return, Kaya's Ghostform, Oathkeeper).
  if ((m = l.match(/^(?:when|whenever) (?:enchanted|equipped) (?:creature|permanent) dies(?: or is put into exile)?,\s*(.*)$/))) return { when: 'creatureDies', scope: 'attached', body: m[1] };
  // Necroskitter: an opponent's creature with a -1/-1 counter on it.
  if ((m = l.match(/^whenever a creature an opponent controls with a -1\/-1 counter on it dies,\s*(.*)$/))) return { when: 'creatureDies', scope: 'opponents', body: `${m[1].replace(/\.$/, '')} (shrunk)` };
  // Read whole by recogniseControl.
  if (/^whenever an opponent taps an artifact for mana, gain control of that artifact|^whenever a nonland permanent an opponent owns enters the battlefield under your control|^if (?:you would create|one or more tokens would be created)|^the first time you would create one or more tokens each turn|^if you would copy a spell one or more times|^~ enters under the control of an opponent of your choice/.test(l)) return { when: 'static', body: l };
  // Vesuvan Duplimancy, Orvar: the spell's target is what gets copied.
  if ((m = l.match(/^whenever you cast (?:a|an) (instant or sorcery )?spell(?:, if it targets one or more other permanents you control| that targets only a single artifact or creature you control),\s*(.*)$/))) return { when: 'cast', castFilter: m[1] ? 'instantSorcery' : 'any', body: m[2] };
  // Jin-Gitaxias: "an artifact, instant, or sorcery spell" (the commas trip the general cast rule).
  if ((m = l.match(/^whenever (you|an opponent) casts? an artifact, instant, or sorcery spell,\s*(.*)$/))) return { when: m[1] === 'you' ? 'cast' : 'opponentCast', castFilter: 'artifactInstantSorcery', body: m[2] };
  // Ivy: copies of spells aimed at a single creature, retargeted at Ivy.
  if ((m = l.match(/^whenever (you|an opponent) casts? a spell that targets only a single creature other than (?:~|\w+),\s*(.*)$/))) return { when: m[1] === 'you' ? 'cast' : 'opponentCast', castFilter: 'any', body: 'copy that spell to ~' };
  return null;
}

/** "Target nonlegendary creature you control", "another target attacking creature", "target artifact or enchantment you control". */
function copyFilter(phrase: string): CopyFilter | null {
  const m = phrase.match(/^(another |other )?target ((?:non\w+ |nontoken |attacking )*)(artifact creature|(?:artifact|creature|enchantment)(?: (?:or|and\/or) (?:artifact|creature|enchantment))*|permanent)( (?:you control|that's attacking[^.,]*))?/);
  if (!m) return null;
  const types = m[3] === 'permanent' ? ['creature', 'artifact', 'enchantment'] as const : m[3].split(/ (?:or|and\/or) | /).filter((t) => t === 'artifact' || t === 'creature' || t === 'enchantment') as ('creature' | 'artifact' | 'enchantment')[];
  return {
    types: [...types],
    ...(m[4] === ' you control' ? { yours: true } : {}),
    ...(m[1] ? { other: true } : {}),
    ...(/nonlegendary/.test(m[2]) ? { nonlegendary: true } : {}),
    ...(/nontoken/.test(m[2]) ? { nontoken: true } : {}),
    ...(/attacking/.test(m[2]) || /attacking/.test(m[4] ?? '') ? { attacking: true } : {}),
    ...(m[3] === 'artifact creature' ? { both: true } : {}),
  };
}

function describeFilter(f: CopyFilter | undefined): string {
  if (!f) return 'it';
  return `${f.other ? 'another ' : ''}${f.nonlegendary ? 'nonlegendary ' : ''}${f.nontoken ? 'nontoken ' : ''}${f.attacking ? 'attacking ' : ''}${f.types.join(f.both ? ' ' : ' or ')}${f.yours ? ' you control' : ''}`;
}

/** The "except ..." changes of a token copy, read from the sentence and the ones after it. */
function copyChanges(line: string, fullLine: string) {
  const rest = fullLine.slice(Math.max(0, fullLine.indexOf(line)));
  const except = rest.match(/except ([^.]*)\./)?.[1] ?? '';
  const pt = except.match(/(?:is|it's|it is) (?:a )?(\d+)\/(\d+)/);
  const kws = KEYWORDS.filter((k) => new RegExp(`(?:has|gains|have)[^.]*\\b${k}\\b`).test(except) || new RegExp(`(?:that token|the tokens?|it) gains? [^.]*\\b${k}\\b`).test(rest));
  return {
    ...(/(?:isn't|it's not|is not|aren't) legendary/.test(except) ? { nonlegendary: true } : {}),
    ...(/it's legendary/.test(except) ? { legendary: true } : {}),
    ...(kws.includes('haste') ? { haste: true } : {}),
    ...(kws.includes('flying') ? { flying: true } : {}),
    ...(pt ? { pt: { p: parseInt(pt[1], 10), t: parseInt(pt[2], 10) } } : {}),
    ...(/it's an enchantment and loses all other card types/.test(except) ? { enchantment: true } : {}),
    ...(/(sacrifice|exile) (it|that token|those tokens|them) at the beginning of the next end step/.test(rest) ? { end: /exile (it|that token|those tokens|them) at the beginning/.test(rest) ? 'exile' as const : 'sacrifice' as const } : {}),
    ...(/(enters|enter|create a) tapped|tapped token/.test(rest) ? { tapped: true } : {}),
    ...(/tapped and attacking/.test(rest) ? { attacking: true } : {}),
  };
}

/**
 * Reads one sentence. Returns what it does when the sentence is one of the wordings in this file
 * (an empty list when it is only part of one, like "untap that creature" after a steal), else null.
 */
export function recogniseControl(line: string, fullLine: string, _card: { isPermanent: boolean; isCreature: boolean }): Found[] | null {
  let m: RegExpMatchArray | null;
  const out: Found[] = [];
  const push = (body: EffectBody, note: string, chance?: number) => {
    out.push({ body, note, ...(chance !== undefined ? { chance } : {}) });
    return out;
  };

  // --- Gaining control ----------------------------------------------------------
  // Threaten effects: "gain control of target creature until end of turn. Untap that creature. It gains haste until end of turn."
  const threaten = /gain control of (target|that) (creature|artifact or creature|permanent)[^.]*until end of turn/.test(fullLine);
  if (threaten && /^(?:untap (?:that creature|it)\.?|(?:it|that creature) gains haste until end of turn\.?|until end of turn, it has base power and toughness [^.]*|choose target creature\.?)$/.test(line)) return out;
  if ((m = line.match(/^(?:if [^,]*, )?gain control of (target|that) (creature|artifact or creature|permanent)( with mana value (x|\d+) or less)? until end of turn/))) {
    const untap = /untap (that creature|it)\b/.test(fullLine);
    const haste = /gains? (?:[a-z0-9, ]*and )?haste/.test(fullLine);
    const base = fullLine.match(/base power and toughness (\d+)\/(\d+) and gains ([a-z0-9, ]*?)(?:,)? and haste/);
    const small = line.match(/^if that creature's power is (\d+) or less or if you control another (\w+), /);
    const what = m[2] === 'permanent' ? 'permanent' as const : undefined;
    const maxCmc = m[4] === 'x' ? -1 : m[4] ? parseInt(m[4], 10) : undefined;
    return push({
      kind: 'steal', from: 'battlefield', until: 'eot', ...(what ? { what } : {}), ...(maxCmc !== undefined ? { maxCmc } : {}), ...(untap ? { untap } : {}), ...(haste ? { haste } : {}),
      ...(small ? { maxPower: parseInt(small[1], 10), orSubtype: small[2].replace(/^./, (c) => c.toUpperCase()) } : {}),
      ...(base ? { base: { p: parseInt(base[1], 10), t: parseInt(base[2], 10), keywords: base[3].split(/,\s*|\s+and\s+/).map((k) => k.replace(/ \d+$/, '').trim()).filter((k) => KEYWORDS.includes(k)) } } : {}),
    }, `Take ${what ? 'a permanent' : 'a creature'}${small ? ` (power ${small[1]} or less, or any with another ${small[2]})` : ''}${maxCmc === -1 ? ' with mana value X or less' : ''} until end of turn${untap ? ', untapped' : ''}${haste ? ', with haste' : ''}${base ? ` as a ${base[1]}/${base[2]}` : ''}`);
  }
  // Blue Sun's Twilight: a lasting steal with an X limit (a token copy follows when X is 5 or more).
  if ((m = line.match(/^gain control of target creature with mana value (x|\d+) or less\.?$/))) {
    const maxCmc = m[1] === 'x' ? -1 : parseInt(m[1], 10);
    return push({ kind: 'steal', from: 'battlefield', maxCmc }, `Take control of a creature with mana value ${m[1] === 'x' ? 'X' : m[1]} or less`);
  }
  if (/^gain control of all artifacts that player controls/.test(line)) return push({ kind: 'steal', from: 'battlefield', all: 'artifacts' }, 'Take every artifact of the player it hit');
  if (/^gain control of target noncreature artifact/.test(line)) return push({ kind: 'steal', from: 'battlefield', what: 'noncreatureArtifact' }, 'Take control of a noncreature artifact');
  if (/^whenever an opponent taps an artifact for mana, gain control of that artifact until the end of your next turn/.test(line)) return push({ kind: 'nabArtifacts' }, "Takes each artifact an opponent taps for mana, until the end of your next turn");
  if (/^whenever a nonland permanent an opponent owns enters the battlefield under your control, they lose life equal to its mana value/.test(line)) return push({ kind: 'stolenDrain' }, "Opponents lose life equal to the mana value of their permanents you take");
  if (/^~ enters under the control of an opponent of your choice/.test(line)) return push({ kind: 'givenAway' }, 'Enters under an opponent\'s control and attacks the others each combat');
  if (/^search target opponent's library for an artifact card and put that card onto the battlefield under your control/.test(line)) return push({ kind: 'steal', from: 'library', what: 'artifact' }, "Take the best artifact from an opponent's library");
  if (/^then that player shuffles\.?$/.test(line) && /search target opponent's library/.test(fullLine)) return out;
  if (/^target opponent reveals their hand\. you may put a creature card from it onto the battlefield under your control/.test(fullLine)) {
    if (/^target opponent reveals their hand/.test(line)) return push({ kind: 'steal', from: 'hand', haste: true, ...(/sacrifice it at the beginning of the next end step/.test(fullLine) ? { sacAtEnd: true } : {}) }, "Put the best creature from an opponent's hand onto the battlefield under your control, with haste, until the end step");
    return out;
  }
  if (/^put target legendary permanent card not named ~ from a graveyard onto the battlefield under your control/.test(line)) return push({ kind: 'recursion', n: 1, toBattlefield: true, what: 'legendary', from: 'any' }, 'Put a legendary permanent card from any graveyard onto the battlefield under your control');
  // "Return that card to the battlefield under your control": the card the trigger is about.
  if ((m = line.match(/^(?:you may )?(?:return|put) (?:that card|it) (?:from a graveyard )?(?:to|onto) the battlefield under your control( if it's a samurai card)?( \(shrunk\))?\.?$/))) {
    const samurai = !!m[1];
    const shrunk = !!m[2];
    return push({ kind: 'takeCard', ...(samurai ? { samurai } : {}), ...(shrunk ? { shrunk } : {}) }, `It comes back under your control${samurai ? ' (Samurai only)' : ''}`);
  }
  if (/^return it to the battlefield under your control, then return ~ to the battlefield transformed under your control/.test(line)) return push({ kind: 'takeCard' }, 'It comes back under your control');

  // --- Token replacement (rule 614.1a) ----------------------------------------------------
  if (/^if you would create a clue, food, or treasure token, instead create one of each/.test(line)) return push({ kind: 'tokenReplace', add: 'oneOfEach' }, 'A Clue, Food or Treasure you make becomes one of each');
  if (/^if you would create one or more treasure tokens, instead create those tokens plus an additional treasure token/.test(line)) return push({ kind: 'tokenReplace', add: 'treasure' }, 'One more Treasure each time you make Treasures');
  if (/^if one or more tokens would be created under your control, those tokens plus that many 1\/1 green squirrel creature tokens are created instead/.test(line)) return push({ kind: 'tokenReplace', add: 'squirrels' }, 'That many 1/1 Squirrels too whenever you make tokens');
  if (/^if one or more tokens would be created under your control, those tokens plus an additional food token are created instead/.test(line)) return push({ kind: 'tokenReplace', add: 'food' }, 'A Food too whenever you make tokens');
  if (/^the first time you would create one or more tokens each turn, you may instead create that many tokens that are copies of enchanted permanent/.test(line)) return push({ kind: 'tokenReplace', add: 'copies' }, 'The first tokens each turn are copies of the enchanted permanent');

  // --- Copies of spells ---------------------------------------------------------------
  if (/^if you would copy a spell one or more times, instead copy it that many times plus an additional time/.test(line)) return push({ kind: 'copyDoubler' }, 'Each spell you copy is copied once more');
  if (/^(?:when you next cast|until end of turn, whenever you cast) /.test(line)) {
    if (/^when you next cast an instant or sorcery spell this turn, copy that spell/.test(line)) return push({ kind: 'copyNext', until: 'next' }, 'Copy the next instant or sorcery you cast this turn');
    if (/^until end of turn, whenever you cast a spell, copy it/.test(line)) return push({ kind: 'copyNext', until: 'turn' }, 'Copy every spell you cast this turn');
  }
  if (/^\+ \{\d+\} — copy target instant spell, sorcery spell, activated ability, or triggered ability/.test(line)) return push({ kind: 'copySpell', what: 'spell' }, 'Copy an instant or sorcery spell');
  if (/^copy target permanent spell you control/.test(line)) return push({ kind: 'copySpell', what: 'permanentSpell', yours: true }, 'Copy a permanent spell you control (it becomes a token)');
  if (/^copy target creature spell you control/.test(line)) {
    const nonlegendary = /isn't legendary/.test(line);
    return push({ kind: 'copySpell', what: 'creatureSpell', yours: true, ...(nonlegendary ? { nonlegendary } : {}) }, `Copy a creature spell you control (it becomes a token${nonlegendary ? ", not legendary" : ''})`);
  }
  // Wandering Archaic: "they may pay {2}. If they don't, you may copy that spell."
  if ((m = line.match(/^they may pay \{(\d+)\}\.?$/)) && /if they don't, you may copy that spell/.test(fullLine)) return push({ kind: 'copySpell', what: 'trigger', unlessPay: parseInt(m[1], 10) }, `Copy it unless they pay {${m[1]}}`);
  if (/^if they don't, you may copy that spell/.test(line)) return out;
  // Ivy: "you may copy that spell. The copy targets Ivy." (controlTrigger rewrites the body).
  if (/^copy that spell to ~$/.test(line)) return push({ kind: 'copySpell', what: 'trigger', toSource: true }, 'Copy a spell aimed at one creature, aimed at itself instead');
  // Jin-Gitaxias: "whenever an opponent casts ..., counter that spell".
  if (/^counter that spell\.?$/.test(line)) return push({ kind: 'counter', target: 'any', subject: true }, 'Counter that spell');
  // Taigam: "copy it, then exile the spell you cast with four time counters on it" (the suspend half is left out).
  if (/^copy it, then exile the spell you cast/.test(line)) return push({ kind: 'copySpell', what: 'trigger' }, 'Copy that spell (its suspend half is left out)');

  // --- Changing targets (rule 115.7) -------------------------------------------------------
  if ((m = line.match(/^(?:\+ \{\d+\} — )?(?:you may )?(?:change (?:a|the) target of|choose new targets for) target (instant or sorcery spell|spell or ability|spell|activated or triggered ability|spell, activated ability, or triggered ability)(?: with (?:a single|one or more) targets?)?(?: to ~)?/))) {
    const self = /to ~\.?$/.test(line);
    const spells = m[1] === 'instant or sorcery spell' ? 'instantSorcery' as const : 'any' as const;
    const abilities = /ability/.test(m[1]);
    const damage = /(?:deals damage to you|you lose life) equal to that spell's mana value/.test(fullLine);
    return push({ kind: 'redirect', to: self ? 'self' : 'choose', spells, ...(abilities ? { abilities } : {}), ...(damage ? { damage } : {}) }, self ? `Change the target of ${spells === 'instantSorcery' ? 'an instant or sorcery' : 'a spell or ability'} to itself` : `Change the target of ${abilities ? 'a spell or ability' : 'a spell'}${damage ? " (you take damage equal to its mana value)" : ''}`);
  }
  if (/^(?:~ deals damage to you|you lose life) equal to that spell's mana value/.test(line)) return out;
  // Wyll's Reversal: "choose target spell or ability with one or more targets. Roll a d20 ..."
  if (/^choose target spell or ability with one or more targets/.test(line)) return push({ kind: 'redirect', to: 'choose', spells: 'any', abilities: true }, 'Change the targets of a spell or ability (a 15+ also copies it)');
  if (/^roll a d20 and add the greatest power among creatures you control/.test(line) && /choose target spell or ability/.test(fullLine)) return out;

  // --- Becoming a copy (rule 707.2) -------------------------------------------------------
  if ((m = line.match(/^(?:you may have )?~ becomes? a copy of (another target creature you control|another target creature|target artifact, creature, enchantment, or land|target creature card in your graveyard with mana value x|that card)( until end of turn)?/))) {
    const of = m[1] === 'that card' ? 'subject' as const : /graveyard/.test(m[1]) ? 'graveyard' as const : 'target' as const;
    const filter: CopyFilter | undefined = of !== 'target' ? undefined : /artifact, creature/.test(m[1]) ? { types: ['artifact', 'creature', 'enchantment'], other: true } : { types: ['creature'], other: true, ...(/you control/.test(m[1]) ? { yours: true } : {}) };
    const untilEot = !!m[2];
    const keep = /it has this ability|and it has this ability|has this ability/.test(fullLine);
    const pump = fullLine.match(/each get \+(\d+)\/\+0 and gain haste/);
    const hexproof = /it has hexproof/.test(fullLine);
    const name = /except its name is ~/.test(fullLine);
    return push({ kind: 'becomeCopy', of, ...(name ? { name } : {}), ...(filter ? { filter } : {}), ...(untilEot ? { untilEot } : {}), ...(keep ? { keep } : {}), ...(pump ? { pump: parseInt(pump[1], 10) } : {}), ...(hexproof ? { hexproof } : {}) },
      `Becomes a copy of ${of === 'subject' ? 'that card' : of === 'graveyard' ? 'a creature card in your graveyard with mana value X' : describeFilter(filter)}${untilEot ? ' until end of turn' : ''}${keep ? ', keeping this ability' : ''}${pump ? ` (both get +${pump[1]}/+0 and haste)` : ''}`);
  }
  if (/^if you do, ~ and that creature each get \+\d+\/\+0 and gain haste/.test(line)) return out;
  if ((m = line.match(/^you may have ~ enter (tapped )?as a copy of (?:any|a) (enchantment|artifact|creature) on the battlefield/))) {
    const what = m[2] === 'creature' ? undefined : m[2] as 'enchantment' | 'artifact';
    // Phantasmal Image: "when this creature becomes the target of a spell or ability, sacrifice it".
    const fragile = /becomes the target of a spell or ability, sacrifice it/.test(fullLine);
    return push({ kind: 'clone', ...(what ? { what } : {}), ...(m[1] ? { tapped: true } : {}), ...(fragile ? { fragile } : {}) }, `Enters as a copy of the best ${m[2]} on the battlefield${m[1] ? ', tapped' : ''}`);
  }

  // --- Token copies (rules 111.10, 707.2) ----------------------------------------------------
  // The target of a token copy may be chosen in a sentence of its own ("Choose target artifact creature you control.").
  if (/^choose target [^.]*\.?$/.test(line) && /create (?:a|one) (?:tapped )?tokens? that's a copy of (?:it|that creature)/.test(fullLine)) return out;
  // Opponents get the copy (Wedding Ring, Life of the Party).
  if ((m = line.match(/^(?:if [^,]*, )?(target opponent|each opponent) creates? a token that's a copy of (?:it|~)/))) {
    const each = m[1] === 'each opponent';
    const goaded = /goaded for the rest of the game/.test(fullLine);
    return push({ kind: 'copySelf', n: 1, give: each ? 'each' : 'target', ...(goaded ? { goaded } : {}) }, `${each ? 'Each opponent gets' : 'An opponent gets'} a token copy of it${goaded ? ', goaded for good' : ''}`);
  }
  if (/^the tokens are goaded for the rest of the game/.test(line)) return out;
  if ((m = line.match(/^(?:(?:then )?if [^,]*, |\+ \{\d+\} — )?(?:you may )?(?:for each (token you control|creature chosen this way), )?create (a|an|one|two|three|that many) (tapped )?tokens? that(?:'s| are) (?:a )?cop(?:y|ies) of (.*?)(?:,|\.|$)/))) {
    const phrase = m[4].trim();
    if (phrase === '~') return null;
    const changes = copyChanges(line, fullLine);
    const n = count(m[2], 1);
    let of: 'target' | 'attached' | 'subject' | 'aimed' | 'tokens' = 'subject';
    let filter: CopyFilter | undefined;
    if (m[1] === 'token you control') of = 'tokens';
    // Vesuvan Duplimancy, Orvar: the permanent of yours the spell targets.
    else if (/^(that artifact or creature|one of those permanents)$/.test(phrase)) filter = { types: phrase === 'one of those permanents' ? ['creature', 'artifact', 'enchantment'] : ['artifact', 'creature'], yours: true };
    else if (/^(enchanted|equipped) /.test(phrase)) of = 'attached';
    else if ((filter = copyFilter(phrase) ?? undefined)) of = 'target';
    else {
      // "That creature", "it": a target chosen earlier in the ability, what the ability just took or returned, or what the trigger is about.
      const chosen = fullLine.match(/choose (target [^.]*?)(?: that doesn't have [^.]*)?\./);
      if (chosen && (filter = copyFilter(chosen[1].replace(/ that's attacking that player/, ' attacking').replace(/target nontoken creature attacking/, 'target nontoken attacking creature')) ?? undefined)) of = 'target';
      else if (/(gain control of|return) target/.test(fullLine)) of = 'aimed';
    }
    const minX = fullLine.match(/if x is (\d+) or more/);
    const chance = /if the gift was promised/.test(line) ? 0.5 : undefined;
    const what = of === 'tokens' ? 'each token you control' : of === 'attached' ? `the ${/equipped/.test(phrase) ? 'equipped' : 'enchanted'} permanent` : of === 'aimed' ? 'that creature' : of === 'subject' ? 'that permanent' : describeFilter(filter);
    const extras = [changes.nonlegendary ? "not legendary" : '', changes.legendary ? 'legendary' : '', changes.pt ? `${changes.pt.p}/${changes.pt.t}` : '', changes.flying ? 'flying' : '', changes.haste ? 'haste' : '', changes.enchantment ? 'an enchantment' : '', changes.attacking ? 'tapped and attacking' : changes.tapped ? 'tapped' : '', changes.end ? `${changes.end === 'exile' ? 'exiled' : 'sacrificed'} at the end step` : ''].filter(Boolean);
    return push({ kind: 'tokenCopy', n, of, ...(filter ? { filter } : {}), ...changes, ...(m[3] ? { tapped: true } : {}), ...(minX ? { minX: parseInt(minX[1], 10) } : {}) },
      `${n === 1 ? 'A token copy' : `${n === -1 ? 'That many' : n} token copies`} of ${what}${extras.length ? ` (${extras.join(', ')})` : ''}${minX ? ` if X is ${minX[1]} or more` : ''}`, chance);
  }
  if (/^(?:that token|the token|those tokens) (?:gains? haste|enters? tapped and attacking[^.]*)\.?$|^(?:sacrifice|exile) (?:it|that token|those tokens|them) at the beginning of the next end step\.?$/.test(line) && /cop(?:y|ies) of/.test(fullLine)) return out;
  if (/^if the token is an aura, untap ~, then scry 2/.test(line)) return out;
  return null;
}

/** Lines that need no effect of their own: Xantcha's attack rule is part of 'givenAway'. */
export function controlLineHandled(line: string): boolean {
  return /^~ attacks each combat if able and can't attack its owner/.test(line) || /^(?:1—14|15\+) \| you may choose new targets for that spell or ability/.test(line);
}

/** How much an effect from this file is worth to the bot (cardValue). undefined: not one of ours. */
export function controlValue(e: EffectBody, mult: number): number | undefined {
  switch (e.kind) {
    case 'tokenCopy': return (e.of === 'tokens' ? 5 : 3.5) * Math.max(e.n, 1) * (e.end ? 0.5 : 1) * mult;
    case 'becomeCopy': return e.untilEot ? 1.5 : 3;
    case 'takeCard': return 2.5 * mult;
    case 'nabArtifacts': return 2.5;
    case 'stolenDrain': return 1.5;
    case 'tokenReplace': return e.add === 'squirrels' ? 4 : e.add === 'oneOfEach' ? 3 : 2;
    case 'redirect': return 3;
    case 'copyNext': return e.until === 'turn' ? 5 : 2.5;
    case 'copyDoubler': return 2;
    case 'givenAway': return -2;
    default: return undefined;
  }
}
