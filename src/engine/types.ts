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
  | 'sacrifice' // you sacrifice a permanent
  | 'draw' // you draw a card
  | 'permEnters' // an artifact or enchantment enters under your control (see castFilter)
  | 'gainLife' // you gain life
  | 'activated' // activated ability, paid for with spare mana
  | 'loyalty' // planeswalker loyalty ability (see Effect.loyalty)
  | 'mutates' // a mutating creature spell merges with this creature (scope 'self') or one you control ('any')
  | 'turnedFaceUp' // this face-down permanent is turned face up
  | 'static'; // always on while the permanent is on the battlefield

/** Which creature a creature-based trigger watches. */
/** 'attached': the creature this Equipment or Aura is on. 'all': creatures of every player. */
export type TriggerScope = 'self' | 'any' | 'oneOrMore' | 'attached' | 'all';

export type CastFilter = 'any' | 'noncreature' | 'instantSorcery' | 'creature' | 'artifact' | 'enchantment' | 'mutate';

export type RemovalTarget = 'creature' | 'permanent' | 'noncreature' | 'artifactEnchantment' | 'planeswalker';
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
  /** Creature-enters triggers that only watch nontoken creatures. */
  nontoken?: boolean;
  /** "Do this only once each turn." */
  oncePerTurn?: boolean;
  /** Cast triggers: only on the caster's first, second, ... spell of the turn ("their second spell each turn"). */
  nth?: number;
  /** Cast triggers: only during the caster's own turn, or only during someone else's ("during each opponent's turn"). */
  turn?: 'own' | 'others';
  /** Dies triggers: "this creature or another creature" also triggers on its own death. */
  selfToo?: boolean;
  /** For activated abilities: the mana cost and whether it taps the source. */
  activation?: { cost: ManaCost; tap: boolean; sacrifice: boolean; /** "Sacrifice a creature" as part of the cost. */ sacCreature?: boolean };
};

