// Shared data model for decks, cards, and game results.
//
// A "SimCard" is our simplified understanding of a Magic card: its cost,
// its body (if it is a creature), and a list of Effects we recognised in its
// oracle text. Anything we couldn't recognise is simply ignored by the game
// engine, and `modeled` records whether we understood the card at all.

import type { ExileEffect } from './typesExile';

export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];
/** A single unit of mana: a color, or 'C' for colorless. */
export type Mana = Color | 'C';

export interface ManaCost {
  /** Generic mana, e.g. the 3 in {3}{G}. */
  generic: number;
  /** Each pip lists the mana types that can pay it ({G/U} -> ['G','U']). */
  pips: Mana[][];
  /** Number of {X} symbols. */
  x: number;
  /** Phyrexian pips we pay with 2 life each. */
  life: number;
}

/** When an effect happens. */
export type Trigger =
  | 'resolve' // instant/sorcery resolves, or permanent enters the battlefield
  | 'upkeep' // once at the start of each of your turns
  | 'attack' // a creature attacks
  | 'combatDamage' // a creature deals combat damage to a player
  | 'cast' // you cast a spell (see castFilter)
  | 'creatureEnters' // a creature enters under your control
  | 'creatureDies' // a creature you control dies
  | 'landfall' // a land enters under your control
  | 'opponentCast' // an opponent casts a spell (see castFilter)
  | 'opponentDraw' // an opponent draws a card
  | 'opponentDiscard' // an opponent discards a card (once for each card)
  | 'opponentLoseLife' // an opponent loses life (x = how much)
  | 'sacrifice' // you sacrifice a permanent
  | 'draw' // you draw a card
  | 'permEnters' // an artifact or enchantment enters under your control (see castFilter)
  | 'gainLife' // you gain life
  | 'milled' // a player mills one or more cards (scope 'self': you, 'any': an opponent, 'all': anyone; castFilter 'creature': only creature cards)
  | 'activated' // activated ability, paid for with spare mana
  | 'loyalty' // planeswalker loyalty ability (see Effect.loyalty)
  | 'chapter' // Saga chapter ability (see Effect.chapters)
  | 'surveil' // you surveil
  | 'countered' // a spell or ability you control counters a spell
  | 'dieRoll' // you roll a die (see Effect.minRoll)
  | 'opponentMonarch' // an opponent becomes the monarch
  | 'ringTempts' // the Ring tempts you (rule 701.54)
  | 'energy' // you get one or more energy counters (x: how many)
  | 'mutates' // a mutating creature spell merges with this creature (scope 'self') or one you control ('any')
  | 'turnedFaceUp' // this face-down permanent is turned face up
  | 'lore' // you put a lore counter on a Saga you control (Sigurd)
  | 'targeted' // a permanent becomes the target of a spell or ability (see scope, targetedBy, spellOnly)
  | 'eachUpkeep' // the beginning of every player's upkeep, not only yours (Midnight Clock)
  | 'hourTwelve' // the twelfth hour counter is put on this permanent (Midnight Clock)
  | 'opponentSearch' // an opponent searches their library (Wan Shi Tong)
  | 'countersPut' // one or more +1/+1 counters are put on this permanent (scope 'self') or a creature you control ('any'); x = how many
  | 'crewed' // this Vehicle becomes crewed (Mobilizer Mech)
  | 'unlock' // this door of a Room is unlocked, by casting it or paying its unlock cost (rule 709.5h)
  | 'fullyUnlock' // you fully unlock a Room (rule 709.5i)
  | 'sacrificeFood' // you sacrifice a Food
  | 'postcombatMain' // the beginning of each of your postcombat main phases
  | 'leaves' // this permanent ('self') or a token you control ('any', with nontoken false) leaves the battlefield (see Effect.zones); x = its power
  | 'opponentActivate' // an opponent activates an ability of a permanent that isn't a mana ability
  | 'playerAttacks' // a player attacks: 'all' any player, 'opponents' an opponent attacks one of your other opponents (see minAttackers)
  | 'playerSacrifice' // a player ('all') or an opponent ('opponents') sacrifices a permanent (castFilter 'noncreature': only a Treasure or other noncreature token)
  | 'opponentCrime' // an opponent commits a crime: targets a player other than themselves, or a permanent or spell another player controls (rule 700.13)
  | 'opponentSacrifice' // an opponent sacrifices a nontoken permanent, the trigger is about that card (scope 'all': or discards a permanent card, Tergrid)
  | 'blocked' // this creature (scope 'self') or a creature you control ('any') becomes blocked (rule 509.1h)
  | 'unblocked' // this creature attacks and isn't blocked (rule 509.1h)
  | 'opponentCreatureEnters' // a creature enters under an opponent's control (Authority of the Consuls)
  | 'permDies' // an artifact or enchantment (castFilter) is put into a graveyard from the battlefield: yours (scope 'any') or anyone's ('all')
  | 'proliferate' // you proliferate (rule 701.34)
  | 'discard' // you discard a card (once for each card)
  | 'leaveGraveyard' // one or more cards leave your graveyard at once (castFilter 'creature': only creature cards; Desecrated Tomb)
  | 'permLeaves' // a permanent you control leaves the battlefield (castFilter 'creature': only creatures); x = the +1/+1 counters it had (The Ozolith, Resourceful Defense)
  | 'beginCombat' // the beginning of combat on your turn (The Ozolith)
  | 'minusCounters' // you put one or more -1/-1 counters on a creature; x = how many (Nest of Scarabs)
  | 'static'; // always on while the permanent is on the battlefield

/** Which creature a creature-based trigger watches. */
/** 'attached': the creature this Equipment or Aura is on. 'all': creatures of every player. 'opponents': only opponents' creatures. */
export type TriggerScope = 'self' | 'any' | 'oneOrMore' | 'attached' | 'all' | 'opponents';

export type CastFilter = 'any' | 'noncreature' | 'instantSorcery' | 'creature' | 'artifact' | 'enchantment' | 'mutate' | 'creatureOrPlaneswalker' | 'colorless' | /** "An artifact, instant, or sorcery spell" (Jin-Gitaxias). */ 'artifactInstantSorcery' | 'flash';

export type RemovalTarget = 'creature' | 'permanent' | 'noncreature' | 'artifactEnchantment' | 'planeswalker' | 'land' | 'nonbasicLand';
export type RemovalMode = 'destroy' | 'exile' | 'bounce' | 'damage' | 'edict' | 'fight';

/** -1 anywhere a number is expected means "X" (the X paid for the spell). */
export type Effect = EffectBody & {
  when: Trigger;
  scope?: TriggerScope;
  castFilter?: CastFilter;
  /** Cast triggers: only for spells with at least this mana value. */
  minCmc?: number;
  /** Conditional ("if ...") triggers: probability the condition holds. */
  chance?: number;
  /** Loyalty abilities: the loyalty added (+1) or removed (-3) to activate it. */
  loyalty?: number;
  /** "-X:" loyalty abilities (rule 606.4): X loyalty is removed, chosen as it is activated. */
  loyaltyX?: boolean;
  /** "Three times X": the X the effect sees is this many times the X paid. */
  xTimes?: number;
  /** Saga chapter abilities: the chapters (lore counts) this ability triggers on. */
  chapters?: number[];
  /** Creature-enters triggers that only watch nontoken creatures. */
  nontoken?: boolean;
  /** Enters and dies triggers: only creatures of this subtype ("whenever another Dragon you control enters"), or of the source's chosen type ('chosen'). */
  ofType?: string;
  /** "Do this only once each turn." */
  oncePerTurn?: boolean;
  /** Die-roll triggers: the lowest result that counts ("whenever you roll a 4 or higher"). */
  minRoll?: number;
  /** Cast triggers: only on the caster's first, second, ... spell of the turn ("their second spell each turn"). */
  nth?: number;
  /** Cast triggers: only during the caster's own turn, or only during someone else's ("during each opponent's turn"). */
  turn?: 'own' | 'others';
  /** Dies triggers: "this creature or another creature" also triggers on its own death. */
  selfToo?: boolean;
  /** "You may pay {E}{E}{E}. When you do, ...": paid in energy as it resolves, or nothing happens (rule 107.14). */
  energyCost?: number;
  /** Multikicker (rule 702.33c): the effect happens once more for each time the spell was kicked (Comet Storm). */
  perKick?: boolean;
  /** "If ~ has N or more charge (quest, oil ...) counters on it" (rule 603.4): only then does it trigger or apply. */
  minCharge?: number;
  /** "Then if it has N or more charge counters on it, (remove them all and) ...": checked as the ability resolves. */
  chargeAtResolve?: { n: number; reset: boolean };
  /** "Becomes the target" triggers: whose spell or ability it must be ('you' or 'opponents'; default anyone's). */
  targetedBy?: 'you' | 'opponents';
  /** "Becomes the target of a spell": abilities don't count. */
  spellOnly?: boolean;
  /** "This ability triggers only twice each turn" (Nadu): counted for each permanent that is targeted. */
  perTurn?: number;
  /** "That player", "they": the effect's target is the player the trigger is about (whoever drew, cast, attacked or was hit). */
  thatPlayer?: boolean;
  /** Dies triggers: "if it had no counters on it" (Unstoppable Slasher). */
  noCounters?: boolean;
  /** 'leaves' triggers: only when it goes to one of these zones ("dies or is put into exile"). */
  zones?: ('graveyard' | 'exile' | 'hand' | 'library')[];
  /** 'playerAttacks': only when the player attacks with at least this many creatures (Aurelia). */
  minAttackers?: number;
  /** For activated abilities: the mana cost and whether it taps the source. */
  activation?: {
    cost: ManaCost; tap: boolean; sacrifice: boolean; /** "Sacrifice a creature" as part of the cost. */ sacCreature?: boolean; /** "Tap four untapped Advisors you control" as part of the cost. */ tapCreatures?: number;
    /** "Pay {E}{E}": energy counters paid (rule 107.14). -1: "pay X {E}", any amount, and X is what was paid. */
    energy?: number;
    /** "Remove three charge counters from ~": charge counters removed from the source. */
    charge?: number;
    /** "Activate only as a sorcery." */
    sorcery?: boolean;
    /** "Discard a card" as part of the cost. */
    discard?: number;
    /** "Put a -1/-1 counter on ~" as part of the cost (Devoted Druid). */
    shrinkSelf?: number;
    /** "Remove two +1/+1 counters from ~" ('self'), or "remove a counter from a permanent you control" ('any': any kind, any of yours). */
    removeCounters?: { n: number; from: 'self' | 'any' };
    /** Boast: only if the source attacked this turn, once each turn (rule 702.142). */
    boast?: boolean;
    /** "Sacrifice a Food", "sacrifice five artifacts", "sacrifice a permanent" (Claws of Gix): other permanents of yours sacrificed as part of the cost. */
    sacOther?: { what: 'food' | 'artifact' | 'permanent'; n: number };
    /** "Exile this enchantment": the source is exiled as a cost (not a sacrifice). */
    exileSelf?: boolean;
  };
};

