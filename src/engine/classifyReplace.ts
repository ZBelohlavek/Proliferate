// Replacement effects, prevention, trigger doublers and "whenever an opponent ..." triggers
// for the card reader (rules 603.2d, 614, 615, 701.19).
//
// classify.ts calls in here at three points, like classifyRare.ts:
// - rewriteReplace(line) turns a wording into one the reader already knows, or into a
//   short private wording recogniseReplace reads ("return ~ as an enchantment").
// - replaceTrigger(line) reads trigger wordings classify.ts has no rule for.
// - recogniseReplace(sentence, ...) reads the effects, after the other recognisers.
//
// The engine side is in src/rules/game.ts ("Replacement and prevention effects").

import type { CastFilter, Color, EffectBody, Trigger, TriggerScope } from './types';

type Found = { body: EffectBody; note: string; chance?: number; thatPlayer?: boolean; noCounters?: boolean };
type ReplaceContext = { when: Trigger; scope?: TriggerScope; castFilter?: CastFilter; body: string; chance?: number; zones?: ('graveyard' | 'exile' | 'hand' | 'library')[]; minAttackers?: number; nth?: number; turn?: 'own' | 'others' };

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, x: -1 };
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w) ? parseInt(w, 10) : WORDS[w] ?? fallback);
const COLOR: Record<string, Color> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const cap = (w: string) => w[0].toUpperCase() + w.slice(1);

