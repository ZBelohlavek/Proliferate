// A sample of widely played Commander cards, used to measure how much of a
// real deck the classifier understands and to exercise the rules engine.
//
// The oracle text was typed in by hand, so small wording differences from the
// printed cards are possible. Format: name | cost | mana value | types | subtypes | P/T | text.

import { classifyCard } from '../src/engine/classify';
import type { Color, SimCard, SimDeck } from '../src/engine/types';
import { card as rawCard } from './helpers';

const ROWS = String.raw`
Sol Ring|{1}|1|Artifact||-|{T}: Add {C}{C}.
Arcane Signet|{2}|2|Artifact||-|{T}: Add one mana of any color in your commander's color identity.
Swords to Plowshares|{W}|1|Instant||-|Exile target creature. Its controller gains life equal to its power.
Path to Exile|{W}|1|Instant||-|Exile target creature. Its controller may search their library for a basic land card, put that card onto the battlefield tapped, then shuffle.
Counterspell|{U}{U}|2|Instant||-|Counter target spell.
Swan Song|{U}|1|Instant||-|Counter target enchantment, instant, or sorcery spell. Its controller creates a 2/2 blue Bird creature token with flying.
Cultivate|{2}{G}|3|Sorcery||-|Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.
Kodama's Reach|{2}{G}|3|Sorcery|Arcane|-|Search your library for up to two basic land cards, reveal those cards, put one onto the battlefield tapped and the other into your hand, then shuffle.
Rampant Growth|{1}{G}|2|Sorcery||-|Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.
Farseek|{1}{G}|2|Sorcery||-|Search your library for a Plains, Island, Swamp, or Mountain card, put it onto the battlefield tapped, then shuffle.
Nature's Lore|{1}{G}|2|Sorcery||-|Search your library for a Forest card, put that card onto the battlefield, then shuffle.
Three Visits|{1}{G}|2|Sorcery||-|Search your library for a Forest card, put that card onto the battlefield, then shuffle.
Beast Within|{2}{G}|3|Instant||-|Destroy target permanent. Its controller creates a 3/3 green Beast creature token.
Generous Gift|{2}{W}|3|Instant||-|Destroy target permanent. Its controller creates a 3/3 green Elephant creature token.
Chaos Warp|{2}{R}|3|Instant||-|The owner of target permanent shuffles it into their library, then reveals the top card of their library. If it's a permanent card, they put it onto the battlefield.
Blasphemous Act|{8}{R}|9|Sorcery||-|This spell costs {1} less to cast for each creature on the battlefield.\nBlasphemous Act deals 13 damage to each creature.
Cyclonic Rift|{1}{U}|2|Instant||-|Return target nonland permanent you don't control to its owner's hand.\nOverload {6}{U} (You may cast this spell for its overload cost. If you do, change "target" in its text to "each.")
Rhystic Study|{2}{U}|3|Enchantment||-|Whenever an opponent casts a spell, you may draw a card unless that player pays {1}.
Mystic Remora|{U}|1|Enchantment||-|Cumulative upkeep {1}\nWhenever an opponent casts a noncreature spell, you may draw a card unless that player pays {4}.
Smothering Tithe|{3}{W}|4|Enchantment||-|Whenever an opponent draws a card, that player may pay {2}. If the player doesn't, you create a Treasure token.
Lightning Greaves|{2}|2|Artifact|Equipment|-|Equipped creature has haste and shroud.\nEquip {0}
Swiftfoot Boots|{2}|2|Artifact|Equipment|-|Equipped creature has hexproof and haste.\nEquip {1}
Skullclamp|{1}|1|Artifact|Equipment|-|Equipped creature gets +1/-1.\nWhenever equipped creature dies, draw two cards.\nEquip {1}
Fellwar Stone|{2}|2|Artifact||-|{T}: Add one mana of any color that a land an opponent controls could produce.
Mind Stone|{2}|2|Artifact||-|{T}: Add {C}.\n{1}, {T}, Sacrifice Mind Stone: Draw a card.
Thought Vessel|{2}|2|Artifact||-|You have no maximum hand size.\n{T}: Add {C}.
Commander's Sphere|{3}|3|Artifact||-|{T}: Add one mana of any color in your commander's color identity.\nSacrifice Commander's Sphere: Draw a card.
Talisman of Dominance|{2}|2|Artifact||-|{T}: Add {C}.\n{T}: Add {U} or {B}. Talisman of Dominance deals 1 damage to you.
Dimir Signet|{2}|2|Artifact||-|{1}, {T}: Add {U}{B}.
Chromatic Lantern|{3}|3|Artifact||-|Lands you control have "{T}: Add one mana of any color."\n{T}: Add one mana of any color.
Mana Crypt|{0}|0|Artifact||-|At the beginning of your upkeep, flip a coin. If you lose the flip, Mana Crypt deals 3 damage to you.\n{T}: Add {C}{C}.
Mana Vault|{1}|1|Artifact||-|Mana Vault doesn't untap during your untap step.\nAt the beginning of your upkeep, you may pay {4}. If you do, untap Mana Vault.\nAt the beginning of your draw step, if Mana Vault is tapped, it deals 1 damage to you.\n{T}: Add {C}{C}{C}.
Llanowar Elves|{G}|1|Creature|Elf Druid|1/1|{T}: Add {G}.
Birds of Paradise|{G}|1|Creature|Bird|0/1|Flying\n{T}: Add one mana of any color.
Bloom Tender|{1}{G}|2|Creature|Elf Druid|1/1|{T}: For each color among permanents you control, add one mana of that color.
Sakura-Tribe Elder|{1}{G}|2|Creature|Snake Shaman|1/1|Sacrifice Sakura-Tribe Elder: Search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.
Wood Elves|{2}{G}|3|Creature|Elf Scout|1/1|When Wood Elves enters, search your library for a Forest card, put that card onto the battlefield, then shuffle.
Solemn Simulacrum|{4}|4|Artifact Creature|Golem|2/2|When Solemn Simulacrum enters, you may search your library for a basic land card, put that card onto the battlefield tapped, then shuffle.\nWhen Solemn Simulacrum dies, you may draw a card.
Eternal Witness|{1}{G}{G}|3|Creature|Human Shaman|2/1|When Eternal Witness enters, you may return target card from your graveyard to your hand.
Reclamation Sage|{2}{G}|3|Creature|Elf Shaman|2/1|When Reclamation Sage enters, you may destroy target artifact or enchantment.
Beast Whisperer|{2}{G}{G}|4|Creature|Elf Druid|2/3|Whenever you cast a creature spell, draw a card.
Avenger of Zendikar|{5}{G}{G}|7|Creature|Elemental|5/5|When Avenger of Zendikar enters, create a 0/1 green Plant creature token for each land you control.\nLandfall — Whenever a land you control enters, you may put a +1/+1 counter on each Plant creature you control.
Craterhoof Behemoth|{5}{G}{G}{G}|8|Creature|Beast|5/5|Haste\nWhen Craterhoof Behemoth enters, creatures you control gain trample and get +X/+X until end of turn, where X is the number of creatures you control.
Mulldrifter|{4}{U}|5|Creature|Elemental|2/2|Flying\nWhen Mulldrifter enters, draw two cards.\nEvoke {2}{U}
Solitude|{3}{W}{W}|5|Creature|Elemental Incarnation|3/2|Flash\nLifelink\nWhen Solitude enters, exile up to one other target creature. That creature's controller gains life equal to its power.\nEvoke—Exile a white card from your hand.
Ravenous Chupacabra|{2}{B}{B}|4|Creature|Beast Horror|2/2|When Ravenous Chupacabra enters, destroy target creature an opponent controls.
Gray Merchant of Asphodel|{3}{B}{B}|5|Creature|Zombie|2/4|When Gray Merchant of Asphodel enters, each opponent loses X life, where X is your devotion to black. You gain life equal to the life lost this way.
Blood Artist|{1}{B}|2|Creature|Vampire|0/1|Whenever Blood Artist or another creature dies, target player loses 1 life and you gain 1 life.
Zulaport Cutthroat|{1}{B}|2|Creature|Human Rogue Ally|1/1|Whenever Zulaport Cutthroat or another creature you control dies, each opponent loses 1 life and you gain 1 life.
Viscera Seer|{B}|1|Creature|Vampire Wizard|1/1|Sacrifice a creature: Scry 1.
Dockside Extortionist|{1}{R}|2|Creature|Goblin Pirate|1/2|When Dockside Extortionist enters, create X Treasure tokens, where X is the number of artifacts and enchantments your opponents control.
Etali, Primal Storm|{4}{R}{R}|6|Legendary Creature|Elder Dinosaur|6/6|Whenever Etali, Primal Storm attacks, exile the top card of each player's library, then you may cast any number of spells from among those cards without paying their mana costs.
Sun Titan|{4}{W}{W}|6|Creature|Giant|6/6|Vigilance\nWhenever Sun Titan enters or attacks, you may return target permanent card with mana value 3 or less from your graveyard to the battlefield.
Grave Titan|{4}{B}{B}|6|Creature|Giant|6/6|Deathtouch\nWhenever Grave Titan enters or attacks, create two 2/2 black Zombie creature tokens.
Consecrated Sphinx|{4}{U}{U}|6|Creature|Sphinx|4/6|Flying\nWhenever an opponent draws a card, you may draw two cards.
Esper Sentinel|{W}|1|Artifact Creature|Human Soldier|1/1|Whenever an opponent casts their first noncreature spell each turn, draw a card unless that player pays {X}, where X is Esper Sentinel's power.
Guardian Project|{3}{G}|4|Enchantment||-|Whenever a nontoken creature you control enters, if it doesn't have the same name as another creature you control or a creature card in your graveyard, draw a card.
Phyrexian Arena|{1}{B}{B}|3|Enchantment||-|At the beginning of your upkeep, you draw a card and you lose 1 life.
Sylvan Library|{1}{G}|2|Enchantment||-|At the beginning of your draw step, you may draw two additional cards. If you do, choose two cards in your hand drawn this turn. For each of those cards, pay 4 life or put the card on top of your library.
Necropotence|{B}{B}{B}|3|Enchantment||-|Skip your draw step.\nWhenever you discard a card, exile that card from your graveyard.\nPay 1 life: Exile the top card of your library face down. Put that card into your hand at the beginning of your next end step.
Doubling Season|{4}{G}|5|Enchantment||-|If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.\nIf an effect would put one or more counters on a permanent you control, it puts twice that many of those counters on that permanent instead.
Parallel Lives|{3}{G}|4|Enchantment||-|If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.
Propaganda|{2}{U}|3|Enchantment||-|Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.
Ghostly Prison|{2}{W}|3|Enchantment||-|Creatures can't attack you unless their controller pays {2} for each creature they control that's attacking you.
Rest in Peace|{1}{W}|2|Enchantment||-|When Rest in Peace enters, exile all graveyards.\nIf a card or token would be put into a graveyard from anywhere, exile it instead.
Aura Shards|{1}{G}{W}|3|Enchantment||-|Whenever a creature you control enters, you may destroy target artifact or enchantment.
Impact Tremors|{1}{R}|2|Enchantment||-|Whenever a creature you control enters, Impact Tremors deals 1 damage to each opponent.
Purphoros, God of the Forge|{3}{R}|4|Legendary Enchantment Creature|God|6/5|Indestructible\nAs long as your devotion to red is less than five, Purphoros isn't a creature.\nWhenever another creature you control enters, Purphoros deals 2 damage to each opponent.\n{2}{R}: Creatures you control get +1/+0 until end of turn.
Beastmaster Ascension|{2}{G}|3|Enchantment||-|Whenever a creature you control attacks, you may put a quest counter on Beastmaster Ascension.\nAs long as Beastmaster Ascension has seven or more quest counters on it, creatures you control get +5/+5.
Cathars' Crusade|{3}{W}{W}|5|Enchantment||-|Whenever a creature you control enters, put a +1/+1 counter on each creature you control.
Anointed Procession|{3}{W}|4|Enchantment||-|If an effect would create one or more tokens under your control, it creates twice that many of those tokens instead.
Wrath of God|{2}{W}{W}|4|Sorcery||-|Destroy all creatures. They can't be regenerated.
Farewell|{4}{W}{W}|6|Sorcery||-|Choose one or more —\n• Exile all artifacts.\n• Exile all creatures.\n• Exile all enchantments.\n• Exile all graveyards.
Toxic Deluge|{2}{B}|3|Sorcery||-|As an additional cost to cast this spell, pay X life.\nAll creatures get -X/-X until end of turn.
Damnation|{2}{B}{B}|4|Sorcery||-|Destroy all creatures. They can't be regenerated.
Austere Command|{4}{W}{W}|6|Sorcery||-|Choose two —\n• Destroy all artifacts.\n• Destroy all enchantments.\n• Destroy all creatures with mana value 3 or less.\n• Destroy all creatures with mana value 4 or greater.
Vandalblast|{R}|1|Sorcery||-|Destroy target artifact you don't control.\nOverload {4}{R}
Krosan Grip|{2}{G}|3|Instant||-|Split second\nDestroy target artifact or enchantment.
Nature's Claim|{G}|1|Instant||-|Destroy target artifact or enchantment. Its controller gains 4 life.
Return to Dust|{2}{W}{W}|4|Instant||-|Exile target artifact or enchantment. If you cast this spell during your main phase, you may exile up to one other target artifact or enchantment.
Anguished Unmaking|{1}{W}{B}|3|Instant||-|Exile target nonland permanent. You lose 3 life.
Assassin's Trophy|{B}{G}|2|Instant||-|Destroy target permanent an opponent controls. Its controller may search their library for a basic land card, put it onto the battlefield, then shuffle.
Terminate|{B}{R}|2|Instant||-|Destroy target creature. It can't be regenerated.
Go for the Throat|{1}{B}|2|Instant||-|Destroy target nonartifact creature.
Feed the Swarm|{1}{B}|2|Sorcery||-|Destroy target creature or enchantment an opponent controls. You lose life equal to that permanent's mana value.
Pongify|{U}|1|Instant||-|Destroy target creature. It can't be regenerated. Its controller creates a 3/3 green Ape creature token.
Rapid Hybridization|{U}|1|Instant||-|Destroy target creature. It can't be regenerated. That creature's controller creates a 3/3 green Frog Lizard creature token.
Negate|{1}{U}|2|Instant||-|Counter target noncreature spell.
Mana Drain|{U}{U}|2|Instant||-|Counter target spell. At the beginning of your next main phase, add an amount of {C} equal to that spell's mana value.
Fierce Guardianship|{2}{U}|3|Instant||-|If you control a commander, you may cast this spell without paying its mana cost.\nCounter target noncreature spell.
Force of Will|{3}{U}{U}|5|Instant||-|You may pay 1 life and exile a blue card from your hand rather than pay this spell's mana cost.\nCounter target spell.
Arcane Denial|{1}{U}|2|Instant||-|Counter target spell. Its controller may draw up to two cards at the beginning of the next turn's upkeep.\nYou draw a card at the beginning of the next turn's upkeep.
An Offer You Can't Refuse|{U}|1|Instant||-|Counter target noncreature spell. Its controller creates two Treasure tokens.
Heroic Intervention|{1}{G}|2|Instant||-|Permanents you control gain hexproof and indestructible until end of turn.
Teferi's Protection|{2}{W}|3|Instant||-|Until your next turn, your life total can't change and you gain protection from everything. All permanents you control phase out.\nExile Teferi's Protection.
Flawless Maneuver|{2}{W}|3|Instant||-|If you control a commander, you may cast this spell without paying its mana cost.\nCreatures you control gain indestructible until end of turn.
Deflecting Swat|{2}{R}|3|Instant||-|If you control a commander, you may cast this spell without paying its mana cost.\nYou may choose new targets for target spell or ability.
Demonic Tutor|{1}{B}|2|Sorcery||-|Search your library for a card, put that card into your hand, then shuffle.
Vampiric Tutor|{B}|1|Instant||-|Search your library for a card, then shuffle and put that card on top. You lose 2 life.
Enlightened Tutor|{W}|1|Instant||-|Search your library for an artifact or enchantment card, reveal it, then shuffle and put that card on top.
Worldly Tutor|{G}|1|Instant||-|Search your library for a creature card, reveal it, then shuffle and put that card on top.
Green Sun's Zenith|{X}{G}|1|Sorcery||-|Search your library for a green creature card with mana value X or less, put it onto the battlefield, then shuffle. Shuffle Green Sun's Zenith into its owner's library.
Finale of Devastation|{X}{G}{G}|2|Sorcery||-|Search your library and/or graveyard for a creature card with mana value X or less and put it onto the battlefield. If you search your library this way, shuffle. If X is 10 or more, creatures you control get +X/+X and gain haste until end of turn.
Reanimate|{B}|1|Sorcery||-|Put target creature card from a graveyard onto the battlefield under your control. You lose life equal to its mana value.
Animate Dead|{1}{B}|2|Enchantment|Aura|-|Enchant creature card in a graveyard\nWhen Animate Dead enters, if it's on the battlefield, it loses "enchant creature card in a graveyard" and gains "enchant creature put onto the battlefield with Animate Dead." Return enchanted creature card to the battlefield under your control and attach Animate Dead to it. When Animate Dead leaves the battlefield, that creature's controller sacrifices it.\nEnchanted creature gets -1/-0.
Victimize|{2}{B}|3|Sorcery||-|Choose two target creature cards in your graveyard. Sacrifice a creature. If you do, return the chosen cards to the battlefield tapped.
Regrowth|{1}{G}|2|Sorcery||-|Return target card from your graveyard to your hand.
Harmonize|{2}{G}{G}|4|Sorcery||-|Draw three cards.
Night's Whisper|{1}{B}|2|Sorcery||-|You draw two cards and you lose 2 life.
Read the Bones|{2}{B}|3|Sorcery||-|Scry 2, then draw two cards. You lose 2 life.
Brainstorm|{U}|1|Instant||-|Draw three cards, then put two cards from your hand on top of your library in any order.
Ponder|{U}|1|Sorcery||-|Look at the top three cards of your library, then put them back in any order. You may shuffle.\nDraw a card.
Fact or Fiction|{3}{U}|4|Instant||-|Reveal the top five cards of your library. An opponent separates those cards into two piles. Put one pile into your hand and the other into your graveyard.
Windfall|{2}{U}|3|Sorcery||-|Each player discards their hand, then draws cards equal to the greatest number of cards a player discarded this way.
Wheel of Fortune|{2}{R}|3|Sorcery||-|Each player discards their hand, then draws seven cards.
Faithless Looting|{R}|1|Sorcery||-|Draw two cards, then discard two cards.\nFlashback {2}{R}
Jeska's Will|{2}{R}|3|Sorcery||-|Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Add {R} for each card in target opponent's hand.\n• Exile the top three cards of your library. You may play them this turn.
Dark Ritual|{B}|1|Instant||-|Add {B}{B}{B}.
Exsanguinate|{X}{B}{B}|2|Sorcery||-|Each opponent loses X life. You gain life equal to the life lost this way.
Torment of Hailfire|{X}{B}{B}|2|Sorcery||-|Repeat the following process X times. Each opponent loses 3 life unless that player sacrifices a nonland permanent of their choice or discards a card.
Triumph of the Hordes|{2}{G}{G}|4|Sorcery||-|Until end of turn, creatures you control get +1/+1 and gain trample and infect.
Overwhelming Stampede|{3}{G}{G}|5|Sorcery||-|Until end of turn, creatures you control gain trample and get +X/+X, where X is the greatest power among creatures you control.
Akroma's Will|{3}{W}|4|Instant||-|Choose one. If you control a commander as you cast this spell, you may choose both instead.\n• Creatures you control gain flying, vigilance, and double strike until end of turn.\n• Creatures you control gain lifelink, indestructible, and protection from each color until end of turn.
Thassa's Oracle|{U}{U}|2|Creature|Merfolk Wizard|1/3|When Thassa's Oracle enters, look at the top X cards of your library, where X is your devotion to blue. Put up to one of them on top of your library and the rest on the bottom of your library in a random order. If X is greater than or equal to the number of cards in your library, you win the game.
Sensei's Divining Top|{1}|1|Artifact||-|{1}: Look at the top three cards of your library, then put them back in any order.\n{T}: Draw a card, then put Sensei's Divining Top on top of its owner's library.
Sword of Feast and Famine|{3}|3|Artifact|Equipment|-|Equipped creature gets +2/+2 and has protection from black and from green.\nWhenever equipped creature deals combat damage to a player, that player discards a card and you untap all lands you control.\nEquip {2}
Ashnod's Altar|{3}|3|Artifact||-|Sacrifice a creature: Add {C}{C}.
Isochron Scepter|{2}|2|Artifact||-|Imprint — When Isochron Scepter enters, you may exile an instant card with mana value 2 or less from your hand.\n{2}, {T}: You may copy the exiled card. If you do, you may cast the copy without paying its mana cost.
Panharmonicon|{4}|4|Artifact||-|If an artifact or creature entering causes a triggered ability of a permanent you control to trigger, that ability triggers an additional time.
The Great Henge|{7}{G}{G}|9|Legendary Artifact||-|This spell costs {X} less to cast, where X is the greatest power among creatures you control.\n{T}: Add {G}{G}. You gain 2 life.\nWhenever a nontoken creature you control enters, put a +1/+1 counter on it and draw a card.
Lightning Bolt|{R}|1|Instant||-|Lightning Bolt deals 3 damage to any target.
Rakdos Charm|{B}{R}|2|Instant||-|Choose one —\n• Exile target player's graveyard.\n• Destroy target artifact.\n• Each creature deals 1 damage to its controller.
Tormod's Crypt|{0}|0|Artifact||-|{T}, Sacrifice Tormod's Crypt: Exile target player's graveyard.
Grafdigger's Cage|{1}|1|Artifact||-|Creature cards in graveyards and libraries can't enter the battlefield.\nPlayers can't cast spells from graveyards or libraries.
Drannith Magistrate|{1}{W}|2|Creature|Human Wizard|1/3|Your opponents can't cast spells from anywhere other than their hands.
Rule of Law|{2}{W}|3|Enchantment||-|Each player can't cast more than one spell each turn.
Winter Orb|{2}|2|Artifact||-|As long as Winter Orb is untapped, players can't untap more than one land during their untap steps.
Clever Impersonator|{2}{U}{U}|4|Creature|Shapeshifter|0/0|You may have Clever Impersonator enter as a copy of any nonland permanent on the battlefield.
Clone|{3}{U}|4|Creature|Shapeshifter|0/0|You may have Clone enter as a copy of any creature on the battlefield.
Control Magic|{2}{U}{U}|4|Enchantment|Aura|-|Enchant creature\nYou control enchanted creature.
Bribery|{3}{U}{U}|5|Sorcery||-|Search target opponent's library for a creature card and put that card onto the battlefield under your control. Then that player shuffles.
Time Warp|{3}{U}{U}|5|Sorcery||-|Target player takes an extra turn after this one.
Approach of the Second Sun|{6}{W}|7|Sorcery||-|If this spell was cast from your hand and you've cast another spell named Approach of the Second Sun this game, you win the game. Otherwise, put Approach of the Second Sun into its owner's library seventh from the top and you gain 7 life.
Elesh Norn, Grand Cenobite|{5}{W}{W}|7|Legendary Creature|Phyrexian Praetor|4/7|Vigilance\nOther creatures you control get +2/+2.\nCreatures your opponents control get -2/-2.
Atraxa, Praetors' Voice|{G}{W}{U}{B}|4|Legendary Creature|Phyrexian Angel Horror|4/4|Flying, vigilance, deathtouch, lifelink\nAt the beginning of your end step, proliferate.
Edgar Markov|{3}{R}{W}{B}|6|Legendary Creature|Vampire Knight|4/4|Eminence — Whenever you cast another Vampire spell, if Edgar Markov is in the command zone or on the battlefield, create a 1/1 black Vampire creature token.\nFirst strike, haste\nWhenever Edgar Markov attacks, put a +1/+1 counter on each Vampire you control.
The Ur-Dragon|{4}{W}{U}{B}{R}{G}|9|Legendary Creature|Dragon Avatar|10/10|Eminence — As long as The Ur-Dragon is in the command zone or on the battlefield, other Dragon spells you cast cost {1} less to cast.\nFlying\nWhenever one or more Dragons you control attack, draw that many cards, then you may put a permanent card from your hand onto the battlefield.
Krenko, Mob Boss|{2}{R}{R}|4|Legendary Creature|Goblin Warrior|3/3|{T}: Create X 1/1 red Goblin creature tokens, where X is the number of Goblins you control.
Meren of Clan Nel Toth|{2}{B}{G}|4|Legendary Creature|Human Shaman|3/4|Whenever another creature you control dies, you get an experience counter.\nAt the beginning of your end step, choose target creature card in your graveyard. If that card's mana value is less than or equal to the number of experience counters you have, return it to the battlefield. Otherwise, put it into your hand.
Kaalia of the Vast|{1}{R}{W}{B}|4|Legendary Creature|Human Cleric|2/2|Flying\nWhenever Kaalia of the Vast attacks an opponent, you may put an Angel, Demon, or Dragon creature card from your hand onto the battlefield tapped and attacking that opponent.
Yuriko, the Tiger's Shadow|{1}{U}{B}|3|Legendary Creature|Human Ninja|1/3|Commander ninjutsu {U}{B}\nWhenever a Ninja you control deals combat damage to a player, reveal the top card of your library and put that card into your hand. Each opponent loses life equal to that card's mana value.
Korvold, Fae-Cursed King|{2}{B}{R}{G}|5|Legendary Creature|Dragon Noble|4/4|Flying\nWhenever Korvold enters or attacks, sacrifice another permanent.\nWhenever you sacrifice a permanent, put a +1/+1 counter on Korvold and draw a card.
Miirym, Sentinel Wyrm|{3}{G}{U}{R}|6|Legendary Creature|Dragon Spirit|6/6|Flying, ward {2}\nWhenever another nontoken Dragon you control enters, create a token that's a copy of it, except the token isn't legendary.
Tatyova, Benthic Druid|{3}{G}{U}|5|Legendary Creature|Merfolk Druid|3/3|Landfall — Whenever a land you control enters, you gain 1 life and draw a card.
Talrand, Sky Summoner|{2}{U}{U}|4|Legendary Creature|Merfolk Wizard|2/2|Whenever you cast an instant or sorcery spell, create a 2/2 blue Drake creature token with flying.
Lathril, Blade of the Elves|{2}{B}{G}|4|Legendary Creature|Elf Noble|2/3|Menace\nWhenever Lathril deals combat damage to a player, create that many 1/1 green Elf Warrior creature tokens.\n{T}, Tap ten untapped Elves you control: Each opponent loses 10 life and you gain 10 life.
Teferi, Hero of Dominaria|{3}{W}{U}|5|Legendary Planeswalker|Teferi|-|+1: Draw a card. At the beginning of the next end step, untap up to two lands.\n−3: Put target nonland permanent into its owner's library third from the top.\n−8: You get an emblem with "Whenever you draw a card, exile target permanent an opponent controls."
Elspeth, Sun's Champion|{4}{W}{W}|6|Legendary Planeswalker|Elspeth|-|+1: Create three 1/1 white Soldier creature tokens.\n−3: Destroy all creatures with power 4 or greater.\n−7: You get an emblem with "Creatures you control get +2/+2 and have flying."
The One Ring|{4}|4|Legendary Artifact||-|Indestructible\nWhen The One Ring enters, if you cast it, you gain protection from everything until your next turn.\nAt the beginning of your upkeep, you lose 1 life for each burden counter on The One Ring.\n{T}: Put a burden counter on The One Ring, then draw a card for each burden counter on The One Ring.
Bolas's Citadel|{3}{B}{B}{B}|6|Legendary Artifact||-|You may look at the top card of your library any time.\nYou may play lands and cast spells from the top of your library. If you cast a spell this way, pay life equal to its mana value rather than pay its mana cost.\n{T}, Sacrifice ten nonland permanents: Each opponent loses 10 life.
Exploration|{G}|1|Enchantment||-|You may play an additional land on each of your turns.
Oracle of Mul Daya|{3}{G}|4|Creature|Elf Shaman|2/2|You may play an additional land on each of your turns.\nPlay with the top card of your library revealed.\nYou may play lands from the top of your library.
Goblin Bombardment|{1}{R}|2|Enchantment||-|Sacrifice a creature: Goblin Bombardment deals 1 damage to any target.
Jet Medallion|{2}|2|Artifact||-|Black spells you cast cost {1} less to cast.
Urza's Incubator|{3}|3|Artifact||-|As Urza's Incubator enters, choose a creature type.\nCreature spells of the chosen type cost {2} less to cast.
Coat of Arms|{5}|5|Artifact||-|Each creature gets +1/+1 for each other creature on the battlefield that shares at least one creature type with it.
Kindred Discovery|{3}{U}{U}|5|Enchantment||-|As Kindred Discovery enters, choose a creature type.\nWhenever a creature you control of the chosen type enters or attacks, draw a card.
`;

