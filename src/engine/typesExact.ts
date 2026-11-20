import type { ManaCost } from './types';

// Effects for the last approximated cards in Zach's decks (cardRulesExact.ts): the engine pieces that let
// them play as printed instead of "≈". Kept apart from types.ts like typesExile.ts; EffectBody includes ExactEffect.

/**
 * A number an effect works out as it resolves (or, for statics, whenever it is looked at), instead of a fixed one:
 * - greatestPower / greatestToughness: among creatures you control.
 * - subjectToughness: the toughness of the creature the trigger is about (Angelic Chorus).
 * - srcPower: the source's power (Gleeful Arsonist).
 * - graveyardSpells: noncreature, nonland cards in your graveyard (Summon: Esper Ramuh).
 * - sacrificed: the power of the creature sacrificed to activate it (Wick); sacrificedMv: the mana value of the permanent sacrificed (Demon of Fate's Design).
 * - otherSpellMv: total mana value of the other spells you cast this turn (Call Forth the Tempest).
 * - bobbleheads: Bobbleheads you control. outlaws: Assassins, Mercenaries, Pirates, Rogues and Warlocks you control (and Laughing Jasper Flint's Mercenaries).
 * - playersAttacked: players being attacked this combat (Commander Liara Portyr).
 * - energy: your energy counters (Razorfield Ripper). colorsSpent: colors of mana spent on the spell (converge, Bring to Light).
 * - artifacts / enchantments: artifacts or enchantments you control (Cranial Ram, Sphere of Safety).
 * - x: the X paid.
 */
export type AmountFrom =
  | 'greatestPower' | 'greatestToughness' | 'subjectToughness' | 'srcPower' | 'graveyardSpells' | 'sacrificed' | 'sacrificedMv'
  | 'otherSpellMv' | 'bobbleheads' | 'outlaws' | 'playersAttacked' | 'energy' | 'colorsSpent' | 'artifacts' | 'enchantments' | 'x'
  /** Noncreature spells the player the trigger is about cast this turn (Magebane Lizard). */
  | 'noncreatureSpells';

