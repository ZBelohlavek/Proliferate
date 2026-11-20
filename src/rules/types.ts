// Data model for the rules engine: the game state, and the decisions it asks
// players (people or bots) to make.
//
// The engine never decides anything itself. Every choice a player has under
// the rules is handed out as a Decision and comes back as an answer, so the
// same game can be played by a person, a bot, or any mix of the two.

import type { Color, Effect, FlashFilter, LandInfo, LossReason, SimCard, SimDeck } from '../engine/types';

/** Steps of a turn, in order (rules 500–514). */
export type Step =
  | 'untap'
  | 'upkeep'
  | 'draw'
  | 'main1'
  | 'beginCombat'
  | 'declareAttackers'
  | 'declareBlockers'
  | 'combatDamage'
  | 'endCombat'
  | 'main2'
  | 'end'
  | 'cleanup';

export const STEP_NAMES: Record<Step, string> = {
  untap: 'Untap',
  upkeep: 'Upkeep',
  draw: 'Draw',
  main1: 'Main phase',
  beginCombat: 'Beginning of combat',
  declareAttackers: 'Declare attackers',
  declareBlockers: 'Declare blockers',
  combatDamage: 'Combat damage',
  endCombat: 'End of combat',
  main2: 'Second main phase',
  end: 'End step',
  cleanup: 'Cleanup',
};

