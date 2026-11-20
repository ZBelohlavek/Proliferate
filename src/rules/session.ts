// Runs a game: feeds the engine's decisions to whoever sits in each seat.
//
// `playGame` plays bots against each other from start to finish (the
// simulator). `Session` adds one human seat: it runs the bots until the game
// needs the person, and waits for their answer.

import type { GameResult, SimDeck } from '../engine/types';
import { Bot, type BotOptions } from './bot';
import { Game, type Flow, type GameOptions } from './game';
import type { Agent, Answer, Decision } from './types';

export interface PlayOptions extends GameOptions {
  bots?: BotOptions[];
}

/** Play one bot-versus-bot game. */
export function playGame(decks: SimDeck[], seed: number, opts: PlayOptions = {}): { result: GameResult; log: string[] | null } {
  const game = new Game(decks, seed, opts);
  const bots = decks.map((_, seat) => new Bot(seat, seed, opts.bots?.[seat]));
  const flow = game.run();
  let next = flow.next();
  // A bot only looks at the table while it decides, so the game can remember what it works out.
  while (!next.done) {
    const d = next.value;
    next = flow.next(game.readOnly(() => bots[d.seat].decide(game, d)));
  }
  return { result: next.value, log: game.log };
}

export interface SessionOptions extends PlayOptions {
  /**
   * Full control: stop every time the person could act. Otherwise priority
   * is passed for them when they would rarely want it (see `autoPass`).
   */
  fullControl?: boolean;
}

/** A game with one person at the table and bots in the other seats. */
export class Session {
  readonly game: Game;
  /** The decision waiting for the person, or null while bots are playing or the game is over. */
  pending: Decision | null = null;
  result: GameResult | null = null;
  fullControl: boolean;
  private readonly flow: Flow<GameResult>;
  private readonly agents: (Agent | null)[];
  private started = false;
  /** A bot decision the engine is waiting on, when stepping. */
  private waiting: Decision | null = null;

  constructor(decks: SimDeck[], seed: number, readonly humanSeat: number, opts: SessionOptions = {}) {
    this.game = new Game(decks, seed, { ...opts, log: true });
    this.agents = decks.map((_, seat) => (seat === humanSeat ? null : new Bot(seat, seed, opts.bots?.[seat])));
    this.fullControl = !!opts.fullControl;
    this.flow = this.game.run();
  }

  get busy(): boolean {
    return !this.pending && !this.result;
  }

  /** Answer the pending decision. Call `step` or `run` afterwards to let the game continue. */
  answer(answer: Answer) {
    if (!this.pending) return;
    this.pending = null;
    this.take(this.flow.next(answer));
  }

  /** Let the bots play until the person is needed or the game ends. */
  run() {
    while (this.step()) { /* keep going */ }
  }

  /**
   * Advance until something new is in the log (so the table can show the game
   * unfolding), the person is needed, or the game ends. Returns false when
   * there is nothing more to do without the person.
   */
  step(): boolean {
    const logged = this.game.log!.length;
    for (let i = 0; i < 10_000; i++) {
      if (this.pending || this.result) return false;
      if (!this.started) {
        this.started = true;
        this.take(this.flow.next());
      } else if (this.waiting) {
        const d = this.waiting;
        this.waiting = null;
        const agent = this.agents[d.seat];
        this.take(this.flow.next(agent ? this.game.readOnly(() => agent.decide(this.game, d)) : this.autoAnswer(d)));
      }
      if (this.game.log!.length > logged) return !this.pending && !this.result;
    }
    return false;
  }

  private take(next: IteratorResult<Decision, GameResult>) {
    if (next.done) {
      this.result = next.value;
      return;
    }
    const d = next.value;
    if (d.seat === this.humanSeat && !this.autoPass(d)) this.pending = d;
    else this.waiting = d;
  }

  private autoAnswer(d: Decision): Answer {
    // Only reached for the person's auto-passed priority.
    return d.kind === 'priority' ? { action: 0 } : null;
  }

  /**
   * Should priority be passed for the person without asking? The engine only
   * asks when they have something they could do. They are asked: in their own
   * main phases; whenever an opponent's spell or ability is on the stack;
   * during combat when blockers are declared or they are being attacked; and
   * in the end step just before their turn.
   */
  private autoPass(d: Decision): boolean {
    if (d.kind !== 'priority' || this.fullControl) return false;
    const g = this.game;
    const top = g.stack[g.stack.length - 1];
    if (top) return top.controller === this.humanSeat;
    const mine = g.activeSeat === this.humanSeat;
    if (mine) return !(g.step === 'main1' || g.step === 'main2' || (g.step === 'declareBlockers' && g.attackers().length > 0));
    if (g.step === 'declareAttackers' || g.step === 'declareBlockers') return !g.attackers().some((a) => a.attacking === this.humanSeat);
    if (g.step === 'end') return g.nextAliveSeat(g.activeSeat) !== this.humanSeat;
    return true;
  }
}
