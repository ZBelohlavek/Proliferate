// The last cards in Zach's decks that the built-in engine played as something close ("≈"): now played as
// printed, with the engine pieces in typesExact.ts and resolveExact in src/rules/game.ts. Spread into
// CARD_RULES after every other rules file, so these entries win.

import type { CardRule } from './cardRules';
import type { Effect, ManaCost } from './types';

const cost = (generic: number, pips: string[][] = [], life = 0): ManaCost => ({ generic, pips: pips as ManaCost['pips'], x: 0, life });
const act = (c: ManaCost, tap: boolean, more: Partial<NonNullable<Effect['activation']>> = {}): NonNullable<Effect['activation']> => ({ cost: c, tap, sacrifice: false, ...more });

export const EXACT_RULES: Record<string, CardRule> = {
  'Intellect Devourer': {
    effects: [{ kind: 'exilePlay', n: 1, from: 'opponents', zone: 'hand', until: 'exiled', whileSource: true, anyMana: true, returnToHand: true, when: 'resolve' }],
    notes: ['When it enters, each opponent exiles a card from their hand until it leaves; you may play those cards, with mana of any type'],
    why: 'Cards still exiled go back to their owners\' hands when it leaves the battlefield.',
  },
  "Tasha's Hideous Laughter": {
    effects: [{ kind: 'exileUntilMv', total: 20, when: 'resolve' }],
    notes: ['Each opponent exiles cards from the top of their library until the exiled mana values total 20 or more'],
    why: 'Counted card by card, so a library of lands loses many more cards than one of big spells.',
  },
  'Wharf Infiltrator': {
    effects: [
      { kind: 'draw', n: 1, loot: true, when: 'combatDamage', scope: 'self' },
      { kind: 'tokens', n: 1, power: 3, toughness: 2, keywords: [], subtypes: ['eldrazi', 'horror'], castFilter: 'creature', mayPay: 2, when: 'discard' },
    ],
    notes: ['On combat damage to a player: you may draw a card, then discard one', 'When you discard a creature card: pay {2} for a 3/2 Eldrazi Horror'],
    why: 'The discard trigger looks at the discarded card, and the {2} is paid as it resolves when there is mana to spare.',
  },
  "Tishana's Tidebinder": {
    effects: [{ kind: 'counterAbility', when: 'resolve' }],
    notes: ['When it enters: counter up to one activated or triggered ability; an artifact, creature or planeswalker whose ability it counters loses all abilities while this stays'],
    why: 'Bots flash it in when an opponent activates or triggers something worth stopping.',
  },
  'Mnemonic Betrayal': {
    effects: [{ kind: 'exilePlay', n: 99, from: 'opponents', zone: 'graveyard', until: 'turn', anyMana: true, castOnly: true, endReturn: 'graveyard', when: 'resolve' }],
    notes: ["Exile opponents' graveyards; you may cast spells from among them this turn with mana of any type; at the next end step the rest go back to their owners' graveyards", 'Exiles itself'],
    why: 'Cards not cast go back to their owners\' graveyards at the next end step, and the spell exiles itself.',
  },
  'Tolarian Kraken': {
    effects: [{ kind: 'tap', target: 'creature', orUntap: true, mayPay: 1, when: 'draw' }],
    notes: ['Whenever you draw a card, you may pay {1}: tap or untap target creature'],
    why: 'The {1} is paid as the trigger resolves; bots tap an opponent\'s creature or untap one of their own. The target is chosen as the trigger goes on the stack.',
  },
  'Monstrosity of the Lake': {
    effects: [{ kind: 'tapAllOf', who: 'opponents', stunAll: true, mayPay: 5, when: 'resolve' }],
    notes: ["When it enters, you may pay {5}: tap all creatures your opponents control and put a stun counter on each"],
    why: 'The {5} is paid as the trigger resolves, when there is that much mana.',
  },
  'Sadistic Shell Game': {
    effects: [{ kind: 'shellGame', when: 'resolve' }],
    notes: ["Starting with the next opponent, each player chooses a creature you don't control; destroy them"],
    why: 'Each player picks in turn order; opponents pick each other\'s best creatures and you pick the biggest threat.',
  },
  'Thieving Amalgam': {
    effects: [
      { kind: 'manifest', who: 'opponents', when: 'upkeep', whose: 'opponents' },
      { kind: 'ownerDrain', n: 2, when: 'creatureDies' },
    ],
    notes: ["Each opponent's upkeep: manifest the top card of that player's library", "When a creature you control but don't own dies: its owner loses 2 life and you gain 2"],
    why: 'Only creatures you control but don\'t own count, checked as each one dies.',
  },
  'Thran Vigil': {
    effects: [{ kind: 'counters', n: 1, all: false, castFilter: 'artifactOrCreature', ifCond: { k: 'yourTurn' }, when: 'leaveGraveyard' }],
    notes: ['When artifact or creature cards leave your graveyard during your turn: a +1/+1 counter on target creature you control'],
    why: 'Watches your graveyard after each spell or ability: one trigger however many cards left at once.',
  },
  'Fire Covenant': {
    effects: [{ kind: 'removal', target: 'creature', mode: 'damage', amount: 0, amountFrom: 'x', multi: 'any', divided: true, when: 'resolve' }],
    notes: ['X is paid in life', 'X damage divided among any number of target creatures'],
    why: 'Bots split the damage so each target gets what it takes to die, the first target any left over.',
  },
  'Magebane Lizard': {
    effects: [
      { kind: 'damagePlayer', n: 0, amountFrom: 'noncreatureSpells', thatPlayer: true, castFilter: 'noncreature', when: 'cast' },
      { kind: 'damagePlayer', n: 0, amountFrom: 'noncreatureSpells', thatPlayer: true, castFilter: 'noncreature', when: 'opponentCast' },
    ],
    notes: ['Whenever a player casts a noncreature spell: damage to them equal to the noncreature spells they cast this turn'],
    why: 'Each player\'s noncreature spells are counted through the turn.',
  },
  'Laughing Jasper Flint': {
    effects: [{ kind: 'exilePlay', n: 0, amountFrom: 'outlaws', from: 'target', until: 'turn', anyMana: true, castOnly: true, when: 'upkeep' }],
    notes: ["Creatures you control but don't own are Mercenaries", "Each upkeep: exile the top X cards of an opponent's library, X = your outlaws; cast spells from among them this turn with mana of any type"],
    why: 'Outlaws are your Assassins, Mercenaries, Pirates, Rogues and Warlocks, counting creatures you took from others as Mercenaries.',
  },
  'Descent into Avernus': {
    effects: [{ kind: 'descent', when: 'upkeep' }],
    notes: ['Each upkeep: two descent counters, then each player makes X Treasures and takes X damage, X = the counters'],
    why: 'The counters build up, so everyone gets more Treasures and more damage each turn.',
  },
  'Gleeful Arsonist': {
    effects: [{ kind: 'damagePlayer', n: 0, amountFrom: 'srcPower', thatPlayer: true, castFilter: 'noncreature', when: 'opponentCast' }],
    notes: ['When an opponent casts a noncreature spell: damage to them equal to its power'],
    why: 'Its power as the trigger resolves, counters included.',
  },
  'Crackle with Power': {
    effects: [{ kind: 'removal', target: 'creature', mode: 'damage', amount: 0, anyTarget: true, amountFrom: 'x', xTimes: 5, multi: 'x', when: 'resolve' }],
    notes: ['Five times X damage to each of up to X targets'],
    why: 'Up to X different targets, each taking 5X.',
  },
  'Arni Slays the Troll': {
    effects: [
      { kind: 'removal', target: 'creature', mode: 'fight', amount: 0, when: 'chapter', chapters: [1] },
      { kind: 'treasure', n: 1, ritual: true, when: 'chapter', chapters: [2] },
      { kind: 'counters', n: 2, all: false, when: 'chapter', chapters: [2] },
      { kind: 'gainLife', n: 0, amountFrom: 'greatestPower', when: 'chapter', chapters: [3] },
    ],
    notes: ['I: your creature fights one you don\'t control', 'II: add {R}; two +1/+1 counters on a creature you control', 'III: gain life equal to your greatest power'],
    why: 'Chapter III counts your greatest power as it resolves.',
  },
  'Fall of the Impostor': {
    effects: [
      { kind: 'counters', n: 1, all: false, when: 'chapter', chapters: [1, 2] },
      { kind: 'exileBiggest', when: 'chapter', chapters: [3] },
    ],
    notes: ['I, II: a +1/+1 counter on up to one creature', 'III: exile a creature with the greatest power among those target opponent controls'],
    why: 'Chapter III targets the opponent, not the creature, so hexproof and ward on the creature don\'t stop it.',
  },
  'Battle at the Helvault': {
    effects: [
      { kind: 'exileEachUntil', when: 'chapter', chapters: [1, 2] },
      { kind: 'tokens', n: 1, power: 8, toughness: 8, keywords: ['flying', 'vigilance', 'indestructible'], subtypes: ['angel'], legendary: true, when: 'chapter', chapters: [3] },
    ],
    notes: ['I, II: for each player, exile up to one non-Saga nonland permanent they control until this leaves', 'III: Avacyn, a legendary 8/8 flying, vigilance, indestructible Angel'],
    why: 'The exiled permanents return when the Saga leaves, which is right after chapter III.',
  },
  'Summon: Esper Ramuh': {
    effects: [
      { kind: 'removal', target: 'creature', mode: 'damage', amount: 0, amountFrom: 'graveyardSpells', when: 'chapter', chapters: [1] },
      { kind: 'overrun', p: 1, t: 0, trample: false, subtype: 'wizard', when: 'chapter', chapters: [2, 3] },
    ],
    notes: ['I: damage to an opponent\'s creature equal to the noncreature, nonland cards in your graveyard', 'II, III: Wizards you control get +1/+0 this turn'],
    why: 'The graveyard is counted as chapter I resolves.',
  },
  'Summon: Good King Mog XII': {
    effects: [
      { kind: 'tokens', n: 2, power: 1, toughness: 2, keywords: ['lifelink'], subtypes: ['moogle'], when: 'chapter', chapters: [1] },
      { kind: 'castCopiesToken', when: 'chapter', chapters: [2, 3] },
      { kind: 'counters', n: 2, all: true, subtype: 'moogle', other: true, when: 'chapter', chapters: [4] },
    ],
    notes: ['I: two 1/2 lifelink Moogles', 'II, III: this turn, each noncreature spell you cast makes a token copy of a non-Saga token you control', 'IV: two +1/+1 counters on each other Moogle you control'],
    why: 'Bots copy their best token for each noncreature spell on chapter turns.',
  },
  'Yuna, Hope of Spira': {
    effects: [
      { kind: 'anthem', p: 0, t: 0, keywords: ['trample', 'lifelink', 'ward'], only: 'enchantment', selfToo: true, yourTurn: true, when: 'static' },
      { kind: 'recursion', n: 1, toBattlefield: true, what: 'enchantment', finality: true, when: 'upkeep', at: 'end' },
    ],
    notes: ['During your turn, Yuna and your enchantment creatures have trample, lifelink and ward {2}', 'Your end step: an enchantment card from your graveyard returns with a finality counter'],
    why: 'The keywords only apply during your turn.',
  },
  'Make Your Own Luck': {
    effects: [{ kind: 'plotDig', n: 3, when: 'resolve' }],
    notes: ['Look at the top three: plot a nonland card among them, the rest into your hand'],
    why: 'The plotted card is cast free on a later turn as a sorcery (rule 702.170).',
  },
  'Tlincalli Hunter': {
    effects: [{ kind: 'altOnce', what: 'creatureFromExile', when: 'static' }],
    notes: ['Once each turn, pay {0} instead of the mana cost of a creature spell you cast from exile'],
    why: 'Used on the first creature spell cast from exile each turn.',
  },
  "River Song's Diary": {
    effects: [{ kind: 'diaryImprint', when: 'static' }, { kind: 'diaryCast', when: 'upkeep' }],
    notes: ['Instants and sorceries cast from a hand are exiled with it as they resolve', 'Your upkeep, with four or more cards exiled with it: cast one at random free'],
    why: 'Every player\'s instants and sorceries cast from hand go under it.',
  },
  'Coppercoat Vanguard': {
    effects: [{ kind: 'anthem', p: 1, t: 0, keywords: ['ward1'], other: true, subtype: 'human', when: 'static' }],
    notes: ['Other Humans you control get +1/+0 and ward {1}'],
    why: 'Only Humans, and the ward costs {1}.',
  },
  'The Great Henge': {
    effects: [
      { kind: 'mana', amount: 2, colors: ['G'], when: 'static' },
      { kind: 'gainLife', n: 2, when: 'activated', activation: act(cost(0), true) },
      { kind: 'draw', n: 1, when: 'creatureEnters', nontoken: true },
      { kind: 'counters', n: 1, all: false, when: 'creatureEnters', nontoken: true },
      { kind: 'selfDiscount', amount: 0, amountFrom: 'greatestPower', when: 'static' },
    ],
    notes: ['Costs {X} less, X = the greatest power among your creatures', '{T}: add {G}{G} and gain 2 life', 'When a nontoken creature you control enters: a +1/+1 counter on it and draw a card'],
    why: 'The discount is your greatest power as you cast it.',
  },
  'Dredge the Mire': {
    effects: [{ kind: 'dredgeMire', when: 'resolve' }],
    notes: ['Each opponent chooses a creature card in their graveyard; you put them onto the battlefield'],
    why: 'Opponents choose their least valuable creature card.',
  },
  'Fact or Fiction': {
    effects: [{ kind: 'piles', n: 5, when: 'resolve' }],
    notes: ['Reveal the top five; an opponent splits them into two piles; one to your hand, the other to your graveyard'],
    why: 'The opponent splits to give you as little as they can; you take the better pile.',
  },
  'Commune with Lava': {
    effects: [{ kind: 'exilePlay', n: -1, from: 'you', until: 'nextTurn', when: 'resolve' }],
    notes: ['Exile the top X cards of your library; play them until the end of your next turn'],
    why: 'X cards, as paid.',
  },
  'Commander Liara Portyr': {
    effects: [
      { kind: 'exileDiscount', amount: 0, amountFrom: 'playersAttacked', when: 'attack', scope: 'oneOrMore' },
      { kind: 'exilePlay', n: 0, amountFrom: 'playersAttacked', from: 'you', until: 'turn', castOnly: true, when: 'attack', scope: 'oneOrMore' },
    ],
    notes: ['Whenever you attack: spells you cast from exile this turn cost {X} less, then exile the top X cards; cast spells from among them this turn (X = players attacked)'],
    why: 'X is the number of players you attack.',
  },
  'Plargg and Nassari': {
    effects: [{ kind: 'freeCast', from: 'until', n: 0, who: 'each', only: 'nonland', casts: 2, rest: 'exile', oppExcludes: true, when: 'upkeep' }],
    notes: ['Your upkeep: each player exiles until a nonland card; an opponent picks one of those; cast up to two of the others free'],
    why: 'The opponent takes away the best of the exiled spells.',
  },
  'Wand of Wonder': {
    effects: [{ kind: 'wandOfWonder', when: 'activated', activation: act(cost(4), true) }],
    notes: ['{4}, {T}: roll a d20; each opponent exiles until an instant or sorcery; cast one (1-9), two (10-19) or three (20) of them free'],
    why: 'The roll decides how many of the exiled spells may be cast.',
  },
  'Selective Obliteration': {
    effects: [{ kind: 'selectiveOblit', when: 'resolve' }],
    notes: ["Each player chooses a color; exile each permanent unless it's colorless or only its controller's chosen color"],
    why: 'Each player names the color that saves the most of their permanents.',
  },
  'Darksteel Monolith': {
    effects: [{ kind: 'altOnce', what: 'colorlessFromHand', when: 'static' }],
    notes: ['Once each turn, pay {0} instead of the mana cost of a colorless spell you cast from your hand'],
    why: 'Used on the first colorless spell cast from hand each turn.',
  },
  'Calamity of the Titans': {
    effects: [{ kind: 'wipe', target: 'creatures', mode: 'exile', amount: 0, oneSided: false, belowReveal: true, walkers: true, when: 'resolve' }],
    notes: ['As an extra cost, reveal a colorless creature card from your hand', 'Exile each creature and planeswalker with mana value less than the revealed card\'s'],
    why: 'It can only be cast while you hold a colorless creature card; bots reveal their biggest.',
  },
  'Satoru Umezawa': {
    effects: [
      { kind: 'grantNinjutsu', cost: cost(2, [['U'], ['B']]), when: 'static' },
      { kind: 'lookPick', n: 3, rest: 'bottom', oncePerTurn: true, when: 'ninjutsu' },
    ],
    notes: ['Creature cards in your hand have ninjutsu {2}{U}{B}', 'Once each turn, when you activate ninjutsu: look at the top three, one to your hand, the rest on the bottom'],
    why: 'Every creature card in your hand can ninjutsu in for an unblocked attacker.',
  },
  'Stonehorn Dignitary': {
    effects: [{ kind: 'skipCombat', when: 'resolve' }],
    notes: ['When it enters: target opponent skips their next combat phase'],
    why: 'Bots aim it at the opponent most likely to attack them.',
  },
  'Bring to Light': {
    effects: [{ kind: 'search', what: 'creatureInstantSorcery', to: 'cast', n: 1, maxCmc: 0, amountFrom: 'colorsSpent', when: 'resolve' }],
    notes: ['Converge: find a creature, instant or sorcery with mana value up to the colors spent on it, and cast it free'],
    why: 'Counts the colors of mana actually spent on it.',
  },
  'Call Forth the Tempest': {
    effects: [{ kind: 'wipe', target: 'creatures', mode: 'damage', amount: 0, oneSided: true, amountFrom: 'otherSpellMv', when: 'resolve' }],
    notes: ["Damage to each opponent's creature equal to the total mana value of other spells you cast this turn"],
    why: 'Its two cascades count, since they are cast first.',
  },
  'Codie, Vociferous Codex': {
    effects: [
      { kind: 'castLock', who: 'you', rule: 'permanents', when: 'static' },
      { kind: 'codieNext', when: 'activated', activation: act(cost(4), true) },
    ],
    notes: ["You can't cast permanent spells", '{4}, {T}: add {W}{U}{B}{R}{G}; when you next cast a spell this turn, exile until an instant or sorcery with lesser mana value and cast it free this turn'],
    why: 'The five mana goes into your mana pool and empties at the end of the step.',
  },
  'Sphere of Safety': {
    effects: [{ kind: 'attackTax', amount: 0, amountFrom: 'enchantments', when: 'static' }],
    notes: ['Creatures attacking you or your planeswalkers cost {X} each, X = your enchantments'],
    why: 'X is counted as attackers are declared.',
  },
  'Tandem Lookout': {
    effects: [{ kind: 'soulbond', when: 'static' }],
    notes: ['Soulbond: paired with another creature; each of the pair draws a card when it deals damage to an opponent'],
    why: 'It pairs when it or another creature enters (rule 702.95).',
  },
  Aetherspouts: {
    effects: [{ kind: 'fog', who: 'all', bounce: true, tuck: true, when: 'resolve' }],
    notes: ['Each attacking creature goes on top or bottom of its owner\'s library, owner\'s choice'],
    why: 'Every attacking creature, not only those attacking you; owners put theirs on top.',
  },
  'Curse of the Swine': {
    effects: [{ kind: 'removal', target: 'creature', mode: 'exile', amount: 0, multi: 'x', boar: true, when: 'resolve' }],
    notes: ['Exile X target creatures; each one\'s controller makes a 2/2 Boar'],
    why: 'Up to X targets.',
  },
  'Accursed Witch': {
    effects: [
      { kind: 'aimedDiscount', amount: 1, when: 'static' },
      { kind: 'returnAs', as: 'curseOnOpponent', curse: [{ on: 'theirUpkeep', act: 'drain', n: 1 }], backEffects: [{ kind: 'aimedDiscount', amount: 1, when: 'static' }], when: 'creatureDies', scope: 'self' },
    ],
    notes: ["Opponents' spells that target it cost {1} less", 'When it dies, it returns as Infectious Curse on an opponent: your spells aimed at them cost {1} less, and they lose 1 and you gain 1 each upkeep of theirs'],
    why: 'The back face is an Aura curse on the opponent bots most want to drain.',
  },
  "Demon of Fate's Design": {
    effects: [
      { kind: 'altOnce', what: 'enchantmentForLife', when: 'static' },
      { kind: 'pump', p: 1, t: 0, protect: false, self: true, amountFrom: 'sacrificedMv', when: 'activated', activation: act(cost(2, [['B']]), false, { sacOther: { what: 'enchantment', n: 1 } }) },
    ],
    notes: ['Once during each of your turns, cast an enchantment spell by paying life equal to its mana value', '{2}{B}, sacrifice another enchantment: +X/+0 this turn, X = its mana value'],
    why: 'Bots pay life only when they can spare it.',
  },
  'Hallowed Haunting': {
    effects: [
      { kind: 'anthem', p: 0, t: 0, keywords: ['flying', 'vigilance'], minEnchantments: 7, when: 'static' },
      { kind: 'tokens', n: 1, power: 0, toughness: 0, keywords: [], subtypes: ['spirit', 'cleric'], ptFrom: 'spirits', castFilter: 'enchantment', when: 'cast' },
    ],
    notes: ['With seven or more enchantments, your creatures have flying and vigilance', 'Whenever you cast an enchantment spell: a Spirit Cleric with power and toughness equal to your Spirits'],
    why: 'The Spirit tokens grow with every Spirit you control.',
  },
  'Kratos, God of War': {
    effects: [
      { kind: 'anthem', p: 0, t: 0, keywords: ['haste'], everyone: true, when: 'static' },
      { kind: 'idleDamage', when: 'upkeep', at: 'end', whose: 'each' },
    ],
    notes: ['All creatures have haste', "Each player's end step: damage to them for each creature they control that didn't attack this turn"],
    why: 'Opponents\' creatures get haste too.',
  },
  Necromancy: {
    keywords: ['flash'],
    effects: [{ kind: 'necromancy', when: 'resolve' }],
    notes: ['Return a creature card from a graveyard to the battlefield under your control; it is sacrificed when this leaves', 'Cast at instant speed, it is sacrificed at the next cleanup'],
    why: 'Bots cast it at sorcery speed unless an end-of-turn steal is worth it.',
  },
  'Living Death': {
    effects: [{ kind: 'livingDeath', when: 'resolve' }],
    notes: ['Each player exiles their graveyard\'s creature cards, sacrifices their creatures, then puts the exiled cards onto the battlefield'],
    why: 'All three steps happen for every player at once.',
  },
  "Vraska, Betrayal's Sting": {
    effects: [
      { kind: 'draw', n: 1, when: 'loyalty', loyalty: 0 },
      { kind: 'loseLife', n: 1, when: 'loyalty', loyalty: 0 },
      { kind: 'counters', n: 1, all: true, proliferate: true, when: 'loyalty', loyalty: 0 },
      { kind: 'becomeTreasure', when: 'loyalty', loyalty: -2 },
      { kind: 'poison', n: 9, who: 'target', upTo: 9, when: 'loyalty', loyalty: -9 },
    ],
    notes: ['0: draw a card, lose 1 life, proliferate', '-2: target creature becomes a Treasure artifact with "{T}, sacrifice: add one mana of any color" and nothing else', '-9: target player goes up to nine poison counters'],
    why: 'The creature stays on the battlefield as a Treasure under its controller.',
  },
  'Phyresis Outbreak': {
    effects: [
      { kind: 'poison', n: 1, who: 'opponents', when: 'resolve' },
      { kind: 'wipe', target: 'creatures', mode: 'damage', amount: 0, oneSided: true, shrink: 'temp', perPoison: true, when: 'resolve' },
    ],
    notes: ["Each opponent gets a poison counter, then their creatures get -1/-1 this turn for each poison counter that player has"],
    why: 'Each opponent\'s creatures shrink by that opponent\'s own poison count.',
  },
  'Thrumming Stone': {
    effects: [{ kind: 'ripple', n: 4, when: 'cast' }],
    notes: ['Spells you cast have ripple 4: cast free any with the same name from the top four'],
    why: 'Cards cast this way ripple again.',
  },
  'Skrelv, Defector Mite': {
    effects: [{ kind: 'protectColor', toxic: 1, hexproofUnblockable: true, when: 'activated', activation: act(cost(0, [], 2), true) }],
    notes: ['{W/P}, {T}: another creature you control gains toxic 1 and hexproof from a color this turn, and can\'t be blocked by creatures of that color'],
    why: 'Bots name the color of the opponents\' blockers and removal.',
  },
  'Razorfield Ripper': {
    effects: [
      { kind: 'energy', n: 1, when: 'attack', scope: 'self' },
      { kind: 'pump', p: 1, t: 1, protect: false, self: true, amountFrom: 'energy', when: 'attack', scope: 'self' },
      { kind: 'equip', p: 0, t: 0, keywords: [], aura: false, cost: cost(2), reconfigure: true, when: 'static' },
    ],
    notes: ['Whenever it or equipped creature attacks: you get {E}, then it gets +X/+X this turn, X = your energy', 'Reconfigure {2} or {E}{E}{E}'],
    why: 'Reconfigure (rule 702.151): attached, it is not a creature.',
  },
  'Aether Spike': {
    effects: [{ kind: 'energy', n: 2, when: 'resolve' }, { kind: 'energyCounter', when: 'resolve' }],
    notes: ['You get {E}{E}, then pay any amount of {E}: counter target spell unless its controller pays {1} for each'],
    why: 'Bots pay all their energy.',
  },
  'Suppression Ray': {
    effects: [{ kind: 'tapAllOf', stunEnergy: true, when: 'resolve' }],
    notes: ['Tap all creatures target player controls; pay any amount of {E} to stun that many of them'],
    why: 'Bots stun the biggest ones with all their energy.',
  },
  'Price of Fame': {
    effects: [
      { kind: 'removal', target: 'creature', mode: 'destroy', amount: 0, when: 'resolve' },
      { kind: 'scry', n: 2, surveil: true, when: 'resolve' },
    ],
    notes: ['Destroy target creature; surveil 2', 'Costs {2} less if it targets a legendary creature'],
    why: 'The discount depends on the target chosen.',
  },
  "Ephara's Dispersal": {
    effects: [
      { kind: 'removal', target: 'creature', mode: 'bounce', amount: 0, when: 'resolve' },
      { kind: 'scry', n: 2, surveil: true, when: 'resolve' },
    ],
    notes: ["Return target creature to its owner's hand; surveil 2", 'Costs {2} less if it targets an attacking creature'],
    why: 'The discount depends on the target chosen.',
  },
  "Patriarch's Bidding": {
    effects: [{ kind: 'patriarch', when: 'resolve' }],
    notes: ['Each player chooses a creature type; each player returns all creature cards of a chosen type from their graveyard'],
    why: 'Each player names the type with the most value in their own graveyard.',
  },
  'Wick, the Whorled Mind': {
    effects: [
      { kind: 'tokens', n: 1, power: 1, toughness: 1, keywords: [], subtypes: ['snail'], elseCounterOn: 'snail', when: 'resolve' },
      { kind: 'tokens', n: 1, power: 1, toughness: 1, keywords: [], subtypes: ['snail'], elseCounterOn: 'snail', ofType: 'rat', when: 'creatureEnters' },
      { kind: 'drain', n: 0, gain: 0, damage: true, amountFrom: 'sacrificed', when: 'activated', activation: act(cost(0, [['U'], ['B'], ['R']]), false, { sacCreature: true, sacType: 'snail' }) },
      { kind: 'draw', n: 0, amountFrom: 'sacrificed', rider: true, when: 'activated', activation: act(cost(0, [['U'], ['B'], ['R']]), false, { sacCreature: true, sacType: 'snail' }) },
    ],
    notes: ['When it or another Rat enters: a 1/1 Snail if you have none, else a +1/+1 counter on a Snail', '{U}{B}{R}, sacrifice a Snail: damage to each opponent equal to its power, then draw that many'],
    why: 'The Snail grows with each Rat until it is cashed in.',
  },
  'Witch-king of Angmar': {
    effects: [
      { kind: 'pump', p: 0, t: 0, protect: false, grant: ['indestructible'], self: true, tapSelf: true, when: 'activated', activation: act(cost(0), false, { discard: 1 }) },
      { kind: 'sacHitters', when: 'combatDamagedYou' },
      { kind: 'ringTempts', when: 'combatDamagedYou' },
    ],
    notes: ['Discard a card: indestructible this turn, and tap it', 'When creatures deal combat damage to you: each opponent sacrifices one of them, and the Ring tempts you'],
    why: 'Only the creatures that hit you this turn can be sacrificed.',
  },
  "Sauron's Ransom": {
    effects: [{ kind: 'piles', n: 4, faceDown: true, when: 'resolve' }, { kind: 'ringTempts', when: 'resolve' }],
    notes: ['An opponent splits your top four into a face-down and a face-up pile; one to your hand, the other to your graveyard', 'The Ring tempts you'],
    why: 'You don\'t see the face-down pile when you choose.',
  },
  'Perimeter Captain': {
    effects: [{ kind: 'gainLife', n: 2, when: 'defenderBlocks' }],
    notes: ['Whenever a creature you control with defender blocks: gain 2 life'],
    why: 'Once for each of your defenders that blocks.',
  },
  "Huatli, the Sun's Heart": {
    effects: [
      { kind: 'toughnessMatters', defenders: false, yours: true, when: 'static' },
      { kind: 'gainLife', n: 0, amountFrom: 'greatestToughness', when: 'loyalty', loyalty: -3 },
    ],
    notes: ['Your creatures deal combat damage equal to their toughness', '-3: gain life equal to your greatest toughness'],
    why: 'Counted as the ability resolves.',
  },
  'Wave of Reckoning': {
    effects: [{ kind: 'wipe', target: 'creatures', mode: 'damage', amount: 0, oneSided: false, selfPower: true, when: 'resolve' }],
    notes: ['Each creature deals damage to itself equal to its power'],
    why: 'Each creature uses its own power.',
  },
  'Angelic Chorus': {
    effects: [{ kind: 'gainLife', n: 0, amountFrom: 'subjectToughness', when: 'creatureEnters' }],
    notes: ['When a creature you control enters: gain life equal to its toughness'],
    why: 'Its toughness as the trigger resolves.',
  },
  'Kefka, Court Mage': {
    effects: [
      { kind: 'discardTypesDraw', when: 'resolve' },
      { kind: 'discardTypesDraw', when: 'attack', scope: 'self' },
      { kind: 'sacPermanents', who: 'opponents', n: 1, when: 'activated', activation: act(cost(8), false, { sorcery: true }) },
      { kind: 'transform', when: 'activated', activation: act(cost(8), false, { sorcery: true }), rider: true },
    ],
    notes: ['When it enters or attacks: each player discards a card, then you draw a card for each card type among them', '{8}: each opponent sacrifices a permanent; transform it'],
    why: 'Card types counted among all the discarded cards.',
  },
  'Cranial Ram': {
    effects: [
      { kind: 'tokens', n: 1, power: 0, toughness: 0, keywords: [], subtypes: ['phyrexian', 'germ'], attachSource: true, when: 'resolve' },
      { kind: 'equip', p: 0, t: 1, keywords: [], aura: false, amountFrom: 'artifacts', cost: cost(2), when: 'static' },
    ],
    notes: ['Living weapon', 'Equipped creature gets +X/+1, X = your artifacts', 'Equip {2}'],
    why: 'X is counted whenever its power is looked at.',
  },
  'Earth-Cult Elemental': {
    effects: [{ kind: 'sacPermanents', who: 'each', n: 1, roll: true, when: 'resolve' }],
    notes: ['When it enters, roll a d20: 1-9 each player sacrifices a permanent; 10-19 each opponent does; 20 each opponent sacrifices two'],
    why: 'The roll decides who sacrifices.',
  },
  'Perception Bobblehead': {
    effects: [
      { kind: 'mana', amount: 1, colors: 'any', when: 'static' },
      { kind: 'freeCast', from: 'top', n: 0, amountFrom: 'bobbleheads', who: 'you', maxCmc: 3, casts: 1, rest: 'bottom', when: 'activated', activation: act(cost(3), true) },
    ],
    notes: ['{T}: add one mana of any color', '{3}, {T}: look at the top X, X = your Bobbleheads; cast one with mana value 3 or less free'],
    why: 'X counts your Bobbleheads as it resolves.',
  },
  "Jace's Mindseeker": {
    effects: [
      { kind: 'mill', n: 5, who: 'target', when: 'resolve' },
      { kind: 'freeCast', from: 'milled', n: 0, who: 'targetController', only: 'instantSorcery', casts: 1, when: 'resolve' },
    ],
    notes: ['When it enters: target opponent mills five; cast an instant or sorcery from among them free'],
    why: 'Only the five cards just milled.',
  },
  'Jace, Memory Adept': {
    effects: [
      { kind: 'draw', n: 1, when: 'loyalty', loyalty: 1 },
      { kind: 'mill', n: 1, who: 'target', when: 'loyalty', loyalty: 1 },
      { kind: 'mill', n: 10, who: 'target', when: 'loyalty', loyalty: 0 },
      { kind: 'draw', n: 20, opponents: true, when: 'loyalty', loyalty: -7 },
    ],
    notes: ['+1: draw a card; target player mills one', '0: target player mills ten', '-7: any number of target players draw twenty'],
    why: 'Bots aim the -7 at their opponents, to empty their libraries.',
  },
  'Ichormoon Gauntlet': {
    effects: [
      { kind: 'pwAbilities', when: 'static' },
      { kind: 'oneCounter', castFilter: 'noncreature', when: 'cast' },
    ],
    notes: ['Your planeswalkers have [0]: proliferate and [-12]: take an extra turn', 'Whenever you cast a noncreature spell: one more of a counter already on target permanent'],
    why: 'One counter of one kind on one permanent.',
  },
  'Dovin, Hand of Control': {
    effects: [
      { kind: 'spellTax', amount: 1, filter: 'artifactInstantSorcery', when: 'static' },
      { kind: 'fog', who: 'creature', when: 'loyalty', loyalty: -1 },
    ],
    notes: ['Artifact, instant and sorcery spells your opponents cast cost {1} more', '-1: prevent damage to and by an opponent\'s permanent'],
    why: 'Only artifacts, instants and sorceries are taxed.',
  },
  'Soulless Jailer': {
    effects: [
      { kind: 'graveyardLock', enterOnly: true, when: 'static' },
      { kind: 'castLock', who: 'all', rule: 'graveyard', when: 'static' },
    ],
    notes: ["Permanent cards in graveyards can't enter the battlefield", "No one can cast noncreature spells from graveyards or exile"],
    why: 'Creature spells can still be cast from graveyards.',
  },
  'Land Tax': {
    effects: [{ kind: 'search', what: 'basicLand', to: 'hand', n: 3, ifCond: { k: 'oppMoreLands' }, when: 'upkeep' }],
    notes: ['Your upkeep, if an opponent controls more lands: up to three basic lands into your hand'],
    why: 'Checked as the trigger resolves too.',
  },
  "Alchemist's Retrieval": {
    effects: [{ kind: 'saveBounce', when: 'resolve' }],
    notes: ["Return target nonland permanent you control (with cleave, any nonland permanent) to its owner's hand"],
    why: 'Bots save their own permanent from removal, or cleave to bounce an opponent\'s.',
  },
  'March of Swirling Mist': {
    effects: [{ kind: 'phaseOut', multi: 'x', when: 'resolve' }],
    notes: ['Up to X target creatures phase out', 'Exile blue cards from your hand to pay {2} less each'],
    why: 'Phased-out creatures come back at their controller\'s next untap step (rule 702.26).',
  },
  'Mana Vault': {
    effects: [
      { kind: 'untap', what: 'self', n: 1, mayPay: 4, ifTapped: true, when: 'upkeep' },
      { kind: 'loseLife', n: 1, ifTapped: true, when: 'upkeep', at: 'draw' },
      { kind: 'mana', amount: 3, colors: ['C'], when: 'static' },
    ],
    notes: ["Doesn't untap during your untap step", 'Your upkeep: you may pay {4} to untap it', 'Your draw step: 1 damage to you if it is tapped', '{T}: add {C}{C}{C}'],
    why: 'The {4} is paid when it is tapped and the mana can be spared.',
  },
  Clockspinning: {
    effects: [{ kind: 'oneCounter', either: true, when: 'resolve' }],
    notes: ['Remove a counter from target permanent, or put another of that kind on it'],
    why: 'Bots add to their own and remove from opponents\'.',
  },
  'Pollywog Prodigy': {
    effects: [
      { kind: 'evolve', when: 'static' },
      { kind: 'draw', n: 1, castFilter: 'noncreature', ifCond: { k: 'spellBelowPower' }, when: 'opponentCast' },
    ],
    notes: ['Evolve', "When an opponent casts a noncreature spell with mana value less than its power: draw a card"],
    why: 'Evolve compares power and toughness as each creature enters (rule 702.100).',
  },
  'Midnight Banshee': {
    effects: [{ kind: 'wipe', target: 'creatures', mode: 'damage', amount: 1, oneSided: false, shrink: 'counters', nonblack: true, when: 'upkeep' }],
    notes: ['Your upkeep: a -1/-1 counter on each nonblack creature'],
    why: 'Every nonblack creature, yours too.',
  },
  'Seal of the Guildpact': {
    effects: [{ kind: 'colorDiscount', when: 'static' }],
    notes: ['As it enters, choose two colors; your spells cost {1} less for each of them they are'],
    why: 'The two colors are the ones most of its owner\'s cards are.',
  },
  'Mauhúr, Uruk-hai Captain': {
    effects: [{ kind: 'extraCounter', types: ['army', 'goblin', 'orc'], when: 'static' }],
    notes: ['One more +1/+1 counter whenever counters go on an Army, Goblin or Orc you control'],
    why: 'Plus one, not doubled.',
  },
  'Many Partings': {
    effects: [
      { kind: 'search', what: 'basicLand', to: 'hand', n: 1, when: 'resolve' },
      { kind: 'artifactToken', token: 'food', n: 1, when: 'resolve' },
    ],
    notes: ['A basic land into your hand', 'A Food'],
    why: 'A real land search.',
  },
  'Pest Infestation': {
    effects: [
      { kind: 'removal', target: 'artifactEnchantment', mode: 'destroy', amount: 0, multi: 'x', when: 'resolve' },
      { kind: 'tokens', n: 0, amountFrom: 'x', xTimes: 2, power: 1, toughness: 1, keywords: [], subtypes: ['pest'], diesGain: 1, when: 'resolve' },
    ],
    notes: ['Destroy up to X artifacts and/or enchantments', 'Twice X 1/1 Pests with "when this dies, gain 1 life"'],
    why: 'X targets and 2X Pests.',
  },
  'Trail of Crumbs': {
    effects: [
      { kind: 'artifactToken', token: 'food', n: 1, when: 'resolve' },
      { kind: 'lookPick', n: 2, only: 'permanent', rest: 'bottom', mayPay: 1, when: 'sacrificeFood' },
    ],
    notes: ['When it enters: a Food', 'Whenever you sacrifice a Food, you may pay {1}: look at the top two, a permanent card to your hand, the rest on the bottom'],
    why: 'The {1} is paid as the trigger resolves.',
  },
  'Phyrexian Unlife': {
    effects: [
      { kind: 'cantLose', lifeOnly: true, when: 'static' },
      { kind: 'cantLose', lifeOnly: true, infect: true, when: 'static' },
    ],
    notes: ["You don't lose for having 0 or less life", 'At 0 or less life, damage to you is dealt as poison counters'],
    why: 'Only damage turns into poison; other life loss still lowers your life.',
  },
  "Angel's Grace": {
    keywords: ['split second'],
    effects: [{ kind: 'graceTurn', when: 'resolve' }],
    notes: ["You can't lose and opponents can't win this turn; damage can't take you below 1 life this turn", 'Split second'],
    why: 'Split second (rule 702.61): nothing but mana abilities while it is on the stack.',
  },
  'Professor Onyx': {
    effects: [
      { kind: 'drain', n: 2, gain: 2, when: 'cast', castFilter: 'instantSorcery' },
      { kind: 'loseLife', n: 1, when: 'loyalty', loyalty: 1 },
      { kind: 'lookPick', n: 3, rest: 'graveyard', when: 'loyalty', loyalty: 1 },
      { kind: 'removal', target: 'creature', mode: 'edict', amount: 0, each: 'opponents', biggest: true, when: 'loyalty', loyalty: -3 },
      { kind: 'discardOrLose', times: 7, life: 3, when: 'loyalty', loyalty: -8 },
    ],
    notes: ['Magecraft: drain each opponent 2', '+1: lose 1 life; one of the top three to hand, the rest to the graveyard', '-3: each opponent sacrifices a creature with the greatest power they control', '-8: seven times, each opponent discards a card or loses 3 life'],
    why: 'Opponents discard while they have cards they can spare.',
  },
};
