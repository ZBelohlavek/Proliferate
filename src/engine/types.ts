// Shared data model for decks, cards, and game results.
//
// A "SimCard" is our simplified understanding of a Magic card: its cost,
// its body (if it is a creature), and a list of Effects we recognised in its
// oracle text. Anything we couldn't recognise is simply ignored by the game
// engine, and `modeled` records whether we understood the card at all.

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
  | 'countersPut' // one or more +1/+1 counters are put on this permanent (scope 'self') or a creature you control ('any'); x = how many
  | 'leaves' // this permanent ('self') or a token you control ('any', with nontoken false) leaves the battlefield (see Effect.zones); x = its power
  | 'opponentActivate' // an opponent activates an ability of a permanent that isn't a mana ability
  | 'playerAttacks' // a player attacks: 'all' any player, 'opponents' an opponent attacks one of your other opponents (see minAttackers)
  | 'playerSacrifice' // a player ('all') or an opponent ('opponents') sacrifices a permanent (castFilter 'noncreature': only a Treasure or other noncreature token)
  | 'opponentCrime' // an opponent commits a crime: targets a player other than themselves, or a permanent or spell another player controls (rule 700.13)
  | 'static'; // always on while the permanent is on the battlefield

/** Which creature a creature-based trigger watches. */
/** 'attached': the creature this Equipment or Aura is on. 'all': creatures of every player. 'opponents': only opponents' creatures. */
export type TriggerScope = 'self' | 'any' | 'oneOrMore' | 'attached' | 'all' | 'opponents';

export type CastFilter = 'any' | 'noncreature' | 'instantSorcery' | 'creature' | 'artifact' | 'enchantment' | 'mutate';

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
  /** Saga chapter abilities: the chapters (lore counts) this ability triggers on. */
  chapters?: number[];
  /** Creature-enters triggers that only watch nontoken creatures. */
  nontoken?: boolean;
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
  };
};