export type EffectBody =
  | { kind: 'ramp'; lands: number; toHand: number; tapped: boolean }
  | { kind: 'mana'; amount: number; colors: Mana[] | 'any' }
  | { kind: 'costReduction'; amount: number; filter: CastFilter }
  /** ritual: mana from a spell or a sacrificed creature, not Treasure tokens, so token doublers don't touch it. */
  | { kind: 'treasure'; n: number; ritual?: boolean }
  | { kind: 'extraLand' }
  | { kind: 'draw'; n: number }
  /** anyTarget: damage that can also be aimed at a player ("any target"). */
  /** each: an edict that hits every opponent, or every player, instead of one target. */
  /** shrink: a 'damage' effect that is really -N/-N until end of turn ('temp') or -1/-1 counters ('counters'), which indestructible doesn't stop. */
  | { kind: 'removal'; target: RemovalTarget; mode: RemovalMode; amount: number; anyTarget?: boolean; each?: 'opponents' | 'all'; shrink?: 'temp' | 'counters' }
  | { kind: 'wipe'; target: 'creatures' | 'nonland' | 'artifacts'; mode: RemovalMode; amount: number; oneSided: boolean; shrink?: 'temp' | 'counters' }
  | { kind: 'counter'; target: 'any' | 'noncreature' | 'creature' }
  | { kind: 'tokens'; n: number; power: number; toughness: number; keywords: string[] }
  /** keywords: "creatures you control have lifelink". */
  | { kind: 'anthem'; p: number; t: number; keywords?: string[]; /** Only creatures with power or toughness 1 or less (Tetsuko). */ small?: boolean; /** "Other creatures you control": not the source itself. */ other?: boolean }
  /** scale: what X counts when the bonus is "+X/+X, where X is ...". */
  | { kind: 'overrun'; p: number; t: number; trample: boolean; scale?: 'creatures' | 'power'; /** Keywords the team gains this turn. */ grant?: string[] }
  /** grant: keywords the creature gains until end of turn ("can't be blocked this turn" is 'unblockable'). */
  | { kind: 'pump'; p: number; t: number; protect: boolean; grant?: string[] }
  /** cost: the equip cost of an Equipment, when the text gives one. */
  | { kind: 'equip'; p: number; t: number; keywords: string[]; aura: boolean; cost?: ManaCost; /** Control Magic: you control the enchanted creature. */ steal?: boolean }
  /** all: every permanent you control. player: you can't lose life either, until your next turn. */
  | { kind: 'protect'; all?: boolean; player?: boolean }
  /** gain: life you gain afterwards; -1 = equal to the total life lost. */
  | { kind: 'drain'; n: number; gain: number }
  | { kind: 'damagePlayer'; n: number }
  | { kind: 'gainLife'; n: number }
  /** A drawback: you lose this much life (Bitterblossom, Dark Confidant). */
  | { kind: 'loseLife'; n: number }
  /** creatureToBattlefield: finds a creature and puts it straight onto the battlefield. */
  | { kind: 'tutor'; creatureToBattlefield?: boolean; /** Only creatures with mana value X or less. */ xLimit?: boolean }
  /** what: which cards it can return (default creatures). toTop: onto the library instead of into the hand. */
  | { kind: 'recursion'; n: number; toBattlefield: boolean; what?: 'any' | 'artifact' | 'enchantment' | 'instantSorcery'; toTop?: boolean }
  /** proliferate: only creatures that already have a counter. */
  | { kind: 'counters'; n: number; all: boolean; proliferate?: boolean }
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
  /** Cards that would go to a graveyard are exiled instead. */
  | { kind: 'graveyardHate' }
  /** Exile graveyards: every opponent's, or everyone's. */
  | { kind: 'exileGraveyards'; all: boolean }
  /** Enters as a copy of a creature on the battlefield: any, only yours (Spark Double) or only an opponent's (Imposter Mech). */
  | { kind: 'clone'; from?: 'yours' | 'opponents'; /** "It isn't legendary." */ nonlegendary?: boolean; /** "Enters with an additional +1/+1 counter." */ extraCounter?: boolean }
  /** Take a creature: one on the battlefield, or the best in an opponent's library. */
  /** whileSource: only "for as long as you control ~" (Sower of Temptation): the creature goes back when the source leaves. */
  | { kind: 'steal'; from: 'battlefield' | 'library'; whileSource?: boolean }
  /** Put a creature card from your hand onto the battlefield. */
  | { kind: 'cheat' }
  | { kind: 'extraTurn' }
  /** Look at the top n cards and keep or bin each. Surveil puts the rest in the graveyard, scry on the bottom. */
  | { kind: 'scry'; n: number; surveil: boolean }
  /** Put cards from the top of a library into the graveyard. n: -1 = X, -2 = half the library. */
  | { kind: 'mill'; n: number; who: 'target' | 'opponents' | 'all' | 'you' }
  | { kind: 'discard'; n: number; who: 'target' | 'opponents' }
  /** You have no maximum hand size. */
  | { kind: 'noMaxHand' }
  /** Laboratory Maniac: drawing from an empty library wins the game instead. */
  | { kind: 'winOnEmptyDraw' }
  /** You become the monarch: draw a card at each of your end steps until someone takes it by combat damage. */
  | { kind: 'monarch' }
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
  | { kind: 'approach' };

export type EffectKind = EffectBody['kind'];

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
  /** "As an additional cost to cast this spell": sacrifice a permanent of this kind and/or discard cards. */
  extraCost?: { sacrifice?: 'creature' | 'artifact' | 'artifactOrCreature'; discard?: number; either?: boolean };
  /** A nonland permanent that enters tapped. */
  entersTapped?: boolean;
  /** X is paid in life instead of mana (Toxic Deluge). */
  xFromLife?: boolean;
  /** Costs {amount} less for each of something (affinity, improvise, convoke, "for each creature on the battlefield"). */
  discount?: { per: 'artifacts' | 'creatures' | 'allCreatures' | 'graveyardCreatures' | 'graveyard'; amount: number };
  /** Mutate (rule 702.140): cast for this cost onto a non-Human creature you own, merging with it. */
  mutate?: { cost: ManaCost; /** Brokkos: may also be cast this way from the graveyard. */ fromGraveyard?: boolean };
  /** Morph, megamorph or disguise (rules 702.37, 702.168): may be cast face down as a 2/2 for {3}, then turned face up for this cost. */
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