/** A permanent on the battlefield. */
export interface Perm {
  id: number;
  card: SimCard;
  /** Seat of the controller. */
  seat: number;
  /** Seat of the owner, when someone else controls it (Control Magic, Bribery). */
  owner?: number;
  /** The card this permanent really is, while it is a copy of another (Clone). */
  printed?: SimCard;
  tapped: boolean;
  /** Summoning sick: came under its controller's control this turn (rule 302.6). */
  sick: boolean;
  token: boolean;
  isCommander: boolean;
  /** +1/+1 counters. */
  counters: number;
  /** Planeswalkers: loyalty counters. */
  loyalty?: number;
  /** Planeswalkers: a loyalty ability was activated this turn (rule 606.3). */
  loyaltyUsed?: boolean;
  /** Battles: defense counters (rule 310.4). */
  defense?: number;
  /** Battles: seat of the player protecting it (rule 310.8). That player is the defending player when it is attacked. */
  protector?: number;
  /** Stun counters: each replaces one untap. */
  stun?: number;
  /** Goaded by these seats, until each one's next turn (rule 701.15). */
  goadedBy?: number[];
  /** An emblem (rule 114): kept with its owner's permanents so its abilities work, but it can't be touched. */
  emblem?: boolean;
  /** Suspected (rule 701.60): it has menace and can't block for as long as it stays suspected. */
  suspected?: boolean;
  /** "As ~ enters, choose a creature type": the type chosen (Metallic Mimic, Leyline of Transformation). */
  chosenType?: string;
  /** Sagas: lore counters (rule 714). */
  lore?: number;
  /** Classes: the level it has reached (rule 716). Its card then carries the abilities of every level so far. */
  level?: number;
  /** Cast with dash: returns to its owner's hand at the beginning of the next end step (rule 702.109). */
  dashed?: boolean;
  /** A bounty counter. */
  bounty?: boolean;
  /** Mathas: "for as long as it has a bounty counter, it has 'when this creature dies, each opponent draws a card and gains 2 life'". */
  bountyGrant?: boolean;
  /** Keyword counters (rule 122.1b): indestructible, flying ... */
  kwCounters?: string[];
  /** A temporary token copy (Satya): sacrificed at the next end step unless its controller pays energy. */
  temporary?: boolean;
  /**
   * A merged permanent (mutate, rule 721): its cards from top to bottom. `card` is then the
   * top card's characteristics plus every card's abilities. `real` is null for a token.
   */
  parts?: { real: SimCard | null; face: SimCard; commander: boolean }[];
  /** Transformed (rule 712): its front face. `card` is then the back face. */
  front?: SimCard;
  /** Face down (morph, manifest, rule 708): the real card. `card` is then a nameless 2/2. */
  faceDown?: SimCard;
  /** Id of the permanent whose effect gives its controller this one (Control Magic, Sower of Temptation); control ends when that permanent leaves. */
  heldBy?: number;
  /**
   * Taken only for a while (Act of Treason, Treasure Nabber): control goes back at the cleanup step of turn `turn` ('eot'),
   * or at the end of seat `by`'s next turn after turn `turn` ('nextTurn').
   */
  borrowed?: { until: 'eot' | 'nextTurn'; by: number; turn: number };
  /** Sacrificed or exiled at the beginning of the next end step (Kiki-Jiki's tokens, Treacherous Urge). */
  atEnd?: 'sacrifice' | 'exile';
  /** A copy "until end of turn" (Gogo, Mirage Mirror): what it goes back to at cleanup. */
  copiedUntilEot?: SimCard;
  /** Xantcha: attacks each combat if able, but never this seat (its owner). */
  neverAttacks?: number;
  /** Goaded by this seat for the rest of the game (Life of the Party's tokens). */
  goadForever?: number;
  /** Taken "for as long as that player is the monarch" (Garland, Royal Kidnapper): control ends when that seat stops being the monarch. */
  heldWhileMonarch?: number;
  /** Under a lockdown Aura (Amphibian Downpour, Imprisoned in the Moon): its real card. `card` is then the vanilla version. */
  unlocked?: SimCard;
  /** The Aura that locks it down. */
  lockedBy?: number;
  /** Charge counters. */
  charge?: number;
  /** Kill Switch: the artifacts it tapped, which don't untap during their controllers' untap steps while it stays tapped. */
  holdsTapped?: number[];
  /** Combat damage to and from it is prevented this turn (Maze of Ith). */
  fogged?: boolean;
  /** The turn number on which it last attacked (boast, rule 702.142). */
  attackedTurn?: number;
  /** A Curse: the seat of the player it enchants (rule 303.4). */
  cursing?: number;
  /** Age counters (cumulative upkeep). */
  age?: number;
  /** Times its spell was kicked (multikicker counts each payment; offspring counts as one). */
  kicked?: number;
  /** Hour counters (Midnight Clock). */
  hours?: number;
  /** Sacrificed when it becomes the target of a spell ('spell') or of a spell or ability ('any'): Phantasmal Image, Jace's Illusions. */
  fragile?: 'spell' | 'any';
  /** A crewed Vehicle: its card while it isn't a creature. */
  uncrewed?: SimCard;
  /** A permanent made a creature "until your next turn" (Karn, the Great Creator): `uncrewed` goes back at the start of this seat's turn instead of at cleanup. */
  animatedUntil?: number;
  /** Sacrificed at the beginning of the next end step (Depthshaker Titan's animated artifacts). */
  sacAtEnd?: boolean;
  /** A slime counter (Sludge Monster). */
  slime?: boolean;
  /** Has lost all abilities until this seat's next turn (Azure Beastbinder). */
  blankUntil?: number;
  /** A Treasure that is a 3/3 creature until end of turn (Vihaan): it goes back to being a Treasure at cleanup. */
  treasureCreature?: boolean;
  /** Impending (rule 702.176): time counters left. While it has any it isn't a creature: `card` is the noncreature version and `impendingCard` the real one. */
  impending?: number;
  impendingCard?: SimCard;
  /** Cast with blitz (rule 702.152): sacrificed at the next end step, and draws a card when it dies. */
  blitzed?: boolean;
  /** Cast with warp (rule 702.185): exiled at the next end step, then castable from exile on a later turn. */
  warped?: boolean;
  /** Cipher (rule 702.99): spell cards encoded on this creature. */
  encoded?: SimCard[];
  /** Hideaway (rule 702.75): the card exiled face down with it. */
  hidden?: SimCard;
  /** Seat of the hidden card's owner: whoever hid it from their library, not always the permanent's owner. */
  hiddenOwner?: number;
  damage: number;
  /** Dealt damage by a deathtouch source since the last state-based check (rule 704.5h). */
  deathtouched: boolean;
  /** "Until end of turn" changes. */
  tempP: number;
  tempT: number;
  tempKw: string[];
  /** For Equipment and Auras: the permanent they are attached to. */
  attachedTo: number | null;
  /** Abilities activated this turn. */
  activations: number;
  /** Once-per-turn triggers already used this turn. */
  usedThisTurn: Effect[];
  /** For lands: what they tap for. */
  landInfo?: LandInfo;
  /** Combat: seat of the player this creature is attacking, or null. */
  attacking: number | null;
  /** Combat: id of the planeswalker or battle this creature is attacking (`attacking` is then its controller, or the battle's protector), or undefined when it attacks the player. */
  attackingPw?: number;
  /** Combat: true once a blocker was declared for this attacker (it stays blocked even if the blocker leaves, rule 509.1h). */
  blocked: boolean;
  /** Combat: id of the attacker this creature is blocking, or null. */
  blocking: number | null;
}

