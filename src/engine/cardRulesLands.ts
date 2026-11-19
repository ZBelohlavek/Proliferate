// Card-specific rules for lands with a line the general reader doesn't read (see cardRules.ts for how entries work).
// Most utility lands are written here in wordings the reader knows; what a bot can't use (mana that only lasts
// through combat, copying another land, hexproof removal for one turn) is left out and said in `why`.

import type { CardRule } from './cardRules';

export const LAND_RULES: Record<string, CardRule> = {
  'Three Tree City': {
    text: 'As ~ enters, choose a creature type.\n{T}: Add {C}.',
    add: [{ kind: 'mana', amount: 0, colors: 'any', count: 'chosenType', net: 2, when: 'static' }],
    notes: ['Mana: one for each creature of the chosen type you control, less the {2} it costs (used when that beats {C})'],
    why: 'The "{2}, {T}" ability is kept as its net gain: a creature count of four makes two extra mana, of any color. The chosen type is the one most of the deck\'s creatures share.',
  },
  'Nykthos, Shrine to Nyx': {
    text: '{T}: Add {C}.',
    add: [{ kind: 'mana', amount: 0, colors: 'any', count: 'devotion', net: 2, when: 'static' }],
    notes: ['Mana: your devotion to your best color, less the {2} it costs (used when that beats {C})'],
    why: 'The "{2}, {T}" ability is kept as its net gain, in the color you have the most devotion to (rule 700.5).',
  },
  "Urza's Saga": {
    text: '(As this Saga enters and after your draw step, add a lore counter. Sacrifice after III.)\nI — ~ gains "{T}: Add {C}."\nII, III — Create a 2/2 colorless Construct artifact creature token.\nIII — Search your library for an artifact card with mana cost {0} or {1}, put it onto the battlefield, then shuffle.',
    why: 'Chapter II gives the Saga "{2}, {T}: create a Construct" for the turns it has left; read as one Construct on each of those two turns, 2/2 (it is really +1/+1 for each artifact you control).',
  },
  'Nesting Grounds': {
    text: '{T}: Add {C}.',
    why: 'Moving a counter from one permanent to another is left out: the engine has no use for moving a counter it already counts.',
  },
  'Fire Nation Palace': {
    text: 'This land enters tapped unless you control a basic land.\n{T}: Add {R}.',
    add: [{ kind: 'treasure', n: 4, ritual: true, when: 'activated', activation: { cost: { generic: 1, pips: [['R']], x: 0, life: 0 }, tap: true, sacrifice: false, sorcery: true } }],
    notes: ['Activated: four red mana for the turn (firebending 4)'],
    why: 'Firebending\'s mana lasts until end of combat; as for firebending creatures, it is kept as one-shot mana in the main phase.',
  },
  'Access Tunnel': {
    text: '{T}: Add {C}.\n{3}, {T}: Target creature can\'t be blocked this turn.',
    why: 'The power-3-or-less limit on the target is left out.',
  },
  'Talon Gates of Madara': {
    text: 'When ~ enters, tap target creature an opponent controls.\n{T}: Add {C}.\n{1}, {T}: Add one mana of any color.',
    why: 'Phasing out an opponent\'s creature is read as tapping it (it is gone until their next untap). Putting it onto the battlefield from hand for {4} is left out.',
  },
  'Archway of Innovation': {
    text: 'This land enters tapped unless you control an Island.\n{T}: Add {U}.',
    why: 'Giving the next spell improvise is left out: the engine pays costs with all of your mana sources already.',
  },
  'The Mycosynth Gardens': {
    text: '{T}: Add {C}.\n{1}, {T}: Add one mana of any color.',
    why: 'Becoming a copy of an artifact is left out.',
  },
  'Cephalid Coliseum': {
    text: '{T}: Add {U}. ~ deals 1 damage to you.\n{U}, {T}, Sacrifice ~: Draw three cards, then discard three cards.',
    why: 'Aimed at yourself, as it nearly always is. The threshold condition (seven cards in your graveyard) is left out.',
  },
  'War Room': {
    text: '{T}: Add {C}.\n{3}, {T}, Pay 2 life: Draw a card.',
    why: 'The life paid is the number of colors in your commander\'s color identity; read as 2.',
  },
  'Forbidden Orchard': {
    text: '{T}: Add one mana of any color.',
    why: 'The 1/1 Spirit an opponent gets each time it is tapped for mana is left out.',
  },
  'Monumental Henge': {
    text: 'This land enters tapped unless you control a Plains.\n{T}: Add {W}.\n{2}{W}{W}, {T}: Look at the top five cards of your library. Put one of them into your hand and the rest on the bottom of your library in a random order.',
    why: 'Only a historic card can be taken; read as any card.',
  },
  "Shizo, Death's Storehouse": {
    text: '{T}: Add {B}.\n{B}, {T}: Target creature can\'t be blocked this turn.',
    why: 'Fear (blocked only by artifact or black creatures) is read as unblockable, and the legendary-only target limit is left out.',
  },
  'The Black Gate': {
    text: '{T}: Add {B}.\n{1}{B}, {T}: Target creature can\'t be blocked this turn.',
    why: 'It can\'t be blocked by the player with the most life; read as unblockable. Paying 3 life to enter untapped is left out (it enters untapped).',
  },
  'Mistrise Village': {
    text: 'This land enters tapped unless you control a Mountain or a Forest.\n{T}: Add {U}.',
    why: 'Making the next spell uncounterable is left out.',
  },
  'The Seedcore': {
    text: '{T}: Add {C}.\n{T}: Add one mana of any color.\n{T}: Target creature gets +2/+1 until end of turn.',
    why: 'The any-color mana is only for Phyrexian creature spells, and the pump only for 1/1 creatures while an opponent has three poison counters; both limits are left out.',
  },
  'Riptide Laboratory': {
    text: '{T}: Add {C}.\n{1}{U}, {T}: Exile target creature you control, then return it to the battlefield under its owner\'s control.',
    why: 'Returning a Wizard to hand to cast it again is read as a blink: its enters abilities happen again without paying for it twice.',
  },
  'Power Depot': {
    text: 'This land enters tapped.\n{T}: Add {C}.\n{T}: Add one mana of any color.',
    why: 'The any-color mana is only for artifacts. Modular 1 only matters if the land becomes a creature, and is left out.',
  },
  'Dark Depths': {
    text: '{3}: Put a charge counter on ~. Then if it has ten or more charge counters on it, remove them all and create a 20/20 black Avatar creature token with flying and indestructible.',
    why: 'Removing ten ice counters is read as adding ten charge counters, so Marit Lage still takes ten activations of {3}. Combos with Thespian\'s Stage are left out.',
  },
  'Terrain Generator': {
    text: '{T}: Add {C}.\n{2}, {T}: You may put a land card from your hand onto the battlefield.',
    why: 'Only a basic land, and it enters tapped; read as an extra land drop.',
  },
  'Detection Tower': {
    text: '{T}: Add {C}.',
    why: 'Ignoring hexproof for a turn is left out: bots aim around hexproof.',
  },
  'Arcane Lighthouse': {
    text: '{T}: Add {C}.',
    why: 'Taking away hexproof and shroud for a turn is left out: bots aim around them.',
  },
  'Plaza of Heroes': {
    text: '{T}: Add {C}.\n{T}: Add one mana of any color.\n{3}, {T}, Sacrifice ~: Target creature you control gains hexproof and indestructible until end of turn.',
    why: 'The any-color mana is only for legendary spells or the colors of your legendaries; read as any color. Exiling it is read as sacrificing it, and the target as any of your creatures.',
  },
  'Rockface Village': {
    text: '{T}: Add {C}.\n{T}: Add {R}.\n{R}, {T}: Target creature you control gets +1/+0 and gains haste until end of turn. Activate only as a sorcery.',
    why: 'The {R} is only for creature spells, and the pump only for Lizards, Mice, Otters and Raccoons; both limits are left out.',
  },
  'Urban Retreat': {
    text: 'This land enters tapped.\n{T}: Add {G}, {W}, or {U}.',
    why: 'Putting it onto the battlefield from hand by returning a tapped creature is left out.',
  },
  'Westvale Abbey': {
    text: '{T}: Add {C}.\n{5}, {T}, Pay 1 life: Create a 1/1 white and black Human Cleric creature token.',
    why: 'Sacrificing five creatures to make the 9/7 Ormendahl is left out.',
  },
  'Endless Sands': {
    text: '{T}: Add {C}.\n{2}, {T}: Exile target creature you control, then return it to the battlefield under its owner\'s control.',
    why: 'Exiling creatures and bringing them all back later is read as a blink.',
  },
  "Maze's End": {
    text: 'This land enters tapped.\n{T}: Add {C}.\n{3}, {T}: Search your library for a basic land card, put it onto the battlefield tapped, then shuffle.',
    why: 'Fetching a Gate (and returning itself to hand) is read as fetching a basic land. Winning with ten Gates is left out.',
  },
  'Gond Gate': {
    text: '{T}: Add {C}.\n{T}: Add one mana of any color.',
    why: 'Making other Gates enter untapped is left out; the any-color mana is the colors your Gates make.',
  },
  'Heap Gate': {
    text: '{T}: Add {C}.\n{1}, {T}: Add one mana of any color.\n{1}, {T}: Create a Treasure token.',
    why: 'Tapping another Gate as part of the Treasure cost is left out.',
  },
  'Gateway Plaza': {
    text: 'This land enters tapped.\n{T}: Add one mana of any color.',
    why: 'The {1} paid as it enters is left out: bots always pay it.',
  },
  'Mines of Moria': {
    text: 'Mines of Moria enters tapped unless you control a legendary creature.\n{T}: Add {R}.\n{3}{R}, {T}: Create two Treasure tokens.',
    why: 'Exiling three cards from your graveyard as part of the cost is left out.',
  },
  'Inkmoth Nexus': {
    text: '{T}: Add {C}.\n{1}: Until end of turn, ~ becomes a 1/1 Phyrexian Blinkmoth artifact creature with flying and infect. It\'s still a land.',
    why: 'Same ability in the reader\'s wording.',
  },
  'Mutavault': {
    text: '{T}: Add {C}.\n{1}: Until end of turn, ~ becomes a 2/2 creature. It\'s still a land.',
    why: 'Same ability in the reader\'s wording; having every creature type is left out.',
  },
  'Faerie Conclave': {
    text: 'This land enters tapped.\n{T}: Add {U}.\n{1}{U}: Until end of turn, ~ becomes a 2/1 blue Faerie creature with flying. It\'s still a land.',
    why: 'Same ability in the reader\'s wording.',
  },
  'Urborg, Tomb of Yawgmoth': {
    text: '{T}: Add {B}.',
    why: 'Every land being a Swamp is read for Urborg only (it taps for {B}); other lands keep their types.',
  },
  'Command Beacon': {
    text: '{T}: Add {C}.',
    why: 'Putting your commander into your hand from the command zone (to dodge commander tax) is left out.',
  },
  'Dimir Aqueduct': {
    text: 'This land enters tapped.\n{T}: Add {U} or {B}.',
    why: 'Returning a land to hand as it enters and tapping for two mana is read as an ordinary tapped dual land: one land drop, about one land\'s worth of mana.',
  },
  'Swarmyard': {
    text: '{T}: Add {C}.\n{T}: Target creature you control gains indestructible until end of turn.',
    why: 'Regenerating an Insect, Rat, Spider or Squirrel is read as indestructible for a turn, for any of your creatures.',
  },
  'Minas Morgul, Dark Fortress': {
    text: 'This land enters tapped.\n{T}: Add {B}.\n{3}{B}, {T}: Target creature can\'t be blocked this turn.',
    why: 'A shadow counter (blocked only by creatures with shadow) is read as unblockable this turn.',
  },
  'Underdark Rift': {
    text: '{T}: Add {C}.\n{5}, {T}, Sacrifice ~: Exile target creature. Activate only as a sorcery.',
    why: 'Putting it into its owner\'s library under the top d10 cards is read as exiling it; it also hits artifacts and planeswalkers.',
  },
  'The Tabernacle at Pendrell Vale': {
    text: "Creatures can't attack you unless their controller pays {1} for each creature they control that's attacking you.",
    why: 'Every creature paying {1} each upkeep or being destroyed is read as an attack tax of {1} a creature.',
  },
  'Gemstone Caverns': {
    text: '{T}: Add {C}.',
    why: 'Starting the game on the battlefield is left out.',
  },
  'Mount Doom': {
    text: '{T}, Pay 1 life: Add {B} or {R}.\n{1}{B}{R}, {T}: ~ deals 1 damage to each opponent.\n{5}{B}{R}, {T}, Sacrifice ~: Destroy all creatures your opponents control. Activate only as a sorcery.',
    why: 'Choosing up to two creatures and destroying the rest is read as a one-sided wipe (you keep your two best). Sacrificing a legendary artifact as part of the cost is left out.',
  },
  "Thespian's Stage": {
    text: '{T}: Add {C}.',
    why: 'Becoming a copy of another land is left out.',
  },
  'Barad-dûr': {
    text: 'Barad-dûr enters tapped unless you control a legendary creature.\n{T}: Add {B}.\n{4}{B}, {T}: Amass Orcs 2.',
    why: 'X is read as 2, and the "only if a creature died this turn" condition is left out.',
  },
  'Kessig Wolf Run': {
    text: '{T}: Add {C}.\n{3}{R}{G}, {T}: Target creature gets +3/+0 and gains trample until end of turn.',
    why: 'X is read as 3.',
  },
  'Lotus Field': {
    text: 'Hexproof\nThis land enters tapped.\n{T}: Add three mana of any one color.',
    add: [{ kind: 'landSac', n: 2, who: 'you', when: 'resolve' }],
    notes: ['When it enters, you sacrifice two lands'],
    why: 'Same card; the sacrifice is its own effect.',
  },
  'The Shire': {
    text: 'The Shire enters tapped unless you control a legendary creature.\n{T}: Add {G}.\n{1}{G}, {T}: Create a Food token.',
    why: 'Tapping one of your creatures as part of the cost is left out.',
  },
};
