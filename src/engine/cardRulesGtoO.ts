// Card-specific rules for one-off cards whose names start with G through O (see cardRules.ts for how
// entries work). Kept in their own file so the threads adding A–F and P–Z don't edit the same lines.
// Entries are in alphabetical order.
//
// Texts were written from each card's Oracle text; `why` says what is played differently and why.

import type { CardRule } from './cardRules';
import type { Effect } from './types';

/** "Sacrifice ~: ... gain hexproof and indestructible until end of turn" (Jirina, King Darien). */
const SAC_PROTECT: Effect = { kind: 'protect', all: true, when: 'activated', activation: { cost: { generic: 0, pips: [], x: 0, life: 0 }, tap: false, sacrifice: true } };

export const CARD_RULES_G_TO_O: Record<string, CardRule> = {
  'Game Plan': {
    text: 'Assist\nEach player shuffles their hand and graveyard into their library, then draws seven cards. Exile ~.',
    why: 'Assist (rule 702.132) lets another player help pay; bots pay the whole cost themselves.',
  },
  'General Kudro of Drannith': {
    text: "Other Humans you control get +1/+1.\nWhenever ~ or another Human you control enters, exile target card from an opponent's graveyard.\n{2}, Sacrifice a creature: Destroy target creature with power 4 or greater.",
    why: 'Sacrificing two Humans is played as one creature. The target still must have power 4 or more.',
  },
  "General's Enforcer": {
    text: '{2}{W}{B}: Exile target card from a graveyard. If it was a creature card, create a 1/1 white Human Soldier creature token.',
    add: [{ kind: 'commanderKeywords', keywords: ['indestructible'], when: 'static' }],
    notes: ['Your commanders have indestructible'],
    why: '"Legendary Humans you control have indestructible": played as your commanders, the legendary Humans in its decks.',
  },
  'Generous Plunderer': {
    text: 'Menace\nAt the beginning of your upkeep, you may create a Treasure token. When you do, target opponent creates a tapped Treasure token.\nWhenever ~ attacks, it deals 2 damage to target opponent.',
    why: 'Damage equal to the artifacts the defending player controls is played as 2: mostly the Treasures it hands out.',
  },
  'Ghalta, Primal Hunger': {
    text: 'Trample\n~ costs {2} less to cast for each creature you control.',
    why: 'Costs {X} less where X is your creatures\' total power: played as {2} for each creature you control.',
  },
  'Ghostly Pilferer': {
    text: "Whenever an opponent casts a spell from anywhere other than their hand, draw a card.\nDiscard a card: ~ can't be blocked this turn.\nAt the beginning of your upkeep, you may pay {2}. If you do, draw a card.",
    why: '"Whenever this becomes untapped, you may pay {2} to draw": it untaps in your untap step, so it is played at your upkeep.',
  },
  'Gilded Drake': {
    effects: [
      { kind: 'steal', from: 'battlefield', when: 'resolve' },
      { kind: 'sacrificeSelf', when: 'resolve' },
    ],
    notes: ['Exchange: take an opponent\'s best creature; the Drake leaves you'],
    why: 'Exchange of control (rule 701.12b): you get their creature for good. The Drake goes to that opponent; here it is sacrificed instead.',
  },
  Glamdring: {
    text: 'Equipped creature has first strike and gets +1/+0 for each instant and sorcery card in your graveyard.\nWhenever equipped creature deals combat damage to a player, you may cast a spell with mana value 3 or less from your hand without paying its mana cost.\nEquip {3}',
    why: 'The free spell may have mana value up to the damage dealt and must be an instant or sorcery: played as mana value 3 or less.',
  },
  Glamerdye: {
    text: 'Retrace',
    why: 'Changing a color word in a card\'s text is not played: bots never cast it.',
  },
  'Gnat Miser': {
    text: '',
    add: [{ kind: 'handSize', n: -1, who: 'opponents', when: 'static' }],
    notes: ["Opponents' maximum hand size is one smaller"],
    why: 'Rule 402.2: each opponent discards down to six at cleanup.',
  },
  'Gonti, Night Minister': {
    effects: [{ kind: 'exilePlay', n: 1, from: 'targetController', until: 'exiled', anyMana: true, when: 'combatDamage', scope: 'any' }],
    notes: ["When one of your creatures hits a player: exile their top card; you may play it, with mana of any type"],
    why: 'Only your own creatures are played (opponents\' creatures hitting other opponents would give them the card). The Treasure for casting a spell you don\'t own is left out.',
  },
  "Gossip's Talent": {
    text: "Whenever a creature you control enters, surveil 1.\n{1}{U}: Level 2\nWhenever you attack, target creature can't be blocked this turn.\n{3}{U}: Level 3",
    why: 'Level 2 only works on a creature with power 3 or less; played on any attacker. Level 3 (blinking a creature that hit a player) is left out.',
  },
  'Gothmog, Morgul Lieutenant': {
    text: 'When ~ enters, amass Orcs 1.',
    add: [{ kind: 'anthem', p: 0, t: 0, keywords: ['deathtouch'], only: 'token', when: 'static' }],
    notes: ['Your creature tokens have deathtouch'],
    why: 'Creature tokens you control have deathtouch.',
  },
  'Grafted Butcher': {
    text: 'When ~ enters, creatures you control gain menace until end of turn.\nOther Phyrexians you control get +1/+1.\n{3}{B}, Sacrifice a creature: Return ~ from your graveyard to the battlefield. Activate only as a sorcery.',
    why: 'Menace goes to Phyrexians only; played on all your creatures, which are mostly Phyrexians in its deck. Sacrificing an artifact instead of a creature is left out.',
  },
  "Graywater's Fixer": {
    text: '',
    why: 'Giving outlaw cards in your graveyard encore is left out: it plays as a 4/4.',
  },
  'Green Slime': {
    text: 'Flash\nWhen ~ enters, destroy target artifact or enchantment.\nForetell {G}',
    why: 'Countering an artifact or enchantment\'s ability destroys that permanent: bots use it on the best artifact or enchantment, ability or not.',
  },
  'Grell Philosopher': {
    text: '',
    why: 'Borrowing the activated abilities of an opponent\'s artifact is left out: it plays as a 1/4.',
  },
  'Grim Hireling': {
    text: 'Whenever one or more creatures you control deal combat damage to a player, create two Treasure tokens.\n{3}{B}: Target creature gets -3/-3 until end of turn. Activate only as a sorcery.',
    why: '"{B}, Sacrifice X Treasures: -X/-X": Treasures are mana here, so it is played as {3}{B} for -3/-3.',
  },
  'Grond, the Gatebreaker': {
    text: 'Trample\nCrew 3',
    why: 'Being a creature on your turn while you control an Army is left out; it is crewed instead.',
  },
  'Grudge Keeper': {
    text: '',
    why: 'Voting: bots vote together in this engine, so its drain never happens. It plays as a 2/1.',
  },
  'Hammer of Purphoros': {
    text: 'Creatures you control have haste.\n{3}{R}, {T}: Create a 3/3 colorless Golem enchantment artifact creature token.',
    why: 'Sacrificing a land is played as one more mana in the cost.',
  },
  'Hand of the Praetors': {
    text: 'Infect\nOther creatures you control get +1/+1.\nWhenever you cast a creature spell with infect, target player gets a poison counter.',
    why: 'The anthem is for creatures with infect only; in its deck that is nearly all of them.',
  },
  'Harper Recruiter': {
    text: 'Flying\nWhenever ~ attacks, draw a card.',
    why: 'Taking each Cleric, Rogue, Warrior and Wizard from the top four is played as one card.',
  },
  Harrow: {
    text: 'Search your library for a basic land card, put it onto the battlefield, then shuffle.',
    why: 'Sacrificing a land for two untapped basics is played as one basic: the same land count.',
  },
  'Heart of Ramos': {
    text: '{T}: Add {R}.',
    why: 'Sacrificing it for one more mana is left out.',
  },
  'Heartless Hidetsugu': {
    text: '',
    why: 'Halving every player\'s life, yours included, is left out: bots can\'t yet judge when that helps them. It plays as a 4/3.',
  },
  'Herald of Hadar': {
    text: '{5}{B}: Each opponent loses 2 life and you gain 2 life.',
    why: 'The d20: 10–19 is the common result and is what is played; the Treasures on a 20 are left out.',
  },
  'Heraldic Banner': {
    text: 'Creatures you control get +1/+0.\n{T}: Add one mana of any color.',
    why: 'The chosen color is the one its creatures share.',
  },
  'Herd Heirloom': {
    text: '{T}: Add one mana of any color.\n{T}: Target creature you control gains trample until end of turn.',
    why: 'The creature-only restriction on the mana and the card drawn on combat damage are left out.',
  },
  'High Alert': {
    text: 'Each creature you control assigns combat damage equal to its toughness rather than its power.\n{2}{W}{U}: Untap target creature.',
    why: 'Letting defenders attack is played by the toughness rule: its walls attack.',
  },
  "Historian's Boon": {
    text: 'Whenever ~ or another nontoken enchantment you control enters, create a 1/1 white Soldier creature token.',
    why: 'The 4/4 Angel when a Saga ends is left out.',
  },
  'Hoarding Ogre': {
    text: 'Whenever ~ attacks, create two Treasure tokens.',
    why: 'The d20 makes one, two or three Treasures; played as two, about the average.',
  },
  'Hostile Investigator': {
    text: 'When ~ enters, target opponent discards a card.\nWhenever an opponent discards a card, draw a card. This ability triggers only once each turn.',
    why: 'The Clue is played as a card drawn. Your own discards also make one; left out.',
  },
  'Huddle Up': {
    text: 'Assist\nDraw a card.',
    why: 'The second player who draws is left out. Assist: bots pay the whole cost themselves.',
  },
  'Idol of False Gods': {
    text: '{1}{C}, {T}: Create a 0/1 colorless Eldrazi Spawn creature token with "Sacrifice this token: Add {C}."\nWhenever another Eldrazi you control dies, put a +1/+1 counter on ~.',
    why: 'Becoming an 8/8 annihilator with eight counters is left out.',
  },
  'Ignoble Hierarch': {
    text: '{T}: Add {B}, {R}, or {G}.',
    why: 'Exalted (+1/+1 when a creature attacks alone) is left out.',
  },
  'Illusion of Choice': {
    text: 'Draw a card.',
    why: 'Choosing how everyone votes: bots vote together here, so only the card matters.',
  },
  'Imoti, Celebrant of Bounty': {
    text: 'Cascade',
    add: [{ kind: 'freeCast', from: 'until', n: 0, who: 'you', only: 'nonland', maxCmc: -2, casts: 1, rest: 'bottom', when: 'cast', castFilter: 'any', minCmc: 6 }],
    notes: ['Your spells with mana value 6 or more have cascade'],
    why: 'Cascade (rule 702.85) on its own spell and on your spells with mana value 6 or more.',
  },
  'Ingenious Artillerist': {
    text: 'Whenever an artifact you control enters, ~ deals 1 damage to each opponent.',
    why: '"One or more artifacts ... that much damage": one damage for each artifact.',
  },
  'Insidious Roots': {
    text: 'Creature tokens you control have "{T}: Add one mana of any color."',
    why: 'The Plant token when creature cards leave your graveyard is left out.',
  },
  'Inspiring Statuary': {
    text: 'Noncreature spells you cast cost {1} less to cast.',
    why: 'Improvise for nonartifact spells: tapping artifacts pays generic mana. Played as {1} less for noncreature spells.',
  },
  'Inti, Seneschal of the Sun': {
    text: 'Whenever you attack, put a +1/+1 counter on target creature.\nWhenever you discard a card, exile the top card of your library. You may play that card until the end of your next turn.',
    why: 'The discard that pays for the +1/+1 counter is left out (and the trample). Discarding several cards at once triggers once for each card.',
  },
  'Iroh, Dragon of the West': {
    text: 'Haste\nMentor\nFirebending 2',
    why: 'Firebending 2 goes to each of your creatures with a counter; played as Iroh\'s own.',
  },
  'Iroh, Firebending Instructor': {
    text: 'Whenever ~ attacks, creatures you control get +1/+1 until end of turn.',
    why: 'Only attacking creatures get +1/+1; bots attack with most of them.',
  },
  'Iron Mastiff': {
    effects: [
      { kind: 'damagePlayer', n: 4, when: 'attack', scope: 'self', chance: 0.55 },
      { kind: 'loseLife', n: 4, when: 'attack', scope: 'self', chance: 0.45 },
    ],
    notes: ['On attack: d20 — 4 damage to the defending player (10+) or to you (1–9)'],
    why: 'One d20 for one defending player: 1–9 hurts you, 10 or more hurts the opponent. A 20 hitting each opponent is played as one.',
  },
  'Ironsoul Enforcer': {
    text: 'Whenever ~ attacks, return target artifact card from your graveyard to the battlefield.',
    why: '"Attacks alone": played on any attack by it. A commander attacking alone is left out.',
  },
  "Jace's Phantasm": {
    text: 'Flying',
    why: '+4/+4 while an opponent has ten cards in their graveyard is left out.',
  },
  "Jace's Projection": {
    text: 'Whenever you draw a card, put a +1/+1 counter on ~.',
    why: 'Loyalty counters on a Jace are left out.',
  },
  'Jaheira, Friend of the Forest': {
    text: 'Creature tokens you control have "{T}: Add one mana of any color."',
    why: 'All tokens tap for {G}: played for creature tokens (Treasures already make mana).',
  },
  'Jan Jansen, Chaos Crafter': {
    text: 'Haste\n{T}, Sacrifice a creature: Create two Treasure tokens.',
    why: 'Sacrificing an artifact creature is played as any creature. Turning a noncreature artifact into two 1/1 Constructs is left out.',
  },
  'Jeskai Barricade': {
    text: 'Flash\nDefender',
    why: 'Returning one of your creatures to hand is left out.',
  },
  'Jin-Gitaxias, Core Augur': {
    text: 'Flash\nAt the beginning of your end step, draw seven cards.',
    add: [{ kind: 'handSize', n: -7, who: 'opponents', when: 'static' }],
    notes: ["Opponents' maximum hand size is 0"],
    why: 'Rule 402.2: opponents discard their whole hand at cleanup.',
  },
  'Jirina, Dauntless General': {
    text: "When ~ enters, exile target player's graveyard.",
    add: [SAC_PROTECT],
    notes: ['Sacrifice it: your permanents gain hexproof and indestructible this turn'],
    why: 'Only Humans gain hexproof and indestructible; played on all your permanents.',
  },
  'Join the Dead': {
    text: 'Target creature gets -5/-5 until end of turn.',
    why: 'Descend 4 (-10/-10) is left out.',
  },
  'Kamiz, Obscura Oculus': {
    text: "Whenever you attack, target creature can't be blocked this turn.",
    why: 'The connive and the double strike for a smaller attacker are left out.',
  },
  'Kardur, Doomscourge': {
    text: 'When ~ enters, until your next turn, creatures your opponents control attack each combat if able and attack a player other than you if able.\nWhenever a creature an opponent controls dies, each opponent loses 1 life and you gain 1 life.',
    why: '"Whenever an attacking creature dies": played on opponents\' creatures dying, mostly in the combats it forces.',
  },
  'Karumonix, the Rat King': {
    text: 'Toxic 1\nWhen ~ enters, draw two cards.',
    why: 'Taking every Rat in the top five is played as two cards. Toxic for other Rats is left out.',
  },
  'Katsumasa, the Animator': {
    text: 'Flying\n{2}{U}: Until end of turn, target noncreature artifact you control becomes an artifact creature and gains flying. If it\'s not a Vehicle, it has base power and toughness 1/1 until end of turn.',
    why: 'The +1/+1 counters on noncreature artifacts each upkeep are left out.',
  },
  'Kazuul, Tyrant of the Cliffs': {
    effects: [{ kind: 'attackTax', amount: 3, when: 'static' }],
    notes: ['Opponents pay {3} for each creature attacking you (else you get a 3/3 Ogre)'],
    why: 'Each attacker makes you a 3/3 Ogre unless its controller pays {3}: played as a {3} attack tax, which bots pay or don\'t attack.',
  },
  'Keranos, God of Storms': {
    text: 'Indestructible\nAs long as your devotion to blue and red is less than seven, ~ isn\'t a creature.\nAt the beginning of your upkeep, ~ deals 3 damage to any target.',
    why: 'The revealed first draw each turn: a nonland deals 3 damage (most draws), a land draws another card (left out).',
  },
  'King Darien XLVIII': {
    text: 'Other creatures you control get +1/+1.\n{3}{G}{W}: Put a +1/+1 counter on ~ and create a 1/1 white Soldier creature token.',
    add: [SAC_PROTECT],
    notes: ['Sacrifice it: your permanents gain hexproof and indestructible this turn'],
    why: 'Only creature tokens gain hexproof and indestructible; played on all your permanents.',
  },
  'Kotori, Pilot Prodigy': {
    text: 'At the beginning of combat on your turn, target creature you control gains lifelink and vigilance until end of turn.',
    why: 'Giving Vehicles crew 2 is left out; the target should be an artifact creature.',
  },
  'Kozilek, Butcher of Truth': {
    text: 'When you cast this spell, draw four cards.\nAnnihilator 4\nIf ~ would be put into a graveyard from anywhere, reveal ~ and shuffle it into its owner\'s library instead.',
    why: 'Its owner shuffles their whole graveyard into their library; played as Kozilek alone.',
  },
  'Kroxa, Titan of Death\'s Hunger': {
    text: "When ~ enters, sacrifice it unless it escaped.\nWhenever ~ enters or attacks, each opponent discards a card, then each opponent who didn't discard a nonland card this way loses 3 life.\nEscape—{B}{B}{R}{R}, Exile five other cards from your graveyard.",
    why: 'Played as written (rule 702.138c: "escaped").',
  },
  'Kutzil, Malamet Exemplar': {
    text: "Your opponents can't cast spells during your turn.\nWhenever one or more creatures you control that are pumped deal combat damage to a player, draw a card.",
    why: 'Only creatures with power above their base power count: played as half the time.',
  },
  "Lae'zel's Acrobatics": {
    effects: [{ kind: 'blink', n: 99, what: 'creature', when: 'resolve' }],
    notes: ['Blink all your nontoken creatures'],
    why: 'They return at the next end step (1–9) or right away and again at end step (10–20). Played as one immediate blink of each.',
  },
  Lashwrithe: {
    text: 'Living weapon\nEquipped creature gets +1/+1 for each Swamp you control.\nEquip {B/P}{B/P}',
    why: 'Living weapon (rule 702.92) makes a 0/0 Germ and attaches it.',
  },
  Lembas: {
    text: 'When ~ enters, scry 1, then draw a card.\n{2}, {T}, Sacrifice ~: You gain 3 life.\nIf ~ would be put into a graveyard from anywhere, reveal ~ and shuffle it into its owner\'s library instead.',
    why: 'Played as written; it goes back into the library from the battlefield only, which is the same thing here.',
  },
  'Leyline Tyrant': {
    text: 'Flying\nWhen ~ dies, it deals 3 damage to any target.',
    why: 'Paying any amount of {R} as it dies is played as 3. Keeping unspent red mana is left out.',
  },
  'Liberty Prime, Recharged': {
    text: 'Vigilance, trample, haste\nAt the beginning of your upkeep, you lose 2 life.\n{2}, {T}: You get {E}{E}. Draw a card.',
    why: 'Paying {E}{E} on each attack or block is played as 2 life each turn. Sacrificing an artifact to draw is left out of the cost.',
  },
  'Life from the Loam': {
    text: 'Return up to three target land cards from your graveyard to your hand.',
    why: 'Dredge 3 is left out: bots draw normally.',
  },
  'Life of the Party': {
    text: 'First strike, trample, haste\nWhenever ~ attacks, ~ gets +3/+0 until end of turn.\nWhen ~ enters, if it\'s not a token, each opponent creates a token that\'s a copy of it. The tokens are goaded for the rest of the game.',
    why: '+X/+0 for your creatures when it attacks is played as +3/+0.',
  },
  'Light Up the Stage': {
    text: 'Exile the top two cards of your library. Until the end of your next turn, you may play those cards.',
    why: 'Spectacle (cast for {R} after an opponent lost life) is left out.',
  },
  'Lightfoot Rogue': {
    text: 'Whenever ~ attacks, ~ gets +1/+0 until end of turn.\nWhenever ~ attacks, ~ gains deathtouch until end of turn.',
    why: 'Every d20 result gives deathtouch; +1/+0 is the usual bonus (+3/+0 and first strike on a 20 is left out).',
  },
  'Lodestone Myr': {
    text: 'Trample\nWhenever ~ attacks, ~ gets +2/+2 until end of turn.',
    why: 'Tapping untapped artifacts for +1/+1 each is played as two artifacts when it attacks.',
  },
  'Loot, Exuberant Explorer': {
    text: 'You may play an additional land on each of your turns.',
    why: 'The six-card dig for a creature is left out.',
  },
  'Lorehold, the Historian': {
    text: "Flying, haste\nAt the beginning of each opponent's upkeep, you may discard a card. If you do, draw a card.",
    why: 'Miracle {2} for instants and sorceries in hand is left out.',
  },
  'Lux Artillery': {
    text: 'At the beginning of your end step, if there are thirty or more counters among artifacts and creatures you control, ~ deals 10 damage to each opponent.',
    why: 'Sunburst for artifact creature spells is left out.',
  },
  'Mad Auntie': {
    text: 'Other Goblins you control get +1/+1.',
    why: 'Regenerating another Goblin is left out.',
  },
  'Maelstrom Wanderer': {
    text: 'Creatures you control have haste.\nCascade, cascade',
    why: 'Cascade twice (rule 702.85c).',
  },
  'Magda, the Hoardmaster': {
    text: 'Whenever you commit a crime, create a tapped Treasure token. This ability triggers only once each turn.\n{3}: Create a 4/4 red Dragon creature token with flying and haste. Activate only as a sorcery.',
    why: 'Sacrificing three Treasures is played as paying {3}: Treasures are mana here.',
  },
  'Maha, Its Feathers Night': {
    text: 'Flying, trample\nWard—Discard a card.',
    why: 'Opponents\' creatures having base toughness 1 is left out.',
  },
  'Marionette Apprentice': {
    text: 'Fabricate 1\nWhenever another creature you control dies, each opponent loses 1 life.',
    why: 'Artifacts going to the graveyard also drain; only creatures are played.',
  },
  'Marrow-Gnawer': {
    text: 'Other Rats you control have fear.\n{T}, Sacrifice a creature: Create X 1/1 black Rat creature tokens, where X is the number of Rats you control.',
    why: 'All Rats have fear, opponents\' too; played for yours.',
  },
  'Marvin, Murderous Mimic': {
    text: '',
    why: 'Having your other creatures\' activated abilities is left out: it plays as a 2/2.',
  },
  'Master of Death': {
    text: 'When ~ enters, surveil 2.',
    why: 'Coming back to hand from the graveyard each upkeep is left out.',
  },
  'Matoya, Archon Elder': {
    text: 'Whenever you surveil, draw a card.',
    why: 'Scry also draws; only surveil is played.',
  },
  'Matzalantli, the Great Door': {
    text: '{T}: Draw a card, then discard a card.\n{4}, {T}: Transform ~.',
    why: 'Four permanent types in your graveyard to transform is left out.',
  },
  'Mentor of the Meek': {
    text: 'Whenever another creature you control enters, you may pay {1}. If you do, draw a card.',
    why: 'Only creatures with power 2 or less: in its deck, most are.',
  },
  'Mesmeric Orb': {
    text: 'At the beginning of your upkeep, each player mills five cards.',
    why: 'Each permanent untapping mills its controller one card: about five a turn for each player.',
  },
  'Mindblade Render': {
    text: 'Whenever a creature you control deals combat damage to a player, you draw a card and you lose 1 life. This ability triggers only once each turn.',
    why: 'Only Warriors count; its deck is Warriors.',
  },
  'Mine Layer': {
    text: '{1}{R}, {T}: Destroy target land. Activate only as a sorcery.',
    why: 'The mine destroys the land the next time it is tapped, which is nearly always its controller\'s next turn.',
  },
  'Minn, Wily Illusionist': {
    text: 'Whenever you draw your second card each turn, create a 1/1 blue Illusion creature token with "This token gets +1/+0 for each other Illusion you control."',
    why: 'Putting a permanent from hand onto the battlefield when an Illusion dies is left out.',
  },
  'Mirkwood Bats': {
    text: 'Flying\nWhenever you sacrifice a permanent, each opponent loses 1 life.\nWhenever a creature token you control enters, each opponent loses 1 life.',
    why: 'Only tokens: played on any sacrifice and on creature tokens (Treasures you make are left out).',
  },
  'Misleading Signpost': {
    text: 'Flash\n{T}: Add {U}.',
    why: 'Redirecting an attacker is left out.',
  },
  'Mithril Coat': {
    text: 'Flash\nIndestructible\nWhen ~ enters, attach it to target legendary creature you control.\nEquipped creature has indestructible.\nEquip {3}',
    why: 'Played as written.',
  },
  'Model of Unity': {
    text: '{T}: Add one mana of any color.',
    why: 'Scrying after votes: bots vote together here; left out.',
  },
  'Mondrak, Glory Dominus': {
    text: 'If one or more tokens would be created under your control, twice that many of those tokens are created instead.\n{1}{W}{W}, Sacrifice a creature: Put an indestructible counter on ~.',
    why: 'Sacrificing two artifacts or creatures is played as one creature.',
  },
  'Monument to Endurance': {
    text: 'Whenever you discard a card, draw a card. This ability triggers only once each turn.\nWhenever you discard a card, each opponent loses 3 life. This ability triggers only once each turn.',
    why: 'Each mode once a turn: the card and the 3 life loss are played; the Treasure is left out.',
  },
  'Mossborn Hydra': {
    text: 'Trample\n~ enters with a +1/+1 counter on it.\nLandfall — Whenever a land you control enters, put two +1/+1 counters on ~.',
    why: 'Doubling its counters is played as two counters a land.',
  },
  'Mox Diamond': {
    text: 'As an additional cost to cast ~, discard a card.\n{T}: Add one mana of any color.',
    why: 'The discarded card must be a land.',
  },
  'Myr Matrix': {
    text: 'Indestructible\nMyr creatures you control get +1/+1.\n{5}: Create a 1/1 colorless Myr artifact creature token.',
    why: 'All Myr get +1/+1, opponents\' too; played for yours.',
  },
  'Myr Welder': {
    text: '{T}: Exile target card from a graveyard.',
    why: 'Gaining the exiled artifacts\' activated abilities is left out.',
  },
  "Myrkul's Edict": {
    text: 'Each opponent sacrifices a creature.',
    why: 'The d20: 10–19 is the usual result. One opponent only (1–9) and the biggest creature (20) are left out.',
  },
  'Mystic Confluence': {
    text: 'Choose one —\n• Counter target spell unless its controller pays {9}.\n• Draw three cards.',
    why: 'Three modes, repeats allowed: bots pick all three counters or all three draws.',
  },
  'Necrogen Communion': {
    text: 'Enchant creature you control\nWhen enchanted creature dies, return that card to the battlefield under your control.',
    why: 'Toxic 2 is left out.',
  },
  'Nelly Borca, Impulsive Accuser': {
    text: 'Vigilance\nWhenever ~ attacks, suspect target creature. Then goad all suspected creatures.',
    add: [{ kind: 'draw', n: 1, when: 'playerAttacks', scope: 'opponents' }],
    notes: ['When an opponent attacks another opponent: draw a card'],
    why: 'You draw when their creatures deal combat damage to your other opponents: played on such attacks. Their draw is left out.',
  },
  'Night of the Sweets\' Revenge': {
    text: 'When ~ enters, create a Food token.\n{5}{G}{G}, Sacrifice ~: Creatures you control get +X/+X until end of turn, where X is the number of Foods you control. Activate only as a sorcery.',
    why: 'Foods tapping for {G} is left out.',
  },
  'Night Shift of the Living Dead': {
    text: 'Whenever you roll a 6, create a 2/2 black Zombie Employee creature token.',
    why: 'Paying 1 life to shift a die roll is left out.',
  },
  Nighthowler: {
    text: "~'s power and toughness are each equal to the number of creature cards in all graveyards.",
    why: 'Bestow is left out: it is cast as a creature.',
  },
  "Norn's Inquisitor": {
    text: 'When ~ enters, incubate 3.',
    why: 'The +1/+1 counter when its Incubator transforms is played as a third counter on it.',
  },
  'Oathkeeper, Takeno\'s Daisho': {
    text: 'Equipped creature gets +3/+1.\nWhenever equipped creature dies, return that card to the battlefield under your control if it\'s a Samurai card.\nEquip {2}',
    why: 'Exiling the equipped creature when Oathkeeper goes to the graveyard is left out.',
  },
  'Obeka, Splitter of Seconds': {
    text: 'Menace',
    add: [{ kind: 'extraPhase', phase: 'beginning', when: 'combatDamage', scope: 'self' }],
    notes: ['On combat damage: an extra upkeep'],
    why: 'One extra upkeep for each damage dealt: played as one extra beginning phase.',
  },
  'Obsidian Fireheart': {
    text: '{1}{R}{R}: ~ deals 3 damage to target player.',
    why: 'A blaze counter burns the land\'s controller for 1 every upkeep: played as 3 damage up front.',
  },
  'Otharri, Suns\' Glory': {
    text: "Flying, lifelink, haste\nWhenever ~ attacks, you get an experience counter. Then create a 2/2 red Rebel creature token that's tapped and attacking for each experience counter you have.\n{2}{R}{W}: Return ~ from your graveyard to the battlefield tapped.",
    why: 'Tapping an untapped Rebel as part of the cost is left out; it makes a lot of them.',
  },
  'Out of Bounds': {
    text: 'Assist\nCounter target spell.',
    why: 'Assist: bots pay the whole cost themselves.',
  },
  'Outlaws\' Merriment': {
    text: 'At the beginning of your upkeep, create a 2/1 red and white Human creature token with haste.',
    why: 'One of three tokens at random (3/1 trample, 2/1 lifelink, 1/2 that pings): played as a 2/1 haste.',
  },
  'Overclocked Electromancer': {
    text: 'At the beginning of combat on your turn, you may pay {E}{E}{E}. If you do, put a +1/+1 counter on ~.\nWhenever ~ attacks, ~ gets +2/+0 until end of turn.\nWhenever ~ deals combat damage to a creature, if that creature was dealt excess damage this turn, you get X {E}, where X is that excess damage.',
    why: 'Doubling its power on attack is played as +2/+0.',
  },
  'Overseer of the Damned': {
    text: 'Flying\nWhen ~ enters, you may destroy target creature.\nWhenever a creature an opponent controls dies, create a 2/2 black Zombie creature token.',
    why: 'Only nontoken creatures, and the Zombie enters tapped.',
  },
  'Owlbear Cub': {
    text: '',
    why: 'Its dig needs the defending player to control eight lands; left out, it plays as a 3/3.',
  },
  'Ozai, the Phoenix King': {
    text: 'Trample, haste\nFirebending 4',
    why: 'Turning lost mana red, and flying and indestructible with six unspent mana, are left out.',
  },
};