export type EffectBody =
  | ExileEffect
  | { kind: 'ramp'; lands: number; toHand: number; tapped: boolean }
  /**
   * energy: each use also costs this many energy counters (Solar Transformer).
   * charge: the amount is the source's charge counters ('tap': Astral Cornucopia; 'grow': a counter is added first,
   * Empowered Autogenerator) or each counter can be removed for one mana without tapping ('spend': Pentad Prism).
   */
  | { kind: 'mana'; amount: number; colors: Mana[] | 'any'; energy?: number; charge?: 'tap' | 'grow' | 'spend'; /** A land that taps for one mana for each artifact you control, less one it costs (Uthros, Titanic Godcore). */ perArtifact?: boolean
      /** The amount is a count instead (see classifyCounting.ts): enchantments you control (Sanctum Weaver) or the source's power (Vivi Ornitier). */
      count?: 'enchantments' | 'power' | 'colors' | /** Creatures you control of the source's chosen type (Three Tree City). */ 'chosenType' | /** Your devotion to your best color (Nykthos). */ 'devotion';
      /** "{2}, {T}: Add ...": generic mana paid from your other sources first. Kept as the net gain, used only when it beats the source's plain mana (Three Tree City, Nykthos). */
      net?: number;
      /** Corrupted: this ability works only while an opponent has three or more poison counters (Glistening Sphere). */
      corrupted?: boolean;
      /** "{0}: Add ...", usable once each turn during your own turn, without tapping (Vivi Ornitier). */
      oncePerTurn?: boolean;
      /** "Remove a +1/+1 counter from ~: Add one mana": each +1/+1 counter is a mana, without tapping (Crystalline Crawler). */
      fromCounters?: boolean;
      /** "Sacrifice an artifact: Add {C}{C}": each spare artifact token you control is this much mana, sacrificed when spent (Krark-Clan Ironworks). */
      sacArtifact?: boolean }
  /**
   * Spells cost less. from: only spells cast from a graveyard ('graveyard'), a graveyard or exile ('graveyardOrExile') or
   * anywhere but your hand ('notHand', which includes the command zone). first: only the first such spell you cast each turn.
   * minCmc: only spells with at least this mana value. affinity: {1} less for each artifact you control instead (Tezzeret).
   */
  | { kind: 'costReduction'; amount: number; filter: CastFilter; from?: 'graveyard' | 'graveyardOrExile' | 'notHand' | 'hand'; first?: boolean; minCmc?: number; affinity?: boolean }
  /**
   * Static: activated abilities cost {amount} less, but not below one mana (rule 601.2f): only abilities of creatures
   * you control ('yours', Training Grounds), of any creatures ('creatures', Heartstone) or every non-mana ability you activate ('all', Zirda).
   */
  | { kind: 'abilityDiscount'; amount: number; of: 'yours' | 'creatures' | 'all' }
  /**
   * Static: your lands make one more mana when tapped for mana: Swamps ('swamps', Crypt Ghast), every land ('lands',
   * Mirari's Wake), lands that make the chosen color ('chosenColor', Caged Sun: the color your deck uses most), or every
   * land and artifact that taps for {C} ('colorless', Forsaken Monument).
   */
  | { kind: 'manaBoost'; what: 'swamps' | 'lands' | 'chosenColor' | 'colorless' }
  /** Static: your creature tokens have "{T}: Add one mana of any color" (Insidious Roots). */
  | { kind: 'tokenMana' }
  /** Tap target permanent an opponent controls: a creature ('creature'), a nonland permanent ('nonland'), or an artifact, creature or land ('any'). noFlying: only a creature without flying. */
  | { kind: 'tap'; target: 'creature' | 'nonland' | 'any'; noFlying?: boolean }
  /** Static: untap steps change: nobody untaps ('none', Stasis) or creatures with power 3 or more don't untap ('bigCreatures', Meekstone). */
  | { kind: 'untapRule'; rule: 'none' | 'bigCreatures' }
  /** Static: "at the beginning of your upkeep, sacrifice ~ unless you pay {cost}" (Stasis). */
  | { kind: 'upkeepCost'; cost: ManaCost }
  /** Myr Battlesphere: tap X untapped creatures of this type you control; the source gets +X/+0 and deals X damage to the player it attacks. */
  | { kind: 'tapAllies'; subtype: string }
  /** ritual: mana from a spell or a sacrificed creature, not Treasure tokens, so token doublers don't touch it. */
  | { kind: 'treasure'; n: number; ritual?: boolean; /** One more {U} for each untapped Island you control (High Tide). */ islands?: boolean; /** One mana for each charge counter on the source (Black Market). */ byCharge?: boolean; /** One mana for each creature you control that shares a creature type with the one that entered (Mana Echoes). */ shareType?: boolean;
      /** Ritual mana that lasts until end of combat instead of the end of the step (firebending, rule 106.4). */ lasts?: 'combat';
      /** Ritual mana that can only pay for activated abilities (Thran Turbine). */ abilityOnly?: boolean; /** Colorless mana instead of any color. */ colorless?: boolean }
  | { kind: 'extraLand' }
  /**
   * count: the number drawn is counted as it resolves, and `n` is only the reader's estimate: the greatest power or
   * toughness among your creatures (Rishkar's Expertise, Last March of the Ents), your hand size plus one (Sea Gate
   * Restoration) or your devotion to red (Clive). discardHand: you discard your hand first (Clive).
   */
  | { kind: 'draw'; n: number; count?: 'greatestPower' | 'greatestToughness' | 'handPlusOne' | 'redDevotion'; discardHand?: boolean }
  /** Each player discards their hand, then draws `n` cards, or as many as the most anyone discarded ('max': Windfall, Jace's Archivist). */
  | { kind: 'wheelAll'; n: number | 'max' }
  /** Exchange life totals with the opponent highest on life, only when that gains you life, so the "draw what you lost" rider never applies (Mister Negative). */
  | { kind: 'exchangeLife' }
  /** anyTarget: damage that can also be aimed at a player ("any target"). */
  /** each: an edict that hits every opponent, or every player, instead of one target. */
  /** shrink: a 'damage' effect that is really -N/-N until end of turn ('temp') or -1/-1 counters ('counters'), which indestructible doesn't stop. */
  /** replace: a destroyed land's controller may search for a basic land to put onto the battlefield (Ghost Quarter). */
  /** energyPaid: "then you may pay any amount of {E}; it deals that much damage" (Galvanic Discharge): the damage is energy paid, and `amount` is what the spell itself gives. */
  | { kind: 'removal'; target: RemovalTarget; mode: RemovalMode; amount: number; /** Only a creature with a bounty counter on it (Bounty Hunter). */ bountyOnly?: boolean; anyTarget?: boolean; each?: 'opponents' | 'all'; shrink?: 'temp' | 'counters'; replace?: boolean; energyPaid?: boolean }
  | { kind: 'wipe'; target: 'creatures' | 'nonland' | 'artifacts'; mode: RemovalMode; amount: number; oneSided: boolean; shrink?: 'temp' | 'counters'; /** Wrath of the Skies: only mana value up to the energy paid (all of it). */ byEnergy?: boolean; /** Only mana value up to this (-1: X, Ugin's -X). */ maxCmc?: number; /** Only permanents that are one or more colors. */ colored?: boolean }
  /** cmc: only spells with this mana value (Mental Misstep). refund: you get one-shot mana equal to the countered spell's mana value (Mana Drain). */
  | { kind: 'counter'; target: 'any' | 'noncreature' | 'creature'; cmc?: number; refund?: boolean; /** "Counter that spell": the spell that set off this trigger. */ subject?: boolean }
  /** fragile: the token has "when this token becomes the target of a spell, sacrifice it" (Jace's Illusions). */
  | { kind: 'tokens'; n: number; power: number; toughness: number; keywords: string[]; /** Amass: grow the one Army you control instead of making another (rule 701.47). */ army?: boolean; fragile?: 'spell' | 'any'; /** The tokens' creature types ("1/1 white Soldier creature token"), lowercased, for tribal rules. */ subtypes?: string[]; /** Living weapon, job select: attach the source Equipment to the first token (rules 702.92, 702.182). */ attachSource?: boolean }
  /**
   * Create token copies of the source permanent (Skyclave Relic, Jace, Mirror Mage; offspring makes a 1/1 one).
   * size: the copy's power and toughness. loyalty: its starting loyalty.
   */
  | { kind: 'copySelf'; n: number; tapped?: boolean; nonlegendary?: boolean; loyalty?: number; size?: number; /** Opponents get the copy: one target opponent, or each opponent (Wedding Ring, Life of the Party). goaded: goaded for the rest of the game. */ give?: 'target' | 'each'; goaded?: boolean }
  /** Shuffle the source into its owner's library (Fblthp, the Lost). */
  | { kind: 'shuffleSelf' }
  /** Sacrifice the source (Phantasmal Image's "when this becomes the target ..."). */
  | { kind: 'sacrificeSelf'; /** "Sacrifice it unless it escaped" (Kroxa, rule 702.138c). */ unlessEscaped?: boolean }
  /** Static: the maximum hand size of `who` changes by n (rule 402.2; Gnat Miser -1, Jin-Gitaxias -7). */
  | { kind: 'handSize'; n: number; who: 'opponents' | 'you' }
  /** "When ~ enters, attach it to target legendary creature you control" (Mithril Coat). */
  | { kind: 'attachSelf'; legendary?: boolean }
  /** Reveal the top card of your library: a land goes onto the battlefield, anything else into your hand (Nadu). */
  | { kind: 'revealTop' }
  /** Put this many hour counters on the source; the twelfth sets off its 'hourTwelve' abilities (Midnight Clock). */
  | { kind: 'hours'; n: number }
  /** Shuffle your hand (and graveyard) into your library, then draw n. exileSelf: then exile the source. */
  | { kind: 'wheel'; n: number; graveyard: boolean; exileSelf?: boolean }
  /** keywords: "creatures you control have lifelink". */
  | { kind: 'anthem'; p: number; t: number; keywords?: string[]; /** Only creatures with power or toughness 1 or less (Tetsuko). */ small?: boolean; /** Only enchantment creatures, or only creatures you control but don't own (Garland). */ only?: 'enchantment' | 'artifact' | 'stolen' | 'token'; /** "Other creatures you control": not the source itself. */ other?: boolean; /** Only nonlegendary creatures (Cybermen Squadron). */ nonlegendary?: boolean; /** "+1/+1 for each blessing counter on ~": times the source's charge counters (Boon of the Spirit Realm). */ perCharge?: boolean; /** Only creatures of this subtype ("other Elves you control"), or of the type chosen as the source entered ('chosen'). */ subtype?: string }
  /** scale: what X counts when the bonus is "+X/+X, where X is ...". */
  | { kind: 'overrun'; p: number; t: number; trample: boolean; scale?: 'creatures' | 'power'; /** Keywords the team gains this turn. */ grant?: string[] }
  /** grant: keywords the creature gains until end of turn ("can't be blocked this turn" is 'unblockable'). */
  /** self: the source itself ("~ gains haste until end of turn"), no target. */
  | { kind: 'pump'; p: number; t: number; protect: boolean; grant?: string[]; self?: boolean; /** "Double its power": +X/+0 where X is its power as this resolves (p is the bots' estimate). */ doublePower?: boolean }
  /** cost: the equip cost of an Equipment, when the text gives one. */
  | { kind: 'equip'; p: number; t: number; keywords: string[]; aura: boolean; cost?: ManaCost; /** Control Magic: you control the enchanted creature. */ steal?: boolean; /** The enchanted permanent loses all abilities: a vanilla creature of `lockSize` (Amphibian Downpour) or a land that taps for {C} (Imprisoned in the Moon). */ lock?: 'blank' | 'land'; lockSize?: { p: number; t: number } }
  /** all: every permanent you control. player: you can't lose life either, until your next turn. */
  | { kind: 'protect'; all?: boolean; player?: boolean; /** Undying Malice, Not Dead After All: instead of protection, it returns tapped if it dies this turn, with this many +1/+1 counters. */ returns?: number }
  /** gain: life you gain afterwards; -1 = equal to the total life lost. */
  /** devotion: n is your devotion to this color instead (Gray Merchant). */
  | { kind: 'drain'; n: number; gain: number; devotion?: Color; /** Only opponents with no cards in hand (Tinybones). */ emptyHand?: boolean; /** "Deals N damage to each opponent": damage, so Torbran and prevention apply. */ damage?: boolean }
  /** lifeLoss: the player loses life rather than being dealt damage ("that player loses 2 life"), so damage rules don't touch it. */
  | { kind: 'damagePlayer'; n: number; lifeLoss?: boolean }
  | { kind: 'gainLife'; n: number }
  /** A drawback: you lose this much life (Bitterblossom, Dark Confidant). */
  | { kind: 'loseLife'; n: number; /** Only while the source is tapped (Mana Vault). */ ifTapped?: boolean }
  /** creatureToBattlefield: finds a creature and puts it straight onto the battlefield. */
  | { kind: 'tutor'; creatureToBattlefield?: boolean; /** Only creatures with mana value X or less. */ xLimit?: boolean; /** An artifact card onto the battlefield instead (Tezzeret the Seeker). */ artifactToBattlefield?: boolean }
  /**
   * Return cards from a graveyard. what: which cards it can return (default creatures). toTop: onto the library instead of into the hand.
   * all: every matching card instead of n of them. from: whose graveyard ('any' graveyard, or only 'opponents''; default your own);
   * cards from someone else's graveyard enter under your control. maxCmc: only cards with at most this mana value.
   */
  | { kind: 'recursion'; n: number; toBattlefield: boolean; what?: RecursionWhat; toTop?: boolean; all?: boolean; from?: 'any' | 'opponents'; maxCmc?: number; tapped?: boolean; /** Onto the battlefield if its mana value is at most your experience counters, else to hand (Meren). */ byExperience?: boolean; /** Only creature cards with power less than the source's (Mirko). */ belowPower?: boolean; /** The returned permanent gets a finality counter. */ finality?: boolean }
  /** Put up to n cards from your library into your graveyard (Buried Alive, Entomb). what: creature cards only, or any. */
  | { kind: 'entomb'; n: number; what: 'creature' | 'any' }
  /** Opponents mill more: twice as many (mult 2, Bruvac) and/or extra cards (plus 4, The Water Crystal). */
  | { kind: 'millBoost'; mult: number; plus: number }
  /** Damage your sources would deal to opponents is prevented and they mill that many instead (The Mindskinner). */
  | { kind: 'damageToMill' }
  /** You may play these cards from your graveyard (Crucible of Worlds: lands; Muldrotha: permanents, one of each type a turn). */
  | { kind: 'graveyardPlay'; what: 'lands' | 'permanents' | 'artifacts'; lifeCost?: number; /** It enters with a finality counter. */ finality?: boolean }
  /** Grafdigger's Cage: creature cards can't enter from graveyards and nobody casts spells from graveyards. */
  | { kind: 'graveyardLock' }
  /** Put the top (or bottom) card of your library into your graveyard; a creature card with power up to the source's goes onto the battlefield (Grenzo). */
  | { kind: 'millReanimate'; fromBottom: boolean }
  /** Persist and undying: the creature that just died returns with a -1/-1 (persist) or +1/+1 (undying) counter. */
  | { kind: 'returnSelf'; counters: number; tapped?: boolean }
  /** proliferate: only creatures that already have a counter. */
  /** byExperience: as many counters as you have experience counters (Kratos). */
  | { kind: 'counters'; n: number; all: boolean; /** "Each artifact creature you control" (Steel Overseer). */ artifact?: boolean; proliferate?: boolean; byExperience?: boolean; /** "Other target creature": never the source itself. */ other?: boolean }
  /** Replacement effects that double the tokens and/or +1/+1 counters you get. */
  | { kind: 'doubler'; tokens: boolean; counters: boolean }
  /**
   * Your permanents' triggered abilities trigger an additional time when the event is
   * 'enters' (an artifact or creature entering: Panharmonicon, the default),
   * 'permanentEnters' (any permanent: Elesh Norn, Yarok), 'attack' (a creature attacking: Isshin),
   * 'dies' (a creature dying: Drivnod) or 'magecraft' (you casting an instant or sorcery: Veyran).
   */
  | { kind: 'etbDoubler'; event?: 'enters' | 'permanentEnters' | 'attack' | 'dies' | 'magecraft' }
  /** Creatures can't attack you unless their controller pays this much for each. */
  | { kind: 'attackTax'; amount: number; /** Only creatures with counters, `amount` for each counter on them (Nils). */ perCounter?: boolean }
  /** Each player can't cast more than one spell each turn. */
  | { kind: 'spellLimit' }
  /** Spells cost more: your opponents' (or everyone's, with `all`), optionally only noncreature spells. */
  | { kind: 'spellTax'; amount: number; filter: 'any' | 'noncreature'; all?: boolean }
  /** Ankh of Mishra, Zo-Zu: a land entering costs its controller life. */
  | { kind: 'landPunish'; n: number }
  /** Creatures deal combat damage with toughness (Doran); `defenders`: only those with defender, which may also attack (Arcades). */
  | { kind: 'toughnessMatters'; defenders: boolean; /** Only your creatures. */ yours?: boolean }
  /** Reveal from the top of your library until a nonland permanent card, and put it onto the battlefield. */
  | { kind: 'digPermanent'; /** Every artifact card among the top `among` cards instead (Tezzeret, Master of the Bridge). */ artifacts?: boolean; among?: number;
      /** Every permanent card among the top `among` cards (-1: X) onto the battlefield, with mana value X or less if `xLimit`; the rest go to `rest` (Genesis Ultimatum, Genesis Wave). */
      permanents?: { xLimit: boolean; rest: 'hand' | 'graveyard' } }
  /** Target player separates their permanents into two piles and sacrifices one (Liliana of the Veil): about half of them. */
  | { kind: 'sacrificeHalf' }
  /** Cast a card from your graveyard without paying its mana cost (Vadrok). */
  | { kind: 'freeFromGraveyard'; maxCmc: number; noncreature?: boolean }
  /** Opponents can't cast their commanders from the command zone. */
  | { kind: 'commandLock' }
  /** Cards that would go to a graveyard are exiled instead (only your opponents' cards, with `opponents`: Dauthi Voidwalker). */
  | { kind: 'graveyardHate'; opponents?: boolean }
  /** Exile graveyards: every opponent's, or everyone's. `cards`: only that many cards, the best ones in opponents' graveyards. */
  | { kind: 'exileGraveyards'; all: boolean; cards?: number }
  /** Enters as a copy of a creature on the battlefield: any, only yours (Spark Double) or only an opponent's (Imposter Mech). */
  | { kind: 'clone'; from?: 'yours' | 'opponents'; /** Copy Enchantment, Copy Artifact: copies an enchantment or an artifact instead of a creature. */ what?: 'enchantment' | 'artifact'; /** Enters tapped (Callidus Assassin). */ tapped?: boolean; /** "It isn't legendary." */ nonlegendary?: boolean; /** "Enters with an additional +1/+1 counter." */ extraCounter?: boolean; /** Phantasmal Image: "when this becomes the target of a spell or ability, sacrifice it". */ fragile?: boolean }
  /** Take a creature: one on the battlefield, or the best in an opponent's library. */
  /** whileSource: only "for as long as you control ~" (Sower of Temptation): the creature goes back when the source leaves. */
  /** what: an artifact instead of a creature (Thieving Skydiver; an Equipment is then attached to the source). maxCmc: only mana value up to this; -1 = X. */
  /** payEnergy: Confiscation Coup gives this much energy, then the steal costs energy equal to the target's mana value. */
  /**
   * until: control ends at the end of this turn ('eot', Act of Treason) or of the taker's next turn ('nextTurn', Treasure Nabber).
   * untap / haste: "untap that creature, it gains haste" (threaten). all: every artifact the player the ability is about controls
   * (Hellkite Tyrant). from 'hand': put a creature card from target opponent's hand onto the battlefield (Treacherous Urge).
   * what 'permanent' / 'noncreatureArtifact': what can be taken besides a creature. minPower: only if its power is at most this,
   * unless you control another creature of `orSubtype` (Reptilian Recruiter). base: it has this base power and toughness and these
   * keywords until end of turn (Flayer of Loyalties).
   */
  | { kind: 'steal'; from: 'battlefield' | 'library' | 'hand'; whileSource?: boolean; payEnergy?: number; what?: 'artifact' | 'noncreatureArtifact' | 'permanent'; maxCmc?: number; until?: 'eot' | 'nextTurn'; untap?: boolean; haste?: boolean; all?: 'artifacts'; maxPower?: number; orSubtype?: string; base?: { p: number; t: number; keywords: string[] }; /** "Sacrifice it at the beginning of the next end step." */ sacAtEnd?: boolean }
  /**
   * Real token copies (rules 111.10, 707.2): tokens with the copiable values of a permanent, with the card's "except" changes.
   * of: 'target' (a target permanent that matches `filter`), 'attached' (the equipped or enchanted permanent), 'subject' (the
   * permanent or card the trigger is about: the creature that entered, attacked or died), 'aimed' (what the previous part of the
   * spell took or returned: Blue Sun's Twilight, Coiling Rebirth), 'tokens' (each token you control: Second Harvest).
   * end: sacrificed or exiled at the beginning of the next end step. minX: only if X is at least this.
   */
  | { kind: 'tokenCopy'; n: number; of: 'target' | 'attached' | 'subject' | 'aimed' | 'tokens'; filter?: CopyFilter; nonlegendary?: boolean; legendary?: boolean; haste?: boolean; flying?: boolean; /** "Except it's 1/1": its base power and toughness. */ pt?: { p: number; t: number }; end?: 'sacrifice' | 'exile'; tapped?: boolean; attacking?: boolean; minX?: number; /** The copy is an enchantment and no other card type (Myrkul). */ enchantment?: boolean }
  /**
   * The source becomes a copy of another permanent (rule 707.2): a target matching `filter`, or a creature card in a graveyard
   * ('graveyard': yours with mana value X, Lazav the Multifarious; 'subject': the card the trigger is about, Lazav Dimir Mastermind).
   * untilEot: only until end of turn. keep: "except it has this ability" (it keeps the source's abilities). name: it keeps its name.
   * pump: both it and the copied creature get +p/+0 and haste until end of turn (Gogo).
   */
  | { kind: 'becomeCopy'; of: 'target' | 'graveyard' | 'subject'; filter?: CopyFilter; untilEot?: boolean; keep?: boolean; pump?: number; hexproof?: boolean; /** "Except its name is ~" (and it's legendary, for Lazav). */ name?: boolean }
  /**
   * "Return that card to the battlefield under your control": the card the trigger is about (a creature that died, a permanent an
   * opponent sacrificed or discarded), from its owner's graveyard, or from exile (Kaya's Ghostform: "dies or is put into exile").
   * samurai: only Samurai cards (Oathkeeper). shrunk: only a creature that had a -1/-1 counter on it (Necroskitter).
   */
  | { kind: 'takeCard'; samurai?: boolean; shrunk?: boolean }
  /** Static: whenever an opponent taps an artifact for mana, you gain control of it until the end of your next turn (Treasure Nabber). */
  | { kind: 'nabArtifacts' }
  /** Static: whenever a nonland permanent an opponent owns enters under your control, they lose life equal to its mana value (Brainstealer Dragon). */
  | { kind: 'stolenDrain' }
  /**
   * Static token replacement (rule 614.1a). 'oneOfEach': a Clue, Food or Treasure becomes one of each (Academy Manufactor).
   * 'treasure': one more Treasure (Xorn). 'squirrels': that many 1/1 Squirrels too (Chatterfang). 'food': one more Food (Peregrin Took).
   * 'copies': the first tokens each turn are copies of the enchanted permanent instead (Moonlit Meditation).
   */
  | { kind: 'tokenReplace'; add: 'oneOfEach' | 'treasure' | 'squirrels' | 'food' | 'copies' }
  /**
   * Change the target of a spell or ability with a single target (rule 115.7). to 'choose': any new legal target (Deflecting Swat,
   * Misdirection); 'self': the source itself (Spellskite, Hydroelectric Specimen). spells: only instants and sorceries ('instantSorcery'),
   * or any spell; abilities: abilities too. copy: then copy it, and the copy may have new targets too (Wyll's Reversal on 15+).
   * damage: you take damage equal to the spell's mana value (Imp's Mischief).
   */
  | { kind: 'redirect'; to: 'choose' | 'self'; spells: 'any' | 'instantSorcery'; abilities?: boolean; copy?: boolean; damage?: boolean }
  /**
   * Delayed copies (rule 707.10): the next instant or sorcery spell you cast this turn is copied ('next', Teach by Example),
   * or every spell you cast this turn ('turn', Jace Reawakened).
   */
  | { kind: 'copyNext'; until: 'next' | 'turn' }
  /** Static: whenever you would copy a spell, copy it once more (Twinning Staff). */
  | { kind: 'copyDoubler' }
  /** Static: the source enters under the control of an opponent and attacks each combat, but never its owner (Xantcha). */
  | { kind: 'givenAway' }
  /** Put a creature card from your hand onto the battlefield. */
  | { kind: 'cheat' }
  | { kind: 'extraTurn'; /** Take this many (Teferi, Master of Time's two). */ n?: number }
  /** You get an emblem with these abilities (rule 114): they work from the command zone for the rest of the game. */
  | { kind: 'emblem'; card: SimCard }
  /**
   * Make real artifact tokens: Food ("{2}, {T}, sacrifice: gain 3 life"), Blood ("{1}, {T}, discard a card,
   * sacrifice: draw a card") or an Incubator with `size` +1/+1 counters ("{2}: transform" into a Phyrexian artifact
   * creature, rule 701.53). n: how many (-1: X).
   */
  | { kind: 'artifactToken'; token: 'food' | 'blood' | 'incubator'; n: number; size?: number }
  /** Transform target Incubator token you control into its Phyrexian side (Progenitor Exarch). */
  | { kind: 'hatch' }
  /** "There is an additional beginning phase after this phase" (Sphinx of the Second Sun, rule 500.8). */
  | { kind: 'extraPhase'; phase: 'beginning' }
  /** Static: planeswalkers you control have "[0]: proliferate" and "[-12]: take an extra turn after this one" (Ichormoon Gauntlet). */
  | { kind: 'pwAbilities' }
  /** Static: unlock costs you pay cost this much less (Inquisitive Glimmer, rule 709.5e). */
  | { kind: 'unlockDiscount'; n: number }
  /** Look at the top n cards and keep or bin each. Surveil puts the rest in the graveyard, scry on the bottom. */
  | { kind: 'scry'; n: number; surveil: boolean }
  /**
   * Put cards from the top of a library into the graveyard. n: -1 = X, -2 = half the library, -3 = twice X.
   * untilLands: reveal cards until that many lands are revealed and mill them all (Consuming Aberration, Mind Grind).
   */
  | { kind: 'mill'; n: number; who: 'target' | 'opponents' | 'all' | 'you'; untilLands?: number }
  | { kind: 'discard'; n: number; who: 'target' | 'opponents' }
  /** You have no maximum hand size. */
  | { kind: 'noMaxHand' }
  /** Laboratory Maniac: drawing from an empty library wins the game instead. */
  | { kind: 'winOnEmptyDraw' }
  /** You become the monarch: draw a card at each of your end steps until someone takes it by combat damage. */
  | { kind: 'monarch'; /** Garland: a target opponent becomes the monarch instead. */ opponent?: boolean }
  /** You get an experience counter. */
  | { kind: 'experience' }
  /** Put a stun counter on an opponent's nonland permanent (its next untap doesn't happen). */
  | { kind: 'stun'; /** Tap it first (Fear of Sleep Paralysis). */ tap?: boolean; /** Only a tapped creature (Cryogen Relic). */ tapped?: boolean; /** Up to this many creatures (-1: the times this creature has mutated, Archipelagore). */ n?: number }
  /** Mathas: a bounty counter on an opponent's creature; when it dies, its controller's opponents each draw 1 and gain 2. */
  | { kind: 'bounty'; /** Only the counter: the creature doesn't get Mathas's "when this dies, each opponent draws and gains 2". */ plain?: boolean; /** Any creature, not only an opponent's (Bounty Board). */ any?: boolean }
  /** Static: whenever a creature with a bounty counter dies, each of its controller's opponents draws and gains 2 (Bounty Board), or this gets `n` +1/+1 counters (Shay Cormac). */
  | { kind: 'bountyPayout'; what: 'drawGain' | 'counters'; n: number }
  /** Static: an opponent's creature that becomes the target of your spell or ability gets a bounty counter (Shay Cormac). */
  | { kind: 'bountyOnTarget' }
  /** Players get poison counters (rule 122.1f): each opponent, each player, or one target player. */
  | { kind: 'poison'; n: number; who: 'opponents' | 'each' | 'target'; /** Up to this many in total (Vraska's "equal to the difference"). */ upTo?: number }
  /** A keyword counter (rule 122.1b): an indestructible or flying counter on the source ('self') or one of your creatures ('yours'). */
  | { kind: 'kwCounter'; kw: string; on: 'self' | 'yours' }
  /** Korvold: sacrifice another permanent (part of the trigger, not optional). */
  | { kind: 'sacrificeOther' }
  /** Roll this many six-sided dice; each result fires your die-roll triggers. */
  | { kind: 'rollDice'; n: number }
  /** The source has a keyword while a condition holds. */
  | { kind: 'selfKeyword'; keyword: string; cond: 'halfLife' | 'yourTurn' }
  /** Satya: a token copy of another nontoken creature you control, tapped and attacking; sacrificed at the next end step unless you pay energy equal to its mana value. */
  | { kind: 'copyCreature'; temporary: boolean }
  /** A token copy of another nonlegendary artifact or enchantment; only while you're the monarch when `monarch` (Court of Vantress). */
  | { kind: 'copyPermanent'; monarch?: boolean }
  /** Gev: your other creatures enter with this many extra +1/+1 counters for each opponent who lost life this turn. */
  | { kind: 'enterCounters'; n: number; /** Metallic Mimic: only creatures of the chosen type, one counter each, no life-loss scaling. */ chosen?: boolean }
  /** Kudo: other creatures have this base power and toughness. */
  | { kind: 'baseSize'; p: number; t: number }
  /** You get this many energy counters (rule 122.1, 107.14). -1: "that many" / X. */
  | { kind: 'energy'; n: number }
  /** Energy you would get is doubled (Aether Refinery: mult 2) or increased (Izzet Generatorium: plus 1). */
  | { kind: 'energyBoost'; mult: number; plus: number }
  /** Charge counters: on the source, or on another target artifact you control. */
  | { kind: 'charge'; n: number; target?: 'artifact'; /** "Your choice of a +1/+1 counter or two charge counters" (Inspirit): a +1/+1 counter on an artifact creature when no artifact uses charge counters. */ orCounter?: boolean }
  /** Darksteel Reactor: you win the game once the source has this many charge counters. */
  | { kind: 'chargeWin'; n: number }
  /**
   * Static rules about lands (rule 305.7: setting a land's subtype removes its old land types and abilities).
   * nonbasicMountains / nonbasicIslands: Blood Moon, Harbinger of the Seas. nonbasicNoUntap: Back to Basics.
   * untapOneNonbasic: Winter Moon. untapOneLand: Winter Orb. oppNonbasicTapped: Archon of Emeria.
   * everyType: Dryad of the Ilysian Grove (your lands tap for any color).
   */
  | { kind: 'landRule'; rule: 'nonbasicMountains' | 'nonbasicIslands' | 'nonbasicNoUntap' | 'untapOneNonbasic' | 'untapOneLand' | 'oppNonbasicTapped' | 'everyType' }
  /**
   * Whenever a player taps a land for mana: it deals `n` damage to them (Manabarbs; Burning Earth: only nonbasic lands),
   * all their lands become tapped ('tapAll', War's Toll and Mana Web: opponents only), or the land is destroyed
   * if it isn't their turn ('destroyOffTurn', Price of Glory).
   */
  | { kind: 'tapPunish'; what: 'damage' | 'tapAll' | 'destroyOffTurn'; n: number; nonbasic?: boolean; opponents?: boolean }
  /** Destroy all lands, or all nonbasic lands; with `replace` each player may fetch a basic land for each (From the Ashes). */
  | { kind: 'landWipe'; nonbasic: boolean; replace?: boolean }
  /** Each player (or each opponent) sacrifices `n` lands, or all but `keep` of them (Keldon Firebombers). */
  | { kind: 'landSac'; n: number; /** 'you': you sacrifice them (Lotus Field). */ who: 'each' | 'opponents' | 'you'; keep?: number }
  /** Damage to each player for each nonbasic land they control (Price of Progress: 2, Sunspine Lynx: 1). */
  | { kind: 'nonbasicBurn'; per: number }
  /** Dingus Egg: whenever a land goes to a graveyard from the battlefield, its controller takes this much damage. */
  | { kind: 'landDiesPunish'; n: number }
  /**
   * Prevent combat damage this turn (rule 615): all of it ('all', Fog), the damage dealt to you ('you', Inkshield,
   * which makes a 2/1 flyer for each 1 prevented: `tokens`), or the damage dealt to and by one target attacking creature ('creature', Maze of Ith).
   */
  | { kind: 'fog'; who: 'all' | 'you' | 'creature'; tokens?: boolean; untap?: boolean; /** Return the creatures attacking you to their owners' hands instead (Aetherize). */ bounce?: boolean; /** With bounce: into their owners' libraries instead of hands (Aetherspouts). */ tuck?: boolean }
  /**
   * Manifest (rule 701.40): put the top card of a library onto the battlefield face down as a 2/2.
   * who: 'you'; 'targetController', the controller of what the previous part of the ability hit
   * (Reality Shift); 'opponents', the top card of each opponent's library, under your control.
   * dread: look at the top two and manifest one, the other goes to the graveyard (rule 701.62).
   */
  | { kind: 'manifest'; who: 'you' | 'targetController' | 'opponents'; dread?: boolean }
  /**
   * Transform a double-faced permanent to its other face (rule 701.28). reenter: it is exiled and
   * returns transformed, as a new object. fromGraveyard: "when this dies, return it transformed".
   * cond: only if you have at least `n` creatures (of `subtype`) or cards in your graveyard.
   */
  | { kind: 'transform'; reenter?: boolean; fromGraveyard?: boolean; tapped?: boolean; cond?: { count: 'creatures' | 'graveyard'; n: number; subtype?: string }; /** Part of another activated ability on the same line (Jace, Vryn's Prodigy): not activated by itself. */ rider?: boolean }
  /** Approach of the Second Sun: gain 7 the first time, win the second. */
  | { kind: 'approach' }
  /**
   * Goad (rule 701.15): the creature attacks each combat if able, and attacks a player other
   * than you if able, until your next turn. all: every creature your opponents control.
   * weaker: static, only creatures with less power than the source (Baeloth Barrityl).
   */
  | { kind: 'goad'; all: boolean; weaker?: boolean; /** Tap it too (Karazikar). */ tap?: boolean }
  /** Exile your own permanents and return them at once, so their enters abilities happen again. */
  | { kind: 'blink'; n: number; what: 'creature' | 'permanent' }
  /** The Ring tempts you (rule 701.54): choose a ring-bearer; each time adds one of the Ring's four abilities. */
  | { kind: 'ringTempts' }
  /** Put a lore counter on target Saga you control (Sigurd's boast). Its chapter ability triggers. */
  | { kind: 'lore' }
  /** Static: when this permanent becomes the target of a spell, it is shuffled into its owner's library (Fblthp, the Lost). */
  | { kind: 'shuffleWhenTargeted' }
  /** Put a blight counter on target land: it loses its abilities and taps for {C} for good (Ultima). */
  | { kind: 'blight' }
  /** Static: whenever you tap a land for {C}, add an additional {C} (Ultima). */
  | { kind: 'colorlessBoost' }
  /** Target non-Aura enchantment you control becomes a creature with base power and toughness equal to its mana value, for good (Zur). */
  | { kind: 'animate' }
  // --- Lockouts, animation and winning or losing (see classifyLocks.ts) ---------
  /**
   * Static: activated abilities of these permanents can't be activated, mana abilities included (rule 602.5):
   * creatures (Cursed Totem), artifacts (Karn, the Great Creator) or artifacts, creatures and enchantments (Grand Abolisher).
   * who: whose permanents. yourTurn: only during the source controller's turn.
   */
  | { kind: 'abilityLock'; perms: 'creatures' | 'artifacts' | 'nonland'; who: 'all' | 'opponents'; yourTurn?: boolean }
  /**
   * Static: who can't cast which spells (rule 101.2). 'all': nothing at all; 'yourTurn': nothing during the source
   * controller's turn (Kutzil); 'sorcerySpeed': only when they could cast a sorcery (Teferi, Time Raveler); 'evenCmc'
   * (Void Winnower); 'overLands': noncreature spells with mana value above their land count (Lavinia); 'graveyard':
   * noncreature spells from graveyards or exile (Soulless Jailer); 'oneNonPhyrexian': one non-Phyrexian spell a turn (Phyrexian Censor).
   */
  | { kind: 'castLock'; who: 'all' | 'opponents'; rule: 'all' | 'yourTurn' | 'sorcerySpeed' | 'evenCmc' | 'overLands' | 'graveyard' | 'oneNonPhyrexian' }
  /** Your opponents can't cast spells this turn (Silence). */
  | { kind: 'silence' }
  /** Static: spells you control can't be countered: all of them (Chimil), spells with flash (Cunning Nightbonder), creature and enchantment spells (Destiny Spinner). */
  | { kind: 'uncounterable'; filter: 'any' | 'flash' | 'creatureOrEnchantment' }
  /** Static: whenever a player (or an opponent) casts a spell with no mana spent on it, counter it (Vexing Bauble, Lavinia). */
  | { kind: 'counterFree'; who: 'all' | 'opponents' }
  /** Static: creatures lose all abilities (Dress Down), or only non-Horror creatures with slime counters, which are also 2/2 (Sludge Monster). */
  | { kind: 'loseAbilities'; what: 'creatures' | 'slimed' }
  /**
   * Target permanent an opponent controls loses all abilities: while the source stays ('source', Tishana's Tidebinder),
   * or until your next turn ('yourNextTurn', Azure Beastbinder). `size`: a creature also has this base power and toughness.
   */
  | { kind: 'blank'; until: 'source' | 'yourNextTurn'; size?: { p: number; t: number } }
  /** Put a slime counter on another target creature (Sludge Monster). */
  | { kind: 'slime' }
  /** Static: these events don't make abilities trigger: creatures entering or dying, for everyone (Hushbringer), or permanents entering, for your opponents' permanents (Elesh Norn). */
  | { kind: 'triggerLock'; event: 'creatures' | 'enters'; who: 'all' | 'opponents' }
  /** Static: this isn't a creature unless your devotion to these colors is at least `n` (Theros gods), or you control `n` permanents you don't own (Arvinox). */
  | { kind: 'notCreature'; devotion?: Color[]; stolen?: boolean; n: number }
  /**
   * Permanents become creatures (rule 613.1d): the source itself ('self'), a target noncreature artifact or Vehicle, every
   * noncreature artifact or Vehicle you control, a land you control, or your Treasures. size: base power and toughness
   * ('cmc': its mana value; 'enchantments': the number of enchantments you control); a Vehicle keeps its own when there is none.
   * until: end of turn, your next turn, or sacrificed at the next end step ('sacAtEnd').
   */
  | { kind: 'becomeCreature'; what: 'self' | 'artifact' | 'artifacts' | 'vehicle' | 'vehicles' | 'land' | 'treasures'; size?: { p: number; t: number } | 'cmc' | 'enchantments'; keywords?: string[]; until: 'eot' | 'yourNextTurn' | 'sacAtEnd' }
  /** Target permanent becomes an artifact in addition to its other types until end of turn (Argent Mutation). */
  | { kind: 'becomeArtifact' }
  /** Target creature becomes a Treasure and loses its other types and abilities (Vraska, Betrayal's Sting): its controller gets a Treasure for it. */
  | { kind: 'becomeTreasure' }
  /**
   * "You win the game" when a count is reached, checked as the ability resolves: Treasures (Revel in Riches), artifacts
   * (Hellkite Tyrant), exactly `n` cards in hand (Triskaidekaphile), `n` counters on the source or `orHand` cards in hand (Twenty-Toed Toad).
   */
  | { kind: 'winIf'; cond: 'treasures' | 'artifacts' | 'handExactly' | 'counters'; n: number; orHand?: number }
  /**
   * Static: you can't lose the game (and, with `opponentsCantWin`, your opponents can't win: Platinum Angel), or only
   * not for having 0 or less life (`lifeOnly`: Phyrexian Unlife; `attached`: while this Equipment is on a creature, Pact Weapon).
   * `infect`: while you have 0 or less life, damage to you is dealt as poison counters.
   */
  | { kind: 'cantLose'; lifeOnly?: boolean; opponentsCantWin?: boolean; attached?: boolean; infect?: boolean }
  /** "At the beginning of your next upkeep, pay this. If you don't, you lose the game." (Pacts) */
  | { kind: 'pact'; cost: ManaCost }
  /** Static: drawing from an empty library returns a creature card from your graveyard to the battlefield instead; with none, you lose (Out of the Tombs). */
  | { kind: 'emptyDrawReanimate' }
  /** Static: sacrificed at the beginning of each end step (Dress Down, Ball Lightning). */
  | { kind: 'endSacrifice' }
  /** Static: your creatures of this subtype have protection from ring-bearers (Lord of the Nazgûl). */
  | { kind: 'ringProtection'; subtype: string }
  /** Static: when an opponent's spell or ability makes you discard this card, create a token copy of target permanent (Orvar). */
  | { kind: 'copyOnDiscard' }
  /** Static: other creatures are Food artifacts with "{2}, {T}, Sacrifice this: gain 3 life" (Ygra). */
  | { kind: 'foodCreatures' }
  /** A Curse's ability (see SimCard.curse). */
  | { kind: 'curse'; act: CurseAct; n: number }
  /** Static: a Curse put into your graveyard from the battlefield returns attached to you at the next end step (Lynde). */
  | { kind: 'returnCurses' }
  /**
   * Static attack and block rules (rules 508.1c-d, 509.1b-c), see classifyCombat.ts.
   * rule: 'mustAttack' (attacks each combat if able), 'cantAttack', 'cantBlock', 'cantAttackYou' (can't attack the
   * source's controller), 'maxAttackers' (no more than `n` creatures can attack you each combat).
   * who: whose creatures it covers: 'self' (the source), 'attached' (the creature this Aura is on), 'opponents'
   * (creatures the source's controller's opponents control), 'all'.
   * filter: only creatures that are goaded, have even mana value, power `maxPower` or less, a subtype, a name,
   * -1/-1 counters, or less power than the source ('weaker'). vsYours: only when blocking the source controller's creatures.
   * unlessCreatures: the rule lifts while its controller controls this many other creatures (Oketra).
 * 'cantAttackOwner': can't attack its owner (Xantcha). 'allAttack': once one of an opponent's creatures attacks, all of theirs must (War's Toll).
   */
  | { kind: 'combatRule'; rule: 'mustAttack' | 'cantAttack' | 'cantBlock' | 'cantAttackYou' | 'cantAttackOwner' | 'maxAttackers' | 'allAttack'; who: 'self' | 'attached' | 'opponents' | 'all'; n?: number; filter?: { goaded?: boolean; evenMv?: boolean; maxPower?: number; subtype?: string; name?: string; minusCounters?: boolean; weaker?: boolean }; vsYours?: boolean; unlessCreatures?: number; /** Only during extra turns (Medomai). */ extraTurns?: boolean }
  /** Creatures your opponents control attack each combat if able, this turn ('turn') or until your next turn ('yourNextTurn') (Bident of Thassa, The Akroan War). */
  | { kind: 'forceAttack'; until: 'turn' | 'yourNextTurn' }
  /** Until your next turn, creatures can't attack you unless their controller pays this much for each (Summon: Yojimbo). */
  | { kind: 'tempAttackTax'; amount: number }
  /** Target creature can't attack and/or can't block this turn (Endbringer, Zirda). */
  | { kind: 'pacify'; attack: boolean; block: boolean }
  /** Suspect target creature (rule 701.60): it has menace and can't block for as long as it's suspected. thenGoad: then goad all suspected creatures (Nelly Borca). */
  | { kind: 'suspect'; thenGoad?: boolean }
  /** Static: whenever a goaded creature attacks, it deals this much damage to its controller (Vengeful Ancestor). */
  | { kind: 'goadPunish'; n: number }
  /** Return the blocked creature that set this off to its owner's hand (Grazilaxx). */
  | { kind: 'returnBlocked' }
  /**
   * Static: whenever a source deals damage to this permanent, that source's controller sacrifices that many permanents
   * ('sacrifice', Phyrexian Obliterator) or gets a poison counter ('poison', Reaper of Sheoldred).
   */
  | { kind: 'damagedPunish'; what: 'sacrifice' | 'poison' }
  /** Static: whenever a creature or planeswalker an opponent controls with a bounty counter on it is dealt damage, destroy it (Termination Facilitator). */
  | { kind: 'bountyDestroy' }
  /** Static: if you would proliferate, proliferate twice instead (Tekuthal); two of them make it four times. */
  | { kind: 'proliferateTwice' }
  /** Static: you have hexproof, so opponents' spells and abilities can't target you (rule 702.11c; Teyo, Crystal Barricade). */
  | { kind: 'playerHexproof' }
  /** Static: at the beginning of your end step, return this permanent to its owner's hand (Reinforced Ronin). */
  | { kind: 'bounceSelfAtEnd' }
  /** Static: at the beginning of your end step, your life total becomes n (The Endstone: half your starting life total). */
  | { kind: 'lifeBecomes'; n: number }
  /**
   * The player this creature attacked, when it attacked and wasn't blocked: loses life for each card in their graveyard
   * ('graveyard', Guiltfeeder) or discards `n` cards after you sacrifice the creature ('discard', Dauthi Mindripper).
   */
  | { kind: 'punishDefender'; what: 'graveyard' | 'discard'; n: number }
  /** Static: you have protection from each of your opponents (rule 702.16j, Absolute Virtue). */
  | { kind: 'playerProtection' }
  /** "Creatures your opponents control get -2/-2" (Elesh Norn, Grand Cenobite). */
  | { kind: 'oppAnthem'; p: number; t: number }
  /** "Creatures your opponents control enter tapped" (Authority of the Consuls); artifacts too (Blind Obedience). */
  | { kind: 'oppEnterTapped'; artifacts?: boolean }
  /** Static: commanders you control have these keywords (Vexilus Praetor: protection from everything). */
  | { kind: 'commanderKeywords'; keywords: string[] }
  /** Target creature you control gains protection from the color of your choice until end of turn (Mother of Runes). */
  /** Static: creatures you control are every creature type (Maskwood Nexus), or also the type chosen as the source entered (Leyline of Transformation). */
  | { kind: 'creatureTypes'; every: boolean }
  | { kind: 'protectColor'; /** It also gains toxic this turn (Skrelv). */ toxic?: number }
  /** You may move a Curse attached to you onto an opponent; if you do, draw n cards (Lynde). */
  | { kind: 'passCurse'; n: number }
  /**
   * Rules about drawing: 'double' (Teferi's Ageless Insight: your draws past the first in your draw step are doubled),
   * 'steal' (Notion Thief: those draws of your opponents come to you instead), 'limit' (Narset: opponents draw at most one card a turn).
   */
  | { kind: 'drawRule'; rule: 'double' | 'steal' | 'limit' }
  /** Mindcrank: whenever an opponent loses life, they mill that many cards. */
  | { kind: 'lifeLossMill' }
  /** Untap your permanents: up to n lands, all your creatures, all your nonland permanents, one permanent, or the source itself. */
  | { kind: 'untap'; what: 'lands' | 'creatures' | 'nonland' | 'artifacts' | 'permanent' | 'self'; n: number }
  /**
   * Additional combat phases (rule 500.8): `n` combats, then an additional main phase if `main`. They come right after
   * the current phase, or after the second main phase ('lastMain', World at War). firstOnly: only during the turn's
   * first combat (Genji Glove, Aurelia). inCombat: only during your own combat (Great Train Heist). untapAttacked: at the
   * beginning of each combat this turn, untap all creatures that attacked this turn (Full Throttle).
   */
  | { kind: 'extraCombat'; n: number; main?: boolean; after?: 'lastMain'; firstOnly?: boolean; inCombat?: boolean; untapAttacked?: boolean }
  /**
   * Static: damage your sources deal to an opponent is increased: by the source's charge counters (Fated Firepower's
   * fire counters, `perCharge`), or doubled (`double`; only noncombat damage with `noncombat`, Solphim).
   */
  | { kind: 'damageBonus'; perCharge?: boolean; double?: boolean; noncombat?: boolean }
  /**
   * Static damage replacement and prevention (rules 614.1a, 615): damage from `from` to `to` gets `n` more ('plus'),
   * is multiplied by `n` ('times'), is raised to the source's power ('toPower', Ojer Axonil), or is prevented
   * ('prevent'; 'preventHalf' prevents half, rounded up). See Game.damageAfter.
   * from: sources you control ('yours'), other sources you control ('otherYours'), any source ('any').
   * to: an opponent or a permanent an opponent controls ('opponents'), an opponent only ('opponentPlayers'), anything ('any'),
   * you or a permanent you control ('you'), this permanent ('self'), other creatures you control ('otherCreatures'),
   * attacking creatures you control ('attackers'), the equipped or enchanted creature ('attached').
   */
  | {
    kind: 'damageMod'; op: 'plus' | 'times' | 'toPower' | 'prevent' | 'preventHalf'; n: number;
    from: 'yours' | 'otherYours' | 'any'; to: 'opponents' | 'opponentPlayers' | 'any' | 'you' | 'self' | 'otherCreatures' | 'attackers' | 'attached';
    /** Only damage from a source of this color ("a red source you control"). */ color?: Color;
    /** Only noncombat damage. */ noncombat?: boolean;
    /** Only creatures of these types (Valley Flamecaller), or with a +1/+1 counter (Uncivil Unrest). */ subtypes?: string[]; withCounter?: boolean;
    /** Revolt: only if a permanent left the battlefield under your control this turn (Aether Revolt). */ revolt?: boolean;
    /** Phyrexian Vindicator: the prevented damage is dealt to another target instead. */ reflect?: boolean;
  }
  /** Static: damage can't be prevented (Sunspine Lynx, rule 615.12). */
  | { kind: 'noPrevent' }
  /**
   * Static life-gain replacements (rule 614.1a): nobody gains life ('noGain'), life you gain is doubled ('double'),
   * or a player who would gain life loses that much instead ('lossInstead'). who: every player, your opponents, or you.
   */
  | { kind: 'lifeRule'; rule: 'noGain' | 'double' | 'lossInstead'; who: 'all' | 'opponents' | 'you' }
  /** The player the trigger is about loses half their life, rounded up (Quietus Spike). */
  | { kind: 'loseHalf' }
  /** "The next time a source of your choice would deal damage to you this turn, prevent that damage" (Deflecting Palm): `reflect` deals it to that source's controller. */
  | { kind: 'preventNext'; reflect: boolean }
  /**
   * Static: a creature that would die is exiled instead (rule 614.1a): opponents' creatures (Gisa, Vren, The Darkness Crystal: `nontoken`, and you
   * gain `gain` life). `keep`: the exiled cards are "exiled with" the source, for its other abilities (`reanimateExiled`).
   */
  | { kind: 'deathExile'; nontoken?: boolean; gain?: number; keep?: boolean }
  /** Put creature cards exiled with the source onto the battlefield under your control: all of them (Gisa) or the best one (The Darkness Crystal). */
  | { kind: 'reanimateExiled'; all: boolean; counters?: number; tapped?: boolean }
  /** This turn, your permanents that would be put into a graveyard from the battlefield are exiled and return at the next end step (Cosmic Intervention). */
  | { kind: 'deathShield' }
  /**
   * Return the card of the creature that just died to the battlefield under your control (Minion's Return, Luminous Broodmoth).
   * kw: with a keyword counter. subtype: only a card of this creature type (Oathkeeper). filter: only a creature without flying,
   * or one with a -1/-1 counter on it (Necroskitter).
   */
  | { kind: 'returnDied'; kw?: string; subtype?: string; filter?: 'noFlying' | 'minusCounter' }
  /**
   * Bring the source back from the graveyard (or exile) in another way: to the battlefield as a noncreature enchantment ('enchantment',
   * the Enduring cycle), tapped with stun counters ('stunned', Unstoppable Slasher), to its owner's hand at the next end step ('handAtEnd',
   * The Locust God), into its owner's library `n` cards from the top (0: the bottom; God-Eternals, Murderous Rider), or simply
   * back to the battlefield ('battlefield', Wave of Rats).
   */
  | { kind: 'returnAs'; as: 'battlefield' | 'enchantment' | 'stunned' | 'handAtEnd' | 'library'; n?: number }
  /** Static: if this card would be put into a graveyard from anywhere, it is shuffled into its owner's library instead (Nexus of Fate, Blightsteel Colossus). */
  | { kind: 'shuffleInstead' }
  /**
   * Static: triggered abilities of your permanents that match trigger an additional time (rule 603.2d): creatures of a type
   * (Harmonic Prodigy: shamans or other wizards), of the type chosen as it entered (Roaming Throne), legendary creatures
   * (Annie Joins Up), colorless permanents (Echoes of Eternity), creatures with power 2 or less (Delney).
   */
  | {
    kind: 'triggerDoubler'; subtypes?: string[]; chosenType?: boolean; legendary?: boolean; colorless?: boolean; maxPower?: number; other?: boolean;
    /** Firebender Ascension: only abilities a creature attacking sets off; each one puts a charge counter on the source, and they trigger again once it has `charged` counters. */
    attack?: boolean; charged?: number;
  }
  /** Static: whenever a creature enters under an opponent's control, its enters abilities happen for you too (Aboleth Spawn). */
  | { kind: 'copyOpponentEtb' }
  /** Put loyalty counters on this planeswalker (Kaito, Ral). */
  | { kind: 'loyaltyUp'; n: number }
  /** Double the number of each kind of counter on your permanents ('yours', Deepglow Skate) or on your best one ('best', Aetheric Amplifier). */
  | { kind: 'doubleCounters'; on: 'yours' | 'best' }
  /** Static: your Treasures tap for two mana (Goldspan Dragon). */
  | { kind: 'treasureBoost' }
  /** You win the game (Simic Ascendancy). */
  | { kind: 'winGame' }
  /** That player loses the game: the player the trigger is about (Strixhaven Stadium). */
  | { kind: 'loseGame' }
  /** Static: untap these permanents of yours during each other player's untap step too (Seedborn Muster, Unwinding Clock). */
  | { kind: 'untapAlways'; what: 'all' | 'artifacts' | 'self' }
  /**
   * Copy a spell or ability on the stack. 'spell': target instant or sorcery spell; 'trigger': the spell
   * that set off this ability ("whenever you cast ..., copy that spell"); 'ability': target ability you control.
   */
  | { kind: 'copySpell'; what: 'spell' | 'trigger' | 'ability' | 'permanentSpell' | 'creatureSpell'; /** Only spells you control. */ yours?: boolean; /** The copy isn't legendary (Double Major). */ nonlegendary?: boolean; /** "The copy targets ~" (Ivy): the copy's target is the source, and only spells that help it are copied. */ toSource?: boolean; /** "They may pay {2}. If they don't, ..." (Wandering Archaic): the caster pays when they can spare it. */ unlessPay?: number }
  /**
   * You may cast spells of this kind as though they had flash (rule 702.8): static on a permanent, or for a while
   * when it resolves ('turn': this turn, Borne Upon a Wind; 'yourNextTurn': until your next turn, Teferi, Time Raveler).
   */
  | { kind: 'flashGrant'; what: FlashFilter; until?: 'turn' | 'yourNextTurn' }
  /** Hideaway (rule 702.75): play the card exiled with the source without paying its mana cost, if your graveyard holds `graveyard` cards. */
  | { kind: 'playHidden'; graveyard?: number; /** Hideaway lands: creatures you control have total power 10+ (Mosswort Bridge), you attacked with three or more creatures this turn (Windbrisk Heights), an opponent was dealt 7+ damage this turn (Spinerock Knoll). */ cond?: 'power10' | 'attacked3' | 'damage7' }
  /** Exile a nonland card with mana value up to `maxCmc` from your hand; it becomes plotted (rule 702.170, Jace Reawakened). */
  | { kind: 'plotFromHand'; maxCmc: number }
  // --- The last rules-bending cards (see cardRulesFinal.ts) ---------------------
  /** Static: mana you would lose as a step or phase ends becomes colorless and stays (Horizon Stone, rule 106.4). */
  | { kind: 'keepMana' }
  /**
   * Static: permanents have these card types in addition to their others (rule 205.1b): every permanent (Enchanted Evening),
   * or your nonland permanents and the permanent spells you cast (Encroaching Mycosynth).
   */
  | { kind: 'addTypes'; types: ('enchantment' | 'artifact')[]; who: 'all' | 'yoursNonland' }
  /** Static: players can't get counters, and counters can't be put on artifacts, creatures, enchantments or lands (Solemnity). */
  | { kind: 'noCounters' }
  /** Tap all other artifacts; they don't untap during their controllers' untap steps for as long as the source stays tapped (Kill Switch). */
  | { kind: 'tapArtifacts' }
  /** Isochron Scepter: copy the card exiled with this and cast the copy without paying its mana cost. */
  | { kind: 'castImprinted' }
  /** Target permanent you own (even one an opponent controls) is destroyed or put on the bottom of your library (Despotic Scepter, Tel-Jilad Stylus). */
  | { kind: 'ownPerm'; to: 'destroy' | 'bottom' }
  /** Remove target attacking creature you control from combat and untap it (Reconnaissance, rule 506.4). */
  | { kind: 'removeFromCombat' }
  /** Berserker's Frenzy: roll two d20 and keep the higher; 1-14 chosen creatures block this turn if able, 15-20 you choose how creatures block. */
  | { kind: 'forceBlocks' }
  /** Static: you look at `n` more cards each time you surveil (Enhanced Surveillance). */
  | { kind: 'surveilBoost'; n: number }
  /** Shuffle your graveyard into your library (Enhanced Surveillance). */
  | { kind: 'shuffleGraveyard' }
  /** The Ozolith: keep the counters ('store': of the creature that left), or move the kept counters onto target creature you control ('release'). */
  | { kind: 'ozolith'; act: 'store' | 'release' }
  /**
   * Move +1/+1 counters onto target permanent you control: those the permanent that left had ('subject', Resourceful Defense's trigger),
   * or ones removed from another permanent you control ('yours', Resourceful Defense's activated ability, Moxite Refinery).
   */
  | { kind: 'moveCounters'; from: 'subject' | 'yours' }
  /** Knowledge Pool: each player exiles the top three cards of their library ('exile'); a spell cast from hand is exiled and swapped for one in the pool ('static'). */
  | { kind: 'knowledgePool' }
  /**
   * Text change (rule 612): replace a color word (or, with `landTypes`, a basic land type) in target permanent's text with another,
   * until end of turn or for good. The engine changes what that reads as: protection from a color and landwalk.
   */
  | { kind: 'textChange'; until: 'eot' | 'forever'; landTypes?: boolean };