export interface PlayerState {
  seat: number;
  deck: SimDeck;
  /** Name shown in the log and the table. */
  name: string;
  identity: Color[];
  life: number;
  library: SimCard[];
  hand: SimCard[];
  graveyard: SimCard[];
  exile: SimCard[];
  battlefield: Perm[];
  commandZone: SimCard[];
  /** Times each commander was cast from the command zone (commander tax, rule 903.8). */
  commanderCasts: Map<string, number>;
  /** Combat damage taken from each commander, keyed by "seat:name" (rule 903.10a). */
  commanderDamage: Map<string, number>;
  treasures: number;
  /** Mana in the mana pool (rule 106.4): ritual mana, firebending, Mana Drain, Thran Turbine. It empties as steps end (see Game.poolLive). */
  pool?: PoolMana[];
  /** Turn number on which this player last lost life (Gev). */
  lostLifeTurn: number;
  /** Turn number on which this player last discarded a card, and last attacked with a creature (conditions, rule 603.4). */
  discardedTurn?: number;
  attackedTurn?: number;
  /** Experience counters (Meren, Kratos). */
  experience: number;
  /** Energy counters (rule 122.1). */
  energy: number;
  /** Energy paid this turn (Blaster Hulk). */
  energyPaid?: number;
  /** Turn number on which a permanent last left the battlefield under this player's control (revolt). */
  revoltTurn?: number;
  /** Deflecting Palm: the next damage from one source to this player this turn is prevented (`reflect`: and dealt to that source's controller). */
  preventNext?: { reflect: boolean; card: SimCard };
  /** Cosmic Intervention: on this turn number, this player's permanents going to a graveyard are exiled and return at the next end step. */
  deathShield?: number;
  /** Creature spells and instant or sorcery spells cast this turn ("the first creature spell you cast each turn"). */
  creatureSpellsThisTurn?: number;
  instantSorceryThisTurn?: number;
  /** Combat damage dealt to this player is prevented this turn; `tokens`: and makes that many 2/1 flyers (Inkshield). */
  fogged?: { tokens: boolean };
  alive: boolean;
  drewFromEmpty: boolean;
  landsPlayed: number;
  /** Seat of the last opponent who milled this player's cards, credited if they run out (null: nobody). */
  milledBy: number | null;
  /** An effect said this player loses the game (rule 104.3); they leave at the next state-based check unless they can't lose. */
  lost?: boolean;
  /** Poison counters; ten lose the game (rule 704.5c). */
  poison: number;
  /** Spells cast this turn (Rule of Law). */
  spellsThisTurn: number;
  /** Cards drawn this turn (for "their second card each turn"). */
  drawsThisTurn: number;
  /** How many times the Ring has tempted this player, up to 4 (rule 701.54), and the current ring-bearer. */
  ringLevel: number;
  ringBearer: number | null;
  /** Cards exiled to be cast later: foretold, plotted, suspended (with `time` counters) or warped (rules 702.143, 702.170, 702.62, 702.185). */
  held?: HeldCard[];
  /** "As though it had flash" for a while (Borne Upon a Wind, Teferi): what it covers, until when, and the turn it began. */
  flashGrants?: { what: FlashFilter; until: 'turn' | 'yourNextTurn'; turn: number }[];
  /** Turn number on which a Rogue of theirs last dealt combat damage to a player (prowl). */
  rogueHit?: number;
  /** Turn number of their last creature spell (The Blue Spirit). */
  creatureCastTurn?: number;
  /** Madness and miracle (rules 702.35, 702.94): cards that may be cast now for that cost, until this player next passes priority. */
  windows?: { card: SimCard; how: 'madness' | 'miracle' }[];
  /** Teach by Example, Jace Reawakened: copy the next instant or sorcery spell cast this turn, or every spell cast this turn. */
  copyNext?: 'next' | 'turn';
  /** Cards in exile this player may play (impulse draw, theft; rule 611.2). The card sits in its owner's exile. */
  mayPlay?: MayPlay[];
  /** Turns this player has begun, to tell when "until the end of your next turn" runs out. */
  turnsTaken?: number;
  /** The turn number on which One with the Multiverse's free spell was used. */
  freeSpellTurn?: number;
  /** Permanent types already cast or played from the graveyard this turn (Muldrotha). */
  graveyardTypes?: Set<string>;
  /** Can't lose life or take commander damage until their next turn (Teferi's Protection). */
  shielded: boolean;
  lastHitBy: number | null;
  lastHitKind: LossReason;
  commanderRound: number | null;
  mulligans: number;
  earlyNames: Set<string>;
  drawnNames: Set<string>;
  castNames: Set<string>;
}

