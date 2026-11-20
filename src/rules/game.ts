// The rules engine: one game of multiplayer Commander under the real turn
// structure, with priority, the stack, targets, declared attackers and
// blockers, state-based actions and the Commander rules.
//
// Rule numbers in comments refer to the Magic Comprehensive Rules.
//
// The engine is a generator. Whenever the rules give a player a choice it
// yields a Decision and waits for the answer, so it never decides anything
// itself: a person, a bot, or any mix can sit in the seats (see session.ts).
//
// What a card does comes from the Effects the classifier found in its oracle
// text (src/engine/classify.ts). The engine supplies the rules around them.
// Known simplifications are listed in the README.

import { bloodCard, foodCard, incubatorCard, isFood, isIncubator } from '../engine/artifactTokens';
import { Rng } from '../engine/rng';
import type {
  CastFilter, Color, Cond, CopyFilter, CurseAbility, CurseAct, Effect, Elimination, FlashFilter, GameResult, LandInfo, LossReason, Mana, ManaCost, RecursionWhat, SimCard, SimDeck, Trigger,
} from '../engine/types';
import type {
  About, Action, Answer, AttackDeclaration, BlockDeclaration, CastFrom, ChoiceOption, ChooseReason, Decision, DiedCard, HeldCard, MayPlay, Perm, PlayerState, PoolMana, PriorityAnswer, StackItem, Step, Target,
} from './types';
import type { CardKind, Who } from '../engine/typesExile';
import { artifactCount, assembledCombo, UPKEEP_COUNTERS, UPKEEP_WINS, WINCON_NAMES } from './wincons';

/** A piece of the game that may stop to ask players for decisions. */
export type Flow<T> = Generator<Decision, T, Answer>;

export interface GameOptions {
  /** Rounds after which the game is called a draw. */
  maxRounds?: number;
  /** Keep a play-by-play log. */
  log?: boolean;
  /** Display name per seat. */
  names?: string[];
  /** Seat that takes the first turn. */
  startSeat?: number;
}

interface ManaSource {
  perm: Perm | null; // null = a Treasure token
  colors: Mana[] | 'any';
  amount: number;
  /** Energy each use costs (Solar Transformer). */
  energy?: number;
  /** How the source's charge counters pay (see the 'mana' effect). */
  charge?: 'tap' | 'grow' | 'spend';
  /** Each +1/+1 counter removed is a mana; nothing is tapped (Crystalline Crawler). */
  counters?: boolean;
  /** A "{0}: Add ..." ability usable once each turn: it is marked used instead of tapping (Vivi Ornitier). */
  once?: Effect;
  /** An artifact token sacrificed for the mana (Krark-Clan Ironworks). */
  sac?: boolean;
  /** Mana already in the player's pool (rule 106.4). */
  pool?: PoolMana;
}

/**
 * How a spell is cast from somewhere other than its usual zone (rule 601.2): from exile or the top of a library under
 * a permission, or during the resolution of another spell or ability without paying its mana cost.
 */
interface CastVia {
  zone: SimCard[];
  owner: PlayerState;
  /** 'free': without paying its mana cost. 'life': life equal to its mana value instead. 'anyMana': mana of any type. */
  mode: 'free' | 'life' | 'anyMana' | 'normal';
  /** Cast a copy of the card; the card itself stays where it is (rule 707.12). */
  copy?: boolean;
  exileAfter?: boolean;
  entry?: MayPlay;
  /** Added to the log line after the card's name. */
  label: string;
  /** Cast transformed: the card in `zone` is this front face, and its back face (`card`) is the spell (rule 712.11). */
  front?: SimCard;
}

/** A triggered ability waiting to be put on the stack (rule 603.3). */
interface PendingTrigger {
  controller: number;
  card: SimCard;
  sourceId: number | null;
  effects: Effect[];
  /** The spell that set it off, for "copy that spell". */
  subject?: number;
  /** The card or permanent the trigger is about (see StackItem.about). */
  about?: About;
  /** The number "that much" refers to (life gained, for Sanguine Bond). */
  x: number;
  /** The seat of the player the trigger is about ("that player"). */
  aboutSeat?: number;
  /** Dies triggers: the creature that died. */
  died?: DiedCard;
}

const PASS: Action = { type: 'pass' };
const NONE: Perm[] = [];

/**
 * Answers worked out once while nothing on the table can change (see `Game.readOnly`):
 * a creature's power, toughness and keywords, what is attached to what, the static
 * abilities in play. Looking these up again and again was most of a game's cost.
 */
interface Memo {
  power: Map<Perm, number>;
  toughness: Map<Perm, number>;
  kw: Map<Perm, Map<string, boolean>>;
  attached: Map<number, Perm[]> | null;
  statics: Map<string, number>;
  staticsOf: Map<string, { e: Effect; perm: Perm }[]>;
  manaSources: Map<string, ManaSource[]>;
  /** Anthem abilities on each seat's permanents. */
  anthems: Map<number, { perm: Perm; e: Extract<Effect, { kind: 'anthem' }> }[]>;
  curses: Map<number, Perm[]>;
}

/** Testing aid: recompute every remembered answer and throw if it went stale. */
let verifyMemo = false;
export function setMemoCheck(on: boolean) {
  verifyMemo = on;
}
function checkMemo<T>(what: string, kept: T, now: T): T {
  if (JSON.stringify(kept, memoReplacer) !== JSON.stringify(now, memoReplacer)) throw new Error(`Stale ${what}: kept ${JSON.stringify(kept, memoReplacer)}, now ${JSON.stringify(now, memoReplacer)}`);
  return kept;
}
function memoReplacer(key: string, value: unknown) {
  if (key === 'perm' && value && typeof value === 'object') return (value as Perm).id;
  if (key === 'card' || key === 'pool') return undefined;
  if (key === 'e' && value && typeof value === 'object') return (value as Effect).kind;
  return value;
}
const NO_COST: ManaCost = { generic: 0, pips: [], x: 0, life: 0 };
/** Equip cost assumed when a deck was imported before equip costs were recorded. */
const DEFAULT_EQUIP: ManaCost = { generic: 2, pips: [], x: 0, life: 0 };
/** Foretelling costs {2} (rule 702.143a). */
const FORETELL_COST: ManaCost = { generic: 2, pips: [], x: 0, life: 0 };
const COMBAT_STEPS: Step[] = ['beginCombat', 'declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat'];
const BEFORE_BLOCKERS: Step[] = ['upkeep', 'draw', 'main1', 'beginCombat', 'declareAttackers'];
const BLITZ_DRAW: Effect = { kind: 'draw', n: 1, when: 'creatureDies', scope: 'self' };
/** Curse of Echoes: copy that spell (the player may choose new targets). */
const ECHO: Effect = { kind: 'copySpell', what: 'trigger', when: 'resolve' };
/** How the log says where a spell was cast from. */
const CAST_FROM_TEXT: Partial<Record<string, string>> = { foretell: ' from exile (foretold)', plot: ' from exile (plotted)', warp: ' from exile (warped)', madness: ' for its madness cost', miracle: ' for its miracle cost', free: ' without paying its mana cost' };
/** How much a Curse hurts the player it enchants, for choosing which one to move (Lynde). */
const CURSE_HARM: Record<CurseAct, number> = {
  cruel: 6, unbinding: 6, double: 5, torment: 5, thirst: 4, drain: 4, shrink: 4, burn: 3, hex: 3, misfortunes: 3, fraying: 3, surveil: 2, spite: 2, restless: 2,
  hospitality: 2, echoes: 1, gold: 1, zombie: 1, gainLife: 1, draw: 1, attackerZombie: 1, obsessionDiscard: 1, obsessionDraw: 0,
};
/** What a Treasure token is, for locks on artifacts' abilities (Karn, the Great Creator). */
const TREASURE_TYPES = { isCreature: false, isArtifact: true, isEnchantment: false };
/** A Food's ability: "{2}, {T}, Sacrifice this permanent: You gain 3 life." Creatures have it while Ygra is out. */
export const FOOD: Effect = { kind: 'gainLife', n: 3, when: 'activated', activation: { cost: { generic: 2, pips: [], x: 0, life: 0 }, tap: true, sacrifice: true } };
/** Mana an opponent pays to target a permanent with ward (the classifier doesn't keep the exact ward cost). */
const WARD_COST = 2;
/** Library cards (after the opening hand) counted as "early" for card stats. */
const EARLY_LIBRARY_CARDS = 8;
const STARTING_LIFE = 40; // rule 903.7
const COMMANDER_DAMAGE = 21; // rule 903.10a
const MAX_HAND = 7;

function* ask<T>(decision: Decision): Flow<T> {
  return (yield decision) as T;
}

/** Cascade's trigger: exile until a nonland card with lesser mana value, cast it free, the rest to the bottom. */
const CASCADE: Effect = { kind: 'freeCast', from: 'until', n: 0, who: 'you', only: 'nonland', maxCmc: -2, casts: 1, rest: 'bottom', when: 'resolve' };

export class Game {
  readonly players: PlayerState[];
  readonly rng: Rng;
  round = 0;
  turnNumber = 0;
  activeSeat = 0;
  step: Step = 'untap';
  /** The stack; the last item is on top. */
  readonly stack: StackItem[] = [];
  readonly log: string[] | null;
  over = false;
  winner: number | null = null;
  readonly eliminations: Elimination[] = [];
  readonly placements: number[];
  private nextId = 1;
  private readonly maxRounds: number;
  private readonly startSeat: number;
  private triggerBudget = 0;
  /** The rest of this turn's combat and postcombat main phases, in order. Additional combats go here (rule 500.8). */
  private phases: ('combat' | 'main' | 'beginning')[] = [];
  /** Combat phases begun this turn (Genji Glove, Aurelia: "the first combat phase of the turn"). */
  combatsThisTurn = 0;
  /** Full Throttle, World at War: at the beginning of each combat this turn, untap all creatures that attacked this turn. */
  private untapAttackersEachCombat = false;
  private pending: PendingTrigger[] = [];
  /** Commanders that just went to a graveyard, exile or hand (rule 903.9). */
  private pendingCommander: { seat: number; card: SimCard; to: 'graveyard' | 'exile' | 'hand' | 'library' }[] = [];
  /** Legendary permanents with the same name and controller, for the legend rule (704.5j). */
  private pendingLegend: { seat: number; name: string; ids: number[] }[] = [];
  /** Defeated Sieges whose controller casts them transformed (rule 310.11b). */
  private pendingSiege: { seat: number; owner: number; card: SimCard }[] = [];
  /** Damage dealt to permanents that something watches (Phyrexian Obliterator, bounty counters), handled with state-based actions. */
  private damagedQueue: { perm: Perm; seat: number; amount: number }[] = [];
  /** Attackers that dealt combat damage in the first-strike step (rule 510.4). */
  private struckFirst = new Set<number>();
  /** False while nothing is attached to anything, to skip the search for attachments. */
  private anyAttached = false;
  /** Remembered answers while the table can't change (see `readOnly`). */
  private memo: Memo | null = null;
  private memoDepth = 0;
  /** While a spell or ability resolves: its card (the source of a "when this dies" trigger may be gone). */
  private resolvingCard: SimCard | null = null;
  /** While a spell or ability resolves: the controller of the last thing it targeted. */
  private aimedSeat: number | null = null;
  /** Seats that take an extra turn after the current one (Time Warp). */
  private extraTurns: number[] = [];
  private extraTurnsTaken = 0;
  /** This turn is an extra turn (Medomai the Ageless can't attack during one). */
  inExtraTurn = false;
  /** Additional beginning phases added this turn (Sphinx of the Second Sun), capped against loops. */
  private extraBeginnings = 0;
  /** Times each seat resolved Approach of the Second Sun. */
  private approachCasts = new Map<number, number>();
  /** The spell or ability resolving right now. */
  private resolving: StackItem | null = null;
  /** Set while a spell resolves that goes back into its owner's library instead of the graveyard. */
  private tuckSpell = false;
  /** The resolving spell shuffles itself into its owner's library (Blue Sun's Zenith). */
  private shuffleSpell = false;
  /** Seat of the monarch, if any (rule 724). */
  monarch: number | null = null;
  /** Fog: all combat damage this turn is prevented. */
  private fogAll = false;
  /** Unearthed creatures: exiled at the end step, or if they would leave the battlefield (rule 702.84). */
  private readonly unearthed = new Set<number>();
  /** Permanents with a finality counter: exiled instead of going to a graveyard. */
  private readonly finality = new Set<number>();
  /** Permanents that escaped (rule 702.138c), for Kroxa's "sacrifice it unless it escaped". */
  private readonly escapedPerms = new Set<number>();
  /** Effect kinds of every permanent made so far, so static effects no deck plays cost nothing to check. */
  private readonly kindsInGame = new Set<string>();
  /** The spell or ability choosing or checking its targets right now, for protection and "hexproof from" (rules 702.16b, 702.11d). */
  private aim: { card: SimCard; seat: number; ability: boolean } | null = null;
  /**
   * "Creatures your opponents control attack this turn if able" (Bident of Thassa, The Akroan War: 'force') and
   * "creatures can't attack you unless their controller pays" for a while (Summon: Yojimbo: 'tax'), set by `seat`.
   */
  private attackOrders: { seat: number; kind: 'force' | 'tax'; amount: number; until: 'turn' | 'nextTurn'; turn: number }[] = [];
  /** Leonin Arbiter: the turn on which each seat last paid {2} to search. */
  private readonly arbiterPaid = new Map<number, number>();
  /** Isochron Scepter: the card exiled with each one (keyed by permanent id). */
  readonly imprinted = new Map<number, SimCard>();
  /** Life each seat lost this turn (Bloodchief Ascension). */
  private lifeLostThisTurn: number[] = [];
  /** Seats that can't cast spells this turn (Silence). */
  private readonly silenced = new Set<number>();
  /** Pacts: what each seat must pay at its next upkeep or lose the game. */
  private pacts: { seat: number; cost: ManaCost; name: string }[] = [];
  /** Creatures that died this turn (Blood for the Blood God!). */
  diedThisTurn = 0;
  /** Seats that hold a card from a combo or an alternative win, so the checks cost nothing for other decks. */
  private readonly winconSeats = new Set<number>();

  constructor(decks: SimDeck[], seed: number, opts: GameOptions = {}) {
    if (decks.length < 2 || decks.length > 6) throw new Error(`A game needs 2–6 players, got ${decks.length}.`);
    this.rng = new Rng(seed);
    this.maxRounds = opts.maxRounds ?? 40;
    this.log = opts.log ? [] : null;
    this.startSeat = Math.max(0, Math.min(decks.length - 1, opts.startSeat ?? 0));
    this.placements = decks.map(() => 0);
    this.players = decks.map((deck, seat) => ({
      seat,
      deck,
      name: opts.names?.[seat] ?? `${deck.commanders[0]?.name ?? deck.name} (P${seat + 1})`,
      identity: deck.colorIdentity,
      life: STARTING_LIFE,
      library: [],
      hand: [],
      graveyard: [],
      exile: [],
      battlefield: [],
      commandZone: [...deck.commanders],
      commanderCasts: new Map(),
      commanderDamage: new Map(),
      treasures: 0,
      experience: 0,
      energy: 0,
      lostLifeTurn: -1,
      alive: true,
      drewFromEmpty: false,
      landsPlayed: 0,
      spellsThisTurn: 0,
      drawsThisTurn: 0,
      ringLevel: 0,
      ringBearer: null,
      poison: 0,
      shielded: false,
      lastHitBy: null,
      lastHitKind: 'combat',
      commanderRound: null,
      mulligans: 0,
      earlyNames: new Set(),
      drawnNames: new Set(),
      castNames: new Set(),
      milledBy: null,
    }));
    this.lifeLostThisTurn = this.players.map(() => 0);
    this.players.forEach((p, seat) => {
      if ([...p.deck.commanders, ...p.deck.cards.map((e) => e.card)].some((c) => WINCON_NAMES.has(c.name) && !c.effects.some((e) => e.kind === 'winIf'))) this.winconSeats.add(seat);
    });
  }

  // -------------------------------------------------------------------------
  // Top level
  // -------------------------------------------------------------------------

  *run(): Flow<GameResult> {
    for (const p of this.inTurnOrder()) yield* this.openingHand(p);
    // Leylines: may begin the game on the battlefield (rule 103.6a).
    for (const p of this.inTurnOrder()) this.beginWithLeylines(p);

    while (!this.over && this.round < this.maxRounds) {
      this.round++;
      for (const p of this.inTurnOrder()) {
        if (!p.alive) continue;
        yield* this.turn(p);
        // Extra turns (rule 500.7). Capped so a recursion loop can't go on forever.
        while (!this.over && this.extraTurns.length && this.extraTurnsTaken < 12) {
          const extra = this.players[this.extraTurns.shift()!];
          if (!extra.alive) continue;
          this.extraTurnsTaken++;
          this.say(`${extra.name} takes an extra turn.`);
          this.inExtraTurn = true;
          yield* this.turn(extra);
          this.inExtraTurn = false;
        }
        this.extraTurns = [];
        if (this.over) break;
      }
    }

    const alive = this.alivePlayers();
    if (alive.length === 1) {
      this.winner = alive[0].seat;
      this.placements[this.winner] = 1;
      this.say(`${alive[0].name} wins on round ${this.round}.`);
    } else if (alive.length > 1) {
      // Turn limit: survivors share the top places.
      const shared = (1 + alive.length) / 2;
      for (const p of alive) {
        this.placements[p.seat] = shared;
        this.eliminations.push({ seat: p.seat, round: this.round, reason: 'timeout', killer: null });
      }
      this.say(`Turn limit reached — draw between ${alive.map((p) => p.name).join(', ')}.`);
    }
    this.over = true;
    return this.result();
  }

  result(): GameResult {
    return {
      seats: this.players.map((p) => p.deck.id),
      winner: this.winner,
      placements: this.placements,
      rounds: this.round,
      eliminations: this.eliminations,
      commanderRound: this.players.map((p) => p.commanderRound),
      mulligans: this.players.map((p) => p.mulligans),
      cards: this.players.map((p) => ({ early: [...p.earlyNames], drawn: [...p.drawnNames], cast: [...p.castNames] })),
    };
  }

  private inTurnOrder(): PlayerState[] {
    const n = this.players.length;
    return this.players.map((_, i) => this.players[(this.startSeat + i) % n]);
  }

  alivePlayers(): PlayerState[] {
    return this.players.filter((p) => p.alive);
  }

  opponents(p: PlayerState): PlayerState[] {
    return this.players.filter((o) => o.alive && o !== p);
  }

  /** The next living player after `seat` in turn order. */
  nextAliveSeat(seat: number): number {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const q = this.players[(seat + i) % n];
      if (q.alive) return q.seat;
    }
    return seat;
  }

  private say(msg: string) {
    if (this.log) this.log.push(msg);
  }

  // -------------------------------------------------------------------------
  // Setup and mulligans (rule 103.5)
  // -------------------------------------------------------------------------

  private *openingHand(p: PlayerState): Flow<void> {
    const cards: SimCard[] = [];
    for (const entry of p.deck.cards) for (let i = 0; i < entry.count; i++) cards.push(entry.card);
    p.library = this.rng.shuffle(cards);
    p.hand = p.library.splice(0, MAX_HAND);

    // London mulligan; the first one is free in multiplayer (rule 103.5c).
    const free = this.players.length > 2 ? 1 : 0;
    while (MAX_HAND - Math.max(0, p.mulligans + 1 - free) > 0) {
      const again = yield* ask<boolean>({
        kind: 'confirm', seat: p.seat, reason: 'mulligan',
        prompt: p.mulligans === 0 ? 'Keep this hand, or mulligan?' : `Keep, or mulligan again? (${p.mulligans} taken so far)`,
      });
      if (!again) break;
      p.mulligans++;
      p.library.push(...p.hand);
      this.rng.shuffle(p.library);
      p.hand = p.library.splice(0, MAX_HAND);
    }
    const toBottom = Math.min(p.hand.length, Math.max(0, p.mulligans - free));
    if (toBottom > 0) {
      const picks = yield* this.choose(p, 'bottom', `Put ${toBottom} card${toBottom > 1 ? 's' : ''} on the bottom of your library.`, p.hand.map((card) => ({ label: card.name, card })), toBottom, toBottom);
      const cards2 = picks.map((i) => p.hand[i]);
      for (const c of cards2) {
        p.hand.splice(p.hand.indexOf(c), 1);
        p.library.push(c);
      }
    }
    for (const c of p.hand) p.drawnNames.add(c.name);
    for (const c of [...p.hand, ...p.library.slice(0, EARLY_LIBRARY_CARDS)]) p.earlyNames.add(c.name);
    this.say(`${p.name} keeps ${p.hand.length}${p.mulligans ? ` after ${p.mulligans} mulligan(s)` : ''}.`);
  }

  // -------------------------------------------------------------------------
  // Turn structure (rules 500–514)
  // -------------------------------------------------------------------------

  /**
   * An additional beginning phase (rule 500.8, Sphinx of the Second Sun): untap, upkeep and draw steps again
   * in the same turn. Things that last "this turn" carry on; the end phase follows.
   */
  private *extraBeginning(p: PlayerState): Flow<void> {
    this.say(`${p.name} begins an additional beginning phase.`);
    this.step = 'untap';
    const untapLimit = this.untapLimits(p);
    const held = this.kindsInGame.has('tapArtifacts') ? this.heldTapped() : null;
    for (const perm of p.battlefield) {
      if (held?.has(perm.id) && perm.tapped) continue;
      if (perm.stun && perm.tapped) perm.stun--;
      else if (perm.tapped && perm.landInfo && !untapLimit(perm)) { /* Back to Basics, Winter Orb */ }
      else if (!perm.card.noUntap) perm.tapped = false;
    }
    this.step = 'upkeep';
    this.cumulativeUpkeep(p);
    this.fireStep(p, 'upkeep');
    if (this.kindsInGame.has('when:eachUpkeep')) for (const q of this.players) if (q.alive) this.fire(q, 'eachUpkeep');
    yield* this.priority();
    if (this.stopped(p)) return;
    this.step = 'draw';
    this.draw(p, 1);
    yield* this.priority();
  }

  /** Kill Switch: ids of the artifacts held tapped by a tapped Kill Switch. A Kill Switch that is untapped lets go of them. */
  private heldTapped(): Set<number> {
    const out = new Set<number>();
    for (const q of this.allPerms()) {
      if (!q.holdsTapped) continue;
      if (!q.tapped) q.holdsTapped = undefined;
      else for (const id of q.holdsTapped) out.add(id);
    }
    return out;
  }

  private stopped(p: PlayerState): boolean {
    return this.over || !p.alive;
  }

  private *turn(p: PlayerState): Flow<void> {
    this.activeSeat = p.seat;
    this.turnNumber++;
    p.turnsTaken = (p.turnsTaken ?? 0) + 1;
    this.triggerBudget = 300;
    this.lifeLostThisTurn.fill(0);
    // "Until your next turn" flash (Teferi, Time Raveler) ends as this turn begins; "this turn" ones are long gone.
    if (p.flashGrants) p.flashGrants = p.flashGrants.filter((f) => f.until === 'turn' && f.turn === this.turnNumber);

    // Untap step (502). No player gets priority.
    this.step = 'untap';
    this.silenced.clear();
    if (this.anyLocked || this.kindsInGame.has('becomeCreature')) this.endUntilYourTurn(p);
    this.fogAll = false;
    for (const q of this.players) {
      q.fogged = undefined;
      // Deflecting Palm lasts "this turn".
      q.preventNext = undefined;
    }
    const untapLimit = this.untapLimits(p);
    // Stasis: the untap step is skipped. Meekstone: creatures with power 3 or more stay tapped.
    const untapRules = this.untapRules();
    // Kill Switch: artifacts it tapped stay tapped while it is tapped (checked before anything untaps: they all untap at once, rule 502.3).
    const held = this.kindsInGame.has('tapArtifacts') ? this.heldTapped() : null;
    for (const perm of p.battlefield) {
      perm.sick = false;
      if (untapRules.has('none')) continue;
      if (held?.has(perm.id) && perm.tapped) continue;
      // A stun counter is removed instead of untapping (rule 122.1d).
      if (perm.stun && perm.tapped) perm.stun--;
      else if (perm.tapped && perm.landInfo && !untapLimit(perm)) { /* Back to Basics, Winter Orb */ }
      else if (perm.tapped && untapRules.has('bigCreatures') && perm.card.isCreature && this.power(perm) >= 3) { /* Meekstone */ }
      else if (!perm.card.noUntap) perm.tapped = false;
    }
    // Seedborn Muster, Unwinding Clock: other players' permanents untap in this untap step too.
    if (this.kindsInGame.has('untapAlways')) {
      for (const q of this.opponents(p)) {
        for (const src of q.battlefield) for (const e of src.card.effects) {
          if (e.kind !== 'untapAlways' || e.when !== 'static') continue;
          for (const perm of q.battlefield) {
            if (perm.stun || held?.has(perm.id) || !(e.what === 'all' || (e.what === 'artifacts' && perm.card.isArtifact) || (e.what === 'self' && perm === src))) continue;
            perm.tapped = false;
          }
        }
      }
    }
    for (const q of this.players) {
      for (const perm of q.battlefield) {
        perm.usedThisTurn = [];
        perm.activations = 0;
        perm.loyaltyUsed = false;
        // Goad lasts until the goading player's next turn (rule 701.15a).
        if (perm.goadedBy) {
          perm.goadedBy = perm.goadedBy.filter((s) => s !== p.seat || perm.goadForever === s);
          if (!perm.goadedBy.length) perm.goadedBy = undefined;
        }
      }
    }
    if (this.attackOrders.length) this.attackOrders = this.attackOrders.filter((o) => !(o.until === 'nextTurn' && o.seat === p.seat) && !(o.until === 'turn' && o.turn !== this.turnNumber));
    p.landsPlayed = 0;
    p.graveyardTypes = undefined;
    p.shielded = false;
    for (const q of this.players) {
      q.spellsThisTurn = 0;
      q.drawsThisTurn = 0;
      q.creatureSpellsThisTurn = 0;
      q.instantSorceryThisTurn = 0;
      q.energyPaid = 0;
    }
    this.diedThisTurn = 0;

    // Upkeep step (503).
    this.step = 'upkeep';
    this.cumulativeUpkeep(p);
    if (this.pacts.length) this.payPacts(p);
    // Suspend (rule 702.62): a time counter comes off each suspended card; with the last, it is cast.
    if (p.held?.some((h) => h.way === 'suspend')) this.suspendUpkeep(p);
    if (this.kindsInGame.has('upkeepCost')) this.upkeepCosts(p);
    this.fireStep(p, 'upkeep');
    this.graveyardMark = this.players.map((q) => q.graveyard.length);
    if (this.anyCurse) {
      this.curseEvent(p, 'theirUpkeep');
      // Curse of Misfortunes: "at the beginning of your upkeep", on whichever player it enchants.
      for (const q of this.alivePlayers()) this.curseEvent(q, 'yourUpkeep', undefined, p);
    }
    // "At the beginning of each upkeep" (Midnight Clock): every player's permanents, in turn order.
    if (this.kindsInGame.has('when:eachUpkeep')) for (const q of this.players) if (q.alive) this.fire(q, 'eachUpkeep');
    if (this.winconSeats.has(p.seat)) this.upkeepWins(p);
    yield* this.priority();
    if (this.stopped(p)) return;

    // Draw step (504). Only in a two-player game does the first player skip it (rule 103.8).
    this.step = 'draw';
    if (!(this.turnNumber === 1 && this.players.length === 2)) this.draw(p, 1);
    this.fireStep(p, 'draw');
    if (this.anyCurse) this.curseEvent(p, 'theirDraw');
    yield* this.priority();
    if (this.stopped(p)) return;

    this.step = 'main1';
    // Sagas get a lore counter as the precombat main phase begins (rule 714.3b).
    for (const perm of p.battlefield) if (perm.card.saga) this.addLore(p, perm);
    this.fireStep(p, 'main1');
    yield* this.priority();
    if (this.stopped(p)) return;

    // Combat, then the postcombat main phase. Additional combat (and main) phases are added to `phases` (rule 500.8).
    this.phases = ['combat', 'main'];
    this.extraBeginnings = 0;
    this.combatsThisTurn = 0;
    this.untapAttackersEachCombat = false;
    while (this.phases.length) {
      const phase = this.phases.shift()!;
      if (phase === 'combat') {
        this.combatsThisTurn++;
        if (this.combatsThisTurn > 1) this.say(`${p.name} begins an additional combat phase.`);
        yield* this.combat(p);
        this.endCombat();
      } else if (phase === 'beginning') {
        yield* this.extraBeginning(p);
      } else {
        this.step = 'main2';
        // Sphinx of the Second Sun: "at the beginning of each of your postcombat main phases".
        if (this.kindsInGame.has('when:postcombatMain')) this.fire(p, 'postcombatMain');
        yield* this.priority();
      }
      if (this.stopped(p)) return;
    }

    this.step = 'end';
    for (const id of this.unearthed) {
      const perm = this.findPerm(id);
      if (perm) {
        this.say(`${perm.card.name} is exiled (unearth).`);
        this.removePerm(perm, 'exile');
      }
    }
    this.unearthed.clear();
    // Dash: the creature returns to its owner's hand at the beginning of the end step (rule 702.109a).
    for (const perm of [...p.battlefield]) {
      // Reinforced Ronin: "at the beginning of your end step, return ~ to its owner's hand".
      const own = perm.card.effects.some((e) => e.kind === 'bounceSelfAtEnd');
      if (!perm.dashed && !own) continue;
      this.say(`${perm.card.name} returns to ${p.name}'s hand${own ? '' : ' (dash)'}.`);
      this.removePerm(perm, 'hand');
    }
    // The Endstone: "your life total becomes half your starting life total, rounded up" (rule 119.5).
    for (const perm of p.battlefield) for (const e of perm.card.effects) {
      if (e.kind !== 'lifeBecomes' || p.life === e.n) continue;
      if (p.life > e.n) this.loseLife(p, p.life - e.n, p, 'noncombat');
      else p.life = e.n;
      this.say(`${p.name}'s life total becomes ${e.n} (${perm.card.name}).`);
    }
    this.questCounters();
    // Blitz, warp and impending (rules 702.152, 702.185, 702.176).
    this.castingEndStep(p);
    this.endStepCleanup();
    if (this.anyCurse) {
      this.curseEvent(p, 'theirEnd');
      for (const q of this.alivePlayers()) this.curseEvent(q, 'eachEnd');
    }
    // Lynde: Curses put into her controller's graveyard come back attached to that player.
    if (this.curseReturns.length) yield* this.returnCurses();
    // Cosmic Intervention, The Locust God: "at the beginning of the next end step".
    if (this.endReturns.length) yield* this.returnAtEnd();
    if (this.monarch === p.seat) {
      this.say(`${p.name} draws a card as the monarch.`);
      this.draw(p, 1);
    }
    this.endTemporaryTokens();
    this.endStepSacrifices();
    this.fireStep(p, 'end');
    yield* this.priority();
    if (this.stopped(p)) return;

    // Cleanup step (514): discard to hand size, then damage and "until end of turn" effects wear off.
    this.step = 'cleanup';
    const maxHand = this.maxHandSize(p);
    if (p.hand.length > maxHand && this.statics(p, 'noMaxHand') === 0) {
      const n = p.hand.length - maxHand;
      const picks = yield* this.choose(p, 'discard', `Discard ${n} card${n > 1 ? 's' : ''} (hand size is ${maxHand}).`, p.hand.map((card) => ({ label: card.name, card })), n, n);
      const cards = picks.map((i) => p.hand[i]);
      for (const c of cards) {
        p.hand.splice(p.hand.indexOf(c), 1);
        this.discarded(p, c, true);
      }
      this.say(`${p.name} discards ${cards.map((c) => c.name).join(', ')}.`);
    }
    if (this.kindsInGame.has('mayPlay')) this.pruneMayPlay();
    for (const q of this.players) {
      for (const perm of q.battlefield) {
        perm.damage = 0;
        perm.deathtouched = false;
        perm.tempP = 0;
        perm.tempT = 0;
        perm.tempKw = [];
        perm.fogged = undefined;
        if (perm.uncrewed && perm.animatedUntil === undefined) {
          perm.card = perm.uncrewed;
          perm.uncrewed = undefined;
        }
      }
    }
    if (this.kindsInGame.has('becomeCreature')) this.endTreasureCreatures();
    this.endOfTurnControl(p);
    yield* this.checkState();
  }

  /** `quiet`: don't set off "whenever an opponent draws" (used for draws those abilities cause, so two can't feed each other). */
  draw(p: PlayerState, n: number, quiet = false) {
    for (let i = 0; i < n; i++) {
      // Narset, Notion Thief, Teferi's Ageless Insight (replacement effects apply once per draw, rule 614.5).
      if (this.kindsInGame.has('drawRule') && !quiet) {
        const rule = this.drawRule(p);
        if (rule === 'limit') return;
        if (rule !== null && typeof rule === 'object') {
          this.say(`${rule.thief.name} draws instead of ${p.name}.`);
          this.draw(rule.thief, 1, true);
          continue;
        }
        if (rule === 'double') {
          this.draw(p, 1, true);
          this.say(`${p.name} draws an extra card.`);
        }
      }
      const c = p.library.shift();
      if (!c) {
        if (this.statics(p, 'winOnEmptyDraw') > 0) {
          this.winGame(p, 'drawing from an empty library');
          return;
        }
        // Out of the Tombs: a creature card comes back from the graveyard instead; with none, the player loses.
        if (this.statics(p, 'emptyDrawReanimate') > 0) {
          const creatures = p.graveyard.filter((card) => card.isCreature);
          if (creatures.length) {
            const back = creatures.reduce((a, b) => (b.value > a.value ? b : a));
            p.graveyard.splice(p.graveyard.indexOf(back), 1);
            const perm = this.put(p.seat, back, { sick: true });
            this.say(`${p.name} would draw from an empty library and returns ${back.name} to the battlefield instead.`);
            this.creatureEntered(p, perm);
            continue;
          }
          p.lost = true;
          this.say(`${p.name} has no creature card to return and loses the game.`);
          return;
        }
        // Rule 704.5b: loses the next time state-based actions are checked.
        p.drewFromEmpty = true;
        return;
      }
      p.hand.push(c);
      p.drawnNames.add(c.name);
      p.drawsThisTurn++;
      if (this.turnNumber === 0) continue;
      // Miracle (rule 702.94): the first card drawn this turn may be cast for its miracle cost right away.
      if (c.casting?.miracle && p.drawsThisTurn === 1) {
        (p.windows ??= []).push({ card: c, how: 'miracle' });
        this.say(`${p.name} reveals ${c.name} (miracle).`);
      }
      if (this.kindsInGame.has('when:draw')) this.fire(p, 'draw');
      if (this.anyCurse) this.curseEvent(p, 'draws');
      if (quiet) continue;
      for (const o of this.players) {
        if (o === p || !o.alive) continue;
        for (const perm of o.battlefield) {
          // "Whenever an opponent draws their second card each turn" (Faerie Mastermind) counts that player's draws.
          const hits = perm.card.effects.filter((e) => e.when === 'opponentDraw' && (e.nth === undefined || e.nth === p.drawsThisTurn));
          if (hits.length) this.trigger(o, perm.card, perm.id, hits, 0, null, undefined, undefined, p.seat);
        }
      }
    }
  }

  /**
   * What happens to `p`'s next draw: nothing (null), it doesn't happen ('limit': Narset), an opponent draws
   * instead (Notion Thief), or it becomes two ('double': Teferi's Ageless Insight). The first card of the
   * draw step is exempt from the last two.
   */
  private drawRule(p: PlayerState): 'limit' | 'double' | { thief: PlayerState } | null {
    const rules = (q: PlayerState) => q.battlefield.flatMap((perm) => perm.card.effects.filter((e): e is Extract<Effect, { kind: 'drawRule' }> => e.kind === 'drawRule' && e.when === 'static'));
    const opponents = this.opponents(p);
    if (p.drawsThisTurn >= 1 && opponents.some((o) => rules(o).some((e) => e.rule === 'limit'))) return 'limit';
    if (this.step === 'draw' && this.activeSeat === p.seat && p.drawsThisTurn === 0) return null;
    const thief = opponents.find((o) => rules(o).some((e) => e.rule === 'steal'));
    if (thief) return { thief };
    return rules(p).some((e) => e.rule === 'double') ? 'double' : null;
  }

  /** How many of a static effect `p` controls, or everyone controls when `p` is null. */
  /** Maximum hand size (rule 402.2): seven, changed by Gnat Miser, Jin-Gitaxias and the like. */
  private maxHandSize(p: PlayerState): number {
    if (!this.kindsInGame.has('handSize')) return MAX_HAND;
    let n = MAX_HAND;
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) for (const e of perm.card.effects) {
        if (e.kind === 'handSize' && e.when === 'static' && ((e.who === 'opponents') === (q !== p))) n += e.n;
      }
    }
    return Math.max(0, n);
  }

  private statics(p: PlayerState | null, kind: Effect['kind']): number {
    if (!this.kindsInGame.has(kind)) return 0;
    const m = this.memo;
    if (!m) return this.staticsNow(p, kind);
    const key = `${p ? p.seat : 'all'}:${kind}`;
    const kept = m.statics.get(key);
    if (kept === undefined) {
      const v = this.staticsNow(p, kind);
      m.statics.set(key, v);
      return v;
    }
    return verifyMemo ? checkMemo(`statics ${key}`, kept, this.staticsNow(p, kind)) : kept;
  }

  private staticsNow(p: PlayerState | null, kind: Effect['kind']): number {
    let n = 0;
    for (const q of p ? [p] : this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) for (const e of perm.card.effects) if (e.kind === kind && e.when === 'static') n++;
    }
    return n;
  }

  /**
   * `p` sacrificed a permanent: "whenever you sacrifice" abilities trigger, and so do their opponents'
   * "whenever an opponent sacrifices a nontoken permanent" (Tergrid, It That Betrays), about that card.
   */
  /** "Whenever an artifact (enchantment) is put into a graveyard from the battlefield": `card` null is a Treasure token. */
  private permDied(card: SimCard | null, seat: number) {
    for (const q of this.alivePlayers()) for (const w of q.battlefield) {
      const hits = w.card.effects.filter((e) => e.when === 'permDies' && (e.scope === 'all' || q.seat === seat)
        && (e.castFilter === 'enchantment' ? !!card?.isEnchantment : !card || card.isArtifact));
      if (hits.length) this.trigger(q, w.card, w.id, hits);
    }
  }

  private sacrificed(p: PlayerState, gone?: Perm) {
    this.fire(p, 'sacrifice');
    // Trail of Crumbs, Camellia: "whenever you sacrifice a Food".
    if (gone && isFood(gone.card) && this.kindsInGame.has('when:sacrificeFood')) this.fire(p, 'sacrificeFood');
    // Mayhem Devil: "whenever a player sacrifices a permanent"; Bloodroot Apothecary: "whenever an opponent sacrifices".
    if (this.kindsInGame.has('when:playerSacrifice')) {
      for (const q of this.alivePlayers()) for (const perm of q.battlefield) {
        const hits = perm.card.effects.filter((e) => e.when === 'playerSacrifice' && (e.scope !== 'opponents' || q !== p));
        if (hits.length) this.trigger(q, perm.card, perm.id, hits, 0, null, undefined, undefined, p.seat);
      }
    }
    if (gone && !gone.token && !gone.parts && this.kindsInGame.has('when:opponentSacrifice')) {
      const about: About = { card: realCard(gone), owner: gone.owner ?? gone.seat };
      for (const o of this.opponents(p)) {
        for (const perm of o.battlefield) {
          const hits = perm.card.effects.filter((e) => e.when === 'opponentSacrifice');
          if (hits.length) this.trigger(o, perm.card, perm.id, hits, 0, null, undefined, about);
        }
      }
    }
  }

  /** Satya's token copies: sacrificed at the next end step unless their controller pays energy equal to the mana value. */
  private endTemporaryTokens() {
    for (const q of this.players) {
      for (const perm of q.battlefield.filter((x) => x.temporary)) {
        if (q.energy >= perm.card.cmc) {
          q.energy -= perm.card.cmc;
          perm.temporary = false;
          this.say(`${q.name} pays ${perm.card.cmc} energy to keep the ${perm.card.name} token.`);
        } else {
          this.removePerm(perm, 'graveyard');
          this.sacrificed(q, perm);
        }
      }
    }
  }

  /** `p` becomes the monarch (rule 724), which some opponents' abilities watch for. */
  private setMonarch(p: PlayerState) {
    if (this.monarch === p.seat) return;
    this.monarch = p.seat;
    this.say(`${p.name} becomes the monarch.`);
    // "For as long as they're the monarch" ends now (rule 611.2b).
    if (this.anyHeld) for (const q of this.allPerms()) if (q.heldWhileMonarch !== undefined && q.heldWhileMonarch !== p.seat) this.giveBack(q);
    if (this.kindsInGame.has('when:opponentMonarch')) for (const o of this.opponents(p)) this.fire(o, 'opponentMonarch');
  }

  // -------------------------------------------------------------------------
  // Priority (rule 117)
  // -------------------------------------------------------------------------

  /**
   * Run `fn`, which only looks at the game and changes nothing on the table, remembering
   * power, toughness, keywords, attachments and static abilities as they are worked out.
   * Bots deciding, listing legal actions and checking creature deaths ask for the same
   * answers thousands of times a game.
   */
  readOnly<T>(fn: () => T): T {
    if (this.memoDepth++ === 0) this.memo = { power: new Map(), toughness: new Map(), kw: new Map(), attached: null, statics: new Map(), staticsOf: new Map(), manaSources: new Map(), anthems: new Map(), curses: new Map() };
    try {
      return fn();
    } finally {
      if (--this.memoDepth === 0) this.memo = null;
    }
  }

  /**
   * Players get priority in turn order, starting with the active player. When
   * everyone passes in a row, the top of the stack resolves, or, if the stack
   * is empty, the step ends (rule 117.4).
   */
  private *priority(): Flow<void> {
    let passes = 0;
    let seat = this.activeSeat;
    for (let guard = 0; guard < 2000; guard++) {
      // State-based actions, then waiting triggers go on the stack (rule 117.5).
      yield* this.checkState();
      if (this.over) return;
      const p = this.players[seat];
      if (!p.alive) {
        // The active player left the game: finish what is on the stack, then end the turn.
        if (seat === this.activeSeat && !this.stack.length) return;
        seat = this.nextAliveSeat(seat);
        continue;
      }

      // Suspended cards whose last time counter came off, hideaway, cipher copies: cast now, as their abilities resolve.
      if (this.pendingCasts.length) {
        yield* this.castPending();
        continue;
      }

      const actions = this.legalActions(p);
      if (actions.length > 1) {
        const answer = yield* ask<PriorityAnswer | null>({ kind: 'priority', seat, actions });
        const chosen = actions[answer?.action ?? 0] ?? PASS;
        if (chosen.type !== 'pass') {
          // A player who acts keeps priority (rule 117.3c). A cast that was taken back changes nothing.
          if (yield* this.perform(p, chosen, answer?.x ?? 0)) passes = 0;
          continue;
        }
      }
      // Madness and miracle: passing means the card wasn't cast that way.
      if (p.windows?.length) this.closeWindows(p);

      passes++;
      if (passes >= this.alivePlayers().length) {
        if (!this.stack.length) return;
        yield* this.resolveTop();
        passes = 0;
        seat = this.activeSeat; // rule 117.3b
      } else {
        seat = this.nextAliveSeat(seat);
      }
    }
  }

  /** May this player cast sorcery-speed spells right now? (rule 307.1) */
  sorcerySpeed(p: PlayerState): boolean {
    return this.activeSeat === p.seat && this.stack.length === 0 && (this.step === 'main1' || this.step === 'main2');
  }

  /** Everything `p` may do with priority. The first entry is always "pass". */
  legalActions(p: PlayerState): Action[] {
    return this.readOnly(() => this.legalActionsNow(p));
  }

  private legalActionsNow(p: PlayerState): Action[] {
    const actions: Action[] = [PASS];
    const sorcery = this.sorcerySpeed(p);

    if (sorcery && p.landsPlayed < 1 + this.statics(p, 'extraLand')) {
      for (const card of new Set(p.hand)) {
        if (card.isLand && card.land) actions.push({ type: 'land', card, back: false });
        else if (card.backLand) actions.push({ type: 'land', card, back: true });
      }
      // Crucible of Worlds, Muldrotha: lands from the graveyard.
      if (this.kindsInGame.has('graveyardPlay')) {
        for (const card of new Set(p.graveyard)) if (card.isLand && card.land && this.graveyardPermission(p, card)) actions.push({ type: 'land', card, back: false, fromGraveyard: true });
      }
    }

    const mana = this.availableMana(p);
    // Rule of Law: one spell a turn. Drannith Magistrate: no casting from the command zone.
    const mayCast = !(p.spellsThisTurn >= 1 && this.statics(null, 'spellLimit') > 0);
    const locked = this.opponents(p).some((o) => this.statics(o, 'commandLock') > 0);
    let mutateHosts: boolean | undefined;
    // Looked up once per call: scanning every battlefield for each card is what slowed games after the lockouts landed.
    const castLockers = this.staticsOf('castLock');
    const castLocks = this.silenced.size > 0 || castLockers.length > 0;
    const consider = (card: SimCard, from: CastFrom, mutate = false, kick = 0, modes = 0, door = false): boolean => {
      if (card.isLand || !mayCast || (from === 'command' && locked)) return false;
      if (!this.castTimingOk(p, card, from, sorcery)) return false;
      // Silence, Teferi, Void Winnower, Grand Abolisher (rule 101.2).
      if (castLocks && this.castLocked(p, card, from, castLockers)) return false;
      if (mutate && !(mutateHosts ??= this.mutateTargets(p).length > 0)) return false;
      // Spree and tiered spells are cast with their modes chosen (rule 702.172).
      if (card.casting?.spree && !modes) return false;
      if (kick && !this.optionalCostPayable(p, card)) return false;
      const fromCommand = from === 'command';
      const priced = modes ? this.spreeCard(card, modes) : kick ? this.kickedCard(card, kick) : from === 'alt' && card.altCost?.emerge ? this.emergeCard(card, this.emergeDiscount(p, card)) : this.castCard(card, door ? 'door' : mutate ? 'mutate' : from, p.seat);
      if (mana < this.effectiveCost(p, priced, fromCommand)) return false;
      if (!this.canAfford(p, priced, fromCommand, 0)) return false;
      if (from !== 'overload' && !this.hasTargets(p, kick || modes || from === 'alt' || from === 'foretell' ? priced : card)) return false;
      const maxX = this.maxX(p, priced, fromCommand);
      // Kicker {X}: "X can't be 0" (Thieving Skydiver).
      if (kick && card.kicker!.cost.x > 0 && maxX < 1) return false;
      actions.push({ type: 'cast', card, from, maxX, ...(mutate ? { mutate } : {}), ...(kick ? { kick } : {}), ...(modes ? { modes } : {}), ...(door ? { door } : {}) });
      return true;
    };
    /** Kicker, multikicker and offspring: the same spell with the extra cost paid once (or, for multikicker, up to eight times). */
    const kicked = (card: SimCard, from: 'hand' | 'command') => {
      if (!card.kicker) return;
      for (let k = 1; k <= (card.kicker.multi ? 8 : 1); k++) if (!consider(card, from, false, k)) break;
    };
    for (const card of new Set(p.commandZone)) {
      consider(card, 'command');
      kicked(card, 'command');
      if (card.mutate) consider(card, 'command', true);
    }
    for (const card of new Set(p.hand)) {
      consider(card, 'hand');
      kicked(card, 'hand');
      if (card.overload) consider(card, 'overload');
      if (card.altCost && this.altCostAllowed(p, card)) consider(card, 'alt');
      if (card.mutate) consider(card, 'hand', true);
      // Rooms: either door may be cast (rule 709.5d).
      if (card.room) consider(card, 'hand', false, 0, 0, true);
      if (card.casting?.spree) for (const modes of spreeChoices(card)) consider(card, 'hand', false, 0, modes);
      // Morph and disguise: cast face down as a 2/2 for {3} (rule 702.37c).
      if (card.morph && sorcery && mayCast && !(castLocks && this.castLocked(p, card, 'hand', castLockers)) && this.canAfford(p, this.castCard(card, 'faceDown'), false, 0)) actions.push({ type: 'cast', card, from: 'hand', maxX: 0, faceDown: true });
    }
    // Foretold, plotted and warped cards: from exile, on a later turn (rules 702.143, 702.170, 702.185).
    const fromExile = new Set<string>();
    for (const h of p.held ?? []) {
      if (h.way === 'suspend' || h.turn >= this.turnNumber || fromExile.has(`${h.way}:${h.card.name}`)) continue;
      fromExile.add(`${h.way}:${h.card.name}`);
      consider(h.card, h.way);
    }
    // Madness and miracle: for that cost, right after the card was discarded or drawn.
    for (const w of p.windows ?? []) consider(w.card, w.how);
    // Foretell, plot, suspend, transmute and channel from hand.
    for (const card of new Set(p.hand)) if (card.casting) for (const how of this.handUses(p, card, sorcery, mayCast)) actions.push({ type: 'hand', card, how });
    const seen = new Set<SimCard>();
    for (const card of p.graveyard) {
      if (seen.has(card)) continue;
      seen.add(card);
      if (this.graveyardCastable(p, card)) consider(card, 'graveyard');
      if (card.mutate?.fromGraveyard) consider(card, 'graveyard', true);
      if (card.graveyard?.how === 'return' && this.canReturnFromGraveyard(p, card, sorcery)) actions.push({ type: 'graveyard', card });
    }
    seen.clear();
    // Impulse draw and theft (rule 611.2), Future Sight and friends.
    if (this.kindsInGame.has('mayPlay') || this.kindsInGame.has('playTop')) this.exileActions(p, sorcery, actions, (card, from) => consider(card, from));
    // One with the Multiverse: one spell from hand or the top of the library without paying its mana cost, each turn.
    if (mayCast && this.freeSpellAvailable(p)) {
      const tops = this.topPermission(p) ? [p.library[0]] : [];
      for (const card of new Set([...p.hand, ...tops])) {
        if (card.isLand || (!sorcery && !isInstantSpeed(card)) || !this.castableNow(p, card, 'free')) continue;
        actions.push({ type: 'cast', card, from: card === tops[0] && !p.hand.includes(card) ? 'library' : 'hand', maxX: 0, free: true });
      }
    }
    seen.clear();
    // Cycling works at any time you have priority (rule 702.29).
    for (const card of p.hand) {
      if (card.cycling && !seen.has(card) && this.planPayment(p, card.cycling.cost, 0, 0) !== null) {
        seen.add(card);
        actions.push({ type: 'cycle', card });
      }
    }

    const abilityLockers = this.staticsOf('abilityLock');
    for (const perm of p.battlefield) {
      // Cursed Totem, Karn, Grand Abolisher: none of this permanent's abilities can be activated (crew, station and levels are abilities too).
      if (abilityLockers.length && this.abilitiesLocked(p, perm.card, abilityLockers)) {
        const up = this.faceUpCost(perm);
        if (up && this.planPayment(p, up, 0, 0) !== null) actions.push({ type: 'turnFaceUp', permId: perm.id });
        continue;
      }
      for (const effect of perm.card.effects) {
        if (this.canActivate(p, perm, effect, sorcery, false)) actions.push({ type: 'activate', permId: perm.id, effect });
      }
      if (perm.card.isPlaneswalker) for (const effect of this.grantedLoyalty(p)) if (this.canActivate(p, perm, effect, sorcery, false)) actions.push({ type: 'activate', permId: perm.id, effect });
      // Ygra: every other creature is a Food with "{2}, {T}, Sacrifice this permanent: You gain 3 life."
      if (this.foodAbility(perm) && this.canActivate(p, perm, FOOD, sorcery, false)) actions.push({ type: 'activate', permId: perm.id, effect: FOOD });
      // Turning a face-down permanent face up is a special action, any time you have priority (rule 116.2b).
      const up = this.faceUpCost(perm);
      if (up && this.planPayment(p, up, 0, 0) !== null) actions.push({ type: 'turnFaceUp', permId: perm.id });
      // Crew, kept simple: in your first main phase, so the Vehicle can attack.
      // Crew is an activated ability: any time its controller has priority (rule 702.122a), say to block with the Vehicle.
      if (perm.card.crew && this.crewFor(p, perm)) actions.push({ type: 'crew', permId: perm.id });
      // Station (rule 702.184a): tap another untapped creature to add charge counters, as a sorcery, until the last threshold.
      if (sorcery && this.stationRoom(perm) && this.stationCrew(p, perm).length) actions.push({ type: 'station', permId: perm.id });
      // Rooms: a locked door is unlocked for its mana cost as a sorcery (rule 709.5e).
      if (sorcery && perm.card.room && this.planPayment(p, perm.card.room.door.cost, 0, this.unlockDiscount(p)) !== null) actions.push({ type: 'unlock', permId: perm.id });
      // Classes gain their next level as a sorcery (rule 716.2a).
      const next = sorcery ? this.nextLevel(perm) : undefined;
      if (next && this.planPayment(p, next.cost, 0, 0) !== null) actions.push({ type: 'level', permId: perm.id });
    }
    // Ninjutsu: once blockers are declared, swap a ninja in for an unblocked attacker (rule 702.49a).
    if (this.step === 'declareBlockers' && this.activeSeat === p.seat) {
      const unblocked = p.battlefield.filter((q) => q.attacking !== null && !q.blocked);
      if (unblocked.length) {
        const ninjas = [...new Set(p.hand), ...p.commandZone.filter((c) => c.ninjutsu?.commander)].filter((c) => c.ninjutsu && this.planPayment(p, c.ninjutsu.cost, 0, 0) !== null);
        for (const card of ninjas) for (const q of unblocked) actions.push({ type: 'ninjutsu', card, permId: q.id });
      }
    }
    return actions;
  }

  /** The level a Class would gain next, if any. */
  nextLevel(perm: Perm): NonNullable<SimCard['levels']>[number] | undefined {
    const levels = (perm.printed ?? perm.card).levels;
    return levels?.find((l) => l.level === (perm.level ?? 1) + 1);
  }

  /** Can `p` cast this card for its alternative cost right now? */
  private altCostAllowed(p: PlayerState, card: SimCard): boolean {
    const a = card.altCost!;
    if (a.notYourTurn && this.activeSeat === p.seat) return false;
    if (a.opponentSpells && !this.opponents(p).some((o) => o.spellsThisTurn >= a.opponentSpells!)) return false;
    if (a.creatures && this.allPerms().filter((q) => q.card.isCreature).length < a.creatures) return false;
    if (a.life && p.life <= a.life) return false;
    if (a.pitch && !p.hand.some((h) => h !== card && pitchable(h, a.pitch!))) return false;
    if (a.returnIslands && this.islands(p).length < a.returnIslands) return false;
    if (a.prowl && p.rogueHit !== this.turnNumber) return false;
    if (a.emerge && !this.emergeFodder(p, card).length) return false;
    return true;
  }

  private islands(p: PlayerState): Perm[] {
    return p.battlefield.filter((q) => q.landInfo && /\bIsland\b/.test(q.card.typeLine));
  }

  /** `checkLock` is false when the caller already skipped permanents whose abilities are locked. */
  private canActivate(p: PlayerState, perm: Perm, e: Effect, sorcery: boolean, checkLock = true): boolean {
    if (perm.activations >= 20) return false;
    if (checkLock && this.kindsInGame.has('abilityLock') && this.abilitiesLocked(p, perm.card)) return false;
    if (e.kind === 'equip') {
      // Equip: sorcery speed, target creature you control (rule 702.6).
      if (e.aura || !sorcery) return false;
      if (!p.battlefield.some((q) => q.card.isCreature && q.id !== perm.attachedTo && q !== perm)) return false;
      return this.planPayment(p, e.cost ?? DEFAULT_EQUIP, 0, 0, undefined, true) !== null;
    }
    if (e.when === 'loyalty') {
      // One loyalty ability per planeswalker per turn, at sorcery speed (rule 606.3).
      if (!sorcery || perm.loyaltyUsed || perm.loyalty === undefined) return false;
      if ((e.loyalty ?? 0) < 0 && perm.loyalty < -(e.loyalty ?? 0)) return false;
      // "-X": X can be anything up to its loyalty; zero would do nothing.
      if (e.loyaltyX && perm.loyalty < 1) return false;
      const targets = this.aimAs(perm.card, p.seat, true, () => this.targetCandidates(p, e, perm));
      return targets === null || targets.length > 0;
    }
    if (e.when !== 'activated' || !e.activation) return false;
    // Boast: only once this creature attacked this turn, and once each turn (rule 702.142).
    if (e.activation.boast && (perm.attackedTurn !== this.turnNumber || perm.usedThisTurn.includes(e))) return false;
    if (e.kind === 'transform' && (e.rider || !sorcery || !perm.card.back)) return false;
    // The Darkness Crystal: only with a creature card exiled with it.
    if (e.kind === 'reanimateExiled' && !(this.exiledWith.get(perm.id) ?? []).some((r) => this.players[r.owner].exile.includes(r.card))) return false;
    const act = e.activation;
    if (act.tap && (perm.tapped || (perm.sick && perm.card.isCreature && !this.hasKw(perm, 'haste')))) return false;
    if (act.cost.life >= p.life && act.cost.life > 0) return false;
    if (act.sorcery && !sorcery) return false;
    if (act.energy && p.energy < Math.max(1, act.energy)) return false;
    if (act.charge && (perm.charge ?? 0) < act.charge) return false;
    if (act.discard && p.hand.length < act.discard) return false;
    // Devoted Druid: never put on the counter that kills it.
    if (act.shrinkSelf && this.toughness(perm) - act.shrinkSelf < 1) return false;
    if (act.removeCounters && this.counterPool(p, perm, act.removeCounters.from) < act.removeCounters.n) return false;
    if (act.sacCreature && !p.battlefield.some((q) => q.card.isCreature)) return false;
    if (act.sacOther && this.sacOtherChoices(p, act.sacOther.what, act.sacrifice ? perm : undefined).length < act.sacOther.n) return false;
    if (act.tapCreatures && p.battlefield.filter((q) => q.card.isCreature && !q.tapped && !(act.tap && q === perm)).length < act.tapCreatures) return false;
    if (this.planPayment(p, act.cost, 0, this.abilityDiscount(p, perm, e), act.tap ? perm : undefined, true) === null) return false;
    const candidates = this.aimAs(perm.card, p.seat, true, () => this.targetCandidates(p, e, perm));
    return candidates === null || candidates.length > 0;
  }

  /** Does every targeted part of this spell have something to target? (rule 601.2c) */
  private hasTargets(p: PlayerState, card: SimCard): boolean {
    if (card.isInstant || card.isSorcery) {
      for (const e of card.effects) {
        if (e.when !== 'resolve') continue;
        const candidates = this.aimAs(card, p.seat, false, () => this.targetCandidates(p, e, null));
        if (candidates !== null && candidates.length === 0) return false;
      }
      return true;
    }
    if (isAura(card)) return this.aimAs(card, p.seat, false, () => this.auraCandidates(p)).length > 0;
    return true;
  }

  private *perform(p: PlayerState, action: Action, x: number): Flow<boolean> {
    switch (action.type) {
      case 'land': {
        if (action.from) return this.sorcerySpeed(p) && p.landsPlayed < 1 + this.statics(p, 'extraLand') && this.playLandFrom(p, action.card, action.from);
        const zone = action.fromGraveyard ? p.graveyard : p.hand;
        const idx = zone.indexOf(action.card);
        if (idx === -1 || (action.fromGraveyard && !this.graveyardPermission(p, action.card))) return false;
        if (action.fromGraveyard) this.useGraveyardPermission(p, action.card);
        zone.splice(idx, 1);
        const info = action.back ? action.card.backLand! : action.card.land!;
        this.say(`${p.name} plays ${action.back ? action.card.backLand!.name : action.card.name}${action.fromGraveyard ? ' from their graveyard' : ''}.`);
        this.putLand(p, action.card, info);
        p.landsPlayed++;
        p.castNames.add(action.card.name);
        return true;
      }
      case 'cast':
        if (action.faceDown) return this.castFaceDown(p, action.card);
        if (action.free) {
          if (!this.freeSpellAvailable(p)) return false;
          const zone = action.from === 'library' ? p.library : p.hand;
          if (action.from === 'library' && p.library[0] !== action.card) return false;
          const done = yield* this.cast(p, action.card, false, 0, 'hand', false, 0, { zone, owner: p, mode: 'free', label: action.from === 'library' ? ' from the top of their library' : '' });
          if (done) p.freeSpellTurn = this.turnNumber;
          return done;
        }
        return yield* this.cast(p, action.card, action.from === 'command', Math.max(action.kick && action.card.kicker?.cost.x ? 1 : 0, Math.min(action.maxX, Math.floor(x) || 0)), action.from, !!action.mutate, action.kick ?? 0, undefined, action.modes ?? 0, false, !!action.door);
      case 'hand':
        return yield* this.useFromHand(p, action.card, action.how);
      case 'unlock': {
        const perm = p.battlefield.find((q) => q.id === action.permId);
        const plan = perm?.card.room && this.sorcerySpeed(p) ? this.planPayment(p, perm.card.room.door.cost, 0, this.unlockDiscount(p)) : null;
        if (!perm || !plan) return false;
        this.commitPayment(p, plan);
        this.unlockDoor(p, perm);
        return true;
      }
      case 'crew': {
        const perm = this.findPerm(action.permId);
        const crew = perm ? this.crewFor(p, perm) : null;
        if (!perm || !crew) return false;
        for (const c of crew) c.tapped = true;
        perm.uncrewed = perm.card;
        perm.card = this.castCard(perm.card, 'crewed');
        this.say(`${p.name} crews ${perm.card.name} with ${crew.map((c) => c.card.name).join(', ')}.`);
        const crewed = perm.card.effects.filter((e) => e.when === 'crewed');
        if (crewed.length) this.trigger(p, perm.card, perm.id, crewed);
        return true;
      }
      case 'station': {
        const perm = this.findPerm(action.permId);
        const crew = perm ? this.stationCrew(p, perm) : [];
        if (!perm || !crew.length) return false;
        const [pick] = crew.length === 1 ? [0] : yield* this.choose(p, 'station', `Station ${perm.card.name}: tap which creature?`, crew.map((q) => ({ label: `${q.card.name} (${this.power(q)})`, card: q.card, permId: q.id })), 1, 1);
        const driver = crew[pick ?? 0];
        driver.tapped = true;
        const n = Math.max(0, this.power(driver));
        this.say(`${p.name} taps ${driver.card.name} to station ${perm.card.name}.`);
        if (n) this.addCharge(perm, n);
        return true;
      }
      case 'cycle': {
        const card = action.card;
        const plan = card.cycling ? this.planPayment(p, card.cycling.cost, 0, 0) : null;
        const idx = p.hand.indexOf(card);
        if (!plan || idx === -1) return false;
        this.commitPayment(p, plan);
        p.life -= card.cycling!.cost.life;
        p.hand.splice(idx, 1);
        this.discarded(p, card);
        const land = card.cycling!.land ? p.library.findIndex((c) => c.isLand) : -1;
        if (land !== -1) {
          const [found] = p.library.splice(land, 1);
          p.hand.push(found);
          this.rng.shuffle(p.library);
          this.say(`${p.name} cycles ${card.name} and finds ${found.name}.`);
        } else {
          this.say(`${p.name} cycles ${card.name}.`);
          this.draw(p, 1);
        }
        // "When you cycle ~" (Fractured Sanity).
        if (card.cycling!.effects?.length) this.trigger(p, card, null, card.cycling!.effects);
        return true;
      }
      case 'activate':
        return yield* this.activate(p, action.permId, action.effect, x);
      case 'graveyard':
        return yield* this.returnFromGraveyard(p, action.card);
      case 'level': {
        const perm = p.battlefield.find((q) => q.id === action.permId);
        const next = perm && this.sorcerySpeed(p) ? this.nextLevel(perm) : undefined;
        const plan = next ? this.planPayment(p, next.cost, 0, 0) : null;
        if (!perm || !next || !plan) return false;
        this.commitPayment(p, plan);
        this.setLevel(p, perm, next.level);
        return true;
      }
      case 'ninjutsu': {
        const attacker = p.battlefield.find((q) => q.id === action.permId);
        const card = action.card;
        const fromCommand = p.commandZone.includes(card) && !!card.ninjutsu?.commander;
        const zone = fromCommand ? p.commandZone : p.hand;
        const plan = card.ninjutsu ? this.planPayment(p, card.ninjutsu.cost, 0, 0) : null;
        if (!attacker || attacker.attacking === null || attacker.blocked || !zone.includes(card) || !plan || this.step !== 'declareBlockers') return false;
        this.commitPayment(p, plan);
        const defender = attacker.attacking;
        this.say(`${p.name} uses ninjutsu: ${attacker.card.name} returns to hand and ${card.name} attacks ${this.players[defender].name}.`);
        this.removePerm(attacker, 'hand');
        zone.splice(zone.indexOf(card), 1);
        const perm = yield* this.enter(p, card, fromCommand || p.deck.commanders.includes(card), 0, null);
        if (perm && p.battlefield.includes(perm) && perm.card.isCreature) {
          perm.tapped = true;
          perm.attacking = defender;
          perm.blocked = false;
        }
        return true;
      }
      case 'turnFaceUp': {
        const perm = p.battlefield.find((q) => q.id === action.permId);
        const cost = perm ? this.faceUpCost(perm) : null;
        const plan = cost ? this.planPayment(p, cost, 0, 0) : null;
        if (!perm || !cost || !plan) return false;
        this.commitPayment(p, plan);
        p.life -= cost.life;
        this.turnFaceUp(p, perm);
        return true;
      }
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Alternative casting: foretell, plot, suspend, warp, madness, miracle, spree, gift ... (see classifyCasting.ts)
  // -------------------------------------------------------------------------

  /** Cards to be cast as an ability resolves: a suspended card's last time counter, hideaway, cipher copies. */
  private pendingCasts: { seat: number; card: SimCard; copy?: boolean; why: string }[] = [];
  /** A suspended card loses time counters when opponents cast spells (Deep-Sea Kraken). */
  private suspendWatch = false;

  /** Is now a time `p` may cast this card from `from`? (rules 307.1, 601.3, 702.8) */
  private castTimingOk(p: PlayerState, card: SimCard, from: CastFrom, sorcery: boolean): boolean {
    const c = card.casting;
    // A card with no mana cost can't be cast from hand the usual way (rule 202.1b, 118.6): suspend is its only way.
    if (c?.noCost && (from === 'hand' || from === 'command')) return false;
    if (c?.fromTurn && (p.turnsTaken ?? 0) < c.fromTurn) return false;
    // Madness and miracle are cast as their trigger resolves, whatever the card type (rules 702.35, 702.94).
    if (from === 'madness' || from === 'miracle') return true;
    if (c?.timing) {
      const theirs = this.activeSeat !== p.seat;
      if (c.timing === 'opponentCombat' && !(theirs && COMBAT_STEPS.includes(this.step))) return false;
      if (c.timing === 'opponentBlockers' && !(theirs && this.step === 'declareBlockers')) return false;
      if (c.timing === 'beforeBlockers' && !BEFORE_BLOCKERS.includes(this.step)) return false;
    }
    // Plotted cards are cast as a sorcery (rule 702.170d).
    if (from === 'plot') return sorcery;
    return sorcery || isInstantSpeed(card) || this.hasFlashFor(p, card);
  }

  /**
   * May `p` cast this card as though it had flash? Static grants (Vedalken Orrery), grants for a while (Borne Upon
   * a Wind, Teferi), and Tegwyll's Scouring's own way (tapping flyers, unless `selfTap` is false).
   */
  hasFlashFor(p: PlayerState, card: SimCard, selfTap = true): boolean {
    if (selfTap && card.casting?.flashByTapping && this.untappedFlyers(p).length >= card.casting.flashByTapping) return true;
    const castCreature = p.creatureCastTurn === this.turnNumber;
    if (this.kindsInGame.has('flashGrant')) {
      for (const perm of p.battlefield) for (const e of perm.card.effects) if (e.kind === 'flashGrant' && e.when === 'static' && flashCovers(e.what, card, castCreature)) return true;
    }
    for (const f of p.flashGrants ?? []) if ((f.until === 'yourNextTurn' || f.turn === this.turnNumber) && flashCovers(f.what, card, castCreature)) return true;
    return false;
  }

  private untappedFlyers(p: PlayerState): Perm[] {
    return p.battlefield.filter((q) => q.card.isCreature && !q.tapped && this.hasKw(q, 'flying'));
  }

  /** Leylines (rule 103.6a): from the opening hand straight onto the battlefield. */
  private beginWithLeylines(p: PlayerState) {
    for (const card of p.hand.filter((c) => c.casting?.leyline)) {
      p.hand.splice(p.hand.indexOf(card), 1);
      this.put(p.seat, card);
      p.castNames.add(card.name);
      this.say(`${p.name} begins the game with ${card.name} on the battlefield.`);
    }
  }

  /** The foretold, plotted or warped card `p` may cast now from exile (on a later turn than it was exiled). */
  private heldEntry(p: PlayerState, card: SimCard, way: 'foretell' | 'plot' | 'warp'): HeldCard | undefined {
    return p.held?.find((h) => h.card === card && h.way === way && h.turn < this.turnNumber);
  }

  /** What `p` may do with this card from hand without casting it (foretell, plot, suspend, transmute, channel). */
  handUses(p: PlayerState, card: SimCard, sorcery: boolean, mayCast = true): Extract<Action, { type: 'hand' }>['how'][] {
    const c = card.casting;
    if (!c) return [];
    const out: Extract<Action, { type: 'hand' }>['how'][] = [];
    const can = (cost: ManaCost) => this.planPayment(p, cost, 0, 0) !== null && p.life > cost.life;
    // Foretell: a special action any time you have priority during your turn (rule 702.143a, 116.2h).
    if (c.foretell && this.activeSeat === p.seat && can(FORETELL_COST)) out.push('foretell');
    // Plot: a special action as a sorcery (rule 702.170a).
    if (c.plot && sorcery && can(c.plot)) out.push('plot');
    // Suspend: any time you could cast the card (rule 702.62a).
    if (c.suspend && mayCast && (sorcery || isInstantSpeed(card) || this.hasFlashFor(p, card)) && can(c.suspend.cost)) out.push('suspend');
    // Transmute: as a sorcery, and only worth offering if there is something to find.
    if (c.transmute && sorcery && can(c.transmute) && p.library.some((l) => l.cmc === card.cmc)) out.push('transmute');
    if (c.channel && can(c.channel.cost) && c.channel.effects.every((e) => {
      const t = this.targetCandidates(p, e, null);
      return t === null || t.length > 0;
    })) out.push('channel');
    return out;
  }

  private *useFromHand(p: PlayerState, card: SimCard, how: Extract<Action, { type: 'hand' }>['how']): Flow<boolean> {
    const c = card.casting;
    const idx = p.hand.indexOf(card);
    if (!c || idx === -1 || !this.handUses(p, card, this.sorcerySpeed(p)).includes(how)) return false;
    const cost = how === 'foretell' ? FORETELL_COST : how === 'plot' ? c.plot! : how === 'suspend' ? c.suspend!.cost : how === 'transmute' ? c.transmute! : c.channel!.cost;
    // Channel is an activated ability from hand: its targets are chosen before it is paid for (rule 602.2b).
    const targets: (Target | null)[] = [];
    if (how === 'channel') {
      for (const e of c.channel!.effects) {
        const all = this.targetCandidates(p, e, null);
        if (all === null) {
          targets.push(null);
          continue;
        }
        if (!all.length) return false;
        const t = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(card, e), card, effect: e, candidates: all, cancellable: true });
        if (!t || !all.some((u) => sameTarget(u, t))) return false;
        targets.push(t);
      }
    }
    const plan = this.planPayment(p, cost, 0, 0);
    if (!plan) return false;
    this.commitPayment(p, plan);
    p.life -= cost.life;
    p.hand.splice(idx, 1);
    switch (how) {
      case 'foretell':
      case 'plot':
        (p.held ??= []).push({ card, way: how, turn: this.turnNumber });
        this.say(how === 'foretell' ? `${p.name} foretells a card.` : `${p.name} plots ${card.name}.`);
        break;
      case 'suspend':
        (p.held ??= []).push({ card, way: 'suspend', turn: this.turnNumber, time: c.suspend!.n });
        if (c.suspend!.onOpponentCast) this.suspendWatch = true;
        this.say(`${p.name} suspends ${card.name} with ${c.suspend!.n} time counters.`);
        break;
      case 'transmute': {
        this.discarded(p, card);
        const options = p.library.filter((l) => l.cmc === card.cmc);
        if (options.length) {
          const pick = options.length === 1 ? [0] : yield* this.choose(p, 'tutor', `Transmute ${card.name}: find a card with mana value ${card.cmc}.`, options.map((l) => ({ label: l.name, card: l })), 1, 1);
          const found = options[pick[0] ?? 0];
          p.library.splice(p.library.indexOf(found), 1);
          p.hand.push(found);
          this.say(`${p.name} transmutes ${card.name} for ${found.name}.`);
        }
        this.rng.shuffle(p.library);
        break;
      }
      case 'channel': {
        this.discarded(p, card);
        this.stack.push({ id: this.nextId++, kind: 'ability', controller: p.seat, card, effects: c.channel!.effects, targets, x: 0, isCommander: false, sourceId: null, attachTo: null, label: `${card.name} (channel)` });
        const aimed = targets.filter((t): t is Target => t !== null);
        this.say(`${p.name} channels ${card.name}${aimed.length ? ` targeting ${aimed.map((t) => this.describeTarget(t)).join(', ')}` : ''}.`);
        for (const t of aimed) this.becameTarget(p, t, false);
        break;
      }
    }
    return true;
  }

  /** Upkeep: a time counter comes off each suspended card (rule 702.62b). */
  private suspendUpkeep(p: PlayerState) {
    for (const h of [...(p.held ?? [])]) if (h.way === 'suspend') this.tickSuspend(p, h);
  }

  /** Remove a time counter from a suspended card; with the last one it is cast without paying its mana cost (rule 702.62c). */
  private tickSuspend(p: PlayerState, h: HeldCard) {
    h.time = Math.max(0, (h.time ?? 1) - 1);
    if (h.time > 0) return;
    p.held!.splice(p.held!.indexOf(h), 1);
    this.say(`The last time counter comes off ${h.card.name}.`);
    this.pendingCasts.push({ seat: p.seat, card: h.card, why: 'suspend' });
  }

  /** Cast the next waiting card for free. One that can't be cast stays in exile (a copy just ceases to exist). */
  private *castPending(): Flow<void> {
    const next = this.pendingCasts.shift()!;
    const p = this.players[next.seat];
    if (!p.alive) return;
    // Hideaway can find a land: it is played instead.
    if (next.card.isLand) {
      if (next.card.land) {
        this.say(`${p.name} plays ${next.card.name} (${next.why}).`);
        this.putLand(p, next.card, next.card.land);
      }
      return;
    }
    const ok = yield* this.cast(p, next.card, false, 0, 'free', false, 0, undefined, 0, !!next.copy);
    if (!ok) {
      this.say(`${p.name} doesn't cast ${next.card.name} (${next.why}).`);
      if (!next.copy) p.exile.push(next.card);
    }
  }

  /** Madness (rule 702.35): a discarded madness card goes to exile, castable for its madness cost until its owner next passes. */
  private discarded(p: PlayerState, card: SimCard, quiet = false) {
    p.discardedTurn = this.turnNumber;
    if (card.casting?.madness) {
      p.exile.push(card);
      (p.windows ??= []).push({ card, how: 'madness' });
      if (!quiet) this.say(`${p.name} discards ${card.name} into exile (madness).`);
      return;
    }
    this.toGraveyard(p, card, false);
    if (this.kindsInGame.has('when:discard')) this.fire(p, 'discard', 1);
  }

  /** `p` passed with a madness or miracle card waiting: it wasn't cast that way. A madness card goes to the graveyard. */
  private closeWindows(p: PlayerState) {
    for (const w of p.windows ?? []) {
      if (w.how !== 'madness' || !p.exile.includes(w.card)) continue;
      p.exile.splice(p.exile.indexOf(w.card), 1);
      this.toGraveyard(p, w.card, false);
    }
    p.windows = [];
  }

  /** Can the optional cost that works like kicker be paid at all (something to sacrifice, someone to give a gift to)? */
  private optionalCostPayable(p: PlayerState, card: SimCard): boolean {
    const k = card.kicker;
    if (k?.as === 'bargain') return this.bargainFodder(p).length > 0;
    if (k?.as === 'casualty') return this.casualtyFodder(p, k.casualty ?? 1).length > 0;
    if (k?.as === 'gift') return this.opponents(p).length > 0;
    return true;
  }

  private bargainFodder(p: PlayerState): Perm[] {
    return p.battlefield.filter((q) => q.card.isArtifact || q.card.isEnchantment || q.token);
  }

  private casualtyFodder(p: PlayerState, power: number): Perm[] {
    return p.battlefield.filter((q) => q.card.isCreature && this.power(q) >= power);
  }

  emergeFodder(p: PlayerState, card: SimCard): Perm[] {
    const what = card.altCost?.emerge;
    return p.battlefield.filter((q) => (what === 'artifact' ? q.card.isArtifact : q.card.isCreature));
  }

  /** The most an emerge cost can be reduced by right now: the highest mana value among what could be sacrificed. */
  emergeDiscount(p: PlayerState, card: SimCard): number {
    return Math.max(0, ...this.emergeFodder(p, card).map((q) => q.card.cmc));
  }

  private emergeCache = new WeakMap<SimCard, Map<number, SimCard>>();
  /** The card priced at its emerge cost, less `mv` generic mana (rule 702.119a). */
  emergeCard(card: SimCard, mv: number): SimCard {
    let byMv = this.emergeCache.get(card);
    if (!byMv) this.emergeCache.set(card, (byMv = new Map()));
    let out = byMv.get(mv);
    if (!out) {
      const mana = card.altCost!.mana;
      byMv.set(mv, (out = { ...card, cost: { ...mana, generic: Math.max(0, mana.generic - mv) } }));
    }
    return out;
  }

  private spreeCache = new WeakMap<SimCard, Map<number, SimCard>>();
  /** A spree or tiered spell with the modes in `modes` (bits) chosen: their costs added, their effects in order (rule 702.172). */
  spreeCard(card: SimCard, modes: number): SimCard {
    const spree = card.casting?.spree;
    if (!spree) return card;
    let byModes = this.spreeCache.get(card);
    if (!byModes) this.spreeCache.set(card, (byModes = new Map()));
    let out = byModes.get(modes);
    if (!out) {
      const chosen = spree.modes.filter((_, i) => modes & (1 << i));
      const cost: ManaCost = {
        generic: card.cost.generic + chosen.reduce((n, m) => n + m.cost.generic, 0),
        pips: [...card.cost.pips, ...chosen.flatMap((m) => m.cost.pips)],
        x: card.cost.x + chosen.reduce((n, m) => n + m.cost.x, 0),
        life: card.cost.life + chosen.reduce((n, m) => n + m.cost.life, 0),
      };
      byModes.set(modes, (out = { ...card, cost, effects: [...card.effects, ...chosen.flatMap((m) => m.effects)] }));
    }
    return out;
  }

  /**
   * Costs paid as the spell is cast besides mana (rule 601.2h): bargain, casualty, emerge and Dread Return's flashback
   * sacrifices, the gift's recipient, Tegwyll's Scouring's flyers. null if they can't be paid after all.
   */
  private *payCastingCosts(p: PlayerState, card: SimCard, from: CastFrom | 'free', kicks: number, emergeFodder: Perm | null): Flow<{ gift?: number; casualty?: boolean } | null> {
    const out: { gift?: number; casualty?: boolean } = {};
    const k = card.kicker;
    const sacrifice = function* (this: Game, options: Perm[], n: number, why: string): Flow<boolean> {
      if (options.length < n) return false;
      const picks = options.length === n ? options.map((_, i) => i) : yield* this.choose(p, 'sacrifice', `Sacrifice ${n === 1 ? 'a permanent' : `${n} creatures`} to ${why} ${card.name}.`, options.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), n, n);
      const gone = picks.map((i) => options[i]).filter(Boolean);
      if (gone.length < n) return false;
      this.say(`${p.name} sacrifices ${gone.map((q) => q.card.name).join(', ')} to ${why} ${card.name}.`);
      this.removePerms(gone, 'graveyard');
      for (let i = 0; i < gone.length; i++) this.sacrificed(p);
      return true;
    }.bind(this);
    if (kicks && k?.as === 'bargain' && !(yield* sacrifice(this.bargainFodder(p), 1, 'bargain'))) return null;
    if (kicks && k?.as === 'casualty') {
      if (!(yield* sacrifice(this.casualtyFodder(p, k.casualty ?? 1), 1, 'pay casualty for'))) return null;
      out.casualty = true;
    }
    if (kicks && k?.as === 'gift') {
      const opps = this.opponents(p);
      if (!opps.length) return null;
      const pick = opps.length === 1 ? [0] : yield* this.choose(p, 'gift', `Promise the gift of ${card.name} to which opponent?`, opps.map((o) => ({ label: o.name })), 1, 1);
      out.gift = opps[pick[0] ?? 0].seat;
    }
    if (from === 'graveyard' && card.casting?.flashbackSac) {
      if (!(yield* sacrifice(p.battlefield.filter((q) => q.card.isCreature), card.casting.flashbackSac, 'flash back'))) return null;
    }
    if (emergeFodder) {
      this.say(`${p.name} sacrifices ${emergeFodder.card.name} to emerge ${card.name}.`);
      this.removePerm(emergeFodder, 'graveyard');
      this.sacrificed(p);
    }
    const tap = card.casting?.flashByTapping;
    if (tap && !this.sorcerySpeed(p) && !isInstantSpeed(card) && !this.hasFlashFor(p, card, false)) {
      const flyers = this.untappedFlyers(p).sort((a, b) => threatOf(a) - threatOf(b)).slice(0, tap);
      if (flyers.length < tap) return null;
      for (const q of flyers) q.tapped = true;
      this.say(`${p.name} taps ${flyers.map((q) => q.card.name).join(', ')} to cast ${card.name} at instant speed.`);
    }
    return out;
  }

  /** Gift (rule 702.174): the promised opponent gets the gift as the spell resolves, before its other effects. */
  private giveGift(card: SimCard, seat: number) {
    const o = this.players[seat];
    if (!o.alive) return;
    const what = card.kicker?.gift ?? 'card';
    switch (what) {
      case 'card':
        this.draw(o, 1, true);
        break;
      case 'extraTurn':
        this.extraTurns.push(o.seat);
        break;
      case 'treasure':
        o.treasures++;
        break;
      case 'food':
        this.gainLife(o, 3);
        break;
      case 'fish':
      case 'octopus': {
        const token = this.makePerm(o, what === 'fish' ? tokenCard(1, 1, []) : tokenCard(8, 8, []), true);
        token.tapped = what === 'fish';
        o.battlefield.push(token);
        this.creatureEntered(o, token);
        break;
      }
    }
    this.say(`${o.name} gets the gift from ${card.name} (${{ card: 'a card', extraTurn: 'an extra turn', treasure: 'a Treasure', food: 'a Food', fish: 'a tapped 1/1 Fish', octopus: 'an 8/8 Octopus' }[what]}).`);
  }

  /** Where a resolved spell goes instead of the graveyard: buyback, suspending itself again, cipher. True if it went somewhere. */
  private *spellAfterResolving(p: PlayerState, item: StackItem): Flow<boolean> {
    if (item.copy || item.flashback) return false;
    const card = item.card;
    if (item.buyback) {
      this.players[item.owner ?? p.seat].hand.push(card);
      this.say(`${card.name} returns to ${p.name}'s hand (buyback).`);
      return true;
    }
    const again = card.casting?.suspend?.again;
    if (again) {
      // It is exiled under its owner, who casts it when the last time counter goes (rule 702.62a).
      (this.players[item.owner ?? p.seat].held ??= []).push({ card, way: 'suspend', turn: this.turnNumber, time: again });
      this.say(`${card.name} is exiled with ${again} time counters.`);
      return true;
    }
    if (card.casting?.cipher) {
      const creatures = p.battlefield.filter((q) => q.card.isCreature);
      if (!creatures.length) return false;
      const pick = creatures.length === 1 ? [0] : yield* this.choose(p, 'cipher', `Encode ${card.name} on which creature?`, creatures.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
      const host = creatures[pick[0] ?? 0];
      (host.encoded ??= []).push(card);
      // The card itself stays in its owner's exile (rule 702.99a), where it remains if the creature leaves.
      this.players[item.owner ?? p.seat].exile.push(card);
      this.say(`${p.name} encodes ${card.name} on ${host.card.name}.`);
      return true;
    }
    return false;
  }

  /** Hideaway N (rule 702.75a): look at the top N cards, exile one face down with the permanent, the rest go to the bottom. */
  private *hideaway(p: PlayerState, perm: Perm, n: number): Flow<void> {
    const top = p.library.splice(0, Math.min(n, p.library.length));
    if (!top.length) return;
    const pick = top.length === 1 ? [0] : yield* this.choose(p, 'hideaway', `${perm.card.name}: exile which card face down?`, top.map((c) => ({ label: c.name, card: c })), 1, 1);
    const at = pick[0] ?? 0;
    perm.hidden = top[at];
    perm.hiddenOwner = p.seat;
    top.splice(at, 1);
    p.library.push(...this.rng.shuffle(top));
    this.say(`${p.name} hides a card under ${perm.card.name}.`);
  }

  /** Does the hideaway condition hold (rule 702.75)? */
  hiddenPlayable(p: PlayerState, e: Extract<Effect, { kind: 'playHidden' }>): boolean {
    if (e.graveyard && p.graveyard.length < e.graveyard) return false;
    if (e.cond === 'power10') return p.battlefield.filter((q) => q.card.isCreature).reduce((n, q) => n + Math.max(0, this.power(q)), 0) >= 10;
    if (e.cond === 'attacked3') return p.battlefield.filter((q) => q.card.isCreature && q.attackedTurn === this.turnNumber).length >= 3;
    if (e.cond === 'damage7') return this.opponents(p).some((o) => (this.lifeLostThisTurn[o.seat] ?? 0) >= 7);
    return true;
  }

  /** End step: blitzed creatures are sacrificed, warped ones exiled (any player's end step); impending counters come off yours. */
  private castingEndStep(active: PlayerState) {
    for (const q of this.players) {
      for (const perm of [...q.battlefield]) {
        if (perm.blitzed) {
          this.say(`${perm.card.name} is sacrificed (blitz).`);
          this.removePerm(perm, 'graveyard');
          this.sacrificed(q);
        } else if (perm.warped) {
          const owner = this.players[perm.owner ?? perm.seat];
          const card = perm.card;
          this.say(`${card.name} is exiled (warp).`);
          this.removePerm(perm, 'exile');
          // Castable from exile on a later turn (rule 702.185a).
          const at = owner.exile.lastIndexOf(card);
          if (at !== -1 && !perm.token) {
            owner.exile.splice(at, 1);
            (owner.held ??= []).push({ card, way: 'warp', turn: this.turnNumber });
          }
        } else if (q === active && perm.impending) {
          perm.impending--;
          if (perm.impending <= 0) {
            perm.card = perm.impendingCard ?? perm.card;
            perm.impending = undefined;
            perm.impendingCard = undefined;
            this.say(`The last time counter comes off ${perm.card.name}: it is a creature now.`);
          }
        }
      }
    }
  }

  /** Combat damage to a player: Rogues enable prowl, and encoded cards are cast again (rules 702.76, 702.99). */
  private castingCombatHits(p: PlayerState, hit: Set<Perm>) {
    for (const a of hit) {
      if (/\bRogue\b/.test(a.card.typeLine)) p.rogueHit = this.turnNumber;
      for (const card of a.encoded ?? []) this.pendingCasts.push({ seat: p.seat, card, copy: true, why: 'cipher' });
    }
  }

  // -------------------------------------------------------------------------
  // Playing cards from exile and the top of a library, free spells, searching
  // -------------------------------------------------------------------------

  /** Whether a permission to play a card from exile still holds (rule 611.2). */
  private mayPlayValid(p: PlayerState, m: MayPlay): boolean {
    const owner = this.players[m.owner];
    if (!owner.exile.includes(m.card)) return false;
    if (m.until === 'turn' && this.turnNumber !== m.turn) return false;
    if (m.until === 'nextTurn' && (p.turnsTaken ?? 0) > m.turnsAt + 1) return false;
    if (m.sourceId !== undefined && !p.battlefield.some((q) => q.id === m.sourceId)) return false;
    return true;
  }

  /** The cards `p` may play from exile right now, each with its permission. */
  exilePlayable(p: PlayerState): MayPlay[] {
    if (!p.mayPlay?.length) return [];
    const ownTurn = this.activeSeat === p.seat;
    return p.mayPlay.filter((m) => this.mayPlayValid(p, m) && (!m.ownTurn || ownTurn));
  }

  /** Drop permissions that ran out (end of turn) or whose card left exile. */
  private pruneMayPlay() {
    for (const q of this.players) if (q.mayPlay?.length) q.mayPlay = q.mayPlay.filter((m) => this.players[m.owner].exile.includes(m.card) && !(m.until === 'turn' && m.turn < this.turnNumber) && !(m.until === 'nextTurn' && (q.turnsTaken ?? 0) > m.turnsAt + 1));
  }

  /** Give `p` permission to play `card` (in `owner`'s exile). */
  private grantPlay(p: PlayerState, card: SimCard, owner: PlayerState, opts: Omit<MayPlay, 'card' | 'owner' | 'turn' | 'turnsAt'>) {
    (p.mayPlay ??= []).push({ card, owner: owner.seat, turn: this.turnNumber, turnsAt: p.turnsTaken ?? 0, ...opts });
    this.kindsInGame.add('mayPlay');
  }

  /** The playTop permission (Future Sight, Bolas's Citadel) that lets `p` play the top card of their library, if any. */
  topPermission(p: PlayerState): Extract<Effect, { kind: 'playTop' }> | null {
    if (!this.kindsInGame.has('playTop')) return null;
    const card = p.library[0];
    if (!card) return null;
    let best: Extract<Effect, { kind: 'playTop' }> | null = null;
    for (const perm of p.battlefield) {
      for (const e of perm.card.effects) {
        if (e.kind !== 'playTop' || e.when !== 'static') continue;
        if (!matchesKind(card, e.what)) continue;
        if (e.subtypes && !e.subtypes.some((s) => hasSubtype(card, s))) continue;
        if (e.coven && new Set(p.battlefield.filter((q) => q.card.isCreature).map((q) => this.power(q))).size < 3) continue;
        // A permission that costs mana beats one that costs life, for anyone not flush with life.
        if (!best || (best.payLife && !e.payLife)) best = e;
      }
    }
    return best;
  }

  /** One with the Multiverse: a spell from hand or the top of the library free, once during each of your turns. */
  freeSpellAvailable(p: PlayerState): boolean {
    return this.kindsInGame.has('freeEachTurn') && this.activeSeat === p.seat && p.freeSpellTurn !== this.turnNumber && this.statics(p, 'freeEachTurn') > 0;
  }

  /** How a card is cast from exile or the top of the library: from which zone, priced how. */
  private viaFor(p: PlayerState, card: SimCard, from: 'exile' | 'library'): CastVia | null {
    if (from === 'library') {
      const perm = p.library[0] === card ? this.topPermission(p) : null;
      if (!perm || card.isLand) return null;
      return { zone: p.library, owner: p, mode: perm.payLife ? 'life' : 'normal', label: ' from the top of their library' };
    }
    const m = this.exilePlayable(p).find((e) => e.card === card && !card.isLand && matchesKind(card, e.only ?? 'any'));
    if (!m) return null;
    const owner = this.players[m.owner];
    return { zone: owner.exile, owner, mode: m.free ? 'free' : m.payLife ? 'life' : m.anyMana ? 'anyMana' : 'normal', entry: m, label: owner === p ? ' from exile' : ` from ${owner.name}'s exile` };
  }

  /** The card cast without paying its mana cost. */
  freeCard(card: SimCard): SimCard {
    return this.pricedAs(card, 'free');
  }

  /** The card priced the way it is being cast (free, life instead of mana, mana of any type). */
  private pricedAs(card: SimCard, mode: CastVia['mode']): SimCard {
    if (mode === 'normal') return card;
    let cache = this.altCards.get(`via:${mode}`);
    if (!cache) this.altCards.set(`via:${mode}`, (cache = new WeakMap()));
    let alt = cache.get(card);
    if (!alt) {
      const c = card.cost;
      const cost: ManaCost = mode === 'free' ? NO_COST : mode === 'life' ? { generic: 0, pips: [], x: 0, life: card.cmc } : { generic: c.generic + c.pips.length, pips: [], x: c.x, life: c.life };
      cache.set(card, (alt = { ...card, cost }));
    }
    return alt;
  }

  /** The playable cards of a permission to play from exile or the top of the library, as legal actions. */
  private exileActions(p: PlayerState, sorcery: boolean, actions: Action[], consider: (card: SimCard, from: 'exile' | 'library') => boolean) {
    const landDrop = sorcery && p.landsPlayed < 1 + this.statics(p, 'extraLand');
    const seen = new Set<SimCard>();
    for (const m of this.exilePlayable(p)) {
      if (seen.has(m.card) || !matchesKind(m.card, m.only ?? 'any')) continue;
      seen.add(m.card);
      if (m.card.isLand) {
        if (landDrop && !m.castOnly && m.card.land) actions.push({ type: 'land', card: m.card, back: false, from: 'exile' });
      } else consider(m.card, 'exile');
    }
    const top = this.topPermission(p);
    if (top) {
      const card = p.library[0];
      if (card.isLand) {
        if (landDrop && card.land) actions.push({ type: 'land', card, back: false, from: 'library' });
      } else consider(card, 'library');
    }
  }

  /** Play a land from exile or the top of the library. */
  private playLandFrom(p: PlayerState, card: SimCard, from: 'exile' | 'library'): boolean {
    let owner = p;
    if (from === 'library') {
      if (p.library[0] !== card || !this.topPermission(p)) return false;
      p.library.shift();
      this.say(`${p.name} plays ${card.name} from the top of their library.`);
    } else {
      const m = this.exilePlayable(p).find((e) => e.card === card && !e.castOnly);
      if (!m) return false;
      owner = this.players[m.owner];
      owner.exile.splice(owner.exile.indexOf(card), 1);
      this.usePermission(p, m);
      this.say(`${p.name} plays ${card.name} from ${owner === p ? 'exile' : `${owner.name}'s exile`}.`);
    }
    // A land played from an opponent's exile is still theirs (rule 108.3): it goes back to their graveyard.
    const perm = this.putLand(p, card, card.land!);
    if (owner !== p) perm.owner = owner.seat;
    p.landsPlayed++;
    p.castNames.add(card.name);
    return true;
  }

  /** A permission is used up when its card is played; "one of those cards" ends the others too. */
  private usePermission(p: PlayerState, m: MayPlay) {
    p.mayPlay = (p.mayPlay ?? []).filter((e) => e !== m && (m.group === undefined || e.group !== m.group));
  }

  /** The players an effect's `from`/`who` names. */
  private playersFor(p: PlayerState, who: Who, target: Target | null, e?: Effect): PlayerState[] {
    if (who === 'you') return [p];
    if (who === 'active') return this.activeSeat !== p.seat && this.players[this.activeSeat].alive ? [this.players[this.activeSeat]] : [];
    if (who === 'opponents') return this.opponents(p);
    if (who === 'each') return this.alivePlayers();
    if (target?.kind === 'player') return this.players[target.seat].alive ? [this.players[target.seat]] : [];
    if (target?.kind === 'perm') {
      const q = this.findPerm(target.id);
      return q ? [this.players[q.seat]] : [];
    }
    if (this.aimedSeat !== null && this.players[this.aimedSeat].alive) return [this.players[this.aimedSeat]];
    // "That player" on a combat damage trigger: the player the creature hit (the trigger's subject), else the opponent with the most cards left.
    const struck = e?.when === 'combatDamage' ? this.resolving?.subject : undefined;
    if (struck !== undefined && this.players[struck]?.alive && struck !== p.seat) return [this.players[struck]];
    const opps = this.opponents(p);
    return opps.length ? [opps.reduce((a, b) => (b.library.length > a.library.length ? b : a))] : [];
  }

  /** Put cards from the bottom of a library in a random order (rule 701.24c-style "random order"). */
  private toBottom(v: PlayerState, cards: SimCard[]) {
    const rest = [...cards];
    this.rng.shuffle(rest);
    for (const c of rest) {
      const i = v.library.indexOf(c);
      if (i !== -1) v.library.splice(i, 1);
      v.library.push(c);
    }
  }

  private *resolveExilePlay(p: PlayerState, e: Extract<Effect, { kind: 'exilePlay' }>, src: Perm | null, x: number, target: Target | null): Flow<void> {
    const count = e.n === -1 ? Math.max(x, 1) : e.n;
    const group = e.oneOf ? this.nextId++ : undefined;
    const source = this.resolvingCard?.name ?? src?.card.name ?? 'an effect';
    for (const v of this.playersFor(p, e.from, target, e)) {
      let exiled: SimCard[] = [];
      if (e.zone === 'hand') {
        const n = Math.min(count, v.hand.length);
        if (!n) continue;
        const picks = yield* this.choose(v, 'discard', `Exile ${n} card${n > 1 ? 's' : ''} from your hand (${source}).`, v.hand.map((c) => ({ label: c.name, card: c })), n, n);
        exiled = picks.map((i) => v.hand[i]);
        for (const c of exiled) v.hand.splice(v.hand.indexOf(c), 1);
      } else if (e.zone === 'graveyard') {
        const pool = v.graveyard.filter((c) => matchesKind(c, e.only ?? 'any'));
        if (!pool.length) continue;
        // "Exile all opponents' graveyards" (Mnemonic Betrayal): every card, no choice.
        const picks = count >= 99 ? pool.map((_, i) => i) : yield* this.choose(p, 'recursion', `Exile a card from ${v === p ? 'your' : `${v.name}'s`} graveyard to play it later (${source}).`, pool.map((c) => ({ label: c.name, card: c })), 1, Math.min(count, pool.length));
        exiled = picks.map((i) => pool[i]);
        for (const c of exiled) v.graveyard.splice(v.graveyard.indexOf(c), 1);
      } else if (e.untilKind) {
        // Exile cards until one of the kind; only that one may be played, the rest go to the bottom.
        const at = v.library.findIndex((c) => matchesKind(c, e.untilKind!));
        const revealed = at === -1 ? [...v.library] : v.library.slice(0, at + 1);
        if (!revealed.length) continue;
        const hit = at === -1 ? null : revealed[revealed.length - 1];
        v.library.splice(0, revealed.length);
        if (hit) exiled = [hit];
        v.library.push(...this.rng.shuffle(revealed.filter((c) => c !== hit)));
      } else if (e.look) {
        const seen = v.library.slice(0, e.look);
        if (!seen.length) continue;
        const pool = seen.filter((c) => matchesKind(c, e.only ?? 'any'));
        const n = Math.min(count, pool.length);
        const picks = n ? yield* this.choose(p, 'impulse', `Exile ${n} of the top ${seen.length} cards of ${v === p ? 'your' : `${v.name}'s`} library to play later (${source}).`, pool.map((c) => ({ label: c.name, card: c })), n, n) : [];
        exiled = picks.map((i) => pool[i]);
        v.library.splice(0, seen.length);
        v.library.push(...this.rng.shuffle(seen.filter((c) => !exiled.includes(c))));
      } else {
        exiled = e.bottom ? v.library.splice(Math.max(0, v.library.length - count), count) : v.library.splice(0, count);
      }
      if (!exiled.length) continue;
      v.exile.push(...exiled);
      const playable = exiled.filter((c) => matchesKind(c, e.only ?? 'any') && !(e.castOnly && c.isLand));
      this.say(`${v === p ? p.name : v.name} exiles ${exiled.map((c) => c.name).join(', ')}${v.library.length || e.zone ? '' : ''}${playable.length ? `; ${p.name} may play ${playable.length > 1 ? (e.oneOf ? 'one of them' : 'them') : 'it'}${e.until === 'turn' ? ' this turn' : e.until === 'nextTurn' ? ' until the end of their next turn' : ''}${e.free ? ' without paying its mana cost' : e.payLife ? ' for life instead of mana' : ''}` : ''} (${source}).`);
      for (const card of playable) {
        this.grantPlay(p, card, v, {
          until: e.until, source, ...(e.anyMana ? { anyMana: true } : {}), ...(e.payLife ? { payLife: true } : {}), ...(e.free ? { free: true } : {}),
          ...(e.castOnly ? { castOnly: true } : {}), ...(e.ownTurn ? { ownTurn: true } : {}), ...(group !== undefined ? { group } : {}),
          ...(e.only && e.only !== 'any' ? { only: e.only } : {}), ...(e.whileSource && src ? { sourceId: src.id } : {}),
        });
      }
    }
  }

  /** Cast spells without paying their mana costs while this resolves (rule 608.2g): Etali, Villainous Wealth, discover. */
  private *resolveFreeCast(p: PlayerState, e: Extract<Effect, { kind: 'freeCast' }>, src: Perm | null, x: number, target: Target | null): Flow<void> {
    const n = e.n === -1 ? Math.max(x, 0) : e.n === -2 ? this.triggeringCmc() : e.n;
    const maxCmc = e.maxCmc === undefined ? Infinity : e.maxCmc === -1 ? x : e.maxCmc === -2 ? this.triggeringCmc() - 1 : e.maxCmc === -3 ? this.triggeringCmc() : e.maxCmc;
    const fits = (c: SimCard) => !c.isLand && matchesKind(c, e.only ?? 'any') && c.cmc <= maxCmc;
    const source = this.resolvingCard?.name ?? src?.card.name ?? 'an effect';
    type Cand = { card: SimCard; zone: SimCard[]; owner: PlayerState };
    const cands: Cand[] = [];
    /** Cards looked at or revealed, and where they go afterwards if not cast. */
    const looked: { card: SimCard; owner: PlayerState; zone: SimCard[] }[] = [];
    const victims = e.who === 'you' ? [p] : this.playersFor(p, e.who, target, e);
    for (const v of victims) {
      if (e.from === 'top') {
        for (const c of v.library.slice(0, n)) {
          looked.push({ card: c, owner: v, zone: v.library });
          if (fits(c)) cands.push({ card: c, zone: v.library, owner: v });
        }
      } else if (e.from === 'until') {
        // Reveal (exile) cards until a card that fits (discover: a nonland card with mana value N or less).
        const at = v.library.findIndex(fits);
        const revealed = at === -1 ? [...v.library] : v.library.slice(0, at + 1);
        v.library.splice(0, revealed.length);
        v.exile.push(...revealed);
        for (const c of revealed) looked.push({ card: c, owner: v, zone: v.exile });
        if (at !== -1) cands.push({ card: revealed[revealed.length - 1], zone: v.exile, owner: v });
        if (revealed.length) this.say(`${v.name} reveals ${revealed.length} card${revealed.length > 1 ? 's' : ''}${at !== -1 ? `, stopping at ${revealed[revealed.length - 1].name}` : ''} (${source}).`);
      } else if (e.from === 'hand') {
        for (const c of new Set(v.hand)) if (fits(c)) cands.push({ card: c, zone: v.hand, owner: v });
      } else if (e.from === 'graveyard') {
        if (this.graveyardLocked()) continue;
        if (e.random) {
          // Kefka: a card at random from each opponent's graveyard is exiled; it may be cast if it is a spell.
          if (!v.graveyard.length) continue;
          const c = v.graveyard[Math.floor(this.rng.next() * v.graveyard.length)];
          v.graveyard.splice(v.graveyard.indexOf(c), 1);
          v.exile.push(c);
          this.say(`${p.name} exiles ${c.name} from ${v.name}'s graveyard (${source}).`);
          if (fits(c)) cands.push({ card: c, zone: v.exile, owner: v });
          continue;
        }
        for (const c of new Set(v.graveyard)) if (fits(c)) cands.push({ card: c, zone: v.graveyard, owner: v });
      } else if (e.from === 'search') {
        const pool = yield* this.searchLibrary(p);
        if (!pool) continue;
        const found = [...new Set(pool.filter(fits))];
        if (!found.length) {
          this.rng.shuffle(p.library);
          continue;
        }
        const pick = yield* this.choose(p, 'tutor', `Search your library for a card to cast without paying its mana cost (${source}).`, found.map((c) => ({ label: c.name, card: c })), 1, 1);
        const card = found[pick[0] ?? 0];
        const kept = this.foundInSearch(p, [card]);
        p.library.splice(p.library.indexOf(card), 1);
        this.rng.shuffle(p.library);
        if (!kept.length) continue;
        p.exile.push(card);
        cands.push({ card, zone: p.exile, owner: p });
        looked.push({ card, owner: p, zone: p.exile });
      }
    }
    const cast = new Set<SimCard>();
    const mode: CastVia['mode'] = e.pay ? (e.anyMana ? 'anyMana' : 'normal') : 'free';
    for (let i = 0; i < e.casts; i++) {
      const open = cands.filter((c) => !cast.has(c.card) && c.zone.includes(c.card) && this.castableNow(p, c.card, mode));
      if (!open.length) break;
      const pick = yield* this.choose(p, 'freeCast', `Cast a spell${mode === 'free' ? ' without paying its mana cost' : ''} (${source})?`, open.map((c) => ({ label: c.owner === p ? c.card.name : `${c.card.name} (${c.owner.name})`, card: c.card })), 0, 1);
      if (!pick.length) break;
      const chosen = open[pick[0]];
      const copies = e.copy ? Math.max(1, e.copies ?? 1) : 1;
      let any = false;
      for (let k = 0; k < copies; k++) {
        const via: CastVia = { zone: chosen.zone, owner: chosen.owner, mode, copy: !!e.copy, label: e.copy ? ' (a copy)' : chosen.owner === p ? '' : ` from ${chosen.owner.name}'s ${chosen.zone === chosen.owner.hand ? 'hand' : chosen.zone === chosen.owner.graveyard ? 'graveyard' : chosen.zone === chosen.owner.library ? 'library' : 'exile'}`, ...(e.exileAfter ? { exileAfter: true } : {}) };
        if (yield* this.cast(p, chosen.card, false, 0, 'hand', false, 0, via)) any = true;
      }
      if (any) {
        cast.add(chosen.card);
        // Mizzix's Mastery, Psionic Ritual: the card itself is exiled and only its copy is cast.
        if (e.copy && chosen.zone === chosen.owner.graveyard && chosen.zone.includes(chosen.card)) {
          chosen.zone.splice(chosen.zone.indexOf(chosen.card), 1);
          chosen.owner.exile.push(chosen.card);
        }
      } else cands.splice(cands.indexOf(chosen), 1);
    }
    // What wasn't cast goes where the card says.
    const left = looked.filter((l) => !cast.has(l.card) && l.zone.includes(l.card));
    if (e.elseHand) {
      for (const l of left.filter((l) => cands.some((c) => c.card === l.card))) {
        l.zone.splice(l.zone.indexOf(l.card), 1);
        p.hand.push(l.card);
        this.say(`${p.name} puts ${l.card.name} into their hand.`);
        left.splice(left.indexOf(l), 1);
      }
    }
    for (const v of new Set(left.map((l) => l.owner))) {
      const mine = left.filter((l) => l.owner === v);
      for (const l of mine) l.zone.splice(l.zone.indexOf(l.card), 1);
      const cards = mine.map((l) => l.card);
      const rest = e.rest ?? (e.from === 'top' ? 'top' : 'bottom');
      if (rest === 'graveyard') for (const c of cards) this.toGraveyard(v, c, false);
      else if (rest === 'hand') v.hand.push(...cards);
      else if (rest === 'exile') v.exile.push(...cards);
      else if (rest === 'top') v.library.unshift(...cards);
      else {
        v.library.push(...cards);
        if (rest === 'shuffle') this.rng.shuffle(v.library);
        else this.toBottom(v, cards);
      }
    }
  }

  /** The mana value of the spell that set off the ability now resolving (Rashmi, Sunbird's Invocation). */
  private triggeringCmc(): number {
    const subject = this.resolving?.subject;
    const spell = subject !== undefined ? this.stack.find((s) => s.id === subject) : undefined;
    return spell?.card.cmc ?? 3;
  }

  /** Could `p` cast this card right now, priced `mode`, with targets for it? */
  private castableNow(p: PlayerState, card: SimCard, mode: CastVia['mode']): boolean {
    if (card.isLand) return false;
    const priced = this.pricedAs(card, mode);
    if (!this.canAfford(p, priced, false, 0)) return false;
    return this.hasTargets(p, card);
  }

  /**
   * `p` searches `v`'s library (rule 701.23). Returns the cards they may find, or null when they can't search:
   * Ashiok, Dream Render; Leonin Arbiter unless they pay {2}; Aven Mindcensor shows only the top four.
   */
  private *searchLibrary(p: PlayerState, v: PlayerState = p): Flow<SimCard[] | null> {
    if (this.kindsInGame.has('when:opponentSearch') && v === p) for (const o of this.opponents(p)) this.fire(o, 'opponentSearch');
    if (!this.kindsInGame.has('searchRule')) return v.library;
    const rules = (q: PlayerState, rule: string) => q.battlefield.some((perm) => perm.card.effects.some((e) => e.kind === 'searchRule' && e.when === 'static' && e.rule === rule));
    if (v === p && this.opponents(p).some((o) => rules(o, 'noSearch'))) {
      this.say(`${p.name} can't search their library (Ashiok).`);
      return null;
    }
    if (this.alivePlayers().some((q) => rules(q, 'pay2')) && this.arbiterPaid.get(p.seat) !== this.turnNumber) {
      const plan = this.planPayment(p, { generic: 2, pips: [], x: 0, life: 0 }, 0, 0);
      if (!plan) {
        this.say(`${p.name} can't search a library (Leonin Arbiter).`);
        return null;
      }
      this.commitPayment(p, plan);
      this.arbiterPaid.set(p.seat, this.turnNumber);
      this.say(`${p.name} pays {2} to search this turn (Leonin Arbiter).`);
    }
    if (this.opponents(p).some((o) => rules(o, 'top4'))) return v.library.slice(0, 4);
    return v.library;
  }

  /** Opposition Agent: what an opponent finds while searching their library is exiled, for the Agent's controller to play. Returns what the searcher keeps. */
  private foundInSearch(p: PlayerState, cards: SimCard[]): SimCard[] {
    if (!cards.length || !this.kindsInGame.has('searchRule')) return cards;
    const agent = this.opponents(p).find((o) => o.battlefield.some((perm) => perm.card.effects.some((e) => e.kind === 'searchRule' && e.when === 'static' && e.rule === 'agent')));
    if (!agent) return cards;
    for (const c of cards) {
      const i = p.library.indexOf(c);
      if (i !== -1) p.library.splice(i, 1);
      p.exile.push(c);
      this.grantPlay(agent, c, p, { until: 'exiled', anyMana: true, source: 'Opposition Agent' });
    }
    this.say(`${p.name} exiles ${cards.map((c) => c.name).join(', ')} instead; ${agent.name} may play ${cards.length > 1 ? 'them' : 'it'} (Opposition Agent).`);
    return [];
  }

  /** Search for cards beyond a plain tutor (Tezzeret, Zur, Protean Hulk, Sunforger, Varragoth). */
  private *resolveSearch(p: PlayerState, e: Extract<Effect, { kind: 'search' }>, src: Perm | null, x: number, target: Target | null): Flow<void> {
    const searcher = e.who === 'target' && target?.kind === 'player' ? this.players[target.seat] : p;
    if (!searcher.alive) return;
    const pool = yield* this.searchLibrary(searcher);
    if (!pool) return;
    const maxCmc = e.maxCmc === undefined ? Infinity : e.maxCmc === -1 ? x : e.maxCmc;
    const fits = (c: SimCard) => matchesKind(c, e.what) && c.cmc <= maxCmc && (!e.colors || e.colors.some((col) => cardColors(c).includes(col as Color)));
    let found = [...new Set(pool.filter(fits))].sort((a, b) => a.name.localeCompare(b.name));
    const source = this.resolvingCard?.name ?? src?.card.name ?? 'an effect';
    const chosen: SimCard[] = [];
    let budget = e.totalCmc ?? Infinity;
    for (let i = 0; i < e.n && found.length; i++) {
      const pick = yield* this.choose(searcher, e.to === 'top' ? 'tutor' : e.to === 'battlefield' && e.what === 'creature' ? 'take' : 'tutor', `Search your library for ${e.n > 1 ? 'a card (one at a time)' : 'a card'} (${source}).`, found.map((c) => ({ label: c.name, card: c })), e.n > 1 ? 0 : 1, 1);
      if (!pick.length) break;
      const card = found[pick[0]];
      chosen.push(card);
      budget -= card.cmc;
      // Another copy of the same card is still in the library.
      const left = pool.filter((c) => c === card).length - chosen.filter((c) => c === card).length;
      found = found.filter((c) => (c !== card || left > 0) && (e.totalCmc === undefined || c.cmc <= budget));
    }
    const kept = this.foundInSearch(searcher, chosen);
    for (const c of kept) searcher.library.splice(searcher.library.indexOf(c), 1);
    this.rng.shuffle(searcher.library);
    if (!kept.length) {
      this.say(`${searcher.name} searches their library${chosen.length ? '' : ' and finds nothing'}.`);
      return;
    }
    if (e.to === 'hand') {
      searcher.hand.push(...kept);
      this.say(`${searcher.name} searches their library for ${kept.length > 1 ? `${kept.length} cards` : 'a card'}.`);
    } else if (e.to === 'top') {
      searcher.library.unshift(...kept);
      this.say(`${searcher.name} searches their library and puts a card on top.`);
    } else if (e.to === 'battlefield') {
      this.say(`${searcher.name} searches their library and puts ${kept.map((c) => c.name).join(', ')} onto the battlefield.`);
      for (const c of kept) {
        if (c.isLand && c.land) this.putLand(searcher, c, c.land, e.tapped);
        else {
          const perm = yield* this.enter(searcher, c, false, 0, null);
          if (perm && e.tapped) perm.tapped = true;
        }
      }
    } else {
      // 'cast' and 'exilePlay': exiled, then cast free now or played this turn.
      searcher.exile.push(...kept);
      if (e.to === 'exilePlay') {
        for (const c of kept) this.grantPlay(searcher, c, searcher, { until: 'turn', free: true, castOnly: true, source });
        this.say(`${searcher.name} exiles ${kept.map((c) => c.name).join(', ')} and may cast ${kept.length > 1 ? 'them' : 'it'} free this turn.`);
      } else {
        for (const c of kept) {
          if (this.castableNow(searcher, c, 'free')) yield* this.cast(searcher, c, false, 0, 'hand', false, 0, { zone: searcher.exile, owner: searcher, mode: 'free', label: '' });
        }
        // A card that couldn't be cast stays in exile.
      }
    }
  }

  /** Look at the top cards and put them back in any order; Ponder may shuffle instead. */
  private *rearrange(p: PlayerState, e: Extract<Effect, { kind: 'rearrange' }>): Flow<void> {
    const top = p.library.slice(0, e.n);
    if (!top.length) return;
    const picks = yield* this.choose(p, 'rearrange', `Put the top ${top.length} cards of your library back: choose them from the top down${e.shuffle ? ', or choose none to shuffle your library' : ''}.`, top.map((c) => ({ label: c.name, card: c })), e.shuffle ? 0 : top.length, top.length);
    if (!picks.length && e.shuffle) {
      this.rng.shuffle(p.library);
      this.say(`${p.name} looks at the top ${top.length} cards and shuffles their library.`);
      return;
    }
    const order = [...picks.map((i) => top[i]), ...top.filter((_, i) => !picks.includes(i))];
    p.library.splice(0, top.length, ...order);
    this.say(`${p.name} looks at the top ${top.length} cards of their library and puts them back in any order.`);
  }

  // -------------------------------------------------------------------------
  // Using cards from the graveyard
  // -------------------------------------------------------------------------

  /** Grafdigger's Cage: nothing is cast from graveyards and creature cards don't come back from them. */
  graveyardLocked(): boolean {
    return this.statics(null, 'graveyardLock') > 0;
  }

  /**
   * Whether a static ability lets `p` play this card from their graveyard (Crucible of Worlds, Muldrotha, Noctis).
   * Returns the extra life it costs, or null if nothing allows it.
   */
  graveyardPermission(p: PlayerState, card: SimCard): { life: number; finality?: boolean } | null {
    if (!this.kindsInGame.has('graveyardPlay')) return null;
    if (!card.isLand && this.graveyardLocked()) return null;
    let best: { life: number; finality?: boolean } | null = null;
    for (const perm of p.battlefield) {
      for (const e of perm.card.effects) {
        if (e.kind !== 'graveyardPlay' || e.when !== 'static') continue;
        let ok = false;
        if (e.what === 'lands') ok = card.isLand;
        else if (e.what === 'artifacts') ok = card.isArtifact && !card.isLand;
        else ok = permanentTypes(card).some((t) => !p.graveyardTypes?.has(t));
        if (ok && (!best || (e.lifeCost ?? 0) < best.life)) best = { life: e.lifeCost ?? 0, ...(e.finality ? { finality: true } : {}) };
      }
    }
    return best;
  }

  /** Muldrotha: note the permanent type used. A Crucible-style permission for lands uses nothing up. */
  private useGraveyardPermission(p: PlayerState, card: SimCard) {
    const own = p.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'graveyardPlay' && e.when === 'static' && (e.what === 'lands' ? card.isLand : e.what === 'artifacts' && card.isArtifact)));
    if (own) return;
    const type = permanentTypes(card).find((t) => !p.graveyardTypes?.has(t));
    if (type) (p.graveyardTypes ??= new Set()).add(type);
  }

  /** May `p` cast this card from their graveyard now (flashback, escape, retrace, disturb, or a static permission)? */
  graveyardCastable(p: PlayerState, card: SimCard): boolean {
    if (card.isLand || !p.graveyard.includes(card) || this.graveyardLocked()) return false;
    // Dread Return: flashback by sacrificing three creatures.
    if (card.casting?.flashbackSac) return p.battlefield.filter((q) => q.card.isCreature).length >= card.casting.flashbackSac;
    if (card.flashback) return true;
    const use = card.graveyard;
    if (use?.how === 'cast') {
      if (use.exileOthers && p.graveyard.length - 1 < use.exileOthers) return false;
      if (use.discardLand && !p.hand.some((c) => c.isLand)) return false;
      return true;
    }
    const permission = this.graveyardPermission(p, card);
    return !!permission && p.life > permission.life;
  }

  /** May `p` use this card's "return from your graveyard" ability now (unearth, embalm, Reassembling Skeleton)? */
  canReturnFromGraveyard(p: PlayerState, card: SimCard, sorcery = this.sorcerySpeed(p)): boolean {
    const use = card.graveyard;
    if (!use || use.how !== 'return' || !p.graveyard.includes(card)) return false;
    if (use.sorcery && !sorcery) return false;
    if (use.to === 'battlefield' && card.isCreature && this.graveyardLocked()) return false;
    if (use.sacCreature && !p.battlefield.some((q) => q.card.isCreature)) return false;
    return this.planPayment(p, use.cost, 0, 0) !== null;
  }

  private *returnFromGraveyard(p: PlayerState, card: SimCard): Flow<boolean> {
    const use = card.graveyard;
    if (!use || !this.canReturnFromGraveyard(p, card)) return false;
    const plan = this.planPayment(p, use.cost, 0, 0);
    if (!plan) return false;
    let fodder: Perm | null = null;
    if (use.sacCreature) {
      const creatures = p.battlefield.filter((q) => q.card.isCreature);
      const pick = creatures.length === 1 ? [0] : yield* this.choose(p, 'sacrifice', `Sacrifice which creature to return ${card.name}?`, creatures.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
      fodder = creatures[pick[0] ?? 0];
    }
    this.commitPayment(p, plan);
    p.life -= use.cost.life;
    if (fodder) {
      this.removePerm(fodder, 'graveyard');
      this.sacrificed(p, fodder);
    }
    if (!p.graveyard.includes(card)) return true;
    p.graveyard.splice(p.graveyard.indexOf(card), 1);
    if (use.to === 'hand') {
      p.hand.push(card);
      this.say(`${p.name} returns ${card.name} from their graveyard to their hand.`);
      return true;
    }
    if (use.token) {
      // Embalm, eternalize: the card is exiled and a token copy enters (rule 702.128).
      p.exile.push(card);
      this.say(`${p.name} ${use.label}s ${card.name}.`);
      const copy = use.size ? sized(card, use.size) : card;
      const perm = yield* this.enter(p, copy, false, 0, null);
      if (perm) perm.token = true;
      return true;
    }
    this.say(`${p.name} ${use.label === 'unearth' ? 'unearths' : 'returns'} ${card.name}${use.label === 'unearth' ? '' : ' from their graveyard to the battlefield'}.`);
    const perm = yield* this.enter(p, card, p.deck.commanders.includes(card), 0, null);
    if (perm) {
      if (use.tapped) perm.tapped = true;
      if (use.haste) perm.tempKw.push('haste');
      if (use.exileAtEnd) this.unearthed.add(perm.id);
    }
    return true;
  }

  /**
   * The cards a recursion effect could return for `p`, with the player whose graveyard each is in.
   * Empty when Grafdigger's Cage stops it.
   */
  recursionPool(p: PlayerState, e: Extract<Effect, { kind: 'recursion' }>): { card: SimCard; owner: PlayerState }[] {
    const owners = e.from === 'any' ? this.alivePlayers() : e.from === 'opponents' ? this.opponents(p) : [p];
    const out: { card: SimCard; owner: PlayerState }[] = [];
    const locked = e.toBattlefield && this.graveyardLocked();
    for (const owner of owners) {
      for (const card of owner.graveyard) {
        if (!recursionMatches(e.what, card)) continue;
        if (e.maxCmc !== undefined && card.cmc > e.maxCmc) continue;
        if (e.toBattlefield && (card.isInstant || card.isSorcery || (card.isLand && e.what !== 'land' && e.what !== 'permanent'))) continue;
        if (locked && !card.isLand) continue;
        out.push({ card, owner });
      }
    }
    return out;
  }

  /**
   * Mill: `count` cards from the top of `v`'s library into their graveyard, made bigger by Bruvac and The Water Crystal
   * when an opponent of theirs controls one. Returns how many were milled.
   */
  private millCards(v: PlayerState, count: number, untilLands = 0): number {
    if (!v.alive) return 0;
    if (untilLands > 0) {
      let lands = 0;
      count = 0;
      while (count < v.library.length && lands < untilLands) if (v.library[count++].isLand) lands++;
    } else if (this.kindsInGame.has('millBoost')) {
      for (const q of this.opponents(v)) {
        for (const perm of q.battlefield) for (const e of perm.card.effects) if (e.kind === 'millBoost' && e.when === 'static') count = count * e.mult + e.plus;
      }
    }
    count = Math.min(v.library.length, count);
    if (count <= 0) return 0;
    const milled = v.library.splice(0, count);
    for (const card of milled) this.toGraveyard(v, card, false);
    this.say(`${v.name} mills ${count} card${count > 1 ? 's' : ''} (${v.library.length} left).`);
    // "Whenever an opponent mills one or more cards" (Lo and Li), "whenever you mill" (Devourer of Memory).
    if (this.kindsInGame.has('when:milled')) {
      const creature = milled.some((c) => c.isCreature);
      for (const q of this.alivePlayers()) {
        for (const perm of q.battlefield) {
          const hits = perm.card.effects.filter((e) => e.when === 'milled' && (e.castFilter !== 'creature' || creature) && (e.scope === 'all' || (e.scope === 'self' ? q === v : q !== v)));
          if (hits.length) this.trigger(q, perm.card, perm.id, hits);
        }
      }
    }
    return count;
  }

  /** The Mindskinner: damage `p`'s sources would deal to an opponent is prevented and that player mills that many cards. */
  private damageMills(p: PlayerState, victim: PlayerState, amount: number): boolean {
    if (victim === p || !this.kindsInGame.has('damageToMill') || this.statics(p, 'damageToMill') === 0) return false;
    this.say(`${p.name}'s damage to ${victim.name} is prevented.`);
    this.millCards(victim, amount);
    return true;
  }

  // -------------------------------------------------------------------------
  // Mana
  // -------------------------------------------------------------------------

  /**
   * The mana in `p`'s pool that is still there (rule 106.4): mana empties as the step it was made in ends, firebending's at
   * end of combat, Mana Drain's is there in its owner's next precombat main phase. Horizon Stone keeps what would empty, as {C}.
   */
  livePool(p: PlayerState): PoolMana[] {
    if (!p.pool?.length) return [];
    let keep: boolean | null = null;
    p.pool = p.pool.filter((m) => {
      if (m.n <= 0) return false;
      const state = this.poolState(p, m);
      if (state !== 'gone') return true;
      keep ??= this.kindsInGame.has('keepMana') && this.statics(p, 'keepMana') > 0;
      if (!keep) return false;
      m.until = 'kept';
      m.colors = ['C'];
      return true;
    });
    return p.pool.filter((m) => this.poolState(p, m) === 'live');
  }

  private poolState(p: PlayerState, m: PoolMana): 'live' | 'waiting' | 'gone' {
    switch (m.until) {
      case 'kept': return 'live';
      case 'step': return m.turn === this.turnNumber && m.step === this.step && m.combat === this.combatsThisTurn ? 'live' : 'gone';
      case 'combat': return m.turn === this.turnNumber && COMBAT_STEPS.includes(this.step) && m.combat === this.combatsThisTurn ? 'live' : 'gone';
      case 'nextMain':
        if (this.activeSeat !== p.seat || this.turnNumber <= m.turn) return 'waiting';
        return this.step === 'main1' ? 'live' : ['untap', 'upkeep', 'draw'].includes(this.step) ? 'waiting' : 'gone';
    }
  }

  /** Add mana to `p`'s pool. */
  addMana(p: PlayerState, n: number, opts: { until?: PoolMana['until']; abilityOnly?: boolean; colorless?: boolean } = {}) {
    if (n <= 0) return;
    (p.pool ??= []).push({ n, colors: opts.colorless ? ['C'] : 'any', turn: this.turnNumber, step: this.step, combat: this.combatsThisTurn, until: opts.until ?? 'step', abilityOnly: opts.abilityOnly });
  }

  /** `ability`: paying for an activated ability, which Thran Turbine's mana may do. */
  private manaSources(p: PlayerState, exclude?: Perm, ability = false): ManaSource[] {
    const m = this.memo;
    if (!m) return this.manaSourcesNow(p, exclude, ability);
    const key = `${p.seat}:${exclude ? exclude.id : -1}:${ability ? 1 : 0}`;
    const kept = m.manaSources.get(key);
    if (kept === undefined) {
      const v = this.manaSourcesNow(p, exclude, ability);
      m.manaSources.set(key, v);
      return [...v];
    }
    return [...(verifyMemo ? checkMemo(`mana sources ${key}`, kept, this.manaSourcesNow(p, exclude, ability)) : kept)];
  }

  private manaSourcesNow(p: PlayerState, exclude?: Perm, ability = false): ManaSource[] {
    const out: ManaSource[] = [];
    if (p.pool?.length) for (const m of this.livePool(p)) if (!m.abilityOnly || ability) out.push({ perm: null, colors: m.colors, amount: m.n, pool: m });
    let energy = p.energy;
    // Ultima: lands that tap for {C} add an additional {C}.
    const boost = this.kindsInGame.has('colorlessBoost') && this.statics(p, 'colorlessBoost') > 0;
    // Cursed Totem, Karn: mana abilities are activated abilities too (rule 605.1a).
    const lockers = this.staticsOf('abilityLock');
    const locks = lockers.length > 0;
    // Crypt Ghast, Mirari's Wake, Caged Sun, Forsaken Monument: lands (and {C} rocks) make more.
    const boosts = this.kindsInGame.has('manaBoost') ? this.manaBoosts(p) : null;
    const corrupted = this.opponents(p).some((o) => o.poison >= 3);
    const tokenManaOn = this.kindsInGame.has('tokenMana') && this.statics(p, 'tokenMana') > 0;
    for (const perm of p.battlefield) {
      if (perm === exclude) continue;
      if (locks && this.abilitiesLocked(p, perm.card, lockers)) continue;
      if (perm.landInfo) {
        if (perm.tapped) continue;
        const perArtifact = perm.card.effects.some((e) => e.kind === 'mana' && e.perArtifact);
        if (perArtifact) {
          out.push({ perm, colors: this.landProduces(perm), amount: Math.max(1, p.battlefield.filter((q) => q.card.isArtifact).length - 1) });
          continue;
        }
        // Three Tree City, Nykthos: "{2}, {T}: Add X mana of one color", kept as the net gain when that beats the plain {C}.
        const big = perm.card.effects.find((e): e is Extract<Effect, { kind: 'mana' }> => e.kind === 'mana' && e.net !== undefined);
        if (big) {
          const net = this.manaCount(p, perm, big) - big.net!;
          if (net > 1) {
            out.push({ perm, colors: 'any', amount: net });
            continue;
          }
        }
        const colors = this.landProduces(perm);
        out.push({ perm, colors, amount: (boost && this.colorlessLand(perm) ? 2 : 1) + (boosts ? this.landBoost(perm, colors, boosts) : 0) });
        continue;
      }
      // Most permanents make no mana: skip them before the costlier checks (token-heavy boards made this the hot spot).
      const tokenMana = tokenManaOn && perm.token && perm.card.isCreature;
      if (!tokenMana && !perm.card.effects.some((e) => e.kind === 'mana')) continue;
      // Summoning sickness only stops {T} abilities (rule 302.6).
      const tapBlocked = perm.tapped || (perm.sick && perm.card.isCreature && !this.hasKw(perm, 'haste'));
      // One tap gives one ability's mana: the biggest one this permanent can pay for.
      let best: ManaSource | null = null;
      for (const e of perm.card.effects) {
        if (e.kind !== 'mana') continue;
        const charge = perm.charge ?? 0;
        if (e.charge === 'spend') {
          // Pentad Prism: each counter is a mana, without tapping.
          if (charge > 0) out.push({ perm, colors: e.colors, amount: charge, charge: 'spend' });
          continue;
        }
        // Crystalline Crawler: each +1/+1 counter is a mana, without tapping.
        if (e.fromCounters) {
          if (perm.counters > 0) out.push({ perm, colors: e.colors, amount: perm.counters, counters: true });
          continue;
        }
        // Krark-Clan Ironworks: spare artifact tokens are mana (see sacrificeForMana).
        if (e.sacArtifact) continue;
        // Vivi Ornitier: "{0}: Add X mana ...", once each turn during your turn, without tapping.
        if (e.oncePerTurn) {
          if (this.activeSeat === p.seat && !perm.usedThisTurn.includes(e)) {
            const amount = this.manaCount(p, perm, e);
            if (amount > 0) out.push({ perm, colors: e.colors, amount, once: e });
          }
          continue;
        }
        if (tapBlocked) continue;
        if (e.energy && energy < e.energy) continue;
        if (e.corrupted && !corrupted) continue;
        const amount = e.charge === 'tap' ? charge : e.charge === 'grow' ? charge + 1 : e.count ? this.manaCount(p, perm, e) : e.amount;
        if (amount <= 0) continue;
        const src: ManaSource = { perm, colors: e.colors, amount: amount + (boosts?.has('colorless') && Array.isArray(e.colors) && e.colors.every((c) => c === 'C') ? 1 : 0), ...(e.energy ? { energy: e.energy } : {}), ...(e.charge ? { charge: e.charge } : {}) };
        if (!best || src.amount > best.amount || (src.amount === best.amount && e.colors === 'any' && best.colors !== 'any')) best = src;
      }
      // Insidious Roots: creature tokens tap for any color.
      if (!best && !tapBlocked && tokenMana) best = { perm, colors: 'any', amount: 1 };
      if (best) {
        if (best.energy) energy -= best.energy;
        out.push(best);
      }
    }
    if (this.kindsInGame.has('mana:sacArtifact')) out.push(...this.sacrificeForMana(p, exclude));
    // Goldspan Dragon: "Treasures you control have '{T}, Sacrifice this artifact: Add two mana of any one color.'"
    const treasure = this.kindsInGame.has('treasureBoost') && this.statics(p, 'treasureBoost') > 0 ? 2 : 1;
    if (!(locks && this.abilitiesLocked(p, TREASURE_TYPES, lockers))) for (let i = 0; i < p.treasures; i++) out.push({ perm: null, colors: 'any', amount: treasure });
    return out;
  }

  /** "Draw cards equal to ...": counted as the effect resolves. */
  drawCount(p: PlayerState, count: 'greatestPower' | 'greatestToughness' | 'handPlusOne' | 'redDevotion'): number {
    const creatures = p.battlefield.filter((q) => q.card.isCreature);
    switch (count) {
      case 'greatestPower': return Math.max(0, ...creatures.map((q) => this.power(q)));
      case 'greatestToughness': return Math.max(0, ...creatures.map((q) => this.toughness(q)));
      case 'handPlusOne': return p.hand.length + 1;
      case 'redDevotion': return this.devotionTo(p, ['R']);
    }
  }

  /** How much a mana ability that counts something makes: the source's power (Vivi) or your enchantments (Sanctum Weaver). */
  private manaCount(p: PlayerState, perm: Perm, e: Extract<Effect, { kind: 'mana' }>): number {
    if (e.count === 'power') return this.power(perm);
    if (e.count === 'enchantments') return p.battlefield.filter((q) => q.card.isEnchantment).length;
    if (e.count === 'colors') return colorsAmong(p.battlefield.map((q) => q.card));
    if (e.count === 'chosenType') return p.battlefield.filter((q) => q.card.isCreature && this.isType(q, 'chosen', perm)).length;
    if (e.count === 'devotion') return Math.max(...(['W', 'U', 'B', 'R', 'G'] as Color[]).map((c) => this.devotionTo(p, [c])));
    return e.amount;
  }

  /** Krark-Clan Ironworks: each artifact token that isn't worth keeping (no bigger than a 1/1) is mana when sacrificed. */
  private sacrificeForMana(p: PlayerState, exclude?: Perm): ManaSource[] {
    const outlet = p.battlefield.find((q) => q.card.effects.some((e) => e.kind === 'mana' && e.sacArtifact));
    if (!outlet) return [];
    const e = outlet.card.effects.find((f) => f.kind === 'mana' && f.sacArtifact) as Extract<Effect, { kind: 'mana' }>;
    return p.battlefield
      .filter((q) => q !== exclude && q !== outlet && q.token && q.card.isArtifact && (!q.card.isCreature || this.power(q) <= 1) && !q.card.effects.some((f) => f.kind === 'mana'))
      .map((q) => ({ perm: q, colors: e.colors, amount: e.amount, sac: true }));
  }

  /** The mana boosts `p` has (manaBoost effects). */
  private manaBoosts(p: PlayerState): Set<string> {
    const out = new Set<string>();
    for (const perm of p.battlefield) for (const e of perm.card.effects) if (e.kind === 'manaBoost' && e.when === 'static') out.add(e.what);
    return out;
  }

  /** Extra mana a land makes from `p`'s mana boosts. */
  private landBoost(land: Perm, colors: Mana[] | 'any', boosts: Set<string>): number {
    let n = 0;
    if (boosts.has('lands')) n++;
    if (boosts.has('swamps') && (/\bSwamp\b/.test(land.card.typeLine) || (Array.isArray(colors) && colors.length === 1 && colors[0] === 'B' && land.card.isBasic))) n++;
    if (boosts.has('colorless') && this.colorlessLand(land)) n++;
    if (boosts.has('chosenColor')) {
      const main = this.mainColor(this.players[land.seat]);
      if (main && (colors === 'any' || colors.includes(main))) n++;
    }
    return n;
  }

  /** "Choose a color" for a deck: the color most of its lands make (Caged Sun). */
  private mainColor(p: PlayerState): Color | null {
    let best: Color | null = null;
    let most = 0;
    for (const c of p.identity) {
      const n = p.battlefield.filter((q) => q.landInfo && (q.landInfo.produces === 'any' || q.landInfo.produces.includes(c))).length;
      if (n > most) {
        most = n;
        best = c;
      }
    }
    return best;
  }

  /** A land that taps only for {C}. */
  private colorlessLand(perm: Perm): boolean {
    const m = perm.landInfo?.produces;
    return Array.isArray(m) && m.length > 0 && m.every((c) => c === 'C');
  }

  /** Total mana `p` could produce right now. */
  availableMana(p: PlayerState): number {
    let n = 0;
    for (const s of this.manaSources(p)) n += s.amount;
    return n;
  }

  /**
   * What a land taps for, after Blood Moon and Harbinger of the Seas (a nonbasic land that is a Mountain
   * or an Island has only that mana ability, rule 305.7) and Dryad of the Ilysian Grove (every basic land type).
   */
  landProduces(perm: Perm): Mana[] | 'any' {
    const base = perm.landInfo?.produces ?? [];
    if (!this.kindsInGame.has('landRule')) return base;
    const rules = this.landRules(null);
    if (!perm.card.isBasic && !perm.unlocked) {
      if (rules.has('nonbasicMountains')) return ['R'];
      if (rules.has('nonbasicIslands')) return ['U'];
    }
    if (this.landRules(this.players[perm.seat]).has('everyType')) return 'any';
    return base;
  }

  /** The land rules on the battlefield: `p`'s own (for "lands you control"), or everyone's with null. */
  private landRules(p: PlayerState | null): Set<string> {
    const out = new Set<string>();
    if (!this.kindsInGame.has('landRule')) return out;
    for (const q of p ? [p] : this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) for (const e of perm.card.effects) if (e.kind === 'landRule' && e.when === 'static') out.add(e.rule);
    }
    return out;
  }

  /**
   * Back to Basics, Winter Moon, Winter Orb: which of `p`'s tapped lands may untap this untap step.
   * With a limit of one, the land that makes the most mana for `p`'s colors untaps.
   */
  private untapLimits(p: PlayerState): (perm: Perm) => boolean {
    const rules = this.landRules(null);
    if (!rules.size) return () => true;
    const noNonbasic = rules.has('nonbasicNoUntap');
    const oneNonbasic = rules.has('untapOneNonbasic');
    const oneLand = rules.has('untapOneLand');
    if (!noNonbasic && !oneNonbasic && !oneLand) return () => true;
    const tapped = p.battlefield.filter((q) => q.landInfo && q.tapped && !(noNonbasic && !q.card.isBasic));
    const best = (list: Perm[]) => list.sort((a, b) => (this.landProduces(b) === 'any' ? 6 : this.landProduces(b).length) - (this.landProduces(a) === 'any' ? 6 : this.landProduces(a).length))[0];
    let allowed: Set<Perm>;
    if (oneLand) allowed = new Set(tapped.length ? [best(tapped)] : []);
    else if (oneNonbasic) {
      const nonbasic = tapped.filter((q) => !q.card.isBasic);
      allowed = new Set([...tapped.filter((q) => q.card.isBasic), ...(nonbasic.length ? [best(nonbasic)] : [])]);
    } else allowed = new Set(tapped);
    return (perm) => allowed.has(perm);
  }

  colorsAvailable(p: PlayerState): Set<Mana> {
    const set = new Set<Mana>();
    for (const perm of p.battlefield) {
      let produces: Mana[] | 'any' | undefined = perm.landInfo ? this.landProduces(perm) : undefined;
      const all: (Mana[] | 'any')[] = produces ? [produces] : [];
      if (!produces) for (const e of perm.card.effects) if (e.kind === 'mana' && (!e.energy || p.energy >= e.energy)) all.push(e.colors);
      for (const made of all) {
        if (made === 'any') p.identity.forEach((c) => set.add(c));
        else made.forEach((c) => set.add(c));
      }
    }
    if (p.treasures || this.livePool(p).some((m) => m.colors === 'any')) p.identity.forEach((c) => set.add(c));
    return set;
  }

  landCount(p: PlayerState): number {
    let n = 0;
    for (const perm of p.battlefield) if (perm.landInfo) n++;
    return n;
  }

  private costReduction(p: PlayerState, card: SimCard, fromCommand = false): number {
    let n = 0;
    for (const perm of p.battlefield) {
      for (const e of perm.card.effects) {
        if (e.kind === 'costReduction' && matchesFilter(this.spellTypes(p, card), e.filter) && this.reductionApplies(p, card, e, fromCommand)) {
          n += e.affinity ? p.battlefield.filter((q) => q.card.isArtifact).length * e.amount : e.amount;
        }
      }
    }
    // Affinity, improvise, convoke, delve and "costs {1} less for each ...".
    const d = card.discount;
    if (d) {
      let count = 0;
      if (d.per === 'artifacts') count = p.battlefield.filter((q) => q.card.isArtifact).length;
      else if (d.per === 'creatures') count = p.battlefield.filter((q) => q.card.isCreature).length;
      else if (d.per === 'allCreatures') count = this.allPerms().filter((q) => q.card.isCreature).length;
      else if (d.per === 'graveyardCreatures') count = p.graveyard.filter((c) => c.isCreature).length;
      else if (d.per === 'graveyard') count = p.graveyard.length;
      else count = this.discountCount(p, d);
      n += (d.once ? Math.min(1, count) : count) * d.amount;
    }
    return n;
  }

  /** Where a spell is cast from and what came before it this turn, for reductions that care (see the costReduction effect). */
  private reductionApplies(p: PlayerState, card: SimCard, e: Extract<Effect, { kind: 'costReduction' }>, fromCommand: boolean): boolean {
    if (e.minCmc && card.cmc < e.minCmc) return false;
    if (e.from) {
      const zone = fromCommand ? 'command' : card.castZone ?? 'hand';
      if (e.from === 'graveyard' && zone !== 'graveyard') return false;
      if (e.from === 'graveyardOrExile' && zone !== 'graveyard' && zone !== 'exile') return false;
      if (e.from === 'notHand' && zone === 'hand') return false;
      if (e.from === 'hand' && zone !== 'hand') return false;
    }
    if (e.first) {
      const cast = e.filter === 'creature' ? p.creatureSpellsThisTurn : e.filter === 'instantSorcery' ? p.instantSorceryThisTurn : p.spellsThisTurn;
      if ((cast ?? 0) > 0) return false;
    }
    return true;
  }

  /** The count behind "costs {1} less for each ..." and "costs {2} less if ..." (see classifyCounting.ts). */
  private discountCount(p: PlayerState, d: NonNullable<SimCard['discount']>): number {
    switch (d.per) {
      case 'tokens': return p.battlefield.filter((q) => q.token).length + p.treasures;
      case 'subtype': return p.battlefield.filter((q) => hasSubtype(q.card, d.subtype ?? '')).length;
      case 'party': return this.partySize(p);
      case 'graveyardTypes': return cardTypeCount(p.graveyard);
      case 'spellsInGraveyard': return p.graveyard.filter((c) => c.isInstant || c.isSorcery).length;
      case 'diedThisTurn': return this.diedThisTurn;
      case 'energyPaid': return p.energyPaid ?? 0;
      case 'bigCreature': return p.battlefield.some((q) => q.card.isCreature && this.power(q) >= 4) ? 1 : 0;
      case 'poisoned': return this.opponents(p).some((o) => o.poison >= 3) ? 1 : 0;
      case 'legendaryTarget': return this.opponents(p).some((o) => o.battlefield.some((q) => q.card.isCreature && q.card.isLegendary && this.canTarget(p, q))) ? 1 : 0;
      case 'attackingTarget': return this.attackers().some((q) => q.seat !== p.seat) ? 1 : 0;
      case 'opponentArtifacts': return Math.max(0, ...this.opponents(p).map((o) => o.battlefield.filter((q) => q.card.isArtifact).length + o.treasures));
      case 'historicValue': return p.battlefield.filter((q) => q.card.isArtifact || q.card.isLegendary || !!q.card.saga).reduce((n, q) => n + q.card.cmc, 0);
      default: return 0;
    }
  }

  /** Party (rule 700.8): up to one each of Cleric, Rogue, Warrior and Wizard among your creatures. */
  partySize(p: PlayerState): number {
    const roles = ['Cleric', 'Rogue', 'Warrior', 'Wizard'];
    const creatures = p.battlefield.filter((q) => q.card.isCreature).map((q) => roles.filter((r) => hasSubtype(q.card, r)));
    // Fill the rarest roles first, so a Cleric Wizard doesn't take the only Wizard slot from a lone Wizard.
    const used = new Set<number>();
    let n = 0;
    for (const role of [...roles].sort((a, b) => creatures.filter((c) => c.includes(a)).length - creatures.filter((c) => c.includes(b)).length)) {
      const i = creatures.findIndex((c, j) => !used.has(j) && c.includes(role));
      if (i === -1) continue;
      used.add(i);
      n++;
    }
    return n;
  }

  /** Static rules about untapping (Stasis, Meekstone). */
  private untapRules(): Set<string> {
    const out = new Set<string>();
    if (!this.kindsInGame.has('untapRule')) return out;
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) for (const e of perm.card.effects) if (e.kind === 'untapRule' && e.when === 'static') out.add(e.rule);
    }
    return out;
  }

  /** "At the beginning of your upkeep, sacrifice ~ unless you pay {U}" (Stasis): paid whenever it can be. */
  private upkeepCosts(p: PlayerState) {
    for (const perm of [...p.battlefield]) {
      for (const e of perm.card.effects) {
        if (e.kind !== 'upkeepCost' || e.when !== 'static') continue;
        const plan = this.planPayment(p, e.cost, 0, 0);
        if (plan) {
          this.commitPayment(p, plan);
          this.say(`${p.name} pays the upkeep of ${perm.card.name}.`);
        } else {
          this.say(`${p.name} can't pay the upkeep of ${perm.card.name} and sacrifices it.`);
          this.removePerm(perm, 'graveyard');
          this.sacrificed(p);
        }
      }
    }
  }

  /** Mana Echoes: creatures `p` controls that share a creature type with the one that entered (itself included). */
  private sharingType(p: PlayerState, entering: Perm): number {
    const types = (entering.card.typeLine.split('—')[1] ?? '').trim().split(/\s+/).filter(Boolean);
    if (!types.length && !entering.card.keywords.includes('changeling')) return 0;
    return p.battlefield.filter((q) => q.card.isCreature && (entering.card.keywords.includes('changeling') || types.some((t) => hasSubtype(q.card, t)))).length;
  }

  /**
   * Training Grounds, Heartstone, Zirda: how much less this activated ability costs. It can't go below
   * one mana (rule 601.2f), and only generic mana is taken off.
   */
  abilityDiscount(p: PlayerState, perm: Perm, e: Effect): number {
    if (!this.kindsInGame.has('abilityDiscount') || !e.activation || e.kind === 'mana') return 0;
    let n = 0;
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const src of q.battlefield) for (const f of src.card.effects) {
        if (f.kind !== 'abilityDiscount' || f.when !== 'static') continue;
        if (f.of === 'all' ? q === p : f.of === 'yours' ? q === p && perm.seat === p.seat && perm.card.isCreature : perm.card.isCreature) n += f.amount;
      }
    }
    const cost = e.activation.cost;
    return Math.max(0, Math.min(n, cost.generic, cost.generic + cost.pips.length - 1));
  }

  /** Commander tax: {2} more for each earlier cast from the command zone (rule 903.8). */
  commanderTax(p: PlayerState, card: SimCard, fromCommand: boolean): number {
    return fromCommand ? 2 * (p.commanderCasts.get(card.name) ?? 0) : 0;
  }

  /** Total mana a spell would cost right now. */
  /** Fierce Guardianship and friends cost nothing while their controller's commander is on the battlefield. */
  private isFree(p: PlayerState, card: SimCard): boolean {
    return !!card.freeWithCommander && p.battlefield.some((q) => q.isCommander);
  }

  /** Can `p` pay this spell's additional cost (a sacrifice and/or a discard)? */
  private canPayExtra(p: PlayerState, card: SimCard): boolean {
    const c = card.extraCost;
    if (!c) return true;
    const sac = c.sacrifice ? this.sacrificeChoices(p, c.sacrifice).length > 0 : true;
    const disc = c.discard ? p.hand.filter((h) => h !== card).length >= c.discard : true;
    return c.either ? (!!c.sacrifice && sac) || (!!c.discard && disc) : sac && disc;
  }

  private sacrificeChoices(p: PlayerState, what: 'creature' | 'artifact' | 'artifactOrCreature'): Perm[] {
    return p.battlefield.filter((q) => (what !== 'artifact' && q.card.isCreature) || (what !== 'creature' && q.card.isArtifact));
  }

  /** Grand Arbiter, Thalia: extra generic mana `p` pays for this spell. */
  private spellTax(p: PlayerState, card: SimCard): number {
    if (!this.kindsInGame.has('spellTax')) return 0;
    let tax = 0;
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) for (const e of perm.card.effects) {
        if (e.kind === 'spellTax' && (e.all || q !== p) && (e.filter === 'any' || !card.isCreature) && (e.minCmc === undefined || card.cmc >= e.minCmc)) tax += e.amount;
      }
    }
    return tax;
  }

  effectiveCost(p: PlayerState, card: SimCard, fromCommand = false, x = 0): number {
    if (this.isFree(p, card)) return this.spellTax(p, card);
    const base = card.cost.generic + card.cost.x * x + this.commanderTax(p, card, fromCommand) + this.spellTax(p, card);
    return Math.max(0, base - this.costReduction(p, card, fromCommand)) + card.cost.pips.length;
  }

  /**
   * Work out which sources pay for a cost. Returns the sources and how many
   * units each contributes, or null if it can't be paid. Greedy: pay the
   * hardest colored pips first with the least flexible sources.
   */
  private planPayment(p: PlayerState, cost: ManaCost, extraGeneric: number, reduction: number, exclude?: Perm, ability = false): Map<ManaSource, number> | null {
    const sources = this.manaSources(p, exclude, ability);
    const remaining = sources.map((s) => s.amount);
    const used = new Map<ManaSource, number>();
    const can = (s: ManaSource, pip: Mana[]) => {
      if (s.colors === 'any') return pip.some((m) => m === 'C' || p.identity.includes(m as Color) || p.identity.length === 0);
      return pip.some((m) => (s.colors as Mana[]).includes(m));
    };
    // Treasures, +1/+1 counters and sacrificed tokens are spent last.
    const flex = (s: ManaSource) => (s.pool ? (s.pool.abilityOnly ? -20 : -10) : (s.colors === 'any' ? 6 : s.colors.length) + (s.perm === null ? 10 : 0) + (s.counters ? 15 : 0) + (s.sac ? 30 : 0));
    const take = (i: number) => {
      remaining[i]--;
      used.set(sources[i], (used.get(sources[i]) ?? 0) + 1);
    };

    const pips = cost.pips.length > 1
      ? [...cost.pips].sort((a, b) => sources.filter((s) => can(s, a)).length - sources.filter((s) => can(s, b)).length)
      : cost.pips;
    for (const pip of pips) {
      let best = -1;
      for (let i = 0; i < sources.length; i++) {
        if (remaining[i] <= 0 || !can(sources[i], pip)) continue;
        if (best === -1 || flex(sources[i]) < flex(sources[best]) || (flex(sources[i]) === flex(sources[best]) && used.has(sources[i]) && !used.has(sources[best]))) best = i;
      }
      if (best === -1) return null;
      take(best);
    }

    let generic = Math.max(0, cost.generic + extraGeneric - reduction);
    while (generic > 0) {
      let best = -1;
      let bestScore = Infinity;
      for (let i = 0; i < sources.length; i++) {
        if (remaining[i] <= 0) continue;
        // Prefer leftovers from sources already tapped, then sources that fit exactly, then least flexible.
        let score = flex(sources[i]);
        if (used.has(sources[i])) score -= 20;
        if (remaining[i] > generic) score += 5;
        if (score < bestScore) {
          best = i;
          bestScore = score;
        }
      }
      if (best === -1) return null;
      take(best);
      generic--;
    }
    return used;
  }

  private commitPayment(p: PlayerState, plan: Map<ManaSource, number>) {
    const lands: Perm[] = [];
    for (const [src, units] of plan) {
      if (src.pool) src.pool.n -= units;
      else if (src.perm && src.charge === 'spend') src.perm.charge = Math.max(0, (src.perm.charge ?? 0) - units);
      else if (src.perm && src.counters) src.perm.counters = Math.max(0, src.perm.counters - units);
      else if (src.perm && src.once) src.perm.usedThisTurn.push(src.once);
      else if (src.perm && src.sac) {
        this.say(`${p.name} sacrifices ${src.perm.card.name} for mana.`);
        this.removePerm(src.perm, 'graveyard');
        this.sacrificed(p);
      } else if (src.perm) {
        src.perm.tapped = true;
        if (src.perm.landInfo) lands.push(src.perm);
        if (src.energy) p.energy = Math.max(0, p.energy - src.energy);
        // Empowered Autogenerator: the counter goes on as part of the ability.
        if (src.charge === 'grow') src.perm.charge = (src.perm.charge ?? 0) + 1;
      } else if (units > 0) {
        // Each Treasure is its own source (two mana with Goldspan Dragon) and is sacrificed on its own: Korvold and Juri trigger once for each.
        p.treasures -= 1;
        this.sacrificed(p);
        if (this.kindsInGame.has('when:permDies')) this.permDied(null, p.seat);
      }
    }
    if (lands.length && this.kindsInGame.has('tapPunish')) this.landsTapped(p, lands);
    // Treasure Nabber: an opponent taps an artifact for mana, and the Nabber's controller takes it until the end of their next turn.
    if (this.kindsInGame.has('nabArtifacts')) {
      const artifacts = [...plan.keys()].flatMap((src) => (src.perm && !src.perm.landInfo && src.perm.card.isArtifact && src.charge !== 'spend' ? [src.perm] : []));
      for (const o of this.opponents(p)) {
        if (!artifacts.length || this.statics(o, 'nabArtifacts') === 0) continue;
        for (const q of artifacts) {
          if (q.seat !== p.seat) continue;
          this.takeControl(q, o);
          q.borrowed = { until: 'nextTurn', by: o.seat, turn: this.turnNumber };
          this.anyTemporary = true;
        }
        break;
      }
    }
  }

  /** Manabarbs, Burning Earth, War's Toll, Mana Web, Price of Glory: `p` just tapped these lands for mana. */
  private landsTapped(p: PlayerState, lands: Perm[]) {
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const src of q.battlefield) for (const e of src.card.effects) {
        if (e.kind !== 'tapPunish' || e.when !== 'static' || (e.opponents && q === p)) continue;
        const hit = e.nonbasic ? lands.filter((l) => !l.card.isBasic) : lands;
        if (!hit.length) continue;
        if (e.what === 'damage') {
          const lost = this.loseLife(p, e.n * hit.length, q === p ? null : q, 'noncombat');
          if (lost) this.say(`${src.card.name} deals ${lost} damage to ${p.name} for tapping lands (life ${p.life}).`);
        } else if (e.what === 'tapAll') {
          for (const l of p.battlefield) if (l.landInfo) l.tapped = true;
        } else if (e.what === 'destroyOffTurn' && this.activeSeat !== p.seat) {
          this.say(`${src.card.name} destroys ${hit.map((l) => l.card.name).join(', ')} (${p.name}).`);
          for (const l of hit) this.destroy(l);
        }
      }
    }
  }

  private spellPlan(p: PlayerState, card: SimCard, fromCommand: boolean, x: number, extra: number) {
    if (card.cost.life > 0 && card.cost.life >= p.life) return null;
    if (!this.canPayExtra(p, card)) return null;
    const tax = this.spellTax(p, card);
    if (this.isFree(p, card)) return this.planPayment(p, NO_COST, extra + tax, 0);
    return this.planPayment(p, card.cost, card.cost.x * x + this.commanderTax(p, card, fromCommand) + extra + tax, this.costReduction(p, card, fromCommand));
  }

  canAfford(p: PlayerState, card: SimCard, fromCommand = false, x = 0, extra = 0): boolean {
    return this.spellPlan(p, card, fromCommand, x, extra) !== null;
  }

  /** Largest X `p` could pay for this card right now. */
  maxX(p: PlayerState, card: SimCard, fromCommand = false): number {
    // Toxic Deluge: X is paid in life.
    if (card.xFromLife) return Math.max(0, Math.min(p.life - 1, 15));
    if (card.cost.x === 0) return 0;
    let x = 0;
    while (x < 30 && this.canAfford(p, card, fromCommand, x + 1)) x++;
    return x;
  }

  // -------------------------------------------------------------------------
  // Targets (rule 115)
  // -------------------------------------------------------------------------

  /** Every permanent on the battlefield. */
  allPerms(): Perm[] {
    const out: Perm[] = [];
    for (const q of this.players) if (q.alive) for (const perm of q.battlefield) out.push(perm);
    return out;
  }

  findPerm(id: number | null): Perm | null {
    if (id === null) return null;
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) if (perm.id === id) return perm;
    }
    return null;
  }

  /** Hexproof stops opponents; shroud stops everyone (rules 702.11, 702.18). */
  canTarget(by: PlayerState, perm: Perm): boolean {
    // Emblems aren't permanents: nothing can target them (rule 114.5).
    if (perm.emblem || this.hasKw(perm, 'shroud')) return false;
    if (perm.seat !== by.seat && this.hasKw(perm, 'hexproof')) return false;
    // Protection and "hexproof from": checked against the spell or ability doing the targeting, when it is known.
    if (this.aim && this.kindsInGame.has('protection')) {
      const kws = this.protections(perm);
      if (kws.length) {
        const { card, seat, ability } = this.aim;
        if (kws.some((k) => k.startsWith('pro:') && this.quality(k.slice(4), card, seat, ability))) return false;
        if (seat !== perm.seat && kws.some((k) => k.startsWith('hexfrom:') && this.quality(k.slice(8), card, seat, ability))) return false;
      }
    }
    return true;
  }

  /** Protection and "hexproof from" keywords `perm` has now: printed, gained this turn, from Equipment and anthems, and Vexilus Praetor's for commanders. */
  protections(perm: Perm): string[] {
    if (!this.kindsInGame.has('protection') && !this.kindsInGame.has('commanderKeywords')) return [];
    const out = [...perm.card.keywords, ...perm.tempKw].filter(isProtection);
    for (const eq of this.attachments(perm)) for (const e of eq.card.effects) if (e.kind === 'equip') out.push(...e.keywords.filter(isProtection));
    if (perm.isCommander && this.kindsInGame.has('commanderKeywords')) {
      for (const q of this.players[perm.seat].battlefield) for (const e of q.card.effects) if (e.kind === 'commanderKeywords') out.push(...e.keywords);
    }
    return out;
  }

  /** Does a source (a card controlled by `seat`; `ability`: an activated or triggered ability) have this quality? (rule 702.16a) */
  private quality(q: string, card: SimCard, seat: number, ability: boolean): boolean {
    if (q === 'all') return true;
    if (q === 'ability') return ability;
    if (/^[WUBRG]$/.test(q)) return cardColors(card).includes(q as Color);
    if (q === 'multi') return cardColors(card).length > 1;
    if (q === 'mono') return cardColors(card).length === 1;
    if (q.startsWith('mv<=')) return card.cmc <= parseInt(q.slice(4), 10) && !card.isLand;
    if (q.startsWith('mv>=')) return card.cmc >= parseInt(q.slice(4), 10);
    if (q.startsWith('sub:')) return card.isCreature && hasSubtype(card, q.slice(4));
    switch (q) {
      case 'instant': return card.isInstant;
      case 'sorcery': return card.isSorcery;
      case 'creature': return card.isCreature;
      case 'artifact': return card.isArtifact;
      case 'enchantment': return card.isEnchantment;
      case 'planeswalker': return card.isPlaneswalker;
      case 'land': return card.isLand;
    }
    void seat;
    return false;
  }

  /** Has `perm` protection from this source? (rule 702.16) */
  protectedFromCard(perm: Perm, card: SimCard, seat: number): boolean {
    if (!this.kindsInGame.has('protection') && !this.kindsInGame.has('commanderKeywords')) return false;
    return this.protections(perm).some((k) => k.startsWith('pro:') && this.quality(k.slice(4), card, seat, false));
  }

  /** Absolute Virtue: `p` has protection from each of their opponents, so damage their sources deal to `p` is prevented (rule 702.16j). */
  playerProtectedFrom(p: PlayerState, seat: number): boolean {
    return seat !== p.seat && this.kindsInGame.has('playerProtection') && p.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'playerProtection'));
  }

  /**
   * The color to give `perm` protection from (Mother of Runes): the color of a spell or ability aimed at it, else of
   * the creatures it is fighting, else the color most common among its opponents' permanents.
   */
  threatColor(perm: Perm): Color {
    const count = new Map<Color, number>();
    const add = (card: SimCard, w: number) => { for (const c of cardColors(card)) count.set(c, (count.get(c) ?? 0) + w); };
    for (const item of this.stack) if (item.controller !== perm.seat && item.targets.some((t) => t?.kind === 'perm' && t.id === perm.id)) add(item.card, 100);
    for (const q of this.allPerms()) {
      if (q.seat === perm.seat) continue;
      if (q.blocking === perm.id || perm.blocking === q.id) add(q.card, 20);
      else if (q.card.isCreature) add(q.card, 2);
      else add(q.card, 1);
    }
    let best: Color = 'B';
    let most = 0;
    for (const [c, k] of count) if (k > most) [best, most] = [c, k];
    return best;
  }

  /** Choose or check targets as `card` (a spell, or an ability when `ability`) controlled by `seat`. */
  private aimAs<T>(card: SimCard, seat: number, ability: boolean, f: () => T): T {
    const before = this.aim;
    this.aim = { card, seat, ability };
    try {
      return f();
    } finally {
      this.aim = before;
    }
  }

  private wardCost(by: PlayerState, t: Target | null): number {
    return this.wardOf(by, t)?.mana ?? 0;
  }

  /** Ward on a permanent `by` targets (rule 702.21): its printed cost, or {2} for ward granted without one. */
  private wardOf(by: PlayerState, t: Target | null): { mana?: number; life?: number; discard?: number; sacrifice?: number } | null {
    if (!t || t.kind !== 'perm') return null;
    const perm = this.findPerm(t.id);
    if (!perm || perm.seat === by.seat || !this.hasKw(perm, 'ward')) return null;
    return perm.card.ward ?? { mana: WARD_COST };
  }

  /** Can `p` pay the parts of these targets' ward costs that aren't mana (life, discards, sacrifices)? `spell`: a card leaving the hand to be cast. */
  private wardPayable(p: PlayerState, targets: (Target | null)[], spell?: SimCard): boolean {
    let life = 0, discard = 0, sacrifice = 0;
    for (const t of targets) {
      const w = this.wardOf(p, t);
      life += w?.life ?? 0;
      discard += w?.discard ?? 0;
      sacrifice += w?.sacrifice ?? 0;
    }
    // Life can be paid only up to your life total (rule 119.4).
    return (life === 0 || p.life >= life) && p.hand.filter((c) => c !== spell).length >= discard && p.battlefield.length >= sacrifice;
  }

  /** Pay the life, discards and sacrifices ward asks for (rule 702.21a). */
  private *payWardOther(p: PlayerState, targets: (Target | null)[], spell?: SimCard): Flow<void> {
    for (const t of targets) {
      const w = this.wardOf(p, t);
      if (!w || (!w.life && !w.discard && !w.sacrifice)) continue;
      const what = this.describeTarget(t!);
      if (w.life) {
        p.life -= w.life;
        this.say(`${p.name} pays ${w.life} life for ward (${what}).`);
      }
      if (w.discard) {
        const options = p.hand.filter((c) => c !== spell);
        const picks = yield* this.choose(p, 'discard', `Ward (${what}): discard ${w.discard} card${w.discard > 1 ? 's' : ''}.`, options.map((c) => ({ label: c.name, card: c })), Math.min(w.discard, options.length), Math.min(w.discard, options.length));
        for (const c of picks.map((i) => options[i])) {
          p.hand.splice(p.hand.indexOf(c), 1);
          this.discarded(p, c);
        }
      }
      if (w.sacrifice) {
        const options = p.battlefield.filter((q) => !q.emblem);
        const picks = yield* this.choose(p, 'sacrifice', `Ward (${what}): sacrifice ${w.sacrifice} permanent${w.sacrifice > 1 ? 's' : ''}.`, options.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), Math.min(w.sacrifice, options.length), Math.min(w.sacrifice, options.length));
        for (const q of picks.map((i) => options[i])) {
          this.say(`${p.name} sacrifices ${q.card.name} for ward.`);
          this.removePerm(q, 'graveyard');
          this.sacrificed(p, q);
        }
      }
    }
  }

  /**
   * What an effect could target if `p` used it now. null means the effect
   * doesn't target; an empty list means it targets but nothing is legal.
   */
  targetCandidates(p: PlayerState, e: Effect, src: Perm | null): Target[] | null {
    const out = this.targetCandidatesAny(p, e, src);
    // "You have hexproof" (Teyo, Leyline of Sanctity): opponents can't target that player (rule 702.11c).
    if (!out || !this.kindsInGame.has('playerHexproof')) return out;
    return out.filter((t) => t.kind !== 'player' || t.seat === p.seat || !this.players[t.seat].battlefield.some((q) => q.card.effects.some((x) => x.kind === 'playerHexproof' && x.when === 'static')));
  }

  private targetCandidatesAny(p: PlayerState, e: Effect, src: Perm | null): Target[] | null {
    const ids = (perms: Perm[]): Target[] => perms.map((q) => ({ kind: 'perm', id: q.id }));
    switch (e.kind) {
      case 'ownPerm':
        return ids(this.allPerms().filter((q) => q !== src && !q.emblem && (q.owner ?? q.seat) === p.seat && this.canTarget(p, q)));
      case 'removeFromCombat':
        return ids(p.battlefield.filter((q) => q.attacking !== null && this.canTarget(p, q)));
      case 'ozolith':
        if (e.act !== 'release') return null;
        return src?.counters ? ids(this.allPerms().filter((q) => q.card.isCreature && this.canTarget(p, q))) : [];
      case 'moveCounters':
        return ids(p.battlefield.filter((q) => q !== src && !q.emblem && this.canTarget(p, q) && (e.from === 'subject' || ((q.card.isCreature || q.card.isArtifact) && this.counterDonor(p, q) !== null))));
      case 'textChange':
        return ids(this.allPerms().filter((q) => !q.emblem && this.canTarget(p, q)));
      case 'removal': {
        if (e.each) return null;
        if (e.mode === 'edict') {
          return this.opponents(p).filter((o) => o.battlefield.some((q) => q.card.isCreature)).map((o) => ({ kind: 'player', seat: o.seat }));
        }
        const out: Target[] = [];
        const lands = e.target === 'land' || e.target === 'nonbasicLand';
        if (lands) {
          // Land destruction: "target land", "target nonbasic land (an opponent controls)".
          for (const perm of this.allPerms()) if (perm.landInfo && perm !== src && (e.target === 'land' || !perm.card.isBasic) && this.canTarget(p, perm)) out.push({ kind: 'perm', id: perm.id });
          return out;
        }
        for (const perm of this.allPerms()) {
          // Damage to any target can hit planeswalkers and battles too; "creature or planeswalker", planeswalkers (rule 115.4).
          if (this.damageWalker(e, perm)) {
            if (perm !== src && this.canTarget(p, perm) && !e.bountyOnly) out.push({ kind: 'perm', id: perm.id });
            continue;
          }
          if (perm === src || perm.card.isLand || !this.removable(e.target, perm) || !this.canTarget(p, perm)) continue;
          if (e.bountyOnly && !perm.bounty) continue;
          if ((e.mode === 'damage' || e.mode === 'fight') && !perm.card.isCreature) continue;
          if (e.mode === 'fight' && perm.seat === p.seat) continue;
          out.push({ kind: 'perm', id: perm.id });
        }
        if (e.mode === 'fight' && !(src?.card.isCreature || p.battlefield.some((q) => q.card.isCreature))) return [];
        if (e.mode === 'damage' && e.anyTarget) for (const o of this.alivePlayers()) out.push({ kind: 'player', seat: o.seat });
        return out;
      }
      case 'counter':
        return this.stack.filter((s) => s.kind === 'spell' && counterMatches(e.target, s.card) && (e.cmc === undefined || s.card.cmc === e.cmc) && !s.card.keywords.includes('uncounterable') && !this.uncounterable(s)).map((s) => ({ kind: 'stack', id: s.id }));
      case 'pump': {
        if (e.self) return null;
        const out: Target[] = [];
        for (const perm of this.allPerms()) if (perm.card.isCreature && this.canTarget(p, perm)) out.push({ kind: 'perm', id: perm.id });
        return out;
      }
      case 'protect':
        if (e.all || e.player) return null;
        return p.battlefield.filter((q) => !q.card.isLand && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'damagePlayer':
        return this.opponents(p).map((o) => ({ kind: 'player', seat: o.seat }));
      case 'mill':
      case 'discard':
        if (e.who !== 'target') return null;
        return this.alivePlayers().filter((o) => e.kind === 'mill' || (o !== p && o.hand.length > 0)).map((o) => ({ kind: 'player', seat: o.seat }));
      case 'goad':
        if (e.all) return null;
        return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'suspect':
        // The bot suspects an opponent's creature: it can't block and gets goaded along with the rest.
        return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && !q.suspected && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'pacify':
        // Any creature: an opponent's attacker on their turn, or a blocker on ours.
        return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'protectColor':
        return p.battlefield.filter((q) => q.card.isCreature && q !== (e.toxic ? src : null) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'blink':
        return p.battlefield.filter((q) => q !== src && this.blinkable(p, q, e)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'copySpell':
        if (e.what === 'trigger') return null;
        // Lithoform Engine, Double Major: a permanent (or creature) spell you control.
        if (e.what === 'permanentSpell' || e.what === 'creatureSpell') return this.stack.filter((s) => s.kind === 'spell' && s.controller === p.seat && !s.copy && !s.card.isInstant && !s.card.isSorcery && (e.what === 'permanentSpell' || s.card.isCreature)).map((s) => ({ kind: 'stack', id: s.id }));
        if (e.what === 'ability') return this.stack.filter((s) => s.kind === 'ability' && s.controller === p.seat && s.sourceId !== src?.id && s.effects.length > 0).map((s) => ({ kind: 'stack', id: s.id }));
        return this.stack.filter((s) => s.kind === 'spell' && (s.card.isInstant || s.card.isSorcery) && (!e.yours || s.controller === p.seat)).map((s) => ({ kind: 'stack', id: s.id }));
      case 'stun':
        return this.opponents(p).flatMap((o) => o.battlefield).filter((q) => !q.card.isLand && (!e.tapped || (q.tapped && q.card.isCreature)) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'tap':
        // Only untapped permanents of opponents: tapping our own or a tapped one does nothing for us.
        return this.opponents(p).flatMap((o) => o.battlefield).filter((q) => q !== src && !q.tapped && this.canTarget(p, q)
          && (e.target === 'creature' ? q.card.isCreature && !(e.noFlying && this.hasKw(q, 'flying')) : e.target === 'nonland' ? !q.card.isLand : q.card.isCreature || q.card.isArtifact || q.card.isLand)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'bounty':
        // Bounty Board may mark any creature; the bot marks opponents' creatures.
        return this.opponents(p).flatMap((o) => o.battlefield).filter((q) => q.card.isCreature && !q.bounty && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'kwCounter':
        if (e.on === 'self') return null;
        return p.battlefield.filter((q) => q.card.isCreature && !q.kwCounters?.includes(e.kw) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'poison':
        return e.who === 'target' ? this.opponents(p).map((o) => ({ kind: 'player', seat: o.seat })) : null;
      case 'monarch':
        return e.opponent ? this.opponents(p).map((o) => ({ kind: 'player', seat: o.seat })) : null;
      case 'fog':
        if (e.who !== 'creature') return null;
        return this.attackers().filter((q) => q.seat !== p.seat && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'lore':
        return p.battlefield.filter((q) => q.card.saga && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'hatch':
        return p.battlefield.filter((q) => isIncubator(q.card) && this.canTarget(p, q)).sort((a, b) => b.counters - a.counters).map((q) => ({ kind: 'perm', id: q.id }));
      case 'sacrificeHalf':
        return this.opponents(p).filter((o) => o.battlefield.some((q) => !q.emblem)).map((o) => ({ kind: 'player', seat: o.seat }));
      case 'blight':
        return this.allPerms().filter((q) => q.landInfo && !this.blighted.has(q.id) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'becomeCreature':
      case 'becomeArtifact':
      case 'becomeTreasure':
      case 'blank':
      case 'slime':
        return this.lockTargets(p, e, src);
      case 'animate':
        return p.battlefield.filter((q) => q.card.isEnchantment && !q.card.isCreature && !q.unlocked && !isAura(q.card) && !q.card.curse && !/\bAura\b/.test(q.card.typeLine) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'exilePlay':
        return e.from === 'target' ? this.opponents(p).filter((o) => (e.zone === 'hand' ? o.hand : e.zone === 'graveyard' ? o.graveyard : o.library).length > 0).map((o) => ({ kind: 'player', seat: o.seat })) : null;
      case 'freeCast':
        return e.who === 'target' ? this.opponents(p).filter((o) => (e.from === 'hand' ? o.hand : e.from === 'graveyard' ? o.graveyard : o.library).length > 0).map((o) => ({ kind: 'player', seat: o.seat })) : null;
      case 'steal':
        if (e.all) return null;
        if (e.from === 'hand') return this.opponents(p).filter((o) => o.hand.length > 0).map((o) => ({ kind: 'player', seat: o.seat }));
        if (e.from === 'library' && e.what === 'artifact') return this.opponents(p).filter((o) => o.library.some((c) => c.isArtifact)).map((o) => ({ kind: 'player', seat: o.seat }));
        if (e.what === 'noncreatureArtifact') return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isArtifact && !q.card.isCreature && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        if (e.what === 'permanent') return this.allPerms().filter((q) => q.seat !== p.seat && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        if (e.maxCmc !== undefined && e.maxCmc >= 0 && e.what !== 'artifact') return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && q.card.cmc <= e.maxCmc! && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        if (e.payEnergy !== undefined && e.from === 'battlefield') return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && q.card.cmc <= p.energy + e.payEnergy! && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        if (e.from === 'library') return this.opponents(p).filter((o) => o.library.some((c) => c.isCreature)).map((o) => ({ kind: 'player', seat: o.seat }));
        // Garland: "a creature that player controls", the new monarch.
        if (e.when === 'opponentMonarch') return this.allPerms().filter((q) => q.seat === this.monarch && q.seat !== p.seat && q.card.isCreature && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        if (e.what === 'artifact') return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isArtifact && (e.maxCmc === undefined || e.maxCmc < 0 || q.card.cmc <= e.maxCmc) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'tokenCopy':
        if (e.of !== 'target' || !e.filter) return null;
        return this.allPerms().filter((q) => this.copyMatches(p, q, e.filter!, src) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'becomeCopy':
        if (e.of !== 'target' || !e.filter) return null;
        return this.allPerms().filter((q) => this.copyMatches(p, q, e.filter!, src) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'copySelf':
        return e.give === 'target' ? this.opponents(p).map((o) => ({ kind: 'player', seat: o.seat })) : null;
      case 'redirect':
        // A spell (or ability) with a target that something else could be; to the source only if the source is a legal new target.
        return this.stack.filter((s) => {
          if (s.kind === 'spell' ? e.spells === 'instantSorcery' && !s.card.isInstant && !s.card.isSorcery : !e.abilities) return false;
          const i = s.targets.findIndex((t) => t !== null);
          // Not another redirect (its own candidates would be this list again).
          if (i === -1 || s.effects[i].kind === 'redirect') return false;
          const legal = this.targetCandidates(this.players[s.controller], s.effects[i], this.findPerm(s.sourceId)) ?? [];
          return e.to === 'self' ? !!src && s.controller !== p.seat && legal.some((t) => t.kind === 'perm' && t.id === src.id) && !(s.targets[i]!.kind === 'perm' && (s.targets[i] as { id: number }).id === src.id) : legal.length > 1;
        }).map((s) => ({ kind: 'stack', id: s.id }));
      default:
        return null;
    }
  }

  /** Could this blink effect exile and return `perm`? Tokens and Auras would not come back, so they aren't offered. */
  private blinkable(p: PlayerState, perm: Perm, e: Extract<Effect, { kind: 'blink' }>): boolean {
    if (perm.seat !== p.seat || perm.token || perm.landInfo || isAura(perm.card) || !this.canTarget(p, perm)) return false;
    return e.what === 'permanent' || perm.card.isCreature;
  }

  private auraCandidates(p: PlayerState): Target[] {
    const out: Target[] = [];
    for (const perm of this.allPerms()) if (perm.card.isCreature && this.canTarget(p, perm)) out.push({ kind: 'perm', id: perm.id });
    return out;
  }

  private targetStillLegal(p: PlayerState, e: Effect | null, t: Target): boolean {
    if (t.kind === 'player') return this.players[t.seat].alive;
    if (t.kind === 'stack') return this.stack.some((s) => s.id === t.id);
    const perm = this.findPerm(t.id);
    if (!perm || !this.canTarget(p, perm)) return false;
    if (e?.kind === 'removal' && e.mode !== 'edict' && !this.removable(e.target, perm) && !this.damageWalker(e, perm)) return false;
    return true;
  }

  /** A noncreature planeswalker or battle this damage may target: "any target" (rule 115.4), or "creature or planeswalker". */
  private damageWalker(e: Extract<Effect, { kind: 'removal' }>, perm: Perm): boolean {
    if (e.mode !== 'damage' || perm.card.isCreature || perm.emblem) return false;
    if (perm.card.isBattle) return !!e.anyTarget;
    return perm.card.isPlaneswalker && perm.loyalty !== undefined && !!(e.anyTarget || e.orPlaneswalker);
  }

  describeTarget(t: Target): string {
    if (t.kind === 'player') return this.players[t.seat].name;
    if (t.kind === 'stack') return this.stack.find((s) => s.id === t.id)?.label ?? 'a spell';
    const perm = this.findPerm(t.id);
    return perm ? `${perm.card.name} (${this.players[perm.seat].name})` : 'a permanent';
  }

  // -------------------------------------------------------------------------
  // Casting spells (rule 601) and activating abilities (rule 602)
  // -------------------------------------------------------------------------

  /** Returns false if the cast was taken back before anything was paid. */
  /** The cheapest untapped creatures that can crew this Vehicle (rule 702.122), or null. */
  crewFor(p: PlayerState, vehicle: Perm): Perm[] | null {
    const need = vehicle.card.crew;
    if (!need || vehicle.uncrewed || vehicle.card.isCreature || p.battlefield.indexOf(vehicle) === -1) return null;
    const pool = p.battlefield.filter((q) => q.card.isCreature && !q.tapped && q !== vehicle).sort((a, b) => this.power(a) - this.power(b));
    // Prefer one creature that is just big enough; otherwise the smallest ones together.
    const single = pool.find((q) => this.power(q) >= need);
    const group: Perm[] = [];
    let sum = 0;
    for (const q of pool) {
      if (sum >= need) break;
      group.push(q);
      sum += this.power(q);
    }
    if (sum < need) return null;
    const groupPower = sum;
    return single && this.power(single) <= groupPower ? [single] : group;
  }

  private altCards = new Map<string, WeakMap<SimCard, SimCard>>();
  /** A copy of a card that isn't legendary (Spark Double), so the legend rule leaves both. */
  private nonlegendary(card: SimCard): SimCard {
    let cache = this.altCards.get('nonlegendary');
    if (!cache) this.altCards.set('nonlegendary', (cache = new WeakMap()));
    let alt = cache.get(card);
    if (!alt) cache.set(card, (alt = { ...card, isLegendary: false }));
    return alt;
  }
  private kickCache = new WeakMap<SimCard, Map<number, SimCard>>();
  /**
   * The card with its kicker (or offspring) cost paid `kicks` times (rule 702.33): the extra cost added to its
   * cost, and what it does when kicked. Multikicker effects marked `perKick` happen once for each kick.
   */
  kickedCard(card: SimCard, kicks: number): SimCard {
    const k = card.kicker;
    if (!k || kicks <= 0) return card;
    let byCard = this.kickCache.get(card);
    if (!byCard) this.kickCache.set(card, (byCard = new Map()));
    let out = byCard.get(kicks);
    if (!out) {
      // Cleave: its cost is paid instead of the mana cost (rule 702.148).
      const cost: ManaCost = k.as === 'cleave' ? { ...k.cost } : {
        generic: card.cost.generic + k.cost.generic * kicks,
        pips: [...card.cost.pips, ...Array.from({ length: kicks }, () => k.cost.pips).flat()],
        x: card.cost.x + k.cost.x,
        life: card.cost.life + k.cost.life * kicks,
      };
      const effects = k.effects.flatMap((e) => (e.perKick ? Array.from({ length: kicks }, () => e) : [e]));
      byCard.set(kicks, (out = { ...card, cost, effects }));
    }
    return out;
  }

  /** The card as it is cast: priced at its flashback or mutate cost, or with its overload cost and effects. */
  /** `seat`: who casts it, for cards cast from exile or the top of a library (their permission sets the price). */
  castCard(card: SimCard, from: CastFrom | 'crewed' | 'mutate' | 'faceDown' | 'free' | 'impending' | 'door', seat?: number): SimCard {
    if (from === 'hand' || from === 'command') return card;
    if (from === 'exile' || from === 'library') {
      const p = this.players[seat ?? this.activeSeat];
      const via = this.viaFor(p, card, from);
      return via ? this.pricedAs(card, via.mode) : card;
    }
    let cache = this.altCards.get(from);
    if (!cache) this.altCards.set(from, (cache = new WeakMap()));
    let alt = cache.get(card);
    if (!alt) {
      alt = from === 'door'
        // A Room cast as its other door: that door, with the shown door locked (rule 709.5d).
        ? { ...card.room!.door, room: { door: { ...card, room: undefined } } }
        : from === 'faceDown'
        ? faceDownCard(!!card.morph?.ward)
        : from === 'crewed'
        ? { ...card, isCreature: true }
        : from === 'alt'
        ? { ...card, cost: { ...card.altCost!.mana, life: card.altCost!.mana.life + (card.altCost!.life ?? 0) }, effects: card.altCost!.effects ?? card.effects }
        : from === 'foretell'
        ? { ...card, cost: card.casting?.foretell?.cost ?? card.cost, effects: card.casting?.foretell?.effects ?? card.effects }
        : from === 'plot' || from === 'free'
        ? { ...card, cost: NO_COST }
        : from === 'madness' || from === 'miracle'
        ? { ...card, cost: card.casting?.[from] ?? card.cost }
        : from === 'warp'
        ? card
        : from === 'impending'
        ? { ...card, isCreature: false }
        : from === 'mutate'
        ? { ...card, cost: card.mutate?.cost ?? card.cost }
        : from === 'graveyard'
        ? { ...card, cost: card.flashback ?? (card.graveyard?.how === 'cast' ? card.graveyard.cost : card.cost), castZone: 'graveyard' as const }
        : { ...card, cost: card.overload?.cost ?? card.cost, effects: card.overload?.effects ?? card.effects };
      cache.set(card, alt);
    }
    return alt;
  }

  /**
   * Cast a spell (rule 601). `from` 'free' casts a card already taken from wherever it was without paying its
   * mana cost (suspend, hideaway), or a copy of it with `copy` (cipher).
   */
  private *cast(p: PlayerState, card: SimCard, fromCommand: boolean, x: number, from: CastFrom | 'free' = 'hand', mutate = false, kicks = 0, via?: CastVia, modes = 0, copy = false, door = false): Flow<boolean> {
    if (from === 'exile' || from === 'library') {
      const v = this.viaFor(p, card, from);
      if (!v) return false;
      via = v;
    }
    if (via && (kicks || mutate || fromCommand)) return false;
    if (via?.mode === 'free') x = 0;
    if (kicks && (!card.kicker || (from !== 'hand' && from !== 'command') || mutate || (!card.kicker.multi && kicks > 1))) return false;
    if (door && (!card.room || from !== 'hand' || mutate || kicks)) return false;
    if (kicks && !this.optionalCostPayable(p, card)) return false;
    if (modes && !card.casting?.spree) return false;
    const flashback = from === 'graveyard' && !mutate;
    // Foretold, plotted and warped cards are cast from exile; madness and miracle while their window is open.
    const held = from === 'foretell' || from === 'plot' || from === 'warp' ? this.heldEntry(p, card, from) : undefined;
    const window = from === 'madness' || from === 'miracle' ? p.windows?.find((w) => w.card === card && w.how === from) : undefined;
    const zone: SimCard[] | null = via ? via.zone : from === 'free' || held ? null : fromCommand ? p.commandZone : from === 'graveyard' ? p.graveyard : from === 'madness' ? p.exile : p.hand;
    const physical = via?.front ?? card;
    if ((zone && !zone.includes(physical)) || (flashback && !this.graveyardCastable(p, card)) || (from === 'overload' && !card.overload)) return false;
    if ((from === 'foretell' || from === 'plot' || from === 'warp') && !held) return false;
    if ((from === 'madness' || from === 'miracle') && !window) return false;
    if (mutate && (!card.mutate || (from === 'graveyard' && !card.mutate.fromGraveyard))) return false;
    if (from === 'alt' && !(card.altCost && this.altCostAllowed(p, card))) return false;
    /** How it is cast from the graveyard: flashback, the card's own keyword (escape, retrace, disturb), or a permission (Muldrotha). */
    const graveyardWay = !flashback ? null : card.flashback ? 'flashback' : card.graveyard?.how === 'cast' ? card.graveyard.label : 'permission';
    let finality = false;
    let escaped = false;
    // Emerge: the sacrificed creature (or artifact) is chosen first, since it sets the price (rule 702.119).
    let emergeFodder: Perm | null = null;
    if (from === 'alt' && card.altCost?.emerge) {
      const fodder = this.emergeFodder(p, card).filter((q) => this.canAfford(p, this.emergeCard(card, q.card.cmc), false, x));
      if (!fodder.length) return false;
      const pick = fodder.length === 1 ? [0] : yield* this.choose(p, 'sacrifice', `Sacrifice which permanent to emerge ${card.name}?`, fodder.map((q) => ({ label: `${q.card.name} (mana value ${q.card.cmc})`, card: q.card, permId: q.id })), 1, 1);
      emergeFodder = fodder[pick[0] ?? 0];
    }
    const priced = via ? this.pricedAs(card, via.mode) : modes ? this.spreeCard(card, modes) : kicks ? this.kickedCard(card, kicks) : emergeFodder ? this.emergeCard(card, emergeFodder.card.cmc) : this.castCard(card, door ? 'door' : mutate ? 'mutate' : from);
    const permanent = !card.isInstant && !card.isSorcery;
    const effects = permanent ? [] : priced.effects.filter((e) => e.when === 'resolve');

    // Choose targets (601.2c), then pay (601.2h). Ward is charged as part of the cost.
    let ward = 0;
    const targets: (Target | null)[] = [];
    const affordable = (t: Target) => this.canAfford(p, priced, fromCommand, x, ward + this.wardCost(p, t)) && this.wardPayable(p, [attachTo, ...targets, t], card);
    let attachTo: Target | null = null;
    // Curses enchant a player (rule 303.4). Only opponents are offered: a Curse on yourself is never what you want.
    if (permanent && card.curse) {
      const candidates: Target[] = this.opponents(p).map((o) => ({ kind: 'player', seat: o.seat }));
      if (!candidates.length) return false;
      attachTo = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `Curse which player with ${card.name}?`, card, effect: null, candidates, cancellable: true });
      if (!attachTo || !candidates.some((c) => sameTarget(c, attachTo!))) return false;
    }
    if (permanent && isAura(card)) {
      const candidates = this.aimAs(card, p.seat, false, () => this.auraCandidates(p)).filter(affordable);
      if (!candidates.length) return false;
      attachTo = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `Enchant which creature with ${card.name}?`, card, effect: null, candidates, cancellable: true });
      if (!attachTo || !candidates.some((c) => sameTarget(c, attachTo!))) return false;
      ward += this.wardCost(p, attachTo);
    }
    // Mutate: the spell targets a non-Human creature its caster owns (rule 702.140a).
    let mutateOnto: number | undefined;
    if (mutate) {
      const candidates = this.mutateTargets(p).filter(affordable);
      if (!candidates.length) return false;
      const t = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `Mutate ${card.name} onto which creature?`, card, effect: null, candidates, cancellable: true });
      if (!t || t.kind !== 'perm' || !candidates.some((c) => sameTarget(c, t))) return false;
      mutateOnto = t.id;
    }
    for (const e of effects) {
      const all = this.aimAs(card, p.seat, false, () => this.targetCandidates(p, e, null));
      if (all === null) {
        targets.push(null);
        continue;
      }
      // Comet Storm: each extra target for multikicker is a different one ("another target").
      const candidates = all.filter(affordable).filter((c) => !(card.kicker?.multi && targets.some((u) => u && sameTarget(u, c))));
      if (!candidates.length) return false;
      const t = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(card, e), card, effect: e, candidates, cancellable: true });
      if (!t || !candidates.some((c) => sameTarget(c, t))) return false;
      ward += this.wardCost(p, t);
      targets.push(t);
    }

    const plan = this.spellPlan(p, priced, fromCommand, x, ward);
    if (!plan) return false;
    // Bargain, casualty, gift, flashback by sacrifice, emerge, flash by tapping flyers (classifyCasting.ts).
    const extras = yield* this.payCastingCosts(p, card, from, kicks, emergeFodder);
    if (extras === null) return false;
    if (card.extraCost) {
      // Additional costs are paid as the spell is cast (rule 601.2h): sacrifice if possible, else discard.
      const c = card.extraCost;
      const fodder = c.sacrifice ? this.sacrificeChoices(p, c.sacrifice) : [];
      if (c.sacrifice && fodder.length && !(c.either && !fodder.some((q) => q.token || q.card.value < 2) && p.hand.length > 1)) {
        const pick = fodder.length === 1 ? [0] : yield* this.choose(p, 'sacrifice', `Sacrifice which permanent to cast ${card.name}?`, fodder.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
        const gone = fodder[pick[0] ?? 0];
        this.say(`${p.name} sacrifices ${gone.card.name} to cast ${card.name}.`);
        this.removePerm(gone, 'graveyard');
        this.sacrificed(p, gone);
      } else if (c.discard) {
        const options = p.hand.filter((h) => h !== card);
        const picks = yield* this.choose(p, 'discard', `Discard ${c.discard} card${c.discard > 1 ? 's' : ''} to cast ${card.name}.`, options.map((h) => ({ label: h.name, card: h })), c.discard, c.discard);
        for (const h of picks.map((i) => options[i])) {
          p.hand.splice(p.hand.indexOf(h), 1);
          this.discarded(p, h);
        }
      }
    }
    if (graveyardWay && graveyardWay !== 'flashback' && graveyardWay !== 'permission') {
      const use = card.graveyard!;
      // Escape: exile other cards from your graveyard. Retrace: discard a land card.
      if (use.exileOthers) {
        escaped = true;
        const others = p.graveyard.filter((c) => c !== card);
        const picks = yield* this.choose(p, 'exileCard', `Exile ${use.exileOthers} other cards from your graveyard to escape ${card.name}.`, others.map((c) => ({ label: c.name, card: c })), use.exileOthers, use.exileOthers);
        const gone = picks.map((i) => others[i]);
        for (const c of gone) p.graveyard.splice(p.graveyard.indexOf(c), 1);
        p.exile.push(...gone);
      }
      if (use.discardLand) {
        const lands = p.hand.filter((c) => c.isLand);
        const pick = lands.length === 1 ? [0] : yield* this.choose(p, 'discard', `Discard a land card to retrace ${card.name}.`, lands.map((c) => ({ label: c.name, card: c })), 1, 1);
        const land = lands[pick[0] ?? 0];
        if (land) {
          p.hand.splice(p.hand.indexOf(land), 1);
          this.toGraveyard(p, land, false);
        }
      }
    } else if (graveyardWay === 'permission') {
      const permission = this.graveyardPermission(p, card);
      p.life -= permission?.life ?? 0;
      if (permission?.finality) finality = true;
      this.useGraveyardPermission(p, card);
    }
    if (from === 'alt') {
      // Alternative costs that aren't mana: exile a card of the right color, or return Islands (rule 118.9).
      const a = card.altCost!;
      if (a.pitch) {
        const options = p.hand.filter((h) => h !== card && pitchable(h, a.pitch!));
        const pick = options.length === 1 ? [0] : yield* this.choose(p, 'pitch', `Exile which card to cast ${card.name}?`, options.map((h) => ({ label: h.name, card: h })), 1, 1);
        const gone = options[pick[0] ?? 0];
        p.hand.splice(p.hand.indexOf(gone), 1);
        p.exile.push(gone);
        this.say(`${p.name} exiles ${gone.name} from their hand to pay for ${card.name}.`);
      }
      if (a.returnIslands) {
        // Tapped Islands first: they have already given their mana.
        const islands = this.islands(p).sort((u, v) => Number(v.tapped) - Number(u.tapped)).slice(0, a.returnIslands);
        for (const q of islands) this.removePerm(q, 'hand');
        this.say(`${p.name} returns ${islands.map((q) => q.card.name).join(' and ')} to their hand to pay for ${card.name}.`);
      }
    }
    this.commitPayment(p, plan);
    p.life -= priced.cost.life + (card.xFromLife ? x : 0);
    yield* this.payWardOther(p, [attachTo, ...targets], card);
    let manaSpent = 0;
    for (const units of plan.values()) manaSpent += units;

    if (zone && !via?.copy) zone.splice(zone.indexOf(physical), 1);
    if (via?.entry) this.usePermission(p, via.entry);
    if (held) p.held!.splice(p.held!.indexOf(held), 1);
    if (window) p.windows!.splice(p.windows!.indexOf(window), 1);
    if (card.isCreature) p.creatureCastTurn = this.turnNumber;
    if (fromCommand) {
      p.commanderCasts.set(card.name, (p.commanderCasts.get(card.name) ?? 0) + 1);
      if (p.commanderRound === null) p.commanderRound = this.round;
    } else if (!via || via.owner === p) {
      p.castNames.add(card.name);
    }
    p.spellsThisTurn++;
    if (card.isCreature) p.creatureSpellsThisTurn = (p.creatureSpellsThisTurn ?? 0) + 1;
    if (card.isInstant || card.isSorcery) p.instantSorceryThisTurn = (p.instantSorceryThisTurn ?? 0) + 1;
    const item: StackItem = {
      id: this.nextId++, kind: 'spell', controller: p.seat, card, effects, targets, x,
      isCommander: !via?.copy && (via ? via.owner : p).deck.commanders.includes(physical), sourceId: null, attachTo, label: card.name,
    };
    if (via?.front) item.front = via.front;
    if (via) {
      if (via.owner !== p && !via.copy) item.owner = via.owner.seat;
      if (via.copy) item.copy = true;
      if (via.exileAfter) item.exileAfter = true;
    }
    if (graveyardWay === 'flashback' || (graveyardWay !== 'permission' && card.graveyard?.exiled && flashback)) item.flashback = true;
    if (finality) item.finality = true;
    if (escaped) item.escaped = true;
    if (mutateOnto !== undefined) item.mutateOnto = mutateOnto;
    if (from === 'alt' && card.altCost) {
      const a = card.altCost;
      const how = a.evoke ? 'evoke' : a.dash ? 'dash' : a.blitz ? 'blitz' : a.warp ? 'warp' : a.impending ? 'impending' : undefined;
      if (how) item.alt = how;
    }
    if (kicks && card.kicker?.as !== 'replicate' && card.kicker?.as !== 'casualty') item.kicked = kicks;
    if (kicks && card.kicker?.as === 'buyback') item.buyback = true;
    if (extras.gift !== undefined) item.gift = extras.gift;
    if (from === 'free' && card.casting?.suspend) item.suspended = true;
    if (copy) item.copy = true;
    if (door) {
      item.door = priced;
      item.label = priced.name;
    }
    this.stack.push(item);
    const aimed = [attachTo, ...targets].filter((t): t is Target => t !== null);
    const kickText = !kicks ? '' : card.kicker!.offspring ? ' paying offspring' : card.kicker!.multi ? ` kicked ${kicks} time${kicks > 1 ? 's' : ''}` : ' kicked';
    this.say(`${p.name} casts ${copy ? 'a copy of ' : ''}${door ? priced.name : card.name}${kickText}${priced.cost.x ? ` (X=${x})` : ''}${mutate ? ` for its mutate cost onto ${this.findPerm(mutateOnto ?? null)?.card.name ?? 'a creature'}` : ''}${via ? `${via.label}${via.mode === 'free' ? ' without paying its mana cost' : via.mode === 'life' ? ` for ${card.cmc} life` : ''}` : fromCommand ? ' from the command zone' : graveyardWay === 'permission' ? ' from their graveyard' : graveyardWay ? ` with ${graveyardWay}` : from === 'graveyard' ? ' from the graveyard' : from === 'overload' ? ' with overload' : item.alt ? ` with ${item.alt}` : from === 'alt' ? (card.altCost?.prowl ? ' with prowl' : card.altCost?.emerge ? ' with emerge' : ' without paying its mana cost') : CAST_FROM_TEXT[from] ?? ''}${modes ? ` (${spreeLabel(card, modes)})` : ''}${aimed.length ? ` targeting ${aimed.map((t) => this.describeTarget(t)).join(', ')}` : ''}.`);
    // Replicate and casualty: copies of the spell, which may choose new targets (rules 702.56, 702.153).
    const copies = kicks && card.kicker?.as === 'replicate' ? kicks : extras.casualty ? 1 : 0;
    for (let i = 0; i < copies; i++) yield* this.copyItem(p, item);
    // Deep-Sea Kraken: an opponent's spell takes a time counter off it.
    if (this.suspendWatch) for (const o of this.opponents(p)) for (const h of o.held ?? []) if (h.way === 'suspend' && h.card.casting?.suspend?.onOpponentCast && (h.time ?? 0) > 0) this.tickSuspend(o, h);

    // "Becomes the target of a spell" triggers (rule 603.2): the spell is on the stack with its targets chosen.
    for (const t of aimed) this.becameTarget(p, t, true);
    if (mutateOnto !== undefined) this.becameTarget(p, { kind: 'perm', id: mutateOnto }, true);

    // Storm: a copy for each spell cast before this one this turn (rule 702.40).
    if (card.storm) {
      const before = this.players.reduce((sum, q) => sum + q.spellsThisTurn, 0) - 1;
      for (let i = 0; i < Math.min(before, 20); i++) {
        this.stack.push({ ...item, id: this.nextId++, kind: 'ability', isCommander: false, label: `${card.name} (storm copy)` });
      }
      if (before > 0) this.say(`Storm copies ${card.name} ${before} time${before === 1 ? '' : 's'}.`);
    }

    // Cascade (rule 702.85): a trigger for each instance, about this spell (so "costs less" compares with its mana value).
    if (card.cascade && !copy) {
      for (let i = 0; i < card.cascade; i++) this.trigger(p, card, null, [CASCADE], 0, null, item.id);
    }

    // "Their second spell each turn", "your first spell during each opponent's turn".
    const counts = (e: Effect) => (e.nth === undefined || e.nth === p.spellsThisTurn) && (e.turn === undefined || (e.turn === 'own') === (this.activeSeat === p.seat));
    // "Whenever you cast a spell" triggers (they go on the stack above the spell). Veyran doubles them for instants and sorceries.
    const times = card.isInstant || card.isSorcery ? this.triggerTimes(p, 'magecraft') : 1;
    // A spell aimed at a single permanent: cast triggers are about it (Vesuvan Duplimancy, Orvar, Ivy).
    const single = aimed.length === 1 && aimed[0].kind === 'perm' ? this.findPerm(aimed[0].id) : null;
    const about = single ? aboutPerm(single) : undefined;
    const seen = this.spellTypes(p, card);
    for (const perm of p.battlefield) {
      const hits = perm.card.effects.filter((e) => e.when === 'cast' && matchesFilter(seen, e.castFilter ?? 'any') && card.cmc >= (e.minCmc ?? 0) && counts(e));
      if (hits.length) for (let i = 0; i < times; i++) this.trigger(p, perm.card, perm.id, hits, 0, null, item.id, about, p.seat);
    }
    // "Whenever an opponent casts a spell" (Rhystic Study).
    for (const o of this.opponents(p)) {
      for (const perm of o.battlefield) {
        const hits = perm.card.effects.filter((e) => e.when === 'opponentCast' && matchesFilter(seen, e.castFilter ?? 'any') && counts(e));
        if (hits.length) this.trigger(o, perm.card, perm.id, hits, p.spellsThisTurn, null, item.id, about, p.seat);
      }
    }
    // Teach by Example, Jace Reawakened: copy this spell (rule 707.10).
    if (p.copyNext && (p.copyNext === 'turn' || card.isInstant || card.isSorcery)) {
      if (p.copyNext === 'next') p.copyNext = undefined;
      yield* this.copyItem(p, item);
    }
    if (this.anyCurse) this.curseEvent(p, 'casts', card, undefined, item.id);
    // Knowledge Pool: a spell cast from hand is exiled and swapped for one in the pool.
    if (from === 'hand' && !fromCommand && !copy && this.kindsInGame.has('knowledgePool')) yield* this.knowledgePoolSwap(p, item);
    // Vexing Bauble, Lavinia: a spell cast without spending mana is countered.
    if (manaSpent === 0 && this.kindsInGame.has('counterFree')) this.counterFreeSpell(p, item);
    // Fblthp, the Lost: becoming the target of a spell shuffles it away (its trigger resolves first, so the spell may lose its target).
    if (this.kindsInGame.has('shuffleWhenTargeted')) {
      for (const t of aimed) {
        const q = t.kind === 'perm' ? this.findPerm(t.id) : null;
        const hits = q ? q.card.effects.filter((e) => e.kind === 'shuffleWhenTargeted') : [];
        if (q && hits.length) this.trigger(this.players[q.seat], q.card, q.id, hits.map((e) => ({ ...e, when: 'resolve' as const })));
      }
    }
    return true;
  }

  /**
   * A loyalty ability read as several effects ("+1: Draw a card. Each opponent loses 1 life."): the effects next to
   * `e` on the card with the same loyalty cost. Abilities granted by Ichormoon Gauntlet stand alone.
   */
  loyaltyAbility(perm: Perm, e: Effect): Effect[] {
    const all = perm.card.effects;
    const at = all.indexOf(e);
    if (at === -1) return [e];
    const same = (f: Effect) => f.when === 'loyalty' && f.loyalty === e.loyalty && !!f.loyaltyX === !!e.loyaltyX;
    let from = at;
    let to = at;
    while (from > 0 && same(all[from - 1])) from--;
    while (to < all.length - 1 && same(all[to + 1])) to++;
    return all.slice(from, to + 1);
  }

  /** Ichormoon Gauntlet: "[0]: Proliferate" and "[−12]: Take an extra turn after this one" for `p`'s planeswalkers. */
  private grantedLoyalty(p: PlayerState): Effect[] {
    if (!this.kindsInGame.has('pwAbilities') || !p.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'pwAbilities' && e.when === 'static'))) return NONE_EFFECTS;
    return GAUNTLET_ABILITIES;
  }

  private *activate(p: PlayerState, permId: number, e: Effect, x = 0): Flow<boolean> {
    const perm = p.battlefield.find((q) => q.id === permId);
    if (!perm || !this.canActivate(p, perm, e, this.sorcerySpeed(p))) return false;

    if (e.kind === 'equip') {
      const candidates: Target[] = p.battlefield.filter((q) => q.card.isCreature && q.id !== perm.attachedTo && q !== perm).map((q) => ({ kind: 'perm', id: q.id }));
      const t = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `Equip ${perm.card.name} to which creature?`, card: perm.card, effect: e, candidates, cancellable: true });
      if (!t || !candidates.some((c) => sameTarget(c, t))) return false;
      const plan = this.planPayment(p, e.cost ?? DEFAULT_EQUIP, 0, 0, undefined, true);
      if (!plan) return false;
      this.commitPayment(p, plan);
      perm.activations++;
      this.stack.push({ id: this.nextId++, kind: 'ability', controller: p.seat, card: perm.card, effects: [], targets: [], x: 0, isCommander: false, sourceId: perm.id, attachTo: t, label: `Equip ${perm.card.name}` });
      this.say(`${p.name} equips ${perm.card.name} to ${this.describeTarget(t)}.`);
      this.becameTarget(p, t, false);
      return true;
    }

    if (e.when === 'loyalty') {
      // The rest of the same ability: its other sentences were read as effects next to this one.
      const parts = this.loyaltyAbility(perm, e);
      const targets: (Target | null)[] = [];
      for (const part of parts) {
        const options = this.aimAs(perm.card, p.seat, true, () => this.targetCandidates(p, part, perm));
        if (options === null) {
          targets.push(null);
          continue;
        }
        if (!options.length) {
          if (part === e) return false;
          targets.push(null);
          continue;
        }
        const aim = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(perm.card, part), card: perm.card, effect: part, candidates: options, cancellable: part === e });
        if (!aim || !options.some((c) => sameTarget(c, aim))) {
          if (part === e) return false;
          targets.push(options[0]);
          continue;
        }
        targets.push(aim);
      }
      // "-X" (rule 606.4): X is chosen now. Left to the engine, it keeps one loyalty.
      const loyalty = perm.loyalty ?? 0;
      const paidX = e.loyaltyX ? Math.max(1, Math.min(loyalty, x > 0 ? Math.floor(x) : loyalty - 1)) : 0;
      perm.loyalty = loyalty + (e.loyaltyX ? -paidX : e.loyalty ?? 0);
      perm.loyaltyUsed = true;
      const used = e.loyaltyX ? `-${paidX}` : `${(e.loyalty ?? 0) > 0 ? '+' : ''}${e.loyalty}`;
      const aimed = targets.filter((t): t is Target => t !== null);
      this.say(`${p.name} uses ${perm.card.name} (${used}, loyalty ${perm.loyalty})${aimed.length ? ` targeting ${aimed.map((t) => this.describeTarget(t)).join(', ')}` : ''}.`);
      this.stack.push({ id: this.nextId++, kind: 'ability', controller: p.seat, card: perm.card, effects: parts, targets, x: paidX * (e.xTimes ?? 1), isCommander: false, sourceId: perm.id, attachTo: null, label: `${perm.card.name} ability` });
      for (const aim of aimed) this.becameTarget(p, aim, false);
      return true;
    }
    const act = e.activation!;
    const discount = this.abilityDiscount(p, perm, e);
    let target: Target | null = null;
    const all = this.aimAs(perm.card, p.seat, true, () => this.targetCandidates(p, e, perm));
    if (all !== null) {
      const candidates = all.filter((t) => this.planPayment(p, act.cost, this.wardCost(p, t), discount, act.tap ? perm : undefined, true) !== null && this.wardPayable(p, [t]));
      if (!candidates.length) return false;
      target = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(perm.card, e), card: perm.card, effect: e, candidates, cancellable: true });
      if (!target || !candidates.some((c) => sameTarget(c, target!))) return false;
    }
    const plan = this.planPayment(p, act.cost, this.wardCost(p, target), discount, act.tap ? perm : undefined, true);
    if (!plan) return false;
    let fodder: Perm | null = null;
    if (act.sacCreature) {
      const creatures = p.battlefield.filter((q) => q.card.isCreature);
      if (!creatures.length) return false;
      const pick = creatures.length === 1 ? [0] : yield* this.choose(p, 'sacrifice', `Sacrifice which creature to ${perm.card.name}?`, creatures.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
      fodder = creatures[pick[0] ?? 0];
    }
    // "Sacrifice a Food", "sacrifice five artifacts": chosen before paying (rule 601.2h).
    let others: Perm[] = [];
    if (act.sacOther) {
      const options = this.sacOtherChoices(p, act.sacOther.what, act.sacrifice ? perm : undefined);
      if (options.length < act.sacOther.n) return false;
      const picks = options.length === act.sacOther.n ? options.map((_, i) => i) : yield* this.choose(p, 'sacrifice', `Sacrifice ${act.sacOther.n} ${act.sacOther.what === 'food' ? 'Food' : act.sacOther.what}${act.sacOther.n > 1 ? 's' : ''} for ${perm.card.name}.`, options.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), act.sacOther.n, act.sacOther.n);
      others = picks.map((i) => options[i]).filter(Boolean);
      if (others.length < act.sacOther.n) return false;
    }
    this.commitPayment(p, plan);
    p.life -= act.cost.life;
    if (act.tap) perm.tapped = true;
    yield* this.payWardOther(p, [target]);
    // Energy (rule 107.14) and charge counters paid as part of the cost. "Pay X {E}": X is the energy paid,
    // the target's mana value for HELIOS One, everything otherwise.
    let paidX = 0;
    if (act.energy) {
      const aimed = target?.kind === 'perm' ? this.findPerm(target.id) : null;
      paidX = act.energy > 0 ? act.energy : aimed ? aimed.card.cmc : p.energy;
      this.payEnergy(p, paidX);
    }
    if (act.charge) {
      perm.charge = (perm.charge ?? 0) - act.charge;
      this.refreshStation(perm);
    }
    if (act.discard) {
      const picks = yield* this.choose(p, 'discard', `Discard ${act.discard} card${act.discard > 1 ? 's' : ''} for ${perm.card.name}.`, p.hand.map((c) => ({ label: c.name, card: c })), act.discard, act.discard);
      const gone = picks.map((i) => p.hand[i]).filter(Boolean);
      for (const c of gone) {
        p.hand.splice(p.hand.indexOf(c), 1);
        this.discarded(p, c);
      }
      if (gone.length) this.say(`${p.name} discards ${gone.map((c) => c.name).join(', ')}.`);
      if (this.kindsInGame.has('when:opponentDiscard')) for (let i = 0; i < gone.length; i++) this.fireOpponents(p, 'opponentDiscard', 1);
    }
    if (act.shrinkSelf) perm.counters -= act.shrinkSelf;
    if (act.removeCounters) this.removeCountersFrom(p, perm, act.removeCounters.n, act.removeCounters.from);
    if (act.tapCreatures) {
      // Tap the creatures that matter least (summoning sickness doesn't stop this, rule 302.6).
      const crew = p.battlefield.filter((q) => q.card.isCreature && !q.tapped).sort((a, b) => this.power(a) - this.power(b)).slice(0, act.tapCreatures);
      for (const q of crew) q.tapped = true;
    }
    perm.activations++;
    if (act.boast) perm.usedThisTurn.push(e);
    this.say(`${p.name} activates ${perm.card.name}${fodder ? `, sacrificing ${fodder.card.name}` : ''}${target ? ` targeting ${this.describeTarget(target)}` : ''}.`);
    if (fodder) {
      this.removePerm(fodder, 'graveyard');
      this.sacrificed(p, fodder);
    }
    if (others.length) {
      this.say(`${p.name} sacrifices ${others.map((q) => q.card.name).join(', ')}.`);
      this.removePerms(others, 'graveyard');
      for (const q of others) this.sacrificed(p, q);
    }
    if (act.sacrifice) {
      this.removePerm(perm, 'graveyard');
      this.sacrificed(p, perm);
    }
    // "Exile this enchantment": a cost, but not a sacrifice (Enhanced Surveillance).
    if (act.exileSelf) this.removePerm(perm, 'exile');
    // Parts of the same ability that were read as separate effects (a transform after a loot).
    const riders = perm.card.effects.filter((r) => r.kind === 'transform' && r.rider && r !== e && sameActivation(r, e));
    this.stack.push({
      id: this.nextId++, kind: 'ability', controller: p.seat, card: perm.card, effects: [e, ...riders], targets: [target, ...riders.map(() => null)], x: act.energy === -1 ? paidX : 0,
      isCommander: false, sourceId: act.sacrifice || act.exileSelf || fodder === perm ? null : perm.id, attachTo: null, label: `${perm.card.name} ability`,
    });
    this.becameTarget(p, target, false);
    // Harsh Mentor: "whenever an opponent activates an ability ... that isn't a mana ability".
    if (this.kindsInGame.has('when:opponentActivate')) this.fireOpponents(p, 'opponentActivate');
    return true;
  }

  // -------------------------------------------------------------------------
  // Triggered abilities (rule 603)
  // -------------------------------------------------------------------------

  /**
   * Note that an ability triggered. It goes on the stack the next time a player would get priority.
   * `x`: the amount "that much" refers to. `left`: the source, when it has just left the battlefield.
   * `subject`: the spell that set it off, for "copy that spell".
   */
  private trigger(controller: PlayerState, card: SimCard, sourceId: number | null, effects: Effect[], x = 0, left: Perm | null = null, subject?: number, about?: About, aboutSeat?: number) {
    if (!controller.alive || !effects.length) return;
    const src = left ?? this.findPerm(sourceId);
    const kept: Effect[] = [];
    const died = this.diedNow;
    for (const e of effects) {
      if (this.triggerBudget-- <= 0) return;
      // "Return that card": only a creature card that qualifies (Luminous Broodmoth, Necroskitter, Oathkeeper).
      if (e.kind === 'returnDied' && !this.returnDiedFits(e, died)) continue;
      // "If ~ has four or more quest counters on it" (rule 603.4).
      if (e.minCharge && (src?.charge ?? 0) < e.minCharge) continue;
      // "If" conditions the classifier couldn't read hold about half the time.
      if (e.chance !== undefined && !this.rng.chance(e.chance)) continue;
      // Intervening "if" clauses it can read are checked as it triggers, and again as it resolves (rule 603.4).
      if (e.ifCond && !this.condHolds(controller, src, e.ifCond, subject, about)) continue;
      if (e.oncePerTurn && src) {
        if (src.usedThisTurn.includes(e)) continue;
        src.usedThisTurn.push(e);
      }
      kept.push(e);
    }
    if (!kept.length) return;
    // Roaming Throne, Harmonic Prodigy: some of your permanents' abilities trigger an additional time (rule 603.2d).
    const times = src && src.seat === controller.seat && this.kindsInGame.has('triggerDoubler') ? 1 + this.extraTriggers(controller, src, kept) : 1;
    for (let i = 0; i < times; i++) {
      this.pending.push({ controller: controller.seat, card, sourceId, effects: kept, x, ...(subject !== undefined ? { subject } : {}), ...(about ? { about } : {}), ...(aboutSeat !== undefined ? { aboutSeat } : {}), ...(died ? { died } : {}) });
    }
  }

  /** Abilities of `p`'s opponents' permanents that trigger on something that happened to `p` (x = how much). */
  private fireOpponents(p: PlayerState, when: Trigger, x = 0) {
    for (const o of this.opponents(p)) this.fire(o, when, x, p.seat);
  }

  /** An opponent of `p` controls a static effect of this kind ("artifacts your opponents control enter tapped": `artifacts`). */
  private opponentStatic(p: PlayerState, kind: 'oppEnterTapped', artifacts = false): boolean {
    return this.opponents(p).some((o) => o.battlefield.some((q) => q.card.effects.some((e) => e.kind === kind && e.when === 'static' && (!artifacts || e.artifacts))));
  }

  private flushDepth = 0;

  /**
   * `t` just became the target of a spell (`spell`) or ability controlled by `by` (rule 603.2):
   * "whenever ~ becomes the target" abilities (Fblthp, Goldspan Dragon, valiant, Nadu, Battle Mammoth) trigger,
   * and Phantasmal Image and Jace's Illusions are sacrificed.
   */
  private becameTarget(by: PlayerState, t: Target | null, spell: boolean) {
    this.crime(by, t);
    if (!t || t.kind !== 'perm') return;
    const perm = this.findPerm(t.id);
    if (!perm) return;
    const holder = this.players[perm.seat];
    if (perm.fragile && (spell || perm.fragile === 'any')) this.trigger(holder, perm.card, perm.id, [SACRIFICE_SELF]);
    // Shay Cormac: an opponent's creature targeted by your spell or ability gets a bounty counter.
    if (this.kindsInGame.has('bountyOnTarget') && holder !== by && perm.card.isCreature && !perm.bounty && this.statics(by, 'bountyOnTarget') > 0) {
      perm.bounty = true;
      this.say(`${perm.card.name} gets a bounty counter.`);
    }
    if (!this.kindsInGame.has('when:targeted')) return;
    const mine = by.seat === holder.seat;
    for (const src of holder.battlefield) {
      const hits = src.card.effects.filter((e) => {
        if (e.when !== 'targeted' || (e.spellOnly && !spell)) return false;
        if (e.targetedBy && (e.targetedBy === 'you') !== mine) return false;
        if (e.scope === 'self') return src === perm;
        if (e.castFilter === 'creature' && !perm.card.isCreature) return false;
        // Nadu: "this ability triggers only twice each turn", for each creature.
        if (e.perTurn) {
          if (perm.usedThisTurn.filter((u) => u === e).length >= e.perTurn) return false;
          perm.usedThisTurn.push(e);
        }
        return true;
      });
      if (hits.length) this.trigger(holder, src.card, src.id, hits);
    }
  }

  /** Abilities of `p`'s permanents that trigger on a simple event. */
  /**
   * "At the beginning of [your/each/each opponent's] upkeep, draw step, precombat main phase, combat, end step" abilities,
   * on `active`'s turn (rules 503.1, 504.2, 505.4, 507.1, 513.1). "That player" is the active player.
   */
  private fireStep(active: PlayerState, step: 'upkeep' | 'draw' | 'main1' | 'combat' | 'end') {
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) {
        const hits = perm.card.effects.filter((e) => e.when === 'upkeep' && (e.at ?? 'upkeep') === step
          && (q === active ? e.whose !== 'opponents' : e.whose === 'each' || e.whose === 'opponents'));
        if (hits.length) this.trigger(q, perm.card, perm.id, hits, 0, null, undefined, undefined, q === active ? undefined : active.seat);
      }
    }
  }

  private fire(p: PlayerState, when: Trigger, x = 0, aboutSeat?: number) {
    for (const perm of p.battlefield) {
      const hits = perm.card.effects.filter((e) => e.when === when);
      if (hits.length) this.trigger(p, perm.card, perm.id, hits, x, null, undefined, undefined, aboutSeat);
    }
  }

  /**
   * Panharmonicon, Isshin, Drivnod, Veyran: how many times an ability of `p`'s
   * permanents triggers for this event (1 + one for each matching doubler `p` controls).
   */
  private triggerTimes(p: PlayerState, event: 'enters' | 'permanentEnters' | 'attack' | 'dies' | 'magecraft', entering?: SimCard): number {
    // Hushbringer, Elesh Norn: these events don't make abilities trigger at all.
    if (this.kindsInGame.has('triggerLock') && event !== 'attack' && event !== 'magecraft' && this.triggersStopped(p, event, entering)) return 0;
    if (!this.kindsInGame.has('etbDoubler')) return 1;
    let n = 1;
    for (const perm of p.battlefield) for (const e of perm.card.effects) {
      if (e.kind !== 'etbDoubler' || e.when !== 'static') continue;
      const ev = e.event ?? 'enters';
      if (ev === event) n++;
      // "An artifact or creature entering" is a narrower "permanent entering".
      else if (event === 'permanentEnters' && ev === 'enters' && entering && (entering.isArtifact || entering.isCreature)) n++;
    }
    return n;
  }

  /** "Whenever a creature enters under your control" (Panharmonicon makes these trigger twice, tokens included). */
  private creatureEntered(p: PlayerState, entering: Perm) {
    if (this.anyCurse) this.curseEvent(p, 'creatureEnters');
    // Authority of the Consuls: an opponent's creature enters tapped, and its "whenever a creature an opponent controls enters".
    if (this.kindsInGame.has('oppEnterTapped') && this.opponentStatic(p, 'oppEnterTapped')) entering.tapped = true;
    if (this.kindsInGame.has('when:opponentCreatureEnters')) this.fireOpponents(p, 'opponentCreatureEnters');
    if (!this.kindsInGame.has('when:creatureEnters')) return;
    const times = this.triggerTimes(p, 'permanentEnters', entering.card);
    for (const perm of p.battlefield) {
      if (perm === entering) continue;
      const hits = perm.card.effects.filter((e) => e.when === 'creatureEnters' && !(e.nontoken && entering.token) && (!e.ofType || this.isType(entering, e.ofType, perm)));
      if (!hits.length) continue;
      // Mana Echoes: "that share a creature type with it" is counted as the creature enters.
      const shared = hits.some((e) => e.kind === 'treasure' && e.shareType) ? this.sharingType(p, entering) : 0;
      for (let i = 0; i < times; i++) this.trigger(p, perm.card, perm.id, hits, shared, null, undefined, aboutPerm(entering));
    }
  }

  /** Put waiting triggers on the stack in turn order from the active player (rule 603.3b). */
  private *flushTriggers(): Flow<void> {
    if (!this.pending.length) return;
    const n = this.players.length;
    const order = (seat: number) => (seat - this.activeSeat + n) % n;
    const waiting = this.pending.sort((a, b) => order(a.controller) - order(b.controller));
    this.pending = [];
    for (const t of waiting) {
      const p = this.players[t.controller];
      if (!p.alive) continue;
      const src = this.findPerm(t.sourceId);
      const effects: Effect[] = [];
      const targets: (Target | null)[] = [];
      for (const e of t.effects) {
        // "That player": the player the trigger is about, not a choice (Sheoldred, Quietus Spike).
        if (e.thatPlayer) {
          if (t.aboutSeat === undefined || !this.players[t.aboutSeat].alive) continue;
          effects.push(e);
          targets.push({ kind: 'player', seat: t.aboutSeat });
          continue;
        }
        const all = this.aimAs(t.card, p.seat, true, () => this.targetCandidates(p, e, src));
        if (all === null) {
          effects.push(e);
          targets.push(null);
          continue;
        }
        let candidates = all.filter((c) => (this.wardCost(p, c) === 0 || this.planPayment(p, NO_COST, this.wardCost(p, c), 0) !== null) && this.wardPayable(p, [c]));
        // "Counter that spell": only the spell that set it off.
        if (e.kind === 'counter' && e.subject) candidates = candidates.filter((c) => c.kind === 'stack' && c.id === t.subject);
        // No legal target: that part of the ability is removed (rule 603.3d).
        if (!candidates.length) continue;
        // Blink triggers say "you may" or "up to one": the controller may choose no target.
        const optional = e.kind === 'blink' || e.kind === 'ozolith';
        const pick = candidates.length === 1 && !optional
          ? candidates[0]
          : yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(t.card, e), card: t.card, effect: e, candidates, cancellable: optional });
        if (optional && !pick) continue;
        const chosen = pick && candidates.some((c) => sameTarget(c, pick)) ? pick : candidates[0];
        if (this.wardCost(p, chosen)) {
          const plan = this.planPayment(p, NO_COST, this.wardCost(p, chosen), 0);
          if (plan) this.commitPayment(p, plan);
        }
        yield* this.payWardOther(p, [chosen]);
        effects.push(e);
        targets.push(chosen);
      }
      if (!effects.length) continue;
      this.stack.push({ id: this.nextId++, kind: 'ability', controller: p.seat, card: t.card, effects, targets, x: t.x, isCommander: false, sourceId: t.sourceId, attachTo: null, label: `${t.card.name} trigger`, ...(t.subject !== undefined ? { subject: t.subject } : {}), ...(t.about ? { about: t.about } : {}), ...(t.aboutSeat !== undefined ? { aboutSeat: t.aboutSeat } : {}), ...(t.died ? { died: t.died } : {}) });
      targets.forEach((aim, i) => { if (!effects[i].thatPlayer) this.becameTarget(p, aim, false); });
    }
    // Abilities that triggered on those targets go on the stack too (rule 603.3b).
    if (this.pending.length && this.flushDepth < 5) {
      this.flushDepth++;
      yield* this.flushTriggers();
      this.flushDepth--;
    }
  }

  // -------------------------------------------------------------------------
  // Resolving spells and abilities (rule 608)
  // -------------------------------------------------------------------------

  private *resolveTop(): Flow<void> {
    const item = this.stack.pop();
    if (!item) return;
    const p = this.players[item.controller];
    if (!p.alive) return;

    // A spell or ability whose targets are all illegal doesn't resolve (rule 608.2b).
    const legal = this.aimAs(item.card, p.seat, item.kind === 'ability', () => item.targets.map((t, i) => (t ? this.targetStillLegal(p, item.effects[i], t) : true)));
    const attachLegal = item.attachTo ? this.aimAs(item.card, p.seat, item.kind === 'ability', () => this.targetStillLegal(p, null, item.attachTo!)) : true;
    const targeted = item.targets.some((t) => t !== null) || item.attachTo !== null;
    const anyLegal = item.targets.some((t, i) => t !== null && legal[i]) || (item.attachTo !== null && attachLegal);
    if (targeted && !anyLegal) {
      this.say(`${item.label} has no legal target and doesn't resolve.`);
      if (item.kind === 'spell') this.leaveStack(p, item);
      return;
    }

    if (item.kind === 'spell' && item.faceDown) {
      this.putFaceDown(p, p, item.faceDown, item.card);
      return;
    }
    if (item.kind === 'spell' && item.mutateOnto !== undefined) {
      const host = this.findPerm(item.mutateOnto);
      if (host && this.canMutateOnto(p, host)) {
        yield* this.merge(p, host, item.card, item.isCommander, !!item.copy);
        return;
      }
      // With its target gone, a mutating creature spell just enters as a creature (rule 702.140b).
      this.say(`${item.card.name} has nothing to mutate onto and enters as a creature.`);
    }
    if (item.kind === 'spell' && item.front && !item.copy) {
      // A spell cast transformed enters with its back face up (rule 712.11).
      yield* this.enterTransformed(p, item.front, false, item.isCommander);
      const perm = p.battlefield.find((q) => q.front === item.front);
      if (perm && item.owner !== undefined) perm.owner = item.owner;
      return;
    }
    if (item.kind === 'spell' && !item.card.isInstant && !item.card.isSorcery) {
      // A copy of a permanent spell becomes a token (rule 707.10f).
      const perm = yield* this.enter(p, item.door ?? item.card, item.isCommander, item.x, item.attachTo, item.owner !== undefined ? this.players[item.owner] : undefined, item.copy ? 'token' : item.alt, item.kicked);
      if (perm && item.finality) this.finality.add(perm.id);
      if (perm && item.escaped) this.escapedPerms.add(perm.id);
      // A Room cast as its other door is still the whole card underneath (it goes to the graveyard as one).
      if (perm && item.door) perm.printed = item.card;
      // The door that was cast is unlocked as the Room enters, so "when you unlock this door" triggers (rule 709.5h).
      if (perm && perm.card.room) {
        const own = perm.card.effects.filter((e) => e.when === 'unlock');
        if (own.length) this.trigger(p, perm.card, perm.id, own);
      }
      // Suspend: a creature cast as its last time counter came off has haste (rule 702.62a).
      if (perm && item.suspended && perm.card.isCreature) perm.tempKw.push('haste');
      return;
    }

    const src = this.findPerm(item.sourceId);
    if (item.kind === 'ability' && item.attachTo && src) {
      const host = this.findPerm(item.attachTo.kind === 'perm' ? item.attachTo.id : null);
      if (host && host.seat === src.seat) {
        src.attachedTo = host.id;
        this.anyAttached = true;
      }
    }
    // Gift (rule 702.174): the promised gift comes first.
    if (item.gift !== undefined) this.giveGift(item.card, item.gift);
    this.resolving = item;
    this.aimedSeat = null;
    this.lastAffected = null;
    this.resolvingCard = item.card;
    for (let i = 0; i < item.effects.length; i++) {
      // "Its controller" in a later sentence means whoever controlled what this part hit (Reality Shift).
      const aim = item.targets[i];
      if (aim) this.aimedSeat = aim.kind === 'player' ? aim.seat : aim.kind === 'perm' ? this.findPerm(aim.id)?.seat ?? this.aimedSeat : this.stack.find((s) => s.id === aim.id)?.controller ?? this.aimedSeat;
      if (!legal[i] || !p.alive) continue;
      if (item.effects[i].ifCond && !this.condHolds(p, src, item.effects[i].ifCond!, item.subject, item.about)) continue;
      if (item.effects[i].unlessPays !== undefined && (yield* this.paysTax(p, item, i, src))) continue;
      yield* this.resolveEffect(p, item.effects[i], src, item.x, item.targets[i], item.card);
    }
    this.resolving = null;
    if (item.kind === 'spell') {
      // A copy of a spell ceases to exist instead of going anywhere (rule 707.10a).
      // A spell cast from someone else's library or graveyard goes back to its owner's (rule 400.3).
      const owner = this.players[item.owner ?? p.seat];
      if (this.tuckSpell && !item.copy) owner.library.splice(Math.min(6, owner.library.length), 0, item.card);
      else if (this.shuffleSpell && !item.copy) {
        owner.library.push(item.card);
        this.rng.shuffle(owner.library);
        this.say(`${item.card.name} is shuffled into ${owner.name}'s library.`);
      }
      else if (!(yield* this.spellAfterResolving(p, item))) this.leaveStack(p, item);
      this.tuckSpell = false;
      this.shuffleSpell = false;
    }
  }

  /**
   * "Unless that player pays {N}" (Rhystic Study, Mystic Remora, Esper Sentinel, Smothering Tithe): the player the trigger
   * is about chooses as it resolves whether to pay (rules 118.12, 608.2d). True if they paid, so the effect doesn't happen.
   */
  private *paysTax(p: PlayerState, item: StackItem, i: number, src: Perm | null): Flow<boolean> {
    const e = item.effects[i];
    const seat = item.aboutSeat;
    if (seat === undefined || seat === p.seat || !this.players[seat].alive) return false;
    const payer = this.players[seat];
    // Esper Sentinel: X is its power, as the ability resolves (or as it last existed).
    const n = e.unlessPays === -1 ? (src ? Math.max(0, this.power(src)) : item.card.power) : e.unlessPays!;
    if (n <= 0) {
      this.say(`${payer.name} pays {0} for ${item.card.name}.`);
      return true;
    }
    const plan = this.planPayment(payer, NO_COST, n, 0);
    if (!plan) return false;
    const pay = yield* ask<boolean>({ kind: 'confirm', seat, reason: 'payTax', prompt: `${item.card.name} (${p.name}): pay {${n}}? If you don't, ${this.taxConsequence(e)}.`, card: item.card });
    if (!pay) {
      this.say(`${payer.name} doesn't pay {${n}} for ${item.card.name}.`);
      return false;
    }
    const again = this.planPayment(payer, NO_COST, n, 0);
    if (!again) return false;
    this.commitPayment(payer, again);
    this.say(`${payer.name} pays {${n}} for ${item.card.name}.`);
    return true;
  }

  /** What happens if a tax isn't paid, for the prompt. */
  private taxConsequence(e: Effect): string {
    switch (e.kind) {
      case 'draw': return `its controller draws ${e.n === 1 ? 'a card' : `${e.n} cards`}`;
      case 'treasure': return `its controller creates ${e.n === 1 ? 'a Treasure' : `${e.n} Treasures`}`;
      case 'counter': return 'your spell is countered';
      default: return 'its ability happens';
    }
  }

  /** Does an intervening "if" condition hold for `p` now (rule 603.4)? `subject`: the spell that set it off; `about`: what it is about. */
  private condHolds(p: PlayerState, src: Perm | null, c: Cond, subject?: number, about?: About): boolean {
    const top = p.library[0];
    const spell = subject !== undefined ? this.stack.find((s) => s.id === subject) : undefined;
    switch (c.k) {
      case 'youControl': {
        const n = p.battlefield.filter((q) => !q.emblem && controlMatches(q, c.what)).length;
        return n >= c.min && (c.max === undefined || n <= c.max);
      }
      case 'oppMoreLands': return this.opponents(p).some((o) => this.landCount(o) > this.landCount(p));
      case 'oppMonarch': return this.monarch !== null && this.monarch !== p.seat;
      case 'youMonarch': return this.monarch === p.seat;
      case 'notOwned': return p.battlefield.filter((q) => q.owner !== undefined && q.owner !== p.seat && !q.token).length >= c.min;
      case 'landsTotal': return this.alivePlayers().reduce((n, q) => n + this.landCount(q), 0) >= c.min;
      case 'oppLostLife': return this.opponents(p).some((o) => o.lostLifeTurn === this.turnNumber);
      case 'youAttacked': return p.attackedTurn === this.turnNumber;
      case 'selfAttacked': return !!src && src.attackedTurn === this.turnNumber;
      case 'drewMore': return p.drawsThisTurn >= c.min;
      case 'fullParty': return this.partySize(p) >= 4;
      case 'selfUntapped': return !!src && !src.tapped;
      case 'creatureDied': return this.diedThisTurn > 0;
      case 'uniqueName': {
        const name = about?.card.name;
        if (!name) return true;
        return !p.battlefield.some((q) => q.card.isCreature && q.id !== about?.permId && q.card.name === name) && !p.graveyard.some((g) => g.isCreature && g.name === name);
      }
      case 'counters': return p.battlefield.filter((q) => q.card.isCreature || q.card.isArtifact).reduce((n, q) => n + this.counterCount(q), 0) >= c.min;
      case 'discarded': return (c.opponent ? this.opponents(p) : this.alivePlayers()).some((q) => q.discardedTurn === this.turnNumber);
      case 'topChosen': return !!top && top.isCreature && !!src?.chosenType && hasSubtype(top, src.chosenType);
      case 'chosenSpell': return !!spell && !!src?.chosenType && hasSubtype(spell.card, src.chosenType);
      case 'topSameMv': return !!top && !!spell && top.cmc === spell.card.cmc;
    }
  }

  /** Where a spell goes after it resolves or is countered: exile if it was cast with flashback (rule 702.34). */
  private leaveStack(p: PlayerState, item: StackItem) {
    if (item.copy) return;
    // A card cast from someone else's library or exile goes to its owner's graveyard (rule 400.3).
    const owner = item.owner !== undefined ? this.players[item.owner] : p;
    if (item.flashback || item.exileAfter) owner.exile.push(item.front ?? item.card);
    else this.toGraveyard(owner, item.front ?? item.faceDown ?? item.card, item.isCommander);
  }

  private toGraveyard(p: PlayerState, card: SimCard, isCommander: boolean) {
    // Nexus of Fate: shuffled into its owner's library instead.
    if (!isCommander && this.shufflesInstead(card)) {
      p.library.splice(this.rng.int(p.library.length + 1), 0, card);
      this.say(`${card.name} is shuffled into ${p.name}'s library instead.`);
      return;
    }
    // Rest in Peace: exiled instead.
    const to = this.exiledInstead(p) ? 'exile' : 'graveyard';
    p[to].push(card);
    if (isCommander) this.pendingCommander.push({ seat: p.seat, card, to });
  }

  /** Rest in Peace (anyone's cards), Dauthi Voidwalker (its controller's opponents' cards): cards `owner` owns are exiled instead of going to their graveyard. */
  private exiledInstead(owner: PlayerState): boolean {
    if (!this.kindsInGame.has('graveyardHate')) return false;
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) for (const e of perm.card.effects) if (e.kind === 'graveyardHate' && e.when === 'static' && (!e.opponents || q !== owner)) return true;
    }
    return false;
  }

  /** `p` takes control of a permanent. Its owner gets it back when it leaves the battlefield. */
  private takeControl(perm: Perm, p: PlayerState) {
    const from = this.players[perm.seat];
    const idx = from.battlefield.indexOf(perm);
    if (idx === -1 || from === p || perm.emblem) return;
    from.battlefield.splice(idx, 1);
    perm.owner ??= from.seat;
    perm.seat = p.seat;
    perm.heldBy = undefined;
    perm.heldWhileMonarch = undefined;
    perm.borrowed = undefined;
    perm.neverAttacks = perm.neverAttacks === p.seat ? undefined : perm.neverAttacks;
    if (perm.owner === p.seat) perm.owner = undefined;
    perm.sick = true;
    perm.attacking = null;
    perm.attackingPw = undefined;
    perm.blocking = null;
    perm.blocked = false;
    p.battlefield.push(perm);
    this.say(`${p.name} takes control of ${perm.card.name}.`);
  }

  // -------------------------------------------------------------------------
  // Mutate (rules 702.140 and 721)
  // -------------------------------------------------------------------------

  /** May a mutating creature spell of `p`'s merge with this permanent? A non-Human creature they own and control. */
  canMutateOnto(p: PlayerState, perm: Perm): boolean {
    return perm.seat === p.seat && perm.owner === undefined && perm.card.isCreature && !perm.uncrewed
      && !/\bHuman\b/.test(perm.card.typeLine) && p.battlefield.includes(perm) && this.canTarget(p, perm);
  }

  /** Creatures `p` could mutate onto. */
  mutateTargets(p: PlayerState): Target[] {
    return p.battlefield.filter((q) => this.canMutateOnto(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
  }

  /**
   * A mutating creature spell resolves: it joins the permanent on top or underneath. The permanent
   * stays the same object, with its counters, damage and summoning sickness (rule 721.2), and has
   * the top card's characteristics plus the abilities of every card in it. It doesn't enter the
   * battlefield, so only "whenever this creature mutates" abilities trigger.
   */
  private *merge(p: PlayerState, host: Perm, card: SimCard, isCommander: boolean, copy = false): Flow<void> {
    const parts = host.parts ?? [{ real: host.token ? null : realCard(host), face: host.card, commander: host.isCommander }];
    host.faceDown = undefined;
    host.front = undefined;
    const current = parts[0].face;
    const pick = yield* this.choose(p, 'mutate', `Put ${card.name} on top of ${current.name} (its body and name), or underneath (only its abilities)?`, [
      { label: `On top: ${card.name} ${card.power}/${card.toughness}`, card },
      { label: `Underneath: stay ${current.name} ${current.power}/${current.toughness}`, card: current },
    ], 1, 1);
    // A copy of a mutating spell merges as a token part: no card of its own goes anywhere later (rule 707.10f).
    const part = { real: copy ? null : card, face: card, commander: isCommander && !copy };
    const onTop = (pick[0] ?? 0) === 0;
    host.parts = onTop ? [part, ...parts] : [...parts, part];
    host.printed = undefined;
    host.card = mergedCard(host.parts.map((x) => x.face));
    host.token = host.parts[0].real === null;
    host.isCommander = host.parts.some((x) => x.commander);
    for (const e of card.effects) {
      this.kindsInGame.add(e.kind);
      this.kindsInGame.add(`when:${e.when}`);
    }
    this.say(`${card.name} mutates ${onTop ? 'onto' : 'under'} ${current.name} (now ${host.card.name}, ${host.parts.length} cards).`);
    const own = host.card.effects.filter((e) => e.when === 'mutates' && e.scope !== 'any');
    if (own.length) this.trigger(p, host.card, host.id, own);
    // "Whenever a creature you control mutates" (Essence Symbiote): "that creature" is the merged one.
    for (const other of p.battlefield) {
      const hits = other.card.effects.filter((e) => e.when === 'mutates' && e.scope === 'any');
      if (hits.length) this.trigger(p, other.card, host.id, hits);
    }
  }

  // -------------------------------------------------------------------------
  // Face-down permanents: morph, disguise, manifest (rules 708, 702.37, 701.40)
  // -------------------------------------------------------------------------

  /** What turning this permanent face up costs: its morph cost, or its mana cost if it is a manifested creature card. Null if it can't be. */
  faceUpCost(perm: Perm): ManaCost | null {
    const real = perm.faceDown;
    if (!real || perm.parts) return null;
    if (real.morph) return real.morph.cost;
    return real.isCreature ? real.cost : null;
  }

  /** Cast a morph or disguise card face down for {3}. A special way to cast it, so it uses the stack as a creature spell. */
  private castFaceDown(p: PlayerState, card: SimCard): boolean {
    const idx = p.hand.indexOf(card);
    const priced = this.castCard(card, 'faceDown');
    const plan = idx === -1 || !card.morph ? null : this.spellPlan(p, priced, false, 0, 0);
    if (!plan) return false;
    this.commitPayment(p, plan);
    p.hand.splice(idx, 1);
    p.castNames.add(card.name);
    p.spellsThisTurn++;
    this.stack.push({ id: this.nextId++, kind: 'spell', controller: p.seat, card: priced, faceDown: card, effects: [], targets: [], x: 0, isCommander: false, sourceId: null, attachTo: null, label: 'a face-down creature' });
    this.say(`${p.name} casts a face-down creature.`);
    for (const perm of p.battlefield) {
      const hits = perm.card.effects.filter((e) => e.when === 'cast' && matchesFilter(priced, e.castFilter ?? 'any') && priced.cmc >= (e.minCmc ?? 0));
      if (hits.length) this.trigger(p, perm.card, perm.id, hits, 0, null, undefined, undefined, p.seat);
    }
    for (const o of this.opponents(p)) {
      for (const perm of o.battlefield) {
        const hits = perm.card.effects.filter((e) => e.when === 'opponentCast' && matchesFilter(priced, e.castFilter ?? 'any'));
        if (hits.length) this.trigger(o, perm.card, perm.id, hits, p.spellsThisTurn, null, undefined, undefined, p.seat);
      }
    }
    return true;
  }

  /** Put `real` onto the battlefield face down under `p`'s control; `owner` owns it. It is a creature entering, but none of its own abilities exist. */
  private putFaceDown(p: PlayerState, owner: PlayerState, real: SimCard, face: SimCard = faceDownCard(false)): Perm {
    const perm = this.makePerm(p, face, false);
    perm.faceDown = real;
    if (owner !== p) perm.owner = owner.seat;
    p.battlefield.push(perm);
    this.creatureEntered(p, perm);
    return perm;
  }

  /** Manifest the top card of `from`'s library under `p`'s control; with dread, the better of the top two. */
  private *manifest(p: PlayerState, from: PlayerState, dread: boolean): Flow<void> {
    if (!from.library.length || !p.alive) return;
    let card = from.library.shift()!;
    if (dread && from.library.length) {
      const other = from.library.shift()!;
      const options = [card, other];
      const pick = yield* this.choose(p, 'manifest', 'Manifest dread: which card goes onto the battlefield face down? The other goes to the graveyard.', options.map((c) => ({ label: c.name, card: c })), 1, 1);
      card = options[pick[0] ?? 0];
      this.toGraveyard(from, options[1 - (pick[0] ?? 0)], false);
    }
    this.putFaceDown(p, from, card);
    this.say(`${p.name} manifests ${from === p ? 'the top card of their library' : `the top card of ${from.name}'s library`}${dread ? ' (dread)' : ''}.`);
  }

  /** Turn a face-down permanent face up: it becomes its real card, keeping counters, damage and combat status (rule 708.8). */
  private turnFaceUp(p: PlayerState, perm: Perm) {
    const real = perm.faceDown;
    if (!real) return;
    perm.faceDown = undefined;
    perm.card = real;
    for (const e of real.effects) {
      this.kindsInGame.add(e.kind);
      this.kindsInGame.add(`when:${e.when}`);
    }
    if (real.morph?.counter) perm.counters++;
    if (real.loyalty !== undefined) perm.loyalty = real.loyalty;
    this.say(`${p.name} turns a face-down creature face up: it is ${real.name}.`);
    const up = real.effects.filter((e) => e.when === 'turnedFaceUp');
    if (up.length) this.trigger(p, real, perm.id, up);
  }

  // -------------------------------------------------------------------------
  // Transforming double-faced cards (rules 701.28, 712)
  // -------------------------------------------------------------------------

  /** Does a transform's condition hold for `p`? ("If you control four or more Wizards", "seven or more cards in your graveyard".) */
  private transformAllowed(p: PlayerState, e: Extract<Effect, { kind: 'transform' }>): boolean {
    const c = e.cond;
    if (!c) return true;
    if (c.count === 'graveyard') return p.graveyard.length >= c.n;
    // Tokens made by this engine carry no creature types, so they count toward any type.
    const re = c.subtype ? new RegExp(`\\b${c.subtype}\\b`, 'i') : null;
    return p.battlefield.filter((q) => q.card.isCreature && (!re || re.test(q.card.typeLine) || q.token)).length >= c.n;
  }

  private *transform(p: PlayerState, e: Extract<Effect, { kind: 'transform' }>, src: Perm | null): Flow<void> {
    if (!this.transformAllowed(p, e)) return;
    if (e.fromGraveyard) {
      // "When this dies, return it to the battlefield transformed": only if it is still in its owner's graveyard.
      const front = this.resolvingCard;
      const owner = front?.back ? this.players.find((q) => q.alive && q.graveyard.includes(front)) : undefined;
      if (!front || !owner) return;
      owner.graveyard.splice(owner.graveyard.indexOf(front), 1);
      this.say(`${front.name} returns to the battlefield transformed into ${front.back!.name}.`);
      yield* this.enterTransformed(owner, front, !!e.tapped, false);
      return;
    }
    if (!src || !this.players[src.seat].battlefield.includes(src) || src.parts || src.faceDown) return;
    const front = src.front ?? src.card;
    if (!front.back) return;
    if (e.reenter) {
      // Exiled and returned: a new object with no memory of the old one (rule 400.7), under its owner's control.
      const controller = this.players[src.seat];
      controller.battlefield.splice(controller.battlefield.indexOf(src), 1);
      const owner = this.players[src.owner ?? src.seat];
      const toBack = !src.front;
      // A token (a copy of the Saga, say) that is exiled ceases to exist and can't come back (rules 111.7, 704.5d).
      if (src.token) {
        this.say(`${src.card.name} is exiled (a token can't return).`);
        return;
      }
      this.say(`${src.card.name} is exiled and returns ${toBack ? `transformed into ${front.back.name}` : `as ${front.name}`}.`);
      if (toBack) yield* this.enterTransformed(owner, front, false, src.isCommander);
      else yield* this.enter(owner, front, src.isCommander, 0, null);
      return;
    }
    // Transforming in place keeps everything else about the permanent (rule 712.10).
    const next = src.front ? src.front : front.back;
    src.front = src.front ? undefined : front;
    src.card = next;
    src.landInfo = next.isLand ? next.land : undefined;
    if (next.loyalty !== undefined) src.loyalty = next.loyalty;
    for (const f of next.effects) {
      this.kindsInGame.add(f.kind);
      this.kindsInGame.add(`when:${f.when}`);
    }
    this.say(`${front.name} transforms into ${next.name}.`);
  }

  /** Put the back face of `front` onto the battlefield (it enters, so its enters abilities trigger). */
  private *enterTransformed(p: PlayerState, front: SimCard, tapped: boolean, isCommander: boolean): Flow<void> {
    const back = front.back!;
    if (back.isLand && back.land) {
      this.putLand(p, back, back.land, tapped);
      const perm = p.battlefield[p.battlefield.length - 1];
      perm.front = front;
      perm.isCommander = isCommander;
      return;
    }
    yield* this.enter(p, back, isCommander, 0, null);
    const perm = p.battlefield.find((q) => q.card === back && !q.front);
    if (perm) {
      perm.front = front;
      if (tapped) perm.tapped = true;
    }
  }

  /**
   * Vadrok: cast a card from your graveyard without paying its mana cost. Instants and sorceries go on the stack
   * with their targets (and then to the graveyard); permanents are cast and resolve as usual.
   */
  private *castFreeFromGraveyard(p: PlayerState, e: Extract<Effect, { kind: 'freeFromGraveyard' }>): Flow<void> {
    const options = [...new Set(p.graveyard.filter((c) => !c.isLand && c.cmc <= e.maxCmc && !(e.noncreature && c.isCreature) && c.modeled))];
    if (!options.length) return;
    const pick = yield* this.choose(p, 'recursion', 'Cast a card from your graveyard without paying its mana cost.', options.map((c) => ({ label: c.name, card: c })), 0, 1);
    const card = options[pick[0] ?? -1];
    if (!card || !p.graveyard.includes(card)) return;
    const permanent = !card.isInstant && !card.isSorcery;
    const effects = permanent ? [] : card.effects.filter((f) => f.when === 'resolve');
    const targets: (Target | null)[] = [];
    for (const f of effects) {
      const all = this.targetCandidates(p, f, null);
      if (all === null) {
        targets.push(null);
        continue;
      }
      if (!all.length) return;
      const t = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(card, f), card, effect: f, candidates: all, cancellable: false });
      targets.push(t && all.some((c) => sameTarget(c, t)) ? t : all[0]);
    }
    p.graveyard.splice(p.graveyard.indexOf(card), 1);
    p.spellsThisTurn++;
    p.castNames.add(card.name);
    this.stack.push({ id: this.nextId++, kind: 'spell', controller: p.seat, card, effects, targets, x: 0, isCommander: false, sourceId: null, attachTo: null, label: card.name });
    this.say(`${p.name} casts ${card.name} from their graveyard without paying its mana cost.`);
    for (const t of targets) this.becameTarget(p, t, true);
  }

  /** Inquisitive Glimmer: "unlock costs you pay cost {1} less". */
  private unlockDiscount(p: PlayerState): number {
    if (!this.kindsInGame.has('unlockDiscount')) return 0;
    let n = 0;
    for (const perm of p.battlefield) for (const e of perm.card.effects) if (e.kind === 'unlockDiscount' && e.when === 'static') n += e.n;
    return n;
  }

  private roomCards = new WeakMap<SimCard, SimCard>();
  /** Unlock a Room's locked door (rule 709.5e): the permanent now has both doors' abilities. */
  private unlockDoor(p: PlayerState, perm: Perm) {
    const shown = perm.card;
    const door = shown.room?.door;
    if (!door) return;
    let both = this.roomCards.get(shown);
    if (!both) {
      both = { ...shown, name: shown.name.includes(door.name) ? shown.name : `${shown.name} // ${door.name}`, effects: [...shown.effects, ...door.effects], room: undefined, value: shown.value + door.value, notes: [...shown.notes, ...door.notes] };
      this.roomCards.set(shown, both);
    }
    perm.printed ??= shown;
    perm.card = both;
    for (const e of door.effects) {
      this.kindsInGame.add(e.kind);
      this.kindsInGame.add(`when:${e.when}`);
    }
    this.say(`${p.name} unlocks ${door.name}.`);
    const own = door.effects.filter((e) => e.when === 'unlock');
    if (own.length) this.trigger(p, perm.card, perm.id, own);
    // Entity Tracker: "whenever you fully unlock a Room" (rule 709.5i).
    if (this.kindsInGame.has('when:fullyUnlock')) this.fire(p, 'fullyUnlock');
  }

  /**
   * Food, Blood and Incubator tokens (rule 111.10). They are real artifacts, so they can be sacrificed and
   * their "whenever an artifact enters" abilities trigger. An Incubator gets `size` +1/+1 counters (rule 701.53a).
   */
  private makeArtifactTokens(p: PlayerState, token: 'food' | 'blood' | 'incubator', n: number, size: number): number {
    const card = token === 'food' ? foodCard() : token === 'blood' ? bloodCard() : incubatorCard();
    const count = Math.min(Math.max(n, 0) * 2 ** this.doublers(p, 'tokens'), 40);
    for (let i = 0; i < count; i++) {
      const perm = this.makePerm(p, card, true);
      perm.sick = true;
      if (token === 'incubator') perm.counters = size * 2 ** this.doublers(p, 'counters');
      p.battlefield.push(perm);
      this.artifactEntered(p, perm);
    }
    if (count > 0) this.say(`${p.name} makes ${count > 1 ? `${count} ` : 'a '}${card.name}${token === 'incubator' ? ` token with ${size} +1/+1 counter${size === 1 ? '' : 's'}` : ' token'}${count > 1 ? 's' : ''}.`);
    return count;
  }

  /** "Whenever an artifact (or enchantment) enters under your control" for a permanent that entered without being cast. */
  private artifactEntered(p: PlayerState, perm: Perm) {
    if (!this.kindsInGame.has('when:permEnters')) return;
    const times = this.triggerTimes(p, 'permanentEnters', perm.card);
    for (const other of p.battlefield) {
      if (other === perm) continue;
      const hits = other.card.effects.filter((e) => e.when === 'permEnters' && matchesFilter(perm.card, e.castFilter ?? 'any'));
      if (hits.length) for (let i = 0; i < times; i++) this.trigger(p, other.card, other.id, hits);
    }
  }

  /** Permanents of `p` that can pay a "sacrifice N Foods / artifacts" cost, least useful first. */
  sacOtherChoices(p: PlayerState, what: 'food' | 'artifact' | 'permanent', exclude?: Perm): Perm[] {
    return p.battlefield
      .filter((q) => q !== exclude && !q.emblem && (what === 'food' ? isFood(q.card) : what === 'permanent' || q.card.isArtifact))
      .sort((a, b) => Number(!a.token) - Number(!b.token) || Number(a.card.isCreature) - Number(b.card.isCreature) || a.card.value - b.card.value);
  }

  private makePerm(p: PlayerState, card: SimCard, token: boolean): Perm {
    for (const e of [...card.effects, ...(card.levels ?? []).flatMap((l) => l.effects)]) {
      this.kindsInGame.add(e.kind);
      this.kindsInGame.add(`when:${e.when}`);
      if (e.kind === 'pump' && e.grant?.some(isProtection)) this.kindsInGame.add('protection');
      if (e.kind === 'mana' && e.sacArtifact) this.kindsInGame.add('mana:sacArtifact');
    }
    if (card.keywords.some(isProtection)) this.kindsInGame.add('protection');
    return {
      id: this.nextId++, card, seat: p.seat, tapped: false, sick: true, token, isCommander: false,
      counters: 0, damage: 0, deathtouched: false, tempP: 0, tempT: 0, tempKw: [],
      attachedTo: null, activations: 0, usedThisTurn: [], attacking: null, blocked: false, blocking: null,
      ...(card.loyalty !== undefined ? { loyalty: card.loyalty } : {}),
      ...(card.stun ? { stun: card.stun } : {}),
      // "As ~ enters, choose a creature type": the type most of its controller's creatures share.
      ...(card.choosesType ? { chosenType: this.favoriteType(p) } : {}),
    };
  }

  /** The creature type most common among `p`'s creature cards, for "choose a creature type". */
  favoriteType(p: PlayerState): string {
    const count = new Map<string, number>();
    const seen = [...p.battlefield.map((q) => q.card), ...p.hand, ...p.library, ...p.graveyard, ...p.deck.commanders];
    for (const c of seen) {
      if (!c.isCreature) continue;
      for (const t of subtypesOf(c)) count.set(t, (count.get(t) ?? 0) + 1);
    }
    let best = 'human';
    let most = 0;
    for (const [t, k] of count) if (k > most) [best, most] = [t, k];
    return best;
  }

  /** Is `perm` a creature of this type? 'chosen' means `src`'s chosen type. Changeling, Maskwood Nexus and Leyline of Transformation count (rule 205.3). */
  isType(perm: Perm, type: string, src?: Perm | null): boolean {
    const want = type === 'chosen' ? src?.chosenType : type;
    if (!want) return false;
    // Outlaws are a group of types (rule 700.15).
    if (want === 'outlaw') return ['assassin', 'mercenary', 'pirate', 'rogue', 'warlock'].some((t) => this.isType(perm, t));
    if (hasSubtype(perm.card, want)) return true;
    if (perm.card.isCreature && this.kindsInGame.has('creatureTypes')) {
      for (const q of this.players[perm.seat].battlefield) for (const e of q.card.effects) if (e.kind === 'creatureTypes' && (e.every || q.chosenType === want)) return true;
    }
    return false;
  }

  /** Put a permanent card onto the battlefield and note its enters triggers. */
  private *enter(p: PlayerState, card: SimCard, isCommander: boolean, x: number, attachTo: Target | null, owner?: PlayerState, how?: 'token' | 'evoke' | 'dash' | 'blitz' | 'warp' | 'impending', kicks = 0): Flow<Perm | null> {
    const perm = this.makePerm(p, kicks ? this.kickedCard(card, kicks) : card, how === 'token');
    perm.card = card;
    if (kicks) perm.kicked = kicks;
    perm.isCommander = isCommander;
    if (owner && owner !== p) perm.owner = owner.seat;
    // Clone: enters as a copy of a creature on the battlefield (rule 707).
    const clone = card.effects.find((e) => e.kind === 'clone');
    if (clone?.kind === 'clone') {
      if (clone.fragile) perm.fragile = 'any';
      // Spark Double copies only your own creatures, Imposter Mech only an opponent's.
      // Copy Enchantment, Copy Artifact: an enchantment or an artifact instead.
      const fits = (q: Perm) => (clone.what === 'enchantment' ? q.card.isEnchantment && !isAura(q.card) && !q.card.curse : clone.what === 'artifact' ? q.card.isArtifact && !q.landInfo : q.card.isCreature);
      const creatures = this.allPerms().filter((q) => fits(q) && (clone.from === undefined || (clone.from === 'yours') === (q.seat === p.seat)));
      if (creatures.length) {
        const pick = creatures.length === 1 ? [0] : yield* this.choose(p, 'clone', `${card.name} enters as a copy of which ${clone.what ?? 'creature'}?`, creatures.map((q) => ({ label: `${q.card.name} (${this.players[q.seat].name})`, card: q.card, permId: q.id })), 1, 1);
        const original = creatures[pick[0] ?? 0];
        perm.printed = card;
        card = clone.nonlegendary && original.card.isLegendary ? this.nonlegendary(original.card) : original.card;
        perm.card = card;
        this.say(`${perm.printed.name} enters as a copy of ${card.name}.`);
      }
    }
    if (card.curse) {
      const seat = attachTo?.kind === 'player' ? attachTo.seat : null;
      // A Curse with no player to enchant goes to the graveyard instead (rule 608.3b).
      if (seat === null || !this.players[seat].alive) {
        // A token one simply ceases to exist (rule 111.7).
        if (how !== 'token') this.toGraveyard(owner ?? p, card, isCommander);
        return null;
      }
      perm.cursing = seat;
      this.anyCurse = true;
    }
    if (isAura(card)) {
      const host = attachTo && attachTo.kind === 'perm' ? this.findPerm(attachTo.id) : null;
      // An Aura with nothing legal to enchant goes to the graveyard instead (rule 608.3b).
      if (!host || !this.canTarget(p, host)) {
        // A token one simply ceases to exist (rule 111.7).
        if (how !== 'token') this.toGraveyard(owner ?? p, card, isCommander);
        return null;
      }
      perm.attachedTo = host.id;
      this.anyAttached = true;
      // Control Magic: you control the enchanted creature, until the Aura leaves.
      if (host.seat !== p.seat && card.effects.some((e) => e.kind === 'equip' && e.steal)) {
        this.takeControl(host, p);
        this.hold(host, perm);
      }
      const lock = card.effects.find((e) => e.kind === 'equip' && e.lock);
      if (lock?.kind === 'equip') this.lockDown(host, perm, lock);
    }
    // Doubling Season: counters a permanent enters with are doubled too (rule 122.6, 614.1c).
    // Solemnity: nothing it would enter with (planeswalkers aside).
    const doubled = this.countersBlocked(perm) ? 0 : 2 ** this.doublers(p, 'counters');
    if (card.entersWithX) perm.counters = x * doubled;
    if (card.charge !== undefined) perm.charge = (card.charge === -1 ? x : card.charge) * doubled;
    // Everflowing Chalice: a charge counter for each time it was kicked.
    if (kicks && card.kicker?.charge) perm.charge = kicks * doubled;
    if (card.sunburst) {
      // One counter for each color of mana spent (rule 702.44a): the colors the caster can make, up to the mana value.
      const colors = [...this.colorsAvailable(p)].filter((c) => c !== 'C').length;
      const n = Math.min(Math.max(colors, card.cost.pips.length > 0 ? 1 : 0), Math.max(card.cmc, 1)) * doubled;
      if (card.isCreature) perm.counters += n;
      else perm.charge = (perm.charge ?? 0) + n;
    }
    if (card.loyalty !== undefined) perm.loyalty = card.loyalty * doubled;
    // Battles enter with defense counters (rule 310.4b). As a Siege enters, its controller chooses an opponent to protect it (310.11a).
    if (card.isBattle) {
      perm.defense = (card.defense ?? 0) * doubled;
      const opps = this.opponents(p);
      if (opps.length) {
        const pick = opps.length === 1 ? [0] : yield* this.choose(p, 'protector', `${card.name}: choose an opponent to protect it.`, opps.map((o) => ({ label: o.name })), 1, 1);
        perm.protector = opps[pick[0] ?? 0].seat;
        this.say(`${this.players[perm.protector].name} protects ${card.name} (defense ${perm.defense}).`);
      }
    }
    if (perm.charge) this.refreshStation(perm);
    if (perm.printed && clone?.kind === 'clone' && clone.extraCounter && card.isCreature) perm.counters += doubled;
    if (card.isCreature && this.kindsInGame.has('enterCounters')) {
      const hurt = this.opponents(p).filter((o) => o.lostLifeTurn === this.turnNumber).length;
      for (const q of p.battlefield) for (const e of q.card.effects) {
        if (e.kind !== 'enterCounters') continue;
        // Metallic Mimic: one extra counter on each other creature of the chosen type.
        if (e.chosen) perm.counters += this.isType(perm, 'chosen', q) ? e.n : 0;
        else perm.counters += e.n * hurt;
      }
    }
    if (card.entersTapped || (clone?.kind === 'clone' && clone.tapped)) perm.tapped = true;
    // Blind Obedience: an opponent's artifacts enter tapped too (creatures are tapped as they enter, tokens included).
    if (card.isArtifact && !card.isCreature && this.kindsInGame.has('oppEnterTapped') && this.opponentStatic(p, 'oppEnterTapped', true)) perm.tapped = true;
    // Impending: time counters, and not a creature until the last is gone (rule 702.176a).
    if (how === 'impending' && card.altCost?.impending) {
      perm.impending = card.altCost.impending * doubled;
      perm.impendingCard = card;
      perm.card = this.castCard(card, 'impending');
    }
    // Roaming Throne: "as this enters, choose a creature type".
    if (card.effects.some((e) => e.kind === 'triggerDoubler' && e.chosenType)) {
      perm.chosenType = this.chooseCreatureType(p);
      if (perm.chosenType) this.say(`${p.name} chooses ${perm.chosenType} for ${card.name}.`);
    }
    p.battlefield.push(perm);
    // Hideaway: look at the top cards and exile one face down (rule 702.75a).
    if (card.casting?.hideaway) yield* this.hideaway(p, perm, card.casting.hideaway);
    // Brainstealer Dragon: a nonland permanent an opponent owns enters under your control.
    if (owner && owner !== p && !card.isLand && card.cmc > 0 && this.statics(p, 'stolenDrain') > 0) {
      for (let i = this.statics(p, 'stolenDrain'); i > 0; i--) {
        const lost = this.loseLife(owner, card.cmc, p, 'noncombat');
        if (lost) this.say(`${owner.name} loses ${lost} life (${card.name} entered under ${p.name}'s control).`);
      }
    }
    // Xantcha: enters under the control of an opponent of its owner's choice.
    if (card.effects.some((e) => e.kind === 'givenAway')) yield* this.giveAway(p, perm);
    if (card.name === 'Isochron Scepter') this.imprint(p, perm);
    // Kicked (or offspring paid): its "if it was kicked" enters abilities too. Kicker {X} sets the X they refer to.
    const etb = (kicks && !perm.printed ? this.kickedCard(card, kicks) : card).effects.filter((e) => e.when === 'resolve')
      .map((e) => (e.kind === 'steal' && e.maxCmc === -1 ? { ...e, maxCmc: x } : e));
    if (etb.length) for (let i = this.triggerTimes(p, 'permanentEnters', card); i > 0; i--) this.trigger(p, card, perm.id, etb, x);
    // Aboleth Spawn: a creature entering under an opponent's control sets off its enters abilities for you too (a copy you control).
    if (etb.length && card.isCreature && this.kindsInGame.has('copyOpponentEtb')) {
      for (const o of this.opponents(p)) for (const q of o.battlefield) {
        if (!q.card.effects.some((e) => e.kind === 'copyOpponentEtb' && e.when === 'static')) continue;
        this.say(`${q.card.name} copies ${card.name}'s enters ability for ${o.name}.`);
        this.trigger(o, card, q.id, etb.filter((e) => e.kind !== 'clone' && e.kind !== 'counters'));
      }
    }
    if (card.isCreature) this.creatureEntered(p, perm);
    // A Saga enters with a lore counter, which sets off chapter I (rule 714.3a).
    if (card.saga) this.addLore(p, perm);
    if (how === 'dash') {
      perm.dashed = true;
      perm.tempKw.push('haste');
    }
    if (how === 'blitz') {
      perm.blitzed = true;
      perm.tempKw.push('haste');
    }
    if (how === 'warp') perm.warped = true;
    // Evoke: sacrificed as it enters; its enters abilities still happen (rule 702.74a).
    if (how === 'evoke') {
      this.say(`${card.name} is sacrificed (evoke).`);
      this.removePerm(perm, 'graveyard');
      this.sacrificed(p, perm);
    }
    if ((card.isArtifact || card.isEnchantment) && this.kindsInGame.has('when:permEnters')) {
      const times = this.triggerTimes(p, 'permanentEnters', card);
      for (const other of p.battlefield) {
        if (other === perm) continue;
        const hits = other.card.effects.filter((e) => e.when === 'permEnters' && matchesFilter(card, e.castFilter ?? 'any'));
        if (hits.length) for (let i = 0; i < times; i++) this.trigger(p, other.card, other.id, hits, 0, null, undefined, aboutPerm(perm));
      }
    }
    return perm;
  }

  /**
   * Isochron Scepter's imprint: exile an instant with mana value 2 or less from
   * hand. Dramatic Reversal (the combo) is taken first, otherwise the best one.
   */
  private imprint(p: PlayerState, perm: Perm) {
    const options = p.hand.filter((c) => c.isInstant && c.cmc <= 2);
    if (!options.length) return;
    const pick = options.find((c) => c.name === 'Dramatic Reversal') ?? options.reduce((a, b) => (b.value > a.value ? b : a));
    p.hand.splice(p.hand.indexOf(pick), 1);
    p.exile.push(pick);
    this.imprinted.set(perm.id, pick);
    this.say(`${p.name} exiles ${pick.name} with Isochron Scepter.`);
  }

  /**
   * Put a permanent straight onto the battlefield, without casting it and
   * without triggers. For building board states (tests, puzzles), not used in play.
   */
  put(seat: number, card: SimCard, opts: { sick?: boolean; tapped?: boolean; counters?: number; commander?: boolean } = {}): Perm {
    const p = this.players[seat];
    const perm = this.makePerm(p, card, false);
    if (card.isLand && card.land) perm.landInfo = card.land;
    perm.sick = opts.sick ?? false;
    perm.tapped = opts.tapped ?? false;
    perm.counters = opts.counters ?? 0;
    perm.isCommander = opts.commander ?? false;
    p.battlefield.push(perm);
    // A card put straight onto the table (tests, tools) wasn't in any deck: let its triggers be checked.
    for (const e of card.effects) {
      this.kindsInGame.add(e.kind);
      this.kindsInGame.add(`when:${e.when}`);
    }
    return perm;
  }

  /** Put a lore counter on a Saga and set off the chapter it reaches (rule 714.2b). */
  private addLore(p: PlayerState, perm: Perm) {
    if (this.countersBlocked(perm)) return;
    perm.lore = (perm.lore ?? 0) + 1;
    const hits = perm.card.effects.filter((e) => e.when === 'chapter' && e.chapters?.includes(perm.lore!));
    this.say(`${perm.card.name} gets lore counter ${perm.lore}.`);
    if (hits.length) this.trigger(p, perm.card, perm.id, hits);
    // Sigurd: "whenever you put a lore counter on a Saga you control".
    if (this.kindsInGame.has('when:lore')) this.fire(p, 'lore');
  }

  private levelCards = new WeakMap<SimCard, SimCard[]>();
  /** A Class gains a level: its card now has the abilities of every level so far (rule 716.2). */
  private setLevel(p: PlayerState, perm: Perm, level: number) {
    const base = perm.printed ?? perm.card;
    let cache = this.levelCards.get(base);
    if (!cache) this.levelCards.set(base, (cache = []));
    const gained = (base.levels ?? []).filter((l) => l.level <= level);
    // "When this Class becomes level N" happens once, as the level is gained; it isn't kept on the card.
    cache[level] ??= { ...base, effects: [...base.effects, ...gained.flatMap((l) => l.effects.filter((e) => e.when !== 'resolve'))] };
    perm.printed = base;
    perm.card = cache[level];
    perm.level = level;
    this.say(`${p.name}'s ${base.name} becomes level ${level}.`);
    const now = gained.find((l) => l.level === level)?.effects.filter((e) => e.when === 'resolve') ?? [];
    if (now.length) this.trigger(p, perm.card, perm.id, now);
  }

  /** Exile a permanent and return it at once: a new object, so its enters abilities happen again (rule 400.7). */
  private *blinkPerm(perm: Perm): Flow<void> {
    const controller = this.players[perm.seat];
    const owner = this.players[perm.owner ?? perm.seat];
    const idx = controller.battlefield.indexOf(perm);
    if (idx === -1) return;
    controller.battlefield.splice(idx, 1);
    // A token that leaves the battlefield ceases to exist (rule 111.8).
    if (perm.token || !owner.alive) return;
    // Control that lasts "for as long as" this permanent stays ends now (Sower of Temptation).
    if (this.anyHeld) for (const q of this.allPerms()) if (q.heldBy === perm.id) this.giveBack(q);
    // A merged permanent returns as its separate cards (rule 721.3); a face-down or transformed one returns face up, front face first.
    const cards = perm.parts
      ? perm.parts.flatMap((x) => (x.real ? [{ card: x.real, commander: x.commander }] : []))
      : [{ card: realCard(perm), commander: perm.isCommander }];
    for (const { card, commander } of cards) {
      this.say(`${card.name} is exiled and returns to the battlefield under ${owner.name}'s control.`);
      yield* this.enter(owner, card, commander, 0, null);
    }
  }

  /** Seats that goaded this creature, including static goad (Baeloth Barrityl). */
  goaders(perm: Perm): number[] {
    const seats = [...(perm.goadedBy ?? [])];
    if (this.kindsInGame.has('goad')) {
      for (const o of this.opponents(this.players[perm.seat])) {
        if (seats.includes(o.seat)) continue;
        for (const src of o.battlefield) {
          if (src.card.effects.some((e) => e.kind === 'goad' && e.weaker && e.when === 'static') && this.power(perm) < this.power(src)) {
            seats.push(o.seat);
            break;
          }
        }
      }
    }
    return seats;
  }

  private goad(perm: Perm, by: PlayerState) {
    if (perm.seat === by.seat) return;
    perm.goadedBy = [...new Set([...(perm.goadedBy ?? []), by.seat])];
  }

  /** Put a copy of a spell or ability on the stack for `p`, who may choose new targets (rule 707.10). */
  /** `extra`: Twinning Staff may add one more copy. `nonlegendary`: the copy isn't legendary (Double Major). */
  private *copyItem(p: PlayerState, orig: StackItem, extra = true, nonlegendary = false): Flow<void> {
    const src = this.findPerm(orig.sourceId);
    const targets: (Target | null)[] = [];
    for (let i = 0; i < orig.effects.length; i++) {
      const e = orig.effects[i];
      const old = orig.targets[i];
      const all = old ? this.aimAs(orig.card, p.seat, orig.kind === 'ability', () => this.targetCandidates(p, e, src)) : null;
      if (!old || !all || !all.length) {
        targets.push(old);
        continue;
      }
      const pick = all.length === 1 ? all[0] : yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `${orig.card.name} (copy): choose a new target.`, card: orig.card, effect: e, candidates: all, cancellable: false });
      targets.push(pick && all.some((c) => sameTarget(c, pick)) ? pick : old);
    }
    const copy: StackItem = { ...orig, id: this.nextId++, controller: p.seat, targets, isCommander: false, copy: true, flashback: false, label: `${orig.label} (copy)` };
    if (nonlegendary && copy.card.isLegendary) copy.card = this.nonlegendary(copy.card);
    delete copy.alt;
    this.stack.push(copy);
    this.say(`${p.name} copies ${orig.label}.`);
    // Twinning Staff: one more copy for each one you control (rule 614.1a).
    if (extra && this.kindsInGame.has('copyDoubler')) for (let i = this.statics(p, 'copyDoubler'); i > 0; i--) yield* this.copyItem(p, orig, false, nonlegendary);
  }

  private putLand(p: PlayerState, card: SimCard, info: LandInfo, forceTapped = false): Perm {
    const perm = this.makePerm(p, card, false);
    perm.landInfo = info;
    perm.tapped = forceTapped || info.tapped;
    // Archon of Emeria, Thalia, Heretic Cathar.
    if (!card.isBasic && this.kindsInGame.has('landRule') && this.opponents(p).some((o) => this.landRules(o).has('oppNonbasicTapped'))) perm.tapped = true;
    perm.sick = false;
    p.battlefield.push(perm);
    // Elesh Norn, Mother of Machines: a land entering is a permanent entering.
    const times = this.triggerTimes(p, 'permanentEnters', card);
    const etb = card.effects.filter((e) => e.when === 'resolve');
    if (etb.length) for (let i = 0; i < times; i++) this.trigger(p, card, perm.id, etb);
    if (this.kindsInGame.has('landPunish')) {
      for (const q of this.allPerms()) for (const e of q.card.effects) {
        if (e.kind === 'landPunish' && !p.shielded) {
          p.life -= e.n;
          this.say(`${q.card.name} deals ${e.n} damage to ${p.name} (life ${p.life}).`);
        }
      }
    }
    for (let i = 0; i < times; i++) this.fire(p, 'landfall');
    if (this.anyCurse) this.curseEvent(p, 'landEnters');
    return perm;
  }

  /** The last rules-bending cards (cardRulesFinal.ts): Kill Switch, Despotic Scepter, Reconnaissance, Berserker's Frenzy, The Ozolith, Knowledge Pool, Alter Reality ... */
  private *resolveFinal(p: PlayerState, e: Effect, src: Perm | null, x: number, target: Target | null): Flow<void> {
    const aimed = target?.kind === 'perm' ? this.findPerm(target.id) : null;
    switch (e.kind) {
      case 'castImprinted': {
        // Isochron Scepter: the copy is cast as the ability resolves (rule 707.12), and ceases to exist if it can't be.
        const card = src ? this.imprinted.get(src.id) : undefined;
        if (!card) {
          this.say(`${src?.card.name ?? 'It'} has no card exiled with it.`);
          break;
        }
        this.pendingCasts.push({ seat: p.seat, card: { ...card }, copy: true, why: src!.card.name });
        break;
      }
      case 'tapArtifacts': {
        // Kill Switch: "tap all other artifacts. They don't untap during their controllers' untap steps for as long as this artifact remains tapped."
        const hit = this.allPerms().filter((q) => q !== src && !q.emblem && (q.card.isArtifact || this.foodAbility(q)));
        for (const q of hit) q.tapped = true;
        if (src) src.holdsTapped = hit.map((q) => q.id);
        this.say(`${src?.card.name ?? 'It'} taps ${hit.length} other artifact${hit.length === 1 ? '' : 's'}.`);
        break;
      }
      case 'ownPerm': {
        // Despotic Scepter, Tel-Jilad Stylus: a permanent you own, even one an opponent controls now.
        if (!aimed || (aimed.owner ?? aimed.seat) !== p.seat) break;
        if (e.to === 'destroy') {
          if (this.hasKw(aimed, 'indestructible')) break;
          this.say(`${aimed.card.name} is destroyed (${src?.card.name ?? 'it'}).`);
          this.removePerm(aimed, 'graveyard');
        } else {
          this.say(`${aimed.card.name} goes to the bottom of ${p.name}'s library (${src?.card.name ?? 'it'}).`);
          const card = aimed.token ? null : realCard(aimed);
          this.removePerm(aimed, 'exile');
          // removePerm put it in exile (or the command zone): move a nontoken card on to the bottom of the library.
          if (card && p.exile[p.exile.length - 1] === card) {
            p.exile.pop();
            p.library.push(card);
          }
        }
        break;
      }
      case 'removeFromCombat': {
        // Reconnaissance (rule 506.4): it stops being an attacking creature, and untaps.
        if (!aimed || aimed.seat !== p.seat || aimed.attacking === null) break;
        aimed.attacking = null;
        aimed.attackingPw = undefined;
        for (const b of this.allPerms()) if (b.blocking === aimed.id) b.blocking = null;
        aimed.tapped = false;
        this.say(`${aimed.card.name} is removed from combat and untaps.`);
        break;
      }
      case 'forceBlocks': {
        // Berserker's Frenzy: only before blockers are declared. Two d20, the higher counts.
        if (!BEFORE_BLOCKERS.includes(this.step) && this.step !== 'main1') break;
        const roll = Math.max(this.rng.int(20) + 1, this.rng.int(20) + 1);
        const mode = roll >= 15 ? 'choose' : 'must';
        this.forcedBlocks = { by: p.seat, mode, turn: this.turnNumber };
        this.say(`${p.name} rolls ${roll}: ${mode === 'choose' ? `${p.name} chooses how creatures block this turn` : 'creatures that would lose a fight block this turn if able'}.`);
        break;
      }
      case 'shuffleGraveyard': {
        // Enhanced Surveillance: shuffle your graveyard into your library.
        const n = p.graveyard.length;
        p.library.push(...p.graveyard.splice(0));
        this.rng.shuffle(p.library);
        this.say(`${p.name} shuffles their graveyard (${n} cards) into their library.`);
        break;
      }
      case 'ozolith': {
        if (!src || !this.players[src.seat].battlefield.includes(src)) break;
        if (e.act === 'store') {
          // "Put those counters on The Ozolith": +1/+1 (or -1/-1) counters, kept on an artifact that isn't a creature.
          if (x === 0 || this.countersBlocked(src)) break;
          src.counters += x;
          this.say(`${src.card.name} keeps ${Math.abs(x)} ${x > 0 ? '+1/+1' : '-1/-1'} counter${Math.abs(x) === 1 ? '' : 's'} (${src.counters}).`);
          break;
        }
        if (!src.counters || !aimed || !aimed.card.isCreature) break;
        const n = src.counters;
        src.counters = 0;
        if (n > 0) this.putCounters(aimed, n);
        else this.minusCounters(aimed, -n, p);
        this.say(`${src.card.name} moves ${Math.abs(n)} ${n > 0 ? '+1/+1' : '-1/-1'} counter${Math.abs(n) === 1 ? '' : 's'} onto ${aimed.card.name}.`);
        break;
      }
      case 'moveCounters': {
        if (!aimed || aimed.seat !== p.seat) break;
        if (e.from === 'subject') {
          // Resourceful Defense: the counters the permanent that left had.
          if (x > 0) this.putCounters(aimed, x);
          else if (x < 0) this.minusCounters(aimed, -x, p);
          if (x) this.say(`${aimed.card.name} gets the ${Math.abs(x)} counter${Math.abs(x) === 1 ? '' : 's'} (${src?.card.name ?? 'it'}).`);
          break;
        }
        // Moxite Refinery, Resourceful Defense: counters taken from another permanent of yours (the one in danger, else the one that uses them least).
        const from = this.counterDonor(p, aimed);
        if (!from) break;
        if (from.counters > 0) {
          const n = from.counters;
          from.counters = 0;
          if (aimed.card.isCreature) this.putCounters(aimed, n);
          else this.addCharge(aimed, n);
          this.say(`${n} counter${n === 1 ? '' : 's'} move${n === 1 ? 's' : ''} from ${from.card.name} to ${aimed.card.name}.`);
        } else if ((from.charge ?? 0) > 0) {
          const n = from.charge!;
          from.charge = 0;
          this.refreshStation(from);
          if (aimed.card.isCreature) this.putCounters(aimed, n);
          else this.addCharge(aimed, n);
          this.say(`${n} counter${n === 1 ? '' : 's'} move${n === 1 ? 's' : ''} from ${from.card.name} to ${aimed.card.name}.`);
        }
        break;
      }
      case 'knowledgePool': {
        // Imprint: each player exiles the top three cards of their library.
        if (!src) break;
        const pile = this.exiledWith.get(src.id) ?? [];
        for (const q of this.alivePlayers()) {
          const top = q.library.splice(0, 3);
          q.exile.push(...top);
          for (const card of top) pile.push({ card, owner: q.seat });
        }
        this.exiledWith.set(src.id, pile);
        this.say(`Each player exiles the top three cards of their library into ${src.card.name}.`);
        break;
      }
      case 'textChange': {
        if (!aimed) break;
        yield* this.changeText(p, aimed, e);
        break;
      }
    }
  }

  /** Moxite Refinery, Resourceful Defense: the permanent of yours to take counters from, other than `to`. */
  counterDonor(p: PlayerState, to: Perm): Perm | null {
    const has = (q: Perm) => q !== to && (q.counters > 0 || (q.charge ?? 0) > 0);
    // One of ours that an opponent's spell or ability is about to remove.
    for (const s of [...this.stack].reverse()) {
      if (s.controller === p.seat) continue;
      for (const t of s.targets) if (t?.kind === 'perm') {
        const q = p.battlefield.find((r) => r.id === t.id);
        if (q && has(q)) return q;
      }
    }
    // Otherwise counters doing nothing: on a permanent that isn't a creature and has nothing to spend them on, or a creature that can't attack.
    const idle = p.battlefield.filter((q) => has(q) && (q.card.isCreature ? this.hasKw(q, 'defender') : q.counters > 0 || chargeUse(q.card) === 0));
    return idle.sort((a, b) => b.counters + (b.charge ?? 0) - a.counters - (a.charge ?? 0))[0] ?? null;
  }

  /**
   * Alter Reality, Whim of Volrath (rule 612): change a color word (or basic land type) in a permanent's text. The words the engine
   * reads are protection from a color and landwalk: an opponent's protection from our color goes to one we don't use, ours to the
   * color the table uses most; landwalk the same way with land types.
   */
  private *changeText(p: PlayerState, perm: Perm, e: Extract<Effect, { kind: 'textChange' }>): Flow<void> {
    const base = perm.card;
    const mine = perm.seat === p.seat;
    const theirColor = (): Color | null => {
      const count = new Map<Color, number>();
      for (const o of this.opponents(p)) for (const c of o.identity) count.set(c, (count.get(c) ?? 0) + 1);
      return [...count].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    };
    const unused = (['W', 'U', 'B', 'R', 'G'] as Color[]).find((c) => !p.identity.includes(c)) ?? null;
    const keywords = base.keywords.map((kw) => {
      const m = kw.match(/^(pro|hexfrom):([WUBRG])$/);
      if (m) {
        const to = mine ? theirColor() : p.identity.includes(m[2] as Color) ? unused : null;
        return to && to !== m[2] ? `${m[1]}:${to}` : kw;
      }
      const walk = LANDWALKS.find(([w]) => w === kw);
      if (walk && e.landTypes) {
        const has = (q: PlayerState, type: string) => q.battlefield.some((l) => l.landInfo && hasSubtype(l.card, type));
        const types = LANDWALKS.map(([w, t]) => [w, t] as const);
        const to = mine ? types.find(([, t]) => this.opponents(p).some((o) => has(o, t))) : has(p, walk[1]) ? types.find(([, t]) => !has(p, t)) : undefined;
        return to ? to[0] : kw;
      }
      return kw;
    });
    if (keywords.every((k, i) => k === base.keywords[i])) {
      this.say(`${base.name}'s text changes, to no effect here.`);
      return;
    }
    if (e.until === 'eot') {
      perm.copiedUntilEot ??= base;
      this.anyTemporary = true;
    } else perm.printed ??= realCard(perm);
    perm.card = { ...base, keywords };
    for (const kw of keywords) if (isProtection(kw)) this.kindsInGame.add('protection');
    this.say(`${base.name}'s text changes: ${keywords.filter((k, i) => k !== base.keywords[i]).join(', ')}${e.until === 'eot' ? ' until end of turn' : ''}.`);
  }

  /** Knowledge Pool: a spell cast from hand is exiled, and its caster may cast another card from the pool without paying its mana cost. */
  private *knowledgePoolSwap(p: PlayerState, item: StackItem): Flow<void> {
    const pool = this.staticsOf('knowledgePool')[0]?.perm;
    const idx = this.stack.indexOf(item);
    if (!pool || idx === -1) return;
    this.stack.splice(idx, 1);
    // The spell goes to its owner's exile: it may have come from someone else's (rule 400.3).
    const spellOwner = item.owner ?? p.seat;
    this.players[spellOwner].exile.push(item.card);
    const pile = (this.exiledWith.get(pool.id) ?? []).filter((r) => this.players[r.owner].exile.includes(r.card));
    const options = pile.filter((r) => !r.card.isLand && r.card !== item.card);
    pile.push({ card: item.card, owner: spellOwner });
    this.exiledWith.set(pool.id, pile);
    this.say(`${item.card.name} is exiled into ${pool.card.name}.`);
    if (!options.length) return;
    const picks = yield* this.choose(p, 'freeCast', `${pool.card.name}: cast one of these without paying its mana cost?`, options.map((r) => ({ label: r.card.name, card: r.card })), 0, 1);
    const r = options[picks[0] ?? -1];
    if (!r) return;
    const owner = this.players[r.owner];
    owner.exile.splice(owner.exile.indexOf(r.card), 1);
    pile.splice(pile.indexOf(r), 1);
    const before = this.stack.length;
    const ok = yield* this.cast(p, r.card, false, 0, 'free');
    if (!ok) {
      owner.exile.push(r.card);
      pile.push(r);
      return;
    }
    const cast = this.stack[before];
    if (cast && cast.card === r.card && owner !== p) cast.owner = owner.seat;
  }

  /** Desecrated Tomb: did creature cards leave a watching player's graveyard since the last check? */
  private graveyardWatch() {
    for (const q of this.players) {
      if (!q.alive || !q.battlefield.some((w) => w.card.effects.some((e) => e.when === 'leaveGraveyard'))) {
        this.graveyardSeen.delete(q.seat);
        continue;
      }
      const now = new Map<SimCard, number>();
      for (const c of q.graveyard) if (c.isCreature) now.set(c, (now.get(c) ?? 0) + 1);
      const before = this.graveyardSeen.get(q.seat);
      this.graveyardSeen.set(q.seat, now);
      if (!before) continue;
      let left = 0;
      for (const [c, k] of before) left += Math.max(0, k - (now.get(c) ?? 0));
      if (left > 0) this.fire(q, 'leaveGraveyard', left);
    }
  }

  private *choose(p: PlayerState, reason: ChooseReason, prompt: string, options: ChoiceOption[], min: number, max: number): Flow<number[]> {
    max = Math.min(max, options.length);
    min = Math.min(min, max);
    if (max <= 0) return [];
    if (min === options.length) return options.map((_, i) => i);
    const answer = yield* ask<number[] | null>({ kind: 'choose', seat: p.seat, reason, prompt, options, min, max });
    const picks = [...new Set((Array.isArray(answer) ? answer : []).filter((i) => Number.isInteger(i) && i >= 0 && i < options.length))].slice(0, max);
    // Fill up from the front if too few were picked.
    for (let i = 0; picks.length < min && i < options.length; i++) if (!picks.includes(i)) picks.push(i);
    return picks;
  }

  /** `card`: the card the spell or ability comes from. */
  private *resolveEffect(p: PlayerState, e: Effect, src: Perm | null, x: number, target: Target | null, card?: SimCard): Flow<void> {
    const n = (v: number) => (v === -1 ? x : v);
    // "You may pay {E}{E}{E}. When you do, ...": paid if there is enough energy (rule 107.14).
    if (e.energyCost) {
      if (p.energy < e.energyCost) return;
      this.payEnergy(p, e.energyCost);
    }
    // "Then if it has eight or more night counters on it, remove all of them and ..." (Replicating Ring).
    if (e.chargeAtResolve) {
      if (!src || (src.charge ?? 0) < e.chargeAtResolve.n) return;
      if (e.chargeAtResolve.reset) {
        src.charge = 0;
        this.refreshStation(src);
      }
    }

    switch (e.kind) {
      case 'tapArtifacts':
      case 'castImprinted':
      case 'ownPerm':
      case 'removeFromCombat':
      case 'forceBlocks':
      case 'shuffleGraveyard':
      case 'ozolith':
      case 'moveCounters':
      case 'knowledgePool':
      case 'textChange':
        yield* this.resolveFinal(p, e, src, x, target);
        break;
      case 'exilePlay':
        yield* this.resolveExilePlay(p, e, src, x, target);
        break;
      case 'freeCast':
        yield* this.resolveFreeCast(p, e, src, x, target);
        break;
      case 'search':
        yield* this.resolveSearch(p, e, src, x, target);
        break;
      case 'rearrange':
        yield* this.rearrange(p, e);
        break;
      case 'ramp': {
        const pool = yield* this.searchLibrary(p);
        if (!pool) break;
        let found = 0;
        const window = pool === p.library ? null : [...pool];
        for (let i = 0; i < e.lands + e.toHand; i++) {
          const looking = window ?? p.library;
          const names = [...new Set(looking.filter((c) => c.isBasic && c.land).map((c) => c.name))];
          if (!names.length) break;
          const toBattlefield = i < e.lands;
          const pick = names.length === 1 ? [0] : yield* this.choose(p, 'ramp', `Search for a basic land${toBattlefield ? ' to put onto the battlefield' : ' for your hand'}.`, names.map((name) => ({ label: name, card: looking.find((c) => c.name === name) })), 1, 1);
          const land = looking.find((c) => c.isBasic && c.land && c.name === names[pick[0] ?? 0])!;
          if (window) window.splice(window.indexOf(land), 1);
          if (!this.foundInSearch(p, [land]).length) continue;
          p.library.splice(p.library.indexOf(land), 1);
          if (toBattlefield) this.putLand(p, land, land.land!, e.tapped);
          else p.hand.push(land);
          found++;
        }
        this.rng.shuffle(p.library);
        if (found) this.say(`${p.name} searches for ${found} basic land${found > 1 ? 's' : ''}.`);
        break;
      }
      case 'treasure': {
        // Treasures are tokens, so Doubling Season and Parallel Lives double them (rule 111.1, 614.1a). Ritual mana is not.
        const count = e.byCharge ? src?.charge ?? 0 : e.shareType ? x : e.islands ? this.islands(p).filter((q) => !q.tapped).length : e.ritual ? n(e.n) : Math.min(e.n * 2 ** this.doublers(p, 'tokens'), 40);
        if (count <= 0) break;
        // Ritual mana goes to the mana pool and empties as the step ends (firebending's at end of combat, rule 106.4).
        if (e.ritual) this.addMana(p, count, { until: e.lasts === 'combat' && COMBAT_STEPS.includes(this.step) ? 'combat' : 'step', abilityOnly: e.abilityOnly, colorless: e.colorless });
        else p.treasures += count;
        this.say(`${p.name} ${e.ritual ? 'gets' : 'makes'} ${count} ${e.ritual ? 'mana' : `Treasure${count > 1 ? 's' : ''}`}.`);
        if (!e.ritual && !e.byCharge) yield* this.tokensMade(p, count, 'treasure');
        break;
      }
      case 'extraLand': {
        const lands = p.hand.filter((c) => c.isLand && c.land);
        if (!lands.length) break;
        const pick = yield* this.choose(p, 'extraLand', 'Put a land from your hand onto the battlefield?', lands.map((card) => ({ label: card.name, card })), 0, 1);
        if (!pick.length) break;
        const land = lands[pick[0]];
        p.hand.splice(p.hand.indexOf(land), 1);
        this.say(`${p.name} puts ${land.name} onto the battlefield.`);
        this.putLand(p, land, land.land!);
        break;
      }
      case 'draw': {
        if (e.discardHand && p.hand.length) {
          // Clive: discard your hand first.
          const gone = p.hand.splice(0);
          for (const card of gone) this.discarded(p, card, true);
          this.say(`${p.name} discards their hand (${gone.length}).`);
        }
        // "Draw half X cards, rounded down" (Wan Shi Tong): a fractional xTimes on a spell or enters ability.
        const half = e.xTimes !== undefined && e.xTimes < 1;
        const count = e.count ? this.drawCount(p, e.count) : e.n === -1 ? (half ? Math.floor(x * e.xTimes!) : Math.max(x, 1)) : e.n;
        if (count <= 0) break;
        // "That player draws seven cards" (Forced Fruition), "the attacking player draws a card" (Breena).
        if (e.thatPlayer && target?.kind === 'player') {
          const who = this.players[target.seat];
          this.draw(who, count);
          this.say(`${who.name} draws ${count} card${count > 1 ? 's' : ''}.`);
          break;
        }
        this.draw(p, count, e.when === 'opponentDraw');
        this.say(`${p.name} draws ${count} card${count > 1 ? 's' : ''}.`);
        break;
      }
      case 'removal':
        yield* this.resolveRemoval(p, e, src, x, target);
        break;
      case 'loseHalf': {
        const v = target?.kind === 'player' ? this.players[target.seat] : null;
        if (!v?.alive || v.life <= 0) break;
        const lost = this.loseLife(v, Math.ceil(v.life / 2), p, 'noncombat');
        this.say(`${v.name} loses half their life: ${lost} (life ${v.life}).`);
        break;
      }
      case 'preventNext':
        p.preventNext = { reflect: e.reflect, card: card ?? this.resolvingCard ?? p.commandZone[0] };
        this.say(`${p.name} will prevent the next damage a source deals to them this turn.`);
        break;
      case 'deathShield':
        p.deathShield = this.turnNumber;
        this.say(`This turn, ${p.name}'s permanents are exiled instead of going to the graveyard, and come back at the end step.`);
        break;
      case 'reanimateExiled': {
        if (!src) break;
        const pile = (this.exiledWith.get(src.id) ?? []).filter((r) => this.players[r.owner].exile.includes(r.card));
        if (!pile.length) break;
        // The Darkness Crystal: the best one. Gisa: all of them, with decayed.
        const chosen = e.all ? pile : [pile.reduce((a, b) => (b.card.value > a.card.value ? b : a))];
        this.exiledWith.set(src.id, pile.filter((r) => !chosen.includes(r)));
        for (const r of chosen) {
          const owner = this.players[r.owner];
          owner.exile.splice(owner.exile.indexOf(r.card), 1);
          this.say(`${r.card.name} comes back under ${p.name}'s control (${src.card.name}).`);
          const perm = yield* this.enter(p, r.card, false, 0, null, owner);
          if (!perm) continue;
          if (e.tapped) perm.tapped = true;
          if (e.counters && !this.countersBlocked(perm)) perm.counters += e.counters;
          // Decayed (rule 702.147): it can't block, and it is sacrificed at end of combat when it attacks.
          if (e.all) perm.kwCounters = [...(perm.kwCounters ?? []), 'decayed', "can't block"];
        }
        break;
      }
      case 'returnDied': {
        const d = this.resolving?.died;
        if (!d) break;
        const owner = this.players[d.owner];
        const i = owner.graveyard.indexOf(d.card);
        if (i === -1 || this.graveyardLocked()) break;
        owner.graveyard.splice(i, 1);
        this.say(`${d.card.name} returns to the battlefield under ${p.name}'s control.`);
        const perm = yield* this.enter(p, d.card, false, 0, null, owner);
        if (perm && e.kw && !this.countersBlocked(perm)) perm.kwCounters = [...(perm.kwCounters ?? []), e.kw];
        break;
      }
      case 'returnAs': {
        if (!card) break;
        const owner = p;
        if (e.as === 'library') {
          if (!owner.deck.commanders.includes(card)) this.tuck(owner, card, e.n ?? 0);
          break;
        }
        if (!owner.graveyard.includes(card)) break;
        if (e.as === 'handAtEnd') {
          this.endReturns.push({ card, owner: owner.seat, to: 'hand', from: 'graveyard' });
          break;
        }
        if (this.graveyardLocked()) break;
        owner.graveyard.splice(owner.graveyard.indexOf(card), 1);
        if (e.as === 'enchantment') {
          // The Enduring cycle: back as an enchantment that isn't a creature, so it can't die and return again.
          this.say(`${card.name} returns to the battlefield as an enchantment.`);
          const perm = yield* this.enter(p, enchantmentOnly(card), false, 0, null);
          if (perm) perm.printed = card;
        } else {
          this.say(`${card.name} returns to the battlefield${e.as === 'stunned' ? ` tapped with ${e.n ?? 2} stun counters` : ''}.`);
          const perm = yield* this.enter(p, card, false, 0, null);
          if (perm && e.as === 'stunned') {
            perm.tapped = true;
            perm.stun = (perm.stun ?? 0) + (e.n ?? 2);
          }
        }
        break;
      }
      case 'wipe': {
        const amount = n(e.amount);
        // Wrath of the Skies: pay all the energy you have; everything with mana value up to that goes.
        const cap = e.byEnergy ? p.energy : Infinity;
        if (e.byEnergy) this.payEnergy(p, cap);
        this.say(`${p.name} wipes the board (${e.mode} ${e.target === 'creatures' ? 'creatures' : 'nonland permanents'}${e.oneSided ? ', opponents only' : ''}).`);
        // Everything goes at once, so death triggers see every creature that died with them (rule 603.10a).
        const hit: Perm[] = [];
        for (const q of this.alivePlayers()) {
          if (e.oneSided && q === p) continue;
          for (const perm of q.battlefield) {
            if (perm.card.isLand) continue;
            if (e.target === 'creatures' && !perm.card.isCreature) continue;
            if (e.target === 'artifacts' && !perm.card.isArtifact) continue;
            if (perm.card.cmc > cap || (e.byEnergy && perm.card.isPlaneswalker && !perm.card.isCreature)) continue;
            // Ugin, the Spirit Dragon: mana value X or less, and one or more colors.
            if (e.maxCmc !== undefined && perm.card.cmc > n(e.maxCmc)) continue;
            if (e.colored && !cardColors(perm.card).length) continue;
            if (e.mode === 'damage') {
              // Protection from the sweeper's color (or from everything) prevents its damage (rule 702.16e).
              if (perm.card.isCreature && !(card && !e.shrink && this.protectedFromCard(perm, card, p.seat))) this.hurt(perm, e.shrink ? amount : this.damagePerm(p, card ?? null, src, perm, amount), e.shrink, p);
            } else if (e.mode === 'exile' || e.mode === 'bounce' || !this.hasKw(perm, 'indestructible') && !this.regenerated(perm)) hit.push(perm);
          }
        }
        if (hit.length) this.removePerms(hit, e.mode === 'exile' ? 'exile' : e.mode === 'bounce' ? 'hand' : 'graveyard');
        break;
      }
      case 'transform':
        yield* this.transform(p, e, src);
        break;
      case 'manifest': {
        if (e.who === 'opponents') {
          for (const o of this.opponents(p)) yield* this.manifest(p, o, !!e.dread);
        } else {
          const who = e.who === 'you' ? p : this.aimedSeat !== null ? this.players[this.aimedSeat] : null;
          if (who?.alive) yield* this.manifest(who, who, !!e.dread);
        }
        break;
      }
      case 'counter': {
        if (!target || target.kind !== 'stack') break;
        const idx = this.stack.findIndex((s) => s.id === target.id);
        if (idx === -1 || this.uncounterable(this.stack[idx])) break;
        const [hit] = this.stack.splice(idx, 1);
        this.say(`${hit.label} is countered.`);
        if (hit.kind === 'spell') this.leaveStack(this.players[hit.controller], hit);
        // Mana Drain: mana equal to the countered spell's mana value, kept as one-shot mana.
        if (e.refund && hit.kind === 'spell' && hit.card.cmc > 0) {
          this.addMana(p, hit.card.cmc, { until: 'nextMain', colorless: true });
          this.say(`${p.name} will get ${hit.card.cmc} mana at the beginning of their next main phase.`);
        }
        this.fire(p, 'countered');
        break;
      }
      case 'tokens': {
        if (e.army) {
          // Amass N (rule 701.47): N +1/+1 counters on an Army you control, making a 0/0 Army first if you have none.
          const card = armyCard();
          let army = p.battlefield.find((q) => q.card === card);
          const made: Perm[] = [];
          if (!army) {
            const count = Math.min(2 ** this.doublers(p, 'tokens'), 40);
            for (let i = 0; i < count; i++) made.push(this.makePerm(p, card, true));
            p.battlefield.push(...made);
            army = made[0];
          }
          if (!this.countersBlocked(army)) army.counters += e.power * 2 ** this.doublers(p, 'counters');
          for (const token of made) this.creatureEntered(p, token);
          this.say(`${p.name} amasses ${e.power}${made.length ? ', making an Army token' : ''} (Army is ${this.power(army)}/${this.toughness(army)}).`);
          break;
        }
        const count = Math.min((e.n === -1 ? x : e.n) * 2 ** this.doublers(p, 'tokens'), 40);
        // Moonlit Meditation: the first tokens each turn are copies of the enchanted permanent instead.
        const host = count > 0 ? this.moonlitHost(p) : null;
        if (host) {
          this.moonlitUsed.add(p.seat);
          for (let i = 0; i < Math.min(count, 20); i++) yield* this.makeCopyToken(p, host.card, host.landInfo);
          this.say(`${p.name} makes ${count} token cop${count > 1 ? 'ies' : 'y'} of ${host.card.name} instead (Moonlit Meditation).`);
          yield* this.tokensMade(p, count, 'copy');
          break;
        }
        for (let i = 0; i < count; i++) {
          const token = this.makePerm(p, tokenCard(e.power, e.toughness, e.keywords, e.subtypes), true);
          if (e.fragile) token.fragile = e.fragile;
          p.battlefield.push(token);
          // Living weapon, job select: the Equipment is attached to the first token (rules 702.92a, 702.182a).
          if (e.attachSource && i === 0 && src && p.battlefield.includes(src)) {
            src.attachedTo = token.id;
            this.anyAttached = true;
          }
          this.creatureEntered(p, token);
        }
        if (count > 0) this.say(`${p.name} makes ${count} ${e.power}/${e.toughness} token${count > 1 ? 's' : ''}.`);
        if (count > 0) yield* this.tokensMade(p, count, 'creature');
        break;
      }
      case 'overrun': {
        // "+X/+X, where X is ...": worked out once, as the ability resolves.
        const team = p.battlefield.filter((q) => q.card.isCreature);
        const scaled = e.scale === 'creatures' ? team.length : e.scale === 'power' ? Math.max(0, ...team.map((q) => this.power(q))) : null;
        const bp = scaled ?? n(e.p);
        const bt = scaled ?? n(e.t);
        for (const perm of team) {
          perm.tempP += bp;
          perm.tempT += bt;
          if (e.trample) perm.tempKw.push('trample');
          if (e.grant) perm.tempKw.push(...e.grant);
        }
        this.say(e.grant && !bp && !bt ? `${p.name}'s creatures gain ${e.grant.join(', ')} until end of turn.` : `${p.name}'s creatures get +${bp}/+${bt}${e.trample ? ' and trample' : ''} until end of turn.`);
        break;
      }
      case 'pump': {
        const perm = e.self ? (src && this.players[src.seat].battlefield.includes(src) ? src : null) : target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm) break;
        const doubled = e.doublePower ? Math.max(0, this.power(perm)) : 0;
        perm.tempP += e.doublePower ? doubled : n(e.p);
        perm.tempT += n(e.t);
        if (e.protect) perm.tempKw.push('indestructible', 'hexproof');
        if (e.grant) perm.tempKw.push(...e.grant);
        this.say(e.grant && !e.p && !e.t ? `${perm.card.name} gains ${e.grant.join(', ')} until end of turn.` : `${perm.card.name} gets +${e.doublePower ? doubled : n(e.p)}/+${n(e.t)} until end of turn.`);
        break;
      }
      case 'protect': {
        if (e.all || e.player) {
          if (e.all) for (const q of p.battlefield) if (!q.card.isLand) q.tempKw.push('indestructible', 'hexproof');
          if (e.player) p.shielded = true;
          this.say(e.player ? `${p.name} can't lose life until their next turn.` : `${p.name}'s permanents are protected until end of turn.`);
          break;
        }
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm) break;
        if (e.returns !== undefined) {
          perm.tempKw.push(`returns:${e.returns}`);
          this.say(`${perm.card.name} will return to the battlefield if it dies this turn.`);
          break;
        }
        perm.tempKw.push('indestructible', 'hexproof');
        this.say(`${perm.card.name} is protected until end of turn.`);
        break;
      }
      case 'drain': {
        const amount = e.devotion ? this.devotion(p, e.devotion) : e.n === -1 ? Math.max(x, 1) : e.n;
        let total = 0;
        // "You gain life equal to the life lost this way": only what was really lost (Teferi's Protection stops it).
        for (const o of this.opponents(p)) {
          if (e.emptyHand && o.hand.length > 0) continue;
          // "Deals 1 damage to each opponent": damage, so Torbran adds to it and prevention stops it.
          const dealt = e.damage ? this.damageAfter(p, card ?? null, src, o, amount, false) : amount;
          total += this.loseLife(o, dealt, p, 'noncombat');
        }
        this.gainLife(p, e.gain === -1 ? total : e.gain);
        this.say(e.emptyHand ? `${p.name} drains each opponent with an empty hand for ${amount}.` : `${p.name} drains each opponent for ${amount}.`);
        break;
      }
      case 'damagePlayer': {
        const victim = target?.kind === 'player' ? this.players[target.seat] : null;
        if (!victim?.alive) break;
        const amount = e.n === -1 ? Math.max(x, 1) : e.n;
        // "That player loses 2 life" (Sheoldred) is life loss, not damage.
        if (e.lifeLoss) {
          const lost = this.loseLife(victim, amount, p, 'noncombat');
          this.say(`${victim.name} loses ${lost} life (life ${victim.life}).`);
          break;
        }
        if (this.damageMills(p, victim, amount)) break;
        const dealt = this.doubledDamage(victim, this.damageAfter(p, card ?? null, src, victim, amount, false), p);
        this.loseLife(victim, dealt, p, 'noncombat');
        this.say(`${p.name} hits ${victim.name} for ${dealt} (life ${victim.life}).`);
        break;
      }
      case 'gainLife':
        this.gainLife(p, e.n === -1 ? Math.max(x, 1) : e.n);
        break;
      case 'loseLife':
        // Mana Vault: only while the source is still tapped.
        if (e.ifTapped && !src?.tapped) break;
        if (!p.shielded) p.life -= e.n;
        if (e.ifTapped) this.say(`${src?.card.name ?? 'It'} deals ${e.n} damage to ${p.name} (life ${p.life}).`);
        break;
      case 'digPermanent': {
        if (e.permanents) {
          // Genesis Ultimatum (top five, the rest to hand), Genesis Wave (top X, mana value X or less, the rest to the graveyard).
          const top = p.library.splice(0, e.among === -1 ? x : e.among ?? 5);
          const found = top.filter((c) => !c.isInstant && !c.isSorcery && !isAura(c) && (!e.permanents!.xLimit || c.cmc <= x));
          const rest = top.filter((c) => !found.includes(c));
          if (e.permanents.rest === 'hand') p.hand.push(...rest);
          else for (const c of rest) this.toGraveyard(p, c, false);
          this.say(`${p.name} reveals the top ${top.length} cards and puts ${found.length ? found.map((c) => c.name).join(', ') : 'nothing'} onto the battlefield${rest.length ? ` (${rest.length} to ${e.permanents.rest === 'hand' ? 'hand' : 'the graveyard'})` : ''}.`);
          for (const c of found) {
            if (c.isLand && c.land) this.putLand(p, c, c.land);
            else yield* this.enter(p, c, false, 0, null);
          }
          break;
        }
        if (e.artifacts) {
          // Tezzeret, Master of the Bridge: every artifact card among the top ten onto the battlefield; the rest are exiled.
          const top = p.library.splice(0, e.among ?? 10);
          const found = top.filter((c) => c.isArtifact && !c.isLand);
          p.exile.push(...top.filter((c) => !found.includes(c)));
          this.say(`${p.name} exiles the top ${top.length} cards and puts ${found.length ? found.map((c) => c.name).join(', ') : 'no artifacts'} onto the battlefield.`);
          for (const c of found) yield* this.enter(p, c, false, 0, null);
          break;
        }
        const at = p.library.findIndex((c) => !c.isLand && !c.isInstant && !c.isSorcery && !isAura(c));
        if (at === -1) break;
        const [found] = p.library.splice(at, 1);
        // The cards exiled on the way go to the bottom here.
        p.library.push(...p.library.splice(0, at));
        this.say(`${p.name} digs up ${found.name} and puts it onto the battlefield.`);
        yield* this.enter(p, found, false, 0, null);
        break;
      }
      case 'tutor': {
        if (!p.library.length) break;
        const pool = yield* this.searchLibrary(p);
        if (!pool) break;
        if (e.artifactToBattlefield) {
          // Tezzeret the Seeker: an artifact card with mana value X or less onto the battlefield.
          const found = [...new Set(pool.filter((c) => c.isArtifact && !c.isLand && (!e.xLimit || c.cmc <= x)))].sort((a, b) => a.name.localeCompare(b.name));
          if (!found.length) break;
          const pick = yield* this.choose(p, 'take', 'Search your library for an artifact to put onto the battlefield.', found.map((card) => ({ label: card.name, card })), 1, 1);
          const card = found[pick[0] ?? 0];
          if (!this.foundInSearch(p, [card]).length) {
            this.rng.shuffle(p.library);
            break;
          }
          p.library.splice(p.library.indexOf(card), 1);
          this.rng.shuffle(p.library);
          this.say(`${p.name} searches their library and puts ${card.name} onto the battlefield.`);
          yield* this.enter(p, card, false, 0, null);
          break;
        }
        if (e.creatureToBattlefield) {
          const found = [...new Set(pool.filter((c) => c.isCreature && (!e.xLimit || c.cmc <= x)))].sort((a, b) => a.name.localeCompare(b.name));
          if (!found.length) break;
          const pick = yield* this.choose(p, 'take', 'Search your library for a creature to put onto the battlefield.', found.map((card) => ({ label: card.name, card })), 1, 1);
          const card = found[pick[0] ?? 0];
          if (!this.foundInSearch(p, [card]).length) {
            this.rng.shuffle(p.library);
            break;
          }
          p.library.splice(p.library.indexOf(card), 1);
          this.rng.shuffle(p.library);
          this.say(`${p.name} searches their library and puts ${card.name} onto the battlefield.`);
          yield* this.enter(p, card, false, 0, null);
          break;
        }
        const cards = [...new Set(pool)].sort((a, b) => a.name.localeCompare(b.name));
        if (!cards.length) break;
        const pick = yield* this.choose(p, 'tutor', 'Search your library for a card to put into your hand.', cards.map((card) => ({ label: card.name, card })), 1, 1);
        const card = cards[pick[0] ?? 0];
        if (!this.foundInSearch(p, [card]).length) {
          this.rng.shuffle(p.library);
          break;
        }
        p.library.splice(p.library.indexOf(card), 1);
        p.hand.push(card);
        this.rng.shuffle(p.library);
        this.say(`${p.name} searches their library for a card.`);
        break;
      }
      case 'recursion': {
        const limit = e.belowPower ? (src ? this.power(src) : 0) : Infinity;
        const pool = this.recursionPool(p, e).filter(({ card }) => card.power < limit);
        if (!pool.length) break;
        const where = e.toBattlefield ? 'the battlefield' : e.toTop ? 'the top of your library' : 'your hand';
        const elsewhere = pool.some((c) => c.owner !== p);
        const picks = e.all
          ? pool.map((_, i) => i)
          : yield* this.choose(p, 'recursion', `Return up to ${e.n} card${e.n > 1 ? 's' : ''} from ${elsewhere ? 'a graveyard' : 'your graveyard'} to ${where}.`, pool.map(({ card, owner }) => ({ label: owner === p ? card.name : `${card.name} (${owner.name})`, card })), 1, e.n);
        const chosen = picks.map((i) => pool[i]);
        if (e.all && chosen.length) this.say(`${p.name} returns ${chosen.length} card${chosen.length > 1 ? 's' : ''} from ${e.from ? 'graveyards' : 'their graveyard'} to ${where.replace('your', 'their')}: ${chosen.map((c) => c.card.name).join(', ')}.`);
        for (const { card, owner } of chosen) {
          if (!owner.graveyard.includes(card)) continue;
          owner.graveyard.splice(owner.graveyard.indexOf(card), 1);
          const from = owner === p ? '' : ` from ${owner.name}'s graveyard`;
          if (e.toTop) {
            this.say(`${p.name} puts ${card.name} on top of their library.`);
            owner.library.unshift(card);
          } else if (e.toBattlefield || (e.byExperience && card.cmc <= p.experience && !card.isInstant && !card.isSorcery)) {
            if (!e.all) this.say(`${p.name} returns ${card.name}${from} to the battlefield.`);
            if (card.isLand && card.land) {
              this.putLand(p, card, card.land, !!e.tapped);
              continue;
            }
            const perm = yield* this.enter(p, card, owner === p && p.deck.commanders.includes(card), 0, null, owner);
            if (perm && e.tapped) perm.tapped = true;
            if (perm && e.finality) this.finality.add(perm.id);
            if (perm) this.lastAffected = perm;
          } else {
            if (!e.all) this.say(`${p.name} returns ${card.name}${from} to their hand.`);
            // A card always goes to its owner's hand.
            owner.hand.push(card);
          }
        }
        break;
      }
      case 'entomb': {
        const options = [...new Set(p.library.filter((c) => e.what === 'any' || c.isCreature))];
        if (!options.length) break;
        const picks = yield* this.choose(p, 'entomb', `Put up to ${e.n} card${e.n > 1 ? 's' : ''} from your library into your graveyard.`, options.map((c) => ({ label: c.name, card: c })), 0, e.n);
        const cards = picks.map((i) => options[i]);
        for (const c of cards) {
          p.library.splice(p.library.indexOf(c), 1);
          this.toGraveyard(p, c, false);
        }
        this.rng.shuffle(p.library);
        if (cards.length) this.say(`${p.name} puts ${cards.map((c) => c.name).join(', ')} into their graveyard.`);
        break;
      }
      case 'millReanimate': {
        const c = e.fromBottom ? p.library.pop() : p.library.shift();
        if (!c) break;
        this.toGraveyard(p, c, false);
        const limit = src ? this.power(src) : 3;
        if (c.isCreature && c.power <= limit && p.graveyard.includes(c) && !this.graveyardLocked()) {
          p.graveyard.splice(p.graveyard.indexOf(c), 1);
          this.say(`${p.name} puts ${c.name} from their library onto the battlefield.`);
          yield* this.enter(p, c, false, 0, null);
        } else {
          this.say(`${p.name} mills ${c.name}.`);
        }
        break;
      }
      case 'returnSelf': {
        // Persist and undying: the card comes back from its owner's graveyard with a counter (rule 702.79, 702.93).
        if (!card || !p.graveyard.includes(card) || this.graveyardLocked()) break;
        p.graveyard.splice(p.graveyard.indexOf(card), 1);
        this.say(`${card.name} returns to the battlefield${e.tapped ? ' tapped' : ''}${e.counters ? ` with a ${e.counters > 0 ? '+1/+1' : '-1/-1'} counter` : ''}.`);
        const perm = yield* this.enter(p, card, false, 0, null);
        if (perm && e.tapped) perm.tapped = true;
        if (perm && e.counters < 0) this.minusCounters(perm, -e.counters, p);
        else if (perm && !this.countersBlocked(perm)) perm.counters += e.counters;
        break;
      }
      case 'counters': {
        const amount = (e.byExperience ? p.experience : e.n === -1 ? Math.max(x, 1) : e.n) * 2 ** this.doublers(p, 'counters');
        if (amount <= 0) break;
        const creatures = p.battlefield.filter((q) => q.card.isCreature && (!e.artifact || q.card.isArtifact));
        if (e.proliferate) {
          // Proliferate: you choose, so +1/+1 counters on your creatures and -1/-1 counters on your opponents' (rule 701.34).
          // Doubling Season only doubles counters on permanents you control. Tekuthal: twice instead, for each one.
          const twice = p.battlefield.filter((q) => q.card.effects.some((t) => t.kind === 'proliferateTwice' && t.when === 'static')).length;
          const times = 2 ** Math.min(twice, 3);
          if (times > 1) this.say(`${p.name} proliferates ${times} times.`);
          for (let rep = 0; rep < times; rep++) {
            for (const perm of creatures) if (perm.counters > 0 && !this.countersBlocked(perm)) perm.counters += amount;
            for (const perm of this.allPerms()) if (perm.seat !== p.seat && perm.card.isCreature && perm.counters < 0) this.minusCounters(perm, 1, p);
            for (const perm of p.battlefield) if (perm.loyalty !== undefined && perm.card.isPlaneswalker) perm.loyalty += amount;
            // Proliferate also reaches players (rule 701.34a): one more poison counter on each poisoned opponent,
            // and one more counter on our other permanents that have some (quest and charge counters).
            for (const o of this.opponents(p)) {
              if (o.poison > 0 && !o.shielded) {
                o.poison++;
                o.lastHitBy = p.seat;
                o.lastHitKind = 'noncombat';
                this.say(`${o.name} gets a poison counter from proliferate (${o.poison} of 10).`);
              }
            }
            for (const perm of p.battlefield) {
              if (perm.charge) {
                perm.charge++;
                this.chargeWins(perm);
              }
              if (perm.card.isCreature || perm.card.isPlaneswalker) continue;
              if (perm.loyalty !== undefined) perm.loyalty++;
              else if (perm.hours) this.addHours(perm, 1);
              else if (perm.counters > 0) perm.counters++;
            }
            // Players' counters too: energy and experience (rule 701.34a).
            if (p.energy > 0 && !this.countersBlocked()) p.energy++;
            if (p.experience > 0 && !this.countersBlocked()) p.experience++;
            this.fire(p, 'proliferate');
          }
        } else if (e.all) {
          for (const perm of creatures) this.putCounters(perm, amount);
        } else if (src && src.card.isCreature && p.battlefield.includes(src) && !e.other) {
          this.putCounters(src, amount);
        } else if (e.other ? creatures.some((q) => q !== src) : creatures.length) {
          if (e.other) creatures.splice(creatures.indexOf(src!), creatures.includes(src!) ? 1 : 0);
          const pick = creatures.length === 1 ? [0] : yield* this.choose(p, 'counters', `Put ${amount} +1/+1 counter${amount > 1 ? 's' : ''} on which creature?`, creatures.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
          this.putCounters(creatures[pick[0] ?? 0], amount);
        }
        break;
      }
      case 'exileGraveyards':
        if (e.cards) {
          // Soul-Guide Lantern, Kozilek's Command: the best cards in opponents' graveyards.
          const pool = this.opponents(p).flatMap((q) => q.graveyard.map((c) => ({ card: c, owner: q })));
          if (!pool.length) break;
          const picks = yield* this.choose(p, 'exileCard', `Exile up to ${e.cards} card${e.cards > 1 ? 's' : ''} from opponents' graveyards.`, pool.map(({ card: c, owner }) => ({ label: `${c.name} (${owner.name})`, card: c })), 1, e.cards);
          for (const { card: c, owner } of picks.map((i) => pool[i])) {
            if (!owner.graveyard.includes(c)) continue;
            owner.graveyard.splice(owner.graveyard.indexOf(c), 1);
            owner.exile.push(c);
            this.say(`${p.name} exiles ${c.name} from ${owner.name}'s graveyard.`);
          }
          break;
        }
        for (const q of e.all ? this.alivePlayers() : this.opponents(p)) {
          q.exile.push(...q.graveyard);
          q.graveyard.length = 0;
        }
        this.say(`${p.name} exiles ${e.all ? 'all graveyards' : "their opponents' graveyards"}.`);
        break;
      case 'steal': {
        // Hellkite Tyrant: every artifact the player it hit controls.
        if (e.all === 'artifacts') {
          const seat = this.resolving?.subject;
          const victim = seat !== undefined ? this.players[seat] : null;
          if (!victim?.alive || victim === p) break;
          for (const q of victim.battlefield.filter((t) => t.card.isArtifact)) this.takeControl(q, p);
          break;
        }
        // Treacherous Urge: a creature card from target opponent's hand.
        if (e.from === 'hand') {
          const victim = target?.kind === 'player' ? this.players[target.seat] : null;
          const found = victim?.alive ? victim.hand.filter((c) => c.isCreature) : [];
          if (!victim || !found.length) break;
          this.say(`${victim.name} reveals their hand.`);
          const pick = yield* this.choose(p, 'take', `Put which creature from ${victim.name}'s hand onto the battlefield?`, found.map((c) => ({ label: c.name, card: c })), 0, 1);
          if (!pick.length) break;
          const taken = found[pick[0]];
          victim.hand.splice(victim.hand.indexOf(taken), 1);
          this.say(`${p.name} puts ${taken.name} from ${victim.name}'s hand onto the battlefield.`);
          const perm = yield* this.enter(p, taken, false, 0, null, victim);
          if (!perm) break;
          if (e.haste) perm.tempKw.push('haste');
          if (e.sacAtEnd) {
            perm.atEnd = 'sacrifice';
            this.anyTemporary = true;
          }
          this.lastAffected = perm;
          break;
        }
        if (e.from === 'battlefield') {
          const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
          if (!perm) break;
          // "With mana value X or less" (Blue Sun's Twilight), checked again with the X paid.
          if (e.maxCmc === -1 && perm.card.cmc > x) break;
          // Reptilian Recruiter: power 2 or less, unless you control another Lizard.
          if (e.maxPower !== undefined && this.power(perm) > e.maxPower && !p.battlefield.some((q) => q !== src && q.card.isCreature && e.orSubtype && q.card.typeLine.includes(e.orSubtype))) break;
          // Confiscation Coup: only by paying energy equal to its mana value.
          if (e.payEnergy !== undefined) {
            if (p.energy < perm.card.cmc) break;
            this.payEnergy(p, perm.card.cmc);
          }
          if (e.whileSource) {
            // "For as long as you control ~": if that already ended, nothing happens (rule 611.2b).
            if (!src || src.seat !== p.seat || !p.battlefield.includes(src)) break;
            this.takeControl(perm, p);
            this.hold(perm, src);
          } else if (e.when === 'opponentMonarch') {
            // Garland: only while the player it came from is still the monarch.
            if (this.monarch !== perm.seat) break;
            const from = perm.seat;
            this.takeControl(perm, p);
            if (perm.owner !== undefined) {
              perm.heldWhileMonarch = from;
              this.anyHeld = true;
            }
          } else this.takeControl(perm, p);
          if (perm.seat === p.seat) {
            this.lastAffected = perm;
            // Threaten (Act of Treason): only until end of turn (or the end of your next turn), untapped, with haste.
            if (e.until) {
              perm.borrowed = { until: e.until, by: p.seat, turn: this.turnNumber };
              this.anyTemporary = true;
            }
            if (e.untap) perm.tapped = false;
            if (e.haste) perm.tempKw.push('haste');
            if (e.base) {
              // Flayer of Loyalties: base power and toughness 10/10 until end of turn.
              perm.tempP += e.base.p - this.power(perm);
              perm.tempT += e.base.t - this.toughness(perm);
              perm.tempKw.push(...e.base.keywords);
            }
            if (e.sacAtEnd) {
              perm.atEnd = 'sacrifice';
              this.anyTemporary = true;
            }
          }
          // Thieving Skydiver: "if that artifact is an Equipment, attach it to ~".
          if (e.what === 'artifact' && /\bEquipment\b/.test(perm.card.typeLine) && src?.card.isCreature && p.battlefield.includes(src) && perm.seat === p.seat) {
            perm.attachedTo = src.id;
            this.anyAttached = true;
            this.say(`${perm.card.name} is attached to ${src.card.name}.`);
          }
          break;
        }
        const victim = target?.kind === 'player' ? this.players[target.seat] : null;
        if (!victim?.alive) break;
        // Acquire: an artifact card instead of a creature card.
        const found = [...new Set(victim.library.filter((c) => (e.what === 'artifact' ? c.isArtifact : c.isCreature)))].sort((a, b) => a.name.localeCompare(b.name));
        if (!found.length) break;
        const pick = yield* this.choose(p, 'take', `Take which ${e.what === 'artifact' ? 'artifact' : 'creature'} from ${victim.name}'s library?`, found.map((card) => ({ label: card.name, card })), 1, 1);
        const card = found[pick[0] ?? 0];
        victim.library.splice(victim.library.indexOf(card), 1);
        this.rng.shuffle(victim.library);
        this.say(`${p.name} takes ${card.name} from ${victim.name}'s library.`);
        yield* this.enter(p, card, false, 0, null, victim);
        break;
      }
      case 'cheat': {
        const creatures = [...new Set(p.hand.filter((c) => c.isCreature))];
        if (!creatures.length) break;
        const pick = yield* this.choose(p, 'cheat', 'Put a creature from your hand onto the battlefield?', creatures.map((card) => ({ label: card.name, card })), 0, 1);
        if (!pick.length) break;
        const card = creatures[pick[0]];
        p.hand.splice(p.hand.indexOf(card), 1);
        this.say(`${p.name} puts ${card.name} onto the battlefield.`);
        yield* this.enter(p, card, p.deck.commanders.includes(card), 0, null);
        break;
      }
      case 'scry': {
        // Enhanced Surveillance: look at two more cards each time you surveil.
        const top = p.library.slice(0, e.n + (e.surveil && this.kindsInGame.has('surveilBoost') ? this.staticsOf('surveilBoost').filter((s) => s.perm.seat === p.seat).reduce((k, s) => k + s.e.n, 0) : 0));
        if (!top.length) break;
        const where = e.surveil ? 'into your graveyard' : 'on the bottom of your library';
        const picks = yield* this.choose(p, 'scry', `${e.surveil ? 'Surveil' : 'Scry'} ${top.length}: choose the cards to put ${where}. The rest stay on top.`, top.map((card) => ({ label: card.name, card })), 0, top.length);
        const away = picks.map((i) => top[i]);
        for (const card of away) {
          p.library.splice(p.library.indexOf(card), 1);
          if (e.surveil) this.toGraveyard(p, card, false);
          else p.library.push(card);
        }
        this.say(`${p.name} ${e.surveil ? 'surveils' : 'scries'} ${top.length}${away.length ? ` and puts ${away.length} ${where.replace('your', 'their')}` : ''}.`);
        if (e.surveil) this.fire(p, 'surveil');
        break;
      }
      case 'mill': {
        const victims = e.who === 'you' ? [p] : e.who === 'opponents' ? this.opponents(p) : e.who === 'all' ? this.alivePlayers() : target?.kind === 'player' && this.players[target.seat].alive ? [this.players[target.seat]] : [];
        for (const v of victims) {
          const count = e.n === -2 ? Math.ceil(v.library.length / 2) : e.n === -1 ? Math.max(x, 1) : e.n === -3 ? Math.max(x, 1) * 2 : e.n;
          this.millCards(v, count, e.untilLands);
          if (count && v !== p) v.milledBy = p.seat;
        }
        break;
      }
      case 'discard': {
        const victims = e.who === 'opponents' ? this.opponents(p) : target?.kind === 'player' && this.players[target.seat].alive ? [this.players[target.seat]] : [];
        for (const v of victims) {
          const count = Math.min(e.n, v.hand.length);
          if (!count) continue;
          const picks = yield* this.choose(v, 'discard', `Discard ${count} card${count > 1 ? 's' : ''}.`, v.hand.map((card) => ({ label: card.name, card })), count, count);
          const gone = picks.map((i) => v.hand[i]);
          for (const card of gone) {
            v.hand.splice(v.hand.indexOf(card), 1);
            this.discarded(v, card);
          }
          this.say(`${v.name} discards ${gone.map((c) => c.name).join(', ')}.`);
          // Megrim, Waste Not: once for each card discarded.
          if (this.kindsInGame.has('when:opponentDiscard')) for (let i = 0; i < gone.length; i++) this.fireOpponents(v, 'opponentDiscard', 1);
          if (v !== p) this.discardedByOpponent(v, gone);
        }
        break;
      }
      case 'monarch': {
        // Garland: a target opponent becomes the monarch instead.
        const who = e.opponent ? (target?.kind === 'player' ? this.players[target.seat] : null) : p;
        if (who?.alive) this.setMonarch(who);
        break;
      }
      case 'exchangeLife': {
        // "You may": only worth it with an opponent above you on life.
        const foe = this.opponents(p).filter((o) => o.alive).sort((a, b) => b.life - a.life)[0];
        if (!foe || foe.life <= p.life) break;
        const [mine, theirs] = [p.life, foe.life];
        p.life = theirs;
        foe.life = mine;
        this.say(`${p.name} exchanges life totals with ${foe.name}: ${p.name} goes to ${theirs}, ${foe.name} to ${mine}.`);
        break;
      }
      case 'extraTurn': {
        // "Take two extra turns after this one": both come right after this turn, before any added earlier (rule 500.7).
        const times = e.n ?? 1;
        this.extraTurns.unshift(...Array(times).fill(p.seat));
        this.say(`${p.name} will take ${times > 1 ? `${times} extra turns` : 'an extra turn'}.`);
        break;
      }
      case 'extraPhase':
        // Sphinx of the Second Sun: untap, upkeep and draw again, then the end phase; no further main phase (rule 500.8).
        if (this.activeSeat === p.seat && this.extraBeginnings < 3) {
          this.extraBeginnings++;
          this.phases.unshift('beginning');
          this.say(`${p.name} gets an additional beginning phase.`);
        }
        break;
      case 'emblem': {
        // An emblem (rule 114): kept with the player's permanents so its abilities work, but nothing can touch it.
        const emblem = this.makePerm(p, e.card, true);
        emblem.emblem = true;
        emblem.sick = false;
        p.battlefield.push(emblem);
        this.say(`${p.name} gets an emblem: ${e.card.notes.filter((t) => !/^Not read/.test(t)).join('; ') || e.card.name}.`);
        break;
      }
      case 'artifactToken': {
        const made = this.makeArtifactTokens(p, e.token, n(e.n), e.size === -1 ? x : e.size ?? 0);
        // Peregrin Took, Academy Manufactor: token replacements for Food.
        if (e.token === 'food') yield* this.tokensMade(p, made, 'food');
        break;
      }
      case 'hatch': {
        const egg = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (egg && egg.seat === p.seat && isIncubator(egg.card)) yield* this.transform(p, { kind: 'transform', when: 'resolve' }, egg);
        break;
      }
      case 'flashGrant':
        // Static grants are checked where spells are cast; from a spell or loyalty ability, it lasts a while.
        if (e.when === 'static') break;
        (p.flashGrants ??= []).push({ what: e.what, until: e.until ?? 'turn', turn: this.turnNumber });
        this.say(`${p.name} may cast ${e.what === 'all' ? 'spells' : `${e.what} spells`} as though they had flash ${e.until === 'yourNextTurn' ? 'until their next turn' : 'this turn'}.`);
        break;
      case 'playHidden': {
        // Hideaway: play the card exiled with the source for free, if the condition holds (rule 702.75).
        if (!src?.hidden || !this.hiddenPlayable(p, e)) break;
        const hidden = src.hidden;
        src.hidden = undefined;
        this.pendingCasts.push({ seat: p.seat, card: hidden, why: 'hideaway' });
        break;
      }
      case 'plotFromHand': {
        // Jace Reawakened: exile a cheap nonland card from hand; it becomes plotted (rule 702.170).
        const options = p.hand.filter((c) => !c.isLand && c.cmc <= e.maxCmc);
        if (!options.length) break;
        const pick = options.length === 1 ? [0] : yield* this.choose(p, 'exileCard', `Plot which card from your hand?`, options.map((c) => ({ label: c.name, card: c })), 1, 1);
        const plotted = options[pick[0] ?? 0];
        p.hand.splice(p.hand.indexOf(plotted), 1);
        (p.held ??= []).push({ card: plotted, way: 'plot', turn: this.turnNumber });
        this.say(`${p.name} plots ${plotted.name}.`);
        break;
      }
      case 'approach': {
        // A copy wasn't cast, so it neither wins nor counts as the first cast (rule 707.10).
        if (this.resolving?.copy) {
          p.life += 7;
          this.say(`${p.name} gains 7 life (a copy of Approach of the Second Sun).`);
          break;
        }
        const times = (this.approachCasts.get(p.seat) ?? 0) + 1;
        this.approachCasts.set(p.seat, times);
        if (times >= 2) {
          this.say(`${p.name} casts Approach of the Second Sun for the second time and wins the game.`);
          for (const o of this.opponents(p)) {
            o.shielded = false;
            this.loseLife(o, o.life, p, 'noncombat');
          }
        } else {
          p.life += 7;
          this.tuckSpell = true;
          this.say(`${p.name} gains 7 life and puts Approach of the Second Sun seventh from the top of their library.`);
        }
        break;
      }
      case 'goad': {
        if (e.weaker) break;
        if (e.all) {
          for (const o of this.opponents(p)) for (const q of o.battlefield) if (q.card.isCreature) this.goad(q, p);
          this.say(`${p.name} goads every creature their opponents control.`);
          break;
        }
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm) break;
        this.goad(perm, p);
        if (e.tap) perm.tapped = true;
        this.say(`${perm.card.name} (${this.players[perm.seat].name}) is ${e.tap ? 'tapped and ' : ''}goaded.`);
        break;
      }
      case 'forceAttack':
        this.attackOrders.push({ seat: p.seat, kind: 'force', amount: 0, until: e.until === 'turn' ? 'turn' : 'nextTurn', turn: this.turnNumber });
        this.say(`Creatures ${p.name}'s opponents control must attack ${e.until === 'turn' ? 'this turn' : `until ${p.name}'s next turn`}.`);
        break;
      case 'tempAttackTax':
        this.attackOrders.push({ seat: p.seat, kind: 'tax', amount: e.amount, until: 'nextTurn', turn: this.turnNumber });
        this.say(`Until ${p.name}'s next turn, creatures pay ${e.amount} each to attack them.`);
        break;
      case 'pacify': {
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm) break;
        if (e.attack) perm.tempKw.push("can't attack");
        if (e.block) perm.tempKw.push("can't block");
        this.say(`${perm.card.name} (${this.players[perm.seat].name}) can't ${e.attack && e.block ? 'attack or block' : e.attack ? 'attack' : 'block'} this turn.`);
        break;
      }
      case 'suspect': {
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (perm) {
          perm.suspected = true;
          this.say(`${perm.card.name} (${this.players[perm.seat].name}) is suspected.`);
        }
        if (e.thenGoad) for (const q of this.allPerms()) if (q.suspected && q.card.isCreature) this.goad(q, p);
        break;
      }
      case 'returnBlocked': {
        // Grazilaxx: the blocked creature goes back to hand, out of the fight (rule 506.4).
        const perm = this.findPerm(this.resolving?.subject ?? null);
        if (!perm || perm.seat !== p.seat || perm.attacking === null) break;
        // "You may": only a nontoken creature the block would kill (a token returned to hand is gone).
        const foes = this.blockersOf(perm);
        const dies = foes.reduce((n, b) => n + this.power(b), 0) >= this.toughness(perm) - perm.damage || foes.some((b) => this.hasKw(b, 'deathtouch'));
        if (perm.token || !dies || this.hasKw(perm, 'indestructible')) break;
        this.say(`${perm.card.name} is blocked and returns to ${this.players[perm.owner ?? perm.seat].name}'s hand.`);
        for (const b of this.blockersOf(perm)) b.blocking = null;
        this.removePerm(perm, 'hand');
        break;
      }
      case 'punishDefender': {
        const attacker = this.findPerm(this.resolving?.subject ?? null) ?? src;
        const seat = attacker?.attacking;
        if (!attacker || seat === null || seat === undefined) break;
        const defender = this.players[seat];
        if (!defender.alive) break;
        if (e.what === 'graveyard') {
          const lost = this.loseLife(defender, e.n * defender.graveyard.length, p, 'noncombat');
          this.say(`${defender.name} loses ${lost} life (${defender.graveyard.length} cards in their graveyard).`);
        } else {
          // Dauthi Mindripper: sacrifice it, and they discard.
          if (!p.battlefield.includes(attacker)) break;
          this.removePerm(attacker, 'graveyard');
          this.sacrificed(p);
          this.say(`${p.name} sacrifices ${attacker.card.name}.`);
          yield* this.resolveEffect(p, { kind: 'discard', n: e.n, who: 'target', when: 'resolve' } as Effect, src, x, { kind: 'player', seat }, card);
        }
        break;
      }
      case 'protectColor': {
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm) break;
        const color = this.threatColor(perm);
        perm.tempKw.push(`pro:${color}`);
        this.kindsInGame.add('protection');
        this.say(`${perm.card.name} gains protection from ${({ W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' } as Record<string, string>)[color]} until end of turn.`);
        break;
      }
      case 'blink': {
        const first = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        const chosen = first ? [first] : [];
        if (e.n > 1) {
          const more = p.battlefield.filter((q) => q !== first && this.blinkable(p, q, e));
          const picks = yield* this.choose(p, 'blink', `Exile and return up to ${e.n - chosen.length} more permanent${e.n - chosen.length > 1 ? 's' : ''}?`, more.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 0, e.n - chosen.length);
          chosen.push(...picks.map((i) => more[i]));
        }
        for (const perm of chosen) yield* this.blinkPerm(perm);
        break;
      }
      case 'untap': {
        let list: Perm[];
        if (e.what === 'self') list = src && p.battlefield.includes(src) ? [src] : [];
        else if (e.what === 'permanent') {
          const tapped = p.battlefield.filter((q) => q.tapped);
          const picks = yield* this.choose(p, 'untap', `Untap up to ${e.n} permanent${e.n > 1 ? 's' : ''}.`, tapped.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 0, e.n);
          list = picks.map((i) => tapped[i]);
        } else {
          list = p.battlefield.filter((q) => q.tapped && (e.what === 'lands' ? !!q.landInfo : e.what === 'creatures' ? q.card.isCreature : e.what === 'artifacts' ? q.card.isArtifact : !q.landInfo)).slice(0, e.n);
        }
        for (const q of list) q.tapped = false;
        if (list.length) this.say(`${p.name} untaps ${list.length === 1 ? list[0].card.name : `${list.length} permanents`}.`);
        break;
      }
      case 'loyaltyUp':
        if (src && src.loyalty !== undefined && p.battlefield.includes(src)) {
          src.loyalty += e.n;
          this.say(`${src.card.name} gets ${e.n} loyalty (${src.loyalty}).`);
        }
        break;
      case 'doubleCounters': {
        const total = (q: Perm) => Math.max(0, q.counters) + (q.charge ?? 0) + (q.loyalty ?? 0);
        const mine = p.battlefield.filter((q) => total(q) > 0);
        const list = e.on === 'yours' ? mine : mine.sort((a, b) => total(b) - total(a)).slice(0, 1);
        for (const q of list) {
          if (q.counters > 0) this.putCounters(q, q.counters);
          if (q.charge) this.addCharge(q, q.charge);
          if (q.loyalty) q.loyalty *= 2;
        }
        if (list.length) this.say(`${p.name} doubles the counters on ${list.map((q) => q.card.name).join(', ')}.`);
        break;
      }
      case 'winGame':
        if (!this.over) this.winGame(p, card?.name ?? src?.card.name ?? 'an ability');
        break;
      case 'loseGame': {
        // The player the trigger is about (the one dealt combat damage), else the opponent closest to losing.
        const about = this.resolving?.subject;
        const v = about !== undefined && this.players[about] ? this.players[about] : [...this.opponents(p)].sort((a, b) => a.life - b.life)[0];
        if (!v || !v.alive || v === p) break;
        this.say(`${v.name} loses the game (${card?.name ?? src?.card.name ?? 'an ability'}).`);
        v.life = Math.min(v.life, 0);
        v.lastHitBy = p.seat;
        v.lastHitKind = 'noncombat';
        break;
      }
      case 'extraCombat': {
        // Only during the turn's own combat or main phases; a cap keeps loops (Aurelia with Lightning Runner) finite.
        const inCombat = ['beginCombat', 'declareAttackers', 'declareBlockers', 'combatDamage', 'endCombat'].includes(this.step);
        if (e.inCombat && (!inCombat || this.activeSeat !== p.seat)) break;
        if (e.firstOnly && this.combatsThisTurn > 1) break;
        if (e.untapAttacked) this.untapAttackersEachCombat = true;
        const room = Math.max(0, 6 - this.combatsThisTurn - this.phases.filter((ph) => ph === 'combat').length);
        const n = Math.min(e.n, room);
        if (!n) break;
        const added: ('combat' | 'main')[] = [];
        for (let i = 0; i < n; i++) added.push('combat');
        if (e.main) added.push('main');
        if (e.after === 'lastMain') this.phases.push(...added);
        else this.phases.unshift(...added);
        this.say(`There ${n === 1 ? 'is an additional combat phase' : `are ${n} additional combat phases`} this turn${e.main ? ', followed by an additional main phase' : ''}.`);
        break;
      }
      case 'copySpell': {
        if (e.toSource) {
          yield* this.copyToSource(p, src);
          break;
        }
        const id = e.what === 'trigger' ? this.resolving?.subject : target?.kind === 'stack' ? target.id : undefined;
        const orig = this.stack.find((s) => s.id === id);
        if (!orig) break;
        // Wandering Archaic: the caster may pay {2} to stop the copy.
        if (e.unlessPay) {
          const caster = this.players[orig.controller];
          const plan = caster.alive ? this.planPayment(caster, NO_COST, e.unlessPay, 0) : null;
          if (plan) {
            const pay = yield* this.choose(caster, 'payCost', `Pay {${e.unlessPay}} so ${card?.name ?? 'it'} doesn't copy ${orig.label}?`, [{ label: `Pay {${e.unlessPay}}`, card: orig.card }], 0, 1);
            if (pay.length) {
              this.commitPayment(caster, plan);
              this.say(`${caster.name} pays {${e.unlessPay}}.`);
              break;
            }
          }
        }
        yield* this.copyItem(p, orig, true, e.nonlegendary);
        break;
      }
      case 'tokenCopy':
        yield* this.tokenCopies(p, e, src, x, target);
        break;
      case 'becomeCopy': {
        if (!src || !this.players[src.seat].battlefield.includes(src)) break;
        let model: SimCard | null = null;
        let other: Perm | null = null;
        if (e.of === 'target') {
          other = target?.kind === 'perm' ? this.findPerm(target.id) : null;
          model = other ? (other.faceDown ? other.card : other.unlocked ?? other.card) : null;
        } else if (e.of === 'graveyard') {
          // Lazav, the Multifarious: a creature card in your graveyard with mana value X.
          const pool = p.graveyard.filter((c) => c.isCreature && c.cmc === x);
          if (pool.length) model = pool.reduce((a, b) => (b.value > a.value ? b : a));
        } else model = this.resolving?.about?.card ?? null;
        if (!model) break;
        this.becomeCopyOf(src, model, e);
        // Gogo: it and the creature it copied each get +2/+0 and haste until end of turn.
        if (e.pump) for (const q of [src, other]) if (q) {
          q.tempP += e.pump;
          q.tempKw.push('haste');
        }
        break;
      }
      case 'takeCard': {
        // "Return that card to the battlefield under your control": the card the trigger is about, wherever it went.
        const about = this.resolving?.about;
        if (!about || (e.samurai && !/\bSamurai\b/.test(about.card.typeLine)) || (e.shrunk && !about.shrunk)) break;
        const owner = this.players[about.owner];
        const zone = owner.graveyard.includes(about.card) ? owner.graveyard : owner.exile.includes(about.card) ? owner.exile : null;
        if (!zone || about.card.isInstant || about.card.isSorcery) break;
        zone.splice(zone.indexOf(about.card), 1);
        this.say(`${p.name} puts ${about.card.name}${owner !== p ? ` (${owner.name}'s)` : ''} onto the battlefield under their control.`);
        if (about.card.isLand && about.card.land) {
          this.putLand(p, about.card, about.card.land);
          const land = p.battlefield[p.battlefield.length - 1];
          if (land?.card === about.card && owner !== p) land.owner = owner.seat;
          break;
        }
        const perm = yield* this.enter(p, about.card, false, 0, null, owner);
        if (perm) this.lastAffected = perm;
        break;
      }
      case 'redirect':
        yield* this.redirectItem(p, e, src, target);
        break;
      case 'copyNext':
        p.copyNext = e.until;
        this.say(e.until === 'turn' ? `${p.name} will copy every spell they cast this turn.` : `${p.name} will copy the next instant or sorcery they cast this turn.`);
        break;
      case 'ringTempts':
        this.ringTempts(p);
        break;
      case 'curse':
        yield* this.resolveCurse(p, e, src, this.players[x] ?? p);
        break;
      case 'passCurse': {
        // Lynde: move a Curse attached to you onto an opponent; if one moved, draw.
        const mine = this.cursesOn(p);
        const opponents = this.opponents(p);
        if (!mine.length || !opponents.length) break;
        // The Curse that hurts its holder most goes first.
        const harm = (q: Perm) => Math.max(...q.card.curse!.map((c) => CURSE_HARM[c.act]));
        const curse = mine.reduce((a, b) => (harm(b) > harm(a) ? b : a));
        const t = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `Move ${curse.card.name} onto which opponent?`, card: curse.card, effect: e, candidates: opponents.map((o) => ({ kind: 'player', seat: o.seat })), cancellable: true });
        if (!t || t.kind !== 'player' || !opponents.includes(this.players[t.seat])) break;
        this.moveCurse(curse, this.players[t.seat]);
        this.draw(p, e.n);
        break;
      }
      case 'lore': {
        const saga = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (saga && saga.seat === p.seat && saga.card.saga) this.addLore(p, saga);
        break;
      }
      case 'blight': {
        const land = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (land) this.blight(land);
        break;
      }
      // --- Lockouts, animation, winning and losing (classifyLocks.ts) ---
      case 'silence':
        for (const o of this.opponents(p)) this.silenced.add(o.seat);
        this.say(`${p.name}'s opponents can't cast spells this turn.`);
        break;
      case 'blank': {
        const q = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        // "For as long as ~ remains on the battlefield": with the source gone, the effect lasts no time at all.
        if (!q || (e.until === 'source' && !src)) break;
        const before = q.card.name;
        this.blankPerm(q, e.until === 'source' ? src!.id : -3, q.card.isCreature ? e.size : undefined);
        if (e.until === 'yourNextTurn') q.blankUntil = p.seat;
        this.say(`${before} loses all abilities${e.until === 'source' ? ` while ${src!.card.name} stays` : ' until ' + p.name + "'s next turn"}.`);
        break;
      }
      case 'slime': {
        const q = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (q && !this.countersBlocked(q)) {
          q.slime = true;
          this.say(`${q.card.name} gets a slime counter.`);
        }
        break;
      }
      case 'becomeCreature':
        yield* this.becomeCreature(p, e, src, target);
        break;
      case 'becomeArtifact': {
        const q = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!q || q.card.isArtifact) break;
        q.uncrewed ??= q.card;
        q.card = { ...q.card, isArtifact: true };
        this.say(`${q.card.name} becomes an artifact until end of turn.`);
        break;
      }
      case 'becomeTreasure': {
        const q = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!q) break;
        // ≈ The permanent stays on the battlefield as a Treasure: here it leaves without dying and its controller gets a Treasure.
        const holder = this.players[q.seat];
        const owner = this.players[q.owner ?? q.seat];
        const card = realCard(q);
        this.removePerms([q], 'exile');
        const i = owner.exile.lastIndexOf(card);
        if (i !== -1 && !q.isCommander) owner.graveyard.push(...owner.exile.splice(i, 1));
        holder.treasures++;
        this.say(`${card.name} becomes a Treasure.`);
        break;
      }
      case 'winIf': {
        const counters = (src?.counters ?? 0) + (src?.charge ?? 0);
        const met = e.cond === 'treasures' ? p.treasures >= e.n
          : e.cond === 'artifacts' ? artifactCount(p) >= e.n
          : e.cond === 'handExactly' ? p.hand.length === e.n
          : counters >= e.n || p.hand.length >= (e.orHand ?? Infinity);
        if (met && !this.over) this.winGame(p, card?.name ?? src?.card.name ?? 'an ability');
        break;
      }
      case 'pact':
        this.pacts.push({ seat: p.seat, cost: e.cost, name: card?.name ?? 'a Pact' });
        break;
      case 'animate': {
        const ench = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (ench && ench.seat === p.seat) this.animate(ench);
        break;
      }
      case 'shuffleWhenTargeted':
        if (src && this.players[src.seat].battlefield.includes(src)) {
          this.say(`${src.card.name} is shuffled into ${this.players[src.owner ?? src.seat].name}'s library.`);
          this.removePerm(src, 'library');
        }
        break;
      case 'copyOnDiscard': {
        // Orvar: a token copy of target permanent.
        const options = this.allPerms().filter((q) => this.canTarget(p, q) && !q.card.isLegendary);
        if (!options.length) break;
        const [pick] = yield* this.choose(p, 'clone', `${card?.name ?? 'Orvar'}: create a token copy of which permanent?`, options.map((q) => ({ label: `${q.card.name} (${this.players[q.seat].name})`, card: q.card, permId: q.id })), 1, 1);
        const model = options[pick ?? 0];
        this.say(`${p.name} creates a token copy of ${model.card.name}.`);
        const made = yield* this.enter(p, model.card, false, 0, null, undefined, 'token');
        if (made && model.landInfo) made.landInfo = model.landInfo;
        break;
      }
      case 'experience':
        if (this.countersBlocked()) break;
        p.experience++;
        this.say(`${p.name} gets an experience counter (${p.experience}).`);
        break;
      case 'energy':
        this.gainEnergy(p, e.n === -1 ? x : e.n);
        break;
      case 'charge': {
        const amount = n(e.n) * 2 ** this.doublers(p, 'counters');
        if (amount <= 0) break;
        let on = e.target ? null : src && p.battlefield.includes(src) ? src : null;
        if (e.target) {
          // Another artifact you control: the one that does the most with charge counters.
          const options = p.battlefield.filter((q) => q.card.isArtifact && q !== src).sort((a, b) => chargeUse(b.card) - chargeUse(a.card));
          if (!options.length) break;
          // Inspirit: a +1/+1 counter on an artifact creature instead, when no artifact does anything with charge counters.
          const body = e.orCounter && chargeUse(options[0].card) === 0 ? options.filter((q) => q.card.isCreature).sort((a, b) => this.power(b) - this.power(a))[0] : undefined;
          if (body) {
            if (!this.countersBlocked(body)) body.counters += 2 ** this.doublers(p, 'counters');
            this.say(`${body.card.name} gets a +1/+1 counter.`);
            break;
          }
          const pick = options.length === 1 ? [0] : yield* this.choose(p, 'counters', `Put ${amount} charge counter${amount > 1 ? 's' : ''} on which artifact?`, options.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
          on = options[pick[0] ?? 0];
        }
        if (!on) break;
        this.addCharge(on, amount);
        break;
      }
      case 'fog':
        if (e.who === 'all') {
          this.fogAll = true;
          this.say(`${p.name} prevents all combat damage this turn.`);
        } else if (e.who === 'you' && e.bounce) {
          // Aetherize: the creatures attacking you go back to their owners' hands.
          const coming = this.attackers().filter((q) => q.attacking === p.seat);
          // Aetherspouts: into their owners' libraries instead.
          if (coming.length) this.removePerms(coming, e.tuck ? 'library' : 'hand');
          this.say(`${p.name} puts ${coming.length} attacking creature${coming.length === 1 ? '' : 's'} into ${e.tuck ? (coming.length === 1 ? "its owner's library" : "their owners' libraries") : coming.length === 1 ? "its owner's hand" : "their owners' hands"}.`);
        } else if (e.who === 'you') {
          p.fogged = { tokens: !!e.tokens };
          this.say(`${p.name} prevents all combat damage to them this turn.`);
        } else {
          const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
          if (!perm) break;
          perm.fogged = true;
          if (e.untap) perm.tapped = false;
          this.say(`Combat damage to and by ${perm.card.name} is prevented this turn.`);
        }
        break;
      case 'landWipe': {
        const lands = this.alivePlayers().flatMap((q) => q.battlefield.filter((l) => l.landInfo && (!e.nonbasic || !l.card.isBasic)));
        this.say(`${p.name} destroys all ${e.nonbasic ? 'nonbasic ' : ''}lands (${lands.length}).`);
        // Impending Disaster is sacrificed as part of it.
        if (src && e.when === 'upkeep' && p.battlefield.includes(src)) {
          this.removePerm(src, 'graveyard');
          this.sacrificed(p, src);
        }
        const lost = new Map<PlayerState, number>();
        for (const l of lands) if (!this.hasKw(l, 'indestructible')) lost.set(this.players[l.seat], (lost.get(this.players[l.seat]) ?? 0) + 1);
        this.removePerms(lands.filter((l) => !this.hasKw(l, 'indestructible')), 'graveyard');
        if (e.replace) for (const [q, n] of lost) this.fetchBasics(q, n, false);
        break;
      }
      case 'landSac':
        for (const q of e.who === 'each' ? this.alivePlayers() : e.who === 'you' ? [p] : this.opponents(p)) {
          const lands = q.battlefield.filter((l) => l.landInfo);
          const n = e.keep !== undefined ? Math.max(0, lands.length - e.keep) : Math.min(e.n, lands.length);
          if (n <= 0) continue;
          const picks = n >= lands.length ? lands.map((_, i) => i) : yield* this.choose(q, 'sacrifice', `Sacrifice ${n} land${n > 1 ? 's' : ''}.`, lands.map((l) => ({ label: l.card.name, card: l.card, permId: l.id })), n, n);
          const gone = picks.map((i) => lands[i]);
          this.say(`${q.name} sacrifices ${gone.map((l) => l.card.name).join(', ')}.`);
          this.removePerms(gone, 'graveyard');
          for (const l of gone) this.sacrificed(q, l);
        }
        break;
      case 'nonbasicBurn':
        for (const q of this.alivePlayers()) {
          const n = q.battlefield.filter((l) => l.landInfo && !l.card.isBasic).length * e.per;
          const lost = this.loseLife(q, n, q === p ? null : p, 'noncombat');
          if (lost) this.say(`${card?.name ?? 'It'} deals ${lost} damage to ${q.name} for nonbasic lands (life ${q.life}).`);
        }
        break;
      case 'tap': {
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm || perm.tapped) break;
        perm.tapped = true;
        this.say(`${perm.card.name} becomes tapped.`);
        break;
      }
      case 'tapAllies': {
        // Myr Battlesphere: tap the other untapped Myr that aren't attacking; +X/+0 and X damage to the player it attacks.
        if (!src || src.attacking === null) break;
        const allies = p.battlefield.filter((q) => q !== src && !q.tapped && q.attacking === null && hasSubtype(q.card, e.subtype));
        if (!allies.length) break;
        for (const q of allies) q.tapped = true;
        src.tempP += allies.length;
        const victim = this.players[src.attacking];
        const lost = this.loseLife(victim, allies.length, p, 'noncombat');
        this.say(`${p.name} taps ${allies.length} ${e.subtype}: ${src.card.name} gets +${allies.length}/+0 and deals ${lost} damage to ${victim.name} (life ${victim.life}).`);
        break;
      }
      case 'stun': {
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm) break;
        // Archipelagore: "up to X target creatures, where X is the number of times it has mutated". The rest are the
        // opponents' biggest untapped creatures.
        const more = e.n === -1 ? Math.max(0, (src?.parts?.length ?? 2) - 2) : Math.max(0, (e.n ?? 1) - 1);
        const others = more ? this.opponents(p).flatMap((o) => o.battlefield).filter((q) => q !== perm && q.card.isCreature && !q.tapped && this.canTarget(p, q)).sort((a, b) => this.power(b) - this.power(a)).slice(0, more) : [];
        for (const q of [perm, ...others]) {
          if (e.tap) q.tapped = true;
          if (this.countersBlocked(q)) continue;
          q.stun = (q.stun ?? 0) + 1;
          this.say(`${q.card.name} gets a stun counter.`);
        }
        break;
      }
      case 'sacrificeHalf': {
        // Liliana of the Veil: two piles, and that player sacrifices the pile they choose. Here they keep the better half.
        const v = target?.kind === 'player' ? this.players[target.seat] : null;
        if (!v?.alive) break;
        const all = v.battlefield.filter((q) => !q.emblem).sort((a, b) => (b.landInfo ? 1.5 : b.card.value) - (a.landInfo ? 1.5 : a.card.value));
        const gone = all.filter((_, i) => i % 2 === 1);
        this.say(`${v.name} sacrifices half their permanents: ${gone.map((q) => q.card.name).join(', ') || 'nothing'}.`);
        this.removePerms(gone, 'graveyard');
        for (const q of gone) this.sacrificed(v, q);
        break;
      }
      case 'freeFromGraveyard':
        yield* this.castFreeFromGraveyard(p, e);
        break;
      case 'bounty': {
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm || perm.bounty || this.countersBlocked(perm)) break;
        perm.bounty = true;
        if (!e.plain) perm.bountyGrant = true;
        this.say(`${perm.card.name} gets a bounty counter.`);
        break;
      }
      case 'poison': {
        const victims = e.who === 'each' ? this.alivePlayers() : e.who === 'opponents' ? this.opponents(p) : target?.kind === 'player' ? [this.players[target.seat]] : [];
        for (const v of victims) {
          if (!v.alive || v.shielded) continue;
          const more = e.upTo !== undefined ? Math.max(0, e.upTo - v.poison) : e.n;
          if (!more || this.countersBlocked()) continue;
          v.poison += more;
          if (v !== p) {
            v.lastHitBy = p.seat;
            v.lastHitKind = 'noncombat';
          }
          this.say(`${v.name} gets ${more} poison counter${more > 1 ? 's' : ''} (${v.poison} of 10).`);
        }
        break;
      }
      case 'kwCounter': {
        const perm = e.on === 'self' ? (src && p.battlefield.includes(src) ? src : null) : target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm || perm.kwCounters?.includes(e.kw)) break;
        (perm.kwCounters ??= []).push(e.kw);
        this.say(`${perm.card.name} gets ${/^[aeiou]/.test(e.kw) ? 'an' : 'a'} ${e.kw} counter.`);
        break;
      }
      case 'sacrificeOther': {
        const others = p.battlefield.filter((q) => q !== src);
        const options: ChoiceOption[] = others.map((q) => ({ label: q.card.name, card: q.card, permId: q.id }));
        if (p.treasures > 0) options.unshift({ label: 'Treasure' });
        if (!options.length) break;
        const [pick] = yield* this.choose(p, 'sacrifice', `${src?.card.name ?? 'This'}: sacrifice another permanent.`, options, 1, 1);
        const chosen = options[pick ?? 0];
        if (chosen.permId === undefined) p.treasures--;
        else {
          const perm = others.find((q) => q.id === chosen.permId);
          if (!perm) break;
          this.removePerm(perm, 'graveyard');
          this.sacrificed(p, perm);
        }
        this.say(`${p.name} sacrifices ${chosen.label}.`);
        if (chosen.permId === undefined) {
          this.sacrificed(p);
          if (this.kindsInGame.has('when:permDies')) this.permDied(null, p.seat);
        }
        break;
      }
      case 'rollDice': {
        for (let i = 0; i < e.n; i++) {
          const roll = 1 + this.rng.int(6);
          this.say(`${p.name} rolls a ${roll}.`);
          for (const perm of p.battlefield) {
            const hits = perm.card.effects.filter((f) => f.when === 'dieRoll' && roll >= (f.minRoll ?? 1));
            if (hits.length) this.trigger(p, perm.card, perm.id, hits);
          }
        }
        break;
      }
      case 'copyCreature': {
        const pool = p.battlefield.filter((q) => q.card.isCreature && !q.token && q !== src);
        if (!pool.length) break;
        const [pick] = pool.length === 1 ? [0] : yield* this.choose(p, 'clone', `${src?.card.name ?? 'This'}: copy which creature?`, pool.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
        const original = pool[pick ?? 0];
        const copy = this.makePerm(p, original.card, true);
        copy.tapped = true;
        if (src && src.attacking !== null) copy.attacking = src.attacking;
        if (e.temporary) copy.temporary = true;
        p.battlefield.push(copy);
        this.say(`${p.name} makes a token copy of ${original.card.name}${copy.attacking !== null ? ', tapped and attacking' : ''}.`);
        const etb = original.card.effects.filter((f) => f.when === 'resolve');
        if (etb.length) this.trigger(p, original.card, copy.id, etb);
        this.creatureEntered(p, copy);
        break;
      }
      case 'copyPermanent': {
        if (e.monarch && this.monarch !== p.seat) break;
        const pool = this.alivePlayers().flatMap((o) => o.battlefield).filter((q) => (q.card.isArtifact || q.card.isEnchantment) && !q.card.isLegendary && !q.card.isLand && q !== src && q.card.name !== src?.card.name);
        if (!pool.length) break;
        pool.sort((a, b) => b.card.value - a.card.value);
        const [pick] = pool.length === 1 ? [0] : yield* this.choose(p, 'clone', `${src?.card.name ?? 'This'}: copy which permanent?`, pool.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 0, 1);
        if (pick === undefined) break;
        const original = pool[pick];
        const copy = this.makePerm(p, original.card, true);
        p.battlefield.push(copy);
        this.say(`${p.name} makes a token copy of ${original.card.name}.`);
        const etb = original.card.effects.filter((f) => f.when === 'resolve');
        if (etb.length) this.trigger(p, original.card, copy.id, etb);
        if (copy.card.isCreature) this.creatureEntered(p, copy);
        break;
      }
      case 'copySelf': {
        // Token copies of the source (rule 707.2): its printed card, not what kicking it did (Skyclave Relic, offspring).
        const base = src ? src.printed ?? src.faceDown ?? src.card : card;
        if (!base) break;
        // Wedding Ring, Life of the Party: an opponent (or each one) gets the copy. Its "if it was cast" / "if it's not a token" enters ability doesn't happen again.
        if (e.give) {
          const to = e.give === 'each' ? this.opponents(p) : target?.kind === 'player' && this.players[target.seat].alive ? [this.players[target.seat]] : [];
          const given = { ...base, effects: base.effects.filter((f) => !(f.kind === 'copySelf' && f.give)) };
          for (const o of to) {
            const token = yield* this.makeCopyToken(o, given);
            if (!token) continue;
            if (e.goaded) {
              token.goadForever = p.seat;
              this.goad(token, p);
            }
            this.say(`${o.name} gets a token copy of ${base.name}${e.goaded ? ', goaded for the rest of the game' : ''}.`);
          }
          break;
        }
        let copy = e.nonlegendary && base.isLegendary ? this.nonlegendary(base) : base;
        if (e.size !== undefined && copy.isCreature) copy = sized(copy, e.size);
        // Copies that copy themselves (Homunculus Horde, Scute Swarm) double every turn: stop at 40, as the game is decided by then.
        const already = p.battlefield.filter((q) => q.card.name === base.name).length;
        const count = Math.max(0, Math.min(e.n * 2 ** this.doublers(p, 'tokens'), 20, 40 - already));
        for (let i = 0; i < count; i++) {
          const token = this.makePerm(p, copy, true);
          if (e.tapped) token.tapped = true;
          if (copy.loyalty !== undefined) token.loyalty = e.loyalty ?? copy.loyalty;
          p.battlefield.push(token);
          const etb = copy.effects.filter((f) => f.when === 'resolve');
          if (etb.length) this.trigger(p, copy, token.id, etb);
          if (copy.isCreature) this.creatureEntered(p, token);
        }
        if (count > 0) this.say(`${p.name} makes ${count === 1 ? 'a token copy' : `${count} token copies`} of ${base.name}${e.size !== undefined ? ` (${e.size}/${e.size})` : ''}.`);
        if (count > 0) yield* this.tokensMade(p, count, 'copy');
        break;
      }
      case 'shuffleSelf': {
        // A spell (Blue Sun's Zenith) goes into the library instead of the graveyard as it finishes resolving.
        if (!src && this.resolving?.kind === 'spell') {
          this.shuffleSpell = true;
          break;
        }
        if (!src || !this.players[src.seat].battlefield.includes(src)) break;
        this.say(`${src.card.name} is shuffled into its owner's library.`);
        this.removePerm(src, 'library');
        break;
      }
      case 'attachSelf': {
        // Mithril Coat: attached to the best (legendary) creature you control as it enters.
        if (!src || !p.battlefield.includes(src)) break;
        const hosts = p.battlefield.filter((q) => q.card.isCreature && q !== src && (!e.legendary || q.card.isLegendary)).sort((a, b) => b.card.value - a.card.value);
        if (!hosts.length) break;
        src.attachedTo = hosts[0].id;
        this.anyAttached = true;
        this.say(`${src.card.name} is attached to ${hosts[0].card.name}.`);
        break;
      }
      case 'sacrificeSelf': {
        if (!src || !this.players[src.seat].battlefield.includes(src)) break;
        if (e.unlessEscaped && this.escapedPerms.has(src.id)) break;
        this.say(`${this.players[src.seat].name} sacrifices ${src.card.name}.`);
        this.removePerm(src, 'graveyard');
        this.sacrificed(this.players[src.seat], src);
        break;
      }
      case 'revealTop': {
        // Nadu: a land goes onto the battlefield, anything else into your hand.
        const top = p.library.shift();
        if (!top) break;
        this.say(`${p.name} reveals ${top.name}.`);
        if (top.isLand && top.land) this.putLand(p, top, top.land);
        else {
          p.hand.push(top);
          p.drawnNames.add(top.name);
        }
        break;
      }
      case 'hours': {
        if (src && this.players[src.seat].battlefield.includes(src)) this.addHours(src, e.n);
        break;
      }
      case 'wheelAll': {
        // Windfall, Wheel of Fortune: everyone discards their hand, then draws (rule 701.9).
        const players = this.alivePlayers();
        let most = 0;
        for (const q of players) {
          const gone = q.hand.splice(0);
          most = Math.max(most, gone.length);
          for (const card of gone) this.discarded(q, card, true);
          if (gone.length && q !== p && this.kindsInGame.has('when:opponentDiscard')) for (let i = 0; i < gone.length; i++) this.fireOpponents(q, 'opponentDiscard', 1);
        }
        const n = e.n === 'max' ? most : e.n;
        this.say(`Each player discards their hand and draws ${n}.`);
        for (const q of players) if (q.alive) this.draw(q, n);
        break;
      }
      case 'wheel': {
        // Midnight Clock: shuffle your hand (and graveyard) into your library, then draw seven (rule 701.20).
        const back = p.hand.length + (e.graveyard ? p.graveyard.length : 0);
        p.library.push(...p.hand.splice(0));
        if (e.graveyard) p.library.push(...p.graveyard.splice(0));
        this.rng.shuffle(p.library);
        this.say(`${p.name} shuffles ${back} card${back === 1 ? '' : 's'} into their library and draws ${e.n}.`);
        this.draw(p, e.n);
        if (e.exileSelf && src && this.players[src.seat].battlefield.includes(src)) {
          this.say(`${src.card.name} is exiled.`);
          this.removePerm(src, 'exile');
        }
        break;
      }
      // Static effects (mana, anthems, cost reduction, attachments) do nothing on resolution.
      default:
        break;
    }
  }

  private *resolveRemoval(p: PlayerState, e: Extract<Effect, { kind: 'removal' }>, src: Perm | null, x: number, target: Target | null): Flow<void> {
    if (e.each) {
      // Each player chooses their own creature to sacrifice, in turn order (rule 701.21).
      for (const victim of e.each === 'all' ? this.alivePlayers() : this.opponents(p)) {
        const creatures = victim.battlefield.filter((q) => q.card.isCreature);
        if (!creatures.length) continue;
        const pick = creatures.length === 1 ? [0] : yield* this.choose(victim, 'sacrifice', 'Sacrifice a creature.', creatures.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
        const gone = creatures[pick[0] ?? 0];
        this.say(`${victim.name} sacrifices ${gone.card.name}.`);
        this.removePerm(gone, 'graveyard');
        this.sacrificed(victim, gone);
      }
      return;
    }
    if (!target) return;
    const amount = e.amount === -1 ? x : e.amount;

    if (target.kind === 'player') {
      const victim = this.players[target.seat];
      if (!victim.alive) return;
      if (e.mode === 'edict') {
        // The player sacrificing chooses what to sacrifice (rule 701.21).
        const creatures = victim.battlefield.filter((q) => q.card.isCreature);
        if (!creatures.length) return;
        const pick = yield* this.choose(victim, 'sacrifice', 'Sacrifice a creature.', creatures.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
        const gone = creatures[pick[0] ?? 0];
        this.say(`${victim.name} sacrifices ${gone.card.name}.`);
        this.removePerm(gone, 'graveyard');
        this.sacrificed(victim, gone);
      } else {
        const dealt = this.doubledDamage(victim, this.damageAfter(p, this.resolvingCard, src, victim, amount, false), p);
        this.loseLife(victim, dealt, p, 'noncombat');
        this.say(`${p.name} deals ${dealt} damage to ${victim.name} (life ${victim.life}).`);
      }
      return;
    }
    if (target.kind !== 'perm') return;
    const perm = this.findPerm(target.id);
    if (!perm) return;
    const owner = this.players[perm.seat];
    switch (e.mode) {
      case 'destroy':
        this.say(`${perm.card.name} (${owner.name}) is destroyed.`);
        this.destroy(perm);
        // Ghost Quarter, Field of Ruin: the land's controller may search for a basic land.
        if (e.replace && perm.landInfo && !this.findPerm(perm.id)) this.fetchBasics(owner, 1, false);
        break;
      case 'exile':
        this.say(`${perm.card.name} (${owner.name}) is exiled.`);
        this.removePerm(perm, 'exile');
        break;
      case 'bounce':
        this.say(`${perm.card.name} returns to ${owner.name}'s hand.`);
        this.removePerm(perm, 'hand');
        break;
      case 'damage':
        if (e.energyPaid) {
          // Galvanic Discharge: pay just enough energy to kill it, or all of it if that falls short.
          const pay = Math.min(p.energy, Math.max(1, this.toughness(perm) - perm.damage));
          this.payEnergy(p, pay);
          this.hurt(perm, pay, e.shrink, p);
          this.say(`${perm.card.name} (${owner.name}) takes ${pay} damage (${pay} energy paid).`);
          break;
        }
        if (e.shrink) {
          this.hurt(perm, amount, e.shrink, p);
          this.say(`${perm.card.name} (${owner.name}) gets -${amount}/-${amount}.`);
          break;
        }
        {
          const dealt = this.damagePerm(p, this.resolvingCard, src, perm, amount);
          this.hurt(perm, dealt);
          this.say(`${perm.card.name} (${owner.name}) takes ${dealt} damage.`);
        }
        break;
      case 'fight': {
        let fighter = src && src.card.isCreature && p.battlefield.includes(src) ? src : null;
        if (!fighter) {
          const mine = p.battlefield.filter((q) => q.card.isCreature);
          if (!mine.length) return;
          const pick = mine.length === 1 ? [0] : yield* this.choose(p, 'fighter', `Which of your creatures deals damage to ${perm.card.name}?`, mine.map((q) => ({ label: `${q.card.name} (${this.power(q)}/${this.toughness(q)})`, card: q.card, permId: q.id })), 1, 1);
          fighter = mine[pick[0] ?? 0];
        }
        const dealt = this.damagePerm(p, fighter.card, fighter, perm, this.power(fighter));
        this.markDamage(perm, dealt);
        if (dealt > 0 && this.hasKw(fighter, 'deathtouch')) perm.deathtouched = true;
        this.say(`${fighter.card.name} deals ${dealt} damage to ${perm.card.name} (${owner.name}).`);
        break;
      }
    }
  }

  /**
   * Damage, or -N/-N. Indestructible stops destruction by damage but not a
   * toughness of 0 or less (rules 702.12b, 704.5f), so Toxic Deluge kills through Heroic Intervention.
   */
  private hurt(perm: Perm, amount: number, shrink?: 'temp' | 'counters', by: PlayerState | null = null) {
    if (shrink === 'counters') this.minusCounters(perm, amount, by); // -1/-1 counters cancel +1/+1 counters (rule 704.5q)
    else if (shrink === 'temp') {
      perm.tempP -= amount;
      perm.tempT -= amount;
    } else this.markDamage(perm, amount);
  }

  /**
   * Damage dealt to a permanent: a planeswalker loses that much loyalty (rule 120.3c), a battle that much defense (120.3h),
   * and a creature has it marked (120.3e). A creature that is also a planeswalker gets both.
   */
  private markDamage(perm: Perm, amount: number) {
    if (amount <= 0) return;
    if (perm.card.isPlaneswalker && perm.loyalty !== undefined) perm.loyalty = Math.max(0, perm.loyalty - amount);
    if (perm.card.isBattle && perm.defense !== undefined) perm.defense = Math.max(0, perm.defense - amount);
    if (perm.card.isCreature) perm.damage += amount;
  }

  /** Doubling Season and friends: how many times tokens or counters are doubled for `p`. */
  private doublers(p: PlayerState, what: 'tokens' | 'counters'): number {
    let n = 0;
    for (const perm of p.battlefield) for (const e of perm.card.effects) if (e.kind === 'doubler' && e[what]) n++;
    return Math.min(n, 3);
  }

  /** `p` gets energy counters, after Aether Refinery and Izzet Generatorium; "whenever you get {E}" triggers. */
  gainEnergy(p: PlayerState, amount: number) {
    if (amount <= 0 || this.countersBlocked()) return;
    if (this.kindsInGame.has('energyBoost')) {
      for (const perm of p.battlefield) for (const e of perm.card.effects) if (e.kind === 'energyBoost' && e.when === 'static' && e.mult > 1) amount *= e.mult;
      for (const perm of p.battlefield) for (const e of perm.card.effects) if (e.kind === 'energyBoost' && e.when === 'static') amount += e.plus;
    }
    p.energy += amount;
    this.say(`${p.name} gets ${amount} energy (${p.energy}).`);
    if (this.kindsInGame.has('when:energy')) this.fire(p, 'energy', amount);
  }

  private payEnergy(p: PlayerState, amount: number) {
    amount = Math.min(amount, p.energy);
    p.energy -= amount;
    p.energyPaid = (p.energyPaid ?? 0) + amount;
  }

  /** Counters a "remove N counters" cost can take: +1/+1 counters on the source ('self'), or any counters on `p`'s permanents ('any'). */
  counterPool(p: PlayerState, src: Perm, from: 'self' | 'any'): number {
    if (from === 'self') return Math.max(0, src.counters);
    return p.battlefield.reduce((n, q) => n + Math.max(0, q.counters) + (q.charge ?? 0), 0);
  }

  /** Pay a "remove counters" cost: charge counters first (they are spent anyway), then +1/+1 counters on the least useful creature. */
  private removeCountersFrom(p: PlayerState, src: Perm, n: number, from: 'self' | 'any') {
    let left = n;
    if (from === 'self') {
      src.counters -= Math.min(left, Math.max(0, src.counters));
      return;
    }
    for (const q of [...p.battlefield].sort((a, b) => (b.charge ?? 0) - (a.charge ?? 0))) {
      if (left <= 0) break;
      const take = Math.min(left, q.charge ?? 0);
      if (take) {
        q.charge! -= take;
        left -= take;
        this.refreshStation(q);
      }
    }
    for (const q of [...p.battlefield].filter((x) => x.counters > 0).sort((a, b) => this.power(a) - this.power(b))) {
      if (left <= 0) break;
      const take = Math.min(left, q.counters);
      q.counters -= take;
      left -= take;
    }
  }

  /**
   * A creature with a bounty counter died. Mathas's counter carries "each opponent draws a card and gains 2 life";
   * Bounty Board pays the same while it is out; Shay Cormac gets +1/+1 counters.
   */
  private bountyPaid(perm: Perm, controller: PlayerState) {
    const payouts = this.allPerms().flatMap((q) => q.card.effects.filter((e) => e.kind === 'bountyPayout').map((e) => ({ q, e: e as Extract<Effect, { kind: 'bountyPayout' }> })));
    if (perm.bountyGrant || payouts.some(({ e }) => e.what === 'drawGain')) {
      for (const o of this.opponents(controller)) {
        this.draw(o, 1);
        this.gainLife(o, 2);
      }
      this.say(`The bounty on ${perm.card.name} pays out.`);
    }
    for (const { q, e } of payouts) {
      if (e.what !== 'counters' || q === perm) continue;
      this.putCounters(q, e.n * 2 ** this.doublers(this.players[q.seat], 'counters'));
      this.say(`${q.card.name} collects the bounty on ${perm.card.name} (${e.n} +1/+1 counters).`);
    }
  }

  /** Put +1/+1 counters on a permanent: "whenever one or more +1/+1 counters are put on" abilities trigger (Simic Ascendancy, Knighted Myr). */
  /**
   * Solemnity: counters can't be put on artifacts, creatures, enchantments or lands, and players can't get counters.
   * `perm` undefined asks about a player.
   */
  countersBlocked(perm?: Perm): boolean {
    if (!this.kindsInGame.has('noCounters') || this.statics(null, 'noCounters') === 0) return false;
    if (!perm) return true;
    const c = perm.card;
    return c.isArtifact || c.isCreature || c.isEnchantment || c.isLand || !!perm.landInfo;
  }

  /** `by` puts `n` -1/-1 counters on `perm` (they cancel +1/+1 counters, rule 704.5q). Nest of Scarabs counts them. */
  private minusCounters(perm: Perm, n: number, by: PlayerState | null) {
    if (n <= 0 || this.countersBlocked(perm)) return;
    perm.counters -= n;
    if (by && perm.card.isCreature && this.kindsInGame.has('when:minusCounters')) this.fire(by, 'minusCounters', n);
  }

  putCounters(perm: Perm, n: number) {
    if (n <= 0 || this.countersBlocked(perm)) return;
    perm.counters += n;
    if (!this.kindsInGame.has('when:countersPut')) return;
    const p = this.players[perm.seat];
    for (const q of p.battlefield) {
      const hits = q.card.effects.filter((e) => e.when === 'countersPut' && (e.scope === 'self' ? q === perm : perm.card.isCreature));
      if (hits.length) this.trigger(p, q.card, q.id, hits, n);
    }
  }

  /** Put charge (quest, oil ...) counters on a permanent: station thresholds, charge wins and the like follow. */
  addCharge(perm: Perm, n: number) {
    if (n > 0 && this.countersBlocked(perm)) return;
    perm.charge = (perm.charge ?? 0) + n;
    const name = (perm.printed ?? perm.card).counterName ?? 'charge';
    this.say(`${perm.card.name} gets ${n} ${name} counter${n > 1 ? 's' : ''} (${perm.charge}).`);
    this.chargeWins(perm);
  }

  /** Whether stationing this permanent still reaches a threshold it hasn't got to yet. */
  stationRoom(perm: Perm): boolean {
    const st = (perm.printed ?? perm.card).station;
    if (!st) return false;
    const top = Math.max(st.creatureAt ?? 0, ...st.tiers.map((t) => t.n));
    return (perm.charge ?? 0) < top;
  }

  /** The other untapped creatures that could station this permanent, strongest first (summoning sickness doesn't matter, rule 302.6). */
  stationCrew(p: PlayerState, perm: Perm): Perm[] {
    return p.battlefield.filter((q) => q !== perm && q.card.isCreature && !q.tapped && this.power(q) > 0).sort((a, b) => this.power(b) - this.power(a));
  }

  private stationCards = new WeakMap<SimCard, Map<number, SimCard>>();
  /** Station (rule 702.184c): the abilities of every threshold the charge counters reach; a Spacecraft is a creature from `creatureAt`. */
  private refreshStation(perm: Perm) {
    const base = perm.printed ?? perm.card;
    const st = base.station;
    if (!st) return;
    const charge = perm.charge ?? 0;
    const reached = st.tiers.filter((t) => t.n <= charge);
    const creature = st.creatureAt !== undefined && charge >= st.creatureAt;
    const key = reached.length * 2 + (creature ? 1 : 0);
    let cache = this.stationCards.get(base);
    if (!cache) this.stationCards.set(base, (cache = new Map()));
    let card = cache.get(key);
    if (!card) {
      card = key === 0 ? base : {
        ...base,
        isCreature: base.isCreature || creature,
        keywords: [...base.keywords, ...reached.flatMap((t) => t.keywords)],
        effects: [...base.effects, ...reached.flatMap((t) => t.effects)],
      };
      cache.set(key, card);
    }
    if (perm.card === card) return;
    const was = perm.card;
    perm.printed = base;
    perm.card = card;
    for (const e of card.effects) {
      this.kindsInGame.add(e.kind);
      this.kindsInGame.add(`when:${e.when}`);
    }
    if (card.isCreature && !was.isCreature) this.say(`${base.name} is now a ${card.power}/${card.toughness} artifact creature.`);
    else if (card.effects.length > was.effects.length || card.keywords.length > was.keywords.length) this.say(`${base.name} reaches its ${Math.max(...reached.map((t) => t.n))}+ station threshold.`);
  }

  /** Darksteel Reactor: twenty charge counters win the game. */
  private chargeWins(perm: Perm) {
    this.refreshStation(perm);
    for (const e of perm.card.effects) {
      if (e.kind === 'chargeWin' && (perm.charge ?? 0) >= e.n) {
        const p = this.players[perm.seat];
        if (p.alive && !this.over) this.winGame(p, `${perm.card.name} has ${perm.charge} charge counters`);
      }
    }
  }

  /** `p` may search for up to `n` basic lands and put them onto the battlefield (Ghost Quarter, From the Ashes). */
  private fetchBasics(p: PlayerState, n: number, tapped: boolean) {
    let found = 0;
    for (let i = 0; i < n; i++) {
      const land = p.library.find((c) => c.isBasic && c.land);
      if (!land) break;
      p.library.splice(p.library.indexOf(land), 1);
      this.putLand(p, land, land.land!, tapped);
      found++;
    }
    if (found) {
      this.rng.shuffle(p.library);
      this.say(`${p.name} searches for ${found} basic land${found > 1 ? 's' : ''}.`);
    }
  }

  gainLife(p: PlayerState, amount: number) {
    if (amount <= 0) return;
    if (this.kindsInGame.has('lifeRule')) amount = this.lifeGained(p, amount);
    if (amount <= 0) return;
    p.life += amount;
    this.fire(p, 'gainLife', amount);
  }

  /** Returns the life actually lost (none while the player is protected). */
  loseLife(p: PlayerState, amount: number, source: PlayerState | null, kind: LossReason): number {
    if (amount <= 0 || p.shielded) return 0;
    // Phyrexian Unlife: at 0 or less life, damage is dealt as poison counters (≈ all life loss is).
    if (p.life <= 0 && this.kindsInGame.has('cantLose') && p.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'cantLose' && e.infect && e.when === 'static'))) {
      if (!this.countersBlocked()) p.poison += amount;
      if (source && source !== p) {
        p.lastHitBy = source.seat;
        p.lastHitKind = kind;
      }
      this.say(`${p.name} gets ${amount} poison counter${amount > 1 ? 's' : ''} instead (poison ${p.poison}).`);
      return amount;
    }
    p.life -= amount;
    this.lifeLostThisTurn[p.seat] += amount;
    p.lostLifeTurn = this.turnNumber;
    if (source && source !== p) {
      p.lastHitBy = source.seat;
      p.lastHitKind = kind;
    }
    // Exquisite Blood: "whenever an opponent loses life" (x = how much).
    if (this.kindsInGame.has('when:opponentLoseLife')) this.fireOpponents(p, 'opponentLoseLife', amount);
    // Mindcrank: mill that many.
    if (this.kindsInGame.has('lifeLossMill')) {
      for (const o of this.opponents(p)) {
        const n = this.statics(o, 'lifeLossMill');
        if (!n) continue;
        this.millCards(p, amount * n);
        p.milledBy = o.seat;
      }
    }
    return amount;
  }

  // -------------------------------------------------------------------------
  // Permanents: characteristics, leaving the battlefield
  // -------------------------------------------------------------------------

  /** Anthems `target`'s controller has. Lords ("other creatures you control") don't pump themselves. */
  private anthemBonus(target: Perm): { p: number; t: number } {
    let p = 0;
    let t = 0;
    for (const { perm, e } of this.anthemsOf(target.seat)) {
      if (this.anthemApplies(e, target, perm) && !(e.other && perm === target) && this.chargeOn(perm, e)) {
        const times = e.perCharge ? perm.charge ?? 0 : 1;
        p += e.p * times;
        t += e.t * times;
      }
    }
    // Elesh Norn, Grand Cenobite: "creatures your opponents control get -2/-2".
    if (this.kindsInGame.has('oppAnthem')) for (const o of this.opponents(this.players[target.seat])) for (const q of o.battlefield) for (const e of q.card.effects) {
      if (e.kind === 'oppAnthem' && e.when === 'static') {
        p += e.p;
        t += e.t;
      }
    }
    // Curse of Death's Hold: creatures the enchanted player controls get -1/-1.
    if (this.anyCurse) for (const c of this.cursedBy(this.players[target.seat], 'shrink')) {
      p -= c.n;
      t -= c.n;
    }
    return { p, t };
  }

  /** Anthem abilities on the permanents a seat controls, in battlefield order. */
  private anthemsOf(seat: number): { perm: Perm; e: Extract<Effect, { kind: 'anthem' }> }[] {
    const m = this.memo;
    const kept = m?.anthems.get(seat);
    if (kept && !verifyMemo) return kept;
    const out: { perm: Perm; e: Extract<Effect, { kind: 'anthem' }> }[] = [];
    if (this.kindsInGame.has('anthem')) for (const perm of this.players[seat].battlefield) for (const e of perm.card.effects) if (e.kind === 'anthem') out.push({ perm, e });
    if (kept) return checkMemo(`anthems of seat ${seat}`, kept, out);
    m?.anthems.set(seat, out);
    return out;
  }

  /** A static ability that needs "N or more charge counters" on its source (Beastmaster Ascension) is on. */
  private chargeOn(src: Perm, e: Effect): boolean {
    return !e.minCharge || (src.charge ?? 0) >= e.minCharge;
  }

  /** Anthems limited to some creatures: enchantment or artifact creatures, or ones you control but don't own. */
  private anthemApplies(e: Extract<Effect, { kind: 'anthem' }>, perm: Perm, src?: Perm): boolean {
    // "Other Elves you control get +1/+1", "creatures you control of the chosen type".
    if (e.subtype && !this.isType(perm, e.subtype, src)) return false;
    if (e.nonlegendary && perm.card.isLegendary) return false;
    switch (e.only) {
      case 'enchantment': return perm.card.isEnchantment;
      case 'artifact': return perm.card.isArtifact;
      case 'stolen': return perm.owner !== undefined && perm.owner !== perm.seat;
      case 'token': return perm.token;
      default: return true;
    }
  }

  /** Kudo: other creatures have this base power and toughness. */
  private baseSize(perm: Perm): { p: number; t: number } {
    if (this.kindsInGame.has('baseSize')) {
      for (const q of this.players) {
        if (!q.alive) continue;
        for (const src of q.battlefield) {
          if (src === perm) continue;
          for (const e of src.card.effects) if (e.kind === 'baseSize') return { p: e.p, t: e.t };
        }
      }
    }
    return { p: perm.card.power, t: perm.card.toughness };
  }

  /** Equipment and Auras attached to `perm`. */
  attachments(perm: Perm): Perm[] {
    if (!this.anyAttached) return NONE;
    const m = this.memo;
    if (m) {
      if (!m.attached) {
        m.attached = new Map();
        for (const q of this.players) for (const other of q.battlefield) {
          if (other.attachedTo === null) continue;
          const list = m.attached.get(other.attachedTo);
          if (list) list.push(other);
          else m.attached.set(other.attachedTo, [other]);
        }
      }
      const kept = m.attached.get(perm.id) ?? NONE;
      return verifyMemo ? checkMemo(`attachments of ${perm.card.name}`, kept, this.attachmentsNow(perm)) : kept;
    }
    return this.attachmentsNow(perm);
  }

  private attachmentsNow(perm: Perm): Perm[] {
    const out: Perm[] = [];
    for (const q of this.players) for (const other of q.battlefield) if (other.attachedTo === perm.id) out.push(other);
    return out;
  }

  /** Doran and Arcades: does this creature deal combat damage with its toughness? */
  private usesToughness(perm: Perm): boolean {
    if (!this.kindsInGame.has('toughnessMatters')) return false;
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const src of q.battlefield) for (const e of src.card.effects) {
        if (e.kind !== 'toughnessMatters') continue;
        if (e.yours && q.seat !== perm.seat) continue;
        if (!e.defenders || perm.card.keywords.includes('defender')) return true;
      }
    }
    return false;
  }

  power(perm: Perm): number {
    const m = this.memo;
    if (!m) return this.powerNow(perm);
    const kept = m.power.get(perm);
    if (kept === undefined) {
      const v = this.powerNow(perm);
      m.power.set(perm, v);
      return v;
    }
    return verifyMemo ? checkMemo(`power of ${perm.card.name}`, kept, this.powerNow(perm)) : kept;
  }

  private powerNow(perm: Perm): number {
    if (perm.card.isCreature && this.usesToughness(perm)) return Math.max(0, this.toughness(perm));
    let p = this.baseSize(perm).p + perm.counters + perm.tempP + this.anthemBonus(perm).p + this.scaled(perm);
    for (const eq of this.attachments(perm)) for (const e of eq.card.effects) if (e.kind === 'equip') p += e.p;
    return Math.max(0, p);
  }

  /** "Power equal to the number of ...": what that number is right now. */
  private scaled(perm: Perm): number {
    const s = perm.card.scales;
    if (!s) return 0;
    const p = this.players[perm.seat];
    switch (s.by) {
      case 'hand': return p.hand.length;
      case 'graveyard': return p.graveyard.length;
      case 'oneGraveyard': return Math.max(0, ...this.opponents(p).map((o) => o.graveyard.length));
      case 'oppGraveyards': return this.opponents(p).reduce((n, o) => n + o.graveyard.length, 0);
      case 'allGraveyardCreatures': return this.players.reduce((n, q) => n + q.graveyard.filter((c) => c.isCreature).length, 0);
      case 'spellsInGraveyard': return p.graveyard.filter((c) => c.isInstant || c.isSorcery).length;
      case 'artifacts': return p.battlefield.filter((q) => q.card.isArtifact).length;
      case 'lands': return this.landCount(p);
      case 'enchantments': return p.battlefield.filter((q) => q.card.isEnchantment).length;
      case 'drawnThisTurn': return p.drawsThisTurn;
      case 'oppExile': return this.opponents(p).reduce((n, o) => n + o.exile.length, 0);
      case 'colors': return colorsAmong(p.battlefield.map((q) => q.card));
      case 'experience': return p.experience;
      case 'graveyardCreatures': return p.graveyard.filter((c) => c.isCreature).length;
      case 'party': return this.partySize(p);
      case 'oppGraveyardTypes': return cardTypeCount(this.opponents(p).flatMap((o) => o.graveyard));
      case 'subtype': return p.battlefield.filter((q) => !(s.other && q === perm) && hasSubtype(q.card, s.subtype ?? '')).length;
      default: return p.battlefield.filter((q) => q.card.isCreature).length;
    }
  }

  toughness(perm: Perm): number {
    const m = this.memo;
    if (!m) return this.toughnessNow(perm);
    const kept = m.toughness.get(perm);
    if (kept === undefined) {
      const v = this.toughnessNow(perm);
      m.toughness.set(perm, v);
      return v;
    }
    return verifyMemo ? checkMemo(`toughness of ${perm.card.name}`, kept, this.toughnessNow(perm)) : kept;
  }

  private toughnessNow(perm: Perm): number {
    let t = this.baseSize(perm).t + perm.counters + perm.tempT + this.anthemBonus(perm).t + (perm.card.scales?.toughness ? this.scaled(perm) : 0);
    for (const eq of this.attachments(perm)) for (const e of eq.card.effects) if (e.kind === 'equip') t += e.t;
    return t;
  }

  hasKw(perm: Perm, kw: string): boolean {
    if (perm.card.keywords.includes(kw) || perm.tempKw.includes(kw) || perm.kwCounters?.includes(kw)) return true;
    // A suspected creature has menace and can't block (rule 701.60c).
    if (perm.suspected && (kw === 'menace' || kw === "can't block")) return true;
    if (this.kindsInGame.has('selfKeyword')) {
      for (const e of perm.card.effects) {
        if (e.kind !== 'selfKeyword' || e.keyword !== kw) continue;
        const owner = this.players[perm.seat];
        if (e.cond === 'yourTurn' ? this.activeSeat === perm.seat : owner.life <= STARTING_LIFE / 2) return true;
      }
    }
    if (!perm.card.isCreature) return false;
    if (!this.kindsInGame.has('anthem') && !this.anyAttached) return false;
    const m = this.memo;
    if (!m) return this.grantedKw(perm, kw);
    let byKw = m.kw.get(perm);
    if (!byKw) m.kw.set(perm, (byKw = new Map()));
    const kept = byKw.get(kw);
    if (kept === undefined) {
      const v = this.grantedKw(perm, kw);
      byKw.set(kw, v);
      return v;
    }
    return verifyMemo ? checkMemo(`${kw} on ${perm.card.name}`, kept, this.grantedKw(perm, kw)) : kept;
  }

  /** Keywords a creature gets from anthems ("creatures you control have flying") and from Equipment and Auras. */
  private grantedKw(perm: Perm, kw: string): boolean {
    if (this.kindsInGame.has('anthem')) {
      for (const { perm: q, e } of this.anthemsOf(perm.seat)) if (e.keywords?.includes(kw) && this.anthemApplies(e, perm, q) && !(e.other && q === perm) && this.chargeOn(q, e) && (!e.small || perm.card.power + perm.counters <= 1 || perm.card.toughness + perm.counters <= 1)) return true;
    }
    for (const eq of this.attachments(perm)) {
      for (const e of eq.card.effects) if (e.kind === 'equip' && e.keywords.includes(kw)) return true;
    }
    return false;
  }

  /** Destroy a permanent. Indestructible permanents stay (rule 702.12). */
  private destroy(perm: Perm) {
    if (this.hasKw(perm, 'indestructible') || this.regenerated(perm)) return;
    this.removePerm(perm, 'graveyard');
  }

  private removePerm(perm: Perm, to: 'graveyard' | 'exile' | 'hand' | 'library') {
    this.removePerms([perm], to);
  }

  /**
   * Several permanents leave the battlefield at the same time (a wipe, or
   * state-based actions). Abilities that trigger on dying "look back in time"
   * (rule 603.10a): every permanent on the battlefield just before the event
   * sees every creature that died in it, including those that died with it.
   */
  private removePerms(perms: Perm[], to: 'graveyard' | 'exile' | 'hand' | 'library') {
    const watchers = to === 'graveyard' && this.kindsInGame.has('when:creatureDies') ? this.allPerms().map((w) => ({ w, seat: w.seat })) : [];
    const died: { perm: Perm; seat: number; worn: Perm[]; real: DiedCard | undefined }[] = [];
    const landsDied: PlayerState[] = [];
    const leaving: { perm: Perm; seat: number; dest: typeof to; power: number }[] = [];
    for (const perm of perms) {
      const controller = this.players[perm.seat];
      const owner = this.players[perm.owner ?? perm.seat];
      const idx = controller.battlefield.indexOf(perm);
      // Emblems never leave the command zone (rule 114.4).
      if (idx === -1 || perm.emblem) continue;
      const worn = to === 'graveyard' && perm.card.isCreature ? this.attachments(perm) : NONE;
      const power = perm.card.isCreature ? this.power(perm) : 0;
      const flying = perm.card.isCreature && this.hasKw(perm, 'flying');
      controller.battlefield.splice(idx, 1);
      controller.revoltTurn = this.turnNumber;
      // Hideaway: the face-down card stays in exile when its permanent leaves (rule 702.75a).
      if (perm.hidden) {
        this.players[perm.hiddenOwner ?? owner.seat].exile.push(perm.hidden);
        perm.hidden = undefined;
      }
      // Rest in Peace, Dauthi Voidwalker: exiled instead, so nothing "dies". An unearthed creature is exiled if it would leave.
      let dest = to;
      if (dest === 'graveyard' && this.exiledInstead(owner)) dest = 'exile';
      if (this.unearthed.delete(perm.id)) dest = 'exile';
      if (this.finality.delete(perm.id) && dest === 'graveyard') dest = 'exile';
      // Gisa, Vren, The Darkness Crystal: an opponent's creature that would die is exiled instead (rule 614.1a).
      let exiler: { q: Perm; e: Extract<Effect, { kind: 'deathExile' }> } | null = null;
      if (dest === 'graveyard' && (exiler = this.deathExiler(controller, perm))) {
        dest = 'exile';
        this.say(`${perm.card.name} is exiled instead (${exiler.q.card.name}).`);
        if (exiler.e.gain && !perm.token) this.gainLife(this.players[exiler.q.seat], exiler.e.gain);
      }
      // Cosmic Intervention: exiled instead, and back at the beginning of the next end step.
      const shielded = dest === 'graveyard' && controller.deathShield === this.turnNumber && !perm.token;
      if (shielded) dest = 'exile';
      let real: DiedCard | undefined;

      // Tokens cease to exist once they leave the battlefield (rule 704.5d). A copy goes back to being its own card.
      // A merged permanent's cards all go to the same zone (rule 721.3).
      if (owner.alive) {
        const cards = perm.parts
          ? perm.parts.flatMap((x) => (x.real ? [{ card: x.real, commander: x.commander }] : []))
          : perm.token ? [] : [{ card: realCard(perm), commander: perm.isCommander }];
        for (const { card, commander } of cards) {
          if (dest === 'library') {
            // Shuffled into the library. Its owner may put a commander into the command zone instead (rule 903.9b), asked in checkState.
            owner.library.splice(this.rng.int(owner.library.length + 1), 0, card);
            if (commander) this.pendingCommander.push({ seat: owner.seat, card, to: 'library' });
            continue;
          }
          // Nexus of Fate, Blightsteel Colossus: shuffled into the library instead.
          if (dest === 'graveyard' && this.shufflesInstead(card)) {
            owner.library.splice(this.rng.int(owner.library.length + 1), 0, card);
            this.say(`${card.name} is shuffled into ${owner.name}'s library instead.`);
            continue;
          }
          if (dest === 'exile' && exiler?.e.keep && card.isCreature) {
            const pile = this.exiledWith.get(exiler.q.id) ?? [];
            pile.push({ card, owner: owner.seat });
            this.exiledWith.set(exiler.q.id, pile);
          }
          if (shielded && dest === 'exile' && !commander) this.endReturns.push({ card, owner: owner.seat, to: 'battlefield', from: 'exile' });
          if (dest === 'graveyard') {
            owner.graveyard.push(card);
            if (card.curse && owner.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'returnCurses'))) this.curseReturns.push({ seat: owner.seat, card });
          } else if (dest === 'exile') owner.exile.push(card);
          else owner.hand.push(card);
          if (commander) this.pendingCommander.push({ seat: owner.seat, card, to: dest });
        }
        if (cards.length === 1 && dest === 'graveyard' && owner.graveyard[owner.graveyard.length - 1] === cards[0].card) real = { card: cards[0].card, owner: owner.seat, counters: perm.counters, flying };
        // Persist (no -1/-1 counter on it) and undying (no +1/+1 counter): it returns (rules 702.79, 702.93).
        const card = cards.length === 1 ? cards[0].card : null;
        const persist = card?.persist;
        if (card && persist && dest === 'graveyard' && card.isCreature && (persist === 'persist' ? perm.counters >= 0 : perm.counters <= 0)) {
          this.trigger(owner, card, null, [{ kind: 'returnSelf', counters: persist === 'persist' ? -1 : 1, when: 'creatureDies', scope: 'self' }]);
        }
        // Undying Malice, Not Dead After All: "when this creature dies, return it to the battlefield tapped under its owner's control".
        const back = perm.tempKw.find((k) => k.startsWith('returns:'));
        if (card && back && dest === 'graveyard' && card.isCreature) {
          this.trigger(owner, card, null, [{ kind: 'returnSelf', counters: Number(back.slice(8)), tapped: true, when: 'creatureDies', scope: 'self' }]);
        }
      }
      if (perm.card.isCreature && dest === 'graveyard') this.diedThisTurn++;
      if (perm.card.isCreature && dest === 'graveyard' && controller.alive) died.push({ perm, seat: controller.seat, worn, real });
      leaving.push({ perm, seat: controller.seat, dest, power });
      if (perm.landInfo && dest === 'graveyard' && controller.alive && this.kindsInGame.has('landDiesPunish')) landsDied.push(controller);
    }
    // Disciple of the Vault, Ashiok's Reaper: an artifact or enchantment put into a graveyard from the battlefield (tokens too, rule 111.7).
    if (this.kindsInGame.has('when:permDies')) for (const { perm, seat, dest } of leaving) if (dest === 'graveyard') this.permDied(perm.card, seat);
    // Dingus Egg: each land that went to a graveyard hurts its controller.
    for (const victim of landsDied) {
      for (const q of this.alivePlayers()) for (const egg of q.battlefield) for (const e of egg.card.effects) {
        if (e.kind !== 'landDiesPunish' || e.when !== 'static') continue;
        const lost = this.loseLife(victim, e.n, q === victim ? null : q, 'noncombat');
        if (lost) this.say(`${egg.card.name} deals ${lost} damage to ${victim.name} (life ${victim.life}).`);
      }
    }
    // Control that lasts "for as long as" a permanent stays ends when it leaves (Sower of Temptation, Control Magic).
    if (this.anyHeld) {
      const gone = new Set(perms.map((q) => q.id));
      for (const q of this.allPerms()) if (q.heldBy !== undefined && gone.has(q.heldBy)) this.giveBack(q);
    }
    // A lockdown Aura that leaves gives the permanent its abilities back.
    if (this.anyLocked) {
      const gone = new Set(perms.map((q) => q.id));
      for (const q of this.allPerms()) if (q.lockedBy !== undefined && gone.has(q.lockedBy)) this.unlock(q);
    }

    for (const { perm, seat, worn, real } of died) {
      const controller = this.players[seat];
      this.diedNow = real;
      // "If it had no counters on it" (Unstoppable Slasher) is checked as it dies (rule 603.4).
      const counted = perm.counters !== 0 || !!perm.charge || !!perm.stun;
      const own = perm.card.effects.filter((e) => e.when === 'creatureDies' && e.scope === 'self' && !(e.noCounters && counted));
      if (own.length) for (let i = this.triggerTimes(controller, 'dies'); i > 0; i--) this.trigger(controller, perm.card, null, own, 0, perm);
      for (const { w, seat: wSeat } of watchers) {
        const q = this.players[wSeat];
        if (!q.alive) continue;
        // "Whenever a creature you control dies" watches your own; "whenever a creature dies" watches everyone's.
        // A creature sees its own death only for "this creature or another" and "a creature you control".
        const hits = w.card.effects.filter((e) => e.when === 'creatureDies' && e.scope !== 'self' && e.scope !== 'attached'
          && (q === controller ? e.scope !== 'opponents' : e.scope === 'all' || e.scope === 'opponents') && (w !== perm || e.selfToo) && !(e.nontoken && perm.token) && (!e.ofType || this.isType(perm, e.ofType, w)));
        if (hits.length) for (let i = this.triggerTimes(q, 'dies'); i > 0; i--) this.trigger(q, w.card, w.id, hits, 0, w, undefined, aboutDead(perm));
      }
      if (perm.bounty) this.bountyPaid(perm, controller);
      // Blitz: "when this creature dies, draw a card".
      if (perm.blitzed) this.trigger(controller, perm.card, null, [BLITZ_DRAW], 0, perm);
      // Skullclamp: "whenever equipped creature dies".
      for (const eq of worn) {
        const hits = eq.card.effects.filter((e) => e.when === 'creatureDies' && e.scope === 'attached');
        const holder = this.players[eq.seat];
        if (hits.length) for (let i = this.triggerTimes(holder, 'dies'); i > 0; i--) this.trigger(holder, eq.card, eq.id, hits, 0, null, undefined, aboutDead(perm));
      }
      this.diedNow = undefined;
    }
    // "Whenever a creature (permanent) you control leaves the battlefield, if it had counters on it" (The Ozolith, Resourceful Defense): x = its +1/+1 counters.
    if (this.kindsInGame.has('when:permLeaves')) {
      for (const { perm, seat } of leaving) {
        if (!perm.counters) continue;
        const controller = this.players[seat];
        for (const w of controller.battlefield) {
          const hits = w.card.effects.filter((e) => e.when === 'permLeaves' && (e.castFilter !== 'creature' || perm.card.isCreature));
          if (hits.length) this.trigger(controller, w.card, w.id, hits, perm.counters);
        }
      }
    }
    // "When ~ leaves the battlefield" / "dies or is put into exile" (x = its power), and "whenever a token you control leaves" (Nadier's Nightblade).
    if (this.kindsInGame.has('when:leaves')) {
      for (const { perm, seat, dest, power } of leaving) {
        const controller = this.players[seat];
        const own = perm.card.effects.filter((e) => e.when === 'leaves' && e.scope === 'self' && (!e.zones || e.zones.includes(dest)));
        if (own.length) this.trigger(controller, perm.card, null, own, power, perm);
        if (!perm.token) continue;
        for (const w of controller.battlefield) {
          const hits = w.card.effects.filter((e) => e.when === 'leaves' && e.scope === 'any');
          if (hits.length) this.trigger(controller, w.card, w.id, hits);
        }
      }
    }
  }

  /**
   * Cumulative upkeep (rule 702.24): an age counter, then pay the cost once per counter or sacrifice it.
   * Paid while it costs three times the cost or less and mana allows; the trigger is handled at once here.
   */
  private cumulativeUpkeep(p: PlayerState) {
    for (const perm of [...p.battlefield]) {
      // Vanishing: age counts the time counters removed so far.
      if (perm.card.vanishing) {
        perm.age = (perm.age ?? 0) + 1;
        if (perm.age >= perm.card.vanishing) {
          this.say(`The last time counter comes off ${perm.card.name}; ${p.name} sacrifices it (vanishing).`);
          this.removePerm(perm, 'graveyard');
          this.sacrificed(p, perm);
        }
        continue;
      }
      const cost = perm.card.cumulativeUpkeep;
      if (!cost) continue;
      // Solemnity: no age counter, so the upkeep costs nothing.
      if (this.countersBlocked(perm)) continue;
      perm.age = (perm.age ?? 0) + 1;
      const total: ManaCost = { generic: cost.generic * perm.age, pips: Array.from({ length: perm.age }, () => cost.pips).flat(), x: 0, life: 0 };
      const plan = perm.age <= 3 ? this.planPayment(p, total, 0, 0) : null;
      if (plan) {
        this.commitPayment(p, plan);
        this.say(`${p.name} pays cumulative upkeep for ${perm.card.name} (${perm.age} age counter${perm.age > 1 ? 's' : ''}).`);
      } else {
        this.say(`${p.name} doesn't pay cumulative upkeep and sacrifices ${perm.card.name}.`);
        this.removePerm(perm, 'graveyard');
        this.sacrificed(p, perm);
      }
    }
  }

  /** True once anything was taken "for as long as" something stays. */
  private anyHeld = false;
  /** True once a lockdown Aura has been attached. */
  private anyLocked = false;
  /** Lands with a blight counter (Ultima): they tap for {C} and have no other abilities, for good. */
  private readonly blighted = new Set<number>();
  /** True once a Curse has entered, to skip the search for Curses. */
  private anyCurse = false;
  /** Lynde: Curses that return attached to their owner at the beginning of the next end step. */
  private curseReturns: { seat: number; card: SimCard }[] = [];
  /** Each player's graveyard size as the turn began (Fraying Sanity). */
  private graveyardMark: number[] = [];

  /** Amphibian Downpour, Imprisoned in the Moon: `host` loses its abilities while `aura` stays attached (rule 613.1). */
  private lockDown(host: Perm, aura: Perm, e: Extract<Effect, { kind: 'equip' }>) {
    if (host.unlocked) return;
    host.unlocked = host.card;
    host.lockedBy = aura.id;
    host.card = lockedCard(host.card, e.lock === 'land' ? null : e.lockSize ?? { p: 1, t: 1 });
    this.anyLocked = true;
    this.say(`${host.unlocked.name} loses all its abilities${e.lock === 'land' ? ' and becomes a land' : ` and is a ${this.power(host)}/${this.toughness(host)}`}.`);
  }

  // -------------------------------------------------------------------------
  // Curses (Auras with "Enchant player", rule 303.4)
  // -------------------------------------------------------------------------

  /** The Curses attached to `v`. */
  cursesOn(v: PlayerState): Perm[] {
    if (!this.anyCurse) return [];
    const m = this.memo;
    const kept = m?.curses.get(v.seat);
    if (kept && !verifyMemo) return kept;
    const out = this.allPerms().filter((q) => q.cursing === v.seat && q.card.curse);
    if (kept) return checkMemo(`curses on ${v.name}`, kept, out);
    m?.curses.set(v.seat, out);
    return out;
  }

  /** The abilities of this kind on Curses attached to `v`. */
  private cursedBy(v: PlayerState, act: CurseAct): CurseAbility[] {
    return this.cursesOn(v).flatMap((q) => q.card.curse!.filter((c) => c.act === act));
  }

  /**
   * Something happened to `v` (or, for 'yourUpkeep', it is `actor`'s upkeep): the matching abilities of the Curses on `v`
   * trigger for their controllers. When `v` is attacked, each player attacking them shares in the reward (`actor` is the attacker).
   */
  private curseEvent(v: PlayerState, on: CurseAbility['on'], cast?: SimCard, actor?: PlayerState, subject?: number) {
    for (const curse of this.cursesOn(v)) {
      const owner = this.players[curse.seat];
      for (const c of curse.card.curse!) {
        if (c.on !== on) continue;
        if (on === 'yourUpkeep' && owner !== actor) continue;
        if (on === 'casts' && cast && ((c.filter === 'noncreature' && cast.isCreature) || (c.filter === 'instantSorcery' && !cast.isInstant && !cast.isSorcery) || (c.filter === 'notFirst' && v.spellsThisTurn <= 1))) continue;
        // Curse of Echoes: each other player may copy that spell.
        if (c.act === 'echoes') {
          for (const o of this.alivePlayers()) if (o !== v) this.trigger(o, curse.card, curse.id, [ECHO], 0, null, subject);
          continue;
        }
        const effect: Effect = { kind: 'curse', act: c.act, n: c.n, when: 'resolve' };
        if (on === 'attacked') {
          // "Each opponent attacking that player does the same"; Curse of Shallow Graves rewards only the attackers.
          if (c.act !== 'attackerZombie') this.trigger(owner, curse.card, curse.id, [effect], v.seat);
          if (actor && actor !== owner && (c.act === 'attackerZombie' || this.opponents(owner).includes(actor))) this.trigger(actor, curse.card, curse.id, [effect], v.seat);
          else if (actor && actor === owner && c.act === 'attackerZombie') this.trigger(owner, curse.card, curse.id, [effect], v.seat);
          continue;
        }
        this.trigger(owner, curse.card, curse.id, [effect], v.seat);
      }
    }
  }

  /** Lynde: Curses that went to her controller's graveyard come back attached to that player. */
  private *returnCurses(): Flow<void> {
    const due = this.curseReturns;
    this.curseReturns = [];
    for (const { seat, card } of due) {
      const p = this.players[seat];
      if (!p.alive || !p.graveyard.includes(card)) continue;
      p.graveyard.splice(p.graveyard.indexOf(card), 1);
      this.say(`${card.name} returns to the battlefield attached to ${p.name}.`);
      yield* this.enter(p, card, false, 0, { kind: 'player', seat });
    }
  }

  /** Move a Curse to another player. */
  private moveCurse(curse: Perm, to: PlayerState) {
    curse.cursing = to.seat;
    this.say(`${curse.card.name} now enchants ${to.name}.`);
  }

  /** A Curse's ability resolves: `p` gets the reward, `v` is the enchanted player. */
  private *resolveCurse(p: PlayerState, e: Extract<Effect, { kind: 'curse' }>, src: Perm | null, v: PlayerState): Flow<void> {
    const name = src?.card.name ?? this.resolvingCard?.name ?? 'A Curse';
    const zombie = (tapped: boolean) => {
      const perm = this.makePerm(p, tokenCard(2, 2, []), true);
      perm.tapped = tapped;
      p.battlefield.push(perm);
      this.creatureEntered(p, perm);
    };
    switch (e.act) {
      case 'gold':
        p.treasures++;
        this.say(`${p.name} creates a Gold token (${name}).`);
        break;
      case 'zombie':
      case 'restless':
        zombie(false);
        this.say(`${p.name} creates a 2/2 Zombie (${name}).`);
        break;
      case 'attackerZombie':
        zombie(true);
        this.say(`${p.name} creates a tapped 2/2 Zombie (${name}).`);
        break;
      case 'gainLife':
        this.gainLife(p, e.n);
        break;
      case 'draw':
        this.draw(p, e.n);
        break;
      case 'surveil': {
        const n = this.cursesOn(v).length;
        if (n) this.draw(p, n);
        this.say(`${p.name} draws ${n} (${name}).`);
        break;
      }
      case 'thirst':
      case 'burn':
      case 'hex': {
        if (!v.alive) break;
        const roll = e.act === 'hex' ? this.rng.int(6) + 1 : 0;
        const base = e.act === 'thirst' ? this.cursesOn(v).length : e.act === 'hex' ? roll : e.n;
        const amount = this.doubledDamage(v, base);
        this.loseLife(v, amount, p, 'noncombat');
        this.say(`${name} deals ${amount} damage to ${v.name}${e.act === 'hex' ? ` (rolled ${roll})` : ''} (life ${v.life}).`);
        // Maddening Hex moves on to another opponent of its controller, chosen at random.
        if (e.act === 'hex' && src && src.cursing === v.seat) {
          const others = this.opponents(p).filter((o) => o !== v);
          if (others.length) this.moveCurse(src, others[this.rng.int(others.length)]);
        }
        break;
      }
      case 'drain': {
        if (!v.alive) break;
        const lost = this.loseLife(v, e.n, p, 'noncombat');
        this.gainLife(p, lost);
        this.say(`${v.name} loses ${e.n} and ${p.name} gains ${lost} (${name}).`);
        break;
      }
      case 'torment': {
        if (!v.alive) break;
        // They pick: lose the life, discard a card or sacrifice a nonland permanent.
        const perms = v.battlefield.filter((q) => !q.landInfo);
        const options: ChoiceOption[] = [{ label: `Lose ${e.n} life` }, ...v.hand.map((card) => ({ label: `Discard ${card.name}`, card })), ...perms.map((q) => ({ label: `Sacrifice ${q.card.name}`, permId: q.id }))];
        const [pick] = yield* this.choose(v, 'torment', `${name}: lose ${e.n} life unless you sacrifice a nonland permanent or discard a card.`, options, 1, 1);
        const opt = options[pick ?? 0];
        if (opt.permId !== undefined) {
          const q = this.findPerm(opt.permId);
          if (q) {
            this.say(`${v.name} sacrifices ${q.card.name} (${name}).`);
            this.removePerm(q, 'graveyard');
            this.sacrificed(v, q);
          }
        } else if (opt.card) {
          v.hand.splice(v.hand.indexOf(opt.card), 1);
          this.toGraveyard(v, opt.card, false);
          this.say(`${v.name} discards ${opt.card.name} (${name}).`);
          if (v !== p) this.discardedByOpponent(v, [opt.card]);
        } else {
          this.loseLife(v, e.n, p, 'noncombat');
          this.say(`${v.name} loses ${e.n} life (${name}) (life ${v.life}).`);
        }
        break;
      }
      case 'cruel': {
        if (!v.alive) break;
        const victims = v.battlefield.filter((q) => q.card.isCreature || q.card.isPlaneswalker);
        if (!victims.length) {
          this.loseLife(v, e.n, p, 'noncombat');
          this.say(`${v.name} has nothing to sacrifice and loses ${e.n} (${name}) (life ${v.life}).`);
          break;
        }
        const [pick] = yield* this.choose(v, 'sacrifice', `${name}: sacrifice a creature or planeswalker.`, victims.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
        const q = victims[pick ?? 0];
        this.say(`${v.name} sacrifices ${q.card.name} (${name}).`);
        this.removePerm(q, 'graveyard');
        this.sacrificed(v, q);
        break;
      }
      case 'unbinding': {
        if (!v.alive) break;
        const at = v.library.findIndex((c) => c.isCreature);
        const revealed = at === -1 ? v.library.splice(0) : v.library.splice(0, at + 1);
        const creature = at === -1 ? null : revealed.pop()!;
        v.graveyard.push(...revealed);
        if (revealed.length) v.milledBy = p.seat;
        this.say(`${v.name} reveals ${revealed.length + (creature ? 1 : 0)} cards (${name})${creature ? `; ${p.name} takes ${creature.name}` : ''}.`);
        if (creature) yield* this.enter(p, creature, false, 0, null, v);
        break;
      }
      case 'spite':
        if (src) src.counters++;
        break;
      case 'fraying': {
        const x = Math.max(0, v.graveyard.length - (this.graveyardMark[v.seat] ?? v.graveyard.length));
        if (!x || !v.alive) break;
        const milled = this.millCards(v, x);
        if (v !== p) v.milledBy = p.seat;
        this.say(`${v.name} mills ${milled} (${name}).`);
        break;
      }
      case 'obsessionDraw':
        this.draw(v, e.n);
        this.say(`${v.name} draws ${e.n} more (${name}).`);
        break;
      case 'obsessionDiscard': {
        const gone = v.hand.splice(0);
        for (const card of gone) this.toGraveyard(v, card, false);
        if (gone.length) this.say(`${v.name} discards their hand: ${gone.map((c) => c.name).join(', ')} (${name}).`);
        if (v !== p) this.discardedByOpponent(v, gone);
        break;
      }
      case 'misfortunes': {
        if (!v.alive) break;
        const names = new Set(this.cursesOn(v).map((q) => q.card.name));
        const options = p.library.filter((c) => c.curse && !names.has(c.name));
        if (!options.length) break;
        const [pick] = yield* this.choose(p, 'tutor', `${name}: put a Curse onto the battlefield attached to ${v.name}.`, options.map((card) => ({ label: card.name, card })), 1, 1);
        const card = options[pick ?? 0];
        p.library.splice(p.library.indexOf(card), 1);
        this.rng.shuffle(p.library);
        this.say(`${p.name} puts ${card.name} onto ${v.name} (${name}).`);
        yield* this.enter(p, card, false, 0, { kind: 'player', seat: v.seat });
        break;
      }
      // Static abilities, read where they apply.
      case 'shrink':
      case 'double':
      case 'hospitality':
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Commander one-offs: Fblthp, Ultima, Zur, Orvar, Ygra
  // -------------------------------------------------------------------------

  /** Ultima: a blight counter. The land loses its abilities and taps for {C}, for as long as the counter stays (for good, here). */
  private blight(land: Perm) {
    if (!land.landInfo || this.blighted.has(land.id)) return;
    this.blighted.add(land.id);
    if (!land.unlocked) {
      land.unlocked = land.card;
      land.lockedBy = -1;
      land.card = lockedCard(land.card, null);
      this.anyLocked = true;
    }
    land.landInfo = { produces: ['C'], tapped: false };
    this.say(`${land.unlocked.name} (${this.players[land.seat].name}) gets a blight counter and now only taps for {C}.`);
  }

  /** Zur: the enchantment becomes a creature with base power and toughness equal to its mana value, for good. */
  private animate(perm: Perm) {
    if (perm.card.isCreature || perm.unlocked) return;
    const base = perm.card;
    perm.unlocked = base;
    perm.lockedBy = -1;
    perm.card = { ...base, isCreature: true, power: base.cmc, toughness: base.cmc, notes: [...base.notes, `Animated: a ${base.cmc}/${base.cmc} creature`] };
    this.anyLocked = true;
    this.say(`${base.name} becomes a ${base.cmc}/${base.cmc} creature.`);
  }

  // -------------------------------------------------------------------------
  // Lockouts, animation and winning or losing (see classifyLocks.ts)
  // -------------------------------------------------------------------------

  /** Static effects of one kind on the battlefield, with the permanent each is on. */
  private staticsOf<K extends Effect['kind']>(kind: K): { e: Extract<Effect, { kind: K }>; perm: Perm }[] {
    if (!this.kindsInGame.has(kind)) return [];
    const m = this.memo;
    if (!m) return this.staticsOfNow(kind);
    const kept = m.staticsOf.get(kind) as { e: Extract<Effect, { kind: K }>; perm: Perm }[] | undefined;
    if (kept === undefined) {
      const v = this.staticsOfNow(kind);
      m.staticsOf.set(kind, v);
      return [...v];
    }
    return [...(verifyMemo ? checkMemo(`statics of ${kind}`, kept, this.staticsOfNow(kind)) : kept)];
  }

  private staticsOfNow<K extends Effect['kind']>(kind: K): { e: Extract<Effect, { kind: K }>; perm: Perm }[] {
    const out: { e: Extract<Effect, { kind: K }>; perm: Perm }[] = [];
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) for (const e of perm.card.effects) if (e.kind === kind && e.when === 'static') out.push({ e: e as Extract<Effect, { kind: K }>, perm });
    }
    return out;
  }

  /** Cursed Totem, Karn, Linvala, Grand Abolisher: can `p` activate abilities of a permanent like `card` (rule 602.5)? */
  abilitiesLocked(p: PlayerState, card: Pick<SimCard, 'isCreature' | 'isArtifact' | 'isEnchantment'>, lockers = this.staticsOf('abilityLock')): boolean {
    for (const { e, perm } of lockers) {
      if (e.who === 'opponents' && perm.seat === p.seat) continue;
      if (e.yourTurn && this.activeSeat !== perm.seat) continue;
      if (e.perms === 'creatures' ? card.isCreature : e.perms === 'artifacts' ? card.isArtifact : card.isArtifact || card.isCreature || card.isEnchantment) return true;
    }
    return false;
  }

  /** Silence, Teferi, Void Winnower, Lavinia, Soulless Jailer, Phyrexian Censor: `p` can't cast `card` from there now (rule 101.2). */
  castLocked(p: PlayerState, card: SimCard, from: CastFrom, lockers = this.staticsOf('castLock')): boolean {
    if (this.silenced.has(p.seat)) return true;
    for (const { e, perm } of lockers) {
      if (e.who === 'opponents' && perm.seat === p.seat) continue;
      switch (e.rule) {
        case 'all': return true;
        case 'yourTurn': if (this.activeSeat === perm.seat) return true; break;
        case 'sorcerySpeed': if (!this.sorcerySpeed(p)) return true; break;
        case 'evenCmc': if (card.cmc % 2 === 0) return true; break;
        case 'overLands': if (!card.isCreature && card.cmc > this.landCount(p)) return true; break;
        case 'graveyard': if (from === 'graveyard' && !card.isCreature) return true; break;
        // ≈ Counts every spell cast this turn, Phyrexian or not.
        case 'oneNonPhyrexian': if (p.spellsThisTurn >= 1 && !/\bPhyrexian\b/.test(card.typeLine)) return true; break;
      }
    }
    return false;
  }

  /** Chimil, Destiny Spinner, Cunning Nightbonder: this spell can't be countered. */
  uncounterable(s: StackItem): boolean {
    if (s.kind !== 'spell') return false;
    for (const { e, perm } of this.staticsOf('uncounterable')) {
      if (perm.seat !== s.controller) continue;
      if (e.filter === 'any' || (e.filter === 'flash' && matchesFilter(s.card, 'flash')) || (e.filter === 'creatureOrEnchantment' && (s.card.isCreature || s.card.isEnchantment))) return true;
    }
    return false;
  }

  /** Vexing Bauble, Lavinia: `p` cast this spell without spending mana, so their abilities trigger to counter it. */
  private counterFreeSpell(p: PlayerState, item: StackItem) {
    const seen = new Set<Perm>();
    for (const { e, perm } of this.staticsOf('counterFree')) {
      if (seen.has(perm) || (e.who === 'opponents' && perm.seat === p.seat)) continue;
      seen.add(perm);
      this.trigger(this.players[perm.seat], perm.card, perm.id, [{ kind: 'counter', target: 'any', subject: true, when: 'resolve' }], 0, null, item.id);
    }
  }

  /** Hushbringer (creatures entering or dying), Elesh Norn (permanents entering, for her controller's opponents). */
  private triggersStopped(p: PlayerState, event: 'enters' | 'permanentEnters' | 'dies', entering?: SimCard): boolean {
    for (const { e, perm } of this.staticsOf('triggerLock')) {
      if (e.who === 'opponents' && perm.seat === p.seat) continue;
      if (e.event === 'enters' && event !== 'dies') return true;
      if (e.event === 'creatures' && (event === 'dies' || !!entering?.isCreature)) return true;
    }
    return false;
  }

  /** Targets for the effects in this section. Null: no target ("up to one" with nothing to choose, or the effect needs none). */
  private lockTargets(p: PlayerState, e: Effect, src: Perm | null): Target[] | null {
    const ids = (perms: Perm[]) => perms.filter((q) => this.canTarget(p, q)).map((q): Target => ({ kind: 'perm', id: q.id }));
    switch (e.kind) {
      case 'becomeCreature': {
        let list: Target[];
        if (e.what === 'artifact') list = ids(p.battlefield.filter((q) => q.card.isArtifact && !q.card.isCreature && !q.landInfo && !q.uncrewed));
        else if (e.what === 'vehicle') list = ids(p.battlefield.filter((q) => q !== src && q.card.crew !== undefined && !q.card.isCreature && !q.uncrewed));
        else if (e.what === 'land') list = ids(p.battlefield.filter((q) => q.landInfo && !q.card.isCreature && !q.uncrewed));
        else return null;
        // "Up to one target": a loyalty ability or trigger with nothing to aim at still happens, doing nothing.
        return list.length || e.when === 'activated' ? list : null;
      }
      case 'becomeArtifact':
        return ids(this.allPerms().filter((q) => !q.landInfo && !q.card.isArtifact));
      case 'becomeTreasure':
        return ids(this.allPerms().filter((q) => q.card.isCreature));
      case 'blank': {
        const list = ids(this.opponents(p).flatMap((o) => o.battlefield).filter((q) => !q.unlocked && (q.card.isArtifact || q.card.isCreature || q.card.isPlaneswalker) && (q.card.effects.length > 0 || q.card.keywords.length > 0)));
        return list.length ? list : null;
      }
      case 'slime': {
        const list = ids(this.allPerms().filter((q) => q !== src && q.card.isCreature && !q.slime));
        return list.length ? list : null;
      }
      default:
        return null;
    }
  }

  /** The card a permanent is while it has lost all its abilities (and, with `size`, has that base power and toughness). */
  private blankCard(card: SimCard, size?: { p: number; t: number }): SimCard {
    const key = size ? `blank ${size.p}/${size.t}` : 'blank';
    let cache = LOCKED.get(key);
    if (!cache) LOCKED.set(key, (cache = new WeakMap()));
    let out = cache.get(card);
    if (!out) {
      out = {
        ...card, keywords: [], effects: [], scales: undefined, crew: undefined, persist: undefined, toxic: undefined, cumulativeUpkeep: undefined, vanishing: undefined, noUntap: undefined, levels: undefined, station: undefined,
        ...(size ? { power: size.p, toughness: size.t } : {}), notes: [...card.notes, `Has lost all abilities${size ? ` (${size.p}/${size.t})` : ''}`],
      };
      cache.set(card, out);
    }
    return out;
  }

  /** `perm` loses all abilities while `by` stays (-3: until a turn, see Perm.blankUntil). */
  private blankPerm(perm: Perm, by: number, size?: { p: number; t: number }) {
    if (perm.unlocked) return;
    perm.unlocked = perm.card;
    perm.lockedBy = by;
    perm.card = this.blankCard(perm.card, size);
    this.anyLocked = true;
  }

  /** Mana symbols among `p`'s permanents' costs that are any of these colors (rule 700.5; a hybrid symbol counts once). */
  private devotionTo(p: PlayerState, colors: Color[]): number {
    let n = 0;
    for (const perm of p.battlefield) for (const pip of (perm.unlocked ?? perm.card).cost.pips) if (pip.some((c) => colors.includes(c as Color))) n++;
    return n;
  }

  /**
   * Static abilities that change what permanents are: a god that isn't a creature until its devotion is high enough
   * (rule 613.1d), Dress Down and Sludge Monster taking creatures' abilities away (613.1f).
   */
  private refreshCharacteristics() {
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) {
        const real = perm.lockedBy === -2 ? perm.unlocked! : perm.card;
        const rule = real.effects.find((e): e is Extract<Effect, { kind: 'notCreature' }> => e.kind === 'notCreature' && e.when === 'static');
        if (!rule || !real.isCreature) continue;
        const creature = rule.stolen ? q.battlefield.filter((x) => x.owner !== undefined && x.owner !== q.seat).length >= rule.n : this.devotionTo(q, rule.devotion ?? []) >= rule.n;
        if (!creature && perm.lockedBy !== -2 && !perm.unlocked) {
          perm.unlocked = real;
          perm.lockedBy = -2;
          perm.card = this.dormantCard(real);
          perm.attacking = null;
          perm.attackingPw = undefined;
          perm.blocking = null;
          this.anyLocked = true;
        } else if (creature && perm.lockedBy === -2) {
          this.unlock(perm);
          this.say(`${real.name} (${q.name}) is a creature now.`);
        }
      }
    }
    const losers = this.staticsOf('loseAbilities');
    if (!losers.length) return;
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) {
        if (!perm.card.isCreature || perm.unlocked) continue;
        const by = losers.find(({ e }) => e.what === 'creatures' || (perm.slime && !hasSubtype(perm.card, 'Horror')));
        if (by) this.blankPerm(perm, by.perm.id, by.e.what === 'slimed' ? { p: 2, t: 2 } : undefined);
      }
    }
  }

  /** Give each permanent the card types Enchanted Evening and Encroaching Mycosynth add, and take them away once those leave. */
  private refreshTypes() {
    const adders = this.staticsOf('addTypes');
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) {
        if (perm.emblem) continue;
        const base = TYPED_BASE.get(perm.card) ?? perm.card;
        const types = new Set<'artifact' | 'enchantment'>();
        for (const { e, perm: src } of adders) if (e.who === 'all' || (src.seat === perm.seat && !base.isLand && !perm.landInfo)) for (const t of e.types) types.add(t);
        const want = types.size ? typedCard(base, [...types]) : base;
        if (perm.card !== want) perm.card = want;
      }
    }
  }

  /** Encroaching Mycosynth: the card as a spell `p` casts sees it (a nonland permanent spell is an artifact too). */
  spellTypes(p: PlayerState, card: SimCard): SimCard {
    if (!this.kindsInGame.has('addTypes') || card.isLand || card.isInstant || card.isSorcery || card.isArtifact) return card;
    const mine = this.staticsOf('addTypes').some(({ e, perm }) => e.who === 'yoursNonland' && perm.seat === p.seat && e.types.includes('artifact'));
    return mine ? typedCard(card, ['artifact']) : card;
  }

  /** A god while it isn't a creature. */
  private dormantCard(card: SimCard): SimCard {
    let cache = LOCKED.get('dormant');
    if (!cache) LOCKED.set('dormant', (cache = new WeakMap()));
    let out = cache.get(card);
    if (!out) cache.set(card, (out = { ...card, isCreature: false, notes: [...card.notes, 'Not a creature right now'] }));
    return out;
  }

  /** Permanents become creatures: Karn, Cyberdrive Awakener, Destiny Spinner, Vehicles without crewing, Vihaan's Treasures. */
  private *becomeCreature(p: PlayerState, e: Extract<Effect, { kind: 'becomeCreature' }>, src: Perm | null, target: Target | null): Flow<void> {
    let perms: Perm[] = [];
    switch (e.what) {
      case 'self': if (src && this.players[src.seat].battlefield.includes(src)) perms = [src]; break;
      case 'artifact': case 'vehicle': case 'land': {
        const q = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (q && q.seat === p.seat) perms = [q];
        break;
      }
      case 'artifacts':
        perms = p.battlefield.filter((q) => q.card.isArtifact && !q.card.isCreature && !q.landInfo && !q.uncrewed);
        // Depthshaker Titan's artifacts are sacrificed afterwards: ≈ its controller picks the ones it can spare (no mana rocks, Equipment or anything costly).
        if (e.until === 'sacAtEnd') perms = perms.filter((q) => q.token || (q.card.cmc <= 3 && !q.card.effects.some((f) => f.kind === 'mana' || f.kind === 'equip')));
        break;
      case 'vehicles': perms = p.battlefield.filter((q) => q.card.crew !== undefined && !q.card.isCreature && !q.uncrewed); break;
      case 'treasures': {
        if (!p.treasures) return;
        const yes = yield* ask<boolean>({ kind: 'confirm', seat: p.seat, reason: 'animate', prompt: `Make your ${p.treasures} Treasure${p.treasures > 1 ? 's' : ''} into ${typeof e.size === 'object' ? `${e.size.p}/${e.size.t}` : ''} creatures until end of turn? (They can't be used for mana while they are.)` });
        if (!yes) return;
        const size = typeof e.size === 'object' ? e.size : { p: 3, t: 3 };
        const n = p.treasures;
        p.treasures = 0;
        for (let i = 0; i < n; i++) {
          const token = this.makePerm(p, treasureCreatureCard(size.p, size.t), true);
          token.sick = false;
          token.treasureCreature = true;
          p.battlefield.push(token);
        }
        this.say(`${p.name}'s ${n} Treasure${n > 1 ? 's become' : ' becomes a'} ${size.p}/${size.t} creature${n > 1 ? 's' : ''} until end of turn.`);
        return;
      }
    }
    for (const perm of perms) {
      if (perm.uncrewed || (perm.card.isCreature && e.what !== 'self')) continue;
      const base = perm.card;
      const enchantments = p.battlefield.filter((q) => q.card.isEnchantment).length;
      const size = e.size === 'cmc' ? { p: base.cmc, t: base.cmc } : e.size === 'enchantments' ? { p: enchantments, t: enchantments } : e.size ?? (base.crew !== undefined || base.isCreature ? { p: base.power, t: base.toughness } : { p: 1, t: 1 });
      perm.uncrewed = base;
      perm.card = { ...base, isCreature: true, power: size.p, toughness: size.t, keywords: [...new Set([...base.keywords, ...(e.keywords ?? [])])] };
      if (e.until === 'yourNextTurn') perm.animatedUntil = p.seat;
      if (e.until === 'sacAtEnd') perm.sacAtEnd = true;
      this.say(`${base.name} becomes a ${size.p}/${size.t} creature${e.until === 'yourNextTurn' ? ` until ${p.name}'s next turn` : e.until === 'sacAtEnd' ? ' (sacrificed at the end step)' : ' until end of turn'}.`);
    }
  }

  /** At the start of `p`'s turn: what lasted "until your next turn" ends (Karn's animation, Azure Beastbinder). */
  private endUntilYourTurn(p: PlayerState) {
    for (const perm of this.allPerms()) {
      if (perm.animatedUntil === p.seat && perm.uncrewed) {
        perm.card = perm.uncrewed;
        perm.uncrewed = undefined;
        perm.animatedUntil = undefined;
      }
      if (perm.blankUntil === p.seat) {
        perm.blankUntil = undefined;
        this.unlock(perm);
      }
    }
  }

  /** The beginning of the end step: Dress Down, Ball Lightning and Depthshaker Titan's artifacts are sacrificed. */
  private endStepSacrifices() {
    if (!this.kindsInGame.has('endSacrifice') && !this.kindsInGame.has('becomeCreature')) return;
    for (const q of this.players) {
      if (!q.alive) continue;
      const gone = q.battlefield.filter((perm) => perm.sacAtEnd || (perm.unlocked ?? perm.card).effects.some((e) => e.kind === 'endSacrifice' && e.when === 'static'));
      for (const perm of gone) {
        this.say(`${perm.card.name} (${q.name}) is sacrificed at the end step.`);
        this.removePerm(perm, 'graveyard');
        this.sacrificed(q);
      }
    }
  }

  /** Cleanup: Vihaan's Treasures stop being creatures. */
  private endTreasureCreatures() {
    for (const q of this.players) {
      const back = q.battlefield.filter((perm) => perm.treasureCreature);
      if (!back.length) continue;
      for (const perm of back) q.battlefield.splice(q.battlefield.indexOf(perm), 1);
      q.treasures += back.length;
    }
  }

  /** Pacts: pay now, at the beginning of the upkeep, or lose the game. */
  private payPacts(p: PlayerState) {
    const due = this.pacts.filter((x) => x.seat === p.seat);
    if (!due.length) return;
    this.pacts = this.pacts.filter((x) => x.seat !== p.seat);
    for (const pact of due) {
      const plan = this.planPayment(p, pact.cost, 0, 0);
      if (plan) {
        this.commitPayment(p, plan);
        this.say(`${p.name} pays for ${pact.name}.`);
      } else {
        this.say(`${p.name} can't pay for ${pact.name} and loses the game.`);
        p.lost = true;
      }
    }
  }

  /** What keeps `p` in the game (rule 104.3): 'all' (Platinum Angel), 'life' (Phyrexian Unlife, Pact Weapon on a creature), or nothing. */
  lossShield(p: PlayerState): 'all' | 'life' | null {
    let out: 'life' | null = null;
    for (const perm of p.battlefield) for (const e of perm.card.effects) {
      if (e.kind !== 'cantLose' || e.when !== 'static') continue;
      if (e.attached && !(perm.attachedTo !== null && this.findPerm(perm.attachedTo)?.card.isCreature)) continue;
      if (!e.lifeOnly) return 'all';
      out = 'life';
    }
    return out;
  }

  /** Orvar: discarded by an opponent's spell or ability, it makes a token copy of a permanent. */
  private discardedByOpponent(v: PlayerState, cards: SimCard[]) {
    for (const card of cards) {
      const hits = card.effects.filter((e) => e.kind === 'copyOnDiscard');
      if (hits.length && v.graveyard.includes(card)) this.trigger(v, card, null, hits.map((e) => ({ ...e, when: 'resolve' as const })));
    }
  }

  /** Could removal aimed at this kind of permanent hit `perm`? With Ygra out, other creatures are Food artifacts too. */
  removable(target: string, perm: Perm): boolean {
    return removalMatches(target, perm.card) || (target === 'artifactEnchantment' && this.foodAbility(perm));
  }

  /** Ygra: other creatures are Food with "{2}, {T}, Sacrifice this permanent: You gain 3 life." */
  foodAbility(perm: Perm): boolean {
    if (!this.kindsInGame.has('foodCreatures') || !perm.card.isCreature) return false;
    return this.allPerms().some((q) => q !== perm && q.card.effects.some((e) => e.kind === 'foodCreatures' && e.when === 'static'));
  }

  /** Curse of Bloodletting: damage to the enchanted player is doubled for each one. */
  private doubledDamage(victim: PlayerState, amount: number, from?: PlayerState, combat = false): number {
    let out = amount;
    // Fated Firepower (+1 per fire counter), Solphim (noncombat damage doubled): damage `from`'s sources deal to an opponent.
    if (from && from !== victim && amount > 0 && this.kindsInGame.has('damageBonus')) {
      for (const perm of from.battlefield) for (const e of perm.card.effects) {
        if (e.kind !== 'damageBonus' || (e.noncombat && combat)) continue;
        if (e.perCharge) out += perm.charge ?? 0;
        if (e.double) out *= 2;
      }
    }
    if (!this.anyCurse) return out;
    return out * 2 ** this.cursedBy(victim, 'double').length;
  }

  /** The Ring tempts `p` (rule 701.54): the next of its abilities, a ring-bearer (their strongest creature), then "whenever the Ring tempts you". */
  private ringTempts(p: PlayerState) {
    p.ringLevel = Math.min(4, p.ringLevel + 1);
    const creatures = p.battlefield.filter((q) => q.card.isCreature);
    const bearer = creatures.length ? creatures.reduce((a, b) => (this.power(b) + (this.hasKw(b, 'flying') || this.hasKw(b, 'unblockable') ? 2 : 0) > this.power(a) + (this.hasKw(a, 'flying') || this.hasKw(a, 'unblockable') ? 2 : 0) ? b : a)) : null;
    p.ringBearer = bearer?.id ?? null;
    this.say(`The Ring tempts ${p.name} (${p.ringLevel} of 4)${bearer ? `; ${bearer.card.name} is the ring-bearer` : ''}.`);
    this.fire(p, 'ringTempts');
  }

  /** How many of the Ring's abilities `perm` has: its controller's count if it is their ring-bearer, else 0. */
  ringLevel(perm: Perm): number {
    const p = this.players[perm.seat];
    return p.ringBearer === perm.id ? p.ringLevel : 0;
  }

  /** Draw a card, then discard a card. */
  private *loot(p: PlayerState, why: string): Flow<void> {
    this.draw(p, 1);
    if (!p.hand.length) return;
    const [pick] = yield* this.choose(p, 'discard', `${why}: discard a card.`, p.hand.map((card) => ({ label: card.name, card })), 1, 1);
    const card = p.hand[pick ?? 0];
    p.hand.splice(p.hand.indexOf(card), 1);
    this.discarded(p, card);
    this.say(`${p.name} loots (${why}), discarding ${card.name}.`);
  }

  private unlock(perm: Perm) {
    if (!perm.unlocked) return;
    perm.card = perm.unlocked;
    perm.unlocked = undefined;
    perm.lockedBy = undefined;
  }

  private hold(perm: Perm, by: Perm) {
    if (perm.owner === undefined) return;
    perm.heldBy = by.id;
    this.anyHeld = true;
  }

  /** Control of a borrowed permanent goes back to its owner (rule 611.2b). */
  private giveBack(perm: Perm) {
    perm.heldBy = undefined;
    perm.heldWhileMonarch = undefined;
    const owner = this.players[perm.owner ?? perm.seat];
    if (!owner.alive || perm.owner === undefined) return;
    this.takeControl(perm, owner);
  }

  // -------------------------------------------------------------------------
  // State-based actions (rule 704)
  // -------------------------------------------------------------------------

  /** Check state-based actions until nothing changes, then put waiting triggers on the stack. */
  private *checkState(): Flow<void> {
    // Putting triggers on the stack can change the game too (life paid for ward as targets are chosen), so state-based
    // actions are checked again until nothing more happens (rule 117.5).
    for (let round = 0; round < 5; round++) {
      const before = this.vitals();
      yield* this.checkStateOnce();
      if (this.over || this.sameVitals(before)) return;
    }
  }

  /** Every player's life, poison and whether they are still in the game, to see whether anything changed. */
  private vitals(): (number | boolean)[] {
    const out: (number | boolean)[] = [];
    for (const q of this.players) out.push(q.life, q.poison, q.alive);
    return out;
  }

  private sameVitals(before: (number | boolean)[]): boolean {
    let i = 0;
    for (const q of this.players) if (!Object.is(before[i++], q.life) || !Object.is(before[i++], q.poison) || before[i++] !== q.alive) return false;
    return true;
  }

  private *checkStateOnce(): Flow<void> {
    for (let i = 0; i < 100; i++) {
      if (this.damagedQueue.length) yield* this.damagedEvents();
      this.pendingLegend = [];
      let changed = this.stateBasedActions();
      // The legend rule (704.5j): each player keeps one of their legendary permanents with the same name.
      for (const l of this.pendingLegend) {
        const owner = this.players[l.seat];
        const perms = l.ids.map((id) => owner.battlefield.find((x) => x.id === id)).filter((x): x is Perm => !!x);
        if (!owner.alive || perms.length < 2) continue;
        const pick = yield* this.choose(owner, 'legend', `Legend rule: you control ${perms.length} permanents named ${l.name}. Choose the one to keep.`, perms.map((x) => ({ label: this.legendLabel(x), card: x.card, permId: x.id })), 1, 1);
        const keep = perms[pick[0] ?? 0];
        for (const x of perms) {
          if (x === keep || !owner.battlefield.includes(x)) continue;
          this.say(`${x.card.name} (${owner.name}) is put into the graveyard (legend rule).`);
          this.removePerm(x, 'graveyard');
        }
        changed = true;
      }
      // Defeated Sieges: cast the back face without paying its mana cost (rule 310.11b).
      while (this.pendingSiege.length) {
        const s = this.pendingSiege.shift()!;
        const caster = this.players[s.seat];
        const owner = this.players[s.owner];
        if (!caster.alive || !owner.exile.includes(s.card)) continue;
        // "You may cast it transformed": a spell, so cast triggers see it (rule 712.11). Turning it down leaves it in exile.
        const back = s.card.back!;
        const via: CastVia = { zone: owner.exile, owner, mode: 'free', label: ' transformed', front: s.card };
        if (yield* this.cast(caster, back, false, 0, 'hand', false, 0, via)) changed = true;
      }
      // A commander that went to a graveyard or exile may go to the command zone
      // instead (rule 903.9a); one headed for its owner's hand may too (903.9b).
      while (this.pendingCommander.length) {
        const c = this.pendingCommander.shift()!;
        const owner = this.players[c.seat];
        const zone = c.to === 'graveyard' ? owner.graveyard : c.to === 'exile' ? owner.exile : c.to === 'library' ? owner.library : owner.hand;
        if (!owner.alive || !zone.includes(c.card)) continue;
        const move = yield* ask<boolean>({ kind: 'confirm', seat: c.seat, reason: 'commandZone', prompt: `Return ${c.card.name} to the command zone? (Otherwise it stays in your ${c.to}.)`, card: c.card, to: c.to });
        if (move) {
          zone.splice(zone.indexOf(c.card), 1);
          owner.commandZone.push(c.card);
          this.say(`${c.card.name} returns to ${owner.name}'s command zone.`);
          changed = true;
        }
      }
      if (this.over || !changed) break;
    }
    if (!this.over) yield* this.flushTriggers();
  }

  private stateBasedActions(): boolean {
    let changed = false;
    // Gods that stop being creatures, Dress Down and Sludge Monster: static abilities that change what permanents are.
    if (this.kindsInGame.has('notCreature') || this.kindsInGame.has('loseAbilities')) this.refreshCharacteristics();
    // Enchanted Evening, Encroaching Mycosynth: permanents have card types in addition to their own (rule 205.1b).
    if (this.kindsInGame.has('addTypes')) this.refreshTypes();
    if (this.kindsInGame.has('when:leaveGraveyard')) this.graveyardWatch();

    // Players who lose (704.5a–c, 903.10a). They all leave at the same time.
    for (const seat of this.winconSeats) if (this.players[seat].alive) this.checkCombo(this.players[seat]);

    const losing: { p: PlayerState; reason: LossReason }[] = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      let reason: LossReason | null = null;
      if (p.life <= 0) reason = p.lastHitKind;
      const lifeOnly = reason !== null;
      for (const dmg of p.commanderDamage.values()) if (dmg >= COMMANDER_DAMAGE) reason = 'commander';
      if (p.poison >= 10) reason = p.lastHitKind === 'noncombat' ? 'noncombat' : 'combat';
      if (p.drewFromEmpty) reason = 'decked';
      if (p.lost) reason ??= 'noncombat';
      // Platinum Angel: can't lose at all. Phyrexian Unlife: doesn't lose for having 0 or less life.
      if (reason && this.kindsInGame.has('cantLose')) {
        const shield = this.lossShield(p);
        const onlyLife = lifeOnly && reason === p.lastHitKind && !p.drewFromEmpty && !p.lost && p.poison < 10 && ![...p.commanderDamage.values()].some((d) => d >= COMMANDER_DAMAGE);
        if (shield === 'all' || (shield === 'life' && onlyLife)) {
          // The events that would have made them lose are over (rule 704.5b checks only draws since the last check).
          p.drewFromEmpty = false;
          p.lost = false;
          reason = null;
        }
      }
      if (reason) losing.push({ p, reason });
    }
    if (losing.length) {
      this.eliminate(losing);
      changed = true;
      if (this.over) return true;
    }

    const dying: Perm[] = [];
    // Toughness and indestructible are worked out for every creature first, with nothing changing
    // meanwhile; regeneration shields are used up afterwards, in the same order.
    const checked = this.readOnly(() => {
      const out: { perm: Perm; q: PlayerState; dies: boolean; lethal: boolean }[] = [];
      for (const q of this.players) {
        if (!q.alive) continue;
        for (const perm of q.battlefield) {
          if (!perm.card.isCreature) continue;
          // 704.5f: toughness 0 or less. 704.5g/h: lethal or deathtouch damage destroys.
          const toughness = this.toughness(perm);
          const dies = toughness <= 0;
          const lethal = (perm.damage >= toughness || perm.deathtouched) && !this.hasKw(perm, 'indestructible');
          // A survivor only needs remembering to clear its deathtouch mark.
          if (dies || lethal || perm.deathtouched) out.push({ perm, q, dies, lethal });
        }
      }
      return out;
    });
    for (const { perm, q, dies, lethal } of checked) {
      if (dies || (lethal && !this.regenerated(perm))) {
        this.say(`${perm.card.name} (${q.name}) dies.`);
        dying.push(perm);
      } else {
        perm.deathtouched = false;
      }
    }
    // All state-based actions happen at the same time (rule 704.3), so these creatures die together.
    if (dying.length) {
      this.removePerms(dying, 'graveyard');
      changed = true;
    }
    for (const q of this.players) {
      if (!q.alive) continue;
      // Most boards have none of these, so skip copying the battlefield then.
      const watched = q.battlefield.some((perm) => perm.card.saga || perm.loyalty !== undefined || perm.cursing !== undefined || perm.attachedTo !== null);
      for (const perm of watched ? [...q.battlefield] : NONE) {
        // 714.4: a Saga whose last chapter has resolved is sacrificed.
        if (perm.card.saga && (perm.lore ?? 0) >= perm.card.saga && q.battlefield.includes(perm) && !this.stack.some((s) => s.sourceId === perm.id) && !this.pending.some((t) => t.sourceId === perm.id)) {
          this.say(`${perm.card.name} (${q.name}) has finished its last chapter and is sacrificed.`);
          this.removePerm(perm, 'graveyard');
          this.sacrificed(q);
          changed = true;
          continue;
        }
        // 704.5i: a planeswalker with no loyalty is put into its owner's graveyard.
        if (perm.loyalty !== undefined && perm.loyalty <= 0 && q.battlefield.includes(perm)) {
          this.say(`${perm.card.name} (${q.name}) runs out of loyalty.`);
          this.removePerm(perm, 'graveyard');
          changed = true;
        }
        // 704.5m: a Curse enchanting a player who left the game goes to the graveyard.
        if (perm.cursing !== undefined && !this.players[perm.cursing].alive && q.battlefield.includes(perm)) {
          this.removePerm(perm, 'graveyard');
          changed = true;
          continue;
        }
        if (perm.attachedTo !== null && !this.findPerm(perm.attachedTo)) {
          perm.attachedTo = null;
          // 704.5m: an Aura attached to nothing goes to the graveyard. Equipment just falls off (704.5n).
          if (isAura(perm.card) && q.battlefield.includes(perm)) {
            this.removePerm(perm, 'graveyard');
            changed = true;
          }
        }
      }

      // 704.5j: the legend rule. Its controller chooses which one to keep (asked in checkState).
      let named: Map<string, Perm[]> | null = null;
      let twice = false;
      for (const perm of q.battlefield) {
        if (!perm.card.isLegendary || perm.emblem) continue;
        named ??= new Map();
        const same = named.get(perm.card.name);
        if (same) {
          same.push(perm);
          twice = true;
        } else named.set(perm.card.name, [perm]);
      }
      if (named && twice) for (const [name, perms] of named) if (perms.length > 1) this.pendingLegend.push({ seat: q.seat, name, ids: perms.map((x) => x.id) });

      for (const perm of q.battlefield.some((x) => x.card.isBattle) ? [...q.battlefield] : NONE) {
        if (!perm.card.isBattle || !q.battlefield.includes(perm)) continue;
        // A Siege whose last defense counter is gone is defeated: exile it, then its controller may cast it transformed (rule 310.11b).
        if ((perm.defense ?? 0) <= 0) {
          this.say(`${perm.card.name} (${q.name}) is defeated.`);
          const card = perm.token ? null : realCard(perm);
          this.removePerm(perm, 'exile');
          if (card?.back) this.pendingSiege.push({ seat: q.seat, card, owner: perm.owner ?? q.seat });
          changed = true;
        } else if (perm.protector === undefined || perm.protector === q.seat || !this.players[perm.protector].alive) {
          // 704.5w: a battle with no one to protect it (or protected by its own controller) goes to the graveyard.
          this.say(`${perm.card.name} (${q.name}) has no protector and is put into the graveyard.`);
          this.removePerm(perm, 'graveyard');
          changed = true;
        }
      }
    }
    return changed;
  }

  // -------------------------------------------------------------------------
  // Winning without combat: alternative win conditions and combos (wincons.ts)
  // -------------------------------------------------------------------------

  /** Mana symbols of `color` among the mana costs of permanents `p` controls (rule 700.5). */
  devotion(p: PlayerState, color: Color): number {
    let n = 0;
    for (const perm of p.battlefield) for (const pip of perm.card.cost.pips) if (pip.includes(color)) n++;
    return n;
  }

  /** `p` wins the game: every opponent loses (rule 104.2a), even one whose life can't change. */
  private winGame(p: PlayerState, why: string) {
    // Platinum Angel: its controller's opponents can't win, and its controller can't lose (rule 104.3).
    if (this.kindsInGame.has('cantLose') && this.opponents(p).some((o) => o.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'cantLose' && e.when === 'static' && e.opponentsCantWin)))) {
      this.say(`${p.name} would win the game (${why}), but can't win.`);
      return;
    }
    this.say(`${p.name} wins the game (${why}).`);
    for (const o of this.opponents(p)) {
      if (this.kindsInGame.has('cantLose') && this.lossShield(o) === 'all') continue;
      o.lost = true;
      o.lastHitBy = p.seat;
      o.lastHitKind = 'noncombat';
    }
  }

  /** "At the beginning of your upkeep, if ..., you win the game." */
  private upkeepWins(p: PlayerState) {
    for (const perm of p.battlefield) {
      const name = perm.card.name;
      if (UPKEEP_COUNTERS.has(name)) perm.counters++;
      const wins = perm.card.effects.some((e) => e.kind === 'winIf') ? undefined : UPKEEP_WINS[name];
      if (wins?.(p, perm)) {
        this.winGame(p, name);
        return;
      }
    }
  }

  /** Hour counters (Midnight Clock): the twelfth one sets off its "when the twelfth hour counter is put on ~" ability. */
  private addHours(perm: Perm, n: number) {
    const before = perm.hours ?? 0;
    perm.hours = before + n;
    if (before < 12 && perm.hours >= 12) {
      const hits = perm.card.effects.filter((e) => e.when === 'hourTwelve');
      if (hits.length) this.trigger(this.players[perm.seat], perm.card, perm.id, hits);
    }
  }

  /** Bloodchief Ascension: a quest counter at each end step in which an opponent lost 2 or more life. */
  private questCounters() {
    for (const seat of this.winconSeats) {
      const p = this.players[seat];
      if (!p.alive) continue;
      for (const perm of p.battlefield) {
        if (perm.card.name !== 'Bloodchief Ascension') continue;
        if (this.opponents(p).some((o) => this.lifeLostThisTurn[o.seat] >= 2)) this.addCharge(perm, 1);
      }
    }
  }

  /**
   * A combo that is assembled wins right away: the loop it starts is taken as a
   * shortcut (rule 727) instead of being played out one trigger at a time.
   */
  private checkCombo(p: PlayerState) {
    const opps = this.opponents(p);
    if (!opps.length) return;
    const found = assembledCombo(this, p);
    if (!found) return;
    if (found.kind === 'mill') {
      // Every opponent's library goes to the graveyard; each loses the next time they would draw.
      const left = opps.filter((o) => o.library.length > 0);
      if (!left.length) return;
      this.say(`${p.name} assembles ${found.combo.name} and mills every opponent's library.`);
      for (const o of left) {
        for (const card of o.library.splice(0)) this.toGraveyard(o, card, false);
        o.milledBy = p.seat;
      }
      return;
    }
    // A drain loop can't touch a player whose life can't change this turn (Teferi's Protection).
    const victims = opps.filter((o) => !o.shielded && o.life > 0);
    if (!victims.length) return;
    if (victims.length < opps.length) {
      this.say(`${p.name} loops ${found.combo.name}, draining every opponent who can lose life.`);
      for (const o of victims) this.loseLife(o, o.life, p, 'noncombat');
      return;
    }
    this.winGame(p, found.combo.name);
  }

  private eliminate(dying: { p: PlayerState; reason: LossReason }[]) {
    const aliveBefore = this.alivePlayers().length;
    // Curse of Vengeance: when the enchanted player loses, its controller gains and draws one for each spite counter.
    if (this.anyCurse) for (const { p } of dying) for (const curse of this.cursesOn(p)) {
      const holder = this.players[curse.seat];
      if (holder === p || dying.some((d) => d.p === holder) || !curse.card.curse!.some((c) => c.act === 'spite') || !curse.counters) continue;
      this.gainLife(holder, curse.counters);
      this.draw(holder, curse.counters);
      this.say(`${holder.name} gains ${curse.counters} life and draws ${curse.counters} (${curse.card.name}).`);
    }
    for (const { p, reason } of dying) {
      p.alive = false;
      // Everyone still in the game finished ahead; players who lose together share the place.
      this.placements[p.seat] = aliveBefore - dying.length + 1;
      // Running out of cards counts against whoever milled them last, if anyone did.
      const killer = reason === 'decked' ? p.milledBy : p.lastHitBy;
      this.eliminations.push({ seat: p.seat, round: this.round, reason, killer });
      this.say(`${p.name} is eliminated (${reason}${killer !== null ? ` by ${this.players[killer].name}` : ''}).`);
      // Everything a player owns leaves the game with them, and what they took goes back (rule 800.4a).
      for (const perm of p.battlefield) {
        const owner = perm.owner !== undefined ? this.players[perm.owner] : null;
        if (!owner?.alive) continue;
        perm.seat = owner.seat;
        perm.owner = undefined;
        perm.attacking = null;
        perm.attackingPw = undefined;
        perm.blocking = null;
        owner.battlefield.push(perm);
      }
      p.battlefield = [];
      for (const q of this.players) if (q !== p) q.battlefield = q.battlefield.filter((perm) => perm.owner !== p.seat);
      for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].controller === p.seat || this.stack[i].owner === p.seat) this.stack.splice(i, 1);
      // Their cards in every other zone leave the game too, so nobody can play them from exile or bring them back (rule 800.4a).
      p.hand = [];
      p.library = [];
      p.graveyard = [];
      p.exile = [];
      p.held = undefined;
      p.mayPlay = undefined;
      for (const q of this.players) if (q.mayPlay?.length) q.mayPlay = q.mayPlay.filter((m) => m.owner !== p.seat);
      this.pending = this.pending.filter((t) => t.controller !== p.seat);
      for (const perm of this.allPerms()) if (perm.attacking === p.seat) {
        perm.attacking = null;
        perm.attackingPw = undefined;
      }
    }
    if (this.monarch !== null && !this.players[this.monarch].alive) this.monarch = this.alivePlayers()[0]?.seat ?? null;
    if (this.alivePlayers().length <= 1) this.over = true;
  }

  // -------------------------------------------------------------------------
  // Combat (rules 506–511)
  // -------------------------------------------------------------------------

  /**
   * Mana each creature's controller must pay to attack `defender` (Propaganda, Ghostly Prison, Summon: Yojimbo).
   * With `attacker`: also what that creature pays for its counters (Nils, Discipline Enforcer).
   */
  attackTax(defender: PlayerState, attacker?: Perm): number {
    let tax = 0;
    for (const perm of defender.battlefield) for (const e of perm.card.effects) {
      if (e.kind !== 'attackTax') continue;
      if (!e.perCounter) tax += e.amount;
      else if (attacker) tax += e.amount * this.counterCount(attacker);
    }
    for (const o of this.attackOrders) if (o.kind === 'tax' && o.seat === defender.seat) tax += o.amount;
    return tax;
  }

  /** Every counter on a permanent, of any kind (Nils). */
  private counterCount(perm: Perm): number {
    return Math.abs(perm.counters) + (perm.charge ?? 0) + (perm.stun ?? 0) + (perm.kwCounters?.length ?? 0) + (perm.bounty ? 1 : 0) + (perm.loyalty ?? 0) + (perm.lore ?? 0) + (perm.age ?? 0) + (perm.hours ?? 0);
  }

  /** Static attack and block rules on the battlefield, with the permanent each comes from. */
  private combatRules(): { e: Extract<Effect, { kind: 'combatRule' }>; src: Perm }[] {
    if (!this.kindsInGame.has('combatRule')) return [];
    const out: { e: Extract<Effect, { kind: 'combatRule' }>; src: Perm }[] = [];
    for (const src of this.allPerms()) for (const e of src.card.effects) if (e.kind === 'combatRule') out.push({ e, src });
    return out;
  }

  /** Does a combat rule from `src` cover creature `perm`? */
  private ruleCovers(e: Extract<Effect, { kind: 'combatRule' }>, src: Perm, perm: Perm): boolean {
    switch (e.who) {
      case 'self': if (perm !== src) return false; break;
      case 'attached': if (src.attachedTo !== perm.id) return false; break;
      case 'opponents': if (perm.seat === src.seat) return false; break;
      default: break;
    }
    const f = e.filter;
    if (f) {
      if (f.goaded && !this.goaders(perm).length) return false;
      if (f.evenMv && perm.card.cmc % 2 !== 0) return false;
      if (f.maxPower !== undefined && this.power(perm) > f.maxPower) return false;
      if (f.subtype && !this.isType(perm, f.subtype)) return false;
      if (f.name && perm.card.name.toLowerCase() !== f.name) return false;
      if (f.minusCounters && perm.counters >= 0) return false;
      if (f.weaker && !(this.power(perm) < this.power(src))) return false;
    }
    if (e.unlessCreatures !== undefined && this.players[src.seat].battlefield.filter((q) => q !== src && q.card.isCreature).length >= e.unlessCreatures) return false;
    if (e.extraTurns && !this.inExtraTurn) return false;
    return true;
  }

  /** Must `perm` attack this combat if able? Goad, "attacks each combat if able", Bident of Thassa (rule 508.1d). */
  mustAttack(perm: Perm): boolean {
    if (this.goaders(perm).length) return true;
    // Xantcha, given away: attacks each combat if able.
    if (perm.neverAttacks !== undefined) return true;
    if (this.attackOrders.some((o) => o.kind === 'force' && o.seat !== perm.seat)) return true;
    return this.combatRules().some(({ e, src }) => e.rule === 'mustAttack' && this.ruleCovers(e, src, perm));
  }

  /** May `perm` attack the player in `seat` at all? "Can't attack", "can't attack you", "can't attack its owner" (rule 508.1c). */
  /** How a permanent is told apart from others with its name, for the legend rule's choice. */
  private legendLabel(perm: Perm): string {
    const bits: string[] = [];
    if (perm.isCommander) bits.push('commander');
    if (perm.token) bits.push('token');
    if (perm.tapped) bits.push('tapped');
    if (perm.card.isCreature) bits.push(`${this.power(perm)}/${this.toughness(perm)}`);
    if (perm.counters) bits.push(`${perm.counters > 0 ? '+1/+1' : '-1/-1'} counters: ${Math.abs(perm.counters)}`);
    if (perm.loyalty !== undefined) bits.push(`loyalty ${perm.loyalty}`);
    if (perm.damage) bits.push(`${perm.damage} damage`);
    if (perm.sick && perm.card.isCreature) bits.push('summoning sick');
    return `${perm.card.name}${bits.length ? ` (${bits.join(', ')})` : ''}`;
  }

  /** The player defending against an attack on this planeswalker or battle: a battle's protector, otherwise its controller (rule 506.2). */
  defenderOf(perm: Perm): number | undefined {
    return perm.card.isBattle ? perm.protector : perm.seat;
  }

  canAttack(perm: Perm, seat: number): boolean {
    if (this.hasKw(perm, "can't attack")) return false;
    if (perm.neverAttacks === seat) return false;
    for (const { e, src } of this.combatRules()) {
      if (e.rule === 'cantAttack' && this.ruleCovers(e, src, perm)) return false;
      if (e.rule === 'cantAttackYou' && src.seat === seat && this.ruleCovers(e, src, perm)) return false;
      if (e.rule === 'cantAttackOwner' && (perm.owner ?? perm.seat) === seat && this.ruleCovers(e, src, perm)) return false;
    }
    // Absolute Virtue's controller can be attacked, but nothing gets through, so a bot never needs to: left to the bot.
    return true;
  }

  /** Crawlspace: how many creatures can attack the player in `seat` this combat (Infinity: no limit). */
  attackLimit(seat: number): number {
    let limit = Infinity;
    for (const { e, src } of this.combatRules()) if (e.rule === 'maxAttackers' && src.seat === seat) limit = Math.min(limit, e.n ?? 2);
    return limit;
  }

  /** Creatures `p` could declare as attackers (rule 508.1a). */
  attackCandidates(p: PlayerState): Perm[] {
    return p.battlefield.filter((perm) => perm.card.isCreature && !perm.tapped && (!perm.sick || this.hasKw(perm, 'haste')) && (!this.hasKw(perm, 'defender') || this.usesToughness(perm)));
  }

  /** Could `blocker` legally block `attacker`? (rule 509.1b) */
  canBlock(blocker: Perm, attacker: Perm): boolean {
    if (!blocker.card.isCreature || blocker.tapped) return false;
    if (this.hasKw(attacker, 'unblockable')) return false;
    if (this.hasKw(attacker, 'flying') && !this.hasKw(blocker, 'flying') && !this.hasKw(blocker, 'reach')) return false;
    if (this.hasKw(blocker, "can't block")) return false;
    // "Goaded creatures your opponents control can't block", Void Winnower, Champion of Lambholt, Oketra (rule 509.1b).
    for (const { e, src } of this.combatRules()) if (e.rule === 'cantBlock' && this.ruleCovers(e, src, blocker) && (!e.vsYours || attacker.seat === src.seat)) return false;
    // Shadow blocks and is blocked only by shadow (702.28b). Fear: only artifact or black creatures block it (702.36b).
    if (this.hasKw(attacker, 'shadow') !== this.hasKw(blocker, 'shadow')) return false;
    if (this.hasKw(attacker, 'fear') && !blocker.card.isArtifact && !blocker.card.cost.pips.some((pip) => pip.includes('B'))) return false;
    for (const k of attacker.card.keywords) {
      const m = k.match(/^can't be blocked by power (\d+) or (less|greater)$/);
      if (m && (m[2] === 'less' ? this.power(blocker) <= +m[1] : this.power(blocker) >= +m[1])) return false;
    }
    // Skulk: can't be blocked by creatures with greater power (702.118b).
    if (this.hasKw(attacker, 'skulk') && this.power(blocker) > this.power(attacker)) return false;
    // Landwalk: unblockable while the defending player controls a land of that type (702.14c).
    for (const [kw, type] of LANDWALKS) if (this.hasKw(attacker, kw) && this.players[blocker.seat].battlefield.some((q) => q.card.isLand && hasSubtype(q.card, type))) return false;
    // The Ring, first ability: the ring-bearer can't be blocked by creatures with greater power.
    if (this.ringLevel(attacker) >= 1 && this.power(blocker) > this.power(attacker)) return false;
    // Lord of the Nazgûl: Wraiths have protection from ring-bearers, so a ring-bearer can't block them (rule 702.16e).
    // Protection from a color, from creatures, from Humans ...: can't be blocked by creatures with that quality.
    if (this.protectedFrom(attacker, blocker)) return false;
    return true;
  }

  /** Does `perm` have protection from the permanent `source`? (rule 702.16) */
  protectedFrom(perm: Perm, source: Perm): boolean {
    if (this.protectedFromCard(perm, source.card, source.seat)) return true;
    if (!this.kindsInGame.has('ringProtection') || this.players[source.seat].ringBearer !== source.id) return false;
    return this.players[perm.seat].battlefield.some((q) => q.card.effects.some((e) => e.kind === 'ringProtection' && e.when === 'static' && hasSubtype(perm.card, e.subtype)));
  }

  /** Creatures currently blocking `attacker`. */
  blockersOf(attacker: Perm): Perm[] {
    const out: Perm[] = [];
    for (const perm of this.allPerms()) if (perm.blocking === attacker.id) out.push(perm);
    return out;
  }

  attackers(): Perm[] {
    return this.players[this.activeSeat].battlefield.filter((perm) => perm.attacking !== null);
  }

  private *combat(p: PlayerState): Flow<void> {
    this.step = 'beginCombat';
    // "At the beginning of combat on your turn" (The Ozolith).
    if (this.kindsInGame.has('when:beginCombat')) this.fire(p, 'beginCombat');
    this.fireStep(p, 'combat');
    if (this.untapAttackersEachCombat) {
      const again = p.battlefield.filter((q) => q.tapped && q.attackedTurn === this.turnNumber && q.card.isCreature && !q.stun);
      for (const q of again) q.tapped = false;
      if (again.length) this.say(`${p.name} untaps ${again.length === 1 ? again[0].card.name : `${again.length} creatures`} that attacked this turn.`);
    }
    yield* this.priority();
    if (this.stopped(p)) return;

    // Declare attackers (508). Each creature may attack a different opponent (rule 802.2a).
    this.step = 'declareAttackers';
    const defenders = this.opponents(p).map((o) => o.seat);
    const candidates = this.attackCandidates(p).filter((c) => defenders.some((d) => this.canAttack(c, d)));
    if (!candidates.length || !defenders.length) return;
    // Creatures that must attack (goad, "attacks each combat if able", Bident of Thassa), and the players each may attack.
    // Goaded ones attack someone other than whoever goaded them if they can (rule 701.15b).
    // Paying a cost to attack is never required (rule 508.1d), so players with an attack tax don't count.
    const goaded: { attacker: number; defenders: number[] }[] = [];
    for (const c of candidates) {
      if (!this.mustAttack(c)) continue;
      const by = this.goaders(c);
      const free = defenders.filter((d) => this.canAttack(c, d) && this.attackTax(this.players[d], c) === 0);
      const others = free.filter((d) => !by.includes(d));
      const allowed = others.length ? others : free;
      if (allowed.length) goaded.push({ attacker: c.id, defenders: allowed });
    }
    // Planeswalkers opponents control can be attacked too (rule 508.1b); their controller is the defending player.
    // So can battles this player doesn't protect, their own Sieges included; the protector is the defending player.
    const planeswalkers = [
      ...this.opponents(p).flatMap((o) => o.battlefield.filter((q) => q.card.isPlaneswalker && !q.card.isBattle && !q.emblem && q.loyalty !== undefined)),
      ...this.allPerms().filter((q) => q.card.isBattle && q.protector !== undefined && q.protector !== p.seat && defenders.includes(q.protector)),
    ].map((q) => q.id);
    const declared = yield* ask<AttackDeclaration[] | null>({ kind: 'attackers', seat: p.seat, candidates: candidates.map((c) => c.id), defenders, ...(goaded.length ? { goaded } : {}), ...(planeswalkers.length ? { planeswalkers } : {}) });
    const attacking: Perm[] = [];
    // Crawlspace: no more than so many creatures can attack a player each combat (rule 508.1c).
    const room = (seat: number) => this.attackLimit(seat) - attacking.filter((a) => a.attacking === seat).length;
    const declare = (perm: Perm, seat: number, pw?: number) => {
      p.attackedTurn = this.turnNumber;
      perm.attacking = seat;
      perm.attackingPw = pw;
      perm.attackedTurn = this.turnNumber;
      if (!this.hasKw(perm, 'vigilance')) perm.tapped = true;
      attacking.push(perm);
    };
    for (const d of Array.isArray(declared) ? declared : []) {
      const perm = candidates.find((c) => c.id === d?.attacker);
      const pw = d?.planeswalker !== undefined && planeswalkers.includes(d.planeswalker) ? this.findPerm(d.planeswalker) : null;
      const chosen = pw ? this.defenderOf(pw) : d?.defender;
      if (!perm || perm.attacking !== null || chosen === undefined || !defenders.includes(chosen)) continue;
      const must = goaded.find((gd) => gd.attacker === perm.id);
      const seat = must && !must.defenders.includes(chosen) ? must.defenders[0] : chosen;
      if (!this.canAttack(perm, seat) || room(seat) <= 0) continue;
      // Propaganda: pay for each creature attacking that player, or it stays home (rule 508.1h).
      const tax = this.attackTax(this.players[seat], perm);
      if (tax > 0) {
        const plan = this.planPayment(p, NO_COST, tax, 0, perm);
        if (!plan) continue;
        this.commitPayment(p, plan);
        this.say(`${p.name} pays ${tax} for ${perm.card.name} to attack ${this.players[seat].name}.`);
      }
      declare(perm, seat, pw && this.defenderOf(pw) === seat ? pw.id : undefined);
    }
    for (const must of goaded) {
      const perm = candidates.find((c) => c.id === must.attacker);
      if (!perm || perm.attacking !== null) continue;
      // Left out: it attacks the most vulnerable player it may attack.
      const open = must.defenders.filter((d) => room(d) > 0);
      if (!open.length) continue;
      declare(perm, open.reduce((a, b) => (this.players[b].life < this.players[a].life ? b : a)));
      this.say(`${perm.card.name} ${perm.goadedBy?.length ? 'is goaded and ' : ''}must attack.`);
    }
    // War's Toll: once one of this player's creatures attacks, all of them attack if able.
    if (attacking.length && this.combatRules().some(({ e, src }) => e.rule === 'allAttack' && src.seat !== p.seat)) {
      const rest = candidates.filter((c) => c.attacking === null);
      for (const perm of rest) {
        const open = defenders.filter((d) => this.canAttack(perm, d) && this.attackTax(this.players[d], perm) === 0 && room(d) > 0);
        if (open.length) declare(perm, open.reduce((a, b) => (this.players[b].life < this.players[a].life ? b : a)));
      }
      if (rest.some((c) => c.attacking !== null)) this.say(`War's Toll: all of ${p.name}'s creatures that can attack do.`);
    }
    // No attackers: skip straight to the end of combat (rule 508.8).
    if (!attacking.length) return;
    for (const seat of defenders) {
      for (const pw of [undefined, ...planeswalkers]) {
        const group = attacking.filter((a) => a.attacking === seat && a.attackingPw === pw);
        const at = pw === undefined ? undefined : this.findPerm(pw);
        const what = !at ? this.players[seat].name : `${at.card.name} (${at.card.isBattle ? `protected by ${this.players[seat].name}` : this.players[seat].name})`;
        if (group.length) this.say(`${p.name} attacks ${what} with ${group.map((a) => `${a.card.name} ${this.power(a)}/${this.toughness(a)}`).join(', ')}.`);
      }
    }
    // Vengeful Ancestor: each goaded creature that attacks deals damage to its controller.
    if (this.kindsInGame.has('goadPunish')) {
      for (const src of this.allPerms()) for (const e of src.card.effects) {
        if (e.kind !== 'goadPunish') continue;
        const hit = attacking.filter((a) => this.goaders(a).length > 0);
        if (!hit.length) continue;
        this.loseLife(p, e.n * hit.length, this.players[src.seat], 'noncombat');
        this.say(`${hit.map((a) => a.card.name).join(', ')} ${hit.length > 1 ? 'are' : 'is'} goaded and deal${hit.length > 1 ? '' : 's'} ${e.n * hit.length} damage to ${p.name} (${src.card.name}).`);
      }
    }
    // Curses on the players being attacked (Curse of Opulence and friends).
    if (this.anyCurse) for (const seat of defenders) if (attacking.some((a) => a.attacking === seat)) this.curseEvent(this.players[seat], 'attacked', undefined, p);
    // The Ring, second ability: whenever the ring-bearer attacks, draw a card, then discard a card.
    for (const a of attacking) if (this.ringLevel(a) >= 2) yield* this.loot(p, `${a.card.name} carries the Ring`);
    // Myriad (702.116): a token copy attacking each other opponent, exiled at end of combat (here: at end of turn).
    for (const a of attacking) {
      if (!this.hasKw(a, 'myriad')) continue;
      for (const seat of defenders) {
        if (seat === a.attacking || !this.players[seat].alive) continue;
        const token = yield* this.makeCopyToken(p, this.copyCard(a.faceDown ? a.card : a.unlocked ?? a.card, {}), a.landInfo);
        if (!token) continue;
        token.tapped = true;
        token.attacking = seat;
        token.attackedTurn = this.turnNumber;
        token.atEnd = 'exile';
        this.anyTemporary = true;
        this.say(`${a.card.name} has myriad: a token copy attacks ${this.players[seat].name}.`);
      }
    }
    // Isshin: abilities that creatures attacking set off trigger an additional time.
    const times = this.triggerTimes(p, 'attack');
    for (let i = 0; i < times; i++) {
      for (const a of attacking) {
        const own = a.card.effects.filter((e) => e.when === 'attack' && e.scope === 'self');
        if (own.length) this.trigger(p, a.card, a.id, own);
        for (const eq of this.attachments(a)) {
          const hits = eq.card.effects.filter((e) => e.when === 'attack' && e.scope === 'self');
          if (hits.length) this.trigger(p, eq.card, eq.id, hits);
        }
      }
      for (const perm of p.battlefield) {
        const once = perm.card.effects.filter((e) => e.when === 'attack' && e.scope === 'oneOrMore');
        if (once.length) this.trigger(p, perm.card, perm.id, once);
        const each = perm.card.effects.filter((e) => e.when === 'attack' && e.scope === 'any');
        // "Whenever a nontoken creature you control attacks" (Mardu Ascendancy): tokens don't count.
        if (each.length) for (const a of attacking) {
          const hits = each.filter((e) => !(e.nontoken && a.token));
          if (hits.length) this.trigger(p, perm.card, perm.id, hits);
        }
      }
    }
    // "Whenever a player attacks (one of your opponents)" (Breena, Karazikar, Aurelia).
    this.playerAttacked(p, attacking);
    yield* this.priority();
    if (this.stopped(p)) return;

    // Declare blockers (509), each defending player in turn order.
    this.step = 'declareBlockers';
    const n = this.players.length;
    for (let i = 1; i < n; i++) {
      const d = this.players[(p.seat + i) % n];
      if (!d.alive) continue;
      const incoming = this.attackers().filter((a) => a.attacking === d.seat);
      const able = d.battlefield.filter((b) => b.card.isCreature && !b.tapped && incoming.some((a) => this.canBlock(b, a)));
      if (!incoming.length || !able.length) continue;
      // Berserker's Frenzy, 15-20: the caster chooses how these creatures block.
      const forced = this.forcedBlocks?.turn === this.turnNumber && this.forcedBlocks.by === p.seat ? this.forcedBlocks : null;
      const blocks = forced?.mode === 'choose'
        ? able.flatMap((b) => {
          const bad = incoming.find((a) => this.canBlock(b, a) && this.fightResult(a, b).killsBlocker && !this.fightResult(a, b).killsAttacker);
          return bad ? [{ blocker: b.id, attacker: bad.id }] : [];
        })
        : yield* ask<BlockDeclaration[] | null>({ kind: 'blockers', seat: d.seat, attackers: incoming.map((a) => a.id), candidates: able.map((b) => b.id) });
      const byAttacker = new Map<Perm, Perm[]>();
      for (const b of Array.isArray(blocks) ? blocks : []) {
        const blocker = able.find((c) => c.id === b?.blocker);
        const attacker = incoming.find((a) => a.id === b?.attacker);
        if (!blocker || !attacker || blocker.blocking !== null || !this.canBlock(blocker, attacker)) continue;
        blocker.blocking = attacker.id;
        byAttacker.set(attacker, [...(byAttacker.get(attacker) ?? []), blocker]);
      }
      // Berserker's Frenzy, 1-14: the creatures its caster chose (those that would lose a fight) block if able; their controller picks what they block.
      if (forced?.mode === 'must') {
        for (const b of able) {
          if (b.blocking !== null) continue;
          const options = incoming.filter((a) => this.canBlock(b, a));
          if (!options.some((a) => this.fightResult(a, b).killsBlocker)) continue;
          const pick = options.find((a) => !this.fightResult(a, b).killsBlocker) ?? options.find((a) => this.fightResult(a, b).killsAttacker) ?? options.reduce((x, y) => (this.power(y) < this.power(x) ? y : x));
          b.blocking = pick.id;
          byAttacker.set(pick, [...(byAttacker.get(pick) ?? []), b]);
        }
      }
      for (const [attacker, blockers] of byAttacker) {
        // Menace: can't be blocked except by two or more creatures (rule 702.111b).
        if (blockers.length < 2 && this.hasKw(attacker, 'menace')) {
          for (const b of blockers) b.blocking = null;
          byAttacker.delete(attacker);
          continue;
        }
        attacker.blocked = true;
      }
      if (byAttacker.size) this.say(`${d.name} blocks: ${[...byAttacker].map(([a, bs]) => `${bs.map((b) => b.card.name).join(' + ')} blocks ${a.card.name}`).join(', ')}.`);
    }
    // "Whenever ~ becomes blocked" and "whenever ~ attacks and isn't blocked" (rule 509.1h, 509.5).
    if (this.kindsInGame.has('when:blocked') || this.kindsInGame.has('when:unblocked')) {
      for (const a of this.attackers()) {
        const own = a.card.effects.filter((e) => (a.blocked ? e.when === 'blocked' : e.when === 'unblocked') && e.scope === 'self');
        if (own.length) this.trigger(p, a.card, a.id, own, 0, null, a.id);
        if (!a.blocked) continue;
        for (const perm of p.battlefield) {
          const hits = perm.card.effects.filter((e) => e.when === 'blocked' && e.scope === 'any');
          if (hits.length) this.trigger(p, perm.card, perm.id, hits, 0, null, a.id);
        }
      }
    }
    yield* this.priority();
    if (this.stopped(p)) return;

    // Combat damage (510). First and double strikers deal damage in a step of their own (510.4).
    this.step = 'combatDamage';
    this.struckFirst.clear();
    const fighting = [...this.allPerms()].filter((c) => c.attacking !== null || c.blocking !== null);
    if (fighting.some((c) => this.hasKw(c, 'first strike') || this.hasKw(c, 'double strike'))) {
      this.dealCombatDamage(p, true);
      yield* this.priority();
      if (this.stopped(p)) return;
    }
    this.dealCombatDamage(p, false);
    yield* this.priority();
    if (this.stopped(p)) return;

    this.step = 'endCombat';
    // The Ring, third ability: a creature that blocked the ring-bearer is sacrificed at end of combat.
    const doomed = this.attackers().filter((a) => this.ringLevel(a) >= 3).flatMap((a) => this.blockersOf(a));
    if (doomed.length) {
      this.say(`${doomed.map((b) => b.card.name).join(', ')} blocked the ring-bearer and ${doomed.length === 1 ? 'is' : 'are'} sacrificed.`);
      this.removePerms(doomed, 'graveyard');
      for (const b of doomed) this.sacrificed(this.players[b.seat], b);
      yield* this.checkState();
    }
    yield* this.priority();
  }

  /** A one-on-one fight, roughly: does the attacker kill the blocker, and the blocker the attacker? */
  fightResult(attacker: Perm, blocker: Perm): { killsBlocker: boolean; killsAttacker: boolean } {
    const kills = (from: Perm, to: Perm) => !this.hasKw(to, 'indestructible') && this.power(from) > 0 && (this.hasKw(from, 'deathtouch') || this.power(from) >= this.toughness(to) - to.damage);
    return { killsBlocker: kills(attacker, blocker), killsAttacker: kills(blocker, attacker) };
  }

  private endCombat() {
    // Decayed (rule 702.147): a creature with decayed that attacked is sacrificed at end of combat.
    const decayed = this.allPerms().filter((q) => q.attacking !== null && q.kwCounters?.includes('decayed'));
    if (decayed.length) {
      this.removePerms(decayed, 'graveyard');
      for (const q of decayed) this.sacrificed(this.players[q.seat]);
    }
    for (const q of this.players) {
      for (const perm of q.battlefield) {
        perm.attacking = null;
        perm.attackingPw = undefined;
        perm.blocked = false;
        perm.blocking = null;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Replacement and prevention effects (rules 614, 615), regeneration (701.19),
  // death and leave-the-battlefield replacements, trigger doublers (603.2d)
  // -------------------------------------------------------------------------

  /** Creature cards exiled "with" a permanent (Gisa, The Darkness Crystal), by the permanent's id. */
  private exiledWith = new Map<number, { card: SimCard; owner: number }[]>();
  /** Desecrated Tomb: the creature cards last seen in each watching player's graveyard. */
  private readonly graveyardSeen = new Map<number, Map<SimCard, number>>();
  /** Berserker's Frenzy: this turn, blocks are chosen by `by` ('choose') or creatures that would lose a fight block if able ('must'). */
  forcedBlocks?: { by: number; mode: 'choose' | 'must'; turn: number };
  /** Cards that come back at the beginning of the next end step (Cosmic Intervention, The Locust God). */
  private endReturns: { card: SimCard; owner: number; to: 'battlefield' | 'hand'; from: 'exile' | 'graveyard' }[] = [];
  /** While dies triggers are being noted: the creature that died (for "return that card"). */
  private diedNow: DiedCard | undefined;
  /** Damage redirected by a replacement (Phyrexian Vindicator, Deflecting Palm) isn't replaced again, so it can't loop. */
  private redirecting = false;

  /**
   * The damage `amount` from `src` (a permanent `srcPerm`, or a spell) controlled by `from` really deals to `to`,
   * after static replacement and prevention effects (rules 614.1a, 615): Torbran, Gisela, City on Fire, Ojer Axonil,
   * Phyrexian Vindicator, Iroas, Deflecting Palm. The affected player picks the order (rule 616.1), so multiplying
   * comes before adding, and prevention last.
   */
  damageAfter(from: PlayerState | null, src: SimCard | null, srcPerm: Perm | null, to: PlayerState | Perm, amount: number, combat: boolean): number {
    if (amount <= 0) return amount;
    const hasMods = this.kindsInGame.has('damageMod');
    const toPlayer = 'battlefield' in to;
    const victim = toPlayer ? to : this.players[to.seat];
    if (!hasMods && !(toPlayer && victim.preventNext)) return amount;
    const unpreventable = this.kindsInGame.has('noPrevent') && this.allPerms().some((q) => q.card.effects.some((e) => e.kind === 'noPrevent' && e.when === 'static'));
    let out = amount;
    const prevent: { q: Perm; e: Extract<Effect, { kind: 'damageMod' }> }[] = [];
    if (hasMods) {
      const plus: number[] = [];
      let times = 1;
      let floor = 0;
      for (const q of this.allPerms()) for (const e of q.card.effects) {
        if (e.kind !== 'damageMod' || e.when !== 'static') continue;
        if (!this.damageModApplies(q, e, from, src, srcPerm, to, combat)) continue;
        if (e.op === 'plus') plus.push(e.n);
        else if (e.op === 'times') times *= e.n;
        else if (e.op === 'toPower') floor = Math.max(floor, this.power(q));
        else prevent.push({ q, e });
      }
      out = out * Math.min(times, 64) + plus.reduce((a, b) => a + b, 0);
      if (floor > out) out = floor;
    }
    if (unpreventable) return out;
    for (const { q, e } of prevent) {
      const stopped = e.op === 'prevent' ? out : Math.ceil(out / 2);
      out -= stopped;
      if (stopped > 0) this.say(`${q.card.name} prevents ${stopped} damage${toPlayer ? ` to ${victim.name}` : ` to ${(to as Perm).card.name}`}.`);
      // Phyrexian Vindicator: "when damage is prevented this way, it deals that much damage to any other target".
      if (e.reflect && stopped > 0) this.trigger(this.players[q.seat], q.card, q.id, [{ kind: 'removal', target: 'creature', mode: 'damage', amount: stopped, anyTarget: true, when: 'resolve' }]);
    }
    // Deflecting Palm: the next damage an opponent's source would deal to this player this turn.
    if (toPlayer && victim.preventNext && from && from !== victim && out > 0) {
      const shield = victim.preventNext;
      victim.preventNext = undefined;
      this.say(`${shield.card.name} prevents ${out} damage to ${victim.name}.`);
      if (shield.reflect && !this.redirecting) {
        this.redirecting = true;
        const back = this.damageAfter(victim, shield.card, null, from, out, false);
        this.redirecting = false;
        const lost = this.loseLife(from, back, victim, 'noncombat');
        this.say(`${shield.card.name} deals ${lost} damage to ${from.name} (life ${from.life}).`);
      }
      out = 0;
    }
    return out;
  }

  private damageModApplies(q: Perm, e: Extract<Effect, { kind: 'damageMod' }>, from: PlayerState | null, src: SimCard | null, srcPerm: Perm | null, to: PlayerState | Perm, combat: boolean): boolean {
    const owner = this.players[q.seat];
    if (e.noncombat && combat) return false;
    if (e.from === 'yours' && from !== owner) return false;
    if (e.from === 'otherYours' && (from !== owner || srcPerm === q)) return false;
    if (e.color && !(src && cardColors(src).includes(e.color))) return false;
    if (e.subtypes && !(srcPerm?.card.isCreature && e.subtypes.some((t) => hasSubtype(srcPerm.card, t)))) return false;
    if (e.withCounter && !(srcPerm?.card.isCreature && srcPerm.counters > 0)) return false;
    if (e.revolt && owner.revoltTurn !== this.turnNumber) return false;
    const toPlayer = 'battlefield' in to;
    const victim = toPlayer ? to : this.players[to.seat];
    switch (e.to) {
      case 'any': return true;
      case 'opponents': return victim !== owner;
      case 'opponentPlayers': return toPlayer && victim !== owner;
      case 'you': return victim === owner;
      case 'self': return to === q;
      case 'otherCreatures': return !toPlayer && to !== q && to.seat === q.seat && to.card.isCreature;
      case 'attackers': return !toPlayer && to.seat === q.seat && to.attacking !== null;
      case 'attached': return !toPlayer && q.attachedTo === to.id;
    }
    return false;
  }

  /** Damage `from`'s spell or permanent deals to a creature (or other permanent), after replacement and prevention. */
  private damagePerm(from: PlayerState, src: SimCard | null, srcPerm: Perm | null, perm: Perm, amount: number, combat = false): number {
    const dealt = this.kindsInGame.has('damageMod') ? this.damageAfter(from, src, srcPerm, perm, amount, combat) : amount;
    this.noteDamaged(from.seat, perm, dealt);
    return dealt;
  }

  /** Remember damage dealt to a permanent when something cares about it (see damagedQueue). */
  private noteDamaged(seat: number, perm: Perm, amount: number) {
    if (amount <= 0) return;
    if (this.kindsInGame.has('damagedPunish') || (perm.bounty && this.kindsInGame.has('bountyDestroy'))) this.damagedQueue.push({ perm, seat, amount });
  }

  /**
   * Phyrexian Obliterator and Reaper of Sheoldred: the source's controller sacrifices that many permanents, or gets a
   * poison counter. Termination Facilitator: a damaged creature with a bounty counter is destroyed (here marked like
   * deathtouch damage, so indestructible and regeneration still save it).
   */
  private *damagedEvents(): Flow<void> {
    while (this.damagedQueue.length) {
      const { perm, seat, amount } = this.damagedQueue.shift()!;
      if (perm.bounty && this.allPerms().some((q) => q.seat !== perm.seat && q.card.effects.some((e) => e.kind === 'bountyDestroy'))) {
        perm.deathtouched = true;
        this.say(`${perm.card.name} has a bounty counter and is dealt damage: it is destroyed.`);
      }
      for (const e of perm.card.effects) {
        if (e.kind !== 'damagedPunish') continue;
        const v = this.players[seat];
        if (!v.alive) continue;
        if (e.what === 'poison') {
          if (this.countersBlocked()) continue;
          v.poison += 1;
          v.lastHitBy = perm.seat;
          this.say(`${v.name} gets a poison counter from damaging ${perm.card.name} (${v.poison} of 10).`);
          continue;
        }
        const perms = v.battlefield;
        const n = Math.min(amount, perms.length);
        if (!n) continue;
        const picks = n === perms.length ? perms.map((_, i) => i) : yield* this.choose(v, 'sacrifice', `${perm.card.name}: sacrifice ${n} permanent${n > 1 ? 's' : ''}.`, perms.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), n, n);
        const gone = picks.map((i) => perms[i]).filter(Boolean);
        this.say(`${v.name} sacrifices ${gone.map((q) => q.card.name).join(', ')} for damaging ${perm.card.name}.`);
        this.removePerms(gone, 'graveyard');
        for (const q of gone) this.sacrificed(v, q);
      }
    }
  }

  /** Life `p` would gain, after Sulfuric Vortex, Tainted Remedy and Alhammarret's Archive (rule 614.1a). */
  private lifeGained(p: PlayerState, amount: number): number {
    const rules: { owner: PlayerState; rule: 'noGain' | 'double' | 'lossInstead' }[] = [];
    for (const q of this.allPerms()) for (const e of q.card.effects) {
      if (e.kind !== 'lifeRule' || e.when !== 'static') continue;
      const owner = this.players[q.seat];
      if (e.who === 'all' || (e.who === 'opponents' && owner !== p) || (e.who === 'you' && owner === p)) rules.push({ owner, rule: e.rule });
    }
    // The player gaining life orders replacements (rule 616.1); "gains no life" is never worse for them.
    if (rules.some((r) => r.rule === 'noGain')) return 0;
    const loss = rules.find((r) => r.rule === 'lossInstead');
    if (loss) {
      const lost = this.loseLife(p, amount, loss.owner, 'noncombat');
      if (lost) this.say(`${p.name} loses ${lost} life instead of gaining it (life ${p.life}).`);
      return 0;
    }
    return amount * 2 ** Math.min(rules.filter((r) => r.rule === 'double').length, 4);
  }

  /** A regeneration shield replaces being destroyed: tap it, remove its damage, take it out of combat (rule 701.19). */
  private regenerated(perm: Perm): boolean {
    const i = perm.tempKw.indexOf('regenerate');
    if (i === -1) return false;
    perm.tempKw.splice(i, 1);
    perm.tapped = true;
    perm.damage = 0;
    perm.deathtouched = false;
    perm.attacking = null;
    perm.attackingPw = undefined;
    perm.blocking = null;
    this.say(`${perm.card.name} regenerates.`);
    return true;
  }

  /** The triggered abilities of `src` trigger this many additional times for `p` (Roaming Throne, Harmonic Prodigy, Delney). */
  private extraTriggers(p: PlayerState, src: Perm, effects: Effect[]): number {
    let n = 0;
    for (const q of p.battlefield) for (const e of q.card.effects) {
      if (e.kind !== 'triggerDoubler' || e.when !== 'static') continue;
      if (e.other && q === src) continue;
      if (e.attack) {
        // Firebender Ascension: a counter for each ability an attacking creature sets off, then copies from four counters on.
        if (!src.card.isCreature || src.attacking === null || !effects.some((f) => f.when === 'attack')) continue;
        this.addCharge(q, 1);
        if ((q.charge ?? 0) >= (e.charged ?? 0)) n++;
        continue;
      }
      const card = src.card;
      if (e.colorless) {
        if (cardColors(card).length || q === src) continue;
      } else if (!card.isCreature) continue;
      if (e.subtypes && !e.subtypes.some((t) => hasSubtype(card, t))) continue;
      if (e.chosenType && (q === src || !q.chosenType || !hasSubtype(card, q.chosenType))) continue;
      if (e.legendary && !card.isLegendary) continue;
      if (e.maxPower !== undefined && this.power(src) > e.maxPower) continue;
      n++;
    }
    return Math.min(n, 3);
  }

  /** "As ~ enters, choose a creature type" (Roaming Throne): the most common type among `p`'s creatures and creature cards. */
  private chooseCreatureType(p: PlayerState): string | undefined {
    const tally = new Map<string, number>();
    const cards = [...p.battlefield.map((q) => q.card), ...p.hand, ...p.library, ...p.commandZone];
    // Creatures with triggered abilities are what the choice is for; the rest count a little.
    for (const c of cards) {
      if (!c.isCreature) continue;
      const weight = c.effects.some((e) => e.when !== 'static' && e.when !== 'activated' && e.when !== 'loyalty') ? 3 : 1;
      for (const t of creatureTypes(c)) tally.set(t, (tally.get(t) ?? 0) + weight);
    }
    let best: string | undefined;
    for (const [t, n] of tally) if (!best || n > tally.get(best)!) best = t;
    return best;
  }

  private returnDiedFits(e: Extract<Effect, { kind: 'returnDied' }>, died: DiedCard | undefined): boolean {
    if (!died || !died.card.isCreature) return false;
    if (e.filter === 'noFlying' && died.flying) return false;
    if (e.filter === 'minusCounter' && died.counters >= 0) return false;
    if (e.subtype && !hasSubtype(died.card, e.subtype)) return false;
    return true;
  }

  /** Gisa, The Darkness Crystal: a creature of `controller`'s that would die is exiled instead. Returns the permanent doing it, or null. */
  private deathExiler(controller: PlayerState, perm: Perm): { q: Perm; e: Extract<Effect, { kind: 'deathExile' }> } | null {
    if (!this.kindsInGame.has('deathExile') || !perm.card.isCreature) return null;
    for (const o of this.opponents(controller)) for (const q of o.battlefield) for (const e of q.card.effects) {
      if (e.kind !== 'deathExile' || e.when !== 'static') continue;
      if (e.nontoken && perm.token) continue;
      return { q, e };
    }
    return null;
  }

  /** Nexus of Fate, Blightsteel Colossus: shuffled into the library instead of going to a graveyard. */
  private shufflesInstead(card: SimCard): boolean {
    return card.effects.some((e) => e.kind === 'shuffleInstead');
  }

  /** Cosmic Intervention, The Locust God: cards that come back at the beginning of the end step. */
  private *returnAtEnd(): Flow<void> {
    const due = this.endReturns;
    this.endReturns = [];
    for (const r of due) {
      const owner = this.players[r.owner];
      const zone = owner[r.from];
      const i = zone.indexOf(r.card);
      if (i === -1 || !owner.alive) continue;
      zone.splice(i, 1);
      if (r.to === 'hand') {
        owner.hand.push(r.card);
        this.say(`${r.card.name} returns to ${owner.name}'s hand.`);
      } else {
        this.say(`${r.card.name} returns to the battlefield.`);
        yield* this.enter(owner, r.card, false, 0, null);
      }
    }
  }

  /** Put a card from a graveyard or exile into its owner's library, `depth` cards from the top (0: the bottom). */
  private tuck(owner: PlayerState, card: SimCard, depth: number): boolean {
    for (const zone of [owner.graveyard, owner.exile]) {
      const i = zone.indexOf(card);
      if (i === -1) continue;
      zone.splice(i, 1);
      owner.library.splice(depth > 0 ? Math.min(depth - 1, owner.library.length) : owner.library.length, 0, card);
      this.say(`${card.name} is put into ${owner.name}'s library${depth > 0 ? ` ${['', 'on top', 'second from the top', 'third from the top'][depth] ?? `${depth}th from the top`}` : ' on the bottom'}.`);
      return true;
    }
    return false;
  }

  /** `by` attacks: "whenever a player attacks (one of your opponents / with three or more creatures)" (Breena, Karazikar, Aurelia). */
  private playerAttacked(by: PlayerState, attackers: Perm[]) {
    if (!this.kindsInGame.has('when:playerAttacks') || !attackers.length) return;
    for (const q of this.alivePlayers()) for (const perm of q.battlefield) {
      const hits = perm.card.effects.filter((e) => {
        if (e.when !== 'playerAttacks') return false;
        if (e.minAttackers && attackers.length < e.minAttackers) return false;
        // "One of your opponents": someone other than the watcher was attacked; "an opponent attacks another of your opponents": and the attacker is an opponent too.
        if (e.scope === 'opponents' && (by === q || !attackers.some((a) => a.attacking !== q.seat))) return false;
        if (e.scope === 'any' && !attackers.some((a) => a.attacking !== q.seat)) return false;
        return true;
      });
      if (hits.length) this.trigger(q, perm.card, perm.id, hits, attackers.length, null, undefined, undefined, by.seat);
    }
  }

  /** `by` targeted something: if it belongs to someone else, that's a crime (rule 700.13) for "whenever an opponent commits a crime". */
  private crime(by: PlayerState, t: Target | null) {
    if (!t || !this.kindsInGame.has('when:opponentCrime')) return;
    const seat = t.kind === 'player' ? t.seat : t.kind === 'perm' ? this.findPerm(t.id)?.seat : this.stack.find((s) => s.id === t.id)?.controller;
    if (seat === undefined || seat === by.seat) return;
    this.fireOpponents(by, 'opponentCrime');
  }

  /** Assign and deal one step of combat damage. All of it is dealt at once (rule 510.2). */
  private dealCombatDamage(p: PlayerState, firstStrikeStep: boolean) {
    const strikes = (c: Perm) => {
      const first = this.hasKw(c, 'first strike');
      const double = this.hasKw(c, 'double strike');
      if (firstStrikeStep) return first || double;
      return double || !this.struckFirst.has(c.id);
    };
    const toPerm: { from: Perm; to: Perm; amount: number }[] = [];
    const toPlayer: { from: Perm; to: PlayerState; amount: number }[] = [];

    for (const a of this.attackers()) {
      if (!strikes(a)) continue;
      const power = this.power(a);
      if (power <= 0) continue;
      const defender = this.players[a.attacking!];
      // Attacking a planeswalker: its damage goes to the planeswalker, or nowhere if it has left (rule 506.4).
      const pw = a.attackingPw !== undefined ? this.findPerm(a.attackingPw) : undefined;
      const hit = (amount: number) => {
        if (a.attackingPw === undefined) {
          if (defender.alive) toPlayer.push({ from: a, to: defender, amount });
        } else if (pw && this.defenderOf(pw) === defender.seat) toPerm.push({ from: a, to: pw, amount });
      };
      if (!a.blocked) {
        hit(power);
        continue;
      }
      const blockers = this.blockersOf(a);
      // Curse of Hospitality: creatures attacking the enchanted player have trample.
      const trample = this.hasKw(a, 'trample') || this.cursedBy(defender, 'hospitality').length > 0;
      if (!blockers.length) {
        // Blocked, but the blockers are gone: no damage unless it has trample (rule 702.19e).
        if (trample) hit(power);
        continue;
      }
      // Lethal damage to each blocker in turn; trample sends the rest to the player (702.19b).
      const deathtouch = this.hasKw(a, 'deathtouch');
      let left = power;
      for (const b of blockers) {
        const lethal = deathtouch ? 1 : Math.max(1, this.toughness(b) - b.damage);
        const dealt = Math.min(left, lethal);
        if (dealt > 0) toPerm.push({ from: a, to: b, amount: dealt });
        left -= dealt;
      }
      if (left > 0) {
        if (trample) hit(left);
        else toPerm.push({ from: a, to: blockers[0], amount: left });
      }
    }
    for (const b of this.allPerms()) {
      if (b.blocking === null || !strikes(b)) continue;
      const a = this.findPerm(b.blocking);
      const power = this.power(b);
      if (a && a.attacking !== null && power > 0) toPerm.push({ from: b, to: a, amount: power });
    }
    if (firstStrikeStep) for (const c of this.allPerms()) if ((c.attacking !== null || c.blocking !== null) && strikes(c)) this.struckFirst.add(c.id);
    // Fog, Maze of Ith, Inkshield: prevented combat damage is never dealt (rule 615.1), unless damage can't be prevented (Sunspine Lynx).
    const unpreventable = this.kindsInGame.has('noPrevent') && this.allPerms().some((q) => q.card.effects.some((e) => e.kind === 'noPrevent' && e.when === 'static'));
    if (this.fogAll && !unpreventable) {
      if (toPerm.length || toPlayer.length) this.say('All combat damage is prevented.');
      toPerm.length = 0;
      toPlayer.length = 0;
    }
    for (let i = toPerm.length - 1; i >= 0; i--) if (!unpreventable && (toPerm[i].from.fogged || toPerm[i].to.fogged)) toPerm.splice(i, 1);
    for (let i = toPlayer.length - 1; i >= 0; i--) {
      const d = toPlayer[i];
      if (unpreventable || !d.from.fogged && !d.to.fogged) continue;
      toPlayer.splice(i, 1);
      if (d.to.fogged?.tokens && !d.from.fogged) {
        // Inkshield: a 2/1 flying Inkling for each 1 damage prevented.
        const n = Math.min(d.amount, 20);
        for (let k = 0; k < n; k++) {
          const t = this.makePerm(d.to, tokenCard(2, 1, ['flying']), true);
          d.to.battlefield.push(t);
        }
        this.say(`${d.to.name} prevents ${d.amount} damage and makes ${n} Inkling${n > 1 ? 's' : ''}.`);
      }
    }

    // Damage replacement and prevention: Torbran, Gisela, Iroas, Phyrexian Vindicator (rules 614, 615).
    if (this.kindsInGame.has('damageMod') || this.players.some((q) => q.preventNext)) {
      // Deflecting Palm's "source of your choice": the biggest hit.
      if (this.players.some((q) => q.preventNext)) toPlayer.sort((a, b) => b.amount - a.amount);
      for (const d of [...toPerm, ...toPlayer]) d.amount = this.damageAfter(this.players[d.from.seat], d.from.card, d.from, d.to, d.amount, true);
      for (let i = toPerm.length - 1; i >= 0; i--) if (toPerm[i].amount <= 0) toPerm.splice(i, 1);
      for (let i = toPlayer.length - 1; i >= 0; i--) if (toPlayer[i].amount <= 0) toPlayer.splice(i, 1);
    }
    // Protection prevents damage from sources with its quality (rule 702.16e); Absolute Virtue's controller takes none from opponents.
    for (let i = toPerm.length - 1; i >= 0; i--) if (this.protectedFrom(toPerm[i].to, toPerm[i].from)) toPerm.splice(i, 1);
    for (let i = toPlayer.length - 1; i >= 0; i--) {
      if (!this.playerProtectedFrom(toPlayer[i].to, toPlayer[i].from.seat)) continue;
      this.say(`${toPlayer[i].to.name} has protection from ${this.players[toPlayer[i].from.seat].name}: ${toPlayer[i].from.card.name}'s damage is prevented.`);
      toPlayer.splice(i, 1);
    }
    const hitPlayer = new Set<Perm>();
    const before = new Map<PlayerState, number>();
    // Lifelink: all the damage one creature deals in a step is one life gain event; separate creatures are separate events (rule 702.15e).
    const linked = new Map<Perm, number>();
    for (const d of [...toPerm, ...toPlayer]) if (this.hasKw(d.from, 'lifelink')) linked.set(d.from, (linked.get(d.from) ?? 0) + d.amount);
    for (const d of toPerm) {
      // Wither and infect: damage to creatures as -1/-1 counters (rules 702.80, 702.90).
      // Damage to a battle removes that many defense counters (rule 120.3h).
      if (d.to.card.isBattle && d.to.defense !== undefined) {
        d.to.defense = Math.max(0, d.to.defense - d.amount);
        this.say(`${d.from.card.name} deals ${d.amount} damage to ${d.to.card.name} (defense ${d.to.defense}).`);
        this.noteDamaged(d.from.seat, d.to, d.amount);
        continue;
      }
      // Damage to a planeswalker removes that many loyalty counters (rule 120.3c).
      if (d.to.card.isPlaneswalker && d.to.loyalty !== undefined) {
        d.to.loyalty = Math.max(0, d.to.loyalty - d.amount);
        this.say(`${d.from.card.name} deals ${d.amount} damage to ${d.to.card.name} (loyalty ${d.to.loyalty}).`);
        if (!d.to.card.isCreature) {
          this.noteDamaged(d.from.seat, d.to, d.amount);
          continue;
        }
      }
      if (this.hasKw(d.from, 'wither') || this.hasKw(d.from, 'infect')) this.minusCounters(d.to, d.amount, this.players[d.from.seat]);
      else d.to.damage += d.amount;
      if (this.hasKw(d.from, 'deathtouch')) d.to.deathtouched = true;
      this.noteDamaged(d.from.seat, d.to, d.amount);
    }
    for (const d of toPlayer) {
      // The Mindskinner: prevented, and the player mills that many instead.
      if (this.damageMills(p, d.to, d.amount)) continue;
      if (!before.has(d.to)) before.set(d.to, d.to.life);
      d.amount = this.doubledDamage(d.to, d.amount, p, true);
      // Infect: poison counters instead of life loss (rule 702.90).
      if (this.hasKw(d.from, 'infect')) {
        if (!d.to.shielded && !this.countersBlocked()) {
          d.to.poison += d.amount;
          d.to.lastHitBy = p.seat;
          d.to.lastHitKind = 'combat';
          this.say(`${d.to.name} gets ${d.amount} poison (${d.to.poison} of 10).`);
        }
      } else this.loseLife(d.to, d.amount, p, 'combat');
      // Toxic: poison counters as well (rule 702.164).
      if (d.from.card.toxic && !d.to.shielded && !this.countersBlocked()) {
        d.to.poison += d.from.card.toxic;
        d.to.lastHitBy = p.seat;
        d.to.lastHitKind = 'combat';
        this.say(`${d.to.name} gets ${d.from.card.toxic} poison from toxic (${d.to.poison} of 10).`);
      }
      if (d.from.isCommander && !d.to.shielded) {
        // Commander damage counts per commander, whoever controls it now (rule 903.10a).
        const key = `${d.from.owner ?? d.from.seat}:${commanderName(d.from)}`;
        d.to.commanderDamage.set(key, (d.to.commanderDamage.get(key) ?? 0) + d.amount);
      }
      hitPlayer.add(d.from);
      if (this.monarch === d.to.seat && p.alive) this.setMonarch(p);
      // Curse of Hospitality: the top card of their library is exiled, and the attacker may play it this turn. It stays its owner's card (rule 108.3).
      for (let i = this.cursedBy(d.to, 'hospitality').length; i > 0 && d.to.library.length; i--) {
        const card = d.to.library.shift()!;
        d.to.exile.push(card);
        this.grantPlay(p, card, d.to, { until: 'turn', source: 'Curse of Hospitality' });
        this.say(`${d.to.name} exiles ${card.name} (Curse of Hospitality); ${p.name} may play it this turn.`);
      }
    }
    for (const [d, life] of before) this.say(`${d.name} takes ${life - d.life} (life ${d.life}).`);
    for (const [src, amount] of linked) this.gainLife(this.players[src.seat], amount);

    // The Ring, fourth ability: when the ring-bearer deals combat damage to a player, each opponent loses 3 life.
    for (const a of hitPlayer) {
      if (this.ringLevel(a) < 4) continue;
      for (const o of this.opponents(p)) this.loseLife(o, 3, p, 'noncombat');
      this.say(`The Ring: each opponent of ${p.name} loses 3 life.`);
    }
    // "Deals combat damage to a player" triggers.
    for (const a of hitPlayer) {
      const own = a.card.effects.filter((e) => e.when === 'combatDamage' && e.scope === 'self');
      // "You get that many {E}" (Aurora Shifter): the damage it dealt.
      if (own.length) this.trigger(p, a.card, a.id, own, toPlayer.filter((d) => d.from === a).reduce((n, d) => n + d.amount, 0), null, a.attacking ?? undefined, undefined, a.attacking ?? undefined);
      for (const eq of this.attachments(a)) {
        const hits = eq.card.effects.filter((e) => e.when === 'combatDamage' && e.scope === 'self');
        if (hits.length) this.trigger(p, eq.card, eq.id, hits, toPlayer.filter((d) => d.from === a).reduce((n, d) => n + d.amount, 0), null, a.attacking ?? undefined, undefined, a.attacking ?? undefined);
      }
    }
    // Prowl and cipher (rules 702.76, 702.99).
    if (hitPlayer.size) this.castingCombatHits(p, hitPlayer);
    if (hitPlayer.size) {
      for (const perm of p.battlefield) {
        const once = perm.card.effects.filter((e) => e.when === 'combatDamage' && e.scope === 'oneOrMore');
        if (once.length) this.trigger(p, perm.card, perm.id, once);
        const each = perm.card.effects.filter((e) => e.when === 'combatDamage' && e.scope === 'any');
        if (each.length) for (const a of hitPlayer) {
          const hits = each.filter((e) => !(e.nontoken && a.token));
          // The player it hit is what the ability is about (Strixhaven Stadium: "that player loses the game").
          if (hits.length) this.trigger(p, perm.card, perm.id, hits, 0, null, a.attacking ?? undefined);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Control, copies and redirects (rules 110.2, 111.10, 115.7, 614.1a, 707)
  // -------------------------------------------------------------------------

  /** What the previous part of the resolving spell or ability took or returned (Blue Sun's Twilight, Coiling Rebirth). */
  private lastAffected: Perm | null = null;
  /** False while nothing is borrowed until end of turn, sacrificed at the end step or a copy until end of turn. */
  private anyTemporary = false;
  /** Moonlit Meditation: seats whose first tokens this turn were already replaced. */
  private readonly moonlitUsed = new Set<number>();

  /** Does `perm` match a token copy's or "becomes a copy" filter, for `p` with the ability's source `src`? */
  copyMatches(p: PlayerState, perm: Perm, f: CopyFilter, src: Perm | null): boolean {
    if (perm.landInfo || (f.yours && perm.seat !== p.seat) || (f.other && perm === src)) return false;
    if ((f.nonlegendary && perm.card.isLegendary) || (f.nontoken && perm.token) || (f.attacking && perm.attacking === null)) return false;
    const c = perm.card;
    const is = (t: CopyFilter['types'][number]) => (t === 'creature' ? c.isCreature : t === 'artifact' ? c.isArtifact : c.isEnchantment);
    return f.both ? f.types.every(is) : f.types.some(is);
  }

  /** A token's card: the copied card with the copy effect's exceptions (rule 707.9). */
  private copyCard(card: SimCard, e: { nonlegendary?: boolean; legendary?: boolean; haste?: boolean; flying?: boolean; pt?: { p: number; t: number }; enchantment?: boolean }): SimCard {
    let c = e.nonlegendary && card.isLegendary ? this.nonlegendary(card) : card;
    // A copy of an instant or sorcery card on the battlefield (Myrkul copying a face-down Second Harvest): its spell
    // abilities do nothing there (rule 113.6), or they would run again as the token enters, without end.
    if (c.isInstant || c.isSorcery) c = { ...c, effects: c.effects.filter((f) => f.when !== 'resolve') };
    const kws = [...(e.haste && !c.keywords.includes('haste') ? ['haste'] : []), ...(e.flying && !c.keywords.includes('flying') ? ['flying'] : [])];
    if (e.legendary || kws.length || e.pt || e.enchantment) {
      c = {
        ...c, keywords: [...c.keywords, ...kws],
        ...(e.legendary ? { isLegendary: true } : {}),
        ...(e.pt ? { power: e.pt.p, toughness: e.pt.t } : {}),
        // Myrkul: "it's an enchantment and loses all other card types".
        ...(e.enchantment ? { isCreature: false, isArtifact: false, isPlaneswalker: false, isEnchantment: true, typeLine: 'Enchantment' } : {}),
      };
    }
    return c;
  }

  /** Make one token that copies `card` for `p` (its enters abilities happen, rule 707.2). */
  private *makeCopyToken(p: PlayerState, card: SimCard, landInfo?: LandInfo): Flow<Perm | null> {
    const made = yield* this.enter(p, card, false, 0, null, undefined, 'token');
    if (made && landInfo) made.landInfo = landInfo;
    return made;
  }

  /** Token copies (Kiki-Jiki, Helm of the Host, Second Harvest, March of Progress ...). */
  private *tokenCopies(p: PlayerState, e: Extract<Effect, { kind: 'tokenCopy' }>, src: Perm | null, x: number, target: Target | null): Flow<void> {
    if (e.minX !== undefined && x < e.minX) return;
    const models: { card: SimCard; from: Perm | null }[] = [];
    const fromPerm = (q: Perm | null) => {
      if (q) models.push({ card: q.faceDown ? q.card : q.unlocked ?? q.card, from: q });
    };
    switch (e.of) {
      case 'target': fromPerm(target?.kind === 'perm' ? this.findPerm(target.id) : null); break;
      case 'attached': fromPerm(src && src.attachedTo !== null ? this.findPerm(src.attachedTo) : null); break;
      case 'tokens': for (const q of p.battlefield.filter((t) => t.token && !t.landInfo)) fromPerm(q); break;
      case 'aimed': fromPerm(this.lastAffected && this.findPerm(this.lastAffected.id)); break;
      case 'subject': {
        const about = this.resolving?.about;
        const q = about?.permId !== undefined ? this.findPerm(about.permId) : null;
        if (q) {
          if (!e.filter || this.copyMatches(p, q, e.filter, src)) fromPerm(q);
        } else if (about && !e.filter) {
          // A card that left (Myrkul: "you may exile it. If you do, create a token that's a copy of that card").
          const owner = this.players[about.owner];
          if (e.enchantment) {
            if (!owner.graveyard.includes(about.card)) break;
            owner.graveyard.splice(owner.graveyard.indexOf(about.card), 1);
            owner.exile.push(about.card);
          }
          models.push({ card: about.card, from: null });
        } else if (!about) fromPerm(this.lastAffected && this.findPerm(this.lastAffected.id));
        break;
      }
    }
    if (!models.length) return;
    const each = Math.min(Math.max(e.n === -1 ? x : e.n, 1) * 2 ** this.doublers(p, 'tokens'), 20);
    let made = 0;
    for (const model of models) {
      const card = this.copyCard(model.card, e);
      for (let i = 0; i < each; i++) {
        const token = yield* this.makeCopyToken(p, card, model.from?.landInfo);
        if (!token) continue;
        made++;
        if (e.tapped || e.attacking) token.tapped = true;
        // "Tapped and attacking": the same player the copied creature (or the source) attacks.
        if (e.attacking && this.step !== 'end' && this.step !== 'cleanup') {
          const seat = model.from?.attacking ?? src?.attacking ?? null;
          if (seat !== null && this.players[seat].alive) token.attacking = seat;
        }
        if (e.end) {
          token.atEnd = e.end;
          this.anyTemporary = true;
        }
      }
      this.say(`${p.name} creates ${each === 1 ? 'a token copy' : `${each} token copies`} of ${model.card.name}.`);
    }
    if (made) yield* this.tokensMade(p, made, 'copy');
  }

  /**
   * Token replacement effects (rule 614.1a) after `p` made `n` tokens: Chatterfang's Squirrels, Peregrin Took's Food,
   * Xorn's extra Treasure, Academy Manufactor's "one of each". The extra tokens don't set these off again.
   */
  private *tokensMade(p: PlayerState, n: number, what: 'creature' | 'copy' | 'treasure' | 'food' | 'clue'): Flow<void> {
    if (n <= 0 || !this.kindsInGame.has('tokenReplace')) return;
    for (const perm of [...p.battlefield]) {
      for (const e of perm.card.effects) {
        if (e.kind !== 'tokenReplace' || e.when !== 'static') continue;
        switch (e.add) {
          case 'squirrels': {
            const squirrel = tokenCard(1, 1, []);
            for (let i = 0; i < Math.min(n, 20); i++) {
              const token = this.makePerm(p, squirrel, true);
              p.battlefield.push(token);
              this.creatureEntered(p, token);
            }
            this.say(`${perm.card.name}: ${p.name} also makes ${n} 1/1 Squirrel${n > 1 ? 's' : ''}.`);
            break;
          }
          case 'food':
            yield* this.makeFoodOrClue(p, 'food', 1);
            this.say(`${perm.card.name}: ${p.name} also makes a Food.`);
            break;
          case 'treasure':
            if (what !== 'treasure') break;
            p.treasures += 1;
            this.say(`${perm.card.name}: ${p.name} makes an extra Treasure.`);
            break;
          case 'oneOfEach': {
            if (what !== 'treasure' && what !== 'food' && what !== 'clue') break;
            if (what !== 'treasure') p.treasures += n;
            if (what !== 'food') yield* this.makeFoodOrClue(p, 'food', n);
            if (what !== 'clue') yield* this.makeFoodOrClue(p, 'clue', n);
            this.say(`${perm.card.name}: ${p.name} makes one of each (Treasure, Food, Clue).`);
            break;
          }
          case 'copies':
            break;
        }
      }
    }
  }

  /** Real Food and Clue tokens: artifacts with "{2}, {T}, sacrifice: gain 3 life" and "{2}, sacrifice: draw a card". */
  private *makeFoodOrClue(p: PlayerState, kind: 'food' | 'clue', n: number): Flow<void> {
    if (kind === 'food') {
      this.makeArtifactTokens(p, 'food', n, 0);
      return;
    }
    for (let i = 0; i < Math.min(n, 20); i++) p.battlefield.push(this.makePerm(p, CLUE_TOKEN, true));
  }

  /** Moonlit Meditation: the first tokens `p` makes each turn are copies of the enchanted permanent instead. */
  private moonlitHost(p: PlayerState): Perm | null {
    if (!this.kindsInGame.has('tokenReplace') || this.moonlitUsed.has(p.seat)) return null;
    for (const perm of p.battlefield) {
      if (!perm.card.effects.some((e) => e.kind === 'tokenReplace' && e.add === 'copies') || perm.attachedTo === null) continue;
      const host = this.findPerm(perm.attachedTo);
      if (host) return host;
    }
    return null;
  }

  /** "Becomes a copy" (Gogo, Mirage Mirror, Lazav, Protean Thaumaturge): its copiable values change (rule 707.2). */
  private becomeCopyOf(perm: Perm, model: SimCard, e: Extract<Effect, { kind: 'becomeCopy' }>) {
    const base = perm.printed ?? perm.copiedUntilEot ?? perm.card;
    // "Except it has this ability": the source keeps its copy ability (and Aurora Shifter its energy).
    const kept = e.keep || e.name ? base.effects.filter((f) => f.kind === 'becomeCopy' || (f.kind === 'energy' && f.when === 'combatDamage')) : [];
    const card: SimCard = {
      ...model, effects: [...model.effects.filter((f) => f.kind !== 'becomeCopy'), ...kept],
      ...(e.name ? { name: base.name, isLegendary: true } : {}),
      ...(e.hexproof && !model.keywords.includes('hexproof') ? { keywords: [...model.keywords, 'hexproof'] } : {}),
    };
    for (const f of card.effects) {
      this.kindsInGame.add(f.kind);
      this.kindsInGame.add(`when:${f.when}`);
    }
    if (e.untilEot) {
      perm.copiedUntilEot ??= perm.card;
      this.anyTemporary = true;
    } else if (!perm.printed) perm.printed = base;
    perm.card = card;
    this.say(`${base.name} becomes a copy of ${model.name}${e.untilEot ? ' until end of turn' : ''}.`);
  }

  /**
   * Change the target of a spell or ability (rule 115.7): Deflecting Swat, Misdirection, Spellskite. Only to a
   * target that is legal for it, and the spell's controller doesn't change.
   */
  private *redirectItem(p: PlayerState, e: Extract<Effect, { kind: 'redirect' }>, src: Perm | null, target: Target | null): Flow<void> {
    const item = target?.kind === 'stack' ? this.stack.find((s) => s.id === target.id) : undefined;
    if (!item) return;
    if (e.damage) {
      const lost = this.loseLife(p, item.card.cmc, null, 'noncombat');
      if (lost) this.say(`${p.name} loses ${lost} life (${this.resolvingCard?.name ?? 'redirect'}).`);
    }
    const caster = this.players[item.controller];
    const itemSrc = this.findPerm(item.sourceId);
    for (let i = 0; i < item.targets.length; i++) {
      const old = item.targets[i];
      if (!old) continue;
      const all = (this.targetCandidates(caster, item.effects[i], itemSrc) ?? []).filter((t) => !sameTarget(t, old) && !(t.kind === 'stack' && t.id === item.id));
      if (!all.length) continue;
      let pick: Target | null = null;
      if (e.to === 'self') {
        const self = src ? all.find((t) => t.kind === 'perm' && t.id === src.id) : undefined;
        if (!self || item.controller === p.seat) continue;
        pick = self;
      } else {
        const chosen = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `${item.label}: choose a new target (or keep ${this.describeTarget(old)}).`, card: item.card, effect: item.effects[i], candidates: all, cancellable: true });
        pick = chosen && all.some((c) => sameTarget(c, chosen)) ? chosen : null;
      }
      if (!pick) continue;
      item.targets[i] = pick;
      this.say(`${p.name} changes the target of ${item.label} to ${this.describeTarget(pick)}.`);
      this.becameTarget(caster, pick, item.kind === 'spell');
      break;
    }
    // Wyll's Reversal: a 15 or more on the d20 (about a third of the time with a decent creature out) copies it too.
    if (e.copy && this.rng.chance(0.35)) yield* this.copyItem(p, item);
  }

  /** Ivy, Gleeful Spellthief: copy a spell aimed at a single creature, with the copy aimed at the source. */
  private *copyToSource(p: PlayerState, src: Perm | null): Flow<void> {
    const orig = this.stack.find((s) => s.id === this.resolving?.subject);
    if (!orig || !src || !this.players[src.seat].battlefield.includes(src)) return;
    const aims = orig.targets.filter((t): t is Target => t !== null);
    if (aims.length !== 1 || aims[0].kind !== 'perm' || aims[0].id === src.id || !this.findPerm(aims[0].id)?.card.isCreature) return;
    const i = orig.targets.findIndex((t) => t !== null);
    const legal = this.targetCandidates(p, orig.effects[i], this.findPerm(orig.sourceId)) ?? [];
    if (!legal.some((t) => t.kind === 'perm' && t.id === src.id)) return;
    const yes = yield* this.choose(p, 'copySpell', `Copy ${orig.label}, aimed at ${src.card.name}?`, [{ label: 'Copy it', card: orig.card }], 0, 1);
    if (!yes.length) return;
    const targets = orig.targets.map((t) => (t ? { kind: 'perm' as const, id: src.id } : null));
    this.stack.push({ ...orig, id: this.nextId++, controller: p.seat, targets, isCommander: false, copy: true, flashback: false, label: `${orig.label} (copy)` });
    this.say(`${p.name} copies ${orig.label}, aimed at ${src.card.name}.`);
    this.becameTarget(p, targets[i], true);
  }

  /** Xantcha: enters under the control of an opponent of its owner's choice and attacks the others. */
  private *giveAway(p: PlayerState, perm: Perm): Flow<void> {
    const opponents = this.opponents(p);
    if (!opponents.length) return;
    const [pick] = opponents.length === 1 ? [0] : yield* this.choose(p, 'player', `${perm.card.name} enters under which opponent's control?`, opponents.map((o) => ({ label: o.name })), 1, 1);
    const to = opponents[pick ?? 0];
    perm.neverAttacks = p.seat;
    this.takeControl(perm, to);
  }

  /** The end step: Kiki-Jiki's tokens and Treacherous Urge's creature go (rule 603.7: "at the beginning of the next end step"). */
  private endStepCleanup() {
    if (!this.anyTemporary) return;
    for (const q of this.players) {
      for (const perm of q.battlefield.filter((t) => t.atEnd)) {
        this.say(`${perm.card.name} is ${perm.atEnd === 'exile' ? 'exiled' : 'sacrificed'} at the end step.`);
        this.removePerm(perm, perm.atEnd === 'exile' ? 'exile' : 'graveyard');
        if (perm.atEnd === 'sacrifice') this.sacrificed(q, perm);
      }
    }
  }

  /** The cleanup step: borrowed permanents go back (Act of Treason, Treasure Nabber) and copies until end of turn end. */
  private endOfTurnControl(active: PlayerState) {
    for (const q of this.players) q.copyNext = undefined;
    this.moonlitUsed.clear();
    if (!this.anyTemporary) return;
    for (const perm of this.allPerms()) {
      if (perm.copiedUntilEot) {
        perm.card = perm.copiedUntilEot;
        perm.copiedUntilEot = undefined;
      }
      const b = perm.borrowed;
      if (!b || (b.until === 'nextTurn' && !(active.seat === b.by && this.turnNumber > b.turn))) continue;
      perm.borrowed = undefined;
      if (perm.owner !== undefined) this.giveBack(perm);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A lockdown Aura's view of a card: a vanilla creature of `size`, or (with null) a land that taps for {C}. Cached per card. */
const LOCKED = new Map<string, WeakMap<SimCard, SimCard>>();
/** Cards with types added (Enchanted Evening, Encroaching Mycosynth): the version for each set of added types, and back to the card. */
const TYPED = new WeakMap<SimCard, Map<string, SimCard>>();
const TYPED_BASE = new WeakMap<SimCard, SimCard>();

/** The card as printed, without types an Enchanted Evening-style effect added on the battlefield (those end as it leaves, rule 611.3a). */
function printedCard(card: SimCard): SimCard {
  return TYPED_BASE.get(card) ?? card;
}
function typedCard(base: SimCard, types: ('artifact' | 'enchantment')[]): SimCard {
  const add = types.filter((t) => !(t === 'artifact' ? base.isArtifact : base.isEnchantment)).sort();
  if (!add.length) return base;
  const key = add.join(',');
  let byKey = TYPED.get(base);
  if (!byKey) TYPED.set(base, (byKey = new Map()));
  let out = byKey.get(key);
  if (!out) {
    const words = add.map((t) => (t === 'artifact' ? 'Artifact' : 'Enchantment')).join(' ');
    out = { ...base, isArtifact: base.isArtifact || add.includes('artifact'), isEnchantment: base.isEnchantment || add.includes('enchantment'), typeLine: `${words} ${base.typeLine}` };
    byKey.set(key, out);
    TYPED_BASE.set(out, base);
  }
  return out;
}
export function lockedCard(card: SimCard, size: { p: number; t: number } | null): SimCard {
  const key = size ? `${size.p}/${size.t}` : 'land';
  let cache = LOCKED.get(key);
  if (!cache) LOCKED.set(key, (cache = new WeakMap()));
  let out = cache.get(card);
  if (!out) {
    out = size
      ? { ...card, isCreature: true, isPlaneswalker: false, power: size.p, toughness: size.t, keywords: [], effects: [], scales: undefined, crew: undefined, loyalty: undefined }
      : { ...card, isCreature: false, isArtifact: false, isEnchantment: false, isPlaneswalker: false, power: 0, toughness: 0, keywords: [], scales: undefined, crew: undefined, loyalty: undefined, effects: [{ kind: 'mana', amount: 1, colors: ['C'], when: 'static' }] };
    cache.set(card, out);
  }
  return out;
}

/** The characteristics of a merged permanent: the top card's, with every card's abilities (rule 721.2a). */
export function mergedCard(faces: SimCard[]): SimCard {
  const [top, ...rest] = faces;
  if (!rest.length) return top;
  const effects = [...top.effects];
  const keywords = [...top.keywords];
  for (const f of rest) {
    for (const e of f.effects) if (!effects.includes(e)) effects.push(e);
    for (const k of f.keywords) if (!keywords.includes(k)) keywords.push(k);
  }
  return { ...top, effects, keywords, notes: [...top.notes, `Mutated over ${rest.map((f) => f.name).join(', ')}`] };
}

/** Commander damage is counted per commander card, whatever the permanent is called now. */
export function commanderName(perm: Perm): string {
  return perm.parts?.find((x) => x.commander)?.real?.name ?? perm.front?.name ?? perm.printed?.name ?? perm.card.name;
}

const FACE_DOWN: SimCard[] = [];
/** A face-down permanent: a nameless, colorless 2/2 creature with no abilities (rule 708.2). Disguise adds ward {2}. */
export function faceDownCard(ward: boolean): SimCard {
  const i = ward ? 1 : 0;
  FACE_DOWN[i] ??= {
    name: 'Face-down creature', cost: { generic: 3, pips: [], x: 0, life: 0 }, cmc: 0, typeLine: 'Creature',
    isLand: false, isCreature: true, isArtifact: false, isEnchantment: false, isPlaneswalker: false, isInstant: false, isSorcery: false,
    isLegendary: false, isBasic: false, power: 2, toughness: 2, keywords: ward ? ['ward'] : [], effects: [], value: 2, modeled: true,
    notes: ['Face down: a 2/2 with no name or abilities'],
  };
  return FACE_DOWN[i];
}

/** Two effects read from the same "cost: effect" line. */
/** How much a card does with charge counters on it, to choose where counters go. */
export function chargeUse(card: SimCard): number {
  let n = 0;
  for (const e of card.effects) {
    if (e.kind === 'chargeWin') n += 10;
    else if (e.kind === 'mana' && e.charge) n += 4;
    else if (e.kind === 'treasure' && e.byCharge) n += 3;
    else if (e.activation?.charge) n += e.activation.charge <= 5 ? 6 - e.activation.charge : 0;
    else if (e.minCharge) n += 2;
    else if (e.chargeAtResolve) n += 4;
  }
  // Spacecraft and Planets: counters bring them to their station thresholds.
  if (card.station) n += 5;
  return n;
}

function sameActivation(a: Effect, b: Effect): boolean {
  return !!a.activation && !!b.activation && a.activation.tap === b.activation.tap && JSON.stringify(a.activation.cost) === JSON.stringify(b.activation.cost);
}

/** Does a flash grant cover this card? `castCreature`: a creature spell was already cast this turn (The Blue Spirit). */
export function flashCovers(what: FlashFilter, card: SimCard, castCreature: boolean): boolean {
  const colorless = card.cost.pips.every((pip) => pip.every((m) => m === 'C')) && card.cost.life === 0;
  switch (what) {
    case 'all': return true;
    case 'sorcery': return card.isSorcery;
    case 'artifact': return card.isArtifact;
    case 'colorless': return colorless;
    case 'artifactOrColorless': return card.isArtifact || colorless;
    case 'noncreature': return !card.isCreature;
    case 'auraEquipment': return /\b(Aura|Equipment)\b/.test(card.typeLine);
    case 'creatureFirst': return card.isCreature && !castCreature;
  }
}

/** Every choice of spree modes (any nonempty set), or of one tier (rule 702.172). Bits index the modes. */
export function spreeChoices(card: SimCard): number[] {
  const spree = card.casting?.spree;
  if (!spree) return [];
  const n = spree.modes.length;
  if (spree.one) return spree.modes.map((_, i) => 1 << i);
  return Array.from({ length: (1 << n) - 1 }, (_, i) => i + 1);
}

export function spreeLabel(card: SimCard, modes: number): string {
  return (card.casting?.spree?.modes ?? []).filter((_, i) => modes & (1 << i)).map((m) => m.label).join(', ');
}

/** A rough measure of how much a permanent matters, for picking the least useful one. */
function threatOf(perm: Perm): number {
  return perm.card.value + perm.counters + (perm.isCommander ? 10 : 0) - (perm.token ? 1 : 0);
}

/** Does a card match a CardKind (see typesExile.ts)? */
export function matchesKind(card: SimCard, kind: CardKind): boolean {
  switch (kind) {
    case 'any': return true;
    case 'nonland': return !card.isLand;
    case 'land': return card.isLand;
    case 'basicLand': return card.isLand && card.isBasic;
    case 'permanent': return !card.isInstant && !card.isSorcery;
    case 'nonlandPermanent': return !card.isLand && !card.isInstant && !card.isSorcery;
    case 'creature': return card.isCreature;
    case 'instantSorcery': return card.isInstant || card.isSorcery;
    case 'instant': return card.isInstant;
    case 'artifact': return card.isArtifact;
    case 'enchantment': return card.isEnchantment;
    case 'artifactOrColorless': return !card.isLand && (card.isArtifact || cardColors(card).length === 0);
    case 'colorlessNonland': return !card.isLand && cardColors(card).length === 0;
    case 'legendaryCreature': return card.isCreature && card.isLegendary;
    case 'creatureInstantSorcery': return card.isCreature || card.isInstant || card.isSorcery;
    case 'none': return false;
  }
}

/** A card's colors, from the colored symbols in its mana cost (rule 202.2). */
export function cardColors(card: SimCard): Color[] {
  const out = new Set<Color>();
  for (const pip of card.cost.pips) for (const m of pip) if (m !== 'C') out.add(m);
  return [...out];
}

export function isInstantSpeed(card: SimCard): boolean {
  return card.isInstant || card.keywords.includes('flash');
}

/** Is this a card of the given color, for "exile a blue card from your hand"? Colors come from its mana cost. */
export function pitchable(card: SimCard, color: Color): boolean {
  return card.cost.pips.some((pip) => pip.includes(color));
}

/** An Enduring creature back as an enchantment: not a creature, so it neither attacks nor dies (the Enduring cycle). Cached per card. */
const ENCHANTMENT_ONLY = new WeakMap<SimCard, SimCard>();
export function enchantmentOnly(card: SimCard): SimCard {
  let out = ENCHANTMENT_ONLY.get(card);
  if (!out) {
    out = { ...card, isCreature: false, isEnchantment: true, power: 0, toughness: 0, typeLine: card.typeLine.replace(/\bCreature\b/, 'Enchantment').replace(/\bEnchantment Enchantment\b/, 'Enchantment'), effects: card.effects.filter((e) => !(e.when === 'creatureDies' && e.scope === 'self')) };
    ENCHANTMENT_ONLY.set(card, out);
  }
  return out;
}

/** The creature types on a card's type line ("Creature — Elf Druid" -> Elf, Druid). */
export function creatureTypes(card: SimCard): string[] {
  const m = card.typeLine.match(/—\s*(.*)$/);
  return m ? m[1].split(/\s+/).filter(Boolean) : [];
}

const subtypeCache = new Map<string, boolean>();
const LANDWALKS: [string, string][] = [['islandwalk', 'Island'], ['swampwalk', 'Swamp'], ['forestwalk', 'Forest'], ['mountainwalk', 'Mountain'], ['plainswalk', 'Plains']];

export function hasSubtype(card: SimCard, subtype: string): boolean {
  if (card.keywords.includes('changeling')) return true;
  const key = `${card.typeLine}|${subtype}`;
  let hit = subtypeCache.get(key);
  if (hit === undefined) {
    hit = new RegExp(`—.*\\b${subtype}\\b`, 'i').test(card.typeLine);
    if (subtypeCache.size > 20000) subtypeCache.clear();
    subtypeCache.set(key, hit);
  }
  return hit;
}

/** The creature types on a card's type line, lowercased. */
export function subtypesOf(card: SimCard): string[] {
  const after = card.typeLine.split(' — ')[1];
  return after ? after.toLowerCase().split(/\s+/).filter(Boolean) : [];
}

/** A protection or "hexproof from" keyword (see classifyCombat.ts). */
export function isProtection(kw: string): boolean {
  return kw.startsWith('pro:') || kw.startsWith('hexfrom:');
}

export function isAura(card: SimCard): boolean {
  return card.effects.some((e) => e.kind === 'equip' && e.aura);
}

export function sameTarget(a: Target, b: Target): boolean {
  if (a.kind === 'player') return b.kind === 'player' && a.seat === b.seat;
  return a.kind === b.kind && a.id === (b as { id: number }).id;
}

export function matchesFilter(card: SimCard, filter: CastFilter): boolean {
  switch (filter) {
    case 'any': return true;
    case 'noncreature': return !card.isCreature;
    case 'creature': return card.isCreature;
    case 'instantSorcery': return card.isInstant || card.isSorcery;
    case 'artifact': return card.isArtifact;
    case 'enchantment': return card.isEnchantment;
    case 'mutate': return !!card.mutate;
    case 'flash': return card.isInstant || card.keywords.includes('flash');
    case 'artifactInstantSorcery': return card.isArtifact || card.isInstant || card.isSorcery;
    case 'creatureOrPlaneswalker': return card.isCreature || card.isPlaneswalker;
    // Colorless: no colored mana symbols in its cost.
    case 'colorless': return card.cost.pips.every((pip) => pip.every((m) => m === 'C'));
  }
}

export function counterMatches(target: 'any' | 'noncreature' | 'creature', card: SimCard): boolean {
  if (target === 'any') return true;
  return target === 'creature' ? card.isCreature : !card.isCreature;
}

export function recursionMatches(what: RecursionWhat | undefined, card: SimCard): boolean {
  switch (what) {
    case 'any': return !card.isLand;
    case 'artifact': return card.isArtifact;
    case 'enchantment': return card.isEnchantment;
    case 'instantSorcery': return card.isInstant || card.isSorcery;
    case 'land': return card.isLand;
    case 'planeswalker': return card.isPlaneswalker;
    case 'creatureOrPlaneswalker': return card.isCreature || card.isPlaneswalker;
    case 'artifactOrCreature': return card.isArtifact || card.isCreature;
    case 'artifactOrEnchantment': return card.isArtifact || card.isEnchantment;
    case 'permanent': return !card.isInstant && !card.isSorcery;
    case 'legendary': return card.isLegendary && !card.isInstant && !card.isSorcery;
    default: return card.isCreature;
  }
}

/** "You control an artifact", "you control no Snakes": does this permanent count? */
function controlMatches(perm: Perm, what: string): boolean {
  const c = perm.card;
  switch (what.replace(/^(nonland|nontoken) /, '')) {
    case 'artifact': return c.isArtifact;
    case 'creature': return c.isCreature;
    case 'enchantment': return c.isEnchantment;
    case 'planeswalker': return c.isPlaneswalker;
    case 'land': return c.isLand || !!perm.landInfo;
    case 'permanent': return what.startsWith('nonland') ? !(c.isLand || perm.landInfo) : what.startsWith('nontoken') ? !perm.token : true;
    default: return hasSubtype(c, what);
  }
}

/** The permanent types of a card, for Muldrotha. */
export function permanentTypes(card: SimCard): string[] {
  const out: string[] = [];
  if (card.isCreature) out.push('creature');
  if (card.isArtifact) out.push('artifact');
  if (card.isEnchantment) out.push('enchantment');
  if (card.isPlaneswalker) out.push('planeswalker');
  if (card.isLand) out.push('land');
  if (!out.length && /battle/i.test(card.typeLine)) out.push('battle');
  return out;
}

const sizedCache = new WeakMap<SimCard, Map<number, SimCard>>();
/** The card as a P/P token copy (eternalize makes 4/4s). */
function sized(card: SimCard, size: number): SimCard {
  let byCard = sizedCache.get(card);
  if (!byCard) sizedCache.set(card, (byCard = new Map()));
  let out = byCard.get(size);
  if (!out) byCard.set(size, (out = { ...card, power: size, toughness: size }));
  return out;
}

export function removalMatches(target: string, card: SimCard): boolean {
  switch (target) {
    case 'creature': return card.isCreature;
    case 'permanent': return true;
    case 'noncreature': return !card.isCreature;
    case 'artifactEnchantment': return card.isArtifact || card.isEnchantment;
    case 'planeswalker': return card.isPlaneswalker;
    case 'land': return card.isLand;
    case 'nonbasicLand': return card.isLand && !card.isBasic;
    default: return false;
  }
}

function targetPrompt(card: SimCard, e: Effect): string {
  switch (e.kind) {
    case 'removal':
      if (e.mode === 'edict') return `${card.name}: which opponent sacrifices a creature?`;
      if (e.mode === 'damage') return `${card.name}: deal damage to which target?`;
      if (e.mode === 'fight') return `${card.name}: which creature takes the damage?`;
      return `${card.name}: ${e.mode} which ${e.target === 'artifactEnchantment' ? 'artifact or enchantment' : e.target}?`;
    case 'counter': return `${card.name}: counter which spell?`;
    case 'pump': return `${card.name}: which creature gets the bonus?`;
    case 'protect': return `${card.name}: protect which permanent?`;
    case 'damagePlayer': return `${card.name}: which opponent?`;
    case 'goad': return `${card.name}: goad which creature?`;
    case 'blink': return `${card.name}: exile and return which permanent?`;
    case 'copySpell': return `${card.name}: copy which ${e.what === 'ability' ? 'ability' : 'spell'}?`;
    default: return `${card.name}: choose a target.`;
  }
}

const NONE_EFFECTS: Effect[] = [];
/** Ichormoon Gauntlet's abilities for planeswalkers. */
const GAUNTLET_ABILITIES: Effect[] = [
  { kind: 'counters', n: 1, all: true, proliferate: true, when: 'loyalty', loyalty: 0 },
  { kind: 'extraTurn', when: 'loyalty', loyalty: -12 },
];

/** Phantasmal Image and Jace's Illusions: "when this becomes the target of a spell, sacrifice it". */
const SACRIFICE_SELF: Effect = { kind: 'sacrificeSelf', when: 'targeted', scope: 'self' };

const tokenCache = new Map<string, SimCard>();

/** The Army token amass makes (rule 701.47a): a 0/0 that grows with +1/+1 counters. */
let army: SimCard | null = null;
function armyCard(): SimCard {
  return (army ??= { ...tokenCard(0, 0, []), name: 'Army token', typeLine: 'Token Creature — Army' });
}

/** A Treasure that is a creature until end of turn (Vihaan, Goldwaker). */
const treasureCreatures = new Map<string, SimCard>();
function treasureCreatureCard(power: number, toughness: number): SimCard {
  const key = `${power}/${toughness}`;
  let card = treasureCreatures.get(key);
  if (!card) treasureCreatures.set(key, (card = { ...tokenCard(power, toughness, []), name: 'Treasure', typeLine: 'Token Artifact Creature — Treasure Construct Assassin', isArtifact: true }));
  return card;
}

function tokenCard(power: number, toughness: number, keywords: string[], subtypes: string[] = []): SimCard {
  const key = `${power}/${toughness}/${keywords.join(',')}/${subtypes.join(' ')}`;
  let card = tokenCache.get(key);
  if (!card) {
    const types = subtypes.map((t) => t[0].toUpperCase() + t.slice(1)).join(' ');
    card = {
      name: `${power}/${toughness}${types ? ` ${types}` : ''} token`,
      cost: { generic: 0, pips: [], x: 0, life: 0 },
      cmc: 0,
      typeLine: `Token Creature${types ? ` — ${types}` : ''}`,
      isLand: false, isCreature: true, isArtifact: false, isEnchantment: false, isPlaneswalker: false,
      isInstant: false, isSorcery: false, isLegendary: false, isBasic: false,
      power, toughness, keywords, effects: [],
      value: power + toughness * 0.5,
      modeled: true,
      notes: [],
    };
    tokenCache.set(key, card);
  }
  return card;
}

/**
 * The card a permanent really is, whatever it is copying or wearing (what goes to the graveyard). The physical card
 * comes first (face-down, front face, a Clone's own card), then what an effect has turned it into (a lockdown Aura).
 */
function realCard(perm: Perm): SimCard {
  return printedCard(perm.faceDown ?? perm.front ?? perm.printed ?? perm.unlocked ?? perm.copiedUntilEot ?? perm.uncrewed ?? perm.impendingCard ?? perm.card);
}

/** A trigger about a permanent on the battlefield (the creature that entered). */
function aboutPerm(perm: Perm): About {
  return { card: perm.card, owner: perm.owner ?? perm.seat, permId: perm.id };
}

/** A trigger about a creature that died: the card it was, in its owner's graveyard. */
function aboutDead(perm: Perm): About {
  return { card: realCard(perm), owner: perm.owner ?? perm.seat, ...(perm.counters < 0 ? { shrunk: true } : {}) };
}

/** Food and Clue tokens (rules 111.10b, 111.10f). */
const CLUE_TOKEN: SimCard = {
  ...tokenCard(0, 0, []), name: 'Clue', typeLine: 'Token Artifact — Clue', isCreature: false, isArtifact: true, notes: ['{2}, sacrifice: draw a card'], value: 1,
  effects: [{ kind: 'draw', n: 1, when: 'activated', activation: { cost: { generic: 2, pips: [], x: 0, life: 0 }, tap: false, sacrifice: true } }],
};
/** Card types among these cards (Emrakul, the Promised End; Nighthawk Scavenger). */
export function cardTypeCount(cards: SimCard[]): number {
  const types = new Set<string>();
  for (const c of cards) {
    for (const t of permanentTypes(c)) types.add(t);
    if (c.isInstant) types.add('instant');
    if (c.isSorcery) types.add('sorcery');
    if (/\bKindred\b|\bTribal\b/.test(c.typeLine)) types.add('kindred');
  }
  return types.size;
}

/** Colors among these cards, from the colored mana symbols in their costs (Faeburrow Elder). */
export function colorsAmong(cards: SimCard[]): number {
  const colors = new Set<string>();
  for (const c of cards) for (const pip of c.cost.pips) for (const m of pip) if (m !== 'C') colors.add(m);
  return colors.size;
}