/** Which spells a flash grant covers. 'creatureFirst': the first creature spell you cast each turn (The Blue Spirit). */
export type FlashFilter = 'all' | 'sorcery' | 'artifact' | 'colorless' | 'artifactOrColorless' | 'noncreature' | 'auraEquipment' | 'creatureFirst';

/**
 * Ways to cast a card other than paying its mana cost from hand, and things done with it from hand
 * (see src/engine/classifyCasting.ts). Optional additional costs (entwine, buyback, bargain, gift, cleave,
 * replicate, casualty) live in SimCard.kicker instead, since they work like kicker.
 */
export interface Casting {
  /** The card has no mana cost, so it can't be cast from hand the usual way (rule 202.1b): suspend only. */
  noCost?: boolean;
  /** Foretell (702.143): on your turn pay {2} to exile it face down; on a later turn cast it for `cost`. `effects`: what it does "if this spell was cast from exile". */
  foretell?: { cost: ManaCost; effects?: Effect[] };
  /**
   * Suspend N—cost (702.62): exile it with N time counters; one comes off each upkeep, and with the last it is cast
   * without paying its mana cost (a creature has haste). `again`: it exiles itself with that many time counters as
   * it resolves (Inspiring Refrain). `onOpponentCast`: a counter also comes off when an opponent casts a spell (Deep-Sea Kraken).
   */
  suspend?: { n: number; cost: ManaCost; again?: number; onOpponentCast?: boolean };
  /** Plot (702.170): pay this and exile it as a sorcery; cast it on a later turn as a sorcery without paying its mana cost. */
  plot?: ManaCost;
  /** Transmute (702.53): pay this and discard it, as a sorcery, to find a card with the same mana value. */
  transmute?: ManaCost;
  /** Channel: pay this and discard it from your hand for `effects`. */
  channel?: { cost: ManaCost; effects: Effect[] };
  /** Hideaway N (702.75): as it enters, look at the top N cards and exile one face down (see Effect playHidden). */
  hideaway?: number;
  /** Madness (702.35): when discarded it is exiled, and may be cast for this right away. */
  madness?: ManaCost;
  /** Miracle (702.94): when it is the first card drawn in a turn, it may be cast for this right away. */
  miracle?: ManaCost;
  /** Cipher (702.99): as it resolves, encode it on a creature you control; whenever that creature deals combat damage to a player, cast a copy. */
  cipher?: boolean;
  /** Spree (702.172) or tiered: modes with their own additional costs; choose one or more (`one`: exactly one). */
  spree?: { modes: { cost: ManaCost; effects: Effect[]; label: string }[]; one?: boolean };
  /** "If this card is in your opening hand, you may begin the game with it on the battlefield." (Leylines) */
  leyline?: boolean;
  /** "Cast ~ only ..." (rule 601.3): during combat on an opponent's turn, in the declare blockers step of an opponent's turn, or before blockers are declared. */
  timing?: 'opponentCombat' | 'opponentBlockers' | 'beforeBlockers';
  /** "You can't cast ~ during your first, second, or third turns of the game." */
  fromTurn?: number;
  /** Flashback paid by sacrificing this many creatures (Dread Return). */
  flashbackSac?: number;
  /** "You may cast ~ as though it had flash by tapping three untapped creatures you control with flying" (Tegwyll's Scouring). */
  flashByTapping?: number;
}