export type ExactEffect =
  /** Reveal the top n cards; an opponent splits them into two piles (Fact or Fiction), or into a face-down and a face-up pile (Sauron's Ransom). One pile to hand, the other to the graveyard. */
  | { kind: 'piles'; n: number; faceDown?: boolean }
  /** Look at the top n: exile a nonland card among them plotted (rule 702.170), the rest into your hand (Make Your Own Luck). */
  | { kind: 'plotDig'; n: number }
  /** Each opponent exiles cards from the top of their library until the total mana value exiled is `total` or more (Tasha's Hideous Laughter). */
  | { kind: 'exileUntilMv'; total: number }
  /** Starting with the next opponent, each player chooses a creature you don't control; destroy them (Sadistic Shell Game). */
  | { kind: 'shellGame' }
  /** Each player exiles their graveyard's creature cards, sacrifices their creatures, then puts the exiled cards onto the battlefield (Living Death). */
  | { kind: 'livingDeath' }
  /** Each player chooses a creature type; each player returns every creature card of a chosen type from their graveyard to the battlefield (Patriarch's Bidding). */
  | { kind: 'patriarch' }
  /** Each opponent chooses a creature card in their graveyard; you put them onto the battlefield (Dredge the Mire). */
  | { kind: 'dredgeMire' }
  /** Each player chooses a color; exile each permanent unless it's colorless or only its controller's chosen color (Selective Obliteration). */
  | { kind: 'selectiveOblit' }
  /** Each opponent may discard a card; if they don't, they lose `life`. Repeated `times` times in all (Professor Onyx). */
  | { kind: 'discardOrLose'; times: number; life: number }
  /** Two descent counters, then each player makes X Treasures and takes X damage, X = the counters (Descent into Avernus). */
  | { kind: 'descent' }
  /** For each opponent, exile up to one of their non-Saga nonland permanents until the source leaves the battlefield (Battle at the Helvault). */
  | { kind: 'exileEachUntil' }
  /** Exile a creature with the greatest power among those target opponent controls (Fall of the Impostor): not targeted, so hexproof doesn't stop it. */
  | { kind: 'exileBiggest' }
  /** Put one more counter of a kind already on target permanent (Ichormoon Gauntlet), or remove one (Clockspinning, `remove`). */
  | { kind: 'oneCounter'; remove?: boolean; /** Remove one or add one, whichever is better (Clockspinning). */ either?: boolean }
  /** Target opponent skips their next combat phase (Stonehorn Dignitary). */
  | { kind: 'skipCombat' }
  /** Up to X target creatures phase out until their controller's next untap step (rule 702.26). */
  | { kind: 'phaseOut' }
  /** Ripple n (rule 702.60): reveal the top n; cast any with the same name as the spell free, the rest go on the bottom (Thrumming Stone). */
  | { kind: 'ripple'; n: number }
  /** River Song's Diary: with four or more cards exiled with it, cast one at random free. */
  | { kind: 'diaryCast' }
  /** Static: instants and sorceries cast from a hand are exiled with this as they resolve (River Song's Diary's imprint). */
  | { kind: 'diaryImprint' }
  /** The next spell you cast this turn: exile until an instant or sorcery with lesser mana value; you may cast it free this turn (Codie). */
  | { kind: 'codieNext' }
  /** At each player's end step: damage to them for each creature they control that didn't attack this turn (Kratos). */
  | { kind: 'idleDamage' }
  /** A creature you controlled but didn't own died: its owner loses n, you gain n (Thieving Amalgam). */
  | { kind: 'ownerDrain'; n: number }
  /** Each opponent sacrifices a creature that dealt combat damage to you this turn (Witch-king of Angmar). */
  | { kind: 'sacHitters' }
  /** For the rest of the turn, whenever you cast a noncreature spell, a token copy of a non-Saga token you control (Summon: Good King Mog XII). */
  | { kind: 'castCopiesToken' }
  /** Tap all creatures target player controls; pay any amount of energy to stun that many of them (Suppression Ray). */
  | { kind: 'tapAllOf'; stunEnergy?: boolean; /** Every opponent's creatures instead of target player's (Monstrosity of the Lake). */ who?: 'opponents'; /** A stun counter on each one tapped. */ stunAll?: boolean }
  /** Each player (or each opponent) sacrifices n permanents of their choice; `roll`: Earth-Cult Elemental's d20 decides who and how many. */
  | { kind: 'sacPermanents'; who: 'each' | 'opponents'; n: number; roll?: boolean }
  /** d20 for Wand of Wonder: each opponent reveals until an instant or sorcery; cast up to 1 (1-9), 2 (10-19) or 3 (20) of them free. */
  | { kind: 'wandOfWonder' }
  /** Static: once each turn, a spell may be cast this way instead of paying its mana cost: free creature spells from exile (Tlincalli Hunter), free colorless spells from hand (Darksteel Monolith), or enchantments for life equal to their mana value during your turn (Demon of Fate's Design). */
  | { kind: 'altOnce'; what: 'creatureFromExile' | 'colorlessFromHand' | 'enchantmentForLife' }
  /** Static: opponents' spells that target this permanent cost `amount` less (Accursed Witch); on a Curse, your spells that target the enchanted player (Infectious Curse). */
  | { kind: 'aimedDiscount'; amount: number }
  /** Static soulbond (rule 702.95): paired with another creature; each of the pair draws a card when it deals damage to an opponent (Tandem Lookout). */
  | { kind: 'soulbond' }
  /** Static: one more +1/+1 counter on an Army, Goblin or Orc you control (Mauhúr). */
  | { kind: 'extraCounter'; types: string[] }
  /** Static: creature cards in your hand have ninjutsu with this cost (Satoru Umezawa). */
  | { kind: 'grantNinjutsu'; cost: ManaCost }
  /** Evolve (rule 702.100): a +1/+1 counter when a creature with greater power or toughness enters under your control. */
  | { kind: 'evolve' }
  /** Static: spells you cast cost {1} less for each of the two colors chosen as this entered (Seal of the Guildpact). */
  | { kind: 'colorDiscount' }
  /** Return target creature card from a graveyard under your control; at instant speed it is sacrificed at the next cleanup (Necromancy). */
  | { kind: 'necromancy' }
  /** Static: spells cast from exile this turn cost X less, X = players attacked; set as you attack (Commander Liara Portyr). */
  | { kind: 'exileDiscount'; amount: number }
  /** Return target nonland permanent you control (or any, with cleave) to its owner's hand: in answer to removal (Alchemist's Retrieval). */
  | { kind: 'saveBounce' }
  /** You can't lose and opponents can't win this turn; damage that would take you below 1 life leaves you at 1 (Angel's Grace). */
  | { kind: 'graceTurn' }
  /** Counter target spell unless its controller pays {1} for each energy you pay; you pay all your energy (Aether Spike). */
  | { kind: 'energyCounter' }
  /** Counter target activated or triggered ability; its artifact, creature or planeswalker source loses its abilities while the source of this stays (Tishana's Tidebinder). */
  | { kind: 'counterAbility' }
  /** Look at the top n; put one (only a permanent card, if `only`) into your hand and the rest on the bottom or into the graveyard (Satoru Umezawa, Trail of Crumbs). */
  /** Each player discards a card, then you draw a card for each card type among them (Kefka, Court Mage). */
  | { kind: 'discardTypesDraw' }
  /** Static on a card in hand: this spell costs `amount` less (with amountFrom: counted as it is cast; The Great Henge). */
  | { kind: 'selfDiscount'; amount: number }
  | { kind: 'lookPick'; n: number; only?: 'permanent'; rest?: 'bottom' | 'graveyard' };
