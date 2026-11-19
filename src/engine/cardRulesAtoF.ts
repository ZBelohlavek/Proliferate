// Card-specific rules for one-off cards from A to F in Zach's decks: cards whose unread lines
// share no mechanic with other cards. Each is written in wordings the reader knows; what is left
// out or approximated is said in `why`. Spread into CARD_RULES (cardRules.ts), which explains the
// fields. Cards whose only gap is a keyword another file reads (cascade, living weapon, job
// select, landwalk, myriad, vanishing, fabricate, assist, "you have hexproof", evasion by power) have no entry here.

import type { CardRule } from './cardRules';
import type { Effect } from './types';

export const CARD_RULES_A_TO_F: Record<string, CardRule> = {
  'Aetheric Amplifier': {
    text: '{T}: Add one mana of any color.\n{4}, {T}: Proliferate. Activate only as a sorcery.',
    why: 'Doubling the counters on a permanent (or your own counters) is played as proliferate: one more of each kind, which is all the engine can add at once.',
  },
  'Aethertide Whale': {
    text: 'Flying\nWhen ~ enters, you get six {E}.',
    why: 'Paying four energy to return it to hand is left out: bots don\'t save creatures from removal in response, so the energy is kept for other energy cards.',
  },
  'Agility Bobblehead': {
    text: "{T}: Add one mana of any color.\n{3}, {T}: Target creature you control can't be blocked this turn.",
    why: 'X is the number of Bobbleheads you control, nearly always one; the creature is made unblockable (only hasty creatures could block it) and the haste is left out.',
  },
  'Airbender Ascension': {
    text: "When ~ enters, return up to one target creature to its owner's hand.\nWhenever a creature you control enters, put a quest counter on ~.\nAt the beginning of your end step, if ~ has four or more quest counters on it, exile up to one target creature you control, then return it to the battlefield under its owner's control.",
    why: 'Airbend exiles the creature and lets its owner cast it again for {2}; played as returning it to its owner\'s hand, which costs them about as much.',
  },
  'Alandra, Sky Dreamer': {
    text: 'Whenever you draw your second card each turn, create a 2/2 blue Drake creature token with flying.',
    why: 'The fifth-card pump (+X/+X to Alandra and Drakes, X = cards in hand) is left out: bots seldom draw five in a turn.',
  },
  'All Will Be One': {
    text: 'Whenever one or more +1/+1 counters are put on a creature you control, ~ deals that much damage to any target.',
    why: 'Only +1/+1 counters on your creatures are counted; counters on other permanents and players (loyalty, poison, charge) are left out. Bots aim the damage at an opponent or their creature.',
  },
  'Alora, Merry Thief': {
    text: "Whenever ~ attacks, target creature you control can't be blocked this turn.",
    why: '"Whenever you attack" is read as Alora attacking. Returning the creature to hand at end of turn is left out (it is mostly a way to reuse enters abilities).',
  },
  'Altar of the Pantheon': {
    text: '{T}: Add one mana of any color.',
    why: 'Devotion +1 and the 1 life with a God or legendary enchantment are left out.',
  },
  'Alter Reality': {
    text: '',
    why: 'Changing a color word in a card\'s text does nothing in this engine, which reads text once when the deck is built. Bots never cast it.',
  },
  "Angel's Grace": {
    text: "You can't lose the game this turn and your opponents can't win the game this turn. Until end of turn, damage that would reduce your life total to less than 1 reduces it to 1 instead.",
    why: 'Split second (rule 702.61) is left out: bots rarely respond to it anyway.',
  },
  Anger: {
    text: 'Haste',
    why: 'Giving your creatures haste from the graveyard is left out: the engine has no abilities that work from a graveyard.',
  },
  'Animation Module': {
    text: 'Whenever one or more +1/+1 counters are put on a permanent you control, you may pay {1}. If you do, create a 1/1 colorless Servo artifact creature token.\n{3}, {T}: Proliferate.',
    why: 'Adding one counter of a kind already on a permanent or player is played as proliferate.',
  },
  'Ao, the Dawn Sky': {
    text: 'Flying, vigilance\nWhen ~ dies, put two +1/+1 counters on each creature you control.',
    why: 'Of its two death modes, bots take the counters; looking at the top seven for permanents with total mana value 4 is left out.',
  },
  'Archetype of Courage': {
    text: 'Creatures you control have first strike.',
    why: 'Opponents\' creatures losing first strike is left out.',
  },
  'Archetype of Imagination': {
    text: 'Creatures you control have flying.',
    add: [{ kind: 'anthem', p: 0, t: 0, keywords: ['unblockable'], when: 'static' }],
    notes: ['Your creatures can\'t be blocked (opponents\' creatures lose flying)'],
    why: 'Opponents\' creatures lose flying, so only creatures with reach could block your flyers: played as your creatures being unblockable.',
  },
  "Archon of Sun's Grace": {
    text: 'Flying\nLifelink\nConstellation — Whenever an enchantment you control enters, create a 2/2 white Pegasus creature token with flying.',
    add: [{ kind: 'anthem', p: 0, t: 0, keywords: ['lifelink'], subtype: 'Pegasus', other: true, when: 'static' }],
    notes: ['Your other Pegasus creatures have lifelink'],
    why: '"Pegasus creatures you control have lifelink" given as a Pegasus-only anthem.',
  },
  'Arm with Aether': {
    text: "Return target creature an opponent controls to its owner's hand.\nReturn target creature an opponent controls to its owner's hand.",
    why: 'Each of your creatures that damages an opponent bounces one of their creatures; played as bouncing two opposing creatures when cast, before combat.',
  },
  'Arterial Alchemy': {
    text: 'When ~ enters, create a Blood token for each opponent you have.',
    why: 'Blood tokens becoming +2/+0 Equipment (equip {2}) is left out: tokens are not equipment here.',
  },
  Asceticism: {
    text: 'Creatures you control have hexproof.\n{1}{G}: Target creature gains indestructible until end of turn.',
    why: 'Regenerate (rule 701.19) is played as indestructible this turn, which it nearly always amounts to.',
  },
  "Ashiok's Reaper": {
    text: 'Whenever an enchantment you control is put into a graveyard from the battlefield, draw a card.',
    why: 'Read as written; the trigger was added to the engine with this card.',
  },
  'Ashling, Flame Dancer': {
    text: "Magecraft — Whenever you cast or copy an instant or sorcery spell, discard a card, then draw a card. If this is the second time this ability has resolved this turn, ~ deals 2 damage to each opponent and each creature they control. If it's the third time, add {R}{R}{R}{R}.",
    why: 'Keeping unspent red mana between steps is left out: bots spend mana in the main phase.',
  },
  'Ashling, the Extinguisher': {
    text: 'Whenever ~ deals combat damage to a player, target player sacrifices a creature.',
    why: 'Ashling chooses which creature; here the player hit sacrifices one of their choice.',
  },
  'Assault Formation': {
    text: 'Each creature you control assigns combat damage equal to its toughness rather than its power.\n{2}{G}: Creatures you control get +0/+1 until end of turn.',
    why: 'Letting a defender attack for {G} is left out.',
  },
  'Aura of Silence': {
    text: 'Noncreature spells your opponents cast cost {1} more to cast.\nSacrifice ~: Destroy target artifact or enchantment.',
    why: 'Artifact and enchantment spells cost {2} more; the engine taxes noncreature spells, so it is {1} on all of them, about the same on average.',
  },
  'Authority of the Consuls': {
    text: 'Creatures your opponents control enter tapped.\nWhenever a creature an opponent controls enters, you gain 1 life.',
    why: 'Read as written; both lines were added to the engine with this card.',
  },
  'Aven Interrupter': {
    text: 'Flash\nFlying\nWhen ~ enters, exile target spell. It becomes plotted.',
    why: 'The {2} tax on opponents\' spells cast from graveyards and exile is left out.',
  },
  'Ballot Broker': {
    text: '',
    why: 'Extra votes are left out: votes are decided by the reader when the voting card is read. Played as a 2/3.',
  },
  'Barbarian Class': {
    text: '{1}{R}: Level 2\nWhenever you roll one or more dice, target creature you control gets +2/+0 and gains menace until end of turn.\n{2}{R}: Level 3\nCreatures you control have haste.',
    why: 'Rolling an extra die and dropping the lowest is left out.',
  },
  'Barkform Harvester': {
    text: 'Changeling\nReach',
    why: 'Putting a graveyard card on the bottom of the library is left out.',
  },
  'Bear Umbra': {
    text: 'Enchant creature\nEnchanted creature gets +2/+2.\nWhenever enchanted creature attacks, untap all lands you control.',
    why: 'Umbra armor (rule 702.89) is left out: the Aura does not save the creature.',
  },
  "Berserker's Frenzy": {
    text: '',
    why: 'Forcing or choosing blocks is not modelled. Bots never cast it.',
  },
  Biotransference: {
    text: 'Whenever you cast an artifact or creature spell, you lose 1 life and create a 2/2 black Necron Warrior artifact creature token.',
    why: 'Your creatures being artifacts is played only through its own trigger, which now counts creature spells. Other artifact-matters cards don\'t see your creatures as artifacts.',
  },
  "Black Mage's Rod": {
    text: 'Job select\nEquipped creature gets +1/+0.\nWhenever you cast a noncreature spell, ~ deals 1 damage to each opponent.\nEquip {3}',
    why: 'The 1 damage on each noncreature spell is the equipped creature\'s ability; here it comes from the Rod, which is nearly always on a creature (the Hero from job select first).',
  },
  'Blind Obedience': {
    text: 'Extort\nArtifacts and creatures your opponents control enter tapped.',
    why: 'Read as written; opponents\' artifacts and creatures entering tapped was added to the engine with this card.',
  },
  'Bloodchief Ascension': {
    effects: (['creatureDies', 'opponentDiscard', 'milled'] as const).flatMap((when) => [
      { kind: 'damagePlayer', n: 2, lifeLoss: true, when, scope: when === 'creatureDies' ? 'opponents' : when === 'milled' ? 'any' : undefined, minCharge: 3 },
      { kind: 'gainLife', n: 2, when, scope: when === 'creatureDies' ? 'opponents' : when === 'milled' ? 'any' : undefined, minCharge: 3 },
    ] as Effect[]),
    notes: ['A quest counter at each end step in which an opponent lost 2 or more life', 'With three or more: an opponent loses 2 and you gain 2 when their creature dies, they discard, or they mill'],
    why: 'Cards put into an opponent\'s graveyard are counted when their creature dies, for each card they discard, and once for each time they mill; cards from spells resolving are left out. The quest counters are kept by the engine (Game.questCounters).',
  },
  'Bloodletter of Aclazotz': {
    text: 'Flying\nIf a source would deal damage to an opponent or a permanent an opponent controls, that source deals double that damage instead.',
    why: 'Opponents lose twice as much life during your turn; played as doubled damage to opponents (and their permanents) at any time, which is when nearly all of it happens.',
  },
  'Bloodthirsty Blade': {
    text: 'Equipped creature gets +2/+0 and is goaded.\n{1}: Goad target creature an opponent controls. Activate only as a sorcery.',
    why: 'Attaching the Blade to an opponent\'s creature is played as goading that creature.',
  },
  'Body of Knowledge': {
    text: "~'s power and toughness are each equal to the number of cards in your hand.\nYou have no maximum hand size.",
    why: 'Drawing a card for each damage dealt to it is left out.',
  },
  "Bolas's Citadel": {
    text: 'You may look at the top card of your library any time.\nYou may play lands and cast spells from the top of your library. If you cast a spell this way, pay life equal to its mana value rather than pay its mana cost.',
    why: 'Sacrificing ten nonland permanents for 10 life loss each is left out: bots rarely have ten to spare.',
  },
  "Bootleggers' Stash": {
    text: 'At the beginning of your end step, create a Treasure token for each land you control.',
    why: 'Each land can tap for a Treasure instead of mana; played as Treasures for the lands at the end step (the engine reads about three).',
  },
  'Bramble Familiar': {
    text: '{T}: Add {G}.',
    why: 'Returning it to hand by discarding a card (to cast the Fetch Quest adventure again) is left out.',
  },
  "Brago's Representative": {
    text: '',
    why: 'Extra votes are left out: votes are decided by the reader when the voting card is read. Played as a 1/4.',
  },
  'Brash Taunter': {
    text: 'Indestructible\n{2}{R}, {T}: ~ deals 3 damage to target opponent.',
    why: 'Fighting a creature hurts the Taunter, which passes the damage to an opponent; played as 3 damage to an opponent, about the power of what it fights. Damage from other sources is left out.',
  },
  'Brave the Sands': {
    text: 'Creatures you control have vigilance.',
    why: 'Blocking an additional creature is left out.',
  },
  'Brazen Borrower': {
    text: "Flash\nFlying\n~ can't block.",
    why: 'It can block only creatures with flying; played as not blocking at all.',
  },
  'Bria, Riptide Rogue': {
    text: "Prowess\nWhenever you cast a noncreature spell, creatures you control get +1/+1 until end of turn.\nWhenever you cast a noncreature spell, target creature you control can't be blocked this turn.",
    why: 'Other creatures having prowess is the same as the team getting +1/+1 for each noncreature spell.',
  },
  'Brotherhood Scribe': {
    text: '{T}: You get {E}.\nWhenever you get one or more {E} during your turn, creatures you control get +1/+1 until end of turn.',
    why: 'Metalcraft (three artifacts) is assumed met.',
  },
  'Burning Sands': {
    text: 'Whenever a creature an opponent controls dies, destroy target land an opponent controls.',
    why: 'Each creature\'s controller sacrifices a land of their choice; played one-sided against opponents (its deck builds around that), with the land picked by you.',
  },
  'Caged Sun': {
    text: 'Creatures you control get +1/+1.\nWhenever a land\'s ability causes you to add one or more mana of the chosen color, add an additional one mana of that color.',
    why: 'The chosen color is your deck\'s main color, so the anthem covers most of your creatures.',
  },
  'Calamity of the Titans': {
    text: "Exile each creature and planeswalker with mana value less than the revealed card's mana value.",
    why: 'Revealing a colorless creature card is assumed possible in its deck.',
  },
  'Call of the Ring': {
    text: 'At the beginning of your upkeep, the Ring tempts you.\nAt the beginning of your upkeep, you may pay 2 life. If you do, draw a card.',
    why: 'The Ring tempts you each upkeep and you choose a Ring-bearer each time, so the draw comes every upkeep.',
  },
  'Camellia, the Seedmiser': {
    text: 'Menace\nOther Squirrels you control have menace.\nWhenever you sacrifice one or more Foods, create a 1/1 green Squirrel creature token.\n{2}, Sacrifice a Food: Put a +1/+1 counter on each other creature you control.',
    why: 'Forage is played as sacrificing a Food; the counters go on each other creature (mostly Squirrels in its deck).',
  },
  'Case of the Ransacked Lab': {
    text: 'Instant and sorcery spells you cast cost {1} less to cast.',
    why: 'Solving it needs four instants and sorceries in one turn, which bots almost never do; the card draw is left out.',
  },
  'Case of the Shifting Visage': {
    text: 'At the beginning of your upkeep, surveil 1.',
    why: 'Copying nonlegendary creature spells once fifteen cards are in your graveyard is left out.',
  },
  'Cauldron Familiar': {
    text: 'When ~ enters, each opponent loses 1 life and you gain 1 life.',
    why: 'Returning from the graveyard by sacrificing a Food is left out: the engine has no abilities that work from a graveyard.',
  },
  'Cavern-Hoard Dragon': {
    text: 'This spell costs {X} less to cast, where X is the greatest number of artifacts an opponent controls.\nFlying, trample, haste\nWhenever ~ deals combat damage to a player, you create a Treasure token for each artifact that player controls.',
    why: 'Read as written; the cost reduction was added to the engine with this card.',
  },
  'Cayth, Famed Mechanist': {
    text: 'Fabricate 1\nWhenever another nontoken creature you control enters, create a 1/1 colorless Servo artifact creature token.\n{2}, {T}: Proliferate.',
    why: 'Other nontoken creatures having fabricate 1 is played as a Servo for each (bots take the token). Of the {2}, {T} modes, proliferate is kept and populate left out.',
  },
  'Celebr-8000': {
    text: 'At the beginning of combat on your turn, ~ gets +1/+1 and gains menace until end of turn.',
    keywords: [],
    why: 'Two d6 each give +1/+1 or one ability this turn; played as +1/+1 and menace. The card data lists all five abilities as keywords, which it doesn\'t have all the time.',
  },
  'Cephalid Constable': {
    text: "Whenever ~ deals combat damage to a player, return target permanent that player controls to its owner's hand.",
    why: 'It returns up to that many permanents (its power, usually 1).',
  },
  "Champion's Helm": {
    text: 'Equipped creature gets +2/+2 and has hexproof.\nEquip {1}',
    why: 'Hexproof only on a legendary creature: bots equip their commander first.',
  },
  "Chandra's Pyreling": {
    text: '',
    why: 'Getting +1/+0 and double strike when you deal noncombat damage is left out. Played as a 1/3.',
  },
  'Charred Foyer': {
    text: 'At the beginning of your upkeep, exile the top card of your library. You may play it this turn.',
    why: 'Warped Space (casting a spell from exile for free once each turn) is left out.',
  },
  'Children of Korlis': {
    text: '',
    why: 'Sacrificing it to gain the life lost this turn is left out. Played as a 1/1.',
  },
  'Chromatic Orrery': {
    text: '{T}: Add {C}{C}{C}{C}{C}.\n{5}, {T}: Draw a card for each color among permanents you control.',
    why: 'Spending mana as though it were any color is left out.',
  },
  'Chrome Mox': {
    text: '{T}: Add one mana of any color.',
    why: 'Imprinting (exiling a card from hand) is left out, so it is a free mana rock.',
  },
  'Claws of Gix': {
    text: '',
    why: '1 life for a permanent: bots never sacrifice for it.',
  },
  'Coldsteel Heart': {
    text: '~ enters tapped.\n{T}: Add one mana of any color.',
    why: 'The color chosen as it enters is whichever you need.',
  },
  'Combat Research': {
    text: 'Enchant creature\nEnchanted creature gets +1/+1.\nWhenever enchanted creature deals combat damage to a player, draw a card.',
    why: '+1/+1 and ward {1} only on a legendary creature; bots enchant their commander, and the ward is left out.',
  },
  'Comet, Stellar Pup': {
    text: '+1: Create two 1/1 green Squirrel creature tokens. They gain haste until end of turn.\n−2: ~ deals 4 damage to any target.',
    why: 'Its one ability rolls a d6; played as its two common results (Squirrels, or damage equal to loyalty). The graveyard return and extra activations are left out.',
  },
  'Compleated Huntmaster': {
    text: '{1}, {T}, Sacrifice another creature: Incubate 3.',
    why: 'An artifact may be sacrificed instead of a creature; bots sacrifice a creature.',
  },
  'Contraband Livestock': {
    text: 'Exile target creature.',
    why: 'Its controller gets a token from a d20 roll (4/4, 2/2 or 0/1); left out.',
  },
  'Crystal Spray': {
    text: 'Draw a card.',
    why: 'Changing a color word or basic land type in a card\'s text does nothing in this engine. Bots cast it to draw a card.',
  },
  'Custodi Lich': {
    text: 'When ~ enters, you become the monarch.\nWhen ~ enters, target player sacrifices a creature.',
    why: 'The sacrifice comes each time you become the monarch; played once, as it enters. Taking the crown back later is left out.',
  },
  'Danny Pink': {
    text: 'Mentor\nWhenever one or more +1/+1 counters are put on a creature you control, draw a card.',
    why: 'Each creature draws for the first counters each turn; any counter on a creature you control draws here. Mentor is read by the engine.',
  },
  'Darksteel Monolith': {
    text: 'Indestructible',
    add: [{ kind: 'costReduction', amount: 6, filter: 'colorless', first: true, when: 'static' }],
    notes: ['The first colorless spell each turn costs {6} less (≈ free)'],
    why: 'Casting a colorless spell from hand without paying its mana cost once each turn: played as {6} off the first colorless spell each turn.',
  },
  'Chatterfang, Squirrel General': {
    text: 'Forestwalk\nIf one or more tokens would be created under your control, those tokens plus that many 1/1 green Squirrel creature tokens are created instead.',
    why: 'Sacrificing X Squirrels to give a creature +X/-X is left out.',
  },
  'Dauthi Voidwalker': {
    text: "Shadow\nIf a card would be put into an opponent's graveyard from anywhere, instead exile it with a void counter on it.\n{T}, Sacrifice ~: Draw a card.",
    why: 'Playing an opponent\'s exiled card for free is played as drawing a card.',
  },
  'Davriel, Rogue Shadowmage': {
    text: '−1: Target player discards a card.',
    why: 'The 2 damage to opponents with one or fewer cards in hand at their upkeep is left out.',
  },
  'Deadeye Navigator': {
    text: "{1}{U}: Exile another target creature you control, then return it to the battlefield under its owner's control.",
    why: 'Soulbond (rule 702.95) pairs it with a creature, and both can blink themselves for {1}{U}; played as blinking another creature you control for {1}{U}, its usual use (the paired creature\'s enters ability again).',
  },
  "Death's Oasis": {
    text: 'Whenever a nontoken creature you control dies, mill two cards. Then return a creature card with lesser mana value than the creature that died from your graveyard to your hand.\n{1}, Sacrifice ~: You gain 4 life.',
    why: 'The life gained is the greatest mana value among your creatures; played as 4.',
  },
  'Decoction Module': {
    text: 'Whenever a creature you control enters, you get {E}.',
    why: 'Returning your own creature to hand for {4} is left out.',
  },
  'Delney, Streetwise Lookout': {
    text: 'If a triggered ability of a creature you control with power 2 or less triggers, that ability triggers an additional time.',
    why: 'The evasion for small creatures is left out.',
  },
  "Demon of Fate's Design": {
    text: 'Flying, trample',
    add: [{ kind: 'costReduction', amount: 3, filter: 'enchantment', first: true, when: 'static' }],
    notes: ['The first enchantment spell each turn costs {3} less (≈ paid with life)'],
    why: 'Once each turn an enchantment may be cast for life equal to its mana value; played as {3} off the first enchantment spell each turn. Sacrificing enchantments to pump it is left out.',
  },
  'Depthshaker Titan': {
    text: 'When ~ enters, any number of target noncreature artifacts you control become 3/3 artifact creatures. Sacrifice them at the beginning of the next end step.\nArtifact creatures you control get +1/+0 and have trample and haste.',
    why: 'Melee is +1/+1 for each opponent attacked, usually one: played as +1/+0 on artifact creatures.',
  },
  'Desecrated Tomb': {
    text: '',
    why: 'A Bat when creature cards leave your graveyard: the engine has no trigger for that. Bots never cast it.',
  },
  'Despotic Scepter': {
    text: '',
    why: 'Destroying your own permanent is never worth it to bots.',
  },
  'Devourer of Memory': {
    text: '{1}{U}{B}: Mill a card.',
    add: [{ kind: 'pump', p: 1, t: 1, protect: false, grant: ['unblockable'], self: true, when: 'milled', scope: 'self' }],
    notes: ["When you mill: it gets +1/+1 and can't be blocked this turn"],
    why: '"Whenever one or more cards are put into your graveyard from your library" is read as whenever you mill.',
  },
  "Dion, Bahamut's Dominant": {
    text: "During your turn, ~ has flying.\nWhen ~ enters, create a 2/2 white Knight creature token.\n{4}{W}{W}, {T}: Exile ~, then return it to the battlefield transformed under its owner's control. Activate only as a sorcery.",
    why: 'Other Knights having flying during your turn is left out.',
  },
  'Disciple of the Vault': {
    text: 'Whenever an artifact is put into a graveyard from the battlefield, you may have target opponent lose 1 life.',
    why: 'Read as written; the trigger was added to the engine with this card. Treasures count.',
  },
  'Djeru and Hazoret': {
    text: 'Vigilance, haste\nWhenever ~ attacks, look at the top six cards of your library. You may exile a legendary creature card from among them. Put the rest on the bottom of your library in a random order. Until end of turn, you may cast the exiled card without paying its mana cost.',
    why: 'Vigilance and haste need one or fewer cards in hand, which is usual for a five-drop; played as always on.',
  },
  'Doomsday Confluence': {
    text: 'Create two 3/3 black Dalek artifact creature tokens with menace.\nEach opponent discards a card.',
    why: 'Choose X modes: bots take two Daleks and a discard (X = 3 on six mana). The edict mode is left out.',
  },
  'Doubling Cube': {
    text: '{3}, {T}: Add {C}{C}{C}{C}{C}{C}.',
    why: 'Doubling the unspent mana: with about six mana up, paying {3} leaves three, doubled to six.',
  },
  'Dour Port-Mage': {
    text: "{1}{U}, {T}: Return another target creature you control to its owner's hand. Draw a card.",
    why: 'The draw triggers when other creatures leave without dying; played as part of its own bounce ability, its usual source.',
  },
  'Dragon Tempest': {
    text: 'Creatures you control have haste.\nWhenever a Dragon you control enters, it deals X damage to any target, where X is the number of Dragons you control.',
    why: 'Only flyers get haste as they enter; played as all your creatures, which in its deck are mostly Dragons.',
  },
  'Dream Devourer': {
    text: '',
    why: 'Foretell for every card in hand is left out. Played as a 0/3.',
  },
  'Drivnod, Carnage Dominus': {
    text: 'If a creature dying causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.',
    why: 'Exiling three creature cards for an indestructible counter is left out.',
  },
  'Druid of Purification': {
    text: 'When ~ enters, destroy target artifact or enchantment an opponent controls.',
    why: 'Each player may choose an artifact or enchantment you don\'t control; played as one of an opponent\'s.',
  },
  'Earth-Cult Elemental': {
    text: 'When ~ enters, each opponent sacrifices a permanent.',
    why: 'A d20 roll; 10–19, the most likely result, is each opponent sacrificing a permanent.',
  },
  'Edric, Spymaster of Trest': {
    text: 'Whenever a creature you control deals combat damage to a player, draw a card.',
    why: 'Any creature hitting one of your opponents draws its controller a card; only yours are counted.',
  },
  'Eiganjo Uprising': {
    text: 'Create X 2/2 white Samurai creature tokens with vigilance. They gain menace and haste until end of turn.',
    why: 'Opponents getting X minus one Samurai each is left out.',
  },
  'Eldrazi Confluence': {
    text: 'Target creature gets -3/-3 until end of turn.\nCreate two 1/1 colorless Eldrazi Scion creature tokens with "Sacrifice this token: Add {C}."',
    why: 'Choose three: bots take +3/-3 on an opposing creature (read as -3/-3) and two Scions. The flicker mode is left out.',
  },
  'Elesh Norn, Grand Cenobite': {
    text: 'Vigilance\nOther creatures you control get +2/+2.\nCreatures your opponents control get -2/-2.',
    why: 'Read as written; opponents\' creatures getting -2/-2 for as long as it stays was added to the engine with this card.',
  },
  'Eluge, the Shoreless Sea': {
    text: "~'s power and toughness are each equal to the number of Islands you control.\nThe first instant or sorcery spell you cast each turn costs {1} less to cast.",
    why: 'Flood counters are left out; the discount is read as one flooded land.',
  },
  'Elvish Spirit Guide': {
    text: '',
    why: 'Exiling it from hand for {G} is left out. Played as a 2/2.',
  },
  'Emet-Selch of the Third Seat': {
    text: 'Spells you cast from your graveyard cost {2} less to cast.\nAt the beginning of your end step, return target instant or sorcery card from your graveyard to your hand.',
    why: 'Casting an instant or sorcery from the graveyard once each turn when an opponent loses life; played as returning one to hand each turn.',
  },
  'Enchanted Evening': {
    text: '',
    why: 'All permanents being enchantments does nothing here: other cards don\'t see the added type. Bots never cast it.',
  },
  'Encroaching Mycosynth': {
    text: '',
    why: 'Your nonland permanents being artifacts does nothing here: other cards don\'t see the added type. Bots never cast it.',
  },
  'Endless Evil': {
    text: "Enchant creature you control\nAt the beginning of your upkeep, create a token that's a copy of enchanted creature, except the token is 1/1.",
    why: 'Returning to hand when a Horror it enchants dies is left out.',
  },
  'Enduring Courage': {
    text: "Other creatures you control have haste.\nWhen ~ dies, if it was a creature, return it to the battlefield under its owner's control. It's an enchantment. (It's not a creature.)",
    why: 'Entering creatures get +2/+0 and haste this turn; the haste is kept, the +2/+0 left out.',
  },
  'Enduring Innocence': {
    text: "Lifelink\nWhenever one or more other creatures you control enter, draw a card. This ability triggers only once each turn.\nWhen ~ dies, if it was a creature, return it to the battlefield under its owner's control. It's an enchantment. (It's not a creature.)",
    why: 'Only creatures with power 2 or less count; in its deck nearly all do.',
  },
  'Enhanced Surveillance': {
    text: '',
    why: 'Two more cards when surveilling and shuffling the graveyard back are left out. Bots never cast it.',
  },
  'Epitaph Golem': {
    text: '',
    why: 'Putting a graveyard card on the bottom of the library is left out. Played as a 3/5.',
  },
  'Erestor of the Council': {
    text: '',
    why: 'Its trigger on voting is left out: votes are decided by the reader when the voting card is read. Played as a 2/4.',
  },
  'Eternal of Harsh Truths': {
    text: "Whenever ~ attacks and isn't blocked, draw a card.",
    why: 'Afflict 2 (rule 702.130) is left out.',
  },
  'Excalibur, Sword of Eden': {
    text: 'This spell costs {X} less to cast, where X is the total mana value of historic permanents you control.\nEquipped creature gets +10/+0 and has vigilance.\nEquip {2}',
    why: 'Equip only onto a legendary creature: bots equip their commander. The cost reduction was added to the engine with this card.',
  },
  Fatespinner: {
    text: '',
    why: 'Opponents skipping a step or phase they choose is left out. Played as a 1/2.',
  },
  'Fblthp, Lost on the Range': {
    text: 'Ward {2}\nYou may play lands and cast spells from the top of your library.',
    why: 'Plotting the top card (cast it for free on a later turn after paying its cost now) is played as casting spells from the top of the library.',
  },
  'Fealty to the Realm': {
    text: "Enchant creature\nWhen ~ enters, you become the monarch.\nYou control enchanted creature.\nEnchanted creature attacks each combat if able and can't attack you.",
    why: 'The monarch controls the creature; played as you controlling it, since you become the monarch as it enters. It changing hands with the crown is left out.',
  },
  'Fear of Isolation': {
    text: 'Flying',
    why: 'Returning a permanent you control to hand as an extra cost is left out.',
  },
  'Fear of Sleep Paralysis': {
    text: 'Flying\nEerie — Whenever this creature or another enchantment you control enters and whenever you fully unlock a Room, tap up to one target creature and put a stun counter on it.',
    why: 'Stun counters not coming off opponents\' permanents is left out.',
  },
  'Fiery Confluence': {
    text: '~ deals 6 damage to each opponent.',
    why: 'Choose three: bots take 2 damage to each opponent three times. The creature damage and artifact modes are left out.',
  },
  'Filigree Vector': {
    text: 'When ~ enters, put a +1/+1 counter on each creature you control.\n{2}, {T}: Proliferate.',
    why: 'The enters counters go on each creature (charge counters on artifacts left out). Sacrificing another artifact for proliferate is played as paying {1} more.',
  },
  'Fire Nation Cadets': {
    text: 'Firebending 2\n{2}: ~ gets +1/+0 until end of turn.',
    why: 'Firebending needs a Lesson card in your graveyard, usually there by midgame.',
  },
  'Flamecache Gecko': {
    text: '{1}{R}, Discard a card: Draw a card.',
    why: '{B}{R} as it enters (if an opponent lost life this turn) is left out.',
  },
  'Forge Anew': {
    text: 'When ~ enters, return target Equipment card from your graveyard to the battlefield.',
    why: 'Equipping at instant speed and the free first equip each turn are left out.',
  },
  'Frontier Warmonger': {
    text: 'Creatures you control have menace.',
    why: 'Creatures attacking your opponents gain menace; played as your creatures having it.',
  },
  'Frontline Medic': {
    text: 'Sacrifice ~: Counter target spell with {X} in its mana cost unless its controller pays {3}.',
    add: [{ kind: 'overrun', p: 0, t: 0, trample: false, grant: ['indestructible'], when: 'attack', scope: 'self' }],
    notes: ['On attack: your creatures gain indestructible this turn'],
    why: 'Battalion needs two other attackers; played as whenever it attacks.',
  },
};