/** What a token copy or "becomes a copy" effect may copy. */
export interface CopyFilter {
  /** Card types that qualify (any of them). */
  types: ('creature' | 'artifact' | 'enchantment')[];
  /** Only permanents you control. */
  yours?: boolean;
  nonlegendary?: boolean;
  /** "Another" / "other": not the source. */
  other?: boolean;
  /** Both types at once ("artifact creature"). */
  both?: boolean;
  attacking?: boolean;
  nontoken?: boolean;
}

export type EffectKind = EffectBody['kind'];

/**
 * What a Curse does (Aura — Curse with "Enchant player", rule 303.4).
 * - gold, zombie, gainLife, draw: you get it, and so does each opponent attacking the enchanted player (Curse of Opulence, Disturbance, Vitality, Verbosity).
 * - attackerZombie: each player attacking the enchanted player may create a tapped 2/2 Zombie (Curse of Shallow Graves).
 * - thirst: damage equal to the Curses attached to them. torment: they lose n unless they sacrifice a nonland permanent or discard.
 * - surveil: you draw cards equal to the Curses attached to them. unbinding: reveal until a creature, it is yours, the rest are milled.
 * - cruel: they sacrifice a creature or planeswalker, or lose n. drain: they lose n and you gain n.
 * - burn: n damage to them. hex: a d6 of damage, then the Curse moves to another opponent at random.
 * - spite: a spite counter on the Curse; when they lose, you gain that much life and draw that many.
 * - restless: you create a 2/2 Zombie that can't block. fraying: they mill as many cards as went to their graveyard this turn.
 * - obsessionDraw: they draw n more. obsessionDiscard: they discard their hand. misfortunes: tutor another Curse onto them.
 * - shrink: their creatures get -n/-n. double: damage to them is doubled. hospitality: creatures attacking them have trample,
 *   and each one that connects exiles their top card for its controller to play.
 */
