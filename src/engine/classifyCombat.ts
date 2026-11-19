// Attack and block rules, protection and "hexproof from", and creature types,
// for the card reader.
//
// classify.ts calls in here:
// - protectionKeywords(part) for one keyword of a keyword line ("protection from
//   red and from green", "hexproof from each color"): the keywords the engine
//   checks (see Game.protections in rules/game.ts).
// - combatTrigger(line) for trigger wordings about blocking and attacking.
// - recogniseCombat(sentence, out, fullLine) on every sentence.
// - combatLineHandled(line) for lines that need no effect of their own.
// - tribeOf(word) to turn a plural creature type into the subtype it names.
//
// Protection keywords (rule 702.16): 'pro:W' (a color), 'pro:all' (everything),
// 'pro:instant' / 'pro:creature' / 'pro:artifact' ... (a card type), 'pro:multi',
// 'pro:mono', 'pro:mv<=3' / 'pro:mv>=4' (mana value), 'pro:sub:human' (a creature type).
// "Hexproof from" (rule 702.11d): 'hexfrom:W' (a color), 'hexfrom:ability'
// (activated and triggered abilities), 'hexfrom:artifact' ...

import type { CastFilter, EffectBody, Trigger, TriggerScope } from './types';

type Found = { body: EffectBody; note: string; chance?: number };
type CombatContext = { when: Trigger; scope?: TriggerScope; castFilter?: CastFilter; body: string; chance?: number };

const COLOR_WORDS: Record<string, string> = { white: 'W', blue: 'U', black: 'B', red: 'R', green: 'G' };
const TYPE_WORDS: Record<string, string> = { instants: 'instant', sorceries: 'sorcery', creatures: 'creature', artifacts: 'artifact', enchantments: 'enchantment', planeswalkers: 'planeswalker', lands: 'land' };
const NUMBER_WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
const n = (w: string) => (/^\d+$/.test(w) ? parseInt(w, 10) : NUMBER_WORDS[w] ?? 1);