export type EffectBody =
  | { kind: 'ramp'; lands: number; toHand: number; tapped: boolean }
  /**
   * energy: each use also costs this many energy counters (Solar Transformer).
   * charge: the amount is the source's charge counters ('tap': Astral Cornucopia; 'grow': a counter is added first,
   * Empowered Autogenerator) or each counter can be removed for one mana without tapping ('spend': Pentad Prism).
   */
  | { kind: 'mana'; amount: number; colors: Mana[] | 'any'; energy?: number; charge?: 'tap' | 'grow' | 'spend'; /** A land that taps for one mana for each artifact you control, less one it costs (Uthros, Titanic Godcore). */ perArtifact?: boolean }
  | { kind: 'costReduction'; amount: number; filter: CastFilter }
  /** ritual: mana from a spell or a sacrificed creature, not Treasure tokens, so token doublers don't touch it. */
  | { kind: 'treasure'; n: number; ritual?: boolean; /** One mana for each charge counter on the source (Black Market). */ byCharge?: boolean }
  | { kind: 'extraLand' }
  | { kind: 'draw'; n: number }
  /** Exchange life totals with the opponent highest on life, only when that gains you life, so the "draw what you lost" rider never applies (Mister Negative). */
  | { kind: 'exchangeLife' }
  /** anyTarget: damage that can also be aimed at a player ("any target"). */
  /** each: an edict that hits every opponent, or every player, instead of one target. */
  /** shrink: a 'damage' effect that is really -N/-N until end of turn ('temp') or -1/-1 counters ('counters'), which indestructible doesn't stop. */
  /** replace: a destroyed land's controller may search for a basic land to put onto the battlefield (Ghost Quarter). */
  /** energyPaid: "then you may pay any amount of {E}; it deals that much damage" (Galvanic Discharge): the damage is energy paid, and `amount` is what the spell itself gives. */
  | { kind: 'removal'; target: RemovalTarget; mode: RemovalMode; amount: number; /** Only a creature with a bounty counter on it (Bounty Hunter). */ bountyOnly?: boolean; anyTarget?: boolean; each?: 'opponents' | 'all'; shrink?: 'temp' | 'counters'; replace?: boolean; energyPaid?: boolean }
  | { kind: 'wipe'; target: 'creatures' | 'nonland' | 'artifacts'; mode: RemovalMode; amount: number; oneSided: boolean; shrink?: 'temp' | 'counters'; /** Wrath of the Skies: only mana value up to the energy paid (all of it). */ byEnergy?: boolean }
  /** cmc: only spells with this mana value (Mental Misstep). refund: you get one-shot mana equal to the countered spell's mana value (Mana Drain). */
  | { kind: 'counter'; target: 'any' | 'noncreature' | 'creature'; cmc?: number; refund?: boolean }
  /** fragile: the token has "when this token becomes the target of a spell, sacrifice it" (Jace's Illusions). */
  | { kind: 'tokens'; n: number; power: number; toughness: number; keywords: string[]; /** Amass: grow the one Army you control instead of making another (rule 701.47). */ army?: boolean; fragile?: 'spell' | 'any' }
  /**
   * Create token copies of the source permanent (Skyclave Relic, Jace, Mirror Mage; offspring makes a 1/1 one).
   * size: the copy's power and toughness. loyalty: its starting loyalty.
   */
  | { kind: 'copySelf'; n: number; tapped?: boolean; nonlegendary?: boolean; loyalty?: number; size?: number }
  /** Shuffle the source into its owner's library (Fblthp, the Lost). */
  | { kind: 'shuffleSelf' }
  /** Sacrifice the source (Phantasmal Image's "when this becomes the target ..."). */
  | { kind: 'sacrificeSelf' }
  /** Reveal the top card of your library: a land goes onto the battlefield, anything else into your hand (Nadu). */
  | { kind: 'revealTop' }
  /** Put this many hour counters on the source; the twelfth sets off its 'hourTwelve' abilities (Midnight Clock). */
  | { kind: 'hours'; n: number }
  /** Shuffle your hand (and graveyard) into your library, then draw n. exileSelf: then exile the source. */
  | { kind: 'wheel'; n: number; graveyard: boolean; exileSelf?: boolean }
  /** keywords: "creatures you control have lifelink". */
  | { kind: 'anthem'; p: number; t: number; keywords?: string[]; /** Only creatures with power or toughness 1 or less (Tetsuko). */ small?: boolean; /** Only enchantment creatures, or only creatures you control but don't own (Garland). */ only?: 'enchantment' | 'artifact' | 'stolen'; /** "Other creatures you control": not the source itself. */ other?: boolean; /** "+1/+1 for each blessing counter on ~": times the source's charge counters (Boon of the Spirit Realm). */ perCharge?: boolean }
  /** scale: what X counts when the bonus is "+X/+X, where X is ...". */
  | { kind: 'overrun'; p: number; t: number; trample: boolean; scale?: 'creatures' | 'power'; /** Keywords the team gains this turn. */ grant?: string[] }
  /** grant: keywords the creature gains until end of turn ("can't be blocked this turn" is 'unblockable'). */
  /** self: the source itself ("~ gains haste until end of turn"), no target. */
  | { kind: 'pump'; p: number; t: number; protect: boolean; grant?: string[]; self?: boolean }
  /** cost: the equip cost of an Equipment, when the text gives one. */
  | { kind: 'equip'; p: number; t: number; keywords: string[]; aura: boolean; cost?: ManaCost; /** Control Magic: you control the enchanted creature. */ steal?: boolean; /** The enchanted permanent loses all abilities: a vanilla creature of `lockSize` (Amphibian Downpour) or a land that taps for {C} (Imprisoned in the Moon). */ lock?: 'blank' | 'land'; lockSize?: { p: number; t: number } }
  /** all: every permanent you control. player: you can't lose life either, until your next turn. */
  | { kind: 'protect'; all?: boolean; player?: boolean }
  /** gain: life you gain afterwards; -1 = equal to the total life lost. */
  /** devotion: n is your devotion to this color instead (Gray Merchant). */
  | { kind: 'drain'; n: number; gain: number; devotion?: Color; /** Only opponents with no cards in hand (Tinybones). */ emptyHand?: boolean; /** "Deals N damage to each opponent": damage, so Torbran and prevention apply. */ damage?: boolean }
  /** lifeLoss: the player loses life rather than being dealt damage ("that player loses 2 life"), so damage rules don't touch it. */
  | { kind: 'damagePlayer'; n: number; lifeLoss?: boolean }
  | { kind: 'gainLife'; n: number }
  /** A drawback: you lose this much life (Bitterblossom, Dark Confidant). */
  | { kind: 'loseLife'; n: number }
  /** creatureToBattlefield: finds a creature and puts it straight onto the battlefield. */
  | { kind: 'tutor'; creatureToBattlefield?: boolean; /** Only creatures with mana value X or less. */ xLimit?: boolean }
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
  | { kind: 'returnSelf'; counters: number }
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
  | { kind: 'attackTax'; amount: number }
  /** Each player can't cast more than one spell each turn. */
  | { kind: 'spellLimit' }
  /** Spells cost more: your opponents' (or everyone's, with `all`), optionally only noncreature spells. */
  | { kind: 'spellTax'; amount: number; filter: 'any' | 'noncreature'; all?: boolean }
  /** Ankh of Mishra, Zo-Zu: a land entering costs its controller life. */
  | { kind: 'landPunish'; n: number }
  /** Creatures deal combat damage with toughness (Doran); `defenders`: only those with defender, which may also attack (Arcades). */
  | { kind: 'toughnessMatters'; defenders: boolean; /** Only your creatures. */ yours?: boolean }
  /** Reveal from the top of your library until a nonland permanent card, and put it onto the battlefield. */
  | { kind: 'digPermanent' }
  /** Opponents can't cast their commanders from the command zone. */
  | { kind: 'commandLock' }
  /** Cards that would go to a graveyard are exiled instead (only your opponents' cards, with `opponents`: Dauthi Voidwalker). */
  | { kind: 'graveyardHate'; opponents?: boolean }
  /** Exile graveyards: every opponent's, or everyone's. `cards`: only that many cards, the best ones in opponents' graveyards. */
  | { kind: 'exileGraveyards'; all: boolean; cards?: number }
  /** Enters as a copy of a creature on the battlefield: any, only yours (Spark Double) or only an opponent's (Imposter Mech). */
  | { kind: 'clone'; from?: 'yours' | 'opponents'; /** "It isn't legendary." */ nonlegendary?: boolean; /** "Enters with an additional +1/+1 counter." */ extraCounter?: boolean; /** Phantasmal Image: "when this becomes the target of a spell or ability, sacrifice it". */ fragile?: boolean }
  /** Take a creature: one on the battlefield, or the best in an opponent's library. */
  /** whileSource: only "for as long as you control ~" (Sower of Temptation): the creature goes back when the source leaves. */
  /** what: an artifact instead of a creature (Thieving Skydiver; an Equipment is then attached to the source). maxCmc: only mana value up to this; -1 = X. */
  /** payEnergy: Confiscation Coup gives this much energy, then the steal costs energy equal to the target's mana value. */
  | { kind: 'steal'; from: 'battlefield' | 'library'; whileSource?: boolean; payEnergy?: number; what?: 'artifact'; maxCmc?: number }
  /** Put a creature card from your hand onto the battlefield. */
  | { kind: 'cheat' }
  | { kind: 'extraTurn' }
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
  | { kind: 'stun'; /** Tap it first (Fear of Sleep Paralysis). */ tap?: boolean; /** Only a tapped creature (Cryogen Relic). */ tapped?: boolean }
  /** Mathas: a bounty counter on an opponent's creature; when it dies, its controller's opponents each draw 1 and gain 2. */
  | { kind: 'bounty'; /** Only the counter: the creature doesn't get Mathas's "when this dies, each opponent draws and gains 2". */ plain?: boolean; /** Any creature, not only an opponent's (Bounty Board). */ any?: boolean }
  /** Static: whenever a creature with a bounty counter dies, each of its controller's opponents draws and gains 2 (Bounty Board), or this gets `n` +1/+1 counters (Shay Cormac). */
  | { kind: 'bountyPayout'; what: 'drawGain' | 'counters'; n: number }
  /** Static: an opponent's creature that becomes the target of your spell or ability gets a bounty counter (Shay Cormac). */
  | { kind: 'bountyOnTarget' }
  /** Players get poison counters (rule 122.1f): each opponent, each player, or one target player. */
  | { kind: 'poison'; n: number; who: 'opponents' | 'each' | 'target' }
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
  | { kind: 'enterCounters'; n: number }
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
  | { kind: 'landSac'; n: number; who: 'each' | 'opponents'; keep?: number }
  /** Damage to each player for each nonbasic land they control (Price of Progress: 2, Sunspine Lynx: 1). */
  | { kind: 'nonbasicBurn'; per: number }
  /** Dingus Egg: whenever a land goes to a graveyard from the battlefield, its controller takes this much damage. */
  | { kind: 'landDiesPunish'; n: number }
  /**
   * Prevent combat damage this turn (rule 615): all of it ('all', Fog), the damage dealt to you ('you', Inkshield,
   * which makes a 2/1 flyer for each 1 prevented: `tokens`), or the damage dealt to and by one target attacking creature ('creature', Maze of Ith).
   */
  | { kind: 'fog'; who: 'all' | 'you' | 'creature'; tokens?: boolean; untap?: boolean; /** Return the creatures attacking you to their owners' hands instead (Aetherize). */ bounce?: boolean }
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
  | { kind: 'goad'; all: boolean; weaker?: boolean }
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
  | { kind: 'copySpell'; what: 'spell' | 'trigger' | 'ability'; /** Only spells you control. */ yours?: boolean };

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
export type CurseAct = 'gold' | 'zombie' | 'gainLife' | 'draw' | 'attackerZombie' | 'thirst' | 'torment' | 'surveil' | 'unbinding' | 'cruel' | 'drain' | 'burn' | 'hex' | 'spite' | 'restless' | 'fraying' | 'obsessionDraw' | 'obsessionDiscard' | 'misfortunes' | 'shrink' | 'double' | 'hospitality';

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
  cycling?: { cost: ManaCost; land?: boolean };
  /** Cumulative upkeep (rule 702.24): each upkeep it gets an age counter, then you pay this cost once per counter or sacrifice it. */
  cumulativeUpkeep?: ManaCost;
  /** Toxic N (rule 702.164): combat damage to a player also gives that many poison counters. */
  toxic?: number;
  /** Overload: for this cost the spell hits everything it could target instead of one target. */
  overload?: { cost: ManaCost; effects: Effect[] };
  /** Storm: copied for each spell cast before it this turn. */
  storm?: boolean;
  /** Power (and toughness, if `toughness`) equal to a count, e.g. cards in your hand. */
  scales?: { by: 'hand' | 'graveyard' | 'oppGraveyards' | 'oneGraveyard' | 'allGraveyardCreatures' | 'spellsInGraveyard' | 'artifacts' | 'creatures' | 'lands'; toughness: boolean };
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
  };
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
  discount?: { per: 'artifacts' | 'creatures' | 'allCreatures' | 'graveyardCreatures' | 'graveyard'; amount: number };
  /**
   * Kicker, multikicker or offspring (rules 702.33, 702.175): an optional additional cost. `effects` is what the card
   * does when it was paid (its `effects` are the unkicked version). Multikicker may be paid any number of times.
   */
  kicker?: { cost: ManaCost; multi?: boolean; offspring?: boolean; effects: Effect[]; /** Enters with a charge counter for each time it was kicked (Everflowing Chalice). */ charge?: boolean };
  /** Mutate (rule 702.140): cast for this cost onto a non-Human creature you own, merging with it. */
  mutate?: { cost: ManaCost; /** Brokkos: may also be cast this way from the graveyard. */ fromGraveyard?: boolean };
  /** Morph, megamorph or disguise (rules 702.37, 702.168): may be cast face down as a 2/2 for {3}, then turned face up for this cost. */
  /** Ninjutsu (rule 702.49): return an unblocked attacker you control to hand to put this onto the battlefield tapped and attacking. `commander`: also from the command zone. */
  ninjutsu?: { cost: ManaCost; commander?: boolean };
  morph?: { cost: ManaCost; /** Megamorph: a +1/+1 counter when turned face up. */ counter?: boolean; /** Disguise: the face-down creature has ward {2}. */ ward?: boolean };
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