export type CurseAct = 'echoes' | 'gold' | 'zombie' | 'gainLife' | 'draw' | 'attackerZombie' | 'thirst' | 'torment' | 'surveil' | 'unbinding' | 'cruel' | 'drain' | 'burn' | 'hex' | 'spite' | 'restless' | 'fraying' | 'obsessionDraw' | 'obsessionDiscard' | 'misfortunes' | 'shrink' | 'double' | 'hospitality';

/**
 * When a Curse's ability happens. attacked: the enchanted player is attacked. theirUpkeep, theirDraw, theirEnd: steps of
 * the enchanted player's turn. yourUpkeep: its controller's upkeep. eachEnd: every end step. draws, casts, creatureEnters,
 * landEnters: things the enchanted player does. static: always on.
 */
export interface CurseAbility {
  on: 'attacked' | 'theirUpkeep' | 'theirDraw' | 'theirEnd' | 'yourUpkeep' | 'eachEnd' | 'draws' | 'casts' | 'creatureEnters' | 'landEnters' | 'static';
  act: CurseAct;
  n: number;
  /** casts: only these spells ('notFirst': every spell after their first each turn). */
  filter?: 'noncreature' | 'instantSorcery' | 'notFirst';
}

/** Which cards a recursion effect can return. */
export type RecursionWhat = 'any' | 'artifact' | 'enchantment' | 'instantSorcery' | 'land' | 'planeswalker' | 'creatureOrPlaneswalker' | 'artifactOrCreature' | 'artifactOrEnchantment' | 'permanent' | 'legendary';