/** Rewrites a whole line (after ability words are stripped). */
export function rewriteReplace(l: string): string {
  return l
    // The Enduring cycle: "if it was a creature" always holds when it dies (as an enchantment it can't die).
    .replace(/^when ~ dies, if it was a creature, return it to the battlefield under its owner's control\. it's an enchantment\.?/, 'when ~ dies, return ~ as an enchantment.')
    // Unstoppable Slasher: the condition is checked by the engine as it dies.
    .replace(/^when ~ dies, if it had no counters on it, return it to the battlefield tapped under its owner's control with (\w+) stun counters on it\.?/, 'when ~ dies, return ~ stunned with $1 counters unless it had counters.')
    // Journey to Eternity: the creature, then the Aura itself as its land side.
    .replace(/^(when enchanted creature dies), return it to the battlefield under your control, then return ~ to the battlefield transformed under your control\.?/, '$1, return that card to the battlefield under your control. return ~ to the battlefield transformed under your control.')
    // Rapacious Guest, Ukkima: "equal to its power" is the X the engine passes.
    .replace(/target opponent loses life equal to its power/, 'target opponent loses x life')
    // Aurelia: "each of your opponents" is each opponent.
    .replace(/\beach of your opponents\b/g, 'each opponent')
    // Karazikar: both players draw and lose life.
    .replace(/you and the attacking player each draw a card and lose 1 life\.?$/, 'you draw a card. that player draws a card. that player loses 1 life. you lose 1 life.');
}

/** Trigger wordings classify.ts doesn't know. Returns null to let classify.ts carry on. */
export function replaceTrigger(l: string): ReplaceContext | null {
  let m: RegExpMatchArray | null;
  // Leaving the battlefield (x = the creature's power as it left).
  if ((m = l.match(/^when ~ dies or is put into exile(?: from the battlefield)?,\s*(.*)$/))) return { when: 'leaves', scope: 'self', zones: ['graveyard', 'exile'], body: m[1] };
  if ((m = l.match(/^when ~ leaves the battlefield,\s*(.*)$/))) return { when: 'leaves', scope: 'self', body: m[1] };
  if ((m = l.match(/^whenever a token you control leaves the battlefield,\s*(.*)$/))) return { when: 'leaves', scope: 'any', body: m[1] };
  // Auras and Equipment that bring the creature back ("when", not only "whenever").
  if ((m = l.match(/^(?:when|whenever) (?:enchanted|equipped) (?:creature|permanent) dies(?: or is put into exile)?,\s*(.*)$/))) return { when: 'creatureDies', scope: 'attached', body: m[1] };
  // Luminous Broodmoth, Necroskitter.
  if ((m = l.match(/^whenever a creature you control without flying dies, return it to the battlefield under its owner's control with a flying counter on it\.?$/))) return { when: 'creatureDies', body: 'return that card to the battlefield with a flying counter if it had no flying' };
  if ((m = l.match(/^whenever a creature an opponent controls with a -1\/-1 counter on it dies, (?:you may )?return that card to the battlefield under your control\.?$/))) return { when: 'creatureDies', scope: 'opponents', body: 'return that card to the battlefield under your control if it had a -1/-1 counter' };
  // Aboleth Spawn and Firebender Ascension: copies of triggered abilities, read as statics.
  if (/^whenever a creature entering under an opponent's control causes a triggered ability of that creature to trigger, you may copy that ability/.test(l)) return { when: 'static', body: 'copy enters abilities of opponents creatures' };
  if (/^whenever a creature you control attacking causes a triggered ability of that creature to trigger, put an? (?:quest|charge) counter on ~\. then if it has four or more (?:quest|charge) counters on it, you may copy that ability/.test(l)) return { when: 'static', body: 'attack triggers of your creatures trigger twice once ~ has four counters' };
  // Things opponents (or any player) do.
  if ((m = l.match(/^whenever an opponent activates an ability of an? [a-z, ]+?(?: on the battlefield)?(?:, if it isn't a mana ability| that isn't a mana ability),\s*(.*)$/))) return { when: 'opponentActivate', body: m[1] };
  if ((m = l.match(/^whenever an opponent attacks another one of your opponents,\s*(.*)$/))) return { when: 'playerAttacks', scope: 'opponents', body: m[1] };
  if ((m = l.match(/^whenever a player attacks one of your opponents,\s*(.*)$/))) return { when: 'playerAttacks', scope: 'any', body: m[1] };
  if ((m = l.match(/^whenever a player attacks with (\w+) or more creatures,\s*(.*)$/))) return { when: 'playerAttacks', scope: 'all', minAttackers: count(m[1], 3), body: m[2] };
  if ((m = l.match(/^whenever a player sacrifices a permanent,\s*(.*)$/))) return { when: 'playerSacrifice', scope: 'all', body: m[1] };
  // Bloodroot Apothecary: Treasures, Clues and Food are most of what opponents sacrifice that isn't a creature.
  if ((m = l.match(/^whenever an opponent sacrifices a noncreature token,\s*(.*)$/))) return { when: 'playerSacrifice', scope: 'opponents', body: m[1], chance: 0.5 };
  if ((m = l.match(/^whenever an opponent sacrifices (?:a|another) (?:nontoken )?permanent,\s*(.*)$/))) return { when: 'playerSacrifice', scope: 'opponents', body: m[1] };
  if ((m = l.match(/^whenever an opponent commits a crime,\s*(.*)$/))) return { when: 'opponentCrime', body: m[1] };
  // Sewer Nemesis: one chosen opponent, about a third of opponents' spells at a four-player table.
  if ((m = l.match(/^whenever the chosen player casts a spell,\s*(.*)$/))) return { when: 'opponentCast', castFilter: 'any', body: m[1], chance: 0.35 };
  // The Council of Four: drawing a second card on their own turn.
  if ((m = l.match(/^whenever a player draws their second card during their turn,\s*(.*)$/))) return { when: 'opponentDraw', body: m[1], nth: 2 };
  return null;
}

/** Reads replacement, prevention and "that player" effects in a sentence. Runs after the other recognisers. */
export function recogniseReplace(line: string, out: Found[], fullLine: string) {
  let m: RegExpMatchArray | null;
  // Lines read here replace whatever a looser recogniser found in them.
  const only = (body: EffectBody, note: string, extra: Partial<Found> = {}) => out.splice(0, out.length, { body, note, ...extra });

  // --- Damage replacement (rule 614.1a) ------------------------------------------
  const src = line.match(/^(?:(?:revolt — )?as long as a permanent left the battlefield under your control this turn, )?if (a|another) ((?:red |white |blue |black |green )?source|[a-z, ]+?|creature) you control( with a \+1\/\+1 counter on it)? would deal (noncombat )?damage to (an opponent or a permanent an opponent controls|a permanent or player), (?:it|that source) deals (double|triple|that much damage plus (\w+)) (?:that damage )?(?:to that permanent or player )?instead/);
  if (src) {
    const color = src[2].match(/^(red|white|blue|black|green) source$/);
    const tribal = !/source|^creature$/.test(src[2]) ? src[2].replace(/,? or /g, ', ').split(/, /).map((t) => cap(t.trim())) : undefined;
    const op = src[6] === 'double' || src[6] === 'triple' ? 'times' as const : 'plus' as const;
    const n = src[6] === 'double' ? 2 : src[6] === 'triple' ? 3 : count(src[7], 1);
    const revolt = /^(revolt — )?as long as a permanent left/.test(line);
    only({
      kind: 'damageMod', op, n, from: src[1] === 'another' ? 'otherYours' : 'yours', to: src[5] === 'a permanent or player' ? 'any' : 'opponents',
      ...(color ? { color: COLOR[color[1]] } : {}), ...(src[4] ? { noncombat: true } : {}), ...(tribal ? { subtypes: tribal } : {}), ...(src[3] ? { withCounter: true } : {}), ...(revolt ? { revolt } : {}),
    }, `${src[3] ? 'Your creatures with +1/+1 counters deal' : tribal ? `Your ${tribal.join(', ')} deal` : `Your ${color ? `${color[1]} ` : ''}sources deal`} ${op === 'times' ? `${n === 2 ? 'double' : 'triple'}` : `${n} more`} ${src[4] ? 'noncombat ' : ''}damage${src[5] === 'a permanent or player' ? '' : ' to opponents and their permanents'}${revolt ? ' (revolt)' : ''}`);
    return;
  }
  // Gisela: any source, double to opponents.
  if (/^if a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage/.test(line)) {
    only({ kind: 'damageMod', op: 'times', n: 2, from: 'any', to: 'opponents' }, 'Damage to opponents and their permanents is doubled');
    return;
  }
  if (/^if a source would deal damage to you or a permanent you control, prevent half that damage, rounded up/.test(line)) {
    only({ kind: 'damageMod', op: 'preventHalf', n: 1, from: 'any', to: 'you' }, 'Half the damage to you and your permanents is prevented');
    return;
  }
  // Ojer Axonil.
  if (/^if a red source you control would deal an amount of noncombat damage less than ~'s power to an opponent, that source deals damage equal to ~'s power instead/.test(line)) {
    only({ kind: 'damageMod', op: 'toPower', n: 0, from: 'yours', to: 'opponentPlayers', color: 'R', noncombat: true }, "Your red sources' noncombat damage to opponents is at least its power");
    return;
  }
  // --- Prevention (rule 615) --------------------------------------------------------
  if (/^damage can't be prevented\.?$/.test(line)) return void only({ kind: 'noPrevent' }, "Damage can't be prevented");
  if (/^prevent all damage that would be dealt to attacking creatures you control/.test(line)) return void only({ kind: 'damageMod', op: 'prevent', n: 0, from: 'any', to: 'attackers' }, 'Damage to your attacking creatures is prevented');
  if (/^prevent all noncombat damage that would be dealt to other creatures you control/.test(line)) return void only({ kind: 'damageMod', op: 'prevent', n: 0, from: 'any', to: 'otherCreatures', noncombat: true }, 'Noncombat damage to your other creatures is prevented');
  if (/^if damage would be dealt to ~, prevent that damage/.test(line)) {
    const reflect = /when damage is prevented this way, ~ deals that much damage to any other target/.test(fullLine);
    return void only({ kind: 'damageMod', op: 'prevent', n: 0, from: 'any', to: 'self', ...(reflect ? { reflect } : {}) }, `Damage to it is prevented${reflect ? ' and dealt to another target instead' : ''}`);
  }
  if (/^when damage is prevented this way, ~ deals that much damage to any other target/.test(line)) return;
  if (/^the next time a source of your choice would deal damage to you this turn, prevent that damage\.( if damage is prevented this way, ~ deals that much damage to that source's controller)?/.test(line)) {
    const reflect = /that source's controller/.test(line);
    return void only({ kind: 'preventNext', reflect }, `Prevent the next damage one source deals to you this turn${reflect ? ', and deal it to its controller' : ''}`);
  }
  // --- Life gain (rule 614.1a) ------------------------------------------------------
  if (/^(players can't gain life|if a player would gain life, that player gains no life instead)/.test(line)) return void only({ kind: 'lifeRule', rule: 'noGain', who: 'all' }, "Players can't gain life");
  if (/^your opponents can't gain life/.test(line)) return void only({ kind: 'lifeRule', rule: 'noGain', who: 'opponents' }, "Your opponents can't gain life");
  if (/^if you would gain life, you gain twice that much life instead/.test(line)) return void only({ kind: 'lifeRule', rule: 'double', who: 'you' }, 'Life you gain is doubled');
  if (/^if an opponent would gain life, that player loses that much life instead/.test(line)) return void only({ kind: 'lifeRule', rule: 'lossInstead', who: 'opponents' }, 'Opponents lose life instead of gaining it');
  // --- "That player": whoever drew, cast, attacked or was hit ------------------------------
  if (/^(?:that player|they) loses? half (?:their|his or her) life, rounded up/.test(line)) return void only({ kind: 'loseHalf' }, 'That player loses half their life', { thatPlayer: true });
  if ((m = line.match(/^(?:that player|they|the attacking player) loses? (\w+) life\.?$/))) return void only({ kind: 'damagePlayer', n: count(m[1], 1), lifeLoss: true }, `That player loses ${count(m[1], 1)} life`, { thatPlayer: true });
  if ((m = line.match(/^(?:~|it) deals (\w+) damage to that player\.?$/))) return void only({ kind: 'damagePlayer', n: count(m[1], 1) }, `${count(m[1], 1)} damage to that player`, { thatPlayer: true });
  if (/^~ deals damage (?:equal to its power )?to that player(?: equal to [^.]*)?\.?$/.test(line)) return void only({ kind: 'damagePlayer', n: /noncreature spells/.test(line) ? -1 : 2 }, /noncreature spells/.test(line) ? 'Damage to that player for each spell they cast this turn (≈ all spells)' : 'Damage equal to its power to that player (≈ 2)', { thatPlayer: true });
  if ((m = line.match(/^(?:that player|they|that attacking player|the attacking player) draws? (\w+) cards?/))) {
    const rest = out.filter((f) => f.body.kind !== 'draw');
    out.splice(0, out.length, ...rest, { body: { kind: 'draw', n: count(m[1], 1) }, note: `That player draws ${count(m[1], 1)}`, thatPlayer: true });
    return;
  }
  if ((m = line.match(/^that player mills (\w+) cards?/))) return void only({ kind: 'mill', n: count(m[1], 1), who: 'target' }, `That player mills ${count(m[1], 1)}`, { thatPlayer: true });
  if ((m = line.match(/^that player gets (\w+) poison counters?/))) return void only({ kind: 'poison', n: count(m[1], 1), who: 'target' }, `That player gets ${count(m[1], 1)} poison`, { thatPlayer: true });
  if (/^target opponent loses x life\.?$/.test(line)) return void only({ kind: 'damagePlayer', n: -1, lifeLoss: true }, 'Target opponent loses life equal to its power');
  // --- Death and leave-the-battlefield replacements --------------------------------------
  if (/^if a creature an opponent controls would die, exile it instead/.test(line)) return void only({ kind: 'deathExile', keep: true }, "Opponents' creatures are exiled instead of dying");
  if ((m = line.match(/^if a nontoken creature an opponent controls would die, instead exile it and you gain (\w+) life/))) return void only({ kind: 'deathExile', nontoken: true, gain: count(m[1], 2), keep: true }, `Opponents' nontoken creatures are exiled instead of dying, and you gain ${m[1]} life`);
  if (/^put all creature cards exiled with ~ onto the battlefield under your control/.test(line)) return void only({ kind: 'reanimateExiled', all: true }, 'Put every creature card exiled with it onto the battlefield (decayed)');
  if (/^they gain decayed\.?$/.test(line)) return;
  if ((m = line.match(/^put target creature card exiled with ~ onto the battlefield (tapped )?under your control(?: with (\w+) additional \+1\/\+1 counters? on it)?/))) {
    return void only({ kind: 'reanimateExiled', all: false, ...(m[1] ? { tapped: true } : {}), ...(m[2] ? { counters: count(m[2], 1) } : {}) }, 'Put a creature card exiled with it onto the battlefield');
  }
  if (/^if a permanent you control would be put into a graveyard from the battlefield this turn, exile it instead/.test(line)) return void only({ kind: 'deathShield' }, 'This turn your permanents are exiled instead of dying, and come back at the end step');
  if (/^if ~ would be put into a graveyard from anywhere, reveal ~ and shuffle it into its owner's library instead/.test(line)) return void only({ kind: 'shuffleInstead' }, "Shuffled into its owner's library instead of going to a graveyard");
  if ((m = line.match(/^return that card to the battlefield (?:under your control )?(?:with a (flying) counter if it had no flying|if it had a -1\/-1 counter)?\.?$/)) || (m = line.match(/^(?:you may )?return that card to the battlefield under your control( if it's a (\w+) card)?\.?$/))) {
    const subtype = m[2] && !m[1] ? cap(m[2]) : undefined;
    const filter = /no flying/.test(line) ? 'noFlying' as const : /-1\/-1 counter/.test(line) ? 'minusCounter' as const : undefined;
    return void only({ kind: 'returnDied', ...(filter === 'noFlying' ? { kw: 'flying' } : {}), ...(subtype ? { subtype } : {}), ...(filter ? { filter } : {}) }, `Returns the creature that died${filter === 'noFlying' ? ' with a flying counter' : ''}${subtype ? ` (${subtype}s only)` : ''}`);
  }
  if (/^return ~ as an enchantment\.?$/.test(line)) return void only({ kind: 'returnAs', as: 'enchantment' }, "Returns as an enchantment (not a creature)");
  if ((m = line.match(/^return ~ stunned with (\w+) counters unless it had counters\.?$/))) return void only({ kind: 'returnAs', as: 'stunned', n: count(m[1], 2) }, `Returns tapped with ${m[1]} stun counters, if it had no counters`, { noCounters: true });
  if (/^return (?:it|~) to the battlefield under its owner's control\.?$/.test(line)) return void only({ kind: 'returnAs', as: 'battlefield' }, 'Returns to the battlefield');
  if (/^return (?:it|~) to its owner's hand at the beginning of the next end step/.test(line)) return void only({ kind: 'returnAs', as: 'handAtEnd' }, 'Returns to its owner\'s hand at the next end step');
  if ((m = line.match(/^(?:you may )?put (?:it|~) (?:into its owner's library (third|second) from the top|on the bottom of its owner's library)/))) {
    const n = m[1] === 'third' ? 3 : m[1] === 'second' ? 2 : 0;
    return void only({ kind: 'returnAs', as: 'library', n }, n ? `Goes into its owner's library ${m[1]} from the top` : "Goes on the bottom of its owner's library");
  }
  // --- Trigger doublers (rule 603.2d) ------------------------------------------------
  if ((m = line.match(/^if a triggered ability of (.*?) (?:you control )?triggers, (?:that ability|it) triggers an additional time/))) {
    const who = m[1];
    let found: EffectBody | null = null;
    let note = '';
    if ((m = who.match(/^another creature you control of the chosen type$/))) { found = { kind: 'triggerDoubler', chosenType: true }; note = 'creatures of the chosen type'; }
    else if ((m = who.match(/^an? (\w+) or another (\w+)(?: you control)?$/))) { found = { kind: 'triggerDoubler', subtypes: [cap(m[1]), cap(m[2])], other: true }; note = `${m[1]}s and other ${m[2]}s`; }
    else if (/^a legendary creature( you control)?$/.test(who)) { found = { kind: 'triggerDoubler', legendary: true }; note = 'legendary creatures'; }
    else if (/^a colorless spell you control or another colorless permanent( you control)?$/.test(who)) { found = { kind: 'triggerDoubler', colorless: true }; note = 'other colorless permanents'; }
    else if ((m = who.match(/^a creature you control with power (\d+) or less$/))) { found = { kind: 'triggerDoubler', maxPower: parseInt(m[1], 10) }; note = `creatures with power ${m[1]} or less`; }
    if (found) return void only(found, `Abilities of your ${note} trigger an additional time`);
  }
  if (/^copy enters abilities of opponents creatures$/.test(line)) return void only({ kind: 'copyOpponentEtb' }, "Copies the enters abilities of opponents' creatures");
  if (/^attack triggers of your creatures trigger twice once ~ has four counters$/.test(line)) {
    only({ kind: 'triggerDoubler', attack: true, charged: 4 }, "A counter each time an attacking creature's ability triggers; from four on, those abilities trigger twice");
  }
}
