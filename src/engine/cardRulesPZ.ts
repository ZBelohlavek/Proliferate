// Card-specific rules for one-off cards named P to Z (see cardRules.ts for how an entry works).
//
// These are the cards in real decks whose unread lines share no mechanic with any other card. Each entry
// is how this engine plays the card: `text` rewritten in wordings the reader knows wherever one fits,
// `effects`/`add` where none does, and `why` saying what differs from the printed card.

import type { CardRule } from './cardRules';

export const RULES_P_TO_Z: Record<string, CardRule> = {
  'Pain Distributor': {
    text: 'Menace\nWhenever a player casts their first spell each turn, they create a Treasure token.\nWhenever an opponent sacrifices a permanent, ~ deals 1 damage to that player.',
    why: 'Pings an opponent whenever they sacrifice a permanent: in practice the Treasures it hands out. Artifacts destroyed rather than sacrificed are left out.',
  },
  Parcelbeast: {
    text: 'Mutate {G}{U}\n{1}, {T}: Draw a card. You may put a land card from your hand onto the battlefield.',
    why: 'Looks at the top card: a land goes onto the battlefield, anything else into your hand. Played as drawing it plus an extra land drop, which comes to the same thing.',
  },
  'Party Thrasher': {
    text: 'At the beginning of your first main phase, you may discard a card. If you do, exile the top two cards of your library, then choose one of them. You may play that card this turn.',
    why: 'Convoke for noncreature spells cast from exile is left out: bots pay those with mana.',
  },
  'Passionate Archaeologist': {
    text: 'Whenever you cast a spell from exile, ~ deals 3 damage to target opponent.',
    why: 'The ability is granted to your commander; here the enchantment has it. The damage equals the spell\'s mana value, played as 3 (a typical exiled spell).',
  },
  'Perpetual Timepiece': {
    text: '{T}: Mill two cards.',
    why: 'Shuffling graveyard cards back into the library is left out: it only matters against decking, which bots rarely face.',
  },
  'Persistent Marshstalker': {
    text: '~ gets +1/+0 for each other Rat you control.',
    why: 'Coming back from the graveyard tapped and attacking (threshold, {2}{B}) is left out.',
  },
  'Phyrexian Censor': {
    text: "Each player can't cast more than one non-Phyrexian spell each turn.",
    why: 'Non-Phyrexian creatures entering tapped is left out.',
  },
  'Phyrexian Obliterator': {
    text: 'Trample',
    add: [{ kind: 'damagedPunish', what: 'sacrifice', when: 'static' }],
    notes: ['Whenever a source deals damage to it, that source\'s controller sacrifices that many permanents'],
    why: 'Played as printed: any damage to it, combat or not, makes the source\'s controller sacrifice that many permanents of their choice.',
  },
  'Pia Nalaar, Consul of Revival': {
    text: 'Thopters you control have haste.\nWhenever you cast a spell from exile, create a 1/1 colorless Thopter artifact creature token with flying.',
    why: 'Lands played from exile are left out; only spells make a Thopter.',
  },
  'Plasma Caster': {
    text: 'Equipped creature gets +1/+1.\nWhenever equipped creature attacks, you get {E}{E}.\nEquip {2}',
    why: 'Spending the energy to flip a coin against a blocker is left out.',
  },
  'Polygraph Orb': {
    text: 'When ~ enters, look at the top four cards of your library. Put two of them into your hand and the rest into your graveyard. You lose 2 life.\n{2}, {T}: Each opponent discards a card.',
    why: 'Each opponent chooses: lose 3 life, discard or sacrifice a creature. Played as a discard, the usual pick. Collecting evidence 3 is left out of the cost.',
  },
  'Preston, the Vanisher': {
    text: "Whenever another nontoken creature you control enters, if it wasn't cast, create a token that's a copy of that creature, except it's a 0/1 white Illusion.",
    why: 'Sacrificing five Illusions to exile a permanent is left out: the deck rarely has five.',
  },
  'Prosper, Tome-Bound': {
    text: 'Deathtouch\nAt the beginning of your end step, exile the top card of your library. Until the end of your next turn, you may play that card.\nWhenever you cast a spell from exile, create a Treasure token.',
    why: 'Pact Boon also counts lands played from exile; only spells are counted here.',
  },
  'Prosperous Thief': {
    text: 'Ninjutsu {1}{U}\nWhenever a creature you control deals combat damage to a player, create a Treasure token.',
    why: '"One or more Ninja or Rogue creatures": its deck is Ninjas and Rogues, so every creature counts. Several connecting at once make one Treasure each here.',
  },
  'Proteus Staff': {
    effects: [{ kind: 'removal', target: 'creature', mode: 'proteus', amount: 0, when: 'activated', activation: { cost: { generic: 2, pips: [['U']], x: 0, life: 0 }, tap: true, sacrifice: false, sorcery: true } }],
    notes: ['Activated ({2}{U}, sorcery): put a creature on the bottom of its library; its controller reveals until a creature card, puts it onto the battlefield and the rest on the bottom in any order'],
    why: 'Built in the engine as its own removal mode (proteus). With no other creature in the library, the tucked creature comes straight back and its controller stacks the whole library (Fblthp decks).',
  },
  'Psychic Frog': {
    text: 'Whenever ~ deals combat damage to a player or planeswalker, draw a card.\nDiscard a card: Put a +1/+1 counter on ~.',
    why: 'Exiling three graveyard cards for flying is left out.',
  },
  'Puresteel Paladin': {
    text: 'Whenever an artifact you control enters, you may draw a card.',
    why: 'Only Equipment draw; its deck is mostly Equipment. Equip {0} with metalcraft is left out.',
  },
  'Quest for the Nihil Stone': {
    text: 'Whenever an opponent discards a card, you may put a quest counter on ~.',
    add: [{ kind: 'drain', n: 5, gain: 0, emptyHand: true, when: 'upkeep', minCharge: 2 }],
    notes: ['With two or more quest counters: each opponent with no cards in hand loses 5 life each turn'],
    why: 'Happens at each opponent\'s upkeep in the card; here once a turn cycle at your upkeep, to each opponent with an empty hand.',
  },
  'Rain of Riches': {
    text: 'When ~ enters, create two Treasure tokens.\nWhenever you cast your first spell each turn, discover 4.',
    why: 'Cascade on the first spell each turn paid with Treasure mana. Its decks make Treasures every turn, so the first spell is played as cascading; cascade into a spell of mana value 4 or less is read as discover 4.',
  },
  'Ringwraiths': {
    text: 'When ~ enters, target creature an opponent controls gets -3/-3 until end of turn. If that creature is legendary, its controller loses 3 life.',
    why: 'Returning from the graveyard when the Ring tempts you is left out.',
  },
  'Rammas Echor, Ancient Shield': {
    text: 'Whenever you cast your second spell each turn, draw a card, then create a 0/3 white Wall creature token with defender.',
    why: 'Giving defenders exalted is left out: defenders rarely attack.',
  },
  'Rampaging Yao Guai': {
    text: 'Vigilance, trample\n~ enters with X +1/+1 counters on it.\nWhen ~ enters, destroy target artifact or enchantment.',
    why: 'Destroys any number of artifacts and enchantments with total mana value X or less; played as one.',
  },
  'Rankle, Master of Pranks': {
    text: 'Flying, haste\nWhenever ~ deals combat damage to a player, each opponent discards a card.\nWhenever ~ deals combat damage to a player, each opponent loses 1 life.\nWhenever ~ deals combat damage to a player, each player sacrifices a creature.',
    why: 'All three modes are chosen, as bots usually would. You also discard a card, lose 1 life and draw a card; those cancel out about evenly and are left out.',
  },
  'Ravenous Squirrel': {
    text: 'Whenever you sacrifice a permanent, put a +1/+1 counter on ~.\n{1}{B}{G}, Sacrifice a creature: You gain 1 life and draw a card.',
    why: 'Sacrificing an artifact instead of a creature is left out; the creature trigger counts any sacrificed permanent.',
  },
  'Reaper of Sheoldred': {
    text: 'Infect',
    add: [{ kind: 'damagedPunish', what: 'poison', when: 'static' }],
    notes: ['Whenever a source deals damage to it, that source\'s controller gets a poison counter'],
    why: 'Played as printed.',
  },
  'Redirect Lightning': {
    text: 'Change the target of target spell or ability with a single target.',
    why: 'The extra cost (5 life or {2}) is left out.',
  },
  'Reidane, God of the Worthy': {
    text: 'Flying, vigilance',
    add: [{ kind: 'spellTax', amount: 2, filter: 'noncreature', when: 'static', minCmc: 4 }],
    notes: ['Noncreature spells your opponents cast with mana value 4 or more cost {2} more'],
    why: 'Snow lands entering tapped is left out: no deck runs snow lands.',
  },
  'Reinforced Ronin': {
    text: 'Haste\nChannel — {1}{R}, Discard ~: Draw a card.',
    add: [{ kind: 'bounceSelfAtEnd', when: 'static' }],
    notes: ['Returns to your hand at your end step'],
    why: 'Played as printed.',
  },
  'Relic Putrescence': {
    effects: [{ kind: 'poison', n: 1, who: 'target', when: 'upkeep' }],
    notes: ['A poison counter for an opponent each turn (they tap the enchanted artifact)'],
    why: 'Enchants an opponent\'s mana rock: its controller gets a poison counter each time it taps, about once a turn; played as a poison counter at your upkeep.',
  },
  'Riverchurn Monument': {
    text: '{1}, {T}: Each opponent mills two cards.\n{2}{U}{U}, {T}: Each opponent mills ten cards.',
    why: 'Exhaust (once only) mills each player as many cards as are in their graveyard; played as ten, and not limited to once.',
  },
  'Satsuki, the Living Lore': {
    text: '{T}: Put a lore counter on target Saga you control.',
    why: 'Puts a lore counter on each Saga; played as one. The death trigger is read as before.',
  },
  'Scheming Aspirant': {
    text: 'Whenever you proliferate, each opponent loses 2 life and you gain 2 life.',
    why: 'Played as printed.',
  },
  'Scorch Spitter': {
    text: 'Whenever ~ attacks, ~ deals 1 damage to target opponent.',
    why: 'Hits the player it attacks; bots pick the same opponent.',
  },
  'Seasoned Dungeoneer': {
    text: 'When ~ enters, you become the monarch.',
    why: 'Taking the initiative is played as becoming the monarch: a card each turn, lost when a player deals you combat damage. The protection-and-explore attack trigger is left out.',
  },
  'Secret Arcade': {
    text: 'Whenever you cast an enchantment spell, put three +1/+1 counters on target creature.',
    why: 'Making your permanents enchantments is left out. The Dusty Parlor door (counters equal to the spell\'s mana value) is always on, with three counters.',
  },
  'Selfless Samurai': {
    text: 'Sacrifice ~: Another target creature you control gains indestructible until end of turn.',
    why: 'Lifelink for a lone attacking Samurai or Warrior is left out.',
  },
  'Selfless Spirit': {
    text: 'Flying\nSacrifice ~: Target creature you control gains indestructible until end of turn.',
    why: 'Saves all your creatures; played as saving the best one, which is how bots use it against removal. Against a wipe it saves only that one.',
  },
  'Sewer Nemesis': {
    text: "~'s power and toughness are each equal to the number of cards in the chosen player's graveyard.\nWhenever an opponent casts a spell, that player mills a card.",
    why: 'The chosen player is the opponent with the fullest graveyard.',
  },
  'Shabraz, the Skyshark': {
    text: 'Flying\nWhenever you draw a card, put a +1/+1 counter on ~ and you gain 1 life.',
    why: 'Giving a Human flying is left out.',
  },
  'Shay Cormac': {
    text: 'Whenever a creature an opponent controls becomes the target of a spell or ability you control, put a bounty counter on that creature.\nWhenever a creature with a bounty counter on it dies, put two +1/+1 counters on ~.',
    why: 'Removing opponents\' hexproof, indestructible and protection for {1} is left out.',
  },
  'Sheoldred, Whispering One': {
    text: 'Swampwalk\nAt the beginning of your upkeep, return target creature card from your graveyard to the battlefield.\nAt the beginning of your upkeep, each opponent sacrifices a creature.',
    why: 'Each opponent sacrifices at the start of their own turn; here all at once on yours, the same number per round.',
  },
  'Shimmering Mirage': {
    text: 'Draw a card.',
    why: 'Changing a land\'s type (for landwalk or land-type tricks) is left out.',
  },
  'Simian Spirit Guide': {
    text: '',
    why: 'Exiling it from hand for {R} is left out: bots keep it as a 2/2.',
  },
  "Sigarda's Aid": {
    text: 'You may cast Aura and Equipment spells as though they had flash.',
    why: 'Attaching Equipment for free as it enters is left out; bots pay equip costs.',
  },
  'Six': {
    text: 'Reach\nWhenever ~ attacks, mill three cards. You may put a land card from among them into your hand.',
    why: 'Retrace for permanent cards in your graveyard is left out.',
  },
  'Six-Sided Die': {
    effects: [{ kind: 'removal', target: 'creature', mode: 'destroy', amount: 0, when: 'resolve' }],
    notes: ['Removal: a creature (die roll; nearly always dies)'],
    why: 'Rolls a d6: 2, 4, 5 and 6 kill most creatures, 1 and 3 kill small ones. Played as destroying the creature.',
  },
  'Skittering Cicada': {
    text: 'Flash\nYou may cast colorless spells as though they had flash.\nWhenever you cast a colorless spell, ~ gets +3/+3 and gains trample until end of turn.',
    why: '+X/+X for the spell\'s mana value, played as +3/+3.',
  },
  "Skrelv's Hive": {
    text: 'At the beginning of your upkeep, you lose 1 life and create a 1/1 colorless Phyrexian Mite artifact creature token with toxic 1 and "This token can\'t block."',
    why: 'Lifelink for toxic creatures once an opponent has three poison counters is left out.',
  },
  'Slaughter Specialist': {
    text: 'Whenever a creature an opponent controls dies, put a +1/+1 counter on ~.',
    why: 'Each opponent getting a 1/1 Human is left out.',
  },
  'Slickshot Lockpicker': {
    text: 'When ~ enters, return target instant or sorcery card from your graveyard to your hand.\nPlot {2}{U}',
    why: 'Gives an instant or sorcery flashback this turn; played as returning it to hand (it should be cast this turn and then exiled).',
  },
  'Sneaky Snacker': {
    text: 'Flying',
    why: 'Returning from the graveyard when you draw your third card in a turn is left out.',
  },
  'Solemn Doomguide': {
    text: 'Flying',
    why: 'Unearth for Cleric, Rogue, Warrior and Wizard cards in your graveyard is left out.',
  },
  Soulherder: {
    text: 'At the beginning of your end step, you may exile another target creature you control, then return that card to the battlefield under its owner\'s control.\nAt the beginning of your end step, put a +1/+1 counter on ~.',
    why: 'Grows whenever any creature is exiled from the battlefield; its own blink each turn does that, so it gets one counter a turn. Other exiles are left out.',
  },
  'Sozin\'s Comet': {
    text: 'Creatures you control get +2/+0 and gain haste until end of turn.\nForetell {2}{R}',
    why: 'Firebending 5 on every creature makes five red mana per attacker, used in combat. Bots don\'t spend combat mana well, so it is played as a team pump.',
  },
  'Sram, Senior Edificer': {
    text: 'Whenever you cast an artifact spell, draw a card.',
    why: 'Draws on Auras, Equipment and Vehicles; read as artifact spells, which in its deck are mostly Equipment and Vehicles.',
  },
  'Stalwart Shield-Bearers': {
    text: 'Defender\nOther Walls you control get +0/+2.',
    why: '"Creatures with defender" read as Walls, which they are in its deck.',
  },
  'Starfield Mystic': {
    text: 'Enchantment spells you cast cost {1} less to cast.',
    why: 'The +1/+1 counter when an enchantment of yours goes to the graveyard is left out.',
  },
  'Starfield of Nyx': {
    text: 'At the beginning of your upkeep, you may return target enchantment card from your graveyard to the battlefield.',
    why: 'Turning your enchantments into creatures with five or more is left out.',
  },
  'Staff of Compleation': {
    text: '{T}, Pay 2 life: Add one mana of any color.\n{T}, Pay 3 life: Proliferate.\n{T}, Pay 4 life: Draw a card.\n{5}: Untap ~.',
    why: 'Destroying a permanent you own is left out: it is for death triggers bots don\'t plan.',
  },
  'Steal Enchantment': {
    effects: [{ kind: 'steal', from: 'battlefield', what: 'permanent', whileSource: true, when: 'resolve' }],
    notes: ['Gain control of an enchantment for as long as this stays'],
    why: 'Only enchantments can be taken; the engine picks the best permanent it can take, which may not be an enchantment.',
  },
  'Step Through': {
    effects: [
      { kind: 'removal', target: 'creature', mode: 'bounce', amount: 0, when: 'resolve' },
      { kind: 'removal', target: 'creature', mode: 'bounce', amount: 0, when: 'resolve' },
    ],
    notes: ['Return two creatures to their owners\' hands'],
    why: 'Played as printed, except wizardcycling {2}, which the reader takes for landcycling.',
  },
  'Stormkeld Vanguard': {
    text: "~ can't be blocked by creatures with power 2 or less.",
    why: 'Played as printed.',
  },
  'Stoneforge Mystic': {
    text: 'When ~ enters, you may search your library for an Equipment card, reveal it, put it into your hand, then shuffle.',
    why: 'Putting an Equipment from hand onto the battlefield for {1}{W} is left out; bots cast it.',
  },
  'Strixhaven Stadium': {
    text: '{T}: Add {C}. Put a point counter on ~.\nWhenever a creature you control deals combat damage to an opponent, put a point counter on ~. Then if it has ten or more point counters on it, remove them all and that player loses the game.',
    why: 'Losing a point counter when a creature deals combat damage to you is left out.',
  },
  'Surge Conductor': {
    text: 'Whenever another artifact you control enters, proliferate.',
    why: 'Only nontoken artifacts count; Treasures and Clues trigger it here.',
  },
  'Surgehacker Mech': {
    text: 'Menace\nWhen ~ enters, it deals 4 damage to target creature or planeswalker an opponent controls.\nCrew 4',
    why: 'Twice the Vehicles you control, played as 4 (it and one other).',
  },
  'Syr Ginger, the Meal Ender': {
    text: 'Whenever you sacrifice a permanent, put a +1/+1 counter on ~ and scry 1.',
    why: 'Artifacts going to your graveyard are mostly sacrificed Food and Treasures. Trample, hexproof and haste against planeswalkers, and the sacrifice for life, are left out.',
  },
  'Tainted Sigil': {
    text: '{T}, Sacrifice ~: You gain 10 life.',
    why: 'Gains the life everyone lost this turn; played as 10.',
  },
  'Tekuthal, Inquiry Dominus': {
    text: 'Flying\n{1}{U/P}{U/P}: Put an indestructible counter on ~.',
    add: [{ kind: 'proliferateTwice', when: 'static' }],
    notes: ['If you would proliferate, you proliferate twice instead'],
    why: 'Removing three counters as part of the cost is left out.',
  },
  'Termination Facilitator': {
    text: '{T}: Put a bounty counter on target creature or planeswalker. Activate only as a sorcery.',
    add: [{ kind: 'bountyDestroy', when: 'static' }],
    notes: ['A creature an opponent controls with a bounty counter is destroyed when it is dealt damage'],
    why: 'Played as printed.',
  },
  'Teyo, the Shieldmage': {
    text: 'You have hexproof.\n−2: Create a 0/3 white Wall creature token with defender.',
    why: 'Played as printed.',
  },
  'The Endstone': {
    text: 'Whenever you play a land or cast a spell, draw a card.',
    add: [{ kind: 'lifeBecomes', n: 20, when: 'static' }],
    notes: ['At your end step your life total becomes 20'],
    why: 'Half the starting life total of 40 is 20. Lands played don\'t draw here, only spells.',
  },
  'The Foretold Soldier': {
    text: 'Foretell {1}{G}',
    why: 'Must be blocked, can\'t be blocked by more than one creature, and returning to exile foretold after dealing damage are left out: it plays as a 6/6.',
  },
  'The Grim Captain\'s Locker': {
    text: '{T}: Surveil 1.',
    why: 'Giving creature cards in your graveyard escape is left out.',
  },
  'The Pride of Hull Clade': {
    text: 'Defender',
    why: 'Its cost reduction (total toughness) and the {2}{U}{U} draw on combat damage are left out: it plays as a 2/15 wall.',
  },
  'The Soul Stone': {
    text: 'Indestructible\n{T}: Add {B}.\n{6}{B}, {T}, Sacrifice a creature: Put a charge counter on ~.\nAt the beginning of your upkeep, if ~ has one or more charge counters on it, return target creature card from your graveyard to the battlefield.',
    why: 'Harnessing it is a charge counter; exiling the creature is read as sacrificing it.',
  },
  'Thermal Flux': {
    text: 'Draw a card.',
    why: 'Making a permanent snow or not snow is left out; the card comes at once instead of next upkeep.',
  },
  'Thought-Stalker Warlock': {
    text: 'Menace\nWhen ~ enters, target opponent discards a card.',
    why: 'You choose the card only if they lost life this turn; played as a plain discard.',
  },
  'Threefold Thunderhulk': {
    text: '~ enters with three +1/+1 counters on it.\nWhenever ~ enters or attacks, create a number of 1/1 colorless Gnome artifact creature tokens equal to its power.\n{2}, Sacrifice a creature: Put a +1/+1 counter on ~.',
    why: 'Sacrifice another artifact; its Gnomes are artifact creatures, so they pay for it.',
  },
  'Throne of Geth': {
    effects: [{ kind: 'counters', n: 1, all: true, proliferate: true, when: 'activated', activation: { cost: { generic: 0, pips: [], x: 0, life: 0 }, tap: true, sacrifice: false, sacOther: { what: 'artifact', n: 1 } } }],
    notes: ['Activated ({T}, sacrifice an artifact): proliferate'],
    why: 'Played as printed.',
  },
  'Thunderwave': {
    effects: [{ kind: 'wipe', target: 'creatures', mode: 'damage', amount: 3, oneSided: false, when: 'resolve' }],
    notes: ['3 damage to each creature (d20: 1–19); a 20 is 6 to opponents\' creatures only'],
    why: 'Rolls a d20: 1–9 hits every creature, 10–19 spares one of yours, 20 hits only opponents\' for 6. Played as 3 to each creature.',
  },
  'Time Stop': {
    text: 'Counter target spell.',
    why: 'Ending the turn exiles every spell on the stack; bots use it as a counterspell.',
  },
  'Tinybones Joins Up': {
    text: 'When ~ enters, each opponent discards a card.\nWhenever a legendary creature you control enters, each opponent mills a card and loses 1 life.',
    why: '"Any number of target players": bots pick every opponent.',
  },
  'Titan\'s Presence': {
    text: 'Exile target creature.',
    why: 'Only a creature with power up to that of a colorless creature you reveal; its deck holds big Eldrazi, so nearly anything.',
  },
  'Tivit, Seller of Secrets': {
    text: "Flying, ward {3}\nCouncil's dilemma — Whenever ~ enters or deals combat damage to a player, starting with you, each player votes for evidence or bribery. For each evidence vote, investigate. For each bribery vote, create a Treasure token.",
    why: 'Your extra vote is already in the reading: votes are counted as you choosing for everyone.',
  },
  'Tomb Trawler': {
    text: '',
    why: 'Putting a graveyard card on the bottom of your library is left out: it plays as a 0/4.',
  },
  'Toralf, God of Fury': {
    text: 'Trample',
    why: 'Excess noncombat damage to opponents\' creatures being dealt again is left out.',
  },
  'Totentanz, Swarm Piper': {
    text: 'Whenever ~ or another nontoken creature you control dies, create a 1/1 black Rat creature token with "This token can\'t block."',
    why: 'Giving an attacking Rat deathtouch is left out.',
  },
  'Tragic Slip': {
    text: 'Target creature gets -13/-13 until end of turn.',
    why: 'Morbid: -13/-13 if a creature died this turn, else -1/-1. Bots usually cast it after a trade or sacrifice, so it is played as the big version.',
  },
  'Tree of Perdition': {
    text: 'Defender',
    why: 'Swapping an opponent\'s life with its toughness is left out.',
  },
  'Twenty-Toed Toad': {
    text: 'Whenever ~ attacks, you win the game if there are twenty or more counters on it or you have twenty or more cards in hand.\nWhenever you attack with two or more creatures, put a +1/+1 counter on ~ and draw a card.\nYou have no maximum hand size.',
    why: 'A maximum hand size of twenty is read as none.',
  },
  'Ulamog, the Ceaseless Hunger': {
    text: 'Indestructible\nWhen ~ enters, exile target nonland permanent.\nWhen ~ enters, exile target nonland permanent.\nWhenever ~ attacks, defending player mills twenty cards.',
    why: 'Its cast trigger is played on entering. Defending player exiles their top twenty cards; read as milling.',
  },
  'Ulamog, the Defiler': {
    text: 'When you cast ~, target opponent mills half their library.\n~ enters with ten +1/+1 counters on it.\nAnnihilator 4',
    why: 'Exiling half the library is read as milling it. Counters equal to the greatest mana value in exile: about ten. Annihilator X for its counters: played as 4.',
  },
  'Umbris, Fear Manifest': {
    text: '~ gets +1/+1 for each card your opponents own in exile.\nWhenever another creature you control enters, target opponent mills three cards.\nWhen ~ enters, target opponent mills three cards.',
    why: 'Exiling until a land (about three cards) is read as milling, so those cards don\'t grow Umbris; only Nightmares and Horrors trigger it, read as any creature.',
  },
  'Unbreakable Formation': {
    text: 'Creatures you control gain indestructible until end of turn.',
    why: 'The addendum (counters and vigilance in your main phase) is left out: bots cast it in response to removal.',
  },
  'Uncivil Unrest': {
    text: 'Creatures you control have haste.\nIf a creature you control with a +1/+1 counter on it would deal damage to a permanent or player, it deals double that damage instead.',
    why: 'Riot gives the choice of haste or a +1/+1 counter; played as haste.',
  },
  'Unshakable Tail': {
    text: 'When ~ enters, surveil 1.\nAt the beginning of your upkeep, surveil 1.',
    why: 'Investigating when creature cards are milled and returning by sacrificing a Clue are left out.',
  },
  'Uglúk of the White Hand': {
    text: 'Whenever another creature you control dies, put a +1/+1 counter on ~.',
    why: 'Two counters for a Goblin or Orc is left out.',
  },
  'Vedalken Aethermage': {
    text: 'Flash\nCycling {3}',
    why: 'Bouncing a Sliver is left out: no Slivers in its deck. Wizardcycling finds a Wizard; the reader took it for landcycling, so it is played as cycling (a card).',
  },
  'Venat, Heart of Hydaelyn': {
    text: 'Whenever you cast a legendary spell, draw a card. This ability triggers only once each turn.\n{7}, {T}: Exile target nonland permanent. Transform ~. Activate only as a sorcery.',
    why: 'The ability word is dropped so the reader sees the cost.',
  },
  'Verity Circle': {
    text: '{4}{U}: Tap target creature without flying. Draw a card.',
    why: 'Draws whenever an opponent\'s creature becomes tapped other than by attacking; here only when it taps one itself.',
  },
  "Vivi's Persistence": {
    text: 'Create a 0/1 black Wizard creature token.',
    why: 'The token\'s "1 damage to each opponent on noncreature spells" and returning the card when your commander enters or attacks are left out.',
  },
  'Vorpal Sword': {
    text: 'Equipped creature gets +2/+0 and has deathtouch.\nEquip {B}{B}',
    why: 'The {5}{B}{B}{B} "that player loses the game" is left out.',
  },
  'Wail of the Nim': {
    text: 'Choose one —\n• Creatures you control gain indestructible until end of turn.\n• ~ deals 1 damage to each creature and each player.\nEntwine {B}',
    why: 'Regenerating your creatures is played as indestructible this turn (rule 701.19: both stop destruction).',
  },
  'Wall of Junk': {
    text: 'Defender',
    why: 'Returning to hand after blocking is left out.',
  },
  'Wan Shi Tong, Librarian': {
    text: 'Flash\nFlying, vigilance\n~ enters with X +1/+1 counters on it.\nWhenever an opponent searches their library, put a +1/+1 counter on ~ and draw a card.',
    add: [{ kind: 'draw', n: -1, xTimes: 0.5, when: 'resolve' }],
    notes: ['When it enters: draw half X cards'],
    why: '"On him": the reader didn\'t take "him" for the card.',
  },
  'Warbeast of Gorgoroth': {
    text: 'Whenever ~ or another creature you control dies, amass Orcs 2.',
    why: 'Only creatures with power 4 or more; read as any creature.',
  },
  'Watcher of Hours': {
    text: 'Flying, ward {3}\nSuspend 6—{1}{U}',
    why: 'Surveil 1 as each time counter comes off is left out.',
  },
  'Wear': {
    text: 'Destroy target artifact.\nDestroy target enchantment.',
    why: 'Fuse (rule 702.102): both halves together. The extra {W} for Tear is left out.',
  },
  'Weathered Sentinels': {
    text: 'Defender, reach, vigilance, trample\nWhenever ~ attacks, it gets +3/+3 and gains indestructible until end of turn.',
    why: 'Attacking players who attacked you is left out: it stays home.',
  },
  'Weatherlight': {
    text: 'Flying\nWhenever ~ deals combat damage to a player, draw a card.\nCrew 3',
    why: 'Takes a historic card from the top five; its deck is mostly historic, so read as drawing one.',
  },
  'Weftstalker Ardent': {
    text: 'Whenever another creature you control enters, ~ deals 1 damage to each opponent.\nWhenever an artifact you control enters, ~ deals 1 damage to each opponent.\nWarp {R}',
    why: 'Artifact creatures trigger it twice here instead of once.',
  },
  'Welcoming Vampire': {
    text: 'Flying\nWhenever another creature you control enters, draw a card. This ability triggers only once each turn.',
    why: 'Only creatures with power 2 or less; its deck is mostly small creatures.',
  },
  'Well of Ideas': {
    text: 'When ~ enters, draw two cards.\nAt the beginning of your upkeep, draw two cards.\nAt the beginning of each opponent\'s upkeep, that player draws a card.',
    why: 'The extra draws come in draw steps; played at upkeep.',
  },
  'Werebear': {
    text: '{T}: Add {G}.',
    why: 'Threshold (+3/+3 with seven cards in your graveyard) is left out: it plays as a mana creature.',
  },
  'Wild-Magic Sorcerer': {
    text: 'Whenever you cast a spell from exile, discover 3.',
    why: 'Cascade on the first spell cast from exile each turn, read as discover 3.',
  },
  'Wildsear, Scouring Maw': {
    text: 'Trample\nWhenever you cast an enchantment spell, discover 3.',
    why: 'Enchantment spells from hand have cascade; read as discover 3 (a free spell of mana value 3 or less).',
  },
  'Witch-king, Bringer of Ruin': {
    text: 'Flying\nWhenever ~ attacks, target opponent sacrifices a creature.',
    why: 'The defending player sacrifices their weakest creature; here the opponent picks which.',
  },
  'Woebringer Demon': {
    text: 'Flying\nAt the beginning of your upkeep, each player sacrifices a creature.',
    why: 'Each player sacrifices at their own upkeep; here all at once on yours. If you can\'t, Woebringer goes: left out.',
  },
  'Wyll, Blade of Frontiers': {
    text: 'Whenever you roll one or more dice, put a +1/+1 counter on ~.',
    why: 'Rolling an extra die and dropping the lowest is left out.',
  },
  'Xathrid Necromancer': {
    text: 'Whenever a Human you control dies, create a tapped 2/2 black Zombie creature token.',
    why: 'Xathrid itself is a Human, so it counts.',
  },
  'Yorion, Sky Nomad': {
    text: 'Flying\nWhen ~ enters, exile up to two other target nonland permanents you control, then return them to the battlefield under their owner\'s control.',
    why: 'Any number of your nonland permanents come back at the end step; played as two, at once. Companion is left out.',
  },
  'Zhulodok, Void Gorger': {
    text: 'Whenever you cast a colorless spell with mana value 7 or greater, discover 6.\nWhenever you cast a colorless spell with mana value 7 or greater, discover 6.',
    why: 'Cascade twice on big colorless spells from hand, read as discover 6 twice.',
  },
  'Zuko, Seeking Honor': {
    text: 'Firebending 1\nWhenever you cast a noncreature spell, ~ gains first strike until end of turn.\nWhenever ~ deals combat damage to a player, put a +1/+1 counter on ~.',
    why: '"On him": the reader didn\'t take "him" for the card.',
  },
};