/**
 * A way to use a card from your graveyard.
 * - cast: cast it from the graveyard for `cost` (escape, retrace). `exileOthers`: also exile that many other cards
 *   from your graveyard; `discardLand`: also discard a land card (retrace); `exiled`: exiled when it leaves the stack (escape spells).
 * - return: pay `cost` to put it onto the battlefield (unearth, Reassembling Skeleton) or into your hand.
 *   `haste` and `exileAtEnd`: unearth; `token`: a token copy is made and the card is exiled (embalm, eternalize, encore).
 *   `sorcery`: only as a sorcery; `sacCreature`: sacrifice a creature too.
 */
export interface GraveyardUse {
  how: 'cast' | 'return';
  cost: ManaCost;
  label: string;
  exileOthers?: number;
  discardLand?: boolean;
  exiled?: boolean;
  to?: 'battlefield' | 'hand';
  tapped?: boolean;
  haste?: boolean;
  exileAtEnd?: boolean;
  token?: boolean;
  sorcery?: boolean;
  sacCreature?: boolean;
  /** Token copies made with eternalize are 4/4. */
  size?: number;
}

export interface LandInfo {
  produces: Mana[] | 'any';
  tapped: boolean;
}

export interface SimCard {
  name: string;
  cost: ManaCost;
  cmc: number;
  typeLine: string;
  isLand: boolean;
  isCreature: boolean;
  isArtifact: boolean;
  isEnchantment: boolean;
  isPlaneswalker: boolean;
  isInstant: boolean;
  isSorcery: boolean;
  isLegendary: boolean;
  isBasic: boolean;
  power: number;
  toughness: number;
  keywords: string[];
  effects: Effect[];
  land?: LandInfo;
  /** X-cost creature that enters with X +1/+1 counters (Hangarback Walker, Stonecoil Serpent). */
  entersWithX?: boolean;
  /** Planeswalkers: loyalty counters it enters with. */
  loyalty?: number;
  /** Doesn't untap during its controller's untap step (Basalt Monolith, Mana Vault). */
  noUntap?: boolean;
  /** Free to cast while you control a commander (Fierce Guardianship, Deadly Rollick). */
  freeWithCommander?: boolean;
  /** Cycling: pay this and discard the card to draw one (`land` searches for a land instead). */
  cycling?: { cost: ManaCost; land?: boolean; /** "When you cycle ~" (Fractured Sanity). */ effects?: Effect[] };
  /** Cumulative upkeep (rule 702.24): each upkeep it gets an age counter, then you pay this cost once per counter or sacrifice it. */
  cumulativeUpkeep?: ManaCost;
  /** Vanishing N (rule 702.63): enters with N time counters, loses one each upkeep, sacrificed when the last is removed. */
  vanishing?: number;
  /** Toxic N (rule 702.164): combat damage to a player also gives that many poison counters. */
  toxic?: number;
  /** "As ~ enters, choose a creature type" (see Perm.chosenType). */
  choosesType?: boolean;
  /** Overload: for this cost the spell hits everything it could target instead of one target. */
  overload?: { cost: ManaCost; effects: Effect[] };
  /** Storm: copied for each spell cast before it this turn. */
  storm?: boolean;
  /** Cascade (rule 702.85): how many times; each exiles cards until a cheaper nonland card and casts it free. */
  cascade?: number;
  /** Power (and toughness, if `toughness`) equal to a count, e.g. cards in your hand. */
  scales?: {
    by: 'hand' | 'graveyard' | 'oppGraveyards' | 'oneGraveyard' | 'allGraveyardCreatures' | 'spellsInGraveyard' | 'artifacts' | 'creatures' | 'lands'
      // See classifyCounting.ts: "gets +1/+1 for each ..." and other counts.
      | 'enchantments' | 'drawnThisTurn' | 'oppExile' | 'colors' | 'experience' | 'graveyardCreatures' | 'party' | 'oppGraveyardTypes' | 'subtype';
    toughness: boolean;
    /** by 'subtype': the creature type counted ("for each other Rat you control"). */
    subtype?: string;
    /** Not counting itself ("each other Rat"). */
    other?: boolean;
  };
  /** Vehicle: tap creatures with this much total power to make it a creature until end of turn. */
  crew?: number;
  /** Enters tapped with this many stun counters (each one stops an untap). */
  stun?: number;
  /** Flashback: may be cast from the graveyard for this cost, then exiled. */
  flashback?: ManaCost;
  /** Other ways to use the card from the graveyard: escape, retrace, unearth, embalm, "{1}{B}: return ~ from your graveyard". */
  graveyard?: GraveyardUse;
  /** Persist (returns with a -1/-1 counter) or undying (with a +1/+1 counter) when it dies without one. */
  persist?: 'persist' | 'undying';
  /** "As an additional cost to cast this spell": sacrifice a permanent of this kind and/or discard cards. */
  extraCost?: { sacrifice?: 'creature' | 'artifact' | 'artifactOrCreature'; discard?: number; either?: boolean };
  /** Saga: the last chapter. It is sacrificed once that chapter has resolved (rule 714.4). */
  saga?: number;
  /** Class: the cost of each level after the first and the abilities it adds (rule 716). */
  levels?: { level: number; cost: ManaCost; effects: Effect[] }[];
  /**
   * An alternative cost (rule 118.9): cast it by paying this instead of its mana cost.
   * evoke: sacrificed when it enters. dash: gains haste and returns to hand at end of turn.
   */
  altCost?: {
    mana: ManaCost;
    life?: number;
    /** Exile a card of this color from your hand (Force of Will). */
    pitch?: Color;
    /** Return this many Islands you control to their owner's hand (Daze, Gush). */
    returnIslands?: number;
    /** Only if it isn't your turn (Force of Negation). */
    notYourTurn?: boolean;
    /** Only if an opponent cast this many spells this turn (Mindbreak Trap). */
    opponentSpells?: number;
    /** Only if there are this many creatures on the battlefield (Blasphemous Edict). */
    creatures?: number;
    evoke?: boolean;
    dash?: boolean;
    /** Warp (702.185): exiled at the next end step, then castable from exile on a later turn. */
    warp?: boolean;
    /** Blitz (702.152): haste and "when this dies, draw a card"; sacrificed at the next end step. */
    blitz?: boolean;
    /** Impending N (702.176): enters with N time counters and isn't a creature until the last is removed. */
    impending?: number;
    /** Prowl (702.76): only if a Rogue of yours dealt combat damage to a player this turn. */
    prowl?: boolean;
    /** Emerge (702.119): sacrifice a creature (or an artifact), and the cost is reduced by its mana value. */
    emerge?: 'creature' | 'artifact';
    /** What the spell does when cast this way, when that differs (prowl: "if this spell's prowl cost was paid"). */
    effects?: Effect[];
  };
  /** Alternative casting keywords and things done from hand (foretell, suspend, plot, transmute, spree ...). */
  casting?: Casting;
  /**
   * Station (rule 702.184): tap another creature you control to put charge counters equal to its power on this,
   * as a sorcery. Each tier's abilities and keywords apply from `n` charge counters on; a Spacecraft becomes an
   * artifact creature with the card's power and toughness at `creatureAt`.
   */
  station?: { tiers: { n: number; keywords: string[]; effects: Effect[] }[]; creatureAt?: number };
  /** What this card's charge counters are really called (quest, oil, loot ...), for the log. */
  counterName?: string;
  /** Enters with this many charge counters (-1: X; sunburst: one for each color of mana spent, rule 702.44). */
  charge?: number;
  /** Sunburst (rule 702.44): a creature gets +1/+1 counters, anything else charge counters, one for each color spent. */
  sunburst?: boolean;
  /** A Curse: an Aura with "Enchant player" (rule 303.4) and what it does to that player. */
  curse?: CurseAbility[];
  /** A nonland permanent that enters tapped. */
  entersTapped?: boolean;
  /** X is paid in life instead of mana (Toxic Deluge). */
  xFromLife?: boolean;
  /** Costs {amount} less for each of something (affinity, improvise, convoke, "for each creature on the battlefield"). */
  discount?: {
    per: 'artifacts' | 'creatures' | 'allCreatures' | 'graveyardCreatures' | 'graveyard'
      // See classifyCounting.ts.
      | 'tokens' | 'subtype' | 'party' | 'graveyardTypes' | 'spellsInGraveyard' | 'diedThisTurn' | 'energyPaid' | 'bigCreature' | 'poisoned' | 'legendaryTarget' | 'attackingTarget'
      // "Where X is the greatest number of artifacts an opponent controls" (Cavern-Hoard Dragon), "the total mana value of historic permanents you control" (Excalibur).
      | 'opponentArtifacts' | 'historicValue';
    amount: number;
    /** per 'subtype': the creature type ("affinity for Humans", "if you control a Wizard"). */
    subtype?: string;
    /** "Costs {2} less if ...": the discount once, when the count is at least one. */
    once?: boolean;
  };
  /** Cast from somewhere other than a hand or the command zone (set on the priced copy, for "spells you cast from your graveyard cost less"). */
  castZone?: 'graveyard' | 'exile';
  /**
   * Kicker, multikicker or offspring (rules 702.33, 702.175): an optional additional cost. `effects` is what the card
   * does when it was paid (its `effects` are the unkicked version). Multikicker may be paid any number of times.
   */
  kicker?: {
    cost: ManaCost; multi?: boolean; offspring?: boolean; effects: Effect[]; /** Enters with a charge counter for each time it was kicked (Everflowing Chalice). */ charge?: boolean;
    /**
     * Other optional costs that work like kicker (see classifyCasting.ts): entwine (702.42, all modes), buyback (702.27, back
     * to hand), bargain (702.166, sacrifice an artifact, enchantment or token), gift (702.174, an opponent gets `gift`),
     * cleave (702.148, `cost` replaces the mana cost), replicate (702.56, a copy per payment), casualty (702.153, sacrifice a
     * creature with power `casualty` or more for a copy).
     */
    as?: 'entwine' | 'buyback' | 'bargain' | 'gift' | 'cleave' | 'replicate' | 'casualty';
    gift?: 'card' | 'fish' | 'extraTurn' | 'food' | 'treasure' | 'octopus';
    casualty?: number;
  };
  /** Mutate (rule 702.140): cast for this cost onto a non-Human creature you own, merging with it. */
  mutate?: { cost: ManaCost; /** Brokkos: may also be cast this way from the graveyard. */ fromGraveyard?: boolean };
  /** Morph, megamorph or disguise (rules 702.37, 702.168): may be cast face down as a 2/2 for {3}, then turned face up for this cost. */
  /** Ninjutsu (rule 702.49): return an unblocked attacker you control to hand to put this onto the battlefield tapped and attacking. `commander`: also from the command zone. */
  ninjutsu?: { cost: ManaCost; commander?: boolean };
  morph?: { cost: ManaCost; /** Megamorph: a +1/+1 counter when turned face up. */ counter?: boolean; /** Disguise: the face-down creature has ward {2}. */ ward?: boolean };
  /**
   * Room (rule 709.5): a split enchantment whose doors unlock separately. The card itself is the door cast
   * (its effects, cost and name); `door` is the other, locked door, unlocked as a sorcery for its mana cost.
   */
  room?: { door: SimCard };
  /** Transforming double-faced card: its back face (rule 712). */
  back?: SimCard;
  /** Modal double-faced card whose back is a land. */
  backLand?: LandInfo & { name: string };
  /** Rough "how good is this card" score used by the AI. */
  value: number;
  /** True if we recognised at least one thing the card does (or it's a vanilla body/land). */
  modeled: boolean;
  /** Human-readable interpretation, shown on the deck page. */
  notes: string[];
  /** Lines of rules text the classifier found nothing in (lower case, card name as ~). */
  unread?: string[];
  /** The card has its own rule (src/engine/cardRules.ts): why it is played the way it is. */
  ruled?: string;
  imageUrl?: string;
  /** "A deck can have any number of (up to N) cards named ~" (rule 903.5b): 999 for any number. */
  copyLimit?: number;
  /** May be a commander (rule 903.3): a legendary creature, Vehicle or Spacecraft with P/T, a Background, or "~ can be your commander". */
  canCommand?: boolean;
  /** How this commander can share the command zone with another (rule 702.124): partner, partner with, friends forever, Backgrounds, the Doctor. */
  pairing?: 'partner' | 'friendsForever' | 'chooseBackground' | 'background' | 'doctorsCompanion' | 'doctor' | { with: string } | { group: string };
}

