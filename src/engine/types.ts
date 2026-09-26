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
  | 'activated' // activated ability, paid for with spare mana
  | 'static'; // always on while the permanent is on the battlefield

/** Which creature a creature-based trigger watches. */
export type TriggerScope = 'self' | 'any' | 'oneOrMore';

export type CastFilter = 'any' | 'noncreature' | 'instantSorcery' | 'creature' | 'artifact' | 'enchantment';

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
  /** "Do this only once each turn." */
  oncePerTurn?: boolean;
  /** For activated abilities: the mana cost and whether it taps the source. */
  activation?: { cost: ManaCost; tap: boolean; sacrifice: boolean };
};

export type EffectBody =
  | { kind: 'ramp'; lands: number; toHand: number; tapped: boolean }
  | { kind: 'mana'; amount: number; colors: Mana[] | 'any' }
  | { kind: 'costReduction'; amount: number; filter: CastFilter }
  | { kind: 'treasure'; n: number }
  | { kind: 'extraLand' }
  | { kind: 'draw'; n: number }
  | { kind: 'removal'; target: RemovalTarget; mode: RemovalMode; amount: number }
  | { kind: 'wipe'; target: 'creatures' | 'nonland'; mode: RemovalMode; amount: number; oneSided: boolean }
  | { kind: 'counter'; target: 'any' | 'noncreature' | 'creature' }
  | { kind: 'tokens'; n: number; power: number; toughness: number; keywords: string[] }
  | { kind: 'anthem'; p: number; t: number }
  | { kind: 'overrun'; p: number; t: number; trample: boolean }
  | { kind: 'pump'; p: number; t: number; protect: boolean }
  | { kind: 'equip'; p: number; t: number; keywords: string[]; aura: boolean }
  | { kind: 'protect' }
  /** gain: life you gain afterwards; -1 = equal to the total life lost. */
  | { kind: 'drain'; n: number; gain: number }
  | { kind: 'damagePlayer'; n: number }
  | { kind: 'gainLife'; n: number }
  | { kind: 'tutor' }
  | { kind: 'recursion'; n: number; toBattlefield: boolean }
  | { kind: 'counters'; n: number; all: boolean };

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
  /** Modal double-faced card whose back is a land. */
  backLand?: LandInfo & { name: string };
  /** Rough "how good is this card" score used by the AI. */
  value: number;
  /** True if we recognised at least one thing the card does (or it's a vanilla body/land). */
  modeled: boolean;
  /** Human-readable interpretation, shown on the deck page. */
  notes: string[];
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
}