export function staples(): SimCard[] {
  return ROWS.trim().split('\n').map((row) => {
    const [name, cost, cmc, types, subs, pt, rawText] = row.split('|');
    const all = types.split(' ');
    const text = rawText.replace(/\\n/g, '\n');
    const [power, toughness] = pt === '-' ? [null, null] : pt.split('/');
    // A first line made only of keywords ("Flying, vigilance") is what Scryfall reports as keywords.
    const first = text.split('\n')[0];
    const keywords = /^[A-Za-z ,{}0-9]+$/.test(first) && first.split(' ').length <= 6 ? first.split(',').map((k) => k.trim()) : [];
    return classifyCard({
      name, manaCost: cost, cmc: Number(cmc), types: all.filter((t) => t !== 'Legendary'), superTypes: all.filter((t) => t === 'Legendary'),
      subTypes: subs ? subs.split(' ') : [], text, power, toughness, keywords, colorIdentity: [],
    });
  });
}

/** Four five-color decks that between them hold every staple, for stress-testing the engine. */
export function stapleDecks(): SimDeck[] {
  const cards = staples();
  const colors: Color[] = ['W', 'U', 'B', 'R', 'G'];
  const lands = ['Plains', 'Island', 'Swamp', 'Mountain', 'Forest'];
  return [0, 1, 2, 3].map((seat) => {
    const mine = cards.filter((_, i) => i % 4 === seat);
    const commander = mine.find((c) => c.isLegendary && c.isCreature)!;
    return {
      id: `staples-${seat}`,
      name: `Staples ${seat + 1}`,
      commanders: [commander],
      cards: [
        ...mine.filter((c) => c !== commander).map((card) => ({ card, count: 1 })),
        ...lands.map((name, i) => ({ card: rawCard({ name, types: ['Land'], superTypes: ['Basic'], subTypes: [name], colorIdentity: [colors[i]] }), count: 8 })),
      ],
      source: 'text',
      colorIdentity: colors,
      importedAt: 0,
    } as SimDeck;
  });
}
