// The scripted-table harness for rules tests: every seat passes and declines
// everything unless a handler says otherwise, so a test scripts only the plays it is about.

import type { SimDeck } from '../src/engine/types';
import { Game } from '../src/rules/game';
import type { Action, Answer, Decision } from '../src/rules/types';
import { forest, stompyDeck } from './helpers';

export type Handler = (g: Game, d: Decision) => Answer | undefined;

function fallback(d: Decision): Answer {
  switch (d.kind) {
    case 'priority': return { action: 0 };
    case 'target': return d.candidates[0];
    case 'attackers': return [];
    case 'blockers': return [];
    case 'choose': return d.options.slice(0, d.min).map((_, i) => i);
    case 'confirm': return d.reason === 'commandZone';
  }
}

export class Table {
  readonly game: Game;
  private flow: ReturnType<Game['run']>;
  private next: IteratorResult<Decision, unknown>;
  handlers: Record<number, Handler> = {};

  constructor(players = 2, opts: { maxRounds?: number } = {}) {
    const decks: SimDeck[] = Array.from({ length: players }, (_, i) => stompyDeck(`p${i}`));
    this.game = new Game(decks, 1, { log: true, ...opts });
    this.flow = this.game.run();
    this.next = this.flow.next();
    // Play up to seat 0's first main phase, then clear the table for the test's own setup.
    this.until((g) => g.step === 'main1');
    for (const p of this.game.players) {
      p.hand = [];
      p.battlefield = [];
    }
    this.stale = true;
  }

  /**
   * The decision waiting after setup lists plays from the old hand. Choosing
   * one (it can no longer be made) has the engine ask again with the new state.
   */
  private stale = false;

  get done() {
    return !!this.next.done;
  }

  /** Answer decisions until `stop` is true at a decision point, or the game ends. */
  until(stop: (g: Game, d: Decision) => boolean) {
    if (this.stale) {
      this.stale = false;
      this.next = this.flow.next({ action: 1 });
    }
    for (let i = 0; i < 20_000 && !this.next.done; i++) {
      const d = this.next.value as Decision;
      if (stop(this.game, d)) return;
      this.next = this.flow.next(this.handlers[d.seat]?.(this.game, d) ?? fallback(d));
    }
  }

  /** Play to the end of the current turn (the next turn's upkeep or later). */
  finishTurn() {
    const turn = this.game.turnNumber;
    this.until((g) => g.turnNumber !== turn);
  }

  lands(seat: number, n: number) {
    for (let i = 0; i < n; i++) this.game.put(seat, forest());
  }
}

export const find = (actions: Action[], type: Action['type'], name?: string) =>
  actions.findIndex((a) => a.type === type && (name === undefined || ('card' in a && a.card.name === name)));

/** Cast `name` the first time it is castable, at the first chance. */
export function castOnce(name: string, when: (g: Game) => boolean = () => true): Handler {
  let done = false;
  return (g, d) => {
    if (done || d.kind !== 'priority' || !when(g)) return undefined;
    const i = find(d.actions, 'cast', name);
    if (i === -1) return undefined;
    done = true;
    return { action: i };
  };
}

export const attackAll = (defender: number): Handler => (_g, d) => (d.kind === 'attackers' ? d.candidates.map((attacker) => ({ attacker, defender })) : undefined);
