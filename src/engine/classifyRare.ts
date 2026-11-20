// Rarer wordings for the card reader, found on cards in real decks that the
// main recognisers in classify.ts read nothing on at all.
//
// classify.ts calls in here at three points:
// - rewriteRare(line) turns an odd wording into one the reader already knows
//   ("add one mana of the chosen color" -> "add one mana of any color").
// - rareTrigger(line) reads trigger wordings classify.ts has no rule for, and
//   can rewrite the body into words the effect recognisers understand.
// - recogniseRare(sentence, ...) runs on each sentence nothing else read.
//
// Most of these are approximations, and each note says so with "≈". Kept in
// its own file so the rest of the reader stays easy to follow.

import { boardTrigger, recogniseBoard } from './classifyBoard';
import type { CastFilter, Cond, EffectBody, Trigger, TriggerScope } from './types';

type Found = { body: EffectBody; note: string; chance?: number; ifCond?: Cond };
type RareContext = { when: Trigger; scope?: TriggerScope; castFilter?: CastFilter; body: string; chance?: number; oncePerTurn?: boolean };

const WORDS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, x: -1 };
const count = (w: string | undefined, fallback = 1) => (w === undefined ? fallback : /^\d+$/.test(w) ? parseInt(w, 10) : WORDS[w] ?? fallback);