/** "Elves" -> "elf", "Zombies" -> "zombie", "Inklings" -> "inkling". Null for words that aren't a creature type. */
export function tribeOf(word: string): string | null {
  const w = word.toLowerCase().trim();
  if (/^(creature|token|permanent|spell|card|land|artifact|enchantment|planeswalker|player|opponent|other|nontoken|attacking|blocking|tapped|untapped|legendary|historic|nonhuman|colorless|multicolored|white|blue|black|red|green|commander|it|they|that|those|all|each|you|your)s?$/.test(w)) return null;
  if (/^(elves|dwarves|wolves|werewolves)$/.test(w)) return w.replace(/ves$/, 'f');
  if (/^(merfolk|fish|sheep|elk|moonfolk|kithkin|treefolk|jellyfish|octopus)$/.test(w)) return w;
  if (w.endsWith('ies') && !/^(zombies|faeries|pixies|homunculies)$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(sses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s')) return w.slice(0, -1);
  return w;
}

function qualityOf(what: string, prefix: 'pro' | 'hexfrom'): string[] | null {
  const w = what.trim().replace(/\.$/, '');
  if (w === 'everything') return [`${prefix}:all`];
  if (/^(each|all) colors?$/.test(w)) return ['W', 'U', 'B', 'R', 'G'].map((c) => `${prefix}:${c}`);
  if (COLOR_WORDS[w]) return [`${prefix}:${COLOR_WORDS[w]}`];
  if (TYPE_WORDS[w]) return [`${prefix}:${TYPE_WORDS[w]}`];
  if (w === 'multicolored') return [`${prefix}:multi`];
  if (w === 'monocolored') return [`${prefix}:mono`];
  if (prefix === 'hexfrom' && /^activated and triggered abilities$|^abilities$/.test(w)) return ['hexfrom:ability'];
  let m = w.match(/^mana value (\d+) or (less|greater)$/);
  if (m) return [`${prefix}:mv${m[2] === 'less' ? '<=' : '>='}${m[1]}`];
  m = w.match(/^([a-z]+)$/);
  if (m && prefix === 'pro') {
    const tribe = tribeOf(m[1]);
    if (tribe) return [`pro:sub:${tribe}`];
  }
  return null;
}

/**
 * One part of a keyword line: "protection from red and from green", "hexproof from each color",
 * "protection from mana value 3 or less" (after an ability word). Null when it isn't one.
 */
export function protectionKeywords(part: string): string[] | null {
  const p = part.trim().replace(/^[a-z' ]+ — /, '').replace(/\.$/, '');
  const m = p.match(/^(protection|hexproof) from (.+)$/);
  if (!m) return null;
  const prefix = m[1] === 'protection' ? 'pro' : 'hexfrom';
  const out: string[] = [];
  // "from white and from black", "from red and from green".
  for (const piece of m[2].split(/,? and from |, from /)) {
    const q = qualityOf(piece, prefix);
    if (!q) return null;
    out.push(...q);
  }
  return out;
}

/** Plain words for notes: 'pro:R' -> "protection from red". */
export function describeProtection(kw: string): string {
  const [prefix, ...rest] = kw.split(':');
  const what = rest.join(':');
  const color = Object.entries(COLOR_WORDS).find(([, c]) => c === what)?.[0];
  const words = what === 'all' ? 'everything' : color ?? (what === 'ability' ? 'abilities' : what.startsWith('sub:') ? `${what.slice(4)}s` : what.startsWith('mv') ? `mana value ${what.slice(4)} or ${what[2] === '<' ? 'less' : 'greater'}` : what === 'multi' ? 'multicolored' : what === 'mono' ? 'monocolored' : `${what}s`);
  return `${prefix === 'pro' ? 'protection' : 'hexproof'} from ${words}`;
}

/** Trigger wordings about blocks and attacks. */
export function combatTrigger(l: string): CombatContext | null {
  let m: RegExpMatchArray | null;
  if ((m = l.match(/^whenever ~ becomes blocked,\s*(.*)$/))) return { when: 'blocked', scope: 'self', body: m[1].replace(/^it gets /, '~ gets ') };
  if ((m = l.match(/^whenever a creature you control becomes blocked,\s*(.*)$/))) return { when: 'blocked', scope: 'any', body: m[1].replace(/^(?:you may )?return it to its owner's hand/, "return the blocked creature to its owner's hand") };
  if ((m = l.match(/^whenever ~ attacks and isn't blocked,\s*(.*)$/))) return { when: 'unblocked', scope: 'self', body: m[1] };
  // Vengeful Ancestor: read whole as a static rule.
  if (/^whenever a goaded creature attacks, it deals \w+ damage to its controller/.test(l)) return { when: 'static', body: l };
  return null;
}

/** Sentences about attacking, blocking, goad, suspect and protection. */
export function recogniseCombat(line: string, out: Found[], fullLine: string) {
  let m: RegExpMatchArray | null;
  const push = (body: EffectBody, note: string) => out.push({ body, note });

  // --- Creatures that must attack, or can't attack someone (rule 508.1c-d) ---
  if (/^~ attacks each combat if able/.test(line)) {
    push({ kind: 'combatRule', rule: 'mustAttack', who: 'self' }, 'Attacks each combat if able');
    if (/can't attack its owner/.test(line)) push({ kind: 'combatRule', rule: 'cantAttackOwner', who: 'self' }, "Can't attack its owner");
  }
  if (/^enchanted creature attacks each combat if able/.test(line)) {
    push({ kind: 'combatRule', rule: 'mustAttack', who: 'attached' }, 'Enchanted creature attacks each combat if able');
    if (/can't attack you/.test(line)) push({ kind: 'combatRule', rule: 'cantAttackYou', who: 'attached' }, "Enchanted creature can't attack you");
  }
  if ((m = line.match(/^(?:~|[a-z]+) can't attack or block unless you control at least (\w+) other creatures/))) {
    push({ kind: 'combatRule', rule: 'cantAttack', who: 'self', unlessCreatures: n(m[1]) }, `Can't attack or block unless you control ${m[1]} other creatures`);
    push({ kind: 'combatRule', rule: 'cantBlock', who: 'self', unlessCreatures: n(m[1]) }, '');
  }
  if (/^(?:~|[a-z]+) can't attack during extra turns/.test(line)) push({ kind: 'combatRule', rule: 'cantAttack', who: 'self', extraTurns: true }, "Can't attack during extra turns");
  // Bident of Thassa, The Akroan War, Kardur.
  if (/^creatures your opponents control attack this turn if able/.test(line)) push({ kind: 'forceAttack', until: 'turn' }, "Opponents' creatures must attack this turn");
  if ((m = line.match(/^until your next turn, creatures your opponents control attack each combat if able( and attack a player other than you if able)?/))) {
    if (m[1]) push({ kind: 'goad', all: true }, 'Goad every creature your opponents control');
    else push({ kind: 'forceAttack', until: 'yourNextTurn' }, "Opponents' creatures must attack until your next turn");
  }
  if (/^if a creature an opponent controls attacks, all creatures that opponent controls attack if able/.test(line)) push({ kind: 'combatRule', rule: 'allAttack', who: 'opponents' }, "When an opponent attacks, all their creatures must attack");
  // Crawlspace.
  if ((m = line.match(/^no more than (\w+) creatures can attack you each combat/))) push({ kind: 'combatRule', rule: 'maxAttackers', who: 'all', n: n(m[1]) }, `No more than ${m[1]} creatures can attack you each combat`);
  // Reverence.
  if ((m = line.match(/^creatures with power (\d+) or less can't attack you/))) push({ kind: 'combatRule', rule: 'cantAttackYou', who: 'all', filter: { maxPower: parseInt(m[1], 10) } }, `Creatures with power ${m[1]} or less can't attack you`);
  // Combat Calligrapher, Varchild, Rite of the Raging Storm.
  if ((m = line.match(/^creatures named ([a-z ]+) can't attack you/))) push({ kind: 'combatRule', rule: 'cantAttackYou', who: 'all', filter: { name: m[1] } }, `Creatures named ${m[1]} can't attack you`);
  else if ((m = line.match(/^([a-z]+) (?:your opponents control )?can't block, and they can't attack you/))) {
    const tribe = tribeOf(m[1]);
    if (tribe) {
      push({ kind: 'combatRule', rule: 'cantBlock', who: 'opponents', filter: { subtype: tribe } }, `Opponents' ${m[1]} can't block or attack you`);
      push({ kind: 'combatRule', rule: 'cantAttackYou', who: 'opponents', filter: { subtype: tribe } }, '');
    }
  } else if ((m = line.match(/^([a-z]+) can't attack you or planeswalkers you control/)) && tribeOf(m[1])) {
    push({ kind: 'combatRule', rule: 'cantAttackYou', who: 'all', filter: { subtype: tribeOf(m[1])! } }, `${m[1][0].toUpperCase()}${m[1].slice(1)} can't attack you`);
  }
  // Nils: a tax for each counter on the attacking creature.
  if (/^each creature with one or more counters on it can't attack you[^.]*unless its controller pays \{x\}, where x is the number of counters on that creature/.test(line)) push({ kind: 'attackTax', amount: 1, perCounter: true }, 'Creatures with counters pay {1} per counter to attack you');
  // Summon: Yojimbo.
  if ((m = line.match(/^until your next turn, creatures can't attack you unless their controller pays \{(\d+)\} for each/))) push({ kind: 'tempAttackTax', amount: parseInt(m[1], 10) }, `Until your next turn, creatures pay {${m[1]}} each to attack you`);

  // --- Can't block (rule 509.1b) ---
  if (/^goaded creatures your opponents control can't block/.test(line)) push({ kind: 'combatRule', rule: 'cantBlock', who: 'opponents', filter: { goaded: true } }, "Goaded creatures your opponents control can't block");
  if (/^your opponents can't block with creatures with even mana values/.test(line)) push({ kind: 'combatRule', rule: 'cantBlock', who: 'opponents', filter: { evenMv: true } }, "Opponents can't block with even mana value creatures");
  if (/^creatures your opponents control with -1\/-1 counters on them can't block/.test(line)) push({ kind: 'combatRule', rule: 'cantBlock', who: 'opponents', filter: { minusCounters: true } }, "Opponents' creatures with -1/-1 counters can't block");
  if (/^creatures with power less than ~'s power can't block creatures you control/.test(line)) push({ kind: 'combatRule', rule: 'cantBlock', who: 'all', filter: { weaker: true }, vsYours: true }, "Creatures with less power than it can't block your creatures");
  if ((m = line.match(/^(?:up to one )?target creature can't (attack or block|block|attack) this turn/))) {
    push({ kind: 'pacify', attack: m[1] !== 'block', block: m[1] !== 'attack' }, `A creature can't ${m[1]} this turn`);
  }

  // --- Goad and suspect (rules 701.15, 701.60) ---
  if (/^tap target creature (?:that player|defending player|an opponent) controls and goad it/.test(line)) push({ kind: 'goad', all: false, tap: true }, "Tap and goad a creature of the player you attack");
  if (/^suspect (?:up to one )?target creature/.test(line)) {
    const thenGoad = /then goad all suspected creatures/.test(fullLine);
    push({ kind: 'suspect', ...(thenGoad ? { thenGoad } : {}) }, `Suspect a creature (menace, can't block)${thenGoad ? ', then goad every suspected creature' : ''}`);
  }
  if (/^whenever a goaded creature attacks, it deals (\w+) damage to its controller/.test(line)) {
    const d = line.match(/deals (\w+) damage/)![1];
    push({ kind: 'goadPunish', n: n(d) }, `A goaded creature that attacks deals ${d} damage to its controller`);
  }

  // --- Blocks and unblocked attackers ---
  if (/^return the blocked creature to its owner's hand/.test(line)) push({ kind: 'returnBlocked' }, 'Return the blocked creature to hand');
  if (/^defending player loses 1 life for each card in their graveyard/.test(line)) push({ kind: 'punishDefender', what: 'graveyard', n: 1 }, 'The player it hit loses 1 life for each card in their graveyard');
  if ((m = line.match(/^you may sacrifice it\. if you do, defending player discards (\w+) cards/)) || (/^you may sacrifice it\.?$/.test(line) && (m = fullLine.match(/defending player discards (\w+) cards/)))) {
    push({ kind: 'punishDefender', what: 'discard', n: n(m[1]) }, `Sacrifice it: the player it hit discards ${m[1]}`);
  }

  // --- Protection (rule 702.16) ---
  if (/^target creature you control gains protection from the color of your choice until end of turn/.test(line)) push({ kind: 'protectColor' }, 'Protection from a color for one of your creatures');
  // Skrelv: hexproof from a color and unblockable by it, read as protection from that color.
  if (/^another target creature you control gains toxic 1 and hexproof from that color until end of turn/.test(line)) push({ kind: 'protectColor', toxic: 1 }, 'Protection from a color for another of your creatures (≈ hexproof from it; toxic 1 left out)');
  if ((m = line.match(/^(?:[a-z' ]+ — )?commanders you control have (protection from [a-z ]+|hexproof from [a-z ]+)\.?$/))) {
    const kws = protectionKeywords(m[1]);
    if (kws) push({ kind: 'commanderKeywords', keywords: kws }, `Your commanders have ${m[1]}`);
  }
  if (/^you have protection from each of your opponents/.test(line)) push({ kind: 'playerProtection' }, 'You have protection from your opponents');
  if ((m = line.match(/^target attacking ([a-z, ]+) gains (protection from [a-z]+) until end of turn/))) {
    const kws = protectionKeywords(m[2]);
    if (kws) push({ kind: 'pump', p: 0, t: 0, protect: false, grant: kws }, `An attacking creature gains ${m[2]}`);
  }
}

/** Lines read whole elsewhere or with nothing to do in this engine. */
export function combatLineHandled(line: string): boolean {
  // "Then goad all suspected creatures" rides on the suspect sentence.
  return /^then goad all suspected creatures\.?$/.test(line);
}