/** Mana in a player's pool. `until`: when it empties: as the step it was made in ends, at end of combat (firebending) or after the owner's next precombat main phase (Mana Drain). */
export interface PoolMana {
  n: number;
  colors: 'any' | ['C'];
  turn: number;
  step: Step;
  combat: number;
  until: 'step' | 'combat' | 'nextMain' | 'kept';
  /** Thran Turbine: only for activated abilities. */
  abilityOnly?: boolean;
}

/** A card in exile that its owner may cast later (see PlayerState.held). */
export interface HeldCard {
  card: SimCard;
  way: 'foretell' | 'plot' | 'suspend' | 'warp';
  /** Turn number it was exiled on: foretold, plotted and warped cards are cast on a later turn. */
  turn: number;
  /** Suspend: time counters left. */
  time?: number;
}

/** Permission to play a card from exile (rule 611.2: it lasts as long as the effect says). */
export interface MayPlay {
  card: SimCard;
  /** Seat of the owner: the card is in that player's exile. */
  owner: number;
  /** 'turn': until the end of the turn on which it was given (`turn`). 'nextTurn': until the end of this player's next turn (`turnsAt`). 'exiled': as long as it stays exiled. */
  until: 'turn' | 'nextTurn' | 'exiled';
  turn: number;
  turnsAt: number;
  anyMana?: boolean;
  payLife?: boolean;
  free?: boolean;
  castOnly?: boolean;
  ownTurn?: boolean;
  /** Only cards of this kind may be played (Arvinox: permanent spells). */
  only?: import('../engine/typesExile').CardKind;
  /** "You may play one of those cards": entries sharing a group lapse once one of them is played. */
  group?: number;
  /** Only while this permanent stays on the battlefield (Nightveil Specter). */
  sourceId?: number;
  /** Where it came from, for the log. */
  source: string;
}

/** Something a spell or ability can target. */
export type Target =
  | { kind: 'perm'; id: number }
  | { kind: 'player'; seat: number }
  | { kind: 'stack'; id: number };