/** Rewrites a whole line (after ability words are stripped) into wording the reader knows. */
export function rewriteRare(l: string): string {
  return l
    // Council's dilemma (Expropriate): "Exile ~." after the votes would hide the last vote outcome.
    .replace(/^(.*\bvotes? for .*?)\s+exile ~\.$/, '$1')
    // Spacecraft and Sieges name themselves "this spacecraft" / "this siege".
    .replace(/\bthis (spacecraft|siege)\b/g, '~')
    // Cleave: the bracketed words are dropped when it's cast for its cleave cost; the bot reads the wider version.
    .replace(/ \[[^\]]*\]/g, '')
    // Metalcraft mana (Mox Opal): needs three artifacts, which artifact decks usually have.
    .replace(/^metalcraft — (\{t\}: add [^.]*)\. activate only if you control three or more artifacts\.?$/, '$1')
    // Mana of a color picked as it enters (Coldsteel Heart, Heraldic Banner) or from an imprinted card (Chrome Mox).
    .replace(/add one mana of (?:the chosen color|any of the exiled card's colors)/, 'add one mana of any color')
    // Moonsnare Prototype: tapping another artifact or creature is part of the cost.
    .replace(/^\{t\}, tap an untapped [a-z ]+ you control: add/, '{t}: add')
    // Nyx Lotus, Astral Cornucopia, Empowered Autogenerator: a growing pile of one color, usually about three.
    .replace(/^\{t\}: (?:choose a color\. add (?:an amount of mana of that color equal to your devotion to that color|one mana of that color for each charge counter on ~)|put a charge counter on ~\. add x mana of any one color[^.]*)\.?$/, '{t}: add three mana of any one color.')
    // "Of the chosen color" anthems (Heraldic Banner, Caged Sun): most of your creatures share it.
    .replace(/^creatures you control of the chosen color get/, 'creatures you control get');
}

/** Trigger wordings classify.ts doesn't know. Returns null to let classify.ts carry on. */
export function rareTrigger(l: string): RareContext | null {
  let m: RegExpMatchArray | null;
  const board = boardTrigger(l);
  if (board) return board;
  // Lotus Petal, Lion's Eye Diamond: mana once, by sacrificing it: kept as Treasures.
  if ((m = l.match(/^(?:discard your hand, )?\{t\}, sacrifice ~: add (one|two|three) mana of any (?:one )?color|^(?:discard your hand, )?sacrifice ~: add (one|two|three) mana of any (?:one )?color/))) {
    const n = count(m[1] ?? m[2]);
    return { when: 'resolve', body: `create ${['', 'a', 'two', 'three'][n]} treasure token${n > 1 ? 's' : ''}` };
  }
  // Scheming Aspirant, Thrummingbird payoffs: "whenever you proliferate" (each time, Tekuthal's second time too).
  if ((m = l.match(/^whenever you proliferate,\s*(.*)$/))) return { when: 'proliferate', body: m[1] };
  // Exquisite Blood.
  if ((m = l.match(/^whenever an opponent loses life, (?!that player mills)(.*)$/))) return { when: 'opponentLoseLife', body: m[1] };
  // Geth's Grimoire, Liliana's Caress, Megrim, Waste Not, Entropic Battlecruiser.
  if ((m = l.match(/^(?:\d+\+ \| )?whenever an opponent discards (a|a creature|a land|a noncreature, nonland) card,\s*(.*)$/))) {
    const chance = m[1] === 'a' ? undefined : m[1] === 'a land' ? 0.3 : 0.4;
    const body = m[2].replace(/^(that player|they) loses?/, 'target opponent loses').replace(/damage to that player/, 'damage to target opponent');
    return { when: 'opponentDiscard', body, chance };
  }
  // Fabricate N (rule 702.123): N +1/+1 counters or N 1/1 Servos; bots take the Servos.
  if ((m = l.match(/^fabricate (\d+)$/))) {
    const n = parseInt(m[1], 10);
    return { when: 'resolve', body: `create ${n === 1 ? 'a' : n} 1/1 colorless servo artifact creature token${n > 1 ? 's' : ''}` };
  }
  // Mentor (rule 702.134): a +1/+1 counter on an attacking creature with lesser power.
  if (/^mentor$/.test(l)) return { when: 'attack', scope: 'self', body: 'put a +1/+1 counter on target creature' };
  // Living weapon (rule 702.92) and job select: a token, then this Equipment is attached to it.
  if (/^living weapon$/.test(l)) return { when: 'resolve', body: 'living weapon germ' };
  if (/^job select$/.test(l)) return { when: 'resolve', body: 'job select hero' };
  // "Whenever you discard a card" (Inti, Monument to Endurance): once for each card discarded.
  if ((m = l.match(/^whenever you discard (?:a card|one or more cards)[^,]*,\s*(.*)$/))) return { when: 'discard', body: m[1] };
  // Extort: pay {W/B} as you cast a spell to drain each opponent for 1. Paid about half the time.
  if (/^extort$/.test(l)) return { when: 'cast', castFilter: 'any', body: 'each opponent loses 1 life and you gain 1 life', chance: 0.5 };
  // Howling Mine, Dictate of Kruphix, Font of Mythos: everyone draws more; you get yours each turn.
  if ((m = l.match(/^at the beginning of each player's draw step, (?:if ~ is untapped, )?that player draws (an|two) additional cards?\.?$/))) {
    return { when: 'upkeep', body: `draw ${m[1] === 'an' ? 'a card' : 'two cards'}` };
  }
  // Mystic Forge, Fortune Teller's Talent: playing off the top of the library some of the time.
  if (/^you may cast artifact spells and colorless spells from the top of your library|^as long as you've cast a spell this turn, you may play cards from the top of your library/.test(l)) {
    return { when: 'upkeep', body: 'draw a card', chance: 0.5 };
  }
  // Sulfuric Vortex: everyone takes 2 each upkeep, you too.
  if (/^at the beginning of each player's upkeep, ~ deals (\d+) damage to that player/.test(l)) {
    const n = l.match(/deals (\d+)/)![1];
    return { when: 'upkeep', body: `~ deals ${n} damage to each opponent. you lose ${n} life` };
  }
  // Rite of the Raging Storm: everyone gets a 5/1 that can't attack you; yours can attack them.
  if (/^at the beginning of each player's upkeep, that player creates a 5\/1 red elemental creature token named lightning rager/.test(l)) {
    return { when: 'upkeep', body: 'create a 5/1 red elemental creature token with trample and haste' };
  }
  // Unnatural Growth: doubling power and toughness each combat is about +2/+2 for a typical team.
  if (/^at the beginning of each combat, double the power and toughness of each creature you control/.test(l)) {
    return { when: 'upkeep', body: 'creatures you control get +2/+2 until end of turn' };
  }
  // Agent of the Iron Throne: mostly creatures dying.
  if ((m = l.match(/^whenever an artifact or creature you control is put into a graveyard from the battlefield,\s*(.*)$/))) return { when: 'creatureDies', body: m[1] };
  // Altar of the Brood: read as your creatures entering.
  if ((m = l.match(/^whenever another permanent you control enters,\s*(.*)$/))) return { when: 'creatureEnters', body: m[1] };
  // Duelist's Heritage: usually your own attack.
  if ((m = l.match(/^whenever one or more creatures attack, you may have target attacking creature gain ([a-z ]+) until end of turn/))) {
    return { when: 'attack', scope: 'oneOrMore', body: `target creature gains ${m[1]} until end of turn` };
  }
  // Shared Animosity: each attacker gets +1/+0 per other attacker of its type, about +2/+0 in a tribal deck.
  if (/^whenever a creature you control attacks, it gets \+1\/\+0 until end of turn for each other attacking creature that shares a creature type with it/.test(l)) {
    return { when: 'attack', scope: 'oneOrMore', body: 'creatures you control get +2/+0 until end of turn' };
  }
  // Night Shift of the Living Dead, Barbarian Class: die-roll wordings.
  if ((m = l.match(/^whenever you roll a (\d+),\s*(.*)$/))) return { when: 'dieRoll', body: m[2], chance: 1 / 6 };
  if ((m = l.match(/^whenever you roll one or more dice,\s*(.*)$/))) return { when: 'dieRoll', body: m[1] };
  // The Endstone: lands played aren't counted, only spells.
  if ((m = l.match(/^whenever you play a land or cast a spell,\s*(.*)$/))) return { when: 'cast', castFilter: 'any', body: m[1] };
  // Wedding Ring: the opponent with the copy draws on their own turn now and then.
  if ((m = l.match(/^whenever an opponent who controls an artifact named ~ (draws a card|gains life) during their turn, (you draw a card|you gain that much life)/))) {
    return m[1] === 'draws a card' ? { when: 'opponentDraw', body: 'draw a card', chance: 0.3 } : { when: 'upkeep', body: 'you gain 2 life', chance: 0.3 };
  }
  // Reality Acid: the enchanted permanent goes when Reality Acid fades away (vanishing 3). Read as removal on arrival.
  if (/^when ~ leaves the battlefield, enchanted permanent's controller sacrifices it/.test(l)) return { when: 'resolve', body: 'destroy target nonland permanent' };
  // Hot Pursuit: the suspected creature is goaded.
  if ((m = l.match(/^when ~ enters, suspect target creature an opponent controls\. as long as ~ remains on the battlefield, that creature is also goaded/))) return { when: 'resolve', body: 'goad target creature' };
  // Outlaws' Merriment: a random token each upkeep, about a 2/2 with a keyword.
  if (/^at the beginning of your upkeep, choose one at random\. create a red and white creature token with those characteristics/.test(l)) return { when: 'upkeep', body: 'create a 2/2 red and white creature token' };
  // Chimil and Long-Range Sensor: discover N is a free spell off the top.
  if ((m = l.match(/^at the beginning of your end step, discover (\d+)/))) return { when: 'upkeep', body: `discover ${m[1]}` };
  return null;
}

/** Effects on a sentence nothing else recognised. `fullLine` is the whole ability. */
export function recogniseRare(line: string, out: Found[], card: { isPermanent: boolean; isCreature: boolean }, fullLine: string) {
  let m: RegExpMatchArray | null;
  const push = (body: EffectBody, note: string, chance?: number) => out.push({ body, note, ...(chance !== undefined ? { chance } : {}) });
  if (recogniseBoard(line, out)) return;

  if (/^living weapon germ$/.test(line)) return push({ kind: 'tokens', n: 1, power: 0, toughness: 0, keywords: [], subtypes: ['phyrexian', 'germ'], attachSource: true }, 'Living weapon: a 0/0 Germ token wearing it');
  if (/^job select hero$/.test(line)) return push({ kind: 'tokens', n: 1, power: 1, toughness: 1, keywords: [], subtypes: ['hero'], attachSource: true }, 'Job select: a 1/1 Hero token wearing it');
  if (/^sacrifice (?:it|~) unless it escaped\.?$/.test(line)) return push({ kind: 'sacrificeSelf', unlessEscaped: true }, 'Sacrificed unless it escaped');
  if ((m = line.match(/^attach (?:it|~) to target (legendary )?creature you control\.?$/))) return push({ kind: 'attachSelf', ...(m[1] ? { legendary: true } : {}) }, `Attaches itself to ${m[1] ? 'a legendary' : 'a'} creature of yours as it enters`);
  if ((m = line.match(/^each opponent's maximum hand size is reduced by (\w+)\.?$/))) return push({ kind: 'handSize', n: -count(m[1]), who: 'opponents' }, `Opponents' maximum hand size is ${count(m[1])} smaller`);
  if ((m = line.match(/^creature tokens you control have ([a-z]+(?:(?:, | and )[a-z]+)*)\.?$/))) return push({ kind: 'anthem', p: 0, t: 0, keywords: m[1].split(/, | and /), only: 'token' }, `Your creature tokens have ${m[1]}`);

  // --- Free spells and card advantage ------------------------------------------
  if (/^you may cast (?:the copy|the copies|the exiled card|target instant or sorcery card from an opponent's graveyard) without paying/.test(line) || /you may cast (?:the copy|the copies) without paying/.test(line)) {
    const n = /the copies/.test(line) ? 3 : 1;
    return push({ kind: 'draw', n }, `Cast ${n > 1 ? 'copies of a spell' : 'a spell'} for free (≈ draw ${n})`);
  }
  if ((m = line.match(/you may cast (any number of|up to (?:x|two)|an?) [^.]*from among [^.]*without paying/))) {
    const n = m[1] === 'any number of' ? 3 : 1;
    return push({ kind: 'draw', n }, `Free spell${n > 1 ? 's' : ''} from among the revealed cards (≈ draw ${n})`);
  }
  if (/^you may cast spells from among those cards this turn/.test(line)) return push({ kind: 'draw', n: 3 }, "Cast spells from opponents' graveyards this turn (≈ draw 3)");
  if (/^exile the top x cards of your library\. until the end of your next turn, you may play those cards/.test(fullLine) && /^exile the top x/.test(line)) return push({ kind: 'draw', n: -1 }, 'Impulse draw X');
  if (/^you may play the exiled card for as long as it remains exiled/.test(line)) return push({ kind: 'draw', n: 1 }, "Play a card from an opponent's library (≈ draw 1)");
  if (/^look at the top three cards of your library\. you may exile a nonland card from among them\. if you do, it becomes plotted\. put the rest into your hand/.test(fullLine) && /^look at/.test(line)) return push({ kind: 'draw', n: 3 }, 'Three cards, one of them plotted (≈ draw 3)');
  if (/you draw a card for each opponent who drew a card this way/.test(line)) return push({ kind: 'draw', n: 3 }, 'Draw a card for each opponent (they draw one each)');
  if ((m = line.match(/^discover (\d+)/))) return push({ kind: 'draw', n: 1 }, `Discover ${m[1]} (≈ a free spell)`);
  if (/^put any number of permanent cards from among them onto the battlefield and the rest into your hand/.test(line)) {
    return push({ kind: 'digPermanent', among: 5, permanents: { xLimit: false, rest: 'hand' } }, 'Every permanent card among the top five onto the battlefield, the rest into your hand');
  }
  if (/^you may put any number of permanent cards with mana value x or less from among them onto the battlefield/.test(line)) return push({ kind: 'digPermanent', among: -1, permanents: { xLimit: true, rest: 'graveyard' } }, 'Every permanent card with mana value X or less among the top X onto the battlefield, the rest into your graveyard');
  if (/^you may put a land card from among them onto the battlefield tapped/.test(line)) return push({ kind: 'ramp', lands: 1, toHand: 0, tapped: true }, 'A land from the top four onto the battlefield tapped', 0.7);
  if (/^if it's a land card, you may put it onto the battlefield tapped/.test(line)) return push({ kind: 'ramp', lands: 1, toHand: 0, tapped: true }, 'Top card onto the battlefield if it is a land', 0.4);
  if (/^each opponent exiles cards from the top of their library until that player has exiled cards with total mana value 20/.test(line)) return push({ kind: 'mill', n: 7, who: 'opponents' }, 'Each opponent exiles about 7 cards from the top (≈ mill 7)');
  if (/^you gain life equal to (its|that creature's) toughness/.test(line)) return push({ kind: 'gainLife', n: 3 }, 'Gain life equal to its toughness (≈ 3)');
  if (/^you gain that much life/.test(line)) return push({ kind: 'gainLife', n: -1 }, 'Gain that much life');
  if (/^(?:then )?each player creates (x|\w+) treasure tokens/.test(line)) return push({ kind: 'treasure', n: 2 }, 'Treasures for everyone (≈ 2 for you)');
  if (/^(?:if ~ is untapped, )?that creature's controller creates a 1\/1 colorless myr artifact creature token/.test(line)) return push({ kind: 'tokens', n: 1, power: 1, toughness: 1, keywords: [] }, 'Make a 1/1 Myr for each nontoken creature entering');

  if ((m = line.match(/^that player loses (\d+) life unless they discard a card/))) return push({ kind: 'damagePlayer', n: parseInt(m[1], 10) }, `That player loses ${m[1]} life unless they discard`, 0.5);
  if (/^create a white spirit cleric creature token with/.test(line)) return push({ kind: 'tokens', n: 1, power: 2, toughness: 2, keywords: [] }, 'Make a Spirit token (≈ 2/2, grows with your Spirits)');
  if (/^choose a counter on target permanent or suspended card\. remove that counter from that permanent or card or put another of those counters on it/.test(fullLine) && /^choose a counter/.test(line)) return push({ kind: 'counters', n: 1, all: false, proliferate: true }, 'An extra counter on a permanent (≈ proliferate)');

  // --- Removal and sweepers ----------------------------------------------------
  if (/^exile each permanent with the most votes/.test(line)) return push({ kind: 'removal', target: 'permanent', mode: 'exile', amount: 0 }, 'Exile a nonland permanent (the vote)');
  if (/^exile x target creatures/.test(line)) return push({ kind: 'removal', target: 'creature', mode: 'exile', amount: 0 }, 'Exile X creatures (≈ one)');
  if (/^for each player, exile up to one target non-saga, nonland permanent that player controls/.test(line)) return push({ kind: 'removal', target: 'permanent', mode: 'exile', amount: 0 }, 'Exile a nonland permanent of each player (≈ one of an opponent)');
  if (/^starting with the next opponent in turn order, each player chooses a creature you don't control\. destroy the chosen creatures/.test(fullLine) && /^starting/.test(line)) return push({ kind: 'removal', target: 'creature', mode: 'destroy', amount: 0 }, 'Destroy creatures the players choose (≈ one)');
  if (/^destroy up to x target artifacts and\/or enchantments/.test(line)) return push({ kind: 'removal', target: 'artifactEnchantment', mode: 'destroy', amount: 0 }, 'Destroy X artifacts or enchantments (≈ one)');
  if (/^create twice x 1\/1 [a-z ]+ creature tokens/.test(line)) return push({ kind: 'tokens', n: 2, power: 1, toughness: 1, keywords: [] }, 'Make twice X 1/1 tokens (≈ 2)');
  if (/^choose two target creatures controlled by different players\. return those creatures to their owners' hands/.test(fullLine) && /^choose/.test(line)) return push({ kind: 'removal', target: 'creature', mode: 'bounce', amount: 0 }, 'Bounce a creature (and one of yours)');
  if ((m = line.match(/^~ deals x damage divided as you choose among any number of target creatures/))) return push({ kind: 'removal', target: 'creature', mode: 'damage', amount: -1 }, 'Deal X damage to creatures (≈ one)');
  if (/^choose any target, then choose another target for each time ~ was kicked\. ~ deals x damage to each of them/.test(fullLine) && /^choose any target/.test(line)) return push({ kind: 'removal', target: 'creature', mode: 'damage', amount: -1, anyTarget: true }, 'Deal X damage to any target');
  if (/^~ deals five times x damage to each of up to x targets/.test(line)) return push({ kind: 'removal', target: 'creature', mode: 'damage', amount: 5, anyTarget: true }, 'Deal 5 damage to a target for each X (≈ one)');
  if (/^~ deals damage to each creature your opponents control equal to the total mana value of other spells you've cast this turn/.test(line)) return push({ kind: 'wipe', target: 'creatures', mode: 'damage', amount: 4, oneSided: true }, 'One-sided sweeper (≈ 4 damage after the cascades)');
  if (/^each creature deals damage to itself equal to its power/.test(line)) return push({ kind: 'wipe', target: 'creatures', mode: 'damage', amount: 3, oneSided: false }, 'Each creature deals damage to itself (≈ 3-damage sweeper)');
  if (/^destroy each artifact with mana value x or less/.test(line)) return push({ kind: 'wipe', target: 'artifacts', mode: 'destroy', amount: 0, oneSided: false }, 'Destroy artifacts with mana value X or less');
  if (/^then destroy all artifacts and enchantments/.test(line)) return push({ kind: 'wipe', target: 'artifacts', mode: 'destroy', amount: 0, oneSided: false }, 'Destroy all artifacts and enchantments');
  if (/^return each nonland permanent that's not historic to its owner's hand/.test(line)) return push({ kind: 'wipe', target: 'nonland', mode: 'bounce', amount: 0, oneSided: false }, 'Bounce every nonland permanent that is not historic');
  if (/^return (all|each) (nontoken )?creatures?( tokens)?( your opponents control)?[^.]* to (its|their) owners?'? hands?/.test(line)) return push({ kind: 'wipe', target: 'creatures', mode: 'bounce', amount: 0, oneSided: /opponents control/.test(line) }, 'Mass bounce');
  if (/^each player sacrifices (thirteen|\w+teen|twenty) creatures/.test(line)) return push({ kind: 'wipe', target: 'creatures', mode: 'destroy', amount: 0, oneSided: false }, 'Mass sacrifice');
  // Each player keeps one or a few: read as a symmetrical wipe.
  if (/^each player puts a vow counter on a creature they control and sacrifices the rest|^each player chooses (?:any number of creatures they control with total power \d+ or less|a party from among creatures they control), then sacrifices (?:all other creatures they control|the rest)/.test(line) || (/^choose up to one creature\.?$/.test(line) && /destroy the rest/.test(fullLine))) {
    return push({ kind: 'wipe', target: 'creatures', mode: 'destroy', amount: 0, oneSided: false }, 'Creature wipe (each player keeps one or a few)');
  }
  if (/^each player chooses an artifact, a creature, an enchantment, and a planeswalker from among the nonland permanents they control, then sacrifices the rest/.test(line)) return push({ kind: 'wipe', target: 'nonland', mode: 'destroy', amount: 0, oneSided: false }, 'Wipe (each player keeps one of each type)');
  if (/^each player chooses a color\. then exile each permanent unless/.test(fullLine) && /^each player chooses a color/.test(line)) return push({ kind: 'wipe', target: 'nonland', mode: 'exile', amount: 0, oneSided: false }, 'Exile most permanents (≈ wipe)');
  if (/^exile each creature and planeswalker with mana value less than the revealed card's mana value/.test(line)) return push({ kind: 'wipe', target: 'creatures', mode: 'exile', amount: 0, oneSided: false }, 'Exile smaller creatures (≈ wipe)');
  if (/^return each creature your opponents control with toughness x or less to its owner's hand/.test(line)) return push({ kind: 'wipe', target: 'creatures', mode: 'bounce', amount: 0, oneSided: true }, "Bounce opponents' smaller creatures");
  if (/^each opponent gets a poison counter\. then each creature your opponents control gets -1\/-1 until end of turn for each poison counter/.test(fullLine) && /^each opponent gets a poison/.test(line)) return push({ kind: 'wipe', target: 'creatures', mode: 'damage', amount: 1, oneSided: true, shrink: 'temp' }, 'One-sided shrink (≈ -1/-1)');
  // Discard spells where you pick the card.
  if (/^(?:if you do, )?(?:that player|they) discards? (that card|it)\.?$/.test(line) && /reveals their hand/.test(fullLine)) return push({ kind: 'discard', n: 1, who: 'target' }, 'An opponent discards the card you choose');
  if (/^(?:for each money vote, )?choose a permanent owned by the voter and gain control of it/.test(line)) return push({ kind: 'steal', from: 'battlefield' }, 'Take control of a permanent (the vote)');
  if (/^for each creature with one or more votes, put that many stun counters on it/.test(line)) return push({ kind: 'stun' }, "Stun counters on an opponent's creature (the vote)");
  if (/^tap target creature an opponent controls\.?$/.test(line) && /doesn't untap during its controller's next untap step/.test(fullLine)) return push({ kind: 'stun' }, "Tap an opponent's creature; it skips an untap");
  if (/^put a double strike counter on target creature, then goad/.test(line)) return push({ kind: 'goad', all: false }, 'Goad a creature (with a double strike counter)');
  if (/^goad target creature$/.test(line)) return push({ kind: 'goad', all: false }, 'Goad a creature (suspected)');

  // --- Counterspells and redirection -----------------------------------------------
  if (/^counter target spell, activated ability, or triggered ability/.test(line)) return push({ kind: 'counter', target: 'any' }, 'Counterspell (also abilities)');
  if (/^counter target activated ability, triggered ability, or legendary spell/.test(line)) return push({ kind: 'counter', target: 'any' }, 'Counter a legendary spell or an ability');
  // Deflecting Swat, Misdirection, Bolt Bend: real redirects now (classifyControl.ts).
  if (/^you may reveal the top card of your library\. if you do, counter that spell if it has the same mana value/.test(fullLine) && /^you may reveal/.test(line)) return void out.push({ body: { kind: 'counter', target: 'any', subject: true }, note: 'Counter that spell if your top card has the same mana value', ifCond: { k: 'topSameMv' } });

  // --- Pumps, protection, equipment ------------------------------------------------
  if ((m = line.match(/^(?:until end of turn, )?(?:up to one )?target creature( you control)? gets \+(\d+)\/\+(\d+) and gains ([a-z0-9, ]*?|) ?(?:until end of turn|\.?$)/))) {
    const grant = ['lifelink', 'indestructible', 'first strike', 'double strike', 'infect', 'trample', 'menace', 'haste', 'flying'].filter((k) => m![4].includes(k));
    const protect = grant.includes('indestructible');
    return push({ kind: 'pump', p: parseInt(m[2], 10), t: parseInt(m[3], 10), protect, ...(grant.length ? { grant } : {}) }, `Combat trick +${m[2]}/+${m[3]}${grant.length ? ` and ${grant.join(', ')}` : ''}`);
  }
  if ((m = line.match(/^until end of turn, double target creature's power and it gains (first strike|double strike|trample)/))) return push({ kind: 'pump', p: 3, t: 0, protect: false, grant: [m[1]], doublePower: true }, `Double a creature's power and ${m[1]}`);
  if (/^double target creature's power until end of turn/.test(line)) return push({ kind: 'pump', p: 3, t: 0, protect: false, doublePower: true }, "Double a creature's power");
  if (/^it and other creatures you control that share a creature type with it each get \+(\d)\/\+(\d)/.test(line)) {
    const [, p, t] = line.match(/\+(\d)\/\+(\d)/)!;
    return push({ kind: 'overrun', p: parseInt(p, 10), t: parseInt(t, 10), trample: false }, `Creatures of its type get +${p}/+${t} this turn`);
  }
  if (/^(?:until end of turn, )?target creature( you control)? gains "when ~ dies, return it to the battlefield/.test(fullLine) && /target creature/.test(line)) {
    const plus = /with a \+1\/\+1 counter on it/.test(fullLine) ? 1 : 0;
    return push({ kind: 'protect', returns: plus }, `It returns to the battlefield tapped if it dies this turn${plus ? ', with a +1/+1 counter' : ''}`);
  }
  if (/^up to x target creatures phase out/.test(line)) return push({ kind: 'protect' }, 'Phase out creatures (≈ protection)');
  if (/^all creatures gain hexproof and indestructible until end of turn/.test(line)) return push({ kind: 'protect', all: true }, 'Everything is protected this turn');
  if (/^you can't lose the game this turn and your opponents can't win the game this turn/.test(line)) return push({ kind: 'protect', player: true }, "You can't lose this turn (≈ protected until your next turn)");
  if (card.isPermanent && /^other permanents you control have hexproof/.test(line)) return push({ kind: 'anthem', p: 0, t: 0, keywords: ['hexproof'], other: true }, 'Your other permanents have hexproof');
  if (/^equipped creature can't be blocked and has (shroud|hexproof)/.test(line)) return push({ kind: 'equip', p: 0, t: 0, keywords: ['unblockable', line.includes('shroud') ? 'shroud' : 'hexproof'], aura: false }, "Equipment: can't be blocked, shroud");
  if ((m = line.match(/^equipped creature gets \+x\/\+(\d+), where x is the number of artifacts you control/))) return push({ kind: 'equip', p: 3, t: parseInt(m[1], 10), keywords: [], aura: false }, `Equipment +X/+${m[1]} (X = your artifacts, ≈ 3)`);
  if (/^choose a counter on target permanent\. put an additional counter of that kind on that permanent/.test(fullLine) && /^choose a counter/.test(line)) return push({ kind: 'counters', n: 1, all: false, proliferate: true }, 'An extra counter on a permanent (≈ proliferate)');

  // --- Taxes and cost reduction -----------------------------------------------------
  if (/^creatures can't attack you or planeswalkers you control unless their controller pays \{x\} for each of those creatures, where x is the number of enchantments you control/.test(line)) return push({ kind: 'attackTax', amount: 3 }, 'Attack tax: {X} per creature, X = your enchantments (≈ 3)');
  if (/^artifact, instant, and sorcery spells your opponents cast cost \{1\} more to cast/.test(line)) return push({ kind: 'spellTax', amount: 1, filter: 'noncreature' }, 'Noncreature spells your opponents cast cost {1} more (≈ artifacts, instants and sorceries)');
  if (/^each spell you cast costs \{1\} less to cast for each of the chosen colors it is/.test(line)) return push({ kind: 'costReduction', amount: 1, filter: 'any' }, 'Spells cost {1} less for each chosen color (≈ {1})');
  if (/^you may cast spells from your hand without paying their mana costs/.test(line)) return push({ kind: 'costReduction', amount: 9, filter: 'any' }, 'Your spells are free');

  // --- Copies and other odds ---------------------------------------------------------
  if (/^each opponent chooses a creature card in their graveyard\. put those cards onto the battlefield under your control/.test(fullLine) && /^each opponent chooses/.test(line)) return push({ kind: 'recursion', n: 2, toBattlefield: true, what: 'artifactOrCreature', from: 'opponents' }, "Creatures from opponents' graveyards onto the battlefield under your control (≈ 2)");
  if (/^each player returns all creature cards of a type chosen this way from their graveyard to the battlefield/.test(line)) return push({ kind: 'recursion', n: 3, toBattlefield: true, what: 'artifactOrCreature' }, 'Creatures of the chosen type back to the battlefield (≈ 3 of yours)');
  if (/^each player exiles all creature cards from their graveyard, then sacrifices all creatures they control, then puts all cards they exiled this way onto the battlefield/.test(line)) {
    push({ kind: 'wipe', target: 'creatures', mode: 'destroy', amount: 0, oneSided: false }, 'Every creature dies…');
    return push({ kind: 'recursion', n: 5, toBattlefield: true, what: 'artifactOrCreature' }, '…and graveyard creatures come back (≈ 5 of yours)');
  }
  if (/^create avacyn, a legendary 8\/8 white angel creature token with flying/.test(line)) return push({ kind: 'tokens', n: 1, power: 8, toughness: 8, keywords: ['flying', 'vigilance', 'indestructible'] }, 'Make Avacyn, an 8/8 flier');
}
