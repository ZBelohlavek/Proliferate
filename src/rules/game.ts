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

import { Rng } from '../engine/rng';
import type {
  CastFilter, Color, CurseAbility, CurseAct, Effect, Elimination, GameResult, LandInfo, LossReason, Mana, ManaCost, RecursionWhat, SimCard, SimDeck, Trigger,
} from '../engine/types';
import type {
  Action, Answer, AttackDeclaration, BlockDeclaration, ChoiceOption, ChooseReason, Decision, Perm, PlayerState, PriorityAnswer, StackItem, Step, Target,
} from './types';
import { assembledCombo, UPKEEP_COUNTERS, UPKEEP_WINS, WINCON_NAMES } from './wincons';

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
}

/** A triggered ability waiting to be put on the stack (rule 603.3). */
interface PendingTrigger {
  controller: number;
  card: SimCard;
  sourceId: number | null;
  effects: Effect[];
  /** The spell that set it off, for "copy that spell". */
  subject?: number;
  /** The number "that much" refers to (life gained, for Sanguine Bond). */
  x: number;
}

const PASS: Action = { type: 'pass' };
const NONE: Perm[] = [];
const NO_COST: ManaCost = { generic: 0, pips: [], x: 0, life: 0 };
/** Equip cost assumed when a deck was imported before equip costs were recorded. */
const DEFAULT_EQUIP: ManaCost = { generic: 2, pips: [], x: 0, life: 0 };
/** How much a Curse hurts the player it enchants, for choosing which one to move (Lynde). */
const CURSE_HARM: Record<CurseAct, number> = {
  cruel: 6, unbinding: 6, double: 5, torment: 5, thirst: 4, drain: 4, shrink: 4, burn: 3, hex: 3, misfortunes: 3, fraying: 3, surveil: 2, spite: 2, restless: 2,
  hospitality: 2, gold: 1, zombie: 1, gainLife: 1, draw: 1, attackerZombie: 1, obsessionDiscard: 1, obsessionDraw: 0,
};
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
  private phases: ('combat' | 'main')[] = [];
  /** Combat phases begun this turn (Genji Glove, Aurelia: "the first combat phase of the turn"). */
  combatsThisTurn = 0;
  /** Full Throttle, World at War: at the beginning of each combat this turn, untap all creatures that attacked this turn. */
  private untapAttackersEachCombat = false;
  private pending: PendingTrigger[] = [];
  /** Commanders that just went to a graveyard, exile or hand (rule 903.9). */
  private pendingCommander: { seat: number; card: SimCard; to: 'graveyard' | 'exile' | 'hand' | 'library' }[] = [];
  /** Attackers that dealt combat damage in the first-strike step (rule 510.4). */
  private struckFirst = new Set<number>();
  /** False while nothing is attached to anything, to skip the search for attachments. */
  private anyAttached = false;
  /** While a spell or ability resolves: its card (the source of a "when this dies" trigger may be gone). */
  private resolvingCard: SimCard | null = null;
  /** While a spell or ability resolves: the controller of the last thing it targeted. */
  private aimedSeat: number | null = null;
  /** Seats that take an extra turn after the current one (Time Warp). */
  private extraTurns: number[] = [];
  private extraTurnsTaken = 0;
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
  /** Effect kinds of every permanent made so far, so static effects no deck plays cost nothing to check. */
  private readonly kindsInGame = new Set<string>();
  /** Isochron Scepter: the card exiled with each one (keyed by permanent id). */
  readonly imprinted = new Map<number, SimCard>();
  /** Life each seat lost this turn (Bloodchief Ascension). */
  private lifeLostThisTurn: number[] = [];
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
      if ([...p.deck.commanders, ...p.deck.cards.map((e) => e.card)].some((c) => WINCON_NAMES.has(c.name))) this.winconSeats.add(seat);
    });
  }

  // -------------------------------------------------------------------------
  // Top level
  // -------------------------------------------------------------------------

  *run(): Flow<GameResult> {
    for (const p of this.inTurnOrder()) yield* this.openingHand(p);

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
          yield* this.turn(extra);
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

  private stopped(p: PlayerState): boolean {
    return this.over || !p.alive;
  }

  private *turn(p: PlayerState): Flow<void> {
    this.activeSeat = p.seat;
    this.turnNumber++;
    this.triggerBudget = 300;
    this.lifeLostThisTurn.fill(0);
    this.say(`— Round ${this.round}, ${p.name} (life ${p.life}) —`);

    // Untap step (502). No player gets priority.
    this.step = 'untap';
    this.fogAll = false;
    for (const q of this.players) q.fogged = undefined;
    const untapLimit = this.untapLimits(p);
    for (const perm of p.battlefield) {
      // A stun counter is removed instead of untapping (rule 122.1d).
      if (perm.stun && perm.tapped) perm.stun--;
      else if (perm.tapped && perm.landInfo && !untapLimit(perm)) { /* Back to Basics, Winter Orb */ }
      else if (!perm.card.noUntap) perm.tapped = false;
      perm.sick = false;
    }
    // Seedborn Muster, Unwinding Clock: other players' permanents untap in this untap step too.
    if (this.kindsInGame.has('untapAlways')) {
      for (const q of this.opponents(p)) {
        for (const src of q.battlefield) for (const e of src.card.effects) {
          if (e.kind !== 'untapAlways' || e.when !== 'static') continue;
          for (const perm of q.battlefield) {
            if (perm.stun || !(e.what === 'all' || (e.what === 'artifacts' && perm.card.isArtifact) || (e.what === 'self' && perm === src))) continue;
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
          perm.goadedBy = perm.goadedBy.filter((s) => s !== p.seat);
          if (!perm.goadedBy.length) perm.goadedBy = undefined;
        }
      }
    }
    p.landsPlayed = 0;
    p.graveyardTypes = undefined;
    p.shielded = false;
    for (const q of this.players) {
      q.spellsThisTurn = 0;
      q.drawsThisTurn = 0;
    }

    // Upkeep step (503).
    this.step = 'upkeep';
    this.cumulativeUpkeep(p);
    this.fire(p, 'upkeep');
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
    if (this.anyCurse) this.curseEvent(p, 'theirDraw');
    yield* this.priority();
    if (this.stopped(p)) return;

    this.step = 'main1';
    // Sagas get a lore counter as the precombat main phase begins (rule 714.3b).
    for (const perm of p.battlefield) if (perm.card.saga) this.addLore(p, perm);
    yield* this.priority();
    if (this.stopped(p)) return;

    // Combat, then the postcombat main phase. Additional combat (and main) phases are added to `phases` (rule 500.8).
    this.phases = ['combat', 'main'];
    this.combatsThisTurn = 0;
    this.untapAttackersEachCombat = false;
    while (this.phases.length) {
      const phase = this.phases.shift()!;
      if (phase === 'combat') {
        this.combatsThisTurn++;
        if (this.combatsThisTurn > 1) this.say(`${p.name} begins an additional combat phase.`);
        yield* this.combat(p);
        this.endCombat();
      } else {
        this.step = 'main2';
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
      if (!perm.dashed) continue;
      this.say(`${perm.card.name} returns to ${p.name}'s hand (dash).`);
      this.removePerm(perm, 'hand');
    }
    this.questCounters();
    if (this.anyCurse) {
      this.curseEvent(p, 'theirEnd');
      for (const q of this.alivePlayers()) this.curseEvent(q, 'eachEnd');
    }
    // Lynde: Curses put into her controller's graveyard come back attached to that player.
    if (this.curseReturns.length) yield* this.returnCurses();
    if (this.monarch === p.seat) {
      this.say(`${p.name} draws a card as the monarch.`);
      this.draw(p, 1);
    }
    this.endTemporaryTokens();
    yield* this.priority();
    if (this.stopped(p)) return;

    // Cleanup step (514): discard to hand size, then damage and "until end of turn" effects wear off.
    this.step = 'cleanup';
    if (p.hand.length > MAX_HAND && this.statics(p, 'noMaxHand') === 0) {
      const n = p.hand.length - MAX_HAND;
      const picks = yield* this.choose(p, 'discard', `Discard ${n} card${n > 1 ? 's' : ''} (hand size is ${MAX_HAND}).`, p.hand.map((card) => ({ label: card.name, card })), n, n);
      const cards = picks.map((i) => p.hand[i]);
      for (const c of cards) {
        p.hand.splice(p.hand.indexOf(c), 1);
        p.graveyard.push(c);
      }
      this.say(`${p.name} discards ${cards.map((c) => c.name).join(', ')}.`);
    }
    for (const q of this.players) {
      for (const perm of q.battlefield) {
        perm.damage = 0;
        perm.deathtouched = false;
        perm.tempP = 0;
        perm.tempT = 0;
        perm.tempKw = [];
        perm.fogged = undefined;
        if (perm.uncrewed) {
          perm.card = perm.uncrewed;
          perm.uncrewed = undefined;
        }
      }
    }
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
          this.say(`${p.name} would draw from an empty library and wins the game instead.`);
          for (const o of this.opponents(p)) {
            o.shielded = false;
            this.loseLife(o, Math.max(o.life, 1), p, 'noncombat');
          }
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
      if (this.kindsInGame.has('when:draw')) this.fire(p, 'draw');
      if (this.anyCurse) this.curseEvent(p, 'draws');
      if (quiet) continue;
      for (const o of this.players) {
        if (o === p || !o.alive) continue;
        for (const perm of o.battlefield) {
          // "Whenever an opponent draws their second card each turn" (Faerie Mastermind) counts that player's draws.
          const hits = perm.card.effects.filter((e) => e.when === 'opponentDraw' && (e.nth === undefined || e.nth === p.drawsThisTurn));
          if (hits.length) this.trigger(o, perm.card, perm.id, hits);
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
  private statics(p: PlayerState | null, kind: Effect['kind']): number {
    if (!this.kindsInGame.has(kind)) return 0;
    let n = 0;
    for (const q of p ? [p] : this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) for (const e of perm.card.effects) if (e.kind === kind && e.when === 'static') n++;
    }
    return n;
  }

  /** `p` sacrificed a permanent: "whenever you sacrifice" abilities trigger. */
  private sacrificed(p: PlayerState) {
    this.fire(p, 'sacrifice');
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
          this.sacrificed(q);
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
    const mutateHosts = this.mutateTargets(p).length > 0;
    const consider = (card: SimCard, from: 'hand' | 'command' | 'graveyard' | 'overload' | 'alt', mutate = false, kick = 0): boolean => {
      if (card.isLand || !mayCast || (from === 'command' && locked)) return false;
      if (!sorcery && !isInstantSpeed(card)) return false;
      if (mutate && !mutateHosts) return false;
      const fromCommand = from === 'command';
      const priced = kick ? this.kickedCard(card, kick) : this.castCard(card, mutate ? 'mutate' : from);
      if (mana < this.effectiveCost(p, priced, fromCommand)) return false;
      if (!this.canAfford(p, priced, fromCommand, 0)) return false;
      if (from !== 'overload' && !this.hasTargets(p, kick ? priced : card)) return false;
      const maxX = this.maxX(p, priced, fromCommand);
      // Kicker {X}: "X can't be 0" (Thieving Skydiver).
      if (kick && card.kicker!.cost.x > 0 && maxX < 1) return false;
      actions.push({ type: 'cast', card, from, maxX, ...(mutate ? { mutate } : {}), ...(kick ? { kick } : {}) });
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
      // Morph and disguise: cast face down as a 2/2 for {3} (rule 702.37c).
      if (card.morph && sorcery && mayCast && this.canAfford(p, this.castCard(card, 'faceDown'), false, 0)) actions.push({ type: 'cast', card, from: 'hand', maxX: 0, faceDown: true });
    }
    const seen = new Set<SimCard>();
    for (const card of p.graveyard) {
      if (seen.has(card)) continue;
      seen.add(card);
      if (this.graveyardCastable(p, card)) consider(card, 'graveyard');
      if (card.mutate?.fromGraveyard) consider(card, 'graveyard', true);
      if (card.graveyard?.how === 'return' && this.canReturnFromGraveyard(p, card, sorcery)) actions.push({ type: 'graveyard', card });
    }
    seen.clear();
    // Cycling works at any time you have priority (rule 702.29).
    for (const card of p.hand) {
      if (card.cycling && !seen.has(card) && this.planPayment(p, card.cycling.cost, 0, 0) !== null) {
        seen.add(card);
        actions.push({ type: 'cycle', card });
      }
    }

    for (const perm of p.battlefield) {
      for (const effect of perm.card.effects) {
        if (this.canActivate(p, perm, effect, sorcery)) actions.push({ type: 'activate', permId: perm.id, effect });
      }
      // Ygra: every other creature is a Food with "{2}, {T}, Sacrifice this permanent: You gain 3 life."
      if (this.foodAbility(perm) && this.canActivate(p, perm, FOOD, sorcery)) actions.push({ type: 'activate', permId: perm.id, effect: FOOD });
      // Turning a face-down permanent face up is a special action, any time you have priority (rule 116.2b).
      const up = this.faceUpCost(perm);
      if (up && this.planPayment(p, up, 0, 0) !== null) actions.push({ type: 'turnFaceUp', permId: perm.id });
      // Crew, kept simple: in your first main phase, so the Vehicle can attack.
      if (perm.card.crew && sorcery && this.step === 'main1' && this.crewFor(p, perm)) actions.push({ type: 'crew', permId: perm.id });
      // Station (rule 702.184a): tap another untapped creature to add charge counters, as a sorcery, until the last threshold.
      if (sorcery && this.stationRoom(perm) && this.stationCrew(p, perm).length) actions.push({ type: 'station', permId: perm.id });
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
    return true;
  }

  private islands(p: PlayerState): Perm[] {
    return p.battlefield.filter((q) => q.landInfo && /\bIsland\b/.test(q.card.typeLine));
  }

  private canActivate(p: PlayerState, perm: Perm, e: Effect, sorcery: boolean): boolean {
    if (perm.activations >= 20) return false;
    if (e.kind === 'equip') {
      // Equip: sorcery speed, target creature you control (rule 702.6).
      if (e.aura || !sorcery) return false;
      if (!p.battlefield.some((q) => q.card.isCreature && q.id !== perm.attachedTo && q !== perm)) return false;
      return this.planPayment(p, e.cost ?? DEFAULT_EQUIP, 0, 0) !== null;
    }
    if (e.when === 'loyalty') {
      // One loyalty ability per planeswalker per turn, at sorcery speed (rule 606.3).
      if (!sorcery || perm.loyaltyUsed || perm.loyalty === undefined) return false;
      if ((e.loyalty ?? 0) < 0 && perm.loyalty < -(e.loyalty ?? 0)) return false;
      const targets = this.targetCandidates(p, e, perm);
      return targets === null || targets.length > 0;
    }
    if (e.when !== 'activated' || !e.activation) return false;
    // Boast: only once this creature attacked this turn, and once each turn (rule 702.142).
    if (e.activation.boast && (perm.attackedTurn !== this.turnNumber || perm.usedThisTurn.includes(e))) return false;
    if (e.kind === 'transform' && (e.rider || !sorcery || !perm.card.back)) return false;
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
    if (act.tapCreatures && p.battlefield.filter((q) => q.card.isCreature && !q.tapped && !(act.tap && q === perm)).length < act.tapCreatures) return false;
    if (this.planPayment(p, act.cost, 0, 0, act.tap ? perm : undefined) === null) return false;
    const candidates = this.targetCandidates(p, e, perm);
    return candidates === null || candidates.length > 0;
  }

  /** Does every targeted part of this spell have something to target? (rule 601.2c) */
  private hasTargets(p: PlayerState, card: SimCard): boolean {
    if (card.isInstant || card.isSorcery) {
      for (const e of card.effects) {
        if (e.when !== 'resolve') continue;
        const candidates = this.targetCandidates(p, e, null);
        if (candidates !== null && candidates.length === 0) return false;
      }
      return true;
    }
    if (isAura(card)) return this.auraCandidates(p).length > 0;
    return true;
  }

  private *perform(p: PlayerState, action: Action, x: number): Flow<boolean> {
    switch (action.type) {
      case 'land': {
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
        return yield* this.cast(p, action.card, action.from === 'command', Math.max(action.kick && action.card.kicker?.cost.x ? 1 : 0, Math.min(action.maxX, Math.floor(x) || 0)), action.from, !!action.mutate, action.kick ?? 0);
      case 'crew': {
        const perm = this.findPerm(action.permId);
        const crew = perm ? this.crewFor(p, perm) : null;
        if (!perm || !crew) return false;
        for (const c of crew) c.tapped = true;
        perm.uncrewed = perm.card;
        perm.card = this.castCard(perm.card, 'crewed');
        this.say(`${p.name} crews ${perm.card.name} with ${crew.map((c) => c.card.name).join(', ')}.`);
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
        this.toGraveyard(p, card, false);
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
        return true;
      }
      case 'activate':
        return yield* this.activate(p, action.permId, action.effect);
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
      this.sacrificed(p);
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

  private manaSources(p: PlayerState, exclude?: Perm): ManaSource[] {
    const out: ManaSource[] = [];
    let energy = p.energy;
    // Ultima: lands that tap for {C} add an additional {C}.
    const boost = this.kindsInGame.has('colorlessBoost') && this.statics(p, 'colorlessBoost') > 0;
    for (const perm of p.battlefield) {
      if (perm === exclude) continue;
      if (perm.landInfo) {
        if (perm.tapped) continue;
        const perArtifact = perm.card.effects.some((e) => e.kind === 'mana' && e.perArtifact);
        if (perArtifact) {
          out.push({ perm, colors: this.landProduces(perm), amount: Math.max(1, p.battlefield.filter((q) => q.card.isArtifact).length - 1) });
          continue;
        }
        out.push({ perm, colors: this.landProduces(perm), amount: boost && this.colorlessLand(perm) ? 2 : 1 });
        continue;
      }
      if (perm.sick && perm.card.isCreature && !this.hasKw(perm, 'haste')) continue;
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
        if (perm.tapped) continue;
        if (e.energy && energy < e.energy) continue;
        const amount = e.charge === 'tap' ? charge : e.charge === 'grow' ? charge + 1 : e.amount;
        if (amount <= 0) continue;
        const src: ManaSource = { perm, colors: e.colors, amount, ...(e.energy ? { energy: e.energy } : {}), ...(e.charge ? { charge: e.charge } : {}) };
        if (!best || amount > best.amount || (amount === best.amount && e.colors === 'any' && best.colors !== 'any')) best = src;
      }
      if (best) {
        if (best.energy) energy -= best.energy;
        out.push(best);
      }
    }
    // Goldspan Dragon: "Treasures you control have '{T}, Sacrifice this artifact: Add two mana of any one color.'"
    const treasure = this.kindsInGame.has('treasureBoost') && this.statics(p, 'treasureBoost') > 0 ? 2 : 1;
    for (let i = 0; i < p.treasures; i++) out.push({ perm: null, colors: 'any', amount: treasure });
    return out;
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
    if (p.treasures) p.identity.forEach((c) => set.add(c));
    return set;
  }

  landCount(p: PlayerState): number {
    let n = 0;
    for (const perm of p.battlefield) if (perm.landInfo) n++;
    return n;
  }

  private costReduction(p: PlayerState, card: SimCard): number {
    let n = 0;
    for (const perm of p.battlefield) {
      for (const e of perm.card.effects) {
        if (e.kind === 'costReduction' && matchesFilter(card, e.filter)) n += e.amount;
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
      else count = p.graveyard.length;
      n += count * d.amount;
    }
    return n;
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
        if (e.kind === 'spellTax' && (e.all || q !== p) && (e.filter === 'any' || !card.isCreature)) tax += e.amount;
      }
    }
    return tax;
  }

  effectiveCost(p: PlayerState, card: SimCard, fromCommand = false, x = 0): number {
    if (this.isFree(p, card)) return this.spellTax(p, card);
    const base = card.cost.generic + card.cost.x * x + this.commanderTax(p, card, fromCommand) + this.spellTax(p, card);
    return Math.max(0, base - this.costReduction(p, card)) + card.cost.pips.length;
  }

  /**
   * Work out which sources pay for a cost. Returns the sources and how many
   * units each contributes, or null if it can't be paid. Greedy: pay the
   * hardest colored pips first with the least flexible sources.
   */
  private planPayment(p: PlayerState, cost: ManaCost, extraGeneric: number, reduction: number, exclude?: Perm): Map<ManaSource, number> | null {
    const sources = this.manaSources(p, exclude);
    const remaining = sources.map((s) => s.amount);
    const used = new Map<ManaSource, number>();
    const can = (s: ManaSource, pip: Mana[]) => {
      if (s.colors === 'any') return pip.some((m) => m === 'C' || p.identity.includes(m as Color) || p.identity.length === 0);
      return pip.some((m) => (s.colors as Mana[]).includes(m));
    };
    const flex = (s: ManaSource) => (s.colors === 'any' ? 6 : s.colors.length) + (s.perm === null ? 10 : 0);
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
      if (src.perm && src.charge === 'spend') src.perm.charge = Math.max(0, (src.perm.charge ?? 0) - units);
      else if (src.perm) {
        src.perm.tapped = true;
        if (src.perm.landInfo) lands.push(src.perm);
        if (src.energy) p.energy = Math.max(0, p.energy - src.energy);
        // Empowered Autogenerator: the counter goes on as part of the ability.
        if (src.charge === 'grow') src.perm.charge = (src.perm.charge ?? 0) + 1;
      } else if (units > 0) {
        // Each Treasure is its own source (two mana with Goldspan Dragon) and is sacrificed on its own: Korvold and Juri trigger once for each.
        p.treasures -= 1;
        this.sacrificed(p);
      }
    }
    if (lands.length && this.kindsInGame.has('tapPunish')) this.landsTapped(p, lands);
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
    return this.planPayment(p, card.cost, card.cost.x * x + this.commanderTax(p, card, fromCommand) + extra + tax, this.costReduction(p, card));
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
    if (this.hasKw(perm, 'shroud')) return false;
    return !(perm.seat !== by.seat && this.hasKw(perm, 'hexproof'));
  }

  private wardCost(by: PlayerState, t: Target | null): number {
    if (!t || t.kind !== 'perm') return 0;
    const perm = this.findPerm(t.id);
    return perm && perm.seat !== by.seat && this.hasKw(perm, 'ward') ? WARD_COST : 0;
  }

  /**
   * What an effect could target if `p` used it now. null means the effect
   * doesn't target; an empty list means it targets but nothing is legal.
   */
  targetCandidates(p: PlayerState, e: Effect, src: Perm | null): Target[] | null {
    switch (e.kind) {
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
        return this.stack.filter((s) => s.kind === 'spell' && counterMatches(e.target, s.card) && !s.card.keywords.includes('uncounterable')).map((s) => ({ kind: 'stack', id: s.id }));
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
      case 'blink':
        return p.battlefield.filter((q) => q !== src && this.blinkable(p, q, e)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'copySpell':
        if (e.what === 'trigger') return null;
        if (e.what === 'ability') return this.stack.filter((s) => s.kind === 'ability' && s.controller === p.seat && s.sourceId !== src?.id && s.effects.length > 0).map((s) => ({ kind: 'stack', id: s.id }));
        return this.stack.filter((s) => s.kind === 'spell' && (s.card.isInstant || s.card.isSorcery) && (!e.yours || s.controller === p.seat)).map((s) => ({ kind: 'stack', id: s.id }));
      case 'stun':
        return this.opponents(p).flatMap((o) => o.battlefield).filter((q) => !q.card.isLand && (!e.tapped || (q.tapped && q.card.isCreature)) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
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
      case 'blight':
        return this.allPerms().filter((q) => q.landInfo && !this.blighted.has(q.id) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'animate':
        return p.battlefield.filter((q) => q.card.isEnchantment && !q.card.isCreature && !q.unlocked && !isAura(q.card) && !q.card.curse && !/\bAura\b/.test(q.card.typeLine) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      case 'steal':
        if (e.payEnergy !== undefined && e.from === 'battlefield') return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && q.card.cmc <= p.energy + e.payEnergy! && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        if (e.from === 'library') return this.opponents(p).filter((o) => o.library.some((c) => c.isCreature)).map((o) => ({ kind: 'player', seat: o.seat }));
        // Garland: "a creature that player controls", the new monarch.
        if (e.when === 'opponentMonarch') return this.allPerms().filter((q) => q.seat === this.monarch && q.seat !== p.seat && q.card.isCreature && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        if (e.what === 'artifact') return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isArtifact && (e.maxCmc === undefined || e.maxCmc < 0 || q.card.cmc <= e.maxCmc) && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
        return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
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
    if (e?.kind === 'removal' && e.mode !== 'edict' && !this.removable(e.target, perm)) return false;
    return true;
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
      const cost: ManaCost = {
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
  castCard(card: SimCard, from: 'hand' | 'command' | 'graveyard' | 'overload' | 'crewed' | 'mutate' | 'faceDown' | 'alt'): SimCard {
    if (from === 'hand' || from === 'command') return card;
    let cache = this.altCards.get(from);
    if (!cache) this.altCards.set(from, (cache = new WeakMap()));
    let alt = cache.get(card);
    if (!alt) {
      alt = from === 'faceDown'
        ? faceDownCard(!!card.morph?.ward)
        : from === 'crewed'
        ? { ...card, isCreature: true }
        : from === 'alt'
        ? { ...card, cost: { ...card.altCost!.mana, life: card.altCost!.mana.life + (card.altCost!.life ?? 0) } }
        : from === 'mutate'
        ? { ...card, cost: card.mutate?.cost ?? card.cost }
        : from === 'graveyard'
        ? { ...card, cost: card.flashback ?? (card.graveyard?.how === 'cast' ? card.graveyard.cost : card.cost) }
        : { ...card, cost: card.overload?.cost ?? card.cost, effects: card.overload?.effects ?? card.effects };
      cache.set(card, alt);
    }
    return alt;
  }

  private *cast(p: PlayerState, card: SimCard, fromCommand: boolean, x: number, from: 'hand' | 'command' | 'graveyard' | 'overload' | 'alt' = 'hand', mutate = false, kicks = 0): Flow<boolean> {
    if (kicks && (!card.kicker || (from !== 'hand' && from !== 'command') || mutate || (!card.kicker.multi && kicks > 1))) return false;
    const flashback = from === 'graveyard' && !mutate;
    const zone = fromCommand ? p.commandZone : from === 'graveyard' ? p.graveyard : p.hand;
    if (!zone.includes(card) || (flashback && !this.graveyardCastable(p, card)) || (from === 'overload' && !card.overload)) return false;
    if (mutate && (!card.mutate || (from === 'graveyard' && !card.mutate.fromGraveyard))) return false;
    if (from === 'alt' && !(card.altCost && this.altCostAllowed(p, card))) return false;
    /** How it is cast from the graveyard: flashback, the card's own keyword (escape, retrace, disturb), or a permission (Muldrotha). */
    const graveyardWay = !flashback ? null : card.flashback ? 'flashback' : card.graveyard?.how === 'cast' ? card.graveyard.label : 'permission';
    let finality = false;
    const priced = kicks ? this.kickedCard(card, kicks) : this.castCard(card, mutate ? 'mutate' : from);
    const permanent = !card.isInstant && !card.isSorcery;
    const effects = permanent ? [] : priced.effects.filter((e) => e.when === 'resolve');

    // Choose targets (601.2c), then pay (601.2h). Ward is charged as part of the cost.
    let ward = 0;
    const affordable = (t: Target) => this.canAfford(p, priced, fromCommand, x, ward + this.wardCost(p, t));
    let attachTo: Target | null = null;
    // Curses enchant a player (rule 303.4). Only opponents are offered: a Curse on yourself is never what you want.
    if (permanent && card.curse) {
      const candidates: Target[] = this.opponents(p).map((o) => ({ kind: 'player', seat: o.seat }));
      if (!candidates.length) return false;
      attachTo = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `Curse which player with ${card.name}?`, card, effect: null, candidates, cancellable: true });
      if (!attachTo || !candidates.some((c) => sameTarget(c, attachTo!))) return false;
    }
    if (permanent && isAura(card)) {
      const candidates = this.auraCandidates(p).filter(affordable);
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
    const targets: (Target | null)[] = [];
    for (const e of effects) {
      const all = this.targetCandidates(p, e, null);
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
    if (card.extraCost) {
      // Additional costs are paid as the spell is cast (rule 601.2h): sacrifice if possible, else discard.
      const c = card.extraCost;
      const fodder = c.sacrifice ? this.sacrificeChoices(p, c.sacrifice) : [];
      if (c.sacrifice && fodder.length && !(c.either && !fodder.some((q) => q.token || q.card.value < 2) && p.hand.length > 1)) {
        const pick = fodder.length === 1 ? [0] : yield* this.choose(p, 'sacrifice', `Sacrifice which permanent to cast ${card.name}?`, fodder.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
        const gone = fodder[pick[0] ?? 0];
        this.say(`${p.name} sacrifices ${gone.card.name} to cast ${card.name}.`);
        this.removePerm(gone, 'graveyard');
        this.sacrificed(p);
      } else if (c.discard) {
        const options = p.hand.filter((h) => h !== card);
        const picks = yield* this.choose(p, 'discard', `Discard ${c.discard} card${c.discard > 1 ? 's' : ''} to cast ${card.name}.`, options.map((h) => ({ label: h.name, card: h })), c.discard, c.discard);
        for (const h of picks.map((i) => options[i])) {
          p.hand.splice(p.hand.indexOf(h), 1);
          this.toGraveyard(p, h, false);
        }
      }
    }
    if (graveyardWay && graveyardWay !== 'flashback' && graveyardWay !== 'permission') {
      const use = card.graveyard!;
      // Escape: exile other cards from your graveyard. Retrace: discard a land card.
      if (use.exileOthers) {
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

    zone.splice(zone.indexOf(card), 1);
    if (fromCommand) {
      p.commanderCasts.set(card.name, (p.commanderCasts.get(card.name) ?? 0) + 1);
      if (p.commanderRound === null) p.commanderRound = this.round;
    } else {
      p.castNames.add(card.name);
    }
    p.spellsThisTurn++;
    const item: StackItem = {
      id: this.nextId++, kind: 'spell', controller: p.seat, card, effects, targets, x,
      isCommander: p.deck.commanders.includes(card), sourceId: null, attachTo, label: card.name,
    };
    if (graveyardWay === 'flashback' || (graveyardWay !== 'permission' && card.graveyard?.exiled && flashback)) item.flashback = true;
    if (finality) item.finality = true;
    if (mutateOnto !== undefined) item.mutateOnto = mutateOnto;
    if (from === 'alt' && (card.altCost?.evoke || card.altCost?.dash)) item.alt = card.altCost.evoke ? 'evoke' : 'dash';
    if (kicks) item.kicked = kicks;
    this.stack.push(item);
    const aimed = [attachTo, ...targets].filter((t): t is Target => t !== null);
    const kickText = !kicks ? '' : card.kicker!.offspring ? ' paying offspring' : card.kicker!.multi ? ` kicked ${kicks} time${kicks > 1 ? 's' : ''}` : ' kicked';
    this.say(`${p.name} casts ${card.name}${kickText}${priced.cost.x ? ` (X=${x})` : ''}${mutate ? ` for its mutate cost onto ${this.findPerm(mutateOnto ?? null)?.card.name ?? 'a creature'}` : ''}${fromCommand ? ' from the command zone' : graveyardWay === 'permission' ? ' from their graveyard' : graveyardWay ? ` with ${graveyardWay}` : from === 'graveyard' ? ' from the graveyard' : from === 'overload' ? ' with overload' : item.alt ? ` with ${item.alt}` : from === 'alt' ? ' without paying its mana cost' : ''}${aimed.length ? ` targeting ${aimed.map((t) => this.describeTarget(t)).join(', ')}` : ''}.`);

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

    // "Their second spell each turn", "your first spell during each opponent's turn".
    const counts = (e: Effect) => (e.nth === undefined || e.nth === p.spellsThisTurn) && (e.turn === undefined || (e.turn === 'own') === (this.activeSeat === p.seat));
    // "Whenever you cast a spell" triggers (they go on the stack above the spell). Veyran doubles them for instants and sorceries.
    const times = card.isInstant || card.isSorcery ? this.triggerTimes(p, 'magecraft') : 1;
    for (const perm of p.battlefield) {
      const hits = perm.card.effects.filter((e) => e.when === 'cast' && matchesFilter(card, e.castFilter ?? 'any') && card.cmc >= (e.minCmc ?? 0) && counts(e));
      if (hits.length) for (let i = 0; i < times; i++) this.trigger(p, perm.card, perm.id, hits, 0, null, item.id);
    }
    // "Whenever an opponent casts a spell" (Rhystic Study).
    for (const o of this.opponents(p)) {
      for (const perm of o.battlefield) {
        const hits = perm.card.effects.filter((e) => e.when === 'opponentCast' && matchesFilter(card, e.castFilter ?? 'any') && counts(e));
        if (hits.length) this.trigger(o, perm.card, perm.id, hits, 0, null, item.id);
      }
    }
    if (this.anyCurse) this.curseEvent(p, 'casts', card);
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

  private *activate(p: PlayerState, permId: number, e: Effect): Flow<boolean> {
    const perm = p.battlefield.find((q) => q.id === permId);
    if (!perm || !this.canActivate(p, perm, e, this.sorcerySpeed(p))) return false;

    if (e.kind === 'equip') {
      const candidates: Target[] = p.battlefield.filter((q) => q.card.isCreature && q.id !== perm.attachedTo && q !== perm).map((q) => ({ kind: 'perm', id: q.id }));
      const t = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `Equip ${perm.card.name} to which creature?`, card: perm.card, effect: e, candidates, cancellable: true });
      if (!t || !candidates.some((c) => sameTarget(c, t))) return false;
      const plan = this.planPayment(p, e.cost ?? DEFAULT_EQUIP, 0, 0);
      if (!plan) return false;
      this.commitPayment(p, plan);
      perm.activations++;
      this.stack.push({ id: this.nextId++, kind: 'ability', controller: p.seat, card: perm.card, effects: [], targets: [], x: 0, isCommander: false, sourceId: perm.id, attachTo: t, label: `Equip ${perm.card.name}` });
      this.say(`${p.name} equips ${perm.card.name} to ${this.describeTarget(t)}.`);
      this.becameTarget(p, t, false);
      return true;
    }

    if (e.when === 'loyalty') {
      let aim: Target | null = null;
      const options = this.targetCandidates(p, e, perm);
      if (options !== null) {
        aim = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(perm.card, e), card: perm.card, effect: e, candidates: options, cancellable: true });
        if (!aim || !options.some((c) => sameTarget(c, aim!))) return false;
      }
      perm.loyalty = (perm.loyalty ?? 0) + (e.loyalty ?? 0);
      perm.loyaltyUsed = true;
      this.say(`${p.name} uses ${perm.card.name} (${(e.loyalty ?? 0) > 0 ? '+' : ''}${e.loyalty}, loyalty ${perm.loyalty})${aim ? ` targeting ${this.describeTarget(aim)}` : ''}.`);
      this.stack.push({ id: this.nextId++, kind: 'ability', controller: p.seat, card: perm.card, effects: [e], targets: [aim], x: 0, isCommander: false, sourceId: perm.id, attachTo: null, label: `${perm.card.name} ability` });
      this.becameTarget(p, aim, false);
      return true;
    }
    const act = e.activation!;
    let target: Target | null = null;
    const all = this.targetCandidates(p, e, perm);
    if (all !== null) {
      const candidates = all.filter((t) => this.planPayment(p, act.cost, this.wardCost(p, t), 0, act.tap ? perm : undefined) !== null);
      if (!candidates.length) return false;
      target = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(perm.card, e), card: perm.card, effect: e, candidates, cancellable: true });
      if (!target || !candidates.some((c) => sameTarget(c, target!))) return false;
    }
    const plan = this.planPayment(p, act.cost, this.wardCost(p, target), 0, act.tap ? perm : undefined);
    if (!plan) return false;
    let fodder: Perm | null = null;
    if (act.sacCreature) {
      const creatures = p.battlefield.filter((q) => q.card.isCreature);
      if (!creatures.length) return false;
      const pick = creatures.length === 1 ? [0] : yield* this.choose(p, 'sacrifice', `Sacrifice which creature to ${perm.card.name}?`, creatures.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
      fodder = creatures[pick[0] ?? 0];
    }
    this.commitPayment(p, plan);
    p.life -= act.cost.life;
    if (act.tap) perm.tapped = true;
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
        p.graveyard.push(c);
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
      this.sacrificed(p);
    }
    if (act.sacrifice) {
      this.removePerm(perm, 'graveyard');
      this.sacrificed(p);
    }
    // Parts of the same ability that were read as separate effects (a transform after a loot).
    const riders = perm.card.effects.filter((r) => r.kind === 'transform' && r.rider && r !== e && sameActivation(r, e));
    this.stack.push({
      id: this.nextId++, kind: 'ability', controller: p.seat, card: perm.card, effects: [e, ...riders], targets: [target, ...riders.map(() => null)], x: act.energy === -1 ? paidX : 0,
      isCommander: false, sourceId: act.sacrifice || fodder === perm ? null : perm.id, attachTo: null, label: `${perm.card.name} ability`,
    });
    this.becameTarget(p, target, false);
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
  private trigger(controller: PlayerState, card: SimCard, sourceId: number | null, effects: Effect[], x = 0, left: Perm | null = null, subject?: number) {
    if (!controller.alive || !effects.length) return;
    const src = left ?? this.findPerm(sourceId);
    const kept: Effect[] = [];
    for (const e of effects) {
      if (this.triggerBudget-- <= 0) return;
      // "If ~ has four or more quest counters on it" (rule 603.4).
      if (e.minCharge && (src?.charge ?? 0) < e.minCharge) continue;
      // "If" conditions the classifier couldn't read hold about half the time.
      if (e.chance !== undefined && !this.rng.chance(e.chance)) continue;
      if (e.oncePerTurn && src) {
        if (src.usedThisTurn.includes(e)) continue;
        src.usedThisTurn.push(e);
      }
      kept.push(e);
    }
    if (kept.length) this.pending.push({ controller: controller.seat, card, sourceId, effects: kept, x, ...(subject !== undefined ? { subject } : {}) });
  }

  /** Abilities of `p`'s opponents' permanents that trigger on something that happened to `p` (x = how much). */
  private fireOpponents(p: PlayerState, when: Trigger, x = 0) {
    for (const o of this.opponents(p)) this.fire(o, when, x);
  }

  private flushDepth = 0;

  /**
   * `t` just became the target of a spell (`spell`) or ability controlled by `by` (rule 603.2):
   * "whenever ~ becomes the target" abilities (Fblthp, Goldspan Dragon, valiant, Nadu, Battle Mammoth) trigger,
   * and Phantasmal Image and Jace's Illusions are sacrificed.
   */
  private becameTarget(by: PlayerState, t: Target | null, spell: boolean) {
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
  private fire(p: PlayerState, when: Trigger, x = 0) {
    for (const perm of p.battlefield) {
      const hits = perm.card.effects.filter((e) => e.when === when);
      if (hits.length) this.trigger(p, perm.card, perm.id, hits, x);
    }
  }

  /**
   * Panharmonicon, Isshin, Drivnod, Veyran: how many times an ability of `p`'s
   * permanents triggers for this event (1 + one for each matching doubler `p` controls).
   */
  private triggerTimes(p: PlayerState, event: 'enters' | 'permanentEnters' | 'attack' | 'dies' | 'magecraft', entering?: SimCard): number {
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
    if (!this.kindsInGame.has('when:creatureEnters')) return;
    const times = this.triggerTimes(p, 'permanentEnters', entering.card);
    for (const perm of p.battlefield) {
      if (perm === entering) continue;
      const hits = perm.card.effects.filter((e) => e.when === 'creatureEnters' && !(e.nontoken && entering.token));
      if (hits.length) for (let i = 0; i < times; i++) this.trigger(p, perm.card, perm.id, hits);
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
        const all = this.targetCandidates(p, e, src);
        if (all === null) {
          effects.push(e);
          targets.push(null);
          continue;
        }
        const candidates = all.filter((c) => this.wardCost(p, c) === 0 || this.planPayment(p, NO_COST, WARD_COST, 0) !== null);
        // No legal target: that part of the ability is removed (rule 603.3d).
        if (!candidates.length) continue;
        // Blink triggers say "you may" or "up to one": the controller may choose no target.
        const optional = e.kind === 'blink';
        const pick = candidates.length === 1 && !optional
          ? candidates[0]
          : yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(t.card, e), card: t.card, effect: e, candidates, cancellable: optional });
        if (optional && !pick) continue;
        const chosen = pick && candidates.some((c) => sameTarget(c, pick)) ? pick : candidates[0];
        if (this.wardCost(p, chosen)) {
          const plan = this.planPayment(p, NO_COST, WARD_COST, 0);
          if (plan) this.commitPayment(p, plan);
        }
        effects.push(e);
        targets.push(chosen);
      }
      if (!effects.length) continue;
      this.stack.push({ id: this.nextId++, kind: 'ability', controller: p.seat, card: t.card, effects, targets, x: t.x, isCommander: false, sourceId: t.sourceId, attachTo: null, label: `${t.card.name} trigger`, ...(t.subject !== undefined ? { subject: t.subject } : {}) });
      for (const aim of targets) this.becameTarget(p, aim, false);
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
    const legal = item.targets.map((t, i) => (t ? this.targetStillLegal(p, item.effects[i], t) : true));
    const attachLegal = item.attachTo ? this.targetStillLegal(p, null, item.attachTo) : true;
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
        yield* this.merge(p, host, item.card, item.isCommander);
        return;
      }
      // With its target gone, a mutating creature spell just enters as a creature (rule 702.140b).
      this.say(`${item.card.name} has nothing to mutate onto and enters as a creature.`);
    }
    if (item.kind === 'spell' && !item.card.isInstant && !item.card.isSorcery) {
      // A copy of a permanent spell becomes a token (rule 707.10f).
      const perm = yield* this.enter(p, item.card, item.isCommander, item.x, item.attachTo, undefined, item.copy ? 'token' : item.alt, item.kicked);
      if (perm && item.finality) this.finality.add(perm.id);
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
    this.resolving = item;
    this.aimedSeat = null;
    this.resolvingCard = item.card;
    for (let i = 0; i < item.effects.length; i++) {
      // "Its controller" in a later sentence means whoever controlled what this part hit (Reality Shift).
      const aim = item.targets[i];
      if (aim) this.aimedSeat = aim.kind === 'player' ? aim.seat : aim.kind === 'perm' ? this.findPerm(aim.id)?.seat ?? this.aimedSeat : this.stack.find((s) => s.id === aim.id)?.controller ?? this.aimedSeat;
      if (!legal[i] || !p.alive) continue;
      yield* this.resolveEffect(p, item.effects[i], src, item.x, item.targets[i], item.card);
    }
    this.resolving = null;
    if (item.kind === 'spell') {
      if (this.tuckSpell) p.library.splice(Math.min(6, p.library.length), 0, item.card);
      else if (this.shuffleSpell && !item.copy) {
        p.library.push(item.card);
        this.rng.shuffle(p.library);
        this.say(`${item.card.name} is shuffled into ${p.name}'s library.`);
      }
      else this.leaveStack(p, item);
      this.tuckSpell = false;
      this.shuffleSpell = false;
    }
  }

  /** Where a spell goes after it resolves or is countered: exile if it was cast with flashback (rule 702.34). */
  private leaveStack(p: PlayerState, item: StackItem) {
    if (item.copy) return;
    if (item.flashback) p.exile.push(item.card);
    else this.toGraveyard(p, item.faceDown ?? item.card, item.isCommander);
  }

  private toGraveyard(p: PlayerState, card: SimCard, isCommander: boolean) {
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
    if (idx === -1 || from === p) return;
    from.battlefield.splice(idx, 1);
    perm.owner ??= from.seat;
    perm.seat = p.seat;
    perm.heldBy = undefined;
    perm.heldWhileMonarch = undefined;
    if (perm.owner === p.seat) perm.owner = undefined;
    perm.sick = true;
    perm.attacking = null;
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
  private *merge(p: PlayerState, host: Perm, card: SimCard, isCommander: boolean): Flow<void> {
    const parts = host.parts ?? [{ real: host.token ? null : host.faceDown ?? host.front ?? host.printed ?? host.card, face: host.card, commander: host.isCommander }];
    host.faceDown = undefined;
    host.front = undefined;
    const current = parts[0].face;
    const pick = yield* this.choose(p, 'mutate', `Put ${card.name} on top of ${current.name} (its body and name), or underneath (only its abilities)?`, [
      { label: `On top: ${card.name} ${card.power}/${card.toughness}`, card },
      { label: `Underneath: stay ${current.name} ${current.power}/${current.toughness}`, card: current },
    ], 1, 1);
    const part = { real: card, face: card, commander: isCommander };
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
      if (hits.length) this.trigger(p, perm.card, perm.id, hits);
    }
    for (const o of this.opponents(p)) {
      for (const perm of o.battlefield) {
        const hits = perm.card.effects.filter((e) => e.when === 'opponentCast' && matchesFilter(priced, e.castFilter ?? 'any'));
        if (hits.length) this.trigger(o, perm.card, perm.id, hits);
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

  private makePerm(p: PlayerState, card: SimCard, token: boolean): Perm {
    for (const e of [...card.effects, ...(card.levels ?? []).flatMap((l) => l.effects)]) {
      this.kindsInGame.add(e.kind);
      this.kindsInGame.add(`when:${e.when}`);
    }
    return {
      id: this.nextId++, card, seat: p.seat, tapped: false, sick: true, token, isCommander: false,
      counters: 0, damage: 0, deathtouched: false, tempP: 0, tempT: 0, tempKw: [],
      attachedTo: null, activations: 0, usedThisTurn: [], attacking: null, blocked: false, blocking: null,
      ...(card.loyalty !== undefined ? { loyalty: card.loyalty } : {}),
      ...(card.stun ? { stun: card.stun } : {}),
    };
  }

  /** Put a permanent card onto the battlefield and note its enters triggers. */
  private *enter(p: PlayerState, card: SimCard, isCommander: boolean, x: number, attachTo: Target | null, owner?: PlayerState, how?: 'token' | 'evoke' | 'dash', kicks = 0): Flow<Perm | null> {
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
      const creatures = this.allPerms().filter((q) => q.card.isCreature && (clone.from === undefined || (clone.from === 'yours') === (q.seat === p.seat)));
      if (creatures.length) {
        const pick = creatures.length === 1 ? [0] : yield* this.choose(p, 'clone', `${card.name} enters as a copy of which creature?`, creatures.map((q) => ({ label: `${q.card.name} (${this.players[q.seat].name})`, card: q.card, permId: q.id })), 1, 1);
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
        this.toGraveyard(p, card, isCommander);
        return null;
      }
      perm.cursing = seat;
      this.anyCurse = true;
    }
    if (isAura(card)) {
      const host = attachTo && attachTo.kind === 'perm' ? this.findPerm(attachTo.id) : null;
      // An Aura with nothing legal to enchant goes to the graveyard instead (rule 608.3b).
      if (!host || !this.canTarget(p, host)) {
        this.toGraveyard(p, card, isCommander);
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
    const doubled = 2 ** this.doublers(p, 'counters');
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
    if (perm.charge) this.refreshStation(perm);
    if (perm.printed && clone?.kind === 'clone' && clone.extraCounter && card.isCreature) perm.counters += doubled;
    if (card.isCreature && this.kindsInGame.has('enterCounters')) {
      const hurt = this.opponents(p).filter((o) => o.lostLifeTurn === this.turnNumber).length;
      for (const q of p.battlefield) for (const e of q.card.effects) if (e.kind === 'enterCounters') perm.counters += e.n * hurt;
    }
    if (card.entersTapped) perm.tapped = true;
    p.battlefield.push(perm);
    if (card.name === 'Isochron Scepter') this.imprint(p, perm);
    // Kicked (or offspring paid): its "if it was kicked" enters abilities too. Kicker {X} sets the X they refer to.
    const etb = (kicks && !perm.printed ? this.kickedCard(card, kicks) : card).effects.filter((e) => e.when === 'resolve')
      .map((e) => (e.kind === 'steal' && e.maxCmc === -1 ? { ...e, maxCmc: x } : e));
    if (etb.length) for (let i = this.triggerTimes(p, 'permanentEnters', card); i > 0; i--) this.trigger(p, card, perm.id, etb);
    if (card.isCreature) this.creatureEntered(p, perm);
    // A Saga enters with a lore counter, which sets off chapter I (rule 714.3a).
    if (card.saga) this.addLore(p, perm);
    if (how === 'dash') {
      perm.dashed = true;
      perm.tempKw.push('haste');
    }
    // Evoke: sacrificed as it enters; its enters abilities still happen (rule 702.74a).
    if (how === 'evoke') {
      this.say(`${card.name} is sacrificed (evoke).`);
      this.removePerm(perm, 'graveyard');
      this.sacrificed(p);
    }
    if ((card.isArtifact || card.isEnchantment) && this.kindsInGame.has('when:permEnters')) {
      const times = this.triggerTimes(p, 'permanentEnters', card);
      for (const other of p.battlefield) {
        if (other === perm) continue;
        const hits = other.card.effects.filter((e) => e.when === 'permEnters' && matchesFilter(card, e.castFilter ?? 'any'));
        if (hits.length) for (let i = 0; i < times; i++) this.trigger(p, other.card, other.id, hits);
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
    return perm;
  }

  /** Put a lore counter on a Saga and set off the chapter it reaches (rule 714.2b). */
  private addLore(p: PlayerState, perm: Perm) {
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
      : [{ card: perm.unlocked ?? perm.faceDown ?? perm.front ?? perm.printed ?? perm.uncrewed ?? perm.card, commander: perm.isCommander }];
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
  private *copyItem(p: PlayerState, orig: StackItem): Flow<void> {
    const src = this.findPerm(orig.sourceId);
    const targets: (Target | null)[] = [];
    for (let i = 0; i < orig.effects.length; i++) {
      const e = orig.effects[i];
      const old = orig.targets[i];
      const all = old ? this.targetCandidates(p, e, src) : null;
      if (!old || !all || !all.length) {
        targets.push(old);
        continue;
      }
      const pick = all.length === 1 ? all[0] : yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `${orig.card.name} (copy): choose a new target.`, card: orig.card, effect: e, candidates: all, cancellable: false });
      targets.push(pick && all.some((c) => sameTarget(c, pick)) ? pick : old);
    }
    const copy: StackItem = { ...orig, id: this.nextId++, controller: p.seat, targets, isCommander: false, copy: true, flashback: false, label: `${orig.label} (copy)` };
    delete copy.alt;
    this.stack.push(copy);
    this.say(`${p.name} copies ${orig.label}.`);
  }

  private putLand(p: PlayerState, card: SimCard, info: LandInfo, forceTapped = false) {
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
      case 'ramp': {
        let found = 0;
        for (let i = 0; i < e.lands + e.toHand; i++) {
          const names = [...new Set(p.library.filter((c) => c.isBasic && c.land).map((c) => c.name))];
          if (!names.length) break;
          const toBattlefield = i < e.lands;
          const pick = names.length === 1 ? [0] : yield* this.choose(p, 'ramp', `Search for a basic land${toBattlefield ? ' to put onto the battlefield' : ' for your hand'}.`, names.map((name) => ({ label: name, card: p.library.find((c) => c.name === name) })), 1, 1);
          const land = p.library.find((c) => c.isBasic && c.land && c.name === names[pick[0] ?? 0])!;
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
        const count = e.byCharge ? src?.charge ?? 0 : e.ritual ? e.n : Math.min(e.n * 2 ** this.doublers(p, 'tokens'), 40);
        if (count <= 0) break;
        p.treasures += count;
        this.say(`${p.name} ${e.ritual ? 'gets' : 'makes'} ${count} ${e.ritual ? 'mana' : `Treasure${count > 1 ? 's' : ''}`}.`);
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
        const count = e.n === -1 ? Math.max(x, 1) : e.n;
        this.draw(p, count, e.when === 'opponentDraw');
        this.say(`${p.name} draws ${count} card${count > 1 ? 's' : ''}.`);
        break;
      }
      case 'removal':
        yield* this.resolveRemoval(p, e, src, x, target);
        break;
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
            if (e.mode === 'damage') {
              if (perm.card.isCreature) this.hurt(perm, amount, e.shrink);
            } else if (e.mode === 'exile' || e.mode === 'bounce' || !this.hasKw(perm, 'indestructible')) hit.push(perm);
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
        if (idx === -1) break;
        const [hit] = this.stack.splice(idx, 1);
        this.say(`${hit.label} is countered.`);
        if (hit.kind === 'spell') this.leaveStack(this.players[hit.controller], hit);
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
          army.counters += e.power * 2 ** this.doublers(p, 'counters');
          for (const token of made) this.creatureEntered(p, token);
          this.say(`${p.name} amasses ${e.power}${made.length ? ', making an Army token' : ''} (Army is ${this.power(army)}/${this.toughness(army)}).`);
          break;
        }
        const count = Math.min((e.n === -1 ? x : e.n) * 2 ** this.doublers(p, 'tokens'), 40);
        for (let i = 0; i < count; i++) {
          const token = this.makePerm(p, tokenCard(e.power, e.toughness, e.keywords), true);
          if (e.fragile) token.fragile = e.fragile;
          p.battlefield.push(token);
          this.creatureEntered(p, token);
        }
        if (count > 0) this.say(`${p.name} makes ${count} ${e.power}/${e.toughness} token${count > 1 ? 's' : ''}.`);
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
        perm.tempP += n(e.p);
        perm.tempT += n(e.t);
        if (e.protect) perm.tempKw.push('indestructible', 'hexproof');
        if (e.grant) perm.tempKw.push(...e.grant);
        this.say(e.grant && !e.p && !e.t ? `${perm.card.name} gains ${e.grant.join(', ')} until end of turn.` : `${perm.card.name} gets +${n(e.p)}/+${n(e.t)} until end of turn.`);
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
          total += this.loseLife(o, amount, p, 'noncombat');
        }
        this.gainLife(p, e.gain === -1 ? total : e.gain);
        this.say(e.emptyHand ? `${p.name} drains each opponent with an empty hand for ${amount}.` : `${p.name} drains each opponent for ${amount}.`);
        break;
      }
      case 'damagePlayer': {
        const victim = target?.kind === 'player' ? this.players[target.seat] : null;
        if (!victim?.alive) break;
        const amount = e.n === -1 ? Math.max(x, 1) : e.n;
        if (this.damageMills(p, victim, amount)) break;
        const dealt = this.doubledDamage(victim, amount, p);
        this.loseLife(victim, dealt, p, 'noncombat');
        this.say(`${p.name} hits ${victim.name} for ${dealt} (life ${victim.life}).`);
        break;
      }
      case 'gainLife':
        this.gainLife(p, e.n === -1 ? Math.max(x, 1) : e.n);
        break;
      case 'loseLife':
        if (!p.shielded) p.life -= e.n;
        break;
      case 'digPermanent': {
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
        if (e.creatureToBattlefield) {
          const found = [...new Set(p.library.filter((c) => c.isCreature && (!e.xLimit || c.cmc <= x)))].sort((a, b) => a.name.localeCompare(b.name));
          if (!found.length) break;
          const pick = yield* this.choose(p, 'take', 'Search your library for a creature to put onto the battlefield.', found.map((card) => ({ label: card.name, card })), 1, 1);
          const card = found[pick[0] ?? 0];
          p.library.splice(p.library.indexOf(card), 1);
          this.rng.shuffle(p.library);
          this.say(`${p.name} searches their library and puts ${card.name} onto the battlefield.`);
          yield* this.enter(p, card, false, 0, null);
          break;
        }
        const cards = [...new Set(p.library)].sort((a, b) => a.name.localeCompare(b.name));
        const pick = yield* this.choose(p, 'tutor', 'Search your library for a card to put into your hand.', cards.map((card) => ({ label: card.name, card })), 1, 1);
        const card = cards[pick[0] ?? 0];
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
        this.say(`${card.name} returns to the battlefield with a ${e.counters > 0 ? '+1/+1' : '-1/-1'} counter.`);
        const perm = yield* this.enter(p, card, false, 0, null);
        if (perm) perm.counters += e.counters;
        break;
      }
      case 'counters': {
        const amount = (e.byExperience ? p.experience : e.n === -1 ? Math.max(x, 1) : e.n) * 2 ** this.doublers(p, 'counters');
        if (amount <= 0) break;
        const creatures = p.battlefield.filter((q) => q.card.isCreature && (!e.artifact || q.card.isArtifact));
        if (e.proliferate) {
          // Proliferate: you choose, so +1/+1 counters on your creatures and -1/-1 counters on your opponents' (rule 701.34).
          // Doubling Season only doubles counters on permanents you control.
          for (const perm of creatures) if (perm.counters > 0) perm.counters += amount;
          for (const perm of this.allPerms()) if (perm.seat !== p.seat && perm.card.isCreature && perm.counters < 0) perm.counters -= 1;
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
          if (p.energy > 0) p.energy++;
          if (p.experience > 0) p.experience++;
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
        if (e.from === 'battlefield') {
          const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
          if (!perm) break;
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
        const found = [...new Set(victim.library.filter((c) => c.isCreature))].sort((a, b) => a.name.localeCompare(b.name));
        if (!found.length) break;
        const pick = yield* this.choose(p, 'take', `Take which creature from ${victim.name}'s library?`, found.map((card) => ({ label: card.name, card })), 1, 1);
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
        const top = p.library.slice(0, e.n);
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
            this.toGraveyard(v, card, false);
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
      case 'extraTurn':
        this.extraTurns.push(p.seat);
        this.say(`${p.name} will take an extra turn.`);
        break;
      case 'approach': {
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
        this.say(`${perm.card.name} (${this.players[perm.seat].name}) is goaded.`);
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
        const id = e.what === 'trigger' ? this.resolving?.subject : target?.kind === 'stack' ? target.id : undefined;
        const orig = this.stack.find((s) => s.id === id);
        if (orig) yield* this.copyItem(p, orig);
        break;
      }
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
            body.counters += 2 ** this.doublers(p, 'counters');
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
          this.sacrificed(p);
        }
        const lost = new Map<PlayerState, number>();
        for (const l of lands) if (!this.hasKw(l, 'indestructible')) lost.set(this.players[l.seat], (lost.get(this.players[l.seat]) ?? 0) + 1);
        this.removePerms(lands.filter((l) => !this.hasKw(l, 'indestructible')), 'graveyard');
        if (e.replace) for (const [q, n] of lost) this.fetchBasics(q, n, false);
        break;
      }
      case 'landSac':
        for (const q of e.who === 'each' ? this.alivePlayers() : this.opponents(p)) {
          const lands = q.battlefield.filter((l) => l.landInfo);
          const n = e.keep !== undefined ? Math.max(0, lands.length - e.keep) : Math.min(e.n, lands.length);
          if (n <= 0) continue;
          const picks = n >= lands.length ? lands.map((_, i) => i) : yield* this.choose(q, 'sacrifice', `Sacrifice ${n} land${n > 1 ? 's' : ''}.`, lands.map((l) => ({ label: l.card.name, card: l.card, permId: l.id })), n, n);
          const gone = picks.map((i) => lands[i]);
          this.say(`${q.name} sacrifices ${gone.map((l) => l.card.name).join(', ')}.`);
          this.removePerms(gone, 'graveyard');
          for (let i = 0; i < gone.length; i++) this.sacrificed(q);
        }
        break;
      case 'nonbasicBurn':
        for (const q of this.alivePlayers()) {
          const n = q.battlefield.filter((l) => l.landInfo && !l.card.isBasic).length * e.per;
          const lost = this.loseLife(q, n, q === p ? null : p, 'noncombat');
          if (lost) this.say(`${card?.name ?? 'It'} deals ${lost} damage to ${q.name} for nonbasic lands (life ${q.life}).`);
        }
        break;
      case 'stun': {
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm) break;
        if (e.tap) perm.tapped = true;
        perm.stun = (perm.stun ?? 0) + 1;
        this.say(`${perm.card.name} gets a stun counter.`);
        break;
      }
      case 'bounty': {
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
        if (!perm || perm.bounty) break;
        perm.bounty = true;
        if (!e.plain) perm.bountyGrant = true;
        this.say(`${perm.card.name} gets a bounty counter.`);
        break;
      }
      case 'poison': {
        const victims = e.who === 'each' ? this.alivePlayers() : e.who === 'opponents' ? this.opponents(p) : target?.kind === 'player' ? [this.players[target.seat]] : [];
        for (const v of victims) {
          if (!v.alive || v.shielded) continue;
          v.poison += e.n;
          if (v !== p) {
            v.lastHitBy = p.seat;
            v.lastHitKind = 'noncombat';
          }
          this.say(`${v.name} gets ${e.n} poison counter${e.n > 1 ? 's' : ''} (${v.poison} of 10).`);
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
        }
        this.say(`${p.name} sacrifices ${chosen.label}.`);
        this.sacrificed(p);
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
      case 'sacrificeSelf': {
        if (!src || !this.players[src.seat].battlefield.includes(src)) break;
        this.say(`${this.players[src.seat].name} sacrifices ${src.card.name}.`);
        this.removePerm(src, 'graveyard');
        this.sacrificed(this.players[src.seat]);
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
        this.sacrificed(victim);
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
        this.sacrificed(victim);
      } else {
        this.loseLife(victim, amount, p, 'noncombat');
        this.say(`${p.name} deals ${amount} damage to ${victim.name} (life ${victim.life}).`);
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
          this.hurt(perm, pay, e.shrink);
          this.say(`${perm.card.name} (${owner.name}) takes ${pay} damage (${pay} energy paid).`);
          break;
        }
        this.hurt(perm, amount, e.shrink);
        this.say(e.shrink ? `${perm.card.name} (${owner.name}) gets -${amount}/-${amount}.` : `${perm.card.name} (${owner.name}) takes ${amount} damage.`);
        break;
      case 'fight': {
        let fighter = src && src.card.isCreature && p.battlefield.includes(src) ? src : null;
        if (!fighter) {
          const mine = p.battlefield.filter((q) => q.card.isCreature);
          if (!mine.length) return;
          const pick = mine.length === 1 ? [0] : yield* this.choose(p, 'fighter', `Which of your creatures deals damage to ${perm.card.name}?`, mine.map((q) => ({ label: `${q.card.name} (${this.power(q)}/${this.toughness(q)})`, card: q.card, permId: q.id })), 1, 1);
          fighter = mine[pick[0] ?? 0];
        }
        const dealt = this.power(fighter);
        perm.damage += dealt;
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
  private hurt(perm: Perm, amount: number, shrink?: 'temp' | 'counters') {
    if (shrink === 'counters') perm.counters -= amount; // -1/-1 counters cancel +1/+1 counters (rule 704.5q)
    else if (shrink === 'temp') {
      perm.tempP -= amount;
      perm.tempT -= amount;
    } else perm.damage += amount;
  }

  /** Doubling Season and friends: how many times tokens or counters are doubled for `p`. */
  private doublers(p: PlayerState, what: 'tokens' | 'counters'): number {
    let n = 0;
    for (const perm of p.battlefield) for (const e of perm.card.effects) if (e.kind === 'doubler' && e[what]) n++;
    return Math.min(n, 3);
  }

  /** `p` gets energy counters, after Aether Refinery and Izzet Generatorium; "whenever you get {E}" triggers. */
  gainEnergy(p: PlayerState, amount: number) {
    if (amount <= 0) return;
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
  putCounters(perm: Perm, n: number) {
    if (n <= 0) return;
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
    p.life += amount;
    this.fire(p, 'gainLife', amount);
  }

  /** Returns the life actually lost (none while the player is protected). */
  loseLife(p: PlayerState, amount: number, source: PlayerState | null, kind: LossReason): number {
    if (amount <= 0 || p.shielded) return 0;
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
    for (const perm of this.players[target.seat].battlefield) {
      for (const e of perm.card.effects) {
        if (e.kind === 'anthem' && this.anthemApplies(e, target) && !(e.other && perm === target) && this.chargeOn(perm, e)) {
          const times = e.perCharge ? perm.charge ?? 0 : 1;
          p += e.p * times;
          t += e.t * times;
        }
      }
    }
    // Curse of Death's Hold: creatures the enchanted player controls get -1/-1.
    if (this.anyCurse) for (const c of this.cursedBy(this.players[target.seat], 'shrink')) {
      p -= c.n;
      t -= c.n;
    }
    return { p, t };
  }

  /** A static ability that needs "N or more charge counters" on its source (Beastmaster Ascension) is on. */
  private chargeOn(src: Perm, e: Effect): boolean {
    return !e.minCharge || (src.charge ?? 0) >= e.minCharge;
  }

  /** Anthems limited to some creatures: enchantment or artifact creatures, or ones you control but don't own. */
  private anthemApplies(e: Extract<Effect, { kind: 'anthem' }>, perm: Perm): boolean {
    switch (e.only) {
      case 'enchantment': return perm.card.isEnchantment;
      case 'artifact': return perm.card.isArtifact;
      case 'stolen': return perm.owner !== undefined && perm.owner !== perm.seat;
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
      default: return p.battlefield.filter((q) => q.card.isCreature).length;
    }
  }

  toughness(perm: Perm): number {
    let t = this.baseSize(perm).t + perm.counters + perm.tempT + this.anthemBonus(perm).t + (perm.card.scales?.toughness ? this.scaled(perm) : 0);
    for (const eq of this.attachments(perm)) for (const e of eq.card.effects) if (e.kind === 'equip') t += e.t;
    return t;
  }

  hasKw(perm: Perm, kw: string): boolean {
    if (perm.card.keywords.includes(kw) || perm.tempKw.includes(kw) || perm.kwCounters?.includes(kw)) return true;
    if (this.kindsInGame.has('selfKeyword')) {
      for (const e of perm.card.effects) {
        if (e.kind !== 'selfKeyword' || e.keyword !== kw) continue;
        const owner = this.players[perm.seat];
        if (e.cond === 'yourTurn' ? this.activeSeat === perm.seat : owner.life <= STARTING_LIFE / 2) return true;
      }
    }
    if (!perm.card.isCreature) return false;
    if (this.kindsInGame.has('anthem')) {
      for (const q of this.players[perm.seat].battlefield) for (const e of q.card.effects) if (e.kind === 'anthem' && e.keywords?.includes(kw) && this.anthemApplies(e, perm) && !(e.other && q === perm) && this.chargeOn(q, e) && (!e.small || perm.card.power + perm.counters <= 1 || perm.card.toughness + perm.counters <= 1)) return true;
    }
    for (const eq of this.attachments(perm)) {
      for (const e of eq.card.effects) if (e.kind === 'equip' && e.keywords.includes(kw)) return true;
    }
    return false;
  }

  /** Destroy a permanent. Indestructible permanents stay (rule 702.12). */
  private destroy(perm: Perm) {
    if (this.hasKw(perm, 'indestructible')) return;
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
    const died: { perm: Perm; seat: number; worn: Perm[] }[] = [];
    const landsDied: PlayerState[] = [];
    for (const perm of perms) {
      const controller = this.players[perm.seat];
      const owner = this.players[perm.owner ?? perm.seat];
      const idx = controller.battlefield.indexOf(perm);
      if (idx === -1) continue;
      const worn = to === 'graveyard' && perm.card.isCreature ? this.attachments(perm) : NONE;
      controller.battlefield.splice(idx, 1);
      // Rest in Peace, Dauthi Voidwalker: exiled instead, so nothing "dies". An unearthed creature is exiled if it would leave.
      let dest = to;
      if (dest === 'graveyard' && this.exiledInstead(owner)) dest = 'exile';
      if (this.unearthed.delete(perm.id)) dest = 'exile';
      if (this.finality.delete(perm.id) && dest === 'graveyard') dest = 'exile';

      // Tokens cease to exist once they leave the battlefield (rule 704.5d). A copy goes back to being its own card.
      // A merged permanent's cards all go to the same zone (rule 721.3).
      if (owner.alive) {
        const cards = perm.parts
          ? perm.parts.flatMap((x) => (x.real ? [{ card: x.real, commander: x.commander }] : []))
          : perm.token ? [] : [{ card: perm.unlocked ?? perm.faceDown ?? perm.front ?? perm.printed ?? perm.uncrewed ?? perm.card, commander: perm.isCommander }];
        for (const { card, commander } of cards) {
          if (dest === 'library') {
            // Shuffled into the library. A commander may go to the command zone instead (rule 903.9b); it always does here.
            if (commander) {
              owner.commandZone.push(card);
              this.say(`${card.name} returns to ${owner.name}'s command zone.`);
            } else owner.library.splice(this.rng.int(owner.library.length + 1), 0, card);
            continue;
          }
          if (dest === 'graveyard') {
            owner.graveyard.push(card);
            if (card.curse && owner.battlefield.some((q) => q.card.effects.some((e) => e.kind === 'returnCurses'))) this.curseReturns.push({ seat: owner.seat, card });
          } else if (dest === 'exile') owner.exile.push(card);
          else owner.hand.push(card);
          if (commander) this.pendingCommander.push({ seat: owner.seat, card, to: dest });
        }
        // Persist (no -1/-1 counter on it) and undying (no +1/+1 counter): it returns (rules 702.79, 702.93).
        const card = cards.length === 1 ? cards[0].card : null;
        const persist = card?.persist;
        if (card && persist && dest === 'graveyard' && card.isCreature && (persist === 'persist' ? perm.counters >= 0 : perm.counters <= 0)) {
          this.trigger(owner, card, null, [{ kind: 'returnSelf', counters: persist === 'persist' ? -1 : 1, when: 'creatureDies', scope: 'self' }]);
        }
      }
      if (perm.card.isCreature && dest === 'graveyard' && controller.alive) died.push({ perm, seat: controller.seat, worn });
      if (perm.landInfo && dest === 'graveyard' && controller.alive && this.kindsInGame.has('landDiesPunish')) landsDied.push(controller);
    }
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

    for (const { perm, seat, worn } of died) {
      const controller = this.players[seat];
      const own = perm.card.effects.filter((e) => e.when === 'creatureDies' && e.scope === 'self');
      if (own.length) for (let i = this.triggerTimes(controller, 'dies'); i > 0; i--) this.trigger(controller, perm.card, null, own, 0, perm);
      for (const { w, seat: wSeat } of watchers) {
        const q = this.players[wSeat];
        if (!q.alive) continue;
        // "Whenever a creature you control dies" watches your own; "whenever a creature dies" watches everyone's.
        // A creature sees its own death only for "this creature or another" and "a creature you control".
        const hits = w.card.effects.filter((e) => e.when === 'creatureDies' && e.scope !== 'self' && e.scope !== 'attached'
          && (q === controller ? e.scope !== 'opponents' : e.scope === 'all' || e.scope === 'opponents') && (w !== perm || e.selfToo) && !(e.nontoken && perm.token));
        if (hits.length) for (let i = this.triggerTimes(q, 'dies'); i > 0; i--) this.trigger(q, w.card, w.id, hits, 0, w);
      }
      if (perm.bounty) this.bountyPaid(perm, controller);
      // Skullclamp: "whenever equipped creature dies".
      for (const eq of worn) {
        const hits = eq.card.effects.filter((e) => e.when === 'creatureDies' && e.scope === 'attached');
        const holder = this.players[eq.seat];
        if (hits.length) for (let i = this.triggerTimes(holder, 'dies'); i > 0; i--) this.trigger(holder, eq.card, eq.id, hits);
      }
    }
  }

  /**
   * Cumulative upkeep (rule 702.24): an age counter, then pay the cost once per counter or sacrifice it.
   * Paid while it costs three times the cost or less and mana allows; the trigger is handled at once here.
   */
  private cumulativeUpkeep(p: PlayerState) {
    for (const perm of [...p.battlefield]) {
      const cost = perm.card.cumulativeUpkeep;
      if (!cost) continue;
      perm.age = (perm.age ?? 0) + 1;
      const total: ManaCost = { generic: cost.generic * perm.age, pips: Array.from({ length: perm.age }, () => cost.pips).flat(), x: 0, life: 0 };
      const plan = perm.age <= 3 ? this.planPayment(p, total, 0, 0) : null;
      if (plan) {
        this.commitPayment(p, plan);
        this.say(`${p.name} pays cumulative upkeep for ${perm.card.name} (${perm.age} age counter${perm.age > 1 ? 's' : ''}).`);
      } else {
        this.say(`${p.name} doesn't pay cumulative upkeep and sacrifices ${perm.card.name}.`);
        this.removePerm(perm, 'graveyard');
        this.sacrificed(p);
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
    return this.allPerms().filter((q) => q.cursing === v.seat && q.card.curse);
  }

  /** The abilities of this kind on Curses attached to `v`. */
  private cursedBy(v: PlayerState, act: CurseAct): CurseAbility[] {
    return this.cursesOn(v).flatMap((q) => q.card.curse!.filter((c) => c.act === act));
  }

  /**
   * Something happened to `v` (or, for 'yourUpkeep', it is `actor`'s upkeep): the matching abilities of the Curses on `v`
   * trigger for their controllers. When `v` is attacked, each player attacking them shares in the reward (`actor` is the attacker).
   */
  private curseEvent(v: PlayerState, on: CurseAbility['on'], cast?: SimCard, actor?: PlayerState) {
    for (const curse of this.cursesOn(v)) {
      const owner = this.players[curse.seat];
      for (const c of curse.card.curse!) {
        if (c.on !== on) continue;
        if (on === 'yourUpkeep' && owner !== actor) continue;
        if (on === 'casts' && cast && ((c.filter === 'noncreature' && cast.isCreature) || (c.filter === 'instantSorcery' && !cast.isInstant && !cast.isSorcery) || (c.filter === 'notFirst' && v.spellsThisTurn <= 1))) continue;
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
            this.sacrificed(v);
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
        this.sacrificed(v);
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
    this.toGraveyard(p, card, false);
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
    for (let i = 0; i < 100; i++) {
      let changed = this.stateBasedActions();
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

    // Players who lose (704.5a–c, 903.10a). They all leave at the same time.
    for (const seat of this.winconSeats) if (this.players[seat].alive) this.checkCombo(this.players[seat]);

    const losing: { p: PlayerState; reason: LossReason }[] = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      let reason: LossReason | null = null;
      if (p.life <= 0) reason = p.lastHitKind;
      for (const dmg of p.commanderDamage.values()) if (dmg >= COMMANDER_DAMAGE) reason = 'commander';
      if (p.poison >= 10) reason = p.lastHitKind === 'noncombat' ? 'noncombat' : 'combat';
      if (p.drewFromEmpty) reason = 'decked';
      if (reason) losing.push({ p, reason });
    }
    if (losing.length) {
      this.eliminate(losing);
      changed = true;
      if (this.over) return true;
    }

    const dying: Perm[] = [];
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of q.battlefield) {
        if (perm.card.isCreature) {
          // 704.5f: toughness 0 or less. 704.5g/h: lethal or deathtouch damage destroys.
          const toughness = this.toughness(perm);
          if (toughness <= 0 || ((perm.damage >= toughness || perm.deathtouched) && !this.hasKw(perm, 'indestructible'))) {
            this.say(`${perm.card.name} (${q.name}) dies.`);
            dying.push(perm);
          } else {
            perm.deathtouched = false;
          }
        }
      }
    }
    // All state-based actions happen at the same time (rule 704.3), so these creatures die together.
    if (dying.length) {
      this.removePerms(dying, 'graveyard');
      changed = true;
    }
    for (const q of this.players) {
      if (!q.alive) continue;
      for (const perm of [...q.battlefield]) {
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

      // 704.5j: the legend rule. Keep the first of each name.
      const seen = new Set<string>();
      for (const perm of [...q.battlefield]) {
        if (!perm.card.isLegendary) continue;
        if (seen.has(perm.card.name)) {
          this.say(`${perm.card.name} (${q.name}) is put into the graveyard (legend rule).`);
          this.removePerm(perm, 'graveyard');
          changed = true;
        } else {
          seen.add(perm.card.name);
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
    this.say(`${p.name} wins the game (${why}).`);
    for (const o of this.opponents(p)) {
      o.life = Math.min(o.life, 0);
      o.lastHitBy = p.seat;
      o.lastHitKind = 'noncombat';
    }
  }

  /** "At the beginning of your upkeep, if ..., you win the game." */
  private upkeepWins(p: PlayerState) {
    for (const perm of p.battlefield) {
      const name = perm.card.name;
      if (UPKEEP_COUNTERS.has(name)) perm.counters++;
      const wins = UPKEEP_WINS[name];
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
        perm.blocking = null;
        owner.battlefield.push(perm);
      }
      p.battlefield = [];
      for (const q of this.players) if (q !== p) q.battlefield = q.battlefield.filter((perm) => perm.owner !== p.seat);
      for (let i = this.stack.length - 1; i >= 0; i--) if (this.stack[i].controller === p.seat) this.stack.splice(i, 1);
      this.pending = this.pending.filter((t) => t.controller !== p.seat);
      for (const perm of this.allPerms()) if (perm.attacking === p.seat) perm.attacking = null;
    }
    if (this.monarch !== null && !this.players[this.monarch].alive) this.monarch = this.alivePlayers()[0]?.seat ?? null;
    if (this.alivePlayers().length <= 1) this.over = true;
  }

  // -------------------------------------------------------------------------
  // Combat (rules 506–511)
  // -------------------------------------------------------------------------

  /** Mana each creature's controller must pay to attack `defender` (Propaganda, Ghostly Prison). */
  attackTax(defender: PlayerState): number {
    let tax = 0;
    for (const perm of defender.battlefield) for (const e of perm.card.effects) if (e.kind === 'attackTax') tax += e.amount;
    return tax;
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
    // Shadow blocks and is blocked only by shadow (702.28b). Fear: only artifact or black creatures block it (702.36b).
    if (this.hasKw(attacker, 'shadow') !== this.hasKw(blocker, 'shadow')) return false;
    if (this.hasKw(attacker, 'fear') && !blocker.card.isArtifact && !blocker.card.cost.pips.some((pip) => pip.includes('B'))) return false;
    // The Ring, first ability: the ring-bearer can't be blocked by creatures with greater power.
    if (this.ringLevel(attacker) >= 1 && this.power(blocker) > this.power(attacker)) return false;
    // Lord of the Nazgûl: Wraiths have protection from ring-bearers, so a ring-bearer can't block them (rule 702.16e).
    if (this.protectedFrom(attacker, blocker)) return false;
    return true;
  }

  /** Does `perm` have protection from `source`? Only Lord of the Nazgûl's "protection from ring-bearers" so far. */
  protectedFrom(perm: Perm, source: Perm): boolean {
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
    if (this.untapAttackersEachCombat) {
      const again = p.battlefield.filter((q) => q.tapped && q.attackedTurn === this.turnNumber && q.card.isCreature && !q.stun);
      for (const q of again) q.tapped = false;
      if (again.length) this.say(`${p.name} untaps ${again.length === 1 ? again[0].card.name : `${again.length} creatures`} that attacked this turn.`);
    }
    yield* this.priority();
    if (this.stopped(p)) return;

    // Declare attackers (508). Each creature may attack a different opponent (rule 802.2a).
    this.step = 'declareAttackers';
    const candidates = this.attackCandidates(p);
    const defenders = this.opponents(p).map((o) => o.seat);
    if (!candidates.length || !defenders.length) return;
    // Goaded creatures must attack, and must attack someone other than whoever goaded them if they can (rule 701.15b).
    // Paying a cost to attack is never required (rule 508.1d), so players with an attack tax don't count.
    const goaded: { attacker: number; defenders: number[] }[] = [];
    for (const c of candidates) {
      const by = this.goaders(c);
      if (!by.length) continue;
      const free = defenders.filter((d) => this.attackTax(this.players[d]) === 0);
      const others = free.filter((d) => !by.includes(d));
      const allowed = others.length ? others : free;
      if (allowed.length) goaded.push({ attacker: c.id, defenders: allowed });
    }
    const declared = yield* ask<AttackDeclaration[] | null>({ kind: 'attackers', seat: p.seat, candidates: candidates.map((c) => c.id), defenders, ...(goaded.length ? { goaded } : {}) });
    const attacking: Perm[] = [];
    for (const d of Array.isArray(declared) ? declared : []) {
      const perm = candidates.find((c) => c.id === d?.attacker);
      if (!perm || perm.attacking !== null || !defenders.includes(d.defender)) continue;
      // Propaganda: pay for each creature attacking that player, or it stays home (rule 508.1h).
      const tax = this.attackTax(this.players[d.defender]);
      if (tax > 0) {
        const plan = this.planPayment(p, NO_COST, tax, 0, perm);
        if (!plan) continue;
        this.commitPayment(p, plan);
        this.say(`${p.name} pays ${tax} for ${perm.card.name} to attack ${this.players[d.defender].name}.`);
      }
      const must = goaded.find((gd) => gd.attacker === perm.id);
      perm.attacking = must && !must.defenders.includes(d.defender) ? must.defenders[0] : d.defender;
      perm.attackedTurn = this.turnNumber;
      if (!this.hasKw(perm, 'vigilance')) perm.tapped = true;
      attacking.push(perm);
    }
    for (const must of goaded) {
      const perm = candidates.find((c) => c.id === must.attacker);
      if (!perm || perm.attacking !== null) continue;
      // Left out: it attacks the most vulnerable player it may attack.
      perm.attacking = must.defenders.reduce((a, b) => (this.players[b].life < this.players[a].life ? b : a));
      perm.attackedTurn = this.turnNumber;
      if (!this.hasKw(perm, 'vigilance')) perm.tapped = true;
      attacking.push(perm);
      this.say(`${perm.card.name} is goaded and must attack.`);
    }
    // No attackers: skip straight to the end of combat (rule 508.8).
    if (!attacking.length) return;
    for (const seat of defenders) {
      const group = attacking.filter((a) => a.attacking === seat);
      if (group.length) this.say(`${p.name} attacks ${this.players[seat].name} with ${group.map((a) => `${a.card.name} ${this.power(a)}/${this.toughness(a)}`).join(', ')}.`);
    }
    // Curses on the players being attacked (Curse of Opulence and friends).
    if (this.anyCurse) for (const seat of defenders) if (attacking.some((a) => a.attacking === seat)) this.curseEvent(this.players[seat], 'attacked', undefined, p);
    // The Ring, second ability: whenever the ring-bearer attacks, draw a card, then discard a card.
    for (const a of attacking) if (this.ringLevel(a) >= 2) yield* this.loot(p, `${a.card.name} carries the Ring`);
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
      const blocks = yield* ask<BlockDeclaration[] | null>({ kind: 'blockers', seat: d.seat, attackers: incoming.map((a) => a.id), candidates: able.map((b) => b.id) });
      const byAttacker = new Map<Perm, Perm[]>();
      for (const b of Array.isArray(blocks) ? blocks : []) {
        const blocker = able.find((c) => c.id === b?.blocker);
        const attacker = incoming.find((a) => a.id === b?.attacker);
        if (!blocker || !attacker || blocker.blocking !== null || !this.canBlock(blocker, attacker)) continue;
        blocker.blocking = attacker.id;
        byAttacker.set(attacker, [...(byAttacker.get(attacker) ?? []), blocker]);
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
      for (const b of doomed) this.sacrificed(this.players[b.seat]);
      yield* this.checkState();
    }
    yield* this.priority();
  }

  private endCombat() {
    for (const q of this.players) {
      for (const perm of q.battlefield) {
        perm.attacking = null;
        perm.blocked = false;
        perm.blocking = null;
      }
    }
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
      if (!a.blocked) {
        if (defender.alive) toPlayer.push({ from: a, to: defender, amount: power });
        continue;
      }
      const blockers = this.blockersOf(a);
      // Curse of Hospitality: creatures attacking the enchanted player have trample.
      const trample = this.hasKw(a, 'trample') || this.cursedBy(defender, 'hospitality').length > 0;
      if (!blockers.length) {
        // Blocked, but the blockers are gone: no damage unless it has trample (rule 702.19e).
        if (trample && defender.alive) toPlayer.push({ from: a, to: defender, amount: power });
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
        if (trample && defender.alive) toPlayer.push({ from: a, to: defender, amount: left });
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
    // Fog, Maze of Ith, Inkshield: prevented combat damage is never dealt (rule 615.1).
    if (this.fogAll) {
      if (toPerm.length || toPlayer.length) this.say('All combat damage is prevented.');
      toPerm.length = 0;
      toPlayer.length = 0;
    }
    for (let i = toPerm.length - 1; i >= 0; i--) if (toPerm[i].from.fogged || toPerm[i].to.fogged) toPerm.splice(i, 1);
    for (let i = toPlayer.length - 1; i >= 0; i--) {
      const d = toPlayer[i];
      if (!d.from.fogged && !d.to.fogged) continue;
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

    const hitPlayer = new Set<Perm>();
    const before = new Map<PlayerState, number>();
    // Lifelink: all the damage one creature deals in a step is one life gain event; separate creatures are separate events (rule 702.15e).
    const linked = new Map<Perm, number>();
    for (const d of [...toPerm, ...toPlayer]) if (this.hasKw(d.from, 'lifelink')) linked.set(d.from, (linked.get(d.from) ?? 0) + d.amount);
    for (const d of toPerm) {
      if (this.protectedFrom(d.to, d.from)) continue;
      // Wither and infect: damage to creatures as -1/-1 counters (rules 702.80, 702.90).
      if (this.hasKw(d.from, 'wither') || this.hasKw(d.from, 'infect')) d.to.counters -= d.amount;
      else d.to.damage += d.amount;
      if (this.hasKw(d.from, 'deathtouch')) d.to.deathtouched = true;
    }
    for (const d of toPlayer) {
      // The Mindskinner: prevented, and the player mills that many instead.
      if (this.damageMills(p, d.to, d.amount)) continue;
      if (!before.has(d.to)) before.set(d.to, d.to.life);
      d.amount = this.doubledDamage(d.to, d.amount, p, true);
      // Infect: poison counters instead of life loss (rule 702.90).
      if (this.hasKw(d.from, 'infect')) {
        if (!d.to.shielded) {
          d.to.poison += d.amount;
          d.to.lastHitBy = p.seat;
          d.to.lastHitKind = 'combat';
          this.say(`${d.to.name} gets ${d.amount} poison (${d.to.poison} of 10).`);
        }
      } else this.loseLife(d.to, d.amount, p, 'combat');
      // Toxic: poison counters as well (rule 702.164).
      if (d.from.card.toxic && !d.to.shielded) {
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
      // Curse of Hospitality: the top card of their library, for the attacker to play this turn (kept when it is a land or cheap enough to cast).
      for (let i = this.cursedBy(d.to, 'hospitality').length; i > 0 && d.to.library.length; i--) {
        const card = d.to.library.shift()!;
        const usable = card.isLand ? p.landsPlayed === 0 : card.cmc <= this.availableMana(p) + 1;
        (usable ? p.hand : d.to.exile).push(card);
        this.say(`${d.to.name} exiles ${card.name} (Curse of Hospitality)${usable ? `; ${p.name} takes it` : ''}.`);
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
      if (own.length) this.trigger(p, a.card, a.id, own, toPlayer.filter((d) => d.from === a).reduce((n, d) => n + d.amount, 0));
      for (const eq of this.attachments(a)) {
        const hits = eq.card.effects.filter((e) => e.when === 'combatDamage' && e.scope === 'self');
        if (hits.length) this.trigger(p, eq.card, eq.id, hits);
      }
    }
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
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A lockdown Aura's view of a card: a vanilla creature of `size`, or (with null) a land that taps for {C}. Cached per card. */
const LOCKED = new Map<string, WeakMap<SimCard, SimCard>>();
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

export function isInstantSpeed(card: SimCard): boolean {
  return card.isInstant || card.keywords.includes('flash');
}

/** Is this a card of the given color, for "exile a blue card from your hand"? Colors come from its mana cost. */
export function pitchable(card: SimCard, color: Color): boolean {
  return card.cost.pips.some((pip) => pip.includes(color));
}

export function hasSubtype(card: SimCard, subtype: string): boolean {
  return card.keywords.includes('changeling') || new RegExp(`—.*\\b${subtype}\\b`).test(card.typeLine);
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

/** Phantasmal Image and Jace's Illusions: "when this becomes the target of a spell, sacrifice it". */
const SACRIFICE_SELF: Effect = { kind: 'sacrificeSelf', when: 'targeted', scope: 'self' };

const tokenCache = new Map<string, SimCard>();

/** The Army token amass makes (rule 701.47a): a 0/0 that grows with +1/+1 counters. */
let army: SimCard | null = null;
function armyCard(): SimCard {
  return (army ??= { ...tokenCard(0, 0, []), name: 'Army token', typeLine: 'Token Creature — Army' });
}

function tokenCard(power: number, toughness: number, keywords: string[]): SimCard {
  const key = `${power}/${toughness}/${keywords.join(',')}`;
  let card = tokenCache.get(key);
  if (!card) {
    card = {
      name: `${power}/${toughness} token`,
      cost: { generic: 0, pips: [], x: 0, life: 0 },
      cmc: 0,
      typeLine: 'Token Creature',
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
