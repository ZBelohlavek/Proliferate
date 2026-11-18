// Data model for the rules engine: the game state, and the decisions it asks
// players (people or bots) to make.
//
// The engine never decides anything itself. Every choice a player has under
// the rules is handed out as a Decision and comes back as an answer, so the
// same game can be played by a person, a bot, or any mix of the two.

import type { Color, Effect, LandInfo, LossReason, SimCard, SimDeck } from '../engine/types';

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
  /** Stun counters: each replaces one untap. */
  stun?: number;
  /** A crewed Vehicle: its card while it isn't a creature. */
  uncrewed?: SimCard;
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
  alive: boolean;
  drewFromEmpty: boolean;
  landsPlayed: number;
  /** Seat of the last opponent who milled this player's cards, credited if they run out (null: nobody). */
  milledBy: number | null;
  /** Poison counters; ten lose the game (rule 704.5c). */
  poison: number;
  /** Spells cast this turn (Rule of Law). */
  spellsThisTurn: number;
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
  /** Cast with flashback: exiled when it leaves the stack. */
  flashback?: boolean;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

/** One thing a player may do when they have priority. */
export type Action =
  | { type: 'pass' }
  /** Play a land from hand. `back` plays the land side of a modal double-faced card. */
  | { type: 'land'; card: SimCard; back: boolean }
  /** Cast a spell. maxX is the largest X that can be paid (0 for spells without X). */
  | { type: 'cast'; card: SimCard; from: 'hand' | 'command' | 'graveyard' | 'overload'; maxX: number }
  /** Crew a Vehicle: tap creatures to make it a creature until end of turn. */
  | { type: 'crew'; permId: number }
  /** Cycling: pay the cost and discard the card to draw one. */
  | { type: 'cycle'; card: SimCard }
  /** Activate an ability of a permanent (`effect` is one of its card's effects). */
  | { type: 'activate'; permId: number; effect: Effect };

export interface ChoiceOption {
  label: string;
  card?: SimCard;
  permId?: number;
}

export type ChooseReason = 'bottom' | 'discard' | 'tutor' | 'recursion' | 'sacrifice' | 'ramp' | 'extraLand' | 'counters' | 'fighter' | 'clone' | 'cheat' | 'take' | 'scry';
export type ConfirmReason = 'mulligan' | 'commandZone';

export type Decision =
  /** The player has priority: take one of these actions (the first is always "pass"). */
  | { kind: 'priority'; seat: number; actions: Action[] }
  /** Choose a target for one effect of a spell or ability. Answer null to take a cast back. */
  | { kind: 'target'; seat: number; prompt: string; card: SimCard; effect: Effect | null; candidates: Target[]; cancellable: boolean }
  /** Declare attackers: which creatures attack which players (rule 508.1). */
  | { kind: 'attackers'; seat: number; candidates: number[]; defenders: number[] }
  /** Declare blockers for the creatures attacking this player (rule 509.1). */
  | { kind: 'blockers'; seat: number; attackers: number[]; candidates: number[] }
  /** Pick between `min` and `max` of the options. */
  | { kind: 'choose'; seat: number; reason: ChooseReason; prompt: string; options: ChoiceOption[]; min: number; max: number }
  /** A yes/no question. `card` is the card it is about, if any. */
  | { kind: 'confirm'; seat: number; reason: ConfirmReason; prompt: string; card?: SimCard; to?: 'graveyard' | 'exile' | 'hand' };

export interface PriorityAnswer {
  /** Index into the decision's `actions`. */
  action: number;
  /** For spells with X in their cost. */
  x?: number;
}
export interface AttackDeclaration {
  attacker: number;
  defender: number;
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