export interface DeckEntry {
  card: SimCard;
  count: number;
}

export interface SimDeck {
  id: string;
  name: string;
  source: 'archidekt' | 'text';
  url?: string;
  commanders: SimCard[];
  cards: DeckEntry[];
  colorIdentity: Color[];
  importedAt: number;
  /** Bracket the owner set on Archidekt (1–5), if any. */
  archidektBracket?: number | null;
  /** When the deck was last changed on Archidekt (ms), for syncing. */
  archidektUpdatedAt?: number;
  /** Where the deck breaks the Commander deck rules (100 cards, singleton, color identity, commanders), found at import. */
  issues?: string[];
}

export type LossReason = 'combat' | 'commander' | 'noncombat' | 'decked' | 'timeout';

export interface Elimination {
  seat: number;
  round: number;
  reason: LossReason;
  /** Seat of the player that dealt the finishing blow, if any. */
  killer: number | null;
}

export interface GameResult {
  /** Deck id per seat, in turn order. */
  seats: string[];
  /** Seat index of the winner, or null for a draw (turn limit). */
  winner: number | null;
  /** Finishing place per seat: 1 = winner. Timeouts share the best open place. */
  placements: number[];
  rounds: number;
  eliminations: Elimination[];
  /** Round each seat first cast its commander, or null. */
  commanderRound: (number | null)[];
  /** Mulligans taken per seat. */
  mulligans: number[];
  /** Per-seat card usage, for per-card performance. */
  cards?: SeatCards[];
}

export interface SeatCards {
  /**
   * The opening hand plus the next few library cards, fixed by the shuffle
   * before any decisions. Whether a card is here is pure luck and doesn't
   * depend on how long you survive, which makes it a fair basis for
   * comparing games with and without the card. Empty for Forge games.
   */
  early: string[];
  /** Cards actually drawn (opening hand and draws). Empty for Forge games. */
  drawn: string[];
  /** Cards cast or played. */
  cast: string[];
}
