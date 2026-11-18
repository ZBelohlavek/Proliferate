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
  CastFilter, Color, Effect, Elimination, GameResult, LandInfo, LossReason, Mana, ManaCost, SimCard, SimDeck, Trigger,
} from '../engine/types';
import type {
  Action, Answer, AttackDeclaration, BlockDeclaration, ChoiceOption, ChooseReason, Decision, Perm, PlayerState, PriorityAnswer, StackItem, Step, Target,
} from './types';

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
}

/** A triggered ability waiting to be put on the stack (rule 603.3). */
interface PendingTrigger {
  controller: number;
  card: SimCard;
  sourceId: number | null;
  effects: Effect[];
  /** The number "that much" refers to (life gained, for Sanguine Bond). */
  x: number;
}

const PASS: Action = { type: 'pass' };
const NONE: Perm[] = [];
const NO_COST: ManaCost = { generic: 0, pips: [], x: 0, life: 0 };
/** Equip cost assumed when a deck was imported before equip costs were recorded. */
const DEFAULT_EQUIP: ManaCost = { generic: 2, pips: [], x: 0, life: 0 };
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
  private pending: PendingTrigger[] = [];
  /** Commanders that just went to a graveyard, exile or hand (rule 903.9). */
  private pendingCommander: { seat: number; card: SimCard; to: 'graveyard' | 'exile' | 'hand' }[] = [];
  /** Attackers that dealt combat damage in the first-strike step (rule 510.4). */
  private struckFirst = new Set<number>();
  /** False while nothing is attached to anything, to skip the search for attachments. */
  private anyAttached = false;
  /** Seats that take an extra turn after the current one (Time Warp). */
  private extraTurns: number[] = [];
  private extraTurnsTaken = 0;
  /** Times each seat resolved Approach of the Second Sun. */
  private approachCasts = new Map<number, number>();
  /** Set while a spell resolves that goes back into its owner's library instead of the graveyard. */
  private tuckSpell = false;
  /** Seat of the monarch, if any (rule 724). */
  monarch: number | null = null;
  /** Effect kinds of every permanent made so far, so static effects no deck plays cost nothing to check. */
  private readonly kindsInGame = new Set<string>();

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
      alive: true,
      drewFromEmpty: false,
      landsPlayed: 0,
      spellsThisTurn: 0,
      poison: 0,
      shielded: false,
      lastHitBy: null,
      lastHitKind: 'combat',
      commanderRound: null,
      mulligans: 0,
      earlyNames: new Set(),
      drawnNames: new Set(),
      castNames: new Set(),
    }));
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
    this.say(`— Round ${this.round}, ${p.name} (life ${p.life}) —`);

    // Untap step (502). No player gets priority.
    this.step = 'untap';
    for (const perm of p.battlefield) {
      // A stun counter is removed instead of untapping (rule 122.1d).
      if (perm.stun && perm.tapped) perm.stun--;
      else if (!perm.card.noUntap) perm.tapped = false;
      perm.sick = false;
    }
    for (const q of this.players) {
      for (const perm of q.battlefield) {
        perm.usedThisTurn = [];
        perm.activations = 0;
        perm.loyaltyUsed = false;
      }
    }
    p.landsPlayed = 0;
    p.shielded = false;
    for (const q of this.players) q.spellsThisTurn = 0;

    // Upkeep step (503).
    this.step = 'upkeep';
    this.fire(p, 'upkeep');
    yield* this.priority();
    if (this.stopped(p)) return;

    // Draw step (504). Only in a two-player game does the first player skip it (rule 103.8).
    this.step = 'draw';
    if (!(this.turnNumber === 1 && this.players.length === 2)) this.draw(p, 1);
    yield* this.priority();
    if (this.stopped(p)) return;

    this.step = 'main1';
    yield* this.priority();
    if (this.stopped(p)) return;

    yield* this.combat(p);
    this.endCombat();
    if (this.stopped(p)) return;

    this.step = 'main2';
    yield* this.priority();
    if (this.stopped(p)) return;

    this.step = 'end';
    if (this.monarch === p.seat) {
      this.say(`${p.name} draws a card as the monarch.`);
      this.draw(p, 1);
    }
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
      if (this.turnNumber === 0) continue;
      if (this.kindsInGame.has('when:draw')) this.fire(p, 'draw');
      if (quiet) continue;
      for (const o of this.players) {
        if (o === p || !o.alive) continue;
        for (const perm of o.battlefield) {
          const hits = perm.card.effects.filter((e) => e.when === 'opponentDraw');
          if (hits.length) this.trigger(o, perm.card, perm.id, hits);
        }
      }
    }
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
    }

    const mana = this.availableMana(p);
    // Rule of Law: one spell a turn. Drannith Magistrate: no casting from the command zone.
    const mayCast = !(p.spellsThisTurn >= 1 && this.statics(null, 'spellLimit') > 0);
    const locked = this.opponents(p).some((o) => this.statics(o, 'commandLock') > 0);
    const consider = (card: SimCard, from: 'hand' | 'command' | 'graveyard' | 'overload') => {
      if (card.isLand || !mayCast || (from === 'command' && locked)) return;
      if (!sorcery && !isInstantSpeed(card)) return;
      const fromCommand = from === 'command';
      const priced = this.castCard(card, from);
      if (mana < this.effectiveCost(p, priced, fromCommand)) return;
      if (!this.canAfford(p, priced, fromCommand, 0)) return;
      if (from !== 'overload' && !this.hasTargets(p, card)) return;
      actions.push({ type: 'cast', card, from, maxX: this.maxX(p, priced, fromCommand) });
    };
    for (const card of new Set(p.commandZone)) consider(card, 'command');
    for (const card of new Set(p.hand)) {
      consider(card, 'hand');
      if (card.overload) consider(card, 'overload');
    }
    const seen = new Set<SimCard>();
    for (const card of p.graveyard) {
      if (card.flashback && !seen.has(card)) {
        seen.add(card);
        consider(card, 'graveyard');
      }
    }
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
      // Crew, kept simple: in your first main phase, so the Vehicle can attack.
      if (perm.card.crew && sorcery && this.step === 'main1' && this.crewFor(p, perm)) actions.push({ type: 'crew', permId: perm.id });
    }
    return actions;
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
    const act = e.activation;
    if (act.tap && (perm.tapped || (perm.sick && perm.card.isCreature && !this.hasKw(perm, 'haste')))) return false;
    if (act.cost.life >= p.life && act.cost.life > 0) return false;
    if (act.sacCreature && !p.battlefield.some((q) => q.card.isCreature)) return false;
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
        const idx = p.hand.indexOf(action.card);
        if (idx === -1) return false;
        p.hand.splice(idx, 1);
        const info = action.back ? action.card.backLand! : action.card.land!;
        this.say(`${p.name} plays ${action.back ? action.card.backLand!.name : action.card.name}.`);
        this.putLand(p, action.card, info);
        p.landsPlayed++;
        p.castNames.add(action.card.name);
        return true;
      }
      case 'cast':
        return yield* this.cast(p, action.card, action.from === 'command', Math.max(0, Math.min(action.maxX, Math.floor(x) || 0)), action.from);
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
      default:
        return false;
    }
  }

  // -------------------------------------------------------------------------
  // Mana
  // -------------------------------------------------------------------------

  private manaSources(p: PlayerState, exclude?: Perm): ManaSource[] {
    const out: ManaSource[] = [];
    for (const perm of p.battlefield) {
      if (perm.tapped || perm === exclude) continue;
      if (perm.landInfo) {
        out.push({ perm, colors: perm.landInfo.produces, amount: 1 });
        continue;
      }
      if (perm.sick && perm.card.isCreature && !this.hasKw(perm, 'haste')) continue;
      for (const e of perm.card.effects) {
        if (e.kind === 'mana') out.push({ perm, colors: e.colors, amount: e.amount });
      }
    }
    for (let i = 0; i < p.treasures; i++) out.push({ perm: null, colors: 'any', amount: 1 });
    return out;
  }

  /** Total mana `p` could produce right now. */
  availableMana(p: PlayerState): number {
    let n = p.treasures;
    for (const perm of p.battlefield) {
      if (perm.tapped) continue;
      if (perm.landInfo) n++;
      else if (!(perm.sick && perm.card.isCreature && !this.hasKw(perm, 'haste'))) {
        for (const e of perm.card.effects) if (e.kind === 'mana') n += e.amount;
      }
    }
    return n;
  }

  colorsAvailable(p: PlayerState): Set<Mana> {
    const set = new Set<Mana>();
    for (const perm of p.battlefield) {
      let produces: Mana[] | 'any' | undefined = perm.landInfo?.produces;
      if (!produces) {
        const mana = perm.card.effects.find((e) => e.kind === 'mana');
        if (mana && mana.kind === 'mana') produces = mana.colors;
      }
      if (!produces) continue;
      if (produces === 'any') p.identity.forEach((c) => set.add(c));
      else produces.forEach((c) => set.add(c));
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
    for (const [src, units] of plan) {
      if (src.perm) src.perm.tapped = true;
      else {
        p.treasures -= units;
        // Each Treasure is sacrificed on its own: Korvold and Juri trigger once for each.
        for (let i = 0; i < units; i++) this.sacrificed(p);
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
        for (const perm of this.allPerms()) {
          if (perm === src || perm.card.isLand || !removalMatches(e.target, perm.card) || !this.canTarget(p, perm)) continue;
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
      case 'steal':
        if (e.from === 'library') return this.opponents(p).filter((o) => o.library.some((c) => c.isCreature)).map((o) => ({ kind: 'player', seat: o.seat }));
        return this.allPerms().filter((q) => q.seat !== p.seat && q.card.isCreature && this.canTarget(p, q)).map((q) => ({ kind: 'perm', id: q.id }));
      default:
        return null;
    }
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
    if (e?.kind === 'removal' && e.mode !== 'edict' && !removalMatches(e.target, perm.card)) return false;
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
  /** The card as it is cast: priced at its flashback cost, or with its overload cost and effects. */
  castCard(card: SimCard, from: 'hand' | 'command' | 'graveyard' | 'overload' | 'crewed'): SimCard {
    if (from === 'hand' || from === 'command') return card;
    let cache = this.altCards.get(from);
    if (!cache) this.altCards.set(from, (cache = new WeakMap()));
    let alt = cache.get(card);
    if (!alt) {
      alt = from === 'crewed'
        ? { ...card, isCreature: true }
        : from === 'graveyard'
        ? { ...card, cost: card.flashback ?? card.cost }
        : { ...card, cost: card.overload?.cost ?? card.cost, effects: card.overload?.effects ?? card.effects };
      cache.set(card, alt);
    }
    return alt;
  }

  private *cast(p: PlayerState, card: SimCard, fromCommand: boolean, x: number, from: 'hand' | 'command' | 'graveyard' | 'overload' = 'hand'): Flow<boolean> {
    const flashback = from === 'graveyard';
    const zone = fromCommand ? p.commandZone : flashback ? p.graveyard : p.hand;
    if (!zone.includes(card) || (flashback && !card.flashback) || (from === 'overload' && !card.overload)) return false;
    const priced = this.castCard(card, from);
    const permanent = !card.isInstant && !card.isSorcery;
    const effects = permanent ? [] : priced.effects.filter((e) => e.when === 'resolve');

    // Choose targets (601.2c), then pay (601.2h). Ward is charged as part of the cost.
    let ward = 0;
    const affordable = (t: Target) => this.canAfford(p, priced, fromCommand, x, ward + this.wardCost(p, t));
    let attachTo: Target | null = null;
    if (permanent && isAura(card)) {
      const candidates = this.auraCandidates(p).filter(affordable);
      if (!candidates.length) return false;
      attachTo = yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: `Enchant which creature with ${card.name}?`, card, effect: null, candidates, cancellable: true });
      if (!attachTo || !candidates.some((c) => sameTarget(c, attachTo!))) return false;
      ward += this.wardCost(p, attachTo);
    }
    const targets: (Target | null)[] = [];
    for (const e of effects) {
      const all = this.targetCandidates(p, e, null);
      if (all === null) {
        targets.push(null);
        continue;
      }
      const candidates = all.filter(affordable);
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
    if (flashback) item.flashback = true;
    this.stack.push(item);
    const aimed = [attachTo, ...targets].filter((t): t is Target => t !== null);
    this.say(`${p.name} casts ${card.name}${card.cost.x ? ` (X=${x})` : ''}${fromCommand ? ' from the command zone' : flashback ? ' with flashback' : from === 'overload' ? ' with overload' : ''}${aimed.length ? ` targeting ${aimed.map((t) => this.describeTarget(t)).join(', ')}` : ''}.`);

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
      if (hits.length) for (let i = 0; i < times; i++) this.trigger(p, perm.card, perm.id, hits);
    }
    // "Whenever an opponent casts a spell" (Rhystic Study).
    for (const o of this.opponents(p)) {
      for (const perm of o.battlefield) {
        const hits = perm.card.effects.filter((e) => e.when === 'opponentCast' && matchesFilter(card, e.castFilter ?? 'any') && counts(e));
        if (hits.length) this.trigger(o, perm.card, perm.id, hits);
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
    perm.activations++;
    this.say(`${p.name} activates ${perm.card.name}${fodder ? `, sacrificing ${fodder.card.name}` : ''}${target ? ` targeting ${this.describeTarget(target)}` : ''}.`);
    if (fodder) {
      this.removePerm(fodder, 'graveyard');
      this.sacrificed(p);
    }
    if (act.sacrifice) {
      this.removePerm(perm, 'graveyard');
      this.sacrificed(p);
    }
    this.stack.push({
      id: this.nextId++, kind: 'ability', controller: p.seat, card: perm.card, effects: [e], targets: [target], x: 0,
      isCommander: false, sourceId: act.sacrifice || fodder === perm ? null : perm.id, attachTo: null, label: `${perm.card.name} ability`,
    });
    return true;
  }

  // -------------------------------------------------------------------------
  // Triggered abilities (rule 603)
  // -------------------------------------------------------------------------

  /**
   * Note that an ability triggered. It goes on the stack the next time a player would get priority.
   * `x`: the amount "that much" refers to. `left`: the source, when it has just left the battlefield.
   */
  private trigger(controller: PlayerState, card: SimCard, sourceId: number | null, effects: Effect[], x = 0, left: Perm | null = null) {
    if (!controller.alive || !effects.length) return;
    const src = left ?? this.findPerm(sourceId);
    const kept: Effect[] = [];
    for (const e of effects) {
      if (this.triggerBudget-- <= 0) return;
      // "If" conditions the classifier couldn't read hold about half the time.
      if (e.chance !== undefined && !this.rng.chance(e.chance)) continue;
      if (e.oncePerTurn && src) {
        if (src.usedThisTurn.includes(e)) continue;
        src.usedThisTurn.push(e);
      }
      kept.push(e);
    }
    if (kept.length) this.pending.push({ controller: controller.seat, card, sourceId, effects: kept, x });
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
        const pick = candidates.length === 1
          ? candidates[0]
          : yield* ask<Target | null>({ kind: 'target', seat: p.seat, prompt: targetPrompt(t.card, e), card: t.card, effect: e, candidates, cancellable: false });
        const chosen = pick && candidates.some((c) => sameTarget(c, pick)) ? pick : candidates[0];
        if (this.wardCost(p, chosen)) {
          const plan = this.planPayment(p, NO_COST, WARD_COST, 0);
          if (plan) this.commitPayment(p, plan);
        }
        effects.push(e);
        targets.push(chosen);
      }
      if (!effects.length) continue;
      this.stack.push({ id: this.nextId++, kind: 'ability', controller: p.seat, card: t.card, effects, targets, x: t.x, isCommander: false, sourceId: t.sourceId, attachTo: null, label: `${t.card.name} trigger` });
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

    if (item.kind === 'spell' && !item.card.isInstant && !item.card.isSorcery) {
      yield* this.enter(p, item.card, item.isCommander, item.x, item.attachTo);
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
    for (let i = 0; i < item.effects.length; i++) {
      if (!legal[i] || !p.alive) continue;
      yield* this.resolveEffect(p, item.effects[i], src, item.x, item.targets[i]);
    }
    if (item.kind === 'spell') {
      if (this.tuckSpell) p.library.splice(Math.min(6, p.library.length), 0, item.card);
      else this.leaveStack(p, item);
      this.tuckSpell = false;
    }
  }

  /** Where a spell goes after it resolves or is countered: exile if it was cast with flashback (rule 702.34). */
  private leaveStack(p: PlayerState, item: StackItem) {
    if (item.flashback) p.exile.push(item.card);
    else this.toGraveyard(p, item.card, item.isCommander);
  }

  private toGraveyard(p: PlayerState, card: SimCard, isCommander: boolean) {
    // Rest in Peace: exiled instead.
    const to = this.statics(null, 'graveyardHate') > 0 ? 'exile' : 'graveyard';
    p[to].push(card);
    if (isCommander) this.pendingCommander.push({ seat: p.seat, card, to });
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
    if (perm.owner === p.seat) perm.owner = undefined;
    perm.sick = true;
    perm.attacking = null;
    perm.blocking = null;
    perm.blocked = false;
    p.battlefield.push(perm);
    this.say(`${p.name} takes control of ${perm.card.name}.`);
  }

  private makePerm(p: PlayerState, card: SimCard, token: boolean): Perm {
    for (const e of card.effects) {
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
  private *enter(p: PlayerState, card: SimCard, isCommander: boolean, x: number, attachTo: Target | null, owner?: PlayerState): Flow<void> {
    const perm = this.makePerm(p, card, false);
    perm.isCommander = isCommander;
    if (owner && owner !== p) perm.owner = owner.seat;
    // Clone: enters as a copy of a creature on the battlefield (rule 707).
    const clone = card.effects.find((e) => e.kind === 'clone');
    if (clone?.kind === 'clone') {
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
    if (isAura(card)) {
      const host = attachTo && attachTo.kind === 'perm' ? this.findPerm(attachTo.id) : null;
      // An Aura with nothing legal to enchant goes to the graveyard instead (rule 608.3b).
      if (!host || !this.canTarget(p, host)) {
        this.toGraveyard(p, card, isCommander);
        return;
      }
      perm.attachedTo = host.id;
      this.anyAttached = true;
      // Control Magic: you control the enchanted creature, until the Aura leaves.
      if (host.seat !== p.seat && card.effects.some((e) => e.kind === 'equip' && e.steal)) {
        this.takeControl(host, p);
        this.hold(host, perm);
      }
    }
    // Doubling Season: counters a permanent enters with are doubled too (rule 122.6, 614.1c).
    const doubled = 2 ** this.doublers(p, 'counters');
    if (card.entersWithX) perm.counters = x * doubled;
    if (card.loyalty !== undefined) perm.loyalty = card.loyalty * doubled;
    if (perm.printed && clone?.kind === 'clone' && clone.extraCounter && card.isCreature) perm.counters += doubled;
    if (card.entersTapped) perm.tapped = true;
    p.battlefield.push(perm);
    const etb = card.effects.filter((e) => e.when === 'resolve');
    if (etb.length) for (let i = this.triggerTimes(p, 'permanentEnters', card); i > 0; i--) this.trigger(p, card, perm.id, etb);
    if (card.isCreature) this.creatureEntered(p, perm);
    if ((card.isArtifact || card.isEnchantment) && this.kindsInGame.has('when:permEnters')) {
      const times = this.triggerTimes(p, 'permanentEnters', card);
      for (const other of p.battlefield) {
        if (other === perm) continue;
        const hits = other.card.effects.filter((e) => e.when === 'permEnters' && matchesFilter(card, e.castFilter ?? 'any'));
        if (hits.length) for (let i = 0; i < times; i++) this.trigger(p, other.card, other.id, hits);
      }
    }
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

  private putLand(p: PlayerState, card: SimCard, info: LandInfo, forceTapped = false) {
    const perm = this.makePerm(p, card, false);
    perm.landInfo = info;
    perm.tapped = forceTapped || info.tapped;
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

  private *resolveEffect(p: PlayerState, e: Effect, src: Perm | null, x: number, target: Target | null): Flow<void> {
    const n = (v: number) => (v === -1 ? x : v);

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
        const count = e.ritual ? e.n : Math.min(e.n * 2 ** this.doublers(p, 'tokens'), 40);
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
        this.say(`${p.name} wipes the board (${e.mode} ${e.target === 'creatures' ? 'creatures' : 'nonland permanents'}${e.oneSided ? ', opponents only' : ''}).`);
        // Everything goes at once, so death triggers see every creature that died with them (rule 603.10a).
        const hit: Perm[] = [];
        for (const q of this.alivePlayers()) {
          if (e.oneSided && q === p) continue;
          for (const perm of q.battlefield) {
            if (perm.card.isLand) continue;
            if (e.target === 'creatures' && !perm.card.isCreature) continue;
            if (e.target === 'artifacts' && !perm.card.isArtifact) continue;
            if (e.mode === 'damage') {
              if (perm.card.isCreature) this.hurt(perm, amount, e.shrink);
            } else if (e.mode === 'exile' || e.mode === 'bounce' || !this.hasKw(perm, 'indestructible')) hit.push(perm);
          }
        }
        if (hit.length) this.removePerms(hit, e.mode === 'exile' ? 'exile' : e.mode === 'bounce' ? 'hand' : 'graveyard');
        break;
      }
      case 'counter': {
        if (!target || target.kind !== 'stack') break;
        const idx = this.stack.findIndex((s) => s.id === target.id);
        if (idx === -1) break;
        const [hit] = this.stack.splice(idx, 1);
        this.say(`${hit.label} is countered.`);
        if (hit.kind === 'spell') this.leaveStack(this.players[hit.controller], hit);
        break;
      }
      case 'tokens': {
        const count = Math.min((e.n === -1 ? x : e.n) * 2 ** this.doublers(p, 'tokens'), 40);
        for (let i = 0; i < count; i++) {
          const token = this.makePerm(p, tokenCard(e.power, e.toughness, e.keywords), true);
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
        const perm = target?.kind === 'perm' ? this.findPerm(target.id) : null;
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
        const amount = e.n === -1 ? Math.max(x, 1) : e.n;
        let total = 0;
        // "You gain life equal to the life lost this way": only what was really lost (Teferi's Protection stops it).
        for (const o of this.opponents(p)) total += this.loseLife(o, amount, p, 'noncombat');
        this.gainLife(p, e.gain === -1 ? total : e.gain);
        this.say(`${p.name} drains each opponent for ${amount}.`);
        break;
      }
      case 'damagePlayer': {
        const victim = target?.kind === 'player' ? this.players[target.seat] : null;
        if (!victim?.alive) break;
        const amount = e.n === -1 ? Math.max(x, 1) : e.n;
        this.loseLife(victim, amount, p, 'noncombat');
        this.say(`${p.name} hits ${victim.name} for ${amount} (life ${victim.life}).`);
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
        const creatures = p.graveyard.filter((c) => recursionMatches(e.what, c) && (!e.toBattlefield || (!c.isInstant && !c.isSorcery && !c.isLand)));
        if (!creatures.length) break;
        const where = e.toBattlefield ? 'the battlefield' : e.toTop ? 'the top of your library' : 'your hand';
        const picks = yield* this.choose(p, 'recursion', `Return up to ${e.n} card${e.n > 1 ? 's' : ''} from your graveyard to ${where}.`, creatures.map((card) => ({ label: card.name, card })), 1, e.n);
        for (const card of picks.map((i) => creatures[i])) {
          p.graveyard.splice(p.graveyard.indexOf(card), 1);
          if (e.toTop) {
            this.say(`${p.name} puts ${card.name} on top of their library.`);
            p.library.unshift(card);
          } else if (e.toBattlefield) {
            this.say(`${p.name} returns ${card.name} to the battlefield.`);
            yield* this.enter(p, card, p.deck.commanders.includes(card), 0, null);
          } else {
            this.say(`${p.name} returns ${card.name} to their hand.`);
            p.hand.push(card);
          }
        }
        break;
      }
      case 'counters': {
        const amount = (e.n === -1 ? Math.max(x, 1) : e.n) * 2 ** this.doublers(p, 'counters');
        const creatures = p.battlefield.filter((q) => q.card.isCreature);
        if (e.proliferate) {
          // Proliferate: you choose, so +1/+1 counters on your creatures and -1/-1 counters on your opponents' (rule 701.34).
          // Doubling Season only doubles counters on permanents you control.
          for (const perm of creatures) if (perm.counters > 0) perm.counters += amount;
          for (const perm of this.allPerms()) if (perm.seat !== p.seat && perm.card.isCreature && perm.counters < 0) perm.counters -= 1;
          for (const perm of p.battlefield) if (perm.loyalty !== undefined && perm.card.isPlaneswalker) perm.loyalty += amount;
        } else if (e.all) {
          for (const perm of creatures) perm.counters += amount;
        } else if (src && src.card.isCreature && p.battlefield.includes(src)) {
          src.counters += amount;
        } else if (creatures.length) {
          const pick = creatures.length === 1 ? [0] : yield* this.choose(p, 'counters', `Put ${amount} +1/+1 counter${amount > 1 ? 's' : ''} on which creature?`, creatures.map((q) => ({ label: q.card.name, card: q.card, permId: q.id })), 1, 1);
          creatures[pick[0] ?? 0].counters += amount;
        }
        break;
      }
      case 'exileGraveyards':
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
          if (e.whileSource) {
            // "For as long as you control ~": if that already ended, nothing happens (rule 611.2b).
            if (!src || src.seat !== p.seat || !p.battlefield.includes(src)) break;
            this.takeControl(perm, p);
            this.hold(perm, src);
          } else this.takeControl(perm, p);
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
        break;
      }
      case 'mill': {
        const victims = e.who === 'you' ? [p] : e.who === 'opponents' ? this.opponents(p) : e.who === 'all' ? this.alivePlayers() : target?.kind === 'player' && this.players[target.seat].alive ? [this.players[target.seat]] : [];
        for (const v of victims) {
          const count = Math.min(v.library.length, e.n === -2 ? Math.ceil(v.library.length / 2) : e.n === -1 ? Math.max(x, 1) * 2 : e.n);
          for (const card of v.library.splice(0, count)) this.toGraveyard(v, card, false);
          if (count) this.say(`${v.name} mills ${count} card${count > 1 ? 's' : ''} (${v.library.length} left).`);
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
        }
        break;
      }
      case 'monarch':
        if (this.monarch !== p.seat) this.say(`${p.name} becomes the monarch.`);
        this.monarch = p.seat;
        break;
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

  gainLife(p: PlayerState, amount: number) {
    if (amount <= 0) return;
    p.life += amount;
    this.fire(p, 'gainLife', amount);
  }

  /** Returns the life actually lost (none while the player is protected). */
  loseLife(p: PlayerState, amount: number, source: PlayerState | null, kind: LossReason): number {
    if (amount <= 0 || p.shielded) return 0;
    p.life -= amount;
    if (source && source !== p) {
      p.lastHitBy = source.seat;
      p.lastHitKind = kind;
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
        if (e.kind === 'anthem' && !(e.other && perm === target)) {
          p += e.p;
          t += e.t;
        }
      }
    }
    return { p, t };
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
    let p = perm.card.power + perm.counters + perm.tempP + this.anthemBonus(perm).p + this.scaled(perm);
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
    let t = perm.card.toughness + perm.counters + perm.tempT + this.anthemBonus(perm).t + (perm.card.scales?.toughness ? this.scaled(perm) : 0);
    for (const eq of this.attachments(perm)) for (const e of eq.card.effects) if (e.kind === 'equip') t += e.t;
    return t;
  }

  hasKw(perm: Perm, kw: string): boolean {
    if (perm.card.keywords.includes(kw) || perm.tempKw.includes(kw)) return true;
    if (!perm.card.isCreature) return false;
    if (this.kindsInGame.has('anthem')) {
      for (const q of this.players[perm.seat].battlefield) for (const e of q.card.effects) if (e.kind === 'anthem' && e.keywords?.includes(kw) && !(e.other && q === perm) && (!e.small || perm.card.power + perm.counters <= 1 || perm.card.toughness + perm.counters <= 1)) return true;
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

  private removePerm(perm: Perm, to: 'graveyard' | 'exile' | 'hand') {
    this.removePerms([perm], to);
  }

  /**
   * Several permanents leave the battlefield at the same time (a wipe, or
   * state-based actions). Abilities that trigger on dying "look back in time"
   * (rule 603.10a): every permanent on the battlefield just before the event
   * sees every creature that died in it, including those that died with it.
   */
  private removePerms(perms: Perm[], to: 'graveyard' | 'exile' | 'hand') {
    // Rest in Peace: exiled instead, so nothing "dies".
    if (to === 'graveyard' && this.statics(null, 'graveyardHate') > 0) to = 'exile';
    const watchers = to === 'graveyard' && this.kindsInGame.has('when:creatureDies') ? this.allPerms().map((w) => ({ w, seat: w.seat })) : [];
    const died: { perm: Perm; seat: number; worn: Perm[] }[] = [];
    for (const perm of perms) {
      const controller = this.players[perm.seat];
      const owner = this.players[perm.owner ?? perm.seat];
      const idx = controller.battlefield.indexOf(perm);
      if (idx === -1) continue;
      const worn = to === 'graveyard' && perm.card.isCreature ? this.attachments(perm) : NONE;
      controller.battlefield.splice(idx, 1);

      // Tokens cease to exist once they leave the battlefield (rule 704.5d). A copy goes back to being its own card.
      if (!perm.token && owner.alive) {
        const card = perm.printed ?? perm.uncrewed ?? perm.card;
        if (to === 'graveyard') owner.graveyard.push(card);
        else if (to === 'exile') owner.exile.push(card);
        else owner.hand.push(card);
        if (perm.isCommander) this.pendingCommander.push({ seat: owner.seat, card, to });
      }
      if (perm.card.isCreature && to === 'graveyard' && controller.alive) died.push({ perm, seat: controller.seat, worn });
    }
    // Control that lasts "for as long as" a permanent stays ends when it leaves (Sower of Temptation, Control Magic).
    if (this.anyHeld) {
      const gone = new Set(perms.map((q) => q.id));
      for (const q of this.allPerms()) if (q.heldBy !== undefined && gone.has(q.heldBy)) this.giveBack(q);
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
          && (q === controller || e.scope === 'all') && (w !== perm || e.selfToo) && !(e.nontoken && perm.token));
        if (hits.length) for (let i = this.triggerTimes(q, 'dies'); i > 0; i--) this.trigger(q, w.card, w.id, hits, 0, w);
      }
      // Skullclamp: "whenever equipped creature dies".
      for (const eq of worn) {
        const hits = eq.card.effects.filter((e) => e.when === 'creatureDies' && e.scope === 'attached');
        const holder = this.players[eq.seat];
        if (hits.length) for (let i = this.triggerTimes(holder, 'dies'); i > 0; i--) this.trigger(holder, eq.card, eq.id, hits);
      }
    }
  }

  /** True once anything was taken "for as long as" something stays. */
  private anyHeld = false;

  private hold(perm: Perm, by: Perm) {
    if (perm.owner === undefined) return;
    perm.heldBy = by.id;
    this.anyHeld = true;
  }

  /** Control of a borrowed permanent goes back to its owner (rule 611.2b). */
  private giveBack(perm: Perm) {
    perm.heldBy = undefined;
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
        const zone = c.to === 'graveyard' ? owner.graveyard : c.to === 'exile' ? owner.exile : owner.hand;
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
    const losing: { p: PlayerState; reason: LossReason }[] = [];
    for (const p of this.players) {
      if (!p.alive) continue;
      let reason: LossReason | null = null;
      if (p.life <= 0) reason = p.lastHitKind;
      for (const dmg of p.commanderDamage.values()) if (dmg >= COMMANDER_DAMAGE) reason = 'commander';
      if (p.poison >= 10) reason = 'combat';
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
        // 704.5i: a planeswalker with no loyalty is put into its owner's graveyard.
        if (perm.loyalty !== undefined && perm.loyalty <= 0 && q.battlefield.includes(perm)) {
          this.say(`${perm.card.name} (${q.name}) runs out of loyalty.`);
          this.removePerm(perm, 'graveyard');
          changed = true;
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

  private eliminate(dying: { p: PlayerState; reason: LossReason }[]) {
    const aliveBefore = this.alivePlayers().length;
    for (const { p, reason } of dying) {
      p.alive = false;
      // Everyone still in the game finished ahead; players who lose together share the place.
      this.placements[p.seat] = aliveBefore - dying.length + 1;
      const killer = reason === 'decked' ? null : p.lastHitBy;
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
    return true;
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
    yield* this.priority();
    if (this.stopped(p)) return;

    // Declare attackers (508). Each creature may attack a different opponent (rule 802.2a).
    this.step = 'declareAttackers';
    const candidates = this.attackCandidates(p);
    const defenders = this.opponents(p).map((o) => o.seat);
    if (!candidates.length || !defenders.length) return;
    const declared = yield* ask<AttackDeclaration[] | null>({ kind: 'attackers', seat: p.seat, candidates: candidates.map((c) => c.id), defenders });
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
      perm.attacking = d.defender;
      if (!this.hasKw(perm, 'vigilance')) perm.tapped = true;
      attacking.push(perm);
    }
    // No attackers: skip straight to the end of combat (rule 508.8).
    if (!attacking.length) return;
    for (const seat of defenders) {
      const group = attacking.filter((a) => a.attacking === seat);
      if (group.length) this.say(`${p.name} attacks ${this.players[seat].name} with ${group.map((a) => `${a.card.name} ${this.power(a)}/${this.toughness(a)}`).join(', ')}.`);
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
      const trample = this.hasKw(a, 'trample');
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

    const hitPlayer = new Set<Perm>();
    const before = new Map<PlayerState, number>();
    // Lifelink: all the damage one creature deals in a step is one life gain event; separate creatures are separate events (rule 702.15e).
    const linked = new Map<Perm, number>();
    for (const d of [...toPerm, ...toPlayer]) if (this.hasKw(d.from, 'lifelink')) linked.set(d.from, (linked.get(d.from) ?? 0) + d.amount);
    for (const d of toPerm) {
      d.to.damage += d.amount;
      if (this.hasKw(d.from, 'deathtouch')) d.to.deathtouched = true;
    }
    for (const d of toPlayer) {
      if (!before.has(d.to)) before.set(d.to, d.to.life);
      // Infect: poison counters instead of life loss (rule 702.90).
      if (this.hasKw(d.from, 'infect')) {
        if (!d.to.shielded) {
          d.to.poison += d.amount;
          d.to.lastHitBy = p.seat;
          d.to.lastHitKind = 'combat';
          this.say(`${d.to.name} gets ${d.amount} poison (${d.to.poison} of 10).`);
        }
      } else this.loseLife(d.to, d.amount, p, 'combat');
      if (d.from.isCommander && !d.to.shielded) {
        // Commander damage counts per commander, whoever controls it now (rule 903.10a).
        const key = `${d.from.owner ?? d.from.seat}:${d.from.card.name}`;
        d.to.commanderDamage.set(key, (d.to.commanderDamage.get(key) ?? 0) + d.amount);
      }
      hitPlayer.add(d.from);
      if (this.monarch === d.to.seat && p.alive) {
        this.monarch = p.seat;
        this.say(`${p.name} becomes the monarch.`);
      }
    }
    for (const [d, life] of before) this.say(`${d.name} takes ${life - d.life} (life ${d.life}).`);
    for (const [src, amount] of linked) this.gainLife(this.players[src.seat], amount);

    // "Deals combat damage to a player" triggers.
    for (const a of hitPlayer) {
      const own = a.card.effects.filter((e) => e.when === 'combatDamage' && e.scope === 'self');
      if (own.length) this.trigger(p, a.card, a.id, own);
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
          if (hits.length) this.trigger(p, perm.card, perm.id, hits);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isInstantSpeed(card: SimCard): boolean {
  return card.isInstant || card.keywords.includes('flash');
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
  }
}

export function counterMatches(target: 'any' | 'noncreature' | 'creature', card: SimCard): boolean {
  if (target === 'any') return true;
  return target === 'creature' ? card.isCreature : !card.isCreature;
}

export function recursionMatches(what: 'any' | 'artifact' | 'enchantment' | 'instantSorcery' | undefined, card: SimCard): boolean {
  switch (what) {
    case 'any': return !card.isLand;
    case 'artifact': return card.isArtifact;
    case 'enchantment': return card.isEnchantment;
    case 'instantSorcery': return card.isInstant || card.isSorcery;
    default: return card.isCreature;
  }
}

export function removalMatches(target: string, card: SimCard): boolean {
  switch (target) {
    case 'creature': return card.isCreature;
    case 'permanent': return true;
    case 'noncreature': return !card.isCreature;
    case 'artifactEnchantment': return card.isArtifact || card.isEnchantment;
    case 'planeswalker': return card.isPlaneswalker;
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
    default: return `${card.name}: choose a target.`;
  }
}

const tokenCache = new Map<string, SimCard>();

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