/** A spell or ability on the stack. */
export interface StackItem {
  id: number;
  kind: 'spell' | 'ability';
  controller: number;
  /** The spell's card, or the card the ability comes from. */
  card: SimCard;
  /** What happens when it resolves. */
  effects: Effect[];
  /** One entry per effect; null when that effect has no target. */
  targets: (Target | null)[];
  x: number;
  /** A spell that is its controller's commander. */
  isCommander: boolean;
  /** Abilities: the permanent the ability came from. */
  sourceId: number | null;
  /** Aura spells and equip abilities: what to attach to. */
  attachTo: Target | null;
  /** Short description for the table and the log. */
  label: string;
  /** Cast with flashback (or escape, disturb): exiled when it leaves the stack. */
  flashback?: boolean;
  /** Cast with escape (rule 702.138c: it "escaped"). */
  escaped?: boolean;
  /** Cast from the graveyard with Noctis: the permanent enters with a finality counter (exiled instead of going to a graveyard). */
  finality?: boolean;
  /** A copy of a spell (rule 707.10): it ceases to exist instead of going anywhere when it leaves the stack. */
  copy?: boolean;
  /** Cast with an alternative cost that changes what happens on resolution (evoke, dash, blitz, warp, impending). */
  alt?: 'evoke' | 'dash' | 'blitz' | 'warp' | 'impending';
  /** Buyback paid (rule 702.27): it returns to its owner's hand as it resolves. */
  buyback?: boolean;
  /** Gift promised (rule 702.174): the opponent who gets it, before the spell's other effects. */
  gift?: number;
  /** Cast from suspend: a creature spell has haste (rule 702.62a). */
  suspended?: boolean;
  /** Triggered abilities: the spell that set it off ("whenever you cast a spell, copy that spell"). */
  subject?: number;
  /** Cast face down for {3} (morph, disguise): the real card. `card` is then the nameless 2/2 everyone sees. */
  faceDown?: SimCard;
  /** Cast transformed (a defeated Siege, rule 310.11b): the card's front face. `card` is then its back face. */
  front?: SimCard;
  /** Cast for its mutate cost: the permanent it merges with (rule 702.140). */
  mutateOnto?: number;
  /** Times the spell was kicked (kicker, multikicker, offspring). */
  kicked?: number;
  /** A Room cast as its other door: what enters (`card` is still the card that goes to the graveyard). */
  door?: SimCard;
  /** Seat of the card's owner, when its controller cast it from someone else's library, exile or graveyard. */
  owner?: number;
  /** Exiled instead of going anywhere else when it leaves the stack (Wrexial, Mizzix's Mastery's copies are copies). */
  exileAfter?: boolean;
  /** Triggered abilities: the seat of the player the trigger is about ("that player", see Effect.thatPlayer). */
  aboutSeat?: number;
  /** Dies triggers: the card of the creature that died, for "return that card" (Minion's Return). */
  died?: DiedCard;
  /** Triggered abilities: the card or permanent the trigger is about (the creature that died, entered or attacked; the card an opponent sacrificed). */
  about?: About;
}

/** A creature that just died: its card, its owner, and what it looked like on the battlefield. */
export interface DiedCard {
  card: SimCard;
  owner: number;
  /** +1/+1 counters (negative: -1/-1 counters) it had. */
  counters: number;
  flying: boolean;
}

