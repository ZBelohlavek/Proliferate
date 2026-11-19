// Card-specific rules for the cards the mechanic threads left out and for cards the reader only approximated
// (see cardRules.ts for how entries work). Cards the one-off threads also ruled (Gonti, Deadeye Navigator, Mine
// Layer, Leyline Tyrant, Inti, Gossip's Talent, Lightfoot Rogue, Iron Mastiff, Knowledge Pool) keep their entries there.

import type { CardRule } from './cardRules';

export const LATE_RULES: Record<string, CardRule> = {
  // --- Leftovers of the mechanic groups ------------------------------------------------
  'Psionic Ritual': {
    text: 'Exile target instant or sorcery card from a graveyard and copy it. You may cast the copy without paying its mana cost.\nExile Psionic Ritual.',
    why: 'Replicate by tapping Horrors is left out: it is cast once.',
  },
  'Azula, Cunning Usurper': {
    text: 'Firebending 2 (Whenever this creature attacks, add {R}{R}. This mana lasts until end of combat.)\nWhen ~ enters, target opponent sacrifices a creature.',
    why: 'The opponent exiling a creature of their choice is read as an edict. Casting the exiled cards (and the graveyard card) is left out.',
  },
  'The Rise of Sozin': {
    text: '(As this Saga enters and after your draw step, add a lore counter.)\nI — Destroy all creatures.\nIII — Exile this Saga, then return it to the battlefield transformed under your control.',
    why: 'Chapter II (naming a card and exiling every copy of it) is left out: Commander decks hold one of each.',
  },
  'Waste Not': {
    text: 'Whenever an opponent discards a creature card, create a 2/2 black Zombie creature token.\nWhenever an opponent discards a noncreature, nonland card, draw a card.',
    why: 'The {B}{B} for a discarded land is left out.',
  },
  'Mendicant Core, Guidelight': {
    text: 'Mendicant Core\'s power is equal to the number of artifacts you control.',
    why: 'Speed ("start your engines!") and the max-speed copies of artifact spells are left out.',
  },
  'Lazav, Dimir Mastermind': {
    text: 'Hexproof',
    why: 'Becoming a copy of creature cards put into opponents\' graveyards is left out: it stays a 3/3 with hexproof.',
  },
  'Nezahal, Primal Tide': {
    text: 'This spell can\'t be countered.\nYou have no maximum hand size.\nWhenever an opponent casts a noncreature spell, draw a card.',
    why: 'Discarding three cards to exile it until the end step (to dodge removal) is left out.',
  },
  'Athreos, Shroud-Veiled': {
    text: 'Indestructible\nAs long as your devotion to white and black is less than seven, Athreos isn\'t a creature.\nWhenever a creature an opponent controls dies, return it to the battlefield under your control.',
    why: 'Coin counters go on one creature each end step and bring it back under your control when it dies; read as any opponent\'s creature that dies coming back to you.',
  },
  'Tenuous Truce': {
    text: 'Enchant opponent\nAt the beginning of your upkeep, draw a card.',
    why: 'You and the enchanted opponent each draw at their end step until either of you attacks the other. Read as you drawing each turn; their card and the sacrifice are left out.',
  },
  'Ghoulish Impetus': {
    text: 'Enchant creature\nEnchanted creature gets +1/+1, has deathtouch, and is goaded. (It attacks each combat if able and attacks a player other than you if able.)',
    why: 'Returning to the battlefield at the next end step after the creature dies is left out.',
  },
  'Chaos Shrine\'s Black Crystal': {
    text: 'Whenever a nontoken creature you control dies, return it to the battlefield under its owner\'s control.',
    why: 'The creature is exiled and comes back at your next upkeep with a finality counter; read as coming back right away.',
  },
  'Domineering Will': {
    text: 'Prevent all combat damage that would be dealt this turn.',
    why: 'Taking up to three creatures to block with is read as a Fog: it stops an attack on you.',
  },
  'Cemetery Gatekeeper': {
    text: 'First strike\nWhen this creature enters, exile a card from a graveyard.\nWhenever an opponent casts a creature spell, ~ deals 2 damage to that player.',
    why: 'The card type is the one it exiled from a graveyard, usually a creature; read as creature spells. Lands played are left out.',
  },
  'Hot Pursuit': {
    text: 'When this enchantment enters, suspect target creature an opponent controls. As long as this enchantment remains on the battlefield, that creature is also goaded.',
    why: 'Taking every goaded and suspected creature once two players have lost is left out.',
  },
  'Death Kiss': {
    text: '{4}{R}: Put two +1/+1 counters on ~.\nWhen ~ enters, goad target creature an opponent controls.',
    why: 'Doubling attackers\' power is left out. Monstrosity X is read as two +1/+1 counters for {4}{R}, and its goad as a goad when it enters.',
  },
  'Combat Calligrapher': {
    text: 'Flying\nInklings can\'t attack you or planeswalkers you control.',
    why: 'Inklings for players attacking your opponents are left out.',
  },
  'Slicer, Hired Muscle': {
    text: 'Double strike, haste',
    why: 'The cheaper converted cast and handing Slicer to each opponent in their upkeep are left out: it stays a 3/4 double striker for you.',
  },
  'Goblin Spymaster': {
    text: 'First strike',
    why: 'The Goblin tokens it gives opponents (which force their creatures to attack) are left out.',
  },
  'Varchild, Betrayer of Kjeldor': {
    text: 'Survivors your opponents control can\'t block, and they can\'t attack you or planeswalkers you control.',
    why: 'The Survivor tokens it gives damaged players, and taking them when it leaves, are left out.',
  },
  'Fandaniel, Telophoroi Ascian': {
    text: 'Whenever you cast an instant or sorcery spell, surveil 1.\nAt the beginning of your end step, each opponent loses 2 life.',
    why: 'Each opponent may sacrifice a nontoken creature instead of losing 2 life for each instant and sorcery in your graveyard; read as 2 life each.',
  },
  'Avatar Roku, Firebender': {
    text: 'Firebending 6\n{R}{R}{R}: Target creature gets +3/+0 until end of turn.',
    why: 'Six {R} whenever any player attacks is read as firebending 6 (one-shot mana when Roku attacks).',
  },
  'The Aesir Escape Valhalla': {
    text: '(As this Saga enters and after your draw step, add a lore counter.)\nI — You gain 4 life.\nII — Put a number of +1/+1 counters on target creature you control equal to the mana value of the exiled card.\nIII — Return target permanent card from your graveyard to your hand.',
    why: 'Chapter I exiles a permanent card from your graveyard for life equal to its mana value (read as 4); chapter III returns that card to your hand, read as returning a permanent card from your graveyard. The Saga itself returning to hand is left out.',
  },
  'Elspeth Conquers Death': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Exile target permanent an opponent controls with mana value 3 or greater.\nIII — Return target creature or planeswalker card from your graveyard to the battlefield. Put a +1/+1 counter or a loyalty counter on it.',
    why: 'Opponents\' noncreature spells costing {2} more for a turn is left out.',
  },
  'Fall of Gil-galad': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Scry 2.\nII — Put two +1/+1 counters on target creature you control.\nIII — Target creature you control fights target creature you don\'t control.',
    why: 'The "draw two when it dies" rider is left out.',
  },
  'Summon: Magus Sisters': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI, II, III — Put two +1/+1 counters on target creature you control.\nHaste',
    why: 'Each chapter picks one of three modes at random (three counters, a shield counter and 3 life, or a fight); read as two +1/+1 counters.',
  },
  'Summon: Primal Garuda': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Aerial Blast — This creature deals 4 damage to target tapped creature an opponent controls.\nII, III — Target creature you control gets +1/+0 and gains flying until end of turn.\nFlying',
    why: '"Another" target creature is left out.',
  },
  'Tale of Tinúviel': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Target creature you control gains indestructible until end of turn.\nII — Return target creature card from your graveyard to the battlefield.\nIII — Target creature you control gains lifelink until end of turn.',
    why: 'Chapter I lasts as long as the Saga does; read as one turn. Chapter III gives two creatures lifelink; read as one.',
  },
  'The Akroan War': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Gain control of target creature for as long as this Saga remains on the battlefield.\nII — Until your next turn, creatures your opponents control attack each combat if able.\nIII — ~ deals 3 damage to each creature your opponents control.',
    why: 'Each tapped creature dealing damage to itself, after chapter II forced opponents\' creatures to attack, is read as 3 damage to each of their creatures.',
  },
  'Summon: Fenrir': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Crescent Fang — Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.\nII — Put a +1/+1 counter on target creature you control.\nIII — Ecliptic Growl — Draw a card if you control the creature with the greatest power or tied for the greatest power.',
    why: 'The +1/+1 counter on the next creature cast is read as a counter on one you control.',
  },
  'Summon: Brynhildr': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Chain — Exile the top card of your library. During any turn you put a lore counter on this Saga, you may play that card.\nII, III — Target creature you control gains haste until end of turn.',
    why: 'Haste for the next creature cast this turn is read as haste for a creature you control.',
  },
  'Summon: Titan': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Mill five cards.\nII — Return all land cards from your graveyard to the battlefield tapped.\nIII — Target creature you control gets +5/+5 and gains trample until end of turn.\nReach, trample',
    why: 'X is the number of lands you control; read as 5.',
  },
  'Vault 13: Dweller\'s Journey': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — For each player, exile up to one other target enchantment or creature that player controls until this Saga leaves the battlefield.\nII — You gain 2 life and scry 2.',
    why: 'Chapter III\'s return of the exiled cards is left out: what chapter I exiled stays exiled.',
  },
  'Doc Aurlock, Grizzled Genius': {
    text: 'Spells you cast from your graveyard or from exile cost {2} less to cast.',
    why: 'Cheaper plotting is left out.',
  },
  'River Song\'s Diary': {
    text: 'At the beginning of your upkeep, if there are four or more cards exiled with this artifact, choose one of them at random. You may cast it without paying its mana cost.',
    why: 'Exiling instants and sorceries as they resolve is left out; the upkeep free spell is read as a card.',
  },
  'Norin the Wary': {
    text: '',
    why: 'Blinking itself whenever anyone casts a spell or attacks is left out: it stays a 2/1.',
  },
  'Fire Lord Ozai': {
    text: '{6}: Exile the top card of each opponent\'s library. Until end of turn, you may play one of those cards without paying its mana cost.',
    why: 'Sacrificing a creature for red mana when it attacks is left out.',
  },
  'Emrakul, the Promised End': {
    text: 'This spell costs {1} less to cast for each card type among cards in your graveyard.\nFlying, trample, protection from instants',
    why: 'Controlling an opponent\'s next turn is left out: it is a 13/13 flier with trample.',
  },
  'Silver-Fur Master': {
    text: 'Ninjutsu {U}{B} ({U}{B}, Return an unblocked attacker you control to hand: Put this card onto the battlefield from your hand tapped and attacking.)\nOther Ninja and Rogue creatures you control get +1/+1.',
    why: 'Cheaper ninjutsu is left out.',
  },
  'Teach by Example': {
    text: '({U/R} can be paid with either {U} or {R}.)',
    add: [{ kind: 'copyNext', until: 'next', when: 'resolve' }],
    notes: ['Copy the next instant or sorcery you cast this turn'],
    why: 'Same card, given straight to the engine\'s copy-next-spell effect.',
  },
  'Barrenton Medic': {
    text: 'Put a -1/-1 counter on this creature: Untap this creature.',
    why: 'Preventing 1 damage (and untapping with -1/-1 counters) is left out.',
  },
  'Kambal, Profiteering Mayor': {
    text: 'Whenever one or more tokens you control enter, each opponent loses 1 life and you gain 1 life.',
    why: 'Copying tokens opponents make is left out.',
  },
  'Chandra, Spark Hunter': {
    text: 'At the beginning of combat on your turn, choose up to one target Vehicle you control. Until end of turn, it becomes an artifact creature and gains haste.\n+2: You may sacrifice an artifact or discard a card. If you do, draw a card.\n0: Create a 3/2 colorless artifact creature token.\n−7: You get an emblem with "Whenever an artifact you control enters, this emblem deals 3 damage to any target."',
    why: 'The Vehicle token with crew 1 is read as a 3/2 creature: her combat trigger animates it each turn.',
  },
  'Rose, Cutthroat Raider': {
    text: 'First strike\nWhenever ~ attacks, exile the top card of your library. You may play that card this turn.',
    why: 'The Junk token for each opponent attacked is read as one impulse draw when Rose attacks; the {R} for sacrificing Junk is left out.',
  },
  'Accursed Witch': {
    text: 'Spells your opponents cast that target this creature cost {1} less to cast.',
    why: 'Coming back as Infectious Curse (drain 1 each upkeep) is left out.',
  },
  'Curse of Echoes': {
    text: 'Enchant player',
    why: 'Copying the enchanted player\'s instants and sorceries is left out.',
  },
  'Azula, Ruthless Firebender': {
    text: 'Firebending 1 (Whenever this creature attacks, add {R}. This mana lasts until end of combat.)\nWhenever Azula attacks, you may discard a card. Then you get an experience counter for each player who discarded a card this turn.\n{2}{B}: ~ gets +2/+2 until end of turn.',
    why: 'The +1/+1 for each experience counter is read as +2/+2; menace is left out.',
  },
  'K\'rrik, Son of Yawgmoth': {
    text: '({B/P} can be paid with either {B} or 2 life.)\nLifelink\nWhenever you cast a black spell, put a +1/+1 counter on K\'rrik.',
    why: 'Paying 2 life for each {B} in costs is left out.',
  },
  'Geth\'s Summons': {
    text: 'Return up to one target creature card from your graveyard to the battlefield.',
    why: 'The corrupted extra reanimation from opponents\' graveyards is left out.',
  },
  'Deep Gnome Terramancer': {
    text: 'Flash',
    why: 'Fetching Plains when opponents\' lands enter without being played is left out.',
  },
  'Multiclass Baldric': {
    text: 'Equipped creature has lifelink if you control a Cleric, deathtouch if you control a Rogue, haste if you control a Warrior, and flying if you control a Wizard.\nEquip {2}',
    why: 'Full-party damage prevention is left out.',
  },
  'Mirror Entity': {
    text: 'Changeling (This card is every creature type.)\n{4}: Creatures you control get +2/+2 until end of turn.',
    why: 'Setting your creatures\' base power and toughness to X/X is read as +2/+2 for {4}.',
  },
  'Conjurer\'s Mantle': {
    text: 'Equipped creature gets +1/+1 and has vigilance.\nWhenever equipped creature attacks, look at the top six cards of your library. Put one of them into your hand and the rest on the bottom of your library in a random order.\nEquip {1}',
    why: 'Only a card sharing a creature type with the creature can be taken; read as any card.',
  },
  'Reconnaissance': {
    text: '',
    why: 'Removing your attackers from combat is left out.',
  },
  'Elesh Norn': {
    text: 'Vigilance',
    why: 'The {1} tax on opponents\' damage and transforming into The Argent Etchings are left out.',
  },
  'Etchings of the Chosen': {
    text: 'As this enchantment enters, choose a creature type.\nCreatures you control of the chosen type get +1/+1.\n{1}, Sacrifice a creature: Target creature you control gains indestructible until end of turn.',
    why: 'Only a creature of the chosen type can be sacrificed; read as any.',
  },
  'Guide of Souls': {
    text: 'Whenever another creature you control enters, you gain 1 life and get {E} (an energy counter).\nWhenever ~ attacks, you may pay {E}{E}{E}. When you do, put two +1/+1 counters on target creature.',
    why: '"Whenever you attack" and the flying counter are read as Guide attacking and two +1/+1 counters.',
  },
  'Dogged Detective': {
    text: 'When this creature enters, surveil 2. (Look at the top two cards of your library, then put any number of them into your graveyard and the rest on top of your library in any order.)',
    why: 'Returning to hand when an opponent draws their second card is left out.',
  },
  'Eye of Duskmantle': {
    text: 'Flying, lifelink',
    why: 'Casting surveilled cards from the graveyard for life is left out.',
  },
  'The Ozolith': {
    text: '',
    why: 'Keeping counters from creatures that leave is left out.',
  },
  'Piper of the Swarm': {
    text: 'Rats you control have menace.\n{1}{B}, {T}: Create a 1/1 black Rat creature token.\n{2}{B}{B}, {T}, Sacrifice a creature: Gain control of target creature.',
    why: 'Three Rats are sacrificed; read as one creature.',
  },
  'Sauron, the Necromancer': {
    text: 'Menace\nWhenever ~ attacks, create a 3/3 black Wraith creature token with menace that\'s tapped and attacking.',
    why: 'The token copies a creature card exiled from your graveyard and is exiled at the end step unless Sauron is your Ring-bearer; read as a plain 3/3 that stays.',
  },
  'Canoptek Wraith': {
    text: '~ can\'t be blocked.',
    why: 'Paying {3} and sacrificing it to fetch two basic lands is left out.',
  },
  'Shadow Puppeteers': {
    text: 'Flying, ward {2}\nWhen this creature enters, create two 1/1 black Faerie Rogue creature tokens with flying.',
    why: 'Fliers becoming 4/4 Dragons when they attack is left out.',
  },
  'Illusionist\'s Gambit': {
    text: 'Cast this spell only during the declare blockers step on an opponent\'s turn.\nPrevent all combat damage that would be dealt this turn.',
    why: 'Turning an attack on you into an extra combat against someone else is read as a Fog.',
  },
  'Wall of Frost': {
    text: 'Defender',
    why: 'Blocked creatures skipping their untap is left out.',
  },
  'Tinybones, Bauble Burglar': {
    text: 'Whenever an opponent discards a card, draw a card.\n{3}{B}, {T}: Each opponent discards a card. Activate only as a sorcery.',
    why: 'Discarded cards are stashed in exile for Tinybones\' controller to play; read as drawing a card.',
  },
  'Treasure Chest': {
    text: '{4}, Sacrifice ~: You gain 3 life and draw three cards.',
    why: 'The d20 table is read as its most common result (10–19: gain 3 life and draw three).',
  },
  'Chaos Dragon': {
    text: 'Flying, haste\nThis creature attacks each combat if able.',
    why: 'The d20 roll that stops it attacking some players is left out.',
  },
  'Danse Macabre': {
    text: 'Each player sacrifices a creature.\nReturn a creature card from a graveyard to the battlefield under your control.',
    why: 'The d20 roll for one or two creatures is read as one.',
  },
  'The Deck of Many Things': {
    text: '{2}, {T}: Draw a card.',
    why: 'The d20 table (minus your hand size) is read as one card.',
  },
  'Delina, Wild Mage': {
    text: 'Whenever ~ attacks, create a token that\'s a copy of target creature you control, except it\'s not legendary. That token is tapped and attacking. Exile it at end of combat.',
    why: 'Rolling 15 or more lets you roll again for another copy; read as one copy.',
  },
  'Kellogg, Dangerous Mind': {
    text: 'First strike, haste\nWhenever Kellogg attacks, create a Treasure token.\n{5}: Gain control of target creature for as long as you control ~. Activate only as a sorcery.',
    why: 'Sacrificing five Treasures is read as paying {5}.',
  },
  'Nautiloid Ship': {
    text: 'Flying\nWhen this Vehicle enters, exile target player\'s graveyard.\nWhenever ~ deals combat damage to a player, return target creature card from a graveyard to the battlefield under your control.\nCrew 3',
    why: 'Only creature cards it exiled can come back; read as any graveyard.',
  },
  'The Chain Veil': {
    text: 'At the beginning of your end step, if you didn\'t activate a loyalty ability of a planeswalker this turn, you lose 2 life.',
    why: 'Extra loyalty activations are left out (the 2-life end step loss is read).',
  },
  'Círdan the Shipwright': {
    text: 'Vigilance\nWhenever ~ enters or attacks, draw a card.',
    why: 'The secret vote is read as you getting one vote\'s card; other players\' cards and permanents are left out.',
  },
  'Gwafa Hazid, Profiteer': {
    text: '{W}{U}, {T}: Tap target creature an opponent controls. Its controller draws a card.',
    why: 'A bribery counter stops the creature attacking or blocking for good; read as tapping it.',
  },
  'Truth or Consequences': {
    text: 'Draw two cards.\n~ deals 3 damage to target opponent.',
    why: 'The secret vote is read as two truth votes and one consequences vote.',
  },
  'Sokrates, Athenian Teacher': {
    text: 'Defender\nHexproof',
    why: 'Hexproof only while untapped (read as always); its draw-instead-of-damage ability is left out.',
  },
  'Spelltithe Enforcer': {
    text: 'Spells your opponents cast cost {1} more to cast.',
    why: 'Each spell an opponent casts costs them a permanent unless they pay {1}; read as a {1} tax.',
  },
  'Teferi, Master of Time': {
    text: '+1: Draw a card, then discard a card.\n-3: Tap target creature an opponent controls.\n−10: Take two extra turns after this one.',
    why: 'Activating at instant speed is left out. Phasing out a creature is read as tapping it.',
  },
  'Hex Parasite': {
    text: '',
    why: 'Removing counters is left out.',
  },
  'Repurposing Bay': {
    text: '{4}, {T}: Search your library for an artifact card, put it onto the battlefield, then shuffle. Activate only as a sorcery.',
    why: 'Sacrificing an artifact for one with mana value one higher is read as paying {2} more for any artifact.',
  },
  'March of Swirling Mist': {
    text: 'Up to X target creatures phase out. (While they\'re phased out, they\'re treated as though they don\'t exist. Each one phases in before its controller untaps during their next untap step.)',
    why: 'Exiling blue cards to cast it cheaper is left out.',
  },
  'Resourceful Defense': {
    text: '',
    why: 'Moving counters is left out.',
  },
  'The Creation of Avacyn': {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — Search your library for a card, exile it face down, then shuffle.\nII — You lose 4 life.\nIII — You may put a creature card from your hand onto the battlefield.',
    why: 'The card found face down in chapter I is read as going to your hand; chapter II\'s life loss as 4, and chapter III as putting a creature from hand onto the battlefield.',
  },
  'Zurzoth, Chaos Rider': {
    text: 'Whenever one or more Devils you control attack one or more players, you and those players each draw a card, then discard a card at random.',
    why: 'Devils for opponents\' off-turn first draws are left out.',
  },
  'Lukka, Coppercoat Outcast': {
    text: '+1: Exile the top three cards of your library. Creature cards exiled this way gain "You may cast this card from exile as long as you control a Lukka planeswalker."\n-2: Search your library for a creature card, put it onto the battlefield, then shuffle.\n−7: Each creature you control deals damage equal to its power to each opponent.',
    why: 'Exiling one of your creatures to reveal a bigger one is read as putting a creature from your library onto the battlefield.',
  },
  'Kill Switch': {
    text: '',
    why: 'Tapping all other artifacts is left out.',
  },
  'Omenpath Journey': {
    text: 'At the beginning of your end step, search your library for a land card, put it onto the battlefield tapped, then shuffle.',
    why: 'The five lands exiled as it enters come out one each end step; read as fetching one from your library each end step.',
  },
  'Yosei, the Morning Star': {
    text: 'Flying\nWhen ~ dies, tap target creature an opponent controls. It doesn\'t untap during its controller\'s next untap step.',
    why: 'The player skipping their untap step and five permanents tapped are read as one creature locked down.',
  },
  'Drana, the Last Bloodchief': {
    text: 'Flying\nWhenever ~ attacks, return target creature card with mana value 2 or less from your graveyard to the battlefield.',
    why: 'The defending player picks the creature, so it is read as a small one.',
  },
  'Liliana of the Dark Realms': {
    text: '+1: Search your library for a Swamp card, reveal it, put it into your hand, then shuffle.\n-3: Target creature gets -4/-4 until end of turn.\n−6: You get an emblem with "Swamps you control have \'{T}: Add {B}{B}{B}{B}.\'"',
    why: 'X is your Swamps; read as 4, used as removal.',
  },
  'Visage of Dread': {
    text: 'When this artifact enters, target opponent reveals their hand. You choose an artifact or creature card from it. That player discards that card.',
    why: 'Crafting into Dread Osseosaur is left out.',
  },
  'Liliana of the Veil': {
    text: '+1: Each opponent discards a card.\n−2: Target player sacrifices a creature.\n−6: Separate all permanents target player controls into two piles. That player sacrifices all permanents in the pile of their choice.',
    why: 'Each player discards, you too; your discard is left out.',
  },

  // --- Cards the reader only approximated ----------------------------------------------
  'Last March of the Ents': {
    text: "This spell can't be countered.\nDraw cards equal to the greatest toughness among creatures you control.\nYou may put a creature card from your hand onto the battlefield.",
    why: 'Any number of creature cards may go onto the battlefield; read as one, the biggest.',
  },
  Crabomination: {
    text: 'Emerge from artifact {5}{B}{B}\nWhen ~ enters, target opponent reveals the top three cards of their library. You may cast an instant or sorcery spell from among them without paying its mana cost.',
    why: 'The opponent exiles the top card of their library and a random card from their graveyard and hand; read as a free instant or sorcery from the top three of their library. Emerge from artifact is read as emerge.',
  },
};