/** What a triggered ability is about: a card that left (with the seat that owned it), or a permanent still on the battlefield. */
export interface About {
  card: SimCard;
  owner: number;
  permId?: number;
  /** It had a -1/-1 counter on it when it died (Necroskitter). */
  shrunk?: boolean;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** One thing a player may do when they have priority. */
export type Action =
  | { type: 'pass' }
  /** Play a land from hand. `back` plays the land side of a modal double-faced card. `fromGraveyard`: Crucible of Worlds. */
  | { type: 'land'; card: SimCard; back: boolean; fromGraveyard?: boolean; /** Played from exile or the top of the library (see PlayerState.mayPlay, playTop). */ from?: 'exile' | 'library' }
  /** Cast a spell. maxX is the largest X that can be paid (0 for spells without X). */
  /** `alt` casts it for its alternative cost (see SimCard.altCost). `mutate`: cast for its mutate cost, onto a creature chosen as the target. `faceDown`: cast face down for {3} (morph). */
  /** `kick`: pay its kicker (or offspring) cost this many times (rule 702.33). */
  /** From exile: 'foretell' (for its foretell cost), 'plot' (free, as a sorcery), 'warp' (a warped card, for its mana cost). 'madness' and 'miracle': for that cost, right after it was discarded or drawn. */
  /** `exile`: a card the player may play from exile (PlayerState.mayPlay). `library`: the top card of their library (playTop). */
  /** `modes`: spree or tiered modes chosen, as bits (rule 702.172). */
  | { type: 'cast'; card: SimCard; from: CastFrom; maxX: number; mutate?: boolean; faceDown?: boolean; kick?: number; modes?: number; /** Without paying its mana cost, once each turn (One with the Multiverse). */ free?: boolean; /** `door`: cast a Room's other door (`card.room.door`) instead of the one the card shows (rule 709.5d). */ door?: boolean }
  /** Use a card from hand without casting it: foretell, plot or suspend it (exile it to cast later), transmute or channel it. */
  | { type: 'hand'; card: SimCard; how: 'foretell' | 'plot' | 'suspend' | 'transmute' | 'channel' }
  /** Pay a Room's locked door's mana cost to unlock it (rule 709.5e). A special action. */
  | { type: 'unlock'; permId: number }
  /** Give a Class its next level (rule 716.2a). */
  | { type: 'level'; permId: number }
  /** Turn a face-down permanent face up for its morph cost, or its mana cost if it is a manifested creature card (rule 702.37e, 701.40b). A special action. */
  | { type: 'turnFaceUp'; permId: number }
  /** Ninjutsu: return the unblocked attacker `permId` to hand and put `card` onto the battlefield attacking in its place (rule 702.49a). */
  | { type: 'ninjutsu'; card: SimCard; permId: number }
  /** Crew a Vehicle: tap creatures to make it a creature until end of turn. */
  | { type: 'crew'; permId: number }
  /** Station (rule 702.184a): tap another untapped creature to put charge counters equal to its power on this permanent. */
  | { type: 'station'; permId: number }
  /** Cycling: pay the cost and discard the card to draw one. */
  | { type: 'cycle'; card: SimCard }
  /** Use a card's ability from your graveyard: unearth, embalm, "{1}{B}: return ~ from your graveyard". */
  | { type: 'graveyard'; card: SimCard }
  /** Activate an ability of a permanent (`effect` is one of its card's effects). */
  | { type: 'activate'; permId: number; effect: Effect };

export type CastFrom = 'hand' | 'command' | 'graveyard' | 'overload' | 'alt' | 'foretell' | 'plot' | 'warp' | 'exile' | 'library' | 'madness' | 'miracle';

export interface ChoiceOption {
  label: string;
  card?: SimCard;
  permId?: number;
}

export type ChooseReason = 'bottom' | 'discard' | 'tutor' | 'recursion' | 'sacrifice' | 'ramp' | 'extraLand' | 'counters' | 'fighter' | 'clone' | 'cheat' | 'take' | 'scry' | 'mutate' | 'manifest' | 'blink' | 'pitch' | 'untap' | 'entomb' | 'exileCard' | 'torment' | 'station' | 'player' | 'impulse' | 'freeCast' | 'rearrange' | 'cipher' | 'gift' | 'hideaway' | 'copySpell' | 'payCost' | 'protector' | 'legend' | 'stack';
export type ConfirmReason = 'mulligan' | 'commandZone' | 'animate' | 'payTax';

export type Decision =
  /** The player has priority: take one of these actions (the first is always "pass"). */
  | { kind: 'priority'; seat: number; actions: Action[] }
  /** Choose a target for one effect of a spell or ability. Answer null to take a cast back. */
  | { kind: 'target'; seat: number; prompt: string; card: SimCard; effect: Effect | null; candidates: Target[]; cancellable: boolean }
  /** Declare attackers: which creatures attack which players (rule 508.1). */
  /** `goaded`: creatures that must attack, and the players each may attack (rule 701.15b). The engine adds them if left out. */
  /** `planeswalkers`: ids of planeswalkers opponents control, and of battles this player doesn't protect, which may be attacked instead of a player (rule 508.1b). */
  | { kind: 'attackers'; seat: number; candidates: number[]; defenders: number[]; goaded?: { attacker: number; defenders: number[] }[]; planeswalkers?: number[] }
  /** Declare blockers for the creatures attacking this player (rule 509.1). */
  | { kind: 'blockers'; seat: number; attackers: number[]; candidates: number[] }
  /** Pick between `min` and `max` of the options. */
  | { kind: 'choose'; seat: number; reason: ChooseReason; prompt: string; options: ChoiceOption[]; min: number; max: number }
  /** A yes/no question. `card` is the card it is about, if any. */
  | { kind: 'confirm'; seat: number; reason: ConfirmReason; prompt: string; card?: SimCard; to?: 'graveyard' | 'exile' | 'hand' | 'library' };

export interface PriorityAnswer {
  /** Index into the decision's `actions`. */
  action: number;
  /** For spells with X in their cost. */
  x?: number;
}
export interface AttackDeclaration {
  attacker: number;
  defender: number;
  /** Attack this planeswalker or battle (one of the decision's `planeswalkers`) instead of a player; `defender` is then ignored. */
  planeswalker?: number;
}
export interface BlockDeclaration {
  blocker: number;
  attacker: number;
}

/** What each kind of decision is answered with. */
export type Answer = PriorityAnswer | Target | null | AttackDeclaration[] | BlockDeclaration[] | number[] | boolean;

/** Anything that can answer decisions for a seat. */
export interface Agent {
  decide(game: GameView, decision: Decision): Answer;
}

/** The engine as agents see it (see Game in game.ts). */
export type GameView = import('./game').Game;
